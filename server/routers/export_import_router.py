"""
ピックアップ（take_out / import）＆ スマート・テイクアウト / コンタクトシート出力 APIルーター
"""

import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import get_photo_by_id
from ..exporter import (
    DEFAULT_TAKEOUT_DIR,
    detect_photo_privacy_masks,
    open_folder_in_windows_explorer,
    pick_folder_dialog,
    pick_watermark_image_dialog,
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
    include_raw: bool = False


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
    """選択された写真を take_out フォルダ（または指定サブフォルダ）へ無加工コピーする（include_raw=True 時はRAW原本も抱き合わせコピー）"""
    from ..raw_loader import is_raw_file
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)

    folder_target = (req.folder_name or req.destination or "").strip()
    if folder_target:
        sanitized = re.sub(r'[\\/*?:"<>|]', '_', folder_target).strip()
        dest_dir = IMPORT_DIR / sanitized
    else:
        dest_dir = IMPORT_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)

    copied = []
    raw_copied = []
    skipped = []
    errors = []

    for pid in req.photo_ids:
        photo = get_photo_by_id(pid)
        if not photo:
            continue

        jpg_src = None
        raw_src = None
        vol_serial = photo.get("volume_serial")
        main_fp = photo.get("file_path")
        if main_fp:
            p_main, is_main_online = resolve_portable_path(main_fp, expected_serial=vol_serial)
            if is_main_online and p_main.exists():
                if is_raw_file(p_main) or photo.get("is_raw"):
                    raw_src = p_main
                elif p_main.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
                    jpg_src = p_main

        paired_fp = photo.get("paired_raw_path")
        if paired_fp:
            p_paired, is_paired_online = resolve_portable_path(paired_fp, expected_serial=vol_serial)
            if is_paired_online and p_paired.exists():
                if is_raw_file(p_paired):
                    raw_src = p_paired
                elif not jpg_src and p_paired.suffix.lower() in (".jpg", ".jpeg"):
                    jpg_src = p_paired

        want_raw = bool(req.include_raw and raw_src)
        if not jpg_src and not want_raw:
            skipped.append(photo.get("file_name", str(pid)))
            continue

        base_stem = (jpg_src or raw_src).stem
        jpg_ext = jpg_src.suffix.lower() if jpg_src else ""
        raw_ext = raw_src.suffix if want_raw and raw_src else ""

        stem_candidate = base_stem
        counter = 1
        while (
            (jpg_ext and (dest_dir / f"{stem_candidate}{jpg_ext}").exists())
            or (raw_ext and (dest_dir / f"{stem_candidate}{raw_ext}").exists())
        ):
            stem_candidate = f"{base_stem}_{counter}"
            counter += 1

        if jpg_src:
            target_jpg = dest_dir / f"{stem_candidate}{jpg_ext}"
            try:
                copy_file_unsealed(jpg_src, target_jpg)
                copied.append(target_jpg.name)
            except Exception as e:
                errors.append(f"{jpg_src.name}: {e}")

        if want_raw and raw_src:
            target_raw = dest_dir / f"{stem_candidate}{raw_ext}"
            try:
                copy_file_unsealed(raw_src, target_raw)
                raw_copied.append(target_raw.name)
            except Exception as e:
                errors.append(f"{raw_src.name}: {e}")

    return {
        "status": "ok",
        "copied_count": len(copied),
        "raw_copied_count": len(raw_copied),
        "skipped_count": len(skipped),
        "copied_files": copied,
        "raw_copied_files": raw_copied,
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
    export_raw_original: bool = False
    open_folder_after: bool = True
    art_preset: Optional[str] = None
    seq_offset: int = 0
    privacy_masks: Optional[Dict[str, Any]] = None
    watermark: Optional[Dict[str, Any]] = None
    print_frame: Optional[Dict[str, Any]] = None


class DetectPrivacyRequest(BaseModel):
    photo_id: int
    apply_adjustments: bool = True
    detect_plates: bool = True
    detect_faces: bool = True


class PickWatermarkImageRequest(BaseModel):
    initial_path: Optional[str] = None


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


@router.post("/api/export/detect-privacy")
def api_detect_privacy_masks(req: DetectPrivacyRequest):
    """対象写真のナンバープレート4頂点および人物顔をローカルONNX推論で自動検出して提案する"""
    res = detect_photo_privacy_masks(
        photo_id=req.photo_id,
        apply_adjustments=req.apply_adjustments,
        detect_plates=req.detect_plates,
        detect_faces=req.detect_faces,
    )
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message") or "自動検出に失敗しました")
    return _fast_json(res)


@router.post("/api/export/pick-watermark-image")
def api_pick_watermark_image(req: Optional[PickWatermarkImageRequest] = None):
    """ウォーターマーク用のローカル透過PNG/WebPロゴ画像をファイル選択ダイアログで取得する"""
    init_path = req.initial_path if req else None
    return _fast_json(pick_watermark_image_dialog(init_path))
