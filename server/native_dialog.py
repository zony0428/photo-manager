"""
Windows ネイティブ ファイル／フォルダ選択ダイアログモジュール

責務:
- 外部パッケージ非依存（標準 ctypes の COM IFileOpenDialog）でエクスプローラー型ダイアログを起動する
- 呼び出し元のアプリウィンドウ中央に WS_EX_TOPMOST オーナーウィンドウを生成し、確実に最前面表示する
- _DIALOG_LOCK により多重起動を防止し、待機中の再クリック時は既存ダイアログを最前面へ引き上げる
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

logger = logging.getLogger(__name__)

_DIALOG_LOCK = threading.Lock()
_OWNER_CLASS = "STATIC"
_OWNER_TITLE = "TetheractDialogOwner"


def _resolve_python_exe() -> str:
    """pythonw.exe 起動時でも標準入出力を扱える python.exe を優先解決する"""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        cand = exe.with_name("python.exe")
        if cand.exists():
            return str(cand)
    return str(exe)


def _bring_existing_dialog_to_front() -> None:
    """すでに表示中のダイアログがあれば前面へ引き上げる"""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
        user32.FindWindowW.restype = wintypes.HWND
        user32.GetLastActivePopup.argtypes = [wintypes.HWND]
        user32.GetLastActivePopup.restype = wintypes.HWND

        owner_hwnd = user32.FindWindowW(_OWNER_CLASS, _OWNER_TITLE)
        if owner_hwnd:
            target = user32.GetLastActivePopup(owner_hwnd) or owner_hwnd
            if user32.IsIconic(target):
                user32.ShowWindow(target, 9)  # SW_RESTORE
            user32.SetWindowPos(target, wintypes.HWND(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
            user32.SetWindowPos(target, wintypes.HWND(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
            user32.SetForegroundWindow(target)
    except Exception as e:
        logger.debug(f"既存ダイアログ前面化スキップ: {e}")


def _get_target_monitor_center() -> Tuple[int, int]:
    """アプリウィンドウ（なければアクティブウィンドウ）が属するモニタの中央座標を返す"""
    if sys.platform != "win32":
        return (400, 300)
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        target_hwnd = None
        try:
            from server.window_utils import _find_photo_manager_hwnds

            hwnds = _find_photo_manager_hwnds()
            if hwnds:
                target_hwnd = hwnds[0]
        except Exception as e:
            logger.debug(f"アプリHWND取得スキップ: {e}")

        if not target_hwnd:
            target_hwnd = user32.GetForegroundWindow()

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
            ]

        if target_hwnd:
            hmon = user32.MonitorFromWindow(target_hwnd, 2)  # MONITOR_DEFAULTTONEAREST
            if hmon:
                mi = MONITORINFO()
                mi.cbSize = ctypes.sizeof(MONITORINFO)
                if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                    rc = mi.rcWork
                    return ((rc.left + rc.right) // 2, (rc.top + rc.bottom) // 2)

        cx = max(320, int(user32.GetSystemMetrics(0)) // 2)
        cy = max(240, int(user32.GetSystemMetrics(1)) // 2)
        return (cx, cy)
    except Exception as e:
        logger.debug(f"モニタ中央取得フォールバック: {e}")
        return (400, 300)


def _force_foreground_hwnd(hwnd: int) -> None:
    """オーナーウィンドウへフォアグラウンド権限を一時結合し、確実に最前面化する"""
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        HWND_TOPMOST = wintypes.HWND(-1)
        SWP_NOMOVE = 0x0002
        SWP_NOSIZE = 0x0001
        SWP_SHOWWINDOW = 0x0040

        fg = user32.GetForegroundWindow()
        cur_tid = kernel32.GetCurrentThreadId()
        fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        attached = False
        if fg_tid and fg_tid != cur_tid:
            attached = bool(user32.AttachThreadInput(fg_tid, cur_tid, True))
        try:
            user32.ShowWindow(hwnd, 5)  # SW_SHOW
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(fg_tid, cur_tid, False)
    except Exception as e:
        logger.debug(f"オーナーHWND前面化スキップ: {e}")


def _run_com_dialog_worker(payload: Dict[str, Any], dry_run: bool = False) -> Dict[str, Any]:
    """
    STA スレッド上で COM IFileOpenDialog を構築・実行するワーカー。
    dry_run=True の場合は Show() を呼ばず、COM・TopMost HWND 生成と解放のみ検証する。
    """
    if sys.platform != "win32":
        return {"ok": False, "cancelled": False, "path": None, "error": "Windows専用機能です"}

    import ctypes
    from ctypes import wintypes

    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32
    user32 = ctypes.windll.user32

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_ulong),
            ("Data2", ctypes.c_ushort),
            ("Data3", ctypes.c_ushort),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    class COMDLG_FILTERSPEC(ctypes.Structure):
        _fields_ = [("pszName", wintypes.LPCWSTR), ("pszSpec", wintypes.LPCWSTR)]

    CLSID_FileOpenDialog = GUID(
        0xDC1C5A9C, 0xE88A, 0x4DDE, (ctypes.c_ubyte * 8)(0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7)
    )
    IID_IFileOpenDialog = GUID(
        0xD57C7288, 0xD4AD, 0x4768, (ctypes.c_ubyte * 8)(0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60)
    )
    IID_IShellItem = GUID(
        0x43826D1E, 0xE718, 0x42EE, (ctypes.c_ubyte * 8)(0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE)
    )

    COINIT_APARTMENTTHREADED = 0x2
    CLSCTX_INPROC_SERVER = 0x1
    FOS_PICKFOLDERS = 0x00000020
    FOS_FORCEFILESYSTEM = 0x00000040
    FOS_PATHMUSTEXIST = 0x00000800
    FOS_FILEMUSTEXIST = 0x00001000
    SIGDN_FILESYSPATH = 0x80058000
    ERROR_CANCELLED_HR = 0x800704C7

    mode = str(payload.get("mode") or "folder")
    title = str(payload.get("title") or "選択してください")
    initial_dir = payload.get("initial_dir")
    filter_name = str(payload.get("filter_name") or "すべてのファイル (*.*)")
    filter_spec = str(payload.get("filter_spec") or "*.*")

    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoCreateInstance.argtypes = [
        ctypes.POINTER(GUID),
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    ole32.CoCreateInstance.restype = ctypes.c_long
    ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    shell32.SHCreateItemFromParsingName.argtypes = [
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    shell32.SHCreateItemFromParsingName.restype = ctypes.c_long
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
    user32.DestroyWindow.argtypes = [wintypes.HWND]

    hr_init = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
    com_inited = hr_init in (0, 1)  # S_OK / S_FALSE
    dlg = ctypes.c_void_p()
    owner_hwnd = None
    init_item = ctypes.c_void_p()
    res_item = ctypes.c_void_p()

    try:
        hr_cls = ole32.CoCreateInstance(
            ctypes.byref(CLSID_FileOpenDialog),
            None,
            CLSCTX_INPROC_SERVER,
            ctypes.byref(IID_IFileOpenDialog),
            ctypes.byref(dlg),
        )
        if hr_cls != 0 or not dlg.value:
            return {"ok": False, "cancelled": False, "path": None, "error": f"CoCreateInstance失敗: 0x{hr_cls & 0xFFFFFFFF:08X}"}

        vtbl = ctypes.cast(ctypes.cast(dlg, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        fn_release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])
        fn_show = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wintypes.HWND)(vtbl[3])
        fn_set_file_types = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(COMDLG_FILTERSPEC))(vtbl[4])
        fn_set_options = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_uint)(vtbl[9])
        fn_get_options = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint))(vtbl[10])
        fn_set_folder = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)(vtbl[12])
        fn_set_title = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wintypes.LPCWSTR)(vtbl[17])
        fn_get_result = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(vtbl[20])

        opts = ctypes.c_uint(0)
        if fn_get_options(dlg, ctypes.byref(opts)) == 0:
            flags = opts.value | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
            if mode == "folder":
                flags |= FOS_PICKFOLDERS
            else:
                flags |= FOS_FILEMUSTEXIST
            fn_set_options(dlg, flags)

        fn_set_title(dlg, title)

        if mode == "file" and filter_spec:
            spec = COMDLG_FILTERSPEC(filter_name, filter_spec)
            fn_set_file_types(dlg, 1, ctypes.byref(spec))

        if initial_dir and str(initial_dir).strip():
            cand = Path(str(initial_dir).strip())
            if cand.is_file():
                cand = cand.parent
            if cand.exists() and cand.is_dir():
                hr_item = shell32.SHCreateItemFromParsingName(
                    str(cand.resolve()), None, ctypes.byref(IID_IShellItem), ctypes.byref(init_item)
                )
                if hr_item == 0 and init_item.value:
                    fn_set_folder(dlg, init_item)

        cx, cy = _get_target_monitor_center()
        # WS_EX_TOPMOST (0x8) | WS_EX_TOOLWINDOW (0x80), WS_POPUP (0x80000000)
        owner_hwnd = user32.CreateWindowExW(
            0x00000088, _OWNER_CLASS, _OWNER_TITLE, 0x80000000, cx, cy, 1, 1, None, None, None, None
        )

        if dry_run:
            return {"ok": True, "cancelled": False, "path": None, "dry_run": True}

        if owner_hwnd:
            _force_foreground_hwnd(owner_hwnd)

        hr_show = fn_show(dlg, owner_hwnd)
        if (hr_show & 0xFFFFFFFF) == ERROR_CANCELLED_HR:
            return {"ok": True, "cancelled": True, "path": None}
        if hr_show != 0:
            return {"ok": False, "cancelled": False, "path": None, "error": f"Show失敗: 0x{hr_show & 0xFFFFFFFF:08X}"}

        hr_res = fn_get_result(dlg, ctypes.byref(res_item))
        if hr_res != 0 or not res_item.value:
            return {"ok": False, "cancelled": False, "path": None, "error": f"GetResult失敗: 0x{hr_res & 0xFFFFFFFF:08X}"}

        item_vtbl = ctypes.cast(ctypes.cast(res_item, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        fn_get_name = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p))(item_vtbl[5])
        psz_path = ctypes.c_void_p()
        hr_name = fn_get_name(res_item, SIGDN_FILESYSPATH, ctypes.byref(psz_path))
        if hr_name != 0 or not psz_path.value:
            return {"ok": False, "cancelled": False, "path": None, "error": f"GetDisplayName失敗: 0x{hr_name & 0xFFFFFFFF:08X}"}

        try:
            selected_path = ctypes.wstring_at(psz_path.value)
        finally:
            ole32.CoTaskMemFree(psz_path)

        return {"ok": True, "cancelled": False, "path": selected_path}
    except Exception as e:
        return {"ok": False, "cancelled": False, "path": None, "error": str(e)}
    finally:
        for shell_ptr in (res_item, init_item):
            if shell_ptr.value:
                try:
                    vt = ctypes.cast(ctypes.cast(shell_ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vt[2])(shell_ptr)
                except Exception:
                    pass
        if dlg.value:
            try:
                vt = ctypes.cast(ctypes.cast(dlg, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vt[2])(dlg)
            except Exception:
                pass
        if owner_hwnd:
            try:
                user32.DestroyWindow(owner_hwnd)
            except Exception:
                pass
        if com_inited:
            try:
                ole32.CoUninitialize()
            except Exception:
                pass


def _pick_via_powershell_fallback(
    mode: str,
    initial_dir: Optional[str],
    title: str,
    filter_name: str,
    filter_spec: str,
) -> Optional[str]:
    """COMダイアログ失敗時の UTF-8 + TopMost PowerShell フォールバック"""
    init_path = ""
    if initial_dir and str(initial_dir).strip():
        cand = Path(str(initial_dir).strip())
        if cand.is_file():
            cand = cand.parent
        if cand.exists() and cand.is_dir():
            init_path = str(cand.resolve())

    if mode == "file":
        ps_script = """
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.ShowInTaskbar = $false
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:PM_DIALOG_TITLE
$dialog.Filter = "$($env:PM_DIALOG_FILTER_NAME)|$($env:PM_DIALOG_FILTER_SPEC)"
if ($env:PM_DIALOG_INIT_DIR -and (Test-Path -LiteralPath $env:PM_DIALOG_INIT_DIR)) {
    $dialog.InitialDirectory = $env:PM_DIALOG_INIT_DIR
}
$res = $dialog.ShowDialog($owner)
$owner.Dispose()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.FileName
}
"""
    else:
        ps_script = """
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.ShowInTaskbar = $false
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:PM_DIALOG_TITLE
$dialog.ShowNewFolderButton = $true
if ($env:PM_DIALOG_INIT_DIR -and (Test-Path -LiteralPath $env:PM_DIALOG_INIT_DIR)) {
    $dialog.SelectedPath = $env:PM_DIALOG_INIT_DIR
}
$res = $dialog.ShowDialog($owner)
$owner.Dispose()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
}
"""

    try:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        env = os.environ.copy()
        env["PM_DIALOG_INIT_DIR"] = init_path
        env["PM_DIALOG_TITLE"] = title
        env["PM_DIALOG_FILTER_NAME"] = filter_name
        env["PM_DIALOG_FILTER_SPEC"] = filter_spec

        proc = subprocess.run(
            ["powershell", "-Sta", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            creationflags=creationflags,
            timeout=300,
        )
        selected = proc.stdout.strip()
        if not selected:
            return None
        p = Path(selected)
        if mode == "folder" and p.is_dir():
            return str(p)
        if mode == "file" and p.is_file():
            return str(p)
        return None
    except Exception as e:
        logger.warning(f"PowerShellフォールバックダイアログ失敗: {e}")
        return None


def _invoke_dialog_subprocess(payload: Dict[str, Any]) -> Dict[str, Any]:
    """独立した子プロセスの STA スレッドで COM ダイアログを実行する"""
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    cmd = [_resolve_python_exe(), "-X", "utf8", "-m", "server.native_dialog"]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(_PROJECT_ROOT),
        creationflags=creationflags,
    )
    try:
        stdout_data, stderr_data = proc.communicate(input=json.dumps(payload, ensure_ascii=False), timeout=300)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        return {"ok": False, "cancelled": False, "path": None, "error": "ダイアログ操作がタイムアウトしました"}

    raw_out = (stdout_data or "").strip().splitlines()
    for line in reversed(raw_out):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except Exception as e:
                logger.warning(f"ダイアログJSON解析失敗: {e}")
    return {
        "ok": False,
        "cancelled": False,
        "path": None,
        "error": (stderr_data or "").strip() or f"ダイアログ終了コード {proc.returncode}",
    }


def _pick_with_guard(payload: Dict[str, Any]) -> Optional[str]:
    """多重起動ロック付きでネイティブダイアログを起動し、失敗時はPowerShell版へフォールバックする"""
    if not _DIALOG_LOCK.acquire(blocking=False):
        _bring_existing_dialog_to_front()
        return None

    mode = str(payload.get("mode") or "folder")
    try:
        res = _invoke_dialog_subprocess(payload)
        if res.get("ok"):
            if res.get("cancelled") or not res.get("path"):
                return None
            p = Path(str(res["path"]))
            if mode == "folder" and p.is_dir():
                return str(p)
            if mode == "file" and p.is_file():
                return str(p)
            return None

        logger.warning(f"COMダイアログ失敗のためPowerShellフォールバックを実行: {res.get('error')}")
        return _pick_via_powershell_fallback(
            mode=mode,
            initial_dir=payload.get("initial_dir"),
            title=str(payload.get("title") or "選択してください"),
            filter_name=str(payload.get("filter_name") or "すべてのファイル (*.*)"),
            filter_spec=str(payload.get("filter_spec") or "*.*"),
        )
    except Exception as e:
        logger.warning(f"ネイティブダイアログ呼び出し例外: {e}")
        return None
    finally:
        _DIALOG_LOCK.release()


def pick_native_folder_dialog(
    initial_dir: Optional[str] = None,
    title: str = "エクスポート先フォルダを選択してください",
) -> Optional[str]:
    """Windows エクスプローラー型フォルダ選択ダイアログを最前面表示し、選択パスを返す"""
    return _pick_with_guard({
        "mode": "folder",
        "initial_dir": initial_dir,
        "title": title,
    })


def pick_native_file_dialog(
    initial_dir: Optional[str] = None,
    title: str = "ファイルを選択してください",
    filter_name: str = "すべてのファイル (*.*)",
    filter_spec: str = "*.*",
) -> Optional[str]:
    """Windows エクスプローラー型ファイル選択ダイアログを最前面表示し、選択パスを返す"""
    return _pick_with_guard({
        "mode": "file",
        "initial_dir": initial_dir,
        "title": title,
        "filter_name": filter_name,
        "filter_spec": filter_spec,
    })


if __name__ == "__main__":
    raw_stdin = sys.stdin.read()
    try:
        req_payload = json.loads(raw_stdin) if raw_stdin.strip() else {}
    except Exception as parse_err:
        req_payload = {}
        print(json.dumps({"ok": False, "cancelled": False, "path": None, "error": str(parse_err)}, ensure_ascii=False))
        sys.exit(1)

    result = _run_com_dialog_worker(req_payload, dry_run=False)
    print(json.dumps(result, ensure_ascii=False))
