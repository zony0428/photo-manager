# 実装計画書: カレンダー機能の強化（ミニカレンダー ＆ 拡大カレンダー）

## 1. 目的と設計コンセプト

現在の「年 ＞ 月」リストによるタイムライン機能を強化し、**大雑把な年・月単位のOR絞り込み**から**ピンポイントな日単位・期間単位の絞り込み**、さらに**大画面でのビジュアルな撮影振り返り**までをシームレスに行えるようにします。

1. **左ペイン「常設ミニカレンダー ＋ 年月ツリー連動」（A案）**:
   - タイムラインセクション上部に **1ヶ月分の7列ミニカレンダー** を常設し、下の「年 ＞ 月」ツリーと連動させます。
   - **大雑把な絞り込み**: これまで通り「2024年」「2025年」「2026年」などの年ヘッダーや月アイテムをクリックすることで、複数年・複数月の **OR条件** で素早く絞り込めます。
   - **日単位の絞り込み**: 月をクリックすると上部ミニカレンダーがその月に切り替わり、7列のカレンダーグリッドから特定の日付（`YYYY-MM-DD`）をクリック（複数日のOR選択・`Shift`クリックによる期間選択対応）して絞り込めます。
   - **年・月と日のシームレスなOR結合**: 「2024年全体 ＋ 2025年10月 ＋ 2026年10月31日」のように、年・月（`selectedYearMonths`）と個別の日付（`selectedDates`）を同一タイムライン軸の **OR条件** として自在に組み合わせられます。

2. **モーダル「拡大カレンダー (`#calendarModal`)」**:
   - ジオタグの「制覇マップ」と同様、タイムライン上部ツールバーの `[カレンダー]` ボタンから大画面モーダルを起動できます。
   - **タブ1：月間フォトカレンダー**:
     - 大きな7列カレンダーの各日付セルに、**その日の代表写真サムネイル（評価「優」優先）**、**撮影枚数バッジ**、**主な撮影場所（都道府県・市区町村）** を表示します。
     - 日付セルのクリックで選択（複数日OR選択・`Shift`範囲選択対応）、ダブルクリックまたは「選択した日程で表示」ボタンでメイングリッドへ即座に反映します。
   - **タブ2：年間12ヶ月ヒートマップ**:
     - 選択した年の1月〜12月を `4列 × 3段` のミニカレンダーで一覧表示し、撮影枚数（または「優」枚数）に応じた濃淡ヒートマップで1年間の撮影リズムを可視化します。
     - 年ヘッダーの「この年（YYYY年）をOR選択に追加」ボタンで年単位の大雑把な比較・抽出も可能にし、月見出しクリックで「月間フォトカレンダー」へズームイン、日付クリックでその日の写真を抽出できます。

---

## 2. 変更対象ファイルと実装詳細

### 2.1 バックエンド (Python / FastAPI / SQLite)

- **[server/database/folders.py](file:///c:/Users/zony0/Documents/photo-manager/server/database/folders.py)**
  - `get_calendar_summary()` を新設します。
  - `photos` テーブル（`is_unlinked = 0`）から日付 `SUBSTR(REPLACE(date_taken, ':', '-'), 1, 10)` ごとに以下を1回のSQLで高速集計します：
    - `date`: `YYYY-MM-DD`
    - `year_month`: `YYYY-MM`
    - `count`: 撮影枚数（棄を除く枚数、および全枚数）
    - `excellent_count`: 評価「優（`rating = 2`）」の枚数
    - `rep_photo_id`: その日の代表写真ID（`rating DESC, is_stack_primary DESC, date_taken ASC` で選出）
    - `location_label`: その日の代表的な撮影地（`state` / `city`）
- **[server/database/photos.py](file:///c:/Users/zony0/Documents/photo-manager/server/database/photos.py)**
  - [`get_photos()`](file:///c:/Users/zony0/Documents/photo-manager/server/database/photos.py#L250-L361) に引数 `dates: Optional[List[str]] = None` を追加します。
  - `target_yms`（`YYYY-MM`）と `target_dates`（`YYYY-MM-DD`）が指定された場合、同一タイムライン条件として `(p.year_month IN (...) OR SUBSTR(REPLACE(p.date_taken, ':', '-'), 1, 10) IN (...))` でOR結合します。
- **[server/app.py](file:///c:/Users/zony0/Documents/photo-manager/server/app.py) ＆ [server/lan_access.py](file:///c:/Users/zony0/Documents/photo-manager/server/lan_access.py)**
  - `GET /api/calendar/summary` エンドポイントを追加します。
  - `GET /api/photos` に `dates` クエリパラメータ（カンマ区切り `YYYY-MM-DD`）を追加します。
  - `server/lan_access.py` の読み取り専用ホワイトリストに `/api/calendar/summary` を追加します。

---

### 2.2 フロントエンド (HTML / CSS / Vanilla JS)

- **[frontend/index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html)**
  - `#accordionItem-timeline` 内に操作ツールバー `#timelineToolbar`（`[↻]` `[カレンダー]` `[展開]` `[閉じる]`）と、上部常設ミニカレンダーコンテナ `#sidebarMiniCalendar` を配置します。
  - 拡大カレンダーモーダル `#calendarModal` を追加します（UIデザインシステム規約に従い、OSカラー絵文字は一切使わず単色細線SVGアイコンと等幅数値フォント `tabular-nums` で構成）。
- **[frontend/js/common.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/common.js)**
  - `state.selectedDates = new Set()`（`YYYY-MM-DD` 文字列の集合）
  - `state.lastClickedCalendarDate = null`（`Shift` 範囲選択の起点日）
  - `state.miniCalendarYm = null`（左ペインミニカレンダーで現在表示中の `YYYY-MM`）
  - `state.isMiniCalendarCollapsed = false`（ミニカレンダー部の開閉状態）
  - `state.calendarSummary = null`（日別集計キャッシュ）
- **[frontend/js/sidebar_filters.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/sidebar_filters.js)**
  - **ミニカレンダー描画 (`renderSidebarMiniCalendar()`)**:
    - 表示対象月（デフォルトは最新の撮影月、または最後にクリックした月）の7列グリッド（日〜土）を生成。
    - 撮影がある日には枚数に応じた濃淡クラス（`.cal-level-1` 〜 `.cal-level-4`）と枚数ツールチップを付与。
    - 日付クリックで `toggleTimelineDate(dateStr, isShift)` を呼び出し、単一日トグルまたは `Shift` 範囲選択を実行。
    - ミニカレンダーのヘッダー月名クリックで「その月全体（`YYYY-MM`）」をトグル選択。
  - **年月ツリーとの連携 (`renderTimeline()`, `updateTimelineFilterState()`)**:
    - 年ヘッダークリック：その年の全月を一括OR選択/解除（2024年、2025年、2026年の複数年OR選択がワンクリックで可能）。
    - 月アイテムクリック：その月をOR選択/解除すると同時に、上部ミニカレンダーをその月へ連動切り替え。
    - 年・月内に個別選択された日付（`state.selectedDates`）がある場合も、年ヘッダーや月アイテムに選択バッジ（`+N日`）を表示。
- **[frontend/js/app.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/app.js) ＆ [frontend/js/presets.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/presets.js)**
  - `fetchPhotos()` で `state.selectedDates` を `dates` パラメータとして送信。
  - 上部チップバー（`#viewHeaderChipBar`）の「年月:」文節において：
    - ある年の全月がすべて選択されている場合は `2025年 (全体)` ピルに集約表示して見通しを向上（×ボタンでその年を一括解除可能）。
    - 個別日付（`state.selectedDates`）も `2026年10月31日` ピルとして並べて表示。
  - フィルタ全解除・プリセット保存/復元（`presets.js`）に `selectedDates` を完全統合。
- **[frontend/js/i18n.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/i18n.js) ＆ [MANUAL.md](file:///c:/Users/zony0/Documents/photo-manager/MANUAL.md)**
  - 新規UIラベルの日英翻訳対応、および操作マニュアル・ヘルプモーダル（`#helpModal`）へのカレンダー操作説明の追記。

---

## 3. 検証計画

1. **自動テストの実行**:
   - `.\python\python.exe -m unittest tests/test_core_regression.py tests/test_security.py` を実行し、既存の全テストおよび新規追加するカレンダー集計・日付OR検索テストがすべて合格することを確認します。
2. **動作・UI確認**:
   - 年単位（2024年・2025年・2026年等）の複数年OR選択、月単位のOR選択、日単位（単一日・複数日・Shift期間）のOR選択が単独でも組み合わせても正しく動作すること。
   - 左ペインのミニカレンダーと拡大カレンダーモーダル（月間フォトカレンダー／年間12ヶ月ヒートマップ）が双方向に状態同期すること。
