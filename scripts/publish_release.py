"""
GitHub Releases 自動公開スクリプト (Photo Manager)

実行内容:
1. VERSION ファイルから現在のバージョン番号 (例: 3.0.1) を取得
2. docs/release_notes/RELEASE_NOTES_v<VERSION>.md と配布ZIP 2種
   (Tetheract_v<VERSION>diff.zip / Tetheract_v<VERSION>.zip) の存在を検証
3. 公開用リポジトリ (public: zony0428/photo-manager) の main ブランチへ
   現在の HEAD ツリーを単一コミットとして反映し、タグ v<VERSION> をプッシュ
4. GitHub REST API を用いて zony0428/photo-manager に Release を作成（または更新）し、
   差分ZIP・フルZIPの2ファイルを Assets として自動アップロード

使い方:
  .\\python\\python.exe scripts\\publish_release.py
  .\\python\\python.exe scripts\\publish_release.py --build   (ZIP未生成時に build_dist.bat も実行)
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple
import urllib.error
import urllib.parse
import urllib.request

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from server.version import get_version

PUBLIC_REPO = "zony0428/photo-manager"
PUBLIC_REMOTE = "public"


def validate_release_branch_and_version(
    branch: str,
    version: str,
    target_public_branch: str = "main",
    allow_v2_public: bool = False,
) -> None:
    """
    リリース公開時のブランチと VERSION メジャー系列の整合性を検証する。
    v2 ブランチや VERSION 2.x から安定版公開ブランチ (public/main) への誤プッシュを即座に遮断する。
    """
    clean_branch = (branch or "").strip()
    clean_ver = (version or "").strip()
    clean_pub = (target_public_branch or "main").strip()

    if not clean_branch or clean_branch == "HEAD":
        raise RuntimeError(
            "[RELEASE GUARD] detached HEAD または不明なブランチからは公開リリースを実行できません。"
        )
    if not re.match(r"^\d+\.\d+\.\d+", clean_ver):
        raise RuntimeError(f"[RELEASE GUARD] VERSION 形式が不正です: '{clean_ver}'")

    if clean_pub == "main" and (clean_branch != "main" or not clean_ver.startswith("1.")):
        raise RuntimeError(
            f"[RELEASE GUARD] v1安定版公開ブランチ ({PUBLIC_REMOTE}/main) へ "
            f"branch='{clean_branch}', VERSION='{clean_ver}' をプッシュすることは禁止されています。"
            "main ブランチかつ VERSION 1.x で実行してください。"
        )

    if clean_branch == "main":
        if not clean_ver.startswith("1."):
            raise RuntimeError(
                f"[RELEASE GUARD] main ブランチと VERSION='{clean_ver}' のメジャー系列が不一致です（1.x が必須）。"
            )
        return

    if clean_branch == "v2":
        if not clean_ver.startswith("2."):
            raise RuntimeError(
                f"[RELEASE GUARD] v2 ブランチと VERSION='{clean_ver}' のメジャー系列が不一致です（2.x が必須）。"
            )
        if not allow_v2_public or clean_pub == "main":
            raise RuntimeError(
                f"[RELEASE GUARD] v2 系リリース (VERSION={clean_ver}) は既定で公開遮断されています"
                f"（{PUBLIC_REMOTE}/main への誤強制プッシュ防止）。"
                "将来 v2 専用ブランチへ公開する場合は --public-branch v2 --allow-v2-public を明示してください。"
            )
        return

    raise RuntimeError(
        f"[RELEASE GUARD] 作業ブランチ '{clean_branch}' からの直接リリース公開は禁止されています。"
    )


def ensure_safe_release_target(
    version: Optional[str] = None,
    target_public_branch: str = "main",
    allow_v2_public: bool = False,
) -> str:
    """現在の Git ブランチと VERSION を取得して公開可否を検証し、ブランチ名を返す"""
    cur_branch = _run_git("branch", "--show-current")
    cur_ver = version if version is not None else get_version()
    validate_release_branch_and_version(
        cur_branch,
        cur_ver,
        target_public_branch=target_public_branch,
        allow_v2_public=allow_v2_public,
    )
    return cur_branch


def check_v2_apk_freshness(root_dir: Path = ROOT_DIR) -> Tuple[bool, str]:
    """
    v2 配布パッケージ生成前に dist_v2/android/Tetheract_Android.apk の存在と
    Android ネイティブ / モバイル Web ソース群に対する更新日時（鮮度）を検証する。
    """
    apk_path = root_dir / "dist_v2" / "android" / "Tetheract_Android.apk"
    if not apk_path.is_file() or apk_path.stat().st_size <= 0:
        return (
            False,
            f"v2 配布用の Android APK が見つかりません: {apk_path} "
            "（先に .\\python\\python.exe scripts\\build_android_apk.py を実行してください）",
        )

    apk_mtime = apk_path.stat().st_mtime
    source_candidates: List[Path] = [
        root_dir / "android" / "settings.gradle",
        root_dir / "android" / "build.gradle",
        root_dir / "android" / "gradle.properties",
        root_dir / "android" / "app" / "build.gradle",
        root_dir / "android" / "app" / "src" / "main" / "AndroidManifest.xml",
        root_dir / "frontend" / "mobile.html",
        root_dir / "frontend" / "manifest_mobile.json",
        root_dir / "frontend" / "sw_mobile.js",
        root_dir / "frontend" / "css" / "mobile.css",
        root_dir / "frontend" / "css" / "touch-responsive.css",
        root_dir / "frontend" / "css" / "touch-fieldlog.css",
        root_dir / "frontend" / "js" / "mobile.js",
        root_dir / "frontend" / "js" / "privacy_mask_editor.js",
        root_dir / "server" / "mobile_bundle.py",
    ]
    icons_dir = root_dir / "frontend" / "icons"
    if icons_dir.is_dir():
        source_candidates.extend(sorted(p for p in icons_dir.rglob("*") if p.is_file()))
    privacy_models_dir = root_dir / "models" / "privacy"
    if privacy_models_dir.is_dir():
        source_candidates.extend(sorted(privacy_models_dir.glob("*.onnx")))
    java_dir = root_dir / "android" / "app" / "src" / "main" / "java"
    if java_dir.is_dir():
        source_candidates.extend(sorted(java_dir.rglob("*.kt")))
    res_dir = root_dir / "android" / "app" / "src" / "main" / "res"
    if res_dir.is_dir():
        source_candidates.extend(sorted(p for p in res_dir.rglob("*") if p.is_file()))
    for sub in ("core", "adapters", "views/touch"):
        js_sub = root_dir / "frontend" / "js" / sub
        if js_sub.is_dir():
            source_candidates.extend(sorted(js_sub.rglob("*.js")))

    newer_files: List[Tuple[float, str]] = []
    for src in source_candidates:
        if not src.is_file():
            continue
        st_m = src.stat().st_mtime
        if st_m > apk_mtime + 1e-6:
            newer_files.append((st_m, src.relative_to(root_dir).as_posix()))

    if newer_files:
        newer_files.sort(reverse=True)
        samples = ", ".join(rel for _, rel in newer_files[:3])
        extra = f" ほか {len(newer_files) - 3} 件" if len(newer_files) > 3 else ""
        return (
            False,
            f"dist_v2/android/Tetheract_Android.apk がソースより古くなっています"
            f"（更新検知: {samples}{extra}）。"
            "先に .\\python\\python.exe scripts\\build_android_apk.py を実行して APK を再ビルドしてください。",
        )

    return True, f"dist_v2/android/Tetheract_Android.apk は最新です ({apk_path.stat().st_size / (1024 * 1024):.2f} MB)"


def _run_git(*args: str) -> str:
    """git コマンドを実行し標準出力を返す"""
    res = subprocess.run(
        ["git", *args],
        cwd=str(ROOT_DIR),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    )
    return res.stdout.strip()


def _get_github_token() -> str:
    """Git Credential Manager から github.com の認証トークンを取得する"""
    env_tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env_tok:
        return env_tok.strip()

    proc = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        cwd=str(ROOT_DIR),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    )
    creds: Dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip()
    token = creds.get("password", "")
    if not token:
        raise RuntimeError("Git Credential Manager から GitHub トークンを取得できませんでした。")
    return token


def _github_api_request(
    method: str,
    url: str,
    token: str,
    json_body: Optional[Dict[str, Any]] = None,
    raw_data: Optional[bytes] = None,
    content_type: str = "application/json",
    timeout: int = 600,
) -> Any:
    """GitHub REST API へリクエストを送信し JSON レスポンスを返す"""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "PhotoManager-ReleasePublisher",
    }
    data_bytes = raw_data
    if json_body is not None:
        data_bytes = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    elif raw_data is not None:
        headers["Content-Type"] = content_type
        headers["Content-Length"] = str(len(raw_data))

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else None


def read_release_title(notes_path: Path, version: str) -> str:
    """リリースノート冒頭の `- **Title**: `...`` 行からリリースタイトルを取得する（無ければ既定タイトル）"""
    match = re.search(r"^- \*\*Title\*\*:\s*`([^`]+)`", notes_path.read_text(encoding="utf-8"), re.MULTILINE)
    if match:
        return match.group(1).strip()
    print(f"[WARN] {notes_path.name} に Title 行が無いため既定タイトルを使用します。")
    return f"Tetheract Photo Manager v{version}"


def sync_public_repository(
    tag_name: str,
    target_public_branch: str = "main",
    allow_v2_public: bool = False,
) -> str:
    """現在の HEAD ツリーを公開リポジトリの指定ブランチへ反映しタグをプッシュする"""
    ensure_safe_release_target(
        target_public_branch=target_public_branch,
        allow_v2_public=allow_v2_public,
    )
    print(f"[1/3] Syncing public repository ({PUBLIC_REMOTE}: {PUBLIC_REPO} -> {target_public_branch})...")
    _run_git("fetch", PUBLIC_REMOTE)

    head_tree = _run_git("rev-parse", "HEAD^{tree}")
    head_subject = _run_git("log", "-1", "--format=%s", "HEAD")

    try:
        pub_tree = _run_git("rev-parse", f"{PUBLIC_REMOTE}/{target_public_branch}^{{tree}}")
        branch_exists = True
    except subprocess.CalledProcessError:
        pub_tree = ""
        branch_exists = False

    if branch_exists and head_tree == pub_tree:
        pub_commit = _run_git("rev-parse", f"{PUBLIC_REMOTE}/{target_public_branch}")
        print(f"      {PUBLIC_REMOTE}/{target_public_branch} tree is already up to date ({pub_commit[:7]}).")
    else:
        parent_ref = f"{PUBLIC_REMOTE}/{target_public_branch}" if branch_exists else f"{PUBLIC_REMOTE}/main"
        pub_parent = _run_git("rev-parse", parent_ref)
        pub_commit = _run_git("commit-tree", head_tree, "-p", pub_parent, "-m", head_subject)
        _run_git("push", PUBLIC_REMOTE, f"{pub_commit}:refs/heads/{target_public_branch}")
        print(f"      Pushed new commit {pub_commit[:7]} to {PUBLIC_REMOTE}/{target_public_branch}.")

    _run_git("push", PUBLIC_REMOTE, f"{pub_commit}:refs/tags/{tag_name}", "--force")
    print(f"      Pushed tag {tag_name} -> {pub_commit[:7]} on {PUBLIC_REMOTE}.")
    return pub_commit


def upsert_github_release(
    token: str,
    tag_name: str,
    release_title: str,
    release_body: str,
    target_commitish: str = "main",
    prerelease: bool = False,
) -> Dict[str, Any]:
    """GitHub Release を取得または新規作成し、本文を最新化する"""
    print(f"[2/3] Creating / updating GitHub Release for {tag_name} (prerelease={prerelease})...")
    tag_url = f"https://api.github.com/repos/{PUBLIC_REPO}/releases/tags/{urllib.parse.quote(tag_name)}"
    existing: Optional[Dict[str, Any]] = None
    try:
        existing = _github_api_request("GET", tag_url, token)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    if existing:
        release_id = existing["id"]
        patch_url = f"https://api.github.com/repos/{PUBLIC_REPO}/releases/{release_id}"
        release = _github_api_request(
            "PATCH",
            patch_url,
            token,
            json_body={
                "tag_name": tag_name,
                "name": release_title,
                "body": release_body,
                "draft": False,
                "prerelease": prerelease,
            },
        )
        print(f"      Updated existing release id={release_id}.")
        return release

    create_url = f"https://api.github.com/repos/{PUBLIC_REPO}/releases"
    release = _github_api_request(
        "POST",
        create_url,
        token,
        json_body={
            "tag_name": tag_name,
            "target_commitish": target_commitish,
            "name": release_title,
            "body": release_body,
            "draft": False,
            "prerelease": prerelease,
        },
    )
    print(f"      Created new release id={release['id']}.")
    return release


def upload_release_assets(
    token: str,
    release: Dict[str, Any],
    asset_paths: list[Path],
) -> None:
    """Release に ZIP アセットをアップロードする（同名アセットがあれば差し替え）"""
    print("[3/3] Uploading release ZIP assets...")
    release_id = release["id"]
    existing_assets = {a["name"]: a for a in release.get("assets", [])}

    for path in asset_paths:
        name = path.name
        size_mb = path.stat().st_size / (1024 * 1024)
        if name in existing_assets:
            asset_id = existing_assets[name]["id"]
            del_url = f"https://api.github.com/repos/{PUBLIC_REPO}/releases/assets/{asset_id}"
            print(f"      Removing existing asset {name} (id={asset_id})...")
            _github_api_request("DELETE", del_url, token)

        upload_url = (
            f"https://uploads.github.com/repos/{PUBLIC_REPO}/releases/{release_id}/assets"
            f"?name={urllib.parse.quote(name)}"
        )
        print(f"      Uploading {name} ({size_mb:.2f} MB)...")
        raw_bytes = path.read_bytes()
        uploaded = _github_api_request(
            "POST",
            upload_url,
            token,
            raw_data=raw_bytes,
            content_type="application/zip",
            timeout=900,
        )
        print(f"      [OK] Uploaded {uploaded['name']} ({uploaded['size'] / (1024 * 1024):.2f} MB)")


def main() -> None:
    """エントリーポイント"""
    parser = argparse.ArgumentParser(description="Publish Photo Manager release to GitHub Releases.")
    parser.add_argument("--build", action="store_true", help="Run build_dist.bat before publishing")
    parser.add_argument("--title", default=None, help="Release title on GitHub (省略時はリリースノートの Title 行)")
    parser.add_argument(
        "--public-branch",
        default="main",
        help="Target branch on public repository (default: main)",
    )
    parser.add_argument(
        "--allow-v2-public",
        action="store_true",
        help="Explicitly allow publishing v2.x to a non-main public branch (e.g. --public-branch v2)",
    )
    parser.add_argument(
        "--prerelease",
        action="store_true",
        help="Mark the GitHub Release as a pre-release (keeping v1.8.x as Latest)",
    )
    parser.add_argument(
        "--check-v2-apk",
        action="store_true",
        help="Check dist_v2/android/Tetheract_Android.apk existence and source freshness only, then exit",
    )
    args = parser.parse_args()

    if args.check_v2_apk:
        ok, msg = check_v2_apk_freshness(ROOT_DIR)
        if ok:
            print(f"        [OK] {msg}")
            return
        print(f"[ERROR] {msg}", file=sys.stderr)
        sys.exit(1)

    ver = get_version()
    ensure_safe_release_target(
        version=ver,
        target_public_branch=args.public_branch,
        allow_v2_public=args.allow_v2_public,
    )
    tag_name = f"v{ver}"
    notes_path = ROOT_DIR / "docs" / "release_notes" / f"RELEASE_NOTES_v{ver}.md"
    diff_zip = ROOT_DIR / f"Tetheract_v{ver}diff.zip"
    full_zip = ROOT_DIR / f"Tetheract_v{ver}.zip"

    if not notes_path.exists():
        raise FileNotFoundError(f"リリースノートが見つかりません: {notes_path}")

    if args.build or not diff_zip.exists() or not full_zip.exists():
        print("[INFO] Running build_dist.bat to generate distribution packages...")
        env = os.environ.copy()
        env["NO_PAUSE"] = "1"
        subprocess.run(["cmd", "/c", "build_dist.bat"], cwd=str(ROOT_DIR), env=env, check=True)

    for z in (diff_zip, full_zip):
        if not z.exists():
            raise FileNotFoundError(f"配布用ZIPが見つかりません: {z}")

    release_body = notes_path.read_text(encoding="utf-8")
    token = _get_github_token()

    sync_public_repository(
        tag_name,
        target_public_branch=args.public_branch,
        allow_v2_public=args.allow_v2_public,
    )
    release = upsert_github_release(
        token,
        tag_name,
        args.title or read_release_title(notes_path, ver),
        release_body,
        target_commitish=args.public_branch,
        prerelease=args.prerelease,
    )
    upload_release_assets(token, release, [full_zip, diff_zip])

    print("\n============================================================")
    print(f"  [SUCCESS] Published {tag_name} to GitHub Releases!")
    print(f"  URL: {release.get('html_url')}")
    print("============================================================")


if __name__ == "__main__":
    main()
