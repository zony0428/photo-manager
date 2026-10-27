"""
画像スキャナ ＆ サムネイル生成モジュール
指定されたフォルダ内の画像を再帰的に走査し、EXIFメタデータの抽出および高速表示用WebPサムネイルの生成を行う。
"""

import os
import re
import io
import math
import hashlib
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from PIL import Image, ExifTags, ImageOps, ImageDraw, ImageEnhance

logger = logging.getLogger("scanner")

from .database import (
    CACHE_DIR,
    upsert_photo,
    upsert_photos_batch,
    get_existing_photos_map,
    get_photo_by_path,
    get_photo_brief,
    cleanup_missing_photos_in_folder,
    recalculate_stacks,
    save_thumbnail,
    get_thumbnail,
    delete_thumbnail,
    thumbnail_exists,
    find_existing_thumbnail_for_duplicate,
    compute_thumbnail_hash,
    find_duplicate_photo_match,
    copy_metadata_to_duplicate,
    upsert_volume,
    add_scan_root,
    extract_folder_fingerprint,
    verify_folder_fingerprint,
    get_scan_root_fingerprint,
    update_scan_root_fingerprint,
    get_ignored_folders,
    remove_ignored_folder,
    backfill_missing_lens_models,
)
from .database.folders import clear_folders_fs_cache

from .raw_loader import (
    is_raw_file,
    extract_raw_thumbnail_image,
    extract_raw_full_preview,
    extract_raw_metadata,
    extract_fallback_lens_model,
    is_valid_lens_name,
    SUPPORTED_RAW_EXTENSIONS,
)
from .volume_info import get_volume_info
from .shell_thumbnail import get_shell_thumbnail, is_cloud_or_ondemand_path


# サムネイルキャッシュ用ディレクトリ（旧ファイル方式・移行時の参照用に保持）
THUMBNAIL_DIR = CACHE_DIR / "thumbnails"

# 対象画像拡張子（通常画像 + 各社RAW）
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".tif", ".heic", ".heif", ".avif"}
SUPPORTED_EXTENSIONS = SUPPORTED_IMAGE_EXTENSIONS | SUPPORTED_RAW_EXTENSIONS

# EXIFタグの逆引きマッピング作成
EXIF_TAG_DICT = {ExifTags.TAGS[k]: k for k in ExifTags.TAGS}

# オンデマンド未ダウンロード用プレースホルダーWebPのメモリキャッシュ
_ONDEMAND_PLACEHOLDER_CACHE: Optional[bytes] = None


def sanitize_camera_model(model: Optional[str]) -> str:
    """
    カメラ機種名からNUL文字（\\x00）や不可視制御文字を除去し、安全な文字列にサニタイズする。
    HTC端末や一部のデジカメでExifのModelタグにNUL文字がパディングされる問題を防ぐ。
    """
    if not model:
        return "不明"
    cleaned = str(model).replace("\x00", "").strip()
    return cleaned if cleaned else "不明"


def parse_filename_datetime(filename: str) -> Optional[str]:
    """
    ファイル名から撮影日時（YYYY-MM-DD HH:MM:SS）を高精度に抽出する。
    Exifが取得できない場合やオンデマンドファイルでダウンロードを回避する際に極めて有効。
    対応パターン:
    1. YYYY-MM-DD_HH.MM.SS / YYYY-MM-DD HH:MM:SS / YYYY-MM-DD_HH-MM-SS
    2. YYYYMMDD_HHMMSS / YYYYMMDDTHHMMSS (例: PXL_20231207_113523442.jpg, 20120902T012512.jpg)
    3. YYMMDD_HHMMSS (例: 141007_231845.JPG -> 2014-10-07 23:18:45)
    4. YYMMDD_HHMM (例: 071126_0325~0002.jpg -> 2007-11-26 03:25:00)
    ※ 深夜24時表記（例: 24.05.06）は翌日00時として安全に正規化
    """
    if not filename:
        return None

    # パターン1: YYYY-MM-DD_HH.MM.SS (または - / : 区切り)
    m = re.search(r"(\d{4})[-_](\d{2})[-_](\d{2})[\s_-](\d{2})[.:\-_](\d{2})[.:\-_](\d{2})", filename)
    if m:
        y, mo, d, h, mi, s = m.groups()
        h_int = int(h)
        if h_int == 24:
            h = "00"
            h_int = 0
        if 1 <= int(mo) <= 12 and 1 <= int(d) <= 31 and 0 <= h_int <= 23 and 0 <= int(mi) <= 59 and 0 <= int(s) <= 59:
            return f"{y}-{mo}-{d} {h}:{mi}:{s}"

    # パターン2: YYYYMMDD_HHMMSS または YYYYMMDDTHHMMSS (接頭辞 IMG_, PXL_, VID_ 等を許容)
    m = re.search(r"(?:IMG_|PXL_|VID_|DSC_|WP_)?(\d{4})(\d{2})(\d{2})[T_](\d{2})(\d{2})(\d{2})", filename)
    if m:
        y, mo, d, h, mi, s = m.groups()
        h_int = int(h)
        if h_int == 24:
            h = "00"
            h_int = 0
        if 1970 <= int(y) <= 2099 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31 and 0 <= h_int <= 23 and 0 <= int(mi) <= 59 and 0 <= int(s) <= 59:
            return f"{y}-{mo}-{d} {h}:{mi}:{s}"

    # パターン3: YYMMDD_HHMMSS (例: 141007_231845.JPG)
    m = re.search(r"^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})", filename)
    if m:
        yy, mo, d, h, mi, s = m.groups()
        yy_int = int(yy)
        yyyy = f"19{yy_int:02d}" if yy_int >= 70 else f"20{yy_int:02d}"
        if 1 <= int(mo) <= 12 and 1 <= int(d) <= 31 and 0 <= int(h) <= 23 and 0 <= int(mi) <= 59 and 0 <= int(s) <= 59:
            return f"{yyyy}-{mo}-{d} {h}:{mi}:{s}"

    # パターン4: YYMMDD_HHMM (例: 071126_0325~0002.jpg)
    m = re.search(r"^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})", filename)
    if m:
        yy, mo, d, h, mi = m.groups()
        yy_int = int(yy)
        yyyy = f"19{yy_int:02d}" if yy_int >= 70 else f"20{yy_int:02d}"
        if 1 <= int(mo) <= 12 and 1 <= int(d) <= 31 and 0 <= int(h) <= 23 and 0 <= int(mi) <= 59:
            return f"{yyyy}-{mo}-{d} {h}:{mi}:00"

    return None


def get_ondemand_placeholder_webp() -> bytes:
    """
    クラウド同期・オンデマンドファイルで未ダウンロード時に表示する
    ダークテーマに調和した軽量プレースホルダーWebPバイナリを返す。
    """
    global _ONDEMAND_PLACEHOLDER_CACHE
    if _ONDEMAND_PLACEHOLDER_CACHE is not None:
        return _ONDEMAND_PLACEHOLDER_CACHE

    width, height = 360, 270
    img = Image.new("RGB", (width, height), color=(24, 27, 34))
    draw = ImageDraw.Draw(img)

    # 雲アイコンとダウンロード矢印のシンプルな描画
    cx, cy = width // 2, height // 2 - 10
    # 雲のベース楕円
    draw.ellipse([cx - 40, cy - 15, cx + 40, cy + 25], fill=(45, 55, 72))
    draw.ellipse([cx - 25, cy - 35, cx + 15, cy + 15], fill=(45, 55, 72))
    draw.ellipse([cx + 5, cy - 25, cx + 35, cy + 15], fill=(45, 55, 72))
    # ダウンロード下向き矢印
    arrow_color = (99, 179, 237)
    draw.rectangle([cx - 4, cy - 5, cx + 4, cy + 20], fill=arrow_color)
    draw.polygon([(cx - 14, cy + 18), (cx + 14, cy + 18), (cx, cy + 32)], fill=arrow_color)

    # 枠線
    draw.rectangle([0, 0, width - 1, height - 1], outline=(38, 44, 56), width=2)

    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=80)
    _ONDEMAND_PLACEHOLDER_CACHE = buf.getvalue()
    return _ONDEMAND_PLACEHOLDER_CACHE


# ディレクトリ単位のオンライン判定TTLキャッシュ（5秒TTL、スレッドセーフ）
_online_cache_lock = threading.Lock()
_directory_online_cache: Dict[str, Tuple[bool, float]] = {}


def clear_online_cache() -> None:
    """ディレクトリオンライン判定キャッシュをクリアする"""
    with _online_cache_lock:
        _directory_online_cache.clear()


def resolve_portable_path(stored_path: str) -> Tuple[Path, bool]:
    """
    USBポータブル運用やPC間移動によるドライブレター変更に対応し、
    実写真ファイルの現在位置を動的に解決する。
    戻り値: (解決されたPath, ファイルが存在するかどうかのbool)
    """
    orig_path = Path(stored_path)
    parent_str = str(orig_path.parent)

    # 親ディレクトリのオンライン判定キャッシュを確認
    now = time.time()
    parent_known_offline = False
    with _online_cache_lock:
        cached = _directory_online_cache.get(parent_str)
        if cached is not None:
            is_online, expire_time = cached
            if now < expire_time and not is_online:
                parent_known_offline = True

    # 親ディレクトリがキャッシュ上オフラインなら、切断ドライブで数秒ブロックし得る元パスの確認だけを省く。
    # （手順1・2のローカル代替照合は常に行う。省くと同階層の別ファイル/フォルダが誤ってオフライン判定される）
    if not parent_known_offline and orig_path.exists():
        with _online_cache_lock:
            _directory_online_cache[parent_str] = (True, now + 5.0)
        return orig_path, True

    # 1. カレントドライブ（USBドライブ）上での相対パス照合
    base_dir = Path(__file__).resolve().parent.parent
    current_drive = base_dir.drive
    if current_drive and orig_path.drive and current_drive.lower() != orig_path.drive.lower():
        path_without_drive = str(orig_path)[len(orig_path.drive):].lstrip("\\/")
        candidate_same_drive = Path(f"{current_drive}\\{path_without_drive}")
        if candidate_same_drive.exists():
            return candidate_same_drive, True

    # 2. プロジェクト直下の "storage" ディレクトリ（サブフォルダ階層含む）を照合
    app_storage_dir = base_dir / "storage"
    if app_storage_dir.exists():
        norm_stored = str(orig_path).replace("/", "\\").rstrip("\\")
        lower_stored = norm_stored.lower()
        marker = "\\storage\\"
        idx_st = lower_stored.rfind(marker)
        if idx_st != -1:
            rel_in_storage = norm_stored[idx_st + len(marker):].lstrip("\\")
            if rel_in_storage:
                candidate_storage = app_storage_dir / rel_in_storage
                if candidate_storage.exists():
                    return candidate_storage, True
        elif lower_stored.endswith("\\storage"):
            return app_storage_dir, True

    # 3. プロジェクト直下の "photos" ディレクトリ内を照合
    app_photos_dir = base_dir / "photos"
    if app_photos_dir.exists():
        candidate_app_sub = app_photos_dir / orig_path.name
        if candidate_app_sub.exists():
            return candidate_app_sub, True
        if orig_path.parent.name:
            candidate_parent_sub = app_photos_dir / orig_path.parent.name / orig_path.name
            if candidate_parent_sub.exists():
                return candidate_parent_sub, True

    # 4. 見つからない場合はオフライン
    # 元パスの親ディレクトリの存在状態（ドライブ切断等の判定）をキャッシュ
    # （キャッシュは「元パスの親が実在するか」のみを表す。代替照合の成功では書き込まない）
    if not parent_known_offline:
        parent_online = orig_path.parent.exists()
        with _online_cache_lock:
            _directory_online_cache[parent_str] = (parent_online, now + 5.0)
    return orig_path, False


def parse_exif_date(date_str: Optional[str]) -> Optional[str]:
    """EXIFの日時文字列 (YYYY:MM:DD HH:MM:SS) を YYYY-MM-DD HH:MM:SS 形式に変換する"""
    if not date_str:
        return None
    try:
        # 例: "2023:05:14 14:23:10"
        cleaned = date_str.strip()
        dt = datetime.strptime(cleaned, "%Y:%m:%d %H:%M:%S")
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        # 日時パース失敗時はNone
        return None


def _parse_gps_coord(coord, ref) -> Optional[float]:
    """EXIF GPS座標（度分秒タプル + 方角ref）を十進度に変換する"""
    if not coord or not ref:
        return None
    try:
        # coord は ((度, 分母), (分, 分母), (秒, 分母)) または IFDRational のタプル
        def to_float(val):
            if isinstance(val, tuple) and len(val) == 2:
                return val[0] / val[1] if val[1] else 0.0
            return float(val)

        degrees = to_float(coord[0])
        minutes = to_float(coord[1])
        seconds = to_float(coord[2])
        decimal = degrees + minutes / 60.0 + seconds / 3600.0

        if ref in ('S', 'W'):
            decimal = -decimal
        return round(decimal, 7)
    except Exception:
        return None


def _apply_xmp_hardware_fallback(meta: Dict[str, Any], file_path: Path, fallback_dt_str: str) -> Dict[str, Any]:
    """
    Exifから取得できなかったハードウェア情報（レンズ機種名・カメラ機種名・撮影日時・GPS座標）がある場合のみ、
    付随する .xmp サイドカーからハードウェア情報を安全に補完する（評価・タグ・ビットマップ調整は自動反映しない）。
    """
    need_lens = not is_valid_lens_name(meta.get("lens_model"))
    need_cam = meta.get("camera_model") in (None, "", "不明", "RAW写真")
    need_dt = (not meta.get("date_taken")) or (meta.get("date_taken") == fallback_dt_str)
    need_gps = meta.get("latitude") is None or meta.get("longitude") is None

    if not (need_lens or need_cam or need_dt or need_gps):
        return meta

    try:
        from .sidecar import parse_xmp_for_photo
        xmp_info = parse_xmp_for_photo(file_path)
        if not xmp_info.get("has_xmp"):
            return meta
        hw = xmp_info.get("hardware") or {}
        if need_lens and hw.get("lens_model") and is_valid_lens_name(hw["lens_model"]):
            meta["lens_model"] = hw["lens_model"]
        if need_cam and hw.get("camera_model"):
            meta["camera_model"] = sanitize_camera_model(hw["camera_model"])
        if need_dt and hw.get("date_taken"):
            meta["date_taken"] = hw["date_taken"]
            meta["year_month"] = hw["date_taken"][:7] if len(hw["date_taken"]) >= 7 else ""
        if need_gps and hw.get("latitude") is not None and hw.get("longitude") is not None:
            meta["latitude"] = hw["latitude"]
            meta["longitude"] = hw["longitude"]
            meta["gps_source"] = meta.get("gps_source") or "exif"
            try:
                from server.geocoder import reverse_geocode
                loc = reverse_geocode(meta["latitude"], meta["longitude"])
                meta["country"] = loc.get("country")
                meta["state"] = loc.get("state")
                meta["city"] = loc.get("city")
            except Exception as geo_err:
                logger.warning(f"XMP GPS逆ジオコーディング失敗 ({file_path.name}): {geo_err}")
    except Exception as e:
        logger.debug(f"XMPハードウェア補完スキップ ({file_path.name}): {e}")

    return meta


def extract_metadata(file_path: Path) -> Dict[str, Any]:
    """画像ファイルから幅、高さ、撮影日時、カメラ機種などのメタデータを抽出する（RAW対応）"""
    if is_raw_file(file_path):
        raw_meta = extract_raw_metadata(file_path)
        try:
            fb_str = datetime.fromtimestamp(file_path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            fb_str = ""
        return _apply_xmp_hardware_fallback(raw_meta, file_path, fb_str)

    stat = file_path.stat()
    file_size = stat.st_size

    # デフォルト値（ファイル更新日時をフォールバックとして使用）
    fallback_dt = datetime.fromtimestamp(stat.st_mtime)
    date_taken = fallback_dt.strftime("%Y-%m-%d %H:%M:%S")
    camera_model = "不明"
    width = 0
    height = 0
    exposure_bias = 0.0
    shutter_speed = None
    f_number = None
    iso = None
    focal_length = None
    lens_model = None
    subsec_time = None
    latitude = None
    longitude = None

    try:
        with Image.open(file_path) as img:
            width, height = img.size

            # EXIFの向き情報（Orientation）に応じた自動回転を考慮
            exif = img.getexif()
            if exif:
                # サブIFD (Exif IFD) を取得
                exif_ifd = {}
                try:
                    exif_ifd = exif.get_ifd(0x8769)
                except (KeyError, AttributeError, ValueError) as e:
                    logger.debug(f"Exif IFD取得スキップ: {e}")

                # 撮影日時（DateTimeOriginal または DateTime）
                raw_date = (
                    exif_ifd.get(0x9003) or
                    exif.get(0x9003) or
                    exif.get(0x0132) or
                    exif_ifd.get(0x0132)
                )

                parsed_date = parse_exif_date(str(raw_date) if raw_date else None)
                if parsed_date:
                    date_taken = parsed_date

                # サブ秒（SubSecTimeOriginal: 0x9291 または SubSecTime: 0x9290）
                raw_subsec = exif_ifd.get(0x9291) or exif.get(0x9291) or exif_ifd.get(0x9290) or exif.get(0x9290)
                if raw_subsec:
                    subsec_time = str(raw_subsec).strip()

                # カメラ機種（Model: 0x0110）
                model = exif.get(0x0110) or exif_ifd.get(0x0110)
                if model:
                    camera_model = sanitize_camera_model(str(model))

                # レンズ機種名（LensModel: 0xa434）
                raw_lens = exif_ifd.get(0xa434) or exif.get(0xa434)
                if raw_lens:
                    clean_lens = str(raw_lens).replace("\x00", "").strip()
                    if is_valid_lens_name(clean_lens):
                        lens_model = clean_lens

                # 露出補正値（ExposureBiasValue: 0x9204）
                raw_bias = exif_ifd.get(0x9204) or exif.get(0x9204)
                if raw_bias is not None:
                    try:
                        exposure_bias = round(float(raw_bias), 2)
                    except (ValueError, TypeError) as e:
                        logger.debug(f"露出補正値変換スキップ: {e}")

                # シャッター速度（ExposureTime: 0x829a）
                raw_exp = exif_ifd.get(0x829a) or exif.get(0x829a)
                if raw_exp is not None:
                    try:
                        exp_val = float(raw_exp)
                        if exp_val > 0:
                            if exp_val < 1.0:
                                shutter_speed = f"1/{int(round(1.0 / exp_val))}"
                            else:
                                shutter_speed = f"{exp_val:.1f}s"
                    except (ValueError, TypeError, ZeroDivisionError) as e:
                        logger.debug(f"シャッター速度変換スキップ: {e}")

                # F値（FNumber: 0x829d）
                raw_fnum = exif_ifd.get(0x829d) or exif.get(0x829d)
                if raw_fnum is not None:
                    try:
                        f_number = round(float(raw_fnum), 1)
                    except (ValueError, TypeError) as e:
                        logger.debug(f"F値変換スキップ: {e}")

                # ISO感度（ISOSpeedRatings: 0x8827）
                raw_iso = exif_ifd.get(0x8827) or exif.get(0x8827)
                if raw_iso is not None:
                    try:
                        iso = int(raw_iso)
                    except (ValueError, TypeError) as e:
                        logger.debug(f"ISO感度変換スキップ: {e}")

                # 焦点距離（FocalLength: 0x920a）
                raw_focal = exif_ifd.get(0x920a) or exif.get(0x920a)
                if raw_focal is not None:
                    try:
                        focal_length = round(float(raw_focal), 1)
                    except (ValueError, TypeError) as e:
                        logger.debug(f"焦点距離変換スキップ: {e}")

                # 画像の向き（Orientation: 0x0112）に応じた幅・高さのスワップ
                # 5, 6, 7, 8 は 90度または 270度回転を表すため、縦横を反転
                raw_orient = exif.get(0x0112) or exif_ifd.get(0x0112)
                if raw_orient in (5, 6, 7, 8):
                    if width > 0 and height > 0 and width >= height:
                        width, height = height, width

                # GPS情報（GPS IFD: 0x8825）
                try:
                    gps_ifd = exif.get_ifd(0x8825)
                    if gps_ifd:
                        # GPSLatitude(2) + GPSLatitudeRef(1), GPSLongitude(4) + GPSLongitudeRef(3)
                        latitude = _parse_gps_coord(gps_ifd.get(2), gps_ifd.get(1))
                        longitude = _parse_gps_coord(gps_ifd.get(4), gps_ifd.get(3))
                        # (0.0, 0.0) 付近はGPS未測位エラー（Null Island）として無効化
                        if latitude is not None and longitude is not None:
                            if abs(latitude) < 0.0001 and abs(longitude) < 0.0001:
                                latitude = None
                                longitude = None
                except (KeyError, AttributeError, ValueError, TypeError) as e:
                    logger.debug(f"GPS情報パーススキップ: {e}")
    except Exception as e:
        # 画像オープンエラー時は基本情報のみで進める
        logger.debug(f"画像メタデータ読み出しスキップ ({file_path.name}): {e}")

    # 標準EXIF (0xA434) でレンズ機種名が取得できなかった場合、Panasonic MakerNote / XMP からフォールバック抽出
    if not is_valid_lens_name(lens_model):
        lens_model = extract_fallback_lens_model(file_path)

    # Exifから日時が得られなかった、またはファイル更新日時のフォールバックになっている場合、
    # ファイル名から撮影日時を高精度に抽出する（スマホ撮影画像の確実な復元）
    if not date_taken or date_taken == fallback_dt.strftime("%Y-%m-%d %H:%M:%S"):
        fn_date = parse_filename_datetime(file_path.name)
        if fn_date:
            date_taken = fn_date

    # 年月キー (YYYY-MM)
    year_month = date_taken[:7] if len(date_taken) >= 7 else ""

    gps_source = "exif" if (latitude is not None and longitude is not None) else None

    # GPSが存在する場合、ローカル逆ジオコーダーで国・都道府県・市区町村を特定
    country = None
    state = None
    city = None
    if latitude is not None and longitude is not None:
        try:
            from server.geocoder import reverse_geocode
            loc = reverse_geocode(latitude, longitude)
            country = loc.get("country")
            state = loc.get("state")
            city = loc.get("city")
        except Exception as e:
            logger.warning(f"逆ジオコーディング失敗 ({file_path.name}): {e}")

    meta = {
        "file_path": os.path.abspath(str(file_path)),
        "file_name": file_path.name,
        "directory_path": os.path.abspath(str(file_path.parent)),
        "file_size": file_size,
        "file_mtime": stat.st_mtime,
        "width": width,
        "height": height,
        "date_taken": date_taken,
        "year_month": year_month,
        "camera_model": camera_model,
        "exposure_bias": exposure_bias,
        "shutter_speed": shutter_speed,
        "f_number": f_number,
        "iso": iso,
        "focal_length": focal_length,
        "lens_model": lens_model,
        "subsec_time": subsec_time,
        "is_raw": 0,
        "raw_format": None,
        "volume_serial": None,
        "latitude": latitude,
        "longitude": longitude,
        "gps_source": gps_source,
        "country": country,
        "state": state,
        "city": city,
    }
    return _apply_xmp_hardware_fallback(meta, file_path, fallback_dt.strftime("%Y-%m-%d %H:%M:%S"))



def get_thumbnail_path(photo_id: int) -> Path:
    """写真IDに対応するWebPサムネイルの旧ファイルパスを返す（移行互換用）"""
    return THUMBNAIL_DIR / f"{photo_id}.webp"


def apply_photo_adjustments_pil(
    img: Image.Image,
    rotation: int = 0,
    fine_angle: float = 0.0,
    crop_box: Optional[Tuple[float, float, float, float]] = None,
    brightness: int = 0,
    contrast: int = 0,
    saturation: int = 0,
) -> Image.Image:
    """
    Pillow Image に対して非破壊調整パラメータ（90度回転・水平傾き補正・クロップ・明るさ・コントラスト・彩度）を一括適用する。
    - 水平傾き補正（fine_angle != 0）時は、回転によって生じる四隅の黒余白を自動的に内接矩形クロップで除去し、
      UIのステージ表示（自動ズーム scale）と1対1で一致する座標系で切り抜く。
    """
    # 1. 90度単位の回転（時計回り）
    if rotation:
        norm_rot = (int(rotation) % 360 + 360) % 360
        if norm_rot == 90:
            img = img.transpose(Image.Transpose.ROTATE_270)  # PIL ROTATE_270 は反時計回り270度 = 時計回り90度
        elif norm_rot == 180:
            img = img.transpose(Image.Transpose.ROTATE_180)
        elif norm_rot == 270:
            img = img.transpose(Image.Transpose.ROTATE_90)   # PIL ROTATE_90 は反時計回り90度 = 時計回り270度

    fa = float(fine_angle or 0.0)
    has_fine_angle = abs(fa) > 0.01

    cx, cy, cw, ch = 0.0, 0.0, 1.0, 1.0
    has_crop = False
    if crop_box and len(crop_box) == 4:
        raw_cx, raw_cy, raw_cw, raw_ch = crop_box
        if raw_cx is not None and raw_cy is not None and raw_cw is not None and raw_ch is not None:
            if raw_cw > 0 and raw_ch > 0:
                cx = max(0.0, min(1.0, float(raw_cx)))
                cy = max(0.0, min(1.0, float(raw_cy)))
                cw = max(0.01, min(1.0 - cx, float(raw_cw)))
                ch = max(0.01, min(1.0 - cy, float(raw_ch)))
                if cw < 0.999 or ch < 0.999 or cx > 0.001 or cy > 0.001:
                    has_crop = True

    b_val = int(brightness or 0)
    c_val = int(contrast or 0)
    s_val = int(saturation or 0)
    has_tone = (b_val != 0 or c_val != 0 or s_val != 0)

    if (has_fine_angle or has_tone) and img.mode != "RGB":
        img = img.convert("RGB")

    # 2. 水平出し（微小角度回転）＋ クロップの統合適用
    if has_fine_angle:
        orig_w, orig_h = img.size
        if orig_w > 4 and orig_h > 4:
            # PIL Image.rotate は反時計回りが正のため、時計回り fa 度には -fa を渡す
            img = img.rotate(-fa, resample=Image.Resampling.BICUBIC, expand=False)
            rad = abs(fa) * math.pi / 180.0
            aspect_max = max(orig_w / orig_h, orig_h / orig_w)
            auto_scale = math.cos(rad) + math.sin(rad) * aspect_max
            inscribed_w = orig_w / auto_scale
            inscribed_h = orig_h / auto_scale
            inscribed_x0 = (orig_w - inscribed_w) * 0.5
            inscribed_y0 = (orig_h - inscribed_h) * 0.5

            left = max(0, int(round(inscribed_x0 + cx * inscribed_w)))
            top = max(0, int(round(inscribed_y0 + cy * inscribed_h)))
            right = min(orig_w, int(round(inscribed_x0 + (cx + cw) * inscribed_w)))
            bottom = min(orig_h, int(round(inscribed_y0 + (cy + ch) * inscribed_h)))
            if right > left + 2 and bottom > top + 2:
                img = img.crop((left, top, right, bottom))
    elif has_crop:
        orig_w, orig_h = img.size
        left = max(0, int(round(cx * orig_w)))
        top = max(0, int(round(cy * orig_h)))
        right = min(orig_w, int(round((cx + cw) * orig_w)))
        bottom = min(orig_h, int(round((cy + ch) * orig_h)))
        if right > left + 2 and bottom > top + 2:
            img = img.crop((left, top, right, bottom))

    # 3. トーン微調整（明るさ: カメラ露出補正 EV×10 [-20〜+20 = -2.0EV〜+2.0EV]、コントラスト・彩度: -100 〜 +100）
    if b_val != 0:
        ev = max(-3.0, min(3.0, b_val / 10.0))
        factor = max(0.1, 2.0 ** (ev / 2.2))
        img = ImageEnhance.Brightness(img).enhance(factor)
    if c_val != 0:
        factor = max(0.1, 1.0 + (c_val / 100.0) * 0.75)
        img = ImageEnhance.Contrast(img).enhance(factor)
    if s_val != 0:
        factor = max(0.0, 1.0 + (s_val / 100.0))
        img = ImageEnhance.Color(img).enhance(factor)

    return img


def render_thumbnail_webp(
    target_path: Path | str,
    max_size: int = 360,
    allow_cloud_download: bool = False,
    rotation: int = 0,
    fine_angle: float = 0.0,
    crop_box: Optional[Tuple[float, float, float, float]] = None,
    brightness: int = 0,
    contrast: int = 0,
    saturation: int = 0,
) -> Optional[Tuple[bytes, int, int]]:
    """
    指定された画像ファイルからWebPサムネイルを生成し、(バイナリ, 幅, 高さ) を返す。
    クラウド同期・オンデマンドファイル、RAW画像、通常画像の各処理および高速化(JPEG draft等)を統一して行う。
    ダウンロード禁止のクラウド未実体化ファイルや生成不能時は None を返す。
    非破壊回転(rotation)、水平傾き補正(fine_angle)、クロップ(crop_box)、トーン調整(brightness/contrast/saturation)を反映する。
    """
    if isinstance(target_path, str):
        target_path = Path(target_path)

    try:
        img: Optional[Image.Image] = None

        # 1. クラウド同期・オンデマンドファイル（Google Drive, OneDrive等）の場合:
        #    元ファイルのフルダウンロードを回避するため、Windows Shellからサムネイルを直取り
        is_cloud = is_cloud_or_ondemand_path(target_path)
        if is_cloud:
            img = get_shell_thumbnail(target_path, max_size)
            if img is None and not allow_cloud_download:
                # シェルサムネイルが未生成で、ダウンロード許可がない場合はフルダウンロードを完全遮断
                return None

        # 2. ローカルファイル、またはシェル取得失敗時（通常ファイル）の処理
        if img is None:
            if is_raw_file(target_path):
                # RAWファイルの場合は内部の埋め込みプレビューJPEGを直接抽出（生現像不要で爆速）
                raw_img = extract_raw_thumbnail_image(target_path)
                if raw_img is None:
                    # RAW埋め込み展開失敗時もシェルサムネイルをフォールバック試行
                    img = get_shell_thumbnail(target_path, max_size)
                    if img is None:
                        logger.warning(f"RAWファイルからプレビューを抽出できませんでした: {target_path}")
                        return None
                else:
                    img = raw_img
            else:
                try:
                    opened_img = Image.open(target_path)
                    # P1-8: JPEGの場合は exif_transpose の前に draft を呼び出し、デコード負荷を大幅軽減
                    # ※ クロップや水平傾き補正がある場合は拡大切り抜き時にぼやけないよう4倍サイズでdraftする
                    if getattr(opened_img, "format", None) == "JPEG":
                        try:
                            draft_mult = 4 if (crop_box or abs(float(fine_angle or 0.0)) > 0.01) else 2
                            opened_img.draft("RGB", (max_size * draft_mult, max_size * draft_mult))
                        except Exception as e:
                            logger.warning(f"JPEG draft失敗 ({target_path}): {e}")
                    img = opened_img
                except Exception as e:
                    # Pillowで開けなかった場合（動画や特殊形式など）もシェルサムネイルをフォールバック試行
                    img = get_shell_thumbnail(target_path, max_size)
                    if img is None:
                        logger.warning(f"画像を開けませんでした ({target_path}): {e}")
                        return None

        if img is None:
            return None

        # EXIFの向きに基づいて正しく回転
        img = ImageOps.exif_transpose(img)

        # 非破壊調整（90度回転・水平傾き補正・クロップ・明るさ・コントラスト・彩度）を一括適用
        img = apply_photo_adjustments_pil(
            img,
            rotation=rotation,
            fine_angle=fine_angle,
            crop_box=crop_box,
            brightness=brightness,
            contrast=contrast,
            saturation=saturation,
        )

        # RGBに変換（RGBAやCMYK対策）
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        # アスペクト比を維持してリサイズ（P1-8: reducing_gap=2.0 を指定）
        if img.width > max_size or img.height > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS, reducing_gap=2.0)

        # メモリ上でWebPバイナリに変換
        buffer = io.BytesIO()
        img.save(buffer, format="WEBP", quality=82)
        thumb_data = buffer.getvalue()
        thumb_width, thumb_height = img.size

        return (thumb_data, thumb_width, thumb_height)

    except Exception as e:
        logger.error(f"サムネイル生成処理でエラーが発生しました ({target_path}): {e}")
        return None


def ensure_thumbnail(photo_id: int, file_path_str: str, max_size: int = 360, allow_cloud_download: bool = False) -> bytes:
    """
    サムネイルがDB内に存在しない場合は生成し、SQLite BLOBとして保存してバイナリを返す。
    既にDB内に存在する場合はBLOBをそのまま返す（RAW埋め込みJPEG対応）。
    オンデマンドファイルでShellサムネイルが未取得の場合、意図しない元ファイルの全ダウンロードを完全遮断する。
    """
    # DB内に既存サムネイルがあるかチェック
    existing = get_thumbnail(photo_id)
    if existing:
        return existing["data"]

    # 重複写真（他フォルダにある同一画像）の既存サムネイルがあれば高速再利用（画像デコードをスキップ）
    photo_meta = get_photo_brief(photo_id)
    if photo_meta and photo_meta.get("date_taken") and photo_meta.get("file_size"):
        dup_thumb = find_existing_thumbnail_for_duplicate(
            file_size=photo_meta["file_size"],
            date_taken=photo_meta["date_taken"],
            exclude_photo_id=photo_id,
        )
        if dup_thumb:
            file_hash = compute_thumbnail_hash(str(file_path_str))
            save_thumbnail(photo_id, dup_thumb["data"], dup_thumb["width"], dup_thumb["height"], file_hash)
            return dup_thumb["data"]

    # サムネイル生成
    target_path, is_online = resolve_portable_path(file_path_str)
    if not is_online:
        raise FileNotFoundError(f"画像ファイルが未接続です: {file_path_str}")

    is_cloud = is_cloud_or_ondemand_path(target_path)
    rotation = (photo_meta.get("rotation") or 0) if photo_meta else 0
    fine_angle = (photo_meta.get("fine_angle") or 0.0) if photo_meta else 0.0
    brightness = (photo_meta.get("brightness") or 0) if photo_meta else 0
    contrast = (photo_meta.get("contrast") or 0) if photo_meta else 0
    saturation = (photo_meta.get("saturation") or 0) if photo_meta else 0
    crop_box = None
    if photo_meta and photo_meta.get("crop_w") and photo_meta.get("crop_h"):
        crop_box = (
            photo_meta.get("crop_x") or 0.0,
            photo_meta.get("crop_y") or 0.0,
            photo_meta["crop_w"],
            photo_meta["crop_h"],
        )
    res = render_thumbnail_webp(
        target_path,
        max_size=max_size,
        allow_cloud_download=allow_cloud_download,
        rotation=rotation,
        fine_angle=fine_angle,
        crop_box=crop_box,
        brightness=brightness,
        contrast=contrast,
        saturation=saturation,
    )

    if res is None:
        if is_cloud and not allow_cloud_download:
            # シェルサムネイルが未生成で、ダウンロード許可がない場合はフルダウンロードを完全遮断
            # DBには保存せずプレースホルダーWebPを返す（次回ダウンロード後に本物生成）
            return get_ondemand_placeholder_webp()
        raise RuntimeError(f"サムネイル生成に失敗しました ({file_path_str})")

    thumb_data, thumb_width, thumb_height = res
    file_hash = compute_thumbnail_hash(str(target_path))
    save_thumbnail(photo_id, thumb_data, thumb_width, thumb_height, file_hash)

    return thumb_data


def refresh_photo_thumbnail_transform(photo_id: int, delta_degrees: int = 0) -> bool:
    """
    写真の最新の rotation / fine_angle / crop / トーン設定に基づいて、サムネイルBLOBを再生成・更新する。
    元画像にアクセス可能な場合は元画像から高品質に再生成し、
    元画像が未接続の場合は既存サムネイルBLOBを変換させて更新する。
    """
    photo = get_photo_brief(photo_id)
    if not photo:
        return False

    file_path = photo.get("file_path")
    rotation = photo.get("rotation") or 0
    fine_angle = photo.get("fine_angle") or 0.0
    brightness = photo.get("brightness") or 0
    contrast = photo.get("contrast") or 0
    saturation = photo.get("saturation") or 0
    crop_box = None
    if photo.get("crop_w") and photo.get("crop_h"):
        crop_box = (
            photo.get("crop_x") or 0.0,
            photo.get("crop_y") or 0.0,
            photo["crop_w"],
            photo["crop_h"],
        )

    # 1. 元画像から再生成を試行
    if file_path:
        target_path, is_online = resolve_portable_path(file_path)
        if is_online and target_path and target_path.exists():
            try:
                res = render_thumbnail_webp(
                    target_path,
                    rotation=rotation,
                    fine_angle=fine_angle,
                    crop_box=crop_box,
                    brightness=brightness,
                    contrast=contrast,
                    saturation=saturation,
                )
                if res:
                    data, w, h = res
                    file_hash = compute_thumbnail_hash(str(target_path))
                    save_thumbnail(photo_id, data, w, h, file_hash)
                    return True
            except Exception as e:
                logger.warning(f"元画像からのサムネイル再生成失敗 ({photo_id}): {e}")

    # 2. オフライン等で元画像がない場合: 既存サムネイルBLOBをメモリ上で回転
    existing = get_thumbnail(photo_id)
    rot_amount = delta_degrees if delta_degrees != 0 else rotation
    if existing and existing.get("data") and rot_amount:
        try:
            with Image.open(io.BytesIO(existing["data"])) as img:
                norm_rot = (rot_amount % 360 + 360) % 360
                if norm_rot == 90:
                    img = img.transpose(Image.Transpose.ROTATE_270)
                elif norm_rot == 180:
                    img = img.transpose(Image.Transpose.ROTATE_180)
                elif norm_rot == 270:
                    img = img.transpose(Image.Transpose.ROTATE_90)
                buf = io.BytesIO()
                img.save(buf, format="WEBP", quality=85)
                save_thumbnail(photo_id, buf.getvalue(), img.width, img.height, existing.get("file_hash"))
                return True
        except Exception as e:
            logger.warning(f"既存サムネイルのメモリ回転に失敗しました: {e}")

    return False


def smart_sync_photo(meta: Dict[str, Any], existing_record: Optional[Any] = None, do_upsert: bool = True) -> str:
    """
    写真メタデータを同期する。
    1. 同一ファイルパスが既に存在する場合: 通常更新 ('updated')
    2. 新規ファイルパスの場合: 安全のため独立した写真として新規追加 ('added')
       ※外付けドライブ切断時（オフライン時）の誤判定やバックアップコピー時のデータ乗っ取りを防ぐため、
         自動付け替え（relink）は行わず、ファイルパスごとに独立したレコードとして登録する。
    戻り値: 'added', 'updated'
    """
    if existing_record is not None:
        existing_by_path = True
    else:
        existing_by_path = bool(get_photo_by_path(meta["file_path"]))

    if existing_by_path:
        if do_upsert:
            upsert_photo(meta)
        return "updated"

    # 新規パスの場合は独立した写真として新規追加
    # 同一画像（他フォルダの重複コピー）が既存にあれば、評価やタグを初期値として連携
    dup = find_duplicate_photo_match(
        file_size=meta.get("file_size", 0),
        date_taken=meta.get("date_taken"),
        camera_model=meta.get("camera_model"),
    )
    if dup:
        if dup.get("rating") and not meta.get("rating"):
            meta["rating"] = dup["rating"]
        if dup.get("is_favorite") and not meta.get("is_favorite"):
            meta["is_favorite"] = dup["is_favorite"]
        meta["_dup_source_id"] = dup["id"]

    if do_upsert:
        new_id = upsert_photo(meta)
        if dup and new_id:
            copy_metadata_to_duplicate(dup["id"], new_id)

    return "added"


class ScanTracker:
    """スキャン進捗状態をスレッドセーフに管理するクラス"""

    def __init__(self):
        self.lock = threading.Lock()
        self.is_scanning = False
        self.folder_path = ""
        self.phase = "idle"  # 'idle', 'listing', 'scanning', 'stacks', 'completed', 'error'
        self.total_files = 0
        self.scanned = 0
        self.added = 0
        self.updated = 0
        self.relinked = 0
        self.unchanged = 0
        self.current_file = ""
        self.error_message: Optional[str] = None
        self.result: Optional[Dict[str, Any]] = None

    def start(self, folder_path: str):
        """スキャンの開始を記録"""
        with self.lock:
            self.is_scanning = True
            self.folder_path = folder_path
            self.phase = "listing"
            self.total_files = 0
            self.scanned = 0
            self.added = 0
            self.updated = 0
            self.relinked = 0
            self.unchanged = 0
            self.current_file = ""
            self.error_message = None
            self.result = None

    def set_phase(self, phase: str, total_files: int = 0):
        """スキャンフェーズと総ファイル数を更新"""
        with self.lock:
            self.phase = phase
            if total_files > 0:
                self.total_files = total_files

    def update_progress(self, scanned: int, current_file: str, action: str):
        """1ファイルごとの進捗状況を更新"""
        with self.lock:
            self.scanned = scanned
            self.current_file = current_file
            if action == "added":
                self.added += 1
            elif action == "updated":
                self.updated += 1
            elif action == "relinked":
                self.relinked += 1
            elif action == "unchanged":
                self.unchanged += 1

    def finish(self, result: Dict[str, Any]):
        """スキャンの正常完了を記録"""
        with self.lock:
            self.is_scanning = False
            self.phase = "completed"
            self.result = result

    def set_error(self, err: str):
        """スキャンエラーを記録"""
        with self.lock:
            self.is_scanning = False
            self.phase = "error"
            self.error_message = err

    def get_status(self) -> Dict[str, Any]:
        """現在の進捗状態を辞書形式で取得（APIレスポンス用）"""
        with self.lock:
            percent = 0
            if self.total_files > 0:
                percent = min(100, int((self.scanned / self.total_files) * 100))
            return {
                "is_scanning": self.is_scanning,
                "folder_path": self.folder_path,
                "phase": self.phase,
                "total_files": self.total_files,
                "scanned": self.scanned,
                "added": self.added,
                "updated": self.updated,
                "relinked": self.relinked,
                "unchanged": self.unchanged,
                "current_file": self.current_file,
                "percent": percent,
                "error_message": self.error_message,
                "result": self.result,
            }


# グローバルスキャントラッカーインスタンス
scan_tracker = ScanTracker()


def scan_directory(target_dir_str: str, cleanup_orphans: bool = False, recursive: bool = True) -> Dict[str, Any]:
    """
    指定されたディレクトリを走査し、スマート同期（移動の自動再紐付け含む）を行う。
    recursive=False の場合は指定ディレクトリ直下のみをスキャンする。
    進捗状況は scan_tracker にリアルタイムに反映される。
    """
    target_dir = Path(target_dir_str)
    if not target_dir.exists() or not target_dir.is_dir():
        scan_tracker.set_error(f"有効なディレクトリではありません: {target_dir_str}")
        raise ValueError(f"有効なディレクトリではありません: {target_dir_str}")

    # import フォルダまたはその配下の場合はスキャン対象外
    app_import_dir = Path(__file__).resolve().parent.parent / "import"
    try:
        resolved_target = target_dir.resolve()
        resolved_import = app_import_dir.resolve()
        if resolved_target == resolved_import or resolved_import in resolved_target.parents:
            scan_tracker.set_error("import フォルダはスキャン対象外です")
            raise ValueError("import フォルダはスキャン対象外です")
    except Exception as e:
        if isinstance(e, ValueError):
            raise

    scan_tracker.start(target_dir_str)

    # ドライブ接続直後などに古い判定を引きずらないよう、FS状態のTTLキャッシュをクリア
    clear_online_cache()
    clear_folders_fs_cache()

    try:
        # 指紋照合（別PC・別アカウントの同名ドライブ/フォルダ誤読防止）
        matched_root, stored_fp = get_scan_root_fingerprint(target_dir_str)
        if matched_root and stored_fp:
            # 指紋はルートフォルダ基準で記録されているため、ルートパスで検証する
            is_valid, reason = verify_folder_fingerprint(matched_root, stored_fp)
            if not is_valid:
                scan_tracker.set_error(reason)
                raise PermissionError(reason)

        # 既存の登録ルート配下のサブフォルダでない場合のみ、新規ルートとしてDBに記録
        if not matched_root or os.path.normpath(target_dir_str) == os.path.normpath(matched_root):
            add_scan_root(target_dir_str)

        # スキャン対象ディレクトリのボリューム情報を1回だけ取得してDBに登録
        vol_info = get_volume_info(target_dir_str)
        volume_serial = None
        if vol_info:
            volume_serial = vol_info["serial"]
            upsert_volume(vol_info["serial"], vol_info["label"], vol_info["drive"])

        # 1. まず高速に対象画像ファイルをリストアップして総数を把握
        scan_tracker.set_phase("listing")
        image_files = []

        # 除外フォルダ一覧の取得と正規化
        ignored_list = get_ignored_folders()
        ignored_set = {os.path.normpath(p).lower() for p in ignored_list}

        # スキャン対象自身が除外リストに入っていた場合は、ユーザーが意図してスキャンしたため除外を自動解除
        target_norm = os.path.normpath(target_dir_str).lower()
        if target_norm in ignored_set:
            remove_ignored_folder(target_dir_str)
            ignored_set.discard(target_norm)

        if recursive:
            for root, dirs, files in os.walk(target_dir):
                # 隠しフォルダ、システム除外フォルダ（carry/take_out等）、およびユーザー除外フォルダを再帰探索から除外
                pruned = []
                for d in dirs:
                    if d.startswith(".") or d.lower() in ("import", ".cache", "cache", "uploads", "carry", "take_out", "$recycle.bin"):
                        continue
                    full_d = os.path.normpath(os.path.join(root, d)).lower()
                    if any(full_d == ig or full_d.startswith(ig + os.sep) for ig in ignored_set):
                        continue
                    pruned.append(d)
                dirs[:] = pruned

                for file in files:
                    ext = os.path.splitext(file)[1].lower()
                    if ext in SUPPORTED_EXTENSIONS:
                        image_files.append((root, file))
        else:
            # 直下のみスキャン（子フォルダは走査しない）
            for file in os.listdir(target_dir):
                full = target_dir / file
                if full.is_file():
                    ext = os.path.splitext(file)[1].lower()
                    if ext in SUPPORTED_EXTENSIONS:
                        image_files.append((str(target_dir), file))


        total_files = len(image_files)
        scan_tracker.set_phase("scanning", total_files=total_files)

        # 既存レコード {file_path: (id, file_size, file_mtime)} を先読み
        existing_map = get_existing_photos_map(target_dir_str, recursive=recursive)

        # スタック再計算用の列挙済み絶対パス集合
        existing_paths_set = {os.path.abspath(os.path.join(root, file)) for root, file in image_files}

        total_scanned = 0
        total_added = 0
        total_updated = 0
        total_relinked = 0
        total_unchanged = 0

        batch_meta: List[Dict[str, Any]] = []
        dup_tag_pairs: List[Tuple[int, str]] = []  # (dup_source_id, full_path_str)

        def _flush_batch_with_duplicates():
            nonlocal batch_meta, dup_tag_pairs
            if not batch_meta:
                return
            upsert_photos_batch(batch_meta)
            if dup_tag_pairs:
                for src_id, fpath_str in dup_tag_pairs:
                    p = get_photo_by_path(fpath_str)
                    if p:
                        copy_metadata_to_duplicate(src_id, p["id"])
                dup_tag_pairs.clear()
            batch_meta.clear()

        # 2. 各ファイルのメタデータ抽出および同期処理
        for idx, (root, file) in enumerate(image_files, start=1):
            abs_path_str = os.path.abspath(os.path.join(root, file))
            norm_key = os.path.normcase(abs_path_str)
            existing = existing_map.get(norm_key)
            full_path = Path(abs_path_str)

            total_scanned += 1
            try:
                stat = full_path.stat()
                st_size = stat.st_size
                st_mtime = stat.st_mtime

                # 差分判定: size と mtime が両方一致したファイルは extract_metadata を呼ばず unchanged
                # （file_mtime が NULL の既存行は従来どおり解析して埋める）
                if existing is not None:
                    ex_id, ex_size, ex_mtime = existing
                    if ex_mtime is not None and ex_size == st_size and abs(ex_mtime - st_mtime) < 1e-4:
                        total_unchanged += 1
                        scan_tracker.update_progress(idx, file, "unchanged")
                        continue

                    # size または mtime が変わったファイルは更新時にサムネイルを削除（P2-3）
                    is_modified = (ex_size != st_size) or (ex_mtime is not None and abs(ex_mtime - st_mtime) >= 1e-4)
                    if is_modified:
                        delete_thumbnail(ex_id)

                meta = extract_metadata(full_path)
                meta["volume_serial"] = volume_serial
                sync_action = smart_sync_photo(meta, existing_record=existing, do_upsert=False)

                if sync_action == "relinked":
                    total_relinked += 1
                elif sync_action == "added":
                    total_added += 1
                    if "_dup_source_id" in meta:
                        dup_tag_pairs.append((meta["_dup_source_id"], abs_path_str))
                    batch_meta.append(meta)
                else:
                    total_updated += 1
                    batch_meta.append(meta)

                # 200件ごとにバッチ書き込み
                if len(batch_meta) >= 200:
                    _flush_batch_with_duplicates()

                scan_tracker.update_progress(idx, file, sync_action)
            except Exception as e:
                # 個別ファイルのエラーはスキップして継続
                print(f"[WARN] スキャン処理失敗 ({full_path}): {e}")
                scan_tracker.update_progress(idx, file, "skip")
                continue

        # 残りのバッチをコミット
        _flush_batch_with_duplicates()

        # 既存（unchanged）レコードで lens_model が未取得の写真を MakerNote / XMP から高速補完
        try:
            backfill_missing_lens_models(
                directory_path=os.path.abspath(target_dir_str),
                recursive=recursive,
            )
        except Exception as bf_err:
            print(f"[WARN] レンズ情報の補完処理で警告: {bf_err}")

        cleaned_count = 0
        if cleanup_orphans:
            cleaned_count = cleanup_missing_photos_in_folder(target_dir_str, recursive=recursive)

        # 3. スキャン完了後にブラケット・連写スタックを自動再計算（列挙済みパス集合を渡してos.path.existsを回避）
        scan_tracker.set_phase("stacks")
        stacks_created = recalculate_stacks(os.path.abspath(target_dir_str), recursive=recursive, existing_paths=existing_paths_set)

        # 4. 指紋（フィンガープリント）を最新状態に更新（写真の変更・追加・削除があった場合のみ更新）
        if total_added > 0 or total_updated > 0 or total_relinked > 0 or cleaned_count > 0:
            try:
                new_fp = extract_folder_fingerprint(target_dir_str)
                if new_fp:
                    update_scan_root_fingerprint(target_dir_str, new_fp)
            except Exception as fp_err:
                print(f"[WARN] 指紋更新エラー（スキャン処理には影響なし）: {fp_err}")

        result = {
            "scanned": total_scanned,
            "total_files": total_files,
            "added": total_added,
            "updated": total_updated,
            "relinked": total_relinked,
            "unchanged": total_unchanged,
            "cleaned": cleaned_count,
            "stacks_created": stacks_created,
            "added_or_updated": total_added + total_updated + total_relinked,
        }
        # スマホで cache/library.db 単体を開いた際にもスキャン結果がすべて含まれるようWALをフラッシュ
        try:
            with get_connection() as ck_conn:
                ck_conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
        except Exception as ck_err:
            print(f"[WARN] スキャン完了時のWALチェックポイント警告: {ck_err}")

        scan_tracker.finish(result)

        # スキャン完了後、未生成のサムネイルをバックグラウンドで事前キャッシュ
        def _bg_preload():
            try:
                from .preload_thumbnails import preload_all_thumbnails
                preload_all_thumbnails()
                with get_connection() as ck_conn:
                    ck_conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            except Exception as e:
                print(f"[WARN] バックグラウンドサムネイル生成エラー: {e}")

        threading.Thread(target=_bg_preload, daemon=True).start()

        return result

    except Exception as e:
        scan_tracker.set_error(str(e))
        raise


def check_folder_diff(target_dir_str: str) -> Dict[str, Any]:
    """
    指定ディレクトリ直下の実ファイルとDBレコードを高速に照合し、
    追加・削除・変更の差分件数をミリ秒単位で集計して返却する。
    画像デコードやEXIF解析は行わず、os.scandir のメタデータ（size, mtime）のみを使用するため極めて高速。
    """
    target_path = Path(target_dir_str)
    if not target_path.exists() or not target_path.is_dir():
        return {"has_changes": False, "added": 0, "deleted": 0, "modified": 0, "is_valid": False}

    # 1. 実ファイル一覧の取得 (直下のみ)
    disk_files: Dict[str, Tuple[int, float]] = {}
    try:
        with os.scandir(target_path) as it:
            for entry in it:
                if entry.is_file():
                    ext = os.path.splitext(entry.name)[1].lower()
                    if ext in SUPPORTED_EXTENSIONS:
                        try:
                            stat = entry.stat()
                            disk_files[entry.name.lower()] = (stat.st_size, stat.st_mtime)
                        except Exception:
                            continue
    except Exception as e:
        logger.warning(f"check_folder_diff scandir エラー ({target_dir_str}): {e}")
        return {"has_changes": False, "added": 0, "deleted": 0, "modified": 0, "is_valid": False}

    # 2. DBレコード一覧・管理状態の取得
    from .database.connection import get_connection
    norm_win = os.path.normpath(target_dir_str).rstrip("\\/")
    db_files: Dict[str, Tuple[int, float]] = {}
    is_managed = False

    with get_connection() as conn:
        cursor = conn.cursor()
        # scan_roots に登録されているか確認
        cursor.execute("SELECT id FROM scan_roots WHERE folder_path = ? COLLATE NOCASE", (norm_win,))
        if cursor.fetchone():
            is_managed = True

        # 直下の photos レコードを取得
        cursor.execute(
            "SELECT file_name, file_size, file_mtime FROM photos WHERE directory_path = ? COLLATE NOCASE",
            (norm_win,),
        )
        for r in cursor.fetchall():
            fn = r["file_name"].lower()
            sz = r["file_size"] or 0
            mt = r["file_mtime"] or 0.0
            db_files[fn] = (sz, mt)

        if len(db_files) > 0:
            is_managed = True
        elif not is_managed:
            # 配下（サブフォルダ）に管理写真が存在するか確認
            sub_prefix = norm_win + "\\%"
            cursor.execute("SELECT id FROM photos WHERE directory_path LIKE ? LIMIT 1", (sub_prefix,))
            if cursor.fetchone():
                is_managed = True

    disk_keys = set(disk_files.keys())
    db_keys = set(db_files.keys())

    added_count = len(disk_keys - db_keys)
    deleted_count = len(db_keys - disk_keys)

    # 共通ファイルの中でサイズまたはmtimeが変更されたもの
    common_keys = disk_keys & db_keys
    modified_count = 0
    for k in common_keys:
        d_sz, d_mt = disk_files[k]
        b_sz, b_mt = db_files[k]
        if d_sz != b_sz or (b_mt > 0 and abs(d_mt - b_mt) >= 1e-4):
            modified_count += 1

    # 管理外フォルダの場合は「変更」ではなく未登録扱いとする
    has_changes = is_managed and (added_count > 0 or deleted_count > 0 or modified_count > 0)
    return {
        "has_changes": has_changes,
        "is_managed": is_managed,
        "added": added_count if is_managed else 0,
        "deleted": deleted_count if is_managed else 0,
        "modified": modified_count if is_managed else 0,
        "is_valid": True,
        "total_disk": len(disk_files),
        "total_db": len(db_files),
    }



