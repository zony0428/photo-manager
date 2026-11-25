"""
Art Framer (プリント枠・EXIFキャプション・ウォーターマーク・プライバシーマスク・ONNX自動検出) 単体・統合テスト
本番 cache/library.db や take_out/ に一切接触しない一時ディレクトリ隔離テスト。
"""

import contextlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from server import database as db_pkg_mod  # noqa: E402
from server import lan_access as lan_access_mod  # noqa: E402
from server import mobile_bundle as mobile_bundle_mod  # noqa: E402
from server import mobile_delta as mobile_delta_mod  # noqa: E402
from server import storage_manager as storage_mgr_mod  # noqa: E402
from server.app import app  # noqa: E402
from server.database import (  # noqa: E402
    close_all_connections,
    initialize_database,
    stats as db_stats_mod,
    switch_database_path as _raw_switch_db,
    upsert_photo,
)
from server.database import connection as db_conn_mod  # noqa: E402
from server.export_decorator import (  # noqa: E402
    apply_print_frame_pil,
    apply_watermark_pil,
    build_caption_parts,
    resize_photo_for_target_output,
)
from server.privacy_mask import apply_privacy_masks_pil  # noqa: E402
from server.security import initialize_security_state, set_instance_file_for_test  # noqa: E402


def _switch_db_isolated(new_path: Path) -> Path:
    old = _raw_switch_db(new_path)
    resolved = Path(new_path)
    db_stats_mod.DB_PATH = resolved
    db_pkg_mod.DB_PATH = resolved
    return old


class TestArtFramerSuite(unittest.TestCase):
    """Art Framer 描画エンジン・外寸逆算・マスク不可逆化・コンベアAPIの検証"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp_root = Path(cls._tmp.name)
        cls.photos_dir = cls.tmp_root / "photos"
        cls.out_dir = cls.tmp_root / "out"
        cls.photos_dir.mkdir(parents=True, exist_ok=True)
        cls.out_dir.mkdir(parents=True, exist_ok=True)

        cls._orig_db = db_conn_mod.DB_PATH
        cls._orig_delta_db = mobile_delta_mod.DELTA_DB_PATH
        cls._orig_locker_state = mobile_delta_mod.LOCKER_STATE_PATH
        cls._orig_last_seq = mobile_delta_mod._last_built_commit_seq
        cls._orig_last_mtime = mobile_delta_mod._last_built_locker_mtime
        cls._orig_loome_dir = storage_mgr_mod.LOOME_DIR
        cls._orig_storage_dir = storage_mgr_mod.STORAGE_DIR
        cls._orig_legacy_dir = storage_mgr_mod.LEGACY_STORAGE_DIR
        cls._orig_lan_auth_file = lan_access_mod._LAN_AUTH_FILE
        cls._orig_standalone_html = mobile_bundle_mod.STANDALONE_HTML_PATH

        cls._stack = contextlib.ExitStack()
        cls._stack.enter_context(patch("server.database.switch_database_path", side_effect=_switch_db_isolated))
        cls._stack.enter_context(patch("server.database.connection.switch_database_path", side_effect=_switch_db_isolated))

        tmp_loome = cls.tmp_root / "Loome"
        tmp_loome.mkdir(parents=True, exist_ok=True)
        mobile_delta_mod.DELTA_DB_PATH = cls.tmp_root / "mobile_delta.db"
        mobile_delta_mod.LOCKER_STATE_PATH = cls.tmp_root / "mobile_locker_state.json"
        mobile_delta_mod._last_built_commit_seq = -1
        mobile_delta_mod._last_built_locker_mtime = -1.0
        storage_mgr_mod.LOOME_DIR = tmp_loome
        storage_mgr_mod.STORAGE_DIR = tmp_loome
        storage_mgr_mod.LEGACY_STORAGE_DIR = cls.tmp_root / "legacy_storage_unused"
        lan_access_mod._LAN_AUTH_FILE = cls.tmp_root / ".mobile_lan_auth.json"
        mobile_bundle_mod.STANDALONE_HTML_PATH = cls.tmp_root / "Tetheract_Mobile.html"

        set_instance_file_for_test(cls.tmp_root / ".tetheract_instance_art_test")
        _switch_db_isolated(cls.tmp_root / "art_test_library.db")
        initialize_database()
        initialize_security_state(force_reload=True)

        cls.client = TestClient(app, base_url="http://127.0.0.1:8088")

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            close_all_connections()
            set_instance_file_for_test(None)
            _switch_db_isolated(cls._orig_db)
            mobile_delta_mod.DELTA_DB_PATH = cls._orig_delta_db
            mobile_delta_mod.LOCKER_STATE_PATH = cls._orig_locker_state
            mobile_delta_mod._last_built_commit_seq = cls._orig_last_seq
            mobile_delta_mod._last_built_locker_mtime = cls._orig_last_mtime
            storage_mgr_mod.LOOME_DIR = cls._orig_loome_dir
            storage_mgr_mod.STORAGE_DIR = cls._orig_storage_dir
            storage_mgr_mod.LEGACY_STORAGE_DIR = cls._orig_legacy_dir
            lan_access_mod._LAN_AUTH_FILE = cls._orig_lan_auth_file
            mobile_bundle_mod.STANDALONE_HTML_PATH = cls._orig_standalone_html
            initialize_security_state(force_reload=True)
        finally:
            cls._stack.close()
            cls._tmp.cleanup()

    def test_preset_dimensions_for_x_and_insta_and_fullsize(self) -> None:
        """for_x (長辺2048以下保証) / for_insta (1080x1350 & 1080x1080厳密一致) / full_size の寸法検証"""
        # 半端な高解像度サイズでも丸め誤差で 2048px を1pxも超えないことを確認
        for src_size in ((4032, 3024), (2667, 4000), (5472, 3648)):
            src = Image.new("RGB", src_size, (60, 90, 120))

            # 1. for_x
            f_x = {"enabled": True, "layout": "classic", "matte": "white", "aspect_mode": "original", "border_ratio": 0.05}
            rx, fix_x = resize_photo_for_target_output(src, {"art_preset": "for_x"}, f_x)
            out_x = apply_print_frame_pil(rx, {"camera_model": "SONY ILCE-7M4"}, f_x, fixed_canvas_size=fix_x)
            self.assertLessEqual(max(out_x.size), 2048)
            self.assertGreaterEqual(max(out_x.size), 2045)

            # 2. for_insta (4:5)
            f_insta45 = {"enabled": True, "layout": "editorial", "matte": "paper", "aspect_mode": "4:5", "border_ratio": 0.05}
            ri45, fix_i45 = resize_photo_for_target_output(src, {"art_preset": "for_insta"}, f_insta45)
            out_i45 = apply_print_frame_pil(ri45, {"camera_model": "SIGMA fp L"}, f_insta45, fixed_canvas_size=fix_i45)
            self.assertEqual(out_i45.size, (1080, 1350))

            # 3. for_insta (1:1)
            f_insta11 = {"enabled": True, "layout": "polaroid", "matte": "sumi", "aspect_mode": "1:1", "border_ratio": 0.05}
            ri11, fix_i11 = resize_photo_for_target_output(src, {"art_preset": "for_insta"}, f_insta11)
            out_i11 = apply_print_frame_pil(ri11, {"camera_model": "RICOH GR IIIx"}, f_insta11, fixed_canvas_size=fix_i11)
            self.assertEqual(out_i11.size, (1080, 1080))

        # 4. full_size: リサイズなし外周拡張
        small = Image.new("RGB", (1200, 800), (100, 100, 100))
        f_full = {"enabled": True, "layout": "border_only", "matte": "white", "aspect_mode": "original", "border_ratio": 0.05}
        rf, fix_f = resize_photo_for_target_output(small, {"art_preset": "full_size"}, f_full)
        out_f = apply_print_frame_pil(rf, {}, f_full, fixed_canvas_size=fix_f)
        self.assertEqual(out_f.size, (1320, 920))

    def test_privacy_masks_irreversible_pixel_overwrite(self) -> None:
        """ナンバー4頂点ポリゴン塗りと顔フェザーモヤが対象領域を確実に上書きし外部を無傷に保つこと"""
        img = Image.new("RGB", (800, 600), (20, 40, 60))
        draw = ImageDraw.Draw(img)
        # プレート位置 (中心 0.5, 0.7) に高コントラストの赤パッチ、顔位置 (0.25, 0.25) に緑チェッカーを描画
        draw.rectangle([360, 400, 440, 440], fill=(240, 10, 10))
        for y in range(120, 180, 6):
            for x in range(170, 230, 6):
                if ((x + y) // 6) % 2 == 0:
                    draw.rectangle([x, y, x + 5, y + 5], fill=(10, 250, 20))

        before_arr = np.asarray(img)
        masked = apply_privacy_masks_pil(
            img,
            {
                "enabled": True,
                "plates": [
                    {
                        "pts": [
                            {"x": 0.43, "y": 0.65},
                            {"x": 0.57, "y": 0.65},
                            {"x": 0.57, "y": 0.75},
                            {"x": 0.43, "y": 0.75},
                        ],
                        "style": "solid",
                        "color": "#F4F6F9",
                    }
                ],
                "faces": [
                    {"x": 0.25, "y": 0.25, "r": 0.08, "style": "milky", "strength": 0.9}
                ],
            },
        )
        after_arr = np.asarray(masked)

        # 1. プレート中心は白 (#F4F6F9) に完全置換されていること
        center_px = after_arr[420, 400]
        self.assertGreater(int(center_px[0]), 235)
        self.assertGreater(int(center_px[1]), 235)
        self.assertGreater(int(center_px[2]), 235)

        # 2. 顔チェッカー領域の分散 (コントラスト) がガウスぼかし＋白モヤで大幅に平滑化されていること
        std_before = float(np.std(before_arr[135:165, 185:215]))
        std_after = float(np.std(after_arr[135:165, 185:215]))
        self.assertLess(std_after, std_before * 0.25)

        # 3. プレート外周フチ (x=344 = 0.43*800) はソフトフェザーモヤにより背景色と白の中間値へ滑らかに遷移していること
        edge_px = after_arr[420, 344]
        self.assertGreater(int(edge_px[0]), 40)
        self.assertLess(int(edge_px[0]), 235)

        # 4. 遠く離れた右下ピクセルは1ビットも変化していないこと
        np.testing.assert_array_equal(before_arr[580, 780], after_arr[580, 780])

    def test_face_haze_100pct_destroys_spatial_features_against_ai_recovery(self) -> None:
        """顔モヤ100% (および既定92%) で目・鼻・口・輪郭の低周波配置も含め完全に平坦化・不可逆消去されること"""
        img = Image.new("RGB", (1000, 800), (80, 95, 110))
        draw = ImageDraw.Draw(img)
        # 中心 (500, 400)、半径 100px の範囲に強い明暗コントラストを持つ疑似顔（肌・黒い両目・白いハイライト・暗い口）を描画
        draw.ellipse([400, 290, 600, 510], fill=(228, 192, 168), outline=(30, 20, 15), width=6)
        draw.ellipse([435, 355, 475, 385], fill=(12, 12, 15))
        draw.ellipse([525, 355, 565, 385], fill=(12, 12, 15))
        draw.ellipse([452, 364, 462, 374], fill=(255, 255, 255))
        draw.ellipse([542, 364, 552, 374], fill=(255, 255, 255))
        draw.rectangle([492, 385, 508, 430], fill=(248, 224, 205))
        draw.rectangle([455, 450, 545, 472], fill=(45, 18, 22))

        orig_roi = np.asarray(img, dtype=np.float32)[330:480, 425:575]
        orig_spatial_std = float(np.std(orig_roi, axis=(0, 1)).mean())
        self.assertGreater(orig_spatial_std, 50.0)

        for style in ("frosted", "milky", "smoke"):
            masked_100 = apply_privacy_masks_pil(
                img,
                {
                    "enabled": True,
                    "faces": [{"x": 0.5, "y": 0.5, "r": 0.13, "style": style, "strength": 1.0}],
                },
            )
            roi_100 = np.asarray(masked_100, dtype=np.float32)[330:480, 425:575]
            # 100%時は微細グレイン以外の空間構造が完全に消滅 (各チャンネル空間標準偏差 3.0 未満) していること
            spatial_std_100 = float(np.std(roi_100, axis=(0, 1)).mean())
            self.assertLess(spatial_std_100, 3.0, f"style={style} で陰影が残存しています")
            # 両目があった位置 (y=370, x=455) と額の位置 (y=340, x=500) のチャンネル別平均差もゼロに近いこと
            eye_mean = roi_100[35:45, 25:40].mean(axis=(0, 1))
            forehead_mean = roi_100[5:18, 65:85].mean(axis=(0, 1))
            self.assertLess(float(np.max(np.abs(eye_mean - forehead_mean))), 2.5, f"style={style} で目元の暗さが残存しています")

        # 既定値 (strength=0.92) でも空間コントラストが元の5%未満へ不可逆圧縮されていること
        masked_92 = apply_privacy_masks_pil(
            img,
            {
                "enabled": True,
                "faces": [{"x": 0.5, "y": 0.5, "r": 0.13, "style": "frosted", "strength": 0.92}],
            },
        )
        roi_92 = np.asarray(masked_92, dtype=np.float32)[330:480, 425:575]
        spatial_std_92 = float(np.std(roi_92, axis=(0, 1)).mean())
        self.assertLess(spatial_std_92, orig_spatial_std * 0.05)

    def test_multi_vehicle_and_hope_number_plate_detection(self) -> None:
        """複数台並び (日陰の希望ナンバー '・ ・・3' ＋ 通常4桁ナンバー) が誤検出なく両方検出・4辺スナップされること"""
        from PIL import ImageFont

        from server.ai.privacy_detector import get_privacy_detector

        im = Image.new("RGB", (1600, 1066), (70, 82, 65))
        draw = ImageDraw.Draw(im)

        # 誤検出トラップ: 上部の白い壁、ヘッドライト楕円、斜めの道路白線
        draw.rectangle([100, 50, 500, 240], fill=(235, 238, 240))
        draw.ellipse([430, 500, 510, 535], fill=(240, 245, 255))
        draw.polygon([(50, 920), (350, 780), (375, 790), (75, 935)], fill=(230, 230, 230))

        from server.export_decorator import BUNDLED_INTER_FONT

        try:
            f_top = ImageFont.truetype(str(BUNDLED_INTER_FONT), 11)
            f_bot = ImageFont.truetype(str(BUNDLED_INTER_FONT), 20)
        except Exception:
            f_top = ImageFont.load_default()
            f_bot = ImageFont.load_default()

        # 左車両: 日陰の黒グリル内にある1桁希望ナンバー (x=650..728, y=585..625)
        draw.polygon([(520, 530), (780, 530), (760, 650), (540, 650)], fill=(18, 18, 22))
        draw.rectangle([650, 585, 728, 625], fill=(165, 170, 173), outline=(25, 25, 25), width=2)
        draw.text((664, 587), "UTO 330", fill=(30, 50, 38), font=f_top)
        draw.text((656, 601), "m . . . 3", fill=(25, 45, 32), font=f_bot)

        # 右車両: 通常4桁ナンバー (x=1305..1383, y=575..615)
        draw.polygon([(1210, 520), (1450, 520), (1430, 640), (1230, 640)], fill=(15, 15, 18))
        draw.rectangle([1305, 575, 1383, 615], fill=(228, 232, 236), outline=(25, 25, 25), width=2)
        draw.text((1320, 577), "NGY 330", fill=(25, 55, 35), font=f_top)
        draw.text((1313, 591), "a 12-34", fill=(20, 50, 30), font=f_bot)

        det = get_privacy_detector()
        plates = det.detect_plates(im)
        self.assertEqual(len(plates), 2)

        centers_x = sorted(sum(pt["x"] for pt in p["pts"]) * 0.25 * 1600 for p in plates)
        self.assertAlmostEqual(centers_x[0], 689.0, delta=8.0)
        self.assertAlmostEqual(centers_x[1], 1344.0, delta=8.0)
        for p in plates:
            self.assertEqual(p.get("feather"), 0.45)

    def test_white_car_thin_frame_snap_and_concrete_step_rejection(self) -> None:
        """白ボディ車 (細い黒枠4px＋白リップ＋太字99-09) で右端切れ・傾きなく吸着し、コンクリート段差の明暗差誤検出を排除すること"""
        from PIL import ImageFont

        from server.ai.privacy_detector import get_privacy_detector
        from server.export_decorator import BUNDLED_INTER_FONT

        im = Image.new("RGB", (1600, 1200), (68, 65, 62))
        d = ImageDraw.Draw(im)

        # 左端トラップ: コンクリートテラス段差 + 濃い影 + 黒いアイアンチェアの縦脚影 + 駐車白線
        d.rectangle([0, 0, 420, 580], fill=(150, 185, 225))
        d.rectangle([420, 0, 1600, 680], fill=(232, 236, 238))
        d.rectangle([0, 680, 620, 725], fill=(162, 166, 168))
        d.rectangle([0, 725, 620, 760], fill=(28, 28, 30))
        for x in range(40, 220, 12):
            d.line([(x, 520), (x, 724)], fill=(22, 24, 26), width=3)
        d.polygon([(200, 1160), (380, 790), (415, 790), (255, 1160)], fill=(215, 218, 222))

        # 白ボディ車両 + 黒グリル (下側の黒隙間はわずか 4px で直下に白バンパーリップと赤ライン)
        d.polygon([(650, 580), (1400, 580), (1440, 1020), (620, 1020)], fill=(238, 238, 236))
        d.polygon([(780, 885), (1270, 885), (1235, 984), (815, 984)], fill=(16, 17, 20))
        d.rectangle([1012, 985, 1038, 1020], fill=(215, 24, 24))
        # 本物のナンバー真値: x=935..1115, y=892..980
        d.rectangle([935, 892, 1115, 980], fill=(242, 244, 245), outline=(22, 22, 25), width=3)

        try:
            f1 = ImageFont.truetype(str(BUNDLED_INTER_FONT), 22)
            f2 = ImageFont.truetype(str(BUNDLED_INTER_FONT), 48)
        except Exception:
            f1 = ImageFont.load_default()
            f2 = ImageFont.load_default()
        d.text((965, 896), "UTO 330", fill=(22, 48, 30), font=f1)
        d.text((943, 924), "h 99-09", fill=(18, 42, 26), font=f2)

        plates = get_privacy_detector().detect_plates(im)
        self.assertEqual(len(plates), 1)
        pts = plates[0]["pts"]
        min_x = min(p["x"] for p in pts) * 1600
        max_x = max(p["x"] for p in pts) * 1600
        # 右端の 9 (x=1115付近) まで切れずに覆われ、かつ傾いていないこと
        self.assertLessEqual(min_x, 938.0)
        self.assertGreaterEqual(max_x, 1112.0)
        top_tilt = abs(pts[0]["y"] - pts[1]["y"]) * 1200
        self.assertLess(top_tilt, 3.0)

        # 中央に閉じた丸穴文字 ('9', '0') があり、かつ対角潰れした初期枠が入力された場合でも正常な長方形へ復元されること
        from server.ai.plate_refiner import quad_is_well_formed, snap_quad_to_plate_surface

        d.ellipse([1008, 916, 1042, 960], fill=(18, 40, 25))
        d.ellipse([1018, 926, 1032, 950], fill=(242, 244, 245))
        collapsed_q = np.array(
            [[935 / 1600, 892 / 1200], [1045 / 1600, 922 / 1200], [1115 / 1600, 980 / 1200], [985 / 1600, 950 / 1200]],
            dtype=np.float32,
        )
        snapped_q, ok_snap = snap_quad_to_plate_surface(np.asarray(im), collapsed_q, score=0.92)
        self.assertTrue(ok_snap)
        self.assertIsNotNone(snapped_q)
        self.assertTrue(quad_is_well_formed(np.column_stack([snapped_q[:, 0] * 1600, snapped_q[:, 1] * 1200])))

        # 上の白いフロントバンパーに隙間0pxで同色密着している正面ナンバーでも水平0度で4辺スナップされること
        d.rectangle([935, 880, 1115, 895], fill=(242, 244, 245))
        skewed_frontal_q = np.array(
            [[931 / 1600, 886 / 1200], [1106 / 1600, 902 / 1200], [1116 / 1600, 984 / 1200], [940 / 1600, 976 / 1200]],
            dtype=np.float32,
        )
        zero_gap_q, ok_zg = snap_quad_to_plate_surface(np.asarray(im), skewed_frontal_q, score=0.92)
        self.assertTrue(ok_zg)
        self.assertIsNotNone(zero_gap_q)
        self.assertAlmostEqual(float(zero_gap_q[0, 1]), float(zero_gap_q[1, 1]), delta=0.001)
        self.assertLessEqual(float(zero_gap_q[0, 0]) * 1600, 935.0)
        self.assertGreaterEqual(float(zero_gap_q[1, 0]) * 1600, 1115.0)

    def test_dutch_angle_foreshortened_three_vehicles(self) -> None:
        """ダッチアングル (約31度傾き) ＋ 斜め前方パースペクティブ圧縮された3台並びが誤検出なく角度追従で検出されること"""
        import math
        from PIL import ImageFont

        from server.ai.privacy_detector import get_privacy_detector
        from server.export_decorator import BUNDLED_INTER_FONT

        canvas = Image.new("RGB", (2200, 1800), (145, 142, 140))
        d = ImageDraw.Draw(canvas)
        d.rectangle([0, 0, 2200, 560], fill=(215, 212, 225))
        # 背景トラップ: 太陽光パネル風の格子パターン
        d.rectangle([1450, 620, 1950, 740], fill=(75, 92, 115))
        for gx in range(1460, 1940, 24):
            d.line([(gx, 620), (gx, 740)], fill=(195, 200, 210), width=1)

        try:
            f1 = ImageFont.truetype(str(BUNDLED_INTER_FONT), 10)
            f2 = ImageFont.truetype(str(BUNDLED_INTER_FONT), 18)
            f1b = ImageFont.truetype(str(BUNDLED_INTER_FONT), 13)
            f2b = ImageFont.truetype(str(BUNDLED_INTER_FONT), 24)
        except Exception:
            f1 = f2 = f1b = f2b = ImageFont.load_default()

        # 左奥・中央・手前の3台（斜め前方からの圧縮アスペクト比 1.23〜1.31）
        d.polygon([(380, 660), (540, 660), (530, 760), (390, 760)], fill=(18, 18, 22))
        d.rectangle([425, 700, 467, 734], fill=(218, 222, 226), outline=(25, 25, 25), width=2)
        d.text((431, 702), "330", fill=(25, 50, 35), font=f1)
        d.text((428, 713), "20-12", fill=(20, 45, 30), font=f2)

        d.polygon([(620, 690), (810, 690), (795, 805), (635, 805)], fill=(16, 17, 20))
        d.rectangle([672, 740, 722, 780], fill=(215, 220, 224), outline=(25, 25, 25), width=2)
        d.text((682, 743), "330", fill=(25, 50, 35), font=f1)
        d.text((676, 756), "25-15", fill=(20, 45, 30), font=f2)

        d.polygon([(940, 730), (1180, 730), (1160, 860), (960, 860)], fill=(15, 15, 18))
        d.rectangle([1010, 778, 1078, 830], fill=(232, 236, 240), outline=(22, 22, 25), width=2)
        d.text((1024, 782), "302", fill=(25, 50, 35), font=f1b)
        d.text((1016, 799), "66-96", fill=(18, 42, 28), font=f2b)

        tilted = canvas.rotate(-31.0, resample=Image.Resampling.BILINEAR).crop((240, 180, 1840, 1246))
        plates = get_privacy_detector().detect_plates(tilted)
        self.assertEqual(len(plates), 3)
        for p in plates:
            pts = p["pts"]
            dx = (pts[1]["x"] - pts[0]["x"]) * 1600
            dy = (pts[1]["y"] - pts[0]["y"]) * 1066
            ang_deg = math.degrees(math.atan2(dy, dx))
            self.assertAlmostEqual(ang_deg, 31.0, delta=4.0)

    def test_watermark_text_and_logo_image_and_cjk_caption(self) -> None:
        """テキスト透かし・透過PNGロゴ透かし・日本語撮影地キャプション・Make重複整理の検証"""
        base = Image.new("RGB", (1000, 700), (50, 60, 70))

        # 透過PNGロゴを一時生成
        logo_path = self.tmp_root / "test_logo.png"
        logo = Image.new("RGBA", (200, 80), (255, 255, 255, 0))
        ImageDraw.Draw(logo).ellipse([10, 10, 190, 70], fill=(255, 255, 255, 220))
        logo.save(logo_path, "PNG")

        wm_text_img = apply_watermark_pil(
            base,
            {"enabled": True, "type": "text", "text": "© 2026 TETHERACT 写真室", "position": "bottom-right", "opacity": 0.7},
        )
        self.assertEqual(wm_text_img.size, (1000, 700))

        wm_logo_img = apply_watermark_pil(
            base,
            {"enabled": True, "type": "image", "image_path": str(logo_path), "position": "top-left", "opacity": 0.8, "size_ratio": 0.15},
        )
        self.assertEqual(wm_logo_img.size, (1000, 700))

        # Make と Model の重複除去確認
        exif = Image.Exif()
        exif[0x010F] = "SONY CORPORATION"
        parts = build_caption_parts(
            {"camera_model": "ILCE-7M4", "lens_model": "FE 35mm F1.4 GM", "focal_length": 35, "f_number": 1.4, "shutter_speed": "1/500", "iso": 100, "state": "長野県", "city": "松本市"},
            {"show_camera": True, "show_lens": True, "show_exposure": True, "show_location": True},
            orig_exif_bytes=exif.tobytes(),
        )
        self.assertEqual(parts["camera"], "SONY ILCE-7M4")
        self.assertIn("松本市, 長野県", parts["extra"])

    def test_conveyor_export_with_exif_strip_and_detect_endpoint(self) -> None:
        """1枚完結コンベア出力 (seq_offset連番) + EXIF全消去と白枠キャプション両立 + 自動検出APIの統合検証"""
        p1_path = self.photos_dir / "car_sample_1.jpg"
        p2_path = self.photos_dir / "car_sample_2.jpg"

        pids = []
        for idx, p_path in enumerate((p1_path, p2_path), 1):
            im = Image.new("RGB", (1600, 1066), (45, 70, 95))
            ex = Image.Exif()
            ex[0x010F] = "SIGMA"
            ex[0x0110] = "SIGMA fp L"
            ex[0x013B] = "SecretArtistName"
            im.save(p_path, "JPEG", quality=92, exif=ex.tobytes())

            pid = upsert_photo({
                "file_path": str(p_path),
                "file_name": p_path.name,
                "directory_path": str(self.photos_dir),
                "file_size": p_path.stat().st_size,
                "file_mtime": p_path.stat().st_mtime,
                "width": 1600,
                "height": 1066,
                "date_taken": f"2026-11-16 10:00:0{idx}",
                "camera_model": "SIGMA fp L",
                "lens_model": "45mm F2.8 DG DN",
                "focal_length": 45.0,
                "f_number": 2.8,
                "shutter_speed": "1/640",
                "iso": 100,
                "latitude": 35.6812,
                "longitude": 139.7671,
            })
            pids.append(pid)

        pid1, pid2 = pids[0], pids[1]

        # 1. ローカル自動検出エンドポイントが正常応答すること
        det_res = self.client.post("/api/export/detect-privacy", json={"photo_id": pid1})
        self.assertEqual(det_res.status_code, 200)
        det_json = det_res.json()
        self.assertEqual(det_json["status"], "ok")
        self.assertIn("plates", det_json)
        self.assertIn("faces", det_json)

        # 2. コンベア1枚目 (seq_offset=0) と 2枚目 (seq_offset=1) を順番に確定出力 (内部EXIF全消去 + 白枠キャプションON)
        for seq_idx, pid in enumerate((pid1, pid2)):
            exp_res = self.client.post(
                "/api/export/smart",
                json={
                    "photo_ids": [pid],
                    "destination": str(self.out_dir),
                    "format": "jpeg",
                    "quality": 92,
                    "naming_rule": "custom_seq",
                    "custom_prefix": "FrameTest",
                    "exif_remove_all": True,
                    "open_folder_after": False,
                    "art_preset": "for_x",
                    "seq_offset": seq_idx,
                    "privacy_masks": {
                        "enabled": True,
                        "plates": [
                            {"pts": [{"x": 0.4, "y": 0.6}, {"x": 0.6, "y": 0.6}, {"x": 0.6, "y": 0.7}, {"x": 0.4, "y": 0.7}], "style": "solid", "color": "#F4F6F9"}
                        ],
                        "faces": [],
                    },
                    "watermark": {"enabled": True, "type": "text", "text": "© 2026 TEST", "position": "bottom-right"},
                    "print_frame": {
                        "enabled": True,
                        "layout": "classic",
                        "matte": "white",
                        "aspect_mode": "original",
                        "border_ratio": 0.05,
                        "show_camera": True,
                        "show_lens": True,
                        "show_exposure": True,
                    },
                },
            )
            self.assertEqual(exp_res.status_code, 200)
            body = exp_res.json()
            self.assertEqual(body["success_count"], 1)
            expected_name = f"FrameTest_{seq_idx + 1:03d}.jpg"
            self.assertEqual(body["exported_files"], [expected_name])

            saved_file = self.out_dir / expected_name
            self.assertTrue(saved_file.is_file())
            with Image.open(saved_file) as out_im:
                # 内部EXIFは完全消去されていること
                self.assertEqual(len(out_im.getexif()), 0)
                # 下部白枠の中央付近にキャプション文字の暗いピクセルが印字されていること
                w_out, h_out = out_im.size
                caption_strip = np.asarray(out_im.crop((int(w_out * 0.25), int(h_out * 0.90), int(w_out * 0.75), h_out - 4)))
                self.assertLess(int(np.min(caption_strip)), 100)

        # 3. Art Framer 既定の thmod_original ルールで thmod_car_sample_1.jpg が出力されること
        mod_res = self.client.post(
            "/api/export/smart",
            json={
                "photo_ids": [pid1],
                "destination": str(self.out_dir),
                "format": "jpeg",
                "quality": 92,
                "naming_rule": "thmod_original",
                "open_folder_after": False,
                "art_preset": "for_x",
                "print_frame": {"enabled": True, "layout": "border_only", "matte": "white", "aspect_mode": "original", "border_ratio": 0.04},
            },
        )
        self.assertEqual(mod_res.status_code, 200)
        self.assertEqual(mod_res.json()["exported_files"], ["thmod_car_sample_1.jpg"])

    def test_thmod_managed_folder_stack_and_ai_tag_exclusion(self) -> None:
        """管理フォルダ保存時: EXIF維持なら元写真を代表として自動スタック化・EXIF消去なら非スタック・thmod_はAIタグ推論対象外となること"""
        from unittest.mock import MagicMock

        from server.ai.worker import AITaggingWorker
        from server.database import add_tag_to_photo, get_photo_by_id, get_photo_tags_details
        from server.scanner import scan_directory

        managed_dir = self.tmp_root / "managed_album"
        managed_dir.mkdir(parents=True, exist_ok=True)

        # あえて ASCII 順で 'thmod_' より後ろになる 'z_' 始まりのファイル名で代表優先度も検証
        orig1_path = managed_dir / "z_street_001.jpg"
        orig2_path = managed_dir / "z_street_002.jpg"

        for idx, p_path in enumerate((orig1_path, orig2_path), 1):
            im = Image.new("RGB", (1200, 800), (60 + idx * 20, 90, 120))
            ex = Image.Exif()
            ex[0x010F] = "NIKON CORPORATION"
            ex[0x0110] = "NIKON Zf"
            ifd = ex.get_ifd(0x8769)
            ifd[0x9003] = f"2026:05:10 15:20:{idx * 10:02d}"
            ifd[0x829D] = 2.0
            ex[0x8769] = ifd
            im.save(p_path, "JPEG", quality=92, exif=ex.tobytes())

        scan_directory(str(managed_dir), cleanup_orphans=False, recursive=False)

        conn = db_conn_mod.get_connection()
        rows = {
            r["file_name"]: dict(r)
            for r in conn.execute(
                "SELECT id, file_name, stack_id, is_stack_primary FROM photos WHERE directory_path = ?",
                (str(managed_dir),),
            ).fetchall()
        }
        orig1_id = int(rows["z_street_001.jpg"]["id"])
        orig2_id = int(rows["z_street_002.jpg"]["id"])
        add_tag_to_photo(orig1_id, "街角スナップ")

        # ケースA: EXIFを維持して元の管理フォルダへ thmod_ 書き出し
        res_keep_exif = self.client.post(
            "/api/export/smart",
            json={
                "photo_ids": [orig1_id],
                "destination": str(managed_dir),
                "format": "jpeg",
                "quality": 92,
                "naming_rule": "thmod_original",
                "exif_remove_gps": True,
                "exif_remove_all": False,
                "open_folder_after": False,
                "art_preset": "for_x",
                "print_frame": {"enabled": True, "layout": "classic", "matte": "white", "aspect_mode": "original", "border_ratio": 0.05},
            },
        )
        self.assertEqual(res_keep_exif.status_code, 200)
        self.assertEqual(res_keep_exif.json()["exported_files"], ["thmod_z_street_001.jpg"])

        # ケースB: EXIFを全消去して元の管理フォルダへ thmod_ 書き出し
        res_strip_exif = self.client.post(
            "/api/export/smart",
            json={
                "photo_ids": [orig2_id],
                "destination": str(managed_dir),
                "format": "jpeg",
                "quality": 92,
                "naming_rule": "thmod_original",
                "exif_remove_all": True,
                "open_folder_after": False,
                "art_preset": "for_x",
                "print_frame": {"enabled": True, "layout": "classic", "matte": "white", "aspect_mode": "original", "border_ratio": 0.05},
            },
        )
        self.assertEqual(res_strip_exif.status_code, 200)
        self.assertEqual(res_strip_exif.json()["exported_files"], ["thmod_z_street_002.jpg"])

        # 管理フォルダを再スキャン
        scan_directory(str(managed_dir), cleanup_orphans=False, recursive=False)

        after_rows = {
            r["file_name"]: dict(r)
            for r in db_conn_mod.get_connection().execute(
                "SELECT id, file_name, stack_id, is_stack_primary, stack_type FROM photos WHERE directory_path = ?",
                (str(managed_dir),),
            ).fetchall()
        }
        p_orig1 = get_photo_by_id(orig1_id)
        p_thmod1 = get_photo_by_id(int(after_rows["thmod_z_street_001.jpg"]["id"]))
        p_orig2 = get_photo_by_id(orig2_id)
        p_thmod2 = get_photo_by_id(int(after_rows["thmod_z_street_002.jpg"]["id"]))

        # A: EXIF維持の thmod_z_street_001.jpg は元写真とスタック化され、元写真が代表 (is_stack_primary=1) になること
        self.assertIsNotNone(p_orig1["stack_id"])
        self.assertEqual(p_orig1["stack_id"], p_thmod1["stack_id"])
        self.assertEqual(p_orig1["is_stack_primary"], 1)
        self.assertEqual(p_thmod1["is_stack_primary"], 0)
        # スタック同期により元写真の手動タグが引き継がれていること
        thmod1_tags = {t["tag"] for t in get_photo_tags_details(p_thmod1["id"])}
        self.assertIn("街角スナップ", thmod1_tags)

        # B: EXIF全消去の thmod_z_street_002.jpg はスタック化されず独立していること
        self.assertIsNone(p_orig2["stack_id"])
        self.assertIsNone(p_thmod2["stack_id"])
        self.assertEqual(p_orig2["is_stack_primary"], 1)
        self.assertEqual(p_thmod2["is_stack_primary"], 1)

        # C: AIタグ付けワーカーを実行した際、thmod_ ファイルは推論対象から除外されること
        fake_tagger = MagicMock()
        fake_tagger.load.return_value = True
        fake_tagger.is_loaded = True
        fake_tagger.is_available.return_value = True
        fake_tagger.predict_from_bytes.return_value = [{"tag": "夜景", "confidence": 0.91}]

        worker = AITaggingWorker()
        with patch("server.ai.worker.get_ai_tagger", return_value=fake_tagger):
            worker._run_job(
                folder_path=str(managed_dir),
                photo_ids=None,
                force_retag=True,
                color_only=False,
            )

        # 元写真2枚 (z_street_001, z_street_002) のみ推論され、thmod_ 2枚はスキップされること
        self.assertEqual(worker.total_count, 2)
        self.assertEqual(fake_tagger.predict_from_bytes.call_count, 2)
        thmod2_tags = {t["tag"] for t in get_photo_tags_details(p_thmod2["id"])}
        self.assertNotIn("夜景", thmod2_tags)

        # photo_ids 明示指定時にも thmod_ が除外されること
        fake_tagger.predict_from_bytes.reset_mock()
        with patch("server.ai.worker.get_ai_tagger", return_value=fake_tagger):
            worker._run_job(
                folder_path=None,
                photo_ids=[orig1_id, p_thmod1["id"], orig2_id, p_thmod2["id"]],
                force_retag=True,
                color_only=False,
            )
        self.assertEqual(worker.total_count, 2)
        self.assertEqual(fake_tagger.predict_from_bytes.call_count, 2)

    def test_normalize_camera_stem_preserves_img_numbers(self) -> None:
        """IMG_1234 / IMG_5678 / 20261117_001 の末尾番号を誤切除せず、コピー枝番と thmod_ のみ除去すること"""
        from server.mobile_signals import find_smart_stem_date_matches, normalize_camera_stem
        from server.routers.mobile_case_router import _normalize_dup_filename

        self.assertEqual(normalize_camera_stem("IMG_1234.JPG"), "img_1234")
        self.assertEqual(normalize_camera_stem("IMG_5678.JPG"), "img_5678")
        self.assertNotEqual(normalize_camera_stem("IMG_1234.JPG"), normalize_camera_stem("IMG_5678.JPG"))
        self.assertEqual(normalize_camera_stem("20261117_001.jpg"), "20261117_001")
        self.assertEqual(normalize_camera_stem("IMG_1234_1.JPG"), "img_1234")
        self.assertEqual(normalize_camera_stem("DSC01234 (1).JPG"), "dsc01234")
        self.assertEqual(normalize_camera_stem("thmod_DSC01234.jpg"), "dsc01234")

        self.assertEqual(_normalize_dup_filename("IMG_1234.JPG"), "img_1234.jpg")
        self.assertEqual(_normalize_dup_filename("IMG_1234_1.JPG"), "img_1234.jpg")

        # 同じ撮影日時（同秒連写想定）・同じカメラ機種でも IMG_1234 と IMG_5678 は別コマとして区別されること
        seq_dir = self.tmp_root / "seq_preserve_dir"
        seq_dir.mkdir(parents=True, exist_ok=True)
        f_1234 = seq_dir / "IMG_1234.JPG"
        f_1234.write_bytes(b"img1234")
        pid_1234 = upsert_photo({
            "file_path": str(f_1234),
            "file_name": f_1234.name,
            "directory_path": str(seq_dir),
            "file_size": 4_200_000,
            "date_taken": "2027-01-10 11:22:33",
            "camera_model": "Canon EOS R6m2",
        })
        conn = db_conn_mod.get_connection()
        hits = find_smart_stem_date_matches(
            conn.cursor(),
            [
                {"key": "same", "file_name": "IMG_1234.JPG", "date_taken": "2027-01-10 11:22:33", "camera_model": "EOS R6m2"},
                {"key": "other", "file_name": "IMG_5678.JPG", "date_taken": "2027-01-10 11:22:33", "camera_model": "EOS R6m2"},
            ],
        )
        self.assertEqual(hits.get("same"), [pid_1234])
        self.assertNotIn("other", hits)

    def test_smart_stem_date_matching_and_raw_jpeg_sync(self) -> None:
        """2MP縮小画像と母艦フルサイズJPEG/RAWのスマート一致および評価・タグ・GPSペア連動検証"""
        from server.database import get_photo_by_id, get_photo_tags_details, upsert_photos_batch
        from server.database.stacks import recalculate_stacks_for_directories
        from server.mobile_sync_apply import apply_mobile_sync_changes

        sd_dir = self.tmp_root / "sd_smart_match"
        sd_dir.mkdir(parents=True, exist_ok=True)
        jpg_path = sd_dir / "DSC04567.JPG"
        arw_path = sd_dir / "DSC04567.ARW"
        solo_raw_path = sd_dir / "DSC04568.ARW"
        for p, sz in ((jpg_path, b"jpg_full"), (arw_path, b"arw_full"), (solo_raw_path, b"arw_solo")):
            p.write_bytes(sz)

        upsert_photos_batch([
            {
                "file_path": str(arw_path),
                "file_name": arw_path.name,
                "directory_path": str(sd_dir),
                "file_size": 34_000_000,
                "date_taken": "2027-02-14 10:15:30",
                "camera_model": "ILCE-7M4",
                "is_raw": 1,
                "raw_format": "ARW",
            },
            {
                "file_path": str(jpg_path),
                "file_name": jpg_path.name,
                "directory_path": str(sd_dir),
                "file_size": 12_000_000,
                "date_taken": "2027-02-14 10:15:30",
                "camera_model": "ILCE-7M4",
                "is_raw": 0,
                "paired_raw_path": str(arw_path),
            },
            {
                "file_path": str(solo_raw_path),
                "file_name": solo_raw_path.name,
                "directory_path": str(sd_dir),
                "file_size": 35_000_000,
                "date_taken": "2027-02-14 10:16:00",
                "camera_model": "ILCE-7M4",
                "is_raw": 1,
                "raw_format": "ARW",
            },
        ])
        recalculate_stacks_for_directories([str(sd_dir)], recursive=False)

        # 1. workingモードで1秒差・別サイズ(2M)のスマホ画像を preflight 送信 → 本体送信スキップ＆ペア両方へ信号適用
        preflight_res = self.client.post(
            "/api/mobile/case-preflight",
            json={
                "items": [
                    {
                        "client_id": "phone_4567",
                        "file_name": "DSC04567.JPG",
                        "file_size": 1_850_000,
                        "date_taken": "2027-02-14 10:15:31",
                        "camera_model": "SONY ILCE-7M4",
                        "folder_mode": "working",
                        "rating": 2,
                        "tags": ["野鳥", "速報/カワセミ"],
                        "latitude": 35.6812,
                        "longitude": 139.7671,
                    }
                ]
            },
        )
        self.assertEqual(preflight_res.status_code, 200)
        body = preflight_res.json()
        self.assertEqual(body["upload_client_ids"], [])
        self.assertIn("phone_4567", body["skipped_client_ids"])
        self.assertGreater(body["applied_to_existing"], 0)
        self.assertEqual(body["queued_pending_signals"], 0)

        conn = db_conn_mod.get_connection()
        rows = {
            r["file_name"]: int(r["id"])
            for r in conn.execute("SELECT id, file_name FROM photos WHERE directory_path = ?", (str(sd_dir),)).fetchall()
        }
        p_jpg = get_photo_by_id(rows["DSC04567.JPG"])
        p_arw = get_photo_by_id(rows["DSC04567.ARW"])
        self.assertEqual(int(p_jpg["rating"]), 2)
        self.assertEqual(int(p_arw["rating"]), 2)
        self.assertAlmostEqual(float(p_jpg["latitude"]), 35.6812, places=3)
        self.assertAlmostEqual(float(p_arw["latitude"]), 35.6812, places=3)
        jpg_tags = {t["tag"] for t in get_photo_tags_details(p_jpg["id"])}
        arw_tags = {t["tag"] for t in get_photo_tags_details(p_arw["id"])}
        self.assertTrue({"野鳥", "速報", "速報/カワセミ"}.issubset(jpg_tags))
        self.assertTrue({"野鳥", "速報", "速報/カワセミ"}.issubset(arw_tags))

        # 2. apply_mobile_sync_changes でも拡張子違い (JPG→ARW) をスマート照合して反映できること
        sync_res = apply_mobile_sync_changes(
            [
                {
                    "photo_id": 900_004_568,
                    "file_name": "DSC04568.JPG",
                    "file_size": 950_000,
                    "date_taken": "2027-02-14 10:16:00",
                    "camera_model": "ILCE-7M4",
                    "rating": 1,
                    "add_tags": ["ギャラリー同期"],
                }
            ]
        )
        self.assertEqual(sync_res["applied_count"], 1)
        self.assertEqual(sync_res["skipped_count"], 0)
        p_solo = get_photo_by_id(rows["DSC04568.ARW"])
        self.assertEqual(int(p_solo["rating"]), 1)
        self.assertIn("ギャラリー同期", {t["tag"] for t in get_photo_tags_details(p_solo["id"])})

    def test_pending_signals_auto_applied_on_later_sd_import(self) -> None:
        """SDカード取り込み前の先行信号(preflight / sync-import両経路)が後続スキャン時にRAW+JPEGへ自動合流すること"""
        from server.database import get_photo_by_id, get_photo_tags_details, upsert_photos_batch
        from server.database.stacks import recalculate_stacks_for_directories
        from server.mobile_sync_apply import apply_mobile_sync_changes

        # 1a. PC未登録状態で working フォルダから preflight 信号送信
        pre_res = self.client.post(
            "/api/mobile/case-preflight",
            json={
                "items": [
                    {
                        "client_id": "pending_8899",
                        "file_name": "R0008899.JPG",
                        "file_size": 1_400_000,
                        "date_taken": "2027-03-20 14:05:10",
                        "camera_model": "RICOH GR IIIx",
                        "folder_mode": "working",
                        "rating": 2,
                        "tags": ["スナップ/夜景"],
                        "latitude": 35.6581,
                        "longitude": 139.7017,
                    }
                ]
            },
        )
        self.assertEqual(pre_res.status_code, 200)
        pre_body = pre_res.json()
        self.assertEqual(pre_body["upload_client_ids"], [])
        self.assertIn("pending_8899", pre_body["skipped_client_ids"])
        self.assertEqual(pre_body["queued_pending_signals"], 1)

        # 1b. gallery側 sync-import ルートでも未登録写真の変更がドロップされず待機シグナルへ積まれること
        sync_pre = apply_mobile_sync_changes(
            [
                {
                    "photo_id": 900_008_900,
                    "file_name": "R0008900.JPG",
                    "file_size": 1_300_000,
                    "date_taken": "2027-03-20 14:06:00",
                    "camera_model": "RICOH GR IIIx",
                    "rating": 1,
                    "add_tags": ["先行タグ"],
                }
            ]
        )
        self.assertEqual(sync_pre["applied_count"], 1)
        self.assertTrue(sync_pre["applied_items"][0].get("queued_pending"))

        # 2. 帰宅後、SDカードから RAW+JPEG と単体RAW を PC へ取り込み
        later_dir = self.tmp_root / "later_sd_import"
        later_dir.mkdir(parents=True, exist_ok=True)
        dng_8899 = later_dir / "R0008899.DNG"
        jpg_8899 = later_dir / "R0008899.JPG"
        dng_8900 = later_dir / "R0008900.DNG"
        for p in (dng_8899, jpg_8899, dng_8900):
            p.write_bytes(b"sd_file")

        upsert_photos_batch([
            {
                "file_path": str(dng_8899),
                "file_name": dng_8899.name,
                "directory_path": str(later_dir),
                "file_size": 25_000_000,
                "date_taken": "2027-03-20 14:05:10",
                "camera_model": "RICOH GR IIIx",
                "is_raw": 1,
                "raw_format": "DNG",
            },
            {
                "file_path": str(jpg_8899),
                "file_name": jpg_8899.name,
                "directory_path": str(later_dir),
                "file_size": 8_500_000,
                "date_taken": "2027-03-20 14:05:10",
                "camera_model": "RICOH GR IIIx",
                "is_raw": 0,
                "paired_raw_path": str(dng_8899),
            },
            {
                "file_path": str(dng_8900),
                "file_name": dng_8900.name,
                "directory_path": str(later_dir),
                "file_size": 24_800_000,
                "date_taken": "2027-03-20 14:06:00",
                "camera_model": "RICOH GR IIIx",
                "is_raw": 1,
                "raw_format": "DNG",
            },
        ])
        recalculate_stacks_for_directories([str(later_dir)], recursive=False)

        conn = db_conn_mod.get_connection()
        rows = {
            r["file_name"]: int(r["id"])
            for r in conn.execute("SELECT id, file_name FROM photos WHERE directory_path = ?", (str(later_dir),)).fetchall()
        }
        r_jpg = get_photo_by_id(rows["R0008899.JPG"])
        r_dng = get_photo_by_id(rows["R0008899.DNG"])
        r_dng2 = get_photo_by_id(rows["R0008900.DNG"])

        self.assertEqual(int(r_jpg["rating"]), 2)
        self.assertEqual(int(r_dng["rating"]), 2)
        self.assertAlmostEqual(float(r_jpg["latitude"]), 35.6581, places=3)
        self.assertAlmostEqual(float(r_dng["latitude"]), 35.6581, places=3)
        self.assertTrue({"スナップ", "スナップ/夜景"}.issubset({t["tag"] for t in get_photo_tags_details(r_jpg["id"])}))
        self.assertTrue({"スナップ", "スナップ/夜景"}.issubset({t["tag"] for t in get_photo_tags_details(r_dng["id"])}))
        self.assertEqual(int(r_dng2["rating"]), 1)
        self.assertIn("先行タグ", {t["tag"] for t in get_photo_tags_details(r_dng2["id"])})

    def test_cross_folder_thmod_auto_stacking_preserves_original_primary(self) -> None:
        """Loome/case へ入った thmod_ 加工画が別フォルダの元写真と自動スタックされ、元写真が代表を維持・タグ同期されること"""
        from server.database import add_tag_to_photo, get_photo_by_id, get_photo_tags_details
        from server.database.stacks import stack_cross_folder_thmod_derivatives

        orig_dir = self.tmp_root / "cross_thmod_orig"
        case_dir = self.tmp_root / "cross_thmod_case"
        orig_dir.mkdir(parents=True, exist_ok=True)
        case_dir.mkdir(parents=True, exist_ok=True)

        # ASCII順で thmod_ より後ろになるファイル名かつ thmod_ より後のID登録でも元写真が代表を保つことを検証
        thmod_file = case_dir / "thmod_z_DSC09001.jpg"
        orig_file = orig_dir / "z_DSC09001.JPG"
        thmod_file.write_bytes(b"thmod_out")
        orig_file.write_bytes(b"orig_src")

        thmod_id = upsert_photo({
            "file_path": str(thmod_file),
            "file_name": thmod_file.name,
            "directory_path": str(case_dir),
            "file_size": 780_000,
            "date_taken": "2027-04-05 09:00:00",
            "camera_model": "ILCE-7RV",
            "rating": 2,
        })
        orig_id = upsert_photo({
            "file_path": str(orig_file),
            "file_name": orig_file.name,
            "directory_path": str(orig_dir),
            "file_size": 18_500_000,
            "date_taken": "2027-04-05 09:00:00",
            "camera_model": "ILCE-7RV",
            "rating": 2,
        })
        add_tag_to_photo(orig_id, "春/桜")

        conn = db_conn_mod.get_connection()
        stacked = stack_cross_folder_thmod_derivatives(conn.cursor())
        conn.commit()
        self.assertGreaterEqual(stacked, 1)

        p_orig = get_photo_by_id(orig_id)
        p_thmod = get_photo_by_id(thmod_id)
        self.assertIsNotNone(p_orig["stack_id"])
        self.assertEqual(p_orig["stack_id"], p_thmod["stack_id"])
        self.assertEqual(int(p_orig["is_stack_primary"]), 1)
        self.assertEqual(int(p_thmod["is_stack_primary"]), 0)
        thmod_tags = {t["tag"] for t in get_photo_tags_details(thmod_id)}
        self.assertTrue({"春", "春/桜"}.issubset(thmod_tags))

    def test_night_dual_roadsters_bold_plate_and_road_sign_non_face(self) -> None:
        """夜間照明下の黒車+白車2台(54-33 / 太字99-09)の両方を検出し、左上の丸い道路標識を顔と誤検出しないこと"""
        from PIL import ImageFont

        from server.ai.privacy_detector import get_privacy_detector
        from server.export_decorator import BUNDLED_INTER_FONT

        im = Image.new("RGB", (1600, 1200), (22, 24, 28))
        d = ImageDraw.Draw(im)

        # 左上の丸い道路標識トラップ (目のような2黒点を持つ青白い円盤)
        d.ellipse([70, 290, 140, 360], fill=(175, 185, 195), outline=(45, 70, 120), width=5)
        d.ellipse([88, 314, 98, 326], fill=(28, 32, 38))
        d.ellipse([112, 314, 122, 326], fill=(28, 32, 38))

        # 左車: 暗いフロントノーズ＋黒グリル＋やや暗めの夜間白プレート (54-33)
        d.polygon([(210, 560), (680, 560), (650, 760), (240, 760)], fill=(12, 13, 16))
        d.rectangle([380, 610, 504, 674], fill=(154, 158, 156), outline=(14, 14, 16), width=3)

        # 右車: 白ボディ＋黒グリル＋白いリップ密着＋太字ナンバー (99-09)
        d.polygon([(920, 530), (1440, 530), (1410, 760), (950, 760)], fill=(215, 218, 222))
        d.polygon([(990, 598), (1360, 598), (1330, 710), (1020, 710)], fill=(14, 15, 18))
        d.rectangle([1114, 616, 1236, 678], fill=(160, 164, 162), outline=(14, 14, 16), width=3)

        try:
            f1 = ImageFont.truetype(str(BUNDLED_INTER_FONT), 15)
            f2 = ImageFont.truetype(str(BUNDLED_INTER_FONT), 34)
        except Exception:
            f1 = ImageFont.load_default()
            f2 = ImageFont.load_default()

        d.text((406, 619), "TKT 502", fill=(28, 52, 36), font=f1)
        d.text((390, 636), "54-33", fill=(22, 46, 30), font=f2)
        d.text((1140, 625), "UTO 330", fill=(28, 52, 36), font=f1)
        d.text((1122, 642), "99-09", fill=(20, 44, 28), font=f2)

        res = get_privacy_detector().detect_all(im)
        self.assertEqual(len(res["faces"]), 0)
        self.assertEqual(len(res["plates"]), 2)
        cx_sorted = sorted(sum(pt["x"] for pt in p["pts"]) * 0.25 * 1600 for p in res["plates"])
        self.assertAlmostEqual(cx_sorted[0], 442.0, delta=12.0)
        self.assertAlmostEqual(cx_sorted[1], 1175.0, delta=12.0)

    def test_watermark_nine_anchor_positions_and_shadow_toggle(self) -> None:
        """9方向ウォーターマーク配置（top-center/middle-left/middle-right含む）と白黒・影あり/なしの描画分岐を検証"""
        base = Image.new("RGB", (600, 400), (128, 128, 128))
        positions = [
            ("top-left", 0, 0),
            ("top-center", 1, 0),
            ("top-right", 2, 0),
            ("middle-left", 0, 1),
            ("center", 1, 1),
            ("middle-right", 2, 1),
            ("bottom-left", 0, 2),
            ("bottom-center", 1, 2),
            ("bottom-right", 2, 2),
        ]
        x_bounds = [(0, 200), (200, 400), (400, 600)]
        y_bounds = [(0, 133), (133, 266), (266, 400)]

        for pos, expect_col, expect_row in positions:
            out = apply_watermark_pil(
                base,
                {
                    "enabled": True,
                    "type": "text",
                    "text": "WM",
                    "position": pos,
                    "color": "light",
                    "shadow": False,
                    "opacity": 1.0,
                    "size_ratio": 0.05,
                },
            )
            arr = np.asarray(out, dtype=np.int16)
            for row, (y0, y1) in enumerate(y_bounds):
                for col, (x0, x1) in enumerate(x_bounds):
                    zone_diff = np.abs(arr[y0:y1, x0:x1] - 128).max()
                    if (col, row) == (expect_col, expect_row):
                        self.assertGreater(int(zone_diff), 40, f"{pos} の対象ゾーンに透かしが描画されていません")
                    else:
                        self.assertEqual(int(zone_diff), 0, f"{pos} が他ゾーン ({col},{row}) へはみ出しています")

        # 4パターンのテキスト透かし（白文字 / 白文字(影付き) / 黒文字 / 黒文字(影付き)）
        light_plain = np.asarray(
            apply_watermark_pil(base, {"enabled": True, "type": "text", "text": "WM", "position": "center", "color": "light", "shadow": False, "opacity": 1.0, "size_ratio": 0.06})
        )
        light_shadow = np.asarray(
            apply_watermark_pil(base, {"enabled": True, "type": "text", "text": "WM", "position": "center", "color": "light", "shadow": True, "opacity": 1.0, "size_ratio": 0.06})
        )
        dark_plain = np.asarray(
            apply_watermark_pil(base, {"enabled": True, "type": "text", "text": "WM", "position": "center", "color": "dark", "shadow": False, "opacity": 1.0, "size_ratio": 0.06})
        )
        dark_shadow = np.asarray(
            apply_watermark_pil(base, {"enabled": True, "type": "text", "text": "WM", "position": "center", "color": "dark", "shadow": True, "opacity": 1.0, "size_ratio": 0.06})
        )

        self.assertGreater(int(light_plain.max()), 220)
        self.assertGreaterEqual(int(light_plain.min()), 128)
        self.assertLess(int(light_shadow.min()), 128)

        self.assertLess(int(dark_plain.min()), 40)
        self.assertLessEqual(int(dark_plain.max()), 128)
        self.assertGreater(int(dark_shadow.max()), 128)

    def test_step0_adjustments_view_detect_and_export_integration(self) -> None:
        """Step 0 非破壊調整（トーンのみ vs 90度回転＋傾き）保存後の view?raw=1・detect-privacy・smart出力連携を検証"""
        import io as _io

        img_path = self.photos_dir / "step0_sample.jpg"
        Image.new("RGB", (800, 600), (100, 120, 140)).save(img_path, format="JPEG", quality=92)
        pid = upsert_photo({
            "file_path": str(img_path),
            "file_name": img_path.name,
            "directory_path": str(self.photos_dir),
            "file_size": img_path.stat().st_size,
            "file_mtime": img_path.stat().st_mtime,
            "width": 800,
            "height": 600,
            "date_taken": "2026-11-25 10:00:00",
            "camera_model": "SIGMA fp",
            "lens_model": "45mm F2.8",
        })

        # 1. トーンのみ変更（寸法 800x600 は不変で raw=1 は元色を維持）
        r1 = self.client.post(
            f"/api/photo/{pid}/adjust",
            json={"rotation": 0, "fine_angle": 0.0, "brightness": 10, "contrast": 15, "saturation": 0},
        )
        self.assertEqual(r1.status_code, 200)

        v_adj = self.client.get(f"/api/photo/{pid}/view")
        v_raw = self.client.get(f"/api/photo/{pid}/view?raw=1")
        self.assertEqual(v_adj.status_code, 200)
        self.assertEqual(v_raw.status_code, 200)
        im_adj = Image.open(_io.BytesIO(v_adj.content))
        im_raw = Image.open(_io.BytesIO(v_raw.content))
        self.assertEqual(im_adj.size, (800, 600))
        self.assertEqual(im_raw.size, (800, 600))
        self.assertGreater(float(np.mean(np.asarray(im_adj))), float(np.mean(np.asarray(im_raw))) + 10.0)

        # 2. 幾何変更（90度回転 + 水平傾き）→ 縦横反転しつつ黒欠けなし内接クロップ、detect-privacy & smart export 成功
        r2 = self.client.post(
            f"/api/photo/{pid}/adjust",
            json={"rotation": 90, "fine_angle": 3.0, "brightness": 10, "contrast": 15, "saturation": 0},
        )
        self.assertEqual(r2.status_code, 200)
        v_rot = self.client.get(f"/api/photo/{pid}/view")
        self.assertEqual(v_rot.status_code, 200)
        im_rot = Image.open(_io.BytesIO(v_rot.content))
        self.assertLess(im_rot.width, im_rot.height)

        det_res = self.client.post(
            "/api/export/detect-privacy",
            json={"photo_id": pid, "apply_adjustments": True, "detect_plates": True, "detect_faces": True},
        )
        self.assertEqual(det_res.status_code, 200)

        out_sub = self.out_dir / "step0_export"
        out_sub.mkdir(parents=True, exist_ok=True)
        exp_res = self.client.post(
            "/api/export/smart",
            json={
                "photo_ids": [pid],
                "destination": str(out_sub),
                "format": "jpeg",
                "quality": 90,
                "resize_mode": "original",
                "naming_rule": "thmod_original",
                "apply_adjustments": True,
                "open_folder_after": False,
                "art_preset": "for_x",
                "print_frame": {"enabled": False},
                "watermark": {"enabled": False},
            },
        )
        self.assertEqual(exp_res.status_code, 200)
        self.assertEqual(exp_res.json().get("success_count"), 1)

    def test_lens_effects_swirl_bubble_vignette_focus_spot_and_smart_export(self) -> None:
        """Step 2 レンズ演出（ぐるぐる/バブル/ビネット/ハレーション・中心保護）と /api/export/smart 統合を検証"""
        from server.lens_effects import (
            apply_lens_effects_pil,
            is_lens_effect_active,
            normalize_lens_effect_config,
        )

        # 1. 有効判定の正規化
        self.assertFalse(is_lens_effect_active(None))
        self.assertFalse(is_lens_effect_active({"bokeh_mode": "none", "strength": 0.0, "vignette": 0.0, "halation": 0.0}))
        norm = normalize_lens_effect_config({"bokeh_mode": "swirl", "strength": 0.65, "cx": 0.35, "cy": 0.40})
        self.assertTrue(norm["enabled"])
        self.assertAlmostEqual(norm["cx"], 0.35, places=3)

        # 2. ピント中心保護 + 周辺ぐるぐる/バブル効果 + ビネット/ハレーション検証
        w, h = 240, 180
        arr = np.full((h, w, 3), 24, dtype=np.uint8)
        # ピント中心 (0.35, 0.40) 付近に微細な市松模様を配置
        cx_px, cy_px = int(w * 0.35), int(h * 0.40)
        for yy in range(cy_px - 10, cy_px + 10):
            for xx in range(cx_px - 10, cx_px + 10):
                arr[yy, xx] = (210, 180, 140) if ((xx + yy) % 2 == 0) else (40, 60, 80)
        # 外周に点光源＋縦ストライプ配置
        arr[20:26, 200:206] = (255, 250, 230)
        arr[140:155, 195:210] = (240, 200, 120)
        src_img = Image.fromarray(arr, mode="RGB")

        for mode in ("swirl", "bubble", "soft"):
            out_img = apply_lens_effects_pil(
                src_img,
                {
                    "bokeh_mode": mode,
                    "strength": 0.80,
                    "specular": 0.85,
                    "radius": 0.25,
                    "feather": 0.20,
                    "cx": 0.35,
                    "cy": 0.40,
                    "vignette": -0.35 if mode == "swirl" else 0.0,
                    "halation": 0.40 if mode == "bubble" else 0.0,
                },
                work_max_long=240,
            )
            out_arr = np.asarray(out_img, dtype=np.float32)
            orig_f = np.asarray(src_img, dtype=np.float32)
            # ピント保護中心（半径内）は原画とほぼ一致
            center_diff = float(np.mean(np.abs(out_arr[cy_px - 6:cy_px + 6, cx_px - 6:cx_px + 6] - orig_f[cy_px - 6:cy_px + 6, cx_px - 6:cx_px + 6])))
            self.assertLess(center_diff, 4.0, f"{mode}: ピント保護中心が過度に劣化しました")
            # 外周部は演出が反映されて変化
            outer_diff = float(np.mean(np.abs(out_arr[12:36, 188:218] - orig_f[12:36, 188:218])))
            self.assertGreater(outer_diff, 1.5, f"{mode}: 外周部にレンズ演出が反映されていません")

        # 3. 単独ビネット（コーナー減光）＋ハレーション検証
        flat_wall = Image.new("RGB", (160, 120), (160, 160, 160))
        vig_out = np.asarray(
            apply_lens_effects_pil(
                flat_wall,
                {"bokeh_mode": "none", "strength": 0.0, "vignette": -0.75, "cx": 0.5, "cy": 0.5, "radius": 0.28, "feather": 0.30},
            ),
            dtype=np.float32,
        )
        self.assertGreater(float(np.mean(vig_out[60, 80])), float(np.mean(vig_out[4, 4])) + 30.0)

        # 4. /api/export/smart に lens_effect を渡した統合書き出し
        img_path = self.photos_dir / "lens_effect_sample.jpg"
        src_img.resize((640, 480), Image.Resampling.BILINEAR).save(img_path, format="JPEG", quality=92)
        pid = upsert_photo({
            "file_path": str(img_path),
            "file_name": img_path.name,
            "directory_path": str(self.photos_dir),
            "file_size": img_path.stat().st_size,
            "file_mtime": img_path.stat().st_mtime,
            "width": 640,
            "height": 480,
            "date_taken": "2026-11-25 11:00:00",
            "camera_model": "FUJIFILM X-T5",
            "lens_model": "Helios 44-2 58mm F2",
        })
        out_sub = self.out_dir / "lens_effect_export"
        out_sub.mkdir(parents=True, exist_ok=True)
        exp_res = self.client.post(
            "/api/export/smart",
            json={
                "photo_ids": [pid],
                "destination": str(out_sub),
                "format": "jpeg",
                "quality": 90,
                "resize_mode": "original",
                "naming_rule": "thmod_original",
                "open_folder_after": False,
                "art_preset": "for_x",
                "lens_effect": {
                    "bokeh_mode": "swirl",
                    "strength": 0.65,
                    "specular": 0.72,
                    "radius": 0.28,
                    "feather": 0.36,
                    "cx": 0.45,
                    "cy": 0.50,
                    "vignette": -0.25,
                    "halation": 0.15,
                },
                "privacy_masks": {
                    str(pid): {"plates": [{"x": 0.2, "y": 0.7, "w": 0.15, "h": 0.08, "style": "solid", "color": "#FFFFFF"}], "faces": []},
                },
                "print_frame": {"enabled": True, "layout": "classic"},
                "watermark": {"enabled": False},
            },
        )
        self.assertEqual(exp_res.status_code, 200)
        self.assertEqual(exp_res.json().get("success_count"), 1)
        written_files = list(out_sub.glob("*.jpg"))
        self.assertEqual(len(written_files), 1)

    def test_native_dialog_com_dry_run_lock_guard_and_pick_folder_api(self) -> None:
        """Windows ネイティブCOMダイアログの dry_run 構築・二重起動ロック・/api/export/pick-folder APIを検証"""
        import sys
        from unittest import mock

        from server import native_dialog

        # 1. Windows COM IFileOpenDialog + TopMost HWND のヘッドレス構築・解放検証
        if sys.platform == "win32":
            folder_res = native_dialog._run_com_dialog_worker(
                {"mode": "folder", "initial_dir": str(self.out_dir), "title": "テストフォルダ選択"},
                dry_run=True,
            )
            self.assertTrue(folder_res.get("ok"), f"folder COM dry_run失敗: {folder_res}")
            self.assertTrue(folder_res.get("dry_run"))

            file_res = native_dialog._run_com_dialog_worker(
                {
                    "mode": "file",
                    "initial_dir": str(self.out_dir),
                    "title": "テストファイル選択",
                    "filter_name": "画像 (*.png;*.jpg)",
                    "filter_spec": "*.png;*.jpg",
                },
                dry_run=True,
            )
            self.assertTrue(file_res.get("ok"), f"file COM dry_run失敗: {file_res}")

        # 2. _DIALOG_LOCK 取得中に二重呼び出ししてもブロック・二重起動せず即座に None を返す
        with mock.patch.object(native_dialog, "_bring_existing_dialog_to_front") as mock_front:
            self.assertTrue(native_dialog._DIALOG_LOCK.acquire(blocking=False))
            try:
                res_busy = native_dialog.pick_native_folder_dialog(initial_dir=str(self.out_dir))
                self.assertIsNone(res_busy)
                mock_front.assert_called_once()
            finally:
                native_dialog._DIALOG_LOCK.release()

        # 3. /api/export/pick-folder が選択パスおよびキャンセル(None)を正しく返すこと
        picked_dir = str(self.out_dir)
        with mock.patch("server.routers.export_import_router.pick_folder_dialog", return_value=picked_dir) as mock_pick:
            r_ok = self.client.post("/api/export/pick-folder", json={"initial_dir": picked_dir})
            self.assertEqual(r_ok.status_code, 200)
            self.assertEqual(r_ok.json(), {"selected_path": picked_dir})
            mock_pick.assert_called_once_with(picked_dir)

        with mock.patch("server.routers.export_import_router.pick_folder_dialog", return_value=None) as mock_cancel:
            r_cancel = self.client.post("/api/export/pick-folder", json={})
            self.assertEqual(r_cancel.status_code, 200)
            self.assertEqual(r_cancel.json(), {"selected_path": None})
            mock_cancel.assert_called_once_with(None)


if __name__ == "__main__":
    unittest.main()
