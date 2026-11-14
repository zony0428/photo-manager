"""
フィールドログ（GPS足跡点列）と写真撮影日時を照合する純粋関数モジュール

データベースや FastAPI フレームワークには一切依存しない。
"""

import bisect
import math
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

VALID_OVERWRITE_MODES = ("missing_only", "replace_inferred", "all")

_DATE_TAKEN_RE = re.compile(
    r"^\s*(\d{4})[-:/](\d{1,2})[-:/](\d{1,2})[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?"
)


def parse_photo_naive_epoch(date_taken: Any) -> Optional[float]:
    """
    写真の date_taken 文字列（時差なしローカル時刻）を、仮に UTC とみなしたエポック秒へ変換する。
    パース不能な場合は None を返す。
    """
    if not date_taken or not isinstance(date_taken, str):
        return None
    m = _DATE_TAKEN_RE.match(date_taken)
    if not m:
        return None
    try:
        year = int(m.group(1))
        month = int(m.group(2))
        day = int(m.group(3))
        hour = int(m.group(4))
        minute = int(m.group(5))
        second = int(m.group(6)) if m.group(6) is not None else 0
        micro = 0
        if m.group(7):
            frac = (m.group(7) + "000000")[:6]
            micro = int(frac)
        dt = datetime(year, month, day, hour, minute, second, micro, tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def _normalize_points(points: List[dict]) -> List[Dict[str, Any]]:
    """入力された点リストから有効な座標・時刻を持つ点を抽出し、t 昇順に整列して返す"""
    valid: List[Dict[str, Any]] = []
    for p in points or []:
        if not isinstance(p, dict):
            continue
        if p.get("type", "pt") != "pt":
            continue
        t_raw = p.get("t")
        lat_raw = p.get("lat")
        lon_raw = p.get("lon")
        if t_raw is None or lat_raw is None or lon_raw is None:
            continue
        if isinstance(t_raw, bool) or isinstance(lat_raw, bool) or isinstance(lon_raw, bool):
            continue
        try:
            t_ms = int(t_raw)
            lat = float(lat_raw)
            lon = float(lon_raw)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(lat) and math.isfinite(lon)):
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        if abs(lat) < 1e-6 and abs(lon) < 1e-6:
            continue

        norm_p: Dict[str, Any] = {
            "t": t_ms,
            "lat": lat,
            "lon": lon,
        }
        tz_raw = p.get("tz")
        if tz_raw is not None and not isinstance(tz_raw, bool):
            try:
                norm_p["tz"] = int(tz_raw)
            except (TypeError, ValueError):
                pass
        acc_raw = p.get("acc")
        if acc_raw is not None and not isinstance(acc_raw, bool):
            try:
                acc_f = float(acc_raw)
                if math.isfinite(acc_f) and acc_f >= 0.0:
                    norm_p["acc"] = acc_f
            except (TypeError, ValueError):
                pass
        valid.append(norm_p)

    # 既に昇順なら Python の Timsort は O(N) で完了する
    valid.sort(key=lambda item: item["t"])
    return valid


def _find_nearest_point_index(pt_times: List[int], target_ms: int) -> int:
    """昇順リスト pt_times の中で target_ms に最も近い要素のインデックスを返す"""
    idx = bisect.bisect_left(pt_times, target_ms)
    if idx <= 0:
        return 0
    if idx >= len(pt_times):
        return len(pt_times) - 1
    before_diff = target_ms - pt_times[idx - 1]
    after_diff = pt_times[idx] - target_ms
    return (idx - 1) if before_diff <= after_diff else idx


def _resolve_tz_near(sorted_pts: List[Dict[str, Any]], near_idx: int, fallback_tz: int) -> int:
    """最近傍点（欠けていればその前後）から tz（UTCオフセット分）を取得する"""
    pt = sorted_pts[near_idx]
    if "tz" in pt:
        return int(pt["tz"])
    # 前後へ探索
    n = len(sorted_pts)
    for offset in range(1, n):
        left = near_idx - offset
        right = near_idx + offset
        if left >= 0 and "tz" in sorted_pts[left]:
            return int(sorted_pts[left]["tz"])
        if right < n and "tz" in sorted_pts[right]:
            return int(sorted_pts[right]["tz"])
    return fallback_tz


def _interpolate_lon(lon1: float, lon2: float, ratio: float) -> float:
    """日付変更線（±180度）跨ぎを考慮して経度を線形補間する"""
    dlon = lon2 - lon1
    if dlon > 180.0:
        dlon -= 360.0
    elif dlon < -180.0:
        dlon += 360.0
    lon = lon1 + ratio * dlon
    if lon > 180.0:
        lon -= 360.0
    elif lon < -180.0:
        lon += 360.0
    return lon


def _interpolate_acc(p_before: Dict[str, Any], p_after: Dict[str, Any], ratio: float) -> Optional[float]:
    """前後2点の水平精度 acc を補間（片方のみならその値）して返す"""
    acc1 = p_before.get("acc")
    acc2 = p_after.get("acc")
    if acc1 is not None and acc2 is not None:
        return round((1.0 - ratio) * float(acc1) + ratio * float(acc2), 1)
    if acc1 is not None:
        return round(float(acc1), 1)
    if acc2 is not None:
        return round(float(acc2), 1)
    return None


def _check_overwrite_skip_reason(photo: dict, overwrite: str) -> Optional[str]:
    """
    写真の上書き可否を判定し、スキップすべき場合は理由文字列を返す。対象とする場合は None を返す。
    gps_source == 'manual' はいかなる設定でも保護する。
    """
    prev_source = photo.get("gps_source")
    if prev_source == "manual":
        return "manual_protected"

    lat_val = photo.get("latitude")
    if "longitude" in photo:
        has_gps = lat_val is not None and photo.get("longitude") is not None
    else:
        has_gps = lat_val is not None

    if overwrite == "missing_only":
        if has_gps:
            return "already_has_gps"
        return None

    if overwrite == "replace_inferred":
        if has_gps and prev_source not in ("inferred", "fieldlog"):
            return "exif_or_copied_protected"
        return None

    # overwrite == "all" ('manual' は先頭で除外済み)
    return None


def match_photos(
    photos: list[dict],
    points: list[dict],
    camera_offsets: dict[str, int] = {},
    max_gap_sec: int = 300,
    max_nearest_sec: int = 120,
    overwrite: str = "missing_only",
) -> dict:
    """
    写真リストとフィールドログ点列を撮影時刻で照合し、付与候補・未一致・スキップを返す純粋関数。
    """
    if overwrite not in VALID_OVERWRITE_MODES:
        raise ValueError(f"不正な overwrite モードです: {overwrite!r}")

    gap_limit_sec = max(0.0, float(max_gap_sec))
    nearest_limit_sec = max(0.0, float(max_nearest_sec))

    offsets: Dict[str, int] = {}
    if camera_offsets:
        for k, v in camera_offsets.items():
            if k is not None and v is not None:
                offsets[str(k)] = int(v)
                offsets[str(k).strip()] = int(v)

    sorted_pts = _normalize_points(points)
    pt_times = [p["t"] for p in sorted_pts]
    n_pts = len(sorted_pts)

    initial_tz = 0
    for p in sorted_pts:
        if "tz" in p:
            initial_tz = int(p["tz"])
            break

    items: List[Dict[str, Any]] = []
    unmatched: List[Any] = []
    skipped: List[Dict[str, Any]] = []

    for photo in photos or []:
        if not isinstance(photo, dict):
            continue
        photo_id = photo["id"] if "id" in photo else photo.get("photo_id")

        skip_reason = _check_overwrite_skip_reason(photo, overwrite)
        if skip_reason is not None:
            skipped.append({"photo_id": photo_id, "reason": skip_reason})
            continue

        naive_epoch = parse_photo_naive_epoch(photo.get("date_taken"))
        if naive_epoch is None:
            skipped.append({"photo_id": photo_id, "reason": "no_date_taken"})
            continue

        if n_pts == 0:
            unmatched.append(photo_id)
            continue

        raw_cam = photo.get("camera_model") or ""
        cam_offset_sec = offsets.get(str(raw_cam), offsets.get(str(raw_cam).strip(), 0))

        # 2段階反復で最近傍点の tz（UTCオフセット分）を確定し、正確な UTC ミリ秒を求める
        approx_ms = int(round((naive_epoch - initial_tz * 60 + cam_offset_sec) * 1000.0))
        near_idx_1 = _find_nearest_point_index(pt_times, approx_ms)
        tz_1 = _resolve_tz_near(sorted_pts, near_idx_1, initial_tz)
        utc_ms = int(round((naive_epoch - tz_1 * 60 + cam_offset_sec) * 1000.0))

        near_idx_2 = _find_nearest_point_index(pt_times, utc_ms)
        tz_2 = _resolve_tz_near(sorted_pts, near_idx_2, tz_1)
        if tz_2 != tz_1:
            utc_ms = int(round((naive_epoch - tz_2 * 60 + cam_offset_sec) * 1000.0))

        idx = bisect.bisect_left(pt_times, utc_ms)
        matched_entry: Optional[Tuple[float, float, str, float, Optional[float]]] = None

        # 1. 前後2点による線形補間（ぴったり同一時刻の点がある場合も含む）
        if idx < n_pts and pt_times[idx] == utc_ms:
            p_exact = sorted_pts[idx]
            acc_val = round(float(p_exact["acc"]), 1) if "acc" in p_exact else None
            matched_entry = (p_exact["lat"], p_exact["lon"], "interpolated", 0.0, acc_val)
        elif 0 < idx < n_pts:
            p_before = sorted_pts[idx - 1]
            p_after = sorted_pts[idx]
            span_ms = p_after["t"] - p_before["t"]
            span_sec = span_ms / 1000.0
            if span_ms > 0 and span_sec <= gap_limit_sec:
                ratio = (utc_ms - p_before["t"]) / float(span_ms)
                lat = p_before["lat"] + ratio * (p_after["lat"] - p_before["lat"])
                lon = _interpolate_lon(p_before["lon"], p_after["lon"], ratio)
                acc_val = _interpolate_acc(p_before, p_after, ratio)
                matched_entry = (lat, lon, "interpolated", round(span_sec, 1), acc_val)

        # 2. 線形補間できない場合は許容差内の最寄り点を採用
        if matched_entry is None:
            candidates: List[Dict[str, Any]] = []
            if idx > 0:
                candidates.append(sorted_pts[idx - 1])
            if idx < n_pts:
                candidates.append(sorted_pts[idx])
            if candidates:
                p_near = min(candidates, key=lambda pt: abs(utc_ms - pt["t"]))
                diff_sec = abs(utc_ms - p_near["t"]) / 1000.0
                if diff_sec <= nearest_limit_sec:
                    acc_val = round(float(p_near["acc"]), 1) if "acc" in p_near else None
                    matched_entry = (
                        p_near["lat"],
                        p_near["lon"],
                        "nearest",
                        round(diff_sec, 1),
                        acc_val,
                    )

        if matched_entry is None:
            unmatched.append(photo_id)
            continue

        lat_res, lon_res, method_res, gap_res, acc_res = matched_entry
        result_item: Dict[str, Any] = {
            "photo_id": photo_id,
            "lat": round(lat_res, 7),
            "lon": round(lon_res, 7),
            "method": method_res,
            "gap_sec": gap_res,
            "acc_m": acc_res,
            "prev_source": photo.get("gps_source"),
        }
        for opt_field in ("file_name", "date_taken", "camera_model"):
            if opt_field in photo:
                result_item[opt_field] = photo.get(opt_field)
        items.append(result_item)

    return {
        "items": items,
        "unmatched": unmatched,
        "skipped": skipped,
    }
