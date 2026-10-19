"""
Windows ウィンドウ最大化ユーティリティ
起動時の Edge / Chrome アプリモードウィンドウを確実に最大化（タスクバー表示ありのフル画面）にする。
"""

import ctypes
import sys
import time
from ctypes import wintypes


def maximize_photo_manager_window(port: int = 8088) -> int:
    """
    現在表示されている Photo Manager のブラウザウィンドウ（Chrome_WidgetWin_1）を探し、
    Windows 標準の最大化状態（タスクバーを残したフル画面）にする。
    戻り値: 対象として検出・最大化したウィンドウ数
    """
    if sys.platform != "win32":
        return 0

    try:
        user32 = ctypes.windll.user32

        SW_MAXIMIZE = 3
        WM_SYSCOMMAND = 0x0112
        SC_MAXIMIZE = 0xF030

        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        target_keywords = (
            "Photo Manager - Tiat & Picasa Inspired",
            f"127.0.0.1:{port}",
            f"localhost:{port}",
        )

        matched_hwnds = []

        def _enum_cb(hwnd, _lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length <= 0:
                    return True
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value or ""

                if any(kw in title for kw in target_keywords):
                    if any(ignore in title for ignore in ("Visual Studio Code", "Antigravity", "Cursor")):
                        return True
                    cls_buf = ctypes.create_unicode_buffer(256)
                    user32.GetClassNameW(hwnd, cls_buf, 256)
                    if cls_buf.value == "Chrome_WidgetWin_1":
                        matched_hwnds.append(hwnd)
            except Exception:
                pass
            return True

        cb_func = WNDENUMPROC(_enum_cb)
        user32.EnumWindows(cb_func, 0)

        for hwnd in matched_hwnds:
            try:
                if not user32.IsZoomed(hwnd):
                    # 1. 非同期ShowWindowで最大化を要求
                    user32.ShowWindowAsync(hwnd, SW_MAXIMIZE)
                    # 2. タイトルバーの最大化ボタンを押したのと同じシステムコマンドを送信（Chromium内部状態の同期・保存用）
                    user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_MAXIMIZE, 0)
                    # 3. 同期ShowWindowも呼び出し
                    user32.ShowWindow(hwnd, SW_MAXIMIZE)
                try:
                    user32.SetForegroundWindow(hwnd)
                except Exception:
                    pass
            except Exception:
                pass

        return len(matched_hwnds)
    except Exception as e:
        print(f"[WARN] ウィンドウ最大化処理スキップ: {e}")
        return 0


def ensure_maximized_loop(port: int = 8088, timeout_sec: float = 6.0, hold_sec: float = 2.5) -> None:
    """
    ウィンドウが立ち上がるまで待機して最大化し、さらに Chromium が起動直後に
    前回のウィンドウサイズ（半分サイズ等）を遅延復元するのを防ぐため一定時間監視して再適用する。
    """
    if sys.platform != "win32":
        return

    deadline = time.time() + timeout_sec
    first_found_at = None

    while time.time() < deadline:
        count = maximize_photo_manager_window(port=port)
        if count > 0:
            if first_found_at is None:
                first_found_at = time.time()
                # 初回検出後、hold_sec 秒間は遅延サイズ復元の上書きを防ぐため監視を継続する
                deadline = max(deadline, first_found_at + hold_sec)
            elif time.time() - first_found_at >= hold_sec:
                return
            time.sleep(0.25)
        else:
            time.sleep(0.12)
