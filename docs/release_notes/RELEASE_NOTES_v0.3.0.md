# Photo Manager v3.00 Release Notes

- **Tag**: `v3.00`
- **Title**: `Photo Manager v3.00 - Stoic UI/UX Overhaul (2-Stage Sidebar, Single Header, 4:3 Inspector) & Instant Lightbox`
- **Date**: `2026-10-27`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v3.00diff.zip`）**:  
>   すでにフルパッケージ版をご利用中の場合は、`PhotoManager_v3.00diff.zip` を解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけでアップデートが完了します（`cache/` データベースや `storage/`、`python/` 環境はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v3.00.zip`）**:  
>   初めて導入される場合は、ポータブル Python 環境一式を同梱した `PhotoManager_v3.00.zip` をダウンロードして解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v3.00diff.zip`)**:  
>   Simply extract `PhotoManager_v3.00diff.zip` and overwrite your existing `PhotoManager` directory. Your `cache/library.db`, `storage/`, and `python/` runtime remain untouched.

---

## 日本語 (Japanese)

### 1. メジャー UI / UX 刷新（Stoic Darkroom / Tiat-Inspired Design System）

| 領域 | 刷新内容 |
| :--- | :--- |
| **2段階左サイドバー** | 左端の「垂直タブレール（幅 54px：`クイック / フォルダ / タグ / ジオタグ / 年月 / 機材 / ラボ` ＋ 最下部 `検索`）」と、選択中の1パネルのみを縦 100% の高さで表示する「全高メニューエリア」の2段階構造に刷新。従来のアコーディオン縦積みによる窮屈な多重スクロールを解消 |
| **メニューオフ時のオーバーレイ展開** | ヘッダー左端の「メニュー」ボタンでメニューをオフにしても左端のアイコン列（54px）は残る設計とし、アイコンをクリックすると写真グリッドの上にメニューがオーバーレイ展開（再クリックまたはグリッド側クリックで自動クローズ） |
| **常設グローバルフィルタ** | 左メニューエリア最上部（`フィルタ全解除` 直下）に「種別フィルタ（`すべて / RAW / 調整済` ＋ 詳細属性セレクト）」と「評価フィルタ（`優 / 良 / 可 / 棄`）」を常設し、どのタブからでも即座に絞り込み可能に |
| **完全1段スリムヘッダー（44px）** | 2段に分かれていた上部バーを高さ 44px の1段ヘッダーに統合。テーマ切替（`和紙` / `夜墨`）、言語切替（`JP` / `EN`）、設定、スマホ連携、ヘルプ、詳細開閉、終了を1行の定位置へ集約 |
| **右インスペクタ 4:3 プレビュー ＆ 常設 EXIF** | プレビュー枠を見切れのない `4:3` 比率に刷新（邪魔なオーバーレイ波形ボタンを廃止）。評価ボタン直下にタブ切替不要の「常時表示クイック EXIF サマリ（撮影日時・解像度・カメラ/レンズ名・露出ピル）」を新設 |
| **下部フローティングバーの廃止** | 写真選択時に画面下部を遮っていたフローティング選択バーを廃止し、右クリックコンテキストメニューおよび右インスペクタへ操作を一本化 |
| **文字・色・アイコンのストイック化** | UI から明朝体フォールバックと OS 標準カラー絵文字を全面排除し、サンセリフ体＋等幅数値（`tabular-nums`）と単色細線 SVG アイコン（`stroke="currentColor"`）に統一。サムネイル上のバッジを半透明すりガラス・モノトーン化し、全スクロールバーを 6px 細線化 |

### 2. 新機能・ワークフロー強化
- **撮影日時の一括シフト補正（非破壊・元日時リセット対応）**:
  複数カメラ間の時計ズレや時差を `±日・時間・分・秒` 指定で一括補正。変更前の元の EXIF 撮影日時を DB 内に自動退避し、ワンクリックで復元可能。
- **シャッター速度順ソート（高速 ↔ 低速）**:
  ソートメニューに `シャッター速度 (高速 → 低速)` / `シャッター速度 (低速 → 高速)` を追加。分数表記（`1/8000` 等）や小数表記を実数値秒へ変換して正確にソート。
- **詳細属性フィルタ（`JPEG / 一般のみ`・`RAW+JPG ペア`・`XMP あり`）**:
  種別フィルタの詳細プルダウンから、純粋な JPEG のみ、RAW+JPG ペア撮影のみ、XMP サイドカー保有写真のみをワンクリックで抽出。
- **取り込み導線の `storage/` 一本化**:
  ヘッダーの「取り込み」およびドラッグ＆ドロップ取り込み先をアプリ内 `storage/` に統一。

### 3. パフォーマンス改善
- **ダブルクリックによるビューワ（ライトボックス）起動の即時化**:
  - グリッドのキャッシュ済みサムネイルを 0ms で即時表示しつつ、フル解像度画像を非同期プリロードしてシームレスに差し替える二段描画を実装。
  - 1万枚超のフィルムストリップ構築を次フレームへ非同期化し、画面中央付近（`±18`枚）のみ `<img>` をオンデマンド生成することで初期 DOM 負荷を極小化。
  - ダブルクリック時の重複インスペクタ再構築、および重複・XMPを持たない写真の不要な `/api/photo/{id}` 通信を排除。
  - 日本語モード時の `i18n.js` `MutationObserver` を切断し、`/api/photo/{id}/view` を単一主キー検索（`get_photo_brief`）へ軽量化。

---

## English

### 1. Major UI / UX Overhaul (Stoic Darkroom / Tiat-Inspired Design System)
- **2-Stage Left Sidebar**: Replaced stacked accordions with a persistent 54px vertical icon rail (`Quick / Folders / Tags / Geotags / Date / Gear / Lab` + bottom `Search`) paired with a 100%-height menu stage.
- **Overlay Expansion in Menu-Off Mode**: Collapsing the menu keeps the 54px icon rail visible; clicking any icon smoothly overlays the menu stage over the photo grid and auto-closes when clicking back on the grid.
- **Persistent Global Filters**: Placed Attribute pills (`All / RAW / Edited` + detailed attribute selector) and 4-tier Rating pills (`Ex / Gd / Nm / Rj`) permanently at the top of the left menu stage.
- **Unified Single-Row Header (44px)**: Consolidated all top toolbar controls, including Theme (`Washi` / `Urusi`) and Language (`JP` / `EN`) toggles, into a single 44px bar.
- **4:3 Inspector Preview & Always-Visible Quick EXIF**: Updated the Inspector mini-preview to an uncropped `4:3` aspect ratio, removed redundant overlay buttons, and added a permanent Quick EXIF summary right below the rating buttons.
- **Retired Bottom Floating Bar**: Removed the bottom floating selection bar in favor of the comprehensive right-click context menu and right Inspector batch view.
- **Stoic Typography & Monochrome SVG Iconography**: Removed Mincho font fallbacks and OS color emojis across the UI, standardizing on crisp sans-serif with `tabular-nums`, thin monochrome SVG icons, translucent dark frosted-glass thumbnail badges, and 6px thin scrollbars.

### 2. New Features & Performance
- **Batch Capture Time Shift**: Offset capture timestamps (`±Days/Hours/Min/Sec`) non-destructively with automatic backup and one-click restore of original EXIF timestamps.
- **Shutter Speed Sorting**: Sort photos from fastest to slowest (`1/8000s` to long exposures) or slowest to fastest.
- **Detailed Attribute Filters**: Filter specifically for `JPEG Only`, `RAW+JPG Pair`, or `Has XMP`.
- **Instant Lightbox Opening on Double-Click**: Displays the cached grid thumbnail at 0ms while asynchronously preloading the full-resolution image, defers 16,000+ item filmstrip layout to `requestAnimationFrame` with on-demand `<img>` instantiation, eliminates redundant `/api/photo/{id}` requests, and disconnects the i18n `MutationObserver` when running in Japanese mode.
