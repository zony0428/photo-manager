"""
セキュリティ回帰テスト（Host検証・Origin検証・LANトークン認証・LANホワイトリスト・XMPサイズ上限）
実行: python\\python.exe -m unittest discover -s tests -p "test_*.py"  または  python\\python.exe tests\\test_security.py
（同梱 Python に pytest は無いため、末尾の unittest ラッパー経由で discover からも実行される）
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app  # noqa: E402
from server.lan_access import LAN_TOKEN, LAN_TOKEN_COOKIE, is_host_header_allowed, is_lan_path_allowed  # noqa: E402

LOCAL = TestClient(app, base_url="http://127.0.0.1:8088")
LAN_IP = "192.168.1.50"


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
        ("POST", "/api/volumes/DEADBEEF/loome"),
        ("DELETE", "/api/volumes/DEADBEEF/loome"),
        ("DELETE", "/api/tags/foo"),
        ("POST", "/api/photo/1/adjust"),
        ("POST", "/api/photo/1/open-file"),
        ("GET", "/api/browse"),
        ("GET", "/api/photo/1/view"),
        ("GET", "/api/mobile/info"),
        ("POST", "/api/media/check"),
        ("GET", "/api/media/events"),
        ("POST", "/api/photos/check-external-updates"),
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
        ("POST", "/api/photo/12/rate"),
        ("POST", "/api/photos/batch-rate"),
        ("POST", "/api/photo/12/tags"),
        ("DELETE", "/api/photo/12/tags/%E7%8C%AB"),
        ("POST", "/api/mobile/sync-import"),
    ]
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
        set_instance_file_for_test(None)
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
        DB_PATH,
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

    orig_db = DB_PATH
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
        # 放り込まれた場合でも、初回起動時に別環境DBとして検知され db_foreign_locked = True になること
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

    finally:
        close_thread_connection()
        set_instance_file_for_test(None)
        switch_database_path(orig_db)
        initialize_security_state(force_reload=True)


class TestSecurityRegression(unittest.TestCase):
    """unittest discover からも上記のセキュリティ回帰テストを実行するためのラッパー"""

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


if __name__ == "__main__":
    failures = 0
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
    sys.exit(1 if failures else 0)
