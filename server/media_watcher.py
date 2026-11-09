"""
クロスメディア抜き挿し自動検知・イベント配信モジュール (media_watcher)
Windows OS の WM_DEVICECHANGE イベント駆動（CPU負荷ゼロ待機）をメインとし、
ウィンドウフォーカス復帰時のオンデマンド照合をサブ保険として組み合わせ、
SDカード・USBメモリ・外付けSSDの接続／取り外しをリアルタイムに検知してSSEでフロントエンドへプッシュ通知する。
"""

import asyncio
import logging
import string
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from .database.connection import get_connection
from .database.folders import clear_folders_fs_cache, upsert_volume
from .scanner import clear_online_cache
from .volume_info import get_volume_info_for_drive

logger = logging.getLogger("photo_manager.media_watcher")

# Windows デバイス変更メッセージ定数
WM_DEVICECHANGE = 0x0219
WM_DESTROY = 0x0002
DBT_DEVNODES_CHANGED = 0x0007
DBT_DEVICEARRIVAL = 0x8000
DBT_DEVICEREMOVECOMPLETE = 0x8004

_watcher_lock = threading.Lock()
_initialized: bool = False
# { VSN(大文字): {"serial": VSN, "drive": "E:", "label": "EOS_DIGITAL", "filesystem": "exFAT"} }
_last_drives: Dict[str, Dict[str, Any]] = {}
# 直近で取り外されたメディアのキャッシュ情報（取り外し通知時にラベル等を表示するため保持）
_known_volume_meta: Dict[str, Dict[str, Any]] = {}

_event_seq: int = 0
_last_event: Optional[Dict[str, Any]] = None

# SSE購読クライアント管理 (loop, asyncio.Queue)
_subscribers_lock = threading.Lock()
_subscribers: Set[Tuple[asyncio.AbstractEventLoop, "asyncio.Queue[Dict[str, Any]]"]] = set()

_watcher_thread: Optional[threading.Thread] = None
_probe_Schedule_lock = threading.Lock()
_probe_running: bool = False
_probe_last_trigger_ts: float = 0.0


def _format_short_serial(serial: str) -> str:
    """8桁16進のVSNを XXXX-XXXX 形式に整形する"""
    s = (serial or "").strip().upper()
    if len(s) == 8 and all(c in "0123456789ABCDEF" for c in s):
        return f"{s[:4]}-{s[4:]}"
    return s


def _scan_connected_local_drives() -> Dict[str, Dict[str, Any]]:
    """
    現在接続されている全ローカルドライブ（ネットワークドライブ除く）のボリューム情報を走査する。
    OSのドライブビットマスクとボリュームヘッダのみを参照するため1ミリ秒未満で完了する。
    """
    result: Dict[str, Dict[str, Any]] = {}
    if sys.platform != "win32":
        return result

    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        old_mode = ctypes.c_uint(0)
        try:
            kernel32.SetThreadErrorMode(0x0001 | 0x8000, ctypes.byref(old_mode))
        except Exception as e:
            logger.debug(f"SetThreadErrorMode 失敗: {e}")

        try:
            mask = kernel32.GetLogicalDrives()
            for i, letter in enumerate(string.ascii_uppercase):
                if not (mask & (1 << i)):
                    continue
                root = f"{letter}:\\"
                drive_type = kernel32.GetDriveTypeW(ctypes.c_wchar_p(root))
                # 0=UNKNOWN, 1=NO_ROOT_DIR, 4=REMOTE(ネットワークドライブはブロック回避のため除外)
                if drive_type <= 1 or drive_type == 4:
                    continue
                info = get_volume_info_for_drive(letter)
                if info and info.get("serial"):
                    serial = str(info["serial"]).strip().upper()
                    result[serial] = {
                        "serial": serial,
                        "drive": f"{letter}:",
                        "label": str(info.get("label") or ""),
                        "filesystem": str(info.get("filesystem") or ""),
                        "drive_type": int(drive_type),
                    }
        finally:
            try:
                kernel32.SetThreadErrorMode(old_mode.value, None)
            except Exception as e:
                logger.debug(f"SetThreadErrorMode 復元失敗: {e}")
    except Exception as e:
        logger.debug(f"接続ドライブ走査失敗: {e}")

    return result


def _enrich_media_item(serial: str, drive_info: Optional[Dict[str, Any]], is_online: bool) -> Dict[str, Any]:
    """
    指定されたVSNに対して、DB上の登録情報（識別名 custom_name、管理写真枚数、Loome有無）を結合して返す。
    """
    s_upper = (serial or "").strip().upper()
    short_s = _format_short_serial(s_upper)
    cached_meta = _known_volume_meta.get(s_upper, {})

    drive_letter = (drive_info or {}).get("drive") or cached_meta.get("drive") or ""
    os_label = (drive_info or {}).get("label") if drive_info is not None else cached_meta.get("label", "")
    os_label = str(os_label or "")
    custom_name = str(cached_meta.get("custom_name") or "")
    loome_enabled = bool(cached_meta.get("loome_enabled", False))
    photo_count = 0
    is_in_volumes_table = False

    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT volume_label, custom_name, drive_letter, loome_enabled FROM volumes WHERE volume_serial = ? COLLATE NOCASE LIMIT 1",
                (s_upper,),
            )
            v_row = cursor.fetchone()
            db_vol_label = ""
            db_drive_letter = ""
            if v_row:
                is_in_volumes_table = True
                db_vol_label = str(v_row["volume_label"] or "")
                db_drive_letter = str(v_row["drive_letter"] or "")
                if not os_label and db_vol_label:
                    os_label = db_vol_label
                custom_name = str(v_row["custom_name"] or "")
                if not drive_letter and db_drive_letter:
                    drive_letter = db_drive_letter
                loome_enabled = bool(v_row["loome_enabled"])

            cursor.execute(
                """
                SELECT COUNT(DISTINCT pl.photo_id) AS cnt
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.volume_serial = ? COLLATE NOCASE
                  AND COALESCE(p.is_unlinked, 0) = 0
                """,
                (s_upper,),
            )
            c_row = cursor.fetchone()
            if c_row and c_row["cnt"] is not None:
                photo_count = int(c_row["cnt"])
    except Exception as e:
        logger.debug(f"メディアDB情報照会スキップ ({s_upper}): {e}")

    # 接続されたメディアが既にDB管理下（volumes登録済み または 写真リンクあり）で、未登録またはラベル・ドライブ文字が変化した場合のみDBへ同期
    if is_online and drive_info and (is_in_volumes_table or photo_count > 0):
        need_vol_sync = (
            not is_in_volumes_table
            or (os_label and os_label != db_vol_label)
            or (drive_letter and drive_letter.upper() != db_drive_letter.upper())
        )
        if need_vol_sync:
            try:
                upsert_volume(s_upper, os_label, drive_letter)
            except Exception as e:
                logger.debug(f"ボリューム接続情報のDB自動更新スキップ ({s_upper}): {e}")

    primary_name = custom_name or os_label or f"メディア [ID:{short_s}]"
    if custom_name and os_label and custom_name != os_label:
        display_name = f"{custom_name} ({os_label}) [ID:{short_s}]"
    elif custom_name or os_label:
        display_name = f"{primary_name} [ID:{short_s}]"
    else:
        display_name = primary_name

    enriched = {
        "serial": s_upper,
        "short_serial": short_s,
        "drive": drive_letter,
        "label": os_label,
        "custom_name": custom_name,
        "primary_name": primary_name,
        "display_name": display_name,
        "photo_count": photo_count,
        "is_managed": bool(photo_count > 0 or is_in_volumes_table),
        "loome_enabled": loome_enabled,
        "is_online": is_online,
    }
    _known_volume_meta[s_upper] = enriched
    return enriched


def update_known_volume_meta(
    volume_serial: str,
    custom_name: Optional[str] = None,
    label: Optional[str] = None,
    drive: Optional[str] = None,
    loome_enabled: Optional[bool] = None,
) -> None:
    """ボリューム情報変更時に _known_volume_meta のキャッシュを最新化する"""
    s_upper = (volume_serial or "").strip().upper()
    if not s_upper:
        return
    with _watcher_lock:
        if s_upper in _known_volume_meta:
            meta = dict(_known_volume_meta[s_upper])
            if custom_name is not None:
                meta["custom_name"] = str(custom_name or "").strip()
            if label is not None and label != "":
                meta["label"] = str(label).strip()
            if drive is not None and drive != "":
                meta["drive"] = str(drive).strip()
            if loome_enabled is not None:
                meta["loome_enabled"] = bool(loome_enabled)
            _known_volume_meta[s_upper] = meta
        drive_info = _last_drives.get(s_upper)
        if drive_info and label:
            drive_info["label"] = str(label)
    try:
        _enrich_media_item(s_upper, drive_info, is_online=(drive_info is not None))
    except Exception as e:
        logger.debug(f"known_volume_meta 再計算スキップ ({s_upper}): {e}")


def _broadcast_event(event_payload: Dict[str, Any]) -> None:
    """購読中の全SSEクライアントへメディア変更イベントを非同期キュー経由で即時プッシュする"""
    with _subscribers_lock:
        subs = list(_subscribers)
    for loop, q in subs:
        try:
            loop.call_soon_threadsafe(q.put_nowait, event_payload)
        except Exception as e:
            logger.debug(f"SSEクライアントへのイベント送信スキップ: {e}")


def broadcast_app_event(event_type: str, payload: Optional[Dict[str, Any]] = None) -> None:
    """汎用アプリケーションイベントを全SSE購読クライアントへプッシュ配信する"""
    evt: Dict[str, Any] = {"type": event_type, **(payload or {})}
    _broadcast_event(evt)


def check_media_changes(source: str = "manual") -> Dict[str, Any]:
    """
    現在の接続ドライブ・VSN一覧を前回スナップショットと比較し、
    抜き挿しやドライブレター変動があればサーバーキャッシュを一斉クリアしてイベントを発行する。
    """
    global _initialized, _last_drives, _event_seq, _last_event

    current_drives = _scan_connected_local_drives()

    with _watcher_lock:
        if not _initialized:
            _last_drives = current_drives
            _initialized = True
            # 初回起動時に接続中メディアのメタデータを温めておく
            for s, d_info in current_drives.items():
                _enrich_media_item(s, d_info, is_online=True)
            return {
                "changed": False,
                "seq": _event_seq,
                "connected_count": len(current_drives),
                "last_event": _last_event,
            }

        prev_serials = set(_last_drives.keys())
        curr_serials = set(current_drives.keys())

        added_serials = sorted(curr_serials - prev_serials)
        removed_serials = sorted(prev_serials - curr_serials)
        # 同じVSNのままマウント先ドライブ文字やボリュームラベルが変わったケース
        changed_serials = sorted(
            s for s in (curr_serials & prev_serials)
            if _last_drives[s].get("drive") != current_drives[s].get("drive")
            or _last_drives[s].get("label") != current_drives[s].get("label")
        )

        if not added_serials and not removed_serials and not changed_serials:
            return {
                "changed": False,
                "seq": _event_seq,
                "connected_count": len(current_drives),
                "last_event": _last_event,
            }

        prev_snapshot = dict(_last_drives)
        _last_drives = current_drives

    # 抜き挿し・変化を検出した瞬間にサーバー内のオンライン判定・FS・写真一覧・Loomeルートキャッシュを全パージ
    from .storage_manager import invalidate_loome_roots_cache

    clear_online_cache()
    clear_folders_fs_cache()
    invalidate_loome_roots_cache()

    added_items = [_enrich_media_item(s, current_drives.get(s), is_online=True) for s in added_serials]
    removed_items = [_enrich_media_item(s, prev_snapshot.get(s), is_online=False) for s in removed_serials]
    changed_items = [_enrich_media_item(s, current_drives.get(s), is_online=True) for s in changed_serials]

    # DB上のドライブ文字更新が行われた可能性があるため再度キャッシュクリア
    clear_online_cache()
    clear_folders_fs_cache()
    invalidate_loome_roots_cache()

    with _watcher_lock:
        _event_seq += 1
        seq = _event_seq
        event_payload: Dict[str, Any] = {
            "seq": seq,
            "timestamp": time.time(),
            "source": source,
            "added": added_items,
            "removed": removed_items,
            "changed": changed_items,
            "connected_drives": list(current_drives.values()),
        }
        _last_event = event_payload

    logger.info(
        f"[MediaWatcher] メディア変化を検知 (seq={seq}, source={source}): "
        f"added={[x['display_name'] for x in added_items]}, "
        f"removed={[x['display_name'] for x in removed_items]}, "
        f"changed={[x['display_name'] for x in changed_items]}"
    )

    _broadcast_event(event_payload)
    return {
        "changed": True,
        "seq": seq,
        "connected_count": len(current_drives),
        "event": event_payload,
        "last_event": _last_event,
    }


def get_media_watcher_state() -> Dict[str, Any]:
    """現在のメディア監視シーケンス番号と直近のイベント情報を返す"""
    if not _initialized:
        check_media_changes(source="init")
    with _watcher_lock:
        return {
            "seq": _event_seq,
            "connected_drives": list(_last_drives.values()),
            "last_event": _last_event,
        }


def subscribe_media_events() -> Tuple[asyncio.AbstractEventLoop, "asyncio.Queue[Dict[str, Any]]"]:
    """SSE配信用にイベントキューを購読登録する"""
    loop = asyncio.get_running_loop()
    q: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=32)
    with _subscribers_lock:
        _subscribers.add((loop, q))
    return loop, q


def unsubscribe_media_events(sub: Tuple[asyncio.AbstractEventLoop, "asyncio.Queue[Dict[str, Any]]"]) -> None:
    """SSE切断時にイベントキューの購読を解除する"""
    with _subscribers_lock:
        _subscribers.discard(sub)


def _trigger_delayed_probes(source: str = "wm_devicechange") -> None:
    """
    OSから WM_DEVICECHANGE を受信した際、マウント直後のボリューム情報確定ラグを吸収するため、
    0.15秒後・0.8秒後・2.0秒後の計3回に分けて軽量チェックを実行する。
    """
    global _probe_running, _probe_last_trigger_ts
    now = time.monotonic()
    with _probe_Schedule_lock:
        _probe_last_trigger_ts = now
        if _probe_running:
            return
        _probe_running = True

    def _worker():
        global _probe_running
        try:
            for delay in (0.15, 0.65, 1.2):
                time.sleep(delay)
                try:
                    check_media_changes(source=source)
                except Exception as e:
                    logger.debug(f"遅延メディアチェック失敗: {e}")
        finally:
            with _probe_Schedule_lock:
                _probe_running = False

    threading.Thread(target=_worker, daemon=True, name="MediaProbeWorker").start()


def _win32_message_loop() -> None:
    """
    Windows OS の WM_DEVICECHANGE ブロードキャストを受信するための非表示トップレベルウィンドウを作成し、
    GetMessageW でイベント駆動待機する（待機中のCPU負荷は完全に0%）。
    """
    if sys.platform != "win32":
        return

    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        LRESULT = ctypes.c_ssize_t
        WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

        kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        kernel32.GetModuleHandleW.restype = wintypes.HMODULE

        user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.DefWindowProcW.restype = LRESULT

        user32.RegisterClassExW.argtypes = [ctypes.c_void_p]
        user32.RegisterClassExW.restype = wintypes.ATOM

        user32.CreateWindowExW.argtypes = [
            wintypes.DWORD,
            wintypes.LPCWSTR,
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HWND,
            wintypes.HMENU,
            wintypes.HINSTANCE,
            wintypes.LPVOID,
        ]
        user32.CreateWindowExW.restype = wintypes.HWND

        user32.GetMessageW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.UINT]
        user32.GetMessageW.restype = wintypes.BOOL
        user32.TranslateMessage.argtypes = [ctypes.c_void_p]
        user32.DispatchMessageW.argtypes = [ctypes.c_void_p]

        class WNDCLASSEXW(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.UINT),
                ("style", wintypes.UINT),
                ("lpfnWndProc", WNDPROC),
                ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int),
                ("hInstance", wintypes.HINSTANCE),
                ("hIcon", wintypes.HANDLE),
                ("hCursor", wintypes.HANDLE),
                ("hbrBackground", wintypes.HANDLE),
                ("lpszMenuName", wintypes.LPCWSTR),
                ("lpszClassName", wintypes.LPCWSTR),
                ("hIconSm", wintypes.HANDLE),
            ]

        def _wnd_proc(hwnd, msg, wparam, lparam):
            if msg == WM_DEVICECHANGE:
                if wparam in (DBT_DEVICEARRIVAL, DBT_DEVICEREMOVECOMPLETE, DBT_DEVNODES_CHANGED):
                    _trigger_delayed_probes(source="wm_devicechange")
                return 1
            if msg == WM_DESTROY:
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        # ガベージコレクション防止のため参照をローカル変数に保持
        wnd_proc_cb = WNDPROC(_wnd_proc)
        hinst = kernel32.GetModuleHandleW(None)
        class_name = f"TetheractMediaWatcher_{id(wnd_proc_cb)}"

        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.style = 0
        wc.lpfnWndProc = wnd_proc_cb
        wc.cbClsExtra = 0
        wc.cbWndExtra = 0
        wc.hInstance = hinst
        wc.hIcon = None
        wc.hCursor = None
        wc.hbrBackground = None
        wc.lpszMenuName = None
        wc.lpszClassName = class_name
        wc.hIconSm = None

        atom = user32.RegisterClassExW(ctypes.byref(wc))
        if not atom:
            logger.warning("MediaWatcher: RegisterClassExW に失敗しました")
            return

        # WM_DEVICECHANGE ブロードキャストを受け取るため非表示のトップレベルウィンドウを作成する
        hwnd = user32.CreateWindowExW(
            0,
            class_name,
            "TetheractMediaWatcherWindow",
            0,
            0, 0, 0, 0,
            None,
            None,
            hinst,
            None,
        )
        if not hwnd:
            logger.warning("MediaWatcher: CreateWindowExW に失敗しました")
            return

        logger.info("[MediaWatcher] Windows WM_DEVICECHANGE イベント監視を開始しました")

        msg = wintypes.MSG()
        while True:
            ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if ret <= 0:
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    except Exception as e:
        logger.warning(f"[MediaWatcher] WM_DEVICECHANGE 監視スレッド例外: {e}")


def start_media_watcher() -> None:
    """
    初期ドライブスナップショットを記録し、バックグラウンドの WM_DEVICECHANGE 監視スレッドを起動する。
    """
    global _watcher_thread
    try:
        check_media_changes(source="startup")
    except Exception as e:
        logger.debug(f"MediaWatcher 初期スナップショット取得スキップ: {e}")

    if sys.platform != "win32":
        return

    with _watcher_lock:
        if _watcher_thread is not None and _watcher_thread.is_alive():
            return
        _watcher_thread = threading.Thread(
            target=_win32_message_loop,
            daemon=True,
            name="Win32MediaWatcher",
        )
        _watcher_thread.start()
