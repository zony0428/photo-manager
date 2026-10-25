# タスク: フロントエンドコード（app.js）の安全なモジュール分割

## 概要
7,760行（約300KB）に肥大化した `frontend/js/app.js` を、Vanilla JS の互換性と動作の安全性を100%維持しながら、責務ごとの独立したモジュールへ段階的に切り出す。

## タスクリスト
- [x] <!-- id: 0 --> リファクタリング計画書（`implementation_plan.md`）の作成
- [x] <!-- id: 1 --> フェーズ1: 共通基盤・ユーティリティの分離 (`frontend/js/common.js`)
  - 定数、`state`、`elements`、`COLOR_TAG_MAP`、ヘルパー関数（`showToast`, `escapeHtml` 等）の切り出し
  - `index.html` への読み込み追加と動作確認
- [x] <!-- id: 2 --> フェーズ2: ライトボックス・ズーム・フィルムストリップの分離 (`frontend/js/lightbox.js`)
  - `openLightbox`, `loadLightboxPhoto`, ズーム/パン, スタック切替, フィルムストリップの切り出し
  - 動作確認（全画面表示、ズーム、スタック送り）
- [x] <!-- id: 3 --> フェーズ3: 右ペイン（インスペクター・EXIF・GPS）の分離 (`frontend/js/inspector.js`)
  - `showSingleInspector`, `showBatchInspector`, GPS候補モーダル等の切り出し
  - 動作確認（EXIF表示、タグ付け、一括編集）
- [x] <!-- id: 4 --> フェーズ4: 複数選択・コンテキストメニューの分離 (`frontend/js/selection.js`)
  - `togglePhotoSelection`, `rangeSelectPhotos`, `openContextMenu`, フローティングバーの切り出し
  - 動作確認（Ctrl/Shift選択、右クリック操作、一括操作）
- [x] <!-- id: 5 --> フェーズ5: スキャンモーダル・フォルダブラウザ・DBメンテの分離 (`frontend/js/scanner_modal.js`)
  - `loadScanModalFolders`, `executeScan`, `loadFolderBrowser`, DBメンテ等の切り出し
  - 動作確認（スキャンモーダル、進捗表示）
- [x] <!-- id: 6 --> 総合動作確認・回帰テスト
- [x] <!-- id: 7 --> バージョン更新（v1.38） & ドキュメント同期（`feature-code-map.md`, `walkthrough.md`）
