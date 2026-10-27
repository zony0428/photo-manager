"""
GitHub Releases 自動公開スクリプト (Photo Manager)

実行内容:
1. VERSION ファイルから現在のバージョン番号 (例: 3.0.1) を取得
2. docs/release_notes/RELEASE_NOTES_v<VERSION>.md と配布ZIP 2種
   (PhotoManager_v<VERSION>diff.zip / PhotoManager_v<VERSION>.zip) の存在を検証
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
import subprocess
import sys
from typing import Any, Dict, Optional
import urllib.error
import urllib.parse
import urllib.request

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from server.version import get_version

PUBLIC_REPO = "zony0428/photo-manager"
PUBLIC_REMOTE = "public"
DEFAULT_RELEASE_TITLE = "Photo Manager (Windows USB-Portable)"


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


def sync_public_repository(tag_name: str) -> str:
    """現在の HEAD ツリーを公開リポジトリ (public/main) へ反映しタグをプッシュする"""
    print(f"[1/3] Syncing public repository ({PUBLIC_REMOTE}: {PUBLIC_REPO})...")
    _run_git("fetch", PUBLIC_REMOTE)

    head_tree = _run_git("rev-parse", "HEAD^{tree}")
    pub_tree = _run_git("rev-parse", f"{PUBLIC_REMOTE}/main^{{tree}}")
    head_subject = _run_git("log", "-1", "--format=%s", "HEAD")

    if head_tree == pub_tree:
        pub_commit = _run_git("rev-parse", f"{PUBLIC_REMOTE}/main")
        print(f"      public/main tree is already up to date ({pub_commit[:7]}).")
    else:
        pub_parent = _run_git("rev-parse", f"{PUBLIC_REMOTE}/main")
        pub_commit = _run_git("commit-tree", head_tree, "-p", pub_parent, "-m", head_subject)
        _run_git("push", PUBLIC_REMOTE, f"{pub_commit}:refs/heads/main")
        print(f"      Pushed new commit {pub_commit[:7]} to {PUBLIC_REMOTE}/main.")

    _run_git("push", PUBLIC_REMOTE, f"{pub_commit}:refs/tags/{tag_name}", "--force")
    print(f"      Pushed tag {tag_name} -> {pub_commit[:7]} on {PUBLIC_REMOTE}.")
    return pub_commit


def upsert_github_release(
    token: str,
    tag_name: str,
    release_title: str,
    release_body: str,
) -> Dict[str, Any]:
    """GitHub Release を取得または新規作成し、本文を最新化する"""
    print(f"[2/3] Creating / updating GitHub Release for {tag_name}...")
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
                "prerelease": False,
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
            "target_commitish": "main",
            "name": release_title,
            "body": release_body,
            "draft": False,
            "prerelease": False,
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
    parser.add_argument("--title", default=DEFAULT_RELEASE_TITLE, help="Release title on GitHub")
    args = parser.parse_args()

    ver = get_version()
    tag_name = f"v{ver}"
    notes_path = ROOT_DIR / "docs" / "release_notes" / f"RELEASE_NOTES_v{ver}.md"
    diff_zip = ROOT_DIR / f"PhotoManager_v{ver}diff.zip"
    full_zip = ROOT_DIR / f"PhotoManager_v{ver}.zip"

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

    sync_public_repository(tag_name)
    release = upsert_github_release(token, tag_name, args.title, release_body)
    upload_release_assets(token, release, [full_zip, diff_zip])

    print("\n============================================================")
    print(f"  [SUCCESS] Published {tag_name} to GitHub Releases!")
    print(f"  URL: {release.get('html_url')}")
    print("============================================================")


if __name__ == "__main__":
    main()
