# タスクリスト: サイドバートグルボタンの左端配置・アイコン化・控えめ配色 (v1.72)

- [x] **フェーズ1: HTML構造の整理** <!-- id: 1 -->
  - [x] `frontend/index.html`: `#toggleSidebarBtn` をロゴの左側（`header-left` の先頭）に移動
  - [x] `frontend/index.html`: 「サイドバー」テキスト（`#sidebarToggleLabel`）を削除し、アイコンのみにする
  - [x] `frontend/index.html`: `?v=1.72` および `#appVersion`（`v1.72`）に更新

- [x] **フェーズ2: CSSスタイルの洗練（控えめな上品配色）** <!-- id: 2 -->
  - [x] `frontend/css/style.css`: `#toggleSidebarBtn` 専用の上品・控えめな配色（淡い朱色ティント背景＋朱色アイコン線）を定義
  - [x] `frontend/css/style.css`: ホバーおよび和紙テーマでの配色を調整
  - [x] `frontend/css/style.css`: 不要になった `#sidebarToggleLabel` のスタイル指定を整理

- [x] **フェーズ3: バージョン & マニュアル同期** <!-- id: 3 -->
  - [x] `VERSION`: `1.72` に更新
  - [x] `MANUAL.md`: ヘッダー左端配置についての記載を更新
  - [x] `walkthrough.md` の作成
