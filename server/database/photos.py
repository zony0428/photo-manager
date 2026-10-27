"""
写真 CRUD 管理モジュール
写真メタデータの登録・検索・更新・削除、GPS操作、同期・クリーンアップを提供する。
"""

import bisect
from datetime import datetime, timedelta
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .connection import calc_solar_altitude, get_connection
from .lab_analytics import (
    _SHUTTER_SECONDS_SQL,
    _get_jp_prefecture_aliases,
    _normalize_jp_prefecture,
    get_lab_karte_data,
    get_location_heatmap_data,
    get_random_unrated_folder,
)

logger = logging.getLogger(__name__)


def _directory_filter_sql(folder: str, recursive: bool = True, column_name: str = "directory_path") -> Tuple[str, List[Any]]:
    """
    指定ディレクトリ（および配下サブディレクトリ）の絞り込みSQLフラグメントとパラメータを生成する。
    LIKE による大文字小文字インデックス不適用およびワイルドカード（_）誤一致を防止するため、
    COLLATE NOCASE と文字コード範囲比較（'\\' の次は ']'、'/' の次は '0'）を使用する。
    """
    norm = folder.rstrip("\\/")
    norm_win = norm.replace("/", "\\")
    norm_posix = norm.replace("\\", "/")

    if not recursive:
        # 指定フォルダ直下のみ（完全一致。ドライブ直下 'C:\' のような末尾区切り付き表記も一致させる）
        sql = (
            f"({column_name} = ? COLLATE NOCASE OR {column_name} = ? COLLATE NOCASE"
            f" OR {column_name} = ? COLLATE NOCASE)"
        )
        return sql, [norm_win, norm_posix, norm_win + "\\"]

    # 指定フォルダ自身、またはその配下サブフォルダ（Windows \ 区切りおよび POSIX / 区切り両対応）
    # 下限は >= とし、ドライブ直下 'C:\' のような末尾区切り付き表記も範囲に含める
    sql = (
        f"({column_name} = ? COLLATE NOCASE"
        f" OR {column_name} = ? COLLATE NOCASE"
        f" OR ({column_name} >= ? COLLATE NOCASE AND {column_name} < ? COLLATE NOCASE)"
        f" OR ({column_name} >= ? COLLATE NOCASE AND {column_name} < ? COLLATE NOCASE))"
    )
    params = [
        norm_win,
        norm_posix,
        norm_win + "\\",
        norm_win + "]",
        norm_posix + "/",
        norm_posix + "0",
    ]
    return sql, params


def _sanitize_photo_data(photo_data: Dict[str, Any]) -> Dict[str, Any]:
    """写真メタデータのデフォルト値補完とサニタイズ（NUL文字除去等）を行う共通関数"""
    clean_data = dict(photo_data)
    clean_data.setdefault("file_size", 0)
    clean_data.setdefault("file_mtime", None)
    clean_data.setdefault("width", None)
    clean_data.setdefault("height", None)
    clean_data.setdefault("date_taken", None)
    if "year_month" not in clean_data or clean_data["year_month"] is None:
        dt = clean_data.get("date_taken")
        if dt and len(str(dt)) >= 7:
            clean_data["year_month"] = str(dt)[:7].replace(":", "-")
        else:
            clean_data["year_month"] = None
    clean_data.setdefault("exposure_bias", 0.0)
    clean_data.setdefault("shutter_speed", None)
    clean_data.setdefault("f_number", None)
    clean_data.setdefault("iso", None)
    clean_data.setdefault("focal_length", None)
    clean_data.setdefault("lens_model", None)
    clean_data.setdefault("subsec_time", None)
    clean_data.setdefault("is_raw", 0)
    clean_data.setdefault("raw_format", None)
    clean_data.setdefault("paired_raw_path", None)
    clean_data.setdefault("volume_serial", None)
    clean_data.setdefault("latitude", None)
    clean_data.setdefault("longitude", None)
    clean_data.setdefault("gps_source", None)
    clean_data.setdefault("country", None)
    clean_data.setdefault("state", None)
    clean_data.setdefault("city", None)
    clean_data.setdefault("rotation", 0)
    clean_data.setdefault("fine_angle", 0.0)
    clean_data.setdefault("crop_x", None)
    clean_data.setdefault("crop_y", None)
    clean_data.setdefault("crop_w", None)
    clean_data.setdefault("crop_h", None)
    clean_data.setdefault("crop_aspect", None)
    clean_data.setdefault("brightness", 0)
    clean_data.setdefault("contrast", 0)
    clean_data.setdefault("saturation", 0)
    clean_data.setdefault("original_date_taken", None)

    # カメラ機種名およびレンズ名のサニタイズ（NUL文字などの除去）
    cam = clean_data.get("camera_model")
    if cam:
        cleaned_cam = str(cam).replace("\x00", "").strip()
        clean_data["camera_model"] = cleaned_cam if cleaned_cam else "不明"
    else:
        clean_data["camera_model"] = "不明"

    lens = clean_data.get("lens_model")
    if lens:
        cleaned_lens = str(lens).replace("\x00", "").strip()
        clean_data["lens_model"] = cleaned_lens if cleaned_lens else None
    else:
        clean_data["lens_model"] = None

    return clean_data


_UPSERT_PHOTO_SQL = """
INSERT INTO photos (
    file_path, file_name, directory_path, file_size, file_mtime,
    width, height, date_taken, year_month, camera_model,
    exposure_bias, shutter_speed, f_number, iso, focal_length, lens_model, subsec_time,
    is_raw, raw_format, paired_raw_path, volume_serial,
    latitude, longitude, gps_source, country, state, city
) VALUES (
    :file_path, :file_name, :directory_path, :file_size, :file_mtime,
    :width, :height, :date_taken, :year_month, :camera_model,
    :exposure_bias, :shutter_speed, :f_number, :iso, :focal_length, :lens_model, :subsec_time,
    :is_raw, :raw_format, :paired_raw_path, :volume_serial,
    :latitude, :longitude, :gps_source, :country, :state, :city
)
ON CONFLICT(file_path) DO UPDATE SET
    file_size = excluded.file_size,
    file_mtime = excluded.file_mtime,
    width = excluded.width,
    height = excluded.height,
    date_taken = CASE WHEN photos.original_date_taken IS NOT NULL AND photos.original_date_taken != '' THEN photos.date_taken ELSE excluded.date_taken END,
    year_month = CASE WHEN photos.original_date_taken IS NOT NULL AND photos.original_date_taken != '' THEN photos.year_month ELSE excluded.year_month END,
    camera_model = excluded.camera_model,
    exposure_bias = excluded.exposure_bias,
    shutter_speed = excluded.shutter_speed,
    f_number = excluded.f_number,
    iso = excluded.iso,
    focal_length = excluded.focal_length,
    lens_model = excluded.lens_model,
    subsec_time = excluded.subsec_time,
    is_raw = excluded.is_raw,
    raw_format = excluded.raw_format,
    paired_raw_path = COALESCE(excluded.paired_raw_path, photos.paired_raw_path),
    volume_serial = COALESCE(excluded.volume_serial, photos.volume_serial),
    latitude = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.latitude ELSE COALESCE(excluded.latitude, photos.latitude) END,
    longitude = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.longitude ELSE COALESCE(excluded.longitude, photos.longitude) END,
    gps_source = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.gps_source ELSE COALESCE(excluded.gps_source, photos.gps_source) END,
    country = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.country ELSE COALESCE(excluded.country, photos.country) END,
    state = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.state ELSE COALESCE(excluded.state, photos.state) END,
    city = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.city ELSE COALESCE(excluded.city, photos.city) END,
    updated_at = CURRENT_TIMESTAMP
"""


def upsert_photo(photo_data: Dict[str, Any]) -> int:
    """写真情報を挿入または更新する"""
    clean_data = _sanitize_photo_data(photo_data)
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(_UPSERT_PHOTO_SQL, clean_data)
        conn.commit()
        return cursor.lastrowid or 0


def upsert_photos_batch(list_of_meta: List[Dict[str, Any]]) -> None:
    """複数の写真情報を1トランザクションで一括挿入または更新する（バッチコミット）"""
    if not list_of_meta:
        return
    cleaned_batch = [_sanitize_photo_data(m) for m in list_of_meta]
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.executemany(_UPSERT_PHOTO_SQL, cleaned_batch)
        conn.commit()


def _shutter_speed_seconds_sql(col: str = "p.shutter_speed") -> str:
    """シャッター速度文字列（分数 '1/250' または小数 '0.5' / '2.5s'）を露光秒数(REAL)に換算するSQL式を返す"""
    clean_col = f"TRIM(REPLACE({col}, 's', ''))"
    return f"""(CASE
        WHEN {col} IS NULL OR TRIM({col}) = '' THEN NULL
        WHEN INSTR({clean_col}, '/') > 0 THEN
            CASE
                WHEN CAST(SUBSTR({clean_col}, INSTR({clean_col}, '/') + 1) AS REAL) > 0
                THEN CAST(SUBSTR({clean_col}, 1, INSTR({clean_col}, '/') - 1) AS REAL)
                     / CAST(SUBSTR({clean_col}, INSTR({clean_col}, '/') + 1) AS REAL)
                ELSE NULL
            END
        ELSE CAST({clean_col} AS REAL)
    END)"""


def _has_xmp_sidecar_fast(
    file_path: Optional[str],
    paired_raw_path: Optional[str] = None,
    dir_file_set: Optional[set] = None,
) -> bool:
    """指定写真（またはペアRAW）と同名の .xmp サイドカーファイルが存在するか高速判定する"""
    if not file_path:
        return False
    fname = os.path.basename(file_path)
    stem, _ = os.path.splitext(fname)
    candidates = {
        f"{stem.lower()}.xmp",
        f"{fname.lower()}.xmp",
    }
    if paired_raw_path:
        raw_fname = os.path.basename(paired_raw_path)
        raw_stem, _ = os.path.splitext(raw_fname)
        candidates.add(f"{raw_stem.lower()}.xmp")
        candidates.add(f"{raw_fname.lower()}.xmp")

    if dir_file_set is not None:
        return bool(candidates & dir_file_set)

    try:
        from ..scanner import resolve_portable_path
        real_p, is_online = resolve_portable_path(file_path)
        if not is_online:
            return False
        parent_dir = real_p.parent
        for cand in candidates:
            if (parent_dir / cand).exists():
                return True
    except Exception as e:
        logger.debug(f"XMPサイドカー存在確認スキップ ({file_path}): {e}")
    return False


def invalidate_fast_cache() -> None:
    """写真一覧キャッシュおよびフォルダ集計キャッシュを無効化する"""
    try:
        from .folders import clear_folders_fs_cache
        clear_folders_fs_cache()
    except Exception as e:
        logger.debug(f"キャッシュ無効化スキップ: {e}")


def get_photos(
    folder: Optional[str] = None,
    year_month: Optional[str] = None,
    year_months: Optional[List[str]] = None,
    cameras: Optional[List[str]] = None,
    excluded_cameras: Optional[List[str]] = None,
    lenses: Optional[List[str]] = None,
    excluded_lenses: Optional[List[str]] = None,
    ratings: Optional[List[int]] = None,
    search: Optional[str] = None,
    included_tags: Optional[List[str]] = None,
    excluded_tags: Optional[List[str]] = None,
    untagged_only: bool = False,
    sort_by: str = "date_taken DESC",
    stacked: bool = True,
    limit: int = 0,
    exclude_folder: Optional[str] = None,
    unlinked_only: bool = False,
    duplicates_only: bool = False,
    country: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    no_location_only: bool = False,
    lab_filter: Optional[str] = None,
    on_this_day: Optional[str] = None,
    focal_range: Optional[str] = None,
    aperture_range: Optional[str] = None,
    attr_filter: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """条件に合致する写真一覧を取得する（タグの含む/除外排他検索、複数年月OR条件、カメラ・レンズ含む/除外条件、場所階層絞り込み、ラボ分析フィルタ、ブラケットスタック表示、重複写真抽出に対応）"""
    # デフォルト: 棄(-1)を除く全て (優・良・可: [0, 1, 2])
    if ratings is None:
        ratings = [0, 1, 2]
    query = """
        SELECT p.*,
               t.width AS thumb_width,
               t.height AS thumb_height,
               v.volume_label,
               v.drive_letter AS volume_drive,
               CASE WHEN t.photo_id IS NOT NULL THEN 1 ELSE 0 END AS has_thumbnail,
               COALESCE(dup.dup_cnt, 1) AS duplicate_count
        FROM photos p
        LEFT JOIN volumes v ON p.volume_serial = v.volume_serial
        LEFT JOIN thumbnails t ON p.id = t.photo_id
        LEFT JOIN (
            SELECT date_taken, file_size, COUNT(*) as dup_cnt
            FROM photos
            WHERE date_taken IS NOT NULL AND date_taken != '' AND file_size > 0
              AND IFNULL(is_unlinked, 0) = 0
            GROUP BY date_taken, file_size
            HAVING dup_cnt > 1
        ) dup ON p.date_taken = dup.date_taken AND p.file_size = dup.file_size
        WHERE p.rating IN ({})
    """.format(','.join(['?'] * len(ratings)))
    params: List[Any] = list(ratings)

    # リンク消失写真（実体パス未登録）の切り替え
    if unlinked_only:
        query += " AND p.is_unlinked = 1"
    else:
        query += " AND (p.is_unlinked IS NULL OR p.is_unlinked = 0)"

    # 重複写真（他フォルダコピーあり）のみ
    if duplicates_only:
        query += " AND dup.dup_cnt > 1"

    # 場所（国・都道府県・市区町村）フィルタ
    if no_location_only:
        query += " AND (p.latitude IS NULL OR p.country IS NULL OR p.country = '' OR (ABS(p.latitude) < 0.0001 AND ABS(p.longitude) < 0.0001))"
    else:
        if country:
            if country in ("日本", "Japan", "JP"):
                query += " AND p.country IN ('日本', 'Japan', 'JP')"
            else:
                query += " AND p.country = ?"
                params.append(country)
        if state:
            aliases = _get_jp_prefecture_aliases(state)
            if aliases and len(aliases) > 1:
                placeholders = ",".join(["?"] * len(aliases))
                query += f" AND p.state IN ({placeholders})"
                params.extend(aliases)
            else:
                query += " AND p.state = ?"
                params.append(state)
        if city:
            query += " AND p.city = ?"
            params.append(city)

    if folder:
        dir_sql, dir_params = _directory_filter_sql(folder, recursive=True, column_name="p.directory_path")
        query += f" AND {dir_sql}"
        params.extend(dir_params)

    # フォルダ除外絞り込み（指定フォルダおよび配下を除外）
    if exclude_folder:
        ex_sql, ex_params = _directory_filter_sql(exclude_folder, recursive=True, column_name="p.directory_path")
        query += f" AND NOT {ex_sql}"
        params.extend(ex_params)

    # タイムライン複数年月フィルタ（OR条件）
    target_yms = list(year_months) if year_months else []
    if year_month and year_month not in target_yms:
        target_yms.append(year_month)

    if target_yms:
        placeholders = ",".join(["?"] * len(target_yms))
        query += f" AND p.year_month IN ({placeholders})"
        params.extend(target_yms)

    # カメラ機種・レンズ [+] (include) 条件（同一機材カテゴリ内は OR 結合）
    equip_inc_clauses: List[str] = []
    equip_inc_params: List[Any] = []
    if cameras:
        placeholders = ",".join(["?"] * len(cameras))
        equip_inc_clauses.append(f"p.camera_model IN ({placeholders})")
        equip_inc_params.extend(cameras)

    if lenses:
        for lens_spec in lenses:
            if "::" in lens_spec:
                cam_part, lens_part = lens_spec.split("::", 1)
                if lens_part == "__NONE__":
                    equip_inc_clauses.append(
                        "(p.camera_model = ? AND (p.lens_model IS NULL OR TRIM(p.lens_model) = ''))"
                    )
                    equip_inc_params.append(cam_part)
                else:
                    equip_inc_clauses.append("(p.camera_model = ? AND TRIM(p.lens_model) = ?)")
                    equip_inc_params.extend([cam_part, lens_part.strip()])
            else:
                if lens_spec == "__NONE__":
                    equip_inc_clauses.append("(p.lens_model IS NULL OR TRIM(p.lens_model) = '')")
                else:
                    equip_inc_clauses.append("TRIM(p.lens_model) = ?")
                    equip_inc_params.append(lens_spec.strip())

    if equip_inc_clauses:
        query += f" AND ({' OR '.join(equip_inc_clauses)})"
        params.extend(equip_inc_params)

    # カメラ機種 [-] (exclude) 条件
    if excluded_cameras:
        placeholders = ",".join(["?"] * len(excluded_cameras))
        query += f" AND (p.camera_model IS NULL OR p.camera_model NOT IN ({placeholders}))"
        params.extend(excluded_cameras)

    # レンズ [-] (exclude) 条件
    if excluded_lenses:
        for ex_spec in excluded_lenses:
            if "::" in ex_spec:
                cam_part, lens_part = ex_spec.split("::", 1)
                if lens_part == "__NONE__":
                    query += " AND NOT (p.camera_model = ? AND (p.lens_model IS NULL OR TRIM(p.lens_model) = ''))"
                    params.append(cam_part)
                else:
                    query += " AND NOT (p.camera_model = ? AND TRIM(p.lens_model) = ?)"
                    params.extend([cam_part, lens_part.strip()])
            else:
                if ex_spec == "__NONE__":
                    query += " AND NOT (p.lens_model IS NULL OR TRIM(p.lens_model) = '')"
                else:
                    query += " AND (p.lens_model IS NULL OR TRIM(p.lens_model) != ?)"
                    params.append(ex_spec.strip())

    # ラボ分析フィルタ（手ブレ警告・ゴールデンアワー・ブルーアワー・マジックアワー・夜景）
    if lab_filter:
        lf = lab_filter.strip().lower()
        if lf == "shake_risk":
            query += (
                f" AND p.focal_length IS NOT NULL AND p.focal_length > 0"
                f" AND p.shutter_speed IS NOT NULL AND p.shutter_speed != ''"
                f" AND ({_SHUTTER_SECONDS_SQL} * p.focal_length) >= 1.0"
            )
        elif lf == "golden_hour":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -4.0 AND 6.0"
            )
        elif lf == "blue_hour":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -8.0 AND -4.0001"
            )
        elif lf == "magic_all":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -8.0 AND 6.0"
            )
        elif lf == "night":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) < -8.0"
            )

    # 過去の今日（MM-DD 形式）フィルタ（YYYY-MM-DD と YYYY:MM:DD の両方に対応）
    if on_this_day and len(on_this_day.strip()) == 5:
        otd_dash = on_this_day.strip().replace(":", "-")
        otd_colon = otd_dash.replace("-", ":")
        query += " AND p.date_taken IS NOT NULL AND SUBSTR(p.date_taken, 6, 5) IN (?, ?)"
        params.extend([otd_dash, otd_colon])

    # 焦点距離レンジ（"min-max" 形式）フィルタ
    if focal_range and "-" in focal_range:
        try:
            f_min_s, f_max_s = focal_range.split("-", 1)
            f_min, f_max = float(f_min_s), float(f_max_s)
            query += " AND p.focal_length IS NOT NULL AND p.focal_length BETWEEN ? AND ?"
            params.extend([f_min, f_max])
        except ValueError as e:
            logger.debug(f"焦点距離レンジのパースに失敗しました ({focal_range}): {e}")

    # F値レンジ（"min-max" 形式）フィルタ
    if aperture_range and "-" in aperture_range:
        try:
            a_min_s, a_max_s = aperture_range.split("-", 1)
            a_min, a_max = float(a_min_s), float(a_max_s)
            query += " AND p.f_number IS NOT NULL AND p.f_number BETWEEN ? AND ?"
            params.extend([a_min, a_max])
        except ValueError as e:
            logger.debug(f"F値レンジのパースに失敗しました ({aperture_range}): {e}")

    # 属性フィルタ（RAW / JPEG / RAW+JPEGペア / XMPサイドカー / 非破壊調整済み）
    if attr_filter:
        af = attr_filter.strip().lower()
        if af == "raw":
            query += " AND (p.is_raw = 1 OR (p.paired_raw_path IS NOT NULL AND p.paired_raw_path != ''))"
        elif af == "jpeg":
            query += " AND COALESCE(p.is_raw, 0) = 0"
        elif af == "raw_pair":
            query += " AND (p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')"
        elif af == "adjusted":
            query += (
                " AND (COALESCE(p.rotation, 0) != 0"
                " OR ABS(COALESCE(p.fine_angle, 0.0)) > 0.01"
                " OR COALESCE(p.brightness, 0) != 0"
                " OR COALESCE(p.contrast, 0) != 0"
                " OR COALESCE(p.saturation, 0) != 0"
                " OR (p.crop_w IS NOT NULL AND p.crop_h IS NOT NULL"
                " AND (p.crop_w < 0.999 OR p.crop_h < 0.999 OR COALESCE(p.crop_x, 0.0) > 0.001 OR COALESCE(p.crop_y, 0.0) > 0.001)))"
            )

    # ファイル名検索（ユーザー要望によりファイル名限定）
    if search:
        query += " AND p.file_name LIKE ?"
        params.append(f"%{search}%")

    # スタック表示モード時: スタックの代表写真(is_stack_primary=1)または単独写真(stack_id IS NULL)を表示
    # ※特定フォルダ絞り込み時: 重複スタック(stack_type='duplicate')の代表が他フォルダにある場合でも、
    # 当該フォルダ配下に実在するメンバーを代表としてフォールバック表示する（写真の消失防止）
    if stacked:
        if folder:
            sub_dir_sql, sub_dir_params = _directory_filter_sql(folder, recursive=True, column_name="p_sub.directory_path")
            query += f""" AND (
                p.is_stack_primary = 1 
                OR p.stack_id IS NULL
                OR (
                    p.stack_type = 'duplicate' 
                    AND p.id = (
                        SELECT p_sub.id 
                        FROM photos p_sub 
                        WHERE p_sub.stack_id = p.stack_id 
                          AND {sub_dir_sql}
                        ORDER BY p_sub.is_stack_primary DESC, p_sub.id ASC 
                        LIMIT 1
                    )
                )
            )"""
            params.extend(sub_dir_params)
        else:
            query += " AND (p.is_stack_primary = 1 OR p.stack_id IS NULL)"

    # ペア済みRAW（JPEGペアが存在する）はグリッドから常に除外
    # RAW単体（ペアなし）はそのまま表示される
    query += " AND NOT (p.is_raw = 1 AND p.paired_raw_path IS NOT NULL)"

    # 未分類（タグなし）のみ
    if untagged_only:
        query += " AND p.id NOT IN (SELECT photo_id FROM photo_tags)"
    else:
        # 階層タグ排他検索: 含むタグ（祖先ノード独立保存により完全一致で十分）
        if included_tags:
            for tag in included_tags:
                query += " AND p.id IN (SELECT photo_id FROM photo_tags WHERE tag = ?)"
                params.extend([tag])

        # 階層タグ排他検索: 除外するタグ（祖先ノード独立保存により完全一致で十分）
        if excluded_tags:
            for tag in excluded_tags:
                query += " AND p.id NOT IN (SELECT photo_id FROM photo_tags WHERE tag = ?)"
                params.extend([tag])

    # ソート条件の検証
    ss_sql = _shutter_speed_seconds_sql("p.shutter_speed")
    shutter_fast_sql = f"CASE WHEN ({ss_sql}) IS NULL OR ({ss_sql}) <= 0 THEN 1 ELSE 0 END ASC, ({ss_sql}) ASC, p.date_taken DESC, p.id DESC"
    shutter_slow_sql = f"CASE WHEN ({ss_sql}) IS NULL OR ({ss_sql}) <= 0 THEN 1 ELSE 0 END ASC, ({ss_sql}) DESC, p.date_taken DESC, p.id DESC"
    valid_sorts = {
        "date_taken DESC": "p.date_taken DESC, p.file_name ASC",
        "date_taken ASC": "p.date_taken ASC, p.file_name ASC",
        "rating DESC": "p.rating DESC, p.date_taken DESC",
        "file_name ASC": "p.file_name ASC",
        "file_name DESC": "p.file_name DESC",
        "file_size DESC": "COALESCE(p.file_size, 0) DESC, p.date_taken DESC",
        "file_size ASC": "COALESCE(p.file_size, 0) ASC, p.date_taken DESC",
        "focal_length ASC": "CASE WHEN p.focal_length IS NULL OR p.focal_length <= 0 THEN 1 ELSE 0 END ASC, p.focal_length ASC, p.date_taken DESC",
        "focal_length DESC": "CASE WHEN p.focal_length IS NULL OR p.focal_length <= 0 THEN 1 ELSE 0 END ASC, p.focal_length DESC, p.date_taken DESC",
        "f_number ASC": "CASE WHEN p.f_number IS NULL OR p.f_number <= 0 THEN 1 ELSE 0 END ASC, p.f_number ASC, p.date_taken DESC",
        "f_number DESC": "CASE WHEN p.f_number IS NULL OR p.f_number <= 0 THEN 1 ELSE 0 END ASC, p.f_number DESC, p.date_taken DESC",
        "iso DESC": "CASE WHEN p.iso IS NULL OR p.iso <= 0 THEN 1 ELSE 0 END ASC, p.iso DESC, p.date_taken DESC",
        "iso ASC": "CASE WHEN p.iso IS NULL OR p.iso <= 0 THEN 1 ELSE 0 END ASC, p.iso ASC, p.date_taken DESC",
        "shutter_fast": shutter_fast_sql,
        "shutter_slow": shutter_slow_sql,
        "shutter_speed ASC": shutter_fast_sql,
        "shutter_speed DESC": shutter_slow_sql,
    }
    order_clause = valid_sorts.get(sort_by, "p.date_taken DESC, p.file_name ASC")
    query += f" ORDER BY {order_clause}"

    # 大量写真時のメモリ・描画負荷を防止するための上限
    if limit and limit > 0:
        query += f" LIMIT {int(limit)}"

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.row_factory = None
        cursor.execute(query, params)
        col_names = [d[0] for d in cursor.description]
        rows = cursor.fetchall()
        photos = [dict(zip(col_names, row)) for row in rows]

        if photos:
            # ディレクトリ単位のファイル一覧を1回スキャンして XMP サイドカー有無を O(1) で判定
            dir_files_map: Dict[str, Optional[set]] = {}
            try:
                from ..scanner import resolve_portable_path
                from .folders import _PHOTO_DIR_SCAN_CACHE, _PHOTO_DIR_SCAN_TTL
                import time as _time
                now_ts = _time.monotonic()
                unique_dirs = {p.get("directory_path") for p in photos if p.get("directory_path")}
                for d_path in unique_dirs:
                    cached = _PHOTO_DIR_SCAN_CACHE.get(d_path)
                    if cached and (now_ts - cached[0]) <= _PHOTO_DIR_SCAN_TTL:
                        dir_files_map[d_path] = cached[4]
                    else:
                        resolved_dir, is_online = resolve_portable_path(d_path)
                        if is_online and resolved_dir:
                            try:
                                with os.scandir(str(resolved_dir)) as it:
                                    dir_files_map[d_path] = {entry.name.lower() for entry in it}
                            except Exception as e:
                                logger.debug(f"XMP判定用ディレクトリスキャン失敗 ({resolved_dir}): {e}")
                                dir_files_map[d_path] = None
                        else:
                            dir_files_map[d_path] = None
            except Exception as e:
                logger.debug(f"XMP判定キャッシュ準備スキップ: {e}")

            for p in photos:
                p["original_date_taken"] = p.get("original_date_taken")
                d_path = p.get("directory_path")
                f_set = dir_files_map.get(d_path) if d_path else None
                p["has_xmp"] = _has_xmp_sidecar_fast(
                    p.get("file_path"),
                    p.get("paired_raw_path"),
                    dir_file_set=f_set,
                )

            if (attr_filter or "").strip().lower() == "xmp":
                photos = [p for p in photos if p.get("has_xmp")]

        if photos:
            photo_ids = [p["id"] for p in photos]
            photo_id_set = set(photo_ids)
            tags_map: Dict[int, List[str]] = {}
            tag_details_map: Dict[int, List[Dict[str, Any]]] = {}
            chunk_size = 900

            if len(photo_ids) > 1500:
                cursor.execute("SELECT photo_id, tag, source, confidence FROM photo_tags")
                for pid, tag_val, src_val, conf_val in cursor.fetchall():
                    if pid in photo_id_set:
                        tags_map.setdefault(pid, []).append(tag_val)
                        tag_details_map.setdefault(pid, []).append({
                            "tag": tag_val,
                            "source": src_val or "manual",
                            "confidence": conf_val if conf_val is not None else 1.0,
                        })
            else:
                for i in range(0, len(photo_ids), chunk_size):
                    id_chunk = photo_ids[i:i + chunk_size]
                    cursor.execute(
                        f"SELECT photo_id, tag, source, confidence FROM photo_tags WHERE photo_id IN ({','.join(['?']*len(id_chunk))})",
                        id_chunk
                    )
                    for pid, tag_val, src_val, conf_val in cursor.fetchall():
                        tags_map.setdefault(pid, []).append(tag_val)
                        tag_details_map.setdefault(pid, []).append({
                            "tag": tag_val,
                            "source": src_val or "manual",
                            "confidence": conf_val if conf_val is not None else 1.0,
                        })

            for p in photos:
                pid = p["id"]
                p["tags"] = tags_map.get(pid, [])
                p["tag_details"] = tag_details_map.get(pid, [])

            # スタックメンバー情報の付与
            active_stack_ids = list({p["stack_id"] for p in photos if p.get("stack_id")})
            if active_stack_ids:
                active_stack_set = set(active_stack_ids)
                stack_map: Dict[int, List[Dict[str, Any]]] = {}
                stack_cols = [
                    "id", "file_name", "file_path", "directory_path", "file_size", "width", "height",
                    "date_taken", "subsec_time", "exposure_bias", "shutter_speed", "f_number", "camera_model",
                    "is_stack_primary", "stack_id", "rating", "is_raw", "raw_format"
                ]
                if len(active_stack_ids) > 800:
                    cursor.execute(
                        """
                        SELECT id, file_name, file_path, directory_path, file_size, width, height,
                               date_taken, subsec_time, exposure_bias, shutter_speed, f_number, camera_model,
                               is_stack_primary, stack_id, rating, is_raw, raw_format
                        FROM photos
                        WHERE stack_id IS NOT NULL
                        ORDER BY date_taken ASC, subsec_time ASC, id ASC
                        """
                    )
                    for r in cursor.fetchall():
                        sid = r[14]
                        if sid in active_stack_set:
                            stack_map.setdefault(sid, []).append(dict(zip(stack_cols, r)))
                else:
                    for i in range(0, len(active_stack_ids), chunk_size):
                        sid_chunk = active_stack_ids[i:i + chunk_size]
                        cursor.execute(
                            f"""
                            SELECT id, file_name, file_path, directory_path, file_size, width, height,
                                   date_taken, subsec_time, exposure_bias, shutter_speed, f_number, camera_model,
                                   is_stack_primary, stack_id, rating, is_raw, raw_format
                            FROM photos
                            WHERE stack_id IN ({','.join(['?']*len(sid_chunk))})
                            ORDER BY date_taken ASC, subsec_time ASC, id ASC
                            """,
                            sid_chunk
                        )
                        for r in cursor.fetchall():
                            sid = r[14]
                            stack_map.setdefault(sid, []).append(dict(zip(stack_cols, r)))

                for p in photos:
                    sid = p.get("stack_id")
                    if sid and sid in stack_map:
                        p["stack_count"] = len(stack_map[sid])
                        p["stack_photos"] = stack_map[sid]
                    else:
                        p["stack_count"] = 1
                        p["stack_photos"] = []
            else:
                for p in photos:
                    p["stack_count"] = 1
                    p["stack_photos"] = []

        return photos




def batch_update_rating(photo_ids: List[int], rating: int) -> int:
    """複数の写真の評価を一括更新する（-1:棄, 0:可, 1:良, 2:優）"""
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"UPDATE photos SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
                [rating] + chunk,
            )
            updated += cursor.rowcount
        conn.commit()
        return updated



def get_total_photos_count() -> int:
    """ライブラリに登録されている全写真の物理総数を返す"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) as count FROM photos")
        row = cursor.fetchone()
        return row["count"] if row else 0


def get_photo_by_id(photo_id: int) -> Optional[Dict[str, Any]]:
    """IDで単一の写真情報を取得する（タグ一覧＋スタックメンバー付き）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*, v.volume_label, v.drive_letter AS volume_drive
            FROM photos p
            LEFT JOIN volumes v ON p.volume_serial = v.volume_serial
            WHERE p.id = ?
            """,
            (photo_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        photo = dict(row)
        photo["original_date_taken"] = row["original_date_taken"] if "original_date_taken" in row.keys() else None
        photo["has_xmp"] = _has_xmp_sidecar_fast(
            photo.get("file_path"),
            photo.get("paired_raw_path"),
        )
        cursor.execute("SELECT tag, source, confidence FROM photo_tags WHERE photo_id = ? ORDER BY tag ASC", (photo_id,))
        tag_rows = cursor.fetchall()
        photo["tags"] = [r["tag"] for r in tag_rows]
        photo["tag_details"] = [
            {
                "tag": r["tag"],
                "source": r["source"] or "manual",
                "confidence": r["confidence"] if r["confidence"] is not None else 1.0,
            }
            for r in tag_rows
        ]

        # スタックメンバー情報の取得
        if photo.get("stack_id"):
            cursor.execute(
                """
                SELECT id, file_name, file_path, date_taken, subsec_time, exposure_bias, shutter_speed, f_number,
                       is_stack_primary, stack_id, stack_type, rating, is_raw, raw_format, paired_raw_path
                FROM photos
                WHERE stack_id = ?
                ORDER BY date_taken ASC, subsec_time ASC, id ASC
                """,
                (photo["stack_id"],)
            )
            photo["stack_photos"] = [dict(r) for r in cursor.fetchall()]
            photo["stack_count"] = len(photo["stack_photos"])
        else:
            photo["stack_photos"] = []
            photo["stack_count"] = 1

        # 重複写真（他フォルダコピー含む）情報の取得
        from .duplicates import get_duplicates_for_photo
        dups = get_duplicates_for_photo(photo_id)
        photo["duplicates"] = dups
        photo["duplicate_count"] = len(dups) if dups else 1

        return photo


def get_duplicate_photos_count() -> int:
    """ライブラリ全体で重複（同一撮影日時 ＋ 同一ファイルサイズ）が存在する写真の総数を返す"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*) as count
            FROM photos p
            INNER JOIN (
                SELECT date_taken, file_size
                FROM photos
                WHERE date_taken IS NOT NULL AND date_taken != '' AND file_size > 0
                  AND IFNULL(is_unlinked, 0) = 0
                GROUP BY date_taken, file_size
                HAVING COUNT(*) > 1
            ) dup ON p.date_taken = dup.date_taken AND p.file_size = dup.file_size
            WHERE IFNULL(p.is_unlinked, 0) = 0
            """
        )
        row = cursor.fetchone()
        return row["count"] if row else 0




def update_rating(photo_id: int, rating: int) -> bool:
    """評価を更新する（-1:棄, 0:可, 1:良, 2:優）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE photos SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (rating, photo_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def _parse_photo_datetime(dt_str: Optional[str]) -> Optional[datetime]:
    """写真の撮影日時文字列を datetime オブジェクトにパースする"""
    if not dt_str:
        return None
    s = str(dt_str).strip()
    if not s:
        return None
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y:%m:%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y:%m:%d %H:%M",
        "%Y-%m-%d",
        "%Y:%m:%d",
    ):
        try:
            return datetime.strptime(s[:19] if len(s) >= 19 else s, fmt)
        except (ValueError, TypeError):
            continue
    return None


def batch_shift_photo_dates(
    photo_ids: List[int],
    offset_seconds: int = 0,
    reset: bool = False,
) -> Dict[str, Any]:
    """
    複数写真の撮影日時（date_taken）を指定秒数だけ一括シフト、または初期撮影日時（original_date_taken）へ非破壊リセットする。
    初回シフト時はシフト前の date_taken を original_date_taken カラムに退避・保持する。
    """
    if not photo_ids:
        return {"updated_count": 0, "photos": []}

    unique_ids = list(dict.fromkeys(int(pid) for pid in photo_ids if pid is not None))
    if not unique_ids:
        return {"updated_count": 0, "photos": []}

    updated_photos: List[Dict[str, Any]] = []
    chunk_size = 500

    with get_connection() as conn:
        cursor = conn.cursor()

        if reset:
            target_rows = []
            for i in range(0, len(unique_ids), chunk_size):
                chunk = unique_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    SELECT id, date_taken, year_month, original_date_taken
                    FROM photos
                    WHERE id IN ({placeholders})
                      AND original_date_taken IS NOT NULL
                      AND original_date_taken != ''
                    """,
                    chunk,
                )
                target_rows.extend(cursor.fetchall())

            if target_rows:
                for i in range(0, len(unique_ids), chunk_size):
                    chunk = unique_ids[i:i + chunk_size]
                    placeholders = ",".join(["?"] * len(chunk))
                    cursor.execute(
                        f"""
                        UPDATE photos
                        SET date_taken = original_date_taken,
                            year_month = substr(replace(original_date_taken, ':', '-'), 1, 7),
                            original_date_taken = NULL,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id IN ({placeholders})
                          AND original_date_taken IS NOT NULL
                          AND original_date_taken != ''
                        """,
                        chunk,
                    )
                conn.commit()

                for r in target_rows:
                    orig_dt = str(r["original_date_taken"])
                    restored_ym = orig_dt.replace(":", "-")[:7] if len(orig_dt) >= 7 else None
                    updated_photos.append({
                        "id": r["id"],
                        "date_taken": orig_dt,
                        "year_month": restored_ym,
                        "original_date_taken": None,
                    })

            invalidate_fast_cache()
            return {
                "updated_count": len(updated_photos),
                "photos": updated_photos,
            }

        # reset=False の場合
        rows = []
        for i in range(0, len(unique_ids), chunk_size):
            chunk = unique_ids[i:i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"""
                SELECT id, date_taken, year_month, original_date_taken
                FROM photos
                WHERE id IN ({placeholders})
                """,
                chunk,
            )
            rows.extend(cursor.fetchall())

        if int(offset_seconds or 0) == 0:
            current_list = [
                {
                    "id": r["id"],
                    "date_taken": r["date_taken"],
                    "year_month": r["year_month"],
                    "original_date_taken": r["original_date_taken"],
                }
                for r in rows
            ]
            return {"updated_count": 0, "photos": current_list}

        delta = timedelta(seconds=int(offset_seconds))
        update_params: List[Tuple[str, str, str, int]] = []

        for r in rows:
            pid = r["id"]
            cur_dt_str = r["date_taken"]
            orig_dt_str = r["original_date_taken"]
            if not cur_dt_str:
                continue
            dt = _parse_photo_datetime(cur_dt_str)
            if dt is None:
                continue

            saved_orig = (
                str(orig_dt_str)
                if (orig_dt_str is not None and str(orig_dt_str).strip() != "")
                else str(cur_dt_str)
            )
            shifted = dt + delta
            new_dt = shifted.strftime("%Y-%m-%d %H:%M:%S")
            new_ym = shifted.strftime("%Y-%m")

            update_params.append((new_dt, new_ym, saved_orig, pid))
            updated_photos.append({
                "id": pid,
                "date_taken": new_dt,
                "year_month": new_ym,
                "original_date_taken": saved_orig,
            })

        if update_params:
            cursor.executemany(
                """
                UPDATE photos
                SET date_taken = ?,
                    year_month = ?,
                    original_date_taken = ?,
                    meta_dirty = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                update_params,
            )
            conn.commit()

    invalidate_fast_cache()
    return {
        "updated_count": len(updated_photos),
        "photos": updated_photos,
    }


def update_photo_adjustments(
    photo_id: int,
    rotation: int = 0,
    fine_angle: float = 0.0,
    crop_x: Optional[float] = None,
    crop_y: Optional[float] = None,
    crop_w: Optional[float] = None,
    crop_h: Optional[float] = None,
    crop_aspect: Optional[str] = None,
    brightness: int = 0,
    contrast: int = 0,
    saturation: int = 0,
) -> bool:
    """写真の回転角度・水平傾き補正・トリミング範囲・トーン微調整を非破壊更新する（元画像は触らない）"""
    norm_rotation = (int(rotation) % 360 + 360) % 360
    clamped_angle = round(max(-45.0, min(45.0, float(fine_angle or 0.0))), 2)
    clamped_b = max(-100, min(100, int(brightness or 0)))
    clamped_c = max(-100, min(100, int(contrast or 0)))
    clamped_s = max(-100, min(100, int(saturation or 0)))
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET rotation = ?,
                fine_angle = ?,
                crop_x = ?,
                crop_y = ?,
                crop_w = ?,
                crop_h = ?,
                crop_aspect = ?,
                brightness = ?,
                contrast = ?,
                saturation = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                norm_rotation,
                clamped_angle,
                crop_x,
                crop_y,
                crop_w,
                crop_h,
                crop_aspect,
                clamped_b,
                clamped_c,
                clamped_s,
                photo_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0


def batch_update_photo_tone(
    photo_ids: List[int],
    brightness: int = 0,
    contrast: int = 0,
    saturation: int = 0,
) -> int:
    """複数写真のトーン微調整（明るさ・コントラスト・彩度）のみを一括更新する（回転・傾き・クロップは維持）"""
    if not photo_ids:
        return 0
    clamped_b = max(-100, min(100, int(brightness or 0)))
    clamped_c = max(-100, min(100, int(contrast or 0)))
    clamped_s = max(-100, min(100, int(saturation or 0)))
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            sql = f"""
                UPDATE photos
                SET brightness = ?,
                    contrast = ?,
                    saturation = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
            """
            cursor.execute(sql, [clamped_b, clamped_c, clamped_s] + chunk)
            updated += cursor.rowcount
        conn.commit()
        return updated


def rotate_photo(photo_id: int, delta_degrees: int = 90) -> Dict[str, Any]:
    """写真の回転角度を90度単位で加算・更新する（例: 0 -> 90 -> 180 -> 270 -> 0）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT rotation FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        if not row:
            return {"success": False, "rotation": 0}
        current_rotation = row["rotation"] or 0
        new_rotation = ((current_rotation + delta_degrees) % 360 + 360) % 360
        cursor.execute(
            "UPDATE photos SET rotation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_rotation, photo_id),
        )
        conn.commit()
        return {"success": True, "photo_id": photo_id, "rotation": new_rotation}


def reset_photo_adjustments(photo_id: int) -> bool:
    """写真の回転・水平傾き補正・トリミング・トーン微調整を初期状態へリセットする"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET rotation = 0,
                fine_angle = 0.0,
                crop_x = NULL,
                crop_y = NULL,
                crop_w = NULL,
                crop_h = NULL,
                crop_aspect = NULL,
                brightness = 0,
                contrast = 0,
                saturation = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (photo_id,),
        )
        conn.commit()
        return cursor.rowcount > 0


def batch_reset_photo_adjustments(photo_ids: List[int]) -> int:
    """複数写真の回転・水平傾き補正・トリミング・トーン微調整を一括で初期状態へリセットする"""
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            sql = f"""
                UPDATE photos
                SET rotation = 0,
                    fine_angle = 0.0,
                    crop_x = NULL,
                    crop_y = NULL,
                    crop_w = NULL,
                    crop_h = NULL,
                    crop_aspect = NULL,
                    brightness = 0,
                    contrast = 0,
                    saturation = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
            """
            cursor.execute(sql, chunk)
            updated += cursor.rowcount
        conn.commit()
        return updated


def batch_rotate_photos(photo_ids: List[int], delta_degrees: int = 90) -> int:
    """複数の写真の回転角度を一括で加算・更新する"""
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            sql = f"""
                UPDATE photos
                SET rotation = (((COALESCE(rotation, 0) + ?) % 360) + 360) % 360,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
            """
            cursor.execute(sql, [delta_degrees] + chunk)
            updated += cursor.rowcount
        conn.commit()
        return updated



def update_photo_gps(photo_id: int, latitude: float, longitude: float, source: str = "copied") -> bool:
    """写真のGPS位置情報を更新する（元ファイルのEXIFは触らない）"""
    from server.geocoder import reverse_geocode
    with get_connection() as conn:
        loc = reverse_geocode(latitude, longitude, db_conn=conn)
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE photos
               SET latitude = ?, longitude = ?, gps_source = ?,
                   country = ?, state = ?, city = ?,
                   meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (latitude, longitude, source, loc.get("country"), loc.get("state"), loc.get("city"), photo_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def find_nearby_gps_photos(date_taken: str, minutes: int = 60, exclude_id: Optional[int] = None) -> Dict[str, Any]:
    """
    指定した撮影日時の ±N分 以内で GPS 情報を持つ写真を検索する。
    直前（before）と直後（after）の候補を分離し、地名情報（country, state, city）も含めて返す。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 日時文字列をパースし、BETWEEN によるインデックス範囲検索（idx_photos_gps_date）を試行
        dt = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                dt = datetime.strptime(str(date_taken).strip(), fmt)
                break
            except (ValueError, TypeError) as e:
                logger.debug(f"GPS近傍検索: 日時パース試行失敗 ({fmt}): {e}")

        if dt is not None:
            min_dt = (dt - timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
            max_dt = (dt + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
            query = """
                SELECT id, file_name, date_taken, camera_model, latitude, longitude, gps_source,
                       country, state, city,
                       CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL) AS time_diff_signed,
                       ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) AS time_diff_min
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND date_taken BETWEEN ? AND ?
            """
            params: List[Any] = [date_taken, date_taken, min_dt, max_dt]
        else:
            # 日時パース失敗時は従来の julianday クエリに安全にフォールバック
            logger.warning(f"GPS近傍検索: 日時パース失敗のため従来のjulianday走査へフォールバックします: {date_taken}")
            query = """
                SELECT id, file_name, date_taken, camera_model, latitude, longitude, gps_source,
                       country, state, city,
                       CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL) AS time_diff_signed,
                       ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) AS time_diff_min
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) <= ?
            """
            params = [date_taken, date_taken, date_taken, minutes]

        if exclude_id is not None:
            query += " AND id != ?"
            params.append(exclude_id)
        query += " ORDER BY time_diff_min ASC LIMIT 30"
        cursor.execute(query, params)
        all_candidates = [dict(row) for row in cursor.fetchall()]

        # 直前 (time_diff_signed <= 0) と 直後 (time_diff_signed > 0) の最近傍を抽出
        before_candidate = None
        after_candidate = None

        for c in all_candidates:
            diff = c.get("time_diff_signed", 0)
            if diff <= 0:
                if before_candidate is None:
                    before_candidate = c
            else:
                if after_candidate is None:
                    after_candidate = c
            if before_candidate and after_candidate:
                break

        return {
            "candidates": all_candidates,
            "before": before_candidate,
            "after": after_candidate,
        }


def batch_infer_gps(
    photo_ids: Optional[List[int]] = None,
    folder: Optional[str] = None,
    max_minutes: int = 60
) -> Dict[str, Any]:
    """
    GPS情報のない写真に対して、撮影時刻が ±max_minutes 以内で最も近い写真のGPSを準用する。
    gps_source = 'inferred' として記録。
    N+1 を解消し、対象期間のGPS付き写真を一括取得後にメモリ上二分探索して executemany で一括更新する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 対象写真の抽出（GPS未設定かつ撮影日時が存在するもの）
        if photo_ids:
            target_photos = []
            chunk_size = 500
            for i in range(0, len(photo_ids), chunk_size):
                chunk = photo_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    SELECT id, date_taken
                    FROM photos
                    WHERE id IN ({placeholders})
                      AND latitude IS NULL
                      AND date_taken IS NOT NULL AND date_taken != ''
                    """,
                    chunk
                )
                target_photos.extend(cursor.fetchall())
        elif folder:
            dir_sql, dir_params = _directory_filter_sql(folder, recursive=True, column_name="directory_path")
            cursor.execute(
                f"""
                SELECT id, date_taken
                FROM photos
                WHERE {dir_sql}
                  AND latitude IS NULL
                  AND date_taken IS NOT NULL AND date_taken != ''
                """,
                dir_params
            )
            target_photos = cursor.fetchall()
        else:
            return {"inferred_count": 0, "skipped_count": 0, "total_target": 0}

        total_target = len(target_photos)
        if total_target == 0:
            return {"inferred_count": 0, "skipped_count": 0, "total_target": 0}

        # ターゲット写真の日時パース
        parsed_targets: List[Tuple[int, datetime, str]] = []
        unparsed_targets: List[Tuple[int, str]] = []

        for p in target_photos:
            pid = p["id"]
            date_taken = p["date_taken"]
            dt = None
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
                try:
                    dt = datetime.strptime(str(date_taken).strip(), fmt)
                    break
                except (ValueError, TypeError) as e:
                    logger.debug(f"GPS一括推定: ターゲット日時パース試行失敗 ({fmt}): {e}")

            if dt is not None:
                parsed_targets.append((pid, dt, date_taken))
            else:
                unparsed_targets.append((pid, date_taken))

        update_params = []

        # パース成功したターゲットの写真について一括範囲検索
        if parsed_targets:
            min_dt_target = min(item[1] for item in parsed_targets)
            max_dt_target = max(item[1] for item in parsed_targets)

            overall_min = (min_dt_target - timedelta(minutes=max_minutes)).strftime("%Y-%m-%d %H:%M:%S")
            overall_max = (max_dt_target + timedelta(minutes=max_minutes)).strftime("%Y-%m-%d %H:%M:%S")

            cursor.execute(
                """
                SELECT id, latitude, longitude, country, state, city, date_taken
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND date_taken BETWEEN ? AND ?
                ORDER BY date_taken ASC
                """,
                (overall_min, overall_max)
            )
            gps_rows = cursor.fetchall()

            # GPS候補写真の日時パース
            gps_candidates: List[Tuple[datetime, Any]] = []
            for row in gps_rows:
                raw_dt = row["date_taken"]
                c_dt = None
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
                    try:
                        c_dt = datetime.strptime(str(raw_dt).strip(), fmt)
                        break
                    except (ValueError, TypeError) as e:
                        logger.debug(f"GPS一括推定: 候補日時パース試行失敗 ({fmt}): {e}")
                if c_dt is not None:
                    gps_candidates.append((c_dt, row))

            gps_candidates.sort(key=lambda x: x[0])
            gps_times = [c[0] for c in gps_candidates]

            for pid, dt, date_taken in parsed_targets:
                if not gps_times:
                    continue

                idx = bisect.bisect_left(gps_times, dt)
                best_diff = None
                best_candidate = None

                # 直前 (idx - 1)
                if idx > 0:
                    diff_before = abs((gps_times[idx - 1] - dt).total_seconds()) / 60.0
                    if diff_before <= max_minutes:
                        best_diff = diff_before
                        best_candidate = gps_candidates[idx - 1][1]

                # 直後 (idx)
                if idx < len(gps_times):
                    diff_after = abs((gps_times[idx] - dt).total_seconds()) / 60.0
                    if diff_after <= max_minutes:
                        # 直前・直後で等しい場合は直後を採用（SQLite julianday の評価順と合致）
                        if best_diff is None or diff_after <= best_diff:
                            best_diff = diff_after
                            best_candidate = gps_candidates[idx][1]

                if best_candidate and best_candidate["latitude"] is not None:
                    update_params.append((
                        best_candidate["latitude"],
                        best_candidate["longitude"],
                        best_candidate["country"],
                        best_candidate["state"],
                        best_candidate["city"],
                        pid
                    ))

        # パース失敗した珍しいターゲットがあれば個別にフォールバック
        for pid, date_taken in unparsed_targets:
            cursor.execute(
                """
                SELECT latitude, longitude, country, state, city,
                       ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) AS time_diff_min
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) <= ?
                ORDER BY time_diff_min ASC
                LIMIT 1
                """,
                (date_taken, date_taken, max_minutes)
            )
            nearest = cursor.fetchone()
            if nearest and nearest["latitude"] is not None:
                update_params.append((
                    nearest["latitude"],
                    nearest["longitude"],
                    nearest["country"],
                    nearest["state"],
                    nearest["city"],
                    pid
                ))

        if update_params:
            cursor.executemany(
                """
                UPDATE photos
                SET latitude = ?, longitude = ?, gps_source = 'inferred',
                    country = ?, state = ?, city = ?,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                update_params
            )

        conn.commit()
        inferred_count = len(update_params)
        return {
            "inferred_count": inferred_count,
            "skipped_count": total_target - inferred_count,
            "total_target": total_target,
        }


def clear_inferred_gps(
    photo_ids: Optional[List[int]] = None,
    folder: Optional[str] = None
) -> int:
    """
    準用（gps_source = 'inferred'）された写真のGPSおよび地名をリセットする。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        if photo_ids:
            chunk_size = 500
            for i in range(0, len(photo_ids), chunk_size):
                chunk = photo_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    UPDATE photos
                    SET latitude = NULL, longitude = NULL, gps_source = NULL,
                        country = NULL, state = NULL, city = NULL,
                        meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id IN ({placeholders}) AND gps_source = 'inferred'
                    """,
                    chunk
                )
                updated += cursor.rowcount
        elif folder:
            dir_sql, dir_params = _directory_filter_sql(folder, recursive=True, column_name="directory_path")
            cursor.execute(
                f"""
                UPDATE photos
                SET latitude = NULL, longitude = NULL, gps_source = NULL,
                    country = NULL, state = NULL, city = NULL,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE {dir_sql} AND gps_source = 'inferred'
                """,
                dir_params
            )
            updated = cursor.rowcount
        else:
            return 0

        conn.commit()
        return updated


def clear_photo_gps(
    photo_ids: Optional[List[int]] = None,
    folder: Optional[str] = None
) -> int:
    """
    指定写真（またはフォルダ内写真）のSQLite上のジオタグ情報（緯度・経度・ソース・国・県・市）をリセットする。
    gps_sourceの種類を問わずクリアする。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        if photo_ids:
            chunk_size = 500
            for i in range(0, len(photo_ids), chunk_size):
                chunk = photo_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    UPDATE photos
                    SET latitude = NULL, longitude = NULL, gps_source = NULL,
                        country = NULL, state = NULL, city = NULL,
                        meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id IN ({placeholders})
                    """,
                    chunk
                )
                updated += cursor.rowcount
        elif folder:
            dir_sql, dir_params = _directory_filter_sql(folder, recursive=True, column_name="directory_path")
            cursor.execute(
                f"""
                UPDATE photos
                SET latitude = NULL, longitude = NULL, gps_source = NULL,
                    country = NULL, state = NULL, city = NULL,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE {dir_sql}
                """,
                dir_params
            )
            updated = cursor.rowcount
        else:
            return 0

        conn.commit()
        return updated


def cleanup_invalid_zero_gps() -> int:
    """
    緯度経度が (0.0, 0.0) 付近の無効なGPSエラー（未測位/Null Island）データをSQLite上でリセットする。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET latitude = NULL, longitude = NULL, gps_source = NULL,
                country = NULL, state = NULL, city = NULL,
                meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
              AND ABS(latitude) < 0.0001 AND ABS(longitude) < 0.0001
            """
        )
        conn.commit()
        return cursor.rowcount


def batch_copy_gps(source_photo_id: int, target_photo_ids: List[int]) -> int:
    """指定した写真のGPSを複数の写真に一括コピーする"""
    from server.geocoder import reverse_geocode
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT latitude, longitude FROM photos WHERE id = ?", (source_photo_id,))
        source = cursor.fetchone()
        if not source or source["latitude"] is None or source["longitude"] is None:
            return 0
        lat, lng = source["latitude"], source["longitude"]
        loc = reverse_geocode(lat, lng, db_conn=conn)
        count = 0
        unique_ids = list(dict.fromkeys(target_photo_ids))
        for i in range(0, len(unique_ids), 500):
            chunk = unique_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"""UPDATE photos
                   SET latitude = ?, longitude = ?, gps_source = 'copied',
                       country = ?, state = ?, city = ?,
                       meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                   WHERE id IN ({placeholders})""",
                (lat, lng, loc.get("country"), loc.get("state"), loc.get("city"), *chunk),
            )
            count += cursor.rowcount
        conn.commit()
        return count


def backfill_photo_locations(limit: int = 5000) -> int:
    """
    GPS座標（latitude, longitude）があるが国・県・市（country）が未設定の写真に対して
    逆ジオコーディングを一括実行して地名を補完する。UPDATE を executemany で一括実行。
    """
    from server.geocoder import reverse_geocode
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, latitude, longitude
            FROM photos
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
              AND country IS NULL
            LIMIT ?
            """,
            (limit,)
        )
        rows = cursor.fetchall()
        if not rows:
            return 0

        update_params = []
        for row in rows:
            pid = row["id"]
            lat = row["latitude"]
            lon = row["longitude"]
            loc = reverse_geocode(lat, lon, db_conn=conn)
            update_params.append((loc.get("country"), loc.get("state"), loc.get("city"), pid))

        if update_params:
            cursor.executemany(
                """
                UPDATE photos
                SET country = ?, state = ?, city = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                update_params
            )

        conn.commit()
        return len(update_params)


def backfill_missing_lens_models(
    directory_path: Optional[str] = None,
    recursive: bool = True,
    only_interchangeable_cameras: bool = False,
    limit: int = 30000,
) -> int:
    """
    lens_model が未設定（NULL / 空文字 / '----'）の写真ファイルから、
    Panasonic MakerNote (0x0051) や XMP (aux:Lens) 等のレンズ機種名を高速抽出し、DBへ一括補完する。
    """
    from concurrent.futures import ThreadPoolExecutor
    from server.raw_loader import extract_fallback_lens_model, is_valid_lens_name
    from server.scanner import resolve_portable_path

    where_clauses = [
        "(is_unlinked IS NULL OR is_unlinked = 0)",
        "(lens_model IS NULL OR TRIM(lens_model) = '' OR lens_model = '----')",
    ]
    params: List[Any] = []

    if directory_path:
        dir_sql, dir_params = _directory_filter_sql(directory_path, recursive=recursive, column_name="directory_path")
        where_clauses.append(dir_sql)
        params.extend(dir_params)

    if only_interchangeable_cameras:
        where_clauses.append(
            "("
            "camera_model LIKE 'DC-%' OR camera_model LIKE 'DMC-G%' OR camera_model LIKE 'DMC-GH%' "
            "OR camera_model LIKE 'DMC-GF%' OR camera_model LIKE 'DMC-GX%' OR camera_model LIKE 'DMC-GM%' "
            "OR camera_model LIKE 'LUMIX%' OR camera_model LIKE 'NIKON D%' OR camera_model LIKE 'NIKON Z%' "
            "OR camera_model LIKE 'Canon EOS%' OR camera_model LIKE 'ILCE-%' OR camera_model LIKE 'NEX-%' "
            "OR camera_model LIKE 'sd Quattro%' OR camera_model LIKE 'DP%' OR is_raw = 1"
            ")"
        )

    params.append(limit)
    query = f"""
        SELECT id, file_path
        FROM photos
        WHERE {' AND '.join(where_clauses)}
        LIMIT ?
    """

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        rows = [(r["id"], r["file_path"]) for r in cursor.fetchall()]

    if not rows:
        return 0

    def _probe_one(item: Tuple[int, str]) -> Optional[Tuple[str, int]]:
        pid, fpath = item
        try:
            target_path, is_online = resolve_portable_path(fpath)
            if not is_online or not target_path:
                return None
            lens = extract_fallback_lens_model(target_path)
            if lens and is_valid_lens_name(lens):
                return (lens, pid)
        except Exception as e:
            logger.debug(f"レンズ機種名抽出失敗 ({fpath}): {e}")
        return None

    updated_total = 0
    chunk_size = 500
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i in range(0, len(rows), chunk_size):
            chunk = rows[i:i + chunk_size]
            results = [r for r in pool.map(_probe_one, chunk) if r is not None]
            if results:
                with get_connection() as conn:
                    cursor = conn.cursor()
                    cursor.executemany(
                        "UPDATE photos SET lens_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                        results,
                    )
                    conn.commit()
                    updated_total += len(results)

    return updated_total



def get_existing_photos_map(directory_path: str, recursive: bool = True) -> Dict[str, Tuple[int, int, Optional[float]]]:
    """
    指定ディレクトリ配下の登録済み写真の {file_path: (id, file_size, file_mtime)} マップを取得する。
    1回のクエリで先読みし、再スキャン時の差分判定および移動照合を高速化する。
    """
    sql_frag, params = _directory_filter_sql(directory_path, recursive=recursive, column_name="directory_path")
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT id, file_path, file_size, file_mtime FROM photos WHERE {sql_frag}",
            params,
        )
        res = {}
        for row in cursor.fetchall():
            val = (row["id"], row["file_size"], row["file_mtime"])
            res[row["file_path"]] = val
            res[os.path.normcase(os.path.abspath(row["file_path"]))] = val
        return res


def get_photo_by_path(file_path: str) -> Optional[Dict[str, Any]]:
    """ファイルパスで写真情報を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM photos WHERE file_path = ?", (file_path,))
        row = cursor.fetchone()
        return dict(row) if row else None


def find_missing_photo_match(
    file_name: str,
    file_size: int,
    date_taken: Optional[str] = None,
    camera_model: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    実ファイルが現在存在しない（移動元となった）既存写真レコードの中から、
    Exif撮影日時・ファイルサイズ・ファイル名などの特徴量が一致する同一写真を照合・探索する
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 最優先: ファイル名 + 撮影日時 + ファイルサイズ の完全一致（確度 100%）
        if date_taken:
            cursor.execute(
                """
                SELECT * FROM photos
                WHERE file_name = ? AND date_taken = ? AND file_size = ?
                """,
                (file_name, date_taken, file_size),
            )
            for row in cursor.fetchall():
                # 実ファイルが既に存在しなくなっている（移動された）ことを確認
                if not os.path.exists(row["file_path"]):
                    return dict(row)

        # 2. 次点: 撮影日時 + ファイルサイズ + カメラ機種（リネームされて移動したケース）
        if date_taken and camera_model and camera_model != "不明":
            cursor.execute(
                """
                SELECT * FROM photos
                WHERE date_taken = ? AND file_size = ? AND camera_model = ?
                """,
                (date_taken, file_size, camera_model),
            )
            for row in cursor.fetchall():
                if not os.path.exists(row["file_path"]):
                    return dict(row)

        # 3. 日時なし画像の場合: ファイル名 + ファイルサイズ
        cursor.execute(
            """
            SELECT * FROM photos
            WHERE file_name = ? AND file_size = ?
            """,
            (file_name, file_size),
        )
        for row in cursor.fetchall():
            if not os.path.exists(row["file_path"]):
                return dict(row)

        return None


def relink_photo_path(photo_id: int, new_path: str, new_dir: str) -> bool:
    """移動した写真レコードのパス情報を更新し、既存のタグ・星評価を完全維持して再紐付けする"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET file_path = ?, directory_path = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (new_path, new_dir, photo_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def cleanup_missing_photos_in_folder(directory_path: str, recursive: bool = False) -> int:
    """指定フォルダのファイル存在チェックを行い、
    実ファイルが消えている写真のDB レコード（写真・タグ・サムネイル）を安全に削除する。
    recursive=False は直下のみ、True は配下サブフォルダも対象とする。
    スタックメンバーが削除された場合は同じ範囲のスタック整合性を自動修復する。
    ドライブ未接続（オフライン）やドライブレター変動時に誤って全件削除しないよう、
    resolve_portable_path でオンラインと判定できた写真のみを削除対象とする。"""
    from ..scanner import resolve_portable_path
    norm_win = os.path.normpath(directory_path).rstrip("\\/")
    sql_frag, sql_params = _directory_filter_sql(directory_path, recursive=recursive, column_name="directory_path")

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT id, file_path, stack_id, is_stack_primary FROM photos
            WHERE {sql_frag}
            """,
            sql_params,
        )
        rows = cursor.fetchall()
        missing_ids = []
        for r in rows:
            f_path, is_online = resolve_portable_path(r["file_path"])
            if is_online and not os.path.exists(str(f_path)):
                missing_ids.append(r["id"])

        if missing_ids:
            for i in range(0, len(missing_ids), 500):
                chunk = missing_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)
            conn.commit()

            # スタックの健全性を即座に修復（実在写真のみでスタックを再編成）
            try:
                from .stacks import recalculate_stacks
                recalculate_stacks(norm_win, recursive=recursive)
            except Exception as stack_err:
                print(f"[WARN] スタック修復エラー（削除自体は完了）: {stack_err}")

            return len(missing_ids)
        return 0


def cleanup_missing_upload_photos(upload_dir: Path) -> int:
    """
    storage（旧 carry）フォルダ配下の写真で、実ファイルが削除されたレコードをDBから完全にクリーンアップする。
    （サブフォルダ内の写真およびポータブル移動時の相対パスも検証し、実在する写真は確実に保持する）
    """
    from ..scanner import resolve_portable_path

    upload_dir_resolved = upload_dir.resolve()
    upload_dir_str = str(upload_dir_resolved).rstrip("\\/")
    upload_dir_low = upload_dir_str.lower()

    dir_sql, dir_params = _directory_filter_sql(upload_dir_str, recursive=True, column_name="directory_path")
    fp_sql, fp_params = _directory_filter_sql(upload_dir_str, recursive=True, column_name="file_path")

    with get_connection() as conn:
        cursor = conn.cursor()
        # storage ディレクトリ（およびサブフォルダ）配下の写真を検索
        cursor.execute(
            f"""
            SELECT id, file_path, directory_path
            FROM photos
            WHERE {dir_sql} OR {fp_sql}
            """,
            dir_params + fp_params,
        )
        rows = cursor.fetchall()
        if not rows:
            return 0

        missing_ids = []
        for r in rows:
            raw_fp = r["file_path"] or ""
            p_path = Path(raw_fp)
            is_present = p_path.exists()

            if not is_present:
                resolved_p, is_online = resolve_portable_path(raw_fp)
                if is_online and resolved_p.exists():
                    is_present = True

            if not is_present:
                norm_fp = raw_fp.replace("/", "\\")
                if norm_fp.lower().startswith(upload_dir_low + "\\"):
                    rel_sub = norm_fp[len(upload_dir_str):].lstrip("\\")
                    if rel_sub and (upload_dir_resolved / rel_sub).exists():
                        is_present = True

            if not is_present:
                missing_ids.append(r["id"])

        if missing_ids:
            # SQLiteの変数上限（999個）を回避するため500件ずつチャンク削除
            for i in range(0, len(missing_ids), 500):
                chunk = missing_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)
            conn.commit()
            print(f"[INFO] storage 内のリンク切れ写真 {len(missing_ids)} 件をDBから自動クリーンアップしました。")
            return len(missing_ids)
        return 0


def delete_photo_by_id(photo_id: int, delete_file: bool = False) -> bool:
    """
    指定されたIDの写真をDB（およびオプションで実ファイル）から削除する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT file_path FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        if not row:
            return False

        file_path_str = row["file_path"]

        cursor.execute("DELETE FROM thumbnails WHERE photo_id = ?", (photo_id,))
        cursor.execute("DELETE FROM photo_tags WHERE photo_id = ?", (photo_id,))
        cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        conn.commit()

        if delete_file and file_path_str:
            try:
                from ..scanner import resolve_portable_path
                real_path, is_online = resolve_portable_path(file_path_str)
                if is_online and real_path.is_file():
                    real_path.unlink()
            except Exception as e:
                logger.warning(f"実ファイルの削除に失敗しました: {e}")

        return True


def delete_photos_by_ids(photo_ids: List[int]) -> int:
    """
    複数の写真をDB（写真・タグ・サムネイル）から一括削除する。実ファイルは削除しない。
    削除した写真が属していたディレクトリのスタックを再計算し、代表写真が消えたスタックを修復する。
    """
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        deleted = 0
        affected_dirs = set()
        for i in range(0, len(photo_ids), 500):
            chunk = photo_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(f"SELECT DISTINCT directory_path FROM photos WHERE id IN ({placeholders})", chunk)
            affected_dirs.update(r["directory_path"] for r in cursor.fetchall())
            cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)
            deleted += cursor.rowcount
        conn.commit()

    # スタックの健全性を修復（削除元ディレクトリ直下のみ）
    for d in affected_dirs:
        try:
            from .stacks import recalculate_stacks
            recalculate_stacks(d, recursive=False)
        except Exception as stack_err:
            print(f"[WARN] スタック修復エラー（削除自体は完了） ({d}): {stack_err}")
    return deleted


def get_photo_brief(photo_id: int) -> Optional[Dict[str, Any]]:
    """サムネイルおよびビューワ画像配信のための軽量な写真情報（単一主キー検索・JOIN/サブクエリなし）を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, file_name, file_path, file_size, file_mtime, date_taken, is_raw, paired_raw_path, rotation, fine_angle, crop_x, crop_y, crop_w, crop_h, crop_aspect, brightness, contrast, saturation FROM photos WHERE id = ?",
            (photo_id,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None


def get_photos_brief_batch(photo_ids: List[int]) -> List[Dict[str, Any]]:
    """複数写真のサムネイル処理用軽量情報（id, file_path, file_size, file_mtime, date_taken, rotation, fine_angle, crop_*, トーン調整値）を一括取得する"""
    if not photo_ids:
        return []
    with get_connection() as conn:
        cursor = conn.cursor()
        results = []
        for i in range(0, len(photo_ids), 500):
            chunk = photo_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"SELECT id, file_path, file_size, file_mtime, date_taken, rotation, fine_angle, crop_x, crop_y, crop_w, crop_h, crop_aspect, brightness, contrast, saturation FROM photos WHERE id IN ({placeholders})",
                chunk,
            )
            results.extend([dict(r) for r in cursor.fetchall()])
        return results


def get_missing_photos(limit: int = 0) -> List[Dict[str, Any]]:
    """
    接続中（オンライン）のドライブ・フォルダに登録されているが、
    実ファイルが削除または移動されて見つからない写真（孤児レコード）を抽出して返す。
    未接続（オフライン）の外部ドライブ写真は除外され、安全に保護される。
    """
    from ..scanner import resolve_portable_path
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*,
                   t.width AS thumb_width,
                   t.height AS thumb_height,
                   v.volume_label,
                   v.drive_letter AS volume_drive,
                   CASE WHEN t.photo_id IS NOT NULL THEN 1 ELSE 0 END AS has_thumbnail
            FROM photos p
            LEFT JOIN volumes v ON p.volume_serial = v.volume_serial
            LEFT JOIN thumbnails t ON p.id = t.photo_id
            WHERE p.rating IN (0, 1, 2)
              AND (p.is_unlinked IS NULL OR p.is_unlinked = 0)
            ORDER BY p.date_taken DESC, p.file_name ASC
            """
        )
        rows = cursor.fetchall()
        dir_online_cache: Dict[str, bool] = {}
        dir_files_cache: Dict[str, Optional[set]] = {}
        missing_photos: List[Dict[str, Any]] = []

        for r in rows:
            d_path = r["directory_path"]
            if d_path not in dir_online_cache:
                resolved_dir, is_online = resolve_portable_path(d_path)
                dir_online_cache[d_path] = is_online
                if is_online and resolved_dir:
                    try:
                        with os.scandir(str(resolved_dir)) as it:
                            dir_files_cache[d_path] = {entry.name.lower() for entry in it}
                    except Exception:
                        dir_files_cache[d_path] = None
                else:
                    dir_files_cache[d_path] = None

            # 親ドライブ/フォルダがオンラインなのに、実ファイルが存在しない写真
            if dir_online_cache[d_path]:
                file_set = dir_files_cache.get(d_path)
                fname = r["file_name"] or os.path.basename(r["file_path"] or "")
                if file_set is not None and fname and fname.lower() in file_set:
                    continue
                f_path, _ = resolve_portable_path(r["file_path"])
                if not os.path.exists(str(f_path)):
                    item = dict(r)
                    item["is_missing"] = True
                    item["is_offline"] = False
                    item["stack_count"] = 1
                    item["stack_photos"] = []
                    missing_photos.append(item)
                    if limit and limit > 0 and len(missing_photos) >= limit:
                        break

        # タグ情報を付与 (SQLiteバインド上限回避のため900件ずつチャンク取得)
        if missing_photos:
            photo_ids = [p["id"] for p in missing_photos]
            tags_map: Dict[int, List[str]] = {}
            for i in range(0, len(photo_ids), 900):
                id_chunk = photo_ids[i:i + 900]
                cursor.execute(
                    f"SELECT photo_id, tag FROM photo_tags WHERE photo_id IN ({','.join(['?']*len(id_chunk))})",
                    id_chunk,
                )
                for tr in cursor.fetchall():
                    tags_map.setdefault(tr["photo_id"], []).append(tr["tag"])
            for p in missing_photos:
                p["tags"] = tags_map.get(p["id"], [])

        return missing_photos


def get_missing_photos_count() -> int:
    """実体パスが存在しない写真（オンラインドライブ内）の件数を取得する"""
    photos = get_missing_photos(limit=0)
    return len(photos)


def unlink_missing_photos_in_folder(directory_path: str, recursive: bool = False) -> int:
    """
    指定フォルダ内で実ファイルが見つからない写真について、
    DBのレコードやサムネイル・タグは保持したまま、実体パスとの紐付けを解除（is_unlinked = 1）にする。
    これにより、写真データ（メタ情報・サムネ）を安全に維持しつつ「リンク消失」状態へ移行する。
    """
    from ..scanner import resolve_portable_path
    sql_frag, sql_params = _directory_filter_sql(directory_path, recursive=recursive, column_name="directory_path")

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT id, file_path, stack_id, is_stack_primary FROM photos
            WHERE {sql_frag} AND (is_unlinked IS NULL OR is_unlinked = 0)
            """,
            sql_params,
        )
        rows = cursor.fetchall()
        missing_ids = []
        for r in rows:
            f_path, is_online = resolve_portable_path(r["file_path"])
            if is_online and not os.path.exists(str(f_path)):
                missing_ids.append(r["id"])

        if missing_ids:
            for i in range(0, len(missing_ids), 500):
                chunk = missing_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"UPDATE photos SET is_unlinked = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
                    chunk,
                )
            conn.commit()

            # スタックの健全性を修復
            try:
                from .stacks import recalculate_stacks
                norm_win = os.path.normpath(directory_path).rstrip("\\/")
                recalculate_stacks(norm_win, recursive=recursive)
            except Exception as stack_err:
                logger.warning(f"スタック修復スキップ: {stack_err}")

            return len(missing_ids)
        return 0


def get_unlinked_photos_count() -> int:
    """実体パスとの紐付けが外れた（リンク消失）写真の件数を高速に取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS cnt FROM photos WHERE is_unlinked = 1")
        row = cursor.fetchone()
        return row["cnt"] if row else 0


def purge_unlinked_photos(photo_ids: Optional[List[int]] = None) -> int:
    """
    リンク消失した写真を、ユーザーの明示的な指示によりDB（サムネイル・タグ・メタデータ）から完全抹消する。
    photo_ids 指定時はその写真のみ、None の場合は is_unlinked = 1 の全写真を削除する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        if photo_ids is not None:
            if not photo_ids:
                return 0
            target_ids = list(photo_ids)
        else:
            cursor.execute("SELECT id FROM photos WHERE is_unlinked = 1")
            rows = cursor.fetchall()
            target_ids = [r["id"] for r in rows]

        if not target_ids:
            return 0

        for i in range(0, len(target_ids), 500):
            chunk = target_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)

        # 孤立サムネイルクリーンアップ
        cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
        conn.commit()
        return len(target_ids)


def get_location_tree_summary() -> Dict[str, Any]:
    """
    左ペイン用の国・都道府県・市区町村の階層ツリー構造および写真枚数を集計して返す。
    インデックス idx_photos_location により高速にGROUP BY集計を行う。
    """
    try:
        backfill_photo_locations(limit=5000)
    except Exception as e:
        logger.warning(f"場所ツリー集計前の自動逆ジオコーディングをスキップしました: {e}")

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 位置情報付き写真の国・県・市ごとの集計
        cursor.execute(
            """
            SELECT country, state, city, COUNT(*) as cnt
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND country IS NOT NULL AND country != ''
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
            GROUP BY country, state, city
            ORDER BY country ASC, state ASC, city ASC
            """
        )
        rows = cursor.fetchall()

        country_dict: Dict[str, Any] = {}

        for row in rows:
            c = row["country"]
            s = row["state"] or "その他"
            ci = row["city"] or "その他"
            cnt = row["cnt"]

            if c not in country_dict:
                country_dict[c] = {"count": 0, "states": {}}

            country_dict[c]["count"] += cnt

            if s not in country_dict[c]["states"]:
                country_dict[c]["states"][s] = {"count": 0, "cities": []}

            country_dict[c]["states"][s]["count"] += cnt
            country_dict[c]["states"][s]["cities"].append({"city": ci, "count": cnt})

        # 配列構造へ変換（国・都道府県・市区町村ともに枚数降順）
        tree = []
        for c_name, c_data in sorted(country_dict.items(), key=lambda x: x[1]["count"], reverse=True):
            states_list = []
            for s_name, s_data in sorted(c_data["states"].items(), key=lambda x: x[1]["count"], reverse=True):
                cities_list = sorted(s_data["cities"], key=lambda x: x["count"], reverse=True)
                states_list.append({
                    "state": s_name,
                    "count": s_data["count"],
                    "cities": cities_list,
                })
            tree.append({
                "country": c_name,
                "count": c_data["count"],
                "states": states_list,
            })

        # 2. 位置情報なし写真の件数
        cursor.execute(
            """
            SELECT COUNT(*) as cnt
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND (latitude IS NULL OR country IS NULL OR country = ''
                   OR (ABS(latitude) < 0.0001 AND ABS(longitude) < 0.0001))
            """
        )
        no_loc_row = cursor.fetchone()
        no_loc_count = no_loc_row["cnt"] if no_loc_row else 0

        return {
            "tree": tree,
            "no_location_count": no_loc_count,
        }

