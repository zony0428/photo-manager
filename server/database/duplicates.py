"""
重複写真スマート管理モジュール
複数フォルダに存在する同一画像の高精度な検知、品質スコア（Quality Score）の算出、
代表写真の選定、およびサムネイルやメタデータ（タグ・星評価）の共有を担う。
"""

import os
import logging
from typing import Any, Dict, List, Optional, Tuple

from .connection import get_connection

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


def find_duplicate_photo_match(
    file_size: int,
    date_taken: Optional[str] = None,
    camera_model: Optional[str] = None,
    exclude_photo_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    指定された特徴量（ファイルサイズ、撮影日時、カメラ機種等）と一致する
    既存の写真レコードを高速に検索する。
    サムネイルの共有やタグの初期連携で同一写真を特定するために使用する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 撮影日時 ＋ ファイルサイズ の一致（Exifがある画像での最高精度一致）
        if date_taken:
            query = """
                SELECT * FROM photos
                WHERE date_taken = ? AND file_size = ?
            """
            params: List[Any] = [date_taken, file_size]
            if exclude_photo_id:
                query += " AND id != ?"
                params.append(exclude_photo_id)

            if camera_model and camera_model != "不明":
                # 同一カメラでの一致を優先
                cursor.execute(query + " AND camera_model = ? LIMIT 1", params + [camera_model])
                row = cursor.fetchone()
                if row:
                    return dict(row)

            cursor.execute(query + " LIMIT 1", params)
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
    同一写真間でタグ、星評価、お気に入りを安全にコピーする。
    source_photo_id のメタデータを target_photo_id へ反映（既存値がある場合はマージ）。
    """
    if source_photo_id == target_photo_id:
        return False

    with get_connection() as conn:
        cursor = conn.cursor()

        # ソース写真の評価とお気に入りを取得
        cursor.execute("SELECT rating, is_favorite FROM photos WHERE id = ?", (source_photo_id,))
        source = cursor.fetchone()
        if not source:
            return False

        # ターゲット写真の評価とお気に入りを更新（ソース側が有効な値の場合）
        if source["rating"] != 0 or source["is_favorite"] != 0:
            cursor.execute(
                """
                UPDATE photos
                SET rating = CASE WHEN rating = 0 THEN ? ELSE rating END,
                    is_favorite = CASE WHEN is_favorite = 0 THEN ? ELSE is_favorite END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (source["rating"], source["is_favorite"], target_photo_id),
            )

        # ソース写真のタグをコピー（UNIQUE制約があるため INSERT OR IGNORE）
        cursor.execute(
            """
            INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence)
            SELECT ?, tag, source, confidence
            FROM photo_tags
            WHERE photo_id = ?
            """,
            (target_photo_id, source_photo_id),
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
                   v.volume_label, v.volume_serial
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

        # 実ファイルの存在チェック（is_offline）およびドライブレター抽出
        for r in rows:
            fp = r.get("file_path")
            r["is_offline"] = not (fp and os.path.exists(fp))
            if fp and len(fp) >= 2 and fp[1] == ":":
                r["volume_drive"] = fp[:2].upper()
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
