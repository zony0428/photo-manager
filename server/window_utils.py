"""
Windows ウィンドウ制御・起動サイズ設定ユーティリティ
起動時の Edge / Chrome アプリモードウィンドウを、ユーザー設定（最大化・前回記憶・中央・左半分・右半分・フルスクリーン）に応じて制御する。
"""

import ctypes
import json
import logging
import sys
import time
from ctypes import wintypes
from pathlib import Path

logger = logging.getLogger(__name__)

# プロジェクトルート配下の cache/window_settings.json にポータブル保存
_BASE_DIR = Path(__file__).resolve().parent.parent
_SETTINGS_FILE = _BASE_DIR / "cache" / "window_settings.json"

VALID_WINDOW_MODES = (
    "maximized",
    "remember",
    "center",
    "left_half",
    "right_half",
    "fullscreen",
)
DEFAULT_WINDOW_MODE = "maximized"


def get_startup_window_mode() -> str:
    """保存されている起動時ウィンドウモードを取得する（未設定時は 'maximized'）"""
    try:
        if _SETTINGS_FILE.exists():
            data = json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
            mode = data.get("startup_mode", DEFAULT_WINDOW_MODE)
            if mode in VALID_WINDOW_MODES:
                return mode
    except Exception as e:
        print(f"[WARN] ウィンドウ設定の読み込みスキップ: {e}")
    return DEFAULT_WINDOW_MODE


def set_startup_window_mode(mode: str) -> str:
    """起動時ウィンドウモードを保存する"""
    normalized = mode if mode in VALID_WINDOW_MODES else DEFAULT_WINDOW_MODE
    try:
        _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = {"startup_mode": normalized}
        _SETTINGS_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        print(f"[WARN] ウィンドウ設定の保存エラー: {e}")
    return normalized


class _MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def get_primary_work_area() -> tuple:
    """プライマリモニターの作業領域 (x, y, width, height) を返す"""
    if sys.platform == "win32":
        try:
            user32 = ctypes.windll.user32
            SPI_GETWORKAREA = 0x0030
            work_rect = wintypes.RECT()
            if user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(work_rect), 0):
                w = max(640, work_rect.right - work_rect.left)
                h = max(480, work_rect.bottom - work_rect.top)
                return (work_rect.left, work_rect.top, w, h)
            w = max(640, user32.GetSystemMetrics(0))
            h = max(480, user32.GetSystemMetrics(1) - 48)
            return (0, 0, w, h)
        except Exception as e:
            logger.debug(f"作業領域取得エラー: {e}")
    return (0, 0, 1920, 1032)


def get_startup_chromium_args(mode: str = None) -> list:
    """
    指定されたウィンドウモードに応じて、Edge/Chrome 起動時に渡すコマンドライン引数リストを生成する。
    """
    target_mode = mode if mode in VALID_WINDOW_MODES else get_startup_window_mode()
    if target_mode == "remember":
        # 前回のサイズ・位置を記憶（システム標準）の場合はサイズ指定引数を渡さず Chromium の記憶に任せる
        return []
    if target_mode == "maximized":
        return ["--start-maximized", "--window-position=0,0"]
    if target_mode == "fullscreen":
        return ["--start-fullscreen"]

    work_x, work_y, work_w, work_h = get_primary_work_area()
    if target_mode == "left_half":
        w = work_w // 2
        h = work_h
        x = work_x
        y = work_y
    elif target_mode == "right_half":
        half_w = work_w // 2
        w = work_w - half_w
        h = work_h
        x = work_x + half_w
        y = work_y
    else:  # "center"
        w = max(900, int(work_w * 0.78))
        h = max(640, int(work_h * 0.82))
        x = work_x + (work_w - w) // 2
        y = work_y + (work_h - h) // 2

    return [f"--window-position={x},{y}", f"--window-size={w},{h}"]


def _find_photo_manager_hwnds(port: int = 8088) -> list:
    """現在表示されている Photo Manager のブラウザウィンドウ（Chrome_WidgetWin_1）の HWND リストを返す"""
    if sys.platform != "win32":
        return []

    user32 = ctypes.windll.user32
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
        except Exception as e:
            logger.debug(f"ウィンドウ列挙スキップ (hwnd={hwnd}): {e}")
        return True

    cb_func = WNDENUMPROC(_enum_cb)
    user32.EnumWindows(cb_func, 0)
    return matched_hwnds


def _get_monitor_rects(hwnd: int) -> tuple:
    """対象ウィンドウが存在するモニターの (rcMonitor, rcWork) を取得する"""
    user32 = ctypes.windll.user32
    MONITOR_DEFAULTTONEAREST = 2
    hmonitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    mi = _MONITORINFO()
    mi.cbSize = ctypes.sizeof(_MONITORINFO)
    if hmonitor and user32.GetMonitorInfoW(hmonitor, ctypes.byref(mi)):
        return mi.rcMonitor, mi.rcWork

    # フォールバック: プライマリモニター
    SPI_GETWORKAREA = 0x0030
    work_rect = wintypes.RECT()
    user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(work_rect), 0)
    mon_rect = wintypes.RECT(0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1))
    return mon_rect, work_rect


def _get_invisible_frame_margins(hwnd: int) -> tuple:
    """
    Windows 10/11 の DWM 見えないリサイズ枠（左右・下の約7〜8pxの透明境界）の幅を取得する。
    戻り値: (pad_left, pad_top, pad_right, pad_bottom)
    """
    try:
        user32 = ctypes.windll.user32
        dwmapi = ctypes.windll.dwmapi
        DWMWA_EXTENDED_FRAME_BOUNDS = 9

        win_rect = wintypes.RECT()
        frame_rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(win_rect)):
            return (0, 0, 0, 0)
        hr = dwmapi.DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            ctypes.byref(frame_rect),
            ctypes.sizeof(frame_rect),
        )
        if hr != 0:
            return (0, 0, 0, 0)

        pad_left = max(0, frame_rect.left - win_rect.left)
        pad_top = max(0, frame_rect.top - win_rect.top)
        pad_right = max(0, win_rect.right - frame_rect.right)
        pad_bottom = max(0, win_rect.bottom - frame_rect.bottom)
        return (pad_left, pad_top, pad_right, pad_bottom)
    except Exception:
        return (0, 0, 0, 0)


def _is_window_fullscreen(hwnd: int, rc_monitor: wintypes.RECT) -> bool:
    """ウィンドウが現在 F11 フルスクリーン状態（モニター全域を覆い、かつ標準最大化ではない）か判定する"""
    user32 = ctypes.windll.user32
    if user32.IsZoomed(hwnd):
        return False
    win_rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(win_rect)):
        return False
    return (
        win_rect.left <= rc_monitor.left
        and win_rect.top <= rc_monitor.top
        and win_rect.right >= rc_monitor.right
        and win_rect.bottom >= rc_monitor.bottom
    )


def _send_f11_key(hwnd: int) -> None:
    """指定した Chromium ウィンドウに F11 キーイベントを送り、フルスクリーン状態を切り替える"""
    user32 = ctypes.windll.user32
    WM_KEYDOWN = 0x0100
    WM_KEYUP = 0x0101
    VK_F11 = 0x7A
    try:
        user32.SetForegroundWindow(hwnd)
    except Exception as e:
        logger.debug(f"フォアグラウンド設定スキップ (hwnd={hwnd}): {e}")
    user32.PostMessageW(hwnd, WM_KEYDOWN, VK_F11, 0)
    time.sleep(0.04)
    user32.PostMessageW(hwnd, WM_KEYUP, VK_F11, 0)


def apply_window_mode(mode: str = None, port: int = 8088) -> int:
    """
    指定されたウィンドウモード（未指定時は保存済み設定）を現在の Photo Manager ウィンドウへ適用する。
    戻り値: 処理したウィンドウ数
    """
    if sys.platform != "win32":
        return 0

    target_mode = mode if mode in VALID_WINDOW_MODES else get_startup_window_mode()

    try:
        user32 = ctypes.windll.user32
        SW_RESTORE = 9
        SW_MAXIMIZE = 3
        WM_SYSCOMMAND = 0x0112
        SC_MAXIMIZE = 0xF030
        SC_RESTORE = 0xF120
        SWP_NOZORDER = 0x0004
        SWP_NOACTIVATE = 0x0010
        SWP_SHOWWINDOW = 0x0040

        matched_hwnds = _find_photo_manager_hwnds(port=port)
        if not matched_hwnds:
            return 0

        for hwnd in matched_hwnds:
            try:
                rc_mon, rc_work = _get_monitor_rects(hwnd)
                is_fs = _is_window_fullscreen(hwnd, rc_mon)

                if target_mode == "fullscreen":
                    if not is_fs:
                        _send_f11_key(hwnd)
                    continue

                # フルスクリーン以外のモードへ切り替える際、現在フルスクリーンなら先に解除する
                if is_fs:
                    _send_f11_key(hwnd)
                    time.sleep(0.18)

                if target_mode == "remember":
                    # 前回のサイズ・位置を記憶（システム標準）の場合は現在のサイズをそのまま維持
                    try:
                        user32.SetForegroundWindow(hwnd)
                    except Exception as e:
                        logger.debug(f"フォアグラウンド設定スキップ (hwnd={hwnd}): {e}")
                    continue

                if target_mode == "maximized":
                    if not user32.IsZoomed(hwnd):
                        user32.ShowWindowAsync(hwnd, SW_MAXIMIZE)
                        user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_MAXIMIZE, 0)
                        user32.ShowWindow(hwnd, SW_MAXIMIZE)
                    try:
                        user32.SetForegroundWindow(hwnd)
                    except Exception as e:
                        logger.debug(f"フォアグラウンド設定スキップ (hwnd={hwnd}): {e}")
                    continue

                # --- 通常ウィンドウ系（center / left_half / right_half） ---
                if user32.IsZoomed(hwnd):
                    user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_RESTORE, 0)
                    user32.ShowWindow(hwnd, SW_RESTORE)
                    time.sleep(0.08)

                work_x = rc_work.left
                work_y = rc_work.top
                work_w = max(640, rc_work.right - rc_work.left)
                work_h = max(480, rc_work.bottom - rc_work.top)

                if target_mode == "left_half":
                    target_w = work_w // 2
                    target_h = work_h
                    target_x = work_x
                    target_y = work_y
                elif target_mode == "right_half":
                    half_w = work_w // 2
                    target_w = work_w - half_w
                    target_h = work_h
                    target_x = work_x + half_w
                    target_y = work_y
                else:  # "center" (画面中央・約80%サイズ)
                    target_w = max(900, int(work_w * 0.78))
                    target_h = max(640, int(work_h * 0.82))
                    target_x = work_x + (work_w - target_w) // 2
                    target_y = work_y + (work_h - target_h) // 2

                # DWM の透明リサイズ枠（約7〜8px）を補正して隙間なく配置
                pad_l, pad_t, pad_r, pad_b = _get_invisible_frame_margins(hwnd)
                adj_x = target_x - pad_l
                adj_y = target_y - pad_top if "pad_top" in locals() else target_y - pad_t
                adj_w = target_w + pad_l + pad_r
                adj_h = target_h + pad_t + pad_b

                user32.SetWindowPos(
                    hwnd,
                    0,
                    adj_x,
                    adj_y,
                    adj_w,
                    adj_h,
                    SWP_NOZORDER | SWP_SHOWWINDOW | SWP_NOACTIVATE,
                )
                try:
                    user32.SetForegroundWindow(hwnd)
                except Exception as e:
                    logger.debug(f"フォアグラウンド設定スキップ (hwnd={hwnd}): {e}")
            except Exception as inner_e:
                logger.warning(f"ウィンドウ個別制御スキップ: {inner_e}")

        return len(matched_hwnds)
    except Exception as e:
        logger.warning(f"ウィンドウモード適用スキップ: {e}")
        return 0


def maximize_photo_manager_window(port: int = 8088) -> int:
    """後方互換ラッパー: 保存されている起動時ウィンドウモードを適用する"""
    mode = get_startup_window_mode()
    if mode == "remember":
        return 0
    return apply_window_mode(mode=mode, port=port)


def ensure_window_mode_loop(
    mode: str = None,
    port: int = 8088,
    timeout_sec: float = 6.0,
    hold_sec: float = 2.0,
) -> None:
    """
    起動時にウィンドウが立ち上がるまで待機して指定モードを適用する。
    """
    if sys.platform != "win32":
        return

    target_mode = mode if mode in VALID_WINDOW_MODES else get_startup_window_mode()
    if target_mode == "remember":
        return

    deadline = time.time() + timeout_sec
    first_found_at = None

    while time.time() < deadline:
        count = apply_window_mode(mode=target_mode, port=port)
        if count > 0:
            if target_mode in ("center", "left_half", "right_half", "fullscreen"):
                # サイズ指定系・フルスクリーンは1回適用＋微調整確認で完了（何度もSetWindowPosを連打しない）
                time.sleep(0.35)
                if target_mode != "fullscreen":
                    apply_window_mode(mode=target_mode, port=port)
                return

            # maximized の場合は Chromium の遅延サイズ復元を防ぐため hold_sec 間監視する
            if first_found_at is None:
                first_found_at = time.time()
                deadline = max(deadline, first_found_at + hold_sec)
            elif time.time() - first_found_at >= hold_sec:
                return
            time.sleep(0.25)
        else:
            time.sleep(0.12)


def ensure_maximized_loop(port: int = 8088, timeout_sec: float = 6.0, hold_sec: float = 2.5) -> None:
    """後方互換ラッパー: 起動時の設定モードに応じてループ制御を行う"""
    ensure_window_mode_loop(mode=None, port=port, timeout_sec=timeout_sec, hold_sec=hold_sec)
