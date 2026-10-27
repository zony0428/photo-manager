"""
試作用サンプル写真生成モジュール
勤務先PC等の検証環境ですぐにUIや操作感を試せるよう、ダミーの写真画像を生成する。
"""

import math
from datetime import datetime, timedelta
from pathlib import Path
from typing import List
from PIL import Image, ImageDraw, ImageFont


def create_gradient_image(width: int, height: int, start_color: tuple, end_color: tuple) -> Image.Image:
    """縦方向の美しい線形グラデーション画像を生成する"""
    base = Image.new("RGB", (width, height), start_color)
    top = Image.new("RGB", (width, height), end_color)
    mask = Image.new("L", (width, height))
    mask_data = []
    for y in range(height):
        mask_data.extend([int(255 * (y / height))] * width)
    mask.putdata(mask_data)
    base.paste(top, (0, 0), mask)
    return base


def generate_sample_photos(target_dir: Path, count: int = 16) -> List[Path]:
    """多様なアスペクト比と撮影日のサンプル画像を生成する"""
    target_dir.mkdir(parents=True, exist_ok=True)

    themes = [
        ("Sunrise Coast", (255, 120, 80), (30, 40, 90), (1920, 1080), "2024-07-15 05:42:10", "Canon EOS R5"),
        ("Forest Mist", (34, 139, 34), (10, 40, 20), (1440, 1920), "2024-07-20 09:15:33", "Sony Alpha 7 IV"),
        ("Golden Hour", (255, 180, 50), (120, 40, 30), (1920, 1280), "2024-08-03 18:22:45", "Nikon Z8"),
        ("Deep Ocean", (0, 180, 216), (3, 4, 94), (1920, 1080), "2024-08-11 13:05:00", "Fujifilm X-T5"),
        ("Night Skyline", (80, 20, 120), (10, 10, 30), (1600, 1200), "2024-09-02 21:40:12", "Leica Q3"),
        ("Spring Blossom", (255, 192, 203), (200, 80, 120), (1200, 1600), "2024-04-10 11:30:22", "Canon EOS R6"),
        ("Desert Dune", (237, 201, 175), (160, 82, 45), (1920, 1080), "2024-05-18 16:50:08", "Sony Alpha 7 IV"),
        ("Snow Peak", (240, 248, 255), (70, 130, 180), (1800, 1200), "2024-01-22 10:11:55", "Nikon Z7 II"),
        ("Autumn Leaves", (220, 20, 60), (255, 140, 0), (1920, 1280), "2023-11-05 14:15:40", "Sony Alpha 7 IV"),
        ("Coffee Time", (188, 143, 143), (92, 64, 51), (1200, 1200), "2023-10-12 15:45:00", "Ricoh GR III"),
        ("Tokyo Neon", (255, 0, 128), (20, 20, 60), (1920, 1080), "2023-09-28 20:33:19", "Fujifilm X100V"),
        ("Summer Cloud", (135, 206, 235), (245, 245, 245), (1600, 1200), "2023-08-15 12:20:00", "Canon EOS R5"),
    ]

    generated_paths = []

    for i, (title, col1, col2, (w, h), date_str, camera) in enumerate(themes):
        img = create_gradient_image(w, h, col1, col2)
        draw = ImageDraw.Draw(img)

        # 幾何学的な円を描画して写真っぽさを演出
        cx, cy = w // 2, h // 2
        for r in range(50, min(w, h) // 2, 60):
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 40), width=2)

        # タイトルと撮影情報テキストを描画
        info_text = f"Sample: {title}\nDate: {date_str} | Camera: {camera}\nSize: {w}x{h}"
        draw.text((40, h - 120), info_text, fill=(255, 255, 255))

        # EXIFメタデータを埋め込み
        exif = img.getexif()
        # EXIF日時形式は YYYY:MM:DD HH:MM:SS
        exif_date_fmt = date_str.replace("-", ":")
        exif[0x0132] = exif_date_fmt  # DateTime (ルートIFD)
        exif[0x0110] = camera         # Model

        # DateTimeOriginal をサブIFD (Exif IFD) にも設定
        # scanner.py は 0x9003 を優先的に読むため、これがないと撮影日がファイル更新日にフォールバックする
        exif_ifd = exif.get_ifd(0x8769)
        exif_ifd[0x9003] = exif_date_fmt  # DateTimeOriginal

        file_name = f"sample_{i+1:02d}_{title.lower().replace(' ', '_')}.jpg"
        out_path = target_dir / file_name
        img.save(out_path, format="JPEG", quality=90, exif=exif.tobytes())
        generated_paths.append(out_path)

    return generated_paths
