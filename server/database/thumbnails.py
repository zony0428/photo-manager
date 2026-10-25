"""
サムネイル BLOB 管理モジュール
SQLite内にWebPサムネイルバイナリを格納・取得する。
"""

import os
import hashlib
from typing import Any, Dict, List, Optional, Tuple

from .connection import get_connection
def compute_thumbnail_hash(file_path: str, mtime: Optional[float] = None) -> str:
    """元画像の絶対パスと更新日時からサムネイルのハッシュキーを生成する"""
    import hashlib
    if mtime is None:
        try:
            mtime = os.path.getmtime(file_path)
        except OSError:
            mtime = 0.0
    raw = f"{file_path}:{mtime}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def save_thumbnail(
    photo_id: int,
    data: bytes,
    width: int,
    height: int,
    file_hash: Optional[str] = None,
) -> None:
    """サムネイルBLOBを1件保存する（同一photo_idの古いサムネイルを確実に置換）"""
    if file_hash is None:
        file_hash = str(photo_id)
    with get_connection() as conn:
        cursor = conn.cursor()
        # 同一 photo_id の既存レコードがあれば事前に削除して重複や不整合を防止
        cursor.execute("DELETE FROM thumbnails WHERE photo_id = ?", (photo_id,))
        cursor.execute(
            """
            INSERT OR REPLACE INTO thumbnails (file_hash, photo_id, data, width, height)
            VALUES (?, ?, ?, ?, ?)
            """,
            (file_hash, photo_id, data, width, height),
        )
        conn.commit()


def save_thumbnails_batch(
    items: List[Tuple[int, bytes, int, int, str]],
) -> int:
    """
    サムネイルBLOBを一括保存する（1トランザクション内でまとめてコミット）。
    items: [(photo_id, data, width, height, file_hash), ...]
    """
    if not items:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        photo_ids = [pid for pid, _, _, _, _ in items]
        for i in range(0, len(photo_ids), 500):
            chunk = photo_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
        cursor.executemany(
            """
            INSERT OR REPLACE INTO thumbnails (file_hash, photo_id, data, width, height)
            VALUES (?, ?, ?, ?, ?)
            """,
            [(fh, pid, d, w, h) for pid, d, w, h, fh in items],
        )
        conn.commit()
        return len(items)


def get_thumbnail(photo_id: int) -> Optional[Dict[str, Any]]:
    """photo_idからサムネイルBLOBを1件取得する（photosテーブルとINNER JOINし実在写真のみ返却）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT t.data, t.width, t.height
            FROM thumbnails t
            INNER JOIN photos p ON t.photo_id = p.id
            WHERE t.photo_id = ?
            ORDER BY t.created_at DESC
            LIMIT 1
            """,
            (photo_id,),
        )
        row = cursor.fetchone()
        if row:
            return {"data": row["data"], "width": row["width"], "height": row["height"]}
        return None


def get_thumbnails_batch(photo_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    """
    photo_idのリストを受け取り、IN句で一度にまとめてサムネイルBLOBを取得する。
    （photosテーブルとINNER JOINして実在する写真のみ返却）
    戻り値: {photo_id: {"data": bytes, "width": int, "height": int}, ...}
    """
    if not photo_ids:
        return {}
    with get_connection() as conn:
        cursor = conn.cursor()
        result = {}
        for i in range(0, len(photo_ids), 500):
            chunk = photo_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"""
                SELECT t.photo_id, t.data, t.width, t.height
                FROM thumbnails t
                INNER JOIN photos p ON t.photo_id = p.id
                WHERE t.photo_id IN ({placeholders})
                """,
                chunk,
            )
            for row in cursor.fetchall():
                result[row["photo_id"]] = {
                    "data": row["data"],
                    "width": row["width"],
                    "height": row["height"],
                }
        return result


def delete_thumbnail(photo_id: int) -> bool:
    """指定されたphoto_idのサムネイルをDBから削除する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM thumbnails WHERE photo_id = ?", (photo_id,))
        conn.commit()
        return cursor.rowcount > 0


def thumbnail_exists(photo_id: int) -> bool:
    """指定されたphoto_idのサムネイルがDB内に存在するかを高速チェックする"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT 1 FROM thumbnails WHERE photo_id = ? LIMIT 1",
            (photo_id,),
        )
        return cursor.fetchone() is not None


def find_existing_thumbnail_for_duplicate(
    file_size: int,
    date_taken: Optional[str] = None,
    exclude_photo_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    同一特徴量（撮影日時・ファイルサイズ）を持つ別の写真で、
    既に生成済みのサムネイルBLOBが存在すれば取得する。
    画像デコードおよびWebP再圧縮を完全にスキップして高速再利用するために使用する。
    """
    if not date_taken or file_size <= 0:
        return None

    with get_connection() as conn:
        cursor = conn.cursor()
        query = """
            SELECT t.data, t.width, t.height, p.id as source_photo_id
            FROM thumbnails t
            INNER JOIN photos p ON t.photo_id = p.id
            WHERE p.date_taken = ? AND p.file_size = ?
        """
        params: List[Any] = [date_taken, file_size]
        if exclude_photo_id:
            query += " AND p.id != ?"
            params.append(exclude_photo_id)

        query += " ORDER BY t.created_at DESC LIMIT 1"
        cursor.execute(query, params)
        row = cursor.fetchone()
        if row:
            return {
                "data": row["data"],
                "width": row["width"],
                "height": row["height"],
                "source_photo_id": row["source_photo_id"],
            }
        return None


def clone_thumbnail(source_photo_id: int, target_photo_id: int, file_hash: Optional[str] = None) -> bool:
    """既存写真のサムネイルBLOBを別の写真レコードへ高速複製する"""
    if source_photo_id == target_photo_id:
        return False
    thumb = get_thumbnail(source_photo_id)
    if not thumb:
        return False
    save_thumbnail(target_photo_id, thumb["data"], thumb["width"], thumb["height"], file_hash)
    return True


