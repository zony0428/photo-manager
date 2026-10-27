# サムネイル保存方式 SQLite BLOB 移行リファクタリング

## 背景
現在、サムネイル画像は `.cache/thumbnails/` ディレクトリに `{photo_id}.webp` として個別ファイル保存されている。3,000枚を超えるとファイルI/O（ファイルオープン・exists確認・読み取り）の負荷でレスポンスが低下する問題が発生している。

SQLite の BLOB 格納方式に変更することで、以下のメリットが得られる：
- ファイルシステムへのI/Oオーバーヘッド削減（1つのDBファイルでランダムアクセス）
- WAL モードによる読み書き競合回避
- バッチ取得（IN句）による一括読み出しの効率化

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| [`database.py`](file:///r:/photo-manager/server/database.py) | `thumbnails` テーブル作成、BLOB CRUD 関数、PRAGMA 設定 |
| [`scanner.py`](file:///r:/photo-manager/server/scanner.py) | `ensure_thumbnail()` を DB 保存に変更、`get_thumbnail_path()` 廃止 |
| [`app.py`](file:///r:/photo-manager/server/app.py) | サムネイル配信エンドポイントを `Response(content=blob)` に変更 |
| [`migrate_thumbnails.py`](file:///r:/photo-manager/server/migrate_thumbnails.py) | [NEW] 既存ファイルからDBへの移行スクリプト |

### 変更不要なファイル
- **フロントエンド（`app.js`, `index.html`, `style.css`）**: API のパス `/api/photo/{id}/thumbnail` は変更しないため、フロントエンド側の変更は不要。

---

## 提案する変更内容

### 1. データベース層 ([`database.py`](file:///r:/photo-manager/server/database.py))

#### PRAGMA 設定（`get_connection()` に追加）
```python
conn.execute("PRAGMA journal_mode = WAL")
conn.execute("PRAGMA synchronous = NORMAL")
```

#### `thumbnails` テーブル作成（`initialize_database()` に追加）
```sql
CREATE TABLE IF NOT EXISTS thumbnails (
    file_hash TEXT PRIMARY KEY,
    photo_id INTEGER NOT NULL,
    data BLOB NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
)
CREATE INDEX IF NOT EXISTS idx_thumbnails_photo_id ON thumbnails(photo_id)
```

> [!NOTE]
> `file_hash` は `photo_id` から生成するシンプルなキー（`str(photo_id)`）としても機能させます。将来、ファイルパス+更新日時のハッシュに拡張可能な構造です。

#### 新規関数

| 関数名 | 機能 |
|---|---|
| `save_thumbnail(photo_id, data, width, height)` | BLOB をトランザクション内で INSERT/REPLACE |
| `save_thumbnails_batch(items)` | `[(photo_id, data, w, h), ...]` をまとめて1トランザクションで INSERT |
| `get_thumbnail(photo_id)` | 単一サムネイルの BLOB 取得 |
| `get_thumbnails_batch(photo_ids)` | `IN (?, ?, ...)` で複数サムネイルを一括取得 → `{photo_id: {data, width, height}}` |
| `delete_thumbnail(photo_id)` | 写真削除時のサムネイル削除 |

---

### 2. スキャナ層 ([`scanner.py`](file:///r:/photo-manager/server/scanner.py))

#### `ensure_thumbnail()` の変更
- **Before**: ファイルの存在確認 → なければ生成して `.webp` ファイルに保存 → ファイルパスを返す
- **After**: DB にサムネイルが存在するか確認 → なければ生成して BLOB として DB に保存 → `(data, width, height)` タプルを返す

#### `get_thumbnail_path()` の廃止
- この関数は削除し、代わりに `database.get_thumbnail()` を使う

#### `THUMBNAIL_DIR` の削除
- サムネイルディレクトリの作成・参照を廃止

---

### 3. API 層 ([`app.py`](file:///r:/photo-manager/server/app.py))

#### `GET /api/photo/{photo_id}/thumbnail` の変更
```python
# Before: FileResponse(str(thumb_path), media_type="image/webp")
# After:
thumb_data = ensure_thumbnail(photo["id"], photo["file_path"])
return Response(
    content=thumb_data,
    media_type="image/webp",
    headers={"Cache-Control": "public, max-age=86400"},
)
```

#### `GET /api/photo/{photo_id}/view`（オフライン時のフォールバック）の変更
```python
# Before: get_thumbnail_path(photo_id) → FileResponse
# After: get_thumbnail(photo_id) → Response(content=blob)
```

#### [NEW] `GET /api/thumbnails/batch`（バッチ取得エンドポイント）
- クエリパラメータ `ids=1,2,3,...` を受け取り、一括で Base64 エンコードされたサムネイルを JSON で返す
- フロントエンドの将来の最適化で利用可能

> [!NOTE]
> 現在のフロントエンドは個別の `<img src="/api/photo/{id}/thumbnail">` で取得するため、バッチAPIは互換性を壊さない追加エンドポイントとして用意します。

---

### 4. 移行スクリプト ([NEW] [`migrate_thumbnails.py`](file:///r:/photo-manager/server/migrate_thumbnails.py))

```
機能:
1. .cache/thumbnails/ 内の全 .webp ファイルを走査
2. ファイル名（{photo_id}.webp）から photo_id を抽出
3. WebP バイナリを読み込み、Pillow で width/height を取得
4. 1トランザクション内でまとめて thumbnails テーブルに INSERT
5. 完了後、確認プロンプトを表示してから .cache/thumbnails/ ディレクトリを削除
6. 進捗バー表示（処理件数/全件数）
```

---

## User Review Required

> [!IMPORTANT]
> **バッチ取得API**: `GET /api/thumbnails/batch` エンドポイントは追加のみで、既存の個別取得APIは維持します。フロントエンドの変更は現時点では行いません。将来的にフロントエンドでバッチ取得を利用する場合に備えた準備となります。

> [!IMPORTANT]
> **`file_hash` のキー設計**: 要件では「元画像の絶対パス+更新日時のハッシュ」とありますが、現在のサムネイルは `photo_id` ベースで管理されているため、`file_hash` = SHA-256(`file_path` + `mtime`) のハッシュ値をキーとしつつ、`photo_id` でもインデックス検索できる設計とします。これにより、写真のパスが変わった場合でもサムネイルの再生成判定が正確になります。

---

## 検証計画

### 自動テスト
```bash
# 移行スクリプトのドライラン
python -m server.migrate_thumbnails --dry-run

# サーバ起動テスト
python run.py
```

### 手動検証
1. サーバ起動後、ブラウザでサムネイル表示を確認
2. 新規スキャン時のサムネイル生成がDBに正しく保存されることを確認
3. オフライン時のフォールバック（スマートプレビュー）が正常動作することを確認
4. 移行スクリプト実行後、旧 `.cache/thumbnails/` ディレクトリが安全に削除されることを確認
