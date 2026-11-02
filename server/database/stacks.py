"""
ブラケット撮影（露出ブラケット）・連写（バースト）スタック計算モジュール
同一フォルダ内の連続撮影写真を自動グループ化し、代表写真を選定する。
"""

import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .connection import get_connection
from .photos import _build_folder_missing_filter, _directory_filter_sql, _strip_vsn_prefix_raw


def recalculate_stacks(directory_path: Optional[str] = None, recursive: bool = True, existing_paths: Optional[set] = None) -> int:
    """
    同一ディレクトリ内の写真を走査し、
    1. 同名ステムのRAW+JPEGペアの自動紐付け（JPEGを代表、RAWをスタックメンバー化）
    2. 露出ブラケット（露出補正値の差）および連写（burst）の自動グルーピング
    を行い、スタックグループ（stack_id）と代表写真（is_stack_primary）を割り当てる。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 対象ディレクトリの抽出（photos と photo_links の両方から収集）
        if directory_path:
            sql_frag_p, sql_params_p = _build_folder_missing_filter(directory_path, recursive=recursive)
            cursor.execute(f"SELECT DISTINCT directory_path FROM photos WHERE {sql_frag_p}", sql_params_p)
            dirs_set = {r["directory_path"] for r in cursor.fetchall() if r["directory_path"]}
            sql_frag_pl, sql_params_pl = _build_folder_missing_filter(directory_path, recursive=recursive)
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

        for d in dirs:
            cursor.execute(
                """
                SELECT p.id, pl.id AS link_id, pl.file_name, pl.file_path, p.file_size,
                       p.date_taken, p.subsec_time, p.exposure_bias,
                       p.f_number, p.focal_length, p.shutter_speed, p.camera_model,
                       p.stack_id, p.is_stack_primary, p.stack_type,
                       COALESCE(pl.paired_raw_path, p.paired_raw_path) AS paired_raw_path,
                       p.is_raw, p.raw_format, pl.volume_serial
                FROM photo_links pl
                INNER JOIN photos p ON pl.photo_id = p.id
                WHERE pl.directory_path = ? COLLATE NOCASE AND IFNULL(p.is_unlinked, 0) = 0
                UNION ALL
                SELECT p.id, NULL AS link_id, p.file_name, p.file_path, p.file_size,
                       p.date_taken, p.subsec_time, p.exposure_bias,
                       p.f_number, p.focal_length, p.shutter_speed, p.camera_model,
                       p.stack_id, p.is_stack_primary, p.stack_type, p.paired_raw_path,
                       p.is_raw, p.raw_format, p.volume_serial
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
                    try:
                        from ..scanner import resolve_portable_path
                    except Exception:
                        resolve_portable_path = None
                    for p in photos:
                        if str(p["file_path"]).startswith("vsn://"):
                            if resolve_portable_path and p.get("volume_serial"):
                                res_p, is_on = resolve_portable_path(p["file_path"], expected_serial=p.get("volume_serial"))
                                p["is_online"] = bool(is_on and res_p.exists())
                            else:
                                p["is_online"] = False
                        elif resolve_portable_path and p.get("volume_serial"):
                            res_p, is_on = resolve_portable_path(p["file_path"], expected_serial=p.get("volume_serial"))
                            p["is_online"] = bool(is_on and res_p.exists())
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

                            # 代表写真の選定: ブラケットなら±0に最も近いもの、連写なら1枚目（必ず実在する写真から選出）
                            if is_bracket:
                                best_rep = min(online_reps, key=lambda p: abs(p.get("exposure_bias") or 0.0))
                                primary_id = best_rep["id"]
                            else:
                                primary_id = online_reps[0]["id"]

                            stack_id = primary_id

                            # グループ内の代表写真およびその全付随RAWをスタック化
                            for rep in group:
                                is_pri = 1 if rep["id"] == primary_id else 0
                                queue_update(rep["id"], stack_id, is_pri, stack_type, rep.get("paired_raw_path"))
                                for raw_it in rep.get("attached_raws", []):
                                    queue_update(raw_it["id"], stack_id, 0, stack_type, raw_it.get("paired_raw_path"))

                            total_stacks_created += 1

                        elif len(online_reps) == 1:
                            # 実在する写真が1枚だけ残っている場合:
                            # 物理削除により連写/ブラケットが解消されたため、スタックを解除して単独写真（代表）として表示
                            survivor = online_reps[0]
                            queue_update(survivor["id"], None, 1, None, survivor.get("paired_raw_path"))
                            # survivorに付随する実在RAWがあれば、正規のペアとして紐付け
                            for raw_it in survivor.get("attached_raws", []):
                                queue_update(raw_it["id"], None, 1, None, survivor["_clean_file_path"])

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
                                best_rep = min(group, key=lambda p: abs(p.get("exposure_bias") or 0.0))
                                primary_id = best_rep["id"]
                            else:
                                primary_id = group[0]["id"]

                            stack_id = primary_id
                            for rep in group:
                                is_pri = 1 if rep["id"] == primary_id else 0
                                queue_update(rep["id"], stack_id, is_pri, stack_type, rep.get("paired_raw_path"))
                                for raw_it in rep.get("attached_raws", []):
                                    queue_update(raw_it["id"], stack_id, 0, stack_type, raw_it.get("paired_raw_path"))

                        i = j

                    # ブラケット/連写ではないが、RAW+JPEGペアが存在する場合
                    # → スタック化はせず、paired_raw_path の紐付けのみ行う
                    #   （右ペインで「RAWあり」表示 + 「RAWを開く」ボタンで対応）
                    elif group[0].get("has_pair") or group[0].get("attached_raws"):
                        rep = group[0]
                        queue_update(rep["id"], None, 1, None, rep.get("paired_raw_path"))
                        for raw_it in rep.get("attached_raws", []):
                            queue_update(raw_it["id"], None, 1, None, rep["_clean_file_path"])
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

        # ============================================================
        # 第2パス: クロスフォルダ RAW+JPEG ペアリング
        # ディレクトリ内ペアリングでマッチしなかった未ペアRAWに対して、
        # 全スキャン済みフォルダを横断してステム名+撮影日時で対応するJPEGを探す。
        # （例: 112_PANA/ にJPEG、112_PANA RAW/ にRAW が別管理されるケース）
        # ※ 別SDカード（異なる volume_serial）の同名ファイルとはペアリングしない。
        # ============================================================
        cursor.execute(
            """
            SELECT id, file_name, file_path, date_taken, volume_serial
            FROM photos
            WHERE is_raw = 1 AND paired_raw_path IS NULL AND IFNULL(is_unlinked, 0) = 0
            """
        )
        unpaired_raws = [dict(r) for r in cursor.fetchall()]

        if unpaired_raws:
            # 全非RAW写真のステム名→写真リスト マップを構築（1回のクエリで完了）
            cursor.execute(
                """
                SELECT id, file_name, file_path, date_taken, volume_serial
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
            for raw_photo in unpaired_raws:
                raw_stem = Path(raw_photo["file_name"]).stem.lower()
                raw_date = raw_photo.get("date_taken")
                raw_vsn = (raw_photo.get("volume_serial") or "").strip().upper()

                all_candidates = jpeg_stem_map.get(raw_stem, [])
                if not all_candidates:
                    continue

                # 同一ボリューム（または両方 volume_serial 未設定）の候補のみに限定
                candidates = [
                    c for c in all_candidates
                    if (c.get("volume_serial") or "").strip().upper() == raw_vsn
                ]
                if not candidates:
                    continue

                # 撮影日時が一致する候補を優先（誤マッチ防止）
                matched = None
                if raw_date:
                    for cand in candidates:
                        if cand.get("date_taken") == raw_date:
                            matched = cand
                            break

                # 日時マッチがなければ候補が1件のみの場合に限り採用
                if not matched and len(candidates) == 1:
                    matched = candidates[0]

                if matched:
                    raw_clean_fp = _strip_vsn_prefix_raw(raw_photo["file_path"])
                    jpeg_clean_fp = _strip_vsn_prefix_raw(matched["file_path"])
                    # JPEG側: paired_raw_path にRAWのパスを設定
                    cross_pair_updates.append((raw_clean_fp, matched["id"]))
                    # RAW側: paired_raw_path にJPEGのパスを設定
                    cross_pair_updates.append((jpeg_clean_fp, raw_photo["id"]))
                    # マッチ済みJPEGを候補から除外（1対1マッチング）
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

        conn.commit()

        # ============================================================
        # 第3パス: 重複写真（同一画像）のクロスフォルダ スタック化
        # 複数フォルダに存在する同一画像をスマート品質スコアで代表選定し、
        # stack_type = 'duplicate' としてグループ化する。
        # ============================================================
        dup_count = recalculate_duplicate_stacks()
        total_stacks_created += dup_count

        return total_stacks_created


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
        dup_stacks_created = 0

        for g in dup_groups:
            dt = g["date_taken"]
            sz = g["file_size"]

            cursor.execute(
                """
                SELECT id, file_name, file_path, file_size, width, height,
                       date_taken, camera_model, lens_model, f_number, shutter_speed, iso,
                       exposure_bias, latitude, longitude, is_raw,
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

            # 最高スコアを算出
            max_score = max(m["_score"] for m in eligible_members)

            # 既存代表の優先維持:
            # すでに代表（is_stack_primary = 1 かつ stack_type = 'duplicate'）として設定されているメンバーが存在し、
            # かつそのスコアが最高スコア（同点・実質差なし）である場合は、既存代表を尊重して維持する
            # （リフレッシュ時にユーザーの手動代表選択がID順で勝手に戻る現象を防止）
            existing_primary = next(
                (m for m in eligible_members if m.get("is_stack_primary") == 1 and m.get("stack_type") == "duplicate"),
                None
            )
            if existing_primary and existing_primary["_score"] >= max_score - 1e-4:
                primary_id = existing_primary["id"]
            else:
                # 新規追加や品質差がある場合は、スコア降順（同点ならID昇順）で最高品質を代表に選出
                eligible_members.sort(key=lambda x: (x["_score"], -x["id"]), reverse=True)
                primary_id = eligible_members[0]["id"]

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

        conn.commit()
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
        return True
