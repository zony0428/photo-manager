# ウォークスルー: カレンダー機能の強化（ミニカレンダー ＆ 拡大カレンダー）

## 1. 実装概要

タイムライン（撮影年月）セクションを強化し、**大雑把な年・月のOR絞り込み（例：2024年 OR 2025年 OR 2026年）**の軽快さを維持したまま、**左サイドバー常設のミニカレンダー**と**大画面の拡大カレンダーモーダル**を実装しました。

---

## 2. 主な追加・変更点

### ① バックエンド：日別集計APIと `year_months` + `dates` のOR結合検索
- **[folders.py](file:///c:/Users/zony0/Documents/photo-manager/server/database/folders.py) (`get_calendar_summary`)**:
  - SQLiteのCTE＋ウィンドウ関数（`ROW_NUMBER() OVER (PARTITION BY norm_date ORDER BY CASE WHEN rating = 2 THEN 0 ...)`）を用い、単一クエリで各撮影日（`YYYY-MM-DD`）の総枚数、アクティブ枚数、「優」枚数、「良」枚数、その日の代表写真ID（評価「優」優先）、主な撮影地（都道府県・市区町村）を高速集計します。
- **[photos.py](file:///c:/Users/zony0/Documents/photo-manager/server/database/photos.py) (`get_photos`)**:
  - `dates: Optional[List[str]]` パラメータを追加し、`year_months`（`YYYY-MM`）と `dates`（`YYYY-MM-DD`）を同一タイムライン条件句内で `OR` 結合して検索できるようにしました。
- **[app.py](file:///c:/Users/zony0/Documents/photo-manager/server/app.py)**:
  - `GET /api/calendar/summary` エンドポイントおよび `GET /api/photos?dates=...` クエリパラメータを追加しました。

### ② 左サイドバー：常設ミニカレンダー ＆ タイムライン操作バー
- **[index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html) / [sidebar_filters.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/sidebar_filters.js) / [lab-map.css](file:///c:/Users/zony0/Documents/photo-manager/frontend/css/lab-map.css)**:
  - タイムライン上部に操作ツールバー（`再読込` / `拡大カレンダー` / `全展開` / `全折りたたみ`）を追加しました。
  - その直下に7列（日〜土）の1ヶ月**ミニカレンダー (`#sidebarMiniCalendarBox`)** を常設配置しました（開閉トグル状態の `localStorage` 記憶対応）。
  - 下部の年＞月ツリーで月をクリックするとミニカレンダーがその月へ自動ジャンプし、各日の撮影枚数に応じた4段階ヒートマップ濃淡と「優」評価写真の存在ドットを表示します。
  - 日付セルをクリックすると日単位（`YYYY-MM-DD`）でOR選択/解除でき、`Shift + クリック`で期間（開始日〜終了日）の撮影日を一括範囲選択できます。

### ③ 拡大カレンダーモーダル (`#calendarModal`)
- **[sidebar_filters.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/sidebar_filters.js) (`openCalendarModal`)**:
  - **タブ1：月間フォトカレンダー (`#calTabPaneMonth`)**:
    - 大きく操作しやすい7列カレンダーグリッドに、各撮影日の**代表写真サムネイル**（評価「優」優先）、**撮影枚数バッジ**、**「優」枚数バッジ**、**主な撮影地（都道府県・市区町村）**を表示します。
    - クリックで日単位のOR選択、`Shift + クリック`で期間範囲選択、**ダブルクリック**でその日単独に絞り込んで即座にモーダルを閉じます。
  - **タブ2：年間ヒートマップ 12ヶ月 (`#calTabPaneYear`)**:
    - 1年分（1月〜12月）のミニカレンダーを `4×3` グリッドで一覧表示し、「総撮影枚数」と「優 (Ex) 枚数」を切り替えられる日の丸インク（`#e14d2a`）ヒートマップを描画します。
    - 上部の年ピルバーや「この年全体を選択」ボタンから年単位（`2024年 OR 2025年 OR 2026年` 等）のOR選択が行え、各月の「詳細 ▸」ボタンから月間フォトカレンダーへドリルダウンできます。

### ④ フローティング・フィルタフッターバーの年単位集約ピル ＆ プリセット対応
- **[app.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/app.js) (`renderActiveFilterChips`)**:
  - ある年の全月が選択されている場合は、月ごとのピルを羅列せず **`2025年 (全体)`** ピルに自動集約して表示し、複数年選択時も `2024年 (全体) または 2025年 (全体) または 2026年 (全体)` のようにすっきりと確認・個別解除できます。
  - 日単位の選択（`2025年10月15日`）も同じ `年月:` セクション内に `または` で並び、ピルをクリックするとその月の拡大カレンダーが開きます。
- **[presets.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/presets.js)**:
  - 保存済みフィルタセット（プリセット）に `selectedDates` の保存・復元・バッジ表示を統合しました。

---

## 3. 検証結果

- **コア回帰テスト (`tests/test_core_regression.py`)**:
  - 新規追加した `test_12_calendar_summary_and_date_or_filtering` を含む全11テストを実行し、すべて `OK`（合格）を確認しました。
- **セキュリティ回帰テスト (`tests/test_security.py`)**:
  - 全8項目のセキュリティテストを実行し、すべて `[PASS]` を確認しました。
- **実データAPI疎通確認**:
  - `TestClient` にて `/api/calendar/summary`（実DB上の1,263日分の集計）および `/api/photos?dates=...&year_months=...` が正常に200 OKを返すことを確認しました。
