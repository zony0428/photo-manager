# 実装計画: サムネイル取得・更新機能の実装 (v1.39)

## 1. 概要
写真ギャラリーにおいて、取り込み直後や大量スキャン時にプレースホルダー（サムネイル未生成）が並んでいる状態から、右クリックメニューまたは下部フローティング選択バーより即座に「サムネイルを取得」できるようにする。
また、既にサムネイルが生成されている写真に対しても、元画像更新時や再生成ニーズに応えて「サムネイルを更新」できるようにする。複数写真選択時の一括処理にも完全対応する。

## 2. ユーザー体験（UI/UX設計）

### 2.1 右クリックコンテキストメニュー（`#contextMenu`）
- **未取得（プレースホルダー）の写真が1枚でも含まれる場合**:
  - 文言: `🖼️ サムネイルを取得` （複数選択時は `🖼️ サムネイルを取得 (${count}枚)`）
- **選択中の写真すべてが取得済みの場合**:
  - 文言: `🔄 サムネイルを更新` （複数選択時は `🔄 サムネイルを更新 (${count}枚)`）

### 2.2 下部フローティング選択バー（`#selectionFloatingBar`）
- ボタンを追加:
  - 未取得が含まれる場合: `🖼️ サムネイル取得`
  - 全て取得済みの場合: `🔄 サムネイル更新`

### 2.3 実行中の視覚的フィードバックと即時画面反映
- **実行中**:
  - トースト通知（例: `「3枚のサムネイルを更新中...」`）
  - 対象カードにローディング演出（`.thumb-refreshing` クラスによるパルスまたは半透明スピナー）
- **完了後**:
  - トースト通知（例: `「3枚のサムネイルを更新しました」`）
  - 対象カードの `img.src` をキャッシュバスター付きURL（`/api/photo/${id}/thumbnail?t=${Date.now()}`）に即座に差し替え、ブラウザキャッシュを迂回して即時更新
  - 右ペイン（インスペクタ）が表示中の場合も自動追従
  - 選択中バーおよびコンテキストメニューの文言を最新状態に更新

## 3. バックエンド設計

### 3.1 DB層 (`server/database/photos.py`)
- `get_photos()` のクエリにおいて、サムネイル有無フラグ `has_thumbnail` を返却するよう改修：
  - `LEFT JOIN (SELECT DISTINCT photo_id FROM thumbnails) t ON p.id = t.photo_id`
  - `p.*, ... (t.photo_id IS NOT NULL) AS has_thumbnail`
  - これによりフロントエンド側で高速・確実に「サムネイル未生成」を判定可能にする。

### 3.2 APIエンドポイント (`server/app.py`)
- `POST /api/thumbnails/refresh`
  - リクエスト: `{"photo_ids": [int, ...], "force": bool}`
  - 処理:
    1. 指定された写真の実ファイルパスを `resolve_portable_path` で解決。
    2. 接続中の写真に対し、`render_thumbnail_webp()` を `ThreadPoolExecutor` で並列生成。
    3. `save_thumbnail` で SQLite BLOB として保存。
    4. 結果（成功IDリスト、失敗IDリスト）をJSON返却。

## 4. フロントエンド設計

### 4.1 HTML (`frontend/index.html`)
- `#contextMenu` に `#contextMenuRefreshThumbItem` を配置。
- `#selectionFloatingBar` に `#floatingRefreshThumbBtn` を配置。

### 4.2 CSS (`frontend/css/style.css`)
- `.photo-card.thumb-refreshing` のローディング・パルススタイルを追加。

### 4.3 JS (`frontend/js/selection.js`, `frontend/js/common.js`)
- `updateSelectionUI()` および `openContextMenu()` で選択写真の `has_thumbnail` をチェックし、文言を「取得」/「更新」に切り替え。
- `refreshSelectedThumbnails()` 関数を実装し、API呼び出しとキャッシュバスターによる画像URL即時置換を実行。

## 5. バージョンアップ & ドキュメント同期
- `VERSION` / `server/version.py`: `1.38` → `1.39`
- `frontend/index.html`: 静的アセットキャッシュクエリ `?v=1.39`
- `MANUAL.md` およびアプリ内 `#helpModal`: 右クリックメニューおよび下部バーからのサムネイル取得・更新操作方法を追記

## 6. 検証手順
1. バックエンド単体動作テスト（テストスクリプトで `POST /api/thumbnails/refresh` の並列実行とDB更新を検証）
2. ブラウザ画面での動作確認:
   - 単一写真での「サムネイルを更新」動作確認
   - 複数写真選択での一括更新動作確認
   - 画面がリロードなしで即座にパッと切り替わることの確認
   - トースト通知およびボタン文言の切り替わり確認
3. バージョン表記およびマニュアル記載の整合性確認
