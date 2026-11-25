"""
FastAPI バックエンドメインアプリケーション
写真のインデックス、メタデータ配信、高速サムネイル提供、4段階評価（棄/可/良/優）管理を行う。
"""

import base64
import concurrent.futures
import hashlib
import json
import logging
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .database import (
    initialize_database,
    get_photos,
    get_photo_by_id,
    get_photo_brief,
    get_photos_brief_batch,
    update_rating,
    upsert_photo,
    get_timeline_summary,
    get_calendar_summary,
    get_folders_summary,
    get_scan_roots_summary,
    get_cameras_summary,
    remove_folder_photos,
    add_ignored_folder,
    remove_ignored_folder,
    get_ignored_folders,
    add_tag_to_photo,
    remove_tag_from_photo,
    get_all_tags_summary,
    get_untagged_count,
    get_total_photos_count,
    delete_tag,
    rename_tag,
    resolve_tag_by_key_or_name,
    update_tag_metadata,
    batch_add_tag,
    batch_remove_tag,
    batch_update_rating,
    recalculate_stacks,
    set_stack_primary,
    cleanup_missing_photos_in_folder,
    get_missing_photos,
    get_missing_photos_count,
    unlink_missing_photos_in_folder,
    get_unlinked_photos_count,
    get_connection_counts,
    purge_unlinked_photos,
    get_duplicate_photos_count,
    get_thumbnail as db_get_thumbnail,
    get_thumbnails_batch,
    save_thumbnail,
    update_photo_adjustments,
    batch_update_photo_tone,
    batch_shift_photo_dates,
    add_scan_root,
    rotate_photo,
    reset_photo_adjustments,
    batch_reset_photo_adjustments,
    batch_rotate_photos,
    cleanup_invalid_zero_gps,
    backfill_missing_lens_models,
    cleanup_missing_upload_photos,
    delete_photo_by_id,
    delete_photos_by_ids,
    get_database_stats,
    vacuum_database,
    backup_database,
    get_backup_info,
    open_backup_directory,
    get_filter_presets,
    get_filter_preset,
    create_filter_preset,
    update_filter_preset,
    delete_filter_preset,
    get_startup_status,
    set_startup_status,
    get_db_commit_seq,
    invalidate_fast_cache,
    close_thread_connection,
)
from .database.connection import get_connection, get_links_seq, get_photos_seq, get_tags_seq
from .scanner import (
    scan_directory,
    scan_tracker,
    ensure_thumbnail,
    render_thumbnail_webp,
    apply_photo_adjustments_pil,
    compute_thumbnail_hash,
    extract_metadata,
    resolve_portable_path,
    resolve_drive_online_path,
    clear_online_cache,
    is_raw_file,
    extract_raw_full_preview,
    check_folder_diff,
    refresh_photo_thumbnail_transform,
    _safe_exists,
    SUPPORTED_EXTENSIONS,
)
from .shell_thumbnail import is_cloud_or_ondemand_path
from .database.folders import (
    clear_folders_fs_cache,
    _PHOTO_DIR_SCAN_CACHE,
    _PHOTO_DIR_SCAN_TTL,
)
from .storage_manager import (
    ensure_storage_dir,
    migrate_carry_to_storage,
    is_path_in_storage,
    is_photo_in_storage,
    resolve_storage_target_with_root,
    invalidate_loome_roots_cache,
    get_storage_task_status,
)
from .heartbeat import (
    record_heartbeat,
    request_shutdown,
)
from .folder_tree import (
    build_roots as build_folder_tree_roots,
    list_children as list_folder_tree_children,
)

from .media_watcher import (
    start_media_watcher,
    check_media_changes,
    get_media_watcher_state,
    subscribe_media_events,
    unsubscribe_media_events,
    broadcast_app_event,
)
from .version import get_version_info, __version__
from .mobile_bundle import ensure_standalone_mobile_html
from .sidecar import (
    is_sidecar_file,
    parse_xmp_for_photo,
)
from .lan_access import (
    LAN_TOKEN_COOKIE,
    build_lan_cookie_header,
    extract_explicit_lan_token,
    is_host_header_allowed,
    is_lan_path_allowed,
    is_lan_public_discovery_path,
    is_lan_token_valid,
    is_loopback_client,
    resolve_request_client_host,
    touch_lan_activity,
)
from .security import (
    get_current_security_level,
    get_logical_file_size,
    get_security_status,
    is_app_locked,
    is_vault_encrypted_file,
    read_loome_file_decrypted_bytes,
    seal_loome_file,
)
from .routers.common import (
    BASE_DIR,
    FRONTEND_DIR,
    IMPORT_DIR,
    UPLOAD_DIR,
    _API_PHOTOS_RESPONSE_CACHE,
    _fast_json,
    _mobile_sync_event,
    _require_localhost,
    clear_api_photos_cache,
)

logger = logging.getLogger("photo_manager.app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """起動時にDBを最速初期化して即座にHTTP待受を開始し、ストレージ整合性確認・モバイルHTML生成はバックグラウンドで実行する"""
    set_startup_status(is_ready=False, phase="init", message="データベースを初期化中...", detail="キャッシュとスキーマを確認しています", percent=10)
    initialize_database(fast_boot=True)
    start_media_watcher()
    set_startup_status(is_ready=True, phase="ready", message="準備完了", detail="", percent=100)

    # ウィンドウ表示・初期描画完了後のバックグラウンド保守（Loome整合性・モバイルHTML・スキーマ保守・レンズ補完）
    def _bg_post_unlock_maintenance():
        import time as _t
        from .database import get_connection, migrate_and_merge_exifless_photos
        from .database.schema import run_background_schema_maintenance
        _t.sleep(3.5)
        try:
            try:
                ensure_standalone_mobile_html()
            except Exception as mob_err:
                logger.debug(f"[PostUnlock] モバイルHTML生成スキップ: {mob_err}")

            while is_app_locked():
                _t.sleep(2.0)

            try:
                migrate_carry_to_storage()
                active_loome = ensure_storage_dir()
                cleanup_missing_upload_photos(active_loome)
                cleanup_invalid_zero_gps()
                run_background_schema_maintenance()
            except Exception as clean_err:
                logger.warning(f"[PostUnlock] 起動時クリーンアップスキップ: {clean_err}")

            # 保留されていた大規模DB向けの exifless_content_hash_v1 マイグレーションがあればバックグラウンドで実行
            try:
                with get_connection() as conn:
                    cur = conn.cursor()
                    cur.execute("SELECT 1 FROM migrations WHERE name = 'exifless_content_hash_v1'")
                    need_exifless = cur.fetchone() is None
                if need_exifless:
                    exifless_res = migrate_and_merge_exifless_photos()
                    set_startup_status(exifless_migration=exifless_res)
                    with get_connection() as conn:
                        conn.execute("INSERT OR IGNORE INTO migrations (name) VALUES ('exifless_content_hash_v1')")
                        conn.commit()
                    if exifless_res.get("updated", 0) > 0 or exifless_res.get("merged", 0) > 0:
                        logger.info(
                            f"[MIGRATE] exifless_content_hash_v1 (BG): "
                            f"Exifなし画像 {exifless_res.get('updated', 0)} 枚の識別キーを更新し、"
                            f"重複 {exifless_res.get('merged', 0)} 件を統合しました"
                        )
            except Exception as ex_err:
                logger.warning(f"[MIGRATE] バックグラウンドExifなし画像移行スキップ: {ex_err}")

            # 初回のみオンラインのローカルフォルダから has_xmp カラムを非ブロッキングでバックフィル
            try:
                from .database.photos import backfill_online_local_has_xmp_once
                with get_connection() as conn:
                    need_xmp_bf = conn.execute(
                        "SELECT 1 FROM migrations WHERE name = 'backfill_has_xmp_v1'"
                    ).fetchone() is None
                if need_xmp_bf:
                    xmp_cnt = backfill_online_local_has_xmp_once()
                    with get_connection() as conn:
                        conn.execute("INSERT OR IGNORE INTO migrations (name) VALUES ('backfill_has_xmp_v1')")
                        conn.commit()
                    if xmp_cnt > 0:
                        logger.info(f"[Backfill] 既存写真の XMP サイドカー有無を {xmp_cnt} 件同期しました")
            except Exception as xmp_bf_err:
                logger.warning(f"[Backfill] 初回 has_xmp バックフィルスキップ: {xmp_bf_err}")

            _t.sleep(10.0)
            while is_app_locked():
                _t.sleep(3.0)
            with get_connection() as conn:
                need_lens_v2 = conn.execute(
                    "SELECT 1 FROM migrations WHERE name = 'lens_sentinel_backfill_v2'"
                ).fetchone() is None
            if not need_lens_v2:
                return
            cnt = backfill_missing_lens_models(only_interchangeable_cameras=False)
            with get_connection() as conn:
                conn.execute("INSERT OR IGNORE INTO migrations (name) VALUES ('lens_sentinel_backfill_v2')")
                conn.commit()
            if cnt > 0:
                logger.info(f"[Backfill] 既存写真のレンズ機種名を {cnt} 件自動補完しました")
                clear_folders_fs_cache()
                broadcast_app_event("lenses_backfilled", {"updated": cnt})
            marker_file = BASE_DIR / "cache" / ".lens_backfill_done_v1"
            marker_file.parent.mkdir(parents=True, exist_ok=True)
            marker_file.write_text("done", encoding="utf-8")
        except Exception as e:
            logger.warning(f"[Backfill] バックグラウンド保守スキップ: {e}")

    def _bg_mobile_delta_watcher():
        import time as _t
        from .lan_access import ensure_lan_listeners, is_lan_device_paired
        from .mobile_delta import ensure_mobile_delta_db
        from .routers.mobile_case_router import is_case_upload_active
        _t.sleep(2.0)
        try:
            if not is_app_locked() and is_lan_device_paired():
                ensure_lan_listeners(app, port=8088)
        except Exception as e:
            logger.debug(f"[MobileDelta] 初回LANリスナー起動スキップ: {e}")
        _t.sleep(8.0)
        last_lan_check = 0.0
        last_delta_build = 0.0
        observed_seq = get_db_commit_seq()
        seq_changed_at = _t.time()
        while True:
            try:
                if not is_app_locked():
                    now_ts = _t.time()
                    cur_seq = get_db_commit_seq()
                    if cur_seq != observed_seq:
                        observed_seq = cur_seq
                        seq_changed_at = now_ts
                    paired = is_lan_device_paired()
                    if paired and (now_ts - last_lan_check >= 20.0):
                        ensure_lan_listeners(app, port=8088)
                        last_lan_check = now_ts
                    # 未ペアリング時は差分DB生成を完全休止し、ペアリング中も編集操作が15秒以上落ち着いたタイミングで更新する
                    if (
                        paired
                        and not scan_tracker.is_scanning
                        and not is_case_upload_active()
                        and (last_delta_build == 0.0 or ((now_ts - seq_changed_at >= 15.0) and (now_ts - last_delta_build >= 45.0)))
                    ):
                        ensure_mobile_delta_db(force=False)
                        last_delta_build = _t.time()
            except Exception as d_err:
                logger.debug(f"[MobileDelta] 定期チェック警告: {d_err}")
            _t.sleep(4.0)

    threading.Thread(target=_bg_post_unlock_maintenance, daemon=True).start()
    threading.Thread(target=_bg_mobile_delta_watcher, daemon=True).start()
    yield
    try:
        from .lan_access import is_lan_device_paired
        from .mobile_delta import ensure_mobile_delta_db
        if not is_app_locked() and is_lan_device_paired():
            ensure_mobile_delta_db(force=False)
    except Exception as e:
        logger.debug(f"[MobileDelta] 終了時更新スキップ: {e}")


# アプリ初期化
app = FastAPI(title="Tetheract Photo Manager", version=__version__, lifespan=lifespan)

# ループバック（PC自身）オリジン判定用正規表現
# ※ プライベートLANのIPを一括許可すると、LAN上の他ホスト（ルーター・他PC等）のページから
#   127.0.0.1 宛ての破壊系APIを呼べてしまうため、LANオリジンは「同一オリジン（Origin = Host）」のみ許可する
_ALLOWED_ORIGIN_RE = re.compile(
    r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$",
    re.IGNORECASE,
)

# 単体モバイルHTML (file:// や content:// 由来の Origin: null) からアクセスを許可するAPIパス
# ※ Drive-by Localhost / PNA 越境攻撃を防ぐため、トークン必須の差分反映API1本のみに限定する
_NULL_ORIGIN_ALLOWED_PATHS = {
    "/api/mobile/sync-import",
}

def _is_origin_allowed(origin: Optional[str], path: str, host: Optional[str] = None) -> bool:
    """
    クロスオリジンリクエストのOriginヘッダを検証し、外部悪意サイトからのCSRF/Localhost攻撃を遮断する。
    許可するのは「ループバックのオリジン」と「同一オリジン（スマホ画面が PC の LAN IP から配信された場合など）」のみ。
    """
    if not origin:
        return True
    if origin == "null":
        return path in _NULL_ORIGIN_ALLOWED_PATHS
    if _ALLOWED_ORIGIN_RE.match(origin):
        return True
    origin_netloc = origin.split("://", 1)[-1].rstrip("/").lower()
    return bool(host) and origin_netloc == host.strip().lower()


def _is_lan_request_allowed(client_host: str, method: str, path: str) -> bool:
    """LAN経由（スマホ等）のリクエストはホワイトリスト（スマホ画面の閲覧・評価・タグ付け）のみ許可する"""
    if is_loopback_client(client_host):
        return True
    return is_lan_path_allowed(method, path)


def _json_error(status_code: int, detail: str) -> Response:
    """ミドルウェアから返すJSONエラーレスポンスを生成する"""
    return Response(
        content=json.dumps({"detail": detail}),
        status_code=status_code,
        media_type="application/json",
    )


@app.middleware("http")
async def add_no_cache_header(request: Request, call_next):
    """
    1. Host ヘッダ検証による DNS Rebinding 攻撃の遮断
    2. 外部Webサイトおよび sandbox iframe (Origin: null + PNA) からの Drive-by Localhost 攻撃を遮断
    3. LAN経由アクセスは有効なトークン認証＋ホワイトリストのAPIのみ許可（無認証Cookie交付禁止）
    4. 静的ファイル変更の即時反映ヘッダを付与
    """
    path = request.url.path
    origin = request.headers.get("origin")
    is_null_origin = origin == "null"
    client_host = resolve_request_client_host(request)

    if not is_host_header_allowed(request.headers.get("host")):
        return _json_error(400, "Invalid Host header")

    if not _is_origin_allowed(origin, path, request.headers.get("host")):
        return _json_error(403, "Forbidden origin")

    explicit_token = extract_explicit_lan_token(request)
    if is_null_origin:
        # Origin: null はループバック発であっても無認証特権を与えず、明示提示された LAN_TOKEN を必須とする
        if not is_lan_token_valid(None, explicit_token):
            return _json_error(403, "Valid LAN token required for null origin")

    set_lan_cookie = False
    if not is_loopback_client(client_host):
        if not _is_lan_request_allowed(client_host, request.method, path):
            return _json_error(403, "This operation is restricted to localhost only")
        cookie_token = request.cookies.get(LAN_TOKEN_COOKIE)
        if not is_lan_public_discovery_path(path):
            if not is_lan_token_valid(cookie_token, explicit_token):
                return _json_error(401, "LAN access token required. Please scan the QR code on the PC again.")
            touch_lan_activity()
            # 有効な LAN_TOKEN をクエリ(?t=)等で明示提示して検証通過した場合のみ Cookie を交付する
            if (
                not is_null_origin
                and is_lan_token_valid(None, explicit_token)
                and not is_lan_token_valid(cookie_token, None)
            ):
                set_lan_cookie = True

    cors_origin = origin if origin else "http://127.0.0.1:8088"

    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": cors_origin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*, Authorization, X-Tetheract-Lan-Token",
            "Vary": "Origin",
        }
        if not is_null_origin and request.headers.get("access-control-request-private-network") == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        return Response(status_code=204, headers=headers)

    if path.startswith("/api/") and not (
        path.startswith("/api/security/")
        or path in ("/api/startup/status", "/api/version", "/api/heartbeat", "/api/shutdown", "/api/media/events")
        or path.startswith("/api/window/")
    ):
        if is_app_locked():
            sec_st = get_security_status()
            return Response(
                content=json.dumps(
                    {
                        "detail": "アプリケーションはロックされています。ロックを解除してください。",
                        "is_locked": True,
                        "security_level": sec_st.get("security_level", 0),
                        "db_foreign_locked": sec_st.get("db_foreign_locked", False),
                    },
                    ensure_ascii=False,
                ),
                status_code=423,
                media_type="application/json",
            )

    response = await call_next(request)
    if set_lan_cookie:
        response.headers.append("set-cookie", build_lan_cookie_header())
    if origin:
        response.headers["Access-Control-Allow-Origin"] = cors_origin
        response.headers["Vary"] = "Origin"
    if not is_null_origin and request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    if path.endswith(".js") or path.endswith(".css") or path.endswith(".html") or path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    elif path.startswith("/api/") and "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response


# リクエストモデル
class ScanRequest(BaseModel):
    folder_path: str
    cleanup_orphans: bool = False
    recursive: bool = True
    auto_ai_tag: bool = False
    volume_serial: Optional[str] = None
    diff_only: bool = False


class DeleteFolderRequest(BaseModel):
    folder_path: str
    recursive: bool = True
    volume_serial: Optional[str] = None


class RotateRequest(BaseModel):
    delta: int = 90


class BatchRotateRequest(BaseModel):
    photo_ids: List[int]
    delta: int = 90


class BatchResetAdjustRequest(BaseModel):
    photo_ids: List[int]


class BatchToneAdjustRequest(BaseModel):
    photo_ids: List[int]
    brightness: int = 0
    contrast: int = 0
    saturation: int = 0


class BatchDateShiftRequest(BaseModel):
    photo_ids: List[int]
    offset_seconds: int = 0
    reset: bool = False


class AdjustRequest(BaseModel):
    rotation: int = 0
    fine_angle: float = 0.0
    crop_x: Optional[float] = None
    crop_y: Optional[float] = None
    crop_w: Optional[float] = None
    crop_h: Optional[float] = None
    crop_aspect: Optional[str] = None
    brightness: int = 0
    contrast: int = 0
    saturation: int = 0


class MobileAdjustmentsRequest(BaseModel):
    rotation: Optional[int] = None
    fine_angle: Optional[float] = None
    brightness: Optional[int] = None
    contrast: Optional[int] = None
    saturation: Optional[int] = None


class RateRequest(BaseModel):
    rating: int


class RefreshThumbnailsRequest(BaseModel):
    photo_ids: List[int]
    force: bool = True



class TagRequest(BaseModel):
    tag: str
    tag_key: Optional[str] = None
    short_name: Optional[str] = None
    is_pinned: Optional[bool] = None


class UpdateTagMetaRequest(BaseModel):
    tag: Optional[str] = None
    tag_key: Optional[str] = None
    short_name: Optional[str] = None
    is_pinned: Optional[bool] = None


class WindowSettingsRequest(BaseModel):
    startup_mode: str
    apply_now: bool = True


def _lookup_paired_volume_serial(paired_path_str: Optional[str], fallback_vsn: Optional[str] = None) -> Optional[str]:
    """ペア相手ファイルのパスから photo_links / photos の volume_serial を取得する（別ドライブペア対応）"""
    if not paired_path_str:
        return fallback_vsn
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT volume_serial FROM photo_links WHERE file_path = ? COLLATE NOCASE LIMIT 1",
                (paired_path_str,),
            )
            row = cur.fetchone()
            if not row:
                cur.execute(
                    "SELECT volume_serial FROM photos WHERE file_path = ? COLLATE NOCASE LIMIT 1",
                    (paired_path_str,),
                )
                row = cur.fetchone()
            if row:
                vsn = (row[0] or "").strip() if not hasattr(row, "keys") else (row["volume_serial"] or "").strip()
                return vsn or None
    except Exception as e:
        logger.debug(f"ペア相手のボリュームシリアル取得スキップ ({paired_path_str}): {e}")
    return fallback_vsn


def _resolve_paired_raw_path(photo: Dict[str, Any]) -> Optional[str]:
    """ペアRAWパスをポータブル解決し（ドライブレター変動・VSN対応）、XMP探索に渡せる文字列を返す"""
    raw_path_str = photo.get("paired_raw_path")
    if not raw_path_str:
        return None
    pair_vsn = _lookup_paired_volume_serial(raw_path_str, photo.get("volume_serial"))
    resolved, _ = resolve_portable_path(raw_path_str, expected_serial=pair_vsn)
    return str(resolved)


@app.post("/api/heartbeat")
def api_heartbeat():
    """ブラウザからの生存確認を受け取り、スマホからのWi-Fi同期イベント連番を返す"""
    record_heartbeat()
    return {
        "status": "ok",
        "mobile_sync_seq": _mobile_sync_event["seq"],
        "mobile_sync_applied": _mobile_sync_event["applied_count"],
        "media_event_seq": get_media_watcher_state()["seq"],
        "media_last_event": get_media_watcher_state()["last_event"],
    }


@app.post("/api/media/check")
def api_media_check():
    """ウィンドウフォーカス復帰時や手動確認時にドライブ接続状態の差分をチェックする（localhost専用）"""
    return _fast_json(check_media_changes(source="window_focus"))


@app.get("/api/media/events")
async def api_media_events(request: Request):
    """
    Windows OS の WM_DEVICECHANGE イベント等で検知したメディア抜き挿しを
    Server-Sent Events (SSE) でフロントエンドへ即時プッシュ配信する（localhost専用）。
    """
    import asyncio as _asyncio

    async def _event_generator():
        sub = subscribe_media_events()
        _, q = sub
        try:
            init_state = get_media_watcher_state()
            init_json = json.dumps({"type": "init", **init_state}, ensure_ascii=False, default=str)
            yield f"data: {init_json}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    evt = await _asyncio.wait_for(q.get(), timeout=20.0)
                    evt_json = json.dumps({"type": "change", **evt}, ensure_ascii=False, default=str)
                    yield f"data: {evt_json}\n\n"
                except _asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except _asyncio.CancelledError:
            pass
        finally:
            unsubscribe_media_events(sub)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/window/settings")
def api_get_window_settings():
    """起動時ウィンドウモードの設定値を取得する"""
    from .window_utils import get_startup_window_mode

    return {"status": "ok", "startup_mode": get_startup_window_mode()}


@app.post("/api/window/settings")
def api_set_window_settings(req: WindowSettingsRequest):
    """起動時ウィンドウモードを保存し、必要に応じて現在のウィンドウへ即座に適用する"""
    from .window_utils import apply_window_mode, set_startup_window_mode

    saved_mode = set_startup_window_mode(req.startup_mode)
    applied_count = 0
    if req.apply_now:
        applied_count = apply_window_mode(mode=saved_mode, port=8088)
    return {
        "status": "ok",
        "startup_mode": saved_mode,
        "applied_count": applied_count,
    }


@app.post("/api/window/maximize")
def api_window_maximize():
    """フロントエンド起動完了時に設定されたウィンドウモード（既定は最大化）を適用する"""
    from .window_utils import get_startup_window_mode, maximize_photo_manager_window

    mode = get_startup_window_mode()
    count = maximize_photo_manager_window(port=8088)
    return {"status": "ok", "startup_mode": mode, "maximized_count": count}


@app.post("/api/shutdown")
def api_shutdown():
    """サーバーを手動でシャットダウンする"""
    request_shutdown("API経由のシャットダウン要求")
    return {"status": "shutting_down"}


@app.get("/api/startup/status")
def api_startup_status():
    """起動時・DBマイグレーションの進捗状態を返す"""
    return get_startup_status()


@app.get("/api/storage/status")
def api_storage_task_status():
    """現在実行中の storage ファイル操作（インポート・移動・リネーム・エクスポート）の進捗状態を返す"""
    return get_storage_task_status()


@app.get("/api/photos/missing")
def api_get_missing_photos():
    """実ファイルが削除・移動されて見つからない写真一覧を取得する"""
    photos = get_missing_photos()
    for p in photos:
        p["is_storage"] = is_photo_in_storage(p)
    return _fast_json({"photos": photos, "count": len(photos)})


@app.get("/api/photos/missing-count")
def api_get_missing_photos_count():
    """実ファイルが見つからない写真の件数を取得する"""
    count = get_missing_photos_count()
    return {"count": count}


@app.get("/api/photos/unlinked-count")
def api_get_unlinked_photos_count():
    """実体パスとの紐付けが外れた（リンク消失）写真の件数を取得する"""
    counts = get_connection_counts()
    if isinstance(counts, dict):
        return {"count": counts["unlinked_count"], **counts}
    count = get_unlinked_photos_count()
    return {"count": count}


@app.get("/api/photos/duplicates-count")
def api_get_duplicates_count():
    """ライブラリ全体で他フォルダに重複（同一撮影日時＋サイズ）が存在する写真の件数を取得する"""
    count = get_duplicate_photos_count()
    return {"count": count}


class CheckExternalUpdatesRequest(BaseModel):
    photo_ids: Optional[List[int]] = None
    folders: Optional[List[str]] = None


def _check_external_updates_sync(req: CheckExternalUpdatesRequest) -> Dict[str, Any]:
    """外部編集・XMPサイドカー変化をワーカースレッド上で検査し、実変更があった場合のみ該当キャッシュを更新する"""
    updated_photo_ids: List[int] = []
    checked_photos: List[Dict[str, Any]] = []
    xmp_changed_dirs: set = set()
    changed_dirs: set = set()

    if req.photo_ids:
        from .database.connection import bump_photos_seq, get_connection
        from .database.photos import _has_xmp_sidecar_fast, _strip_vsn_prefix_raw

        unique_ids = [int(x) for x in dict.fromkeys(req.photo_ids) if isinstance(x, int) or (isinstance(x, str) and str(x).isdigit())][:200]
        if unique_ids:
            placeholders = ",".join("?" for _ in unique_ids)
            changed_rows: List[Tuple[int, str, float, int]] = []
            xmp_db_updates: List[Tuple[int, int]] = []
            with get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    f"""
                    SELECT id, file_path, directory_path, paired_raw_path, volume_serial, file_mtime, file_size,
                           COALESCE(has_xmp, 0) AS has_xmp
                    FROM photos
                    WHERE id IN ({placeholders})
                    """,
                    unique_ids,
                )
                rows = cursor.fetchall()

                for row in rows:
                    pid = int(row["id"])
                    fpath = _strip_vsn_prefix_raw(row["file_path"]) or ""
                    dpath = row["directory_path"]
                    paired_raw = row["paired_raw_path"]
                    v_ser = row["volume_serial"]
                    old_mtime = float(row["file_mtime"] or 0.0)
                    old_size = int(row["file_size"] or 0)
                    old_has_xmp = bool(row["has_xmp"])
                    cur_mtime = old_mtime
                    is_file_online = False

                    if fpath:
                        real_p, is_online = resolve_portable_path(fpath, expected_serial=v_ser)
                        if is_online and real_p.exists():
                            is_file_online = True
                            try:
                                st = real_p.stat()
                                cur_mtime = float(st.st_mtime)
                                cur_size = int(get_logical_file_size(real_p))
                                if abs(cur_mtime - old_mtime) > 0.5 or cur_size != old_size:
                                    changed_rows.append((pid, fpath, cur_mtime, cur_size))
                                    if dpath:
                                        changed_dirs.add((dpath, v_ser or None))
                            except Exception as e:
                                logger.debug(f"外部更新チェック stat 失敗 ({real_p}): {e}")

                    has_xmp = (
                        _has_xmp_sidecar_fast(fpath, paired_raw, volume_serial=v_ser)
                        if is_file_online
                        else old_has_xmp
                    )
                    if has_xmp != old_has_xmp:
                        xmp_db_updates.append((1 if has_xmp else 0, pid))
                        if dpath:
                            xmp_changed_dirs.add((dpath, v_ser or None))

                    checked_photos.append({
                        "id": pid,
                        "file_mtime": cur_mtime,
                        "has_xmp": has_xmp,
                    })

                if changed_rows or xmp_db_updates:
                    for pid, fpath, new_mtime, new_size in changed_rows:
                        cursor.execute(
                            "UPDATE photos SET file_mtime = ?, file_size = ? WHERE id = ?",
                            (new_mtime, new_size, pid),
                        )
                        cursor.execute(
                            "UPDATE photo_links SET file_mtime = ? WHERE photo_id = ? AND file_path = ?",
                            (new_mtime, pid, fpath),
                        )
                    if xmp_db_updates:
                        cursor.executemany(
                            "UPDATE photos SET has_xmp = ? WHERE id = ?",
                            xmp_db_updates,
                        )
                    conn.commit()

            for pid, _, _, _ in changed_rows:
                try:
                    refresh_photo_thumbnail_transform(pid)
                except Exception as e:
                    logger.warning(f"外部編集検知後のサムネイル再生成失敗 (id={pid}): {e}")
                updated_photo_ids.append(pid)

            for dk in (changed_dirs | xmp_changed_dirs):
                _PHOTO_DIR_SCAN_CACHE.pop(dk, None)
            if xmp_db_updates:
                bump_photos_seq()
            if updated_photo_ids or xmp_changed_dirs or xmp_db_updates:
                clear_api_photos_cache()

    return {
        "ok": True,
        "updated_photo_ids": updated_photo_ids,
        "photos": checked_photos,
    }


@app.post("/api/photos/check-external-updates")
async def api_check_external_updates(request: Request):
    """
    ウィンドウフォーカス復帰時等に外部アプリでの編集・削除・XMP追加を検知し、
    実際に変化があった写真のみサムネイル再生成と該当キャッシュ更新を行う（localhost専用・非ブロッキング）。
    """
    _require_localhost(request)

    req = CheckExternalUpdatesRequest()
    try:
        body_bytes = await request.body()
        if body_bytes:
            body_data = json.loads(body_bytes.decode("utf-8"))
            if isinstance(body_data, dict):
                req = CheckExternalUpdatesRequest(**body_data)
    except Exception as e:
        logger.debug(f"check-external-updates リクエストボディ解析スキップ: {e}")

    return await run_in_threadpool(_check_external_updates_sync, req)


@app.get("/api/photos")
def api_get_photos(
    folder: Optional[str] = None,
    volume_serial: Optional[str] = None,
    serial_mode: Optional[str] = None,
    year_month: Optional[str] = None,
    year_months: Optional[str] = None,
    dates: Optional[str] = None,
    cameras: Optional[str] = None,
    exclude_cameras: Optional[str] = None,
    excluded_cameras: Optional[str] = None,
    lenses: Optional[str] = None,
    exclude_lenses: Optional[str] = None,
    excluded_lenses: Optional[str] = None,
    ratings: Optional[str] = None,
    search: Optional[str] = None,
    include_tags: Optional[str] = None,
    exclude_tags: Optional[str] = None,
    untagged: bool = False,
    sort_by: str = "date_taken DESC",
    stacked: bool = True,
    exclude_folder: Optional[str] = None,
    missing_only: bool = False,
    unlinked_only: bool = False,
    include_unlinked: bool = False,
    duplicates_only: bool = False,
    country: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    no_location: bool = False,
    lab_filter: Optional[str] = None,
    on_this_day: Optional[str] = None,
    focal_range: Optional[str] = None,
    aperture_range: Optional[str] = None,
    attr_filter: Optional[str] = None,
    tag_and_roots: Optional[str] = None,
    tag_group_op: str = "and",
    limit: int = 0,
    offset: int = 0,
):
    """写真一覧を取得する（DB直読定数時間アーキテクチャ・ページネーション・VSNメディア識別対応）"""
    if missing_only:
        photos = get_missing_photos()
        for p in photos:
            p["is_storage"] = is_photo_in_storage(p)
        return _fast_json({"photos": photos, "count": len(photos)})

    now_req_ts = time.monotonic()
    resp_cache_key = (
        get_photos_seq(),
        get_tags_seq(),
        get_links_seq(),
        folder, volume_serial, serial_mode, year_month, year_months, dates,
        cameras, exclude_cameras, excluded_cameras, lenses, exclude_lenses, excluded_lenses,
        ratings, search, include_tags, exclude_tags, untagged, sort_by, stacked,
        exclude_folder, unlinked_only, include_unlinked, duplicates_only,
        country, state, city, no_location, lab_filter, on_this_day,
        focal_range, aperture_range, attr_filter, tag_and_roots, tag_group_op,
        limit, offset,
    )
    cached_resp = _API_PHOTOS_RESPONSE_CACHE.get(resp_cache_key)
    if cached_resp and (now_req_ts - cached_resp[0]) <= _PHOTO_DIR_SCAN_TTL:
        return cached_resp[1]

    inc_list = [t.strip() for t in include_tags.split(",") if t.strip()] if include_tags else None
    exc_list = [t.strip() for t in exclude_tags.split(",") if t.strip()] if exclude_tags else None
    and_roots_list = [r.strip() for r in tag_and_roots.split(",") if r.strip()] if tag_and_roots else None
    ym_list = [y.strip() for y in year_months.split(",") if y.strip()] if year_months else None
    dates_list = [d.strip() for d in dates.split(",") if d.strip()] if dates else None
    cam_list = [c.strip() for c in cameras.split(",") if c.strip()] if cameras else None
    raw_ex_cams = excluded_cameras or exclude_cameras
    ex_cam_list = [c.strip() for c in raw_ex_cams.split(",") if c.strip()] if raw_ex_cams else None
    lens_list = [l.strip() for l in lenses.split(",") if l.strip()] if lenses else None
    raw_ex_lenses = excluded_lenses or exclude_lenses
    ex_lens_list = [l.strip() for l in raw_ex_lenses.split(",") if l.strip()] if raw_ex_lenses else None
    ratings_list = [int(r.strip()) for r in ratings.split(",") if r.strip()] if ratings else None

    photos = get_photos(
        folder=folder,
        volume_serial=volume_serial,
        serial_mode=serial_mode,
        year_month=year_month,
        year_months=ym_list,
        dates=dates_list,
        cameras=cam_list,
        excluded_cameras=ex_cam_list,
        lenses=lens_list,
        excluded_lenses=ex_lens_list,
        ratings=ratings_list,
        search=search,
        included_tags=inc_list,
        excluded_tags=exc_list,
        untagged_only=untagged,
        sort_by=sort_by,
        stacked=stacked,
        limit=limit,
        offset=offset,
        exclude_folder=exclude_folder,
        unlinked_only=unlinked_only,
        include_unlinked=include_unlinked,
        duplicates_only=duplicates_only,
        country=country,
        state=state,
        city=city,
        no_location_only=no_location,
        lab_filter=lab_filter,
        on_this_day=on_this_day,
        focal_range=focal_range,
        aperture_range=aperture_range,
        attr_filter=attr_filter,
        tag_and_roots=and_roots_list,
        tag_group_op=tag_group_op,
    )

    # ドライブVSN対応表とストレージルート判定のみで O(1) にオフライン/Loome状態を確定（os.scandir 不使用）
    dir_meta_map: Dict[Tuple[str, Optional[str]], Tuple[bool, bool]] = {}
    raw_pair_jpeg_vsn_map: Dict[str, Optional[str]] = {}
    paired_raw_targets = [
        p.get("paired_raw_path")
        for p in photos
        if not p.get("is_unlinked") and p.get("is_raw") and p.get("paired_raw_path")
    ]
    if paired_raw_targets:
        unique_targets = list(dict.fromkeys(paired_raw_targets))
        try:
            with get_connection() as conn:
                cur = conn.cursor()
                for i in range(0, len(unique_targets), 500):
                    chunk = unique_targets[i:i + 500]
                    ph = ",".join(["?"] * len(chunk))
                    cur.execute(
                        f"SELECT file_path, volume_serial FROM photo_links WHERE file_path COLLATE NOCASE IN ({ph}) "
                        f"UNION ALL SELECT file_path, volume_serial FROM photos WHERE file_path COLLATE NOCASE IN ({ph})",
                        chunk + chunk,
                    )
                    for r in cur.fetchall():
                        fp_val = r[0]
                        if not fp_val:
                            continue
                        k = fp_val.lower()
                        v_val = (r[1] or "").strip() or None
                        if k not in raw_pair_jpeg_vsn_map or (raw_pair_jpeg_vsn_map[k] is None and v_val is not None):
                            raw_pair_jpeg_vsn_map[k] = v_val
        except Exception as e:
            logger.debug(f"ペアJPEGのVSN一括取得スキップ: {e}")

    for p in photos:
        if p.get("is_unlinked"):
            p["is_offline"] = False
            p["is_missing"] = False
            p["is_storage"] = False
            continue
        dir_path = p.get("directory_path")
        v_ser = p.get("volume_serial") or None
        if dir_path:
            dk = (dir_path, v_ser)
            meta_entry = dir_meta_map.get(dk)
            if meta_entry is None:
                _, is_dir_online = resolve_drive_online_path(dir_path, expected_serial=v_ser)
                is_dir_storage = is_path_in_storage(dir_path, volume_serial=v_ser)
                meta_entry = (bool(is_dir_online), bool(is_dir_storage))
                dir_meta_map[dk] = meta_entry
            is_dir_online, is_dir_storage = meta_entry
        else:
            is_dir_online = False
            is_dir_storage = is_photo_in_storage(p)

        # RAW+JPEGペアで万一RAW側レコードが返された場合も、触る対象であるJPEG側がオンラインならオンライン扱いとする
        if not is_dir_online and p.get("is_raw") and p.get("paired_raw_path"):
            jpeg_fp = str(p["paired_raw_path"])
            jpeg_dir = str(Path(jpeg_fp).parent)
            jpeg_vsn = raw_pair_jpeg_vsn_map[jpeg_fp.lower()] if jpeg_fp.lower() in raw_pair_jpeg_vsn_map else v_ser
            j_dk = (jpeg_dir, jpeg_vsn)
            j_meta = dir_meta_map.get(j_dk)
            if j_meta is None:
                _, j_online = resolve_drive_online_path(jpeg_dir, expected_serial=jpeg_vsn)
                j_storage = is_path_in_storage(jpeg_dir, volume_serial=jpeg_vsn)
                j_meta = (bool(j_online), bool(j_storage))
                dir_meta_map[j_dk] = j_meta
            if j_meta[0]:
                is_dir_online = True

        p["is_offline"] = not is_dir_online
        p["is_storage"] = is_dir_storage
        p["is_missing"] = False

    resp = _fast_json({"photos": photos, "count": len(photos)})
    if len(_API_PHOTOS_RESPONSE_CACHE) >= 12:
        try:
            oldest_key = next(iter(_API_PHOTOS_RESPONSE_CACHE))
            _API_PHOTOS_RESPONSE_CACHE.pop(oldest_key, None)
        except StopIteration:
            pass
    _API_PHOTOS_RESPONSE_CACHE[resp_cache_key] = (now_req_ts, resp)
    return resp


@app.get("/api/photo/{photo_id}")
def api_get_photo_detail(photo_id: int):
    """指定IDの写真詳細情報（タグ一覧・スタックメンバー・XMPサイドカー解析情報含む）を取得する"""
    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    # ポータブルパス・オフライン状態解決（VSN対応）
    vol_serial = photo.get("volume_serial")
    dir_path = photo.get("directory_path")
    is_dir_online = False
    if dir_path:
        _, is_dir_online = resolve_portable_path(dir_path, expected_serial=vol_serial)
        photo["is_offline"] = not is_dir_online

    paired_path_str = photo.get("paired_raw_path")
    if paired_path_str:
        pair_vsn = _lookup_paired_volume_serial(paired_path_str, vol_serial)
        _, is_paired_online = resolve_portable_path(paired_path_str, expected_serial=pair_vsn)
        photo["paired_is_offline"] = not is_paired_online
        # RAWレコードが表示されている場合でも相手JPEGがオンラインならオンライン扱いとする
        if photo.get("is_raw") and is_paired_online and not is_dir_online:
            photo["is_offline"] = False
    else:
        photo["paired_is_offline"] = False

    photo["is_storage"] = is_photo_in_storage(photo)
    if photo.get("is_unlinked"):
        photo["is_offline"] = False
        photo["is_storage"] = False
        photo["paired_is_offline"] = False

    # XMPサイドカー情報の付与
    file_path_str = photo.get("file_path")
    if file_path_str:
        real_path, is_online = resolve_portable_path(file_path_str, expected_serial=vol_serial)
        if is_online and real_path.exists():
            photo["xmp_info"] = parse_xmp_for_photo(real_path, _resolve_paired_raw_path(photo))
        else:
            photo["xmp_info"] = {"has_xmp": False}
    else:
        photo["xmp_info"] = {"has_xmp": False}
    return photo


class XmpImportMetadataRequest(BaseModel):
    import_rating: bool = True
    import_tags: bool = True


@app.get("/api/photo/{photo_id}/xmp-preview")
def api_get_photo_xmp_preview(photo_id: int, mode: str = Query(default="thumb")):
    """
    XMPサイドカーの現像調整値のみを元画像へオンザフライ適用したプレビュー画像を返す。
    Photo Manager のDB上の非破壊調整値は一切適用せず、XMP側の調整（回転・傾き・クロップ・露出・コントラスト・彩度）のみを反映する。
    - mode="thumb": WebPサムネイル (max_size=360, image/webp)
    - mode="view": フルサイズ拡大プレビュー (image/jpeg, quality=90)
    """
    import io as _io
    from PIL import Image as _Image, ImageOps as _ImageOps

    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    file_path_str = photo.get("file_path")
    if not file_path_str:
        raise HTTPException(status_code=404, detail="ファイルパスが記録されていません")

    vol_serial = photo.get("volume_serial")
    real_path, is_online = resolve_portable_path(file_path_str, expected_serial=vol_serial)
    if not is_online or not real_path.exists():
        raise HTTPException(status_code=404, detail="元写真ファイルが未接続です")

    xmp_info = parse_xmp_for_photo(real_path, _resolve_paired_raw_path(photo))
    adj = xmp_info.get("adjustments") or {}
    rot_val = int(adj.get("rotation") or 0)
    fa_val = float(adj.get("fine_angle") or 0.0)
    cw_val = adj.get("crop_w")
    ch_val = adj.get("crop_h")
    cx_val = adj.get("crop_x") or 0.0
    cy_val = adj.get("crop_y") or 0.0
    crop_box = (cx_val, cy_val, cw_val, ch_val) if (cw_val and ch_val) else None
    b_val = int(adj.get("brightness") or 0)
    ct_val = int(adj.get("contrast") or 0)
    s_val = int(adj.get("saturation") or 0)

    if str(mode).lower() == "thumb":
        res = render_thumbnail_webp(
            real_path,
            max_size=360,
            allow_cloud_download=True,
            rotation=rot_val,
            fine_angle=fa_val,
            crop_box=crop_box,
            brightness=b_val,
            contrast=ct_val,
            saturation=s_val,
        )
        if res is None:
            raise HTTPException(status_code=500, detail="XMPサムネイルプレビューの生成に失敗しました")
        thumb_bytes, _, _ = res
        return Response(
            content=thumb_bytes,
            media_type="image/webp",
            headers={
                "Cache-Control": "no-cache, must-revalidate",
                "X-Photo-Xmp-Preview": "thumb",
            },
        )

    # mode == "view"
    pil_img = None
    try:
        if photo.get("is_raw") or is_raw_file(real_path):
            preview_res = extract_raw_full_preview(real_path)
            if preview_res:
                img_bytes, _, _, _ = preview_res
                pil_img = _Image.open(_io.BytesIO(img_bytes))
            elif photo.get("paired_raw_path"):
                p_pair, is_pair_online = resolve_portable_path(photo["paired_raw_path"], expected_serial=vol_serial)
                if is_pair_online and p_pair.exists():
                    pil_img = (
                        _Image.open(_io.BytesIO(read_loome_file_decrypted_bytes(p_pair)))
                        if is_vault_encrypted_file(p_pair)
                        else _Image.open(p_pair)
                    )
                    pil_img = _ImageOps.exif_transpose(pil_img)
        else:
            pil_img = (
                _Image.open(_io.BytesIO(read_loome_file_decrypted_bytes(real_path)))
                if is_vault_encrypted_file(real_path)
                else _Image.open(real_path)
            )
            pil_img = _ImageOps.exif_transpose(pil_img)
    except Exception as e:
        logger.warning(f"XMPプレビュー用元画像読み込み失敗 ({real_path}): {e}")
        pil_img = None

    if pil_img is None:
        raise HTTPException(status_code=500, detail="XMPプレビュー用の元画像を読み込めませんでした")

    try:
        pil_img = apply_photo_adjustments_pil(
            pil_img,
            rotation=rot_val,
            fine_angle=fa_val,
            crop_box=crop_box,
            brightness=b_val,
            contrast=ct_val,
            saturation=s_val,
        )
        if pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")
        buf = _io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=90)
        return Response(
            content=buf.getvalue(),
            media_type="image/jpeg",
            headers={
                "Cache-Control": "no-cache, must-revalidate",
                "X-Photo-Xmp-Preview": "view",
            },
        )
    except Exception as e:
        logger.error(f"XMPプレビュー描画エラー ({real_path}): {e}")
        raise HTTPException(status_code=500, detail=f"XMPプレビュー生成エラー: {e}")


@app.post("/api/photo/{photo_id}/import-xmp-metadata")
def api_import_xmp_metadata(
    photo_id: int,
    req: XmpImportMetadataRequest = XmpImportMetadataRequest(),
):
    """
    写真に付随する .xmp サイドカーから、評価（4段階変換）およびタグ（すべて XMP/ ルート配下）を
    Photo Manager のDBへ明示的に取り込む。
    """
    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    file_path_str = photo.get("file_path")
    if not file_path_str:
        raise HTTPException(status_code=404, detail="ファイルパスが記録されていません")

    real_path, is_online = resolve_portable_path(file_path_str, expected_serial=photo.get("volume_serial"))
    if not is_online or not real_path.exists():
        raise HTTPException(status_code=404, detail="元写真ファイルが未接続です")

    xmp_info = parse_xmp_for_photo(real_path, _resolve_paired_raw_path(photo))
    if not xmp_info.get("has_xmp"):
        raise HTTPException(status_code=404, detail="XMPサイドカーファイルが見つかりません")

    imported_rating: Optional[int] = None
    rating_info = xmp_info.get("rating") or {}
    if req.import_rating and rating_info.get("has_rating") and rating_info.get("mapped_rating") is not None:
        mapped_r = int(rating_info["mapped_rating"])
        if -1 <= mapped_r <= 2:
            update_rating(photo_id, mapped_r)
            imported_rating = mapped_r

    imported_tags: List[str] = []
    xmp_tags = xmp_info.get("tags") or []
    if req.import_tags and xmp_tags:
        for tag in xmp_tags:
            if tag:
                add_tag_to_photo(photo_id, tag)
                imported_tags.append(tag)

    clear_api_photos_cache()
    return {
        "status": "ok",
        "photo_id": photo_id,
        "imported_rating": imported_rating,
        "imported_tags": imported_tags,
    }


@app.post("/api/photo/{photo_id}/set-primary")
def api_set_primary(photo_id: int):
    """指定された写真をそのスタック（ブラケットグループ）の代表写真に設定する"""
    success = set_stack_primary(photo_id)
    if not success:
        raise HTTPException(status_code=400, detail="スタック代表の変更に失敗しました（スタックに属していない可能性があります）")
    clear_api_photos_cache()
    return {"status": "ok", "photo_id": photo_id}


@app.post("/api/stacks/recalculate")
def api_recalculate_stacks(folder: Optional[str] = None):
    """露出ブラケットや連写写真の自動スタックを再計算する"""
    count = recalculate_stacks(folder)
    clear_api_photos_cache()
    return {"status": "ok", "stacks_created": count}


@app.get("/api/stacks/{stack_id}")
def api_get_stack_detail(stack_id: int):
    """指定されたスタックIDに属する全メンバー写真のフル詳細情報を取得する"""
    from .database.stacks import get_stack_detail
    detail = get_stack_detail(stack_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="指定されたスタックが見つかりません")
    return _fast_json(detail)


@app.delete("/api/photo/{photo_id}")
def api_delete_photo(photo_id: int, delete_file: bool = False):
    """写真をライブラリから削除する（delete_file=True の場合は保管庫内実ファイルも削除）"""
    try:
        success = delete_photo_by_id(photo_id, delete_file=delete_file)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    if not success:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    clear_folders_fs_cache()
    invalidate_loome_roots_cache()
    clear_api_photos_cache()
    return {"status": "ok", "photo_id": photo_id, "deleted_file": delete_file}



@app.get("/api/tags")
def api_get_tags():
    """すべてのタグ集計と未分類写真件数、ライブラリ総写真数を取得する"""
    tags = get_all_tags_summary()
    untagged_count = get_untagged_count()
    total_count = get_total_photos_count()
    conn_counts = get_connection_counts()
    return _fast_json({"tags": tags, "untagged_count": untagged_count, "total_count": total_count, **conn_counts})


@app.delete("/api/tags/{tag:path}")
def api_delete_tag(tag: str):
    """指定されたタグを全写真から一括削除する（子孫タグも含む）"""
    deleted_count = delete_tag(tag)
    clear_api_photos_cache()
    return _fast_json({
        "status": "ok",
        "tag": tag,
        "deleted_count": deleted_count,
        "tags": get_all_tags_summary(),
        "untagged_count": get_untagged_count(),
        "total_count": get_total_photos_count(),
    })


class RenameTagRequest(BaseModel):
    new_tag: str


@app.post("/api/tags/create")
def api_create_tag_definition(req: TagRequest):
    """写真未付与のまま新規タグ（親フォルダタグ等）をタグツリー定義に登録する"""
    from .database import create_tag_definition
    success = create_tag_definition(
        req.tag,
        short_name=req.short_name,
        is_pinned=bool(req.is_pinned),
    )
    if not success:
        raise HTTPException(status_code=400, detail="タグ名が空です")
    return _fast_json({
        "status": "ok",
        "tag": req.tag.strip().strip("/"),
        "tags": get_all_tags_summary(),
        "untagged_count": get_untagged_count(),
        "total_count": get_total_photos_count(),
    })


@app.put("/api/tags-meta")
def api_update_tag_meta(req: UpdateTagMetaRequest):
    """タグのメタデータ（スマホ用ショート名 short_name・ピン留め is_pinned）を更新する"""
    try:
        updated = update_tag_metadata(
            tag=req.tag or "",
            tag_key=req.tag_key,
            short_name=req.short_name,
            is_pinned=req.is_pinned,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _fast_json({
        "status": "ok",
        "tag_meta": updated,
        "tags": get_all_tags_summary(),
        "untagged_count": get_untagged_count(),
        "total_count": get_total_photos_count(),
    })


@app.put("/api/tags/{tag:path}")
def api_rename_tag(tag: str, req: RenameTagRequest):
    """タグをリネームまたは別階層へ移動する（子孫タグのプレフィックスも一括変更）"""
    try:
        updated_count = rename_tag(tag, req.new_tag)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    clear_api_photos_cache()
    return _fast_json({
        "status": "ok",
        "old_tag": tag,
        "new_tag": req.new_tag,
        "updated_count": updated_count,
        "tags": get_all_tags_summary(),
        "untagged_count": get_untagged_count(),
        "total_count": get_total_photos_count(),
    })


@app.post("/api/photo/{photo_id}/tags")
def api_add_tag(photo_id: int, req: TagRequest):
    """写真にタグを追加する（tag_key が指定されている場合は最新パスへ解決）"""
    target_tag = req.tag
    if req.tag_key:
        from .database.connection import get_connection
        with get_connection() as conn:
            resolved = resolve_tag_by_key_or_name(conn.cursor(), req.tag_key, req.tag)
            if resolved:
                target_tag = resolved
    success = add_tag_to_photo(photo_id, target_tag)
    clear_api_photos_cache()
    return {"status": "ok", "photo_id": photo_id, "tag": target_tag, "success": success}


@app.delete("/api/photo/{photo_id}/tags/{tag:path}")
def api_remove_tag(photo_id: int, tag: str):
    """写真からタグを削除する"""
    success = remove_tag_from_photo(photo_id, tag)
    clear_api_photos_cache()
    return {"status": "ok", "photo_id": photo_id, "tag": tag, "success": success}


class BatchTagRequest(BaseModel):
    photo_ids: List[int]
    tag: str
    tag_key: Optional[str] = None
    action: str = "add"  # "add" または "remove"


class BatchRateRequest(BaseModel):
    photo_ids: List[int]
    rating: int


@app.post("/api/photos/batch-tags")
def api_batch_tags(req: BatchTagRequest):
    """複数の写真に一括でタグを追加または削除する（マルチ選択用）"""
    target_tag = req.tag
    if req.tag_key:
        from .database.connection import get_connection
        with get_connection() as conn:
            resolved = resolve_tag_by_key_or_name(conn.cursor(), req.tag_key, req.tag)
            if resolved:
                target_tag = resolved
    if req.action == "remove":
        affected = batch_remove_tag(req.photo_ids, target_tag)
    else:
        affected = batch_add_tag(req.photo_ids, target_tag)
    clear_api_photos_cache()
    return {"status": "ok", "affected": affected, "tag": target_tag, "action": req.action}


@app.post("/api/photos/batch-rate")
def api_batch_rate(req: BatchRateRequest):
    """複数の写真の星評価を一括更新する"""
    if req.rating not in (-1, 0, 1, 2):
        raise HTTPException(status_code=400, detail="評価値は -1(棄) / 0(可) / 1(良) / 2(優) のいずれかです")
    affected = batch_update_rating(req.photo_ids, req.rating)
    clear_api_photos_cache()
    return {"status": "ok", "affected": affected, "rating": req.rating}


class BatchDeleteRequest(BaseModel):
    photo_ids: List[int]


@app.post("/api/photos/batch-delete")
def api_batch_delete(req: BatchDeleteRequest):
    """複数の写真をライブラリ（DB）から一括削除する（実ファイルは削除しない）"""
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="削除対象が指定されていません")
    deleted = delete_photos_by_ids(req.photo_ids)
    clear_folders_fs_cache()
    invalidate_loome_roots_cache()
    clear_api_photos_cache()
    return {"status": "ok", "deleted": deleted}


# ==============================================================================
# 非破壊画像調整（回転・クロップ）API
# ==============================================================================

@app.post("/api/photo/{photo_id}/rotate")
def api_rotate_photo(photo_id: int, req: RotateRequest = RotateRequest()):
    """写真の回転角度を90度単位で加算更新し、サムネイルキャッシュも追従更新する"""
    res = rotate_photo(photo_id, delta_degrees=req.delta)
    if not res.get("success"):
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    try:
        refresh_photo_thumbnail_transform(photo_id, delta_degrees=req.delta)
    except Exception as e:
        logger.warning(f"回転後のサムネイル更新に失敗 ({photo_id}): {e}")
    clear_api_photos_cache()
    return res


@app.post("/api/photos/batch-rotate")
def api_batch_rotate(req: BatchRotateRequest):
    """複数の写真の回転角度を一括で加算更新し、サムネイルも更新する"""
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="対象写真が指定されていません")
    affected = batch_rotate_photos(req.photo_ids, delta_degrees=req.delta)
    for pid in req.photo_ids:
        try:
            refresh_photo_thumbnail_transform(pid, delta_degrees=req.delta)
        except Exception as e:
            logger.warning(f"一括回転後のサムネイル更新失敗 ({pid}): {e}")
    clear_api_photos_cache()
    return {"status": "ok", "affected": affected}


@app.post("/api/photo/{photo_id}/adjust")
def api_adjust_photo(photo_id: int, req: AdjustRequest):
    """写真の回転角度・水平傾き補正・トリミング範囲・トーン微調整を非破壊更新し、サムネイルキャッシュを更新する"""
    success = update_photo_adjustments(
        photo_id=photo_id,
        rotation=req.rotation,
        fine_angle=req.fine_angle,
        crop_x=req.crop_x,
        crop_y=req.crop_y,
        crop_w=req.crop_w,
        crop_h=req.crop_h,
        crop_aspect=req.crop_aspect,
        brightness=req.brightness,
        contrast=req.contrast,
        saturation=req.saturation,
    )
    if not success:
        raise HTTPException(status_code=404, detail="写真の更新に失敗しました")
    clear_api_photos_cache()
    try:
        refresh_photo_thumbnail_transform(photo_id)
    except Exception as e:
        logger.warning(f"調整後のサムネイル更新に失敗 ({photo_id}): {e}")
    return {"status": "ok", "photo_id": photo_id}


@app.post("/api/photo/{photo_id}/adjustments")
def api_mobile_adjust_photo(photo_id: int, req: MobileAdjustmentsRequest):
    """モバイル/タッチ画面からの非破壊トーン・傾き微調整を部分更新する（既存の回転・クロップ範囲は維持）"""
    existing = get_photo_by_id(photo_id)
    if not existing:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    rot_val = req.rotation if req.rotation is not None else int(existing.get("rotation") or 0)
    fa_val = req.fine_angle if req.fine_angle is not None else float(existing.get("fine_angle") or 0.0)
    b_val = req.brightness if req.brightness is not None else int(existing.get("brightness") or 0)
    c_val = req.contrast if req.contrast is not None else int(existing.get("contrast") or 0)
    s_val = req.saturation if req.saturation is not None else int(existing.get("saturation") or 0)

    success = update_photo_adjustments(
        photo_id=photo_id,
        rotation=rot_val,
        fine_angle=fa_val,
        crop_x=existing.get("crop_x"),
        crop_y=existing.get("crop_y"),
        crop_w=existing.get("crop_w"),
        crop_h=existing.get("crop_h"),
        crop_aspect=existing.get("crop_aspect"),
        brightness=b_val,
        contrast=c_val,
        saturation=s_val,
    )
    if not success:
        raise HTTPException(status_code=404, detail="写真の更新に失敗しました")
    clear_api_photos_cache()
    try:
        refresh_photo_thumbnail_transform(photo_id)
    except Exception as e:
        logger.warning(f"モバイル調整後のサムネイル更新に失敗 ({photo_id}): {e}")
    return {
        "status": "ok",
        "photo_id": photo_id,
        "rotation": rot_val,
        "fine_angle": fa_val,
        "brightness": b_val,
        "contrast": c_val,
        "saturation": s_val,
    }


@app.post("/api/photo/{photo_id}/adjust/reset")
def api_reset_photo_adjust(photo_id: int):
    """写真の回転・傾き・トリミング・トーンをリセットし、サムネイルを元に戻す"""
    success = reset_photo_adjustments(photo_id)
    if not success:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    try:
        refresh_photo_thumbnail_transform(photo_id)
    except Exception as e:
        logger.warning(f"リセット後のサムネイル更新に失敗 ({photo_id}): {e}")
    clear_api_photos_cache()
    return {"status": "ok", "photo_id": photo_id}


@app.post("/api/photos/batch-reset-adjust")
def api_batch_reset_photo_adjust(req: BatchResetAdjustRequest):
    """複数写真の回転およびトリミングを一括リセットし、サムネイルを元に戻す"""
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="対象写真が指定されていません")
    affected = batch_reset_photo_adjustments(req.photo_ids)
    for pid in req.photo_ids:
        try:
            refresh_photo_thumbnail_transform(pid)
        except Exception as e:
            logger.warning(f"一括リセット後のサムネイル更新失敗 ({pid}): {e}")
    clear_api_photos_cache()
    return {"status": "ok", "affected": affected}


@app.post("/api/photos/batch-adjust-tone")
def api_batch_adjust_photo_tone(req: BatchToneAdjustRequest):
    """複数写真のトーン微調整（明るさ・コントラスト・彩度）のみを一括更新し、既存の回転・傾き・クロップを維持したままサムネイルを再生成する"""
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="対象写真が指定されていません")
    unique_ids = list(dict.fromkeys(req.photo_ids))
    affected = batch_update_photo_tone(
        unique_ids,
        brightness=req.brightness,
        contrast=req.contrast,
        saturation=req.saturation,
    )

    def _refresh_one(pid: int) -> None:
        try:
            refresh_photo_thumbnail_transform(pid)
        except Exception as e:
            logger.warning(f"トーン一括ペースト後のサムネイル更新失敗 ({pid}): {e}")

    if len(unique_ids) == 1:
        _refresh_one(unique_ids[0])
    elif len(unique_ids) > 1:
        max_workers = min(4, os.cpu_count() or 2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            list(executor.map(_refresh_one, unique_ids))

    clear_api_photos_cache()
    return {
        "status": "ok",
        "affected": affected,
        "brightness": req.brightness,
        "contrast": req.contrast,
        "saturation": req.saturation,
    }


@app.post("/api/photos/batch-shift-date")
def api_batch_shift_photo_dates(req: BatchDateShiftRequest):
    """複数写真の撮影日時（date_taken）を指定秒数だけ一括シフト、または初期撮影日時（original_date_taken）へ非破壊リセットする"""
    res = batch_shift_photo_dates(
        photo_ids=req.photo_ids,
        offset_seconds=req.offset_seconds,
        reset=req.reset,
    )
    clear_api_photos_cache()
    return {
        "status": "ok",
        "updated_count": res["updated_count"],
        "photos": res["photos"],
    }


@app.get("/api/photo/{photo_id}/thumbnail")
def api_get_thumbnail(photo_id: int, request: Request):
    """写真の軽量WebPサムネイルを高速配信する（DBキャッシュ直引き ＋ オンデマンド生成フォールバック）"""
    photo = get_photo_brief(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    # 1. 既存サムネイルBLOBを直引きし、未生成時のみ元画像からオンデマンド生成
    thumb = db_get_thumbnail(photo_id)
    thumb_data: Optional[bytes] = thumb["data"] if thumb and thumb.get("data") else None
    if thumb_data is None:
        try:
            thumb_data = ensure_thumbnail(photo["id"], photo["file_path"])
            thumb = db_get_thumbnail(photo_id)
        except Exception as e:
            logger.debug(f"サムネイルのオンデマンド生成スキップ ({photo_id}): {e}")
            thumb_data = None

    if thumb_data is None:
        # サムネイル生成に失敗した場合（オフライン・一時的読み込みエラー等）、500エラーではなくプレースホルダーを返す
        from .scanner import get_ondemand_placeholder_webp
        return Response(
            content=get_ondemand_placeholder_webp(),
            media_type="image/webp",
            headers={
                "Cache-Control": "no-store",
                "X-Thumbnail-Error": "true",
            },
        )

    # ETagにファイルパスを含めてDB再構築時のID衝突を防止
    # file_mtime, rotation, fine_angle, crop_*, トーン微調整値に加え、サムネイルBLOBのサイズと寸法も含め、再生成後も古いサムネイルが返らないようにする
    path_hash = hashlib.md5(photo.get("file_path", "").encode()).hexdigest()[:8]
    mtime_part = int(photo.get("file_mtime") or 0)
    rot_part = photo.get("rotation") or 0
    fa_part = int(round((photo.get("fine_angle") or 0.0) * 10))
    cx_part = int((photo.get("crop_x") or 0) * 1000)
    cy_part = int((photo.get("crop_y") or 0) * 1000)
    cw_part = int((photo.get("crop_w") or 0) * 1000)
    ch_part = int((photo.get("crop_h") or 0) * 1000)
    b_part = int(photo.get("brightness") or 0)
    ct_part = int(photo.get("contrast") or 0)
    s_part = int(photo.get("saturation") or 0)
    thumb_len = len(thumb_data)
    thumb_w = (thumb.get("width") if thumb else 0) or 0
    thumb_h = (thumb.get("height") if thumb else 0) or 0
    etag_val = (
        f'"{photo_id}-{path_hash}-{photo.get("file_size", 0)}-{mtime_part}'
        f'-r{rot_part}-fa{fa_part}-c{cx_part}_{cy_part}_{cw_part}_{ch_part}'
        f'-t{b_part}_{ct_part}_{s_part}-tb{thumb_len}_{thumb_w}x{thumb_h}"'
    )

    # If-None-Match と ETag が一致した場合は 304 Not Modified（本文なし）を返す
    if_none_match = request.headers.get("if-none-match")
    if if_none_match and (if_none_match == etag_val or etag_val in [t.strip() for t in if_none_match.split(",")]):
        return Response(
            status_code=304,
            headers={
                "Cache-Control": "no-cache, must-revalidate",
                "ETag": etag_val,
            },
        )

    return Response(
        content=thumb_data,
        media_type="image/webp",
        headers={
            "Cache-Control": "no-cache, must-revalidate",
            "ETag": etag_val,
        },
    )


@app.get("/api/photo/{photo_id}/view")
def api_get_photo_view(photo_id: int, request: Request, raw: int = Query(default=0)):
    """
    実画像ファイルを配信する（拡大プレビュー用・RAWは埋め込み高解像度プレビュー・オフライン時はDB内サムネイルをスマートプレビュー配信）。
    raw=1 の場合は調整モーダル用に未加工の元画像を返し、
    raw=0 かつ非破壊調整（回転・クロップ・水平傾き補正・トーン調整）がある場合はオンザフライで調整反映済みJPEGを返す。
    """
    import io as _io
    from PIL import Image as _Image, ImageOps as _ImageOps

    photo = get_photo_brief(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    fa_val = float(photo.get("fine_angle") or 0.0)
    cw_val = photo.get("crop_w")
    ch_val = photo.get("crop_h")
    cx_val = photo.get("crop_x") or 0.0
    cy_val = photo.get("crop_y") or 0.0
    b_val = int(photo.get("brightness") or 0)
    ct_val = int(photo.get("contrast") or 0)
    s_val = int(photo.get("saturation") or 0)
    rot_val = int(photo.get("rotation") or 0)

    has_crop = bool(cw_val and ch_val and (cw_val < 0.999 or ch_val < 0.999 or cx_val > 0.001 or cy_val > 0.001))
    has_baked_adjustments = (raw == 0) and (
        rot_val != 0 or has_crop or abs(fa_val) > 0.01 or b_val != 0 or ct_val != 0 or s_val != 0
    )

    # ETagにファイルパスと更新日時および調整パラメータを含めてキャッシュ整合性を担保
    path_hash = hashlib.md5(photo.get("file_path", "").encode()).hexdigest()[:8]
    mtime_part = int(photo.get("file_mtime") or 0)
    file_size_part = photo.get("file_size", 0)
    if has_baked_adjustments:
        adj_sig = f"r{rot_val}_fa{int(round(fa_val*10))}_c{int(cx_val*1000)}_{int(cy_val*1000)}_{int((cw_val or 0)*1000)}_{int((ch_val or 0)*1000)}_t{b_val}_{ct_val}_{s_val}"
    else:
        adj_sig = f"raw{raw}"
    etag_val = f'"{photo_id}-{path_hash}-{file_size_part}-{mtime_part}-{adj_sig}-view"'

    target_path, is_online = resolve_portable_path(photo["file_path"], expected_serial=photo.get("volume_serial"))
    target_exists = bool(is_online and _safe_exists(target_path))
    switched_to_pair = False
    if not target_exists and photo.get("paired_raw_path"):
        pair_fp = str(photo["paired_raw_path"])
        pair_vsn = _lookup_paired_volume_serial(pair_fp, photo.get("volume_serial"))
        pair_path, is_pair_online = resolve_portable_path(pair_fp, expected_serial=pair_vsn)
        if is_pair_online and _safe_exists(pair_path):
            target_path = pair_path
            target_exists = True
            switched_to_pair = True

    if target_exists:
        # オンラインで実ファイルが存在する場合のみ ETag / 304 Not Modified を返す
        if_none_match = request.headers.get("if-none-match")
        if if_none_match and (if_none_match == etag_val or etag_val in [t.strip() for t in if_none_match.split(",")]):
            return Response(
                status_code=304,
                headers={
                    "Cache-Control": "no-cache, must-revalidate",
                    "ETag": etag_val,
                },
            )

        is_raw_target = is_raw_file(target_path) if switched_to_pair else bool(photo.get("is_raw") or is_raw_file(target_path))

        # 非破壊調整（回転・クロップ・水平出し・トーン微調整）が有効かつ raw=0 の場合はPillowで適用して返却
        if has_baked_adjustments:
            try:
                pil_img = None
                if is_raw_target:
                    preview_res = extract_raw_full_preview(target_path)
                    if preview_res:
                        img_bytes, _, _, _ = preview_res
                        pil_img = _Image.open(_io.BytesIO(img_bytes))
                else:
                    pil_img = (
                        _Image.open(_io.BytesIO(read_loome_file_decrypted_bytes(target_path)))
                        if is_vault_encrypted_file(target_path)
                        else _Image.open(target_path)
                    )
                    pil_img = _ImageOps.exif_transpose(pil_img)

                if pil_img is not None:
                    crop_box = (cx_val, cy_val, cw_val, ch_val) if (cw_val and ch_val) else None
                    pil_img = apply_photo_adjustments_pil(
                        pil_img,
                        rotation=rot_val,
                        fine_angle=fa_val,
                        crop_box=crop_box,
                        brightness=b_val,
                        contrast=ct_val,
                        saturation=s_val,
                    )
                    if pil_img.mode != "RGB":
                        pil_img = pil_img.convert("RGB")
                    buf = _io.BytesIO()
                    pil_img.save(buf, format="JPEG", quality=92)
                    return Response(
                        content=buf.getvalue(),
                        media_type="image/jpeg",
                        headers={
                            "Cache-Control": "no-cache, must-revalidate",
                            "ETag": etag_val,
                            "X-Photo-Adjusted": "true",
                            "X-Photo-View-Source": "original",
                        },
                    )
            except Exception as e:
                logger.warning(f"拡大プレビューへの非破壊調整適用失敗 ({target_path}): {e}")

        # RAWファイルはブラウザが直接デコードできないため、カメラ内現像済みの埋め込みフルサイズプレビュー（JPEG）を抽出して配信
        if is_raw_target:
            try:
                preview_res = extract_raw_full_preview(target_path)
                if preview_res:
                    img_bytes, mime_type, w, h = preview_res
                    return Response(
                        content=img_bytes,
                        media_type=mime_type,
                        headers={
                            "Cache-Control": "no-cache, must-revalidate",
                            "ETag": etag_val,
                            "X-Photo-Raw-Preview": "full",
                            "X-Photo-View-Source": "original",
                        },
                    )
            except Exception as e:
                logger.warning(f"RAWフルサイズプレビュー抽出失敗 ({target_path}): {e}")

            # フルサイズプレビューが取得できなかった場合のフォールバック: DBサムネイル（キャッシュ汚染防止のためETagなし）
            try:
                thumb_data = ensure_thumbnail(photo["id"], photo["file_path"], allow_cloud_download=True)
                return Response(
                    content=thumb_data,
                    media_type="image/webp",
                    headers={
                        "Cache-Control": "no-store",
                        "X-Photo-Offline": "true",
                    },
                )
            except Exception as e:
                logger.debug(f"調整適用プレビュー生成失敗、スマートプレビューへフォールバック (id={photo_id}): {e}")
        else:
            import mimetypes as _mimetypes
            ext_low = target_path.suffix.lower()
            is_vault = is_vault_encrypted_file(target_path)
            if ext_low in (".tif", ".tiff"):
                try:
                    raw_src = _io.BytesIO(read_loome_file_decrypted_bytes(target_path)) if is_vault else target_path
                    with _Image.open(raw_src) as tiff_img:
                        conv_img = _ImageOps.exif_transpose(tiff_img)
                        if conv_img.mode != "RGB":
                            conv_img = conv_img.convert("RGB")
                        buf = _io.BytesIO()
                        conv_img.save(buf, format="JPEG", quality=92)
                    return Response(
                        content=buf.getvalue(),
                        media_type="image/jpeg",
                        headers={
                            "Cache-Control": "no-cache, must-revalidate",
                            "ETag": etag_val,
                            "X-Photo-View-Source": "original",
                        },
                    )
                except Exception as e:
                    logger.warning(f"TIFF原本のブラウザ配信変換失敗 ({target_path}): {e}")
            elif is_vault:
                mime_guess = _mimetypes.guess_type(str(target_path))[0] or "image/jpeg"
                return Response(
                    content=read_loome_file_decrypted_bytes(target_path),
                    media_type=mime_guess,
                    headers={
                        "Cache-Control": "no-cache, must-revalidate",
                        "ETag": etag_val,
                        "X-Photo-View-Source": "original",
                    },
                )
            elif is_cloud_or_ondemand_path(target_path):
                # クラウド仮想FS上のファイルはFileResponse事前statとの不整合を避けるため一括読込して配信する
                try:
                    data_bytes = target_path.read_bytes()
                    mime_guess = _mimetypes.guess_type(str(target_path))[0] or "image/jpeg"
                    return Response(
                        content=data_bytes,
                        media_type=mime_guess,
                        headers={
                            "Cache-Control": "no-cache, must-revalidate",
                            "ETag": etag_val,
                            "X-Photo-View-Source": "original",
                        },
                    )
                except Exception as e:
                    logger.warning(f"クラウド原本のオンデマンド読込失敗、スマートプレビューへフォールバック ({target_path}): {e}")
            else:
                return FileResponse(
                    str(target_path),
                    headers={
                        "Cache-Control": "no-cache, must-revalidate",
                        "ETag": etag_val,
                        "X-Photo-View-Source": "original",
                    },
                )

    # オフライン時（USB持出で元ドライブ未接続など）または実ファイル取得失敗時はDB内サムネイルをスマートプレビューとしてフォールバック配信
    # ※再接続時にフル解像度へ即切り替わるよう ETag は付与せず no-store とする
    thumb = db_get_thumbnail(photo_id)
    if thumb:
        return Response(
            content=thumb["data"],
            media_type="image/webp",
            headers={
                "Cache-Control": "no-store",
                "X-Photo-Offline": "true",
            },
        )

    # サムネイルもない場合はプレースホルダーWebPを返して404を回避
    from .scanner import get_ondemand_placeholder_webp
    return Response(
        content=get_ondemand_placeholder_webp(),
        media_type="image/webp",
        headers={
            "Cache-Control": "no-store",
            "X-Photo-Offline": "true",
            "X-Photo-Missing": "true",
        },
    )


@app.get("/api/thumbnails/batch")
def api_get_thumbnails_batch(ids: str = Query(..., description="カンマ区切りのphoto_idリスト")):
    """
    複数サムネイルをIN句で一括取得する（バッチAPI）。
    クエリパラメータ ids=1,2,3,... を受け取り、Base64エンコードされたサムネイルをJSON返却。
    """
    try:
        photo_ids = [int(x.strip()) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids パラメータには数値のカンマ区切りを指定してください")

    if not photo_ids:
        return {"thumbnails": {}}

    results = get_thumbnails_batch(photo_ids)
    thumbnails = {}
    for pid, info in results.items():
        thumbnails[str(pid)] = {
            "data_base64": base64.b64encode(info["data"]).decode("ascii"),
            "width": info["width"],
            "height": info["height"],
        }
    return {"thumbnails": thumbnails}


@app.post("/api/thumbnails/refresh")
def api_refresh_thumbnails(req: RefreshThumbnailsRequest):
    """
    指定された写真のサムネイルを実ファイルからオンデマンドで生成・更新する。
    force=True の場合は既存のサムネイルBLOBを上書き再生成する。
    単一写真なら即時実行、複数写真なら ThreadPoolExecutor により並列生成して高速化する。
    """
    if not req.photo_ids:
        return {"status": "ok", "success_ids": [], "failed_ids": [], "total": 0}

    unique_ids = list(dict.fromkeys(req.photo_ids))
    briefs = get_photos_brief_batch(unique_ids)
    brief_map = {b["id"]: b for b in briefs}

    success_ids: List[int] = []
    failed_ids: List[int] = []

    def _process_one(photo_brief: Dict[str, Any]) -> Tuple[int, bool]:
        pid = photo_brief["id"]
        file_path_str = photo_brief.get("file_path", "")
        try:
            target_path, is_online = resolve_portable_path(
                file_path_str,
                expected_serial=photo_brief.get("volume_serial"),
            )
            if not is_online or not target_path.exists():
                logger.warning(f"サムネイル再生成スキップ（ファイル未接続） (ID: {pid}): {file_path_str}")
                return pid, False

            crop_box = None
            if photo_brief.get("crop_w") and photo_brief.get("crop_h"):
                crop_box = (
                    photo_brief.get("crop_x") or 0.0,
                    photo_brief.get("crop_y") or 0.0,
                    photo_brief["crop_w"],
                    photo_brief["crop_h"],
                )
            res = render_thumbnail_webp(
                target_path,
                max_size=360,
                allow_cloud_download=True,
                rotation=photo_brief.get("rotation") or 0,
                fine_angle=photo_brief.get("fine_angle") or 0.0,
                crop_box=crop_box,
                brightness=photo_brief.get("brightness") or 0,
                contrast=photo_brief.get("contrast") or 0,
                saturation=photo_brief.get("saturation") or 0,
            )
            if res is None:
                logger.warning(f"サムネイル再生成失敗（render_thumbnail_webp が None） (ID: {pid}): {file_path_str}")
                return pid, False

            thumb_data, thumb_w, thumb_h = res
            file_hash = compute_thumbnail_hash(str(target_path))
            save_thumbnail(pid, thumb_data, thumb_w, thumb_h, file_hash)

            if (
                is_raw_file(target_path)
                and (
                    int(photo_brief.get("width") or 0) <= 0
                    or int(photo_brief.get("height") or 0) <= 0
                    or (photo_brief.get("camera_model") or "") in ("", "不明", "RAW写真")
                )
            ):
                try:
                    meta = extract_metadata(target_path)
                    meta["volume_serial"] = photo_brief.get("volume_serial")
                    if not photo_brief.get("volume_serial") and file_path_str and meta.get("file_path") != file_path_str:
                        meta["file_path"] = file_path_str
                        meta["directory_path"] = os.path.dirname(file_path_str)
                    upsert_photo(meta)
                except Exception as meta_err:
                    logger.warning(f"RAWメタデータ補完スキップ (ID: {pid}): {meta_err}")

            return pid, True
        except Exception as e:
            logger.error(f"サムネイル再生成エラー (ID: {pid}): {e}")
            return pid, False

    def _process_one_worker(photo_brief: Dict[str, Any]) -> Tuple[int, bool]:
        try:
            return _process_one(photo_brief)
        finally:
            try:
                close_thread_connection()
            except Exception as close_err:
                logger.debug(f"スレッドDB接続クローズ警告: {close_err}")

    target_briefs = [brief_map[pid] for pid in unique_ids if pid in brief_map]

    # DBに対象が存在しなかったIDをfailed_idsに記録
    found_pids = {b["id"] for b in target_briefs}
    for pid in unique_ids:
        if pid not in found_pids:
            failed_ids.append(pid)

    if len(target_briefs) == 1:
        pid, ok = _process_one(target_briefs[0])
        if ok:
            success_ids.append(pid)
        else:
            failed_ids.append(pid)
    elif len(target_briefs) > 1:
        max_workers = min(4, os.cpu_count() or 2)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_id = {executor.submit(_process_one_worker, b): b["id"] for b in target_briefs}
            for future in concurrent.futures.as_completed(future_to_id):
                pid = future_to_id[future]
                try:
                    res_pid, ok = future.result()
                    if ok:
                        success_ids.append(res_pid)
                    else:
                        failed_ids.append(res_pid)
                except Exception as e:
                    logger.error(f"サムネイル並列ワーカー例外 (ID: {pid}): {e}")
                    failed_ids.append(pid)

    invalidate_fast_cache()
    return {
        "status": "ok",
        "success_ids": success_ids,
        "failed_ids": failed_ids,
        "total": len(unique_ids),
    }


# OSの規定アプリで直接開くことを許可する画像・RAW拡張子（実行可能ファイルの起動を防止）
_SAFE_OPEN_MEDIA_EXTS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".avif",
    ".cr2", ".cr3", ".crw", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".orf", ".rw2", ".raf",
    ".pef", ".dng", ".erf", ".3fr", ".fff", ".iiq", ".rwl", ".srw", ".x3f", ".mrw", ".kdc", ".dcr",
}


def _validate_safe_media_file(path: Path) -> None:
    """os.startfile で開く対象が実在する通常ファイルであり、安全な画像/RAW拡張子であることを検証する"""
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail=f"ファイルが存在しません: {path}")
    if path.suffix.lower() not in _SAFE_OPEN_MEDIA_EXTS:
        raise HTTPException(status_code=403, detail=f"セキュリティ保護のため画像・RAW以外のファイルは開けません: {path.suffix}")


@app.post("/api/photo/{photo_id}/open-raw")
def api_open_raw(photo_id: int):
    """ペアのRAWファイルをOSのデフォルトアプリケーションで開く"""
    import os as _os

    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    if photo.get("is_raw") and photo.get("paired_raw_path"):
        raw_path_str = photo.get("file_path")
        raw_vsn = photo.get("volume_serial")
    else:
        raw_path_str = photo.get("paired_raw_path")
        if not raw_path_str:
            raise HTTPException(status_code=404, detail="この写真にはRAWペアが存在しません")
        raw_vsn = _lookup_paired_volume_serial(raw_path_str, photo.get("volume_serial"))

    raw_path, is_online = resolve_portable_path(raw_path_str, expected_serial=raw_vsn)
    if not is_online:
        raise HTTPException(status_code=404, detail="RAWファイルの保存先ドライブが未接続です（オフライン）")
    _validate_safe_media_file(raw_path)

    try:
        _os.startfile(str(raw_path))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"RAWファイルを開けませんでした: {e}")

    return {"status": "ok", "raw_path": str(raw_path)}


@app.post("/api/photo/{photo_id}/open-folder")
def api_open_photo_folder(photo_id: int):
    """写真（元データ）が格納されているフォルダをOS標準のエクスプローラーで開き、該当写真を選択状態にする"""
    import subprocess
    import os as _os

    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    file_path_str = photo.get("file_path")
    if not file_path_str:
        raise HTTPException(status_code=404, detail="ファイルパスが記録されていません")

    target_path, is_online = resolve_portable_path(file_path_str, expected_serial=photo.get("volume_serial"))
    if not is_online:
        raise HTTPException(status_code=404, detail="写真の保存先ドライブが未接続です（オフライン）")

    norm_file = _os.path.normpath(str(target_path))
    parent_dir = _os.path.normpath(str(target_path.parent))

    # 1. 実ファイルが存在する場合: explorer.exe /select,"<path>" でファイルを選択した状態で開く
    if _os.path.isfile(norm_file):
        try:
            # explorer /select,"パス" の文字列構文でプロセスを起動
            # ※ リスト形式 ["explorer", f"/select,{path}"] は引数全体がクォートされ /select スイッチが壊れるため文字列形式を使用
            safe_norm = norm_file.replace('"', "")
            subprocess.Popen(f'explorer.exe /select,"{safe_norm}"')
            return {"status": "ok", "path": norm_file}
        except Exception as e:
            if _os.path.isdir(parent_dir):
                try:
                    _os.startfile(parent_dir)
                    return {"status": "ok", "path": parent_dir}
                except Exception as e2:
                    raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {e2}")

    # 2. 親フォルダが存在する場合: 親フォルダを確実に開く
    elif _os.path.isdir(parent_dir):
        try:
            _os.startfile(parent_dir)
            return {"status": "ok", "path": parent_dir}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"フォルダを開けませんでした: {e}")

    raise HTTPException(status_code=404, detail=f"ファイルまたはフォルダが存在しません: {norm_file}")


@app.post("/api/photo/{photo_id}/open-file")
def api_open_photo_file(photo_id: int):
    """写真の実ファイルをOSの規定アプリケーション（既定のビューワ・現像ソフト等）で開く"""
    import os as _os

    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    file_path_str = photo.get("file_path")
    if not file_path_str:
        raise HTTPException(status_code=404, detail="ファイルパスが記録されていません")

    target_path, is_online = resolve_portable_path(file_path_str, expected_serial=photo.get("volume_serial"))
    if not is_online:
        raise HTTPException(status_code=404, detail="写真の保存先ドライブが未接続です（オフライン）")

    _validate_safe_media_file(target_path)

    try:
        _os.startfile(str(target_path))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ファイルを開けませんでした: {e}")

    return {"status": "ok", "path": str(target_path)}


@app.post("/api/photo/{photo_id}/rate")
def api_rate_photo(photo_id: int, req: RateRequest):
    """評価（-1:棄, 0:可, 1:良, 2:優）を更新する"""
    if not (-1 <= req.rating <= 2):
        raise HTTPException(status_code=400, detail="評価は-1〜2の範囲で指定してください（-1:棄, 0:可, 1:良, 2:優）")

    success = update_rating(photo_id, req.rating)
    if not success:
        raise HTTPException(status_code=404, detail="写真が見つかりません")

    clear_api_photos_cache()
    return {"status": "ok", "photo_id": photo_id, "rating": req.rating}


@app.get("/api/timeline")
def api_get_timeline():
    """年・月ごとの写真枚数集計を取得する"""
    timeline = get_timeline_summary()
    return _fast_json({"timeline": timeline})


@app.get("/api/calendar/summary")
def api_get_calendar_summary():
    """日別（YYYY-MM-DD）の写真枚数・優枚数・代表写真ID・代表撮影地を集計して返す（ミニカレンダー＆拡大カレンダー用）"""
    days = get_calendar_summary()
    return _fast_json({"days": days})


@app.get("/api/folders")
def api_get_folders(fast: int = Query(0)):
    """フォルダごとの写真枚数集計を取得する（fast=1 の場合は未管理サブフォルダの os.scandir 走査を省略して高速返却）"""
    if fast:
        folders = get_folders_summary(include_unmanaged=False)
        return _fast_json({"folders": folders, "roots": []})
    folders = get_folders_summary(include_unmanaged=True)
    roots = get_scan_roots_summary()
    return _fast_json({"folders": folders, "roots": roots})


class OpenFolderRequest(BaseModel):
    folder_path: str


@app.post("/api/folders/open")
def api_open_folder(req: OpenFolderRequest):
    """指定されたフォルダをOS標準のエクスプローラーで開く"""
    target_path, is_online = resolve_portable_path(req.folder_path)
    norm_path = os.path.normpath(str(target_path))
    print(f"[DEBUG] api_open_folder: req={req.folder_path}, target={norm_path}, exists={os.path.exists(norm_path)}, is_dir={os.path.isdir(norm_path)}")
    if not os.path.exists(norm_path) or not os.path.isdir(norm_path):
        raise HTTPException(status_code=404, detail=f"フォルダが存在しないか、ドライブが未接続です: {norm_path}")
    try:
        os.startfile(norm_path)
        return {"status": "ok", "folder_path": norm_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"エクスプローラーの起動に失敗しました: {e}")


@app.delete("/api/folders")
def api_delete_folder(req: DeleteFolderRequest):
    """指定したフォルダの写真登録をDBから解除する（実ファイルは削除しない。volume_serial指定時は該当メディアのみ解除）"""
    try:
        result = remove_folder_photos(
            req.folder_path,
            recursive=req.recursive,
            volume_serial=req.volume_serial,
        )
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return {
            "status": "ok",
            "folder_path": req.folder_path,
            "deleted_count": result["deleted_count"],
            "affected_folders": result["affected_folders"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FolderIgnoreRequest(BaseModel):
    folder_path: str


@app.post("/api/folders/ignore")
def api_ignore_folder(req: FolderIgnoreRequest):
    """指定されたフォルダを除外（管理対象外）として登録し、DBから写真を解除する"""
    try:
        add_ignored_folder(req.folder_path)
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return {"status": "ok", "folder_path": req.folder_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/folders/ignore")
def api_unignore_folder(req: FolderIgnoreRequest):
    """指定されたフォルダの除外設定を解除する（未管理状態に戻す）"""
    try:
        remove_ignored_folder(req.folder_path)
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return {"status": "ok", "folder_path": req.folder_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/folders/ignored")
def api_get_ignored_folders():
    """除外フォルダ一覧を取得する"""
    try:
        ignored = get_ignored_folders()
        return {"ignored_folders": ignored}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FolderDiffRequest(BaseModel):
    folder_path: str
    volume_serial: Optional[str] = None


@app.post("/api/folders/check-diff")
def api_check_folder_diff(req: FolderDiffRequest):
    """フォルダ直下の実ファイルとDBレコードの高速差分（追加・削除・変更）を判定する"""
    try:
        target_path, is_drive_online = resolve_drive_online_path(req.folder_path, expected_serial=req.volume_serial)
        if not is_drive_online:
            return {"status": "ok", "has_changes": False, "is_offline": True, "added": 0, "deleted": 0, "modified": 0}
        diff = check_folder_diff(str(target_path), volume_serial=req.volume_serial)
        return {"status": "ok", **diff}
    except Exception as e:
        return {"status": "error", "has_changes": False, "detail": str(e), "added": 0, "deleted": 0, "modified": 0}


class FolderCleanupMissingRequest(BaseModel):
    folder_path: str
    recursive: bool = False
    volume_serial: Optional[str] = None


@app.post("/api/folders/cleanup-missing")
def api_cleanup_missing_folder_photos(req: FolderCleanupMissingRequest):
    """指定フォルダ配下の実ファイル消失写真をDBからクリーンアップ（登録解除）する"""
    try:
        cleaned = cleanup_missing_photos_in_folder(
            req.folder_path,
            recursive=req.recursive,
            volume_serial=req.volume_serial,
        )
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return {"status": "ok", "cleaned": cleaned, "folder_path": req.folder_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FolderUnlinkMissingRequest(BaseModel):
    folder_path: str
    recursive: bool = False
    volume_serial: Optional[str] = None


@app.post("/api/folders/unlink-missing")
def api_unlink_missing_folder_photos(req: FolderUnlinkMissingRequest):
    """
    指定フォルダ配下の実ファイル消失写真について、
    DBレコード（サムネイル・タグ含む）は保持したまま、実体パスとの紐付けを解除（リンク消失）する
    """
    try:
        unlinked = unlink_missing_photos_in_folder(
            req.folder_path,
            recursive=req.recursive,
            volume_serial=req.volume_serial,
        )
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return {"status": "ok", "unlinked": unlinked, "folder_path": req.folder_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class PurgeUnlinkedRequest(BaseModel):
    photo_ids: Optional[List[int]] = None


@app.post("/api/photos/purge-unlinked")
def api_purge_unlinked_photos(req: PurgeUnlinkedRequest):
    """
    ユーザーの明示的な要求に基づき、リンク消失写真をDB（サムネイル・タグ含む）から完全抹消する
    """
    try:
        purged = purge_unlinked_photos(req.photo_ids)
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return {"status": "ok", "purged": purged}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/photos/missing")
def api_delete_missing_photos():
    """実ファイルが消失した写真を一括でDBからクリーンアップする"""
    try:
        missing = get_missing_photos()
        missing_ids = [int(p["id"]) for p in missing if p.get("id")]
        deleted = delete_photos_by_ids(missing_ids) if missing_ids else 0
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return {"status": "ok", "deleted": deleted}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/version")
def api_get_version():
    """現在のアプリケーションバージョンと最終更新日時を取得する"""
    return get_version_info()



@app.get("/api/database/stats")
def api_get_database_stats():
    """データベースのファイルサイズと空き領域（フリーリスト）の統計を取得する"""
    try:
        stats = get_database_stats()
        return {"status": "ok", "stats": stats}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/database/vacuum")
def api_vacuum_database():
    """データベースの空き領域を回収してファイルサイズを最適化・圧縮する（VACUUM実行）"""
    try:
        result = vacuum_database()
        return {"status": "ok", "result": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/database/backup")
def api_backup_database():
    """データベースを安全にバックアップし、世代管理を行う"""
    try:
        result = backup_database(max_backups=5)
        return {"status": "ok", "result": result}
    except Exception as e:
        logger.error(f"データベースバックアップ失敗: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/database/backups")
def api_get_database_backups():
    """バックアップ一覧と最新情報を取得する"""
    try:
        info = get_backup_info()
        return {"status": "ok", "info": info}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/database/open-backup-dir")
def api_open_backup_dir():
    """バックアップ保存フォルダをエクスプローラーで開く"""
    try:
        ok = open_backup_directory()
        return {"status": "ok" if ok else "error"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FilterPresetCreateRequest(BaseModel):
    name: str
    filters: Any
    description: Optional[str] = ""


class FilterPresetUpdateRequest(BaseModel):
    name: str
    filters: Any
    description: Optional[str] = ""


@app.get("/api/filter-presets")
def api_get_filter_presets():
    """保存されたフィルタプリセット一覧を取得する"""
    presets = get_filter_presets()
    return {"presets": presets}


@app.post("/api/filter-presets")
def api_create_filter_preset(req: FilterPresetCreateRequest):
    """新しいフィルタプリセットを作成・保存する"""
    try:
        preset = create_filter_preset(req.name, req.filters, req.description or "")
        return {"status": "ok", "preset": preset}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"プリセットの保存に失敗しました: {str(e)}")


@app.get("/api/filter-presets/{preset_id}")
def api_get_filter_preset(preset_id: int):
    """指定IDのフィルタプリセットを取得する"""
    preset = get_filter_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="プリセットが見つかりません")
    return {"status": "ok", "preset": preset}


@app.put("/api/filter-presets/{preset_id}")
def api_update_filter_preset(preset_id: int, req: FilterPresetUpdateRequest):
    """指定IDのフィルタプリセットを更新する"""
    try:
        preset = update_filter_preset(preset_id, req.name, req.filters, req.description or "")
        if not preset:
            raise HTTPException(status_code=404, detail="プリセットが見つかりません")
        return {"status": "ok", "preset": preset}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"プリセットの保存に失敗しました: {str(e)}")


@app.delete("/api/filter-presets/{preset_id}")
def api_delete_filter_preset(preset_id: int):
    """指定IDのフィルタプリセットを削除する"""
    success = delete_filter_preset(preset_id)
    if not success:
        raise HTTPException(status_code=404, detail="プリセットが見つかりません")
    return {"status": "ok", "deleted_id": preset_id}


@app.get("/api/cameras")
def api_get_cameras():
    """カメラ機種ごとの写真枚数集計を取得する"""
    cameras = get_cameras_summary()
    return _fast_json({"cameras": cameras})


def _get_windows_quick_access() -> list:
    """Windowsの主要な特殊フォルダ（よく使う場所）の正確なパスを取得する"""
    home = Path.home()
    items = []

    # Windowsレジストリからリダイレクト先（OneDriveや別ドライブ等）を正確に取得
    folder_paths = {}
    try:
        import winreg

        sub_key = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub_key) as key:
            reg_names = {
                "pictures": "My Pictures",
                "desktop": "Desktop",
                "documents": "Personal",
                "downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
            }
            for k, val_name in reg_names.items():
                try:
                    raw_val, _ = winreg.QueryValueEx(key, val_name)
                    exp_val = os.path.expandvars(raw_val)
                    if os.path.isdir(exp_val):
                        folder_paths[k] = exp_val
                except (OSError, FileNotFoundError) as e:
                    logger.debug(f"レジストリ特殊フォルダ取得スキップ ({val_name}): {e}")
    except (OSError, FileNotFoundError) as e:
        logger.debug(f"Windows レジストリ User Shell Folders オープンスキップ: {e}")

    # 特殊フォルダの定義リスト
    special_defs = [
        ("pictures", "ピクチャ", "🖼️", home / "Pictures"),
        ("desktop", "デスクトップ", "🖥️", home / "Desktop"),
        ("documents", "ドキュメント", "📁", home / "Documents"),
        ("downloads", "ダウンロード", "📥", home / "Downloads"),
    ]

    for key, name, icon, fallback_path in special_defs:
        target_path = folder_paths.get(key)
        if not target_path:
            if fallback_path.exists():
                target_path = str(fallback_path)
            else:
                # OneDrive 配下の確認
                for rel in [f"OneDrive\\{fallback_path.name}", "OneDrive\\画像", "OneDrive\\ドキュメント"]:
                    op = home / rel
                    if op.exists():
                        target_path = str(op)
                        break

        if target_path and os.path.isdir(target_path):
            items.append({
                "key": key,
                "name": name,
                "path": target_path,
                "icon": icon,
                "is_special": True,
            })

    # ユーザーホーム
    if home.exists():
        items.append({
            "key": "home",
            "name": f"ユーザー ({home.name})",
            "path": str(home),
            "icon": "🏠",
            "is_special": True,
        })

    return items


@app.get("/api/folder-tree/roots")
def api_folder_tree_roots(refresh: int = Query(default=0)):
    """フォルダツリー最上位（ショートカット・接続中ドライブ・未接続ボリューム）を返す"""
    if refresh:
        clear_online_cache()
        clear_folders_fs_cache()
        clear_api_photos_cache()
    return _fast_json(build_folder_tree_roots(_get_windows_quick_access()))


@app.get("/api/folder-tree/children")
def api_folder_tree_children(
    path: str,
    volume_serial: Optional[str] = None,
    serial_mode: str = "any",
    offline: bool = False,
):
    """フォルダツリーの指定ノード直下の子フォルダ（管理状態・写真枚数付き）を返す"""
    if not path or not path.strip():
        raise HTTPException(status_code=400, detail="path が指定されていません")
    if serial_mode not in ("any", "match", "match_or_null", "null"):
        raise HTTPException(status_code=400, detail="serial_mode が不正です")
    try:
        return _fast_json(list_folder_tree_children(path, volume_serial, serial_mode, offline))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))


@app.get("/api/browse")
def api_browse_folders(path: Optional[str] = None):
    """ディレクトリの子フォルダ一覧を返す（ツリーブラウザ用）。
    path 未指定時は利用可能なドライブ一覧およびクイックアクセス一覧を返す（Windows対応）。
    """
    import string
    from pathlib import Path as _Path

    if not path or path.strip() == "":
        quick_access = _get_windows_quick_access()

        # Windows: 存在するドライブレターを列挙
        drives = []
        for letter in string.ascii_uppercase:
            drive_path = f"{letter}:\\"
            try:
                if not os.path.isdir(drive_path):
                    continue
                # ドライブラベルの取得（可能であれば）
                label = ""
                try:
                    import ctypes
                    buf = ctypes.create_unicode_buffer(256)
                    ctypes.windll.kernel32.GetVolumeInformationW(
                        drive_path, buf, 256, None, None, None, None, 0
                    )
                    label = buf.value
                except Exception as e:
                    logger.debug(f"ドライブラベル取得スキップ ({drive_path}): {e}")
                display = f"{letter}: ({label})" if label else f"{letter}:"
                drives.append({"name": display, "path": drive_path, "is_drive": True, "icon": "💿"})
            except (OSError, PermissionError):
                continue  # アクセス不可のドライブ（光学/未接続など）はスキップ
        return {
            "quick_access": quick_access,
            "drives": drives,
            "folders": drives,  # 既存クライアント後方互換
            "parent": None,
            "current": "",
        }

    # 指定されたパスのサブフォルダ一覧
    target = _Path(path)
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"ディレクトリが見つかりません: {path}")

    children = []
    try:
        for entry in sorted(target.iterdir()):
            if entry.is_dir() and not entry.name.startswith(".") and entry.name.lower() != "import":
                children.append({
                    "name": entry.name,
                    "path": str(entry),
                    "icon": "📁",
                })
    except PermissionError as e:
        logger.debug(f"ディレクトリ走査アクセス権限なしスキップ ({path}): {e}")

    parent = str(target.parent) if target.parent != target else None
    return {"folders": children, "parent": parent, "current": str(target)}


@app.get("/api/scan/status")
def api_get_scan_status():
    """現在実行中のスキャン進捗状態を取得する"""
    return scan_tracker.get_status()


@app.post("/api/scan")
def api_scan_folder(req: ScanRequest):
    """指定されたフォルダをスキャンしてインデックスを更新する（diff_only=True 時は変更ディレクトリのみピンポイント更新）"""
    try:
        if getattr(req, "diff_only", False):
            from .folder_diff import refresh_folder_diff
            result = refresh_folder_diff(
                req.folder_path,
                volume_serial=req.volume_serial,
            )
        else:
            result = scan_directory(
                req.folder_path,
                cleanup_orphans=req.cleanup_orphans,
                recursive=req.recursive,
                volume_serial=req.volume_serial,
            )
        clear_api_photos_cache()
        if getattr(req, "auto_ai_tag", False) and int(result.get("added_or_updated") or 0) > 0:
            from .ai import get_ai_worker
            aff_dirs = result.get("affected_dirs")
            ai_folder = aff_dirs[0] if isinstance(aff_dirs, list) and len(aff_dirs) == 1 else req.folder_path
            get_ai_worker().start_tagging(folder_path=ai_folder)
        return {"status": "ok", "result": result}
    except PermissionError as e:
        # 指紋不一致によるセキュリティブロック
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))




class PhotoUploadItem(BaseModel):
    filename: str
    content_base64: str
    rel_path: Optional[str] = None


class PhotoUploadRequest(BaseModel):
    files: List[PhotoUploadItem]
    destination: Optional[str] = None
    target_folder: Optional[str] = None


def _resolve_upload_item_dir(base_dir: Path, active_root: Path, rel_path_raw: Optional[str]) -> Path:
    """アップロードファイルの相対パスからサブフォルダを安全に解決する（パストラバーサル防止）"""
    if not rel_path_raw:
        return base_dir
    norm_rel = str(rel_path_raw).replace("\\", "/").strip("/")
    parts = [p.strip() for p in norm_rel.split("/") if p.strip()]
    if len(parts) <= 1:
        return base_dir
    dir_parts = parts[:-1]
    clean_parts: List[str] = []
    for seg in dir_parts:
        if seg in (".", "..") or seg.startswith("."):
            raise ValueError("不正な相対パス指定が含まれています")
        cleaned = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "_", seg).strip().rstrip(".")
        if not cleaned or cleaned in (".", "..") or cleaned.startswith("."):
            raise ValueError(f"無効なフォルダ名です: {seg}")
        clean_parts.append(cleaned)
    resolved = base_dir.joinpath(*clean_parts).resolve()
    root_str = str(active_root.resolve()).rstrip("\\/").lower()
    res_str = str(resolved).rstrip("\\/").lower()
    if not (res_str == root_str or res_str.startswith(root_str + "\\")):
        raise ValueError("アップロード先が Loome の管理範囲外です")
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


@app.post("/api/upload")
def api_upload_photos(req: PhotoUploadRequest):
    """ブラウザからのドラッグ＆ドロップまたはファイル・フォルダ選択で Loome へ写真・付随サイドカーを追加する (サブフォルダ構造維持対応)"""
    dest_spec = req.destination or req.target_folder
    try:
        target_dir, active_root = resolve_storage_target_with_root(dest_spec, must_exist=False)
        target_dir.mkdir(parents=True, exist_ok=True)
        add_scan_root(str(active_root))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    from .volume_info import get_volume_info
    vol_info = get_volume_info(str(target_dir))
    upload_vsn = vol_info["serial"] if vol_info else None

    saved_photos = []
    saved_photo_ids: List[int] = []
    saved_sidecars = []
    errors = []

    # 第1パス: サイドカーファイル（.xmp, .pp3, .dop 等）を先に保存し、直後の画像 extract_metadata で参照可能にする
    photo_items: List[Tuple[PhotoUploadItem, Path]] = []
    for item in req.files:
        if not item.filename:
            continue
        try:
            item_dir = _resolve_upload_item_dir(target_dir, active_root, item.rel_path)
        except ValueError as ve:
            errors.append(f"{item.filename}: {str(ve)}")
            continue
        safe_name = Path(item.filename).name
        ext = Path(safe_name).suffix.lower()
        if is_sidecar_file(safe_name):
            clean_sc_name = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "_", safe_name).strip().rstrip(".")
            if not clean_sc_name:
                continue
            dest_sc_path = item_dir / clean_sc_name
            try:
                raw_b64 = item.content_base64
                if "," in raw_b64:
                    raw_b64 = raw_b64.split(",", 1)[1]
                file_bytes = base64.b64decode(raw_b64)
                with open(dest_sc_path, "wb") as f:
                    f.write(file_bytes)
                saved_sidecars.append(dest_sc_path.name)
            except Exception as e:
                errors.append(f"{item.filename}: {str(e)}")
        elif ext in SUPPORTED_EXTENSIONS:
            photo_items.append((item, item_dir))
        else:
            errors.append(f"非対応形式: {item.filename}")

    # 第2パス: 画像本体の保存 & メタデータ抽出（付随XMPからのハードウェア補完含む）& DB登録
    for item, item_dir in photo_items:
        safe_name = Path(item.filename).name
        ext = Path(safe_name).suffix.lower()
        clean_stem = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "_", Path(safe_name).stem).strip().rstrip(".") or "photo"
        dest_path = item_dir / f"{clean_stem}{ext}"
        counter = 1
        while dest_path.exists():
            dest_path = item_dir / f"{clean_stem}_{counter}{ext}"
            counter += 1

        try:
            raw_b64 = item.content_base64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            file_bytes = base64.b64decode(raw_b64)

            with open(dest_path, "wb") as f:
                f.write(file_bytes)

            meta = extract_metadata(dest_path)
            if upload_vsn:
                meta["volume_serial"] = upload_vsn
            upserted_id = upsert_photo(meta)
            if upserted_id:
                saved_photo_ids.append(int(upserted_id))
            if get_current_security_level() == 2:
                try:
                    seal_loome_file(dest_path)
                except Exception as seal_err:
                    logger.warning(f"アップロード後のLv.2カプセル化警告 ({dest_path}): {seal_err}")
            saved_photos.append(dest_path.name)
        except Exception as e:
            errors.append(f"{item.filename}: {str(e)}")

    paired_raw_upload_ids = set()
    if saved_photos:
        try:
            recalculate_stacks(str(target_dir), recursive=True)
        except Exception as st_err:
            logger.warning(f"アップロード後のスタック再計算スキップ: {st_err}")

        if saved_photo_ids:
            try:
                from .database.connection import get_connection as _get_upload_conn
                uniq_up_ids = list(dict.fromkeys(saved_photo_ids))
                with _get_upload_conn() as _u_conn:
                    _u_cur = _u_conn.cursor()
                    for _i in range(0, len(uniq_up_ids), 500):
                        _chunk = uniq_up_ids[_i : _i + 500]
                        _ph = ",".join(["?"] * len(_chunk))
                        _u_cur.execute(
                            f"""
                            SELECT id FROM photos
                            WHERE id IN ({_ph})
                              AND COALESCE(is_raw, 0) = 1
                              AND paired_raw_path IS NOT NULL
                              AND paired_raw_path != ''
                            """,
                            _chunk,
                        )
                        for _r in _u_cur.fetchall():
                            paired_raw_upload_ids.add(int(_r["id"]))
            except Exception as pr_err:
                logger.warning(f"アップロード後のペア済みRAW判定スキップ: {pr_err}")

    if saved_photos or saved_sidecars:
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()

    logical_upload_count = (
        len([pid for pid in saved_photo_ids if pid not in paired_raw_upload_ids])
        if saved_photo_ids
        else len(saved_photos)
    )
    return {
        "status": "ok",
        "uploaded_count": logical_upload_count,
        "raw_pair_count": len(paired_raw_upload_ids),
        "uploaded_sidecar_count": len(saved_sidecars),
        "files": saved_photos,
        "sidecar_files": saved_sidecars,
        "destination": str(target_dir),
        "folder": str(target_dir),
        "errors": errors,
    }


# ==============================================================================
# 分割ルーター登録 & 後方互換シンボル re-export
# ==============================================================================
from .routers.ai_router import (
    AIClearTagsRequest,
    AIPromoteTagRequest,
    AITagColorBatchRequest,
    AITagFolderRequest,
    api_ai_cancel,
    api_ai_clear_tags,
    api_ai_promote_tag,
    api_ai_status,
    api_ai_tag_color_photos,
    api_ai_tag_folder,
    api_ai_tag_single_photo,
    router as _ai_router,
)
from .routers.export_import_router import (
    ContactSheetExportRequest,
    CopyToImportRequest,
    CreateImportFolderRequest,
    OpenImportFolderRequest,
    PickFolderRequest,
    SmartExportRequest,
    api_copy_to_import,
    api_create_import_folder,
    api_export_contact_sheet,
    api_get_default_export_dir,
    api_get_import_destinations,
    api_open_export_folder,
    api_open_import_folder,
    api_pick_export_folder,
    api_smart_export,
    router as _export_import_router,
)
from .routers.gps_lab_router import (
    BatchCopyGpsRequest,
    BatchInferGpsRequest,
    ClearGpsRequest,
    ClearInferredGpsRequest,
    CopyGpsRequest,
    api_backfill_locations,
    api_batch_copy_gps,
    api_batch_infer_gps,
    api_cleanup_zero_gps,
    api_clear_gps,
    api_clear_inferred_gps,
    api_copy_gps,
    api_delete_photo_gps,
    api_get_lab_karte,
    api_get_locations_heatmap,
    api_get_locations_tree,
    api_get_random_unrated_folder,
    api_gps_candidates,
    router as _gps_lab_router,
)
from .routers.mobile_router import (
    MobileSyncChangeItem,
    MobileSyncImportRequest,
    _apply_mobile_sync_changes,
    _find_detected_sync_file,
    _lan_mobile_url,
    _sanitize_mobile_tag,
    api_mobile_info,
    api_mobile_qr_svg,
    api_mobile_standalone,
    api_mobile_sync_import,
    mobile_app_entry,
    router as _mobile_router,
)
from .routers.security_router import (
    SecurityConfigureRequest,
    SecurityRecoverDbRequest,
    SecurityUnlockForeignLoomeRequest,
    SecurityUnlockRequest,
    api_get_security_status,
    api_security_configure,
    api_security_lock,
    api_security_recover_db,
    api_security_unlock,
    api_security_unlock_foreign_loome,
    router as _security_router,
)
from .routers.field_log_router import router as _field_log_router
from .routers.updater_router import router as _updater_router
from .routers.storage_volumes_router import (
    DuplicatesResolveRequest,
    EnableVolumeLoomeRequest,
    StorageBatchRenamePhotosRequest,
    StorageCreateFolderRequest,
    StorageDeleteFolderRequest,
    StorageExportFolderRequest,
    StorageImportPhotosRequest,
    StorageMovePhotosRequest,
    StorageRenameFolderRequest,
    StorageRenamePhotoRequest,
    UpdateVolumeNameRequest,
    _VOLUME_LABEL_PINS,
    api_batch_rename_photos_in_storage,
    api_create_storage_folder,
    api_delete_storage_folder,
    api_delete_volume,
    api_disable_volume_loome,
    api_enable_volume_loome,
    api_export_storage_folder,
    api_get_duplicates,
    api_get_storage_folders,
    api_get_volume_status,
    api_get_volumes,
    api_import_photos_to_storage,
    api_move_photos_in_storage,
    api_rename_photo_in_storage,
    api_rename_storage_folder,
    api_resolve_duplicates,
    api_update_volume_name,
    issue_volume_label_pin,
    router as _storage_volumes_router,
    verify_volume_label_pin,
)

app.include_router(_ai_router)
app.include_router(_gps_lab_router)
app.include_router(_storage_volumes_router)
app.include_router(_export_import_router)
app.include_router(_mobile_router)
app.include_router(_security_router)
app.include_router(_field_log_router)
app.include_router(_updater_router)


# favicon
_FAVICON_ICO_PATH = FRONTEND_DIR / "favicon.ico"


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    if _FAVICON_ICO_PATH.exists():
        return FileResponse(
            _FAVICON_ICO_PATH,
            media_type="image/x-icon",
            headers={"Cache-Control": "no-cache, must-revalidate"}
        )
    return Response(status_code=404)


# フロントエンド静的ファイルの提供
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

