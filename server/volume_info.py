"""
ボリューム情報取得ユーティリティ
ファイルパスからドライブのボリュームシリアル番号（VSN）とラベルを取得する。
Windows API (GetVolumeInformationW) を ctypes 経由で呼び出す（外部依存なし）。
"""

import logging
import sys
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def get_volume_info(file_path: str) -> Optional[Dict[str, Any]]:
    """
    ファイルパスからボリューム情報を取得する。

    戻り値:
        {"serial": "A1B2C3D4", "label": "PHOTOS_SSD", "drive": "R:"}
        取得失敗時は None
    """
    if sys.platform != "win32":
        return None

    try:
        import ctypes
        from ctypes import wintypes

        # ファイルパスからドライブルートを抽出（例: "R:\Photos\..." → "R:\"）
        path = Path(file_path).resolve()
        drive = path.drive
        if not drive:
            return None
        root_path = drive + "\\"

        # バッファ確保
        volume_name_buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH + 1)
        fs_name_buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH + 1)
        serial_number = wintypes.DWORD(0)
        max_component_length = wintypes.DWORD(0)
        fs_flags = wintypes.DWORD(0)

        # GetVolumeInformationW 呼び出し（バッファサイズは文字数 len() を指定）
        result = ctypes.windll.kernel32.GetVolumeInformationW(
            root_path,
            volume_name_buf,
            len(volume_name_buf),
            ctypes.byref(serial_number),
            ctypes.byref(max_component_length),
            ctypes.byref(fs_flags),
            fs_name_buf,
            len(fs_name_buf),
        )

        if not result:
            return None

        # シリアル番号を16進文字列に変換（例: 0xA1B2C3D4 → "A1B2C3D4"）
        serial_hex = format(serial_number.value, "08X")

        return {
            "serial": serial_hex,
            "label": volume_name_buf.value or "",
            "drive": drive,
        }

    except Exception as e:
        logger.debug(f"ボリューム情報取得失敗 ({file_path}): {e}")
        return None


def get_volume_info_for_drive(drive_letter: str) -> Optional[Dict[str, Any]]:
    """
    ドライブレターを指定してボリューム情報を取得する。
    drive_letter: "R:" または "R" の形式
    """
    drive = drive_letter.rstrip(":\\")
    if not drive:
        return None
    return get_volume_info(f"{drive}:\\")
