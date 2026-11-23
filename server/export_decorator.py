"""
Art Framer / スマート・テイクアウト装飾エンジン (プリント枠・EXIFキャプション・ウォーターマーク・外寸逆算)
同梱 Inter 可変フォントと Windows 標準日本語フォントのハイブリッド描画により、追加パッケージ不要で動作する。
"""

import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BUNDLED_INTER_FONT = PROJECT_ROOT / "frontend" / "vendor" / "fonts" / "inter-latin.woff2"

# 台紙カラーパレット定義
MATTE_PALETTES: Dict[str, Dict[str, Any]] = {
    "white": {
        "bg": (255, 255, 255),
        "text_main": (26, 26, 26),
        "text_sub": (107, 114, 128),
        "divider": (209, 213, 219),
        "inner_border": (0, 0, 0, 26),
        "shadow_rgba": (0, 0, 0, 44),
    },
    "paper": {
        "bg": (246, 244, 238),
        "text_main": (42, 41, 38),
        "text_sub": (110, 106, 97),
        "divider": (207, 203, 192),
        "inner_border": (42, 41, 38, 34),
        "shadow_rgba": (30, 28, 24, 46),
    },
    "sumi": {
        "bg": (21, 22, 25),
        "text_main": (236, 234, 228),
        "text_sub": (142, 149, 162),
        "divider": (52, 56, 66),
        "inner_border": (255, 255, 255, 36),
        "shadow_rgba": (0, 0, 0, 160),
    },
}

# 日本語文字判定用正規表現 (ひらがな・カタカナ・漢字・全角記号)
_NON_LATIN_RE = re.compile(r"[^\x00-\x024F\u1E00-\u1EFF\u2000-\u206F\u00A0-\u00FF]")


def _find_japanese_fallback_font(bold: bool = False) -> Optional[Path]:
    """Windows 標準の日本語サンセリフフォントを優先順で探索する"""
    win_fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = (
        ["YuGothB.ttc", "meiryob.ttc", "YuGothM.ttc", "meiryo.ttc", "msgothic.ttc"]
        if bold
        else ["YuGothM.ttc", "YuGothR.ttc", "meiryo.ttc", "segoeui.ttf", "msgothic.ttc"]
    )
    for name in candidates:
        p = win_fonts / name
        if p.is_file():
            return p
    return None


def _load_smart_font(text: str, size_px: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    """
    テキストがラテン文字のみなら同梱の Inter 可変フォントを指定ウェイトでロードし、
    日本語等を含む場合は OS 標準日本語フォントへ自動フォールバックする。
    """
    size_px = max(10, int(size_px))
    needs_cjk = bool(_NON_LATIN_RE.search(text or ""))

    if not needs_cjk and BUNDLED_INTER_FONT.is_file():
        try:
            font = ImageFont.truetype(str(BUNDLED_INTER_FONT), size_px)
            if hasattr(font, "set_variation_by_axes"):
                try:
                    font.set_variation_by_axes([max(100, min(900, int(weight)))])
                except Exception as var_err:
                    logger.debug(f"Inter可変ウェイト設定スキップ: {var_err}")
            return font
        except Exception as e:
            logger.debug(f"同梱Interフォント読込スキップ: {e}")

    jp_font_path = _find_japanese_fallback_font(bold=(weight >= 600))
    if jp_font_path is not None:
        try:
            return ImageFont.truetype(str(jp_font_path), size_px, index=0)
        except Exception as e:
            logger.debug(f"日本語フォント読込スキップ ({jp_font_path}): {e}")

    if BUNDLED_INTER_FONT.is_file():
        try:
            return ImageFont.truetype(str(BUNDLED_INTER_FONT), size_px)
        except Exception as e:
            logger.debug(f"Interフォールバック読込失敗: {e}")

    return ImageFont.load_default()


def _fit_font_to_width(
    draw: ImageDraw.ImageDraw, text: str, initial_px: int, max_width: int, weight: int = 400, min_px: int = 11
) -> ImageFont.FreeTypeFont:
    """長いレンズ名やキャプションが台紙余白からはみ出ないよう、必要に応じてフォントサイズを自動縮小する"""
    cur_px = max(min_px, int(initial_px))
    font = _load_smart_font(text, cur_px, weight=weight)
    if max_width <= 0 or not text:
        return font

    while cur_px > min_px:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        if tw <= max_width:
            break
        cur_px = max(min_px, int(cur_px * 0.90) - 1)
        font = _load_smart_font(text, cur_px, weight=weight)
    return font


def compute_frame_geometry(
    photo_w: int,
    photo_h: int,
    frame_cfg: Optional[Dict[str, Any]],
) -> Dict[str, int]:
    """
    内側写真サイズ (photo_w, photo_h) とフレーム設定から、
    最終出力キャンバスサイズ (canvas_w, canvas_h) および写真配置位置 (photo_x, photo_y, bottom_space) を算出する。
    """
    if not frame_cfg or not frame_cfg.get("enabled"):
        return {
            "canvas_w": photo_w,
            "canvas_h": photo_h,
            "photo_x": 0,
            "photo_y": 0,
            "bottom_space": 0,
            "pad": 0,
        }

    layout = str(frame_cfg.get("layout") or "classic").lower()
    aspect_mode = str(frame_cfg.get("aspect_mode") or "original").strip()
    border_ratio = float(frame_cfg.get("border_ratio") or 0.05)
    border_ratio = max(0.015, min(0.18, border_ratio))

    photo_long = max(photo_w, photo_h)
    pad = max(8, int(round(photo_long * border_ratio)))

    if layout in ("classic", "editorial"):
        extra_bottom = int(round(pad * 2.35))
    elif layout == "polaroid":
        extra_bottom = int(round(pad * 3.75))
    else:
        extra_bottom = pad

    if aspect_mode in ("1:1", "4:5", "16:9", "3:4"):
        aw_str, ah_str = aspect_mode.split(":")
        target_ratio = float(aw_str) / float(ah_str)
        min_w = photo_w + pad * 2
        min_h = photo_h + pad + extra_bottom
        if (min_w / max(1.0, float(min_h))) > target_ratio:
            canvas_w = min_w
            canvas_h = max(min_h, int(round(min_w / target_ratio)))
        else:
            canvas_h = min_h
            canvas_w = max(min_w, int(round(min_h * target_ratio)))

        photo_x = int(round((canvas_w - photo_w) / 2.0))
        avail_vert = canvas_h - photo_h
        if layout == "border_only":
            photo_y = int(round(avail_vert / 2.0))
        else:
            photo_y = max(pad, int(round((avail_vert - (extra_bottom - pad)) / 2.0)))
        bottom_space = max(0, canvas_h - (photo_y + photo_h))
    else:
        canvas_w = photo_w + pad * 2
        canvas_h = photo_h + pad + extra_bottom
        photo_x = pad
        photo_y = pad
        bottom_space = extra_bottom

    return {
        "canvas_w": canvas_w,
        "canvas_h": canvas_h,
        "photo_x": photo_x,
        "photo_y": photo_y,
        "bottom_space": bottom_space,
        "pad": pad,
    }


def resize_photo_for_target_output(
    img: Image.Image,
    opts: Dict[str, Any],
    frame_cfg: Optional[Dict[str, Any]] = None,
) -> Tuple[Image.Image, Optional[Tuple[int, int]]]:
    """
    ターゲットプリセット (for_x / for_insta / full_size) または既存の resize_mode に基づき、
    フレームを含めた最終外寸が指定解像度と厳密に一致するよう内側写真サイズを逆算して LANCZOS リサイズする。
    戻り値: (リサイズ後の写真Image, 固定最終キャンバス寸法またはNone)
    """
    cur_w, cur_h = img.size
    art_preset = str(opts.get("art_preset") or "").lower().strip()
    frame_on = bool(frame_cfg and frame_cfg.get("enabled"))
    aspect_mode = str((frame_cfg or {}).get("aspect_mode") or "original").strip()

    # 1. Instagram 専用プリセット: 1080x1350 (4:5) または 1080x1080 (1:1) ピッタリに収める
    if art_preset == "for_insta":
        target_canvas_w = 1080
        target_canvas_h = 1080 if aspect_mode == "1:1" else 1350
        if not frame_on:
            # 枠なし時は長辺 1350px 以内に縮小
            scale = min(1.0, 1350.0 / max(cur_w, cur_h))
            if scale < 0.999:
                img = img.resize(
                    (max(1, round(cur_w * scale)), max(1, round(cur_h * scale))),
                    Image.Resampling.LANCZOS,
                )
            return img, None

        # 台紙サイズ (1080x1350 or 1080x1080) から余白を除いた内側写真ボックスへ内接リサイズ
        border_ratio = max(0.015, min(0.18, float((frame_cfg or {}).get("border_ratio") or 0.05)))
        layout = str((frame_cfg or {}).get("layout") or "classic").lower()
        pad_px = max(16, int(round(max(target_canvas_w, target_canvas_h) * border_ratio * 0.85)))
        if layout in ("classic", "editorial"):
            bot_px = int(round(pad_px * 2.35))
        elif layout == "polaroid":
            bot_px = int(round(pad_px * 3.6))
        else:
            bot_px = pad_px

        avail_w = max(64, target_canvas_w - pad_px * 2)
        avail_h = max(64, target_canvas_h - pad_px - bot_px)
        scale = min(avail_w / cur_w, avail_h / cur_h)
        new_w = max(1, int(round(cur_w * scale)))
        new_h = max(1, int(round(cur_h * scale)))
        if (new_w, new_h) != (cur_w, cur_h):
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        return img, (target_canvas_w, target_canvas_h)

    # 2. Full Size プリセット: リサイズなし (原本解像度のまま外側に枠を拡張)
    if art_preset == "full_size":
        return img, None

    # 3. for_x (長辺2048px) または通常の resize_mode 長辺上限
    target_long_edge: Optional[int] = None
    if art_preset == "for_x":
        target_long_edge = int(opts.get("custom_long_edge") or 2048) if opts.get("resize_mode") == "custom" else 2048
    else:
        resize_mode = str(opts.get("resize_mode") or "original")
        if resize_mode in ("3840", "2048", "1920", "1280"):
            target_long_edge = int(resize_mode)
        elif resize_mode == "custom":
            try:
                target_long_edge = int(opts.get("custom_long_edge") or 0)
            except Exception:
                target_long_edge = None

    if not target_long_edge or target_long_edge <= 0:
        return img, None

    if not frame_on:
        cur_long = max(cur_w, cur_h)
        if cur_long > target_long_edge:
            scale = target_long_edge / float(cur_long)
            img = img.resize(
                (max(1, round(cur_w * scale)), max(1, round(cur_h * scale))),
                Image.Resampling.LANCZOS,
            )
        return img, None

    # プリント枠込みの最終外寸長辺が target_long_edge を1pxも超えないよう比例逆算＋丸め補正
    unit_geom = compute_frame_geometry(cur_w, cur_h, frame_cfg)
    unit_outer_long = max(unit_geom["canvas_w"], unit_geom["canvas_h"])
    if unit_outer_long > target_long_edge:
        ratio = target_long_edge / float(unit_outer_long)
        new_w = max(1, int(round(cur_w * ratio)))
        new_h = max(1, int(round(cur_h * ratio)))
        for _ in range(4):
            chk_geom = compute_frame_geometry(new_w, new_h, frame_cfg)
            if max(chk_geom["canvas_w"], chk_geom["canvas_h"]) <= target_long_edge:
                break
            if new_w >= new_h and new_w > 2:
                new_w -= 1
                new_h = max(1, int(round(cur_h * (new_w / float(cur_w)))))
            elif new_h > 2:
                new_h -= 1
                new_w = max(1, int(round(cur_w * (new_h / float(cur_h)))))
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

    return img, None


def apply_watermark_pil(img: Image.Image, wm_cfg: Optional[Dict[str, Any]]) -> Image.Image:
    """
    写真領域に対してテキスト透かしまたは透過PNG/WebPロゴ画像をアルファ合成する。
    """
    if not wm_cfg or not isinstance(wm_cfg, dict) or not wm_cfg.get("enabled"):
        return img

    w, h = img.size
    long_edge = max(w, h)
    opacity = float(wm_cfg.get("opacity") if wm_cfg.get("opacity") is not None else 0.58)
    opacity = max(0.05, min(1.0, opacity))
    pos = str(wm_cfg.get("position") or "bottom-right").lower()
    margin = max(10, int(round(long_edge * float(wm_cfg.get("margin_ratio") or 0.024))))
    wm_type = str(wm_cfg.get("type") or "text").lower()

    base_rgba = img.convert("RGBA")
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    # A. 画像ロゴ透かし（library.db の asset_id 優先、互換用にローカル image_path も維持）
    asset_id = str(wm_cfg.get("asset_id") or "").strip()
    logo_path_str = str(wm_cfg.get("image_path") or "").strip()
    if wm_type == "image" and (asset_id or logo_path_str):
        try:
            logo: Optional[Image.Image] = None
            if asset_id:
                import io
                from .database.watermarks import get_watermark_asset_blob
                blob_info = get_watermark_asset_blob(asset_id)
                if blob_info and blob_info[0]:
                    logo = Image.open(io.BytesIO(blob_info[0])).convert("RGBA")
            if logo is None and logo_path_str:
                logo_path = Path(logo_path_str)
                if logo_path.is_file() and logo_path.suffix.lower() in (".png", ".webp", ".jpg", ".jpeg"):
                    logo = Image.open(logo_path).convert("RGBA")

            if logo is not None:
                scale_ratio = max(0.03, min(0.50, float(wm_cfg.get("size_ratio") or 0.16)))
                logo_long = max(1.0, float(max(logo.width, logo.height)))
                target_long = max(24.0, float(long_edge) * scale_ratio)
                sc = target_long / logo_long
                target_logo_w = max(12, int(round(logo.width * sc)))
                target_logo_h = max(12, int(round(logo.height * sc)))
                logo = logo.resize((target_logo_w, target_logo_h), Image.Resampling.LANCZOS)

                if opacity < 0.999:
                    r_ch, g_ch, b_ch, a_ch = logo.split()
                    a_ch = a_ch.point(lambda p: int(round(p * opacity)))
                    logo = Image.merge("RGBA", (r_ch, g_ch, b_ch, a_ch))

                lx, ly = _compute_anchor_xy(w, h, target_logo_w, target_logo_h, pos, margin)
                overlay.paste(logo, (lx, ly), logo)
                return Image.alpha_composite(base_rgba, overlay).convert("RGB")
        except Exception as e:
            logger.warning(f"画像ロゴ透かしの適用に失敗しました (asset_id={asset_id}, path={logo_path_str}): {e}")

    # B. テキスト透かし
    text = str(wm_cfg.get("text") or "").strip()
    if not text:
        return img

    size_ratio = max(0.008, min(0.08, float(wm_cfg.get("size_ratio") or 0.018)))
    font_px = max(13, int(round(long_edge * size_ratio)))
    font = _load_smart_font(text, font_px, weight=500)

    draw = ImageDraw.Draw(overlay)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx, ty = _compute_anchor_xy(w, h, tw, th, pos, margin)
    tx -= bbox[0]
    ty -= bbox[1]

    color_mode = str(wm_cfg.get("color") or "light").lower()
    alpha_int = int(round(255 * opacity))
    fg_rgba = (20, 22, 26, alpha_int) if color_mode == "dark" else (255, 255, 255, alpha_int)

    if wm_cfg.get("shadow", True):
        shadow_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        s_draw = ImageDraw.Draw(shadow_layer)
        s_alpha = int(round(alpha_int * 0.68))
        s_col = (255, 255, 255, s_alpha) if color_mode == "dark" else (0, 0, 0, s_alpha)
        s_off = max(1, int(round(font_px * 0.06)))
        s_draw.text((tx, ty + s_off), text, font=font, fill=s_col)
        blur_px = max(1.5, font_px * 0.14)
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=blur_px))
        overlay = Image.alpha_composite(overlay, shadow_layer)
        draw = ImageDraw.Draw(overlay)

    draw.text((tx, ty), text, font=font, fill=fg_rgba)
    return Image.alpha_composite(base_rgba, overlay).convert("RGB")


def _compute_anchor_xy(
    canvas_w: int, canvas_h: int, item_w: int, item_h: int, pos: str, margin: int
) -> Tuple[int, int]:
    """9方向アンカー名から左上描画座標 (x, y) を返す"""
    if pos == "top-left":
        return margin, margin
    if pos == "top-center":
        return max(0, (canvas_w - item_w) // 2), margin
    if pos == "top-right":
        return max(0, canvas_w - item_w - margin), margin
    if pos == "middle-left":
        return margin, max(0, (canvas_h - item_h) // 2)
    if pos == "center":
        return max(0, (canvas_w - item_w) // 2), max(0, (canvas_h - item_h) // 2)
    if pos == "middle-right":
        return max(0, canvas_w - item_w - margin), max(0, (canvas_h - item_h) // 2)
    if pos == "bottom-left":
        return margin, max(0, canvas_h - item_h - margin)
    if pos == "bottom-center":
        return max(0, (canvas_w - item_w) // 2), max(0, canvas_h - item_h - margin)
    # デフォルト: bottom-right
    return max(0, canvas_w - item_w - margin), max(0, canvas_h - item_h - margin)


def _extract_camera_display_name(photo: Dict[str, Any], orig_exif_bytes: Optional[bytes] = None) -> str:
    """元Exifの Make と DBの camera_model を重複なく自然に結合する"""
    model = str(photo.get("camera_model") or "").strip()
    if model in ("", "不明", "RAW写真"):
        model = ""

    make = ""
    if orig_exif_bytes:
        try:
            exif = Image.Exif()
            exif.load(orig_exif_bytes)
            raw_make = exif.get(0x010F)
            if raw_make:
                make = str(raw_make).replace("\x00", "").strip()
        except Exception as e:
            logger.debug(f"Exif Make抽出スキップ: {e}")

    if make and model:
        # 既に model 側にメーカー名が含まれている場合 (例: Canon EOS R6, NIKON Z 8, RICOH GR IIIx) は重複させない
        make_first = make.split()[0].upper()
        if make_first in model.upper():
            return model
        # CORPORATION / CO., LTD. などの冗長サフィックスを整理
        clean_make = re.sub(
            r"\s+(?:CORPORATION|CORP\.?|CO\.?,?\s*LTD\.?|INC\.?|OPTICAL)$",
            "",
            make,
            flags=re.IGNORECASE,
        ).strip()
        if clean_make.upper() in model.upper():
            return model
        return f"{clean_make} {model}"
    return model or make


def build_caption_parts(
    photo: Dict[str, Any], frame_cfg: Dict[str, Any], orig_exif_bytes: Optional[bytes] = None
) -> Dict[str, str]:
    """DB情報とフレーム表示設定からキャプションの各パーツ文字列を組み立てる"""
    camera_str = _extract_camera_display_name(photo, orig_exif_bytes) if frame_cfg.get("show_camera", True) else ""

    lens_str = ""
    if frame_cfg.get("show_lens", True):
        raw_lens = str(photo.get("lens_model") or "").strip()
        if raw_lens and raw_lens not in ("不明", "----"):
            lens_str = raw_lens

    exposure_str = ""
    if frame_cfg.get("show_exposure", True):
        exp_items: List[str] = []
        fl = photo.get("focal_length")
        if fl is not None:
            try:
                fl_f = float(fl)
                exp_items.append(f"{int(fl_f)}mm" if fl_f.is_integer() else f"{fl_f:.1f}mm")
            except (ValueError, TypeError):
                pass
        fn = photo.get("f_number")
        if fn is not None:
            try:
                fn_s = f"{float(fn):.1f}".rstrip("0").rstrip(".")
                exp_items.append(f"F{fn_s}")
            except (ValueError, TypeError):
                pass
        ss = photo.get("shutter_speed")
        if ss:
            s_clean = str(ss).strip()
            if not s_clean.endswith("s"):
                s_clean += "s"
            exp_items.append(s_clean)
        iso = photo.get("iso")
        if iso:
            exp_items.append(f"ISO{iso}")
        exposure_str = "  ".join(exp_items)

    extra_items: List[str] = []
    if frame_cfg.get("show_date", False):
        dt_raw = str(photo.get("date_taken") or "").strip()
        if len(dt_raw) >= 10:
            extra_items.append(dt_raw[:10].replace("-", ".").replace(":", "."))

    if frame_cfg.get("show_location", False):
        loc_parts = [
            str(photo.get(k) or "").strip()
            for k in ("city", "state", "country")
            if photo.get(k) and str(photo.get(k)).strip() not in ("不明", "Unknown")
        ]
        if loc_parts:
            # 市区町村＋都道府県 または 都道府県＋国 の最大2階層ですっきり表記
            extra_items.append(", ".join(loc_parts[:2]))

    if frame_cfg.get("show_note", False):
        note = str(frame_cfg.get("custom_note") or "").strip()
        if note:
            extra_items.append(note)

    return {
        "camera": camera_str,
        "lens": lens_str,
        "exposure": exposure_str,
        "extra": "  ·  ".join(extra_items),
    }


def apply_print_frame_pil(
    img: Image.Image,
    photo: Dict[str, Any],
    frame_cfg: Optional[Dict[str, Any]],
    orig_exif_bytes: Optional[bytes] = None,
    fixed_canvas_size: Optional[Tuple[int, int]] = None,
) -> Image.Image:
    """
    プリント風マット台紙・ドロップシャドウ・1px境界線・EXIFキャプションを描画した最終画像を返す。
    """
    if not frame_cfg or not isinstance(frame_cfg, dict) or not frame_cfg.get("enabled"):
        return img

    photo_rgb = img.convert("RGB")
    pw, ph = photo_rgb.size
    photo_long = max(pw, ph)

    matte_key = str(frame_cfg.get("matte") or "white").lower()
    palette = MATTE_PALETTES.get(matte_key, MATTE_PALETTES["white"])
    layout = str(frame_cfg.get("layout") or "classic").lower()

    if fixed_canvas_size is not None:
        canvas_w, canvas_h = fixed_canvas_size
        photo_x = max(0, (canvas_w - pw) // 2)
        avail_v = max(0, canvas_h - ph)
        if layout == "border_only":
            photo_y = avail_v // 2
        else:
            border_ratio = max(0.015, min(0.18, float(frame_cfg.get("border_ratio") or 0.05)))
            min_top = max(14, int(round(max(canvas_w, canvas_h) * border_ratio * 0.8)))
            extra_factor = 3.5 if layout == "polaroid" else 2.3
            photo_y = max(min_top, int(round((avail_v - min_top * (extra_factor - 1.0)) / 2.0)))
            if photo_y + ph > canvas_h - 16:
                photo_y = max(8, avail_v // 3)
        bottom_space = max(0, canvas_h - (photo_y + ph))
    else:
        geom = compute_frame_geometry(pw, ph, frame_cfg)
        canvas_w = geom["canvas_w"]
        canvas_h = geom["canvas_h"]
        photo_x = geom["photo_x"]
        photo_y = geom["photo_y"]
        bottom_space = geom["bottom_space"]

    canvas_rgba = Image.new("RGBA", (canvas_w, canvas_h), palette["bg"] + (255,))

    # 1. オプションのドロップシャドウ
    if frame_cfg.get("photo_shadow", False):
        shadow_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        s_draw = ImageDraw.Draw(shadow_layer)
        off_y = max(2, int(round(photo_long * 0.0045)))
        s_draw.rectangle(
            [photo_x, photo_y + off_y, photo_x + pw, photo_y + ph + off_y],
            fill=palette["shadow_rgba"],
        )
        blur_r = max(4.0, photo_long * 0.012)
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=blur_r))
        canvas_rgba = Image.alpha_composite(canvas_rgba, shadow_layer)

    # 2. 写真本体の貼り付け
    canvas_rgba.paste(photo_rgb, (photo_x, photo_y))

    # 3. ハイキー写真の輪郭溶けを防ぐ極細1px境界線
    if frame_cfg.get("inner_border", True):
        border_overlay = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        b_draw = ImageDraw.Draw(border_overlay)
        line_w = max(1, int(round(photo_long * 0.0009)))
        b_draw.rectangle(
            [photo_x, photo_y, photo_x + pw - 1, photo_y + ph - 1],
            outline=palette["inner_border"],
            width=line_w,
        )
        canvas_rgba = Image.alpha_composite(canvas_rgba, border_overlay)

    out_rgb = canvas_rgba.convert("RGB")
    if layout == "border_only" or bottom_space < 18:
        return out_rgb

    # 4. 下部 EXIF キャプション組版
    parts = build_caption_parts(photo, frame_cfg, orig_exif_bytes=orig_exif_bytes)
    draw = ImageDraw.Draw(out_rgb)
    base_ref = min(canvas_w, canvas_h)
    font_scale = max(0.65, min(1.5, float(frame_cfg.get("font_scale") or 1.0)))
    title_px = max(12, int(round(base_ref * 0.020 * font_scale)))
    sub_px = max(10, int(round(base_ref * 0.0145 * font_scale)))
    area_cy = photo_y + ph + int(round(bottom_space * 0.52))
    max_text_w = max(80, canvas_w - max(24, int(round(canvas_w * 0.08))))

    if layout == "editorial":
        left_p = parts["camera"] or parts["lens"]
        left_s = parts["lens"] if parts["camera"] else ""
        right_p = parts["exposure"] or parts["extra"]
        right_s = parts["extra"] if parts["exposure"] else ""

        left_edge = photo_x if pw >= canvas_w * 0.62 else max(24, int(round(canvas_w * 0.06)))
        right_edge = (photo_x + pw) if pw >= canvas_w * 0.62 else (canvas_w - left_edge)
        col_max_w = max(60, int((right_edge - left_edge) * 0.48))

        # 左カラム描画
        if left_p and left_s:
            f_lp = _fit_font_to_width(draw, left_p, title_px, col_max_w, weight=600)
            f_ls = _fit_font_to_width(draw, left_s, sub_px, col_max_w, weight=400)
            gap = max(2, int(round(sub_px * 0.22)))
            draw.text((left_edge, area_cy - gap), left_p, font=f_lp, fill=palette["text_main"], anchor="lb")
            draw.text((left_edge, area_cy + gap), left_s, font=f_ls, fill=palette["text_sub"], anchor="lt")
        elif left_p:
            f_lp = _fit_font_to_width(draw, left_p, title_px, col_max_w, weight=600)
            draw.text((left_edge, area_cy), left_p, font=f_lp, fill=palette["text_main"], anchor="lm")

        # 右カラム ＋ 縦区切り線描画
        max_rw = 0
        if right_p and right_s:
            f_rp = _fit_font_to_width(draw, right_p, int(round(title_px * 0.90)), col_max_w, weight=500)
            f_rs = _fit_font_to_width(draw, right_s, sub_px, col_max_w, weight=400)
            gap = max(2, int(round(sub_px * 0.22)))
            draw.text((right_edge, area_cy - gap), right_p, font=f_rp, fill=palette["text_main"], anchor="rb")
            draw.text((right_edge, area_cy + gap), right_s, font=f_rs, fill=palette["text_sub"], anchor="rt")
            b1 = draw.textbbox((0, 0), right_p, font=f_rp)
            b2 = draw.textbbox((0, 0), right_s, font=f_rs)
            max_rw = max(b1[2] - b1[0], b2[2] - b2[0])
        elif right_p:
            f_rp = _fit_font_to_width(draw, right_p, int(round(title_px * 0.90)), col_max_w, weight=500)
            draw.text((right_edge, area_cy), right_p, font=f_rp, fill=palette["text_main"], anchor="rm")
            b1 = draw.textbbox((0, 0), right_p, font=f_rp)
            max_rw = b1[2] - b1[0]

        if left_p and right_p and max_rw > 0:
            sep_x = right_edge - max_rw - max(10, int(round(title_px * 0.92)))
            sep_half_h = max(8, int(round(title_px * 0.92)))
            sep_w = max(1, int(round(photo_long * 0.0011)))
            if sep_x > left_edge + 40:
                draw.line(
                    [(sep_x, area_cy - sep_half_h), (sep_x, area_cy + sep_half_h)],
                    fill=palette["divider"],
                    width=sep_w,
                )
    else:
        # Classic / Polaroid: 中央揃え 1〜2段
        line1 = parts["camera"] or parts["lens"]
        line2_items: List[str] = []
        if parts["camera"] and parts["lens"]:
            line2_items.append(parts["lens"])
        if parts["exposure"]:
            line2_items.append(parts["exposure"])
        if parts["extra"]:
            line2_items.append(parts["extra"])
        line2 = "  ·  ".join(line2_items)

        cx = canvas_w // 2
        if line1 and line2:
            f1 = _fit_font_to_width(draw, line1, title_px, max_text_w, weight=600)
            f2 = _fit_font_to_width(draw, line2, sub_px, max_text_w, weight=400)
            gap = max(2, int(round(sub_px * 0.24)))
            draw.text((cx, area_cy - gap), line1, font=f1, fill=palette["text_main"], anchor="mb")
            draw.text((cx, area_cy + gap), line2, font=f2, fill=palette["text_sub"], anchor="mt")
        elif line1 or line2:
            single = line1 or line2
            is_primary = bool(line1)
            fs = _fit_font_to_width(draw, single, title_px if is_primary else sub_px, max_text_w, weight=600 if is_primary else 400)
            draw.text((cx, area_cy), single, font=fs, fill=palette["text_main"] if is_primary else palette["text_sub"], anchor="mm")

    return out_rgb
