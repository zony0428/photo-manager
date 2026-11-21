"""
ウォーターマーク用ロゴ画像アセット (library.db: watermark_assets) 管理モジュール
透過PNG/WebP等のロゴ画像を SQLite BLOB として管理し、PC・モバイル間でポータブルに共有する。
"""

import io
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

from .connection import bump_db_commit_seq, get_connection

logger = logging.getLogger("photo_manager.database.watermarks")

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_WATERMARK_ID = "default_tetheract_logo"
DEFAULT_WATERMARK_NAME = "TETHERACT"
DEFAULT_WATERMARK_SEED_KEY = "default_watermark_seeded_v1"
DEFAULT_WATERMARK_ICON_PATH = PROJECT_ROOT / "frontend" / "icons" / "tetheract-watermark-default.png"

MAX_WATERMARK_COUNT = 24
MAX_WATERMARK_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_WATERMARK_LONG_EDGE = 2048


def _format_local_now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ensure_watermark_assets_table(cursor) -> None:
    """watermark_assets テーブルが存在しない場合に作成する"""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS watermark_assets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            data BLOB NOT NULL,
            origin TEXT NOT NULL DEFAULT 'pc',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def seed_default_watermark_if_needed(cursor) -> bool:
    """初回のみデフォルトの TETHERACT 透過ロゴを登録する（ユーザー削除後は再投入しない）"""
    ensure_watermark_assets_table(cursor)
    cursor.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'")
    has_meta = cursor.fetchone() is not None
    if has_meta:
        row = cursor.execute(
            "SELECT value FROM app_meta WHERE key = ?",
            (DEFAULT_WATERMARK_SEED_KEY,),
        ).fetchone()
        if row and str(row[0] or "") == "1":
            return False

    if not DEFAULT_WATERMARK_ICON_PATH.is_file():
        logger.debug(f"デフォルトウォーターマーク画像が見つかりません: {DEFAULT_WATERMARK_ICON_PATH}")
        return False

    try:
        raw_bytes = DEFAULT_WATERMARK_ICON_PATH.read_bytes()
        with Image.open(io.BytesIO(raw_bytes)) as img:
            w, h = img.size
        cursor.execute(
            """
            INSERT OR IGNORE INTO watermark_assets
                (id, name, mime_type, width, height, data, origin, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                DEFAULT_WATERMARK_ID,
                DEFAULT_WATERMARK_NAME,
                "image/png",
                int(w),
                int(h),
                raw_bytes,
                "default",
                _format_local_now(),
            ),
        )
        if has_meta:
            cursor.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)",
                (DEFAULT_WATERMARK_SEED_KEY, "1"),
            )
        return True
    except Exception as e:
        logger.warning(f"デフォルトウォーターマーク投入スキップ: {e}")
        return False


def normalize_watermark_image_bytes(raw_bytes: bytes) -> Tuple[bytes, int, int, str]:
    """アップロード画像を RGBA 透過維持 PNG（長辺最大2048px）へ正規化する"""
    if not raw_bytes:
        raise ValueError("画像データが空です")
    if len(raw_bytes) > MAX_WATERMARK_UPLOAD_BYTES:
        raise ValueError("15MB以下の画像を選択してください")

    try:
        with Image.open(io.BytesIO(raw_bytes)) as src:
            rgba = src.convert("RGBA")
    except Exception as e:
        raise ValueError(f"対応していない画像形式です: {e}") from e

    w, h = rgba.size
    if w <= 0 or h <= 0:
        raise ValueError("無効な画像サイズです")

    long_edge = max(w, h)
    if long_edge > MAX_WATERMARK_LONG_EDGE:
        scale = MAX_WATERMARK_LONG_EDGE / float(long_edge)
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        rgba = rgba.resize((new_w, new_h), Image.Resampling.LANCZOS)
        w, h = rgba.size

    buf = io.BytesIO()
    rgba.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), int(w), int(h), "image/png"


def list_watermark_assets() -> List[Dict[str, Any]]:
    """登録済みウォーターマークロゴ一覧（バイナリを除くメタ情報）を返す"""
    with get_connection() as conn:
        cur = conn.cursor()
        ensure_watermark_assets_table(cur)
        if seed_default_watermark_if_needed(cur):
            conn.commit()
        rows = cur.execute(
            """
            SELECT id, name, mime_type, width, height, LENGTH(data) AS byte_size, origin, created_at
            FROM watermark_assets
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
            """,
            (DEFAULT_WATERMARK_ID,),
        ).fetchall()
        result: List[Dict[str, Any]] = []
        for r in rows:
            aid = str(r["id"])
            result.append(
                {
                    "id": aid,
                    "name": str(r["name"] or "logo.png"),
                    "mime_type": str(r["mime_type"] or "image/png"),
                    "width": int(r["width"] or 0),
                    "height": int(r["height"] or 0),
                    "byte_size": int(r["byte_size"] or 0),
                    "origin": str(r["origin"] or "pc"),
                    "created_at": str(r["created_at"] or ""),
                    "image_url": f"/api/watermarks/{aid}/image",
                }
            )
        return result


def get_watermark_asset_blob(asset_id: str) -> Optional[Tuple[bytes, str, str, int, int]]:
    """指定IDのウォーターマーク画像バイナリとメタ情報を返す"""
    aid = str(asset_id or "").strip()
    if not aid:
        return None
    with get_connection() as conn:
        cur = conn.cursor()
        ensure_watermark_assets_table(cur)
        row = cur.execute(
            "SELECT data, mime_type, name, width, height FROM watermark_assets WHERE id = ?",
            (aid,),
        ).fetchone()
        if not row or not row["data"]:
            return None
        return (
            bytes(row["data"]),
            str(row["mime_type"] or "image/png"),
            str(row["name"] or "logo.png"),
            int(row["width"] or 0),
            int(row["height"] or 0),
        )


def save_watermark_asset(
    name: str,
    raw_bytes: bytes,
    origin: str = "pc",
    asset_id: Optional[str] = None,
) -> Dict[str, Any]:
    """ウォーターマーク画像を正規化して watermark_assets テーブルへ保存する"""
    png_bytes, width, height, mime_type = normalize_watermark_image_bytes(raw_bytes)
    clean_name = Path(str(name or "logo.png").strip()).name or "logo.png"
    clean_origin = "mobile" if str(origin).lower() == "mobile" else "pc"
    prefix = "mob" if clean_origin == "mobile" else "pc"
    aid = str(asset_id or "").strip() or f"{prefix}_{uuid.uuid4().hex[:16]}"
    now_str = _format_local_now()

    with get_connection() as conn:
        cur = conn.cursor()
        ensure_watermark_assets_table(cur)
        cur_count = cur.execute("SELECT COUNT(*) FROM watermark_assets").fetchone()[0]
        exists_same = cur.execute("SELECT 1 FROM watermark_assets WHERE id = ?", (aid,)).fetchone() is not None
        if not exists_same and int(cur_count or 0) >= MAX_WATERMARK_COUNT:
            raise ValueError(f"登録できるロゴ画像は最大{MAX_WATERMARK_COUNT}枚までです（不要なロゴを削除してください）")
        cur.execute(
            """
            INSERT OR REPLACE INTO watermark_assets
                (id, name, mime_type, width, height, data, origin, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (aid, clean_name, mime_type, width, height, png_bytes, clean_origin, now_str),
        )
        conn.commit()
    bump_db_commit_seq()
    return {
        "id": aid,
        "name": clean_name,
        "mime_type": mime_type,
        "width": width,
        "height": height,
        "byte_size": len(png_bytes),
        "origin": clean_origin,
        "created_at": now_str,
        "image_url": f"/api/watermarks/{aid}/image",
    }


def delete_watermark_asset(asset_id: str) -> bool:
    """指定IDのウォーターマーク画像を watermark_assets から削除する"""
    aid = str(asset_id or "").strip()
    if not aid:
        return False
    with get_connection() as conn:
        cur = conn.cursor()
        ensure_watermark_assets_table(cur)
        cur.execute("DELETE FROM watermark_assets WHERE id = ?", (aid,))
        deleted = cur.rowcount > 0
        # デフォルトロゴ削除時はシード済みフラグを確実に立て、再起動時の復活を防ぐ
        if aid == DEFAULT_WATERMARK_ID:
            cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_meta'")
            if cur.fetchone():
                cur.execute(
                    "INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)",
                    (DEFAULT_WATERMARK_SEED_KEY, "1"),
                )
        conn.commit()
    if deleted:
        bump_db_commit_seq()
    return deleted
