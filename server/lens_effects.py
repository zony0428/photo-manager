"""
Art Framer Step 2 (演出) 光学レンズ表現・ポストエフェクトエンジン (Pillow + NumPy ベクトル化実装)

責務:
- ぐるぐるボケ (Helios/Petzval風同心円弧ボケ)
- バブルボケ (Trioplan風中空リングボケ)
- オールドソフト (開放滲み)
- 周辺光量 (ビネット) ＆ ブラックミスト風ハレーション
- ピント中心 (cx, cy) とシャープ径 (radius) 内の原画無劣化保護
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

import numpy as np
from PIL import Image

VALID_BOKEH_MODES = ("none", "swirl", "bubble", "soft")


def _clamp(val: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, float(val)))


def normalize_lens_effect_config(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """フロントエンドやAPIから渡されたレンズ演出設定を正規化する"""
    raw = cfg if isinstance(cfg, dict) else {}
    mode = str(raw.get("bokeh_mode") or "none").strip().lower()
    if mode not in VALID_BOKEH_MODES:
        mode = "none"

    strength = _clamp(raw.get("strength", 0.0) or 0.0, 0.0, 1.0)
    specular = _clamp(raw.get("specular", 0.65) if raw.get("specular") is not None else 0.65, 0.0, 1.0)
    radius = _clamp(raw.get("radius", 0.32) if raw.get("radius") is not None else 0.32, 0.08, 0.80)
    feather = _clamp(raw.get("feather", 0.36) if raw.get("feather") is not None else 0.36, 0.10, 0.75)
    cx = _clamp(raw.get("cx", 0.50) if raw.get("cx") is not None else 0.50, 0.0, 1.0)
    cy = _clamp(raw.get("cy", 0.50) if raw.get("cy") is not None else 0.50, 0.0, 1.0)
    vignette = _clamp(raw.get("vignette", 0.0) or 0.0, -1.0, 1.0)
    halation = _clamp(raw.get("halation", 0.0) or 0.0, 0.0, 1.0)

    has_bokeh = (mode != "none") and (strength > 0.01)
    has_vig = abs(vignette) > 0.01
    has_hal = halation > 0.01
    enabled_flag = raw.get("enabled")
    active = (enabled_flag is not False) and (has_bokeh or has_vig or has_hal)

    return {
        "enabled": active,
        "bokeh_mode": mode,
        "strength": strength,
        "specular": specular,
        "radius": radius,
        "feather": feather,
        "cx": cx,
        "cy": cy,
        "vignette": vignette,
        "halation": halation,
    }


def is_lens_effect_active(cfg: Optional[Dict[str, Any]]) -> bool:
    """有効なレンズ演出が1つ以上設定されているかを返す"""
    return bool(normalize_lens_effect_config(cfg).get("enabled"))


def _separable_box_blur_rgb(arr: np.ndarray, radius: int) -> np.ndarray:
    """エッジ複製パディング＋cumsum による O(H*W) 高速分離ボックスブラー (RGB float32 [H,W,3])"""
    r = max(1, int(radius))
    k = 2 * r + 1

    # 水平方向
    padded_h = np.pad(arr, ((0, 0), (r + 1, r), (0, 0)), mode="edge")
    csum_h = np.cumsum(padded_h, axis=1, dtype=np.float64)
    horiz = (csum_h[:, k:, :] - csum_h[:, :-k, :]) / float(k)

    # 垂直方向
    padded_v = np.pad(horiz, ((r + 1, r), (0, 0), (0, 0)), mode="edge")
    csum_v = np.cumsum(padded_v, axis=0, dtype=np.float64)
    vert = (csum_v[k:, :, :] - csum_v[:-k, :, :]) / float(k)
    return vert.astype(np.float32)


def _compute_spot_distance(h: int, w: int, cx: float, cy: float) -> np.ndarray:
    """ピント中心 (cx, cy) からの正規化距離マップ（対角線半分基準）を返す"""
    ys = np.arange(h, dtype=np.float32)[:, None] - (cy * float(h))
    xs = np.arange(w, dtype=np.float32)[None, :] - (cx * float(w))
    half_diag = max(1.0, 0.5 * math.hypot(float(w), float(h)))
    return np.sqrt(xs * xs + ys * ys) / np.float32(half_diag)


def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    span = max(0.05, float(edge1 - edge0))
    t = np.clip((x - np.float32(edge0)) / np.float32(span), 0.0, 1.0)
    return t * t * (np.float32(3.0) - np.float32(2.0) * t)


def _bilinear_sample_rgb(arr: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    """float32 RGB画像 [H,W,3] からサブピクセル座標 (sx, sy) をベクトル化バイリニア補間する"""
    h, w = arr.shape[:2]
    cx = np.clip(sx, 0.0, float(w - 1))
    cy = np.clip(sy, 0.0, float(h - 1))
    x0 = np.floor(cx).astype(np.int32)
    y0 = np.floor(cy).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    wx = (cx - x0)[..., None]
    wy = (cy - y0)[..., None]

    c00 = arr[y0, x0]
    c10 = arr[y0, x1]
    c01 = arr[y1, x0]
    c11 = arr[y1, x1]
    top = c00 * (np.float32(1.0) - wx) + c10 * wx
    bot = c01 * (np.float32(1.0) - wx) + c11 * wx
    return top * (np.float32(1.0) - wy) + bot * wy


def _compute_swirl_bokeh(
    work_arr: np.ndarray,
    cx: float,
    cy: float,
    radius: float,
    feather: float,
    strength: float,
    specular: float,
) -> np.ndarray:
    """Helios / Petzval 風の同心円弧ぐるぐるボケ場を生成する"""
    h, w = work_arr.shape[:2]
    ys_grid, xs_grid = np.mgrid[0:h, 0:w].astype(np.float32)
    cx_px = np.float32(cx * float(w))
    cy_px = np.float32(cy * float(h))
    dx = xs_grid - cx_px
    dy = ys_grid - cy_px
    half_diag = np.float32(max(1.0, 0.5 * math.hypot(float(w), float(h))))
    dist = np.sqrt(dx * dx + dy * dy) / half_diag

    # 周辺に向かって角度が滑らかに立ち上がる
    w_outer = _smoothstep(radius * 0.85, radius + feather * 1.15, dist)
    max_theta = np.float32((2.5 + 13.5 * strength) * (math.pi / 180.0))
    theta_map = max_theta * np.clip(w_outer * (0.45 + 0.65 * dist), 0.0, 1.35)

    # 明部ハイライトを持ち上げて木漏れ日・点光源を美しく伸ばす
    lum = (
        work_arr[:, :, 0] * np.float32(0.2126)
        + work_arr[:, :, 1] * np.float32(0.7152)
        + work_arr[:, :, 2] * np.float32(0.0722)
    )
    hl_t = np.clip((lum - np.float32(0.56)) / np.float32(0.44), 0.0, 1.0)
    hl_gain = np.float32(1.0) + np.float32(3.4 * specular) * (hl_t * hl_t)
    boosted = work_arr * hl_gain[:, :, None]

    # 中心保護域からのわずかな放射収縮 + 13タップの円弧サンプリング
    taps = 13
    half_taps = taps // 2
    accum = np.zeros_like(work_arr, dtype=np.float32)
    weight_sum = np.float32(0.0)
    radial_squash = np.float32(1.0) - np.float32(0.015 * strength) * w_outer

    for idx in range(taps):
        u = float(idx - half_taps) / float(half_taps)  # -1.0 .. +1.0
        tap_w = np.float32(1.0 - 0.35 * (u * u))
        ang = np.float32(u) * theta_map
        cos_a = np.cos(ang)
        sin_a = np.sin(ang)
        sx = cx_px + (dx * cos_a - dy * sin_a) * radial_squash
        sy = cy_px + (dx * sin_a + dy * cos_a) * radial_squash
        accum += _bilinear_sample_rgb(boosted, sx, sy) * tap_w
        weight_sum += tap_w

    swirled = accum / max(np.float32(1e-5), weight_sum)
    # 増幅されたハイライトエネルギーを柔らかく再圧縮
    out = swirled / (np.float32(1.0) + np.maximum(np.float32(0.0), swirled - np.float32(1.0)) * np.float32(0.58))
    return np.clip(out, 0.0, 1.0)


def _compute_bubble_bokeh(work_arr: np.ndarray, strength: float, specular: float) -> np.ndarray:
    """Trioplan 風の滑らかな背景ボケ＋中空シャボン玉リングボケ場を生成する"""
    h, w = work_arr.shape[:2]
    long_edge = max(w, h)
    blur_r = max(2, int(round(long_edge * (0.006 + 0.016 * strength))))
    ring_r = max(4, int(round(long_edge * (0.008 + 0.020 * strength))))

    # 1. ベース背景ボケ（二重エッジ化を防ぐ柔らかい土台）
    base = _separable_box_blur_rgb(_separable_box_blur_rgb(work_arr, blur_r), max(1, blur_r // 2 + 1))

    # 2. 局所ハイライト成分だけを抽出（平坦な白壁には反応させない）
    lum = (
        work_arr[:, :, 0] * np.float32(0.2126)
        + work_arr[:, :, 1] * np.float32(0.7152)
        + work_arr[:, :, 2] * np.float32(0.0722)
    )
    lum_thr = np.clip((lum - np.float32(0.46)) / np.float32(0.54), 0.0, 1.0)
    local_diff = np.maximum(np.float32(0.0), work_arr - base * np.float32(0.88))
    spec_energy = local_diff * (lum_thr * np.float32(1.1 + 2.8 * specular))[:, :, None]

    # 3. 中空シャボン玉カーネル（薄い内部膜 + 24方向内外2重リング）
    inner_glow = _separable_box_blur_rgb(spec_energy, max(2, ring_r // 2)) * np.float32(0.16)

    pad_r = ring_r + 2
    padded = np.pad(spec_energy, ((pad_r, pad_r), (pad_r, pad_r), (0, 0)), mode="edge")
    ring_accum = np.zeros_like(spec_energy, dtype=np.float32)
    n_dirs = 24
    for i in range(n_dirs):
        ang = (2.0 * math.pi * i) / float(n_dirs)
        ox1 = int(round(math.cos(ang) * ring_r))
        oy1 = int(round(math.sin(ang) * ring_r))
        ox2 = int(round(math.cos(ang) * (ring_r * 0.85)))
        oy2 = int(round(math.sin(ang) * (ring_r * 0.85)))
        ring_accum += padded[pad_r + oy1 : pad_r + oy1 + h, pad_r + ox1 : pad_r + ox1 + w] * np.float32(0.65)
        ring_accum += padded[pad_r + oy2 : pad_r + oy2 + h, pad_r + ox2 : pad_r + ox2 + w] * np.float32(0.35)

    ring_glow = (ring_accum / np.float32(float(n_dirs))) * np.float32(1.25 + 1.45 * specular) + inner_glow
    # スクリーン合成でハイライトが自然に溶け込むシャボン玉リングに
    out = np.float32(1.0) - (np.float32(1.0) - base) * (np.float32(1.0) - np.clip(ring_glow, 0.0, 0.92))
    return np.clip(out, 0.0, 1.0)


def _compute_soft_bokeh(work_arr: np.ndarray, strength: float, specular: float) -> np.ndarray:
    """開放オールドレンズ風の柔らかいデフォーカス＋穏やかなハイライト滲み"""
    h, w = work_arr.shape[:2]
    long_edge = max(w, h)
    r = max(2, int(round(long_edge * (0.006 + 0.017 * strength))))
    blur1 = _separable_box_blur_rgb(work_arr, r)
    blur2 = _separable_box_blur_rgb(blur1, max(1, r // 2 + 1))

    lum = (
        work_arr[:, :, 0] * np.float32(0.2126)
        + work_arr[:, :, 1] * np.float32(0.7152)
        + work_arr[:, :, 2] * np.float32(0.0722)
    )
    hl_mask = np.clip((lum - np.float32(0.60)) / np.float32(0.40), 0.0, 1.0)
    hl_src = work_arr * (hl_mask * np.float32(0.65 * specular))[:, :, None]
    hl_glow = _separable_box_blur_rgb(hl_src, max(2, int(round(r * 1.4))))
    out = np.float32(1.0) - (np.float32(1.0) - blur2) * (np.float32(1.0) - np.clip(hl_glow, 0.0, 0.75))
    return np.clip(out, 0.0, 1.0)


def _compute_halation_glow(work_arr: np.ndarray, halation: float) -> np.ndarray:
    """ブラックミスト / フィルムハレーション風の暖色強ハイライト滲みマップを返す"""
    h, w = work_arr.shape[:2]
    long_edge = max(w, h)
    lum = (
        work_arr[:, :, 0] * np.float32(0.2126)
        + work_arr[:, :, 1] * np.float32(0.7152)
        + work_arr[:, :, 2] * np.float32(0.0722)
    )
    hl = np.clip((lum - np.float32(0.66)) / np.float32(0.34), 0.0, 1.0)
    tint = np.array([1.0, 0.86, 0.76], dtype=np.float32)[None, None, :]
    hl_rgb = work_arr * (np.power(hl, np.float32(1.35))[:, :, None]) * tint

    r1 = max(2, int(round(long_edge * (0.012 + 0.024 * halation))))
    r2 = max(2, int(round(r1 * 0.72)))
    g1 = _separable_box_blur_rgb(hl_rgb, r1)
    g2 = _separable_box_blur_rgb(g1, r2)
    g3 = _separable_box_blur_rgb(g2, max(1, r2 // 2))
    return np.clip(g3 * np.float32(0.95 * halation), 0.0, 0.85)


def apply_lens_effects_pil(
    img: Image.Image,
    effect_cfg: Optional[Dict[str, Any]],
    work_max_long: int = 1080,
) -> Image.Image:
    """
    Pillow Image に Step 2（レンズ演出：ぐるぐる/バブル/ソフトボケ・ビネット・ハレーション）を適用して返す。
    """
    cfg = normalize_lens_effect_config(effect_cfg)
    if not cfg["enabled"]:
        return img

    orig_mode = img.mode
    rgb_img = img.convert("RGB") if orig_mode != "RGB" else img
    orig_w, orig_h = rgb_img.size
    if orig_w < 8 or orig_h < 8:
        return img

    has_bokeh = cfg["bokeh_mode"] != "none" and cfg["strength"] > 0.01
    has_hal = cfg["halation"] > 0.01
    has_vig = abs(cfg["vignette"]) > 0.01

    orig_arr = np.asarray(rgb_img, dtype=np.float32) / np.float32(255.0)
    out_arr = orig_arr.copy()

    if has_bokeh or has_hal:
        orig_long = max(orig_w, orig_h)
        w_lim = max(120, int(work_max_long))
        if orig_long > w_lim:
            sc = float(w_lim) / float(orig_long)
            ww = max(16, int(round(orig_w * sc)))
            wh = max(16, int(round(orig_h * sc)))
            work_img = rgb_img.resize((ww, wh), Image.Resampling.BILINEAR)
        else:
            ww, wh = orig_w, orig_h
            work_img = rgb_img
        work_arr = np.asarray(work_img, dtype=np.float32) / np.float32(255.0)

        if has_bokeh:
            mode = cfg["bokeh_mode"]
            if mode == "swirl":
                bokeh_small = _compute_swirl_bokeh(
                    work_arr, cfg["cx"], cfg["cy"], cfg["radius"], cfg["feather"], cfg["strength"], cfg["specular"]
                )
            elif mode == "bubble":
                bokeh_small = _compute_bubble_bokeh(work_arr, cfg["strength"], cfg["specular"])
            else:
                bokeh_small = _compute_soft_bokeh(work_arr, cfg["strength"], cfg["specular"])

            if (ww, wh) != (orig_w, orig_h):
                b_pil = Image.fromarray((np.clip(bokeh_small, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), mode="RGB")
                bokeh_full = np.asarray(b_pil.resize((orig_w, orig_h), Image.Resampling.BILINEAR), dtype=np.float32) / np.float32(255.0)
            else:
                bokeh_full = bokeh_small

            dist_full = _compute_spot_distance(orig_h, orig_w, cfg["cx"], cfg["cy"])
            w_spot = _smoothstep(cfg["radius"], cfg["radius"] + cfg["feather"], dist_full)[:, :, None]
            out_arr = out_arr * (np.float32(1.0) - w_spot) + bokeh_full * w_spot

        if has_hal:
            hal_small = _compute_halation_glow(work_arr, cfg["halation"])
            if (ww, wh) != (orig_w, orig_h):
                h_pil = Image.fromarray((np.clip(hal_small, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), mode="RGB")
                hal_full = np.asarray(h_pil.resize((orig_w, orig_h), Image.Resampling.BILINEAR), dtype=np.float32) / np.float32(255.0)
            else:
                hal_full = hal_small
            out_arr = np.float32(1.0) - (np.float32(1.0) - out_arr) * (np.float32(1.0) - hal_full)

    if has_vig:
        dist_full = _compute_spot_distance(orig_h, orig_w, cfg["cx"], cfg["cy"])
        vig_w = _smoothstep(cfg["radius"] * 0.72, cfg["radius"] * 0.72 + cfg["feather"] * 1.2 + 0.16, dist_full)[:, :, None]
        v = cfg["vignette"]
        if v < 0:
            att = np.float32(1.0) - np.float32(abs(v) * 0.84) * vig_w
            out_arr = out_arr * np.clip(att, 0.08, 1.0)
        else:
            lift = np.float32(v * 0.36) * vig_w
            out_arr = out_arr + (np.float32(1.0) - out_arr) * lift

    out_u8 = (np.clip(out_arr, 0.0, 1.0) * np.float32(255.0) + np.float32(0.5)).astype(np.uint8)
    res_img = Image.fromarray(out_u8, mode="RGB")
    if orig_mode != "RGB" and orig_mode in ("RGBA", "L"):
        return res_img.convert(orig_mode)
    return res_img
