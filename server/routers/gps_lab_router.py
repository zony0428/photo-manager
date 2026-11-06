"""
GPS ジオタグ・ロケーション階層・撮影ラボ＆機材相性カルテ APIルーター
"""

from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..database import (
    backfill_photo_locations,
    batch_copy_gps,
    batch_infer_gps,
    cleanup_invalid_zero_gps,
    clear_inferred_gps,
    clear_photo_gps,
    find_nearby_gps_photos,
    get_lab_karte_data,
    get_location_heatmap_data,
    get_location_tree_summary,
    get_photo_by_id,
    get_random_unrated_folder,
    update_photo_gps,
)
from .common import _fast_json

router = APIRouter()


# --- GPS ジオタグ機能 ---

class CopyGpsRequest(BaseModel):
    source_photo_id: int


class BatchCopyGpsRequest(BaseModel):
    source_photo_id: int
    target_ids: List[int]


class BatchInferGpsRequest(BaseModel):
    photo_ids: Optional[List[int]] = None
    folder: Optional[str] = None
    max_minutes: int = 60


class ClearInferredGpsRequest(BaseModel):
    photo_ids: Optional[List[int]] = None
    folder: Optional[str] = None


class ClearGpsRequest(BaseModel):
    photo_ids: Optional[List[int]] = None
    folder: Optional[str] = None


@router.get("/api/photo/{photo_id}/gps-candidates")
def api_gps_candidates(photo_id: int, minutes: int = Query(default=60, ge=1, le=1440)):
    """指定写真の撮影時刻 ±N分（デフォルト60分）以内のGPS付き写真を候補として返す（直前・直後を分離）"""
    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    if not photo.get("date_taken"):
        return {"candidates": [], "before": None, "after": None}
    res = find_nearby_gps_photos(photo["date_taken"], minutes=minutes, exclude_id=photo_id)
    return res


@router.delete("/api/photo/{photo_id}/gps")
def api_delete_photo_gps(photo_id: int):
    """指定写真のSQLite上のジオタグ情報（緯度・経度・国・県・市）を削除する"""
    cleared = clear_photo_gps(photo_ids=[photo_id])
    if cleared == 0:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    return {"status": "ok", "photo_id": photo_id}


@router.post("/api/photo/{photo_id}/copy-gps")
def api_copy_gps(photo_id: int, req: CopyGpsRequest):
    """別の写真からGPSをコピーする"""
    source = get_photo_by_id(req.source_photo_id)
    if not source or source.get("latitude") is None:
        raise HTTPException(status_code=400, detail="コピー元の写真にGPS情報がありません")
    success = update_photo_gps(photo_id, source["latitude"], source["longitude"], "copied")
    if not success:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    return {"status": "ok", "photo_id": photo_id, "latitude": source["latitude"], "longitude": source["longitude"]}


@router.post("/api/photos/batch-copy-gps")
def api_batch_copy_gps(req: BatchCopyGpsRequest):
    """指定写真のGPSを複数の写真に一括コピーする"""
    count = batch_copy_gps(req.source_photo_id, req.target_ids)
    return {"status": "ok", "updated_count": count}


@router.post("/api/photos/batch-infer-gps")
def api_batch_infer_gps(req: BatchInferGpsRequest):
    """GPS情報のない写真に対して、撮影時刻が近いスマホ写真のGPSを一括準用する"""
    res = batch_infer_gps(photo_ids=req.photo_ids, folder=req.folder, max_minutes=req.max_minutes)
    return {"status": "ok", **res}


@router.post("/api/photos/clear-inferred-gps")
def api_clear_inferred_gps(req: ClearInferredGpsRequest):
    """準用されたGPS情報をクリアして元に戻す"""
    cleared = clear_inferred_gps(photo_ids=req.photo_ids, folder=req.folder)
    return {"status": "ok", "cleared_count": cleared}


@router.post("/api/photos/clear-gps")
def api_clear_gps(req: ClearGpsRequest):
    """指定写真（またはフォルダ内写真）のSQLite上のジオタグ情報（緯度・経度・地名）を一括削除する"""
    cleared = clear_photo_gps(photo_ids=req.photo_ids, folder=req.folder)
    return {"status": "ok", "cleared_count": cleared}


@router.post("/api/photos/cleanup-zero-gps")
def api_cleanup_zero_gps():
    """無効な(0, 0)のGPSエラーデータをSQLite上でクリーンアップする"""
    cleared = cleanup_invalid_zero_gps()
    return {"status": "ok", "cleared_count": cleared}


@router.post("/api/locations/backfill")
def api_backfill_locations(limit: int = Query(default=5000, ge=1, le=50000)):
    """既存のGPS付き写真（地名未設定）に対してローカル逆ジオコーディングを一括実行する"""
    count = backfill_photo_locations(limit=limit)
    return {"status": "ok", "updated_count": count}


@router.get("/api/locations/tree")
def api_get_locations_tree():
    """左ペイン表示用の国・都道府県・市区町村の階層ツリーと写真枚数を取得する"""
    data = get_location_tree_summary()
    return _fast_json(data)


@router.get("/api/locations/heatmap")
def api_get_locations_heatmap(
    date_filter: Optional[str] = None,
    date: Optional[str] = None,
):
    """ジオタグ47都道府県制覇マップ・ヒートマップ・撮影軌跡（フォトラリー）用の集計データを取得する"""
    target_date = date_filter or date
    data = get_location_heatmap_data(date_filter=target_date)
    return _fast_json(data)


@router.get("/api/lab/karte")
def api_get_lab_karte(today_mmdd: Optional[str] = None):
    """パーソナル撮影ラボ＆機材相性カルテ（歩留まりランキング・焦点距離/F値統計・太陽高度別枚数・時間帯分布）を取得する"""
    data = get_lab_karte_data(today_mmdd=today_mmdd)
    return _fast_json(data)


@router.get("/api/lab/random-unrated-folder")
def api_get_random_unrated_folder():
    """未整理（評価: 可）の写真が残っているフォルダをランダムに1つ抽選して返す（未整理フォルダ発掘ガチャ用）"""
    data = get_random_unrated_folder()
    return _fast_json(data)
