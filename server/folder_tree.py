"""
フォルダツリー（左ペイン「フォルダ」タブ）用データ生成モジュール
実ファイルシステムのドライブ・フォルダと DB の管理状態（写真枚数・スキャンルート・除外設定）を突き合わせ、
遅延展開用のノード情報を返す。
"""

import os
from pathlib import Path
import string
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from .database import (
    SYSTEM_IGNORE_NAMES,
    get_all_volumes,
    get_directory_counts_under,
    get_drive_photo_counts,
    get_ignored_folders,
    get_scan_roots,
)
from .database.folders import _natural_sort_key, normalize_folder_path
from .storage_manager import get_all_loome_roots, is_loome_root_path, is_path_in_storage
from .volume_info import get_volume_info_for_drive
from .security import inspect_drive_loome_ownership

BASE_DIR = Path(__file__).resolve().parent.parent

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


def _format_vsn_short(serial: Optional[str]) -> str:
    """8桁16進のボリュームシリアル番号（例: A1B2C3D4）を XXXX-XXXX 形式に整形する"""
    if not serial:
        return ""
    s = str(serial).strip().upper()
    if len(s) == 8 and all(c in "0123456789ABCDEF" for c in s):
        return f"{s[:4]}-{s[4:]}"
    return s


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


def _format_connected_drive_name(
    letter: str,
    label: str,
    custom_name: str,
    short_serial: str,
    drive_type: str,
) -> str:
    """接続中ドライブの表示名を生成する（カスタム識別名・ボリュームラベル・VSN対応）"""
    if custom_name:
        if label and label != custom_name:
            return f"{letter} [{custom_name}] ({label})"
        return f"{letter} [{custom_name}]"
    if label:
        if drive_type == "removable" and short_serial:
            return f"{letter} ({label}) [ID:{short_serial}]"
        return f"{letter} ({label})"
    if drive_type == "removable" and short_serial:
        return f"{letter} [ID:{short_serial}]"
    return letter


def _format_offline_volume_name(
    letter: str,
    label: str,
    custom_name: str,
    short_serial: str,
) -> str:
    """未接続メディアの表示名を生成する（複数SDカードが全てラベル無し・E:でも一意に識別可能にする）"""
    if custom_name:
        if label and label != custom_name:
            return f"[{custom_name}] {label} ({letter})"
        return f"[{custom_name}] ({letter})"
    if label:
        if short_serial:
            return f"{label} [ID:{short_serial}] ({letter})"
        return f"{label} ({letter})"
    if short_serial:
        return f"メディア [ID:{short_serial}] ({letter})"
    return letter


def build_roots(quick_access: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    ツリー最上位のノード群を返す。
    shortcuts: ピクチャ/ドキュメント/デスクトップ、drives: 接続中ドライブ、
    offline_volumes: DB にのみ写真が残る未接続ボリューム（ドライブ文字が無い、またはシリアル不一致）。
    """
    scan_root_keys = [_key(r) for r in get_scan_roots()]

    # ショートカット（配下の写真総数は都度集計）
    shortcuts: List[Dict[str, Any]] = []
    loome_roots = get_all_loome_roots(force_refresh=True)
    for lr in loome_roots:
        l_path = normalize_folder_path(lr["path"])
        l_vsn = lr.get("volume_serial")
        l_total = sum(r["count"] for r in get_directory_counts_under(l_path, volume_serial=l_vsn))
        shortcuts.append({
            "key": lr["key"],
            "name": lr["name"],
            "icon": "📦",
            "path": l_path,
            "total": l_total,
            "has_managed": True,
            "is_storage": True,
            "is_storage_root": True,
            "is_primary_loome": bool(lr.get("is_primary")),
            "volume_serial": l_vsn,
        })

    quick_items: List[Dict[str, Any]] = []
    for item in quick_access:
        if item.get("key") not in ("pictures", "documents", "desktop"):
            continue
        path = normalize_folder_path(item["path"])
        total = sum(r["count"] for r in get_directory_counts_under(path))
        quick_items.append({
            "key": item["key"],
            "name": item["name"],
            "icon": item.get("icon", "📁"),
            "path": path,
            "total": total,
            "has_managed": total > 0 or _has_scan_root_under(_key(path), scan_root_keys),
        })
    # 表示順を固定（Loome群 → ピクチャ → ドキュメント → デスクトップ）
    order = {"pictures": 0, "documents": 1, "desktop": 2}
    quick_items.sort(key=lambda s: order.get(s["key"], 9))
    shortcuts.extend(quick_items)

    connected = _list_connected_drives()
    connected_by_letter = {d["letter"]: d for d in connected}
    connected_by_serial = {
        str(d["volume_serial"]).upper(): d for d in connected if d.get("volume_serial")
    }
    count_rows = get_drive_photo_counts()
    all_vols = get_all_volumes()
    volumes_by_serial: Dict[str, Dict[str, Any]] = {
        str(v["volume_serial"]).upper(): v for v in all_vols if v.get("volume_serial")
    }

    # 接続中ドライブの写真数（シリアル一致またはシリアル未記録。ドライブ文字が変わった接続中SDカードもVSN一致で追従）
    drives: List[Dict[str, Any]] = []
    for d in connected:
        serial = d["volume_serial"]
        serial_upper = str(serial).upper() if serial else ""
        vol_meta = volumes_by_serial.get(serial_upper) if serial_upper else None
        custom_name = (vol_meta.get("custom_name") or "").strip() if vol_meta else ""
        short_serial = _format_vsn_short(serial)

        total = 0
        other_serial_has_photos = False
        for r in count_rows:
            r_serial = r["volume_serial"]
            r_serial_upper = str(r_serial).upper() if r_serial else ""
            if serial_upper:
                if r_serial_upper == serial_upper:
                    # VSNが一致すれば、前回スキャン時のドライブ文字（例: E:）と現在の文字（例: F:）が異なっても合算
                    total += r["count"]
                    if not custom_name and r.get("custom_name"):
                        custom_name = str(r["custom_name"]).strip()
                elif r_serial is None and r["drive"] == d["letter"]:
                    total += r["count"]
                elif r["drive"] == d["letter"]:
                    other_serial_has_photos = True
            else:
                if r["drive"] == d["letter"]:
                    total += r["count"]
                    if not custom_name and r.get("custom_name"):
                        custom_name = str(r["custom_name"]).strip()

        # 別SDカードのスキャンルートが同じドライブ文字(E:等)に残っている場合、
        # 現在挿さっているSDカードに写真が0枚なら未管理として正しく表示する
        has_scan_root = _has_scan_root_under(_key(d["path"]), scan_root_keys)
        if total > 0:
            has_managed = True
        elif has_scan_root and not other_serial_has_photos:
            has_managed = True
        else:
            has_managed = False

        drives.append({
            **d,
            "custom_name": custom_name,
            "short_serial": short_serial,
            "name": _format_connected_drive_name(
                letter=d["letter"],
                label=d["label"],
                custom_name=custom_name,
                short_serial=short_serial,
                drive_type=d.get("drive_type", ""),
            ),
            "total": total,
            "has_managed": has_managed,
            "loome_enabled": bool(vol_meta and int(vol_meta.get("loome_enabled") or 0)),
            "foreign_loome": (inspect_drive_loome_ownership(d["path"], volume_serial=serial)[0] == "foreign"),
            "foreign_loome_info": (
                inspect_drive_loome_ownership(d["path"], volume_serial=serial)[1]
                if inspect_drive_loome_ownership(d["path"], volume_serial=serial)[0] == "foreign"
                else None
            ),
            # 子ノード取得時のボリューム絞り込み条件
            "serial_mode": "match_or_null" if serial else "any",
        })

    # 未接続ボリューム（シリアルごとにまとめる。シリアル未記録はドライブ文字ごと）
    offline_map: Dict[str, Dict[str, Any]] = {}
    for r in count_rows:
        letter = r["drive"]
        serial = r["volume_serial"]
        serial_upper = str(serial).upper() if serial else ""
        # VSNが現在接続中のいずれかのドライブと一致していれば（ドライブ文字が変わっていても）接続中扱い
        if serial_upper and serial_upper in connected_by_serial:
            continue
        conn_drive = connected_by_letter.get(letter)
        if conn_drive is not None:
            conn_serial = conn_drive["volume_serial"]
            conn_serial_upper = str(conn_serial).upper() if conn_serial else ""
            # 同じドライブ文字で接続中のボリュームと一致（またはシリアル不明）なら接続中扱い
            if conn_serial is None or serial is None or serial_upper == conn_serial_upper:
                continue
        group_key = f"serial:{serial_upper}" if serial_upper else f"drive:{letter}"
        group = offline_map.get(group_key)
        if group is None:
            vol_meta = volumes_by_serial.get(serial_upper) if serial_upper else None
            custom_name = (
                (r.get("custom_name") or "").strip()
                or ((vol_meta.get("custom_name") or "").strip() if vol_meta else "")
            )
            label = r.get("volume_label") or ((vol_meta.get("volume_label") or "") if vol_meta else "")
            short_serial = _format_vsn_short(serial)
            group = {
                "key": group_key,
                "letter": letter,
                "path": f"{letter}\\",
                "volume_serial": serial,
                "short_serial": short_serial,
                "label": label,
                "custom_name": custom_name,
                "total": 0,
                "has_managed": True,
                "is_offline": True,
                "serial_mode": "match" if serial else "null",
            }
            offline_map[group_key] = group
        group["total"] += r["count"]

    offline_volumes = list(offline_map.values())
    for v in offline_volumes:
        v["name"] = _format_offline_volume_name(
            letter=v["letter"],
            label=v.get("label") or "",
            custom_name=v.get("custom_name") or "",
            short_serial=v.get("short_serial") or "",
        )
    offline_volumes.sort(
        key=lambda v: (
            _natural_sort_key(v["letter"]),
            _natural_sort_key(v.get("custom_name") or ""),
            _natural_sort_key(v.get("label") or ""),
            _natural_sort_key(v.get("volume_serial") or ""),
        )
    )

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
    offline=True または実フォルダが存在しない場合（または別VSNのメディアが挿さっている場合）は DB の情報だけで組み立てる。
    """
    parent = normalize_folder_path(path)
    base = parent.rstrip("\\/")
    base_key = base.lower()
    parent_is_storage = is_path_in_storage(base, volume_serial=volume_serial)

    scan_root_keys = [_key(r) for r in get_scan_roots()]
    ignored_keys = [_key(p) for p in get_ignored_folders()]

    # VSNが厳密指定(serial_mode=='match')されている場合、現在そのドライブ文字に別VSNのメディアが挿さっていればオフライン扱いとする
    # ※ 切断済みネットワークドライブでのブロックを防ぐため、キャッシュ・エラー抑止済みの _get_connected_drive_serial_map を使用する
    effective_offline = offline
    if not effective_offline and volume_serial and serial_mode == "match" and len(base) >= 2 and base[1] == ":":
        try:
            from .scanner import _get_connected_drive_serial_map

            _, drive_to_serial = _get_connected_drive_serial_map()
            cur_serial = drive_to_serial.get(base[:2].upper())
            if not cur_serial or str(cur_serial).upper() != str(volume_serial).upper():
                effective_offline = True
        except Exception:
            info = get_volume_info_for_drive(base[:2])
            if info is None or (info.get("serial") and str(info["serial"]).upper() != str(volume_serial).upper()):
                effective_offline = True

    # 他人の Loome が存在するドライブは展開・閲覧をエシカル保護により完全ブロック
    if not effective_offline:
        from .security import assert_drive_not_blocked_by_foreign_loome
        assert_drive_not_blocked_by_foreign_loome(parent, volume_serial=volume_serial)

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
    fs_subdirs = None if effective_offline else _list_fs_subdirs(parent)
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
        direct_count = int(db_info["count"] or 0)
        total_count = int(db_info["total"] or 0)
        sub_count = max(0, total_count - direct_count)

        child_is_storage = parent_is_storage or is_path_in_storage(child_path, volume_serial=volume_serial)

        if any(_is_under(child_key, ig) for ig in ignored_keys):
            status = "ignored"
        elif (
            child_is_storage
            or total_count > 0
            or (not volume_serial and child_key in scan_root_keys)
        ):
            # 直下枚数が0枚でも、管理下の子フォルダに写真が存在する場合（例: 0 + 3952 = 3952）は管理下(managed)として扱う
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

        child_item: Dict[str, Any] = {
            "name": node["name"],
            "path": child_path,
            "status": status,
            "count": direct_count,
            "sub_count": sub_count,
            "total": total_count,
            "has_managed": child_is_storage or total_count > 0 or (not volume_serial and _has_scan_root_under(child_key, scan_root_keys)),
            "has_children": has_children,
            # 親フォルダは存在するのに実フォルダが無い = 消失（親自体が無い場合は未接続扱いで消失とはしない）
            "is_missing": parent_exists and not node["in_fs"],
        }
        if child_is_storage:
            child_item["is_storage"] = True
            child_item["is_storage_root"] = is_loome_root_path(child_path)
        result.append(child_item)

    result.sort(key=lambda c: _natural_sort_key(c["name"]))
    parent_sub_count = sum(c["total"] for c in result)
    return {
        "path": parent,
        "exists": parent_exists,
        "direct_count": parent_direct,
        "sub_count": parent_sub_count,
        "total_count": parent_direct + parent_sub_count,
        "children": result,
    }
