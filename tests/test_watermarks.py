"""
ウォーターマーク用ロゴライブラリ (library.db: watermark_assets) および
長辺基準パーセンテージ合成・mobile_delta同期・LAN制御・モバイル単体バンドルの回帰テスト。
"""

import io
import sqlite3
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from server import database as db_pkg
from server import mobile_delta as mobile_delta_mod
from server.database import (
    DEFAULT_WATERMARK_ID,
    close_all_connections,
    delete_watermark_asset,
    get_watermark_asset_blob,
    initialize_database,
    list_watermark_assets,
    save_watermark_asset,
    stats as db_stats,
    switch_database_path,
)
from server.database import connection as db_conn
from server.export_decorator import apply_watermark_pil
from server.lan_access import is_lan_path_allowed
from server.mobile_bundle import build_standalone_mobile_html
from server.mobile_delta import ensure_mobile_delta_db
from server.security import initialize_security_state, set_instance_file_for_test


def _make_png_bytes(width: int, height: int, rgba=(255, 64, 32, 220)) -> bytes:
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for x in range(width):
        for y in range(height):
            if 0 < x < width - 1 and 0 < y < height - 1:
                img.putpixel((x, y), rgba)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestWatermarkAssetsAndSharing(unittest.TestCase):
    """library.db ウォーターマークアセット管理・長辺%合成・同期・LAN境界テスト"""

    def setUp(self) -> None:
        self._orig_db_path = db_conn.DB_PATH
        self._orig_delta_db = mobile_delta_mod.DELTA_DB_PATH
        self._orig_locker_state = mobile_delta_mod.LOCKER_STATE_PATH
        self._orig_last_seq = mobile_delta_mod._last_built_commit_seq
        self._orig_last_mtime = mobile_delta_mod._last_built_locker_mtime
        self._tmp = tempfile.TemporaryDirectory()
        tmp_root = Path(self._tmp.name)
        self._test_db = tmp_root / "library.db"
        set_instance_file_for_test(tmp_root / ".tetheract_instance_wm_test")
        switch_database_path(self._test_db)
        db_stats.DB_PATH = self._test_db
        db_pkg.DB_PATH = self._test_db
        mobile_delta_mod.DELTA_DB_PATH = tmp_root / "mobile_delta.db"
        mobile_delta_mod.LOCKER_STATE_PATH = tmp_root / "mobile_locker_state.json"
        mobile_delta_mod._last_built_commit_seq = -1
        mobile_delta_mod._last_built_locker_mtime = -1.0
        initialize_database(fast_boot=False)
        initialize_security_state(force_reload=True)

    def tearDown(self) -> None:
        try:
            close_all_connections()
            set_instance_file_for_test(None)
            switch_database_path(self._orig_db_path)
            db_stats.DB_PATH = self._orig_db_path
            db_pkg.DB_PATH = self._orig_db_path
            mobile_delta_mod.DELTA_DB_PATH = self._orig_delta_db
            mobile_delta_mod.LOCKER_STATE_PATH = self._orig_locker_state
            mobile_delta_mod._last_built_commit_seq = self._orig_last_seq
            mobile_delta_mod._last_built_locker_mtime = self._orig_last_mtime
            initialize_security_state(force_reload=True)
        finally:
            self._tmp.cleanup()

    def test_default_tetheract_logo_seeded_once_and_user_can_delete(self) -> None:
        """初回DB初期化でTETHERACTロゴが登録され、ユーザー削除後は再初期化しても復活しない"""
        assets = list_watermark_assets()
        ids = [a["id"] for a in assets]
        self.assertIn(DEFAULT_WATERMARK_ID, ids)

        blob = get_watermark_asset_blob(DEFAULT_WATERMARK_ID)
        self.assertIsNotNone(blob)
        raw_bytes, mime, name, w, h = blob
        self.assertEqual(mime, "image/png")
        self.assertEqual(name, "TETHERACT")
        self.assertGreater(len(raw_bytes), 1000)
        self.assertGreater(w, h)

        # ユーザーが削除した場合、再初期化・一覧取得しても勝手に復活しない
        self.assertTrue(delete_watermark_asset(DEFAULT_WATERMARK_ID))
        initialize_database(fast_boot=False)
        initialize_database(fast_boot=True)
        assets_after = list_watermark_assets()
        self.assertNotIn(DEFAULT_WATERMARK_ID, [a["id"] for a in assets_after])

    def test_save_normalize_and_long_edge_percentage_composite(self) -> None:
        """縦長・横長カスタムロゴの保存・長辺2048px正規化・長辺基準%合成が正確に機能する"""
        # 縦長 (100x400) の透過PNGロゴを登録
        tall_bytes = _make_png_bytes(100, 400, rgba=(255, 0, 0, 255))
        saved = save_watermark_asset("tall_logo.png", tall_bytes, origin="pc")
        self.assertEqual(saved["width"], 100)
        self.assertEqual(saved["height"], 400)
        self.assertTrue(saved["id"].startswith("pc_"))

        # 写真 1000x800 (長辺1000px) に対して 20% → ロゴ長辺=200px → 50x200px に収まること
        base_photo = Image.new("RGB", (1000, 800), (10, 20, 30))
        out = apply_watermark_pil(
            base_photo,
            {
                "enabled": True,
                "type": "image",
                "asset_id": saved["id"],
                "position": "center",
                "opacity": 1.0,
                "size_ratio": 0.20,
            },
        )
        # 変更された画素のバウンディングボックスを計測して 50x200 に極めて近いことを検証
        xs, ys = [], []
        pix = out.load()
        for y in range(800):
            for x in range(1000):
                if pix[x, y][0] > 100:
                    xs.append(x)
                    ys.append(y)
        self.assertTrue(xs and ys, "ロゴが合成されていません")
        drawn_w = max(xs) - min(xs) + 1
        drawn_h = max(ys) - min(ys) + 1
        self.assertAlmostEqual(drawn_w, 50, delta=4)
        self.assertAlmostEqual(drawn_h, 200, delta=4)

        # 2048px 超の大型ロゴは自動で長辺 2048px へ縮小保存されること
        huge_img = Image.new("RGBA", (3000, 1500), (255, 255, 255, 200))
        huge_buf = io.BytesIO()
        huge_img.save(huge_buf, format="PNG")
        saved_huge = save_watermark_asset("huge.png", huge_buf.getvalue(), origin="pc")
        self.assertEqual(max(saved_huge["width"], saved_huge["height"]), 2048)

    def test_mobile_delta_includes_watermark_assets(self) -> None:
        """mobile_delta.db に watermark_assets テーブルが含まれる"""
        custom = save_watermark_asset("sync_logo.png", _make_png_bytes(120, 60), origin="pc")
        delta_path = ensure_mobile_delta_db(force=True)
        self.assertIsNotNone(delta_path)
        self.assertTrue(delta_path.is_file())

        conn = sqlite3.connect(str(delta_path))
        try:
            ids = {r[0] for r in conn.execute("SELECT id FROM watermark_assets").fetchall()}
            self.assertIn(DEFAULT_WATERMARK_ID, ids)
            self.assertIn(custom["id"], ids)
        finally:
            conn.close()

    def test_lan_access_and_standalone_bundle_integrity(self) -> None:
        """LANからはロゴ読取のみ許可・書込削除は拒否され、単体HTMLにランチャーとアダプタが結合される"""
        self.assertTrue(is_lan_path_allowed("GET", "/api/watermarks"))
        self.assertTrue(is_lan_path_allowed("GET", "/api/watermarks/default_tetheract_logo/image"))
        self.assertFalse(is_lan_path_allowed("POST", "/api/watermarks"))
        self.assertFalse(is_lan_path_allowed("DELETE", "/api/watermarks/default_tetheract_logo"))

        html = build_standalone_mobile_html()
        self.assertIn("mViewerLauncherBtn", html)
        self.assertIn("mViewerQuickShareBtn", html)
        self.assertIn("TetheractWatermarkAdapter", html)
        self.assertIn("viewerLauncher", html)


if __name__ == "__main__":
    unittest.main()
