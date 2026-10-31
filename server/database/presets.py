"""
フィルタプリセット管理モジュール
絞り込み条件（フィルタ）に名前を付けて保存・取得・更新・削除する機能を提供する。
"""

import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from .connection import get_connection
from .tags import (
    _ensure_tag_keys_registered,
    get_key_to_tag_map,
    get_tag_key_map,
    is_color_tag,
)


def _enrich_filters_with_tag_keys(cursor, filters: Any) -> Dict[str, Any]:
    """
    保存・更新時に filters 内の tagFilters から固有キーマップ tagFilterKeys ({tag_key: mode}) を自動生成・付与する。
    """
    if isinstance(filters, str):
        try:
            filters_obj = json.loads(filters)
        except Exception:
            filters_obj = {}
    elif isinstance(filters, dict):
        filters_obj = dict(filters)
    else:
        filters_obj = {}

    tf = filters_obj.get("tagFilters")
    if isinstance(tf, dict) and tf:
        general_tags = [
            t.strip() for t in tf.keys()
            if t and isinstance(t, str) and t.strip() and not is_color_tag(t.strip())
        ]
        if general_tags:
            _ensure_tag_keys_registered(cursor, general_tags)
        tag_to_key = get_tag_key_map(cursor)
        tf_keys: Dict[str, str] = {}
        for t_name, mode in tf.items():
            t_clean = (t_name or "").strip()
            if not t_clean or is_color_tag(t_clean):
                continue
            t_key = tag_to_key.get(t_clean)
            if t_key:
                tf_keys[t_key] = mode
        filters_obj["tagFilterKeys"] = tf_keys
    elif "tagFilters" in filters_obj:
        filters_obj["tagFilterKeys"] = {}

    return filters_obj


def _resolve_filters_from_tag_keys(
    filters_obj: Dict[str, Any],
    key_to_tag: Dict[str, str],
    tag_to_key: Dict[str, str],
) -> Dict[str, Any]:
    """
    取得時に filters 内の tagFilterKeys を参照し、タグのリネームや階層移動が起きていた場合でも
    最新のタグパスへ解決した tagFilters を返す。
    """
    if not isinstance(filters_obj, dict):
        return {}
    tf_keys = filters_obj.get("tagFilterKeys")
    tf = filters_obj.get("tagFilters")
    if not isinstance(tf_keys, dict) or not tf_keys:
        return filters_obj

    new_tf: Dict[str, str] = {}
    # カラータグは tag_key 対象外のためそのまま保持
    if isinstance(tf, dict):
        for t_name, mode in tf.items():
            if is_color_tag(t_name):
                new_tf[t_name] = mode

    # tagFilterKeys から最新のタグ名を逆引き復元
    for t_key, mode in tf_keys.items():
        resolved_tag = key_to_tag.get(t_key)
        if resolved_tag:
            new_tf[resolved_tag] = mode

    # 万が一 tagFilterKeys に未登録だった一般タグが tagFilters にあり、かつ現在も有効なタグとして存在する場合は保持
    if isinstance(tf, dict):
        resolved_values = set(new_tf.keys())
        for t_name, mode in tf.items():
            if is_color_tag(t_name) or t_name in resolved_values:
                continue
            t_key = tag_to_key.get(t_name)
            if t_key and t_key not in tf_keys:
                new_tf[t_name] = mode

    filters_obj["tagFilters"] = new_tf
    return filters_obj


def get_filter_presets() -> List[Dict[str, Any]]:
    """保存済みフィルタプリセットの一覧を更新日時の新しい順に取得する"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id, name, description, filters, created_at, updated_at
        FROM filter_presets
        ORDER BY updated_at DESC, name ASC
        """
    )
    rows = cursor.fetchall()
    key_to_tag = get_key_to_tag_map(cursor)
    tag_to_key = {v: k for k, v in key_to_tag.items()}

    results = []
    for row in rows:
        filters_val = row["filters"]
        if isinstance(filters_val, str):
            try:
                filters_obj = json.loads(filters_val)
            except Exception:
                filters_obj = {}
        else:
            filters_obj = filters_val or {}

        filters_obj = _resolve_filters_from_tag_keys(filters_obj, key_to_tag, tag_to_key)

        results.append({
            "id": row["id"],
            "name": row["name"],
            "description": row["description"] or "",
            "filters": filters_obj,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        })
    return results


def get_filter_preset(preset_id: int) -> Optional[Dict[str, Any]]:
    """指定IDのフィルタプリセットを取得する"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id, name, description, filters, created_at, updated_at
        FROM filter_presets
        WHERE id = ?
        """,
        (preset_id,),
    )
    row = cursor.fetchone()
    if not row:
        return None

    filters_val = row["filters"]
    if isinstance(filters_val, str):
        try:
            filters_obj = json.loads(filters_val)
        except Exception:
            filters_obj = {}
    else:
        filters_obj = filters_val or {}

    key_to_tag = get_key_to_tag_map(cursor)
    tag_to_key = {v: k for k, v in key_to_tag.items()}
    filters_obj = _resolve_filters_from_tag_keys(filters_obj, key_to_tag, tag_to_key)

    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "filters": filters_obj,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def create_filter_preset(
    name: str, filters: Any, description: str = ""
) -> Dict[str, Any]:
    """
    新しいフィルタプリセットを作成する。
    名前が空、または同名プリセットが既に存在する場合は ValueError を送出する。
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("プリセット名を入力してください")

    conn = get_connection()
    cursor = conn.cursor()

    # 同名チェック
    cursor.execute("SELECT id FROM filter_presets WHERE name = ?", (name,))
    if cursor.fetchone():
        raise ValueError(f"プリセット名 '{name}' は既に使用されています")

    enriched_filters = _enrich_filters_with_tag_keys(cursor, filters)
    filters_json = json.dumps(enriched_filters, ensure_ascii=False)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        """
        INSERT INTO filter_presets (name, description, filters, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (name, description or "", filters_json, now_str, now_str),
    )
    conn.commit()
    preset_id = cursor.lastrowid
    return get_filter_preset(preset_id)


def update_filter_preset(
    preset_id: int, name: str, filters: Any, description: str = ""
) -> Optional[Dict[str, Any]]:
    """指定IDのフィルタプリセットを更新する"""
    name = (name or "").strip()
    if not name:
        raise ValueError("プリセット名を入力してください")

    conn = get_connection()
    cursor = conn.cursor()

    # 自分以外に同名プリセットがないかチェック
    cursor.execute(
        "SELECT id FROM filter_presets WHERE name = ? AND id != ?",
        (name, preset_id),
    )
    if cursor.fetchone():
        raise ValueError(f"プリセット名 '{name}' は既に使用されています")

    enriched_filters = _enrich_filters_with_tag_keys(cursor, filters)
    filters_json = json.dumps(enriched_filters, ensure_ascii=False)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        """
        UPDATE filter_presets
        SET name = ?, description = ?, filters = ?, updated_at = ?
        WHERE id = ?
        """,
        (name, description or "", filters_json, now_str, preset_id),
    )
    conn.commit()
    return get_filter_preset(preset_id)


def delete_filter_preset(preset_id: int) -> bool:
    """指定IDのフィルタプリセットを削除する"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM filter_presets WHERE id = ?", (preset_id,))
    conn.commit()
    return cursor.rowcount > 0
