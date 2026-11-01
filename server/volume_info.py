"""
ボリューム情報取得・ボリュームラベル設定ユーティリティ
ファイルパスからドライブのボリュームシリアル番号（VSN）・ラベル・ファイルシステム種別を取得し、
ユーザー承認時に安全な半角ASCIIボリュームラベルを書き込む。
Windows API (GetVolumeInformationW / SetVolumeLabelW) を ctypes 経由で呼び出す（外部依存なし）。
"""

import logging
import re
import string
import sys
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# ボリュームラベルで使用を禁止する記号（FAT32 / exFAT / NTFS 共通の禁止文字）
_FORBIDDEN_LABEL_CHARS = set('*?/\\|.,;:+=[]<>"')


def get_volume_info(file_path: str) -> Optional[Dict[str, Any]]:
    """
    ファイルパスからボリューム情報を取得する。

    戻り値:
        {"serial": "A1B2C3D4", "label": "PHOTOS_SSD", "drive": "R:", "filesystem": "exFAT"}
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
            "filesystem": fs_name_buf.value or "",
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


def find_online_drive_for_serial(volume_serial: str) -> Optional[Dict[str, Any]]:
    """
    指定されたボリュームシリアル番号（VSN）を持つ現在接続中のドライブを探索してボリューム情報を返す。
    未接続時は None を返す。
    """
    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean or sys.platform != "win32":
        return None

    for letter in string.ascii_uppercase:
        info = get_volume_info_for_drive(letter)
        if info and info.get("serial", "").upper() == serial_clean:
            return info
    return None


def validate_ascii_volume_label(label: str) -> str:
    """
    メディア本体へ書き込むボリュームラベルを検証・正規化する。
    カメラや別OSでの文字化け・認識不良を防ぐため、2バイト文字（非ASCII）は厳格に拒否し、
    11文字以内の安全な半角ASCII文字のみを許可する（空文字はラベル消去として許可）。
    """
    if label is None:
        return ""
    cleaned = str(label).strip()
    if not cleaned:
        return ""

    # 1. 2バイト文字（全角文字・日本語・制御文字）の厳格拒否
    for ch in cleaned:
        code = ord(ch)
        if code < 0x20 or code > 0x7E:
            raise ValueError(
                "ボリュームラベルには2バイト文字（全角・日本語・環境依存文字）は使用できません。"
                "半角英数字・ハイフン(-)・アンダースコア(_)で入力してください。"
            )

    # 2. ファイルシステム禁止記号のチェック
    bad_chars = [ch for ch in cleaned if ch in _FORBIDDEN_LABEL_CHARS]
    if bad_chars:
        raise ValueError(
            "ボリュームラベルに使用できない記号が含まれています。"
            "半角英数字・ハイフン(-)・アンダースコア(_)・半角スペースのみ使用できます。"
        )

    # 3. 文字数上限チェック（FAT32 / exFAT 共通の11文字上限）
    if len(cleaned) > 11:
        raise ValueError(
            f"ボリュームラベルは半角11文字以内で指定してください（現在 {len(cleaned)} 文字）。"
        )

    return cleaned


def set_physical_volume_label(volume_serial: str, new_label: str) -> Dict[str, Any]:
    """
    指定VSNのメディア（接続中ドライブ）の物理ボリュームラベルを SetVolumeLabelW で書き換える。
    事前のASCII検証および接続中ドライブのVSN一致確認を必須とする。
    """
    serial_clean = (volume_serial or "").strip().upper()
    if not serial_clean:
        raise ValueError("ボリュームシリアル番号(VSN)が指定されていません。")

    validated_label = validate_ascii_volume_label(new_label)

    if sys.platform != "win32":
        raise RuntimeError("ボリュームラベルの書き込みはWindows環境でのみ対応しています。")

    online_info = find_online_drive_for_serial(serial_clean)
    if not online_info or not online_info.get("drive"):
        raise RuntimeError("対象のメディアが現在PCに接続されていないため、ボリュームラベルを書き込めません。")

    drive = online_info["drive"].rstrip(":\\") + ":"
    root_path = drive + "\\"

    # 書き込み直前に再度VSNを照合（メディア差し替え事故防止）
    recheck = get_volume_info_for_drive(drive)
    if not recheck or recheck.get("serial", "").upper() != serial_clean:
        raise RuntimeError("ドライブのボリュームシリアル番号が一致しません。メディアが差し替えられた可能性があります。")

    import ctypes

    label_arg = validated_label if validated_label else None
    res = ctypes.windll.kernel32.SetVolumeLabelW(root_path, label_arg)
    if not res:
        err_code = ctypes.windll.kernel32.GetLastError()
        if err_code == 5:
            raise PermissionError(
                "メディアへの書き込み権限がありません（SDカードのLOCKスイッチ、または固定ディスクの管理者権限制限を確認してください）。"
            )
        if err_code == 19:
            raise PermissionError(
                "メディアが書き込み禁止（ライトプロテクト）になっています。SDカードのLOCKスイッチを確認してください。"
            )
        if err_code == 154:
            raise ValueError("ボリュームラベルが長すぎます（半角11文字以内で指定してください）。")
        raise RuntimeError(f"ボリュームラベルの書き込みに失敗しました (WinError: {err_code})。")

    updated_info = get_volume_info_for_drive(drive) or online_info
    return {
        "serial": serial_clean,
        "drive": drive,
        "volume_label": updated_info.get("label", validated_label),
        "filesystem": updated_info.get("filesystem", online_info.get("filesystem", "")),
    }
