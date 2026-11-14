"""
フィールドログ（GPS足跡採取・時刻照合・非破壊位置付与・Undo・GPX出力）単体＆統合テスト
本番の cache/library.db や cache/field_logs には一切触れず、一時ディレクトリ上で検証する。
"""

import hashlib
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from server import field_log_match, field_log_store  # noqa: E402
from server.app import app  # noqa: E402
from server.database import (  # noqa: E402
    close_all_connections,
    get_connection,
    get_photo_by_id,
    initialize_database,
    switch_database_path,
    update_photo_gps,
    upsert_photo,
)
from server.database import connection as db_conn_mod  # noqa: E402
from server.field_log_match import match_photos  # noqa: E402
from server.security import initialize_security_state, set_instance_file_for_test  # noqa: E402

JST = timezone(timedelta(hours=9))
PST = timezone(timedelta(hours=-8))
DEV_ID_1 = "3f2a1111-2222-4333-8444-555566667777"
DEV_ID_2 = "9b8c0000-aaaa-4bbb-9ccc-ddddeeeeffff"


def _jst_ms(iso_local: str) -> int:
    """JST ローカル日時文字列 (YYYY-MM-DD HH:MM:SS) を UTC epoch ミリ秒へ変換するテスト補助関数"""
    dt = datetime.strptime(iso_local, "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
    return int(dt.timestamp() * 1000)


def _pst_ms(iso_local: str) -> int:
    """PST ローカル日時文字列 (YYYY-MM-DD HH:MM:SS) を UTC epoch ミリ秒へ変換するテスト補助関数"""
    dt = datetime.strptime(iso_local, "%Y-%m-%d %H:%M:%S").replace(tzinfo=PST)
    return int(dt.timestamp() * 1000)


def _build_jsonl(device_id: str, device_name: str, date_str: str, records: list[dict]) -> tuple[str, str]:
    """ヘッダ付きの JSONL 文字列と sha256 16進文字列を生成する"""
    header = {
        "type": "header",
        "format": "tetheract-fieldlog-v1",
        "device_id": device_id,
        "device_name": device_name,
        "date": date_str,
    }
    lines = [json.dumps(header, ensure_ascii=False)]
    for r in records:
        lines.append(json.dumps(r, ensure_ascii=False))
    content = "\n".join(lines) + "\n"
    sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return content, sha


class TestFieldLogMatchPure(unittest.TestCase):
    """server/field_log_match.py（純粋関数）の単体テスト"""

    def test_pure_module_has_no_db_or_fastapi_dependency(self):
        """field_log_match モジュールが DB や FastAPI をインポートしていないことを確認"""
        src = Path(field_log_match.__file__).read_text(encoding="utf-8")
        self.assertNotIn("fastapi", src)
        self.assertNotIn("sqlite3", src)
        self.assertNotIn("get_connection", src)

    def test_interpolation_nearest_and_unmatched(self):
        """線形補間・最寄り点採用・許容差超え未一致の基本動作を検証"""
        points = [
            {"type": "pt", "t": _jst_ms("2026-11-09 10:00:00"), "tz": 540, "lat": 35.0000, "lon": 135.0000, "acc": 6.0},
            {"type": "pt", "t": _jst_ms("2026-11-09 10:02:00"), "tz": 540, "lat": 35.0020, "lon": 135.0040, "acc": 10.0},
            # 10分間のギャップ（max_gap_sec=300 を超える区間）
            {"type": "pt", "t": _jst_ms("2026-11-09 10:12:00"), "tz": 540, "lat": 35.0100, "lon": 135.0200, "acc": 8.0},
        ]
        photos = [
            # 10:00:30 -> 2分間（120秒）の 1/4 地点で線形補間される（EXIF コロン区切り形式も検証）
            {"id": 1, "date_taken": "2026:11:09 10:00:30", "camera_model": "X-T5", "latitude": None, "gps_source": None},
            # 09:58:30 -> 開始 90秒前（max_nearest_sec=120 以内）なので最寄り点採用
            {"id": 2, "date_taken": "2026-11-09 09:58:30", "camera_model": "X-T5", "latitude": None, "gps_source": None},
            # 10:03:30 -> ギャップ600秒区間だが 10:02:00 から90秒差なので nearest 採用
            {"id": 3, "date_taken": "2026-11-09 10:03:30", "camera_model": "X-T5", "latitude": None, "gps_source": None},
            # 10:07:00 -> 前後どちらの点からも300秒離れており max_nearest_sec=120 超えで unmatched
            {"id": 4, "date_taken": "2026-11-09 10:07:00", "camera_model": "X-T5", "latitude": None, "gps_source": None},
            # date_taken なし -> skipped
            {"id": 5, "date_taken": None, "camera_model": "X-T5", "latitude": None, "gps_source": None},
        ]

        res = match_photos(photos, points, max_gap_sec=300, max_nearest_sec=120)
        by_id = {it["photo_id"]: it for it in res["items"]}

        self.assertEqual(set(by_id.keys()), {1, 2, 3})
        self.assertEqual(by_id[1]["method"], "interpolated")
        self.assertAlmostEqual(by_id[1]["lat"], 35.0005, places=6)
        self.assertAlmostEqual(by_id[1]["lon"], 135.0010, places=6)
        self.assertAlmostEqual(by_id[1]["gap_sec"], 120.0, places=1)
        self.assertAlmostEqual(by_id[1]["acc_m"], 7.0, places=1)

        self.assertEqual(by_id[2]["method"], "nearest")
        self.assertAlmostEqual(by_id[2]["lat"], 35.0000, places=6)
        self.assertAlmostEqual(by_id[2]["gap_sec"], 90.0, places=1)

        self.assertEqual(by_id[3]["method"], "nearest")
        self.assertAlmostEqual(by_id[3]["lat"], 35.0020, places=6)
        self.assertAlmostEqual(by_id[3]["gap_sec"], 90.0, places=1)

        self.assertEqual(res["unmatched"], [4])
        self.assertEqual(res["skipped"], [{"photo_id": 5, "reason": "no_date_taken"}])

    def test_timezone_and_camera_offsets(self):
        """タイムゾーン (tz=540 / tz=-480) とカメラ機種別時計ズレ補正 (camera_offsets) を検証"""
        points = [
            {"type": "pt", "t": _pst_ms("2026-11-09 15:00:00"), "tz": -480, "lat": 37.7749, "lon": -122.4194},
            {"type": "pt", "t": _pst_ms("2026-11-09 15:02:00"), "tz": -480, "lat": 37.7769, "lon": -122.4174},
        ]
        # カメラ ILCE-7RM5 の時計が 60秒進んでいる（15:02:00 と記録されているが本当は 15:01:00）
        photos = [
            {"id": 10, "date_taken": "2026-11-09 15:02:00", "camera_model": "ILCE-7RM5", "latitude": None, "gps_source": None},
            {"id": 11, "date_taken": "2026-11-09 15:01:00", "camera_model": "Z8", "latitude": None, "gps_source": None},
        ]
        res = match_photos(photos, points, camera_offsets={"ILCE-7RM5": -60})
        by_id = {it["photo_id"]: it for it in res["items"]}
        # 両方とも実時刻 15:01:00（中間点）に一致する
        self.assertAlmostEqual(by_id[10]["lat"], 37.7759, places=6)
        self.assertAlmostEqual(by_id[11]["lat"], 37.7759, places=6)

    def test_overwrite_modes_and_manual_protection(self):
        """overwrite 3モードの挙動と、manual が overwrite='all' でも絶対に保護されることを検証"""
        points = [
            {"type": "pt", "t": _jst_ms("2026-11-09 12:00:00"), "tz": 540, "lat": 35.6812, "lon": 139.7671},
        ]
        photos = [
            {"id": 1, "date_taken": "2026-11-09 12:00:00", "camera_model": "A", "latitude": None, "longitude": None, "gps_source": None},
            {"id": 2, "date_taken": "2026-11-09 12:00:00", "camera_model": "A", "latitude": 34.0, "longitude": 135.0, "gps_source": "inferred"},
            {"id": 3, "date_taken": "2026-11-09 12:00:00", "camera_model": "A", "latitude": 34.1, "longitude": 135.1, "gps_source": "fieldlog"},
            {"id": 4, "date_taken": "2026-11-09 12:00:00", "camera_model": "A", "latitude": 34.2, "longitude": 135.2, "gps_source": None},
            {"id": 5, "date_taken": "2026-11-09 12:00:00", "camera_model": "A", "latitude": 34.3, "longitude": 135.3, "gps_source": "copied"},
            {"id": 6, "date_taken": "2026-11-09 12:00:00", "camera_model": "A", "latitude": 34.9, "longitude": 135.9, "gps_source": "manual"},
        ]

        # 1. missing_only -> id=1 のみ
        r_missing = match_photos(photos, points, overwrite="missing_only")
        self.assertEqual([it["photo_id"] for it in r_missing["items"]], [1])

        # 2. replace_inferred -> id=1, 2, 3 のみ（EXIF元データ id=4、copied id=5、manual id=6 は保護）
        r_rep = match_photos(photos, points, overwrite="replace_inferred")
        self.assertEqual([it["photo_id"] for it in r_rep["items"]], [1, 2, 3])

        # 3. all -> id=1..5 が対象になるが、id=6 (manual) は絶対に保護される！
        r_all = match_photos(photos, points, overwrite="all")
        self.assertEqual([it["photo_id"] for it in r_all["items"]], [1, 2, 3, 4, 5])
        self.assertEqual(r_all["skipped"], [{"photo_id": 6, "reason": "manual_protected"}])

    def test_timezone_transition_within_same_trip(self):
        """同一期間の点列内でタイムゾーンが変化（JST 540 -> PST -480）しても最近傍 tz で正確に変換されることを検証"""
        points = [
            {"type": "pt", "t": _jst_ms("2026-11-08 10:00:00"), "tz": 540, "lat": 35.5494, "lon": 139.7798},
            {"type": "pt", "t": _pst_ms("2026-11-09 11:00:00"), "tz": -480, "lat": 37.6213, "lon": -122.3790},
            {"type": "pt", "t": _pst_ms("2026-11-09 11:02:00"), "tz": -480, "lat": 37.6233, "lon": -122.3770},
        ]
        photos = [
            {"id": 21, "date_taken": "2026-11-09 11:01:00", "camera_model": "Z8", "latitude": None, "gps_source": None},
        ]
        res = match_photos(photos, points)
        self.assertEqual(len(res["items"]), 1)
        self.assertAlmostEqual(res["items"][0]["lat"], 37.6223, places=6)
        self.assertAlmostEqual(res["items"][0]["lon"], -122.3780, places=6)


class TestFieldLogStoreAndIntegration(unittest.TestCase):
    """ストレージ・日付境界・クラッシュ耐性・DB適用・再スキャン保護・Undo・GPX・APIの統合テスト"""

    @classmethod
    def setUpClass(cls):
        cls._orig_db_path = db_conn_mod.DB_PATH
        cls._orig_logs_dir = field_log_store.FIELD_LOGS_DIR
        cls._temp_dir = tempfile.TemporaryDirectory()
        tmp_root = Path(cls._temp_dir.name)

        set_instance_file_for_test(tmp_root / ".tetheract_instance_fieldlog")
        switch_database_path(tmp_root / "test_fieldlog_library.db")
        initialize_database()
        initialize_security_state(force_reload=True)

        field_log_store.FIELD_LOGS_DIR = tmp_root / "field_logs"
        cls.client = TestClient(app, base_url="http://127.0.0.1:8088")

    @classmethod
    def tearDownClass(cls):
        field_log_store.FIELD_LOGS_DIR = cls._orig_logs_dir
        close_all_connections()
        set_instance_file_for_test(None)
        switch_database_path(cls._orig_db_path)
        initialize_security_state(force_reload=True)
        cls._temp_dir.cleanup()

    def setUp(self):
        # 各テスト前にDB写真とフィールドログ一時フォルダをクリアする
        with get_connection() as conn:
            conn.execute("DELETE FROM photo_tags")
            conn.execute("DELETE FROM thumbnails")
            conn.execute("DELETE FROM photo_links")
            conn.execute("DELETE FROM photos")
            conn.commit()
        logs_root = Path(field_log_store.FIELD_LOGS_DIR)
        if logs_root.exists():
            import shutil
            shutil.rmtree(logs_root)

    def test_store_validation_truncated_tail_usb_fallback_and_gpx(self):
        """入力検証・最終行途中切れ耐性・USB直書き時のheader端末名補完・GPX 1.1出力を検証"""
        # パストラバーサル・不正日付の拒否
        with self.assertRaises(ValueError):
            field_log_store.validate_device_id("../evil-device")
        with self.assertRaises(ValueError):
            field_log_store.validate_date_str("2026-02-30")

        # session / mark / pt を含み、さらに最終行がクラッシュで途中切れしている JSONL
        base_jsonl, _ = _build_jsonl(
            DEV_ID_1,
            'Pixel 8 <Pro> & "Field"',
            "2026-11-09",
            [
                {"type": "session", "t": _jst_ms("2026-11-09 09:00:00"), "tz": 540, "state": "start", "reason": "user"},
                {"type": "pt", "t": _jst_ms("2026-11-09 09:00:10"), "tz": 540, "lat": 35.0116, "lon": 135.7681, "alt": 52.4, "acc": 5.0},
                {"type": "mark", "t": _jst_ms("2026-11-09 09:00:25"), "tz": 540, "label": "reserved_v3"},
                {"type": "pt", "t": _jst_ms("2026-11-09 09:01:10"), "tz": 540, "lat": 35.0126, "lon": 135.7691, "acc": 6.0},
            ],
        )
        truncated_jsonl = base_jsonl + '{"type":"pt","t":1762646500000,"lat":35.01'
        trunc_sha = hashlib.sha256(truncated_jsonl.encode("utf-8")).hexdigest()

        # sha256 不一致は拒否される
        r_bad_sha = self.client.post(
            "/api/mobile/field-logs",
            json={
                "device_id": DEV_ID_1,
                "device_name": 'Pixel 8 <Pro> & "Field"',
                "date": "2026-11-09",
                "sha256": "0" * 64,
                "content": truncated_jsonl,
            },
        )
        self.assertEqual(r_bad_sha.status_code, 400)

        # 正しい sha256 なら途中切れ最終行を読み飛ばして保存成功する（有効 pt は 2 点）
        r_up = self.client.post(
            "/api/mobile/field-logs",
            json={
                "device_id": DEV_ID_1,
                "device_name": 'Pixel 8 <Pro> & "Field"',
                "date": "2026-11-09",
                "sha256": trunc_sha,
                "content": truncated_jsonl,
            },
        )
        self.assertEqual(r_up.status_code, 200)
        up_json = r_up.json()
        self.assertTrue(up_json["ok"])
        self.assertEqual(up_json["points"], 2)

        # USB SAF 直書き模擬: device.json 無しで DEV_ID_2/2026-11-10.jsonl だけ配置
        usb_dir = Path(field_log_store.FIELD_LOGS_DIR) / DEV_ID_2
        usb_dir.mkdir(parents=True, exist_ok=True)
        usb_jsonl, _ = _build_jsonl(
            DEV_ID_2,
            "Xperia USB Direct",
            "2026-11-10",
            [{"type": "pt", "t": _jst_ms("2026-11-10 08:30:00"), "tz": 540, "lat": 34.6937, "lon": 135.5023}],
        )
        (usb_dir / "2026-11-10.jsonl").write_text(usb_jsonl, encoding="utf-8")

        # GET /api/field-logs で両デバイスと header 補完端末名・距離・時間帯が返る
        r_list = self.client.get("/api/field-logs")
        self.assertEqual(r_list.status_code, 200)
        devs = {d["device_id"]: d for d in r_list.json()["devices"]}
        self.assertIn(DEV_ID_1, devs)
        self.assertIn(DEV_ID_2, devs)
        self.assertEqual(devs[DEV_ID_2]["device_name"], "Xperia USB Direct")
        day_info = devs[DEV_ID_1]["days"][0]
        self.assertEqual(day_info["date"], "2026-11-09")
        self.assertEqual(day_info["points"], 2)
        self.assertEqual(day_info["first"], "09:00:10")
        self.assertEqual(day_info["last"], "09:01:10")
        self.assertGreater(day_info["distance_m"], 100.0)

        # GPX 1.1 出力と XML パース検証（特殊文字を含む端末名でも整形式 XML になること）
        r_gpx = self.client.get(f"/api/field-logs/{DEV_ID_1}/2026-11-09.gpx")
        self.assertEqual(r_gpx.status_code, 200)
        self.assertIn("application/gpx+xml", r_gpx.headers.get("content-type", ""))
        root_el = ET.fromstring(r_gpx.text)
        ns = {"gpx": "http://www.topografix.com/GPX/1/1"}
        trkpts = root_el.findall(".//gpx:trkpt", ns)
        self.assertEqual(len(trkpts), 2)
        ele_el = trkpts[0].find("gpx:ele", ns)
        time_el = trkpts[0].find("gpx:time", ns)
        self.assertIsNotNone(ele_el)
        self.assertEqual(ele_el.text, "52.40")
        # 2026-11-09 09:00:10 JST == 2026-11-09T00:00:10Z UTC
        self.assertEqual(time_el.text, "2026-11-09T00:00:10Z")

    def test_midnight_boundary_matching(self):
        """日付境界（23:59 -> 翌 00:01）を跨ぐ撮影が前後1日自動ロードにより線形補間されることを検証"""
        day1_jsonl, sha1 = _build_jsonl(
            DEV_ID_1,
            "Pixel 8",
            "2026-11-08",
            [{"type": "pt", "t": _jst_ms("2026-11-08 23:59:00"), "tz": 540, "lat": 35.0000, "lon": 135.7000}],
        )
        day2_jsonl, sha2 = _build_jsonl(
            DEV_ID_1,
            "Pixel 8",
            "2026-11-09",
            [{"type": "pt", "t": _jst_ms("2026-11-09 00:01:00"), "tz": 540, "lat": 35.0020, "lon": 135.7040}],
        )
        field_log_store.save_uploaded_day(DEV_ID_1, "Pixel 8", "2026-11-08", sha1, day1_jsonl)
        field_log_store.save_uploaded_day(DEV_ID_1, "Pixel 8", "2026-11-09", sha2, day2_jsonl)

        pid_before_mid = upsert_photo({
            "file_path": "D:\\NightWalk\\DSC001.JPG",
            "file_name": "DSC001.JPG",
            "directory_path": "D:\\NightWalk",
            "file_size": 1000,
            "date_taken": "2026-11-08 23:59:30",
            "camera_model": "GR IIIx",
        })
        pid_after_mid = upsert_photo({
            "file_path": "D:\\NightWalk\\DSC002.JPG",
            "file_name": "DSC002.JPG",
            "directory_path": "D:\\NightWalk",
            "file_size": 1001,
            "date_taken": "2026-11-09 00:00:30",
            "camera_model": "GR IIIx",
        })

        # 2026-11-09 だけを指定してプレビューしても 2026-11-08 のログが自動読込され、00:00:30 が補間される
        r_prev = self.client.post("/api/field-logs/match/preview", json={"dates": ["2026-11-09"]})
        self.assertEqual(r_prev.status_code, 200)
        p_json = r_prev.json()
        self.assertEqual(len(p_json["items"]), 1)
        self.assertEqual(p_json["items"][0]["photo_id"], pid_after_mid)
        self.assertEqual(p_json["items"][0]["method"], "interpolated")
        self.assertAlmostEqual(p_json["items"][0]["lat"], 35.0015, places=6)

        # 2026-11-08 側も同様に 2026-11-09 の点と線形補間される
        r_prev_d1 = self.client.post("/api/field-logs/match/preview", json={"dates": ["2026-11-08"]})
        self.assertEqual(r_prev_d1.status_code, 200)
        items_d1 = r_prev_d1.json()["items"]
        self.assertEqual(len(items_d1), 1)
        self.assertEqual(items_d1[0]["photo_id"], pid_before_mid)
        self.assertEqual(items_d1[0]["method"], "interpolated")
        self.assertAlmostEqual(items_d1[0]["lat"], 35.0005, places=6)

    def test_apply_rescan_protection_log_deletion_and_undo(self):
        """
        位置付与 (apply) -> 逆ジオコーディング地名 -> 再スキャン保護 (upsert_photo) ->
        ログ削除しても位置が残ること -> Undo で元の状態へ完全復元されることを一気通貫で検証
        """
        # 京都市役所付近 (35.0116, 135.7681) のログを登録
        kyoto_jsonl, sha = _build_jsonl(
            DEV_ID_1,
            "Pixel 8",
            "2026-11-09",
            [
                {"type": "pt", "t": _jst_ms("2026-11-09 14:00:00"), "tz": 540, "lat": 35.0116, "lon": 135.7681, "acc": 4.0},
                {"type": "pt", "t": _jst_ms("2026-11-09 14:02:00"), "tz": 540, "lat": 35.0136, "lon": 135.7681, "acc": 4.0},
            ],
        )
        field_log_store.save_uploaded_day(DEV_ID_1, "Pixel 8", "2026-11-09", sha, kyoto_jsonl)

        # 写真1: GPS無しカメラ写真
        pid_empty = upsert_photo({
            "file_path": "E:\\Trip\\IMG_0001.JPG",
            "file_name": "IMG_0001.JPG",
            "directory_path": "E:\\Trip",
            "file_size": 2048,
            "date_taken": "2026-11-09 14:01:00",
            "camera_model": "EOS R6",
            "volume_serial": "VSN-TRIP",
        })
        # 写真2: 既に inferred で東京付近の仮GPSが入っている写真
        pid_inferred = upsert_photo({
            "file_path": "E:\\Trip\\IMG_0002.JPG",
            "file_name": "IMG_0002.JPG",
            "directory_path": "E:\\Trip",
            "file_size": 2049,
            "date_taken": "2026-11-09 14:01:00",
            "camera_model": "EOS R6",
            "volume_serial": "VSN-TRIP",
        })
        update_photo_gps(pid_inferred, 35.6895, 139.6917, "inferred")
        before_inf = get_photo_by_id(pid_inferred)

        # 写真3: manual で手動ピン留めされた写真（絶対に上書きされない）
        pid_manual = upsert_photo({
            "file_path": "E:\\Trip\\IMG_0003.JPG",
            "file_name": "IMG_0003.JPG",
            "directory_path": "E:\\Trip",
            "file_size": 2050,
            "date_taken": "2026-11-09 14:01:00",
            "camera_model": "EOS R6",
            "volume_serial": "VSN-TRIP",
        })
        update_photo_gps(pid_manual, 43.0618, 141.3545, "manual")

        # 1. プレビュー確認（camera_models に EOS R6 が含まれ、DBはまだ未変更）
        r_prev = self.client.post(
            "/api/field-logs/match/preview",
            json={"folder": "E:\\Trip", "overwrite": "replace_inferred"},
        )
        self.assertEqual(r_prev.status_code, 200)
        prev_data = r_prev.json()
        self.assertIn("EOS R6", prev_data["camera_models"])
        self.assertEqual({it["photo_id"] for it in prev_data["items"]}, {pid_empty, pid_inferred})
        self.assertIsNone(get_photo_by_id(pid_empty)["latitude"])

        # 2. 適用 (apply)
        r_app = self.client.post(
            "/api/field-logs/match/apply",
            json={"folder": "E:\\Trip", "overwrite": "replace_inferred"},
        )
        self.assertEqual(r_app.status_code, 200)
        app_data = r_app.json()
        self.assertTrue(app_data["ok"])
        self.assertEqual(app_data["applied"], 2)
        batch_id = app_data["batch_id"]
        self.assertTrue(batch_id)

        # DB上の値が fieldlog になり、逆ジオコーディングで京都府の地名が付与されていることを確認
        p1_after = get_photo_by_id(pid_empty)
        p2_after = get_photo_by_id(pid_inferred)
        p3_after = get_photo_by_id(pid_manual)
        self.assertEqual(p1_after["gps_source"], "fieldlog")
        self.assertAlmostEqual(p1_after["latitude"], 35.0126, places=5)
        self.assertEqual(p1_after["state"], "京都府")
        self.assertEqual(p2_after["gps_source"], "fieldlog")
        self.assertEqual(p2_after["state"], "京都府")
        # manual は北海道のまま完全に保護されている
        self.assertEqual(p3_after["gps_source"], "manual")
        self.assertAlmostEqual(p3_after["latitude"], 43.0618, places=4)

        # 3. 再スキャン保護: 元ファイル（GPS無し、または別GPS）として upsert_photo が再実行されても fieldlog が消えないこと！
        upsert_photo({
            "file_path": "E:\\Trip\\IMG_0001.JPG",
            "file_name": "IMG_0001.JPG",
            "directory_path": "E:\\Trip",
            "file_size": 2048,
            "date_taken": "2026-11-09 14:01:00",
            "camera_model": "EOS R6",
            "volume_serial": "VSN-TRIP",
            "latitude": 26.2124,
            "longitude": 127.6809,
            "country": "日本",
            "state": "沖縄県",
            "city": "那覇市",
        })
        p1_rescan = get_photo_by_id(pid_empty)
        self.assertEqual(p1_rescan["gps_source"], "fieldlog")
        self.assertAlmostEqual(p1_rescan["latitude"], 35.0126, places=5)
        self.assertEqual(p1_rescan["state"], "京都府")

        # 4. フィールドログを全削除しても、写真に付与済みの位置とバッチ履歴は残ること！
        r_del = self.client.post("/api/field-logs/delete", json={"all": True})
        self.assertEqual(r_del.status_code, 200)
        self.assertEqual(r_del.json()["deleted"], 1)
        self.assertEqual(self.client.get("/api/field-logs").json()["devices"], [])
        self.assertEqual(get_photo_by_id(pid_empty)["gps_source"], "fieldlog")

        r_batches = self.client.get("/api/field-logs/match/batches")
        self.assertEqual(r_batches.status_code, 200)
        batches = r_batches.json()["batches"]
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["batch_id"], batch_id)
        self.assertFalse(batches[0]["undone"])

        # 5. Undo を実行すると、GPS無しだった写真1は NULL に、inferred だった写真2は東京の inferred に完全復元されること！
        r_undo = self.client.post("/api/field-logs/match/undo", json={"batch_id": batch_id})
        self.assertEqual(r_undo.status_code, 200)
        self.assertEqual(r_undo.json()["restored"], 2)

        p1_restored = get_photo_by_id(pid_empty)
        self.assertIsNone(p1_restored["latitude"])
        self.assertIsNone(p1_restored["longitude"])
        self.assertIsNone(p1_restored["gps_source"])
        self.assertIsNone(p1_restored["state"])

        p2_restored = get_photo_by_id(pid_inferred)
        self.assertEqual(p2_restored["gps_source"], "inferred")
        self.assertAlmostEqual(p2_restored["latitude"], before_inf["latitude"], places=5)
        self.assertEqual(p2_restored["state"], before_inf["state"])

        # 二重 Undo は 400 で拒否される
        r_undo_again = self.client.post("/api/field-logs/match/undo", json={"batch_id": batch_id})
        self.assertEqual(r_undo_again.status_code, 400)

    def test_selective_delete_size_limit_locked_423_and_undo_manual_protection(self):
        """日別選択削除・8MB上限(413)・ロック中423・適用後にmanual化された写真のUndo保護を検証"""
        from unittest.mock import patch

        j1, s1 = _build_jsonl(
            DEV_ID_1,
            "Pixel 8",
            "2026-11-08",
            [{"type": "pt", "t": _jst_ms("2026-11-08 10:00:00"), "tz": 540, "lat": 35.01, "lon": 135.76}],
        )
        j2, s2 = _build_jsonl(
            DEV_ID_1,
            "Pixel 8",
            "2026-11-09",
            [{"type": "pt", "t": _jst_ms("2026-11-09 10:00:00"), "tz": 540, "lat": 35.02, "lon": 135.77}],
        )
        field_log_store.save_uploaded_day(DEV_ID_1, "Pixel 8", "2026-11-08", s1, j1)
        field_log_store.save_uploaded_day(DEV_ID_1, "Pixel 8", "2026-11-09", s2, j2)

        # 2026-11-08 のみを選択削除 -> 2026-11-09 は残る
        r_del_one = self.client.post(
            "/api/field-logs/delete",
            json={"targets": [{"device_id": DEV_ID_1, "date": "2026-11-08"}]},
        )
        self.assertEqual(r_del_one.status_code, 200)
        self.assertEqual(r_del_one.json()["deleted"], 1)
        remaining_days = self.client.get("/api/field-logs").json()["devices"][0]["days"]
        self.assertEqual([d["date"] for d in remaining_days], ["2026-11-09"])

        # 8MB 上限超え -> 413
        with patch.object(field_log_store, "MAX_DAY_BYTES", 64):
            r_large = self.client.post(
                "/api/mobile/field-logs",
                json={
                    "device_id": DEV_ID_1,
                    "device_name": "Pixel 8",
                    "date": "2026-11-10",
                    "sha256": s2,
                    "content": j2,
                },
            )
            self.assertEqual(r_large.status_code, 413)

        # ロック中 -> 423
        with patch("server.app.is_app_locked", return_value=True), patch("server.routers.field_log_router.is_app_locked", return_value=True):
            r_locked = self.client.post(
                "/api/mobile/field-logs",
                json={
                    "device_id": DEV_ID_1,
                    "device_name": "Pixel 8",
                    "date": "2026-11-09",
                    "sha256": s2,
                    "content": j2,
                },
            )
            self.assertEqual(r_locked.status_code, 423)

        # 適用後にユーザーが manual ピン留めへ変更した写真は Undo 時も保護される
        pid_a = upsert_photo({
            "file_path": "E:\\UndoGuard\\A.JPG",
            "file_name": "A.JPG",
            "directory_path": "E:\\UndoGuard",
            "file_size": 1111,
            "date_taken": "2026-11-09 10:00:10",
            "camera_model": "Z6III",
        })
        pid_b = upsert_photo({
            "file_path": "E:\\UndoGuard\\B.JPG",
            "file_name": "B.JPG",
            "directory_path": "E:\\UndoGuard",
            "file_size": 1112,
            "date_taken": "2026-11-09 10:00:20",
            "camera_model": "Z6III",
        })
        r_app = self.client.post("/api/field-logs/match/apply", json={"photo_ids": [pid_a, pid_b]})
        self.assertEqual(r_app.status_code, 200)
        b_id = r_app.json()["batch_id"]

        # pid_a だけ後から手動ピン留め変更する
        update_photo_gps(pid_a, 33.5902, 130.4017, "manual")

        r_undo = self.client.post("/api/field-logs/match/undo", json={"batch_id": b_id})
        self.assertEqual(r_undo.status_code, 200)
        self.assertEqual(r_undo.json()["restored"], 1)
        self.assertEqual(r_undo.json()["skipped_manual"], 1)
        self.assertEqual(get_photo_by_id(pid_a)["gps_source"], "manual")
        self.assertAlmostEqual(get_photo_by_id(pid_a)["latitude"], 33.5902, places=4)
        self.assertIsNone(get_photo_by_id(pid_b)["latitude"])

    def test_10_library_id_identity_for_switch_guard(self):
        """各 library.db に固有の library_id が付与され、discover / locker-sync / mobile_delta で一貫し別DBとは区別されること"""
        import sqlite3
        from server.database import get_or_create_library_id, initialize_database, switch_database_path
        from server.mobile_delta import ensure_mobile_delta_db

        lib_id_1 = get_or_create_library_id()
        self.assertTrue(lib_id_1.startswith("lib_"))
        self.assertEqual(lib_id_1, get_or_create_library_id(), "同一DBでは不変の library_id が返ること")

        r_disc = self.client.get("/api/mobile/discover")
        self.assertEqual(r_disc.status_code, 200)
        self.assertEqual(r_disc.json().get("library_id"), lib_id_1)

        r_st = self.client.get("/api/mobile/locker-sync?mode=status")
        self.assertEqual(r_st.status_code, 200)
        self.assertEqual(r_st.json().get("library_id"), lib_id_1)

        delta_path = ensure_mobile_delta_db(force=True)
        self.assertIsNotNone(delta_path)
        with sqlite3.connect(str(delta_path)) as dconn:
            row = dconn.execute("SELECT value FROM delta_meta WHERE key = 'library_id'").fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], lib_id_1)

        # 別の library.db に切り替えた場合は異なる library_id が採番されること
        with tempfile.TemporaryDirectory() as other_tmp:
            other_db = Path(other_tmp) / "other_library.db"
            prev_db = switch_database_path(other_db)
            try:
                initialize_database()
                lib_id_2 = get_or_create_library_id()
                self.assertTrue(lib_id_2.startswith("lib_"))
                self.assertNotEqual(lib_id_1, lib_id_2, "別インスタンスのDBは異なる library_id を持つこと")
            finally:
                close_all_connections()
                switch_database_path(prev_db)


if __name__ == "__main__":
    unittest.main()
