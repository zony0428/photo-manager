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
from typing import Any, Dict, List, Optional, Tuple, Union
from PIL import Image, ImageFile, ImageOps

ImageFile.LOAD_TRUNCATED_IMAGES = True

try:
    import rawpy
except Exception as _rawpy_err:
    rawpy = None  # type: ignore[assignment]

logger = logging.getLogger("raw_loader")

# サポートするRAW拡張子一覧（大文字小文字不問）
SUPPORTED_RAW_EXTENSIONS = {
    ".rw2",  # Panasonic Lumix
    ".arw",  # Sony α
    ".srf",  # Sony α (旧)
    ".sr2",  # Sony α (旧)
    ".arq",  # Sony Pixel Shift Multi Shooting
    ".cr2",  # Canon EOS (旧)
    ".cr3",  # Canon EOS (新/CR3)
    ".crw",  # Canon PowerShot / EOS (旧)
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
            from .security import read_loome_file_decrypted_bytes
            raw = read_loome_file_decrypted_bytes(file_path, max_bytes=131072)
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


def _apply_raw_orientation(img: Image.Image, outer_orient: Optional[int] = None) -> Image.Image:
    """
    埋め込みプレビュー画像自身のExif Orientation、または外側のRAW TIFF IFD0 Orientationを安全に適用する。
    二重回転を防ぐため、内側Exifに有効な回転がある場合のみ exif_transpose を行い、
    内側に回転が無い場合にのみ外側TIFFのOrientationを適用する。
    """
    inner_orient = None
    try:
        inner_exif = img.getexif()
        if inner_exif:
            inner_orient = inner_exif.get(0x0112)
    except Exception:
        inner_orient = None

    if inner_orient in (2, 3, 4, 5, 6, 7, 8):
        try:
            return ImageOps.exif_transpose(img)
        except Exception as e:
            logger.debug(f"埋め込みJPEG Exif回転スキップ: {e}")
            return img

    if outer_orient in (2, 3, 4, 5, 6, 7, 8):
        # 5,6,7,8 (縦位置90/270度回転) は、ピクセルがまだ横長（未回転）の場合のみ適用する
        if outer_orient in (5, 6, 7, 8) and img.width < img.height:
            return img
        try:
            if outer_orient == 2:
                return img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            elif outer_orient == 3:
                return img.transpose(Image.Transpose.ROTATE_180)
            elif outer_orient == 4:
                return img.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
            elif outer_orient == 5:
                return img.transpose(Image.Transpose.TRANSPOSE)
            elif outer_orient == 6:
                return img.transpose(Image.Transpose.ROTATE_270)
            elif outer_orient == 7:
                return img.transpose(Image.Transpose.TRANSVERSE)
            elif outer_orient == 8:
                return img.transpose(Image.Transpose.ROTATE_90)
        except Exception as e:
            logger.debug(f"外側TIFF Orientation回転スキップ: {e}")

    return img


def _extract_tiff_preview_and_info(file_path: Path) -> Tuple[Optional[Image.Image], Optional[int], int, int]:
    """
    TIFFベースのRAWファイル（Sony .ARW / .SR2 / .ARQ, Nikon .NEF, Canon .CR2, DNG, PEF, ORF, RW2 等）の
    IFDツリー（IFD0 / SubIFDs 0x014A / ExifIFD 0x8769 / MakerNote 0x927C / IFD1）を直接走査し、
    (最大解像度の埋め込みプレビューImage, IFD0 Orientation, センサー幅, センサー高さ) を返す。
    Sony αのロスレス圧縮RAW (M/S/L) や新型ボディ等、LibRawが未対応のRAWでも1ms未満で確実に抽出できる。
    """
    from .security import decrypted_file_path_context

    ifd0_orient: Optional[int] = None
    sensor_w = 0
    sensor_h = 0
    candidates: List[Tuple[int, int]] = []  # (offset, length)

    try:
        with decrypted_file_path_context(file_path) as dec_p, open(dec_p, "rb") as f:
            f.seek(0, os.SEEK_END)
            fsize = f.tell()
            if fsize < 64:
                return None, None, 0, 0

            f.seek(0)
            head = f.read(8)
            if head[:4] in (b"II*\x00", b"IIU\x00", b"II\xbc\x01", b"IIRS"):
                endian = "<"
            elif head[:4] == b"MM\x00*":
                endian = ">"
            else:
                return None, None, 0, 0

            first_ifd = struct.unpack(endian + "I", head[4:8])[0]
            queue: List[Tuple[int, bool]] = [(first_ifd, True)]
            visited = set()

            def _read_u32_list(typ: int, cnt: int, val_bytes: bytes) -> List[int]:
                if cnt <= 0 or cnt > 64:
                    return []
                if typ == 3:  # SHORT
                    if cnt == 1:
                        return [struct.unpack(endian + "H", val_bytes[:2])[0]]
                    elif cnt == 2:
                        return list(struct.unpack(endian + "HH", val_bytes[:4]))
                    off = struct.unpack(endian + "I", val_bytes)[0]
                    if 0 < off and off + cnt * 2 <= fsize:
                        f.seek(off)
                        buf = f.read(cnt * 2)
                        return list(struct.unpack(f"{endian}{cnt}H", buf))
                elif typ in (4, 13):  # LONG or IFD
                    if cnt == 1:
                        return [struct.unpack(endian + "I", val_bytes)[0]]
                    off = struct.unpack(endian + "I", val_bytes)[0]
                    if 0 < off and off + cnt * 4 <= fsize:
                        f.seek(off)
                        buf = f.read(cnt * 4)
                        return list(struct.unpack(f"{endian}{cnt}I", buf))
                return []

            while queue and len(visited) < 32:
                ifd_off, is_ifd0 = queue.pop(0)
                if ifd_off <= 0 or ifd_off + 2 > fsize or ifd_off in visited:
                    continue
                visited.add(ifd_off)

                f.seek(ifd_off)
                cnt_b = f.read(2)
                if len(cnt_b) < 2:
                    continue
                num_entries = struct.unpack(endian + "H", cnt_b)[0]
                if num_entries <= 0 or num_entries > 512:
                    continue

                entries_b = f.read(num_entries * 12)
                if len(entries_b) < num_entries * 12:
                    continue
                next_b = f.read(4)
                next_ifd = struct.unpack(endian + "I", next_b)[0] if len(next_b) == 4 else 0
                if 0 < next_ifd < fsize and next_ifd not in visited:
                    queue.append((next_ifd, False))

                jpeg_off = 0
                jpeg_len = 0
                strip_off = 0
                strip_len = 0
                ifd_w = 0
                ifd_h = 0

                for i in range(num_entries):
                    eb = entries_b[i * 12:(i + 1) * 12]
                    tag, typ, cnt = struct.unpack(endian + "HHI", eb[:8])
                    val_bytes = eb[8:12]

                    if tag == 0x0112 and is_ifd0 and ifd0_orient is None:
                        vals = _read_u32_list(typ, 1, val_bytes)
                        if vals:
                            ifd0_orient = vals[0]
                    elif tag == 0x0100:
                        vals = _read_u32_list(typ, 1, val_bytes)
                        if vals:
                            ifd_w = vals[0]
                    elif tag == 0x0101:
                        vals = _read_u32_list(typ, 1, val_bytes)
                        if vals:
                            ifd_h = vals[0]
                    elif tag == 0x0201:
                        vals = _read_u32_list(typ, 1, val_bytes)
                        if vals:
                            jpeg_off = vals[0]
                    elif tag == 0x0202:
                        vals = _read_u32_list(typ, 1, val_bytes)
                        if vals:
                            jpeg_len = vals[0]
                    elif tag == 0x0111 and cnt == 1:
                        vals = _read_u32_list(typ, 1, val_bytes)
                        if vals:
                            strip_off = vals[0]
                    elif tag == 0x0117 and cnt == 1:
                        vals = _read_u32_list(typ, 1, val_bytes)
                        if vals:
                            strip_len = vals[0]
                    elif tag == 0x002E and cnt > 1024:  # Panasonic RW2 JpgFromRaw
                        off = struct.unpack(endian + "I", val_bytes)[0]
                        if 0 < off and off + cnt <= fsize:
                            candidates.append((off, cnt))
                    elif tag == 0x2001 and cnt > 1024:  # Sony MakerNote PreviewImage
                        off = struct.unpack(endian + "I", val_bytes)[0]
                        if 0 < off and off + cnt <= fsize:
                            candidates.append((off, cnt))
                    elif tag in (0x014A, 0x8769):  # SubIFDs or ExifIFD
                        for sub_off in _read_u32_list(typ, cnt, val_bytes):
                            if 0 < sub_off < fsize and sub_off not in visited:
                                queue.append((sub_off, False))

                if ifd_w * ifd_h > sensor_w * sensor_h:
                    sensor_w, sensor_h = ifd_w, ifd_h
                if jpeg_off > 0 and jpeg_len > 1024 and jpeg_off + jpeg_len <= fsize:
                    candidates.append((jpeg_off, jpeg_len))
                if strip_off > 0 and strip_len > 1024 and strip_off + strip_len <= fsize:
                    candidates.append((strip_off, strip_len))

            # 候補をバイトサイズの大きい順に検証し、最大ピクセル面積の有効なJPEGを選択
            best_img: Optional[Image.Image] = None
            best_area = 0
            seen_ranges = set()

            for off, length in sorted(candidates, key=lambda x: x[1], reverse=True):
                if (off, length) in seen_ranges:
                    continue
                seen_ranges.add((off, length))
                f.seek(off)
                probe = f.read(min(64, length))
                soi_idx = probe.find(b"\xff\xd8\xff")
                if soi_idx < 0:
                    continue
                f.seek(off + soi_idx)
                jpeg_bytes = f.read(length - soi_idx)
                try:
                    cand_img = Image.open(io.BytesIO(jpeg_bytes))
                    cand_img.load()
                    area = cand_img.width * cand_img.height
                    if area > best_area:
                        best_area = area
                        best_img = cand_img
                        # 十分な高解像度プレビュー（長辺1000px以上）が見つかれば確定
                        if max(cand_img.width, cand_img.height) >= 1000:
                            break
                except Exception:
                    continue

            if best_img is not None:
                best_img = _apply_raw_orientation(best_img, ifd0_orient)
                return best_img, ifd0_orient, sensor_w, sensor_h
    except Exception as e:
        logger.debug(f"TIFF IFDプレビュー抽出スキップ ({file_path.name}): {e}")

    return None, ifd0_orient, sensor_w, sensor_h


def _find_jpeg_end_after_sos(data: bytes, soi_pos: int) -> int:
    """
    JPEG SOI (0xFFD8) からセグメント長に従ってヘッダを読み飛ばし、
    APP1 (Exif) 内の極小サムネイル EOI (0xFFD9) での誤切断を回避して真の EOI 終端位置を返す。
    プログレッシブJPEG（複数SOSスキャン）にも対応する。
    """
    p = soi_pos + 2
    n = len(data)
    saw_sos = False

    while p + 2 <= n:
        if data[p] != 0xFF:
            if saw_sos:
                # SOSスキャンデータ内から次のマーカー (0xFF + 非0x00/非RST) を高速探索
                search_p = p
                while True:
                    ff_pos = data.find(b"\xff", search_p)
                    if ff_pos < 0 or ff_pos + 1 >= n:
                        return -1
                    nxt = data[ff_pos + 1]
                    if nxt == 0x00 or nxt == 0xFF or (0xD0 <= nxt <= 0xD7):
                        search_p = ff_pos + 2
                        continue
                    if nxt == 0xD9:
                        return ff_pos + 2
                    p = ff_pos
                    break
            else:
                return -1

        while p < n and data[p] == 0xFF:
            p += 1
        if p >= n:
            return -1
        marker = data[p]
        p += 1

        if marker == 0xD9:
            return p if saw_sos else -1
        if marker == 0x00 or marker == 0xD8:
            return -1
        if (0xD0 <= marker <= 0xD7) or marker == 0x01:
            continue
        if p + 2 > n:
            return -1
        seg_len = (data[p] << 8) | data[p + 1]
        if seg_len < 2 or p + seg_len > n:
            return -1
        p += seg_len
        if marker == 0xDA:
            saw_sos = True

    return -1


def _extract_embedded_jpeg(file_path: Path) -> Optional[Image.Image]:
    """
    RAWファイルから埋め込みプレビューJPEGを直接探索・抽出する。
    1. まずTIFF IFDツリー（0x0201/0x0202等）から正確なオフセット・長さとOrientationを取得する。
    2. 非TIFF形式（CR3, RAF, X3F等）の場合は、JPEGセグメント構造を辿ってAPP1内サムネイル誤切断や
       RAWセンサーデータ内のランダムなFFD8..FFD9誤検知を防ぎつつ最大解像度のJPEGを抽出する。
    """
    tiff_img, ifd0_orient, _, _ = _extract_tiff_preview_and_info(file_path)
    if tiff_img is not None:
        return tiff_img

    from .security import read_loome_file_decrypted_bytes
    data = read_loome_file_decrypted_bytes(file_path)
    if not data or len(data) < 2048:
        return None

    candidates: List[bytes] = []
    search_start = 0
    limit = len(data) - 4

    while search_start < limit:
        soi_pos = data.find(b"\xff\xd8\xff", search_start)
        if soi_pos == -1 or soi_pos + 4 >= len(data):
            break
        fourth = data[soi_pos + 3]
        if not (0xC0 <= fourth <= 0xFE and fourth not in (0xD8, 0xD9)):
            search_start = soi_pos + 2
            continue

        eoi_end = _find_jpeg_end_after_sos(data, soi_pos)
        if eoi_end > soi_pos + 1024:
            candidates.append(data[soi_pos:eoi_end])
            search_start = eoi_end
        else:
            # フォールバック: APP1等の先頭セグメント長を跨いで最初の EOI を試行
            seg_skip = soi_pos + 2
            if fourth in (0xE0, 0xE1) and soi_pos + 6 <= len(data):
                app_len = (data[soi_pos + 4] << 8) | data[soi_pos + 5]
                if app_len >= 2 and soi_pos + 4 + app_len < len(data):
                    seg_skip = soi_pos + 4 + app_len
            eoi_pos = data.find(b"\xff\xd9", seg_skip)
            if eoi_pos != -1 and (eoi_pos + 2 - soi_pos) > 1024:
                candidates.append(data[soi_pos:eoi_pos + 2])
            search_start = soi_pos + 2

    best_img: Optional[Image.Image] = None
    best_area = 0
    for jpeg_data in sorted(candidates, key=len, reverse=True):
        try:
            img = Image.open(io.BytesIO(jpeg_data))
            img.load()
            area = img.width * img.height
            if area > best_area:
                best_area = area
                best_img = img
                if max(img.width, img.height) >= 1000:
                    break
        except Exception:
            continue

    if best_img is not None:
        return _apply_raw_orientation(best_img, ifd0_orient)

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
    if rawpy is not None:
        try:
            from .security import decrypted_file_path_context
            with decrypted_file_path_context(path_obj) as dec_p, rawpy.imread(str(dec_p)) as raw:
                flip_orient = None
                if hasattr(raw, "sizes"):
                    flip_val = getattr(raw.sizes, "flip", 0)
                    flip_orient = {3: 3, 5: 8, 6: 6}.get(flip_val)

                no_thumb_errs = tuple(
                    e for e in (
                        getattr(rawpy, "LibRawNoThumbnailError", None),
                        getattr(rawpy, "LibRawUnsupportedThumbnailError", None),
                        getattr(rawpy, "NoThumbnailError", None),
                    ) if e is not None
                ) or (Exception,)

                try:
                    thumb = raw.extract_thumb()
                except no_thumb_errs:
                    thumb = None

                if thumb is not None:
                    if thumb.format == rawpy.ThumbFormat.JPEG:
                        img = Image.open(io.BytesIO(thumb.data))
                        img.load()
                        img = _apply_raw_orientation(img, flip_orient)
                        # 万が一160x120等の極小サムネイルだった場合はTIFF IFD内の高解像度プレビューも確認
                        if max(img.width, img.height) < 400:
                            tiff_img, _, _, _ = _extract_tiff_preview_and_info(path_obj)
                            if tiff_img is not None and (tiff_img.width * tiff_img.height) > (img.width * img.height):
                                return tiff_img
                        return img
                    elif thumb.format == rawpy.ThumbFormat.BITMAP:
                        img = Image.fromarray(thumb.data)
                        img = _apply_raw_orientation(img, flip_orient)
                        return img
        except Exception as e:
            logger.debug(f"rawpyサムネイル展開スキップ ({path_obj.name}): {e}")

    # 2. フォールバック: TIFF IFD直接解析およびバイナリJPEGセグメント探索
    #    (Sony α ロスレス圧縮RAW M/S、新型カメラ、X3F等、LibRaw未対応のRAWフォーマット用)
    try:
        img = _extract_embedded_jpeg(path_obj)
        if img is not None:
            return img
    except Exception as e:
        logger.debug(f"埋め込みJPEG抽出フォールバックスキップ ({path_obj.name}): {e}")

    # 3. フォールバック: DNGなどPillow自身で直接開ける非圧縮/標準TIFF RAWの場合
    try:
        from .security import is_vault_encrypted_file, read_loome_file_decrypted_bytes
        src = io.BytesIO(read_loome_file_decrypted_bytes(path_obj)) if is_vault_encrypted_file(path_obj) else path_obj
        with Image.open(src) as img:
            img.load()
            img = ImageOps.exif_transpose(img)
            return img.copy()
    except Exception as e:
        logger.debug(f"Pillow RAWオープンフォールバックスキップ ({path_obj.name}): {e}")

    # 4. 最終フォールバック: 埋め込みJPEGを持たないRAWに対してrawpyの高速ハーフサイズ現像を試行
    if rawpy is not None:
        try:
            from .security import decrypted_file_path_context
            with decrypted_file_path_context(path_obj) as dec_p, rawpy.imread(str(dec_p)) as raw:
                rgb = raw.postprocess(half_size=True, use_camera_wb=True)
                return Image.fromarray(rgb)
        except Exception as e:
            logger.debug(f"rawpyハーフサイズ現像フォールバックスキップ ({path_obj.name}): {e}")

    return None


def extract_raw_full_preview(file_path: Union[str, Path], max_dimension: Optional[int] = None) -> Optional[Tuple[bytes, str, int, int]]:
    """
    RAWファイルからカメラ内現像済みの埋め込みフルサイズ（高解像度）プレビュー画像を抽出し、
    (jpeg_bytes, mime_type, width, height) のタプルで返す。
    ライトボックス（全画面表示・拡大ピント確認）およびJPEG書き出し用。

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


def _load_outer_tiff_exif(file_path: Path) -> Tuple[Optional[Image.Exif], Dict[int, Any]]:
    """
    TIFFベースのRAWファイル（.ARW, .NEF, .CR2, .DNG 等）の先頭512KBから
    外側のTIFF IFD0およびExifIFD (0x8769) を直接読み取る。
    """
    try:
        from .security import read_loome_file_decrypted_bytes
        raw_head = read_loome_file_decrypted_bytes(file_path, max_bytes=524288)
        if not raw_head or len(raw_head) < 16:
            return None, {}
        if raw_head[:4] not in (b"II*\x00", b"MM\x00*"):
            return None, {}
        ex = Image.Exif()
        ex.load(raw_head)
        ex_ifd: Dict[int, Any] = {}
        try:
            ifd_obj = ex.get_ifd(0x8769)
            if isinstance(ifd_obj, dict):
                ex_ifd = dict(ifd_obj)
        except Exception:
            ex_ifd = {}
        return ex, ex_ifd
    except Exception as e:
        logger.debug(f"外側TIFF Exif直接読み取りスキップ ({file_path.name}): {e}")
        return None, {}


def extract_raw_metadata(file_path: Path) -> Dict[str, Any]:
    """
    RAWファイルからメタデータ（撮影日時、カメラ機種、露出情報、画像サイズ、GPSなど）を抽出する。
    埋め込みプレビューのExif、外側TIFF IFD0/ExifIFD、およびRAWファイル構造から網羅的に取得する。
    """
    stat = file_path.stat()
    from .security import decrypted_file_path_context, get_logical_file_size
    file_size = get_logical_file_size(file_path)

    # デフォルト値（ファイル更新日時フォールバック）
    fallback_dt = datetime.fromtimestamp(stat.st_mtime)
    date_taken = fallback_dt.strftime("%Y-%m-%d %H:%M:%S")
    camera_model = "RAW写真"
    has_exif_date = False
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

    # 1. まず外側TIFFヘッダ (IFD0 / ExifIFD) を直接解析（ARW等のメタデータの主格納場所）
    exif, exif_ifd = _load_outer_tiff_exif(file_path)

    # 2. rawpy から基本サイズおよび埋め込みプレビューのExifを取得・補完
    if rawpy is not None:
        try:
            with decrypted_file_path_context(file_path) as dec_raw_path, rawpy.imread(str(dec_raw_path)) as raw:
                if hasattr(raw, "sizes"):
                    width = int(raw.sizes.width)
                    height = int(raw.sizes.height)

                if not exif or not exif_ifd:
                    try:
                        thumb = raw.extract_thumb()
                        if thumb and thumb.format == rawpy.ThumbFormat.JPEG:
                            thumb_img = Image.open(io.BytesIO(thumb.data))
                            t_exif = thumb_img.getexif()
                            if t_exif:
                                if not exif:
                                    exif = t_exif
                                try:
                                    t_ifd = t_exif.get_ifd(0x8769)
                                    if isinstance(t_ifd, dict):
                                        for k, v in t_ifd.items():
                                            exif_ifd.setdefault(k, v)
                                except Exception:
                                    pass
                    except Exception as e:
                        logger.debug(f"RAWサムネイルExif補完スキップ ({file_path.name}): {e}")
        except Exception as e:
            logger.debug(f"rawpyメタデータ読み込みスキップ ({file_path.name}): {e}")

    # 3. TIFF IFDツリー走査または埋め込みJPEGからセンサーサイズ・Exifをフォールバック補完
    if width <= 0 or height <= 0 or not exif:
        tiff_img, _, sensor_w, sensor_h = _extract_tiff_preview_and_info(file_path)
        if width <= 0 or height <= 0:
            if sensor_w > 0 and sensor_h > 0:
                width, height = sensor_w, sensor_h
            elif tiff_img is not None:
                width, height = tiff_img.size
        if not exif and tiff_img is not None:
            try:
                exif = tiff_img.getexif()
                if exif and not exif_ifd:
                    exif_ifd = dict(exif.get_ifd(0x8769) or {})
            except Exception:
                pass

    if not exif:
        try:
            embedded_img = _extract_embedded_jpeg(file_path)
            if embedded_img:
                if width <= 0 or height <= 0:
                    width, height = embedded_img.size
                exif = embedded_img.getexif()
                if exif:
                    try:
                        exif_ifd = dict(exif.get_ifd(0x8769) or {})
                    except Exception:
                        exif_ifd = {}
        except Exception as e:
            logger.debug(f"埋め込みJPEGメタデータ抽出スキップ ({file_path.name}): {e}")

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
        has_exif_date = bool(parsed)
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
            except (ValueError, TypeError) as e:
                logger.debug(f"露出補正値変換スキップ: {e}")

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
            except (ValueError, TypeError, ZeroDivisionError) as e:
                logger.debug(f"シャッター速度変換スキップ: {e}")

        # F値 (FNumber: 0x829d)
        raw_fnum = exif_ifd.get(0x829d) or exif.get(0x829d)
        if raw_fnum is not None:
            try:
                f_number = round(float(raw_fnum), 1)
            except (ValueError, TypeError) as e:
                logger.debug(f"F値変換スキップ: {e}")

        # ISO感度 (ISOSpeedRatings: 0x8827)
        raw_iso = exif_ifd.get(0x8827) or exif.get(0x8827)
        if raw_iso is not None:
            try:
                iso = int(raw_iso)
            except (ValueError, TypeError) as e:
                logger.debug(f"ISO感度変換スキップ: {e}")

        # 焦点距離 (FocalLength: 0x920a)
        raw_focal = exif_ifd.get(0x920a) or exif.get(0x920a)
        if raw_focal is not None:
            try:
                focal_length = round(float(raw_focal), 1)
            except (ValueError, TypeError) as e:
                logger.debug(f"焦点距離変換スキップ: {e}")

        # ExifIFD 内の有効画像寸法補完
        if width <= 0 or height <= 0:
            ex_w = exif_ifd.get(0xA002) or exif.get(0x0100)
            ex_h = exif_ifd.get(0xA003) or exif.get(0x0101)
            try:
                if ex_w and ex_h:
                    width, height = int(ex_w), int(ex_h)
            except Exception:
                pass

        # 画像の向き (Orientation: 0x0112) に応じた幅・高さのスワップ
        raw_orient = exif.get(0x0112) or exif_ifd.get(0x0112)
        if raw_orient in (5, 6, 7, 8):
            if width > 0 and height > 0 and width >= height:
                width, height = height, width

        # GPS情報 (GPS IFD: 0x8825)
        try:
            from .scanner import _parse_gps_coord
            gps_ifd = exif.get_ifd(0x8825)
            if gps_ifd:
                latitude = _parse_gps_coord(gps_ifd.get(2), gps_ifd.get(1))
                longitude = _parse_gps_coord(gps_ifd.get(4), gps_ifd.get(3))
                if latitude is not None and longitude is not None:
                    if abs(latitude) < 0.0001 and abs(longitude) < 0.0001:
                        latitude = None
                        longitude = None
        except Exception as e:
            logger.debug(f"RAW GPS情報パーススキップ: {e}")

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
        except Exception as e:
            logger.debug(f"ファイル名日時パーススキップ ({file_path.name}): {e}")

    year_month = date_taken[:7] if len(date_taken) >= 7 else ""
    gps_source = "exif" if (latitude is not None and longitude is not None) else None

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
            logger.warning(f"RAW逆ジオコーディング失敗 ({file_path.name}): {e}")

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
        "has_exif_date": has_exif_date,
        "volume_serial": None,
        "latitude": latitude,
        "longitude": longitude,
        "gps_source": gps_source,
        "country": country,
        "state": state,
        "city": city,
    }
