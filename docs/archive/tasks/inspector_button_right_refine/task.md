# タスクリスト: インスペクタトグルボタンの右端配置・アイコン化・控えめ配色 (v1.73)

- [x] **フェーズ1: HTML構造の整理** <!-- id: 1 -->
  - [x] `frontend/index.html`: 旧位置から `#toggleInspectorBtn` を削除
  - [x] `frontend/index.html`: 終了ボタン（`#openShutdownModalBtn`）の右に縦セパレータ（`.toolbar-divider`）を追加
  - [x] `frontend/index.html`: 最右端に `#toggleInspectorBtn` を配置（左右反転のサイドバーアイコン、テキストなし）
  - [x] `frontend/index.html`: `?v=1.73` および `#appVersion`（`v1.73`）に更新

- [x] **フェーズ2: CSSスタイルの洗練（縦セパレータ & 左右対称・控えめ配色）** <!-- id: 2 -->
  - [x] `frontend/css/style.css`: `.toolbar-divider` のスタイルを定義
  - [x] `frontend/css/style.css`: `#toggleInspectorBtn.btn-inspector-toggle` を `#toggleSidebarBtn` と同一の控えめ・上品な淡色ティントスタイルとして統一定義
  - [x] `frontend/css/style.css`: メディアクエリから不要になった `#inspectorToggleLabel` 等を整理

- [x] **フェーズ3: バージョン & マニュアル同期** <!-- id: 3 -->
  - [x] `VERSION`: `1.73` に更新
  - [x] `MANUAL.md`: ヘッダー最右端配置およびセパレータについての記載を更新
  - [x] `walkthrough.md` の作成
