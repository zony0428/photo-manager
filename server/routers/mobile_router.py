"""
Android / モバイル専用ビューア & オフライン差分同期 APIルーター
"""

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from ..database import (
    add_tag_to_photo,
    remove_tag_from_photo,
    resolve_tag_by_key_or_name,
    update_rating,
)
from ..database.folders import clear_folders_fs_cache
from ..lan_access import (
    LAN_TOKEN,
    LAN_TOKEN_QUERY,
    detect_local_ip_addresses as _detect_local_ip_addresses,
    ensure_lan_listeners,
)
from ..media_watcher import broadcast_app_event
from ..mobile_bundle import (
    STANDALONE_HTML_FILENAME,
    ensure_standalone_mobile_html,
)
from .common import (
    BASE_DIR,
    FRONTEND_DIR,
    _mobile_sync_event,
    clear_api_photos_cache,
)

logger = logging.getLogger("photo_manager.app")

router = APIRouter()


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
    add_tag_keys: Optional[Any] = None
    remove_tag_keys: Optional[Any] = None


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
    """スマホ版 (/m) 接続用URL・QRコード情報、およびUSB内の未反映 mobile_sync.json の有無を返す"""
    import datetime

    port = request.url.port or 8088
    if enable_lan:
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
    from ..database.connection import get_connection

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

            def _resolve_mobile_tags_list(raw_tags_val: Any, raw_keys_val: Any) -> List[str]:
                resolved_list: List[str] = []
                seen = set()

                def _push(t_str: str) -> None:
                    c = _sanitize_mobile_tag(t_str)
                    if c and c not in seen:
                        seen.add(c)
                        resolved_list.append(c)

                raw_tags_seq = list(raw_tags_val)[:50] if isinstance(raw_tags_val, list) else []
                if isinstance(raw_keys_val, dict):
                    # {"tk_xxx": "旧タグ名", ...} 形式
                    covered_fallbacks = set()
                    for k_str, fb_name in list(raw_keys_val.items())[:50]:
                        clean_k = _sanitize_mobile_tag(k_str)
                        clean_fb = _sanitize_mobile_tag(fb_name)
                        if clean_fb:
                            covered_fallbacks.add(clean_fb)
                        resolved_name = resolve_tag_by_key_or_name(cursor, clean_k, clean_fb)
                        if resolved_name:
                            _push(resolved_name)
                    for rt in raw_tags_seq:
                        clean_rt = _sanitize_mobile_tag(rt)
                        if clean_rt and clean_rt not in covered_fallbacks:
                            resolved_name = resolve_tag_by_key_or_name(
                                cursor,
                                clean_rt if clean_rt.startswith("tk_") else None,
                                clean_rt,
                            )
                            _push(resolved_name)
                elif isinstance(raw_keys_val, list) and raw_keys_val:
                    keys_seq = list(raw_keys_val)[:50]
                    max_len = max(len(raw_tags_seq), len(keys_seq))
                    for idx in range(max_len):
                        k_item = keys_seq[idx] if idx < len(keys_seq) else None
                        t_item = raw_tags_seq[idx] if idx < len(raw_tags_seq) else None
                        if isinstance(k_item, dict):
                            clean_k = _sanitize_mobile_tag(k_item.get("tag_key") or k_item.get("key"))
                            clean_fb = _sanitize_mobile_tag(k_item.get("tag") or t_item)
                        else:
                            clean_k = _sanitize_mobile_tag(k_item)
                            clean_fb = _sanitize_mobile_tag(t_item)
                        resolved_name = resolve_tag_by_key_or_name(cursor, clean_k, clean_fb)
                        if resolved_name:
                            _push(resolved_name)
                else:
                    for rt in raw_tags_seq:
                        clean_rt = _sanitize_mobile_tag(rt)
                        if clean_rt:
                            resolved_name = resolve_tag_by_key_or_name(
                                cursor,
                                clean_rt if clean_rt.startswith("tk_") else None,
                                clean_rt,
                            )
                            _push(resolved_name)
                return resolved_list

            # タグ削除（tag_key があればPC側の最新リネーム後パスへ解決して削除）
            removed_tags: List[str] = _resolve_mobile_tags_list(
                item.get("remove_tags"),
                item.get("remove_tag_keys"),
            )
            for clean_r_tag in removed_tags:
                remove_tag_from_photo(target_id, clean_r_tag)

            # タグ追加（tag_key があればPC側の最新リネーム後パスへ解決して追加）
            added_tags: List[str] = _resolve_mobile_tags_list(
                item.get("add_tags"),
                item.get("add_tag_keys"),
            )
            for clean_a_tag in added_tags:
                add_tag_to_photo(target_id, clean_a_tag)

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
        clear_folders_fs_cache()
        clear_api_photos_cache()
        broadcast_app_event(
            "mobile_synced",
            {"applied": applied_count, "seq": _mobile_sync_event["seq"]},
        )

    return {
        "status": "ok",
        "applied_count": applied_count,
        "skipped_count": skipped_count,
        "source_file": used_file.name if used_file else None,
        "applied_items": applied_items,
    }


@router.post("/api/mobile/sync-import")
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
