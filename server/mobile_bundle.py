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
import logging
import re
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger("photo_manager.mobile_bundle")

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
STANDALONE_HTML_FILENAME = "Tetheract_Mobile.html"
STANDALONE_HTML_PATH = BASE_DIR / STANDALONE_HTML_FILENAME

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
    "js/views/touch/touch_layout.js",
    "js/views/touch/touch_gestures.js",
    "js/views/touch/morph_thumb_bar.js",
    "js/views/touch/touch_duel.js",
    "js/views/touch/touch_field_log.js",
    "js/views/touch/touch_phone_case.js",
    "js/views/touch/touch_center_dial.js",
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


if __name__ == "__main__":
    out = ensure_standalone_mobile_html(force=True)
    if out:
        print(f"[OK] Generated: {out} ({out.stat().st_size / 1024:.1f} KB)")
    else:
        raise SystemExit(1)
