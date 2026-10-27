# タスクリスト: 左ペイン（サイドバー）の表示・非表示トグル機能 (v1.71)

- [x] **フェーズ1: HTML構造 & ヘッダー・サイドバー内トグルUI追加** <!-- id: 1 -->
  - [x] `frontend/index.html`: `header-left` に `#toggleSidebarBtn`（左サイドバートグルボタン）を追加
  - [x] `frontend/index.html`: `sidebar-top-bar` に `#sidebarCloseBtn`（サイドバー折りたたみボタン）を追加
  - [x] `frontend/index.html`: ヘルプモーダルのショートカット一覧表にキーバインド（`[` / `B`）を追加

- [x] **フェーズ2: CSSスタイル整備** <!-- id: 2 -->
  - [x] `frontend/css/style.css`: `.sidebar.accordion-sidebar.is-collapsed` を `display: none !important;` に設定
  - [x] `frontend/css/style.css`: `#sidebarCloseBtn` のスタイル（ホバー・サイズ）を定義
  - [x] `frontend/css/style.css`: 画面幅縮小時の `#sidebarToggleLabel` アイコン化レスポンシブルールを追加

- [x] **フェーズ3: JavaScriptトグルロジック & ショートカット実装** <!-- id: 3 -->
  - [x] `frontend/js/common.js`: `state.isSidebarOpen` の追加および `localStorage` 復元
  - [x] `frontend/js/common.js`: `elements.toggleSidebarBtn` / `sidebarCloseBtn` の定義
  - [x] `frontend/js/app.js`: `toggleSidebar(forcedState)` 関数の実装と初期化処理
  - [x] `frontend/js/app.js`: キーボードショートカット（`[` / `B` / `Ctrl+B`）の追加

- [x] **フェーズ4: バージョン & マニュアル同期** <!-- id: 4 -->
  - [x] `VERSION` を `1.71` に更新
  - [x] `frontend/index.html` のクエリおよびバージョン表記を `?v=1.71` に更新
  - [x] `MANUAL.md` のショートカット表・操作説明を更新
  - [x] `walkthrough.md` の作成
