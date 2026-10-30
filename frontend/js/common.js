/**
 * Photo Manager - 共通基盤 & ユーティリティ (Common Foundation)
 * 全モジュールで共有される定数、アプリケーション状態 (state)、DOM要素参照 (elements)、
 * 汎用ヘルパー関数、テーマ制御、ハートビート、ペインリサイズを管理する。
 */

// localStorage が利用できない環境（ブラウザ設定・ストレージ制限等）でも起動不能にならないよう、
// アクセス時に例外が出る場合はメモリ上の代替ストレージへ差し替える（全モジュールの直接呼び出しを一括で保護）
(function ensureSafeLocalStorage() {
  try {
    const probeKey = '__pm_storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
  } catch (err) {
    console.warn('[WARN] localStorage が利用できないため、メモリ上の代替ストレージで動作します:', err);
    const memoryStore = new Map();
    const fallbackStorage = {
      getItem: (key) => (memoryStore.has(String(key)) ? memoryStore.get(String(key)) : null),
      setItem: (key, value) => { memoryStore.set(String(key), String(value)); },
      removeItem: (key) => { memoryStore.delete(String(key)); },
      clear: () => { memoryStore.clear(); },
      key: (index) => Array.from(memoryStore.keys())[index] ?? null,
      get length() { return memoryStore.size; },
    };
    try {
      Object.defineProperty(window, 'localStorage', { value: fallbackStorage, configurable: true });
    } catch (defineErr) {
      console.warn('[WARN] 代替ストレージの適用に失敗しました:', defineErr);
    }
  }
})();

// アプリケーション全体の定数 (0 = 表示上限なし)
const MAX_DISPLAY_PHOTOS = 0;

// カラータグ定義マッピング (カラーコーディング ＆ パレット上部集約用)
const COLOR_TAG_MAP = {
  '赤': { label: '赤', color: '#dc2626', bg: '#dc2626', border: '#b91c1c', text: '#ffffff', shadow: true },
  '青': { label: '青', color: '#2563eb', bg: '#2563eb', border: '#1d4ed8', text: '#ffffff', shadow: true },
  '緑': { label: '緑', color: '#16a34a', bg: '#16a34a', border: '#15803d', text: '#ffffff', shadow: true },
  '黄色': { label: '黄', color: '#eab308', bg: '#eab308', border: '#ca8a04', text: '#0f172a', shadow: false },
  '黒': { label: '黒', color: '#18181b', bg: '#18181b', border: '#3f3f46', text: '#f8fafc', shadow: true },
  '白': { label: '白', color: '#ffffff', bg: '#ffffff', border: '#cbd5e1', text: '#0f172a', shadow: false },
  '銀・シルバー': { label: '銀', color: '#94a3b8', bg: 'linear-gradient(135deg, #f8fafc 0%, #cbd5e1 50%, #94a3b8 100%)', border: '#94a3b8', text: '#0f172a', shadow: false },
  '金・ゴールド': { label: '金', color: '#ca8a04', bg: 'linear-gradient(135deg, #fef08a 0%, #eab308 50%, #ca8a04 100%)', border: '#ca8a04', text: '#1c1917', shadow: false },
  '茶色': { label: '茶', color: '#854d0e', bg: '#854d0e', border: '#713f12', text: '#ffffff', shadow: true },
  '紫': { label: '紫', color: '#9333ea', bg: '#9333ea', border: '#7e22ce', text: '#ffffff', shadow: true },
  'オレンジ': { label: '橙', color: '#ea580c', bg: '#ea580c', border: '#c2410c', text: '#ffffff', shadow: true },
  'ピンク': { label: '桃', color: '#db2777', bg: '#db2777', border: '#be185d', text: '#ffffff', shadow: true }
};

// アプリケーション全体の状態管理
const state = {
  photos: [],
  filteredPhotos: [],
  currentFilter: { type: 'all', value: null },
  ratingFilter: new Set([0, 1, 2]),  // デフォルト: 棄(-1)を除く全て (優・良・可: [0, 1, 2])
  searchQuery: '',
  sortBy: 'date_taken DESC',
  currentPhotoIndex: -1,
  currentRotation: 0,
  currentLightboxStackPhotos: [], // ライトボックス内で開いているスタックの全写真リスト
  currentLightboxStackIndex: -1,  // ライトボックス内で表示中のスタック内インデックス
  currentLightboxStackType: null, // ライトボックス内のスタック種別 ('burst' | 'bracket' | 'duplicate' | null)
  lightboxZoom: 1.0,              // 現在のズーム倍率 (1.0 = フィット)
  lightboxPanX: 0,                // パン移動量 X (px)
  lightboxPanY: 0,                // パン移動量 Y (px)
  isLightboxPanning: false,       // ドラッグ中フラグ
  lightboxPanStartX: 0,
  lightboxPanStartY: 0,
  viewMode: 'grid',         // 'grid' | 'masonry' | 'mount'
  isMinimalView: false,     // 情報表示ON/OFF (クリーンモード)
  tagFilters: new Map(),    // タグ名 -> 'include' | 'exclude' (3ステート排他管理)
  tagAndRoots: new Set(),   // 同グループ内の [+] タグを OR(既定) から AND('かつ') に切り替えたルート名集合
  tagInterGroupMode: 'and', // 異グループ間のタグ文節結合モード ('and' = かつ[既定] | 'or' = または)
  untaggedOnly: false,      // 未分類写真フィルタ
  onlineOnly: false,        // 接続中の写真のみ表示フィルタ (後方互換)
  connectionFilter: 'all',  // 'all' | 'online' | 'offline' (接続中 / 未接続フィルタ)
  availableTags: [],        // 利用可能なタグ一覧
  selectedYearMonths: new Set(), // タイムライン複数選択（OR条件）用Set
  expandedTimelineYears: new Set(), // 展開されたタイムライン年集合 (デフォルトはすべて閉じた状態)
  selectedCameras: new Set(),    // カメラ機種複数選択（OR条件）用Set (後方互換)
  cameraFilters: new Map(),      // カメラ名 -> 'include' | 'exclude' (3ステート管理)
  lensFilters: new Map(),        // "CameraModel::LensModel" または "LensModel" -> 'include' | 'exclude'
  expandedCameras: new Set(),    // 展開されたカメラツリー機種名集合
  selectedLenses: new Set(),     // レンズ選択（OR条件）用Set
  availableCameras: [],          // 利用可能なカメラ機種一覧
  selectedPhotoIds: new Set(), // マルチ選択中の写真IDセット
  lastSelectedIndex: -1,       // Shift範囲選択用インデックス
  selectionBaseIds: null,      // Shift範囲選択開始前のベース選択Set
  isSidebarOpen: localStorage.getItem('pm_sidebar_open') !== 'false', // 左ペイン（サイドバー）の表示状態
  isInspectorOpen: true,       // 右ペイン（インスペクタ）の表示状態
  activeInspectorPhotoId: null,// インスペクタに表示中の単一写真ID
  activeLocation: null,        // 場所ツリーフィルタ ({ country, state, city, label, no_location })
  isStacked: true,             // 露出ブラケット・連写のスタック表示 (ON/OFF)
  expandedTagPaths: new Set(), // 展開されたタグツリーのパス集合 (デフォルトはすべて閉じた状態)
  rawFoldersData: [],          // フォルダデータのキャッシュ
  isLimitReached: false,
  activePresetId: null,
  filterPresets: [],       // 表示上限に達したかどうか
  tagSourceFilter: 'manual',  // タグ種別フィルタ ('manual' | 'ai' | 'all')
  tagSearchQuery: '',      // タグ一覧のテキスト検索クエリ (Enter確定)
  tagSortMode: (localStorage.getItem('pm_tag_sort_mode_v2') && localStorage.getItem('pm_tag_sort_mode_v2') !== 'count_desc')
    ? localStorage.getItem('pm_tag_sort_mode_v2')
    : 'natural', // タグツリーの名前順ルール ('natural' | 'natural_desc' | 'lexical' | 'lexical_desc')
  tagSortByCount: localStorage.getItem('pm_tag_sort_by_count_v2') === 'true', // 左ペイン: 写真枚数が多い順トグル (ON: 枚数順 / OFF: tagSortModeに従う)
  inspectorTagSortByCount: localStorage.getItem('pm_inspector_tag_sort_by_count') === 'true', // 右インスペクタ: 独立した枚数順トグル
  settingsTagSortByCount: false, // 設定モーダル内タグツリーエディタ: 独立した枚数順トグル

  settingsTagTreeExpandedPaths: new Set(), // 設定モーダル内タグツリーエディタの展開パス集合
  inspectorActiveTab: localStorage.getItem('pm_inspector_tab') || 'tags', // インスペクタの選択中タブ ('tags' | 'exif' | 'map')
  labFilter: null,             // ラボフィルタ ('shake_risk' | 'golden_hour' | 'blue_hour' | 'magic_all' | 'night' | null)
  onThisDay: null,             // 歴代の今日フィルタ ('MM-DD' | null)
  focalRange: null,            // 焦点距離帯フィルタ ('ultra_wide' | 'wide' | 'standard' | 'short_tele' | 'telephoto' | 'super_tele' | null)
  focalRangeLabel: null,       // 焦点距離帯の表示ラベル
  apertureRange: null,         // F値帯フィルタ ('f1_4' | 'f2_0' | 'f2_8' | 'f4_0' | 'f5_6' | 'f8_0' | 'f11_plus' | null)
  apertureRangeLabel: null,    // F値帯の表示ラベル
  attrFilter: 'all',           // 属性フィルタ ('all' | 'raw' | 'adjusted' | 'jpeg' | 'raw_pair' | 'xmp')
  selectionAnchorIndex: -1,    // Shift+矢印キー範囲選択の起点インデックス
  copiedToneAdjustments: null, // コピー済みのトーン調整値 ({ brightness, contrast, saturation })
};



// DOM要素参照キャッシュ
const elements = {
  // ヘッダー
  searchInput: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  thumbnailSizeSlider: document.getElementById('thumbnailSizeSlider'),
  sortBySelect: document.getElementById('sortBySelect'),
  openHelpModalBtn: document.getElementById('openHelpModalBtn'),
  openMobileModalBtn: document.getElementById('openMobileModalBtn'),
  mobileConnectModal: document.getElementById('mobileConnectModal'),
  closeMobileModalBtn: document.getElementById('closeMobileModalBtn'),
  closeMobileModalFooterBtn: document.getElementById('closeMobileModalFooterBtn'),
  mobileUrlsContainer: document.getElementById('mobileUrlsContainer'),
  mobileDbSizeLabel: document.getElementById('mobileDbSizeLabel'),
  mobileDetectedSyncBox: document.getElementById('mobileDetectedSyncBox'),
  mobileDetectedSyncDesc: document.getElementById('mobileDetectedSyncDesc'),
  applyDetectedMobileSyncBtn: document.getElementById('applyDetectedMobileSyncBtn'),
  openMobilePreviewWindowBtn: document.getElementById('openMobilePreviewWindowBtn'),
  pickMobileSyncFileBtn: document.getElementById('pickMobileSyncFileBtn'),
  mobileSyncFileInput: document.getElementById('mobileSyncFileInput'),
  openShutdownModalBtn: document.getElementById('openShutdownModalBtn'),
  shutdownModal: document.getElementById('shutdownModal'),
  closeShutdownModalBtn: document.getElementById('closeShutdownModalBtn'),
  btnCancelShutdown: document.getElementById('btnCancelShutdown'),
  btnConfirmShutdown: document.getElementById('btnConfirmShutdown'),
  // タグ完全削除確認モーダル
  deleteTagModal: document.getElementById('deleteTagModal'),
  deleteTagModalTagName: document.getElementById('deleteTagModalTagName'),
  deleteTagModalPhotoCountDesc: document.getElementById('deleteTagModalPhotoCountDesc'),
  closeDeleteTagModalBtn: document.getElementById('closeDeleteTagModalBtn'),
  btnCancelDeleteTag: document.getElementById('btnCancelDeleteTag'),
  btnConfirmDeleteTag: document.getElementById('btnConfirmDeleteTag'),
  // フォルダ管理登録確認モーダル (v2.02)
  registerFolderModal: document.getElementById('registerFolderModal'),
  registerFolderModalName: document.getElementById('registerFolderModalName'),
  registerFolderModalPath: document.getElementById('registerFolderModalPath'),
  registerFolderModalCount: document.getElementById('registerFolderModalCount'),
  closeRegisterFolderModalBtn: document.getElementById('closeRegisterFolderModalBtn'),
  btnCancelRegisterFolder: document.getElementById('btnCancelRegisterFolder'),
  btnDirectRegisterFolder: document.getElementById('btnDirectRegisterFolder'),
  btnRecursiveRegisterFolder: document.getElementById('btnRecursiveRegisterFolder'),
  toggleInfoBtn: document.getElementById('toggleInfoBtn'),
  infoToggleLabel: document.getElementById('infoToggleLabel'),
  uploadFilesBtn: document.getElementById('uploadFilesBtn'),
  fileUploadInput: document.getElementById('fileUploadInput'),
  dragDropOverlay: document.getElementById('dragDropOverlay'),
  modeButtons: document.querySelectorAll('.mode-btn'),
  // コンテキストメニュー & 下部選択バー
  contextMenu: document.getElementById('contextMenu'),
  contextMenuSelectedCount: document.getElementById('contextMenuSelectedCount'),
  contextTagSubmenu: document.getElementById('contextTagSubmenu'),
  contextTagTreeContainer: document.getElementById('contextTagTreeContainer'),
  contextNewTagInput: document.getElementById('contextNewTagInput'),
  contextConfirmNewTagBtn: document.getElementById('contextConfirmNewTagBtn'),
  contextMenuImportItem: document.getElementById('contextMenuImportItem'),
  contextImportSubmenu: document.getElementById('contextImportSubmenu'),
  contextNewImportFolderInput: document.getElementById('contextNewImportFolderInput'),
  contextConfirmNewImportFolderBtn: document.getElementById('contextConfirmNewImportFolderBtn'),
  contextOpenImportFolderBtn: document.getElementById('contextOpenImportFolderBtn'),
  contextImportFolderList: document.getElementById('contextImportFolderList'),
  contextMenuRefreshThumbItem: document.getElementById('contextMenuRefreshThumbItem'),
  contextMenuRefreshThumbLabel: document.getElementById('contextMenuRefreshThumbLabel'),
  contextMenuPreviewItem: document.getElementById('contextMenuPreviewItem'),
  contextMenuDeleteItem: document.getElementById('contextMenuDeleteItem'),
  contextMenuClearSelection: document.getElementById('contextMenuClearSelection'),
  // フォルダ専用コンテキストメニュー
  folderContextMenu: document.getElementById('folderContextMenu'),
  folderContextMenuPath: document.getElementById('folderContextMenuPath'),
  folderMenuManagedGroup: document.getElementById('folderMenuManagedGroup'),
  folderMenuUnmanagedGroup: document.getElementById('folderMenuUnmanagedGroup'),
  folderMenuIgnoredGroup: document.getElementById('folderMenuIgnoredGroup'),
  folderMenuRescanDirect: document.getElementById('folderMenuRescanDirect'),
  folderMenuRescanRecursive: document.getElementById('folderMenuRescanRecursive'),
  folderMenuRefresh: document.getElementById('folderMenuRefresh'),
  folderMenuAiTag: document.getElementById('folderMenuAiTag'),
  folderMenuUnmanage: document.getElementById('folderMenuUnmanage'),
  folderMenuIgnoreFromManaged: document.getElementById('folderMenuIgnoreFromManaged'),
  folderMenuAddAndScan: document.getElementById('folderMenuAddAndScan'),
  folderMenuIgnoreFromUnmanaged: document.getElementById('folderMenuIgnoreFromUnmanaged'),
  folderMenuUnignore: document.getElementById('folderMenuUnignore'),
  folderMenuAddFromIgnored: document.getElementById('folderMenuAddFromIgnored'),
  folderMenuOpenExplorer: document.getElementById('folderMenuOpenExplorer'),
  folderWarningBanner: document.getElementById('folderWarningBanner'),
  warningBannerDesc: document.getElementById('warningBannerDesc'),
  warningBannerReloadBtn: document.getElementById('warningBannerReloadBtn'),
  appVersion: document.getElementById('appVersion'),
  // サイドバー
  sidebar: document.getElementById('sidebar'),
  toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
  sidebarToggleLabel: document.getElementById('sidebarToggleLabel'),
  sidebarIndexTabs: document.getElementById('sidebarIndexTabs'),
  timelineTree: document.getElementById('timelineTree'),
  timelineList: document.getElementById('timelineList'),
  cameraList: document.getElementById('cameraList'),
  folderList: document.getElementById('folderList'),
  folderAutoAiToggleBtn: document.getElementById('folderAutoAiToggleBtn'),
  folderDbMaintenanceBtn: document.getElementById('folderDbMaintenanceBtn'),
  folderScanProgressCard: document.getElementById('folderScanProgressCard'),
  folderScanProgressTitle: document.getElementById('folderScanProgressTitle'),
  folderScanProgressCount: document.getElementById('folderScanProgressCount'),
  folderScanProgressFill: document.getElementById('folderScanProgressFill'),
  folderScanProgressCurrent: document.getElementById('folderScanProgressCurrent'),
  globalScanBanner: document.getElementById('globalScanBanner'),
  globalScanTitle: document.getElementById('globalScanTitle'),
  globalScanCount: document.getElementById('globalScanCount'),
  globalScanFill: document.getElementById('globalScanFill'),
  globalScanFilename: document.getElementById('globalScanFilename'),
  folderPathInput: document.getElementById('folderPathInput'),
  folderPathScanBtn: document.getElementById('folderPathScanBtn'),
  dbMaintenanceModal: document.getElementById('dbMaintenanceModal'),
  closeDbMaintenanceModalBtn: document.getElementById('closeDbMaintenanceModalBtn'),
  closeDbMaintenanceFooterBtn: document.getElementById('closeDbMaintenanceFooterBtn'),
  settingStartupWindowModeSelect: document.getElementById('settingStartupWindowModeSelect'),
  settingTagSortModeSelect: document.getElementById('settingTagSortModeSelect'),
  settingsTagExpandAllBtn: document.getElementById('settingsTagExpandAllBtn'),
  settingsTagCollapseAllBtn: document.getElementById('settingsTagCollapseAllBtn'),
  settingsTagRootDropZone: document.getElementById('settingsTagRootDropZone'),
  settingsTagTreeContainer: document.getElementById('settingsTagTreeContainer'),
  settingsNewRootTagInput: document.getElementById('settingsNewRootTagInput'),
  settingsAddRootTagBtn: document.getElementById('settingsAddRootTagBtn'),
  dbMaintPhotoCount: document.getElementById('dbMaintPhotoCount'),
  dbMaintDbSize: document.getElementById('dbMaintDbSize'),
  dbMaintThumbCount: document.getElementById('dbMaintThumbCount'),
  dbMaintWalSize: document.getElementById('dbMaintWalSize'),
  dbMaintVacuumBtn: document.getElementById('dbMaintVacuumBtn'),
  dbMaintBackupInfoText: document.getElementById('dbMaintBackupInfoText'),
  dbMaintBackupBtn: document.getElementById('dbMaintBackupBtn'),
  dbMaintOpenBackupDirBtn: document.getElementById('dbMaintOpenBackupDirBtn'),
  totalPhotosCount: document.getElementById('totalPhotosCount'),
  untaggedNavItem: document.getElementById('untaggedNavItem'),
  untaggedPhotosCount: document.getElementById('untaggedPhotosCount'),
  onlineOnlyNavItem: document.getElementById('onlineOnlyNavItem'),
  offlineOnlyNavItem: document.getElementById('offlineOnlyNavItem'),
  unlinkedOnlyNavItem: document.getElementById('unlinkedOnlyNavItem'),
  unlinkedPhotosCount: document.getElementById('unlinkedPhotosCount'),
  duplicatesOnlyNavItem: document.getElementById('duplicatesOnlyNavItem'),
  duplicatePhotosCount: document.getElementById('duplicatePhotosCount'),
  folderTreeUnlinkedSection: document.getElementById('folderTreeUnlinkedSection'),
  folderTreeUnlinkedItem: document.getElementById('folderTreeUnlinkedItem'),
  folderTreeUnlinkedCount: document.getElementById('folderTreeUnlinkedCount'),
  purgeUnlinkedBtn: document.getElementById('purgeUnlinkedBtn'),
  tagSection: document.getElementById('tagSection'),
  tagAccordionHeader: document.getElementById('tagAccordionHeader'),
  tagAccordionArrow: document.getElementById('tagAccordionArrow'),
  openAddTagInputBtn: document.getElementById('openAddTagInputBtn'),
  inlineTagCreate: document.getElementById('inlineTagCreate'),
  newTagNameInput: document.getElementById('newTagNameInput'),
  confirmCreateTagBtn: document.getElementById('confirmCreateTagBtn'),
  cancelCreateTagBtn: document.getElementById('cancelCreateTagBtn'),
  colorPaletteSection: document.getElementById('colorPaletteSection'),
  colorPaletteHeader: document.getElementById('colorPaletteHeader'),
  colorPaletteBody: document.getElementById('colorPaletteBody'),
  colorPaletteArrow: document.getElementById('colorPaletteArrow'),
  colorSwatchGrid: document.getElementById('colorSwatchGrid'),
  colorPaletteActiveCount: document.getElementById('colorPaletteActiveCount'),
  tagSearchBox: document.getElementById('tagSearchBox'),
  tagSearchInput: document.getElementById('tagSearchInput'),
  clearTagSearchBtn: document.getElementById('clearTagSearchBtn'),
  tagList: document.getElementById('tagList'),
  clearTagFiltersBtn: document.getElementById('clearTagFiltersBtn'),
  tagSortByCountToggleBtn: document.getElementById('tagSortByCountToggleBtn'),
  tagTypeSegmentedControl: document.getElementById('tagTypeSegmentedControl'),
  // メインエリア
  viewTitle: document.getElementById('viewTitle'),
  currentCountBadge: document.getElementById('currentCountBadge'),
  ratingFilterToggles: document.getElementById('ratingFilterToggles'),
  photoGrid: document.getElementById('photoGrid'),
  emptyState: document.getElementById('emptyState'),
  emptyStateActionBtn: document.getElementById('emptyStateActionBtn'),
  // ヘルプモーダル (操作マニュアル)
  helpModal: document.getElementById('helpModal'),
  closeHelpModalBtn: document.getElementById('closeHelpModalBtn'),
  closeHelpModalFooterBtn: document.getElementById('closeHelpModalFooterBtn'),
  helpNavTabs: document.getElementById('helpNavTabs'),
  // ライトボックス (プレビューモーダル)
  lightboxModal: document.getElementById('lightboxModal'),
  lightboxFileName: document.getElementById('lightboxFileName'),
  lightboxMeta: document.getElementById('lightboxMeta'),
  lightboxPrimaryBtn: document.getElementById('lightboxPrimaryBtn'),
  lightboxRatingWidget: document.getElementById('lightboxRatingWidget'),
  lightboxRotateLeftBtn: document.getElementById('lightboxRotateLeftBtn'),
  rotateBtn: document.getElementById('rotateBtn'),
  lightboxAdjustBtn: document.getElementById('lightboxAdjustBtn'),
  toggleExifBtn: document.getElementById('toggleExifBtn'),
  closeLightboxBtn: document.getElementById('closeLightboxBtn'),
  prevPhotoBtn: document.getElementById('prevPhotoBtn'),
  nextPhotoBtn: document.getElementById('nextPhotoBtn'),
  imageStage: document.getElementById('imageStage'),
  lightboxZoomBadge: document.getElementById('lightboxZoomBadge'),
  lightboxImage: document.getElementById('lightboxImage'),
  exifDrawer: document.getElementById('exifDrawer'),
  filmstrip: document.getElementById('filmstrip'),
  // EXIF詳細セル
  exifFileName: document.getElementById('exifFileName'),
  exifFormat: document.getElementById('exifFormat'),
  exifRawPairRow: document.getElementById('exifRawPairRow'),
  exifRawPair: document.getElementById('exifRawPair'),
  exifDateTaken: document.getElementById('exifDateTaken'),
  exifCamera: document.getElementById('exifCamera'),
  exifLensRow: document.getElementById('exifLensRow'),
  exifLens: document.getElementById('exifLens'),
  exifExposureRow: document.getElementById('exifExposureRow'),
  exifExposureParams: document.getElementById('exifExposureParams'),
  exifFocalRow: document.getElementById('exifFocalRow'),
  exifFocalLength: document.getElementById('exifFocalLength'),
  exifDimensions: document.getElementById('exifDimensions'),
  exifFileSize: document.getElementById('exifFileSize'),
  exifPath: document.getElementById('exifPath'),
  photoTagsContainer: document.getElementById('photoTagsContainer'),
  lightboxNewTagInput: document.getElementById('lightboxNewTagInput'),
  lightboxAddTagBtn: document.getElementById('lightboxAddTagBtn'),
  lightboxAiTagBtn: document.getElementById('lightboxAiTagBtn'),
  // 右インスペクタ・ペイン
  toggleInspectorBtn: document.getElementById('toggleInspectorBtn'),
  inspectorToggleLabel: document.getElementById('inspectorToggleLabel'),
  inspectorPane: document.getElementById('inspectorPane'),
  inspectorBody: document.getElementById('inspectorBody'),
  closeInspectorBtn: document.getElementById('closeInspectorBtn'),
  inspectorTitle: document.getElementById('inspectorTitle'),
  inspectorSingleView: document.getElementById('inspectorSingleView'),
  inspectorBatchView: document.getElementById('inspectorBatchView'),
  inspectorFixedPreview: document.getElementById('inspectorFixedPreview'),
  inspectorPreviewWrapper: document.getElementById('inspectorPreviewWrapper'),
  inspectorThumb: document.getElementById('inspectorThumb'),
  inspectorOpenFolderBtn: document.getElementById('inspectorOpenFolderBtn'),
  inspectorOpenFileBtn: document.getElementById('inspectorOpenFileBtn'),
  inspectorRatingBtns: document.getElementById('inspectorRatingBtns'),
  inspectorQuickExif: document.getElementById('inspectorQuickExif'),
  quickExifDate: document.getElementById('quickExifDate'),
  quickExifRes: document.getElementById('quickExifRes'),
  quickExifGear: document.getElementById('quickExifGear'),
  quickExifPills: document.getElementById('quickExifPills'),
  inspectorTabsNav: document.getElementById('inspectorTabsNav'),
  inspectorTabGpsDot: document.getElementById('inspectorTabGpsDot'),
  inspectorTagCount: document.getElementById('inspectorTagCount'),
  inspectorTagList: document.getElementById('inspectorTagList'),
  inspectorColorPaletteBlock: document.getElementById('inspectorColorPaletteBlock'),
  inspectorColorHeader: document.getElementById('inspectorColorHeader'),
  inspectorColorArrow: document.getElementById('inspectorColorArrow'),
  inspectorColorActiveCount: document.getElementById('inspectorColorActiveCount'),
  inspectorColorBody: document.getElementById('inspectorColorBody'),
  inspectorColorGrid: document.getElementById('inspectorColorGrid'),
  inspectorNewTagInput: document.getElementById('inspectorNewTagInput'),
  inspectorAddTagBtn: document.getElementById('inspectorAddTagBtn'),
  inspectorQuickTree: document.getElementById('inspectorQuickTree'),
  inspectorAiTagBlock: document.getElementById('inspectorAiTagBlock'),
  inspectorAiTagHeader: document.getElementById('inspectorAiTagHeader'),
  inspectorAiTagArrow: document.getElementById('inspectorAiTagArrow'),
  inspectorAiTagBody: document.getElementById('inspectorAiTagBody'),
  inspectorAiTagBtn: document.getElementById('inspectorAiTagBtn'),
  inspectorFileName: document.getElementById('inspectorFileName'),
  inspectorFormat: document.getElementById('inspectorFormat'),
  inspectorRawPairRow: document.getElementById('inspectorRawPairRow'),
  inspectorRawPairPath: document.getElementById('inspectorRawPairPath'),
  inspectorOpenRawBtn: document.getElementById('inspectorOpenRawBtn'),
  inspectorDateTaken: document.getElementById('inspectorDateTaken'),
  inspectorCamera: document.getElementById('inspectorCamera'),
  inspectorLensRow: document.getElementById('inspectorLensRow'),
  inspectorLens: document.getElementById('inspectorLens'),
  inspectorExposureRow: document.getElementById('inspectorExposureRow'),
  inspectorExposureParams: document.getElementById('inspectorExposureParams'),
  inspectorFocalLengthRow: document.getElementById('inspectorFocalLengthRow'),
  inspectorFocalLength: document.getElementById('inspectorFocalLength'),
  inspectorDimensions: document.getElementById('inspectorDimensions'),
  inspectorFileSize: document.getElementById('inspectorFileSize'),
  inspectorPathRow: document.getElementById('inspectorPathRow'),
  inspectorPathLabel: document.getElementById('inspectorPathLabel'),
  inspectorPath: document.getElementById('inspectorPath'),
  inspectorVolumeRow: document.getElementById('inspectorVolumeRow'),
  inspectorVolumeLabel: document.getElementById('inspectorVolumeLabel'),
  inspectorVolume: document.getElementById('inspectorVolume'),
  // GPS
  inspectorGpsRow: document.getElementById('inspectorGpsRow'),
  inspectorGpsVal: document.getElementById('inspectorGpsVal'),
  inspectorLocationRow: document.getElementById('inspectorLocationRow'),
  inspectorLocationVal: document.getElementById('inspectorLocationVal'),
  inspectorMiniMap: document.getElementById('inspectorMiniMap'),
  inspectorGpsBtnBar: document.getElementById('inspectorGpsBtnBar'),
  inspectorClearGpsBtn: document.getElementById('inspectorClearGpsBtn'),
  inspectorGpsActions: document.getElementById('inspectorGpsActions'),
  inspectorCopyGpsBtn: document.getElementById('inspectorCopyGpsBtn'),
  // インスペクタ一括編集
  batchCountBadge: document.getElementById('batchCountBadge'),
  batchThumbnailsStrip: document.getElementById('batchThumbnailsStrip'),
  batchRateButtons: document.getElementById('batchRateButtons'),
  batchGpsSection: document.getElementById('batchGpsSection'),
  batchInferGpsBtn: document.getElementById('batchInferGpsBtn'),
  batchClearGpsBtn: document.getElementById('batchClearGpsBtn'),
  batchNewTagInput: document.getElementById('batchNewTagInput'),
  batchAddTagBtn: document.getElementById('batchAddTagBtn'),
  batchColorPaletteBlock: document.getElementById('batchColorPaletteBlock'),
  batchColorHeader: document.getElementById('batchColorHeader'),
  batchColorArrow: document.getElementById('batchColorArrow'),
  batchColorActiveCount: document.getElementById('batchColorActiveCount'),
  batchColorBody: document.getElementById('batchColorBody'),
  batchColorGrid: document.getElementById('batchColorGrid'),
  batchQuickTree: document.getElementById('batchQuickTree'),

  batchCommonTagsList: document.getElementById('batchCommonTagsList'),
  batchClearSelectionBtn: document.getElementById('batchClearSelectionBtn'),


  // 露出ブラケット・スタック
  toggleStackBtn: document.getElementById('toggleStackBtn'),
  stackToggleLabel: document.getElementById('stackToggleLabel'),
  inspectorBracketSection: document.getElementById('inspectorBracketSection'),
  inspectorBracketLabel: document.getElementById('inspectorBracketLabel'),
  inspectorBracketTypeBadge: document.getElementById('inspectorBracketTypeBadge'),
  inspectorBracketList: document.getElementById('inspectorBracketList'),
  inspectorBracketExpanderBtn: document.getElementById('inspectorBracketExpanderBtn'),
  lightboxBracketBar: document.getElementById('lightboxBracketBar'),
  lightboxBracketBarLabel: document.getElementById('lightboxBracketBarLabel'),
  lightboxBracketPills: document.getElementById('lightboxBracketPills'),
  // テーマ切替（和紙 ⇄ 夜墨）
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  themeToggleIcon: document.getElementById('themeToggleIcon'),
  themeToggleLabel: document.getElementById('themeToggleLabel'),
  // 撮影日時一括シフト補正モーダル & 詳細属性フィルタ
  contextMenuShiftDateItem: document.getElementById('contextMenuShiftDateItem'),
  dateShiftModal: document.getElementById('dateShiftModal'),
  closeDateShiftModalBtn: document.getElementById('closeDateShiftModalBtn'),
  cancelDateShiftModalBtn: document.getElementById('cancelDateShiftModalBtn'),
  dateShiftTargetCount: document.getElementById('dateShiftTargetCount'),
  dateShiftDirection: document.getElementById('dateShiftDirection'),
  dateShiftDays: document.getElementById('dateShiftDays'),
  dateShiftHours: document.getElementById('dateShiftHours'),
  dateShiftMinutes: document.getElementById('dateShiftMinutes'),
  dateShiftSeconds: document.getElementById('dateShiftSeconds'),
  dateShiftPresetGroup: document.getElementById('dateShiftPresetGroup'),
  dateShiftPreviewList: document.getElementById('dateShiftPreviewList'),
  dateShiftResetOrigBtn: document.getElementById('dateShiftResetOrigBtn'),
  dateShiftSubmitBtn: document.getElementById('dateShiftSubmitBtn'),
  attrSubFilterSelect: document.getElementById('attrSubFilterSelect'),
};



/**
 * 写真の撮影時刻を高精度タイムスタンプ（秒単位 float、ミリ秒・サブセック含む）として取得する
 */
function getPhotoExactTimestamp(p) {
  if (!p) return 0;
  let sec = 0;
  if (p.date_taken) {
    const str = String(p.date_taken).trim();
    // 'YYYY:MM:DD HH:MM:SS' または 'YYYY-MM-DD HH:MM:SS' または 'YYYY-MM-DDTHH:MM:SS'
    const m = str.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
      const ms = dt.getTime();
      if (!isNaN(ms)) {
        sec = ms / 1000.0;
      }
    }
  }

  // ファイル名からの推測 (PXL_20260913_055922075 など)
  if (sec === 0 && p.file_name) {
    const m = String(p.file_name).match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})?/);
    if (m) {
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
      const ms = dt.getTime();
      if (!isNaN(ms)) {
        sec = ms / 1000.0;
        if (m[7]) {
          sec += parseFloat(`0.${m[7]}`);
        }
      }
    }
  }

  // サブセック（ミリ秒・小数秒）の加算
  if (p.subsec_time != null && p.subsec_time !== '') {
    const subStr = String(p.subsec_time).trim();
    if (subStr) {
      const subVal = parseFloat(`0.${subStr}`);
      if (!isNaN(subVal)) {
        sec += subVal;
      }
    }
  }
  return sec;
}

/**
 * 写真オブジェクトにサーバー側で焼き込み配信すべき非破壊調整（クロップ・水平出し・トーン微調整）があるか判定する
 */
function hasBakedViewAdjustments(photo) {
  if (!photo) return false;
  const hasCrop = Boolean(
    photo.crop_w && photo.crop_h &&
    (photo.crop_w < 0.999 || photo.crop_h < 0.999 || (photo.crop_x || 0) > 0.001 || (photo.crop_y || 0) > 0.001)
  );
  const hasAngle = Math.abs(Number(photo.fine_angle) || 0) > 0.01;
  const hasTone = Boolean((photo.brightness || 0) !== 0 || (photo.contrast || 0) !== 0 || (photo.saturation || 0) !== 0);
  return hasCrop || hasAngle || hasTone;
}

/**
 * 写真オブジェクトからキャッシュバスター付きサムネイルURLを生成
 * （回転・水平出し・クロップ・トーン微調整・同一IDの別写真キャッシュ汚染を完全に防止）
 */
function getThumbnailUrl(photo) {
  if (!photo) return '';
  const rot = photo.rotation || 0;
  const fa = Math.round((Number(photo.fine_angle) || 0) * 10);
  const mtime = Math.floor(photo.file_mtime || 0);
  const crop = photo.crop_w
    ? `${Math.round((photo.crop_x || 0) * 1000)}_${Math.round((photo.crop_y || 0) * 1000)}_${Math.round(photo.crop_w * 1000)}_${Math.round((photo.crop_h || 0) * 1000)}`
    : '0';
  const tone = `${photo.brightness || 0}_${photo.contrast || 0}_${photo.saturation || 0}`;
  const bust = photo._thumbBust ? `_${photo._thumbBust}` : '';
  const ver = `${photo.file_size || photo.id}_${mtime}_r${rot}_fa${fa}_c${crop}_t${tone}${bust}`;
  return `/api/photo/${photo.id}/thumbnail?v=${ver}`;
}

/**
 * 写真オブジェクトからキャッシュバスター付き拡大プレビューURLを生成
 * （RAWフルサイズ更新・非破壊調整の反映・同一IDのキャッシュ汚染を完全に防止）
 */
function getPhotoViewUrl(photo) {
  if (!photo) return '';
  const baseVer = `${photo.file_size || 0}_${Math.floor(photo.file_mtime || 0)}`;
  if (hasBakedViewAdjustments(photo)) {
    const rot = photo.rotation || 0;
    const fa = Math.round((Number(photo.fine_angle) || 0) * 10);
    const crop = photo.crop_w
      ? `${Math.round((photo.crop_x || 0) * 1000)}_${Math.round((photo.crop_y || 0) * 1000)}_${Math.round(photo.crop_w * 1000)}_${Math.round((photo.crop_h || 0) * 1000)}`
      : '0';
    const tone = `${photo.brightness || 0}_${photo.contrast || 0}_${photo.saturation || 0}`;
    const bust = photo._thumbBust ? `_${photo._thumbBust}` : '';
    return `/api/photo/${photo.id}/view?v=${baseVer}_r${rot}_fa${fa}_c${crop}_t${tone}${bust}`;
  }
  return `/api/photo/${photo.id}/view?v=${baseVer}`;
}

/**
 * 写真オブジェクトのDBメタデータ（サムネイル寸法・元寸法・回転・クロップ）から
 * プレースホルダおよびカードレイアウト用の正確な表示アスペクト比情報を算出する。
 * - thumbnails テーブルの thumb_width / thumb_height は scanner.py で既に EXIF Orientation・rotation・crop が反映済みのため二重回転させない。
 * - サムネイル未生成（またはクライアント上で回転・クロップ直後）の場合は width / height に対して rotation と crop_w / crop_h を適用して算出する。
 */
function getPhotoAspectInfo(photo) {
  let w = 0;
  let h = 0;
  if (photo && photo.thumb_width > 0 && photo.thumb_height > 0) {
    w = photo.thumb_width;
    h = photo.thumb_height;
  } else if (photo && photo.width > 0 && photo.height > 0) {
    w = photo.width;
    h = photo.height;
    if (photo.rotation === 90 || photo.rotation === 270) {
      const tmp = w;
      w = h;
      h = tmp;
    }
    if (photo.crop_w > 0 && photo.crop_h > 0) {
      w = Math.max(1, Math.round(w * photo.crop_w));
      h = Math.max(1, Math.round(h * photo.crop_h));
    }
  }
  if (w > 0 && h > 0) {
    const ratio = Math.max(0.2, Math.min(5.0, w / h));
    return {
      width: w,
      height: h,
      isPortrait: h > w,
      aspectCss: `${w} / ${h}`,
      aspectRatio: ratio.toFixed(4),
    };
  }
  return {
    width: 3,
    height: 2,
    isPortrait: false,
    aspectCss: '3 / 2',
    aspectRatio: '1.5000',
  };
}

/**
 * テーマ切り替え管理（Hinomaru Ink: 和紙モード ⇄ 夜墨モード）
 */
function initTheme() {
  const savedTheme = localStorage.getItem('pm_hinomaru_theme') || 'paper';
  applyTheme(savedTheme);

  if (elements.themeToggleBtn) {
    elements.themeToggleBtn.addEventListener('click', toggleTheme);
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  localStorage.setItem('pm_hinomaru_theme', theme);

  if (elements.themeToggleIcon && elements.themeToggleLabel) {
    if (theme === 'paper') {
      elements.themeToggleIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      elements.themeToggleLabel.textContent = '和紙';
      elements.themeToggleBtn.title = '夜墨（ダーク）モードに切り替え';
    } else {
      elements.themeToggleIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      elements.themeToggleLabel.textContent = '夜墨';
      elements.themeToggleBtn.title = '和紙（ライト）モードに切り替え';
    }
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'paper';
  const nextTheme = current === 'paper' ? 'sumi' : 'paper';
  applyTheme(nextTheme);
}

/**
 * 定期ハートビート（生存信号）の送信
 * ブラウザが開いている間、3秒間隔でサーバーへ生存を通知。
 * すべてのタブ/ウィンドウが閉じられると通信が途絶え、サーバー側で自動停止する。
 */
let _lastSeenMobileSyncSeq = null;

/**
 * クライアント側 JavaScript API で可能な範囲でウィンドウモードを即時反映する（Win32 API とのハイブリッド補完）
 * @param {string} mode - 'maximized' | 'remember' | 'center' | 'left_half' | 'right_half' | 'fullscreen'
 * @param {boolean} isUserGesture - ユーザー操作（セレクトボックス変更など）による呼び出しかどうか
 */
function applyClientWindowMode(mode, isUserGesture = false) {
  try {
    const availW = window.screen.availWidth || 1920;
    const availH = window.screen.availHeight || 1040;
    const availLeft = typeof window.screen.availLeft === 'number' ? window.screen.availLeft : 0;
    const availTop = typeof window.screen.availTop === 'number' ? window.screen.availTop : 0;

    if (mode === 'fullscreen') {
      if (isUserGesture && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      return;
    }

    // フルスクリーン以外のモードで現在 DOM フルスクリーン中なら解除
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }

    if (mode === 'remember') {
      return;
    }

    if (mode === 'maximized') {
      window.moveTo(availLeft, availTop);
      window.resizeTo(availW, availH);
    } else if (mode === 'center') {
      const targetW = Math.max(960, Math.round(availW * 0.8));
      const targetH = Math.max(680, Math.round(availH * 0.82));
      const x = availLeft + Math.round((availW - targetW) / 2);
      const y = availTop + Math.round((availH - targetH) / 2);
      window.resizeTo(targetW, targetH);
      window.moveTo(x, y);
    } else if (mode === 'left_half') {
      const halfW = Math.round(availW / 2);
      window.resizeTo(halfW, availH);
      window.moveTo(availLeft, availTop);
    } else if (mode === 'right_half') {
      const halfW = Math.round(availW / 2);
      window.resizeTo(availW - halfW, availH);
      window.moveTo(availLeft + halfW, availTop);
    }
  } catch (e) {
    // 通常タブ等でのリサイズ制限時はバックエンド Win32 API に委ねる
  }
}
window.applyClientWindowMode = applyClientWindowMode;

/**
 * 起動時に設定されたウィンドウモード（最大化 / 前回記憶 / 画面中央 / 左半分 / 右半分 / フルスクリーン）を適用する
 */
function ensureStartupWindowMaximized() {
  if (sessionStorage.getItem('pm_window_maximized')) return;

  fetch('/api/window/settings')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const mode = (data && data.startup_mode) || localStorage.getItem('pm_startup_window_mode') || 'maximized';
      localStorage.setItem('pm_startup_window_mode', mode);
      sessionStorage.setItem('pm_window_maximized', '1');

      if (mode === 'remember') {
        return;
      }

      if (mode === 'maximized') {
        const triggerMaximize = () => {
          const isNotMaximized =
            window.outerWidth < window.screen.availWidth * 0.95 ||
            window.outerHeight < window.screen.availHeight * 0.9;
          if (isNotMaximized) {
            applyClientWindowMode('maximized', false);
            fetch('/api/window/maximize', { method: 'POST' }).catch(() => {});
          }
        };
        triggerMaximize();
        setTimeout(triggerMaximize, 250);
        setTimeout(triggerMaximize, 800);
      } else {
        // クライアント側リサイズ + バックエンド Win32 API で正確に適用
        applyClientWindowMode(mode, false);
        fetch('/api/window/maximize', { method: 'POST' }).catch(() => {});
      }
    })
    .catch(() => {
      sessionStorage.setItem('pm_window_maximized', '1');
    });
}

function initHeartbeat() {
  ensureStartupWindowMaximized();

  const sendHeartbeat = () => {
    fetch('/api/heartbeat', { method: 'POST' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || typeof data.mobile_sync_seq !== 'number') return;
        if (_lastSeenMobileSyncSeq === null) {
          _lastSeenMobileSyncSeq = data.mobile_sync_seq;
        } else if (data.mobile_sync_seq > _lastSeenMobileSyncSeq) {
          _lastSeenMobileSyncSeq = data.mobile_sync_seq;
          const cnt = data.mobile_sync_applied || 0;
          showToast(`スマホから ${cnt} 件の選別・タグ変更が自動反映されました`, 'success', 5000);
          if (typeof refreshAll === 'function') {
            refreshAll();
          }
        }
      })
      .catch(() => {
        // サーバー停止時などのネットワークエラーは無視
      });
  };

  // 起動時に初回送信
  sendHeartbeat();

  // 3秒間隔で定期送信
  setInterval(sendHeartbeat, 3000);

  // ウィンドウ再フォーカス時や可視化時にも即座に送信
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sendHeartbeat();
  });
  window.addEventListener('focus', sendHeartbeat);
}

async function initAppVersion() {
  if (!elements.appVersion) return;
  try {
    const res = await fetch('/api/version');
    if (res.ok) {
      const data = await res.json();
      if (data.version) {
        elements.appVersion.textContent = `v${data.version}`;
        if (data.updated_at) {
          elements.appVersion.title = `v${data.version} (最終更新: ${data.updated_at})`;
        }
      }
    }
  } catch (e) {
    // 取得失敗時はHTML内の初期値を維持
  }
}


/**
 * モダンなトースト通知を表示
 */
function showToast(message, type = 'info', durationMs = 3500) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast-message toast-${type}`;
  const icon = type === 'success' ? '✓' : type === 'warning' ? '!' : type === 'error' ? '×' : 'i';
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  // 表示アニメーション
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) {
        container.remove();
      }
    }, 300);
  }, durationMs);
}

/**
 * ユーティリティ: HTMLエスケープ
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
const escapeAttr = escapeHtml;
const _escHtml = escapeHtml;
const _escAttr = escapeHtml;
window.escapeHtml = escapeHtml;
window.escapeAttr = escapeHtml;
window._escHtml = escapeHtml;
window._escAttr = escapeHtml;

/**
 * ユーティリティ: ファイルサイズ表記変換
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ==========================================================================
// ペインリサイズ機能
// ==========================================================================
function initPaneResize() {
  const sidebar = document.querySelector('.sidebar');
  const inspector = document.getElementById('inspectorPane');
  const handleLeft = document.getElementById('resizeHandleLeft');
  const handleRight = document.getElementById('resizeHandleRight');
  const drawerPanels = document.querySelector('.sidebar-tab-panels');
  const drawerHandle = document.getElementById('drawerResizeHandle');

  // 右インスペクタの保存済み幅を復元
  const savedInspectorWidth = localStorage.getItem('pm_inspector_width');
  if (savedInspectorWidth && inspector) inspector.style.width = savedInspectorWidth + 'px';

  // サイドバー / ドロワーパネルの幅設定＆保存ヘルパー
  function setSidebarPanelWidth(panelWidth) {
    const minW = 220;
    const maxW = 600;
    panelWidth = Math.max(minW, Math.min(maxW, Math.round(panelWidth)));
    const totalWidth = panelWidth + 52;

    document.documentElement.style.setProperty('--sidebar-panel-width', panelWidth + 'px');
    document.documentElement.style.setProperty('--sidebar-pinned-width', totalWidth + 'px');
    if (sidebar) {
      sidebar.style.setProperty('--sidebar-panel-width', panelWidth + 'px');
      sidebar.style.setProperty('--sidebar-pinned-width', totalWidth + 'px');
      if (sidebar.classList.contains('is-pinned')) {
        sidebar.style.width = totalWidth + 'px';
      }
    }
    localStorage.setItem('pm_sidebar_panel_width', panelWidth);
    localStorage.setItem('pm_sidebar_pinned_width', totalWidth);
  }

  // 保存済みパネル幅の復元
  let savedPanelWidth = parseInt(localStorage.getItem('pm_sidebar_panel_width'), 10);
  if (!savedPanelWidth) {
    const savedPinned = parseInt(localStorage.getItem('pm_sidebar_pinned_width'), 10);
    if (savedPinned) {
      savedPanelWidth = Math.max(220, savedPinned - 52);
    } else {
      savedPanelWidth = 320;
    }
  }
  // 1. 左サイドバーのリサイズ（アコーディオンサイドバー）
  if (handleLeft && sidebar) {
    // 保存済みサイドバー幅の復元
    const savedSidebarWidth = localStorage.getItem('pm_sidebar_width') || localStorage.getItem('pm_sidebar_pinned_width');
    if (savedSidebarWidth) {
      const w = Math.max(200, Math.min(600, parseInt(savedSidebarWidth, 10)));
      sidebar.style.width = w + 'px';
      document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    }

    handleLeft.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebar.getBoundingClientRect().width;
      handleLeft.classList.add('active');
      document.body.classList.add('resizing');

      function onMouseMove(e) {
        const delta = e.clientX - startX;
        const minW = parseInt(getComputedStyle(sidebar).minWidth) || 200;
        const maxW = parseInt(getComputedStyle(sidebar).maxWidth) || 600;
        const newWidth = Math.max(minW, Math.min(maxW, Math.round(startWidth + delta)));
        sidebar.style.width = newWidth + 'px';
        document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px');
      }

      function onMouseUp() {
        handleLeft.classList.remove('active');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        const finalW = Math.round(sidebar.getBoundingClientRect().width);
        localStorage.setItem('pm_sidebar_width', finalW);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // 2. ドロワー展開時: ドロワーパネル右端リサイズハンドル
  if (drawerHandle && drawerPanels) {
    drawerHandle.addEventListener('mousedown', (e) => {
      if (sidebar && sidebar.classList.contains('is-pinned')) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = drawerPanels.getBoundingClientRect().width;
      drawerHandle.classList.add('active');
      document.body.classList.add('resizing');

      function onMouseMove(e) {
        const delta = e.clientX - startX;
        const newPanelWidth = startWidth + delta;
        setSidebarPanelWidth(newPanelWidth);
      }

      function onMouseUp() {
        drawerHandle.classList.remove('active');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // 3. 右インスペクタのリサイズ
  if (handleRight && inspector) {
    handleRight.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = inspector.getBoundingClientRect().width;
      handleRight.classList.add('active');
      document.body.classList.add('resizing');

      function onMouseMove(e) {
        const delta = e.clientX - startX;
        const minW = parseInt(getComputedStyle(inspector).minWidth) || 160;
        const maxW = parseInt(getComputedStyle(inspector).maxWidth) || 550;
        const newWidth = Math.max(minW, Math.min(maxW, startWidth - delta));
        inspector.style.width = newWidth + 'px';
      }

      function onMouseUp() {
        handleRight.classList.remove('active');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        localStorage.setItem('pm_inspector_width', Math.round(inspector.getBoundingClientRect().width));
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

/**
 * 左ペイン（サイドバー）の表示・非表示をトグル
 * @param {boolean} [forcedState] - 強制的に設定する開閉状態
 */
function toggleSidebar(forcedState) {
  state.isSidebarOpen = (forcedState !== undefined) ? forcedState : !state.isSidebarOpen;
  const sidebar = elements.sidebar || document.getElementById('sidebar');
  const toggleBtn = elements.toggleSidebarBtn || document.getElementById('toggleSidebarBtn');
  const resizeHandle = document.getElementById('resizeHandleLeft');

  if (sidebar) {
    sidebar.classList.toggle('is-collapsed', !state.isSidebarOpen);
    sidebar.classList.remove('is-overlay-open');
  }
  if (typeof window.syncSidebarRailActiveState === 'function') {
    window.syncSidebarRailActiveState();
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', state.isSidebarOpen);
    toggleBtn.setAttribute('aria-expanded', state.isSidebarOpen ? 'true' : 'false');
  }
  if (resizeHandle) {
    resizeHandle.style.display = state.isSidebarOpen ? 'block' : 'none';
  }
  localStorage.setItem('pm_sidebar_open', state.isSidebarOpen ? 'true' : 'false');

  // グリッドのリサイズ追従（仮想スクロールやMasonryの再計算）
  window.dispatchEvent(new Event('resize'));
}
window.toggleSidebar = toggleSidebar;

// ============================================================
// 操作マニュアル & ヘルプモーダル制御
// ============================================================
function openHelpModal() {
  if (elements.helpModal) elements.helpModal.style.display = 'flex';
}

function closeHelpModal() {
  if (elements.helpModal) elements.helpModal.style.display = 'none';
}

function toggleHelpModal() {
  if (!elements.helpModal) return;
  if (elements.helpModal.style.display === 'flex') {
    closeHelpModal();
  } else {
    openHelpModal();
  }
}

// ============================================================
// アプリ終了確認モーダル制御 (Photo Manager Shutdown)
// ============================================================
let isShuttingDownGracefully = false;

function openShutdownModal() {
  if (elements.shutdownModal) {
    elements.shutdownModal.style.display = 'flex';
  }
}

function closeShutdownModal() {
  if (elements.shutdownModal) {
    elements.shutdownModal.style.display = 'none';
  }
}

// サーバー停止＆終了の実行
async function confirmShutdown() {
  isShuttingDownGracefully = true;
  const btn = elements.btnConfirmShutdown;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '停止処理中...';
  }
  showToast('サーバーを停止しています...', 'info');

  try {
    await fetch('/api/shutdown', { method: 'POST' });
  } catch (e) {
    // サーバー即座停止による切断エラーは正常
  }

  showToast('サーバーを停止しました。ウィンドウを閉じます。', 'success');

  setTimeout(() => {
    window.close();
    // ブラウザセキュリティ制限で window.close() がブロックされた場合のフォールバック案内
    const body = document.querySelector('.shutdown-modal-body');
    if (body) {
      body.innerHTML = `
        <div style="text-align: center; padding: 24px 0;">
          <div style="font-size: 2.8rem; margin-bottom: 14px; font-weight: 700; color: var(--danger, #ef4444);">!</div>
          <h3 style="font-size: 1.15rem; font-weight: 700; color: var(--text-main); margin-bottom: 8px;">サーバーは正常に停止しました</h3>
          <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">このブラウザタブまたはウィンドウを閉じてください。<br>次回は <strong>PhotoManager.exe</strong> から一瞬で起動できます。</p>
        </div>
      `;
    }
  }, 500);
}

// ============================================================
// タグ完全削除確認モーダル制御 (Delete Tag Modal)
// ============================================================
let _pendingDeleteTagResolve = null;

function showDeleteTagModal(tagName, photoCount = 0) {
  return new Promise((resolve) => {
    const modalEl = elements.deleteTagModal || document.getElementById('deleteTagModal');
    const tagNameEl = elements.deleteTagModalTagName || document.getElementById('deleteTagModalTagName');
    const descEl = elements.deleteTagModalPhotoCountDesc || document.getElementById('deleteTagModalPhotoCountDesc');
    const cancelBtnEl = elements.btnCancelDeleteTag || document.getElementById('btnCancelDeleteTag');

    if (!modalEl) {
      // モーダル要素が存在しない場合は標準 confirm に安全フォールバック
      const countMsg = photoCount > 0
        ? `\n\n※ ${photoCount} 枚の写真からこのタグ（およびその子孫タグ）が削除されます。`
        : '\n\n※ このタグ（およびその子孫タグ）が全写真から削除されます。';
      resolve(window.confirm(`タグ「${tagName}」を全体から削除しますか？${countMsg}\n※ 写真ファイル自体は削除されません。`));
      return;
    }

    _pendingDeleteTagResolve = resolve;

    if (tagNameEl) {
      tagNameEl.textContent = tagName;
    }
    if (descEl) {
      if (photoCount > 0) {
        descEl.textContent = `${photoCount} 枚の写真からこのタグ（およびその子孫タグ）が完全に除去されます。`;
      } else {
        descEl.textContent = `このタグ（およびその子孫タグ）がライブラリ内の全写真から完全に除去されます。`;
      }
    }

    modalEl.style.display = 'flex';
    if (cancelBtnEl) {
      cancelBtnEl.focus();
    }
  });
}

function closeDeleteTagModal(confirmed = false) {
  const modalEl = elements.deleteTagModal || document.getElementById('deleteTagModal');
  if (modalEl) {
    modalEl.style.display = 'none';
  }
  if (_pendingDeleteTagResolve) {
    _pendingDeleteTagResolve(confirmed);
    _pendingDeleteTagResolve = null;
  }
}
window.showDeleteTagModal = showDeleteTagModal;
window.closeDeleteTagModal = closeDeleteTagModal;

// ============================================================
// フォルダ管理登録確認モーダル制御 (Register Folder Modal v2.02)
// ============================================================
let _pendingRegisterFolderResolve = null;

function showRegisterFolderModal(folderPath, folderName, fileCount = 0) {
  return new Promise((resolve) => {
    if (!elements.registerFolderModal) {
      const countMsg = fileCount > 0 ? ` (ファイル数: ${fileCount.toLocaleString()}枚)` : '';
      const choice = confirm(`管理外のフォルダです。子フォルダも含めて登録しますか？${countMsg}\n（OK: 子フォルダを含む / キャンセル: 中止）`);
      resolve(choice ? 'recursive' : null);
      return;
    }

    _pendingRegisterFolderResolve = resolve;

    if (elements.registerFolderModalName) {
      elements.registerFolderModalName.textContent = folderName || folderPath;
    }
    if (elements.registerFolderModalPath) {
      elements.registerFolderModalPath.textContent = folderPath;
    }
    if (elements.registerFolderModalCount) {
      elements.registerFolderModalCount.textContent = fileCount > 0
        ? `直下の画像ファイル数: ${fileCount.toLocaleString()} 枚`
        : '直下の画像ファイル: なし（子フォルダに写真がある場合があります）';
    }

    elements.registerFolderModal.style.display = 'flex';
    if (elements.btnRecursiveRegisterFolder) {
      elements.btnRecursiveRegisterFolder.focus();
    }
  });
}

function closeRegisterFolderModal(choice = null) {
  if (elements.registerFolderModal) {
    elements.registerFolderModal.style.display = 'none';
  }
  if (_pendingRegisterFolderResolve) {
    _pendingRegisterFolderResolve(choice);
    _pendingRegisterFolderResolve = null;
  }
}
window.showRegisterFolderModal = showRegisterFolderModal;
window.closeRegisterFolderModal = closeRegisterFolderModal;

// ============================================================
// スマホ（Android）連携 & オフライン差分同期モーダル制御
// ============================================================
function closeMobileSyncResultModal() {
  const modal = document.getElementById('mobileSyncResultModal');
  if (modal) modal.style.display = 'none';
}
window.closeMobileSyncResultModal = closeMobileSyncResultModal;

function showMobileSyncResultModal(resultData, sourceLabel = 'mobile_sync.json', isAutoStartup = false) {
  const modal = document.getElementById('mobileSyncResultModal');
  if (!modal) return;

  const appliedCount = Number((resultData && resultData.applied_count) || 0);
  const skippedCount = Number((resultData && resultData.skipped_count) || 0);
  const items = Array.isArray(resultData && resultData.applied_items) ? resultData.applied_items : [];

  const subtitleEl = document.getElementById('mobileSyncResultSubtitle');
  const bannerEl = document.getElementById('mobileSyncResultBanner');
  const iconEl = document.getElementById('mobileSyncResultIcon');
  const headlineEl = document.getElementById('mobileSyncResultHeadline');
  const metaEl = document.getElementById('mobileSyncResultMeta');
  const listWrapEl = document.getElementById('mobileSyncResultListWrap');
  const listEl = document.getElementById('mobileSyncResultList');
  const okBtn = document.getElementById('closeMobileSyncResultOkBtn');

  if (subtitleEl) {
    subtitleEl.textContent = isAutoStartup
      ? 'USBメモリ内の選別データ (mobile_sync.json) を起動時に自動検出して取り込みました'
      : `選択されたデータ（${sourceLabel}）をPCライブラリへ取り込みました`;
  }

  if (appliedCount > 0) {
    if (bannerEl) {
      bannerEl.style.background = 'rgba(22, 163, 74, 0.14)';
      bannerEl.style.borderColor = 'rgba(34, 197, 94, 0.45)';
    }
    if (iconEl) iconEl.textContent = '✓';
    if (headlineEl) {
      headlineEl.textContent = `${appliedCount} 枚の写真にスマホでの選別結果を反映しました！`;
    }
  } else {
    if (bannerEl) {
      bannerEl.style.background = 'rgba(245, 158, 11, 0.14)';
      bannerEl.style.borderColor = 'rgba(245, 158, 11, 0.45)';
    }
    if (iconEl) iconEl.textContent = '!';
    if (headlineEl) {
      headlineEl.textContent = '反映対象の写真が見つかりませんでした（0件更新）';
    }
  }

  if (metaEl) {
    const metaParts = [`取り込み元: ${sourceLabel}`];
    if (skippedCount > 0) {
      metaParts.push(`未照合スキップ: ${skippedCount}件`);
    }
    metaEl.textContent = metaParts.join(' ／ ');
  }

  if (listWrapEl && listEl) {
    if (items.length > 0) {
      listWrapEl.style.display = 'flex';
      const rateLabelMap = {
        2: '<span style="background:rgba(225,77,42,0.22); color:#fb923c; border:1px solid rgba(225,77,42,0.45); border-radius:4px; padding:1px 6px; font-weight:700; font-size:0.76rem;">優 (Ex)</span>',
        1: '<span style="background:rgba(59,130,246,0.22); color:#60a5fa; border:1px solid rgba(59,130,246,0.45); border-radius:4px; padding:1px 6px; font-weight:700; font-size:0.76rem;">良 (Gd)</span>',
        0: '<span style="background:rgba(148,163,184,0.18); color:var(--text-muted, #94a3b8); border:1px solid rgba(148,163,184,0.35); border-radius:4px; padding:1px 6px; font-weight:600; font-size:0.76rem;">可 (Nm)</span>',
        '-1': '<span style="background:rgba(239,68,68,0.22); color:#f87171; border:1px solid rgba(239,68,68,0.45); border-radius:4px; padding:1px 6px; font-weight:700; font-size:0.76rem;">棄 (Rj)</span>',
      };

      listEl.innerHTML = items
        .map((it) => {
          const badges = [];
          if (it.rating !== undefined && it.rating !== null && rateLabelMap[String(it.rating)]) {
            badges.push(rateLabelMap[String(it.rating)]);
          }
          if (Array.isArray(it.add_tags)) {
            for (const t of it.add_tags) {
              badges.push(
                `<span style="background:rgba(34,197,94,0.16); color:#4ade80; border-radius:4px; padding:1px 6px; font-size:0.74rem;">＋ #${escapeHtml(t)}</span>`
              );
            }
          }
          if (Array.isArray(it.remove_tags)) {
            for (const t of it.remove_tags) {
              badges.push(
                `<span style="background:rgba(239,68,68,0.16); color:#f87171; border-radius:4px; padding:1px 6px; font-size:0.74rem;">－ #${escapeHtml(t)}</span>`
              );
            }
          }
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 6px; border-bottom:1px solid rgba(255,255,255,0.05); flex-wrap:wrap;">
              <span style="font-family:monospace; font-weight:600; color:var(--text-main, #eceae4);">${escapeHtml(it.file_name || '')}</span>
              <div style="display:flex; gap:4px; flex-wrap:wrap;">${badges.join('')}</div>
            </div>
          `;
        })
        .join('');
    } else {
      listWrapEl.style.display = 'none';
      listEl.innerHTML = '';
    }
  }

  modal.style.display = 'flex';
  if (okBtn) {
    setTimeout(() => okBtn.focus(), 50);
  }
}

async function loadMobileConnectionInfo(silentCheck = false) {
  try {
    const endpoint = silentCheck ? '/api/mobile/info' : '/api/mobile/info?enable_lan=1';
    const res = await fetch(endpoint);
    if (!res.ok) return;
    const data = await res.json();

    const qrImg = document.getElementById('mobileQrImg');
    const urlListEl = document.getElementById('mobileUrlList');
    const urls = Array.isArray(data.mobile_urls) && data.mobile_urls.length > 0
      ? data.mobile_urls
      : [data.primary_url || `${window.location.origin}/m`];

    if (qrImg && urls[0]) {
      qrImg.src = `/api/mobile/qr.svg?url=${encodeURIComponent(urls[0])}`;
    }

    if (urlListEl) {
      urlListEl.innerHTML = urls
        .map(
          (u) => `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--bg-primary, rgba(0,0,0,0.12)); padding:6px 10px; border-radius:4px; border:1px solid var(--border-soft, rgba(128,128,128,0.18));">
            <code style="font-size:0.86rem; color:var(--accent-primary, #e14d2a); font-weight:700; word-break:break-all;">${escapeHtml(u)}</code>
            <button class="btn btn-secondary btn-xs copy-mobile-url-btn" data-url="${escapeHtml(u)}" style="white-space:nowrap;">コピー</button>
          </div>
        `
        )
        .join('');
      urlListEl.querySelectorAll('.copy-mobile-url-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetUrl = btn.getAttribute('data-url') || '';
          if (qrImg && targetUrl) {
            qrImg.src = `/api/mobile/qr.svg?url=${encodeURIComponent(targetUrl)}`;
          }
          try {
            await navigator.clipboard.writeText(targetUrl);
            showToast(`URLをコピーしました: ${targetUrl}`, 'success', 2500);
          } catch (_e) {
            showToast(targetUrl, 'info', 4000);
          }
        });
      });
    }

    if (elements.mobileDbSizeLabel && data.db_size_mb != null) {
      elements.mobileDbSizeLabel.textContent = `${data.db_size_mb} MB`;
    }

    const lastBox = document.getElementById('mobileLastAppliedSyncBox');
    const lastDesc = document.getElementById('mobileLastAppliedSyncDesc');
    if (lastBox && lastDesc) {
      if (data.last_applied_sync && data.last_applied_sync.change_count > 0) {
        const la = data.last_applied_sync;
        lastBox.style.display = 'block';
        lastDesc.textContent = `取り込み日時: ${la.applied_at || '-'} ／ 反映件数: ${la.change_count}件 ${la.exported_at ? `(スマホ出力: ${la.exported_at})` : ''}`;
      } else {
        lastBox.style.display = 'none';
      }
    }

    if (data.detected_sync_file && data.detected_sync_file.change_count > 0) {
      const det = data.detected_sync_file;
      if (elements.mobileDetectedSyncBox) {
        elements.mobileDetectedSyncBox.style.display = 'block';
      }
      if (elements.mobileDetectedSyncDesc) {
        elements.mobileDetectedSyncDesc.textContent = `対象写真: ${det.change_count}件 ${det.exported_at ? `(${det.exported_at} 出力)` : ''} — ${det.file_path}`;
      }
      if (silentCheck) {
        // PC起動時にフォルダ内の mobile_sync.json を検出した場合は自動で一括反映し、完了モーダルを表示する
        await applyDetectedMobileSync(true);
      }
    } else if (elements.mobileDetectedSyncBox) {
      elements.mobileDetectedSyncBox.style.display = 'none';
    }
  } catch (err) {
    console.warn('モバイル接続情報の取得失敗:', err);
  }
}

function openMobileModal() {
  if (elements.mobileConnectModal) {
    elements.mobileConnectModal.style.display = 'flex';
    loadMobileConnectionInfo(false);
  }
}

function closeMobileModal() {
  if (elements.mobileConnectModal) {
    elements.mobileConnectModal.style.display = 'none';
  }
}
window.openMobileModal = openMobileModal;
window.closeMobileModal = closeMobileModal;

async function applyDetectedMobileSync(isAutoStartup = false) {
  try {
    if (elements.applyDetectedMobileSyncBtn) {
      elements.applyDetectedMobileSyncBtn.disabled = true;
      elements.applyDetectedMobileSyncBtn.textContent = '反映中...';
    }
    const res = await fetch('/api/mobile/sync-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ use_detected_file: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '反映に失敗しました');

    if (_lastSeenMobileSyncSeq !== null && (data.applied_count || 0) > 0) {
      _lastSeenMobileSyncSeq += 1;
    }
    const srcName = data.source_file || 'mobile_sync.json';
    showToast(`スマホ選別データ (${srcName}) から ${data.applied_count || 0} 件を反映しました`, 'success', 5000);
    showMobileSyncResultModal(data, srcName, Boolean(isAutoStartup));

    await loadMobileConnectionInfo(false);
    if (typeof refreshAll === 'function') {
      await refreshAll();
    }
  } catch (err) {
    showToast(`同期エラー: ${err.message}`, 'error', 5000);
  } finally {
    if (elements.applyDetectedMobileSyncBtn) {
      elements.applyDetectedMobileSyncBtn.disabled = false;
      elements.applyDetectedMobileSyncBtn.textContent = '今すぐPCに反映';
    }
  }
}

async function importMobileSyncJsonText(text, sourceLabel = 'mobile_sync.json') {
  const parsed = JSON.parse(text);
  const changes = Array.isArray(parsed) ? parsed : (parsed.changes || []);
  if (!Array.isArray(changes) || changes.length === 0) {
    showToast('反映すべき変更データが含まれていません', 'warning', 4500);
    return;
  }

  const res = await fetch('/api/mobile/sync-import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || '反映に失敗しました');

  if (_lastSeenMobileSyncSeq !== null && (data.applied_count || 0) > 0) {
    _lastSeenMobileSyncSeq += 1;
  }
  showToast(`${sourceLabel} から ${data.applied_count || 0} 件の選別・タグ変更を反映しました`, 'success', 5000);
  showMobileSyncResultModal(data, sourceLabel, false);
  await loadMobileConnectionInfo(false);
  if (typeof refreshAll === 'function') {
    await refreshAll();
  }
}

async function importMobileSyncJsonFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    await importMobileSyncJsonText(text, file.name);
  } catch (err) {
    showToast(`ファイル取り込みエラー: ${err.message}`, 'error', 5000);
  }
}

async function importMobileSyncFromClipboard() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      throw new Error('クリップボード読み取りに対応していません');
    }
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      showToast('クリップボードが空です', 'warning');
      return;
    }
    await importMobileSyncJsonText(text, 'クリップボード');
  } catch (err) {
    showToast(`クリップボード取り込みエラー: ${err.message}`, 'error', 5000);
  }
}

// 共通モーダルのイベント登録
function initCommonModals() {
  if (elements.openHelpModalBtn) {
    elements.openHelpModalBtn.addEventListener('click', openHelpModal);
  }
  if (elements.closeHelpModalBtn) {
    elements.closeHelpModalBtn.addEventListener('click', closeHelpModal);
  }
  if (elements.closeHelpModalFooterBtn) {
    elements.closeHelpModalFooterBtn.addEventListener('click', closeHelpModal);
  }
  if (elements.helpModal) {
    elements.helpModal.addEventListener('click', (e) => {
      if (e.target === elements.helpModal) closeHelpModal();
    });
  }

  // スマホ連携モーダル
  if (elements.openMobileModalBtn) {
    elements.openMobileModalBtn.addEventListener('click', openMobileModal);
  }
  if (elements.closeMobileModalBtn) {
    elements.closeMobileModalBtn.addEventListener('click', closeMobileModal);
  }
  if (elements.closeMobileModalFooterBtn) {
    elements.closeMobileModalFooterBtn.addEventListener('click', closeMobileModal);
  }
  if (elements.mobileConnectModal) {
    elements.mobileConnectModal.addEventListener('click', (e) => {
      if (e.target === elements.mobileConnectModal) closeMobileModal();
    });
  }
  if (elements.openMobilePreviewWindowBtn) {
    elements.openMobilePreviewWindowBtn.addEventListener('click', () => {
      window.open('/m', 'PhotoManagerMobilePreview', 'width=412,height=880,menubar=no,toolbar=no,location=no,status=no');
    });
  }
  if (elements.applyDetectedMobileSyncBtn) {
    elements.applyDetectedMobileSyncBtn.addEventListener('click', () => applyDetectedMobileSync(false));
  }
  const pasteSyncBtn = document.getElementById('pasteMobileSyncJsonBtn');
  if (pasteSyncBtn) {
    pasteSyncBtn.addEventListener('click', importMobileSyncFromClipboard);
  }
  const copyFirewallCmdBtn = document.getElementById('copyFirewallCmdBtn');
  if (copyFirewallCmdBtn) {
    copyFirewallCmdBtn.addEventListener('click', async () => {
      const codeEl = document.getElementById('mobileFirewallCmdCode');
      const cmdText = codeEl ? codeEl.textContent.trim() : '';
      if (!cmdText) return;
      try {
        await navigator.clipboard.writeText(cmdText);
        showToast('ファイアウォール許可コマンドをコピーしました（管理者PowerShell等で実行してください）', 'success', 3500);
      } catch (_e) {
        showToast(cmdText, 'info', 5000);
      }
    });
  }
  if (elements.pickMobileSyncFileBtn && elements.mobileSyncFileInput) {
    elements.pickMobileSyncFileBtn.addEventListener('click', () => {
      elements.mobileSyncFileInput.value = '';
      elements.mobileSyncFileInput.click();
    });
    elements.mobileSyncFileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importMobileSyncJsonFile(f);
    });
  }

  // スマホ選別データ取り込み完了モーダル
  const syncResultModal = document.getElementById('mobileSyncResultModal');
  document.getElementById('closeMobileSyncResultBtn')?.addEventListener('click', closeMobileSyncResultModal);
  document.getElementById('closeMobileSyncResultOkBtn')?.addEventListener('click', closeMobileSyncResultModal);
  syncResultModal?.addEventListener('click', (e) => {
    if (e.target === syncResultModal) closeMobileSyncResultModal();
  });

  // 起動時に未反映の mobile_sync.json があるかバックグラウンド確認して自動反映＆モーダル通知
  setTimeout(() => {
    loadMobileConnectionInfo(true);
  }, 1200);

  if (elements.helpNavTabs) {
    elements.helpNavTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.help-tab-btn');
      if (!btn) return;
      const targetTab = btn.dataset.tab;
      if (!targetTab) return;

      elements.helpNavTabs.querySelectorAll('.help-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const contents = document.querySelectorAll('#helpModal .help-tab-content');
      contents.forEach(c => {
        c.classList.toggle('active', c.id === `helpTab-${targetTab}`);
      });
      const helpBody = document.querySelector('#helpModal .help-modal-body');
      if (helpBody) helpBody.scrollTop = 0;
    });
  }

  if (elements.openShutdownModalBtn) {
    elements.openShutdownModalBtn.addEventListener('click', openShutdownModal);
  }
  if (elements.closeShutdownModalBtn) {
    elements.closeShutdownModalBtn.addEventListener('click', closeShutdownModal);
  }
  if (elements.btnCancelShutdown) {
    elements.btnCancelShutdown.addEventListener('click', closeShutdownModal);
  }
  if (elements.shutdownModal) {
    elements.shutdownModal.addEventListener('click', (e) => {
      if (e.target === elements.shutdownModal) closeShutdownModal();
    });
  }
  if (elements.btnConfirmShutdown) {
    elements.btnConfirmShutdown.addEventListener('click', confirmShutdown);
  }

  // タグ完全削除モーダル
  if (elements.closeDeleteTagModalBtn) {
    elements.closeDeleteTagModalBtn.addEventListener('click', () => closeDeleteTagModal(false));
  }
  if (elements.btnCancelDeleteTag) {
    elements.btnCancelDeleteTag.addEventListener('click', () => closeDeleteTagModal(false));
  }
  if (elements.btnConfirmDeleteTag) {
    elements.btnConfirmDeleteTag.addEventListener('click', () => closeDeleteTagModal(true));
  }
  if (elements.deleteTagModal) {
    elements.deleteTagModal.addEventListener('click', (e) => {
      if (e.target === elements.deleteTagModal) closeDeleteTagModal(false);
    });
  }

  // フォルダ管理登録モーダル (v2.02)
  if (elements.closeRegisterFolderModalBtn) {
    elements.closeRegisterFolderModalBtn.addEventListener('click', () => closeRegisterFolderModal(null));
  }
  if (elements.btnCancelRegisterFolder) {
    elements.btnCancelRegisterFolder.addEventListener('click', () => closeRegisterFolderModal(null));
  }
  if (elements.btnDirectRegisterFolder) {
    elements.btnDirectRegisterFolder.addEventListener('click', () => closeRegisterFolderModal('direct'));
  }
  if (elements.btnRecursiveRegisterFolder) {
    elements.btnRecursiveRegisterFolder.addEventListener('click', () => closeRegisterFolderModal('recursive'));
  }
  if (elements.registerFolderModal) {
    elements.registerFolderModal.addEventListener('click', (e) => {
      if (e.target === elements.registerFolderModal) closeRegisterFolderModal(null);
    });
  }
}

function bootCommonUI() {
  initCommonModals();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootCommonUI);
} else {
  bootCommonUI();
}
