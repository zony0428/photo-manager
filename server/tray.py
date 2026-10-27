"""
Photo Manager - タスクトレイ常駐管理モジュール (pystray)
Windowsの通知領域に常駐し、アプリ画面の呼び出しおよび安全なシャットダウンを提供する。
"""

import logging
import os
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Callable, Optional

from PIL import Image
import pystray

logger = logging.getLogger("tray")

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_ICON_PATH = _PROJECT_ROOT / "frontend" / "favicon.ico"
_PNG_ICON_PATH = _PROJECT_ROOT / "frontend" / "icons" / "icon-32.png"


def _load_tray_image() -> Image.Image:
    """トレイ用アイコン画像を読み込む"""
    for p in [_PNG_ICON_PATH, _ICON_PATH]:
        if p.exists():
            try:
                img = Image.open(p)
                img.load()
                return img.convert("RGBA")
            except Exception as e:
                logger.warning(f"アイコン読み込み失敗 ({p}): {e}")

    # フォールバック画像（鮮やかな朱色・日の丸の簡易アイコン）
    fallback = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    from PIL import ImageDraw
    d = ImageDraw.Draw(fallback)
    d.ellipse([2, 2, 30, 30], fill=(225, 77, 42, 255))
    return fallback


class TrayManager:
    """タスクトレイ常駐アイコンのライフサイクル管理"""

    def __init__(
        self,
        app_url: str = "http://127.0.0.1:8088",
        on_open_app: Optional[Callable[[], None]] = None,
        on_shutdown: Optional[Callable[[], None]] = None,
    ):
        self.app_url = app_url
        self.on_open_app = on_open_app
        self.on_shutdown = on_shutdown
        self._icon: Optional[pystray.Icon] = None
        self._thread: Optional[threading.Thread] = None

    def _action_open_app(self, icon=None, item=None):
        """アプリ画面を開く（Edge/Chromeアプリモードまたはブラウザ）"""
        if self.on_open_app:
            try:
                self.on_open_app()
                return
            except Exception as e:
                logger.warning(f"on_open_app エラー: {e}")
        webbrowser.open(self.app_url)

    def _action_open_browser(self, icon=None, item=None):
        """通常のブラウザタブで開く"""
        webbrowser.open(self.app_url)

    def _action_shutdown(self, icon=None, item=None):
        """サーバーを安全に終了する"""
        logger.info("タスクトレイメニューから終了が指示されました。")
        self.stop()
        if self.on_shutdown:
            try:
                self.on_shutdown()
            except Exception as e:
                logger.error(f"on_shutdown エラー: {e}")
                os._exit(0)
        else:
            os._exit(0)

    def start(self) -> None:
        """トレイアイコンをバックグラウンドスレッドで起動する"""
        if self._icon is not None:
            return

        image = _load_tray_image()

        menu = pystray.Menu(
            pystray.MenuItem(
                "Photo Manager を開く",
                self._action_open_app,
                default=True,
            ),
            pystray.MenuItem(
                "ブラウザで開く (通常タブ)",
                self._action_open_browser,
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "サーバーを終了 (シャットダウン)",
                self._action_shutdown,
            ),
        )

        self._icon = pystray.Icon(
            name="PhotoManager",
            icon=image,
            title=f"Photo Manager (稼働中: {self.app_url})",
            menu=menu,
        )

        def _run():
            try:
                self._icon.run()
            except Exception as e:
                logger.error(f"トレイアイコン実行エラー: {e}")

        self._thread = threading.Thread(target=_run, daemon=True, name="TrayThread")
        self._thread.start()
        logger.info("タスクトレイアイコンを開始しました。")

    def stop(self) -> None:
        """トレイアイコンを停止・通知領域から削除する"""
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception as e:
                logger.warning(f"トレイアイコン停止時の警告: {e}")
            self._icon = None
        logger.info("タスクトレイアイコンを停止しました。")
