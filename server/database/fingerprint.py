"""
フォルダ指紋（フィンガープリント）管理モジュール
写真フォルダの構成指紋を生成・照合し、別PC・別アカウントの同名フォルダ誤読を防止する。
"""

import json
import os
from typing import Any, Dict, List, Optional, Tuple

from .connection import get_connection
# フィンガープリント抽出用に対象とする画像・RAW拡張子セット
FINGERPRINT_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff",
    ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".pef", ".raf"
}


def extract_folder_fingerprint(folder_path: str, max_samples: int = 5) -> Optional[str]:
    """
    フォルダ内の写真構成から代表指紋（フィンガープリント）を抽出する。
    写真ファイルへの書き込みは一切行わず（0バイト・完全リードオンリー）、
    かつオンデマンドファイル（Google Drive / OneDrive）の自動ダウンロードを避けるため、
    ディレクトリエントリのメタデータ（相対パス・ファイルサイズ）のみを参照する。

    Args:
        folder_path: ルートフォルダパス
        max_samples: サンプリングする代表枚数（デフォルト5枚）

    Returns:
        JSON文字列（サンプルリスト）、写真が存在しない場合は None
    """
    norm_folder = os.path.normpath(folder_path)
    if not os.path.exists(norm_folder) or not os.path.isdir(norm_folder):
        return None

    # ドライブ直下（C:\, G: 等）の丸ごと走査はシステムフリーズ防止のため禁止
    clean_norm = norm_folder.rstrip("\\/")
    if len(clean_norm) <= 2 or clean_norm.endswith(":"):
        return None

    candidates = []
    scanned_file_count = 0
    try:
        for root, _, files in os.walk(norm_folder):
            for f in files:
                scanned_file_count += 1
                if scanned_file_count > 3000:
                    # 巨大フォルダ（3000ファイル超）での起動時無限フリーズを防止
                    break
                ext = os.path.splitext(f)[1].lower()
                if ext in FINGERPRINT_EXTENSIONS:
                    full_p = os.path.join(root, f)
                    try:
                        # os.path.getsize はメタデータのみ参照するためオンデマンドダウンロードを起こさない
                        sz = os.path.getsize(full_p)
                        rel_p = os.path.relpath(full_p, norm_folder).replace("\\", "/")
                        candidates.append((rel_p, sz))
                    except (OSError, PermissionError):
                        continue
            if scanned_file_count > 3000:
                break
    except Exception as e:
        print(f"[WARN] 指紋サンプリング走査エラー: {e}")
        return None

    if not candidates:
        return None

    # 再現性のため相対パス順にソート
    candidates.sort(key=lambda x: x[0])
    total_count = len(candidates)

    # 均等に分散させて最大 max_samples 枚を選定
    selected = []
    if total_count <= max_samples:
        selected = candidates
    else:
        indices = [int(i * (total_count - 1) / (max_samples - 1)) for i in range(max_samples)]
        seen_idx = set()
        for idx in indices:
            if idx not in seen_idx:
                seen_idx.add(idx)
                selected.append(candidates[idx])

    fp_dict = {
        "version": 1,
        "total_scanned_files": total_count,
        "samples": [{"rel_path": rel, "size": sz} for rel, sz in selected]
    }
    return json.dumps(fp_dict, ensure_ascii=False)


def verify_folder_fingerprint(folder_path: str, stored_fp_json: Optional[str]) -> Tuple[bool, str]:
    """
    指定されたフォルダが、登録時の指紋（フィンガープリント）と合致するか検証する。
    写真ファイル本文は一切読まず、OSメタデータ（相対パスとサイズ）のみで瞬時に照合する。
    3〜5枚中2枚以上（または1〜2枚中1枚以上）が合致すれば同一ライブラリと承認する（多数決判定）。

    Args:
        folder_path: 検証対象のフォルダパス
        stored_fp_json: DBに保存されていた指紋JSON

    Returns:
        (is_valid: bool, reason: str)
    """
    if not stored_fp_json:
        return True, "初回スキャンのため指紋照合をスキップしました"

    try:
        fp_data = json.loads(stored_fp_json)
    except Exception as e:
        return True, f"指紋データ解析エラーのため照合スキップ: {e}"

    samples = fp_data.get("samples", [])
    if not samples:
        return True, "登録指紋サンプルが空のため照合スキップ"

    norm_folder = os.path.normpath(folder_path)
    if not os.path.exists(norm_folder):
        return False, f"指定されたフォルダが存在しません: {folder_path}"

    matched_count = 0
    missing_count = 0
    size_mismatch_count = 0
    total_samples = len(samples)

    for item in samples:
        rel = os.path.normpath(item["rel_path"])
        full_path = os.path.join(norm_folder, rel)
        if not os.path.exists(full_path):
            missing_count += 1
            continue
        try:
            curr_size = os.path.getsize(full_path)
            if curr_size == item["size"]:
                matched_count += 1
            else:
                size_mismatch_count += 1
        except Exception:
            missing_count += 1

    # 判定閾値（マジョリティ判定）
    # 写真の微細な整理・追加・削除による誤検知を防ぐ
    if total_samples >= 3:
        pass_threshold = 2
    else:
        pass_threshold = 1

    if matched_count >= pass_threshold:
        return True, f"指紋照合合格（代表{total_samples}件中 {matched_count}件一致）"
    else:
        reason = (
            f"⚠️ セキュリティ警告: フォルダ内の写真構成が登録時と一致しません "
            f"（代表{total_samples}件中 {matched_count}件のみ一致）。\n"
            f"別PC・別アカウントのフォルダの可能性があります。"
            f"意図しないデータの読み取りや混入を防ぐため、スキャンを安全に中断しました。"
        )
        return False, reason


def get_scan_root_fingerprint(folder_path: str) -> Tuple[Optional[str], Optional[str]]:
    """指定されたフォルダ（またはその親となる登録ルート）の (ルートパス, 指紋JSON) を取得する"""
    norm_path = os.path.normpath(folder_path)
    with get_connection() as conn:
        cursor = conn.cursor()
        # 1. 完全一致
        cursor.execute("SELECT folder_path, fingerprint FROM scan_roots WHERE folder_path = ?", (norm_path,))
        row = cursor.fetchone()
        if row and row["fingerprint"]:
            return row["folder_path"], row["fingerprint"]

        # 2. 親フォルダが登録ルートになっているケース（最長の親パスを優先）
        cursor.execute("SELECT folder_path, fingerprint FROM scan_roots WHERE fingerprint IS NOT NULL")
        matched_root = None
        matched_fp = None
        for r in cursor.fetchall():
            r_path = os.path.normpath(r["folder_path"])
            if norm_path.startswith(r_path + os.sep) or norm_path == r_path:
                if matched_root is None or len(r_path) > len(matched_root):
                    matched_root = r_path
                    matched_fp = r["fingerprint"]

        return matched_root, matched_fp


def update_scan_root_fingerprint(folder_path: str, fp_json: str) -> None:
    """指定された登録ルートの指紋JSONを更新する"""
    norm_path = os.path.normpath(folder_path)
    with get_connection() as conn:
        conn.execute(
            "UPDATE scan_roots SET fingerprint = ? WHERE folder_path = ?",
            (fp_json, norm_path)
        )
        conn.commit()

