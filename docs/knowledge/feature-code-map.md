# Photo Manager - 機能別コードマップ (Feature-to-Code Architecture Map)

本ドキュメントは、Photo Manager の各機能が「フロントエンド（UI/JS）」「API（FastAPI）」「バックエンド処理/DB（Python/SQLite）」のどのコードに対応しているかを網羅的に整理したアーキテクチャ案内である。
「○○機能を改善したい」「不具合を修正したい」という依頼を受けたエージェントは、まず本マップを参照して該当コードを特定すること。

---

## 目次
1. [写真グリッド・表示・レイアウト (Grid & Presentation)](#1-写真グリッド表示レイアウト-grid--presentation)
2. [写真の選択と一括操作 (Selection & Batch Actions)](#2-写真の選択と一括操作-selection--batch-actions)
3. [評価・カラーラベル・階層タグ管理 ＆ タグツリーエディタ (Rating, Labels & Tags)](#3-評価カラーラベル階層タグ管理--タグツリーエディタ-rating-labels--tags)
4. [ライトボックス & スライドショー (Lightbox & Slideshow)](#4-ライトボックス--スライドショー-lightbox--slideshow)
5. [サイドバー・絞り込み・検索 (Sidebar, Filtering & Search)](#5-サイドバー絞り込み検索-sidebar-filtering--search)
6. [右ペイン (インスペクター / 詳細・一括編集・XMPプレビュー) (Inspector)](#6-右ペイン-インスペクター--詳細一括編集xmpプレビュー-inspector)
7. [写真グループ化 & スタック (Burst, RAW+JPG, Bracket Stacks)](#7-写真グループ化--スタック-burst-rawjpg-bracket-stacks)
8. [スキャン & フォルダ管理 (Scanner & Folder Management)](#8-スキャン--フォルダ管理-scanner--folder-management)
9. [RAW画像処理 & クラウド連携 (RAW Loading & Cloud Storage)](#9-raw画像処理--クラウド連携-raw-loading--cloud-storage)
10. [AI自動タグ付け & 機械学習 (AI Auto-tagging)](#10-ai自動タグ付け--機械学習-ai-auto-tagging)
11. [アプリ内ストレージ (`storage/`) 完結管理・XMP連携・スマートテイクアウト & 非破壊画像調整](#11-アプリ内ストレージ-storage-完結管理xmp連携スマートテイクアウト--非破壊画像調整)
12. [設定 ＆ データベース管理・ライフサイクル・配布ビルド (Settings, Database & Build)](#12-設定--データベース管理ライフサイクル配布ビルド-settings-database--build)
13. [Android / スマホ専用UI & ハイブリッドDB連携 (Mobile Viewer & Offline DB Sync)](#13-android--スマホ専用ui--ハイブリッドdb連携-mobile-viewer--offline-db-sync)
14. [セキュリティ ＆ 自動テスト (Security & Automated Tests)](#14-セキュリティ--自動テスト-security--automated-tests)

---

## フロントエンド・モジュール構成 (JS / CSS)

### JavaScript モジュール (`frontend/js/`)
| モジュール | 役割・担当機能 |
|---|---|
| `frontend/js/common.js` | 定数、`state`、`elements`、汎用ヘルパー（`showToast`, `escapeHtml`, ローカルタイム日付ヘルパー等）、テーマ制御、ハートビート、ペインリサイズ、共通モーダル（ヘルプ・終了・スマホ連携・タグ削除確認） |
| `frontend/js/selection.js` | 複数選択、Shift範囲選択、選択差分DOM更新、右クリックメニュー（#contextMenu）表示・制御、キーボードショートカット連携 |
| `frontend/js/storage.js` | アプリ内ストレージ（`storage/`）管理: 外部写真からのインポート、サブフォルダ作成/リネーム/削除/エクスポート、写真のサブフォルダ間D&D/移動、単一/一括連番リネーム (`F2`) |
| `frontend/js/inspector.js` | 右ペイン、単一写真EXIF詳細、露出タグ、地図・MiniMap、GPS候補モーダル、クイックタグツリー（`+追加`/`+子`）、XMPサイドカー検出バー（`[👁️ XMPプレビュー]` ホールド比較・`📥 評価・タグ取込`）、一括タグ編集 |
| `frontend/js/lightbox.js` | 全画面プレビュー、ズーム・パン、スタック切替バー、フィルムストリップ、ライトボックス内タグ/評価 |
| `frontend/js/folder_tree.js` | 左ペイン階層フォルダツリー（遅延展開、`storage` 専用右クリックメニュー＆D&D移動受け入れ、ショートカット、接続/未接続分離、除外/通常切替、パス直接入力、スキャン進捗）、2ペイン `⚙️ 設定 ＆ 🌳 タグツリーエディタ` モーダル (`#dbMaintenanceModal`) |
| `frontend/js/location_tree.js` | 左ペインジオタグ階層ツリー（国 ＞ 都道府県 ＞ 市区町村） |
| `frontend/js/location_map.js` | 47都道府県 撮影制覇白地図（インラインSVG）・撮影密度ヒートマップ・撮影さんぽ軌跡ライン (`#locationMapModal`) |
| `frontend/js/lab.js` | 左ペイン「🧪 ラボ」セクション（太陽高度抽出・手ブレ注意・歴代の今日・未整理ガチャ）＆ 勝ちレンズ・得意設定カルテ (`#labKarteModal`) |
| `frontend/js/compare.js` | Side-by-Side 2枚並列比較ビュー（同期ズーム＆パン・トーナメント勝ち抜き選別・`V`キー） |
| `frontend/js/histogram.js` | オンデマンドRGB・輝度ヒストグラム（インスペクタ・ライトボックス・画像調整・2枚比較・XMPプレビュー連動・`H`キー） |
| `frontend/js/adjust.js` | 非破壊画像調整モーダル（回転・水平傾き補正・アスペクト比クロップ・EV露出/コントラスト/彩度） |
| `frontend/js/takeout.js` | スマート・テイクアウト（高機能一括画像書き出し・オプション `.xmp` サイドカー出力）＆ ベタ焼き（コンタクトシート）HTML出力 |
| `frontend/js/presets.js` | フィルタプリセットの保存・適用・チップ描画・削除 |
| `frontend/js/slideshow.js` | フルスクリーンスライドショービューア（ダブルバッファ切替、自動再生、シャッフル） |
| `frontend/js/sidebar_filters.js` | 左ペインのタイムライン（年月ツリー）、カメラ＆レンズ2階層ツリー（`[+]`/`[-]`排他検索）、フォルダ階層データ構築、階層タグツリー（`📊 枚数順` トグル＆名前順4ルール）・12色カラーパレット管理 |
| `frontend/js/i18n.js` | マルチランゲージ（日本語 `🇯🇵 JP` ⇄ 英語 `🇺🇸 EN`）リアルタイム双方向切替モジュール（MutationObserver 連動） |
| `frontend/js/app.js` | コアオーケストレータ: 初期化、データ取得、写真グリッド段階チャンク描画、適用中フィルタチップ描画、評価・タグ更新、キーボードショートカット |
| `frontend/js/mobile.js` | スマホ専用画面（`mobile.html` / `/m`）のコントローラ: PC直結モード・WebAssembly (`sql.js`) ローカルDB直接読込モード、片手4段階選別、差分JSON出力/同期 |

### CSS モジュール (`frontend/css/` — カスケード順序通りに `<link>` 読込)
| スタイルシート | 役割・担当コンポーネント |
|---|---|
| `frontend/css/style.css` | テーマ変数（和紙 `paper` / 夜墨 `sumi`）、リセット、上部ヘッダーツールバー、左サイドバー（アコーディオン、タイムライン、フォルダツリー、タグツリー、`📊 枚数順` トグル、カラーパレット） |
| `frontend/css/grid-lightbox.css` | メインコンテンツエリア、写真グリッド（標準・びっしり・マウント・クリーン表示）、スキャンモーダル、ライトボックス全画面ビュー |
| `frontend/css/selection-menu.css` | マルチ選択チェックボックス、右クリックコンテキストメニュー（#contextMenu）、フォルダ右クリックメニュー（#folderContextMenu） |
| `frontend/css/inspector.css` | 右インスペクタ・ペイン、露出ブラケット・連写スタックバー、RAWバッジ、GPSミニマップ、評価フィルタトグル |
| `frontend/css/modals-features.css` | 保存済みプリセット、フルスクリーンスライドショー、AI自動タグ、ヘルプモーダル (`#helpModal`)、終了確認、グローバルスキャン進捗フッター、重複ドッグイヤー、場所ツリー、非破壊画像調整モーダル、スマート・テイクアウトモーダル、`storage` リネームモーダル、XMPプレビューバー、2ペイン `⚙️ 設定 ＆ 🌳 タグツリーエディタ` モーダル |
| `frontend/css/lab-map.css` | カメラ・レンズ2階層ツリー、ラボセクション、勝ちレンズカルテ (`#labKarteModal`)、47都道府県制覇マップ・ヒートマップ・さんぽ軌跡 (`#locationMapModal`)、ベタ焼きトリガー |
| `frontend/css/histogram.css` | オンデマンドRGB・輝度ヒストグラムウィジェット |
| `frontend/css/compare.css` | 2枚並列比較ビュー (`#compareModal`) |
| `frontend/css/ui-unify.css` | UI形状3分類（器=`2px`、操作=`5px`、表示ピル=`999px`）＆ 操作3タイプ（単発A・トグルB・択一セレクトC）統一ルール |
| `frontend/css/mobile.css` | スマホ専用画面 (`mobile.html` / `PhotoManager_Mobile.html`) 用スタイル |

---

## 1. 写真グリッド・表示・レイアウト (Grid & Presentation)

メイン画面中央の写真サムネイル一覧、カード表示、ソート、レイアウト変更に関する機能。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#photoGrid` (メインコンテナ), `#viewTitle`, `#photoCountBadge`, `#sortBySelect` (14種類のソート順: シャッター速度順含む), `#attrFilterGroup` (`#attrFilterToggles`: `すべて`/`RAW`/`✂ 調整済` ＋ `#attrSubFilterSelect`: `JPEG`/`RAW+JPG`/`📄 XMP`), `#layoutToggleBtn`, `#minimalToggleBtn` |
| **CSS** | `frontend/css/style.css`, `frontend/css/grid-lightbox.css` (`.photo-grid`, `.photo-card`, `.view-actions`, `.attr-filter-toggles`, `.attr-sub-select`) |
| **フロントエンド (JS)** | `frontend/js/app.js`<br>・`fetchPhotos()`: APIから写真一覧を取得し `state.photos` へ格納（`attr_filter` 等対応）<br>・`renderPhotoGrid()`: グリッド描画のメイン処理（差分更新、DOM構築）<br>・`createPhotoCard(photo, index)`: 1枚分のカードDOM要素を生成<br>・`setupPhotoGridDelegation()`: グリッド上のクリック/右クリック/ダブルクリックの委譲処理<br>・`navigateGridSelection(key, isShift)`: 一覧グリッドでの矢印キー移動（`←` `→` `↑` `↓` ＆ `Shift` 範囲選択・自動スクロール・インスペクタ同期）<br>・`setAttrFilter(attr)` / `syncAttrFilterButtons()`: 属性フィルタピル＆詳細属性サブセレクト（すべて / RAW / 調整済 / JPEG / RAW+JPG / XMP）切替<br>・`setLayoutMode(mode)`: グリッドサイズ・密度切り替え<br>・`toggleMinimalView()`: 情報非表示の純粋写真一覧モード切替<br>・`removePhotoFromView(photoId)`: フィルタ外となった写真を全再描画せずDOMから差分除去し、単一フォーカス時は次の写真へ自動引き継ぎ |
| **APIエンドポイント** | `GET /api/photos` (クエリ引数: `folder`, `recursive`, `search`, `ratings`, `attr_filter`, `tags`, `sort_by`, `camera`, `year_month`, `connection`, `stacked`)<br>`GET /api/photo/{photo_id}/thumbnail` (サムネイル画像バイナリ)<br>`GET /api/thumbnails/batch` (複数サムネイルの一括取得) |
| **バックエンド (Python)** | `server/app.py`: `api_photos()` (`_fast_json()` で高速返却)<br>`server/database/photos.py`: `get_photos()` (動的SQL構築、`_directory_filter_sql` による範囲絞り込み、`_shutter_speed_seconds_sql()` によるシャッター速度順ソート)<br>`server/database/thumbnails.py`: `get_thumbnail()` (SQLite BLOB取得) |
| **関連ナレッジ** | `performance-optimization-patterns.md` (LIKE検索廃止と範囲比較、JSON高速化、BLOBサムネイル), `ui-ux-diagnosis-and-roadmap.md` |

---

## 2. 写真の選択と一括操作 (Selection & Batch Actions)

サムネイルの選択、範囲選択、コンテキストメニュー、一括操作バー、非破壊撮影日時シフト補正、物理削除機能。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#contextMenu` (右クリックコンテキストメニュー), `#inspectorBatchView` (右インスペクタの一括編集パネル), `#batchThumbnailsStrip`, `#batchRateButtons`, `#batchColorPaletteBlock`, `#dateShiftModal` (撮影日時一括シフト補正モーダル), `#deleteConfirmModal` |
| **フロントエンド (JS)** | `frontend/js/selection.js` ＆ `frontend/js/inspector.js`<br>・`togglePhotoSelection(photoId, isCtrl)`: 単一・Ctrl追加選択<br>・`rangeSelectPhotos(targetPhotoId)`: Shiftクリックによる範囲選択<br>・`selectAllPhotos()` / `clearSelection()`: 全選択 / 選択解除 (Escキー)<br>・`updateCardSelectionClasses()`: 前回選択差分（`lastSelectedPhotoIds`）のみDOM更新<br>・`openContextMenu(e, photoId)` / `closeContextMenu()`: 右クリックメニュー表示・アクションディスパッチ（評価、タグ付与、スマートテイクアウト、撮影日時シフト、storage操作、サムネイル再生成、画像コピー等）<br>・`showBatchInspector(photos)`: 右インスペクタでの選択枚数表示・一括評価設定（優・良・可・棄）・一括タグ/カラーラベル付与<br>・`openDateShiftModal()` / `submitDateShift()` / `_formatShiftedDateLocal()`: 撮影日時一括シフト補正（±日時・プリセット・5件プレビュー・元のEXIF日時への復元）<br>・`deleteSelectedPhotos()`: 選択中写真の物理削除（確認ダイアログ後実行） |
| **APIエンドポイント** | `DELETE /api/photo/{photo_id}` (単一写真の削除)<br>`POST /api/photos/batch-tags` (一括タグ追加/削除)<br>`POST /api/photos/batch-rate` (一括評価付与)<br>`POST /api/photos/batch-shift-date` (非破壊の撮影日時一括シフト補正＆元日時リセット) |
| **バックエンド (Python)** | `server/app.py`: `api_delete_photo()`, `api_batch_tags()`, `api_batch_rate()`, `api_batch_shift_photo_dates()`<br>`server/database/photos.py`: `delete_photo_by_id()`, `batch_shift_photo_dates()` (`original_date_taken` 退避・再スキャン保護)<br>`server/database/tags.py`: `batch_add_tag()`, `batch_remove_tag()` |

---

## 3. 評価・カラーラベル・階層タグ管理 ＆ タグツリーエディタ (Rating, Labels & Tags)

Picasaスタイルの4段階評価（棄/可/良/優）、カラーラベル（12色）、階層タグ（`旅行/2026/京都` 形式）の付与・フィルタリング、および専用「🌳 タグツリーエディタ」でのドラッグ＆ドロップ階層変更・管理。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#accordionItem-tags`, `#tagSortByCountToggleBtn` (`📊 枚数順`), `#tagList`, `#inspectorRatingBtns`, `#inspectorColorGrid`, `#inspectorTagList`, `#inspectorQuickTree`, `#settingsTagTreeContainer` (`#dbMaintenanceModal` 右ペイン), `#settingsTagRootDropZone`, `#deleteTagModal` |
| **フロントエンド (JS)** | `frontend/js/sidebar_filters.js`<br>・`buildTagTree(tags)`: `state.tagSortByCount`（ON時は枚数順、OFF時は `state.tagSortMode` 名前順4ルール）に基づく階層ツリー構築<br>・`renderTagList()`: 左ペインの3ステート（`[+]`含む/`[-]`除外/解除）フィルタツリー描画<br>`frontend/js/inspector.js`<br>・`renderInspectorQuickTree()`: 写真への明示的タグ付与（`+追加`）と子タグ作成（`+子`）<br>`frontend/js/folder_tree.js`<br>・`renderSettingsTagTreeEditor()`: ドラッグ＆ドロップでの親子階層移動・ルート独立移動、インラインリネーム（`✏`）、全体削除（`🗑️` 確認モーダル連動）、0枚の空タグ作成 |
| **APIエンドポイント** | `POST /api/photo/{photo_id}/rate`<br>`POST /api/photos/batch-rate`<br>`GET /api/tags`<br>`POST /api/tags/create` (0枚の空タグ・親フォルダ定義作成)<br>`POST /api/photo/{photo_id}/tags`<br>`DELETE /api/photo/{photo_id}/tags/{tag:path}`<br>`PUT /api/tags/{tag:path}` (リネーム・D&D階層移動・祖先タグ安全同期)<br>`DELETE /api/tags/{tag:path}` (一括完全削除) |
| **バックエンド (Python)** | `server/app.py`: `api_rate_photo()`, `api_batch_rate()`, `api_get_tags()`, `api_create_tag()`, `api_add_tag()`, `api_rename_tag()` 等<br>`server/database/photos.py`: `update_rating()`, `batch_update_rating()`<br>`server/database/tags.py`: `get_all_tags_summary()`, `create_tag_definition()`, `add_tag_to_photo()`, `rename_tag()`, `delete_tag()` |
| **関連ナレッジ** | `tag-trees-and-batch-actions.md` |

---

## 4. ライトボックス & スライドショー (Lightbox & Slideshow)

全画面表示、詳細ビュー、ズーム・パン、スタック切替、自動スライドショー。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#lightboxModal`, `#lightboxImg`, `#lightboxFilmstrip`, `#filmstripList`, `#slideshowModal`, `#slideshowStage`, `#slideshowImgA`, `#slideshowImgB` |
| **フロントエンド (JS)** | `frontend/js/lightbox.js` (ライトボックス):<br>・`openLightbox(index)` / `closeLightbox()`: ライトボックス開閉<br>・`loadLightboxPhoto(index)` / `updateLightboxContent(photo)`: 写真読み込み・EXIF/タグ更新<br>・`initLightboxZoomInteractions()`: マウスホイール拡大、ドラッグパン、ダブルクリックフィット<br>・`renderLightboxBracketBar()` / `navigateStackMember()`: 連写/ブラケット写真の切替バー<br>・`renderFilmstrip()`: 下部フィルムストリップの高速差分レンダリング<br>`frontend/js/slideshow.js` (スライドショー):<br>・`startSlideshow(photos, startIndex, title)`: スライドショー開始<br>・ダブルバッファ構造 (`imgA` / `imgB`) によるクロスフェード、再生速度切替、シャッフル |
| **APIエンドポイント** | `GET /api/photo/{photo_id}/view` (プレビュー用リサイズ画像または原寸画像)<br>`GET /api/photo/{photo_id}` (詳細メタデータ・スタック構成メンバー) |
| **バックエンド (Python)** | `server/app.py`: `api_photo_view()` (WebP変換・キャッシュ返却), `api_photo_detail()`<br>`server/raw_loader.py`: RAW内蔵プレビューJPEG抽出またはLibRaw高速現像 |

---

## 5. サイドバー・絞り込み・検索 (Sidebar, Filtering & Search)

左ペインのナビゲーション（フォルダ、タイムライン、カメラ、タグ、検索、プリセット）。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#sidebarIndexTabs`, `#sidebarTabPanels`, `#tabPanel-quick`, `#tabPanel-timeline`, `#sidebarMiniCalendarBox` (サイドバー常設ミニカレンダー), `#timelineOpenCalendarBtn`, `#calendarModal` (拡大カレンダーモーダル: 月間フォト＆年間12ヶ月ヒートマップ), `#tabPanel-camera`, `#tabPanel-folder`, `#tabPanel-tags`, `#tabPanel-presets`, `#tabPanel-search` |
| **フロントエンド (JS)** | `frontend/js/sidebar_filters.js` & `frontend/js/app.js` & `frontend/js/presets.js`<br>・`initSidebarTabs()`: サイドバータブ切替<br>・`renderTimeline(timelineData)` / `toggleTimelineYearMonth()` / `toggleYearMonths()` / `toggleTimelineDate()`: 撮影年月ツリーと年・月・日のOR絞り込み (`sidebar_filters.js`)<br>・`fetchCalendarSummary()` / `renderSidebarMiniCalendar()` / `openCalendarModal()`: サイドバーミニカレンダー＆拡大カレンダー（月間代表サムネイル・年間12ヶ月ヒートマップ・Shift日付範囲選択） (`sidebar_filters.js`)<br>・`renderCameras(cameras)` / `cycleCameraFilterState()` / `cycleLensFilterState()`: カメラ＆レンズ2階層ツリーと排他絞り込み (`sidebar_filters.js`)<br>・`buildTagTree(tags)` / `renderTagList()`: 階層タグツリーと12色パレット (`sidebar_filters.js`)<br>・`renderFilterPresetsList()` / `applyFilterPreset()`: フィルタプリセットの保存・適用 (`presets.js`) |
| **APIエンドポイント** | `GET /api/timeline`<br>`GET /api/calendar/summary` (日別枚数・優枚数・代表写真ID・代表撮影地集計)<br>`GET /api/cameras`<br>`GET /api/folders`<br>`GET /api/locations/heatmap`<br>`GET /api/lab/karte`<br>`GET /api/lab/random-unrated-folder`<br>`POST /api/folders/open` (エクスプローラー起動)<br>`POST /api/folders/ignore` / `DELETE /api/folders/ignore` (除外管理)<br>`GET /api/filter-presets`, `POST /api/filter-presets` (プリセットCRUD) |
| **バックエンド (Python)** | `server/database/photos.py`: `get_photos()` (`year_months` と `dates` のOR結合フィルタ対応), `get_location_tree_summary()`<br>`server/database/lab_analytics.py`: `get_location_heatmap_data()`, `get_lab_karte_data()`, `get_random_unrated_folder()`, `_normalize_jp_prefecture()`<br>`server/database/folders.py`: `get_timeline_summary()`, `get_calendar_summary()`, `get_cameras_summary()`, `get_folders_summary()`, `_directory_filter_sql()`<br>`server/database/presets.py`: `get_filter_presets()`, `create_filter_preset()` |

---

## 6. 右ペイン (インスペクター / 詳細・一括編集・XMPプレビュー) (Inspector)

選択写真のEXIF詳細、ヒストグラム、XMPサイドカープレビュー/取込、地図・GPS情報、RAW連携、一括メタデータ編集。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#inspectorPane`, `#inspectorSingleView`, `#inspectorBatchView`, `#inspectorQuickActionsBar` (`#inspectorQuickAdjustBtn`, `#inspectorQuickHistBtn`, `#inspectorQuickRotateLeftBtn`, `#inspectorQuickRotateRightBtn`), `#inspectorXmpBar`, `#inspectorXmpHoldPreviewBtn`, `#inspectorXmpImportBtn`, `#inspectorTabPaneExif`, `#inspectorTabPaneMap`, `#inspectorTabPaneTags`, `#gpsCandidateModal` |
| **フロントエンド (JS)** | `frontend/js/inspector.js`<br>・`toggleInspector(forceState)`: インスペクター開閉とレイアウト調整<br>・`updateInspectorView()`: 選択数に応じて単一/一括ビューを切り替え<br>・`showSingleInspector(photo)`: EXIF値・XMPサイドカー検出バーの描画、`_bindXmpSidecarControls()` による長押しホールド比較と評価・タグ取込<br>・`showBatchInspector(photos)`: 複数選択時の一括タグ編集・一括評価<br>・`showGpsCandidateModal(photo)`: 近傍写真（時間・場所）からGPS座標をコピーするモーダル<br>・`openPhotoFolder(photoId)`: 写真をエクスプローラーで選択状態で表示 |
| **APIエンドポイント** | `GET /api/photo/{photo_id}`<br>`GET /api/photo/{photo_id}/xmp-preview`<br>`POST /api/photo/{photo_id}/xmp-import` / `POST /api/photos/batch-xmp-import`<br>`POST /api/photo/{photo_id}/open-raw`<br>`POST /api/photo/{photo_id}/open-folder`<br>`GET /api/photo/{photo_id}/gps-candidates`<br>`POST /api/photo/{photo_id}/copy-gps` / `POST /api/photos/batch-copy-gps` |
| **バックエンド (Python)** | `server/app.py`: `api_photo_xmp_preview()`, `api_photo_xmp_import()`, `api_open_raw()`, `api_open_folder()`, `api_gps_candidates()`, `api_copy_gps()`<br>`server/sidecar.py`: `parse_xmp_for_photo()`, `find_sidecars_for_file()`<br>`server/database/photos.py`: `update_photo_gps()`, `find_nearby_gps_photos()` |

---

## 7. 写真グループ化 & スタック (Burst, RAW+JPG, Bracket Stacks)

同一被写体の連写（バースト）、RAW+JPEGペア、露出ブラケット（AEB）のグループ化表示。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#card-stack-badge`, `#inspectorBracketSection`, `#inspectorRawPairRow` |
| **フロントエンド (JS)** | `frontend/js/app.js`<br>・`createPhotoCard()`: スタック代表カードのバッジ描画（枚数表示、ペアバッジ）<br>・`getPhotoExactTimestamp()`: サブセック・ミリ秒精度での撮影時間計算<br>・`renderLightboxBracketBar()`: 連写の秒ズレ（+0.17s等）やEV補正値（-1.00 EV等）の比較表示<br>・`switchLightboxStackMember()` / `selectLightboxStackMember()`: スタック内写真の切替 |
| **APIエンドポイント** | `POST /api/photo/{photo_id}/set-primary` (代表写真の変更)<br>`POST /api/stacks/recalculate` (スタックの再計算) |
| **バックエンド (Python)** | `server/database/stacks.py`: `recalculate_stacks()` (連写間隔・露出値による自動グループ化、差分更新), `set_stack_primary()` |
| **関連ナレッジ** | `performance-optimization-patterns.md` (スタック差分UPDATEによる高速化) |

---

## 8. スキャン & フォルダ管理 (Scanner & Folder Management)

フォルダ監視・登録、再帰探索、メタデータ抽出、サムネイル自動生成、差分更新。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | 左サイドバー `#folderList` (階層フォルダツリー), `#folderScanProgressCard`, `#folderPathInput`, `#folderPathScanBtn`, `#folderContextMenu` |
| **フロントエンド (JS)** | `frontend/js/folder_tree.js`<br>・`renderFolderTree()` / `_ftFetchChildren()`: ショートカット・接続ドライブ・未接続セクションの遅延展開<br>・`_ftToggleFilter()`: 通常絞り込み / 除外絞り込み / 解除の3段切替<br>・`_ftShowContextMenu()`: 再スキャン、リフレッシュ（消去ファイルDB削除）、AI自動タグ、管理除外、`storage` 専用操作（サブフォルダ作成・リネーム・外部エクスポート・空フォルダ削除）<br>・`_ftStartScan()` / `_ftPollScanProgress()`: スキャンリクエスト発行と下部進捗バー表示 |
| **APIエンドポイント** | `GET /api/folder-tree/roots`<br>`GET /api/folder-tree/children`<br>`POST /api/scan` (スキャン開始)<br>`GET /api/scan/status` (進捗取得)<br>`POST /api/folder-tree/exclude`<br>`DELETE /api/folder-tree/clean-missing`<br>`POST /api/photos/batch-delete`<br>`DELETE /api/folders` |
| **バックエンド (Python)** | `server/folder_tree.py`: ショートカット・ドライブ一覧取得、除外フォルダ永続化<br>`server/scanner.py`: `scan_directory()` (size+mtimeによる差分スキップ、EXIF抽出、WebP生成)<br>`server/database/folders.py`: フォルダCRUD・親フォルダ/未接続ステータス管理 |
| **関連ナレッジ** | `portable-storage-patterns.md` (ポータブルパス原則), `performance-optimization-patterns.md` (差分スキャン) |

---

## 9. RAW画像処理 & クラウド連携 (RAW Loading & Cloud Storage)

各社RAWファイルの解析、プレビュー高速抽出、クラウドストレージの誤ダウンロード防止。

| 項目 | 内容 |
|---|---|
| **対象拡張子** | `.cr2`, `.cr3`, `.nef`, `.arw`, `.dng`, `.raf`, `.rw2`, `.orf` など |
| **バックエンド (Python)** | `server/raw_loader.py`:<br>・`is_raw_file(path)`: RAW判定<br>・`extract_embedded_jpeg(path)`: EXIF/RAWコンテナ内の内蔵JPEG高速バイナリ抽出<br>・`load_raw_preview(path)`: LibRaw（`rawpy`）による半解像度高速現像<br>`server/shell_thumbnail.py`:<br>・`get_shell_thumbnail(path)`: Windows Shell API経由でサムネイル取得（クラウドオンデマンドファイルを実体化させずに安全表示） |
| **関連ナレッジ** | `.agents/rules/architecture-and-performance.md` 第4章 (RAW画像処理 & パフォーマンス) |

---

## 10. AI自動タグ付け & 機械学習 (AI Auto-tagging)

ONNX Runtime と CLIP モデルによるローカル画像分類・被写体自動認識。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#inspectorAiTagBtn`, `#aiTagProgressBar`, `#aiTagProgressText`, `#cancelAiTagBtn`, `#folderAutoAiToggleBtn` |
| **フロントエンド (JS)** | `frontend/js/app.js`<br>・`triggerAiTagForSinglePhoto(photoId)`: 単一写真へのAIタグ付け実行<br>・`promoteTagForPhoto(photoId, tag)`: AI候補タグ（半透明）をクリックして確定タグへ昇格<br>`frontend/js/folder_tree.js`<br>・AI自動タグON/OFFトグル、フォルダ単位のAIタグ一括実行 |
| **APIエンドポイント** | `POST /api/ai/tag-photo/{photo_id}`<br>`POST /api/ai/tag-folder`<br>`GET /api/ai/status`<br>`POST /api/ai/cancel`<br>`POST /api/ai/promote-tag`<br>`DELETE /api/ai/tags` |
| **バックエンド (Python)** | `server/ai/tagger.py`: ONNX Runtime推論エンジン、タグ埋め込みベクトル照合<br>`server/ai/worker.py`: バックグラウンドワーカースレッド、優先度キュー、中断処理 |

---

## 11. アプリ内ストレージ (`storage/`) 完結管理・XMP連携・スマートテイクアウト & 非破壊画像調整

`storage/` 内のファイル/フォルダ管理・サイドカー追従、選択した写真を特定フォルダへコピー・リサイズ・Exif同期/選択消去・非破壊調整焼き込みして書き出す機能、および元画像非破壊での回転・水平出し・クロップ・トーン微調整機能。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | **テイクアウト**: `#smartTakeoutModal`, `#takeoutApplyAdjustments`, `#takeoutExifSyncDb`, `#takeoutExifRemoveAll`, `#takeoutExifRemoveGps`, `#takeoutExportXmp`<br>**storage管理**: `#storageRenameModal`, `#storageFolderCreateModal`, `#storageFolderRenameModal`, `#storageFolderExportModal`<br>**画像調整**: `#imageAdjustModal`, `#adjustCopyToneBtn`, `#adjustPasteToneBtn`, `#adjustCompareOrigBtn`, `#adjustBeforeBadge`, `#adjustFineAngleRange`, `#adjustBrightnessRange`, `#adjustContrastRange`, `#adjustSaturationRange`<br>**コンテキストメニュー連携**: `#contextMenuCopyTone`, `#contextMenuPasteTone`, `#contextMenuCopyImageItem` |
| **フロントエンド (JS)** | `frontend/js/takeout.js`: スマートテイクアウト設定モーダル制御、`executeSmartTakeout()`<br>`frontend/js/storage.js`: `storage/` へのインポート・移動・単一/一括連番リネーム (`openStorageRenameModal`)、ドラッグ＆ドロップ階層移動<br>`frontend/js/adjust.js`: Twitter(X)風クロップ枠・8点ハンドル制御、水平出し（自動内接ズーム連動）・明るさ・コントラスト・彩度の0ms CSSリアルタイムプレビュー、`setCompareOriginalMode()`（`\` / `Space` 長押しBefore比較）、`copyPhotoToneAdjustments()` / `batchPastePhotoToneAdjustments()`（トーン3項目のみのコピー＆一括ペースト）、`copyPhotoImageToClipboard()`（`Ctrl+C` で非破壊調整反映済み画像をOSクリップボードへコピー）、`saveAdjustModal()` |
| **APIエンドポイント** | `POST /api/export/smart` (スマートテイクアウト一括出力・オプション `.xmp` サイドカー出力)<br>`POST /api/photo/{photo_id}/adjust` / `POST /api/photos/batch-adjust-tone` (トーン3項目一括適用) / `POST /api/photo/{photo_id}/reset-adjust` / `POST /api/photos/batch-reset-adjust`<br>`GET /api/photo/{photo_id}/view` (`?raw=1` で調整モーダル用無加工原画を返却)<br>`GET /api/storage-folders` / `POST /api/storage-folders` / `PUT /api/storage-folders/rename` / `DELETE /api/storage-folders` / `POST /api/storage-folders/export`<br>`POST /api/photos/import-to-storage` / `POST /api/storage/move-photos` / `POST /api/storage/rename-photo` / `POST /api/storage/batch-rename-photos` |
| **バックエンド (Python)** | `server/storage_manager.py`: `get_storage_folders()`, `create_storage_subfolder()`, `rename_storage_subfolder()`, `delete_storage_subfolder()`, `export_storage_folder()`, `import_photos_to_storage()`, `move_photos_in_storage()`, `rename_photo_in_storage()`, `batch_rename_photos_in_storage()`<br>`server/sidecar.py`: `parse_xmp_for_photo()`, `write_xmp_sidecar_for_photo()`, `find_sidecars_for_file()`, `move_sidecars_for_file()`, `rename_sidecars_for_file()`, `copy_sidecars_for_file()`<br>`server/exporter.py`: `export_single_photo()`, `filter_exif_data()`<br>`server/scanner.py`: `apply_photo_adjustments_pil()`, `refresh_photo_thumbnail_transform()`<br>`server/database/photos.py`: `update_photo_adjustments()`, `batch_update_photo_tone()`, `reset_photo_adjustments()`, `update_photo_file_location()`, `update_directory_prefix()` |
| **関連ナレッジ** | `storage-and-xmp-sidecar-architecture.md` |

---

## 12. 設定 ＆ データベース管理・ライフサイクル・配布ビルド (Settings, Database & Build)

2ペイン設定画面（タグ名前順設定・タグツリーエディタ・DB管理）、SQLite最適化、VACUUM、自動バックアップ、プロセス終了監視、ポータブル配布パッケージ生成。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#dbMaintenanceModal` (`⚙️ 設定 ＆ タグツリーエディタ`), `#settingTagSortModeSelect`, `#settingsTagTreeContainer`, `#dbMaintVacuumBtn`, `#dbMaintBackupBtn`, `#dbMaintOpenBackupDirBtn`, `#shutdownModal` |
| **フロントエンド (JS)** | `frontend/js/folder_tree.js`<br>・`_ftInitDbMaintenanceModal()`: 名前順ルール保存、右ペイン `renderSettingsTagTreeEditor()` 描画、データベース統計取得、VACUUM最適化、世代管理バックアップ、フォルダ起動<br>`frontend/js/common.js`<br>・`confirmShutdown()`: アプリ正常終了リクエスト発行<br>・`initPaneResize()`: 左右ペインのリサイズバー制御と `localStorage` 永続化 |
| **APIエンドポイント** | `POST /api/heartbeat`<br>`POST /api/shutdown`<br>`GET /api/version`<br>`GET /api/database/stats`<br>`POST /api/database/vacuum`<br>`POST /api/database/backup`<br>`GET /api/database/backups`<br>`POST /api/database/open-backup-dir`<br>`GET /api/volumes` |
| **バックエンド / ビルド** | `server/heartbeat.py`: ブラウザ生存監視、自動シャットダウンタイマー<br>`server/database/connection.py`: SQLite接続・PRAGMA設定<br>`server/database/stats.py`: DBサイズ計算、VACUUM、バックアップ管理<br>`build_dist.bat` & `server/make_release_zips.py`: `robocopy /MIR` 差分同期によるフル版 (`dist/` → `PhotoManager_v<VER>.zip`) ＆ 軽量差分アップデート版 (`dist_update/` → `PhotoManager_v<VER>diff.zip`) の自動生成 |
| **関連ナレッジ** | `portable-storage-patterns.md`, `sqlite-blob-thumbnails.md`, `performance-optimization-patterns.md` |

---

## 13. Android / スマホ専用UI & ハイブリッドDB連携 (Mobile Viewer & Offline DB Sync)

スマートフォン（Android）からのWi-Fi直結リアルタイム閲覧・選別、および外出先での完全インライン単体HTML (`PhotoManager_Mobile.html`) ＋ USB内 `cache/library.db` 直接読込（WebAssembly SQLite によるファイルロック完全回避）と差分同期機能。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | **スマホ専用画面**: `frontend/mobile.html` / 単体完結版 `PhotoManager_Mobile.html` (`#mPhotoGrid`, `#mViewerModal`, `#mDrawer`, `#mInfoSheet`, `#mDbSyncOverlay`)<br>**PC側連携モーダル**: `frontend/index.html` (`#openMobileModalBtn`, `#mobileConnectModal`, `#mobileUrlsContainer`, `#mobileDetectedSyncBox`, `#pasteMobileSyncJsonBtn`, `#pickMobileSyncFileBtn`) |
| **CSS** | `frontend/css/mobile.css` (Hinomaru Ink 夜墨・和紙対応モバイルUI、親指ドック、ボトムシート、セーフエリア対応) |
| **フロントエンド (JS)** | `frontend/js/mobile.js`<br>・`tryConnectServer()` / `ensureSqlJsLoaded()` / `loadLocalSqliteFile(file)`: `server` モードと `localdb` (`sql.js` WebAssembly・Base64 `wasmBinary` 直接展開対応) モードの自動切替とメモリ展開、`_safeGetStorage` による `content://` 保護<br>・`getMobileThumbnailUrl(photo)`: サーバーサムネイルURLまたは `thumbnails.data` BLOB からの `ObjectURL` 生成＆キャッシュ<br>・`rateCurrentViewerPhoto()` / `setupViewerTouchGestures()`: 親指ワンタップ4段階評価（自動次送り連動）、左右スワイプ送り、ダブルタップズーム<br>・`exportSyncJsonFile()` / `shareSyncJsonFile()` / `copySyncJsonToClipboard()` / `pushPendingChangesToServer()`: `mobile_sync.json` 出力（Data URI対応）・OS共有・コピー・Wi-Fi直接反映<br>`frontend/js/common.js`<br>・`openMobileModal()` / `loadMobileConnectionInfo()` / `applyDetectedMobileSync()` / `importMobileSyncJsonFile()` / `importMobileSyncFromClipboard()`: PC側からの接続URL表示・差分インポート制御 |
| **単体HTML / WASM資産** | `PhotoManager_Mobile.html` (自動生成単体ファイル), `server/mobile_bundle.py`, `frontend/vendor/sqljs/sql-wasm.js`, `frontend/vendor/sqljs/sql-wasm.wasm` |
| **APIエンドポイント** | `GET /m` (`mobile.html` エントリ)<br>`GET /api/mobile/standalone` (`PhotoManager_Mobile.html` ダウンロード配信)<br>`GET /api/mobile/info` (LAN/Tailscale接続URL一覧、DBサイズ、未反映 `mobile_sync.json` 自動検知)<br>`POST /api/mobile/sync-import` (評価・タグ差分のサニタイズ＆3段階フォールバック照合マージ) |
| **バックエンド (Python)** | `server/mobile_bundle.py`: `build_standalone_mobile_html()`, `ensure_standalone_mobile_html()`<br>`server/app.py`: `mobile_app_entry()`, `api_mobile_standalone()`, `api_mobile_info()`, `api_mobile_sync_import()`, `_sanitize_mobile_tag()`<br>`server/lan_access.py`: `is_host_header_allowed()` (DNS Rebinding防止), `is_lan_path_allowed()` (LANホワイトリスト), トークン認証・Cookie管理, `enable_lan_listeners()`, 30分アイドル自動待受停止<br>`run.py`: サーバー起動・アプリウィンドウ立ち上げ |
| **関連ナレッジ** | `mobile-hybrid-architecture.md` |

---

---

## 14. セキュリティ ＆ 自動テスト (Security & Automated Tests)

ローカルWebサーバー固有の脆弱性対策（DNS Rebinding、CSRF、LAN不正アクセス、XSS）と自動回帰テストスイート。

| 項目 | 内容 |
|---|---|
| **セキュリティ防御層** | **Layer 1: Hostヘッダ検証** (`server/lan_access.py`: `is_host_header_allowed()`)<br>**Layer 2: Originヘッダ検証** (`server/app.py`: 外部オリジン・nullオリジン遮断)<br>**Layer 3: LAN接続トークン認証** (`server/lan_access.py`: `LAN_TOKEN`, QRコード埋め込み → `pm_lan_token` HttpOnly Cookie)<br>**Layer 4: LAN APIホワイトリスト** (`server/lan_access.py`: `is_lan_path_allowed()`, モバイル最小限APIのみ許可、管理API遮断)<br>**ライフサイクル保護**: 30分無通信自動停止 (`LAN_IDLE_TIMEOUT_SEC`), アプリ再起動時トークン失効<br>**サニタイズ ＆ 上限設定**: `frontend/js/common.js` `escapeHtml()` 徹底、XMP最大5MB、Upload最大32MB |
| **テストスイート (`tests/`)** | `tests/test_security.py`:<br>・`test_local_access_ok`: ローカルアクセス正常性<br>・`test_dns_rebinding_host_rejected`: 悪意あるHostヘッダ遮断 (400)<br>・`test_foreign_origin_rejected`: 外部Origin遮断 (403)<br>・`test_lan_requires_token`: LANトークン必須化・Cookie認証<br>・`test_lan_whitelist_blocks_admin_apis`: LAN管理API遮断<br>・`test_lan_whitelist_allows_mobile_apis`: LANモバイルAPI許可<br>・`test_xmp_size_limit`: 5MB超XMP安全スキップ<br>・`test_open_folder_rejects_files`: 不正実行ファイル起動防止<br>`tests/test_core_regression.py`:<br>・DB初期化・マイグレーション、サムネイルBLOB、タグ祖先、4段階評価、コンタクトシートフォールバック |
| **実行コマンド** | `.\python\python.exe tests\test_security.py`<br>`.\python\python.exe tests\test_core_regression.py` |
| **関連ナレッジ** | `security-architecture.md`, `storage-and-xmp-sidecar-architecture.md` |

---

## まとめ：機能改修時の基本チェックフロー

1. **画面UIや操作性を変えたい場合**:
   - `frontend/index.html` で対象要素の ID / クラス名を確認
   - 該当の `frontend/js/*.js` モジュールで `render*` またはイベントリスナー関数を改修
   - 必要に応じて `frontend/css/*.css` でスタイル調整し、`frontend/js/i18n.js` に日英翻訳辞書を追加
2. **データの絞り込み・取得速度・SQLを変えたい場合**:
   - `server/database/` 配下の該当モジュール（`photos.py`, `folders.py`, `tags.py` 等）を改修
   - インデックスが効いているか、`_directory_filter_sql` を使っているか確認
3. **ファイル操作・RAW・スキャンを変えたい場合**:
   - `server/scanner.py` または `server/raw_loader.py` を改修
   - ポータブルパス（`resolve_portable_path`）を維持しているか確認
4. **改修後の必須手順**:
   - `VERSION` ファイル内の最終更新日時（`Updated: YYYY-MM-DD HH:MM`）の更新、および検証完了・コミット時のバージョン番号カウントアップ（`+0.01` またはユーザー指示値）
   - マニュアルの同期更新（`MANUAL.md` および `frontend/index.html` の `#helpModal`）
