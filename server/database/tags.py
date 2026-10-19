"""
タグ管理モジュール
写真への階層タグ付け（祖先ノード自動展開）、バッチ操作、リネーム、削除を提供する。
"""

from typing import Any, Dict, List, Optional

from .connection import get_connection
from .photos import _directory_filter_sql
def _expand_ancestor_tags(tag: str) -> List[str]:
    """タグパスからすべての祖先パスを含むリストを生成する。
    例: 'A/B/C' → ['A', 'A/B', 'A/B/C']
    """
    parts = tag.split("/")
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


def _expand_stack_and_pair_photo_ids(conn, photo_ids: List[int]) -> List[int]:
    """指定された写真ID群から、同一スタック（stack_id）およびRAW+JPEGペア（paired_raw_path）の写真IDをすべて取得・展開する"""
    if not photo_ids:
        return []

    cursor = conn.cursor()
    all_ids = set(photo_ids)
    chunk_size = 500
    id_list = list(photo_ids)

    stack_ids = set()
    file_paths = set()
    paired_paths = set()

    for i in range(0, len(id_list), chunk_size):
        chunk = id_list[i : i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))
        cursor.execute(
            f"SELECT id, stack_id, file_path, paired_raw_path FROM photos WHERE id IN ({placeholders})",
            chunk,
        )
        for row in cursor.fetchall():
            sid = row["stack_id"]
            if sid:
                stack_ids.add(sid)
            fp = row["file_path"]
            if fp:
                file_paths.add(fp)
            prp = row["paired_raw_path"]
            if prp:
                paired_paths.add(prp)

    # 1. 同一スタック（連写/ブラケット/スタック付随RAW）の写真IDを展開
    if stack_ids:
        s_list = list(stack_ids)
        for i in range(0, len(s_list), chunk_size):
            chunk = s_list[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"SELECT id FROM photos WHERE stack_id IN ({placeholders})",
                chunk,
            )
            for row in cursor.fetchall():
                all_ids.add(row["id"])

    # 2. RAW+JPEGペア（paired_raw_path）の写真IDを展開
    if paired_paths:
        p_list = list(paired_paths)
        for i in range(0, len(p_list), chunk_size):
            chunk = p_list[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"SELECT id FROM photos WHERE file_path IN ({placeholders})",
                chunk,
            )
            for row in cursor.fetchall():
                all_ids.add(row["id"])

    if file_paths:
        f_list = list(file_paths)
        for i in range(0, len(f_list), chunk_size):
            chunk = f_list[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"SELECT id FROM photos WHERE paired_raw_path IN ({placeholders})",
                chunk,
            )
            for row in cursor.fetchall():
                all_ids.add(row["id"])

    return list(all_ids)


def add_tag_to_photo(photo_id: int, tag: str) -> bool:
    """写真にタグを追加する（スタック・ペア全体にも自動連動、祖先パス自動追加・AIタグは手動昇格）"""
    cleaned_tag = tag.strip()
    if not cleaned_tag:
        return False
    all_tags = _expand_ancestor_tags(cleaned_tag)
    with get_connection() as conn:
        cursor = conn.cursor()
        target_ids = _expand_stack_and_pair_photo_ids(conn, [photo_id])
        cursor.executemany(
            """
            INSERT INTO photo_tags (photo_id, tag, source, confidence)
            VALUES (?, ?, 'manual', 1.0)
            ON CONFLICT(photo_id, tag) DO UPDATE SET
                source = 'manual',
                confidence = 1.0
            """,
            [(pid, t) for pid in target_ids for t in all_tags],
        )
        conn.commit()
        return cursor.rowcount > 0


def remove_tag_from_photo(photo_id: int, tag: str) -> bool:
    """写真から特定のタグとその子孫タグを削除する（スタック・ペア全体にも自動連動、祖先タグは残す）"""
    cleaned_tag = tag.strip()
    if not cleaned_tag:
        return False
    with get_connection() as conn:
        cursor = conn.cursor()
        target_ids = _expand_stack_and_pair_photo_ids(conn, [photo_id])
        if not target_ids:
            return False
        total_deleted = 0
        chunk_size = 500
        for i in range(0, len(target_ids), chunk_size):
            chunk = target_ids[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders}) AND (tag = ? OR tag LIKE ?)",
                chunk + [cleaned_tag, f"{cleaned_tag}/%"],
            )
            total_deleted += cursor.rowcount
        conn.commit()
        return total_deleted > 0


def batch_add_tag(photo_ids: List[int], tag: str) -> int:
    """複数の写真に一括でタグを追加する（スタック・ペア全体にも自動連動、祖先パス自動追加・手動昇格）"""
    cleaned_tag = tag.strip()
    if not cleaned_tag or not photo_ids:
        return 0
    all_tags = _expand_ancestor_tags(cleaned_tag)
    with get_connection() as conn:
        cursor = conn.cursor()
        target_ids = _expand_stack_and_pair_photo_ids(conn, photo_ids)
        cursor.executemany(
            """
            INSERT INTO photo_tags (photo_id, tag, source, confidence)
            VALUES (?, ?, 'manual', 1.0)
            ON CONFLICT(photo_id, tag) DO UPDATE SET
                source = 'manual',
                confidence = 1.0
            """,
            [(pid, t) for pid in target_ids for t in all_tags],
        )
        conn.commit()
        return cursor.rowcount


def add_ai_tags_to_photo(photo_id: int, tag_items: List[Dict[str, Any]]) -> int:
    """AI自動タグを写真に追加する（手動タグが既に存在する場合は上書きせず保持）"""
    if not tag_items:
        return 0
    params = []
    for item in tag_items:
        tag = item.get("tag", "").strip()
        confidence = float(item.get("confidence", 0.0))
        if not tag:
            continue
        all_tags = _expand_ancestor_tags(tag)
        for t in all_tags:
            params.append((photo_id, t, confidence))
    if not params:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.executemany(
            """
            INSERT INTO photo_tags (photo_id, tag, source, confidence)
            VALUES (?, ?, 'ai', ?)
            ON CONFLICT(photo_id, tag) DO UPDATE SET
                confidence = excluded.confidence
            WHERE photo_tags.source = 'ai'
            """,
            params,
        )
        conn.commit()
        return cursor.rowcount


def promote_ai_tag(photo_id: int, tag: str) -> bool:
    """AIタグを手動タグに昇格（確定）する（スタック・ペア全体にも自動連動）"""
    cleaned_tag = tag.strip()
    if not cleaned_tag:
        return False
    with get_connection() as conn:
        cursor = conn.cursor()
        target_ids = _expand_stack_and_pair_photo_ids(conn, [photo_id])
        if not target_ids:
            return False
        total_updated = 0
        chunk_size = 500
        for i in range(0, len(target_ids), chunk_size):
            chunk = target_ids[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"UPDATE photo_tags SET source = 'manual', confidence = 1.0 WHERE photo_id IN ({placeholders}) AND tag = ?",
                chunk + [cleaned_tag],
            )
            total_updated += cursor.rowcount
        conn.commit()
        return total_updated > 0


def remove_ai_tags(photo_id: Optional[int] = None, folder_path: Optional[str] = None) -> int:
    """AIによって付与されたタグのみを一括削除する（手動タグは完全保護）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        if photo_id is not None:
            cursor.execute("DELETE FROM photo_tags WHERE photo_id = ? AND source = 'ai'", (photo_id,))
        elif folder_path is not None:
            sql_frag, sql_params = _directory_filter_sql(folder_path, recursive=True, column_name="directory_path")
            cursor.execute(
                f"""
                DELETE FROM photo_tags
                WHERE source = 'ai' AND photo_id IN (
                    SELECT id FROM photos
                    WHERE {sql_frag}
                )
                """,
                sql_params,
            )
        else:
            cursor.execute("DELETE FROM photo_tags WHERE source = 'ai'")
        conn.commit()
        return cursor.rowcount


def get_photo_tags_details(photo_id: int) -> List[Dict[str, Any]]:
    """写真のタグ詳細（source, confidence 含む）を取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT tag, source, confidence FROM photo_tags WHERE photo_id = ? ORDER BY tag ASC",
            (photo_id,),
        )
        return [dict(r) for r in cursor.fetchall()]


def batch_remove_tag(photo_ids: List[int], tag: str) -> int:
    """複数の写真（および同一スタック・ペア全体）から一括でタグを削除する（マルチ選択用・完全一致および配下タグ対応）"""
    cleaned_tag = tag.strip()
    if not cleaned_tag or not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        target_ids = _expand_stack_and_pair_photo_ids(conn, photo_ids)
        if not target_ids:
            return 0
        total_deleted = 0
        chunk_size = 500
        for i in range(0, len(target_ids), chunk_size):
            chunk = target_ids[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"""
                DELETE FROM photo_tags
                WHERE photo_id IN ({placeholders})
                  AND (tag = ? OR tag LIKE ?)
                """,
                chunk + [cleaned_tag, f"{cleaned_tag}/%"],
            )
            total_deleted += cursor.rowcount
        conn.commit()
        return total_deleted


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


def get_all_tags_summary() -> List[Dict[str, Any]]:
    """すべてのタグと、それぞれが付けられている写真枚数・属性（手動/AI）を集計する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT 
                tag, 
                COUNT(DISTINCT photo_id) as count,
                SUM(CASE WHEN source = 'ai' THEN 1 ELSE 0 END) as ai_count,
                SUM(CASE WHEN source = 'manual' OR source IS NULL THEN 1 ELSE 0 END) as manual_count
            FROM photo_tags
            GROUP BY tag
            ORDER BY count DESC, tag ASC
            """
        )
        rows = cursor.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            ai_c = d.get("ai_count", 0) or 0
            man_c = d.get("manual_count", 0) or 0
            if man_c > 0 and ai_c > 0:
                d["source"] = "both"
            elif ai_c > 0:
                d["source"] = "ai"
            else:
                d["source"] = "manual"
            results.append(d)
        return results


def delete_tag(tag: str) -> int:
    """指定されたタグを全写真から一括削除する（子孫タグも含めて完全除去）"""
    cleaned_tag = tag.strip()
    if not cleaned_tag:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM photo_tags WHERE tag = ? OR tag LIKE ?",
            (cleaned_tag, f"{cleaned_tag}/%"),
        )
        conn.commit()
        return cursor.rowcount


def rename_tag(old_tag: str, new_tag: str) -> int:
    """タグをリネームする（子孫タグのプレフィックスも一括変更）。
    例: rename_tag("A/1", "A/猫") → "A/1" → "A/猫", "A/1/い" → "A/猫/い"
    リネーム先タグが既に存在する場合は重複レコードを事前除去してUNIQUE制約違反を防止する。
    """
    old_tag = old_tag.strip()
    new_tag = new_tag.strip()
    if not old_tag or not new_tag or old_tag == new_tag:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        # UNIQUE制約 (photo_id, tag) 違反を防ぐため、リネーム先タグが既に付いている
        # レコードを事前に削除する（重複マージ）
        cursor.execute(
            """DELETE FROM photo_tags
               WHERE tag = ? AND photo_id IN (SELECT photo_id FROM photo_tags WHERE tag = ?)""",
            (old_tag, new_tag),
        )
        # 完全一致のリネーム
        cursor.execute(
            "UPDATE photo_tags SET tag = ? WHERE tag = ?",
            (new_tag, old_tag),
        )
        count = cursor.rowcount
        # 子孫タグのプレフィックス置換 (例: "A/1/い" → "A/猫/い")
        # 同様にリネーム先が既存の場合は重複を事前除去
        cursor.execute(
            """DELETE FROM photo_tags
               WHERE photo_id IN (SELECT photo_id FROM photo_tags WHERE tag LIKE ?)
                 AND tag IN (SELECT ? || SUBSTR(tag, ?) FROM photo_tags WHERE tag LIKE ?)""",
            (f"{old_tag}/%", new_tag, len(old_tag) + 1, f"{old_tag}/%"),
        )
        cursor.execute(
            "UPDATE photo_tags SET tag = ? || SUBSTR(tag, ?) WHERE tag LIKE ?",
            (new_tag, len(old_tag) + 1, f"{old_tag}/%"),
        )
        count += cursor.rowcount
        conn.commit()
        return count


def get_untagged_count() -> int:
    """タグが1つも付いていない写真の総数を返す"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*) as count
            FROM photos
            WHERE id NOT IN (SELECT DISTINCT photo_id FROM photo_tags)
            """
        )
        row = cursor.fetchone()
        return row["count"] if row else 0

