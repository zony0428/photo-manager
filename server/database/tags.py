"""
タグ管理モジュール
写真への階層タグ付け（祖先ノード自動展開）、固有タグキー（tag_key）・ショート名・ピン留め管理、
バッチ操作、リネーム、削除を提供する。
"""

import json
import logging
from typing import Any, Dict, Iterable, List, Optional
import uuid

from .connection import get_connection
from .photos import _directory_filter_sql

logger = logging.getLogger(__name__)

# 12色カラーラベル定義（photo_tags 内で通常タグと区別するための定数）
COLOR_TAG_NAMES = (
    "赤",
    "青",
    "緑",
    "黄色",
    "黒",
    "白",
    "銀・シルバー",
    "金・ゴールド",
    "茶色",
    "紫",
    "オレンジ",
    "ピンク",
)
COLOR_TAG_SET = set(COLOR_TAG_NAMES)


def is_color_tag(tag: str) -> bool:
    """指定されたタグ文字列が12色カラーラベルであるか判定する"""
    return bool(tag and tag.strip() in COLOR_TAG_SET)


def _generate_unique_tag_key(cursor, existing_keys: Optional[set] = None) -> str:
    """衝突しない固有の tag_key (例: 'tk_a1b2c3d4e5f6') を生成する"""
    for _ in range(20):
        candidate = f"tk_{uuid.uuid4().hex[:12]}"
        if existing_keys is not None:
            if candidate not in existing_keys:
                existing_keys.add(candidate)
                return candidate
        else:
            cursor.execute("SELECT 1 FROM tag_definitions WHERE tag_key = ?", (candidate,))
            if not cursor.fetchone():
                return candidate
    return f"tk_{uuid.uuid4().hex}"


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
    cleaned_tag = tag.strip().strip("/")
    if not cleaned_tag:
        return False
    all_tags = _expand_ancestor_tags(cleaned_tag)
    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_keys_registered(cursor, all_tags)
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
    cleaned_tag = tag.strip().strip("/")
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
    cleaned_tag = tag.strip().strip("/")
    if not cleaned_tag or not photo_ids:
        return 0
    all_tags = _expand_ancestor_tags(cleaned_tag)
    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_keys_registered(cursor, all_tags)
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
    cleaned_tag = tag.strip().strip("/")
    if not cleaned_tag:
        return False
    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_keys_registered(cursor, _expand_ancestor_tags(cleaned_tag))
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
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i : i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"UPDATE photos SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
                [rating] + chunk,
            )
            updated += cursor.rowcount
        conn.commit()
        return updated


def _ensure_tag_definitions_table(cursor) -> None:
    """tag_definitions テーブルおよび拡張カラム（tag_key, short_name, is_pinned, updated_at）が存在することを保証する"""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS tag_definitions (
            tag TEXT PRIMARY KEY,
            tag_key TEXT,
            short_name TEXT DEFAULT '',
            is_pinned INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute("PRAGMA table_info(tag_definitions)")
    existing_cols = {row["name"] for row in cursor.fetchall()}
    if "tag_key" not in existing_cols:
        cursor.execute("ALTER TABLE tag_definitions ADD COLUMN tag_key TEXT")
    if "short_name" not in existing_cols:
        cursor.execute("ALTER TABLE tag_definitions ADD COLUMN short_name TEXT DEFAULT ''")
    if "is_pinned" not in existing_cols:
        cursor.execute("ALTER TABLE tag_definitions ADD COLUMN is_pinned INTEGER DEFAULT 0")
    if "updated_at" not in existing_cols:
        cursor.execute("ALTER TABLE tag_definitions ADD COLUMN updated_at TIMESTAMP")
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_definitions_tag_key ON tag_definitions(tag_key)"
    )


def _ensure_tag_keys_registered(cursor, tags: Iterable[str]) -> Dict[str, str]:
    """指定されたタグ群（祖先パス含む・カラータグ除外）を tag_definitions に登録し、固有の tag_key を保証する"""
    _ensure_tag_definitions_table(cursor)
    clean_tags: List[str] = []
    seen = set()
    for raw_t in tags:
        if not raw_t:
            continue
        stripped = str(raw_t).strip().strip("/")
        if not stripped or is_color_tag(stripped):
            continue
        for t in _expand_ancestor_tags(stripped):
            if t and not is_color_tag(t) and t not in seen:
                seen.add(t)
                clean_tags.append(t)

    if not clean_tags:
        return {}

    cursor.execute("SELECT tag, tag_key FROM tag_definitions")
    all_rows = cursor.fetchall()
    existing_map: Dict[str, Optional[str]] = {}
    existing_keys: set = set()
    for r in all_rows:
        t_name = r["tag"]
        t_key = r["tag_key"]
        existing_map[t_name] = t_key
        if t_key:
            existing_keys.add(str(t_key))

    result_map: Dict[str, str] = {}
    to_insert = []
    to_update = []
    for t in clean_tags:
        if t not in existing_map:
            new_key = _generate_unique_tag_key(cursor, existing_keys)
            existing_map[t] = new_key
            result_map[t] = new_key
            to_insert.append((t, new_key))
        elif not existing_map[t]:
            new_key = _generate_unique_tag_key(cursor, existing_keys)
            existing_map[t] = new_key
            result_map[t] = new_key
            to_update.append((new_key, t))
        else:
            result_map[t] = str(existing_map[t])

    if to_insert:
        cursor.executemany(
            """
            INSERT OR IGNORE INTO tag_definitions (tag, tag_key, short_name, is_pinned, updated_at)
            VALUES (?, ?, '', 0, CURRENT_TIMESTAMP)
            """,
            to_insert,
        )
    if to_update:
        cursor.executemany(
            "UPDATE tag_definitions SET tag_key = ?, updated_at = CURRENT_TIMESTAMP WHERE tag = ?",
            to_update,
        )
    return result_map


def get_tag_key_map(cursor=None) -> Dict[str, str]:
    """現在登録されているすべての { tag: tag_key } マッピング辞書を返す"""
    if cursor is not None:
        _ensure_tag_definitions_table(cursor)
        cursor.execute("SELECT tag, tag_key FROM tag_definitions WHERE tag_key IS NOT NULL AND tag_key != ''")
        return {str(r["tag"]): str(r["tag_key"]) for r in cursor.fetchall()}
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tag_definitions_table(cur)
        cur.execute("SELECT tag, tag_key FROM tag_definitions WHERE tag_key IS NOT NULL AND tag_key != ''")
        return {str(r["tag"]): str(r["tag_key"]) for r in cur.fetchall()}


def get_key_to_tag_map(cursor=None) -> Dict[str, str]:
    """現在登録されているすべての { tag_key: tag } 逆引きマッピング辞書を返す"""
    if cursor is not None:
        _ensure_tag_definitions_table(cursor)
        cursor.execute("SELECT tag, tag_key FROM tag_definitions WHERE tag_key IS NOT NULL AND tag_key != ''")
        return {str(r["tag_key"]): str(r["tag"]) for r in cursor.fetchall()}
    with get_connection() as conn:
        cur = conn.cursor()
        _ensure_tag_definitions_table(cur)
        cur.execute("SELECT tag, tag_key FROM tag_definitions WHERE tag_key IS NOT NULL AND tag_key != ''")
        return {str(r["tag_key"]): str(r["tag"]) for r in cur.fetchall()}


def resolve_tag_by_key_or_name(
    cursor,
    tag_key: Optional[str] = None,
    fallback_tag: Optional[str] = None,
) -> str:
    """
    tag_key が指定されていれば tag_definitions から最新のタグパス文字列を解決して返す。
    タグがリネーム・階層移動されていても tag_key から現在のパスを追跡できる。
    見つからない場合は fallback_tag を返す。
    """
    _ensure_tag_definitions_table(cursor)
    if tag_key and str(tag_key).strip():
        clean_key = str(tag_key).strip()
        cursor.execute("SELECT tag FROM tag_definitions WHERE tag_key = ?", (clean_key,))
        row = cursor.fetchone()
        if row and row["tag"]:
            return str(row["tag"])
    return str(fallback_tag or "").strip().strip("/")


def update_tag_metadata(
    tag_or_key: Optional[str] = None,
    short_name: Optional[str] = None,
    is_pinned: Optional[bool] = None,
    *,
    tag: Optional[str] = None,
    tag_key: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    指定されたタグ（フルパス文字列または tag_key）のショート表示名（short_name）およびピン留め（is_pinned）を更新する。
    """
    raw_target = (tag_key or tag or tag_or_key or "").strip().strip("/")
    if not raw_target:
        raise ValueError("対象のタグまたは tag_key が指定されていません")
    target = raw_target

    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_definitions_table(cursor)

        # tag_key または tag 名で検索
        cursor.execute(
            "SELECT tag, tag_key, short_name, is_pinned FROM tag_definitions WHERE tag_key = ? OR tag = ? LIMIT 1",
            (target, target),
        )
        row = cursor.fetchone()
        if not row:
            # まだ tag_definitions に未登録の既存タグだった場合は登録する
            if not target.startswith("tk_") and not is_color_tag(target):
                _ensure_tag_keys_registered(cursor, [target])
                cursor.execute(
                    "SELECT tag, tag_key, short_name, is_pinned FROM tag_definitions WHERE tag = ? LIMIT 1",
                    (target,),
                )
                row = cursor.fetchone()
        if not row:
            return None

        actual_tag = str(row["tag"])
        new_short = str(row["short_name"] or "")
        if short_name is not None:
            # 制御文字やスラッシュを除去して最大40文字に整形
            cleaned_s = str(short_name).replace("\x00", "").replace("/", "・").strip()
            new_short = cleaned_s[:40]

        new_pinned = int(row["is_pinned"] or 0)
        if is_pinned is not None:
            new_pinned = 1 if is_pinned else 0

        cursor.execute(
            """
            UPDATE tag_definitions
            SET short_name = ?, is_pinned = ?, updated_at = CURRENT_TIMESTAMP
            WHERE tag = ?
            """,
            (new_short, new_pinned, actual_tag),
        )
        conn.commit()
        return {
            "tag": actual_tag,
            "tag_key": str(row["tag_key"] or ""),
            "short_name": new_short,
            "is_pinned": bool(new_pinned),
        }


def create_tag_definition(tag: str, short_name: str = "", is_pinned: bool = False) -> bool:
    """写真未付与のまま新規タグ（およびその祖先階層）をタグツリー定義に登録する（固有 tag_key 自動採番）"""
    cleaned_tag = tag.strip().strip("/")
    if not cleaned_tag:
        return False
    all_tags = _expand_ancestor_tags(cleaned_tag)
    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_keys_registered(cursor, all_tags)
        if short_name or is_pinned:
            clean_short = str(short_name or "").replace("\x00", "").replace("/", "・").strip()[:40]
            cursor.execute(
                """
                UPDATE tag_definitions
                SET short_name = CASE WHEN ? != '' THEN ? ELSE short_name END,
                    is_pinned = CASE WHEN ? = 1 THEN 1 ELSE is_pinned END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE tag = ?
                """,
                (clean_short, clean_short, 1 if is_pinned else 0, cleaned_tag),
            )
        conn.commit()
        return True


def get_all_tags_summary() -> List[Dict[str, Any]]:
    """すべてのタグと、それぞれが付けられている写真枚数・属性（手動/AI）・固有Key・ショート名・ピン留め状態を集計する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_definitions_table(cursor)
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

        # photo_tags に存在する手動タグのうち tag_definitions に未登録または tag_key 未設定のものを自動補完
        manual_tag_names = [
            str(r["tag"])
            for r in rows
            if r["tag"] and not is_color_tag(str(r["tag"])) and (r["manual_count"] or 0) > 0
        ]
        if manual_tag_names:
            _ensure_tag_keys_registered(cursor, manual_tag_names)
            conn.commit()

        # tag_definitions のメタデータ（tag_key, short_name, is_pinned）を取得
        cursor.execute(
            "SELECT tag, tag_key, COALESCE(short_name, '') AS short_name, COALESCE(is_pinned, 0) AS is_pinned FROM tag_definitions ORDER BY tag ASC"
        )
        def_rows = cursor.fetchall()
        def_map: Dict[str, Dict[str, Any]] = {}
        missing_key_defs: List[str] = []
        for dr in def_rows:
            t_name = str(dr["tag"])
            t_key = str(dr["tag_key"] or "")
            if not t_key and not is_color_tag(t_name):
                missing_key_defs.append(t_name)
            def_map[t_name] = {
                "tag_key": t_key,
                "short_name": str(dr["short_name"] or ""),
                "is_pinned": bool(dr["is_pinned"]),
            }

        if missing_key_defs:
            new_keys = _ensure_tag_keys_registered(cursor, missing_key_defs)
            conn.commit()
            for t_name, k_val in new_keys.items():
                if t_name in def_map:
                    def_map[t_name]["tag_key"] = k_val

        results = []
        existing_tags = set()
        for row in rows:
            d = dict(row)
            t_name = str(d["tag"])
            existing_tags.add(t_name)
            ai_c = d.get("ai_count", 0) or 0
            man_c = d.get("manual_count", 0) or 0
            if man_c > 0 and ai_c > 0:
                d["source"] = "both"
            elif ai_c > 0:
                d["source"] = "ai"
            else:
                d["source"] = "manual"

            meta = def_map.get(t_name, {})
            d["tag_key"] = meta.get("tag_key", "")
            d["short_name"] = meta.get("short_name", "")
            d["is_pinned"] = bool(meta.get("is_pinned", False))
            results.append(d)

        # tag_definitions に登録されている空タグ（0枚）もツリー表示用にマージ
        for t_name, meta in def_map.items():
            if t_name and t_name not in existing_tags and not is_color_tag(t_name):
                existing_tags.add(t_name)
                results.append(
                    {
                        "tag": t_name,
                        "count": 0,
                        "ai_count": 0,
                        "manual_count": 0,
                        "source": "manual",
                        "tag_key": meta.get("tag_key", ""),
                        "short_name": meta.get("short_name", ""),
                        "is_pinned": bool(meta.get("is_pinned", False)),
                    }
                )
        return results


def delete_tag(tag: str) -> int:
    """指定されたタグを全写真およびタグ定義から一括削除する（子孫タグも含めて完全除去）"""
    cleaned_tag = tag.strip().strip("/")
    if not cleaned_tag:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_definitions_table(cursor)
        cursor.execute(
            "DELETE FROM photo_tags WHERE tag = ? OR tag LIKE ?",
            (cleaned_tag, f"{cleaned_tag}/%"),
        )
        deleted = cursor.rowcount
        cursor.execute(
            "DELETE FROM tag_definitions WHERE tag = ? OR tag LIKE ?",
            (cleaned_tag, f"{cleaned_tag}/%"),
        )
        conn.commit()
        return deleted


def _sync_filter_presets_on_tag_rename(cursor, old_tag: str, new_tag: str) -> None:
    """
    タグがリネーム・階層移動された際、filter_presets テーブル内の保存済みプリセットの
    tagFilters / tagAndRoots に含まれる旧タグパスを新タグパスへ自動追従更新する。
    """
    try:
        cursor.execute("SELECT id, filters FROM filter_presets")
        preset_rows = cursor.fetchall()
    except Exception as e:
        logger.debug(f"プリセット自動追従スキップ (filter_presets 未作成等): {e}")
        return

    if not preset_rows:
        return

    key_map = get_tag_key_map(cursor)
    prefix = f"{old_tag}/"
    old_root = old_tag.split("/", 1)[0]
    new_root = new_tag.split("/", 1)[0]

    for row in preset_rows:
        pid = row["id"]
        raw_filters = row["filters"]
        if not raw_filters:
            continue
        try:
            f_obj = json.loads(raw_filters) if isinstance(raw_filters, str) else dict(raw_filters)
        except Exception as e:
            logger.debug(f"プリセットJSON解析スキップ (id={pid}): {e}")
            continue
        if not isinstance(f_obj, dict):
            continue

        changed = False
        tag_filters = f_obj.get("tagFilters")
        if isinstance(tag_filters, dict) and tag_filters:
            new_tf: Dict[str, Any] = {}
            for k, mode in tag_filters.items():
                k_str = str(k)
                if k_str == old_tag:
                    new_tf[new_tag] = mode
                    changed = True
                elif k_str.startswith(prefix):
                    replaced = f"{new_tag}{k_str[len(old_tag):]}"
                    new_tf[replaced] = mode
                    changed = True
                else:
                    new_tf[k_str] = mode
            if changed:
                f_obj["tagFilters"] = new_tf
                # tagFilterKeys も最新の tag_key マップで同期
                tf_keys: Dict[str, Any] = {}
                for t_path, mode in new_tf.items():
                    tk = key_map.get(t_path)
                    if tk:
                        tf_keys[tk] = mode
                f_obj["tagFilterKeys"] = tf_keys

        tag_and_roots = f_obj.get("tagAndRoots")
        if isinstance(tag_and_roots, list) and old_root in tag_and_roots and old_root != new_root:
            # ルート自体が変更された場合、新ルートを追加
            new_roots = [new_root if r == old_root else r for r in tag_and_roots]
            f_obj["tagAndRoots"] = list(dict.fromkeys(new_roots))
            changed = True

        if changed:
            cursor.execute(
                "UPDATE filter_presets SET filters = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (json.dumps(f_obj, ensure_ascii=False), pid),
            )


def rename_tag(old_tag: str, new_tag: str) -> int:
    """タグをリネームまたは別階層へ移動する（子孫タグのプレフィックスも一括変更・固有 tag_key 維持・プリセット追従）。
    例:
      - rename_tag("A/1", "A/猫") → "A/1" → "A/猫", "A/1/い" → "A/猫/い"
      - rename_tag("A/B", "D/B") → "A/B" → "D/B", 新親 "D" を自動補完、
        他で "A/*" を持たない写真からは旧親 "A" を自動除去（「A/C」を併せ持つ写真の「A」は維持）
    """
    old_tag = old_tag.strip().strip("/")
    new_tag = new_tag.strip().strip("/")
    if not old_tag or not new_tag or old_tag == new_tag:
        return 0
    if new_tag.startswith(old_tag + "/"):
        raise ValueError("自分自身の配下階層へは移動できません")

    with get_connection() as conn:
        cursor = conn.cursor()
        _ensure_tag_definitions_table(cursor)

        # リネーム前に photo_tags 上の旧タグ群も確実に tag_definitions (tag_key 付き) に登録しておく
        cursor.execute(
            "SELECT DISTINCT tag FROM photo_tags WHERE tag = ? OR tag LIKE ?",
            (old_tag, f"{old_tag}/%"),
        )
        old_pt_tags = [str(r["tag"]) for r in cursor.fetchall() if r["tag"]]
        _ensure_tag_keys_registered(cursor, [old_tag] + old_pt_tags)

        # 対象タグ（またはその子孫タグ）を持つすべての photo_id を事前取得
        cursor.execute(
            "SELECT DISTINCT photo_id FROM photo_tags WHERE tag = ? OR tag LIKE ?",
            (old_tag, f"{old_tag}/%"),
        )
        affected_photo_ids = [r["photo_id"] for r in cursor.fetchall()]

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

        # 1. 新しい親（祖先）タグの自動補完（例: "B" → "D/E/B" なら "D", "D/E" を対象写真に追加）
        new_ancestors = _expand_ancestor_tags(new_tag)[:-1]
        if new_ancestors and affected_photo_ids:
            cursor.executemany(
                """
                INSERT INTO photo_tags (photo_id, tag, source, confidence)
                VALUES (?, ?, 'manual', 1.0)
                ON CONFLICT(photo_id, tag) DO NOTHING
                """,
                [(pid, anc) for pid in affected_photo_ids for anc in new_ancestors],
            )

        # 2. 旧親（祖先）タグの整理（例: "A/B" → "D/B" のとき、同じ写真に "A/C" 等が無ければ "A" を外す）
        old_ancestors = _expand_ancestor_tags(old_tag)[:-1]
        new_chain_set = set(_expand_ancestor_tags(new_tag))
        removed_ancestors = [a for a in reversed(old_ancestors) if a not in new_chain_set]
        if removed_ancestors and affected_photo_ids:
            chunk_size = 500
            for anc in removed_ancestors:
                for i in range(0, len(affected_photo_ids), chunk_size):
                    chunk = affected_photo_ids[i : i + chunk_size]
                    placeholders = ",".join(["?"] * len(chunk))
                    cursor.execute(
                        f"""
                        DELETE FROM photo_tags
                        WHERE tag = ?
                          AND photo_id IN ({placeholders})
                          AND NOT EXISTS (
                              SELECT 1 FROM photo_tags pt2
                              WHERE pt2.photo_id = photo_tags.photo_id
                                AND pt2.tag LIKE ?
                          )
                        """,
                        [anc] + chunk + [f"{anc}/%"],
                    )

        # 3. tag_definitions テーブル側の更新（固有 tag_key・short_name・is_pinned を確実に引き継ぐ）
        cursor.execute(
            """
            SELECT tag, tag_key, COALESCE(short_name, '') AS short_name, COALESCE(is_pinned, 0) AS is_pinned
            FROM tag_definitions
            WHERE tag = ? OR tag LIKE ?
            ORDER BY LENGTH(tag) ASC
            """,
            (old_tag, f"{old_tag}/%"),
        )
        old_def_rows = cursor.fetchall()
        for dr in old_def_rows:
            src_t = str(dr["tag"])
            dst_t = new_tag if src_t == old_tag else f"{new_tag}{src_t[len(old_tag):]}"
            cursor.execute(
                "SELECT tag, COALESCE(short_name, '') AS short_name, COALESCE(is_pinned, 0) AS is_pinned FROM tag_definitions WHERE tag = ?",
                (dst_t,),
            )
            existing_dst = cursor.fetchone()
            if existing_dst:
                # 移動先に同名タグが既に存在する場合はメタデータをマージして旧行を削除
                merged_short = str(existing_dst["short_name"] or dr["short_name"] or "")
                merged_pin = max(int(existing_dst["is_pinned"] or 0), int(dr["is_pinned"] or 0))
                cursor.execute(
                    "UPDATE tag_definitions SET short_name = ?, is_pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE tag = ?",
                    (merged_short, merged_pin, dst_t),
                )
                cursor.execute("DELETE FROM tag_definitions WHERE tag = ?", (src_t,))
            else:
                # 移動先が存在しない場合は tag カラムを更新し、tag_key / short_name / is_pinned をそのまま維持
                cursor.execute(
                    "UPDATE tag_definitions SET tag = ?, updated_at = CURRENT_TIMESTAMP WHERE tag = ?",
                    (dst_t, src_t),
                )

        # 新しい親（祖先）タグも tag_definitions に tag_key 付きで登録保証
        _ensure_tag_keys_registered(cursor, _expand_ancestor_tags(new_tag))

        # 4. 保存済みフィルタプリセット内の旧タグ名を新タグ名へ自動追従
        _sync_filter_presets_on_tag_rename(cursor, old_tag, new_tag)

        conn.commit()
        return count


def get_untagged_count() -> int:
    """手動の通常タグ（AI自動タグおよび12色カラーラベルを除く）が1つも付いていない有効写真の総数を返す"""
    color_placeholders = ",".join(["?"] * len(COLOR_TAG_NAMES))
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT COUNT(*) as count
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL)
              AND id NOT IN (
                  SELECT DISTINCT photo_id
                  FROM photo_tags
                  WHERE COALESCE(source, 'manual') != 'ai'
                    AND tag NOT IN ({color_placeholders})
              )
            """,
            list(COLOR_TAG_NAMES),
        )
        row = cursor.fetchone()
        return row["count"] if row else 0

