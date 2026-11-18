"""
モバイル連携（Workingフォルダ・縮小転送スマート一致・待機シグナル・クロスフォルダthmod）共通ロジック

- カメラからスマホへ2M縮小転送された画像と、PC側のフルサイズJPEG/RAWのスマート一致
- SDカード取り込み前の先行評価・タグ・GPSを一時保管する待機シグナル (mobile_pending_signals)
- スキャン登録時の待機シグナル自動適用（RAW+JPEG同時取り込み両対応）
"""

from datetime import datetime, timedelta
import json
import logging
import os
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .database.tags import (
    _ensure_tag_keys_registered,
    _expand_ancestor_tags,
    _expand_stack_and_pair_photo_ids,
    _normalize_tag_path,
)

logger = logging.getLogger("photo_manager.mobile_signals")

_EXIF_DATE_PREFIX_RE = re.compile(r"^(\d{4})[-:/](\d{2})[-:/](\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?")
_PAREN_COPY_SUFFIX_RE = re.compile(r"\s*\(\d+\)$")
_UNDERSCORE_COPY_SUFFIX_RE = re.compile(r"^(.+)_([1-9]\d?)$")
_CAMERA_NUMBERED_BASE_RE = re.compile(r"(?:[a-z]+\d{3,}|_\d{3,}|\d{6,})$")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_INVALID_CAMERAS = {"", "不明", "raw写真", "unknown"}


def is_thmod_filename(file_name: Optional[str]) -> bool:
    """Art Framer等で生成された thmod_ 接頭辞付きの加工成果物ファイルか判定する"""
    if not file_name:
        return False
    base = os.path.basename(str(file_name).replace("\\", "/")).strip().lower()
    return base.startswith("thmod_")


def normalize_camera_stem(file_name: Optional[str]) -> str:
    """
    ファイル名から拡張子・先頭thmod_・OSコピー枝番を除去した正規化ステム名を返す。
    IMG_1234 や 20261117_001 のようなカメラ連番・日付番号の末尾数字は絶対に削らない。
    """
    if not file_name:
        return ""
    base = os.path.basename(str(file_name).replace("\\", "/")).strip()
    if not base:
        return ""
    stem = Path(base).stem.strip().lower()
    if not stem:
        return ""
    if stem.startswith("thmod_"):
        stem = stem[6:].strip()
    stem = _PAREN_COPY_SUFFIX_RE.sub("", stem).strip()
    m = _UNDERSCORE_COPY_SUFFIX_RE.match(stem)
    if m:
        prefix = m.group(1)
        if _CAMERA_NUMBERED_BASE_RE.search(prefix):
            stem = prefix
    return stem


def normalize_exif_dt_str(raw: Any) -> str:
    """日時文字列を YYYY-MM-DD HH:MM:SS（時刻省略時は 00:00:00）へ正規化する"""
    s = str(raw or "").strip()
    if not s:
        return ""
    m = _EXIF_DATE_PREFIX_RE.match(s)
    if not m:
        return ""
    yyyy, mm, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1970 <= yyyy <= 2100 and 1 <= mm <= 12 and 1 <= dd <= 31):
        return ""
    hh = int(m.group(4) or 0)
    mi = int(m.group(5) or 0)
    ss = int(m.group(6) or 0)
    if not (0 <= hh <= 23 and 0 <= mi <= 59 and 0 <= ss <= 59):
        return ""
    return f"{yyyy:04d}-{mm:02d}-{dd:02d} {hh:02d}:{mi:02d}:{ss:02d}"


def _parse_dt(dt_str: str) -> Optional[datetime]:
    """正規化済み日時文字列を datetime へ変換する"""
    norm = normalize_exif_dt_str(dt_str)
    if not norm:
        return None
    try:
        return datetime.strptime(norm, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def dates_within_tolerance(dt_a: Any, dt_b: Any, max_diff_sec: int = 2) -> bool:
    """2つの撮影日時が指定秒数（既定±2秒）以内で一致するか判定する"""
    norm_a = normalize_exif_dt_str(dt_a)
    norm_b = normalize_exif_dt_str(dt_b)
    if not norm_a or not norm_b:
        return False
    if norm_a == norm_b:
        return True
    parsed_a = _parse_dt(norm_a)
    parsed_b = _parse_dt(norm_b)
    if parsed_a is None or parsed_b is None:
        return False
    return abs((parsed_a - parsed_b).total_seconds()) <= float(max_diff_sec)


def normalize_camera_key(raw: Any) -> str:
    """カメラ機種名を比較用に英数字小文字のみへ正規化する"""
    s = str(raw or "").strip().lower()
    if s in _INVALID_CAMERAS:
        return ""
    cleaned = _NON_ALNUM_RE.sub("", s)
    return cleaned


def camera_models_compatible(cam_a: Any, cam_b: Any) -> bool:
    """2つのカメラ機種名が互換（一方未設定またはメーカー表記揺れ吸収で一致）か判定する"""
    ka = normalize_camera_key(cam_a)
    kb = normalize_camera_key(cam_b)
    if not ka or not kb:
        return True
    return ka == kb or (ka in kb) or (kb in ka)


def _expand_date_keys_with_neighbors(dt_strings: Iterable[str]) -> List[str]:
    """日付境界（23:59:59 ⇔ 00:00:01）を吸収するため前後1日を含む日付文字列リストを返す"""
    day_prefixes: set = set()
    for raw_dt in dt_strings:
        parsed = _parse_dt(str(raw_dt or ""))
        if parsed is None:
            continue
        for delta in (-1, 0, 1):
            d = (parsed + timedelta(days=delta)).strftime("%Y-%m-%d")
            day_prefixes.add(d)
            day_prefixes.add(d.replace("-", ":"))
    return sorted(day_prefixes)


def find_smart_stem_date_matches(
    cursor: Any,
    items: List[Dict[str, Any]],
    max_diff_sec: int = 2,
) -> Dict[str, List[int]]:
    """
    ファイルサイズや拡張子が異なるスマホ縮小転送画像（2M等）と母艦のフルサイズJPEG/RAW原本を
    「正規化ステム名 ＋ 撮影日時(±2秒) ＋ カメラ機種互換」で照合し、キー毎の一致photo_idリストを返す。
    EXIF撮影日時を持たないアイテムは誤爆防止のためスマート一致対象外とする。
    """
    parsed_items: List[Tuple[str, str, str, str]] = []
    dt_samples: List[str] = []
    for idx, it in enumerate(items):
        key = str(it.get("key") or idx)
        fname = str(it.get("file_name") or "").strip()
        if not fname or is_thmod_filename(fname):
            continue
        dt_norm = normalize_exif_dt_str(it.get("date_taken"))
        if not dt_norm:
            continue
        stem = normalize_camera_stem(fname)
        if not stem:
            continue
        cam = str(it.get("camera_model") or "").strip()
        parsed_items.append((key, stem, dt_norm, cam))
        dt_samples.append(dt_norm)

    if not parsed_items:
        return {}

    date_keys = _expand_date_keys_with_neighbors(dt_samples)
    if not date_keys:
        return {}

    ph = ",".join("?" for _ in date_keys)
    cursor.execute(
        f"""
        SELECT id, file_name, date_taken, original_date_taken, camera_model, paired_raw_path, stack_id
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0
          AND (SUBSTR(date_taken, 1, 10) IN ({ph}) OR SUBSTR(original_date_taken, 1, 10) IN ({ph}))
        """,
        date_keys + date_keys,
    )
    rows_by_stem: Dict[str, List[Dict[str, Any]]] = {}
    for row in cursor.fetchall():
        fn = str(row["file_name"] or "")
        if not fn or is_thmod_filename(fn):
            continue
        st = normalize_camera_stem(fn)
        if not st:
            continue
        rows_by_stem.setdefault(st, []).append(dict(row))

    if not rows_by_stem:
        return {}

    matches: Dict[str, List[int]] = {}
    conn = getattr(cursor, "connection", None)
    for key, stem, dt_norm, cam in parsed_items:
        cands = rows_by_stem.get(stem)
        if not cands:
            continue
        matched_ids: List[int] = []
        for cand in cands:
            if not camera_models_compatible(cam, cand.get("camera_model")):
                continue
            cand_dt1 = cand.get("date_taken")
            cand_dt2 = cand.get("original_date_taken")
            if dates_within_tolerance(dt_norm, cand_dt1, max_diff_sec) or dates_within_tolerance(
                dt_norm, cand_dt2, max_diff_sec
            ):
                matched_ids.append(int(cand["id"]))
        if matched_ids:
            if conn is not None:
                expanded = _expand_stack_and_pair_photo_ids(conn, matched_ids)
                # 既に別のファイル名(別連写コマ)へ無闇に広がらないよう、元の順を保ちつつペア相手を補完
                ordered = list(dict.fromkeys(matched_ids + expanded))
                matches[key] = ordered
            else:
                matches[key] = list(dict.fromkeys(matched_ids))
    return matches


def upsert_pending_signal(
    cursor: Any,
    *,
    file_name: str,
    date_taken: Any,
    camera_model: str = "",
    rating: Optional[int] = None,
    tags: Optional[Iterable[str]] = None,
    remove_tags: Optional[Iterable[str]] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    resolve_geo: bool = True,
) -> bool:
    """
    SDカード取り込み前の先行評価・タグ・GPS信号を mobile_pending_signals テーブルへ保存・更新する。
    """
    norm_dt = normalize_exif_dt_str(date_taken)
    norm_stem = normalize_camera_stem(file_name)
    if not norm_dt or not norm_stem or is_thmod_filename(file_name):
        return False

    clean_tags: List[str] = []
    seen_tags: set = set()
    for t in tags or []:
        nt = _normalize_tag_path(str(t or "").strip())
        if nt and nt not in seen_tags:
            seen_tags.add(nt)
            clean_tags.append(nt)

    remove_set: set = set()
    for rt in remove_tags or []:
        nrt = _normalize_tag_path(str(rt or "").strip())
        if nrt:
            remove_set.add(nrt)

    lat_f: Optional[float] = None
    lon_f: Optional[float] = None
    if latitude is not None and longitude is not None:
        try:
            la = round(float(latitude), 7)
            lo = round(float(longitude), 7)
            if abs(la) >= 0.0001 or abs(lo) >= 0.0001:
                lat_f, lon_f = la, lo
        except (TypeError, ValueError):
            lat_f, lon_f = None, None

    r_val: Optional[int] = None
    if rating is not None:
        try:
            r_val = max(-1, min(2, int(rating)))
        except (TypeError, ValueError):
            r_val = None

    cursor.execute(
        "SELECT id, rating, tags_json, latitude, longitude, country, state, city FROM mobile_pending_signals "
        "WHERE norm_stem = ? AND date_taken = ? LIMIT 1",
        (norm_stem, norm_dt),
    )
    existing = cursor.fetchone()

    has_meaningful = bool((r_val is not None and r_val != 0) or clean_tags or (lat_f is not None and lon_f is not None))
    if not existing and not has_meaningful:
        return False

    merged_rating = r_val if r_val is not None else (int(existing["rating"] or 0) if existing else 0)
    merged_tags_list: List[str] = []
    merged_tags_seen: set = set()
    if existing and existing["tags_json"]:
        try:
            prev_tags = json.loads(existing["tags_json"])
            if isinstance(prev_tags, list):
                for pt in prev_tags:
                    npt = _normalize_tag_path(str(pt or "").strip())
                    if npt and npt not in remove_set and not any(npt.startswith(f"{rm}/") for rm in remove_set):
                        if npt not in merged_tags_seen:
                            merged_tags_seen.add(npt)
                            merged_tags_list.append(npt)
        except Exception as e:
            logger.debug(f"待機シグナル既存タグJSON解析スキップ: {e}")

    for nt in clean_tags:
        if nt not in merged_tags_seen:
            merged_tags_seen.add(nt)
            merged_tags_list.append(nt)

    if lat_f is None and existing and existing["latitude"] is not None and existing["longitude"] is not None:
        lat_f = existing["latitude"]
        lon_f = existing["longitude"]
        country = existing["country"]
        state = existing["state"]
        city = existing["city"]
    elif lat_f is not None and lon_f is not None:
        country, state, city = None, None, None
        if resolve_geo:
            try:
                from .geocoder import reverse_geocode

                loc = reverse_geocode(lat_f, lon_f)
                country = loc.get("country")
                state = loc.get("state")
                city = loc.get("city")
            except Exception as geo_err:
                logger.debug(f"待機シグナル逆ジオコーディングスキップ: {geo_err}")
    else:
        country, state, city = None, None, None

    cam_str = str(camera_model or "").strip()
    tags_json_str = json.dumps(merged_tags_list, ensure_ascii=False)

    if existing:
        cursor.execute(
            """
            UPDATE mobile_pending_signals
            SET file_name = ?,
                camera_model = CASE WHEN ? != '' THEN ? ELSE camera_model END,
                rating = ?,
                tags_json = ?,
                latitude = ?,
                longitude = ?,
                country = ?,
                state = ?,
                city = ?,
                matched_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                os.path.basename(str(file_name)),
                cam_str,
                cam_str,
                merged_rating,
                tags_json_str,
                lat_f,
                lon_f,
                country,
                state,
                city,
                existing["id"],
            ),
        )
    else:
        cursor.execute(
            """
            INSERT INTO mobile_pending_signals (
                norm_stem, file_name, date_taken, camera_model,
                rating, tags_json, latitude, longitude, country, state, city, matched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                norm_stem,
                os.path.basename(str(file_name)),
                norm_dt,
                cam_str,
                merged_rating,
                tags_json_str,
                lat_f,
                lon_f,
                country,
                state,
                city,
            ),
        )
    return True


def load_active_pending_signals_map(cursor: Any) -> Dict[str, List[Dict[str, Any]]]:
    """
    未適用（matched_at IS NULL）および直近60秒以内に適用開始された待機シグナルを1クエリでロードする。
    同一スキャン中に RAW + JPEG の2ファイルが連続登録されても両方に適用できるようにし、
    過去スキャンから時間が経過した既適用シグナルによる誤上書きを防止する。
    0件の場合は空辞書を返し、通常スキャンのオーバーヘッドをゼロに保つ。
    """
    try:
        cursor.execute(
            """
            SELECT *
            FROM mobile_pending_signals
            WHERE matched_at IS NULL
               OR matched_at >= DATETIME('now', '-60 seconds')
            ORDER BY id ASC
            """
        )
        rows = cursor.fetchall()
    except Exception:
        return {}

    if not rows:
        return {}

    sig_map: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        d = dict(r)
        st = str(d.get("norm_stem") or "").strip().lower()
        if st:
            sig_map.setdefault(st, []).append(d)
    return sig_map


def apply_pending_signals_to_photo_in_tx(
    cursor: Any,
    photo_id: int,
    clean_data: Dict[str, Any],
    pending_map: Dict[str, List[Dict[str, Any]]],
    registered_tags_cache: Optional[set] = None,
) -> bool:
    """
    新規登録（または復帰）した写真1枚に対してプリロード済み待機シグナルを照合・インライン適用する。
    同一トランザクション内で完結させ、途中で commit() を呼ばない。
    """
    if not pending_map or not photo_id:
        return False

    fname = str(clean_data.get("file_name") or "").strip()
    if not fname or is_thmod_filename(fname):
        return False

    dt_norm = normalize_exif_dt_str(clean_data.get("original_date_taken") or clean_data.get("date_taken"))
    if not dt_norm:
        return False

    stem = normalize_camera_stem(fname)
    if not stem:
        return False

    cands = pending_map.get(stem)
    if not cands:
        return False

    cam_str = str(clean_data.get("camera_model") or "")
    matched_signals: List[Dict[str, Any]] = []
    for sig in cands:
        if not camera_models_compatible(cam_str, sig.get("camera_model")):
            continue
        if dates_within_tolerance(dt_norm, sig.get("date_taken"), max_diff_sec=2):
            matched_signals.append(sig)

    if not matched_signals:
        return False

    cache = registered_tags_cache if registered_tags_cache is not None else set()
    applied = False
    for sig in matched_signals:
        sig_rating = int(sig.get("rating") or 0)
        sig_lat = sig.get("latitude")
        sig_lon = sig.get("longitude")
        sig_country = sig.get("country")
        sig_state = sig.get("state")
        sig_city = sig.get("city")

        update_clauses: List[str] = []
        update_params: List[Any] = []
        if sig_rating != 0:
            update_clauses.append("rating = ?")
            update_params.append(sig_rating)
        if sig_lat is not None and sig_lon is not None and (clean_data.get("latitude") is None or clean_data.get("longitude") is None):
            update_clauses.extend(
                [
                    "latitude = COALESCE(latitude, ?)",
                    "longitude = COALESCE(longitude, ?)",
                    "gps_source = COALESCE(gps_source, 'exif')",
                    "country = COALESCE(country, ?)",
                    "state = COALESCE(state, ?)",
                    "city = COALESCE(city, ?)",
                ]
            )
            update_params.extend([sig_lat, sig_lon, sig_country, sig_state, sig_city])

        if update_clauses:
            update_clauses.append("updated_at = CURRENT_TIMESTAMP")
            update_params.append(int(photo_id))
            cursor.execute(
                f"UPDATE photos SET {', '.join(update_clauses)} WHERE id = ?",
                update_params,
            )
            applied = True

        tags_raw = sig.get("tags_json")
        if tags_raw:
            try:
                tag_list = json.loads(tags_raw) if isinstance(tags_raw, str) else tags_raw
            except Exception as e:
                logger.debug(f"待機シグナルタグJSON解析スキップ: {e}")
                tag_list = []
            if isinstance(tag_list, list) and tag_list:
                all_tags: List[str] = []
                for raw_t in tag_list:
                    nt = _normalize_tag_path(str(raw_t or "").strip())
                    if nt:
                        for anc in _expand_ancestor_tags(nt):
                            if anc not in all_tags:
                                all_tags.append(anc)
                if all_tags:
                    missing_keys = [t for t in all_tags if t not in cache]
                    if missing_keys:
                        _ensure_tag_keys_registered(cursor, missing_keys)
                        cache.update(missing_keys)
                    cursor.executemany(
                        """
                        INSERT INTO photo_tags (photo_id, tag, source, confidence)
                        VALUES (?, ?, 'manual', 1.0)
                        ON CONFLICT(photo_id, tag) DO UPDATE SET
                            source = 'manual',
                            confidence = 1.0
                        """,
                        [(int(photo_id), t) for t in all_tags],
                    )
                    applied = True

        cursor.execute(
            "UPDATE mobile_pending_signals SET matched_at = COALESCE(matched_at, CURRENT_TIMESTAMP) WHERE id = ?",
            (int(sig["id"]),),
        )

    return applied
