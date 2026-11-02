"""
重複写真スマート管理モジュール
複数フォルダ・複数メディアに存在する同一画像の検知（photo_links 連携）、品質スコア（Quality Score）の算出、
代表リンクの選定、およびサムネイルやメタデータ（タグ・評価・非破壊調整・GPS・日時シフト）の共有を担う。
"""

import os
import logging
from typing import Any, Dict, List, Optional

from .connection import get_connection
from .thumbnails import compute_thumbnail_hash

logger = logging.getLogger("duplicates")


def compute_photo_quality_score(photo: Dict[str, Any]) -> float:
    """
    写真のクオリティスコアを算出する。
    同一画像・類似写真グループ内で最も「マスター（原版・高品質）」にふさわしい写真を判定する。
    """
    score = 0.0

    width = photo.get("width") or 0
    height = photo.get("height") or 0
    file_size = photo.get("file_size") or 0
    pixels = width * height

    if pixels > 0:
        score += pixels / 100.0

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

    if file_size > 0:
        score += file_size / 1000.0

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
    """
    if not file_size or file_size <= 0:
        return None

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
    ライブラリ全体から複数の所在リンク（photo_links）を持つ重複写真を検索し、
    各グループ（photo_id 単位）のリンクメンバーおよび代表を選定して返す。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*,
                   (SELECT GROUP_CONCAT(tag, ', ') FROM photo_tags WHERE photo_id = p.id) as tags_str
            FROM photos p
            WHERE IFNULL(p.is_unlinked, 0) = 0
              AND COALESCE(p.link_count, 1) > 1
            ORDER BY p.link_count DESC, p.date_taken DESC, p.id ASC
            LIMIT ?
            """,
            (limit,),
        )
        dup_photos = [dict(r) for r in cursor.fetchall()]
        if not dup_photos:
            return []

        try:
            from ..scanner import strip_vsn_prefix
        except Exception:
            strip_vsn_prefix = None

        results: List[Dict[str, Any]] = []
        for p in dup_photos:
            pid = p["id"]
            cursor.execute(
                """
                SELECT pl.*,
                       v.volume_label,
                       COALESCE(v.custom_name, '') as volume_custom_name
                FROM photo_links pl
                LEFT JOIN volumes v ON pl.volume_serial = v.volume_serial
                WHERE pl.photo_id = ?
                ORDER BY pl.is_primary DESC, pl.id ASC
                """,
                (pid,),
            )
            links = [dict(r) for r in cursor.fetchall()]
            if len(links) <= 1:
                continue

            base_score = compute_photo_quality_score(p)
            scored_members = []
            for lk in links:
                m_copy = dict(p)
                fp = lk.get("file_path") or p.get("file_path") or ""
                if strip_vsn_prefix and fp:
                    fp = strip_vsn_prefix(fp)
                m_copy["link_id"] = lk["id"]
                m_copy["file_path"] = fp
                m_copy["directory_path"] = lk.get("directory_path") or p.get("directory_path")
                m_copy["file_name"] = lk.get("file_name") or p.get("file_name")
                m_copy["volume_serial"] = lk.get("volume_serial") or None
                m_copy["volume_label"] = lk.get("volume_label")
                m_copy["volume_custom_name"] = lk.get("volume_custom_name") or ""
                m_copy["quality_score"] = base_score
                scored_members.append(m_copy)

            results.append(
                {
                    "photo_id": pid,
                    "date_taken": p.get("date_taken"),
                    "file_size": p.get("file_size"),
                    "count": len(scored_members),
                    "primary_photo_id": pid,
                    "photos": scored_members,
                }
            )

        return results


def _copy_metadata_to_duplicate_with_cursor(cursor: Any, source_photo_id: int, target_photo_id: int) -> bool:
    """指定カーソルを用いて同一写真間でユーザー編集メタデータを安全・確実に引き継ぐ内部実装"""
    if source_photo_id == target_photo_id:
        # 同一 photo_id に統合済みの写真で、いずれかのリンクに paired_raw_path（ペア相手）があればペア相手をソースとして引き継ぐ
        cursor.execute(
            "SELECT paired_raw_path FROM photo_links WHERE photo_id = ? AND paired_raw_path IS NOT NULL AND paired_raw_path != '' LIMIT 1",
            (target_photo_id,),
        )
        lk_pair = cursor.fetchone()
        paired_p = lk_pair["paired_raw_path"] if lk_pair else None
        if not paired_p:
            cursor.execute("SELECT paired_raw_path FROM photos WHERE id = ?", (target_photo_id,))
            p_row = cursor.fetchone()
            paired_p = p_row["paired_raw_path"] if p_row else None
        if not paired_p:
            return False
        cursor.execute(
            """
            SELECT id FROM photos
            WHERE (file_path = ? COLLATE NOCASE OR id IN (SELECT photo_id FROM photo_links WHERE file_path = ? COLLATE NOCASE))
              AND id != ?
            LIMIT 1
            """,
            (paired_p, paired_p, target_photo_id),
        )
        pair_row = cursor.fetchone()
        if not pair_row:
            return False
        source_photo_id = int(pair_row["id"])

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

    pair_source: Optional[Dict[str, Any]] = None
    paired_path = source.get("paired_raw_path")
    if not paired_path:
        cursor.execute(
            "SELECT paired_raw_path FROM photo_links WHERE photo_id = ? AND paired_raw_path IS NOT NULL AND paired_raw_path != '' LIMIT 1",
            (source_photo_id,),
        )
        lk_p = cursor.fetchone()
        if lk_p:
            paired_path = lk_p["paired_raw_path"]
    if paired_path:
        cursor.execute(
            """
            SELECT * FROM photos
            WHERE (file_path = ? COLLATE NOCASE OR id IN (SELECT photo_id FROM photo_links WHERE file_path = ? COLLATE NOCASE))
              AND id != ?
            LIMIT 1
            """,
            (paired_path, paired_path, source_photo_id),
        )
        p_row = cursor.fetchone()
        if p_row:
            pair_source = dict(p_row)

    def _pick_source_field(field_check_fn) -> Dict[str, Any]:
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

    # 2. 撮影日時シフト補正
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

    # 4. GPS・撮影地情報
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

    # 5. タグのコピー
    tag_source_ids = [source_photo_id]
    if pair_source and pair_source.get("id") and pair_source["id"] != target_photo_id:
        tag_source_ids.append(pair_source["id"])

    for tid_src in tag_source_ids:
        cursor.execute(
            """
            INSERT INTO photo_tags (photo_id, tag, source, confidence)
            SELECT ?, tag, COALESCE(source, 'manual'), COALESCE(confidence, 1.0)
            FROM photo_tags
            WHERE photo_id = ?
            ON CONFLICT(photo_id, tag) DO UPDATE SET
                source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE photo_tags.source END,
                confidence = CASE WHEN excluded.source = 'manual' THEN 1.0 ELSE MAX(COALESCE(photo_tags.confidence, 0.0), COALESCE(excluded.confidence, 0.0)) END
            """,
            (target_photo_id, tid_src),
        )

    # 6. サムネイルBLOBの引き継ぎ
    cursor.execute("SELECT 1 FROM thumbnails WHERE photo_id = ? LIMIT 1", (target_photo_id,))
    tgt_has_thumb = cursor.fetchone() is not None
    if not tgt_has_thumb or copied_adjustments:
        thumb_donor_id = adj_src.get("id") if copied_adjustments else source_photo_id
        cursor.execute(
            "SELECT data, width, height FROM thumbnails WHERE photo_id = ? LIMIT 1",
            (thumb_donor_id,),
        )
        donor_thumb = cursor.fetchone()
        if not donor_thumb and thumb_donor_id != source_photo_id:
            cursor.execute(
                "SELECT data, width, height FROM thumbnails WHERE photo_id = ? LIMIT 1",
                (source_photo_id,),
            )
            donor_thumb = cursor.fetchone()

        if donor_thumb and donor_thumb["data"]:
            tgt_fp = target.get("file_path") or str(target_photo_id)
            tgt_mtime = target.get("file_mtime")
            new_fh = compute_thumbnail_hash(tgt_fp, tgt_mtime)
            cursor.execute(
                """
                INSERT OR REPLACE INTO thumbnails (photo_id, file_hash, data, width, height)
                VALUES (?, ?, ?, ?, ?)
                """,
                (target_photo_id, new_fh, donor_thumb["data"], donor_thumb["width"], donor_thumb["height"]),
            )

    return True


def copy_metadata_to_duplicate(
    source_photo_id: int,
    target_photo_id: int,
    cursor: Optional[Any] = None,
) -> bool:
    """
    同一写真間でユーザー編集メタデータを安全・確実に引き継ぐ。
    """
    if cursor is not None:
        return _copy_metadata_to_duplicate_with_cursor(cursor, source_photo_id, target_photo_id)

    with get_connection() as conn:
        cur = conn.cursor()
        ok = _copy_metadata_to_duplicate_with_cursor(cur, source_photo_id, target_photo_id)
        if ok:
            conn.commit()
        return ok


def get_duplicates_for_photo(photo_id: int) -> List[Dict[str, Any]]:
    """
    指定された写真に紐づくすべての実ファイル所在リンク (photo_links) を返す。
    複数メディア・複数フォルダに存在するリンク一覧を抽出し、各リンクのパスやボリューム情報・接続状態を付加する。
    リンクが1件以下の場合は空リスト [] を返す。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.id, p.file_name, p.file_path, p.directory_path, p.file_size,
                   p.width, p.height, p.date_taken, p.camera_model, p.lens_model,
                   p.rating, p.is_favorite, p.is_raw, p.is_unlinked,
                   p.stack_id, p.is_stack_primary, p.stack_type,
                   p.volume_serial
            FROM photos p
            WHERE p.id = ? AND IFNULL(p.is_unlinked, 0) = 0
            """,
            (photo_id,),
        )
        p_row = cursor.fetchone()
        if not p_row:
            return []
        base_photo = dict(p_row)

        cursor.execute(
            """
            SELECT pl.*,
                   v.volume_label,
                   COALESCE(v.custom_name, '') as volume_custom_name
            FROM photo_links pl
            LEFT JOIN volumes v ON pl.volume_serial = v.volume_serial
            WHERE pl.photo_id = ?
            ORDER BY pl.is_primary DESC, pl.id ASC
            """,
            (photo_id,),
        )
        links = [dict(r) for r in cursor.fetchall()]
        if len(links) <= 1:
            return []

        try:
            from ..scanner import resolve_portable_path, strip_vsn_prefix
        except Exception:
            resolve_portable_path = None
            strip_vsn_prefix = None

        rows: List[Dict[str, Any]] = []
        for lk in links:
            r = dict(base_photo)
            fp = lk.get("file_path") or ""
            vol_ser = lk.get("volume_serial") or None
            clean_fp = strip_vsn_prefix(fp) if strip_vsn_prefix else fp
            r["link_id"] = lk["id"]
            r["file_path"] = clean_fp
            r["directory_path"] = lk.get("directory_path") or base_photo.get("directory_path")
            r["file_name"] = lk.get("file_name") or base_photo.get("file_name")
            r["volume_serial"] = vol_ser
            r["volume_label"] = lk.get("volume_label")
            r["volume_custom_name"] = lk.get("volume_custom_name") or ""

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
            rows.append(r)

        return rows


def get_duplicate_photo_ids() -> List[int]:
    """
    ライブラリ全体で重複（複数フォルダ・複数メディアにリンクが存在する）全写真のIDリストを取得する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id
            FROM photos
            WHERE IFNULL(is_unlinked, 0) = 0
              AND COALESCE(link_count, 1) > 1
            ORDER BY date_taken DESC, id ASC
            """
        )
        return [r["id"] for r in cursor.fetchall()]
