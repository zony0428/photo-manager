"""
モバイル選別差分（評価・タグ・トーン調整・クロップ・お気に入り・スタック代表）の library.db 適用モジュール
"""

import logging
import re
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .database.folders import clear_folders_fs_cache
from .database.photos import _sync_stack_primary_by_rating
from .database.tags import (
    _cleanup_orphan_ancestor_tags,
    _ensure_tag_keys_registered,
    _expand_ancestor_tags,
    _expand_stack_and_pair_photo_ids,
    _normalize_tag_path,
    resolve_tag_by_key_or_name,
)
from .media_watcher import broadcast_app_event
from .mobile_signals import (
    find_smart_stem_date_matches,
    upsert_pending_signal,
)

logger = logging.getLogger("photo_manager.app")


def _sanitize_mobile_tag(raw_tag: Any) -> str:
    """モバイル同期データに含まれるタグ文字列を検証・無害化する（制御文字・HTMLタグ混入防止）"""
    if not raw_tag:
        return ""
    s = str(raw_tag).strip()
    s = re.sub(r"[\x00-\x1f\x7f<>\"'`]", "", s).strip()
    return s[:100]


def _schedule_thumbnail_refresh(photo_ids: List[int]) -> None:
    """モバイル同期で調整変更された写真のサムネイルを再生成する（先頭20件は即時完了させ差分DBへ即座に含める）"""
    if not photo_ids:
        return

    from .routers.common import clear_api_photos_cache
    from .scanner import refresh_photo_thumbnail_transform

    sync_batch = photo_ids[:20]
    async_tail = photo_ids[20:]
    for pid in sync_batch:
        try:
            refresh_photo_thumbnail_transform(pid)
        except Exception as e:
            logger.warning(f"モバイル同期後のサムネイル同期再生成失敗 ({pid}): {e}")
    clear_api_photos_cache()

    if not async_tail:
        return

    def _worker() -> None:
        for pid in async_tail:
            try:
                refresh_photo_thumbnail_transform(pid)
            except Exception as e:
                logger.warning(f"モバイル同期後のサムネイル再生成失敗 ({pid}): {e}")
        clear_api_photos_cache()
        try:
            from .mobile_delta import ensure_mobile_delta_db
            ensure_mobile_delta_db(force=True)
        except Exception as delta_err:
            logger.debug(f"バックグラウンド再生成後の差分DB更新スキップ: {delta_err}")

    threading.Thread(target=_worker, name="mobile-sync-thumb-refresh", daemon=True).start()


def _update_rating_in_tx(cursor: Any, photo_id: int, rating: int) -> None:
    """トランザクション内で評価を更新し、RAW+JPEGペア相手を同期した上でスタック代表写真を再選出する（commitしない）"""
    cursor.execute("SELECT stack_id, file_path, paired_raw_path FROM photos WHERE id = ?", (photo_id,))
    row = cursor.fetchone()
    stack_id = row["stack_id"] if row else None
    target_ids = [int(photo_id)]
    if row:
        fp = row["file_path"]
        prp = row["paired_raw_path"]
        if prp:
            cursor.execute("SELECT id FROM photos WHERE file_path = ? AND id != ?", (prp, photo_id))
            target_ids.extend(int(r["id"]) for r in cursor.fetchall())
        if fp:
            cursor.execute("SELECT id FROM photos WHERE paired_raw_path = ? AND id != ?", (fp, photo_id))
            target_ids.extend(int(r["id"]) for r in cursor.fetchall())
    uniq_ids = list(dict.fromkeys(target_ids))
    ph = ",".join("?" for _ in uniq_ids)
    cursor.execute(
        f"UPDATE photos SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN ({ph})",
        [rating] + uniq_ids,
    )
    if stack_id is not None:
        _sync_stack_primary_by_rating(cursor, [stack_id])


def _add_tag_in_tx(
    conn: Any,
    cursor: Any,
    photo_id: int,
    tag: str,
    registered_tags_cache: set,
) -> None:
    """トランザクション内でタグ（祖先・スタック・ペア連動含む）を追加する（commitしない）"""
    cleaned_tag = _normalize_tag_path(tag)
    if not cleaned_tag:
        return
    all_tags = _expand_ancestor_tags(cleaned_tag)
    if any(t not in registered_tags_cache for t in all_tags):
        _ensure_tag_keys_registered(cursor, all_tags)
        registered_tags_cache.update(all_tags)
    target_ids = _expand_stack_and_pair_photo_ids(conn, [photo_id])
    if not target_ids:
        return
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


def _remove_tag_in_tx(conn: Any, cursor: Any, photo_id: int, tag: str) -> None:
    """トランザクション内でタグとその子孫・孤立祖先タグを削除する（commitしない）"""
    cleaned_tag = tag.strip().strip("/")
    if not cleaned_tag:
        return
    target_ids = _expand_stack_and_pair_photo_ids(conn, [photo_id])
    if not target_ids:
        return
    chunk_size = 500
    for i in range(0, len(target_ids), chunk_size):
        chunk = target_ids[i : i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))
        cursor.execute(
            f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders}) AND (tag = ? OR tag LIKE ?)",
            chunk + [cleaned_tag, f"{cleaned_tag}/%"],
        )
    _cleanup_orphan_ancestor_tags(cursor, cleaned_tag, target_ids)


def apply_mobile_sync_changes(
    raw_changes: List[Dict[str, Any]],
    used_file: Optional[Path] = None,
    schedule_thumb_refresh: Optional[Callable[[List[int]], None]] = None,
) -> Dict[str, Any]:
    """モバイル選別差分リストをPC本体の library.db に単一トランザクションで適用する"""
    from .database.connection import get_connection

    if not raw_changes:
        return {
            "status": "ok",
            "applied_count": 0,
            "skipped_count": 0,
            "source_file": used_file.name if used_file else None,
            "applied_items": [],
            "skipped_items": [],
        }

    applied_count = 0
    skipped_count = 0
    applied_items: List[Dict[str, Any]] = []
    skipped_items: List[Dict[str, Any]] = []
    thumb_refresh_ids: List[int] = []
    registered_tags_cache: set = set()

    with get_connection() as conn:
        cursor = conn.cursor()
        if not conn.in_transaction:
            cursor.execute("BEGIN")
        for item in raw_changes:
            if not isinstance(item, dict):
                continue
            target_id: Optional[int] = None
            matched_file_name: str = ""
            pid = item.get("photo_id")
            ckey = item.get("content_key")
            fpath = item.get("file_path")
            fname = item.get("file_name")
            dtaken = item.get("date_taken")
            try:
                fsize = int(item.get("file_size") or 0)
            except (TypeError, ValueError):
                fsize = 0

            # 0. content_key で照合（再スキャン・パス変更・リネーム時でも同一写真を一意特定）
            if ckey and str(ckey).strip():
                clean_ck = str(ckey).strip()
                cursor.execute(
                    "SELECT id, file_name FROM photos WHERE content_key = ? AND IFNULL(is_unlinked, 0) = 0 LIMIT 1",
                    (clean_ck,),
                )
                row = cursor.fetchone()
                if not row and (clean_ck.startswith("dt:") or clean_ck.startswith("hash:")):
                    cursor.execute(
                        "SELECT id, file_name FROM photos WHERE content_key LIKE ? AND IFNULL(is_unlinked, 0) = 0 LIMIT 2",
                        (f"{clean_ck}%",),
                    )
                    rows_ck = cursor.fetchall()
                    if len(rows_ck) == 1:
                        row = rows_ck[0]
                if row:
                    target_id = int(row["id"])
                    matched_file_name = str(row["file_name"] or "")

            # 1. photo_id (+ file_name または file_size) で照合
            if target_id is None and pid:
                if fname:
                    cursor.execute(
                        "SELECT id, file_name FROM photos WHERE id = ? AND file_name = ?",
                        (int(pid), str(fname)),
                    )
                else:
                    cursor.execute("SELECT id, file_name FROM photos WHERE id = ?", (int(pid),))
                row = cursor.fetchone()
                if not row and fsize > 0:
                    cursor.execute(
                        "SELECT id, file_name FROM photos WHERE id = ? AND file_size = ?",
                        (int(pid), fsize),
                    )
                    row = cursor.fetchone()
                if row:
                    target_id = int(row["id"])
                    matched_file_name = str(row["file_name"] or "")

            # 2. date_taken + file_size で照合（PC側でリネームされていても撮影日時＋バイト数が一致すれば同一画像）
            if target_id is None and dtaken and fsize > 0:
                s_dt = str(dtaken).strip()
                norm_dt = (s_dt[:10].replace(":", "-").replace("/", "-") + s_dt[10:])[:19]
                colon_dt = (s_dt[:10].replace("-", ":").replace("/", ":") + s_dt[10:])[:19]
                cursor.execute(
                    """
                    SELECT id, file_name FROM photos
                    WHERE IFNULL(is_unlinked, 0) = 0
                      AND file_size = ?
                      AND (date_taken IN (?, ?) OR original_date_taken IN (?, ?))
                    LIMIT 2
                    """,
                    (fsize, norm_dt, colon_dt, norm_dt, colon_dt),
                )
                rows_dt = cursor.fetchall()
                if len(rows_dt) == 1:
                    target_id = int(rows_dt[0]["id"])
                    matched_file_name = str(rows_dt[0]["file_name"] or "")

            # 3. file_path で照合
            if target_id is None and fpath:
                cursor.execute("SELECT id, file_name FROM photos WHERE file_path = ?", (str(fpath),))
                row = cursor.fetchone()
                if row:
                    target_id = int(row["id"])
                    matched_file_name = str(row["file_name"] or "")

            # 4. file_name + date_taken で照合（ドライブレター変動・再スキャン対策）
            if target_id is None and fname and dtaken:
                cursor.execute(
                    "SELECT id, file_name FROM photos WHERE file_name = ? AND date_taken = ? LIMIT 1",
                    (str(fname), str(dtaken)),
                )
                row = cursor.fetchone()
                if row:
                    target_id = int(row["id"])
                    matched_file_name = str(row["file_name"] or "")

            # 5. file_name (+ file_size) で照合（Exifなし画像のフォールバック）
            if target_id is None and fname:
                if fsize > 0:
                    cursor.execute(
                        "SELECT id, file_name FROM photos WHERE file_name = ? AND file_size = ? LIMIT 2",
                        (str(fname), fsize),
                    )
                else:
                    cursor.execute(
                        "SELECT id, file_name FROM photos WHERE file_name = ? LIMIT 2",
                        (str(fname),),
                    )
                rows = cursor.fetchall()
                if len(rows) == 1:
                    target_id = int(rows[0]["id"])
                    matched_file_name = str(rows[0]["file_name"] or "")

            def _resolve_mobile_tags_list(raw_tags_val: Any, raw_keys_val: Any) -> List[str]:
                resolved_list: List[str] = []
                seen = set()

                def _push(t_str: str) -> None:
                    c = _sanitize_mobile_tag(t_str)
                    if c and c not in seen:
                        seen.add(c)
                        resolved_list.append(c)

                raw_tags_seq = list(raw_tags_val)[:50] if isinstance(raw_tags_val, list) else []
                if isinstance(raw_keys_val, dict):
                    covered_fallbacks = set()
                    for k_str, fb_name in list(raw_keys_val.items())[:50]:
                        clean_k = _sanitize_mobile_tag(k_str)
                        clean_fb = _sanitize_mobile_tag(fb_name)
                        if clean_fb:
                            covered_fallbacks.add(clean_fb)
                        resolved_name = resolve_tag_by_key_or_name(cursor, clean_k, clean_fb)
                        if resolved_name:
                            _push(resolved_name)
                    for rt in raw_tags_seq:
                        clean_rt = _sanitize_mobile_tag(rt)
                        if clean_rt and clean_rt not in covered_fallbacks:
                            resolved_name = resolve_tag_by_key_or_name(
                                cursor,
                                clean_rt if clean_rt.startswith("tk_") else None,
                                clean_rt,
                            )
                            _push(resolved_name)
                elif isinstance(raw_keys_val, list) and raw_keys_val:
                    keys_seq = list(raw_keys_val)[:50]
                    max_len = max(len(raw_tags_seq), len(keys_seq))
                    for idx in range(max_len):
                        k_item = keys_seq[idx] if idx < len(keys_seq) else None
                        t_item = raw_tags_seq[idx] if idx < len(raw_tags_seq) else None
                        if isinstance(k_item, dict):
                            clean_k = _sanitize_mobile_tag(k_item.get("tag_key") or k_item.get("key"))
                            clean_fb = _sanitize_mobile_tag(k_item.get("tag") or t_item)
                        else:
                            clean_k = _sanitize_mobile_tag(k_item)
                            clean_fb = _sanitize_mobile_tag(t_item)
                        resolved_name = resolve_tag_by_key_or_name(cursor, clean_k, clean_fb)
                        if resolved_name:
                            _push(resolved_name)
                else:
                    for rt in raw_tags_seq:
                        clean_rt = _sanitize_mobile_tag(rt)
                        if clean_rt:
                            resolved_name = resolve_tag_by_key_or_name(
                                cursor,
                                clean_rt if clean_rt.startswith("tk_") else None,
                                clean_rt,
                            )
                            _push(resolved_name)
                return resolved_list

            removed_tags: List[str] = _resolve_mobile_tags_list(
                item.get("remove_tags"),
                item.get("remove_tag_keys"),
            )
            added_tags: List[str] = _resolve_mobile_tags_list(
                item.get("add_tags"),
                item.get("add_tag_keys"),
            )

            # 6. スマート一致（2M縮小画像 ⇔ 母艦フルサイズJPEG / RAW 原本のサイズ・拡張子不問照合）
            if target_id is None and fname and dtaken:
                smart_hits = find_smart_stem_date_matches(
                    cursor,
                    [
                        {
                            "key": "item",
                            "file_name": str(fname),
                            "date_taken": dtaken,
                            "camera_model": item.get("camera_model") or "",
                        }
                    ],
                    max_diff_sec=2,
                )
                matched_list = smart_hits.get("item") or []
                if matched_list:
                    target_id = int(matched_list[0])
                    cursor.execute("SELECT file_name FROM photos WHERE id = ?", (target_id,))
                    r_fn = cursor.fetchone()
                    matched_file_name = str(r_fn["file_name"] or "") if r_fn else str(fname)

            # 7. 未取り込み先行操作時は mobile_pending_signals へ安全に待機保存（SDカードスキャン時に自動合流）
            if target_id is None:
                rating_val_p = item.get("rating")
                r_int_p = max(-1, min(2, int(rating_val_p))) if rating_val_p is not None else None
                queued_ok = False
                if fname and dtaken:
                    queued_ok = upsert_pending_signal(
                        cursor,
                        file_name=str(fname),
                        date_taken=dtaken,
                        camera_model=str(item.get("camera_model") or ""),
                        rating=r_int_p,
                        tags=added_tags,
                        remove_tags=removed_tags,
                        latitude=item.get("latitude"),
                        longitude=item.get("longitude"),
                        resolve_geo=True,
                    )
                if queued_ok:
                    applied_count += 1
                    if len(applied_items) < 50:
                        applied_items.append({
                            "photo_id": None,
                            "queued_pending": True,
                            "file_name": str(fname),
                            "rating": r_int_p,
                            "add_tags": added_tags,
                            "remove_tags": removed_tags,
                        })
                    continue

                skipped_count += 1
                logger.warning(
                    f"モバイル同期: 該当写真が見つからず変更を適用できませんでした "
                    f"(photo_id={pid}, file_name={fname}, date_taken={dtaken})"
                )
                if len(skipped_items) < 50:
                    skipped_items.append({
                        "photo_id": pid,
                        "content_key": ckey,
                        "file_name": fname,
                        "date_taken": dtaken,
                    })
                continue

            # 評価の更新 (-1: 棄, 0: 可, 1: 良, 2: 優)
            rating_val = item.get("rating")
            applied_rating: Optional[int] = None
            if rating_val is not None:
                r_int = max(-1, min(2, int(rating_val)))
                _update_rating_in_tx(cursor, target_id, r_int)
                applied_rating = r_int

            for clean_r_tag in removed_tags:
                _remove_tag_in_tx(conn, cursor, target_id, clean_r_tag)

            for clean_a_tag in added_tags:
                _add_tag_in_tx(conn, cursor, target_id, clean_a_tag, registered_tags_cache)

            # 非破壊調整値（回転・水平傾き・トリミング・明るさ・コントラスト・彩度）とお気に入りの反映
            adj_src = item.get("adjustments") if isinstance(item.get("adjustments"), dict) else item
            adj_cols: List[str] = []
            adj_params: List[Any] = []
            if adj_src.get("rotation") is not None:
                adj_cols.append("rotation = ?")
                adj_params.append((int(adj_src["rotation"]) % 360 + 360) % 360)
            if adj_src.get("fine_angle") is not None:
                adj_cols.append("fine_angle = ?")
                adj_params.append(round(max(-45.0, min(45.0, float(adj_src["fine_angle"]))), 2))
            for tone_col in ("brightness", "contrast", "saturation"):
                if adj_src.get(tone_col) is not None:
                    adj_cols.append(f"{tone_col} = ?")
                    adj_params.append(max(-100, min(100, int(adj_src[tone_col]))))
            crop_keys = ("crop_x", "crop_y", "crop_w", "crop_h")
            if all(adj_src.get(k) is not None for k in crop_keys):
                for crop_col in crop_keys:
                    adj_cols.append(f"{crop_col} = ?")
                    adj_params.append(round(max(0.0, min(1.0, float(adj_src[crop_col]))), 5))
            needs_thumb_refresh = bool(adj_cols)
            fav_val = item.get("is_favorite")
            if fav_val is not None:
                adj_cols.append("is_favorite = ?")
                adj_params.append(1 if int(fav_val) else 0)
            if adj_cols:
                adj_cols.append("updated_at = CURRENT_TIMESTAMP")
                adj_params.append(target_id)
                cursor.execute(
                    f"UPDATE photos SET {', '.join(adj_cols)} WHERE id = ?",
                    adj_params,
                )
                if needs_thumb_refresh and target_id not in thumb_refresh_ids:
                    thumb_refresh_ids.append(target_id)

            # スタック代表（表紙コマ）変更の反映
            if bool(adj_src.get("set_stack_primary") or item.get("set_stack_primary")):
                cursor.execute("SELECT stack_id FROM photos WHERE id = ?", (target_id,))
                st_row = cursor.fetchone()
                if st_row and st_row["stack_id"]:
                    old_sid = st_row["stack_id"]
                    cursor.execute(
                        "UPDATE photos SET stack_id = ?, is_stack_primary = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP WHERE stack_id = ?",
                        (target_id, target_id, old_sid),
                    )

            applied_count += 1
            if len(applied_items) < 50:
                applied_items.append({
                    "photo_id": target_id,
                    "file_name": matched_file_name or str(fname or f"ID:{target_id}"),
                    "rating": applied_rating,
                    "add_tags": added_tags,
                    "remove_tags": removed_tags,
                })

        conn.commit()
        try:
            conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except Exception as e:
            logger.debug(f"モバイル同期後のWALチェックポイントスキップ: {e}")

    from .routers.common import (
        BASE_DIR,
        _mobile_sync_event,
        clear_api_photos_cache,
    )

    if used_file and used_file.exists():
        try:
            cache_dir = BASE_DIR / "cache"
            cache_dir.mkdir(parents=True, exist_ok=True)
            bak_path = cache_dir / "mobile_sync.json.applied"
            if bak_path.exists():
                bak_path.unlink()
            used_file.replace(bak_path)
        except Exception as e:
            logger.warning(f"適用済み mobile_sync.json の退避失敗: {e}")

    refresh_fn = schedule_thumb_refresh or _schedule_thumbnail_refresh
    refresh_fn(thumb_refresh_ids)

    try:
        from .mobile_delta import ensure_mobile_delta_db
        ensure_mobile_delta_db(force=applied_count > 0)
    except Exception as delta_err:
        logger.debug(f"モバイル差分DB更新スキップ: {delta_err}")

    if applied_count > 0:
        _mobile_sync_event["seq"] += 1
        _mobile_sync_event["applied_count"] = applied_count
        clear_folders_fs_cache()
        clear_api_photos_cache()
        broadcast_app_event(
            "mobile_synced",
            {"applied": applied_count, "seq": _mobile_sync_event["seq"]},
        )

    return {
        "status": "ok",
        "applied_count": applied_count,
        "skipped_count": skipped_count,
        "source_file": used_file.name if used_file else None,
        "applied_items": applied_items,
        "skipped_items": skipped_items,
    }


_apply_mobile_sync_changes = apply_mobile_sync_changes
