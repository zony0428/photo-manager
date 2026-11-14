"""
ブラケット撮影（露出ブラケット）・連写（バースト）スタック計算モジュール
同一フォルダ内の連続撮影写真を自動グループ化し、代表写真を選定する。
"""

import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .connection import get_connection
from .photos import _build_folder_missing_filter, _directory_filter_sql, _strip_vsn_prefix_raw, invalidate_fast_cache


def _sync_tags_across_groups(cursor: Any, member_groups: List[List[int]]) -> int:
    """
    同一スタック（連写・ブラケット・重複）または同一フォルダRAW+JPEGペアとして編成された
    写真グループ内で、既存メンバーが保持しているタグ（photo_tags）をグループ全員へ同期する。
    """
    if not member_groups:
        return 0

    normalized_groups: List[List[int]] = []
    all_photo_ids_set: set = set()
    for grp in member_groups:
        uniq = list(dict.fromkeys(int(pid) for pid in grp if pid))
        if len(uniq) >= 2:
            normalized_groups.append(uniq)
            all_photo_ids_set.update(uniq)

    if not normalized_groups or not all_photo_ids_set:
        return 0

    all_ids = sorted(all_photo_ids_set)
    existing_tags_by_photo: Dict[int, Dict[str, tuple]] = {}
    chunk_sz = 450
    for idx in range(0, len(all_ids), chunk_sz):
        chunk = all_ids[idx : idx + chunk_sz]
        ph = ",".join(["?"] * len(chunk))
        cursor.execute(
            f"SELECT photo_id, tag, source, confidence FROM photo_tags WHERE photo_id IN ({ph})",
            chunk,
        )
        for row in cursor.fetchall():
            pid = int(row["photo_id"])
            tag_name = row["tag"]
            src = row["source"] or "manual"
            conf = float(row["confidence"]) if row["confidence"] is not None else 1.0
            existing_tags_by_photo.setdefault(pid, {})[tag_name] = (src, conf)

    if not existing_tags_by_photo:
        return 0

    upsert_params = []
    for grp in normalized_groups:
        merged_tags: Dict[str, tuple] = {}
        for pid in grp:
            p_tags = existing_tags_by_photo.get(pid)
            if not p_tags:
                continue
            for tag_name, (src, conf) in p_tags.items():
                if tag_name not in merged_tags:
                    merged_tags[tag_name] = (src, conf)
                else:
                    prev_src, prev_conf = merged_tags[tag_name]
                    best_src = "manual" if (src == "manual" or prev_src == "manual") else prev_src
                    best_conf = 1.0 if best_src == "manual" else max(prev_conf, conf)
                    merged_tags[tag_name] = (best_src, best_conf)

        if not merged_tags:
            continue

        for pid in grp:
            p_tags = existing_tags_by_photo.get(pid, {})
            for tag_name, (best_src, best_conf) in merged_tags.items():
                cur = p_tags.get(tag_name)
                if cur is None or (best_src == "manual" and cur[0] != "manual") or (best_conf > cur[1] + 1e-6):
                    upsert_params.append((pid, tag_name, best_src, best_conf))
                    existing_tags_by_photo.setdefault(pid, {})[tag_name] = (best_src, best_conf)

    if upsert_params:
        cursor.executemany(
            """
            INSERT INTO photo_tags (photo_id, tag, source, confidence)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(photo_id, tag) DO UPDATE SET
                source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE photo_tags.source END,
                confidence = CASE WHEN excluded.source = 'manual' THEN 1.0 ELSE MAX(COALESCE(photo_tags.confidence, 0.0), COALESCE(excluded.confidence, 0.0)) END
            """,
            upsert_params,
        )

    return len(upsert_params)


def recalculate_stacks(directory_path: Optional[str] = None, recursive: bool = True, existing_paths: Optional[set] = None) -> int:
    """単一ディレクトリ（またはライブラリ全体）のRAW+JPEGペア・連写・重複スタックを再計算する"""
    target_dirs = [directory_path] if directory_path else None
    return recalculate_stacks_for_directories(target_dirs, recursive=recursive, existing_paths=existing_paths)


def recalculate_stacks_for_directories(
    directory_paths: Optional[Iterable[str]] = None,
    recursive: bool = True,
    existing_paths: Optional[set] = None,
) -> int:
    """
    指定された1つ以上のディレクトリ（未指定時は全体）の写真を一括走査し、
    RAW+JPEGペア・露出ブラケット・連写・重複スタックを単一パスで再計算する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 対象ディレクトリの抽出（photos と photo_links の両方から収集）
        cleaned_targets = [d for d in (directory_paths or []) if d]
        if cleaned_targets:
            dirs_set: set = set()
            for dir_target in cleaned_targets:
                sql_frag_p, sql_params_p = _build_folder_missing_filter(dir_target, recursive=recursive)
                cursor.execute(f"SELECT DISTINCT directory_path FROM photos WHERE {sql_frag_p}", sql_params_p)
                for r in cursor.fetchall():
                    if r["directory_path"]:
                        dirs_set.add(r["directory_path"])
                sql_frag_pl, sql_params_pl = _build_folder_missing_filter(dir_target, recursive=recursive)
                cursor.execute(f"SELECT DISTINCT directory_path FROM photo_links WHERE {sql_frag_pl}", sql_params_pl)
                for r in cursor.fetchall():
                    if r["directory_path"]:
                        dirs_set.add(r["directory_path"])
            dirs = sorted(dirs_set)
        else:
            cursor.execute("SELECT DISTINCT directory_path FROM photos WHERE directory_path IS NOT NULL")
            dirs_set = {r["directory_path"] for r in cursor.fetchall() if r["directory_path"]}
            cursor.execute("SELECT DISTINCT directory_path FROM photo_links WHERE directory_path IS NOT NULL")
            for r in cursor.fetchall():
                if r["directory_path"]:
                    dirs_set.add(r["directory_path"])
            dirs = sorted(dirs_set)

        norm_existing_paths = None
        if existing_paths is not None:
            norm_existing_paths = {os.path.normcase(os.path.abspath(p)) for p in existing_paths}

        total_stacks_created = 0
        cleared_paired_counterparts: set = set()
        tag_sync_groups: List[List[int]] = []

        for d in dirs:
            cursor.execute(
                """
                SELECT p.id, pl.id AS link_id, pl.file_name, pl.file_path, p.file_size,
                       p.date_taken, p.subsec_time, p.exposure_bias,
                       p.f_number, p.focal_length, p.shutter_speed, p.camera_model,
                       p.stack_id, p.is_stack_primary, p.stack_type, p.rating,
                       COALESCE(pl.paired_raw_path, p.paired_raw_path) AS paired_raw_path,
                       p.is_raw, p.raw_format, pl.volume_serial, COALESCE(p.has_xmp, 0) AS has_xmp
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.directory_path = ? COLLATE NOCASE AND IFNULL(p.is_unlinked, 0) = 0
                UNION ALL
                SELECT p.id, NULL AS link_id, p.file_name, p.file_path, p.file_size,
                       p.date_taken, p.subsec_time, p.exposure_bias,
                       p.f_number, p.focal_length, p.shutter_speed, p.camera_model,
                       p.stack_id, p.is_stack_primary, p.stack_type, p.rating, p.paired_raw_path,
                       p.is_raw, p.raw_format, p.volume_serial, COALESCE(p.has_xmp, 0) AS has_xmp
                FROM photos p
                WHERE p.directory_path = ? COLLATE NOCASE AND IFNULL(p.is_unlinked, 0) = 0
                  AND NOT EXISTS (
                      SELECT 1 FROM photo_links pl2
                      WHERE pl2.photo_id = p.id AND pl2.directory_path = ? COLLATE NOCASE
                  )
                ORDER BY date_taken ASC, subsec_time ASC, file_name ASC
                """,
                (d, d, d),
            )
            all_dir_photos = [dict(r) for r in cursor.fetchall()]
            if not all_dir_photos:
                continue

            # 複数SDカードが同一ドライブレター・同一ディレクトリ（例: E:\DCIM\100MSDCF）を共有する場合に
            # 別メディアの同名ファイルや連写が混ざらないよう、volume_serial ごとに分離して処理する
            vsn_buckets: Dict[str, List[Dict[str, Any]]] = {}
            for p_row in all_dir_photos:
                vsn_key = (p_row.get("volume_serial") or "").strip().upper()
                vsn_buckets.setdefault(vsn_key, []).append(p_row)

            pending_updates = []
            pending_link_updates = []
            pending_xmp_updates = []

            # 同一ドライブレター・同一ディレクトリに複数VSNが存在する場合、同時にマウントできるのは1つのVSNのみ
            active_vsn_at_dir = None
            non_empty_vsns = [k for k in vsn_buckets.keys() if k]
            if len(non_empty_vsns) > 1:
                try:
                    from ..volume_info import get_volume_info
                    vi = get_volume_info(d)
                    if vi and vi.get("serial") and str(vi["serial"]).strip().upper() in vsn_buckets:
                        active_vsn_at_dir = str(vi["serial"]).strip().upper()
                except Exception:
                    pass
                if not active_vsn_at_dir:
                    active_vsn_at_dir = max(
                        non_empty_vsns,
                        key=lambda k: max(int(p.get("id") or 0) for p in vsn_buckets[k]),
                    )

            for _vsn_key, photos in vsn_buckets.items():
                is_unmounted_vsn = bool(active_vsn_at_dir and _vsn_key and _vsn_key != active_vsn_at_dir)
                # 現在のDB値を保持し、変更が必要な行だけをバッチ更新するためのマップ
                current_vals = {
                    p["id"]: (p.get("stack_id"), p.get("is_stack_primary"), p.get("stack_type"), p.get("paired_raw_path"))
                    for p in photos
                }
                link_id_map = {p["id"]: p.get("link_id") for p in photos}

                # 旧実装との互換: paired_raw_path はステップ1で明示設定されたもの以外は None 扱いとする
                # （DB値は差分判定用の current_vals と、非表示化時に値を維持するための db_paired にのみ保持）
                db_paired = {p["id"]: p.pop("paired_raw_path", None) for p in photos}

                def queue_update(photo_id: int, new_stack_id: Optional[int], new_is_primary: int, new_stack_type: Optional[str], new_paired_raw: Optional[str]) -> None:
                    clean_paired = _strip_vsn_prefix_raw(new_paired_raw) if new_paired_raw else None
                    cur = current_vals.get(photo_id)
                    if cur and cur[3] and not clean_paired:
                        cleared_paired_counterparts.add(_strip_vsn_prefix_raw(cur[3]))
                    target = (new_stack_id, new_is_primary, new_stack_type, clean_paired)
                    if cur != target:
                        pending_updates.append((new_stack_id, new_is_primary, new_stack_type, clean_paired, photo_id))
                        current_vals[photo_id] = target
                    lid = link_id_map.get(photo_id)
                    if lid is not None and db_paired.get(photo_id) != clean_paired:
                        pending_link_updates.append((clean_paired, lid))
                        db_paired[photo_id] = clean_paired

                # 各写真の実ファイル存在チェック（オフライン/物理削除の判別、vsn:// 退避パス対応）
                for p in photos:
                    p["_clean_file_path"] = _strip_vsn_prefix_raw(p["file_path"])

                if is_unmounted_vsn:
                    for p in photos:
                        p["is_online"] = False
                elif norm_existing_paths is not None:
                    for p in photos:
                        if str(p["file_path"]).startswith("vsn://"):
                            p["is_online"] = False
                        else:
                            p["is_online"] = os.path.normcase(os.path.abspath(p["file_path"])) in norm_existing_paths
                else:
                    from ..scanner import resolve_portable_path
                    for p in photos:
                        if p.get("volume_serial"):
                            res_p, is_on = resolve_portable_path(p["file_path"], expected_serial=p.get("volume_serial"))
                            p["is_online"] = bool(is_on and res_p.exists())
                        elif str(p["file_path"]).startswith("vsn://"):
                            p["is_online"] = False
                        else:
                            p["is_online"] = os.path.exists(p["file_path"])

                # ステップ1: ステム名（拡張子抜き）でグループ化してRAW+JPEGペアを検出
                stem_map: Dict[str, List[Dict[str, Any]]] = {}
                for p in photos:
                    stem = Path(p["file_name"]).stem.lower()
                    stem_map.setdefault(stem, []).append(p)

                # 代表アイテム一覧（1ステムあたり1代表: 実在するファイルを最優先し、JPEG優先、なければRAW）
                representative_list = []
                for stem, items in stem_map.items():
                    raws = [it for it in items if it.get("is_raw")]
                    jpegs = [it for it in items if not it.get("is_raw")]

                    online_raws = [it for it in raws if it.get("is_online")]
                    online_jpegs = [it for it in jpegs if it.get("is_online")]

                    if online_raws and online_jpegs:
                        # RAWとJPEGが両方実在するペア: 実在JPEGを代表に設定
                        primary_rep = online_jpegs[0]
                        primary_rep["paired_raw_path"] = online_raws[0]["_clean_file_path"]
                        for r in raws:
                            r["paired_raw_path"] = primary_rep["_clean_file_path"]
                        if not primary_rep.get("has_xmp") and any(r.get("has_xmp") for r in online_raws):
                            pending_xmp_updates.append((1, primary_rep["id"]))
                        primary_rep["attached_raws"] = [j for j in jpegs if j["id"] != primary_rep["id"]] + raws
                        primary_rep["has_pair"] = True
                        representative_list.append(primary_rep)
                    elif online_jpegs:
                        # JPEGのみ実在（RAWは未存在または削除済）
                        rep = online_jpegs[0]
                        rep["paired_raw_path"] = None
                        rep["attached_raws"] = [j for j in jpegs if j["id"] != rep["id"]] + raws
                        rep["has_pair"] = False
                        representative_list.append(rep)
                    elif online_raws:
                        # RAWのみ実在（JPEGは未存在または削除済）
                        rep = online_raws[0]
                        rep["paired_raw_path"] = None
                        rep["attached_raws"] = [r for r in raws if r["id"] != rep["id"]] + jpegs
                        rep["has_pair"] = False
                        representative_list.append(rep)
                    elif raws and jpegs:
                        # 両方実ファイルなし（全滅または退避中）: JPEGを代表
                        primary_rep = jpegs[0]
                        primary_rep["paired_raw_path"] = raws[0]["_clean_file_path"]
                        for r in raws:
                            r["paired_raw_path"] = primary_rep["_clean_file_path"]
                        primary_rep["attached_raws"] = jpegs[1:] + raws
                        primary_rep["has_pair"] = True
                        representative_list.append(primary_rep)
                    elif raws:
                        rep = raws[0]
                        rep["paired_raw_path"] = None
                        rep["attached_raws"] = raws[1:]
                        rep["has_pair"] = False
                        representative_list.append(rep)
                    else:
                        rep = jpegs[0]
                        rep["paired_raw_path"] = None
                        rep["attached_raws"] = jpegs[1:]
                        rep["has_pair"] = False
                        representative_list.append(rep)

                # 代表アイテムを時系列順にソート
                representative_list.sort(key=lambda p: (p.get("date_taken") or "", p.get("subsec_time") or "", p["file_name"]))

                # datetime.strptime の結果を事前に1回だけ計算してキャッシュ
                for p in representative_list:
                    dt_str = p.get("date_taken")
                    p_dt = None
                    if dt_str:
                        try:
                            p_dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
                        except Exception:
                            p_dt = None
                    p["_parsed_dt"] = p_dt

                # ステップ2: 代表写真同士でブラケットおよび連写をグルーピング
                # 【重要】無限数珠つなぎとExifなし同一秒の誤スタック化を完全に防ぐ
                i = 0
                while i < len(representative_list):
                    first_rep = representative_list[i]
                    group = [first_rep]
                    t_start = first_rep.get("_parsed_dt")

                    # 先頭写真のExif情報（撮影パラメータ）有無
                    has_first_exif = bool(
                        first_rep.get("subsec_time") or
                        first_rep.get("shutter_speed") or
                        first_rep.get("f_number") or
                        (first_rep.get("camera_model") and first_rep.get("camera_model") != "不明")
                    )

                    j = i + 1
                    while j < len(representative_list):
                        prev = representative_list[j - 1]
                        curr = representative_list[j]

                        t1 = prev.get("_parsed_dt")
                        t2 = curr.get("_parsed_dt")
                        if not t1 or not t2 or not t_start:
                            break

                        time_diff = abs((t2 - t1).total_seconds())
                        total_diff = abs((t2 - t_start).total_seconds())

                        # 安全弁1: グループ先頭写真から5秒を超えるか、連写枚数が20枚に達したら打ち切り
                        if total_diff > 5.0 or len(group) >= 20:
                            break

                        # カメラ機種が異なる場合は別カメラ撮影のため連写・ブラケット化しない
                        if curr.get("camera_model") and first_rep.get("camera_model"):
                            if curr.get("camera_model") != first_rep.get("camera_model"):
                                break

                        bias_diff = abs((curr.get("exposure_bias") or 0.0) - (prev.get("exposure_bias") or 0.0))

                        # ブラケット候補: 2.5秒以内で露出差がある（最大7枚まで）
                        if time_diff <= 2.5 and bias_diff > 0.1 and len(group) < 7:
                            group.append(curr)
                            j += 1
                            continue

                        # 高速連写候補: 1秒以内かつ露出が同じ
                        if time_diff <= 1.0 and bias_diff <= 0.05:
                            # 安全弁2: 同一秒（time_diff == 0）かつExif情報が皆無の場合
                            # （ファイルコピー等で更新日時が一致しただけの大量ファイル事故）は連写化を阻止
                            if time_diff == 0.0 and not has_first_exif:
                                break
                            # 安全弁3: 同一秒かつファイルサイズが完全一致する場合は同一写真の複製（重複コピー）のため
                            # 連写化を阻止し、第3パスの重複スタック（duplicate）に正しく委ねる
                            if time_diff == 0.0 and curr.get("file_size") and curr.get("file_size") == prev.get("file_size"):
                                break
                            group.append(curr)
                            j += 1
                            continue

                        break

                    # 2枚以上のブラケット/連写グループの場合
                    if len(group) >= 2:
                        # 実在する写真（物理ファイルが存在する写真）を優先抽出
                        online_reps = [g for g in group if g.get("is_online")]

                        if len(online_reps) >= 2:
                            # 実在する写真が2枚以上: 実在する写真群から代表を選定
                            biases = [g.get("exposure_bias") or 0.0 for g in online_reps]
                            is_bracket = len(set(biases)) > 1
                            stack_type = "bracket" if is_bracket else "burst"

                            # 代表写真の選定: 評価（優=2 > 良=1 > 可=0 > 棄=-1）が最も高いコマを最優先とし、
                            # 同評価の場合はブラケットなら±0に最も近いもの、連写なら1枚目（必ず実在する写真から選出）
                            if is_bracket:
                                best_rep = min(
                                    online_reps,
                                    key=lambda p: (-int(p.get("rating") or 0), abs(p.get("exposure_bias") or 0.0)),
                                )
                                primary_id = best_rep["id"]
                            else:
                                best_rep = max(
                                    enumerate(online_reps),
                                    key=lambda kv: (int(kv[1].get("rating") or 0), -kv[0]),
                                )[1]
                                primary_id = best_rep["id"]

                            stack_id = primary_id

                            # グループ内の代表写真およびその全付随RAWをスタック化
                            grp_member_ids = []
                            for rep in group:
                                is_pri = 1 if rep["id"] == primary_id else 0
                                queue_update(rep["id"], stack_id, is_pri, stack_type, rep.get("paired_raw_path"))
                                grp_member_ids.append(rep["id"])
                                for raw_it in rep.get("attached_raws", []):
                                    queue_update(raw_it["id"], stack_id, 0, stack_type, raw_it.get("paired_raw_path"))
                                    grp_member_ids.append(raw_it["id"])
                            tag_sync_groups.append(grp_member_ids)

                            total_stacks_created += 1

                        elif len(online_reps) == 1:
                            # 実在する写真が1枚だけ残っている場合:
                            # 物理削除により連写/ブラケットが解消されたため、スタックを解除して単独写真（代表）として表示
                            survivor = online_reps[0]
                            queue_update(survivor["id"], None, 1, None, survivor.get("paired_raw_path"))
                            survivor_pair_ids = [survivor["id"]]
                            # survivorに付随する実在RAWがあれば、正規のペアとして紐付け
                            for raw_it in survivor.get("attached_raws", []):
                                queue_update(raw_it["id"], None, 1, None, survivor["_clean_file_path"])
                                survivor_pair_ids.append(raw_it["id"])
                            if len(survivor_pair_ids) >= 2:
                                tag_sync_groups.append(survivor_pair_ids)

                            # 実在しない他メンバー（およびその付随RAW）は代表にせず非表示化（paired_raw_path は変更しない）
                            for rep in group:
                                if rep["id"] != survivor["id"]:
                                    queue_update(rep["id"], None, 0, None, db_paired.get(rep["id"]))
                                    for raw_it in rep.get("attached_raws", []):
                                        queue_update(raw_it["id"], None, 0, None, db_paired.get(raw_it["id"]))
                        else:
                            # 全滅（実在写真が0枚または退避中）の場合: 従来通りのフォールバック
                            biases = [g.get("exposure_bias") or 0.0 for g in group]
                            is_bracket = len(set(biases)) > 1
                            stack_type = "bracket" if is_bracket else "burst"
                            if is_bracket:
                                best_rep = min(
                                    group,
                                    key=lambda p: (-int(p.get("rating") or 0), abs(p.get("exposure_bias") or 0.0)),
                                )
                                primary_id = best_rep["id"]
                            else:
                                best_rep = max(
                                    enumerate(group),
                                    key=lambda kv: (int(kv[1].get("rating") or 0), -kv[0]),
                                )[1]
                                primary_id = best_rep["id"]

                            stack_id = primary_id
                            grp_member_ids = []
                            for rep in group:
                                is_pri = 1 if rep["id"] == primary_id else 0
                                queue_update(rep["id"], stack_id, is_pri, stack_type, rep.get("paired_raw_path"))
                                grp_member_ids.append(rep["id"])
                                for raw_it in rep.get("attached_raws", []):
                                    queue_update(raw_it["id"], stack_id, 0, stack_type, raw_it.get("paired_raw_path"))
                                    grp_member_ids.append(raw_it["id"])
                            tag_sync_groups.append(grp_member_ids)

                        i = j

                    # ブラケット/連写ではないが、RAW+JPEGペアが存在する場合
                    # → スタック化はせず、paired_raw_path の紐付けのみ行う
                    #   （右ペインで「RAWあり」表示 + 「RAWを開く」ボタンで対応）
                    elif group[0].get("has_pair") or group[0].get("attached_raws"):
                        rep = group[0]
                        queue_update(rep["id"], None, 1, None, rep.get("paired_raw_path"))
                        pair_member_ids = [rep["id"]]
                        for raw_it in rep.get("attached_raws", []):
                            queue_update(raw_it["id"], None, 1, None, rep["_clean_file_path"])
                            pair_member_ids.append(raw_it["id"])
                        if len(pair_member_ids) >= 2:
                            tag_sync_groups.append(pair_member_ids)
                        i += 1

                    # 完全な単独写真（ペアなし、ブラケットなし）
                    else:
                        rep = group[0]
                        # 重複スタック（duplicate）に属している写真は第3パス（recalculate_duplicate_stacks）で
                        # 専任管理するため、第1パスで勝手にリセットしない
                        if rep.get("stack_type") != "duplicate":
                            queue_update(rep["id"], None, 1, None, None)
                        i += 1

            # 変更が必要な写真のみ executemany でまとめて一括更新
            if pending_updates:
                cursor.executemany(
                    """
                    UPDATE photos
                    SET stack_id = ?, is_stack_primary = ?, stack_type = ?, paired_raw_path = ?
                    WHERE id = ?
                    """,
                    pending_updates,
                )
            if pending_link_updates:
                cursor.executemany(
                    """
                    UPDATE photo_links
                    SET paired_raw_path = ?
                    WHERE id = ?
                    """,
                    pending_link_updates,
                )
            if pending_xmp_updates:
                cursor.executemany("UPDATE photos SET has_xmp = ? WHERE id = ?", pending_xmp_updates)

        # ============================================================
        # 第2パス: クロスフォルダ・クロスドライブ RAW+JPEG ペアリング
        # ディレクトリ内ペアリングでマッチしなかった未ペアRAWに対して、
        # 全スキャン済みフォルダを横断してステム名+撮影日時(+カメラ機種)で対応するJPEGを探す。
        # （例: 112_PANA/ にJPEG、112_PANA RAW/ にRAW、あるいは別ドライブにRAWを退避管理するケース）
        # ============================================================
        if cleared_paired_counterparts:
            cp_list = list(cleared_paired_counterparts)
            chunk_sz = 400
            for idx_c in range(0, len(cp_list), chunk_sz):
                chunk_cp = cp_list[idx_c : idx_c + chunk_sz]
                ph = ",".join(["?"] * len(chunk_cp))
                cursor.execute(
                    f"""
                    UPDATE photos SET paired_raw_path = NULL
                    WHERE file_path IN ({ph})
                       OR id IN (SELECT photo_id FROM photo_links WHERE file_path IN ({ph}))
                    """,
                    chunk_cp + chunk_cp,
                )
                cursor.execute(
                    f"""
                    UPDATE photo_links SET paired_raw_path = NULL
                    WHERE file_path IN ({ph})
                       OR photo_id IN (SELECT id FROM photos WHERE file_path IN ({ph}))
                    """,
                    chunk_cp + chunk_cp,
                )

        if tag_sync_groups:
            _sync_tags_across_groups(cursor, tag_sync_groups)

        pair_cross_folder_raw_jpeg(cursor)
        conn.commit()

        # ============================================================
        # 第3パス: 重複写真（同一画像）のクロスフォルダ スタック化
        # 複数フォルダに存在する同一画像をスマート品質スコアで代表選定し、
        # stack_type = 'duplicate' としてグループ化する。
        # ============================================================
        dup_count = recalculate_duplicate_stacks()
        total_stacks_created += dup_count

        invalidate_fast_cache()
        return total_stacks_created


def pair_cross_folder_raw_jpeg(cursor: Any) -> int:
    """
    未ペアRAWに対して、全スキャン済みフォルダ・全ドライブを横断して
    対応するJPEGを探索・ペアリングし、タグと評価を双方向同期する。
    """
    cursor.execute(
        """
        SELECT id, file_name, file_path, date_taken, camera_model, volume_serial, rating,
               COALESCE(has_xmp, 0) AS has_xmp
        FROM photos
        WHERE is_raw = 1 AND paired_raw_path IS NULL AND IFNULL(is_unlinked, 0) = 0
        """
    )
    unpaired_raws = [dict(r) for r in cursor.fetchall()]
    if not unpaired_raws:
        return 0

    cursor.execute(
        """
        SELECT id, file_name, file_path, date_taken, camera_model, volume_serial, rating,
               COALESCE(has_xmp, 0) AS has_xmp
        FROM photos
        WHERE is_raw = 0 AND paired_raw_path IS NULL AND IFNULL(is_unlinked, 0) = 0
        """
    )
    jpeg_stem_map: Dict[str, List[Dict[str, Any]]] = {}
    for row in cursor.fetchall():
        jpeg = dict(row)
        stem = Path(jpeg["file_name"]).stem.lower()
        jpeg_stem_map.setdefault(stem, []).append(jpeg)

    cross_pairs_found = 0
    cross_pair_updates = []
    cross_tag_sync_pairs = []
    cross_rating_updates = []
    cross_xmp_updates = []
    invalid_cams = {"", "不明", "raw写真"}

    for raw_photo in unpaired_raws:
        raw_stem = Path(raw_photo["file_name"]).stem.lower()
        raw_date = (raw_photo.get("date_taken") or "").strip()
        raw_cam = (raw_photo.get("camera_model") or "").strip()
        raw_cam_valid = raw_cam.lower() not in invalid_cams
        raw_vsn = (raw_photo.get("volume_serial") or "").strip().upper()

        all_candidates = jpeg_stem_map.get(raw_stem, [])
        if not all_candidates:
            continue

        # 1. 同一ボリューム（または両方 volume_serial 未設定）の候補を最優先
        same_vsn_candidates = [
            c for c in all_candidates
            if (c.get("volume_serial") or "").strip().upper() == raw_vsn
        ]
        matched = None
        if same_vsn_candidates:
            if raw_date:
                for cand in same_vsn_candidates:
                    if (cand.get("date_taken") or "").strip() == raw_date:
                        matched = cand
                        break
            if not matched and len(same_vsn_candidates) == 1:
                matched = same_vsn_candidates[0]

        # 2. 別ドライブ・別ボリューム間でも、ステム名 + 撮影日時 + カメラ機種 が完全一致する場合はペアリング
        #    （別カメラ・別SDカードの同名ファイル誤ペアリングを防ぐため撮影日時と有効なカメラ機種の一致を必須とする）
        if not matched and raw_date and raw_cam_valid:
            for cand in all_candidates:
                cand_vsn = (cand.get("volume_serial") or "").strip().upper()
                if cand_vsn == raw_vsn:
                    continue
                cand_date = (cand.get("date_taken") or "").strip()
                cand_cam = (cand.get("camera_model") or "").strip()
                if cand_date == raw_date and cand_cam.lower() not in invalid_cams and cand_cam.lower() == raw_cam.lower():
                    matched = cand
                    break

        if matched:
            raw_clean_fp = _strip_vsn_prefix_raw(raw_photo["file_path"])
            jpeg_clean_fp = _strip_vsn_prefix_raw(matched["file_path"])
            cross_pair_updates.append((raw_clean_fp, matched["id"]))
            cross_pair_updates.append((jpeg_clean_fp, raw_photo["id"]))
            cross_tag_sync_pairs.append((matched["id"], raw_photo["id"]))

            j_rating = int(matched.get("rating") or 0)
            r_rating = int(raw_photo.get("rating") or 0)
            if j_rating != r_rating:
                merged_rating = j_rating if r_rating == 0 else (r_rating if j_rating == 0 else max(j_rating, r_rating))
                if j_rating != merged_rating:
                    cross_rating_updates.append((merged_rating, matched["id"]))
                if r_rating != merged_rating:
                    cross_rating_updates.append((merged_rating, raw_photo["id"]))

            if raw_photo.get("has_xmp") and not matched.get("has_xmp"):
                cross_xmp_updates.append((1, matched["id"]))
            elif matched.get("has_xmp") and not raw_photo.get("has_xmp"):
                cross_xmp_updates.append((1, raw_photo["id"]))

            all_candidates.remove(matched)
            cross_pairs_found += 1

    if cross_pair_updates:
        cursor.executemany(
            "UPDATE photos SET paired_raw_path = ? WHERE id = ?",
            cross_pair_updates,
        )
        cursor.executemany(
            "UPDATE photo_links SET paired_raw_path = ? WHERE photo_id = ?",
            cross_pair_updates,
        )

    if cross_tag_sync_pairs:
        tag_sync_params = []
        for j_id, r_id in cross_tag_sync_pairs:
            tag_sync_params.append((r_id, j_id))
            tag_sync_params.append((j_id, r_id))
        cursor.executemany(
            """
            INSERT INTO photo_tags (photo_id, tag, source, confidence)
            SELECT ?, tag, source, confidence FROM photo_tags WHERE photo_id = ?
            ON CONFLICT(photo_id, tag) DO UPDATE SET
                source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE photo_tags.source END,
                confidence = CASE WHEN excluded.source = 'manual' THEN 1.0 ELSE MAX(photo_tags.confidence, excluded.confidence) END
            """,
            tag_sync_params,
        )

    if cross_rating_updates:
        cursor.executemany(
            "UPDATE photos SET rating = ? WHERE id = ?",
            cross_rating_updates,
        )
    if cross_xmp_updates:
        cursor.executemany(
            "UPDATE photos SET has_xmp = ? WHERE id = ?",
            cross_xmp_updates,
        )

    return cross_pairs_found


def recalculate_duplicate_stacks() -> int:
    """
    ライブラリ全体の重複写真（同一撮影日時 ＋ 同一ファイルサイズ）を検索し、
    品質スコア（Quality Score）が最高の写真を代表（is_stack_primary = 1）とし、
    同一グループの写真を stack_type = 'duplicate' としてスタック化する。

    ※既存の連写バースト・露出ブラケット（burst, bracket）は優先して保護する。
    戻り値: 作成・維持された重複スタック数
    """
    from .duplicates import compute_photo_quality_score

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 撮影日時とファイルサイズが同一で2件以上存在するグループを抽出
        cursor.execute(
            """
            SELECT date_taken, file_size, COUNT(*) as cnt
            FROM photos
            WHERE date_taken IS NOT NULL AND date_taken != '' AND file_size > 0 AND IFNULL(is_unlinked, 0) = 0
            GROUP BY date_taken, file_size
            HAVING cnt > 1
            """
        )
        dup_groups = cursor.fetchall()

        # 現在 duplicate スタックに割り当てられている全写真IDの集合を取得（解消されたスタックのリセット判定用）
        cursor.execute("SELECT id, stack_id, is_stack_primary FROM photos WHERE stack_type = 'duplicate'")
        existing_dup_photos = {r["id"]: (r["stack_id"], r["is_stack_primary"]) for r in cursor.fetchall()}

        active_dup_photo_ids = set()
        pending_updates = []
        dup_tag_sync_groups: List[List[int]] = []
        dup_stacks_created = 0

        for g in dup_groups:
            dt = g["date_taken"]
            sz = g["file_size"]

            cursor.execute(
                """
                SELECT id, file_name, file_path, file_size, width, height,
                       date_taken, camera_model, lens_model, f_number, shutter_speed, iso,
                       exposure_bias, latitude, longitude, is_raw, rating,
                       stack_id, is_stack_primary, stack_type
                FROM photos
                WHERE date_taken = ? AND file_size = ? AND IFNULL(is_unlinked, 0) = 0
                ORDER BY id ASC
                """,
                (dt, sz),
            )
            members = [dict(r) for r in cursor.fetchall()]

            # 既存の burst / bracket スタックに属している写真は重複スタックから除外（連写を最優先保護）
            eligible_members = [
                m for m in members
                if m.get("stack_type") not in ("burst", "bracket")
            ]

            if len(eligible_members) < 2:
                continue

            # 各メンバーの品質スコアを算出
            for m in eligible_members:
                m["_score"] = compute_photo_quality_score(m)

            # 評価（優=2 > 良=1 > 可=0 > 棄=-1）最優先、同評価なら品質スコア降順（同点ならID昇順）で代表を選出
            eligible_members.sort(key=lambda x: (int(x.get("rating") or 0), x["_score"], -x["id"]), reverse=True)
            primary_id = eligible_members[0]["id"]
            dup_tag_sync_groups.append([int(m["id"]) for m in eligible_members])

            for m in eligible_members:
                m_id = m["id"]
                active_dup_photo_ids.add(m_id)
                new_pri = 1 if m_id == primary_id else 0
                cur_stack_id = m.get("stack_id")
                cur_pri = m.get("is_stack_primary")
                cur_type = m.get("stack_type")

                if cur_stack_id != primary_id or cur_pri != new_pri or cur_type != "duplicate":
                    pending_updates.append((primary_id, new_pri, "duplicate", m_id))

            dup_stacks_created += 1

        # 重複が解消された（削除などにより単独になった）かつて duplicate スタックだった写真のリセット
        reset_ids = set(existing_dup_photos.keys()) - active_dup_photo_ids
        for r_id in reset_ids:
            pending_updates.append((None, 1, None, r_id))

        if pending_updates:
            cursor.executemany(
                """
                UPDATE photos
                SET stack_id = ?, is_stack_primary = ?, stack_type = ?
                WHERE id = ?
                """,
                pending_updates,
            )

        if dup_tag_sync_groups:
            _sync_tags_across_groups(cursor, dup_tag_sync_groups)

        conn.commit()
        invalidate_fast_cache()
        return dup_stacks_created


def set_stack_primary(photo_id: int) -> bool:
    """指定された写真をそのスタックの代表（primary）に設定する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT stack_id FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        if not row or not row["stack_id"]:
            return False

        old_stack_id = row["stack_id"]
        new_primary_id = photo_id
        # スタック内の全写真の is_stack_primary を更新し、stack_id も新代表の ID に統一
        cursor.execute(
            """
            UPDATE photos
            SET stack_id = ?, is_stack_primary = CASE WHEN id = ? THEN 1 ELSE 0 END
            WHERE stack_id = ?
            """,
            (new_primary_id, new_primary_id, old_stack_id),
        )
        conn.commit()
        invalidate_fast_cache()
        return True


def get_stack_detail(stack_id: int) -> Optional[Dict[str, Any]]:
    """指定された stack_id に属する全メンバー写真のフル属性（EXIF・タグ・調整値・状態）を取得する"""
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT p.id, p.file_path, p.file_name, p.directory_path, p.file_size, p.file_mtime,
               p.width, p.height, p.date_taken, p.original_date_taken, p.year_month, p.camera_model,
               p.exposure_bias, p.shutter_speed, p.f_number, p.iso, p.focal_length,
               p.lens_model, p.subsec_time, p.latitude, p.longitude, p.gps_source,
               p.country, p.state, p.city, p.stack_id, p.is_stack_primary, p.stack_type,
               p.rating, p.is_raw, p.raw_format, p.paired_raw_path, p.volume_serial,
               p.rotation, p.fine_angle, p.crop_x, p.crop_y, p.crop_w, p.crop_h,
               p.crop_aspect, p.brightness, p.contrast, p.saturation,
               p.is_unlinked, COALESCE(p.has_xmp, 0) AS has_xmp,
               v.volume_label, COALESCE(v.custom_name, '') AS volume_custom_name,
               v.drive_letter AS volume_drive
        FROM photos p
        LEFT JOIN volumes v ON p.volume_serial = v.volume_serial AND COALESCE(p.is_unlinked, 0) = 0
        WHERE p.stack_id = ?
          AND IFNULL(p.is_unlinked, 0) = 0
          AND NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')
        ORDER BY p.date_taken ASC, p.subsec_time ASC, p.exposure_bias ASC, p.file_name ASC
        """,
        (int(stack_id),),
    ).fetchall()
    if not rows:
        return None

    members = [dict(r) for r in rows]
    photo_ids = [int(m["id"]) for m in members]
    ph = ",".join("?" * len(photo_ids))

    tags_map: Dict[int, List[str]] = {}
    tag_details_map: Dict[int, List[Dict[str, Any]]] = {}
    for tr in conn.execute(
        f"SELECT photo_id, tag, source, confidence FROM photo_tags WHERE photo_id IN ({ph}) ORDER BY confidence DESC",
        photo_ids,
    ).fetchall():
        pid_t = int(tr["photo_id"])
        tags_map.setdefault(pid_t, []).append(tr["tag"])
        tag_details_map.setdefault(pid_t, []).append({
            "tag": tr["tag"],
            "source": tr["source"] or "manual",
            "confidence": tr["confidence"] if tr["confidence"] is not None else 1.0,
        })

    from ..scanner import resolve_drive_online_path
    from ..storage_manager import is_path_in_storage

    primary_id: Optional[int] = None
    stack_type: Optional[str] = None
    dir_state_cache: Dict[tuple, tuple] = {}

    for m in members:
        pid = int(m["id"])
        m["file_path"] = _strip_vsn_prefix_raw(m.get("file_path"))
        m["tags"] = tags_map.get(pid, [])
        m["tag_details"] = tag_details_map.get(pid, [])
        m["has_xmp"] = bool(m.get("has_xmp"))
        vsn = m.get("volume_serial")
        dp = m.get("directory_path") or ""
        ck = (vsn or "", dp)
        if ck not in dir_state_cache:
            if dp and not str(dp).startswith("vsn://"):
                _, is_on = resolve_drive_online_path(dp, expected_serial=vsn)
                is_st = is_path_in_storage(dp, volume_serial=vsn)
                dir_state_cache[ck] = (bool(is_on), bool(is_st))
            else:
                dir_state_cache[ck] = (False, False)
        is_on, is_st = dir_state_cache[ck]
        m["is_offline"] = not is_on
        m["is_storage"] = is_st
        m["is_missing"] = False
        if m.get("is_stack_primary"):
            primary_id = pid
        if not stack_type and m.get("stack_type"):
            stack_type = m["stack_type"]

    if primary_id is None:
        primary_id = int(members[0]["id"])

    return {
        "stack_id": int(stack_id),
        "stack_type": stack_type,
        "primary_photo_id": primary_id,
        "stack_count": len(members),
        "photos": members,
    }
