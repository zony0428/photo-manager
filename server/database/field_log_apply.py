"""
フィールドログ照合プレビュー・DB非破壊適用・バッチ履歴管理・Undo復元モジュール
"""

import json
import logging
import os
import re
import secrets
import threading
from datetime import date as _date_cls, datetime as _dt_cls, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from ..field_log_match import VALID_OVERWRITE_MODES, match_photos
from ..field_log_store import (
    BATCHES_DIR_NAME,
    DATE_RE,
    get_field_logs_root,
    list_available_log_dates,
    load_points_for_dates,
    validate_date_str,
    validate_device_id,
)
from ..geocoder import reverse_geocode
from .connection import bump_db_commit_seq, get_connection
from .photos import _directory_filter_sql_with_vsn, invalidate_fast_cache

logger = logging.getLogger("photo_manager.field_log_apply")

BATCH_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4,16}$")


def _get_batches_dir() -> Path:
    """バッチ履歴 JSON の保存ディレクトリを返す"""
    return get_field_logs_root() / BATCHES_DIR_NAME


def _resolve_safe_batch_file(batch_id: str) -> Path:
    """batch_id を検証し、安全なバッチ履歴ファイルパスを返す"""
    if not isinstance(batch_id, str):
        raise ValueError("batch_id が文字列ではありません")
    cleaned = batch_id.strip()
    if not BATCH_ID_RE.match(cleaned):
        raise ValueError(f"不正な batch_id 形式です: {batch_id!r}")
    batches_root = _get_batches_dir().resolve()
    target = (batches_root / f"{cleaned}.json").resolve()
    if target.parent != batches_root:
        raise ValueError("不正なバッチファイルパスです")
    return target


def _atomic_write_json(target_path: Path, payload: Dict[str, Any]) -> None:
    """辞書を UTF-8 JSON として一時ファイル経由でアトミック保存する"""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.parent / f".{target_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    try:
        with open(tmp_path, "wb") as f:
            f.write(data)
        os.replace(str(tmp_path), str(target_path))
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception as cleanup_err:
            logger.debug(f"バッチ一時ファイル削除スキップ ({tmp_path}): {cleanup_err}")
        raise


def _clear_all_photo_caches() -> None:
    """DB更新後にオンメモリキャッシュおよびAPIレスポンスキャッシュを一括クリアする"""
    bump_db_commit_seq()
    invalidate_fast_cache()
    try:
        from ..routers.common import clear_api_photos_cache
        clear_api_photos_cache()
    except Exception as e:
        logger.debug(f"APIキャッシュクリアスキップ: {e}")


def _extract_photo_date_str(date_taken: Any) -> Optional[str]:
    """date_taken 文字列の先頭から YYYY-MM-DD を安全に抽出する"""
    if not date_taken or not isinstance(date_taken, str):
        return None
    head = date_taken.strip()[:10].replace(":", "-").replace("/", "-")
    if not DATE_RE.match(head):
        return None
    try:
        _date_cls.fromisoformat(head)
        return head
    except ValueError:
        return None


def _normalize_date_list(
    date: Optional[str] = None,
    dates: Optional[List[str]] = None,
) -> List[str]:
    """単数 date と配列 dates を統合・検証して重複なし YYYY-MM-DD リストを返す"""
    raw_list: List[str] = []
    if date and str(date).strip():
        raw_list.append(str(date).strip())
    if dates:
        for d in dates:
            if d and str(d).strip():
                raw_list.append(str(d).strip())
    normalized: List[str] = []
    seen: Set[str] = set()
    for item in raw_list:
        dt_str = validate_date_str(item.replace(":", "-"))
        if dt_str not in seen:
            seen.add(dt_str)
            normalized.append(dt_str)
    return normalized


def query_target_photos_for_field_log(
    dates: Optional[List[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    folder: Optional[str] = None,
    volume_serial: Optional[str] = None,
    photo_ids: Optional[List[int]] = None,
    device_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    フィールドログ照合の対象となる写真を SQL の WHERE 句で絞り込んで取得する（全件取得禁止）。
    すべてのフィルタが省略された場合は、保存済みフィールドログが存在する日付（±1日）で絞り込む。
    """
    if device_id:
        validate_device_id(device_id)

    norm_dates = _normalize_date_list(dates=dates)
    norm_from = validate_date_str(date_from.strip().replace(":", "-")) if (date_from and date_from.strip()) else None
    norm_to = validate_date_str(date_to.strip().replace(":", "-")) if (date_to and date_to.strip()) else None
    clean_folder = folder.strip() if (folder and folder.strip()) else None

    clean_ids: Optional[List[int]] = None
    if photo_ids is not None:
        clean_ids = []
        seen_ids: Set[int] = set()
        for pid in photo_ids:
            if pid is None or isinstance(pid, bool):
                continue
            p_int = int(pid)
            if p_int not in seen_ids:
                seen_ids.add(p_int)
                clean_ids.append(p_int)
        if not clean_ids:
            return []

    # フィルタ無指定時は、保存されているフィールドログの日付（および前後1日）に限定して WHERE 句を構築する
    if clean_ids is None and not clean_folder and not norm_dates and not norm_from and not norm_to:
        avail_dates = list_available_log_dates(device_id=device_id)
        if not avail_dates:
            return []
        expanded: Set[str] = set()
        for d_str in avail_dates:
            d_obj = _date_cls.fromisoformat(d_str)
            expanded.add((d_obj - timedelta(days=1)).isoformat())
            expanded.add(d_obj.isoformat())
            expanded.add((d_obj + timedelta(days=1)).isoformat())
        norm_dates = sorted(expanded)

    base_clauses: List[str] = ["COALESCE(p.is_unlinked, 0) = 0"]
    base_params: List[Any] = []

    if clean_ids is None:
        base_clauses.append("NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')")

    if clean_folder:
        dir_sql_p, dir_params_p = _directory_filter_sql_with_vsn(
            clean_folder,
            volume_serial=volume_serial,
            recursive=True,
            column_name="p.directory_path",
            vsn_column="p.volume_serial",
        )
        dir_sql_pl, dir_params_pl = _directory_filter_sql_with_vsn(
            clean_folder,
            volume_serial=volume_serial,
            recursive=True,
            column_name="pl.directory_path",
            vsn_column="pl.volume_serial",
        )
        base_clauses.append(
            f"({dir_sql_p} OR EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id AND {dir_sql_pl}))"
        )
        base_params.extend(dir_params_p + dir_params_pl)

    date_expr = "SUBSTR(REPLACE(p.date_taken, ':', '-'), 1, 10)"
    if norm_from:
        base_clauses.append(f"(p.date_taken IS NOT NULL AND {date_expr} >= ?)")
        base_params.append(norm_from)
    if norm_to:
        base_clauses.append(f"(p.date_taken IS NOT NULL AND {date_expr} <= ?)")
        base_params.append(norm_to)

    select_cols = (
        "SELECT p.id, p.file_name, p.directory_path, p.date_taken, p.camera_model, "
        "p.latitude, p.longitude, p.gps_source, p.country, p.state, p.city FROM photos p"
    )

    rows: List[Dict[str, Any]] = []
    with get_connection() as conn:
        cursor = conn.cursor()
        if clean_ids is not None:
            # photo_ids 指定時は 500 件ずつチャンク実行する
            date_clause = ""
            date_params: List[Any] = []
            if norm_dates:
                d_ph = ",".join(["?"] * len(norm_dates))
                date_clause = f" AND (p.date_taken IS NOT NULL AND {date_expr} IN ({d_ph}))"
                date_params = list(norm_dates)
            where_prefix = " AND ".join(base_clauses)
            for i in range(0, len(clean_ids), 500):
                chunk = clean_ids[i:i + 500]
                id_ph = ",".join(["?"] * len(chunk))
                sql = f"{select_cols} WHERE {where_prefix}{date_clause} AND p.id IN ({id_ph})"
                cursor.execute(sql, base_params + date_params + chunk)
                rows.extend(dict(r) for r in cursor.fetchall())
        elif norm_dates:
            where_prefix = " AND ".join(base_clauses)
            for i in range(0, len(norm_dates), 400):
                d_chunk = norm_dates[i:i + 400]
                d_ph = ",".join(["?"] * len(d_chunk))
                sql = f"{select_cols} WHERE {where_prefix} AND (p.date_taken IS NOT NULL AND {date_expr} IN ({d_ph}))"
                cursor.execute(sql, base_params + d_chunk)
                rows.extend(dict(r) for r in cursor.fetchall())
        else:
            where_str = " AND ".join(base_clauses)
            sql = f"{select_cols} WHERE {where_str}"
            cursor.execute(sql, base_params)
            rows.extend(dict(r) for r in cursor.fetchall())

    rows.sort(key=lambda r: (str(r.get("date_taken") or ""), int(r["id"])))
    return rows


def _collect_lookup_dates_for_photos(
    photos: List[Dict[str, Any]],
    explicit_dates: Optional[List[str]] = None,
    camera_offsets: Optional[Dict[str, int]] = None,
) -> List[str]:
    """対象写真の撮影日（および大きなカメラ時計補正がある場合は補正後の日）からログ読込対象日を集める"""
    date_set: Set[str] = set(explicit_dates or [])
    max_shift_days = 0
    if camera_offsets:
        max_abs_sec = max((abs(int(v)) for v in camera_offsets.values() if v is not None), default=0)
        if max_abs_sec > 0:
            max_shift_days = (max_abs_sec // 86400) + 1

    for p in photos:
        d_str = _extract_photo_date_str(p.get("date_taken"))
        if d_str:
            date_set.add(d_str)
            if max_shift_days > 0:
                d_obj = _date_cls.fromisoformat(d_str)
                for delta in range(-max_shift_days, max_shift_days + 1):
                    date_set.add((d_obj + timedelta(days=delta)).isoformat())
    return sorted(date_set)


def _compute_matches_from_params(
    device_id: Optional[str] = None,
    date: Optional[str] = None,
    dates: Optional[List[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    folder: Optional[str] = None,
    volume_serial: Optional[str] = None,
    photo_ids: Optional[List[int]] = None,
    camera_offsets: Optional[Dict[str, int]] = None,
    max_gap_sec: int = 300,
    max_nearest_sec: int = 120,
    overwrite: str = "missing_only",
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Any], List[str]]:
    """対象写真の取得・ログ点の読み込み・match_photos 実行を共通化する内部ヘルパー"""
    if overwrite not in VALID_OVERWRITE_MODES:
        raise ValueError(f"不正な overwrite モードです: {overwrite!r}")
    clean_dev = validate_device_id(device_id) if (device_id and device_id.strip()) else None
    merged_dates = _normalize_date_list(date=date, dates=dates)

    photos = query_target_photos_for_field_log(
        dates=merged_dates if merged_dates else None,
        date_from=date_from,
        date_to=date_to,
        folder=folder,
        volume_serial=volume_serial,
        photo_ids=photo_ids,
        device_id=clean_dev,
    )
    lookup_dates = _collect_lookup_dates_for_photos(
        photos,
        explicit_dates=merged_dates,
        camera_offsets=camera_offsets,
    )
    points = load_points_for_dates(lookup_dates, device_id=clean_dev) if lookup_dates else []
    match_res = match_photos(
        photos=photos,
        points=points,
        camera_offsets=camera_offsets or {},
        max_gap_sec=max_gap_sec,
        max_nearest_sec=max_nearest_sec,
        overwrite=overwrite,
    )
    return photos, points, match_res, merged_dates


def preview_field_log_matches(
    device_id: Optional[str] = None,
    date: Optional[str] = None,
    dates: Optional[List[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    folder: Optional[str] = None,
    volume_serial: Optional[str] = None,
    photo_ids: Optional[List[int]] = None,
    camera_offsets: Optional[Dict[str, int]] = None,
    max_gap_sec: int = 300,
    max_nearest_sec: int = 120,
    overwrite: str = "missing_only",
) -> Dict[str, Any]:
    """DBを書き換えずにフィールドログ照合結果と対象カメラ機種一覧をプレビュー返却する"""
    photos, points, match_res, _ = _compute_matches_from_params(
        device_id=device_id,
        date=date,
        dates=dates,
        date_from=date_from,
        date_to=date_to,
        folder=folder,
        volume_serial=volume_serial,
        photo_ids=photo_ids,
        camera_offsets=camera_offsets,
        max_gap_sec=max_gap_sec,
        max_nearest_sec=max_nearest_sec,
        overwrite=overwrite,
    )
    camera_models = sorted({
        str(p["camera_model"]).strip()
        for p in photos
        if p.get("camera_model") and str(p["camera_model"]).strip() and str(p["camera_model"]).strip() != "不明"
    })
    return {
        "ok": True,
        "items": match_res["items"],
        "unmatched": match_res["unmatched"],
        "skipped": match_res["skipped"],
        "camera_models": camera_models,
        "total_photos": len(photos),
        "points_loaded": len(points),
    }


def _generate_unique_batch_id(batches_dir: Path) -> str:
    """ローカル時刻ベースのユニークな batch_id (YYYYMMDD-HHMMSS-xxxx) を発行する"""
    stamp = _dt_cls.now().strftime("%Y%m%d-%H%M%S")
    for _ in range(20):
        candidate = f"{stamp}-{secrets.token_hex(2)}"
        if not (batches_dir / f"{candidate}.json").exists():
            return candidate
    return f"{stamp}-{secrets.token_hex(4)}"


def apply_field_log_matches(
    device_id: Optional[str] = None,
    date: Optional[str] = None,
    dates: Optional[List[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    folder: Optional[str] = None,
    volume_serial: Optional[str] = None,
    photo_ids: Optional[List[int]] = None,
    camera_offsets: Optional[Dict[str, int]] = None,
    max_gap_sec: int = 300,
    max_nearest_sec: int = 120,
    overwrite: str = "missing_only",
) -> Dict[str, Any]:
    """
    サーバー側でフィールドログ照合を再計算し、逆ジオコーディング地名とともに DB へ非破壊適用する。
    適用前の値は _batches/<batch_id>.json に退避し、バッチ単位の Undo を可能にする。
    """
    _, _, match_res, merged_dates = _compute_matches_from_params(
        device_id=device_id,
        date=date,
        dates=dates,
        date_from=date_from,
        date_to=date_to,
        folder=folder,
        volume_serial=volume_serial,
        photo_ids=photo_ids,
        camera_offsets=camera_offsets,
        max_gap_sec=max_gap_sec,
        max_nearest_sec=max_nearest_sec,
        overwrite=overwrite,
    )
    matched_items = match_res["items"]
    if not matched_items:
        return {
            "ok": True,
            "batch_id": None,
            "applied": 0,
            "unmatched": len(match_res["unmatched"]),
            "skipped": len(match_res["skipped"]),
        }

    target_ids = [int(it["photo_id"]) for it in matched_items]
    batches_dir = _get_batches_dir()
    batch_id = _generate_unique_batch_id(batches_dir)
    batch_file = _resolve_safe_batch_file(batch_id)

    with get_connection() as conn:
        cursor = conn.cursor()

        # 適用直前の最新DB状態を取得して退避データを作る
        current_rows: Dict[int, Dict[str, Any]] = {}
        for i in range(0, len(target_ids), 500):
            chunk = target_ids[i:i + 500]
            ph = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"""
                SELECT id, file_name, date_taken, latitude, longitude, gps_source, country, state, city
                FROM photos
                WHERE id IN ({ph})
                """,
                chunk,
            )
            for row in cursor.fetchall():
                current_rows[int(row["id"])] = dict(row)

        before_snapshots: List[Dict[str, Any]] = []
        update_params: List[Tuple[Any, ...]] = []
        applied_dates_set: Set[str] = set(merged_dates)

        for item in matched_items:
            pid = int(item["photo_id"])
            cur = current_rows.get(pid)
            if cur is None:
                continue
            # 並行操作等で manual になっていた場合は絶対に上書きしない
            if cur.get("gps_source") == "manual":
                continue

            lat = float(item["lat"])
            lon = float(item["lon"])
            geo = reverse_geocode(lat, lon, db_conn=conn)

            d_taken = _extract_photo_date_str(cur.get("date_taken"))
            if d_taken:
                applied_dates_set.add(d_taken)

            before_snapshots.append({
                "photo_id": pid,
                "file_name": cur.get("file_name"),
                "latitude": cur.get("latitude"),
                "longitude": cur.get("longitude"),
                "gps_source": cur.get("gps_source"),
                "country": cur.get("country"),
                "state": cur.get("state"),
                "city": cur.get("city"),
                "applied_latitude": lat,
                "applied_longitude": lon,
            })
            update_params.append((
                lat,
                lon,
                geo.get("country"),
                geo.get("state"),
                geo.get("city"),
                pid,
            ))

        if not update_params:
            return {
                "ok": True,
                "batch_id": None,
                "applied": 0,
                "unmatched": len(match_res["unmatched"]),
                "skipped": len(match_res["skipped"]),
            }

        now_local = _dt_cls.now().strftime("%Y-%m-%d %H:%M:%S")
        batch_payload: Dict[str, Any] = {
            "batch_id": batch_id,
            "created_at": now_local,
            "device_id": device_id.strip() if (device_id and device_id.strip()) else None,
            "dates": sorted(applied_dates_set),
            "folder": folder.strip() if (folder and folder.strip()) else None,
            "overwrite": overwrite,
            "camera_offsets": {str(k): int(v) for k, v in (camera_offsets or {}).items()},
            "applied_count": len(update_params),
            "undone": False,
            "undone_at": None,
            "photos": before_snapshots,
        }

        # 先にロールバック用バッチファイルを書き出してからDBを更新する
        _atomic_write_json(batch_file, batch_payload)
        try:
            cursor.executemany(
                """
                UPDATE photos
                SET latitude = ?, longitude = ?, gps_source = 'fieldlog',
                    country = ?, state = ?, city = ?,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND COALESCE(gps_source, '') != 'manual'
                """,
                update_params,
            )
            conn.commit()
        except Exception:
            batch_file.unlink(missing_ok=True)
            raise

    _clear_all_photo_caches()
    return {
        "ok": True,
        "batch_id": batch_id,
        "applied": len(update_params),
        "unmatched": len(match_res["unmatched"]),
        "skipped": len(match_res["skipped"]),
    }


def list_field_log_batches() -> List[Dict[str, Any]]:
    """保存されているフィールドログ適用バッチ履歴を新しい順の一覧で返す"""
    batches_dir = _get_batches_dir()
    if not batches_dir.exists() or not batches_dir.is_dir():
        return []

    summaries: List[Dict[str, Any]] = []
    for bf in sorted(batches_dir.glob("*.json"), key=lambda p: p.stem, reverse=True):
        if not BATCH_ID_RE.match(bf.stem):
            continue
        try:
            data = json.loads(bf.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                continue
            summaries.append({
                "batch_id": str(data.get("batch_id") or bf.stem),
                "created_at": data.get("created_at"),
                "applied_count": int(data.get("applied_count") or len(data.get("photos") or [])),
                "device_id": data.get("device_id"),
                "dates": data.get("dates") or [],
                "folder": data.get("folder"),
                "directory_path": data.get("folder"),
                "overwrite": data.get("overwrite"),
                "undone": bool(data.get("undone", False)),
                "undone_at": data.get("undone_at"),
            })
        except Exception as e:
            logger.warning(f"バッチ履歴 JSON の読込スキップ ({bf}): {e}")

    summaries.sort(key=lambda b: (str(b.get("created_at") or ""), b["batch_id"]), reverse=True)
    return summaries


def undo_field_log_batch(batch_id: str) -> Dict[str, Any]:
    """
    指定バッチの適用前スナップショットから写真の緯度・経度・gps_source・地名を復元する。
    適用後にユーザーが手動ピン留め (gps_source == 'manual') した写真は保護して上書きしない。
    """
    batch_file = _resolve_safe_batch_file(batch_id)
    if not batch_file.exists() or not batch_file.is_file():
        raise FileNotFoundError(f"指定されたバッチ履歴が見つかりません: {batch_id}")

    data = json.loads(batch_file.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("バッチ履歴ファイルの形式が不正です")
    if data.get("undone") is True:
        raise ValueError("このバッチは既に取り消し済みです")

    photo_entries = data.get("photos") or []
    target_ids = [int(p["photo_id"]) for p in photo_entries if isinstance(p, dict) and "photo_id" in p]

    restored_count = 0
    skipped_manual = 0

    if target_ids:
        with get_connection() as conn:
            cursor = conn.cursor()
            cur_sources: Dict[int, Optional[str]] = {}
            for i in range(0, len(target_ids), 500):
                chunk = target_ids[i:i + 500]
                ph = ",".join(["?"] * len(chunk))
                cursor.execute(f"SELECT id, gps_source FROM photos WHERE id IN ({ph})", chunk)
                for row in cursor.fetchall():
                    cur_sources[int(row["id"])] = row["gps_source"]

            restore_params: List[Tuple[Any, ...]] = []
            for entry in photo_entries:
                if not isinstance(entry, dict) or "photo_id" not in entry:
                    continue
                pid = int(entry["photo_id"])
                if pid not in cur_sources:
                    continue
                if cur_sources[pid] == "manual":
                    skipped_manual += 1
                    continue
                restore_params.append((
                    entry.get("latitude"),
                    entry.get("longitude"),
                    entry.get("gps_source"),
                    entry.get("country"),
                    entry.get("state"),
                    entry.get("city"),
                    pid,
                ))

            if restore_params:
                cursor.executemany(
                    """
                    UPDATE photos
                    SET latitude = ?, longitude = ?, gps_source = ?,
                        country = ?, state = ?, city = ?,
                        meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND COALESCE(gps_source, '') != 'manual'
                    """,
                    restore_params,
                )
                restored_count = len(restore_params)
            conn.commit()

    data["undone"] = True
    data["undone_at"] = _dt_cls.now().strftime("%Y-%m-%d %H:%M:%S")
    _atomic_write_json(batch_file, data)

    _clear_all_photo_caches()
    return {
        "ok": True,
        "batch_id": batch_file.stem,
        "restored": restored_count,
        "skipped_manual": skipped_manual,
    }
