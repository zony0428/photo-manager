"""
フロントエンド HTML / JS / CSS 静的整合性・スモークテスト (標準ライブラリのみ・DB非接触)
- frontend/index.html と frontend/mobile.html が参照する全ローカルアセットの実在・重複なし検証
- mobile.html と server/mobile_bundle.py のインライン化対象リスト同期検証
- 全 JS / CSS ファイルの未閉鎖リテラル・括弧アンバランス・マージ競合マーカー検査
- チェリーピック漏れ等の未定義グローバル関数呼び出し（hasBakedAdjustments 等）・禁止API検査
"""

from html.parser import HTMLParser
from pathlib import Path
import re
import sys
import unittest
from typing import Dict, List, Sequence, Set, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from server.mobile_bundle import MOBILE_CSS_REL_PATHS, MOBILE_JS_REL_PATHS  # noqa: E402

FRONTEND_DIR = PROJECT_ROOT / "frontend"

_REGEX_PREV_KEYWORDS = {
    "return", "typeof", "instanceof", "in", "of", "void", "delete",
    "throw", "new", "case", "yield", "await", "else", "do",
}

_JS_KEYWORDS_AND_BUILTINS = {
    "if", "for", "while", "switch", "catch", "function", "async", "return", "typeof",
    "delete", "void", "throw", "new", "super", "import", "await", "yield",
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
    "Math", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
    "ReferenceError", "URIError", "EvalError", "AggregateError",
    "Map", "Set", "WeakMap", "WeakSet", "Promise", "Proxy", "Reflect", "JSON", "Intl",
    "ArrayBuffer", "SharedArrayBuffer", "DataView",
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
    "parseInt", "parseFloat", "isNaN", "isFinite",
    "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent", "escape", "unescape",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback",
    "queueMicrotask", "structuredClone",
    "fetch", "Headers", "Request", "Response", "AbortController", "AbortSignal",
    "URL", "URLSearchParams", "FormData", "Blob", "File", "FileReader",
    "Image", "Audio", "Option", "Event", "CustomEvent", "KeyboardEvent", "MouseEvent",
    "PointerEvent", "TouchEvent", "WheelEvent", "DragEvent", "FocusEvent", "ClipboardEvent",
    "EventSource", "WebSocket", "BroadcastChannel", "MessageChannel", "Worker",
    "DOMParser", "XMLSerializer", "MutationObserver", "ResizeObserver", "IntersectionObserver",
    "PerformanceObserver", "TextEncoder", "TextDecoder", "CompressionStream", "DecompressionStream",
    "atob", "btoa", "alert", "confirm", "prompt", "open", "close", "print", "focus", "blur",
    "scrollTo", "scrollBy", "getComputedStyle", "matchMedia", "CSS", "CSSStyleSheet",
    "NodeFilter", "XPathResult", "Range",
    # ベンダースクリプト（Leaflet / sql.js）が公開するグローバル識別子
    "initSqlJs", "L",
}

_DECL_PATTERNS = (
    re.compile(r"\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\("),
    re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)\b"),
    re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"\b(?:window|self|globalThis)\.([A-Za-z_$][\w$]*)\s*="),
)
_PARAM_ARROW_RE = re.compile(r"([A-Za-z_$][\w$]*)\s*=>")
_BARE_CALL_RE = re.compile(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(")
_CONFLICT_MARKER_RE = re.compile(r"^(?:<{7}\s|>{7}\s)", re.MULTILINE)


class _HtmlAssetParser(HTMLParser):
    """HTML内のローカルJS/CSS/アイコン/画像参照を抽出するパーサー"""

    def __init__(self) -> None:
        super().__init__()
        self.refs: List[Tuple[str, str]] = []
        self.stylesheets: List[str] = []
        self.scripts: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, str | None]]) -> None:
        amap = {k: (v or "") for k, v in attrs}
        if tag == "script" and amap.get("src"):
            src = amap["src"]
            self.refs.append(("script", src))
            clean = src.split("?", 1)[0].split("#", 1)[0].lstrip("/")
            self.scripts.append(clean)
        elif tag == "link" and amap.get("href"):
            rel = amap.get("rel", "").lower()
            href = amap["href"]
            if any(k in rel for k in ("stylesheet", "icon", "manifest", "apple-touch-icon")):
                self.refs.append((f"link:{rel}", href))
            if rel == "stylesheet":
                clean = href.split("?", 1)[0].split("#", 1)[0].lstrip("/")
                self.stylesheets.append(clean)
        elif tag == "img" and amap.get("src"):
            src = amap["src"].strip()
            if src:
                self.refs.append(("img", src))


def scan_js_and_check_brackets(src: str, filename: str) -> str:
    """
    JSのコメント・文字列・テンプレートリテラル・正規表現リテラルを走査し、
    未閉鎖リテラルと () / {} / [] の対応を検証した上で行番号維持のコード部文字列を返す。
    """
    n = len(src)
    i = 0
    line = 1
    stack: List[Tuple[str, int]] = []
    tpl_brace_depths: List[Tuple[int, int]] = []
    out_chars: List[str] = []
    prev_sig = ""
    prev_word = ""
    pairs = {")": "(", "}": "{", "]": "["}

    while i < n:
        ch = src[i]
        if ch == "\n":
            line += 1
            out_chars.append("\n")
            i += 1
            continue

        # 単一行コメント
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            i += 2
            while i < n and src[i] != "\n":
                i += 1
            continue

        # ブロックコメント
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            start_line = line
            i += 2
            closed = False
            while i + 1 < n:
                if src[i] == "\n":
                    line += 1
                    out_chars.append("\n")
                if src[i] == "*" and src[i + 1] == "/":
                    i += 2
                    closed = True
                    break
                i += 1
            if not closed:
                raise AssertionError(f"{filename}:{start_line}: 未閉鎖のブロックコメント /*")
            out_chars.append(" ")
            continue

        # クォート文字列リテラル
        if ch in ("'", '"'):
            quote = ch
            start_line = line
            i += 1
            closed = False
            while i < n:
                c = src[i]
                if c == "\\":
                    if i + 1 < n and src[i + 1] == "\n":
                        line += 1
                        out_chars.append("\n")
                    i += 2
                    continue
                if c == quote:
                    i += 1
                    closed = True
                    break
                if c == "\n":
                    break
                i += 1
            if not closed:
                raise AssertionError(f"{filename}:{start_line}: 未閉鎖の文字列リテラル {quote}")
            out_chars.append('""')
            prev_sig = quote
            prev_word = ""
            continue

        # テンプレートリテラル開始
        if ch == "`":
            start_line = line
            i += 1
            while True:
                if i >= n:
                    raise AssertionError(f"{filename}:{start_line}: 未閉鎖のテンプレートリテラル `")
                c = src[i]
                if c == "\n":
                    line += 1
                    out_chars.append("\n")
                    i += 1
                    continue
                if c == "\\":
                    if i + 1 < n and src[i + 1] == "\n":
                        line += 1
                        out_chars.append("\n")
                    i += 2
                    continue
                if c == "`":
                    i += 1
                    out_chars.append('""')
                    prev_sig = "`"
                    prev_word = ""
                    break
                if c == "$" and i + 1 < n and src[i + 1] == "{":
                    tpl_brace_depths.append((len(stack), start_line))
                    stack.append(("{", line))
                    out_chars.append(" (")
                    prev_sig = "("
                    prev_word = ""
                    i += 2
                    break
                i += 1
            continue

        # テンプレート式 ${ ... } の閉じ波括弧からテンプレート文字列へ復帰
        if ch == "}" and tpl_brace_depths and len(stack) == tpl_brace_depths[-1][0] + 1 and stack[-1][0] == "{":
            _, tpl_start_line = tpl_brace_depths.pop()
            stack.pop()
            out_chars.append(") ")
            i += 1
            while True:
                if i >= n:
                    raise AssertionError(f"{filename}:{tpl_start_line}: 未閉鎖のテンプレートリテラル `")
                c = src[i]
                if c == "\n":
                    line += 1
                    out_chars.append("\n")
                    i += 1
                    continue
                if c == "\\":
                    if i + 1 < n and src[i + 1] == "\n":
                        line += 1
                        out_chars.append("\n")
                    i += 2
                    continue
                if c == "`":
                    i += 1
                    prev_sig = "`"
                    prev_word = ""
                    break
                if c == "$" and i + 1 < n and src[i + 1] == "{":
                    tpl_brace_depths.append((len(stack), tpl_start_line))
                    stack.append(("{", line))
                    out_chars.append("+(")
                    prev_sig = "("
                    prev_word = ""
                    i += 2
                    break
                i += 1
            continue

        # 正規表現リテラル
        if ch == "/":
            is_regex = (
                prev_sig in ("", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">")
                or prev_word in _REGEX_PREV_KEYWORDS
            )
            if is_regex and not (
                i + 1 < n and src[i + 1] == "="
                and prev_sig not in ("", "(", ",", ":", "[", "!", "&", "|", "?", "{", ";")
                and prev_word != "return"
            ):
                j = i + 1
                in_class = False
                valid_rx = False
                while j < n and src[j] != "\n":
                    rc = src[j]
                    if rc == "\\":
                        j += 2
                        continue
                    if rc == "[":
                        in_class = True
                    elif rc == "]":
                        in_class = False
                    elif rc == "/" and not in_class:
                        valid_rx = True
                        j += 1
                        while j < n and src[j].isalpha():
                            j += 1
                        break
                    j += 1
                if valid_rx:
                    i = j
                    out_chars.append(" /rx/ ")
                    prev_sig = "/"
                    prev_word = ""
                    continue

        if ch in "({[":
            stack.append((ch, line))
        elif ch in ")}]":
            if not stack or stack[-1][0] != pairs[ch]:
                raise AssertionError(f"{filename}:{line}: 括弧の対応不正 '{ch}' (直近={stack[-3:]})")
            stack.pop()

        if ch.isalpha() or ch in ("_", "$"):
            j = i + 1
            while j < n and (src[j].isalnum() or src[j] in ("_", "$")):
                j += 1
            word = src[i:j]
            out_chars.append(word)
            prev_word = word
            prev_sig = word[-1]
            i = j
            continue

        out_chars.append(ch)
        if not ch.isspace():
            prev_sig = ch
            prev_word = ""
        i += 1

    if stack:
        raise AssertionError(f"{filename}: 未閉鎖の括弧が残っています: {stack[-3:]}")
    return "".join(out_chars)


def find_undefined_global_calls(stripped_files: Sequence[Tuple[str, str]]) -> List[str]:
    """
    同一HTMLに読み込まれるスクリプト集合（stripped_files）全体でグローバル宣言を集計し、
    typeof ガード無しで呼ばれている未定義のベア関数呼び出し（foo(...)）を検出する。
    """
    global_defs: Set[str] = set(_JS_KEYWORDS_AND_BUILTINS)
    for _, clean in stripped_files:
        for pat in _DECL_PATTERNS:
            global_defs.update(pat.findall(clean))

    issues: List[str] = []
    for rel_name, clean in stripped_files:
        local_defs: Set[str] = set(_PARAM_ARROW_RE.findall(clean))
        for pmatch in re.finditer(r"\(([^()]{1,300})\)\s*(?:=>|\{)", clean):
            local_defs.update(re.findall(r"\b([A-Za-z_$][\w$]*)\b", pmatch.group(1)))
        for dmatch in re.finditer(r"\b(?:const|let|var)\s*[\[{]([^\]}]{1,300})[\]}]", clean):
            local_defs.update(re.findall(r"\b([A-Za-z_$][\w$]*)\b", dmatch.group(1)))
        for mvar in re.finditer(r"\b(?:const|let|var)\s+([^;\n]+)", clean):
            local_defs.update(re.findall(r"(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?:=|,|$)", mvar.group(1)))
        method_defs = set(
            re.findall(r"(?:^|[,{;\n])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{", clean)
        )
        known = global_defs | local_defs | method_defs
        lines = clean.splitlines()
        for idx, line_str in enumerate(lines, 1):
            for match in _BARE_CALL_RE.finditer(line_str):
                fn = match.group(1)
                if fn not in known:
                    ctx = "\n".join(lines[max(0, idx - 3): idx + 1])
                    if f"typeof {fn}" in ctx:
                        continue
                    issues.append(f"{rel_name}:{idx}: 未定義のグローバル関数呼び出し '{fn}('")
    return issues


class TestFrontendJsIntegrity(unittest.TestCase):
    """フロントエンドのアセット参照・構文括弧バランス・グローバル呼び出し整合性の高速スモークテスト"""

    _stripped_js_cache: Dict[str, str] = {}

    @classmethod
    def setUpClass(cls) -> None:
        cls._stripped_js_cache = {}
        for js_path in sorted((FRONTEND_DIR / "js").rglob("*.js")):
            rel = js_path.relative_to(FRONTEND_DIR).as_posix()
            raw = js_path.read_text(encoding="utf-8")
            if _CONFLICT_MARKER_RE.search(raw):
                raise AssertionError(f"{rel}: 未解決のGitマージ競合マーカーが残っています")
            cls._stripped_js_cache[rel] = scan_js_and_check_brackets(raw, rel)

    def test_html_local_asset_references_exist(self) -> None:
        """index.html と mobile.html が参照する全ローカルJS/CSS/アイコンが実在し、mobile_bundle定義と一致することを確認"""
        for html_name in ("index.html", "mobile.html"):
            html_path = FRONTEND_DIR / html_name
            self.assertTrue(html_path.is_file(), f"{html_name} が存在しません")
            raw_html = html_path.read_text(encoding="utf-8")
            self.assertIsNone(_CONFLICT_MARKER_RE.search(raw_html), f"{html_name} に競合マーカーがあります")

            parser = _HtmlAssetParser()
            parser.feed(raw_html)
            self.assertGreater(len(parser.scripts), 0, f"{html_name} に <script src> がありません")

            seen_scripts: Set[str] = set()
            for kind, raw_ref in parser.refs:
                clean_ref = raw_ref.split("?", 1)[0].split("#", 1)[0].strip()
                if not clean_ref or clean_ref.startswith(("http://", "https://", "data:", "blob:", "/api/", "api/")):
                    continue
                rel_path = clean_ref.lstrip("/")
                target = FRONTEND_DIR / rel_path
                self.assertTrue(
                    target.is_file() and target.stat().st_size > 0,
                    f"{html_name} の {kind} 参照先が見つからないか空ファイルです: {raw_ref} -> {target}",
                )
                if kind == "script":
                    self.assertNotIn(rel_path, seen_scripts, f"{html_name} で {rel_path} が重複読み込みされています")
                    seen_scripts.add(rel_path)

            if html_name == "index.html":
                self.assertIn(
                    "js/core/tree_builder.js",
                    parser.scripts,
                    "index.html に共通 TreeBuilder (js/core/tree_builder.js) が配線されていません",
                )
                self.assertLess(
                    parser.scripts.index("js/core/tree_builder.js"),
                    parser.scripts.index("js/common.js"),
                    "js/core/tree_builder.js は js/common.js より前に読み込む必要があります",
                )

            if html_name == "mobile.html":
                self.assertEqual(
                    parser.stylesheets,
                    list(MOBILE_CSS_REL_PATHS),
                    "mobile.html の CSS 読み込み順と server/mobile_bundle.py の MOBILE_CSS_REL_PATHS が不一致です",
                )
                mobile_app_scripts = [s for s in parser.scripts if s != "vendor/sqljs/sql-wasm.js"]
                self.assertEqual(
                    mobile_app_scripts,
                    list(MOBILE_JS_REL_PATHS),
                    "mobile.html の JS 読み込み順と server/mobile_bundle.py の MOBILE_JS_REL_PATHS が不一致です",
                )

        # P3-C で整理された幽霊モジュールが frontend/js/ に残存せずアーカイブ退避されていることを確認
        for retired_name in ("filter_engine.js", "journal_sync.js"):
            self.assertFalse(
                (FRONTEND_DIR / "js" / "core" / retired_name).exists(),
                f"退避済みの幽霊モジュール frontend/js/core/{retired_name} が残存しています",
            )
            self.assertTrue(
                (PROJECT_ROOT / "docs" / "archive" / "js_legacy" / retired_name).is_file(),
                f"docs/archive/js_legacy/{retired_name} に退避ファイルが存在しません",
            )

    def test_js_and_css_bracket_balance(self) -> None:
        """全 frontend/js/**/*.js と frontend/css/*.css の括弧バランスとブロックコメント閉鎖を確認"""
        self.assertGreaterEqual(len(self._stripped_js_cache), 30)
        for css_path in sorted((FRONTEND_DIR / "css").glob("*.css")):
            rel = css_path.relative_to(FRONTEND_DIR).as_posix()
            raw = css_path.read_text(encoding="utf-8")
            self.assertIsNone(_CONFLICT_MARKER_RE.search(raw), f"{rel} に競合マーカーがあります")
            # 未閉鎖の /* コメント検査と文字列・コメント除去後の {} バランス検査
            without_strings = re.sub(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"", '""', raw)
            open_comments = len(re.findall(r"/\*", without_strings))
            close_comments = len(re.findall(r"\*/", without_strings))
            self.assertEqual(open_comments, close_comments, f"{rel}: CSS ブロックコメントの開閉数が不一致です")
            clean_css = re.sub(r"/\*[\s\S]*?\*/", " ", without_strings)
            self.assertEqual(
                clean_css.count("{"),
                clean_css.count("}"),
                f"{rel}: CSS 波括弧 '{{' と '}}' の数が一致しません",
            )

    def test_no_undefined_global_calls_or_prohibited_apis(self) -> None:
        """チェリーピック漏れによる未定義グローバル呼び出し（hasBakedAdjustments等）や禁止API（toISOString/alert/confirm）が無いことを確認"""
        bare_alert_re = re.compile(r"(?<![.\w$])alert\s*\(")
        win_alert_re = re.compile(r"\bwindow\.alert\s*\(")
        any_confirm_re = re.compile(r"(?:\bwindow\.confirm|(?<![.\w$])confirm)\s*\(")
        total_pc_legacy_alerts = 0
        for rel, stripped in self._stripped_js_cache.items():
            self.assertNotIn(
                "hasBakedAdjustments(",
                stripped,
                f"{rel}: 未定義の旧関数名 hasBakedAdjustments( が残っています（正: hasBakedViewAdjustments）",
            )
            self.assertNotIn(
                "toISOString(",
                stripped,
                f"{rel}: UTC基準で日付ズレを起こす禁止API toISOString( が使用されています",
            )
            self.assertIsNone(
                win_alert_re.search(stripped),
                f"{rel}: ブラウザ標準の window.alert( が使用されています（showToast へ統一してください）",
            )
            is_mobile_or_core = rel == "js/mobile.js" or rel.startswith(("js/core/", "js/adapters/", "js/views/touch/"))
            if is_mobile_or_core:
                self.assertIsNone(
                    bare_alert_re.search(stripped),
                    f"{rel}: モバイル/共通JS内で alert( が使用されています（WebViewハング防止のため showToast へ統一必須）",
                )
                self.assertIsNone(
                    any_confirm_re.search(stripped),
                    f"{rel}: モバイル/共通JS内で confirm( が使用されています",
                )
            else:
                total_pc_legacy_alerts += len(bare_alert_re.findall(stripped))

        # 新規の alert( 追加を遮断するラチェット上限
        self.assertLessEqual(
            total_pc_legacy_alerts,
            3,
            f"PC側JSで新規の alert( が追加されています (現在={total_pc_legacy_alerts}, 上限=3): showToast を使用してください",
        )

        for html_name in ("index.html", "mobile.html"):
            parser = _HtmlAssetParser()
            parser.feed((FRONTEND_DIR / html_name).read_text(encoding="utf-8"))
            bundle_files = [
                (s, self._stripped_js_cache[s])
                for s in parser.scripts
                if s in self._stripped_js_cache
            ]
            undef_issues = find_undefined_global_calls(bundle_files)
            self.assertEqual(
                undef_issues,
                [],
                f"{html_name} バンドル内で未定義グローバル関数呼び出しが検出されました:\n" + "\n".join(undef_issues),
            )

    def test_scanner_catches_synthetic_defects(self) -> None:
        """検査器自体が括弧アンバランスや未定義グローバル呼び出しを確実に検知できることを自己検証"""
        # 正規表現やテンプレートリテラル内の括弧は誤検知しない
        ok_code = "const rx = /[({]/g;\nconst s = `val=${fn({ a: [1, 2] })}!`;\nfunction fn(x) { return x.a[0]; }\n"
        stripped_ok = scan_js_and_check_brackets(ok_code, "synthetic_ok.js")
        self.assertEqual(find_undefined_global_calls([("synthetic_ok.js", stripped_ok)]), [])

        # 閉じ括弧不足を検知する
        with self.assertRaises(AssertionError):
            scan_js_and_check_brackets("function broken(a) {\n  if (a) {\n    return 1;\n}\n", "broken.js")

        # チェリーピック漏れ型の未定義関数呼び出しを検知する
        bad_call = scan_js_and_check_brackets("function render(p) { return hasBakedAdjustments(p) ? 0 : 90; }\n", "cmp.js")
        issues = find_undefined_global_calls([("cmp.js", bad_call)])
        self.assertEqual(len(issues), 1)
        self.assertIn("hasBakedAdjustments(", issues[0])

    def test_phone_bottom_nav_and_center_dial_wiring(self) -> None:
        """スマホ下部ナビ3カラム構成（フィルタ / 中央丸型GPSダイヤル / ラボ）の配線整合性を確認"""
        self.assertIn("js/views/touch/touch_center_dial.js", MOBILE_JS_REL_PATHS)
        layout_raw = (FRONTEND_DIR / "js" / "views" / "touch" / "touch_layout.js").read_text(encoding="utf-8")
        dial_raw = (FRONTEND_DIR / "js" / "views" / "touch" / "touch_center_dial.js").read_text(encoding="utf-8")
        pcase_raw = (FRONTEND_DIR / "js" / "views" / "touch" / "touch_phone_case.js").read_text(encoding="utf-8")
        morph_raw = (FRONTEND_DIR / "js" / "views" / "touch" / "morph_thumb_bar.js").read_text(encoding="utf-8")
        touch_css = (FRONTEND_DIR / "css" / "touch-responsive.css").read_text(encoding="utf-8")

        self.assertIn('id="tCenterDialSlot"', layout_raw)
        self.assertIn('data-bnav="filter"', layout_raw)
        self.assertIn('data-bnav="lab"', layout_raw)
        self.assertNotIn('data-bnav="photos"', layout_raw)
        self.assertNotIn('data-bnav="uplink"', layout_raw)

        for mode_id in ("'uplink'", "'gps'", "'camera'"):
            self.assertIn(mode_id, dial_raw)
        self.assertIn("母艦に収納", dial_raw)
        self.assertNotIn("母艦に送信", dial_raw)
        self.assertNotIn("SWIPE_JUMP_PX", dial_raw, "2段飛ばしにより中央GPSを飛び越える SWIPE_JUMP_PX は禁止")
        self.assertIn("toggleFieldLogRecording", dial_raw)
        self.assertIn("openFieldLogScreen", dial_raw)
        self.assertIn("openCameraCapture", dial_raw)
        self.assertIn("triggerQuickDeltaUplink", dial_raw)
        self.assertIn("openPhoneCaseModal", dial_raw)
        self.assertIn("_executeActiveModeLongPress", dial_raw)
        self.assertIn("isMotherShipLinked", morph_raw)
        self.assertIn("isMotherShipLinked", dial_raw)
        self.assertIn("isMotherShipLinked", pcase_raw)
        self.assertIn("is-uplink-offline", dial_raw)
        self.assertIn("is-uplink-offline", touch_css)
        self.assertIn("is-unlinked", pcase_raw)
        self.assertIn("is-unlinked", touch_css)
        self.assertIn("triggerQuickDeltaUplink", pcase_raw)


if __name__ == "__main__":
    unittest.main()
