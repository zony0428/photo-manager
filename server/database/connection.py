"""
データベース接続管理モジュール
SQLiteの接続プール（スレッドローカル再利用）とパフォーマンスPRAGMA設定を提供する。
"""

import logging
import math
import re
import shutil
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_LEGACY_CACHE_DIR = _PROJECT_ROOT / ".cache"
# DBファイルパス（Androidのファイル選択画面で隠しフォルダにならないようドット無しの cache/ に保存）
CACHE_DIR = _PROJECT_ROOT / "cache"

# 各月1日時点の年間通日オフセット（平年・閏年）
_DAYS_BEFORE_MONTH_COMMON = (0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
_DAYS_BEFORE_MONTH_LEAP = (0, 0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335)


def calc_solar_altitude(
    date_taken: Optional[str],
    lat: Optional[float] = None,
    lon: Optional[float] = None,
) -> Optional[float]:
    """
    撮影日時と緯度・経度から太陽高度角（度: -90.0〜+90.0）を算出する。
    GPS未設定（NULL）または (0, 0) の場合は日本標準座標（東京: 北緯35.68度, 東経139.76度）をフォールバック使用する。
    天文学の三角関数式（通日 N、太陽赤緯 δ、均時差、地方真太陽時 t、時角 h）に基づく高速計算。
    """
    if not date_taken:
        return None
    s = str(date_taken).strip()
    if len(s) < 16:
        return None

    try:
        # 高速スライスパース ("YYYY-MM-DD HH:MM:SS" または "YYYY:MM:DD HH:MM:SS")
        year = int(s[0:4])
        month = int(s[5:7])
        day = int(s[8:10])
        hour = int(s[11:13])
        minute = int(s[14:16])
        second = int(s[17:19]) if len(s) >= 19 and s[17:19].isdigit() else 0
    except Exception:
        try:
            dt = datetime.strptime(s[:19].replace(":", "-", 2), "%Y-%m-%d %H:%M:%S")
            year, month, day, hour, minute, second = (
                dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second
            )
        except Exception:
            return None

    if not (1 <= month <= 12 and 1 <= day <= 31 and 0 <= hour <= 23 and 0 <= minute <= 59):
        return None

    # 緯度・経度の決定（NULLまたは(0,0)付近の場合は日本標準座標へフォールバック）
    lat_val = 35.68
    lon_val = 139.76
    if lat is not None and lon is not None:
        try:
            f_lat = float(lat)
            f_lon = float(lon)
            if abs(f_lat) >= 0.0001 or abs(f_lon) >= 0.0001:
                if -90.0 <= f_lat <= 90.0 and -180.0 <= f_lon <= 180.0:
                    lat_val = f_lat
                    lon_val = f_lon
        except (ValueError, TypeError) as e:
            logger.debug(f"太陽高度角: 緯度経度変換スキップ (lat={lat}, lon={lon}): {e}")

    # 標準時子午線の推定（日本周辺は東経135度、その他は経度から15度単位で算出）
    if 20.0 <= lat_val <= 46.0 and 122.0 <= lon_val <= 154.0:
        std_lon = 135.0
    else:
        std_lon = round(lon_val / 15.0) * 15.0

    # 年間通日 N (1月1日 = 1)
    is_leap = (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)
    days_table = _DAYS_BEFORE_MONTH_LEAP if is_leap else _DAYS_BEFORE_MONTH_COMMON
    day_of_year = days_table[month] + day
    days_in_year = 366.0 if is_leap else 365.0

    # 太陽年角 γ (ラジアン)
    local_hours = hour + (minute / 60.0) + (second / 3600.0)
    gamma = (2.0 * math.pi / days_in_year) * (day_of_year - 1 + (local_hours - 12.0) / 24.0)

    # 均時差 (分) - Spencerの近似式
    eq_time = 229.18 * (
        0.000075
        + 0.001868 * math.cos(gamma)
        - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2.0 * gamma)
        - 0.040849 * math.sin(2.0 * gamma)
    )

    # 太陽赤緯 δ (ラジアン) - Spencerの近似式
    decl = (
        0.006918
        - 0.399912 * math.cos(gamma)
        + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2.0 * gamma)
        + 0.000907 * math.sin(2.0 * gamma)
        - 0.002697 * math.cos(3.0 * gamma)
        + 0.001480 * math.sin(3.0 * gamma)
    )

    # 地方真太陽時 t (時) と 時角 h (ラジアン)
    time_offset_min = eq_time + 4.0 * (lon_val - std_lon)
    true_solar_hours = local_hours + (time_offset_min / 60.0)
    hour_angle_deg = (true_solar_hours - 12.0) * 15.0
    hour_angle_rad = math.radians(hour_angle_deg)

    # 太陽高度角 α の算出: sin(α) = sin(φ)sin(δ) + cos(φ)cos(δ)cos(h)
    lat_rad = math.radians(lat_val)
    sin_alt = (
        math.sin(lat_rad) * math.sin(decl)
        + math.cos(lat_rad) * math.cos(decl) * math.cos(hour_angle_rad)
    )
    sin_alt = max(-1.0, min(1.0, sin_alt))
    altitude_deg = math.degrees(math.asin(sin_alt))
    return round(altitude_deg, 2)


def _migrate_legacy_dot_cache_dir() -> None:
    """旧 .cache フォルダが存在する場合、自動的にドット無しの cache フォルダへ安全に移行する"""
    if not _LEGACY_CACHE_DIR.exists() or not _LEGACY_CACHE_DIR.is_dir():
        return
    try:
        if not CACHE_DIR.exists():
            _LEGACY_CACHE_DIR.rename(CACHE_DIR)
            print("[MIGRATE] 旧 .cache フォルダを cache フォルダへ自動移行しました")
            return

        # 既に cache/ フォルダが存在する場合は中身をマージ移動
        for item in _LEGACY_CACHE_DIR.iterdir():
            dest = CACHE_DIR / item.name
            if not dest.exists():
                shutil.move(str(item), str(dest))
        # 空になっていれば旧 .cache を削除
        if not any(_LEGACY_CACHE_DIR.iterdir()):
            _LEGACY_CACHE_DIR.rmdir()
            print("[MIGRATE] 旧 .cache フォルダ内のデータを cache フォルダへ統合しました")
    except Exception as e:
        print(f"[WARN] 旧 .cache から cache への自動移行中に警告が発生しました: {e}")


_migrate_legacy_dot_cache_dir()
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = CACHE_DIR / "library.db"

# スレッドローカルストレージ（スレッドごとのSQLite接続キャッシュ）
_local_db = threading.local()
_all_connections_lock = threading.Lock()
_all_connections: list[sqlite3.Connection] = []
_DB_COMMIT_SEQ: int = 0
_PHOTOS_SEQ: int = 0
_TAGS_SEQ: int = 0
_LINKS_SEQ: int = 0
_THUMBNAILS_SEQ: int = 0

_ALL_SEQ_DOMAINS = ("db", "photos", "tags", "links", "thumbnails")
_DML_TABLE_RE = re.compile(
    r"^\s*(?:WITH\b[\s\S]*?\b)?(INSERT|REPLACE|UPDATE|DELETE)\b"
    r"(?:\s+OR\s+\w+)?(?:\s+INTO|\s+FROM)?\s+[`\"'\[]?(?:\w+\.)?(\w+)",
    re.IGNORECASE,
)
_PHOTOS_LINK_COLS_RE = re.compile(
    r"\b(is_unlinked|volume_serial|directory_path|file_path|link_count|paired_raw_path|is_raw)\s*=",
    re.IGNORECASE,
)


def _classify_write_sql(sql: str):
    """実行SQLが変更するキャッシュドメイン群を判定する（読み取りクエリはNoneを返す）"""
    if not sql:
        return None
    s = sql.lstrip()
    if not s:
        return None
    head = s[:10].upper()
    if head.startswith(("SELECT", "PRAGMA", "EXPLAIN", "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE")):
        return None
    if head.startswith("CREATE") and "IF NOT EXISTS" in s[:80].upper():
        return None
    if head.startswith("WITH"):
        s_upper = s.upper()
        if not any(k in s_upper for k in ("INSERT ", "UPDATE ", "DELETE ", "REPLACE ")):
            return None

    m = _DML_TABLE_RE.match(s)
    if not m:
        return _ALL_SEQ_DOMAINS

    verb = m.group(1).upper()
    table = m.group(2).lower()

    if table == "thumbnails":
        return ("thumbnails",)
    if table in ("photo_tags", "tag_definitions"):
        return ("db", "tags")
    if table in ("photo_links", "volumes", "scan_roots", "ignored_folders"):
        return ("db", "photos", "links")
    if table == "photos":
        if verb in ("INSERT", "DELETE", "REPLACE"):
            return _ALL_SEQ_DOMAINS
        where_idx = s.upper().find(" WHERE ")
        set_part = s[:where_idx] if where_idx != -1 else s
        if _PHOTOS_LINK_COLS_RE.search(set_part):
            return ("db", "photos", "links")
        return ("db", "photos")
    if table in ("filter_presets", "field_logs", "field_log_points", "migrations", "app_meta", "security_meta"):
        return ("db",)
    return _ALL_SEQ_DOMAINS


def _apply_domain_bumps(domains) -> None:
    """指定されたキャッシュドメイン群の世代番号をインクリメントする"""
    global _DB_COMMIT_SEQ, _PHOTOS_SEQ, _TAGS_SEQ, _LINKS_SEQ, _THUMBNAILS_SEQ
    if "db" in domains:
        _DB_COMMIT_SEQ += 1
    if "photos" in domains:
        _PHOTOS_SEQ += 1
    if "tags" in domains:
        _TAGS_SEQ += 1
    if "links" in domains:
        _LINKS_SEQ += 1
    if "thumbnails" in domains:
        _THUMBNAILS_SEQ += 1


class _TrackedCursor(sqlite3.Cursor):
    """書き込み対象テーブルを記録するSQLiteカーソル"""

    def execute(self, sql: str, parameters=(), /):
        domains = _classify_write_sql(sql)
        if domains is not None:
            self.connection._record_tx_domains(domains)
        return super().execute(sql, parameters)

    def executemany(self, sql: str, seq_of_parameters, /):
        domains = _classify_write_sql(sql)
        if domains is not None:
            self.connection._record_tx_domains(domains)
        return super().executemany(sql, seq_of_parameters)

    def executescript(self, sql_script: str, /):
        self.connection._record_tx_domains(_ALL_SEQ_DOMAINS)
        return super().executescript(sql_script)


class _TrackedConnection(sqlite3.Connection):
    """トランザクションコミット時に変更ドメイン別の世代番号を自動インクリメントするSQLite接続"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._tx_domains: set[str] = set()

    def _record_tx_domains(self, domains) -> None:
        self._tx_domains.update(domains)

    def cursor(self, factory=None):
        if factory is None:
            factory = _TrackedCursor
        return super().cursor(factory)

    def execute(self, sql: str, parameters=(), /):
        domains = _classify_write_sql(sql)
        if domains is not None:
            self._tx_domains.update(domains)
        return super().execute(sql, parameters)

    def executemany(self, sql: str, seq_of_parameters, /):
        domains = _classify_write_sql(sql)
        if domains is not None:
            self._tx_domains.update(domains)
        return super().executemany(sql, seq_of_parameters)

    def executescript(self, sql_script: str, /):
        self._tx_domains.update(_ALL_SEQ_DOMAINS)
        return super().executescript(sql_script)

    def commit(self) -> None:
        was_in_tx = self.in_transaction
        domains = tuple(self._tx_domains) if self._tx_domains else _ALL_SEQ_DOMAINS
        super().commit()
        self._tx_domains.clear()
        if was_in_tx:
            _apply_domain_bumps(domains)

    def rollback(self) -> None:
        super().rollback()
        self._tx_domains.clear()

    def __exit__(self, exc_type, exc_val, exc_tb):
        was_in_tx = self.in_transaction
        domains = tuple(self._tx_domains) if self._tx_domains else _ALL_SEQ_DOMAINS
        res = super().__exit__(exc_type, exc_val, exc_tb)
        self._tx_domains.clear()
        if exc_type is None and was_in_tx:
            _apply_domain_bumps(domains)
        return res


def get_db_commit_seq() -> int:
    """データベースの書き込みコミット世代番号（サムネイル単体更新を除く）を返す"""
    return _DB_COMMIT_SEQ


def get_photos_seq() -> int:
    """写真メタデータ・リンク変更の世代番号を返す"""
    return _PHOTOS_SEQ


def get_tags_seq() -> int:
    """タグ・タグ定義変更の世代番号を返す"""
    return _TAGS_SEQ


def get_links_seq() -> int:
    """写真増減・リンク所在・フォルダ構成変更の世代番号を返す"""
    return _LINKS_SEQ


def get_thumbnails_seq() -> int:
    """サムネイルBLOB変更の世代番号を返す"""
    return _THUMBNAILS_SEQ


def bump_photos_seq() -> None:
    """写真一覧キャッシュ世代を明示インクリメントする"""
    _apply_domain_bumps(("photos",))


def bump_tags_seq() -> None:
    """タグキャッシュ世代を明示インクリメントする"""
    _apply_domain_bumps(("tags",))


def bump_links_seq() -> None:
    """リンク・フォルダ接続死活キャッシュ世代を明示インクリメントする"""
    _apply_domain_bumps(("links",))


def bump_thumbnails_seq() -> None:
    """サムネイルキャッシュ世代を明示インクリメントする"""
    _apply_domain_bumps(("thumbnails",))


def bump_db_commit_seq(domains=None) -> None:
    """キャッシュ無効化時に世代番号を明示インクリメントする"""
    if domains is None:
        _apply_domain_bumps(_ALL_SEQ_DOMAINS)
    elif isinstance(domains, str):
        _apply_domain_bumps(("db", domains))
    else:
        _apply_domain_bumps(("db", *domains))


def get_connection() -> sqlite3.Connection:
    """SQLite接続を取得し、行を辞書形式で扱えるように設定する（スレッドローカル再利用＋RAM常駐キャッシュチューニング済み）"""
    conn = getattr(_local_db, "connection", None)
    conn_path = getattr(_local_db, "db_path", None)
    if conn is not None and conn_path != DB_PATH:
        close_thread_connection()
        conn = None
    if conn is not None:
        try:
            conn.execute("SELECT 1")
        except sqlite3.ProgrammingError:
            conn = None
            _local_db.connection = None
    if conn is None:
        conn = sqlite3.connect(str(DB_PATH), timeout=20, check_same_thread=False, factory=_TrackedConnection)
        conn.row_factory = sqlite3.Row
        # 外部キー制約を必ず有効化（ON DELETE CASCADE によるサムネイル・タグの連動削除を保証）
        conn.execute("PRAGMA foreign_keys = ON")
        # パフォーマンス最適化PRAGMA
        # cache_size=-16000: 16MBキャッシュ（スレッドローカル接続 × スレッドプール最大40本分でのメモリ肥大化を防止）
        conn.execute("PRAGMA cache_size = -16000")
        # mmap_size: 256MB メモリマップドI/O。OSページキャッシュを活用して超高速読み出し
        conn.execute("PRAGMA mmap_size = 268435456")
        # synchronous=NORMAL: WALモードでの耐障害性を維持しつつディスク同期オーバーヘッドを最小化
        conn.execute("PRAGMA synchronous = NORMAL")
        # temp_store=MEMORY: ソートや一時テーブルをRAM上で処理
        conn.execute("PRAGMA temp_store = MEMORY")
        # 太陽高度角計算カスタムスカラ関数の登録（マジックアワー・ブルーアワー抽出用）
        conn.create_function("solar_altitude", 3, calc_solar_altitude)
        # v1.7.0 セキュリティ＆ダウングレード防止ガード関数（v1.6.1以前へのDB放り込みによるエシカル保護回避を遮断）
        conn.create_function("tetheract_v170_guard", 0, lambda: 1, deterministic=True)
        _local_db.connection = conn
        _local_db.db_path = DB_PATH
        with _all_connections_lock:
            _all_connections.append(conn)
    return conn


def close_thread_connection() -> None:
    """現在のスレッドが保持しているSQLite接続を安全に閉じてキャッシュをクリアする"""
    conn = getattr(_local_db, "connection", None)
    if conn is not None:
        try:
            conn.close()
        except Exception as e:
            print(f"[WARN] SQLite接続クローズ時の警告: {e}")
        finally:
            _local_db.connection = None
            _local_db.db_path = None
            with _all_connections_lock:
                if conn in _all_connections:
                    _all_connections.remove(conn)


def close_all_connections() -> None:
    """全スレッドが開いているSQLite接続をすべて安全に閉じる（VACUUMやDB切り替え時用）"""
    close_thread_connection()
    with _all_connections_lock:
        conns = list(_all_connections)
        _all_connections.clear()
    for c in conns:
        try:
            c.close()
        except Exception:
            pass


def get_or_create_library_id() -> str:
    """library.db 固有の不変識別子 (library_id) を app_meta から取得する（未設定時は生成して永続化）"""
    import uuid

    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cur.execute("SELECT value FROM app_meta WHERE key = 'library_id'")
    row = cur.fetchone()
    if row and row["value"] and str(row["value"]).strip():
        return str(row["value"]).strip()
    new_id = f"lib_{uuid.uuid4().hex}"
    cur.execute(
        "INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('library_id', ?, CURRENT_TIMESTAMP)",
        (new_id,),
    )
    conn.commit()
    return new_id


def switch_database_path(new_path: Path) -> Path:
    """
    テスト・ベンチマーク用: 全スレッドの接続を確実に閉じてから DB_PATH を切り替える。
    戻り値として切り替え前の旧 DB_PATH を返す。
    """
    global DB_PATH
    old_path = DB_PATH
    close_all_connections()
    DB_PATH = Path(new_path)
    bump_db_commit_seq()
    return old_path
