"""
フォルダ・タイムライン・カメラ集計モジュール
スキャンルート管理、ボリューム管理、写真の年月・フォルダ・カメラ機種別集計を提供する。
"""

import logging
import os
import threading
import time
import re
from typing import Any, Dict, List, Optional, Tuple


def _natural_sort_key(text: Any) -> List[Tuple[int, Any]]:
    """文字列内の数値部分を整数として評価する自然順ソートキーを生成する"""
    return [
        (0, int(part)) if part.isdigit() else (1, part.lower())
        for part in re.split(r"(\d+)", str(text or ""))
    ]

logger = logging.getLogger(__name__)

from .connection import get_connection
from .photos import _directory_filter_sql


# システム除外フォルダ名（小文字）。フォルダ集計とフォルダツリーで共用する
SYSTEM_IGNORE_NAMES = {
    "appdata", "local settings", "application data", "program files", "program files (x86)",
    "windows", "system32", "$recycle.bin", "system volume information", "node_modules",
    ".git", ".gemini", ".vscode", ".idea", ".cache", "cache", "import", "uploads", "carry", "take_out", "__pycache__", "temp"
}


def upsert_volume(volume_serial: str, volume_label: str, drive_letter: Optional[str] = None) -> None:
    """ボリューム情報をUPSERTする（スキャン時にラベルを自動更新）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO volumes (volume_serial, volume_label, drive_letter, last_seen_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(volume_serial) DO UPDATE SET
                volume_label = excluded.volume_label,
                drive_letter = excluded.drive_letter,
                last_seen_at = CURRENT_TIMESTAMP
            """,
            (volume_serial, volume_label, drive_letter),
        )
        conn.commit()


def get_volume_by_serial(volume_serial: str) -> Optional[Dict[str, Any]]:
    """ボリュームシリアル番号からボリューム情報を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM volumes WHERE volume_serial = ?", (volume_serial,))
        row = cursor.fetchone()
        return dict(row) if row else None


def get_all_volumes() -> List[Dict[str, Any]]:
    """登録済みの全ボリューム一覧を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM volumes ORDER BY last_seen_at DESC")
        return [dict(row) for row in cursor.fetchall()]



def get_timeline_summary() -> List[Dict[str, Any]]:
    """年・月ごとの写真枚数集計を取得する（Picasa風タイムライン用）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT year_month, COUNT(*) as count
            FROM photos
            WHERE year_month IS NOT NULL AND year_month != ''
            GROUP BY year_month
            ORDER BY year_month DESC
            """
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]


def get_calendar_summary() -> List[Dict[str, Any]]:
    """
    日別（YYYY-MM-DD）の写真枚数・優枚数・代表写真ID・代表撮影地を一括集計する。
    ミニカレンダーおよび拡大カレンダーモーダル（月間フォトカレンダー／年間ヒートマップ）で使用する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            WITH daily_ranked AS (
                SELECT
                    SUBSTR(REPLACE(p.date_taken, ':', '-'), 1, 10) AS date_ymd,
                    p.year_month AS ym,
                    p.id AS photo_id,
                    p.file_name AS file_name,
                    p.rating AS rating,
                    p.state AS state,
                    p.city AS city,
                    ROW_NUMBER() OVER (
                        PARTITION BY SUBSTR(REPLACE(p.date_taken, ':', '-'), 1, 10)
                        ORDER BY p.rating DESC, COALESCE(p.is_stack_primary, 1) DESC, p.date_taken ASC, p.id ASC
                    ) AS rn
                FROM photos p
                WHERE p.date_taken IS NOT NULL
                  AND LENGTH(TRIM(p.date_taken)) >= 10
                  AND IFNULL(p.is_unlinked, 0) = 0
            )
            SELECT
                date_ymd AS date,
                COALESCE(NULLIF(ym, ''), SUBSTR(date_ymd, 1, 7)) AS year_month,
                COUNT(*) AS count,
                SUM(CASE WHEN rating >= 0 THEN 1 ELSE 0 END) AS active_count,
                SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS excellent_count,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS good_count,
                MAX(CASE WHEN rn = 1 THEN photo_id END) AS rep_photo_id,
                MAX(CASE WHEN rn = 1 THEN file_name END) AS rep_file_name,
                MAX(CASE WHEN rn = 1 THEN state END) AS rep_state,
                MAX(CASE WHEN rn = 1 THEN city END) AS rep_city
            FROM daily_ranked
            WHERE date_ymd GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            GROUP BY date_ymd
            ORDER BY date_ymd DESC
            """
        )
        rows = cursor.fetchall()
        result: List[Dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            st = (d.get("rep_state") or "").strip()
            ct = (d.get("rep_city") or "").strip()
            if st and ct:
                loc_label = f"{st} {ct}" if st != ct else st
            else:
                loc_label = st or ct or ""
            d["location_label"] = loc_label
            result.append(d)
        return result



def add_scan_root(folder_path: str) -> None:
    """スキャン対象として指定された親フォルダ（ルート）を登録する"""
    norm_path = os.path.normpath(folder_path)
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO scan_roots (folder_path) VALUES (?)",
            (norm_path,)
        )
        conn.commit()


def remove_scan_root(folder_path: str) -> None:
    """登録ルートフォルダを削除する"""
    norm_path = os.path.normpath(folder_path)
    with get_connection() as conn:
        conn.execute("DELETE FROM scan_roots WHERE folder_path = ?", (norm_path,))
        conn.commit()


def get_scan_roots() -> List[str]:
    """登録されているルートフォルダ一覧を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT folder_path FROM scan_roots ORDER BY folder_path ASC")
        return [row["folder_path"] for row in cursor.fetchall()]


def add_ignored_folder(folder_path: str) -> None:
    """指定されたフォルダを除外（管理対象外）として登録し、DBから該当写真を解除する"""
    norm_path = os.path.normpath(folder_path)
    # まずDBから写真情報を解除（配下も含めて除外）
    remove_folder_photos(norm_path, recursive=True)
    # 除外リストに登録
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO ignored_folders (folder_path, created_at) VALUES (?, datetime('now', 'localtime'))",
            (norm_path,)
        )
        conn.commit()


def remove_ignored_folder(folder_path: str) -> None:
    """指定されたフォルダの除外設定を解除する（未管理状態に戻す）"""
    norm_path = os.path.normpath(folder_path)
    with get_connection() as conn:
        conn.execute("DELETE FROM ignored_folders WHERE folder_path = ?", (norm_path,))
        conn.commit()


def get_ignored_folders() -> List[str]:
    """除外設定されているフォルダ一覧を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT folder_path FROM ignored_folders ORDER BY folder_path ASC")
        return [row["folder_path"] for row in cursor.fetchall()]


def is_folder_ignored(folder_path: str, ignored_set: Optional[set] = None) -> bool:
    """指定されたフォルダが除外対象（自身または除外フォルダの配下）であるか判定する"""
    norm = os.path.normpath(folder_path).lower()
    if ignored_set is None:
        ignored_set = {os.path.normpath(p).lower() for p in get_ignored_folders()}
    return any(norm == ig or norm.startswith(ig + os.sep) for ig in ignored_set)


def get_scan_roots_summary() -> List[Dict[str, Any]]:

    """
    登録ルートフォルダごとの階層サマリーを取得する。
    親フォルダ直下に写真がない場合でも、親フォルダがルートとして表示され、
    配下のサブフォルダ一覧と合計写真枚数が集計される。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 登録済みルート一覧を取得（指紋の有無も含める）
        cursor.execute("SELECT folder_path, fingerprint FROM scan_roots ORDER BY folder_path ASC")
        registered_root_rows = cursor.fetchall()
        registered_roots = [r["folder_path"] for r in registered_root_rows]
        root_fp_map = {r["folder_path"]: bool(r["fingerprint"]) for r in registered_root_rows}

        # 2. 実際に写真が存在する全ディレクトリの枚数およびサムネイル生成済み枚数を取得
        cursor.execute(
            """
            SELECT p.directory_path,
                   COUNT(*) as count,
                   COUNT(t.photo_id) as cached_count
            FROM photos p
            LEFT JOIN thumbnails t ON p.id = t.photo_id
            GROUP BY p.directory_path
            ORDER BY p.directory_path ASC
            """
        )
        all_dirs = [dict(r) for r in cursor.fetchall()]

        # 3. 各ルートフォルダにサブディレクトリを振り分け
        roots_map: Dict[str, Dict[str, Any]] = {}
        for r_path in registered_roots:
            norm_r = os.path.normpath(r_path)
            roots_map[norm_r] = {
                "folder_path": norm_r,
                "is_root": True,
                "has_fingerprint": root_fp_map.get(r_path, False),
                "total_photos": 0,
                "cached_photos": 0,
                "has_all_thumbnails": True,
                "subfolder_count": 0,
                "subfolders": [],
            }

        unassigned_dirs = []
        for d_info in all_dirs:
            d_path = os.path.normpath(d_info["directory_path"])
            cnt = d_info["count"]
            cached_cnt = d_info["cached_count"]
            has_all_thumb = (cached_cnt >= cnt)

            # 一番近い（最長の）ルートを探す
            matched_root = None
            for r_path in sorted(roots_map.keys(), key=lambda x: len(x), reverse=True):
                if d_path == r_path or d_path.startswith(r_path + os.sep):
                    matched_root = r_path
                    break

            if matched_root:
                roots_map[matched_root]["total_photos"] += cnt
                roots_map[matched_root]["cached_photos"] += cached_cnt
                roots_map[matched_root]["subfolder_count"] += 1
                roots_map[matched_root]["subfolders"].append({
                    "directory_path": d_path,
                    "count": cnt,
                    "cached_count": cached_cnt,
                    "has_all_thumbnails": has_all_thumb,
                })
            else:
                unassigned_dirs.append({
                    "directory_path": d_path,
                    "count": cnt,
                    "cached_count": cached_cnt,
                    "has_all_thumbnails": has_all_thumb,
                })

        # 未割り当てディレクトリ（過去にスキャンされたがscan_rootsに未登録のもの）を
        # 単独ルートとしてまとめる
        for u_dir in unassigned_dirs:
            u_path = u_dir["directory_path"]
            roots_map[u_path] = {
                "folder_path": u_path,
                "is_root": False,
                "has_fingerprint": False,
                "total_photos": u_dir["count"],
                "cached_photos": u_dir["cached_count"],
                "has_all_thumbnails": u_dir["has_all_thumbnails"],
                "subfolder_count": 1,
                "subfolders": [{
                    "directory_path": u_path,
                    "count": u_dir["count"],
                    "cached_count": u_dir["cached_count"],
                    "has_all_thumbnails": u_dir["has_all_thumbnails"],
                }],
            }

        # 各ルートの全写真サムネイル完備フラグを最終確定
        for r_obj in roots_map.values():
            r_obj["has_all_thumbnails"] = (r_obj["cached_photos"] >= r_obj["total_photos"]) if r_obj["total_photos"] > 0 else True

        # 兄弟フォルダの共通親への自動統合、および親子ルートのマージを実行
        result = list(roots_map.values())
        result = _merge_sibling_roots(result)
        result.sort(key=lambda x: _natural_sort_key(x["folder_path"]))
        return result


def _merge_sibling_roots(roots_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    1. 親子関係にあるルート（親Aが登録済みで子Bも登録された場合）を親ルートに吸収する。
    2. 同じ親ディレクトリを共有する複数の登録ルート（子B、子Cなど）が存在する場合、
       共通の親ディレクトリAを親行として自動的に束ねてツリー状に統合する。
    """
    if len(roots_list) <= 1:
        return roots_list

    # ルート辞書（キー: 正規化パス）
    roots_by_path: Dict[str, Dict[str, Any]] = {
        os.path.normpath(r["folder_path"]): r for r in roots_list
    }

    # --- ステップ 1: 親子関係にあるルート同士のマージ ---
    # 深いパスから順に祖先を辿り、登録ルートがあればそこに吸収
    absorbed_into_ancestor = set()
    sorted_paths = sorted(roots_by_path.keys(), key=lambda x: len(x), reverse=True)
    for path in sorted_paths:
        if path in absorbed_into_ancestor:
            continue
        curr = os.path.dirname(path)
        while curr and curr != path:
            if curr in roots_by_path:
                parent_obj = roots_by_path[curr]
                child_obj = roots_by_path[path]

                parent_obj["total_photos"] += child_obj.get("total_photos", 0)
                parent_obj["cached_photos"] += child_obj.get("cached_photos", 0)
                if child_obj.get("has_fingerprint"):
                    parent_obj["has_fingerprint"] = True

                for sf in child_obj.get("subfolders", []):
                    if not any(existing["directory_path"] == sf["directory_path"] for existing in parent_obj.get("subfolders", [])):
                        parent_obj.setdefault("subfolders", []).append(sf)

                parent_obj["subfolder_count"] = len(parent_obj["subfolders"])
                parent_obj["has_all_thumbnails"] = (
                    parent_obj["cached_photos"] >= parent_obj["total_photos"]
                ) if parent_obj["total_photos"] > 0 else True

                absorbed_into_ancestor.add(path)
                break
            prev = curr
            curr = os.path.dirname(curr)
            if curr == prev:
                break

    active_roots = [
        r for p, r in roots_by_path.items() if p not in absorbed_into_ancestor
    ]

    # --- ステップ 2: 同じ親ディレクトリを共有する兄弟ルートの自動統合 ---
    parent_map: Dict[str, List[Dict[str, Any]]] = {}
    for r in active_roots:
        p = os.path.normpath(r["folder_path"])
        parent = os.path.dirname(p)
        drive, tail = os.path.splitdrive(p)
        is_drive_root = (p == drive + os.sep) or (p == drive) or (not tail or tail == os.sep)
        if parent and parent != p and not is_drive_root:
            parent_map.setdefault(parent, []).append(r)

    merged_roots: List[Dict[str, Any]] = []
    absorbed_siblings = set()

    for parent_path in sorted(parent_map.keys(), key=lambda x: len(x), reverse=True):
        children = [c for c in parent_map[parent_path] if c["folder_path"] not in absorbed_siblings]
        if len(children) >= 2:
            combined_subfolders: List[Dict[str, Any]] = []
            total_photos = 0
            cached_photos = 0
            has_fp = False

            for c in children:
                absorbed_siblings.add(c["folder_path"])
                total_photos += c.get("total_photos", 0)
                cached_photos += c.get("cached_photos", 0)
                if c.get("has_fingerprint"):
                    has_fp = True

                for sf in c.get("subfolders", []):
                    if not any(existing["directory_path"] == sf["directory_path"] for existing in combined_subfolders):
                        combined_subfolders.append(sf)

            combined_subfolders.sort(key=lambda s: _natural_sort_key(s["directory_path"]))

            merged_parent_obj = {
                "folder_path": parent_path,
                "is_root": True,
                "is_merged_parent": True,
                "has_fingerprint": has_fp,
                "total_photos": total_photos,
                "cached_photos": cached_photos,
                "has_all_thumbnails": (cached_photos >= total_photos) if total_photos > 0 else True,
                "subfolder_count": len(combined_subfolders),
                "subfolders": combined_subfolders,
            }
            merged_roots.append(merged_parent_obj)

    # 兄弟統合されなかった残りのルートを追加
    for r in active_roots:
        if r["folder_path"] not in absorbed_siblings:
            merged_roots.append(r)

    merged_roots.sort(key=lambda x: _natural_sort_key(x["folder_path"]))
    return merged_roots


def normalize_folder_path(path_str: str) -> str:
    """Windowsドライブ文字の大文字化およびパス区切りの正規化を行う"""
    if not path_str:
        return ""
    norm = os.path.normpath(path_str)
    # Windowsのドライブレター (例: "g:\..." や "g:") を大文字 "G:\..." に統一
    if len(norm) >= 2 and norm[1] == ":" and norm[0].isalpha():
        norm = norm[0].upper() + norm[1:]
    return norm


# get_folders_summary の FS確認 (isdir / scandir) 用 TTLキャッシュ (5秒TTL)
_fs_cache_lock = threading.Lock()
_isdir_cache: Dict[str, Tuple[bool, float]] = {}
_scandir_cache: Dict[str, Tuple[List[Tuple[str, str]], float]] = {}


# /api/photos のディレクトリ別ファイル一覧キャッシュ (45秒TTL)
_PHOTO_DIR_SCAN_CACHE: Dict[str, Any] = {}
_PHOTO_DIR_SCAN_TTL: float = 45.0


def clear_folders_fs_cache() -> None:
    """フォルダ集計および写真一覧用FS確認キャッシュをクリアする"""
    with _fs_cache_lock:
        _isdir_cache.clear()
        _scandir_cache.clear()
        _PHOTO_DIR_SCAN_CACHE.clear()


def _cached_isdir(path: str) -> bool:
    """os.path.isdir の結果をTTLキャッシュ付きで返す"""
    norm_key = normalize_folder_path(path).lower()
    now = time.time()
    with _fs_cache_lock:
        cached = _isdir_cache.get(norm_key)
        if cached is not None:
            is_dir, expire_time = cached
            if now < expire_time:
                return is_dir

    is_dir = os.path.isdir(path)
    with _fs_cache_lock:
        _isdir_cache[norm_key] = (is_dir, now + 5.0)
    return is_dir


def _cached_scandir_subdirs(p_dir: str, system_ignore_names: set) -> List[Tuple[str, str]]:
    """ディレクトリ配下の有効なサブディレクトリ (name, full_path) 一覧をTTLキャッシュ付きで返す"""
    norm_key = normalize_folder_path(p_dir).lower()
    now = time.time()
    with _fs_cache_lock:
        cached = _scandir_cache.get(norm_key)
        if cached is not None:
            subdirs, expire_time = cached
            if now < expire_time:
                return subdirs

    subdirs = []
    try:
        with os.scandir(p_dir) as entries:
            for entry in entries:
                try:
                    if not entry.is_dir():
                        continue
                    name_lower = entry.name.lower()
                    if name_lower.startswith(".") or name_lower in system_ignore_names:
                        continue
                    subdirs.append((entry.name, normalize_folder_path(entry.path)))
                except Exception as e:
                    print(f"[WARN] サブフォルダ判定をスキップしました ({entry.path}): {e}")
                    continue
    except Exception as e:
        print(f"[WARN] フォルダ一覧の取得に失敗しました ({p_dir}): {e}")

    with _fs_cache_lock:
        _scandir_cache[norm_key] = (subdirs, now + 5.0)
    return subdirs


def get_folders_summary() -> List[Dict[str, Any]]:
    """
    ディレクトリごとの写真枚数および管理ステータス（managed / unmanaged / ignored）を取得する。
    登録ルートフォルダ配下の実ディレクトリも走査し、未管理フォルダや除外フォルダもツリーに含めて返却する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 実際に写真が登録されているディレクトリ一覧
        cursor.execute(
            """
            SELECT p.directory_path,
                   COUNT(*) as count,
                   COUNT(t.photo_id) as cached_count
            FROM photos p
            LEFT JOIN thumbnails t ON p.id = t.photo_id
            GROUP BY p.directory_path
            ORDER BY p.directory_path ASC
            """
        )
        rows = cursor.fetchall()
        result: List[Dict[str, Any]] = []
        managed_map: Dict[str, Dict[str, Any]] = {}

        for r in rows:
            d = dict(r)
            norm = normalize_folder_path(d["directory_path"])
            d["directory_path"] = norm
            d["has_all_thumbnails"] = (d["cached_count"] >= d["count"]) if d["count"] > 0 else True
            d["status"] = "managed"

            # 実フォルダの存在確認（オフライン/消失の検出）
            is_present = _cached_isdir(norm)
            if not is_present:
                try:
                    from ..scanner import resolve_portable_path
                    _, is_online = resolve_portable_path(norm)
                    is_present = is_online
                except Exception as e:
                    logger.debug(f"フォルダ存在確認でのポータブルパス解決スキップ ({norm}): {e}")
            d["is_missing"] = not is_present

            result.append(d)
            managed_map[norm.lower()] = d

        # 2. 除外フォルダ一覧
        cursor.execute("SELECT folder_path FROM ignored_folders ORDER BY folder_path ASC")
        ignored_rows = cursor.fetchall()
        ignored_set = {normalize_folder_path(r["folder_path"]).lower() for r in ignored_rows}

        seen_paths = set(managed_map.keys())

        # 除外フォルダ自身を結果に追加（DBに写真が無くてもツリーに表示）
        for ig_row in ignored_rows:
            ig_path = normalize_folder_path(ig_row["folder_path"])
            ig_key = ig_path.lower()
            if ig_key not in seen_paths:
                result.append({
                    "directory_path": ig_path,
                    "count": 0,
                    "cached_count": 0,
                    "has_all_thumbnails": True,
                    "status": "ignored",
                })
                seen_paths.add(ig_key)

        # 3. 探索対象となる親ディレクトリ群を特定（写真ディレクトリ自身、その親、および登録ルート）
        # ※無制限なos.walkによる全ドライブ・AppData等の走査爆発を防止し、ミリ秒単位で高速走査
        cursor.execute("SELECT folder_path FROM scan_roots ORDER BY folder_path ASC")
        roots = [normalize_folder_path(r["folder_path"]) for r in cursor.fetchall()]

        # 探索基点となる親ディレクトリ（小文字ではなく、元の正式なパスの大文字小文字を保持）
        candidate_parents_dict: Dict[str, str] = {}  # key: lower_path, value: cased_path
        for d in managed_map.values():
            curr = d["directory_path"]
            while curr:
                curr_key = curr.lower()
                if curr_key not in candidate_parents_dict:
                    candidate_parents_dict[curr_key] = curr
                parent = os.path.dirname(curr)
                if not parent or parent == curr:
                    break
                curr = parent

        for r_path in roots:
            r_key = r_path.lower()
            if r_key not in candidate_parents_dict:
                candidate_parents_dict[r_key] = r_path

        for p_key, p_dir in candidate_parents_dict.items():
            # ルート自身が結果に未登録なら追加
            if p_key not in seen_paths and any(p_key == r.lower() for r in roots):
                is_ig = p_key in ignored_set
                is_dir_present = _cached_isdir(p_dir)
                result.append({
                    "directory_path": p_dir,
                    "count": 0,
                    "cached_count": 0,
                    "has_all_thumbnails": True,
                    "status": "ignored" if is_ig else "managed",
                    "is_missing": not is_dir_present,
                })
                seen_paths.add(p_key)

            if not _cached_isdir(p_dir):
                continue

            subdirs = _cached_scandir_subdirs(p_dir, SYSTEM_IGNORE_NAMES)
            for entry_name, sub_path in subdirs:
                sub_key = sub_path.lower()
                if sub_key not in seen_paths:
                    is_sub_ignored = any(sub_key == ig or sub_key.startswith(ig + os.sep) for ig in ignored_set)
                    result.append({
                        "directory_path": sub_path,
                        "count": 0,
                        "cached_count": 0,
                        "has_all_thumbnails": True,
                        "status": "ignored" if is_sub_ignored else "unmanaged",
                    })
                    seen_paths.add(sub_key)

        result.sort(key=lambda x: _natural_sort_key(x["directory_path"]))
        return result


def get_drive_photo_counts() -> List[Dict[str, Any]]:
    """ドライブ文字×ボリュームシリアルごとの写真枚数を集計する（フォルダツリーのドライブ一覧用）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT UPPER(SUBSTR(p.directory_path, 1, 2)) AS drive,
                   p.volume_serial,
                   v.volume_label,
                   COUNT(*) AS count
            FROM photos p
            LEFT JOIN volumes v ON p.volume_serial = v.volume_serial
            WHERE p.directory_path IS NOT NULL AND p.directory_path != ''
            GROUP BY drive, p.volume_serial
            """
        )
        return [dict(r) for r in cursor.fetchall()]


def get_directory_counts_under(
    folder_path: str,
    volume_serial: Optional[str] = None,
    serial_mode: str = "any",
) -> List[Dict[str, Any]]:
    """
    指定フォルダ配下（自身含む）のディレクトリごとの写真枚数を集計する。
    serial_mode でボリュームを絞り込む（ドライブ文字が別ボリュームと衝突した場合に、
    接続中/未接続の写真を取り違えないため）:
      any: 絞り込みなし / match: volume_serial 一致のみ /
      match_or_null: 一致またはシリアル未記録 / null: シリアル未記録のみ
    """
    dir_sql, params = _directory_filter_sql(folder_path, recursive=True, column_name="directory_path")
    query = f"SELECT directory_path, COUNT(*) AS count FROM photos WHERE {dir_sql}"
    if serial_mode == "match" and volume_serial:
        query += " AND volume_serial = ?"
        params.append(volume_serial)
    elif serial_mode == "match_or_null" and volume_serial:
        query += " AND (volume_serial = ? OR volume_serial IS NULL)"
        params.append(volume_serial)
    elif serial_mode == "null":
        query += " AND volume_serial IS NULL"
    query += " GROUP BY directory_path"
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        return [dict(r) for r in cursor.fetchall()]




def remove_folder_photos(directory_path: str, recursive: bool = True) -> Dict[str, Any]:
    """
    指定したフォルダ内の写真情報をDBから削除する（実ファイルは削除しない）。
    recursive=True の場合、親フォルダ配下のすべてのサブフォルダの写真・サムネイル・タグも一括削除する。
    """
    norm_path = os.path.normpath(directory_path)

    with get_connection() as conn:
        cursor = conn.cursor()

        # 指定フォルダ（および recursive=True なら配下サブフォルダ）の写真をすべて取得
        sql_frag, sql_params = _directory_filter_sql(norm_path, recursive=recursive, column_name="directory_path")
        cursor.execute(
            f"SELECT id, directory_path FROM photos WHERE {sql_frag}",
            sql_params,
        )

        rows = cursor.fetchall()
        deleted_photo_count = len(rows)
        affected_subfolders = list(set(r["directory_path"] for r in rows))

        if deleted_photo_count > 0:
            photo_ids = [r["id"] for r in rows]
            # SQLiteの変数制限（999個）を回避するため500件ずつチャンク削除
            for i in range(0, len(photo_ids), 500):
                chunk = photo_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)

        # scan_roots からも該当フォルダ（および recursive=True なら配下）を確実に削除
        # （LIKE の '_' ワイルドカード誤一致を避けるため範囲比較ヘルパーを使用）
        root_frag, root_params = _directory_filter_sql(norm_path, recursive=recursive, column_name="folder_path")
        cursor.execute(f"DELETE FROM scan_roots WHERE {root_frag}", root_params)

        # 万が一の孤立サムネイルをここで即座にパージ
        cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
        conn.commit()

        # もしライブラリ内の全写真が0件になったかチェック
        cursor.execute("SELECT 1 FROM photos LIMIT 1")
        should_vacuum = (cursor.fetchone() is None)

    # 接続コンテキストを抜けてコミット完了後にVACUUMを実行
    if should_vacuum:
        try:
            from .stats import vacuum_database
            vacuum_database()
            print("[INFO] 全写真が解除されたため、DBを自動最適化（VACUUM）しました。")
        except Exception as e:
            print(f"[WARN] 自動VACUUM失敗: {e}")

    return {
        "deleted_count": deleted_photo_count,
        "affected_folders": len(affected_subfolders),
        "folder_path": norm_path,
    }


def get_cameras_summary() -> List[Dict[str, Any]]:
    """
    カメラ機種ごと・配下レンズごとの写真枚数集計（2階層ツリー）を取得する。
    lens_model が NULL または空文字のレコードは "__NONE__"（「レンズ情報なし」）としてまとめる。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT camera_model,
                   CASE
                       WHEN lens_model IS NULL OR TRIM(lens_model) = '' THEN '__NONE__'
                       ELSE TRIM(lens_model)
                   END AS norm_lens,
                   COUNT(*) AS cnt
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND camera_model IS NOT NULL AND camera_model != ''
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
            GROUP BY camera_model, norm_lens
            ORDER BY camera_model ASC, cnt DESC
            """
        )
        rows = cursor.fetchall()

        cam_map: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            cam = r["camera_model"]
            lens = r["norm_lens"]
            cnt = int(r["cnt"] or 0)
            if cam not in cam_map:
                cam_map[cam] = {
                    "camera_model": cam,
                    "count": 0,
                    "lenses": [],
                }
            cam_map[cam]["count"] += cnt
            cam_map[cam]["lenses"].append({
                "lens_model": lens,
                "label": "レンズ情報なし" if lens == "__NONE__" else lens,
                "count": cnt,
            })

        result = list(cam_map.values())
        for cam_obj in result:
            cam_obj["lenses"].sort(
                key=lambda x: (1 if x["lens_model"] in ("__NONE__", "----") else 0, _natural_sort_key(x["label"]))
            )
        result.sort(key=lambda x: (1 if x["camera_model"] in ("不明", "Unknown", "__NONE__") else 0, _natural_sort_key(x["camera_model"])))
        return result


