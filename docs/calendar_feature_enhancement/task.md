# タスクリスト: カレンダー機能の強化（ミニカレンダー ＆ 拡大カレンダー）

- [x] **1. 設計・実装計画の策定**
  - [x] 既存のタイムライン・日付フィルタ実装の調査
  - [x] 実装計画書 (`implementation_plan.md`) の作成・承認

- [x] **2. バックエンド：日別集計API ＆ 日付OR検索の実装**
  - [x] `server/database/folders.py`: 日別（`YYYY-MM-DD`）の撮影枚数・優枚数・代表写真ID・代表撮影地を集計する `get_calendar_summary()` を追加
  - [x] `server/database/photos.py`: `get_photos()` に複数日付（`dates`: `YYYY-MM-DD` リスト）パラメータを追加し、`year_months` と同一タイムライン軸の OR 条件で高速検索できるように拡張
  - [x] `server/app.py`: `GET /api/calendar/summary` エンドポイントの追加、`GET /api/photos` への `dates` クエリパラメータ追加

- [x] **3. フロントエンド：左サイドバー「ミニカレンダー」＆ タイムライン強化**
  - [x] `frontend/index.html`: タイムラインセクション（`#accordionItem-timeline`）に操作ツールバー（再読込・拡大カレンダー起動・全展開・全折りたたみ）と上部常設7列ミニカレンダー領域（`#sidebarMiniCalendarBox`）を追加
  - [x] `frontend/js/common.js`: `state.selectedDates`（`Set`）、`state.calendarDaysMap`、`state.miniCalendarYm` 等の状態管理を追加
  - [x] `frontend/js/sidebar_filters.js`:
    - 上部常設ミニカレンダー（`◀ YYYY年M月 ▶`、月選択連動、撮影枚数ドット/濃淡表示、日付クリックでの単一/複数OR選択、Shift範囲選択、その月全体の選択）の描画・操作ロジック実装
    - タイムライン年・月ツリーとの双方向連動（年ヘッダークリックでの年単位OR選択、月クリックでのミニカレンダー連動ジャンプ、年内に選択日がある場合のバッジ表示）
    - タイムライン操作ツールバー（全展開・全折りたたみ・再読込・拡大カレンダー起動）のイベント実装

- [x] **4. フロントエンド：「拡大カレンダー」モーダル (`#calendarModal`) の実装**
  - [x] `frontend/js/sidebar_filters.js`: `#calendarModal`（タブ1: 月間フォトカレンダー、タブ2: 年間12ヶ月ヒートマップ、年月ナビゲーション、選択日程アクションバー）の実装:
    - **月間フォトカレンダー**: 7列大判グリッド、各日の代表サムネイル（評価「優」優先）・枚数・主な撮影地表示、クリック選択・Shift期間選択、ダブルクリックで即座にその日の写真を表示
    - **年間12ヶ月ヒートマップ**: 1年分（1月〜12月）の4×3ミニカレンダー一覧、撮影枚数/優枚数モード切替による濃淡ヒートマップ、月ごとの詳細ボタンで月間ビューへドリルダウン、年単位一括OR選択ボタン
  - [x] `frontend/css/lab-map.css`: Stoic Design Rules（サンセリフ等幅 `tabular-nums`・単色SVGアイコン・OSカラー絵文字ゼロ・半透明ボーダー）に準拠したミニカレンダー＆拡大カレンダースタイルの実装

- [x] **5. フィルタチップ・プリセット・多言語・マニュアル同期 & テスト検証**
  - [x] `frontend/js/app.js`: `fetchPhotos()` への `dates` パラメータ送信、下部フィルタフッターバー（`#viewHeaderChipBar`）での年単位集約表示（`YYYY年 (全体)`）・日付ピル表示・フィルタ全解除連動
  - [x] `frontend/js/presets.js`: `selectedDates` のプリセット保存・復元・条件バッジ表示対応
  - [x] `frontend/js/i18n.js` / `MANUAL.md` / `#helpModal`: 日英翻訳辞書、操作マニュアル、ヘルプモーダルの同期更新
  - [x] `tests/test_core_regression.py` ＆ `tests/test_security.py`: カレンダー集計API・日付OR検索・セキュリティ回帰テストの実行と合格確認
