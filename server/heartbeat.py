"""
Photo Manager ハートビート監視 & 自動シャットダウンモジュール
ブラウザからの定期的なハートビート通信を監視し、
全ブラウザタブが閉じられて通信が途絶えた場合にサーバーを自動終了します。
"""

import os
import signal
import sys
import threading
import time
import logging

logger = logging.getLogger("heartbeat")

# 設定値
INITIAL_TIMEOUT = 300.0   # 起動後、初回ハートビートを受信するまでの猶予秒数（ブラウザ起動待ち・5分）
HEARTBEAT_TIMEOUT = 12.0  # 通常時、ハートビート途絶とみなす秒数（ブラウザ全閉じ検知）
CHECK_INTERVAL = 1.0     # 監視チェック間隔（秒）

_lock = threading.RLock()
_start_time = time.time()
_last_heartbeat = None
_has_received_first = False
_is_shutting_down = False
_monitor_thread = None


def record_heartbeat() -> None:
    """フロントエンドからのハートビートを受信した際に呼び出す"""
    global _last_heartbeat, _has_received_first
    with _lock:
        _last_heartbeat = time.time()
        _has_received_first = True


def _perform_shutdown(reason: str, delay: float = 0.3) -> None:
    """プロセスを安全にシャットダウンする"""
    global _is_shutting_down
    with _lock:
        if _is_shutting_down:
            return
        _is_shutting_down = True

    print(f"\n[INFO] 自動シャットダウンを実行します (理由: {reason})")

    def _shutdown_worker():
        if delay > 0:
            time.sleep(delay)

        # フェイルセーフ（3秒後に強制終了）
        def _failsafe():
            time.sleep(3.0)
            os._exit(0)

        threading.Thread(target=_failsafe, daemon=True).start()

        # メインスレッドにSIGINTを送ってUvicornを正常終了させる
        try:
            if hasattr(signal, "raise_signal"):
                signal.raise_signal(signal.SIGINT)
            elif sys.platform == "win32":
                # Windows フォールバック
                import ctypes
                ctypes.windll.kernel32.GenerateConsoleCtrlEvent(0, 0)
            else:
                os.kill(os.getpid(), signal.SIGINT)
        except Exception as e:
            print(f"[WARN] シグナル送信失敗、直接終了します: {e}")
            os._exit(0)

    threading.Thread(target=_shutdown_worker, daemon=True, name="ShutdownWorker").start()


def request_shutdown(reason: str = "手動リクエスト") -> None:
    """外部から即時シャットダウンを要求する"""
    _perform_shutdown(reason)


def _monitor_loop() -> None:
    """監視バックグラウンドループ"""
    while True:
        time.sleep(CHECK_INTERVAL)

        try:
            with _lock:
                if _is_shutting_down:
                    break

                now = time.time()

                if not _has_received_first:
                    # 初回ハートビート待機中
                    if now - _start_time > INITIAL_TIMEOUT:
                        # 初回タイムアウト
                        _perform_shutdown(f"起動後 {INITIAL_TIMEOUT}秒間 ブラウザからの接続がありませんでした")
                        break
                else:
                    # 通常監視中
                    if _last_heartbeat and (now - _last_heartbeat > HEARTBEAT_TIMEOUT):
                        _perform_shutdown(f"ブラウザ切断（ハートビート途絶 {HEARTBEAT_TIMEOUT}秒）を検知しました")
                        break
        except Exception as e:
            print(f"[ERROR] ハートビート監視ループ内エラー: {e}")


def start_heartbeat_monitor() -> None:
    """ハートビート監視（タスクトレイ常駐化に伴い自動強制終了は無効化）"""
    print("[INFO] タスクトレイ常駐モードで動作中のため、ハートビートによる自動強制終了は無効です。")
