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
        cls._stack = contextlib.ExitStack()
        cls._stack.enter_context(patch("server.database.switch_database_path", side_effect=_switch_db_isolated))
        cls._stack.enter_context(patch("server.database.connection.switch_database_path", side_effect=_switch_db_isolated))

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


if __name__ == "__main__":
    unittest.main()
