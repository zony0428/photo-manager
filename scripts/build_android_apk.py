"""
Tetheract Photo Manager - ポータブル Android (.apk) 自動ビルド＆検証スクリプト

PC環境に Java (JDK) や Android SDK が事前インストールされていなくても、
初回実行時に .android_toolchain/ 配下へポータブル OpenJDK 17 / Android Command-Line Tools /
Gradle 8.5 を自動構築し、フロントエンド Web アセットを同期した上で
デバッグ署名付き Tetheract_Android.apk および Stage 1 UI バンドル (tetheract_ui_bundle.zip) を生成する。

オプション:
  --check-only   ツールチェーンのダウンロードを行わず、プロジェクト構造・アセット同期・
                 Kotlin NativeBridge ⇄ JS DataAdapter 契約・AndroidManifest の整合性を検証する。
  --sync-assets  Webアセットを android/app/src/main/assets/ へ実際に同期する。
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import List, Set, Tuple

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from server.mobile_bundle import (  # noqa: E402
    UI_BUNDLE_SYNC_TARGETS,
    collect_mobile_ui_asset_files,
    get_mobile_ui_bundle_info,
    read_app_version,
    render_stamped_mobile_html,
    write_mobile_ui_bundle_zip,
)

ANDROID_DIR = BASE_DIR / "android"
APP_DIR = ANDROID_DIR / "app"
MAIN_SRC_DIR = APP_DIR / "src" / "main"
JAVA_SRC_ROOT = MAIN_SRC_DIR / "java"
JAVA_PKG_DIR = JAVA_SRC_ROOT / "com" / "tetheract" / "pm"
ASSETS_DIR = MAIN_SRC_DIR / "assets"
FRONTEND_DIR = BASE_DIR / "frontend"
ADAPTERS_DIR = FRONTEND_DIR / "js" / "adapters"
ADAPTER_JS_PATH = ADAPTERS_DIR / "data_adapter.js"

TOOLCHAIN_DIR = BASE_DIR / ".android_toolchain"
JDK_DIR = TOOLCHAIN_DIR / "jdk-17"
SDK_DIR = TOOLCHAIN_DIR / "android-sdk"
GRADLE_DIR = TOOLCHAIN_DIR / "gradle-8.5"

# 公式ポータブルアーカイブ URL (Windows x64)
OPENJDK_WIN_URL = (
    "https://aka.ms/download-jdk/microsoft-jdk-17.0.10-windows-x64.zip"
)
CMDLINE_TOOLS_WIN_URL = (
    "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
)
GRADLE_DIST_URL = "https://services.gradle.org/distributions/gradle-8.5-bin.zip"

REQUIRED_ANDROID_FILES = [
    ANDROID_DIR / "settings.gradle",
    ANDROID_DIR / "build.gradle",
    ANDROID_DIR / "gradle.properties",
    APP_DIR / "build.gradle",
    MAIN_SRC_DIR / "AndroidManifest.xml",
    JAVA_PKG_DIR / "MainActivity.kt",
    JAVA_PKG_DIR / "TetheractNativeBridge.kt",
    JAVA_PKG_DIR / "LockerDatabaseManager.kt",
    JAVA_PKG_DIR / "SafUsbManager.kt",
    JAVA_PKG_DIR / "UsbDownlinkSyncManager.kt",
    JAVA_PKG_DIR / "LoomeVaultCrypto.kt",
    JAVA_PKG_DIR / "PendingJournalStore.kt",
    JAVA_PKG_DIR / "WifiLockerSyncManager.kt",
    JAVA_PKG_DIR / "UsbOfflineUpdater.kt",
    JAVA_PKG_DIR / "FieldLogStore.kt",
    JAVA_PKG_DIR / "FieldLogService.kt",
    JAVA_PKG_DIR / "FieldLogTileService.kt",
    JAVA_PKG_DIR / "FieldLogStartActivity.kt",
    JAVA_PKG_DIR / "FieldLogUploader.kt",
    JAVA_PKG_DIR / "PhoneCaseManager.kt",
    JAVA_PKG_DIR / "PhoneCaseTransferRunner.kt",
    JAVA_PKG_DIR / "PhoneCatalogEngine.kt",
    JAVA_PKG_DIR / "OnnxPrivacyEngine.kt",
    JAVA_PKG_DIR / "QuickShareHelper.kt",
    JAVA_PKG_DIR / "WatermarkAssetStore.kt",
    MAIN_SRC_DIR / "res" / "drawable" / "ic_tile_fieldlog.xml",
    MAIN_SRC_DIR / "res" / "xml" / "file_paths.xml",
    ADAPTER_JS_PATH,
    ADAPTERS_DIR / "field_log_adapter.js",
    ADAPTERS_DIR / "phone_case_adapter.js",
    ADAPTERS_DIR / "watermark_adapter.js",
]

FRONTEND_SYNC_TARGETS = UI_BUNDLE_SYNC_TARGETS


def _read_version() -> Tuple[str, int]:
    """VERSION ファイルから決定論的にバージョン文字列と Android versionCode を算出する"""
    ver_str = read_app_version()
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)", ver_str)
    if m:
        major, minor, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
        ver_code = 30_000_000 + major * 100_000 + minor * 1_000 + patch
    else:
        ver_code = 30_200_000
    return ver_str, ver_code


def _render_stamped_mobile_html(mh_txt: str) -> str:
    """コピー先の assets/mobile.html 用にビルド実行時刻スタンプを注入した文字列を返す（原紙は変更しない）"""
    info = get_mobile_ui_bundle_info()
    ver_str = str(info.get("ui_version") or read_app_version())
    stamp_ms = int(info.get("ui_mtime") or 0)
    stamp_dt = datetime.datetime.fromtimestamp(stamp_ms / 1000.0) if stamp_ms > 0 else datetime.datetime.now()
    return render_stamped_mobile_html(mh_txt, ver_str, stamp_dt)


def stamp_build_version_and_timestamp() -> str:
    """VERSION から算出した versionCode / versionName が未反映の場合のみ android/app/build.gradle を更新する"""
    ver_str, ver_code = _read_version()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    gradle_path = APP_DIR / "build.gradle"
    if gradle_path.exists():
        g_txt = gradle_path.read_text(encoding="utf-8")
        cur_code_m = re.search(r"versionCode\s+(\d+)", g_txt)
        if cur_code_m:
            ver_code = max(ver_code, int(cur_code_m.group(1)))
        new_g_txt = re.sub(r"versionCode\s+\d+", f"versionCode {ver_code}", g_txt)
        new_g_txt = re.sub(r"versionName\s+'[^']*'", f"versionName '{ver_str}'", new_g_txt)
        if new_g_txt != g_txt:
            gradle_path.write_text(new_g_txt, encoding="utf-8")

    return f"{ver_str} (Build {now_str})"


def collect_web_asset_files() -> List[Tuple[Path, str]]:
    """android/app/src/main/assets/ へ同期すべきフロントエンド資産一覧を収集する"""
    return collect_mobile_ui_asset_files()


def sync_launcher_icons_to_android() -> None:
    """frontend/icons/icon-512.png から Android ランチャーアイコン資源 (mipmap / adaptive icon) を自動生成する"""
    src_icon = FRONTEND_DIR / "icons" / "icon-512.png"
    if not src_icon.exists():
        return
    try:
        from PIL import Image
    except ImportError:
        return

    res_dir = MAIN_SRC_DIR / "res"
    with Image.open(src_icon).convert("RGBA") as base_img:
        from PIL import ImageDraw

        mipmap_sizes = {
            "mipmap-mdpi": 48,
            "mipmap-hdpi": 72,
            "mipmap-xhdpi": 96,
            "mipmap-xxhdpi": 144,
            "mipmap-xxxhdpi": 192,
        }
        for folder, px in mipmap_sizes.items():
            out_dir = res_dir / folder
            out_dir.mkdir(parents=True, exist_ok=True)
            resized = base_img.resize((px, px), Image.Resampling.LANCZOS)
            resized.save(out_dir / "ic_launcher.png", format="PNG")

            # 円形ランチャー (ic_launcher_round.png) でも四隅が欠けないようダーク円内に約70%で配置
            round_bg = Image.new("RGBA", (px, px), (0, 0, 0, 0))
            mask = Image.new("L", (px * 2, px * 2), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, px * 2 - 1, px * 2 - 1), fill=255)
            mask = mask.resize((px, px), Image.Resampling.LANCZOS)
            circle_fill = Image.new("RGBA", (px, px), (10, 12, 16, 255))
            round_bg.paste(circle_fill, (0, 0), mask)
            in_px = max(16, int(round(px * 0.70)))
            in_off = (px - in_px) // 2
            in_icon = base_img.resize((in_px, in_px), Image.Resampling.LANCZOS)
            round_bg.paste(in_icon, (in_off, in_off), in_icon)
            round_bg.save(out_dir / "ic_launcher_round.png", format="PNG")

        # Android 8.0+ Adaptive Icon foreground (108dp = 432px, 円形マスク安全圏 66dp = 264px)
        # Pixel等の円形マスクで角丸四角の四隅（対角線長）が欠けないよう 192px (対角約239px < 264px) に縮小配置
        drawable_dir = res_dir / "drawable-xxxhdpi"
        drawable_dir.mkdir(parents=True, exist_ok=True)
        canvas = Image.new("RGBA", (432, 432), (10, 12, 16, 255))
        fg_size = 192
        fg_offset = (432 - fg_size) // 2
        fg_icon = base_img.resize((fg_size, fg_size), Image.Resampling.LANCZOS)
        canvas.paste(fg_icon, (fg_offset, fg_offset), fg_icon)
        canvas.save(drawable_dir / "ic_launcher_foreground.png", format="PNG")


def sync_web_assets_to_android(dry_run: bool = False) -> Tuple[int, int]:
    """フロントエンド Web アセットを android/app/src/main/assets/ へ同期する"""
    files = collect_web_asset_files()
    total_bytes = sum(src.stat().st_size for src, _ in files)
    if dry_run:
        return len(files), total_bytes

    sync_launcher_icons_to_android()

    if ASSETS_DIR.exists():
        shutil.rmtree(ASSETS_DIR)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    for src, rel_posix in files:
        dest = ASSETS_DIR / Path(rel_posix)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if rel_posix == "mobile.html":
            stamped_html = _render_stamped_mobile_html(src.read_text(encoding="utf-8"))
            dest.write_text(stamped_html, encoding="utf-8")
        else:
            shutil.copy2(src, dest)

    # APK内蔵UIのリビジョン照合用メタデータ (ui_bundle_meta.json) を出力
    ui_info = get_mobile_ui_bundle_info()
    (ASSETS_DIR / "ui_bundle_meta.json").write_text(
        json.dumps(ui_info, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # オンデバイスAI検出 (YuNet / LPD-YuNet) 用 ONNX モデルアセットを同期
    privacy_models_dir = BASE_DIR / "models" / "privacy"
    onnx_names = (
        "face_detection_yunet_2023mar.onnx",
        "license_plate_detection_lpd_yunet_2023mar.onnx",
    )
    for model_name in onnx_names:
        m_src = privacy_models_dir / model_name
        if m_src.is_file() and m_src.stat().st_size >= 10_000:
            m_dest = ASSETS_DIR / "models" / "privacy" / model_name
            m_dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(m_src, m_dest)

    return len(files), total_bytes


def build_ui_bundle_zip(output_zip: Path) -> int:
    """Stage 1 USB/Wi-Fi ホットアップデート用の tetheract_ui_bundle.zip を生成する"""
    write_mobile_ui_bundle_zip(output_zip)
    return len(collect_web_asset_files())


def verify_project_integrity(sync_assets: bool = False) -> bool:
    """
    プロジェクト構造・AndroidManifest・Kotlin NativeBridge ⇄ JS DataAdapter・モバイルアセット同期の整合性を検証する
    """
    print("=" * 64)
    print("  Tetheract Android Native Shell & Data Adapter Integrity Check")
    print("=" * 64)

    errors: List[str] = []

    # 1. 必須ファイルの存在検証
    print("\n[1/4] 必須ファイル構成をチェック中...")
    checked_paths: Set[Path] = set()
    all_kt_files = sorted(JAVA_SRC_ROOT.rglob("*.kt")) if JAVA_SRC_ROOT.exists() else []
    all_adapter_files = sorted(ADAPTERS_DIR.glob("*.js")) if ADAPTERS_DIR.exists() else []

    for path in list(REQUIRED_ANDROID_FILES) + all_kt_files + all_adapter_files:
        resolved = path.resolve()
        if resolved in checked_paths:
            continue
        checked_paths.add(resolved)
        rel = path.relative_to(BASE_DIR).as_posix()
        if not path.exists():
            errors.append(f"必須ファイルが見つかりません: {rel}")
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        line_count = len(lines)
        print(f"  - OK: {rel} ({line_count} lines)")

    if errors:
        for err in errors:
            print(f"[ERROR] {err}")
        return False

    # 2. AndroidManifest.xml と Kotlin クラス定義の整合性検証
    print("\n[2/4] AndroidManifest.xml と Kotlin クラスの整合性をチェック中...")
    manifest_path = MAIN_SRC_DIR / "AndroidManifest.xml"
    try:
        tree = ET.parse(manifest_path)
        root = tree.getroot()
        android_ns = "{http://schemas.android.com/apk/res/android}"
        perms = {
            elem.attrib.get(f"{android_ns}name", "")
            for elem in root.findall("uses-permission")
        }
        if "android.permission.REQUEST_INSTALL_PACKAGES" in perms:
            errors.append("Playプロテクト誤検知原因となる REQUEST_INSTALL_PACKAGES が含まれています")

        app_elem = root.find("application")
        if app_elem is None:
            errors.append("<application> 要素が見つかりません")
        else:
            activities = {
                a.attrib.get(f"{android_ns}name", "")
                for a in app_elem.findall("activity")
            }
            if ".MainActivity" not in activities:
                errors.append(".MainActivity が AndroidManifest に登録されていません")
        print("  - OK: AndroidManifest.xml 構文・権限構成正常")
    except Exception as e:
        errors.append(f"AndroidManifest.xml 解析エラー: {e}")

    # 3. Kotlin @JavascriptInterface と JS Adapter 群 (adapters/*.js) のメソッド契約・規約検証
    print("\n[3/4] TetheractNativeBridge.kt <-> adapters/*.js 契約・規約をチェック中...")
    bridge_code = (JAVA_PKG_DIR / "TetheractNativeBridge.kt").read_text(encoding="utf-8")
    exposed_methods: Set[str] = set(
        re.findall(r"@JavascriptInterface\s+fun\s+([A-Za-z0-9_]+)\s*\(", bridge_code)
    )
    print(f"  - Kotlin @JavascriptInterface 公開メソッド ({len(exposed_methods)}個): {', '.join(sorted(exposed_methods))}")

    called_native_methods: Set[str] = set()
    for js_path in all_adapter_files:
        js_rel = js_path.relative_to(BASE_DIR).as_posix()
        js_code = js_path.read_text(encoding="utf-8")
        methods_in_file = set(re.findall(r"TetheractNative\.([A-Za-z0-9_]+)", js_code))
        called_native_methods |= methods_in_file
        missing_in_kotlin = methods_in_file - exposed_methods
        if missing_in_kotlin:
            errors.append(
                f"{js_rel} から呼ばれている未定義のネイティブメソッドがあります: {sorted(missing_in_kotlin)}"
            )

        # Layer 1 禁止事項（DOM操作・toISOString）チェック
        code_without_comments = re.sub(r"//.*|/\*[\s\S]*?\*/", "", js_code)
        for forbidden in ("document.getElementById", "document.querySelector", ".innerHTML", "toISOString("):
            if forbidden in code_without_comments:
                errors.append(f"{js_rel} 内に禁止API '{forbidden}' が含まれています")

    if not errors:
        print(
            f"  - OK: adapters/*.js ({len(all_adapter_files)}ファイル) の呼び出しメソッド "
            f"({len(called_native_methods)}個) がすべて Kotlin 側と一致"
        )

    # data_adapter.js の必須公開APIチェック
    adapter_code = ADAPTER_JS_PATH.read_text(encoding="utf-8")
    required_js_apis = [
        "detectRuntimeMode",
        "getLockerStatus",
        "selectUsbFolderAndSyncLocker",
        "refreshLockerFromUsbIfUpdated",
        "queryPhotos",
        "getFilterTrees",
        "getThumbnailUrl",
        "savePhotoChanges",
        "savePhotoChangesBatch",
        "syncPendingChangesToUsbOrServer",
        "checkAndTriggerUsbUpdate",
    ]
    for api_name in required_js_apis:
        if f"function {api_name}" not in adapter_code:
            errors.append(f"data_adapter.js に必須関数 {api_name} が定義されていません")

    # Kotlin 側の必須クラス・WebView shouldInterceptRequest・_v170_guard 対応チェック
    locker_code = (JAVA_PKG_DIR / "LockerDatabaseManager.kt").read_text(encoding="utf-8")
    if "_v170_guard" not in locker_code or "pending_journal.db" not in locker_code:
        errors.append("LockerDatabaseManager.kt に _v170_guard 対応または pending_journal.db 管理が不足しています")

    main_kt_code = (JAVA_PKG_DIR / "MainActivity.kt").read_text(encoding="utf-8")
    if "shouldInterceptRequest" not in main_kt_code or "appassets.tetheract.local" not in main_kt_code:
        errors.append("MainActivity.kt に shouldInterceptRequest / appassets.tetheract.local インターセプトが不足しています")

    # 4. フロントエンド Web アセット同期・mobile.html 参照漏れ検証
    print("\n[4/4] フロントエンド Web アセット構成をチェック中...")
    collected_rels = {rel for _, rel in collect_web_asset_files()}
    mh_src_path = FRONTEND_DIR / "mobile.html"
    if mh_src_path.exists():
        mh_raw = mh_src_path.read_text(encoding="utf-8")
        refs = re.findall(r'(?:href|src)="(/[^"?#]+)', mh_raw)
        missing_refs = sorted(
            {r.lstrip("/") for r in refs if not r.startswith("/api/")} - collected_rels
        )
        if missing_refs:
            errors.append(f"mobile.html が参照するアセットが FRONTEND_SYNC_TARGETS から漏れています: {missing_refs}")

    file_count, total_bytes = sync_web_assets_to_android(dry_run=not sync_assets)
    if file_count == 0:
        errors.append("フロントエンド Web アセットが見つかりません")
    else:
        mode_label = "実同期完了" if sync_assets else "ドライラン検証OK"
        print(
            f"  - OK: Webアセット {file_count} ファイル ({total_bytes / (1024 * 1024):.2f} MB) [{mode_label}]"
        )

    if errors:
        print("\n[FAILED] 整合性検証でエラーが検出されました:")
        for err in errors:
            print(f"  - {err}")
        return False

    print("\n[SUCCESS] Android プロジェクト・ネイティブブリッジ・データアダプタの全検証に合格しました！")
    return True


def _download_and_extract_zip(url: str, target_dir: Path, label: str) -> None:
    """指定URLからZIPをダウンロードして target_dir へ展開する"""
    TOOLCHAIN_DIR.mkdir(parents=True, exist_ok=True)
    tmp_zip = TOOLCHAIN_DIR / f"{label}.zip"
    print(f"[Toolchain] {label} をダウンロード中...\n  URL: {url}")
    urllib.request.urlretrieve(url, tmp_zip)
    print(f"[Toolchain] {label} を展開中...")
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(tmp_zip, "r") as zf:
        zf.extractall(target_dir)
    try:
        tmp_zip.unlink()
    except Exception as e:
        print(f"[WARN] 一時ZIP削除スキップ: {e}")


def ensure_portable_jdk() -> Path:
    """ポータブル OpenJDK 17 を準備して JAVA_HOME パスを返す"""
    env_java = os.environ.get("JAVA_HOME")
    if env_java and (Path(env_java) / "bin" / "java.exe").exists():
        return Path(env_java)

    existing = list(JDK_DIR.rglob("java.exe")) if JDK_DIR.exists() else []
    if not existing:
        _download_and_extract_zip(OPENJDK_WIN_URL, JDK_DIR, "openjdk-17")
        existing = list(JDK_DIR.rglob("java.exe"))
    if not existing:
        raise RuntimeError("ポータブル OpenJDK 17 の展開に失敗しました")
    return existing[0].parent.parent


def ensure_portable_android_sdk(java_home: Path) -> Path:
    """ポータブル Android SDK (platforms;android-34, build-tools;34.0.0) を準備する"""
    env_sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if env_sdk and (Path(env_sdk) / "platforms" / "android-34").exists():
        return Path(env_sdk)

    cmdline_dir = SDK_DIR / "cmdline-tools" / "latest"
    sdkmanager_bat = cmdline_dir / "bin" / "sdkmanager.bat"
    if not sdkmanager_bat.exists():
        raw_extract = TOOLCHAIN_DIR / "cmdline_tmp"
        if raw_extract.exists():
            shutil.rmtree(raw_extract)
        _download_and_extract_zip(CMDLINE_TOOLS_WIN_URL, raw_extract, "android-cmdline-tools")
        cmdline_dir.parent.mkdir(parents=True, exist_ok=True)
        extracted_inner = raw_extract / "cmdline-tools"
        if extracted_inner.exists():
            shutil.move(str(extracted_inner), str(cmdline_dir))
        shutil.rmtree(raw_extract, ignore_errors=True)

    platform_34 = SDK_DIR / "platforms" / "android-34"
    if not platform_34.exists():
        print("[Toolchain] Android SDK パッケージ (android-34 / build-tools;34.0.0) を導入中...")
        env = os.environ.copy()
        env["JAVA_HOME"] = str(java_home)
        env["ANDROID_HOME"] = str(SDK_DIR)
        yes_input = "y\n" * 20
        res = subprocess.run(
            [
                str(sdkmanager_bat),
                f"--sdk_root={SDK_DIR}",
                "platform-tools",
                "platforms;android-34",
                "build-tools;34.0.0",
            ],
            input=yes_input,
            text=True,
            env=env,
        )
        if res.returncode != 0:
            raise RuntimeError("sdkmanager による Android SDK パッケージ導入に失敗しました")
    return SDK_DIR


def ensure_portable_gradle() -> Path:
    """ポータブル Gradle 8.5 を準備して gradle.bat のパスを返す"""
    existing = list(GRADLE_DIR.rglob("gradle.bat")) if GRADLE_DIR.exists() else []
    if not existing:
        _download_and_extract_zip(GRADLE_DIST_URL, GRADLE_DIR, "gradle-8.5")
        existing = list(GRADLE_DIR.rglob("gradle.bat"))
    if not existing:
        raise RuntimeError("ポータブル Gradle 8.5 の展開に失敗しました")
    return existing[0]


def ensure_release_keystore(java_home: Path) -> Path:
    """Playプロテクトのdebuggable警告を回避するため、専用リリース署名キーストアを準備・同期する"""
    ks_path = TOOLCHAIN_DIR / "tetheract-release.jks"
    shared_ks = ANDROID_DIR / "tetheract-release.jks"
    if shared_ks.exists():
        TOOLCHAIN_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(shared_ks, ks_path)
        return ks_path
    if ks_path.exists():
        return ks_path
    TOOLCHAIN_DIR.mkdir(parents=True, exist_ok=True)
    keytool_exe = java_home / "bin" / "keytool.exe"
    subprocess.run(
        [
            str(keytool_exe),
            "-genkeypair",
            "-v",
            "-keystore",
            str(ks_path),
            "-alias",
            "tetheract",
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-validity",
            "10000",
            "-storepass",
            "tetheract_release_key",
            "-keypass",
            "tetheract_release_key",
            "-dname",
            "CN=Tetheract Photo Manager, OU=Tetheract Project, O=Tetheract, L=Tokyo, ST=Tokyo, C=JP",
        ],
        check=True,
    )
    return ks_path


def build_apk() -> int:
    """ポータブルツールチェーンを整え、アセット同期・リリース署名APKビルド・配布出力を実行する"""
    stamped_ver = stamp_build_version_and_timestamp()
    print(f"[Stamp] APK Version & Build Timestamp: {stamped_ver}")
    if not verify_project_integrity(sync_assets=True):
        return 1

    java_home = ensure_portable_jdk()
    sdk_root = ensure_portable_android_sdk(java_home)
    gradle_bat = ensure_portable_gradle()
    ks_path = ensure_release_keystore(java_home)

    local_props = ANDROID_DIR / "local.properties"
    sdk_escaped = str(sdk_root).replace("\\", "\\\\")
    local_props.write_text(f"sdk.dir={sdk_escaped}\n", encoding="utf-8")

    env = os.environ.copy()
    env["JAVA_HOME"] = str(java_home)
    env["ANDROID_HOME"] = str(sdk_root)
    env["ANDROID_SDK_ROOT"] = str(sdk_root)

    print("\n[Build] Gradle assembleRelease を実行しています...")
    res = subprocess.run(
        [str(gradle_bat), "-p", str(ANDROID_DIR), "assembleRelease", "--no-daemon"],
        env=env,
    )
    if res.returncode != 0:
        print("[ERROR] APK のビルドに失敗しました。")
        return res.returncode

    built_apk = APP_DIR / "build" / "outputs" / "apk" / "release" / "app-release.apk"
    if not built_apk.exists():
        print(f"[ERROR] ビルド出力が見つかりません: {built_apk}")
        return 1

    # 明示的な apksigner (v1 + v2 + v3 全スキーム署名 ＆ 検証)
    apksigner_candidates = list(sdk_root.rglob("apksigner.bat"))
    if apksigner_candidates:
        apksigner_bat = apksigner_candidates[0]
        subprocess.run(
            [
                str(apksigner_bat),
                "sign",
                "--ks",
                str(ks_path),
                "--ks-key-alias",
                "tetheract",
                "--ks-pass",
                "pass:tetheract_release_key",
                "--key-pass",
                "pass:tetheract_release_key",
                "--v1-signing-enabled",
                "true",
                "--v2-signing-enabled",
                "true",
                "--v3-signing-enabled",
                "true",
                str(built_apk),
            ],
            env=env,
            check=True,
        )
        subprocess.run(
            [str(apksigner_bat), "verify", "--verbose", str(built_apk)],
            env=env,
            check=True,
        )

    out_dir = BASE_DIR / "dist_v2" / "android"
    out_dir.mkdir(parents=True, exist_ok=True)
    target_apk = out_dir / "Tetheract_Android.apk"
    shutil.copy2(built_apk, target_apk)

    bundle_zip = out_dir / "tetheract_ui_bundle.zip"
    build_ui_bundle_zip(bundle_zip)

    out_upd_dir = BASE_DIR / "dist_v2_update" / "android"
    out_upd_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target_apk, out_upd_dir / "Tetheract_Android.apk")
    shutil.copy2(bundle_zip, out_upd_dir / "tetheract_ui_bundle.zip")

    ver_str, _ = _read_version()
    print("=" * 64)
    print(f"  [SUCCESS] Tetheract Android APK (v{ver_str}) ビルド完了!")
    print(f"  - APK本体       : {target_apk}")
    print(f"  - 差分更新APK   : {out_upd_dir / 'Tetheract_Android.apk'}")
    print(f"  - Stage 1 バンドル: {bundle_zip}")
    print("=" * 64)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Tetheract Android APK ポータブルビルドツール")
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="ツールチェーンをダウンロードせず、プロジェクト構成とコード整合性のみを検証する",
    )
    parser.add_argument(
        "--sync-assets",
        action="store_true",
        help="Webアセットを android/app/src/main/assets/ へ実コピーする",
    )
    args = parser.parse_args()

    if args.check_only:
        ok = verify_project_integrity(sync_assets=args.sync_assets)
        return 0 if ok else 1

    try:
        return build_apk()
    except Exception as e:
        print(f"\n[ERROR] ビルド処理中に例外が発生しました: {e}")
        return 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main())
