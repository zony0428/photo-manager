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
    if mtime is None:
        try:
            mtime = os.path.getmtime(file_path)
        except OSError:
            mtime = 0.0
    raw = f"{file_path}:{mtime}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _encrypt_thumb_if_needed(photo_id: int, raw_data: bytes) -> bytes:
    """Lv.1 / Lv.2 有効時、未暗号化のサムネイルBLOBをDEKで自動暗号化する"""
    if not raw_data:
        return raw_data
    from ..security import encrypt_thumbnail_blob, get_active_dek, get_current_security_level, is_encrypted_blob
    if is_encrypted_blob(raw_data):
        return raw_data
    if get_current_security_level() >= 1:
        dek = get_active_dek()
        if dek:
            return encrypt_thumbnail_blob(dek, raw_data, photo_id=photo_id)
    return raw_data


def _decrypt_thumb_if_needed(photo_id: int, stored_data: bytes) -> bytes:
    """暗号化済みのサムネイルBLOBをDEKで自動復号して平文WebPバイナリを返す"""
    if not stored_data:
        return stored_data
    from ..security import decrypt_thumbnail_blob, get_active_dek, is_encrypted_blob
    if not is_encrypted_blob(stored_data):
        return stored_data
    dek = get_active_dek()
    if not dek:
        raise PermissionError("サムネイルが暗号化されています。ロックを解除してください。")
    return decrypt_thumbnail_blob(dek, stored_data, photo_id=photo_id)


def save_thumbnail(
    photo_id: int,
    data: bytes,
    width: int,
    height: int,
    file_hash: Optional[str] = None,
) -> None:
    """サムネイルBLOBを1件保存する（photo_id PRIMARY KEY により1発で置換、Lv.1/2時は自動暗号化）"""
    if file_hash is None:
        file_hash = str(photo_id)
    stored_blob = _encrypt_thumb_if_needed(photo_id, data)
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT OR REPLACE INTO thumbnails (photo_id, file_hash, data, width, height)
            VALUES (?, ?, ?, ?, ?)
            """,
            (photo_id, file_hash, stored_blob, width, height),
        )
        conn.commit()


def save_thumbnails_batch(
    items: List[Tuple[int, bytes, int, int, str]],
) -> int:
    """
    サムネイルBLOBを一括保存する（photo_id PRIMARY KEY により1トランザクションで一括置換、Lv.1/2時は自動暗号化）。
    items: [(photo_id, data, width, height, file_hash), ...]
    """
    if not items:
        return 0
    prepared = [
        (pid, fh or str(pid), _encrypt_thumb_if_needed(pid, d), w, h)
        for pid, d, w, h, fh in items
    ]
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.executemany(
            """
            INSERT OR REPLACE INTO thumbnails (photo_id, file_hash, data, width, height)
            VALUES (?, ?, ?, ?, ?)
            """,
            prepared,
        )
        conn.commit()
        return len(items)


def get_thumbnail(photo_id: int) -> Optional[Dict[str, Any]]:
    """photo_idからサムネイルBLOBを1件取得する（photosテーブルとINNER JOINし実在写真のみ返却、暗号化時は自動復号）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT t.data, t.width, t.height
            FROM thumbnails t
            INNER JOIN photos p ON t.photo_id = p.id
            WHERE t.photo_id = ?
            LIMIT 1
            """,
            (photo_id,),
        )
        row = cursor.fetchone()
        if row:
            try:
                plain_data = _decrypt_thumb_if_needed(photo_id, bytes(row["data"]))
            except Exception:
                return None
            return {"data": plain_data, "width": row["width"], "height": row["height"]}
        return None


def get_thumbnails_batch(photo_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    """
    photo_idのリストを受け取り、IN句で一度にまとめてサムネイルBLOBを取得する。
    （photosテーブルとINNER JOINして実在する写真のみ返却、暗号化時は自動復号）
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
                pid = int(row["photo_id"])
                try:
                    plain_data = _decrypt_thumb_if_needed(pid, bytes(row["data"]))
                except Exception:
                    continue
                result[pid] = {
                    "data": plain_data,
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
    同一特徴量（撮影日時またはシフト前元撮影日時・ファイルサイズ）を持つ別の写真で、
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
            WHERE p.file_size = ?
              AND (p.date_taken = ? OR p.original_date_taken = ?)
        """
        params: List[Any] = [file_size, date_taken, date_taken]
        if exclude_photo_id:
            query += " AND p.id != ?"
            params.append(exclude_photo_id)

        query += " ORDER BY t.created_at DESC LIMIT 1"
        cursor.execute(query, params)
        row = cursor.fetchone()
        if row:
            src_pid = int(row["source_photo_id"])
            try:
                plain_data = _decrypt_thumb_if_needed(src_pid, bytes(row["data"]))
            except Exception:
                return None
            return {
                "data": plain_data,
                "width": row["width"],
                "height": row["height"],
                "source_photo_id": src_pid,
            }
        return None
