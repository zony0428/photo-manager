"""
スマートフォン内カメラフォルダから母艦 Loome\\case\\YYYY-MM-DD へのスマート転送 API ルーター

- POST /api/mobile/case-preflight : 転送前の重複照合（母艦DBに既存の写真は転送スキップ＋タグ・評価のみ反映）
- POST /api/mobile/case-upload    : 未登録写真の原本ストリーム受信・EXIF/GPS保持・日付別フォルダ収納・DB登録
"""

from datetime import datetime
import json
import logging
import os
from pathlib import Path
import re
import shutil
import threading
import time
from typing import Any, Dict, List, Optional, Set, Tuple
import uuid

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from ..database import (
    add_tag_to_photo,
    get_connection,
    update_rating,
    upsert_photo,
    upsert_volume,
)
from ..database.connection import bump_db_commit_seq
from ..database.folders import clear_folders_fs_cache, normalize_folder_path
from ..media_watcher import broadcast_app_event
from ..mobile_sync_apply import _sanitize_mobile_tag
from ..scanner import (
    SUPPORTED_EXTENSIONS,
    clear_online_cache,
    ensure_thumbnail,
    extract_metadata,
)
from ..security import (
    get_current_security_level,
    get_logical_file_size,
    is_app_locked,
    seal_loome_file,
)
from ..storage_manager import ensure_storage_dir, invalidate_loome_roots_cache
from ..volume_info import get_volume_info
from .common import clear_api_photos_cache

logger = logging.getLogger("photo_manager.mobile_case")

router = APIRouter()

# 1ファイルあたりの最大アップロードサイズ（150 MB: 高画素RAW・スマホProRAW等もカバー）
MAX_CASE_UPLOAD_BYTES = 150 * 1024 * 1024

_INVALID_FILENAME_CHARS_RE = re.compile(r'[\\/*?:"<>|\x00-\x1f]')
_DATE_PREFIX_RE = re.compile(r"^(\d{4})[-:](\d{2})[-:](\d{2})")

_case_upload_lock = threading.Lock()
_active_case_uploads: int = 0
_last_case_upload_ts: float = 0.0
_pending_case_imported_count: int = 0
_pending_case_applied_count: int = 0
_pending_case_last_info: Dict[str, Any] = {}
_pending_case_need_heavy_clear: bool = False
_pending_case_flush_timer: Optional[threading.Timer] = None
_CASE_FLUSH_DEBOUNCE_SEC = 1.0


def _mark_case_upload_activity() -> None:
    """スマホからの case 転送アクティビティ時刻を更新する"""
    global _last_case_upload_ts
    with _case_upload_lock:
        _last_case_upload_ts = time.time()


def is_case_upload_active(cooldown_sec: float = 12.0) -> bool:
    """スマホからの連続アップロード中（または完了直後のクールダウン中）かどうかを返す"""
    with _case_upload_lock:
        if _active_case_uploads > 0:
            return True
        if _last_case_upload_ts <= 0.0:
            return False
        return (time.time() - _last_case_upload_ts) < cooldown_sec


def _flush_case_post_import_events() -> None:
    """連続Uplink落ち着いた後に重いFS/オンラインキャッシュ無効化とSSE通知を1回に集約して実行する"""
    global _pending_case_imported_count, _pending_case_applied_count
    global _pending_case_last_info, _pending_case_need_heavy_clear, _pending_case_flush_timer

    with _case_upload_lock:
        if _active_case_uploads > 0:
            t = threading.Timer(_CASE_FLUSH_DEBOUNCE_SEC, _flush_case_post_import_events)
            t.daemon = True
            _pending_case_flush_timer = t
            t.start()
            return
        imp_cnt = _pending_case_imported_count
        app_cnt = _pending_case_applied_count
        last_info = dict(_pending_case_last_info)
        need_heavy = _pending_case_need_heavy_clear
        _pending_case_imported_count = 0
        _pending_case_applied_count = 0
        _pending_case_last_info = {}
        _pending_case_need_heavy_clear = False
        _pending_case_flush_timer = None

    if need_heavy:
        clear_folders_fs_cache()
        clear_online_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()

    if imp_cnt > 0 or app_cnt > 0:
        payload: Dict[str, Any] = {
            **last_info,
            "imported_count": imp_cnt,
            "applied_count": app_cnt,
        }
        broadcast_app_event("mobile_case_imported", payload)


def _schedule_case_post_import_flush(
    imported_inc: int = 0,
    applied_inc: int = 0,
    info: Optional[Dict[str, Any]] = None,
    need_heavy_clear: bool = False,
    created_new_folder: bool = False,
) -> None:
    """一覧レスポンスキャッシュは即時無効化し、重いFS走査キャッシュ消去とSSE配信はデバウンス集約する"""
    global _pending_case_imported_count, _pending_case_applied_count
    global _pending_case_last_info, _pending_case_need_heavy_clear, _pending_case_flush_timer

    if imported_inc > 0 or created_new_folder:
        bump_db_commit_seq()
    else:
        bump_db_commit_seq(("photos", "tags"))
    clear_api_photos_cache()
    if created_new_folder:
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()

    with _case_upload_lock:
        _pending_case_imported_count += int(imported_inc or 0)
        _pending_case_applied_count += int(applied_inc or 0)
        if info:
            _pending_case_last_info.update(info)
        if need_heavy_clear:
            _pending_case_need_heavy_clear = True
        if _pending_case_flush_timer is not None:
            _pending_case_flush_timer.cancel()
        t = threading.Timer(_CASE_FLUSH_DEBOUNCE_SEC, _flush_case_post_import_events)
        t.daemon = True
        _pending_case_flush_timer = t
        t.start()


class CasePreflightItem(BaseModel):
    client_id: str
    file_name: str
    file_size: int
    last_modified_ms: Optional[int] = 0
    date_taken: Optional[str] = None
    camera_model: Optional[str] = None
    content_hash: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    rating: Optional[int] = None
    tags: Optional[List[str]] = None


class CasePreflightRequest(BaseModel):
    items: List[CasePreflightItem] = []


def _sanitize_case_filename(raw_name: str) -> str:
    """スマホから渡されたファイル名を安全なベース名に正規化する"""
    base = os.path.basename(str(raw_name or "").replace("\\", "/")).strip()
    base = _INVALID_FILENAME_CHARS_RE.sub("_", base).strip(" .")
    if not base or base in {".", ".."}:
        return ""
    return base


def _norm_exif_dt(val: Any) -> str:
    """撮影日時文字列の先頭日付部 (YYYY:MM:DD) のコロンだけをハイフン (YYYY-MM-DD HH:MM:SS) に正規化する"""
    s = str(val or "").strip()
    if not s:
        return ""
    return (s[:10].replace(":", "-").replace("/", "-") + s[10:])[:19]


def _resolve_date_folder_and_taken_str(
    exif_date_taken: Optional[str],
    last_modified_ms: Optional[int],
) -> Tuple[str, Optional[str]]:
    """
    EXIF撮影日時またはスマホ側の最終更新ミリ秒から、
    保存先日付フォルダ名 (YYYY-MM-DD) とフォールバック撮影日時文字列を決定する。
    """
    if exif_date_taken:
        m = _DATE_PREFIX_RE.match(str(exif_date_taken).strip())
        if m:
            yyyy, mm, dd = m.group(1), m.group(2), m.group(3)
            if 1970 <= int(yyyy) <= 2100 and 1 <= int(mm) <= 12 and 1 <= int(dd) <= 31:
                norm_dt = _norm_exif_dt(exif_date_taken)
                return f"{yyyy}-{mm}-{dd}", norm_dt

    if last_modified_ms and int(last_modified_ms) > 0:
        try:
            dt = datetime.fromtimestamp(int(last_modified_ms) / 1000.0)
            if 1970 <= dt.year <= 2100:
                return dt.strftime("%Y-%m-%d"), dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

    now_dt = datetime.now()
    return now_dt.strftime("%Y-%m-%d"), now_dt.strftime("%Y-%m-%d %H:%M:%S")


def _apply_initial_rating_and_tags(
    photo_id: int,
    rating: Optional[int],
    tags: Optional[List[str]],
) -> bool:
    """対象写真IDへスマホ側で指定された評価・タグを適用する"""
    changed = False
    if rating is not None and int(rating) in (-1, 0, 1, 2) and int(rating) != 0:
        try:
            update_rating(photo_id, int(rating))
            changed = True
        except Exception as e:
            logger.warning(f"case転送時の評価反映スキップ (photo_id={photo_id}): {e}")

    if tags:
        for raw_tag in tags:
            clean_tag = _sanitize_mobile_tag(raw_tag)
            if clean_tag:
                try:
                    if add_tag_to_photo(photo_id, clean_tag):
                        changed = True
                except Exception as e:
                    logger.warning(f"case転送時のタグ反映スキップ (photo_id={photo_id}, tag={clean_tag}): {e}")
    return changed


_DUP_SUFFIX_RE = re.compile(r"(?:_\d+|\s*\(\d+\))$")


def _normalize_dup_filename(fn_low: str) -> str:
    """連番サフィックス (_1, (1) 等) を除いた正規化小文字ファイル名を返す"""
    base, ext = os.path.splitext(str(fn_low or "").strip().lower())
    norm_base = _DUP_SUFFIX_RE.sub("", base).strip()
    return f"{norm_base or base}{ext}"


def _find_existing_photos_by_name_and_size(
    candidates: List[Tuple[str, int]],
    date_size_candidates: Optional[List[Tuple[str, int]]] = None,
) -> Tuple[
    Dict[Tuple[str, int], int],
    Dict[Tuple[str, int], int],
    Dict[Tuple[str, str, int], int],
    Dict[Tuple[str, int], int],
]:
    """
    指定された file_size 集合に一致する母艦DB全体（Loome内外すべての photos / photo_links）の写真を一括取得し、
    1. (date_taken, camera_model_lower, file_size) -> photo_id
    2. (date_taken, file_size) -> photo_id
    3. (content_hash, file_size) -> photo_id  [Exifなし画像の中間バイトサンプリング一致]
    4. (file_name_lower, file_size) -> photo_id [フォールバック]
    の4辞書を返す。
    """
    result: Dict[Tuple[str, int], int] = {}
    date_result: Dict[Tuple[str, int], int] = {}
    dt_cam_result: Dict[Tuple[str, str, int], int] = {}
    hash_result: Dict[Tuple[str, int], int] = {}
    unique_sizes = sorted(
        {int(sz) for _, sz in candidates if int(sz or 0) > 0}
        | {int(sz) for _, sz in (date_size_candidates or []) if int(sz or 0) > 0}
    )
    if not unique_sizes:
        return result, date_result, dt_cam_result, hash_result

    with get_connection() as conn:
        cursor = conn.cursor()
        chunk_size = 400
        for i in range(0, len(unique_sizes), chunk_size):
            chunk = unique_sizes[i : i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            cursor.execute(
                f"""
                SELECT id, LOWER(file_name) AS fn_low, file_size, date_taken, original_date_taken,
                       LOWER(COALESCE(camera_model, '')) AS cam_low, COALESCE(content_key, '') AS ckey
                FROM photos
                WHERE is_unlinked = 0
                  AND file_size IN ({placeholders})
                """,
                chunk,
            )
            for row in cursor.fetchall():
                pid = int(row["id"])
                fn_low = str(row["fn_low"] or "")
                fsize = int(row["file_size"] or 0)
                cam_low = str(row["cam_low"] or "").strip()
                ckey = str(row["ckey"] or "").strip()
                if fn_low and fsize > 0:
                    result[(fn_low, fsize)] = pid
                    result.setdefault((_normalize_dup_filename(fn_low), fsize), pid)
                if ckey.startswith("hash:") and fsize > 0:
                    chash_part = ckey.split("|", 1)[0][5:].strip()
                    if chash_part:
                        hash_result.setdefault((chash_part, fsize), pid)
                for dt_col in ("date_taken", "original_date_taken"):
                    dt_val = _norm_exif_dt(row[dt_col])
                    if dt_val and fsize > 0:
                        date_result.setdefault((dt_val, fsize), pid)
                        if cam_low and cam_low not in ("不明", "raw写真"):
                            dt_cam_result.setdefault((dt_val, cam_low, fsize), pid)

            cursor.execute(
                f"""
                SELECT lk.photo_id, LOWER(lk.file_name) AS fn_low, p.file_size
                FROM photo_links lk
                JOIN photos p ON p.id = lk.photo_id
                WHERE p.is_unlinked = 0
                  AND p.file_size IN ({placeholders})
                """,
                chunk,
            )
            for row in cursor.fetchall():
                pid = int(row["photo_id"])
                fn_low = str(row["fn_low"] or "")
                fsize = int(row["file_size"] or 0)
                if fn_low and fsize > 0:
                    result.setdefault((fn_low, fsize), pid)
                    result.setdefault((_normalize_dup_filename(fn_low), fsize), pid)

    return result, date_result, dt_cam_result, hash_result


def _get_existing_photos_geo_info(photo_ids: Set[int]) -> Dict[int, Dict[str, Any]]:
    """指定された photo_id 集合の現在DB上の GPS・地域情報および case 配下かどうかを取得する"""
    info: Dict[int, Dict[str, Any]] = {}
    if not photo_ids:
        return info
    pids = sorted(int(x) for x in photo_ids if int(x or 0) > 0)
    if not pids:
        return info
    with get_connection() as conn:
        cursor = conn.cursor()
        chunk_size = 400
        for i in range(0, len(pids), chunk_size):
            chunk = pids[i : i + chunk_size]
            ph = ",".join("?" for _ in chunk)
            cursor.execute(
                f"""
                SELECT id, latitude, longitude, country, state, city, file_path
                FROM photos
                WHERE id IN ({ph})
                """,
                chunk,
            )
            for row in cursor.fetchall():
                pid = int(row["id"])
                lat = row["latitude"]
                lon = row["longitude"]
                raw_fp = str(row["file_path"] or "")
                fp = raw_fp.replace("/", "\\").lower()
                info[pid] = {
                    "has_gps": lat is not None and lon is not None,
                    "latitude": lat,
                    "longitude": lon,
                    "country": str(row["country"] or ""),
                    "state": str(row["state"] or ""),
                    "city": str(row["city"] or ""),
                    "in_case_dir": "\\case\\" in fp,
                    "raw_file_path": raw_fp,
                }
    return info


def _supplement_gps_into_meta(
    meta: Dict[str, Any],
    fallback_lat: Optional[float],
    fallback_lon: Optional[float],
) -> None:
    """ストリーム画像からGPSが取得できなかった場合、スマホ側から渡された座標と逆ジオコーディングで補完する"""
    if meta.get("latitude") is not None and meta.get("longitude") is not None:
        return
    if fallback_lat is None or fallback_lon is None:
        return
    try:
        lat_f = round(float(fallback_lat), 7)
        lon_f = round(float(fallback_lon), 7)
    except (ValueError, TypeError):
        return
    if abs(lat_f) < 0.0001 and abs(lon_f) < 0.0001:
        return
    meta["latitude"] = lat_f
    meta["longitude"] = lon_f
    meta["gps_source"] = meta.get("gps_source") or "exif"
    try:
        from ..geocoder import reverse_geocode

        loc = reverse_geocode(lat_f, lon_f)
        meta["country"] = loc.get("country")
        meta["state"] = loc.get("state")
        meta["city"] = loc.get("city")
    except Exception as e:
        logger.warning(f"case転送GPS補完時の逆ジオコーディング警告: {e}")


def _update_existing_photo_gps_if_missing(
    photo_id: int,
    lat: Optional[float],
    lon: Optional[float],
) -> Optional[Dict[str, Any]]:
    """既存写真のGPSが欠落している場合にスマホ側の座標でDBを更新し、逆ジオコーディング結果を返す"""
    if lat is None or lon is None:
        return None
    try:
        lat_f = round(float(lat), 7)
        lon_f = round(float(lon), 7)
    except (ValueError, TypeError):
        return None
    if abs(lat_f) < 0.0001 and abs(lon_f) < 0.0001:
        return None

    country, state, city = None, None, None
    try:
        from ..geocoder import reverse_geocode

        loc = reverse_geocode(lat_f, lon_f)
        country = loc.get("country")
        state = loc.get("state")
        city = loc.get("city")
    except Exception as e:
        logger.warning(f"既存写真GPS補完時の逆ジオコーディング警告 (photo_id={photo_id}): {e}")

    with get_connection() as conn:
        conn.execute(
            """
            UPDATE photos
            SET latitude = COALESCE(latitude, ?),
                longitude = COALESCE(longitude, ?),
                gps_source = COALESCE(gps_source, 'exif'),
                country = COALESCE(country, ?),
                state = COALESCE(state, ?),
                city = COALESCE(city, ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND (latitude IS NULL OR longitude IS NULL)
            """,
            (lat_f, lon_f, country, state, city, int(photo_id)),
        )
        conn.commit()
    return {
        "latitude": lat_f,
        "longitude": lon_f,
        "country": country or "",
        "state": state or "",
        "city": city or "",
    }


@router.post("/api/mobile/case-preflight")
def api_mobile_case_preflight(req: CasePreflightRequest):
    """
    スマホから母艦 Loome\\case へ写真を送る前のプリフライト重複照合エンドポイント。
    Loome内外を問わず母艦DBに既存の写真は本体転送をスキップさせ、
    スマホ側で付けた評価・タグがあればその既存写真へ即座に反映する。
    """
    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    items = req.items or []
    if not items:
        return {
            "ok": True,
            "upload_client_ids": [],
            "skipped_client_ids": [],
            "existing_photo_map": {},
            "applied_to_existing": 0,
        }

    lookup_pairs: List[Tuple[str, int]] = []
    date_pairs: List[Tuple[str, int]] = []
    for it in items:
        clean_name = _sanitize_case_filename(it.file_name)
        sz = int(it.file_size or 0)
        if clean_name and sz > 0:
            lookup_pairs.append((clean_name.lower(), sz))
        dt_str = _norm_exif_dt(it.date_taken)
        if dt_str and sz > 0:
            date_pairs.append((dt_str, sz))

    existing_map, existing_date_map, existing_dt_cam_map, existing_hash_map = (
        _find_existing_photos_by_name_and_size(lookup_pairs, date_pairs)
    )
    all_matched_pids = (
        set(existing_map.values())
        | set(existing_date_map.values())
        | set(existing_dt_cam_map.values())
        | set(existing_hash_map.values())
    )
    geo_info_map = _get_existing_photos_geo_info(all_matched_pids)

    upload_client_ids: List[str] = []
    skipped_client_ids: List[str] = []
    existing_photo_map: Dict[str, int] = {}
    existing_geo_map: Dict[str, Dict[str, Any]] = {}
    applied_count = 0

    for it in items:
        cid = str(it.client_id or "").strip()
        clean_name = _sanitize_case_filename(it.file_name)
        sz = int(it.file_size or 0)
        ext = os.path.splitext(clean_name)[1].lower()
        if not cid or not clean_name or sz <= 0 or ext not in SUPPORTED_EXTENSIONS:
            skipped_client_ids.append(cid)
            continue

        matched_pid: Optional[int] = None
        dt_norm = _norm_exif_dt(it.date_taken)
        cam_norm = str(it.camera_model or "").strip().lower()
        chash_norm = str(it.content_hash or "").strip()

        # 1. 最優先: 撮影日時 + 機材 + ファイルサイズ（ファイル名不問）
        if dt_norm and cam_norm:
            matched_pid = existing_dt_cam_map.get((dt_norm, cam_norm, sz))
        # 2. 撮影日時 + ファイルサイズ（メーカー名表記揺れ吸収・ファイル名不問）
        if not matched_pid and dt_norm:
            matched_pid = existing_date_map.get((dt_norm, sz))
        # 3. Exifなし画像の中間バイトサンプリングハッシュ + ファイルサイズ（ファイル名不問）
        if not matched_pid and chash_norm:
            matched_pid = existing_hash_map.get((chash_norm, sz))
        # 4. フォールバック: ファイル名 + ファイルサイズ
        if not matched_pid:
            fn_low = clean_name.lower()
            matched_pid = (
                existing_map.get((fn_low, sz))
                or existing_map.get((_normalize_dup_filename(fn_low), sz))
            )

        if matched_pid:
            existing_photo_map[cid] = matched_pid
            ginfo = geo_info_map.get(matched_pid) or {}
            client_has_gps = it.latitude is not None and it.longitude is not None

            # 以前GPSがOSによりストリップされた状態で case に保存された写真は、スマホ側にGPSがある場合に再アップロードして原本ファイル・DB双方を修復する
            if not ginfo.get("has_gps") and client_has_gps and ginfo.get("in_case_dir"):
                if _apply_initial_rating_and_tags(matched_pid, it.rating, it.tags):
                    applied_count += 1
                upload_client_ids.append(cid)
            else:
                if not ginfo.get("has_gps") and client_has_gps:
                    patched_geo = _update_existing_photo_gps_if_missing(matched_pid, it.latitude, it.longitude)
                    if patched_geo:
                        ginfo = {**ginfo, **patched_geo, "has_gps": True}
                        geo_info_map[matched_pid] = ginfo
                        applied_count += 1
                if ginfo.get("has_gps"):
                    existing_geo_map[cid] = {
                        "photo_id": matched_pid,
                        "latitude": ginfo.get("latitude"),
                        "longitude": ginfo.get("longitude"),
                        "country": ginfo.get("country") or "",
                        "state": ginfo.get("state") or "",
                        "city": ginfo.get("city") or "",
                    }
                skipped_client_ids.append(cid)
                if _apply_initial_rating_and_tags(matched_pid, it.rating, it.tags):
                    applied_count += 1
        else:
            upload_client_ids.append(cid)

    if upload_client_ids:
        _mark_case_upload_activity()

    if applied_count > 0:
        bump_db_commit_seq()
        clear_api_photos_cache()
        if not upload_client_ids:
            broadcast_app_event(
                "mobile_case_imported",
                {"applied_count": applied_count, "imported_count": 0},
            )

    return {
        "ok": True,
        "upload_client_ids": upload_client_ids,
        "skipped_client_ids": skipped_client_ids,
        "existing_photo_map": existing_photo_map,
        "existing_geo_map": existing_geo_map,
        "applied_to_existing": applied_count,
    }


def _pick_unique_case_dest(dest_dir: Path, stem: str, ext: str) -> Path:
    """既存ファイルを上書きしない未使用の連番ファイルパスを返す"""
    seq = 1
    while True:
        cand = dest_dir / f"{stem}_{seq}{ext}"
        if not cand.exists():
            return cand
        seq += 1


def _process_case_upload_sync(
    *,
    tmp_file: Path,
    total_written: int,
    clean_name: str,
    ext: str,
    last_modified_ms: int,
    rating: Optional[int],
    parsed_tags: List[str],
    lat: Optional[float],
    lon: Optional[float],
    case_root: Path,
) -> Dict[str, Any]:
    """ストリーム書き出し済みの一時ファイルをスレッドプール上でEXIF解析・重複照合・DB登録・サムネイル生成・Lv.2暗号化する"""
    # EXIF無し画像でも extract_metadata がスマホ上の元タイムスタンプを参照できるよう先に mtime を適用
    if last_modified_ms and int(last_modified_ms) > 0:
        try:
            mtime_sec = float(last_modified_ms) / 1000.0
            os.utime(tmp_file, (mtime_sec, mtime_sec))
        except Exception as ut_err:
            logger.debug(f"一時ファイルへの mtime 事前適用スキップ: {ut_err}")

    # 1. 実ファイルサイズ＆撮影日時＋機材（Exif無しはサンプリングハッシュ、最終フォールバックはファイル名）での重複チェック
    fn_low = clean_name.lower()
    existing_map, existing_date_map, existing_dt_cam_map, existing_hash_map = (
        _find_existing_photos_by_name_and_size([(fn_low, total_written)])
    )
    meta: Dict[str, Any] = extract_metadata(tmp_file)
    _supplement_gps_into_meta(meta, lat, lon)

    existing_pid = None
    if existing_map or existing_date_map or existing_dt_cam_map or existing_hash_map:
        exif_dt = _norm_exif_dt(meta.get("date_taken"))
        cam_low = str(meta.get("camera_model") or meta.get("camera_make") or "").strip().lower()
        chash = str(meta.get("content_hash") or "").strip().lower()
        if exif_dt and cam_low:
            existing_pid = existing_dt_cam_map.get((exif_dt, cam_low, total_written))
        if not existing_pid and exif_dt:
            existing_pid = existing_date_map.get((exif_dt, total_written))
        if not existing_pid and chash:
            existing_pid = existing_hash_map.get((chash, total_written))
        if not existing_pid:
            existing_pid = (
                existing_map.get((fn_low, total_written))
                or existing_map.get((_normalize_dup_filename(fn_low), total_written))
            )

    existing_case_target: Optional[Path] = None
    if existing_pid:
        ginfo = _get_existing_photos_geo_info({existing_pid}).get(existing_pid) or {}
        incoming_has_gps = meta.get("latitude") is not None and meta.get("longitude") is not None

        if ginfo.get("has_gps") or not incoming_has_gps:
            try:
                tmp_file.unlink(missing_ok=True)
            except Exception:
                pass
            changed_dup = _apply_initial_rating_and_tags(existing_pid, rating, parsed_tags)
            if changed_dup:
                _schedule_case_post_import_flush(
                    imported_inc=0,
                    applied_inc=1,
                    info={"photo_id": existing_pid},
                )
            else:
                bump_db_commit_seq(("photos", "tags"))
                clear_api_photos_cache()
            return {
                "ok": True,
                "status": "skipped_duplicate",
                "photo_id": existing_pid,
                "file_name": clean_name,
                "latitude": ginfo.get("latitude"),
                "longitude": ginfo.get("longitude"),
                "country": ginfo.get("country") or "",
                "state": ginfo.get("state") or "",
                "city": ginfo.get("city") or "",
            }

        # case 外（外付けドライブや通常管理フォルダ等）の既存写真にGPSを補完する場合は新規ファイル複製を行わずDBレコードのみ更新する
        if not ginfo.get("in_case_dir"):
            try:
                tmp_file.unlink(missing_ok=True)
            except Exception:
                pass
            patched_geo = _update_existing_photo_gps_if_missing(
                existing_pid,
                meta.get("latitude"),
                meta.get("longitude"),
            )
            changed_dup = _apply_initial_rating_and_tags(existing_pid, rating, parsed_tags)
            merged_geo = {**ginfo, **(patched_geo or {})}
            if patched_geo or changed_dup:
                _schedule_case_post_import_flush(
                    imported_inc=0,
                    applied_inc=1,
                    info={"photo_id": existing_pid},
                )
            else:
                bump_db_commit_seq(("photos", "tags"))
                clear_api_photos_cache()
            return {
                "ok": True,
                "status": "skipped_duplicate",
                "gps_updated": bool(patched_geo),
                "photo_id": existing_pid,
                "file_name": clean_name,
                "latitude": merged_geo.get("latitude"),
                "longitude": merged_geo.get("longitude"),
                "country": merged_geo.get("country") or "",
                "state": merged_geo.get("state") or "",
                "city": merged_geo.get("city") or "",
            }

        # 既存の Loome\case 配下ファイルのGPS欠落修復時は既存パスを優先特定する
        raw_existing_fp = str(ginfo.get("raw_file_path") or "").strip()
        if raw_existing_fp:
            try:
                cand_existing = Path(raw_existing_fp).resolve()
                cand_existing.relative_to(case_root.resolve())
                if cand_existing.is_file() and get_logical_file_size(cand_existing) == total_written:
                    existing_case_target = cand_existing
            except Exception:
                existing_case_target = None

    # 2. 保存先日付フォルダの決定
    date_folder, fallback_dt_str = _resolve_date_folder_and_taken_str(
        meta.get("date_taken"),
        last_modified_ms,
    )
    if not meta.get("date_taken") and fallback_dt_str:
        meta["date_taken"] = fallback_dt_str

    if existing_case_target is not None:
        dest_dir = existing_case_target.parent
        created_new_folder = False
        dest_file = existing_case_target
        date_folder = dest_dir.name
    else:
        dest_dir = case_root / date_folder
        created_new_folder = not dest_dir.exists()
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_dir / clean_name

    # 3. 保存先ファイルパスの決定（Lv.2 72Bフッター透過の論理サイズ一致時のみ同一ファイル更新、不一致・判定失敗時は必ず連番退避）
    stem, orig_ext = os.path.splitext(dest_file.name)
    keep_ext = orig_ext or ext
    if dest_file.exists():
        same_logical_size = False
        try:
            same_logical_size = get_logical_file_size(dest_file) == total_written
        except Exception as sz_err:
            logger.warning(f"既存 case ファイルの論理サイズ判定警告 ({dest_file}): {sz_err}")
            same_logical_size = False
        if not same_logical_size:
            dest_file = _pick_unique_case_dest(dest_dir, stem, keep_ext)
    shutil.move(str(tmp_file), str(dest_file))

    # スマホ上の元タイムスタンプを復元
    if last_modified_ms and int(last_modified_ms) > 0:
        try:
            mtime_sec = float(last_modified_ms) / 1000.0
            os.utime(dest_file, (mtime_sec, mtime_sec))
        except Exception:
            pass

    dest_norm = normalize_folder_path(str(dest_dir)).rstrip("\\/")
    file_norm = normalize_folder_path(str(dest_file))
    vol_info = get_volume_info(dest_norm)
    volume_serial = vol_info["serial"] if vol_info else None
    if vol_info and volume_serial:
        try:
            upsert_volume(vol_info["serial"], vol_info["label"], vol_info["drive"])
        except Exception:
            pass

    st = dest_file.stat()
    meta["file_path"] = file_norm
    meta["directory_path"] = dest_norm
    meta["file_name"] = dest_file.name
    meta["file_size"] = total_written
    meta["file_mtime"] = st.st_mtime
    meta["volume_serial"] = volume_serial

    # 4. DB登録 & WebPサムネイル生成（Lv.2カプセル化前にサムネイルを生成）
    photo_id = upsert_photo(meta)
    try:
        ensure_thumbnail(photo_id, file_norm)
    except Exception as th_err:
        logger.warning(f"case転送写真のサムネイル生成警告 ({file_norm}): {th_err}")

    # 5. スマホ側で付与された初期評価・タグの反映
    _apply_initial_rating_and_tags(photo_id, rating, parsed_tags)

    # 6. 母艦が Lv.2 (鍵付きカプセル化モード) の場合は TETHVLT1 暗号化を実行
    try:
        if get_current_security_level() == 2 and dest_file.exists():
            seal_loome_file(dest_file)
    except Exception as seal_err:
        logger.warning(f"case転送後のLv.2カプセル化警告 ({dest_file}): {seal_err}")

    rel_folder = f"case\\{date_folder}"
    _schedule_case_post_import_flush(
        imported_inc=1,
        applied_inc=0,
        info={
            "photo_id": photo_id,
            "file_name": dest_file.name,
            "rel_folder": rel_folder,
        },
        need_heavy_clear=True,
        created_new_folder=created_new_folder,
    )

    return {
        "ok": True,
        "status": "imported",
        "photo_id": photo_id,
        "file_name": dest_file.name,
        "date_folder": date_folder,
        "rel_folder": rel_folder,
        "rel_path": f"{rel_folder}\\{dest_file.name}",
        "latitude": meta.get("latitude"),
        "longitude": meta.get("longitude"),
        "country": meta.get("country") or "",
        "state": meta.get("state") or "",
        "city": meta.get("city") or meta.get("state") or "",
    }


@router.post("/api/mobile/case-upload")
async def api_mobile_case_upload(
    request: Request,
    file_name: str = Query(..., description="元ファイル名"),
    last_modified_ms: int = Query(default=0, description="スマホ上の最終更新日時(ms)"),
    rating: Optional[int] = Query(default=None, description="初期評価 (-1, 0, 1, 2)"),
    tags_json: str = Query(default="[]", description="初期付与タグのJSON配列"),
    lat: Optional[float] = Query(default=None, description="スマホ側で抽出した緯度フォールバック"),
    lon: Optional[float] = Query(default=None, description="スマホ側で抽出した経度フォールバック"),
):
    """
    スマホ内写真を1枚ストリーム受信し、Loome\\case\\YYYY-MM-DD\\ へ日付別に収納してDB登録する。
    EXIF/GPSを1ビットも欠落させずに保存し、逆ジオコーディング・WebPサムネイル生成・Lv.2暗号化まで自動実行する。
    """
    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    clean_name = _sanitize_case_filename(file_name)
    if not clean_name:
        raise HTTPException(status_code=400, detail="無効なファイル名です")

    ext = os.path.splitext(clean_name)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"未対応の画像形式です: {ext}")

    parsed_tags: List[str] = []
    if tags_json:
        try:
            raw_t = json.loads(tags_json)
            if isinstance(raw_t, list):
                parsed_tags = [str(x) for x in raw_t if x]
        except Exception:
            pass

    loome_root = ensure_storage_dir().resolve()
    case_root = loome_root / "case"
    case_root.mkdir(parents=True, exist_ok=True)

    tmp_file = case_root / f".tmp_upload_{uuid.uuid4().hex[:12]}{ext}"
    total_written = 0
    global _active_case_uploads, _last_case_upload_ts
    with _case_upload_lock:
        _active_case_uploads += 1
        _last_case_upload_ts = time.time()
    try:
        with open(tmp_file, "wb") as out_f:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total_written += len(chunk)
                if total_written > MAX_CASE_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="ファイルサイズが上限 (150MB) を超えています")
                out_f.write(chunk)

        if total_written <= 0:
            raise HTTPException(status_code=400, detail="空のファイルデータです")

        return await run_in_threadpool(
            _process_case_upload_sync,
            tmp_file=tmp_file,
            total_written=total_written,
            clean_name=clean_name,
            ext=ext,
            last_modified_ms=last_modified_ms,
            rating=rating,
            parsed_tags=parsed_tags,
            lat=lat,
            lon=lon,
            case_root=case_root,
        )
    finally:
        with _case_upload_lock:
            _active_case_uploads = max(0, _active_case_uploads - 1)
            _last_case_upload_ts = time.time()
        if tmp_file.exists():
            try:
                tmp_file.unlink(missing_ok=True)
            except Exception as rm_err:
                logger.debug(f"一時ファイル削除スキップ: {rm_err}")
