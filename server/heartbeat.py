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

_lock = threading.RLock()
_last_heartbeat = None
_has_received_first = False
_is_shutting_down = False


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
