"""
サムネイル移行スクリプト
既存の個別WebPファイル (.cache/thumbnails/*.webp) を SQLite BLOB (thumbnails テーブル) に移行する。

使い方:
  python -m server.migrate_thumbnails              # 実行
  python -m server.migrate_thumbnails --dry-run     # ドライラン（実際には書き込まない）
  python -m server.migrate_thumbnails --no-cleanup  # 移行後にファイル削除しない
"""

import argparse
import sys
import shutil
from pathlib import Path
from PIL import Image

# プロジェクトルートをパスに追加
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.database import (
    CACHE_DIR,
    initialize_database,
    save_thumbnails_batch,
    get_connection,
    compute_thumbnail_hash,
)

THUMBNAIL_DIR = CACHE_DIR / "thumbnails"


def migrate_thumbnails(dry_run: bool = False, cleanup: bool = True) -> dict:
    """
    .cache/thumbnails/ 内の全 .webp ファイルを走査し、
    SQLite thumbnails テーブルに一括移行する。
    """
    if not THUMBNAIL_DIR.exists():
        print("[INFO] サムネイルディレクトリが存在しません。移行するファイルがありません。")
        return {"total": 0, "migrated": 0, "skipped": 0, "errors": 0}

    webp_files = list(THUMBNAIL_DIR.glob("*.webp"))
    total = len(webp_files)

    if total == 0:
        print("[INFO] 移行対象のWebPファイルがありません。")
        return {"total": 0, "migrated": 0, "skipped": 0, "errors": 0}

    print(f"[INFO] 移行対象: {total} 件のサムネイルファイル")
    if dry_run:
        print("[DRY-RUN] 実際の書き込みは行いません")

    # 既存のDB内サムネイルを確認（重複スキップ用）
    existing_photo_ids = set()
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT photo_id FROM thumbnails")
        for row in cursor.fetchall():
            existing_photo_ids.add(row["photo_id"])

    # photo_id → file_path のマッピングを取得（ハッシュ計算用）
    photo_paths = {}
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, file_path FROM photos")
        for row in cursor.fetchall():
            photo_paths[row["id"]] = row["file_path"]

    batch = []
    migrated = 0
    skipped = 0
    errors = 0

    for i, webp_file in enumerate(webp_files, 1):
        try:
            # ファイル名から photo_id を抽出 (例: "42.webp" → 42)
            stem = webp_file.stem
            if not stem.isdigit():
                print(f"  [SKIP] 非数値ファイル名: {webp_file.name}")
                skipped += 1
                continue

            photo_id = int(stem)

            # 既にDB内に存在する場合はスキップ
            if photo_id in existing_photo_ids:
                skipped += 1
                continue

            # WebPバイナリを読み込み
            data = webp_file.read_bytes()

            # Pillow で width/height を取得
            with Image.open(webp_file) as img:
                width, height = img.size

            # ファイルハッシュの計算
            file_path = photo_paths.get(photo_id, str(photo_id))
            file_hash = compute_thumbnail_hash(file_path)

            batch.append((photo_id, data, width, height, file_hash))
            migrated += 1

            # 進捗表示
            if i % 100 == 0 or i == total:
                pct = (i / total) * 100
                print(f"  [{i}/{total}] ({pct:.1f}%) 処理中...")

        except Exception as e:
            print(f"  [ERROR] {webp_file.name}: {e}")
            errors += 1

    # バッチ書き込み（1トランザクションでまとめてコミット）
    if batch and not dry_run:
        print(f"\n[INFO] {len(batch)} 件を1トランザクションでDBに書き込み中...")
        save_thumbnails_batch(batch)
        print("[INFO] DB書き込み完了")

    print(f"\n[結果] 合計: {total}, 移行: {migrated}, スキップ: {skipped}, エラー: {errors}")

    # クリーンアップ
    if cleanup and not dry_run and migrated > 0:
        print(f"\n[CLEANUP] 旧サムネイルディレクトリを削除しますか？ ({THUMBNAIL_DIR})")
        answer = input("  削除する場合は 'yes' を入力: ").strip().lower()
        if answer == "yes":
            shutil.rmtree(THUMBNAIL_DIR)
            print("[CLEANUP] 旧サムネイルディレクトリを削除しました")
        else:
            print("[CLEANUP] 削除をスキップしました（手動で削除してください）")

    return {"total": total, "migrated": migrated, "skipped": skipped, "errors": errors}


def main():
    parser = argparse.ArgumentParser(
        description="サムネイルを個別WebPファイルからSQLite BLOBに移行する"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="ドライラン: 実際のDB書き込みを行わずに処理内容を表示する",
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="移行後に旧サムネイルディレクトリの削除確認を行わない",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("サムネイル移行ツール: WebPファイル → SQLite BLOB")
    print("=" * 60)

    # DB初期化（thumbnailsテーブルが存在しない場合に作成）
    initialize_database()

    result = migrate_thumbnails(
        dry_run=args.dry_run,
        cleanup=not args.no_cleanup,
    )

    if result["migrated"] > 0 and not args.dry_run:
        print("\n✅ 移行が完了しました。サーバーを再起動してください。")
    elif args.dry_run and result["migrated"] > 0:
        print(f"\n📋 ドライラン完了: {result['migrated']} 件が移行対象です。")
        print("   --dry-run を外して実行すると実際に移行されます。")


if __name__ == "__main__":
    main()
