"""
Windows Shell サムネイル抽出モジュール
IShellItemImageFactory COMインターフェースを利用し、
Google Drive や OneDrive などのオンデマンド（クラウド同期）ファイルを
フルダウンロードさせることなく、OS/クラウドが保持するサムネイル画像を高速取得する。
"""

import os
import ctypes
from ctypes import wintypes
from pathlib import Path
from typing import Optional, Union
from PIL import Image

# COM初期化定数
COINIT_APARTMENTTHREADED = 0x2
HRESULT = ctypes.c_long

# Windows API DLL
ole32 = ctypes.windll.ole32
shell32 = ctypes.windll.shell32
gdi32 = ctypes.windll.gdi32

# GUID構造体定義
class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", wintypes.BYTE * 8),
    ]

# IID_IShellItemImageFactory: {BCC18B79-BA16-442F-80C4-8A59C30C463B}
IID_IShellItemImageFactory = GUID(
    0xBCC18B79, 0xBA16, 0x442F,
    (wintypes.BYTE * 8)(0x80, 0xC4, 0x8A, 0x59, 0xC3, 0x0C, 0x46, 0x3B)
)

class SIZE(ctypes.Structure):
    _fields_ = [("cx", wintypes.LONG), ("cy", wintypes.LONG)]

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]

class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def _hbitmap_to_pil(hbitmap: wintypes.HBITMAP) -> Optional[Image.Image]:
    """Windows GDI HBITMAP を PIL.Image オブジェクトに変換する"""
    if not hbitmap:
        return None

    hdc = gdi32.CreateCompatibleDC(None)
    if not hdc:
        return None

    try:
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        # ビットマップの基本情報を取得
        if gdi32.GetDIBits(hdc, hbitmap, 0, 0, None, ctypes.byref(bmi), 0) == 0:
            return None

        height = abs(bmi.bmiHeader.biHeight)
        width = bmi.bmiHeader.biWidth
        if width <= 0 or height <= 0:
            return None

        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = 0  # BI_RGB
        bmi.bmiHeader.biHeight = -height  # トップダウンDIB形式（正立画像）

        buffer_size = width * height * 4
        pixel_buffer = (ctypes.c_char * buffer_size)()

        # ピクセルデータを取得
        if gdi32.GetDIBits(hdc, hbitmap, 0, height, pixel_buffer, ctypes.byref(bmi), 0) == 0:
            return None

        # BGRA形式からRGBA画像を生成し、RGBに変換
        image = Image.frombuffer("RGBA", (width, height), pixel_buffer, "raw", "BGRA", 0, 1)
        return image.convert("RGB")
    except Exception:
        return None
    finally:
        gdi32.DeleteDC(hdc)


def get_shell_thumbnail(file_path: Union[str, Path], size: int = 360) -> Optional[Image.Image]:
    """
    Windows Shell API (IShellItemImageFactory) を使用してサムネイルを取得する。
    Google Drive や OneDrive の未ダウンロードファイルでも、元ファイルをダウンロードさせずに
    クラウド/OS側のキャッシュから直接サムネイル画像を取得できる。
    """
    path_str = str(Path(file_path).resolve())
    ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
    try:
        factory_pointer = ctypes.c_void_p()
        hr = shell32.SHCreateItemFromParsingName(
            path_str,
            None,
            ctypes.byref(IID_IShellItemImageFactory),
            ctypes.byref(factory_pointer),
        )
        if hr != 0 or not factory_pointer:
            return None

        # IShellItemImageFactory の仮想関数テーブルを取得
        # vtable: [0] QueryInterface, [1] AddRef, [2] Release, [3] GetImage
        vtable_pointer = ctypes.cast(
            factory_pointer,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))
        ).contents

        get_image_func_type = ctypes.WINFUNCTYPE(
            HRESULT,
            ctypes.c_void_p,
            SIZE,
            ctypes.c_uint,
            ctypes.POINTER(wintypes.HBITMAP),
        )
        get_image_func = get_image_func_type(vtable_pointer[3])
        release_func = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(vtable_pointer[2])

        hbitmap = wintypes.HBITMAP()
        requested_size = SIZE(size, size)
        # SIIGBF_BIGGERSIZEOK (0x01) | SIIGBF_THUMBNAILONLY (0x08)
        # 元ファイルの強制ダウンロードを防ぎつつサムネイルを取得
        flags = 0x01 | 0x08

        hr = get_image_func(factory_pointer, requested_size, flags, ctypes.byref(hbitmap))
        release_func(factory_pointer)

        if hr != 0 or not hbitmap:
            return None

        pil_image = _hbitmap_to_pil(hbitmap)
        gdi32.DeleteObject(hbitmap)
        return pil_image
    except Exception:
        return None
    finally:
        ole32.CoUninitialize()


def is_cloud_or_ondemand_path(file_path: Union[str, Path]) -> bool:
    """
    対象ファイルまたはフォルダが、Google Drive や OneDrive などの
    クラウド同期・オンデマンドストレージ配下に存在するか判定する。
    """
    try:
        path = Path(file_path).resolve()
        path_str_upper = str(path).upper()

        # 1. Google Drive の仮想ドライブ (通常 G: ドライブ)
        if path_str_upper.startswith("G:\\") or "\\DRIVEFS\\" in path_str_upper:
            return True

        # 2. OneDrive フォルダ配下
        onedrive_env = os.environ.get("OneDrive")
        if onedrive_env and str(Path(onedrive_env).resolve()).upper() in path_str_upper:
            return True

        onedrive_comm = os.environ.get("OneDriveCommercial")
        if onedrive_comm and str(Path(onedrive_comm).resolve()).upper() in path_str_upper:
            return True

        # 3. iCloud / Dropbox などの代表的クラウドフォルダ名
        if "\\ICLOUDDRIVE\\" in path_str_upper or "\\DROPBOX\\" in path_str_upper:
            return True

        # 4. Windows ファイル属性の判定 (リパースポイントまたはオフライン属性)
        if path.exists():
            stat_info = path.stat()
            file_attrs = getattr(stat_info, "st_file_attributes", 0)
            # FILE_ATTRIBUTE_REPARSE_POINT (0x0400) or FILE_ATTRIBUTE_OFFLINE (0x1000)
            if file_attrs & (0x0400 | 0x1000):
                return True

        return False
    except Exception:
        return False
