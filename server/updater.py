"""
PC母艦アップデート＆ポータブル差分パッケージ管理モジュール

機能:
1. GitHub Releases から最新バージョンおよび軽量差分ZIP (Tetheract_v*diff.zip) を確認・安全ダウンロード
2. 現在稼働中の母艦から個人データ (cache/・Loome/ 等) を除いた差分更新ZIPをオンデマンド生成
3. 手元または取得済みの diff.zip を検証してステージングし、Tetheract.exe のクリーンアップデートを起動
"""

import json
import logging
from pathlib import Path
import re
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from .mobile_bundle import (
    ensure_mobile_ui_bundle_zip,
    ensure_standalone_mobile_html,
    find_prebuilt_android_apk,
    get_mobile_ui_bundle_info,
)
from .version import get_version, get_version_info

logger = logging.getLogger("photo_manager.updater")

BASE_DIR = Path(__file__).resolve().parent.parent
UPDATES_DIR = BASE_DIR / "cache" / "updates"
GITHUB_REPO = "zony0428/photo-manager"
GITHUB_RELEASES_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=10"
GITHUB_DOWNLOAD_PREFIX = f"https://github.com/{GITHUB_REPO}/releases/download/"

_REMOTE_CACHE_TTL_SEC = 15 * 60
_MAX_DIFF_ZIP_BYTES = 250 * 1024 * 1024

_release_cache_lock = threading.Lock()
_release_cache: Dict[str, Any] = {"fetched_at": 0.0, "data": None}

_EXCLUDED_DIR_NAMES = {"__pycache__", ".git", "cache", ".cache"}
_EXCLUDED_FILE_SUFFIXES = (".pyc", ".pyo", ".orig_backup", ".tmp", ".log")


class _HttpsOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """GitHub Releases ダウンロード時に HTTPS 以外へのリダイレクトを遮断するハンドラ"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme.lower() != "https":
            raise urllib.error.HTTPError(
                newurl, code, f"安全でないリダイレクト先スキームを拒否しました: {parsed.scheme}", headers, fp
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def parse_semver(raw: Optional[str]) -> Optional[Tuple[int, int, int]]:
    """バージョン文字列 (例: 'v2.4.0') を (major, minor, patch) タプルに変換する"""
    if not raw:
        return None
    s = str(raw).strip()
    m = re.match(r"^[vV]?\s*(\d+)\.(\d+)(?:\.(\d+))?", s)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


def is_dev_repository(base_dir: Path = BASE_DIR) -> bool:
    """開発リポジトリ環境（自己上書きアップデート保護対象）かどうかを返す"""
    return (base_dir / ".git").exists() or (base_dir / "build_dist.bat").exists()


def validate_diff_zip_file(zip_path: Path) -> Tuple[bool, str, str]:
    """
    指定ファイルが有効かつ安全な Tetheract 軽量差分アップデートZIPであることを検証する。
    戻り値: (valid, version_str, error_message)
    """
    if not zip_path.is_file():
        return False, "", "ZIPファイルが見つかりません"
    size = zip_path.stat().st_size
    if size < 100:
        return False, "", "ZIPファイルが空または小さすぎます"
    if size > _MAX_DIFF_ZIP_BYTES:
        return False, "", "ZIPファイルサイズが上限 (250MB) を超えています"

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            has_server_run = False
            has_frontend_index = False
            has_version = False
            version_str = ""

            for info in zf.infolist():
                raw_name = info.filename.replace("\\", "/")
                if raw_name.startswith("/") or re.match(r"^[A-Za-z]:", raw_name):
                    return False, "", f"絶対パスエントリが含まれています: {info.filename}"
                parts = [p for p in raw_name.split("/") if p]
                if ".." in parts:
                    return False, "", f"不正な相対パスが含まれています: {info.filename}"
                norm = "/".join(parts).lower()
                if norm in ("server/run.py", "run.py"):
                    has_server_run = True
                elif norm == "frontend/index.html":
                    has_frontend_index = True
                elif norm == "version":
                    has_version = True
                    try:
                        ver_lines = zf.read(info).decode("utf-8", errors="ignore").splitlines()
                        if ver_lines and ver_lines[0].strip():
                            parsed = parse_semver(ver_lines[0].strip())
                            if parsed:
                                version_str = f"{parsed[0]}.{parsed[1]}.{parsed[2]}"
                    except Exception as e:
                        logger.debug(f"ZIP内 VERSION 読取スキップ: {e}")

            if not (has_server_run and has_frontend_index and has_version):
                return (
                    False,
                    "",
                    "有効な Tetheract アップデートZIPではありません（server/run.py・frontend/index.html・VERSION のいずれかが不足）",
                )
            if not version_str:
                return False, "", "ZIP内の VERSION から有効なバージョン番号を読み取れませんでした"
            return True, version_str, ""
    except zipfile.BadZipFile:
        return False, "", "破損したZIPファイルです"
    except Exception as e:
        logger.warning(f"アップデートZIP検証エラー ({zip_path}): {e}")
        return False, "", f"ZIPの検証に失敗しました: {e}"


def find_staged_diff_zip(base_dir: Path = BASE_DIR) -> Optional[Dict[str, Any]]:
    """アプリルート直下に配置された適用可能な Tetheract_*diff.zip を探索して返す"""
    cur_ver = get_version()
    cur_tuple = parse_semver(cur_ver)
    best: Optional[Tuple[Tuple[int, int, int], float, Dict[str, Any]]] = None

    try:
        candidates = sorted(
            base_dir.glob("Tetheract_*diff.zip"),
            key=lambda p: p.stat().st_mtime if p.is_file() else 0.0,
            reverse=True,
        )
    except Exception as e:
        logger.warning(f"ステージ済みZIP探索エラー: {e}")
        return None

    for cand in candidates:
        if not cand.is_file():
            continue
        ok, zip_ver, _ = validate_diff_zip_file(cand)
        if not ok:
            continue
        cand_tuple = parse_semver(zip_ver) or (0, 0, 0)
        is_newer = bool(cur_tuple is None or cand_tuple > cur_tuple)
        mtime = cand.stat().st_mtime
        item = {
            "file_name": cand.name,
            "file_path": str(cand),
            "version": zip_ver,
            "size_mb": round(cand.stat().st_size / (1024 * 1024), 2),
            "is_newer": is_newer,
        }
        if best is None or cand_tuple > best[0] or (cand_tuple == best[0] and mtime > best[1]):
            best = (cand_tuple, mtime, item)

    return best[2] if best else None


def _select_best_github_release(
    releases: List[Dict[str, Any]],
    current_tuple: Optional[Tuple[int, int, int]],
) -> Dict[str, Any]:
    """GitHub Releases JSONリストから同系列の最新リリース（および他系列最新情報）を抽出する"""
    cur_major = current_tuple[0] if current_tuple else 1
    best_same_series: Optional[Tuple[Tuple[int, int, int], Dict[str, Any]]] = None
    best_overall: Optional[Tuple[Tuple[int, int, int], Dict[str, Any]]] = None

    for rel in releases:
        if not isinstance(rel, dict):
            continue
        if rel.get("draft") or rel.get("prerelease"):
            continue
        tag = str(rel.get("tag_name") or "").strip()
        ver_t = parse_semver(tag)
        if not ver_t:
            continue
        if best_overall is None or ver_t > best_overall[0]:
            best_overall = (ver_t, rel)
        if ver_t[0] == cur_major:
            if best_same_series is None or ver_t > best_same_series[0]:
                best_same_series = (ver_t, rel)

    chosen = best_same_series or best_overall
    if not chosen:
        return {
            "checked": True,
            "remote_update_available": False,
            "latest_version": "",
            "tag_name": "",
            "html_url": f"https://github.com/{GITHUB_REPO}/releases",
            "diff_asset_name": "",
            "diff_asset_url": "",
            "diff_asset_size_mb": 0.0,
            "published_at": "",
            "error": "",
        }

    rel_tuple, rel_obj = chosen
    ver_str = f"{rel_tuple[0]}.{rel_tuple[1]}.{rel_tuple[2]}"
    diff_name = ""
    diff_url = ""
    diff_size_mb = 0.0
    for asset in rel_obj.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        a_name = str(asset.get("name") or "")
        a_url = str(asset.get("browser_download_url") or "")
        if a_name.startswith("Tetheract_") and a_name.endswith("diff.zip") and a_url.startswith(GITHUB_DOWNLOAD_PREFIX):
            diff_name = a_name
            diff_url = a_url
            diff_size_mb = round(int(asset.get("size") or 0) / (1024 * 1024), 2)
            break

    same_series_newer = bool(
        current_tuple is not None
        and rel_tuple[0] == current_tuple[0]
        and rel_tuple > current_tuple
        and diff_url
    )
    other_series_ver = ""
    if best_overall and current_tuple and best_overall[0][0] != current_tuple[0] and best_overall[0] > current_tuple:
        ot = best_overall[0]
        other_series_ver = f"{ot[0]}.{ot[1]}.{ot[2]}"

    return {
        "checked": True,
        "remote_update_available": same_series_newer,
        "latest_version": ver_str,
        "tag_name": str(rel_obj.get("tag_name") or ""),
        "html_url": str(rel_obj.get("html_url") or f"https://github.com/{GITHUB_REPO}/releases"),
        "diff_asset_name": diff_name,
        "diff_asset_url": diff_url,
        "diff_asset_size_mb": diff_size_mb,
        "published_at": str(rel_obj.get("published_at") or ""),
        "other_series_version": other_series_ver,
        "error": "",
    }


def check_github_latest_release(force: bool = False) -> Dict[str, Any]:
    """GitHub Releases API から最新のリリース情報を取得する（15分キャッシュ・4秒タイムアウト）"""
    now = time.time()
    with _release_cache_lock:
        cached = _release_cache.get("data")
        if not force and isinstance(cached, dict) and (now - float(_release_cache.get("fetched_at") or 0.0)) < _REMOTE_CACHE_TTL_SEC:
            return dict(cached)

    cur_ver = get_version()
    cur_tuple = parse_semver(cur_ver)
    req = urllib.request.Request(
        GITHUB_RELEASES_API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"Tetheract-Photo-Manager/{cur_ver}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            raw_text = resp.read().decode("utf-8")
        releases = json.loads(raw_text)
        if not isinstance(releases, list):
            releases = []
        result = _select_best_github_release(releases, cur_tuple)
        with _release_cache_lock:
            _release_cache["fetched_at"] = now
            _release_cache["data"] = dict(result)
        return result
    except Exception as e:
        logger.warning(f"GitHub リリース確認失敗: {e}")
        return {
            "checked": False,
            "remote_update_available": False,
            "latest_version": "",
            "tag_name": "",
            "html_url": f"https://github.com/{GITHUB_REPO}/releases",
            "diff_asset_name": "",
            "diff_asset_url": "",
            "diff_asset_size_mb": 0.0,
            "published_at": "",
            "error": str(e),
        }


def download_and_stage_github_diff_zip(
    download_url: str = "",
    base_dir: Path = BASE_DIR,
) -> Dict[str, Any]:
    """
    GitHub Releases から公式 diff.zip をダウンロード・検証し、アプリルート直下へステージングする。
    """
    target_url = str(download_url or "").strip()
    if not target_url:
        rel = check_github_latest_release(force=True)
        target_url = str(rel.get("diff_asset_url") or "").strip()
        if not target_url:
            return {
                "ok": False,
                "error": rel.get("error") or "GitHub Releases にダウンロード可能な差分パッケージ (diff.zip) が見つかりませんでした",
            }

    parsed = urllib.parse.urlsplit(target_url)
    if parsed.scheme.lower() != "https" or parsed.netloc.lower() != "github.com" or not target_url.startswith(GITHUB_DOWNLOAD_PREFIX):
        return {
            "ok": False,
            "error": "公式 GitHub Releases 以外のURLからのダウンロードは許可されていません",
        }

    tmp_path = base_dir / f".gh_diff_{threading.get_ident()}.tmp"
    opener = urllib.request.build_opener(_HttpsOnlyRedirectHandler)
    req = urllib.request.Request(
        target_url,
        headers={"User-Agent": f"Tetheract-Photo-Manager/{get_version()}"},
    )
    try:
        total = 0
        with opener.open(req, timeout=45.0) as resp, open(tmp_path, "wb") as out:
            while True:
                chunk = resp.read(128 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > _MAX_DIFF_ZIP_BYTES:
                    raise ValueError("ダウンロードサイズが上限 (250MB) を超えました")
                out.write(chunk)

        ok, zip_ver, err_msg = validate_diff_zip_file(tmp_path)
        if not ok:
            return {"ok": False, "error": err_msg}

        dest_name = f"Tetheract_v{zip_ver}diff.zip"
        dest_path = base_dir / dest_name
        tmp_path.replace(dest_path)
        return {
            "ok": True,
            "file_name": dest_name,
            "version": zip_ver,
            "size_mb": round(dest_path.stat().st_size / (1024 * 1024), 2),
        }
    except Exception as e:
        logger.warning(f"GitHub diff.zip ダウンロードエラー: {e}")
        return {"ok": False, "error": f"更新パッケージの取得に失敗しました: {e}"}
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass


def stage_uploaded_diff_zip(
    file_name: str,
    raw_bytes: bytes,
    base_dir: Path = BASE_DIR,
) -> Dict[str, Any]:
    """アップロードまたは選択された diff.zip バイト列を検証し、アプリルート直下へステージングする"""
    if not raw_bytes or len(raw_bytes) < 100:
        return {"ok": False, "error": "アップロードされたファイルが空または無効です"}
    if len(raw_bytes) > _MAX_DIFF_ZIP_BYTES:
        return {"ok": False, "error": "ファイルサイズが上限 (250MB) を超えています"}

    tmp_path = base_dir / f".stage_diff_{threading.get_ident()}.tmp"
    try:
        tmp_path.write_bytes(raw_bytes)
        ok, zip_ver, err_msg = validate_diff_zip_file(tmp_path)
        if not ok:
            return {"ok": False, "error": err_msg}

        dest_name = f"Tetheract_v{zip_ver}diff.zip"
        dest_path = base_dir / dest_name
        tmp_path.replace(dest_path)
        return {
            "ok": True,
            "file_name": dest_name,
            "version": zip_ver,
            "size_mb": round(dest_path.stat().st_size / (1024 * 1024), 2),
            "source_name": Path(file_name or dest_name).name,
        }
    except Exception as e:
        logger.warning(f"diff.zip ステージングエラー: {e}")
        return {"ok": False, "error": f"diff.zip の配置に失敗しました: {e}"}
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass


def _add_directory_to_zip(zf: zipfile.ZipFile, src_dir: Path, arc_prefix: str) -> int:
    """個人データやキャッシュを除外しながらディレクトリ配下を ZIP に格納する"""
    if not src_dir.is_dir():
        return 0
    count = 0
    for child in sorted(src_dir.rglob("*")):
        if not child.is_file():
            continue
        rel = child.relative_to(src_dir)
        if any(part.lower() in _EXCLUDED_DIR_NAMES for part in rel.parts):
            continue
        if child.name.lower().endswith(_EXCLUDED_FILE_SUFFIXES):
            continue
        zf.write(child, arcname=f"{arc_prefix}/{rel.as_posix()}")
        count += 1
    return count


def build_portable_diff_update_zip(
    base_dir: Path = BASE_DIR,
    out_dir: Optional[Path] = None,
) -> Tuple[Path, Dict[str, Any]]:
    """
    現在稼働中の母艦から個人データを完全に除外した軽量差分パッケージ (Tetheract_v<VER>diff.zip) を
    オンデマンド生成して返す（USB母艦や別PC母艦への持ち出し・同期用）。
    """
    ver_str = get_version()
    target_dir = out_dir or UPDATES_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    zip_name = f"Tetheract_v{ver_str}diff.zip"
    out_zip = target_dir / zip_name
    tmp_zip = target_dir / f".{zip_name}.{threading.get_ident()}.tmp"

    file_count = 0
    try:
        with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            file_count += _add_directory_to_zip(zf, base_dir / "frontend", "frontend")
            file_count += _add_directory_to_zip(zf, base_dir / "server", "server")
            file_count += _add_directory_to_zip(zf, base_dir / "LICENSES", "LICENSES")
            file_count += _add_directory_to_zip(zf, base_dir / "models" / "privacy", "models/privacy")

            # Launcher.cs の ValidateUpdateZip が要求する server/run.py を確実に収録
            if not (base_dir / "server" / "run.py").is_file() and (base_dir / "run.py").is_file():
                zf.write(base_dir / "run.py", arcname="server/run.py")
                file_count += 1

            # tools/ (Launcher.cs, Build.bat, start.bat)
            tools_map = {
                "tools/Launcher.cs": [base_dir / "tools" / "Launcher.cs", base_dir / "launcher" / "Launcher.cs"],
                "tools/Build.bat": [base_dir / "tools" / "Build.bat", base_dir / "Build.bat"],
                "tools/start.bat": [base_dir / "tools" / "start.bat", base_dir / "start.bat"],
            }
            for arc, cands in tools_map.items():
                for c in cands:
                    if c.is_file():
                        zf.write(c, arcname=arc)
                        file_count += 1
                        break

            # Tetheract.exe
            for exe_cand in (
                base_dir / "Tetheract.exe",
                base_dir / "dist_v2" / "Tetheract.exe",
                base_dir / "dist" / "Tetheract.exe",
            ):
                if exe_cand.is_file():
                    zf.write(exe_cand, arcname="Tetheract.exe")
                    file_count += 1
                    break

            # ドキュメント・VERSION
            for doc_name in ("README.md", "README_EN.md", "MANUAL.md", "README_USB.md", "RELEASE_NOTES.md", "LICENSE", "VERSION"):
                doc_p = base_dir / doc_name
                if doc_p.is_file():
                    zf.write(doc_p, arcname=doc_name)
                    file_count += 1

            # 単体完結モバイルHTML・Android APK・UIバンドル
            standalone_path = ensure_standalone_mobile_html()
            if standalone_path and standalone_path.is_file():
                zf.write(standalone_path, arcname="Tetheract_Mobile.html")
                file_count += 1

            apk_path = find_prebuilt_android_apk()
            if apk_path and apk_path.is_file():
                zf.write(apk_path, arcname="android/Tetheract_Android.apk")
                file_count += 1

            ui_bundle_path, _ = ensure_mobile_ui_bundle_zip()
            if ui_bundle_path and ui_bundle_path.is_file():
                zf.write(ui_bundle_path, arcname="android/tetheract_ui_bundle.zip")
                file_count += 1

        tmp_zip.replace(out_zip)
        meta = {
            "ok": True,
            "file_name": zip_name,
            "version": ver_str,
            "file_count": file_count,
            "size_mb": round(out_zip.stat().st_size / (1024 * 1024), 2),
        }
        return out_zip, meta
    finally:
        if tmp_zip.exists():
            try:
                tmp_zip.unlink()
            except Exception:
                pass


def trigger_launcher_clean_update(base_dir: Path = BASE_DIR) -> Dict[str, Any]:
    """
    ステージ済みの diff.zip を適用するため Tetheract.exe を起動する。
    開発リポジトリ環境 (.git または build_dist.bat 存在時) では安全保護のため実行を拒否する。
    """
    if is_dev_repository(base_dir):
        return {
            "ok": False,
            "reason": "dev_repo_protected",
            "error": "開発リポジトリ環境ではソース保護のため自己上書きアップデートは実行されません",
        }

    staged = find_staged_diff_zip(base_dir)
    if not staged:
        return {
            "ok": False,
            "reason": "no_staged_zip",
            "error": "適用可能なステージ済み更新パッケージ (Tetheract_*diff.zip) が見つかりません",
        }

    exe_path = base_dir / "Tetheract.exe"
    if not exe_path.is_file():
        return {
            "ok": False,
            "reason": "launcher_not_found",
            "error": "ランチャー実行ファイル (Tetheract.exe) が見つかりません",
        }

    try:
        subprocess.Popen([str(exe_path)], cwd=str(base_dir))
        return {
            "ok": True,
            "staged_zip": staged["file_name"],
            "version": staged["version"],
        }
    except Exception as e:
        logger.error(f"Tetheract.exe 起動エラー: {e}")
        return {
            "ok": False,
            "reason": "launch_failed",
            "error": f"Tetheract.exe の起動に失敗しました: {e}",
        }


def get_system_update_status(
    check_remote: bool = False,
    base_dir: Path = BASE_DIR,
) -> Dict[str, Any]:
    """現在のバージョン・UI/ネイティブリビジョン・ステージ済みZIP・リモート最新情報をまとめて返す"""
    ver_info = get_version_info()
    ui_info = get_mobile_ui_bundle_info()
    staged = find_staged_diff_zip(base_dir)
    dev_repo = is_dev_repository(base_dir)

    remote: Dict[str, Any]
    if check_remote:
        remote = check_github_latest_release(force=True)
    else:
        with _release_cache_lock:
            cached = _release_cache.get("data")
        remote = dict(cached) if isinstance(cached, dict) else {"checked": False, "remote_update_available": False}

    return {
        "ok": True,
        "current_version": ver_info["version"],
        "updated_at": ver_info.get("updated_at", ""),
        "ui_revision": ui_info.get("ui_revision", ""),
        "native_revision": ui_info.get("native_revision", ""),
        "apk_available": bool(find_prebuilt_android_apk() is not None),
        "is_dev_repository": dev_repo,
        "can_self_apply": bool(not dev_repo and (base_dir / "Tetheract.exe").is_file()),
        "staged_update": staged,
        "remote_release": remote,
    }
