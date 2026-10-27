"""
セキュリティ回帰テスト（Host検証・Origin検証・LANトークン認証・LANホワイトリスト・XMPサイズ上限）
実行: python\\python.exe -m pytest tests -q  または  python\\python.exe tests\\test_security.py
"""

import sys
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
        ("DELETE", "/api/tags/foo"),
        ("POST", "/api/photo/1/adjust"),
        ("POST", "/api/photo/1/open-file"),
        ("GET", "/api/browse"),
        ("GET", "/api/photo/1/view"),
        ("GET", "/api/mobile/info"),
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


if __name__ == "__main__":
    import tempfile

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
