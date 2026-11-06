"""
AI 自動タグ付け機能 (CLIP INT8 Vision) APIルーター
"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database import (
    get_photo_by_id,
    get_thumbnail as db_get_thumbnail,
)
from ..scanner import ensure_thumbnail

logger = logging.getLogger("photo_manager.app")

router = APIRouter()


class AITagFolderRequest(BaseModel):
    folder_path: Optional[str] = None
    force_retag: bool = False
    color_only: bool = False
    photo_ids: Optional[List[int]] = None


class AITagColorBatchRequest(BaseModel):
    photo_ids: List[int]


class AIPromoteTagRequest(BaseModel):
    photo_id: int
    tag: str


class AIClearTagsRequest(BaseModel):
    photo_id: Optional[int] = None
    folder_path: Optional[str] = None


# ==============================================================================
# AI 自動タグ付け機能 (CLIP INT8 Vision)
# ==============================================================================

@router.get("/api/ai/status")
def api_ai_status():
    """AIモデルの状態および実行中ジョブの進捗を取得する"""
    from ..ai import get_ai_worker
    worker = get_ai_worker()
    return worker.get_status()


@router.post("/api/ai/tag-folder")
def api_ai_tag_folder(req: AITagFolderRequest):
    """指定フォルダ（または全未処理写真）のAI自動タグ付けジョブを開始する"""
    from ..ai import get_ai_worker
    worker = get_ai_worker()
    success = worker.start_tagging(
        folder_path=req.folder_path,
        photo_ids=req.photo_ids,
        force_retag=req.force_retag,
        color_only=req.color_only,
    )
    if not success:
        return {"status": "busy", "message": "他のAIタグ付けジョブが実行中です"}
    return {"status": "ok", "message": "AIタグ付けジョブを開始しました"}


@router.post("/api/ai/cancel")
def api_ai_cancel():
    """実行中のAIタグ付けジョブをキャンセルする"""
    from ..ai import get_ai_worker
    worker = get_ai_worker()
    worker.cancel()
    return {"status": "ok", "message": "キャンセルを要求しました"}


@router.post("/api/ai/tag-photo/{photo_id}")
def api_ai_tag_single_photo(photo_id: int, color_only: bool = False):
    """指定写真1枚に対して即座にAI推論を実行しタグを付与する"""
    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    # サムネイルBLOBを取得（未生成ならオンデマンド生成）
    thumb = db_get_thumbnail(photo_id)
    thumb_bytes = thumb["data"] if thumb else None
    if not thumb_bytes:
        try:
            thumb_bytes = ensure_thumbnail(photo["id"], photo["file_path"])
        except Exception as e:
            logger.warning(f"Could not generate thumbnail for AI tagging: {e}")

    if not thumb_bytes:
        raise HTTPException(status_code=500, detail="サムネイルの読み込みに失敗しました")

    from ..ai import get_ai_tagger
    from ..database import add_ai_tags_to_photo, replace_ai_color_tags_for_photo, get_photo_tags_details
    tagger = get_ai_tagger()
    if not tagger.load():
        raise HTTPException(status_code=503, detail="AIモデルを読み込めませんでした（既存のタグは変更していません）")
    matches = tagger.predict_from_bytes(thumb_bytes, top_k=3, color_only=color_only)
    if color_only:
        replace_ai_color_tags_for_photo(photo_id, matches)
    elif matches:
        add_ai_tags_to_photo(photo_id, matches)

    updated_tags = get_photo_tags_details(photo_id)
    return {"status": "ok", "photo_id": photo_id, "predicted": matches, "tags": updated_tags}


@router.post("/api/ai/tag-color-photos")
def api_ai_tag_color_photos(req: AITagColorBatchRequest):
    """選択中の複数写真に対してAIカラータグ（12色）のみを再判定する"""
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="対象の写真が指定されていません")

    # 32枚を超える大量選択時はバックグラウンドワーカーで処理
    if len(req.photo_ids) > 32:
        from ..ai import get_ai_worker
        worker = get_ai_worker()
        success = worker.start_tagging(
            photo_ids=req.photo_ids,
            force_retag=True,
            color_only=True,
        )
        if not success:
            return {"status": "busy", "message": "他のAIタグ付けジョブが実行中です"}
        return {"status": "background", "total": len(req.photo_ids)}

    from ..ai import get_ai_tagger
    from ..database import replace_ai_color_tags_for_photo, get_photo_tags_details
    tagger = get_ai_tagger()
    if not tagger.load():
        raise HTTPException(status_code=503, detail="AIモデルを読み込めませんでした（既存のタグは変更していません）")
    results: Dict[int, List[Dict[str, Any]]] = {}
    predicted_colors: Dict[int, List[str]] = {}
    tagged_count = 0

    for pid in req.photo_ids:
        photo = get_photo_by_id(pid)
        if not photo:
            continue
        thumb = db_get_thumbnail(pid)
        thumb_bytes = thumb["data"] if thumb else None
        if not thumb_bytes:
            try:
                thumb_bytes = ensure_thumbnail(photo["id"], photo["file_path"])
            except Exception as e:
                logger.warning(f"Could not generate thumbnail for AI color tagging ({pid}): {e}")
        if not thumb_bytes:
            continue

        matches = tagger.predict_from_bytes(thumb_bytes, top_k=3, color_only=True)
        replace_ai_color_tags_for_photo(pid, matches)
        if matches:
            tagged_count += 1
            predicted_colors[pid] = [m["tag"] for m in matches]
        results[pid] = get_photo_tags_details(pid)

    return {
        "status": "ok",
        "tagged_count": tagged_count,
        "total": len(req.photo_ids),
        "predicted_colors": predicted_colors,
        "results": results,
    }


@router.post("/api/ai/promote-tag")
def api_ai_promote_tag(req: AIPromoteTagRequest):
    """AIタグを手動タグに昇格（確定）する"""
    from ..database import promote_ai_tag
    success = promote_ai_tag(req.photo_id, req.tag)
    return {"status": "ok", "photo_id": req.photo_id, "tag": req.tag, "success": success}


@router.delete("/api/ai/tags")
def api_ai_clear_tags(photo_id: Optional[int] = None, folder_path: Optional[str] = None):
    """AIタグのみを一括削除する（手動タグは保護）"""
    from ..database import remove_ai_tags
    deleted_count = remove_ai_tags(photo_id=photo_id, folder_path=folder_path)
    return {"status": "ok", "deleted_count": deleted_count}
