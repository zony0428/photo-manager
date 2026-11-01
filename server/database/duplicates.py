"""
重複写真スマート管理モジュール
複数フォルダに存在する同一画像の高精度な検知、品質スコア（Quality Score）の算出、
代表写真の選定、およびサムネイルやメタデータ（タグ・星評価・非破壊調整・GPS・日時シフト）の共有を担う。
"""

import os
import logging
from typing import Any, Dict, List, Optional, Tuple

from .connection import get_connection
from .thumbnails import compute_thumbnail_hash

logger = logging.getLogger("duplicates")


def compute_photo_quality_score(photo: Dict[str, Any]) -> float:
    """
    写真のクオリティスコアを算出する。
    同一画像・類似写真グループ内で最も「マスター（原版・高品質）」にふさわしい写真を判定する。

    スコア評価基準:
    1. 解像度（総画素数）: width * height / 10,000
    2. Exifメタデータの充実度:
       - 撮影日時 (+20,000)
       - カメラ機種名が '不明' 以外 (+10,000)
       - レンズ名あり (+10,000)
       - 露出値 (F値, SS, ISO, 露出補正) 各 +5,000 (最大 +20,000)
       - GPS位置情報あり (+15,000)
    3. 圧縮密度（ビットレート）: (file_size / max(1, width * height)) * 100,000
    4. RAW原版ボーナス: is_raw == 1 の場合 +100,000
    """
    score = 0.0

    width = photo.get("width") or 0
    height = photo.get("height") or 0
    file_size = photo.get("file_size") or 0
    pixels = width * height

    # 1. 解像度スコア（原寸大を最優先: 1メガピクセル = 10,000点）
    if pixels > 0:
        score += pixels / 100.0

    # 2. Exif充実度スコア（SNS経由等のメタデータ欠落版を識別: 最大75,000点）
    if photo.get("date_taken"):
        score += 20000.0

    camera = photo.get("camera_model")
    if camera and camera != "不明":
        score += 10000.0

    lens = photo.get("lens_model")
    if lens and lens != "不明":
        score += 10000.0

    if photo.get("f_number") is not None:
        score += 5000.0
    if photo.get("shutter_speed") is not None:
        score += 5000.0
    if photo.get("iso") is not None:
        score += 5000.0
    if photo.get("exposure_bias") is not None and photo.get("exposure_bias") != 0.0:
        score += 5000.0

    if photo.get("latitude") is not None and photo.get("longitude") is not None:
        score += 15000.0

    # 3. ファイルサイズスコア（同一解像度なら過剰圧縮されていない高品質版を優先: 1MB = 1,000点）
    if file_size > 0:
        score += file_size / 1000.0

    # 4. RAW原版ボーナス（現像元ファイルを最優先）
    if photo.get("is_raw"):
        score += 200000.0

    return score


def _has_non_destructive_adjustments(photo: Dict[str, Any]) -> bool:
    """写真レコードに非破壊画像調整（回転・傾き・トリミング・トーン補正）が設定されているか判定する"""
    if int(photo.get("rotation") or 0) != 0:
        return True
    if abs(float(photo.get("fine_angle") or 0.0)) > 0.01:
        return True
    if photo.get("crop_w") is not None and photo.get("crop_h") is not None:
        return True
    if int(photo.get("brightness") or 0) != 0:
        return True
    if int(photo.get("contrast") or 0) != 0:
        return True
    if int(photo.get("saturation") or 0) != 0:
        return True
    return False


def find_duplicate_photo_match(
    file_size: int,
    date_taken: Optional[str] = None,
    camera_model: Optional[str] = None,
    exclude_photo_id: Optional[int] = None,
    file_name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    指定された特徴量（ファイルサイズ、撮影日時／シフト前元日時、カメラ機種、ファイル名）と一致する
    既存の写真レコードを高速に検索する。
    撮影日時シフト補正済みの写真（original_date_taken に元のEXIF日時を保持）にも確実にヒットさせ、
    複数候補がある場合は評価・タグ・非破壊調整・後付けGPS等の編集情報を持つレコードを最優先で返す。
    """
    if not file_size or file_size <= 0:
        return None

    # 編集済みレコードを優先するためのORDER BY句（評価・日時シフト・非破壊調整・後付けGPS・タグ有無）
    priority_order_sql = """
        ORDER BY
            (CASE WHEN rating != 0 OR is_favorite != 0 THEN 1 ELSE 0 END) DESC,
            (CASE WHEN original_date_taken IS NOT NULL AND original_date_taken != '' THEN 1 ELSE 0 END) DESC,
            (CASE WHEN COALESCE(rotation, 0) != 0
                    OR ABS(COALESCE(fine_angle, 0.0)) > 0.01
                    OR crop_w IS NOT NULL
                    OR COALESCE(brightness, 0) != 0
                    OR COALESCE(contrast, 0) != 0
                    OR COALESCE(saturation, 0) != 0 THEN 1 ELSE 0 END) DESC,
            (CASE WHEN gps_source IN ('copied', 'manual', 'inferred') OR latitude IS NOT NULL THEN 1 ELSE 0 END) DESC,
            (CASE WHEN EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = photos.id) THEN 1 ELSE 0 END) DESC,
            id ASC
        LIMIT 1
    """

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 撮影日時（またはシフト前の original_date_taken）＋ ファイルサイズ の一致
        if date_taken:
            base_where = """
                SELECT * FROM photos
                WHERE file_size = ?
                  AND (date_taken = ? OR original_date_taken = ?)
            """
            params: List[Any] = [file_size, date_taken, date_taken]
            if exclude_photo_id:
                base_where += " AND id != ?"
                params.append(exclude_photo_id)

            if camera_model and camera_model != "不明":
                # 同一カメラでの一致を優先
                cursor.execute(
                    base_where + " AND camera_model = ? " + priority_order_sql,
                    params + [camera_model],
                )
                row = cursor.fetchone()
                if row:
                    return dict(row)

            cursor.execute(base_where + priority_order_sql, params)
            row = cursor.fetchone()
            if row:
                return dict(row)

        # 2. EXIF日時がない画像の場合: ファイル名 ＋ ファイルサイズ の完全一致で照合
        if not date_taken and file_name:
            query_no_dt = """
                SELECT * FROM photos
                WHERE file_name = ? AND file_size = ?
            """
            params_no_dt: List[Any] = [file_name, file_size]
            if exclude_photo_id:
                query_no_dt += " AND id != ?"
                params_no_dt.append(exclude_photo_id)
            cursor.execute(query_no_dt + priority_order_sql, params_no_dt)
            row = cursor.fetchone()
            if row:
                return dict(row)

        return None


def get_all_duplicate_groups(limit: int = 100) -> List[Dict[str, Any]]:
    """
    ライブラリ全体から重複している写真グループ（同一撮影日時 ＋ 同一ファイルサイズ）を検索し、
    各グループのメンバーおよび品質スコアが最高の「代表写真（primary）」を選定して返す。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        # 撮影日時とファイルサイズが同一で複数件存在するグループを抽出
        cursor.execute(
            """
            SELECT date_taken, file_size, COUNT(*) as count
            FROM photos
            WHERE date_taken IS NOT NULL AND date_taken != '' AND file_size > 0
              AND IFNULL(is_unlinked, 0) = 0
            GROUP BY date_taken, file_size
            HAVING count > 1
            ORDER BY count DESC, date_taken DESC
            LIMIT ?
            """,
            (limit,),
        )
        groups_summary = cursor.fetchall()
        if not groups_summary:
            return []

        results: List[Dict[str, Any]] = []

        for group in groups_summary:
            dt = group["date_taken"]
            sz = group["file_size"]

            cursor.execute(
                """
                SELECT p.*,
                       v.volume_label,
                       COALESCE(v.custom_name, '') as volume_custom_name,
                       (SELECT GROUP_CONCAT(tag, ', ') FROM photo_tags WHERE photo_id = p.id) as tags_str
                FROM photos p
                LEFT JOIN volumes v ON p.volume_serial = v.volume_serial
                WHERE p.date_taken = ? AND p.file_size = ?
                  AND IFNULL(p.is_unlinked, 0) = 0
                ORDER BY p.id ASC
                """,
                (dt, sz),
            )
            members = [dict(r) for r in cursor.fetchall()]
            if len(members) <= 1:
                continue

            # 各メンバーの品質スコアを計算
            scored_members = []
            for m in members:
                score = compute_photo_quality_score(m)
                m_copy = dict(m)
                m_copy["quality_score"] = score
                scored_members.append(m_copy)

            # スコア降順（同点時はID昇順）でソートし、先頭を代表とする
            scored_members.sort(key=lambda x: (x["quality_score"], -x["id"]), reverse=True)
            primary_id = scored_members[0]["id"]

            results.append(
                {
                    "date_taken": dt,
                    "file_size": sz,
                    "count": len(scored_members),
                    "primary_photo_id": primary_id,
                    "photos": scored_members,
                }
            )

        return results


def copy_metadata_to_duplicate(source_photo_id: int, target_photo_id: int) -> bool:
    """
    同一写真間でユーザー編集メタデータを安全・確実に引き継ぐ。
    引き継ぎ対象:
      1. 4段階評価 (rating) / お気に入り (is_favorite)
      2. 撮影日時シフト補正 (date_taken, year_month, original_date_taken)
      3. 非破壊画像調整 (rotation, fine_angle, crop_x/y/w/h/aspect, brightness, contrast, saturation)
      4. GPS位置情報・撮影地名 (latitude, longitude, gps_source, country, state, city)
      5. タグ一覧 (photo_tags: 手動タグ・階層タグ・カラータグ・AIタグ)
      6. サムネイルBLOB (非破壊調整済みサムネイルの反映・高速複製)
    ※ ターゲット側に既に設定値がある項目は上書きせず、未設定（初期値）の項目のみ安全にマージする。
    ※ ソース写真がペア済みRAWで、ペア相手の代表JPEG側にメタデータがある場合はそちらも補完参照する。
    """
    if source_photo_id == target_photo_id:
        return False

    with get_connection() as conn:
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM photos WHERE id = ?", (source_photo_id,))
        src_row = cursor.fetchone()
        if not src_row:
            return False
        source = dict(src_row)

        cursor.execute("SELECT * FROM photos WHERE id = ?", (target_photo_id,))
        tgt_row = cursor.fetchone()
        if not tgt_row:
            return False
        target = dict(tgt_row)

        # ソースがペア済みRAW（またはペア相手が存在する写真）の場合、ペア相手レコードも補完候補として取得
        pair_source: Optional[Dict[str, Any]] = None
        paired_path = source.get("paired_raw_path")
        if paired_path:
            cursor.execute("SELECT * FROM photos WHERE file_path = ? AND id != ? LIMIT 1", (paired_path, source_photo_id))
            p_row = cursor.fetchone()
            if p_row:
                pair_source = dict(p_row)

        def _pick_source_field(field_check_fn) -> Dict[str, Any]:
            """source 自身に該当編集があれば source を、なければ pair_source を返す"""
            if field_check_fn(source):
                return source
            if pair_source and field_check_fn(pair_source):
                return pair_source
            return source

        # 1. 評価 & お気に入り
        r_src = _pick_source_field(lambda d: int(d.get("rating") or 0) != 0)
        f_src = _pick_source_field(lambda d: int(d.get("is_favorite") or 0) != 0)
        new_rating = int(target.get("rating") or 0)
        if new_rating == 0 and int(r_src.get("rating") or 0) != 0:
            new_rating = int(r_src["rating"])

        new_favorite = int(target.get("is_favorite") or 0)
        if new_favorite == 0 and int(f_src.get("is_favorite") or 0) != 0:
            new_favorite = int(f_src["is_favorite"])

        # 2. 撮影日時シフト補正（original_date_taken が記録されている場合）
        dt_src = _pick_source_field(lambda d: bool(d.get("original_date_taken") and str(d["original_date_taken"]).strip()))
        new_date_taken = target.get("date_taken")
        new_year_month = target.get("year_month")
        new_orig_dt = target.get("original_date_taken")
        if (not new_orig_dt or not str(new_orig_dt).strip()) and dt_src.get("original_date_taken"):
            new_date_taken = dt_src.get("date_taken") or new_date_taken
            new_year_month = dt_src.get("year_month") or new_year_month
            new_orig_dt = dt_src.get("original_date_taken")

        # 3. 非破壊画像調整パラメータ
        adj_src = _pick_source_field(_has_non_destructive_adjustments)
        copied_adjustments = False
        if not _has_non_destructive_adjustments(target) and _has_non_destructive_adjustments(adj_src):
            new_rotation = int(adj_src.get("rotation") or 0)
            new_fine_angle = float(adj_src.get("fine_angle") or 0.0)
            new_crop_x = adj_src.get("crop_x")
            new_crop_y = adj_src.get("crop_y")
            new_crop_w = adj_src.get("crop_w")
            new_crop_h = adj_src.get("crop_h")
            new_crop_aspect = adj_src.get("crop_aspect")
            new_brightness = int(adj_src.get("brightness") or 0)
            new_contrast = int(adj_src.get("contrast") or 0)
            new_saturation = int(adj_src.get("saturation") or 0)
            copied_adjustments = True
        else:
            new_rotation = int(target.get("rotation") or 0)
            new_fine_angle = float(target.get("fine_angle") or 0.0)
            new_crop_x = target.get("crop_x")
            new_crop_y = target.get("crop_y")
            new_crop_w = target.get("crop_w")
            new_crop_h = target.get("crop_h")
            new_crop_aspect = target.get("crop_aspect")
            new_brightness = int(target.get("brightness") or 0)
            new_contrast = int(target.get("contrast") or 0)
            new_saturation = int(target.get("saturation") or 0)

        # 4. GPS・撮影地情報（後付けGPSやEXIF GPSの引き継ぎ）
        gps_src = _pick_source_field(
            lambda d: d.get("latitude") is not None and d.get("longitude") is not None
        )
        new_lat = target.get("latitude")
        new_lon = target.get("longitude")
        new_gps_source = target.get("gps_source")
        new_country = target.get("country")
        new_state = target.get("state")
        new_city = target.get("city")

        src_has_gps = gps_src.get("latitude") is not None and gps_src.get("longitude") is not None
        tgt_has_gps = new_lat is not None and new_lon is not None
        src_is_user_gps = gps_src.get("gps_source") in ("copied", "manual", "inferred")
        tgt_is_user_gps = new_gps_source in ("copied", "manual", "inferred")

        if src_has_gps and (not tgt_has_gps or (src_is_user_gps and not tgt_is_user_gps)):
            new_lat = gps_src.get("latitude")
            new_lon = gps_src.get("longitude")
            new_gps_source = gps_src.get("gps_source")
            new_country = gps_src.get("country")
            new_state = gps_src.get("state")
            new_city = gps_src.get("city")

        cursor.execute(
            """
            UPDATE photos
            SET rating = ?,
                is_favorite = ?,
                date_taken = ?,
                year_month = ?,
                original_date_taken = ?,
                rotation = ?,
                fine_angle = ?,
                crop_x = ?,
                crop_y = ?,
                crop_w = ?,
                crop_h = ?,
                crop_aspect = ?,
                brightness = ?,
                contrast = ?,
                saturation = ?,
                latitude = ?,
                longitude = ?,
                gps_source = ?,
                country = ?,
                state = ?,
                city = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                new_rating,
                new_favorite,
                new_date_taken,
                new_year_month,
                new_orig_dt,
                new_rotation,
                new_fine_angle,
                new_crop_x,
                new_crop_y,
                new_crop_w,
                new_crop_h,
                new_crop_aspect,
                new_brightness,
                new_contrast,
                new_saturation,
                new_lat,
                new_lon,
                new_gps_source,
                new_country,
                new_state,
                new_city,
                target_photo_id,
            ),
        )

        # 5. ソース写真（およびペア相手があればその写真）のタグをコピー（UNIQUE制約があるため INSERT OR IGNORE）
        tag_source_ids = [source_photo_id]
        if pair_source and pair_source.get("id") and pair_source["id"] != target_photo_id:
            tag_source_ids.append(pair_source["id"])

        for tid_src in tag_source_ids:
            cursor.execute(
                """
                INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence)
                SELECT ?, tag, source, confidence
                FROM photo_tags
                WHERE photo_id = ?
                """,
                (target_photo_id, tid_src),
            )

        # 6. サムネイルBLOBの引き継ぎ（特に非破壊調整済みサムネイルの即時反映）
        cursor.execute("SELECT 1 FROM thumbnails WHERE photo_id = ? LIMIT 1", (target_photo_id,))
        tgt_has_thumb = cursor.fetchone() is not None
        if not tgt_has_thumb or copied_adjustments:
            thumb_donor_id = adj_src.get("id") if copied_adjustments else source_photo_id
            cursor.execute(
                "SELECT data, width, height FROM thumbnails WHERE photo_id = ? ORDER BY created_at DESC LIMIT 1",
                (thumb_donor_id,),
            )
            donor_thumb = cursor.fetchone()
            if not donor_thumb and thumb_donor_id != source_photo_id:
                cursor.execute(
                    "SELECT data, width, height FROM thumbnails WHERE photo_id = ? ORDER BY created_at DESC LIMIT 1",
                    (source_photo_id,),
                )
                donor_thumb = cursor.fetchone()

            if donor_thumb and donor_thumb["data"]:
                tgt_fp = target.get("file_path") or str(target_photo_id)
                tgt_mtime = target.get("file_mtime")
                new_fh = compute_thumbnail_hash(tgt_fp, tgt_mtime)
                cursor.execute("DELETE FROM thumbnails WHERE photo_id = ?", (target_photo_id,))
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO thumbnails (file_hash, photo_id, data, width, height)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (new_fh, target_photo_id, donor_thumb["data"], donor_thumb["width"], donor_thumb["height"]),
                )

        conn.commit()
        return True


def get_duplicates_for_photo(photo_id: int) -> List[Dict[str, Any]]:
    """
    指定された写真と同一（同一撮影日時 ＋ 同一ファイルサイズ）の全写真レコードを返す。
    他フォルダに存在するコピー写真（自分自身を含む）を抽出し、各写真のパスやボリューム情報を付加する。
    重複が存在しない（1件のみ）の場合は空リスト [] を返す。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT date_taken, file_size FROM photos WHERE id = ?", (photo_id,))
        target = cursor.fetchone()
        if not target or not target["date_taken"] or not target["file_size"]:
            return []

        dt = target["date_taken"]
        sz = target["file_size"]

        cursor.execute(
            """
            SELECT p.id, p.file_name, p.file_path, p.directory_path, p.file_size,
                   p.width, p.height, p.date_taken, p.camera_model, p.lens_model,
                   p.rating, p.is_favorite, p.is_raw, p.is_unlinked,
                   p.stack_id, p.is_stack_primary, p.stack_type,
                   p.volume_serial,
                   v.volume_label,
                   COALESCE(v.custom_name, '') as volume_custom_name
            FROM photos p
            LEFT JOIN volumes v ON p.volume_serial = v.volume_serial
            WHERE p.date_taken = ? AND p.file_size = ?
              AND IFNULL(p.is_unlinked, 0) = 0
            ORDER BY p.id ASC
            """,
            (dt, sz),
        )
        rows = [dict(r) for r in cursor.fetchall()]
        if len(rows) <= 1:
            return []

        try:
            from ..scanner import resolve_portable_path, strip_vsn_prefix
        except Exception:
            resolve_portable_path = None
            strip_vsn_prefix = None

        # 実ファイルの存在チェック（VSN対応 is_offline）およびドライブレター抽出
        for r in rows:
            fp = r.get("file_path") or ""
            vol_ser = r.get("volume_serial")
            if strip_vsn_prefix:
                clean_fp = strip_vsn_prefix(fp)
            else:
                clean_fp = fp
            r["file_path"] = clean_fp
            if resolve_portable_path and fp:
                resolved_p, is_online = resolve_portable_path(fp, expected_serial=vol_ser)
                r["is_offline"] = not (is_online and resolved_p.exists())
                resolved_str = str(resolved_p)
                if is_online and len(resolved_str) >= 2 and resolved_str[1] == ":":
                    r["volume_drive"] = resolved_str[:2].upper()
                elif len(clean_fp) >= 2 and clean_fp[1] == ":":
                    r["volume_drive"] = clean_fp[:2].upper()
                else:
                    r["volume_drive"] = None
            else:
                r["is_offline"] = not (clean_fp and os.path.exists(clean_fp))
                if clean_fp and len(clean_fp) >= 2 and clean_fp[1] == ":":
                    r["volume_drive"] = clean_fp[:2].upper()
                else:
                    r["volume_drive"] = None

        return rows


def get_duplicate_photo_ids() -> List[int]:
    """
    ライブラリ全体で重複（同一撮影日時 ＋ 同一ファイルサイズ）が存在する全写真のIDリストを取得する。
    クイックアクセス「重複のある写真」絞り込み用。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.id
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
            ORDER BY p.date_taken DESC, p.id ASC
            """
        )
        return [r["id"] for r in cursor.fetchall()]
