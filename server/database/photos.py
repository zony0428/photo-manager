"""
写真 CRUD 管理モジュール
写真メタデータの登録・検索・更新・削除、GPS操作、同期・クリーンアップを提供する。
"""

from datetime import datetime, timedelta
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .connection import calc_solar_altitude, get_connection

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
    date_taken = excluded.date_taken,
    year_month = excluded.year_month,
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



# シャッタースピード文字列（分数 "1/250" または小数 "0.5" / "2.5s"）を露光秒数(REAL)に換算するSQL式
_SHUTTER_SECONDS_SQL = """(CASE
    WHEN INSTR(p.shutter_speed, '/') > 0 THEN
        CASE
            WHEN CAST(SUBSTR(p.shutter_speed, INSTR(p.shutter_speed, '/') + 1) AS REAL) > 0
            THEN CAST(SUBSTR(p.shutter_speed, 1, INSTR(p.shutter_speed, '/') - 1) AS REAL)
                 / CAST(SUBSTR(p.shutter_speed, INSTR(p.shutter_speed, '/') + 1) AS REAL)
            ELSE 0.0
        END
    ELSE CAST(REPLACE(p.shutter_speed, 's', '') AS REAL)
END)"""


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
    limit: int = 5000,
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
        except ValueError:
            pass

    # F値レンジ（"min-max" 形式）フィルタ
    if aperture_range and "-" in aperture_range:
        try:
            a_min_s, a_max_s = aperture_range.split("-", 1)
            a_min, a_max = float(a_min_s), float(a_max_s)
            query += " AND p.f_number IS NOT NULL AND p.f_number BETWEEN ? AND ?"
            params.extend([a_min, a_max])
        except ValueError:
            pass

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
    valid_sorts = {
        "date_taken DESC": "p.date_taken DESC, p.file_name ASC",
        "date_taken ASC": "p.date_taken ASC, p.file_name ASC",
        "rating DESC": "p.rating DESC, p.date_taken DESC",
        "file_name ASC": "p.file_name ASC",
    }
    order_clause = valid_sorts.get(sort_by, "p.date_taken DESC, p.file_name ASC")
    query += f" ORDER BY {order_clause}"

    # 大量写真時のメモリ・描画負荷を防止するための上限
    if limit and limit > 0:
        query += f" LIMIT {int(limit)}"

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        rows = cursor.fetchall()
        photos = [dict(row) for row in rows]

        if photos:
            photo_ids = [p["id"] for p in photos]
            # タグ情報の付与 (SQLiteのバインドパラメータ上限を回避するため900件ずつチャンク取得)
            tags_map: Dict[int, List[str]] = {}
            tag_details_map: Dict[int, List[Dict[str, Any]]] = {}
            chunk_size = 900
            for i in range(0, len(photo_ids), chunk_size):
                id_chunk = photo_ids[i:i + chunk_size]
                cursor.execute(
                    f"SELECT photo_id, tag, source, confidence FROM photo_tags WHERE photo_id IN ({','.join(['?']*len(id_chunk))})",
                    id_chunk
                )
                for r in cursor.fetchall():
                    pid = r["photo_id"]
                    tags_map.setdefault(pid, []).append(r["tag"])
                    tag_details_map.setdefault(pid, []).append({
                        "tag": r["tag"],
                        "source": r["source"] or "manual",
                        "confidence": r["confidence"] if r["confidence"] is not None else 1.0,
                    })

            for p in photos:
                p["tags"] = tags_map.get(p["id"], [])
                p["tag_details"] = tag_details_map.get(p["id"], [])

            # スタックメンバー情報の付与（ブラケットグループに属する場合、900件ずつチャンク取得）
            active_stack_ids = list(set([p["stack_id"] for p in photos if p.get("stack_id")]))
            if active_stack_ids:
                stack_map: Dict[int, List[Dict[str, Any]]] = {}
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
                        sid = r["stack_id"]
                        stack_map.setdefault(sid, []).append(dict(r))

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
        cursor.execute(
            f"UPDATE photos SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN ({','.join(['?']*len(photo_ids))})",
            [rating] + photo_ids,
        )
        conn.commit()
        return cursor.rowcount



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
        placeholders = ",".join("?" for _ in photo_ids)
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
        cursor.execute(sql, photo_ids)
        conn.commit()
        return cursor.rowcount


def batch_rotate_photos(photo_ids: List[int], delta_degrees: int = 90) -> int:
    """複数の写真の回転角度を一括で加算・更新する"""
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in photo_ids)
        sql = f"""
            UPDATE photos
            SET rotation = (((COALESCE(rotation, 0) + ?) % 360) + 360) % 360,
                updated_at = CURRENT_TIMESTAMP
            WHERE id IN ({placeholders})
        """
        cursor.execute(sql, [delta_degrees] + photo_ids)
        conn.commit()
        return cursor.rowcount



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
            except (ValueError, TypeError):
                pass

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
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 対象写真の抽出（GPS未設定かつ撮影日時が存在するもの）
        if photo_ids:
            placeholders = ",".join(["?"] * len(photo_ids))
            cursor.execute(
                f"""
                SELECT id, date_taken
                FROM photos
                WHERE id IN ({placeholders})
                  AND latitude IS NULL
                  AND date_taken IS NOT NULL AND date_taken != ''
                """,
                photo_ids
            )
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
        else:
            return {"inferred_count": 0, "skipped_count": 0, "total_target": 0}

        target_photos = cursor.fetchall()
        total_target = len(target_photos)
        if total_target == 0:
            return {"inferred_count": 0, "skipped_count": 0, "total_target": 0}

        inferred_count = 0
        skipped_count = 0

        for p in target_photos:
            pid = p["id"]
            date_taken = p["date_taken"]

            dt = None
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
                try:
                    dt = datetime.strptime(str(date_taken).strip(), fmt)
                    break
                except (ValueError, TypeError):
                    pass

            if dt is not None:
                min_dt = (dt - timedelta(minutes=max_minutes)).strftime("%Y-%m-%d %H:%M:%S")
                max_dt = (dt + timedelta(minutes=max_minutes)).strftime("%Y-%m-%d %H:%M:%S")
                cursor.execute(
                    """
                    SELECT latitude, longitude, country, state, city,
                           ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) AS time_diff_min
                    FROM photos
                    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                      AND date_taken BETWEEN ? AND ?
                    ORDER BY time_diff_min ASC
                    LIMIT 1
                    """,
                    (date_taken, min_dt, max_dt)
                )
            else:
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
                cursor.execute(
                    """
                    UPDATE photos
                    SET latitude = ?, longitude = ?, gps_source = 'inferred',
                        country = ?, state = ?, city = ?,
                        meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (nearest["latitude"], nearest["longitude"],
                     nearest["country"], nearest["state"], nearest["city"], pid)
                )
                inferred_count += 1
            else:
                skipped_count += 1

        conn.commit()
        return {
            "inferred_count": inferred_count,
            "skipped_count": skipped_count,
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
        if photo_ids:
            placeholders = ",".join(["?"] * len(photo_ids))
            cursor.execute(
                f"""
                UPDATE photos
                SET latitude = NULL, longitude = NULL, gps_source = NULL,
                    country = NULL, state = NULL, city = NULL,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders}) AND gps_source = 'inferred'
                """,
                photo_ids
            )
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
        else:
            return 0

        conn.commit()
        return cursor.rowcount


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
        if photo_ids:
            placeholders = ",".join(["?"] * len(photo_ids))
            cursor.execute(
                f"""
                UPDATE photos
                SET latitude = NULL, longitude = NULL, gps_source = NULL,
                    country = NULL, state = NULL, city = NULL,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
                """,
                photo_ids
            )
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
        else:
            return 0

        conn.commit()
        return cursor.rowcount


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
        for pid in target_photo_ids:
            cursor.execute(
                """UPDATE photos
                   SET latitude = ?, longitude = ?, gps_source = 'copied',
                       country = ?, state = ?, city = ?,
                       meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?""",
                (lat, lng, loc.get("country"), loc.get("state"), loc.get("city"), pid),
            )
            count += cursor.rowcount
        conn.commit()
        return count


def backfill_photo_locations(limit: int = 5000) -> int:
    """
    GPS座標（latitude, longitude）があるが国・県・市（country）が未設定の写真に対して
    逆ジオコーディングを一括実行して地名を補完する。
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

        updated_count = 0
        for row in rows:
            pid = row["id"]
            lat = row["latitude"]
            lon = row["longitude"]
            loc = reverse_geocode(lat, lon, db_conn=conn)
            cursor.execute(
                """
                UPDATE photos
                SET country = ?, state = ?, city = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (loc.get("country"), loc.get("state"), loc.get("city"), pid)
            )
            updated_count += cursor.rowcount

        conn.commit()
        return updated_count



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


def cleanup_missing_photos() -> int:
    """実ファイルが削除され、移動先も見つからなかった孤立レコード（写真・タグ・サムネイル）を安全に削除する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, file_path FROM photos")
        rows = cursor.fetchall()
        missing_ids = [r["id"] for r in rows if not os.path.exists(r["file_path"])]

        if missing_ids:
            for i in range(0, len(missing_ids), 500):
                chunk = missing_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
                cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)
            # 孤立サムネイルを確実にパージ
            cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
            conn.commit()
            return len(missing_ids)
        return 0


def cleanup_missing_photos_in_folder(directory_path: str, recursive: bool = False) -> int:
    """指定フォルダのファイル存在チェックを行い、
    実ファイルが消えている写真のDB レコード（写真・タグ・サムネイル）を安全に削除する。
    recursive=False は直下のみ、True は配下サブフォルダも対象とする。
    スタックメンバーが削除された場合は同じ範囲のスタック整合性を自動修復する。"""
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
        missing_ids = [r["id"] for r in rows if not os.path.exists(r["file_path"])]

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
    carry フォルダ配下の写真で、実ファイルが削除されたレコードをDBから完全にクリーンアップする。
    （外部ドライブのオフライン写真は保護し、テンポラリ持ち帰り用の carry 写真のみを対象とする）
    """
    upload_dir_resolved = upload_dir.resolve()
    upload_dir_str = str(upload_dir_resolved).rstrip("\\/")

    with get_connection() as conn:
        cursor = conn.cursor()
        # carry ディレクトリ配下の写真を検索
        cursor.execute(
            """
            SELECT id, file_path, directory_path
            FROM photos
            WHERE directory_path = ? OR directory_path LIKE ? OR file_path LIKE ?
            """,
            (upload_dir_str, f"{upload_dir_str}\\%", f"{upload_dir_str}\\%"),
        )
        rows = cursor.fetchall()
        if not rows:
            return 0

        missing_ids = []
        for r in rows:
            p_path = Path(r["file_path"])
            # そのままのパスで存在するか、または現在の upload_dir / ファイル名 で存在するか
            is_present = p_path.exists() or (upload_dir_resolved / p_path.name).exists()
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
            print(f"[INFO] carry 内のリンク切れ写真 {len(missing_ids)} 件をDBから自動クリーンアップしました。")
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
                p = Path(file_path_str)
                if p.exists():
                    p.unlink()
            except Exception as e:
                print(f"[WARN] 実ファイルの削除に失敗しました: {e}")

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
    """サムネイル配信等のための軽量な写真情報（id, file_path, file_size, file_mtime, date_taken, rotation, fine_angle, crop_*, トーン調整値）を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, file_path, file_size, file_mtime, date_taken, rotation, fine_angle, crop_x, crop_y, crop_w, crop_h, crop_aspect, brightness, contrast, saturation FROM photos WHERE id = ?",
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


def get_missing_photos(limit: int = 2000) -> List[Dict[str, Any]]:
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
            ORDER BY p.date_taken DESC, p.file_name ASC
            """
        )
        rows = cursor.fetchall()
        dir_online_cache: Dict[str, bool] = {}
        missing_photos: List[Dict[str, Any]] = []

        for r in rows:
            d_path = r["directory_path"]
            if d_path not in dir_online_cache:
                _, is_online = resolve_portable_path(d_path)
                dir_online_cache[d_path] = is_online

            # 親ドライブ/フォルダがオンラインなのに、実ファイルが存在しない写真
            if dir_online_cache[d_path]:
                f_path, _ = resolve_portable_path(r["file_path"])
                if not os.path.exists(str(f_path)):
                    item = dict(r)
                    item["is_missing"] = True
                    item["is_offline"] = False
                    item["stack_count"] = 1
                    item["stack_photos"] = []
                    missing_photos.append(item)
                    if len(missing_photos) >= limit:
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
    photos = get_missing_photos(limit=5000)
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


# 日本の47都道府県定義（正式名称, 短縮名, 英語名リスト）
_JP_PREF_DEFS: List[Tuple[str, str, List[str]]] = [
    ("北海道", "北海道", ["hokkaido"]),
    ("青森県", "青森", ["aomori"]),
    ("岩手県", "岩手", ["iwate"]),
    ("宮城県", "宮城", ["miyagi"]),
    ("秋田県", "秋田", ["akita"]),
    ("山形県", "山形", ["yamagata"]),
    ("福島県", "福島", ["fukushima"]),
    ("茨城県", "茨城", ["ibaraki"]),
    ("栃木県", "栃木", ["tochigi"]),
    ("群馬県", "群馬", ["gunma", "gumma"]),
    ("埼玉県", "埼玉", ["saitama"]),
    ("千葉県", "千葉", ["chiba"]),
    ("東京都", "東京", ["tokyo", "tokyo metropolis", "tokyo-to"]),
    ("神奈川県", "神奈川", ["kanagawa"]),
    ("新潟県", "新潟", ["niigata"]),
    ("富山県", "富山", ["toyama"]),
    ("石川県", "石川", ["ishikawa"]),
    ("福井県", "福井", ["fukui"]),
    ("山梨県", "山梨", ["yamanashi"]),
    ("長野県", "長野", ["nagano"]),
    ("岐阜県", "岐阜", ["gifu"]),
    ("静岡県", "静岡", ["shizuoka"]),
    ("愛知県", "愛知", ["aichi"]),
    ("三重県", "三重", ["mie"]),
    ("滋賀県", "滋賀", ["shiga"]),
    ("京都府", "京都", ["kyoto", "kyoto-fu"]),
    ("大阪府", "大阪", ["osaka", "osaka-fu"]),
    ("兵庫県", "兵庫", ["hyogo", "hyōgo"]),
    ("奈良県", "奈良", ["nara"]),
    ("和歌山県", "和歌山", ["wakayama"]),
    ("鳥取県", "鳥取", ["tottori"]),
    ("島根県", "島根", ["shimane"]),
    ("岡山県", "岡山", ["okayama"]),
    ("広島県", "広島", ["hiroshima"]),
    ("山口県", "山口", ["yamaguchi"]),
    ("徳島県", "徳島", ["tokushima"]),
    ("香川県", "香川", ["kagawa"]),
    ("愛媛県", "愛媛", ["ehime"]),
    ("高知県", "高知", ["kochi", "kōchi"]),
    ("福岡県", "福岡", ["fukuoka"]),
    ("佐賀県", "佐賀", ["saga"]),
    ("長崎県", "長崎", ["nagasaki"]),
    ("熊本県", "熊本", ["kumamoto"]),
    ("大分県", "大分", ["oita", "ōita"]),
    ("宮崎県", "宮崎", ["miyazaki"]),
    ("鹿児島県", "鹿児島", ["kagoshima"]),
    ("沖縄県", "沖縄", ["okinawa"]),
]

_PREF_LOOKUP_MAP: Dict[str, str] = {}
_PREF_ALIASES_MAP: Dict[str, List[str]] = {}
for _full_jp, _short_jp, _en_list in _JP_PREF_DEFS:
    _aliases = {_full_jp, _short_jp}
    _PREF_LOOKUP_MAP[_full_jp.lower()] = _full_jp
    _PREF_LOOKUP_MAP[_short_jp.lower()] = _full_jp
    for _en in _en_list:
        _PREF_LOOKUP_MAP[_en.lower()] = _full_jp
        _PREF_LOOKUP_MAP[f"{_en.lower()} prefecture"] = _full_jp
        _PREF_LOOKUP_MAP[f"{_en.lower()}-ken"] = _full_jp
        _aliases.add(_en.capitalize())
        _aliases.add(f"{_en.capitalize()} Prefecture")
    _PREF_ALIASES_MAP[_full_jp] = sorted(_aliases)


def _normalize_jp_prefecture(state: Optional[str], country: Optional[str] = None) -> Optional[str]:
    """
    都道府県名（日本語正式名・短縮名・英語名など）を日本の47都道府県の正式名称に正規化する。
    47都道府県に該当しない場合は None を返す。
    """
    if not state:
        return None
    if country and country not in ("日本", "Japan", "JP", ""):
        # 国名が明示的に海外の場合は除外（ただしstate自体が日本の都道府県名なら許容）
        pass
    s_clean = str(state).strip()
    if not s_clean:
        return None
    s_lower = s_clean.lower()
    if s_lower in _PREF_LOOKUP_MAP:
        return _PREF_LOOKUP_MAP[s_lower]
    # "Prefecture" や空白を除去して再照合
    s_stripped = s_lower.replace("prefecture", "").replace("metropolis", "").strip()
    if s_stripped in _PREF_LOOKUP_MAP:
        return _PREF_LOOKUP_MAP[s_stripped]
    return None


def _get_jp_prefecture_aliases(state: str) -> List[str]:
    """指定された都道府県名に対応する表記ゆれ候補リスト（日本語・英語等）を返す"""
    norm = _normalize_jp_prefecture(state)
    if norm and norm in _PREF_ALIASES_MAP:
        return _PREF_ALIASES_MAP[norm]
    return [state]


def get_location_heatmap_data(date_filter: Optional[str] = None) -> Dict[str, Any]:
    """
    ジオタグ47都道府県制覇マップ・ヒートマップ・時系列撮影軌跡（フォトラリー）用の集計データを取得する。
    """
    try:
        backfill_photo_locations(limit=5000)
    except Exception as e:
        logger.warning(f"ヒートマップ集計前の自動逆ジオコーディングをスキップしました: {e}")

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 国・都道府県ごとの枚数・優/良枚数・中心座標集計
        cursor.execute(
            """
            SELECT country, state,
                   COUNT(*) AS cnt,
                   SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS exc_cnt,
                   SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS good_cnt,
                   AVG(latitude) AS avg_lat,
                   AVG(longitude) AS avg_lon
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
            GROUP BY country, state
            """
        )
        loc_rows = cursor.fetchall()

        total_geotagged = 0
        pref_agg: Dict[str, Dict[str, Any]] = {}
        country_agg: Dict[str, Dict[str, Any]] = {}

        for r in loc_rows:
            cnt = int(r["cnt"] or 0)
            exc = int(r["exc_cnt"] or 0)
            good = int(r["good_cnt"] or 0)
            avg_lat = float(r["avg_lat"] or 35.68)
            avg_lon = float(r["avg_lon"] or 139.76)
            raw_country = (r["country"] or "").strip()
            raw_state = (r["state"] or "").strip()

            total_geotagged += cnt

            norm_pref = _normalize_jp_prefecture(raw_state, raw_country)
            if norm_pref:
                c_name = "日本"
            elif raw_country in ("日本", "Japan", "JP"):
                c_name = "日本"
            elif raw_country:
                c_name = raw_country
            else:
                c_name = "不明"

            if c_name not in country_agg:
                country_agg[c_name] = {"country": c_name, "count": 0, "excellent_count": 0}
            country_agg[c_name]["count"] += cnt
            country_agg[c_name]["excellent_count"] += exc

            if norm_pref:
                if norm_pref not in pref_agg:
                    pref_agg[norm_pref] = {
                        "prefecture": norm_pref,
                        "country": "日本",
                        "count": 0,
                        "excellent_count": 0,
                        "good_count": 0,
                        "_lat_sum": 0.0,
                        "_lon_sum": 0.0,
                    }
                pref_agg[norm_pref]["count"] += cnt
                pref_agg[norm_pref]["excellent_count"] += exc
                pref_agg[norm_pref]["good_count"] += good
                pref_agg[norm_pref]["_lat_sum"] += avg_lat * cnt
                pref_agg[norm_pref]["_lon_sum"] += avg_lon * cnt

        prefectures_list: List[Dict[str, Any]] = []
        for p_name, p_info in pref_agg.items():
            c_total = p_info["count"]
            prefectures_list.append({
                "prefecture": p_name,
                "country": "日本",
                "count": c_total,
                "excellent_count": p_info["excellent_count"],
                "good_count": p_info["good_count"],
                "avg_lat": round(p_info["_lat_sum"] / c_total, 4) if c_total > 0 else 35.68,
                "avg_lon": round(p_info["_lon_sum"] / c_total, 4) if c_total > 0 else 139.76,
            })
        prefectures_list.sort(key=lambda x: (-x["count"], x["prefecture"]))

        countries_list = sorted(
            country_agg.values(), key=lambda x: (-x["count"], x["country"])
        )

        # 2. グリッドヒートマップ用ポイント集計 (約1kmメッシュ: 小数点第2位丸め)
        cursor.execute(
            """
            SELECT ROUND(latitude, 2) AS lat,
                   ROUND(longitude, 2) AS lon,
                   COUNT(*) AS count,
                   SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS excellent_count,
                   MAX(state) AS state,
                   MAX(city) AS city
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
            GROUP BY ROUND(latitude, 2), ROUND(longitude, 2)
            ORDER BY count DESC
            LIMIT 2000
            """
        )
        grid_points = [
            {
                "lat": float(r["lat"]),
                "lon": float(r["lon"]),
                "count": int(r["count"] or 0),
                "excellent_count": int(r["excellent_count"] or 0),
                "state": _normalize_jp_prefecture(r["state"]) or (r["state"] or ""),
                "city": r["city"] or "",
            }
            for r in cursor.fetchall()
            if r["lat"] is not None and r["lon"] is not None
        ]

        # 3. 撮影軌跡（フォトラリー）用の日付一覧（最新順・最大100日分）
        cursor.execute(
            """
            SELECT SUBSTR(date_taken, 1, 10) AS dt,
                   COUNT(*) AS cnt,
                   MAX(state) AS main_state,
                   MAX(city) AS main_city
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
              AND date_taken IS NOT NULL AND LENGTH(date_taken) >= 10
            GROUP BY SUBSTR(date_taken, 1, 10)
            ORDER BY dt DESC
            LIMIT 100
            """
        )
        trajectory_dates: List[Dict[str, Any]] = []
        for r in cursor.fetchall():
            dt_str = str(r["dt"] or "").replace(":", "-")
            cnt = int(r["cnt"] or 0)
            st = _normalize_jp_prefecture(r["main_state"]) or (r["main_state"] or "")
            ci = r["main_city"] or ""
            loc_label = f"{st} {ci}".strip() if (st or ci) else "位置情報あり"
            trajectory_dates.append({
                "date": dt_str,
                "count": cnt,
                "state": st,
                "city": ci,
                "label": f"{dt_str} ({loc_label} / {cnt}枚)",
            })

        # 4. 撮影軌跡ポイント一覧（date_filter 指定時はその日、未指定時は最新側から最大1,500件を時系列昇順で返却）
        if date_filter and len(date_filter.strip()) >= 7:
            df_clean = date_filter.strip()
            cursor.execute(
                """
                SELECT id, file_name, date_taken, latitude, longitude, state, city, rating
                FROM photos
                WHERE (is_unlinked IS NULL OR is_unlinked = 0)
                  AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
                  AND latitude IS NOT NULL AND longitude IS NOT NULL
                  AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
                  AND date_taken IS NOT NULL
                  AND SUBSTR(REPLACE(date_taken, ':', '-'), 1, ?) = ?
                ORDER BY date_taken ASC, id ASC
                LIMIT 1500
                """,
                (len(df_clean), df_clean),
            )
            traj_rows = cursor.fetchall()
        else:
            cursor.execute(
                """
                SELECT id, file_name, date_taken, latitude, longitude, state, city, rating
                FROM (
                    SELECT id, file_name, date_taken, latitude, longitude, state, city, rating
                    FROM photos
                    WHERE (is_unlinked IS NULL OR is_unlinked = 0)
                      AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
                      AND latitude IS NOT NULL AND longitude IS NOT NULL
                      AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
                      AND date_taken IS NOT NULL AND date_taken != ''
                    ORDER BY date_taken DESC, id DESC
                    LIMIT 1500
                )
                ORDER BY date_taken ASC, id ASC
                """
            )
            traj_rows = cursor.fetchall()

        trajectory_points = [
            {
                "id": r["id"],
                "file_name": r["file_name"],
                "date_taken": r["date_taken"],
                "lat": float(r["latitude"]),
                "lon": float(r["longitude"]),
                "state": _normalize_jp_prefecture(r["state"]) or (r["state"] or ""),
                "city": r["city"] or "",
                "rating": int(r["rating"] or 0),
            }
            for r in traj_rows
            if r["latitude"] is not None and r["longitude"] is not None
        ]

        return {
            "prefectures": prefectures_list,
            "countries": countries_list,
            "conquered_prefectures_count": len(prefectures_list),
            "total_prefectures": 47,
            "total_geotagged": total_geotagged,
            "grid_points": grid_points,
            "trajectory_dates": trajectory_dates,
            "trajectory_points": trajectory_points,
        }


def get_lab_karte_data(today_mmdd: Optional[str] = None) -> Dict[str, Any]:
    """
    パーソナル撮影ラボ＆機材相性カルテ（歩留まり分析・焦点距離/F値別統計・太陽高度別枚数・時間帯分布・過去の今日）を集計する。
    """
    if not today_mmdd or len(today_mmdd.strip()) != 5:
        today_mmdd = datetime.now().strftime("%m-%d")
    else:
        today_mmdd = today_mmdd.strip()

    base_where = (
        "(p.is_unlinked IS NULL OR p.is_unlinked = 0)"
        " AND NOT (p.is_raw = 1 AND p.paired_raw_path IS NOT NULL)"
    )

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. サマリー集計（全体枚数・優/良枚数・手ブレリスク・ゴールデン/ブルーアワー・過去の今日）
        cursor.execute(
            f"""
            SELECT
                COUNT(*) AS total_photos,
                SUM(CASE WHEN p.rating IN (-1, 1, 2) THEN 1 ELSE 0 END) AS rated_photos,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent_count,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good_count,
                SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable_count,
                SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject_count,
                SUM(CASE
                    WHEN p.focal_length IS NOT NULL AND p.focal_length > 0
                         AND p.shutter_speed IS NOT NULL AND p.shutter_speed != ''
                         AND ({_SHUTTER_SECONDS_SQL} * p.focal_length) >= 1.0
                    THEN 1 ELSE 0
                END) AS shake_risk_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND p.date_taken != ''
                         AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -4.0 AND 6.0
                    THEN 1 ELSE 0
                END) AS golden_hour_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND p.date_taken != ''
                         AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -8.0 AND -4.0001
                    THEN 1 ELSE 0
                END) AS blue_hour_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND p.date_taken != ''
                         AND solar_altitude(p.date_taken, p.latitude, p.longitude) < -8.0
                    THEN 1 ELSE 0
                END) AS night_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND SUBSTR(p.date_taken, 6, 5) IN (?, ?)
                    THEN 1 ELSE 0
                END) AS on_this_day_count
            FROM photos p
            WHERE {base_where}
            """,
            (today_mmdd.replace(":", "-"), today_mmdd.replace("-", ":")),
        )
        sum_row = cursor.fetchone()
        total_photos = int(sum_row["total_photos"] or 0) if sum_row else 0
        rated_photos = int(sum_row["rated_photos"] or 0) if sum_row else 0
        excellent_count = int(sum_row["excellent_count"] or 0) if sum_row else 0
        good_count = int(sum_row["good_count"] or 0) if sum_row else 0
        acceptable_count = int(sum_row["acceptable_count"] or 0) if sum_row else 0
        reject_count = int(sum_row["reject_count"] or 0) if sum_row else 0
        shake_risk_count = int(sum_row["shake_risk_count"] or 0) if sum_row else 0
        golden_hour_count = int(sum_row["golden_hour_count"] or 0) if sum_row else 0
        blue_hour_count = int(sum_row["blue_hour_count"] or 0) if sum_row else 0
        night_count = int(sum_row["night_count"] or 0) if sum_row else 0
        on_this_day_count = int(sum_row["on_this_day_count"] or 0) if sum_row else 0

        overall_excellent_rate = round(excellent_count * 100.0 / total_photos, 1) if total_photos > 0 else 0.0
        overall_hit_rate = round((excellent_count + good_count) * 100.0 / total_photos, 1) if total_photos > 0 else 0.0

        summary = {
            "total_photos": total_photos,
            "rated_photos": rated_photos,
            "excellent_count": excellent_count,
            "good_count": good_count,
            "acceptable_count": acceptable_count,
            "reject_count": reject_count,
            "overall_excellent_rate": overall_excellent_rate,
            "overall_hit_rate": overall_hit_rate,
            "shake_risk_count": shake_risk_count,
            "golden_hour_count": golden_hour_count,
            "blue_hour_count": blue_hour_count,
            "magic_all_count": golden_hour_count + blue_hour_count,
            "night_count": night_count,
            "on_this_day_count": on_this_day_count,
            "today_mmdd": today_mmdd,
        }

        # 2. カメラ＋レンズ別の歩留まり（打率）ランキング
        cursor.execute(
            f"""
            SELECT
                COALESCE(NULLIF(TRIM(p.camera_model), ''), '不明') AS cam,
                CASE
                    WHEN p.lens_model IS NULL OR TRIM(p.lens_model) = '' THEN '__NONE__'
                    ELSE TRIM(p.lens_model)
                END AS lens,
                COUNT(*) AS total,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
            FROM photos p
            WHERE {base_where}
            GROUP BY cam, lens
            """
        )
        lenses_list: List[Dict[str, Any]] = []
        for r in cursor.fetchall():
            tot = int(r["total"] or 0)
            if tot <= 0:
                continue
            exc = int(r["excellent"] or 0)
            gd = int(r["good"] or 0)
            acc = int(r["acceptable"] or 0)
            rej = int(r["reject"] or 0)
            cam_name = r["cam"]
            lens_raw = r["lens"]
            lens_label = "レンズ情報なし" if lens_raw == "__NONE__" else lens_raw
            exc_rate = round(exc * 100.0 / tot, 1)
            hit_rate = round((exc + gd) * 100.0 / tot, 1)
            lenses_list.append({
                "camera_model": cam_name,
                "lens_model": lens_raw,
                "label": lens_label,
                "full_label": f"{cam_name} / {lens_label}",
                "filter_key": f"{cam_name}::{lens_raw}",
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": exc_rate,
                "hit_rate": hit_rate,
            })
        lenses_list.sort(key=lambda x: (-x["excellent_rate"], -x["hit_rate"], -x["total"]))

        # 3. カメラモデル別の歩留まり集計
        cursor.execute(
            f"""
            SELECT
                COALESCE(NULLIF(TRIM(p.camera_model), ''), '不明') AS cam,
                COUNT(*) AS total,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
            FROM photos p
            WHERE {base_where}
            GROUP BY cam
            """
        )
        cameras_list: List[Dict[str, Any]] = []
        for r in cursor.fetchall():
            tot = int(r["total"] or 0)
            if tot <= 0:
                continue
            exc = int(r["excellent"] or 0)
            gd = int(r["good"] or 0)
            acc = int(r["acceptable"] or 0)
            rej = int(r["reject"] or 0)
            cameras_list.append({
                "camera_model": r["cam"],
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": round(exc * 100.0 / tot, 1),
                "hit_rate": round((exc + gd) * 100.0 / tot, 1),
            })
        cameras_list.sort(key=lambda x: (-x["excellent_rate"], -x["hit_rate"], -x["total"]))

        # 4. 焦点距離域（5区分）の集計
        focal_defs = [
            ("0-23.9", "超広角〜広角 (<24mm)", 0.0, 23.999),
            ("24-70", "標準域 (24-70mm)", 24.0, 70.0),
            ("70.1-135", "中望遠 (71-135mm)", 70.001, 135.0),
            ("135.1-300", "望遠 (136-300mm)", 135.001, 300.0),
            ("300.1-9999", "超望遠 (300mm超)", 300.001, 99999.0),
        ]
        focal_ranges: List[Dict[str, Any]] = []
        for f_key, f_label, f_min, f_max in focal_defs:
            cursor.execute(
                f"""
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                    SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                    SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                    SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
                FROM photos p
                WHERE {base_where}
                  AND p.focal_length IS NOT NULL
                  AND p.focal_length BETWEEN ? AND ?
                """,
                (f_min, f_max),
            )
            fr = cursor.fetchone()
            tot = int(fr["total"] or 0) if fr else 0
            exc = int(fr["excellent"] or 0) if fr else 0
            gd = int(fr["good"] or 0) if fr else 0
            acc = int(fr["acceptable"] or 0) if fr else 0
            rej = int(fr["reject"] or 0) if fr else 0
            focal_ranges.append({
                "range": f_key,
                "key": f_key,
                "label": f_label,
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": round(exc * 100.0 / tot, 1) if tot > 0 else 0.0,
                "hit_rate": round((exc + gd) * 100.0 / tot, 1) if tot > 0 else 0.0,
            })

        # 5. F値（絞り）域（5区分）の集計
        aperture_defs = [
            ("0.7-2.0", "大口径・開放 (〜F2.0)", 0.7, 2.0),
            ("2.1-3.5", "明るい (F2.2〜F3.5)", 2.001, 3.5),
            ("3.6-5.6", "標準絞り (F4.0〜F5.6)", 3.501, 5.6),
            ("5.7-11", "パンフォーカス (F6.3〜F11)", 5.601, 11.0),
            ("11.1-99", "小絞り (F13〜)", 11.001, 99.0),
        ]
        aperture_ranges: List[Dict[str, Any]] = []
        for a_key, a_label, a_min, a_max in aperture_defs:
            cursor.execute(
                f"""
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                    SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                    SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                    SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
                FROM photos p
                WHERE {base_where}
                  AND p.f_number IS NOT NULL
                  AND p.f_number BETWEEN ? AND ?
                """,
                (a_min, a_max),
            )
            ar = cursor.fetchone()
            tot = int(ar["total"] or 0) if ar else 0
            exc = int(ar["excellent"] or 0) if ar else 0
            gd = int(ar["good"] or 0) if ar else 0
            acc = int(ar["acceptable"] or 0) if ar else 0
            rej = int(ar["reject"] or 0) if ar else 0
            aperture_ranges.append({
                "range": a_key,
                "key": a_key,
                "label": a_label,
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": round(exc * 100.0 / tot, 1) if tot > 0 else 0.0,
                "hit_rate": round((exc + gd) * 100.0 / tot, 1) if tot > 0 else 0.0,
            })

        # 6. 時間帯別（0〜23時）の撮影リズム分布
        cursor.execute(
            f"""
            SELECT
                CAST(SUBSTR(p.date_taken, 12, 2) AS INTEGER) AS hr,
                COUNT(*) AS cnt,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS exc_cnt,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good_cnt
            FROM photos p
            WHERE {base_where}
              AND p.date_taken IS NOT NULL AND LENGTH(p.date_taken) >= 13
            GROUP BY hr
            """
        )
        hr_map: Dict[int, Dict[str, int]] = {}
        for r in cursor.fetchall():
            h_val = r["hr"]
            if h_val is not None and 0 <= int(h_val) <= 23:
                hr_map[int(h_val)] = {
                    "count": int(r["cnt"] or 0),
                    "excellent": int(r["exc_cnt"] or 0),
                    "good": int(r["good_cnt"] or 0),
                }

        hourly_distribution: List[Dict[str, Any]] = []
        for h in range(24):
            h_info = hr_map.get(h, {"count": 0, "excellent": 0, "good": 0})
            tot_h = h_info["count"]
            exc_h = h_info["excellent"]
            gd_h = h_info["good"]
            hourly_distribution.append({
                "hour": h,
                "label": f"{h:02d}:00",
                "count": tot_h,
                "total": tot_h,
                "excellent": exc_h,
                "excellent_count": exc_h,
                "good": gd_h,
                "good_count": gd_h,
                "excellent_rate": round(exc_h * 100.0 / tot_h, 1) if tot_h > 0 else 0.0,
            })

        return {
            "summary": summary,
            "lenses": lenses_list,
            "cameras": cameras_list,
            "focal_ranges": focal_ranges,
            "aperture_ranges": aperture_ranges,
            "hourly_distribution": hourly_distribution,
        }


def get_random_unrated_folder() -> Dict[str, Any]:
    """
    未整理（rating = 0: 可）の写真が残っているフォルダをランダムに1つ抽選して返す（未整理フォルダ発掘ガチャ用）。
    """
    import random

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                directory_path,
                COUNT(*) AS total_count,
                SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) AS unrated_count
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND directory_path IS NOT NULL AND directory_path != ''
            GROUP BY directory_path
            HAVING unrated_count > 0
            """
        )
        rows = cursor.fetchall()
        if not rows:
            return {"found": False, "total_unrated_folders": 0}

        chosen = random.choice(rows)
        folder_path = chosen["directory_path"]
        folder_name = os.path.basename(folder_path.rstrip("\\/")) or folder_path
        return {
            "found": True,
            "folder_path": folder_path,
            "folder_name": folder_name,
            "unrated_count": int(chosen["unrated_count"] or 0),
            "total_count": int(chosen["total_count"] or 0),
            "total_unrated_folders": len(rows),
        }




