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
  connectionStates: new Set(['online', 'offline', 'unlinked']), // 有効な接続状態セット ('online' | 'offline' | 'unlinked')
  availableTags: [],        // 利用可能なタグ一覧
  selectedYearMonths: new Set(), // タイムライン複数選択（OR条件）用Set
  selectedDates: new Set(),      // カレンダー日付複数選択（YYYY-MM-DD・OR条件）用Set
  lastClickedCalendarDate: null, // カレンダーShift範囲選択の起点日 (YYYY-MM-DD)
  miniCalendarYm: null,          // 左ペインミニカレンダーで現在表示中の YYYY-MM
  isMiniCalendarCollapsed: localStorage.getItem('pm_mini_cal_collapsed') === 'true', // ミニカレンダー開閉状態
  availableTimeline: [],         // タイムライン年月集計キャッシュ
  calendarDaysMap: new Map(),    // 日別集計マップ ('YYYY-MM-DD' -> 日別サマリオブジェクト)
  expandedTimelineYears: new Set(), // 展開されたタイムライン年集合 (デフォルトはすべて閉じた状態)
  selectedCameras: new Set(),    // カメラ機種複数選択（OR条件）用Set (後方互換)
  cameraFilters: new Map(),      // カメラ名 -> 'include' | 'exclude' (3ステート管理)
  lensFilters: new Map(),        // "CameraModel::LensModel" または "LensModel" -> 'include' | 'exclude'
  expandedCameras: new Set(),    // 展開されたカメラツリー機種名集合
  selectedLenses: new Set(),     // レンズ選択（OR条件）用Set
  availableCameras: [],          // 利用可能なカメラ機種一覧
  cameraSortByCount: localStorage.getItem('pm_camera_sort_by_count') === 'true', // カメラ・レンズ一覧の枚数順トグル (ON: 枚数順 / OFF: 名前順)
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
  // 汎用確認モーダル (commonConfirmModal)
  commonConfirmModal: document.getElementById('commonConfirmModal'),
  commonConfirmModalTitle: document.getElementById('commonConfirmModalTitle'),
  commonConfirmModalSubtitle: document.getElementById('commonConfirmModalSubtitle'),
  commonConfirmModalIcon: document.getElementById('commonConfirmModalIcon'),
  commonConfirmModalHeading: document.getElementById('commonConfirmModalHeading'),
  commonConfirmModalSubPathWrap: document.getElementById('commonConfirmModalSubPathWrap'),
  commonConfirmModalSubPath: document.getElementById('commonConfirmModalSubPath'),
  commonConfirmModalDetailsWrap: document.getElementById('commonConfirmModalDetailsWrap'),
  commonConfirmModalDesc: document.getElementById('commonConfirmModalDesc'),
  closeCommonConfirmModalBtn: document.getElementById('closeCommonConfirmModalBtn'),
  btnCancelCommonConfirm: document.getElementById('btnCancelCommonConfirm'),
  btnOkCommonConfirm: document.getElementById('btnOkCommonConfirm'),
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
  contextMenuAiColorTagItem: document.getElementById('contextMenuAiColorTagItem'),
  contextMenuAiColorTagLabel: document.getElementById('contextMenuAiColorTagLabel'),
  contextMenuPreviewItem: document.getElementById('contextMenuPreviewItem'),
  contextMenuDeleteItem: document.getElementById('contextMenuDeleteItem'),
  contextMenuClearSelection: document.getElementById('contextMenuClearSelection'),
  contextMenuPurgeUnlinkedItem: document.getElementById('contextMenuPurgeUnlinkedItem'),
  contextMenuPurgeUnlinkedLabel: document.getElementById('contextMenuPurgeUnlinkedLabel'),
  contextMenuPurgeUnlinkedDivider: document.getElementById('contextMenuPurgeUnlinkedDivider'),
  // フォルダ専用コンテキストメニュー
  folderContextMenu: document.getElementById('folderContextMenu'),
  folderContextMenuPath: document.getElementById('folderContextMenuPath'),
  folderContextHeaderUnlinkBtn: document.getElementById('folderContextHeaderUnlinkBtn'),
  folderMenuManagedGroup: document.getElementById('folderMenuManagedGroup'),
  folderMenuUnmanagedGroup: document.getElementById('folderMenuUnmanagedGroup'),
  folderMenuIgnoredGroup: document.getElementById('folderMenuIgnoredGroup'),
  folderMenuRescanDirect: document.getElementById('folderMenuRescanDirect'),
  folderMenuRescanRecursive: document.getElementById('folderMenuRescanRecursive'),
  folderMenuRefresh: document.getElementById('folderMenuRefresh'),
  folderMenuAiTag: document.getElementById('folderMenuAiTag'),
  folderMenuAiColorTag: document.getElementById('folderMenuAiColorTag'),
  folderMenuUnmanage: document.getElementById('folderMenuUnmanage'),
  folderMenuIgnoreFromManaged: document.getElementById('folderMenuIgnoreFromManaged'),
  folderMenuAddAndScan: document.getElementById('folderMenuAddAndScan'),
  folderMenuIgnoreFromUnmanaged: document.getElementById('folderMenuIgnoreFromUnmanaged'),
  folderMenuUnignore: document.getElementById('folderMenuUnignore'),
  folderMenuAddFromIgnored: document.getElementById('folderMenuAddFromIgnored'),
  folderMenuOpenExplorer: document.getElementById('folderMenuOpenExplorer'),
  folderMenuRenameVolume: document.getElementById('folderMenuRenameVolume'),
  folderWarningBanner: document.getElementById('folderWarningBanner'),
  warningBannerDesc: document.getElementById('warningBannerDesc'),
  warningBannerReloadBtn: document.getElementById('warningBannerReloadBtn'),
  warningBannerUnlinkBtn: document.getElementById('warningBannerUnlinkBtn'),
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
  allPhotosNavItem: document.getElementById('allPhotosNavItem'),
  onlineOnlyNavItem: document.getElementById('onlineOnlyNavItem'),
  onlinePhotosCount: document.getElementById('onlinePhotosCount'),
  offlinePhotosCount: document.getElementById('offlinePhotosCount'),
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
  headerScopeSelect: document.getElementById('headerScopeSelect'),
  headerAttrSelect: document.getElementById('headerAttrSelect'),
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
  settingToolbarPositionSelect: document.getElementById('settingToolbarPositionSelect'),
};

/**
 * state.photos トップレベル・各カードの stack_photos・ライトボックス展開スタック (state.currentLightboxStackPhotos) の
 * 全箇所から指定IDの写真オブジェクトを検索して返す共通ヘルパー
 */
function findPhotoByIdAnywhere(photoId) {
  const numId = Number(photoId);
  if (!numId) return null;
  if (Array.isArray(state.photos)) {
    const top = state.photos.find(p => p.id === numId);
    if (top) return top;
    for (const p of state.photos) {
      if (Array.isArray(p.stack_photos)) {
        const sub = p.stack_photos.find(sp => sp.id === numId);
        if (sub) return sub;
      }
    }
  }
  if (Array.isArray(state.currentLightboxStackPhotos)) {
    const lb = state.currentLightboxStackPhotos.find(sp => sp.id === numId);
    if (lb) return lb;
  }
  return null;
}
window.findPhotoByIdAnywhere = findPhotoByIdAnywhere;

/**
 * 指定IDに一致するすべての写真オブジェクト参照（トップ・stack_photos内・currentLightboxStackPhotos内）を配列で返す
 * （ミューテーション時に全参照を漏れなく同期するため）
 */
function findAllPhotoInstancesById(photoId) {
  const numId = Number(photoId);
  const results = [];
  const seen = new Set();
  const pushUnique = (obj) => {
    if (obj && !seen.has(obj)) {
      seen.add(obj);
      results.push(obj);
    }
  };
  if (!numId) return results;
  if (Array.isArray(state.photos)) {
    for (const p of state.photos) {
      if (p.id === numId) pushUnique(p);
      if (Array.isArray(p.stack_photos)) {
        for (const sp of p.stack_photos) {
          if (sp.id === numId) pushUnique(sp);
        }
      }
    }
  }
  if (Array.isArray(state.currentLightboxStackPhotos)) {
    for (const sp of state.currentLightboxStackPhotos) {
      if (sp.id === numId) pushUnique(sp);
    }
  }
  return results;
}
window.findAllPhotoInstancesById = findAllPhotoInstancesById;

/**
 * 現在の表示モードが「リンク情報なし（リンク消失の写真）」単独表示中かどうかを判定する。
 * リンク消失写真のDB完全消去UI・ショートカットはこの状態でのみ有効化する。
 */
function isStrictlyUnlinkedOnlyView() {
  if (state.connectionFilter === 'unlinked' || state.connectionFilter === 'missing') {
    return true;
  }
  if (
    state.connectionFilter !== 'duplicates' &&
    state.connectionStates instanceof Set &&
    state.connectionStates.size === 1 &&
    state.connectionStates.has('unlinked')
  ) {
    return true;
  }
  return false;
}
window.isStrictlyUnlinkedOnlyView = isStrictlyUnlinkedOnlyView;

/**
 * 指定された写真ID配列（またはSet）を「リンクあり（実体登録あり）」と「リンク情報なし（is_unlinked）」に振り分ける
 */
function partitionPhotosByLinkStatus(photoIds) {
  const ids = Array.isArray(photoIds) ? photoIds : Array.from(photoIds || []);
  const linkedIds = [];
  const unlinkedIds = [];
  for (const rawId of ids) {
    const id = Number(rawId);
    if (!id) continue;
    const p = findPhotoByIdAnywhere(id);
    if (p && p.is_unlinked) {
      unlinkedIds.push(id);
    } else if (p) {
      linkedIds.push(id);
    }
  }
  return { linkedIds, unlinkedIds, allIds: ids };
}
window.partitionPhotosByLinkStatus = partitionPhotosByLinkStatus;



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
  const bust = photo._thumbBust ? `_${photo._thumbBust}` : '';
  if (hasBakedViewAdjustments(photo)) {
    const rot = photo.rotation || 0;
    const fa = Math.round((Number(photo.fine_angle) || 0) * 10);
    const crop = photo.crop_w
      ? `${Math.round((photo.crop_x || 0) * 1000)}_${Math.round((photo.crop_y || 0) * 1000)}_${Math.round(photo.crop_w * 1000)}_${Math.round((photo.crop_h || 0) * 1000)}`
      : '0';
    const tone = `${photo.brightness || 0}_${photo.contrast || 0}_${photo.saturation || 0}`;
    return `/api/photo/${photo.id}/view?v=${baseVer}_r${rot}_fa${fa}_c${crop}_t${tone}${bust}`;
  }
  return `/api/photo/${photo.id}/view?v=${baseVer}${bust}`;
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
  // v1.0.0: Tetheract D / Tetheract L / 夜墨(sumi) / 和紙(paper) の4プリセット対応
  let savedScheme = localStorage.getItem('pm_theme_scheme');
  if (!savedScheme) {
    const legacy = localStorage.getItem('pm_hinomaru_theme');
    savedScheme = (legacy === 'paper') ? 'tetheract-l' : 'tetheract-d';
    try {
      localStorage.setItem('pm_theme_scheme', savedScheme);
    } catch (e) {}
  }
  applyTheme(savedScheme);

  if (elements.themeToggleBtn) {
    elements.themeToggleBtn.addEventListener('click', toggleTheme);
  }
  const settingThemeSelect = document.getElementById('settingThemeSelect');
  if (settingThemeSelect && !settingThemeSelect.dataset.boundTheme) {
    settingThemeSelect.dataset.boundTheme = 'true';
    settingThemeSelect.value = savedScheme;
    settingThemeSelect.addEventListener('change', () => {
      applyTheme(settingThemeSelect.value || 'tetheract-d');
    });
  }

  // ツールバー配置（フッター / ヘッダー）の復元・同期
  const savedTbPos = localStorage.getItem('pm_toolbar_position') || 'bottom';
  applyToolbarPosition(savedTbPos);
}

function applyToolbarPosition(pos) {
  const normalized = (pos === 'top') ? 'top' : 'bottom';
  document.documentElement.setAttribute('data-toolbar-pos', normalized);
  try {
    localStorage.setItem('pm_toolbar_position', normalized);
  } catch (e) {}
  const sel = document.getElementById('settingToolbarPositionSelect');
  if (sel && sel.value !== normalized) {
    sel.value = normalized;
  }
}
window.applyToolbarPosition = applyToolbarPosition;

function applyTheme(schemeOrTheme) {
  const validSchemes = new Set(['tetheract-d', 'tetheract-l', 'sumi', 'paper']);
  const scheme = validSchemes.has(schemeOrTheme) ? schemeOrTheme : 'tetheract-d';
  // 既存コンポーネントの明暗セレクタ ([data-theme="paper" | "sumi"]) との完全互換を維持しつつ data-scheme を付与
  const baseMode = (scheme === 'tetheract-l' || scheme === 'paper') ? 'paper' : 'sumi';

  const root = document.documentElement;
  root.setAttribute('data-theme', baseMode);
  root.setAttribute('data-scheme', scheme);
  try {
    localStorage.setItem('pm_theme_scheme', scheme);
    localStorage.setItem('pm_hinomaru_theme', baseMode);
  } catch (e) {}

  const settingThemeSelect = document.getElementById('settingThemeSelect');
  if (settingThemeSelect && settingThemeSelect.value !== scheme) {
    settingThemeSelect.value = scheme;
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-scheme') || 'tetheract-d';
  const nextScheme = current === 'tetheract-d' ? 'tetheract-l'
    : current === 'tetheract-l' ? 'tetheract-d'
    : current === 'sumi' ? 'paper' : 'sumi';
  applyTheme(nextScheme);
}

/**
 * 定期ハートビート（生存信号）の送信
 * ブラウザが開いている間、3秒間隔でサーバーへ生存を通知。
 * すべてのタブ/ウィンドウが閉じられると通信が途絶え、サーバー側で自動停止する。
 */
let _lastSeenMobileSyncSeq = null;
let _lastSeenMediaEventSeq = null;
let _mediaEventSource = null;
let _mediaSyncRunning = false;

/**
 * メディア（SDカード・USBメモリ・外付けSSD）の抜き挿し検知イベントを受け取り、
 * トースト通知およびフォルダツリー・ギャラリー・インスペクタ・クイックアクセスを自動同期する
 */
async function handleMediaChangeEvent(evt) {
  if (!evt || typeof evt.seq !== 'number') return;
  if (_lastSeenMediaEventSeq !== null && evt.seq <= _lastSeenMediaEventSeq) return;
  _lastSeenMediaEventSeq = evt.seq;

  const added = Array.isArray(evt.added) ? evt.added : [];
  const removed = Array.isArray(evt.removed) ? evt.removed : [];
  const changed = Array.isArray(evt.changed) ? evt.changed : [];
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return;

  // 1. トースト通知の表示
  if (typeof showToast === 'function') {
    added.forEach((m) => {
      const name = m.custom_name || m.label || (m.short_serial ? `ID:${m.short_serial}` : '外部メディア');
      const idPart = (m.short_serial && (m.custom_name || m.label)) ? ` [ID:${m.short_serial}]` : '';
      const drvPart = m.drive ? ` (${m.drive})` : '';
      if (m.photo_count > 0) {
        showToast(
          `🟢 メディア「${name}${idPart}${drvPart}」が接続されました（登録写真 ${Number(m.photo_count).toLocaleString()}枚）`,
          'success',
          4200
        );
      } else if (m.loome_enabled) {
        showToast(`🟢 Loome メディア「${name}${idPart}${drvPart}」が接続されました`, 'success', 3600);
      } else {
        showToast(`🟢 メディア「${name}${idPart}${drvPart}」が接続されました`, 'info', 3200);
      }
    });

    removed.forEach((m) => {
      const name = m.custom_name || m.label || (m.short_serial ? `ID:${m.short_serial}` : '外部メディア');
      const idPart = (m.short_serial && (m.custom_name || m.label)) ? ` [ID:${m.short_serial}]` : '';
      const drvPart = m.drive ? ` (${m.drive})` : '';
      showToast(`⚪ メディア「${name}${idPart}${drvPart}」が取り外されました`, 'info', 3200);
    });

    changed.forEach((m) => {
      const name = m.custom_name || m.label || (m.short_serial ? `ID:${m.short_serial}` : '外部メディア');
      const drvPart = m.drive ? ` (${m.drive})` : '';
      showToast(`🔄 メディア「${name}」が${drvPart}として認識されました`, 'info', 3000);
    });
  }

  // 2. 現在選択中のフォルダ・ボリュームフィルタがあればオンライン状態とドライブ文字を自動追従
  let activeManagedFolderToCheckDiff = null;
  if (state.currentFilter && state.currentFilter.volumeSerial) {
    const curVsn = String(state.currentFilter.volumeSerial).trim().toUpperCase();
    const matchedAdded = added.find(m => String(m.serial || '').toUpperCase() === curVsn)
      || changed.find(m => String(m.serial || '').toUpperCase() === curVsn);
    const matchedRemoved = removed.find(m => String(m.serial || '').toUpperCase() === curVsn);

    if (matchedAdded) {
      state.currentFilter.isOffline = false;
      if (matchedAdded.drive && state.currentFilter.value && /^[a-zA-Z]:/.test(state.currentFilter.value)) {
        const newDrive = matchedAdded.drive.replace(/\\+$/, '');
        state.currentFilter.value = newDrive + state.currentFilter.value.slice(2);
      }
      if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
        activeManagedFolderToCheckDiff = {
          path: state.currentFilter.value,
          name: state.currentFilter.titleText || state.currentFilter.value,
          volumeSerial: curVsn,
        };
      }
    } else if (matchedRemoved) {
      state.currentFilter.isOffline = true;
    }
  }

  // 3. 写真オブジェクトの詳細キャッシュ（重複リスト等）を破棄してインスペクタ再描画時に最新状態を反映させる
  if (Array.isArray(state.photos)) {
    state.photos.forEach((p) => {
      delete p._xmpDetailFetched;
      delete p.duplicates;
    });
  }

  // 4. フォルダツリー・ギャラリー写真一覧・クイックアクセス枚数・インスペクタを一括ライブ同期
  if (_mediaSyncRunning) return;
  _mediaSyncRunning = true;
  try {
    await Promise.all([
      typeof fetchFolders === 'function' ? fetchFolders() : Promise.resolve(),
      typeof fetchPhotos === 'function' ? fetchPhotos() : Promise.resolve(),
      typeof fetchTags === 'function' ? fetchTags() : Promise.resolve(),
      typeof fetchUnlinkedCount === 'function' ? fetchUnlinkedCount() : Promise.resolve(),
      typeof fetchDuplicatesCount === 'function' ? fetchDuplicatesCount() : Promise.resolve(),
    ]);
    if (typeof syncCurrentFilterOfflineState === 'function') {
      syncCurrentFilterOfflineState();
    }

    // ストレージ(Loome)管理モーダルが開いていれば最新化
    const storageModal = document.getElementById('storageManagerModal');
    if (storageModal && storageModal.style.display !== 'none' && typeof window.loadStorageFolders === 'function') {
      window.loadStorageFolders();
    }

    // ライトボックスが開いていれば現在表示中の写真を最新状態（フル解像度・オンラインバッジ解除）で再反映
    if (elements.lightboxModal && elements.lightboxModal.style.display !== 'none' && typeof updateLightboxContent === 'function') {
      const lbPhoto = typeof getCurrentLightboxPhoto === 'function' ? getCurrentLightboxPhoto() : state.photos[state.currentPhotoIndex];
      if (lbPhoto) {
        lbPhoto._thumbBust = Date.now();
        updateLightboxContent(lbPhoto);
      }
    }

    // 接続されたメディア上のフォルダを現在開いている場合は自動で差分（新規追加等）チェックも実行
    if (activeManagedFolderToCheckDiff && typeof window.checkAndPromptFolderRefresh === 'function') {
      window.checkAndPromptFolderRefresh(
        activeManagedFolderToCheckDiff.path,
        activeManagedFolderToCheckDiff.name,
        { volumeSerial: activeManagedFolderToCheckDiff.volumeSerial, kind: 'folder', status: 'managed' }
      );
    }
  } catch (err) {
    console.warn('[MediaWatcher] 自動同期エラー:', err);
  } finally {
    _mediaSyncRunning = false;
  }
}
window.handleMediaChangeEvent = handleMediaChangeEvent;

// 外部アプリ・エクスプローラーで開いた写真・フォルダの追跡セット（ウィンドウフォーカス復帰時の差分検知用）
const _pendingExternalPhotoIds = new Set();
const _pendingExternalFolders = new Set();

window.markExternalPhotoOpened = function (photoId) {
  if (photoId) _pendingExternalPhotoIds.add(Number(photoId));
};
window.markExternalFolderOpened = function (folderPath) {
  if (folderPath) _pendingExternalFolders.add(String(folderPath));
};

/**
 * OSイベント駆動（SSE）＋ ウィンドウフォーカス復帰時の保険チェックを初期化する
 */
function initMediaWatcher() {
  if (typeof EventSource !== 'undefined' && !_mediaEventSource) {
    try {
      const es = new EventSource('/api/media/events');
      _mediaEventSource = es;
      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (!payload) return;
          if (payload.type === 'init') {
            if (_lastSeenMediaEventSeq === null && typeof payload.seq === 'number') {
              _lastSeenMediaEventSeq = payload.seq;
            }
          } else if (payload.type === 'change') {
            handleMediaChangeEvent(payload);
          } else if (payload.type === 'lenses_backfilled') {
            if (typeof fetchCameras === 'function') {
              fetchCameras();
            }
          } else if (payload.type === 'mobile_synced') {
            if (typeof payload.seq === 'number') {
              _lastSeenMobileSyncSeq = payload.seq;
            }
            if (typeof showToast === 'function') {
              showToast('スマホ版での評価・タグ変更がPCに自動反映されました', 'success', 4000);
            }
            if (typeof refreshAll === 'function') {
              refreshAll();
            }
          }
        } catch (err) {
          console.debug('[MediaWatcher] イベント解析スキップ:', err);
        }
      };
      es.onerror = () => {
        // ブラウザ標準の自動再接続に委ねる
      };
    } catch (err) {
      console.warn('[MediaWatcher] EventSource 初期化スキップ:', err);
    }
  }

  // 保険チェック: WM_DEVICECHANGE を送出しない古い外付けカードリーダー対策 ＆ 外部アプリからのフォーカス復帰時同期
  const checkOnFocus = async () => {
    fetch('/api/media/check', { method: 'POST' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.changed && data.event) {
          handleMediaChangeEvent(data.event);
        }
      })
      .catch(() => {});

    // 外部アプリで開いていた写真の変更チェック（mtime / size / XMPサイドカー差分）
    if (_pendingExternalPhotoIds.size > 0 || _pendingExternalFolders.size > 0) {
      const idsToCheck = Array.from(_pendingExternalPhotoIds);
      try {
        const res = await fetch('/api/photos/check-external-updates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: idsToCheck }),
        });
        if (res.ok) {
          const data = await res.json();
          const updatedIds = Array.isArray(data.updated_photo_ids) ? data.updated_photo_ids : [];
          const checkedPhotos = Array.isArray(data.photos) ? data.photos : [];
          let xmpChanged = false;
          checkedPhotos.forEach(pInfo => {
            findAllPhotoInstancesById(pInfo.id).forEach(inst => {
              delete inst._xmpDetailFetched;
              delete inst.duplicates;
              if (Boolean(inst.has_xmp) !== Boolean(pInfo.has_xmp)) {
                inst.has_xmp = Boolean(pInfo.has_xmp);
                xmpChanged = true;
              }
            });
          });
          if (updatedIds.length === 0 && idsToCheck.length > 0 && (xmpChanged || (state.activeInspectorPhotoId && idsToCheck.includes(Number(state.activeInspectorPhotoId))))) {
            if (typeof updateInspectorView === 'function') updateInspectorView();
          }
          if (updatedIds.length > 0) {
            const nowBust = Date.now();
            updatedIds.forEach(uid => {
              findAllPhotoInstancesById(uid).forEach(inst => {
                inst._thumbBust = nowBust;
                delete inst._xmpDetailFetched;
                delete inst.duplicates;
              });
            });
            if (typeof fetchPhotos === 'function') await fetchPhotos();
            if (typeof fetchTags === 'function') fetchTags();
            if (elements.lightboxModal && elements.lightboxModal.style.display !== 'none' && typeof updateLightboxContent === 'function') {
              const curLb = typeof getCurrentLightboxPhoto === 'function' ? getCurrentLightboxPhoto() : null;
              if (curLb && updatedIds.includes(curLb.id)) {
                curLb._thumbBust = nowBust;
                updateLightboxContent(curLb);
              }
            }
            if (typeof updateInspectorView === 'function') updateInspectorView();
            if (typeof showToast === 'function') {
              showToast(`外部アプリでの変更（${updatedIds.length}枚）をライブラリに反映しました`, 'info', 3000);
            }
          }
        }
      } catch (err) {
        console.debug('[FocusSync] 外部更新確認スキップ:', err);
      }
    }

    // エクスプローラーで開いていたフォルダ、および現在表示中フォルダの変更チェック
    if (_pendingExternalFolders.size > 0) {
      _pendingExternalFolders.clear();
      if (typeof refreshFolderTree === 'function') {
        refreshFolderTree();
      }
    }
    if (state.currentFilter && state.currentFilter.type === 'folder' && state.currentFilter.value && !state.currentFilter.isOffline) {
      const curPath = state.currentFilter.value;
      if (typeof window.checkAndPromptFolderRefresh === 'function') {
        const folderName = curPath.split(/[\\/]/).filter(Boolean).pop() || curPath;
        window.checkAndPromptFolderRefresh(curPath, folderName, {
          volumeSerial: state.currentFilter.volumeSerial || null,
          isOffline: false,
        });
      }
    }
  };

  window.addEventListener('focus', checkOnFocus);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkOnFocus();
  });
}

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
  initMediaWatcher();

  const sendHeartbeat = () => {
    fetch('/api/heartbeat', { method: 'POST' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || typeof data.mobile_sync_seq !== 'number') return;
        if (typeof data.media_event_seq === 'number') {
          if (_lastSeenMediaEventSeq === null) {
            _lastSeenMediaEventSeq = data.media_event_seq;
          } else if (data.media_event_seq > _lastSeenMediaEventSeq && data.media_last_event) {
            handleMediaChangeEvent(data.media_last_event);
          }
        }
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
  // 0. 左端アイコンバー（#sidebarRail: 54px〜108px [標準の最大2倍]）のドラッグリサイズ
  const railEl = document.getElementById('sidebarRail');
  const railResizer = document.getElementById('sidebarRailResizer');
  const RAIL_BASE_W = 54;
  const RAIL_MIN_W = 54;
  const RAIL_MAX_W = 108;

  function applyRailWidth(rawWidth, saveToStorage = false) {
    const w = Math.max(RAIL_MIN_W, Math.min(RAIL_MAX_W, Math.round(rawWidth || RAIL_BASE_W)));
    const scale = (w / RAIL_BASE_W).toFixed(4);
    document.documentElement.style.setProperty('--rail-width', w + 'px');
    document.documentElement.style.setProperty('--rail-scale', scale);
    if (saveToStorage) {
      try {
        localStorage.setItem('pm_sidebar_rail_width', String(w));
      } catch (e) {}
    }
    return w;
  }

  const savedRailWidth = parseInt(localStorage.getItem('pm_sidebar_rail_width'), 10);
  if (savedRailWidth && !isNaN(savedRailWidth)) {
    applyRailWidth(savedRailWidth, false);
  }

  if (railResizer && railEl) {
    railResizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startRailW = railEl.getBoundingClientRect().width || RAIL_BASE_W;
      const isCollapsed = sidebar ? sidebar.classList.contains('is-collapsed') : false;
      const startSidebarW = (sidebar && !isCollapsed) ? sidebar.getBoundingClientRect().width : 0;

      railResizer.classList.add('active');
      document.body.classList.add('resizing');

      function onMouseMove(ev) {
        const delta = ev.clientX - startX;
        const newRailW = applyRailWidth(startRailW + delta, false);
        const appliedDelta = newRailW - startRailW;
        if (sidebar && !isCollapsed && startSidebarW > 0) {
          const newSidebarW = Math.round(startSidebarW + appliedDelta);
          sidebar.style.width = newSidebarW + 'px';
          document.documentElement.style.setProperty('--sidebar-width', newSidebarW + 'px');
        }
      }

      function onMouseUp() {
        railResizer.classList.remove('active');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        const finalRailW = Math.round(railEl.getBoundingClientRect().width || RAIL_BASE_W);
        applyRailWidth(finalRailW, true);
        if (sidebar && !isCollapsed) {
          const finalSidebarW = Math.round(sidebar.getBoundingClientRect().width);
          try {
            localStorage.setItem('pm_sidebar_width', String(finalSidebarW));
          } catch (e) {}
        }
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // ダブルクリックで標準幅（54px / 1.0倍）にリセット
    railResizer.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const prevRailW = railEl.getBoundingClientRect().width || RAIL_BASE_W;
      const delta = RAIL_BASE_W - prevRailW;
      applyRailWidth(RAIL_BASE_W, true);
      if (sidebar && !sidebar.classList.contains('is-collapsed') && Math.abs(delta) > 0.5) {
        const currentSidebarW = sidebar.getBoundingClientRect().width;
        const nextSidebarW = Math.max(245, Math.round(currentSidebarW + delta));
        sidebar.style.width = nextSidebarW + 'px';
        document.documentElement.style.setProperty('--sidebar-width', nextSidebarW + 'px');
        try {
          localStorage.setItem('pm_sidebar_width', String(nextSidebarW));
        } catch (err) {}
      }
    });
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
          <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">このブラウザタブまたはウィンドウを閉じてください。<br>次回は <strong>Tetheract.exe</strong> から一瞬で起動できます。</p>
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
// 汎用確認モーダル制御 (Common Confirm Modal: フォルダ更新・リンク解除・各種確認)
// ============================================================
let _pendingCommonConfirmResolve = null;

const CONFIRM_MODAL_ICONS = {
  folder: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  'folder-refresh': '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
  unlink: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>',
  trash: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  ai: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>',
  palette: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>',
  'map-pin': '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  xmp: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/></svg>',
  info: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

/**
 * registerFolderModal / deleteTagModal と統一デザインの確認モーダルを表示する
 * @param {Object} options
 * @returns {Promise<boolean>}
 */
function showConfirmModal(options = {}) {
  return new Promise((resolve) => {
    const modalEl = elements.commonConfirmModal || document.getElementById('commonConfirmModal');
    const titleEl = elements.commonConfirmModalTitle || document.getElementById('commonConfirmModalTitle');
    const subtitleEl = elements.commonConfirmModalSubtitle || document.getElementById('commonConfirmModalSubtitle');
    const iconEl = elements.commonConfirmModalIcon || document.getElementById('commonConfirmModalIcon');
    const headingEl = elements.commonConfirmModalHeading || document.getElementById('commonConfirmModalHeading');
    const subPathWrapEl = elements.commonConfirmModalSubPathWrap || document.getElementById('commonConfirmModalSubPathWrap');
    const subPathEl = elements.commonConfirmModalSubPath || document.getElementById('commonConfirmModalSubPath');
    const detailsWrapEl = elements.commonConfirmModalDetailsWrap || document.getElementById('commonConfirmModalDetailsWrap');
    const descEl = elements.commonConfirmModalDesc || document.getElementById('commonConfirmModalDesc');
    const cancelBtnEl = elements.btnCancelCommonConfirm || document.getElementById('btnCancelCommonConfirm');
    const okBtnEl = elements.btnOkCommonConfirm || document.getElementById('btnOkCommonConfirm');

    if (!modalEl) {
      const fallbackMsg = options.fallbackMessage || options.headingText || options.title || 'よろしいですか？';
      resolve(window.confirm(fallbackMsg));
      return;
    }

    if (_pendingCommonConfirmResolve) {
      _pendingCommonConfirmResolve(false);
      _pendingCommonConfirmResolve = null;
    }
    _pendingCommonConfirmResolve = resolve;

    if (titleEl) {
      titleEl.textContent = options.title || '確認';
    }
    if (subtitleEl) {
      subtitleEl.textContent = options.subtitle || '操作の確認';
    }
    if (iconEl) {
      const iconKey = options.icon || 'folder';
      iconEl.innerHTML = CONFIRM_MODAL_ICONS[iconKey] || CONFIRM_MODAL_ICONS.folder;
    }

    if (headingEl) {
      headingEl.innerHTML = '';
      if (options.targetName !== undefined && options.targetName !== null && options.targetName !== '') {
        if (options.headingPrefix) {
          headingEl.appendChild(document.createTextNode(options.headingPrefix));
        }
        headingEl.appendChild(document.createTextNode('「'));
        const nameSpan = document.createElement('span');
        nameSpan.className = 'raw-filename';
        const isDanger = options.confirmVariant === 'danger';
        nameSpan.style.color = options.targetColor || (isDanger ? '#ef4444' : 'var(--accent-primary, #e14d2a)');
        nameSpan.style.wordBreak = 'break-all';
        nameSpan.textContent = String(options.targetName);
        headingEl.appendChild(nameSpan);
        headingEl.appendChild(document.createTextNode('」'));
        if (options.headingSuffix) {
          headingEl.appendChild(document.createTextNode(options.headingSuffix));
        }
      } else {
        headingEl.textContent = options.headingText || '';
      }
    }

    if (subPathWrapEl && subPathEl) {
      if (options.subPath) {
        subPathEl.textContent = String(options.subPath);
        subPathWrapEl.style.display = 'block';
      } else {
        subPathEl.textContent = '';
        subPathWrapEl.style.display = 'none';
      }
    }

    if (detailsWrapEl) {
      detailsWrapEl.innerHTML = '';
      if (Array.isArray(options.detailRows) && options.detailRows.length > 0) {
        const box = document.createElement('div');
        box.style.cssText = 'background: var(--bg-secondary, rgba(255,255,255,0.04)); border: 1px solid var(--border-color, rgba(255,255,255,0.12)); border-radius: 6px; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem;';
        options.detailRows.forEach((row) => {
          if (!row) return;
          const item = document.createElement('div');
          item.style.cssText = 'display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; line-height: 1.45;';
          const dot = document.createElement('span');
          dot.textContent = '●';
          dot.style.cssText = `font-size: 0.65rem; color: ${row.color || 'var(--accent-primary, #e14d2a)'}; flex-shrink: 0;`;
          const lbl = document.createElement('span');
          lbl.style.cssText = 'color: var(--text-muted, #94a3b8);';
          lbl.textContent = row.label || '';
          const val = document.createElement('strong');
          val.style.cssText = 'color: var(--text-main, #eceae4); font-weight: 600;';
          val.textContent = row.value || '';
          item.appendChild(dot);
          item.appendChild(lbl);
          item.appendChild(val);
          if (row.subText) {
            const sub = document.createElement('span');
            sub.className = 'raw-filename';
            sub.style.cssText = 'font-family: monospace; font-size: 0.74rem; color: var(--text-muted, #94a3b8); opacity: 0.85; word-break: break-all;';
            sub.textContent = row.subText;
            item.appendChild(sub);
          }
          box.appendChild(item);
        });
        detailsWrapEl.appendChild(box);
        detailsWrapEl.style.display = 'block';
      } else {
        detailsWrapEl.style.display = 'none';
      }
    }

    if (descEl) {
      descEl.innerHTML = '';
      const lines = Array.isArray(options.descriptionLines)
        ? options.descriptionLines
        : (options.description ? String(options.description).split('\n') : []);
      lines.forEach((line, idx) => {
        if (idx > 0) {
          descEl.appendChild(document.createElement('br'));
        }
        const span = document.createElement('span');
        span.textContent = line;
        descEl.appendChild(span);
      });
    }

    if (cancelBtnEl) {
      cancelBtnEl.textContent = options.cancelText || 'キャンセル (Esc)';
    }
    if (okBtnEl) {
      okBtnEl.textContent = options.confirmText || 'OK';
      okBtnEl.className = options.confirmVariant === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    }

    modalEl.style.display = 'flex';
    if (options.confirmVariant === 'danger') {
      if (cancelBtnEl) cancelBtnEl.focus();
    } else {
      if (okBtnEl) okBtnEl.focus();
    }
  });
}

function closeConfirmModal(confirmed = false) {
  const modalEl = elements.commonConfirmModal || document.getElementById('commonConfirmModal');
  if (modalEl) {
    modalEl.style.display = 'none';
  }
  if (_pendingCommonConfirmResolve) {
    const fn = _pendingCommonConfirmResolve;
    _pendingCommonConfirmResolve = null;
    fn(Boolean(confirmed));
  }
}
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;

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
    const lockEl = document.getElementById('securityLockOverlay');
    if (lockEl && lockEl.style.display && lockEl.style.display !== 'none') {
      return;
    }
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

  // 汎用確認モーダル (commonConfirmModal)
  if (elements.closeCommonConfirmModalBtn) {
    elements.closeCommonConfirmModalBtn.addEventListener('click', () => closeConfirmModal(false));
  }
  if (elements.btnCancelCommonConfirm) {
    elements.btnCancelCommonConfirm.addEventListener('click', () => closeConfirmModal(false));
  }
  if (elements.btnOkCommonConfirm) {
    elements.btnOkCommonConfirm.addEventListener('click', () => closeConfirmModal(true));
  }
  if (elements.commonConfirmModal) {
    elements.commonConfirmModal.addEventListener('click', (e) => {
      if (e.target === elements.commonConfirmModal) closeConfirmModal(false);
    });
  }

  // 汎用確認モーダル表示中のキーボード操作（Captureフェーズで背後のモーダルへ伝播させない）
  window.addEventListener(
    'keydown',
    (e) => {
      const modalEl = elements.commonConfirmModal || document.getElementById('commonConfirmModal');
      if (!modalEl || modalEl.style.display === 'none') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeConfirmModal(false);
      } else if (e.key === 'Enter') {
        const cancelBtnEl = elements.btnCancelCommonConfirm || document.getElementById('btnCancelCommonConfirm');
        const closeBtnEl = elements.closeCommonConfirmModalBtn || document.getElementById('closeCommonConfirmModalBtn');
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement === cancelBtnEl || document.activeElement === closeBtnEl) {
          closeConfirmModal(false);
        } else {
          closeConfirmModal(true);
        }
      }
    },
    true
  );
}

function bootCommonUI() {
  if (typeof window.t !== 'function') {
    window.t = (_k, fb) => (fb !== undefined ? fb : _k);
  }
  initCommonModals();
  initTetheractActivityUI();
}

/* ==========================================================================
   テサラクト (4D超立方体) Canvasアイコンアニメーター ＆ 統合アクティビティ・ドック
   ========================================================================== */

/**
 * 指定された 2D Canvas コンテキストに Tetheract アイコンを描画する
 * 正面から見たテサラクト（4次元超立方体）のW-Z回転投影として、
 * 「内側の□が4本のコーナービームに沿って外枠へ拡大して重なり、
 *   その時にはすでに奥から次の新しい□が現れて定位置に達している」無限ループを描画する。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} S キャンバスの一辺ピクセル数
 * @param {number} cycleProgress ループ進行度 (0.0〜1.0, 0.0が定位置静止状態)
 * @param {number} glowBoost 発光強度倍率
 */
function drawTetheractIconFrame(ctx, S, cycleProgress = 0.0, glowBoost = 1.0) {
  if (!ctx || S <= 0) return;
  ctx.clearRect(0, 0, S, S);

  const p = ((cycleProgress % 1) + 1) % 1;

  const rrect = (x, y, w, h, r) => {
    const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };

  // 1. 外周ダークリム (#141414)
  rrect(S * 0.015, S * 0.015, S * 0.97, S * 0.97, S * 0.155);
  ctx.fillStyle = '#141414';
  ctx.fill();

  // 2. シャンパンゴールド外枠 (#e8caa4)
  rrect(S * 0.032, S * 0.032, S * 0.936, S * 0.936, S * 0.14);
  const frameGrad = ctx.createLinearGradient(0, 0, S, S);
  frameGrad.addColorStop(0, '#f0d7b6');
  frameGrad.addColorStop(0.5, '#e6c7a0');
  frameGrad.addColorStop(1, '#d5b288');
  ctx.fillStyle = frameGrad;
  ctx.fill();

  // 3. 内部ダークチャンバー領域のクリップ (τ = 2.0 の外枠内縁)
  const ox0 = S * 0.104;
  const oy0 = S * 0.104;
  const ox1 = S * 0.896;
  const oy1 = S * 0.896;
  const ow = ox1 - ox0;
  const oh = oy1 - oy0;

  ctx.save();
  rrect(ox0, oy0, ow, oh, S * 0.068);
  ctx.fillStyle = '#080808';
  ctx.fill();
  ctx.clip();

  // 1点透視図法の不動消失点 V と基準スケール比 r の算出
  // 定位置 (τ = 1.0) の内枠は中心 (0.565, 0.565), サイズ 0.365 (外枠内縁 0.792 に対する比率 r ≈ 0.46086)
  const r = 0.365 / 0.792;
  const vx = ((0.565 - 0.50 * r) / (1 - r)) * S;
  const vy = ((0.565 - 0.50 * r) / (1 - r)) * S;

  // 深さレベル τ ∈ [0, 2] における正方形座標を返す（全頂点が外枠四隅→消失点Vの直線レール上に厳密に乗る）
  const getSquareAtTau = (tau) => {
    const u = Math.pow(r, 2 - tau);
    const x0 = vx + u * (ox0 - vx);
    const y0 = vy + u * (oy0 - vy);
    const x1 = vx + u * (ox1 - vx);
    const y1 = vy + u * (oy1 - vy);
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, u };
  };

  // τ_B = p (奥から定位置へ湧き上がってくる次の□)
  // τ_A = 1 + p (定位置から外枠へ向かって拡大していく現在の□)
  const tauB = p;
  const tauA = 1.0 + p;
  const sqB = getSquareAtTau(tauB);
  const sqA = getSquareAtTau(tauA);

  // 4. 4面の台形パースペクティブ壁のシャンパンウォーム・ブルーム発光
  // sin^2(πτ/2) の重みにより τ_B と τ_A の合計輝度が常に一定(1.0)となり、ループ境界のちらつきをゼロにする
  const drawWallBloomForSquare = (sq, weight) => {
    const alpha = Math.min(0.68, 0.44 * glowBoost * weight);
    if (alpha < 0.01) return;

    // 上壁
    if (sq.y0 > oy0) {
      const gTop = ctx.createLinearGradient(0, sq.y0, 0, oy0);
      gTop.addColorStop(0, `rgba(232, 202, 164, ${alpha})`);
      gTop.addColorStop(0.4, `rgba(176, 142, 104, ${alpha * 0.32})`);
      gTop.addColorStop(1, 'rgba(10, 10, 10, 0)');
      ctx.beginPath();
      ctx.moveTo(ox0, oy0);
      ctx.lineTo(ox1, oy0);
      ctx.lineTo(sq.x1, sq.y0);
      ctx.lineTo(sq.x0, sq.y0);
      ctx.closePath();
      ctx.fillStyle = gTop;
      ctx.fill();
    }
    // 下壁
    if (oy1 > sq.y1) {
      const gBot = ctx.createLinearGradient(0, sq.y1, 0, oy1);
      gBot.addColorStop(0, `rgba(232, 202, 164, ${alpha})`);
      gBot.addColorStop(0.42, `rgba(176, 142, 104, ${alpha * 0.34})`);
      gBot.addColorStop(1, 'rgba(10, 10, 10, 0)');
      ctx.beginPath();
      ctx.moveTo(sq.x0, sq.y1);
      ctx.lineTo(sq.x1, sq.y1);
      ctx.lineTo(ox1, oy1);
      ctx.lineTo(ox0, oy1);
      ctx.closePath();
      ctx.fillStyle = gBot;
      ctx.fill();
    }
    // 左壁
    if (sq.x0 > ox0) {
      const gLeft = ctx.createLinearGradient(sq.x0, 0, ox0, 0);
      gLeft.addColorStop(0, `rgba(232, 202, 164, ${alpha})`);
      gLeft.addColorStop(0.4, `rgba(176, 142, 104, ${alpha * 0.32})`);
      gLeft.addColorStop(1, 'rgba(10, 10, 10, 0)');
      ctx.beginPath();
      ctx.moveTo(ox0, oy0);
      ctx.lineTo(sq.x0, sq.y0);
      ctx.lineTo(sq.x0, sq.y1);
      ctx.lineTo(ox0, oy1);
      ctx.closePath();
      ctx.fillStyle = gLeft;
      ctx.fill();
    }
    // 右壁
    if (ox1 > sq.x1) {
      const gRight = ctx.createLinearGradient(sq.x1, 0, ox1, 0);
      gRight.addColorStop(0, `rgba(232, 202, 164, ${alpha})`);
      gRight.addColorStop(0.42, `rgba(176, 142, 104, ${alpha * 0.34})`);
      gRight.addColorStop(1, 'rgba(10, 10, 10, 0)');
      ctx.beginPath();
      ctx.moveTo(sq.x1, sq.y0);
      ctx.lineTo(ox1, oy0);
      ctx.lineTo(ox1, oy1);
      ctx.lineTo(sq.x1, sq.y1);
      ctx.closePath();
      ctx.fillStyle = gRight;
      ctx.fill();
    }
  };

  const wB = Math.pow(Math.sin((Math.PI * 0.5) * tauB), 2);
  const wA = Math.pow(Math.sin((Math.PI * 0.5) * tauA), 2);
  if (wB > 0.005) drawWallBloomForSquare(sqB, wB);
  if (wA > 0.005) drawWallBloomForSquare(sqA, wA);

  // 5. 外枠四隅から奥のコア四隅へ貫く4本のテーパー付きテザービーム（4D視点レール）
  const deepRailSq = getSquareAtTau(0.0);
  const corners = [
    { ox: ox0, oy: oy0, ix: deepRailSq.x0, iy: deepRailSq.y0 },
    { ox: ox1, oy: oy0, ix: deepRailSq.x1, iy: deepRailSq.y0 },
    { ox: ox1, oy: oy1, ix: deepRailSq.x1, iy: deepRailSq.y1 },
    { ox: ox0, oy: oy1, ix: deepRailSq.x0, iy: deepRailSq.y1 },
  ];
  const wOuter = S * 0.033;
  const wInner = S * 0.006;

  for (const c of corners) {
    const dx = c.ix - c.ox;
    const dy = c.iy - c.oy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) continue;
    const nx = -dy / len;
    const ny = dx / len;

    const bGrad = ctx.createLinearGradient(c.ox, c.oy, c.ix, c.iy);
    bGrad.addColorStop(0, '#b59d80');
    bGrad.addColorStop(0.5, '#52493f');
    bGrad.addColorStop(0.82, '#181615');
    bGrad.addColorStop(1, '#090909');

    ctx.beginPath();
    ctx.moveTo(c.ox + nx * wOuter, c.oy + ny * wOuter);
    ctx.lineTo(c.ox - nx * wOuter, c.oy - ny * wOuter);
    ctx.lineTo(c.ix - nx * wInner, c.iy - ny * wInner);
    ctx.lineTo(c.ix + nx * wInner, c.iy + ny * wInner);
    ctx.closePath();
    ctx.fillStyle = bGrad;
    ctx.fill();
  }

  // 最深部コアの暗실塗りつぶし
  ctx.fillStyle = '#070707';
  ctx.fillRect(deepRailSq.x0, deepRailSq.y0, deepRailSq.w, deepRailSq.h);

  // 6. 2層のテサラクト内枠□を描画する関数（奥の sqB → 手前へ拡大する sqA の順）
  const drawInnerCubeSquare = (sq, tau) => {
    let alpha = 1.0;
    if (tau < 1.0) {
      // τ: 0.0 → 1.0 で奥から滑らかに出現（p=0.15 付近ですでにハッキリ視認可能）
      alpha = Math.sin((Math.PI * 0.5) * Math.min(1, tau / 0.85));
    } else {
      // τ: 1.0 → 2.0 で外枠に向かって拡大し、外枠に重なる直前 (τ > 1.75) で外枠へ溶け込む
      if (tau > 1.72) {
        alpha = Math.max(0, 1.0 - (tau - 1.72) / 0.28);
      }
    }
    if (alpha <= 0.01) return;

    // 線の太さも遠近スケールに連動して手前に来るほど力強くなる
    const scaleFactor = 0.65 + 0.55 * sq.u;
    const strokeW = Math.max(1.4, S * 0.036 * scaleFactor);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = `rgba(236, 206, 168, ${Math.min(0.95, 0.72 * glowBoost)})`;
    ctx.shadowBlur = S * 0.07 * glowBoost * scaleFactor;
    ctx.lineWidth = strokeW;
    // 外枠に近づくにつれて純白 (#ffffff) からシャンパンゴールド (#eed3b3) へわずかに馴染む
    if (tau > 1.55) {
      ctx.strokeStyle = '#f5e2c8';
    } else {
      ctx.strokeStyle = '#ffffff';
    }
    ctx.lineJoin = 'round';
    ctx.strokeRect(
      sq.x0 + strokeW * 0.35,
      sq.y0 + strokeW * 0.35,
      Math.max(1, sq.w - strokeW * 0.7),
      Math.max(1, sq.h - strokeW * 0.7)
    );
    ctx.restore();
  };

  // 奥から湧き上がる次の□ (sqB) と、外枠へ拡大していく現在の□ (sqA) を描画
  if (tauB > 0.005) {
    drawInnerCubeSquare(sqB, tauB);
  }
  drawInnerCubeSquare(sqA, tauA);

  ctx.restore();
}

/**
 * テサラクト・アニメーション管理コントローラ
 */
const TetheractAnimator = {
  canvases: new Set(),
  isActive: false,
  targetCycles: 0,
  rafId: null,
  cycle: 0.0, // 連続累積サイクル数 (整数部が周回数、小数部 0.0〜1.0 が現在の拡大位相)
  glow: 1.0,
  lastTs: 0,

  registerCanvas(canvasEl) {
    if (!canvasEl) return;
    this.canvases.add(canvasEl);
    this.renderOnce(canvasEl);
    if (this.isActive || this.cycle < this.targetCycles) {
      this._ensureLoop();
    }
  },

  renderOnce(canvasEl) {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    drawTetheractIconFrame(ctx, canvasEl.width, this.cycle, this.glow);
  },

  renderAll() {
    for (const c of this.canvases) {
      if (!c.isConnected && c.id !== 'splashTetheractCanvas') {
        this.canvases.delete(c);
        continue;
      }
      this.renderOnce(c);
    }
  },

  setActive(active) {
    const next = Boolean(active);
    if (this.isActive === next) return;
    this.isActive = next;
    if (!next) {
      // アクティブ解除時は現在の拡大ループを次の整数周期（中の□が外枠に重なり、奥の□が定位置に来る地点）まで完走させて止める
      const frac = this.cycle - Math.floor(this.cycle);
      if (frac > 0.01) {
        this.targetCycles = Math.max(this.targetCycles, Math.ceil(this.cycle));
      }
    }
    this._ensureLoop();
  },

  pulse(cyclesCount = 1) {
    // クリックやホバー、フォルダ切替時は最低1周（中の□が外枠へ拡大して次の□に入れ替わるループ）を実行
    const addCycles = cyclesCount > 10 ? 1 : Math.max(1, Math.round(cyclesCount));
    const base = Math.max(this.cycle, Math.floor(this.cycle));
    this.targetCycles = Math.max(this.targetCycles, Math.ceil(base + 0.05));
    if (this.targetCycles - this.cycle < 0.35) {
      this.targetCycles += addCycles;
    }
    this._ensureLoop();
  },

  _ensureLoop() {
    if (this.rafId != null) return;
    this.lastTs = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.06, Math.max(0.001, (now - this.lastTs) / 1000));
      this.lastTs = now;

      const splashEl = document.getElementById('startupSplashOverlay');
      const splashVisible = Boolean(splashEl && !splashEl.classList.contains('is-hidden'));
      const continuousActive = this.isActive || splashVisible;

      // 1ループあたり約 0.95秒（中□→外□への拡大と奥からの次□出現が気持ちよく見える速度）
      const baseSpeed = 1.05;

      if (continuousActive) {
        this.cycle += dt * baseSpeed;
        this.targetCycles = Math.ceil(this.cycle);
        this.glow += (1.22 - this.glow) * Math.min(1, dt * 6.0);
      } else if (this.cycle < this.targetCycles) {
        const remaining = this.targetCycles - this.cycle;
        // 定位置（整数周期）への着地時のみ滑らかに減速してピタッと止まる
        const speedMult = remaining < 0.25 ? Math.max(0.38, remaining / 0.25) : 1.0;
        this.cycle = Math.min(this.targetCycles, this.cycle + dt * baseSpeed * speedMult);
        this.glow += (1.0 - this.glow) * Math.min(1, dt * 6.0);
      } else {
        this.cycle = Math.round(this.cycle);
        this.glow = 1.0;
        this.renderAll();
        this.rafId = null;
        return;
      }

      this.renderAll();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  },
};

function pulseHeaderTetheract(cycles = 1) {
  TetheractAnimator.pulse(cycles);
}

// 統合アクティビティ・ドック状態管理
const _globalActivities = new Map();
const _ACTIVITY_PRIORITY = ['maint', 'storage', 'scan', 'ai', 'diff', 'fetch'];

/**
 * 統合アクティビティ・ドックに処理状態を登録・更新する
 * @param {string} key アクティビティ識別子 ('scan' | 'ai' | 'storage' | 'fetch' | 'diff' | 'maint')
 * @param {object} opts { title, countText, percent, filename, indeterminate, onCancel }
 */
function setGlobalActivity(key, opts = {}) {
  if (!key) return;
  _globalActivities.set(key, {
    key,
    title: opts.title || '',
    countText: opts.countText != null ? String(opts.countText) : '',
    percent: typeof opts.percent === 'number' ? Math.max(0, Math.min(100, Math.round(opts.percent))) : null,
    filename: opts.filename != null ? String(opts.filename) : '',
    indeterminate: Boolean(opts.indeterminate),
    onCancel: typeof opts.onCancel === 'function' ? opts.onCancel : null,
    updatedAt: performance.now(),
  });
  _renderGlobalActivityDock();
}

/**
 * 統合アクティビティ・ドックから処理状態を解除する
 * @param {string} key
 */
function clearGlobalActivity(key) {
  if (!key) return;
  _globalActivities.delete(key);
  _renderGlobalActivityDock();
}

function _renderGlobalActivityDock() {
  const banner = document.getElementById('globalScanBanner');
  if (!banner) return;

  if (_globalActivities.size === 0) {
    banner.style.setProperty('display', 'none', 'important');
    banner.classList.remove('is-indeterminate');
    TetheractAnimator.setActive(false);
    return;
  }

  // 優先度順に最優先のアクティビティを選出
  let activeItem = null;
  for (const priKey of _ACTIVITY_PRIORITY) {
    if (_globalActivities.has(priKey)) {
      activeItem = _globalActivities.get(priKey);
      break;
    }
  }
  if (!activeItem) {
    activeItem = Array.from(_globalActivities.values())[0];
  }

  const titleEl = document.getElementById('globalScanTitle');
  const countEl = document.getElementById('globalScanCount');
  const pctEl = document.getElementById('globalScanPercent');
  const fileEl = document.getElementById('globalScanFilename');
  const fillEl = document.getElementById('globalScanFill');
  const cancelBtn = document.getElementById('globalActivityCancelBtn');

  const extraCount = _globalActivities.size > 1 ? ` (+${_globalActivities.size - 1})` : '';
  if (titleEl) {
    titleEl.textContent = `${activeItem.title || t('common.processing', '処理中...')}${extraCount}`;
  }
  if (countEl) {
    countEl.textContent = activeItem.countText || '';
  }
  if (pctEl) {
    if (!activeItem.indeterminate && activeItem.percent != null) {
      pctEl.textContent = `${activeItem.percent}%`;
      pctEl.style.display = '';
    } else {
      pctEl.textContent = '';
      pctEl.style.display = 'none';
    }
  }
  if (fileEl) {
    fileEl.textContent = activeItem.filename || '';
  }
  if (fillEl) {
    if (activeItem.indeterminate) {
      banner.classList.add('is-indeterminate');
    } else {
      banner.classList.remove('is-indeterminate');
      fillEl.style.width = `${activeItem.percent != null ? activeItem.percent : 0}%`;
    }
  }
  if (cancelBtn) {
    if (activeItem.onCancel) {
      cancelBtn.style.display = 'inline-flex';
      cancelBtn.textContent = t('folder.ai_cancel', '中断');
      cancelBtn.onclick = activeItem.onCancel;
    } else {
      cancelBtn.style.display = 'none';
      cancelBtn.onclick = null;
    }
  }

  banner.style.setProperty('display', 'block', 'important');
  TetheractAnimator.setActive(true);
}

/**
 * 起動スプラッシュスクリーンの進捗メッセージを更新する
 */
function updateStartupSplash(opts = {}) {
  const msgEl = document.getElementById('splashStatusMessage');
  const pctEl = document.getElementById('splashStatusPercent');
  const fillEl = document.getElementById('splashProgressFill');
  const detailEl = document.getElementById('splashStatusDetail');

  if (msgEl && opts.message != null) {
    msgEl.textContent = opts.message;
  }
  if (pctEl && opts.percent != null) {
    pctEl.textContent = `${Math.round(opts.percent)}%`;
  }
  if (fillEl && opts.percent != null) {
    fillEl.style.width = `${Math.max(8, Math.min(100, Math.round(opts.percent)))}%`;
  }
  if (detailEl && opts.detail != null) {
    detailEl.textContent = opts.detail;
  }
}

/**
 * 起動スプラッシュスクリーンを滑らかにフェードアウトして閉じる
 */
let _splashDismissed = false;
let _splashShownAt = performance.now();

function dismissStartupSplash() {
  if (_splashDismissed) return;
  _splashDismissed = true;
  const overlay = document.getElementById('startupSplashOverlay');
  if (!overlay) return;

  updateStartupSplash({
    message: t('splash.ready', '準備完了'),
    percent: 100,
    detail: '',
  });

  // スプラッシュのテサラクトアニメーションが最低限視認できるよう最小表示時間を確保
  const elapsed = performance.now() - _splashShownAt;
  const minDisplayMs = 680;
  const waitMs = Math.max(120, minDisplayMs - elapsed);

  setTimeout(() => {
    overlay.classList.add('is-hidden');
    // メイン画面登場時に左上ヘッダーのテサラクトアイコンも余韻パルスして定位置に収まる
    pulseHeaderTetheract(1200);
  }, waitMs);
}

function initTetheractActivityUI() {
  _splashShownAt = performance.now();
  const headerCanvas = document.getElementById('headerTetheractCanvas');
  const splashCanvas = document.getElementById('splashTetheractCanvas');
  const logoEl = document.getElementById('headerAppLogo') || document.querySelector('.logo');

  if (headerCanvas) {
    TetheractAnimator.registerCanvas(headerCanvas);
    if (logoEl) {
      logoEl.classList.add('tetheract-anim-ready');
      logoEl.addEventListener('mouseenter', () => {
        pulseHeaderTetheract(1);
      });
      logoEl.addEventListener('click', () => {
        pulseHeaderTetheract(1);
      });
    }
  }
  if (splashCanvas) {
    TetheractAnimator.registerCanvas(splashCanvas);
    TetheractAnimator.pulse(2);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootCommonUI);
} else {
  bootCommonUI();
}
