"""
RAW画像ローダー & 埋め込みプレビュー抽出モジュール
LibRaw (rawpy) を使用して、各社カメラのRAWファイルから
カメラ内現像済みの埋め込みプレビューJPEG（およびExifメタデータ）を高速に抽出する。
"""

import html
import io
import logging
import os
import re
import struct
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, Union
from PIL import Image, ImageOps

import rawpy

logger = logging.getLogger("raw_loader")

# サポートするRAW拡張子一覧（大文字小文字不問）
SUPPORTED_RAW_EXTENSIONS = {
    ".rw2",  # Panasonic Lumix
    ".arw",  # Sony α
    ".cr2",  # Canon EOS (旧)
    ".cr3",  # Canon EOS (新/CR3)
    ".nef",  # Nikon Z / D
    ".nrw",  # Nikon Coolpix
    ".dng",  # Adobe DNG / Leica / 各社
    ".raf",  # Fujifilm X / GFX
    ".orf",  # Olympus / OM System
    ".pef",  # Pentax
    ".srw",  # Samsung
    ".x3f",  # Sigma Foveon (DP Merrill / Quattro 等)
}


def is_raw_file(file_path: Union[str, Path]) -> bool:
    """指定されたファイルがRAW画像形式かどうかを判定する"""
    suffix = Path(file_path).suffix.lower()
    return suffix in SUPPORTED_RAW_EXTENSIONS


def parse_exif_date_str(date_str: Optional[str]) -> Optional[str]:
    """EXIF日時文字列 (YYYY:MM:DD HH:MM:SS) を YYYY-MM-DD HH:MM:SS 形式に正規化する"""
    if not date_str:
        return None
    try:
        cleaned = str(date_str).strip()
        dt = datetime.strptime(cleaned, "%Y:%m:%d %H:%M:%S")
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


_INVALID_LENS_NAMES = {
    "", "-", "--", "---", "----", "n/a", "none", "null", "unknown",
    "no-lens", "no lens", "no-accessory", "0", "0.0 mm f/0.0", "0000000"
}

_XMP_LENS_PATTERNS = (
    re.compile(rb"<aux:Lens>([^<]+)</aux:Lens>", re.IGNORECASE),
    re.compile(rb'\baux:Lens="([^"]+)"', re.IGNORECASE),
    re.compile(rb"<exifEX:LensModel>([^<]+)</exifEX:LensModel>", re.IGNORECASE),
    re.compile(rb'\bexifEX:LensModel="([^"]+)"', re.IGNORECASE),
)


def is_valid_lens_name(name: Optional[str]) -> bool:
    """レンズ名が有効な文字列（ダミー値やXML断片でない）かを判定する"""
    if not name:
        return False
    s = str(name).replace("\x00", "").strip()
    if len(s) < 3 or s.lower() in _INVALID_LENS_NAMES:
        return False
    # すべて記号（ハイフンやアンダースコア）のみの場合は無効
    if all(c in "-_./\\*?" for c in s):
        return False
    # XML/RDF 断片の誤混入を除外
    if "<" in s or ">" in s or "xmlns" in s.lower() or "rdf:" in s.lower():
        return False
    return True


def extract_fallback_lens_model(file_path: Union[str, Path]) -> Optional[str]:
    """
    標準EXIF (0xA434: LensModel) にレンズ名が記録されていない写真ファイルから、
    先頭バイナリ（最大128KB）を高速スキャンして以下の順序でレンズ機種名を抽出する:
      1. Panasonic MakerNote (0x927C 内の Tag 0x0051: LensType + Tag 0x0053: ConversionLens)
      2. XMP メタデータ (aux:Lens / exifEX:LensModel — SILKYPIX現像JPEGやNikon D200等)
    """
    try:
        with open(file_path, "rb") as f:
            raw = f.read(131072)
    except Exception as e:
        logger.debug(f"レンズ情報フォールバック読み取りスキップ ({file_path}): {e}")
        return None

    if not raw:
        return None

    # 1. Panasonic MakerNote ("Panasonic\x00\x00\x00") の解析
    pana_sig = b"Panasonic\x00\x00\x00"
    search_pos = 0
    while True:
        idx = raw.find(pana_sig, search_pos)
        if idx < 0 or idx + 14 > len(raw):
            break
        search_pos = idx + 12

        try:
            num_entries = struct.unpack_from("<H", raw, idx + 12)[0]
        except Exception:
            continue

        if not (1 <= num_entries <= 500):
            continue

        # オフセット基準候補: 直前の TIFF Little Endian ヘッダ ("II*\x00") または ファイル先頭 (0)
        tiff_ii = raw.rfind(b"II*\x00", 0, idx)
        base_candidates = [tiff_ii, 0] if tiff_ii >= 0 else [0]

        lens_str: Optional[str] = None
        acc_str: Optional[str] = None

        for i in range(num_entries):
            entry_pos = idx + 14 + i * 12
            if entry_pos + 12 > len(raw):
                break
            tag, typ, cnt, val_off = struct.unpack_from("<HHII", raw, entry_pos)
            if typ != 2 or cnt <= 1 or cnt > 128:
                continue
            if tag not in (0x0051, 0x0053):
                continue

            for base in base_candidates:
                start = base + val_off
                if 0 <= start and start + cnt <= len(raw):
                    chunk = raw[start:start + cnt].split(b"\x00", 1)[0]
                    try:
                        decoded = chunk.decode("ascii").strip()
                    except UnicodeDecodeError:
                        continue
                    if is_valid_lens_name(decoded):
                        if tag == 0x0051 and not lens_str:
                            lens_str = decoded
                        elif tag == 0x0053 and not acc_str:
                            acc_str = decoded
                        break

        if lens_str:
            if acc_str and acc_str not in lens_str:
                return f"{lens_str} + {acc_str}"
            return lens_str

    # 2. XMP メタデータ (aux:Lens / exifEX:LensModel) の解析
    for pat in _XMP_LENS_PATTERNS:
        m = pat.search(raw)
        if m:
            try:
                val = html.unescape(m.group(1).decode("utf-8", errors="ignore")).strip()
                if is_valid_lens_name(val):
                    return val
            except Exception:
                continue

    return None


def extract_raw_thumbnail_image(file_path: Union[str, Path]) -> Optional[Image.Image]:
    """
    RAWファイル内部に格納されているカメラ内現像済みの埋め込みプレビューJPEGを抽出し、
    PIL.Imageオブジェクトとして返す。
    生現像（デモザイク処理）を行わないため、数ミリ秒〜十数ミリ秒の超低負荷・爆速で動作する。
    """
    path_obj = Path(file_path)
    if not path_obj.exists():
        return None

    # 1. rawpy (LibRaw) による埋め込みサムネイル抽出
    try:
        with rawpy.imread(str(path_obj)) as raw:
            try:
                thumb = raw.extract_thumb()
            except rawpy.NoThumbnailError:
                thumb = None

            if thumb is not None:
                if thumb.format == rawpy.ThumbFormat.JPEG:
                    img = Image.open(io.BytesIO(thumb.data))
                    # EXIFの向きに基づいて自動回転
                    try:
                        img = ImageOps.exif_transpose(img)
                    except Exception:
                        pass
                    return img
                elif thumb.format == rawpy.ThumbFormat.BITMAP:
                    # ビットマップ形式サムネイル
                    img = Image.fromarray(thumb.data)
                    return img
    except Exception:
        # rawpyでオープンできなかった場合のフォールバックへ
        pass

    # 2. フォールバック: DNGなどPillow自身で直接開けるRAWの場合
    try:
        with Image.open(path_obj) as img:
            img.load()
            img = ImageOps.exif_transpose(img)
            return img.copy()
    except Exception:
        pass

    # 3. フォールバック: バイナリ中のJPEGマーカーを直接探索（X3F等、rawpyで読めないフォーマット用）
    try:
        img = _extract_embedded_jpeg(path_obj)
        if img:
            return img
    except Exception:
        pass

    return None


def extract_raw_full_preview(file_path: Union[str, Path], max_dimension: Optional[int] = None) -> Optional[Tuple[bytes, str, int, int]]:
    """
    RAWファイルからカメラ内現像済みの埋め込みフルサイズ（高解像度）プレビュー画像を抽出し、
    (jpeg_bytes, mime_type, width, height) のタプルで返す。
    ライトボックス（全画面表示・拡大ピント確認）用。

    デモザイク生現像を行わず、埋め込みJPEGを取り出してExif回転を適用した上で
    高速にJPEGバイナリとして返却するため、数十〜数百ミリ秒の超低負荷・爆速で動作する。
    """
    path_obj = Path(file_path)
    if not path_obj.exists():
        return None

    img = extract_raw_thumbnail_image(path_obj)
    if img is None:
        return None

    try:
        # RGBAやCMYKならRGBに変換
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # オプションで最大寸法が指定されている場合のみリサイズ
        if max_dimension and (img.width > max_dimension or img.height > max_dimension):
            img.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS, reducing_gap=2.0)

        # 高品質JPEGでメモリ上に出力（WebPより圧倒的に高速・数十msで完了）
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=88, optimize=False)
        jpeg_data = buffer.getvalue()
        return (jpeg_data, "image/jpeg", img.width, img.height)
    except Exception as e:
        logger.warning(f"RAWフルサイズプレビュー変換失敗 ({path_obj}): {e}")
        return None


def _extract_embedded_jpeg(file_path: Path) -> Optional[Image.Image]:
    """
    RAWファイルのバイナリから埋め込みJPEG画像を直接探索・抽出する。
    JPEG SOIマーカー (0xFFD8) と EOIマーカー (0xFFD9) を探し、
    最も大きいJPEGブロブをプレビュー画像として返す。
    X3F等、LibRawが対応していないRAWフォーマット用のフォールバック。
    """
    data = file_path.read_bytes()
    SOI = b'\xff\xd8'
    EOI = b'\xff\xd9'

    # 全JPEGブロブを探索し、最大サイズのものを選択（＝プレビュー画像の可能性が高い）
    best_jpeg = None
    best_size = 0
    search_start = 0

    while True:
        soi_pos = data.find(SOI, search_start)
        if soi_pos == -1:
            break
        eoi_pos = data.find(EOI, soi_pos + 2)
        if eoi_pos == -1:
            break
        jpeg_data = data[soi_pos:eoi_pos + 2]
        if len(jpeg_data) > best_size:
            best_size = len(jpeg_data)
            best_jpeg = jpeg_data
        search_start = eoi_pos + 2

    if best_jpeg and best_size > 1000:  # 最低1KB以上のみ（ゴミデータ除外）
        try:
            img = Image.open(io.BytesIO(best_jpeg))
            try:
                img = ImageOps.exif_transpose(img)
            except Exception:
                pass
            return img
        except Exception:
            pass

    return None


def extract_raw_metadata(file_path: Path) -> Dict[str, Any]:
    """
    RAWファイルからメタデータ（撮影日時、カメラ機種、露出情報、画像サイズなど）を抽出する。
    埋め込みプレビューのExif、およびRAWファイル構造から網羅的に取得する。
    """
    stat = file_path.stat()
    file_size = stat.st_size

    # デフォルト値（ファイル更新日時フォールバック）
    fallback_dt = datetime.fromtimestamp(stat.st_mtime)
    date_taken = fallback_dt.strftime("%Y-%m-%d %H:%M:%S")
    camera_model = "RAW写真"
    width = 0
    height = 0
    exposure_bias = 0.0
    shutter_speed = None
    f_number = None
    iso = None
    focal_length = None
    lens_model = None
    subsec_time = None

    # 1 & 2. rawpy から基本サイズおよび埋め込みプレビューのExifを取得
    exif = None
    exif_ifd = {}

    try:
        with rawpy.imread(str(file_path)) as raw:
            # RAWセンサーの有効ピクセル解像度
            if hasattr(raw, "sizes"):
                width = int(raw.sizes.width)
                height = int(raw.sizes.height)

            # 埋め込みプレビューのExif確認
            try:
                thumb = raw.extract_thumb()
                if thumb and thumb.format == rawpy.ThumbFormat.JPEG:
                    thumb_img = Image.open(io.BytesIO(thumb.data))
                    exif = thumb_img.getexif()
                    if exif:
                        try:
                            exif_ifd = exif.get_ifd(0x8769)
                        except Exception as e:
                            logger.warning(f"Exif IFD取得失敗 ({file_path}): {e}")
                            exif_ifd = {}
            except Exception as e:
                logger.warning(f"RAWサムネイル抽出スキップ ({file_path}): {e}")
    except Exception as e:
        logger.warning(f"rawpy読み込み失敗 ({file_path}): {e}")

    # 埋め込みプレビューにExifがない場合、RAW本体からの取得を試行（TIFFベースRAWなど）
    if not exif:
        try:
            with Image.open(file_path) as raw_img:
                exif = raw_img.getexif()
                if exif:
                    try:
                        exif_ifd = exif.get_ifd(0x8769)
                    except Exception:
                        exif_ifd = {}
        except Exception:
            pass

    # バイナリJPEG抽出フォールバック（X3F等、rawpyで読めないフォーマット用）
    if not exif:
        try:
            embedded_img = _extract_embedded_jpeg(file_path)
            if embedded_img:
                exif = embedded_img.getexif()
                if exif:
                    try:
                        exif_ifd = exif.get_ifd(0x8769)
                    except Exception:
                        exif_ifd = {}
        except Exception:
            pass

    # EXIFデータの解析
    if exif:
        # 撮影日時
        raw_date = (
            exif_ifd.get(0x9003) or
            exif.get(0x9003) or
            exif.get(0x0132) or
            exif_ifd.get(0x0132)
        )
        parsed = parse_exif_date_str(str(raw_date) if raw_date else None)
        if parsed:
            date_taken = parsed

        # サブ秒
        raw_subsec = exif_ifd.get(0x9291) or exif.get(0x9291) or exif_ifd.get(0x9290) or exif.get(0x9290)
        if raw_subsec:
            subsec_time = str(raw_subsec).strip()

        # カメラ機種 (Model: 0x0110)
        model = exif.get(0x0110) or exif_ifd.get(0x0110)
        if model:
            camera_model = str(model).replace("\x00", "").strip() or "不明"

        # レンズ機種名 (LensModel: 0xa434)
        raw_lens = exif_ifd.get(0xa434) or exif.get(0xa434)
        if raw_lens:
            clean_lens = str(raw_lens).replace("\x00", "").strip()
            if is_valid_lens_name(clean_lens):
                lens_model = clean_lens

        # 露出補正値 (ExposureBiasValue: 0x9204)
        raw_bias = exif_ifd.get(0x9204) or exif.get(0x9204)
        if raw_bias is not None:
            try:
                exposure_bias = round(float(raw_bias), 2)
            except Exception:
                pass

        # シャッター速度 (ExposureTime: 0x829a)
        raw_exp = exif_ifd.get(0x829a) or exif.get(0x829a)
        if raw_exp is not None:
            try:
                exp_val = float(raw_exp)
                if exp_val > 0:
                    if exp_val < 1.0:
                        shutter_speed = f"1/{int(round(1.0 / exp_val))}"
                    else:
                        shutter_speed = f"{exp_val:.1f}s"
            except Exception:
                pass

        # F値 (FNumber: 0x829d)
        raw_fnum = exif_ifd.get(0x829d) or exif.get(0x829d)
        if raw_fnum is not None:
            try:
                f_number = round(float(raw_fnum), 1)
            except Exception:
                pass

        # ISO感度 (ISOSpeedRatings: 0x8827)
        raw_iso = exif_ifd.get(0x8827) or exif.get(0x8827)
        if raw_iso is not None:
            try:
                iso = int(raw_iso)
            except Exception:
                pass

        # 焦点距離 (FocalLength: 0x920a)
        raw_focal = exif_ifd.get(0x920a) or exif.get(0x920a)
        if raw_focal is not None:
            try:
                focal_length = round(float(raw_focal), 1)
            except Exception:
                pass

        # 画像の向き (Orientation: 0x0112) に応じた幅・高さのスワップ
        # 5, 6, 7, 8 は 90度または 270度回転を表すため、縦横を反転
        raw_orient = exif.get(0x0112) or exif_ifd.get(0x0112)
        if raw_orient in (5, 6, 7, 8):
            if width > 0 and height > 0 and width >= height:
                width, height = height, width


    # 標準Exif (0xA434) でレンズ機種名が取得できなかった場合、Panasonic MakerNote / XMP からフォールバック抽出
    if not is_valid_lens_name(lens_model):
        lens_model = extract_fallback_lens_model(file_path)

    # Exif日時が取れなかった場合、ファイル名から抽出を試みる
    if not date_taken or date_taken == fallback_dt.strftime("%Y-%m-%d %H:%M:%S"):
        try:
            from .scanner import parse_filename_datetime
            fn_date = parse_filename_datetime(file_path.name)
            if fn_date:
                date_taken = fn_date
        except Exception:
            pass

    year_month = date_taken[:7] if len(date_taken) >= 7 else ""

    return {
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
        "is_raw": 1,
        "raw_format": file_path.suffix.lower(),
        "volume_serial": None,
    }
