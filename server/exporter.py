"""
スマート・テイクアウト（高機能エクスポート / マーシャリング）モジュール
元画像ファイルを一切破壊せず、回転・クロップ・リサイズ・リネーム・Exif選択消去を一括適用して出力する。
"""

import base64
import html
import io
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageOps

from .database import get_photo_by_id, get_thumbnails_batch
from .raw_loader import extract_raw_full_preview, is_raw_file
from .scanner import apply_photo_adjustments_pil, ensure_thumbnail, resolve_portable_path

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


def _format_exif_summary(p: Dict[str, Any]) -> str:
    """コンタクトシートのコマ下部表示用のExif短縮文字列を生成する"""
    parts: List[str] = []
    fl = p.get("focal_length")
    if fl is not None:
        try:
            fl_f = float(fl)
            parts.append(f"{int(fl_f)}mm" if fl_f.is_integer() else f"{fl_f:.1f}mm")
        except Exception:
            pass
    fn = p.get("f_number")
    if fn is not None:
        try:
            parts.append(f"F{float(fn):.1f}".replace(".0", ""))
        except Exception:
            pass
    ss = p.get("shutter_speed")
    if ss:
        s_str = str(ss).strip()
        if not s_str.endswith("s"):
            s_str += "s"
        parts.append(s_str)
    iso = p.get("iso")
    if iso:
        parts.append(f"ISO{iso}")
    return " · ".join(parts) if parts else "Exif情報なし"


def run_contact_sheet_export(req: Dict[str, Any]) -> Dict[str, Any]:
    """
    選択された写真群から完全スタンドアロン単一HTMLのベタ焼き（コンタクトシート）を生成して出力する。
    暗室ネガシート / 和紙プリントのテーマ切替、手書き風赤鉛筆（グリースペンシル）⭕マーク、
    拡大ルーペモーダル、A4印刷/PDF最適化CSSをすべて1ファイルに内蔵する。
    """
    photo_ids = req.get("photo_ids") or []
    if not photo_ids:
        return {"status": "error", "message": "コンタクトシートに出力する写真が選択されていません"}

    title_raw = (req.get("title") or "").strip() or "Photo Manager Contact Sheet"
    theme = (req.get("theme") or "darkroom").strip().lower()
    if theme not in ("darkroom", "washi"):
        theme = "darkroom"
    try:
        columns = int(req.get("columns") or 5)
    except Exception:
        columns = 5
    if columns not in (4, 5, 6):
        columns = 5

    dest_dir_str = (req.get("destination_dir") or req.get("destination") or "").strip()
    if dest_dir_str:
        dest_dir = Path(dest_dir_str).resolve()
    else:
        dest_dir = DEFAULT_TAKEOUT_DIR

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return {"status": "error", "message": f"出力先フォルダの作成に失敗しました: {e}"}

    open_after = bool(req.get("open_after", True))

    # 1. 写真メタデータの取得と時系列昇順ソート
    photos: List[Dict[str, Any]] = []
    for pid in photo_ids:
        try:
            p = get_photo_by_id(int(pid))
            if p:
                photos.append(p)
        except Exception as e:
            print(f"[WARN] コンタクトシート用写真取得スキップ (ID={pid}): {e}")

    if not photos:
        return {"status": "error", "message": "有効な写真データが見つかりませんでした"}

    def _sort_key(item: Dict[str, Any]):
        dt = item.get("date_taken") or ""
        fn = item.get("file_name") or ""
        pid = item.get("id") or 0
        return (dt, fn, pid)

    photos.sort(key=_sort_key)

    # 2. WebPサムネイルの一括取得（未生成時はオンデマンド生成フォールバック）
    valid_ids = [p["id"] for p in photos]
    thumb_map = get_thumbnails_batch(valid_ids)

    # 撮影日範囲と優枚数の集計
    dates = [str(p["date_taken"])[:10].replace(":", "-") for p in photos if p.get("date_taken") and len(str(p["date_taken"])) >= 10]
    if dates:
        min_date, max_date = min(dates), max(dates)
        date_range_str = min_date if min_date == max_date else f"{min_date} 〜 {max_date}"
    else:
        date_range_str = datetime.now().strftime("%Y-%m-%d")

    initial_picks = sum(1 for p in photos if int(p.get("rating") or 0) == 2)

    # 3. 各コマのHTMLカードおよびルーペ用JSONデータの構築
    cards_html_list: List[str] = []
    viewer_items: List[Dict[str, Any]] = []

    for idx, p in enumerate(photos):
        pid = p["id"]
        frame_no = f"#{idx + 1:02d}A"
        file_name = str(p.get("file_name") or f"photo_{pid}")
        date_taken = str(p.get("date_taken") or "")
        cam_model = str(p.get("camera_model") or "")
        lens_model = str(p.get("lens_model") or "")
        rating = int(p.get("rating") or 0)
        is_pick = (rating == 2)
        exif_line = _format_exif_summary(p)
        gear_line = " / ".join([x for x in (cam_model, lens_model) if x and x != "不明"]) or "Camera"

        thumb_info = thumb_map.get(pid)
        thumb_bytes = thumb_info["data"] if thumb_info else None
        if not thumb_bytes and p.get("file_path"):
            try:
                thumb_bytes = ensure_thumbnail(pid, p["file_path"])
            except Exception as e:
                print(f"[WARN] コンタクトシート用サムネイル生成フォールバック失敗 (ID={pid}): {e}")

        if thumb_bytes:
            b64_str = base64.b64encode(thumb_bytes).decode("ascii")
            data_uri = f"data:image/webp;base64,{b64_str}"
        else:
            data_uri = ""

        esc_fn = html.escape(file_name)
        esc_dt = html.escape(date_taken)
        esc_exif = html.escape(exif_line)
        esc_gear = html.escape(gear_line)
        pick_cls = " is-picked" if is_pick else ""

        viewer_items.append({
            "index": idx,
            "frame": frame_no,
            "file_name": file_name,
            "date_taken": date_taken,
            "exif": exif_line,
            "gear": gear_line,
            "rating": rating,
            "picked": is_pick,
            "src": data_uri,
        })

        card_html = f"""
        <article class="film-frame{pick_cls}" data-index="{idx}" data-picked="{'1' if is_pick else '0'}">
            <div class="sprocket-row top" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
            <div class="frame-header">
                <span class="frame-num">{frame_no}</span>
                <span class="frame-gear" title="{esc_gear}">{esc_gear}</span>
                <button type="button" class="grease-toggle-btn" onclick="togglePick(event, {idx})" title="赤鉛筆（グリースペンシル）丸印をON/OFF">⭕</button>
            </div>
            <div class="frame-stage" onclick="openLoupe({idx})">
                <img src="{data_uri}" alt="{esc_fn}" loading="lazy">
                <svg class="grease-circle-svg" viewBox="0 0 120 120" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M 22,58 C 18,26 48,12 78,16 C 106,20 114,52 104,82 C 94,108 54,114 28,96 C 12,84 14,50 30,32" />
                </svg>
            </div>
            <div class="frame-meta">
                <div class="meta-filename" title="{esc_fn}">{esc_fn}</div>
                <div class="meta-exif">{esc_exif}</div>
                <div class="meta-date">{esc_dt}</div>
            </div>
            <div class="sprocket-row bottom" aria-hidden="true">
                <span></span><span></span><span></span><span></span><span></span><span></span>
            </div>
        </article>
        """
        cards_html_list.append(card_html)

    esc_title = html.escape(title_raw)
    esc_date_range = html.escape(date_range_str)
    viewer_json = json.dumps(viewer_items, ensure_ascii=False)
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")

    html_content = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc_title} - Contact Sheet</title>
<style>
:root {{
    --cols: {columns};
    --bg-page: #111214;
    --bg-bar: #1b1d21;
    --bg-frame: #08090a;
    --border-frame: #2c2f36;
    --text-main: #f1f3f5;
    --text-sub: #adb5bd;
    --text-amber: #f59f00;
    --sprocket-color: #25282e;
    --accent-red: #e03131;
}}
body.theme-washi {{
    --bg-page: #f7f4eb;
    --bg-bar: #ede8da;
    --bg-frame: #ffffff;
    --border-frame: #d8d0c0;
    --text-main: #2b2927;
    --text-sub: #6c665f;
    --text-amber: #b45309;
    --sprocket-color: #e6dfd1;
    --accent-red: #c92a2a;
}}
* {{
    box-sizing: border-box;
}}
body {{
    margin: 0;
    padding: 0;
    background: var(--bg-page);
    color: var(--text-main);
    font-family: "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif;
    transition: background 0.2s ease, color 0.2s ease;
}}
.control-bar {{
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--bg-bar);
    border-bottom: 1px solid var(--border-frame);
    padding: 12px 24px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}}
.sheet-header-info {{
    display: flex;
    flex-direction: column;
    gap: 4px;
}}
.sheet-title {{
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0;
    padding: 2px 6px;
    border-radius: 4px;
    outline: none;
    border: 1px dashed transparent;
}}
.sheet-title:hover, .sheet-title:focus {{
    border-color: var(--text-amber);
    background: rgba(255, 255, 255, 0.05);
}}
.sheet-subtitle {{
    font-size: 0.82rem;
    color: var(--text-sub);
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
}}
.control-actions {{
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}}
.ctrl-group {{
    display: inline-flex;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid var(--border-frame);
    border-radius: 6px;
    overflow: hidden;
}}
body.theme-washi .ctrl-group {{
    background: rgba(255, 255, 255, 0.6);
}}
.ctrl-btn {{
    background: transparent;
    color: var(--text-main);
    border: none;
    padding: 6px 11px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.15s;
}}
.ctrl-btn:hover {{
    background: rgba(255, 255, 255, 0.1);
}}
.ctrl-btn.active {{
    background: var(--accent-red);
    color: #fff;
    font-weight: 600;
}}
.print-btn {{
    background: var(--accent-red);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
}}
.print-btn:hover {{
    filter: brightness(1.1);
}}
.sheet-container {{
    max-width: 1680px;
    margin: 0 auto;
    padding: 20px 24px 48px;
}}
.print-sheet-banner {{
    display: none;
    margin-bottom: 14px;
    border-bottom: 2px solid var(--border-frame);
    padding-bottom: 8px;
}}
.contact-grid {{
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    gap: 14px;
}}
.film-frame {{
    background: var(--bg-frame);
    border: 1px solid var(--border-frame);
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    position: relative;
    page-break-inside: avoid;
    break-inside: avoid;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
}}
.film-frame:hover {{
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
}}
body.filter-picked-only .film-frame[data-picked="0"] {{
    display: none !important;
}}
.sprocket-row {{
    display: flex;
    justify-content: space-between;
    padding: 2px 4px;
}}
.sprocket-row span {{
    display: inline-block;
    width: 12px;
    height: 7px;
    border-radius: 2px;
    background: var(--sprocket-color);
}}
.frame-header {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: "Consolas", "Courier New", monospace;
    font-size: 0.75rem;
    color: var(--text-amber);
    gap: 6px;
}}
.frame-num {{
    font-weight: 700;
    letter-spacing: 0.5px;
}}
.frame-gear {{
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-sub);
    font-size: 0.7rem;
}}
.grease-toggle-btn {{
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0 2px;
    opacity: 0.35;
    transition: opacity 0.15s, transform 0.15s;
}}
.film-frame.is-picked .grease-toggle-btn,
.grease-toggle-btn:hover {{
    opacity: 1;
    transform: scale(1.15);
}}
.frame-stage {{
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    cursor: zoom-in;
    border-radius: 3px;
}}
body.theme-washi .frame-stage {{
    background: #f1eee6;
}}
.frame-stage img {{
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
}}
.grease-circle-svg {{
    position: absolute;
    inset: 6%;
    width: 88%;
    height: 88%;
    pointer-events: none;
    opacity: 0;
    transform: scale(0.92);
    transition: opacity 0.18s ease, transform 0.18s ease;
}}
.grease-circle-svg path {{
    fill: none;
    stroke: #ff2b2b;
    stroke-width: 4.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
}}
.film-frame.is-picked .grease-circle-svg {{
    opacity: 0.92;
    transform: scale(1);
}}
.frame-meta {{
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 2px;
}}
.meta-filename {{
    font-size: 0.76rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}}
.meta-exif {{
    font-size: 0.7rem;
    color: var(--text-amber);
    font-family: "Consolas", monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}}
.meta-date {{
    font-size: 0.68rem;
    color: var(--text-sub);
}}
/* 拡大ルーペモーダル */
.loupe-modal {{
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(0, 0, 0, 0.88);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
}}
.loupe-modal.open {{
    display: flex;
}}
.loupe-dialog {{
    background: #181a1e;
    color: #f1f3f5;
    border: 1px solid #343840;
    border-radius: 10px;
    max-width: 960px;
    width: 100%;
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.65);
}}
.loupe-top {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}}
.loupe-stage {{
    position: relative;
    height: 62vh;
    background: #0b0c0e;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    overflow: hidden;
}}
.loupe-stage img {{
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
}}
.loupe-nav-btn {{
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.2);
    width: 42px;
    height: 42px;
    border-radius: 50%;
    font-size: 1.1rem;
    cursor: pointer;
}}
.loupe-nav-btn.prev {{ left: 12px; }}
.loupe-nav-btn.next {{ right: 12px; }}
.loupe-bottom {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 0.85rem;
}}
@media print {{
    @page {{
        size: A4 landscape;
        margin: 10mm;
    }}
    .control-bar, .loupe-modal, .grease-toggle-btn {{
        display: none !important;
    }}
    .print-sheet-banner {{
        display: flex !important;
        justify-content: space-between;
        align-items: baseline;
    }}
    .sheet-container {{
        padding: 0;
        max-width: none;
    }}
    .contact-grid {{
        gap: 8px;
    }}
    .film-frame {{
        box-shadow: none !important;
        transform: none !important;
    }}
}}
</style>
</head>
<body class="theme-{theme}">
    <header class="control-bar">
        <div class="sheet-header-info">
            <h1 id="sheetTitle" class="sheet-title" contenteditable="true" spellcheck="false" title="クリックしてタイトルを編集できます">{esc_title}</h1>
            <div class="sheet-subtitle">
                <span>📅 撮影日: {esc_date_range}</span>
                <span>🎞️ 総コマ数: <strong>{len(photos)}</strong>枚</span>
                <span>⭕ 優(ピック): <strong id="pickCountBadge">{initial_picks}</strong>枚</span>
                <span>🕒 出力: {generated_at}</span>
            </div>
        </div>
        <div class="control-actions">
            <div class="ctrl-group" role="group" aria-label="テーマ切替">
                <button type="button" class="ctrl-btn {'active' if theme == 'darkroom' else ''}" id="btnThemeDark" onclick="setTheme('darkroom')">🌙 暗室ネガシート</button>
                <button type="button" class="ctrl-btn {'active' if theme == 'washi' else ''}" id="btnThemeWashi" onclick="setTheme('washi')">☀️ 和紙プリント</button>
            </div>
            <div class="ctrl-group" role="group" aria-label="列数切替">
                <button type="button" class="ctrl-btn {'active' if columns == 4 else ''}" id="btnCol4" onclick="setColumns(4)">4列</button>
                <button type="button" class="ctrl-btn {'active' if columns == 5 else ''}" id="btnCol5" onclick="setColumns(5)">5列</button>
                <button type="button" class="ctrl-btn {'active' if columns == 6 else ''}" id="btnCol6" onclick="setColumns(6)">6列</button>
            </div>
            <div class="ctrl-group" role="group" aria-label="フィルタ切替">
                <button type="button" class="ctrl-btn active" id="btnFilterAll" onclick="setPickFilter(false)">すべて表示</button>
                <button type="button" class="ctrl-btn" id="btnFilterPicked" onclick="setPickFilter(true)">⭕ 優(ピック)のみ表示</button>
            </div>
            <button type="button" class="print-btn" onclick="window.print()">🖨️ 印刷 / PDF保存</button>
        </div>
    </header>

    <main class="sheet-container">
        <div class="print-sheet-banner">
            <strong id="printBannerTitle" style="font-size:1.2rem;">{esc_title}</strong>
            <span style="font-size:0.82rem;">{esc_date_range} / 全{len(photos)}コマ (Photo Manager Contact Sheet)</span>
        </div>
        <section class="contact-grid" id="contactGrid">
            {"".join(cards_html_list)}
        </section>
    </main>

    <div class="loupe-modal" id="loupeModal" onclick="if(event.target===this)closeLoupe()">
        <div class="loupe-dialog">
            <div class="loupe-top">
                <div>
                    <strong id="loupeFrameNo" style="color:var(--text-amber);margin-right:8px;">#01A</strong>
                    <span id="loupeFileName" style="font-weight:600;"></span>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button type="button" class="ctrl-btn" id="loupePickBtn" onclick="toggleCurrentLoupePick()" style="border:1px solid #444;border-radius:6px;">⭕ 赤丸マーク切替</button>
                    <button type="button" class="ctrl-btn" onclick="closeLoupe()" style="border:1px solid #444;border-radius:6px;">✕ 閉じる (Esc)</button>
                </div>
            </div>
            <div class="loupe-stage">
                <button type="button" class="loupe-nav-btn prev" onclick="stepLoupe(-1)" title="前のコマ (←)">‹</button>
                <img id="loupeImg" src="" alt="">
                <button type="button" class="loupe-nav-btn next" onclick="stepLoupe(1)" title="次のコマ (→)">›</button>
            </div>
            <div class="loupe-bottom">
                <span id="loupeExif" style="color:var(--text-amber);font-family:monospace;"></span>
                <span id="loupeGear" style="color:#adb5bd;"></span>
                <span id="loupeDate" style="color:#adb5bd;"></span>
            </div>
        </div>
    </div>

<script>
const ITEMS = {viewer_json};
let currentLoupeIdx = 0;

const titleEl = document.getElementById('sheetTitle');
const printTitleEl = document.getElementById('printBannerTitle');
if (titleEl && printTitleEl) {{
    titleEl.addEventListener('input', () => {{
        printTitleEl.textContent = titleEl.textContent;
        document.title = titleEl.textContent + ' - Contact Sheet';
    }});
}}

function setTheme(theme) {{
    document.body.classList.remove('theme-darkroom', 'theme-washi');
    document.body.classList.add('theme-' + theme);
    document.getElementById('btnThemeDark').classList.toggle('active', theme === 'darkroom');
    document.getElementById('btnThemeWashi').classList.toggle('active', theme === 'washi');
}}

function setColumns(cols) {{
    document.documentElement.style.setProperty('--cols', String(cols));
    [4, 5, 6].forEach(c => {{
        const btn = document.getElementById('btnCol' + c);
        if (btn) btn.classList.toggle('active', c === cols);
    }});
}}

function setPickFilter(pickedOnly) {{
    document.body.classList.toggle('filter-picked-only', !!pickedOnly);
    document.getElementById('btnFilterAll').classList.toggle('active', !pickedOnly);
    document.getElementById('btnFilterPicked').classList.toggle('active', !!pickedOnly);
}}

function updatePickCount() {{
    const count = ITEMS.filter(it => it.picked).length;
    const badge = document.getElementById('pickCountBadge');
    if (badge) badge.textContent = String(count);
}}

function togglePick(ev, idx) {{
    if (ev) ev.stopPropagation();
    const item = ITEMS[idx];
    if (!item) return;
    item.picked = !item.picked;
    const card = document.querySelector('.film-frame[data-index="' + idx + '"]');
    if (card) {{
        card.classList.toggle('is-picked', item.picked);
        card.setAttribute('data-picked', item.picked ? '1' : '0');
    }}
    updatePickCount();
    if (document.getElementById('loupeModal').classList.contains('open') && currentLoupeIdx === idx) {{
        renderLoupe(idx);
    }}
}}

function openLoupe(idx) {{
    currentLoupeIdx = idx;
    renderLoupe(idx);
    document.getElementById('loupeModal').classList.add('open');
}}

function closeLoupe() {{
    document.getElementById('loupeModal').classList.remove('open');
}}

function renderLoupe(idx) {{
    const item = ITEMS[idx];
    if (!item) return;
    document.getElementById('loupeFrameNo').textContent = item.frame;
    document.getElementById('loupeFileName').textContent = item.file_name;
    document.getElementById('loupeImg').src = item.src;
    document.getElementById('loupeExif').textContent = item.exif;
    document.getElementById('loupeGear').textContent = item.gear;
    document.getElementById('loupeDate').textContent = item.date_taken;
    const pickBtn = document.getElementById('loupePickBtn');
    if (pickBtn) {{
        pickBtn.classList.toggle('active', !!item.picked);
        pickBtn.textContent = item.picked ? '⭕ 赤丸マーク ON' : '⭕ 赤丸マーク OFF';
    }}
}}

function toggleCurrentLoupePick() {{
    togglePick(null, currentLoupeIdx);
}}

function stepLoupe(delta) {{
    const nextIdx = (currentLoupeIdx + delta + ITEMS.length) % ITEMS.length;
    currentLoupeIdx = nextIdx;
    renderLoupe(nextIdx);
}}

document.addEventListener('keydown', (e) => {{
    const modal = document.getElementById('loupeModal');
    if (!modal || !modal.classList.contains('open')) return;
    if (e.key === 'Escape') closeLoupe();
    else if (e.key === 'ArrowLeft') stepLoupe(-1);
    else if (e.key === 'ArrowRight') stepLoupe(1);
}});
</script>
</body>
</html>
"""

    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = dest_dir / f"ContactSheet_{timestamp_str}.html"
    try:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(html_content)
    except Exception as e:
        return {"status": "error", "message": f"コンタクトシートHTMLの書き込みに失敗しました: {e}"}

    if open_after:
        try:
            os.startfile(str(output_path))
        except Exception as e:
            print(f"[WARN] コンタクトシートHTMLの自動オープン失敗 ({output_path}): {e}")

    return {
        "status": "ok",
        "output_path": str(output_path),
        "file_name": output_path.name,
        "destination": str(dest_dir),
        "exported_count": len(photos),
    }


