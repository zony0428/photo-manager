# タスクリスト: 開いているセクションより下のメニューのスマート下端固定（スクロールアウト防止） (v1.59)

- [x] **フェーズ1: 設計と調査** <!-- id: 1 -->
  - [x] 表示量が少ない場合は直下に後続メニューが並び、長い場合のみ下端固定留保するFlexbox仕様（`flex: 0 1 auto;`）の確立
  - [x] 内部スクロール（`.accordion-body` の `overflow-y: auto`）およびスクロールバーの最適化
  - [x] 実装計画書（`implementation_plan.md`）の作成

- [x] **フェーズ2: CSSスタイルの改修 (`frontend/css/style.css`)** <!-- id: 2 -->
  - [x] `.sidebar-accordion`: `flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;`
  - [x] `.accordion-item.is-open`: `flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden;`
  - [x] `.accordion-item.is-open .accordion-header`: `flex-shrink: 0;`
  - [x] `.accordion-item.is-open .accordion-body`: `flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;`
  - [x] 閉じている `.accordion-item`: `flex-shrink: 0;`
  - [x] `.accordion-body` の細幅カスタムスクロールバーのスタイリング
  - [x] `app.js` の `openAddTagInputBtn`（タグ新規作成ボタン）の安全化・自動アコーディオン展開

- [x] **フェーズ3: バージョン & マニュアル同期** <!-- id: 3 -->
  - [x] `VERSION` を `1.59` に更新
  - [x] `frontend/index.html` のキャッシュクエリおよびバージョン表記を `?v=1.59` に更新
  - [x] `MANUAL.md` のサイドバー操作説明を更新

- [x] **フェーズ4: 検証とレポート** <!-- id: 4 -->
  - [x] ユーザー自身による確認用にコード整合性検証
  - [x] `walkthrough.md` の作成
