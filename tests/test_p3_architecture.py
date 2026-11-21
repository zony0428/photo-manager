"""
Phase 3（定数時間アーキテクチャ・Lv.2インメモリ復号・Android並列ロック/一括JNI・2D仮想スクロール・配布安全ガード）統合回帰テスト
本番の cache/library.db や Tetheract_Mobile.html には一切触れず、一時ディレクトリ上で高速検証する。
"""

import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from scripts import build_android_apk, publish_release  # noqa: E402
from server import (  # noqa: E402
    field_log_store,
    lan_access,
    mobile_bundle,
    mobile_delta,
    scanner as scanner_mod,
    security as security_mod,
    sidecar as sidecar_mod,
    storage_manager,
)
from server.app import _API_PHOTOS_RESPONSE_CACHE, app  # noqa: E402
from server.database import (  # noqa: E402
    close_all_connections,
    get_cameras_summary,
    get_connection,
    get_photo_by_id,
    get_photos,
    initialize_database,
    recalculate_stacks,
    switch_database_path,
    upsert_photo,
)
from server.database import connection as db_conn_mod  # noqa: E402
from server.database.photos import backfill_missing_lens_models  # noqa: E402
from server.security import (  # noqa: E402
    configure_security_level,
    decrypted_bytes_context,
    initialize_security_state,
    is_vault_encrypted_file,
    open_loome_decrypted_stream,
    seal_all_files_in_directory,
    set_instance_file_for_test,
)


def _make_jpeg_bytes(width: int = 64, height: int = 48, color: tuple[int, int, int] = (70, 130, 180)) -> bytes:
    """テスト用の最小JPEGバイト列を生成する"""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=color).save(buf, format="JPEG", quality=85)
    return buf.getvalue()


class TestPhase3Architecture(unittest.TestCase):
    """P3-A/B/C/D の構造改革・定数時間化・インメモリ復号・配布安全ガードの統合検証"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._temp_dir = tempfile.TemporaryDirectory()
        cls.tmp_root = Path(cls._temp_dir.name)
        cls.tmp_cache = cls.tmp_root / "cache"
        cls.tmp_loome = cls.tmp_root / "Loome"
        cls.tmp_cache.mkdir(parents=True, exist_ok=True)
        cls.tmp_loome.mkdir(parents=True, exist_ok=True)

        cls._orig = {
            "db_path": db_conn_mod.DB_PATH,
            "pbkdf2": security_mod.PBKDF2_ITERATIONS,
            "derive_defaults": security_mod.derive_kek.__defaults__,
            "lan_auth_file": lan_access._LAN_AUTH_FILE,
            "lan_paired": lan_access._lan_paired,
            "standalone_html": mobile_bundle.STANDALONE_HTML_PATH,
            "delta_db": mobile_delta.DELTA_DB_PATH,
            "locker_state": mobile_delta.LOCKER_STATE_PATH,
            "loome_dir": storage_manager.LOOME_DIR,
            "storage_dir": storage_manager.STORAGE_DIR,
            "legacy_dir": storage_manager.LEGACY_STORAGE_DIR,
            "field_logs_dir": field_log_store.FIELD_LOGS_DIR,
        }

        security_mod.PBKDF2_ITERATIONS = 1_000
        security_mod.derive_kek.__defaults__ = (1_000,)

        lan_access._LAN_AUTH_FILE = cls.tmp_cache / ".mobile_lan_auth.json"
        mobile_bundle.STANDALONE_HTML_PATH = cls.tmp_root / "Tetheract_Mobile.html"
        mobile_delta.DELTA_DB_PATH = cls.tmp_cache / "mobile_delta.db"
        mobile_delta.LOCKER_STATE_PATH = cls.tmp_cache / "mobile_locker_state.json"
        storage_manager.LOOME_DIR = cls.tmp_loome
        storage_manager.STORAGE_DIR = cls.tmp_loome
        storage_manager.LEGACY_STORAGE_DIR = cls.tmp_root / "legacy_storage_unused"
        field_log_store.FIELD_LOGS_DIR = cls.tmp_cache / "field_logs"

        cls.test_db_path = cls.tmp_cache / "p3_test_library.db"
        set_instance_file_for_test(cls.tmp_root / ".tetheract_instance_p3")
        switch_database_path(cls.test_db_path)
        initialize_database(fast_boot=True)
        initialize_security_state(force_reload=True)

        cls.local_client = TestClient(app, base_url="http://127.0.0.1:8088")

    @classmethod
    def tearDownClass(cls) -> None:
        close_all_connections()
        set_instance_file_for_test(None)
        switch_database_path(cls._orig["db_path"])

        security_mod.PBKDF2_ITERATIONS = cls._orig["pbkdf2"]
        security_mod.derive_kek.__defaults__ = cls._orig["derive_defaults"]
        lan_access._LAN_AUTH_FILE = cls._orig["lan_auth_file"]
        lan_access._lan_paired = cls._orig["lan_paired"]
        mobile_bundle.STANDALONE_HTML_PATH = cls._orig["standalone_html"]
        mobile_delta.DELTA_DB_PATH = cls._orig["delta_db"]
        mobile_delta.LOCKER_STATE_PATH = cls._orig["locker_state"]
        storage_manager.LOOME_DIR = cls._orig["loome_dir"]
        storage_manager.STORAGE_DIR = cls._orig["storage_dir"]
        storage_manager.LEGACY_STORAGE_DIR = cls._orig["legacy_dir"]
        field_log_store.FIELD_LOGS_DIR = cls._orig["field_logs_dir"]
        cls._temp_dir.cleanup()

    def setUp(self) -> None:
        if security_mod.get_current_security_level() != 0:
            configure_security_level(0, current_password="P3VaultPass99")
        _API_PHOTOS_RESPONSE_CACHE.clear()
        with get_connection() as conn:
            conn.execute("DELETE FROM photo_tags")
            conn.execute("DELETE FROM thumbnails")
            conn.execute("DELETE FROM photo_links")
            conn.execute("DELETE FROM photos")
            conn.execute("DELETE FROM scan_roots")
            conn.execute("DELETE FROM volumes")
            conn.commit()

    def test_01_has_xmp_column_sync_and_zero_scandir_listing(self) -> None:
        """fast_boot での has_xmp カラム保証・スキャン/XMP書出/削除連動・一覧取得時の os.scandir 完全非依存を検証"""
        with get_connection() as conn:
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(photos)").fetchall()}
        self.assertIn("has_xmp", cols)

        album_dir = self.tmp_root / "XmpAlbum"
        album_dir.mkdir(parents=True, exist_ok=True)
        img_with_xmp = album_dir / "WITH_XMP.JPG"
        img_plain = album_dir / "PLAIN.JPG"
        img_with_xmp.write_bytes(_make_jpeg_bytes(96, 72, (180, 60, 60)))
        img_plain.write_bytes(_make_jpeg_bytes(64, 48, (60, 180, 60)) + b"\x00" * 17)
        (album_dir / "WITH_XMP.xmp").write_text(
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4"/>'
            "</rdf:RDF></x:xmpmeta>",
            encoding="utf-8",
        )

        with patch("server.preload_thumbnails.preload_all_thumbnails", return_value=0):
            scanner_mod.scan_directory(str(album_dir), recursive=False)

        rows_all = get_photos(stacked=False)
        by_name = {r["file_name"]: r for r in rows_all}
        self.assertTrue(by_name["WITH_XMP.JPG"]["has_xmp"])
        self.assertFalse(by_name["PLAIN.JPG"]["has_xmp"])

        # attr_filter="xmp" が SQL の has_xmp カラムで正確に絞り込めること
        xmp_only = get_photos(attr_filter="xmp", stacked=False)
        self.assertEqual([r["file_name"] for r in xmp_only], ["WITH_XMP.JPG"])

        # PLAIN.JPG に XMP サイドカーを書き出すと DB の has_xmp=1 が自動同期されること
        plain_rec = get_photo_by_id(by_name["PLAIN.JPG"]["id"])
        written_xmp = sidecar_mod.write_xmp_sidecar_for_photo(plain_rec, plain_rec["file_path"])
        self.assertIsNotNone(written_xmp)
        self.assertTrue(Path(written_xmp).is_file())
        self.assertEqual(len(get_photos(attr_filter="xmp", stacked=False)), 2)

        # XMP サイドカー削除時に DB の has_xmp=0 へ自動復帰すること
        deleted_cnt = sidecar_mod.delete_xmp_sidecar_for_photo(plain_rec["file_path"])
        self.assertEqual(deleted_cnt, 1)
        self.assertEqual([r["file_name"] for r in get_photos(attr_filter="xmp", stacked=False)], ["WITH_XMP.JPG"])

        # 一覧取得 API が os.scandir を一切呼ばずに定数時間で応答すること
        _API_PHOTOS_RESPONSE_CACHE.clear()
        with patch("os.scandir", side_effect=AssertionError("GET /api/photos 実行中に os.scandir を呼んではならない")):
            resp = self.local_client.get("/api/photos")
        self.assertEqual(resp.status_code, 200)
        api_items = {p["file_name"]: p for p in resp.json()["photos"]}
        self.assertTrue(api_items["WITH_XMP.JPG"]["has_xmp"])
        self.assertFalse(api_items["PLAIN.JPG"]["has_xmp"])

    def test_02_slim_stack_photos_pagination_and_stack_detail_api(self) -> None:
        """スリム化された stack_photos 構造、GET /api/stacks/{id} 詳細取得、および limit/offset ページングを検証"""
        p1 = upsert_photo({
            "file_path": str(self.tmp_root / "Burst" / "B001.JPG"),
            "file_name": "B001.JPG",
            "directory_path": str(self.tmp_root / "Burst"),
            "file_size": 3001,
            "date_taken": "2026-10-01 10:00:00",
            "subsec_time": "10",
            "camera_model": "LUMIX DC-S1R",
            "lens_model": "LUMIX S 24-105/F4",
            "iso": 100,
        })
        p2 = upsert_photo({
            "file_path": str(self.tmp_root / "Burst" / "B002.JPG"),
            "file_name": "B002.JPG",
            "directory_path": str(self.tmp_root / "Burst"),
            "file_size": 3002,
            "date_taken": "2026-10-01 10:00:00",
            "subsec_time": "30",
            "camera_model": "LUMIX DC-S1R",
            "lens_model": "LUMIX S 24-105/F4",
            "iso": 200,
        })
        for idx in range(3):
            upsert_photo({
                "file_path": str(self.tmp_root / "Singles" / f"S00{idx}.JPG"),
                "file_name": f"S00{idx}.JPG",
                "directory_path": str(self.tmp_root / "Singles"),
                "file_size": 4000 + idx,
                "date_taken": f"2026-10-02 12:{idx * 15:02d}:00",
            })

        recalculate_stacks()
        r_list = self.local_client.get("/api/photos")
        self.assertEqual(r_list.status_code, 200)
        photos = r_list.json()["photos"]
        self.assertEqual(len(photos), 4)  # スタック代表1件 + 単写真3件

        stacked_rep = next(p for p in photos if p.get("stack_id"))
        sid = stacked_rep["stack_id"]
        stack_members = stacked_rep["stack_photos"]
        self.assertEqual({m["id"] for m in stack_members}, {p1, p2})
        # スリム辞書：フロントエンド必須キーは維持し、冗長な長大EXIF文字列等は省略されていること
        for m in stack_members:
            self.assertIn("id", m)
            self.assertIn("file_name", m)
            self.assertIn("file_path", m)
            self.assertIn("is_stack_primary", m)
            self.assertNotIn("camera_model", m)
            self.assertNotIn("lens_model", m)
            self.assertNotIn("content_key", m)

        # GET /api/stacks/{stack_id} では全メンバーのフルEXIF属性を取得できること
        r_detail = self.local_client.get(f"/api/stacks/{sid}")
        self.assertEqual(r_detail.status_code, 200)
        detail = r_detail.json()
        self.assertEqual(detail["stack_count"], 2)
        self.assertEqual({m["id"] for m in detail["photos"]}, {p1, p2})
        self.assertEqual(detail["photos"][0]["camera_model"], "LUMIX DC-S1R")
        self.assertEqual(detail["photos"][0]["lens_model"], "LUMIX S 24-105/F4")

        r_404 = self.local_client.get("/api/stacks/999999")
        self.assertEqual(r_404.status_code, 404)

        # limit / offset ページネーションが重複・欠落なくスライスを返しキャッシュキーも分離されること
        page1 = self.local_client.get("/api/photos", params={"limit": 2, "offset": 0}).json()["photos"]
        page2 = self.local_client.get("/api/photos", params={"limit": 2, "offset": 2}).json()["photos"]
        self.assertEqual(len(page1), 2)
        self.assertEqual(len(page2), 2)
        self.assertEqual([p["id"] for p in page1] + [p["id"] for p in page2], [p["id"] for p in photos])

    def test_03_lens_empty_sentinel_and_unchanged_scan_zero_reopen(self) -> None:
        """レンズ無し画像の空文字センチネル永続化（再open防止）と未変更フォルダ再スキャンの高速スキップを検証"""
        nolens_dir = self.tmp_root / "NoLensScan"
        nolens_dir.mkdir(parents=True, exist_ok=True)
        nl_file = nolens_dir / "NOLENS_01.JPG"
        nl_file.write_bytes(_make_jpeg_bytes(64, 64, (120, 120, 120)))

        with patch("server.preload_thumbnails.preload_all_thumbnails", return_value=0):
            scanner_mod.scan_directory(str(nolens_dir), recursive=False)

        with get_connection() as conn:
            row = conn.execute("SELECT id, lens_model FROM photos WHERE file_name = 'NOLENS_01.JPG'").fetchone()
        self.assertIsNotNone(row)
        # スキャン時点でレンズ無し探索済みセンチネル '' が記録されること
        self.assertEqual(row["lens_model"], "")
        # カメラ・レンズ集計で空文字レンズが誤って実在レンズ扱いされず、excluded_lenses でも正しく残ること
        cam_summary = get_cameras_summary()
        for entry in cam_summary:
            for l_item in entry.get("lenses", []):
                l_name = l_item.get("lens_model") if isinstance(l_item, dict) else l_item
                self.assertNotEqual(l_name, "")
        kept = get_photos(excluded_lenses=["FE 24-70mm F2.8 GM"], stacked=False)
        self.assertEqual([r["id"] for r in kept], [row["id"]])

        # 旧DB相当の lens_model = NULL に戻した上で backfill を走らせると、1回目で '' が埋まり2回目は open 0回になること
        with get_connection() as conn:
            conn.execute("UPDATE photos SET lens_model = NULL WHERE id = ?", (row["id"],))
            conn.commit()
        backfill_missing_lens_models(directory_path=str(nolens_dir), recursive=False)
        with get_connection() as conn:
            after_bf = conn.execute("SELECT lens_model FROM photos WHERE id = ?", (row["id"],)).fetchone()["lens_model"]
        self.assertEqual(after_bf, "")

        with patch("server.raw_loader.extract_fallback_lens_model", side_effect=AssertionError("探索済み '' を再openしてはならない")):
            cnt2 = backfill_missing_lens_models(directory_path=str(nolens_dir), recursive=False)
        self.assertEqual(cnt2, 0)

        # 未変更フォルダの再スキャン時は get_logical_file_size も recalculate_stacks も呼ばれないこと
        with (
            patch("server.security.get_logical_file_size", side_effect=AssertionError("未変更ファイルを open+read(8) してはならない")),
            patch("server.scanner.recalculate_stacks", side_effect=AssertionError("変更ゼロ時に recalculate_stacks を呼んではならない")),
            patch("server.preload_thumbnails.preload_all_thumbnails", side_effect=AssertionError("変更ゼロ時に preload_all_thumbnails を呼んではならない")),
        ):
            res2 = scanner_mod.scan_directory(str(nolens_dir), recursive=False)
        self.assertEqual(res2.get("added", 0), 0)
        self.assertEqual(res2.get("updated", 0), 0)

    def test_04_lv2_decrypted_stream_and_bytes_context_zero_tempfile(self) -> None:
        """Lv.2 カプセル化ファイルのシーク復号ストリームと BytesIO コンテキストが一時ファイル書出ゼロで完全一致することを検証"""
        vault_dir = self.tmp_root / "Lv2StreamLoome"
        vault_dir.mkdir(parents=True, exist_ok=True)
        storage_manager.LOOME_DIR = vault_dir
        storage_manager.STORAGE_DIR = vault_dir
        try:
            # 64KB 暗号化チャンク境界を跨ぐ 100KB の擬似RAWバイナリを生成
            orig_payload = bytes((i * 73 + 19) % 256 for i in range(100 * 1024))
            raw_file = vault_dir / "SAMPLE_64K_BOUNDARY.ARW"
            raw_file.write_bytes(orig_payload)

            configure_security_level(2, new_password="P3VaultPass99")
            seal_all_files_in_directory(vault_dir)
            self.assertTrue(is_vault_encrypted_file(raw_file))
            self.assertEqual(raw_file.stat().st_size, len(orig_payload) + 72)

            with (
                patch("tempfile.mkstemp", side_effect=AssertionError("%TEMP% への mkstemp 書き出し禁止")),
                patch("tempfile.NamedTemporaryFile", side_effect=AssertionError("%TEMP% への一時ファイル生成禁止")),
            ):
                # 1. open_loome_decrypted_stream: 全読み・64KB境界跨ぎシーク・SEEK_END シーク・EOF 境界（72Bフッター非漏洩）
                with open_loome_decrypted_stream(raw_file) as st:
                    self.assertEqual(st.read(16), orig_payload[:16])
                    # 64KB (65536) 境界前後を跨いで読み取る
                    st.seek(65500)
                    cross = st.read(128)
                    self.assertEqual(cross, orig_payload[65500 : 65500 + 128])
                    # SEEK_END で末尾32Bを読み取り、さらに先を読んでもフッターが混入せず b"" になること
                    st.seek(-32, io.SEEK_END)
                    self.assertEqual(st.tell(), len(orig_payload) - 32)
                    self.assertEqual(st.read(64), orig_payload[-32:])
                    self.assertEqual(st.read(16), b"")
                    st.seek(0)
                    self.assertEqual(st.read(), orig_payload)

                # 2. decrypted_bytes_context: Lv.2 時はオンメモリ io.BytesIO を返すこと
                with decrypted_bytes_context(raw_file) as src_obj:
                    self.assertIsInstance(src_obj, io.BytesIO)
                    self.assertEqual(src_obj.read(), orig_payload)
        finally:
            if security_mod.get_current_security_level() != 0:
                configure_security_level(0, current_password="P3VaultPass99")
            storage_manager.LOOME_DIR = self.tmp_loome
            storage_manager.STORAGE_DIR = self.tmp_loome

    def test_05_publish_release_branch_guard_and_build_dist_v2_guards(self) -> None:
        """publish_release.py のブランチ/VERSIONガード、v2 APK鮮度検査、build_dist.bat の保護ガードを検証"""
        # 正常系: main + 1.x -> public/main
        publish_release.validate_release_branch_and_version("main", "1.8.6", target_public_branch="main")
        # 正常系: 明示フラグ付き v2 + 2.x -> public/v2
        publish_release.validate_release_branch_and_version(
            "v2", "2.1.7", target_public_branch="v2", allow_v2_public=True
        )

        # 異常系: public/main への v2 / 2.x 誤プッシュやブランチ・メジャー系列不一致を即遮断
        invalid_cases = [
            ("v2", "2.1.7", "main", False),
            ("v2", "2.1.7", "main", True),  # allow_v2_public=True でも public/main 上書きは絶対拒否
            ("v2", "1.8.6", "v2", True),
            ("main", "2.1.7", "main", False),
            ("main", "2.1.7", "v2", True),
            ("HEAD", "1.8.6", "main", False),
            ("feature/exp", "1.8.6", "main", False),
        ]
        for branch, ver, pub_br, allow_v2 in invalid_cases:
            with self.subTest(branch=branch, ver=ver, pub_br=pub_br, allow_v2=allow_v2):
                with self.assertRaises(RuntimeError):
                    publish_release.validate_release_branch_and_version(
                        branch, ver, target_public_branch=pub_br, allow_v2_public=allow_v2
                    )

        # check_v2_apk_freshness: ①APK欠落 → NG、②ソース更新後APK未再ビルド → NG、③APK再ビルド後 → OK
        fake_root = self.tmp_root / "FakeRepoForApkCheck"
        ok_missing, msg_missing = publish_release.check_v2_apk_freshness(fake_root)
        self.assertFalse(ok_missing)
        self.assertIn("見つかりません", msg_missing)

        kt_src = fake_root / "android" / "app" / "src" / "main" / "java" / "com" / "tetheract" / "pm" / "MainActivity.kt"
        js_src = fake_root / "frontend" / "js" / "mobile.js"
        apk_out = fake_root / "dist_v2" / "android" / "Tetheract_Android.apk"
        kt_src.parent.mkdir(parents=True, exist_ok=True)
        js_src.parent.mkdir(parents=True, exist_ok=True)
        apk_out.parent.mkdir(parents=True, exist_ok=True)
        kt_src.write_text("class MainActivity {}\n", encoding="utf-8")
        js_src.write_text("console.log('ok');\n", encoding="utf-8")
        apk_out.write_bytes(b"PK\x03\x04dummyapk")

        now = time.time()
        os.utime(apk_out, (now - 120, now - 120))
        os.utime(kt_src, (now - 10, now - 10))
        ok_stale, msg_stale = publish_release.check_v2_apk_freshness(fake_root)
        self.assertFalse(ok_stale)
        self.assertIn("MainActivity.kt", msg_stale)

        os.utime(apk_out, (now + 5, now + 5))
        ok_fresh, _ = publish_release.check_v2_apk_freshness(fake_root)
        self.assertTrue(ok_fresh)

        # build_dist.bat に v2 APK鮮度ガードと開発ルート Tetheract.exe 上書き保護ガードが存在すること
        bat_text = (PROJECT_ROOT / "build_dist.bat").read_text(encoding="utf-8")
        self.assertIn("--check-v2-apk", bat_text)
        self.assertIn('if "%IS_V2%"=="1"', bat_text)
        self.assertIn("root Tetheract.exe preserved", bat_text)

    def test_06_p3_android_rwlock_batch_jni_and_custom_event_contracts(self) -> None:
        """Android ReadWriteLock・一括保存JNI契約・SAFキャッシュ分離・ストリームRAW抽出・CustomEvent統合を検証"""
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(build_android_apk.verify_project_integrity(sync_assets=False))

        pkg_dir = PROJECT_ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "tetheract" / "pm"
        locker_kt = (pkg_dir / "LockerDatabaseManager.kt").read_text(encoding="utf-8")
        self.assertIn("ReentrantReadWriteLock", locker_kt)
        self.assertIn("fun savePhotoChangesBatchJson(", locker_kt)

        bridge_kt = (pkg_dir / "TetheractNativeBridge.kt").read_text(encoding="utf-8")
        self.assertIn("fun savePhotoChangesBatchJson(", bridge_kt)
        self.assertIn("isUsbConnectedCached(", bridge_kt)

        saf_kt = (pkg_dir / "SafUsbManager.kt").read_text(encoding="utf-8")
        self.assertNotIn("input.readBytes()", saf_kt)
        self.assertIn("fun isUsbConnectedCached(", saf_kt)

        data_adapter_js = (PROJECT_ROOT / "frontend" / "js" / "adapters" / "data_adapter.js").read_text(encoding="utf-8")
        self.assertIn("savePhotoChangesBatchJson(", data_adapter_js)
        self.assertIn("tetheract:usb-sync-completed", data_adapter_js)

    def test_07_p3_pc_virtual_grid_and_shared_tree_builder_wiring(self) -> None:
        """PC側 2D仮想スクロールと core/tree_builder.js への6モジュール共通配線が維持されていることを検証"""
        app_js = (PROJECT_ROOT / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("grid-virtual-spacer", app_js)
        self.assertIn("function ensureCardsRenderedUpTo(", app_js)

        tree_js = (PROJECT_ROOT / "frontend" / "js" / "core" / "tree_builder.js").read_text(encoding="utf-8")
        self.assertIn("buildTagHierarchy", tree_js)
        self.assertIn("buildTagTreeMap", tree_js)

        wired_pc_files = (
            "sidebar_filters.js",
            "inspector.js",
            "folder_tree.js",
            "selection.js",
            "sidebar_cascade_flyout.js",
            "filter_chips.js",
        )
        for fname in wired_pc_files:
            content = (PROJECT_ROOT / "frontend" / "js" / fname).read_text(encoding="utf-8")
            self.assertIn(
                "TreeBuilder",
                content,
                f"frontend/js/{fname} が共通 TreeBuilder を利用していません",
            )

    def test_08_cloud_drive_original_view_and_vsn_isolation(self):
        """Google ドライブ仮想ドライブ解決・権限エラー耐性・原本/view応答・物理SDカードVSN隔離を検証"""
        from io import BytesIO
        from PIL import Image
        import server.app as app_mod

        def make_jpeg_bytes(color=(120, 180, 60)):
            buf = BytesIO()
            Image.new("RGB", (64, 48), color).save(buf, format="JPEG", quality=95)
            return buf.getvalue()

        scanner_mod.clear_online_cache()
        try:
            # 1. 未アクセスパスで PermissionError が発生しても _safe_exists が落ちずに False を返す
            with unittest.mock.patch.object(Path, "exists", side_effect=PermissionError("Access is denied")):
                self.assertFalse(scanner_mod._safe_exists(self.tmp_root / "blocked_gdrive"))

            # 2. "\その他のパソコン" マーカー + 仮想VSN 19831116 で別ドライブレターへ追従解決する
            cloud_stored = r"G:\その他のパソコン\StudioPC\Shoot\IMG_9001.JPG"
            expected_resolved = Path(r"H:\その他のパソコン\StudioPC\Shoot\IMG_9001.JPG")
            with unittest.mock.patch.object(
                scanner_mod,
                "_get_connected_drive_serial_map",
                return_value=({"19831116": "H:"}, {"H:": "19831116"}),
            ), unittest.mock.patch.object(
                scanner_mod, "_iter_cloud_candidate_drives", return_value=["H:"]
            ), unittest.mock.patch.object(
                scanner_mod, "_get_gdrive_letters", return_value={"H:"}
            ), unittest.mock.patch.object(
                scanner_mod,
                "_safe_exists",
                side_effect=lambda p: str(p).replace("/", "\\").lower() == str(expected_resolved).lower(),
            ):
                resolved_p, is_online = scanner_mod.resolve_portable_path(
                    cloud_stored, expected_serial="19831116"
                )
                self.assertTrue(is_online)
                self.assertEqual(str(resolved_p).lower(), str(expected_resolved).lower())

            # 3. マーカー外のカスタムパスでも Google Drive ラベルドライブ + 仮想VSN 19831116 で追従解決する
            custom_stored = r"G:\ClientArchive\shot.jpg"
            expected_custom = Path(r"H:\ClientArchive\shot.jpg")
            with unittest.mock.patch.object(
                scanner_mod, "_get_connected_drive_serial_map", return_value=({}, {})
            ), unittest.mock.patch.object(
                scanner_mod, "_iter_cloud_candidate_drives", return_value=["H:"]
            ), unittest.mock.patch.object(
                scanner_mod, "_get_gdrive_letters", return_value={"H:"}
            ), unittest.mock.patch.object(
                scanner_mod,
                "_safe_exists",
                side_effect=lambda p: str(p).replace("/", "\\").lower() == str(expected_custom).lower(),
            ):
                resolved_c, is_c_online = scanner_mod.resolve_portable_path(
                    custom_stored, expected_serial="19831116"
                )
                self.assertTrue(is_c_online)
                self.assertEqual(str(resolved_c).lower(), str(expected_custom).lower())

            # 4. 物理 SD カード（VSN 違いの EOS_DIGITAL 等）は別シリアルの同ドライブ文字へ誤一致しない
            sd_stored = r"E:\DCIM\100CANON\IMG_0001.JPG"
            with unittest.mock.patch.object(
                scanner_mod,
                "_get_connected_drive_serial_map",
                return_value=({"BBBB-2222": "E:"}, {"E:": "BBBB-2222"}),
            ), unittest.mock.patch.object(
                scanner_mod, "_iter_cloud_candidate_drives", return_value=["H:"]
            ), unittest.mock.patch.object(
                scanner_mod, "_get_gdrive_letters", return_value={"H:"}
            ), unittest.mock.patch.object(
                scanner_mod, "_safe_exists", return_value=True
            ):
                _, is_sd_online = scanner_mod.resolve_portable_path(
                    sd_stored, expected_serial="AAAA-1111"
                )
                self.assertFalse(is_sd_online)

            # 5. /api/photo/{id}/view のクラウドオンデマンド読込・ペアJPEGフォールバック・オフラインETag非固定を検証
            cloud_jpg = self.tmp_root / "cloud_ondemand.jpg"
            cloud_bytes = make_jpeg_bytes((10, 160, 220))
            cloud_jpg.write_bytes(cloud_bytes)
            pid_cloud = upsert_photo({
                "file_path": str(cloud_jpg),
                "directory_path": str(cloud_jpg.parent),
                "file_name": cloud_jpg.name,
                "file_size": len(cloud_bytes),
                "is_raw": 0,
            })
            with unittest.mock.patch.object(app_mod, "is_cloud_or_ondemand_path", return_value=True):
                res_cloud = self.local_client.get(f"/api/photo/{pid_cloud}/view")
            self.assertEqual(res_cloud.status_code, 200)
            self.assertEqual(res_cloud.headers.get("X-Photo-View-Source"), "original")
            self.assertEqual(res_cloud.content, cloud_bytes)

            # 6. 主パス RAW がオフラインでも、オンラインな paired_raw_path（JPEG）があればフォールバック配信する
            paired_jpg = self.tmp_root / "paired_online.jpg"
            paired_bytes = make_jpeg_bytes((220, 90, 40))
            paired_jpg.write_bytes(paired_bytes)
            offline_raw = self.tmp_root / "missing_raw_dir" / "IMG_PAIR_01.CR3"
            pid_pair = upsert_photo({
                "file_path": str(offline_raw),
                "directory_path": str(offline_raw.parent),
                "file_name": offline_raw.name,
                "file_size": 12345,
                "is_raw": 1,
                "raw_format": "CR3",
                "paired_raw_path": str(paired_jpg),
            })
            res_pair = self.local_client.get(f"/api/photo/{pid_pair}/view")
            self.assertEqual(res_pair.status_code, 200)
            self.assertEqual(res_pair.content, paired_bytes)

            # 7. 完全オフライン＋サムネイルのみ存在時は X-Photo-Offline: true & Cache-Control: no-store かつ ETag なし
            offline_only = self.tmp_root / "missing_offline_dir" / "OFFLINE_ONLY.JPG"
            pid_off = upsert_photo({
                "file_path": str(offline_only),
                "directory_path": str(offline_only.parent),
                "file_name": offline_only.name,
                "file_size": 9999,
                "is_raw": 0,
            })
            thumb_bytes = make_jpeg_bytes((40, 40, 40))
            with get_connection() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO thumbnails (photo_id, file_hash, data, width, height) VALUES (?, ?, ?, ?, ?)",
                    (pid_off, "offline_test_hash", thumb_bytes, 64, 48),
                )
                conn.commit()
            res_off = self.local_client.get(f"/api/photo/{pid_off}/view")
            self.assertEqual(res_off.status_code, 200)
            self.assertEqual(res_off.headers.get("X-Photo-Offline"), "true")
            self.assertIn("no-store", res_off.headers.get("Cache-Control", ""))
            self.assertIsNone(res_off.headers.get("ETag"))
        finally:
            scanner_mod.clear_online_cache()

    def test_09_android_native_revision_guard_and_download_wiring(self):
        """Android UIホットアップデートの native_revision 互換ガードと APK ダウンロード配線を検証"""
        usb_kt = (
            PROJECT_ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "tetheract" / "pm" / "UsbOfflineUpdater.kt"
        ).read_text(encoding="utf-8")
        wifi_kt = (
            PROJECT_ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "tetheract" / "pm" / "WifiLockerSyncManager.kt"
        ).read_text(encoding="utf-8")
        main_kt = (
            PROJECT_ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "tetheract" / "pm" / "MainActivity.kt"
        ).read_text(encoding="utf-8")
        mobile_js = (PROJECT_ROOT / "frontend" / "js" / "mobile.js").read_text(encoding="utf-8")

        for sym in ("native_revision", "needsNativeApkUpdate", "hasIncompatibleNativeRev", "applyUiBundleFromZipFile", "applyUiBundleFromDocument"):
            self.assertIn(sym, usb_kt)
        self.assertIn("isNativeApkUpdateAvailable()", wifi_kt)
        self.assertIn("setDownloadListener", main_kt)
        self.assertIn("isNativeApkUpdateAvailable()", main_kt)
        self.assertIn("mDownloadApkBannerBtn", mobile_js)
        self.assertIn("/api/mobile/apk?t=", mobile_js)


if __name__ == "__main__":
    unittest.main()
