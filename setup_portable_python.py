"""
Photo Manager - ポータブルPython自動構築スクリプト
USBメモリ等でPython未インストールのPCでも自走できるように、
公式の Embeddable Python をダウンロードしてFastAPI環境を整備する。
"""

import os
import sys
import shutil
import zipfile
import subprocess
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
TARGET_DIR = BASE_DIR / "python"
PYTHON_VERSION = "3.11.9"
EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"


def main():
    print("=" * 60)
    print("  Photo Manager: USB用ポータブルPython 自動構築ツール")
    print("=" * 60)
    print(f"ターゲットディレクトリ: {TARGET_DIR}")

    portable_py = TARGET_DIR / "python.exe"
    if portable_py.exists():
        print(f"\n[INFO] 既にポータブルPythonが存在します: {portable_py}")
        print("再構築したい場合は 'python' フォルダを削除してから再実行してください。")
        return

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    temp_zip = BASE_DIR / "python_embed.zip"
    get_pip_script = TARGET_DIR / "get-pip.py"

    try:
        # 1. Embeddable Python ダウンロード
        print(f"\n[1/4] 公式 Python {PYTHON_VERSION} (Embeddable) をダウンロード中...")
        print(f"URL: {EMBED_URL}")
        urllib.request.urlretrieve(EMBED_URL, temp_zip)
        print(" -> ダウンロード完了")

        # 2. 解凍
        print("\n[2/4] パッケージを展開中...")
        with zipfile.ZipFile(temp_zip, "r") as zip_ref:
            zip_ref.extractall(TARGET_DIR)
        print(" -> 展開完了")

        # 3. python311._pth の修正 (import site の有効化)
        print("\n[3/4] パッケージ環境 (pip) を初期化中...")
        pth_file = TARGET_DIR / "python311._pth"
        pth_content = ".\npython311.zip\n.\nLib\\site-packages\nimport site\n"
        with open(pth_file, "w", encoding="utf-8") as f:
            f.write(pth_content)

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
        else:
            print(" -> pip インストール完了")

        # 4. 依存ライブラリのインストール
        print("\n[4/4] 必須ライブラリ (fastapi, uvicorn, pillow, rawpy, pystray, six, numpy, onnxruntime) をインストール中...")
        packages = ["fastapi", "uvicorn", "pillow", "rawpy", "pystray", "six", "numpy", "onnxruntime"]
        cmd = [str(portable_py), "-m", "pip", "install", *packages, "--no-warn-script-location"]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"[ERROR] パッケージインストールエラー: {proc.stderr}")
            raise RuntimeError("ライブラリのインストールに失敗しました")

        print(" -> ライブラリインストール完了")

        print("\n" + "=" * 60)
        print("  【大成功】USB用ポータブルPythonの構築が完了しました！")
        print(f"  配置先: {TARGET_DIR}")
        print("  これで、Python未インストールのPCでも start.bat で起動できます。")
        print("=" * 60)

    except Exception as e:
        print(f"\n[ERROR] セットアップに失敗しました: {e}")
        # 失敗時は不完全なフォルダを削除
        if TARGET_DIR.exists():
            shutil.rmtree(TARGET_DIR, ignore_errors=True)
        raise
    finally:
        # 一時ファイル削除
        if temp_zip.exists():
            temp_zip.unlink(missing_ok=True)
        if get_pip_script.exists():
            get_pip_script.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
