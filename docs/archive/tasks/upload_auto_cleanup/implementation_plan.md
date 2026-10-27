# uploads 写真のリンク切れ自動クリーンアップ & 削除機能 実装計画

一時的に写真を保管・持ち帰る用途として使われる `uploads` フォルダの写真について、エクスプローラー等で実ファイルが削除された際に、DB（メタデータ、サムネイル、タグ）から自動的に完全クリーンアップする仕組みを実装します。また、UI上（右クリックメニュー等）からも直接写真を削除できるようにします。

---

## ユーザー確認事項 (User Review Required)

> [!IMPORTANT]
> - **対象範囲の限定（安全性）**:
>   - 自動削除されるのは **`uploads` フォルダ配下の写真のみ** です。
>   - 外付けHDDやSDカード等の通常フォルダの写真が未接続（オフライン）になった場合は、これまで通りオフライン写真としてDBに残ります（誤って大事なライブラリデータが消えることはありません）。
> - **自動クリーンアップのタイミング**:
>   - アプリ起動時（サーバー立ち上げ時）
>   - 写真一覧取得時（画面を開いたときやリロード時）
>   - これにより、エクスプローラーでファイルを削除した後にアプリ画面を開くだけで、自動的にライブラリからキレイサッパリ消えます。

---

## 変更内容の提案

### 1. バックエンド (サーバー側)

#### [MODIFY] [database.py](file:///r:/photo-manager/server/database.py)
- `cleanup_missing_upload_photos(upload_dir: Path) -> int` 関数を新設。
  - `photos` テーブルから `directory_path` が `uploads` 配下のレコードを抽出。
  - 実ファイルが存在しないレコードの ID を特定。
  - 紐付く `photo_tags`, `thumbnails`, `photos` からレコードを安全に一括削除。
- `delete_photo_by_id(photo_id: int, delete_file: bool = False) -> bool` 関数を新設。
  - 単一の写真をDBから削除。`delete_file=True` の場合は実ファイルもディスク上から削除（`uploads` フォルダ内のファイル等）。

#### [MODIFY] [app.py](file:///r:/photo-manager/server/app.py)
- `lifespan` 起動処理内で `cleanup_missing_upload_photos(UPLOAD_DIR)` を実行。
- `api_get_photos`（写真一覧取得エンドポイント）の先頭で `cleanup_missing_upload_photos(UPLOAD_DIR)` を実行。
- `DELETE /api/photo/{photo_id}` エンドポイントを追加（クエリ引数 `delete_file: bool = False`）。

---

### 2. フロントエンド (クライアント側)

#### [MODIFY] [app.js](file:///r:/photo-manager/frontend/js/app.js)
- 写真の右クリックメニュー（コンテキストメニュー）に **「ライブラリから削除」**（`uploads` フォルダの写真の場合は「ファイルを完全に削除」）を追加。
- 削除実行後にグリッドを再描画。

#### [MODIFY] [index.html](file:///r:/photo-manager/frontend/index.html)
- コンテキストメニューに削除用メニュー項目を追加。

---

## 検証計画 (Verification Plan)

### 1. 単体テスト
- `uploads/` フォルダにテスト用ダミー画像を作成してDB登録。
- 実ファイルを削除した状態で `cleanup_missing_upload_photos` を呼び出し、該当レコードのみがDBから削除され、通常写真は削除されないことを確認。

### 2. 実機・手動検証
1. `uploads` フォルダに写真をドラッグ＆ドロップで追加。
2. エクスプローラーからその写真ファイルを削除。
3. アプリ画面を再読み込みし、該当写真が一覧から自動消去されていることを確認。
4. 通常スキャンした外付けフォルダの写真がオフライン時でも保持されていることを確認。
