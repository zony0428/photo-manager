"""
プライバシーマスク描画モジュール (Pillow + NumPy)
正規化座標 (0.0〜1.0) で指定されたナンバープレート4頂点枠および顔モヤスタンプを、
アンチエイリアスおよび放射状フェザー減衰を用いて不可逆合成する。
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFilter

logger = logging.getLogger(__name__)


def _parse_rgb_color(hex_str: Optional[str], fallback: Tuple[int, int, int] = (244, 246, 249)) -> Tuple[int, int, int]:
    """HEXカラー文字列を安全に (R, G, B) タプルへ変換する"""
    if not hex_str or not isinstance(hex_str, str):
        return fallback
    try:
        rgb = ImageColor.getrgb(hex_str.strip())
        return (int(rgb[0]), int(rgb[1]), int(rgb[2]))
    except Exception as e:
        logger.debug(f"マスク色パースフォールバック ({hex_str}): {e}")
        return fallback


def _expand_pts_by_px(pts: List[Tuple[float, float]], delta_px: float) -> List[Tuple[float, float]]:
    """4頂点を中心から指定ピクセル量だけ外側へ等方オフセットする"""
    if delta_px <= 0.0 or not pts:
        return pts
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    out: List[Tuple[float, float]] = []
    for px, py in pts:
        dx = px - cx
        dy = py - cy
        dist = float(np.hypot(dx, dy))
        if dist < 1e-4:
            out.append((px, py))
        else:
            scale = (dist + delta_px) / dist
            out.append((cx + dx * scale, cy + dy * scale))
    return out


def _apply_plate_quads_pil(
    img: Image.Image,
    plates: List[Dict[str, Any]],
    default_feather: float = 0.45,
) -> Image.Image:
    """
    ナンバープレート用の4頂点自由四角形マスクを4倍スーパーサンプリング＋ソフトフェザー（フチのモヤ）で合成する。
    style: 'solid' (指定色塗り＋フチモヤ馴染ませ) | 'blur' (強ガウスぼかし) | 'mosaic' (ピクセルモザイク)
    feather: 0.0 (シャープ境界) 〜 1.0 (広いモヤ境界、既定 0.45)
    """
    if not plates:
        return img

    out = img.convert("RGB")
    w, h = out.size
    long_edge = max(w, h)

    for plate in plates:
        raw_pts = plate.get("pts")
        if not isinstance(raw_pts, list) or len(raw_pts) < 3:
            continue

        try:
            pts_px = [
                (
                    float(np.clip(float(p.get("x", 0.0)), 0.0, 1.0)) * w,
                    float(np.clip(float(p.get("y", 0.0)), 0.0, 1.0)) * h,
                )
                for p in raw_pts[:4]
            ]
        except Exception as e:
            logger.debug(f"不正なプレート頂点座標をスキップ: {e}")
            continue

        try:
            raw_f = plate.get("feather", default_feather)
            feather = float(np.clip(float(default_feather if raw_f is None else raw_f), 0.0, 1.0))
        except Exception:
            feather = default_feather

        xs = [p[0] for p in pts_px]
        ys = [p[1] for p in pts_px]
        plate_short = max(6.0, min(max(xs) - min(xs), max(ys) - min(ys)))
        feather_r = max(1.4, plate_short * 0.22 * feather) if feather > 0.02 else 0.0

        pad = max(10, int(np.ceil(long_edge * 0.02 + feather_r * 3.2)))
        bx1 = max(0, int(np.floor(min(xs))) - pad)
        by1 = max(0, int(np.floor(min(ys))) - pad)
        bx2 = min(w, int(np.ceil(max(xs))) + pad)
        by2 = min(h, int(np.ceil(max(ys))) + pad)
        bw = bx2 - bx1
        bh = by2 - by1
        if bw < 2 or bh < 2:
            continue

        ss = 4
        base_patch = out.crop((bx1, by1, bx2, by2))
        style = str(plate.get("style") or "solid").lower()

        # フチモヤ有効時は内側コアの不透明度100%を保つため微小膨張してからガウス減衰させる
        core_pts = _expand_pts_by_px(pts_px, feather_r * 0.55) if feather_r > 0.0 else pts_px
        mask_hi = Image.new("L", (bw * ss, bh * ss), 0)
        draw_hi = ImageDraw.Draw(mask_hi)
        local_pts_hi = [((px - bx1) * ss, (py - by1) * ss) for (px, py) in core_pts]
        draw_hi.polygon(local_pts_hi, fill=255)
        mask_soft = mask_hi.resize((bw, bh), Image.Resampling.LANCZOS)
        if feather_r > 0.0:
            mask_soft = mask_soft.filter(ImageFilter.GaussianBlur(radius=feather_r))

        working_base = base_patch
        if style == "blur":
            blur_r = max(8.0, long_edge * 0.022, plate_short * 0.36)
            fill_patch = base_patch.filter(ImageFilter.GaussianBlur(radius=blur_r))
        elif style == "mosaic":
            block = max(6, int(round(long_edge * 0.012)))
            mw = max(1, bw // block)
            mh = max(1, bh // block)
            fill_patch = base_patch.resize((mw, mh), Image.Resampling.BILINEAR).resize(
                (bw, bh), Image.Resampling.NEAREST
            )
        else:
            rgb_col = _parse_rgb_color(plate.get("color"))
            fill_patch = Image.new("RGB", (bw, bh), rgb_col)
            if feather_r > 0.0:
                # カラー塗りの半透明フェザー境界で文字端や黒枠が透けず自然に馴染むよう下地モヤを敷く
                under_pts = _expand_pts_by_px(pts_px, feather_r * 1.15)
                under_hi = Image.new("L", (bw * ss, bh * ss), 0)
                ImageDraw.Draw(under_hi).polygon(
                    [((px - bx1) * ss, (py - by1) * ss) for (px, py) in under_pts], fill=220
                )
                mask_under = under_hi.resize((bw, bh), Image.Resampling.LANCZOS).filter(
                    ImageFilter.GaussianBlur(radius=feather_r * 1.35)
                )
                under_blur = base_patch.filter(
                    ImageFilter.GaussianBlur(radius=max(4.5, plate_short * 0.28))
                )
                working_base = Image.composite(under_blur, base_patch, mask_under)

        composited = Image.composite(fill_patch, working_base, mask_soft)
        out.paste(composited, (bx1, by1))

    return out


def _apply_face_haze_stamps_pil(img: Image.Image, faces: List[Dict[str, Any]]) -> Image.Image:
    """
    顔モヤスタンプ（強ガウスぼかし ＋ 任意のベール色 ＋ 放射状フェザー減衰）を合成する。
    円の輪郭線が一切出ない自然なボケ・モヤで個人識別特徴を不可逆消去する。
    style: 'frosted' (自然すりガラス) | 'milky' (白モヤ) | 'smoke' (スモークモヤ)
    """
    if not faces:
        return img

    out = img.convert("RGB")
    w, h = out.size
    long_edge = max(w, h)

    for face in faces:
        try:
            nx = float(np.clip(float(face.get("x", 0.5)), 0.0, 1.0))
            ny = float(np.clip(float(face.get("y", 0.5)), 0.0, 1.0))
            nr = float(np.clip(float(face.get("r", 0.05)), 0.005, 0.45))
            strength = float(np.clip(float(face.get("strength", 0.88)), 0.30, 1.0))
        except Exception as e:
            logger.debug(f"不正な顔スタンプ座標をスキップ: {e}")
            continue

        cx = nx * w
        cy = ny * h
        rad = max(6.0, nr * long_edge)
        blur_r = max(6.0, rad * 0.48)
        margin = int(np.ceil(rad + blur_r + 4))

        bx1 = max(0, int(np.floor(cx)) - margin)
        by1 = max(0, int(np.floor(cy)) - margin)
        bx2 = min(w, int(np.ceil(cx)) + margin)
        by2 = min(h, int(np.ceil(cy)) + margin)
        bw = bx2 - bx1
        bh = by2 - by1
        if bw < 2 or bh < 2:
            continue

        base_patch = out.crop((bx1, by1, bx2, by2))
        blurred_patch = base_patch.filter(ImageFilter.GaussianBlur(radius=blur_r))

        style = str(face.get("style") or "frosted").lower()
        if style == "milky":
            veil = Image.new("RGB", (bw, bh), (248, 250, 252))
            blurred_patch = Image.blend(blurred_patch, veil, alpha=min(0.52, 0.45 * strength))
        elif style == "smoke":
            veil = Image.new("RGB", (bw, bh), (28, 32, 40))
            blurred_patch = Image.blend(blurred_patch, veil, alpha=min(0.50, 0.42 * strength))

        # NumPy による滑らかなコサイン放射状フェザーマスク生成 (中心1.0 → 外周0.0)
        yy, xx = np.ogrid[by1:by2, bx1:bx2]
        dist_ratio = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / max(1.0, rad)
        # 内側 35% は完全不透明、35%〜100% で滑らかなコサインカーブでゼロへ減衰
        t = np.clip((dist_ratio - 0.32) / 0.68, 0.0, 1.0)
        alpha_norm = 0.5 * (1.0 + np.cos(np.pi * t)) * min(1.0, strength * 1.08)
        alpha_u8 = np.clip(alpha_norm * 255.0, 0, 255).astype(np.uint8)
        mask_feather = Image.fromarray(alpha_u8, mode="L")

        composited = Image.composite(blurred_patch, base_patch, mask_feather)
        out.paste(composited, (bx1, by1))

    return out


def apply_privacy_masks_pil(img: Image.Image, mask_config: Optional[Dict[str, Any]]) -> Image.Image:
    """
    写真に対してナンバープレート4頂点マスクおよび顔モヤスタンプを一括適用する。
    mask_config 例: {"enabled": True, "plates": [...], "faces": [...]}
    """
    if not mask_config or not isinstance(mask_config, dict):
        return img
    if mask_config.get("enabled") is False:
        return img

    plates = mask_config.get("plates") or []
    faces = mask_config.get("faces") or []
    if not plates and not faces:
        return img

    result = img
    if isinstance(plates, list) and plates:
        try:
            def_feather = float(mask_config.get("plate_feather", 0.45))
        except Exception:
            def_feather = 0.45
        result = _apply_plate_quads_pil(result, plates, default_feather=def_feather)
    if isinstance(faces, list) and faces:
        result = _apply_face_haze_stamps_pil(result, faces)
    return result
