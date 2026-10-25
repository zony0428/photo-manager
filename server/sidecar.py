"""
サイドカーファイル（.xmp, .pp3, .dop 等）管理 ＆ XMPメタデータ解析・出力モジュール
外部現像ソフト（Adobe Lightroom / Camera Raw, darktable, RawTherapee, DxO PhotoLab, Capture One, Nikon NX Studio, SILKYPIX 等）の
サイドカーファイルの検出、インポート・移動・リネーム時の物理追随、XMPメタデータ（機材・GPS・評価・階層タグ・現像調整パラメータ）の
安全解析、およびエクスポート時の標準 .xmp サイドカー書き出しを提供する。
"""

import html
import logging
import os
import re
import shutil
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger("photo_manager.sidecar")

# 対応サイドカー拡張子（小文字）
SIDECAR_EXTENSIONS = {
    ".xmp",   # Adobe Lightroom / Camera Raw / darktable / Bridge 標準XMP
    ".pp3",   # RawTherapee
    ".arp",   # ART (Another RawTherapee)
    ".dop",   # DxO PhotoLab
    ".on1",   # ON1 Photo RAW
    ".cos",   # Capture One
    ".nksc",  # Nikon NX Studio
    ".spd",   # SILKYPIX Developer Studio
}


def is_sidecar_file(file_path: Union[str, Path]) -> bool:
    """指定ファイルが対応サイドカー拡張子を持つか判定する"""
    if not file_path:
        return False
    return Path(file_path).suffix.lower() in SIDECAR_EXTENSIONS


def find_sidecars_for_file(file_path: Union[str, Path]) -> List[Dict[str, Any]]:
    """
    指定された画像ファイルと同じ親ディレクトリ内に存在する付随サイドカーファイルをすべて検出する（大文字小文字無視）。
    - パターンA ("stem"): <p.stem>.<sidecar_ext> (例: DSC0001.ARW -> DSC0001.xmp)
    - パターンB ("full"): <p.name>.<sidecar_ext> (例: DSC0001.ARW -> DSC0001.ARW.xmp, DSC0001.ARW.pp3, DSC0001.ARW.dop)
    戻り値の各要素: {"path": Path, "pattern": "stem" | "full", "ext": orig_sidecar_suffix}
    """
    if not file_path:
        return []

    p = Path(file_path)
    parent = p.parent
    if not parent.exists() or not parent.is_dir():
        return []

    stem_lower = p.stem.lower()
    name_lower = p.name.lower()
    self_name_lower = p.name.lower()

    results: List[Dict[str, Any]] = []
    seen_paths: set = set()

    try:
        with os.scandir(str(parent)) as it:
            entries = list(it)
    except Exception as e:
        logger.warning(f"サイドカー探索時のディレクトリスキャン失敗 ({parent}): {e}")
        return []

    # 安定した順序のためファイル名昇順でソート
    entries.sort(key=lambda e: e.name.lower())

    for entry in entries:
        try:
            if not entry.is_file():
                continue
        except Exception as e:
            logger.debug(f"サイドカー候補のファイル種別確認スキップ ({entry.name}): {e}")
            continue

        ename = entry.name
        if ename.lower() == self_name_lower:
            continue

        suffix = Path(ename).suffix
        suffix_lower = suffix.lower()
        if suffix_lower not in SIDECAR_EXTENSIONS:
            continue

        base_without_sc = ename[:-len(suffix)]
        base_lower = base_without_sc.lower()

        pattern: Optional[str] = None
        if base_lower == name_lower:
            pattern = "full"
        elif base_lower == stem_lower:
            pattern = "stem"

        if pattern:
            sc_path = Path(entry.path)
            norm_key = str(sc_path).replace("/", "\\").lower()
            if norm_key not in seen_paths:
                seen_paths.add(norm_key)
                results.append({
                    "path": sc_path,
                    "pattern": pattern,
                    "ext": suffix,
                })

    return results


def _update_xmp_raw_filename_in_file(xmp_path: Path, old_file_path: Path, new_file_path: Path) -> None:
    """
    リネームまたは別名コピーされた .xmp ファイル内の crs:RawFileName 属性/要素を新しいファイル名に更新する。
    """
    if not xmp_path.exists() or xmp_path.suffix.lower() != ".xmp":
        return

    old_name = old_file_path.name
    new_name = new_file_path.name
    old_stem = old_file_path.stem
    new_stem = new_file_path.stem

    if old_name == new_name and old_stem == new_stem:
        return

    raw_text: Optional[str] = None
    used_encoding = "utf-8"
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            with open(xmp_path, "r", encoding=enc) as f:
                raw_text = f.read()
            used_encoding = enc
            break
        except Exception as e:
            logger.debug(f"XMP読み込みエンコーディング試行 ({enc}) スキップ ({xmp_path}): {e}")
            continue

    if not raw_text:
        return

    def _replace_attr(match: re.Match) -> str:
        prefix, val, suffix = match.group(1), match.group(2), match.group(3)
        if val.lower() == old_name.lower():
            return f"{prefix}{new_name}{suffix}"
        val_p = Path(val)
        if val_p.stem.lower() == old_stem.lower() and val_p.suffix:
            return f"{prefix}{new_stem}{val_p.suffix}{suffix}"
        return match.group(0)

    updated = re.sub(
        r'(crs:RawFileName\s*=\s*["\'])([^"\']+)(["\'])',
        _replace_attr,
        raw_text,
    )
    updated = re.sub(
        r'(<crs:RawFileName>\s*)([^<]+?)(\s*</crs:RawFileName>)',
        _replace_attr,
        updated,
    )

    if updated != raw_text:
        try:
            write_enc = "utf-8-sig" if used_encoding == "utf-8-sig" else "utf-8"
            with open(xmp_path, "w", encoding=write_enc) as f:
                f.write(updated)
        except Exception as e:
            logger.warning(f"XMP内の crs:RawFileName 更新失敗 ({xmp_path}): {e}")


def copy_sidecars_for_file(src_file: Union[str, Path], dest_file: Union[str, Path]) -> List[Path]:
    """
    src_file に付随する全サイドカーを dest_file.parent へ shutil.copy2 でコピーする。
    """
    src_p = Path(src_file)
    dest_p = Path(dest_file)
    sidecars = find_sidecars_for_file(src_p)
    copied: List[Path] = []

    for sc in sidecars:
        sc_path: Path = sc["path"]
        if not sc_path.exists():
            continue
        if sc["pattern"] == "stem":
            dest_name = f"{dest_p.stem}{sc['ext']}"
        else:
            dest_name = f"{dest_p.name}{sc['ext']}"

        dest_sc = dest_p.parent / dest_name
        try:
            if sc_path.resolve() != dest_sc.resolve():
                shutil.copy2(str(sc_path), str(dest_sc))
                if dest_sc.suffix.lower() == ".xmp" and src_p.name != dest_p.name:
                    _update_xmp_raw_filename_in_file(dest_sc, src_p, dest_p)
            copied.append(dest_sc)
        except Exception as e:
            logger.warning(f"サイドカーのコピー失敗 ({sc_path} -> {dest_sc}): {e}")

    return copied


def move_sidecars_for_file(src_file: Union[str, Path], dest_file: Union[str, Path]) -> List[Path]:
    """
    src_file に付随する全サイドカーを dest_file.parent へ shutil.move で移動する。
    """
    src_p = Path(src_file)
    dest_p = Path(dest_file)
    sidecars = find_sidecars_for_file(src_p)
    moved: List[Path] = []

    for sc in sidecars:
        sc_path: Path = sc["path"]
        if not sc_path.exists():
            continue
        if sc["pattern"] == "stem":
            dest_name = f"{dest_p.stem}{sc['ext']}"
        else:
            dest_name = f"{dest_p.name}{sc['ext']}"

        dest_sc = dest_p.parent / dest_name
        try:
            if sc_path.resolve() != dest_sc.resolve():
                shutil.move(str(sc_path), str(dest_sc))
                if dest_sc.suffix.lower() == ".xmp" and src_p.name != dest_p.name:
                    _update_xmp_raw_filename_in_file(dest_sc, src_p, dest_p)
            moved.append(dest_sc)
        except Exception as e:
            logger.warning(f"サイドカーの移動失敗 ({sc_path} -> {dest_sc}): {e}")

    return moved


def rename_sidecars_for_file(src_file: Union[str, Path], new_file: Union[str, Path]) -> List[Path]:
    """
    src_file に付随する全サイドカーを同じ（または new_file の）フォルダ内で new_file に合わせた名前にリネームする。
    リネームしたサイドカーが .xmp である場合、crs:RawFileName も new_file に合わせて書き換える。
    """
    src_p = Path(src_file)
    new_p = Path(new_file)
    sidecars = find_sidecars_for_file(src_p)
    renamed: List[Path] = []

    for sc in sidecars:
        sc_path: Path = sc["path"]
        if not sc_path.exists():
            continue
        if sc["pattern"] == "stem":
            new_sc_name = f"{new_p.stem}{sc['ext']}"
        else:
            new_sc_name = f"{new_p.name}{sc['ext']}"

        new_sc = new_p.parent / new_sc_name
        try:
            if str(sc_path) == str(new_sc):
                renamed.append(new_sc)
                continue

            is_case_only = (str(sc_path).lower() == str(new_sc).lower())
            if is_case_only:
                tmp_sc = sc_path.parent / f".__pm_sc_tmp_{uuid.uuid4().hex[:8]}{sc['ext']}"
                sc_path.rename(tmp_sc)
                tmp_sc.rename(new_sc)
            else:
                if new_sc.exists():
                    os.replace(str(sc_path), str(new_sc))
                else:
                    sc_path.rename(new_sc)

            if new_sc.suffix.lower() == ".xmp":
                _update_xmp_raw_filename_in_file(new_sc, src_p, new_p)

            renamed.append(new_sc)
        except Exception as e:
            logger.warning(f"サイドカーのリネーム失敗 ({sc_path} -> {new_sc}): {e}")

    return renamed


# ==============================================================================
# XMP メタデータ解析
# ==============================================================================

def _empty_xmp_info() -> Dict[str, Any]:
    """XMPが存在しない場合またはパース失敗時の標準戻り値を返す"""
    return {
        "has_xmp": False,
        "xmp_path": None,
        "xmp_name": None,
        "hardware": {},
        "rating": {
            "has_rating": False,
            "raw_xmp_rating": None,
            "pm_rating": None,
            "mapped_rating": None,
        },
        "tags": [],
        "adjustments": {
            "has_adjustments": False,
            "rotation": 0,
            "fine_angle": 0.0,
            "has_crop": False,
            "crop_x": None,
            "crop_y": None,
            "crop_w": None,
            "crop_h": None,
            "crop_aspect": None,
            "brightness": 0,
            "contrast": 0,
            "saturation": 0,
            "summary": [],
        },
    }


def _normalize_xmp_datetime(val: Optional[str]) -> Optional[str]:
    """
    XMP内の日時文字列（ISO 8601形式 2026-10-25T14:30:00+09:00 や Exif形式 2026:10:25 14:30:00）を
    Photo Manager 標準の YYYY-MM-DD HH:MM:SS に正規化する。
    """
    if not val:
        return None
    cleaned = str(val).strip()
    m = re.search(r"(\d{4})[:\-](\d{2})[:\-](\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?", cleaned)
    if m:
        y, mo, d, h, mi, s = m.groups()
        s_str = s if s else "00"
        try:
            if 1970 <= int(y) <= 2099 and 1 <= int(mo) <= 12 and 1 <= int(d) <= 31:
                return f"{y}-{mo}-{d} {h}:{mi}:{s_str}"
        except Exception as e:
            logger.debug(f"XMP日時検証スキップ ({val}): {e}")
    return None


def _parse_xmp_gps_coord(val: Optional[str], ref_hint: Optional[str] = None) -> Optional[float]:
    """
    XMP形式のGPS座標（例: "35,40.8N", "35,40,48N", "35.6800", "-139.76"）を10進数の float に変換する。
    """
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None

    direction = (ref_hint or "").strip().upper()
    if s[-1:].upper() in ("N", "S", "E", "W"):
        direction = s[-1:].upper()
        s = s[:-1].strip()
    elif s[:1].upper() in ("N", "S", "E", "W"):
        direction = s[:1].upper()
        s = s[1:].strip()

    try:
        if "," in s:
            parts = [p.strip() for p in s.split(",") if p.strip()]
            deg = float(parts[0]) if len(parts) >= 1 else 0.0
            minutes = float(parts[1]) if len(parts) >= 2 else 0.0
            seconds = float(parts[2]) if len(parts) >= 3 else 0.0
            sign = -1.0 if deg < 0 else 1.0
            dec = abs(deg) + minutes / 60.0 + seconds / 3600.0
            dec *= sign
        else:
            dec = float(s)

        if direction in ("S", "W") and dec > 0:
            dec = -dec
        return round(dec, 7)
    except Exception as e:
        logger.debug(f"XMP GPS座標パーススキップ ({val}): {e}")
        return None


def _local_tag_name(tag_or_attr: str) -> str:
    """XMLの名前空間URI `{http://...}LocalName` または `prefix:LocalName` からローカル名を取り出す"""
    if "}" in tag_or_attr:
        return tag_or_attr.split("}", 1)[1]
    if ":" in tag_or_attr:
        return tag_or_attr.split(":", 1)[1]
    return tag_or_attr


def _extract_xmp_scalar(root: Optional[ET.Element], raw_xml: str, names: List[str]) -> Optional[str]:
    """
    XMLツリーおよび正規表現フォールバックから、指定されたタグ/属性名リスト（例: ["aux:Lens", "exifEX:LensModel"]）の
    スカラー文字列値を取得する。
    """
    local_targets = {_local_tag_name(n): n for n in names}

    if root is not None:
        # 1. 各要素の属性を探索
        for elem in root.iter():
            for attr_k, attr_v in elem.attrib.items():
                lname = _local_tag_name(attr_k)
                if lname in local_targets and attr_v is not None and str(attr_v).strip() != "":
                    return str(attr_v).strip()
        # 2. 要素テキストを探索
        for elem in root.iter():
            lname = _local_tag_name(elem.tag)
            if lname in local_targets:
                if elem.text and elem.text.strip():
                    return elem.text.strip()
                # <rdf:Alt><rdf:li>...</rdf:li></rdf:Alt> のようなネスト要素がある場合
                for child in elem.iter():
                    if _local_tag_name(child.tag) == "li" and child.text and child.text.strip():
                        return child.text.strip()

    # 3. 正規表現フォールバック
    for name in names:
        esc_name = re.escape(name)
        m_attr = re.search(rf'{esc_name}\s*=\s*["\']([^"\']+)["\']', raw_xml)
        if m_attr and m_attr.group(1).strip():
            return html.unescape(m_attr.group(1).strip())
        m_elem = re.search(rf'<{esc_name}[^>]*>\s*([^<]+?)\s*</{esc_name}>', raw_xml)
        if m_elem and m_elem.group(1).strip():
            return html.unescape(m_elem.group(1).strip())

    return None


def _extract_xmp_list_items(root: Optional[ET.Element], raw_xml: str, prop_name: str) -> List[str]:
    """
    <dc:subject><rdf:Bag><rdf:li>Tag1</rdf:li>...</rdf:Bag></dc:subject> や
    属性形式 prop_name="Tag1,Tag2" から文字列リストを抽出する。
    """
    target_local = _local_tag_name(prop_name)
    items: List[str] = []

    if root is not None:
        for elem in root.iter():
            # 属性にある場合
            for attr_k, attr_v in elem.attrib.items():
                if _local_tag_name(attr_k) == target_local and attr_v and attr_v.strip():
                    for part in attr_v.split(","):
                        if part.strip():
                            items.append(part.strip())
            # 要素にある場合
            if _local_tag_name(elem.tag) == target_local:
                li_found = False
                for child in elem.iter():
                    if _local_tag_name(child.tag) == "li" and child.text and child.text.strip():
                        items.append(child.text.strip())
                        li_found = True
                if not li_found and elem.text and elem.text.strip():
                    for part in elem.text.split(","):
                        if part.strip():
                            items.append(part.strip())

    if not items:
        esc_prop = re.escape(prop_name)
        for m_block in re.finditer(rf'<{esc_prop}[^>]*>(.*?)</{esc_prop}>', raw_xml, re.DOTALL):
            block = m_block.group(1)
            li_matches = re.findall(r'<(?:\w+:)?li[^>]*>(.*?)</(?:\w+:)?li>', block, re.DOTALL)
            if li_matches:
                for lm in li_matches:
                    cleaned = html.unescape(lm).strip()
                    if cleaned:
                        items.append(cleaned)
            else:
                cleaned = html.unescape(re.sub(r"<[^>]+>", "", block)).strip()
                if cleaned:
                    for part in cleaned.split(","):
                        if part.strip():
                            items.append(part.strip())

        if not items:
            m_attr = re.search(rf'{esc_prop}\s*=\s*["\']([^"\']+)["\']', raw_xml)
            if m_attr and m_attr.group(1).strip():
                for part in html.unescape(m_attr.group(1)).split(","):
                    if part.strip():
                        items.append(part.strip())

    return items


def _normalize_tag_to_xmp_root(raw_tag: str) -> Optional[str]:
    """
    タグ文字列の区切り（| や \\）を / に正規化し、先頭に必ず 'XMP/' を付与する。
    既に 'XMP/' で始まっている場合は二重付与しない。
    """
    if not raw_tag:
        return None
    s = str(raw_tag).replace("|", "/").replace("\\", "/").strip()
    segments = [seg.strip() for seg in s.split("/") if seg.strip()]
    if not segments:
        return None
    if segments[0].upper() == "XMP":
        segments = segments[1:]
    if not segments:
        return None
    return "XMP/" + "/".join(segments)


def _find_best_xmp_for_photo(
    file_path: Union[str, Path],
    paired_raw_path: Optional[str] = None,
) -> Optional[Path]:
    """対象ファイル（またはそのペアRAW）に付随する .xmp サイドカーファイルを探索する"""
    candidates: List[Dict[str, Any]] = []
    if file_path:
        for sc in find_sidecars_for_file(file_path):
            if sc["ext"].lower() == ".xmp":
                candidates.append(sc)

    if not candidates and paired_raw_path:
        try:
            from .scanner import resolve_portable_path
            p_cand, is_online = resolve_portable_path(paired_raw_path)
            target_pair = p_cand if is_online else Path(paired_raw_path)
        except Exception:
            target_pair = Path(paired_raw_path)

        for sc in find_sidecars_for_file(target_pair):
            if sc["ext"].lower() == ".xmp":
                candidates.append(sc)

    if not candidates:
        return None

    # fullパターン（DSC0001.ARW.xmp）があれば優先し、なければ stemパターン（DSC0001.xmp）
    full_matches = [c["path"] for c in candidates if c["pattern"] == "full"]
    if full_matches:
        return full_matches[0]
    return candidates[0]["path"]


def parse_xmp_for_photo(
    file_path: Union[str, Path],
    paired_raw_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    写真ファイル（およびペアRAWパス）に付随する .xmp ファイルを解析し、
    機材情報・評価（4段階変換）・タグ（XMP/ルート配下）・非破壊調整パラメータを抽出して返す。
    """
    result = _empty_xmp_info()
    xmp_path = _find_best_xmp_for_photo(file_path, paired_raw_path)
    if not xmp_path or not xmp_path.exists():
        return result

    raw_xml: Optional[str] = None
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            with open(xmp_path, "r", encoding=enc) as f:
                raw_xml = f.read()
            break
        except Exception as e:
            logger.debug(f"XMPデコード試行失敗 ({enc}, {xmp_path}): {e}")
            continue

    if not raw_xml:
        return result

    result["has_xmp"] = True
    result["xmp_path"] = str(xmp_path)
    result["xmp_name"] = xmp_path.name

    # XMLツリー構築（xpacket ヘッダ等が含まれていても ElementTree で解析可能）
    root: Optional[ET.Element] = None
    try:
        root = ET.fromstring(raw_xml)
    except Exception as e:
        logger.debug(f"ElementTree直接パース失敗、xmpmeta抽出または正規表現フォールバックを使用 ({xmp_path.name}): {e}")
        m_meta = re.search(r"(<(?:\w+:)?xmpmeta\b.*?</(?:\w+:)?xmpmeta>)", raw_xml, re.DOTALL)
        if m_meta:
            try:
                root = ET.fromstring(m_meta.group(1))
            except Exception as e2:
                logger.debug(f"xmpmeta部分パーススキップ ({xmp_path.name}): {e2}")

    # 1. Hardware 情報の抽出
    hardware: Dict[str, Any] = {}
    lens_val = _extract_xmp_scalar(root, raw_xml, ["aux:Lens", "exifEX:LensModel"])
    if lens_val:
        hardware["lens_model"] = lens_val

    cam_val = _extract_xmp_scalar(root, raw_xml, ["tiff:Model"])
    if cam_val:
        hardware["camera_model"] = cam_val

    dt_raw = _extract_xmp_scalar(
        root,
        raw_xml,
        ["exif:DateTimeOriginal", "photoshop:DateCreated", "xmp:CreateDate"],
    )
    dt_norm = _normalize_xmp_datetime(dt_raw)
    if dt_norm:
        hardware["date_taken"] = dt_norm

    lat_raw = _extract_xmp_scalar(root, raw_xml, ["exif:GPSLatitude"])
    lon_raw = _extract_xmp_scalar(root, raw_xml, ["exif:GPSLongitude"])
    lat_ref = _extract_xmp_scalar(root, raw_xml, ["exif:GPSLatitudeRef"])
    lon_ref = _extract_xmp_scalar(root, raw_xml, ["exif:GPSLongitudeRef"])
    lat_val = _parse_xmp_gps_coord(lat_raw, lat_ref)
    lon_val = _parse_xmp_gps_coord(lon_raw, lon_ref)
    if lat_val is not None and lon_val is not None:
        if not (abs(lat_val) < 0.0001 and abs(lon_val) < 0.0001):
            hardware["latitude"] = lat_val
            hardware["longitude"] = lon_val

    result["hardware"] = hardware

    # 2. Rating（評価）の抽出と4段階マッピング
    pm_rating_raw = _extract_xmp_scalar(root, raw_xml, ["pm:rating"])
    xmp_rating_raw = _extract_xmp_scalar(root, raw_xml, ["xmp:Rating"])

    pm_rating: Optional[int] = None
    if pm_rating_raw is not None:
        try:
            cand_pm = int(round(float(pm_rating_raw)))
            if cand_pm in (-1, 0, 1, 2):
                pm_rating = cand_pm
        except Exception as e:
            logger.debug(f"pm:rating 変換スキップ ({pm_rating_raw}): {e}")

    raw_xmp_rating: Optional[int] = None
    if xmp_rating_raw is not None:
        try:
            cand_xmp = int(round(float(xmp_rating_raw)))
            raw_xmp_rating = max(-1, min(5, cand_xmp))
        except Exception as e:
            logger.debug(f"xmp:Rating 変換スキップ ({xmp_rating_raw}): {e}")

    mapped_rating: Optional[int] = None
    if pm_rating in (-1, 0, 1, 2):
        mapped_rating = pm_rating
    elif raw_xmp_rating is not None:
        if raw_xmp_rating <= -1:
            mapped_rating = -1
        elif raw_xmp_rating in (0, 1, 2):
            mapped_rating = 0
        elif raw_xmp_rating == 3:
            mapped_rating = 1
        else:  # 4, 5
            mapped_rating = 2

    result["rating"] = {
        "has_rating": bool(pm_rating is not None or raw_xmp_rating is not None),
        "raw_xmp_rating": raw_xmp_rating,
        "pm_rating": pm_rating,
        "mapped_rating": mapped_rating,
    }

    # 3. Tags（すべて XMP/ ルート配下に正規化し、階層タグとフラットタグの冗長重複を整理）
    pm_tags_raw = _extract_xmp_list_items(root, raw_xml, "pm:tags")
    lr_hier_raw = _extract_xmp_list_items(root, raw_xml, "lr:hierarchicalSubject")
    dc_subj_raw = _extract_xmp_list_items(root, raw_xml, "dc:subject")

    hier_normalized: List[str] = []
    for raw_t in pm_tags_raw + lr_hier_raw:
        norm_t = _normalize_tag_to_xmp_root(raw_t)
        if norm_t and norm_t not in hier_normalized:
            hier_normalized.append(norm_t)

    # 階層タグ（2階層以上、すなわち XMP/親/子 以上）に含まれる単体セグメントや親パスを収集
    redundant_flat_segments: set = set()
    for ht in hier_normalized:
        rel = ht[4:] if ht.startswith("XMP/") else ht
        parts = [p for p in rel.split("/") if p]
        if len(parts) >= 2:
            for p_seg in parts:
                redundant_flat_segments.add(p_seg.lower())
        elif len(parts) == 1:
            redundant_flat_segments.add(parts[0].lower())

    final_tags: List[str] = list(hier_normalized)
    for raw_flat in dc_subj_raw:
        norm_f = _normalize_tag_to_xmp_root(raw_flat)
        if not norm_f or norm_f in final_tags:
            continue
        rel_f = norm_f[4:] if norm_f.startswith("XMP/") else norm_f
        if "/" not in rel_f and rel_f.lower() in redundant_flat_segments:
            continue
        final_tags.append(norm_f)

    result["tags"] = final_tags

    # 4. Adjustments（ビットマップ調整データの抽出）
    # (a) 90度単位回転
    rotation = 0
    pm_rot_raw = _extract_xmp_scalar(root, raw_xml, ["pm:rotation"])
    if pm_rot_raw is not None:
        try:
            rot_int = (int(round(float(pm_rot_raw))) % 360 + 360) % 360
            if rot_int in (0, 90, 180, 270):
                rotation = rot_int
        except Exception as e:
            logger.debug(f"pm:rotation パーススキップ ({pm_rot_raw}): {e}")
    else:
        orient_raw = _extract_xmp_scalar(root, raw_xml, ["tiff:Orientation"])
        if orient_raw is not None:
            orient_map = {"6": 90, "3": 180, "8": 270}
            rotation = orient_map.get(str(orient_raw).strip(), 0)

    # (b) 水平傾き補正 (fine_angle)
    fine_angle = 0.0
    pm_fa_raw = _extract_xmp_scalar(root, raw_xml, ["pm:fine_angle"])
    crs_angle_raw = _extract_xmp_scalar(root, raw_xml, ["crs:CropAngle"])
    fa_src = pm_fa_raw if pm_fa_raw is not None else crs_angle_raw
    if fa_src is not None:
        try:
            fine_angle = max(-45.0, min(45.0, round(float(fa_src), 2)))
        except Exception as e:
            logger.debug(f"fine_angle パーススキップ ({fa_src}): {e}")

    # (c) クロップ範囲 (crop_x, crop_y, crop_w, crop_h)
    crop_x: Optional[float] = None
    crop_y: Optional[float] = None
    crop_w: Optional[float] = None
    crop_h: Optional[float] = None
    crop_aspect = _extract_xmp_scalar(root, raw_xml, ["pm:crop_aspect"])
    has_crop = False

    pm_cw_raw = _extract_xmp_scalar(root, raw_xml, ["pm:crop_w"])
    pm_ch_raw = _extract_xmp_scalar(root, raw_xml, ["pm:crop_h"])
    if pm_cw_raw is not None and pm_ch_raw is not None:
        try:
            pm_cx_raw = _extract_xmp_scalar(root, raw_xml, ["pm:crop_x"])
            pm_cy_raw = _extract_xmp_scalar(root, raw_xml, ["pm:crop_y"])
            cx_v = max(0.0, min(1.0, float(pm_cx_raw or 0.0)))
            cy_v = max(0.0, min(1.0, float(pm_cy_raw or 0.0)))
            cw_v = max(0.01, min(1.0 - cx_v, float(pm_cw_raw)))
            ch_v = max(0.01, min(1.0 - cy_v, float(pm_ch_raw)))
            if cw_v < 0.999 or ch_v < 0.999 or cx_v > 0.001 or cy_v > 0.001:
                has_crop = True
                crop_x, crop_y, crop_w, crop_h = round(cx_v, 5), round(cy_v, 5), round(cw_v, 5), round(ch_v, 5)
        except Exception as e:
            logger.debug(f"pm:crop_* パーススキップ: {e}")
    else:
        crs_left = _extract_xmp_scalar(root, raw_xml, ["crs:CropLeft"])
        crs_top = _extract_xmp_scalar(root, raw_xml, ["crs:CropTop"])
        crs_right = _extract_xmp_scalar(root, raw_xml, ["crs:CropRight"])
        crs_bottom = _extract_xmp_scalar(root, raw_xml, ["crs:CropBottom"])
        crs_has_crop = _extract_xmp_scalar(root, raw_xml, ["crs:HasCrop"])
        if (
            crs_left is not None
            and crs_top is not None
            and crs_right is not None
            and crs_bottom is not None
            and str(crs_has_crop or "True").strip().lower() != "false"
        ):
            try:
                left_v = max(0.0, min(1.0, float(crs_left)))
                top_v = max(0.0, min(1.0, float(crs_top)))
                right_v = max(0.0, min(1.0, float(crs_right)))
                bottom_v = max(0.0, min(1.0, float(crs_bottom)))
                if right_v > left_v + 0.01 and bottom_v > top_v + 0.01:
                    cw_v = right_v - left_v
                    ch_v = bottom_v - top_v
                    if cw_v < 0.999 or ch_v < 0.999 or left_v > 0.001 or top_v > 0.001:
                        has_crop = True
                        crop_x = round(left_v, 5)
                        crop_y = round(top_v, 5)
                        crop_w = round(cw_v, 5)
                        crop_h = round(ch_v, 5)
            except Exception as e:
                logger.debug(f"crs:Crop* パーススキップ: {e}")

    # (d) 明るさ / 露出補正 (brightness: -20 〜 +20 = EV×10)
    brightness = 0
    pm_b_raw = _extract_xmp_scalar(root, raw_xml, ["pm:brightness"])
    if pm_b_raw is not None:
        try:
            brightness = max(-20, min(20, int(round(float(pm_b_raw)))))
        except Exception as e:
            logger.debug(f"pm:brightness パーススキップ ({pm_b_raw}): {e}")
    else:
        crs_exp_raw = _extract_xmp_scalar(root, raw_xml, ["crs:Exposure2012", "crs:Exposure"])
        if crs_exp_raw is not None:
            try:
                brightness = max(-20, min(20, int(round(float(crs_exp_raw) * 10.0))))
            except Exception as e:
                logger.debug(f"crs:Exposure パーススキップ ({crs_exp_raw}): {e}")

    # (e) コントラスト (contrast: -100 〜 +100)
    contrast = 0
    pm_c_raw = _extract_xmp_scalar(root, raw_xml, ["pm:contrast"])
    if pm_c_raw is not None:
        try:
            contrast = max(-100, min(100, int(round(float(pm_c_raw)))))
        except Exception as e:
            logger.debug(f"pm:contrast パーススキップ ({pm_c_raw}): {e}")
    else:
        crs_cnt_raw = _extract_xmp_scalar(root, raw_xml, ["crs:Contrast2012", "crs:Contrast"])
        if crs_cnt_raw is not None:
            try:
                contrast = max(-100, min(100, int(round(float(crs_cnt_raw)))))
            except Exception as e:
                logger.debug(f"crs:Contrast パーススキップ ({crs_cnt_raw}): {e}")

    # (f) 彩度 (saturation: -100 〜 +100)
    saturation = 0
    pm_s_raw = _extract_xmp_scalar(root, raw_xml, ["pm:saturation"])
    if pm_s_raw is not None:
        try:
            saturation = max(-100, min(100, int(round(float(pm_s_raw)))))
        except Exception as e:
            logger.debug(f"pm:saturation パーススキップ ({pm_s_raw}): {e}")
    else:
        crs_gray = _extract_xmp_scalar(root, raw_xml, ["crs:ConvertToGrayscale"])
        if crs_gray and str(crs_gray).strip().lower() == "true":
            saturation = -100
        else:
            crs_sat_raw = _extract_xmp_scalar(root, raw_xml, ["crs:Saturation"])
            if crs_sat_raw is not None:
                try:
                    saturation = max(-100, min(100, int(round(float(crs_sat_raw)))))
                except Exception as e:
                    logger.debug(f"crs:Saturation パーススキップ ({crs_sat_raw}): {e}")

    has_adjustments = bool(
        rotation != 0
        or abs(fine_angle) > 0.01
        or has_crop
        or brightness != 0
        or contrast != 0
        or saturation != 0
    )

    summary: List[str] = []
    if rotation != 0:
        summary.append(f"回転 {rotation}°")
    if abs(fine_angle) > 0.01:
        summary.append(f"傾き {fine_angle:+.1f}°")
    if has_crop:
        summary.append("クロップ")
    if brightness != 0:
        summary.append(f"露出 {brightness / 10.0:+.1f}EV")
    if contrast != 0:
        summary.append(f"コントラスト {contrast:+d}")
    if saturation != 0:
        summary.append(f"彩度 {saturation:+d}")

    result["adjustments"] = {
        "has_adjustments": has_adjustments,
        "rotation": rotation,
        "fine_angle": fine_angle,
        "has_crop": has_crop,
        "crop_x": crop_x if has_crop else None,
        "crop_y": crop_y if has_crop else None,
        "crop_w": crop_w if has_crop else None,
        "crop_h": crop_h if has_crop else None,
        "crop_aspect": crop_aspect,
        "brightness": brightness,
        "contrast": contrast,
        "saturation": saturation,
        "summary": summary,
    }

    return result


# ==============================================================================
# XMP サイドカー書き出し
# ==============================================================================

def _decimal_to_xmp_gps_str(dec: float, is_lat: bool) -> str:
    """10進数の緯度・経度を XMP 標準の DD,MM.MMMMMM[N/S/E/W] 形式に変換する"""
    val = float(dec)
    ref = ("N" if val >= 0 else "S") if is_lat else ("E" if val >= 0 else "W")
    abs_val = abs(val)
    deg = int(abs_val)
    minutes = (abs_val - deg) * 60.0
    return f"{deg},{minutes:.6f}{ref}"


def write_xmp_sidecar_for_photo(
    photo: Dict[str, Any],
    target_image_path: Union[str, Path],
    remove_gps: bool = False,
) -> Optional[Path]:
    """
    エクスポート先の画像 target_image_path に対して、同じフォルダに <target_image_path.stem>.xmp を生成する。
    Photo Manager で設定した評価・タグ・非破壊調整値・GPS座標を Adobe / 標準 XMP 互換および pm:* 名前空間で書き出す。
    """
    if not photo or not target_image_path:
        return None

    target_p = Path(target_image_path)
    xmp_path = target_p.parent / f"{target_p.stem}.xmp"

    # 1. 評価値
    rating = int(photo.get("rating") or 0)
    xmp_rating = {-1: -1, 0: 0, 1: 3, 2: 5}.get(rating, 0)

    # 2. タグ一覧の取得とクリーン化（先頭の XMP/ を除去して出力）
    raw_tags: List[str] = []
    if isinstance(photo.get("tags"), list):
        for t in photo["tags"]:
            if isinstance(t, dict) and t.get("tag"):
                raw_tags.append(str(t["tag"]))
            elif isinstance(t, str) and t.strip():
                raw_tags.append(t.strip())
    elif photo.get("id"):
        try:
            from .database import get_photo_tags_details
            for td in get_photo_tags_details(int(photo["id"])):
                if td.get("tag"):
                    raw_tags.append(str(td["tag"]))
        except Exception as e:
            logger.debug(f"XMP出力時のタグ詳細取得スキップ (ID={photo.get('id')}): {e}")

    clean_tags: List[str] = []
    leaf_tags: List[str] = []
    hier_tags: List[str] = []

    for rt in raw_tags:
        s = str(rt).replace("\\", "/").strip().strip("/")
        if not s:
            continue
        parts = [p.strip() for p in s.split("/") if p.strip()]
        if parts and parts[0].upper() == "XMP":
            parts = parts[1:]
        if not parts:
            continue
        clean_rel = "/".join(parts)
        if clean_rel not in clean_tags:
            clean_tags.append(clean_rel)
        hier_str = "|".join(parts)
        if hier_str not in hier_tags:
            hier_tags.append(hier_str)
        leaf = parts[-1]
        if leaf not in leaf_tags:
            leaf_tags.append(leaf)

    # 3. 非破壊調整パラメータ
    rotation = ((int(photo.get("rotation") or 0)) % 360 + 360) % 360
    orient_val = {0: 1, 90: 6, 180: 3, 270: 8}.get(rotation, 1)
    fine_angle = float(photo.get("fine_angle") or 0.0)
    crop_x = photo.get("crop_x")
    crop_y = photo.get("crop_y")
    crop_w = photo.get("crop_w")
    crop_h = photo.get("crop_h")
    crop_aspect = str(photo.get("crop_aspect") or "")

    has_crop = False
    cx_f, cy_f, cw_f, ch_f = 0.0, 0.0, 1.0, 1.0
    if crop_w is not None and crop_h is not None:
        try:
            cx_f = max(0.0, min(1.0, float(crop_x or 0.0)))
            cy_f = max(0.0, min(1.0, float(crop_y or 0.0)))
            cw_f = max(0.01, min(1.0 - cx_f, float(crop_w)))
            ch_f = max(0.01, min(1.0 - cy_f, float(crop_h)))
            if cw_f < 0.999 or ch_f < 0.999 or cx_f > 0.001 or cy_f > 0.001:
                has_crop = True
        except Exception:
            has_crop = False

    brightness = int(photo.get("brightness") or 0)
    contrast = int(photo.get("contrast") or 0)
    saturation = int(photo.get("saturation") or 0)

    # 4. 属性リストの構築
    attrs: List[Tuple[str, str]] = [
        ("crs:RawFileName", target_p.name),
        ("xmp:Rating", str(xmp_rating)),
        ("pm:rating", str(rating)),
        ("tiff:Orientation", str(orient_val)),
        ("pm:rotation", str(rotation)),
        ("pm:fine_angle", f"{fine_angle:.2f}"),
        ("crs:CropAngle", f"{fine_angle:.2f}"),
        ("crs:HasCrop", "True" if has_crop else "False"),
        ("pm:brightness", str(brightness)),
        ("crs:Exposure2012", f"{brightness / 10.0:+.2f}"),
        ("pm:contrast", str(contrast)),
        ("crs:Contrast2012", f"{contrast:+d}" if contrast != 0 else "0"),
        ("pm:saturation", str(saturation)),
        ("crs:Saturation", f"{saturation:+d}" if saturation != 0 else "0"),
    ]

    if has_crop:
        attrs.extend([
            ("pm:crop_x", f"{cx_f:.5f}"),
            ("pm:crop_y", f"{cy_f:.5f}"),
            ("pm:crop_w", f"{cw_f:.5f}"),
            ("pm:crop_h", f"{ch_f:.5f}"),
            ("crs:CropLeft", f"{cx_f:.5f}"),
            ("crs:CropTop", f"{cy_f:.5f}"),
            ("crs:CropRight", f"{min(1.0, cx_f + cw_f):.5f}"),
            ("crs:CropBottom", f"{min(1.0, cy_f + ch_f):.5f}"),
        ])
        if crop_aspect:
            attrs.append(("pm:crop_aspect", crop_aspect))

    if clean_tags:
        attrs.append(("pm:tags", ",".join(clean_tags)))

    # 機材・撮影日時
    cam_model = photo.get("camera_model")
    if cam_model and str(cam_model) not in ("不明", "RAW写真"):
        attrs.append(("tiff:Model", str(cam_model)))
    lens_model = photo.get("lens_model")
    if lens_model and str(lens_model) != "不明":
        attrs.append(("aux:Lens", str(lens_model)))
        attrs.append(("exifEX:LensModel", str(lens_model)))
    date_taken = photo.get("date_taken")
    if date_taken:
        iso_dt = str(date_taken).strip().replace(" ", "T")
        attrs.append(("exif:DateTimeOriginal", iso_dt))

    # GPS・ロケーション
    if not remove_gps:
        lat = photo.get("latitude")
        lon = photo.get("longitude")
        if lat is not None and lon is not None:
            try:
                attrs.append(("exif:GPSLatitude", _decimal_to_xmp_gps_str(float(lat), is_lat=True)))
                attrs.append(("exif:GPSLongitude", _decimal_to_xmp_gps_str(float(lon), is_lat=False)))
            except Exception as e:
                logger.debug(f"XMP GPS変換スキップ: {e}")
        country = photo.get("country") or photo.get("location_country")
        state = photo.get("state") or photo.get("location_state")
        city = photo.get("city") or photo.get("location_city")
        if country:
            attrs.append(("photoshop:Country", str(country)))
        if state:
            attrs.append(("photoshop:State", str(state)))
        if city:
            attrs.append(("photoshop:City", str(city)))

    attr_lines = "\n".join(
        f'   {k}="{html.escape(str(v), quote=True)}"' for k, v in attrs
    )

    child_blocks: List[str] = []
    if leaf_tags:
        li_str = "\n".join(f"     <rdf:li>{html.escape(t)}</rdf:li>" for t in leaf_tags)
        child_blocks.append(
            f"   <dc:subject>\n    <rdf:Bag>\n{li_str}\n    </rdf:Bag>\n   </dc:subject>"
        )
    if hier_tags:
        li_str = "\n".join(f"     <rdf:li>{html.escape(t)}</rdf:li>" for t in hier_tags)
        child_blocks.append(
            f"   <lr:hierarchicalSubject>\n    <rdf:Bag>\n{li_str}\n    </rdf:Bag>\n   </lr:hierarchicalSubject>"
        )

    children_xml = ("\n" + "\n".join(child_blocks) + "\n  ") if child_blocks else ""

    xmp_content = f"""<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Photo Manager XMP Core">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:lr="http://ns.adobe.com/lightroom/1.0/"
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmlns:exif="http://ns.adobe.com/exif/1.0/"
   xmlns:exifEX="http://cipa.jp/exif/1.0/"
   xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
   xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   xmlns:pm="http://photomanager.local/ns/1.0/"
{attr_lines}>{children_xml}</rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"""

    try:
        with open(xmp_path, "w", encoding="utf-8") as f:
            f.write(xmp_content)
        return xmp_path
    except Exception as e:
        logger.warning(f"XMPサイドカー書き出し失敗 ({xmp_path}): {e}")
        return None
