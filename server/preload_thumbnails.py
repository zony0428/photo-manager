"""
サムネイル一括事前生成スクリプト
DB内の全写真に対して、未生成のサムネイルを一括で生成・保存する。
"""

import concurrent.futures
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import List, Optional, Tuple

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from server.database import (
    get_connection,
    save_thumbnails_batch,
    compute_thumbnail_hash,
    find_existing_thumbnail_for_duplicate,
)
from server.scanner import (
    resolve_portable_path,
    render_thumbnail_webp,
)

logger = logging.getLogger("preload_thumbnails")

# 多重起動防止用モジュールレベルロック
_preload_lock = threading.Lock()


def _process_single_thumbnail(photo_id: int, file_path_str: str) -> Optional[Tuple[int, bytes, int, int, str]]:
    """単一の写真のパス解決・サムネイル生成・ハッシュ計算を行う（ワーカースレッド用）"""
    try:
        target_path, is_online = resolve_portable_path(file_path_str)
        if not is_online or not target_path.exists():
            return None

        res = render_thumbnail_webp(target_path, max_size=360, allow_cloud_download=False)
        if res is None:
            return None

        thumb_data, thumb_w, thumb_h = res
        file_hash = compute_thumbnail_hash(str(target_path))
        return (photo_id, thumb_data, thumb_w, thumb_h, file_hash)
    except Exception as e:
        logger.warning(f"サムネイル生成ワーカー失敗 (ID: {photo_id}, Path: {file_path_str}): {e}")
        return None


def preload_all_thumbnails(batch_size: int = 50):
    """
    DB内の未生成サムネイルをバックグラウンドで一括生成・保存する。
    ThreadPoolExecutor による並列生成を行い、DB保存はメインスレッドでバッチ実行する。
    多重起動防止ロックにより、実行中に再呼出しされた場合は即座に戻る。
    """
    if not _preload_lock.acquire(blocking=False):
        logger.info("preload_all_thumbnails は既に実行中のためスキップします。")
        print("preload_all_thumbnails は既に実行中のためスキップします。", flush=True)
        return

    try:
        start_time = time.time()
        with get_connection() as conn:
            cursor = conn.cursor()
            # 未生成の写真を抽出
            cursor.execute("""
                SELECT p.id, p.file_path, p.file_name, p.file_size, p.date_taken, p.is_raw
                FROM photos p
                LEFT JOIN thumbnails t ON p.id = t.photo_id
                WHERE t.photo_id IS NULL
                ORDER BY p.id ASC
            """)
            pending = [dict(r) for r in cursor.fetchall()]

        total_pending = len(pending)
        print(f"=== サムネイル一括生成開始: 残り {total_pending} 件 ===", flush=True)

        if total_pending == 0:
            print("すべてのサムネイルが既に生成済みです。", flush=True)
            return

        success_count = 0
        fail_count = 0

        # 1. 重複写真（他フォルダに同一画像がありサムネイル生成済み）からの高速バッチ複製
        cloned_batch: List[Tuple[int, bytes, int, int, str]] = []
        unresolved_pending = []
        for row in pending:
            p_id = row["id"]
            dt = row.get("date_taken")
            sz = row.get("file_size") or 0
            if dt and sz > 0:
                dup_thumb = find_existing_thumbnail_for_duplicate(file_size=sz, date_taken=dt, exclude_photo_id=p_id)
                if dup_thumb:
                    target_path, _ = resolve_portable_path(row["file_path"])
                    fh = compute_thumbnail_hash(str(target_path))
                    cloned_batch.append((p_id, dup_thumb["data"], dup_thumb["width"], dup_thumb["height"], fh))
                    continue
            unresolved_pending.append(row)

        if cloned_batch:
            save_thumbnails_batch(cloned_batch)
            print(f"[重複再利用] {len(cloned_batch)} 件のサムネイルを既存データから高速複製しました。", flush=True)
            success_count += len(cloned_batch)

        pending = unresolved_pending
        if not pending:
            print("未生成のサムネイルはすべて重複再利用で完了しました。", flush=True)
            return

        max_workers = min(4, os.cpu_count() or 2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            # 処理済み future を都度破棄し、生成済みWebPバイナリを保持し続けないようにする（メモリ肥大防止）
            futures = {
                executor.submit(_process_single_thumbnail, row["id"], row["file_path"])
                for row in pending
            }

            for future in concurrent.futures.as_completed(futures):
                futures.discard(future)
                try:
                    result = future.result()
                    if result is not None:
                        batch.append(result)
                        success_count += 1
                    else:
                        fail_count += 1
                except Exception as err:
                    fail_count += 1
                    logger.warning(f"サムネイル生成タスク例外: {err}")

                # バッチ書き込み（呼び出し元スレッドで50件ずつ実行）
                if len(batch) >= batch_size:
                    save_thumbnails_batch(batch)
                    batch = []
                    elapsed = time.time() - start_time
                    processed = success_count + fail_count
                    print(f"進捗: {processed}/{total_pending} ({success_count} 件成功, {fail_count} 件スキップ/失敗) - {elapsed:.1f}秒", flush=True)

        if batch:
            save_thumbnails_batch(batch)

        total_time = time.time() - start_time
        print(f"=== 完了! 成功: {success_count} 件, 失敗/スキップ: {fail_count} 件 (所要時間: {total_time:.1f}秒) ===", flush=True)

    finally:
        _preload_lock.release()


if __name__ == "__main__":
    preload_all_thumbnails()
