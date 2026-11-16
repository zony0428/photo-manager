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
            # 単一ガウスぼかしからのAI逆畳み込み復元を防ぐため、一度極小セルへ不可逆縮小してから強ぼかしをかける
            q_short = max(2, int(round(min(bw, bh) / max(6.0, plate_short * 0.42))))
            q_long = max(3, int(round(max(bw, bh) / max(6.0, plate_short * 0.42))))
            qw, qh = (q_long, q_short) if bw >= bh else (q_short, q_long)
            quantized = base_patch.resize((qw, qh), Image.Resampling.BOX).resize(
                (bw, bh), Image.Resampling.BILINEAR
            )
            blur_r = max(8.0, long_edge * 0.024, plate_short * 0.42)
            fill_patch = quantized.filter(ImageFilter.GaussianBlur(radius=blur_r))
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
    顔モヤスタンプ（極小ボトルネック量子化 ＋ 環境色フラット収束 ＋ 濃厚ベール ＋ 外周フェザー減衰）を合成する。
    デブラーAIや顔超解像AI（CodeFormer等）による逆算・特徴復元を防ぐため、顔内部の空間位相情報を物理的に消滅させ、
    円の輪郭線が出ない自然なモヤで不可逆消去する（strength=1.0 では陰影も含め完全に無地化する）。
    style: 'frosted' (自然すりガラス) | 'milky' (白モヤ) | 'smoke' (スモークモヤ)
    """
    if not faces:
        return img

    out = img.convert("RGB")
    w, h = out.size
    long_edge = max(w, h)

    for idx, face in enumerate(faces):
        try:
            nx = float(np.clip(float(face.get("x", 0.5)), 0.0, 1.0))
            ny = float(np.clip(float(face.get("y", 0.5)), 0.0, 1.0))
            nr = float(np.clip(float(face.get("r", 0.052)), 0.005, 0.45))
            strength = float(np.clip(float(face.get("strength", 0.92)), 0.35, 1.0))
        except Exception as e:
            logger.debug(f"不正な顔スタンプ座標をスキップ: {e}")
            continue

        cx = nx * w
        cy = ny * h
        rad = max(8.0, nr * long_edge)
        t_s = float(np.clip((strength - 0.35) / 0.65, 0.0, 1.0))

        # ガイド円の内側は100%完全遮蔽し、フェザー減衰はガイド円の外側(outer_r)へ逃がして素顔の透けを防ぐ
        inner_r = rad * (0.64 + 0.24 * t_s)
        outer_r = rad * (1.28 + 0.14 * t_s)
        blur_r = max(7.0, rad * (0.44 + 0.52 * t_s))
        margin = int(np.ceil(outer_r + blur_r * 0.6 + 6))

        bx1 = max(0, int(np.floor(cx)) - margin)
        by1 = max(0, int(np.floor(cy)) - margin)
        bx2 = min(w, int(np.ceil(cx)) + margin)
        by2 = min(h, int(np.ceil(cy)) + margin)
        bw = bx2 - bx1
        bh = by2 - by1
        if bw < 2 or bh < 2:
            continue

        base_patch = out.crop((bx1, by1, bx2, by2))
        base_np = np.asarray(base_patch, dtype=np.float32)

        # 1. 顔中心部の環境平均色を算出し、生々しい肌色彩度をわずかに抑えたベース色を作る
        yy_local, xx_local = np.ogrid[by1:by2, bx1:bx2]
        dist_px = np.sqrt((xx_local - cx) ** 2 + (yy_local - cy) ** 2)
        core_mask = dist_px <= max(3.0, rad * 0.72)
        if np.any(core_mask):
            ambient_rgb = base_np[core_mask].mean(axis=0)
        else:
            ambient_rgb = base_np.reshape(-1, 3).mean(axis=0)
        ambient_luma = float(
            0.299 * ambient_rgb[0] + 0.587 * ambient_rgb[1] + 0.114 * ambient_rgb[2]
        )
        frosted_rgb = ambient_rgb * 0.72 + ambient_luma * 0.28

        # 2. 情報ボトルネック縮小: 目・鼻・口の空間位相配置を数セル以下へ物理的に潰して不可逆消去する
        cells_per_diam = 5.2 * ((1.0 - t_s) ** 1.38) + 1.0
        cell_px = max(4.0, (2.0 * rad) / cells_per_diam)
        gw = max(1, int(round(bw / cell_px)))
        gh = max(1, int(round(bh / cell_px)))
        bottleneck_patch = base_patch.resize((gw, gh), Image.Resampling.BOX).resize(
            (bw, bh), Image.Resampling.BILINEAR
        )
        haze_patch = bottleneck_patch.filter(ImageFilter.GaussianBlur(radius=blur_r))
        haze_np = np.asarray(haze_patch, dtype=np.float32)

        # 3. 濃さに応じて環境色へフラット収束させる (strength=100% では元の陰影・コントラストもほぼゼロになる)
        flat_mix = float((t_s ** 1.55) * 0.96)
        haze_np = haze_np * (1.0 - flat_mix) + frosted_rgb[np.newaxis, np.newaxis, :] * flat_mix

        # 4. スタイル別のベール合成
        style = str(face.get("style") or "frosted").lower()
        if style == "milky":
            veil_rgb = np.array([247.0, 249.0, 252.0], dtype=np.float32)
            veil_alpha = float(0.30 + 0.62 * (t_s ** 1.12))
            haze_np = haze_np * (1.0 - veil_alpha) + veil_rgb * veil_alpha
        elif style == "smoke":
            veil_rgb = np.array([26.0, 30.0, 38.0], dtype=np.float32)
            veil_alpha = float(0.30 + 0.62 * (t_s ** 1.12))
            haze_np = haze_np * (1.0 - veil_alpha) + veil_rgb * veil_alpha
        else:
            # 自然すりガラス: 明暗差をさらに穏やかに整え、極端なトーンカーブ強調への耐性を高める
            soft_veil = np.clip(frosted_rgb * 0.86 + 242.0 * 0.14, 0.0, 255.0)
            frosted_alpha = float(0.14 + 0.34 * t_s)
            haze_np = haze_np * (1.0 - frosted_alpha) + soft_veil * frosted_alpha

        # 5. 微細な不可逆すりガラス粒子を加算し、デコンボリューションAIの逆算を手掛かりゼロにする
        rng = np.random.default_rng((int(round(cx * 100)) * 73856093 ^ int(round(cy * 100)) * 19349663 ^ (idx + 1)) & 0xFFFFFFFF)
        grain = rng.normal(0.0, 1.8, size=haze_np.shape).astype(np.float32)
        haze_u8 = np.clip(np.rint(haze_np + grain), 0, 255).astype(np.uint8)
        haze_final = Image.fromarray(haze_u8, mode="RGB")

        # 6. 内側コアは不透明度100%で生画像を完全置換し、外周リング(inner_r〜outer_r)でコサイン減衰させる
        t_ring = np.clip((dist_px - inner_r) / max(1.0, outer_r - inner_r), 0.0, 1.0)
        peak_alpha = min(1.0, 0.94 + 0.08 * t_s)
        alpha_norm = 0.5 * (1.0 + np.cos(np.pi * t_ring)) * peak_alpha
        alpha_u8 = np.clip(np.rint(alpha_norm * 255.0), 0, 255).astype(np.uint8)
        mask_feather = Image.fromarray(alpha_u8, mode="L")

        composited = Image.composite(haze_final, base_patch, mask_feather)
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
