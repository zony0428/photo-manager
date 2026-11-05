"""
データベーススキーマ定義・マイグレーションモジュール
テーブル作成、インデックス構築、カラム追加、データ移行を管理する。
"""

import json
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List
from . import connection as _conn_mod
from .connection import get_connection
from .thumbnails import compute_thumbnail_hash
from .fingerprint import extract_folder_fingerprint
from .photos import (
    _compute_content_key,
    _split_link_path,
    _strip_vsn_prefix_raw,
    _sync_photo_links_state,
    migrate_and_merge_exifless_photos,
)
from .tags import (
    _ensure_tag_definitions_table,
    _ensure_tag_keys_registered,
    _expand_ancestor_tags,
    _generate_unique_tag_key,
    is_color_tag,
    repair_missing_ancestor_tags,
)

logger = logging.getLogger(__name__)

# 起動・DBマイグレーション進捗状態（スプラッシュ画面・ステータスポーリング用）
_startup_status: Dict[str, Any] = {
    "is_ready": False,
    "phase": "starting",
    "message": "ライブラリを初期化しています...",
    "detail": "",
    "percent": -1,
    "exifless_migration": None,
}


def get_startup_status() -> Dict[str, Any]:
    """起動・DBマイグレーションの現在ステータスを返す"""
    return dict(_startup_status)


def set_startup_status(
    *,
    is_ready: Any = None,
    phase: Any = None,
    message: Any = None,
    detail: Any = None,
    percent: Any = None,
    exifless_migration: Any = None,
) -> None:
    """起動・DBマイグレーションのステータスを更新する"""
    if is_ready is not None:
        _startup_status["is_ready"] = bool(is_ready)
    if phase is not None:
        _startup_status["phase"] = str(phase)
    if message is not None:
        _startup_status["message"] = str(message)
    if detail is not None:
        _startup_status["detail"] = str(detail)
    if percent is not None:
        _startup_status["percent"] = int(percent)
    if exifless_migration is not None:
        _startup_status["exifless_migration"] = exifless_migration


def _create_photos_indexes(cursor) -> None:
    """photos / photo_links / photo_tags / thumbnails の全インデックスとトリガーを構築する"""
    cursor.execute("DROP INDEX IF EXISTS idx_photos_date_taken")
    cursor.execute("DROP INDEX IF EXISTS idx_photos_date_taken_size")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_content_key ON photos(content_key)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_filepath ON photos(file_path)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_filepath_nocase ON photos(file_path COLLATE NOCASE)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_date_size_unlinked ON photos(date_taken, file_size, is_unlinked)")
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_photos_orig_date_size ON photos(original_date_taken, file_size) "
        "WHERE original_date_taken IS NOT NULL"
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_volume_name ON photos(volume_serial, file_name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_year_month ON photos(year_month)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_directory ON photos(directory_path)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_directory_nocase ON photos(directory_path COLLATE NOCASE)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_camera_model ON photos(camera_model)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_camera_lens ON photos(camera_model, lens_model)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_stack_id ON photos(stack_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_name_size ON photos(file_name, file_size)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_gps_date ON photos(date_taken) WHERE latitude IS NOT NULL")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_location ON photos(country, state, city)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_is_unlinked ON photos(is_unlinked)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_volume_serial ON photos(volume_serial)")

    # photo_links インデックス
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_links_photo_id ON photo_links(photo_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_links_vsn_reldir ON photo_links(volume_serial, rel_dir)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_links_dir_nocase ON photo_links(directory_path)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_links_filepath ON photo_links(file_path)")

    # photo_tags インデックス
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_tags_tag_photo ON photo_tags(tag, photo_id)")
    cursor.execute("DROP INDEX IF EXISTS idx_photo_tags_tag")
    cursor.execute("DROP INDEX IF EXISTS idx_photo_tags_photo")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_tags_source ON photo_tags(source)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_thumbnails_dims ON thumbnails(photo_id, width, height)")

    # photos 行削除時に photo_links / photo_tags / thumbnails を確実に連動削除するトリガー
    cursor.execute(
        """
        CREATE TRIGGER IF NOT EXISTS trg_photos_after_delete
        AFTER DELETE ON photos
        BEGIN
            DELETE FROM photo_links WHERE photo_id = OLD.id;
            DELETE FROM photo_tags WHERE photo_id = OLD.id;
            DELETE FROM thumbnails WHERE photo_id = OLD.id;
        END
        """
    )

    # v1.7.0 ダウングレード防止（v1.6.1以前へのDB放り込みによるエシカル保護バイパスを遮断）
    cursor.execute("PRAGMA table_xinfo(photos)")
    xcols = {row["name"] for row in cursor.fetchall()}
    if "_v170_guard" not in xcols:
        cursor.execute(
            "ALTER TABLE photos ADD COLUMN _v170_guard INTEGER GENERATED ALWAYS AS (tetheract_v170_guard()) VIRTUAL"
        )
    cursor.execute("PRAGMA table_xinfo(thumbnails)")
    th_xcols = {row["name"] for row in cursor.fetchall()}
    if "_v170_guard" not in th_xcols:
        cursor.execute(
            "ALTER TABLE thumbnails ADD COLUMN _v170_guard INTEGER GENERATED ALWAYS AS (tetheract_v170_guard()) VIRTUAL"
        )
    for tbl in ("photos", "thumbnails", "photo_tags"):
        for op in ("INSERT", "UPDATE", "DELETE"):
            op_short = op[:3].lower()
            cursor.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_v170_guard_{tbl}_{op_short}
                BEFORE {op} ON {tbl}
                BEGIN
                    SELECT tetheract_v170_guard();
                END
                """
            )
    cursor.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'")
    if cursor.fetchone():
        for op in ("INSERT", "UPDATE"):
            op_short = op[:3].lower()
            cursor.execute(
                f"""
                CREATE TRIGGER IF NOT EXISTS trg_v170_guard_app_meta_{op_short}
                BEFORE {op} ON app_meta
                BEGIN
                    SELECT tetheract_v170_guard();
                END
                """
            )


def initialize_database() -> None:
    """データベースの初期テーブル構造を作成する"""
    set_startup_status(is_ready=False, phase="schema", message="データベース構造を確認しています...", detail="", percent=10)
    with get_connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                directory_path TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_mtime REAL,
                width INTEGER,
                height INTEGER,
                date_taken TEXT,
                year_month TEXT,
                camera_model TEXT,
                rating INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0,
                exposure_bias REAL DEFAULT 0.0,
                shutter_speed TEXT,
                f_number REAL,
                iso INTEGER,
                focal_length REAL,
                lens_model TEXT,
                subsec_time TEXT,
                stack_id INTEGER,
                is_stack_primary INTEGER DEFAULT 1,
                stack_type TEXT,
                is_raw INTEGER DEFAULT 0,
                raw_format TEXT,
                paired_raw_path TEXT,
                volume_serial TEXT,
                latitude REAL,
                longitude REAL,
                gps_source TEXT,
                country TEXT,
                state TEXT,
                city TEXT,
                meta_dirty INTEGER DEFAULT 0,
                is_unlinked INTEGER DEFAULT 0,
                rotation INTEGER DEFAULT 0,
                fine_angle REAL DEFAULT 0.0,
                crop_x REAL,
                crop_y REAL,
                crop_w REAL,
                crop_h REAL,
                crop_aspect TEXT,
                brightness INTEGER DEFAULT 0,
                contrast INTEGER DEFAULT 0,
                saturation INTEGER DEFAULT 0,
                original_date_taken TEXT,
                content_key TEXT,
                link_count INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # 既存テーブルへのカラム追加マイグレーション
        cursor.execute("PRAGMA table_info(photos)")
        existing_cols = {row["name"] for row in cursor.fetchall()}
        new_cols = [
            ("file_mtime", "REAL"),
            ("width", "INTEGER"),
            ("height", "INTEGER"),
            ("date_taken", "TEXT"),
            ("year_month", "TEXT"),
            ("camera_model", "TEXT"),
            ("rating", "INTEGER DEFAULT 0"),
            ("is_favorite", "INTEGER DEFAULT 0"),
            ("exposure_bias", "REAL DEFAULT 0.0"),
            ("shutter_speed", "TEXT"),
            ("f_number", "REAL"),
            ("iso", "INTEGER"),
            ("focal_length", "REAL"),
            ("lens_model", "TEXT"),
            ("subsec_time", "TEXT"),
            ("stack_id", "INTEGER"),
            ("is_stack_primary", "INTEGER DEFAULT 1"),
            ("stack_type", "TEXT"),
            ("is_raw", "INTEGER DEFAULT 0"),
            ("raw_format", "TEXT"),
            ("paired_raw_path", "TEXT"),
            ("volume_serial", "TEXT"),
            ("latitude", "REAL"),
            ("longitude", "REAL"),
            ("gps_source", "TEXT"),
            ("country", "TEXT"),
            ("state", "TEXT"),
            ("city", "TEXT"),
            ("meta_dirty", "INTEGER DEFAULT 0"),
            ("is_unlinked", "INTEGER DEFAULT 0"),
            ("rotation", "INTEGER DEFAULT 0"),
            ("fine_angle", "REAL DEFAULT 0.0"),
            ("crop_x", "REAL"),
            ("crop_y", "REAL"),
            ("crop_w", "REAL"),
            ("crop_h", "REAL"),
            ("crop_aspect", "TEXT"),
            ("brightness", "INTEGER DEFAULT 0"),
            ("contrast", "INTEGER DEFAULT 0"),
            ("saturation", "INTEGER DEFAULT 0"),
            ("original_date_taken", "TEXT"),
            ("content_key", "TEXT"),
            ("link_count", "INTEGER DEFAULT 1"),
        ]
        for col_name, col_type in new_cols:
            if col_name not in existing_cols:
                cursor.execute(f"ALTER TABLE photos ADD COLUMN {col_name} {col_type}")

        # 実ファイルの所在リンク管理テーブル（1つのユニーク写真に対して複数メディア/フォルダのリンクを保持）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS photo_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_id INTEGER NOT NULL,
                volume_serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
                rel_path TEXT NOT NULL COLLATE NOCASE,
                rel_dir TEXT NOT NULL COLLATE NOCASE,
                file_path TEXT NOT NULL COLLATE NOCASE,
                directory_path TEXT NOT NULL COLLATE NOCASE,
                file_name TEXT NOT NULL COLLATE NOCASE,
                file_mtime REAL,
                paired_raw_path TEXT,
                is_primary INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(volume_serial, rel_path),
                FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
            )
            """
        )

        # 逆ジオコーディング座標キャッシュテーブル
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS geo_cache (
                lat_round REAL NOT NULL,
                lon_round REAL NOT NULL,
                country TEXT,
                state TEXT,
                city TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (lat_round, lon_round)
            )
            """
        )

        # タグ・アルバム管理テーブル（WITHOUT ROWID による省メモリ・高速カバリング構造）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS photo_tags (
                photo_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                source TEXT DEFAULT 'manual',
                confidence REAL DEFAULT 1.0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (photo_id, tag),
                FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
            ) WITHOUT ROWID
            """
        )
        # photo_tags マイグレーション（旧スキーマからの起動時互換用: source, confidence）
        cursor.execute("PRAGMA table_info(photo_tags)")
        existing_tag_cols = {row["name"] for row in cursor.fetchall()}
        if "source" not in existing_tag_cols:
            cursor.execute("ALTER TABLE photo_tags ADD COLUMN source TEXT DEFAULT 'manual'")
        if "confidence" not in existing_tag_cols:
            cursor.execute("ALTER TABLE photo_tags ADD COLUMN confidence REAL DEFAULT 1.0")

        # タグ定義テーブル（写真にまだ1枚も付与されていない空の親タグ・新規タグをツリー保持し、固有キー・ショート名・ピン留めを管理）
        _ensure_tag_definitions_table(cursor)

        # ボリューム情報管理テーブル（VSNをキーにラベル・ユーザー識別名・Loome有効状態を管理）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS volumes (
                volume_serial TEXT PRIMARY KEY,
                volume_label  TEXT NOT NULL DEFAULT '',
                custom_name   TEXT NOT NULL DEFAULT '',
                drive_letter  TEXT,
                loome_enabled INTEGER NOT NULL DEFAULT 0,
                last_seen_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("PRAGMA table_info(volumes)")
        existing_vol_cols = {row["name"] for row in cursor.fetchall()}
        if "custom_name" not in existing_vol_cols:
            cursor.execute("ALTER TABLE volumes ADD COLUMN custom_name TEXT NOT NULL DEFAULT ''")
        if "loome_enabled" not in existing_vol_cols:
            cursor.execute("ALTER TABLE volumes ADD COLUMN loome_enabled INTEGER NOT NULL DEFAULT 0")

        # サムネイル BLOB 格納テーブル（photo_id INTEGER PRIMARY KEY による ROWID 直結構造）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS thumbnails (
                photo_id INTEGER PRIMARY KEY,
                file_hash TEXT,
                data BLOB NOT NULL,
                width INTEGER,
                height INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
            )
            """
        )

        # スキャン登録ルートフォルダ管理テーブル（フィンガープリントによる別PC・別アカウント誤読防止対応）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS scan_roots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_path TEXT UNIQUE NOT NULL,
                fingerprint TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("PRAGMA table_info(scan_roots)")
        existing_root_cols = {row["name"] for row in cursor.fetchall()}
        if "fingerprint" not in existing_root_cols:
            cursor.execute("ALTER TABLE scan_roots ADD COLUMN fingerprint TEXT")

        # 除外（管理対象外）フォルダ管理テーブル
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS ignored_folders (
                folder_path TEXT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # フィルタプリセット（条件保存）テーブル
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS filter_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT DEFAULT '',
                filters TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # マイグレーション管理テーブル
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS migrations (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        # アプリメタ情報テーブル（モバイルオフラインDBにPCの最新LAN URL等を引き継ぐためのKey-Valueストア）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        _create_photos_indexes(cursor)
        conn.commit()

        # --- マイグレーション: 既存タグに祖先ノードを追加 ---
        cursor.execute("SELECT 1 FROM migrations WHERE name = 'ancestor_tags'")
        if not cursor.fetchone():
            _migrate_ancestor_tags(cursor)
            cursor.execute("INSERT INTO migrations (name) VALUES ('ancestor_tags')")
            conn.commit()

        # --- マイグレーション: 孤立・不整合サムネイルの修復 ---
        cursor.execute("SELECT 1 FROM migrations WHERE name = 'fix_mismatched_thumbnails_v1'")
        if not cursor.fetchone():
            _migrate_fix_mismatched_thumbnails(cursor)
            cursor.execute("INSERT INTO migrations (name) VALUES ('fix_mismatched_thumbnails_v1')")
            conn.commit()

        # --- マイグレーション: camera_model の NUL文字サニタイズ ---
        cursor.execute("SELECT 1 FROM migrations WHERE name = 'sanitize_camera_models_v1'")
        if not cursor.fetchone():
            _migrate_sanitize_camera_models(cursor)
            cursor.execute("INSERT INTO migrations (name) VALUES ('sanitize_camera_models_v1')")
            conn.commit()

        # --- マイグレーション: 5段階星評価 → 4段階評価（棄/可/良/優）への変換 ---
        cursor.execute("SELECT 1 FROM migrations WHERE name = 'rating_to_4tier_v1'")
        if not cursor.fetchone():
            _migrate_rating_to_4tier(cursor)
            cursor.execute("INSERT INTO migrations (name) VALUES ('rating_to_4tier_v1')")
            conn.commit()

        # --- マイグレーション: 全既存タグへの固有キー(tag_key)付与・プリセット引き継ぎ ---
        cursor.execute("SELECT 1 FROM migrations WHERE name = 'tag_keys_v1'")
        if not cursor.fetchone():
            _migrate_tag_keys_v1(cursor, conn)
            cursor.execute("INSERT INTO migrations (name) VALUES ('tag_keys_v1')")
            conn.commit()
        else:
            # マイグレーション適用済みでも、外部からの投入等で tag_key が欠落している行があれば常時修復する
            cursor.execute(
                "SELECT tag FROM tag_definitions WHERE tag_key IS NULL OR tag_key = ''"
            )
            missing_key_rows = [r["tag"] for r in cursor.fetchall()]
            if missing_key_rows:
                _ensure_tag_keys_registered(cursor, missing_key_rows)
                conn.commit()

        # --- マイグレーション: 理想データ構造（photos 重複排除 + photo_links + ROWID直結 thumbnails + WITHOUT ROWID photo_tags） ---
        cursor.execute("SELECT 1 FROM migrations WHERE name = 'ideal_photo_links_v1'")
        if not cursor.fetchone():
            set_startup_status(phase="migration_links", message="データベースを最新構造へ移行・安全バックアップ中...", detail="ideal_photo_links_v1", percent=45)
            _migrate_ideal_photo_links_v1(cursor, conn)
            cursor.execute("INSERT INTO migrations (name) VALUES ('ideal_photo_links_v1')")
            conn.commit()
        else:
            # マイグレーション適用済みでも、旧DDLテーブルまたは直接SQL投入されたレコードがあれば整合性を自己修復
            if _upgrade_legacy_schema_ddl(cursor, conn):
                conn.commit()
            if _ensure_photo_links_synced(cursor):
                conn.commit()

        # --- マイグレーション: v1.2.0 初版DDL再構築時の CASCADE DELETE で消失した photo_tags / thumbnails を事前バックアップから自動復元 ---
        cursor.execute("SELECT 1 FROM migrations WHERE name = 'restore_cascaded_tags_and_thumbs_v1'")
        if not cursor.fetchone():
            set_startup_status(phase="migration_restore", message="タグ・サムネイル整合性を検証・復元中...", detail="restore_cascaded_tags_and_thumbs_v1", percent=70)
            _restore_cascaded_tags_and_thumbs_from_backup(cursor, conn)
            cursor.execute("INSERT INTO migrations (name) VALUES ('restore_cascaded_tags_and_thumbs_v1')")
            conn.commit()

        # 起動時の高速整合性チェック: 階層タグの親・祖先レコード欠落があれば自動補完（カバリングインデックス使用）
        repaired_anc_count = repair_missing_ancestor_tags(cursor)
        if repaired_anc_count > 0:
            conn.commit()
            print(f"[MIGRATE] ancestor_tags_repair: {repaired_anc_count} 件の欠落していた親・祖先タグレコードを自動補完しました")

        # 起動時の常時安全パージ: photosテーブルに存在しない孤立サムネイルを確実に削除
        cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
        # リンク消失写真 (is_unlinked = 1) に残存していた旧 volume_serial をクリア
        cursor.execute("UPDATE photos SET volume_serial = NULL WHERE is_unlinked = 1 AND volume_serial IS NOT NULL")
        conn.commit()

        # ドライブ直下などの無効なスキャンルートを安全に削除
        cursor.execute("DELETE FROM scan_roots WHERE length(rtrim(replace(folder_path, '/', '\\'), '\\')) <= 2 OR folder_path LIKE '%:'")
        conn.commit()

    # セキュリティ状態（Lv.0 エシカル保護・別環境DB持ち込み検知・Lv.1/Lv.2 ロック判定）を
    # ファイルシステム走査マイグレーションより先に初期化する
    locked_now = False
    try:
        from ..security import initialize_security_state, is_app_locked
        initialize_security_state(force_reload=True)
        locked_now = is_app_locked()
    except Exception as sec_err:
        logger.warning(f"セキュリティ状態の初期化で警告: {sec_err}")

    if not locked_now:
        with get_connection() as conn:
            cursor = conn.cursor()
            # 指紋未設定の既存スキャンルートについて、フォルダが存在すれば初期指紋を自動付与（UNCパスは起動時SMBブロック回避のためスキップ）
            cursor.execute("SELECT folder_path FROM scan_roots WHERE fingerprint IS NULL")
            unfingerprinted = [r["folder_path"] for r in cursor.fetchall()]
            for f_path in unfingerprinted:
                norm = os.path.normpath(f_path).rstrip("\\/")
                if len(norm) <= 2 or norm.endswith(":") or norm.startswith("\\\\"):
                    continue
                if os.path.exists(f_path) and os.path.isdir(f_path):
                    try:
                        fp = extract_folder_fingerprint(f_path)
                        if fp:
                            cursor.execute(
                                "UPDATE scan_roots SET fingerprint = ? WHERE folder_path = ?",
                                (fp, f_path)
                            )
                            conn.commit()
                    except Exception as e:
                        logger.warning(f"スキャンルートのフィンガープリント更新失敗 ({f_path}): {e}")

            # --- マイグレーション: Exif（撮影日時）欠落画像の識別キー更新・重複統合 ---
            # ※ 大規模DB（写真500枚超）の場合はUvicornのポート待受開始をブロックしないようバックグラウンドで実行する
            cursor.execute("SELECT 1 FROM migrations WHERE name = 'exifless_content_hash_v1'")
            if not cursor.fetchone():
                cursor.execute("SELECT COUNT(*) FROM photos")
                total_photos_cnt = int(cursor.fetchone()[0] or 0)
                if total_photos_cnt <= 500:
                    conn.commit()
                    try:
                        exifless_res = migrate_and_merge_exifless_photos()
                        set_startup_status(exifless_migration=exifless_res)
                    except Exception as ex_mig_err:
                        logger.warning(f"Exifなし画像の移行処理で警告: {ex_mig_err}")
                    cursor.execute("INSERT OR IGNORE INTO migrations (name) VALUES ('exifless_content_hash_v1')")
                    conn.commit()

            # クエリオプティマイザのインデックス統計を最新化
            cursor.execute("PRAGMA optimize")
            conn.commit()

    set_startup_status(is_ready=True, phase="ready", message="準備完了", detail="", percent=100)


def _upgrade_legacy_schema_ddl(cursor, conn) -> bool:
    """
    既存DBのテーブル定義が旧スキーマ（photos.file_path の UNIQUE 制約、photo_tags の id カラム、
    thumbnails の file_hash PRIMARY KEY）である場合に、新スキーマへ安全に再構築する。
    ※ SQLite では PRAGMA foreign_keys = ON のまま親テーブル (photos) を DROP すると、
       FOREIGN KEY ... ON DELETE CASCADE を持つ子テーブル (photo_tags / thumbnails) の全行が
       カスケード削除されてしまうため、必ずトランザクションを確定して foreign_keys = OFF にした上で、
       さらに子テーブルのデータを一時退避して旧子テーブルを先に DROP してから photos を再構築する。
    """
    # 1. photos テーブルの file_path UNIQUE 制約の有無を検査
    cursor.execute("PRAGMA index_list(photos)")
    has_unique_filepath = False
    for idx in cursor.fetchall():
        if idx["unique"]:
            cursor.execute(f"PRAGMA index_info('{idx['name']}')")
            cols = [r["name"] for r in cursor.fetchall()]
            if cols == ["file_path"]:
                has_unique_filepath = True
                break

    # 2. photo_tags テーブルの再構築要否を検査
    cursor.execute("PRAGMA table_info(photo_tags)")
    pt_cols = {r["name"] for r in cursor.fetchall()}
    cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='photo_tags'")
    pt_sql_row = cursor.fetchone()
    pt_sql = (pt_sql_row["sql"] or "").upper() if pt_sql_row else ""
    need_rebuild_pt = bool("id" in pt_cols or "WITHOUT ROWID" not in pt_sql or has_unique_filepath)

    # 3. thumbnails テーブルの再構築要否を検査
    cursor.execute("PRAGMA table_info(thumbnails)")
    th_info = [dict(r) for r in cursor.fetchall()]
    th_cols = {r["name"] for r in th_info}
    pk_cols = [r["name"] for r in th_info if r.get("pk")]
    need_rebuild_th = bool(pk_cols != ["photo_id"] or has_unique_filepath)

    if not (has_unique_filepath or need_rebuild_pt or need_rebuild_th):
        return False

    # トランザクション外で PRAGMA foreign_keys = OFF を確実に有効化する
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        cursor.execute("DROP TRIGGER IF EXISTS trg_photos_after_delete")
        cursor.execute("DROP TRIGGER IF EXISTS trg_v170_guard_photos_ins")
        cursor.execute("DROP TRIGGER IF EXISTS trg_v170_guard_photos_upd")
        cursor.execute("DROP TRIGGER IF EXISTS trg_v170_guard_photos_del")

        # 先に子テーブル (photo_tags / thumbnails) のデータを退避し、旧テーブルを DROP して CASCADE DELETE を物理的に遮断
        if need_rebuild_pt:
            has_pt_created = "created_at" in pt_cols
            pt_created_sel = "COALESCE(created_at, CURRENT_TIMESTAMP)" if has_pt_created else "CURRENT_TIMESTAMP"
            pt_src_sel = "COALESCE(source, 'manual')" if "source" in pt_cols else "'manual'"
            pt_conf_sel = "COALESCE(confidence, 1.0)" if "confidence" in pt_cols else "1.0"
            cursor.execute("DROP TABLE IF EXISTS _mig_bak_photo_tags")
            cursor.execute(
                f"""
                CREATE TABLE _mig_bak_photo_tags AS
                SELECT photo_id, tag, {pt_src_sel} AS source, {pt_conf_sel} AS confidence, {pt_created_sel} AS created_at
                FROM photo_tags
                """
            )
            cursor.execute("DROP TABLE photo_tags")

        if need_rebuild_th:
            th_created_sel = "COALESCE(created_at, CURRENT_TIMESTAMP)" if "created_at" in th_cols else "CURRENT_TIMESTAMP"
            cursor.execute("DROP TABLE IF EXISTS _mig_bak_thumbnails")
            cursor.execute(
                f"""
                CREATE TABLE _mig_bak_thumbnails AS
                SELECT photo_id, file_hash, data, width, height, {th_created_sel} AS created_at
                FROM thumbnails
                WHERE photo_id IS NOT NULL
                """
            )
            cursor.execute("DROP TABLE thumbnails")

        if has_unique_filepath:
            cursor.execute("DROP TABLE IF EXISTS _mig_bak_photo_links")
            cursor.execute("CREATE TABLE _mig_bak_photo_links AS SELECT * FROM photo_links")
            cursor.execute("DROP TABLE photo_links")

            cursor.execute(
                """
                CREATE TABLE photos_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    directory_path TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    file_mtime REAL,
                    width INTEGER,
                    height INTEGER,
                    date_taken TEXT,
                    year_month TEXT,
                    camera_model TEXT,
                    rating INTEGER DEFAULT 0,
                    is_favorite INTEGER DEFAULT 0,
                    exposure_bias REAL DEFAULT 0.0,
                    shutter_speed TEXT,
                    f_number REAL,
                    iso INTEGER,
                    focal_length REAL,
                    lens_model TEXT,
                    subsec_time TEXT,
                    stack_id INTEGER,
                    is_stack_primary INTEGER DEFAULT 1,
                    stack_type TEXT,
                    is_raw INTEGER DEFAULT 0,
                    raw_format TEXT,
                    paired_raw_path TEXT,
                    volume_serial TEXT,
                    latitude REAL,
                    longitude REAL,
                    gps_source TEXT,
                    country TEXT,
                    state TEXT,
                    city TEXT,
                    meta_dirty INTEGER DEFAULT 0,
                    is_unlinked INTEGER DEFAULT 0,
                    rotation INTEGER DEFAULT 0,
                    fine_angle REAL DEFAULT 0.0,
                    crop_x REAL,
                    crop_y REAL,
                    crop_w REAL,
                    crop_h REAL,
                    crop_aspect TEXT,
                    brightness INTEGER DEFAULT 0,
                    contrast INTEGER DEFAULT 0,
                    saturation INTEGER DEFAULT 0,
                    original_date_taken TEXT,
                    content_key TEXT,
                    link_count INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            cursor.execute("PRAGMA table_info(photos)")
            old_cols = {r["name"] for r in cursor.fetchall()}
            cursor.execute("PRAGMA table_info(photos_new)")
            new_cols = [r["name"] for r in cursor.fetchall()]
            common_cols = [c for c in new_cols if c in old_cols]
            col_list = ", ".join(common_cols)
            cursor.execute(f"INSERT INTO photos_new ({col_list}) SELECT {col_list} FROM photos")
            cursor.execute("DROP TABLE photos")
            cursor.execute("ALTER TABLE photos_new RENAME TO photos")

            cursor.execute(
                """
                CREATE TABLE photo_links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    photo_id INTEGER NOT NULL,
                    volume_serial TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
                    rel_path TEXT NOT NULL COLLATE NOCASE,
                    rel_dir TEXT NOT NULL COLLATE NOCASE,
                    file_path TEXT NOT NULL COLLATE NOCASE,
                    directory_path TEXT NOT NULL COLLATE NOCASE,
                    file_name TEXT NOT NULL COLLATE NOCASE,
                    file_mtime REAL,
                    paired_raw_path TEXT,
                    is_primary INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(volume_serial, rel_path),
                    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
                )
                """
            )
            cursor.execute("INSERT OR IGNORE INTO photo_links SELECT * FROM _mig_bak_photo_links")
            cursor.execute("DROP TABLE _mig_bak_photo_links")

        if need_rebuild_pt:
            cursor.execute(
                """
                CREATE TABLE photo_tags (
                    photo_id INTEGER NOT NULL,
                    tag TEXT NOT NULL,
                    source TEXT DEFAULT 'manual',
                    confidence REAL DEFAULT 1.0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (photo_id, tag),
                    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
                ) WITHOUT ROWID
                """
            )
            cursor.execute(
                """
                INSERT INTO photo_tags (photo_id, tag, source, confidence, created_at)
                SELECT photo_id, tag, source, confidence, created_at
                FROM _mig_bak_photo_tags
                WHERE photo_id IS NOT NULL AND tag IS NOT NULL
                ON CONFLICT(photo_id, tag) DO UPDATE SET
                    source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE photo_tags.source END,
                    confidence = CASE WHEN excluded.source = 'manual' THEN 1.0 ELSE MAX(COALESCE(photo_tags.confidence, 0.0), COALESCE(excluded.confidence, 0.0)) END
                """
            )
            cursor.execute("DROP TABLE _mig_bak_photo_tags")

        if need_rebuild_th:
            cursor.execute(
                """
                CREATE TABLE thumbnails (
                    photo_id INTEGER PRIMARY KEY,
                    file_hash TEXT,
                    data BLOB NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
                )
                """
            )
            cursor.execute(
                """
                INSERT OR REPLACE INTO thumbnails (photo_id, file_hash, data, width, height, created_at)
                SELECT photo_id, file_hash, data, width, height, created_at
                FROM _mig_bak_thumbnails
                WHERE photo_id IS NOT NULL AND data IS NOT NULL
                """
            )
            cursor.execute("DROP TABLE _mig_bak_thumbnails")

        _create_photos_indexes(cursor)
        conn.commit()
    finally:
        conn.commit()
        conn.execute("PRAGMA foreign_keys = ON")

    return True


def _ensure_photo_links_synced(cursor) -> int:
    """
    content_key が未計算の photos レコード、またはアクティブ (is_unlinked=0) なのに
    photo_links が未登録のレコード（テスト等で直接 SQL INSERT された行など）を自動補完する。
    """
    cursor.execute(
        """
        SELECT id, file_path, file_name, directory_path, file_size, file_mtime,
               width, height, date_taken, original_date_taken, is_raw, raw_format,
               paired_raw_path, volume_serial, is_unlinked, content_key,
               subsec_time, shutter_speed, f_number, iso, exposure_bias
        FROM photos
        WHERE content_key IS NULL
           OR file_path LIKE 'vsn://%'
           OR (IFNULL(is_unlinked, 0) = 0 AND NOT EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = photos.id))
        """
    )
    rows = [dict(r) for r in cursor.fetchall()]
    if not rows:
        return 0

    for r in rows:
        pid = int(r["id"])
        vsn_norm, rel_path, rel_dir, clean_fp, clean_dir = _split_link_path(
            r.get("file_path"),
            r.get("directory_path"),
            r.get("volume_serial"),
        )
        fname = r.get("file_name") or os.path.basename(clean_fp)
        r["file_path"] = clean_fp
        r["directory_path"] = clean_dir
        r["file_name"] = fname
        ckey = r.get("content_key") or _compute_content_key(r)

        if int(r.get("is_unlinked") or 0) == 0 and clean_fp:
            cursor.execute(
                """
                INSERT OR IGNORE INTO photo_links (
                    photo_id, volume_serial, rel_path, rel_dir,
                    file_path, directory_path, file_name, file_mtime, paired_raw_path, is_primary
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    pid,
                    vsn_norm,
                    rel_path,
                    rel_dir,
                    clean_fp,
                    clean_dir,
                    fname,
                    r.get("file_mtime"),
                    _strip_vsn_prefix_raw(r.get("paired_raw_path")) if r.get("paired_raw_path") else None,
                ),
            )
            cursor.execute(
                "UPDATE photos SET content_key = ?, file_path = ?, directory_path = ?, file_name = ? WHERE id = ?",
                (ckey, clean_fp, clean_dir, fname, pid),
            )
            _sync_photo_links_state(cursor, pid)
        else:
            cursor.execute(
                "UPDATE photos SET content_key = ?, file_path = ?, directory_path = ?, file_name = ?, link_count = 0 WHERE id = ?",
                (ckey, clean_fp, clean_dir, fname, pid),
            )

    return len(rows)


def _migrate_ideal_photo_links_v1(cursor, conn) -> None:
    """
    レガシーDBから理想のデータ構造（4点セット）へ自動移行するマイグレーション:
    1. テーブル構造を最新化（photos.file_path の UNIQUE 撤廃、photo_tags の WITHOUT ROWID 化、thumbnails の photo_id PK 化）
    2. 全 photos レコードの vsn:// 退避プレフィックスを正規パスへ復元し、content_key を算出
    3. 同一 content_key を持つ重複 photos 行を代表 1 行に統合（評価・お気に入り・非破壊調整・GPS・日時シフト・タグ・サムネイルを完全マージ）
    4. 各実ファイルの所在を photo_links テーブルへ展開し、link_count と代表パスを同期
    """
    _create_pre_migration_backup(cursor, conn, "ideal_photo_links_v1")
    _upgrade_legacy_schema_ddl(cursor, conn)

    cursor.execute("SELECT * FROM photos ORDER BY id ASC")
    all_photos = [dict(r) for r in cursor.fetchall()]
    if not all_photos:
        return

    groups: Dict[str, List[Dict[str, Any]]] = {}
    for p in all_photos:
        vsn_norm, rel_path, rel_dir, clean_fp, clean_dir = _split_link_path(
            p.get("file_path"),
            p.get("directory_path"),
            p.get("volume_serial"),
        )
        p["_vsn_norm"] = vsn_norm
        p["_rel_path"] = rel_path
        p["_rel_dir"] = rel_dir
        p["_clean_fp"] = clean_fp
        p["_clean_dir"] = clean_dir
        p["_clean_fname"] = p.get("file_name") or os.path.basename(clean_fp)
        p["_clean_paired"] = _strip_vsn_prefix_raw(p.get("paired_raw_path")) if p.get("paired_raw_path") else None
        ckey = _compute_content_key(p)
        p["_ckey"] = ckey
        group_key = ckey if ckey else f"__id_{p['id']}__"
        groups.setdefault(group_key, []).append(p)

    merged_duplicates_count = 0
    total_links_created = 0

    for _gkey, members in groups.items():
        if len(members) == 1:
            m = members[0]
            pid = int(m["id"])
            is_unl = 1 if int(m.get("is_unlinked") or 0) == 1 else 0
            if is_unl == 0 and m["_clean_fp"]:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO photo_links (
                        photo_id, volume_serial, rel_path, rel_dir,
                        file_path, directory_path, file_name, file_mtime, paired_raw_path, is_primary
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    """,
                    (
                        pid,
                        m["_vsn_norm"],
                        m["_rel_path"],
                        m["_rel_dir"],
                        m["_clean_fp"],
                        m["_clean_dir"],
                        m["_clean_fname"],
                        m.get("file_mtime"),
                        m["_clean_paired"],
                    ),
                )
                total_links_created += 1
                cursor.execute(
                    """
                    UPDATE photos
                    SET file_path = ?, directory_path = ?, file_name = ?,
                        paired_raw_path = ?, content_key = ?, link_count = 1
                    WHERE id = ?
                    """,
                    (m["_clean_fp"], m["_clean_dir"], m["_clean_fname"], m["_clean_paired"], m["_ckey"], pid),
                )
            else:
                cursor.execute(
                    """
                    UPDATE photos
                    SET file_path = ?, directory_path = ?, file_name = ?,
                        paired_raw_path = ?, content_key = ?, link_count = 0, is_unlinked = 1
                    WHERE id = ?
                    """,
                    (m["_clean_fp"], m["_clean_dir"], m["_clean_fname"], m["_clean_paired"], m["_ckey"], pid),
                )
            continue

        # 複数メンバーが存在する重複グループ: 代表 (master) を1つ選定して他メンバーを統合
        def _member_priority(x: Dict[str, Any]):
            active = 1 if int(x.get("is_unlinked") or 0) == 0 else 0
            has_rating = 1 if int(x.get("rating") or 0) != 0 or int(x.get("is_favorite") or 0) != 0 else 0
            has_adj = 1 if (
                int(x.get("rotation") or 0) != 0
                or abs(float(x.get("fine_angle") or 0.0)) > 1e-4
                or x.get("crop_w") is not None
                or int(x.get("brightness") or 0) != 0
                or int(x.get("contrast") or 0) != 0
                or int(x.get("saturation") or 0) != 0
            ) else 0
            has_gps = 1 if (x.get("latitude") is not None and x.get("longitude") is not None) else 0
            return (active, has_rating, has_adj, has_gps, -int(x["id"]))

        sorted_members = sorted(members, key=_member_priority, reverse=True)
        master = sorted_members[0]
        master_id = int(master["id"])
        secondaries = sorted_members[1:]

        from .duplicates import _copy_metadata_to_duplicate_with_cursor
        for sec in secondaries:
            _copy_metadata_to_duplicate_with_cursor(cursor, int(sec["id"]), master_id)

        # 全メンバーの有効リンクを master_id の photo_links に登録
        active_members = [m for m in sorted_members if int(m.get("is_unlinked") or 0) == 0 and m["_clean_fp"]]
        for idx, m in enumerate(active_members):
            cursor.execute(
                """
                INSERT OR REPLACE INTO photo_links (
                    photo_id, volume_serial, rel_path, rel_dir,
                    file_path, directory_path, file_name, file_mtime, paired_raw_path, is_primary
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    master_id,
                    m["_vsn_norm"],
                    m["_rel_path"],
                    m["_rel_dir"],
                    m["_clean_fp"],
                    m["_clean_dir"],
                    m["_clean_fname"],
                    m.get("file_mtime"),
                    m["_clean_paired"],
                    1 if idx == 0 else 0,
                ),
            )
            total_links_created += 1

        sec_ids = [int(s["id"]) for s in secondaries]
        if sec_ids:
            ph = ",".join(["?"] * len(sec_ids))
            cursor.execute(f"UPDATE photos SET stack_id = ? WHERE stack_id IN ({ph})", [master_id] + sec_ids)
            cursor.execute(f"DELETE FROM photos WHERE id IN ({ph})", sec_ids)
            merged_duplicates_count += len(sec_ids)

        cursor.execute(
            """
            UPDATE photos
            SET content_key = ?,
                stack_id = CASE WHEN stack_type = 'duplicate' THEN NULL ELSE stack_id END,
                is_stack_primary = CASE WHEN stack_type = 'duplicate' THEN 1 ELSE is_stack_primary END,
                stack_type = CASE WHEN stack_type = 'duplicate' THEN NULL ELSE stack_type END
            WHERE id = ?
            """,
            (master["_ckey"], master_id),
        )
        _sync_photo_links_state(cursor, master_id)

    print(
        f"[MIGRATE] ideal_photo_links_v1: 所在リンク {total_links_created} 件を構築し、"
        f"重複レコード {merged_duplicates_count} 件を統合しました"
    )


def _restore_cascaded_tags_and_thumbs_from_backup(cursor, conn) -> None:
    """
    v1.2.0 初版の DDL 再構築時に ON DELETE CASCADE で消失した photo_tags / thumbnails、
    および旧 content_key で誤統合された同一秒・同一サイズの連写・ブラケット別コマを、
    自動作成された事前バックアップ (library_pre_ideal_photo_links_v1_*.db) から無損失で自動復元する。
    """
    try:
        db_file = ""
        cursor.execute("PRAGMA database_list")
        for row in cursor.fetchall():
            if row["name"] == "main" and row["file"]:
                db_file = row["file"]
                break
        if not db_file:
            db_file = str(_conn_mod.DB_PATH)
        if not db_file or not os.path.isfile(db_file):
            return

        backup_dir = Path(db_file).parent / "backups"
        if not backup_dir.is_dir():
            return

        candidates = sorted(
            backup_dir.glob("library_pre_ideal_photo_links_v1_*.db"),
            key=lambda p: p.stat().st_mtime,
        )
        if not candidates:
            return

        best_bck = None
        best_score = -1
        for cand in candidates:
            try:
                bc = sqlite3.connect(f"file:{cand.as_posix()}?mode=ro", uri=True)
                bc.create_function("tetheract_v170_guard", 0, lambda: 1, deterministic=True)
                try:
                    t_cnt = bc.execute("SELECT COUNT(*) FROM photo_tags").fetchone()[0]
                    th_cnt = bc.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0]
                    score = int(t_cnt) * 10 + int(th_cnt)
                    if score > best_score:
                        best_score = score
                        best_bck = cand
                finally:
                    bc.close()
            except Exception:
                continue

        if not best_bck or best_score <= 0:
            return

        bck_conn = sqlite3.connect(f"file:{best_bck.as_posix()}?mode=ro", uri=True)
        bck_conn.create_function("tetheract_v170_guard", 0, lambda: 1, deterministic=True)
        bck_conn.row_factory = sqlite3.Row
        try:
            bck_cur = bck_conn.cursor()

            # 1. 現在の photos の ID と新 content_key を把握し、全行の content_key を新方式に更新
            cursor.execute("SELECT * FROM photos")
            curr_photos = [dict(r) for r in cursor.fetchall()]
            curr_ids = {int(p["id"]) for p in curr_photos}
            curr_ckeys = {}
            ckey_updates = []
            for p in curr_photos:
                pid = int(p["id"])
                new_ck = _compute_content_key(p)
                if new_ck:
                    curr_ckeys[new_ck] = pid
                if new_ck != p.get("content_key"):
                    ckey_updates.append((new_ck, pid))
            if ckey_updates:
                cursor.executemany("UPDATE photos SET content_key = ? WHERE id = ?", ckey_updates)

            # 2. バックアップ内の全 photos を走査し、旧 content_key で誤統合された連写・ブラケット別コマがあれば分離・復元
            bck_cur.execute("SELECT * FROM photos ORDER BY id ASC")
            bck_photos = [dict(r) for r in bck_cur.fetchall()]

            cursor.execute("PRAGMA table_info(photos)")
            curr_photo_cols = [r["name"] for r in cursor.fetchall()]
            bck_cur.execute("PRAGMA table_info(photos)")
            bck_photo_cols = {r["name"] for r in bck_cur.fetchall()}
            common_photo_cols = [c for c in curr_photo_cols if c in bck_photo_cols]
            col_names_sql = ", ".join(common_photo_cols)
            col_placeholders = ", ".join(["?"] * len(common_photo_cols))

            unmerged_count = 0
            affected_master_ids = set()
            for bp in bck_photos:
                oid = int(bp["id"])
                vsn_norm, rel_path, rel_dir, clean_fp, clean_dir = _split_link_path(
                    bp.get("file_path"),
                    bp.get("directory_path"),
                    bp.get("volume_serial"),
                )
                bp["_vsn_norm"] = vsn_norm
                bp["_rel_path"] = rel_path
                bp["_rel_dir"] = rel_dir
                bp["_clean_fp"] = clean_fp
                bp["_clean_dir"] = clean_dir
                bp["_clean_fname"] = bp.get("file_name") or os.path.basename(clean_fp)
                bp["_clean_paired"] = _strip_vsn_prefix_raw(bp.get("paired_raw_path")) if bp.get("paired_raw_path") else None

                bp_for_ck = dict(bp)
                bp_for_ck["file_path"] = clean_fp
                bp_for_ck["directory_path"] = clean_dir
                bp_for_ck["file_name"] = bp["_clean_fname"]
                ck = _compute_content_key(bp_for_ck)
                bp["_ckey"] = ck

                if oid not in curr_ids and ck:
                    if ck not in curr_ckeys:
                        # 同一秒・同一ファイルサイズだが subsec_time や露出が異なる別コマを復元
                        bp["file_path"] = clean_fp
                        bp["directory_path"] = clean_dir
                        bp["file_name"] = bp["_clean_fname"]
                        bp["paired_raw_path"] = bp["_clean_paired"]
                        bp["content_key"] = ck
                        vals = [bp.get(c) for c in common_photo_cols]
                        cursor.execute(
                            f"INSERT OR IGNORE INTO photos ({col_names_sql}) VALUES ({col_placeholders})",
                            vals,
                        )
                        curr_ids.add(oid)
                        curr_ckeys[ck] = oid
                        unmerged_count += 1

                    target_entity_id = curr_ckeys[ck]
                    cursor.execute(
                        "SELECT id, photo_id FROM photo_links WHERE volume_serial = ? AND rel_path = ? COLLATE NOCASE",
                        (vsn_norm, rel_path),
                    )
                    lk_row = cursor.fetchone()
                    if lk_row:
                        prev_master_id = int(lk_row["photo_id"])
                        if prev_master_id != target_entity_id:
                            cursor.execute(
                                "UPDATE photo_links SET photo_id = ? WHERE id = ?",
                                (target_entity_id, lk_row["id"]),
                            )
                            affected_master_ids.add(prev_master_id)
                            affected_master_ids.add(target_entity_id)
                    elif int(bp.get("is_unlinked") or 0) == 0 and clean_fp:
                        cursor.execute(
                            """
                            INSERT OR REPLACE INTO photo_links (
                                photo_id, volume_serial, rel_path, rel_dir,
                                file_path, directory_path, file_name, file_mtime, paired_raw_path, is_primary
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                            """,
                            (
                                target_entity_id,
                                vsn_norm,
                                rel_path,
                                rel_dir,
                                clean_fp,
                                clean_dir,
                                bp["_clean_fname"],
                                bp.get("file_mtime"),
                                bp["_clean_paired"],
                            ),
                        )
                        affected_master_ids.add(target_entity_id)

            for m_id in affected_master_ids:
                _sync_photo_links_state(cursor, m_id)

            # 3. バックアップ photo_id -> 現在の photo_id の完全マッピングを構築
            cursor.execute("SELECT photo_id, volume_serial, rel_path FROM photo_links")
            curr_links_map = {
                ((r["volume_serial"] or "").upper(), (r["rel_path"] or "").lower()): int(r["photo_id"])
                for r in cursor.fetchall()
            }

            id_map: Dict[int, int] = {}
            for bp in bck_photos:
                oid = int(bp["id"])
                if oid in curr_ids:
                    id_map[oid] = oid
                    continue
                lk_key = (bp["_vsn_norm"].upper(), bp["_rel_path"].lower())
                if lk_key in curr_links_map:
                    id_map[oid] = curr_links_map[lk_key]
                    continue
                ck = bp["_ckey"]
                if ck and ck in curr_ckeys:
                    id_map[oid] = curr_ckeys[ck]

            # 4. photo_tags の復元
            bck_cur.execute("PRAGMA table_info(photo_tags)")
            bpt_cols = {r["name"] for r in bck_cur.fetchall()}
            bpt_src = "COALESCE(source, 'manual')" if "source" in bpt_cols else "'manual'"
            bpt_conf = "COALESCE(confidence, 1.0)" if "confidence" in bpt_cols else "1.0"
            bpt_created = "COALESCE(created_at, CURRENT_TIMESTAMP)" if "created_at" in bpt_cols else "CURRENT_TIMESTAMP"

            bck_cur.execute(
                f"SELECT photo_id, tag, {bpt_src} AS source, {bpt_conf} AS confidence, {bpt_created} AS created_at FROM photo_tags"
            )
            tag_rows_to_insert = []
            for tr in bck_cur.fetchall():
                old_pid = int(tr["photo_id"])
                target_pid = id_map.get(old_pid)
                tag_val = tr["tag"]
                if target_pid is not None and tag_val:
                    tag_rows_to_insert.append((target_pid, tag_val, tr["source"], tr["confidence"], tr["created_at"]))

            restored_tags = 0
            if tag_rows_to_insert:
                before_tags_cnt = cursor.execute("SELECT COUNT(*) FROM photo_tags").fetchone()[0]
                cursor.executemany(
                    """
                    INSERT INTO photo_tags (photo_id, tag, source, confidence, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(photo_id, tag) DO UPDATE SET
                        source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE photo_tags.source END,
                        confidence = CASE WHEN excluded.source = 'manual' THEN 1.0 ELSE MAX(COALESCE(photo_tags.confidence, 0.0), COALESCE(excluded.confidence, 0.0)) END
                    """,
                    tag_rows_to_insert,
                )
                after_tags_cnt = cursor.execute("SELECT COUNT(*) FROM photo_tags").fetchone()[0]
                restored_tags = max(0, after_tags_cnt - before_tags_cnt)

            # 5. thumbnails の復元（代表ID自身のサムネイルを優先し、次に統合セカンダリIDのサムネイルを補完）
            bck_cur.execute("PRAGMA table_info(thumbnails)")
            bth_cols = {r["name"] for r in bck_cur.fetchall()}
            bth_created = "COALESCE(created_at, CURRENT_TIMESTAMP)" if "created_at" in bth_cols else "CURRENT_TIMESTAMP"
            bck_cur.execute(
                f"SELECT photo_id, file_hash, data, width, height, {bth_created} AS created_at FROM thumbnails WHERE photo_id IS NOT NULL AND data IS NOT NULL"
            )
            primary_thumbs = []
            secondary_thumbs = []
            for thr in bck_cur.fetchall():
                old_pid = int(thr["photo_id"])
                target_pid = id_map.get(old_pid)
                if target_pid is None:
                    continue
                rec = (target_pid, thr["file_hash"], thr["data"], thr["width"], thr["height"], thr["created_at"])
                if old_pid == target_pid:
                    primary_thumbs.append(rec)
                else:
                    secondary_thumbs.append(rec)

            restored_thumbs = 0
            if primary_thumbs or secondary_thumbs:
                before_thumbs_cnt = cursor.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0]
                cursor.executemany(
                    """
                    INSERT OR IGNORE INTO thumbnails (photo_id, file_hash, data, width, height, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    primary_thumbs + secondary_thumbs,
                )
                after_thumbs_cnt = cursor.execute("SELECT COUNT(*) FROM thumbnails").fetchone()[0]
                restored_thumbs = max(0, after_thumbs_cnt - before_thumbs_cnt)

            if restored_tags > 0 or restored_thumbs > 0 or unmerged_count > 0:
                repair_missing_ancestor_tags(cursor)
                print(
                    f"[MIGRATE] restore_cascaded_tags_and_thumbs_v1: バックアップ ({best_bck.name}) から "
                    f"タグ {restored_tags} 件・サムネイル {restored_thumbs} 件・連写別コマ {unmerged_count} 件を復元しました"
                )
        finally:
            bck_conn.close()
    except Exception as e:
        logger.warning(f"[MIGRATE] restore_cascaded_tags_and_thumbs_v1 実行中に警告が発生しました: {e}")


def _create_pre_migration_backup(cursor, conn, migration_name: str) -> str:
    """
    既存ユーザーデータが存在するDBに対してマイグレーションを実行する前に、
    SQLite Online Backup API を用いて整合性の取れた事前バックアップを自動作成する。
    戻り値: 作成したバックアップファイルパス（空DB等でスキップした場合は空文字列）
    """
    try:
        cursor.execute("SELECT COUNT(*) as cnt FROM photos")
        photo_cnt = cursor.fetchone()["cnt"]
        cursor.execute("SELECT COUNT(*) as cnt FROM photo_tags")
        ptag_cnt = cursor.fetchone()["cnt"]
        cursor.execute("SELECT COUNT(*) as cnt FROM tag_definitions")
        tdef_cnt = cursor.fetchone()["cnt"]
        cursor.execute("SELECT COUNT(*) as cnt FROM filter_presets")
        preset_cnt = cursor.fetchone()["cnt"]
        if (photo_cnt + ptag_cnt + tdef_cnt + preset_cnt) == 0:
            return ""

        db_file = ""
        cursor.execute("PRAGMA database_list")
        for row in cursor.fetchall():
            if row["name"] == "main" and row["file"]:
                db_file = row["file"]
                break
        if not db_file:
            db_file = str(_conn_mod.DB_PATH)
        if not db_file or not os.path.isfile(db_file):
            return ""

        db_path_obj = Path(db_file)
        backup_dir = db_path_obj.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"library_pre_{migration_name}_{ts_str}.db"

        # 現在のトランザクションを確定してからWAL完全フラッシュ＋高速カーネルコピー（ビジー時はOnline Backup API）を実行
        conn.commit()
        copied_fast = False
        try:
            from .stats import _fast_copy_db_file
            chk_row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            busy = int(chk_row[0]) if chk_row else 1
            if busy == 0 and db_path_obj.exists():
                copied_fast = _fast_copy_db_file(db_path_obj, backup_path)
        except Exception as fast_err:
            logger.debug(f"[MIGRATE] {migration_name}: 高速コピーからOnline Backup APIへフォールバック: {fast_err}")
            copied_fast = False

        if not copied_fast:
            if backup_path.exists():
                try:
                    backup_path.unlink()
                except Exception:
                    pass
            bck_conn = sqlite3.connect(str(backup_path))
            try:
                bck_conn.execute("PRAGMA journal_mode = OFF")
                bck_conn.execute("PRAGMA synchronous = OFF")
                conn.backup(bck_conn)
            finally:
                bck_conn.close()

        # 同種バックアップが増えすぎないよう最新5世代を残して古いものを整理
        existing_backups = sorted(
            backup_dir.glob(f"library_pre_{migration_name}_*.db"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for old_bck in existing_backups[5:]:
            try:
                old_bck.unlink()
            except Exception as unlink_err:
                logger.debug(f"古いバックアップ削除スキップ ({old_bck}): {unlink_err}")

        print(f"[MIGRATE] {migration_name}: 事前安全バックアップを作成しました -> {backup_path}")
        return str(backup_path)
    except Exception as e:
        logger.warning(f"[MIGRATE] {migration_name}: 事前バックアップ作成中に警告が発生しました: {e}")
        return ""


def _migrate_tag_keys_v1(cursor, conn) -> None:
    """
    既存環境向けに以下のマイグレーションを安全かつ冪等に実行する:
    1. 既存データがある場合は SQLite Online Backup API で事前バックアップを自動生成
    2. photo_tags, tag_definitions, filter_presets に登場する全一般タグ（祖先パス含む）を
       tag_definitions に登録し、重複のない不変キー(tag_key: tk_<12hex>)を採番
    3. filter_presets の JSON 内に tagFilterKeys ({tag_key: mode}) をバックフィル保存
    4. マイグレーション後の整合性（NULL/空文字/重複キーゼロ）を検証
    """
    _create_pre_migration_backup(cursor, conn, "tag_keys_v1")
    _ensure_tag_definitions_table(cursor)

    # 1. 全テーブルから既存タグ名を収集（カラーラベルは除外、階層タグは全祖先ノードを展開）
    all_tags = set()

    cursor.execute("SELECT DISTINCT tag FROM photo_tags WHERE tag IS NOT NULL AND COALESCE(source, 'manual') != 'ai'")
    for r in cursor.fetchall():
        t = (r["tag"] or "").strip()
        if t and not is_color_tag(t):
            for anc in _expand_ancestor_tags(t):
                if not is_color_tag(anc):
                    all_tags.add(anc)

    cursor.execute("SELECT tag FROM tag_definitions WHERE tag IS NOT NULL")
    for r in cursor.fetchall():
        t = (r["tag"] or "").strip()
        if t and not is_color_tag(t):
            for anc in _expand_ancestor_tags(t):
                if not is_color_tag(anc):
                    all_tags.add(anc)

    cursor.execute("SELECT id, filters FROM filter_presets")
    preset_rows = cursor.fetchall()
    for pr in preset_rows:
        raw_filters = pr["filters"]
        if not raw_filters:
            continue
        try:
            f_obj = json.loads(raw_filters) if isinstance(raw_filters, str) else raw_filters
        except Exception as e:
            logger.warning(f"[MIGRATE] filter_presets(id={pr['id']}) JSON解析スキップ: {e}")
            continue
        if isinstance(f_obj, dict):
            tf = f_obj.get("tagFilters")
            if isinstance(tf, dict):
                for t_name in tf.keys():
                    t_clean = (t_name or "").strip()
                    if t_clean and not is_color_tag(t_clean):
                        for anc in _expand_ancestor_tags(t_clean):
                            if not is_color_tag(anc):
                                all_tags.add(anc)

    # 2. 全タグを tag_definitions に登録し、未付与のものに固有キー(tag_key)を発行
    if all_tags:
        _ensure_tag_keys_registered(cursor, sorted(all_tags))

    # 念のため tag_definitions 内で tag_key が NULL または空文字のレコードを全て解消
    cursor.execute("SELECT tag FROM tag_definitions WHERE tag_key IS NULL OR tag_key = ''")
    remaining = [r["tag"] for r in cursor.fetchall()]
    if remaining:
        _ensure_tag_keys_registered(cursor, remaining)

    # 万が一 tag_key の重複が存在した場合の自己修復
    cursor.execute(
        """
        SELECT tag_key FROM tag_definitions
        WHERE tag_key IS NOT NULL AND tag_key != ''
        GROUP BY tag_key HAVING COUNT(*) > 1
        """
    )
    dup_keys = [r["tag_key"] for r in cursor.fetchall()]
    for d_key in dup_keys:
        cursor.execute(
            "SELECT tag FROM tag_definitions WHERE tag_key = ? ORDER BY created_at ASC, tag ASC",
            (d_key,),
        )
        dup_tags = [r["tag"] for r in cursor.fetchall()]
        # 先頭1件以外の重複レコードに新しいユニークキーを再採番
        for dup_tag in dup_tags[1:]:
            new_key = _generate_unique_tag_key(cursor)
            cursor.execute(
                "UPDATE tag_definitions SET tag_key = ? WHERE tag = ?",
                (new_key, dup_tag),
            )

    # 3. filter_presets の JSON に tagFilterKeys をバックフィル
    cursor.execute("SELECT tag, tag_key FROM tag_definitions WHERE tag_key IS NOT NULL AND tag_key != ''")
    tag_to_key = {r["tag"]: r["tag_key"] for r in cursor.fetchall()}

    updated_presets = 0
    for pr in preset_rows:
        preset_id = pr["id"]
        raw_filters = pr["filters"]
        if not raw_filters:
            continue
        try:
            f_obj = json.loads(raw_filters) if isinstance(raw_filters, str) else dict(raw_filters)
        except Exception:
            continue
        if not isinstance(f_obj, dict):
            continue
        tf = f_obj.get("tagFilters")
        if not isinstance(tf, dict) or not tf:
            continue

        existing_tf_keys = f_obj.get("tagFilterKeys")
        new_tf_keys = dict(existing_tf_keys) if isinstance(existing_tf_keys, dict) else {}
        changed = False
        for t_name, mode in tf.items():
            if is_color_tag(t_name):
                continue
            t_key = tag_to_key.get(t_name)
            if t_key and new_tf_keys.get(t_key) != mode:
                new_tf_keys[t_key] = mode
                changed = True
        if changed:
            f_obj["tagFilterKeys"] = new_tf_keys
            cursor.execute(
                "UPDATE filter_presets SET filters = ? WHERE id = ?",
                (json.dumps(f_obj, ensure_ascii=False), preset_id),
            )
            updated_presets += 1

    cursor.execute("SELECT COUNT(*) as cnt FROM tag_definitions WHERE tag_key IS NOT NULL AND tag_key != ''")
    total_keyed = cursor.fetchone()["cnt"]
    print(
        f"[MIGRATE] tag_keys_v1: タグ定義 {total_keyed} 件に固有キー(tag_key)を付与・検証し、"
        f"プリセット {updated_presets} 件を更新しました"
    )


def _migrate_fix_mismatched_thumbnails(cursor) -> None:
    """
    photosテーブルに存在しない孤立サムネイル、および
    別の写真とID衝突している不整合サムネイルを一括検知・パージする。
    """
    # 1. 孤立サムネイルの削除
    cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
    orphan_count = cursor.rowcount

    # 2. 現在のphotosレコードとfile_hashが不一致のサムネイルを検出・削除
    cursor.execute("""
        SELECT t.photo_id, t.file_hash, p.file_path
        FROM thumbnails t
        INNER JOIN photos p ON t.photo_id = p.id
    """)
    rows = cursor.fetchall()
    mismatched_ids = []
    for r in rows:
        fh = r["file_hash"]
        fp = r["file_path"]
        if fh and fh != str(r["photo_id"]):
            expected = compute_thumbnail_hash(fp)
            if fh != expected:
                mismatched_ids.append(r["photo_id"])

    if mismatched_ids:
        for i in range(0, len(mismatched_ids), 500):
            chunk = mismatched_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)

    print(f"[MIGRATE] fix_mismatched_thumbnails: 孤立 {orphan_count} 件、不整合 {len(mismatched_ids)} 件のサムネイルを修復削除しました")


def _migrate_ancestor_tags(cursor) -> None:
    """既存の階層タグに対して、祖先パスのタグレコードを追加する（一回限りのマイグレーション）"""
    cursor.execute("SELECT DISTINCT photo_id, tag FROM photo_tags")
    rows = cursor.fetchall()

    inserts = []
    for row in rows:
        photo_id = row["photo_id"]
        tag = row["tag"]
        parts = tag.split("/")
        # 祖先パスのみ生成（フルパス自体は既にDBにある）
        for i in range(1, len(parts)):
            ancestor = "/".join(parts[:i])
            inserts.append((photo_id, ancestor))

    if inserts:
        cursor.executemany(
            "INSERT OR IGNORE INTO photo_tags (photo_id, tag) VALUES (?, ?)",
            inserts,
        )
    print(f"[MIGRATE] ancestor_tags: {len(inserts)} 件の祖先タグレコードを追加しました")


def _migrate_sanitize_camera_models(cursor) -> None:
    """既存のphotosテーブル内のcamera_modelから\\x00（NUL文字）を除去するマイグレーション"""
    cursor.execute("SELECT id, camera_model FROM photos WHERE camera_model IS NOT NULL")
    rows = cursor.fetchall()
    cleaned_count = 0
    for r in rows:
        raw_cam = r["camera_model"]
        if raw_cam and "\x00" in raw_cam:
            cleaned = raw_cam.replace("\x00", "").strip() or "不明"
            cursor.execute("UPDATE photos SET camera_model = ? WHERE id = ?", (cleaned, r["id"]))
            cleaned_count += 1
    if cleaned_count > 0:
        print(f"[MIGRATE] sanitize_camera_models: {cleaned_count} 件のカメラ機種名からNUL文字を除去しました")


def _migrate_rating_to_4tier(cursor) -> None:
    """
    5段階星評価（0～5）を4段階評価（棄/可/良/優）に変換するマイグレーション。
    マッピング:
      旧 0     → 新 0（可: 未評価/普通）
      旧 1～2  → 新 0（可: 低評価は普通扱い）
      旧 3     → 新 1（良）
      旧 4～5  → 新 2（優）
    ※ rating=-1（棄）は新設のため、既存データにはない
    """
    # 旧 4,5 → 新 2（優）
    cursor.execute("UPDATE photos SET rating = 2 WHERE rating >= 4")
    excellent_count = cursor.rowcount

    # 旧 3 → 新 1（良）
    cursor.execute("UPDATE photos SET rating = 1 WHERE rating = 3")
    good_count = cursor.rowcount

    # 旧 1,2 → 新 0（可）
    cursor.execute("UPDATE photos SET rating = 0 WHERE rating IN (1, 2)")
    normal_count = cursor.rowcount

    print(f"[MIGRATE] rating_to_4tier: 優={excellent_count}, 良={good_count}, 可(1,2→0)={normal_count} 件を変換しました")
