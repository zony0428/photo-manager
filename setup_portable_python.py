"""
Photo Manager - ポータブルPython自動構築スクリプト
USBメモリ等でPython未インストールのPCでも自走できるように、
公式の Embeddable Python をダウンロードしてFastAPI環境を整備する。
"""

import subprocess
import urllib.request
import zipfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
TARGET_DIR = BASE_DIR / "python"
PYTHON_VERSION = "3.11.9"
EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
REQUIRED_PACKAGES = [
    "fastapi",
    "uvicorn",
    "pillow",
    "rawpy",
    "pystray",
    "six",
    "numpy",
    "onnxruntime",
]


def _is_env_complete(portable_py: Path, site_packages: Path) -> bool:
    """python.exe と必須パッケージ一式がすでに揃っているか判定する"""
    if not portable_py.exists() or not site_packages.exists():
        return False
    check_code = "import fastapi, uvicorn, PIL, rawpy, pystray, numpy, onnxruntime"
    try:
        res = subprocess.run(
            [str(portable_py), "-c", check_code],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return res.returncode == 0
    except Exception as e:
        print(f"[INFO] 既存環境チェック: {e}")
        return False


def main():
    print("=" * 60)
    print("  Photo Manager: USB用ポータブルPython 自動構築ツール")
    print("=" * 60)
    print(f"ターゲットディレクトリ: {TARGET_DIR}")

    portable_py = TARGET_DIR / "python.exe"
    site_packages = TARGET_DIR / "Lib" / "site-packages"

    # すでに python.exe も必須ライブラリもすべて揃っている場合のみスキップ
    if _is_env_complete(portable_py, site_packages):
        print(f"\n[OK] 既にポータブルPython環境（必須ライブラリ含む）が構築済みです: {portable_py}")
        print("再構築したい場合は 'python' フォルダを削除してから再実行してください。")
        return

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    temp_zip = BASE_DIR / "python_embed.zip"
    get_pip_script = TARGET_DIR / "get-pip.py"

    try:
        # 1 & 2. python.exe がまだ存在しない場合のみ Embeddable Python をダウンロード＆展開
        # （setup_portable_python.bat 経由で既に展開済みの場合はスキップして Step 3 へ進む）
        if not portable_py.exists():
            print(f"\n[1/4] 公式 Python {PYTHON_VERSION} (Embeddable) をダウンロード中...")
            print(f"URL: {EMBED_URL}")
            urllib.request.urlretrieve(EMBED_URL, temp_zip)
            print(" -> ダウンロード完了")

            print("\n[2/4] パッケージを展開中...")
            with zipfile.ZipFile(temp_zip, "r") as zip_ref:
                zip_ref.extractall(TARGET_DIR)
            print(" -> 展開完了")
        else:
            print(f"\n[1-2/4] 本体展開済みを確認 ({portable_py})。パッケージ環境の構築へ進みます...")

        # 3. python311._pth の修正 (import site の有効化)
        print("\n[3/4] パッケージ環境 (pip) を初期化中...")
        pth_file = TARGET_DIR / "python311._pth"
        pth_content = ".\npython311.zip\n.\nLib\\site-packages\nimport site\n"
        with open(pth_file, "w", encoding="utf-8") as f:
            f.write(pth_content)

        site_packages.mkdir(parents=True, exist_ok=True)

        # pip が未導入なら get-pip.py で導入
        pip_check = subprocess.run(
            [str(portable_py), "-m", "pip", "--version"],
            capture_output=True,
            text=True,
        )
        if pip_check.returncode != 0:
            print("get-pip.py をダウンロード中...")
            urllib.request.urlretrieve(GET_PIP_URL, get_pip_script)

            print("pip をインストール中...")
            res = subprocess.run(
                [str(portable_py), str(get_pip_script), "--no-warn-script-location"],
                capture_output=True,
                text=True,
            )
            if res.returncode != 0:
                print(f"[WARN] pip インストール出力: {res.stderr}")
                raise RuntimeError("pip の初期化に失敗しました")
            print(" -> pip インストール完了")
        else:
            print(" -> pip は既に利用可能です")

        # 4. 依存ライブラリのインストール（進捗がユーザーに見えるよう標準出力へ直接表示）
        print(
            f"\n[4/4] 必須ライブラリ ({', '.join(REQUIRED_PACKAGES)}) をインストール中...\n"
            "      ※初回は通信環境により1〜3分ほどかかります。そのままお待ちください。\n"
        )
        cmd = [
            str(portable_py),
            "-m",
            "pip",
            "install",
            "--upgrade",
            *REQUIRED_PACKAGES,
            "--no-warn-script-location",
        ]
        proc = subprocess.run(cmd)
        if proc.returncode != 0:
            raise RuntimeError("ライブラリのインストールに失敗しました")

        print("\n -> ライブラリインストール完了")

        print("\n" + "=" * 60)
        print("  【大成功】USB用ポータブルPythonの構築が完了しました！")
        print(f"  配置先: {TARGET_DIR}")
        print("  続いて Build.bat（または PhotoManager.exe）から起動できます。")
        print("=" * 60)

    except Exception as e:
        print(f"\n[ERROR] セットアップに失敗しました: {e}")
        raise
    finally:
        # 一時ファイル削除
        if temp_zip.exists():
            temp_zip.unlink(missing_ok=True)
        if get_pip_script.exists():
            get_pip_script.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
