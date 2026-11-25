"""
LANアクセス制御モジュール

スマホ連携（/m および Android専用ロッカーWi-Fi同期）用のLAN待受・認証処理を集約する。
- Host ヘッダ検証（DNS Rebinding 対策）
- 永続ペアリングトークン＆長期Cookie認証（初回QRペアリング後はPC再起動後もQR再表示不要）
- LAN経由で許可するAPI・静的ファイルのホワイトリスト
- ペアリング済み環境での自動LAN待受とトークン再発行（ペアリング解除）
"""

import hmac
import ipaddress
import json
import logging
import re
import secrets
import socket
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .lan_bridge import _serve_tcp_ip, _serve_udp_discovery

logger = logging.getLogger("photo_manager.lan_access")

_BASE_DIR = Path(__file__).resolve().parent.parent
_LAN_AUTH_FILE = _BASE_DIR / "cache" / ".mobile_lan_auth.json"

LAN_TOKEN_COOKIE = "pm_lan_token"
LAN_TOKEN_QUERY = "t"
LAN_TOKEN_HEADER = "x-tetheract-lan-token"
LAN_CLIENT_HEADER = "x-tetheract-lan-client"
# ブラウザおよびアプリ用のペアリングCookie有効期間（365日）
LAN_COOKIE_MAX_AGE = 365 * 24 * 3600

# PC画面承認時の指定IPワンタイムペアリング有効期間（既定90秒・上限120秒）
PAIRING_APPROVAL_TTL_SEC = 90
PAIRING_APPROVAL_MAX_TTL_SEC = 120

# 未ペアリング状態で一時的にQR画面を開いた場合のアイドル自動停止秒数（30分）
LAN_IDLE_TIMEOUT_SEC = 30 * 60


def _load_or_init_lan_auth() -> dict:
    """cache/.mobile_lan_auth.json から永続ペアリングトークンを読み込む（無ければ新規作成）"""
    try:
        if _LAN_AUTH_FILE.exists():
            data = json.loads(_LAN_AUTH_FILE.read_text(encoding="utf-8"))
            tok = str(data.get("token") or "").strip()
            if len(tok) >= 16:
                return {
                    "token": tok,
                    "paired": bool(data.get("paired", True)),
                }
    except Exception as e:
        logger.debug(f"LAN認証設定ファイルの読込スキップ: {e}")

    new_state = {
        "token": secrets.token_urlsafe(24),
        "paired": False,
    }
    _save_lan_auth(new_state)
    return new_state


def _save_lan_auth(state: dict) -> None:
    try:
        _LAN_AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
        _LAN_AUTH_FILE.write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        logger.debug(f"LAN認証設定ファイルの保存スキップ: {e}")


_auth_state = _load_or_init_lan_auth()
LAN_TOKEN: str = _auth_state["token"]
_lan_paired: bool = bool(_auth_state.get("paired", False))


def get_lan_token() -> str:
    """現在有効な永続LANペアリングトークンを返す"""
    return LAN_TOKEN


def is_lan_device_paired() -> bool:
    """スマホとの常時Wi-Fi同期（PC起動時の自動LAN待受）が有効かどうかを返す"""
    return _lan_paired


def mark_lan_device_paired(enabled: bool = True) -> None:
    """スマホ連携が利用されたことを記録し、次回PC起動時も自動でLAN待受を開始する"""
    global _lan_paired
    if _lan_paired != enabled:
        _lan_paired = enabled
        _save_lan_auth({"token": LAN_TOKEN, "paired": _lan_paired})


def reset_lan_pairing() -> str:
    """ペアリングトークンを再発行し、既存のスマホCookie・ペアリング承認状態をすべて無効化する"""
    global LAN_TOKEN, _lan_paired
    with _pairing_lock:
        _approved_client_ips.clear()
    LAN_TOKEN = secrets.token_urlsafe(24)
    _lan_paired = True
    _save_lan_auth({"token": LAN_TOKEN, "paired": _lan_paired})
    return LAN_TOKEN


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
    "/css/touch-responsive.css",
    "/css/touch-fieldlog.css",
    "/js/mobile.js",
}
_LAN_STATIC_PREFIXES = (
    "/vendor/sqljs/",
    "/icons/",
    "/js/core/",
    "/js/adapters/",
    "/js/views/",
)

# LAN経由で許可するAPI（メソッドごとの完全一致・正規表現）
_LAN_API_EXACT: Dict[str, set] = {
    "GET": {
        "/api/version",
        "/api/photos",
        "/api/tags",
        "/api/timeline",
        "/api/cameras",
        "/api/folders",
        "/api/filter-presets",
        "/api/locations/tree",
        "/api/mobile/standalone",
        "/api/mobile/apk",
        "/api/mobile/pair-info",
        "/api/mobile/locker-sync",
        "/api/mobile/discover",
        "/api/mobile/connection-status",
        "/api/mobile/ui-bundle",
        "/api/watermarks",
    },
    "POST": {
        "/api/photos/batch-rate",
        "/api/photos/batch-tags",
        "/api/mobile/sync-import",
        "/api/mobile/field-logs",
        "/api/mobile/case-preflight",
        "/api/mobile/case-upload",
    },
}
# トークン未所持のLAN端末がPC母艦の存在確認・ペアリング要求を行うための公開ディスカバリパス
_LAN_PUBLIC_DISCOVERY_PATHS = {"/api/mobile/discover"}
_LAN_API_PATTERNS: Dict[str, List[re.Pattern]] = {
    "GET": [
        re.compile(r"^/api/photo/\d+/thumbnail$"),
        re.compile(r"^/api/photo/\d+/view$"),
        re.compile(r"^/api/watermarks/[A-Za-z0-9_-]+/image$"),
    ],
    "POST": [
        re.compile(r"^/api/photo/\d+/rate$"),
        re.compile(r"^/api/photo/\d+/tags$"),
        re.compile(r"^/api/photo/\d+/set-primary$"),
        re.compile(r"^/api/photo/\d+/adjustments$"),
    ],
    "DELETE": [re.compile(r"^/api/photo/\d+/tags/.+$")],
}

# LAN最終通信時刻とLAN待受スレッド・指定IPワンタイムペアリング承認の管理
_last_lan_activity: float = 0.0
_lan_servers: Dict[str, object] = {}
_lan_lock = threading.Lock()
_pairing_lock = threading.Lock()
_udp_responder_started = False
_approved_client_ips: Dict[str, float] = {}


def is_lan_public_discovery_path(path: str) -> bool:
    """トークン未所持のLAN端末からのディスカバリ・ペアリング要求パスかどうかを返す"""
    return path in _LAN_PUBLIC_DISCOVERY_PATHS


def normalize_lan_client_ip(client_ip: Optional[str]) -> Optional[str]:
    """クライアントIP文字列を正規化し、プライベートIPまたはループバックIPのみ有効文字列として返す"""
    if not client_ip:
        return None
    raw = str(client_ip).strip()
    if not raw or raw == "*":
        return None
    if "%" in raw:
        raw = raw.split("%", 1)[0]
    try:
        ip_obj = ipaddress.ip_address(raw)
        if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped is not None:
            ip_obj = ip_obj.ipv4_mapped
        if ip_obj.is_unspecified or ip_obj.is_multicast:
            return None
        if not (ip_obj.is_private or ip_obj.is_loopback):
            return None
        return str(ip_obj)
    except ValueError:
        return None


def _prune_expired_approved_ips_locked(now: float) -> None:
    """期限切れの承認済みIPエントリを除去する（_pairing_lock 保持下で呼ぶこと）"""
    expired = [ip for ip, exp in _approved_client_ips.items() if exp <= now]
    for ip in expired:
        _approved_client_ips.pop(ip, None)


def approve_lan_pairing_ip(
    client_ip: Optional[str],
    duration_sec: int = PAIRING_APPROVAL_TTL_SEC,
) -> Optional[str]:
    """PC側で承認された特定の正規化済みLANクライアントIPのみを短時間・ワンタイム許可する"""
    norm_ip = normalize_lan_client_ip(client_ip)
    if not norm_ip:
        return None
    ttl = min(max(10, int(duration_sec)), PAIRING_APPROVAL_MAX_TTL_SEC)
    now = time.time()
    with _pairing_lock:
        _prune_expired_approved_ips_locked(now)
        _approved_client_ips[norm_ip] = now + ttl
    return norm_ip


def open_lan_pairing_window(
    duration_sec: int = PAIRING_APPROVAL_TTL_SEC,
    client_ip: Optional[str] = None,
) -> Optional[str]:
    """指定されたLANクライアントIPのみワンタイムペアリング承認を登録する（全IP開放は行わない）"""
    return approve_lan_pairing_ip(client_ip, duration_sec=duration_sec)


def is_lan_pairing_approved_for(client_ip: Optional[str]) -> bool:
    """指定されたLANクライアントIPに対して未消費のワンタイムペアリング承認が存在するか判定する"""
    norm_ip = normalize_lan_client_ip(client_ip)
    if not norm_ip:
        return False
    now = time.time()
    with _pairing_lock:
        _prune_expired_approved_ips_locked(now)
        return norm_ip in _approved_client_ips


def consume_lan_pairing_approval(client_ip: Optional[str]) -> bool:
    """指定されたLANクライアントIPのペアリング承認を検証し、一致時はワンタイム消費（即時失効）する"""
    norm_ip = normalize_lan_client_ip(client_ip)
    if not norm_ip:
        return False
    now = time.time()
    with _pairing_lock:
        _prune_expired_approved_ips_locked(now)
        if norm_ip in _approved_client_ips:
            _approved_client_ips.pop(norm_ip, None)
            return True
    return False


def is_loopback_client(client_host: Optional[str]) -> bool:
    """リクエスト元がPC自身（ループバック）かどうかを判定する"""
    if not client_host:
        return True
    if client_host in _LOOPBACK_CLIENTS:
        return True
    try:
        ip_obj = ipaddress.ip_address(client_host)
        if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped is not None:
            ip_obj = ip_obj.ipv4_mapped
        return ip_obj.is_loopback
    except ValueError:
        return False


def resolve_request_client_host(request: Any) -> str:
    """
    リクエスト元の実質クライアントIPを返す。
    同一プロセス内のLAN TCP中継スレッド経由で 127.0.0.1 のメインUvicornへ渡された接続では、
    付与された X-Tetheract-Lan-Client ヘッダを優先してLANクライアントIPとして扱う。
    """
    raw_host = request.client.host if getattr(request, "client", None) else "127.0.0.1"
    if is_loopback_client(raw_host):
        headers = getattr(request, "headers", None)
        if headers is not None:
            forwarded = (headers.get(LAN_CLIENT_HEADER) or "").strip()
            if forwarded and not is_loopback_client(forwarded):
                return normalize_lan_client_ip(forwarded) or forwarded
    return normalize_lan_client_ip(raw_host) or raw_host


def is_host_header_allowed(host_header: Optional[str]) -> bool:
    """
    Host ヘッダを検証し、DNS Rebinding 攻撃（攻撃者ドメインを127.0.0.1へ再解決させる手法）を遮断する。
    localhost / IPアドレスリテラル（ポート付き可）のみ許可し、任意のドメイン名は拒否する。
    """
    if not host_header:
        return False
    host = host_header.strip()
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
    if method == "OPTIONS":
        return any(is_lan_path_allowed(m, path) for m in ("GET", "POST", "DELETE"))
    if method in ("GET", "HEAD"):
        if path in _LAN_STATIC_EXACT or path.startswith(_LAN_STATIC_PREFIXES):
            return True
    lookup_method = "GET" if method == "HEAD" else method
    if path in _LAN_API_EXACT.get(lookup_method, set()):
        return True
    return any(p.match(path) for p in _LAN_API_PATTERNS.get(lookup_method, []))


def extract_explicit_lan_token(request: Any) -> str:
    """Cookieを除く明示提示されたLANトークン（ヘッダまたはクエリ ?t=）を取得する"""
    headers = getattr(request, "headers", None)
    if headers is not None:
        hdr_tok = (headers.get(LAN_TOKEN_HEADER) or "").strip()
        if hdr_tok:
            return hdr_tok
        auth_hdr = (headers.get("authorization") or "").strip()
        if auth_hdr.lower().startswith("bearer "):
            bearer_tok = auth_hdr[7:].strip()
            if bearer_tok:
                return bearer_tok
    query_params = getattr(request, "query_params", None)
    if query_params is not None:
        q_tok = (query_params.get(LAN_TOKEN_QUERY) or "").strip()
        if q_tok:
            return q_tok
    return ""


def is_lan_token_valid(
    cookie_token: Optional[str],
    query_token: Optional[str],
    header_token: Optional[str] = None,
) -> bool:
    """Cookie・クエリパラメータ・明示ヘッダのトークンが正しいかを定数時間比較で検証する"""
    current_tok = get_lan_token()
    for candidate in (cookie_token, query_token, header_token):
        if candidate and hmac.compare_digest(candidate, current_tok):
            return True
    return False


def build_lan_cookie_header() -> str:
    """LANペアリングトークンを365日間保持する Set-Cookie ヘッダ値を生成する"""
    return f"{LAN_TOKEN_COOKIE}={get_lan_token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age={LAN_COOKIE_MAX_AGE}"


def touch_lan_activity() -> None:
    """LAN経由の正規アクセスがあったことを記録し、永続ペアリングを有効化する"""
    global _last_lan_activity
    _last_lan_activity = time.time()
    mark_lan_device_paired(True)


def detect_local_ip_addresses() -> List[str]:
    """PC自身のLAN内IPv4アドレス一覧を検出する"""
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


def ensure_lan_listeners(app, port: int = 8088) -> List[str]:
    """
    PCのLAN IPアドレス (192.168.x.x等) に軽量ソケット中継スレッドを起動し、
    単一のメインUvicorn (127.0.0.1:port) へ安全に転送する。
    （※2つ目のUvicornインスタンスを別スレッドで起動するとasyncio ProactorEventLoopが競合して
      スマホブラウザの通信がハングアップする問題を根本回避する。外部ドライブやCドライブへのファイル配置も一切不要）
    """
    global _udp_responder_started

    ips = detect_local_ip_addresses()
    primary_ip = ips[0] if ips else "127.0.0.1"
    with _lan_lock:
        globals()["_last_lan_activity"] = time.time()

        if not _udp_responder_started:
            threading.Thread(
                target=_serve_udp_discovery,
                args=(port, primary_ip),
                daemon=True,
                name="MobileUdpDiscovery",
            ).start()
            _udp_responder_started = True

        for ip in ips:
            key = f"{ip}:{port}"
            if key in _lan_servers:
                continue
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.2)
                if s.connect_ex((ip, port)) == 0:
                    _lan_servers[key] = True
                    continue

            t = threading.Thread(
                target=_serve_tcp_ip,
                args=(ip, port),
                daemon=True,
                name=f"MobileLanBridge-{ip}",
            )
            t.start()
            _lan_servers[key] = t
            logger.info(f"[Mobile LAN] スマホ連携用LAN待受を開始しました: http://{key}/m")

    return ips
