"""
リリース配布用ZIPアーカイブ自動生成スクリプト
build_dist.bat から呼び出され、VERSION ファイルのバージョン番号に基づいて
以下の2つのZIPパッケージをルートディレクトリに生成する：
  1. Tetheract_v<VERSION>diff.zip (dist_update/ から生成する軽量差分アップデート版)
  2. Tetheract_v<VERSION>.zip     (dist/ から生成するフルパッケージ版)
"""

from pathlib import Path
import sys
import zipfile

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from server.version import get_version

# 配布ZIPに含めてはならない個人データ・実行時生成物（dist/ でアプリを試用した場合の誤混入防止）
EXCLUDED_TOP_DIRS = {"cache", ".cache", "storage", "carry", "take_out"}
EXCLUDED_DIR_NAMES = {"__pycache__", ".git"}
EXCLUDED_FILE_PATTERNS = ("*.log", "mobile_sync*.json", "*.orig_backup", "autorun.inf")


def _is_excluded(rel_path: Path) -> bool:
    """配布物から除外すべきパスか判定する"""
    parts = rel_path.parts
    if parts and parts[0].lower() in EXCLUDED_TOP_DIRS:
        return True
    if any(p in EXCLUDED_DIR_NAMES for p in parts):
        return True
    return any(rel_path.match(pattern) for pattern in EXCLUDED_FILE_PATTERNS)


def _read_version() -> str:
    """VERSIONファイルからバージョン番号文字列を取得する"""
    return get_version()


def _create_zip_from_dir(src_dir: Path, zip_path: Path) -> float:
    """指定ディレクトリの中身をZIP圧縮し、生成サイズ(MB)を返す"""
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for file_path in src_dir.rglob("*"):
            if file_path.is_file():
                arcname = file_path.relative_to(src_dir)
                if _is_excluded(arcname):
                    print(f"       [SKIP] {arcname}")
                    continue
                zf.write(file_path, arcname)
    return zip_path.stat().st_size / (1024 * 1024)


def main() -> None:
    """軽量差分ZIPとフルパッケージZIPを順番に生成する"""
    ver = _read_version()

    dist_update_dir = ROOT_DIR / "dist_update"
    if dist_update_dir.exists():
        diff_zip = ROOT_DIR / f"Tetheract_v{ver}diff.zip"
        size_mb = _create_zip_from_dir(dist_update_dir, diff_zip)
        print(f"       [OK] {diff_zip.name} ({size_mb:.2f} MB)")

    dist_full_dir = ROOT_DIR / "dist"
    if dist_full_dir.exists():
        full_zip = ROOT_DIR / f"Tetheract_v{ver}.zip"
        print(f"       Creating {full_zip.name} (compressing python/ & models/, please wait)...")
        size_mb = _create_zip_from_dir(dist_full_dir, full_zip)
        print(f"       [OK] {full_zip.name} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
