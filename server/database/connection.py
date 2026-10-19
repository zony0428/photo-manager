"""
データベース接続管理モジュール
SQLiteの接続プール（スレッドローカル再利用）とパフォーマンスPRAGMA設定を提供する。
"""

import shutil
import sqlite3
import threading
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_LEGACY_CACHE_DIR = _PROJECT_ROOT / ".cache"
# DBファイルパス（Androidのファイル選択画面で隠しフォルダにならないようドット無しの cache/ に保存）
CACHE_DIR = _PROJECT_ROOT / "cache"


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


def get_connection() -> sqlite3.Connection:
    """SQLite接続を取得し、行を辞書形式で扱えるように設定する（スレッドローカル再利用＋RAM常駐キャッシュチューニング済み）"""
    conn = getattr(_local_db, "connection", None)
    if conn is None:
        conn = sqlite3.connect(str(DB_PATH), timeout=20, check_same_thread=False)
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
        _local_db.connection = conn
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


def switch_database_path(new_path: Path) -> Path:
    """
    テスト・ベンチマーク用: スレッドローカル接続を確実に閉じてから DB_PATH を切り替える。
    戻り値として切り替え前の旧 DB_PATH を返す。
    """
    global DB_PATH
    old_path = DB_PATH
    close_thread_connection()
    DB_PATH = Path(new_path)
    return old_path
