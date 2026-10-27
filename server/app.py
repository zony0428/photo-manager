"""
FastAPI バックエンドメインアプリケーション
写真のインデックス、メタデータ配信、高速サムネイル提供、4段階評価（棄/可/良/優）管理を行う。
"""

import base64
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
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
    purge_unlinked_photos,
    get_duplicate_photos_count,
    get_thumbnail as db_get_thumbnail,
    get_thumbnails_batch,
    save_thumbnail,
    get_all_volumes,
    update_photo_gps,
    update_photo_adjustments,
    batch_update_photo_tone,
    batch_shift_photo_dates,
    add_scan_root,
    rotate_photo,
    reset_photo_adjustments,
    batch_reset_photo_adjustments,
    batch_rotate_photos,
    find_nearby_gps_photos,
    batch_copy_gps,
    batch_infer_gps,
    clear_inferred_gps,
    clear_photo_gps,
    cleanup_invalid_zero_gps,
    backfill_photo_locations,
    backfill_missing_lens_models,
    get_location_tree_summary,
    get_location_heatmap_data,
    get_lab_karte_data,
    get_random_unrated_folder,
    cleanup_missing_upload_photos,
    delete_photo_by_id,
    delete_photos_by_ids,
    get_all_duplicate_groups,
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
)
from .scanner import (
    scan_directory,
    scan_tracker,
    ensure_thumbnail,
    render_thumbnail_webp,
    apply_photo_adjustments_pil,
    compute_thumbnail_hash,
    extract_metadata,
    resolve_portable_path,
    is_raw_file,
    extract_raw_full_preview,
    check_folder_diff,
    refresh_photo_thumbnail_transform,
    SUPPORTED_EXTENSIONS,
)
from .database.folders import (
    clear_folders_fs_cache,
    _PHOTO_DIR_SCAN_CACHE,
    _PHOTO_DIR_SCAN_TTL,
)
from .storage_manager import (
    STORAGE_DIR,
    ensure_storage_dir,
    migrate_carry_to_storage,
    is_path_in_storage,
    is_photo_in_storage,
    resolve_storage_target_dir,
    get_storage_folders,
    create_storage_subfolder,
    rename_storage_subfolder,
    delete_storage_subfolder,
    import_photos_to_storage,
    move_photos_in_storage,
    rename_photo_in_storage,
    batch_rename_photos_in_storage,
    export_storage_folder,
)
from .heartbeat import (
    record_heartbeat,
    request_shutdown,
)
from .folder_tree import (
    build_roots as build_folder_tree_roots,
    list_children as list_folder_tree_children,
)

from .version import get_version, get_version_info, __version__
from .exporter import (
    run_smart_export,
    run_contact_sheet_export,
    pick_folder_dialog,
    open_folder_in_windows_explorer,
    DEFAULT_TAKEOUT_DIR,
)
from .mobile_bundle import (
    ensure_standalone_mobile_html,
    STANDALONE_HTML_FILENAME,
)
from .sidecar import (
    is_sidecar_file,
    parse_xmp_for_photo,
)
from .lan_access import (
    LAN_TOKEN,
    LAN_TOKEN_COOKIE,
    LAN_TOKEN_QUERY,
    build_lan_cookie_header,
    detect_local_ip_addresses as _detect_local_ip_addresses,
    ensure_lan_listeners,
    is_host_header_allowed,
    is_lan_path_allowed,
    is_lan_token_valid,
    is_loopback_client,
    touch_lan_activity,
)


import logging

logger = logging.getLogger("photo_manager.app")

# プロジェクトルートディレクトリ
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
UPLOAD_DIR = BASE_DIR / "storage"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
IMPORT_DIR = BASE_DIR / "take_out"
IMPORT_DIR.mkdir(parents=True, exist_ok=True)


# モバイルからのWi-Fi直接同期イベント通知用カウンタ（PC画面の自動リロード連動用）
_mobile_sync_event: Dict[str, int] = {"seq": 0, "applied_count": 0}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """起動時にDBを初期化し、旧carryからstorageへの移行・リンク切れ写真整理・無効な(0,0)GPSエラー整理を行い、単体モバイルHTMLを最新化する"""
    initialize_database()
    migrate_carry_to_storage()
    cleanup_missing_upload_photos(UPLOAD_DIR)
    cleanup_invalid_zero_gps()
    ensure_standalone_mobile_html()

    # 既存DBで lens_model が未設定の一眼カメラ写真（Panasonic MakerNote / XMP等）をバックグラウンドで自動補完
    # ※起動直後の「すべての写真」読み込みとディスクI/O・GILが競合しないよう15秒遅延させ、かつ一度チェック済みの環境ではスキップする
    def _bg_backfill_lenses():
        import time as _t
        _t.sleep(15.0)
        try:
            marker_file = BASE_DIR / "cache" / ".lens_backfill_done_v1"
            if marker_file.exists():
                return
            cnt = backfill_missing_lens_models(only_interchangeable_cameras=True)
            if cnt > 0:
                logger.info(f"[Backfill] 既存写真のレンズ機種名を {cnt} 件自動補完しました")
            marker_file.parent.mkdir(parents=True, exist_ok=True)
            marker_file.write_text("done", encoding="utf-8")
        except Exception as e:
            logger.warning(f"[Backfill] レンズ機種名の自動補完スキップ: {e}")

    threading.Thread(target=_bg_backfill_lenses, daemon=True).start()
    yield


def _fast_json(obj: Any) -> Response:
    """FastAPI標準のjsonable_encoderを回避し、json.dumpsで高速にJSONレスポンスを生成する"""
    return Response(
        content=json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str),
        media_type="application/json",
    )


# アプリ初期化
app = FastAPI(title="Photo Manager (Hinomaru Ink)", version=__version__, lifespan=lifespan)

# ローカル・プライベートLANオリジン判定用正規表現
_ALLOWED_ORIGIN_RE = re.compile(
    r"^https?://("
    r"127\.0\.0\.1|localhost|\[::1\]|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}"
    r")(:\d+)?$",
    re.IGNORECASE,
)

# 単体モバイルHTML (file:// や content:// 由来の Origin: null) からアクセスを許可するAPIパス
_NULL_ORIGIN_ALLOWED_PATHS = {
    "/api/mobile/sync-import",
    "/api/mobile/info",
    "/api/heartbeat",
    "/api/version",
}

def _is_origin_allowed(origin: Optional[str], path: str) -> bool:
    """クロスオリジンリクエストのOriginヘッダを検証し、外部悪意サイトからのCSRF/Localhost攻撃を遮断する"""
    if not origin:
        return True
    if origin == "null":
        return path in _NULL_ORIGIN_ALLOWED_PATHS
    return bool(_ALLOWED_ORIGIN_RE.match(origin))


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
    2. 外部Webサイトからの不正なクロスオリジン要求（Drive-by Localhost Attack）を遮断
    3. LAN経由アクセスはトークン認証＋ホワイトリストのAPIのみ許可
    4. 静的ファイル変更の即時反映およびモバイル単体HTMLからのLAN同期ヘッダを付与
    """
    path = request.url.path
    origin = request.headers.get("origin")
    client_host = request.client.host if request.client else "127.0.0.1"

    if not is_host_header_allowed(request.headers.get("host")):
        return _json_error(400, "Invalid Host header")

    if not _is_origin_allowed(origin, path):
        return _json_error(403, "Forbidden origin")

    set_lan_cookie = False
    if not is_loopback_client(client_host):
        if not _is_lan_request_allowed(client_host, request.method, path):
            return _json_error(403, "This operation is restricted to localhost only")
        cookie_token = request.cookies.get(LAN_TOKEN_COOKIE)
        query_token = request.query_params.get(LAN_TOKEN_QUERY)
        if not is_lan_token_valid(cookie_token, query_token):
            return _json_error(401, "LAN access token required. Please scan the QR code on the PC again.")
        touch_lan_activity()
        # QRコードURL (?t=...) で初回アクセスした場合、以降のリクエスト用にトークンをCookieへ保存する
        set_lan_cookie = not is_lan_token_valid(cookie_token, None)

    cors_origin = origin if origin else "http://127.0.0.1:8088"

    if request.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": cors_origin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Vary": "Origin",
        }
        if request.headers.get("access-control-request-private-network") == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        return Response(status_code=204, headers=headers)

    response = await call_next(request)
    if set_lan_cookie:
        response.headers.append("set-cookie", build_lan_cookie_header())
    if origin:
        response.headers["Access-Control-Allow-Origin"] = cors_origin
        response.headers["Vary"] = "Origin"
    if request.headers.get("access-control-request-private-network") == "true":
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


class AITagFolderRequest(BaseModel):
    folder_path: Optional[str] = None
    force_retag: bool = False


class AIPromoteTagRequest(BaseModel):
    photo_id: int
    tag: str


class AIClearTagsRequest(BaseModel):
    photo_id: Optional[int] = None
    folder_path: Optional[str] = None


class DeleteFolderRequest(BaseModel):
    folder_path: str
    recursive: bool = True


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


class RateRequest(BaseModel):
    rating: int


class RefreshThumbnailsRequest(BaseModel):
    photo_ids: List[int]
    force: bool = True



class TagRequest(BaseModel):
    tag: str


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


class WindowSettingsRequest(BaseModel):
    startup_mode: str
    apply_now: bool = True


def _resolve_paired_raw_path(photo: Dict[str, Any]) -> Optional[str]:
    """ペアRAWパスをポータブル解決し（ドライブレター変動対応）、XMP探索に渡せる文字列を返す"""
    raw_path_str = photo.get("paired_raw_path")
    if not raw_path_str:
        return None
    resolved, _ = resolve_portable_path(raw_path_str)
    return str(resolved)


@app.post("/api/heartbeat")
def api_heartbeat():
    """ブラウザからの生存確認を受け取り、スマホからのWi-Fi同期イベント連番を返す"""
    record_heartbeat()
    return {
        "status": "ok",
        "mobile_sync_seq": _mobile_sync_event["seq"],
        "mobile_sync_applied": _mobile_sync_event["applied_count"],
    }


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
    count = get_unlinked_photos_count()
    return {"count": count}


@app.get("/api/photos/duplicates-count")
def api_get_duplicates_count():
    """ライブラリ全体で他フォルダに重複（同一撮影日時＋サイズ）が存在する写真の件数を取得する"""
    count = get_duplicate_photos_count()
    return {"count": count}


@app.get("/api/photos")
def api_get_photos(
    folder: Optional[str] = None,
    year_month: Optional[str] = None,
    year_months: Optional[str] = None,
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
):
    """写真一覧を取得する（タグの含む/除外排他検索、年月OR条件、カメラ・レンズ含む/除外条件、場所階層絞り込み、ラボ分析フィルタ、ブラケットスタック表示、重複抽出、属性フィルタ対応）"""
    if missing_only:
        photos = get_missing_photos()
        for p in photos:
            p["is_storage"] = is_photo_in_storage(p)
        return _fast_json({"photos": photos, "count": len(photos)})

    inc_list = [t.strip() for t in include_tags.split(",") if t.strip()] if include_tags else None
    exc_list = [t.strip() for t in exclude_tags.split(",") if t.strip()] if exclude_tags else None
    ym_list = [y.strip() for y in year_months.split(",") if y.strip()] if year_months else None
    cam_list = [c.strip() for c in cameras.split(",") if c.strip()] if cameras else None
    raw_ex_cams = excluded_cameras or exclude_cameras
    ex_cam_list = [c.strip() for c in raw_ex_cams.split(",") if c.strip()] if raw_ex_cams else None
    lens_list = [l.strip() for l in lenses.split(",") if l.strip()] if lenses else None
    raw_ex_lenses = excluded_lenses or exclude_lenses
    ex_lens_list = [l.strip() for l in raw_ex_lenses.split(",") if l.strip()] if raw_ex_lenses else None
    ratings_list = [int(r.strip()) for r in ratings.split(",") if r.strip()] if ratings else None

    photos = get_photos(
        folder=folder,
        year_month=year_month,
        year_months=ym_list,
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
        exclude_folder=exclude_folder,
        unlinked_only=unlinked_only,
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
    )

    # ポータブル運用・オフライン状態判定および実体消失判定
    # ディレクトリ単位の並列 os.scandir ＋ TTLキャッシュにより 16,000枚超でもミリ秒単位で完了させる
    now_ts = time.monotonic()
    unique_dirs = {p.get("directory_path") for p in photos if p.get("directory_path")}
    uncached_dirs = [
        d for d in unique_dirs
        if d not in _PHOTO_DIR_SCAN_CACHE or (now_ts - _PHOTO_DIR_SCAN_CACHE[d][0]) > _PHOTO_DIR_SCAN_TTL
    ]

    if uncached_dirs:
        def _scan_one_dir(d_path: str):
            resolved_dir, is_dir_online = resolve_portable_path(d_path)
            is_dir_storage = is_path_in_storage(d_path)
            f_set = None
            if is_dir_online and resolved_dir:
                try:
                    with os.scandir(str(resolved_dir)) as it:
                        f_set = {entry.name.lower() for entry in it}
                except Exception as e:
                    logger.warning(f"ディレクトリスキャンキャッシュ取得失敗 ({resolved_dir}): {e}")
            return d_path, (now_ts, resolved_dir, is_dir_online, is_dir_storage, f_set)

        if len(uncached_dirs) > 4:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=8) as pool:
                for d_path, entry_val in pool.map(_scan_one_dir, uncached_dirs):
                    _PHOTO_DIR_SCAN_CACHE[d_path] = entry_val
        else:
            for d_path in uncached_dirs:
                _, entry_val = _scan_one_dir(d_path)
                _PHOTO_DIR_SCAN_CACHE[d_path] = entry_val

    for p in photos:
        dir_path = p.get("directory_path")
        cached = _PHOTO_DIR_SCAN_CACHE.get(dir_path) if dir_path else None
        if cached:
            _, _, is_dir_online, is_dir_storage, file_set = cached
        else:
            is_dir_online = False
            is_dir_storage = is_photo_in_storage(p)
            file_set = None

        is_offline = not is_dir_online
        p["is_offline"] = is_offline
        p["is_storage"] = is_dir_storage
        if not is_offline:
            fname = p.get("file_name") or os.path.basename(p.get("file_path", ""))
            if file_set is not None and fname and fname.lower() in file_set:
                p["is_missing"] = False
            else:
                f_path, _ = resolve_portable_path(p.get("file_path", ""))
                p["is_missing"] = not os.path.exists(str(f_path))
        else:
            p["is_missing"] = False

    return _fast_json({"photos": photos, "count": len(photos)})


@app.get("/api/photo/{photo_id}")
def api_get_photo_detail(photo_id: int):
    """指定IDの写真詳細情報（タグ一覧・スタックメンバー・XMPサイドカー解析情報含む）を取得する"""
    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    # ポータブルパス・オフライン状態解決
    dir_path = photo.get("directory_path")
    if dir_path:
        _, is_dir_online = resolve_portable_path(dir_path)
        photo["is_offline"] = not is_dir_online
    photo["is_storage"] = is_photo_in_storage(photo)

    # XMPサイドカー情報の付与
    file_path_str = photo.get("file_path")
    if file_path_str:
        real_path, is_online = resolve_portable_path(file_path_str)
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

    real_path, is_online = resolve_portable_path(file_path_str)
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
                p_pair, is_pair_online = resolve_portable_path(photo["paired_raw_path"])
                if is_pair_online and p_pair.exists():
                    pil_img = _Image.open(p_pair)
                    pil_img = _ImageOps.exif_transpose(pil_img)
        else:
            pil_img = _Image.open(real_path)
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

    real_path, is_online = resolve_portable_path(file_path_str)
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
    return {"status": "ok", "photo_id": photo_id}


@app.post("/api/stacks/recalculate")
def api_recalculate_stacks(folder: Optional[str] = None):
    """露出ブラケットや連写写真の自動スタックを再計算する"""
    count = recalculate_stacks(folder)
    return {"status": "ok", "stacks_created": count}


@app.delete("/api/photo/{photo_id}")
def api_delete_photo(photo_id: int, delete_file: bool = False):
    """写真をライブラリから削除する（delete_file=True の場合は実ファイルも削除）"""
    success = delete_photo_by_id(photo_id, delete_file=delete_file)
    if not success:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    return {"status": "ok", "photo_id": photo_id, "deleted_file": delete_file}



@app.get("/api/tags")
def api_get_tags():
    """すべてのタグ集計と未分類写真件数、ライブラリ総写真数を取得する"""
    tags = get_all_tags_summary()
    untagged_count = get_untagged_count()
    total_count = get_total_photos_count()
    return _fast_json({"tags": tags, "untagged_count": untagged_count, "total_count": total_count})


@app.delete("/api/tags/{tag:path}")
def api_delete_tag(tag: str):
    """指定されたタグを全写真から一括削除する（子孫タグも含む）"""
    deleted_count = delete_tag(tag)
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
    success = create_tag_definition(req.tag)
    if not success:
        raise HTTPException(status_code=400, detail="タグ名が空です")
    return _fast_json({
        "status": "ok",
        "tag": req.tag.strip().strip("/"),
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
    """写真にタグを追加する"""
    success = add_tag_to_photo(photo_id, req.tag)
    return {"status": "ok", "photo_id": photo_id, "tag": req.tag, "success": success}


@app.delete("/api/photo/{photo_id}/tags/{tag:path}")
def api_remove_tag(photo_id: int, tag: str):
    """写真からタグを削除する"""
    success = remove_tag_from_photo(photo_id, tag)
    return {"status": "ok", "photo_id": photo_id, "tag": tag, "success": success}


class BatchTagRequest(BaseModel):
    photo_ids: List[int]
    tag: str
    action: str = "add"  # "add" または "remove"


class BatchRateRequest(BaseModel):
    photo_ids: List[int]
    rating: int


@app.post("/api/photos/batch-tags")
def api_batch_tags(req: BatchTagRequest):
    """複数の写真に一括でタグを追加または削除する（マルチ選択用）"""
    if req.action == "remove":
        affected = batch_remove_tag(req.photo_ids, req.tag)
    else:
        affected = batch_add_tag(req.photo_ids, req.tag)
    return {"status": "ok", "affected": affected, "tag": req.tag, "action": req.action}


@app.post("/api/photos/batch-rate")
def api_batch_rate(req: BatchRateRequest):
    """複数の写真の星評価を一括更新する"""
    if req.rating not in (-1, 0, 1, 2):
        raise HTTPException(status_code=400, detail="評価値は -1(棄) / 0(可) / 1(良) / 2(優) のいずれかです")
    affected = batch_update_rating(req.photo_ids, req.rating)
    return {"status": "ok", "affected": affected, "rating": req.rating}


class BatchDeleteRequest(BaseModel):
    photo_ids: List[int]


@app.post("/api/photos/batch-delete")
def api_batch_delete(req: BatchDeleteRequest):
    """複数の写真をライブラリ（DB）から一括削除する（実ファイルは削除しない）"""
    if not req.photo_ids:
        raise HTTPException(status_code=400, detail="削除対象が指定されていません")
    deleted = delete_photos_by_ids(req.photo_ids)
    return {"status": "ok", "deleted": deleted}


# ==============================================================================
# AI 自動タグ付け機能 (CLIP INT8 Vision)
# ==============================================================================

@app.get("/api/ai/status")
def api_ai_status():
    """AIモデルの状態および実行中ジョブの進捗を取得する"""
    from .ai import get_ai_worker
    worker = get_ai_worker()
    return worker.get_status()


@app.post("/api/ai/tag-folder")
def api_ai_tag_folder(req: AITagFolderRequest):
    """指定フォルダ（または全未処理写真）のAI自動タグ付けジョブを開始する"""
    from .ai import get_ai_worker
    worker = get_ai_worker()
    success = worker.start_tagging(folder_path=req.folder_path, force_retag=req.force_retag)
    if not success:
        return {"status": "busy", "message": "他のAIタグ付けジョブが実行中です"}
    return {"status": "ok", "message": "AIタグ付けジョブを開始しました"}


@app.post("/api/ai/cancel")
def api_ai_cancel():
    """実行中のAIタグ付けジョブをキャンセルする"""
    from .ai import get_ai_worker
    worker = get_ai_worker()
    worker.cancel()
    return {"status": "ok", "message": "キャンセルを要求しました"}


@app.post("/api/ai/tag-photo/{photo_id}")
def api_ai_tag_single_photo(photo_id: int):
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

    from .ai import get_ai_tagger
    from .database import add_ai_tags_to_photo, get_photo_tags_details
    tagger = get_ai_tagger()
    matches = tagger.predict_from_bytes(thumb_bytes, top_k=3)
    if matches:
        add_ai_tags_to_photo(photo_id, matches)

    updated_tags = get_photo_tags_details(photo_id)
    return {"status": "ok", "photo_id": photo_id, "predicted": matches, "tags": updated_tags}


@app.post("/api/ai/promote-tag")
def api_ai_promote_tag(req: AIPromoteTagRequest):
    """AIタグを手動タグに昇格（確定）する"""
    from .database import promote_ai_tag
    success = promote_ai_tag(req.photo_id, req.tag)
    return {"status": "ok", "photo_id": req.photo_id, "tag": req.tag, "success": success}


@app.delete("/api/ai/tags")
def api_ai_clear_tags(photo_id: Optional[int] = None, folder_path: Optional[str] = None):
    """AIタグのみを一括削除する（手動タグは保護）"""
    from .database import remove_ai_tags
    deleted_count = remove_ai_tags(photo_id=photo_id, folder_path=folder_path)
    return {"status": "ok", "deleted_count": deleted_count}


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
    try:
        refresh_photo_thumbnail_transform(photo_id)
    except Exception as e:
        logger.warning(f"調整後のサムネイル更新に失敗 ({photo_id}): {e}")
    return {"status": "ok", "photo_id": photo_id}


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

    # ETagにファイルパスを含めてDB再構築時のID衝突を防止
    # file_mtime, rotation, fine_angle, crop_*, トーン微調整値も含め、編集後も 304 で古いサムネイルが返らないようにする
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
    etag_val = f'"{photo_id}-{path_hash}-{photo.get("file_size", 0)}-{mtime_part}-r{rot_part}-fa{fa_part}-c{cx_part}_{cy_part}_{cw_part}_{ch_part}-t{b_part}_{ct_part}_{s_part}"'

    # If-None-Match と ETag が一致した場合は 304 Not Modified（本文なし）を返す
    if_none_match = request.headers.get("if-none-match")
    if if_none_match and (if_none_match == etag_val or etag_val in [t.strip() for t in if_none_match.split(",")]):
        return Response(
            status_code=304,
            headers={
                "Cache-Control": "public, max-age=86400",
                "ETag": etag_val,
            },
        )

    # 1. 既存サムネイルBLOBを直引き
    thumb = db_get_thumbnail(photo_id)
    if thumb:
        return Response(
            content=thumb["data"],
            media_type="image/webp",
            headers={
                "Cache-Control": "public, max-age=86400",
                "ETag": etag_val,
            },
        )

    # 2. キャッシュ未生成時のみ元画像からオンデマンド生成
    try:
        thumb_data = ensure_thumbnail(photo["id"], photo["file_path"])
        return Response(
            content=thumb_data,
            media_type="image/webp",
            headers={
                "Cache-Control": "public, max-age=86400",
                "ETag": etag_val,
            },
        )
    except Exception as e:
        # サムネイル生成に失敗した場合（オフライン・一時的読み込みエラー等）、500エラーではなくプレースホルダーを返す
        from .scanner import get_ondemand_placeholder_webp
        return Response(
            content=get_ondemand_placeholder_webp(),
            media_type="image/webp",
            headers={
                "Cache-Control": "no-cache",
                "X-Thumbnail-Error": "true",
            },
        )


@app.get("/api/photo/{photo_id}/view")
def api_get_photo_view(photo_id: int, request: Request, raw: int = Query(default=0)):
    """
    実画像ファイルを配信する（拡大プレビュー用・RAWは埋め込み高解像度プレビュー・オフライン時はDB内サムネイルをスマートプレビュー配信）。
    raw=1 の場合は調整モーダル用に未加工の元画像を返し、
    raw=0 かつ非破壊調整（クロップ・水平傾き補正・トーン調整）がある場合はオンザフライで調整反映済みJPEGを返す。
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
        has_crop or abs(fa_val) > 0.01 or b_val != 0 or ct_val != 0 or s_val != 0
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

    # If-None-Match と ETag が一致した場合は 304 Not Modified（即時返却）
    if_none_match = request.headers.get("if-none-match")
    if if_none_match and (if_none_match == etag_val or etag_val in [t.strip() for t in if_none_match.split(",")]):
        return Response(
            status_code=304,
            headers={
                "Cache-Control": "public, max-age=86400",
                "ETag": etag_val,
            },
        )

    target_path, is_online = resolve_portable_path(photo["file_path"])
    if is_online and target_path.exists():
        # 非破壊調整（クロップ・水平出し・トーン微調整）が有効かつ raw=0 の場合はPillowで適用して返却
        if has_baked_adjustments:
            try:
                pil_img = None
                if photo.get("is_raw") or is_raw_file(target_path):
                    preview_res = extract_raw_full_preview(target_path)
                    if preview_res:
                        img_bytes, _, _, _ = preview_res
                        pil_img = _Image.open(_io.BytesIO(img_bytes))
                else:
                    pil_img = _Image.open(target_path)
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
                        },
                    )
            except Exception as e:
                logger.warning(f"拡大プレビューへの非破壊調整適用失敗 ({target_path}): {e}")

        # RAWファイルはブラウザが直接デコードできないため、カメラ内現像済みの埋め込みフルサイズプレビュー（JPEG）を抽出して配信
        if photo.get("is_raw") or is_raw_file(target_path):
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
                        },
                    )
            except Exception as e:
                logger.warning(f"RAWフルサイズプレビュー抽出失敗 ({target_path}): {e}")

            # フルサイズプレビューが取得できなかった場合のフォールバック: DBサムネイル
            try:
                thumb_data = ensure_thumbnail(photo["id"], photo["file_path"])
                return Response(
                    content=thumb_data,
                    media_type="image/webp",
                    headers={
                        "Cache-Control": "no-cache, must-revalidate",
                        "ETag": etag_val,
                    },
                )
            except Exception as e:
                logger.debug(f"調整適用プレビュー生成失敗、スマートプレビューへフォールバック (id={photo_id}): {e}")
        else:
            return FileResponse(
                str(target_path),
                headers={
                    "Cache-Control": "no-cache, must-revalidate",
                    "ETag": etag_val,
                },
            )

    # オフライン時（USB持出で元ドライブ未接続など）または実ファイル取得失敗時はDB内サムネイルをスマートプレビューとしてフォールバック配信
    thumb = db_get_thumbnail(photo_id)
    if thumb:
        return Response(
            content=thumb["data"],
            media_type="image/webp",
            headers={"X-Photo-Offline": "true", "ETag": etag_val},
        )

    # サムネイルもない場合はプレースホルダーWebPを返して404を回避
    from .scanner import get_ondemand_placeholder_webp
    return Response(
        content=get_ondemand_placeholder_webp(),
        media_type="image/webp",
        headers={"X-Photo-Offline": "true", "X-Photo-Missing": "true"},
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
            target_path, is_online = resolve_portable_path(file_path_str)
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
                allow_cloud_download=False,
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
            return pid, True
        except Exception as e:
            logger.error(f"サムネイル再生成エラー (ID: {pid}): {e}")
            return pid, False

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
            future_to_id = {executor.submit(_process_one, b): b["id"] for b in target_briefs}
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

    raw_path_str = photo.get("paired_raw_path")
    if not raw_path_str:
        raise HTTPException(status_code=404, detail="この写真にはRAWペアが存在しません")

    raw_path, is_online = resolve_portable_path(raw_path_str)
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

    target_path, is_online = resolve_portable_path(file_path_str)
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

    target_path, is_online = resolve_portable_path(file_path_str)
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

    return {"status": "ok", "photo_id": photo_id, "rating": req.rating}


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


@app.get("/api/photo/{photo_id}/gps-candidates")
def api_gps_candidates(photo_id: int, minutes: int = Query(default=60, ge=1, le=1440)):
    """指定写真の撮影時刻 ±N分（デフォルト60分）以内のGPS付き写真を候補として返す（直前・直後を分離）"""
    photo = get_photo_by_id(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    if not photo.get("date_taken"):
        return {"candidates": [], "before": None, "after": None}
    res = find_nearby_gps_photos(photo["date_taken"], minutes=minutes, exclude_id=photo_id)
    return res


@app.delete("/api/photo/{photo_id}/gps")
def api_delete_photo_gps(photo_id: int):
    """指定写真のSQLite上のジオタグ情報（緯度・経度・国・県・市）を削除する"""
    cleared = clear_photo_gps(photo_ids=[photo_id])
    if cleared == 0:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    return {"status": "ok", "photo_id": photo_id}


@app.post("/api/photo/{photo_id}/copy-gps")
def api_copy_gps(photo_id: int, req: CopyGpsRequest):
    """別の写真からGPSをコピーする"""
    source = get_photo_by_id(req.source_photo_id)
    if not source or source.get("latitude") is None:
        raise HTTPException(status_code=400, detail="コピー元の写真にGPS情報がありません")
    success = update_photo_gps(photo_id, source["latitude"], source["longitude"], "copied")
    if not success:
        raise HTTPException(status_code=404, detail="写真が見つかりません")
    return {"status": "ok", "photo_id": photo_id, "latitude": source["latitude"], "longitude": source["longitude"]}


@app.post("/api/photos/batch-copy-gps")
def api_batch_copy_gps(req: BatchCopyGpsRequest):
    """指定写真のGPSを複数の写真に一括コピーする"""
    count = batch_copy_gps(req.source_photo_id, req.target_ids)
    return {"status": "ok", "updated_count": count}


@app.post("/api/photos/batch-infer-gps")
def api_batch_infer_gps(req: BatchInferGpsRequest):
    """GPS情報のない写真に対して、撮影時刻が近いスマホ写真のGPSを一括準用する"""
    res = batch_infer_gps(photo_ids=req.photo_ids, folder=req.folder, max_minutes=req.max_minutes)
    return {"status": "ok", **res}


@app.post("/api/photos/clear-inferred-gps")
def api_clear_inferred_gps(req: ClearInferredGpsRequest):
    """準用されたGPS情報をクリアして元に戻す"""
    cleared = clear_inferred_gps(photo_ids=req.photo_ids, folder=req.folder)
    return {"status": "ok", "cleared_count": cleared}


@app.post("/api/photos/clear-gps")
def api_clear_gps(req: ClearGpsRequest):
    """指定写真（またはフォルダ内写真）のSQLite上のジオタグ情報（緯度・経度・地名）を一括削除する"""
    cleared = clear_photo_gps(photo_ids=req.photo_ids, folder=req.folder)
    return {"status": "ok", "cleared_count": cleared}


@app.post("/api/photos/cleanup-zero-gps")
def api_cleanup_zero_gps():
    """無効な(0, 0)のGPSエラーデータをSQLite上でクリーンアップする"""
    cleared = cleanup_invalid_zero_gps()
    return {"status": "ok", "cleared_count": cleared}


@app.post("/api/locations/backfill")
def api_backfill_locations(limit: int = Query(default=5000, ge=1, le=50000)):
    """既存のGPS付き写真（地名未設定）に対してローカル逆ジオコーディングを一括実行する"""
    count = backfill_photo_locations(limit=limit)
    return {"status": "ok", "updated_count": count}


@app.get("/api/locations/tree")
def api_get_locations_tree():
    """左ペイン表示用の国・都道府県・市区町村の階層ツリーと写真枚数を取得する"""
    data = get_location_tree_summary()
    return _fast_json(data)


@app.get("/api/locations/heatmap")
def api_get_locations_heatmap(
    date_filter: Optional[str] = None,
    date: Optional[str] = None,
):
    """ジオタグ47都道府県制覇マップ・ヒートマップ・撮影軌跡（フォトラリー）用の集計データを取得する"""
    target_date = date_filter or date
    data = get_location_heatmap_data(date_filter=target_date)
    return _fast_json(data)


@app.get("/api/lab/karte")
def api_get_lab_karte(today_mmdd: Optional[str] = None):
    """パーソナル撮影ラボ＆機材相性カルテ（歩留まりランキング・焦点距離/F値統計・太陽高度別枚数・時間帯分布）を取得する"""
    data = get_lab_karte_data(today_mmdd=today_mmdd)
    return _fast_json(data)


@app.get("/api/lab/random-unrated-folder")
def api_get_random_unrated_folder():
    """未整理（評価: 可）の写真が残っているフォルダをランダムに1つ抽選して返す（未整理フォルダ発掘ガチャ用）"""
    data = get_random_unrated_folder()
    return _fast_json(data)


@app.get("/api/timeline")
def api_get_timeline():
    """年・月ごとの写真枚数集計を取得する"""
    timeline = get_timeline_summary()
    return _fast_json({"timeline": timeline})


@app.get("/api/folders")
def api_get_folders():
    """フォルダごとの写真枚数集計を取得する（フラット一覧とスキャンルート階層ツリーの両方を提供）"""
    folders = get_folders_summary()
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
    """指定したフォルダの写真登録をDBから解除する（実ファイルは削除しない）"""
    try:
        result = remove_folder_photos(req.folder_path, recursive=req.recursive)
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
        return {"status": "ok", "folder_path": req.folder_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/folders/ignore")
def api_unignore_folder(req: FolderIgnoreRequest):
    """指定されたフォルダの除外設定を解除する（未管理状態に戻す）"""
    try:
        remove_ignored_folder(req.folder_path)
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


@app.post("/api/folders/check-diff")
def api_check_folder_diff(req: FolderDiffRequest):
    """フォルダ直下の実ファイルとDBレコードの高速差分（追加・削除・変更）を判定する"""
    try:
        target_path, is_online = resolve_portable_path(req.folder_path)
        if not is_online:
            return {"status": "ok", "has_changes": False, "is_offline": True, "added": 0, "deleted": 0, "modified": 0}
        diff = check_folder_diff(str(target_path))
        return {"status": "ok", **diff}
    except Exception as e:
        return {"status": "error", "has_changes": False, "detail": str(e), "added": 0, "deleted": 0, "modified": 0}


class FolderCleanupMissingRequest(BaseModel):
    folder_path: str
    recursive: bool = False


@app.post("/api/folders/cleanup-missing")
def api_cleanup_missing_folder_photos(req: FolderCleanupMissingRequest):
    """指定フォルダ配下の実ファイル消失写真をDBからクリーンアップ（登録解除）する"""
    try:
        cleaned = cleanup_missing_photos_in_folder(req.folder_path, recursive=req.recursive)
        return {"status": "ok", "cleaned": cleaned, "folder_path": req.folder_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class FolderUnlinkMissingRequest(BaseModel):
    folder_path: str
    recursive: bool = False


@app.post("/api/folders/unlink-missing")
def api_unlink_missing_folder_photos(req: FolderUnlinkMissingRequest):
    """
    指定フォルダ配下の実ファイル消失写真について、
    DBレコード（サムネイル・タグ含む）は保持したまま、実体パスとの紐付けを解除（リンク消失）する
    """
    try:
        unlinked = unlink_missing_photos_in_folder(req.folder_path, recursive=req.recursive)
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
        return {"status": "ok", "purged": purged}
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


@app.get("/api/volumes")
def api_get_volumes():
    """登録済みのボリューム一覧を取得する"""
    volumes = get_all_volumes()
    return {"volumes": volumes}


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
def api_folder_tree_roots():
    """フォルダツリー最上位（ショートカット・接続中ドライブ・未接続ボリューム）を返す"""
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
    return _fast_json(list_folder_tree_children(path, volume_serial, serial_mode, offline))


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


# ==============================================================================
# インポート（送る / ピックアップ）機能 (JPG限定)
# ==============================================================================

@app.get("/api/import/destinations")
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


@app.post("/api/import/folders")
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


@app.post("/api/import/copy")
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

        main_raw = photo.get("file_path")
        if main_raw:
            p_main, is_main_online = resolve_portable_path(main_raw)
            if is_main_online and p_main.suffix.lower() in (".jpg", ".jpeg"):
                src_path = p_main

        if not src_path:
            # RAW+JPG ペアの場合、ペアのJPG側を探す
            paired_raw = photo.get("paired_raw_path")
            if paired_raw:
                p_paired, is_paired_online = resolve_portable_path(paired_raw)
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
            shutil.copy2(src_path, target_file)
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


@app.post("/api/import/open")
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


@app.get("/api/scan/status")
def api_get_scan_status():
    """現在実行中のスキャン進捗状態を取得する"""
    return scan_tracker.get_status()


@app.post("/api/scan")
def api_scan_folder(req: ScanRequest):
    """指定されたフォルダをスキャンしてインデックスを更新する（指紋不一致時は403でブロック）"""
    try:
        result = scan_directory(req.folder_path, cleanup_orphans=req.cleanup_orphans, recursive=req.recursive)
        if getattr(req, "auto_ai_tag", False):
            from .ai import get_ai_worker
            get_ai_worker().start_tagging(folder_path=req.folder_path)
        return {"status": "ok", "result": result}
    except PermissionError as e:
        # 指紋不一致によるセキュリティブロック
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))




class PhotoUploadItem(BaseModel):
    filename: str
    content_base64: str


class PhotoUploadRequest(BaseModel):
    files: List[PhotoUploadItem]
    destination: Optional[str] = None
    target_folder: Optional[str] = None


@app.post("/api/upload")
def api_upload_photos(req: PhotoUploadRequest):
    """ブラウザからのドラッグ＆ドロップまたはファイル選択で直接 storage へ写真・付随サイドカーを追加する (Base64方式)"""
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    add_scan_root(str(STORAGE_DIR))

    dest_spec = req.destination or req.target_folder
    try:
        if not dest_spec or not str(dest_spec).strip():
            target_dir = STORAGE_DIR
        else:
            target_dir = resolve_storage_target_dir(dest_spec, must_exist=False)
        target_dir.mkdir(parents=True, exist_ok=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    saved_photos = []
    saved_sidecars = []
    errors = []

    # 第1パス: サイドカーファイル（.xmp, .pp3, .dop 等）を先に保存し、直後の画像 extract_metadata で参照可能にする
    photo_items: List[PhotoUploadItem] = []
    for item in req.files:
        if not item.filename:
            continue
        safe_name = Path(item.filename).name
        ext = Path(safe_name).suffix.lower()
        if is_sidecar_file(safe_name):
            clean_sc_name = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "_", safe_name).strip().rstrip(".")
            if not clean_sc_name:
                continue
            dest_sc_path = target_dir / clean_sc_name
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
            photo_items.append(item)
        else:
            errors.append(f"非対応形式: {item.filename}")

    # 第2パス: 画像本体の保存 & メタデータ抽出（付随XMPからのハードウェア補完含む）& DB登録
    for item in photo_items:
        safe_name = Path(item.filename).name
        ext = Path(safe_name).suffix.lower()
        clean_stem = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "_", Path(safe_name).stem).strip().rstrip(".") or "photo"
        dest_path = target_dir / f"{clean_stem}{ext}"
        # 同名ファイルがある場合はナンバリング
        counter = 1
        while dest_path.exists():
            dest_path = target_dir / f"{clean_stem}_{counter}{ext}"
            counter += 1

        try:
            # Base64ヘッダ（例: "data:image/jpeg;base64,"）を除去してデコード
            raw_b64 = item.content_base64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            file_bytes = base64.b64decode(raw_b64)

            with open(dest_path, "wb") as f:
                f.write(file_bytes)

            # メタデータ抽出 & DB登録
            meta = extract_metadata(dest_path)
            upsert_photo(meta)
            saved_photos.append(dest_path.name)
        except Exception as e:
            errors.append(f"{item.filename}: {str(e)}")

    if saved_photos:
        clear_folders_fs_cache()

    return {
        "status": "ok",
        "uploaded_count": len(saved_photos),
        "uploaded_sidecar_count": len(saved_sidecars),
        "files": saved_photos,
        "sidecar_files": saved_sidecars,
        "destination": str(target_dir),
        "folder": str(target_dir),
        "errors": errors,
    }


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


@app.get("/api/storage/folders")
def api_get_storage_folders():
    """storage 配下の全フォルダ階層と各フォルダの写真枚数を取得する"""
    try:
        return get_storage_folders()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/storage/folders")
def api_create_storage_folder(req: StorageCreateFolderRequest):
    """storage 内に新しいサブフォルダを作成する"""
    try:
        res = create_storage_subfolder(req.parent_path, req.folder_name)
        clear_folders_fs_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/storage/folders/rename")
def api_rename_storage_folder(req: StorageRenameFolderRequest):
    """storage 内のサブフォルダ名を変更し、DB内の写真パスも追従更新する"""
    try:
        res = rename_storage_subfolder(req.folder_path, req.new_name)
        clear_folders_fs_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/storage/folders")
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
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/storage/import-photos")
def api_import_photos_to_storage(req: StorageImportPhotosRequest):
    """選択された写真を storage の指定フォルダへ物理コピーし、メタデータ・タグ・評価・調整値を引き継いでDB登録する"""
    try:
        res = import_photos_to_storage(req.photo_ids, req.destination)
        clear_folders_fs_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/storage/move-photos")
def api_move_photos_in_storage(req: StorageMovePhotosRequest):
    """storage 内の写真を別の storage フォルダへ移動し、DBパスを更新する"""
    try:
        res = move_photos_in_storage(req.photo_ids, req.destination)
        clear_folders_fs_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/storage/rename-photo")
def api_rename_photo_in_storage(req: StorageRenamePhotoRequest):
    """storage 内の単一写真のファイル名を変更する"""
    try:
        res = rename_photo_in_storage(req.photo_id, req.new_name)
        clear_folders_fs_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/storage/batch-rename-photos")
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
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/storage/export-folder")
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


@app.get("/api/duplicates")
def api_get_duplicates(limit: int = 100):
    """ライブラリ内の重複写真グループ一覧および品質スコアに基づく代表写真情報を高速取得する"""
    groups = get_all_duplicate_groups(limit=limit)
    return _fast_json(groups)


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


@app.get("/api/export/default-dir")
def api_get_default_export_dir():
    """テイクアウトの標準保存先パスを取得する"""
    return {"default_dir": str(DEFAULT_TAKEOUT_DIR)}


@app.post("/api/export/smart")
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


@app.post("/api/export/contact-sheet")
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


@app.post("/api/export/pick-folder")
def api_pick_export_folder(req: Optional[PickFolderRequest] = None):
    """Windows標準のフォルダ選択ダイアログを表示してパスを取得する"""
    init_dir = req.initial_dir if req else None
    selected = pick_folder_dialog(init_dir)
    return {"selected_path": selected}


@app.post("/api/export/open-folder")
def api_open_export_folder(req: OpenFolderRequest):
    """指定されたフォルダをWindowsエクスプローラーで開く"""
    p = Path(req.folder_path)
    ok = open_folder_in_windows_explorer(p)
    return {"status": "ok" if ok else "error"}


# -------------------------------------------------------------
# Android / モバイル専用ビューア & オフライン差分同期 API
# -------------------------------------------------------------

class MobileSyncChangeItem(BaseModel):
    photo_id: Optional[int] = None
    file_path: Optional[str] = None
    file_name: Optional[str] = None
    date_taken: Optional[str] = None
    rating: Optional[int] = None
    add_tags: Optional[List[str]] = None
    remove_tags: Optional[List[str]] = None


class MobileSyncImportRequest(BaseModel):
    changes: Optional[List[MobileSyncChangeItem]] = None
    use_detected_file: bool = False


def _find_detected_sync_file() -> Optional[Path]:
    """
    プロジェクト直下、cache 内、またはUSB親フォルダに置かれた mobile_sync*.json を探索する。
    Androidが重複保存時に自動付与する連番ファイル名 (mobile_sync (1).json 等) にも対応し、最新ファイルを返す。
    """
    search_dirs = [
        BASE_DIR,
        BASE_DIR / "cache",
        BASE_DIR / ".cache",
        BASE_DIR.parent,
    ]
    found: List[Path] = []
    for d in search_dirs:
        try:
            if not d.exists() or not d.is_dir():
                continue
            for p in d.glob("mobile_sync*.json"):
                if p.is_file() and not p.name.endswith(".applied") and p.stat().st_size > 0:
                    found.append(p)
        except Exception:
            continue
    if not found:
        return None
    found.sort(key=lambda x: x.stat().st_mtime, reverse=True)
    return found[0]


@app.get("/m", include_in_schema=False)
def mobile_app_entry():
    """スマートフォン専用画面 (mobile.html) を返すショートカットルート"""
    mobile_html = FRONTEND_DIR / "mobile.html"
    if mobile_html.exists():
        return FileResponse(
            mobile_html,
            media_type="text/html",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
    raise HTTPException(status_code=404, detail="mobile.html が見つかりません")


@app.get("/api/mobile/standalone", include_in_schema=False)
def api_mobile_standalone():
    """
    CSS・JS・sql.js(WASM)を1ファイルに完全内蔵したオフライン用単体HTML (PhotoManager_Mobile.html) を生成・配信する。
    スマートフォン本体やUSBメモリに保存しておくことで、PC電源OFF・圏外でもファイルアプリから直接起動できる。
    """
    out_path = ensure_standalone_mobile_html()
    if out_path and out_path.exists():
        return FileResponse(
            out_path,
            media_type="text/html; charset=utf-8",
            filename=STANDALONE_HTML_FILENAME,
            headers={
                "Content-Disposition": f'attachment; filename="{STANDALONE_HTML_FILENAME}"',
                "Cache-Control": "no-cache, no-store, must-revalidate",
            },
        )
    raise HTTPException(status_code=500, detail="単体モバイルHTMLの生成に失敗しました")


def _lan_mobile_url(ip: str, port: int) -> str:
    """LAN接続トークン付きのスマホ版URLを生成する（QRコード読み取り時に自動でCookie化される）"""
    return f"http://{ip}:{port}/m?{LAN_TOKEN_QUERY}={LAN_TOKEN}"


@app.get("/api/mobile/qr.svg", include_in_schema=False)
def api_mobile_qr_svg(request: Request, url: Optional[str] = None):
    """スマホ版 (/m) にアクセスするためのQRコードSVGを返す"""
    from .qr_svg import generate_qr_svg

    target_url = (url or "").strip()
    if not target_url:
        port = request.url.port or 8088
        ips = _detect_local_ip_addresses()
        target_url = _lan_mobile_url(ips[0], port) if ips else f"http://127.0.0.1:{port}/m"

    svg_str = generate_qr_svg(target_url)
    return Response(
        content=svg_str,
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/api/mobile/info")
def api_mobile_info(request: Request, enable_lan: int = Query(default=0)):
    """スマホ版 (/m) 接続用URL・QRコード情報、およびUSB内の未反映 mobile_sync.json の有無を返す"""
    import datetime

    port = request.url.port or 8088
    if enable_lan:
        ips = ensure_lan_listeners(app, port=port)
    else:
        ips = _detect_local_ip_addresses()
    urls = [_lan_mobile_url(ip, port) for ip in ips]
    if not urls:
        urls = [f"http://127.0.0.1:{port}/m"]
    primary_url = urls[0]

    sync_file = _find_detected_sync_file()
    detected_info = None
    if sync_file:
        try:
            with open(sync_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            changes_list = data.get("changes", []) if isinstance(data, dict) else []
            detected_info = {
                "file_path": str(sync_file),
                "file_name": sync_file.name,
                "exported_at": data.get("exported_at", "") if isinstance(data, dict) else "",
                "change_count": len(changes_list),
            }
        except Exception as e:
            logger.warning(f"mobile_sync.json の読み取りに失敗しました: {e}")

    last_applied_info = None
    applied_bak = BASE_DIR / "cache" / "mobile_sync.json.applied"
    if applied_bak.exists():
        try:
            with open(applied_bak, "r", encoding="utf-8") as f:
                bak_data = json.load(f)
            bak_changes = bak_data.get("changes", []) if isinstance(bak_data, dict) else []
            mtime_dt = datetime.datetime.fromtimestamp(applied_bak.stat().st_mtime)
            last_applied_info = {
                "exported_at": bak_data.get("exported_at", "") if isinstance(bak_data, dict) else "",
                "applied_at": mtime_dt.strftime("%Y-%m-%d %H:%M:%S"),
                "change_count": len(bak_changes),
            }
        except Exception as e:
            logger.debug(f"mobile_sync.json.applied の読み取りスキップ: {e}")

    db_path = BASE_DIR / "cache" / "library.db"
    db_size_mb = round(db_path.stat().st_size / (1024 * 1024), 2) if db_path.exists() else 0.0

    return {
        "mobile_urls": urls,
        "primary_url": primary_url,
        "local_preview_url": f"http://127.0.0.1:{port}/m",
        "standalone_filename": STANDALONE_HTML_FILENAME,
        "db_path": str(db_path),
        "db_size_mb": db_size_mb,
        "detected_sync_file": detected_info,
        "last_applied_sync": last_applied_info,
    }


def _sanitize_mobile_tag(raw_tag: Any) -> str:
    """モバイル同期データに含まれるタグ文字列を検証・無害化する（制御文字・HTMLタグ混入防止）"""
    if not raw_tag:
        return ""
    s = str(raw_tag).strip()
    # 制御文字やHTMLタグ記号(<, >)を除去し、最大100文字に制限
    s = re.sub(r"[\x00-\x1f\x7f<>\"'`]", "", s).strip()
    return s[:100]


def _apply_mobile_sync_changes(
    raw_changes: List[Dict[str, Any]],
    used_file: Optional[Path] = None,
) -> Dict[str, Any]:
    """モバイル選別差分リストをPC本体の library.db に適用する"""
    from .database.connection import get_connection

    if not raw_changes:
        return {
            "status": "ok",
            "applied_count": 0,
            "skipped_count": 0,
            "source_file": used_file.name if used_file else None,
            "applied_items": [],
        }

    applied_count = 0
    skipped_count = 0
    applied_items: List[Dict[str, Any]] = []

    with get_connection() as conn:
        cursor = conn.cursor()
        for item in raw_changes:
            if not isinstance(item, dict):
                continue
            target_id: Optional[int] = None
            matched_file_name: str = ""
            pid = item.get("photo_id")
            fpath = item.get("file_path")
            fname = item.get("file_name")
            dtaken = item.get("date_taken")

            # 1. photo_id (+ file_name) で照合
            if pid:
                if fname:
                    cursor.execute(
                        "SELECT id, file_name FROM photos WHERE id = ? AND file_name = ?",
                        (int(pid), str(fname)),
                    )
                else:
                    cursor.execute("SELECT id, file_name FROM photos WHERE id = ?", (int(pid),))
                row = cursor.fetchone()
                if row:
                    target_id = int(row["id"])
                    matched_file_name = str(row["file_name"] or "")

            # 2. file_path で照合
            if target_id is None and fpath:
                cursor.execute("SELECT id, file_name FROM photos WHERE file_path = ?", (str(fpath),))
                row = cursor.fetchone()
                if row:
                    target_id = int(row["id"])
                    matched_file_name = str(row["file_name"] or "")

            # 3. file_name + date_taken で照合（ドライブレター変動・再スキャン対策）
            if target_id is None and fname and dtaken:
                cursor.execute(
                    "SELECT id, file_name FROM photos WHERE file_name = ? AND date_taken = ? LIMIT 1",
                    (str(fname), str(dtaken)),
                )
                row = cursor.fetchone()
                if row:
                    target_id = int(row["id"])
                    matched_file_name = str(row["file_name"] or "")

            # 4. file_name 単体で照合（一意に特定できる場合のフォールバック）
            if target_id is None and fname:
                cursor.execute(
                    "SELECT id, file_name FROM photos WHERE file_name = ? LIMIT 2",
                    (str(fname),),
                )
                rows = cursor.fetchall()
                if len(rows) == 1:
                    target_id = int(rows[0]["id"])
                    matched_file_name = str(rows[0]["file_name"] or "")

            if target_id is None:
                skipped_count += 1
                continue

            # 評価の更新 (-1: 棄, 0: 可, 1: 良, 2: 優)
            rating_val = item.get("rating")
            applied_rating: Optional[int] = None
            if rating_val is not None:
                r_int = max(-1, min(2, int(rating_val)))
                update_rating(target_id, r_int)
                applied_rating = r_int

            # タグ削除（最大50件まで、サニタイズ済み文字列のみ）
            removed_tags: List[str] = []
            for r_tag in (item.get("remove_tags") or [])[:50]:
                clean_r_tag = _sanitize_mobile_tag(r_tag)
                if clean_r_tag:
                    remove_tag_from_photo(target_id, clean_r_tag)
                    removed_tags.append(clean_r_tag)

            # タグ追加（最大50件まで、サニタイズ済み文字列のみ）
            added_tags: List[str] = []
            for a_tag in (item.get("add_tags") or [])[:50]:
                clean_a_tag = _sanitize_mobile_tag(a_tag)
                if clean_a_tag:
                    add_tag_to_photo(target_id, clean_a_tag)
                    added_tags.append(clean_a_tag)

            applied_count += 1
            if len(applied_items) < 50:
                applied_items.append({
                    "photo_id": target_id,
                    "file_name": matched_file_name or str(fname or f"ID:{target_id}"),
                    "rating": applied_rating,
                    "add_tags": added_tags,
                    "remove_tags": removed_tags,
                })

        conn.commit()
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception as e:
            logger.debug(f"モバイル同期後のWALチェックポイントスキップ: {e}")

    # 自動検知ファイルを使用した場合は cache/mobile_sync.json.applied に退避して二重適用を防ぎ、USBルートを綺麗に保つ
    if used_file and used_file.exists():
        try:
            cache_dir = BASE_DIR / "cache"
            cache_dir.mkdir(parents=True, exist_ok=True)
            bak_path = cache_dir / "mobile_sync.json.applied"
            if bak_path.exists():
                bak_path.unlink()
            used_file.replace(bak_path)
        except Exception as e:
            logger.warning(f"適用済み mobile_sync.json の退避失敗: {e}")

    if applied_count > 0:
        _mobile_sync_event["seq"] += 1
        _mobile_sync_event["applied_count"] = applied_count

    return {
        "status": "ok",
        "applied_count": applied_count,
        "skipped_count": skipped_count,
        "source_file": used_file.name if used_file else None,
        "applied_items": applied_items,
    }


@app.post("/api/mobile/sync-import")
async def api_mobile_sync_import(request: Request):
    """
    スマートフォン（オフラインDBモード）で選別した評価・タグ差分 (mobile_sync.json) をPC本体の library.db に一括反映する。
    photo_id -> file_path -> (file_name + date_taken) の4段階フォールバックで確実に写真を特定する。
    """
    try:
        body_bytes = await request.body()
        body_data = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        req = MobileSyncImportRequest(**(body_data if isinstance(body_data, dict) else {}))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"リクエストデータの解析失敗: {e}")

    raw_changes: List[Dict[str, Any]] = []
    used_file: Optional[Path] = None

    if req.use_detected_file:
        used_file = _find_detected_sync_file()
        if not used_file:
            raise HTTPException(status_code=404, detail="mobile_sync.json が見つかりません")
        try:
            with open(used_file, "r", encoding="utf-8") as f:
                payload = json.load(f)
            raw_changes = payload.get("changes", []) if isinstance(payload, dict) else []
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"差分ファイルの読み込み失敗: {e}")
    elif req.changes:
        raw_changes = [
            c.model_dump() if hasattr(c, "model_dump") else c.dict()
            for c in req.changes
        ]

    return _apply_mobile_sync_changes(raw_changes, used_file=used_file)


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

