"""
Android 専用ロッカー向け 超高速差分パック (cache/mobile_delta.db) 自動生成モジュール

1GB超の library.db を毎回USB経由で丸ごとコピーする負荷を解消するため、
- 全写真の最新メタデータ・評価・タグ定義 (photos / photo_tags / tag_definitions)
- スマホ側ロッカー (cache/mobile_locker_state.json) に未転送の新規・更新サムネイル BLOB のみ
を格納した軽量 SQLite パック (cache/mobile_delta.db) をバックグラウンドで自動維持する。
PC側で削除・除外された写真やタグもスマホ側ロッカーへ完全同期される。
"""

import json
import logging
import os
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from .database import connection as _db_conn
from .database.connection import CACHE_DIR, get_db_commit_seq, get_or_create_library_id

logger = logging.getLogger("photo_manager.mobile_delta")

DELTA_DB_PATH = CACHE_DIR / "mobile_delta.db"
LOCKER_STATE_PATH = CACHE_DIR / "mobile_locker_state.json"

_delta_lock = threading.Lock()
_last_built_commit_seq: int = -1
_last_built_locker_mtime: float = -1.0


def _format_local_now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def read_mobile_locker_state() -> Dict[str, Any]:
    """スマホ側が USB の cache/mobile_locker_state.json に記録したロッカー保持状態を読み取る"""
    if not LOCKER_STATE_PATH.exists():
        return {}
    try:
        raw = LOCKER_STATE_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.debug(f"mobile_locker_state.json 読み取りスキップ: {e}")
        return {}


def ensure_mobile_delta_db(force: bool = False) -> Optional[Path]:
    """
    library.db の最新状態から軽量差分パック cache/mobile_delta.db を生成・更新する。
    変更がない場合は0msでスキップする。
    """
    global _last_built_commit_seq, _last_built_locker_mtime

    active_db_path = _db_conn.DB_PATH
    if not active_db_path.exists():
        return None
    out_delta_path = active_db_path.parent / "mobile_delta.db"

    with _delta_lock:
        cur_seq = get_db_commit_seq()
        locker_mtime = LOCKER_STATE_PATH.stat().st_mtime if LOCKER_STATE_PATH.exists() else 0.0

        if not force and out_delta_path.exists():
            if cur_seq == _last_built_commit_seq and locker_mtime == _last_built_locker_mtime:
                return out_delta_path
            # プロセス起動直後 (_last_built_commit_seq == -1) でも、ディスク上の mobile_delta.db が
            # library.db および mobile_locker_state.json より新しければ再生成を0msでスキップする
            if _last_built_commit_seq == -1:
                try:
                    delta_st = out_delta_path.stat()
                    db_st = active_db_path.stat()
                    wal_path = active_db_path.with_name(active_db_path.name + "-wal")
                    wal_mtime = wal_path.stat().st_mtime if wal_path.exists() and wal_path.stat().st_size > 0 else 0.0
                    latest_src_mtime = max(db_st.st_mtime, wal_mtime, locker_mtime)
                    if delta_st.st_size > 4096 and (delta_st.st_mtime + 2.0) >= latest_src_mtime:
                        _last_built_commit_seq = cur_seq
                        _last_built_locker_mtime = locker_mtime
                        return out_delta_path
                except Exception as st_err:
                    logger.debug(f"mobile_delta.db タイムスタンプ判定スキップ: {st_err}")

        t0 = time.time()
        tmp_path = active_db_path.parent / "mobile_delta.db.tmp"
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception as e:
                logger.debug(f"一時差分DB削除スキップ: {e}")

        locker_state = read_mobile_locker_state()
        state_max_id = int(locker_state.get("max_photo_id") or 0)
        state_max_created = str(locker_state.get("max_thumb_created_at") or "").strip()

        conn: Optional[sqlite3.Connection] = None
        try:
            conn = sqlite3.connect(str(active_db_path), timeout=20)
            conn.create_function("tetheract_v170_guard", 0, lambda: 1, deterministic=True)
            cur = conn.cursor()

            # 現在の最大 photo_id と有効写真枚数を取得
            row = cur.execute(
                "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM photos WHERE IFNULL(is_unlinked, 0) = 0"
            ).fetchone()
            active_count = int(row[0] or 0) if row else 0
            current_max_id = int(row[1] or 0) if row else 0

            # mobile_locker_state.json が未作成（既存のスマホロッカー利用中）の場合は直近300枚分をカバー範囲とする
            if state_max_id > 0:
                covered_from_id = state_max_id
            else:
                covered_from_id = max(0, current_max_id - 300)

            covered_from_created = state_max_created or "9999-12-31 23:59:59"

            cur.execute("ATTACH DATABASE ? AS delta", (str(tmp_path),))
            cur.execute("PRAGMA delta.journal_mode = OFF")
            cur.execute("PRAGMA delta.synchronous = OFF")
            cur.execute("PRAGMA delta.temp_store = MEMORY")

            # 1. デルタメタ情報テーブル
            cur.execute(
                """
                CREATE TABLE delta.delta_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            db_stat = active_db_path.stat()
            lib_id = get_or_create_library_id()
            sec_map: Dict[str, str] = {}
            if cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_meta'").fetchone():
                for sk, sv in cur.execute("SELECT key, value FROM security_meta WHERE key IN ('owner_id', 'security_level', 'pw_salt', 'dek_wrapped_pw', 'recovery_salt', 'dek_wrapped_recovery')").fetchall():
                    sec_map[str(sk)] = str(sv or "")
            owner_id = sec_map.get("owner_id", "")
            meta_rows = [
                ("schema", "tetheract-mobile-delta-v1"),
                ("library_id", lib_id),
                ("owner_id", owner_id),
                ("security_level", sec_map.get("security_level", "0")),
                ("pw_salt", sec_map.get("pw_salt", "")),
                ("dek_wrapped_pw", sec_map.get("dek_wrapped_pw", "")),
                ("recovery_salt", sec_map.get("recovery_salt", "")),
                ("dek_wrapped_recovery", sec_map.get("dek_wrapped_recovery", "")),
                ("source_db_mtime", str(int(db_stat.st_mtime * 1000))),
                ("source_db_size", str(db_stat.st_size)),
                ("source_photo_count", str(active_count)),
                ("source_max_photo_id", str(current_max_id)),
                ("covered_from_photo_id", str(covered_from_id)),
                ("covered_from_created_at", state_max_created),
                ("created_at", _format_local_now()),
            ]
            cur.executemany("INSERT INTO delta.delta_meta (key, value) VALUES (?, ?)", meta_rows)

            # 2. 有効な全写真メタデータ（削除・アンリンクされた写真は含まれないためスマホ側で確実に削除判定可能）
            cur.execute(
                "CREATE TABLE delta.photos AS SELECT * FROM main.photos WHERE IFNULL(is_unlinked, 0) = 0"
            )

            # 3. 全タグ付与データ & タグ定義マスタ
            cur.execute(
                """
                CREATE TABLE delta.photo_tags AS
                SELECT pt.photo_id, pt.tag, pt.source, pt.confidence
                FROM main.photo_tags pt
                INNER JOIN main.photos p ON p.id = pt.photo_id
                WHERE IFNULL(p.is_unlinked, 0) = 0
                """
            )
            has_tag_defs = cur.execute(
                "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='tag_definitions'"
            ).fetchone()
            if has_tag_defs:
                cur.execute("CREATE TABLE delta.tag_definitions AS SELECT * FROM main.tag_definitions")

            has_presets = cur.execute(
                "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='filter_presets'"
            ).fetchone()
            if has_presets:
                cur.execute("CREATE TABLE delta.filter_presets AS SELECT * FROM main.filter_presets")

            has_watermarks = cur.execute(
                "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='watermark_assets'"
            ).fetchone()
            if has_watermarks:
                cur.execute("CREATE TABLE delta.watermark_assets AS SELECT * FROM main.watermark_assets")

            has_links = cur.execute(
                "SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='photo_links'"
            ).fetchone()
            if has_links:
                cur.execute(
                    """
                    CREATE TABLE delta.photo_links AS
                    SELECT pl.* FROM main.photo_links pl
                    INNER JOIN main.photos p ON p.id = pl.photo_id
                    WHERE IFNULL(p.is_unlinked, 0) = 0
                    """
                )

            # 4. 新規追加または再生成（回転・クロップ・色調補正）されたサムネイルBLOBのみ抽出
            #    ※ 1GB超の thumbnails テーブルをフルスキャンしないよう、必ず INTEGER PRIMARY KEY (photo_id) レンジ検索・直引きのみを使う
            cur.execute(
                """
                CREATE TABLE delta.thumbnails AS
                SELECT t.photo_id, t.data, t.width, t.height, t.created_at
                FROM main.thumbnails t
                INNER JOIN main.photos p ON p.id = t.photo_id
                WHERE t.photo_id > ?
                  AND IFNULL(p.is_unlinked, 0) = 0
                UNION ALL
                SELECT t.photo_id, t.data, t.width, t.height, t.created_at
                FROM main.photos p
                INNER JOIN main.thumbnails t ON t.photo_id = p.id
                WHERE p.id <= ?
                  AND IFNULL(p.is_unlinked, 0) = 0
                  AND p.updated_at IS NOT NULL
                  AND p.updated_at > ?
                  AND (t.created_at IS NULL OR t.created_at > ?)
                """,
                (covered_from_id, covered_from_id, covered_from_created, covered_from_created),
            )
            delta_thumb_cnt = cur.execute("SELECT COUNT(*) FROM delta.thumbnails").fetchone()[0]

            conn.commit()
            cur.execute("DETACH DATABASE delta")
            conn.close()
            conn = None

            if out_delta_path.exists():
                out_delta_path.unlink()
            os.replace(str(tmp_path), str(out_delta_path))

            _last_built_commit_seq = cur_seq
            _last_built_locker_mtime = locker_mtime
            elapsed = time.time() - t0
            size_mb = out_delta_path.stat().st_size / (1024 * 1024)
            logger.info(
                f"[MobileDelta] mobile_delta.db を更新しました: "
                f"写真={active_count}枚, 差分サムネイル={delta_thumb_cnt}件, "
                f"サイズ={size_mb:.2f}MB ({elapsed:.2f}s)"
            )
            return out_delta_path
        except Exception as e:
            logger.warning(f"[MobileDelta] mobile_delta.db 生成失敗: {e}")
            if conn is not None:
                try:
                    conn.close()
                except Exception as close_err:
                    logger.debug(f"DBクローズスキップ: {close_err}")
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except Exception as rm_err:
                    logger.debug(f"一時ファイル削除スキップ: {rm_err}")
            return None
