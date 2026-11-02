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

    def test_01b_duplicate_match_query_uses_indexes(self):
        """重複照合（date_taken OR original_date_taken）と VSN 復帰照合が全件スキャンにならないことを確認"""
        with get_connection() as conn:
            plan = " ".join(
                str(dict(r).get("detail", ""))
                for r in conn.execute(
                    "EXPLAIN QUERY PLAN SELECT * FROM photos WHERE file_size = ? AND (date_taken = ? OR original_date_taken = ?) AND id != ?",
                    (1, "a", "a", 0),
                ).fetchall()
            )
            self.assertIn("MULTI-INDEX OR", plan)
            self.assertNotIn("SCAN photos", plan)
            plan_vsn = " ".join(
                str(dict(r).get("detail", ""))
                for r in conn.execute(
                    "EXPLAIN QUERY PLAN SELECT id FROM photos WHERE volume_serial = ? AND file_name = ?", ("A", "B")
                ).fetchall()
            )
            self.assertIn("idx_photos_volume_name", plan_vsn)

    def test_02_unlinked_photos_excluded_from_duplicates(self):
        """同一画像が1つのphotosエンティティ＋複数photo_linksに統合され、片方リンク削除時に重複解除されることを確認"""
        from server.database import remove_folder_photos
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

        # 同一画像は同一の photo_id に統合され、photo_links が 2 件になること
        self.assertEqual(p1_id, p2_id)
        self.assertEqual(get_duplicate_photos_count(), 1)
        self.assertEqual(len(get_duplicate_photo_ids()), 1)
        self.assertEqual(len(get_all_duplicate_groups()), 1)
        self.assertEqual(len(get_duplicates_for_photo(p1_id)), 2)

        photos_active = get_photos(stacked=False)
        self.assertEqual(len(photos_active), 1)
        self.assertEqual(photos_active[0]["duplicate_count"], 2)

        # FolderB 側のリンクを削除（片方のフォルダから消えた状態）
        remove_folder_photos(r"C:\Photos\FolderB")

        # FolderA のみ残るため、重複件数は 0、p1 の duplicate_count は 1 になること
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

        # 3. ファイル出力確認（本番の Tetheract_Mobile.html を汚さないよう一時パスへ出力）
        import unittest.mock as _mock
        temp_mobile_html = Path(self._temp_dir.name) / "Tetheract_Mobile.html"
        with _mock.patch("server.mobile_bundle.STANDALONE_HTML_PATH", temp_mobile_html):
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


    def test_color_tags_excluded_from_untagged_and_tag_keys_migration(self) -> None:
        """
        1. 12色カラータグのみが付与された写真は「未分類（untagged_only）」として扱われること
        2. 既存ユーザーのレガシーDBに対する tag_keys_v1 マイグレーションで事前バックアップ生成・tag_key 採番・プリセット引き継ぎが安全に行われること
        3. タグのリネーム・階層移動時に tag_key / short_name / is_pinned および保存済みプリセットが完全維持されること
        4. モバイル同期 (_apply_mobile_sync_changes) で PC側リネーム後のタグへ tag_key 解決されること
        """
        import json
        import sqlite3
        from server.database import (
            close_thread_connection,
            create_filter_preset,
            get_all_tags_summary,
            get_connection,
            get_filter_presets,
            get_tag_key_map,
            get_untagged_count,
            initialize_database,
            rename_tag,
            update_tag_metadata,
        )
        from server.app import _apply_mobile_sync_changes

        # --- Step 1: レガシーDB（tag_keys_v1 適用前）の状態を再現してマイグレーションを検証 ---
        close_thread_connection()
        legacy_db_path = Path(self._temp_dir.name) / "legacy_user.db"
        raw_conn = sqlite3.connect(str(legacy_db_path))
        raw_cur = raw_conn.cursor()
        raw_cur.execute(
            """
            CREATE TABLE photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
                file_name TEXT NOT NULL,
                directory_path TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                width INTEGER,
                height INTEGER,
                date_taken TEXT,
                year_month TEXT,
                camera_model TEXT,
                rating INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0,
                is_raw INTEGER DEFAULT 0,
                paired_raw_path TEXT,
                is_unlinked INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        raw_cur.execute(
            """
            CREATE TABLE photo_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                source TEXT DEFAULT 'manual',
                confidence REAL DEFAULT 1.0,
                UNIQUE(photo_id, tag)
            )
            """
        )
        # 旧スキーマの tag_definitions（tag_key, short_name, is_pinned カラムなし）
        raw_cur.execute(
            """
            CREATE TABLE tag_definitions (
                tag TEXT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        raw_cur.execute(
            """
            CREATE TABLE filter_presets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT DEFAULT '',
                filters TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        raw_cur.execute(
            """
            CREATE TABLE migrations (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # 既存写真3枚＋タグ＋空タグ定義＋プリセットを投入
        raw_cur.execute(
            "INSERT INTO photos (id, file_path, file_name, directory_path, file_size, date_taken) VALUES (1, 'C:\\Legacy\\P1.JPG', 'P1.JPG', 'C:\\Legacy', 1000, '2026:05:01 10:00:00')"
        )
        raw_cur.execute(
            "INSERT INTO photos (id, file_path, file_name, directory_path, file_size, date_taken) VALUES (2, 'C:\\Legacy\\P2.JPG', 'P2.JPG', 'C:\\Legacy', 2000, '2026:05:02 10:00:00')"
        )
        raw_cur.execute(
            "INSERT INTO photos (id, file_path, file_name, directory_path, file_size, date_taken) VALUES (3, 'C:\\Legacy\\P3.JPG', 'P3.JPG', 'C:\\Legacy', 3000, '2026:05:03 10:00:00')"
        )
        # P1: 階層タグ「イベント/運動会/2025」＋ カラータグ「赤」
        raw_cur.execute("INSERT INTO photo_tags (photo_id, tag) VALUES (1, 'イベント/運動会/2025')")
        raw_cur.execute("INSERT INTO photo_tags (photo_id, tag) VALUES (1, '赤')")
        # P2: カラータグ「青」と「金・ゴールド」のみ（一般タグなし -> 未分類扱いになるべき）
        raw_cur.execute("INSERT INTO photo_tags (photo_id, tag) VALUES (2, '青')")
        raw_cur.execute("INSERT INTO photo_tags (photo_id, tag) VALUES (2, '金・ゴールド')")
        # P3: タグ一切なし（未分類）
        # 空のタグ定義
        raw_cur.execute("INSERT INTO tag_definitions (tag) VALUES ('家族/旅行')")
        # 旧形式プリセット（tagFilterKeys なし）
        legacy_preset_filters = json.dumps({
            "tagFilters": {"イベント/運動会/2025": "include", "赤": "include"},
            "untaggedOnly": False,
        }, ensure_ascii=False)
        raw_cur.execute(
            "INSERT INTO filter_presets (name, filters) VALUES ('運動会セット', ?)",
            (legacy_preset_filters,),
        )
        raw_conn.commit()
        raw_conn.close()

        # レガシーDBへ接続を切り替えてマイグレーション実行
        prev_db = switch_database_path(legacy_db_path)
        try:
            initialize_database()

            # 1. 事前安全バックアップが自動作成されていること
            backup_dir = legacy_db_path.parent / "backups"
            backups = list(backup_dir.glob("library_pre_tag_keys_v1_*.db"))
            self.assertEqual(len(backups), 1, "マイグレーション前の自動バックアップが生成されていること")

            # 2. 全一般タグ（祖先ノード含む）にユニークな tag_key が発行され、カラータグは tag_definitions に混入していないこと
            key_map = get_tag_key_map()
            for expected_tag in ("イベント", "イベント/運動会", "イベント/運動会/2025", "家族", "家族/旅行"):
                self.assertIn(expected_tag, key_map)
                self.assertTrue(key_map[expected_tag].startswith("tk_"))
            self.assertNotIn("赤", key_map)
            self.assertNotIn("青", key_map)
            self.assertNotIn("金・ゴールド", key_map)

            # 冪等性チェック: 再度 initialize_database() を呼んでも tag_key が変わらないこと
            old_key_undokai = key_map["イベント/運動会/2025"]
            old_key_parent = key_map["イベント/運動会"]
            initialize_database()
            self.assertEqual(get_tag_key_map()["イベント/運動会/2025"], old_key_undokai)

            # 3. カラータグのみが付与された写真(P2)とタグなし写真(P3)、さらにAIタグのみ付与した場合も「未分類」に含まれること
            from server.database import add_ai_tags_to_photo, promote_ai_tag
            add_ai_tags_to_photo(2, [{"tag": "風景・自然", "confidence": 0.85}])
            self.assertEqual(get_untagged_count(), 2)
            untagged_photos = get_photos(untagged_only=True, stacked=False)
            self.assertEqual(sorted([p["id"] for p in untagged_photos]), [2, 3])

            # AIタグを手動タグへ昇格（確定）すると「未分類」から外れ、後に削除すると再び未分類に戻ること
            promote_ai_tag(2, "風景・自然")
            self.assertEqual(get_untagged_count(), 1)
            from server.database import remove_tag_from_photo
            remove_tag_from_photo(2, "風景・自然")
            self.assertEqual(get_untagged_count(), 2)

            # 未分類フィルタ ＋ カラータグ「青」の絞り込みを併用した場合、P2 のみがヒットすること
            untagged_blue = get_photos(untagged_only=True, included_tags=["青"], stacked=False)
            self.assertEqual([p["id"] for p in untagged_blue], [2])

            # 4. ショート名・ピン留めの設定と、親タグリネーム・階層移動時の完全引き継ぎ検証
            meta_updated = update_tag_metadata(
                tag="イベント/運動会/2025",
                short_name="運25",
                is_pinned=True,
            )
            self.assertEqual(meta_updated["tag_key"], old_key_undokai)
            self.assertEqual(meta_updated["short_name"], "運25")
            self.assertTrue(meta_updated["is_pinned"])

            # 親タグ「イベント/運動会」を「学校行事/スポーツ」へ階層移動・リネーム
            rename_tag("イベント/運動会", "学校行事/スポーツ")

            tags_summary = {t["tag"]: t for t in get_all_tags_summary()}
            self.assertIn("学校行事/スポーツ/2025", tags_summary)
            moved_leaf = tags_summary["学校行事/スポーツ/2025"]
            self.assertEqual(moved_leaf["tag_key"], old_key_undokai, "リネーム・階層移動後も固有キー tag_key が不変であること")
            self.assertEqual(moved_leaf["short_name"], "運25", "リネーム・階層移動後も short_name が引き継がれること")
            self.assertTrue(moved_leaf["is_pinned"], "リネーム・階層移動後も is_pinned が引き継がれること")
            self.assertEqual(tags_summary["学校行事/スポーツ"]["tag_key"], old_key_parent)

            # 5. 保存済みフィルタプリセット「運動会セット」のタグ条件が自動的に新パスへ追従していること
            presets = get_filter_presets()
            self.assertEqual(len(presets), 1)
            pf = presets[0]["filters"]
            self.assertIn("学校行事/スポーツ/2025", pf["tagFilters"])
            self.assertNotIn("イベント/運動会/2025", pf["tagFilters"])
            self.assertEqual(pf["tagFilters"]["赤"], "include")

            # 6. モバイル同期: スマホ側が古いタグ名「イベント/運動会/2025」のままでも tag_key により最新名「学校行事/スポーツ/2025」としてP3に付与されること
            sync_res = _apply_mobile_sync_changes([
                {
                    "photo_id": 3,
                    "file_name": "P3.JPG",
                    "add_tags": ["イベント/運動会/2025"],
                    "add_tag_keys": {old_key_undokai: "イベント/運動会/2025"},
                }
            ])
            self.assertEqual(sync_res["applied_count"], 1)
            p3_after = get_photos(included_tags=["学校行事/スポーツ/2025"], stacked=False)
            self.assertEqual(sorted([p["id"] for p in p3_after]), [1, 3])
        finally:
            switch_database_path(prev_db)

    def test_12_calendar_summary_and_date_or_filtering(self):
        """日別カレンダー集計 get_calendar_summary() と、year_months / dates の OR 結合フィルタを検証"""
        from server.database import get_calendar_summary

        p1 = upsert_photo({
            "file_path": r"C:\Photos\2024\IMG_20240510_1.JPG",
            "directory_path": r"C:\Photos\2024",
            "file_name": "IMG_20240510_1.JPG",
            "file_size": 1000,
            "date_taken": "2024:05:10 10:00:00",
            "rating": 1,
            "state": "北海道",
            "city": "小樽市",
        })
        p2 = upsert_photo({
            "file_path": r"C:\Photos\2025\IMG_20251015_1.JPG",
            "directory_path": r"C:\Photos\2025",
            "file_name": "IMG_20251015_1.JPG",
            "file_size": 2000,
            "date_taken": "2025:10:15 09:00:00",
            "rating": 0,
            "state": "京都府",
            "city": "京都市",
        })
        p3 = upsert_photo({
            "file_path": r"C:\Photos\2025\IMG_20251015_2.JPG",
            "directory_path": r"C:\Photos\2025",
            "file_name": "IMG_20251015_2.JPG",
            "file_size": 3000,
            "date_taken": "2025:10:15 15:30:00",
            "rating": 2,
            "state": "京都府",
            "city": "宇治市",
        })
        p4 = upsert_photo({
            "file_path": r"C:\Photos\2025\IMG_20251020_1.JPG",
            "directory_path": r"C:\Photos\2025",
            "file_name": "IMG_20251020_1.JPG",
            "file_size": 4000,
            "date_taken": "2025-10-20 18:00:00",
        })
        update_rating(p1, 1)
        update_rating(p3, 2)

        summary = get_calendar_summary()
        by_date = {item["date"]: item for item in summary}
        self.assertIn("2024-05-10", by_date)
        self.assertIn("2025-10-15", by_date)
        self.assertIn("2025-10-20", by_date)

        day_1015 = by_date["2025-10-15"]
        self.assertEqual(day_1015["count"], 2)
        self.assertEqual(day_1015["excellent_count"], 1)
        # 評価「優 (2)」の p3 がその日の代表写真として選出されること
        self.assertEqual(day_1015["rep_photo_id"], p3)
        self.assertIn("京都府", day_1015["location_label"])

        # 単一日付フィルタ
        only_1015 = get_photos(dates=["2025-10-15"], stacked=False)
        self.assertEqual(sorted([p["id"] for p in only_1015]), sorted([p2, p3]))

        # ハイフン区切りの date_taken でも一致すること
        only_1020 = get_photos(dates=["2025-10-20"], stacked=False)
        self.assertEqual([p["id"] for p in only_1020], [p4])

        # 年月 (2024-05) と 特定日 (2025-10-15) の OR 結合フィルタ
        combined = get_photos(year_months=["2024-05"], dates=["2025-10-15"], stacked=False)
        self.assertEqual(sorted([p["id"] for p in combined]), sorted([p1, p2, p3]))

    def test_13_full_metadata_inheritance_on_duplicate_or_move(self):
        """SDカード等で付与した全メタデータ（評価・タグ・非破壊調整・後付けGPS・日時シフト・サムネイル・RAWペア）が別フォルダへの移動/コピー時に完全引き継ぎされることを検証"""
        from server.database import (
            add_ai_tags_to_photo,
            batch_shift_photo_dates,
            copy_metadata_to_duplicate,
            find_duplicate_photo_match,
            get_photo_by_id,
             get_thumbnail,
            save_thumbnail,
            update_photo_gps,
        )
        from server.scanner import smart_sync_photo

        # 1. SDカード上の写真レコードを作成（元EXIF日時: 2026-09-01 10:00:00）
        sd_id = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00001.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00001.JPG",
            "file_size": 8765432,
            "date_taken": "2026-09-01 10:00:00",
            "width": 6000,
            "height": 4000,
            "camera_model": "ILCE-7M4",
            "volume_serial": "A1B2C3D4",
        })

        # 評価（優=2）、手動階層タグ、カラータグ、AIタグを付与
        update_rating(sd_id, 2)
        add_tag_to_photo(sd_id, "旅行/北海道/美瑛")
        add_tag_to_photo(sd_id, "青")
        add_ai_tags_to_photo(sd_id, [{"tag": "風景/山", "confidence": 0.91}])

        # 非破壊画像調整を適用
        update_photo_adjustments(
            sd_id,
            rotation=90,
            fine_angle=-2.25,
            crop_x=0.05,
            crop_y=0.10,
            crop_w=0.80,
            crop_h=0.75,
            crop_aspect="16:9",
            brightness=12,
            contrast=-8,
            saturation=18,
        )

        # 後付けGPSを付与
        update_photo_gps(sd_id, 43.5906, 142.4686, source="copied")

        # 撮影日時を +1時間（+3600秒）シフト補正（original_date_taken に '2026-09-01 10:00:00' が退避される）
        shift_res = batch_shift_photo_dates([sd_id], offset_seconds=3600)
        self.assertEqual(shift_res["updated_count"], 1)

        # 調整済みサムネイルBLOBを保存
        dummy_webp = b"RIFF_ADJUSTED_THUMB_WEBP"
        save_thumbnail(sd_id, dummy_webp, 270, 360, "hash_sd_1")

        # 2. PC側フォルダへファイルを移動・コピーしてスキャン（実ファイルのEXIF日時はシフト前の '2026-09-01 10:00:00' のまま）
        pc_meta = {
            "file_path": r"C:\Photos\2026_Hokkaido\DSC00001.JPG",
            "directory_path": r"C:\Photos\2026_Hokkaido",
            "file_name": "DSC00001.JPG",
            "file_size": 8765432,
            "date_taken": "2026-09-01 10:00:00",
            "width": 6000,
            "height": 4000,
            "camera_model": "ILCE-7M4",
            "volume_serial": "11223344",
        }
        action = smart_sync_photo(pc_meta, existing_record=None, do_upsert=True)
        self.assertEqual(action, "added")

        pc_photos = get_photos(folder=r"C:\Photos\2026_Hokkaido", stacked=False)
        self.assertEqual(len(pc_photos), 1)
        pc_id = pc_photos[0]["id"]
        pc_detail = get_photo_by_id(pc_id)

        # すべてのメタデータが漏れなく引き継がれていることを検証
        self.assertEqual(pc_detail["rating"], 2)
        self.assertEqual(pc_detail["date_taken"], "2026-09-01 11:00:00", "シフト後の撮影日時が引き継がれること")
        self.assertEqual(pc_detail["year_month"], "2026-09")
        self.assertEqual(pc_detail["original_date_taken"], "2026-09-01 10:00:00", "元EXIF日時も引き継がれること")
        self.assertEqual(pc_detail["rotation"], 90)
        self.assertAlmostEqual(pc_detail["fine_angle"], -2.25)
        self.assertAlmostEqual(pc_detail["crop_x"], 0.05)
        self.assertAlmostEqual(pc_detail["crop_y"], 0.10)
        self.assertAlmostEqual(pc_detail["crop_w"], 0.80)
        self.assertAlmostEqual(pc_detail["crop_h"], 0.75)
        self.assertEqual(pc_detail["crop_aspect"], "16:9")
        self.assertEqual(pc_detail["brightness"], 12)
        self.assertEqual(pc_detail["contrast"], -8)
        self.assertEqual(pc_detail["saturation"], 18)
        self.assertAlmostEqual(pc_detail["latitude"], 43.5906, places=4)
        self.assertAlmostEqual(pc_detail["longitude"], 142.4686, places=4)
        self.assertEqual(pc_detail["gps_source"], "copied")
        self.assertIn("旅行/北海道/美瑛", pc_detail["tags"])
        self.assertIn("青", pc_detail["tags"])
        self.assertIn("風景/山", pc_detail["tags"])

        # 調整済みサムネイルも即座に引き継がれていること
        pc_thumb = get_thumbnail(pc_id)
        self.assertIsNotNone(pc_thumb)
        self.assertEqual(pc_thumb["data"], dummy_webp)

        # 3. RAW+JPEGペアで代表JPEGにメタデータを付与後、RAW単体のみをPCへ移動したケースの検証
        raw_sd_id = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00002.ARW",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00002.ARW",
            "file_size": 25000000,
            "date_taken": "2026-09-01 12:00:00",
            "camera_model": "ILCE-7M4",
            "is_raw": 1,
            "raw_format": ".arw",
            "paired_raw_path": r"E:\DCIM\100MSDCF\DSC00002.JPG",
        })
        jpg_sd_id = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00002.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00002.JPG",
            "file_size": 7000000,
            "date_taken": "2026-09-01 12:00:00",
            "camera_model": "ILCE-7M4",
            "is_raw": 0,
            "paired_raw_path": r"E:\DCIM\100MSDCF\DSC00002.ARW",
        })
        update_rating(jpg_sd_id, -1)  # 「棄(-1)」評価も正しく引き継がれるか検証
        add_tag_to_photo(jpg_sd_id, "テスト/RAWペア引き継ぎ")

        pc_raw_meta = {
            "file_path": r"C:\Photos\2026_Hokkaido\DSC00002.ARW",
            "directory_path": r"C:\Photos\2026_Hokkaido",
            "file_name": "DSC00002.ARW",
            "file_size": 25000000,
            "date_taken": "2026-09-01 12:00:00",
            "camera_model": "ILCE-7M4",
            "is_raw": 1,
            "raw_format": ".arw",
        }
        smart_sync_photo(pc_raw_meta, existing_record=None, do_upsert=True)
        pc_raw_list = get_photos(folder=r"C:\Photos\2026_Hokkaido", ratings=[-1, 0, 1, 2], stacked=False)
        pc_raw = [p for p in pc_raw_list if p["file_name"] == "DSC00002.ARW"][0]
        self.assertEqual(pc_raw["rating"], -1, "ペアJPEGに付けた棄(-1)評価もRAW単体移動時に引き継がれること")
        self.assertIn("テスト/RAWペア引き継ぎ", pc_raw["tags"])

    def test_14_vsn_multi_sdcard_isolation_and_path_resolution(self):
        """複数SDカードが同一ドライブレター・同一パス・ラベルなしで競合せず独立管理でき、カスタム識別名・VSN絞り込み・クラウドパス解決が機能することを検証"""
        from server.database import (
            get_drive_photo_counts,
            get_existing_photos_map,
            get_photo_by_id,
            remove_folder_photos,
            update_volume_custom_name,
            upsert_photos_batch,
            upsert_volume,
        )
        from server.scanner import _resolve_cloud_drive_path, strip_vsn_prefix

        upsert_volume("1111AAAA", "", "E:")
        upsert_volume("2222BBBB", "", "E:")

        # 1. SDカード① (VSN: 1111AAAA) の DSC00001.JPG と DSC00002.JPG を登録
        sd1_p1 = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00001.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00001.JPG",
            "file_size": 5000111,
            "date_taken": "2026-10-01 10:00:00",
            "camera_model": "ILCE-7M4",
            "volume_serial": "1111AAAA",
        })
        add_tag_to_photo(sd1_p1, "SDカード1の写真")

        # 2. SDカード② (VSN: 2222BBBB) を同じ E:\DCIM\100MSDCF\DSC00001.JPG で登録（UNIQUE衝突せず別レコードとして共存すること）
        sd2_p1 = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00001.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00001.JPG",
            "file_size": 6000222,
            "date_taken": "2026-10-02 14:00:00",
            "camera_model": "RICOH GR IIIx",
            "volume_serial": "2222BBBB",
        })
        add_tag_to_photo(sd2_p1, "SDカード2の写真")
        self.assertNotEqual(sd1_p1, sd2_p1, "異なるVSNの同一パス写真は別レコードとして共存すること")

        # バッチ登録でも同様にVSN退避が機能すること
        upsert_photos_batch([
            {
                "file_path": r"E:\DCIM\100MSDCF\DSC00002.JPG",
                "directory_path": r"E:\DCIM\100MSDCF",
                "file_name": "DSC00002.JPG",
                "file_size": 5000333,
                "date_taken": "2026-10-01 10:05:00",
                "volume_serial": "1111AAAA",
            },
            {
                "file_path": r"E:\DCIM\100MSDCF\DSC00002.JPG",
                "directory_path": r"E:\DCIM\100MSDCF",
                "file_name": "DSC00002.JPG",
                "file_size": 6000444,
                "date_taken": "2026-10-02 14:05:00",
                "volume_serial": "2222BBBB",
            },
        ])

        # 3. カスタム識別名（ニックネーム）の設定と取得
        update_volume_custom_name("1111AAAA", "α7IV メインSD①")
        update_volume_custom_name("2222BBBB", "GRIIIx サブSD②")

        d1 = get_photo_by_id(sd1_p1)
        d2 = get_photo_by_id(sd2_p1)
        self.assertEqual(d1["file_path"], r"E:\DCIM\100MSDCF\DSC00001.JPG", "vsn://プレフィックスが除去されたクリーンなパスが返ること")
        self.assertEqual(d2["file_path"], r"E:\DCIM\100MSDCF\DSC00001.JPG")
        self.assertEqual(d1["volume_custom_name"], "α7IV メインSD①")
        self.assertEqual(d2["volume_custom_name"], "GRIIIx サブSD②")
        self.assertIn("SDカード1の写真", d1["tags"])
        self.assertIn("SDカード2の写真", d2["tags"])

        # 4. VSN指定によるメディア別フィルタリング（どのSDカードに何が入っているか）
        sd1_photos = get_photos(folder=r"E:\DCIM", volume_serial="1111AAAA", serial_mode="match", stacked=False)
        sd2_photos = get_photos(folder=r"E:\DCIM", volume_serial="2222BBBB", serial_mode="match", stacked=False)
        self.assertEqual(len(sd1_photos), 2)
        self.assertEqual(len(sd2_photos), 2)
        self.assertTrue(all(p["volume_serial"] == "1111AAAA" for p in sd1_photos))
        self.assertTrue(all(p["volume_serial"] == "2222BBBB" for p in sd2_photos))
        self.assertTrue(all(not p["file_path"].startswith("vsn://") for p in sd1_photos))

        # get_existing_photos_map でも VSN ごとに正しいレコード辞書が返ること
        map_sd1 = get_existing_photos_map(r"E:\DCIM", recursive=True, volume_serial="1111AAAA")
        map_sd2 = get_existing_photos_map(r"E:\DCIM", recursive=True, volume_serial="2222BBBB")
        self.assertEqual(map_sd1[r"E:\DCIM\100MSDCF\DSC00001.JPG"][0], sd1_p1)
        self.assertEqual(map_sd2[r"E:\DCIM\100MSDCF\DSC00001.JPG"][0], sd2_p1)

        # 5. VSN指定でのフォルダ登録解除で、他方のSDカードの写真が巻き添え削除されないこと
        rem_res = remove_folder_photos(r"E:\DCIM", recursive=True, volume_serial="1111AAAA")
        self.assertEqual(rem_res["deleted_count"], 2)
        remaining_sd2 = get_photos(folder=r"E:\DCIM", volume_serial="2222BBBB", serial_mode="match", stacked=False)
        self.assertEqual(len(remaining_sd2), 2, "SDカード②の2枚は無傷で残っていること")

        # 6. クラウドドライブ相対パスフォールバック (_resolve_cloud_drive_path) の検証
        fake_home = Path(self._temp_dir.name) / "FakeUserHome"
        fake_gdrive = fake_home / "Google Drive" / "マイドライブ" / "CameraUploads"
        fake_gdrive.mkdir(parents=True, exist_ok=True)
        cloud_file = fake_gdrive / "CLOUD_001.JPG"
        cloud_file.write_bytes(b"FAKE_JPEG_DATA")

        import unittest.mock as _mock
        with _mock.patch("server.scanner.Path.home", return_value=fake_home):
            # 別PCで G:\マイドライブ\CameraUploads\CLOUD_001.JPG として登録されていたパスが、
            # 現PCの ~/Google Drive/マイドライブ/CameraUploads/CLOUD_001.JPG へ自動解決されること
            resolved_cloud = _resolve_cloud_drive_path(r"G:\マイドライブ\CameraUploads\CLOUD_001.JPG")
            self.assertIsNotNone(resolved_cloud)
            self.assertEqual(resolved_cloud, cloud_file)

    def test_20_vsn_parking_merges_duplicate_instead_of_silent_delete(self) -> None:
        """VSN退避先に同一実ファイルの重複レコードがある場合、評価・タグを統合してから削除し、データを失わないことを検証"""
        from server.database import get_photo_by_id

        path = r"E:\DCIM\100MSDCF\DSC09999.JPG"
        base = {"file_path": path, "directory_path": r"E:\DCIM\100MSDCF", "file_name": "DSC09999.JPG",
                "file_size": 4000000, "date_taken": "2026-10-05 09:00:00"}
        # カードA（VSN: AAAA0001）の現行レコード
        cur_id = upsert_photo({**base, "volume_serial": "AAAA0001"})
        # 同一画像の別パス登録は同じ photo_id (cur_id) に統合され、評価・タグが共有されること
        old_id = upsert_photo({**base, "file_path": path + ".old", "file_name": "DSC09999_old.JPG", "volume_serial": "AAAA0001"})
        self.assertEqual(old_id, cur_id)
        update_rating(old_id, 3)
        add_tag_to_photo(old_id, "旅行/京都")

        # カードB（VSN: BBBB0002）の別写真が同じパスでスキャンされても vsn:// 退避なしで共存すること
        new_id = upsert_photo({**base, "file_size": 4100000, "volume_serial": "bbbb0002"})
        self.assertNotEqual(new_id, cur_id)

        merged = get_photo_by_id(cur_id)
        self.assertIsNotNone(merged, "カードAのレコードは無傷で残ること")
        self.assertEqual(merged["rating"], 3, "評価が維持されること")
        self.assertIn("旅行/京都", merged["tags"], "タグが維持されること")

        # VSNの大文字小文字の表記揺れでは退避されないこと（同一メディア扱い）
        same_id = upsert_photo({**base, "file_size": 4100000, "volume_serial": "BBBB0002"})
        self.assertEqual(same_id or new_id, new_id)
        with get_connection() as conn:
            parked = conn.execute("SELECT COUNT(*) FROM photos WHERE file_path LIKE 'vsn://BBBB0002/%' OR file_path LIKE 'vsn://bbbb0002/%'").fetchone()[0]
        self.assertEqual(parked, 0)

        # バッチ登録（upsert_photos_batch）の2件目以降で退避重複統合が走っても SQLite 自己デッドロックを起こさないこと
        from server.database import upsert_photos_batch
        path2 = r"E:\DCIM\100MSDCF\DSC09998.JPG"
        base2 = {
            "file_path": path2,
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC09998.JPG",
            "file_size": 4200000,
            "date_taken": "2026-10-05 09:05:00",
        }
        cur_id2 = upsert_photo({**base2, "volume_serial": "AAAA0001"})
        old_id2 = upsert_photo({**base2, "file_path": path2 + ".old", "file_name": "DSC09998_old.JPG", "volume_serial": "AAAA0001"})
        self.assertEqual(old_id2, cur_id2)
        update_rating(old_id2, 2)
        add_tag_to_photo(old_id2, "バッチ統合テスト")

        upsert_photos_batch([
            {
                "file_path": r"E:\DCIM\100MSDCF\DSC09997.JPG",
                "directory_path": r"E:\DCIM\100MSDCF",
                "file_name": "DSC09997.JPG",
                "file_size": 4300000,
                "date_taken": "2026-10-05 09:10:00",
                "volume_serial": "BBBB0002",
            },
            {
                **base2,
                "file_size": 4400000,
                "volume_serial": "BBBB0002",
            },
        ])
        merged2 = get_photo_by_id(cur_id2)
        self.assertIsNotNone(merged2)
        self.assertEqual(merged2["rating"], 2, "バッチスキャン中もデッドロックせず評価が維持されること")
        self.assertIn("バッチ統合テスト", merged2["tags"])

    def test_21_ai_color_retag_keeps_existing_tags_on_empty_result(self) -> None:
        """AIカラー再判定の結果が空（推論失敗・モデル未ロード）の場合、既存のAIカラータグを消さないことを検証"""
        from server.database import get_photo_tags_details, replace_ai_color_tags_for_photo

        pid = upsert_photo({"file_path": r"C:\Photos\Color\C001.JPG", "directory_path": r"C:\Photos\Color",
                            "file_name": "C001.JPG", "file_size": 1234, "date_taken": "2026-10-06 10:00:00"})
        replace_ai_color_tags_for_photo(pid, [{"tag": "青", "confidence": 0.3, "category": "color"}])
        replace_ai_color_tags_for_photo(pid, [])
        tags = {t["tag"]: t["source"] for t in get_photo_tags_details(pid)}
        self.assertEqual(tags.get("青"), "ai", "空の再判定結果で既存のAIカラータグが消えないこと")

    def test_22_network_paths_skip_vsn_strict_matching(self) -> None:
        """ネットワークドライブ・UNC上の写真は VSN 厳密照合の対象外となり、オフライン誤判定されないことを検証"""
        import unittest.mock as _mock

        from server import scanner

        nas_dir = Path(self._temp_dir.name) / "NasShare"
        nas_dir.mkdir(parents=True, exist_ok=True)
        nas_file = nas_dir / "NAS_0001.JPG"
        nas_file.write_bytes(b"FAKE_JPEG_DATA")

        self.assertTrue(scanner._is_network_path(r"\\nas\photos\NAS_0001.JPG"))
        # 一時フォルダをネットワークドライブ上のパスとみなし、VSN対応表に無いシリアルを指定しても解決できること
        with _mock.patch.object(scanner, "_is_network_path", return_value=True):
            resolved, online = scanner.resolve_portable_path(str(nas_file), expected_serial="DEADBEEF")
        self.assertTrue(online)
        self.assertEqual(Path(resolved), nas_file)
        # ローカル扱いのままなら、対応表に無いVSNはオフライン（別メディアへの誤一致防止）のまま
        with _mock.patch.object(scanner, "_is_network_path", return_value=False):
            _, online_local = scanner.resolve_portable_path(str(nas_file), expected_serial="DEADBEEF")
        self.assertFalse(online_local)

    def test_15_ai_color_tag_only_reexecution(self) -> None:
        """コンテキストメニューからのAIカラータグ（12色）単独再判定・既存タグ保護の検証"""
        from server.database import (
            add_tag_to_photo,
            add_ai_tags_to_photo,
            replace_ai_color_tags_for_photo,
            get_photo_tags_details,
        )

        pid = upsert_photo({
            "file_path": r"D:\Photos\ColorRetag\IMG_COLOR_01.JPG",
            "directory_path": r"D:\Photos\ColorRetag",
            "file_name": "IMG_COLOR_01.JPG",
            "file_size": 1200000,
            "date_taken": "2026:07:20 15:00:00",
        })

        # 初期状態: 手動タグ（「お気に入り」＋手動カラータグ「赤」）と、AIタグ（「風景」＋旧AIカラータグ「青」）を付与
        add_tag_to_photo(pid, "お気に入り")
        add_tag_to_photo(pid, "赤")
        add_ai_tags_to_photo(pid, [
            {"tag": "風景", "confidence": 0.295, "category": "scene"},
            {"tag": "青", "confidence": 0.252, "category": "color"},
        ])

        before_tags = {t["tag"]: t["source"] for t in get_photo_tags_details(pid)}
        self.assertEqual(before_tags.get("お気に入り"), "manual")
        self.assertEqual(before_tags.get("赤"), "manual")
        self.assertEqual(before_tags.get("風景"), "ai")
        self.assertEqual(before_tags.get("青"), "ai")

        # AIカラータグのみ再判定（「オレンジ」に変化したケース）
        replace_ai_color_tags_for_photo(pid, [
            {"tag": "オレンジ", "confidence": 0.268, "category": "color"},
        ])

        after_tags = {t["tag"]: t["source"] for t in get_photo_tags_details(pid)}
        self.assertNotIn("青", after_tags, "旧AIカラータグ『青』が置換削除されていること")
        self.assertEqual(after_tags.get("オレンジ"), "ai", "新AIカラータグ『オレンジ』が付与されていること")
        self.assertEqual(after_tags.get("赤"), "manual", "手動で付与したカラータグ『赤』は削除されず保護されること")
        self.assertEqual(after_tags.get("風景"), "ai", "AI被写体・シーンタグ『風景』は削除されず保護されること")
        self.assertEqual(after_tags.get("お気に入り"), "manual", "手動タグ『お気に入り』は保護されること")

    def test_16_volume_label_ascii_validation_and_pin_approval(self) -> None:
        """ボリュームラベル物理書き込みの2バイト文字禁止・11文字制限・ランダムPIN承認ガードの検証"""
        import unittest.mock as _mock
        from fastapi import HTTPException
        from server.volume_info import validate_ascii_volume_label
        from server.app import (
            UpdateVolumeNameRequest,
            api_get_volume_status,
            api_update_volume_name,
        )

        # 1. 半角ASCII 11文字以内は許可
        self.assertEqual(validate_ascii_volume_label("SD_A7M4_01"), "SD_A7M4_01")
        self.assertEqual(validate_ascii_volume_label(""), "")

        # 2. 2バイト文字（日本語・全角英数・環境依存文字）は厳格に拒否されること
        for bad_two_byte in ["メインSD", "SD_①", "ＳＤカード", "α7IV_SD"]:
            with self.assertRaises(ValueError):
                validate_ascii_volume_label(bad_two_byte)

        # 3. 12文字超過および禁止記号は拒否されること
        with self.assertRaises(ValueError):
            validate_ascii_volume_label("SD_CARD_1234")  # 12文字
        with self.assertRaises(ValueError):
            validate_ascii_volume_label("SD*CARD?")  # 禁止記号

        # 4. write_volume_label=False（未チェック）の場合は物理書き込み関数が一切呼ばれないこと
        with _mock.patch("server.volume_info.set_physical_volume_label") as mock_set_label:
            res_db_only = api_update_volume_name(
                "3333CCCC",
                UpdateVolumeNameRequest(
                    custom_name="α7IV メインSD③（日本語ニックネーム）",
                    write_volume_label=False,
                ),
            )
            self.assertEqual(res_db_only["custom_name"], "α7IV メインSD③（日本語ニックネーム）")
            self.assertFalse(res_db_only["wrote_physical_label"])
            mock_set_label.assert_not_called()

            # 5. PIN不一致時は 400 でブロックされ、物理書き込み関数が一切呼ばれないこと
            with _mock.patch(
                "server.volume_info.find_online_drive_for_serial",
                return_value={"serial": "3333CCCC", "label": "NO NAME", "drive": "E:", "filesystem": "exFAT"},
            ):
                status_info = api_get_volume_status("3333CCCC")
                issued_pin = status_info["approval_pin"]
                self.assertEqual(len(issued_pin), 4)
                self.assertTrue(issued_pin.isdigit())

                wrong_pin = "0000" if issued_pin != "0000" else "9999"
                with self.assertRaises(HTTPException) as ctx_wrong:
                    api_update_volume_name(
                        "3333CCCC",
                        UpdateVolumeNameRequest(
                            custom_name="α7IV メインSD③",
                            write_volume_label=True,
                            new_volume_label="SD_A7M4_03",
                            approval_pin=wrong_pin,
                        ),
                    )
                self.assertEqual(ctx_wrong.exception.status_code, 400)
                mock_set_label.assert_not_called()

                # 6. 正しいPINでも2バイト文字が指定された場合は 400 でブロックされ、物理書き込みされないこと
                with self.assertRaises(HTTPException) as ctx_mb:
                    api_update_volume_name(
                        "3333CCCC",
                        UpdateVolumeNameRequest(
                            custom_name="α7IV メインSD③",
                            write_volume_label=True,
                            new_volume_label="日本語ラベル",
                            approval_pin=issued_pin,
                        ),
                    )
                self.assertEqual(ctx_mb.exception.status_code, 400)
                mock_set_label.assert_not_called()

                # 7. 正しい4桁PIN かつ 半角ASCII 11文字以内の場合のみ物理書き込みが実行されること
                mock_set_label.return_value = {
                    "serial": "3333CCCC",
                    "drive": "E:",
                    "volume_label": "SD_A7M4_03",
                    "filesystem": "exFAT",
                }
                res_approved = api_update_volume_name(
                    "3333CCCC",
                    UpdateVolumeNameRequest(
                        custom_name="α7IV メインSD③",
                        write_volume_label=True,
                        new_volume_label="SD_A7M4_03",
                        approval_pin=issued_pin,
                    ),
                )
                self.assertTrue(res_approved["wrote_physical_label"])
                self.assertEqual(res_approved["volume_label"], "SD_A7M4_03")
                self.assertEqual(res_approved["custom_name"], "α7IV メインSD③")
                mock_set_label.assert_called_once_with("3333CCCC", "SD_A7M4_03")

    def test_17_managed_volumes_list_and_unmanage(self):
        """管理対象メディア一覧 get_all_volumes() の集計情報（枚数・撮影期間・カメラ機種・識別名）と remove_volume_by_serial() の検証"""
        from server.database import (
            get_all_volumes,
            get_photos,
            remove_volume_by_serial,
            update_rating,
            update_volume_custom_name,
            upsert_photo,
            upsert_volume,
        )

        # SDカードA (VSN: AAAA1111) に写真2枚を登録
        upsert_volume("AAAA1111", "EOS", "E:")
        update_volume_custom_name("AAAA1111", "Canon メインSD①")
        p_a1 = upsert_photo({
            "file_path": r"E:\DCIM\100CANON\IMG_0001.JPG",
            "directory_path": r"E:\DCIM\100CANON",
            "file_name": "IMG_0001.JPG",
            "file_size": 4100000,
            "date_taken": "2026:07:10 09:00:00",
            "camera_model": "Canon EOS R6m2",
            "volume_serial": "AAAA1111",
            "volume_label": "EOS",
        })
        p_a2 = upsert_photo({
            "file_path": r"E:\DCIM\100CANON\IMG_0002.JPG",
            "directory_path": r"E:\DCIM\100CANON",
            "file_name": "IMG_0002.JPG",
            "file_size": 4200000,
            "date_taken": "2026:07:12 18:30:00",
            "camera_model": "Canon EOS R6m2",
            "volume_serial": "AAAA1111",
            "volume_label": "EOS",
        })
        update_rating(p_a1, 2)  # 優

        # SDカードB (VSN: BBBB2222) に写真1枚を登録（同じE:ドライブ文字）
        upsert_volume("BBBB2222", "", "E:")
        p_b1 = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC01001.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC01001.JPG",
            "file_size": 5300000,
            "date_taken": "2026:09:05 14:15:00",
            "camera_model": "ILCE-7CM2",
            "volume_serial": "BBBB2222",
            "volume_label": "",
        })

        vols = get_all_volumes()
        by_vsn = {v["volume_serial"]: v for v in vols}
        self.assertIn("AAAA1111", by_vsn)
        self.assertIn("BBBB2222", by_vsn)

        va = by_vsn["AAAA1111"]
        self.assertEqual(va["custom_name"], "Canon メインSD①")
        self.assertEqual(va["volume_label"], "EOS")
        self.assertEqual(va["short_serial"], "AAAA-1111")
        self.assertEqual(va["photo_count"], 2)
        self.assertEqual(va["excellent_count"], 1)
        self.assertEqual(va["min_date"], "2026-07-10")
        self.assertEqual(va["max_date"], "2026-07-12")
        self.assertIn("Canon EOS R6m2", va["cameras"])

        vb = by_vsn["BBBB2222"]
        self.assertEqual(vb["photo_count"], 1)
        self.assertEqual(vb["min_date"], "2026-09-05")
        self.assertEqual(vb["max_date"], "2026-09-05")
        self.assertIn("ILCE-7CM2", vb["cameras"])

        # SDカードA (AAAA1111) の管理登録を解除 → Aの写真2枚とボリューム情報が消え、SDカードB (BBBB2222) は無傷で残ること
        res_del = remove_volume_by_serial("AAAA1111")
        self.assertEqual(res_del["removed_count"], 2)

        vols_after = {v["volume_serial"]: v for v in get_all_volumes()}
        self.assertNotIn("AAAA1111", vols_after)
        self.assertIn("BBBB2222", vols_after)
        remaining_photos = get_photos(stacked=False)
        self.assertEqual([p["id"] for p in remaining_photos], [p_b1])

    def test_18_hierarchical_tag_ancestor_integrity_and_exclude_filter(self) -> None:
        """階層タグの親・祖先レコード整合性保証、リネーム時の自動補完・相関マージ、除外フィルタの回帰テスト"""
        from server.database import (
            add_ai_tags_to_photo,
            add_tag_to_photo,
            get_all_tags_summary,
            get_connection,
            get_photo_tags_details,
            get_photos,
            initialize_database,
            promote_ai_tag,
            rename_tag,
            upsert_photo,
        )

        p1 = upsert_photo({
            "file_path": r"C:\Photos\Bento\PXL_20260831_030140793.jpg",
            "directory_path": r"C:\Photos\Bento",
            "file_name": "PXL_20260831_030140793.jpg",
            "file_size": 1200000,
            "date_taken": "2026-08-31 12:00:00",
        })
        p2 = upsert_photo({
            "file_path": r"C:\Photos\Bento\PXL_20260901_030137140.jpg",
            "directory_path": r"C:\Photos\Bento",
            "file_name": "PXL_20260901_030137140.jpg",
            "file_size": 1250000,
            "date_taken": "2026-09-01 12:00:00",
        })
        p3 = upsert_photo({
            "file_path": r"C:\Photos\Books\PXL_20260901_144942491.jpg",
            "directory_path": r"C:\Photos\Books",
            "file_name": "PXL_20260901_144942491.jpg",
            "file_size": 1400000,
            "date_taken": "2026-09-01 14:49:42",
        })

        # 1. 旧バージョン等で「子孫タグのみが存在し、親タグ行が欠落している」状態をシミュレートして rename_tag を実行
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)",
                (p1, "20. 食べ物・飲み物/樹里さん弁当/2026"),
            )
            conn.commit()

        # ルートタグ名をリネームした際、new_tag 自身 ("食事・飲み物") と中間親 ("食事・飲み物/樹里さん弁当") も補完されること
        rename_tag("20. 食べ物・飲み物", "食事・飲み物")
        p1_tags = {d["tag"] for d in get_photo_tags_details(p1)}
        self.assertEqual(
            p1_tags,
            {"食事・飲み物", "食事・飲み物/樹里さん弁当", "食事・飲み物/樹里さん弁当/2026"},
        )

        # 2. DBに直接「末端タグのみ（親欠落）」が存在していた場合でも、initialize_database() の高速修復で自己修復されること
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)",
                (p2, "食事・飲み物/樹里さん弁当/2026"),
            )
            conn.commit()

        initialize_database()
        p2_tags = {d["tag"] for d in get_photo_tags_details(p2)}
        self.assertEqual(
            p2_tags,
            {"食事・飲み物", "食事・飲み物/樹里さん弁当", "食事・飲み物/樹里さん弁当/2026"},
        )

        # 親タグ「食事・飲み物」を除外（-）にしたとき、子孫タグを持つ p1, p2 が確実に除外され p3 のみ残ること
        remaining = get_photos(excluded_tags=["食事・飲み物"])
        self.assertEqual([r["id"] for r in remaining], [p3])

        # 親タグ「食事・飲み物」を含む（+）にしたとき、p1, p2 の両方がヒットし、集計枚数も 2 枚で一致すること
        included = get_photos(included_tags=["食事・飲み物"])
        self.assertEqual({r["id"] for r in included}, {p1, p2})
        summary_map = {item["tag"]: item["count"] for item in get_all_tags_summary()}
        self.assertEqual(summary_map.get("食事・飲み物"), 2)
        self.assertEqual(summary_map.get("食事・飲み物/樹里さん弁当"), 2)
        self.assertEqual(summary_map.get("食事・飲み物/樹里さん弁当/2026"), 2)

        # 3. rename_tag の子孫重複マージ時に、別写真の無関係な既存タグを誤削除しないこと（相関サブクエリ検証）
        add_tag_to_photo(p1, "旧カテゴリ/サブA")
        add_tag_to_photo(p1, "新カテゴリ/サブB")
        add_tag_to_photo(p2, "旧カテゴリ/サブB")
        rename_tag("旧カテゴリ", "新カテゴリ")

        p1_after = {d["tag"] for d in get_photo_tags_details(p1)}
        p2_after = {d["tag"] for d in get_photo_tags_details(p2)}
        self.assertIn("新カテゴリ/サブA", p1_after)
        self.assertIn("新カテゴリ/サブB", p1_after)  # p1 が元々持っていた「新カテゴリ/サブB」が消えていないこと
        self.assertIn("新カテゴリ/サブB", p2_after)

        # 4. promote_ai_tag で階層タグを昇格した際、全祖先パスも manual として保証されること
        add_ai_tags_to_photo(p3, [{"tag": "被写体/動物/猫", "confidence": 0.85}])
        self.assertTrue(promote_ai_tag(p3, "被写体/動物/猫"))
        p3_details = {d["tag"]: d["source"] for d in get_photo_tags_details(p3)}
        self.assertEqual(p3_details.get("被写体"), "manual")
        self.assertEqual(p3_details.get("被写体/動物"), "manual")
        self.assertEqual(p3_details.get("被写体/動物/猫"), "manual")

    def test_19_ai_color_tag_re_evaluation(self) -> None:
        """AIカラータグのみ再判定（predict_from_bytes(color_only=True) および /api/ai/tag-color-photos）の検証"""
        import asyncio
        import io
        from PIL import Image
        import server.app as app_module
        from server.ai.tagger import get_ai_tagger
        from server.database import (
            add_ai_tags_to_photo,
            add_tag_to_photo,
            get_photo_tags_details,
            save_thumbnail,
            upsert_photo,
        )

        # 鮮やかな赤色テスト画像のWebPサムネイルを生成
        img = Image.new("RGB", (224, 224), (225, 25, 25))
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=90)
        red_webp = buf.getvalue()

        p_red = upsert_photo({
            "file_path": r"C:\Photos\Cars\RED_ROADSTER.JPG",
            "directory_path": r"C:\Photos\Cars",
            "file_name": "RED_ROADSTER.JPG",
            "file_size": 2500000,
            "date_taken": "2026-08-14 10:00:00",
        })
        save_thumbnail(p_red, red_webp, 224, 224)

        # 手動タグ（通常タグ + 手動カラータグ「黒」）と、既存のAIタグ（被写体「車・ドライブ」 + 旧AIカラータグ「青」）を付与
        add_tag_to_photo(p_red, "愛車/ロードスター")
        add_tag_to_photo(p_red, "黒")
        add_ai_tags_to_photo(
            p_red,
            [
                {"tag": "車・ドライブ", "confidence": 0.28},
                {"tag": "青", "confidence": 0.22},
            ],
        )

        tagger = get_ai_tagger()
        if tagger.is_available():
            res = app_module.api_ai_tag_color_photos(
                app_module.AITagColorBatchRequest(photo_ids=[p_red])
            )
            self.assertEqual(res["status"], "ok")
            self.assertEqual(res["tagged_count"], 1)
            pred_list = res["predicted_colors"].get(p_red) or res["predicted_colors"].get(str(p_red)) or []
            self.assertIn("赤", pred_list)

            details_map = {d["tag"]: d["source"] for d in get_photo_tags_details(p_red)}
            # 旧AIカラータグ「青」が消え、新AIカラータグ「赤」が付与されていること
            self.assertNotIn("青", details_map)
            self.assertEqual(details_map.get("赤"), "ai")
            # AI被写体タグ「車・ドライブ」および手動タグ「愛車/ロードスター」「黒」は無傷で保持されていること
            self.assertEqual(details_map.get("車・ドライブ"), "ai")
            self.assertEqual(details_map.get("愛車/ロードスター"), "manual")
            self.assertEqual(details_map.get("黒"), "manual")

    def test_23_vsn_stack_isolation_and_drive_letter_shift(self) -> None:
        """
        1. 異なるSDカード（VSN）が同一ドライブ文字・同一フォルダに同名ファイル（DSC00001.JPG/ARW）を持つ場合、
           recalculate_stacks で別カード同士が合体・非表示化されず独立してペア・スタック維持されること
        2. クロスフォルダ RAW+JPEG ペアリングで別SDカードの同名RAWとJPEGが誤ペアリングされないこと
        3. ドライブ文字が変化した接続中SDカード（E: -> F:）が folder_tree.build_roots で分裂せず、
           F: 側のフォルダ指定でも get_directory_counts_under / get_photos が正しくヒットすること
        4. get_calendar_summary でペア済みRAWが重複カウントされないこと
        """
        import unittest.mock as _mock
        from server import folder_tree
        from server.database import (
            get_calendar_summary,
            get_directory_counts_under,
            get_photo_by_id,
            get_photos,
            recalculate_stacks,
            upsert_photo,
            upsert_volume,
        )

        upsert_volume("AAAA1111", "SD_A", "E:")
        upsert_volume("BBBB2222", "SD_B", "E:")

        # SDカードA (AAAA1111): E:\DCIM\100MSDCF\DSC00001.JPG + DSC00001.ARW のペア
        a_jpg = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00001.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00001.JPG",
            "file_size": 5100000,
            "date_taken": "2026-10-10 10:00:00",
            "camera_model": "ILCE-7M4",
            "is_raw": 0,
            "volume_serial": "AAAA1111",
        })
        a_raw = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00001.ARW",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00001.ARW",
            "file_size": 25100000,
            "date_taken": "2026-10-10 10:00:00",
            "camera_model": "ILCE-7M4",
            "is_raw": 1,
            "raw_format": ".arw",
            "volume_serial": "AAAA1111",
        })

        # SDカードB (BBBB2222): 同じパス E:\DCIM\100MSDCF\DSC00001.JPG (単独JPEG)
        # → これにより SDカードA のレコードは vsn://AAAA1111/E:\... へ自動退避される
        b_jpg = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00001.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00001.JPG",
            "file_size": 6200000,
            "date_taken": "2026-10-12 15:00:00",
            "camera_model": "ILCE-7CR",
            "is_raw": 0,
            "volume_serial": "BBBB2222",
        })

        # 別フォルダにあるSDカードAの未ペアRAW（クロスフォルダでSDカードBの同名JPEGと誤ペアリングされないことを検証）
        a_unpaired_raw = upsert_photo({
            "file_path": r"E:\DCIM\101RAW\DSC00009.ARW",
            "directory_path": r"E:\DCIM\101RAW",
            "file_name": "DSC00009.ARW",
            "file_size": 26000000,
            "date_taken": "2026-10-12 16:00:00",
            "camera_model": "ILCE-7M4",
            "is_raw": 1,
            "raw_format": ".arw",
            "volume_serial": "AAAA1111",
        })
        b_other_jpg = upsert_photo({
            "file_path": r"E:\DCIM\100MSDCF\DSC00009.JPG",
            "directory_path": r"E:\DCIM\100MSDCF",
            "file_name": "DSC00009.JPG",
            "file_size": 6300000,
            "date_taken": "2026-10-12 16:00:00",
            "camera_model": "ILCE-7CR",
            "is_raw": 0,
            "volume_serial": "BBBB2222",
        })

        # SDカードBのスキャン時（existing_paths に E:\DCIM\100MSDCF\DSC00001.JPG がある状態）を再現してスタック再計算
        recalculate_stacks(
            directory_path=r"E:\DCIM",
            recursive=True,
            existing_paths={r"E:\DCIM\100MSDCF\DSC00001.JPG", r"E:\DCIM\100MSDCF\DSC00009.JPG"},
        )

        # 1. SDカードAの DSC00001.JPG と DSC00001.ARW はカードA内で正しくペアになり、vsn:// プレフィックス無しの paired_raw_path になること
        a_jpg_row = get_photo_by_id(a_jpg)
        a_raw_row = get_photo_by_id(a_raw)
        b_jpg_row = get_photo_by_id(b_jpg)
        self.assertEqual(a_jpg_row["paired_raw_path"], r"E:\DCIM\100MSDCF\DSC00001.ARW")
        self.assertEqual(a_raw_row["paired_raw_path"], r"E:\DCIM\100MSDCF\DSC00001.JPG")
        self.assertIsNone(b_jpg_row["paired_raw_path"], "SDカードBの単独JPEGにSDカードAのRAWが誤紐付けされないこと")
        self.assertEqual(a_jpg_row["is_stack_primary"], 1, "退避中のSDカードAのJPEGが非表示(0)に潰されないこと")

        # 2. 別SDカード間でクロスフォルダ誤ペアリングが起きないこと
        self.assertIsNone(get_photo_by_id(a_unpaired_raw)["paired_raw_path"])
        self.assertIsNone(get_photo_by_id(b_other_jpg)["paired_raw_path"])

        # 3. 撮影カレンダー集計でペア済みRAW (a_raw) が重複カウントされないこと
        cal_summary = {c["date"]: c["count"] for c in get_calendar_summary()}
        self.assertEqual(cal_summary.get("2026-10-10"), 1, "RAW+JPEGペアはカレンダー集計で1枚としてカウントされること")

        # 4. SDカードA (AAAA1111) が別ポート F: で接続された場合、build_roots で F: に枚数が合算され offline_volumes に分裂しないこと
        fake_connected = [
            {
                "letter": "F:",
                "path": "F:\\",
                "drive_type": "removable",
                "volume_serial": "AAAA1111",
                "label": "SD_A",
            }
        ]
        with _mock.patch.object(folder_tree, "_list_connected_drives", return_value=fake_connected):
            roots = folder_tree.build_roots([])
        f_drive = next(d for d in roots["drives"] if d["letter"] == "F:")
        self.assertEqual(f_drive["total"], 3, "前回E:でスキャンしたSDカードAの3枚が接続中F:ドライブに合算されること")
        offline_serials = {v["volume_serial"] for v in roots["offline_volumes"]}
        self.assertNotIn("AAAA1111", offline_serials, "接続中のSDカードAが未接続メディアに重複出現しないこと")
        self.assertIn("BBBB2222", offline_serials, "未接続のSDカードBは未接続メディアに表示されること")

        # F: 側のパス指定でも get_directory_counts_under と get_photos が VSN 一致でヒットすること
        dir_counts_f = get_directory_counts_under("F:\\", volume_serial="AAAA1111", serial_mode="match_or_null")
        dir_map_f = {r["directory_path"]: r["count"] for r in dir_counts_f}
        self.assertEqual(dir_map_f.get(r"F:\DCIM\100MSDCF"), 2)
        self.assertEqual(dir_map_f.get(r"F:\DCIM\101RAW"), 1)

        photos_f = get_photos(folder=r"F:\DCIM\100MSDCF", volume_serial="AAAA1111", serial_mode="match", stacked=True)
        self.assertEqual([p["id"] for p in photos_f], [a_jpg])

    def test_24_parent_folder_with_only_subfolder_photos_is_managed(self) -> None:
        """
        直下に画像が0枚で、子フォルダにのみ管理写真が存在する親フォルダ（例: 2026 -> 0 + 3952）が、
        scan_roots の登録有無にかかわらず list_children および get_folders_summary で status='managed' になり、
        count(直下枚数) / sub_count(子フォルダ枚数) / total(合計枚数) が正確に返ることを検証
        """
        from server import folder_tree
        from server.database import get_folders_summary, upsert_photo

        root_dir = Path(self._temp_dir.name) / "10.PHOTO"
        dir_2026 = root_dir / "2026"
        dir_202601 = dir_2026 / "202601"
        dir_202602 = dir_2026 / "202602"
        dir_unmanaged = root_dir / "30.WORK"
        dir_202601.mkdir(parents=True, exist_ok=True)
        dir_202602.mkdir(parents=True, exist_ok=True)
        dir_unmanaged.mkdir(parents=True, exist_ok=True)

        # 2026 直下には写真を1枚も置かず、子フォルダ 202601 (2枚) と 202602 (1枚) にのみ登録
        upsert_photo({
            "file_path": str(dir_202601 / "IMG_001.JPG"),
            "directory_path": str(dir_202601),
            "file_name": "IMG_001.JPG",
            "file_size": 1000,
            "date_taken": "2026-01-10 10:00:00",
        })
        upsert_photo({
            "file_path": str(dir_202601 / "IMG_002.JPG"),
            "directory_path": str(dir_202601),
            "file_name": "IMG_002.JPG",
            "file_size": 1100,
            "date_taken": "2026-01-11 10:00:00",
        })
        upsert_photo({
            "file_path": str(dir_202602 / "IMG_003.JPG"),
            "directory_path": str(dir_202602),
            "file_name": "IMG_003.JPG",
            "file_size": 1200,
            "date_taken": "2026-02-05 12:00:00",
        })

        # 1. folder_tree.list_children で 10.PHOTO の子を取得した際、2026 が managed (0 + 3 = 3) になること
        res = folder_tree.list_children(str(root_dir))
        by_name = {c["name"]: c for c in res["children"]}
        self.assertIn("2026", by_name)
        self.assertIn("30.WORK", by_name)

        node_2026 = by_name["2026"]
        self.assertEqual(node_2026["status"], "managed", "直下0枚でも子フォルダに管理写真があれば managed 扱いになること")
        self.assertEqual(node_2026["count"], 0, "直下枚数は 0 枚")
        self.assertEqual(node_2026["sub_count"], 3, "子フォルダ枚数は 3 枚")
        self.assertEqual(node_2026["total"], 3, "合計枚数は 0 + 3 = 3 枚")
        self.assertTrue(node_2026["has_managed"])
        self.assertTrue(node_2026["has_children"])

        node_work = by_name["30.WORK"]
        self.assertEqual(node_work["status"], "unmanaged", "直下も子フォルダも0枚のフォルダは unmanaged のまま")
        self.assertEqual(node_work["count"], 0)
        self.assertEqual(node_work["sub_count"], 0)
        self.assertEqual(node_work["total"], 0)

        # 2. get_folders_summary でも 2026 が status='managed' として返ること
        summary_map = {
            os.path.normcase(os.path.normpath(f["directory_path"])): f
            for f in get_folders_summary()
        }
        key_2026 = os.path.normcase(os.path.normpath(str(dir_2026)))
        self.assertIn(key_2026, summary_map)
        self.assertEqual(summary_map[key_2026]["status"], "managed")

        # 3. 左クリック時の check_folder_diff で親フォルダ(2026)配下の子フォルダ・ファイルの増減を検知できること
        from server.scanner import check_folder_diff
        import shutil

        # 実体ファイルを配置して差分なしの状態を作る
        f1 = dir_202601 / "IMG_001.JPG"
        f2 = dir_202601 / "IMG_002.JPG"
        f3 = dir_202602 / "IMG_003.JPG"
        f1.write_bytes(b"X" * 1000)
        f2.write_bytes(b"X" * 1100)
        f3.write_bytes(b"X" * 1200)

        diff_clean = check_folder_diff(str(dir_2026))
        self.assertTrue(diff_clean["is_managed"])
        self.assertFalse(diff_clean["has_changes"], "実体とDBが一致していれば差分なし")

        # OS側で新しい子フォルダ 202603（中に写真2枚）と、既存子フォルダ 202601 内への新規写真1枚を追加し、
        # さらに既存子フォルダ 202602（写真1枚）を削除したケース
        dir_202603 = dir_2026 / "202603"
        dir_202603.mkdir(parents=True, exist_ok=True)
        (dir_202603 / "NEW_A.JPG").write_bytes(b"X" * 1500)
        (dir_202603 / "NEW_B.JPG").write_bytes(b"X" * 1600)
        (dir_202601 / "IMG_004.JPG").write_bytes(b"X" * 1300)
        shutil.rmtree(dir_202602)

        diff_changed = check_folder_diff(str(dir_2026))
        self.assertTrue(diff_changed["is_managed"])
        self.assertTrue(diff_changed["has_changes"])
        self.assertTrue(diff_changed["has_subfolder_changes"])
        self.assertEqual(diff_changed["added_folders"], ["202603"], "OS側で追加された新規子フォルダが検知されること")
        self.assertEqual(diff_changed["deleted_folders"], ["202602"], "OS側で削除された管理下子フォルダが検知されること")
        self.assertEqual(diff_changed["added"], 3, "202603の2枚 + 202601の1枚 = 計3枚の新規ファイルが検知されること")
        self.assertEqual(diff_changed["deleted"], 1, "消失した202602内の1枚が削除・消失として検知されること")

    def test_25_cross_media_duplicate_unlink_and_re_promote_primary(self) -> None:
        """
        メディアAとメディアBの両方に登録された同一写真(001.jpg)が1つのphotosエンティティ＋2つのphoto_linksで管理され、
        1. 片方（メディアB）から消えた時はメディアBのリンクのみ削除され、メディアAを代表として通常表示を維持（リンク消失送りにならない）
        2. 両方（メディアA・Bとも）から消えた時は is_unlinked=1（リンク消失リスト送り）になり評価・タグ・サムネイルを保持
        3. 後日メディアC（または再接続メディアB）で見つかった時は同一photo_idにリンクが張り直され自動復活することを検証
        """
        from server.database import (
            add_tag_to_photo,
            get_photo_by_id,
            get_photos,
            unlink_missing_photos_in_folder,
            update_rating,
            upsert_photo,
        )

        dir_a = Path(self._temp_dir.name) / "MediaA_DCIM"
        dir_b = Path(self._temp_dir.name) / "MediaB_DCIM"
        dir_c = Path(self._temp_dir.name) / "MediaC_Backup"
        dir_a.mkdir(parents=True, exist_ok=True)
        dir_b.mkdir(parents=True, exist_ok=True)
        dir_c.mkdir(parents=True, exist_ok=True)

        file_a = dir_a / "001.jpg"
        file_b = dir_b / "001.jpg"
        file_c = dir_c / "001_moved.jpg"
        file_a.write_bytes(b"J" * 2048)
        file_b.write_bytes(b"J" * 2048)

        # メディアBとメディアAの両方を登録 → 同一の photo_id に統合され link_count=2 になること
        id_b = upsert_photo({
            "file_path": str(file_b),
            "directory_path": str(dir_b),
            "file_name": "001.jpg",
            "file_size": 2048,
            "date_taken": "2026-08-15 14:30:00",
        })
        id_a = upsert_photo({
            "file_path": str(file_a),
            "directory_path": str(dir_a),
            "file_name": "001.jpg",
            "file_size": 2048,
            "date_taken": "2026-08-15 14:30:00",
        })
        self.assertEqual(id_a, id_b, "同一画像は1つのphotosエンティティに統合されること")
        update_rating(id_a, 2)
        add_tag_to_photo(id_a, "お気に入り/夏休み")

        all_stacked = [p for p in get_photos(stacked=True) if p["id"] == id_a]
        self.assertEqual(len(all_stacked), 1)
        self.assertEqual(all_stacked[0]["duplicate_count"], 2)

        # ステップ1: メディアBから 001.jpg が消失し、unlink_missing_photos_in_folder を実行
        file_b.unlink()
        unlinked_num_b = unlink_missing_photos_in_folder(str(dir_b), recursive=False)
        self.assertEqual(unlinked_num_b, 1)

        # まだメディアAに実ファイルが残っているため、リンク消失リストには送られず、メディアAを代表として通常表示されること
        after_b_gone = [p for p in get_photos(stacked=True) if p["id"] == id_a]
        self.assertEqual(len(after_b_gone), 1, "生きているメディアA側の001.jpgが全体一覧に表示されること")
        self.assertEqual(after_b_gone[0]["duplicate_count"], 1, "B側リンクが消えて単独(duplicate_count=1)になること")
        self.assertEqual(os.path.normcase(after_b_gone[0]["file_path"]), os.path.normcase(str(file_a)))
        self.assertEqual(len([p for p in get_photos(unlinked_only=True) if p["id"] == id_a]), 0, "片方が生きている間はリンク消失リストに入らないこと")

        # ステップ2: 後日メディアAからも 001.jpg が消失（残りリンク0本）
        file_a.unlink()
        unlinked_num_a = unlink_missing_photos_in_folder(str(dir_a), recursive=False)
        self.assertEqual(unlinked_num_a, 1)

        # すべてのリンクが失われたため、通常一覧から消え「リンク消失した画像」リストに送られること
        self.assertEqual(len([p for p in get_photos(stacked=True) if p["id"] == id_a]), 0)
        unlinked_list = [p for p in get_photos(unlinked_only=True) if p["id"] == id_a]
        self.assertEqual(len(unlinked_list), 1, "全リンク消失時はリンク消失リストに保持されること")
        self.assertEqual(unlinked_list[0]["rating"], 2, "評価が保持されていること")
        self.assertIn("お気に入り/夏休み", unlinked_list[0]["tags"], "タグが保持されていること")

        # ステップ3: 後日メディアCで同じ画像（リネーム済み 001_moved.jpg）が見つかりスキャンされた場合、自動的にリンクが張り直され復活すること
        file_c.write_bytes(b"J" * 2048)
        id_c = upsert_photo({
            "file_path": str(file_c),
            "directory_path": str(dir_c),
            "file_name": "001_moved.jpg",
            "file_size": 2048,
            "date_taken": "2026-08-15 14:30:00",
        })
        self.assertEqual(id_c, id_a, "既存のphoto_idに再リンクされること")
        self.assertEqual(len([p for p in get_photos(unlinked_only=True) if p["id"] == id_a]), 0, "リンク消失状態が自動解除されること")
        restored = get_photo_by_id(id_a)
        self.assertEqual(os.path.normcase(restored["file_path"]), os.path.normcase(str(file_c)))
        self.assertEqual(restored["rating"], 2)
        self.assertIn("お気に入り/夏休み", restored["tags"])

    def test_26_legacy_duplicate_rows_migration_and_ideal_schema(self) -> None:
        """
        旧構造DB（重複写真が複数photos行として存在、vsn://退避パスあり、thumbnailsがfile_hash主キー、photo_tagsがid付き）から
        initialize_database() を実行した際、理想の4点セット構造へ無損失で統合マイグレーションされることを検証
        """
        import sqlite3
        from server.database import (
            close_thread_connection,
            get_connection,
            get_photo_by_id,
            get_photos,
             get_thumbnail,
            initialize_database,
        )

        close_thread_connection()
        mig_db_path = Path(self._temp_dir.name) / "legacy_dup_migration.db"
        raw_conn = sqlite3.connect(str(mig_db_path))
        raw_cur = raw_conn.cursor()
        raw_cur.execute(
            """
            CREATE TABLE photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE NOT NULL,
                file_name TEXT NOT NULL,
                directory_path TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                date_taken TEXT,
                rating INTEGER DEFAULT 0,
                is_favorite INTEGER DEFAULT 0,
                rotation INTEGER DEFAULT 0,
                volume_serial TEXT,
                is_unlinked INTEGER DEFAULT 0
            )
            """
        )
        raw_cur.execute(
            """
            CREATE TABLE photo_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                photo_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                UNIQUE(photo_id, tag)
            )
            """
        )
        raw_cur.execute(
            """
            CREATE TABLE thumbnails (
                file_hash TEXT PRIMARY KEY,
                photo_id INTEGER NOT NULL,
                data BLOB NOT NULL,
                width INTEGER,
                height INTEGER
            )
            """
        )
        # 同一画像がメディアA（vsn://退避中・評価2・タグA）とメディアB（回転90度・タグB・サムネイルあり）に分裂していた状態を再現
        raw_cur.execute(
            "INSERT INTO photos (id, file_path, file_name, directory_path, file_size, date_taken, rating, rotation, volume_serial) "
            "VALUES (10, 'vsn://AAAA1111/E:\\DCIM\\001.JPG', '001.JPG', 'E:\\DCIM', 555555, '2026-07-01 10:00:00', 2, 0, 'AAAA1111')"
        )
        raw_cur.execute(
            "INSERT INTO photos (id, file_path, file_name, directory_path, file_size, date_taken, rating, rotation, volume_serial) "
            "VALUES (20, 'D:\\Backup\\001_copy.JPG', '001_copy.JPG', 'D:\\Backup', 555555, '2026-07-01 10:00:00', 0, 90, 'BBBB2222')"
        )
        raw_cur.execute("INSERT INTO photo_tags (photo_id, tag) VALUES (10, '家族')")
        raw_cur.execute("INSERT INTO photo_tags (photo_id, tag) VALUES (20, '旅行')")
        raw_cur.execute("INSERT INTO thumbnails (file_hash, photo_id, data, width, height) VALUES ('20', 20, X'89504E47', 300, 200)")
        raw_cur.execute("CREATE TABLE migrations (name TEXT PRIMARY KEY)")
        raw_cur.execute("INSERT INTO migrations (name) VALUES ('rating_to_4tier_v1'), ('fix_mismatched_thumbnails_v1')")
        raw_conn.commit()
        raw_conn.close()

        prev_db = switch_database_path(mig_db_path)
        try:
            initialize_database()
            with get_connection() as conn:
                c = conn.cursor()
                photo_cnt = c.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
                link_cnt = c.execute("SELECT COUNT(*) FROM photo_links").fetchone()[0]
                pt_sql = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='photo_tags'").fetchone()[0]
                th_pk = [r["name"] for r in c.execute("PRAGMA table_info(thumbnails)").fetchall() if r["pk"]]

            self.assertEqual(photo_cnt, 1, "重複していた2行のphotosが1行（100万-重複分）に統合されること")
            self.assertEqual(link_cnt, 2, "2つのメディアの所在はphoto_linksに2行保持されること")
            self.assertIn("WITHOUT ROWID", pt_sql.upper())
            self.assertEqual(th_pk, ["photo_id"], "thumbnailsのPRIMARY KEYがphoto_id直結になっていること")

            all_p = get_photos(stacked=False)
            self.assertEqual(len(all_p), 1)
            master_id = all_p[0]["id"]
            detail = get_photo_by_id(master_id)
            self.assertEqual(detail["rating"], 2, "片方にあった評価が維持されること")
            self.assertEqual(detail["rotation"], 90, "もう片方にあった回転調整も統合されること")
            self.assertIn("家族", detail["tags"])
            self.assertIn("旅行", detail["tags"])
            self.assertEqual(detail["duplicate_count"], 2)
            self.assertFalse(detail["file_path"].startswith("vsn://"), "vsn://退避プレフィックスが除去されていること")
            thumb = get_thumbnail(master_id)
            self.assertIsNotNone(thumb, "サムネイルも代表IDへ引き継がれること")
        finally:
            switch_database_path(prev_db)


if __name__ == "__main__":
    unittest.main()



