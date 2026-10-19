"""
フォルダツリー（左ペイン「フォルダ」タブ）用データ生成モジュール
実ファイルシステムのドライブ・フォルダと DB の管理状態（写真枚数・スキャンルート・除外設定）を突き合わせ、
遅延展開用のノード情報を返す。
"""

import os
import string
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from .database import (
    SYSTEM_IGNORE_NAMES,
    get_directory_counts_under,
    get_drive_photo_counts,
    get_ignored_folders,
    get_scan_roots,
)
from .database.folders import normalize_folder_path
from .volume_info import get_volume_info_for_drive

# GetDriveTypeW の戻り値
_DRIVE_NO_ROOT_DIR = 1
_DRIVE_REMOVABLE = 2
_DRIVE_FIXED = 3
_DRIVE_REMOTE = 4
_DRIVE_CDROM = 5
_DRIVE_RAMDISK = 6

_DRIVE_TYPE_NAMES = {
    _DRIVE_REMOVABLE: "removable",
    _DRIVE_FIXED: "fixed",
    _DRIVE_REMOTE: "network",
    _DRIVE_CDROM: "cdrom",
    _DRIVE_RAMDISK: "ramdisk",
}

# Windows ファイル属性（隠し・システム）
_FILE_ATTRIBUTE_HIDDEN = 0x2
_FILE_ATTRIBUTE_SYSTEM = 0x4

# has_children 判定（子フォルダの軽量走査）に使う時間予算（秒）。超過分は「子あり」とみなす
_HAS_CHILDREN_BUDGET_SEC = 1.0
# 子フォルダがこの件数を超える場合は has_children 判定を行わず「子あり」とみなす
_HAS_CHILDREN_MAX_ENTRIES = 300


def _key(path: str) -> str:
    """比較用の正規化キー（大文字小文字無視・末尾区切りなし）を返す"""
    return normalize_folder_path(path).rstrip("\\/").lower()


def _is_under(child_key: str, ancestor_key: str) -> bool:
    """child_key が ancestor_key 自身または配下であるか判定する（どちらも _key 済み）"""
    return child_key == ancestor_key or child_key.startswith(ancestor_key + "\\")


def _is_visible_dir_entry(entry: "os.DirEntry") -> bool:
    """ツリーに表示すべきフォルダか判定する（隠し・システム属性、ドット/$始まり、システム除外名を除く）"""
    try:
        if not entry.is_dir():
            return False
        name_lower = entry.name.lower()
        if name_lower.startswith(".") or name_lower.startswith("$") or name_lower in SYSTEM_IGNORE_NAMES:
            return False
        attrs = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
        if attrs & (_FILE_ATTRIBUTE_HIDDEN | _FILE_ATTRIBUTE_SYSTEM):
            return False
        return True
    except Exception as e:
        print(f"[WARN] フォルダ判定をスキップしました ({entry.path}): {e}")
        return False


def _list_fs_subdirs(path: str) -> Optional[List[Tuple[str, str]]]:
    """実フォルダ直下の表示対象サブフォルダ (name, full_path) 一覧を返す。フォルダが開けない場合は None"""
    if not os.path.isdir(path):
        return None
    result: List[Tuple[str, str]] = []
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                if _is_visible_dir_entry(entry):
                    result.append((entry.name, entry.path))
    except Exception as e:
        print(f"[WARN] フォルダ一覧の取得に失敗しました ({path}): {e}")
        return None
    return result


def _has_visible_subdir(path: str) -> bool:
    """表示対象のサブフォルダを1つでも持つか判定する（最初の1件で打ち切り）"""
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                if _is_visible_dir_entry(entry):
                    return True
    except Exception as e:
        print(f"[WARN] サブフォルダ有無の判定に失敗しました ({path}): {e}")
    return False


def _list_connected_drives() -> List[Dict[str, Any]]:
    """
    接続中のドライブ一覧を返す（Windows のみ）。
    ネットワークドライブは切断時に GetVolumeInformation がブロックするため呼ばない。
    メディア未挿入のリムーバブル/光学ドライブはボリューム情報が取れないため除外する。
    """
    if sys.platform != "win32":
        return []
    import ctypes

    kernel32 = ctypes.windll.kernel32
    # 「ディスクがありません」ダイアログを抑止（SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX）
    old_mode = ctypes.c_uint(0)
    try:
        kernel32.SetThreadErrorMode(0x0001 | 0x8000, ctypes.byref(old_mode))
    except Exception as e:
        print(f"[WARN] エラーモード設定に失敗しました: {e}")

    drives: List[Dict[str, Any]] = []
    try:
        mask = kernel32.GetLogicalDrives()
        for i, letter in enumerate(string.ascii_uppercase):
            if not mask & (1 << i):
                continue
            root = f"{letter}:\\"
            drive_type = kernel32.GetDriveTypeW(ctypes.c_wchar_p(root))
            if drive_type <= _DRIVE_NO_ROOT_DIR:
                continue
            serial = None
            label = ""
            if drive_type != _DRIVE_REMOTE:
                info = get_volume_info_for_drive(letter)
                if info is None:
                    continue
                serial = info.get("serial")
                label = info.get("label") or ""
            drives.append({
                "letter": f"{letter}:",
                "path": root,
                "drive_type": _DRIVE_TYPE_NAMES.get(drive_type, "unknown"),
                "volume_serial": serial,
                "label": label,
            })
    finally:
        try:
            kernel32.SetThreadErrorMode(old_mode.value, None)
        except Exception as e:
            print(f"[WARN] エラーモード復元に失敗しました: {e}")
    return drives


def _has_scan_root_under(path_key: str, scan_root_keys: List[str]) -> bool:
    """指定パス配下（自身含む）にスキャンルートが登録されているか判定する"""
    return any(_is_under(r, path_key) for r in scan_root_keys)


def build_roots(quick_access: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    ツリー最上位のノード群を返す。
    shortcuts: ピクチャ/ドキュメント/デスクトップ、drives: 接続中ドライブ、
    offline_volumes: DB にのみ写真が残る未接続ボリューム（ドライブ文字が無い、またはシリアル不一致）。
    """
    scan_root_keys = [_key(r) for r in get_scan_roots()]

    # ショートカット（配下の写真総数は都度集計）
    shortcuts: List[Dict[str, Any]] = []
    for item in quick_access:
        if item.get("key") not in ("pictures", "documents", "desktop"):
            continue
        path = normalize_folder_path(item["path"])
        total = sum(r["count"] for r in get_directory_counts_under(path))
        shortcuts.append({
            "key": item["key"],
            "name": item["name"],
            "icon": item.get("icon", "📁"),
            "path": path,
            "total": total,
            "has_managed": total > 0 or _has_scan_root_under(_key(path), scan_root_keys),
        })
    # 表示順を固定（ピクチャ → ドキュメント → デスクトップ）
    order = {"pictures": 0, "documents": 1, "desktop": 2}
    shortcuts.sort(key=lambda s: order.get(s["key"], 9))

    connected = _list_connected_drives()
    connected_by_letter = {d["letter"]: d for d in connected}
    count_rows = get_drive_photo_counts()

    # 接続中ドライブの写真数（シリアル一致またはシリアル未記録。ネットワークは文字一致のみ）
    drives: List[Dict[str, Any]] = []
    for d in connected:
        serial = d["volume_serial"]
        total = 0
        for r in count_rows:
            if r["drive"] != d["letter"]:
                continue
            if serial is None or r["volume_serial"] is None or r["volume_serial"] == serial:
                total += r["count"]
        drives.append({
            **d,
            "name": f"{d['letter']} ({d['label']})" if d["label"] else d["letter"],
            "total": total,
            "has_managed": total > 0 or _has_scan_root_under(_key(d["path"]), scan_root_keys),
            # 子ノード取得時のボリューム絞り込み条件
            "serial_mode": "match_or_null" if serial else "any",
        })

    # 未接続ボリューム（シリアルごとにまとめる。シリアル未記録はドライブ文字ごと）
    offline_map: Dict[str, Dict[str, Any]] = {}
    for r in count_rows:
        letter = r["drive"]
        serial = r["volume_serial"]
        conn_drive = connected_by_letter.get(letter)
        if conn_drive is not None:
            conn_serial = conn_drive["volume_serial"]
            # 同じドライブ文字で接続中のボリュームと一致（またはシリアル不明）なら接続中扱い
            if conn_serial is None or serial is None or serial == conn_serial:
                continue
        group_key = f"serial:{serial}" if serial else f"drive:{letter}"
        group = offline_map.get(group_key)
        if group is None:
            group = {
                "key": group_key,
                "letter": letter,
                "path": f"{letter}\\",
                "volume_serial": serial,
                "label": r.get("volume_label") or "",
                "total": 0,
                "has_managed": True,
                "is_offline": True,
                "serial_mode": "match" if serial else "null",
            }
            offline_map[group_key] = group
        group["total"] += r["count"]

    offline_volumes = list(offline_map.values())
    for v in offline_volumes:
        v["name"] = f"{v['label']} ({v['letter']})" if v["label"] else v["letter"]
    offline_volumes.sort(key=lambda v: (v["letter"], v["label"]))

    return {"shortcuts": shortcuts, "drives": drives, "offline_volumes": offline_volumes}


def list_children(
    path: str,
    volume_serial: Optional[str] = None,
    serial_mode: str = "any",
    offline: bool = False,
) -> Dict[str, Any]:
    """
    指定フォルダ直下の子フォルダ一覧を、管理状態と写真枚数付きで返す。
    実フォルダの子に加え、DB にのみ存在する子（消失・未接続）も is_missing として含める。
    offline=True または実フォルダが存在しない場合は DB の情報だけで組み立てる。
    """
    parent = normalize_folder_path(path)
    base = parent.rstrip("\\/")
    base_key = base.lower()

    scan_root_keys = [_key(r) for r in get_scan_roots()]
    ignored_keys = [_key(p) for p in get_ignored_folders()]

    # 1. DB 集計（配下全ディレクトリの枚数を1クエリで取得し、直下の子ごとに合算）
    db_children: Dict[str, Dict[str, Any]] = {}
    parent_direct = 0
    for row in get_directory_counts_under(parent, volume_serial=volume_serial, serial_mode=serial_mode):
        d = normalize_folder_path(row["directory_path"]).rstrip("\\/")
        d_key = d.lower()
        if d_key == base_key:
            parent_direct += row["count"]
            continue
        if not d_key.startswith(base_key + "\\"):
            continue
        rel = d[len(base) + 1:]
        first = rel.split("\\", 1)[0]
        if not first:
            continue
        entry = db_children.setdefault(first.lower(), {"name": first, "total": 0, "count": 0, "deeper": False})
        entry["total"] += row["count"]
        if rel == first:
            entry["count"] += row["count"]
        else:
            entry["deeper"] = True

    # 2. 実フォルダの子
    fs_subdirs = None if offline else _list_fs_subdirs(parent)
    parent_exists = fs_subdirs is not None

    children: Dict[str, Dict[str, Any]] = {}
    for name, _full in (fs_subdirs or []):
        children[name.lower()] = {"name": name, "in_fs": True}
    for name_key, info in db_children.items():
        node = children.setdefault(name_key, {"name": info["name"], "in_fs": False})
        node["db"] = info

    # 3. ノード情報の組み立て
    check_children = parent_exists and len(children) <= _HAS_CHILDREN_MAX_ENTRIES
    deadline = time.monotonic() + _HAS_CHILDREN_BUDGET_SEC
    result: List[Dict[str, Any]] = []
    for node in children.values():
        child_path = f"{base}\\{node['name']}"
        child_key = child_path.lower()
        db_info = node.get("db") or {"total": 0, "count": 0, "deeper": False}

        if any(_is_under(child_key, ig) for ig in ignored_keys):
            status = "ignored"
        elif db_info["count"] > 0 or child_key in scan_root_keys:
            status = "managed"
        else:
            status = "unmanaged"

        if db_info["deeper"]:
            has_children = True
        elif not node["in_fs"]:
            has_children = False
        elif check_children and time.monotonic() < deadline:
            has_children = _has_visible_subdir(child_path)
        else:
            has_children = True

        result.append({
            "name": node["name"],
            "path": child_path,
            "status": status,
            "count": db_info["count"],
            "total": db_info["total"],
            "has_managed": db_info["total"] > 0 or _has_scan_root_under(child_key, scan_root_keys),
            "has_children": has_children,
            # 親フォルダは存在するのに実フォルダが無い = 消失（親自体が無い場合は未接続扱いで消失とはしない）
            "is_missing": parent_exists and not node["in_fs"],
        })

    result.sort(key=lambda c: c["name"].lower())
    return {
        "path": parent,
        "exists": parent_exists,
        "direct_count": parent_direct,
        "children": result,
    }
