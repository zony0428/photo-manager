"""
フォルダ差分高速検知 ＆ ピンポイント差分リフレッシュモジュール

フォルダ選択時の高速差分判定（check_folder_diff）と、検出された変更ディレクトリ・変更ファイルのみを
対象に更新・リンク整理・スタック再計算を行う差分リフレッシュ（refresh_folder_diff）を提供する。
"""

import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .database import (
    backfill_missing_lens_models,
    cleanup_missing_photos_in_folder,
    close_thread_connection,
    copy_metadata_to_duplicate,
    delete_thumbnail,
    extract_folder_fingerprint,
    get_connection,
    get_existing_photos_map,
    get_ignored_folders,
    get_photo_by_path,
    get_scan_root_fingerprint,
    migrate_and_merge_exifless_photos,
    recalculate_stacks,
    update_scan_root_fingerprint,
    upsert_photos_batch,
    upsert_volume,
)
from .database.folders import SYSTEM_IGNORE_NAMES, clear_folders_fs_cache
from .database.stacks import recalculate_stacks_for_directories
from .volume_info import get_volume_info

logger = logging.getLogger("photo_manager.folder_diff")

_DIFF_IGNORE_DIRS = set(SYSTEM_IGNORE_NAMES) | {
    "import",
    ".cache",
    "cache",
    "uploads",
    "carry",
    "take_out",
    "$recycle.bin",
    "system volume information",
}


def _count_images_in_new_subdir_fast(
    subdir_path: str,
    ignored_set: Set[str],
    deadline: Optional[float],
    supported_extensions: Set[str],
) -> Tuple[int, bool]:
    """新規追加された子フォルダ内の対象画像数を時間予算内で高速カウントし (枚数, 打ち切り有無) を返す"""
    count = 0
    capped = False
    stack = [subdir_path]
    while stack:
        if deadline is not None and time.monotonic() >= deadline:
            capped = True
            break
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for entry in it:
                    if deadline is not None and time.monotonic() >= deadline:
                        capped = True
                        break
                    try:
                        if entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext in supported_extensions:
                                count += 1
                        elif entry.is_dir(follow_symlinks=False):
                            name_lower = entry.name.lower()
                            if name_lower.startswith(".") or name_lower in _DIFF_IGNORE_DIRS:
                                continue
                            full_sub = os.path.normpath(entry.path).lower()
                            if any(full_sub == ig or full_sub.startswith(ig + os.sep) for ig in ignored_set):
                                continue
                            stack.append(entry.path)
                    except OSError:
                        continue
        except OSError:
            continue
    return count, capped


def _is_drive_root_path(norm_win: str) -> bool:
    """パスがドライブルート（例: C:\\ や D:）かどうかを判定する"""
    return (os.path.dirname(norm_win) == norm_win) or bool(re.match(r"^[a-zA-Z]:\\?$", norm_win))


def _scan_dir_direct_files_and_subdirs(
    dir_path: str,
    ignored_set: Set[str],
    supported_extensions: Set[str],
) -> Tuple[Dict[str, Tuple[int, float]], Dict[str, Tuple[str, str]]]:
    """単一ディレクトリ直下の対象画像ファイル {lower_name: (size, mtime)} とサブフォルダ {lower_name: (name, path)} を返す"""
    files_map: Dict[str, Tuple[int, float]] = {}
    subdirs_map: Dict[str, Tuple[str, str]] = {}
    with os.scandir(dir_path) as it:
        for entry in it:
            try:
                if entry.is_file(follow_symlinks=False):
                    ext = os.path.splitext(entry.name)[1].lower()
                    if ext in supported_extensions:
                        st = entry.stat(follow_symlinks=False)
                        files_map[entry.name.lower()] = (st.st_size, st.st_mtime)
                elif entry.is_dir(follow_symlinks=False):
                    name_lower = entry.name.lower()
                    if name_lower.startswith(".") or name_lower in _DIFF_IGNORE_DIRS:
                        continue
                    full_sub = os.path.normpath(entry.path)
                    full_sub_lower = full_sub.lower()
                    if any(full_sub_lower == ig or full_sub_lower.startswith(ig + os.sep) for ig in ignored_set):
                        continue
                    subdirs_map[name_lower] = (entry.name, full_sub)
            except OSError:
                continue
    return files_map, subdirs_map


def check_folder_diff(
    target_dir_str: str,
    volume_serial: Optional[str] = None,
    timeout_sec: Optional[float] = 0.35,
) -> Dict[str, Any]:
    """
    指定ディレクトリおよび管理下サブフォルダの実ファイル構成とDBレコードを高速照合する。
    通り道の親フォルダやドライブルートでは未登録の兄弟・直下フォルダを巻き込まず、管理下スコープのみを判定する。
    """
    from . import scanner as _scanner
    from .security import assert_drive_not_blocked_by_foreign_loome
    from .storage_manager import is_path_in_storage

    supported_ext = _scanner.SUPPORTED_EXTENSIONS
    target_path = Path(target_dir_str)
    folder_deleted = False
    if not target_path.exists() or not target_path.is_dir():
        resolved_target, is_drive_online = _scanner.resolve_drive_online_path(
            target_dir_str, expected_serial=volume_serial
        )
        if not is_drive_online:
            return {"has_changes": False, "added": 0, "deleted": 0, "modified": 0, "is_valid": False}
        target_path = resolved_target
        target_dir_str = str(resolved_target)
        if not target_path.exists() or not target_path.is_dir():
            folder_deleted = True

    eff_serial = volume_serial
    if not eff_serial:
        probe_path = (
            str(target_path)
            if not folder_deleted
            else (f"{target_path.drive}\\" if target_path.drive else str(target_path))
        )
        vol_info = get_volume_info(probe_path)
        if vol_info and vol_info.get("serial"):
            eff_serial = vol_info["serial"]

    assert_drive_not_blocked_by_foreign_loome(target_dir_str, volume_serial=eff_serial)

    norm_win = os.path.normpath(target_dir_str).rstrip("\\/")
    if len(norm_win) == 2 and norm_win[1] == ":":
        norm_win_for_db = norm_win + "\\"
    else:
        norm_win_for_db = norm_win
    norm_win_prefix = norm_win.rstrip("\\/")
    norm_win_lower = norm_win_prefix.lower()
    is_drive_root = _is_drive_root_path(norm_win)

    ignored_set = {os.path.normpath(p).lower() for p in get_ignored_folders()}

    disk_files: Dict[str, Tuple[int, float]] = {}
    disk_subdirs: Dict[str, Tuple[str, str]] = {}
    if not folder_deleted:
        try:
            disk_files, disk_subdirs = _scan_dir_direct_files_and_subdirs(
                str(target_path), ignored_set, supported_ext
            )
        except Exception as e:
            logger.warning(f"check_folder_diff scandir エラー ({target_dir_str}): {e}")
            return {"has_changes": False, "added": 0, "deleted": 0, "modified": 0, "is_valid": False}

    db_files: Dict[str, Tuple[int, float]] = {}
    db_sub_files_by_dir: Dict[str, Dict[str, Tuple[int, float]]] = {}
    db_sub_cased_dirs: Dict[str, str] = {}
    db_direct_subdirs: Dict[str, str] = {}
    has_direct_child_with_photos = False
    is_managed = False
    is_explicit_scan_root = False
    nearest_ancestor_root_recursive: Optional[bool] = None
    descendant_recursive_roots: List[str] = []
    has_any_descendant_scan_root = False

    with get_connection() as conn:
        cursor = conn.cursor()
        if eff_serial:
            cursor.execute(
                """
                SELECT pl.file_name, p.file_size, COALESCE(pl.file_mtime, p.file_mtime) AS file_mtime
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.directory_path = ? COLLATE NOCASE
                  AND IFNULL(p.is_unlinked, 0) = 0
                  AND (pl.volume_serial = ? COLLATE NOCASE OR pl.volume_serial = '')
                """,
                (norm_win_for_db, eff_serial),
            )
        else:
            cursor.execute(
                """
                SELECT pl.file_name, p.file_size, COALESCE(pl.file_mtime, p.file_mtime) AS file_mtime
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.directory_path = ? COLLATE NOCASE
                  AND IFNULL(p.is_unlinked, 0) = 0
                """,
                (norm_win_for_db,),
            )
        for r in cursor.fetchall():
            db_files[r["file_name"].lower()] = (r["file_size"] or 0, r["file_mtime"] or 0.0)

        if eff_serial and len(norm_win_for_db) >= 2 and norm_win_for_db[1] == ":":
            rel_tail_dir = norm_win_for_db[2:]
            cursor.execute(
                """
                SELECT pl.file_name, p.file_size, COALESCE(pl.file_mtime, p.file_mtime) AS file_mtime
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.volume_serial = ? COLLATE NOCASE
                  AND pl.rel_dir = ? COLLATE NOCASE
                  AND IFNULL(p.is_unlinked, 0) = 0
                """,
                (eff_serial, rel_tail_dir),
            )
            for r in cursor.fetchall():
                fn = r["file_name"].lower()
                if fn not in db_files:
                    db_files[fn] = (r["file_size"] or 0, r["file_mtime"] or 0.0)

        escaped_prefix = (
            norm_win_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "\\\\%"
        )
        if eff_serial:
            cursor.execute(
                """
                SELECT pl.directory_path, pl.file_name, p.file_size, COALESCE(pl.file_mtime, p.file_mtime) AS file_mtime
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.directory_path LIKE ? ESCAPE '\\'
                  AND IFNULL(p.is_unlinked, 0) = 0
                  AND (pl.volume_serial = ? COLLATE NOCASE OR pl.volume_serial = '')
                """,
                (escaped_prefix, eff_serial),
            )
        else:
            cursor.execute(
                """
                SELECT pl.directory_path, pl.file_name, p.file_size, COALESCE(pl.file_mtime, p.file_mtime) AS file_mtime
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.directory_path LIKE ? ESCAPE '\\'
                  AND IFNULL(p.is_unlinked, 0) = 0
                """,
                (escaped_prefix,),
            )
        sub_rows = list(cursor.fetchall())

        if eff_serial and len(norm_win_prefix) >= 2 and norm_win_prefix[1] == ":":
            tail_base = norm_win_prefix[2:]
            escaped_tail_prefix = (
                tail_base.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "\\\\%"
            )
            cursor.execute(
                """
                SELECT pl.directory_path, pl.file_name, p.file_size, COALESCE(pl.file_mtime, p.file_mtime) AS file_mtime
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.volume_serial = ? COLLATE NOCASE
                  AND pl.rel_dir LIKE ? ESCAPE '\\'
                  AND IFNULL(p.is_unlinked, 0) = 0
                """,
                (eff_serial, escaped_tail_prefix),
            )
            sub_rows.extend(cursor.fetchall())

        prefix_len = len(norm_win_prefix) + 1
        for r in sub_rows:
            d_norm = os.path.normpath(r["directory_path"]).rstrip("\\/")
            if (
                eff_serial
                and len(norm_win_prefix) >= 2
                and norm_win_prefix[1] == ":"
                and len(d_norm) >= 2
                and d_norm[1] == ":"
            ):
                d_norm = norm_win_prefix[:2] + d_norm[2:]
            d_lower = d_norm.lower()
            if not d_lower.startswith(norm_win_lower + "\\"):
                continue
            rel = d_norm[prefix_len:]
            parts = rel.split("\\", 1)
            first_seg = parts[0]
            if first_seg:
                db_direct_subdirs.setdefault(first_seg.lower(), first_seg)
                if len(parts) == 1:
                    has_direct_child_with_photos = True
            db_sub_cased_dirs.setdefault(d_lower, d_norm)
            fmap = db_sub_files_by_dir.setdefault(d_lower, {})
            fmap[r["file_name"].lower()] = (r["file_size"] or 0, r["file_mtime"] or 0.0)

        cursor.execute("PRAGMA table_info(scan_roots)")
        sr_cols = {row["name"] for row in cursor.fetchall()}
        if "is_recursive" in sr_cols:
            cursor.execute("SELECT folder_path, is_recursive FROM scan_roots")
        else:
            cursor.execute("SELECT folder_path, NULL AS is_recursive FROM scan_roots")

        nearest_ancestor_len = -1
        for r in cursor.fetchall():
            sr_norm = os.path.normpath(r["folder_path"]).rstrip("\\/")
            sr_lower = sr_norm.lower()
            sr_rec_raw = r["is_recursive"]
            sr_is_rec = True if sr_rec_raw is None else bool(sr_rec_raw)

            # 別SDカードが同一ドライブ文字に刺さっている場合の誤一致を防止
            if eff_serial and (
                sr_lower == norm_win_lower
                or norm_win_lower.startswith(sr_lower + "\\")
                or sr_lower.startswith(norm_win_lower + "\\")
            ):
                cursor.execute(
                    """
                    SELECT id FROM photo_links
                    WHERE (directory_path = ? COLLATE NOCASE OR directory_path LIKE ? ESCAPE '\\')
                      AND volume_serial != '' AND volume_serial != ? COLLATE NOCASE
                    LIMIT 1
                    """,
                    (
                        sr_norm,
                        sr_norm.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "\\\\%",
                        eff_serial,
                    ),
                )
                if cursor.fetchone():
                    continue

            if sr_lower == norm_win_lower:
                is_explicit_scan_root = True
                if len(sr_lower) > nearest_ancestor_len:
                    nearest_ancestor_len = len(sr_lower)
                    nearest_ancestor_root_recursive = sr_is_rec
            elif not _is_drive_root_path(sr_norm) and norm_win_lower.startswith(sr_lower + "\\"):
                if len(sr_lower) > nearest_ancestor_len:
                    nearest_ancestor_len = len(sr_lower)
                    nearest_ancestor_root_recursive = sr_is_rec
            elif sr_lower.startswith(norm_win_lower + "\\"):
                has_any_descendant_scan_root = True
                if not is_drive_root:
                    rel = sr_norm[len(norm_win_prefix) + 1:]
                    first_seg = rel.split("\\", 1)[0]
                    if first_seg:
                        db_direct_subdirs.setdefault(first_seg.lower(), first_seg)
                if sr_is_rec and not _is_drive_root_path(sr_norm):
                    descendant_recursive_roots.append(sr_norm)

        in_loome = is_path_in_storage(norm_win_for_db, volume_serial=eff_serial)
        if len(db_files) > 0 or len(db_sub_files_by_dir) > 0 or is_explicit_scan_root or in_loome:
            is_managed = True

    # 管理スコープの判定（通り道の親フォルダやドライブルートで未登録フォルダを巻き込まない）
    if not is_managed:
        allow_direct_added = False
        allow_new_direct_subdirs = False
    elif in_loome:
        allow_direct_added = not is_drive_root
        allow_new_direct_subdirs = not is_drive_root
    elif nearest_ancestor_root_recursive is not None:
        allow_direct_added = (not is_drive_root) or is_explicit_scan_root
        allow_new_direct_subdirs = (not is_drive_root) and bool(nearest_ancestor_root_recursive)
    elif has_any_descendant_scan_root:
        # 配下に scan_roots を持つ上位コンテナ親（例: D:\ や D:\10.PHOTO）: 直下の未登録兄弟フォルダは対象外
        allow_direct_added = (not is_drive_root) and (len(db_files) > 0)
        allow_new_direct_subdirs = False
    else:
        # scan_roots 未経由の直接登録ケース: 直下または直下子フォルダに写真がある階層のみ対象
        allow_direct_added = (not is_drive_root) and (len(db_files) > 0 or has_direct_child_with_photos)
        allow_new_direct_subdirs = (not is_drive_root) and (len(db_files) > 0 or has_direct_child_with_photos)

    # 3. 直下ファイルの差分集計
    disk_keys = set(disk_files.keys())
    db_keys = set(db_files.keys())

    direct_added = len(disk_keys - db_keys) if allow_direct_added else 0
    direct_deleted = len(db_keys - disk_keys)
    direct_modified = 0
    for k in disk_keys & db_keys:
        d_sz, d_mt = disk_files[k]
        b_sz, b_mt = db_files[k]
        if (d_sz != b_sz and d_sz != b_sz + 72) or (b_mt > 0 and abs(d_mt - b_mt) >= 1e-4):
            direct_modified += 1

    dirty_direct_dirs: List[str] = []
    if is_managed and not folder_deleted and (direct_added > 0 or direct_deleted > 0 or direct_modified > 0):
        dirty_direct_dirs.append(norm_win_for_db)

    # 4. 子フォルダおよび子フォルダ内ファイルの差分集計
    added_folders: List[str] = []
    added_subdir_paths: List[str] = []
    deleted_folders: List[str] = []
    deleted_dir_paths: List[str] = []
    sub_added = 0
    sub_deleted = 0
    sub_modified = 0
    count_capped = False

    if is_managed:
        deadline = (time.monotonic() + timeout_sec) if (timeout_sec is not None and timeout_sec > 0) else None

        # (A) 管理下だった直下子フォルダがOS側で削除・移動されたケース
        if not is_drive_root:
            for sub_lower, sub_cased in db_direct_subdirs.items():
                if sub_lower not in disk_subdirs:
                    deleted_folders.append(sub_cased)
                    deleted_dir_paths.append(os.path.join(norm_win_prefix, sub_cased))

        # (B) 既存の管理下サブフォルダ内のファイル増減・変更チェック
        deleted_dir_lower_set = {p.lower() for p in deleted_dir_paths}
        for sub_dir_lower, sub_fmap in db_sub_files_by_dir.items():
            sub_dir_path = db_sub_cased_dirs[sub_dir_lower]
            if not os.path.isdir(sub_dir_path):
                sub_deleted += len(sub_fmap)
                rel_dir = sub_dir_path[len(norm_win_prefix) + 1:]
                first_seg = rel_dir.split("\\", 1)[0]
                if first_seg.lower() not in {d.lower() for d in deleted_folders} and rel_dir not in deleted_folders:
                    deleted_folders.append(rel_dir)
                if not any(
                    sub_dir_lower == dp or sub_dir_lower.startswith(dp + "\\")
                    for dp in deleted_dir_lower_set
                ):
                    deleted_dir_paths.append(sub_dir_path)
                    deleted_dir_lower_set.add(sub_dir_lower)
                continue

            if deadline is not None and time.monotonic() >= deadline:
                count_capped = True
                continue

            disk_sub_files: Dict[str, Tuple[int, float]] = {}
            try:
                with os.scandir(sub_dir_path) as it:
                    for entry in it:
                        try:
                            if entry.is_file(follow_symlinks=False):
                                ext = os.path.splitext(entry.name)[1].lower()
                                if ext in supported_ext:
                                    st = entry.stat(follow_symlinks=False)
                                    disk_sub_files[entry.name.lower()] = (st.st_size, st.st_mtime)
                        except OSError:
                            continue
            except OSError:
                continue

            ds_keys = set(disk_sub_files.keys())
            bs_keys = set(sub_fmap.keys())
            cur_add = len(ds_keys - bs_keys)
            cur_del = len(bs_keys - ds_keys)
            cur_mod = 0
            for k in ds_keys & bs_keys:
                d_sz, d_mt = disk_sub_files[k]
                b_sz, b_mt = sub_fmap[k]
                if (d_sz != b_sz and d_sz != b_sz + 72) or (b_mt > 0 and abs(d_mt - b_mt) >= 1e-4):
                    cur_mod += 1

            if cur_add > 0 or cur_del > 0 or cur_mod > 0:
                sub_added += cur_add
                sub_deleted += cur_del
                sub_modified += cur_mod
                dirty_direct_dirs.append(sub_dir_path)

        # (C) 再帰管理スコープ内での新規サブフォルダ検知
        if allow_new_direct_subdirs and not folder_deleted:
            for sub_lower, (sub_cased, sub_full_path) in disk_subdirs.items():
                if sub_lower not in db_direct_subdirs:
                    if deadline is not None and time.monotonic() >= deadline:
                        count_capped = True
                        break
                    img_in_sub, was_capped = _count_images_in_new_subdir_fast(
                        sub_full_path, ignored_set, deadline, supported_ext
                    )
                    if was_capped:
                        count_capped = True
                    if img_in_sub > 0:
                        added_folders.append(sub_cased)
                        added_subdir_paths.append(sub_full_path)
                        sub_added += img_in_sub

        # (D) 上位コンテナ親（D:\ や D:\10.PHOTO）クリック時、配下の再帰管理ルート内部に増えた新規サブフォルダも検知
        elif has_any_descendant_scan_root and not folder_deleted and descendant_recursive_roots:
            seen_new_paths: Set[str] = set()
            known_managed_dirs_lower = set(db_sub_files_by_dir.keys())
            for sr_root in descendant_recursive_roots:
                if deadline is not None and time.monotonic() >= deadline:
                    count_capped = True
                    break
                if not os.path.isdir(sr_root):
                    continue
                sr_root_lower = sr_root.lower()
                # 再帰管理ルート自身およびその配下の既知管理親フォルダ直下をチェック
                parent_candidates = {sr_root_lower: sr_root}
                for kd_low, kd_cased in db_sub_cased_dirs.items():
                    if kd_low.startswith(sr_root_lower + "\\"):
                        cur_p = kd_cased
                        while len(cur_p) > len(sr_root):
                            parent_candidates.setdefault(cur_p.lower(), cur_p)
                            nxt = os.path.dirname(cur_p).rstrip("\\/")
                            if nxt == cur_p or len(nxt) < len(sr_root):
                                break
                            cur_p = nxt

                for _, p_cased in parent_candidates.items():
                    if deadline is not None and time.monotonic() >= deadline:
                        count_capped = True
                        break
                    if not os.path.isdir(p_cased):
                        continue
                    try:
                        _, sub_entries = _scan_dir_direct_files_and_subdirs(
                            p_cased, ignored_set, supported_ext
                        )
                    except OSError:
                        continue
                    for _, (_, sub_full) in sub_entries.items():
                        sub_full_low = sub_full.lower()
                        if sub_full_low in seen_new_paths or sub_full_low in parent_candidates:
                            continue
                        if any(
                            kd == sub_full_low or kd.startswith(sub_full_low + "\\")
                            for kd in known_managed_dirs_lower
                        ):
                            continue
                        img_in_sub, was_capped = _count_images_in_new_subdir_fast(
                            sub_full, ignored_set, deadline, supported_ext
                        )
                        if was_capped:
                            count_capped = True
                        if img_in_sub > 0:
                            seen_new_paths.add(sub_full_low)
                            rel_label = sub_full[len(norm_win_prefix) + 1:]
                            added_folders.append(rel_label)
                            added_subdir_paths.append(sub_full)
                            sub_added += img_in_sub

    added_folders.sort()
    deleted_folders.sort()

    total_added = (direct_added + sub_added) if is_managed else 0
    total_deleted = (direct_deleted + sub_deleted) if is_managed else 0
    total_modified = (direct_modified + sub_modified) if is_managed else 0
    has_subfolder_changes = is_managed and bool(
        added_folders or deleted_folders or sub_added > 0 or sub_deleted > 0 or sub_modified > 0
    )

    has_changes = is_managed and (
        folder_deleted
        or total_added > 0
        or total_deleted > 0
        or total_modified > 0
        or len(added_folders) > 0
        or len(deleted_folders) > 0
    )
    return {
        "has_changes": has_changes,
        "is_managed": is_managed,
        "folder_deleted": folder_deleted and is_managed,
        "added": total_added,
        "deleted": total_deleted,
        "modified": total_modified,
        "direct_added": direct_added if is_managed else 0,
        "direct_deleted": direct_deleted if is_managed else 0,
        "direct_modified": direct_modified if is_managed else 0,
        "sub_added": sub_added if is_managed else 0,
        "sub_deleted": sub_deleted if is_managed else 0,
        "sub_modified": sub_modified if is_managed else 0,
        "added_folders": added_folders if is_managed else [],
        "deleted_folders": deleted_folders if is_managed else [],
        "added_folders_count": len(added_folders) if is_managed else 0,
        "deleted_folders_count": len(deleted_folders) if is_managed else 0,
        "has_subfolder_changes": has_subfolder_changes,
        "count_capped": count_capped,
        "dirty_direct_dirs": dirty_direct_dirs if is_managed else [],
        "added_subdir_paths": added_subdir_paths if is_managed else [],
        "deleted_dir_paths": deleted_dir_paths if is_managed else [],
        "is_valid": True,
        "total_disk": len(disk_files),
        "total_disk_subdirs": len(disk_subdirs),
        "total_db": len(db_files),
    }


def _collect_entries_for_target(
    cur_dir: str,
    recurse: bool,
    ignored_set: Set[str],
    supported_ext: Set[str],
    dir_xmp_map: Optional[Dict[str, Set[str]]] = None,
) -> List[Tuple[str, str, int, float]]:
    """対象ディレクトリの画像ファイル (abs_root, name, size, mtime) と .xmp 一覧を高速列挙する"""
    entries_out: List[Tuple[str, str, int, float]] = []
    stack_dirs = [cur_dir]
    while stack_dirs:
        root_s = stack_dirs.pop()
        abs_root = os.path.abspath(root_s)
        xmp_set: Set[str] = set()
        subdirs_to_visit: List[str] = []
        try:
            with os.scandir(root_s) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if not recurse:
                                continue
                            d_lower = entry.name.lower()
                            if entry.name.startswith(".") or d_lower in _DIFF_IGNORE_DIRS:
                                continue
                            full_d = os.path.normpath(entry.path).lower()
                            if any(full_d == ig or full_d.startswith(ig + os.sep) for ig in ignored_set):
                                continue
                            subdirs_to_visit.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext in supported_ext:
                                st = entry.stat(follow_symlinks=False)
                                entries_out.append((abs_root, entry.name, st.st_size, st.st_mtime))
                            elif ext == ".xmp":
                                xmp_set.add(entry.name.lower())
                    except OSError:
                        continue
        except OSError as scan_err:
            logger.debug(f"差分スキャン列挙スキップ ({root_s}): {scan_err}")
            continue
        if dir_xmp_map is not None:
            dir_xmp_map[abs_root] = xmp_set
        for sd in reversed(sorted(subdirs_to_visit)):
            stack_dirs.append(sd)
    return entries_out


def refresh_folder_diff(
    target_dir_str: str,
    volume_serial: Optional[str] = None,
) -> Dict[str, Any]:
    """
    check_folder_diff で検出される「実際に変更のある管理下ディレクトリ・新規サブフォルダ・消失フォルダ」のみを
    ピンポイントで更新する。無変更のサブフォルダや管理外の未登録フォルダは一切走査しない。
    """
    from . import scanner as _scanner
    from .security import (
        assert_drive_not_blocked_by_foreign_loome,
        get_current_security_level,
        get_logical_file_size,
        refresh_vsn_rescue_bundles_if_unlocked,
        seal_all_files_in_directory,
    )
    from .storage_manager import is_path_in_storage

    _scanner.clear_online_cache()
    clear_folders_fs_cache()

    target_dir = Path(target_dir_str)
    if not target_dir.exists() or not target_dir.is_dir():
        resolved_dir, is_drive_online = _scanner.resolve_drive_online_path(
            target_dir_str, expected_serial=volume_serial
        )
        if resolved_dir.exists() and resolved_dir.is_dir():
            target_dir = resolved_dir
            target_dir_str = str(resolved_dir)
        elif is_drive_online:
            return _scanner.scan_directory(
                target_dir_str,
                cleanup_orphans=True,
                recursive=True,
                volume_serial=volume_serial,
            )
        else:
            _scanner.scan_tracker.set_error(f"有効なディレクトリではありません: {target_dir_str}")
            raise ValueError(f"有効なディレクトリではありません: {target_dir_str}")

    _scanner.scan_tracker.start(target_dir_str)

    try:
        vol_info = get_volume_info(target_dir_str)
        eff_serial = volume_serial
        if vol_info:
            eff_serial = vol_info["serial"]
            upsert_volume(vol_info["serial"], vol_info["label"], vol_info["drive"])

        assert_drive_not_blocked_by_foreign_loome(target_dir_str, volume_serial=eff_serial)

        # 時間上限なしで管理スコープ内の差分ターゲットを確定
        diff = check_folder_diff(target_dir_str, volume_serial=eff_serial, timeout_sec=None)
        dirty_direct_dirs: List[str] = list(diff.get("dirty_direct_dirs") or [])
        added_subdir_paths: List[str] = list(diff.get("added_subdir_paths") or [])
        deleted_dir_paths: List[str] = list(diff.get("deleted_dir_paths") or [])

        if not dirty_direct_dirs and not added_subdir_paths and not deleted_dir_paths:
            empty_res = {
                "scanned": 0,
                "total_files": 0,
                "added": 0,
                "updated": 0,
                "relinked": 0,
                "unchanged": 0,
                "cleaned": 0,
                "stacks_created": 0,
                "added_or_updated": 0,
                "exifless_updated": 0,
                "exifless_merged": 0,
                "affected_dirs": [],
            }
            _scanner.scan_tracker.finish(empty_res)
            return empty_res

        ignored_set = {os.path.normpath(p).lower() for p in get_ignored_folders()}
        supported_ext = _scanner.SUPPORTED_EXTENSIONS

        _scanner.scan_tracker.set_phase("listing")

        from .database.photos import _has_xmp_sidecar_fast, sync_has_xmp_from_dir_scan_map

        # 変更対象ディレクトリのみをピンポイント列挙し、未変更ファイルは事前除外
        to_process: List[Tuple[str, str, int, float, Optional[Tuple[int, int, Optional[float]]], bool]] = []
        dir_known_paths: Dict[str, Set[str]] = {}
        dir_xmp_map: Dict[str, Set[str]] = {}
        all_existing_paths: Set[str] = set()
        enumerated_exact_dirs: Set[str] = set()
        enumerated_rec_roots: List[str] = []
        total_scanned = 0
        total_unchanged = 0

        scan_targets: List[Tuple[str, bool]] = (
            [(d, False) for d in dirty_direct_dirs] + [(d, True) for d in added_subdir_paths]
        )
        seen_target_keys: Set[Tuple[str, bool]] = set()

        for scan_dir_path, is_rec in scan_targets:
            norm_scan_dir = os.path.normcase(os.path.abspath(scan_dir_path)).rstrip("\\/")
            t_key = (norm_scan_dir, is_rec)
            if t_key in seen_target_keys or not os.path.isdir(scan_dir_path):
                continue
            seen_target_keys.add(t_key)
            if is_rec:
                enumerated_rec_roots.append(norm_scan_dir)
            else:
                enumerated_exact_dirs.add(norm_scan_dir)

            entries = _collect_entries_for_target(
                scan_dir_path, is_rec, ignored_set, supported_ext, dir_xmp_map=dir_xmp_map
            )
            ex_map = get_existing_photos_map(scan_dir_path, recursive=is_rec, volume_serial=eff_serial)
            in_loome_dir = is_path_in_storage(scan_dir_path, volume_serial=eff_serial)

            cur_paths: Set[str] = set()
            for abs_root, fname, raw_size, raw_mtime in entries:
                abs_fp = os.path.abspath(os.path.join(abs_root, fname))
                cur_paths.add(abs_fp)
                all_existing_paths.add(abs_fp)
                norm_key = os.path.normcase(abs_fp)
                existing = ex_map.get(norm_key)
                if existing is not None:
                    _, ex_size, ex_mtime = existing
                    if (
                        ex_mtime is not None
                        and abs(ex_mtime - raw_mtime) < 1e-4
                        and (ex_size == raw_size or (in_loome_dir and raw_size == ex_size + 72))
                    ):
                        total_scanned += 1
                        total_unchanged += 1
                        continue
                to_process.append((abs_root, fname, raw_size, raw_mtime, existing, in_loome_dir))

            if not is_rec:
                dir_known_paths[scan_dir_path] = cur_paths

        _scanner.scan_tracker.set_phase("scanning", total_files=len(to_process))

        total_added = 0
        total_updated = 0
        total_relinked = 0
        affected_dirs: Set[str] = set()
        loome_dirs_to_seal: Set[str] = set()
        batch_meta: List[Dict[str, Any]] = []
        dup_tag_pairs: List[Tuple[int, str]] = []

        def _flush_batch():
            nonlocal batch_meta, dup_tag_pairs
            if not batch_meta:
                return
            upsert_photos_batch(batch_meta)
            if dup_tag_pairs:
                for src_id, fpath_str in dup_tag_pairs:
                    p = get_photo_by_path(fpath_str, volume_serial=eff_serial)
                    if p:
                        copy_metadata_to_duplicate(src_id, p["id"])
                dup_tag_pairs.clear()
            batch_meta.clear()

        for idx, (abs_root, fname, raw_size, raw_mtime, existing, in_loome_dir) in enumerate(to_process, start=1):
            abs_path_str = os.path.abspath(os.path.join(abs_root, fname))
            full_path = Path(abs_path_str)
            total_scanned += 1
            try:
                if existing is not None:
                    ex_id, ex_size, ex_mtime = existing
                    st_size = get_logical_file_size(full_path)
                    if ex_mtime is not None and ex_size == st_size and abs(ex_mtime - raw_mtime) < 1e-4:
                        total_unchanged += 1
                        _scanner.scan_tracker.update_progress(idx, fname, "unchanged")
                        continue
                    delete_thumbnail(ex_id)

                meta = _scanner.extract_metadata(full_path)
                meta["volume_serial"] = eff_serial
                meta["has_xmp"] = (
                    1 if _has_xmp_sidecar_fast(abs_path_str, None, dir_file_set=dir_xmp_map.get(abs_root, set())) else 0
                )
                sync_action = _scanner.smart_sync_photo(meta, existing_record=existing, do_upsert=False)

                affected_dirs.add(abs_root)
                if in_loome_dir:
                    loome_dirs_to_seal.add(abs_root)

                if sync_action == "relinked":
                    total_relinked += 1
                elif sync_action == "added":
                    total_added += 1
                    if "_dup_source_id" in meta:
                        dup_tag_pairs.append((meta["_dup_source_id"], abs_path_str))
                    batch_meta.append(meta)
                else:
                    total_updated += 1
                    batch_meta.append(meta)

                if len(batch_meta) >= 200:
                    _flush_batch()

                _scanner.scan_tracker.update_progress(idx, fname, sync_action)
            except Exception as e:
                logger.warning(f"差分リフレッシュ個別ファイル処理失敗 ({full_path}): {e}")
                _scanner.scan_tracker.update_progress(idx, fname, "skip")
                continue

        _flush_batch()

        if dir_xmp_map:
            try:
                sync_has_xmp_from_dir_scan_map(dir_xmp_map, volume_serial=eff_serial)
            except Exception as xmp_sync_err:
                logger.debug(f"差分リフレッシュ時の has_xmp 同期スキップ: {xmp_sync_err}")

        # 削除・消失リンクのピンポイント整理
        cleaned_count = 0
        for del_dir in deleted_dir_paths:
            cleaned_count += cleanup_missing_photos_in_folder(
                del_dir,
                recursive=True,
                volume_serial=eff_serial,
                recalculate_stacks_after=False,
                out_affected_dirs=affected_dirs,
            )
        for dirty_dir in dirty_direct_dirs:
            cleaned_count += cleanup_missing_photos_in_folder(
                dirty_dir,
                recursive=False,
                volume_serial=eff_serial,
                known_existing_paths=dir_known_paths.get(dirty_dir),
                recalculate_stacks_after=False,
                out_affected_dirs=affected_dirs,
            )

        # 変更が発生したディレクトリのみ Exifなし画像統合・レンズ補完・スタック再計算を実行
        exifless_updated = 0
        exifless_merged = 0
        sorted_affected_dirs = sorted(affected_dirs)
        for aff_dir in sorted_affected_dirs:
            if not os.path.isdir(aff_dir):
                continue
            try:
                ex_res = migrate_and_merge_exifless_photos(
                    directory_path=aff_dir,
                    recursive=False,
                )
                exifless_updated += int(ex_res.get("updated") or 0)
                exifless_merged += int(ex_res.get("merged") or 0)
            except Exception as ex_err:
                logger.warning(f"差分リフレッシュ Exifなし統合警告 ({aff_dir}): {ex_err}")

            try:
                backfill_missing_lens_models(
                    directory_path=aff_dir,
                    recursive=False,
                )
            except Exception as bf_err:
                logger.warning(f"差分リフレッシュ レンズ補完警告 ({aff_dir}): {bf_err}")

        stacks_created = 0
        has_changes = (
            total_added > 0
            or total_updated > 0
            or total_relinked > 0
            or cleaned_count > 0
            or exifless_merged > 0
        )
        if has_changes and sorted_affected_dirs:
            _scanner.scan_tracker.set_phase("stacks")

            def _is_dir_enumerated(d_path: str) -> bool:
                dn = os.path.normcase(os.path.abspath(d_path)).rstrip("\\/")
                if dn in enumerated_exact_dirs:
                    return True
                return any(dn == r or dn.startswith(r + os.sep) for r in enumerated_rec_roots)

            stack_existing = (
                all_existing_paths
                if (all_existing_paths and all(_is_dir_enumerated(d) for d in sorted_affected_dirs))
                else None
            )
            if len(sorted_affected_dirs) == 1:
                stacks_created = recalculate_stacks(
                    sorted_affected_dirs[0],
                    recursive=False,
                    existing_paths=stack_existing,
                )
            else:
                stacks_created = recalculate_stacks_for_directories(
                    sorted_affected_dirs,
                    recursive=False,
                    existing_paths=stack_existing,
                )

        if has_changes:
            try:
                matched_root, _ = get_scan_root_fingerprint(target_dir_str)
                if matched_root and os.path.isdir(matched_root):
                    new_fp = extract_folder_fingerprint(matched_root)
                    update_scan_root_fingerprint(matched_root, new_fp)
            except Exception as fp_err:
                logger.debug(f"差分リフレッシュ指紋更新スキップ: {fp_err}")

            try:
                if get_current_security_level() == 2 and loome_dirs_to_seal:
                    for l_dir in sorted(loome_dirs_to_seal):
                        seal_all_files_in_directory(Path(l_dir))
            except Exception as seal_err:
                logger.warning(f"Lv.2 Loome カプセル化警告: {seal_err}")

            try:
                refresh_vsn_rescue_bundles_if_unlocked()
            except Exception as vsn_err:
                logger.warning(f"VSN救済バンドル更新警告: {vsn_err}")

        try:
            with get_connection() as ck_conn:
                ck_conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except Exception as ck_err:
            logger.debug(f"WALチェックポイント警告: {ck_err}")

        result = {
            "scanned": len(to_process),
            "total_files": len(to_process),
            "added": total_added,
            "updated": total_updated,
            "relinked": total_relinked,
            "unchanged": total_unchanged,
            "cleaned": cleaned_count,
            "stacks_created": stacks_created,
            "added_or_updated": total_added + total_updated + total_relinked,
            "exifless_updated": exifless_updated,
            "exifless_merged": exifless_merged,
            "affected_dirs": sorted_affected_dirs,
        }
        _scanner.scan_tracker.finish(result)

        if total_added > 0 or total_updated > 0 or total_relinked > 0:
            def _bg_preload():
                try:
                    from .preload_thumbnails import preload_all_thumbnails
                    preload_all_thumbnails()
                    with get_connection() as ck_conn:
                        ck_conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
                except Exception as e:
                    logger.warning(f"バックグラウンドサムネイル生成エラー: {e}")
                finally:
                    try:
                        close_thread_connection()
                    except Exception as close_err:
                        logger.debug(f"スレッドDB接続クローズ警告: {close_err}")

            threading.Thread(target=_bg_preload, daemon=True).start()

        _scanner.clear_online_cache()
        clear_folders_fs_cache()
        return result

    except Exception as e:
        _scanner.scan_tracker.set_error(str(e))
        raise
