"""
バージョン情報管理モジュール
VERSION ファイルから現在のバージョン番号および最終更新日時を取得する。
"""

from datetime import datetime
from pathlib import Path
import re
from typing import Dict

# VERSION ファイルのパス（プロジェクトルート）
_VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION"


def get_version_info() -> Dict[str, str]:
    """現在のバージョン番号と最終更新日時を辞書で取得する"""
    version_str = "1.0.0"
    updated_at = ""
    try:
        if _VERSION_FILE.exists():
            raw = _VERSION_FILE.read_text(encoding="utf-8").strip()
            lines = [line.strip() for line in raw.splitlines() if line.strip()]
            if lines:
                # 1行目: "3.0.1" または "3.0.1 (2026-10-27 15:40)" 等に対応
                first = lines[0]
                m_inline = re.match(r"^v?([0-9]+(?:\.[0-9]+)*)\s*(?:\((.+?)\))?$", first, re.IGNORECASE)
                if m_inline:
                    version_str = m_inline.group(1)
                    if m_inline.group(2):
                        updated_at = m_inline.group(2).strip()
                else:
                    version_str = first.lstrip("vV").strip()

                # 2行目以降: "Updated: 2026-10-16 17:25" または日時文字列
                for line in lines[1:]:
                    cleaned = re.sub(r"^(?:updated|last\s*updated|最終更新(?:日時)?)\s*[:：]\s*", "", line, flags=re.IGNORECASE).strip()
                    if cleaned:
                        updated_at = cleaned
                        break

            # ファイル内に日時記載がない場合はファイルの更新日時をフォールバックとして使用
            if not updated_at:
                mtime = _VERSION_FILE.stat().st_mtime
                updated_at = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
    except Exception as e:
        print(f"[WARN] バージョン読み込みエラー: {e}")

    return {
        "version": version_str,
        "updated_at": updated_at,
    }


def get_version() -> str:
    """現在のバージョン番号文字列を取得する（フォールバック: 1.0.0）"""
    return get_version_info()["version"]


__version__ = get_version()

