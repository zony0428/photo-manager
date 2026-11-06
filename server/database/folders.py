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
    """ボリューム情報をUPSERTする（スキャン時にラベルを自動更新、custom_nameは維持）"""
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


def update_volume_custom_name(
    volume_serial: str,
    custom_name: str,
    volume_label: Optional[str] = None,
    drive_letter: Optional[str] = None,
) -> Dict[str, Any]:
    """指定VSNのメディア識別名（ニックネーム: custom_name）を設定・更新する"""
    serial_clean = (volume_serial or "").strip().upper()
    name_clean = (custom_name or "").strip()
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM volumes WHERE volume_serial = ?", (serial_clean,))
        existing = cursor.fetchone()
        if existing:
            cursor.execute(
                """
                UPDATE volumes
                SET custom_name = ?,
                    volume_label = COALESCE(?, volume_label),
                    drive_letter = COALESCE(?, drive_letter)
                WHERE volume_serial = ?
                """,
                (name_clean, volume_label, drive_letter, serial_clean),
            )
        else:
            cursor.execute(
                """
                INSERT INTO volumes (volume_serial, volume_label, custom_name, drive_letter, last_seen_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (serial_clean, volume_label or "", name_clean, drive_letter),
            )
        conn.commit()
        cursor.execute("SELECT * FROM volumes WHERE volume_serial = ?", (serial_clean,))
        row = cursor.fetchone()
        return dict(row) if row else {
            "volume_serial": serial_clean,
            "volume_label": volume_label or "",
            "custom_name": name_clean,
            "drive_letter": drive_letter,
        }


def get_volume_by_serial(volume_serial: str) -> Optional[Dict[str, Any]]:
    """ボリュームシリアル番号からボリューム情報を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM volumes WHERE volume_serial = ?", (volume_serial,))
        row = cursor.fetchone()
        return dict(row) if row else None


def set_volume_loome_enabled(
    volume_serial: str,
    enabled: bool,
    volume_label: Optional[str] = None,
    drive_letter: Optional[str] = None,
) -> Dict[str, Any]:
    """指定VSNのメディアの Loome 有効状態 (loome_enabled) を設定・更新する"""
    serial_clean = (volume_serial or "").strip().upper()
    enabled_val = 1 if enabled else 0
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM volumes WHERE volume_serial = ?", (serial_clean,))
        existing = cursor.fetchone()
        if existing:
            cursor.execute(
                """
                UPDATE volumes
                SET loome_enabled = ?,
                    volume_label = COALESCE(?, volume_label),
                    drive_letter = COALESCE(?, drive_letter),
                    last_seen_at = CURRENT_TIMESTAMP
                WHERE volume_serial = ?
                """,
                (enabled_val, volume_label, drive_letter, serial_clean),
            )
        else:
            cursor.execute(
                """
                INSERT INTO volumes (volume_serial, volume_label, custom_name, drive_letter, loome_enabled, last_seen_at)
                VALUES (?, ?, '', ?, ?, CURRENT_TIMESTAMP)
                """,
                (serial_clean, volume_label or "", drive_letter, enabled_val),
            )
        conn.commit()
        cursor.execute("SELECT * FROM volumes WHERE volume_serial = ?", (serial_clean,))
        row = cursor.fetchone()
        return dict(row) if row else {
            "volume_serial": serial_clean,
            "volume_label": volume_label or "",
            "custom_name": "",
            "drive_letter": drive_letter,
            "loome_enabled": enabled_val,
        }


def get_all_volumes() -> List[Dict[str, Any]]:
    """
    登録済みの全メディア（ボリューム）一覧を、収録写真枚数・撮影期間・カメラ機種・接続状態付きで取得する。
    photo_links から集計することで、複数メディアに跨る重複写真も各メディアの枚数に正確に反映する。
    """
    from ..scanner import _get_connected_drive_serial_map
    from ..volume_info import get_volume_info_for_drive

    online_map: Dict[str, Dict[str, Any]] = {}
    try:
        serial_to_drive, _ = _get_connected_drive_serial_map()
        for drive in serial_to_drive.values():
            info = get_volume_info_for_drive(drive)
            if info and info.get("serial"):
                online_map[info["serial"].upper()] = info
    except Exception as e:
        logger.debug(f"オンラインボリューム走査スキップ: {e}")

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM volumes ORDER BY last_seen_at DESC")
        vol_rows = {str(r["volume_serial"]).upper(): dict(r) for r in cursor.fetchall() if r["volume_serial"]}

        cursor.execute(
            """
            SELECT
                UPPER(pl.volume_serial) as volume_serial,
                COUNT(DISTINCT pl.photo_id) as photo_count,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) as excellent_count,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) as good_count,
                MIN(p.date_taken) as min_date,
                MAX(p.date_taken) as max_date,
                GROUP_CONCAT(DISTINCT p.camera_model) as cameras_csv,
                MIN(pl.directory_path) as sample_dir
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            WHERE pl.volume_serial IS NOT NULL
              AND pl.volume_serial != ''
              AND COALESCE(p.is_unlinked, 0) = 0
            GROUP BY UPPER(pl.volume_serial)
            """
        )
        stat_rows = {str(r["volume_serial"]).upper(): dict(r) for r in cursor.fetchall() if r["volume_serial"]}

    all_serials = set(vol_rows.keys()) | set(stat_rows.keys())
    results: List[Dict[str, Any]] = []

    for serial in all_serials:
        v_rec = vol_rows.get(serial, {})
        s_rec = stat_rows.get(serial, {})
        online = online_map.get(serial)

        photo_count = int(s_rec.get("photo_count") or 0)
        custom_name = (v_rec.get("custom_name") or "").strip()
        loome_enabled = bool(int(v_rec.get("loome_enabled") or 0))
        if photo_count == 0 and not custom_name and not loome_enabled:
            continue

        vol_label = (
            (online.get("label") if online and online.get("label") else v_rec.get("volume_label"))
            or ""
        ).strip()
        drive_letter = (
            (online.get("drive") if online and online.get("drive") else v_rec.get("drive_letter"))
            or ""
        ).strip()
        if not drive_letter and s_rec.get("sample_dir"):
            raw_dir = str(s_rec["sample_dir"])
            if raw_dir.startswith("vsn://"):
                idx = raw_dir.find("/", 6)
                if idx != -1:
                    raw_dir = raw_dir[idx + 1:]
            if len(raw_dir) >= 2 and raw_dir[1] == ":":
                drive_letter = raw_dir[:2].upper()

        short_serial = f"{serial[:4]}-{serial[4:]}" if len(serial) == 8 else serial
        if custom_name and vol_label and custom_name != vol_label:
            display_name = f"{custom_name} ({vol_label})"
        elif custom_name:
            display_name = custom_name
        elif vol_label:
            display_name = vol_label
        else:
            display_name = f"メディア [ID:{short_serial}]"

        raw_cams = [
            c.strip()
            for c in str(s_rec.get("cameras_csv") or "").split(",")
            if c.strip() and c.strip() != "不明"
        ]
        min_d = str(s_rec.get("min_date") or "")[:10].replace(":", "-")
        max_d = str(s_rec.get("max_date") or "")[:10].replace(":", "-")

        results.append({
            "volume_serial": serial,
            "short_serial": short_serial,
            "custom_name": custom_name,
            "volume_label": vol_label,
            "display_name": display_name,
            "drive_letter": drive_letter,
            "filesystem": (online.get("filesystem") if online else "") or "",
            "is_online": bool(online),
            "loome_enabled": loome_enabled,
            "loome_path": f"{drive_letter}\\Loome" if (loome_enabled and drive_letter) else "",
            "photo_count": photo_count,
            "excellent_count": int(s_rec.get("excellent_count") or 0),
            "good_count": int(s_rec.get("good_count") or 0),
            "min_date": min_d,
            "max_date": max_d,
            "cameras": raw_cams[:4],
            "last_seen_at": v_rec.get("last_seen_at") or "",
        })

    results.sort(
        key=lambda x: (
            0 if x["is_online"] else 1,
            -x["photo_count"],
            x["display_name"],
        )
    )
    return results


def remove_volume_by_serial(volume_serial: str) -> Dict[str, Any]:
    """
    指定VSNのメディアに属するリンク登録をDBから一括解除し、volumes テーブルからも削除する（実ファイルは削除しない）。
    他メディアにもリンクを持つ写真は残存リンクを代表にして保護し、リンクが0本になった写真のみDBから削除する。
    """
    from .photos import _sync_photo_links_state, invalidate_fast_cache

    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean:
        return {"deleted_photos": 0, "volume_serial": ""}

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT DISTINCT photo_id FROM photo_links WHERE UPPER(volume_serial) = ?",
            (serial_clean,),
        )
        affected_photo_ids = [row["photo_id"] for row in cursor.fetchall()]
        cursor.execute("DELETE FROM photo_links WHERE UPPER(volume_serial) = ?", (serial_clean,))

        zero_link_ids: List[int] = []
        for pid in affected_photo_ids:
            rem = _sync_photo_links_state(cursor, pid)
            if rem == 0:
                zero_link_ids.append(pid)

        # リンク未経由の旧レコードがあれば合わせて回収
        cursor.execute(
            "SELECT id FROM photos WHERE UPPER(volume_serial) = ? AND id NOT IN (SELECT photo_id FROM photo_links)",
            (serial_clean,),
        )
        for r in cursor.fetchall():
            if r["id"] not in zero_link_ids:
                zero_link_ids.append(r["id"])

        if zero_link_ids:
            chunk_size = 500
            for i in range(0, len(zero_link_ids), chunk_size):
                chunk = zero_link_ids[i : i + chunk_size]
                ph = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({ph})", chunk)
                cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({ph})", chunk)
                cursor.execute(f"DELETE FROM photos WHERE id IN ({ph})", chunk)

        cursor.execute("DELETE FROM volumes WHERE UPPER(volume_serial) = ?", (serial_clean,))
        conn.commit()

    removed_cnt = len(affected_photo_ids) or len(zero_link_ids)
    clear_folders_fs_cache()
    invalidate_fast_cache()
    return {
        "volume_serial": serial_clean,
        "deleted_photos": removed_cnt,
        "removed_count": removed_cnt,
    }


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
                  AND NOT (p.is_raw = 1 AND p.paired_raw_path IS NOT NULL)
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

        # 2. 実際に写真リンクが存在する全ディレクトリの枚数およびサムネイル生成済み枚数を取得
        cursor.execute(
            """
            SELECT pl.directory_path,
                   COUNT(DISTINCT pl.photo_id) as count,
                   COUNT(DISTINCT t.photo_id) as cached_count
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            LEFT JOIN thumbnails t ON p.id = t.photo_id
            WHERE COALESCE(p.is_unlinked, 0) = 0
            GROUP BY pl.directory_path
            ORDER BY pl.directory_path ASC
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
_PHOTO_DIR_SCAN_CACHE: Dict[Any, Any] = {}
_PHOTO_DIR_SCAN_TTL: float = 45.0


def clear_folders_fs_cache() -> None:
    """フォルダ集計および写真一覧用FS確認キャッシュをクリアする"""
    with _fs_cache_lock:
        _isdir_cache.clear()
        _scandir_cache.clear()
        _PHOTO_DIR_SCAN_CACHE.clear()
    from .connection import bump_db_commit_seq
    bump_db_commit_seq()


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

        # 1. 実際に写真リンクが登録されているディレクトリ一覧（VSN別に集計し、同一パスの別SDカードも識別）
        cursor.execute(
            """
            SELECT pl.directory_path,
                   NULLIF(pl.volume_serial, '') AS volume_serial,
                   COUNT(DISTINCT pl.photo_id) as count,
                   COUNT(DISTINCT t.photo_id) as cached_count
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            LEFT JOIN thumbnails t ON p.id = t.photo_id
            WHERE COALESCE(p.is_unlinked, 0) = 0
            GROUP BY pl.directory_path, pl.volume_serial
            ORDER BY pl.directory_path ASC
            """
        )
        rows = cursor.fetchall()
        result: List[Dict[str, Any]] = []
        managed_map: Dict[str, Dict[str, Any]] = {}

        for r in rows:
            d = dict(r)
            norm = normalize_folder_path(d["directory_path"])
            vol_serial = d.get("volume_serial")
            d["directory_path"] = norm
            d["has_all_thumbnails"] = (d["cached_count"] >= d["count"]) if d["count"] > 0 else True
            d["status"] = "managed"

            # 実フォルダの存在確認（VSN対応のオフライン/消失検出）
            is_present = False
            try:
                from ..scanner import resolve_portable_path
                _, is_online = resolve_portable_path(norm, expected_serial=vol_serial)
                is_present = is_online
            except Exception as e:
                logger.debug(f"フォルダ存在確認でのポータブルパス解決スキップ ({norm}): {e}")
                is_present = _cached_isdir(norm)
            d["is_missing"] = not is_present

            result.append(d)
            # 同一パスに複数VSNがある場合は接続中の方を managed_map の代表とする
            norm_key = norm.lower()
            if norm_key not in managed_map or is_present:
                managed_map[norm_key] = d

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
            # 配下に管理写真が存在する親ディレクトリまたは登録ルート自身が未登録なら managed（除外対象なら ignored）として追加
            is_drive_root = (os.path.dirname(p_dir) == p_dir)
            if p_key not in seen_paths and (not is_drive_root or any(p_key == r.lower() for r in roots)):
                is_ig = any(p_key == ig or p_key.startswith(ig + os.sep) for ig in ignored_set)
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
                    is_sub_managed_parent = sub_key in candidate_parents_dict
                    result.append({
                        "directory_path": sub_path,
                        "count": 0,
                        "cached_count": 0,
                        "has_all_thumbnails": True,
                        "status": "ignored" if is_sub_ignored else ("managed" if is_sub_managed_parent else "unmanaged"),
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
            SELECT UPPER(SUBSTR(pl.directory_path, 1, 2)) AS drive,
                   NULLIF(pl.volume_serial, '') AS volume_serial,
                   v.volume_label,
                   COALESCE(v.custom_name, '') AS custom_name,
                   COUNT(DISTINCT pl.photo_id) AS count
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            LEFT JOIN volumes v ON UPPER(pl.volume_serial) = UPPER(v.volume_serial)
            WHERE COALESCE(p.is_unlinked, 0) = 0
              AND pl.directory_path IS NOT NULL
              AND pl.directory_path != ''
              AND pl.directory_path LIKE '_:%'
            GROUP BY drive, pl.volume_serial
            """
        )
        return [dict(r) for r in cursor.fetchall()]


def get_directory_counts_under(
    folder_path: str,
    volume_serial: Optional[str] = None,
    serial_mode: str = "any",
) -> List[Dict[str, Any]]:
    """
    指定フォルダ配下（自身含む）のディレクトリごとの写真枚数を photo_links から集計する。
    """
    norm_folder = normalize_folder_path(folder_path).rstrip("\\/")
    dir_sql, params = _directory_filter_sql(folder_path, recursive=True, column_name="pl.directory_path")
    query = (
        f"SELECT pl.directory_path, COUNT(DISTINCT pl.photo_id) AS count "
        f"FROM photo_links pl INNER JOIN photos p ON pl.photo_id = p.id "
        f"WHERE COALESCE(p.is_unlinked, 0) = 0 AND {dir_sql}"
    )
    vs_upper = volume_serial.strip().upper() if volume_serial and volume_serial.strip() else ""
    if serial_mode == "match" and vs_upper:
        query += " AND UPPER(pl.volume_serial) = ?"
        params.append(vs_upper)
    elif serial_mode == "match_or_null" and vs_upper:
        query += " AND (UPPER(pl.volume_serial) = ? OR pl.volume_serial = '')"
        params.append(vs_upper)
    elif serial_mode == "null":
        query += " AND pl.volume_serial = ''"
    query += " GROUP BY pl.directory_path"

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        merged_counts: Dict[str, int] = {}
        for r in cursor.fetchall():
            d_norm = normalize_folder_path(r["directory_path"]).rstrip("\\/")
            merged_counts[d_norm] = merged_counts.get(d_norm, 0) + int(r["count"] or 0)

        # VSNが指定されておりドライブ文字パス（例: F: や F:\DCIM）の場合、
        # 別ドライブ文字で登録された同一VSNのリンクも現在のドライブ文字に読み替えて合算する
        if vs_upper and serial_mode in ("match", "match_or_null") and len(norm_folder) >= 2 and norm_folder[1] == ":":
            target_drive = norm_folder[:2].upper()
            target_tail = norm_folder[2:].lower()
            cursor.execute(
                """
                SELECT pl.directory_path, COUNT(DISTINCT pl.photo_id) AS count
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE COALESCE(p.is_unlinked, 0) = 0
                  AND UPPER(pl.volume_serial) = ?
                  AND pl.directory_path LIKE '_:%'
                  AND UPPER(SUBSTR(pl.directory_path, 1, 2)) != ?
                GROUP BY pl.directory_path
                """,
                (vs_upper, target_drive),
            )
            for r in cursor.fetchall():
                raw_dir = normalize_folder_path(r["directory_path"]).rstrip("\\/")
                if len(raw_dir) < 2 or raw_dir[1] != ":":
                    continue
                tail = raw_dir[2:]
                tail_lower = tail.lower()
                if not target_tail or tail_lower == target_tail or tail_lower.startswith(target_tail + "\\"):
                    remapped_dir = target_drive + tail
                    merged_counts[remapped_dir] = merged_counts.get(remapped_dir, 0) + int(r["count"] or 0)

        return [{"directory_path": k, "count": v} for k, v in merged_counts.items()]


def remove_folder_photos(
    directory_path: str,
    recursive: bool = True,
    volume_serial: Optional[str] = None,
) -> Dict[str, Any]:
    """
    指定したフォルダ内の写真リンクをDBから削除する（実ファイルは削除しない）。
    他フォルダ・他メディアにもリンクを持つ写真は残存リンクを代表にして保護し、
    リンクが0本になった写真のみDB（photos・photo_tags・thumbnails）から一括削除する。
    """
    from .photos import _sync_photo_links_state, _vsn_in_sql
    norm_path = os.path.normpath(directory_path)

    with get_connection() as conn:
        cursor = conn.cursor()

        sql_frag, sql_params = _directory_filter_sql(norm_path, recursive=recursive, column_name="directory_path")
        if volume_serial and volume_serial.strip():
            v_sql, v_params = _vsn_in_sql("volume_serial", volume_serial.strip())
            sql_frag = f"({sql_frag}) AND ({v_sql} OR volume_serial = '')"
            sql_params.extend(v_params)

        cursor.execute(
            f"SELECT id, photo_id, directory_path FROM photo_links WHERE {sql_frag}",
            sql_params,
        )
        link_rows = cursor.fetchall()
        deleted_link_count = len(link_rows)
        affected_subfolders = list({r["directory_path"] for r in link_rows if r["directory_path"]})
        affected_photo_ids = list(dict.fromkeys(r["photo_id"] for r in link_rows))

        if link_rows:
            link_ids = [r["id"] for r in link_rows]
            for i in range(0, len(link_ids), 500):
                chunk = link_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_links WHERE id IN ({placeholders})", chunk)

        zero_link_photo_ids: List[int] = []
        for pid in affected_photo_ids:
            rem = _sync_photo_links_state(cursor, pid)
            if rem == 0:
                zero_link_photo_ids.append(pid)

        if zero_link_photo_ids:
            for i in range(0, len(zero_link_photo_ids), 500):
                chunk = zero_link_photo_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)

        # scan_roots からも該当フォルダを削除（他メディアのリンクがまだ残っている場合は維持）
        rem_frag, rem_params = _directory_filter_sql(norm_path, recursive=recursive, column_name="directory_path")
        cursor.execute(f"SELECT 1 FROM photo_links WHERE {rem_frag} LIMIT 1", rem_params)
        has_remaining_photos = cursor.fetchone() is not None
        if not has_remaining_photos:
            root_frag, root_params = _directory_filter_sql(norm_path, recursive=recursive, column_name="folder_path")
            cursor.execute(f"DELETE FROM scan_roots WHERE {root_frag}", root_params)

        cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
        conn.commit()

        cursor.execute("SELECT 1 FROM photos LIMIT 1")
        should_vacuum = (cursor.fetchone() is None)

    if should_vacuum:
        try:
            from .stats import vacuum_database
            vacuum_database()
            print("[INFO] 全写真が解除されたため、DBを自動最適化（VACUUM）しました。")
        except Exception as e:
            print(f"[WARN] 自動VACUUM失敗: {e}")

    return {
        "deleted_count": len(affected_photo_ids),
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
