"""
アプリ内ストレージ（storage フォルダ）管理モジュール
旧 carry フォルダからの自動移行、サブフォルダ作成・リネーム・空フォルダ削除、
外部写真のコピーインポート、storage 内での写真移動、単一/一括連番リネーム、
およびフォルダ単位の外部エクスポートを提供する。
"""

import logging
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .database import (
    compute_thumbnail_hash,
    get_connection,
    get_directory_counts_under,
    get_photo_by_id,
    get_photo_by_path,
    get_thumbnail,
    recalculate_stacks,
    save_thumbnail,
    upsert_photo,
    upsert_volume,
)
from .database.folders import clear_folders_fs_cache, normalize_folder_path
from .database.photos import _directory_filter_sql
from .exporter import open_folder_in_windows_explorer, pick_folder_dialog
from .scanner import (
    SUPPORTED_EXTENSIONS,
    clear_online_cache,
    ensure_thumbnail,
    extract_metadata,
    resolve_portable_path,
)
from .sidecar import (
    copy_sidecars_for_file,
    is_sidecar_file,
    move_sidecars_for_file,
    rename_sidecars_for_file,
    write_xmp_sidecar_for_photo,
)
from .volume_info import get_volume_info

logger = logging.getLogger("photo_manager.storage")

BASE_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = BASE_DIR / "storage"
LEGACY_CARRY_DIR = BASE_DIR / "carry"

# Windows ファイル名・フォルダ名禁止文字
_INVALID_WIN_CHARS_RE = re.compile(r'[\\/*?:"<>|\x00-\x1f]')
# Windows 予約デバイス名
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
}


def ensure_storage_dir() -> Path:
    """storage ルートフォルダを確実に作成してその Path を返す"""
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    return STORAGE_DIR


def _sanitize_single_name(name: str) -> str:
    """単一セグメントのフォルダ名・ファイル名ステムから Windows 禁止文字を除去する"""
    cleaned = _INVALID_WIN_CHARS_RE.sub("_", str(name or "").strip()).strip().rstrip(".")
    if cleaned.upper() in _WINDOWS_RESERVED_NAMES:
        cleaned = f"_{cleaned}"
    return cleaned


# 起動時に1回だけ解決・正規化した storage ルートパスキー（毎回の OS resolve() システムコールを回避）
_STORAGE_ROOT_KEY: str = normalize_folder_path(str(STORAGE_DIR.resolve())).rstrip("\\/").lower()
_STORAGE_ROOT_NO_DRIVE: str = _STORAGE_ROOT_KEY[2:] if (len(_STORAGE_ROOT_KEY) >= 2 and _STORAGE_ROOT_KEY[1] == ":") else ""


def _storage_root_key() -> str:
    """比較用の正規化済み storage ルートパス（小文字・末尾区切りなし）を返す"""
    return _STORAGE_ROOT_KEY


def is_path_in_storage(path_str: Optional[str]) -> bool:
    """
    指定パスが STORAGE_DIR 自身またはその配下であるかを高速・正確に判定する。
    ポータブル運用でドライブレターが変化した場合も考慮する。
    """
    if not path_str:
        return False

    storage_key = _STORAGE_ROOT_KEY
    norm = str(path_str).replace("/", "\\").rstrip("\\").lower()

    if norm == storage_key or norm.startswith(storage_key + "\\"):
        return True

    # ドライブレターが異なる場合、storage ルートのドライブ除外パスと一致するか確認
    if _STORAGE_ROOT_NO_DRIVE and len(norm) >= 2 and norm[1] == ":" and norm[0] != storage_key[0]:
        norm_no_drive = norm[2:]
        if norm_no_drive == _STORAGE_ROOT_NO_DRIVE or norm_no_drive.startswith(_STORAGE_ROOT_NO_DRIVE + "\\"):
            return True

    return False


def is_photo_in_storage(photo: Dict[str, Any]) -> bool:
    """写真辞書データ（directory_path または file_path）が storage 配下にあるか判定する"""
    if not photo:
        return False
    dir_path = photo.get("directory_path")
    if dir_path and is_path_in_storage(dir_path):
        return True
    file_path = photo.get("file_path")
    if file_path and is_path_in_storage(file_path):
        return True
    return False


def resolve_storage_target_dir(dest: Optional[str], must_exist: bool = False) -> Path:
    """
    storage 内のターゲットフォルダパスを解決し、パストラバーサル（..）を完全に遮断する。
    - dest が空/None なら STORAGE_DIR
    - 相対パスなら STORAGE_DIR / dest
    - STORAGE_DIR 配下の絶対パスならそのまま解決
    - STORAGE_DIR の外に出る場合は ValueError を送出
    """
    storage_root = ensure_storage_dir().resolve()
    storage_key = normalize_folder_path(str(storage_root)).rstrip("\\/").lower()

    if dest is None or not str(dest).strip() or str(dest).strip() == ".":
        target = storage_root
    else:
        raw = str(dest).strip().replace("/", "\\")
        raw_path = Path(raw)

        # パストラバーサル要素の明示的拒否
        if ".." in raw_path.parts:
            raise ValueError("不正なフォルダ指定です（親ディレクトリへの参照は許可されていません）")

        if raw_path.is_absolute() or (len(raw) >= 2 and raw[1] == ":"):
            candidate = raw_path.resolve()
            cand_key = normalize_folder_path(str(candidate)).rstrip("\\/").lower()
            # ドライブレター変更時のフォールバック解決
            if not (cand_key == storage_key or cand_key.startswith(storage_key + "\\")):
                resolved_port, _ = resolve_portable_path(raw)
                candidate = Path(resolved_port).resolve()
            target = candidate
        else:
            rel_cleaned = raw.lstrip("\\")
            # 先頭が "storage" 単独または "storage\..." で実際にそのサブフォルダが無い場合はルート基準として解釈
            target = (storage_root / rel_cleaned).resolve()

    target_key = normalize_folder_path(str(target)).rstrip("\\/").lower()
    if not (target_key == storage_key or target_key.startswith(storage_key + "\\")):
        raise ValueError("指定されたフォルダは storage の管理範囲外です")

    if must_exist:
        if not target.exists() or not target.is_dir():
            raise ValueError(f"指定されたフォルダが存在しません: {dest}")

    return target


def _unique_dest_path(dest_dir: Path, stem: str, ext: str, pair_ext: Optional[str] = None) -> Path:
    """
    dest_dir 内で衝突しないファイルパスを生成する（同名が存在する場合は stem_1.ext のように連番付与）。
    pair_ext が指定された場合はペアファイル側の衝突も同時に回避する。
    """
    candidate = dest_dir / f"{stem}{ext}"
    counter = 1
    while candidate.exists() or (pair_ext and (dest_dir / f"{candidate.stem}{pair_ext}").exists()):
        candidate = dest_dir / f"{stem}_{counter}{ext}"
        counter += 1
    return candidate


def _replace_prefix_case_insensitive(path_str: str, old_prefix: str, new_prefix: str) -> str:
    """パス文字列の先頭が old_prefix（大文字小文字無視）と一致する場合に new_prefix へ置換する"""
    norm_path = normalize_folder_path(path_str)
    norm_old = normalize_folder_path(old_prefix).rstrip("\\/")
    norm_new = normalize_folder_path(new_prefix).rstrip("\\/")

    low_path = norm_path.lower()
    low_old = norm_old.lower()
    if low_path == low_old:
        return norm_new
    if low_path.startswith(low_old + "\\"):
        return norm_new + norm_path[len(norm_old):]
    return norm_path


def migrate_carry_to_storage() -> int:
    """
    起動時に呼ばれ、旧 carry フォルダが存在する場合は中身をすべて storage フォルダへ安全に移行し、
    SQLite DB (photos, scan_roots, ignored_folders) のパス参照も新しい storage パスへ更新する。
    """
    storage_root = ensure_storage_dir().resolve()
    legacy_root = LEGACY_CARRY_DIR.resolve()

    moved_path_map: Dict[str, str] = {}  # old_norm_lower -> new_norm_str
    moved_files_count = 0

    # 1. 実ファイル・サブフォルダの移動
    if LEGACY_CARRY_DIR.exists() and LEGACY_CARRY_DIR.is_dir():
        try:
            for root, dirs, files in os.walk(legacy_root, topdown=True):
                root_path = Path(root)
                rel = root_path.relative_to(legacy_root)
                target_dir = storage_root if str(rel) == "." else (storage_root / rel)
                target_dir.mkdir(parents=True, exist_ok=True)

                for fname in files:
                    src_file = root_path / fname
                    dest_file = target_dir / fname
                    if dest_file.exists():
                        dest_file = _unique_dest_path(target_dir, src_file.stem, src_file.suffix)
                    try:
                        shutil.move(str(src_file), str(dest_file))
                        old_norm = normalize_folder_path(str(src_file))
                        new_norm = normalize_folder_path(str(dest_file))
                        moved_path_map[old_norm.lower()] = new_norm
                        moved_files_count += 1
                    except Exception as move_err:
                        logger.warning(f"carry から storage へのファイル移行失敗 ({src_file}): {move_err}")

            # 深い階層から空フォルダを削除
            for root, dirs, files in os.walk(legacy_root, topdown=False):
                rp = Path(root)
                try:
                    if not any(rp.iterdir()):
                        rp.rmdir()
                except Exception as rm_err:
                    logger.warning(f"旧 carry 空フォルダ削除スキップ ({rp}): {rm_err}")
        except Exception as e:
            logger.warning(f"carry フォルダ移行中に警告が発生しました: {e}")

    # 2. DB内の旧 carry パス参照を storage へ一括更新
    old_prefix = normalize_folder_path(str(legacy_root)).rstrip("\\/")
    new_prefix = normalize_folder_path(str(storage_root)).rstrip("\\/")
    updated_db_count = 0

    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            dir_sql, dir_params = _directory_filter_sql(old_prefix, recursive=True, column_name="directory_path")
            fp_sql, fp_params = _directory_filter_sql(old_prefix, recursive=True, column_name="file_path")
            pair_sql, pair_params = _directory_filter_sql(old_prefix, recursive=True, column_name="paired_raw_path")

            cursor.execute(
                f"""
                SELECT id, file_path, file_name, directory_path, paired_raw_path
                FROM photos
                WHERE {dir_sql} OR {fp_sql} OR {pair_sql}
                """,
                dir_params + fp_params + pair_params,
            )
            rows = cursor.fetchall()

            for r in rows:
                pid = r["id"]
                old_fp = r["file_path"] or ""
                old_dp = r["directory_path"] or ""
                old_pair = r["paired_raw_path"]

                mapped_fp = moved_path_map.get(normalize_folder_path(old_fp).lower())
                if mapped_fp:
                    new_fp = mapped_fp
                    new_dp = normalize_folder_path(str(Path(mapped_fp).parent))
                    new_fn = Path(mapped_fp).name
                else:
                    new_fp = _replace_prefix_case_insensitive(old_fp, old_prefix, new_prefix)
                    new_dp = _replace_prefix_case_insensitive(old_dp, old_prefix, new_prefix)
                    new_fn = Path(new_fp).name if new_fp else r["file_name"]

                new_pair = old_pair
                if old_pair:
                    mapped_pair = moved_path_map.get(normalize_folder_path(old_pair).lower())
                    if mapped_pair:
                        new_pair = mapped_pair
                    else:
                        new_pair = _replace_prefix_case_insensitive(old_pair, old_prefix, new_prefix)

                if new_fp != old_fp or new_dp != old_dp or new_pair != old_pair:
                    # 既に移行先パスで別レコードが存在する場合は重複回避
                    cursor.execute("SELECT id FROM photos WHERE file_path = ? AND id != ?", (new_fp, pid))
                    conflict = cursor.fetchone()
                    if conflict:
                        continue
                    cursor.execute(
                        """
                        UPDATE photos
                        SET file_path = ?, file_name = ?, directory_path = ?, paired_raw_path = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                        """,
                        (new_fp, new_fn, new_dp, new_pair, pid),
                    )
                    updated_db_count += 1

            # scan_roots の更新
            root_sql, root_params = _directory_filter_sql(old_prefix, recursive=True, column_name="folder_path")
            cursor.execute(f"SELECT id, folder_path FROM scan_roots WHERE {root_sql}", root_params)
            for sr in cursor.fetchall():
                new_sr_path = _replace_prefix_case_insensitive(sr["folder_path"], old_prefix, new_prefix)
                cursor.execute("SELECT id FROM scan_roots WHERE folder_path = ? AND id != ?", (new_sr_path, sr["id"]))
                if cursor.fetchone():
                    cursor.execute("DELETE FROM scan_roots WHERE id = ?", (sr["id"],))
                else:
                    cursor.execute("UPDATE scan_roots SET folder_path = ? WHERE id = ?", (new_sr_path, sr["id"]))

            # ignored_folders の更新
            ig_sql, ig_params = _directory_filter_sql(old_prefix, recursive=True, column_name="folder_path")
            cursor.execute(f"SELECT folder_path FROM ignored_folders WHERE {ig_sql}", ig_params)
            for ig in cursor.fetchall():
                old_ig = ig["folder_path"]
                new_ig = _replace_prefix_case_insensitive(old_ig, old_prefix, new_prefix)
                cursor.execute("DELETE FROM ignored_folders WHERE folder_path = ?", (old_ig,))
                cursor.execute(
                    "INSERT OR IGNORE INTO ignored_folders (folder_path, created_at) VALUES (?, datetime('now', 'localtime'))",
                    (new_ig,),
                )

            conn.commit()
    except Exception as db_err:
        logger.warning(f"carry から storage へのDBパス更新中に警告: {db_err}")

    if moved_files_count > 0 or updated_db_count > 0:
        clear_folders_fs_cache()
        clear_online_cache()
        logger.info(f"[Storage] carry から storage へ移行完了 (移動ファイル: {moved_files_count}, DB更新: {updated_db_count})")

    return max(moved_files_count, updated_db_count)


def get_storage_folders() -> Dict[str, Any]:
    """
    STORAGE_DIR 配下の全ディレクトリを再帰走査（隠しフォルダ・ドット始まりを除く）し、
    各フォルダ直下の画像ファイル枚数を集計して返す。
    """
    storage_root = ensure_storage_dir().resolve()
    storage_norm = normalize_folder_path(str(storage_root)).rstrip("\\/")

    # DB上のディレクトリ別枚数マップを取得
    db_counts: Dict[str, int] = {}
    try:
        for row in get_directory_counts_under(storage_norm):
            d_key = normalize_folder_path(row["directory_path"]).rstrip("\\/").lower()
            db_counts[d_key] = int(row["count"] or 0)
    except Exception as e:
        logger.warning(f"storage DB枚数集計スキップ: {e}")

    folders: List[Dict[str, Any]] = []

    for root, dirs, files in os.walk(storage_root, topdown=True):
        # 隠しフォルダ・ドット始まりを除外して昇順ソート
        dirs[:] = sorted(
            [d for d in dirs if not d.startswith(".") and not d.startswith("$")],
            key=lambda s: s.lower(),
        )
        curr_path = Path(root).resolve()
        curr_norm = normalize_folder_path(str(curr_path)).rstrip("\\/")
        curr_key = curr_norm.lower()

        # 実ファイルの対応画像枚数（DB未スキャン時のフォールバック）
        disk_img_count = sum(
            1 for f in files
            if not f.startswith(".") and os.path.splitext(f)[1].lower() in SUPPORTED_EXTENSIONS
        )
        count = db_counts.get(curr_key, disk_img_count)
        if count == 0 and disk_img_count > 0:
            count = disk_img_count

        if curr_path == storage_root:
            folders.append({
                "name": "storage (直下)",
                "rel_path": "",
                "path": curr_norm,
                "depth": 0,
                "count": count,
                "is_root": True,
            })
        else:
            rel_path_str = str(curr_path.relative_to(storage_root)).replace("/", "\\")
            depth = len(rel_path_str.split("\\"))
            folders.append({
                "name": curr_path.name,
                "rel_path": rel_path_str,
                "path": curr_norm,
                "depth": depth,
                "count": count,
                "is_root": False,
            })

    return {
        "storage_root": storage_norm,
        "folders": folders,
    }


def create_storage_subfolder(parent_path: Optional[str], folder_name: str) -> Dict[str, Any]:
    """
    storage 内の指定親フォルダ配下に新しいサブフォルダを作成する。
    """
    storage_root = ensure_storage_dir().resolve()
    parent_dir = resolve_storage_target_dir(parent_path, must_exist=True)

    raw_name = (folder_name or "").strip()
    if not raw_name:
        raise ValueError("フォルダ名を入力してください")

    # パス区切り（/ または \）による複数階層作成にも対応しつつ各セグメントをサニタイズ
    raw_segments = [seg.strip() for seg in re.split(r"[\\/]+", raw_name) if seg.strip()]
    if not raw_segments:
        raise ValueError("有効なフォルダ名を入力してください")

    clean_segments: List[str] = []
    for seg in raw_segments:
        if seg in (".", "..") or seg.startswith("."):
            raise ValueError("ドットで始まるフォルダ名や相対パス指定は使用できません")
        sanitized = _sanitize_single_name(seg)
        if not sanitized or sanitized in (".", "..") or sanitized.startswith("."):
            raise ValueError(f"無効なフォルダ名です: {seg}")
        clean_segments.append(sanitized)

    target = parent_dir.joinpath(*clean_segments).resolve()
    # 最終ターゲットも storage 範囲内であることを保証
    storage_key = _storage_root_key()
    target_key = normalize_folder_path(str(target)).rstrip("\\/").lower()
    if not target_key.startswith(storage_key + "\\"):
        raise ValueError("作成先フォルダが storage の範囲外です")

    target.mkdir(parents=True, exist_ok=True)
    clear_folders_fs_cache()

    rel_str = str(target.relative_to(storage_root)).replace("/", "\\")
    return {
        "status": "ok",
        "folder": {
            "name": target.name,
            "rel_path": rel_str,
            "path": normalize_folder_path(str(target)),
        },
    }


def rename_storage_subfolder(folder_path: str, new_name: str) -> Dict[str, Any]:
    """
    storage 内のサブフォルダ名を変更し、配下の写真のDBパス（file_path, directory_path, paired_raw_path）を一括更新する。
    """
    storage_root = ensure_storage_dir().resolve()
    target = resolve_storage_target_dir(folder_path, must_exist=True)

    if target == storage_root:
        raise ValueError("storage ルートフォルダ自体の名前は変更できません")

    raw_new = (new_name or "").strip()
    if not raw_new:
        raise ValueError("新しいフォルダ名を入力してください")
    if "/" in raw_new or "\\" in raw_new:
        raise ValueError("フォルダ名にパス区切り文字は使用できません")

    sanitized_name = _sanitize_single_name(raw_new)
    if not sanitized_name or sanitized_name in (".", "..") or sanitized_name.startswith("."):
        raise ValueError("無効なフォルダ名です")

    new_target = target.parent / sanitized_name
    old_norm = normalize_folder_path(str(target)).rstrip("\\/")
    new_norm = normalize_folder_path(str(new_target)).rstrip("\\/")

    if str(new_target) == str(target):
        return {
            "status": "ok",
            "old_path": old_norm,
            "new_path": new_norm,
            "new_name": sanitized_name,
            "updated_photos": 0,
        }

    is_case_only = (old_norm.lower() == new_norm.lower())
    if not is_case_only and new_target.exists():
        raise ValueError("同じ名前のフォルダが既に存在します")

    # Windows の大文字小文字のみ変更時は一時フォルダ名を経由して確実にリネーム
    try:
        if is_case_only:
            tmp_target = target.parent / f".__pm_dir_tmp_{uuid.uuid4().hex[:8]}"
            target.rename(tmp_target)
            tmp_target.rename(new_target)
        else:
            target.rename(new_target)
    except Exception as e:
        raise ValueError(f"フォルダのリネームに失敗しました: {e}")

    updated_count = 0
    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            dir_sql, dir_params = _directory_filter_sql(old_norm, recursive=True, column_name="directory_path")
            pair_sql, pair_params = _directory_filter_sql(old_norm, recursive=True, column_name="paired_raw_path")

            cursor.execute(
                f"""
                SELECT id, file_path, directory_path, paired_raw_path
                FROM photos
                WHERE {dir_sql} OR {pair_sql}
                """,
                dir_params + pair_params,
            )
            rows = cursor.fetchall()

            # UNIQUE(file_path) 制約の衝突を避けるため、一旦一時パスにしてから新パスへ更新
            batch_token = f".__pm_db_tmp_{uuid.uuid4().hex[:8]}_"
            updates_final = []
            for idx, r in enumerate(rows):
                pid = r["id"]
                old_fp = r["file_path"] or ""
                old_dp = r["directory_path"] or ""
                old_pair = r["paired_raw_path"]

                new_fp = _replace_prefix_case_insensitive(old_fp, old_norm, new_norm)
                new_dp = _replace_prefix_case_insensitive(old_dp, old_norm, new_norm)
                new_pair = _replace_prefix_case_insensitive(old_pair, old_norm, new_norm) if old_pair else None

                if new_fp != old_fp or new_dp != old_dp or new_pair != old_pair:
                    cursor.execute(
                        "UPDATE photos SET file_path = ? WHERE id = ?",
                        (f"{batch_token}{idx}_{pid}", pid),
                    )
                    updates_final.append((new_fp, new_dp, new_pair, pid))

            for new_fp, new_dp, new_pair, pid in updates_final:
                cursor.execute(
                    """
                    UPDATE photos
                    SET file_path = ?, directory_path = ?, paired_raw_path = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (new_fp, new_dp, new_pair, pid),
                )
                # サムネイルの file_hash も新パスに合わせて更新
                new_hash = compute_thumbnail_hash(new_fp)
                cursor.execute(
                    "UPDATE OR IGNORE thumbnails SET file_hash = ? WHERE photo_id = ?",
                    (new_hash, pid),
                )
                updated_count += 1

            # scan_roots の更新
            sr_sql, sr_params = _directory_filter_sql(old_norm, recursive=True, column_name="folder_path")
            cursor.execute(f"SELECT id, folder_path FROM scan_roots WHERE {sr_sql}", sr_params)
            for sr in cursor.fetchall():
                new_sr = _replace_prefix_case_insensitive(sr["folder_path"], old_norm, new_norm)
                cursor.execute("UPDATE OR IGNORE scan_roots SET folder_path = ? WHERE id = ?", (new_sr, sr["id"]))

            # ignored_folders の更新
            ig_sql, ig_params = _directory_filter_sql(old_norm, recursive=True, column_name="folder_path")
            cursor.execute(f"SELECT folder_path FROM ignored_folders WHERE {ig_sql}", ig_params)
            for ig in cursor.fetchall():
                old_ig = ig["folder_path"]
                new_ig = _replace_prefix_case_insensitive(old_ig, old_norm, new_norm)
                cursor.execute("DELETE FROM ignored_folders WHERE folder_path = ?", (old_ig,))
                cursor.execute(
                    "INSERT OR IGNORE INTO ignored_folders (folder_path, created_at) VALUES (?, datetime('now', 'localtime'))",
                    (new_ig,),
                )

            conn.commit()
    except Exception as e:
        logger.error(f"サブフォルダリネーム後のDB更新エラー ({old_norm} -> {new_norm}): {e}")
        raise ValueError(f"フォルダ名の更新中にデータベースエラーが発生しました: {e}")

    clear_folders_fs_cache()
    clear_online_cache()

    return {
        "status": "ok",
        "old_path": old_norm,
        "new_path": new_norm,
        "new_name": sanitized_name,
        "updated_photos": updated_count,
    }


def delete_storage_subfolder(folder_path: str) -> Dict[str, Any]:
    """
    storage 内の空のサブフォルダを削除する。
    ファイルまたはサブフォルダが1つでも存在する場合は ValueError を送出する。
    """
    storage_root = ensure_storage_dir().resolve()
    target = resolve_storage_target_dir(folder_path, must_exist=True)

    if target == storage_root:
        raise ValueError("storage ルートフォルダ自体は削除できません")

    if any(target.iterdir()):
        raise ValueError("フォルダが空ではないため削除できません。先に中の写真を移動または削除してください。")

    target_norm = normalize_folder_path(str(target)).rstrip("\\/")
    try:
        target.rmdir()
    except Exception as e:
        raise ValueError(f"フォルダの削除に失敗しました: {e}")

    # scan_roots / ignored_folders に残っていれば整理
    try:
        with get_connection() as conn:
            conn.execute("DELETE FROM scan_roots WHERE folder_path = ? COLLATE NOCASE", (target_norm,))
            conn.execute("DELETE FROM ignored_folders WHERE folder_path = ? COLLATE NOCASE", (target_norm,))
            conn.commit()
    except Exception as e:
        logger.warning(f"フォルダ削除後のDB設定クリーンアップスキップ ({target_norm}): {e}")

    clear_folders_fs_cache()
    clear_online_cache()

    return {
        "status": "ok",
        "deleted_path": target_norm,
    }


def import_photos_to_storage(photo_ids: List[int], destination: Optional[str] = "") -> Dict[str, Any]:
    """
    閲覧中の写真を storage 内の指定フォルダへ物理コピーし、メタデータ・評価・調整値・GPS・タグ・サムネイルを
    引き継いで DB 登録する。
    """
    if not photo_ids:
        raise ValueError("インポートする写真が選択されていません")

    storage_root = ensure_storage_dir().resolve()
    dest_dir = resolve_storage_target_dir(destination, must_exist=False)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_norm = normalize_folder_path(str(dest_dir)).rstrip("\\/")

    if dest_dir == storage_root:
        rel_label = "storage (直下)"
    else:
        rel_label = str(dest_dir.relative_to(storage_root)).replace("/", "\\")

    vol_info = get_volume_info(dest_norm)
    volume_serial = vol_info["serial"] if vol_info else None
    if vol_info and volume_serial:
        try:
            upsert_volume(vol_info["serial"], vol_info["label"], vol_info["drive"])
        except Exception as e:
            logger.warning(f"storage ボリューム情報更新スキップ: {e}")

    new_ids: List[int] = []
    skipped = 0

    for raw_pid in photo_ids:
        photo = get_photo_by_id(int(raw_pid))
        if not photo:
            skipped += 1
            continue

        src_path_str = photo.get("file_path")
        if not src_path_str:
            skipped += 1
            continue

        src_path, is_online = resolve_portable_path(src_path_str)
        if not is_online or not src_path.exists():
            skipped += 1
            continue

        src_parent_norm = normalize_folder_path(str(src_path.parent)).rstrip("\\/")
        if src_parent_norm.lower() == dest_norm.lower():
            skipped += 1
            continue

        # ペアRAWの確認
        pair_src: Optional[Path] = None
        paired_raw_str = photo.get("paired_raw_path")
        if paired_raw_str:
            p_cand, p_online = resolve_portable_path(paired_raw_str)
            if p_online and p_cand.exists() and p_cand.resolve() != src_path.resolve():
                pair_src = p_cand

        pair_ext = pair_src.suffix if pair_src else None
        dest_file = _unique_dest_path(dest_dir, src_path.stem, src_path.suffix, pair_ext=pair_ext)
        dest_pair_file: Optional[Path] = None
        if pair_src:
            dest_pair_file = dest_dir / f"{dest_file.stem}{pair_src.suffix}"

        try:
            shutil.copy2(str(src_path), str(dest_file))
            copy_sidecars_for_file(src_path, dest_file)
            if pair_src and dest_pair_file:
                shutil.copy2(str(pair_src), str(dest_pair_file))
                copy_sidecars_for_file(pair_src, dest_pair_file)
        except Exception as copy_err:
            logger.warning(f"storage への写真コピー失敗 ({src_path}): {copy_err}")
            skipped += 1
            continue

        try:
            meta = extract_metadata(dest_file)
            meta["file_path"] = normalize_folder_path(str(dest_file))
            meta["directory_path"] = dest_norm
            meta["file_name"] = dest_file.name
            meta["volume_serial"] = volume_serial

            # 元写真の GPS・ロケーション情報の引き継ぎ
            if photo.get("latitude") is not None and photo.get("longitude") is not None:
                meta["latitude"] = photo["latitude"]
                meta["longitude"] = photo["longitude"]
                meta["gps_source"] = photo.get("gps_source") or meta.get("gps_source")
                meta["country"] = photo.get("country") or photo.get("location_country") or meta.get("country")
                meta["state"] = photo.get("state") or photo.get("location_state") or meta.get("state")
                meta["city"] = photo.get("city") or photo.get("location_city") or meta.get("city")

            if dest_pair_file and dest_pair_file.exists():
                meta["paired_raw_path"] = normalize_folder_path(str(dest_pair_file))

            new_id = upsert_photo(meta)
            if not new_id:
                inserted = get_photo_by_path(meta["file_path"])
                new_id = inserted["id"] if inserted else 0

            if not new_id:
                skipped += 1
                continue

            # ペアRAWもコピーした場合は DB に登録しておくことで recalculate_stacks でのペア解除を防止
            if dest_pair_file and dest_pair_file.exists():
                try:
                    pair_meta = extract_metadata(dest_pair_file)
                    pair_meta["file_path"] = normalize_folder_path(str(dest_pair_file))
                    pair_meta["directory_path"] = dest_norm
                    pair_meta["file_name"] = dest_pair_file.name
                    pair_meta["volume_serial"] = volume_serial
                    pair_meta["paired_raw_path"] = meta["file_path"]
                    upsert_photo(pair_meta)
                except Exception as pm_err:
                    logger.warning(f"ペアRAWのメタデータ登録スキップ ({dest_pair_file}): {pm_err}")

            # 評価・非破壊調整パラメータ・タグの引き継ぎ
            with get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    UPDATE photos
                    SET rating = ?,
                        rotation = ?,
                        fine_angle = ?,
                        crop_x = ?,
                        crop_y = ?,
                        crop_w = ?,
                        crop_h = ?,
                        crop_aspect = ?,
                        brightness = ?,
                        contrast = ?,
                        saturation = ?,
                        paired_raw_path = COALESCE(?, paired_raw_path),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (
                        int(photo.get("rating") or 0),
                        int(photo.get("rotation") or 0),
                        float(photo.get("fine_angle") or 0.0),
                        photo.get("crop_x"),
                        photo.get("crop_y"),
                        photo.get("crop_w"),
                        photo.get("crop_h"),
                        photo.get("crop_aspect"),
                        int(photo.get("brightness") or 0),
                        int(photo.get("contrast") or 0),
                        int(photo.get("saturation") or 0),
                        meta.get("paired_raw_path"),
                        new_id,
                    ),
                )

                # タグ（source, confidence 含む）のコピー
                cursor.execute(
                    "SELECT tag, source, confidence FROM photo_tags WHERE photo_id = ?",
                    (photo["id"],),
                )
                tag_rows = cursor.fetchall()
                if tag_rows:
                    cursor.executemany(
                        "INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, ?, ?)",
                        [(new_id, tr["tag"], tr["source"] or "manual", tr["confidence"] if tr["confidence"] is not None else 1.0) for tr in tag_rows],
                    )
                conn.commit()

            # サムネイルのコピー（未生成なら生成）
            orig_thumb = get_thumbnail(photo["id"])
            if orig_thumb and orig_thumb.get("data"):
                new_hash = compute_thumbnail_hash(meta["file_path"], meta.get("file_mtime"))
                save_thumbnail(new_id, orig_thumb["data"], orig_thumb["width"], orig_thumb["height"], new_hash)
            else:
                try:
                    ensure_thumbnail(new_id, meta["file_path"])
                except Exception as th_err:
                    logger.warning(f"インポート写真のサムネイル生成スキップ ({dest_file}): {th_err}")

            new_ids.append(new_id)
        except Exception as db_err:
            logger.error(f"インポート写真のDB登録エラー ({dest_file}): {db_err}")
            skipped += 1

    if new_ids:
        try:
            recalculate_stacks(dest_norm, recursive=False)
        except Exception as st_err:
            logger.warning(f"storage インポート後のスタック再計算スキップ: {st_err}")

    clear_folders_fs_cache()
    clear_online_cache()

    return {
        "status": "ok",
        "imported_count": len(new_ids),
        "skipped_count": skipped,
        "destination_path": dest_norm,
        "destination_name": rel_label,
        "new_photo_ids": new_ids,
    }


def move_photos_in_storage(photo_ids: List[int], destination: Optional[str] = "") -> Dict[str, Any]:
    """
    storage 内の写真を指定された storage 内サブフォルダ（または直下）へ移動し、
    同一 ID レコードのパス情報を更新する。
    """
    if not photo_ids:
        raise ValueError("移動する写真が選択されていません")

    storage_root = ensure_storage_dir().resolve()
    dest_dir = resolve_storage_target_dir(destination, must_exist=False)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_norm = normalize_folder_path(str(dest_dir)).rstrip("\\/")

    if dest_dir == storage_root:
        rel_label = "storage (直下)"
    else:
        rel_label = str(dest_dir.relative_to(storage_root)).replace("/", "\\")

    moved = 0
    skipped = 0

    with get_connection() as conn:
        cursor = conn.cursor()
        for raw_pid in photo_ids:
            photo = get_photo_by_id(int(raw_pid))
            if not photo or not is_photo_in_storage(photo):
                skipped += 1
                continue

            src_path_str = photo.get("file_path")
            if not src_path_str:
                skipped += 1
                continue

            src_path, is_online = resolve_portable_path(src_path_str)
            if not is_online or not src_path.exists():
                skipped += 1
                continue

            src_parent_norm = normalize_folder_path(str(src_path.parent)).rstrip("\\/")
            if src_parent_norm.lower() == dest_norm.lower():
                skipped += 1
                continue

            # ペアRAWが storage 内に存在する場合は連動移動
            pair_src: Optional[Path] = None
            paired_raw_str = photo.get("paired_raw_path")
            if paired_raw_str and is_path_in_storage(paired_raw_str):
                p_cand, p_online = resolve_portable_path(paired_raw_str)
                if p_online and p_cand.exists() and p_cand.resolve() != src_path.resolve():
                    pair_src = p_cand

            pair_ext = pair_src.suffix if pair_src else None
            dest_file = _unique_dest_path(dest_dir, src_path.stem, src_path.suffix, pair_ext=pair_ext)
            dest_pair_file: Optional[Path] = None
            if pair_src:
                dest_pair_file = dest_dir / f"{dest_file.stem}{pair_src.suffix}"

            try:
                move_sidecars_for_file(src_path, dest_file)
                shutil.move(str(src_path), str(dest_file))
                if pair_src and dest_pair_file:
                    move_sidecars_for_file(pair_src, dest_pair_file)
                    shutil.move(str(pair_src), str(dest_pair_file))
            except Exception as mv_err:
                logger.warning(f"storage 内の写真移動失敗 ({src_path}): {mv_err}")
                skipped += 1
                continue

            new_fp = normalize_folder_path(str(dest_file))
            new_pair_fp = normalize_folder_path(str(dest_pair_file)) if dest_pair_file else paired_raw_str

            cursor.execute(
                """
                UPDATE photos
                SET file_path = ?, directory_path = ?, file_name = ?, paired_raw_path = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (new_fp, dest_norm, dest_file.name, new_pair_fp, photo["id"]),
            )
            new_hash = compute_thumbnail_hash(new_fp)
            cursor.execute(
                "UPDATE OR IGNORE thumbnails SET file_hash = ? WHERE photo_id = ?",
                (new_hash, photo["id"]),
            )

            # ペアRAW自身のレコードが photos にあれば同時更新
            if pair_src and dest_pair_file and new_pair_fp:
                old_pair_norm = normalize_folder_path(str(pair_src))
                cursor.execute(
                    """
                    UPDATE photos
                    SET file_path = ?, directory_path = ?, file_name = ?, paired_raw_path = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE file_path = ? COLLATE NOCASE
                    """,
                    (new_pair_fp, dest_norm, dest_pair_file.name, new_fp, old_pair_norm),
                )

            moved += 1

        conn.commit()

    clear_folders_fs_cache()
    clear_online_cache()

    return {
        "status": "ok",
        "moved_count": moved,
        "skipped_count": skipped,
        "destination_path": dest_norm,
        "destination_name": rel_label,
    }


def rename_photo_in_storage(photo_id: int, new_name: str) -> Dict[str, Any]:
    """
    storage 内の単一写真のファイル名を変更する（元の拡張子は維持し、同フォルダのペアRAWも連動リネーム）。
    """
    photo = get_photo_by_id(int(photo_id))
    if not photo:
        raise ValueError("写真が見つかりません")

    if not is_photo_in_storage(photo):
        raise ValueError("storage 内の写真のみファイル名を変更できます")

    src_path, is_online = resolve_portable_path(photo["file_path"])
    if not is_online or not src_path.exists():
        raise ValueError("対象の写真ファイルが見つかりません")

    raw_new = (new_name or "").strip()
    if not raw_new:
        raise ValueError("新しいファイル名を入力してください")

    orig_ext = src_path.suffix
    if orig_ext and raw_new.lower().endswith(orig_ext.lower()):
        stem_part = raw_new[:-len(orig_ext)]
    else:
        stem_part = raw_new

    clean_stem = _sanitize_single_name(stem_part)
    if not clean_stem or clean_stem in (".", ".."):
        raise ValueError("無効なファイル名です")

    new_path = src_path.parent / f"{clean_stem}{orig_ext}"
    old_name = src_path.name
    new_norm = normalize_folder_path(str(new_path))

    if str(new_path) == str(src_path):
        return {
            "status": "ok",
            "photo_id": photo_id,
            "old_name": old_name,
            "new_name": new_path.name,
            "new_path": new_norm,
        }

    is_case_only = (str(new_path).lower() == str(src_path).lower())
    if not is_case_only and new_path.exists():
        raise ValueError("同じ名前のファイルが既に存在します")

    # storage 内のペアRAW確認（同フォルダだけでなく storage 配下の別サブフォルダにあるペアRAWも連動リネーム）
    pair_src: Optional[Path] = None
    pair_new: Optional[Path] = None
    paired_raw_str = photo.get("paired_raw_path")
    if paired_raw_str and is_path_in_storage(paired_raw_str):
        p_cand, p_online = resolve_portable_path(paired_raw_str)
        if (
            p_online
            and p_cand.exists()
            and is_path_in_storage(str(p_cand))
            and p_cand.resolve() != src_path.resolve()
        ):
            pair_src = p_cand
            pair_new = pair_src.parent / f"{clean_stem}{pair_src.suffix}"
            pair_is_case_only = (str(pair_new).lower() == str(pair_src).lower())
            if not pair_is_case_only and pair_new.exists():
                raise ValueError(f"ペアのRAWファイルと同名のファイルが既に存在します: {pair_new.name}")

    try:
        if is_case_only:
            tmp_file = src_path.parent / f".__pm_file_tmp_{uuid.uuid4().hex[:8]}{orig_ext}"
            src_path.rename(tmp_file)
            tmp_file.rename(new_path)
            rename_sidecars_for_file(src_path, new_path)
            if pair_src and pair_new:
                tmp_pair = pair_src.parent / f".__pm_pair_tmp_{uuid.uuid4().hex[:8]}{pair_src.suffix}"
                pair_src.rename(tmp_pair)
                tmp_pair.rename(pair_new)
                rename_sidecars_for_file(pair_src, pair_new)
        else:
            src_path.rename(new_path)
            rename_sidecars_for_file(src_path, new_path)
            if pair_src and pair_new:
                pair_src.rename(pair_new)
                rename_sidecars_for_file(pair_src, pair_new)
    except Exception as e:
        raise ValueError(f"ファイル名の変更に失敗しました: {e}")

    new_pair_norm = normalize_folder_path(str(pair_new)) if pair_new else paired_raw_str

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET file_name = ?, file_path = ?, paired_raw_path = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (new_path.name, new_norm, new_pair_norm, photo_id),
        )
        new_hash = compute_thumbnail_hash(new_norm)
        cursor.execute(
            "UPDATE OR IGNORE thumbnails SET file_hash = ? WHERE photo_id = ?",
            (new_hash, photo_id),
        )

        if pair_src and pair_new and new_pair_norm:
            old_pair_norm = normalize_folder_path(str(pair_src))
            cursor.execute(
                """
                UPDATE photos
                SET file_name = ?, file_path = ?, paired_raw_path = ?, updated_at = CURRENT_TIMESTAMP
                WHERE file_path = ? COLLATE NOCASE
                """,
                (pair_new.name, new_pair_norm, new_norm, old_pair_norm),
            )
        conn.commit()

    clear_online_cache()

    return {
        "status": "ok",
        "photo_id": photo_id,
        "old_name": old_name,
        "new_name": new_path.name,
        "new_path": new_norm,
    }


def _extract_date_parts_for_rename(photo: Dict[str, Any], src_path: Path) -> Tuple[str, str]:
    """写真メタデータまたはファイル更新日時から (YYYYMMDD, HHMMSS) を抽出する"""
    date_taken = photo.get("date_taken")
    if date_taken:
        digits = re.sub(r"\D", "", str(date_taken))
        if len(digits) >= 8:
            ymd = digits[:8]
            hms = digits[8:14].ljust(6, "0") if len(digits) >= 14 else "000000"
            return ymd, hms
    try:
        dt = datetime.fromtimestamp(src_path.stat().st_mtime)
    except Exception:
        dt = datetime.now()
    return dt.strftime("%Y%m%d"), dt.strftime("%H%M%S")


def batch_rename_photos_in_storage(
    photo_ids: List[int],
    naming_rule: str = "date_seq",
    custom_prefix: str = "Photo",
    start_number: int = 1,
) -> Dict[str, Any]:
    """
    storage 内の複数写真を撮影日時昇順（date_taken ASC, id ASC）で一括連番リネームする。
    2段階リネーム（一時ファイル名経由）により既存ファイル名との衝突を完全に防止する。
    """
    if not photo_ids:
        raise ValueError("リネームする写真が選択されていません")

    rule = (naming_rule or "date_seq").strip().lower()
    if rule == "prefix_seq":
        rule = "custom_seq"
    if rule not in ("date_seq", "date_original", "custom_seq"):
        raise ValueError(f"未対応の命名ルールです: {naming_rule}")

    sanitized_prefix = _sanitize_single_name(custom_prefix or "Photo") or "Photo"
    seq_start = max(1, int(start_number or 1))

    # 重複IDを除外しつつ対象写真を取得
    unique_ids = list(dict.fromkeys(int(pid) for pid in photo_ids))
    valid_entries: List[Dict[str, Any]] = []
    skipped = 0

    for pid in unique_ids:
        p = get_photo_by_id(pid)
        if not p or not is_photo_in_storage(p):
            skipped += 1
            continue
        src_path, is_online = resolve_portable_path(p["file_path"])
        if not is_online or not src_path.exists():
            skipped += 1
            continue

        pair_src: Optional[Path] = None
        paired_raw_str = p.get("paired_raw_path")
        if paired_raw_str and is_path_in_storage(paired_raw_str):
            p_cand, p_online = resolve_portable_path(paired_raw_str)
            if (
                p_online
                and p_cand.exists()
                and is_path_in_storage(str(p_cand))
                and p_cand.resolve() != src_path.resolve()
            ):
                pair_src = p_cand

        valid_entries.append({
            "photo": p,
            "src_path": src_path,
            "pair_src": pair_src,
            "orig_stem": src_path.stem,
            "orig_ext": src_path.suffix,
            "old_name": src_path.name,
        })

    if not valid_entries:
        raise ValueError("storage 内のリネーム可能な写真が見つかりませんでした")

    # 撮影日時昇順 (date_taken ASC, id ASC) にソート
    valid_entries.sort(key=lambda e: (str(e["photo"].get("date_taken") or ""), int(e["photo"]["id"])))

    batch_token = uuid.uuid4().hex[:8]

    # 第1段階: すべての対象ファイル（および storage 内のペアRAW・付随サイドカー）を一時ファイル名へリネーム
    for idx, entry in enumerate(valid_entries):
        src_path: Path = entry["src_path"]
        pair_src: Optional[Path] = entry["pair_src"]
        tmp_stem = f".__pm_tmp_{batch_token}_{idx}"
        tmp_path = src_path.parent / f"{tmp_stem}{src_path.suffix}"
        src_path.rename(tmp_path)
        rename_sidecars_for_file(src_path, tmp_path)
        entry["tmp_path"] = tmp_path

        if pair_src:
            tmp_pair_stem = tmp_stem if pair_src.suffix.lower() != src_path.suffix.lower() else f"{tmp_stem}_pair"
            tmp_pair = pair_src.parent / f"{tmp_pair_stem}{pair_src.suffix}"
            pair_src.rename(tmp_pair)
            rename_sidecars_for_file(pair_src, tmp_pair)
            entry["tmp_pair"] = tmp_pair
        else:
            entry["tmp_pair"] = None

    # 第2段階: 目的のファイル名へリネーム（選択外の既存ファイルと衝突する場合は _1 等を付与）
    items: List[Dict[str, Any]] = []
    db_updates: List[Dict[str, Any]] = []

    for idx, entry in enumerate(valid_entries):
        photo = entry["photo"]
        tmp_path: Path = entry["tmp_path"]
        tmp_pair: Optional[Path] = entry["tmp_pair"]
        orig_ext: str = entry["orig_ext"]
        orig_stem: str = entry["orig_stem"]
        parent_dir = tmp_path.parent
        seq_num = seq_start + idx

        ymd, hms = _extract_date_parts_for_rename(photo, tmp_path)
        if rule == "date_seq":
            base_stem = f"{ymd}_{seq_num:03d}"
        elif rule == "date_original":
            base_stem = f"{ymd}_{hms}_{orig_stem}"
        else:  # custom_seq
            base_stem = f"{sanitized_prefix}_{seq_num:03d}"

        clean_stem = _sanitize_single_name(base_stem) or f"Photo_{seq_num:03d}"
        pair_ext = tmp_pair.suffix if tmp_pair else None

        final_path = _unique_dest_path(parent_dir, clean_stem, orig_ext, pair_ext=pair_ext)
        if tmp_pair and tmp_pair.parent.resolve() != parent_dir.resolve():
            counter = 1
            while (tmp_pair.parent / f"{final_path.stem}{tmp_pair.suffix}").exists():
                final_path = _unique_dest_path(parent_dir, f"{clean_stem}_{counter}", orig_ext, pair_ext=pair_ext)
                counter += 1

        tmp_path.rename(final_path)
        rename_sidecars_for_file(tmp_path, final_path)

        final_pair_path: Optional[Path] = None
        if tmp_pair:
            final_pair_path = tmp_pair.parent / f"{final_path.stem}{tmp_pair.suffix}"
            tmp_pair.rename(final_pair_path)
            rename_sidecars_for_file(tmp_pair, final_pair_path)

        new_fp_norm = normalize_folder_path(str(final_path))
        new_pair_norm = (
            normalize_folder_path(str(final_pair_path))
            if final_pair_path
            else photo.get("paired_raw_path")
        )
        old_pair_norm = normalize_folder_path(str(entry["pair_src"])) if entry["pair_src"] else None

        items.append({
            "photo_id": photo["id"],
            "old_name": entry["old_name"],
            "new_name": final_path.name,
            "new_path": new_fp_norm,
        })
        db_updates.append({
            "photo_id": photo["id"],
            "new_name": final_path.name,
            "new_path": new_fp_norm,
            "new_pair_path": new_pair_norm,
            "old_pair_path": old_pair_norm,
            "new_pair_name": final_pair_path.name if final_pair_path else None,
        })

    # DBの一括更新（UNIQUE(file_path) 衝突防止のため2フェーズ更新）
    with get_connection() as conn:
        cursor = conn.cursor()
        for idx, upd in enumerate(db_updates):
            cursor.execute(
                "UPDATE photos SET file_path = ? WHERE id = ?",
                (f".__pm_db_batch_{batch_token}_{idx}_{upd['photo_id']}", upd["photo_id"]),
            )
            if upd["old_pair_path"]:
                cursor.execute(
                    "UPDATE photos SET file_path = ? WHERE file_path = ? COLLATE NOCASE",
                    (f".__pm_db_pair_{batch_token}_{idx}_{upd['photo_id']}", upd["old_pair_path"]),
                )

        for idx, upd in enumerate(db_updates):
            cursor.execute(
                """
                UPDATE photos
                SET file_name = ?, file_path = ?, paired_raw_path = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (upd["new_name"], upd["new_path"], upd["new_pair_path"], upd["photo_id"]),
            )
            new_hash = compute_thumbnail_hash(upd["new_path"])
            cursor.execute(
                "UPDATE OR IGNORE thumbnails SET file_hash = ? WHERE photo_id = ?",
                (new_hash, upd["photo_id"]),
            )
            if upd["old_pair_path"] and upd["new_pair_path"] and upd["new_pair_name"]:
                cursor.execute(
                    """
                    UPDATE photos
                    SET file_name = ?, file_path = ?, paired_raw_path = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE file_path = ?
                    """,
                    (
                        upd["new_pair_name"],
                        upd["new_pair_path"],
                        upd["new_path"],
                        f".__pm_db_pair_{batch_token}_{idx}_{upd['photo_id']}",
                    ),
                )
        conn.commit()

    clear_online_cache()

    return {
        "status": "ok",
        "renamed_count": len(items),
        "skipped_count": skipped,
        "items": items,
    }


def export_storage_folder(
    folder_path: Optional[str] = "",
    destination_dir: Optional[str] = None,
    open_after: bool = True,
) -> Dict[str, Any]:
    """
    storage 内の指定フォルダ（直下またはサブフォルダ）をサブフォルダ構造ごと外部の指定フォルダへコピー出力する。
    destination_dir が未指定の場合はフォルダ選択ダイアログを表示する。
    """
    storage_root = ensure_storage_dir().resolve()
    src_dir = resolve_storage_target_dir(folder_path, must_exist=True)

    if destination_dir is None or not str(destination_dir).strip():
        picked = pick_folder_dialog()
        if not picked:
            return {"status": "cancelled"}
        dest_base = Path(picked).resolve()
    else:
        dest_base = Path(str(destination_dir).strip()).resolve()

    # コピー元フォルダ自身またはその配下への再帰コピーを防止
    if dest_base == src_dir or src_dir in dest_base.parents:
        raise ValueError("エクスポート先にコピー元フォルダ自身またはそのサブフォルダは指定できません")

    out_folder_name = "storage_export" if src_dir == storage_root else src_dir.name
    out_dir = dest_base / out_folder_name
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        raise ValueError(f"エクスポート先フォルダの作成に失敗しました: {e}")

    exported_count = 0
    exported_image_pairs: List[Tuple[Path, Path]] = []
    for root, dirs, files in os.walk(src_dir, topdown=True):
        dirs[:] = [d for d in dirs if not d.startswith(".") and not d.startswith("$")]
        curr_path = Path(root)
        rel = curr_path.relative_to(src_dir)
        target_sub = out_dir if str(rel) == "." else (out_dir / rel)
        target_sub.mkdir(parents=True, exist_ok=True)

        for fname in files:
            if fname.startswith("."):
                continue
            s_file = curr_path / fname
            d_file = target_sub / fname
            if d_file.exists():
                d_file = _unique_dest_path(target_sub, s_file.stem, s_file.suffix)
            shutil.copy2(str(s_file), str(d_file))
            exported_count += 1
            if s_file.suffix.lower() in SUPPORTED_EXTENSIONS:
                exported_image_pairs.append((s_file, d_file))

    # DBに登録されている写真について、評価・タグ・GPS・調整情報を反映した .xmp サイドカーを一緒に出力
    for s_img, d_img in exported_image_pairs:
        try:
            s_norm = normalize_folder_path(str(s_img))
            db_rec = get_photo_by_path(s_norm)
            if db_rec and db_rec.get("id"):
                full_photo = get_photo_by_id(int(db_rec["id"])) or db_rec
                write_xmp_sidecar_for_photo(full_photo, d_img, remove_gps=False)
        except Exception as xmp_err:
            logger.warning(f"storage フォルダエクスポート時の XMP 生成スキップ ({d_img}): {xmp_err}")

    if open_after:
        open_folder_in_windows_explorer(out_dir)

    return {
        "status": "ok",
        "exported_files": exported_count,
        "exported_path": normalize_folder_path(str(out_dir)),
    }
