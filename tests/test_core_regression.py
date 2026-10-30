"""
Photo Manager コア回帰テストスイート (unittest)
本番の .cache/library.db には一切触れず、一時ディレクトリ上の隔離SQLiteデータベースを用いて
スキーマ・インデックス・重複判定・大量件数チャンク取得・フォルダ境界・非破壊編集を検証する。
"""

import os
from pathlib import Path
import sys
import tempfile
import unittest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from server.database import (
    add_tag_to_photo,
    close_thread_connection,
    get_all_duplicate_groups,
    get_connection,
    get_duplicate_photo_ids,
    get_duplicate_photos_count,
    get_duplicates_for_photo,
    get_photo_brief,
    get_photos,
    initialize_database,
    reset_photo_adjustments,
    rotate_photo,
    switch_database_path,
     update_photo_adjustments,
    update_rating,
    upsert_photo,
    upsert_photos_batch,
)
from server.database import connection as db_conn_mod


class TestCoreRegression(unittest.TestCase):
    """データベース・クエリ最適化・副作用防止の回帰テスト"""

    @classmethod
    def setUpClass(cls):
        """元のDBパスを退避し、一時ディレクトリへ切り替える"""
        cls._original_db_path = db_conn_mod.DB_PATH
        cls._temp_dir = tempfile.TemporaryDirectory()
        cls._test_db_path = Path(cls._temp_dir.name) / "test_library.db"
        switch_database_path(cls._test_db_path)
        initialize_database()

    @classmethod
    def tearDownClass(cls):
        """テスト終了後に元のDBパスへ復元し、一時ディレクトリを削除する"""
        close_thread_connection()
        switch_database_path(cls._original_db_path)
        cls._temp_dir.cleanup()

    def setUp(self):
        """各テストの前にテーブルをクリーンアップする"""
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM photo_tags")
            cursor.execute("DELETE FROM thumbnails")
            cursor.execute("DELETE FROM photos")
            conn.commit()

    def test_01_covering_index_for_duplicates(self):
        """重複判定サブクエリが idx_photos_date_size_unlinked のカバリングインデックスを使用することを確認"""
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                EXPLAIN QUERY PLAN
                SELECT date_taken, file_size
                FROM photos
                WHERE date_taken IS NOT NULL AND date_taken != '' AND file_size > 0
                  AND IFNULL(is_unlinked, 0) = 0
                GROUP BY date_taken, file_size
                HAVING COUNT(*) > 1
                """
            )
            plan_rows = [dict(r) for r in cursor.fetchall()]
            plan_detail = " ".join(str(r.get("detail", "")) for r in plan_rows)
            self.assertIn("idx_photos_date_size_unlinked", plan_detail)
            self.assertIn("COVERING INDEX", plan_detail)
            self.assertNotIn("USE TEMP B-TREE", plan_detail)

    def test_02_unlinked_photos_excluded_from_duplicates(self):
        """片方がリンク消失(is_unlinked=1)になったペアが重複として誤検知されないことを確認"""
        p1_id = upsert_photo({
            "file_path": r"C:\Photos\FolderA\IMG_0001.JPG",
            "directory_path": r"C:\Photos\FolderA",
            "file_name": "IMG_0001.JPG",
            "file_size": 5000000,
            "date_taken": "2026:05:01 12:00:00",
            "width": 6000,
            "height": 4000,
            "camera_model": "TestCam",
            "rating": 0,
        })
        p2_id = upsert_photo({
            "file_path": r"C:\Photos\FolderB\IMG_0001_copy.JPG",
            "directory_path": r"C:\Photos\FolderB",
            "file_name": "IMG_0001_copy.JPG",
            "file_size": 5000000,
            "date_taken": "2026:05:01 12:00:00",
            "width": 6000,
            "height": 4000,
            "camera_model": "TestCam",
            "rating": 0,
        })

        # 両方とも有効な状態では重複としてカウントされる
        self.assertEqual(get_duplicate_photos_count(), 2)
        self.assertEqual(len(get_duplicate_photo_ids()), 2)
        self.assertEqual(len(get_all_duplicate_groups()), 1)
        self.assertEqual(len(get_duplicates_for_photo(p1_id)), 2)

        photos_active = get_photos(stacked=False)
        self.assertEqual(len(photos_active), 2)
        self.assertEqual(photos_active[0]["duplicate_count"], 2)

        # p2 をリンク消失(is_unlinked=1)に変更
        with get_connection() as conn:
            conn.execute("UPDATE photos SET is_unlinked = 1 WHERE id = ?", (p2_id,))
            conn.commit()

        # p1 単独になるため、重複件数は 0、p1 の duplicate_count は 1 になること
        self.assertEqual(get_duplicate_photos_count(), 0)
        self.assertEqual(len(get_duplicate_photo_ids()), 0)
        self.assertEqual(len(get_all_duplicate_groups()), 0)
        self.assertEqual(len(get_duplicates_for_photo(p1_id)), 0)

        photos_after = get_photos(stacked=False)
        self.assertEqual(len(photos_after), 1)
        self.assertEqual(photos_after[0]["id"], p1_id)
        self.assertEqual(photos_after[0]["duplicate_count"], 1)

    def test_03_large_batch_chunk_query_over_999_vars(self):
        """1,200枚以上の写真を一度に取得しても SQLite の 999 パラメータ上限エラーが発生しないことを確認"""
        batch = []
        for i in range(1200):
            batch.append({
                "file_path": rf"C:\Photos\Large\IMG_{i:04d}.JPG",
                "directory_path": r"C:\Photos\Large",
                "file_name": f"IMG_{i:04d}.JPG",
                "file_size": 100000 + i,
                "date_taken": f"2026:06:01 10:{(i // 60) % 60:02d}:{i % 60:02d}",
                "width": 4000,
                "height": 3000,
                "camera_model": "BatchCam",
                "rating": 1,
            })
        upsert_photos_batch(batch)

        # 先頭と末尾の写真にタグとスタックIDを設定
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM photos ORDER BY id ASC")
            all_ids = [r["id"] for r in cursor.fetchall()]
            self.assertEqual(len(all_ids), 1200)

            # 1,050個以上の異なる stack_id を持たせて active_stack_ids のチャンク処理も検証
            for idx, pid in enumerate(all_ids[:1050]):
                cursor.execute(
                    "UPDATE photos SET stack_id = ?, is_stack_primary = 1 WHERE id = ?",
                    (idx + 1, pid),
                )
            conn.commit()

        add_tag_to_photo(all_ids[0], "風景/夏")
        add_tag_to_photo(all_ids[-1], "ポートレート")

        # limit=1500 で一括取得し、OperationalError が起きないこと
        result = get_photos(folder=r"C:\Photos\Large", limit=1500)
        self.assertEqual(len(result), 1200)

        by_id = {p["id"]: p for p in result}
        self.assertIn("風景/夏", by_id[all_ids[0]]["tags"])
        self.assertIn("ポートレート", by_id[all_ids[-1]]["tags"])

    def test_04_directory_filter_boundaries_and_wildcard_safety(self):
        """フォルダ検索でアンダースコア(_)のワイルドカード誤爆や前方一致境界バグが起きないことを確認"""
        upsert_photos_batch([
            {
                "file_path": r"C:\Photos\2026_01\A.JPG",
                "directory_path": r"C:\Photos\2026_01",
                "file_name": "A.JPG",
                "file_size": 1000,
                "date_taken": "2026:01:01 00:00:00",
                "width": 100,
                "height": 100,
            },
            {
                "file_path": r"C:\Photos\2026X01\B.JPG",
                "directory_path": r"C:\Photos\2026X01",
                "file_name": "B.JPG",
                "file_size": 2000,
                "date_taken": "2026:01:02 00:00:00",
                "width": 100,
                "height": 100,
            },
            {
                "file_path": r"C:\Photos\2026_01\Sub\C.JPG",
                "directory_path": r"C:\Photos\2026_01\Sub",
                "file_name": "C.JPG",
                "file_size": 3000,
                "date_taken": "2026:01:03 00:00:00",
                "width": 100,
                "height": 100,
            },
        ])

        # get_photos(folder=...) (配下含む): 2026_01 と Sub のみ取得され、2026X01 は混ざらないこと
        recursive_res = get_photos(folder=r"C:\Photos\2026_01")
        self.assertEqual(sorted([p["file_name"] for p in recursive_res]), ["A.JPG", "C.JPG"])

        # _directory_filter_sql(recursive=False) (直下のみ): 2026X01 や Sub が混ざらないこと
        from server.database.photos import _directory_filter_sql
        sql_frag, sql_params = _directory_filter_sql(r"C:\Photos\2026_01", recursive=False)
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(f"SELECT file_name FROM photos WHERE {sql_frag}", sql_params)
            direct_names = [r["file_name"] for r in cur.fetchall()]
        self.assertEqual(direct_names, ["A.JPG"])

    def test_05_non_destructive_adjustments_and_brief(self):
        """評価・回転・傾き微調整・クロップ・トーン補正の非破壊更新と get_photo_brief の取得項目を検証"""
        pid = upsert_photo({
            "file_path": r"C:\Photos\Adjust\TEST.JPG",
            "directory_path": r"C:\Photos\Adjust",
            "file_name": "TEST.JPG",
            "file_size": 456789,
            "file_mtime": 1700000000.0,
            "date_taken": "2026:07:01 09:00:00",
            "width": 6000,
            "height": 4000,
        })

        self.assertTrue(update_rating(pid, 2))
        rot_res = rotate_photo(pid, 90)
        self.assertTrue(rot_res["success"])
        self.assertEqual(rot_res["rotation"], 90)

        self.assertTrue(
            update_photo_adjustments(
                pid,
                rotation=90,
                fine_angle=-3.4,
                crop_x=0.1,
                crop_y=0.2,
                crop_w=0.5,
                crop_h=0.6,
                crop_aspect="3:2",
                brightness=15,
                contrast=-10,
                saturation=25,
            )
        )
        brief = get_photo_brief(pid)
        self.assertIsNotNone(brief)
        self.assertEqual(brief["rotation"], 90)
        self.assertAlmostEqual(brief["fine_angle"], -3.4)
        self.assertAlmostEqual(brief["crop_x"], 0.1)
        self.assertAlmostEqual(brief["crop_y"], 0.2)
        self.assertAlmostEqual(brief["crop_w"], 0.5)
        self.assertAlmostEqual(brief["crop_h"], 0.6)
        self.assertEqual(brief["crop_aspect"], "3:2")
        self.assertEqual(brief["brightness"], 15)
        self.assertEqual(brief["contrast"], -10)
        self.assertEqual(brief["saturation"], 25)

        self.assertTrue(reset_photo_adjustments(pid))
        brief_after = get_photo_brief(pid)
        self.assertEqual(brief_after["rotation"], 0)
        self.assertAlmostEqual(brief_after["fine_angle"], 0.0)
        self.assertIsNone(brief_after["crop_w"])
        self.assertEqual(brief_after["brightness"], 0)
        self.assertEqual(brief_after["contrast"], 0)
        self.assertEqual(brief_after["saturation"], 0)

    def test_06_smart_takeout_exif_sync_and_fine_adjustments(self):
        """スマートテイクアウトのExif DB同期（GPS書き込み・削除・Orientation正規化）と非破壊微調整の焼き込みを検証"""
        from PIL import Image
        from server.exporter import export_single_photo
        from server.scanner import extract_metadata

        with tempfile.TemporaryDirectory() as work_dir:
            src_path = os.path.join(work_dir, "SRC_TEST.JPG")
            out_dir = Path(work_dir) / "out"
            out_dir.mkdir(parents=True, exist_ok=True)

            # 元画像（800x600、Exifにモデル名と撮影日時のみ、GPSなし）を作成
            img = Image.new("RGB", (800, 600), color=(80, 120, 160))
            exif = Image.Exif()
            exif[0x0110] = "PhotoManagerTestCam"
            exif[0x0112] = 1
            exif.get_ifd(0x8769)[0x9003] = "2026:08:15 14:30:00"
            img.save(src_path, format="JPEG", quality=92, exif=exif.tobytes())

            # 1. DBでGPS座標(東京)・90度回転・水平出し(+2.5°)・トーン補正を設定して書き出し (apply_adjustments=True)
            photo_record = {
                "id": 9991,
                "file_path": src_path,
                "file_name": "SRC_TEST.JPG",
                "date_taken": "2026:08:15 14:30:00",
                "camera_model": "PhotoManagerTestCam",
                "rating": 2,
                "latitude": 35.6895,
                "longitude": 139.6917,
                "rotation": 90,
                "fine_angle": 2.5,
                "crop_x": None,
                "crop_y": None,
                "crop_w": None,
                "crop_h": None,
                "brightness": 20,
                "contrast": 10,
                "saturation": 15,
            }
            ok1, out_name1, err1 = export_single_photo(
                photo=photo_record,
                opts={
                    "naming_rule": "custom_seq",
                    "custom_prefix": "adj",
                    "resize_mode": "original",
                    "format": "jpeg",
                    "quality": 90,
                    "exif_remove_all": False,
                    "exif_remove_gps": False,
                    "exif_remove_camera": False,
                    "exif_remove_exposure": False,
                    "exif_remove_other": False,
                    "exif_sync_db": True,
                    "apply_adjustments": True,
                },
                index=0,
                dest_dir=out_dir,
            )
            self.assertTrue(ok1, err1)
            dest_path1 = out_dir / out_name1
            meta1 = extract_metadata(dest_path1)
            self.assertIsNotNone(meta1["latitude"])
            self.assertIsNotNone(meta1["longitude"])
            self.assertAlmostEqual(meta1["latitude"], 35.6895, places=3)
            self.assertAlmostEqual(meta1["longitude"], 139.6917, places=3)
            self.assertEqual(meta1["camera_model"], "PhotoManagerTestCam")
            self.assertEqual(meta1["date_taken"], "2026-08-15 14:30:00")
            # 90度回転がピクセルに適用されたため縦長(width < height)になり、Orientationは1に正規化されていること
            self.assertLess(meta1["width"], meta1["height"])
            with Image.open(dest_path1) as check_img1:
                self.assertEqual(check_img1.getexif().get(0x0112), 1)

            # 2. apply_adjustments=False の場合、ピクセルは回転せず Exif Orientation タグに 90度(6) が書き込まれること
            ok2, out_name2, err2 = export_single_photo(
                photo=photo_record,
                opts={
                    "naming_rule": "custom_seq",
                    "custom_prefix": "noadj",
                    "resize_mode": "original",
                    "format": "jpeg",
                    "quality": 90,
                    "exif_remove_all": False,
                    "exif_remove_gps": False,
                    "exif_remove_camera": False,
                    "exif_remove_exposure": False,
                    "exif_remove_other": False,
                    "exif_sync_db": True,
                    "apply_adjustments": False,
                },
                index=1,
                dest_dir=out_dir,
            )
            self.assertTrue(ok2, err2)
            dest_path2 = out_dir / out_name2
            with Image.open(dest_path2) as check_img2:
                self.assertEqual(check_img2.size, (800, 600))
                self.assertEqual(check_img2.getexif().get(0x0112), 6)

            # 3. 元画像にGPSがある状態で、DB側のGPSが削除(None)された場合、書き出し画像のGPSも消去されること
            photo_record_no_gps = dict(photo_record)
            photo_record_no_gps["file_path"] = str(dest_path1)  # GPS入りの画像をソースにする
            photo_record_no_gps["latitude"] = None
            photo_record_no_gps["longitude"] = None
            ok3, out_name3, err3 = export_single_photo(
                photo=photo_record_no_gps,
                opts={
                    "naming_rule": "custom_seq",
                    "custom_prefix": "gps_cleared",
                    "resize_mode": "original",
                    "format": "jpeg",
                    "quality": 90,
                    "exif_remove_all": False,
                    "exif_remove_gps": False,
                    "exif_remove_camera": False,
                    "exif_remove_exposure": False,
                    "exif_remove_other": False,
                    "exif_sync_db": True,
                    "apply_adjustments": True,
                },
                index=2,
                dest_dir=out_dir,
            )
            self.assertTrue(ok3, err3)
            dest_path3 = out_dir / out_name3
            meta3 = extract_metadata(dest_path3)
            self.assertIsNone(meta3["latitude"])
            self.assertIsNone(meta3["longitude"])

    def test_standalone_mobile_html_bundle_and_security(self) -> None:
        """単体完結型モバイルHTML (PhotoManager_Mobile.html) の完全インライン化とセキュリティ制約の検証"""
        from server.mobile_bundle import build_standalone_mobile_html, ensure_standalone_mobile_html
        from server.app import _sanitize_mobile_tag

        html = build_standalone_mobile_html()
        # 1. 外部CSS/JS/WASM参照が残っておらず、すべてインライン化されていること
        self.assertNotIn('href="/css/mobile.css', html)
        self.assertNotIn('src="/vendor/sqljs/sql-wasm.js', html)
        self.assertNotIn('src="/js/mobile.js', html)
        self.assertNotIn('rel="manifest"', html)

        # 2. CSPメタタグ、WASM Base64、単体フラグ、安全ストレージラッパーが含まれていること
        self.assertIn('http-equiv="Content-Security-Policy"', html)
        self.assertIn("object-src 'none'", html)
        self.assertIn("window.__PM_STANDALONE_HTML__ = true;", html)
        self.assertIn('window.__PM_SQL_WASM_BASE64__ = "', html)
        self.assertIn("function _safeGetStorage(", html)
        self.assertIn("function _safeSetStorage(", html)

        # 3. ファイル出力確認
        out_path = ensure_standalone_mobile_html(force=True)
        self.assertIsNotNone(out_path)
        self.assertTrue(out_path.exists())
        self.assertGreater(out_path.stat().st_size, 800 * 1024)

        # 4. モバイル同期タグのサニタイズ検証
        self.assertEqual(_sanitize_mobile_tag("旅行/2026/京都"), "旅行/2026/京都")
        self.assertEqual(_sanitize_mobile_tag("  <script>alert(1)</script>風景\x00  "), "scriptalert(1)/script風景")
        self.assertEqual(_sanitize_mobile_tag(""), "")

        # 5. 完全オフラインQRコード(SVG)生成検証
        from server.qr_svg import generate_qr_svg, generate_qr_matrix
        mat = generate_qr_matrix("http://192.168.0.15:8088/m")
        self.assertEqual(len(mat), 25)  # 26 bytes -> Version 2 (25x25)
        svg = generate_qr_svg("http://192.168.0.15:8088/m")
        self.assertIn("<svg", svg)
        self.assertIn("</svg>", svg)

        # 6. Androidで隠しフォルダにならないドットなし `cache/library.db` 構成の検証
        self.assertEqual(self._original_db_path.parent.name, "cache")
        self.assertEqual(self._original_db_path.name, "library.db")
        self.assertIn("cache/library.db", html)
        self.assertNotIn(".cache/library.db", html)

    def test_08_camera_lens_tree_lab_heatmap_and_contact_sheet(self) -> None:
        """カメラ・レンズ階層排他検索、ラボ分析・太陽高度・手ブレ抽出、47都道府県白地図ヒートマップ、ベタ焼きHTML出力の総合検証"""
        from server.database import (
            get_cameras_summary,
            get_lab_karte_data,
            get_location_heatmap_data,
            get_random_unrated_folder,
            save_thumbnail,
        )
        from server.exporter import run_contact_sheet_export

        # 1. テスト写真データの登録（カメラ2種、レンズ3種、ゴールデンアワー、手ブレ危険、ジオタグ付き）
        p1 = upsert_photo({
            "file_path": r"C:\Photos\Trip_Tokyo\DSC0001.JPG",
            "directory_path": r"C:\Photos\Trip_Tokyo",
            "file_name": "DSC0001.JPG",
            "file_size": 3000000,
            "date_taken": "2026:10:20 16:45:00",  # 東京の10月20日16:45は日没直前（ゴールデンアワー）
            "width": 6000,
            "height": 4000,
            "camera_model": "SONY ILCE-7RM5",
            "lens_model": "FE 24-70mm F2.8 GM II",
            "focal_length": 35.0,
            "f_number": 2.8,
            "shutter_speed": "1/250",
            "iso": 100,
            "latitude": 35.6895,
            "longitude": 139.6917,
            "country": "日本",
            "state": "東京都",
            "city": "新宿区",
            "rating": 2,  # 優
        })
        p2 = upsert_photo({
            "file_path": r"C:\Photos\Trip_Tokyo\DSC0002.JPG",
            "directory_path": r"C:\Photos\Trip_Tokyo",
            "file_name": "DSC0002.JPG",
            "file_size": 3200000,
            "date_taken": "2026:10:20 21:15:00",  # 夜間 + 200mmで1/30秒（手ブレ危険: 200 * (1/30) = 6.67 >= 1.0）
            "width": 6000,
            "height": 4000,
            "camera_model": "SONY ILCE-7RM5",
            "lens_model": "FE 70-200mm F2.8 GM OSS II",
            "focal_length": 200.0,
            "f_number": 2.8,
            "shutter_speed": "1/30",
            "iso": 3200,
            "latitude": 35.6900,
            "longitude": 139.7000,
            "country": "日本",
            "state": "東京",  # 表記ゆれ（「東京都」に正規化されること）
            "city": "新宿区",
            "rating": 0,  # 未整理(可)
        })
        p3 = upsert_photo({
            "file_path": r"C:\Photos\Trip_Kyoto\IMG_0100.JPG",
            "directory_path": r"C:\Photos\Trip_Kyoto",
            "file_name": "IMG_0100.JPG",
            "file_size": 2800000,
            "date_taken": "2025:05:10 11:30:00",
            "width": 5000,
            "height": 3333,
            "camera_model": "RICOH GR IIIx",
            "lens_model": None,  # レンズ情報なし (__NONE__)
            "focal_length": 40.0,
            "f_number": 5.6,
            "shutter_speed": "1/500",
            "iso": 200,
            "latitude": 35.0116,
            "longitude": 135.7681,
            "country": "日本",
            "state": "京都府",
            "city": "京都市",
            "rating": 1,  # 良
        })
        update_rating(p1, 2)
        update_rating(p3, 1)

        # 2. カメラ＆レンズ階層ツリー集計の検証
        cams = get_cameras_summary()
        self.assertEqual(len(cams), 2)
        sony_cam = next(c for c in cams if c["camera_model"] == "SONY ILCE-7RM5")
        self.assertEqual(sony_cam["count"], 2)
        self.assertEqual(len(sony_cam["lenses"]), 2)
        ricoh_cam = next(c for c in cams if c["camera_model"] == "RICOH GR IIIx")
        self.assertEqual(ricoh_cam["lenses"][0]["lens_model"], "__NONE__")

        # 3. カメラ・レンズ排他検索 ([+] 含む / [-] 除外) の検証
        # SONY を含み、70-200mm を除外 -> p1 のみヒット
        res_cam_excl_lens = get_photos(
            cameras=["SONY ILCE-7RM5"],
            excluded_lenses=["SONY ILCE-7RM5::FE 70-200mm F2.8 GM OSS II"],
        )
        self.assertEqual([p["id"] for p in res_cam_excl_lens], [p1])

        # レンズ情報なし (__NONE__) で絞り込み -> p3 のみヒット
        res_none_lens = get_photos(lenses=["RICOH GR IIIx::__NONE__"])
        self.assertEqual([p["id"] for p in res_none_lens], [p3])

        # 4. ラボ特殊フィルタ（手ブレ危険・ゴールデンアワー・夜景・歴代の今日・焦点距離/F値レンジ）の検証
        res_shake = get_photos(lab_filter="shake_risk")
        self.assertEqual([p["id"] for p in res_shake], [p2])

        res_golden = get_photos(lab_filter="golden_hour")
        self.assertEqual([p["id"] for p in res_golden], [p1])

        res_night = get_photos(lab_filter="night")
        self.assertEqual([p["id"] for p in res_night], [p2])

        res_otd = get_photos(on_this_day="10-20")
        self.assertEqual(sorted([p["id"] for p in res_otd]), sorted([p1, p2]))

        res_focal = get_photos(focal_range="135.1-300")
        self.assertEqual([p["id"] for p in res_focal], [p2])

        res_aperture = get_photos(aperture_range="0.7-2.8")
        self.assertEqual(sorted([p["id"] for p in res_aperture]), sorted([p1, p2]))

        # 5. 47都道府県制覇白地図＆ヒートマップ＆撮影軌跡APIの検証
        heatmap = get_location_heatmap_data()
        self.assertEqual(heatmap["conquered_prefectures_count"], 2)  # 東京都・京都府
        pref_names = {p["prefecture"] for p in heatmap["prefectures"]}
        self.assertEqual(pref_names, {"東京都", "京都府"})
        self.assertEqual(heatmap["total_geotagged"], 3)
        self.assertGreaterEqual(len(heatmap["grid_points"]), 2)
        self.assertGreaterEqual(len(heatmap["trajectory_points"]), 3)

        # 6. ラボカルテ＆未整理フォルダ発掘ガチャの検証
        karte = get_lab_karte_data(today_mmdd="10-20")
        self.assertEqual(karte["summary"]["total_photos"], 3)
        self.assertEqual(karte["summary"]["excellent_count"], 1)
        self.assertEqual(karte["summary"]["shake_risk_count"], 1)
        self.assertEqual(karte["summary"]["on_this_day_count"], 2)
        self.assertGreaterEqual(len(karte["lenses"]), 2)

        gacha = get_random_unrated_folder()
        self.assertTrue(gacha["found"])
        self.assertEqual(gacha["folder_path"], r"C:\Photos\Trip_Tokyo")
        self.assertEqual(gacha["unrated_count"], 1)

        # 7. ベタ焼き（コンタクトシート）HTML出力の検証
        # ダミーWebPバイナリを保存
        save_thumbnail(p1, b"RIFF\x1a\x00\x00\x00WEBPVP8 \x0e\x00\x00\x000\x01\x00\x9d\x01*\x01\x00\x01\x00\x02\x004%\xa4\x00\x03p\x00\xfe\xfb\x94\x00\x00", 160, 120)
        with tempfile.TemporaryDirectory() as cs_dir:
            cs_res = run_contact_sheet_export({
                "photo_ids": [p1, p2, p3],
                "title": "Test Contact Sheet",
                "theme": "darkroom",
                "columns": 5,
                "destination_dir": cs_dir,
                "open_after": False,
            })
            self.assertEqual(cs_res["status"], "ok")
            self.assertEqual(cs_res["exported_count"], 3)
            out_html_path = Path(cs_res["output_path"])
            self.assertTrue(out_html_path.exists())
            html_text = out_html_path.read_text(encoding="utf-8")
            self.assertIn("Test Contact Sheet", html_text)
            self.assertIn("DSC0001.JPG", html_text)
            self.assertIn("FE 24-70mm F2.8 GM II", html_text)
            self.assertIn("data:image/webp;base64,", html_text)

    def test_09_tag_filter_same_root_or_and_different_root_and(self):
        """階層タグフィルタで最上位親が同じタグ同士はOR条件、異なる親グループや最上位タグ同士はAND条件になることを検証"""
        p_cx5 = upsert_photo({
            "file_path": r"C:\Photos\Cars\CX5.JPG",
            "directory_path": r"C:\Photos\Cars",
            "file_name": "CX5.JPG",
            "file_size": 1000,
            "date_taken": "2026:10:01 10:00:00",
        })
        p_prius = upsert_photo({
            "file_path": r"C:\Photos\Cars\PRIUS.JPG",
            "directory_path": r"C:\Photos\Cars",
            "file_name": "PRIUS.JPG",
            "file_size": 2000,
            "date_taken": "2026:10:02 10:00:00",
        })
        p_roadster = upsert_photo({
            "file_path": r"C:\Photos\Cars\ROADSTER.JPG",
            "directory_path": r"C:\Photos\Cars",
            "file_name": "ROADSTER.JPG",
            "file_size": 3000,
            "date_taken": "2026:10:03 10:00:00",
        })

        # タグ付与（add_tag_to_photo により祖先ノードも自動保存される）
        add_tag_to_photo(p_cx5, "車/Mazda/CX-5")
        add_tag_to_photo(p_cx5, "季節/秋")
        add_tag_to_photo(p_cx5, "お気に入り")

        add_tag_to_photo(p_prius, "車/Toyota/Prius")
        add_tag_to_photo(p_prius, "季節/秋")

        add_tag_to_photo(p_roadster, "車/Mazda/Roadster")
        add_tag_to_photo(p_roadster, "季節/夏")
        add_tag_to_photo(p_roadster, "お気に入り")

        # 1. 最上位の親（"車"）が同じ3階層タグ同士（車/Mazda/CX-5 と 車/Toyota/Prius）-> OR 条件で2枚ヒット
        res_same_root = get_photos(included_tags=["車/Mazda/CX-5", "車/Toyota/Prius"], stacked=False)
        self.assertEqual(sorted([p["id"] for p in res_same_root]), sorted([p_cx5, p_prius]))

        # 2. 同じ "車" グループの2つ（OR） ＋ 別グループ "季節/秋"（AND） -> p_cx5 と p_prius がヒット（季節/夏の p_roadster は除外）
        res_or_and = get_photos(
            included_tags=["車/Mazda/CX-5", "車/Mazda/Roadster", "季節/秋"],
            stacked=False,
        )
        self.assertEqual([p["id"] for p in res_or_and], [p_cx5])

        # 3. 親を持たない最上位タグ同士（"車" と "お気に入り"） -> 従来通り AND 条件で p_cx5 と p_roadster がヒット
        res_top_and = get_photos(included_tags=["車", "お気に入り"], stacked=False)
        self.assertEqual(sorted([p["id"] for p in res_top_and]), sorted([p_cx5, p_roadster]))

        # 4. 親タグ自身（"車"）とその子孫タグ（"車/Mazda/CX-5"）を同時に選択した場合 -> 子孫の具体的な絞り込みが優先される
        res_parent_and_child = get_photos(included_tags=["車", "車/Mazda/CX-5"], stacked=False)
        self.assertEqual([p["id"] for p in res_parent_and_child], [p_cx5])

        # 5. 「車/Toyota」を [+]、「車/Toyota/Prius」を [-]、「車/Mazda/Roadster」と「車/Mazda/CX-5」を [+] にした場合
        #    -> プリウス以外のトヨタ車（Crown）＋ ロードスター ＋ CX-5 が表示され、Prius と Mazda3 は除外される
        p_crown = upsert_photo({
            "file_path": r"C:\Photos\Cars\CROWN.JPG",
            "directory_path": r"C:\Photos\Cars",
            "file_name": "CROWN.JPG",
            "file_size": 4000,
            "date_taken": "2026:10:04 10:00:00",
        })
        p_mazda3 = upsert_photo({
            "file_path": r"C:\Photos\Cars\MAZDA3.JPG",
            "directory_path": r"C:\Photos\Cars",
            "file_name": "MAZDA3.JPG",
            "file_size": 5000,
            "date_taken": "2026:10:05 10:00:00",
        })
        add_tag_to_photo(p_crown, "車/Toyota/Crown")
        add_tag_to_photo(p_mazda3, "車/Mazda/Mazda3")

        res_mixed = get_photos(
            included_tags=["車/Toyota", "車/Mazda/Roadster", "車/Mazda/CX-5"],
            excluded_tags=["車/Toyota/Prius"],
            stacked=False,
        )
        self.assertEqual(
            sorted([p["id"] for p in res_mixed]),
            sorted([p_crown, p_roadster, p_cx5]),
        )

        # 6. 同グループ内のORをANDに切り替えた場合（tag_and_roots=["車"]）
        #    -> p_collab に「車/Toyota/Crown」と「車/Mazda/Roadster」の両方を付与し、両方持つ写真のみヒットすることを検証
        p_collab = upsert_photo({
            "file_path": r"C:\Photos\Cars\COLLAB.JPG",
            "directory_path": r"C:\Photos\Cars",
            "file_name": "COLLAB.JPG",
            "file_size": 6000,
            "date_taken": "2026:10:06 10:00:00",
        })
        add_tag_to_photo(p_collab, "車/Toyota/Crown")
        add_tag_to_photo(p_collab, "車/Mazda/Roadster")

        res_intra_and = get_photos(
            included_tags=["車/Toyota/Crown", "車/Mazda/Roadster"],
            tag_and_roots=["車"],
            stacked=False,
        )
        self.assertEqual([p["id"] for p in res_intra_and], [p_collab])

        # 7. 異グループ間のANDをORに切り替えた場合（tag_group_op="or"）
        #    -> 「車: Toyota（除く: − Prius）」または「季節: 夏」で p_crown, p_collab, p_roadster がヒットし、p_prius は除外される
        res_inter_or = get_photos(
            included_tags=["車/Toyota", "季節/夏"],
            excluded_tags=["車/Toyota/Prius"],
            tag_group_op="or",
            stacked=False,
        )
        self.assertEqual(
            sorted([p["id"] for p in res_inter_or]),
            sorted([p_crown, p_collab, p_roadster]),
        )


if __name__ == "__main__":
    unittest.main()



