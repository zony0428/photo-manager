"""
DBバックアップ日時判定・経過日数算出および母艦アップデート確認機能の回帰テスト。
本番 cache/library.db・cache/backups/ に一切接触しない一時ディレクトリ隔離テスト。
"""

import io
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from server import database as db_pkg_mod  # noqa: E402
from server import updater as updater_mod  # noqa: E402
from server.database import (  # noqa: E402
    close_all_connections,
    initialize_database,
    stats as db_stats_mod,
    switch_database_path as _raw_switch_db,
    upsert_photo,
)
from server.database import connection as db_conn_mod  # noqa: E402


class _MockHttpResponse:
    """urllib.request.urlopen 用の簡易コンテキストマネージャモック"""

    def __init__(self, payload_obj) -> None:
        self._bytes = json.dumps(payload_obj, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def read(self) -> bytes:
        return self._bytes


def _switch_db_isolated(new_path: Path) -> Path:
    old = _raw_switch_db(new_path)
    resolved = Path(new_path)
    db_stats_mod.DB_PATH = resolved
    db_pkg_mod.DB_PATH = resolved
    return old


class TestBackupAndUpdaterSuite(unittest.TestCase):
    """DBバックアップ経過日数と母艦GitHubアップデート確認の検証"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_root = Path(self._tmp.name)
        self.db_path = self.tmp_root / "library.db"
        self.backup_dir = self.tmp_root / "backups"
        self._orig_db = db_conn_mod.DB_PATH
        self._orig_backup_dir = db_stats_mod.BACKUP_DIR

        _switch_db_isolated(self.db_path)
        db_stats_mod.BACKUP_DIR = self.backup_dir
        initialize_database()

        # photo_count > 0 にして weekly backup reminder 判定を有効化
        img_file = self.tmp_root / "sample.jpg"
        img_file.write_bytes(b"dummy-jpeg")
        upsert_photo({
            "file_path": str(img_file),
            "file_name": img_file.name,
            "directory_path": str(self.tmp_root),
            "file_size": 10,
            "date_taken": "2026-11-10 12:00:00",
        })

    def tearDown(self) -> None:
        try:
            close_all_connections()
            db_stats_mod.BACKUP_DIR = self._orig_backup_dir
            _switch_db_isolated(self._orig_db)
        finally:
            self._tmp.cleanup()

    def test_backup_database_sets_fresh_mtime_even_when_source_db_is_stale(self) -> None:
        """元DBのst_mtimeが10日前でも、新規バックアップは現在時刻のmtimeを持ちis_overdueがFalseになること"""
        close_all_connections()
        ten_days_ago = time.time() - 10 * 86400
        os.utime(self.db_path, (ten_days_ago, ten_days_ago))

        with patch("server.security.get_security_status", return_value={}):
            res = db_stats_mod.backup_database(max_backups=5)

        self.assertEqual(res["status"], "success")
        b_file = self.backup_dir / res["filename"]
        self.assertTrue(b_file.is_file())
        self.assertLess(time.time() - b_file.stat().st_mtime, 60.0)

        info = db_stats_mod.get_backup_info()
        self.assertEqual(info["days_since_last_backup"], 0)
        stats = db_stats_mod.get_database_stats()
        self.assertFalse(stats["backup_info"]["is_overdue"])

    def test_get_backup_info_rescues_existing_backup_with_stale_mtime_and_detects_old_filename(self) -> None:
        """既存の古いst_mtime付き昨日のバックアップを救済し、逆にmtimeだけ新しい10日前バックアップは期限切れ判定すること"""
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        now_dt = datetime.now()
        yesterday_name = f"library_backup_{(now_dt - timedelta(days=1)).strftime('%Y%m%d_%H%M%S')}.db"
        yesterday_file = self.backup_dir / yesterday_name
        yesterday_file.write_bytes(b"sqlite-backup")
        ten_days_ago = time.time() - 10 * 86400
        os.utime(yesterday_file, (ten_days_ago, ten_days_ago))

        stats_recent = db_stats_mod.get_database_stats()
        self.assertLessEqual(stats_recent["backup_info"]["days_since_last_backup"], 1)
        self.assertFalse(stats_recent["backup_info"]["is_overdue"])

        # 昨日のファイルを消し、10日前のファイル名で現在mtimeのバックアップを配置
        yesterday_file.unlink()
        old_name = f"library_backup_{(now_dt - timedelta(days=10)).strftime('%Y%m%d_%H%M%S')}.db"
        old_file = self.backup_dir / old_name
        old_file.write_bytes(b"sqlite-backup-old")

        stats_old = db_stats_mod.get_database_stats()
        self.assertGreaterEqual(stats_old["backup_info"]["days_since_last_backup"], 9)
        self.assertTrue(stats_old["backup_info"]["is_overdue"])

    def test_backup_generational_pruning_keeps_newest_filename_timestamp(self) -> None:
        """世代削除がファイルシステムの古いst_mtimeに惑わされず最新作成分を残し最古ファイル名分を削除すること"""
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        base_dt = datetime.now() - timedelta(days=20)
        old_names = []
        for i in range(5):
            name = f"library_backup_{(base_dt + timedelta(days=i)).strftime('%Y%m%d_%H%M%S')}.db"
            (self.backup_dir / name).write_bytes(b"old-gen")
            old_names.append(name)

        # 元DBのst_mtimeを古くした状態で新規バックアップを作成
        close_all_connections()
        stale_ts = time.time() - 10 * 86400
        os.utime(self.db_path, (stale_ts, stale_ts))

        with patch("server.security.get_security_status", return_value={}):
            res = db_stats_mod.backup_database(max_backups=5)

        remaining = {p.name for p in self.backup_dir.glob("library_backup_*.db")}
        self.assertIn(res["filename"], remaining)
        self.assertNotIn(old_names[0], remaining)
        self.assertEqual(len(remaining), 5)

    def test_updater_server_cache_force_and_error_retry(self) -> None:
        """更新確認の15分キャッシュ、force_remote強制取得、エラー非キャッシュ＆再試行を検証"""
        mock_releases = [
            {
                "tag_name": "v2.9.9",
                "draft": False,
                "prerelease": False,
                "html_url": "https://github.com/zony0428/photo-manager/releases/tag/v2.9.9",
                "published_at": "2026-11-24T00:00:00Z",
                "assets": [
                    {
                        "name": "Tetheract_v2.9.9diff.zip",
                        "browser_download_url": "https://github.com/zony0428/photo-manager/releases/download/v2.9.9/Tetheract_v2.9.9diff.zip",
                        "size": 10 * 1024 * 1024,
                    }
                ],
            },
            {
                "tag_name": "v1.8.11",
                "draft": False,
                "prerelease": False,
                "html_url": "https://github.com/zony0428/photo-manager/releases/tag/v1.8.11",
                "published_at": "2026-11-15T04:16:27Z",
                "assets": [
                    {
                        "name": "Tetheract_v1.8.11diff.zip",
                        "browser_download_url": "https://github.com/zony0428/photo-manager/releases/download/v1.8.11/Tetheract_v1.8.11diff.zip",
                        "size": 3 * 1024 * 1024,
                    }
                ],
            },
        ]

        with updater_mod._release_cache_lock:
            updater_mod._release_cache["fetched_at"] = 0.0
            updater_mod._release_cache["data"] = None

        with patch("server.updater.get_version_info", return_value={"version": "2.5.4", "updated_at": "2026-11-24 00:25"}), \
             patch("server.updater.get_version", return_value="2.5.4"), \
             patch("server.updater.urllib.request.urlopen", return_value=_MockHttpResponse(mock_releases)) as mock_open:
            st1 = updater_mod.get_system_update_status(check_remote=True, force_remote=False, base_dir=self.tmp_root)
            self.assertTrue(st1["remote_release"]["checked"])
            self.assertTrue(st1["remote_release"]["checked_at"])
            self.assertTrue(st1["remote_release"]["remote_update_available"])
            self.assertEqual(st1["remote_release"]["latest_version"], "2.9.9")
            self.assertEqual(mock_open.call_count, 1)

            # 2回目はキャッシュ再利用
            st2 = updater_mod.get_system_update_status(check_remote=True, force_remote=False, base_dir=self.tmp_root)
            self.assertEqual(mock_open.call_count, 1)
            self.assertEqual(st2["remote_release"]["latest_version"], "2.9.9")

            # force_remote=True で強制再取得
            st3 = updater_mod.get_system_update_status(check_remote=True, force_remote=True, base_dir=self.tmp_root)
            self.assertEqual(mock_open.call_count, 2)
            self.assertTrue(st3["remote_release"]["checked"])

        # キャッシュクリア後の失敗時は非キャッシュで次回即リトライできること
        with updater_mod._release_cache_lock:
            updater_mod._release_cache["fetched_at"] = 0.0
            updater_mod._release_cache["data"] = None

        with patch("server.updater.get_version_info", return_value={"version": "2.5.4", "updated_at": "2026-11-24 00:25"}), \
             patch("server.updater.get_version", return_value="2.5.4"), \
             patch("server.updater.urllib.request.urlopen", side_effect=OSError("timeout")):
            st_err = updater_mod.get_system_update_status(check_remote=True, force_remote=False, base_dir=self.tmp_root)
            self.assertFalse(st_err["remote_release"]["checked"])
            self.assertIn("timeout", st_err["remote_release"]["error"])

        with patch("server.updater.get_version_info", return_value={"version": "2.5.4", "updated_at": "2026-11-24 00:25"}), \
             patch("server.updater.get_version", return_value="2.5.4"), \
             patch("server.updater.urllib.request.urlopen", return_value=_MockHttpResponse(mock_releases)) as mock_recover:
            st_ok = updater_mod.get_system_update_status(check_remote=True, force_remote=False, base_dir=self.tmp_root)
            self.assertEqual(mock_recover.call_count, 1)
            self.assertTrue(st_ok["remote_release"]["checked"])
            self.assertEqual(st_ok["remote_release"]["latest_version"], "2.9.9")

    def test_frontend_startup_update_check_runs_after_unlock_without_12h_lockout(self) -> None:
        """起動時更新確認がロック解除後に発火し、12時間ロックアウト廃止・UPDATEバッジ先頭配置であることを検証"""
        app_js = (PROJECT_ROOT / "frontend" / "js" / "app.js").read_text(encoding="utf-8")
        updater_js = (PROJECT_ROOT / "frontend" / "js" / "system_updater.js").read_text(encoding="utf-8")
        index_html = (PROJECT_ROOT / "frontend" / "index.html").read_text(encoding="utf-8")

        unlock_pos = app_js.index("ensureAppUnlockedOnStartup")
        trig_pos = app_js.index("triggerStartupUpdateCheck")
        self.assertGreater(trig_pos, unlock_pos)

        self.assertNotIn("AUTO_CHECK_INTERVAL_MS", updater_js)
        self.assertNotIn("LAST_REMOTE_CHECK_KEY", updater_js)
        self.assertIn("triggerStartupUpdateCheck", updater_js)
        self.assertIn("force_remote=", updater_js)

        badge_pos = index_html.index('id="headerUpdateAvailBadge"')
        ver_pos = index_html.index('id="appVersion"')
        self.assertLess(badge_pos, ver_pos)


if __name__ == "__main__":
    unittest.main()
