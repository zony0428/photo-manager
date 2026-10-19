# uploads 写真のリンク切れ自動クリーンアップ & 削除機能の確認

一時保管・持ち帰り用として利用される `uploads` フォルダの写真について、エクスプローラー等で実ファイルが削除された際に、DB（メタデータ・サムネイル・タグ）から自動的に完全クリーンアップする仕組み、および画面上からの削除機能を実装・検証しました。

---

## 主な変更点

### 1. リンク切れ写真の自動クリーンアップ
- [server/database.py](file:///r:/photo-manager/server/database.py)
  - `cleanup_missing_upload_photos(upload_dir: Path)` 関数を実装。
  - `uploads` フォルダ配下の写真で、実ファイルが存在しないものを自動検出し、`photos`, `thumbnails`, `photo_tags` の関連レコードを一括削除。
  - **安全性**: 外付けHDDやSDカード等の通常フォルダの写真（オフライン写真）は一切削除されず保護されます。
- [server/app.py](file:///r:/photo-manager/server/app.py)
  - サーバー起動時（`lifespan`）および写真一覧取得時（`api_get_photos`）に `cleanup_missing_upload_photos` を自動呼び出し。
  - これにより、エクスプローラーでファイルを削除した後にアプリ画面を開くだけで、自動的にDBからも完全消去されます。

### 2. 個別写真の削除 API & UI 操作
- [server/app.py](file:///r:/photo-manager/server/app.py)
  - `DELETE /api/photo/{photo_id}` エンドポイントを追加（`delete_file=True` で実ファイルのディスク削除も可能）。
- [frontend/index.html](file:///r:/photo-manager/frontend/index.html) & [frontend/js/app.js](file:///r:/photo-manager/frontend/js/app.js)
  - 写真を右クリックしたときのコンテキストメニューに **「🗑️ ライブラリから削除」** を追加。
  - 複数枚選択時の下部フローティングバーにも **「🗑️ 削除」** ボタンを追加。
  - 削除確認ダイアログ（`uploads` フォルダの写真の場合は実ファイルも削除される旨の案内）を経て安全に削除可能。

---

## 検証結果

### 1. 自動クリーンアップの単体テスト
- `uploads/test_temp_cleanup.jpg` を作成してDB登録。
- 実ファイルを削除後、`cleanup_missing_upload_photos` を実行。
- 該当レコードのみがDBから自動削除され、通常写真（オフライン含む800件）は1件も影響を受けずに保護されることを確認。

### 2. 個別写真削除（実ファイル連動）の単体テスト
- `delete_photo_by_id(photo_id, delete_file=True)` を実行。
- DBレコードおよびディスク上の画像ファイルが共に正常に削除されることを確認。

---

## 使い方

1. **エクスプローラーから消す場合**:
   - USBドライブ内の `uploads` フォルダを開き、不要になった写真ファイルを削除します。
   - アプリ画面を開く（または再読み込みする）だけで、ライブラリからも自動的に消えます。
2. **アプリ画面から消す場合**:
   - 写真を右クリックして **「🗑️ ライブラリから削除」** を選択するか、複数選択して画面下の **「🗑️ 削除」** をクリックします。
   - 確認ダイアログで「OK」を押すと、ライブラリ（および `uploads` 内の実ファイル）から削除されます。
