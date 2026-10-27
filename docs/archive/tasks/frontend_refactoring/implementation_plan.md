# フロントエンドコード分割（リファクタリング）実装計画書

## 1. 目的と背景
- **課題**: `frontend/js/app.js` が 7,760 行（約 300 KB）に肥大化しており、AIエージェントによるコード理解・修正時のトークン消費やリグレッションリスクが高い。
- **目標**: 既存の機能を一切破壊せず（Zero Regression）、Vanilla JS の実行モデルを維持したまま、単一責務の独立モジュールへ段階的に安全に切り出す。

---

## 2. アーキテクチャ設計と安全担保の原則

### (1) ビルドツール不要の Vanilla JS 順次ロード方式
Node.js や Webpack/Vite などの外部ツールを一切使わない本プロジェクトのポータブル原則を順守する。
ブラウザの標準的な `<script src="...">` タグによる順次ロードを採用する。

```html
<!-- 1. 共通基盤: 定数, state, elements, 汎用ユーティリティ -->
<script src="/js/common.js?v=1.38"></script>

<!-- 2. 機能別モジュール: それぞれ単一責務で window またはグローバル関数を提供 -->
<script src="/js/selection.js?v=1.38"></script>
<script src="/js/inspector.js?v=1.38"></script>
<script src="/js/lightbox.js?v=1.38"></script>
<script src="/js/scanner_modal.js?v=1.38"></script>
<script src="/js/presets.js?v=1.38"></script>
<script src="/js/slideshow.js?v=1.38"></script>

<!-- 3. コアオーケストレータ: グリッド描画, サイドバー, 初期化, イベント配線 -->
<script src="/js/app.js?v=1.38"></script>
```

### (2) 安全担保の鉄則 (Zero Regression)
1. **関数シグネチャ・グローバル変数の維持**:
   - `state`, `elements` の構造はそのまま維持し、全モジュールから参照可能とする。
   - 関数名や引数は一切変更せず、既存の相互呼び出しがそのまま動作することを保証する。
2. **ステップバイステップの検証**:
   - 一度に全部分割するのではなく、モジュール単位で1つずつ切り出し、構文チェック（Syntax Check）およびブラウザ実行でのエラーが無いことを確認しながら進める。
3. **外科的変更の徹底**:
   - ロジックの「ついで改善」やリファクタリング（変数名変更など）は一切行わず、純粋な「ファイルの物理分割」に徹する。
4. **ブラウザキャッシュ対策**:
   - `<script src="/js/xxx.js?v=1.38">` のようにバージョンクエリを付与し、ブラウザキャッシュによる新旧スクリプト混在事故を防止する。

---

## 3. 分割フェーズ詳細

### フェーズ1: `common.js`（共通基盤・定数・状態管理・汎用関数）
- 切り出し対象:
  - 定数（`MAX_DISPLAY_PHOTOS`, `COLOR_TAG_MAP`）
  - `state` オブジェクト定義
  - `elements` キャッシュオブジェクト定義
  - 汎用ヘルパー（`escapeHtml`, `formatBytes`, `showToast`, `getPhotoExactTimestamp`, `getThumbnailUrl` 等）
  - テーマ制御（`initTheme`, `applyTheme`, `toggleTheme`）
  - ハートビート初期化（`initHeartbeat`）
  - ユーザー設定（`initUserSettings`）
  - バージョン表示（`initAppVersion`）
  - ペインリサイズ（`initPaneResize`）

### フェーズ2: `lightbox.js`（全画面・ズーム・フィルムストリップ）
- 切り出し対象（約1,100行）:
  - `openLightbox`, `closeLightbox`, `getCurrentLightboxPhoto`, `loadLightboxPhoto`, `updateLightboxContent`
  - ズーム・パン処理（`initLightboxZoomInteractions`, `applyLightboxTransform`, `resetLightboxZoom`, `showZoomBadge`）
  - スタック切替バー（`renderLightboxBracketBar`, `ensureStackMemberDetail`, `selectLightboxStackMember`, `navigateStackMember`, `switchLightboxStackMember`, `openLightboxForStackMember`）
  - ライトボックス内タグ・評価（`renderLightboxTags`, `addTagToCurrentPhoto`, `removeTagFromCurrentPhoto`, `promoteTagForPhoto`, `triggerAiTagForSinglePhoto`, `updateLightboxRating`）
  - フィルムストリップ（`initFilmstripInteractions`, `renderFilmstrip`, `scrollToActiveFilmstrip`, `updateFilmstripActive`）

### フェーズ3: `inspector.js`（右ペイン詳細・EXIF・GPS）
- 切り出し対象（約1,000行）:
  - `toggleInspector`, `updateInspectorView`, `switchInspectorTab`, `openPhotoFolder`, `renderExposureTags`
  - `showSingleInspector`, `showBatchInspector`
  - インスペクター内タグ操作（`renderInspectorTagChips`, `renderInspectorQuickTree`, `renderInspectorColorPalette`, `addTagToPhoto`, `removeTagFromPhoto`, `batchToggleTagWithoutClearing`, `batchRemoveTagFromSelection`）
  - GPS候補モーダル・近傍照合（`showGpsCandidateModal`）

### フェーズ4: `selection.js`（複数選択・コンテキストメニュー）
- 切り出し対象（約600行）:
  - `clearShiftPreview`, `updateShiftPreview`, `togglePhotoSelection`, `rangeSelectPhotos`, `selectAllPhotos`, `clearSelection`, `updateCardSelectionClasses`, `updateSelectionUI`
  - 写真右クリックメニュー（`openContextMenu`, `closeContextMenu`, `deleteSelectedPhotos`）
  - フォルダ右クリックメニュー（`openFolderContextMenu`, `closeFolderContextMenu`）
  - コンテキスト・フローティングバーからの送る/タグ/評価一括操作（`loadAndRenderContextImportSubmenu`, `importSelectedPhotos`, `createNewImportFolderAndImport`, `openImportFolderInExplorer`, `renderContextTagSubmenu`, `batchAddTagToSelection`, `batchRateSelection`, `applyRatingToSelection`）

### フェーズ5: `scanner_modal.js`（スキャンモーダル・フォルダブラウザ・DBメンテ）
- 切り出し対象（約600行）:
  - `loadScanModalFolders`, `executeScan`, `renderScanProgress`, `startScanProgressPolling`, `stopScanProgressPolling`
  - フォルダツリーブラウザ（`loadFolderBrowser`, `normalizeFolderPath`）
  - AIタグ進捗ポーリング（`renderAiProgress`, `startAiProgressPolling`, `stopAiProgressPolling`）
  - DBメンテナンス（`loadDatabaseStats`）
  - アプリ終了確認モーダル（`openShutdownModal`, `closeShutdownModal`, `confirmShutdown`）
  - ヘルプモーダル（`openHelpModal`, `closeHelpModal`, `toggleHelpModal`）

### 最終的な `app.js`（オーケストレータ・コア）
- 残るもの（約1,500行にスリム化！）:
  - アプリ初期化（`initializeApp`, `refreshAll`）
  - データフェッチ（`fetchPhotos`, `fetchTags`, `fetchTimeline`, `fetchFolders`, `fetchCameras`）
  - サイドバー各ビューの描画（`renderTimeline`, `renderCameras`, `renderFolders`, `renderTagList`）
  - メイン写真グリッド描画（`renderPhotoGrid`, `createPhotoCard`, `setupPhotoGridDelegation`, `removePhotoFromView`, `updateCardRatingDirectly`）
  - フィルタ操作（`setFilter`, `resetAllFilters`, `updateRatingFilterUI`, `setConnectionFilter`）
  - メインイベントリスナー配線（`setupEventListeners`）

---

## 4. 検証手順
1. **構文チェック**:
   Node.js は使わないが、ブラウザ（Edge/Chrome）の `--app` モードおよびブラウザコンソールにて SyntaxError が 0 件であることを確認。
2. **動作検証**:
   - 写真グリッド表示・ソート・フィルタ
   - 複数選択（Ctrl/Shift）および一括評価
   - ライトボックス開閉、ズーム、矢印キー移動、スタック切替
   - 右ペインインスペクターでのEXIF表示、タグ付け
   - スキャンモーダル起動・フォルダブラウズ
   - スライドショー起動・停止
