# サムネイル SQLite BLOB 移行 - タスクリスト

## 1. データベース層 (`database.py`)
- [x] `get_connection()` に PRAGMA WAL / synchronous=NORMAL を追加
- [x] `initialize_database()` に `thumbnails` テーブル作成を追加
- [x] `save_thumbnail()` 関数を追加
- [x] `save_thumbnails_batch()` 関数を追加
- [x] `get_thumbnail()` 関数を追加
- [x] `get_thumbnails_batch()` 関数を追加
- [x] `delete_thumbnail()` 関数を追加
- [x] `thumbnail_exists()` 関数を追加
- [x] `compute_thumbnail_hash()` 関数を追加

## 2. スキャナ層 (`scanner.py`)
- [x] `ensure_thumbnail()` を DB 保存方式に変更（bytes 返却）
- [x] `get_thumbnail_path()` を移行互換用に維持
- [x] `THUMBNAIL_DIR` のディレクトリ自動作成を廃止

## 3. API 層 (`app.py`)
- [x] `GET /api/photo/{id}/thumbnail` を Response(content=blob) に変更
- [x] `GET /api/photo/{id}/view` のオフラインフォールバックを DB 対応に変更
- [x] `GET /api/thumbnails/batch` バッチ取得エンドポイントを追加
- [x] import 文の更新（不要な get_thumbnail_path を削除）

## 4. 移行スクリプト
- [x] `migrate_thumbnails.py` を新規作成（--dry-run / --no-cleanup 対応）

## 5. 検証
- [x] DB CRUD 関数の単体テスト合格
- [x] サーバ起動テスト OK（1,761枚の写真環境）
- [x] サムネイルAPI動作確認（12,434 bytes の WebP BLOB 正常配信）
- [x] バッチAPI動作確認
- [x] ブラウザでサムネイルグリッド表示確認
- [x] ライトボックス／インスペクタのプレビュー表示確認
