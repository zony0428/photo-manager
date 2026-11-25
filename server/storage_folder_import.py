"""
外部フォルダ単位での Loome 取り込みモジュール
フォルダ名および配下のサブフォルダ構造・RAW+JPEGペア・付随サイドカー・既存DBメタデータ（評価・タグ・調整値・サムネイル）を保持したまま
指定された Loome ルート／サブフォルダ配下へ一括コピー＆DB登録する。
"""

import concurrent.futures
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .database import (
    add_scan_root,
    compute_thumbnail_hash,
    get_connection,
    recalculate_stacks,
    upsert_volume,
)
from .database.connection import bump_db_commit_seq
from .database.folders import clear_folders_fs_cache, normalize_folder_path
from .database.photos import _sanitize_photo_data, _upsert_single_photo_in_tx
from .exporter import pick_folder_dialog
from .scanner import (
    SUPPORTED_EXTENSIONS,
    clear_online_cache,
    ensure_thumbnail,
    extract_metadata,
)
from .security import (
    assert_drive_not_blocked_by_foreign_loome,
    copy_file_unsealed,
    get_current_security_level,
    is_vault_encrypted_file,
    seal_loome_file,
)
from .sidecar import fast_copy_file, is_sidecar_file
from .storage_manager import (
    _allocate_unique_dest_path,
    _build_copied_photo_meta,
    _has_non_hidden_contents,
    _optimal_copy_workers,
    _sanitize_single_name,
    _update_storage_task_status,
    invalidate_loome_roots_cache,
    resolve_storage_target_with_root,
)
from .volume_info import get_volume_info

logger = logging.getLogger("photo_manager.storage")

_IGNORED_IMPORT_DIRS = {
    ".git", ".gemini", ".vscode", ".idea", ".cache", "cache",
    "__pycache__", "$recycle.bin", "system volume information", "take_out",
}


def _allocate_target_folder_dir(dest_base: Path, raw_folder_name: str) -> Path:
    """コピー先親フォルダ配下に作成するフォルダパスを決定する（既存の非空フォルダがある場合は連番付与）"""
    base_name = _sanitize_single_name(raw_folder_name) or "Imported_Folder"
    candidate = dest_base / base_name
    if not candidate.exists() or not _has_non_hidden_contents(candidate):
        return candidate
    idx = 1
    while True:
        cand = dest_base / f"{base_name}_{idx}"
        if not cand.exists() or not _has_non_hidden_contents(cand):
            return cand
        idx += 1


def import_folder_to_storage(
    source_dir: Optional[str] = None,
    destination: Optional[str] = "",
) -> Dict[str, Any]:
    """
    外部フォルダをフォルダ単位（サブフォルダ階層・サイドカー・RAWペア維持）で Loome 指定先へコピー＆DB登録する。
    source_dir 未指定時は OS ネイティブのフォルダ選択ダイアログを開く。
    """
    dest_base, active_root = resolve_storage_target_with_root(destination, must_exist=False)
    dest_base.mkdir(parents=True, exist_ok=True)

    if source_dir is None or not str(source_dir).strip():
        picked = pick_folder_dialog(title="Loome へ取り込むフォルダを選択してください")
        if not picked:
            return {"status": "cancelled"}
        src_dir = Path(picked).resolve()
    else:
        src_dir = Path(str(source_dir).strip()).resolve()

    if not src_dir.exists() or not src_dir.is_dir():
        raise ValueError(f"取り込み元のフォルダが見つかりません: {src_dir}")

    # 他人の Loome ドライブ保護（エシカルモード）チェック
    src_vol_info = get_volume_info(str(src_dir))
    src_vsn = (src_vol_info.get("serial") or "").upper() if src_vol_info else None
    assert_drive_not_blocked_by_foreign_loome(src_dir, volume_serial=src_vsn)

    raw_folder_name = src_dir.name or (src_dir.drive.rstrip(":\\/") if src_dir.drive else "Imported_Folder")
    dest_root = _allocate_target_folder_dir(dest_base, raw_folder_name).resolve()

    # 自己再帰コピー（コピー元がコピー先自身またはその親である場合）を遮断
    if dest_root == src_dir or src_dir in dest_root.parents:
        raise ValueError("取り込み元にコピー先フォルダ自身またはその親フォルダは指定できません")

    # 1. 取り込み対象ファイル（対応画像・RAW・サイドカー）の列挙
    dir_entries: List[Tuple[Path, Path, List[str]]] = []
    total_image_files = 0
    for root, dirs, files in os.walk(src_dir, topdown=True):
        dirs[:] = sorted(
            [
                d for d in dirs
                if not d.startswith(".")
                and not d.startswith("$")
                and d.lower() not in _IGNORED_IMPORT_DIRS
            ],
            key=lambda s: s.lower(),
        )
        curr_src = Path(root)
        rel = curr_src.relative_to(src_dir)
        if str(rel) == ".":
            curr_dest = dest_root
        else:
            clean_parts = [_sanitize_single_name(p) or "Subfolder" for p in rel.parts]
            curr_dest = dest_root.joinpath(*clean_parts)

        valid_files: List[str] = []
        for fn in sorted(files, key=lambda s: s.lower()):
            if fn.startswith("."):
                continue
            ext_low = os.path.splitext(fn)[1].lower()
            if ext_low in SUPPORTED_EXTENSIONS or is_sidecar_file(fn):
                valid_files.append(fn)
                if ext_low in SUPPORTED_EXTENSIONS:
                    total_image_files += 1
        if valid_files or curr_src == src_dir:
            dir_entries.append((curr_src, curr_dest, valid_files))

    if total_image_files == 0:
        raise ValueError(f"選択されたフォルダ「{src_dir.name}」内に取り込み可能な写真ファイルが見つかりませんでした")

    dest_root.mkdir(parents=True, exist_ok=True)
    add_scan_root(str(active_root))

    dest_root_norm = normalize_folder_path(str(dest_root)).rstrip("\\/")
    rel_label = str(dest_root.relative_to(active_root)).replace("/", "\\")

    dest_vol_info = get_volume_info(dest_root_norm)
    dest_vsn = dest_vol_info["serial"] if dest_vol_info else None
    if dest_vol_info and dest_vsn:
        try:
            upsert_volume(dest_vol_info["serial"], dest_vol_info["label"], dest_vol_info["drive"])
        except Exception as vol_err:
            logger.warning(f"Loome ボリューム情報更新スキップ: {vol_err}")

    _update_storage_task_status(
        is_running=True,
        task_type="import_folder",
        title=f"フォルダ「{dest_root.name}」を取り込み中...",
        current=0,
        total=total_image_files,
        current_file=rel_label,
    )

    new_ids: List[int] = []
    copied_sidecars = 0
    skipped = 0

    try:
        # 2. コピー計画の構築（同一ディレクトリ内の同名ステム ファイル群のステム名同期を維持）
        sidecar_tasks: List[Tuple[Path, Path]] = []
        image_tasks: List[Tuple[Path, Path, str]] = []  # (src_file, dest_file, dest_dir_norm)

        for curr_src, curr_dest, valid_files in dir_entries:
            curr_dest.mkdir(parents=True, exist_ok=True)
            curr_dest_norm = normalize_folder_path(str(curr_dest)).rstrip("\\/")
            reserved_lower: Set[str] = set()
            try:
                with os.scandir(curr_dest) as it:
                    for entry in it:
                        reserved_lower.add(entry.name.lower())
            except Exception:
                pass

            # 同名ステム（例: DSC0001.JPG + DSC0001.ARW + DSC0001.xmp）が別名に分裂しないようグループ化
            stem_groups: Dict[str, List[str]] = {}
            for fn in valid_files:
                stem_low = Path(fn).stem.lower()
                stem_groups.setdefault(stem_low, []).append(fn)

            for _, group_files in stem_groups.items():
                sample_stem = _sanitize_single_name(Path(group_files[0]).stem) or "Photo"
                exts = [Path(fn).suffix for fn in group_files]
                chosen_stem = sample_stem
                counter = 1
                while any(f"{chosen_stem}{ext}".lower() in reserved_lower for ext in exts):
                    chosen_stem = f"{sample_stem}_{counter}"
                    counter += 1

                for fn in group_files:
                    s_file = curr_src / fn
                    ext = Path(fn).suffix
                    # DSC0001.JPG.xmp 等の二重拡張子サイドカーにも対応
                    if is_sidecar_file(fn) and "." in Path(fn).stem:
                        inner_ext = Path(Path(fn).stem).suffix
                        d_name = f"{chosen_stem}{inner_ext}{ext}"
                        if d_name.lower() in reserved_lower:
                            d_file = _allocate_unique_dest_path(curr_dest, f"{chosen_stem}{inner_ext}", ext, reserved_lower)
                        else:
                            reserved_lower.add(d_name.lower())
                            d_file = curr_dest / d_name
                    else:
                        d_name = f"{chosen_stem}{ext}"
                        reserved_lower.add(d_name.lower())
                        d_file = curr_dest / d_name

                    if is_sidecar_file(fn):
                        sidecar_tasks.append((s_file, d_file))
                    else:
                        image_tasks.append((s_file, d_file, curr_dest_norm))

        # 2-A. サイドカーを先にコピー（直後の extract_metadata で XMP 補完情報を参照できるようにする）
        for s_sc, d_sc in sidecar_tasks:
            try:
                if is_vault_encrypted_file(s_sc):
                    copy_file_unsealed(s_sc, d_sc)
                else:
                    fast_copy_file(s_sc, d_sc)
                copied_sidecars += 1
            except Exception as sc_err:
                logger.warning(f"サイドカーのコピー失敗 ({s_sc}): {sc_err}")

        # 2-B. 画像・RAW本体の並列高速コピー
        prog_lock = threading.Lock()
        done_images = 0

        def _copy_one_image(task: Tuple[Path, Path, str]) -> Tuple[bool, Path, Path, str, int]:
            nonlocal done_images
            s_img, d_img, d_norm = task
            try:
                f_sz = s_img.stat().st_size
            except Exception:
                f_sz = 0
            try:
                if is_vault_encrypted_file(s_img):
                    copy_file_unsealed(s_img, d_img)
                else:
                    fast_copy_file(s_img, d_img, file_size=f_sz)
                with prog_lock:
                    done_images += 1
                    _update_storage_task_status(current=done_images, current_file=s_img.name)
                return True, s_img, d_img, d_norm, f_sz
            except Exception as cp_err:
                logger.warning(f"フォルダ取り込み中のファイルコピー失敗 ({s_img}): {cp_err}")
                with prog_lock:
                    done_images += 1
                    _update_storage_task_status(current=done_images, current_file=s_img.name)
                return False, s_img, d_img, d_norm, f_sz

        copied_items: List[Tuple[Path, Path, str]] = []
        if len(image_tasks) == 1:
            ok, s_i, d_i, d_n, _ = _copy_one_image(image_tasks[0])
            if ok:
                copied_items.append((s_i, d_i, d_n))
            else:
                skipped += 1
        elif len(image_tasks) > 1:
            workers = _optimal_copy_workers(src_dir, dest_root, 0, len(image_tasks))
            if workers <= 1:
                results = [_copy_one_image(t) for t in image_tasks]
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                    results = list(ex.map(_copy_one_image, image_tasks))
            for ok, s_i, d_i, d_n, _ in results:
                if ok:
                    copied_items.append((s_i, d_i, d_n))
                else:
                    skipped += 1

        # 3. コピー元が既に library.db に登録されている場合はメタデータ・評価・タグ・サムネイルを引き継ぎ、未登録なら extract_metadata
        src_norm_paths = [normalize_folder_path(str(s_i)) for s_i, _, _ in copied_items]
        existing_src_map: Dict[str, Dict[str, Any]] = {}
        with get_connection() as conn:
            cursor = conn.cursor()
            for i in range(0, len(src_norm_paths), 400):
                chunk = src_norm_paths[i : i + 400]
                ph = ",".join("?" for _ in chunk)
                for row in cursor.execute(
                    f"SELECT * FROM photos WHERE file_path IN ({ph}) COLLATE NOCASE",
                    chunk,
                ).fetchall():
                    existing_src_map[normalize_folder_path(row["file_path"]).lower()] = dict(row)
                for lk_row in cursor.execute(
                    f"""
                    SELECT pl.file_path AS lk_fp, p.*
                    FROM photo_links pl
                    INNER JOIN photos p ON pl.photo_id = p.id
                    WHERE pl.file_path IN ({ph}) COLLATE NOCASE
                    """,
                    chunk,
                ).fetchall():
                    k = normalize_folder_path(lk_row["lk_fp"]).lower()
                    if k not in existing_src_map:
                        existing_src_map[k] = dict(lk_row)

        prepared_records: List[Tuple[Optional[Dict[str, Any]], Dict[str, Any], Path]] = []
        for s_i, d_i, d_n in copied_items:
            src_rec = existing_src_map.get(normalize_folder_path(str(s_i)).lower())
            if src_rec:
                meta = _build_copied_photo_meta(src_rec, d_i, d_n, dest_vsn, paired_raw_norm=None)
            else:
                meta = extract_metadata(d_i)
                meta["file_path"] = normalize_folder_path(str(d_i))
                meta["directory_path"] = d_n
                meta["file_name"] = d_i.name
                meta["volume_serial"] = dest_vsn
            prepared_records.append((src_rec, meta, d_i))

        missing_thumbs: List[Tuple[int, str]] = []
        if prepared_records:
            with get_connection() as conn:
                cursor = conn.cursor()
                for src_rec, meta, d_i in prepared_records:
                    try:
                        new_id = _upsert_single_photo_in_tx(cursor, _sanitize_photo_data(meta))
                        if not new_id:
                            r_ins = cursor.execute(
                                "SELECT id FROM photos WHERE file_path = ? COLLATE NOCASE",
                                (meta["file_path"],),
                            ).fetchone()
                            new_id = int(r_ins["id"]) if r_ins else 0
                        if not new_id:
                            skipped += 1
                            continue

                        if src_rec:
                            src_id = int(src_rec["id"])
                            if new_id != src_id:
                                cursor.execute(
                                    """
                                    UPDATE photos
                                    SET rating = ?, rotation = ?, fine_angle = ?,
                                        crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?, crop_aspect = ?,
                                        brightness = ?, contrast = ?, saturation = ?,
                                        updated_at = CURRENT_TIMESTAMP
                                    WHERE id = ?
                                    """,
                                    (
                                        int(src_rec.get("rating") or 0),
                                        int(src_rec.get("rotation") or 0),
                                        float(src_rec.get("fine_angle") or 0.0),
                                        src_rec.get("crop_x"),
                                        src_rec.get("crop_y"),
                                        src_rec.get("crop_w"),
                                        src_rec.get("crop_h"),
                                        src_rec.get("crop_aspect"),
                                        int(src_rec.get("brightness") or 0),
                                        int(src_rec.get("contrast") or 0),
                                        int(src_rec.get("saturation") or 0),
                                        new_id,
                                    ),
                                )
                                tag_rows = cursor.execute(
                                    "SELECT tag, source, confidence FROM photo_tags WHERE photo_id = ?",
                                    (src_id,),
                                ).fetchall()
                                if tag_rows:
                                    cursor.executemany(
                                        "INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, ?, ?)",
                                        [
                                            (
                                                new_id,
                                                tr["tag"],
                                                tr["source"] or "manual",
                                                tr["confidence"] if tr["confidence"] is not None else 1.0,
                                            )
                                            for tr in tag_rows
                                        ],
                                    )
                            orig_thumb = cursor.execute(
                                "SELECT data, width, height FROM thumbnails WHERE photo_id = ?",
                                (src_id,),
                            ).fetchone()
                            if orig_thumb and orig_thumb["data"]:
                                if new_id != src_id:
                                    new_hash = compute_thumbnail_hash(meta["file_path"], meta.get("file_mtime"))
                                    cursor.execute(
                                        """
                                        INSERT INTO thumbnails (photo_id, data, width, height, file_hash)
                                        VALUES (?, ?, ?, ?, ?)
                                        ON CONFLICT(photo_id) DO UPDATE SET
                                            data = excluded.data,
                                            width = excluded.width,
                                            height = excluded.height,
                                            file_hash = excluded.file_hash,
                                            created_at = CURRENT_TIMESTAMP
                                        """,
                                        (new_id, orig_thumb["data"], orig_thumb["width"], orig_thumb["height"], new_hash),
                                    )
                            else:
                                missing_thumbs.append((new_id, meta["file_path"]))
                        else:
                            missing_thumbs.append((new_id, meta["file_path"]))

                        new_ids.append(new_id)
                    except Exception as db_err:
                        logger.error(f"フォルダ取り込みのDB登録エラー ({d_i}): {db_err}")
                        skipped += 1

                conn.commit()
                bump_db_commit_seq()

        # 4. RAW+JPEG ペア紐付け ＆ 連写・ブラケットスタック再計算（サブフォルダ含む）
        paired_raw_ids: Set[int] = set()
        if new_ids:
            try:
                recalculate_stacks(dest_root_norm, recursive=True)
            except Exception as st_err:
                logger.warning(f"フォルダ取り込み後のスタック再計算スキップ: {st_err}")

            try:
                uniq_new_ids = list(dict.fromkeys(new_ids))
                with get_connection() as conn:
                    cur = conn.cursor()
                    for idx_c in range(0, len(uniq_new_ids), 500):
                        chunk = uniq_new_ids[idx_c : idx_c + 500]
                        ph = ",".join(["?"] * len(chunk))
                        cur.execute(
                            f"""
                            SELECT id FROM photos
                            WHERE id IN ({ph})
                              AND COALESCE(is_raw, 0) = 1
                              AND paired_raw_path IS NOT NULL
                              AND paired_raw_path != ''
                            """,
                            chunk,
                        )
                        for row in cur.fetchall():
                            paired_raw_ids.add(int(row["id"]))
            except Exception as pr_err:
                logger.warning(f"ペア済みRAW判定スキップ: {pr_err}")

        # 5. 未生成サムネイルの生成（ペア済みRAW従属コマは不要な二重デコードを避けるためスキップ）
        for nid, fp in missing_thumbs:
            if nid in paired_raw_ids:
                continue
            try:
                ensure_thumbnail(nid, fp)
            except Exception as th_err:
                logger.warning(f"フォルダ取り込みのサムネイル生成スキップ ({fp}): {th_err}")

        # 6. Lv.2 フルロック時はコピー完了後にカプセル化保護を適用
        if get_current_security_level() == 2:
            for _, d_i, _ in copied_items:
                try:
                    if d_i.exists():
                        seal_loome_file(d_i)
                except Exception as seal_err:
                    logger.warning(f"フォルダ取り込み後のLv.2カプセル化警告 ({d_i}): {seal_err}")
    finally:
        _update_storage_task_status(is_running=False, current=total_image_files, current_file="")

    clear_folders_fs_cache()
    invalidate_loome_roots_cache()
    clear_online_cache()

    logical_entries = [nid for nid in new_ids if nid not in paired_raw_ids]
    logical_unique_ids = list(dict.fromkeys(logical_entries))
    return {
        "status": "ok",
        "imported_count": len(logical_entries),
        "raw_pair_count": len(paired_raw_ids),
        "sidecar_count": copied_sidecars,
        "skipped_count": skipped,
        "folder_name": dest_root.name,
        "destination_path": dest_root_norm,
        "destination_name": rel_label,
        "new_photo_ids": logical_unique_ids,
    }
