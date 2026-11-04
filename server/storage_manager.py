"""
アプリ内ストレージ（storage フォルダ）管理モジュール
旧 carry フォルダからの自動移行、サブフォルダ作成・リネーム・空フォルダ削除、
外部写真のコピーインポート、storage 内での写真移動、単一/一括連番リネーム、
およびフォルダ単位の外部エクスポートを提供する。
"""

import concurrent.futures
import logging
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .database import (
    add_scan_root,
    compute_thumbnail_hash,
    get_connection,
    get_directory_counts_under,
    get_photo_by_id,
    get_photo_by_path,
    get_thumbnail,
    recalculate_stacks,
    save_thumbnail,
    set_volume_loome_enabled,
    upsert_photo,
    upsert_volume,
)
from .database.connection import bump_db_commit_seq
from .database.folders import clear_folders_fs_cache, normalize_folder_path
from .database.photos import (
    _directory_filter_sql,
    _sanitize_photo_data,
    _split_link_path,
    _sync_photo_links_state,
    _upsert_single_photo_in_tx,
)
from .exporter import open_folder_in_windows_explorer, pick_folder_dialog
from .scanner import (
    SUPPORTED_EXTENSIONS,
    _get_connected_drive_serial_map,
    clear_online_cache,
    ensure_thumbnail,
    extract_metadata,
    resolve_portable_path,
)
from .sidecar import (
    copy_sidecars_for_file,
    fast_copy_file,
    is_sidecar_file,
    move_sidecars_for_file,
    rename_sidecars_for_file,
    write_xmp_sidecar_for_photo,
)
from .volume_info import find_online_drive_for_serial, get_volume_info, get_volume_info_for_drive

logger = logging.getLogger("photo_manager.storage")

BASE_DIR = Path(__file__).resolve().parent.parent
LEGACY_STORAGE_DIR = BASE_DIR / "storage"
LOOME_DIR = BASE_DIR / "Loome"
STORAGE_DIR = LEGACY_STORAGE_DIR if LEGACY_STORAGE_DIR.exists() else LOOME_DIR
LEGACY_CARRY_DIR = BASE_DIR / "carry"

# storage ファイル操作のリアルタイム進捗状態
_storage_task_status: Dict[str, Any] = {
    "is_running": False,
    "task_type": "",
    "title": "",
    "current": 0,
    "total": 0,
    "current_file": "",
    "percent": 0,
}


def get_storage_task_status() -> Dict[str, Any]:
    """現在実行中の storage ファイル操作の進捗状態を返す"""
    return dict(_storage_task_status)


def _update_storage_task_status(
    is_running: Optional[bool] = None,
    task_type: Optional[str] = None,
    title: Optional[str] = None,
    current: Optional[int] = None,
    total: Optional[int] = None,
    current_file: Optional[str] = None,
) -> None:
    """storage ファイル操作の進捗状態を更新する"""
    if is_running is not None:
        _storage_task_status["is_running"] = bool(is_running)
    if task_type is not None:
        _storage_task_status["task_type"] = str(task_type)
    if title is not None:
        _storage_task_status["title"] = str(title)
    if current is not None:
        _storage_task_status["current"] = int(current)
    if total is not None:
        _storage_task_status["total"] = int(total)
    if current_file is not None:
        _storage_task_status["current_file"] = str(current_file)
    tot = int(_storage_task_status.get("total") or 0)
    cur = int(_storage_task_status.get("current") or 0)
    if tot > 0:
        _storage_task_status["percent"] = max(0, min(100, int(round((cur / tot) * 100))))
    else:
        _storage_task_status["percent"] = 0

# Windows ファイル名・フォルダ名禁止文字
_INVALID_WIN_CHARS_RE = re.compile(r'[\\/*?:"<>|\x00-\x1f]')
# Windows 予約デバイス名
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
}


def _has_non_hidden_contents(dir_path: Path) -> bool:
    """指定ディレクトリ内に隠し属性・システム管理ファイルを除く実ファイルまたはサブフォルダが1つでも存在するか判定する"""
    if not dir_path.exists() or not dir_path.is_dir():
        return False
    try:
        with os.scandir(str(dir_path)) as it:
            for entry in it:
                ename = entry.name
                if ename.startswith(".") or ename.startswith("$"):
                    continue
                if ename.lower() in ("desktop.ini", "thumbs.db"):
                    continue
                return True
    except Exception as e:
        logger.debug(f"ディレクトリ内容確認スキップ ({dir_path}): {e}")
    return False


_LEGACY_STORAGE_ROOT_KEY: str = normalize_folder_path(str(LEGACY_STORAGE_DIR.resolve())).rstrip("\\/").lower()
_LOOME_ROOT_KEY: str = normalize_folder_path(str(LOOME_DIR.resolve())).rstrip("\\/").lower()
_STORAGE_ROOT_KEY: str = normalize_folder_path(str(STORAGE_DIR.resolve())).rstrip("\\/").lower()
_STORAGE_ROOT_NO_DRIVE: str = _STORAGE_ROOT_KEY[2:] if (len(_STORAGE_ROOT_KEY) >= 2 and _STORAGE_ROOT_KEY[1] == ":") else ""
_LEGACY_STORAGE_NO_DRIVE: str = _LEGACY_STORAGE_ROOT_KEY[2:] if (len(_LEGACY_STORAGE_ROOT_KEY) >= 2 and _LEGACY_STORAGE_ROOT_KEY[1] == ":") else ""
_LOOME_NO_DRIVE: str = _LOOME_ROOT_KEY[2:] if (len(_LOOME_ROOT_KEY) >= 2 and _LOOME_ROOT_KEY[1] == ":") else ""

# 外部ドライブを含む有効な Loome ルート一覧の短期キャッシュ
_loome_roots_cache: Optional[Tuple[float, List[Dict[str, Any]]]] = None
_LOOME_ROOTS_CACHE_TTL = 1.2


def invalidate_loome_roots_cache() -> None:
    """Loome ルート一覧キャッシュを破棄する"""
    global _loome_roots_cache
    _loome_roots_cache = None


def ensure_storage_dir() -> Path:
    """
    本体のプライマリ Loome（旧 storage）ルートフォルダを確定・作成してその Path を返す。
    - 既存の storage/ にファイルやサブフォルダが入っている場合は、既存環境を壊さないよう storage/ を維持する。
    - storage/ が未作成または空っぽの場合は、空の storage/ を片付けて Loome/ を作成・採用する。
    """
    global STORAGE_DIR, _STORAGE_ROOT_KEY, _STORAGE_ROOT_NO_DRIVE

    if LEGACY_STORAGE_DIR.exists() and _has_non_hidden_contents(LEGACY_STORAGE_DIR):
        chosen = LEGACY_STORAGE_DIR
    else:
        if LEGACY_STORAGE_DIR.exists() and not _has_non_hidden_contents(LEGACY_STORAGE_DIR):
            try:
                shutil.rmtree(str(LEGACY_STORAGE_DIR), ignore_errors=True)
            except Exception as rm_err:
                logger.debug(f"空の旧 storage フォルダ整理スキップ: {rm_err}")
        LOOME_DIR.mkdir(parents=True, exist_ok=True)
        chosen = LOOME_DIR

    chosen.mkdir(parents=True, exist_ok=True)
    STORAGE_DIR = chosen
    _STORAGE_ROOT_KEY = normalize_folder_path(str(chosen.resolve())).rstrip("\\/").lower()
    _STORAGE_ROOT_NO_DRIVE = _STORAGE_ROOT_KEY[2:] if (len(_STORAGE_ROOT_KEY) >= 2 and _STORAGE_ROOT_KEY[1] == ":") else ""
    return chosen


def _sanitize_single_name(name: str) -> str:
    """単一セグメントのフォルダ名・ファイル名ステムから Windows 禁止文字を除去する"""
    cleaned = _INVALID_WIN_CHARS_RE.sub("_", str(name or "").strip()).strip().rstrip(".")
    if cleaned.upper() in _WINDOWS_RESERVED_NAMES:
        cleaned = f"_{cleaned}"
    return cleaned


def _storage_root_key() -> str:
    """比較用の正規化済みプライマリ Loome ルートパス（小文字・末尾区切りなし）を返す"""
    return _STORAGE_ROOT_KEY


def get_all_loome_roots(use_cache: bool = True, force_refresh: bool = False) -> List[Dict[str, Any]]:
    """
    本体プライマリ Loome および現在接続中の外部 VSN メディアの Loome ルート一覧を返す。
    各要素: {"key", "name", "path", "norm_key", "is_primary", "volume_serial", "drive_letter"}
    """
    global _loome_roots_cache
    now_ts = time.monotonic()
    if not force_refresh and use_cache and _loome_roots_cache is not None and (now_ts - _loome_roots_cache[0]) < _LOOME_ROOTS_CACHE_TTL:
        return _loome_roots_cache[1]

    primary_dir = ensure_storage_dir().resolve()
    primary_norm = normalize_folder_path(str(primary_dir)).rstrip("\\/")
    primary_key = primary_norm.lower()
    primary_vol_info = get_volume_info(primary_norm)
    primary_serial = (primary_vol_info.get("serial") or "").upper() if primary_vol_info else None

    roots: List[Dict[str, Any]] = [
        {
            "key": "storage",
            "name": "Loome",
            "path": primary_norm,
            "norm_key": primary_key,
            "is_primary": True,
            "volume_serial": primary_serial,
            "drive_letter": primary_norm[:2].upper() if (len(primary_norm) >= 2 and primary_norm[1] == ":") else "",
        }
    ]

    try:
        serial_to_drive, _ = _get_connected_drive_serial_map()
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT volume_serial, volume_label, custom_name, drive_letter FROM volumes WHERE loome_enabled = 1"
            )
            vol_rows = cursor.fetchall()

        for vr in vol_rows:
            vsn = str(vr["volume_serial"] or "").strip().upper()
            if not vsn:
                continue
            mounted_drive = serial_to_drive.get(vsn)
            if not mounted_drive:
                continue
            ext_dir = Path(f"{mounted_drive}\\Loome")
            try:
                ext_resolved = ext_dir.resolve()
            except Exception:
                ext_resolved = ext_dir
            ext_norm = normalize_folder_path(str(ext_resolved)).rstrip("\\/")
            ext_key = ext_norm.lower()
            if ext_key == primary_key:
                continue
            try:
                ext_dir.mkdir(parents=True, exist_ok=True)
            except Exception as mk_err:
                logger.warning(f"外部 Loome フォルダの確認スキップ ({ext_dir}): {mk_err}")
                if not ext_dir.exists():
                    continue

            c_name = (vr["custom_name"] or "").strip()
            v_label = (vr["volume_label"] or "").strip()
            title_part = c_name or v_label or mounted_drive
            if mounted_drive.upper() in title_part.upper():
                disp_name = f"Loome ({title_part})"
            else:
                disp_name = f"Loome ({title_part} {mounted_drive})"

            roots.append(
                {
                    "key": f"loome_{vsn}",
                    "name": disp_name,
                    "path": ext_norm,
                    "norm_key": ext_key,
                    "is_primary": False,
                    "volume_serial": vsn,
                    "drive_letter": mounted_drive.upper(),
                }
            )
    except Exception as e:
        logger.debug(f"外部 Loome ルート列挙スキップ: {e}")

    _loome_roots_cache = (now_ts, roots)
    return roots


def is_loome_root_path(path_str: Optional[str]) -> bool:
    """指定パスが本体または外部ドライブの Loome ルート直下そのものであるか判定する"""
    if not path_str:
        return False
    norm = normalize_folder_path(str(path_str)).rstrip("\\/").lower()
    if norm in (_STORAGE_ROOT_KEY, _LEGACY_STORAGE_ROOT_KEY, _LOOME_ROOT_KEY):
        return True
    for r in get_all_loome_roots(use_cache=True):
        if norm == r["norm_key"]:
            return True
    return False


def is_path_in_storage(path_str: Optional[str], volume_serial: Optional[str] = None) -> bool:
    """
    指定パスが本体 Loome（Loome/ または storage/）あるいは外部 VSN メディアの Loome 配下であるかを高速・正確に判定する。
    ポータブル運用でドライブレターが変化した場合も考慮する。
    """
    if not path_str:
        return False

    norm = str(path_str).replace("/", "\\").rstrip("\\").lower()

    # 1. 本体プライマリ（Loome/ および旧 storage/ の両方を常に認識）
    for root_k in (_STORAGE_ROOT_KEY, _LOOME_ROOT_KEY, _LEGACY_STORAGE_ROOT_KEY):
        if norm == root_k or norm.startswith(root_k + "\\"):
            return True

    # 2. 本体ポータブル移動時（ドライブレター変化時）の照合
    if len(norm) >= 2 and norm[1] == ":":
        norm_no_drive = norm[2:]
        for no_drv in (_STORAGE_ROOT_NO_DRIVE, _LOOME_NO_DRIVE, _LEGACY_STORAGE_NO_DRIVE):
            if no_drv and (norm_no_drive == no_drv or norm_no_drive.startswith(no_drv + "\\")):
                return True

    # 3. 接続中の外部 VSN メディアの Loome ルート照合
    for r in get_all_loome_roots(use_cache=True):
        rk = r["norm_key"]
        if norm == rk or norm.startswith(rk + "\\"):
            return True
        if volume_serial and r.get("volume_serial") and str(volume_serial).upper() == r["volume_serial"]:
            if len(norm) >= 2 and norm[1] == ":":
                rel_part = norm[2:]
                if rel_part == "\\loome" or rel_part.startswith("\\loome\\"):
                    return True

    return False


def _resolve_storage_photo_entry(photo: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    写真辞書データが Loome 配下にあるかを判定し、マルチリンク（外部フォルダ＋Loome）の場合でも
    Loome 側のリンクパス情報（file_path, directory_path, file_name, volume_serial, paired_raw_path）を解決して返す。
    Loome 配下にリンクを持たない場合は None を返す。
    """
    if not photo:
        return None
    vsn = photo.get("volume_serial")
    dir_path = photo.get("directory_path")
    file_path = photo.get("file_path")
    if (dir_path and is_path_in_storage(dir_path, volume_serial=vsn)) or (
        file_path and is_path_in_storage(file_path, volume_serial=vsn)
    ):
        return photo

    # DB の photo_links テーブルから Loome 配下リンク（paired_raw_path 含む）を優先検索
    pid = photo.get("id")
    if pid:
        try:
            with get_connection() as conn:
                rows = conn.execute(
                    """
                    SELECT file_path, directory_path, file_name, volume_serial, paired_raw_path
                    FROM photo_links
                    WHERE photo_id = ?
                    ORDER BY is_primary DESC, id ASC
                    """,
                    (int(pid),),
                ).fetchall()
            for lk in rows:
                lk_vsn = lk["volume_serial"]
                lk_dir = lk["directory_path"]
                lk_fp = lk["file_path"]
                if (lk_dir and is_path_in_storage(lk_dir, volume_serial=lk_vsn)) or (
                    lk_fp and is_path_in_storage(lk_fp, volume_serial=lk_vsn)
                ):
                    resolved = dict(photo)
                    resolved["file_path"] = lk_fp
                    resolved["directory_path"] = lk_dir
                    resolved["file_name"] = lk["file_name"] or (Path(lk_fp).name if lk_fp else resolved.get("file_name"))
                    resolved["volume_serial"] = lk_vsn
                    resolved["paired_raw_path"] = lk["paired_raw_path"]
                    return resolved
        except Exception as e:
            logger.debug(f"Loome リンク解決スキップ (photo_id={pid}): {e}")

    # フォールバック: duplicates 配列に Loome 配下のリンクが含まれているか確認
    for dup in photo.get("duplicates") or []:
        dup_vsn = dup.get("volume_serial")
        dup_dir = dup.get("directory_path")
        dup_fp = dup.get("file_path")
        if (dup_dir and is_path_in_storage(dup_dir, volume_serial=dup_vsn)) or (
            dup_fp and is_path_in_storage(dup_fp, volume_serial=dup_vsn)
        ):
            resolved = dict(photo)
            resolved["file_path"] = dup_fp or resolved.get("file_path")
            resolved["directory_path"] = dup_dir or resolved.get("directory_path")
            resolved["file_name"] = dup.get("file_name") or (Path(dup_fp).name if dup_fp else resolved.get("file_name"))
            resolved["volume_serial"] = dup_vsn
            if dup.get("paired_raw_path") is not None:
                resolved["paired_raw_path"] = dup.get("paired_raw_path")
            return resolved

    return None


def is_photo_in_storage(photo: Dict[str, Any]) -> bool:
    """写真辞書データ（主リンクまたは photo_links 内のサブリンク）が Loome 配下にあるか判定する"""
    return _resolve_storage_photo_entry(photo) is not None


def resolve_storage_target_with_root(
    dest: Optional[str], must_exist: bool = False
) -> Tuple[Path, Path]:
    """
    Loome 内のターゲットフォルダパスと、それが属する Loome ルートフォルダパスを解決し、パストラバーサル（..）を遮断する。
    戻り値: (target_dir: Path, loome_root_dir: Path)
    """
    roots = get_all_loome_roots(use_cache=False)
    primary_meta = roots[0]
    primary_root = Path(primary_meta["path"]).resolve()

    if dest is None or not str(dest).strip() or str(dest).strip() == ".":
        target = primary_root
        matched_meta = primary_meta
        matched_root = primary_root
    else:
        raw = str(dest).strip().replace("/", "\\")
        raw_path = Path(raw)

        # パストラバーサル要素の明示的拒否
        if ".." in raw_path.parts:
            raise ValueError("不正なフォルダ指定です（親ディレクトリへの参照は許可されていません）")

        matched_meta = None
        matched_root = None

        if raw_path.is_absolute() or (len(raw) >= 2 and raw[1] == ":"):
            candidate = raw_path.resolve()
            cand_key = normalize_folder_path(str(candidate)).rstrip("\\/").lower()

            for rm in roots:
                rk = rm["norm_key"]
                if cand_key == rk or cand_key.startswith(rk + "\\"):
                    matched_meta = rm
                    matched_root = Path(rm["path"]).resolve()
                    target = candidate
                    break

            if matched_meta is None:
                # 旧 storage パスやドライブ文字変更時のポータブル解決フォールバック
                resolved_port, _ = resolve_portable_path(raw)
                candidate = Path(resolved_port).resolve()
                cand_key = normalize_folder_path(str(candidate)).rstrip("\\/").lower()
                for rm in roots:
                    rk = rm["norm_key"]
                    if cand_key == rk or cand_key.startswith(rk + "\\"):
                        matched_meta = rm
                        matched_root = Path(rm["path"]).resolve()
                        target = candidate
                        break

                if matched_meta is None:
                    # 旧 storage <-> Loome 切替直後のパス互換解決
                    for old_k in (_LEGACY_STORAGE_ROOT_KEY, _LOOME_ROOT_KEY):
                        if cand_key == old_k:
                            matched_meta = primary_meta
                            matched_root = primary_root
                            target = primary_root
                            break
                        if cand_key.startswith(old_k + "\\"):
                            rel_part = str(candidate)[len(old_k):].lstrip("\\/")
                            matched_meta = primary_meta
                            matched_root = primary_root
                            target = (primary_root / rel_part).resolve()
                            break
        else:
            rel_cleaned = raw.lstrip("\\")
            target = (primary_root / rel_cleaned).resolve()
            matched_meta = primary_meta
            matched_root = primary_root

        if matched_meta is None or matched_root is None:
            raise ValueError("指定されたフォルダは Loome の管理範囲外です")

    target_key = normalize_folder_path(str(target)).rstrip("\\/").lower()
    root_key = normalize_folder_path(str(matched_root)).rstrip("\\/").lower()
    if not (target_key == root_key or target_key.startswith(root_key + "\\")):
        raise ValueError("指定されたフォルダは Loome の管理範囲外です")

    if must_exist:
        if not target.exists() or not target.is_dir():
            raise ValueError(f"指定されたフォルダが存在しません: {dest}")

    return target, matched_root


def resolve_storage_target_dir(dest: Optional[str], must_exist: bool = False) -> Path:
    """Loome 内のターゲットフォルダパスを解決して Path を返す"""
    target, _ = resolve_storage_target_with_root(dest, must_exist=must_exist)
    return target


def enable_volume_loome(volume_serial: str, drive_letter: Optional[str] = None) -> Dict[str, Any]:
    """
    指定された VSN の接続中ドライブ直下に `<Drive>:\\Loome` フォルダを作成し、
    volumes.loome_enabled = 1 に登録してスキャンルートに追加する。
    """
    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean:
        raise ValueError("ボリュームシリアル番号が指定されていません")

    online_info = find_online_drive_for_serial(serial_clean)
    if not online_info and drive_letter:
        drv_clean = str(drive_letter).strip()[:2].upper()
        info_try = get_volume_info_for_drive(drv_clean)
        if info_try and str(info_try.get("serial") or "").upper() == serial_clean:
            online_info = info_try

    if not online_info or not online_info.get("drive"):
        raise ValueError("対象のドライブが現在接続されていないため、Loome を作成できません")

    mounted_drive = str(online_info["drive"]).rstrip("\\/")
    vol_label = online_info.get("label") or ""
    loome_dir = Path(f"{mounted_drive}\\Loome")

    try:
        loome_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        raise ValueError(f"ドライブ {mounted_drive} への Loome フォルダ作成に失敗しました: {e}")

    loome_norm = normalize_folder_path(str(loome_dir.resolve())).rstrip("\\/")
    vol_rec = set_volume_loome_enabled(
        volume_serial=serial_clean,
        enabled=True,
        volume_label=vol_label,
        drive_letter=mounted_drive,
    )
    try:
        add_scan_root(loome_norm)
    except Exception as sr_err:
        logger.debug(f"外部 Loome のスキャンルート追加スキップ ({loome_norm}): {sr_err}")

    invalidate_loome_roots_cache()
    clear_folders_fs_cache()
    clear_online_cache()

    return {
        "status": "ok",
        "volume_serial": serial_clean,
        "drive_letter": mounted_drive,
        "loome_path": loome_norm,
        "loome_enabled": True,
        "volume": vol_rec,
    }


def disable_volume_loome(volume_serial: str) -> Dict[str, Any]:
    """
    指定された VSN の外部ドライブの Loome 登録を解除する（実ファイルは削除しない。空フォルダの場合のみ整理）。
    """
    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean:
        raise ValueError("ボリュームシリアル番号が指定されていません")

    online_info = find_online_drive_for_serial(serial_clean)
    mounted_drive = str(online_info["drive"]).rstrip("\\/") if (online_info and online_info.get("drive")) else None
    if mounted_drive:
        loome_dir = Path(f"{mounted_drive}\\Loome")
        if loome_dir.exists() and not _has_non_hidden_contents(loome_dir):
            try:
                loome_dir.rmdir()
            except Exception:
                pass

    vol_rec = set_volume_loome_enabled(
        volume_serial=serial_clean,
        enabled=False,
        drive_letter=mounted_drive,
    )
    invalidate_loome_roots_cache()
    clear_folders_fs_cache()
    clear_online_cache()

    return {
        "status": "ok",
        "volume_serial": serial_clean,
        "loome_enabled": False,
        "volume": vol_rec,
    }


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


def _is_removable_drive_path(path_obj: Path) -> bool:
    """指定パスのドライブがリムーバブルメディア（SDカード・USBメモリ等: DRIVE_REMOVABLE=2）か判定する"""
    if os.name != "nt":
        return False
    try:
        import ctypes
        s = str(path_obj.resolve())
        if len(s) >= 2 and s[1] == ":":
            root = f"{s[:2]}\\"
            return ctypes.windll.kernel32.GetDriveTypeW(root) == 2
    except Exception:
        pass
    return False


def _optimal_copy_workers(src_sample: Path, dst_dir: Path, avg_file_size: int, task_count: int) -> int:
    """
    コピー元・コピー先のドライブ種別とファイルサイズに応じて最適な並列ワーカー数を返す。
    - 内蔵/外付けSSD同士（DRIVE_FIXED）: 最大 4 並列
    - SDカード/USBメモリ（DRIVE_REMOVABLE）が絡む場合:
      NANDコントローラのランダムアクセス競合（スラッシング）を防ぐため、
      大容量RAW（平均8MB以上）は 1（純粋シーケンシャルDMA転送）、通常JPEG等は 2 並列に自動制御する。
    """
    if task_count <= 1:
        return 1
    if _is_removable_drive_path(src_sample) or _is_removable_drive_path(dst_dir):
        if avg_file_size >= 8 * 1024 * 1024:
            return 1
        return min(2, task_count)
    return min(4, task_count)


def _allocate_unique_dest_path(
    dest_dir: Path,
    stem: str,
    ext: str,
    reserved_names_lower: Set[str],
    pair_ext: Optional[str] = None,
) -> Path:
    """
    事前に走査した既存ファイル名セット（小文字）を用いて、ディスクI/Oなしで衝突しないファイルパスを採番・予約する。
    """
    cand_stem = stem
    counter = 1
    while True:
        name_low = f"{cand_stem}{ext}".lower()
        pair_low = f"{cand_stem}{pair_ext}".lower() if pair_ext else None
        if name_low not in reserved_names_lower and (not pair_low or pair_low not in reserved_names_lower):
            reserved_names_lower.add(name_low)
            if pair_low:
                reserved_names_lower.add(pair_low)
            return dest_dir / f"{cand_stem}{ext}"
        cand_stem = f"{stem}_{counter}"
        counter += 1


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


def _sync_photo_link_on_storage_change(
    cursor: Any,
    photo_id: int,
    old_fp: str,
    new_fp: str,
    new_dp: str,
    new_fn: str,
    new_pair_fp: Optional[str],
    volume_serial: Optional[str] = None,
) -> None:
    """Loome 内のファイル移動・リネーム・フォルダリネーム時に photo_links レコードも同期更新する"""
    try:
        cursor.execute(
            "SELECT id, volume_serial FROM photo_links WHERE photo_id = ? AND file_path = ? COLLATE NOCASE",
            (photo_id, old_fp),
        )
        lk = cursor.fetchone()
        if not lk:
            cursor.execute(
                "SELECT id, volume_serial FROM photo_links WHERE photo_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1",
                (photo_id,),
            )
            lk = cursor.fetchone()
        if lk:
            eff_vsn = volume_serial if volume_serial is not None else (lk["volume_serial"] or "")
            vsn_norm, rel_path, rel_dir, clean_fp, clean_dir = _split_link_path(new_fp, new_dp, eff_vsn)
            cursor.execute(
                """
                UPDATE OR IGNORE photo_links
                SET volume_serial = ?,
                    rel_path = ?,
                    rel_dir = ?,
                    file_path = ?,
                    directory_path = ?,
                    file_name = ?,
                    paired_raw_path = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (vsn_norm, rel_path, rel_dir, clean_fp, clean_dir, new_fn, new_pair_fp, lk["id"]),
            )
    except Exception as e:
        logger.warning(f"photo_links 同期更新エラー (photo_id={photo_id}): {e}")


def get_storage_folders() -> Dict[str, Any]:
    """
    有効な全 Loome ルート（本体 + 接続中外部VSNドライブ）配下の全ディレクトリを再帰走査し、
    各フォルダ直下の画像ファイル枚数を集計して返す。
    """
    primary_root = ensure_storage_dir().resolve()
    primary_norm = normalize_folder_path(str(primary_root)).rstrip("\\/")
    loome_roots = get_all_loome_roots(force_refresh=True)

    folders: List[Dict[str, Any]] = []
    root_paths: List[str] = []

    for r_info in loome_roots:
        r_norm = r_info["path"]
        r_path = Path(r_norm).resolve()
        if not r_path.exists() or not r_path.is_dir():
            continue
        root_paths.append(r_norm)
        r_name = r_info["name"]
        r_vsn = r_info.get("volume_serial")
        is_primary = bool(r_info.get("is_primary"))

        # DB上のディレクトリ別枚数マップを取得
        db_counts: Dict[str, int] = {}
        try:
            for row in get_directory_counts_under(r_norm, volume_serial=r_vsn):
                d_key = normalize_folder_path(row["directory_path"]).rstrip("\\/").lower()
                db_counts[d_key] = int(row["count"] or 0)
        except Exception as e:
            logger.warning(f"Loome DB枚数集計スキップ ({r_norm}): {e}")

        for root, dirs, files in os.walk(r_path, topdown=True):
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

            if curr_path == r_path:
                folders.append({
                    "name": f"{r_name} (直下)",
                    "rel_path": "" if is_primary else curr_norm,
                    "path": curr_norm,
                    "depth": 0,
                    "count": count,
                    "is_root": True,
                    "is_primary_loome": is_primary,
                    "volume_serial": r_vsn,
                    "root_name": r_name,
                })
            else:
                rel_path_str = str(curr_path.relative_to(r_path)).replace("/", "\\")
                depth = len(rel_path_str.split("\\"))
                folders.append({
                    "name": curr_path.name,
                    "rel_path": rel_path_str if is_primary else f"{r_name}\\{rel_path_str}",
                    "path": curr_norm,
                    "depth": depth,
                    "count": count,
                    "is_root": False,
                    "is_primary_loome": is_primary,
                    "volume_serial": r_vsn,
                    "root_name": r_name,
                })

    return {
        "storage_root": primary_norm,
        "storage_roots": root_paths,
        "folders": folders,
    }


def create_storage_subfolder(parent_path: Optional[str], folder_name: str) -> Dict[str, Any]:
    """
    Loome 内の指定親フォルダ配下に新しいサブフォルダを作成する。
    """
    parent_dir, active_root = resolve_storage_target_with_root(parent_path, must_exist=True)

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
    # 最終ターゲットも対象 Loome ルート範囲内であることを保証
    active_root_key = normalize_folder_path(str(active_root)).rstrip("\\/").lower()
    target_key = normalize_folder_path(str(target)).rstrip("\\/").lower()
    if not target_key.startswith(active_root_key + "\\"):
        raise ValueError("作成先フォルダが Loome の範囲外です")

    target.mkdir(parents=True, exist_ok=True)
    clear_folders_fs_cache()

    rel_str = str(target.relative_to(active_root)).replace("/", "\\")
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
    Loome 内のサブフォルダ名を変更し、配下の写真のDBパス（file_path, directory_path, paired_raw_path）を一括更新する。
    """
    target, active_root = resolve_storage_target_with_root(folder_path, must_exist=True)

    if target == active_root or is_loome_root_path(str(target)):
        raise ValueError("Loome ルートフォルダ自体の名前は変更できません")

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
                SELECT id, file_path, directory_path, file_name, paired_raw_path, volume_serial
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
                fname = r["file_name"] or Path(old_fp).name
                vsn = r["volume_serial"]

                new_fp = _replace_prefix_case_insensitive(old_fp, old_norm, new_norm)
                new_dp = _replace_prefix_case_insensitive(old_dp, old_norm, new_norm)
                new_pair = _replace_prefix_case_insensitive(old_pair, old_norm, new_norm) if old_pair else None

                if new_fp != old_fp or new_dp != old_dp or new_pair != old_pair:
                    cursor.execute(
                        "UPDATE photos SET file_path = ? WHERE id = ?",
                        (f"{batch_token}{idx}_{pid}", pid),
                    )
                    updates_final.append((old_fp, new_fp, new_dp, fname, new_pair, vsn, pid))

            for old_fp, new_fp, new_dp, fname, new_pair, vsn, pid in updates_final:
                cursor.execute(
                    """
                    UPDATE photos
                    SET file_path = ?, directory_path = ?, paired_raw_path = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (new_fp, new_dp, new_pair, pid),
                )
                _sync_photo_link_on_storage_change(cursor, pid, old_fp, new_fp, new_dp, fname, new_pair, volume_serial=vsn)
                # サムネイルの file_hash も新パスに合わせて更新
                new_hash = compute_thumbnail_hash(new_fp)
                cursor.execute(
                    "UPDATE OR IGNORE thumbnails SET file_hash = ? WHERE photo_id = ?",
                    (new_hash, pid),
                )
                updated_count += 1

            # photo_links 側で old_norm 配下にある残りリンクも一括更新
            lk_dir_sql, lk_dir_params = _directory_filter_sql(old_norm, recursive=True, column_name="directory_path")
            cursor.execute(
                f"SELECT id, photo_id, file_path, directory_path, file_name, paired_raw_path, volume_serial FROM photo_links WHERE {lk_dir_sql}",
                lk_dir_params,
            )
            for lk_row in cursor.fetchall():
                lk_old_fp = lk_row["file_path"] or ""
                lk_old_dp = lk_row["directory_path"] or ""
                lk_old_pair = lk_row["paired_raw_path"]
                lk_new_fp = _replace_prefix_case_insensitive(lk_old_fp, old_norm, new_norm)
                lk_new_dp = _replace_prefix_case_insensitive(lk_old_dp, old_norm, new_norm)
                lk_new_pair = _replace_prefix_case_insensitive(lk_old_pair, old_norm, new_norm) if lk_old_pair else None
                vsn_norm, rel_path, rel_dir, clean_fp, clean_dir = _split_link_path(
                    lk_new_fp, lk_new_dp, lk_row["volume_serial"]
                )
                cursor.execute(
                    """
                    UPDATE OR IGNORE photo_links
                    SET rel_path = ?, rel_dir = ?, file_path = ?, directory_path = ?, paired_raw_path = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (rel_path, rel_dir, clean_fp, clean_dir, lk_new_pair, lk_row["id"]),
                )

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
    Loome 内の空のサブフォルダを削除する。
    ファイルまたはサブフォルダが1つでも存在する場合は ValueError を送出する。
    """
    target, active_root = resolve_storage_target_with_root(folder_path, must_exist=True)

    if target == active_root or is_loome_root_path(str(target)):
        raise ValueError("Loome ルートフォルダ自体は削除できません")

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


def _build_copied_photo_meta(
    src_photo: Dict[str, Any],
    dest_file: Path,
    dest_norm: str,
    volume_serial: Optional[str],
    paired_raw_norm: Optional[str] = None,
) -> Dict[str, Any]:
    """
    コピー元写真のDBレコードからメタデータを引き継ぎ、EXIF/RAWヘッダの再解析（extract_metadata）を
    省略して高速にDB登録用辞書を構築する。
    """
    # コピー元レコードに寸法・撮影日時のいずれも無い場合のみフォールバック解析
    if src_photo.get("width") is None and src_photo.get("date_taken") is None:
        meta = extract_metadata(dest_file)
    else:
        st = dest_file.stat()
        ext_low = dest_file.suffix.lower()
        meta = {
            "file_size": st.st_size,
            "file_mtime": st.st_mtime,
            "width": src_photo.get("width"),
            "height": src_photo.get("height"),
            "date_taken": src_photo.get("date_taken"),
            "camera_make": src_photo.get("camera_make"),
            "camera_model": src_photo.get("camera_model"),
            "lens_model": src_photo.get("lens_model"),
            "exposure_bias": src_photo.get("exposure_bias"),
            "shutter_speed": src_photo.get("shutter_speed"),
            "f_number": src_photo.get("f_number"),
            "iso": src_photo.get("iso"),
            "focal_length": src_photo.get("focal_length"),
            "subsec_time": src_photo.get("subsec_time") or "",
            "is_raw": int(src_photo.get("is_raw") or 0),
            "raw_format": src_photo.get("raw_format") or (ext_low.lstrip(".").upper() if int(src_photo.get("is_raw") or 0) else None),
            "latitude": src_photo.get("latitude"),
            "longitude": src_photo.get("longitude"),
            "gps_source": src_photo.get("gps_source"),
            "country": src_photo.get("country") or src_photo.get("location_country"),
            "state": src_photo.get("state") or src_photo.get("location_state"),
            "city": src_photo.get("city") or src_photo.get("location_city"),
        }

    meta["file_path"] = normalize_folder_path(str(dest_file))
    meta["directory_path"] = dest_norm
    meta["file_name"] = dest_file.name
    meta["volume_serial"] = volume_serial

    if src_photo.get("latitude") is not None and src_photo.get("longitude") is not None:
        meta["latitude"] = src_photo["latitude"]
        meta["longitude"] = src_photo["longitude"]
        meta["gps_source"] = src_photo.get("gps_source") or meta.get("gps_source")
        meta["country"] = src_photo.get("country") or src_photo.get("location_country") or meta.get("country")
        meta["state"] = src_photo.get("state") or src_photo.get("location_state") or meta.get("state")
        meta["city"] = src_photo.get("city") or src_photo.get("location_city") or meta.get("city")

    if paired_raw_norm:
        meta["paired_raw_path"] = paired_raw_norm

    return meta


def import_photos_to_storage(photo_ids: List[int], destination: Optional[str] = "") -> Dict[str, Any]:
    """
    閲覧中の写真を Loome 内の指定フォルダへ物理コピーし、メタデータ・評価・調整値・GPS・タグ・サムネイルを
    引き継いで DB 登録する。
    Win32 CopyFileExW + マルチスレッド並列コピー + メタデータ再解析スキップ + 単一トランザクション一括登録により高速化する。
    """
    if not photo_ids:
        raise ValueError("インポートする写真が選択されていません")

    dest_dir, active_root = resolve_storage_target_with_root(destination, must_exist=False)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_norm = normalize_folder_path(str(dest_dir)).rstrip("\\/")

    if dest_dir == active_root:
        rel_label = "Loome (直下)"
    else:
        rel_label = str(dest_dir.relative_to(active_root)).replace("/", "\\")

    vol_info = get_volume_info(dest_norm)
    volume_serial = vol_info["serial"] if vol_info else None
    if vol_info and volume_serial:
        try:
            upsert_volume(vol_info["serial"], vol_info["label"], vol_info["drive"])
        except Exception as e:
            logger.warning(f"Loome ボリューム情報更新スキップ: {e}")

    new_ids: List[int] = []
    skipped = 0
    total_target = len(photo_ids)
    _update_storage_task_status(
        is_running=True,
        task_type="import",
        title="写真をコピー取り込み中...",
        current=0,
        total=total_target,
        current_file=rel_label,
    )

    try:
        # 1. 対象写真のDBレコードを一括取得し、コピー先フォルダの既存ファイル名セットを1回だけ走査
        clean_pids = [int(pid) for pid in photo_ids]
        unique_pids = list(dict.fromkeys(clean_pids))
        photo_map: Dict[int, Dict[str, Any]] = {}
        links_by_pid: Dict[int, List[Dict[str, Any]]] = {}

        with get_connection() as conn:
            chunk_size = 500
            for i in range(0, len(unique_pids), chunk_size):
                chunk = unique_pids[i : i + chunk_size]
                placeholders = ",".join("?" for _ in chunk)
                for row in conn.execute(f"SELECT * FROM photos WHERE id IN ({placeholders})", chunk).fetchall():
                    photo_map[int(row["id"])] = dict(row)
                for lk_row in conn.execute(
                    f"""
                    SELECT photo_id, file_path, directory_path, file_name, volume_serial, paired_raw_path, is_primary
                    FROM photo_links
                    WHERE photo_id IN ({placeholders})
                    ORDER BY is_primary DESC, id ASC
                    """,
                    chunk,
                ).fetchall():
                    links_by_pid.setdefault(int(lk_row["photo_id"]), []).append(dict(lk_row))

        reserved_names_lower: Set[str] = set()
        try:
            with os.scandir(dest_dir) as it:
                for entry in it:
                    reserved_names_lower.add(entry.name.lower())
        except Exception as scan_err:
            logger.debug(f"コピー先ディレクトリ走査スキップ ({dest_dir}): {scan_err}")

        copy_plans: List[Dict[str, Any]] = []
        dest_norm_low = dest_norm.lower()

        for raw_pid in clean_pids:
            photo = photo_map.get(raw_pid)
            if not photo:
                skipped += 1
                continue

            # 主リンクがオフラインの場合でも、オンラインのサブリンクがあればそこからコピー可能にする
            src_path: Optional[Path] = None
            active_vsn = photo.get("volume_serial")
            active_paired_raw = photo.get("paired_raw_path")

            candidate_links = [
                {
                    "file_path": photo.get("file_path"),
                    "volume_serial": photo.get("volume_serial"),
                    "paired_raw_path": photo.get("paired_raw_path"),
                }
            ] + links_by_pid.get(raw_pid, [])

            already_in_dest = False
            for cand in candidate_links:
                fp_str = cand.get("file_path")
                if not fp_str:
                    continue
                c_path, c_online = resolve_portable_path(fp_str, expected_serial=cand.get("volume_serial"))
                if c_online and c_path.exists():
                    c_parent_norm = normalize_folder_path(str(c_path.parent)).rstrip("\\/")
                    if c_parent_norm.lower() == dest_norm_low:
                        already_in_dest = True
                        break
                    if src_path is None:
                        src_path = c_path
                        active_vsn = cand.get("volume_serial")
                        active_paired_raw = cand.get("paired_raw_path") or active_paired_raw

            if already_in_dest or src_path is None:
                skipped += 1
                continue

            # ペアRAWの確認
            pair_src: Optional[Path] = None
            if active_paired_raw:
                p_cand, p_online = resolve_portable_path(active_paired_raw, expected_serial=active_vsn)
                if p_online and p_cand.exists() and p_cand.resolve() != src_path.resolve():
                    pair_src = p_cand

            pair_ext = pair_src.suffix if pair_src else None
            dest_file = _allocate_unique_dest_path(
                dest_dir, src_path.stem, src_path.suffix, reserved_names_lower, pair_ext=pair_ext
            )
            dest_pair_file: Optional[Path] = (dest_dir / f"{dest_file.stem}{pair_src.suffix}") if pair_src else None

            copy_plans.append(
                {
                    "photo": photo,
                    "src_path": src_path,
                    "dest_file": dest_file,
                    "pair_src": pair_src,
                    "dest_pair_file": dest_pair_file,
                    "file_size": int(photo.get("file_size") or 0),
                }
            )

        # 2. マルチスレッド + Win32 CopyFileExW による高速並列ファイルコピー
        progress_lock = threading.Lock()
        completed_count = skipped

        def _execute_copy_plan(plan: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
            nonlocal completed_count
            s_path: Path = plan["src_path"]
            d_file: Path = plan["dest_file"]
            p_src: Optional[Path] = plan["pair_src"]
            d_pair: Optional[Path] = plan["dest_pair_file"]
            f_size: int = plan["file_size"]
            try:
                fast_copy_file(s_path, d_file, file_size=f_size)
                copy_sidecars_for_file(s_path, d_file)
                if p_src and d_pair:
                    try:
                        p_size = p_src.stat().st_size
                    except Exception:
                        p_size = 0
                    fast_copy_file(p_src, d_pair, file_size=p_size)
                    copy_sidecars_for_file(p_src, d_pair)
                with progress_lock:
                    completed_count += 1
                    _update_storage_task_status(current=completed_count, current_file=s_path.name)
                return True, plan
            except Exception as copy_err:
                logger.warning(f"Loome への写真コピー失敗 ({s_path}): {copy_err}")
                with progress_lock:
                    completed_count += 1
                    _update_storage_task_status(current=completed_count, current_file=s_path.name)
                return False, plan

        copied_plans: List[Dict[str, Any]] = []
        if len(copy_plans) == 1:
            ok, pl = _execute_copy_plan(copy_plans[0])
            if ok:
                copied_plans.append(pl)
            else:
                skipped += 1
        elif len(copy_plans) > 1:
            avg_sz = sum(int(p.get("file_size") or 0) for p in copy_plans) // max(1, len(copy_plans))
            max_workers = _optimal_copy_workers(copy_plans[0]["src_path"], dest_dir, avg_sz, len(copy_plans))
            if max_workers <= 1:
                for pl in copy_plans:
                    ok, res_pl = _execute_copy_plan(pl)
                    if ok:
                        copied_plans.append(res_pl)
                    else:
                        skipped += 1
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                    results = list(executor.map(_execute_copy_plan, copy_plans))
                for ok, pl in results:
                    if ok:
                        copied_plans.append(pl)
                    else:
                        skipped += 1

        # 3. 単一トランザクションでの一括DB登録・メタデータ/タグ/サムネイル引き継ぎ
        missing_thumb_targets: List[Tuple[int, str]] = []
        if copied_plans:
            # ペアRAWで元レコードがDBにあるものを事前取得
            pair_src_norms = [
                normalize_folder_path(str(pl["pair_src"]))
                for pl in copied_plans
                if pl.get("pair_src") and pl.get("dest_pair_file")
            ]
            pair_photo_by_path: Dict[str, Dict[str, Any]] = {}
            with get_connection() as conn:
                cursor = conn.cursor()
                if pair_src_norms:
                    for i in range(0, len(pair_src_norms), 500):
                        chunk = pair_src_norms[i : i + 500]
                        ph = ",".join("?" for _ in chunk)
                        for prow in cursor.execute(
                            f"SELECT * FROM photos WHERE file_path IN ({ph}) COLLATE NOCASE", chunk
                        ).fetchall():
                            pair_photo_by_path[normalize_folder_path(prow["file_path"]).lower()] = dict(prow)

                for plan in copied_plans:
                    photo = plan["photo"]
                    src_id = int(photo["id"])
                    dest_file: Path = plan["dest_file"]
                    pair_src: Optional[Path] = plan["pair_src"]
                    dest_pair_file: Optional[Path] = plan["dest_pair_file"]

                    try:
                        paired_raw_norm = (
                            normalize_folder_path(str(dest_pair_file))
                            if (dest_pair_file and dest_pair_file.exists())
                            else None
                        )
                        meta = _build_copied_photo_meta(
                            photo, dest_file, dest_norm, volume_serial, paired_raw_norm=paired_raw_norm
                        )
                        new_id = _upsert_single_photo_in_tx(cursor, _sanitize_photo_data(meta))
                        if not new_id:
                            cursor.execute(
                                "SELECT id FROM photos WHERE file_path = ? COLLATE NOCASE", (meta["file_path"],)
                            )
                            r_ins = cursor.fetchone()
                            new_id = int(r_ins["id"]) if r_ins else 0

                        if not new_id:
                            skipped += 1
                            continue

                        # ペアRAWもコピーした場合は同一トランザクション内で DB に登録
                        if pair_src and dest_pair_file and dest_pair_file.exists():
                            try:
                                orig_pair_rec = pair_photo_by_path.get(normalize_folder_path(str(pair_src)).lower())
                                if orig_pair_rec:
                                    pair_meta = _build_copied_photo_meta(
                                        orig_pair_rec,
                                        dest_pair_file,
                                        dest_norm,
                                        volume_serial,
                                        paired_raw_norm=meta["file_path"],
                                    )
                                else:
                                    p_st = dest_pair_file.stat()
                                    p_ext = dest_pair_file.suffix.lower().lstrip(".").upper()
                                    pair_meta = _build_copied_photo_meta(
                                        photo,
                                        dest_pair_file,
                                        dest_norm,
                                        volume_serial,
                                        paired_raw_norm=meta["file_path"],
                                    )
                                    pair_meta["file_size"] = p_st.st_size
                                    pair_meta["file_mtime"] = p_st.st_mtime
                                    pair_meta["is_raw"] = 1
                                    pair_meta["raw_format"] = p_ext
                                _upsert_single_photo_in_tx(cursor, _sanitize_photo_data(pair_meta))
                            except Exception as pm_err:
                                logger.warning(f"ペアRAWのメタデータ登録スキップ ({dest_pair_file}): {pm_err}")

                        # 新規 photo_id が採番された場合（または既存レコードの調整値・ペアRAWパス更新）
                        if new_id != src_id:
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
                            cursor.execute(
                                "SELECT tag, source, confidence FROM photo_tags WHERE photo_id = ?",
                                (src_id,),
                            )
                            tag_rows = cursor.fetchall()
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
                        elif meta.get("paired_raw_path"):
                            cursor.execute(
                                "UPDATE photos SET paired_raw_path = COALESCE(paired_raw_path, ?) WHERE id = ?",
                                (meta["paired_raw_path"], new_id),
                            )

                        # サムネイルの引き継ぎ（同一 photo_id で既にサムネイルが存在する場合は再書き込み不要）
                        cursor.execute(
                            "SELECT data, width, height FROM thumbnails WHERE photo_id = ?",
                            (src_id,),
                        )
                        orig_thumb = cursor.fetchone()
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
                            missing_thumb_targets.append((new_id, meta["file_path"]))

                        new_ids.append(new_id)
                    except Exception as db_err:
                        logger.error(f"インポート写真のDB登録エラー ({dest_file}): {db_err}")
                        skipped += 1

                conn.commit()
                bump_db_commit_seq()

        # 元写真にサムネイルが無かったもののみトランザクション後に生成
        for nid, fp in missing_thumb_targets:
            try:
                ensure_thumbnail(nid, fp)
            except Exception as th_err:
                logger.warning(f"インポート写真のサムネイル生成スキップ ({fp}): {th_err}")
    finally:
        _update_storage_task_status(is_running=False, current=total_target, current_file="")

    if new_ids:
        try:
            recalculate_stacks(dest_norm, recursive=False)
        except Exception as st_err:
            logger.warning(f"Loome インポート後のスタック再計算スキップ: {st_err}")

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
    Loome 内の写真を指定された Loome 内サブフォルダ（または直下）へ移動し、
    同一 ID レコードのパス情報を更新する。
    """
    if not photo_ids:
        raise ValueError("移動する写真が選択されていません")

    dest_dir, active_root = resolve_storage_target_with_root(destination, must_exist=False)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_norm = normalize_folder_path(str(dest_dir)).rstrip("\\/")

    if dest_dir == active_root:
        rel_label = "Loome (直下)"
    else:
        rel_label = str(dest_dir.relative_to(active_root)).replace("/", "\\")

    dest_vol_info = get_volume_info(dest_norm)
    dest_vsn = dest_vol_info["serial"] if dest_vol_info else None
    if dest_vol_info and dest_vsn:
        try:
            upsert_volume(dest_vol_info["serial"], dest_vol_info["label"], dest_vol_info["drive"])
        except Exception as e:
            logger.warning(f"Loome 移動先ボリューム情報更新スキップ: {e}")

    moved = 0
    skipped = 0
    total_target = len(photo_ids)
    _update_storage_task_status(
        is_running=True,
        task_type="move",
        title="写真を移動中...",
        current=0,
        total=total_target,
        current_file=rel_label,
    )

    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            for idx, raw_pid in enumerate(photo_ids, start=1):
                _update_storage_task_status(current=idx)
                raw_photo = get_photo_by_id(int(raw_pid))
                photo = _resolve_storage_photo_entry(raw_photo)
                if not photo:
                    skipped += 1
                    continue

                src_path_str = photo.get("file_path")
                if not src_path_str:
                    skipped += 1
                    continue

                src_path, is_online = resolve_portable_path(src_path_str, expected_serial=photo.get("volume_serial"))
                if not is_online or not src_path.exists():
                    skipped += 1
                    continue

                src_parent_norm = normalize_folder_path(str(src_path.parent)).rstrip("\\/")
                if src_parent_norm.lower() == dest_norm.lower():
                    skipped += 1
                    continue

                # ペアRAWが Loome 内に存在する場合は連動移動
                pair_src: Optional[Path] = None
                paired_raw_str = photo.get("paired_raw_path")
                if paired_raw_str and is_path_in_storage(paired_raw_str, volume_serial=photo.get("volume_serial")):
                    p_cand, p_online = resolve_portable_path(paired_raw_str, expected_serial=photo.get("volume_serial"))
                    if p_online and p_cand.exists() and p_cand.resolve() != src_path.resolve():
                        pair_src = p_cand

                pair_ext = pair_src.suffix if pair_src else None
                dest_file = _unique_dest_path(dest_dir, src_path.stem, src_path.suffix, pair_ext=pair_ext)
                dest_pair_file: Optional[Path] = None
                if pair_src:
                    dest_pair_file = dest_dir / f"{dest_file.stem}{pair_src.suffix}"

                try:
                    _update_storage_task_status(current=idx, current_file=src_path.name)
                    move_sidecars_for_file(src_path, dest_file)
                    shutil.move(str(src_path), str(dest_file))
                    if pair_src and dest_pair_file:
                        move_sidecars_for_file(pair_src, dest_pair_file)
                        shutil.move(str(pair_src), str(dest_pair_file))
                except Exception as mv_err:
                    logger.warning(f"Loome 内の写真移動失敗 ({src_path}): {mv_err}")
                    skipped += 1
                    continue

                new_fp = normalize_folder_path(str(dest_file))
                new_pair_fp = normalize_folder_path(str(dest_pair_file)) if dest_pair_file else paired_raw_str
                eff_vsn = dest_vsn or photo.get("volume_serial")

                cursor.execute(
                    """
                    UPDATE photos
                    SET file_path = ?, directory_path = ?, file_name = ?, paired_raw_path = ?,
                        volume_serial = COALESCE(?, volume_serial),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (new_fp, dest_norm, dest_file.name, new_pair_fp, eff_vsn, photo["id"]),
                )
                _sync_photo_link_on_storage_change(
                    cursor, photo["id"], src_path_str, new_fp, dest_norm, dest_file.name, new_pair_fp, volume_serial=eff_vsn
                )
                new_hash = compute_thumbnail_hash(new_fp)
                cursor.execute(
                    "UPDATE OR IGNORE thumbnails SET file_hash = ? WHERE photo_id = ?",
                    (new_hash, photo["id"]),
                )

                # ペアRAW自身のレコードが photos にあれば同時更新
                if pair_src and dest_pair_file and new_pair_fp:
                    old_pair_norm = normalize_folder_path(str(pair_src))
                    cursor.execute("SELECT id FROM photos WHERE file_path = ? COLLATE NOCASE", (old_pair_norm,))
                    pair_row = cursor.fetchone()
                    cursor.execute(
                        """
                        UPDATE photos
                        SET file_path = ?, directory_path = ?, file_name = ?, paired_raw_path = ?,
                            volume_serial = COALESCE(?, volume_serial),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE file_path = ? COLLATE NOCASE
                        """,
                        (new_pair_fp, dest_norm, dest_pair_file.name, new_fp, eff_vsn, old_pair_norm),
                    )
                    if pair_row:
                        _sync_photo_link_on_storage_change(
                            cursor, pair_row["id"], old_pair_norm, new_pair_fp, dest_norm, dest_pair_file.name, new_fp, volume_serial=eff_vsn
                        )

                moved += 1

            conn.commit()
    finally:
        _update_storage_task_status(is_running=False, current=total_target, current_file="")

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
    Loome 内の単一写真のファイル名を変更する（元の拡張子は維持し、同フォルダのペアRAWも連動リネーム）。
    """
    raw_photo = get_photo_by_id(int(photo_id))
    if not raw_photo:
        raise ValueError("写真が見つかりません")

    photo = _resolve_storage_photo_entry(raw_photo)
    if not photo:
        raise ValueError("Loome 内の写真のみファイル名を変更できます")

    src_path, is_online = resolve_portable_path(photo["file_path"], expected_serial=photo.get("volume_serial"))
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
    dir_norm = normalize_folder_path(str(src_path.parent)).rstrip("\\/")

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

    # Loome 内のペアRAW確認（同フォルダだけでなく Loome 配下の別サブフォルダにあるペアRAWも連動リネーム）
    pair_src: Optional[Path] = None
    pair_new: Optional[Path] = None
    paired_raw_str = photo.get("paired_raw_path")
    if paired_raw_str and is_path_in_storage(paired_raw_str, volume_serial=photo.get("volume_serial")):
        p_cand, p_online = resolve_portable_path(paired_raw_str, expected_serial=photo.get("volume_serial"))
        if (
            p_online
            and p_cand.exists()
            and is_path_in_storage(str(p_cand), volume_serial=photo.get("volume_serial"))
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
        _sync_photo_link_on_storage_change(
            cursor, photo_id, photo["file_path"], new_norm, dir_norm, new_path.name, new_pair_norm, volume_serial=photo.get("volume_serial")
        )
        new_hash = compute_thumbnail_hash(new_norm)
        cursor.execute(
            "UPDATE OR IGNORE thumbnails SET file_hash = ? WHERE photo_id = ?",
            (new_hash, photo_id),
        )

        if pair_src and pair_new and new_pair_norm:
            old_pair_norm = normalize_folder_path(str(pair_src))
            pair_dir_norm = normalize_folder_path(str(pair_new.parent)).rstrip("\\/")
            cursor.execute("SELECT id FROM photos WHERE file_path = ? COLLATE NOCASE", (old_pair_norm,))
            pair_row = cursor.fetchone()
            cursor.execute(
                """
                UPDATE photos
                SET file_name = ?, file_path = ?, paired_raw_path = ?, updated_at = CURRENT_TIMESTAMP
                WHERE file_path = ? COLLATE NOCASE
                """,
                (pair_new.name, new_pair_norm, new_norm, old_pair_norm),
            )
            if pair_row:
                _sync_photo_link_on_storage_change(
                    cursor, pair_row["id"], old_pair_norm, new_pair_norm, pair_dir_norm, pair_new.name, new_norm, volume_serial=photo.get("volume_serial")
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
    Loome 内の複数写真を撮影日時昇順（date_taken ASC, id ASC）で一括連番リネームする。
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
        raw_p = get_photo_by_id(pid)
        p = _resolve_storage_photo_entry(raw_p)
        if not p:
            skipped += 1
            continue
        src_path, is_online = resolve_portable_path(p["file_path"], expected_serial=p.get("volume_serial"))
        if not is_online or not src_path.exists():
            skipped += 1
            continue

        pair_src: Optional[Path] = None
        paired_raw_str = p.get("paired_raw_path")
        if paired_raw_str and is_path_in_storage(paired_raw_str, volume_serial=p.get("volume_serial")):
            p_cand, p_online = resolve_portable_path(paired_raw_str, expected_serial=p.get("volume_serial"))
            if (
                p_online
                and p_cand.exists()
                and is_path_in_storage(str(p_cand), volume_serial=p.get("volume_serial"))
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
        raise ValueError("Loome 内のリネーム可能な写真が見つかりませんでした")

    # 撮影日時昇順 (date_taken ASC, id ASC) にソート
    valid_entries.sort(key=lambda e: (str(e["photo"].get("date_taken") or ""), int(e["photo"]["id"])))

    batch_token = uuid.uuid4().hex[:8]
    total_rename = len(valid_entries)
    _update_storage_task_status(
        is_running=True,
        task_type="rename",
        title="一括リネーム中...",
        current=0,
        total=total_rename,
        current_file="",
    )

    try:
        # 第1段階: すべての対象ファイル（および Loome 内のペアRAW・付随サイドカー）を一時ファイル名へリネーム
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

            _update_storage_task_status(current=idx + 1, current_file=final_path.name)
            tmp_path.rename(final_path)
            rename_sidecars_for_file(tmp_path, final_path)

            final_pair_path: Optional[Path] = None
            if tmp_pair:
                final_pair_path = tmp_pair.parent / f"{final_path.stem}{tmp_pair.suffix}"
                tmp_pair.rename(final_pair_path)
                rename_sidecars_for_file(tmp_pair, final_pair_path)

            new_fp_norm = normalize_folder_path(str(final_path))
            new_dp_norm = normalize_folder_path(str(final_path.parent)).rstrip("\\/")
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
                "old_path": photo["file_path"],
                "new_name": final_path.name,
                "new_path": new_fp_norm,
                "new_dir_path": new_dp_norm,
                "volume_serial": photo.get("volume_serial"),
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
                _sync_photo_link_on_storage_change(
                    cursor,
                    upd["photo_id"],
                    upd["old_path"],
                    upd["new_path"],
                    upd["new_dir_path"],
                    upd["new_name"],
                    upd["new_pair_path"],
                    volume_serial=upd["volume_serial"],
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
    finally:
        _update_storage_task_status(is_running=False, current=total_rename, current_file="")

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
    Loome 内の指定フォルダ（直下またはサブフォルダ）をサブフォルダ構造ごと外部の指定フォルダへコピー出力する。
    destination_dir が未指定の場合はフォルダ選択ダイアログを表示する。
    """
    src_dir, active_root = resolve_storage_target_with_root(folder_path, must_exist=True)

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

    out_folder_name = "Loome_export" if src_dir == active_root else src_dir.name
    out_dir = dest_base / out_folder_name
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        raise ValueError(f"エクスポート先フォルダの作成に失敗しました: {e}")

    exported_count = 0
    exported_image_pairs: List[Tuple[Path, Path]] = []
    # 事前にコピー対象ファイル総数をカウント
    total_export_files = 0
    for _r, _d, _files in os.walk(src_dir, topdown=True):
        _d[:] = [d for d in _d if not d.startswith(".") and not d.startswith("$")]
        total_export_files += sum(1 for fn in _files if not fn.startswith("."))

    _update_storage_task_status(
        is_running=True,
        task_type="export",
        title="外部フォルダへエクスポート中...",
        current=0,
        total=total_export_files,
        current_file=out_folder_name,
    )
    try:
        export_copy_tasks: List[Tuple[Path, Path]] = []
        for root, dirs, files in os.walk(src_dir, topdown=True):
            dirs[:] = [d for d in dirs if not d.startswith(".") and not d.startswith("$")]
            curr_path = Path(root)
            rel = curr_path.relative_to(src_dir)
            target_sub = out_dir if str(rel) == "." else (out_dir / rel)
            target_sub.mkdir(parents=True, exist_ok=True)

            reserved_sub: Set[str] = set()
            try:
                with os.scandir(target_sub) as it:
                    for entry in it:
                        reserved_sub.add(entry.name.lower())
            except Exception:
                pass

            for fname in files:
                if fname.startswith("."):
                    continue
                s_file = curr_path / fname
                d_file = _allocate_unique_dest_path(target_sub, s_file.stem, s_file.suffix, reserved_sub)
                export_copy_tasks.append((s_file, d_file))

        exp_lock = threading.Lock()

        def _copy_export_pair(pair: Tuple[Path, Path]) -> Tuple[Path, Path]:
            nonlocal exported_count
            s_f, d_f = pair
            try:
                f_sz = s_f.stat().st_size
            except Exception:
                f_sz = 0
            fast_copy_file(s_f, d_f, file_size=f_sz)
            with exp_lock:
                exported_count += 1
                _update_storage_task_status(current=exported_count, current_file=s_f.name)
            return s_f, d_f

        if len(export_copy_tasks) == 1:
            s_f, d_f = _copy_export_pair(export_copy_tasks[0])
            if s_f.suffix.lower() in SUPPORTED_EXTENSIONS:
                exported_image_pairs.append((s_f, d_f))
        elif len(export_copy_tasks) > 1:
            exp_workers = _optimal_copy_workers(src_dir, out_dir, 0, len(export_copy_tasks))
            if exp_workers <= 1:
                copied_pairs = [_copy_export_pair(t) for t in export_copy_tasks]
            else:
                with concurrent.futures.ThreadPoolExecutor(max_workers=exp_workers) as executor:
                    copied_pairs = list(executor.map(_copy_export_pair, export_copy_tasks))
            for s_f, d_f in copied_pairs:
                if s_f.suffix.lower() in SUPPORTED_EXTENSIONS:
                    exported_image_pairs.append((s_f, d_f))

        # DBに登録されている写真について、評価・タグ・GPS・調整情報を反映した .xmp サイドカーを一緒に出力
        for s_img, d_img in exported_image_pairs:
            try:
                s_norm = normalize_folder_path(str(s_img))
                db_rec = get_photo_by_path(s_norm)
                if db_rec and db_rec.get("id"):
                    full_photo = get_photo_by_id(int(db_rec["id"])) or db_rec
                    write_xmp_sidecar_for_photo(full_photo, d_img, remove_gps=False)
            except Exception as xmp_err:
                logger.warning(f"Loome フォルダエクスポート時の XMP 生成スキップ ({d_img}): {xmp_err}")
    finally:
        _update_storage_task_status(is_running=False, current=exported_count, current_file="")

    if open_after:
        open_folder_in_windows_explorer(out_dir)

    return {
        "status": "ok",
        "exported_files": exported_count,
        "exported_path": normalize_folder_path(str(out_dir)),
    }
