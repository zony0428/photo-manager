"""
ナンバープレート4頂点精密スナップ補正 ＆ 日本2段プレート補完検出モジュール
1) 太字ナンバー (99-09 等) でも文字穴に惑わされず、黒フレームをバリアとして白いプレート板1枚だけを抽出・角度リセット吸着する。
2) 4辺それぞれの独立外枠コントラスト＋文字ストロークの急峻エッジ＋明暗ダイナミックレンジ検証により、
   コンクリートの段差・縁石・影・白線などの明暗差による誤検出を排除する。
追加ライブラリ不要 (numpy + Pillow のみ)。
"""

from collections import deque
import logging
import math
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger("photo_manager.ai")


def _dilate3_bool(mask: np.ndarray) -> np.ndarray:
    """3x3 近傍の高速論理膨張 (NumPy スライシング)"""
    p = np.pad(mask, 1, mode="constant", constant_values=False)
    return (
        p[:-2, :-2] | p[:-2, 1:-1] | p[:-2, 2:]
        | p[1:-1, :-2] | p[1:-1, 1:-1] | p[1:-1, 2:]
        | p[2:, :-2] | p[2:, 1:-1] | p[2:, 2:]
    )


def _erode3_bool(mask: np.ndarray) -> np.ndarray:
    """3x3 十字近傍の高速論理収縮 (NumPy スライシング)"""
    p = np.pad(mask, 1, mode="constant", constant_values=False)
    return (
        p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:] & p[1:-1, 1:-1]
    )


def _order_pts_cw_np(pts: np.ndarray) -> np.ndarray:
    """
    4頂点 (4, 2) を時計回り順に整列し、長辺ペアのうち上側にある辺が必ず [0]->[1] (TL->TR) になるよう正規化する。
    ダッチアングル（大きな回転角）や非正方形アスペクトでも90度横倒しにならない回転不変の頂点整列。
    """
    center = np.mean(pts, axis=0)
    angles = np.arctan2(pts[:, 1] - center[1], pts[:, 0] - center[0])
    cw = pts[np.argsort(angles)]

    len_01_23 = 0.5 * (float(np.linalg.norm(cw[1] - cw[0])) + float(np.linalg.norm(cw[3] - cw[2])))
    len_12_30 = 0.5 * (float(np.linalg.norm(cw[2] - cw[1])) + float(np.linalg.norm(cw[0] - cw[3])))
    if len_12_30 > len_01_23 * 1.03:
        cw = np.roll(cw, -1, axis=0)

    # 2本の長辺 (0->1 と 2->3) のうち、上側（y平均が小さい、同値ならx平均が小さい方）を先頭 0->1 (上辺) に揃える
    mid_y_01 = 0.5 * float(cw[0, 1] + cw[1, 1])
    mid_y_23 = 0.5 * float(cw[2, 1] + cw[3, 1])
    if mid_y_01 > mid_y_23:
        cw = np.roll(cw, -2, axis=0)
    return cw


def _extract_blobs_grid(
    mask: np.ndarray, min_pixels: int = 24, max_pixels: int = 60000
) -> List[Tuple[np.ndarray, np.ndarray]]:
    """2値マスクから8近傍連結成分の (ys, xs) 座標配列リストを高速抽出する"""
    h, w = mask.shape
    fg_ys, fg_xs = np.nonzero(mask)
    if fg_ys.size < min_pixels:
        return []

    visited = np.zeros((h, w), dtype=bool)
    blobs: List[Tuple[np.ndarray, np.ndarray]] = []

    for start_y, start_x in zip(fg_ys.tolist(), fg_xs.tolist()):
        if visited[start_y, start_x]:
            continue
        visited[start_y, start_x] = True
        q = deque([(start_y, start_x)])
        comp_y = [start_y]
        comp_x = [start_x]

        while q:
            cy, cx = q.popleft()
            y0 = cy - 1 if cy > 0 else 0
            y1 = cy + 1 if cy + 1 < h else h - 1
            x0 = cx - 1 if cx > 0 else 0
            x1 = cx + 1 if cx + 1 < w else w - 1

            for ny in range(y0, y1 + 1):
                for nx in range(x0, x1 + 1):
                    if mask[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        q.append((ny, nx))
                        comp_y.append(ny)
                        comp_x.append(nx)

        cnt = len(comp_y)
        if min_pixels <= cnt <= max_pixels:
            blobs.append((np.array(comp_y, dtype=np.float32), np.array(comp_x, dtype=np.float32)))

    return blobs


def quad_is_well_formed(pts: np.ndarray, min_sin_angle: float = 0.58, min_opp_ratio: float = 0.56) -> bool:
    """
    4頂点 (4, 2) が対角潰れやねじれのない妥当な凸台形・長方形であるか判定する（回転角に依存しない内角・対辺検査）。
    """
    ordered = _order_pts_cw_np(pts.astype(np.float32))
    lens = [float(np.linalg.norm(ordered[(k + 1) % 4] - ordered[k])) for k in range(4)]
    if min(lens) <= 1e-4:
        return False

    if (min(lens[0], lens[2]) / max(lens[0], lens[2])) < min_opp_ratio:
        return False
    if (min(lens[1], lens[3]) / max(lens[1], lens[3])) < min_opp_ratio:
        return False

    # 各頂点における隣接2辺の外積符号（凸性）と内角の sin(θ) を検証（対角潰れ図形は鋭角になり sin が急落する）
    cross_signs = []
    for k in range(4):
        p_prev = ordered[(k - 1) % 4]
        p_curr = ordered[k]
        p_next = ordered[(k + 1) % 4]
        e1 = p_curr - p_prev
        e2 = p_next - p_curr
        n1 = float(np.linalg.norm(e1))
        n2 = float(np.linalg.norm(e2))
        if n1 <= 1e-4 or n2 <= 1e-4:
            return False
        cross_z = float(e1[0] * e2[1] - e1[1] * e2[0])
        sin_val = abs(cross_z) / (n1 * n2)
        if sin_val < min_sin_angle:
            return False
        cross_signs.append(1 if cross_z >= 0 else -1)

    # 全頂点で外積符号が一致（自己交差・凹四角形でない）していること
    return len(set(cross_signs)) == 1


def _extract_best_plate_component(
    mask: np.ndarray, ix0: int, ix1: int, iy0: int, iy1: int
) -> Tuple[np.ndarray, np.ndarray]:
    """
    2値マスク内の全連結成分から、ROI外枠へ漏れておらずコア領域 [ix0:ix1, iy0:iy1] と重なる
    最大面積のプレート板本体成分 (ys, xs) を返す。
    数字 '9', '0', '8' 等の閉じたループ内の小さな白い穴を誤選択するのを完全に防ぐ。
    """
    h, w = mask.shape
    best_ys = np.empty(0, dtype=np.float32)
    best_xs = np.empty(0, dtype=np.float32)
    best_area = 0.0

    for comp_y, comp_x in _extract_blobs_grid(mask, min_pixels=24, max_pixels=h * w):
        min_cx, max_cx = float(np.min(comp_x)), float(np.max(comp_x))
        min_cy, max_cy = float(np.min(comp_y)), float(np.max(comp_y))
        # ROI外枠へ漏れ出している成分（上下の白バンパー等）は除外
        if min_cx < 1.5 or max_cx > w - 2.5 or min_cy < 1.5 or max_cy > h - 2.5:
            continue
        # コア領域内に画素を持つか確認
        in_core = (comp_x >= ix0) & (comp_x < ix1) & (comp_y >= iy0) & (comp_y < iy1)
        if not np.any(in_core):
            continue
        bbox_area = (max_cx - min_cx + 1.0) * (max_cy - min_cy + 1.0)
        score_area = float(comp_y.size) + bbox_area * 0.25
        if score_area > best_area:
            best_area = score_area
            best_ys = comp_y
            best_xs = comp_x

    return best_ys, best_xs


def _snap_by_side_grille_contrast(
    roi_lum: np.ndarray,
    cx_s: float,
    cy_s: float,
    hw_s: float,
    hh_s: float,
    plate_lum: float,
) -> Optional[np.ndarray]:
    """
    左右外側の黒グリル/濃色ホルダーとプレート板の輝度差プロファイルを用いて4頂点を精密検出する。
    白いボディの車でナンバー上縁が白いフロントバンパーに隙間0pxで密着していても、
    バンパー行では左右外側も白くなって差分コントラストが急落するため上下左右4辺を正確に分離できる。
    正面構図では完全水平・垂直にロックし、斜め構図では台形4頂点へ追従する。
    """
    sh, sw = roi_lum.shape
    my0 = max(0, int(round(cy_s - hh_s * 0.50)))
    my1 = min(sh, max(my0 + 4, int(round(cy_s + hh_s * 0.50))))
    if my1 - my0 < 4 or sw < 20:
        return None

    col_p85 = np.percentile(roi_lum[my0:my1, :], 85, axis=0)
    side_span_x = max(3, int(sw * 0.16))
    g_left = float(np.median(col_p85[:side_span_x]))
    g_right = float(np.median(col_p85[sw - side_span_x :]))

    # 左右外側がプレート板より明確に暗い（グリル内・濃色ホルダー内）場合のみ適用
    if (plate_lum - g_left) < 28.0 or (plate_lum - g_right) < 28.0:
        return None

    g_lum = max(g_left, g_right)
    thr_x = g_lum + 0.44 * (plate_lum - g_lum)
    cx_i = int(np.clip(round(cx_s), 2, sw - 3))
    if col_p85[cx_i] < thr_x:
        return None

    xl = cx_i
    while xl > 0 and col_p85[xl - 1] >= thr_x:
        xl -= 1
    xr = cx_i
    while xr + 1 < sw and col_p85[xr + 1] >= thr_x:
        xr += 1

    det_w = float(xr - xl + 1)
    if xl < 2 or xr > sw - 3 or det_w < hw_s * 1.32 or det_w > hw_s * 2.75:
        return None

    # プレート幅内と左右外側グリルの行ごと輝度差プロファイルで上下端を検出
    side_w = max(5, int(round(det_w * 0.22)))
    sl0, sl1 = max(0, xl - side_w - 2), max(2, xl - 2)
    sr0, sr1 = min(sw - 2, xr + 3), min(sw, xr + side_w + 3)
    if sl1 <= sl0 or sr1 <= sr0:
        return None

    row_in = np.percentile(roi_lum[:, xl : xr + 1], 85, axis=1)
    row_side_l = np.median(roi_lum[:, sl0:sl1], axis=1)
    row_side_r = np.median(roi_lum[:, sr0:sr1], axis=1)
    row_contrast = row_in - 0.5 * (row_side_l + row_side_r)

    peak_c = float(np.percentile(row_contrast[my0:my1], 80))
    if peak_c < 28.0:
        return None
    thr_y = max(20.0, peak_c * 0.42)

    cy_i = int(np.clip(round(cy_s), 2, sh - 3))
    if row_contrast[cy_i] < thr_y:
        return None

    yt = cy_i
    while yt > 0 and row_contrast[yt - 1] >= thr_y:
        yt -= 1
    yb = cy_i
    while yb + 1 < sh and row_contrast[yb + 1] >= thr_y:
        yb += 1

    det_h = float(yb - yt + 1)
    det_aspect = det_w / max(1.0, det_h)
    if yt < 1 or yb > sh - 2 or det_aspect < 1.02 or det_aspect > 3.55:
        return None

    # 左右半領域・上下半領域それぞれの端から斜め構図の台形傾きを計測
    mid_x = (xl + xr) // 2
    mid_y = (yt + yb) // 2
    yt_l, yb_l, yt_r, yb_r = float(yt), float(yb), float(yt), float(yb)
    xl_t, xr_t, xl_b, xr_b = float(xl), float(xr), float(xl), float(xr)

    if mid_x - xl >= 6 and xr - mid_x >= 6:
        rc_l = np.percentile(roi_lum[:, xl + 1 : mid_x], 85, axis=1) - row_side_l
        rc_r = np.percentile(roi_lum[:, mid_x + 1 : xr], 85, axis=1) - row_side_r
        tl = mid_y
        while tl > max(0, yt - 4) and rc_l[tl - 1] >= thr_y * 0.92:
            tl -= 1
        bl = mid_y
        while bl + 1 < min(sh, yb + 5) and rc_l[bl + 1] >= thr_y * 0.92:
            bl += 1
        tr = mid_y
        while tr > max(0, yt - 4) and rc_r[tr - 1] >= thr_y * 0.92:
            tr -= 1
        br = mid_y
        while br + 1 < min(sh, yb + 5) and rc_r[br + 1] >= thr_y * 0.92:
            br += 1
        if abs(tl - yt) <= det_h * 0.25 and abs(tr - yt) <= det_h * 0.25:
            yt_l, yt_r = float(tl), float(tr)
        if abs(bl - yb) <= det_h * 0.25 and abs(br - yb) <= det_h * 0.25:
            yb_l, yb_r = float(bl), float(br)

    if mid_y - yt >= 4 and yb - mid_y >= 4:
        cp_t = np.percentile(roi_lum[yt + 1 : mid_y, :], 85, axis=0)
        cp_b = np.percentile(roi_lum[mid_y + 1 : yb, :], 85, axis=0)
        lt = mid_x
        while lt > max(0, xl - 4) and cp_t[lt - 1] >= thr_x * 0.95:
            lt -= 1
        rt = mid_x
        while rt + 1 < min(sw, xr + 5) and cp_t[rt + 1] >= thr_x * 0.95:
            rt += 1
        lb = mid_x
        while lb > max(0, xl - 4) and cp_b[lb - 1] >= thr_x * 0.95:
            lb -= 1
        rb = mid_x
        while rb + 1 < min(sw, xr + 5) and cp_b[rb + 1] >= thr_x * 0.95:
            rb += 1
        if abs(lt - xl) <= det_w * 0.20 and abs(lb - xl) <= det_w * 0.20:
            xl_t, xl_b = float(lt), float(lb)
        if abs(rt - xr) <= det_w * 0.20 and abs(rb - xr) <= det_w * 0.20:
            xr_t, xr_b = float(rt), float(rb)

    # 真っ正面構図（微小ノイズ範囲内）では完全な水平・垂直長方形へスナップロック
    if abs(yt_l - yt_r) <= max(2.2, det_h * 0.055) and abs(yb_l - yb_r) <= max(2.2, det_h * 0.055):
        yt_l = yt_r = float(yt)
        yb_l = yb_r = float(yb)
    if abs(xl_t - xl_b) <= max(2.2, det_w * 0.045) and abs(xr_t - xr_b) <= max(2.2, det_w * 0.045):
        xl_t = xl_b = float(xl)
        xr_t = xr_b = float(xr)

    return np.array(
        [
            [xl_t, yt_l],
            [xr_t, yt_r],
            [xr_b, yb_r],
            [xl_b, yb_l],
        ],
        dtype=np.float32,
    )


def _fit_min_area_quad(xs: np.ndarray, ys: np.ndarray) -> Tuple[np.ndarray, float, float, float]:
    """
    画素群 (xs, ys) に対し角度 -42°〜+42° (1度刻み) で最小面積外接長方形を求める。
    ダッチアングル（斜め構図）の車両ナンバーにも対応。
    戻り値: (quad_px (4,2) [TL,TR,BR,BL], width, height, rectangularity)
    """
    cx = float(np.mean(xs))
    cy = float(np.mean(ys))
    dx = xs - cx
    dy = ys - cy

    angles_deg = np.linspace(-42.0, 42.0, 85, dtype=np.float32)
    rads = np.deg2rad(angles_deg)
    cos_v = np.cos(rads)[:, None]
    sin_v = np.sin(rads)[:, None]

    proj_u = cos_v * dx[None, :] + sin_v * dy[None, :]
    proj_v = -sin_v * dx[None, :] + cos_v * dy[None, :]

    u_min = np.min(proj_u, axis=1)
    u_max = np.max(proj_u, axis=1)
    v_min = np.min(proj_v, axis=1)
    v_max = np.max(proj_v, axis=1)

    widths = np.maximum(1.0, u_max - u_min + 1.0)
    heights = np.maximum(1.0, v_max - v_min + 1.0)
    areas = widths * heights

    best_i = int(np.argmin(areas))
    ca = float(np.cos(rads[best_i]))
    sa = float(np.sin(rads[best_i]))
    u0, u1 = float(u_min[best_i]), float(u_max[best_i])
    v0, v1 = float(v_min[best_i]), float(v_max[best_i])

    u_vec = np.array([ca, sa], dtype=np.float32)
    v_vec = np.array([-sa, ca], dtype=np.float32)
    c_pt = np.array([cx, cy], dtype=np.float32)

    quad = np.stack([
        c_pt + u_vec * u0 + v_vec * v0,
        c_pt + u_vec * u1 + v_vec * v0,
        c_pt + u_vec * u1 + v_vec * v1,
        c_pt + u_vec * u0 + v_vec * v1,
    ], axis=0)

    bw = float(widths[best_i])
    bh = float(heights[best_i])
    rect_fill = float(len(xs)) / max(1.0, bw * bh)
    return _order_pts_cw_np(quad), bw, bh, rect_fill


def _sample_rotated_grid_rgb(
    rgb_np: np.ndarray,
    center: np.ndarray,
    u_vec: np.ndarray,
    v_vec: np.ndarray,
    u_coords: np.ndarray,
    v_coords: np.ndarray,
) -> np.ndarray:
    """回転座標系 (u_coords, v_coords) 上のRGBパッチ (Nv, Nu, 3) を抽出する"""
    h, w = rgb_np.shape[:2]
    uu, vv = np.meshgrid(u_coords, v_coords)
    px = np.clip(np.rint(center[0] + uu * u_vec[0] + vv * v_vec[0]).astype(np.int32), 0, w - 1)
    py = np.clip(np.rint(center[1] + uu * u_vec[1] + vv * v_vec[1]).astype(np.int32), 0, h - 1)
    return rgb_np[py, px]


def _has_plate_character_signature(
    rgb_np: np.ndarray,
    norm_quad: np.ndarray,
    require_four_side_isolation: bool = True,
    extra_strict_surround: bool = False,
) -> Tuple[bool, float]:
    """
    候補4頂点が本物のナンバープレートであるかを検証する。
    - 4辺それぞれの独立外枠コントラスト（横に続くコンクリート段差・縁石・白線を排除）
    - ベース板と文字インクの十分な明暗ダイナミックレンジ（薄いシミ・影ムラを排除）
    - 上段(地名330)・下段(・・3 / 99-09)の両方における急峻な文字ストロークエッジの存在
    """
    h, w = rgb_np.shape[:2]
    raw_px = np.column_stack([norm_quad[:, 0] * w, norm_quad[:, 1] * h]).astype(np.float32)
    pts_px = _order_pts_cw_np(raw_px)

    vec_w = 0.5 * ((pts_px[1] - pts_px[0]) + (pts_px[2] - pts_px[3]))
    vec_h = 0.5 * ((pts_px[3] - pts_px[0]) + (pts_px[2] - pts_px[1]))
    pw = float(np.linalg.norm(vec_w))
    ph = float(np.linalg.norm(vec_h))
    if pw < 12.0 or ph < 8.0:
        return False, 0.0

    u_vec = vec_w / pw
    v_vec = np.array([-u_vec[1], u_vec[0]], dtype=np.float32)
    if float(np.dot(v_vec, vec_h)) < 0.0:
        v_vec = -v_vec
    center = np.mean(pts_px, axis=0)

    nu, nv = 84, 44
    u_coords = np.linspace(-pw * 0.92, pw * 0.92, nu, dtype=np.float32)
    v_coords = np.linspace(-ph * 0.66, ph * 0.66, nv, dtype=np.float32)
    patch = _sample_rotated_grid_rgb(rgb_np, center, u_vec, v_vec, u_coords, v_coords).astype(np.float32)
    lum = 0.299 * patch[:, :, 0] + 0.587 * patch[:, :, 1] + 0.114 * patch[:, :, 2]

    # 内側コア領域 (u: -0.42..+0.42*pw, v: -0.40..+0.40*ph)
    cu0, cu1 = int(nu * 0.27), int(nu * 0.73)
    cv0, cv1 = int(nv * 0.20), int(nv * 0.80)
    core_rgb = patch[cv0:cv1, cu0:cu1]
    core_lum = lum[cv0:cv1, cu0:cu1]

    base_lum = float(np.percentile(core_lum, 85))
    dark_ink_lum = float(np.percentile(core_lum, 5))
    dyn_range = base_lum - dark_ink_lum

    min_dyn = 74.0 if extra_strict_surround else 68.0
    if base_lum < 98.0 or dyn_range < min_dyn:
        return False, 0.0

    # 2. 4辺それぞれの広域外側ストリップ独立チェック (椅子の脚影等を挟んで横に続く段差・縁石・白線も確実に排除)
    left_out_med = float(np.median(lum[cv0:cv1, : int(nu * 0.19)]))
    right_out_med = float(np.median(lum[cv0:cv1, int(nu * 0.81) :]))
    top_out_med = float(np.median(lum[:5, cu0:cu1]))
    bot_out_med = float(np.median(lum[-5:, cu0:cu1]))

    if require_four_side_isolation:
        min_side_gap = 38.0 if extra_strict_surround else 32.0
        if (base_lum - left_out_med) < min_side_gap or (base_lum - right_out_med) < min_side_gap:
            return False, 0.0
        max_tb_gap = max(base_lum - top_out_med, base_lum - bot_out_med)
        min_tb_gap = min(base_lum - top_out_med, base_lum - bot_out_med)
        req_min_tb = 30.0 if extra_strict_surround else 18.0
        if max_tb_gap < 36.0 or min_tb_gap < req_min_tb:
            return False, 0.0

    # 3. ベース板ピクセルの色均一性（虹色反射・草木・網目背景の除外）
    bright_mask = core_lum >= np.percentile(core_lum, 58)
    if np.any(bright_mask):
        bg_std = float(np.mean(np.std(core_rgb[bright_mask], axis=0)))
        if bg_std > 24.0:
            return False, 0.0

    # 4. 文字ストローク画素率・上下2段分布・貫通縦影排除チェック
    ink_thr = base_lum - max(28.0, dyn_range * 0.36)
    ink_mask = core_lum < ink_thr
    ink_ratio = float(np.mean(ink_mask))
    if ink_ratio < 0.032 or ink_ratio > 0.38:
        return False, 0.0

    # 椅子の脚や柵の影のようにコア内部を上端から下端まで真っ黒に貫通する縦棒がある候補を排除（左右端のプレート枠線は除外）
    inner_cols = ink_mask[:, 4:-4] if ink_mask.shape[1] > 12 else ink_mask
    if float(np.max(np.mean(inner_cols, axis=0))) > 0.85:
        return False, 0.0

    ch = ink_mask.shape[0]
    mid_r = max(2, int(ch * 0.44))
    top_ink = float(np.mean(ink_mask[:mid_r, :]))
    bot_ink = float(np.mean(ink_mask[mid_r:, :]))
    if top_ink < 0.015 or bot_ink < 0.020:
        return False, 0.0

    # 上段(地名330)と下段(99-09)の間に水平の白地セパレータ隙間が存在すること
    sep_r0, sep_r1 = max(1, int(ch * 0.28)), min(ch - 1, max(2, int(ch * 0.58)))
    if float(np.min(np.mean(ink_mask[sep_r0:sep_r1, :], axis=1))) > 0.36:
        return False, 0.0

    # 5. 隣接画素間の急峻な水平文字エッジ（印刷文字の縦ストロークによるステップ変化）
    step_thr = max(22.0, dyn_range * 0.24)
    sharp_edges = np.abs(np.diff(core_lum, axis=1)) >= step_thr
    top_sharp = float(np.mean(sharp_edges[:mid_r, :]))
    bot_sharp = float(np.mean(sharp_edges[mid_r:, :]))
    if top_sharp < 0.028 or bot_sharp < 0.030:
        return False, 0.0

    side_gap = min(base_lum - left_out_med, base_lum - right_out_med)
    conf_score = min(0.86, 0.65 + min(0.21, max(0.0, side_gap) / 280.0))
    return True, conf_score


def snap_quad_to_plate_surface(
    rgb_np: np.ndarray,
    norm_quad: np.ndarray,
    score: float = 0.75,
    expand_factor: float = 1.055,
    strict_isolation: bool = False,
) -> Tuple[Optional[np.ndarray], bool]:
    """
    候補4頂点 norm_quad (4, 2) [0..1] を検証し、実画像のプレート板1枚の連結領域へ精密スナップ補正する。
    - 膨張前の生プレート色マスクから中心連結成分のみを先に抜き出すため、数ピクセルしか黒隙間がない
      白いフロントバンパーや赤いアクセントラインにも一切漏れず、太字数字 (99-09 等) の端切れや初期傾き誤差も完全解消する。
    """
    h, w = rgb_np.shape[:2]
    raw_px = np.column_stack([norm_quad[:, 0] * w, norm_quad[:, 1] * h]).astype(np.float32)
    pts_px = _order_pts_cw_np(raw_px)
    pts = np.column_stack([pts_px[:, 0] / w, pts_px[:, 1] / h])

    # 入力が対角潰れしている場合は外接矩形ベースで基準寸法を計算
    bbox_w = float(np.max(pts_px[:, 0]) - np.min(pts_px[:, 0]))
    bbox_h = float(np.max(pts_px[:, 1]) - np.min(pts_px[:, 1]))
    well_formed_in = quad_is_well_formed(pts_px)

    if well_formed_in:
        vec_w = 0.5 * ((pts_px[1] - pts_px[0]) + (pts_px[2] - pts_px[3]))
        vec_h = 0.5 * ((pts_px[3] - pts_px[0]) + (pts_px[2] - pts_px[1]))
        pw = float(np.linalg.norm(vec_w))
        ph = float(np.linalg.norm(vec_h))
    else:
        vec_w = np.array([bbox_w, 0.0], dtype=np.float32)
        vec_h = np.array([0.0, bbox_h], dtype=np.float32)
        pw = bbox_w
        ph = bbox_h

    if pw < 10.0 or ph < 6.0:
        return None, False
    aspect = pw / max(1.0, ph)
    if aspect < 0.85 or aspect > 5.8:
        return None, False

    # 1段分のみ細長く囲んでいる場合は2段相当へ仮拡張して文字シグネチャを検証
    check_quad = pts
    if (ph / pw) < 0.43:
        u_tmp = vec_w / pw
        v_tmp = np.array([-u_tmp[1], u_tmp[0]], dtype=np.float32)
        if float(np.dot(v_tmp, vec_h)) < 0.0:
            v_tmp = -v_tmp
        c_tmp = np.mean(pts_px, axis=0)
        hh_tmp = pw * 0.25
        hw_tmp = pw * 0.5
        q_tmp = np.stack([
            c_tmp - u_tmp * hw_tmp - v_tmp * hh_tmp,
            c_tmp + u_tmp * hw_tmp - v_tmp * hh_tmp,
            c_tmp + u_tmp * hw_tmp + v_tmp * hh_tmp,
            c_tmp - u_tmp * hw_tmp + v_tmp * hh_tmp,
        ], axis=0)
        check_quad = np.column_stack([np.clip(q_tmp[:, 0] / w, 0, 1), np.clip(q_tmp[:, 1] / h, 0, 1)])

    # すべての候補で文字シグネチャを検証し、明暗差だけの段差・縁石・ライト・壁面を排除
    if strict_isolation or score < 0.78:
        ok_sig, _ = _has_plate_character_signature(
            rgb_np,
            check_quad,
            require_four_side_isolation=(strict_isolation or score < 0.72),
        )
        if not ok_sig:
            return None, False

    center = np.mean(pts_px, axis=0)
    ref_hw = pw * 0.5
    ref_hh = max(ph * 0.5, pw * 0.26)

    u_init = vec_w / pw
    v_init = np.array([-u_init[1], u_init[0]], dtype=np.float32)
    if float(np.dot(v_init, vec_h)) < 0.0:
        v_init = -v_init
    tilt_deg = abs(math.degrees(math.atan2(float(u_init[1]), float(u_init[0]))))

    snapped_px: Optional[np.ndarray] = None

    # ダッチアングル等の大きな傾き (> 12°) では回転正規化パッチ上でグリル対比スナップを実行
    if tilt_deg > 12.0:
        u_lim = ref_hw * 1.55
        v_lim = ref_hh * 1.65
        sw_r = int(np.clip(round(u_lim * 2.0), 40, 200))
        sh_r = int(np.clip(round(v_lim * 2.0), 30, 150))
        u_coords = np.linspace(-u_lim, u_lim, sw_r, dtype=np.float32)
        v_coords = np.linspace(-v_lim, v_lim, sh_r, dtype=np.float32)
        rot_arr = _sample_rotated_grid_rgb(rgb_np, center, u_init, v_init, u_coords, v_coords).astype(np.float32)
        rot_lum = 0.299 * rot_arr[:, :, 0] + 0.587 * rot_arr[:, :, 1] + 0.114 * rot_arr[:, :, 2]

        cx_r = (sw_r - 1) * 0.5
        cy_r = (sh_r - 1) * 0.5
        hw_r = ref_hw * (sw_r / max(1.0, u_lim * 2.0))
        hh_r = ref_hh * (sh_r / max(1.0, v_lim * 2.0))
        ix0_r = max(0, int(round(cx_r - hw_r * 0.62)))
        ix1_r = min(sw_r, max(ix0_r + 2, int(round(cx_r + hw_r * 0.62))))
        iy0_r = max(0, int(round(cy_r - hh_r * 0.58)))
        iy1_r = min(sh_r, max(iy0_r + 2, int(round(cy_r + hh_r * 0.58))))

        in_lum_r = rot_lum[iy0_r:iy1_r, ix0_r:ix1_r]
        if in_lum_r.size < 16:
            return None, False
        dyn_r = float(np.percentile(in_lum_r, 85) - np.percentile(in_lum_r, 4))
        if dyn_r < 50.0 or float(np.std(in_lum_r)) < 11.0:
            return None, False

        p82_r = np.percentile(rot_arr[iy0_r:iy1_r, ix0_r:ix1_r].reshape(-1, 3), 82, axis=0)
        plum_r = float(0.299 * p82_r[0] + 0.587 * p82_r[1] + 0.114 * p82_r[2])
        prof_q = _snap_by_side_grille_contrast(rot_lum, cx_r, cy_r, hw_r, hh_r, plum_r)
        if prof_q is not None:
            du = (prof_q[:, 0] / max(1.0, sw_r - 1) - 0.5) * (u_lim * 2.0)
            dv = (prof_q[:, 1] / max(1.0, sh_r - 1) - 0.5) * (v_lim * 2.0)
            snapped_px = (
                center[None, :]
                + du[:, None] * u_init[None, :]
                + dv[:, None] * v_init[None, :]
            )

    # 通常構図 (傾き <= 12°): AIの初期傾き誤差に引きずられないよう、元画像の水平・垂直軸 (Axis-Aligned ROI) で周辺を切り出す
    roi_pad_x = ref_hw * 1.55
    roi_pad_y = ref_hh * 1.65
    rx0 = max(0, int(np.floor(center[0] - roi_pad_x)))
    ry0 = max(0, int(np.floor(center[1] - roi_pad_y)))
    rx1 = min(w, int(np.ceil(center[0] + roi_pad_x)))
    ry1 = min(h, int(np.ceil(center[1] + roi_pad_y)))
    rw = rx1 - rx0
    rh = ry1 - ry0

    if snapped_px is None and tilt_deg <= 12.0 and rw >= 16 and rh >= 12:
        # 3〜4px の細い黒ナンバーフレームが潰れないよう横最大 240px の高解像度を維持
        scale_r = min(1.0, 240.0 / rw)
        if scale_r < 0.999:
            sw = max(32, int(round(rw * scale_r)))
            sh = max(24, int(round(rh * scale_r)))
            roi_pil = Image.fromarray(rgb_np[ry0:ry1, rx0:rx1]).resize((sw, sh), Image.Resampling.BILINEAR)
            roi_arr = np.asarray(roi_pil, dtype=np.float32)
        else:
            sw, sh = rw, rh
            roi_arr = rgb_np[ry0:ry1, rx0:rx1].astype(np.float32)

        roi_lum = 0.299 * roi_arr[:, :, 0] + 0.587 * roi_arr[:, :, 1] + 0.114 * roi_arr[:, :, 2]

        cx_s = (center[0] - rx0) * (sw / rw)
        cy_s = (center[1] - ry0) * (sh / rh)
        hw_s = ref_hw * (sw / rw)
        hh_s = ref_hh * (sh / rh)

        ix0 = max(0, int(round(cx_s - hw_s * 0.62)))
        ix1 = min(sw, max(ix0 + 2, int(round(cx_s + hw_s * 0.62))))
        iy0 = max(0, int(round(cy_s - hh_s * 0.58)))
        iy1 = min(sh, max(iy0 + 2, int(round(cy_s + hh_s * 0.58))))

        inner_pixels = roi_arr[iy0:iy1, ix0:ix1].reshape(-1, 3)
        inner_lum = roi_lum[iy0:iy1, ix0:ix1]
        # 高スコア候補でも最低限の文字コントラスト (p85 - p04 >= 50) が無ければ無地誤検出として除外
        dyn_inner = float(np.percentile(inner_lum, 85) - np.percentile(inner_lum, 4))
        if dyn_inner < 50.0 or float(np.std(inner_lum)) < 11.0:
            return None, False

        # 太字の黒数字 (99-09 等) に引っ張られずベース板の色を拾うため 82パーセンタイルを使用
        p82_rgb = np.percentile(inner_pixels, 82, axis=0)
        plate_lum = float(0.299 * p82_rgb[0] + 0.587 * p82_rgb[1] + 0.114 * p82_rgb[2])
        # ROI外周に白いバンパーが含まれていても影響を受けないよう 15パーセンタイル輝度を暗枠基準にする
        dark_ref = float(np.percentile(roi_lum, 15))

        if plate_lum >= 88.0 and (plate_lum - dark_ref) >= 26.0:
            # ルートA: 左右グリル対比プロファイルスナップ（白バンパーに上縁が隙間0pxで密着している白ボディ車でも正確に分離）
            prof_quad_local = _snap_by_side_grille_contrast(roi_lum, cx_s, cy_s, hw_s, hh_s, plate_lum)
            if prof_quad_local is not None:
                snapped_px = np.column_stack([
                    rx0 + (prof_quad_local[:, 0] + 0.5) * (rw / sw),
                    ry0 + (prof_quad_local[:, 1] + 0.5) * (rh / sh),
                ])
            else:
                # ルートB: 4辺黒フレーム内の最大面積プレート連結成分スナップ
                lum_thr = dark_ref + 0.48 * (plate_lum - dark_ref)
                color_dist = np.max(np.abs(roi_arr - p82_rgb[None, None, :]), axis=2)
                col_thr = max(44.0, (plate_lum - dark_ref) * 0.56)
                base_plate = (roi_lum >= lum_thr) & (color_dist <= col_thr)

                comp_y, comp_x = _extract_best_plate_component(base_plate, ix0, ix1, iy0, iy1)
                if comp_y.size >= 24:
                    world_x = rx0 + (comp_x + 0.5) * (rw / sw)
                    world_y = ry0 + (comp_y + 0.5) * (rh / sh)
                    q_fit, fit_w, fit_h, fit_fill = _fit_min_area_quad(world_x, world_y)
                    fit_aspect = fit_w / max(1.0, fit_h)
                    if (
                        fit_fill >= 0.48
                        and fit_w >= pw * 0.72
                        and fit_h >= ph * 0.68
                        and 1.32 <= fit_aspect <= 3.5
                    ):
                        snapped_px = q_fit

    if snapped_px is None:
        u_vec = vec_w / pw
        # 正面に近い（傾き5.5度未満）のにAIの癖で微傾きしている場合は水平へ整列
        if abs(float(u_vec[1])) < 0.096:
            u_vec = np.array([1.0 if u_vec[0] >= 0 else -1.0, 0.0], dtype=np.float32)
        v_vec = np.array([-u_vec[1], u_vec[0]], dtype=np.float32)
        if float(np.dot(v_vec, vec_h)) < 0.0:
            v_vec = -v_vec
        target_hh = max(ph * 0.5, pw * 0.25) if (ph / pw) < 0.43 else ph * 0.5
        snapped_px = np.stack([
            center - u_vec * ref_hw - v_vec * target_hh,
            center + u_vec * ref_hw - v_vec * target_hh,
            center + u_vec * ref_hw + v_vec * target_hh,
            center - u_vec * ref_hw + v_vec * target_hh,
        ], axis=0)

    c_final = np.mean(snapped_px, axis=0, keepdims=True)
    expanded_px = _order_pts_cw_np(c_final + (snapped_px - c_final) * expand_factor)

    norm_out = np.column_stack([
        np.clip(expanded_px[:, 0] / w, 0.0, 1.0),
        np.clip(expanded_px[:, 1] / h, 0.0, 1.0),
    ])
    return norm_out, True


def detect_japanese_plate_regions(
    rgb: Image.Image, rgb_np: Optional[np.ndarray] = None
) -> List[Tuple[np.ndarray, float]]:
    """
    グリル・バンパー開口部内の明色/黄色プレート板候補を幾何＋4辺独立性＋2段文字エッジ検証で抽出する。
    1桁・2桁の希望ナンバー (・・・3 等) や複数車両の中遠景ナンバーを誤検出なく補完する。
    """
    orig_w, orig_h = rgb.size
    if orig_w < 120 or orig_h < 90:
        return []

    if rgb_np is None:
        rgb_np = np.asarray(rgb, dtype=np.uint8)

    work_w = min(800, orig_w)
    work_h = max(60, int(round(orig_h * (work_w / orig_w))))
    small = rgb.resize((work_w, work_h), Image.Resampling.BILINEAR)
    sm_np = np.asarray(small, dtype=np.float32)

    lum_np = 0.299 * sm_np[:, :, 0] + 0.587 * sm_np[:, :, 1] + 0.114 * sm_np[:, :, 2]
    lum_img = Image.fromarray(np.clip(lum_np, 0, 255).astype(np.uint8), mode="L")
    yel_boost = np.clip((sm_np[:, :, 0] + sm_np[:, :, 1]) * 0.5 - sm_np[:, :, 2], 0.0, 120.0) * 0.35

    # ダッチアングルで左奥・右奥が高い位置に写る車両にも対応 (y >= 0.10)
    y_min_scan = int(work_h * 0.10)
    y_max_scan = int(work_h * 0.96)

    candidates: List[Tuple[np.ndarray, float]] = []
    blur_radii = (max(7, work_w // 38), max(22, work_w // 11))
    thresholds = (25.0, 40.0)

    for rad in blur_radii:
        bg_np = np.asarray(lum_img.filter(ImageFilter.BoxBlur(radius=rad)), dtype=np.float32)
        tophat = (lum_np + yel_boost) - bg_np

        for thr in thresholds:
            fg = (tophat >= thr) & (lum_np >= 96.0)
            fg[:y_min_scan, :] = False
            fg[y_max_scan:, :] = False

            closed = _erode3_bool(_dilate3_bool(_dilate3_bool(fg)))

            for ys, xs in _extract_blobs_grid(closed, min_pixels=20, max_pixels=int(work_w * work_h * 0.07)):
                bx0, bx1 = float(np.min(xs)), float(np.max(xs))
                by0, by1 = float(np.min(ys)), float(np.max(ys))
                bw_box = bx1 - bx0 + 1.0
                bh_box = by1 - by0 + 1.0

                if bw_box < work_w * 0.016 or bw_box > work_w * 0.36:
                    continue
                if bh_box < work_h * 0.014 or bh_box > work_h * 0.28:
                    continue
                # 30°傾いたプレートの軸平行外接箱は正方形近くになるため 0.72 から許容し、直後の回転後比率で厳密判定する
                rough_aspect = bw_box / max(1.0, bh_box)
                if rough_aspect < 0.72 or rough_aspect > 2.95:
                    continue

                quad_sm, rw, rh, rect_fill = _fit_min_area_quad(xs, ys)
                # 傾きにより短辺・長辺が入れ替わっていた場合は正規化
                if rw < rh:
                    rw, rh = rh, rw
                rot_aspect = rw / max(1.0, rh)
                if rot_aspect < 1.05 or rot_aspect > 2.55 or rect_fill < 0.72:
                    continue

                cy_norm = float(np.mean(ys)) / work_h
                # 斜めアングル圧縮比率 (<1.38)・画面上部 (<0.24)・極小遠景 (<0.025) は4辺黒グリル条件を一段厳格化して誤検出を防ぐ
                needs_extra_strict = (
                    rot_aspect < 1.38 or cy_norm < 0.24 or bw_box < work_w * 0.025
                )

                norm_q = np.column_stack([
                    np.clip(quad_sm[:, 0] / work_w, 0.0, 1.0),
                    np.clip(quad_sm[:, 1] / work_h, 0.0, 1.0),
                ])

                ok, v_score = _has_plate_character_signature(
                    rgb_np,
                    norm_q,
                    require_four_side_isolation=True,
                    extra_strict_surround=needs_extra_strict,
                )
                if ok:
                    candidates.append((norm_q, v_score))

    return candidates
