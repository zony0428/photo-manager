"""
データベーススキーマ定義・マイグレーションモジュール
テーブル作成、インデックス構築、カラム追加、データ移行を管理する。
"""

import os
from .connection import get_connection
from .thumbnails import compute_thumbnail_hash
from .fingerprint import extract_folder_fingerprint
def initialize_database() -> None:
    """データベースの初期テーブル構造を作成する"""
    with get_connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
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
        ]
        for col_name, col_type in new_cols:
            if col_name not in existing_cols:
                cursor.execute(f"ALTER TABLE photos ADD COLUMN {col_name} {col_type}")

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

        # タグ・アルバム管理テーブル
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS photo_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                source TEXT DEFAULT 'manual',
                confidence REAL DEFAULT 1.0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(photo_id, tag),
                FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
            )
            """
        )
        # photo_tags マイグレーション（source, confidence）
        cursor.execute("PRAGMA table_info(photo_tags)")
        existing_tag_cols = {row["name"] for row in cursor.fetchall()}
        if "source" not in existing_tag_cols:
            cursor.execute("ALTER TABLE photo_tags ADD COLUMN source TEXT DEFAULT 'manual'")
        if "confidence" not in existing_tag_cols:
            cursor.execute("ALTER TABLE photo_tags ADD COLUMN confidence REAL DEFAULT 1.0")

        # 検索・ソート・重複集計用インデックス（date_taken 単一インデックスを包含し、重複集計を Covering Index 化する複合インデックスに統合）
        cursor.execute("DROP INDEX IF EXISTS idx_photos_date_taken")
        cursor.execute("DROP INDEX IF EXISTS idx_photos_date_taken_size")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_date_size_unlinked ON photos(date_taken, file_size, is_unlinked)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_year_month ON photos(year_month)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_directory ON photos(directory_path)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_directory_nocase ON photos(directory_path COLLATE NOCASE)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_camera_model ON photos(camera_model)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_stack_id ON photos(stack_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_name_size ON photos(file_name, file_size)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_gps_date ON photos(date_taken) WHERE latitude IS NOT NULL")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_location ON photos(country, state, city)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_is_unlinked ON photos(is_unlinked)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_tags_tag_photo ON photo_tags(tag, photo_id)")
        cursor.execute("DROP INDEX IF EXISTS idx_photo_tags_tag")
        cursor.execute("DROP INDEX IF EXISTS idx_photo_tags_photo")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photo_tags_source ON photo_tags(source)")

        # ボリューム情報管理テーブル（VSNをキーにラベルをスキャン時に自動更新）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS volumes (
                volume_serial TEXT PRIMARY KEY,
                volume_label  TEXT NOT NULL DEFAULT '',
                drive_letter  TEXT,
                last_seen_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_photos_volume_serial ON photos(volume_serial)")

        # サムネイル BLOB 格納テーブル（個別WebPファイル方式からの移行先）
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS thumbnails (
                file_hash TEXT PRIMARY KEY,
                photo_id INTEGER NOT NULL,
                data BLOB NOT NULL,
                width INTEGER,
                height INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
            )
            """
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_thumbnails_photo_id ON thumbnails(photo_id)")

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

        # 起動時の常時安全パージ: photosテーブルに存在しない孤立サムネイルを確実に削除
        cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
        conn.commit()

        # ドライブ直下などの無効なスキャンルートを安全に削除
        cursor.execute("DELETE FROM scan_roots WHERE length(rtrim(replace(folder_path, '/', '\\'), '\\')) <= 2 OR folder_path LIKE '%:'")
        conn.commit()

        # 指紋未設定の既存スキャンルートについて、フォルダが存在すれば初期指紋を自動付与
        cursor.execute("SELECT folder_path FROM scan_roots WHERE fingerprint IS NULL")
        unfingerprinted = [r["folder_path"] for r in cursor.fetchall()]
        for f_path in unfingerprinted:
            norm = os.path.normpath(f_path).rstrip("\\/")
            if len(norm) <= 2 or norm.endswith(":"):
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
                except Exception:
                    pass

        # クエリオプティマイザのインデックス統計を最新化
        cursor.execute("PRAGMA optimize")
        conn.commit()


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
        if fh != str(r["photo_id"]):
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

