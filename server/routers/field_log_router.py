"""
フィールドログ（GPS足跡採取・時刻照合・位置付与・Undo・GPX出力）APIルーター
"""

import json
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from ..database import (
    apply_field_log_matches,
    list_field_log_batches,
    preview_field_log_matches,
    undo_field_log_batch,
)
from ..field_log_store import (
    FieldLogTooLargeError,
    MAX_DAY_BYTES,
    delete_field_logs,
    export_day_gpx,
    list_field_logs,
    save_uploaded_day,
)
from ..security import is_app_locked
from .common import _fast_json, _require_localhost, clear_api_photos_cache

router = APIRouter()

# JSONラッパー分を見込んだリクエストボディ全体の上限（12MB）
_MAX_UPLOAD_BODY_BYTES = MAX_DAY_BYTES + (4 * 1024 * 1024)


class MobileFieldLogUploadRequest(BaseModel):
    device_id: str
    device_name: str = ""
    date: str
    sha256: str
    content: str


class FieldLogDeleteTarget(BaseModel):
    device_id: str
    date: str


class FieldLogDeleteRequest(BaseModel):
    targets: Optional[List[FieldLogDeleteTarget]] = None
    all: bool = False
    delete_all: bool = False


class FieldLogMatchRequest(BaseModel):
    device_id: Optional[str] = None
    date: Optional[str] = None
    dates: Optional[List[str]] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    folder: Optional[str] = None
    directory_path: Optional[str] = None
    volume_serial: Optional[str] = None
    photo_ids: Optional[List[int]] = None
    camera_offsets: Dict[str, int] = Field(default_factory=dict)
    max_gap_sec: int = Field(default=300, ge=0, le=86400)
    max_nearest_sec: int = Field(default=120, ge=0, le=86400)
    overwrite: str = "missing_only"


class FieldLogUndoRequest(BaseModel):
    batch_id: str


@router.post("/api/mobile/field-logs")
async def api_mobile_upload_field_log(request: Request):
    """
    スマートフォンから1日分のフィールドログ（JSONL）を受け取り検証・保存する。
    LAN経由のアクセスを許可する（ミドルウェアにて永続ペアリングトークン認証が必須）。
    """
    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    body_chunks = []
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > _MAX_UPLOAD_BODY_BYTES:
            raise HTTPException(status_code=413, detail="フィールドログのサイズが上限（8MB/日）を超えています")
        body_chunks.append(chunk)
    body_bytes = b"".join(body_chunks)

    try:
        payload = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        if not isinstance(payload, dict):
            raise ValueError("JSONオブジェクトである必要があります")
        req = MobileFieldLogUploadRequest(**payload)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"リクエストデータの形式が不正です: {e}")

    try:
        res = await run_in_threadpool(
            save_uploaded_day,
            device_id=req.device_id,
            device_name=req.device_name,
            date_str=req.date,
            sha256_hex=req.sha256,
            content_str=req.content,
        )
        return _fast_json(res)
    except FieldLogTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/field-logs")
def api_list_field_logs(request: Request):
    """PC内に保存されている端末別・日別フィールドログの一覧を返す（localhost専用）"""
    _require_localhost(request)
    return _fast_json(list_field_logs())


@router.post("/api/field-logs/delete")
def api_delete_field_logs(request: Request, req: FieldLogDeleteRequest):
    """指定日または全件のフィールドログファイルを削除する（適用済みの写真位置は消さない・localhost専用）"""
    _require_localhost(request)
    do_all = bool(req.all or req.delete_all)
    if not do_all and not req.targets:
        raise HTTPException(status_code=400, detail="削除対象（targets または all=true）を指定してください")

    target_dicts = (
        [{"device_id": t.device_id, "date": t.date} for t in req.targets]
        if req.targets
        else None
    )
    try:
        res = delete_field_logs(targets=target_dicts, delete_all=do_all)
        return _fast_json(res)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/api/field-logs/match/batches")
def api_list_field_log_batches(request: Request):
    """フィールドログ位置付与の適用履歴一覧を返す（localhost専用）"""
    _require_localhost(request)
    return _fast_json({"ok": True, "batches": list_field_log_batches()})


@router.get("/api/field-logs/{device_id}/{date}.gpx")
def api_export_field_log_gpx(request: Request, device_id: str, date: str):
    """指定日分のフィールドログを GPX 1.1 形式で書き出す（localhost専用）"""
    _require_localhost(request)
    try:
        gpx_xml = export_day_gpx(device_id=device_id, date_str=date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    safe_prefix = device_id[:8]
    headers = {
        "Content-Disposition": f'attachment; filename="fieldlog_{safe_prefix}_{date}.gpx"',
    }
    return Response(
        content=gpx_xml.encode("utf-8"),
        media_type="application/gpx+xml; charset=utf-8",
        headers=headers,
    )


@router.post("/api/field-logs/match/preview")
def api_preview_field_log_matches(request: Request, req: FieldLogMatchRequest):
    """指定条件でフィールドログと写真を時刻照合し、書き込まずにプレビュー結果を返す（localhost専用）"""
    _require_localhost(request)
    eff_folder = req.folder if (req.folder and req.folder.strip()) else req.directory_path
    try:
        res = preview_field_log_matches(
            device_id=req.device_id,
            date=req.date,
            dates=req.dates,
            date_from=req.date_from,
            date_to=req.date_to,
            folder=eff_folder,
            volume_serial=req.volume_serial,
            photo_ids=req.photo_ids,
            camera_offsets=req.camera_offsets,
            max_gap_sec=req.max_gap_sec,
            max_nearest_sec=req.max_nearest_sec,
            overwrite=req.overwrite,
        )
        return _fast_json(res)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/field-logs/match/apply")
def api_apply_field_log_matches(request: Request, req: FieldLogMatchRequest):
    """指定条件でサーバー側再計算により写真へ位置・地名を非破壊付与する（localhost専用）"""
    _require_localhost(request)
    eff_folder = req.folder if (req.folder and req.folder.strip()) else req.directory_path
    try:
        res = apply_field_log_matches(
            device_id=req.device_id,
            date=req.date,
            dates=req.dates,
            date_from=req.date_from,
            date_to=req.date_to,
            folder=eff_folder,
            volume_serial=req.volume_serial,
            photo_ids=req.photo_ids,
            camera_offsets=req.camera_offsets,
            max_gap_sec=req.max_gap_sec,
            max_nearest_sec=req.max_nearest_sec,
            overwrite=req.overwrite,
        )
        clear_api_photos_cache()
        return _fast_json(res)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/field-logs/match/undo")
def api_undo_field_log_batch(request: Request, req: FieldLogUndoRequest):
    """バッチIDを指定してフィールドログ位置付与を適用前の値に戻す（localhost専用）"""
    _require_localhost(request)
    try:
        res = undo_field_log_batch(req.batch_id)
        clear_api_photos_cache()
        return _fast_json(res)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
