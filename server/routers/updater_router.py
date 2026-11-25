"""
PC母艦ソフトウェア更新・ポータブル差分パッケージ配信 APIルーター（localhost専用）
"""

from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from ..updater import (
    _MAX_DIFF_ZIP_BYTES,
    build_portable_diff_update_zip,
    download_and_stage_github_diff_zip,
    get_system_update_status,
    stage_uploaded_diff_zip,
    trigger_launcher_clean_update,
)
from .common import _require_localhost

router = APIRouter()


class GithubDownloadRequest(BaseModel):
    download_url: Optional[str] = None


@router.get("/api/system/update-status")
def api_system_update_status(
    request: Request,
    check_remote: int = Query(default=0),
    force_remote: int = Query(default=0),
):
    """現在バージョン・リビジョン・ステージ済み更新・GitHub最新リリース情報を返す（localhost専用）"""
    _require_localhost(request)
    return get_system_update_status(check_remote=bool(check_remote), force_remote=bool(force_remote))


@router.post("/api/system/download-github-update")
def api_system_download_github_update(
    request: Request,
    payload: Optional[GithubDownloadRequest] = Body(default=None),
):
    """GitHub Releases から最新 diff.zip をダウンロードしてルートへステージングする（localhost専用）"""
    _require_localhost(request)
    url = payload.download_url if payload and payload.download_url else ""
    res = download_and_stage_github_diff_zip(download_url=url)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "ダウンロードに失敗しました")
    return res


@router.get("/api/system/export-diff-zip")
def api_system_export_diff_zip(request: Request):
    """現在稼働中の母艦から個人データを除いたポータブル差分ZIP (Tetheract_v*diff.zip) を生成・配信する（localhost専用）"""
    _require_localhost(request)
    out_zip, meta = build_portable_diff_update_zip()
    if not out_zip or not out_zip.is_file():
        raise HTTPException(status_code=500, detail="差分パッケージの生成に失敗しました")
    return FileResponse(
        out_zip,
        media_type="application/zip",
        filename=meta["file_name"],
        headers={
            "Content-Disposition": f'attachment; filename="{meta["file_name"]}"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
    )


@router.post("/api/system/stage-diff-zip")
async def api_system_stage_diff_zip(
    request: Request,
    file_name: str = Query(default="Tetheract_diff.zip"),
):
    """選択された diff.zip バイナリを検証し、アプリルートへステージングする（localhost専用）"""
    _require_localhost(request)
    chunks = []
    total_bytes = 0
    async for chunk in request.stream():
        total_bytes += len(chunk)
        if total_bytes > _MAX_DIFF_ZIP_BYTES:
            raise HTTPException(status_code=413, detail="diff.zip のサイズが上限 (250MB) を超えています")
        chunks.append(chunk)
    raw_bytes = b"".join(chunks)
    res = await run_in_threadpool(stage_uploaded_diff_zip, file_name=file_name, raw_bytes=raw_bytes)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error") or "diff.zip の読み込みに失敗しました")
    return res


@router.post("/api/system/trigger-clean-update")
def api_system_trigger_clean_update(request: Request):
    """ステージ済み diff.zip を適用するため Tetheract.exe を起動する（localhost専用）"""
    _require_localhost(request)
    res = trigger_launcher_clean_update()
    if not res.get("ok"):
        status = 403 if res.get("reason") == "dev_repo_protected" else 400
        raise HTTPException(status_code=status, detail=res.get("error") or "クリーンアップデートの起動に失敗しました")
    return res
