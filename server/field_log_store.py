"""
フィールドログ（GPS足跡ログ）の日付別 JSONL ストレージ管理モジュール

保存構造:
  cache/field_logs/<device_id>/<YYYY-MM-DD>.jsonl
  cache/field_logs/<device_id>/device.json
  cache/field_logs/_batches/<batch_id>.json  (照合適用履歴 — ログ削除対象外)
"""

import datetime
import hashlib
import json
import logging
import math
import os
import re
import threading
from datetime import date as _date_cls, datetime as _dt_cls, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from xml.sax.saxutils import escape as _xml_escape

logger = logging.getLogger("photo_manager.field_log_store")

BASE_DIR: Path = Path(__file__).resolve().parent.parent
FIELD_LOGS_DIR: Path = BASE_DIR / "cache" / "field_logs"

MAX_DAY_BYTES: int = 8 * 1024 * 1024  # 8MB / 日
DEVICE_ID_RE = re.compile(r"^[0-9a-f-]{8,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
BATCHES_DIR_NAME = "_batches"


class FieldLogTooLargeError(ValueError):
    """1日分のフィールドログがサイズ上限を超えた場合の例外"""


def get_field_logs_root() -> Path:
    """現在のフィールドログ保存ルートディレクトリを返す（テスト差し替え対応）"""
    return Path(FIELD_LOGS_DIR)


def validate_device_id(device_id: str) -> str:
    """device_id を厳格検証して返す（パストラバーサル防止）"""
    if not isinstance(device_id, str):
        raise ValueError("device_id が文字列ではありません")
    cleaned = device_id.strip()
    if not DEVICE_ID_RE.match(cleaned):
        raise ValueError(f"不正な device_id 形式です: {device_id!r}")
    return cleaned


def validate_date_str(date_str: str) -> str:
    """YYYY-MM-DD 形式かつ実在する暦日であることを検証して返す"""
    if not isinstance(date_str, str):
        raise ValueError("date が文字列ではありません")
    cleaned = date_str.strip()
    if not DATE_RE.match(cleaned):
        raise ValueError(f"不正な日付形式です: {date_str!r}")
    try:
        _date_cls.fromisoformat(cleaned)
    except ValueError as e:
        raise ValueError(f"存在しない暦日です: {date_str!r}") from e
    return cleaned


def _resolve_safe_device_dir(root_dir: Path, device_id: str) -> Path:
    """検証済み device_id から安全なサブディレクトリパスを組み立て、ルート配下であることを二重確認する"""
    dev_id = validate_device_id(device_id)
    root_resolved = root_dir.resolve()
    target = (root_resolved / dev_id).resolve()
    if target.parent != root_resolved:
        raise ValueError("不正な保存先パスが検出されました")
    return target


def _sanitize_device_name(name: Optional[str]) -> str:
    """端末表示名から制御文字等を除去して安全な文字列に整える"""
    if not name:
        return ""
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", str(name)).strip()
    return cleaned[:64]


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """2地点間の大圏距離（メートル）を算出する"""
    r_earth = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * (math.sin(d_lam / 2.0) ** 2)
    a = min(1.0, max(0.0, a))
    return 2.0 * r_earth * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def _is_valid_lat_lon(lat: Any, lon: Any) -> bool:
    """有効な緯度・経度数値かどうかを判定する"""
    if isinstance(lat, bool) or isinstance(lon, bool):
        return False
    try:
        f_lat = float(lat)
        f_lon = float(lon)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(f_lat) and math.isfinite(f_lon)):
        return False
    if not (-90.0 <= f_lat <= 90.0 and -180.0 <= f_lon <= 180.0):
        return False
    if abs(f_lat) < 1e-6 and abs(f_lon) < 1e-6:
        return False
    return True


def _parse_jsonl_lines(text: str, strict_middle_lines: bool = False) -> List[Dict[str, Any]]:
    """
    JSONL テキストをパースしてレコード辞書リストを返す。
    最終行の途中切れ（クラッシュ耐性）は常に許容して読み飛ばす。
    strict_middle_lines=True の場合、最終行以外の破損行は ValueError とする。
    """
    raw_lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not raw_lines:
        if strict_middle_lines:
            raise ValueError("フィールドログの内容が空です")
        return []

    records: List[Dict[str, Any]] = []
    last_idx = len(raw_lines) - 1
    for idx, line in enumerate(raw_lines):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            if idx == last_idx:
                logger.debug(f"JSONL 最終行の途中切れをスキップしました: {e}")
                continue
            if strict_middle_lines:
                raise ValueError(f"JSONL の {idx + 1} 行目が不正です: {e}") from e
            logger.warning(f"破損した JSONL 行 ({idx + 1}行目) をスキップしました: {e}")
            continue

        if not isinstance(obj, dict):
            if idx == last_idx and not strict_middle_lines:
                continue
            if strict_middle_lines:
                raise ValueError(f"JSONL の {idx + 1} 行目がオブジェクトではありません")
            continue
        records.append(obj)

    if strict_middle_lines and not records:
        raise ValueError("有効な JSONL レコードが1件も含まれていません")
    return records


def _extract_valid_point(rec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """レコードが有効な pt 行であれば正規化した点辞書を返す"""
    if rec.get("type") != "pt":
        return None
    t_raw = rec.get("t")
    if isinstance(t_raw, bool) or t_raw is None:
        return None
    try:
        t_ms = int(t_raw)
    except (TypeError, ValueError):
        return None
    lat_raw = rec.get("lat")
    lon_raw = rec.get("lon")
    if not _is_valid_lat_lon(lat_raw, lon_raw):
        return None

    pt: Dict[str, Any] = {
        "type": "pt",
        "t": t_ms,
        "lat": float(lat_raw),
        "lon": float(lon_raw),
    }
    tz_raw = rec.get("tz")
    if tz_raw is not None and not isinstance(tz_raw, bool):
        try:
            pt["tz"] = int(tz_raw)
        except (TypeError, ValueError):
            pass
    for opt_key in ("acc", "alt", "spd"):
        val = rec.get(opt_key)
        if val is not None and not isinstance(val, bool):
            try:
                f_val = float(val)
                if math.isfinite(f_val):
                    pt[opt_key] = f_val
            except (TypeError, ValueError):
                pass
    if isinstance(rec.get("prov"), str):
        pt["prov"] = rec["prov"]
    return pt


def _format_point_local_time(pt: Dict[str, Any]) -> str:
    """点レコードの t と tz から記録時点のローカル時刻文字列 HH:MM:SS を生成する"""
    t_sec = int(pt["t"]) / 1000.0
    tz_min = pt.get("tz")
    if tz_min is not None:
        tz_info = timezone(timedelta(minutes=int(tz_min)))
        return _dt_cls.fromtimestamp(t_sec, tz=tz_info).strftime("%H:%M:%S")
    return _dt_cls.fromtimestamp(t_sec).strftime("%H:%M:%S")


def _atomic_write_bytes(target_path: Path, data: bytes) -> None:
    """一時ファイルへ書き出してから os.replace でアトミックに置換保存する"""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.parent / f".{target_path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(tmp_path, "wb") as f:
            f.write(data)
        os.replace(str(tmp_path), str(target_path))
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception as cleanup_err:
            logger.debug(f"一時ファイル削除スキップ ({tmp_path}): {cleanup_err}")
        raise


def save_uploaded_day(
    device_id: str,
    device_name: str,
    date_str: str,
    sha256_hex: str,
    content_str: str,
) -> Dict[str, Any]:
    """
    スマホからアップロードされた1日分の JSONL ログを検証してアトミック保存する。
    """
    dev_id = validate_device_id(device_id)
    dt_str = validate_date_str(date_str)
    if not isinstance(content_str, str):
        raise ValueError("content が文字列ではありません")

    content_bytes = content_str.encode("utf-8")
    if len(content_bytes) > MAX_DAY_BYTES:
        raise FieldLogTooLargeError(f"1日分のログサイズ上限（{MAX_DAY_BYTES} bytes）を超えています")

    if not isinstance(sha256_hex, str) or not SHA256_RE.match(sha256_hex.strip()):
        raise ValueError("sha256 の形式が不正です")
    expected_sha = sha256_hex.strip().lower()
    actual_sha = hashlib.sha256(content_bytes).hexdigest().lower()
    if actual_sha != expected_sha:
        raise ValueError("sha256 ハッシュが一致しません")

    records = _parse_jsonl_lines(content_str, strict_middle_lines=True)
    points_count = 0
    header_dev_name = ""
    for rec in records:
        rec_type = rec.get("type")
        if rec_type == "header" and not header_dev_name:
            header_dev_name = _sanitize_device_name(rec.get("device_name"))
        elif rec_type == "pt":
            if _extract_valid_point(rec) is None:
                raise ValueError("pt レコードの必須座標・時刻フィールドが不正です")
            points_count += 1

    root_dir = get_field_logs_root()
    dev_dir = _resolve_safe_device_dir(root_dir, dev_id)
    day_file = dev_dir / f"{dt_str}.jsonl"
    _atomic_write_bytes(day_file, content_bytes)

    # device.json の更新（ローカル時刻表記）
    dev_meta_path = dev_dir / "device.json"
    existing_name = ""
    if dev_meta_path.exists():
        try:
            old_meta = json.loads(dev_meta_path.read_text(encoding="utf-8"))
            if isinstance(old_meta, dict):
                existing_name = _sanitize_device_name(old_meta.get("device_name"))
        except Exception as e:
            logger.debug(f"既存 device.json 読込スキップ ({dev_meta_path}): {e}")

    final_name = _sanitize_device_name(device_name) or header_dev_name or existing_name or dev_id
    now_local = _dt_cls.now().strftime("%Y-%m-%d %H:%M:%S")
    meta_bytes = json.dumps(
        {"device_name": final_name, "last_upload_at": now_local},
        ensure_ascii=False,
        indent=2,
    ).encode("utf-8")
    _atomic_write_bytes(dev_meta_path, meta_bytes)

    return {
        "ok": True,
        "date": dt_str,
        "points": points_count,
        "sha256": actual_sha,
    }


def _summarize_day_file(jsonl_path: Path, date_str: str) -> Tuple[Dict[str, Any], str]:
    """1日分の JSONL ファイルを集計し、(day_summary, header_device_name) を返す"""
    byte_size = jsonl_path.stat().st_size
    text = jsonl_path.read_text(encoding="utf-8", errors="replace")
    records = _parse_jsonl_lines(text, strict_middle_lines=False)

    header_name = ""
    pts: List[Dict[str, Any]] = []
    for rec in records:
        if rec.get("type") == "header" and not header_name:
            header_name = _sanitize_device_name(rec.get("device_name"))
        else:
            pt = _extract_valid_point(rec)
            if pt is not None:
                pts.append(pt)

    pts.sort(key=lambda p: p["t"])
    total_dist = 0.0
    for i in range(1, len(pts)):
        total_dist += _haversine_m(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])

    first_str: Optional[str] = _format_point_local_time(pts[0]) if pts else None
    last_str: Optional[str] = _format_point_local_time(pts[-1]) if pts else None
    first_t: Optional[int] = pts[0]["t"] if pts else None
    last_t: Optional[int] = pts[-1]["t"] if pts else None

    summary = {
        "date": date_str,
        "points": len(pts),
        "first": first_str,
        "last": last_str,
        "first_t": first_t,
        "last_t": last_t,
        "distance_m": round(total_dist, 1),
        "bytes": byte_size,
    }
    return summary, header_name


def list_field_logs() -> Dict[str, Any]:
    """
    保存されている全デバイスのフィールドログ一覧を集計して返す。
    USB SAF 直書きで device.json が存在しない場合も JSONL の header 行から端末名を補完する。
    """
    root_dir = get_field_logs_root()
    if not root_dir.exists() or not root_dir.is_dir():
        return {"devices": []}

    devices: List[Dict[str, Any]] = []
    for child in sorted(root_dir.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or child.name == BATCHES_DIR_NAME:
            continue
        if not DEVICE_ID_RE.match(child.name):
            continue

        dev_id = child.name
        dev_name = ""
        last_upload_at: Optional[str] = None
        meta_path = child / "device.json"
        if meta_path.exists():
            try:
                meta_obj = json.loads(meta_path.read_text(encoding="utf-8"))
                if isinstance(meta_obj, dict):
                    dev_name = _sanitize_device_name(meta_obj.get("device_name"))
                    if isinstance(meta_obj.get("last_upload_at"), str):
                        last_upload_at = meta_obj["last_upload_at"]
            except Exception as e:
                logger.warning(f"device.json の読み込みに失敗 ({meta_path}): {e}")

        days: List[Dict[str, Any]] = []
        fallback_header_name = ""
        jsonl_files = sorted(child.glob("*.jsonl"), key=lambda p: p.stem, reverse=True)
        for jf in jsonl_files:
            stem = jf.stem
            if not DATE_RE.match(stem):
                continue
            try:
                _date_cls.fromisoformat(stem)
            except ValueError:
                continue
            try:
                day_summary, hdr_name = _summarize_day_file(jf, stem)
                days.append(day_summary)
                if not fallback_header_name and hdr_name:
                    fallback_header_name = hdr_name
            except Exception as e:
                logger.warning(f"フィールドログ集計スキップ ({jf}): {e}")

        if not days:
            continue

        devices.append({
            "device_id": dev_id,
            "device_name": dev_name or fallback_header_name or dev_id,
            "last_upload_at": last_upload_at,
            "days": days,
        })

    # 最新の日付を持つデバイスを先頭に並べる
    devices.sort(key=lambda d: (d["days"][0]["date"] if d["days"] else "", d["device_id"]), reverse=True)
    return {"devices": devices}


def _cleanup_device_dir_if_empty(dev_dir: Path) -> None:
    """デバイスフォルダ内に .jsonl が1件も残っていなければ device.json と空フォルダを整理する"""
    try:
        if not dev_dir.exists() or not dev_dir.is_dir():
            return
        remaining_jsonl = list(dev_dir.glob("*.jsonl"))
        if remaining_jsonl:
            return
        meta_file = dev_dir / "device.json"
        if meta_file.exists():
            meta_file.unlink(missing_ok=True)
        for tmp_f in dev_dir.glob(".*.tmp"):
            tmp_f.unlink(missing_ok=True)
        if not any(dev_dir.iterdir()):
            dev_dir.rmdir()
    except Exception as e:
        logger.debug(f"空デバイスフォルダ整理スキップ ({dev_dir}): {e}")


def delete_field_logs(
    targets: Optional[List[Dict[str, str]]] = None,
    delete_all: bool = False,
) -> Dict[str, Any]:
    """
    指定日または全デバイスのフィールドログファイル (.jsonl) を削除する。
    _batches 内の適用履歴および DB 上の適用済み位置情報は一切削除しない。
    """
    root_dir = get_field_logs_root()
    deleted_count = 0

    if delete_all:
        if not root_dir.exists() or not root_dir.is_dir():
            return {"ok": True, "deleted": 0}
        for child in list(root_dir.iterdir()):
            if not child.is_dir() or child.name == BATCHES_DIR_NAME:
                continue
            if not DEVICE_ID_RE.match(child.name):
                continue
            for jf in list(child.glob("*.jsonl")):
                try:
                    jf.unlink()
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"フィールドログ削除失敗 ({jf}): {e}")
            _cleanup_device_dir_if_empty(child)
        return {"ok": True, "deleted": deleted_count}

    if not targets:
        return {"ok": True, "deleted": 0}

    # 全ターゲットを先に検証してから削除する
    validated_pairs: List[Tuple[Path, Path]] = []
    for item in targets:
        if not isinstance(item, dict):
            raise ValueError("削除ターゲットの形式が不正です")
        dev_id = validate_device_id(str(item.get("device_id") or ""))
        dt_str = validate_date_str(str(item.get("date") or ""))
        dev_dir = _resolve_safe_device_dir(root_dir, dev_id)
        validated_pairs.append((dev_dir, dev_dir / f"{dt_str}.jsonl"))

    touched_dirs: Set[Path] = set()
    for dev_dir, jf in validated_pairs:
        if jf.exists() and jf.is_file():
            jf.unlink()
            deleted_count += 1
            touched_dirs.add(dev_dir)

    for dev_dir in touched_dirs:
        _cleanup_device_dir_if_empty(dev_dir)

    return {"ok": True, "deleted": deleted_count}


def list_available_log_dates(device_id: Optional[str] = None) -> List[str]:
    """現在保存されているフィールドログの日付（YYYY-MM-DD）一覧を昇順で返す"""
    root_dir = get_field_logs_root()
    if not root_dir.exists() or not root_dir.is_dir():
        return []

    if device_id:
        dev_dir = _resolve_safe_device_dir(root_dir, device_id)
        dev_dirs = [dev_dir] if dev_dir.exists() and dev_dir.is_dir() else []
    else:
        dev_dirs = [
            p for p in root_dir.iterdir()
            if p.is_dir() and p.name != BATCHES_DIR_NAME and DEVICE_ID_RE.match(p.name)
        ]

    date_set: Set[str] = set()
    for d_dir in dev_dirs:
        for jf in d_dir.glob("*.jsonl"):
            if DATE_RE.match(jf.stem):
                try:
                    _date_cls.fromisoformat(jf.stem)
                    date_set.add(jf.stem)
                except ValueError:
                    continue
    return sorted(date_set)


def load_points_for_dates(
    dates: List[str],
    device_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    指定した日付群および日付境界またぎ対策の前後1日分の .jsonl から pt レコードを読み込み、
    t（UTC epoch ミリ秒）の昇順リストで返す。
    """
    if not dates:
        return []

    expanded_dates: Set[str] = set()
    for raw_d in dates:
        if not raw_d:
            continue
        dt_str = validate_date_str(raw_d)
        d_obj = _date_cls.fromisoformat(dt_str)
        expanded_dates.add((d_obj - timedelta(days=1)).isoformat())
        expanded_dates.add(d_obj.isoformat())
        expanded_dates.add((d_obj + timedelta(days=1)).isoformat())

    root_dir = get_field_logs_root()
    if not root_dir.exists() or not root_dir.is_dir():
        return []

    if device_id:
        dev_dir = _resolve_safe_device_dir(root_dir, device_id)
        dev_dirs = [dev_dir] if dev_dir.exists() and dev_dir.is_dir() else []
    else:
        dev_dirs = [
            p for p in sorted(root_dir.iterdir(), key=lambda x: x.name)
            if p.is_dir() and p.name != BATCHES_DIR_NAME and DEVICE_ID_RE.match(p.name)
        ]

    points: List[Dict[str, Any]] = []
    seen_keys: Set[Tuple[str, int]] = set()

    for d_dir in dev_dirs:
        for dt_str in sorted(expanded_dates):
            jf = d_dir / f"{dt_str}.jsonl"
            if not jf.exists() or not jf.is_file():
                continue
            try:
                text = jf.read_text(encoding="utf-8", errors="replace")
                records = _parse_jsonl_lines(text, strict_middle_lines=False)
                for rec in records:
                    pt = _extract_valid_point(rec)
                    if pt is not None:
                        dedup_key = (d_dir.name, pt["t"])
                        if dedup_key not in seen_keys:
                            seen_keys.add(dedup_key)
                            points.append(pt)
            except Exception as e:
                logger.warning(f"ログ点読込スキップ ({jf}): {e}")

    points.sort(key=lambda p: p["t"])
    return points


def export_day_gpx(device_id: str, date_str: str) -> str:
    """指定デバイス・日付のフィールドログを GPX 1.1 XML 文字列（UTF-8）に変換して返す"""
    dev_id = validate_device_id(device_id)
    dt_str = validate_date_str(date_str)
    root_dir = get_field_logs_root()
    dev_dir = _resolve_safe_device_dir(root_dir, dev_id)
    jf = dev_dir / f"{dt_str}.jsonl"
    if not jf.exists() or not jf.is_file():
        raise FileNotFoundError(f"指定されたフィールドログが見つかりません: {dev_id}/{dt_str}")

    text = jf.read_text(encoding="utf-8", errors="replace")
    records = _parse_jsonl_lines(text, strict_middle_lines=False)

    header_name = ""
    pts: List[Dict[str, Any]] = []
    for rec in records:
        if rec.get("type") == "header" and not header_name:
            header_name = _sanitize_device_name(rec.get("device_name"))
        else:
            pt = _extract_valid_point(rec)
            if pt is not None:
                pts.append(pt)

    pts.sort(key=lambda p: p["t"])

    dev_name = ""
    meta_path = dev_dir / "device.json"
    if meta_path.exists():
        try:
            meta_obj = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(meta_obj, dict):
                dev_name = _sanitize_device_name(meta_obj.get("device_name"))
        except Exception as e:
            logger.debug(f"GPX出力時の device.json 読込スキップ: {e}")

    track_title = f"{dev_name or header_name or dev_id} - {dt_str}"
    escaped_title = _xml_escape(track_title, {'"': "&quot;", "'": "&apos;"})

    lines: List[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Tetheract Photo Manager" xmlns="http://www.topografix.com/GPX/1/1">',
        "  <trk>",
        f"    <name>{escaped_title}</name>",
        "    <trkseg>",
    ]
    for pt in pts:
        lat_s = f"{pt['lat']:.7f}"
        lon_s = f"{pt['lon']:.7f}"
        utc_iso = _dt_cls.fromtimestamp(pt["t"] / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lines.append(f'      <trkpt lat="{lat_s}" lon="{lon_s}">')
        if "alt" in pt and pt["alt"] is not None:
            lines.append(f"        <ele>{pt['alt']:.2f}</ele>")
        lines.append(f"        <time>{utc_iso}</time>")
        lines.append("      </trkpt>")

    lines.extend([
        "    </trkseg>",
        "  </trk>",
        "</gpx>",
        "",
    ])
    return "\n".join(lines)
