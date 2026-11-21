"""
モバイル専用UI (mobile.html) の完全インライン化（Single-File HTML）バンドル生成モジュール

目的:
1. Android Chrome / ファイルマネージャー (content:// や file://) や Android WebView から直接開いた際、
   外部ファイル (CSS, JS, sql-wasm.wasm) の読み込みがブラウザのセキュリティ制限で
   ブロックされる問題を100%解消する。
2. 非HTTPSのローカルIP (http://192.168.x.x:8088/m) では Service Worker (PWAオフラインキャッシュ) が
   機能しないブラウザ仕様に対し、USBルートまたはスマホ本体に保存した単一HTMLファイル
   (Tetheract_Mobile.html) だけで完全オフライン起動・library.db 読込・選別を可能にする。
3. 3層分離アーキテクチャ（Layer 1: adapters/, Layer 2: core/, Layer 3: views/touch/ + mobile.js）を
   開発時は疎結合モジュールのまま保ち、配布用単体HTML生成時に自動結合する。
4. セキュリティ配慮:
   - ユーザーデータ（写真・DB中身・PCのIPアドレス・ローカルフォルダパス等）は一切埋め込まず、
     純粋な静的UIプログラムとWebAssembly SQLiteエンジンのみを格納する。
   - 厳格な Content-Security-Policy (CSP) メタタグを付与し、外部スクリプト注入や不正通信を防止する。
"""

import base64
import datetime
import hashlib
import json
import logging
import re
import threading
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("photo_manager.mobile_bundle")

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
STANDALONE_HTML_FILENAME = "Tetheract_Mobile.html"
STANDALONE_HTML_PATH = BASE_DIR / STANDALONE_HTML_FILENAME
UI_BUNDLE_FILENAME = "tetheract_ui_bundle.zip"
UI_BUNDLE_PATH = BASE_DIR / "cache" / UI_BUNDLE_FILENAME
UI_BUNDLE_META_PATH = BASE_DIR / "cache" / "tetheract_ui_bundle_meta.json"

UI_BUNDLE_SYNC_TARGETS: List[str] = [
    "mobile.html",
    "manifest_mobile.json",
    "sw_mobile.js",
    "favicon.ico",
    "css/mobile.css",
    "css/touch-responsive.css",
    "css/touch-fieldlog.css",
    "js/core",
    "js/adapters",
    "js/views/touch",
    "js/privacy_mask_editor.js",
    "js/mobile.js",
    "icons",
    "vendor/sqljs",
]

_ui_bundle_lock = threading.Lock()
_ui_bundle_info_cache: Dict[str, Any] = {"sig": None, "info": None}

# 厳格なCSP設定（インラインCSS/JS・WASMメモリ実行・Blob/Data URL画像・Android WebView内部ストリームのみ許可）
CSP_META_TAG = (
    '<meta http-equiv="Content-Security-Policy" '
    "content=\"default-src 'self' https://appassets.tetheract.local blob: data:; "
    "img-src 'self' https://appassets.tetheract.local http: https: blob: data:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
    "connect-src 'self' https://appassets.tetheract.local http: https: data: blob:; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none';\">"
)

MOBILE_CSS_REL_PATHS: List[str] = [
    "css/mobile.css",
    "css/touch-responsive.css",
    "css/touch-fieldlog.css",
]

MOBILE_JS_REL_PATHS: List[str] = [
    "js/core/tree_builder.js",
    "js/adapters/data_adapter.js",
    "js/adapters/field_log_adapter.js",
    "js/adapters/phone_case_adapter.js",
    "js/adapters/watermark_adapter.js",
    "js/views/touch/touch_layout.js",
    "js/views/touch/touch_gestures.js",
    "js/views/touch/morph_thumb_bar.js",
    "js/views/touch/touch_duel.js",
    "js/views/touch/touch_field_log.js",
    "js/views/touch/touch_phone_case.js",
    "js/views/touch/touch_center_dial.js",
    "js/views/touch/touch_viewer_launcher.js",
    "js/privacy_mask_editor.js",
    "js/views/touch/touch_art_framer.js",
    "js/mobile.js",
]


def _read_text_utf8(path: Path) -> str:
    """UTF-8でテキストファイルを安全に読み込む"""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _read_base64(path: Path) -> str:
    """バイナリファイルを読み込みBase64文字列として返す"""
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def build_standalone_mobile_html() -> str:
    """
    frontend/mobile.html と依存アセット (mobile.css, touch-responsive.css, sql-wasm.*,
    Layer 1/2/3 JSモジュール群, mobile.js, アイコン) を単一の自己完結型 HTML 文字列に結合して返す。
    """
    mobile_html_path = FRONTEND_DIR / "mobile.html"
    sql_js_path = FRONTEND_DIR / "vendor" / "sqljs" / "sql-wasm.js"
    sql_wasm_path = FRONTEND_DIR / "vendor" / "sqljs" / "sql-wasm.wasm"
    icon_png_path = FRONTEND_DIR / "icons" / "icon-192.png"

    html = _read_text_utf8(mobile_html_path)
    sql_js_content = _read_text_utf8(sql_js_path)
    sql_wasm_b64 = _read_base64(sql_wasm_path)

    # アイコンをData URI化（file:// や content:// で404を出さないため）
    if icon_png_path.exists():
        icon_data_uri = f"data:image/png;base64,{_read_base64(icon_png_path)}"
    else:
        icon_data_uri = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"

    # 1. アイコン・マニフェスト参照の置換・除去（ローカルファイル起動時のCORSエラー防止）
    html = re.sub(
        r'<link\s+rel="icon"[^>]*>',
        f'<link rel="icon" type="image/png" href="{icon_data_uri}">',
        html,
    )
    html = re.sub(
        r'<link\s+rel="apple-touch-icon"[^>]*>',
        f'<link rel="apple-touch-icon" href="{icon_data_uri}">',
        html,
    )
    html = re.sub(
        r'src="/icons/icon-192\.png[^"]*"',
        f'src="{icon_data_uri}"',
        html,
    )
    html = re.sub(r'<link\s+rel="manifest"[^>]*>\s*', "", html)

    # 2. CSPメタタグの挿入（まだ存在しない場合）
    if 'http-equiv="Content-Security-Policy"' not in html:
        html = html.replace(
            '<meta charset="UTF-8">',
            f'<meta charset="UTF-8">\n  {CSP_META_TAG}',
            1,
        )

    # 3. CSS群のインライン埋め込み
    for rel_css in MOBILE_CSS_REL_PATHS:
        css_path = FRONTEND_DIR / Path(rel_css)
        if not css_path.exists():
            continue
        css_content = _read_text_utf8(css_path)
        inline_style_block = f"<style>\n/* === Inlined {rel_css} === */\n{css_content}\n</style>"
        pattern = rf'<link\s+rel="stylesheet"\s+href="/{re.escape(rel_css)}[^"]*">'
        html = re.sub(pattern, lambda _, b=inline_style_block: b, html, count=1)

    # 4. sql-wasm.js + sql-wasm.wasm (Base64) のインライン埋め込み
    safe_sql_js = sql_js_content.replace("</script>", "<\\/script>")
    inline_sql_block = (
        "<script>\n"
        "window.__PM_STANDALONE_HTML__ = true;\n"
        f'window.__PM_SQL_WASM_BASE64__ = "{sql_wasm_b64}";\n'
        f"{safe_sql_js}\n"
        "</script>"
    )
    html = re.sub(
        r'<script\s+src="/vendor/sqljs/sql-wasm\.js[^"]*"></script>',
        lambda _: inline_sql_block,
        html,
        count=1,
    )

    # 5. Layer 1/2/3 JSモジュール群および mobile.js のインライン埋め込み
    for rel_js in MOBILE_JS_REL_PATHS:
        js_path = FRONTEND_DIR / Path(rel_js)
        if not js_path.exists():
            continue
        js_content = _read_text_utf8(js_path)
        safe_js = js_content.replace("</script>", "<\\/script>")
        inline_js_block = f"<script>\n/* === Inlined {rel_js} === */\n{safe_js}\n</script>"
        pattern = rf'<script\s+src="/{re.escape(rel_js)}[^"]*"></script>'
        html = re.sub(pattern, lambda _, b=inline_js_block: b, html, count=1)

    return html


def ensure_standalone_mobile_html(force: bool = False) -> Optional[Path]:
    """
    ソースファイル群 (mobile.html, CSS群, Layer 1/2/3 JS群, sql-wasm.*) の更新日時を確認し、
    必要であればプロジェクトルート直下の Tetheract_Mobile.html を最新化する。
    """
    try:
        legacy_html = BASE_DIR / "PhotoManager_Mobile.html"
        source_files: List[Path] = [
            FRONTEND_DIR / "mobile.html",
            FRONTEND_DIR / "vendor" / "sqljs" / "sql-wasm.js",
            FRONTEND_DIR / "vendor" / "sqljs" / "sql-wasm.wasm",
            Path(__file__).resolve(),
        ]
        for rel_css in MOBILE_CSS_REL_PATHS:
            source_files.append(FRONTEND_DIR / Path(rel_css))
        for rel_js in MOBILE_JS_REL_PATHS:
            source_files.append(FRONTEND_DIR / Path(rel_js))

        for src in source_files:
            if not src.exists():
                logger.warning(f"単体モバイルHTML生成に必要なソースが見つかりません: {src}")
                return None

        if not force and STANDALONE_HTML_PATH.exists():
            target_mtime = STANDALONE_HTML_PATH.stat().st_mtime
            latest_src_mtime = max(s.stat().st_mtime for s in source_files)
            if target_mtime >= latest_src_mtime:
                if legacy_html.exists():
                    try:
                        legacy_html.unlink()
                    except Exception as e:
                        logger.warning(f"旧モバイルHTMLの削除に失敗しました: {e}")
                return STANDALONE_HTML_PATH

        bundled_html = build_standalone_mobile_html()
        with open(STANDALONE_HTML_PATH, "w", encoding="utf-8", newline="\n") as f:
            f.write(bundled_html)

        if legacy_html.exists():
            try:
                legacy_html.unlink()
            except Exception as e:
                logger.warning(f"旧モバイルHTMLの削除に失敗しました: {e}")

        logger.info(
            f"単体完結型モバイルHTMLを生成しました: {STANDALONE_HTML_PATH.name} "
            f"({len(bundled_html) / 1024:.1f} KB)"
        )
        return STANDALONE_HTML_PATH
    except Exception as e:
        logger.error(f"単体モバイルHTMLの生成に失敗しました: {e}")
        return None


def read_app_version() -> str:
    """ルートの VERSION ファイルからアプリバージョン文字列を取得する"""
    ver_file = BASE_DIR / "VERSION"
    if ver_file.exists():
        try:
            lines = ver_file.read_text(encoding="utf-8").splitlines()
            if lines and lines[0].strip():
                return lines[0].strip()
        except Exception as e:
            logger.debug(f"VERSION 読込スキップ: {e}")
    return "2.0.0"


def collect_mobile_ui_asset_files() -> List[Tuple[Path, str]]:
    """Android UIバンドル・アセット同期対象のフロントエンドファイル一覧を収集する"""
    collected: List[Tuple[Path, str]] = []
    for rel_name in UI_BUNDLE_SYNC_TARGETS:
        src = FRONTEND_DIR / rel_name
        if not src.exists():
            continue
        if src.is_file():
            collected.append((src, rel_name))
        elif src.is_dir():
            for child in sorted(src.rglob("*")):
                if child.is_file() and not child.name.endswith((".pyc", ".tmp")):
                    rel_path = child.relative_to(FRONTEND_DIR).as_posix()
                    collected.append((child, rel_path))
    return collected


def render_stamped_mobile_html(
    mh_txt: str,
    ver_str: str,
    stamp_dt: Optional[datetime.datetime] = None,
) -> str:
    """配信・バンドル用にビルド日時とバージョンを注入した mobile.html 文字列を返す（原紙は変更しない）"""
    now = stamp_dt or datetime.datetime.now()
    now_str = now.strftime("%Y-%m-%d %H:%M")
    short_ts = now.strftime("%m/%d %H:%M")
    full_ver_name = f"{ver_str} (Build {now_str})"
    short_badge = f"v{ver_str} ({short_ts})"

    stamped = re.sub(
        r'(<span id="mAppBuildBadge"[^>]*>)[^<]*(</span>)',
        f"\\g<1>{short_badge}\\g<2>",
        mh_txt,
    )
    stamped = re.sub(
        r'(<div id="mModalAppBuildInfo"[^>]*>)[^<]*(</div>)',
        f"\\g<1>TETHERACT pm · v{full_ver_name}\\g<2>",
        stamped,
    )
    return stamped


def collect_android_native_source_files() -> List[Tuple[Path, str]]:
    """Android ネイティブ層（Kotlin / Manifest / Gradle）のソースファイル一覧を収集する"""
    android_dir = BASE_DIR / "android"
    if not android_dir.is_dir():
        return []

    candidates: List[Path] = [
        android_dir / "settings.gradle",
        android_dir / "build.gradle",
        android_dir / "gradle.properties",
        android_dir / "app" / "build.gradle",
        android_dir / "app" / "src" / "main" / "AndroidManifest.xml",
        android_dir / "app" / "src" / "main" / "res" / "drawable" / "ic_tile_fieldlog.xml",
    ]
    java_dir = android_dir / "app" / "src" / "main" / "java"
    if java_dir.is_dir():
        candidates.extend(sorted(java_dir.rglob("*.kt")))

    collected: List[Tuple[Path, str]] = []
    for p in candidates:
        if p.is_file():
            collected.append((p, p.relative_to(BASE_DIR).as_posix()))
    return collected


def find_prebuilt_android_apk() -> Optional[Path]:
    """配信可能なビルド済み Android APK (Tetheract_Android.apk) のパスを返す"""
    candidates = [
        BASE_DIR / "android" / "Tetheract_Android.apk",
        BASE_DIR / "dist_v2" / "android" / "Tetheract_Android.apk",
        BASE_DIR / "dist" / "android" / "Tetheract_Android.apk",
    ]
    for p in candidates:
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None


def _read_native_revision_from_prebuilt_apk() -> str:
    """配布環境等で Kotlin ソースが無い場合、同梱済み APK 内の ui_bundle_meta.json から native_revision を取得する"""
    apk_path = find_prebuilt_android_apk()
    if not apk_path:
        return ""
    try:
        with zipfile.ZipFile(apk_path, "r") as zf:
            if "assets/ui_bundle_meta.json" in zf.namelist():
                meta = json.loads(zf.read("assets/ui_bundle_meta.json").decode("utf-8"))
                return str(meta.get("native_revision") or "").strip()
    except Exception as e:
        logger.debug(f"APK内蔵メタからの native_revision 読取スキップ: {e}")
    return ""


def get_mobile_ui_bundle_info() -> Dict[str, Any]:
    """モバイルUIアセット群・VERSION・Androidネイティブソースから決定論的リビジョン情報を算出する"""
    files = collect_mobile_ui_asset_files()
    native_files = collect_android_native_source_files()
    ver_file = BASE_DIR / "VERSION"
    ver_stat = ver_file.stat() if ver_file.exists() else None
    ver_sig = (ver_stat.st_mtime_ns, ver_stat.st_size) if ver_stat else (0, 0)

    apk_path = find_prebuilt_android_apk() if not native_files else None
    apk_stat = apk_path.stat() if apk_path else None
    apk_sig = (str(apk_path), apk_stat.st_mtime_ns, apk_stat.st_size) if apk_path and apk_stat else None

    sig_items: List[Any] = [ver_sig, apk_sig]
    max_mtime_ns = ver_stat.st_mtime_ns if ver_stat else 0
    for src, rel_posix in files:
        st = src.stat()
        sig_items.append(("ui", rel_posix, st.st_mtime_ns, st.st_size))
        if st.st_mtime_ns > max_mtime_ns:
            max_mtime_ns = st.st_mtime_ns
    for src, rel_posix in native_files:
        st = src.stat()
        sig_items.append(("native", rel_posix, st.st_mtime_ns, st.st_size))
    sig = tuple(sig_items)

    with _ui_bundle_lock:
        cached_info = _ui_bundle_info_cache.get("info")
        if _ui_bundle_info_cache.get("sig") == sig and isinstance(cached_info, dict):
            return dict(cached_info)

        ver_str = read_app_version()
        ui_hasher = hashlib.sha256()
        ui_hasher.update(f"version:{ver_str}\n".encode("utf-8"))
        for src, rel_posix in files:
            file_hash = hashlib.sha256(src.read_bytes()).hexdigest()
            ui_hasher.update(f"{rel_posix}:{file_hash}\n".encode("utf-8"))

        if native_files:
            native_hasher = hashlib.sha256()
            for src, rel_posix in native_files:
                file_hash = hashlib.sha256(src.read_bytes()).hexdigest()
                native_hasher.update(f"{rel_posix}:{file_hash}\n".encode("utf-8"))
            native_revision = native_hasher.hexdigest()[:16]
        else:
            native_revision = _read_native_revision_from_prebuilt_apk()

        ui_revision = ui_hasher.hexdigest()[:16]
        ui_mtime = int(max_mtime_ns // 1_000_000) if max_mtime_ns > 0 else int(datetime.datetime.now().timestamp() * 1000)
        info = {
            "ui_revision": ui_revision,
            "native_revision": native_revision,
            "ui_mtime": ui_mtime,
            "ui_version": ver_str,
        }
        _ui_bundle_info_cache["sig"] = sig
        _ui_bundle_info_cache["info"] = dict(info)
        return info


def write_mobile_ui_bundle_zip(
    output_zip: Path,
    info: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """指定パスへモバイルUIホットアップデート用 ZIP (tetheract_ui_bundle.zip) を原子的に生成する"""
    bundle_info = dict(info) if info else get_mobile_ui_bundle_info()
    stamp_ms = int(bundle_info.get("ui_mtime") or 0)
    stamp_dt = datetime.datetime.fromtimestamp(stamp_ms / 1000.0) if stamp_ms > 0 else datetime.datetime.now()
    ver_str = str(bundle_info.get("ui_version") or read_app_version())

    files = collect_mobile_ui_asset_files()
    output_zip.parent.mkdir(parents=True, exist_ok=True)
    tmp_zip = output_zip.with_name(f".{output_zip.name}.{threading.get_ident()}.tmp")
    try:
        with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for src, rel_posix in files:
                if rel_posix == "mobile.html":
                    stamped_html = render_stamped_mobile_html(_read_text_utf8(src), ver_str, stamp_dt)
                    zf.writestr(rel_posix, stamped_html.encode("utf-8"))
                else:
                    zf.write(src, arcname=rel_posix)
            zf.writestr(
                "ui_bundle_meta.json",
                json.dumps(bundle_info, ensure_ascii=False, indent=2).encode("utf-8"),
            )
        tmp_zip.replace(output_zip)
    finally:
        if tmp_zip.exists():
            try:
                tmp_zip.unlink()
            except Exception:
                pass
    return bundle_info


def ensure_mobile_ui_bundle_zip(force: bool = False) -> Tuple[Optional[Path], Dict[str, Any]]:
    """
    モバイルUIアセットの変更を検知し、必要時のみ cache/tetheract_ui_bundle.zip を最新化して返す。
    """
    info = get_mobile_ui_bundle_info()
    with _ui_bundle_lock:
        try:
            if not force and UI_BUNDLE_PATH.exists() and UI_BUNDLE_PATH.stat().st_size > 0 and UI_BUNDLE_META_PATH.exists():
                meta = json.loads(UI_BUNDLE_META_PATH.read_text(encoding="utf-8"))
                if meta.get("ui_revision") == info["ui_revision"] and meta.get("native_revision") == info["native_revision"]:
                    return UI_BUNDLE_PATH, info
        except Exception as e:
            logger.debug(f"UIバンドルメタ読込スキップ: {e}")

        try:
            write_mobile_ui_bundle_zip(UI_BUNDLE_PATH, info)
            UI_BUNDLE_META_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp_meta = UI_BUNDLE_META_PATH.with_name(f".{UI_BUNDLE_META_PATH.name}.tmp")
            tmp_meta.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_meta.replace(UI_BUNDLE_META_PATH)
            return UI_BUNDLE_PATH, info
        except Exception as e:
            logger.error(f"UIバンドルZIPの生成に失敗しました: {e}")
            return None, info


if __name__ == "__main__":
    out = ensure_standalone_mobile_html(force=True)
    if out:
        print(f"[OK] Generated: {out} ({out.stat().st_size / 1024:.1f} KB)")
    else:
        raise SystemExit(1)
