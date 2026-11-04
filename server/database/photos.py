"""
写真 CRUD 管理モジュール
写真メタデータの登録・検索・更新・削除、GPS操作、同期・クリーンアップを提供する。
"""

import bisect
from datetime import datetime, timedelta
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .connection import calc_solar_altitude, get_connection
from .lab_analytics import (
    _SHUTTER_SECONDS_SQL,
    _get_jp_prefecture_aliases,
    _normalize_jp_prefecture,
    get_lab_karte_data,
    get_location_heatmap_data,
    get_random_unrated_folder,
)

logger = logging.getLogger(__name__)


def _strip_vsn_prefix_raw(path_str: Optional[str]) -> str:
    """DB内部のVSN退避プレフィックス (vsn://<SERIAL>/<PATH>) を除去して元のWindowsパスを返す"""
    if path_str and path_str.startswith("vsn://"):
        parts = path_str.split("/", 3)
        if len(parts) == 4:
            return parts[3]
    return path_str or ""


def _drive_relative_tail(path_str: Optional[str]) -> str:
    """ドライブレターを除いたドライブ内相対パス（例: \DCIM\100MSDCF\DSC00001.JPG）を返す"""
    clean = _strip_vsn_prefix_raw(path_str).replace("/", "\\")
    if len(clean) >= 2 and clean[1] == ":":
        return clean[2:]
    return ""


def _is_same_photo_metadata(a: Any, b: Any) -> bool:
    """2つの写真メタデータが同一秒・同一サイズの別コマ（連写・ブラケット）ではなく同一画像であるか判定する"""
    sub_a = str(a["subsec_time"] if "subsec_time" in a.keys() and a["subsec_time"] is not None else "").strip()
    sub_b = str(b.get("subsec_time") or "").strip() if isinstance(b, dict) else str(b["subsec_time"] or "").strip()
    if sub_a and sub_b and sub_a != sub_b:
        return False
    ss_a = str(a["shutter_speed"] if "shutter_speed" in a.keys() and a["shutter_speed"] is not None else "").strip()
    ss_b = str(b.get("shutter_speed") or "").strip() if isinstance(b, dict) else str(b["shutter_speed"] or "").strip()
    if ss_a and ss_b and ss_a != ss_b:
        return False
    ev_a = a["exposure_bias"] if "exposure_bias" in a.keys() else None
    ev_b = b.get("exposure_bias") if isinstance(b, dict) else (b["exposure_bias"] if "exposure_bias" in b.keys() else None)
    if ev_a is not None and ev_b is not None:
        try:
            if abs(float(ev_a) - float(ev_b)) > 0.05:
                return False
        except (ValueError, TypeError):
            pass
    return True


def _compute_content_key(meta: Dict[str, Any]) -> Optional[str]:
    """写真メタデータから不変の同一画像識別キー (content_key) を生成する"""
    fsize = int(meta.get("file_size") or 0)
    if fsize <= 0:
        return None
    is_raw_flag = 1 if int(meta.get("is_raw") or 0) == 1 else 0
    dt_raw = str(meta.get("original_date_taken") or meta.get("date_taken") or "").strip()
    if dt_raw:
        dt_norm = dt_raw.replace(":", "-", 2)[:19]
        extra_parts = []
        subsec = str(meta.get("subsec_time") or "").strip()
        if subsec:
            extra_parts.append(f"ss:{subsec}")
        shutter = str(meta.get("shutter_speed") or "").strip()
        if shutter:
            extra_parts.append(f"tv:{shutter}")
        fnum = meta.get("f_number")
        if fnum is not None and str(fnum).strip() != "":
            try:
                extra_parts.append(f"av:{float(fnum):.2f}")
            except (ValueError, TypeError):
                extra_parts.append(f"av:{fnum}")
        iso_val = meta.get("iso")
        if iso_val is not None and str(iso_val).strip() != "":
            extra_parts.append(f"iso:{iso_val}")
        ev_val = meta.get("exposure_bias")
        if ev_val is not None and str(ev_val).strip() != "":
            try:
                ev_f = round(float(ev_val), 2)
                if abs(ev_f) > 1e-4:
                    extra_parts.append(f"ev:{ev_f:+.2f}")
            except (ValueError, TypeError):
                pass
        suffix = ("|" + "|".join(extra_parts)) if extra_parts else ""
        return f"dt:{dt_norm}|sz:{fsize}|raw:{is_raw_flag}{suffix}"
    fname = str(meta.get("file_name") or "").strip().lower()
    if fname:
        w = int(meta.get("width") or 0)
        h = int(meta.get("height") or 0)
        return f"fn:{fname}|sz:{fsize}|wh:{w}x{h}|raw:{is_raw_flag}"
    return None


def _split_link_path(
    file_path: Optional[str],
    directory_path: Optional[str] = None,
    volume_serial: Optional[str] = None,
) -> Tuple[str, str, str, str, str]:
    """
    ファイルパス・ディレクトリパス・VSNから photo_links テーブル用の
    (vsn_norm, rel_path, rel_dir, clean_fp, clean_dir) を算出する。
    """
    clean_fp = _strip_vsn_prefix_raw(file_path).replace("/", "\\")
    raw_dir = directory_path if directory_path is not None else os.path.dirname(clean_fp)
    clean_dir = _strip_vsn_prefix_raw(raw_dir).rstrip("\\/").replace("/", "\\")
    vsn_norm = (volume_serial or "").strip().upper()
    if vsn_norm and len(clean_fp) >= 2 and clean_fp[1] == ":":
        rel_path = clean_fp[2:]
        rel_dir = clean_dir[2:] if (len(clean_dir) >= 2 and clean_dir[1] == ":") else clean_dir
    else:
        rel_path = clean_fp
        rel_dir = clean_dir
    return vsn_norm, rel_path, rel_dir, clean_fp, clean_dir


def _sync_photo_links_state(
    cursor: Any,
    photo_id: int,
    preferred_link_id: Optional[int] = None,
) -> int:
    """
    指定 photo_id に紐づく photo_links を集計し、photos テーブルの代表パス・link_count・is_unlinked を同期する。
    残りリンクが0本になった場合は最後のパス情報を維持したまま link_count=0, is_unlinked=1 に移行する。
    """
    cursor.execute(
        "SELECT * FROM photo_links WHERE photo_id = ? ORDER BY is_primary DESC, id ASC",
        (photo_id,),
    )
    links = cursor.fetchall()
    if not links:
        cursor.execute(
            """
            UPDATE photos
            SET link_count = 0,
                is_unlinked = 1,
                volume_serial = NULL,
                stack_id = NULL,
                is_stack_primary = 1,
                stack_type = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (photo_id,),
        )
        return 0

    link_count = len(links)
    rep = None
    if preferred_link_id is not None:
        for lk in links:
            if lk["id"] == preferred_link_id:
                rep = lk
                break
    if rep is None:
        rep = links[0]

    rep_id = rep["id"]
    cursor.execute(
        "UPDATE photo_links SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE photo_id = ?",
        (rep_id, photo_id),
    )

    rep_vsn = rep["volume_serial"] or None
    rep_paired = rep["paired_raw_path"]
    cursor.execute(
        """
        UPDATE photos
        SET file_path = ?,
            directory_path = ?,
            file_name = ?,
            volume_serial = ?,
            file_mtime = COALESCE(?, file_mtime),
            paired_raw_path = ?,
            link_count = ?,
            is_unlinked = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            rep["file_path"],
            rep["directory_path"],
            rep["file_name"],
            rep_vsn,
            rep["file_mtime"],
            rep_paired,
            link_count,
            photo_id,
        ),
    )
    return link_count


def _directory_filter_sql(folder: str, recursive: bool = True, column_name: str = "directory_path") -> Tuple[str, List[Any]]:
    """
    指定ディレクトリ（および配下サブディレクトリ）の絞り込みSQLフラグメントとパラメータを生成する。
    LIKE による大文字小文字インデックス不適用およびワイルドカード（_）誤一致を防止するため、
    COLLATE NOCASE と文字コード範囲比較（'\\' の次は ']'、'/' の次は '0'）を使用する。
    """
    norm = folder.rstrip("\\/")
    norm_win = norm.replace("/", "\\")
    norm_posix = norm.replace("\\", "/")

    if not recursive:
        sql = (
            f"({column_name} = ? COLLATE NOCASE OR {column_name} = ? COLLATE NOCASE"
            f" OR {column_name} = ? COLLATE NOCASE)"
        )
        return sql, [norm_win, norm_posix, norm_win + "\\"]

    sql = (
        f"({column_name} = ? COLLATE NOCASE"
        f" OR {column_name} = ? COLLATE NOCASE"
        f" OR ({column_name} >= ? COLLATE NOCASE AND {column_name} < ? COLLATE NOCASE)"
        f" OR ({column_name} >= ? COLLATE NOCASE AND {column_name} < ? COLLATE NOCASE))"
    )
    params = [
        norm_win,
        norm_posix,
        norm_win + "\\",
        norm_win + "]",
        norm_posix + "/",
        norm_posix + "0",
    ]
    return sql, params


def _vsn_in_sql(vsn_column: str, volume_serial: str) -> Tuple[str, List[str]]:
    """インデックスを効かせつつ VSN の大文字・小文字表記揺れを吸収する IN 句を生成する"""
    vs = (volume_serial or "").strip()
    variants = list(dict.fromkeys([vs, vs.upper(), vs.lower()]))
    if len(variants) == 1:
        return f"{vsn_column} = ?", variants
    ph = ",".join(["?"] * len(variants))
    return f"{vsn_column} IN ({ph})", variants


def _directory_filter_sql_with_vsn(
    folder: str,
    volume_serial: Optional[str],
    recursive: bool = True,
    column_name: str = "directory_path",
    vsn_column: str = "volume_serial",
) -> Tuple[str, List[Any]]:
    """
    ディレクトリ絞り込みSQLを生成する。
    volume_serial が指定されドライブ文字パス（例: F:\DCIM）である場合、
    前回別ドライブ文字（例: E:\DCIM）でスキャンされた同一VSNの写真もドライブ相対パス一致でヒットさせる。
    """
    base_sql, base_params = _directory_filter_sql(folder, recursive=recursive, column_name=column_name)
    vs = (volume_serial or "").strip()
    norm = folder.rstrip("\\/").replace("/", "\\")
    if not vs or len(norm) < 2 or norm[1] != ":":
        return base_sql, base_params

    tail_win = norm[2:]
    tail_posix = tail_win.replace("\\", "/")
    vsn_sql, vsn_params = _vsn_in_sql(vsn_column, vs)

    if not tail_win:
        sql = f"({base_sql} OR ({vsn_sql} AND {column_name} LIKE '_:%'))"
        return sql, base_params + vsn_params

    sub_col = f"SUBSTR({column_name}, 3)"
    if not recursive:
        rel_sql = f"({sub_col} = ? COLLATE NOCASE OR {sub_col} = ? COLLATE NOCASE OR {sub_col} = ? COLLATE NOCASE)"
        rel_params = [tail_win, tail_posix, tail_win + "\\"]
    else:
        rel_sql = (
            f"({sub_col} = ? COLLATE NOCASE"
            f" OR {sub_col} = ? COLLATE NOCASE"
            f" OR ({sub_col} >= ? COLLATE NOCASE AND {sub_col} < ? COLLATE NOCASE)"
            f" OR ({sub_col} >= ? COLLATE NOCASE AND {sub_col} < ? COLLATE NOCASE))"
        )
        rel_params = [
            tail_win,
            tail_posix,
            tail_win + "\\",
            tail_win + "]",
            tail_posix + "/",
            tail_posix + "0",
        ]

    sql = f"({base_sql} OR ({vsn_sql} AND {column_name} LIKE '_:%' AND {rel_sql}))"
    return sql, base_params + vsn_params + rel_params


def _build_folder_missing_filter(
    directory_path: str,
    recursive: bool = False,
    volume_serial: Optional[str] = None,
    column_name: str = "directory_path",
    vsn_column: str = "volume_serial",
) -> Tuple[str, List[Any]]:
    """ドライブレター変動時にも同一VSN・相対パスのレコードを抽出できるフォルダ絞り込みSQLを返す"""
    eff_serial = (volume_serial or "").strip()
    if not eff_serial:
        try:
            from ..volume_info import get_volume_info
            vi = get_volume_info(directory_path)
            if vi and vi.get("serial"):
                eff_serial = str(vi["serial"]).strip()
        except Exception:
            eff_serial = ""
    return _directory_filter_sql_with_vsn(
        directory_path,
        eff_serial or None,
        recursive=recursive,
        column_name=column_name,
        vsn_column=vsn_column,
    )


def _sanitize_photo_data(photo_data: Dict[str, Any]) -> Dict[str, Any]:
    """写真メタデータのデフォルト値補完とサニタイズ（NUL文字除去等）を行う共通関数"""
    clean_data = dict(photo_data)
    clean_data.setdefault("file_size", 0)
    clean_data.setdefault("file_mtime", None)
    clean_data.setdefault("width", None)
    clean_data.setdefault("height", None)
    clean_data.setdefault("date_taken", None)
    if "year_month" not in clean_data or clean_data["year_month"] is None:
        dt = clean_data.get("date_taken")
        if dt and len(str(dt)) >= 7:
            clean_data["year_month"] = str(dt)[:7].replace(":", "-")
        else:
            clean_data["year_month"] = None
    clean_data.setdefault("exposure_bias", 0.0)
    clean_data.setdefault("shutter_speed", None)
    clean_data.setdefault("f_number", None)
    clean_data.setdefault("iso", None)
    clean_data.setdefault("focal_length", None)
    clean_data.setdefault("lens_model", None)
    clean_data.setdefault("subsec_time", None)
    clean_data.setdefault("is_raw", 0)
    clean_data.setdefault("raw_format", None)
    clean_data.setdefault("paired_raw_path", None)
    clean_data.setdefault("volume_serial", None)
    clean_data.setdefault("latitude", None)
    clean_data.setdefault("longitude", None)
    clean_data.setdefault("gps_source", None)
    clean_data.setdefault("country", None)
    clean_data.setdefault("state", None)
    clean_data.setdefault("city", None)
    clean_data.setdefault("rotation", 0)
    clean_data.setdefault("fine_angle", 0.0)
    clean_data.setdefault("crop_x", None)
    clean_data.setdefault("crop_y", None)
    clean_data.setdefault("crop_w", None)
    clean_data.setdefault("crop_h", None)
    clean_data.setdefault("crop_aspect", None)
    clean_data.setdefault("brightness", 0)
    clean_data.setdefault("contrast", 0)
    clean_data.setdefault("saturation", 0)
    clean_data.setdefault("original_date_taken", None)
    clean_data.setdefault("rating", 0)

    cam = clean_data.get("camera_model")
    if cam:
        cleaned_cam = str(cam).replace("\x00", "").strip()
        clean_data["camera_model"] = cleaned_cam if cleaned_cam else "不明"
    else:
        clean_data["camera_model"] = "不明"

    lens = clean_data.get("lens_model")
    if lens:
        cleaned_lens = str(lens).replace("\x00", "").strip()
        clean_data["lens_model"] = cleaned_lens if cleaned_lens else None
    else:
        clean_data["lens_model"] = None

    return clean_data


def _upsert_single_photo_in_tx(cursor: Any, clean_data: Dict[str, Any]) -> int:
    """
    1トランザクション内で写真エンティティ (photos) と所在リンク (photo_links) を挿入・更新する。
    - 同一リンク (volume_serial, rel_path) が既にあれば更新
    - 同一画像 (content_key 一致) の既存 photos があればその photo_id に新規リンクを追加（リンク消失状態からの自動復活・評価や調整値の100%共有）
    - いずれも無ければ新規 photos と photo_links を作成
    """
    vsn_norm, rel_path, rel_dir, clean_fp, clean_dir = _split_link_path(
        clean_data.get("file_path"),
        clean_data.get("directory_path"),
        clean_data.get("volume_serial"),
    )
    fname = clean_data.get("file_name") or os.path.basename(clean_fp)
    clean_data["file_path"] = clean_fp
    clean_data["directory_path"] = clean_dir
    clean_data["file_name"] = fname
    clean_data["volume_serial"] = vsn_norm or None
    ckey = _compute_content_key(clean_data)
    clean_data["content_key"] = ckey

    # 1. 既存リンク (photo_links) の探索
    cursor.execute(
        "SELECT * FROM photo_links WHERE volume_serial = ? AND rel_path = ? COLLATE NOCASE",
        (vsn_norm, rel_path),
    )
    link_row = cursor.fetchone()
    if not link_row and vsn_norm != "":
        cursor.execute(
            "SELECT * FROM photo_links WHERE volume_serial = '' AND file_path = ? COLLATE NOCASE",
            (clean_fp,),
        )
        link_row = cursor.fetchone()
    elif not link_row and vsn_norm == "":
        cursor.execute(
            """
            SELECT pl.*, p.content_key AS p_ckey
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            WHERE pl.file_path = ? COLLATE NOCASE
            ORDER BY pl.is_primary DESC, pl.id ASC
            """,
            (clean_fp,),
        )
        for cand in cursor.fetchall():
            if not ckey or not cand["p_ckey"] or cand["p_ckey"] == ckey:
                link_row = cand
                break

    if link_row:
        pid = int(link_row["photo_id"])
        cursor.execute("SELECT * FROM photos WHERE id = ?", (pid,))
        p_row = cursor.fetchone()
        if p_row:
            old_ckey = p_row["content_key"]
            if old_ckey and ckey and old_ckey != ckey and int(p_row["link_count"] or 1) > 1:
                # 他メディアに別リンクが残っている状態で、このパスだけ別画像に書き換わった場合は旧リンクを切り離す
                cursor.execute("DELETE FROM photo_links WHERE id = ?", (link_row["id"],))
                _sync_photo_links_state(cursor, pid)
                link_row = None
            else:
                eff_vsn = vsn_norm or (link_row["volume_serial"] or "")
                eff_vsn, eff_rel_path, eff_rel_dir, _, _ = _split_link_path(clean_fp, clean_dir, eff_vsn)
                eff_paired = (
                    clean_data.get("paired_raw_path")
                    if clean_data.get("paired_raw_path") is not None
                    else link_row["paired_raw_path"]
                )
                if eff_paired and len(clean_fp) >= 2 and clean_fp[1] == ":":
                    p_tail = _drive_relative_tail(eff_paired)
                    if p_tail:
                        eff_paired = clean_fp[:2] + p_tail

                cursor.execute(
                    """
                    UPDATE photo_links
                    SET volume_serial = ?,
                        rel_path = ?,
                        rel_dir = ?,
                        file_path = ?,
                        directory_path = ?,
                        file_name = ?,
                        file_mtime = COALESCE(?, file_mtime),
                        paired_raw_path = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (
                        eff_vsn,
                        eff_rel_path,
                        eff_rel_dir,
                        clean_fp,
                        clean_dir,
                        fname,
                        clean_data.get("file_mtime"),
                        eff_paired,
                        link_row["id"],
                    ),
                )
                cursor.execute(
                    """
                    UPDATE photos
                    SET file_size = :file_size,
                        file_mtime = COALESCE(:file_mtime, photos.file_mtime),
                        width = COALESCE(:width, photos.width),
                        height = COALESCE(:height, photos.height),
                        date_taken = CASE WHEN photos.original_date_taken IS NOT NULL AND photos.original_date_taken != '' THEN photos.date_taken ELSE COALESCE(:date_taken, photos.date_taken) END,
                        year_month = CASE WHEN photos.original_date_taken IS NOT NULL AND photos.original_date_taken != '' THEN photos.year_month ELSE COALESCE(:year_month, photos.year_month) END,
                        camera_model = CASE WHEN :camera_model != '不明' THEN :camera_model ELSE COALESCE(photos.camera_model, '不明') END,
                        exposure_bias = COALESCE(:exposure_bias, photos.exposure_bias),
                        shutter_speed = COALESCE(:shutter_speed, photos.shutter_speed),
                        f_number = COALESCE(:f_number, photos.f_number),
                        iso = COALESCE(:iso, photos.iso),
                        focal_length = COALESCE(:focal_length, photos.focal_length),
                        lens_model = COALESCE(:lens_model, photos.lens_model),
                        subsec_time = COALESCE(:subsec_time, photos.subsec_time),
                        is_raw = COALESCE(:is_raw, photos.is_raw),
                        raw_format = COALESCE(:raw_format, photos.raw_format),
                        latitude = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.latitude ELSE COALESCE(:latitude, photos.latitude) END,
                        longitude = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.longitude ELSE COALESCE(:longitude, photos.longitude) END,
                        gps_source = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.gps_source ELSE COALESCE(:gps_source, photos.gps_source) END,
                        country = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.country ELSE COALESCE(:country, photos.country) END,
                        state = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.state ELSE COALESCE(:state, photos.state) END,
                        city = CASE WHEN photos.gps_source IN ('copied', 'manual', 'inferred') THEN photos.city ELSE COALESCE(:city, photos.city) END,
                        content_key = COALESCE(photos.content_key, :content_key),
                        is_unlinked = 0,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = :target_id
                    """,
                    {**clean_data, "target_id": pid},
                )
                _sync_photo_links_state(cursor, pid, preferred_link_id=link_row["id"])
                return pid
        else:
            cursor.execute("DELETE FROM photo_links WHERE id = ?", (link_row["id"],))
            link_row = None

    # 2. 同一画像 (content_key 一致) の既存 photos エンティティを探索
    target_photo = None
    if ckey:
        cursor.execute(
            """
            SELECT * FROM photos
            WHERE content_key = ?
            ORDER BY COALESCE(is_unlinked, 0) ASC,
                     (CASE WHEN rating != 0 OR is_favorite != 0 THEN 1 ELSE 0 END) DESC,
                     id ASC
            LIMIT 1
            """,
            (ckey,),
        )
        target_photo = cursor.fetchone()

    if not target_photo and clean_data.get("date_taken") and int(clean_data.get("file_size") or 0) > 0:
        dt_val = clean_data["date_taken"]
        fsize = int(clean_data["file_size"])
        is_raw_val = 1 if int(clean_data.get("is_raw") or 0) == 1 else 0
        cursor.execute(
            """
            SELECT * FROM photos
            WHERE file_size = ? AND COALESCE(is_raw, 0) = ?
              AND (date_taken = ? OR original_date_taken = ?)
            ORDER BY COALESCE(is_unlinked, 0) ASC,
                     (CASE WHEN rating != 0 OR is_favorite != 0 THEN 1 ELSE 0 END) DESC,
                     id ASC
            """,
            (fsize, is_raw_val, dt_val, dt_val),
        )
        for cand in cursor.fetchall():
            if _is_same_photo_metadata(cand, clean_data):
                target_photo = cand
                break

    if target_photo:
        pid = int(target_photo["id"])
        cursor.execute("SELECT id, directory_path, file_path, volume_serial FROM photo_links WHERE photo_id = ?", (pid,))
        existing_links = cursor.fetchall()

        # もし既存リンクの中に「オンラインドライブ上なのに実ファイルが既に消失している移動元リンク」があれば自動整理する
        # （ただし実ファイルシステムに存在しないテスト用パス等はオンライン消失と誤判定されないよう実在確認）
        dead_link_ids = []
        if existing_links and os.path.exists(clean_fp):
            try:
                from ..scanner import resolve_portable_path
                for ex_lk in existing_links:
                    ex_dir = ex_lk["directory_path"]
                    ex_vsn = ex_lk["volume_serial"] or None
                    res_dir, is_dir_online = resolve_portable_path(ex_dir, expected_serial=ex_vsn)
                    if is_dir_online and res_dir and os.path.isdir(str(res_dir)):
                        res_fp, _ = resolve_portable_path(ex_lk["file_path"], expected_serial=ex_vsn)
                        if not os.path.exists(str(res_fp)):
                            dead_link_ids.append(ex_lk["id"])
            except Exception:
                pass
        if dead_link_ids:
            ph = ",".join(["?"] * len(dead_link_ids))
            cursor.execute(f"DELETE FROM photo_links WHERE id IN ({ph})", dead_link_ids)
            existing_links = [lk for lk in existing_links if lk["id"] not in dead_link_ids]

        has_existing_links = len(existing_links) > 0
        is_prim = 0 if has_existing_links else 1

        cursor.execute(
            """
            INSERT INTO photo_links (
                photo_id, volume_serial, rel_path, rel_dir,
                file_path, directory_path, file_name, file_mtime, paired_raw_path, is_primary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(volume_serial, rel_path) DO UPDATE SET
                photo_id = excluded.photo_id,
                rel_dir = excluded.rel_dir,
                file_path = excluded.file_path,
                directory_path = excluded.directory_path,
                file_name = excluded.file_name,
                file_mtime = COALESCE(excluded.file_mtime, photo_links.file_mtime),
                paired_raw_path = COALESCE(excluded.paired_raw_path, photo_links.paired_raw_path),
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                pid,
                vsn_norm,
                rel_path,
                rel_dir,
                clean_fp,
                clean_dir,
                fname,
                clean_data.get("file_mtime"),
                clean_data.get("paired_raw_path"),
                is_prim,
            ),
        )
        new_link_id = cursor.lastrowid

        # 既存写真レコードの未設定EXIF・GPS等を非破壊で補完
        cursor.execute(
            """
            UPDATE photos
            SET width = COALESCE(photos.width, :width),
                height = COALESCE(photos.height, :height),
                camera_model = CASE WHEN photos.camera_model IS NULL OR photos.camera_model = '不明' THEN :camera_model ELSE photos.camera_model END,
                exposure_bias = COALESCE(photos.exposure_bias, :exposure_bias),
                shutter_speed = COALESCE(photos.shutter_speed, :shutter_speed),
                f_number = COALESCE(photos.f_number, :f_number),
                iso = COALESCE(photos.iso, :iso),
                focal_length = COALESCE(photos.focal_length, :focal_length),
                lens_model = COALESCE(photos.lens_model, :lens_model),
                subsec_time = COALESCE(photos.subsec_time, :subsec_time),
                raw_format = COALESCE(photos.raw_format, :raw_format),
                latitude = COALESCE(photos.latitude, :latitude),
                longitude = COALESCE(photos.longitude, :longitude),
                gps_source = COALESCE(photos.gps_source, :gps_source),
                country = COALESCE(photos.country, :country),
                state = COALESCE(photos.state, :state),
                city = COALESCE(photos.city, :city),
                content_key = COALESCE(photos.content_key, :content_key),
                is_unlinked = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = :target_id
            """,
            {**clean_data, "target_id": pid},
        )

        # もし元レコードがRAW+JPEGペアの片割れ（paired_raw_path あり）で、ペア相手側に評価やタグがある場合は引き継ぐ
        paired_p = target_photo["paired_raw_path"]
        if paired_p:
            cursor.execute("SELECT id FROM photos WHERE file_path = ? AND id != ? LIMIT 1", (paired_p, pid))
            pair_row = cursor.fetchone()
            if pair_row:
                from .duplicates import copy_metadata_to_duplicate
                copy_metadata_to_duplicate(pair_row["id"], pid, cursor=cursor)

        _sync_photo_links_state(cursor, pid, preferred_link_id=(new_link_id if not has_existing_links else None))
        return pid

    # 3. 完全新規のユニーク写真として photos と photo_links に登録
    cursor.execute(
        """
        INSERT INTO photos (
            file_path, file_name, directory_path, file_size, file_mtime,
            width, height, date_taken, year_month, camera_model, rating,
            exposure_bias, shutter_speed, f_number, iso, focal_length, lens_model, subsec_time,
            is_raw, raw_format, paired_raw_path, volume_serial,
            latitude, longitude, gps_source, country, state, city,
            content_key, link_count, is_unlinked
        ) VALUES (
            :file_path, :file_name, :directory_path, :file_size, :file_mtime,
            :width, :height, :date_taken, :year_month, :camera_model, :rating,
            :exposure_bias, :shutter_speed, :f_number, :iso, :focal_length, :lens_model, :subsec_time,
            :is_raw, :raw_format, :paired_raw_path, :volume_serial,
            :latitude, :longitude, :gps_source, :country, :state, :city,
            :content_key, 1, 0
        )
        """,
        clean_data,
    )
    pid = int(cursor.lastrowid or 0)
    cursor.execute(
        """
        INSERT INTO photo_links (
            photo_id, volume_serial, rel_path, rel_dir,
            file_path, directory_path, file_name, file_mtime, paired_raw_path, is_primary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(volume_serial, rel_path) DO UPDATE SET
            photo_id = excluded.photo_id,
            rel_dir = excluded.rel_dir,
            file_path = excluded.file_path,
            directory_path = excluded.directory_path,
            file_name = excluded.file_name,
            file_mtime = COALESCE(excluded.file_mtime, photo_links.file_mtime),
            paired_raw_path = COALESCE(excluded.paired_raw_path, photo_links.paired_raw_path),
            is_primary = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            pid,
            vsn_norm,
            rel_path,
            rel_dir,
            clean_fp,
            clean_dir,
            fname,
            clean_data.get("file_mtime"),
            clean_data.get("paired_raw_path"),
        ),
    )
    return pid


def upsert_photo(photo_data: Dict[str, Any]) -> int:
    """写真情報を挿入または更新する（photo_links による複数メディア統合＆ドライブレター追従対応）"""
    clean_data = _sanitize_photo_data(photo_data)
    with get_connection() as conn:
        cursor = conn.cursor()
        pid = _upsert_single_photo_in_tx(cursor, clean_data)
        conn.commit()
        return pid


def upsert_photos_batch(list_of_meta: List[Dict[str, Any]]) -> None:
    """複数の写真情報を1トランザクションで一括挿入または更新する（photo_links 統合対応）"""
    if not list_of_meta:
        return
    cleaned_batch = [_sanitize_photo_data(m) for m in list_of_meta]
    with get_connection() as conn:
        cursor = conn.cursor()
        for item in cleaned_batch:
            _upsert_single_photo_in_tx(cursor, item)
        conn.commit()


def _shutter_speed_seconds_sql(col: str = "p.shutter_speed") -> str:
    """シャッター速度文字列（分数 '1/250' または小数 '0.5' / '2.5s'）を露光秒数(REAL)に換算するSQL式を返す"""
    clean_col = f"TRIM(REPLACE({col}, 's', ''))"
    return f"""(CASE
        WHEN {col} IS NULL OR TRIM({col}) = '' THEN NULL
        WHEN INSTR({clean_col}, '/') > 0 THEN
            CASE
                WHEN CAST(SUBSTR({clean_col}, INSTR({clean_col}, '/') + 1) AS REAL) > 0
                THEN CAST(SUBSTR({clean_col}, 1, INSTR({clean_col}, '/') - 1) AS REAL)
                     / CAST(SUBSTR({clean_col}, INSTR({clean_col}, '/') + 1) AS REAL)
                ELSE NULL
            END
        ELSE CAST({clean_col} AS REAL)
    END)"""


def _has_xmp_sidecar_fast(
    file_path: Optional[str],
    paired_raw_path: Optional[str] = None,
    dir_file_set: Optional[set] = None,
    volume_serial: Optional[str] = None,
) -> bool:
    """指定写真（またはペアRAW）と同名の .xmp サイドカーファイルが存在するか高速判定する"""
    if not file_path:
        return False
    clean_fp = _strip_vsn_prefix_raw(file_path)
    fname = os.path.basename(clean_fp)
    stem, _ = os.path.splitext(fname)
    candidates = {
        f"{stem.lower()}.xmp",
        f"{fname.lower()}.xmp",
    }
    if paired_raw_path:
        raw_fname = os.path.basename(_strip_vsn_prefix_raw(paired_raw_path))
        raw_stem, _ = os.path.splitext(raw_fname)
        candidates.add(f"{raw_stem.lower()}.xmp")
        candidates.add(f"{raw_fname.lower()}.xmp")

    if dir_file_set is not None:
        return bool(candidates & dir_file_set)

    try:
        from ..scanner import resolve_portable_path
        real_p, is_online = resolve_portable_path(file_path, expected_serial=volume_serial)
        if not is_online:
            return False
        parent_dir = real_p.parent
        for cand in candidates:
            if (parent_dir / cand).exists():
                return True
    except Exception as e:
        logger.debug(f"XMPサイドカー存在確認スキップ ({file_path}): {e}")
    return False


def invalidate_fast_cache() -> None:
    """写真一覧キャッシュおよびフォルダ集計キャッシュを無効化する"""
    try:
        from .folders import clear_folders_fs_cache
        clear_folders_fs_cache()
    except Exception as e:
        logger.debug(f"キャッシュ無効化スキップ: {e}")


def get_photos(
    folder: Optional[str] = None,
    year_month: Optional[str] = None,
    year_months: Optional[List[str]] = None,
    dates: Optional[List[str]] = None,
    cameras: Optional[List[str]] = None,
    excluded_cameras: Optional[List[str]] = None,
    lenses: Optional[List[str]] = None,
    excluded_lenses: Optional[List[str]] = None,
    ratings: Optional[List[int]] = None,
    search: Optional[str] = None,
    included_tags: Optional[List[str]] = None,
    excluded_tags: Optional[List[str]] = None,
    untagged_only: bool = False,
    sort_by: str = "date_taken DESC",
    stacked: bool = True,
    limit: int = 0,
    exclude_folder: Optional[str] = None,
    unlinked_only: bool = False,
    include_unlinked: bool = False,
    duplicates_only: bool = False,
    country: Optional[str] = None,
    state: Optional[str] = None,
    city: Optional[str] = None,
    no_location_only: bool = False,
    lab_filter: Optional[str] = None,
    on_this_day: Optional[str] = None,
    focal_range: Optional[str] = None,
    aperture_range: Optional[str] = None,
    attr_filter: Optional[str] = None,
    tag_and_roots: Optional[List[str]] = None,
    tag_group_op: str = "and",
    volume_serial: Optional[str] = None,
    serial_mode: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """条件に合致する写真一覧を取得する（photo_links 対応：複数メディア間でユニーク写真を1行管理しつつ、フォルダ/メディア指定時は該当リンクのパスを返却）"""
    if ratings == [-1]:
        stacked = False
    if ratings is None:
        ratings = [0, 1, 2]
    query = """
        SELECT p.*,
               t.width AS thumb_width,
               t.height AS thumb_height,
               v.volume_label,
               COALESCE(v.custom_name, '') AS volume_custom_name,
               v.drive_letter AS volume_drive,
               CASE WHEN t.photo_id IS NOT NULL THEN 1 ELSE 0 END AS has_thumbnail,
               CASE WHEN COALESCE(p.link_count, 1) > 1 THEN p.link_count ELSE 1 END AS duplicate_count
        FROM photos p
        LEFT JOIN volumes v ON p.volume_serial = v.volume_serial AND COALESCE(p.is_unlinked, 0) = 0
        LEFT JOIN thumbnails t INDEXED BY idx_thumbnails_dims ON p.id = t.photo_id
        WHERE p.rating IN ({})
    """.format(','.join(['?'] * len(ratings)))
    params: List[Any] = list(ratings)

    # リンク消失写真（全メディアから実ファイルが消えた写真）の切り替え
    if unlinked_only:
        query += " AND p.is_unlinked = 1"
    else:
        s_mode_chk = (serial_mode or "").strip().lower()
        has_link_chk = bool(folder or (volume_serial and volume_serial.strip()) or s_mode_chk == "null")
        if not (include_unlinked and not has_link_chk and not duplicates_only):
            query += " AND (p.is_unlinked IS NULL OR p.is_unlinked = 0)"

    # 重複写真（複数メディア/複数フォルダにリンクを持つ写真）のみ
    if duplicates_only:
        query += " AND COALESCE(p.link_count, 1) > 1"

    # 場所（国・都道府県・市区町村）フィルタ
    if no_location_only:
        query += " AND (p.latitude IS NULL OR p.country IS NULL OR p.country = '' OR (ABS(p.latitude) < 0.0001 AND ABS(p.longitude) < 0.0001))"
    else:
        if country:
            if country in ("日本", "Japan", "JP"):
                query += " AND p.country IN ('日本', 'Japan', 'JP')"
            else:
                query += " AND p.country = ?"
                params.append(country)
        if state:
            aliases = _get_jp_prefecture_aliases(state)
            if aliases and len(aliases) > 1:
                placeholders = ",".join(["?"] * len(aliases))
                query += f" AND p.state IN ({placeholders})"
                params.extend(aliases)
            else:
                query += " AND p.state = ?"
                params.append(state)
        if city:
            query += " AND p.city = ?"
            params.append(city)

    s_mode = (serial_mode or "").strip().lower()
    has_link_filter = bool(folder or (volume_serial and volume_serial.strip()) or s_mode == "null")
    pl_filter_clauses: List[str] = []
    pl_filter_params: List[Any] = []

    if has_link_filter and not unlinked_only:
        if folder:
            dir_sql, dir_params = _directory_filter_sql_with_vsn(
                folder,
                volume_serial=volume_serial,
                recursive=True,
                column_name="pl.directory_path",
                vsn_column="pl.volume_serial",
            )
            pl_filter_clauses.append(dir_sql)
            pl_filter_params.extend(dir_params)

        if volume_serial and volume_serial.strip():
            vsn_sql, vsn_params = _vsn_in_sql("pl.volume_serial", volume_serial.strip())
            if s_mode == "match_or_null":
                pl_filter_clauses.append(f"({vsn_sql} OR pl.volume_serial = '')")
            else:
                pl_filter_clauses.append(vsn_sql)
            pl_filter_params.extend(vsn_params)
        elif s_mode == "null":
            pl_filter_clauses.append("pl.volume_serial = ''")

        pl_where_str = " AND ".join(pl_filter_clauses) if pl_filter_clauses else "1=1"
        query += (
            f" AND EXISTS ("
            f"SELECT 1 FROM photo_links pl "
            f"WHERE pl.photo_id = p.id AND {pl_where_str} "
            f"AND NOT (COALESCE(p.is_raw, 0) = 1 AND pl.paired_raw_path IS NOT NULL AND pl.paired_raw_path != '')"
            f")"
        )
        params.extend(pl_filter_params)
    else:
        if folder:
            dir_sql, dir_params = _directory_filter_sql_with_vsn(
                folder,
                volume_serial=volume_serial,
                recursive=True,
                column_name="p.directory_path",
                vsn_column="p.volume_serial",
            )
            query += f" AND {dir_sql}"
            params.extend(dir_params)

        if volume_serial and volume_serial.strip():
            vsn_sql, vsn_params = _vsn_in_sql("p.volume_serial", volume_serial.strip())
            if s_mode == "match_or_null":
                query += f" AND ({vsn_sql} OR p.volume_serial IS NULL)"
                params.extend(vsn_params)
            else:
                query += f" AND {vsn_sql}"
                params.extend(vsn_params)
        elif s_mode == "null":
            query += " AND p.volume_serial IS NULL"

        # 全体表示時は代表レコードの paired_raw_path でペア済みRAWを除外
        query += " AND NOT (p.is_raw = 1 AND p.paired_raw_path IS NOT NULL)"

    # フォルダ除外絞り込み（指定フォルダおよび配下を除外）
    if exclude_folder:
        ex_sql_p, ex_params_p = _directory_filter_sql_with_vsn(
            exclude_folder,
            volume_serial=volume_serial,
            recursive=True,
            column_name="p.directory_path",
            vsn_column="p.volume_serial",
        )
        ex_sql_pl, ex_params_pl = _directory_filter_sql_with_vsn(
            exclude_folder,
            volume_serial=volume_serial,
            recursive=True,
            column_name="pl_ex.directory_path",
            vsn_column="pl_ex.volume_serial",
        )
        if volume_serial and volume_serial.strip():
            vsn_ex_p, vsn_ex_params_p = _vsn_in_sql("p.volume_serial", volume_serial.strip())
            vsn_ex_pl, vsn_ex_params_pl = _vsn_in_sql("pl_ex.volume_serial", volume_serial.strip())
            query += (
                f" AND NOT ({ex_sql_p} AND {vsn_ex_p})"
                f" AND NOT EXISTS (SELECT 1 FROM photo_links pl_ex WHERE pl_ex.photo_id = p.id AND {ex_sql_pl} AND {vsn_ex_pl})"
            )
            params.extend(ex_params_p + vsn_ex_params_p + ex_params_pl + vsn_ex_params_pl)
        else:
            query += (
                f" AND NOT {ex_sql_p}"
                f" AND NOT EXISTS (SELECT 1 FROM photo_links pl_ex WHERE pl_ex.photo_id = p.id AND {ex_sql_pl})"
            )
            params.extend(ex_params_p + ex_params_pl)

    # タイムライン複数年月・複数日付フィルタ（同一タイムライン軸内でOR条件）
    target_yms = [ym.strip() for ym in (year_months or []) if ym and ym.strip()]
    if year_month and year_month.strip() and year_month.strip() not in target_yms:
        target_yms.append(year_month.strip())
    target_dates = [d.strip().replace(":", "-") for d in (dates or []) if d and d.strip()]

    timeline_or_clauses: List[str] = []
    timeline_or_params: List[Any] = []
    if target_yms:
        ym_placeholders = ",".join(["?"] * len(target_yms))
        timeline_or_clauses.append(f"p.year_month IN ({ym_placeholders})")
        timeline_or_params.extend(target_yms)
    if target_dates:
        date_placeholders = ",".join(["?"] * len(target_dates))
        timeline_or_clauses.append(
            f"(p.date_taken IS NOT NULL AND SUBSTR(REPLACE(p.date_taken, ':', '-'), 1, 10) IN ({date_placeholders}))"
        )
        timeline_or_params.extend(target_dates)

    if timeline_or_clauses:
        query += f" AND ({' OR '.join(timeline_or_clauses)})"
        params.extend(timeline_or_params)

    # カメラ機種・レンズ [+] (include) 条件（同一機材カテゴリ内は OR 結合）
    equip_inc_clauses: List[str] = []
    equip_inc_params: List[Any] = []
    if cameras:
        placeholders = ",".join(["?"] * len(cameras))
        equip_inc_clauses.append(f"p.camera_model IN ({placeholders})")
        equip_inc_params.extend(cameras)

    if lenses:
        for lens_spec in lenses:
            if "::" in lens_spec:
                cam_part, lens_part = lens_spec.split("::", 1)
                if lens_part == "__NONE__":
                    equip_inc_clauses.append(
                        "(p.camera_model = ? AND (p.lens_model IS NULL OR TRIM(p.lens_model) = ''))"
                    )
                    equip_inc_params.append(cam_part)
                else:
                    equip_inc_clauses.append("(p.camera_model = ? AND TRIM(p.lens_model) = ?)")
                    equip_inc_params.extend([cam_part, lens_part.strip()])
            else:
                if lens_spec == "__NONE__":
                    equip_inc_clauses.append("(p.lens_model IS NULL OR TRIM(p.lens_model) = '')")
                else:
                    equip_inc_clauses.append("TRIM(p.lens_model) = ?")
                    equip_inc_params.append(lens_spec.strip())

    if equip_inc_clauses:
        query += f" AND ({' OR '.join(equip_inc_clauses)})"
        params.extend(equip_inc_params)

    # カメラ機種 [-] (exclude) 条件
    if excluded_cameras:
        placeholders = ",".join(["?"] * len(excluded_cameras))
        query += f" AND (p.camera_model IS NULL OR p.camera_model NOT IN ({placeholders}))"
        params.extend(excluded_cameras)

    # レンズ [-] (exclude) 条件
    if excluded_lenses:
        for ex_spec in excluded_lenses:
            if "::" in ex_spec:
                cam_part, lens_part = ex_spec.split("::", 1)
                if lens_part == "__NONE__":
                    query += " AND NOT (p.camera_model = ? AND (p.lens_model IS NULL OR TRIM(p.lens_model) = ''))"
                    params.append(cam_part)
                else:
                    query += " AND NOT (p.camera_model = ? AND TRIM(p.lens_model) = ?)"
                    params.extend([cam_part, lens_part.strip()])
            else:
                if ex_spec == "__NONE__":
                    query += " AND NOT (p.lens_model IS NULL OR TRIM(p.lens_model) = '')"
                else:
                    query += " AND (p.lens_model IS NULL OR TRIM(p.lens_model) != ?)"
                    params.append(ex_spec.strip())

    # ラボ分析フィルタ
    if lab_filter:
        lf = lab_filter.strip().lower()
        if lf == "shake_risk":
            query += (
                f" AND p.focal_length IS NOT NULL AND p.focal_length > 0"
                f" AND p.shutter_speed IS NOT NULL AND p.shutter_speed != ''"
                f" AND ({_SHUTTER_SECONDS_SQL} * p.focal_length) >= 1.0"
            )
        elif lf == "golden_hour":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -4.0 AND 6.0"
            )
        elif lf == "blue_hour":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -8.0 AND -4.0001"
            )
        elif lf == "magic_all":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -8.0 AND 6.0"
            )
        elif lf == "night":
            query += (
                " AND p.date_taken IS NOT NULL AND p.date_taken != ''"
                " AND solar_altitude(p.date_taken, p.latitude, p.longitude) < -8.0"
            )

    if on_this_day and len(on_this_day.strip()) == 5:
        otd_dash = on_this_day.strip().replace(":", "-")
        otd_colon = otd_dash.replace("-", ":")
        query += " AND p.date_taken IS NOT NULL AND SUBSTR(p.date_taken, 6, 5) IN (?, ?)"
        params.extend([otd_dash, otd_colon])

    if focal_range and "-" in focal_range:
        try:
            f_min_s, f_max_s = focal_range.split("-", 1)
            f_min, f_max = float(f_min_s), float(f_max_s)
            query += " AND p.focal_length IS NOT NULL AND p.focal_length BETWEEN ? AND ?"
            params.extend([f_min, f_max])
        except ValueError as e:
            logger.debug(f"焦点距離レンジのパースに失敗しました ({focal_range}): {e}")

    if aperture_range and "-" in aperture_range:
        try:
            a_min_s, a_max_s = aperture_range.split("-", 1)
            a_min, a_max = float(a_min_s), float(a_max_s)
            query += " AND p.f_number IS NOT NULL AND p.f_number BETWEEN ? AND ?"
            params.extend([a_min, a_max])
        except ValueError as e:
            logger.debug(f"F値レンジのパースに失敗しました ({aperture_range}): {e}")

    if attr_filter:
        af = attr_filter.strip().lower()
        if af == "raw":
            query += " AND (p.is_raw = 1 OR (p.paired_raw_path IS NOT NULL AND p.paired_raw_path != ''))"
        elif af == "jpeg":
            query += " AND COALESCE(p.is_raw, 0) = 0"
        elif af == "raw_pair":
            query += " AND (p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')"
        elif af == "adjusted":
            query += (
                " AND (COALESCE(p.rotation, 0) != 0"
                " OR ABS(COALESCE(p.fine_angle, 0.0)) > 0.01"
                " OR COALESCE(p.brightness, 0) != 0"
                " OR COALESCE(p.contrast, 0) != 0"
                " OR COALESCE(p.saturation, 0) != 0"
                " OR (p.crop_w IS NOT NULL AND p.crop_h IS NOT NULL"
                " AND (p.crop_w < 0.999 OR p.crop_h < 0.999 OR COALESCE(p.crop_x, 0.0) > 0.001 OR COALESCE(p.crop_y, 0.0) > 0.001)))"
            )

    if search:
        query += " AND p.file_name LIKE ?"
        params.append(f"%{search}%")

    if stacked:
        query += " AND (p.is_stack_primary = 1 OR p.stack_id IS NULL)"

    # カラータグ定義
    _color_tag_tuple = (
        "赤", "青", "緑", "黄色", "黒", "白",
        "銀・シルバー", "金・ゴールド", "茶色", "紫", "オレンジ", "ピンク",
    )
    _color_tag_names = set(_color_tag_tuple)
    clean_inc = [t.strip() for t in (included_tags or []) if t and t.strip()]
    clean_exc = [t.strip() for t in (excluded_tags or []) if t and t.strip()]

    color_inc = [t for t in clean_inc if t in _color_tag_names]
    general_inc = [t for t in clean_inc if t not in _color_tag_names]
    color_exc = [t for t in clean_exc if t in _color_tag_names]
    general_exc = [t for t in clean_exc if t not in _color_tag_names]

    if color_inc:
        if len(color_inc) == 1:
            query += " AND p.id IN (SELECT photo_id FROM photo_tags WHERE tag = ?)"
            params.append(color_inc[0])
        else:
            placeholders = ",".join(["?"] * len(color_inc))
            query += f" AND p.id IN (SELECT photo_id FROM photo_tags WHERE tag IN ({placeholders}))"
            params.extend(color_inc)
    for c_tag in color_exc:
        query += " AND p.id NOT IN (SELECT photo_id FROM photo_tags WHERE tag = ?)"
        params.append(c_tag)

    if untagged_only:
        color_placeholders = ",".join(["?"] * len(_color_tag_tuple))
        query += f" AND p.id NOT IN (SELECT photo_id FROM photo_tags WHERE COALESCE(source, 'manual') != 'ai' AND tag NOT IN ({color_placeholders}))"
        params.extend(_color_tag_tuple)
    else:
        and_roots_set = {r.strip() for r in (tag_and_roots or []) if r and r.strip()}
        inter_group_or = (tag_group_op or "and").strip().lower() == "or"

        tag_groups: Dict[str, List[str]] = {}
        if general_inc:
            effective_inc = [
                t for t in general_inc
                if not any(other != t and other.startswith(t + "/") for other in general_inc)
            ]
            for tag in effective_inc:
                root_parent = tag.split("/", 1)[0].strip()
                group_list = tag_groups.setdefault(root_parent, [])
                if tag not in group_list:
                    group_list.append(tag)

        exc_by_root: Dict[str, List[str]] = {}
        for tag in general_exc:
            root_parent = tag.split("/", 1)[0].strip()
            exc_list_for_root = exc_by_root.setdefault(root_parent, [])
            if tag not in exc_list_for_root:
                exc_list_for_root.append(tag)

        if tag_groups:
            group_sql_clauses: List[str] = []
            group_sql_params: List[Any] = []

            for root_parent, group_tags in tag_groups.items():
                sub_parts: List[str] = []
                sub_params: List[Any] = []

                if len(group_tags) == 1:
                    sub_parts.append("p.id IN (SELECT photo_id FROM photo_tags WHERE tag = ?)")
                    sub_params.append(group_tags[0])
                elif root_parent in and_roots_set:
                    for g_tag in group_tags:
                        sub_parts.append("p.id IN (SELECT photo_id FROM photo_tags WHERE tag = ?)")
                        sub_params.append(g_tag)
                else:
                    placeholders = ",".join(["?"] * len(group_tags))
                    sub_parts.append(f"p.id IN (SELECT photo_id FROM photo_tags WHERE tag IN ({placeholders}))")
                    sub_params.extend(group_tags)

                if inter_group_or and len(tag_groups) > 1 and root_parent in exc_by_root:
                    for ex_tag in exc_by_root[root_parent]:
                        sub_parts.append("p.id NOT IN (SELECT photo_id FROM photo_tags WHERE tag = ?)")
                        sub_params.append(ex_tag)

                if len(sub_parts) == 1:
                    group_sql_clauses.append(sub_parts[0])
                else:
                    group_sql_clauses.append(f"({' AND '.join(sub_parts)})")
                group_sql_params.extend(sub_params)

            if inter_group_or and len(group_sql_clauses) > 1:
                joined_or = " OR ".join(f"({c})" for c in group_sql_clauses)
                query += f" AND ({joined_or})"
                params.extend(group_sql_params)
            else:
                for c in group_sql_clauses:
                    query += f" AND {c}"
                params.extend(group_sql_params)

        for root_parent, ex_tags in exc_by_root.items():
            if inter_group_or and len(tag_groups) > 1 and root_parent in tag_groups:
                continue
            for ex_tag in ex_tags:
                query += " AND p.id NOT IN (SELECT photo_id FROM photo_tags WHERE tag = ?)"
                params.append(ex_tag)

    ss_sql = _shutter_speed_seconds_sql("p.shutter_speed")
    shutter_fast_sql = f"CASE WHEN ({ss_sql}) IS NULL OR ({ss_sql}) <= 0 THEN 1 ELSE 0 END ASC, ({ss_sql}) ASC, p.date_taken DESC, p.id DESC"
    shutter_slow_sql = f"CASE WHEN ({ss_sql}) IS NULL OR ({ss_sql}) <= 0 THEN 1 ELSE 0 END ASC, ({ss_sql}) DESC, p.date_taken DESC, p.id DESC"
    valid_sorts = {
        "date_taken DESC": "p.date_taken DESC, p.file_name ASC",
        "date_taken ASC": "p.date_taken ASC, p.file_name ASC",
        "rating DESC": "p.rating DESC, p.date_taken DESC",
        "file_name ASC": "p.file_name ASC",
        "file_name DESC": "p.file_name DESC",
        "file_size DESC": "COALESCE(p.file_size, 0) DESC, p.date_taken DESC",
        "file_size ASC": "COALESCE(p.file_size, 0) ASC, p.date_taken DESC",
        "focal_length ASC": "CASE WHEN p.focal_length IS NULL OR p.focal_length <= 0 THEN 1 ELSE 0 END ASC, p.focal_length ASC, p.date_taken DESC",
        "focal_length DESC": "CASE WHEN p.focal_length IS NULL OR p.focal_length <= 0 THEN 1 ELSE 0 END ASC, p.focal_length DESC, p.date_taken DESC",
        "f_number ASC": "CASE WHEN p.f_number IS NULL OR p.f_number <= 0 THEN 1 ELSE 0 END ASC, p.f_number ASC, p.date_taken DESC",
        "f_number DESC": "CASE WHEN p.f_number IS NULL OR p.f_number <= 0 THEN 1 ELSE 0 END ASC, p.f_number DESC, p.date_taken DESC",
        "iso DESC": "CASE WHEN p.iso IS NULL OR p.iso <= 0 THEN 1 ELSE 0 END ASC, p.iso DESC, p.date_taken DESC",
        "iso ASC": "CASE WHEN p.iso IS NULL OR p.iso <= 0 THEN 1 ELSE 0 END ASC, p.iso ASC, p.date_taken DESC",
        "shutter_fast": shutter_fast_sql,
        "shutter_slow": shutter_slow_sql,
        "shutter_speed ASC": shutter_fast_sql,
        "shutter_speed DESC": shutter_slow_sql,
    }
    order_clause = valid_sorts.get(sort_by, "p.date_taken DESC, p.file_name ASC")
    query += f" ORDER BY {order_clause}"

    if limit and limit > 0:
        query += f" LIMIT {int(limit)}"

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.row_factory = None
        try:
            cursor.execute(query, params)
        except sqlite3.OperationalError as oe:
            if "idx_thumbnails_dims" in str(oe):
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_thumbnails_dims ON thumbnails(photo_id, width, height)")
                cursor.execute(query, params)
            else:
                raise
        col_names = [d[0] for d in cursor.description]
        rows = cursor.fetchall()
        photos = [dict(zip(col_names, row)) for row in rows]

        # フォルダまたはボリューム指定時は、マッチした photo_links のパス・ボリューム情報を各写真オブジェクトに反映
        if photos and has_link_filter and not unlinked_only and pl_filter_clauses:
            pl_where_str = " AND ".join(pl_filter_clauses)
            photo_id_set = {p["id"] for p in photos}
            matched_link_map: Dict[int, Tuple[Any, ...]] = {}
            cursor.execute(
                f"""
                SELECT pl.photo_id, pl.file_path, pl.directory_path, pl.file_name,
                       pl.volume_serial, pl.file_mtime, pl.paired_raw_path,
                       v.volume_label, COALESCE(v.custom_name, '') AS volume_custom_name,
                       v.drive_letter AS volume_drive
                FROM photo_links pl
                LEFT JOIN volumes v ON pl.volume_serial = v.volume_serial
                WHERE {pl_where_str}
                ORDER BY pl.is_primary DESC, pl.id ASC
                """,
                pl_filter_params,
            )
            for lk_row in cursor.fetchall():
                pid = lk_row[0]
                if pid in photo_id_set and pid not in matched_link_map:
                    matched_link_map[pid] = lk_row

            for p in photos:
                lk = matched_link_map.get(p["id"])
                if lk:
                    p["file_path"] = lk[1]
                    p["directory_path"] = lk[2]
                    p["file_name"] = lk[3]
                    p["volume_serial"] = lk[4] or None
                    if lk[5] is not None:
                        p["file_mtime"] = lk[5]
                    p["paired_raw_path"] = lk[6]
                    p["volume_label"] = lk[7]
                    p["volume_custom_name"] = lk[8]
                    p["volume_drive"] = lk[9]
        elif photos and not has_link_filter and not unlinked_only:
            # 全体表示・タグ検索等で複数メディアにリンクを持つ写真は、主リンクがオフラインならオンラインの副リンクを優先採用する
            multi_link_photos = [
                p for p in photos
                if int(p.get("duplicate_count") or 1) > 1 and not p.get("is_unlinked")
            ]
            if multi_link_photos:
                from ..scanner import resolve_drive_online_path
                dir_online_memo: Dict[Tuple[str, Optional[str]], bool] = {}

                def _is_dir_online_cached(d_p: Optional[str], v_s: Optional[str]) -> bool:
                    if not d_p:
                        return False
                    key = (d_p, (v_s or "").strip() or None)
                    if key not in dir_online_memo:
                        dir_online_memo[key] = bool(resolve_drive_online_path(d_p, expected_serial=key[1])[1])
                    return dir_online_memo[key]

                offline_primary_map = {
                    p["id"]: p for p in multi_link_photos
                    if not _is_dir_online_cached(p.get("directory_path"), p.get("volume_serial"))
                }
                if offline_primary_map:
                    placeholders = ",".join(["?"] * len(offline_primary_map))
                    cursor.execute(
                        f"""
                        SELECT pl.photo_id, pl.file_path, pl.directory_path, pl.file_name,
                               pl.volume_serial, pl.file_mtime, pl.paired_raw_path,
                               v.volume_label, COALESCE(v.custom_name, '') AS volume_custom_name,
                               v.drive_letter AS volume_drive
                        FROM photo_links pl
                        LEFT JOIN volumes v ON pl.volume_serial = v.volume_serial
                        WHERE pl.photo_id IN ({placeholders})
                        ORDER BY pl.is_primary DESC, pl.id ASC
                        """,
                        list(offline_primary_map.keys()),
                    )
                    resolved_pids = set()
                    for lk_row in cursor.fetchall():
                        pid = lk_row[0]
                        if pid in resolved_pids:
                            continue
                        if _is_dir_online_cached(lk_row[2], lk_row[4]):
                            resolved_pids.add(pid)
                            p = offline_primary_map[pid]
                            p["file_path"] = lk_row[1]
                            p["directory_path"] = lk_row[2]
                            p["file_name"] = lk_row[3]
                            p["volume_serial"] = lk_row[4] or None
                            if lk_row[5] is not None:
                                p["file_mtime"] = lk_row[5]
                            p["paired_raw_path"] = lk_row[6]
                            p["volume_label"] = lk_row[7]
                            p["volume_custom_name"] = lk_row[8]
                            p["volume_drive"] = lk_row[9]

        if photos:
            dir_files_map: Dict[Tuple[str, str], Optional[set]] = {}
            try:
                from ..scanner import resolve_portable_path
                from .folders import _PHOTO_DIR_SCAN_CACHE, _PHOTO_DIR_SCAN_TTL
                import time as _time
                now_ts = _time.monotonic()
                unique_dir_keys = {
                    (p.get("directory_path"), p.get("volume_serial") or None)
                    for p in photos
                    if p.get("directory_path")
                }
                uncached_xmp_dirs = []
                for d_path, v_ser in unique_dir_keys:
                    cache_key = (d_path, v_ser)
                    cached = _PHOTO_DIR_SCAN_CACHE.get(cache_key)
                    if cached and (now_ts - cached[0]) <= _PHOTO_DIR_SCAN_TTL:
                        dir_files_map[cache_key] = {n for n in (cached[4] or ()) if n.endswith(".xmp")}
                    else:
                        uncached_xmp_dirs.append(cache_key)

                if uncached_xmp_dirs:
                    from ..storage_manager import is_path_in_storage

                    def _scan_dir_for_xmp(ck: Tuple[str, Optional[str]]):
                        dp, vs = ck
                        resolved_dir, is_online = resolve_portable_path(dp, expected_serial=vs or None)
                        is_stor = is_path_in_storage(dp, volume_serial=vs)
                        if is_online and resolved_dir:
                            try:
                                with os.scandir(str(resolved_dir)) as it:
                                    all_f = {entry.name.lower() for entry in it}
                                    xmp_f = {n for n in all_f if n.endswith(".xmp")}
                                    return ck, xmp_f, (now_ts, resolved_dir, True, is_stor, all_f)
                            except Exception as e:
                                logger.debug(f"XMP判定用ディレクトリスキャン失敗 ({resolved_dir}): {e}")
                                return ck, set(), (now_ts, resolved_dir, True, is_stor, set())
                        return ck, set(), (now_ts, resolved_dir, False, is_stor, None)

                    if len(uncached_xmp_dirs) > 4:
                        from concurrent.futures import ThreadPoolExecutor
                        with ThreadPoolExecutor(max_workers=8) as pool:
                            for ck, xmp_f, cache_entry in pool.map(_scan_dir_for_xmp, uncached_xmp_dirs):
                                dir_files_map[ck] = xmp_f
                                _PHOTO_DIR_SCAN_CACHE[ck] = cache_entry
                    else:
                        for ck in uncached_xmp_dirs:
                            _, xmp_f, cache_entry = _scan_dir_for_xmp(ck)
                            dir_files_map[ck] = xmp_f
                            _PHOTO_DIR_SCAN_CACHE[ck] = cache_entry
            except Exception as e:
                logger.debug(f"XMP判定キャッシュ準備スキップ: {e}")

            for p in photos:
                p["original_date_taken"] = p.get("original_date_taken")
                p["file_path"] = _strip_vsn_prefix_raw(p.get("file_path"))
                if p.get("is_unlinked"):
                    p["volume_serial"] = None
                    p["volume_label"] = None
                    p["volume_custom_name"] = ""
                    p["volume_drive"] = None
                    p["has_xmp"] = False
                    continue
                d_path = p.get("directory_path")
                v_ser = p.get("volume_serial") or None
                f_set = dir_files_map.get((d_path, v_ser)) if d_path else None
                if not f_set:
                    p["has_xmp"] = False
                    continue
                p["has_xmp"] = _has_xmp_sidecar_fast(
                    p.get("file_path"),
                    p.get("paired_raw_path"),
                    dir_file_set=f_set,
                    volume_serial=v_ser or None,
                )

            if (attr_filter or "").strip().lower() == "xmp":
                photos = [p for p in photos if p.get("has_xmp")]

        if photos:
            photo_ids = [p["id"] for p in photos]
            photo_id_set = set(photo_ids)
            tags_map: Dict[int, List[str]] = {}
            tag_details_map: Dict[int, List[Dict[str, Any]]] = {}
            chunk_size = 900

            if len(photo_ids) > 1500:
                cursor.execute("SELECT photo_id, tag, source, confidence FROM photo_tags")
                for pid, tag_val, src_val, conf_val in cursor.fetchall():
                    if pid in photo_id_set:
                        tags_map.setdefault(pid, []).append(tag_val)
                        tag_details_map.setdefault(pid, []).append({
                            "tag": tag_val,
                            "source": src_val or "manual",
                            "confidence": conf_val if conf_val is not None else 1.0,
                        })
            else:
                for i in range(0, len(photo_ids), chunk_size):
                    id_chunk = photo_ids[i:i + chunk_size]
                    cursor.execute(
                        f"SELECT photo_id, tag, source, confidence FROM photo_tags WHERE photo_id IN ({','.join(['?']*len(id_chunk))})",
                        id_chunk
                    )
                    for pid, tag_val, src_val, conf_val in cursor.fetchall():
                        tags_map.setdefault(pid, []).append(tag_val)
                        tag_details_map.setdefault(pid, []).append({
                            "tag": tag_val,
                            "source": src_val or "manual",
                            "confidence": conf_val if conf_val is not None else 1.0,
                        })

            for p in photos:
                pid = p["id"]
                p["tags"] = tags_map.get(pid, [])
                p["tag_details"] = tag_details_map.get(pid, [])

            active_stack_ids = list({p["stack_id"] for p in photos if p.get("stack_id")})
            if active_stack_ids:
                active_stack_set = set(active_stack_ids)
                stack_map: Dict[int, List[Dict[str, Any]]] = {}
                stack_cols = [
                    "id", "file_name", "file_path", "directory_path", "file_size", "width", "height",
                    "date_taken", "subsec_time", "exposure_bias", "shutter_speed", "f_number", "camera_model",
                    "is_stack_primary", "stack_id", "rating", "is_raw", "raw_format"
                ]
                if len(active_stack_ids) > 800:
                    cursor.execute(
                        """
                        SELECT id, file_name, file_path, directory_path, file_size, width, height,
                               date_taken, subsec_time, exposure_bias, shutter_speed, f_number, camera_model,
                               is_stack_primary, stack_id, rating, is_raw, raw_format
                        FROM photos
                        WHERE stack_id IS NOT NULL AND IFNULL(is_unlinked, 0) = 0
                        ORDER BY date_taken ASC, subsec_time ASC, id ASC
                        """
                    )
                    for r in cursor.fetchall():
                        sid = r[14]
                        if sid in active_stack_set:
                            d_row = dict(zip(stack_cols, r))
                            d_row["file_path"] = _strip_vsn_prefix_raw(d_row.get("file_path"))
                            stack_map.setdefault(sid, []).append(d_row)
                else:
                    for i in range(0, len(active_stack_ids), chunk_size):
                        sid_chunk = active_stack_ids[i:i + chunk_size]
                        cursor.execute(
                            f"""
                            SELECT id, file_name, file_path, directory_path, file_size, width, height,
                                   date_taken, subsec_time, exposure_bias, shutter_speed, f_number, camera_model,
                                   is_stack_primary, stack_id, rating, is_raw, raw_format
                            FROM photos
                            WHERE stack_id IN ({','.join(['?']*len(sid_chunk))}) AND IFNULL(is_unlinked, 0) = 0
                            ORDER BY date_taken ASC, subsec_time ASC, id ASC
                            """,
                            sid_chunk
                        )
                        for r in cursor.fetchall():
                            sid = r[14]
                            d_row = dict(zip(stack_cols, r))
                            d_row["file_path"] = _strip_vsn_prefix_raw(d_row.get("file_path"))
                            stack_map.setdefault(sid, []).append(d_row)

                for p in photos:
                    sid = p.get("stack_id")
                    if sid and sid in stack_map:
                        p["stack_count"] = len(stack_map[sid])
                        p["stack_photos"] = stack_map[sid]
                    else:
                        p["stack_count"] = 1
                        p["stack_photos"] = []
            else:
                for p in photos:
                    p["stack_count"] = 1
                    p["stack_photos"] = []

        return photos


def _sync_stack_primary_by_rating(cursor, stack_ids: List[int]) -> None:
    """
    指定された stack_id 群について、メンバーの評価（優=2 > 良=1 > 可=0 > 棄=-1）に基づき
    代表写真（is_stack_primary = 1）を自動再選出する。
    同評価の場合はブラケットなら ±0.0 EV に最も近いコマ、連写・重複なら先頭コマを代表とする。
    """
    unique_sids = list({int(sid) for sid in stack_ids if sid is not None})
    for sid in unique_sids:
        cursor.execute(
            """
            SELECT id, rating, exposure_bias, stack_type, is_raw, paired_raw_path
            FROM photos
            WHERE stack_id = ? AND IFNULL(is_unlinked, 0) = 0
            ORDER BY date_taken ASC, subsec_time ASC, id ASC
            """,
            (sid,),
        )
        members = [dict(r) for r in cursor.fetchall()]
        if not members:
            continue
        candidates = [
            m for m in members
            if not (m.get("is_raw") and m.get("paired_raw_path"))
        ] or members
        stack_type = candidates[0].get("stack_type") or ""
        if stack_type == "bracket":
            best = min(
                enumerate(candidates),
                key=lambda kv: (-int(kv[1].get("rating") or 0), abs(float(kv[1].get("exposure_bias") or 0.0)), kv[0]),
            )[1]
        else:
            best = max(
                enumerate(candidates),
                key=lambda kv: (int(kv[1].get("rating") or 0), -kv[0]),
            )[1]
        new_pri_id = best["id"]
        cursor.execute(
            """
            UPDATE photos
            SET stack_id = ?,
                is_stack_primary = CASE WHEN id = ? THEN 1 ELSE 0 END
            WHERE stack_id = ?
            """,
            (new_pri_id, new_pri_id, sid),
        )


def batch_update_rating(photo_ids: List[int], rating: int) -> int:
    """複数の写真の評価を一括更新する（-1:棄, 0:可, 1:良, 2:優）"""
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        affected_stack_ids = []
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"SELECT DISTINCT stack_id FROM photos WHERE id IN ({placeholders}) AND stack_id IS NOT NULL",
                chunk,
            )
            affected_stack_ids.extend(r["stack_id"] for r in cursor.fetchall() if r["stack_id"] is not None)
            cursor.execute(
                f"UPDATE photos SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})",
                [rating] + chunk,
            )
            updated += cursor.rowcount
        if affected_stack_ids:
            _sync_stack_primary_by_rating(cursor, affected_stack_ids)
        conn.commit()
        return updated


def get_total_photos_count() -> int:
    """ライブラリに登録されている全写真の物理総数を返す"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) as count FROM photos "
            "WHERE NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL AND paired_raw_path != '')"
        )
        row = cursor.fetchone()
        return row["count"] if row else 0


def get_photo_by_id(photo_id: int) -> Optional[Dict[str, Any]]:
    """IDで単一の写真情報を取得する（タグ一覧＋スタックメンバー＋ボリューム情報付き）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*,
                   v.volume_label,
                   COALESCE(v.custom_name, '') AS volume_custom_name,
                   v.drive_letter AS volume_drive
            FROM photos p
            LEFT JOIN volumes v ON p.volume_serial = v.volume_serial AND COALESCE(p.is_unlinked, 0) = 0
            WHERE p.id = ?
            """,
            (photo_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        photo = dict(row)
        photo["file_path"] = _strip_vsn_prefix_raw(photo.get("file_path"))
        photo["original_date_taken"] = row["original_date_taken"] if "original_date_taken" in row.keys() else None
        if photo.get("is_unlinked"):
            photo["volume_serial"] = None
            photo["volume_label"] = None
            photo["volume_custom_name"] = ""
            photo["volume_drive"] = None
            photo["has_xmp"] = False
        else:
            photo["has_xmp"] = _has_xmp_sidecar_fast(
                photo.get("file_path"),
                photo.get("paired_raw_path"),
                volume_serial=photo.get("volume_serial"),
            )
        cursor.execute("SELECT tag, source, confidence FROM photo_tags WHERE photo_id = ? ORDER BY tag ASC", (photo_id,))
        tag_rows = cursor.fetchall()
        photo["tags"] = [r["tag"] for r in tag_rows]
        photo["tag_details"] = [
            {
                "tag": r["tag"],
                "source": r["source"] or "manual",
                "confidence": r["confidence"] if r["confidence"] is not None else 1.0,
            }
            for r in tag_rows
        ]

        # スタックメンバー情報の取得
        if photo.get("stack_id"):
            cursor.execute(
                """
                SELECT id, file_name, file_path, date_taken, subsec_time, exposure_bias, shutter_speed, f_number,
                       is_stack_primary, stack_id, stack_type, rating, is_raw, raw_format, paired_raw_path
                FROM photos
                WHERE stack_id = ?
                ORDER BY date_taken ASC, subsec_time ASC, id ASC
                """,
                (photo["stack_id"],)
            )
            sp_list = []
            for r in cursor.fetchall():
                sp = dict(r)
                sp["file_path"] = _strip_vsn_prefix_raw(sp.get("file_path"))
                sp_list.append(sp)
            photo["stack_photos"] = sp_list
            photo["stack_count"] = len(photo["stack_photos"])
        else:
            photo["stack_photos"] = []
            photo["stack_count"] = 1

        # 重複写真（他フォルダコピー含む）情報の取得
        from .duplicates import get_duplicates_for_photo
        dups = get_duplicates_for_photo(photo_id)
        photo["duplicates"] = dups
        photo["duplicate_count"] = len(dups) if dups else 1

        return photo


def get_duplicate_photos_count() -> int:
    """ライブラリ全体で重複（複数フォルダ・複数メディアにリンクが存在する）写真の総数を返す"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COUNT(*) as count
            FROM photos
            WHERE IFNULL(is_unlinked, 0) = 0
              AND COALESCE(link_count, 1) > 1
            """
        )
        row = cursor.fetchone()
        return row["count"] if row else 0


def update_rating(photo_id: int, rating: int) -> bool:
    """評価を更新する（-1:棄, 0:可, 1:良, 2:優）。スタック所属時は評価優先で代表写真を自動再選出する。"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT stack_id FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        stack_id = row["stack_id"] if row else None
        cursor.execute(
            "UPDATE photos SET rating = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (rating, photo_id),
        )
        changed = cursor.rowcount > 0
        if stack_id is not None:
            _sync_stack_primary_by_rating(cursor, [stack_id])
        conn.commit()
        return changed


def _parse_photo_datetime(dt_str: Optional[str]) -> Optional[datetime]:
    """写真の撮影日時文字列を datetime オブジェクトにパースする"""
    if not dt_str:
        return None
    s = str(dt_str).strip()
    if not s:
        return None
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y:%m:%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y:%m:%d %H:%M",
        "%Y-%m-%d",
        "%Y:%m:%d",
    ):
        try:
            return datetime.strptime(s[:19] if len(s) >= 19 else s, fmt)
        except (ValueError, TypeError):
            continue
    return None


def batch_shift_photo_dates(
    photo_ids: List[int],
    offset_seconds: int = 0,
    reset: bool = False,
) -> Dict[str, Any]:
    """
    複数写真の撮影日時（date_taken）を指定秒数だけ一括シフト、または初期撮影日時（original_date_taken）へ非破壊リセットする。
    初回シフト時はシフト前の date_taken を original_date_taken カラムに退避・保持する。
    """
    if not photo_ids:
        return {"updated_count": 0, "photos": []}

    unique_ids = list(dict.fromkeys(int(pid) for pid in photo_ids if pid is not None))
    if not unique_ids:
        return {"updated_count": 0, "photos": []}

    updated_photos: List[Dict[str, Any]] = []
    chunk_size = 500

    with get_connection() as conn:
        cursor = conn.cursor()

        if reset:
            target_rows = []
            for i in range(0, len(unique_ids), chunk_size):
                chunk = unique_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    SELECT id, date_taken, year_month, original_date_taken
                    FROM photos
                    WHERE id IN ({placeholders})
                      AND original_date_taken IS NOT NULL
                      AND original_date_taken != ''
                    """,
                    chunk,
                )
                target_rows.extend(cursor.fetchall())

            if target_rows:
                for i in range(0, len(unique_ids), chunk_size):
                    chunk = unique_ids[i:i + chunk_size]
                    placeholders = ",".join(["?"] * len(chunk))
                    cursor.execute(
                        f"""
                        UPDATE photos
                        SET date_taken = original_date_taken,
                            year_month = substr(replace(original_date_taken, ':', '-'), 1, 7),
                            original_date_taken = NULL,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id IN ({placeholders})
                          AND original_date_taken IS NOT NULL
                          AND original_date_taken != ''
                        """,
                        chunk,
                    )
                conn.commit()

                for r in target_rows:
                    orig_dt = str(r["original_date_taken"])
                    restored_ym = orig_dt.replace(":", "-")[:7] if len(orig_dt) >= 7 else None
                    updated_photos.append({
                        "id": r["id"],
                        "date_taken": orig_dt,
                        "year_month": restored_ym,
                        "original_date_taken": None,
                    })

            invalidate_fast_cache()
            return {
                "updated_count": len(updated_photos),
                "photos": updated_photos,
            }

        # reset=False の場合
        rows = []
        for i in range(0, len(unique_ids), chunk_size):
            chunk = unique_ids[i:i + chunk_size]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"""
                SELECT id, date_taken, year_month, original_date_taken
                FROM photos
                WHERE id IN ({placeholders})
                """,
                chunk,
            )
            rows.extend(cursor.fetchall())

        if int(offset_seconds or 0) == 0:
            current_list = [
                {
                    "id": r["id"],
                    "date_taken": r["date_taken"],
                    "year_month": r["year_month"],
                    "original_date_taken": r["original_date_taken"],
                }
                for r in rows
            ]
            return {"updated_count": 0, "photos": current_list}

        delta = timedelta(seconds=int(offset_seconds))
        update_params: List[Tuple[str, str, str, int]] = []

        for r in rows:
            pid = r["id"]
            cur_dt_str = r["date_taken"]
            orig_dt_str = r["original_date_taken"]
            if not cur_dt_str:
                continue
            dt = _parse_photo_datetime(cur_dt_str)
            if dt is None:
                continue

            saved_orig = (
                str(orig_dt_str)
                if (orig_dt_str is not None and str(orig_dt_str).strip() != "")
                else str(cur_dt_str)
            )
            shifted = dt + delta
            new_dt = shifted.strftime("%Y-%m-%d %H:%M:%S")
            new_ym = shifted.strftime("%Y-%m")

            update_params.append((new_dt, new_ym, saved_orig, pid))
            updated_photos.append({
                "id": pid,
                "date_taken": new_dt,
                "year_month": new_ym,
                "original_date_taken": saved_orig,
            })

        if update_params:
            cursor.executemany(
                """
                UPDATE photos
                SET date_taken = ?,
                    year_month = ?,
                    original_date_taken = ?,
                    meta_dirty = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                update_params,
            )
            conn.commit()

    invalidate_fast_cache()
    return {
        "updated_count": len(updated_photos),
        "photos": updated_photos,
    }


def update_photo_adjustments(
    photo_id: int,
    rotation: int = 0,
    fine_angle: float = 0.0,
    crop_x: Optional[float] = None,
    crop_y: Optional[float] = None,
    crop_w: Optional[float] = None,
    crop_h: Optional[float] = None,
    crop_aspect: Optional[str] = None,
    brightness: int = 0,
    contrast: int = 0,
    saturation: int = 0,
) -> bool:
    """写真の回転角度・水平傾き補正・トリミング範囲・トーン微調整を非破壊更新する（元画像は触らない）"""
    norm_rotation = (int(rotation) % 360 + 360) % 360
    clamped_angle = round(max(-45.0, min(45.0, float(fine_angle or 0.0))), 2)
    clamped_b = max(-100, min(100, int(brightness or 0)))
    clamped_c = max(-100, min(100, int(contrast or 0)))
    clamped_s = max(-100, min(100, int(saturation or 0)))
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET rotation = ?,
                fine_angle = ?,
                crop_x = ?,
                crop_y = ?,
                crop_w = ?,
                crop_h = ?,
                crop_aspect = ?,
                brightness = ?,
                contrast = ?,
                saturation = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                norm_rotation,
                clamped_angle,
                crop_x,
                crop_y,
                crop_w,
                crop_h,
                crop_aspect,
                clamped_b,
                clamped_c,
                clamped_s,
                photo_id,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0


def batch_update_photo_tone(
    photo_ids: List[int],
    brightness: int = 0,
    contrast: int = 0,
    saturation: int = 0,
) -> int:
    """複数写真のトーン微調整（明るさ・コントラスト・彩度）のみを一括更新する（回転・傾き・クロップは維持）"""
    if not photo_ids:
        return 0
    clamped_b = max(-100, min(100, int(brightness or 0)))
    clamped_c = max(-100, min(100, int(contrast or 0)))
    clamped_s = max(-100, min(100, int(saturation or 0)))
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            sql = f"""
                UPDATE photos
                SET brightness = ?,
                    contrast = ?,
                    saturation = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
            """
            cursor.execute(sql, [clamped_b, clamped_c, clamped_s] + chunk)
            updated += cursor.rowcount
        conn.commit()
        return updated


def rotate_photo(photo_id: int, delta_degrees: int = 90) -> Dict[str, Any]:
    """写真の回転角度を90度単位で加算・更新する（例: 0 -> 90 -> 180 -> 270 -> 0）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT rotation FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        if not row:
            return {"success": False, "rotation": 0}
        current_rotation = row["rotation"] or 0
        new_rotation = ((current_rotation + delta_degrees) % 360 + 360) % 360
        cursor.execute(
            "UPDATE photos SET rotation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_rotation, photo_id),
        )
        conn.commit()
        return {"success": True, "photo_id": photo_id, "rotation": new_rotation}


def reset_photo_adjustments(photo_id: int) -> bool:
    """写真の回転・水平傾き補正・トリミング・トーン微調整を初期状態へリセットする"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET rotation = 0,
                fine_angle = 0.0,
                crop_x = NULL,
                crop_y = NULL,
                crop_w = NULL,
                crop_h = NULL,
                crop_aspect = NULL,
                brightness = 0,
                contrast = 0,
                saturation = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (photo_id,),
        )
        conn.commit()
        return cursor.rowcount > 0


def batch_reset_photo_adjustments(photo_ids: List[int]) -> int:
    """複数写真の回転・水平傾き補正・トリミング・トーン微調整を一括で初期状態へリセットする"""
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            sql = f"""
                UPDATE photos
                SET rotation = 0,
                    fine_angle = 0.0,
                    crop_x = NULL,
                    crop_y = NULL,
                    crop_w = NULL,
                    crop_h = NULL,
                    crop_aspect = NULL,
                    brightness = 0,
                    contrast = 0,
                    saturation = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
            """
            cursor.execute(sql, chunk)
            updated += cursor.rowcount
        conn.commit()
        return updated


def batch_rotate_photos(photo_ids: List[int], delta_degrees: int = 90) -> int:
    """複数の写真の回転角度を一括で加算・更新する"""
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        chunk_size = 500
        for i in range(0, len(photo_ids), chunk_size):
            chunk = photo_ids[i:i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            sql = f"""
                UPDATE photos
                SET rotation = (((COALESCE(rotation, 0) + ?) % 360) + 360) % 360,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id IN ({placeholders})
            """
            cursor.execute(sql, [delta_degrees] + chunk)
            updated += cursor.rowcount
        conn.commit()
        return updated


def update_photo_gps(photo_id: int, latitude: float, longitude: float, source: str = "copied") -> bool:
    """写真のGPS位置情報を更新する（元ファイルのEXIFは触らない）"""
    from server.geocoder import reverse_geocode
    with get_connection() as conn:
        loc = reverse_geocode(latitude, longitude, db_conn=conn)
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE photos
               SET latitude = ?, longitude = ?, gps_source = ?,
                   country = ?, state = ?, city = ?,
                   meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (latitude, longitude, source, loc.get("country"), loc.get("state"), loc.get("city"), photo_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def find_nearby_gps_photos(date_taken: str, minutes: int = 60, exclude_id: Optional[int] = None) -> Dict[str, Any]:
    """
    指定した撮影日時の ±N分 以内で GPS 情報を持つ写真を検索する。
    直前（before）と直後（after）の候補を分離し、地名情報（country, state, city）も含めて返す。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 日時文字列をパースし、BETWEEN によるインデックス範囲検索（idx_photos_gps_date）を試行
        dt = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                dt = datetime.strptime(str(date_taken).strip(), fmt)
                break
            except (ValueError, TypeError) as e:
                logger.debug(f"GPS近傍検索: 日時パース試行失敗 ({fmt}): {e}")

        if dt is not None:
            min_dt = (dt - timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
            max_dt = (dt + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S")
            query = """
                SELECT id, file_name, date_taken, camera_model, latitude, longitude, gps_source,
                       country, state, city,
                       CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL) AS time_diff_signed,
                       ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) AS time_diff_min
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND date_taken BETWEEN ? AND ?
            """
            params: List[Any] = [date_taken, date_taken, min_dt, max_dt]
        else:
            # 日時パース失敗時は従来の julianday クエリに安全にフォールバック
            logger.warning(f"GPS近傍検索: 日時パース失敗のため従来のjulianday走査へフォールバックします: {date_taken}")
            query = """
                SELECT id, file_name, date_taken, camera_model, latitude, longitude, gps_source,
                       country, state, city,
                       CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL) AS time_diff_signed,
                       ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) AS time_diff_min
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) <= ?
            """
            params = [date_taken, date_taken, date_taken, minutes]

        if exclude_id is not None:
            query += " AND id != ?"
            params.append(exclude_id)
        query += " ORDER BY time_diff_min ASC LIMIT 30"
        cursor.execute(query, params)
        all_candidates = [dict(row) for row in cursor.fetchall()]

        # 直前 (time_diff_signed <= 0) と 直後 (time_diff_signed > 0) の最近傍を抽出
        before_candidate = None
        after_candidate = None

        for c in all_candidates:
            diff = c.get("time_diff_signed", 0)
            if diff <= 0:
                if before_candidate is None:
                    before_candidate = c
            else:
                if after_candidate is None:
                    after_candidate = c
            if before_candidate and after_candidate:
                break

        return {
            "candidates": all_candidates,
            "before": before_candidate,
            "after": after_candidate,
        }


def batch_infer_gps(
    photo_ids: Optional[List[int]] = None,
    folder: Optional[str] = None,
    max_minutes: int = 60
) -> Dict[str, Any]:
    """
    GPS情報のない写真に対して、撮影時刻が ±max_minutes 以内で最も近い写真のGPSを準用する。
    gps_source = 'inferred' として記録。
    N+1 を解消し、対象期間のGPS付き写真を一括取得後にメモリ上二分探索して executemany で一括更新する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        # 対象写真の抽出（GPS未設定かつ撮影日時が存在するもの）
        if photo_ids:
            target_photos = []
            chunk_size = 500
            for i in range(0, len(photo_ids), chunk_size):
                chunk = photo_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    SELECT id, date_taken
                    FROM photos
                    WHERE id IN ({placeholders})
                      AND latitude IS NULL
                      AND date_taken IS NOT NULL AND date_taken != ''
                    """,
                    chunk
                )
                target_photos.extend(cursor.fetchall())
        elif folder:
            dir_sql, dir_params = _directory_filter_sql(folder, recursive=True, column_name="directory_path")
            cursor.execute(
                f"""
                SELECT id, date_taken
                FROM photos
                WHERE {dir_sql}
                  AND latitude IS NULL
                  AND date_taken IS NOT NULL AND date_taken != ''
                """,
                dir_params
            )
            target_photos = cursor.fetchall()
        else:
            return {"inferred_count": 0, "skipped_count": 0, "total_target": 0}

        total_target = len(target_photos)
        if total_target == 0:
            return {"inferred_count": 0, "skipped_count": 0, "total_target": 0}

        # ターゲット写真の日時パース
        parsed_targets: List[Tuple[int, datetime, str]] = []
        unparsed_targets: List[Tuple[int, str]] = []

        for p in target_photos:
            pid = p["id"]
            date_taken = p["date_taken"]
            dt = None
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
                try:
                    dt = datetime.strptime(str(date_taken).strip(), fmt)
                    break
                except (ValueError, TypeError) as e:
                    logger.debug(f"GPS一括推定: ターゲット日時パース試行失敗 ({fmt}): {e}")

            if dt is not None:
                parsed_targets.append((pid, dt, date_taken))
            else:
                unparsed_targets.append((pid, date_taken))

        update_params = []

        # パース成功したターゲットの写真について一括範囲検索
        if parsed_targets:
            min_dt_target = min(item[1] for item in parsed_targets)
            max_dt_target = max(item[1] for item in parsed_targets)

            overall_min = (min_dt_target - timedelta(minutes=max_minutes)).strftime("%Y-%m-%d %H:%M:%S")
            overall_max = (max_dt_target + timedelta(minutes=max_minutes)).strftime("%Y-%m-%d %H:%M:%S")

            cursor.execute(
                """
                SELECT id, latitude, longitude, country, state, city, date_taken
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND date_taken BETWEEN ? AND ?
                ORDER BY date_taken ASC
                """,
                (overall_min, overall_max)
            )
            gps_rows = cursor.fetchall()

            # GPS候補写真の日時パース
            gps_candidates: List[Tuple[datetime, Any]] = []
            for row in gps_rows:
                raw_dt = row["date_taken"]
                c_dt = None
                for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
                    try:
                        c_dt = datetime.strptime(str(raw_dt).strip(), fmt)
                        break
                    except (ValueError, TypeError) as e:
                        logger.debug(f"GPS一括推定: 候補日時パース試行失敗 ({fmt}): {e}")
                if c_dt is not None:
                    gps_candidates.append((c_dt, row))

            gps_candidates.sort(key=lambda x: x[0])
            gps_times = [c[0] for c in gps_candidates]

            for pid, dt, date_taken in parsed_targets:
                if not gps_times:
                    continue

                idx = bisect.bisect_left(gps_times, dt)
                best_diff = None
                best_candidate = None

                # 直前 (idx - 1)
                if idx > 0:
                    diff_before = abs((gps_times[idx - 1] - dt).total_seconds()) / 60.0
                    if diff_before <= max_minutes:
                        best_diff = diff_before
                        best_candidate = gps_candidates[idx - 1][1]

                # 直後 (idx)
                if idx < len(gps_times):
                    diff_after = abs((gps_times[idx] - dt).total_seconds()) / 60.0
                    if diff_after <= max_minutes:
                        # 直前・直後で等しい場合は直後を採用（SQLite julianday の評価順と合致）
                        if best_diff is None or diff_after <= best_diff:
                            best_diff = diff_after
                            best_candidate = gps_candidates[idx][1]

                if best_candidate and best_candidate["latitude"] is not None:
                    update_params.append((
                        best_candidate["latitude"],
                        best_candidate["longitude"],
                        best_candidate["country"],
                        best_candidate["state"],
                        best_candidate["city"],
                        pid
                    ))

        # パース失敗した珍しいターゲットがあれば個別にフォールバック
        for pid, date_taken in unparsed_targets:
            cursor.execute(
                """
                SELECT latitude, longitude, country, state, city,
                       ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) AS time_diff_min
                FROM photos
                WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                  AND ABS(CAST((julianday(date_taken) - julianday(?)) * 24 * 60 AS REAL)) <= ?
                ORDER BY time_diff_min ASC
                LIMIT 1
                """,
                (date_taken, date_taken, max_minutes)
            )
            nearest = cursor.fetchone()
            if nearest and nearest["latitude"] is not None:
                update_params.append((
                    nearest["latitude"],
                    nearest["longitude"],
                    nearest["country"],
                    nearest["state"],
                    nearest["city"],
                    pid
                ))

        if update_params:
            cursor.executemany(
                """
                UPDATE photos
                SET latitude = ?, longitude = ?, gps_source = 'inferred',
                    country = ?, state = ?, city = ?,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                update_params
            )

        conn.commit()
        inferred_count = len(update_params)
        return {
            "inferred_count": inferred_count,
            "skipped_count": total_target - inferred_count,
            "total_target": total_target,
        }


def clear_inferred_gps(
    photo_ids: Optional[List[int]] = None,
    folder: Optional[str] = None
) -> int:
    """
    準用（gps_source = 'inferred'）された写真のGPSおよび地名をリセットする。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        if photo_ids:
            chunk_size = 500
            for i in range(0, len(photo_ids), chunk_size):
                chunk = photo_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    UPDATE photos
                    SET latitude = NULL, longitude = NULL, gps_source = NULL,
                        country = NULL, state = NULL, city = NULL,
                        meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id IN ({placeholders}) AND gps_source = 'inferred'
                    """,
                    chunk
                )
                updated += cursor.rowcount
        elif folder:
            dir_sql, dir_params = _directory_filter_sql(folder, recursive=True, column_name="directory_path")
            cursor.execute(
                f"""
                UPDATE photos
                SET latitude = NULL, longitude = NULL, gps_source = NULL,
                    country = NULL, state = NULL, city = NULL,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE {dir_sql} AND gps_source = 'inferred'
                """,
                dir_params
            )
            updated = cursor.rowcount
        else:
            return 0

        conn.commit()
        return updated


def clear_photo_gps(
    photo_ids: Optional[List[int]] = None,
    folder: Optional[str] = None
) -> int:
    """
    指定写真（またはフォルダ内写真）のSQLite上のジオタグ情報（緯度・経度・ソース・国・県・市）をリセットする。
    gps_sourceの種類を問わずクリアする。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        updated = 0
        if photo_ids:
            chunk_size = 500
            for i in range(0, len(photo_ids), chunk_size):
                chunk = photo_ids[i:i + chunk_size]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(
                    f"""
                    UPDATE photos
                    SET latitude = NULL, longitude = NULL, gps_source = NULL,
                        country = NULL, state = NULL, city = NULL,
                        meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                    WHERE id IN ({placeholders})
                    """,
                    chunk
                )
                updated += cursor.rowcount
        elif folder:
            dir_sql, dir_params = _directory_filter_sql(folder, recursive=True, column_name="directory_path")
            cursor.execute(
                f"""
                UPDATE photos
                SET latitude = NULL, longitude = NULL, gps_source = NULL,
                    country = NULL, state = NULL, city = NULL,
                    meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                WHERE {dir_sql}
                """,
                dir_params
            )
            updated = cursor.rowcount
        else:
            return 0

        conn.commit()
        return updated


def cleanup_invalid_zero_gps() -> int:
    """
    緯度経度が (0.0, 0.0) 付近の無効なGPSエラー（未測位/Null Island）データをSQLite上でリセットする。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE photos
            SET latitude = NULL, longitude = NULL, gps_source = NULL,
                country = NULL, state = NULL, city = NULL,
                meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
              AND ABS(latitude) < 0.0001 AND ABS(longitude) < 0.0001
            """
        )
        conn.commit()
        return cursor.rowcount


def batch_copy_gps(source_photo_id: int, target_photo_ids: List[int]) -> int:
    """指定した写真のGPSを複数の写真に一括コピーする"""
    from server.geocoder import reverse_geocode
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT latitude, longitude FROM photos WHERE id = ?", (source_photo_id,))
        source = cursor.fetchone()
        if not source or source["latitude"] is None or source["longitude"] is None:
            return 0
        lat, lng = source["latitude"], source["longitude"]
        loc = reverse_geocode(lat, lng, db_conn=conn)
        count = 0
        unique_ids = list(dict.fromkeys(target_photo_ids))
        for i in range(0, len(unique_ids), 500):
            chunk = unique_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"""UPDATE photos
                   SET latitude = ?, longitude = ?, gps_source = 'copied',
                       country = ?, state = ?, city = ?,
                       meta_dirty = 1, updated_at = CURRENT_TIMESTAMP
                   WHERE id IN ({placeholders})""",
                (lat, lng, loc.get("country"), loc.get("state"), loc.get("city"), *chunk),
            )
            count += cursor.rowcount
        conn.commit()
        return count


def backfill_photo_locations(limit: int = 5000) -> int:
    """
    GPS座標（latitude, longitude）があるが国・県・市（country）が未設定の写真に対して
    逆ジオコーディングを一括実行して地名を補完する。UPDATE を executemany で一括実行。
    """
    from server.geocoder import reverse_geocode
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, latitude, longitude
            FROM photos
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
              AND country IS NULL
            LIMIT ?
            """,
            (limit,)
        )
        rows = cursor.fetchall()
        if not rows:
            return 0

        update_params = []
        for row in rows:
            pid = row["id"]
            lat = row["latitude"]
            lon = row["longitude"]
            loc = reverse_geocode(lat, lon, db_conn=conn)
            update_params.append((loc.get("country"), loc.get("state"), loc.get("city"), pid))

        if update_params:
            cursor.executemany(
                """
                UPDATE photos
                SET country = ?, state = ?, city = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                update_params
            )

        conn.commit()
        return len(update_params)


def backfill_missing_lens_models(
    directory_path: Optional[str] = None,
    recursive: bool = True,
    only_interchangeable_cameras: bool = False,
    limit: int = 30000,
) -> int:
    """
    lens_model が未設定（NULL / 空文字 / '----'）の写真ファイルから、
    Panasonic MakerNote (0x0051) や XMP (aux:Lens) 等のレンズ機種名を高速抽出し、DBへ一括補完する。
    """
    from concurrent.futures import ThreadPoolExecutor
    from server.raw_loader import extract_fallback_lens_model, is_valid_lens_name
    from server.scanner import resolve_portable_path

    where_clauses = [
        "(is_unlinked IS NULL OR is_unlinked = 0)",
        "(lens_model IS NULL OR TRIM(lens_model) = '' OR lens_model = '----')",
    ]
    params: List[Any] = []

    if directory_path:
        dir_sql, dir_params = _directory_filter_sql(directory_path, recursive=recursive, column_name="directory_path")
        where_clauses.append(dir_sql)
        params.extend(dir_params)

    if only_interchangeable_cameras:
        where_clauses.append(
            "("
            "camera_model LIKE 'DC-%' OR camera_model LIKE 'DMC-G%' OR camera_model LIKE 'DMC-GH%' "
            "OR camera_model LIKE 'DMC-GF%' OR camera_model LIKE 'DMC-GX%' OR camera_model LIKE 'DMC-GM%' "
            "OR camera_model LIKE 'LUMIX%' OR camera_model LIKE 'NIKON D%' OR camera_model LIKE 'NIKON Z%' "
            "OR camera_model LIKE 'Canon EOS%' OR camera_model LIKE 'ILCE-%' OR camera_model LIKE 'NEX-%' "
            "OR camera_model LIKE 'sd Quattro%' OR camera_model LIKE 'DP%' OR is_raw = 1"
            ")"
        )

    params.append(limit)
    query = f"""
        SELECT id, file_path, volume_serial
        FROM photos
        WHERE {' AND '.join(where_clauses)}
        LIMIT ?
    """

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        rows = [(r["id"], r["file_path"], r["volume_serial"]) for r in cursor.fetchall()]

    if not rows:
        return 0

    def _probe_one(item: Tuple[int, str, Optional[str]]) -> Optional[Tuple[str, int]]:
        pid, fpath, vser = item
        try:
            target_path, is_online = resolve_portable_path(fpath, expected_serial=vser)
            if not is_online or not target_path:
                return None
            lens = extract_fallback_lens_model(target_path)
            if lens and is_valid_lens_name(lens):
                return (lens, pid)
        except Exception as e:
            logger.debug(f"レンズ機種名抽出失敗 ({fpath}): {e}")
        return None

    updated_total = 0
    chunk_size = 500
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i in range(0, len(rows), chunk_size):
            chunk = rows[i:i + chunk_size]
            results = [r for r in pool.map(_probe_one, chunk) if r is not None]
            if results:
                with get_connection() as conn:
                    cursor = conn.cursor()
                    cursor.executemany(
                        "UPDATE photos SET lens_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                        results,
                    )
                    conn.commit()
                    updated_total += len(results)

    return updated_total


def get_existing_photos_map(
    directory_path: str,
    recursive: bool = True,
    volume_serial: Optional[str] = None,
) -> Dict[str, Tuple[int, int, Optional[float]]]:
    """
    指定ディレクトリ配下の登録済み写真リンクの {file_path: (photo_id, file_size, file_mtime)} マップを取得する。
    volume_serial が指定されている場合は当該メディア（またはシリアル未設定）のリンクのみを対象とし、
    別SDカードの同名パス写真との混同を防止する。
    """
    sql_frag, params = _directory_filter_sql_with_vsn(
        directory_path,
        volume_serial=volume_serial,
        recursive=recursive,
        column_name="pl.directory_path",
        vsn_column="pl.volume_serial",
    )
    if volume_serial and volume_serial.strip():
        vsn_sql, vsn_params = _vsn_in_sql("pl.volume_serial", volume_serial.strip())
        sql_frag = f"({sql_frag}) AND ({vsn_sql} OR pl.volume_serial = '')"
        params.extend(vsn_params)

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT p.id, pl.file_path, p.file_size, COALESCE(pl.file_mtime, p.file_mtime) AS file_mtime
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            WHERE {sql_frag}
            """,
            params,
        )
        res = {}
        for row in cursor.fetchall():
            clean_fp = _strip_vsn_prefix_raw(row["file_path"])
            val = (row["id"], row["file_size"], row["file_mtime"])
            res[clean_fp] = val
            res[os.path.normcase(os.path.abspath(clean_fp))] = val
        return res


def get_photo_by_path(file_path: str, volume_serial: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    ファイルパス（およびオプションのVSN）で写真情報を取得する。
    photo_links から該当リンクを特定し、リンク固有のパス情報を反映して返す。
    """
    vsn_norm, rel_path, _, clean_fp, _ = _split_link_path(file_path, None, volume_serial)
    with get_connection() as conn:
        cursor = conn.cursor()
        link_row = None
        if vsn_norm:
            cursor.execute(
                "SELECT * FROM photo_links WHERE volume_serial = ? AND rel_path = ? COLLATE NOCASE LIMIT 1",
                (vsn_norm, rel_path),
            )
            link_row = cursor.fetchone()
            if not link_row:
                cursor.execute(
                    "SELECT * FROM photo_links WHERE volume_serial = '' AND file_path = ? COLLATE NOCASE LIMIT 1",
                    (clean_fp,),
                )
                link_row = cursor.fetchone()
        else:
            cursor.execute(
                "SELECT * FROM photo_links WHERE file_path = ? COLLATE NOCASE ORDER BY is_primary DESC, id ASC LIMIT 1",
                (clean_fp,),
            )
            link_row = cursor.fetchone()

        if link_row:
            cursor.execute("SELECT * FROM photos WHERE id = ?", (link_row["photo_id"],))
            prow = cursor.fetchone()
            if prow:
                d = dict(prow)
                d["file_path"] = _strip_vsn_prefix_raw(link_row["file_path"])
                d["directory_path"] = link_row["directory_path"]
                d["file_name"] = link_row["file_name"]
                d["volume_serial"] = link_row["volume_serial"] or None
                if link_row["file_mtime"] is not None:
                    d["file_mtime"] = link_row["file_mtime"]
                d["paired_raw_path"] = link_row["paired_raw_path"]
                return d

        # フォールバック: リンク消失中 (is_unlinked=1) 等の photos.file_path 直接照合
        cursor.execute("SELECT * FROM photos WHERE file_path = ? COLLATE NOCASE", (clean_fp,))
        row = cursor.fetchone()
        if row:
            row_vs = (row["volume_serial"] or "").strip().upper()
            if not vsn_norm or not row_vs or row_vs == vsn_norm:
                d = dict(row)
                d["file_path"] = _strip_vsn_prefix_raw(d.get("file_path"))
                return d
        return None


def find_missing_photo_match(
    file_name: str,
    file_size: int,
    date_taken: Optional[str] = None,
    camera_model: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    リンク消失状態 (is_unlinked=1) または接続中（オンライン）ドライブ上で実ファイルが既に存在しなくなった
    既存写真レコードの中から、Exif撮影日時・ファイルサイズ・ファイル名などの特徴量が一致する同一写真を照合・探索する。
    """
    from ..scanner import resolve_portable_path
    with get_connection() as conn:
        cursor = conn.cursor()

        def _is_unlinked_or_online_missing(row_obj) -> bool:
            if int(row_obj["is_unlinked"] or 0) == 1 or int(row_obj["link_count"] or 0) == 0:
                return True
            dir_p = row_obj["directory_path"]
            v_ser = row_obj["volume_serial"]
            if not dir_p:
                return False
            _, is_dir_online = resolve_portable_path(dir_p, expected_serial=v_ser)
            if not is_dir_online:
                return False
            f_path, _ = resolve_portable_path(row_obj["file_path"], expected_serial=v_ser)
            return not os.path.exists(str(f_path))

        if date_taken:
            cursor.execute(
                """
                SELECT * FROM photos
                WHERE file_name = ? AND (date_taken = ? OR original_date_taken = ?) AND file_size = ?
                """,
                (file_name, date_taken, date_taken, file_size),
            )
            for row in cursor.fetchall():
                if _is_unlinked_or_online_missing(row):
                    return dict(row)

        if date_taken and camera_model and camera_model != "不明":
            cursor.execute(
                """
                SELECT * FROM photos
                WHERE (date_taken = ? OR original_date_taken = ?) AND file_size = ? AND camera_model = ?
                """,
                (date_taken, date_taken, file_size, camera_model),
            )
            for row in cursor.fetchall():
                if _is_unlinked_or_online_missing(row):
                    return dict(row)

        cursor.execute(
            """
            SELECT * FROM photos
            WHERE file_name = ? AND file_size = ?
            """,
            (file_name, file_size),
        )
        for row in cursor.fetchall():
            if _is_unlinked_or_online_missing(row):
                return dict(row)

        return None


def relink_photo_path(
    photo_id: int,
    new_path: str,
    new_dir: str,
    new_volume_serial: Optional[str] = None,
) -> bool:
    """移動した写真レコードのリンク情報（photo_links および代表パス）を更新し、既存のタグ・評価を完全維持して再紐付けする"""
    from ..scanner import resolve_portable_path
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, volume_serial FROM photos WHERE id = ?", (photo_id,))
        prow = cursor.fetchone()
        if not prow:
            return False

        eff_vsn = new_volume_serial if new_volume_serial is not None else prow["volume_serial"]
        vsn_norm, rel_path, rel_dir, clean_fp, clean_dir = _split_link_path(new_path, new_dir, eff_vsn)
        fname = os.path.basename(clean_fp)

        # オンラインで実ファイルが消えている古いリンクがあれば除去
        cursor.execute("SELECT id, file_path, directory_path, volume_serial FROM photo_links WHERE photo_id = ?", (photo_id,))
        old_links = cursor.fetchall()
        dead_ids = []
        for lk in old_links:
            try:
                _, is_online = resolve_portable_path(lk["directory_path"], expected_serial=lk["volume_serial"] or None)
                if is_online:
                    f_p, _ = resolve_portable_path(lk["file_path"], expected_serial=lk["volume_serial"] or None)
                    if not os.path.exists(str(f_p)):
                        dead_ids.append(lk["id"])
            except Exception:
                pass
        if len(old_links) == 1 and not dead_ids:
            dead_ids = [old_links[0]["id"]]
        if dead_ids:
            ph = ",".join(["?"] * len(dead_ids))
            cursor.execute(f"DELETE FROM photo_links WHERE id IN ({ph})", dead_ids)

        cursor.execute(
            """
            INSERT INTO photo_links (
                photo_id, volume_serial, rel_path, rel_dir,
                file_path, directory_path, file_name, is_primary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(volume_serial, rel_path) DO UPDATE SET
                photo_id = excluded.photo_id,
                rel_dir = excluded.rel_dir,
                file_path = excluded.file_path,
                directory_path = excluded.directory_path,
                file_name = excluded.file_name,
                is_primary = 1,
                updated_at = CURRENT_TIMESTAMP
            """,
            (photo_id, vsn_norm, rel_path, rel_dir, clean_fp, clean_dir, fname),
        )
        new_link_id = cursor.lastrowid
        _sync_photo_links_state(cursor, photo_id, preferred_link_id=new_link_id)
        conn.commit()
        return True


def cleanup_missing_photos_in_folder(
    directory_path: str,
    recursive: bool = False,
    volume_serial: Optional[str] = None,
) -> int:
    """
    指定フォルダのファイル存在チェックを行い、実ファイルが消えているリンクを photo_links から解除する。
    - 他メディア・他フォルダに有効なリンクが残っている写真は残存リンクを代表にして通常表示（is_unlinked = 0）を維持する。
    - 有効なリンクが0本になった写真は DB から物理削除せず、is_unlinked = 1（「リンク消失の写真」リスト）へ移行して
      明示的にパージされるまでサムネイル・タグ・評価を保持する。
    """
    return unlink_missing_photos_in_folder(
        directory_path=directory_path,
        recursive=recursive,
        volume_serial=volume_serial,
    )


def cleanup_missing_upload_photos(upload_dir: Path) -> int:
    """
    storage（旧 carry）フォルダ配下の写真リンクで、実ファイルが削除されたものをDBからクリーンアップする。
    """
    from ..scanner import resolve_portable_path

    upload_dir_resolved = upload_dir.resolve()
    upload_dir_str = str(upload_dir_resolved).rstrip("\\/")
    upload_dir_low = upload_dir_str.lower()

    dir_sql, dir_params = _directory_filter_sql(upload_dir_str, recursive=True, column_name="pl.directory_path")
    fp_sql, fp_params = _directory_filter_sql(upload_dir_str, recursive=True, column_name="pl.file_path")

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT pl.id AS link_id, pl.photo_id, pl.file_path, pl.directory_path
            FROM photo_links pl
            WHERE {dir_sql} OR {fp_sql}
            """,
            dir_params + fp_params,
        )
        rows = cursor.fetchall()
        if not rows:
            return 0

        missing_link_ids: List[int] = []
        affected_photo_ids: set = set()
        for r in rows:
            raw_fp = _strip_vsn_prefix_raw(r["file_path"] or "")
            p_path = Path(raw_fp)
            is_present = p_path.exists()

            if not is_present:
                resolved_p, is_online = resolve_portable_path(raw_fp)
                if is_online and resolved_p.exists():
                    is_present = True

            if not is_present:
                norm_fp = raw_fp.replace("/", "\\")
                if norm_fp.lower().startswith(upload_dir_low + "\\"):
                    rel_sub = norm_fp[len(upload_dir_str):].lstrip("\\")
                    if rel_sub and (upload_dir_resolved / rel_sub).exists():
                        is_present = True

            if not is_present:
                missing_link_ids.append(r["link_id"])
                affected_photo_ids.add(r["photo_id"])

        if missing_link_ids:
            for i in range(0, len(missing_link_ids), 500):
                chunk = missing_link_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_links WHERE id IN ({placeholders})", chunk)

            zero_link_photo_ids: List[int] = []
            for pid in affected_photo_ids:
                rem = _sync_photo_links_state(cursor, pid)
                if rem == 0:
                    zero_link_photo_ids.append(pid)

            if zero_link_photo_ids:
                for i in range(0, len(zero_link_photo_ids), 500):
                    chunk = zero_link_photo_ids[i:i + 500]
                    placeholders = ",".join(["?"] * len(chunk))
                    cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
                    cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
                    cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)

            conn.commit()
            print(f"[INFO] storage 内のリンク切れ写真 {len(missing_link_ids)} 件をDBから自動クリーンアップしました。")
            return len(missing_link_ids)
        return 0


def delete_photo_by_id(photo_id: int, delete_file: bool = False) -> bool:
    """指定されたIDの写真をDB（およびオプションで実ファイル）から削除する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT file_path, volume_serial FROM photos WHERE id = ?", (photo_id,))
        row = cursor.fetchone()
        if not row:
            return False

        file_path_str = row["file_path"]
        vol_serial = row["volume_serial"]

        cursor.execute("DELETE FROM photo_links WHERE photo_id = ?", (photo_id,))
        cursor.execute("DELETE FROM thumbnails WHERE photo_id = ?", (photo_id,))
        cursor.execute("DELETE FROM photo_tags WHERE photo_id = ?", (photo_id,))
        cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        conn.commit()

        if delete_file and file_path_str:
            try:
                from ..scanner import resolve_portable_path
                real_path, is_online = resolve_portable_path(file_path_str, expected_serial=vol_serial)
                if is_online and real_path.is_file():
                    real_path.unlink()
            except Exception as e:
                logger.warning(f"実ファイルの削除に失敗しました: {e}")

        return True


def delete_photos_by_ids(photo_ids: List[int]) -> int:
    """
    複数の写真をDB（写真・リンク・タグ・サムネイル）から一括削除する。実ファイルは削除しない。
    """
    if not photo_ids:
        return 0
    with get_connection() as conn:
        cursor = conn.cursor()
        deleted = 0
        affected_dirs = set()
        for i in range(0, len(photo_ids), 500):
            chunk = photo_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(f"SELECT DISTINCT directory_path FROM photos WHERE id IN ({placeholders})", chunk)
            affected_dirs.update(r["directory_path"] for r in cursor.fetchall() if r["directory_path"])
            cursor.execute(f"DELETE FROM photo_links WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)
            deleted += cursor.rowcount
        conn.commit()

    for d in affected_dirs:
        try:
            from .stacks import recalculate_stacks
            recalculate_stacks(d, recursive=False)
        except Exception as stack_err:
            print(f"[WARN] スタック修復エラー（削除自体は完了） ({d}): {stack_err}")
    return deleted


def get_photo_brief(photo_id: int) -> Optional[Dict[str, Any]]:
    """サムネイルおよびビューワ画像配信のための軽量な写真情報を取得する（代表リンクがオフラインの場合もオンラインリンクがあれば自動補完）"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, file_name, file_path, volume_serial, file_size, file_mtime, date_taken, is_raw, paired_raw_path, rotation, fine_angle, crop_x, crop_y, crop_w, crop_h, crop_aspect, brightness, contrast, saturation, link_count FROM photos WHERE id = ?",
            (photo_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["file_path"] = _strip_vsn_prefix_raw(d.get("file_path"))
        return d


def get_photos_brief_batch(photo_ids: List[int]) -> List[Dict[str, Any]]:
    """複数写真のサムネイル処理用軽量情報を一括取得する"""
    if not photo_ids:
        return []
    with get_connection() as conn:
        cursor = conn.cursor()
        results = []
        for i in range(0, len(photo_ids), 500):
            chunk = photo_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(
                f"SELECT id, file_name, file_path, volume_serial, file_size, file_mtime, date_taken, rotation, fine_angle, crop_x, crop_y, crop_w, crop_h, crop_aspect, brightness, contrast, saturation FROM photos WHERE id IN ({placeholders})",
                chunk,
            )
            for r in cursor.fetchall():
                d = dict(r)
                d["file_path"] = _strip_vsn_prefix_raw(d.get("file_path"))
                results.append(d)
        return results


def get_missing_photos(limit: int = 0) -> List[Dict[str, Any]]:
    """
    接続中（オンライン）のドライブ・フォルダに登録されているが、
    実ファイルが削除または移動されて見つからない写真リンクを抽出して返す。
    未接続（オフライン）の外部ドライブ・別SDカードのリンクは除外され、安全に保護される。
    """
    from ..scanner import resolve_portable_path, resolve_drive_online_path
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT p.*,
                   pl.id AS link_id,
                   pl.file_path AS link_file_path,
                   pl.directory_path AS link_directory_path,
                   pl.file_name AS link_file_name,
                   pl.volume_serial AS link_volume_serial,
                   t.width AS thumb_width,
                   t.height AS thumb_height,
                   v.volume_label,
                   COALESCE(v.custom_name, '') AS volume_custom_name,
                   v.drive_letter AS volume_drive,
                   CASE WHEN t.photo_id IS NOT NULL THEN 1 ELSE 0 END AS has_thumbnail
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            LEFT JOIN volumes v ON pl.volume_serial = v.volume_serial
            LEFT JOIN thumbnails t INDEXED BY idx_thumbnails_dims ON p.id = t.photo_id
            WHERE p.rating IN (0, 1, 2)
              AND (p.is_unlinked IS NULL OR p.is_unlinked = 0)
            ORDER BY p.date_taken DESC, pl.file_name ASC
            """
        )
        rows = cursor.fetchall()
        dir_online_cache: Dict[Tuple[str, str], bool] = {}
        dir_files_cache: Dict[Tuple[str, str], Optional[set]] = {}
        missing_photos: List[Dict[str, Any]] = []
        seen_photo_ids: set = set()

        for r in rows:
            pid = r["id"]
            if pid in seen_photo_ids:
                continue
            d_path = r["link_directory_path"]
            v_ser = r["link_volume_serial"] or ""
            cache_key = (d_path, v_ser)
            if cache_key not in dir_online_cache:
                resolved_dir, is_drive_online = resolve_drive_online_path(d_path, expected_serial=v_ser or None)
                dir_online_cache[cache_key] = is_drive_online
                if is_drive_online and resolved_dir and resolved_dir.exists():
                    try:
                        with os.scandir(str(resolved_dir)) as it:
                            dir_files_cache[cache_key] = {entry.name.lower() for entry in it}
                    except Exception:
                        dir_files_cache[cache_key] = None
                else:
                    dir_files_cache[cache_key] = None

            if dir_online_cache[cache_key]:
                file_set = dir_files_cache.get(cache_key)
                fname = r["link_file_name"] or os.path.basename(_strip_vsn_prefix_raw(r["link_file_path"] or ""))
                if file_set is not None and fname and fname.lower() in file_set:
                    continue
                f_path, _ = resolve_portable_path(r["link_file_path"], expected_serial=v_ser or None)
                if not os.path.exists(str(f_path)):
                    item = dict(r)
                    item["file_path"] = _strip_vsn_prefix_raw(r["link_file_path"])
                    item["directory_path"] = r["link_directory_path"]
                    item["file_name"] = r["link_file_name"]
                    item["volume_serial"] = r["link_volume_serial"] or None
                    item["is_missing"] = True
                    item["is_offline"] = False
                    item["stack_count"] = 1
                    item["stack_photos"] = []
                    missing_photos.append(item)
                    seen_photo_ids.add(pid)
                    if limit and limit > 0 and len(missing_photos) >= limit:
                        break

        if missing_photos:
            photo_ids = [p["id"] for p in missing_photos]
            tags_map: Dict[int, List[str]] = {}
            for i in range(0, len(photo_ids), 900):
                id_chunk = photo_ids[i:i + 900]
                cursor.execute(
                    f"SELECT photo_id, tag FROM photo_tags WHERE photo_id IN ({','.join(['?']*len(id_chunk))})",
                    id_chunk,
                )
                for tr in cursor.fetchall():
                    tags_map.setdefault(tr["photo_id"], []).append(tr["tag"])
            for p in missing_photos:
                p["tags"] = tags_map.get(p["id"], [])

        return missing_photos


def get_missing_photos_count() -> int:
    """実体パスが存在しない写真（オンラインドライブ内）の件数を取得する"""
    photos = get_missing_photos(limit=0)
    return len(photos)


def unlink_missing_photos_in_folder(
    directory_path: str,
    recursive: bool = False,
    volume_serial: Optional[str] = None,
) -> int:
    """
    指定フォルダ内で実ファイルが見つからないリンクを photo_links から削除する。
    - 他メディア・他フォルダにまだリンクが残っている写真は、残存リンクを代表にして通常表示（is_unlinked = 0）を維持する。
    - すべてのリンクが失われた（残りリンク0本になった）写真のみ is_unlinked = 1, link_count = 0 として
      「リンク消失の写真」リストへ移行し、明示的にパージされるまでサムネイル・タグ・評価を保持する。
    """
    from ..scanner import resolve_drive_online_path, clear_online_cache
    from .folders import clear_folders_fs_cache

    clear_online_cache()
    clear_folders_fs_cache()

    sql_frag, sql_params = _build_folder_missing_filter(
        directory_path,
        recursive=recursive,
        volume_serial=volume_serial,
        column_name="pl.directory_path",
        vsn_column="pl.volume_serial",
    )
    if volume_serial and volume_serial.strip():
        vsn_sql, vsn_params = _vsn_in_sql("pl.volume_serial", volume_serial.strip())
        sql_frag = f"({sql_frag}) AND ({vsn_sql} OR pl.volume_serial = '')"
        sql_params.extend(vsn_params)

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            f"""
            SELECT pl.id AS link_id, pl.photo_id, pl.file_path, pl.directory_path, pl.volume_serial
            FROM photo_links pl
            INNER JOIN photos p ON pl.photo_id = p.id
            WHERE {sql_frag} AND (p.is_unlinked IS NULL OR p.is_unlinked = 0)
            """,
            sql_params,
        )
        rows = cursor.fetchall()
        missing_link_ids: List[int] = []
        affected_photo_ids: List[int] = []
        seen_pids: set = set()
        for r in rows:
            v_ser = r["volume_serial"] or volume_serial or None
            f_path, is_drive_online = resolve_drive_online_path(r["file_path"], expected_serial=v_ser)
            if not is_drive_online:
                continue
            if not os.path.exists(str(f_path)):
                missing_link_ids.append(r["link_id"])
                pid = r["photo_id"]
                if pid not in seen_pids:
                    seen_pids.add(pid)
                    affected_photo_ids.append(pid)

        # 対象ディレクトリ自体がOS上で削除済みの場合、scan_roots に残っている孤立ルートも掃除する
        norm_win = os.path.normpath(directory_path).rstrip("\\/")
        resolved_target_dir, is_target_drive_online = resolve_drive_online_path(
            directory_path, expected_serial=volume_serial or None
        )
        removed_scan_roots = False
        if is_target_drive_online:
            cursor.execute("SELECT folder_path FROM scan_roots")
            norm_win_lower = norm_win.lower()
            for sr_row in cursor.fetchall():
                sr_raw = sr_row["folder_path"]
                sr_norm = os.path.normpath(sr_raw).rstrip("\\/")
                sr_lower = sr_norm.lower()
                is_match = (sr_lower == norm_win_lower) or (
                    recursive and sr_lower.startswith(norm_win_lower + "\\")
                )
                if is_match:
                    sr_resolved, sr_online = resolve_drive_online_path(
                        sr_norm, expected_serial=volume_serial or None
                    )
                    if sr_online and not sr_resolved.exists():
                        cursor.execute("DELETE FROM scan_roots WHERE folder_path = ?", (sr_raw,))
                        removed_scan_roots = True

        if missing_link_ids or removed_scan_roots:
            for i in range(0, len(missing_link_ids), 500):
                chunk = missing_link_ids[i:i + 500]
                placeholders = ",".join(["?"] * len(chunk))
                cursor.execute(f"DELETE FROM photo_links WHERE id IN ({placeholders})", chunk)

            for pid in affected_photo_ids:
                _sync_photo_links_state(cursor, pid)

            conn.commit()
            invalidate_fast_cache()
            clear_folders_fs_cache()

            if missing_link_ids:
                try:
                    from .stacks import recalculate_stacks
                    recalculate_stacks(norm_win, recursive=recursive)
                except Exception as stack_err:
                    logger.warning(f"スタック修復スキップ: {stack_err}")

            return len(missing_link_ids)
        return 0


def get_unlinked_photos_count() -> int:
    """すべてのリンクが失われた（リンク消失: is_unlinked = 1）写真の件数を高速に取得する"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) AS cnt FROM photos "
            "WHERE is_unlinked = 1 AND NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL AND paired_raw_path != '')"
        )
        row = cursor.fetchone()
        return row["cnt"] if row else 0


def get_connection_counts() -> Dict[str, int]:
    """全写真（ペア済みRAW従属コマを除く）の「接続中」「未接続」「リンク消失」「合計」の件数を高速集計して返す"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT COALESCE(is_unlinked, 0) AS unlinked,
                   COALESCE(volume_serial, '') AS vsn,
                   COALESCE(directory_path, '') AS dir_path,
                   COUNT(*) AS cnt
            FROM photos
            WHERE NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL AND paired_raw_path != '')
            GROUP BY COALESCE(is_unlinked, 0), COALESCE(volume_serial, ''), COALESCE(directory_path, '')
            """
        )
        rows = cursor.fetchall()

    from ..storage_manager import STORAGE_DIR
    from ..scanner import resolve_drive_online_path
    storage_norm = str(STORAGE_DIR).replace("/", "\\").lower()

    online_count = 0
    offline_count = 0
    unlinked_count = 0

    for row in rows:
        cnt = int(row["cnt"] or 0)
        if int(row["unlinked"] or 0) == 1:
            unlinked_count += cnt
            continue
        dir_p = row["dir_path"] or ""
        vsn = (row["vsn"] or "").strip() or None
        norm_dir = dir_p.replace("/", "\\").lower()
        if dir_p and (norm_dir == storage_norm or norm_dir.startswith(storage_norm + "\\")):
            online_count += cnt
        elif dir_p and resolve_drive_online_path(dir_p, expected_serial=vsn)[1]:
            online_count += cnt
        else:
            offline_count += cnt

    if offline_count > 0:
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT p.id, p.directory_path, COALESCE(p.volume_serial, '') AS vsn,
                       pl.directory_path AS link_dir, COALESCE(pl.volume_serial, '') AS link_vsn
                FROM photos p
                JOIN photo_links pl ON pl.photo_id = p.id AND pl.is_primary = 0
                WHERE COALESCE(p.is_unlinked, 0) = 0
                  AND COALESCE(p.link_count, 1) > 1
                  AND NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')
                """
            )
            multi_rows = cursor.fetchall()
        if multi_rows:
            dir_online_memo: Dict[Tuple[str, Optional[str]], bool] = {}

            def _chk_online(dp: str, vs: str) -> bool:
                if not dp:
                    return False
                nd = dp.replace("/", "\\").lower()
                if nd == storage_norm or nd.startswith(storage_norm + "\\"):
                    return True
                k = (dp, (vs or "").strip() or None)
                if k not in dir_online_memo:
                    dir_online_memo[k] = bool(resolve_drive_online_path(dp, expected_serial=k[1])[1])
                return dir_online_memo[k]

            recovered_pids = set()
            for mr in multi_rows:
                pid = mr["id"]
                if pid in recovered_pids:
                    continue
                if not _chk_online(mr["directory_path"] or "", mr["vsn"] or ""):
                    if _chk_online(mr["link_dir"] or "", mr["link_vsn"] or ""):
                        recovered_pids.add(pid)
            if recovered_pids:
                shift_cnt = min(offline_count, len(recovered_pids))
                offline_count -= shift_cnt
                online_count += shift_cnt

    total_count = online_count + offline_count + unlinked_count
    return {
        "total_count": total_count,
        "online_count": online_count,
        "offline_count": offline_count,
        "unlinked_count": unlinked_count,
    }


def purge_unlinked_photos(photo_ids: Optional[List[int]] = None) -> int:
    """
    リンク消失した写真を、ユーザーの明示的な指示によりDB（サムネイル・タグ・メタデータ・リンク）から完全抹消する。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        if photo_ids is not None:
            if not photo_ids:
                return 0
            target_ids = list(photo_ids)
        else:
            cursor.execute("SELECT id FROM photos WHERE is_unlinked = 1")
            rows = cursor.fetchall()
            target_ids = [r["id"] for r in rows]

        if not target_ids:
            return 0

        for i in range(0, len(target_ids), 500):
            chunk = target_ids[i:i + 500]
            placeholders = ",".join(["?"] * len(chunk))
            cursor.execute(f"DELETE FROM photo_links WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM photo_tags WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM thumbnails WHERE photo_id IN ({placeholders})", chunk)
            cursor.execute(f"DELETE FROM photos WHERE id IN ({placeholders})", chunk)

        cursor.execute("DELETE FROM thumbnails WHERE photo_id NOT IN (SELECT id FROM photos)")
        conn.commit()
        return len(target_ids)


def get_location_tree_summary() -> Dict[str, Any]:
    """
    左ペイン用の国・都道府県・市区町村の階層ツリー構造および写真枚数を集計して返す。
    インデックス idx_photos_location により高速にGROUP BY集計を行う。
    """
    try:
        backfill_photo_locations(limit=5000)
    except Exception as e:
        logger.warning(f"場所ツリー集計前の自動逆ジオコーディングをスキップしました: {e}")

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 位置情報付き写真の国・県・市ごとの集計
        cursor.execute(
            """
            SELECT country, state, city, COUNT(*) as cnt
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND country IS NOT NULL AND country != ''
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
            GROUP BY country, state, city
            ORDER BY country ASC, state ASC, city ASC
            """
        )
        rows = cursor.fetchall()

        country_dict: Dict[str, Any] = {}

        for row in rows:
            c = row["country"]
            s = row["state"] or "その他"
            ci = row["city"] or "その他"
            cnt = row["cnt"]

            if c not in country_dict:
                country_dict[c] = {"count": 0, "states": {}}

            country_dict[c]["count"] += cnt

            if s not in country_dict[c]["states"]:
                country_dict[c]["states"][s] = {"count": 0, "cities": []}

            country_dict[c]["states"][s]["count"] += cnt
            country_dict[c]["states"][s]["cities"].append({"city": ci, "count": cnt})

        # 配列構造へ変換（国・都道府県・市区町村ともに枚数降順）
        tree = []
        for c_name, c_data in sorted(country_dict.items(), key=lambda x: x[1]["count"], reverse=True):
            states_list = []
            for s_name, s_data in sorted(c_data["states"].items(), key=lambda x: x[1]["count"], reverse=True):
                cities_list = sorted(s_data["cities"], key=lambda x: x["count"], reverse=True)
                states_list.append({
                    "state": s_name,
                    "count": s_data["count"],
                    "cities": cities_list,
                })
            tree.append({
                "country": c_name,
                "count": c_data["count"],
                "states": states_list,
            })

        # 2. 位置情報なし写真の件数
        cursor.execute(
            """
            SELECT COUNT(*) as cnt
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND (latitude IS NULL OR country IS NULL OR country = ''
                   OR (ABS(latitude) < 0.0001 AND ABS(longitude) < 0.0001))
            """
        )
        no_loc_row = cursor.fetchone()
        no_loc_count = no_loc_row["cnt"] if no_loc_row else 0

        return {
            "tree": tree,
            "no_location_count": no_loc_count,
        }
