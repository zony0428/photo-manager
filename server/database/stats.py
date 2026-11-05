"""
データベース統計・メンテナンスモジュール
ファイルサイズ統計の取得、VACUUM によるDB最適化、およびオンラインバックアップ・世代管理を提供する。
"""

import logging
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .connection import CACHE_DIR, DB_PATH, _local_db, get_connection

logger = logging.getLogger(__name__)

BACKUP_DIR = CACHE_DIR / "backups"
WEEKLY_BACKUP_REMINDER_DAYS = 7


def format_bytes(size_bytes: int) -> str:
    """バイト数を人間が読みやすい文字列（KB, MB, GB）に変換する"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def get_backup_info() -> Dict[str, Any]:
    """
    既存のバックアップ一覧および最新バックアップのサマリーを取得する。
    """
    backup_dir_str = str(BACKUP_DIR.resolve())
    db_file_str = str(DB_PATH.resolve())
    if not BACKUP_DIR.exists():
        return {
            "count": 0,
            "latest": None,
            "backups": [],
            "backup_dir_path": backup_dir_str,
            "db_file_path": db_file_str,
            "days_since_last_backup": None,
        }

    backups: List[Dict[str, Any]] = []
    now_ts = time.time()
    try:
        files = sorted(
            BACKUP_DIR.glob("library_backup_*.db"),
            key=lambda x: x.stat().st_mtime,
            reverse=True,
        )
        for p in files:
            st = p.stat()
            mtime_dt = datetime.fromtimestamp(st.st_mtime)
            age_sec = max(0.0, now_ts - float(st.st_mtime))
            age_days = int(age_sec // 86400)
            backups.append({
                "filename": p.name,
                "file_path": str(p.resolve()),
                "size": st.st_size,
                "size_formatted": format_bytes(st.st_size),
                "created_at": mtime_dt.strftime("%Y-%m-%d %H:%M:%S"),
                "created_at_short": mtime_dt.strftime("%m/%d %H:%M"),
                "mtime_epoch": round(float(st.st_mtime), 2),
                "age_days": age_days,
            })
    except Exception as e:
        logger.warning(f"バックアップ情報取得エラー: {e}")

    latest_item = backups[0] if backups else None
    return {
        "count": len(backups),
        "latest": latest_item,
        "backups": backups,
        "backup_dir_path": backup_dir_str,
        "db_file_path": db_file_str,
        "days_since_last_backup": latest_item["age_days"] if latest_item else None,
    }


def get_database_stats() -> Dict[str, Any]:
    """
    データベースファイル（library.db + WALログ）のサイズと内部の空き領域（フリーリスト）の統計を取得する。
    """
    # 本体およびWALログファイルを合算して実際のディスク消費量を算出
    file_size = 0
    if DB_PATH.exists():
        file_size += DB_PATH.stat().st_size
    wal_path = DB_PATH.with_name(f"{DB_PATH.name}-wal")
    if wal_path.exists():
        file_size += wal_path.stat().st_size

    freelist_bytes = 0
    photo_count = 0
    thumbnail_count = 0
    oldest_photo_created_at: Optional[str] = None

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("PRAGMA page_size")
        page_size = cursor.fetchone()[0]
        cursor.execute("PRAGMA freelist_count")
        freelist_count = cursor.fetchone()[0]
        freelist_bytes = freelist_count * page_size

        cursor.execute("SELECT count(*), min(created_at) FROM photos")
        row_p = cursor.fetchone()
        photo_count = int(row_p[0] or 0) if row_p else 0
        oldest_photo_created_at = str(row_p[1]) if (row_p and row_p[1]) else None

        cursor.execute("SELECT count(*) FROM thumbnails")
        thumbnail_count = cursor.fetchone()[0]

    reclaimable_ratio = (freelist_bytes / file_size) if file_size > 0 else 0.0
    b_info = get_backup_info()

    # ライブラリの運用経過日数および1週間（7日）バックアップ未実施の判定
    library_age_days = 0
    if photo_count > 0:
        if oldest_photo_created_at:
            try:
                dt_oldest = datetime.strptime(oldest_photo_created_at[:19], "%Y-%m-%d %H:%M:%S")
                library_age_days = max(0, int((datetime.now() - dt_oldest).total_seconds() // 86400))
            except Exception:
                library_age_days = 0
        if library_age_days == 0 and DB_PATH.exists():
            try:
                st_db = DB_PATH.stat()
                oldest_ts = min(float(st_db.st_ctime), float(st_db.st_mtime))
                library_age_days = max(0, int((time.time() - oldest_ts) // 86400))
            except Exception:
                library_age_days = 0

    days_since_bck = b_info.get("days_since_last_backup")
    is_overdue = False
    if photo_count > 0:
        if days_since_bck is not None:
            is_overdue = days_since_bck >= WEEKLY_BACKUP_REMINDER_DAYS
        else:
            is_overdue = library_age_days >= WEEKLY_BACKUP_REMINDER_DAYS

    b_info["library_age_days"] = library_age_days
    b_info["reminder_threshold_days"] = WEEKLY_BACKUP_REMINDER_DAYS
    b_info["is_overdue"] = is_overdue

    return {
        "file_size": file_size,
        "file_size_formatted": format_bytes(file_size),
        "freelist_size": freelist_bytes,
        "freelist_size_formatted": format_bytes(freelist_bytes),
        "reclaimable_ratio": round(reclaimable_ratio, 2),
        "reclaimable_percent": int(reclaimable_ratio * 100),
        "photo_count": photo_count,
        "thumbnail_count": thumbnail_count,
        "backup_info": b_info,
    }


def vacuum_database() -> Dict[str, Any]:
    """
    データベースの空き領域を回収し、ファイルを最適化・圧縮する（VACUUM実行）。
    WALログのチェックポイントおよびスレッドローカル接続の一時解放を行う。
    """
    # 実行前の総ディスク使用量
    before_stats = get_database_stats()
    before_size = before_stats["file_size"]

    # スレッドローカルの既存接続があれば安全に解放
    if hasattr(_local_db, "connection") and _local_db.connection:
        try:
            _local_db.connection.close()
        except Exception as e:
            logger.warning(f"VACUUM前のスレッドローカル接続クローズで警告: {e}")
        _local_db.connection = None

    # VACUUM はアクティブなトランザクション外で実行する必要があるため、独立接続＆自動コミットで実行
    conn = sqlite3.connect(str(DB_PATH), timeout=60, isolation_level=None)
    conn.create_function("tetheract_v170_guard", 0, lambda: 1, deterministic=True)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()

    # 実行後の総ディスク使用量
    after_stats = get_database_stats()
    after_size = after_stats["file_size"]
    reclaimed_bytes = max(0, before_size - after_size)

    return {
        "before_size": before_size,
        "after_size": after_size,
        "before_size_formatted": format_bytes(before_size),
        "after_size_formatted": format_bytes(after_size),
        "reclaimed_size": reclaimed_bytes,
        "reclaimed_size_formatted": format_bytes(reclaimed_bytes),
    }


def backup_database(max_backups: int = 5) -> Dict[str, Any]:
    """
    SQLite の Online Backup API を使用して、稼働中のDBを安全にバックアップする。
    最大保持数 (max_backups) を超える古いバックアップは自動削除（世代管理）する。
    """
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUP_DIR / f"library_backup_{timestamp}.db"

    # WALの保留ログをフラッシュ
    with get_connection() as src_conn:
        try:
            src_conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except Exception as e:
            logger.warning(f"WALチェックポイント失敗 (バックアップ継続): {e}")

        dest_conn = sqlite3.connect(str(backup_path), timeout=60)
        try:
            src_conn.backup(dest_conn)
        finally:
            dest_conn.close()

    backup_size = backup_path.stat().st_size if backup_path.exists() else 0

    # 世代管理: 最新 max_backups 件を残し、古いバックアップを削除
    deleted_count = 0
    try:
        existing_files = sorted(
            BACKUP_DIR.glob("library_backup_*.db"),
            key=lambda x: x.stat().st_mtime,
            reverse=True,
        )
        if len(existing_files) > max_backups:
            for old_file in existing_files[max_backups:]:
                try:
                    old_file.unlink()
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"古いバックアップの削除失敗 ({old_file.name}): {e}")
    except Exception as e:
        logger.warning(f"バックアップ世代管理クリーンアップエラー: {e}")

    info = get_backup_info()

    # バックアップ時に復旧キー (recovery_key.txt) もバックアップフォルダへ同期出力する
    try:
        from ..security import get_security_status, save_recovery_key_file
        sec = get_security_status()
        if sec.get("recovery_code") and sec.get("owner_id_full"):
            save_recovery_key_file(sec["recovery_code"], sec["owner_id_full"], target_dir=BACKUP_DIR)
    except Exception as rec_err:
        logger.debug(f"バックアップ時の復旧キー保存スキップ: {rec_err}")

    return {
        "status": "success",
        "filename": backup_path.name,
        "size": backup_size,
        "size_formatted": format_bytes(backup_size),
        "total_backups": info["count"],
        "max_backups": max_backups,
        "deleted_count": deleted_count,
        "backup_info": info,
    }


def open_backup_directory() -> bool:
    """バックアップ保存先ディレクトリをOS標準のファイルマネージャ（Explorer）で開く"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.startfile(str(BACKUP_DIR.resolve()))
        return True
    except Exception as e:
        logger.error(f"バックアップフォルダ起動失敗: {e}")
        return False


