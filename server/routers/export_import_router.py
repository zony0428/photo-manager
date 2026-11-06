"""
ピックアップ（take_out / import）＆ スマート・テイクアウト / コンタクトシート出力 APIルーター
"""

import logging
import os
import re
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import get_photo_by_id
from ..exporter import (
    DEFAULT_TAKEOUT_DIR,
    open_folder_in_windows_explorer,
    pick_folder_dialog,
    run_contact_sheet_export,
    run_smart_export,
)
from ..scanner import resolve_portable_path
from ..security import copy_file_unsealed
from .common import IMPORT_DIR, _fast_json

logger = logging.getLogger("photo_manager.app")

router = APIRouter()


class CreateImportFolderRequest(BaseModel):
    name: Optional[str] = None
    folder_name: Optional[str] = None


class CopyToImportRequest(BaseModel):
    photo_ids: List[int]
    folder_name: Optional[str] = None
    destination: Optional[str] = None


class OpenImportFolderRequest(BaseModel):
    folder_name: Optional[str] = None
    destination: Optional[str] = None


# ==============================================================================
# インポート（送る / ピックアップ）機能 (JPG限定)
# ==============================================================================

@router.get("/api/import/destinations")
def api_get_import_destinations():
    """take_out フォルダ直下の送り先フォルダ一覧を返す"""
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    root_count = sum(1 for f in IMPORT_DIR.iterdir() if f.is_file())
    destinations = [
        {
            "name": "take_out (直下)",
            "folder_name": "",
            "path": "",
            "file_count": root_count,
            "count": root_count,
            "is_root": True,
        }
    ]
    try:
        for entry in sorted(IMPORT_DIR.iterdir()):
            if entry.is_dir() and not entry.name.startswith("."):
                count = sum(1 for f in entry.iterdir() if f.is_file())
                destinations.append({
                    "name": entry.name,
                    "folder_name": entry.name,
                    "path": entry.name,
                    "file_count": count,
                    "count": count,
                    "is_root": False,
                })
    except Exception as e:
        logger.warning(f"送り先フォルダ一覧走査で警告 ({IMPORT_DIR}): {e}")

    return {
        "destinations": destinations,
        "root_file_count": root_count,
        "import_dir": str(IMPORT_DIR),
    }


@router.post("/api/import/folders")
def api_create_import_folder(req: CreateImportFolderRequest):
    """import フォルダ内に新規サブフォルダを作成する"""
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    raw_name = (req.name or req.folder_name or "").strip()
    if not raw_name:
        raise HTTPException(status_code=400, detail="フォルダ名を入力してください")

    # Windows ファイル名禁止文字を置換
    sanitized = re.sub(r'[\\/*?:"<>|]', '_', raw_name).strip()
    if not sanitized or sanitized.startswith("."):
        raise HTTPException(status_code=400, detail="無効なフォルダ名です")

    target_dir = IMPORT_DIR / sanitized
    target_dir.mkdir(parents=True, exist_ok=True)
    return {
        "status": "ok",
        "folder": {"name": sanitized, "folder_name": sanitized, "path": str(target_dir)},
        "folder_name": sanitized,
    }


@router.post("/api/import/copy")
def api_copy_to_import(req: CopyToImportRequest):
    """選択された写真を import フォルダ（または指定サブフォルダ）へコピーする (JPG限定)"""
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)

    folder_target = (req.folder_name or req.destination or "").strip()
    if folder_target:
        sanitized = re.sub(r'[\\/*?:"<>|]', '_', folder_target).strip()
        dest_dir = IMPORT_DIR / sanitized
    else:
        dest_dir = IMPORT_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)

    copied = []
    skipped = []
    errors = []

    for pid in req.photo_ids:
        photo = get_photo_by_id(pid)
        if not photo:
            continue

        # JPG/JPEG ファイルの特定（RAW限定ファイルはスキップ、RAW+JPGペアはJPG側）
        src_path = None

        vol_serial = photo.get("volume_serial")
        main_raw = photo.get("file_path")
        if main_raw:
            p_main, is_main_online = resolve_portable_path(main_raw, expected_serial=vol_serial)
            if is_main_online and p_main.suffix.lower() in (".jpg", ".jpeg"):
                src_path = p_main

        if not src_path:
            # RAW+JPG ペアの場合、ペアのJPG側を探す
            paired_raw = photo.get("paired_raw_path")
            if paired_raw:
                p_paired, is_paired_online = resolve_portable_path(paired_raw, expected_serial=vol_serial)
                if is_paired_online and p_paired.suffix.lower() in (".jpg", ".jpeg"):
                    src_path = p_paired

        if not src_path or not src_path.exists():
            skipped.append(photo.get("file_name", str(pid)))
            continue

        stem = src_path.stem
        ext = src_path.suffix.lower()

        # 同名衝突回避のためのナンバリング
        target_file = dest_dir / f"{stem}{ext}"
        counter = 1
        while target_file.exists():
            target_file = dest_dir / f"{stem}_{counter}{ext}"
            counter += 1

        try:
            copy_file_unsealed(src_path, target_file)
            copied.append(target_file.name)
        except Exception as e:
            errors.append(f"{src_path.name}: {e}")

    return {
        "status": "ok",
        "copied_count": len(copied),
        "skipped_count": len(skipped),
        "copied_files": copied,
        "skipped_files": skipped,
        "errors": errors,
        "destination_name": dest_dir.name if dest_dir != IMPORT_DIR else "take_out (直下)",
        "destination_path": str(dest_dir),
    }


@router.post("/api/import/open")
def api_open_import_folder(req: Optional[OpenImportFolderRequest] = None):
    """import フォルダ（または指定サブフォルダ）をエクスプローラーで開く"""
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    target_dir = IMPORT_DIR
    folder_target = (req.folder_name or req.destination or "").strip() if req else ""
    if folder_target:
        sanitized = re.sub(r'[\\/*?:"<>|]', '_', folder_target).strip()
        sub = IMPORT_DIR / sanitized
        if sub.exists():
            target_dir = sub

    try:
        os.startfile(str(target_dir))
        return {"status": "ok", "path": str(target_dir)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {e}")


# -------------------------------------------------------------
# スマート・テイクアウト（高機能エクスポート）API
# -------------------------------------------------------------

class SmartExportRequest(BaseModel):
    photo_ids: List[int]
    destination: Optional[str] = None
    format: str = "jpeg"
    quality: int = 90
    resize_mode: str = "original"
    custom_long_edge: Optional[int] = 1920
    naming_rule: str = "original"
    custom_prefix: Optional[str] = "Photo"
    apply_adjustments: bool = True
    exif_sync_db: bool = True
    exif_remove_gps: bool = False
    exif_remove_exposure: bool = False
    exif_remove_camera: bool = False
    exif_remove_other: bool = False
    exif_remove_all: bool = False
    export_xmp_sidecar: bool = False
    open_folder_after: bool = True


class ContactSheetExportRequest(BaseModel):
    photo_ids: List[int]
    title: Optional[str] = "Contact Sheet"
    theme: str = "darkroom"
    columns: int = 5
    destination_dir: Optional[str] = None
    destination: Optional[str] = None
    open_after: bool = True


class PickFolderRequest(BaseModel):
    initial_dir: Optional[str] = None


class OpenFolderRequest(BaseModel):
    folder_path: str


@router.get("/api/export/default-dir")
def api_get_default_export_dir():
    """テイクアウトの標準保存先パスを取得する"""
    return {"default_dir": str(DEFAULT_TAKEOUT_DIR)}


@router.post("/api/export/smart")
def api_smart_export(req: SmartExportRequest):
    """
    スマート・テイクアウト実行
    回転・クロップ・リサイズ・リネーム・Exif選択消去を一括適用して指定先へエクスポートする。
    """
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="エクスポート対象の写真が選択されていません")

    opts = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    result = run_smart_export(opts)

    # 完了後にフォルダを開く指定があれば開く
    if req.open_folder_after and result.get("destination"):
        open_folder_in_windows_explorer(Path(result["destination"]))

    return _fast_json(result)


@router.post("/api/export/contact-sheet")
def api_export_contact_sheet(req: ContactSheetExportRequest):
    """
    ベタ焼き（コンタクトシート）単一HTML出力を実行する。
    """
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="コンタクトシートに出力する写真が選択されていません")

    opts = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    result = run_contact_sheet_export(opts)
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("message") or "コンタクトシート出力エラー")
    return _fast_json(result)


@router.post("/api/export/pick-folder")
def api_pick_export_folder(req: Optional[PickFolderRequest] = None):
    """Windows標準のフォルダ選択ダイアログを表示してパスを取得する"""
    init_dir = req.initial_dir if req else None
    selected = pick_folder_dialog(init_dir)
    return {"selected_path": selected}


@router.post("/api/export/open-folder")
def api_open_export_folder(req: OpenFolderRequest):
    """指定されたフォルダをWindowsエクスプローラーで開く"""
    p = Path(req.folder_path)
    ok = open_folder_in_windows_explorer(p)
    return {"status": "ok" if ok else "error"}
