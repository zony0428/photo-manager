"""
Android / モバイル専用ビューア & オフライン差分同期 APIルーター
"""

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from ..lan_access import (
    LAN_TOKEN_COOKIE,
    LAN_TOKEN_QUERY,
    PAIRING_APPROVAL_TTL_SEC,
    approve_lan_pairing_ip,
    consume_lan_pairing_approval,
    detect_local_ip_addresses as _detect_local_ip_addresses,
    ensure_lan_listeners,
    extract_explicit_lan_token,
    get_lan_token,
    is_lan_device_paired,
    is_lan_pairing_approved_for,
    is_lan_token_valid,
    is_loopback_client,
    mark_lan_device_paired,
    reset_lan_pairing,
    resolve_request_client_host,
)
from ..media_watcher import broadcast_app_event
from ..mobile_bundle import (
    STANDALONE_HTML_FILENAME,
    ensure_mobile_ui_bundle_zip,
    ensure_standalone_mobile_html,
    find_prebuilt_android_apk,
    get_mobile_ui_bundle_info,
)
from ..mobile_sync_apply import (
    _sanitize_mobile_tag,
    _schedule_thumbnail_refresh,
    apply_mobile_sync_changes,
)
from .common import (
    BASE_DIR,
    FRONTEND_DIR,
    _require_localhost,
)

logger = logging.getLogger("photo_manager.app")

router = APIRouter()


# -------------------------------------------------------------
# Android / モバイル専用ビューア & オフライン差分同期 API
# -------------------------------------------------------------

class MobileSyncChangeItem(BaseModel):
    photo_id: Optional[int] = None
    content_key: Optional[str] = None
    file_path: Optional[str] = None
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    date_taken: Optional[str] = None
    rating: Optional[int] = None
    is_favorite: Optional[int] = None
    add_tags: Optional[List[str]] = None
    remove_tags: Optional[List[str]] = None
    add_tag_keys: Optional[Any] = None
    remove_tag_keys: Optional[Any] = None
    rotation: Optional[int] = None
    fine_angle: Optional[float] = None
    brightness: Optional[int] = None
    contrast: Optional[int] = None
    saturation: Optional[int] = None
    crop_x: Optional[float] = None
    crop_y: Optional[float] = None
    crop_w: Optional[float] = None
    crop_h: Optional[float] = None
    set_stack_primary: Optional[bool] = None
    adjustments: Optional[Dict[str, Any]] = None


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


@router.get("/m", include_in_schema=False)
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


@router.get("/api/mobile/standalone", include_in_schema=False)
def api_mobile_standalone():
    """
    CSS・JS・sql.js(WASM)を1ファイルに完全内蔵したオフライン用単体HTML (Tetheract_Mobile.html) を生成・配信する。
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


@router.get("/api/mobile/apk", include_in_schema=False)
def api_mobile_apk():
    """Android専用ネイティブアプリ (Tetheract_Android.apk) をWi-Fi経由で直接配信する"""
    apk_path = find_prebuilt_android_apk()
    if apk_path:
        return FileResponse(
            apk_path,
            media_type="application/vnd.android.package-archive",
            filename="Tetheract_Android.apk",
            headers={
                "Content-Disposition": 'attachment; filename="Tetheract_Android.apk"',
                "Cache-Control": "no-cache, no-store, must-revalidate",
            },
        )
    raise HTTPException(status_code=404, detail="Tetheract_Android.apk が見つかりません")


def _lan_mobile_url(ip: str, port: int) -> str:
    """LAN接続トークン付きのスマホ版URLを生成する（QRコード読み取り時に自動でCookie化される）"""
    return f"http://{ip}:{port}/m?{LAN_TOKEN_QUERY}={get_lan_token()}"


@router.get("/api/mobile/qr.svg", include_in_schema=False)
def api_mobile_qr_svg(request: Request, url: Optional[str] = None):
    """スマホ版 (/m) にアクセスするためのQRコードSVGを返す"""
    from ..qr_svg import generate_qr_svg

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


@router.get("/api/mobile/info")
def api_mobile_info(request: Request, enable_lan: int = Query(default=0)):
    """スマホ版 (/m) 接続用URL・QRコード情報、およびUSB内の未反映 mobile_sync.json の有無を返す（localhost専用）"""
    import datetime

    _require_localhost(request)
    port = request.url.port or 8088
    if enable_lan:
        mark_lan_device_paired(True)
        ips = ensure_lan_listeners(request.app, port=port)
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
        "persistent_pairing_enabled": is_lan_device_paired(),
    }


def _apply_mobile_sync_changes(
    raw_changes: List[Dict[str, Any]],
    used_file: Optional[Path] = None,
) -> Dict[str, Any]:
    """モバイル選別差分リストをPC本体の library.db に適用する"""
    return apply_mobile_sync_changes(
        raw_changes,
        used_file=used_file,
        schedule_thumb_refresh=_schedule_thumbnail_refresh,
    )


@router.post("/api/mobile/sync-import")
def api_mobile_sync_import(
    request: Request,
    payload: Optional[Dict[str, Any]] = Body(default=None),
):
    """
    スマートフォン（オフラインDBモード）で選別した評価・タグ差分 (mobile_sync.json) をPC本体の library.db に一括反映する。
    photo_id -> file_path -> (file_name + date_taken) の4段階フォールバックで確実に写真を特定する。
    """
    try:
        req = MobileSyncImportRequest(**(payload if isinstance(payload, dict) else {}))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"リクエストデータの解析失敗: {e}")

    raw_changes: List[Dict[str, Any]] = []
    used_file: Optional[Path] = None

    if req.use_detected_file:
        if not is_loopback_client(resolve_request_client_host(request)) or request.headers.get("origin") == "null":
            raise HTTPException(status_code=403, detail="ローカルファイル自動検出はPC本体画面からのみ実行できます")
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


@router.get("/api/mobile/pair-info")
def api_mobile_pair_info(request: Request):
    """
    スマートフォンでQRコード（/m?t=...）を開いた際、Androidネイティブアプリ（tetheract://pair）を
    ワンタップで起動してペアリング＆Wi-Fiロッカー同期するための接続情報を返す。
    """
    import urllib.parse
    from ..security import is_app_locked

    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    port = request.url.port or 8088
    host_hdr = (request.headers.get("host") or "").strip()
    if not host_hdr or host_hdr.startswith("127.0.0.1") or host_hdr.startswith("localhost"):
        ips = _detect_local_ip_addresses()
        server_url = f"http://{ips[0]}:{port}" if ips else f"http://127.0.0.1:{port}"
    else:
        server_url = f"http://{host_hdr}"

    current_tok = get_lan_token()
    mark_lan_device_paired(True)
    deep_link = (
        f"tetheract://pair?server={urllib.parse.quote(server_url, safe='')}"
        f"&token={urllib.parse.quote(current_tok, safe='')}"
    )
    return {
        "ok": True,
        "server_url": server_url,
        "token": current_tok,
        "deep_link": deep_link,
    }


@router.get("/api/mobile/discover")
def api_mobile_discover(
    request: Request,
    t: str = Query(default=""),
    request_pair: int = Query(default=0),
    device: str = Query(default=""),
    udp: int = Query(default=0),
):
    """
    同一Wi-Fi内のAndroidアプリがPC母艦を自動検出し、ペアリング状態の確認または接続要求を行うエンドポイント。
    - 既に有効なトークンを持っているか、承認済み client_ip からのTCP要求であればワンタイム消費で pair_token を返す。
    - UDP探索中継 (udp=1) では承認状態を消費せず、応答に秘密トークンを一切含めない。
    - 未ペアリング端末から request_pair=1 が送られた場合、PC画面へリアルタイム承認ダイアログを表示する。
    """
    import socket
    from ..database import get_or_create_library_id
    from ..security import is_app_locked

    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    client_host = resolve_request_client_host(request)
    cookie_tok = request.cookies.get(LAN_TOKEN_COOKIE)
    explicit_tok = (t or "").strip() or extract_explicit_lan_token(request)
    matched = is_lan_token_valid(cookie_tok, explicit_tok)
    is_udp_probe = bool(udp == 1)

    if matched:
        approved = False
    elif is_udp_probe:
        approved = is_lan_pairing_approved_for(client_host)
    else:
        approved = consume_lan_pairing_approval(client_host)

    hostname = socket.gethostname()
    port = request.url.port or 8088
    host_hdr = (request.headers.get("host") or "").strip()
    if not host_hdr or host_hdr.startswith("127.0.0.1") or host_hdr.startswith("localhost"):
        ips = _detect_local_ip_addresses()
        server_url = f"http://{ips[0]}:{port}" if ips else f"http://127.0.0.1:{port}"
    else:
        server_url = f"http://{host_hdr}"

    can_grant = bool(matched or approved)
    if not can_grant and request_pair == 1 and not is_udp_probe:
        clean_dev = re.sub(r"[\x00-\x1f\x7f<>\"'`]", "", str(device or "Android"))[:48].strip() or "Android"
        broadcast_app_event(
            "mobile_pair_requested",
            {
                "client_ip": client_host,
                "device": clean_dev,
            },
        )

    if can_grant and not is_udp_probe:
        mark_lan_device_paired(True)

    return {
        "ok": True,
        "service": "tetheract-pm",
        "library_id": get_or_create_library_id(),
        "hostname": hostname,
        "server_url": server_url,
        "paired_match": can_grant,
        "pair_token": get_lan_token() if (can_grant and not is_udp_probe) else "",
        "pairing_pending": bool(request_pair == 1 and not can_grant),
    }


class MobileApprovePairRequest(BaseModel):
    client_ip: Optional[str] = None


@router.post("/api/mobile/approve-pair")
def api_mobile_approve_pair(request: Request, req: MobileApprovePairRequest):
    """PC画面上の承認ダイアログから指定されたLANクライアントIPのみワンタイム許可する（localhost専用）"""
    _require_localhost(request)
    approved_ip = approve_lan_pairing_ip(req.client_ip, duration_sec=PAIRING_APPROVAL_TTL_SEC)
    if not approved_ip:
        raise HTTPException(status_code=400, detail="承認対象の有効なLANクライアントIPアドレスを指定してください")
    port = request.url.port or 8088
    mark_lan_device_paired(True)
    ensure_lan_listeners(request.app, port=port)
    return {
        "ok": True,
        "approved_ip": approved_ip,
        "expires_in_sec": PAIRING_APPROVAL_TTL_SEC,
    }


@router.post("/api/mobile/reset-pairing")
def api_mobile_reset_pairing(request: Request):
    """
    PCのスマホ連携ペアリング鍵（永続トークン・Cookie）を再発行し、
    既存のスマホに保存されているペアリング認証をリセットする（localhost専用）。
    """
    _require_localhost(request)
    new_tok = reset_lan_pairing()
    port = request.url.port or 8088
    ips = ensure_lan_listeners(request.app, port=port)
    urls = [_lan_mobile_url(ip, port) for ip in ips] or [f"http://127.0.0.1:{port}/m"]
    return {
        "ok": True,
        "token_rotated": True,
        "mobile_urls": urls,
        "primary_url": urls[0],
        "token_preview": new_tok[:6] + "...",
    }


@router.get("/api/mobile/locker-sync")
def api_mobile_locker_sync(
    mode: str = Query(default="status"),
    max_photo_id: int = Query(default=0),
    max_thumb_created_at: str = Query(default=""),
):
    """
    Androidアプリの専用ロッカーとPC母艦をローカルWi-Fi経由で高速同期するエンドポイント。
    - mode=status: PC側の library.db の更新時刻・サイズ・写真枚数を返す
    - mode=delta: スマホ側のウォーターマークを更新した上で軽量な mobile_delta.db を生成・配信する
    - mode=full: 初回ロッカー構築用に library.db 本体を配信する
    """
    from ..database import get_or_create_library_id, get_total_photos_count
    from ..database import connection as _db_conn
    from ..database.connection import get_connection
    from ..mobile_delta import LOCKER_STATE_PATH, ensure_mobile_delta_db, read_mobile_locker_state
    from ..security import get_security_status, is_app_locked

    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    db_path = _db_conn.DB_PATH
    if not db_path.exists():
        raise HTTPException(status_code=404, detail="library.db が見つかりません")

    clean_mode = (mode or "status").strip().lower()
    if clean_mode == "status":
        st = db_path.stat()
        wal_path = db_path.with_name(db_path.name + "-wal")
        wal_st = wal_path.stat() if wal_path.exists() else None
        eff_mtime = max(st.st_mtime, wal_st.st_mtime if wal_st else 0.0)
        eff_size = st.st_size + (wal_st.st_size if wal_st else 0)
        sec_st = get_security_status()
        ui_info = get_mobile_ui_bundle_info()
        return {
            "ok": True,
            "library_id": get_or_create_library_id(),
            "owner_id": str(sec_st.get("owner_id_full") or ""),
            "db_mtime": int(eff_mtime * 1000),
            "db_size": eff_size,
            "photo_count": get_total_photos_count(),
            "ui_revision": ui_info["ui_revision"],
            "native_revision": ui_info["native_revision"],
            "ui_mtime": ui_info["ui_mtime"],
            "ui_version": ui_info["ui_version"],
            "apk_available": bool(find_prebuilt_android_apk() is not None),
        }

    if clean_mode == "delta":
        cur_state = read_mobile_locker_state()
        cur_wm_id = int(cur_state.get("max_photo_id") or 0)
        cur_wm_created = str(cur_state.get("max_thumb_created_at") or "").strip()
        clean_created = str(max_thumb_created_at or "").strip()[:40]
        needs_wm_rebuild = bool(
            (max_photo_id > 0 and (cur_wm_id <= 0 or max_photo_id < cur_wm_id))
            or (clean_created and (not cur_wm_created or clean_created < cur_wm_created))
        )
        wm_changed = (
            (max_photo_id > 0 and cur_wm_id != int(max_photo_id))
            or (bool(clean_created) and clean_created != cur_wm_created)
        )
        if wm_changed:
            try:
                LOCKER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
                state_obj = {
                    "max_photo_id": int(max_photo_id) if max_photo_id > 0 else cur_wm_id,
                    "max_thumb_created_at": clean_created or cur_wm_created,
                    "synced_via": "wifi",
                }
                LOCKER_STATE_PATH.write_text(
                    json.dumps(state_obj, ensure_ascii=False),
                    encoding="utf-8",
                )
            except Exception as e:
                logger.debug(f"Wi-Fi同期ウォーターマーク保存スキップ: {e}")

        delta_path = ensure_mobile_delta_db(force=needs_wm_rebuild)
        if not delta_path or not delta_path.exists():
            raise HTTPException(status_code=500, detail="mobile_delta.db の生成に失敗しました")
        return FileResponse(
            delta_path,
            media_type="application/octet-stream",
            filename="mobile_delta.db",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    if clean_mode == "full":
        try:
            with get_connection() as conn:
                conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except Exception as e:
            logger.debug(f"フルDB配信前のWALチェックポイントスキップ: {e}")
        return FileResponse(
            db_path,
            media_type="application/octet-stream",
            filename="library.db",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )

    raise HTTPException(status_code=400, detail="無効な同期モードです")


@router.get("/api/mobile/connection-status")
def api_mobile_connection_status():
    """
    PC母艦における現在のボリューム・写真オンライン接続状況を軽量スナップショットとして返す。
    RAW+JPEGペアは代表JPEGの接続状況で判定し（RAWのみ未接続でもオンライン扱い）、
    配列サイズを最小化するため online_ids / offline_ids のうち少ない方を返却する。
    """
    import hashlib
    from ..database import get_or_create_library_id
    from ..database.connection import get_connection
    from ..scanner import _get_connected_drive_serial_map, resolve_drive_online_path
    from ..security import is_app_locked

    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    serial_to_drive, _ = _get_connected_drive_serial_map()
    online_volumes = sorted(serial_to_drive.keys())
    library_id = get_or_create_library_id()

    dir_online_memo: Dict[tuple, bool] = {}

    def _is_dir_online(dir_path: Optional[str], vsn: Optional[str]) -> bool:
        if not dir_path:
            return False
        v_clean = (vsn or "").strip() or None
        key = (dir_path, v_clean or "")
        cached = dir_online_memo.get(key)
        if cached is not None:
            return cached
        _, is_on = resolve_drive_online_path(dir_path, expected_serial=v_clean)
        res = bool(is_on)
        dir_online_memo[key] = res
        return res

    online_ids: List[int] = []
    offline_ids: List[int] = []
    multi_link_online: Dict[int, bool] = {}

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT pl.photo_id, pl.directory_path, pl.volume_serial
            FROM photo_links pl
            JOIN photos p ON p.id = pl.photo_id
            WHERE IFNULL(p.is_unlinked, 0) = 0
              AND COALESCE(p.link_count, 1) > 1
              AND NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')
            """
        )
        for lk in cur.fetchall():
            pid = int(lk[0])
            if multi_link_online.get(pid):
                continue
            if _is_dir_online(lk[1], lk[2]):
                multi_link_online[pid] = True
            elif pid not in multi_link_online:
                multi_link_online[pid] = False

        cur.execute(
            """
            SELECT id, directory_path, volume_serial, COALESCE(link_count, 1)
            FROM photos
            WHERE IFNULL(is_unlinked, 0) = 0
              AND NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL AND paired_raw_path != '')
            """
        )
        for row in cur.fetchall():
            pid = int(row[0])
            is_on = _is_dir_online(row[1], row[2])
            if not is_on and int(row[3] or 1) > 1:
                is_on = bool(multi_link_online.get(pid, False))
            if is_on:
                online_ids.append(pid)
            else:
                offline_ids.append(pid)

    if len(offline_ids) <= len(online_ids):
        mode = "offline_ids"
        ids = sorted(offline_ids)
    else:
        mode = "online_ids"
        ids = sorted(online_ids)

    rev_src = json.dumps(
        {"lib": library_id, "mode": mode, "ids": ids, "vols": online_volumes},
        separators=(",", ":"),
    ).encode("utf-8")
    revision = hashlib.sha1(rev_src).hexdigest()[:12]

    ui_info = get_mobile_ui_bundle_info()
    return {
        "ok": True,
        "library_id": library_id,
        "revision": revision,
        "mode": mode,
        "ids": ids,
        "online_volumes": online_volumes,
        "total_count": len(online_ids) + len(offline_ids),
        "online_count": len(online_ids),
        "offline_count": len(offline_ids),
        "ui_revision": ui_info["ui_revision"],
        "native_revision": ui_info["native_revision"],
        "ui_mtime": ui_info["ui_mtime"],
        "ui_version": ui_info["ui_version"],
        "apk_available": bool(find_prebuilt_android_apk() is not None),
    }


@router.get("/api/mobile/ui-bundle", include_in_schema=False)
def api_mobile_ui_bundle():
    """Androidアプリ向けのモバイルUIホットアップデート用バンドル (tetheract_ui_bundle.zip) を配信する"""
    from ..security import is_app_locked

    if is_app_locked():
        raise HTTPException(status_code=423, detail="アプリケーションはロックされています")

    bundle_path, ui_info = ensure_mobile_ui_bundle_zip()
    if not bundle_path or not bundle_path.exists():
        raise HTTPException(status_code=500, detail="UIバンドルの生成に失敗しました")

    return FileResponse(
        bundle_path,
        media_type="application/zip",
        filename="tetheract_ui_bundle.zip",
        headers={
            "Content-Disposition": 'attachment; filename="tetheract_ui_bundle.zip"',
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "X-Tetheract-Ui-Revision": str(ui_info.get("ui_revision") or ""),
        },
    )


from .mobile_case_router import router as _mobile_case_router

router.include_router(_mobile_case_router)

