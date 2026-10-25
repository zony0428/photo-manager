"""
Photo Manager 起動スクリプト
FastAPIサーバーを起動し、タスクトレイに常駐してアプリ画面の呼び出しおよび安全なシャットダウンを提供します。
EdgeやChromeの「アプリモード」を利用して、タブやURLバーのない単体ネイティブアプリ風ウィンドウで起動します。
"""

import os
import sys
import time
import threading
import subprocess
import webbrowser
from pathlib import Path

# ポータブルPython (embeddable版) では sys.path にプロジェクトルートが
# 含まれないため、server パッケージを発見できるよう明示的に追加する
_this_file = Path(__file__).resolve()
if _this_file.parent.name.lower() == "server":
    _PROJECT_ROOT = str(_this_file.parent.parent)
else:
    _PROJECT_ROOT = str(_this_file.parent)

if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# pythonw.exe 等で stdout / stderr が利用できない場合のログファイル出力
_is_windowless = False
try:
    if sys.stdout is None or sys.stderr is None:
        _is_windowless = True
    else:
        sys.stdout.fileno()
except Exception:
    _is_windowless = True

if _is_windowless:
    try:
        _log_path = Path(_PROJECT_ROOT) / "server.log"
        _log_f = open(_log_path, "a", encoding="utf-8", buffering=1)
        sys.stdout = _log_f
        sys.stderr = _log_f
    except Exception:
        pass

import socket
import uvicorn
from server.tray import TrayManager

PORT = 8088
HOST = "127.0.0.1"
BIND_HOST = "127.0.0.1"
APP_URL = f"http://{HOST}:{PORT}"


def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """指定ポートが既に使用中か確認する"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


from server.window_utils import ensure_maximized_loop


def _maximize_app_window_win32(timeout_sec: float = 6.0) -> None:
    """Windows API (user32) を用いて起動した Photo Manager ウィンドウを確実に最大化する"""
    ensure_maximized_loop(port=PORT, timeout_sec=timeout_sec, hold_sec=2.5)


def launch_app_window() -> None:
    """デスクトップアプリ風ウィンドウ（または通常ブラウザ）を最大化状態で開く"""
    # Edge または Chrome の実行ファイルを探す
    edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    chrome_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]

    browser_exe = None
    for p in edge_paths + chrome_paths:
        if os.path.exists(p):
            browser_exe = p
            break

    if browser_exe:
        try:
            print(f"[INFO] アプリモード（最大化）でウィンドウを起動します: {browser_exe}")
            # --app オプションにより、URLバーやタブのない単体アプリウィンドウとして起動
            subprocess.Popen([
                browser_exe,
                f"--app={APP_URL}",
                "--start-maximized",
                "--window-position=0,0",
            ])
            threading.Thread(
                target=_maximize_app_window_win32,
                daemon=False,
                name="MaximizeAppWindow",
            ).start()
            return
        except Exception as e:
            print(f"[WARN] アプリモード起動失敗、既定のブラウザで開きます: {e}")

    # フォールバック: 通常の既定ブラウザで開く
    webbrowser.open(APP_URL)
    threading.Thread(
        target=_maximize_app_window_win32,
        daemon=False,
        name="MaximizeAppWindowFallback",
    ).start()


def main() -> None:
    """エントリポイント"""
    # 既にサーバーが稼働中の場合は、ブラウザウィンドウだけ開いて終了する
    if is_port_in_use(PORT, HOST):
        print(f"[INFO] サーバーは既に稼働中です ({APP_URL})。アプリ画面を開きます。")
        launch_app_window()
        return

    print("=" * 60)
    print("  Photo Manager (Hinomaru Ink & Picasa Inspired)")
    print(f"  URL: {APP_URL}")
    print("=" * 60)

    # 1. サーバー立ち上がり待機後にブラウザ/アプリウィンドウを起動するスレッド
    def _delayed_launch():
        # サーバーがポートを開くまでポーリング待機（最大10秒、0.2秒刻み）
        for _ in range(50):
            time.sleep(0.2)
            if is_port_in_use(PORT, HOST):
                break
        time.sleep(0.4)
        launch_app_window()

    launcher_thread = threading.Thread(target=_delayed_launch, daemon=True, name="WindowLauncher")
    launcher_thread.start()

    # 2. Uvicorn サーバーインスタンスの生成（既定は安全なローカル 127.0.0.1 待受、スマホ連携モーダル表示時にオンデマンドでLAN待受を開始）
    from server.app import app
    config = uvicorn.Config(app, host=BIND_HOST, port=PORT, log_level="info")
    server = uvicorn.Server(config)

    # 3. タスクトレイ常駐マネージャーの初期化と開始
    def _handle_shutdown():
        print("[INFO] タスクトレイから終了が要求されました。サーバーをシャットダウンします...")
        server.should_exit = True

        # フェイルセーフ（2秒後にプロセスを強制終了）
        def _failsafe():
            time.sleep(2.0)
            os._exit(0)

        threading.Thread(target=_failsafe, daemon=True, name="ShutdownFailsafe").start()

    tray_manager = TrayManager(
        app_url=APP_URL,
        on_open_app=launch_app_window,
        on_shutdown=_handle_shutdown,
    )
    tray_manager.start()

    # 4. サーバー実行
    try:
        server.run()
    except KeyboardInterrupt:
        print("\n[INFO] Photo Manager を終了しました。")
    except Exception as e:
        print(f"[ERROR] 起動エラー: {e}")
    finally:
        tray_manager.stop()


if __name__ == "__main__":
    main()
