"""
セキュリティ回帰テスト（Host検証・Origin検証・LANトークン認証・LANホワイトリスト・XMPサイズ上限）
実行: python\\python.exe -m unittest discover -s tests -p "test_*.py"  または  python\\python.exe tests\\test_security.py
（同梱 Python に pytest は無いため、末尾の unittest ラッパー経由で discover からも実行される）
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any, Dict
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from server import database as db_pkg_mod, field_log_store, lan_access, mobile_bundle, mobile_delta, security as security_mod, storage_manager, updater as updater_mod  # noqa: E402
from server.app import app  # noqa: E402
from server.database import close_all_connections, initialize_database, stats as db_stats_mod, switch_database_path as _raw_switch_database_path  # noqa: E402
from server.database import connection as db_conn_mod  # noqa: E402
from server.lan_access import LAN_TOKEN, LAN_TOKEN_COOKIE, is_host_header_allowed, is_lan_path_allowed  # noqa: E402
from server.security import get_instance_file_path, initialize_security_state, set_instance_file_for_test  # noqa: E402

# テスト高速化パッチ適用前の本番 PBKDF2 反復回数を退避・検証用に保持
_PROD_PBKDF2_ITERATIONS = security_mod.PBKDF2_ITERATIONS
_PROD_DERIVE_KEK_DEFAULTS = security_mod.derive_kek.__defaults__
_TEST_PBKDF2_ITERATIONS = 1_000

_MODULE_CTX: Dict[str, Any] = {}

LOCAL = TestClient(app, base_url="http://127.0.0.1:8088")
LAN_IP = "192.168.1.50"


def switch_database_path(new_path: Path) -> Path:
    """connection.DB_PATH に加え stats.DB_PATH（vacuum_database等）も同期切替して本番DB接触を完全に防ぐ"""
    old_path = _raw_switch_database_path(new_path)
    resolved = Path(new_path)
    db_stats_mod.DB_PATH = resolved
    db_pkg_mod.DB_PATH = resolved
    return old_path


def setUpModule() -> None:
    """本番 cache/library.db や Tetheract_Mobile.html に一切触れないよう一時環境へ完全隔離し、PBKDF2・LAN待受を軽量化する"""
    if _MODULE_CTX.get("active"):
        return
    temp_dir = tempfile.TemporaryDirectory()
    tmp_root = Path(temp_dir.name)
    tmp_cache = tmp_root / "cache"
    tmp_loome = tmp_root / "Loome"
    tmp_cache.mkdir(parents=True, exist_ok=True)
    tmp_loome.mkdir(parents=True, exist_ok=True)

    stack = contextlib.ExitStack()
    mock_lan_main = stack.enter_context(
        patch("server.lan_access.ensure_lan_listeners", return_value=["192.168.1.10"])
    )
    mock_lan_router = stack.enter_context(
        patch("server.routers.mobile_router.ensure_lan_listeners", return_value=["192.168.1.10"])
    )
    stack.enter_context(patch("server.database.switch_database_path", side_effect=switch_database_path))
    stack.enter_context(patch("server.database.connection.switch_database_path", side_effect=switch_database_path))

    _MODULE_CTX.update({
        "active": True,
        "temp_dir": temp_dir,
        "stack": stack,
        "mock_lan_main": mock_lan_main,
        "mock_lan_router": mock_lan_router,
        "orig_db_path": db_conn_mod.DB_PATH,
        "orig_lan_auth_file": lan_access._LAN_AUTH_FILE,
        "orig_lan_paired": lan_access._lan_paired,
        "orig_lan_token": lan_access.LAN_TOKEN,
        "orig_approved_ips": dict(lan_access._approved_client_ips),
        "orig_standalone_html": mobile_bundle.STANDALONE_HTML_PATH,
        "orig_ui_bundle_path": mobile_bundle.UI_BUNDLE_PATH,
        "orig_ui_bundle_meta_path": mobile_bundle.UI_BUNDLE_META_PATH,
        "orig_updates_dir": updater_mod.UPDATES_DIR,
        "orig_delta_db": mobile_delta.DELTA_DB_PATH,
        "orig_locker_state": mobile_delta.LOCKER_STATE_PATH,
        "orig_loome_dir": storage_manager.LOOME_DIR,
        "orig_storage_dir": storage_manager.STORAGE_DIR,
        "orig_legacy_dir": storage_manager.LEGACY_STORAGE_DIR,
        "orig_field_logs_dir": field_log_store.FIELD_LOGS_DIR,
    })

    security_mod.PBKDF2_ITERATIONS = _TEST_PBKDF2_ITERATIONS
    security_mod.derive_kek.__defaults__ = (_TEST_PBKDF2_ITERATIONS,)

    lan_access._LAN_AUTH_FILE = tmp_cache / ".mobile_lan_auth.json"
    mobile_bundle.STANDALONE_HTML_PATH = tmp_root / "Tetheract_Mobile.html"
    mobile_bundle.UI_BUNDLE_PATH = tmp_cache / "tetheract_ui_bundle.zip"
    mobile_bundle.UI_BUNDLE_META_PATH = tmp_cache / "tetheract_ui_bundle_meta.json"
    updater_mod.UPDATES_DIR = tmp_cache / "updates"
    mobile_delta.DELTA_DB_PATH = tmp_cache / "mobile_delta.db"
    mobile_delta.LOCKER_STATE_PATH = tmp_cache / "mobile_locker_state.json"
    storage_manager.LOOME_DIR = tmp_loome
    storage_manager.STORAGE_DIR = tmp_loome
    storage_manager.LEGACY_STORAGE_DIR = tmp_root / "legacy_storage_unused"
    field_log_store.FIELD_LOGS_DIR = tmp_cache / "field_logs"

    set_instance_file_for_test(tmp_root / ".tetheract_instance_sec_module")
    switch_database_path(tmp_cache / "sec_module_library.db")
    initialize_database()
    initialize_security_state(force_reload=True)


def tearDownModule() -> None:
    """一時DB・モック・パッチをすべて解除し、本番DBファイルを開かずに元の設定値へ戻す"""
    if not _MODULE_CTX.get("active"):
        return
    try:
        close_all_connections()
        set_instance_file_for_test(None)
        switch_database_path(_MODULE_CTX["orig_db_path"])

        security_mod.PBKDF2_ITERATIONS = _PROD_PBKDF2_ITERATIONS
        security_mod.derive_kek.__defaults__ = _PROD_DERIVE_KEK_DEFAULTS

        lan_access._LAN_AUTH_FILE = _MODULE_CTX["orig_lan_auth_file"]
        lan_access._lan_paired = _MODULE_CTX["orig_lan_paired"]
        lan_access.LAN_TOKEN = _MODULE_CTX["orig_lan_token"]
        lan_access._approved_client_ips.clear()
        lan_access._approved_client_ips.update(_MODULE_CTX["orig_approved_ips"])

        mobile_bundle.STANDALONE_HTML_PATH = _MODULE_CTX["orig_standalone_html"]
        mobile_bundle.UI_BUNDLE_PATH = _MODULE_CTX["orig_ui_bundle_path"]
        mobile_bundle.UI_BUNDLE_META_PATH = _MODULE_CTX["orig_ui_bundle_meta_path"]
        updater_mod.UPDATES_DIR = _MODULE_CTX["orig_updates_dir"]
        mobile_delta.DELTA_DB_PATH = _MODULE_CTX["orig_delta_db"]
        mobile_delta.LOCKER_STATE_PATH = _MODULE_CTX["orig_locker_state"]
        storage_manager.LOOME_DIR = _MODULE_CTX["orig_loome_dir"]
        storage_manager.STORAGE_DIR = _MODULE_CTX["orig_storage_dir"]
        storage_manager.LEGACY_STORAGE_DIR = _MODULE_CTX["orig_legacy_dir"]
        field_log_store.FIELD_LOGS_DIR = _MODULE_CTX["orig_field_logs_dir"]
    finally:
        _MODULE_CTX["stack"].close()
        _MODULE_CTX["temp_dir"].cleanup()
        _MODULE_CTX.clear()


def test_production_pbkdf2_iterations_constant():
    """本番の PBKDF2 ストレッチング反復回数が安全な定数値（200,000回以上）に維持されていることを確認"""
    assert _PROD_PBKDF2_ITERATIONS >= 200_000
    assert _PROD_DERIVE_KEK_DEFAULTS == (_PROD_PBKDF2_ITERATIONS,)


def _lan_client(with_cookie: bool = False) -> TestClient:
    """LAN上のスマホからのアクセスを模したクライアントを生成する"""
    client = TestClient(app, base_url="http://192.168.1.10:8088", client=(LAN_IP, 50000))
    if with_cookie:
        client.cookies.set(LAN_TOKEN_COOKIE, LAN_TOKEN)
    return client


def test_local_access_ok():
    """PC自身からの通常アクセスは許可される"""
    assert LOCAL.get("/api/version").status_code == 200


def test_dns_rebinding_host_rejected():
    """任意ドメインの Host ヘッダ（DNS Rebinding）は 400 で拒否される"""
    r = LOCAL.get("/api/photos", headers={"Host": "attacker.example.com:8088"})
    assert r.status_code == 400
    assert is_host_header_allowed("127.0.0.1:8088")
    assert is_host_header_allowed("localhost:8088")
    assert is_host_header_allowed("[::1]:8088")
    assert is_host_header_allowed("192.168.0.17:8088")
    assert not is_host_header_allowed("evil.example.com")
    assert not is_host_header_allowed("")


def test_foreign_origin_rejected():
    """外部サイトからのクロスオリジン要求は 403 で拒否される"""
    assert LOCAL.post("/api/shutdown", headers={"Origin": "https://evil.example.com"}).status_code == 403
    assert LOCAL.post("/api/shutdown", headers={"Origin": "null"}).status_code == 403


def test_lan_host_origin_cannot_call_localhost_destructive_apis():
    """LAN上の他ホスト（ルーター・他PC等）のページから 127.0.0.1 宛ての破壊系APIは 403 で拒否される"""
    foreign_lan = {"Origin": "http://192.168.1.1"}
    assert LOCAL.delete("/api/volumes/DEADBEEF", headers=foreign_lan).status_code == 403
    assert LOCAL.put("/api/volumes/DEADBEEF", json={"custom_name": "x"}, headers=foreign_lan).status_code == 403
    assert LOCAL.get("/api/volumes/DEADBEEF/status", headers=foreign_lan).status_code == 403
    assert LOCAL.post("/api/volumes/DEADBEEF/loome", json={"drive_letter": "E:"}, headers=foreign_lan).status_code == 403
    assert LOCAL.delete("/api/volumes/DEADBEEF/loome", headers=foreign_lan).status_code == 403
    assert LOCAL.post("/api/ai/tag-color-photos", json={"photo_ids": [1]}, headers=foreign_lan).status_code == 403
    assert LOCAL.options("/api/volumes/DEADBEEF", headers=foreign_lan).status_code == 403


def test_same_origin_lan_mobile_requests_allowed():
    """スマホ画面（PC の LAN IP から配信）からの同一オリジン要求は Origin 検証を通過する"""
    lan = _lan_client(with_cookie=True)
    r = lan.get("/api/version", headers={"Origin": "http://192.168.1.10:8088"})
    assert r.status_code == 200
    # LAN経由でも新しい破壊系APIはホワイトリスト外のため 403
    assert lan.delete("/api/volumes/DEADBEEF").status_code == 403
    assert lan.put("/api/tags-meta", json={}).status_code == 403


def test_lan_requires_token():
    """LAN経由はトークン無しだと 401、QRコードURLのトークンで許可されCookieが発行される"""
    lan = _lan_client()
    assert lan.get("/api/version").status_code == 401
    r = lan.get(f"/m?t={LAN_TOKEN}")
    assert r.status_code == 200
    assert LAN_TOKEN_COOKIE in r.headers.get("set-cookie", "")
    assert _lan_client(with_cookie=True).get("/api/version").status_code == 200
    assert _lan_client().get("/api/version?t=wrong-token").status_code == 401


def test_lan_whitelist_blocks_admin_apis():
    """トークンがあってもPC管理系・破壊的APIはLANから呼べない"""
    lan = _lan_client(with_cookie=True)
    blocked = [
        ("POST", "/api/shutdown"),
        ("POST", "/api/photos/batch-shift-date"),
        ("POST", "/api/storage/move-photos"),
        ("POST", "/api/storage/import-folder"),
        ("POST", "/api/volumes/DEADBEEF/loome"),
        ("DELETE", "/api/volumes/DEADBEEF/loome"),
        ("DELETE", "/api/tags/foo"),
        ("POST", "/api/photo/1/adjust"),
        ("POST", "/api/photo/1/open-file"),
        ("GET", "/api/browse"),
        ("GET", "/api/mobile/info"),
        ("POST", "/api/mobile/reset-pairing"),
        ("POST", "/api/mobile/approve-pair"),
        ("POST", "/api/media/check"),
        ("GET", "/api/media/events"),
        ("POST", "/api/photos/check-external-updates"),
        ("POST", "/api/export/smart"),
        ("POST", "/api/export/detect-privacy"),
        ("POST", "/api/export/pick-watermark-image"),
        ("POST", "/api/watermarks"),
        ("DELETE", "/api/watermarks/default_tetheract_logo"),
        ("GET", "/index.html"),
    ]
    for method, path in blocked:
        assert lan.request(method, path).status_code == 403, f"{method} {path} はLANから拒否されるべき"


def test_lan_whitelist_allows_mobile_apis():
    """スマホ画面に必要なAPIはホワイトリストで許可される"""
    allowed = [
        ("GET", "/m"),
        ("GET", "/js/mobile.js"),
        ("GET", "/api/photos"),
        ("GET", "/api/photo/12/thumbnail"),
        ("GET", "/api/photo/12/view"),
        ("POST", "/api/photo/12/rate"),
        ("POST", "/api/photo/12/set-primary"),
        ("POST", "/api/photo/12/adjustments"),
        ("POST", "/api/photos/batch-rate"),
        ("POST", "/api/photo/12/tags"),
        ("DELETE", "/api/photo/12/tags/%E7%8C%AB"),
        ("POST", "/api/mobile/sync-import"),
        ("GET", "/api/mobile/pair-info"),
        ("GET", "/api/mobile/locker-sync"),
        ("GET", "/api/mobile/ui-bundle"),
        ("GET", "/api/watermarks"),
        ("GET", "/api/watermarks/default_tetheract_logo/image"),
        ("GET", "/css/touch-responsive.css"),
        ("GET", "/js/core/tree_builder.js"),
        ("GET", "/js/adapters/data_adapter.js"),
        ("GET", "/js/adapters/watermark_adapter.js"),
        ("GET", "/js/views/touch/touch_layout.js"),
        ("GET", "/js/views/touch/touch_viewer_launcher.js"),
    ]
    lan_no_tok = _lan_client(with_cookie=False)
    assert lan_no_tok.get("/api/mobile/locker-sync?mode=status").status_code == 401
    assert lan_no_tok.get("/api/mobile/pair-info").status_code == 401
    assert lan_no_tok.get("/api/mobile/ui-bundle").status_code == 401
    # トークン未所持のLANクライアントからの discover は母艦情報のみ返し、秘密トークンは漏洩しない
    r_disc_unauth = lan_no_tok.get("/api/mobile/discover?request_pair=1&device=PixelTest")
    assert r_disc_unauth.status_code == 200
    disc_json = r_disc_unauth.json()
    assert disc_json.get("service") == "tetheract-pm"
    assert disc_json.get("paired_match") is False
    assert disc_json.get("pair_token") == ""
    assert disc_json.get("pairing_pending") is True
    # localhost 側で承認すると、承認された LAN クライアントへ pair_token が交付される
    r_approve = LOCAL.post("/api/mobile/approve-pair", json={"client_ip": LAN_IP})
    assert r_approve.status_code == 200
    if _MODULE_CTX.get("mock_lan_router") is not None:
        assert _MODULE_CTX["mock_lan_router"].called is True
    r_disc_approved = lan_no_tok.get("/api/mobile/discover")
    assert r_disc_approved.status_code == 200
    assert r_disc_approved.json().get("paired_match") is True
    assert r_disc_approved.json().get("pair_token") == LAN_TOKEN
    from server import lan_access as _la
    _la._approved_client_ips.clear()

    lan_tok = _lan_client(with_cookie=True)
    r_pair = lan_tok.get("/api/mobile/pair-info")
    assert r_pair.status_code == 200
    assert r_pair.json().get("deep_link", "").startswith("tetheract://pair?")
    r_st = lan_tok.get("/api/mobile/locker-sync?mode=status")
    assert r_st.status_code == 200
    st_json = r_st.json()
    assert st_json.get("ok") is True
    assert st_json.get("ui_revision") and isinstance(st_json.get("ui_mtime"), int) and st_json.get("ui_version")
    assert st_json.get("native_revision")

    r_conn = lan_tok.get("/api/mobile/connection-status")
    assert r_conn.status_code == 200
    conn_json = r_conn.json()
    assert conn_json.get("ui_revision") == st_json.get("ui_revision")
    assert conn_json.get("native_revision") == st_json.get("native_revision")
    assert conn_json.get("ui_version") == st_json.get("ui_version")

    r_bundle = lan_tok.get("/api/mobile/ui-bundle")
    assert r_bundle.status_code == 200
    assert r_bundle.headers.get("x-tetheract-ui-revision") == st_json.get("ui_revision")
    with zipfile.ZipFile(io.BytesIO(r_bundle.content), "r") as zf:
        names = set(zf.namelist())
        assert "mobile.html" in names
        assert "ui_bundle_meta.json" in names
        meta = json.loads(zf.read("ui_bundle_meta.json").decode("utf-8"))
        assert meta.get("ui_revision") == st_json.get("ui_revision")
        assert meta.get("native_revision") == st_json.get("native_revision")
    for method, path in allowed:
        assert is_lan_path_allowed(method, path), f"{method} {path} はLANから許可されるべき"


def test_xmp_size_limit(tmp_path):
    """上限を超えるXMPは解析されない"""
    from server import sidecar

    img = tmp_path / "a.jpg"
    img.write_bytes(b"\xff\xd8\xff\xd9")
    xmp = tmp_path / "a.xmp"
    xmp.write_bytes(b"<x:xmpmeta xmlns:x='adobe:ns:meta/'>" + b" " * (sidecar.MAX_XMP_FILE_BYTES + 10) + b"</x:xmpmeta>")
    assert sidecar.parse_xmp_for_photo(img)["has_xmp"] is False


def test_open_folder_rejects_files():
    """エクスプローラー起動APIはフォルダ以外（実行ファイル等）を開かない"""
    from server.exporter import open_folder_in_windows_explorer

    assert open_folder_in_windows_explorer(Path("C:/Windows/System32/calc.exe")) is False


def test_three_tier_security_and_ethical_protection(tmp_path):
    """
    3段階セキュリティ（Lv.0 エシカルモード / Lv.1 起動＆DBロック / Lv.2 フルロック＋Loomeカプセル化）
    および USB故障時の3つの救済手段（所有メディアVSN照合・パスワード・リカバリーコード）の統合テスト
    """
    from server.database import (
        close_thread_connection,
        get_connection,
        get_thumbnail,
        initialize_database,
        save_thumbnail,
        switch_database_path,
        upsert_photo,
        upsert_volume,
    )
    from server.database import connection as db_conn_mod
    from server.security import (
        THUMB_ENC_MAGIC,
        VAULT_FILE_MAGIC,
        assert_drive_not_blocked_by_foreign_loome,
        configure_security_level,
        get_logical_file_size,
        get_security_status,
        initialize_security_state,
        inspect_drive_loome_ownership,
        is_app_locked,
        is_vault_encrypted_file,
        lock_session_now,
        read_loome_file_decrypted_bytes,
        recover_db_by_owned_media,
        refresh_vsn_rescue_bundles_if_unlocked,
        seal_loome_file,
        set_instance_file_for_test,
        unlock_foreign_loome_with_password,
        unlock_with_password_or_recovery,
        unseal_loome_file,
    )

    orig_db = db_conn_mod.DB_PATH
    orig_inst = get_instance_file_path()
    inst_a = tmp_path / ".tetheract_instance_A"
    inst_b = tmp_path / ".tetheract_instance_B"
    inst_c = tmp_path / ".tetheract_instance_C"
    test_db = tmp_path / "sec_test_library.db"

    try:
        set_instance_file_for_test(inst_a)
        switch_database_path(test_db)
        initialize_database()

        st0 = get_security_status()
        assert st0["security_level"] == 0
        assert st0["is_locked"] is False
        assert st0["db_foreign_locked"] is False
        recovery_code = st0["recovery_code"]
        assert recovery_code and recovery_code.startswith("TETH-")

        # ------------------------------------------------------------------
        # 1. Lv.0 エシカル保護: 他人の Loome ドライブ検知・完全拒否 ＆ 同一パスワード承認
        # ------------------------------------------------------------------
        foreign_drive = tmp_path / "foreign_drive"
        foreign_loome = foreign_drive / "Loome"
        foreign_loome.mkdir(parents=True)
        (foreign_loome / "other_user_photo.jpg").write_bytes(b"\xff\xd8\xff\xd9" * 100)

        # 未刻印でも非空で自DB未登録なら他人のLoomeとして検知される
        st_unsealed, info_unsealed = inspect_drive_loome_ownership(foreign_drive, volume_serial="AAAA-1111")
        assert st_unsealed == "foreign"
        try:
            assert_drive_not_blocked_by_foreign_loome(foreign_drive, volume_serial="AAAA-1111")
            raise AssertionError("他人のLoomeドライブは PermissionError で拒否されるべき")
        except PermissionError:
            pass

        # 自分の別PCでパスワード "SharedPass77" を設定して作った Loome シールを模擬作成
        from server.security import aead_encrypt, clear_drive_loome_cache, derive_kek
        import json as _json
        import os as _os

        pw_salt = _os.urandom(16)
        pw_kek = derive_kek("SharedPass77", pw_salt)
        foreign_owner_id = "foreign_owner_id_9999"
        foreign_bundle = _json.dumps({
            "dek": (_os.urandom(32)).hex(),
            "owner_secret": (_os.urandom(32)).hex(),
            "owner_id": foreign_owner_id,
        }).encode("utf-8")
        wrapped_owner_bundle = aead_encrypt(pw_kek, foreign_bundle, aad=foreign_owner_id.encode("utf-8"))
        seal_data = {
            "version": 1,
            "owner_id": foreign_owner_id,
            "vsn": "BBBB-2222",
            "seal_mac": "00" * 32,
            "pw_protected": True,
            "pw_salt": pw_salt.hex(),
            "wrapped_owner_bundle": wrapped_owner_bundle.hex(),
        }
        (foreign_loome / ".loome_seal").write_text(_json.dumps(seal_data), encoding="utf-8")
        clear_drive_loome_cache()

        st_pw, info_pw = inspect_drive_loome_ownership(foreign_drive, volume_serial="BBBB-2222")
        assert st_pw == "foreign"
        assert info_pw["pw_protected"] is True

        # 誤ったパスワードでは拒否され、正しいパスワードで自分の Loome として承認される
        from unittest.mock import patch
        with patch("server.volume_info.find_online_drive_for_serial", return_value={"drive": str(foreign_drive)}):
            try:
                unlock_foreign_loome_with_password("BBBB-2222", "WrongPass")
                raise AssertionError("誤パスワードは ValueError になるべき")
            except ValueError:
                pass
            unlock_res = unlock_foreign_loome_with_password("BBBB-2222", "SharedPass77")
            assert unlock_res["status"] == "ok"

        st_after, _ = inspect_drive_loome_ownership(foreign_drive, volume_serial="BBBB-2222")
        assert st_after == "own"

        # ------------------------------------------------------------------
        # 2. Lv.0 エシカル保護: DB単体引き抜き検知 ＆ 3つの救済手段（所有メディア照合 / リカバリーコード）
        # ------------------------------------------------------------------
        sample_photo_file = tmp_path / "owned_card_photo.jpg"
        sample_bytes = b"\xff\xd8\xff\xe0" + b"JPEGDATA" * 500 + b"\xff\xd9"
        sample_photo_file.write_bytes(sample_bytes)

        cur_drive = Path(tmp_path).drive.upper().rstrip("\\")
        from server.volume_info import get_volume_info
        real_vol = get_volume_info(str(tmp_path))
        real_vsn = (real_vol.get("serial") if real_vol else None) or "TEST-VSN1"
        upsert_volume(real_vsn, "MY_SD_CARD", cur_drive)
        pid = upsert_photo({
            "file_path": str(sample_photo_file),
            "file_name": sample_photo_file.name,
            "directory_path": str(tmp_path),
            "file_size": len(sample_bytes),
            "file_mtime": sample_photo_file.stat().st_mtime,
            "volume_serial": real_vsn,
        })
        raw_webp = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 20
        save_thumbnail(pid, raw_webp, 160, 120, "hash1")
        refresh_vsn_rescue_bundles_if_unlocked()

        # インスタンスB（別のTetheract本体に library.db だけコピーされた状態）へ切り替え
        set_instance_file_for_test(inst_b)
        initialize_security_state(force_reload=True)
        assert is_app_locked() is True
        assert get_security_status()["db_foreign_locked"] is True
        # ロック中はデータAPIが 423 Locked で遮断される
        assert LOCAL.get("/api/photos").status_code == 423

        # 救済手段①: 所有メディア（VSN＋実在写真ファイル）照合で新本体Bへ引き継ぎ
        if real_vol and real_vol.get("serial"):
            rec_res = recover_db_by_owned_media()
            assert rec_res["status"] == "ok"
            assert is_app_locked() is False
            assert LOCAL.get("/api/photos").status_code == 200

        # インスタンスCへ切り替えて、救済手段③（リカバリーコード）での引き継ぎを検証
        set_instance_file_for_test(inst_c)
        initialize_security_state(force_reload=True)
        assert is_app_locked() is True
        rec_code_res = unlock_with_password_or_recovery(recovery_code)
        assert rec_code_res["status"] == "ok"
        assert is_app_locked() is False

        # ------------------------------------------------------------------
        # 3. Lv.1 起動ロック ＆ DBサムネイル暗号化マイグレーションと透過復号
        # ------------------------------------------------------------------
        cfg1 = configure_security_level(1, new_password="MySecurePassword1")
        assert cfg1["security_level"] == 1

        # DB内の生BLOBは TENC\x01 で暗号化されているが、get_thumbnail() は平文WebPを返す
        with get_connection() as conn:
            row = conn.execute("SELECT data FROM thumbnails WHERE photo_id = ?", (pid,)).fetchone()
            assert bytes(row["data"]).startswith(THUMB_ENC_MAGIC)
        dec_thumb = get_thumbnail(pid)
        assert dec_thumb is not None
        assert dec_thumb["data"] == raw_webp

        # セッションをロックすると 423 Locked になり、パスワードで解除できる
        lock_session_now()
        assert is_app_locked() is True
        assert LOCAL.get("/api/photos").status_code == 423
        assert LOCAL.post("/api/security/unlock", json={"password": "WrongPassword"}).status_code == 400
        assert LOCAL.post("/api/security/unlock", json={"password": "MySecurePassword1"}).status_code == 200
        assert is_app_locked() is False
        assert LOCAL.get("/api/photos").status_code == 200

        # ------------------------------------------------------------------
        # 4. Lv.2 フルロック: Loome ファイルのカプセル化と1ビット完全復元
        # ------------------------------------------------------------------
        cfg2 = configure_security_level(2, current_password="MySecurePassword1", new_password="MySecurePassword1")
        assert cfg2["security_level"] == 2

        vault_target = tmp_path / "loome_sample.jpg"
        orig_payload = b"\xff\xd8\xff\xe1" + _os.urandom(90000) + b"\xff\xd9"
        vault_target.write_bytes(orig_payload)
        orig_mtime = vault_target.stat().st_mtime

        assert seal_loome_file(vault_target) is True
        assert is_vault_encrypted_file(vault_target) is True
        # ディスク上の先頭8バイトは TETHVLT1 になり、サイズは +72 バイト、論理サイズは元のまま
        on_disk = vault_target.read_bytes()
        assert on_disk[:8] == VAULT_FILE_MAGIC
        assert len(on_disk) == len(orig_payload) + 72
        assert get_logical_file_size(vault_target) == len(orig_payload)
        assert abs(vault_target.stat().st_mtime - orig_mtime) < 1e-3

        # オンメモリ復号読み出しで元のデータと1ビット単位で一致する
        decrypted_bytes = read_loome_file_decrypted_bytes(vault_target)
        assert decrypted_bytes == orig_payload

        # カプセル化解除でディスク上のファイル自体も元のデータへ完全復元される
        assert unseal_loome_file(vault_target) is True
        assert is_vault_encrypted_file(vault_target) is False
        assert vault_target.read_bytes() == orig_payload

        # Lv.0 に戻すと DB サムネイルも平文へ復号マイグレーションされる
        cfg0 = configure_security_level(0, current_password="MySecurePassword1")
        assert cfg0["security_level"] == 0
        with get_connection() as conn:
            row0 = conn.execute("SELECT data FROM thumbnails WHERE photo_id = ?", (pid,)).fetchone()
            assert bytes(row0["data"]) == raw_webp

    finally:
        close_thread_connection()
        set_instance_file_for_test(orig_inst)
        switch_database_path(orig_db)
        initialize_security_state(force_reload=True)


def test_red_blue_team_failsafe_and_salvage(tmp_path: Path):
    """
    Red Team vs Blue Team 監査で特定された鍵ロスト・セルフブリック防止策の総合回帰テスト:
      1. Lv.2 カプセル化ファイルに対する compute_file_sample_hash の平文一致性
      2. 重複写真統合等で photo_id が付け替わった暗号化サムネイルの透過復号と Lv.0 解除耐性
      3. Lv.2 運用中に library.db を誤削除・紛失して再起動した際の Loome/.loome_seal からの鍵自動サルベージと完全復号
      4. Lv.0 で cache/ と Loome/ をセットで新フォルダへ引っ越し（.tetheract_instance コピー漏れ）した際の自動ペアリングと、
         library.db 単体引き抜き時の確実なロック発動
    """
    import os as _os
    from server.database import (
        close_all_connections,
        close_thread_connection,
        get_connection,
        get_thumbnail,
        initialize_database,
        save_thumbnail,
        switch_database_path,
        upsert_photo,
    )
    from server.scanner import compute_file_sample_hash
    from server.security import (
        configure_security_level,
        initialize_security_state,
        is_app_locked,
        is_vault_encrypted_file,
        read_loome_file_decrypted_bytes,
        set_instance_file_for_test,
        unlock_with_password_or_recovery,
    )

    orig_db = db_conn_mod.DB_PATH
    orig_inst = get_instance_file_path()
    db_first = tmp_path / "library_v1.db"
    db_recreated = tmp_path / "library_recreated.db"
    inst_first = tmp_path / ".tetheract_instance"
    internal_loome = tmp_path / "Loome"
    internal_loome.mkdir(parents=True, exist_ok=True)

    try:
        set_instance_file_for_test(inst_first)
        switch_database_path(db_first)
        initialize_database()
        st0 = initialize_security_state(force_reload=True)
        orig_owner_id = st0["owner_id_full"]
        orig_recovery_code = st0["recovery_code"]

        # 本体 Loome 内に写真ファイルを作成
        loome_photo = internal_loome / "precious_memory.jpg"
        plain_photo_bytes = b"\xff\xd8\xff\xe0" + _os.urandom(120_000) + b"\xff\xd9"
        loome_photo.write_bytes(plain_photo_bytes)
        plain_sample_hash = compute_file_sample_hash(loome_photo)

        pid1 = upsert_photo({
            "file_path": str(loome_photo),
            "file_name": loome_photo.name,
            "directory_path": str(internal_loome),
            "file_size": len(plain_photo_bytes),
            "file_mtime": loome_photo.stat().st_mtime,
            "volume_serial": "LOOME-VSN1",
        })
        pid2 = upsert_photo({
            "file_path": str(internal_loome / "dup_target.jpg"),
            "file_name": "dup_target.jpg",
            "directory_path": str(internal_loome),
            "file_size": 12345,
            "file_mtime": loome_photo.stat().st_mtime,
            "volume_serial": "LOOME-VSN1",
        })
        thumb_webp = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x11" * 20
        save_thumbnail(pid1, thumb_webp, 160, 120, "h_pid1")

        # Lv.2 フルロックへ移行 -> 本体 Loome 内の precious_memory.jpg も自動カプセル化される
        cfg_lv2 = configure_security_level(2, new_password="SalvagePass99")
        assert cfg_lv2["security_level"] == 2
        assert is_vault_encrypted_file(loome_photo) is True

        # [検証1] Lv.2 カプセル化状態でも compute_file_sample_hash が平文時と完全一致すること
        enc_sample_hash = compute_file_sample_hash(loome_photo)
        assert enc_sample_hash == plain_sample_hash

        # [検証2] 重複統合等で thumbnails.data が別の photo_id (pid2) に SQL コピーされても復号・Lv.0解除できること
        with get_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO thumbnails (photo_id, data, width, height, file_hash) "
                "SELECT ?, data, width, height, file_hash FROM thumbnails WHERE photo_id = ?",
                (pid2, pid1),
            )
            conn.commit()
        dec_pid2 = get_thumbnail(pid2)
        assert dec_pid2 is not None and dec_pid2["data"] == thumb_webp

        # [検証3] 致命的シナリオ: Lv.2 運用中に library.db と .tetheract_instance の両方を誤削除し、
        # 新規空DB (db_recreated) で起動した場合でも、本体 Loome/.loome_seal から鍵が自動サルベージされること！
        close_all_connections()
        inst_first.unlink(missing_ok=True)
        switch_database_path(db_recreated)
        initialize_database()
        st_salvaged = initialize_security_state(force_reload=True)
        assert st_salvaged["security_level"] == 2
        assert st_salvaged["is_locked"] is True

        # リカバリーコード（またはパスワード）でロック解除すると、元の owner_id と元の DEK が完全復活する
        st_unlocked = unlock_with_password_or_recovery(orig_recovery_code)
        assert st_unlocked["status"] == "ok"
        assert st_unlocked["owner_id_full"] == orig_owner_id
        assert is_app_locked() is False

        # サルベージされた元の DEK により、Lv.2 カプセル化されていた写真が1ビットの狂いもなく復号できる！
        assert read_loome_file_decrypted_bytes(loome_photo) == plain_photo_bytes

        # Lv.0 エシカルモードに戻すと、本体 Loome の写真も平文へ完全復元される
        cfg_back_lv0 = configure_security_level(0, current_password="SalvagePass99")
        assert cfg_back_lv0["security_level"] == 0
        assert is_vault_encrypted_file(loome_photo) is False
        assert loome_photo.read_bytes() == plain_photo_bytes

        # [検証4] Lv.0 でフル版ZIP展開フォルダへ cache/ と Loome/ をセットでコピペ引っ越しし、
        # 隠しファイル .tetheract_instance をコピーし忘れた場合でも、Loome/.loome_seal のコヒージョン証明で自動ペアリングされること
        inst_first.unlink(missing_ok=True)
        st_moved = initialize_security_state(force_reload=True)
        assert st_moved["is_locked"] is False
        assert st_moved["db_foreign_locked"] is False

        # 一方、Loome/.loome_seal が無い環境へ library.db 単体が引き抜かれた場合は確実に db_foreign_locked になること
        (internal_loome / ".loome_seal").unlink(missing_ok=True)
        inst_first.unlink(missing_ok=True)
        st_stolen = initialize_security_state(force_reload=True)
        assert st_stolen["is_locked"] is True
        assert st_stolen["db_foreign_locked"] is True

        # [検証5] v1.7.0未満で作られた別PC環境（別ホスト名 / 別CドライブVSN）の未刻印DB（security_meta無し・写真あり）が
        # 放り込まれた場合でも、初回起動時に別環境DBとして検知され db_foreign_locked = True になり、かつDB自体は汚染されないこと
        with get_connection() as conn:
            conn.execute("DROP TABLE IF EXISTS security_meta")
            conn.execute(
                "INSERT INTO photos (file_path, file_name, directory_path, file_size, volume_serial) "
                "VALUES ('C:\\Foreign\\p1.jpg', 'p1.jpg', 'C:\\Foreign', 1024, 'DEADC0DE')"
            )
            conn.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('server_candidates', '[\"http://other-foreign-pc:8088\"]')"
            )
            conn.execute(
                "INSERT OR REPLACE INTO volumes (volume_serial, volume_label, custom_name, drive_letter, loome_enabled) "
                "VALUES ('DEADC0DE', 'ForeignOS', '', 'C:', 0)"
            )
            conn.commit()
        inst_first.unlink(missing_ok=True)
        st_legacy_foreign = initialize_security_state(force_reload=True)
        assert st_legacy_foreign["is_locked"] is True
        assert st_legacy_foreign["db_foreign_locked"] is True
        with get_connection() as conn:
            row_cnt = conn.execute("SELECT COUNT(*) FROM security_meta").fetchone()[0]
            assert row_cnt == 0, "未刻印DBのロック判定時にDBファイルを汚染してはならない"

        # [検証5-B] 本体 Loome/.loome_seal に別DBの刻印が残っている環境でも、自環境の正規バックアップDB（未刻印）を
        # 戻した際は誤ロックされず正常にペアリング起動すること
        (internal_loome / ".loome_seal").write_text(
            '{"version": 2, "owner_id": "other_session_owner", "vsn": "TEST", "seal_mac": "00"}',
            encoding="utf-8",
        )
        with get_connection() as conn:
            conn.execute("DELETE FROM app_meta WHERE key = 'server_candidates'")
            conn.execute("DELETE FROM volumes WHERE volume_serial = 'DEADC0DE'")
            conn.execute(
                "INSERT INTO photos (file_path, file_name, directory_path, file_size, volume_serial) "
                "VALUES (?, 'own_backup.jpg', ?, 1024, 'OWN-VSN')",
                (str(loome_photo), str(internal_loome)),
            )
            conn.commit()
        st_own_backup = initialize_security_state(force_reload=True)
        assert st_own_backup["is_locked"] is False
        assert st_own_backup["db_foreign_locked"] is False

        # [検証6] v1.7.0 で起動した DB を v1.6.1 以前の環境（tetheract_v170_guard 未搭載の旧版 SQLite 接続）に
        # 放り込んだ場合（ダウングレード攻撃）、SELECT p.* FROM photos p および app_meta 更新が OperationalError で完全に拒絶されること
        import sqlite3 as _raw_sqlite3
        legacy_conn = _raw_sqlite3.connect(str(db_recreated))
        try:
            downgrade_select_blocked = False
            try:
                legacy_conn.execute("SELECT p.* FROM photos p").fetchall()
            except _raw_sqlite3.OperationalError:
                downgrade_select_blocked = True
            assert downgrade_select_blocked is True

            downgrade_boot_blocked = False
            try:
                legacy_conn.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('last_server_url', 'http://127.0.0.1:8088')")
            except _raw_sqlite3.OperationalError:
                downgrade_boot_blocked = True
            assert downgrade_boot_blocked is True
        finally:
            legacy_conn.close()

        # [検証7] モバイル用 sql-wasm.js および単体モバイルHTML生成出力の create_function が SQLITE_DETERMINISTIC (2049) を備えていること
        sql_wasm_js = (ROOT / "frontend" / "vendor" / "sqljs" / "sql-wasm.js").read_text(encoding="utf-8")
        assert "tb(this.db,g,l.length,2049,0,n,0,0,0)" in sql_wasm_js
        standalone_html = mobile_bundle.build_standalone_mobile_html()
        assert "tb(this.db,g,l.length,2049,0,n,0,0,0)" in standalone_html

        # [検証8] 3層分離モジュール群（core/・adapters/・views/touch/）および Android ネイティブシェルの契約・インライン化検証
        from scripts.build_android_apk import verify_project_integrity
        with contextlib.redirect_stdout(io.StringIO()):
            assert verify_project_integrity(sync_assets=False) is True
        modular_files = [
            "frontend/js/core/tree_builder.js",
            "frontend/js/adapters/data_adapter.js",
            "frontend/js/adapters/field_log_adapter.js",
            "frontend/js/adapters/phone_case_adapter.js",
            "frontend/js/views/touch/touch_layout.js",
            "frontend/js/views/touch/touch_gestures.js",
            "frontend/js/views/touch/touch_adjust.js",
            "frontend/js/views/touch/morph_thumb_bar.js",
            "frontend/js/views/touch/touch_duel.js",
            "frontend/js/views/touch/touch_field_log.js",
            "frontend/js/views/touch/touch_phone_case.js",
            "frontend/css/touch-responsive.css",
            "frontend/css/touch-fieldlog.css",
        ]
        for rel_mod in modular_files:
            mod_path = ROOT / rel_mod
            assert mod_path.exists(), f"Missing modular file: {rel_mod}"
            assert f"=== Inlined {rel_mod.removeprefix('frontend/')} ===" in standalone_html

    finally:
        close_thread_connection()
        set_instance_file_for_test(orig_inst)
        switch_database_path(orig_db)
        initialize_security_state(force_reload=True)


def test_android_bridge_blocks_arbitrary_sql_write():
    """Android の WebView ブリッジから任意の書き込み SQL を実行できないことを静的に確認する"""
    pkg_dir = ROOT / "android" / "app" / "src" / "main" / "java" / "com" / "tetheract" / "pm"
    bridge_code = (pkg_dir / "TetheractNativeBridge.kt").read_text(encoding="utf-8")
    locker_code = (pkg_dir / "LockerDatabaseManager.kt").read_text(encoding="utf-8")
    mobile_js = (ROOT / "frontend" / "js" / "mobile.js").read_text(encoding="utf-8")

    assert "fun execSqlJson" not in bridge_code, "任意SQL実行ブリッジ execSqlJson を公開してはならない"
    assert "execSqlSafeJson" not in locker_code
    assert "execSqlJson" not in mobile_js
    # 読み取り用 rawQueryJson は読み取り専用判定を必ず通す
    assert "if (!isReadOnlySql(sql))" in locker_code
    assert "WRITE_SQL_REGEX" in locker_code


def test_field_log_lan_and_token_security(tmp_path: Path):
    """
    フィールドログAPIのLANアクセス制御を検証する:
      1. POST /api/mobile/field-logs はLANからトークン無しなら401、正しいトークン付きなら200で通過する
      2. PC管理・照合・削除・GPX出力・Undo系の全エンドポイントは、正しいトークン付きのLANクライアントからでも403で遮断される
    """
    import hashlib
    import json
    from server import field_log_store

    assert is_lan_path_allowed("POST", "/api/mobile/field-logs") is True
    assert is_lan_path_allowed("GET", "/css/touch-fieldlog.css") is True

    dev_id = "3f2a1111-2222-4333-8444-555566667777"
    sample_jsonl = (
        json.dumps({
            "type": "header",
            "format": "tetheract-fieldlog-v1",
            "device_id": dev_id,
            "device_name": "Pixel SecTest",
            "date": "2026-11-09",
        })
        + "\n"
        + json.dumps({
            "type": "pt",
            "t": 1762646400000,
            "tz": 540,
            "lat": 35.0116,
            "lon": 135.7681,
        })
        + "\n"
    )
    sha = hashlib.sha256(sample_jsonl.encode("utf-8")).hexdigest()
    upload_payload = {
        "device_id": dev_id,
        "device_name": "Pixel SecTest",
        "date": "2026-11-09",
        "sha256": sha,
        "content": sample_jsonl,
    }

    orig_logs_dir = field_log_store.FIELD_LOGS_DIR
    field_log_store.FIELD_LOGS_DIR = tmp_path / "sec_field_logs"
    try:
        lan_no_tok = _lan_client(with_cookie=False)
        assert lan_no_tok.post("/api/mobile/field-logs", json=upload_payload).status_code == 401
        assert lan_no_tok.post("/api/mobile/field-logs?t=wrong-token", json=upload_payload).status_code == 401

        lan_tok = _lan_client(with_cookie=True)
        r_ok = lan_tok.post("/api/mobile/field-logs", json=upload_payload)
        assert r_ok.status_code == 200
        assert r_ok.json().get("ok") is True
        assert r_ok.json().get("points") == 1

        # トークン付きLANクライアントであっても、PC側の管理・照合・削除・GPX・Undoはすべて 403 で遮断される
        localhost_only_calls = [
            ("GET", "/api/field-logs", None),
            ("POST", "/api/field-logs/delete", {"all": True}),
            ("GET", f"/api/field-logs/{dev_id}/2026-11-09.gpx", None),
            ("POST", "/api/field-logs/match/preview", {"dates": ["2026-11-09"]}),
            ("POST", "/api/field-logs/match/apply", {"dates": ["2026-11-09"]}),
            ("GET", "/api/field-logs/match/batches", None),
            ("POST", "/api/field-logs/match/undo", {"batch_id": "20261109-120000-abcd"}),
        ]
        for method, path, body in localhost_only_calls:
            resp = lan_tok.request(method, path, json=body) if body is not None else lan_tok.request(method, path)
            assert resp.status_code == 403, f"{method} {path} はトークン付きLANからでも403で拒否されるべき (got {resp.status_code})"
    finally:
        field_log_store.FIELD_LOGS_DIR = orig_logs_dir


def test_mobile_case_preflight_and_upload_security(tmp_path: Path):
    """スマホ内フォルダから母艦 Loome\\case\\YYYY-MM-DD への転送APIのLANトークン認証・重複スキップ・拡張子防御の検証"""
    from PIL import Image
    import server.storage_manager as sm_mod
    from server.database import close_thread_connection, initialize_database, switch_database_path

    lan_no_tok = _lan_client(with_cookie=False)
    assert lan_no_tok.post("/api/mobile/case-preflight", json={"items": []}).status_code == 401
    assert lan_no_tok.post("/api/mobile/case-upload?file_name=test.jpg", content=b"123").status_code == 401

    lan_tok = _lan_client(with_cookie=True)
    r_bad_ext = lan_tok.post("/api/mobile/case-upload?file_name=malware.exe", content=b"MZ...")
    assert r_bad_ext.status_code == 400

    orig_db = db_conn_mod.DB_PATH
    orig_storage_dir = sm_mod.STORAGE_DIR
    orig_loome_dir = sm_mod.LOOME_DIR
    orig_legacy_dir = sm_mod.LEGACY_STORAGE_DIR
    test_loome = tmp_path / "Loome"
    test_loome.mkdir(parents=True, exist_ok=True)
    sm_mod.LOOME_DIR = test_loome
    sm_mod.LEGACY_STORAGE_DIR = tmp_path / "legacy_storage_unused"
    sm_mod.STORAGE_DIR = test_loome
    switch_database_path(tmp_path / "case_sec_test.db")
    initialize_database()
    try:
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), color=(40, 120, 200)).save(buf, format="JPEG", quality=85)
        jpg_bytes = buf.getvalue()
        fname = f"IMG_CASE_SEC_{len(jpg_bytes)}.jpg"
        mod_ms = 1762743600000

        pre1 = lan_tok.post(
            "/api/mobile/case-preflight",
            json={"items": [{"client_id": "cid_1", "file_name": fname, "file_size": len(jpg_bytes), "last_modified_ms": mod_ms}]},
        )
        assert pre1.status_code == 200
        assert "cid_1" in pre1.json().get("upload_client_ids", [])

        up1 = lan_tok.post(
            f"/api/mobile/case-upload?file_name=../../{fname}&last_modified_ms={mod_ms}&rating=2&tags_json=%5B%22CaseTestTag%22%5D",
            content=jpg_bytes,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert up1.status_code == 200
        up1_data = up1.json()
        assert up1_data.get("ok") is True
        assert up1_data.get("status") == "imported"
        assert up1_data.get("rel_folder", "").startswith("case\\")
        saved_file = test_loome / up1_data["rel_path"].replace("\\", "/")
        assert saved_file.exists()

        pre2 = lan_tok.post(
            "/api/mobile/case-preflight",
            json={"items": [{"client_id": "cid_1", "file_name": fname, "file_size": len(jpg_bytes), "last_modified_ms": mod_ms}]},
        )
        assert pre2.status_code == 200
        assert "cid_1" in pre2.json().get("skipped_client_ids", [])
    finally:
        close_thread_connection()
        switch_database_path(orig_db)
        sm_mod.LOOME_DIR = orig_loome_dir
        sm_mod.LEGACY_STORAGE_DIR = orig_legacy_dir
        sm_mod.STORAGE_DIR = orig_storage_dir


def test_drive_by_null_origin_and_pna_blocked():
    """[SEC-1] 127.0.0.1 発でも Origin: null + PNA の無認証越境リクエストが全遮断され PNA 許可ヘッダも付与されないこと"""
    null_pna_headers = {
        "Origin": "null",
        "Access-Control-Request-Private-Network": "true",
        "Access-Control-Request-Method": "POST",
    }
    blocked_targets = [
        ("GET", "/api/mobile/locker-sync?mode=full"),
        ("GET", "/api/mobile/info?enable_lan=1"),
        ("GET", "/api/mobile/pair-info"),
        ("GET", "/api/mobile/discover"),
        ("POST", "/api/mobile/case-upload?file_name=evil.jpg"),
        ("POST", "/api/mobile/sync-import"),
    ]
    for method, target in blocked_targets:
        # OPTIONS プリフライト（トークン無し）は 403 で拒否され PNA 許可ヘッダも一切返さない
        r_opt = LOCAL.options(target, headers=null_pna_headers)
        assert r_opt.status_code == 403, f"OPTIONS {target} with Origin: null must be 403 (got {r_opt.status_code})"
        assert "access-control-allow-private-network" not in {k.lower() for k in r_opt.headers.keys()}

        # 実リクエスト（トークン無し）もループバック特権を与えず 403 で拒否される
        req_kwargs: Dict[str, Any] = {"headers": {"Origin": "null", "Access-Control-Request-Private-Network": "true"}}
        if method == "POST" and "sync-import" in target:
            req_kwargs["json"] = {"changes": []}
        elif method == "POST":
            req_kwargs["content"] = b"\xff\xd8\xff\xd9"
        r_act = LOCAL.request(method, target, **req_kwargs)
        assert r_act.status_code == 403, f"{method} {target} with Origin: null must be 403 (got {r_act.status_code})"
        assert "access-control-allow-private-network" not in {k.lower() for k in r_act.headers.keys()}

    # Cookie 単体（アンビエント認証）では Origin: null の /api/mobile/sync-import を通過できない
    cookie_local = TestClient(app, base_url="http://127.0.0.1:8088")
    cookie_local.cookies.set(LAN_TOKEN_COOKIE, LAN_TOKEN)
    r_cookie_only = cookie_local.post(
        "/api/mobile/sync-import",
        json={"changes": []},
        headers={"Origin": "null"},
    )
    assert r_cookie_only.status_code == 403

    # 正規の明示トークン提示時のみ単体HTML用の /api/mobile/sync-import が動作し、それでも PNA ヘッダは返さない
    r_valid_opt = LOCAL.options(
        f"/api/mobile/sync-import?t={LAN_TOKEN}",
        headers=null_pna_headers,
    )
    assert r_valid_opt.status_code == 204
    assert "access-control-allow-private-network" not in {k.lower() for k in r_valid_opt.headers.keys()}

    r_valid_sync = LOCAL.post(
        "/api/mobile/sync-import",
        json={"changes": []},
        headers={
            "Origin": "null",
            "X-Tetheract-Lan-Token": LAN_TOKEN,
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert r_valid_sync.status_code == 200
    assert "access-control-allow-private-network" not in {k.lower() for k in r_valid_sync.headers.keys()}

    # トークン提示があっても Origin: null から PCローカル自動検出ファイル読込 (use_detected_file) は 403 拒否
    r_detected = LOCAL.post(
        "/api/mobile/sync-import",
        json={"use_detected_file": True},
        headers={"Origin": "null", "X-Tetheract-Lan-Token": LAN_TOKEN},
    )
    assert r_detected.status_code == 403


def test_lan_one_time_ip_pairing_and_third_party_isolation():
    """[SEC-2] グローバル全IP開放廃止・指定IPワンタイム承認・第三者LAN IP遮断・無認証Cookie不交付を検証"""
    assert not hasattr(lan_access, "_pairing_window_until"), "グローバル _pairing_window_until は廃止済みであるべき"
    lan_access._approved_client_ips.clear()
    try:
        approved_client = TestClient(app, base_url="http://192.168.1.10:8088", client=("192.168.1.50", 51050))
        attacker_client = TestClient(app, base_url="http://192.168.1.10:8088", client=("192.168.1.99", 51099))

        # 1. enable_lan=1 単体では未認証LAN IPにトークンもAPIも開放されない
        r_info = LOCAL.get("/api/mobile/info?enable_lan=1")
        assert r_info.status_code == 200
        r_disc_pre = approved_client.get("/api/mobile/discover")
        assert r_disc_pre.status_code == 200
        assert r_disc_pre.json().get("pair_token") == ""
        r_unauth_api = approved_client.get("/api/photos")
        assert r_unauth_api.status_code == 401
        assert LAN_TOKEN_COOKIE not in r_unauth_api.headers.get("set-cookie", "")

        # 不正な client_ip（ワイルドカード・空文字・パブリックIP）での承認要求は 400 で拒否
        for bad_ip in ("", "*", "8.8.8.8"):
            assert LOCAL.post("/api/mobile/approve-pair", json={"client_ip": bad_ip}).status_code == 400

        # 2. 特定IP (192.168.1.50) を承認した状態での検証
        r_app = LOCAL.post("/api/mobile/approve-pair", json={"client_ip": "192.168.1.50"})
        assert r_app.status_code == 200

        # 第三者IP (192.168.1.99) は承認中であってもトークン取得・一般API通過・Cookie取得のいずれも不可
        r_att_disc = attacker_client.get("/api/mobile/discover")
        assert r_att_disc.status_code == 200
        assert r_att_disc.json().get("paired_match") is False
        assert r_att_disc.json().get("pair_token") == ""
        assert LAN_TOKEN_COOKIE not in r_att_disc.headers.get("set-cookie", "")
        r_att_m = attacker_client.get("/m")
        assert r_att_m.status_code == 401
        assert LAN_TOKEN_COOKIE not in r_att_m.headers.get("set-cookie", "")
        assert attacker_client.get("/api/mobile/locker-sync?mode=status").status_code == 401

        # 承認済みIP (192.168.1.50) であってもトークン未提示のまま一般APIを叩いた場合はミドルウェア通過せず Cookie も交付されない
        r_no_tok_m = approved_client.get("/m")
        assert r_no_tok_m.status_code == 401
        assert LAN_TOKEN_COOKIE not in r_no_tok_m.headers.get("set-cookie", "")

        # UDP 探索 (udp=1) には秘密トークンを含めず、かつワンタイム承認も消費しない
        r_udp = approved_client.get("/api/mobile/discover?udp=1")
        assert r_udp.status_code == 200
        assert r_udp.json().get("pair_token") == ""

        # 3. 承認された 192.168.1.50 が TCP discover で1回だけトークンを受け取り、直後にワンタイム失効する
        r_claim1 = approved_client.get("/api/mobile/discover")
        assert r_claim1.status_code == 200
        assert r_claim1.json().get("paired_match") is True
        claimed_token = r_claim1.json().get("pair_token")
        assert claimed_token == LAN_TOKEN
        assert LAN_TOKEN_COOKIE not in r_claim1.headers.get("set-cookie", "")

        # ワンタイム消費後の2回目無認証 discover では再取得できない
        r_claim2 = approved_client.get("/api/mobile/discover")
        assert r_claim2.status_code == 200
        assert r_claim2.json().get("paired_match") is False
        assert r_claim2.json().get("pair_token") == ""

        # 取得したトークンを明示提示すれば正常に LAN API 通信できる
        r_sync_ok = approved_client.get(
            "/api/mobile/locker-sync?mode=status",
            headers={"X-Tetheract-Lan-Token": claimed_token},
        )
        assert r_sync_ok.status_code == 200
        assert r_sync_ok.json().get("ok") is True
    finally:
        lan_access._approved_client_ips.clear()


def test_lan_bridge_oversized_unterminated_header_fail_closed():
    """[SEC-3] lan_bridge.py が \\r\\n\\r\\n 無しの32KB超データに対して上流未接続のまま 431 で即時切断すること"""
    import socket
    import threading
    from server import lan_bridge

    # 1. OS/WFP のループバック HTTP フィルタに左右されないソケットテストダブルで 431 と上流未接続を厳密検証
    class _FakeOversizedSocket:
        def __init__(self, payload: bytes) -> None:
            self._data = payload
            self._pos = 0
            self.sent = bytearray()
            self.shut_wr = False
            self.closed = False
            self.timeouts = []

        def settimeout(self, t: float) -> None:
            self.timeouts.append(t)

        def setsockopt(self, *args) -> None:
            pass

        def recv(self, size: int) -> bytes:
            if self._pos >= len(self._data):
                return b""
            end = min(len(self._data), self._pos + size)
            chunk = self._data[self._pos:end]
            self._pos = end
            return chunk

        def sendall(self, data: bytes) -> None:
            self.sent.extend(data)

        def shutdown(self, how: int) -> None:
            if how == socket.SHUT_WR:
                self.shut_wr = True

        def close(self) -> None:
            self.closed = True

    fake_sock = _FakeOversizedSocket(
        b"GET /api/photos HTTP/1.1\r\nX-Junk: " + (b"A" * (lan_bridge.MAX_HTTP_HEADER_BYTES + 4096))
    )
    with patch(
        "server.lan_bridge.socket.create_connection",
        side_effect=AssertionError("32KB超未完結ヘッダ時に上流 127.0.0.1 へ接続してはならない"),
    ) as mock_upstream:
        lan_bridge._handle_tcp_client(fake_sock, "192.168.1.77", 8088)
        assert mock_upstream.call_count == 0
    assert bytes(fake_sock.sent).startswith(b"HTTP/1.1 431 Request Header Fields Too Large")
    assert fake_sock.shut_wr is True
    assert fake_sock.closed is True

    # 2. 実ループバック socketpair 上でも TCP RST により 431 応答が消失しないことを検証（WFP非HTTPトラフィック）
    c_sock, s_sock = socket.socketpair()
    try:
        oversized_raw = b"X-JUNK-HDR " + (b"A" * (lan_bridge.MAX_HTTP_HEADER_BYTES + 4096))
        with patch(
            "server.lan_bridge.socket.create_connection",
            side_effect=AssertionError("32KB超未完結ヘッダ時に上流 127.0.0.1 へ接続してはならない"),
        ) as mock_upstream:
            t = threading.Thread(target=lan_bridge._handle_tcp_client, args=(s_sock, "192.168.1.77", 8088))
            t.start()
            c_sock.sendall(oversized_raw)
            c_sock.settimeout(3.0)
            resp_bytes = b""
            while True:
                try:
                    chunk = c_sock.recv(4096)
                except (ConnectionError, TimeoutError):
                    break
                if not chunk:
                    break
                resp_bytes += chunk
            t.join(timeout=3.0)
            assert not t.is_alive()
            assert mock_upstream.call_count == 0
        assert resp_bytes.startswith(b"HTTP/1.1 431 Request Header Fields Too Large"), f"Unexpected response: {resp_bytes[:80]!r}"
    finally:
        c_sock.close()
        s_sock.close()

    # LF単独改行や先頭空白を用いた偽装 X-Tetheract-Lan-Client ヘッダも除去・上書きされること
    spoofed = b"GET /api/photos HTTP/1.1\n  X-Tetheract-Lan-Client: 127.0.0.1\nHost: 192.168.1.10:8088"
    rewritten = lan_bridge._rewrite_http_request_header(spoofed, "192.168.1.88")
    assert b"127.0.0.1" not in rewritten
    assert b"X-Tetheract-Lan-Client: 192.168.1.88\r\n" in rewritten


def test_mobile_connection_status_and_raw_jpg_online_rules(tmp_path: Path):
    """[v2.2.2] /api/mobile/connection-status のLAN認証・ロック保護と、RAW+JPGペアのJPEG基準オンライン判定を検証"""
    from server import app as app_mod, scanner
    from server.database import get_connection

    assert is_lan_path_allowed("GET", "/api/mobile/connection-status") is True
    lan_no_tok = _lan_client(with_cookie=False)
    assert lan_no_tok.get("/api/mobile/connection-status").status_code == 401

    online_dir = tmp_path / "online_jpg"
    online_dir.mkdir(parents=True, exist_ok=True)
    online_jpg = online_dir / "IMG_1001.JPG"
    online_jpg.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9")

    offline_raw_dir = Path(r"Q:\DCIM\100RAW")
    offline_raw_path = offline_raw_dir / "IMG_1001.CR3"
    offline_solo_dir = Path(r"Q:\DCIM\100SOLO")
    offline_solo_path = offline_solo_dir / "IMG_2002.JPG"

    with get_connection() as conn:
        conn.execute("DELETE FROM photos")
        conn.execute("DELETE FROM photo_links")
        conn.execute(
            """
            INSERT INTO photos (
                id, file_path, file_name, directory_path, volume_serial, content_key,
                file_size, width, height, rating, is_raw, paired_raw_path, is_unlinked
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                101,
                str(online_jpg),
                "IMG_1001.JPG",
                str(online_dir),
                "",
                "CK_TEST_101",
                128,
                1600,
                1200,
                1,
                0,
                str(offline_raw_path),
            ),
        )
        conn.execute(
            """
            INSERT INTO photos (
                id, file_path, file_name, directory_path, volume_serial, content_key,
                file_size, width, height, rating, is_raw, paired_raw_path, is_unlinked
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                102,
                str(offline_raw_path),
                "IMG_1001.CR3",
                str(offline_raw_dir),
                "OFFLINE-RAW-VSN",
                "CK_TEST_102",
                256,
                1600,
                1200,
                0,
                1,
                str(online_jpg),
            ),
        )
        conn.execute(
            """
            INSERT INTO photos (
                id, file_path, file_name, directory_path, volume_serial, content_key,
                file_size, width, height, rating, is_raw, paired_raw_path, is_unlinked
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                103,
                str(offline_solo_path),
                "IMG_2002.JPG",
                str(offline_solo_dir),
                "OFFLINE-SOLO-VSN",
                "CK_TEST_103",
                128,
                1600,
                1200,
                0,
                0,
                "",
            ),
        )
        conn.commit()

    scanner.clear_online_cache()
    app_mod._API_PHOTOS_RESPONSE_CACHE.clear()

    # 1. トークン付きLANおよびLOCALから接続状態スナップショットを取得できること
    lan_ok = _lan_client(with_cookie=True)
    r_status = lan_ok.get("/api/mobile/connection-status")
    assert r_status.status_code == 200
    st = r_status.json()
    assert st["ok"] is True
    assert st["revision"]
    offline_set = set(st["ids"]) if st["mode"] == "offline_ids" else ({101, 102, 103} - set(st["ids"]))
    # JPEGがオンラインである101はオンライン、103は未接続ドライブのためオフライン
    assert 101 not in offline_set
    assert 102 not in offline_set
    assert 103 in offline_set

    # 2. /api/photos と /api/photo/{id} でも JPEG 基準でオンライン判定されること
    r_list = LOCAL.get("/api/photos?rating=all&limit=50")
    assert r_list.status_code == 200
    by_id = {p["id"]: p for p in r_list.json().get("photos", [])}
    assert by_id[101]["is_offline"] is False
    assert by_id[103]["is_offline"] is True

    r_jpg_detail = LOCAL.get("/api/photo/101")
    assert r_jpg_detail.status_code == 200
    assert r_jpg_detail.json()["is_offline"] is False
    assert r_jpg_detail.json()["paired_is_offline"] is True

    r_raw_detail = LOCAL.get("/api/photo/102")
    assert r_raw_detail.status_code == 200
    assert r_raw_detail.json()["is_offline"] is False
    assert r_raw_detail.json()["paired_is_offline"] is False

    # 3. 未接続ペアRAWを開く要求は404（例外クラッシュしない）
    r_open_raw = LOCAL.post("/api/photo/101/open-raw")
    assert r_open_raw.status_code == 404

    # 4. アプリロック時は 423 Locked で拒否すること
    with patch("server.security.is_app_locked", return_value=True):
        r_locked = lan_ok.get("/api/mobile/connection-status")
        assert r_locked.status_code == 423


def test_system_updater_localhost_only_and_diff_export(tmp_path: Path):
    """PC母艦アップデートAPIのlocalhost専用制限・開発保護ガード・ポータブルdiff.zip生成/検証をテスト"""
    lan_tok = _lan_client(with_cookie=True)
    for method, path in (
        ("GET", "/api/system/update-status"),
        ("GET", "/api/system/export-diff-zip"),
        ("POST", "/api/system/download-github-update"),
        ("POST", "/api/system/stage-diff-zip?file_name=test.zip"),
        ("POST", "/api/system/trigger-clean-update"),
    ):
        r_lan = lan_tok.request(method, path)
        assert r_lan.status_code == 403, f"{method} {path} はLANから拒否されるべき (actual={r_lan.status_code})"

    # localhost からのステータス確認
    r_st = LOCAL.get("/api/system/update-status?check_remote=0")
    assert r_st.status_code == 200
    st_json = r_st.json()
    assert st_json.get("ok") is True
    assert st_json.get("current_version")
    assert st_json.get("ui_revision")
    assert st_json.get("native_revision")
    assert st_json.get("is_dev_repository") is True

    # 開発リポジトリ環境では自己上書きアップデートを拒否
    r_trig = LOCAL.post("/api/system/trigger-clean-update")
    assert r_trig.status_code == 403

    # ポータブル差分ZIP (Tetheract_v*diff.zip) の生成・配信
    r_exp = LOCAL.get("/api/system/export-diff-zip")
    assert r_exp.status_code == 200
    zip_bytes = r_exp.content
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        names = set(zf.namelist())
        assert "VERSION" in names
        assert "frontend/index.html" in names
        assert "server/run.py" in names
        assert "android/tetheract_ui_bundle.zip" in names
        assert not any(n.startswith("cache/") or n.startswith("Loome/") or n.endswith(".loome_seal") for n in names)

    # 非公式URLからのダウンロードは拒否されること
    bad_dl = updater_mod.download_and_stage_github_diff_zip(
        download_url="https://evil.example.com/Tetheract_v9.9.9diff.zip",
        base_dir=tmp_path,
    )
    assert bad_dl.get("ok") is False

    # 有効な diff.zip のステージングと検索
    stage_ok = updater_mod.stage_uploaded_diff_zip("portable.zip", zip_bytes, base_dir=tmp_path)
    assert stage_ok.get("ok") is True
    found = updater_mod.find_staged_diff_zip(base_dir=tmp_path)
    assert found is not None and found.get("version") == stage_ok.get("version")

    # Zip Slip エントリを含む不正ZIPは拒否されること
    bad_buf = io.BytesIO()
    with zipfile.ZipFile(bad_buf, "w") as zf:
        zf.writestr("VERSION", "9.9.9\n")
        zf.writestr("server/run.py", "print('ok')\n")
        zf.writestr("frontend/index.html", "<html></html>")
        zf.writestr("../evil.txt", "pwned")
    stage_bad = updater_mod.stage_uploaded_diff_zip("evil.zip", bad_buf.getvalue(), base_dir=tmp_path)
    assert stage_bad.get("ok") is False

    # URL パストラバーサル (`..`) を含む GitHub Releases URL は拒否されること
    trav_dl = updater_mod.download_and_stage_github_diff_zip(
        download_url="https://github.com/zony0428/photo-manager/releases/download/../../evil/repo/releases/download/v1/Tetheract_v9.9.9diff.zip",
        base_dir=tmp_path,
    )
    assert trav_dl.get("ok") is False

    # 保護領域 (cache/library.db, .tetheract_instance) を上書きする ZIP は拒否されること
    for protected_entry in ("cache/library.db", ".tetheract_instance", "Loome/.loome_seal"):
        prot_buf = io.BytesIO()
        with zipfile.ZipFile(prot_buf, "w") as zf:
            zf.writestr("VERSION", "9.9.9\n")
            zf.writestr("server/run.py", "print('ok')\n")
            zf.writestr("frontend/index.html", "<html></html>")
            zf.writestr(protected_entry, "overwrite")
        res_prot = updater_mod.stage_uploaded_diff_zip("prot.zip", prot_buf.getvalue(), base_dir=tmp_path)
        assert res_prot.get("ok") is False, f"保護領域上書きZIPが拒否されていません: {protected_entry}"


def test_audit_hardening_boundaries(tmp_path: Path):
    """[v2.5.4 監査強化] take_out 境界・コンタクトシートXSS・保管庫外削除拒否・ロック中Loome承認遮断・ファイル名日時解析を検証"""
    from server import exporter as exporter_mod, scanner as scanner_mod, security as sec_mod
    from server.database import upsert_photo

    # 1. scanner.parse_filename_datetime パターン3 (YYMMDD_HHMMSS) で UnboundLocalError が起きないこと
    assert scanner_mod.parse_filename_datetime("141007_231845.JPG") == "2014-10-07 23:18:45"

    # 2. take_out サブフォルダ指定での ".." パストラバーサル拒否
    r_copy_trav = LOCAL.post("/api/import/copy", json={"photo_ids": [], "folder_name": ".."})
    assert r_copy_trav.status_code == 400
    r_open_trav = LOCAL.post("/api/import/open", json={"folder_name": ".."})
    assert r_open_trav.status_code == 400

    # 3. 外部元写真に対する delete_file=true が 403 拒否され実ファイルが無傷であること
    ext_dir = tmp_path / "external_orig"
    ext_dir.mkdir(parents=True, exist_ok=True)
    ext_img = ext_dir / "IMG_KEEP.JPG"
    from PIL import Image
    Image.new("RGB", (64, 48), (12, 34, 56)).save(ext_img, format="JPEG")
    pid = upsert_photo({
        "file_path": str(ext_img),
        "file_name": ext_img.name,
        "directory_path": str(ext_dir),
        "file_size": ext_img.stat().st_size,
        "date_taken": "2026-11-20 10:00:00",
    })
    r_del = LOCAL.delete(f"/api/photo/{pid}?delete_file=true")
    assert r_del.status_code == 403
    assert ext_img.is_file()

    # 4. コンタクトシート HTML 出力で </script> がエスケープされ Stored XSS にならないこと
    xss_img = ext_dir / "IMG_XSS_META.jpg"
    Image.new("RGB", (64, 48), (56, 34, 12)).save(xss_img, format="JPEG")
    pid_xss = upsert_photo({
        "file_path": str(xss_img),
        "file_name": xss_img.name,
        "directory_path": str(ext_dir),
        "file_size": xss_img.stat().st_size,
        "camera_model": "</script><script>alert(1)</script>",
        "date_taken": "2026-11-20 10:05:00",
    })
    cs_res = exporter_mod.run_contact_sheet_export({
        "photo_ids": [pid_xss],
        "destination_dir": str(tmp_path),
        "open_after": False,
        "title": "</script><script>alert(2)</script>",
    })
    assert cs_res.get("status") == "ok", f"Unexpected contact sheet result: {cs_res}"
    html_text = Path(cs_res["output_path"]).read_text(encoding="utf-8")
    assert "</script><script>alert(" not in html_text
    assert "\\u003c/script\\u003e" in html_text

    # 5. アプリロック中は /api/security/unlock-foreign-loome も 423 Locked で拒否されること
    with patch.object(sec_mod, "is_app_locked", return_value=True), \
         patch("server.routers.security_router.is_app_locked", return_value=True):
        r_fl = LOCAL.post("/api/security/unlock-foreign-loome", json={"volume_serial": "1234-5678", "password": "dummy"})
        assert r_fl.status_code == 423


class TestSecurityRegression(unittest.TestCase):
    """unittest discover からも上記のセキュリティ回帰テストを実行するためのラッパー"""

    def test_production_pbkdf2_iterations_constant(self):
        test_production_pbkdf2_iterations_constant()

    def test_local_access_ok(self):
        test_local_access_ok()

    def test_dns_rebinding_host_rejected(self):
        test_dns_rebinding_host_rejected()

    def test_foreign_origin_rejected(self):
        test_foreign_origin_rejected()

    def test_lan_host_origin_cannot_call_localhost_destructive_apis(self):
        test_lan_host_origin_cannot_call_localhost_destructive_apis()

    def test_same_origin_lan_mobile_requests_allowed(self):
        test_same_origin_lan_mobile_requests_allowed()

    def test_lan_requires_token(self):
        test_lan_requires_token()

    def test_lan_whitelist_blocks_admin_apis(self):
        test_lan_whitelist_blocks_admin_apis()

    def test_lan_whitelist_allows_mobile_apis(self):
        test_lan_whitelist_allows_mobile_apis()

    def test_xmp_size_limit(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_xmp_size_limit(Path(tmp_dir))

    def test_open_folder_rejects_files(self):
        test_open_folder_rejects_files()

    def test_three_tier_security_and_ethical_protection(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_three_tier_security_and_ethical_protection(Path(tmp_dir))

    def test_red_blue_team_failsafe_and_salvage(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_red_blue_team_failsafe_and_salvage(Path(tmp_dir))

    def test_android_bridge_blocks_arbitrary_sql_write(self):
        test_android_bridge_blocks_arbitrary_sql_write()

    def test_field_log_lan_and_token_security(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_field_log_lan_and_token_security(Path(tmp_dir))

    def test_mobile_case_preflight_and_upload_security(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_mobile_case_preflight_and_upload_security(Path(tmp_dir))

    def test_drive_by_null_origin_and_pna_blocked(self):
        test_drive_by_null_origin_and_pna_blocked()

    def test_lan_one_time_ip_pairing_and_third_party_isolation(self):
        test_lan_one_time_ip_pairing_and_third_party_isolation()

    def test_lan_bridge_oversized_unterminated_header_fail_closed(self):
        test_lan_bridge_oversized_unterminated_header_fail_closed()

    def test_mobile_connection_status_and_raw_jpg_online_rules(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_mobile_connection_status_and_raw_jpg_online_rules(Path(tmp_dir))

    def test_system_updater_localhost_only_and_diff_export(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_system_updater_localhost_only_and_diff_export(Path(tmp_dir))

    def test_audit_hardening_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            test_audit_hardening_boundaries(Path(tmp_dir))


if __name__ == "__main__":
    failures = 0
    setUpModule()
    try:
        for name, func in list(globals().items()):
            if name.startswith("test_") and callable(func):
                try:
                    if "tmp_path" in func.__code__.co_varnames[: func.__code__.co_argcount]:
                        with tempfile.TemporaryDirectory() as d:
                            func(Path(d))
                    else:
                        func()
                    print(f"[PASS] {name}")
                except Exception as e:
                    failures += 1
                    print(f"[FAIL] {name}: {e!r}")
    finally:
        tearDownModule()
    sys.exit(1 if failures else 0)
