# タスクリスト: 左ペイン幅調整の復活とヘッダー表記のクリーンアップ (v1.70)

- [x] **フェーズ1: タグヘッダーの[+]ボタン削除とタイムライン表記の簡素化** <!-- id: 1 -->
  - [x] `frontend/index.html`: タグヘッダーから不要な `[+]` ボタン（`#openAddTagInputBtn`）を削除
  - [x] `frontend/index.html`: 「タイムライン (年月)」を「タイムライン」に変更
  - [x] `frontend/js/app.js`: 削除した `openAddTagInputBtn` への参照を整理

- [x] **フェーズ2: 左ペイン幅リサイズ機能の復活** <!-- id: 2 -->
  - [x] `frontend/css/style.css`: `#resizeHandleLeft` の `display: none;` を解除し常時表示・リサイズ可能にする
  - [x] `frontend/js/common.js`: `initPaneResize()` の左サイドバーリサイズ処理を改修（`.is-pinned` 依存を撤去し、直接サイドバー幅をドラッグ調整＆`localStorage` 保存・復元）

- [x] **フェーズ3: バージョン & マニュアル同期** <!-- id: 3 -->
  - [x] `VERSION` を `1.70` に更新
  - [x] `frontend/index.html` のクエリおよびバージョン表記を `?v=1.70` に更新
  - [x] `MANUAL.md` の記述同期
  - [x] `walkthrough.md` の作成
