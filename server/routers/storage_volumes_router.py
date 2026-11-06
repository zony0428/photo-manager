"""
ボリューム（メディア/VSN）・PIN承認・外部Loome・アプリ内ストレージ (storage) 管理・重複解決 APIルーター
"""

import time
from typing import Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..database import (
    delete_photos_by_ids,
    get_all_duplicate_groups,
    get_all_volumes,
    get_volume_by_serial,
    remove_volume_by_serial,
    update_volume_custom_name,
)
from ..database.folders import clear_folders_fs_cache
from ..media_watcher import update_known_volume_meta
from ..scanner import clear_online_cache
from ..storage_manager import (
    batch_rename_photos_in_storage,
    create_storage_subfolder,
    delete_storage_subfolder,
    disable_volume_loome,
    enable_volume_loome,
    export_storage_folder,
    get_storage_folders,
    import_photos_to_storage,
    invalidate_loome_roots_cache,
    move_photos_in_storage,
    rename_photo_in_storage,
    rename_storage_subfolder,
)
from .common import _fast_json, clear_api_photos_cache

router = APIRouter()

# ボリュームラベル物理書き込み承認用の一時PIN管理（serial -> (pin, issued_monotonic)）
_VOLUME_LABEL_PINS: Dict[str, Tuple[str, float]] = {}


def issue_volume_label_pin(volume_serial: str) -> str:
    """指定VSNに対する物理ボリュームラベル書き込み承認用のランダム4桁PINを発行する"""
    import secrets

    serial_clean = (volume_serial or "").strip().upper()
    pin = f"{secrets.randbelow(9000) + 1000:04d}"
    _VOLUME_LABEL_PINS[serial_clean] = (pin, time.monotonic())
    return pin


def verify_volume_label_pin(volume_serial: str, pin: Optional[str]) -> bool:
    """発行済みの4桁承認PINを検証する（有効期限10分・使い捨て）"""
    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean or not pin:
        return False
    entry = _VOLUME_LABEL_PINS.get(serial_clean)
    if not entry:
        return False
    expected_pin, issued_at = entry
    if time.monotonic() - issued_at > 600.0:
        _VOLUME_LABEL_PINS.pop(serial_clean, None)
        return False
    if str(pin).strip() != expected_pin:
        return False
    _VOLUME_LABEL_PINS.pop(serial_clean, None)
    return True


class UpdateVolumeNameRequest(BaseModel):
    custom_name: str = ""
    volume_label: Optional[str] = None
    drive_letter: Optional[str] = None
    write_volume_label: bool = False
    new_volume_label: Optional[str] = None
    approval_pin: Optional[str] = None


@router.get("/api/volumes")
def api_get_volumes():
    """登録済みの全メディア（ボリューム）一覧と各メディアの写真枚数・撮影期間・カメラ機種・接続状態を取得する"""
    volumes = get_all_volumes()
    return {"volumes": volumes}


@router.delete("/api/volumes/{volume_serial}")
def api_delete_volume(volume_serial: str):
    """指定されたボリューム（SDカード・外部メディア）の写真登録と管理情報をDBから一括解除する（実ファイルは削除しない）"""
    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean:
        raise HTTPException(status_code=400, detail="ボリュームシリアル番号が指定されていません")
    res = remove_volume_by_serial(serial_clean)
    clear_online_cache()
    clear_folders_fs_cache()
    invalidate_loome_roots_cache()
    clear_api_photos_cache()
    return {"status": "ok", **res}


@router.get("/api/volumes/{volume_serial}/status")
def api_get_volume_status(volume_serial: str):
    """指定されたボリュームの接続状態・ファイルシステム種別・承認用ランダム4桁PINを取得する"""
    from ..volume_info import find_online_drive_for_serial

    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean:
        raise HTTPException(status_code=400, detail="ボリュームシリアル番号が指定されていません")

    db_vol = get_volume_by_serial(serial_clean) or {}
    online_info = find_online_drive_for_serial(serial_clean)
    approval_pin = issue_volume_label_pin(serial_clean)

    return {
        "status": "ok",
        "volume_serial": serial_clean,
        "custom_name": db_vol.get("custom_name") or "",
        "volume_label": (online_info.get("label") if online_info else db_vol.get("volume_label")) or "",
        "drive_letter": (online_info.get("drive") if online_info else db_vol.get("drive_letter")) or "",
        "filesystem": (online_info.get("filesystem") if online_info else "") or "",
        "is_online": bool(online_info),
        "approval_pin": approval_pin,
    }


@router.put("/api/volumes/{volume_serial}")
def api_update_volume_name(volume_serial: str, req: UpdateVolumeNameRequest):
    """
    指定されたボリューム（SDカード・外付けメディア等）のカスタム識別名（ニックネーム）を設定・更新する。
    write_volume_label=True の場合は、2バイト文字禁止チェックおよびランダム4桁PIN承認を検証した上で
    メディア本体の物理ボリュームラベルも書き換える（未承認時は一切触らない）。
    """
    from ..volume_info import set_physical_volume_label, validate_ascii_volume_label

    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean:
        raise HTTPException(status_code=400, detail="ボリュームシリアル番号が指定されていません")

    try:
        updated_phys_label: Optional[str] = req.volume_label
        updated_drive: Optional[str] = req.drive_letter
        wrote_physical = False

        if req.write_volume_label:
            # 1. まず文字種（2バイト文字禁止・11文字以内）を検証
            clean_phys_label = validate_ascii_volume_label(req.new_volume_label or "")
            # 2. ランダム4桁PINによる承認チェック
            if not verify_volume_label_pin(serial_clean, req.approval_pin):
                raise ValueError("承認用の4桁PIN番号が一致しないため、メディアのボリュームラベル書き込みを中止しました。")
            # 3. 物理ボリュームラベルの書き込み
            phys_res = set_physical_volume_label(serial_clean, clean_phys_label)
            updated_phys_label = phys_res.get("volume_label", clean_phys_label)
            updated_drive = phys_res.get("drive") or updated_drive
            wrote_physical = True

        vol = update_volume_custom_name(
            volume_serial=serial_clean,
            custom_name=req.custom_name,
            volume_label=updated_phys_label,
            drive_letter=updated_drive,
        )
        clear_online_cache()
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        update_known_volume_meta(
            serial_clean,
            custom_name=vol.get("custom_name", ""),
            label=vol.get("volume_label", ""),
            drive=vol.get("drive_letter"),
        )
        return {
            "status": "ok",
            "volume": vol,
            "custom_name": vol.get("custom_name", ""),
            "volume_label": vol.get("volume_label", ""),
            "wrote_physical_label": wrote_physical,
        }
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class EnableVolumeLoomeRequest(BaseModel):
    drive_letter: Optional[str] = None


@router.post("/api/volumes/{volume_serial}/loome")
def api_enable_volume_loome(volume_serial: str, req: Optional[EnableVolumeLoomeRequest] = None):
    """接続中の指定ボリューム（ドライブ）直下に Loome フォルダを作成し、外部 Loome として登録する"""
    try:
        drive_letter = req.drive_letter if req else None
        res = enable_volume_loome(volume_serial, drive_letter=drive_letter)
        clear_online_cache()
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/volumes/{volume_serial}/loome")
def api_disable_volume_loome(volume_serial: str):
    """指定ボリュームの Loome 登録を解除する（実フォルダおよび写真ファイルは削除しない）"""
    try:
        res = disable_volume_loome(volume_serial)
        clear_online_cache()
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==============================================================================
# アプリ内ストレージ (storage) 管理 API
# ==============================================================================

class StorageCreateFolderRequest(BaseModel):
    parent_path: Optional[str] = ""
    folder_name: str


class StorageRenameFolderRequest(BaseModel):
    folder_path: str
    new_name: str


class StorageDeleteFolderRequest(BaseModel):
    folder_path: str


class StorageImportPhotosRequest(BaseModel):
    photo_ids: List[int]
    destination: Optional[str] = ""


class StorageMovePhotosRequest(BaseModel):
    photo_ids: List[int]
    destination: Optional[str] = ""


class StorageRenamePhotoRequest(BaseModel):
    photo_id: int
    new_name: str


class StorageBatchRenamePhotosRequest(BaseModel):
    photo_ids: List[int]
    naming_rule: str = "date_seq"
    custom_prefix: Optional[str] = "Photo"
    start_number: int = 1


class StorageExportFolderRequest(BaseModel):
    folder_path: Optional[str] = ""
    destination_dir: Optional[str] = None
    open_after: bool = True


@router.get("/api/storage/folders")
def api_get_storage_folders():
    """storage 配下の全フォルダ階層と各フォルダの写真枚数を取得する"""
    try:
        return get_storage_folders()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/storage/folders")
def api_create_storage_folder(req: StorageCreateFolderRequest):
    """storage 内に新しいサブフォルダを作成する"""
    try:
        res = create_storage_subfolder(req.parent_path, req.folder_name)
        clear_folders_fs_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/api/storage/folders/rename")
def api_rename_storage_folder(req: StorageRenameFolderRequest):
    """storage 内のサブフォルダ名を変更し、DB内の写真パスも追従更新する"""
    try:
        res = rename_storage_subfolder(req.folder_path, req.new_name)
        clear_folders_fs_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/storage/folders")
def api_delete_storage_folder(
    req: Optional[StorageDeleteFolderRequest] = None,
    folder_path: Optional[str] = Query(default=None),
):
    """storage 内の空サブフォルダを削除する"""
    target_path = (req.folder_path if req and req.folder_path else folder_path) or ""
    try:
        res = delete_storage_subfolder(target_path)
        clear_folders_fs_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/storage/import-photos")
def api_import_photos_to_storage(req: StorageImportPhotosRequest):
    """選択された写真を storage の指定フォルダへ物理コピーし、メタデータ・タグ・評価・調整値を引き継いでDB登録する"""
    try:
        res = import_photos_to_storage(req.photo_ids, req.destination)
        clear_folders_fs_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/storage/move-photos")
def api_move_photos_in_storage(req: StorageMovePhotosRequest):
    """storage 内の写真を別の storage フォルダへ移動し、DBパスを更新する"""
    try:
        res = move_photos_in_storage(req.photo_ids, req.destination)
        clear_folders_fs_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/storage/rename-photo")
def api_rename_photo_in_storage(req: StorageRenamePhotoRequest):
    """storage 内の単一写真のファイル名を変更する"""
    try:
        res = rename_photo_in_storage(req.photo_id, req.new_name)
        clear_folders_fs_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/storage/batch-rename-photos")
def api_batch_rename_photos_in_storage(req: StorageBatchRenamePhotosRequest):
    """storage 内の複数写真を撮影日時昇順で一括連番リネームする"""
    try:
        res = batch_rename_photos_in_storage(
            req.photo_ids,
            naming_rule=req.naming_rule,
            custom_prefix=req.custom_prefix or "Photo",
            start_number=req.start_number,
        )
        clear_folders_fs_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/storage/export-folder")
def api_export_storage_folder(req: StorageExportFolderRequest):
    """storage 内のフォルダをサブフォルダ構造ごと外部の指定先へコピー出力する"""
    try:
        return export_storage_folder(
            folder_path=req.folder_path or "",
            destination_dir=req.destination_dir,
            open_after=req.open_after,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/duplicates")
def api_get_duplicates(limit: int = 100):
    """ライブラリ内の重複写真グループ一覧および品質スコアに基づく代表写真情報を高速取得する"""
    groups = get_all_duplicate_groups(limit=limit)
    return _fast_json(groups)


class DuplicatesResolveRequest(BaseModel):
    photo_ids: Optional[List[int]] = None
    delete_photo_ids: Optional[List[int]] = None


@router.post("/api/duplicates/resolve")
def api_resolve_duplicates(req: DuplicatesResolveRequest):
    """重複解消として指定された写真群をライブラリから一括解除し、キャッシュを即時無効化する"""
    target_ids = req.delete_photo_ids or req.photo_ids or []
    deleted = delete_photos_by_ids(target_ids) if target_ids else 0
    clear_folders_fs_cache()
    invalidate_loome_roots_cache()
    clear_api_photos_cache()
    return {"status": "ok", "deleted": deleted}
