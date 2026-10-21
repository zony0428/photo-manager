# Photo Manager - 機能別コードマップ (Feature-to-Code Architecture Map)

本ドキュメントは、Photo Manager の各機能が「フロントエンド（UI/JS）」「API（FastAPI）」「バックエンド処理/DB（Python/SQLite）」のどのコードに対応しているかを網羅的に整理したアーキテクチャ案内である。
「○○機能を改善したい」「不具合を修正したい」という依頼を受けたエージェントは、まず本マップを参照して該当コードを特定すること。

---

## 目次
1. [写真グリッド・表示・レイアウト (Grid & Presentation)](#1-写真グリッド表示レイアウト-grid--presentation)
2. [写真の選択と一括操作 (Selection & Batch Actions)](#2-写真の選択と一括操作-selection--batch-actions)
3. [評価・カラーラベル・階層タグ管理 (Rating, Labels & Tags)](#3-評価カラーラベル階層タグ管理-rating-labels--tags)
4. [ライトボックス & スライドショー (Lightbox & Slideshow)](#4-ライトボックス--スライドショー-lightbox--slideshow)
5. [サイドバー・絞り込み・検索 (Sidebar, Filtering & Search)](#5-サイドバー絞り込み検索-sidebar-filtering--search)
6. [右ペイン (インスペクター / 詳細・一括編集) (Inspector)](#6-右ペイン-インスペクター--詳細一括編集-inspector)
7. [写真グループ化 & スタック (Burst, RAW+JPG, Bracket Stacks)](#7-写真グループ化--スタック-burst-rawjpg-bracket-stacks)
8. [スキャン & フォルダ管理 (Scanner & Folder Management)](#8-スキャン--フォルダ管理-scanner--folder-management)
9. [RAW画像処理 & クラウド連携 (RAW Loading & Cloud Storage)](#9-raw画像処理--クラウド連携-raw-loading--cloud-storage)
10. [AI自動タグ付け & 機械学習 (AI Auto-tagging)](#10-ai自動タグ付け--機械学習-ai-auto-tagging)
11. [写真の送る機能 (エクスポート / インポート) (Export & Import)](#11-写真の送る機能-エクスポート--インポート-export--import)
12. [データベース管理 & ライフサイクル (Database, Performance & Lifecycle)](#12-データベース管理--ライフサイクル-database-performance--lifecycle)
13. [Android / スマホ専用UI & ハイブリッドDB連携 (Mobile Viewer & Offline DB Sync)](#13-android--スマホ専用ui--ハイブリッドdb連携-mobile-viewer--offline-db-sync)

---

## フロントエンド・モジュール構成 (JS / CSS)

### JavaScript モジュール (`frontend/js/`)
| モジュール | 役割・担当機能 |
|---|---|
| `frontend/js/common.js` | 定数、`state`、`elements`、汎用ヘルパー（`showToast`, `escapeHtml` 等）、テーマ制御、ハートビート、ペインリサイズ、共通モーダル（ヘルプ・終了・スマホ連携） |
| `frontend/js/selection.js` | 複数選択、Shift範囲選択、選択差分DOM更新、右クリックメニュー、テイクアウト (take_out) 機能、サムネイル取得/更新 |
| `frontend/js/inspector.js` | 右ペイン、単一写真EXIF詳細、露出タグ、地図・MiniMap、GPS候補モーダル、一括タグ編集 |
| `frontend/js/lightbox.js` | 全画面プレビュー、ズーム・パン、スタック切替バー、フィルムストリップ、ライトボックス内タグ/評価 |
| `frontend/js/folder_tree.js` | 左ペイン階層フォルダツリー（遅延展開、ショートカット、接続/未接続分離、除外/通常切替、右クリックメニュー、パス直接入力、スキャン進捗、DBメンテナンスモーダル） |
| `frontend/js/location_tree.js` | 左ペインジオタグ階層ツリー（国 ＞ 都道府県 ＞ 市区町村） |
| `frontend/js/location_map.js` | 47都道府県 撮影制覇白地図（インラインSVG）・撮影密度ヒートマップ・撮影さんぽ軌跡ライン (`#locationMapModal`) |
| `frontend/js/lab.js` | 左ペイン「🧪 ラボ」セクション（太陽高度抽出・手ブレ注意・歴代の今日・未整理ガチャ）＆ 勝ちレンズ・得意設定カルテ (`#labKarteModal`) |
| `frontend/js/compare.js` | Side-by-Side 2枚並列比較ビュー（同期ズーム＆パン・トーナメント勝ち抜き選別・`V`キー） |
| `frontend/js/histogram.js` | オンデマンドRGB・輝度ヒストグラム（インスペクタ・ライトボックス・画像調整・2枚比較連動・`H`キー） |
| `frontend/js/adjust.js` | 非破壊画像調整モーダル（回転・水平傾き補正・アスペクト比クロップ・EV露出/コントラスト/彩度） |
| `frontend/js/takeout.js` | スマート・テイクアウト（高機能一括画像書き出し）＆ ベタ焼き（コンタクトシート）HTML出力 |
| `frontend/js/presets.js` | フィルタプリセットの保存・適用・チップ描画・削除 |
| `frontend/js/slideshow.js` | フルスクリーンスライドショービューア（ダブルバッファ切替、自動再生、シャッフル） |
| `frontend/js/sidebar_filters.js` | 左ペインのタイムライン（年月ツリー）、カメラ＆レンズ2階層ツリー（`[+]`/`[-]`排他検索）、フォルダ階層データ構築、階層タグツリー・12色カラーパレット管理 |
| `frontend/js/app.js` | コアオーケストレータ: 初期化、データ取得、写真グリッド段階チャンク描画、適用中フィルタチップ描画、評価・タグ更新、キーボードショートカット |
| `frontend/js/mobile.js` | スマホ専用画面（`mobile.html` / `/m`）のコントローラ: PC直結モード・WebAssembly (`sql.js`) ローカルDB直接読込モード、片手4段階選別、差分JSON出力/同期 |

### CSS モジュール (`frontend/css/` — カスケード順序通りに `<link>` 読込)
| スタイルシート | 役割・担当コンポーネント |
|---|---|
| `frontend/css/style.css` | テーマ変数（和紙 `paper` / 夜墨 `sumi`）、リセット、上部ヘッダーツールバー、左サイドバー（アコーディオン、タイムライン、フォルダツリー、タグツリー、カラーパレット） |
| `frontend/css/grid-lightbox.css` | メインコンテンツエリア、写真グリッド（標準・びっしり・マウント・クリーン表示）、スキャンモーダル、ライトボックス全画面ビュー |
| `frontend/css/selection-menu.css` | マルチ選択チェックボックス、右クリックコンテキストメニュー、下部フローティング選択バー |
| `frontend/css/inspector.css` | 右インスペクタ・ペイン、露出ブラケット・連写スタックバー、RAWバッジ、GPSミニマップ、評価フィルタトグル |
| `frontend/css/modals-features.css` | 保存済みプリセット、フルスクリーンスライドショー、AI自動タグ、ヘルプモーダル (`#helpModal`)、終了確認、グローバルスキャン進捗フッター、重複ドッグイヤー、場所ツリー、非破壊画像調整モーダル、スマート・テイクアウトモーダル |
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
| **UI要素 (HTML)** | `#photoGrid` (メインコンテナ), `#viewTitle`, `#photoCountBadge`, `#sortSelect`, `#layoutToggleBtn`, `#minimalToggleBtn` |
| **CSS** | `frontend/css/style.css` (`.photo-grid`, `.photo-card`, `.card-thumb`, `.card-badges`, `.card-rating`) |
| **フロントエンド (JS)** | `frontend/js/app.js`<br>・`fetchPhotos()`: APIから写真一覧を取得し `state.photos` へ格納<br>・`renderPhotoGrid()`: グリッド描画のメイン処理（差分更新、DOM構築）<br>・`createPhotoCard(photo, index)`: 1枚分のカードDOM要素を生成<br>・`setupPhotoGridDelegation()`: グリッド上のクリック/右クリック/ダブルクリックの委譲処理<br>・`setLayoutMode(mode)`: グリッドサイズ・密度切り替え<br>・`toggleMinimalView()`: 情報非表示の純粋写真一覧モード切替<br>・`removePhotoFromView(photoId)`: フィルタ外となった写真を全再描画せずDOMから差分除去 |
| **APIエンドポイント** | `GET /api/photos` (クエリ引数: `folder`, `recursive`, `search`, `rating`, `tags`, `sort`, `camera`, `year_month`, `connection`, `is_stacked`)<br>`GET /api/photo/{photo_id}/thumbnail` (サムネイル画像バイナリ)<br>`GET /api/thumbnails/batch` (複数サムネイルの一括取得) |
| **バックエンド (Python)** | `server/app.py`: `api_photos()` (`_fast_json()` で高速返却)<br>`server/database/photos.py`: `get_photos()` (動的SQL構築、`_directory_filter_sql` による範囲絞り込み)<br>`server/database/thumbnails.py`: `get_thumbnail()` (SQLite BLOB取得) |
| **関連ナレッジ** | `performance-optimization-patterns.md` (LIKE検索廃止と範囲比較、JSON高速化、BLOBサムネイル) |

---

## 2. 写真の選択と一括操作 (Selection & Batch Actions)

サムネイルの選択、範囲選択、コンテキストメニュー、一括操作バー、物理削除機能。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#selectionToolbar`, `#selectionCount`, `#contextMenu`, `#floatingBatchBar`, `#floatingDeleteBtn`, `#floatingClearSelectionBtn` |
| **フロントエンド (JS)** | `frontend/js/selection.js`<br>・`togglePhotoSelection(photoId, isCtrl)`: 単一・Ctrl追加選択<br>・`rangeSelectPhotos(targetPhotoId)`: Shiftクリックによる範囲選択<br>・`selectAllPhotos()` / `clearSelection()`: 全選択 / 選択解除<br>・`updateCardSelectionClasses()`: 前回選択差分（`lastSelectedPhotoIds`）のみDOM更新<br>・`openContextMenu(e, photoId)` / `closeContextMenu()`: 右クリックメニュー表示・位置計算<br>・`deleteSelectedPhotos()`: 選択中写真の物理削除（確認ダイアログ後実行） |
| **APIエンドポイント** | `DELETE /api/photo/{photo_id}` (単一写真の削除)<br>`POST /api/photos/batch-tags` (一括タグ追加/削除)<br>`POST /api/photos/batch-rate` (一括評価付与) |
| **バックエンド (Python)** | `server/app.py`: `api_delete_photo()`, `api_batch_tags()`, `api_batch_rate()`<br>`server/database/photos.py`: `delete_photo_by_id()`<br>`server/database/tags.py`: `batch_add_tag()`, `batch_remove_tag()` |

---

## 3. 評価・カラーラベル・階層タグ管理 (Rating, Labels & Tags)

Picasaスタイルの4段階評価（棄/可/良/優）、カラーラベル（5色）、階層タグ（`旅行/2026/京都` 形式）の付与・管理。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#tabPanel-tags`, `#tagListContainer`, `#sidebarRatingFilterToggles`, `#inspectorRatingBtns`, `#inspectorColorGrid`, `#inspectorTagList` |
| **フロントエンド (JS)** | `frontend/js/app.js`<br>・`updatePhotoRating(photoId, rating)`: 単一写真の評価更新<br>・`batchRateSelection(rating)`: 選択中写真の一括評価<br>・`handleColorFilterLeftClick(color)` / `RightClick`: カラーラベルによるAND/OR/除外フィルタ<br>・`buildTagTree(tags)` / `renderTagList()`: スラッシュ区切りの階層ツリー構築と表示（自然順ソート・数字昇順対応）<br>・`addTagToPhoto(photoId, tag)` / `removeTagFromPhoto(photoId, tag)`: 写真へのタグ付け<br>・`startInlineRename(li, tag)` / `deleteTagCompletely(tag)`: タグのリネームと全体削除<br>・ショートカットキー: `window.addEventListener('keydown')` 内の `0`〜`4`（評価付与）、`x`（棄却） |
| **APIエンドポイント** | `POST /api/photo/{photo_id}/rate`<br>`POST /api/photos/batch-rate`<br>`GET /api/tags`<br>`POST /api/photo/{photo_id}/tags`<br>`DELETE /api/photo/{photo_id}/tags/{tag:path}`<br>`PUT /api/tags/{tag:path}` (リネーム)<br>`DELETE /api/tags/{tag:path}` (一括完全削除) |
| **バックエンド (Python)** | `server/app.py`: `api_rate_photo()`, `api_batch_rate()`, `api_get_tags()`, `api_add_tag()`, `api_rename_tag()` 等<br>`server/database/photos.py`: `update_rating()`, `batch_update_rating()`<br>`server/database/tags.py`: `get_all_tags_summary()`, `add_tag_to_photo()`, `rename_tag()`, `delete_tag()` |

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
| **UI要素 (HTML)** | `#sidebarIndexTabs`, `#sidebarTabPanels`, `#tabPanel-quick`, `#tabPanel-timeline`, `#tabPanel-camera`, `#tabPanel-folder`, `#tabPanel-tags`, `#tabPanel-presets`, `#tabPanel-search` |
| **フロントエンド (JS)** | `frontend/js/sidebar_filters.js` & `frontend/js/app.js` & `frontend/js/presets.js`<br>・`initSidebarTabs()`: サイドバータブ切替<br>・`renderTimeline(timelineData)` / `toggleTimelineYearMonth()`: 撮影年月ツリーと絞り込み (`sidebar_filters.js`)<br>・`renderCameras(cameras)` / `cycleCameraFilterState()` / `cycleLensFilterState()`: カメラ＆レンズ2階層ツリーと排他絞り込み (`sidebar_filters.js`)<br>・`buildTagTree(tags)` / `renderTagList()`: 階層タグツリーと12色パレット (`sidebar_filters.js`)<br>・`renderFilterPresetsList()` / `applyFilterPreset()`: フィルタプリセットの保存・適用 (`presets.js`) |
| **APIエンドポイント** | `GET /api/timeline`<br>`GET /api/cameras`<br>`GET /api/folders`<br>`GET /api/locations/heatmap`<br>`GET /api/lab/karte`<br>`GET /api/lab/random-unrated-folder`<br>`POST /api/folders/open` (エクスプローラー起動)<br>`POST /api/folders/ignore` / `DELETE /api/folders/ignore` (除外管理)<br>`GET /api/filter-presets`, `POST /api/filter-presets` (プリセットCRUD) |
| **バックエンド (Python)** | `server/database/photos.py`: `get_photos()`, `get_location_tree_summary()`<br>`server/database/lab_analytics.py`: `get_location_heatmap_data()`, `get_lab_karte_data()`, `get_random_unrated_folder()`, `_normalize_jp_prefecture()`<br>`server/database/folders.py`: `get_timeline_summary()`, `get_cameras_summary()`, `get_folders_summary()`, `_directory_filter_sql()`<br>`server/database/presets.py`: `get_filter_presets()`, `create_filter_preset()` |

---

## 6. 右ペイン (インスペクター / 詳細・一括編集) (Inspector)

選択写真のEXIF詳細、ヒストグラム、地図・GPS情報、RAW連携、一括メタデータ編集。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#inspectorPane`, `#inspectorSingleView`, `#inspectorBatchView`, `#inspectorTabPaneExif`, `#inspectorTabPaneMap`, `#inspectorTabPaneTags`, `#gpsCandidateModal` |
| **フロントエンド (JS)** | `frontend/js/inspector.js`<br>・`toggleInspector(forceState)`: インスペクター開閉とレイアウト調整<br>・`updateInspectorView()`: 選択数に応じて単一/一括ビューを切り替え<br>・`showSingleInspector(photo)`: EXIF値（カメラ、レンズ、F値、SS、ISO、焦点距離）のフォーマット表示<br>・`showBatchInspector(photos)`: 複数選択時の一括タグ編集（色合い・新規タグ・タグツリー順、設定完了時の自動選択解除・フィルタ再適用）・一括評価<br>・`showGpsCandidateModal(photo)`: 近傍写真（時間・場所）からGPS座標をコピーするモーダル<br>・`openPhotoFolder(photoId)`: 写真をエクスプローラーで選択状態で表示 |
| **APIエンドポイント** | `GET /api/photo/{photo_id}`<br>`POST /api/photo/{photo_id}/open-raw` (関連RAWファイルを関連付けアプリで起動)<br>`POST /api/photo/{photo_id}/open-folder` (エクスプローラーでファイルを選択)<br>`GET /api/photo/{photo_id}/gps-candidates`<br>`POST /api/photo/{photo_id}/copy-gps` / `POST /api/photos/batch-copy-gps` |
| **バックエンド (Python)** | `server/app.py`: `api_open_raw()`, `api_open_folder()`, `api_gps_candidates()`, `api_copy_gps()`<br>`server/database/photos.py`: `update_photo_gps()`, `find_nearby_gps_photos()` |

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
| **フロントエンド (JS)** | `frontend/js/folder_tree.js`<br>・`renderFolderTree()` / `_ftFetchChildren()`: ショートカット・接続ドライブ・未接続セクションの遅延展開<br>・`_ftToggleFilter()`: 通常絞り込み / 除外絞り込み / 解除の3段切替<br>・`_ftShowContextMenu()`: 再スキャン、リフレッシュ（消去ファイルDB削除）、AI自動タグ、管理除外<br>・`_ftStartScan()` / `_ftPollScanProgress()`: スキャンリクエスト発行と下部進捗バー表示 |
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

## 11. 写真の送る機能・スマートテイクアウト & 非破壊画像微調整 (Smart Takeout & Non-Destructive Adjustments)

選択した写真を特定フォルダ（`take_out/` 配下や任意フォルダ）へコピー・リサイズ・Exif同期/選択消去・非破壊調整焼き込みして書き出す機能、および元画像非破壊での回転・水平出し・クロップ・トーン微調整機能。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | **テイクアウト**: `#smartTakeoutModal`, `#takeoutApplyAdjustments`, `#takeoutExifSyncDb`, `#takeoutExifRemoveAll`, `#takeoutExifRemoveGps`, `#contextImportSubmenu`, `#floatingImportBtn`<br>**画像調整**: `#imageAdjustModal`, `#adjustFineAngleRange`, `#adjustBrightnessRange`, `#adjustContrastRange`, `#adjustSaturationRange` |
| **フロントエンド (JS)** | `frontend/js/takeout.js`: スマートテイクアウト設定モーダル制御、`executeSmartTakeout()`<br>`frontend/js/adjust.js`: Twitter(X)風クロップ枠・8点ハンドル制御、水平出し（自動内接ズーム連動）・明るさ・コントラスト・彩度の0ms CSSリアルタイムプレビュー、`saveAdjustModal()`<br>`frontend/js/selection.js`: 簡易フォルダコピー書き出し |
| **APIエンドポイント** | `POST /api/export/smart` (スマートテイクアウト一括出力)<br>`POST /api/photo/{photo_id}/adjust` (回転・水平出し・クロップ・トーン微調整の非破壊保存)<br>`POST /api/photo/{photo_id}/reset-adjust` / `POST /api/photos/batch-reset-adjust`<br>`GET /api/photo/{photo_id}/view` (`?raw=1` で調整モーダル用無加工原画を返却) |
| **バックエンド (Python)** | `server/exporter.py`: `export_single_photo()`, `filter_exif_data()` (DBのGPS座標 `0x8825` 書き込み/消去・`Orientation` `0x0112` 正規化・Exif選択消去)<br>`server/scanner.py`: `apply_photo_adjustments_pil()` (90度回転・水平傾き補正＋自動内接矩形クロップ・自由クロップ・明るさ/コントラスト/彩度の一元処理パイプライン)、`refresh_photo_thumbnail_transform()`<br>`server/database/photos.py`: `update_photo_adjustments()`, `reset_photo_adjustments()` |

---

## 12. データベース管理 & ライフサイクル (Database, Performance & Lifecycle)

SQLite最適化、VACUUM、自動バックアップ、プロセス終了監視、ポータブルドライブ解決。

| 項目 | 内容 |
|---|---|
| **UI要素 (HTML)** | `#dbMaintenanceModal`, `#dbMaintVacuumBtn`, `#dbMaintBackupBtn`, `#dbMaintOpenBackupDirBtn`, `#shutdownModal` |
| **フロントエンド (JS)** | `frontend/js/folder_tree.js`<br>・`_ftInitDbMaintenanceModal()`: データベース統計取得（写真数、DBサイズ、WebPサムネイル数、空き領域）、VACUUM最適化、世代管理バックアップ、フォルダ起動<br>`frontend/js/common.js`<br>・`confirmShutdown()`: アプリ正常終了リクエスト発行<br>・`initPaneResize()`: 左右ペインのリサイズバー制御と `localStorage` 永続化 |
| **APIエンドポイント** | `POST /api/heartbeat`<br>`POST /api/shutdown`<br>`GET /api/version`<br>`GET /api/database/stats`<br>`POST /api/database/vacuum`<br>`POST /api/database/backup`<br>`GET /api/database/backups`<br>`POST /api/database/open-backup-dir`<br>`GET /api/volumes` |
| **バックエンド (Python)** | `server/heartbeat.py`: ブラウザ生存監視、自動シャットダウンタイマー<br>`server/database/connection.py`: SQLite接続・PRAGMA設定（WAL、cache_size、mmap_size）<br>`server/database/stats.py`: DBサイズ計算、VACUUM、タイムスタンプ付きバックアップ管理<br>`server/volume_info.py`: Windows VSN（ボリュームシリアル番号）取得<br>`server/scanner.py`: `resolve_portable_path()` (ドライブレター変動吸収) |
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
| **バックエンド (Python)** | `server/mobile_bundle.py`: `build_standalone_mobile_html()`, `ensure_standalone_mobile_html()`<br>`server/app.py`: `mobile_app_entry()`, `api_mobile_standalone()`, `api_mobile_info()`, `api_mobile_sync_import()`, `_sanitize_mobile_tag()`<br>`run.py`: `BIND_HOST = "0.0.0.0"` によるLAN内スマホ接続受付 |
| **関連ナレッジ** | `mobile-hybrid-architecture.md` |

---

## まとめ：機能改修時の基本チェックフロー

1. **画面UIや操作性を変えたい場合**:
   - `frontend/index.html` で対象要素の ID / クラス名を確認
   - `frontend/js/app.js` で該当の `render*` または イベントリスナー関数を改修
   - 必要に応じて `frontend/css/style.css` でスタイル調整
2. **データの絞り込み・取得速度・SQLを変えたい場合**:
   - `server/database/` 配下の該当モジュール（`photos.py`, `folders.py` 等）を改修
   - インデックスが効いているか、`_directory_filter_sql` を使っているか確認
3. **ファイル操作・RAW・スキャンを変えたい場合**:
   - `server/scanner.py` または `server/raw_loader.py` を改修
   - ポータブルパス（`resolve_portable_path`）を維持しているか確認
4. **改修後の必須手順**:
   - `VERSION` ファイル内の最終更新日時（`Updated: YYYY-MM-DD HH:MM`）の更新、および検証完了・コミット時のバージョン番号カウントアップ（`+0.01` またはユーザー指示値）
   - マニュアルの同期更新（`MANUAL.md` および `frontend/index.html` の `#helpModal`）
