"""
フィルタプリセット管理モジュール
絞り込み条件（フィルタ）に名前を付けて保存・取得・更新・削除する機能を提供する。
"""

import json
import sqlite3
from datetime import datetime
from typing import Any, Dict, List, Optional

from .connection import get_connection


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

    filters_json = json.dumps(filters, ensure_ascii=False) if not isinstance(filters, str) else filters

    conn = get_connection()
    cursor = conn.cursor()

    # 同名チェック
    cursor.execute("SELECT id FROM filter_presets WHERE name = ?", (name,))
    if cursor.fetchone():
        raise ValueError(f"プリセット名 '{name}' は既に使用されています")

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

    filters_json = json.dumps(filters, ensure_ascii=False) if not isinstance(filters, str) else filters

    conn = get_connection()
    cursor = conn.cursor()

    # 自分以外に同名プリセットがないかチェック
    cursor.execute(
        "SELECT id FROM filter_presets WHERE name = ? AND id != ?",
        (name, preset_id),
    )
    if cursor.fetchone():
        raise ValueError(f"プリセット名 '{name}' は既に使用されています")

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
