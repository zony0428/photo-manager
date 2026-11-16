"""
プライバシーマスク用ローカルAI自動検出モジュール (YuNet 顔検出 + LPD-YuNet ナンバープレート4頂点検出)
追加パッケージ不要・onnxruntime (CPU) + numpy + Pillow のみで人物の顔と車両ナンバープレートの四つ角を推定する。
"""

from itertools import product
import logging
import math
import threading
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageOps

from .plate_refiner import (
    _order_pts_cw_np,
    detect_japanese_plate_regions,
    quad_is_well_formed,
    snap_quad_to_plate_surface,
)

logger = logging.getLogger("photo_manager.ai")

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
PRIVACY_MODEL_DIR = PROJECT_ROOT / "models" / "privacy"

FACE_MODEL_FILENAME = "face_detection_yunet_2023mar.onnx"
PLATE_MODEL_FILENAME = "license_plate_detection_lpd_yunet_2023mar.onnx"

FACE_MODEL_PATH = PRIVACY_MODEL_DIR / FACE_MODEL_FILENAME
PLATE_MODEL_PATH = PRIVACY_MODEL_DIR / PLATE_MODEL_FILENAME

FACE_MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
PLATE_MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "license_plate_detection_yunet/license_plate_detection_lpd_yunet_2023mar.onnx"
)


def _nms_boxes(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float = 0.35) -> List[int]:
    """矩形配列 (N, 4) [x1, y1, x2, y2] に対する標準 Non-Maximum Suppression"""
    if len(boxes) == 0:
        return []
    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 2]
    y2 = boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: List[int] = []

    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])

        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[i] + areas[rest] - inter + 1e-7
        iou = inter / union
        order = rest[iou <= iou_threshold]
    return keep


def _order_quad_clockwise(pts: np.ndarray, img_w: int = 1, img_h: int = 1) -> List[Dict[str, float]]:
    """4頂点 (4, 2) を実ピクセル空間で左上(TL) → 右上(TR) → 右下(BR) → 左下(BL) の時計回り順へ正規化する"""
    pts_px = np.column_stack([pts[:, 0] * max(1, img_w), pts[:, 1] * max(1, img_h)]).astype(np.float32)
    ordered_px = _order_pts_cw_np(pts_px)
    return [
        {
            "x": round(float(np.clip(p[0] / max(1, img_w), 0.0, 1.0)), 5),
            "y": round(float(np.clip(p[1] / max(1, img_h), 0.0, 1.0)), 5),
        }
        for p in ordered_px
    ]


class PrivacyDetector:
    """YuNet (顔) および LPD-YuNet (4頂点ナンバープレート) によるローカルプライバシー検出器"""

    _instance: Optional["PrivacyDetector"] = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._face_session = None
        self._plate_session = None
        self._plate_priors: Optional[np.ndarray] = None
        self._init_lock = threading.Lock()
        self._loaded = False

    @classmethod
    def get_instance(cls) -> "PrivacyDetector":
        """シングルトンインスタンスを返す"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def ensure_models(self) -> Tuple[bool, bool]:
        """モデルファイルの存在を確認し、未配置かつ通信可能な場合は公式リポジトリから取得する"""
        PRIVACY_MODEL_DIR.mkdir(parents=True, exist_ok=True)
        for path, url, label in (
            (FACE_MODEL_PATH, FACE_MODEL_URL, "YuNet face model"),
            (PLATE_MODEL_PATH, PLATE_MODEL_URL, "LPD-YuNet plate model"),
        ):
            if not path.exists() or path.stat().st_size < 10_000:
                try:
                    logger.info(f"Downloading {label} to {path}...")
                    urllib.request.urlretrieve(url, path)
                except Exception as e:
                    logger.warning(f"{label} の自動取得をスキップしました (オフライン動作継続): {e}")
        return (
            FACE_MODEL_PATH.exists() and FACE_MODEL_PATH.stat().st_size >= 10_000,
            PLATE_MODEL_PATH.exists() and PLATE_MODEL_PATH.stat().st_size >= 10_000,
        )

    def _build_lpd_priors(self, width: int = 320, height: int = 240) -> np.ndarray:
        """LPD-YuNet 固定入力 (320x240) 用の Prior アンカー配列 (4385, 4) を生成する"""
        min_sizes_groups = [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]]
        steps = [8, 16, 32, 64]

        fm2 = [int(int((height + 1) / 2) / 2), int(int((width + 1) / 2) / 2)]
        fm3 = [int(fm2[0] / 2), int(fm2[1] / 2)]
        fm4 = [int(fm3[0] / 2), int(fm3[1] / 2)]
        fm5 = [int(fm4[0] / 2), int(fm4[1] / 2)]
        fm6 = [int(fm5[0] / 2), int(fm5[1] / 2)]
        feature_maps = [fm3, fm4, fm5, fm6]

        priors: List[List[float]] = []
        for k, fm in enumerate(feature_maps):
            ms_list = min_sizes_groups[k]
            step = steps[k]
            for i, j in product(range(fm[0]), range(fm[1])):
                for ms in ms_list:
                    priors.append([
                        (j + 0.5) * step / width,
                        (i + 0.5) * step / height,
                        ms / width,
                        ms / height,
                    ])
        return np.array(priors, dtype=np.float32)

    def load(self) -> bool:
        """ONNX Runtime CPUセッションを遅延初期化する"""
        if self._loaded:
            return bool(self._face_session or self._plate_session)

        with self._init_lock:
            if self._loaded:
                return bool(self._face_session or self._plate_session)

            has_face, has_plate = self.ensure_models()
            try:
                import onnxruntime as ort

                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 2
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

                if has_face:
                    self._face_session = ort.InferenceSession(
                        str(FACE_MODEL_PATH), sess_options=opts, providers=["CPUExecutionProvider"]
                    )
                if has_plate:
                    self._plate_session = ort.InferenceSession(
                        str(PLATE_MODEL_PATH), sess_options=opts, providers=["CPUExecutionProvider"]
                    )
                    self._plate_priors = self._build_lpd_priors(320, 240)

                self._loaded = True
            except Exception as e:
                logger.error(f"PrivacyDetector のロードに失敗しました: {e}")
                self._loaded = True
            return bool(self._face_session or self._plate_session)

    def _run_yunet_640(self, rgb_crop: Image.Image, score_thresh: float = 0.58) -> List[Tuple[float, float, float, float, float]]:
        """
        任意サイズのPIL画像を 640x640 レターボックスへ収めて YuNet 推論を実行し、
        rgb_crop 内の正規化矩形 (x1, y1, x2, y2, score) リストを返す。
        """
        if self._face_session is None:
            return []

        cw, ch = rgb_crop.size
        if cw < 16 or ch < 16:
            return []

        scale = min(640.0 / cw, 640.0 / ch)
        nw = max(1, int(round(cw * scale)))
        nh = max(1, int(round(ch * scale)))
        resized = rgb_crop.resize((nw, nh), Image.Resampling.BILINEAR)

        canvas = np.zeros((640, 640, 3), dtype=np.float32)
        arr_rgb = np.asarray(resized, dtype=np.float32)
        # YuNet は BGR 0..255 入力
        canvas[:nh, :nw, :] = arr_rgb[:, :, ::-1]
        inp = np.transpose(canvas, (2, 0, 1))[np.newaxis, ...]

        in_name = self._face_session.get_inputs()[0].name
        out_names = [o.name for o in self._face_session.get_outputs()]
        raw_outs = self._face_session.run(out_names, {in_name: inp})
        out_map = dict(zip(out_names, raw_outs))

        strides = (8, 16, 32)
        candidates: List[Tuple[float, float, float, float, float]] = []

        for s in strides:
            cls_arr = np.clip(out_map[f"cls_{s}"].reshape(-1), 0.0, 1.0)
            obj_arr = np.clip(out_map[f"obj_{s}"].reshape(-1), 0.0, 1.0)
            scores = np.sqrt(cls_arr * obj_arr)
            valid_idx = np.where(scores >= score_thresh)[0]
            if valid_idx.size == 0:
                continue

            cols = 640 // s
            bbox_arr = out_map[f"bbox_{s}"].reshape(-1, 4)[valid_idx]
            sel_scores = scores[valid_idx]
            r_idx = valid_idx // cols
            c_idx = valid_idx % cols

            cx = (c_idx + bbox_arr[:, 0]) * s
            cy = (r_idx + bbox_arr[:, 1]) * s
            bw = np.exp(np.clip(bbox_arr[:, 2], -5.0, 5.0)) * s
            bh = np.exp(np.clip(bbox_arr[:, 3], -5.0, 5.0)) * s

            for k in range(len(valid_idx)):
                x1 = (cx[k] - bw[k] * 0.5) / nw
                y1 = (cy[k] - bh[k] * 0.5) / nh
                x2 = (cx[k] + bw[k] * 0.5) / nw
                y2 = (cy[k] + bh[k] * 0.5) / nh
                if x2 <= 0.02 or y2 <= 0.02 or x1 >= 0.98 or y1 >= 0.98:
                    continue
                candidates.append((
                    float(np.clip(x1, 0.0, 1.0)),
                    float(np.clip(y1, 0.0, 1.0)),
                    float(np.clip(x2, 0.0, 1.0)),
                    float(np.clip(y2, 0.0, 1.0)),
                    float(sel_scores[k]),
                ))
        return candidates

    def detect_faces(self, img: Image.Image, score_thresh: float = 0.58) -> List[Dict[str, Any]]:
        """人物の顔を検出し、モヤスタンプ用の正規化座標 [{x, y, r, score}] を返す"""
        self.load()
        if self._face_session is None:
            return []

        rgb = img.convert("RGB")
        w, h = rgb.size
        long_edge = max(w, h)

        all_boxes: List[List[float]] = []
        all_scores: List[float] = []

        # 1. 全体スキャン
        for x1, y1, x2, y2, sc in self._run_yunet_640(rgb, score_thresh=score_thresh):
            all_boxes.append([x1 * w, y1 * h, x2 * w, y2 * h])
            all_scores.append(sc)

        # 2. 高解像度写真では小さな通行人の拾い漏れを防ぐため左右2分割オーバーラップタイルも走査
        if long_edge >= 1200:
            tiles = (
                (0.0, 0.0, 0.62, 1.0),
                (0.38, 0.0, 1.0, 1.0),
            )
            for tx1, ty1, tx2, ty2 in tiles:
                px1, py1 = int(w * tx1), int(h * ty1)
                px2, py2 = int(w * tx2), int(h * ty2)
                sub = rgb.crop((px1, py1, px2, py2))
                sw, sh = sub.size
                for bx1, by1, bx2, by2, sc in self._run_yunet_640(sub, score_thresh=score_thresh + 0.04):
                    all_boxes.append([px1 + bx1 * sw, py1 + by1 * sh, px1 + bx2 * sw, py1 + by2 * sh])
                    all_scores.append(sc)

        if not all_boxes:
            return []

        boxes_np = np.array(all_boxes, dtype=np.float32)
        scores_np = np.array(all_scores, dtype=np.float32)
        keep = _nms_boxes(boxes_np, scores_np, iou_threshold=0.35)

        results: List[Dict[str, Any]] = []
        for idx in keep[:24]:
            bx1, by1, bx2, by2 = boxes_np[idx]
            cx = ((bx1 + bx2) * 0.5) / w
            cy = ((by1 + by2) * 0.5) / h
            # 顔全体と輪郭が100%遮蔽コア内へ確実に収まるようスタンプ半径を広め (×0.74) に設定
            radius = (max(bx2 - bx1, by2 - by1) * 0.74) / long_edge
            radius = float(np.clip(radius, 0.018, 0.35))
            results.append({
                "x": round(float(np.clip(cx, 0.0, 1.0)), 5),
                "y": round(float(np.clip(cy, 0.0, 1.0)), 5),
                "r": round(radius, 5),
                "style": "frosted",
                "strength": 0.92,
                "score": round(float(scores_np[idx]), 3),
            })
        return results

    def _run_lpd_single_320x240(
        self,
        rgb_crop: Image.Image,
        conf_thresh: float = 0.68,
        reject_border_clipped: bool = False,
    ) -> List[Tuple[np.ndarray, float]]:
        """
        任意のクロップ画像を 320x240 へリサイズして LPD-YuNet に通し、
        正規化4頂点 (4, 2) [0..1] と信頼度スコアのリストを返す。
        """
        if self._plate_session is None or self._plate_priors is None:
            return []

        resized = rgb_crop.resize((320, 240), Image.Resampling.BILINEAR)
        arr_bgr = np.asarray(resized, dtype=np.float32)[:, :, ::-1]
        inp = np.transpose(arr_bgr, (2, 0, 1))[np.newaxis, ...]

        in_name = self._plate_session.get_inputs()[0].name
        loc, conf, iou = self._plate_session.run(["loc", "conf", "iou"], {in_name: inp})

        cls_scores = np.clip(conf[:, 1], 0.0, 1.0)
        iou_scores = np.clip(iou[:, 0], 0.0, 1.0)
        scores = np.sqrt(cls_scores * iou_scores)

        valid_idx = np.where(scores >= conf_thresh)[0]
        if valid_idx.size == 0:
            return []

        priors = self._plate_priors[valid_idx]
        loc_v = loc[valid_idx]
        var0 = 0.1

        # LPD-YuNet の 4頂点デコード (正規化 0..1 空間)
        c1 = priors[:, 0:2] + loc_v[:, 4:6] * var0 * priors[:, 2:4]
        c2 = priors[:, 0:2] + loc_v[:, 6:8] * var0 * priors[:, 2:4]
        c3 = priors[:, 0:2] + loc_v[:, 10:12] * var0 * priors[:, 2:4]
        c4 = priors[:, 0:2] + loc_v[:, 12:14] * var0 * priors[:, 2:4]

        out_list: List[Tuple[np.ndarray, float]] = []
        for k in range(len(valid_idx)):
            quad = np.stack([c1[k], c2[k], c3[k], c4[k]], axis=0)
            min_qx, max_qx = float(np.min(quad[:, 0])), float(np.max(quad[:, 0]))
            min_qy, max_qy = float(np.min(quad[:, 1])), float(np.max(quad[:, 1]))
            bw = max_qx - min_qx
            bh = max_qy - min_qy
            if bw < 0.015 or bh < 0.010 or bw > 0.85 or bh > 0.65:
                continue
            # 部分タイル境界で真っ二つに切断された不完全候補を除外（隣接オーバーラップ窓で全体が検出される）
            if reject_border_clipped and (
                min_qx < 0.015 or max_qx > 0.985 or min_qy < 0.015 or max_qy > 0.985
            ):
                continue
            # 対角潰れやねじれを起こしたデコード不良アンカーを除外
            quad_px_320 = np.column_stack([quad[:, 0] * 320.0, quad[:, 1] * 240.0])
            if not quad_is_well_formed(quad_px_320, min_sin_angle=0.58, min_opp_ratio=0.56):
                continue
            out_list.append((quad, float(scores[valid_idx[k]])))
        return out_list

    def detect_plates(self, img: Image.Image, conf_thresh: float = 0.48) -> List[Dict[str, Any]]:
        """
        車両ナンバープレートの4頂点枠を検出し、[{pts: [{x,y}x4], style, color, feather, score}] を返す。
        1) LPD-YuNet 高密度マルチスケール＋暗部オートコントラスト走査
        2) 日本の2段ナンバー・希望ナンバー (・・・3 等) 向け幾何＋2段文字ストローク補完検出
        3) 実画像のプレート板4辺への精密エッジスナップ補正
        を組み合わせて複数車両・日陰グリル内・斜め構図を高精度にカバーする。
        """
        self.load()
        rgb = img.convert("RGB")
        w, h = rgb.size
        rgb_np = np.asarray(rgb, dtype=np.uint8)

        # (quad, score, strict_isolation)
        raw_candidates: List[Tuple[np.ndarray, float, bool]] = []

        if self._plate_session is not None:
            # (x1_norm, y1_norm, x2_norm, y2_norm, thresh, use_autocontrast)
            windows = [
                # 全体・準全体 (近景の大型単一車両向け)
                (0.00, 0.00, 1.00, 1.00, conf_thresh, False),
                (0.04, 0.12, 0.96, 0.96, conf_thresh, True),
                # 中スケール3列オーバーラップ (2〜3台並び・日本の1:2プレートを横長化する縦広窓)
                (0.00, 0.22, 0.50, 0.92, conf_thresh + 0.02, True),
                (0.25, 0.22, 0.75, 0.92, conf_thresh + 0.02, True),
                (0.50, 0.22, 1.00, 0.92, conf_thresh + 0.02, True),
                # 細密スケール4列オーバーラップ (複数台オフ会・中遠景の小さなプレート向け)
                (0.00, 0.30, 0.36, 0.86, conf_thresh + 0.04, True),
                (0.21, 0.30, 0.57, 0.86, conf_thresh + 0.04, True),
                (0.43, 0.30, 0.79, 0.86, conf_thresh + 0.04, True),
                (0.64, 0.30, 1.00, 0.86, conf_thresh + 0.04, True),
                # ローアングル・下部寄り2列窓
                (0.04, 0.46, 0.54, 0.98, conf_thresh + 0.04, True),
                (0.46, 0.46, 0.96, 0.98, conf_thresh + 0.04, True),
            ]

            for wx1, wy1, wx2, wy2, th, use_ac in windows:
                px1, py1 = int(round(w * wx1)), int(round(h * wy1))
                px2, py2 = int(round(w * wx2)), int(round(h * wy2))
                if px2 - px1 < 64 or py2 - py1 < 48:
                    continue
                is_sub_window = (wx2 - wx1) < 0.90
                is_small_tile = (wx2 - wx1) < 0.48
                sub = rgb.crop((px1, py1, px2, py2))

                for local_quad, sc in self._run_lpd_single_320x240(
                    sub, conf_thresh=th, reject_border_clipped=is_sub_window
                ):
                    g_quad = np.zeros_like(local_quad)
                    g_quad[:, 0] = wx1 + local_quad[:, 0] * (wx2 - wx1)
                    g_quad[:, 1] = wy1 + local_quad[:, 1] * (wy2 - wy1)
                    raw_candidates.append((g_quad, sc, is_small_tile))

                if use_ac:
                    try:
                        sub_ac = ImageOps.autocontrast(sub, cutoff=1)
                        for local_quad, sc in self._run_lpd_single_320x240(
                            sub_ac, conf_thresh=th + 0.03, reject_border_clipped=is_sub_window
                        ):
                            g_quad = np.zeros_like(local_quad)
                            g_quad[:, 0] = wx1 + local_quad[:, 0] * (wx2 - wx1)
                            g_quad[:, 1] = wy1 + local_quad[:, 1] * (wy2 - wy1)
                            # オートコントラスト強調候補は段差・影の誤検出を防ぐため4辺独立検証を通す
                            raw_candidates.append((g_quad, sc, True))
                    except Exception as e:
                        logger.debug(f"プレート検出オートコントラストスキップ: {e}")

            # ダッチアングル（カメラを斜め20°〜38°傾けた構図）向け ±28° 回転補完スキャン
            rot_scale = min(1.0, 1120.0 / max(w, h))
            bw_s = max(120, int(round(w * rot_scale)))
            bh_s = max(90, int(round(h * rot_scale)))
            base_small = rgb.resize((bw_s, bh_s), Image.Resampling.BILINEAR) if rot_scale < 0.999 else rgb
            rot_tiles = (
                (0.05, 0.12, 0.95, 0.92, conf_thresh + 0.02),
                (0.02, 0.18, 0.46, 0.86, conf_thresh + 0.04),
                (0.27, 0.18, 0.73, 0.86, conf_thresh + 0.04),
                (0.54, 0.18, 0.98, 0.86, conf_thresh + 0.04),
            )
            for rot_deg in (28.0, -28.0):
                rot_im = base_small.rotate(
                    rot_deg, resample=Image.Resampling.BILINEAR, expand=True, fillcolor=(20, 20, 20)
                )
                rw_e, rh_e = rot_im.size
                rad = math.radians(rot_deg)
                cos_a, sin_a = math.cos(rad), math.sin(rad)
                cx_s0, cy_s0 = bw_s * 0.5, bh_s * 0.5
                rcx_e, rcy_e = rw_e * 0.5, rh_e * 0.5

                for rwx1, rwy1, rwx2, rwy2, rth in rot_tiles:
                    rpx1, rpy1 = int(round(rw_e * rwx1)), int(round(rh_e * rwy1))
                    rpx2, rpy2 = int(round(rw_e * rwx2)), int(round(rh_e * rwy2))
                    if rpx2 - rpx1 < 64 or rpy2 - rpy1 < 48:
                        continue
                    rsub = rot_im.crop((rpx1, rpy1, rpx2, rpy2))
                    rhits = self._run_lpd_single_320x240(
                        rsub, conf_thresh=rth, reject_border_clipped=((rwx2 - rwx1) < 0.85)
                    )
                    try:
                        rsub_ac = ImageOps.autocontrast(rsub, cutoff=1)
                        rhits.extend(
                            self._run_lpd_single_320x240(
                                rsub_ac, conf_thresh=rth + 0.03, reject_border_clipped=((rwx2 - rwx1) < 0.85)
                            )
                        )
                    except Exception as e:
                        logger.debug(f"回転プレート検出オートコントラストスキップ: {e}")

                    for lq, lsc in rhits:
                        rx_px = (rwx1 + lq[:, 0] * (rwx2 - rwx1)) * rw_e
                        ry_px = (rwy1 + lq[:, 1] * (rwy2 - rwy1)) * rh_e
                        dx = rx_px - rcx_e
                        dy = ry_px - rcy_e
                        ox_norm = (cx_s0 + dx * cos_a - dy * sin_a) / bw_s
                        oy_norm = (cy_s0 + dx * sin_a + dy * cos_a) / bh_s
                        if np.any(ox_norm < -0.02) or np.any(ox_norm > 1.02) or np.any(oy_norm < -0.02) or np.any(oy_norm > 1.02):
                            continue
                        orig_q = np.column_stack([np.clip(ox_norm, 0.0, 1.0), np.clip(oy_norm, 0.0, 1.0)]).astype(np.float32)
                        raw_candidates.append((orig_q, lsc, True))

        # 第2エンジン: 日本の2段プレート・希望ナンバー (・・・3 等) の幾何＋2段文字ストローク補完
        try:
            for jp_quad, jp_sc in detect_japanese_plate_regions(rgb, rgb_np=rgb_np):
                raw_candidates.append((jp_quad, jp_sc, True))
        except Exception as e:
            logger.debug(f"日本プレート補完検出スキップ: {e}")

        if not raw_candidates:
            return []

        quads_global: List[np.ndarray] = []
        bboxes_px: List[List[float]] = []
        scores_all: List[float] = []

        # 各候補をプレート板の実4辺へスナップ補正してからNMS統合（部分検出と全体検出を綺麗に1枠へ集約）
        for cand_quad, sc, strict_iso in raw_candidates:
            snapped_quad, is_valid = snap_quad_to_plate_surface(
                rgb_np,
                cand_quad,
                score=sc,
                expand_factor=1.055,
                strict_isolation=strict_iso,
            )
            if not is_valid or snapped_quad is None:
                continue

            min_x = float(np.min(snapped_quad[:, 0])) * w
            min_y = float(np.min(snapped_quad[:, 1])) * h
            max_x = float(np.max(snapped_quad[:, 0])) * w
            max_y = float(np.max(snapped_quad[:, 1])) * h
            if (max_x - min_x) < 10.0 or (max_y - min_y) < 6.0:
                continue

            quads_global.append(snapped_quad)
            bboxes_px.append([min_x, min_y, max_x, max_y])
            scores_all.append(sc)

        if not quads_global:
            return []

        boxes_np = np.array(bboxes_px, dtype=np.float32)
        scores_np = np.array(scores_all, dtype=np.float32)
        keep = _nms_boxes(boxes_np, scores_np, iou_threshold=0.32)

        results: List[Dict[str, Any]] = []
        for idx in keep[:16]:
            quad = quads_global[idx]
            ordered_pts = _order_quad_clockwise(quad, img_w=w, img_h=h)
            auto_color = self._sample_plate_fill_color(rgb, ordered_pts)
            results.append({
                "pts": ordered_pts,
                "style": "solid",
                "color": auto_color,
                "feather": 0.45,
                "score": round(float(scores_np[idx]), 3),
            })
        return results

    @staticmethod
    def _sample_plate_fill_color(rgb: Image.Image, pts: List[Dict[str, float]]) -> str:
        """検出されたプレート内部の中央値カラーから自然な塗りつぶし初期色を決定する"""
        try:
            w, h = rgb.size
            xs = [p["x"] * w for p in pts]
            ys = [p["y"] * h for p in pts]
            cx1 = max(0, int(min(xs)))
            cy1 = max(0, int(min(ys)))
            cx2 = min(w, int(max(xs)) + 1)
            cy2 = min(h, int(max(ys)) + 1)
            if cx2 - cx1 < 4 or cy2 - cy1 < 4:
                return "#F4F6F9"
            patch = np.asarray(rgb.crop((cx1, cy1, cx2, cy2)), dtype=np.float32)
            # 文字の濃色を避けてベース板の色を拾うため 75パーセンタイル値を参照
            r_val, g_val, b_val = np.percentile(patch.reshape(-1, 3), 75, axis=0)
            # 軽自動車の黄色ナンバー判定
            if r_val > 165 and g_val > 140 and b_val < 105 and (r_val - b_val) > 70:
                return "#EAB308"
            # 事業用緑ナンバー・ダークプレート判定
            if max(r_val, g_val, b_val) < 95:
                return "#1A1D24"
            return "#F4F6F9"
        except Exception as e:
            logger.debug(f"プレート初期色サンプリングスキップ: {e}")
            return "#F4F6F9"

    def detect_all(
        self, img: Image.Image, detect_plates: bool = True, detect_faces: bool = True
    ) -> Dict[str, Any]:
        """1枚の画像からナンバープレート4頂点リストと顔スタンプ候補リストを一括検出する"""
        plates = self.detect_plates(img) if detect_plates else []
        faces = self.detect_faces(img) if detect_faces else []
        return {
            "plates": plates,
            "faces": faces,
            "models_ready": {
                "plate": self._plate_session is not None,
                "face": self._face_session is not None,
            },
        }


def get_privacy_detector() -> PrivacyDetector:
    """シングルトン PrivacyDetector を取得する"""
    return PrivacyDetector.get_instance()
