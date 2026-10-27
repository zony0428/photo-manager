"""
LANアクセス制御モジュール

スマホ連携（/m）用のオンデマンドLAN待受に関するセキュリティ処理を集約する。
- Host ヘッダ検証（DNS Rebinding 対策）
- LAN経由リクエストのトークン認証（QRコードURLに埋め込み → Cookie化）
- LAN経由で許可するAPI・静的ファイルのホワイトリスト
- LAN待受（セカンダリUvicorn）の起動とアイドル時の自動停止
"""

import hmac
import ipaddress
import logging
import re
import secrets
import socket
import threading
import time
from typing import Dict, List, Optional

logger = logging.getLogger("photo_manager.lan_access")

# LAN接続用トークン（プロセス起動ごとに再生成。PC再起動後はQRコードの再読み取りが必要）
LAN_TOKEN: str = secrets.token_urlsafe(18)
LAN_TOKEN_COOKIE = "pm_lan_token"
LAN_TOKEN_QUERY = "t"

# 最後のLAN通信からこの秒数が経過したらLAN待受を自動停止する
LAN_IDLE_TIMEOUT_SEC = 30 * 60

# ループバック扱いするクライアントアドレス（TestClient の "testclient" を含む）
_LOOPBACK_CLIENTS = {"127.0.0.1", "::1", "localhost", "testclient"}

# Host ヘッダとして許可するホスト名（IPアドレスリテラルは別途許可）
_ALLOWED_HOSTNAMES = {"localhost"}

# LAN経由で許可する静的ファイル（完全一致・前方一致）
_LAN_STATIC_EXACT = {
    "/m",
    "/mobile.html",
    "/favicon.ico",
    "/manifest_mobile.json",
    "/css/mobile.css",
    "/js/mobile.js",
}
_LAN_STATIC_PREFIXES = ("/vendor/sqljs/", "/icons/")

# LAN経由で許可するAPI（メソッドごとの完全一致・正規表現）
_LAN_API_EXACT: Dict[str, set] = {
    "GET": {
        "/api/version",
        "/api/photos",
        "/api/tags",
        "/api/timeline",
        "/api/cameras",
        "/api/locations/tree",
        "/api/mobile/standalone",
    },
    "POST": {
        "/api/photos/batch-rate",
        "/api/photos/batch-tags",
        "/api/mobile/sync-import",
    },
}
_LAN_API_PATTERNS: Dict[str, List[re.Pattern]] = {
    "GET": [re.compile(r"^/api/photo/\d+/thumbnail$")],
    "POST": [
        re.compile(r"^/api/photo/\d+/rate$"),
        re.compile(r"^/api/photo/\d+/tags$"),
    ],
    "DELETE": [re.compile(r"^/api/photo/\d+/tags/.+$")],
}

# LAN最終通信時刻とLAN待受サーバーの管理
_last_lan_activity: float = 0.0
_lan_servers: Dict[str, object] = {}
_lan_lock = threading.Lock()
_watchdog_started = False


def is_loopback_client(client_host: Optional[str]) -> bool:
    """リクエスト元がPC自身（ループバック）かどうかを判定する"""
    if not client_host:
        return True
    if client_host in _LOOPBACK_CLIENTS:
        return True
    try:
        return ipaddress.ip_address(client_host).is_loopback
    except ValueError:
        return False


def is_host_header_allowed(host_header: Optional[str]) -> bool:
    """
    Host ヘッダを検証し、DNS Rebinding 攻撃（攻撃者ドメインを127.0.0.1へ再解決させる手法）を遮断する。
    localhost / IPアドレスリテラル（ポート付き可）のみ許可し、任意のドメイン名は拒否する。
    """
    if not host_header:
        return False
    host = host_header.strip()
    # IPv6 リテラル [::1]:8088 形式
    if host.startswith("["):
        end = host.find("]")
        if end == -1:
            return False
        hostname = host[1:end]
    else:
        hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    hostname = hostname.lower()
    if hostname in _ALLOWED_HOSTNAMES:
        return True
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        return False


def is_lan_path_allowed(method: str, path: str) -> bool:
    """LAN経由（スマホ等）のリクエストがホワイトリストに含まれるかを判定する"""
    method = method.upper()
    if method in ("GET", "HEAD"):
        if path in _LAN_STATIC_EXACT or path.startswith(_LAN_STATIC_PREFIXES):
            return True
    lookup_method = "GET" if method == "HEAD" else method
    if path in _LAN_API_EXACT.get(lookup_method, set()):
        return True
    return any(p.match(path) for p in _LAN_API_PATTERNS.get(lookup_method, []))


def is_lan_token_valid(cookie_token: Optional[str], query_token: Optional[str]) -> bool:
    """Cookie またはクエリパラメータのトークンが正しいかを定数時間比較で検証する"""
    for candidate in (cookie_token, query_token):
        if candidate and hmac.compare_digest(candidate, LAN_TOKEN):
            return True
    return False


def build_lan_cookie_header() -> str:
    """LANトークンを保持する Set-Cookie ヘッダ値を生成する（JSから読めない HttpOnly 属性付き）"""
    return f"{LAN_TOKEN_COOKIE}={LAN_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400"


def touch_lan_activity() -> None:
    """LAN経由の正規アクセスがあったことを記録する（アイドル自動停止の判定用）"""
    global _last_lan_activity
    _last_lan_activity = time.time()


def detect_local_ip_addresses() -> List[str]:
    """PC自身のLAN内IPv4アドレス一覧を検出する（外部パブリックIPへの通信を発生させずプライベートアドレスのルーティング表を参照）"""
    ips: List[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.2)
            s.connect(("10.255.255.255", 80))
            primary_ip = s.getsockname()[0]
            if primary_ip and not primary_ip.startswith("127."):
                ips.append(primary_ip)
    except Exception as e:
        logger.debug(f"プライマリLAN IP検出スキップ: {e}")

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and not ip.startswith("169.254.") and ip not in ips:
                ips.append(ip)
    except Exception as e:
        logger.debug(f"ホスト名からのLAN IP列挙スキップ: {e}")

    return ips


def _stop_idle_lan_servers_loop() -> None:
    """一定時間LAN通信が無い場合にLAN待受サーバーを停止する監視ループ"""
    while True:
        time.sleep(60)
        with _lan_lock:
            if not _lan_servers:
                continue
            if time.time() - _last_lan_activity < LAN_IDLE_TIMEOUT_SEC:
                continue
            for key, srv in list(_lan_servers.items()):
                try:
                    srv.should_exit = True
                    logger.info(f"[Mobile LAN] 無通信のためLAN待受を停止しました: {key}")
                except Exception as e:
                    logger.warning(f"[Mobile LAN] LAN待受の停止に失敗 ({key}): {e}")
            _lan_servers.clear()


def ensure_lan_listeners(app, port: int = 8088) -> List[str]:
    """
    スマホ連携モーダルを開いた際、オンデマンドでPCのLAN IPアドレス (192.168.x.x等) に
    セカンダリUvicornリスナーを起動する。
    普段は 127.0.0.1 のみで動作するため、ファイアウォール警告やパブリックWi-Fiでのポート露出を回避する。
    無通信が LAN_IDLE_TIMEOUT_SEC 続くと自動停止し、次回モーダル表示時に再起動する。
    """
    global _watchdog_started
    import uvicorn

    ips = detect_local_ip_addresses()
    with _lan_lock:
        # 起動直後にアイドル判定されないよう、待受開始時点を最終通信時刻とみなす
        touch_lan_activity()

        if not _watchdog_started:
            threading.Thread(target=_stop_idle_lan_servers_loop, daemon=True, name="MobileLanWatchdog").start()
            _watchdog_started = True

        for ip in ips:
            key = f"{ip}:{port}"
            if key in _lan_servers:
                continue
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.2)
                if s.connect_ex((ip, port)) == 0:
                    # 既に別サーバーが待受中（停止処理中など）の場合は今回は起動しない
                    continue

            cfg = uvicorn.Config(app, host=ip, port=port, log_level="warning")
            srv = uvicorn.Server(cfg)

            def _run(server=srv, bind_key=key):
                try:
                    logger.info(f"[Mobile LAN] スマホ連携用オンデマンドLAN待受を開始しました: http://{bind_key}/m")
                    server.run()
                except Exception as e:
                    logger.warning(f"[Mobile LAN] LAN待受の起動をスキップ ({bind_key}): {e}")
                finally:
                    with _lan_lock:
                        if _lan_servers.get(bind_key) is server:
                            _lan_servers.pop(bind_key, None)

            threading.Thread(target=_run, daemon=True, name=f"MobileLanListener-{ip}").start()
            _lan_servers[key] = srv

    return ips
