# サムネイル SQLite BLOB 移行 - Walkthrough

## 変更概要

サムネイル画像の保存方式を **個別WebPファイル** (`.cache/thumbnails/{id}.webp`) から **SQLite BLOB格納** (`thumbnails` テーブル) にリファクタリングしました。

---

## 変更ファイル一覧

### [MODIFY] [`database.py`](file:///r:/photo-manager/server/database.py)

| 変更箇所 | 内容 |
|---|---|
| `get_connection()` | `PRAGMA journal_mode = WAL` と `PRAGMA synchronous = NORMAL` を追加 |
| `initialize_database()` | `thumbnails` テーブルと `idx_thumbnails_photo_id` インデックスを追加 |
| 新規関数群 | `compute_thumbnail_hash()`, `save_thumbnail()`, `save_thumbnails_batch()`, `get_thumbnail()`, `get_thumbnails_batch()`, `delete_thumbnail()`, `thumbnail_exists()` |

**スキーマ:**
```sql
CREATE TABLE thumbnails (
    file_hash TEXT PRIMARY KEY,       -- SHA-256(ファイルパス:mtime)
    photo_id INTEGER NOT NULL,        -- photos.id への外部キー
    data BLOB NOT NULL,               -- WebPバイナリ
    width INTEGER,
    height INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
)
```

---

### [MODIFY] [`scanner.py`](file:///r:/photo-manager/server/scanner.py)

| 変更箇所 | 内容 |
|---|---|
| `ensure_thumbnail()` | 戻り値を `Path` → `bytes` に変更。ファイル保存の代わりに `io.BytesIO` で WebP バイナリを生成し、`save_thumbnail()` で DB に保存 |
| `get_thumbnail_path()` | 移行互換用に残存（移行スクリプトからの参照用） |
| `THUMBNAIL_DIR` | ディレクトリの自動作成 (`mkdir`) を廃止 |

---

### [MODIFY] [`app.py`](file:///r:/photo-manager/server/app.py)

| 変更箇所 | 内容 |
|---|---|
| `GET /api/photo/{id}/thumbnail` | `FileResponse(path)` → `Response(content=blob)` に変更 |
| `GET /api/photo/{id}/view` | オフラインフォールバックを `get_thumbnail_path().exists()` → `db_get_thumbnail()` に変更 |
| `GET /api/thumbnails/batch` | **新規追加** — `ids=1,2,3` で複数サムネイルを IN 句で一括取得し Base64 JSON で返却 |
| import | `get_thumbnail_path` を削除、`db_get_thumbnail`, `get_thumbnails_batch` を追加 |

---

### [NEW] [`migrate_thumbnails.py`](file:///r:/photo-manager/server/migrate_thumbnails.py)

既存の `.cache/thumbnails/*.webp` を走査し、1トランザクションで一括 DB 移行するスクリプト。

```bash
# ドライラン
python -m server.migrate_thumbnails --dry-run

# 実行（移行後にクリーンアップ確認あり）
python -m server.migrate_thumbnails

# クリーンアップなしで移行のみ
python -m server.migrate_thumbnails --no-cleanup
```

---

## パフォーマンスチューニング要件の対応状況

| 要件 | 対応 |
|---|---|
| `PRAGMA journal_mode = WAL` | ✅ `get_connection()` で毎接続時に設定 |
| `PRAGMA synchronous = NORMAL` | ✅ `get_connection()` で毎接続時に設定 |
| 一括登録時の1トランザクションコミット | ✅ `save_thumbnails_batch()` で `executemany` → 1回の `commit()` |
| IN句バッチ取得 | ✅ `get_thumbnails_batch()` と `/api/thumbnails/batch` エンドポイント |

---

## テスト結果

### DB CRUD 単体テスト
- `save_thumbnail()` → `get_thumbnail()` → `thumbnail_exists()` → `get_thumbnails_batch()` → `delete_thumbnail()` 全合格

### API 統合テスト（1,761枚の写真環境）
- `GET /api/photo/{id}/thumbnail` → **200 OK** (12,434 bytes WebP)
- `GET /api/thumbnails/batch?ids=...` → **200 OK** (1件返却)
- サーバログで全サムネイルリクエストが **200 OK** で配信確認

### ブラウザ表示テスト
- サムネイルグリッド正常表示
- ライトボックス／インスペクタのプレビュー正常表示

---

## 既存ファイルの移行手順

既存の `.cache/thumbnails/` にWebPファイルがある場合、以下のコマンドで DB に移行できます：

```bash
cd r:\photo-manager
python\python.exe -m server.migrate_thumbnails
```

> [!TIP]
> サーバは初回アクセス時にサムネイルが DB に存在しなければ自動生成するため、移行スクリプトを実行しなくてもアプリケーションは正常動作します。移行スクリプトは「旧ファイルのクリーンアップ」と「初回アクセス時の再生成コスト回避」のために用意されています。
