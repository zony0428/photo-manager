# タスクリスト: インポート（送る）機能の実装（JPG限定）

- [x] 実装計画の作成 (`docs/import_photos_feature/implementation_plan.md`) <!-- id: 0 -->
- [x] サーバー側 API の実装 (`server/app.py`) <!-- id: 1 -->
  - [x] `import` フォルダの確保（実行環境ルート直下 `r:/photo-manager/import`）
  - [x] スキャナー (`server/scanner.py`) で `import` フォルダをスキャン対象外に設定
  - [x] 送り先フォルダ一覧取得 API (`GET /api/import/destinations`)
  - [x] 新規フォルダ作成 API (`POST /api/import/folders`)
  - [x] 写真コピー実行 API (`POST /api/import/copy`、JPG限定・ナンバリング保護・shutil.copy2)
  - [x] エクスプローラーで開く API (`POST /api/import/open`)
- [x] フロントエンド コンテキストメニュー＆フローティングバーの改修 (`frontend/index.html`, `frontend/js/app.js`, `frontend/css/style.css`) <!-- id: 2 -->
  - [x] 右クリックメニューに「📤 送る (import)」サブメニューを追加
  - [x] 送り先フォルダリスト、新規フォルダ作成入力欄、importフォルダを開くボタンの実装
  - [x] 複数選択フローティングバーへの「📤 送る (import)」ボタンの追加
  - [x] コピー完了通知トースト（「◯枚のJPG写真をコピーしました」）
- [x] 動作確認・検証（単一/複数選択コピー、RAW+JPGペア時のJPG限定コピー、フォルダ作成、エクスプローラー起動、スキャン除外確認） <!-- id: 3 -->
- [x] 修正内容確認ドキュメント (`docs/import_photos_feature/walkthrough.md`) の作成 <!-- id: 4 -->
