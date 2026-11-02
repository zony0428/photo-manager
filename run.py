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


from server.window_utils import (
    ensure_window_mode_loop,
    get_startup_chromium_args,
    get_startup_window_mode,
)


def _apply_startup_window_win32(mode: str = None, timeout_sec: float = 6.0) -> None:
    """Windows API (user32) を用いて起動した Photo Manager ウィンドウを設定されたサイズ・状態にする"""
    ensure_window_mode_loop(mode=mode, port=PORT, timeout_sec=timeout_sec, hold_sec=2.5)


def launch_app_window() -> None:
    """デスクトップアプリ風ウィンドウ（または通常ブラウザ）を設定されたウィンドウモードで開く"""
    startup_mode = get_startup_window_mode()

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
            print(f"[INFO] アプリモード (mode={startup_mode}) でウィンドウを起動します: {browser_exe}")
            # --app オプションにより、URLバーやタブのない単体アプリウィンドウとして起動
            cmd = [browser_exe, f"--app={APP_URL}"]
            cmd.extend(get_startup_chromium_args(startup_mode))

            subprocess.Popen(cmd)
            if startup_mode != "remember":
                threading.Thread(
                    target=_apply_startup_window_win32,
                    args=(startup_mode,),
                    daemon=False,
                    name="StartupAppWindowMode",
                ).start()
            return
        except Exception as e:
            print(f"[WARN] アプリモード起動失敗、既定のブラウザで開きます: {e}")

    # フォールバック: 通常の既定ブラウザで開く
    webbrowser.open(APP_URL)
    if startup_mode != "remember":
        threading.Thread(
            target=_apply_startup_window_win32,
            args=(startup_mode,),
            daemon=False,
            name="StartupAppWindowFallback",
        ).start()


def refresh_windows_exe_icon(exe_path: Path) -> None:
    """
    Windows エクスプローラーのアイコンキャッシュが旧アイコン（PhotoManager.exe 時代等）を
    保持し続ける現象を防ぐため、ファイル作成日時を最新化した上で Shell 更新通知を送る。
    """
    if sys.platform != "win32" or not exe_path.exists():
        return
    try:
        import ctypes
        from ctypes import wintypes

        resolved = str(exe_path.resolve())
        kernel32 = ctypes.windll.kernel32
        # FILE_WRITE_ATTRIBUTES (0x0100), OPEN_EXISTING (3), FILE_ATTRIBUTE_NORMAL (0x80)
        handle = kernel32.CreateFileW(resolved, 0x0100, 7, None, 3, 0x80, None)
        if handle != -1 and handle != wintypes.HANDLE(-1).value:
            ft = wintypes.FILETIME()
            kernel32.GetSystemTimeAsFileTime(ctypes.byref(ft))
            kernel32.SetFileTime(handle, ctypes.byref(ft), ctypes.byref(ft), ctypes.byref(ft))
            kernel32.CloseHandle(handle)

        shell32 = ctypes.windll.shell32
        wpath = ctypes.c_wchar_p(resolved)
        wdir = ctypes.c_wchar_p(str(exe_path.resolve().parent))
        # SHCNF_PATHW | SHCNF_FLUSHNOWAIT (0x2005), SHCNF_IDLIST | SHCNF_FLUSHNOWAIT (0x2000)
        shell32.SHChangeNotify(0x00000004, 0x2005, wpath, None)  # SHCNE_DELETE
        shell32.SHChangeNotify(0x00000002, 0x2005, wpath, None)  # SHCNE_CREATE
        shell32.SHChangeNotify(0x00002000, 0x2005, wpath, None)  # SHCNE_UPDATEITEM
        shell32.SHChangeNotify(0x00001000, 0x2005, wdir, None)   # SHCNE_UPDATEDIR
        shell32.SHChangeNotify(0x08000000, 0x2000, None, None)   # SHCNE_ASSOCCHANGED
    except Exception as e:
        print(f"[WARN] アイコンキャッシュ更新通知スキップ: {e}")


def _compile_tetheract_launcher(root_dir: Path) -> bool:
    """
    Windows 標準の csc.exe を用いて、最新の frontend/favicon.ico と launcher/Launcher.cs から
    Tetheract.exe をクリーンビルドする。
    """
    if sys.platform != "win32":
        return False
    cs_path = root_dir / "launcher" / "Launcher.cs"
    ico_path = root_dir / "frontend" / "favicon.ico"
    out_path = root_dir / "Tetheract.exe"
    tmp_path = root_dir / "Tetheract.new.exe"
    if not cs_path.exists() or not ico_path.exists():
        return False

    csc_candidates = [
        Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
    ]
    csc_exe = next((p for p in csc_candidates if p.exists()), None)
    if csc_exe is None:
        return False

    try:
        if tmp_path.exists():
            tmp_path.unlink()
        res = subprocess.run(
            [
                str(csc_exe),
                "/nologo",
                "/target:winexe",
                "/optimize+",
                f"/win32icon:{ico_path}",
                f"/out:{tmp_path}",
                str(cs_path),
            ],
            capture_output=True,
            timeout=15,
        )
        if res.returncode != 0 or not tmp_path.exists():
            return False

        if out_path.exists():
            out_path.unlink()
        tmp_path.replace(out_path)
        refresh_windows_exe_icon(out_path)
        return True
    except Exception as e:
        print(f"[WARN] Tetheract.exe の自動ビルドスキップ: {e}")
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass
        return False


def _migrate_legacy_launcher_files() -> None:
    """
    旧バージョンの PhotoManager.exe / PhotoManager_Mobile.html が残っている場合、
    ランチャープロセス終了後（0.4秒後）に自動で Tetheract.exe / Tetheract_Mobile.html へ
    移行・クリーンアップする。
    ※ PhotoManager.exe（旧アイコン）を単純リネームすると旧アイコンがキャッシュされるため、
       最新アイコンでの再コンパイルを優先する。
    """
    def _worker():
        time.sleep(0.4)
        root_dir = Path(_PROJECT_ROOT)
        old_exe = root_dir / "PhotoManager.exe"
        new_exe = root_dir / "Tetheract.exe"
        ico_path = root_dir / "frontend" / "favicon.ico"

        # 1. PhotoManager.exe の移行または削除
        if old_exe.exists():
            for _ in range(5):
                try:
                    if not new_exe.exists():
                        if _compile_tetheract_launcher(root_dir):
                            old_exe.unlink()
                            print("[MIGRATE] 最新アイコンで Tetheract.exe を生成し、旧 PhotoManager.exe を削除しました")
                        else:
                            old_exe.replace(new_exe)
                            print("[MIGRATE] ランチャーをリネームしました: PhotoManager.exe -> Tetheract.exe")
                    else:
                        old_exe.unlink()
                        print("[MIGRATE] 旧ファイルを整理しました: PhotoManager.exe (新: Tetheract.exe)")
                    break
                except Exception:
                    time.sleep(0.3)

        # 2. 既存の Tetheract.exe に旧アイコンが入っている場合は自動再ビルド
        if new_exe.exists() and ico_path.exists():
            try:
                exe_bytes = new_exe.read_bytes()
                ico_bytes = ico_path.read_bytes()
                needs_rebuild = (b"\x89PNG\r\n\x1a\n" in ico_bytes and ico_bytes[-4096:] not in exe_bytes)
                if needs_rebuild:
                    if _compile_tetheract_launcher(root_dir):
                        print("[MIGRATE] Tetheract.exe のアイコンを最新リソースで更新しました")
            except Exception as e:
                print(f"[WARN] Tetheract.exe アイコン検証スキップ: {e}")

        # 3. PhotoManager_Mobile.html の移行または削除
        old_mob = root_dir / "PhotoManager_Mobile.html"
        new_mob = root_dir / "Tetheract_Mobile.html"
        if old_mob.exists():
            for _ in range(5):
                try:
                    if new_mob.exists():
                        old_mob.unlink()
                        print("[MIGRATE] 旧ファイルを整理しました: PhotoManager_Mobile.html (新: Tetheract_Mobile.html)")
                    else:
                        old_mob.replace(new_mob)
                        print("[MIGRATE] モバイルHTMLをリネームしました: PhotoManager_Mobile.html -> Tetheract_Mobile.html")
                    break
                except Exception:
                    time.sleep(0.3)

    threading.Thread(target=_worker, daemon=True, name="LegacyFileMigrator").start()


def main() -> None:
    """エントリポイント"""
    _migrate_legacy_launcher_files()
    # 既にサーバーが稼働中の場合は、ブラウザウィンドウだけ開いて終了する
    if is_port_in_use(PORT, HOST):
        print(f"[INFO] サーバーは既に稼働中です ({APP_URL})。アプリ画面を開きます。")
        launch_app_window()
        return

    print("=" * 60)
    print("  Tetheract Photo Manager")
    print(f"  URL: {APP_URL}")
    print("=" * 60)

    # 1. サーバー立ち上がり待機後にブラウザ/アプリウィンドウを起動するスレッド
    def _delayed_launch():
        # サーバーがポートを開くまでポーリング待機（初回大規模DBマイグレーション等を考慮し最大180秒、0.2秒刻み）
        for _ in range(900):
            time.sleep(0.2)
            if is_port_in_use(PORT, HOST):
                time.sleep(0.4)
                launch_app_window()
                return

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
        print("\n[INFO] Tetheract Photo Manager を終了しました。")
    except Exception as e:
        print(f"[ERROR] 起動エラー: {e}")
    finally:
        tray_manager.stop()


if __name__ == "__main__":
    main()
