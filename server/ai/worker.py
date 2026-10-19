"""
AIタグ付けバックグラウンドワーカー
非同期スレッドで写真のサムネイルを順次読み込み、AI自動タグ付けをバッチ実行する。
進捗管理、キャンセル機能、フォルダ単位実行、全未処理写真の一括実行を提供する。
"""

import logging
import threading
import time
from typing import Any, Dict, List, Optional

from ..database.connection import get_connection
from ..database.photos import _directory_filter_sql
from ..database.tags import add_ai_tags_to_photo
from .tagger import get_ai_tagger

logger = logging.getLogger("photo_manager.ai.worker")


class AITaggingWorker:
    """AIタグ付けバックグラウンドワーカースレッド管理クラス"""

    _instance: Optional["AITaggingWorker"] = None
    _lock = threading.Lock()

    def __init__(self):
        self._thread: Optional[threading.Thread] = None
        self._cancel_flag = threading.Event()
        self._state_lock = threading.Lock()

        # 進捗情報
        self.is_running = False
        self.folder_path: Optional[str] = None
        self.total_count = 0
        self.processed_count = 0
        self.tagged_count = 0
        self.current_file = ""
        self.start_time = 0.0
        self.error_count = 0
        self.last_error = ""

    @classmethod
    def get_instance(cls) -> "AITaggingWorker":
        """シングルトンインスタンスの取得"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def get_status(self) -> Dict[str, Any]:
        """現在のタグ付け進捗ステータスを返す"""
        with self._state_lock:
            tagger = get_ai_tagger()
            elapsed = time.time() - self.start_time if self.is_running else 0.0
            percent = (
                round((self.processed_count / self.total_count) * 100, 1)
                if self.total_count > 0
                else 0.0
            )

            # 残り時間推定
            remaining_sec = 0.0
            if self.is_running and self.processed_count > 0:
                sec_per_item = elapsed / self.processed_count
                remaining_sec = max(0.0, sec_per_item * (self.total_count - self.processed_count))

            return {
                "is_running": self.is_running,
                "is_model_ready": tagger.is_loaded,
                "model_available": tagger.is_available(),
                "folder_path": self.folder_path,
                "total_count": self.total_count,
                "processed_count": self.processed_count,
                "tagged_count": self.tagged_count,
                "percent": percent,
                "current_file": self.current_file,
                "elapsed_sec": round(elapsed, 1),
                "remaining_sec": round(remaining_sec, 1),
                "error_count": self.error_count,
                "last_error": self.last_error,
            }

    def start_tagging(
        self,
        folder_path: Optional[str] = None,
        photo_ids: Optional[List[int]] = None,
        force_retag: bool = False,
    ) -> bool:
        """AI自動タグ付けジョブを開始する"""
        with self._lock:
            if self.is_running:
                logger.warning("AI tagging job is already running.")
                return False

            self._cancel_flag.clear()
            self._thread = threading.Thread(
                target=self._run_job,
                args=(folder_path, photo_ids, force_retag),
                daemon=True,
                name="AITaggingWorkerThread",
            )
            self._thread.start()
            return True

    def cancel(self):
        """実行中のジョブをキャンセル要求する"""
        if self.is_running:
            logger.info("Cancelling AI tagging job...")
            self._cancel_flag.set()

    def _run_job(
        self,
        folder_path: Optional[str],
        photo_ids: Optional[List[int]],
        force_retag: bool,
    ):
        """ワーカースレッド本体"""
        tagger = get_ai_tagger()
        if not tagger.load():
            with self._state_lock:
                self.last_error = "AIモデルのロードに失敗しました"
            return

        with self._state_lock:
            self.is_running = True
            self.folder_path = folder_path
            self.processed_count = 0
            self.tagged_count = 0
            self.error_count = 0
            self.last_error = ""
            self.start_time = time.time()

        try:
            # 対象写真のIDおよびファイル名のみ取得（メモリ節約のためサムネイルBLOBは後から64件ずつ取得）
            with get_connection() as conn:
                cursor = conn.cursor()

                query = """
                    SELECT p.id, p.file_name
                    FROM photos p
                    JOIN thumbnails t ON p.id = t.photo_id
                """
                conditions = []
                params = []

                if photo_ids:
                    placeholders = ",".join(["?"] * len(photo_ids))
                    conditions.append(f"p.id IN ({placeholders})")
                    params.extend(photo_ids)
                elif folder_path:
                    dir_sql, dir_params = _directory_filter_sql(folder_path, recursive=True, column_name="p.directory_path")
                    conditions.append(dir_sql)
                    params.extend(dir_params)

                if not force_retag:
                    # すでにAIタグが付与済みの写真はスキップ
                    conditions.append("p.id NOT IN (SELECT photo_id FROM photo_tags WHERE source = 'ai')")

                if conditions:
                    query += " WHERE " + " AND ".join(conditions)

                query += " ORDER BY p.id ASC"
                cursor.execute(query, params)
                targets = cursor.fetchall()

            with self._state_lock:
                self.total_count = len(targets)

            logger.info(f"Starting AI tagging for {self.total_count} photos (folder={folder_path})")

            # 64件ずつサムネイルBLOBを取得しながら推論＆保存
            chunk_size = 64
            for i in range(0, len(targets), chunk_size):
                if self._cancel_flag.is_set():
                    logger.info("AI tagging job cancelled by user.")
                    break

                chunk = targets[i : i + chunk_size]
                chunk_ids = [row["id"] for row in chunk]
                placeholders = ",".join(["?"] * len(chunk_ids))

                with get_connection() as conn:
                    cursor = conn.cursor()
                    cursor.execute(
                        f"SELECT photo_id, data FROM thumbnails WHERE photo_id IN ({placeholders})",
                        chunk_ids,
                    )
                    thumb_map = {row["photo_id"]: row["data"] for row in cursor.fetchall()}

                for row in chunk:
                    if self._cancel_flag.is_set():
                        logger.info("AI tagging job cancelled by user.")
                        break

                    pid = row["id"]
                    fname = row["file_name"]
                    thumb_bytes = thumb_map.get(pid)

                    with self._state_lock:
                        self.current_file = fname

                    if not thumb_bytes:
                        with self._state_lock:
                            self.processed_count += 1
                        continue

                    try:
                        predicted = tagger.predict_from_bytes(
                            thumb_bytes,
                            top_k=3,
                        )
                        if predicted:
                            add_ai_tags_to_photo(pid, predicted)
                            with self._state_lock:
                                self.tagged_count += 1
                    except Exception as e:
                        logger.error(f"Error tagging photo {pid} ({fname}): {e}")
                        with self._state_lock:
                            self.error_count += 1
                            self.last_error = str(e)

                    with self._state_lock:
                        self.processed_count += 1

                    # CPU負荷を抑えるための微小なスリープ
                    time.sleep(0.005)

            logger.info(
                f"AI tagging completed: processed={self.processed_count}/{self.total_count}, "
                f"tagged={self.tagged_count}, errors={self.error_count}"
            )

        except Exception as e:
            logger.error(f"Fatal error in AI tagging worker: {e}")
            with self._state_lock:
                self.last_error = str(e)
        finally:
            with self._state_lock:
                self.is_running = False
                self.current_file = ""


def get_ai_worker() -> AITaggingWorker:
    """シングルトンインスタンスを返すヘルパー"""
    return AITaggingWorker.get_instance()
