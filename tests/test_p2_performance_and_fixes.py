"""
Phase 2（体感パフォーマンス乱高下止血・サイレントバグ修正・モバイルUplink/同期堅牢化）統合回帰テスト
本番の cache/library.db や Tetheract_Mobile.html には一切触れず、一時ディレクトリ上で高速検証する。
"""

import io
from datetime import datetime
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from server import field_log_store, lan_access, mobile_bundle, mobile_delta, security as security_mod, storage_manager  # noqa: E402
from server.ai.worker import AITaggingWorker  # noqa: E402
from server.app import _API_PHOTOS_RESPONSE_CACHE, app  # noqa: E402
from server.database import (  # noqa: E402
    add_tag_to_photo,
    batch_update_photo_tone,
    close_all_connections,
    get_connection,
    get_connection_counts,
    get_photo_by_id,
    get_photos,
    initialize_database,
    remove_tag_from_photo,
    rotate_photo,
    save_thumbnail,
    stats as db_stats_mod,
    switch_database_path,
    update_rating,
    upsert_photo,
    upsert_volume,
)
from server.database import connection as db_conn_mod  # noqa: E402
from server.database.connection import (  # noqa: E402
    get_db_commit_seq,
    get_links_seq,
    get_photos_seq,
    get_tags_seq,
    get_thumbnails_seq,
)
from server.database.folders import clear_folders_fs_cache  # noqa: E402
from server.database.photos import _build_photo_links_union_branches  # noqa: E402
from server.database.schema import _FAST_BOOT_REQUIRED_MIGRATIONS  # noqa: E402
from server.lan_access import LAN_TOKEN, LAN_TOKEN_COOKIE  # noqa: E402
from server.mobile_sync_apply import apply_mobile_sync_changes  # noqa: E402
from server.routers import mobile_case_router as mcase_mod  # noqa: E402
from server.scanner import clear_online_cache  # noqa: E402
from server.security import (  # noqa: E402
    clear_drive_loome_cache,
    configure_security_level,
    get_logical_file_size,
    initialize_security_state,
    inspect_drive_loome_ownership,
    is_vault_encrypted_file,
    set_instance_file_for_test,
)


def _make_jpeg_bytes(width: int = 64, height: int = 48, color: tuple[int, int, int] = (40, 120, 200)) -> bytes:
    """テスト用の最小JPEGバイト列を生成する"""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=color).save(buf, format="JPEG", quality=85)
    return buf.getvalue()


class TestPhase2PerformanceAndFixes(unittest.TestCase):
    """P2-A（DB世代分離・UNION絞込・サイレントバグ）・P2-B（JS整合）・P2-C（Case転送・同期原子性）の回帰テスト"""

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

        cls.test_db_path = cls.tmp_cache / "p2_test_library.db"
        set_instance_file_for_test(cls.tmp_root / ".tetheract_instance_p2")
        switch_database_path(cls.test_db_path)
        initialize_database()
        initialize_security_state(force_reload=True)

        cls.local_client = TestClient(app, base_url="http://127.0.0.1:8088")
        cls.lan_client = TestClient(app, base_url="http://192.168.1.10:8088", client=("192.168.1.55", 51000))
        cls.lan_client.cookies.set(LAN_TOKEN_COOKIE, LAN_TOKEN)

    @classmethod
    def tearDownClass(cls) -> None:
        with mcase_mod._case_upload_lock:
            if mcase_mod._pending_case_flush_timer is not None:
                mcase_mod._pending_case_flush_timer.cancel()
                mcase_mod._pending_case_flush_timer = None
            mcase_mod._pending_case_imported_count = 0
            mcase_mod._pending_case_applied_count = 0
            mcase_mod._pending_case_need_heavy_clear = False

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
            configure_security_level(0, current_password="P2VaultPass88")
        with get_connection() as conn:
            conn.execute("DELETE FROM photo_tags")
            conn.execute("DELETE FROM thumbnails")
            conn.execute("DELETE FROM photo_links")
            conn.execute("DELETE FROM photos")
            conn.execute("DELETE FROM scan_roots")
            conn.execute("DELETE FROM volumes")
            conn.commit()

    def test_01_domain_commit_sequences_and_cache_isolation(self) -> None:
        """サムネイル保存・タグ編集・評価/回転/トーン変更・FSキャッシュクリアのドメイン世代分離を検証"""
        pid = upsert_photo({
            "file_path": str(self.tmp_root / "AlbumA" / "IMG_0001.JPG"),
            "file_name": "IMG_0001.JPG",
            "directory_path": str(self.tmp_root / "AlbumA"),
            "file_size": 4096,
            "date_taken": "2026-05-01 12:00:00",
        })
        with get_connection() as conn:
            conn.execute("UPDATE photos SET updated_at = '2026-05-01 12:00:00' WHERE id = ?", (pid,))
            conn.commit()

        # 1. save_thumbnail は thumbnails_seq のみ進め、photos.updated_at や他ドメインを汚染しない
        s_db0, s_ph0, s_tg0, s_lk0, s_th0 = (
            get_db_commit_seq(), get_photos_seq(), get_tags_seq(), get_links_seq(), get_thumbnails_seq()
        )
        save_thumbnail(pid, b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 20, 160, 120, "th_h1")
        self.assertEqual(get_thumbnails_seq(), s_th0 + 1)
        self.assertEqual(get_db_commit_seq(), s_db0)
        self.assertEqual(get_photos_seq(), s_ph0)
        self.assertEqual(get_tags_seq(), s_tg0)
        self.assertEqual(get_links_seq(), s_lk0)
        with get_connection() as conn:
            up_at = conn.execute("SELECT updated_at FROM photos WHERE id = ?", (pid,)).fetchone()["updated_at"]
        self.assertEqual(up_at, "2026-05-01 12:00:00")

        # 2. タグ追加・削除は db + tags のみ進め、photos_seq と links_seq は維持する
        add_tag_to_photo(pid, "風景/京都")
        self.assertGreater(get_tags_seq(), s_tg0)
        self.assertEqual(get_photos_seq(), s_ph0)
        self.assertEqual(get_links_seq(), s_lk0)
        s_tg1 = get_tags_seq()
        remove_tag_from_photo(pid, "風景/京都")
        self.assertGreater(get_tags_seq(), s_tg1)
        self.assertEqual(get_photos_seq(), s_ph0)
        self.assertEqual(get_links_seq(), s_lk0)

        # 3. 評価・回転・一括トーン更新は photos_seq（および invalidate_fast_cache）を進めつつ links_seq を維持する
        s_ph1 = get_photos_seq()
        update_rating(pid, 2)
        self.assertGreater(get_photos_seq(), s_ph1)
        self.assertEqual(get_links_seq(), s_lk0)

        s_ph2 = get_photos_seq()
        rotate_photo(pid, 90)
        self.assertGreater(get_photos_seq(), s_ph2)
        self.assertEqual(get_links_seq(), s_lk0)

        s_ph3 = get_photos_seq()
        batch_update_photo_tone([pid], brightness=10, contrast=5, saturation=0)
        self.assertGreater(get_photos_seq(), s_ph3)
        self.assertEqual(get_links_seq(), s_lk0)

        # 接続数キャッシュが links_seq をキーとして維持され、評価・タグ更新で再計算されないことを確認
        counts1 = get_connection_counts()
        self.assertIn("online_count", counts1)
        self.assertIn("total_count", counts1)
        s_lk_before_clear = get_links_seq()
        s_db_before_clear = get_db_commit_seq()
        clear_folders_fs_cache()
        self.assertEqual(get_db_commit_seq(), s_db_before_clear)
        self.assertEqual(get_links_seq(), s_lk_before_clear)

        # /api/photos レスポンスキャッシュがサムネイル保存では維持され、clear_online_cache() (links_seq) で即無効化されること
        _API_PHOTOS_RESPONSE_CACHE.clear()
        r_ph1 = self.local_client.get("/api/photos")
        self.assertEqual(r_ph1.status_code, 200)
        self.assertEqual(len(_API_PHOTOS_RESPONSE_CACHE), 1)

        save_thumbnail(pid, b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x01" * 20, 160, 120, "th_h2")
        r_ph2 = self.local_client.get("/api/photos")
        self.assertEqual(r_ph2.status_code, 200)
        self.assertEqual(len(_API_PHOTOS_RESPONSE_CACHE), 1, "サムネイル保存で /api/photos キャッシュキーが変化してはならない")

        clear_online_cache()
        self.assertEqual(get_db_commit_seq(), s_db_before_clear)
        self.assertGreater(get_links_seq(), s_lk_before_clear)
        r_ph3 = self.local_client.get("/api/photos")
        self.assertEqual(r_ph3.status_code, 200)
        self.assertEqual(len(_API_PHOTOS_RESPONSE_CACHE), 2, "clear_online_cache 後は links_seq 更新により新キャッシュエントリへ切り替わるべき")

    def test_02_directory_union_filter_equivalence_and_index_plan(self) -> None:
        """非相関 UNION フォルダ絞り込みのサブフォルダ境界・別ドライブ文字VSN一致・インデックス利用計画を検証"""
        upsert_volume("ABCD-1234", "SD_MAIN", "E:")
        p_exact = upsert_photo({
            "file_path": "E:\\Photos\\Trip\\A01.JPG",
            "file_name": "A01.JPG",
            "directory_path": "E:\\Photos\\Trip",
            "file_size": 1001,
            "date_taken": "2026-06-01 10:00:00",
            "volume_serial": "ABCD-1234",
        })
        p_sub = upsert_photo({
            "file_path": "E:\\Photos\\Trip\\Day2\\A02.JPG",
            "file_name": "A02.JPG",
            "directory_path": "E:\\Photos\\Trip\\Day2",
            "file_size": 1002,
            "date_taken": "2026-06-02 10:00:00",
            "volume_serial": "ABCD-1234",
        })
        # 境界プレフィックス衝突トラップ（Trip2 は Trip の検索にヒットしてはならない）
        p_boundary_trap = upsert_photo({
            "file_path": "E:\\Photos\\Trip2\\B01.JPG",
            "file_name": "B01.JPG",
            "directory_path": "E:\\Photos\\Trip2",
            "file_size": 1003,
            "date_taken": "2026-06-03 10:00:00",
            "volume_serial": "ABCD-1234",
        })
        # ドライブレター変動（過去 F:\Photos\Trip で登録された同一 VSN の写真、rel_dir は先頭 \ 付き）
        p_shifted_drive = upsert_photo({
            "file_path": "F:\\Photos\\Trip\\Sub\\C01.JPG",
            "file_name": "C01.JPG",
            "directory_path": "F:\\Photos\\Trip\\Sub",
            "file_size": 1004,
            "date_taken": "2026-06-04 10:00:00",
            "volume_serial": "ABCD-1234",
        })

        # 再帰検索 + VSN 指定（小文字表記揺れ 'abcd-1234' でも F:\Photos\Trip\Sub まで一致し Trip2 は除外）
        rows_rec = get_photos(folder="E:\\Photos\\Trip", volume_serial="abcd-1234", stacked=False)
        got_rec_ids = {r["id"] for r in rows_rec}
        self.assertEqual(got_rec_ids, {p_exact, p_sub, p_shifted_drive})
        self.assertNotIn(p_boundary_trap, got_rec_ids)

        # exclude_folder 指定時にサブフォルダ Day2 が確実に除外されること
        rows_excl = get_photos(
            folder="E:\\Photos\\Trip",
            volume_serial="ABCD-1234",
            exclude_folder="E:\\Photos\\Trip\\Day2",
            stacked=False,
        )
        self.assertEqual({r["id"] for r in rows_excl}, {p_exact, p_shifted_drive})

        # recursive=False（直下のみ）でも UNION 枝が p_exact のみを返しフルスキャンにならないこと
        direct_branches = _build_photo_links_union_branches("E:\\Photos\\Trip", "ABCD-1234", recursive=False, alias="pl")
        direct_sql = " UNION ".join(f"SELECT pl.photo_id FROM photo_links pl WHERE {w}" for w, _ in direct_branches)
        direct_params = [p for _, ps in direct_branches for p in ps]
        with get_connection() as conn:
            direct_ids = {r["photo_id"] for r in conn.execute(direct_sql, direct_params).fetchall()}
            eqp_direct = " | ".join(
                str(dict(r).get("detail", ""))
                for r in conn.execute(f"EXPLAIN QUERY PLAN {direct_sql}", direct_params).fetchall()
            )
        self.assertEqual(direct_ids, {p_exact})
        self.assertNotIn("SCAN pl", eqp_direct)

        # EXPLAIN QUERY PLAN で再帰 UNION 各枝がフルスキャンではなくインデックス検索になることを確認
        branches = _build_photo_links_union_branches("E:\\Photos\\Trip", "ABCD-1234", recursive=True, alias="pl")
        union_sql = " UNION ".join(f"SELECT pl.photo_id FROM photo_links pl WHERE {w}" for w, _ in branches)
        union_params = [p for _, ps in branches for p in ps]
        with get_connection() as conn:
            eqp_rows = conn.execute(f"EXPLAIN QUERY PLAN {union_sql}", union_params).fetchall()
            eqp_text = " | ".join(str(dict(r).get("detail", "")) for r in eqp_rows)
            idx_rows = conn.execute("PRAGMA index_list(photos)").fetchall()
            idx_names = {dict(r)["name"] for r in idx_rows}

        self.assertIn("idx_photo_links_dir_nocase", eqp_text)
        self.assertIn("idx_photo_links_vsn_reldir", eqp_text)
        self.assertNotIn("SCAN pl", eqp_text)
        self.assertIn("idx_photos_unlinked_date_fname", idx_names)

    def test_03_stats_dynamic_db_path_and_silent_bug_fixes(self) -> None:
        """stats.py の動的 DB_PATH 参照・security.py scan_roots.folder_path・schema fast_boot・AIWorker サムネ生成を検証"""
        # 1. stats.py がモジュールインポート時の本番パスではなく現在の一時 DB_PATH を参照すること
        self.assertEqual(db_stats_mod._active_db_path().resolve(), self.test_db_path.resolve())
        st_before = db_stats_mod.get_database_stats()
        self.assertGreater(st_before["file_size"], 0)
        vac_res = db_stats_mod.vacuum_database()
        self.assertGreater(vac_res["after_size"], 0)

        # 2. _FAST_BOOT_REQUIRED_MIGRATIONS に cross_volume_raw_jpeg_pair_v1 が含まれていること
        self.assertIn("cross_volume_raw_jpeg_pair_v1", _FAST_BOOT_REQUIRED_MIGRATIONS)

        # 3. security.py:1432 の scan_roots.folder_path 参照修正により、未刻印でも scan_roots 登録済み Loome が own 判定されること
        ext_drive = self.tmp_root / "MountedCardDrive"
        ext_loome = ext_drive / "Loome"
        ext_loome.mkdir(parents=True, exist_ok=True)
        (ext_loome / "card_photo.jpg").write_bytes(_make_jpeg_bytes())
        clear_drive_loome_cache()
        st_foreign, _ = inspect_drive_loome_ownership(ext_drive, volume_serial="CAFE-9999")
        self.assertEqual(st_foreign, "foreign")

        with get_connection() as conn:
            conn.execute(
                "INSERT INTO scan_roots (folder_path) VALUES (?)",
                (str(ext_loome),),
            )
            conn.commit()
        clear_drive_loome_cache()
        st_own, _ = inspect_drive_loome_ownership(ext_drive, volume_serial="CAFE-9999")
        self.assertEqual(st_own, "own")

        # 4. AITaggingWorker が未生成サムネイルに対して ensure_thumbnail(pid, file_path) の bytes 戻り値で推論できること
        ai_img_path = self.tmp_root / "ai_sample.jpg"
        ai_img_bytes = _make_jpeg_bytes(80, 60, (200, 60, 50))
        ai_img_path.write_bytes(ai_img_bytes)
        ai_pid = upsert_photo({
            "file_path": str(ai_img_path),
            "file_name": ai_img_path.name,
            "directory_path": str(self.tmp_root),
            "file_size": len(ai_img_bytes),
            "date_taken": "2026-07-01 09:00:00",
        })

        class _DummyTagger:
            def __init__(self) -> None:
                self.received_bytes: list[bytes] = []

            def load(self) -> bool:
                return True

            def predict_from_bytes(self, data: bytes, top_k: int = 3, color_only: bool = False):
                self.received_bytes.append(data)
                return [{"tag": "風景/海", "confidence": 0.92}]

        dummy_tagger = _DummyTagger()
        worker = AITaggingWorker()
        with patch("server.ai.worker.get_ai_tagger", return_value=dummy_tagger):
            worker._run_job(folder_path=None, photo_ids=[ai_pid], force_retag=True, color_only=False)

        self.assertEqual(len(dummy_tagger.received_bytes), 1)
        self.assertIsInstance(dummy_tagger.received_bytes[0], bytes)
        self.assertGreater(len(dummy_tagger.received_bytes[0]), 0)
        p_after = get_photo_by_id(ai_pid)
        self.assertIn("風景/海", p_after.get("tags", []))

    def test_04_mobile_case_lv2_no_duplicate_and_external_gps_patch(self) -> None:
        """Lv.2 暗号化時の _1.JPG 重複防止・同名別サイズ非破壊退避・外付け既存写真の非複製GPS補完を検証"""
        case_loome = self.tmp_root / "CaseLv2Loome"
        case_loome.mkdir(parents=True, exist_ok=True)
        storage_manager.LOOME_DIR = case_loome
        storage_manager.STORAGE_DIR = case_loome
        try:
            # --- A. 外付けフォルダの既存写真（GPS無し）への GPS 補完：Loome\case に複製を作らず DB のみ更新 ---
            ext_dir = self.tmp_root / "ExternalSD" / "DCIM"
            ext_dir.mkdir(parents=True, exist_ok=True)
            ext_jpg = _make_jpeg_bytes(72, 54, (30, 150, 90))
            ext_file = ext_dir / "EXT_NOGPS.JPG"
            ext_file.write_bytes(ext_jpg)
            mod_ms = int(datetime(2026, 8, 10, 15, 30, 0).timestamp() * 1000)

            ext_pid = upsert_photo({
                "file_path": str(ext_file),
                "file_name": ext_file.name,
                "directory_path": str(ext_dir),
                "file_size": len(ext_jpg),
                "date_taken": "2026-08-10 15:30:00",
                "volume_serial": "EXT-SD01",
            })

            r_ext_gps = self.lan_client.post(
                "/api/mobile/case-upload",
                params={
                    "file_name": "EXT_NOGPS.JPG",
                    "last_modified_ms": mod_ms,
                    "lat": 35.0116,
                    "lon": 135.7681,
                },
                content=ext_jpg,
                headers={"Content-Type": "application/octet-stream"},
            )
            self.assertEqual(r_ext_gps.status_code, 200)
            body_ext = r_ext_gps.json()
            self.assertEqual(body_ext["status"], "skipped_duplicate")
            self.assertTrue(body_ext.get("gps_updated"))
            self.assertEqual(body_ext["photo_id"], ext_pid)

            patched_photo = get_photo_by_id(ext_pid)
            self.assertAlmostEqual(float(patched_photo["latitude"]), 35.0116, places=4)
            self.assertAlmostEqual(float(patched_photo["longitude"]), 135.7681, places=4)
            case_files_after_ext = list((case_loome / "case").rglob("*.JPG")) if (case_loome / "case").exists() else []
            self.assertEqual(case_files_after_ext, [], "外付け写真のGPS補完時に Loome\\case へ重複ファイルを複製してはならない")

            # --- B. Lv.2 フルロック環境での Uplink：+72B 暗号化済みファイルへの GPS 再送で _1.JPG が増殖しないこと ---
            cfg2 = configure_security_level(2, new_password="P2VaultPass88")
            self.assertEqual(cfg2["security_level"], 2)

            lv2_jpg = _make_jpeg_bytes(80, 80, (90, 60, 190))
            r_up1 = self.lan_client.post(
                "/api/mobile/case-upload",
                params={"file_name": "LV2_SNAP.JPG", "last_modified_ms": mod_ms},
                content=lv2_jpg,
                headers={"Content-Type": "application/octet-stream"},
            )
            self.assertEqual(r_up1.status_code, 200)
            d1 = r_up1.json()
            self.assertEqual(d1["status"], "imported")
            saved_p1 = case_loome / d1["rel_path"].replace("\\", "/")
            self.assertTrue(saved_p1.exists())
            self.assertTrue(is_vault_encrypted_file(saved_p1))
            self.assertEqual(saved_p1.stat().st_size, len(lv2_jpg) + 72)
            self.assertEqual(get_logical_file_size(saved_p1), len(lv2_jpg))

            # 同一画像に後から GPS を付与して再アップロード -> 論理サイズ一致により _1.JPG を作らず同一パスを更新・再封印する
            r_up1_gps = self.lan_client.post(
                "/api/mobile/case-upload",
                params={
                    "file_name": "LV2_SNAP.JPG",
                    "last_modified_ms": mod_ms,
                    "lat": 34.6937,
                    "lon": 135.5023,
                },
                content=lv2_jpg,
                headers={"Content-Type": "application/octet-stream"},
            )
            self.assertEqual(r_up1_gps.status_code, 200)
            self.assertFalse((saved_p1.parent / "LV2_SNAP_1.JPG").exists(), "Lv.2 論理サイズ一致時に _1.JPG が増殖してはならない")
            self.assertTrue(is_vault_encrypted_file(saved_p1))

            # 同名だが別サイズ（別画像）が来た場合は既存ファイルを破壊上書きせず _1.JPG に安全退避する
            diff_jpg = _make_jpeg_bytes(128, 96, (220, 180, 40)) + b"\x00" * 31
            r_up_collision = self.lan_client.post(
                "/api/mobile/case-upload",
                params={"file_name": "LV2_SNAP.JPG", "last_modified_ms": mod_ms + 5000},
                content=diff_jpg,
                headers={"Content-Type": "application/octet-stream"},
            )
            self.assertEqual(r_up_collision.status_code, 200)
            saved_collision = saved_p1.parent / "LV2_SNAP_1.JPG"
            self.assertTrue(saved_collision.exists(), "同名別サイズの別画像は _1.JPG へ連番退避されるべき")
            self.assertEqual(get_logical_file_size(saved_p1), len(lv2_jpg))
            self.assertEqual(get_logical_file_size(saved_collision), len(diff_jpg))

            mcase_mod._flush_case_post_import_events()
        finally:
            if security_mod.get_current_security_level() != 0:
                configure_security_level(0, current_password="P2VaultPass88")
            storage_manager.LOOME_DIR = self.tmp_loome
            storage_manager.STORAGE_DIR = self.tmp_loome

    def test_05_mobile_sync_single_transaction_atomicity(self) -> None:
        """apply_mobile_sync_changes が途中例外時に1件目の評価・タグ変更まで完全ロールバックする原子性を検証"""
        pid1 = upsert_photo({
            "file_path": "D:\\SyncTest\\S01.JPG",
            "file_name": "S01.JPG",
            "directory_path": "D:\\SyncTest",
            "file_size": 2001,
            "date_taken": "2026-09-01 10:00:00",
        })
        pid2 = upsert_photo({
            "file_path": "D:\\SyncTest\\S02.JPG",
            "file_name": "S02.JPG",
            "directory_path": "D:\\SyncTest",
            "file_size": 2002,
            "date_taken": "2026-09-01 10:01:00",
        })

        import server.mobile_sync_apply as msa_mod
        orig_add_tag = msa_mod._add_tag_in_tx
        call_count = {"n": 0}

        def _boom_on_second_photo(conn, cursor, photo_id, tag, cache):
            call_count["n"] += 1
            if call_count["n"] >= 2:
                raise RuntimeError("Simulated mid-batch failure")
            return orig_add_tag(conn, cursor, photo_id, tag, cache)

        with patch("server.mobile_sync_apply._add_tag_in_tx", side_effect=_boom_on_second_photo):
            with self.assertRaises(RuntimeError):
                apply_mobile_sync_changes(
                    [
                        {"photo_id": pid1, "rating": 2, "add_tags": ["旅/北海道"]},
                        {"photo_id": pid2, "rating": 1, "add_tags": ["旅/沖縄"]},
                    ],
                    schedule_thumb_refresh=lambda _ids: None,
                )

        # 途中失敗により pid1 への rating=2 やタグ付与も完全にロールバックされていること
        p1_rolled_back = get_photo_by_id(pid1)
        self.assertEqual(p1_rolled_back["rating"], 0)
        self.assertEqual(p1_rolled_back.get("tags", []), [])

        # 正常時は単一トランザクションで評価・階層タグ・回転が一括反映されること
        refreshed: list[int] = []
        ok_res = apply_mobile_sync_changes(
            [
                {"photo_id": pid1, "rating": 2, "add_tags": ["旅/北海道"], "rotation": 90},
                {"photo_id": pid2, "rating": 1, "add_tags": ["旅/沖縄"]},
            ],
            schedule_thumb_refresh=refreshed.extend,
        )
        self.assertEqual(ok_res["applied_count"], 2)
        self.assertEqual(refreshed, [pid1])
        p1_ok = get_photo_by_id(pid1)
        p2_ok = get_photo_by_id(pid2)
        self.assertEqual(p1_ok["rating"], 2)
        self.assertEqual(p1_ok["rotation"], 90)
        self.assertIn("旅", p1_ok["tags"])
        self.assertIn("旅/北海道", p1_ok["tags"])
        self.assertEqual(p2_ok["rating"], 1)
        self.assertIn("旅/沖縄", p2_ok["tags"])

    def test_06_kotlin_and_frontend_p2_regression_guards(self) -> None:
        """P2-B / P2-C の Kotlin・JS 重要バグ修正（pairToken 再取得・タイマークリア・O(1) Map索引）の契約維持を検証"""
        runner_kt = (
            PROJECT_ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "tetheract" / "pm" / "PhoneCaseTransferRunner.kt"
        ).read_text(encoding="utf-8")
        self.assertNotIn('optString("pairToken")', runner_kt)
        self.assertIn("wifiSyncManager.getConfiguredToken()", runner_kt)

        case_adapter_js = (PROJECT_ROOT / "frontend" / "js" / "adapters" / "phone_case_adapter.js").read_text(encoding="utf-8")
        self.assertGreaterEqual(case_adapter_js.count("clearTimeout(timer)"), 2)
        self.assertIn("if (!startRes || !startRes.ok)", case_adapter_js)

        common_js = (PROJECT_ROOT / "frontend" / "js" / "common.js").read_text(encoding="utf-8")
        self.assertIn("function rebuildPhotoByIdIndex(", common_js)
        self.assertIn("function removePhotoFromByIdIndex(", common_js)
        self.assertIn("function getPhotoById(", common_js)

        app_js = (PROJECT_ROOT / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function doesPhotoMatchActiveTagFilter(", app_js)
        self.assertIn("function removePhotosFromViewBatch(", app_js)


if __name__ == "__main__":
    unittest.main()
