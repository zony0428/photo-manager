"""
スマート・テイクアウト（高機能エクスポート / マーシャリング）モジュール
元画像ファイルを一切破壊せず、回転・クロップ・リサイズ・リネーム・Exif選択消去を一括適用して出力する。
"""

import io
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageOps

from .database import get_photo_by_id
from .raw_loader import extract_raw_full_preview, is_raw_file
from .scanner import apply_photo_adjustments_pil, resolve_portable_path

# プロジェクトルート基準のテイクアウト基本保存先
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TAKEOUT_DIR = PROJECT_ROOT / "take_out"


def _decimal_to_dms_tuple(dec: float) -> Tuple[float, float, float]:
    """10進数の緯度・経度をExif GPSInfo用の (度, 分, 秒) タプルへ変換する"""
    abs_val = abs(float(dec))
    deg = int(abs_val)
    rem = (abs_val - deg) * 60.0
    minutes = int(rem)
    seconds = round((rem - minutes) * 60.0, 4)
    return (float(deg), float(minutes), float(seconds))


def _clear_gps_from_exif(exif: Image.Exif) -> None:
    """ExifオブジェクトからGPSInfo (0x8825) を確実に除去する"""
    try:
        gps_ifd = exif.get_ifd(0x8825)
        if isinstance(gps_ifd, dict):
            gps_ifd.clear()
    except Exception as e:
        pass
    if 0x8825 in exif:
        try:
            del exif[0x8825]
        except Exception as e:
            pass
    try:
        if hasattr(exif, "_ifds") and 0x8825 in exif._ifds:
            del exif._ifds[0x8825]
    except Exception as e:
        pass


def filter_exif_data(
    source_img: Image.Image,
    remove_gps: bool = False,
    remove_exposure: bool = False,
    remove_camera: bool = False,
    remove_other: bool = False,
    remove_all: bool = False,
    orig_exif_bytes: Optional[bytes] = None,
    photo: Optional[dict] = None,
    apply_adjustments: bool = True,
    sync_db_exif: bool = True,
) -> Optional[bytes]:
    """
    ユーザーの指定に応じてDB情報（GPS・回転向き）をExifへ同期し、選択されたExif項目を消去する。
    """
    if remove_all:
        return None

    raw_exif = orig_exif_bytes if orig_exif_bytes is not None else source_img.info.get("exif")

    # DB同期も選択消去もすべてOFFなら元Exifをそのまま返す
    if not sync_db_exif and not (remove_gps or remove_exposure or remove_camera or remove_other):
        return raw_exif

    try:
        exif = Image.Exif()
        if raw_exif:
            try:
                exif.load(raw_exif)
            except Exception as e:
                exif = source_img.getexif()
        else:
            exif = source_img.getexif()

        # --- 0. ローカルDBの編集内容（位置情報GPS・回転Orientation・画像寸法）をExifへ同期 ---
        if sync_db_exif and photo is not None:
            # (a) 回転・向き (Orientation: 0x0112) と画像サイズの整合
            if apply_adjustments:
                # ピクセル自体を回転・水平出し・クロップ済みのため Orientation=1 (標準) に正規化
                exif[0x0112] = 1
                try:
                    w, h = source_img.size
                    if 0x0100 in exif:
                        exif[0x0100] = w
                    if 0x0101 in exif:
                        exif[0x0101] = h
                    exif_ifd = exif.get_ifd(0x8769)
                    if isinstance(exif_ifd, dict):
                        if 0xA002 in exif_ifd:
                            exif_ifd[0xA002] = w
                        if 0xA003 in exif_ifd:
                            exif_ifd[0xA003] = h
                except Exception as e:
                    pass
            else:
                # ピクセル非加工時はDBの90度単位回転 (0/90/180/270) を Exif Orientation (1/6/3/8) に反映
                rot = ((int(photo.get("rotation") or 0)) % 360 + 360) % 360
                rot_to_orientation = {0: 1, 90: 6, 180: 3, 270: 8}
                exif[0x0112] = rot_to_orientation.get(rot, 1)

            # (b) GPS座標 (GPSInfo: 0x8825) のDB同期（GPS消去がOFFのときのみ）
            if not remove_gps:
                lat = photo.get("latitude")
                lon = photo.get("longitude")
                if lat is not None and lon is not None:
                    try:
                        lat_val = float(lat)
                        lon_val = float(lon)
                        lat_ref = "N" if lat_val >= 0 else "S"
                        lon_ref = "E" if lon_val >= 0 else "W"
                        existing_gps: Dict[int, Any] = {}
                        try:
                            raw_gps = exif.get_ifd(0x8825)
                            if isinstance(raw_gps, dict):
                                existing_gps = dict(raw_gps)
                        except Exception as e:
                            existing_gps = {}
                        existing_gps[0] = b"\x02\x02\x00\x00"
                        existing_gps[1] = lat_ref
                        existing_gps[2] = _decimal_to_dms_tuple(lat_val)
                        existing_gps[3] = lon_ref
                        existing_gps[4] = _decimal_to_dms_tuple(lon_val)
                        exif[0x8825] = existing_gps
                    except Exception as e:
                        print(f"[WARN] Exif GPS同期書き込みエラー: {e}")
                else:
                    # DB側で位置情報が削除・未設定の場合はExif側のGPSもクリアしてDB状態に一致させる
                    _clear_gps_from_exif(exif)

        if not exif and not (sync_db_exif and photo is not None):
            return None

        # 1. 📍 位置情報（GPS）の消去
        if remove_gps:
            _clear_gps_from_exif(exif)

        # 2. ⏱️ 撮影条件（SS, F値, ISO, 露出, 焦点距離）の消去
        if remove_exposure:
            try:
                exif_ifd = exif.get_ifd(0x8769)
                exposure_tags = [
                    0x829A,  # ExposureTime (シャッタースピード)
                    0x829D,  # FNumber (F値)
                    0x8822,  # ExposureProgram
                    0x8824,  # SpectralSensitivity
                    0x8827,  # PhotographicSensitivity / ISOSpeedRatings (ISO)
                    0x9201,  # ShutterSpeedValue
                    0x9202,  # ApertureValue
                    0x9203,  # BrightnessValue
                    0x9204,  # ExposureBiasValue (露出補正)
                    0x9205,  # MaxApertureValue
                    0x9207,  # MeteringMode (測光方式)
                    0x9208,  # LightSource
                    0x9209,  # Flash (フラッシュ)
                    0x920A,  # FocalLength (焦点距離)
                    0xA404,  # DigitalZoomRatio
                    0xA405,  # FocalLengthIn35mmFilm (35mm換算焦点距離)
                    0xA407,  # GainControl
                    0xA408,  # Contrast
                    0xA409,  # Saturation
                    0xA40A,  # Sharpness
                ]
                for tag in exposure_tags:
                    if tag in exif_ifd:
                        del exif_ifd[tag]
            except Exception as e:
                pass

        # 3. 📷 カメラ・機材情報（機種名、レンズ名、シリアル等）の消去
        if remove_camera:
            # 0th IFD 内のタグ
            camera_tags_0th = [
                0x010F,  # Make (メーカー名)
                0x0110,  # Model (機種名)
                0x0131,  # Software
                0x013B,  # Artist (撮影者)
                0x8298,  # Copyright (著作権)
            ]
            for tag in camera_tags_0th:
                if tag in exif:
                    del exif[tag]

            # Exif IFD 内のレンズ・機材タグ
            try:
                exif_ifd = exif.get_ifd(0x8769)
                camera_tags_sub = [
                    0xA431,  # BodySerialNumber (カメラ本体シリアル)
                    0xA432,  # LensSpecification (レンズスペック)
                    0xA433,  # LensMake (レンズメーカー)
                    0xA434,  # LensModel (レンズ型番)
                    0xA435,  # LensSerialNumber (レンズシリアル)
                    0xA420,  # ImageUniqueID
                ]
                for tag in camera_tags_sub:
                    if tag in exif_ifd:
                        del exif_ifd[tag]
            except Exception as e:
                pass

        # 4. 🏷️ その他（コメント、説明文、著作権、ソフトウェア名、埋め込みサムネイル等）の消去
        if remove_other:
            other_tags_0th = [
                0x010E,  # ImageDescription
                0x0131,  # Software
                0x013B,  # Artist
                0x8298,  # Copyright
                0x9286,  # UserComment
            ]
            for tag in other_tags_0th:
                if tag in exif:
                    del exif[tag]

            try:
                exif_ifd = exif.get_ifd(0x8769)
                other_tags_sub = [
                    0x9000,  # ExifVersion
                    0x927C,  # MakerNote
                    0x9286,  # UserComment
                    0xA000,  # FlashpixVersion
                    0xA401,  # CustomRendered
                    0xA402,  # ExposureMode
                    0xA403,  # WhiteBalance
                    0xA406,  # SceneCaptureType
                    0xA40C,  # SubjectDistanceRange
                ]
                for tag in other_tags_sub:
                    if tag in exif_ifd:
                        del exif_ifd[tag]
            except Exception as e:
                pass

            # 1st IFD (埋め込みサムネイル等) の消去
            try:
                if hasattr(exif, "_ifds") and 1 in exif._ifds:
                    del exif._ifds[1]
            except Exception as e:
                pass

        return exif.tobytes()
    except Exception as e:
        print(f"[WARN] Exifフィルタリング処理でエラー: {e}")
        return raw_exif


def load_photo_pil_image(photo: dict) -> Tuple[Optional[Image.Image], Optional[bytes]]:
    """
    写真の実体ファイル（またはRAWプレビュー）からPillow Imageおよび元Exifを取得する。
    """
    raw_path_str = photo.get("file_path")
    if not raw_path_str:
        return None, None

    real_path, is_online = resolve_portable_path(raw_path_str)
    if not is_online or not real_path.exists():
        return None, None

    # RAWファイルの場合
    if photo.get("is_raw") or is_raw_file(real_path):
        preview_res = extract_raw_full_preview(real_path)
        if preview_res:
            raw_bytes, _, _, _ = preview_res
            img = Image.open(io.BytesIO(raw_bytes))
            exif_bytes = img.info.get("exif")
            # 念のためRGBモードに統一
            if img.mode != "RGB":
                img = img.convert("RGB")
            return img, exif_bytes

        # RAWペアがある場合はペア側のJPGを探索
        paired_path_str = photo.get("paired_raw_path")
        if paired_path_str:
            p_pair, is_pair_online = resolve_portable_path(paired_path_str)
            if is_pair_online and p_pair.exists() and p_pair.suffix.lower() in (".jpg", ".jpeg"):
                img = Image.open(p_pair)
                exif_bytes = img.info.get("exif")
                if img.mode != "RGB":
                    img = img.convert("RGB")
                return img, exif_bytes

    # 通常の画像ファイル (JPEG, PNG, WebP 等)
    try:
        img = Image.open(real_path)
        # カメラ向きタグを物理適用
        img = ImageOps.exif_transpose(img)
        exif_bytes = img.info.get("exif")
        if img.mode != "RGB":
            img = img.convert("RGB")
        return img, exif_bytes
    except Exception as e:
        print(f"[ERROR] 画像読み込み失敗 ({real_path}): {e}")
        return None, None


def export_single_photo(
    photo: dict,
    opts: dict,
    index: int,
    dest_dir: Path,
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    1枚の写真を指定されたパラメータで処理し、出力フォルダへ保存する。
    戻り値: (成功フラグ, 出力ファイル名, エラーメッセージ)
    """
    img, orig_exif = load_photo_pil_image(photo)
    if not img:
        return False, None, "元写真ファイルにアクセスできませんでした（未接続または読込不可）"

    try:
        # 1 & 2. 非破壊調整（90度回転・水平傾き補正・クロップ・明るさ・コントラスト・彩度）の適用
        apply_adjustments = opts.get("apply_adjustments", True)
        if apply_adjustments:
            crop_box = None
            if photo.get("crop_w") and photo.get("crop_h"):
                crop_box = (
                    photo.get("crop_x") or 0.0,
                    photo.get("crop_y") or 0.0,
                    photo.get("crop_w"),
                    photo.get("crop_h"),
                )
            img = apply_photo_adjustments_pil(
                img,
                rotation=photo.get("rotation") or 0,
                fine_angle=photo.get("fine_angle") or 0.0,
                crop_box=crop_box,
                brightness=photo.get("brightness") or 0,
                contrast=photo.get("contrast") or 0,
                saturation=photo.get("saturation") or 0,
            )

        # 3. リサイズの適用
        resize_mode = opts.get("resize_mode", "original")
        target_long_edge = None

        if resize_mode == "3840":
            target_long_edge = 3840
        elif resize_mode == "2048":
            target_long_edge = 2048
        elif resize_mode == "1920":
            target_long_edge = 1920
        elif resize_mode == "1280":
            target_long_edge = 1280
        elif resize_mode == "custom":
            try:
                target_long_edge = int(opts.get("custom_long_edge") or 0)
            except Exception as e:
                target_long_edge = None

        if target_long_edge and target_long_edge > 0:
            cur_w, cur_h = img.size
            current_long_edge = max(cur_w, cur_h)
            if current_long_edge > target_long_edge:
                if cur_w >= cur_h:
                    new_w = target_long_edge
                    new_h = max(1, round(cur_h * (target_long_edge / cur_w)))
                else:
                    new_h = target_long_edge
                    new_w = max(1, round(cur_w * (target_long_edge / cur_h)))
                img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # 4. ExifのDB同期（位置情報GPS・回転向き）および選択的消去
        filtered_exif = filter_exif_data(
            img,
            remove_gps=opts.get("exif_remove_gps", False),
            remove_exposure=opts.get("exif_remove_exposure", False),
            remove_camera=opts.get("exif_remove_camera", False),
            remove_other=opts.get("exif_remove_other", False),
            remove_all=opts.get("exif_remove_all", False),
            orig_exif_bytes=orig_exif,
            photo=photo,
            apply_adjustments=apply_adjustments,
            sync_db_exif=opts.get("exif_sync_db", True),
        )

        # 5. ファイル名ルールの適用
        naming_rule = opts.get("naming_rule", "original")
        orig_file_name = photo.get("file_name", "photo")
        orig_stem = Path(orig_file_name).stem

        # 日時文字列の抽出
        date_str = ""
        date_taken = photo.get("date_taken")
        if date_taken:
            try:
                # 2026-10-13 14:30:00 -> 20261013_143000
                cleaned = re.sub(r'[-: ]', '', str(date_taken))
                date_str = cleaned[:15] if len(cleaned) >= 8 else ""
            except Exception:
                date_str = ""

        if not date_str:
            date_str = datetime.now().strftime("%Y%m%d_%H%M%S")

        # 拡張子の決定
        fmt = opts.get("format", "jpeg").lower()
        ext = ".webp" if fmt == "webp" else ".jpg"

        seq_num = index + 1
        prefix = (opts.get("custom_prefix") or opts.get("prefix") or "Photo").strip()
        prefix = re.sub(r'[\\/*?:"<>|]', '_', prefix)

        if naming_rule == "date_original":
            base_name = f"{date_str}_{orig_stem}"
        elif naming_rule == "date_seq":
            base_name = f"{date_str[:8]}_{seq_num:03d}"
        elif naming_rule in ("custom_seq", "prefix_seq"):
            base_name = f"{prefix}_{seq_num:03d}"
        else:  # original
            base_name = orig_stem

        # Windows禁止文字置換
        sanitized_base = re.sub(r'[\\/*?:"<>|]', '_', base_name).strip()
        if not sanitized_base:
            sanitized_base = f"photo_{seq_num:03d}"

        # 同名衝突回避のためのナンバリング
        target_path = dest_dir / f"{sanitized_base}{ext}"
        dup_count = 1
        while target_path.exists():
            target_path = dest_dir / f"{sanitized_base}_{dup_count}{ext}"
            dup_count += 1

        # 6. 保存処理
        save_kwargs = {}
        if filtered_exif:
            save_kwargs["exif"] = filtered_exif

        quality = int(opts.get("quality") or 90)
        quality = max(10, min(100, quality))

        if fmt == "webp":
            img.save(target_path, "WEBP", quality=quality, method=6, **save_kwargs)
        else:
            img.save(
                target_path,
                "JPEG",
                quality=quality,
                subsampling=0,  # 4:4:4 高品質
                optimize=True,
                **save_kwargs,
            )

        return True, target_path.name, None

    except Exception as e:
        return False, None, str(e)


def run_smart_export(req: dict) -> dict:
    """
    複数写真の一括スマートエクスポートを実行する。
    """
    photo_ids = req.get("photo_ids", [])
    if not photo_ids:
        return {"status": "error", "message": "出力する写真が選択されていません"}

    # 出力先フォルダの決定
    dest_path_str = req.get("destination") or req.get("custom_dir_path")
    if dest_path_str and str(dest_path_str).strip():
        dest_dir = Path(str(dest_path_str).strip()).resolve()
    else:
        dest_mode = req.get("destination_mode", "takeout")
        if dest_mode == "custom" and req.get("custom_dir_path"):
            dest_dir = Path(req["custom_dir_path"]).resolve()
        else:
            subfolder = (req.get("subfolder_name") or "").strip()
            if subfolder:
                subfolder = re.sub(r'[\\/*?:"<>|]', '_', subfolder).strip()
                dest_dir = DEFAULT_TAKEOUT_DIR / subfolder
            else:
                dest_dir = DEFAULT_TAKEOUT_DIR

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"status": "error", "message": f"出力先フォルダの作成に失敗しました: {e}"}

    success_list = []
    failed_list = []

    # 撮影日時順などの整合性を保つため、DB情報から写真オブジェクトを取得
    photos_to_process = []
    for pid in photo_ids:
        p = get_photo_by_id(pid)
        if p:
            photos_to_process.append(p)

    # 撮影日時（秒単位、未設定ならファイル更新日時）＋ ファイル名（またはID）で時系列昇順ソート
    # これにより「撮影日時＋連番」などで秒数順の正しいナンバリングが保証される
    def _photo_sort_key(p):
        dt = p.get("date_taken") or p.get("modified_at") or ""
        fn = p.get("file_name") or ""
        pid = p.get("id") or 0
        return (dt, fn, pid)

    photos_to_process.sort(key=_photo_sort_key)

    total = len(photos_to_process)
    for idx, photo in enumerate(photos_to_process):
        ok, out_name, err = export_single_photo(photo, req, idx, dest_dir)
        if ok:
            success_list.append(out_name)
        else:
            failed_list.append({"photo_id": photo["id"], "file_name": photo.get("file_name"), "error": err})

    return {
        "status": "ok",
        "total": total,
        "success_count": len(success_list),
        "failed_count": len(failed_list),
        "destination": str(dest_dir),
        "exported_files": success_list,
        "failed_files": failed_list,
    }


def open_folder_in_windows_explorer(dir_path: Path):
    """Windowsエクスプローラーでフォルダを開く"""
    try:
        os.startfile(str(dir_path))
        return True
    except Exception as e:
        print(f"[WARN] エクスプローラー起動失敗 ({dir_path}): {e}")
        return False


def pick_folder_dialog(initial_dir: Optional[str] = None) -> Optional[str]:
    """
    Windowsの標準フォルダ選択ダイアログを前面表示して選択されたパスを返す。
    キャンセルされた場合は None を返す。
    """
    import subprocess
    init_path = initial_dir or str(DEFAULT_TAKEOUT_DIR)
    ps_script = f"""
[System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "エクスポート先フォルダを選択してください"
$dialog.SelectedPath = "{init_path}"
$dialog.ShowNewFolderButton = $true
$res = $dialog.ShowDialog()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {{
    Write-Output $dialog.SelectedPath
}}
"""
    try:
        startupinfo = None
        creationflags = 0
        if os.name == 'nt':
            creationflags = subprocess.CREATE_NO_WINDOW
        
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
            capture_output=True,
            text=True,
            creationflags=creationflags,
            timeout=60,
        )
        selected = proc.stdout.strip()
        if selected and Path(selected).is_dir():
            return selected
        return None
    except Exception as e:
        print(f"[WARN] フォルダ選択ダイアログ呼び出し失敗: {e}")
        return None

