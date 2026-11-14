"""
リムーバブルドライブ（USBメモリ・外付けSSD等）起動時の Windows Defender ファイアウォール遮断を回避する
システムドライブ(C:)常駐型 LAN TCP/UDP ブリッジプロセス。

背景:
Windows Filtering Platform (WFP) はファイアウォール許可ルールを NT デバイスパス
(\\Device\\HarddiskVolumeX\\...) で照合する。USB ドライブを抜き差ししてスマホと往復すると
HarddiskVolume 番号が変化し、既存の許可ルールが不一致となってプロンプトすら出ないまま
LAN からの TCP/UDP パケットがサイレント破棄される。
本スクリプトを固定システムドライブ(C:)上の Python 実行ファイルから起動して
LAN IP:8088 (TCP) および 0.0.0.0:8088 (UDP) を待受し、127.0.0.1:8088 の本体サーバーへ中継する。
"""

import argparse
import ctypes
import ipaddress
import json
import logging
import os
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from typing import List

logger = logging.getLogger("photo_manager.lan_bridge")

MAX_HTTP_HEADER_BYTES = 32768
_HTTP_431_RESPONSE = (
    b"HTTP/1.1 431 Request Header Fields Too Large\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"Content-Length: 31\r\n"
    b"Connection: close\r\n"
    b"\r\n"
    b"Request Header Fields Too Large"
)


def _is_parent_alive(parent_pid: int) -> bool:
    """親プロセスが 생존しているかを確認する"""
    if parent_pid <= 0:
        return True
    if sys.platform == "win32":
        try:
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, int(parent_pid)
            )
            if not handle:
                return False
            try:
                exit_code = ctypes.c_ulong(0)
                ok = ctypes.windll.kernel32.GetExitCodeProcess(
                    handle, ctypes.byref(exit_code)
                )
                return bool(ok and exit_code.value == STILL_ACTIVE)
            finally:
                ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            return True
    else:
        try:
            os.kill(parent_pid, 0)
            return True
        except OSError:
            return False


def _watch_parent_loop(parent_pid: int) -> None:
    """親プロセス終了時にブリッジプロセスも自動終了する監視ループ"""
    while True:
        time.sleep(2.0)
        if not _is_parent_alive(parent_pid):
            os._exit(0)


def _rewrite_http_request_header(raw_header: bytes, remote_ip: str) -> bytes:
    """
    HTTPリクエストヘッダ先頭に X-Tetheract-Lan-Client と Connection: close を注入し、
    クライアント側からの偽装ヘッダ（LF単独改行・先頭空白混入を含む）を完全除去する。
    """
    normalized = raw_header.replace(b"\r\n", b"\n")
    lines = normalized.split(b"\n")
    if not lines or not lines[0]:
        return raw_header
    clean_ip = "".join(ch for ch in str(remote_ip) if ch not in "\r\n")
    out_lines = [
        lines[0],
        f"X-Tetheract-Lan-Client: {clean_ip}".encode("ascii", errors="ignore"),
        b"Connection: close",
    ]
    for line in lines[1:]:
        low = line.lstrip().lower()
        if low.startswith((b"x-tetheract-lan-client:", b"connection:")):
            continue
        out_lines.append(line)
    return b"\r\n".join(out_lines)


def _handle_tcp_client(client_sock: socket.socket, remote_ip: str, target_port: int) -> None:
    """1つのLAN TCP接続を検証した上で 127.0.0.1:target_port へ双方向中継する（未完結・32KB超ヘッダはフェイルクローズ切断）"""
    upstream_sock = None
    try:
        client_sock.settimeout(120.0)
        try:
            client_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception as e:
            logger.debug(f"TCP_NODELAY設定スキップ (client): {e}")

        # 初回HTTPリクエストヘッダ (最大32KB) を読み取る
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < MAX_HTTP_HEADER_BYTES:
            chunk = client_sock.recv(8192)
            if not chunk:
                break
            buf += chunk

        if not buf:
            return

        hdr_end = buf.find(b"\r\n\r\n")
        if hdr_end == -1 or hdr_end >= MAX_HTTP_HEADER_BYTES:
            # 32KB上限到達時に \r\n\r\n 未検出（またはヘッダ部が32KB以上）の場合は上流へ一切接続せず 431 で即時切断する
            if len(buf) >= MAX_HTTP_HEADER_BYTES or hdr_end >= MAX_HTTP_HEADER_BYTES:
                try:
                    client_sock.sendall(_HTTP_431_RESPONSE)
                    client_sock.shutdown(socket.SHUT_WR)
                except Exception as send_err:
                    logger.debug(f"431応答送信スキップ: {send_err}")
            return

        hdr_part = buf[:hdr_end]
        body_part = buf[hdr_end + 4 :]
        rewritten = _rewrite_http_request_header(hdr_part, remote_ip) + b"\r\n\r\n" + body_part

        upstream_sock = socket.create_connection(("127.0.0.1", target_port), timeout=10.0)
        upstream_sock.settimeout(180.0)
        try:
            upstream_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception as e:
            logger.debug(f"TCP_NODELAY設定スキップ (upstream): {e}")

        upstream_sock.sendall(rewritten)

        def _forward_client_body():
            try:
                while True:
                    data = client_sock.recv(65536)
                    if not data:
                        break
                    upstream_sock.sendall(data)
            except Exception as fwd_err:
                logger.debug(f"クライアントボディ中継終了: {fwd_err}")

        threading.Thread(target=_forward_client_body, daemon=True).start()

        while True:
            resp_chunk = upstream_sock.recv(65536)
            if not resp_chunk:
                break
            client_sock.sendall(resp_chunk)
        try:
            client_sock.shutdown(socket.SHUT_WR)
        except Exception as shut_err:
            logger.debug(f"クライアントソケットshutdownスキップ: {shut_err}")
    except Exception as conn_err:
        logger.debug(f"LAN TCP中継クローズ ({remote_ip}): {conn_err}")
    finally:
        for s in (upstream_sock, client_sock):
            if s is not None:
                try:
                    s.close()
                except Exception as close_err:
                    logger.debug(f"ソケットcloseスキップ: {close_err}")


def _serve_tcp_ip(bind_ip: str, port: int) -> None:
    """指定されたLAN IPアドレスでTCP待受し、接続ごとに中継スレッドを起動する"""
    srv = None
    try:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((bind_ip, port))
        srv.listen(128)
        while True:
            try:
                client_sock, client_addr = srv.accept()
                remote_ip = client_addr[0]
                threading.Thread(
                    target=_handle_tcp_client,
                    args=(client_sock, remote_ip, port),
                    daemon=True,
                ).start()
            except Exception as acc_err:
                logger.debug(f"LAN TCP accept待機リトライ: {acc_err}")
                time.sleep(0.05)
    except Exception as srv_err:
        logger.debug(f"LAN TCP待受終了 ({bind_ip}:{port}): {srv_err}")
    finally:
        if srv is not None:
            try:
                srv.close()
            except Exception as close_err:
                logger.debug(f"TCPサーバーcloseスキップ: {close_err}")


def _serve_udp_discovery(port: int, primary_ip: str) -> None:
    """UDP 0.0.0.0:port で Android からの TETHERACT_DISCOVER_V1 を受け、秘密トークンを含めず母艦情報のみ即答する"""
    sock = None
    hostname = socket.gethostname()
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", port))
        while True:
            try:
                data, addr = sock.recvfrom(1024)
                sender_ip = addr[0]
                try:
                    ip_obj = ipaddress.ip_address(sender_ip)
                    if not (ip_obj.is_private or ip_obj.is_loopback):
                        continue
                except ValueError:
                    continue

                text = data.decode("utf-8", errors="ignore").strip()
                if not text.startswith("TETHERACT_DISCOVER_V1"):
                    continue

                parts = text.split("|", 1)
                client_tok = parts[1].strip() if len(parts) > 1 else ""
                q_tok = urllib.parse.quote(client_tok, safe="")
                req_url = f"http://127.0.0.1:{port}/api/mobile/discover?t={q_tok}&udp=1"
                req = urllib.request.Request(
                    req_url,
                    headers={
                        "X-Tetheract-Lan-Client": sender_ip,
                        "Host": f"{primary_ip}:{port}",
                    },
                    method="GET",
                )
                with urllib.request.urlopen(req, timeout=1.5) as resp:
                    body = json.loads(resp.read().decode("utf-8", errors="ignore"))

                # UDPは送信元IP詐称・盗聴リスクがあるため、秘密トークン(pair_token)は絶対に含めない
                udp_resp = {
                    "ok": True,
                    "service": "tetheract-pm",
                    "library_id": body.get("library_id") or "",
                    "hostname": body.get("hostname") or hostname,
                    "port": port,
                    "paired_match": bool(body.get("paired_match")),
                    "pair_token": "",
                }
                sock.sendto(json.dumps(udp_resp).encode("utf-8"), addr)
            except Exception as pkt_err:
                logger.debug(f"UDPディスカバリ応答スキップ: {pkt_err}")
    except Exception as udp_err:
        logger.debug(f"UDPディスカバリ待受終了 (port={port}): {udp_err}")
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception as close_err:
                logger.debug(f"UDPソケットcloseスキップ: {close_err}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Tetheract LAN TCP/UDP Bridge")
    parser.add_argument("--port", type=int, default=8088)
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--ips", type=str, default="")
    args = parser.parse_args()

    if args.parent_pid > 0:
        threading.Thread(
            target=_watch_parent_loop, args=(args.parent_pid,), daemon=True
        ).start()

    ips: List[str] = [
        ip.strip() for ip in (args.ips or "").split(",") if ip.strip()
    ]
    primary_ip = ips[0] if ips else "127.0.0.1"

    threading.Thread(
        target=_serve_udp_discovery, args=(args.port, primary_ip), daemon=True
    ).start()

    for ip in ips:
        threading.Thread(
            target=_serve_tcp_ip, args=(ip, args.port), daemon=True
        ).start()

    while True:
        time.sleep(10.0)


if __name__ == "__main__":
    main()
