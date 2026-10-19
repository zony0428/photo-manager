# タスクリスト: 左ペインボタンとロゴ間の縦セパレータ追加 (v1.74)

- [x] **フェーズ1: HTML構造の更新** <!-- id: 1 -->
  - [x] `frontend/index.html`: `#toggleSidebarBtn` と `.logo` の間に `<div class="toolbar-divider" title="セパレータ"></div>` を追加
  - [x] `frontend/index.html`: `?v=1.74` および `#appVersion`（`v1.74`）に更新

- [x] **フェーズ2: CSS余白バランス調整** <!-- id: 2 -->
  - [x] `frontend/css/style.css`: `.header-left` の `gap` を微調整（10px）して左右のセパレータ余白感を完全調和

- [x] **フェーズ3: バージョン & マニュアル同期** <!-- id: 3 -->
  - [x] `VERSION`: `1.74` に更新
  - [x] `MANUAL.md`: 左側セパレータについての記述同期
  - [x] `walkthrough.md` の作成
