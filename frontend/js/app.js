/**
 * Photo Manager - コアオーケストレータ & メインビュー
 * 定数・state・elements・ヘルパー: /js/common.js
 * 複数選択・コンテキストメニュー:   /js/selection.js
 * インスペクター・EXIF・GPS:       /js/inspector.js
 * ライトボックス・ズーム・フィルム: /js/lightbox.js
 * フォルダツリー・スキャン・設定:   /js/folder_tree.js
 * フィルタチップ・ポップオーバー:   /js/filter_chips.js
 * メディアVSN・フォルダ差分検知:    /js/media_volumes.js
 * 3段階セキュリティUI:              /js/security_ui.js
 * 週次バックアップ・リンク消失消去: /js/maintenance_reminders.js
 * フィルタプリセット:               /js/presets.js
 * スライドショー:                   /js/slideshow.js
 */

/**
 * 永続化されたユーザー表示設定の復元
 */
function initUserSettings() {
  // 1. ソート順
  const savedSort = localStorage.getItem('pm_sort_by');
  if (savedSort) {
    state.sortBy = savedSort;
    if (elements.sortBySelect) elements.sortBySelect.value = savedSort;
  }

  // 2. サムネイルサイズ
  const savedSize = localStorage.getItem('pm_thumbnail_size');
  if (savedSize) {
    if (elements.thumbnailSizeSlider) elements.thumbnailSizeSlider.value = savedSize;
    document.documentElement.style.setProperty('--thumbnail-size', `${savedSize}px`);
  }

  // 3. 表示レイアウトモード
  const savedViewMode = localStorage.getItem('pm_view_mode');
  if (savedViewMode && ['grid', 'masonry', 'mount'].includes(savedViewMode)) {
    setLayoutMode(savedViewMode);
  }

  // 4. 情報表示モード (クリーン表示)
  const savedMinimal = localStorage.getItem('pm_minimal_view');
  if (savedMinimal === 'true') {
    toggleMinimalView(true);
  }

  // 5. スタック表示
  const savedStacked = localStorage.getItem('pm_stacked');
  if (savedStacked !== null) {
    state.isStacked = savedStacked === 'true';
    if (elements.toggleStackBtn) {
      elements.toggleStackBtn.classList.toggle('active', state.isStacked);
    }
  }

  // 5.5 左ペイン（サイドバー）の開閉
  const savedSidebar = localStorage.getItem('pm_sidebar_open');
  const isSidebarOpen = savedSidebar !== null ? savedSidebar === 'true' : true;
  toggleSidebar(isSidebarOpen);

  // 6. 右ペイン（インスペクタ）の開閉
  const savedInspector = localStorage.getItem('pm_inspector_open');
  const isInspectorOpen = savedInspector !== null ? savedInspector === 'true' : true;
  toggleInspector(isInspectorOpen);

  // 7. タグ種別フィルタ (manual / ai / all) - デフォルトは 'manual'
  const savedTagSrc = localStorage.getItem('pm_tag_source_filter');
  if (savedTagSrc && ['manual', 'ai', 'all'].includes(savedTagSrc)) {
    state.tagSourceFilter = savedTagSrc;
  } else {
    state.tagSourceFilter = 'manual';
  }
  const segControl = document.getElementById('tagTypeSegmentedControl');
  if (segControl) {
    segControl.querySelectorAll('.tag-segment-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sourceFilter === state.tagSourceFilter);
    });
  }

  // 8. カラーフィルタエキスパンダの開閉状態復元 (デフォルトは閉じ: false)
  const savedColorExp = localStorage.getItem('pm_color_filter_expanded');
  const isColorExp = savedColorExp === 'true'; // 未設定は false (閉じ)
  toggleColorPaletteExpander(isColorExp);
}

/**
 * バージョン情報の取得と表示
 */

/**
 * 初期化処理
 */
async function initializeApp() {
  initTheme();
  initAppVersion();
  let startupExiflessMig = null;
  if (typeof updateStartupSplash === 'function') {
    try {
      const stRes = await fetch('/api/startup/status');
      if (stRes.ok) {
        const st = await stRes.json();
        if (st && st.exifless_migration) {
          startupExiflessMig = st.exifless_migration;
        }
        if (st && st.message) {
          updateStartupSplash({
            message: st.message,
            percent: st.percent || 35,
            detail: st.detail || '',
          });
        }
      }
    } catch (_) {}
    updateStartupSplash({
      message: t('splash.loading_library', 'ライブラリを読み込み中...'),
      percent: 55,
      detail: t('splash.loading_library_detail', '写真とタグのインデックスを取得しています'),
    });
    if (startupExiflessMig && (startupExiflessMig.updated > 0 || startupExiflessMig.merged > 0)) {
      setTimeout(() => {
        const uCnt = startupExiflessMig.updated || 0;
        const mCnt = startupExiflessMig.merged || 0;
        const mergePart = mCnt > 0 ? `し、重複 ${mCnt}件を統合` : '';
        showToast(`Exifなし画像 ${uCnt}枚の識別キーを更新${mergePart}しました`, 'info', 4500);
      }, 900);
    }
  }
  try {
    if (typeof ensureAppUnlockedOnStartup === 'function') {
      await ensureAppUnlockedOnStartup();
    }
    setupEventListeners();
    initUserSettings();
    initHeartbeat();
    await refreshAll();
  } finally {
    if (typeof dismissStartupSplash === 'function') {
      dismissStartupSplash();
    }
  }
  setTimeout(() => {
    checkWeeklyBackupReminderOnStartup();
  }, 1500);
}

/**
 * 全データの取得と画面更新
 */
async function refreshAll() {
  // 1. まずメイン画面の写真一覧とタグ（件数バッジ）を最優先で取得・描画し、
  //    起動直後のバックエンドGIL・ディスクI/O競合を回避して体感表示速度を最大化する
  await Promise.all([
    fetchPhotos(),
    fetchTags(),
  ]);

  if (typeof dismissStartupSplash === 'function') {
    dismissStartupSplash();
  }

  // 2. 写真グリッドの初期描画完了後、サイドバーのフォルダツリー・タイムライン等を取得する
  await Promise.all([
    fetchTimeline(),
    fetchFolders(),
    fetchCameras(),
    fetchUnlinkedCount(),
    fetchDuplicatesCount(),
    (typeof fetchStorageFolders === 'function' ? fetchStorageFolders() : Promise.resolve()),
    (window.fetchFilterPresets ? window.fetchFilterPresets() : Promise.resolve()),
    (window.loadLocationTree ? window.loadLocationTree() : Promise.resolve()),
  ]);
}

let _fetchPhotosAbortController = null;
let _fetchPhotosSeq = 0;
let _fetchPhotosPendingPromise = null;
let _fetchPhotosQueued = false;

/**
 * 写真一覧の取得（同一イベントループ内の連続呼び出しは queueMicrotask で1回に合流）
 */
function fetchPhotos() {
  if (_fetchPhotosQueued && _fetchPhotosPendingPromise) {
    return _fetchPhotosPendingPromise;
  }
  _fetchPhotosQueued = true;
  _fetchPhotosPendingPromise = new Promise((resolve) => {
    queueMicrotask(() => {
      _fetchPhotosQueued = false;
      _fetchPhotosPendingPromise = null;
      _executeFetchPhotos().then(resolve, resolve);
    });
  });
  return _fetchPhotosPendingPromise;
}

/**
 * 写真一覧の取得本体 (タグの排他検索・複数年月OR・カメラ機種ORパラメータ対応)
 */
async function _executeFetchPhotos() {
  const mySeq = ++_fetchPhotosSeq;
  if (_fetchPhotosAbortController) {
    try { _fetchPhotosAbortController.abort(); } catch (_) {}
  }
  const abortController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  _fetchPhotosAbortController = abortController;

  let fetchActivityTimer = null;
  if (typeof setGlobalActivity === 'function') {
    fetchActivityTimer = setTimeout(() => {
      if (mySeq !== _fetchPhotosSeq) return;
      const targetName = (state.currentFilter && (state.currentFilter.titleText || state.currentFilter.value)) || '';
      setGlobalActivity('fetch', {
        title: t('activity.loading_photos', '写真を読み込み中...'),
        countText: '',
        percent: null,
        filename: targetName,
        indeterminate: true,
      });
    }, 150);
  }
  try {
    const params = new URLSearchParams();
    if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
      params.append('folder', state.currentFilter.value);
    } else if (state.currentFilter.type === 'folder_exclude' && state.currentFilter.value) {
      params.append('exclude_folder', state.currentFilter.value);
    }
    if ((state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude') && state.currentFilter.volumeSerial) {
      params.append('volume_serial', state.currentFilter.volumeSerial);
      params.append('serial_mode', state.currentFilter.serialMode || 'match');
    }
    
    if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
      params.append('year_months', Array.from(state.selectedYearMonths).join(','));
    } else if (state.currentFilter.type === 'year_month' && state.currentFilter.value) {
      params.append('year_month', state.currentFilter.value);
    }

    if (state.selectedDates && state.selectedDates.size > 0) {
      params.append('dates', Array.from(state.selectedDates).join(','));
    }

    // カメラ機種フィルタ（3ステート: 含む / 除外 ＋ 後方互換 selectedCameras）
    const includeCams = new Set();
    const excludeCams = new Set();
    if (state.cameraFilters && state.cameraFilters.size > 0) {
      state.cameraFilters.forEach((mode, cam) => {
        if (mode === 'include') includeCams.add(cam);
        else if (mode === 'exclude') excludeCams.add(cam);
      });
    }
    if (state.selectedCameras && state.selectedCameras.size > 0) {
      state.selectedCameras.forEach(cam => {
        if (!excludeCams.has(cam)) includeCams.add(cam);
      });
    }
    if (state.currentFilter.type === 'camera' && state.currentFilter.value) {
      includeCams.add(state.currentFilter.value);
    }
    if (includeCams.size > 0) {
      params.append('cameras', Array.from(includeCams).join(','));
    }
    if (excludeCams.size > 0) {
      params.append('excluded_cameras', Array.from(excludeCams).join(','));
    }

    // レンズフィルタ（3ステート: 含む / 除外）
    const includeLenses = new Set();
    const excludeLenses = new Set();
    if (state.lensFilters && state.lensFilters.size > 0) {
      state.lensFilters.forEach((mode, lensKey) => {
        if (mode === 'include') includeLenses.add(lensKey);
        else if (mode === 'exclude') excludeLenses.add(lensKey);
      });
    }
    if (state.selectedLenses && state.selectedLenses.size > 0) {
      state.selectedLenses.forEach(lensKey => {
        if (!excludeLenses.has(lensKey)) includeLenses.add(lensKey);
      });
    }
    if (includeLenses.size > 0) {
      params.append('lenses', Array.from(includeLenses).join(','));
    }
    if (excludeLenses.size > 0) {
      params.append('excluded_lenses', Array.from(excludeLenses).join(','));
    }

    // ラボ抽出フィルタ（太陽高度・手ブレ注意・歴代の今日・焦点距離帯・F値帯）
    if (state.labFilter) {
      params.append('lab_filter', state.labFilter);
    }
    if (state.onThisDay) {
      params.append('on_this_day', state.onThisDay);
    }
    if (state.focalRange) {
      params.append('focal_range', state.focalRange);
    }
    if (state.apertureRange) {
      params.append('aperture_range', state.apertureRange);
    }
    
    if (state.ratingFilter && state.ratingFilter.size > 0) {
      params.append('ratings', Array.from(state.ratingFilter).join(','));
    }

    if (state.attrFilter && state.attrFilter !== 'all') {
      params.append('attr_filter', state.attrFilter);
    }

    if (state.searchQuery.trim()) {
      params.append('search', state.searchQuery.trim());
    }

    // 場所フィルタ
    if (state.activeLocation) {
      if (state.activeLocation.no_location) {
        params.append('no_location', 'true');
      } else {
        if (state.activeLocation.country) params.append('country', state.activeLocation.country);
        if (state.activeLocation.state) params.append('state', state.activeLocation.state);
        if (state.activeLocation.city) params.append('city', state.activeLocation.city);
      }
    }

    // 未分類フィルタ
    if (state.untaggedOnly) {
      params.append('untagged', 'true');
    } else {
      // 3ステートタグ排他フィルタ（含む / 除外）
      const includeList = [];
      const excludeList = [];
      state.tagFilters.forEach((mode, tag) => {
        if (mode === 'include') includeList.push(tag);
        else if (mode === 'exclude') excludeList.push(tag);
      });

      if (includeList.length > 0) {
        params.append('include_tags', includeList.join(','));
        if (state.tagAndRoots && state.tagAndRoots.size > 0) {
          params.append('tag_and_roots', Array.from(state.tagAndRoots).join(','));
        }
        if (state.tagInterGroupMode === 'or') {
          params.append('tag_group_op', 'or');
        }
      }
      if (excludeList.length > 0) {
        params.append('exclude_tags', excludeList.join(','));
      }
    }

    syncStackToggleButtonUI();
    params.append('sort_by', state.sortBy);
    params.append('stacked', isEffectiveStacked() ? 'true' : 'false');

    if (state.connectionFilter === 'missing') {
      params.append('missing_only', 'true');
    } else if (state.connectionFilter !== 'duplicates') {
      const connSet = (state.connectionStates instanceof Set && state.connectionStates.size > 0)
        ? state.connectionStates
        : new Set(['online', 'offline', 'unlinked']);
      const hasFolderOrVol = Boolean(state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude' || state.currentFilter.volumeSerial));
      if (state.connectionFilter === 'unlinked' || (connSet.size === 1 && connSet.has('unlinked') && !hasFolderOrVol)) {
        params.append('unlinked_only', 'true');
      } else if (connSet.has('unlinked') && !hasFolderOrVol) {
        params.append('include_unlinked', 'true');
      }
    } else if (state.connectionFilter === 'unlinked') {
      params.append('unlinked_only', 'true');
    } else if (state.connectionFilter === 'duplicates') {
      params.append('duplicates_only', 'true');
    }

    const response = await fetch(`/api/photos?${params.toString()}`, abortController ? { signal: abortController.signal } : undefined);
    if (mySeq !== _fetchPhotosSeq) return;

    if (!response.ok) throw new Error('写真の取得に失敗しました');
    const data = await response.json();
    if (mySeq !== _fetchPhotosSeq) return;

    // 接続状態フィルタ（接続中のみ / 未接続のみ / 見つからない写真 / リンク消失）
    if (state.connectionFilter === 'online') {
      state.photos = data.photos.filter(p => !p.is_offline && !p.is_missing && !p.is_unlinked);
    } else if (state.connectionFilter === 'custom_conn' || (state.connectionFilter === 'all' && state.connectionStates instanceof Set && state.connectionStates.size < 3)) {
      const connSet = state.connectionStates;
      state.photos = data.photos.filter(p => {
        if (p.is_unlinked) return connSet.has('unlinked');
        if (p.is_offline) return connSet.has('offline');
        return !p.is_missing && connSet.has('online');
      });
    } else if (state.connectionFilter === 'offline') {
      state.photos = data.photos.filter(p => p.is_offline);
    } else if (state.connectionFilter === 'missing') {
      state.photos = data.photos.filter(p => p.is_missing);
    } else if (state.connectionFilter === 'unlinked') {
      state.photos = data.photos;
    } else {
      state.photos = data.photos;
    }
    if (typeof rebuildPhotoByIdIndex === 'function') {
      rebuildPhotoByIdIndex();
    }
    state.isLimitReached = MAX_DISPLAY_PHOTOS > 0 && data.photos.length >= MAX_DISPLAY_PHOTOS;
    // リンク消失写真一括消去ボタンの表示切替（updateViewHeader内のrenderActiveFilterChipsより先に実行してバー表示を同期）
    syncPurgeUnlinkedButtonUI();
    renderPhotoGrid();
    updateViewHeader();
    syncOpenInspectorAndLightboxWithLatestPhotos();
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    console.error('写真読み込みエラー:', error);
  } finally {
    if (fetchActivityTimer) clearTimeout(fetchActivityTimer);
    if (mySeq === _fetchPhotosSeq && typeof clearGlobalActivity === 'function') {
      clearGlobalActivity('fetch');
    }
  }
}

/**
 * fetchPhotos() 完了後に開いているインスペクタおよびライトボックスを最新写真データで再同期する
 */
function syncOpenInspectorAndLightboxWithLatestPhotos() {
  if (typeof updateInspectorView === 'function') {
    updateInspectorView();
  }
  if (state.currentPhotoIndex >= 0 && Array.isArray(state.photos)) {
    const lbPhoto = typeof getCurrentLightboxPhoto === 'function'
      ? getCurrentLightboxPhoto()
      : state.photos[state.currentPhotoIndex];
    if (lbPhoto) {
      const freshTarget = (typeof findPhotoByIdAnywhere === 'function'
        ? findPhotoByIdAnywhere(lbPhoto.id)
        : null) || state.photos[state.currentPhotoIndex];
      if (freshTarget) {
        if (elements.lightboxFileName && freshTarget.file_name) {
          elements.lightboxFileName.textContent = freshTarget.file_name;
        }
        if (elements.exifFileName && freshTarget.file_name) {
          elements.exifFileName.textContent = freshTarget.file_name;
        }
        if (typeof renderLightboxTags === 'function') {
          renderLightboxTags(freshTarget);
        }
        if (typeof updateLightboxRating === 'function') {
          updateLightboxRating(freshTarget.rating);
        }
      }
    }
  }
}
window.syncOpenInspectorAndLightboxWithLatestPhotos = syncOpenInspectorAndLightboxWithLatestPhotos;

/**
 * タグ集計データを state および全関連UI（左ペイン・設定タグツリーエディタ・右インスペクタ）へ即時反映する
 */
function applyTagsSummaryData(data) {
  if (!data || !Array.isArray(data.tags)) return;
  state.availableTags = data.tags;
  if (elements.untaggedPhotosCount && data.untagged_count !== undefined) {
    elements.untaggedPhotosCount.textContent = data.untagged_count;
  }
  if (elements.totalPhotosCount && data.total_count !== undefined) {
    elements.totalPhotosCount.textContent = data.total_count;
  }
  if (elements.onlinePhotosCount && data.online_count !== undefined) {
    elements.onlinePhotosCount.textContent = data.online_count;
  }
  if (elements.offlinePhotosCount && data.offline_count !== undefined) {
    elements.offlinePhotosCount.textContent = data.offline_count;
  }
  if (elements.unlinkedPhotosCount && data.unlinked_count !== undefined) {
    elements.unlinkedPhotosCount.textContent = data.unlinked_count;
    elements.unlinkedPhotosCount.classList.toggle('badge-warning', data.unlinked_count > 0);
  }
  if (elements.folderTreeUnlinkedSection && data.unlinked_count !== undefined) {
    elements.folderTreeUnlinkedSection.style.display = data.unlinked_count > 0 ? 'block' : 'none';
  }
  if (elements.folderTreeUnlinkedCount && data.unlinked_count !== undefined) {
    elements.folderTreeUnlinkedCount.textContent = data.unlinked_count;
  }
  renderTagList();

  // 設定＆タグツリーエディタが開いていれば即時再描画
  const settingsModal = elements.dbMaintenanceModal || document.getElementById('dbMaintenanceModal');
  if (settingsModal && settingsModal.style.display !== 'none' && typeof window.renderSettingsTagTreeEditor === 'function') {
    window.renderSettingsTagTreeEditor();
  }

  // 右インスペクタのクイックタグツリーも即時同期
  if (state.isInspectorOpen && typeof renderInspectorQuickTree === 'function') {
    if (state.selectedPhotoIds && state.selectedPhotoIds.size > 1 && elements.batchQuickTree && typeof batchToggleTag === 'function') {
      renderInspectorQuickTree(elements.batchQuickTree, (tName) => {
        batchToggleTag(tName, true);
      });
    } else if (state.activeInspectorPhotoId && elements.inspectorQuickTree && typeof addTagToPhoto === 'function') {
      const activePhoto = (typeof findPhotoByIdAnywhere === 'function'
        ? findPhotoByIdAnywhere(state.activeInspectorPhotoId)
        : null) || (typeof getPhotoById === 'function'
        ? getPhotoById(state.activeInspectorPhotoId)
        : state.photos.find(p => p.id === state.activeInspectorPhotoId));
      if (activePhoto) {
        renderInspectorQuickTree(elements.inspectorQuickTree, (tName) => {
          addTagToPhoto(activePhoto.id, tName, activePhoto);
        });
      }
    }
  }
}
window.applyTagsSummaryData = applyTagsSummaryData;

/**
 * タグ一覧および未分類件数の取得と描画
 */
async function fetchTags() {
  try {
    const response = await fetch('/api/tags', { cache: 'no-store' });
    if (!response.ok) throw new Error('タグ一覧取得失敗');
    const data = await response.json();
    applyTagsSummaryData(data);
  } catch (error) {
    console.error('タグ読み込みエラー:', error);
  }
}
window.fetchTags = fetchTags;
window.fetchPhotos = fetchPhotos;
window.loadPhotos = fetchPhotos;

/**
 * タイムライン情報の取得と描画
 */
async function fetchTimeline() {
  try {
    if (typeof window.fetchCalendarSummary === 'function') {
      window.fetchCalendarSummary();
    }
    const response = await fetch('/api/timeline');
    if (!response.ok) throw new Error('タイムライン取得失敗');
    const data = await response.json();
    renderTimeline(data.timeline);
  } catch (error) {
    console.error('タイムライン取得エラー:', error);
  }
}

/**
 * フォルダ一覧の取得と描画
 * ツリー表示は folder_tree.js（/api/folder-tree）が担う。/api/folders の結果は
 * 未接続警告バナー・空状態表示・「展開」ボタン用に state.rawFoldersData へ保持する。
 */
function syncCurrentFilterOfflineState() {
  if (state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude')) {
    const cf = state.currentFilter;
    const vsn = cf.volumeSerial ? String(cf.volumeSerial).toUpperCase() : '';
    if (vsn && Array.isArray(state.managedVolumes)) {
      const matchedVol = state.managedVolumes.find(v => String(v.volume_serial || '').toUpperCase() === vsn);
      if (matchedVol) {
        cf.isOffline = !matchedVol.is_online;
        if (matchedVol.is_online && matchedVol.drive_letter && cf.value && /^[A-Za-z]:/.test(cf.value)) {
          const newDrivePrefix = matchedVol.drive_letter.slice(0, 2);
          if (cf.value.slice(0, 2).toUpperCase() !== newDrivePrefix.toUpperCase()) {
            cf.value = newDrivePrefix + cf.value.slice(2);
          }
        }
      }
    } else if (cf.value && Array.isArray(state.rawFoldersData)) {
      const curNorm = cf.value.replace(/\\/g, '/').toLowerCase();
      const matchedFolder = state.rawFoldersData.find(f => (f.directory_path || '').replace(/\\/g, '/').toLowerCase() === curNorm);
      if (matchedFolder) {
        cf.isOffline = Boolean(matchedFolder.is_offline);
      }
    }
    updateFolderWarningBanner();
  }
}

async function fetchFolders() {
  const loadFolderSummary = async () => {
    try {
      const response = await fetch('/api/folders?fast=1');
      if (!response.ok) throw new Error('フォルダ一覧取得失敗');
      const data = await response.json();
      state.rawFoldersData = data.folders || [];
    } catch (error) {
      console.error('フォルダ取得エラー:', error);
    }
  };
  await Promise.all([
    loadFolderSummary(),
    refreshFolderTree(),
    (typeof fetchManagedVolumes === 'function' ? fetchManagedVolumes() : Promise.resolve()),
  ]);
}


// グリッドの段階的チャンク描画および行単位2D仮想スクロール状態
let renderedGridCount = 0;
let renderGridTaskId = null;
let _gridScrollListenerBound = false;
let _gridScrollRafId = null;
let _gridResizeRafId = null;
let _gridSliderRafId = null;
let _gridResizeObserver = null;

const VIRTUAL_GRID_MIN_PHOTOS = 300;
const VIRTUAL_GRID_OVERSCAN_ROWS = 9;
const VIRTUAL_GRID_HYSTERESIS_ROWS = 4;

const _gridVirtualState = {
  enabled: false,
  cols: 4,
  rowPitch: 260,
  rowGap: 16,
  startIdx: -1,
  endIdx: -1,
  topSpacer: null,
  bottomSpacer: null,
  metricsDirty: true,
  calibrated: false,
  lastGridWidth: 0,
};

/**
 * サムネイル画像のロード完了時にアスペクト比を自動補正
 * ブラウザが実際にデコードした実寸法（naturalWidth / naturalHeight）はExif回転・クロップ適用済みの絶対値であるため、
 * DB寸法と万一差異があった場合でも常に正確なアスペクト比へ同期する。
 */
function onThumbImageLoad(img) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const card = img.closest('.photo-card');
  if (!card) return;
  const isPort = img.naturalHeight > img.naturalWidth;
  const ratio = Math.max(0.2, Math.min(5.0, img.naturalWidth / img.naturalHeight));
  const aspectCss = `${img.naturalWidth} / ${img.naturalHeight}`;
  const aspectRatio = ratio.toFixed(4);
  if (
    card.classList.contains(isPort ? 'is-portrait' : 'is-landscape') &&
    card.style.getPropertyValue('--photo-aspect') === aspectCss &&
    card.style.getPropertyValue('--photo-aspect-ratio') === aspectRatio
  ) {
    return;
  }
  card.classList.toggle('is-portrait', isPort);
  card.classList.toggle('is-landscape', !isPort);
  card.style.setProperty('--photo-aspect', aspectCss);
  card.style.setProperty('--photo-aspect-ratio', aspectRatio);
}
window.onThumbImageLoad = onThumbImageLoad;

/**
 * 写真オブジェクトからカード下部の手動タグバッジHTMLを生成する
 */
function buildCardTagsHtml(photo) {
  if (!photo) return '';
  const detailsMap = {};
  if (Array.isArray(photo.tag_details)) {
    photo.tag_details.forEach(d => { detailsMap[d.tag] = d; });
  }
  const manualLeafTags = getLeafTags(photo.tags).filter(t => {
    const detail = detailsMap[t];
    return !(detail && detail.source === 'ai');
  });
  if (manualLeafTags.length === 0) return '';
  return '<div class="card-tags">' +
    manualLeafTags.slice(0, 3).map(t => {
      const colorConf = COLOR_TAG_MAP[t];
      const colorDot = colorConf ? `<span class="tag-color-dot" style="background:${colorConf.color};"></span>` : '';
      return `<span class="card-tag-badge">${colorDot}${escapeHtml(t)}</span>`;
    }).join('') +
    (manualLeafTags.length > 3 ? `<span class="card-tag-badge">+${manualLeafTags.length - 3}</span>` : '') +
    '</div>';
}
window.buildCardTagsHtml = buildCardTagsHtml;

/**
 * グリッド上の対象写真カードのタグバッジ領域のみを部分更新する（全カード再生成を回避）
 */
function updateCardTagsDirectly(photoId) {
  const numId = Number(photoId);
  if (!numId) return;
  let targetCardPhoto = typeof getPhotoById === 'function' ? getPhotoById(numId) : state.photos.find(p => p.id === numId);
  if (!targetCardPhoto && Array.isArray(state.photos)) {
    targetCardPhoto = state.photos.find(p => Array.isArray(p.stack_photos) && p.stack_photos.some(sp => sp.id === numId)) || null;
  }
  if (!targetCardPhoto) return;
  const grid = elements.photoGrid || document.getElementById('photoGrid');
  const card = grid ? grid.querySelector(`.photo-card[data-photo-id="${targetCardPhoto.id}"]`) : null;
  if (!card) return;
  const cardInfo = card.querySelector('.card-info');
  if (!cardInfo) return;
  const existingTagsEl = cardInfo.querySelector('.card-tags');
  const newTagsHtml = buildCardTagsHtml(targetCardPhoto);
  if (!newTagsHtml) {
    if (existingTagsEl) existingTagsEl.remove();
  } else if (existingTagsEl) {
    existingTagsEl.outerHTML = newTagsHtml;
  } else {
    cardInfo.insertAdjacentHTML('beforeend', newTagsHtml);
  }
}
window.updateCardTagsDirectly = updateCardTagsDirectly;

/**
 * 単一写真が現在有効なタグフィルタ条件に一致するかをローカル判定する（server/database/photos.py:1334-1431 と完全一致）
 */
function doesPhotoMatchActiveTagFilter(photo) {
  if (!photo) return false;
  const tagList = Array.isArray(photo.tags) ? photo.tags : [];
  const isColorTag = (t) => Boolean(t && Object.prototype.hasOwnProperty.call(COLOR_TAG_MAP, t));
  const hasTagOrChild = (targetTag) => tagList.some(t => t === targetTag || t.startsWith(targetTag + '/'));

  const colorInc = [];
  const generalInc = [];
  const colorExc = [];
  const generalExc = [];

  if (state.tagFilters && state.tagFilters.size > 0) {
    for (const [rawTag, mode] of state.tagFilters.entries()) {
      const t = String(rawTag || '').trim();
      if (!t) continue;
      if (mode === 'include') {
        if (isColorTag(t)) colorInc.push(t);
        else generalInc.push(t);
      } else if (mode === 'exclude') {
        if (isColorTag(t)) colorExc.push(t);
        else generalExc.push(t);
      }
    }
  }

  // 1. カラータグは複数色でも単一ORグループとして常に最上位AND、除外カラーも最上位AND除外 (photos.py:1347-1357)
  if (colorInc.length > 0 && !colorInc.some(cTag => tagList.includes(cTag))) {
    return false;
  }
  if (colorExc.some(cTag => tagList.includes(cTag))) {
    return false;
  }

  // 2. 未分類フィルタ: AIタグおよびカラータグを除く手動一般タグが1つも無いこと (photos.py:1359-1362)
  if (state.untaggedOnly) {
    const detailsMap = new Map();
    if (Array.isArray(photo.tag_details)) {
      photo.tag_details.forEach(d => {
        if (d && d.tag) detailsMap.set(d.tag, d);
      });
    }
    const hasManualGeneralTag = tagList.some(t => {
      if (!t || isColorTag(t)) return false;
      const detail = detailsMap.get(t);
      const src = (detail && detail.source) ? detail.source : 'manual';
      return src !== 'ai';
    });
    return !hasManualGeneralTag;
  }

  if (generalInc.length === 0 && generalExc.length === 0) {
    return true;
  }

  // 3. 一般タグ階層グループ判定 (photos.py:1364-1431)
  const andRootsSet = state.tagAndRoots instanceof Set ? state.tagAndRoots : new Set();
  const interGroupOr = String(state.tagInterGroupMode || 'and').trim().toLowerCase() === 'or';

  const includeByRoot = new Map();
  if (generalInc.length > 0) {
    const effectiveInc = generalInc.filter(
      t => !generalInc.some(other => other !== t && other.startsWith(t + '/'))
    );
    for (const tag of effectiveInc) {
      const rootParent = tag.split('/')[0].trim();
      let list = includeByRoot.get(rootParent);
      if (!list) {
        list = [];
        includeByRoot.set(rootParent, list);
      }
      if (!list.includes(tag)) list.push(tag);
    }
  }

  const excByRoot = new Map();
  for (const tag of generalExc) {
    const rootParent = tag.split('/')[0].trim();
    let list = excByRoot.get(rootParent);
    if (!list) {
      list = [];
      excByRoot.set(rootParent, list);
    }
    if (!list.includes(tag)) list.push(tag);
  }

  if (includeByRoot.size > 0) {
    const groupResults = [];
    for (const [rootParent, groupTags] of includeByRoot.entries()) {
      let matched = andRootsSet.has(rootParent)
        ? groupTags.every(t => hasTagOrChild(t))
        : groupTags.some(t => hasTagOrChild(t));
      if (matched && interGroupOr && includeByRoot.size > 1 && excByRoot.has(rootParent)) {
        if (excByRoot.get(rootParent).some(exTag => hasTagOrChild(exTag))) {
          matched = false;
        }
      }
      groupResults.push(matched);
    }
    const groupsOk = (interGroupOr && groupResults.length > 1)
      ? groupResults.some(Boolean)
      : groupResults.every(Boolean);
    if (!groupsOk) return false;
  }

  for (const [rootParent, exTags] of excByRoot.entries()) {
    if (interGroupOr && includeByRoot.size > 1 && includeByRoot.has(rootParent)) {
      continue;
    }
    if (exTags.some(exTag => hasTagOrChild(exTag))) {
      return false;
    }
  }

  return true;
}
window.doesPhotoMatchActiveTagFilter = doesPhotoMatchActiveTagFilter;

function _toNumericPhotoIdSet(ids) {
  const result = new Set();
  if (ids === null || ids === undefined) return result;
  if (typeof ids === 'number' || typeof ids === 'string') {
    const n = Number(ids);
    if (n) result.add(n);
    return result;
  }
  if (Array.isArray(ids) || ids instanceof Set) {
    for (const id of ids) {
      const n = Number(id);
      if (n) result.add(n);
    }
  }
  return result;
}

/**
 * 処理対象写真の末尾より後方で、除去されずに残る最初の写真IDを返す（末尾まで消える場合は直前の残存写真を返す）
 */
function findNextRemainingPhotoAfterTargets(targetPhotoIds, removedPhotoIds = null) {
  if (!Array.isArray(state.photos) || state.photos.length === 0) return null;
  const targetSet = _toNumericPhotoIdSet(targetPhotoIds);
  if (targetSet.size === 0) return null;
  const removedSet = removedPhotoIds !== null ? _toNumericPhotoIdSet(removedPhotoIds) : targetSet;

  const isTargetCard = (p) => {
    if (!p) return false;
    if (targetSet.has(Number(p.id))) return true;
    return Array.isArray(p.stack_photos) && p.stack_photos.some(sp => sp && targetSet.has(Number(sp.id)));
  };

  let lastTargetIdx = -1;
  for (let i = state.photos.length - 1; i >= 0; i--) {
    if (isTargetCard(state.photos[i])) {
      lastTargetIdx = i;
      break;
    }
  }
  if (lastTargetIdx === -1) return null;

  for (let i = lastTargetIdx + 1; i < state.photos.length; i++) {
    const p = state.photos[i];
    if (p && !removedSet.has(Number(p.id))) {
      return { anchorId: p.id, isAfterTail: true };
    }
  }
  for (let i = lastTargetIdx; i >= 0; i--) {
    const p = state.photos[i];
    if (p && !removedSet.has(Number(p.id))) {
      return { anchorId: p.id, isAfterTail: false };
    }
  }
  return null;
}
window.findNextRemainingPhotoAfterTargets = findNextRemainingPhotoAfterTargets;

/**
 * アンカー写真カードが画面上部〜中央の見やすい位置に来るようスクロール位置を同期する
 */
function scrollPhotoIntoComfortZone(anchorPhotoId, options = {}) {
  const numId = Number(anchorPhotoId);
  if (!numId || state.currentPhotoIndex >= 0 || !elements.photoGrid || !Array.isArray(state.photos) || state.photos.length === 0) {
    return;
  }
  const container = elements.photoGrid.parentElement;
  if (!container || container.clientHeight <= 0) return;

  const targetIdx = state.photos.findIndex(p => p && p.id === numId);
  if (targetIdx === -1) return;

  const viewportH = container.clientHeight;
  const desiredOffset = Math.round(viewportH * 0.22);
  const comfortMin = Math.round(viewportH * 0.10);
  const comfortMax = Math.round(viewportH * 0.48);
  const forceAlign = Boolean(options && options.forceAlign);

  if (_gridVirtualState.enabled) {
    if (_gridVirtualState.metricsDirty || !_gridVirtualState.cols) {
      _measureVirtualGridMetrics(false);
    }
    const cols = Math.max(1, _gridVirtualState.cols || 4);
    const rowPitch = Math.max(40, _gridVirtualState.rowPitch || 220);
    const targetRow = Math.floor(targetIdx / cols);
    const targetTop = targetRow * rowPitch + 20;
    const relTop = targetTop - container.scrollTop;
    if (!forceAlign && relTop >= comfortMin && relTop <= comfortMax) {
      return;
    }

    container.scrollTop = Math.max(0, targetTop - desiredOffset);
    syncVirtualPhotoGrid({ forceRemount: true, includeMinIdx: targetIdx, includeMaxIdx: targetIdx });

    const cardEl = elements.photoGrid.querySelector(`.photo-card[data-photo-id="${numId}"]`);
    if (cardEl) {
      const actualRelTop = cardEl.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (Math.abs(actualRelTop - desiredOffset) > 16) {
        const prevTop = container.scrollTop;
        const nextTop = Math.max(0, Math.round(prevTop + (actualRelTop - desiredOffset)));
        if (Math.abs(nextTop - prevTop) > 1) {
          container.scrollTop = nextTop;
          if (Math.abs(container.scrollTop - prevTop) > 1) {
            syncVirtualPhotoGrid({ includeMinIdx: targetIdx, includeMaxIdx: targetIdx });
          }
        }
      }
    }
    return;
  }

  if (targetIdx >= renderedGridCount) {
    ensureCardsRenderedUpTo(targetIdx + 12);
  }
  const cardEl = elements.photoGrid.querySelector(`.photo-card[data-photo-id="${numId}"]`);
  if (!cardEl) return;

  const relTop = cardEl.getBoundingClientRect().top - container.getBoundingClientRect().top;
  if (!forceAlign && relTop >= comfortMin && relTop <= comfortMax) {
    return;
  }
  container.scrollTop = Math.max(0, Math.round(container.scrollTop + (relTop - desiredOffset)));
  checkAndAppendGridChunksIfNeeded();
}
window.scrollPhotoIntoComfortZone = scrollPhotoIntoComfortZone;

/**
 * タグ変更後に該当カードの部分更新・タグフィルタ不一致カードのインプレース除去・末尾次写真へのスクロール同期を行う
 */
async function syncGridCardsAfterTagChange(photoIds, options = {}) {
  const idList = [];
  const idSet = _toNumericPhotoIdSet(photoIds);
  for (const n of idSet) idList.push(n);
  if (idList.length === 0 || !Array.isArray(state.photos)) return;

  const targetCards = [];
  const seenCardIds = new Set();
  const unresolvedIds = new Set();

  for (const numId of idList) {
    const directCard = typeof getPhotoById === 'function'
      ? getPhotoById(numId)
      : state.photos.find(p => p && p.id === numId);
    if (directCard) {
      if (!seenCardIds.has(directCard.id)) {
        seenCardIds.add(directCard.id);
        targetCards.push(directCard);
      }
    } else {
      unresolvedIds.add(numId);
    }
  }

  if (unresolvedIds.size > 0) {
    for (const p of state.photos) {
      if (!p || !Array.isArray(p.stack_photos)) continue;
      if (p.stack_photos.some(sp => sp && unresolvedIds.has(Number(sp.id)))) {
        if (!seenCardIds.has(p.id)) {
          seenCardIds.add(p.id);
          targetCards.push(p);
        }
      }
    }
  }

  if (targetCards.length === 0) return;

  const hasTagFilter = Boolean(state.untaggedOnly || (state.tagFilters && state.tagFilters.size > 0));
  const idsToRemove = [];

  for (const cardPhoto of targetCards) {
    if (hasTagFilter && !doesPhotoMatchActiveTagFilter(cardPhoto)) {
      idsToRemove.push(cardPhoto.id);
    } else {
      updateCardTagsDirectly(cardPhoto.id);
    }
  }

  const anchorInfo = findNextRemainingPhotoAfterTargets(idList, idsToRemove);
  const anchorPhotoId = anchorInfo ? anchorInfo.anchorId : null;

  if (idsToRemove.length > 0) {
    removePhotosFromViewBatch(idsToRemove, {
      anchorPhotoId,
      forceAlign: idList.length > 1 || idsToRemove.length > 1 || Boolean(options && options.forceAlign),
    });
  } else if (options && options.scrollToNextWhenKept && anchorPhotoId) {
    scrollPhotoIntoComfortZone(anchorPhotoId, { forceAlign: Boolean(options.forceAlign) });
  }
}
window.syncGridCardsAfterTagChange = syncGridCardsAfterTagChange;

/**
 * 単一写真のタグ変更後にカード部分更新とタグフィルタ整合（必要時のみ該当カード除去）を同期する
 */
async function syncGridCardAfterSingleTagChange(photoId) {
  await syncGridCardsAfterTagChange([photoId], { forceAlign: false });
}
window.syncGridCardAfterSingleTagChange = syncGridCardAfterSingleTagChange;

/**
 * 写真カードのDOM要素を生成する（イベントリスナーは委譲するため一切登録しない軽量・高速版）
 */
function createPhotoCard(photo, index) {
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.dataset.photoId = photo.id;
  card.draggable = true;
  card.dataset.index = index;

  // DBメタデータ（サムネイル寸法・元寸法・回転・クロップ）から正確なプレースホルダ縦横比を事前設定
  const aspectInfo = (typeof getPhotoAspectInfo === 'function')
    ? getPhotoAspectInfo(photo)
    : { isPortrait: false, aspectCss: '3 / 2', aspectRatio: '1.5000' };
  card.classList.add(aspectInfo.isPortrait ? 'is-portrait' : 'is-landscape');
  card.style.setProperty('--photo-aspect', aspectInfo.aspectCss);
  card.style.setProperty('--photo-aspect-ratio', aspectInfo.aspectRatio);

  if (state.selectedPhotoIds.has(photo.id)) {
    card.classList.add('selected');
  }

  // オフライン写真はカード全体をデサチュレーション表示（テキストバッジ不要）
  if (photo.is_unlinked) {
    card.classList.add('is-unlinked');
    card.title = '実体パス未登録（リンク消失） — サムネイルプレビューで表示中';
  } else if (photo.is_offline) {
    card.classList.add('is-offline');
    const volLabelOrId = photo.volume_custom_name || photo.volume_label || (photo.volume_serial && photo.volume_serial.length === 8 ? `ID:${photo.volume_serial.slice(0, 4)}-${photo.volume_serial.slice(4)}` : photo.volume_serial || '');
    const volName = volLabelOrId ? `（メディア: ${volLabelOrId}）` : '';
    card.title = `元ファイルが未接続です${volName} — サムネイルプレビューで表示中`;
  }

  // 棄の写真はサムネイルを薄暗く表示
  if (photo.rating === -1) {
    card.classList.add('is-discarded');
  }

  // 重複写真（他フォルダにコピーあり）判定
  const hasDuplicates = Boolean(photo.duplicate_count && photo.duplicate_count > 1);
  if (hasDuplicates) {
    card.classList.add('has-duplicate');
  }

  // 評価アイコンオーバーレイの生成
  let ratingIconHtml = '';
  if (photo.rating === 2) {
    ratingIconHtml = '<span class="card-rating-icon rating-excellent">優</span>';
  } else if (photo.rating === 1) {
    ratingIconHtml = '<span class="card-rating-icon rating-good">良</span>';
  } else if (photo.rating === -1) {
    ratingIconHtml = '<span class="card-rating-icon rating-discard">棄</span>';
  }

  const isStackedCard = isEffectiveStacked() && Boolean((photo.stack_count && photo.stack_count > 1) || (photo.stack_photos && photo.stack_photos.length > 1));

  // ホバー時評価バーの生成（スタック表示中はグレーアウトして変更不可にする）
  const ratingBarHtml = isStackedCard
    ? `
    <div class="card-rating-bar is-stack-disabled" title="スタック画像は変更できません">
      <span class="card-rating-bar-btn disabled${photo.rating === 2 ? ' active' : ''}" data-rating="2" title="スタック画像は変更できません">優</span>
      <span class="card-rating-bar-btn disabled${photo.rating === 1 ? ' active' : ''}" data-rating="1" title="スタック画像は変更できません">良</span>
      <span class="card-rating-bar-btn disabled${photo.rating === -1 ? ' active' : ''}" data-rating="-1" title="スタック画像は変更できません">棄</span>
    </div>
  `
    : `
    <div class="card-rating-bar">
      <span class="card-rating-bar-btn${photo.rating === 2 ? ' active' : ''}" data-rating="2">優</span>
      <span class="card-rating-bar-btn${photo.rating === 1 ? ' active' : ''}" data-rating="1">良</span>
      <span class="card-rating-bar-btn${photo.rating === -1 ? ' active' : ''}" data-rating="-1">棄</span>
    </div>
  `;

  const dateFormatted = photo.date_taken ? photo.date_taken.substring(0, 10) : '日付不明';

  // タグバッジHTML (サムネイルギャラリーの情報パネルにはAIタグを表示せず、手動タグのみ表示)
  const tagsHtml = buildCardTagsHtml(photo);

  // フォーマットバッジHTML (RAW / RAW+JPG)
  let formatBadgeHtml = '';
  const stackHasRaw = Boolean(photo.stack_photos && photo.stack_photos.some(sp => sp.is_raw));
  const stackHasJpg = Boolean(photo.stack_photos && photo.stack_photos.some(sp => !sp.is_raw));
  const hasRawPair = Boolean(
    photo.paired_raw_path ||
    (photo.stack_photos && photo.stack_photos.some(sp => sp.paired_raw_path)) ||
    (stackHasRaw && stackHasJpg)
  );
  if (hasRawPair) {
    formatBadgeHtml = `<span class="format-badge raw-jpg-badge" title="RAW+JPEGペア写真">RAW+JPG</span>`;
  } else if (photo.is_raw) {
    const rawFmt = (photo.raw_format || 'RAW').toUpperCase().replace('.', '');
    formatBadgeHtml = `<span class="format-badge raw-badge" title="RAW画像 (${rawFmt})">${rawFmt}</span>`;
  }

  // スタックバッジHTML (ブラケット / 連写 / 重複)
  let stackBadgeHtml = '';
  if (isEffectiveStacked() && photo.stack_count > 1) {
    if (photo.stack_type === 'duplicate') {
      stackBadgeHtml = `<span class="stack-badge stack-badge-dup" data-photo-id="${photo.id}" title="重複写真 ${photo.stack_count}枚 (他フォルダにコピーあり・クリックで一覧表示)">重複 ${photo.stack_count}</span>`;
    } else {
      const bktType = photo.stack_type === 'burst' ? 'BURST' : 'BKT';
      const isWithRaw = hasRawPair ? ' (RAW+JPG)' : '';
      stackBadgeHtml = `<span class="stack-badge" data-photo-id="${photo.id}" title="グループ ${photo.stack_count}枚${isWithRaw} (クリックで露出一覧を表示)">${bktType} ${photo.stack_count}</span>`;
    }
  }

  // スライドマウント用の上部・下部スタンプ（上段: 機種名・日付 / 下段: ファイル名・BKTバッジ・RAWバッジ）
  const cameraLabel = (photo.camera_model || '35mm SLIDE').trim();
  const mountTopHtml = `
    <div class="card-mount-top">
      <div class="mount-stamp-left">
        <span class="mount-stamp-brand" title="${escapeHtml(cameraLabel)}">${escapeHtml(cameraLabel)}</span>
      </div>
      <span class="card-date">${dateFormatted}</span>
    </div>
  `;
  const mountBottomHtml = `
    <div class="card-mount-bottom">
      <div class="mount-stamp-left">
        <span class="card-filename" title="${escapeHtml(photo.file_name)}">${escapeHtml(photo.file_name)}</span>
        ${stackBadgeHtml}
      </div>
      ${formatBadgeHtml}
    </div>
  `;

  card.innerHTML = `
    ${mountTopHtml}
    <div class="card-thumb-wrapper">
      <div class="card-select-checkbox" title="選択 (Ctrl/Shiftクリック対応)">✓</div>
      ${photo.is_unlinked ? `<span class="unlinked-card-badge" title="実体パス未登録（リンク消失）"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="3" y1="3" x2="21" y2="21"/></svg></span>` : ''}
      ${hasDuplicates ? `<div class="thumb-corner-cut" title="他フォルダに重複コピーあり (計 ${photo.duplicate_count} 箇所)"></div>` : ''}
      ${formatBadgeHtml}
      <img class="card-thumb-img" src="${getThumbnailUrl(photo)}" alt="${escapeHtml(photo.file_name)}" loading="lazy" onload="onThumbImageLoad(this)">
      <div class="card-rating-overlay">
        ${ratingIconHtml}
      </div>
      ${ratingBarHtml}
    </div>
    ${mountBottomHtml}
    <div class="card-info">
      <div class="card-title-row">
        <div class="card-filename" title="${escapeHtml(photo.file_name)}">${escapeHtml(photo.file_name)}</div>
      </div>
      <div class="card-meta">
        <div class="card-meta-left">
          ${stackBadgeHtml}
        </div>
        <div class="card-meta-right">
          <span class="card-date">${dateFormatted}</span>
          <span class="card-camera">${escapeHtml(photo.camera_model || '')}</span>
        </div>
      </div>
      ${tagsHtml}
    </div>
  `;

  return card;
}

/**
 * 選択中フォルダの未接続（消失・ドライブ切断）警告バナーを更新する
 */
function updateFolderWarningBanner() {
  if (!elements.folderWarningBanner) return;
  const unlinkBtn = elements.warningBannerUnlinkBtn || document.getElementById('warningBannerUnlinkBtn');
  const unmanageVolBtn = document.getElementById('warningBannerUnmanageVolumeBtn');

  if (state.currentFilter.type === 'folder' && state.currentFilter.isOffline) {
    if (elements.warningBannerDesc) {
      const targetLabel = state.currentFilter.value || state.currentFilter.titleText || '選択中のメディア';
      elements.warningBannerDesc.textContent = `メディアまたは実フォルダ（${targetLabel}）が現在未接続です。（保存済みサムネイルをキャッシュから表示中）`;
    }
    if (unlinkBtn) unlinkBtn.style.display = 'none';
    if (unmanageVolBtn) {
      unmanageVolBtn.textContent = state.currentFilter.volumeSerial
        ? 'このメディアを管理から外す（登録削除）'
        : '管理から外す（登録削除）';
      unmanageVolBtn.style.display = 'inline-flex';
    }
    elements.folderWarningBanner.style.display = 'flex';
    return;
  }
  if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
    const curNorm = state.currentFilter.value.replace(/\\/g, '/').toLowerCase();
    const matched = (state.rawFoldersData || []).find(f => (f.directory_path || '').replace(/\\/g, '/').toLowerCase() === curNorm);
    if (matched && matched.is_missing) {
      if (elements.warningBannerDesc) {
        elements.warningBannerDesc.textContent = `実フォルダ（${state.currentFilter.value}）が存在しないか、削除・移動されています。（保存済みサムネイルをキャッシュから表示中）`;
      }
      if (unlinkBtn) unlinkBtn.style.display = 'inline-flex';
      if (unmanageVolBtn) unmanageVolBtn.style.display = 'none';
      elements.folderWarningBanner.style.display = 'flex';
      return;
    }
  }
  if (unlinkBtn) unlinkBtn.style.display = 'none';
  if (unmanageVolBtn) unmanageVolBtn.style.display = 'none';
  elements.folderWarningBanner.style.display = 'none';
}

const GRID_INITIAL_CHUNK = 200;
const GRID_CHUNK_SIZE = 200;

function _resetVirtualGridState() {
  _gridVirtualState.enabled = false;
  _gridVirtualState.startIdx = -1;
  _gridVirtualState.endIdx = -1;
  _gridVirtualState.topSpacer = null;
  _gridVirtualState.bottomSpacer = null;
  _gridVirtualState.metricsDirty = true;
  _gridVirtualState.calibrated = false;
  if (elements.photoGrid) {
    elements.photoGrid.classList.remove('is-virtual-grid');
  }
}

function _canUseVirtualPhotoGrid() {
  const grid = elements.photoGrid;
  const container = grid ? grid.parentElement : null;
  if (!grid || !container) return false;
  if (state.photos.length <= VIRTUAL_GRID_MIN_PHOTOS) return false;
  if (state.viewMode === 'masonry' || document.body.classList.contains('layout-masonry')) return false;
  return grid.clientWidth > 0 && container.clientHeight > 0;
}

function _measureVirtualGridMetrics(forceCalibrate = false) {
  const grid = elements.photoGrid;
  if (!grid) return false;
  const gridWidth = grid.clientWidth;
  if (gridWidth <= 0) return false;

  const isMount = state.viewMode === 'mount' || document.body.classList.contains('layout-mount');
  const inlineThumb = parseFloat(document.documentElement.style.getPropertyValue('--thumbnail-size'));
  const thumbSize = (inlineThumb > 40)
    ? inlineThumb
    : (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumbnail-size')) || 230);
  const colWidth = isMount ? (thumbSize * 1.15) : thumbSize;
  const gap = isMount ? 24 : 16;
  const cols = Math.max(1, Math.floor((gridWidth + gap) / (colWidth + gap)));

  let cardHeight = isMount
    ? Math.round(colWidth)
    : (state.isMinimalView ? Math.round(colWidth * 0.75 + 2) : Math.round(colWidth * 0.75 + 62));

  if (forceCalibrate || !_gridVirtualState.calibrated) {
    const sampleCard = grid.querySelector('.photo-card');
    if (sampleCard && sampleCard.offsetHeight > 20) {
      cardHeight = sampleCard.offsetHeight;
      _gridVirtualState.calibrated = true;
    }
  } else if (_gridVirtualState.rowPitch > gap + 20) {
    cardHeight = _gridVirtualState.rowPitch - _gridVirtualState.rowGap;
  }

  _gridVirtualState.cols = cols;
  _gridVirtualState.rowGap = gap;
  _gridVirtualState.rowPitch = Math.max(40, cardHeight + gap);
  _gridVirtualState.lastGridWidth = gridWidth;
  _gridVirtualState.metricsDirty = false;
  return true;
}

function _applyVirtualGridSpacers(startRow, endRow, totalRows) {
  const { topSpacer, bottomSpacer, rowPitch, rowGap } = _gridVirtualState;
  if (topSpacer) {
    if (startRow <= 0) {
      topSpacer.style.display = 'none';
      topSpacer.style.height = '0px';
    } else {
      topSpacer.style.display = 'block';
      topSpacer.style.height = `${Math.max(0, Math.round(startRow * rowPitch - rowGap))}px`;
    }
  }
  if (bottomSpacer) {
    const remainingRows = totalRows - endRow;
    if (remainingRows <= 0) {
      bottomSpacer.style.display = 'none';
      bottomSpacer.style.height = '0px';
    } else {
      bottomSpacer.style.display = 'block';
      bottomSpacer.style.height = `${Math.max(0, Math.round(remainingRows * rowPitch - rowGap))}px`;
    }
  }
}

function _initVirtualPhotoGridDom() {
  const grid = elements.photoGrid;
  if (!grid) return;
  grid.innerHTML = '';
  grid.classList.add('is-virtual-grid');

  const topSpacer = document.createElement('div');
  topSpacer.className = 'grid-virtual-spacer grid-virtual-spacer-top';
  topSpacer.style.display = 'none';

  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'grid-virtual-spacer grid-virtual-spacer-bottom';
  bottomSpacer.style.display = 'none';

  grid.appendChild(topSpacer);
  grid.appendChild(bottomSpacer);

  _gridVirtualState.enabled = true;
  _gridVirtualState.topSpacer = topSpacer;
  _gridVirtualState.bottomSpacer = bottomSpacer;
  _gridVirtualState.startIdx = -1;
  _gridVirtualState.endIdx = -1;
  _gridVirtualState.metricsDirty = true;
  _gridVirtualState.calibrated = false;
}

/**
 * 行単位2D仮想スクロールの可視ウィンドウ＋オーバースキャン行を差分マウントする
 */
function syncVirtualPhotoGrid(options = {}) {
  if (!_gridVirtualState.enabled || !elements.photoGrid) return;
  const total = state.photos.length;
  if (total === 0) return;

  const grid = elements.photoGrid;
  const container = grid.parentElement;
  if (!container) return;

  const forceRemount = Boolean(options.forceRemount);
  const includeMinIdx = (typeof options.includeMinIdx === 'number' && options.includeMinIdx >= 0) ? options.includeMinIdx : null;
  const includeMaxIdx = (typeof options.includeMaxIdx === 'number' && options.includeMaxIdx >= 0) ? options.includeMaxIdx : null;

  const prevCols = _gridVirtualState.cols;
  const widthChanged = grid.clientWidth > 0 && grid.clientWidth !== _gridVirtualState.lastGridWidth;
  if (_gridVirtualState.metricsDirty || widthChanged) {
    if (widthChanged) _gridVirtualState.calibrated = false;
    if (!_measureVirtualGridMetrics(false)) return;
  }

  const cols = _gridVirtualState.cols;
  const rowPitch = _gridVirtualState.rowPitch;
  const totalRows = Math.max(1, Math.ceil(total / cols));
  const viewportH = Math.max(1, container.clientHeight);
  const estMaxScroll = Math.max(0, totalRows * rowPitch + 40 - viewportH);
  const effectiveScrollTop = Math.min(Math.max(0, container.scrollTop), estMaxScroll);
  const scrollTopInGrid = Math.max(0, effectiveScrollTop - 20);

  const visStartRow = Math.min(totalRows - 1, Math.max(0, Math.floor(scrollTopInGrid / rowPitch)));
  const visEndRow = Math.min(totalRows - 1, Math.max(visStartRow, Math.floor((scrollTopInGrid + viewportH) / rowPitch)));

  let startRow = Math.max(0, visStartRow - VIRTUAL_GRID_OVERSCAN_ROWS);
  let endRow = Math.min(totalRows, visEndRow + 1 + VIRTUAL_GRID_OVERSCAN_ROWS);

  if (includeMinIdx !== null) {
    startRow = Math.min(startRow, Math.max(0, Math.floor(includeMinIdx / cols) - 1));
  }
  if (includeMaxIdx !== null) {
    endRow = Math.max(endRow, Math.min(totalRows, Math.floor(Math.min(total - 1, includeMaxIdx) / cols) + 2));
  }

  const prevStart = _gridVirtualState.startIdx;
  const prevEnd = _gridVirtualState.endIdx;
  const colsChanged = prevStart >= 0 && prevCols !== cols;

  if (!forceRemount && !colsChanged && !widthChanged && prevStart >= 0 && prevEnd > prevStart && includeMinIdx === null && includeMaxIdx === null) {
    const guardStartIdx = Math.max(0, visStartRow - VIRTUAL_GRID_HYSTERESIS_ROWS) * cols;
    const guardEndIdx = Math.min(total, (visEndRow + 1 + VIRTUAL_GRID_HYSTERESIS_ROWS) * cols);
    if (prevStart <= guardStartIdx && prevEnd >= guardEndIdx) {
      return;
    }
  }

  const nextStart = startRow * cols;
  const nextEnd = Math.min(total, endRow * cols);
  const { topSpacer, bottomSpacer } = _gridVirtualState;
  if (!topSpacer || !bottomSpacer) return;

  const hasOverlap = !forceRemount && prevStart >= 0 && prevEnd > prevStart && nextStart < prevEnd && nextEnd > prevStart;

  if (!hasOverlap) {
    let node = topSpacer.nextSibling;
    while (node && node !== bottomSpacer) {
      const nxt = node.nextSibling;
      node.remove();
      node = nxt;
    }
    const frag = document.createDocumentFragment();
    for (let i = nextStart; i < nextEnd; i++) {
      frag.appendChild(createPhotoCard(state.photos[i], i));
    }
    grid.insertBefore(frag, bottomSpacer);
  } else {
    if (nextStart > prevStart) {
      while (topSpacer.nextSibling && topSpacer.nextSibling !== bottomSpacer) {
        const card = topSpacer.nextSibling;
        const cIdx = Number(card.dataset ? card.dataset.index : -1);
        if (cIdx >= 0 && cIdx < nextStart) {
          card.remove();
        } else {
          break;
        }
      }
    }
    if (nextEnd < prevEnd) {
      while (bottomSpacer.previousSibling && bottomSpacer.previousSibling !== topSpacer) {
        const card = bottomSpacer.previousSibling;
        const cIdx = Number(card.dataset ? card.dataset.index : -1);
        if (cIdx >= nextEnd) {
          card.remove();
        } else {
          break;
        }
      }
    }
    if (nextStart < prevStart) {
      const topFrag = document.createDocumentFragment();
      const upperBound = Math.min(prevStart, nextEnd);
      for (let i = nextStart; i < upperBound; i++) {
        topFrag.appendChild(createPhotoCard(state.photos[i], i));
      }
      grid.insertBefore(topFrag, topSpacer.nextSibling);
    }
    if (nextEnd > prevEnd) {
      const bottomFrag = document.createDocumentFragment();
      const lowerBound = Math.max(prevEnd, nextStart);
      for (let i = lowerBound; i < nextEnd; i++) {
        bottomFrag.appendChild(createPhotoCard(state.photos[i], i));
      }
      grid.insertBefore(bottomFrag, bottomSpacer);
    }
  }

  _gridVirtualState.startIdx = nextStart;
  _gridVirtualState.endIdx = nextEnd;
  renderedGridCount = nextEnd;

  if (!_gridVirtualState.calibrated) {
    _measureVirtualGridMetrics(true);
    const calibratedRows = Math.max(1, Math.ceil(total / _gridVirtualState.cols));
    _applyVirtualGridSpacers(startRow, Math.min(calibratedRows, endRow), calibratedRows);
  } else {
    _applyVirtualGridSpacers(startRow, endRow, totalRows);
  }
}

function _scheduleGridViewportSync(metricsChanged = false, recalibrate = false) {
  if (metricsChanged) {
    _gridVirtualState.metricsDirty = true;
    if (recalibrate) _gridVirtualState.calibrated = false;
  }
  if (_gridScrollRafId) return;
  _gridScrollRafId = requestAnimationFrame(() => {
    _gridScrollRafId = null;
    checkAndAppendGridChunksIfNeeded();
  });
}

/**
 * 未描画の写真カードチャンクを指定インデックス（または1チャンク分）までDOMに追加する
 */
function appendPhotoGridChunk(targetCount = null) {
  const total = state.photos.length;
  if (renderedGridCount >= total || !elements.photoGrid) return;

  const nextEnd = targetCount !== null
    ? Math.min(Math.max(renderedGridCount + GRID_CHUNK_SIZE, targetCount), total)
    : Math.min(renderedGridCount + GRID_CHUNK_SIZE, total);

  const fragment = document.createDocumentFragment();
  for (let i = renderedGridCount; i < nextEnd; i++) {
    fragment.appendChild(createPhotoCard(state.photos[i], i));
  }
  elements.photoGrid.appendChild(fragment);
  renderedGridCount = nextEnd;
}

/**
 * 指定したインデックスの写真カードがDOM上に確実に存在するようチャンクまたは仮想ウィンドウを同期する
 */
function ensureCardsRenderedUpTo(targetIndex) {
  const total = state.photos.length;
  if (total === 0 || !elements.photoGrid) return;

  if (_gridVirtualState.enabled) {
    const rawTarget = Number(targetIndex) || 0;
    const reqIdx = Math.max(0, Math.min(total - 1, rawTarget >= total ? total - 1 : rawTarget));
    const prevIdx = Math.max(0, reqIdx - 1);
    if (prevIdx >= _gridVirtualState.startIdx && reqIdx < _gridVirtualState.endIdx) {
      return;
    }

    const cols = Math.max(1, _gridVirtualState.cols || 4);
    const targetRow = Math.floor(prevIdx / cols);
    const curStartRow = _gridVirtualState.startIdx >= 0 ? Math.floor(_gridVirtualState.startIdx / cols) : 0;
    const curEndRow = _gridVirtualState.endIdx > 0 ? Math.ceil(_gridVirtualState.endIdx / cols) : 0;
    const container = elements.photoGrid.parentElement;

    if (container && (targetRow < curStartRow - 24 || targetRow > curEndRow + 24)) {
      const targetTop = targetRow * _gridVirtualState.rowPitch;
      container.scrollTop = Math.max(0, targetTop - Math.round(container.clientHeight * 0.25));
      syncVirtualPhotoGrid({ forceRemount: true, includeMinIdx: prevIdx, includeMaxIdx: reqIdx });
    } else {
      syncVirtualPhotoGrid({ forceRemount: false, includeMinIdx: prevIdx, includeMaxIdx: reqIdx });
    }
    return;
  }

  if (targetIndex >= renderedGridCount && renderedGridCount < total) {
    appendPhotoGridChunk(targetIndex + 1);
  }
}
window.ensureCardsRenderedUpTo = ensureCardsRenderedUpTo;

/**
 * スクロール位置やコンテナサイズに応じて仮想グリッドまたは次チャンクを更新する
 */
function checkAndAppendGridChunksIfNeeded() {
  if (!elements.photoGrid || state.photos.length === 0) return;

  const shouldVirtual = _canUseVirtualPhotoGrid();
  if (_gridVirtualState.enabled !== shouldVirtual) {
    if (shouldVirtual) {
      _initVirtualPhotoGridDom();
      syncVirtualPhotoGrid({ forceRemount: true });
    } else {
      _resetVirtualGridState();
      elements.photoGrid.innerHTML = '';
      renderedGridCount = 0;
      appendPhotoGridChunk(GRID_INITIAL_CHUNK);
    }
    return;
  }

  if (_gridVirtualState.enabled) {
    syncVirtualPhotoGrid();
    return;
  }

  if (renderedGridCount >= state.photos.length) return;
  const container = elements.photoGrid.parentElement;
  if (!container) return;

  // 下端から 900px 以内に近づいた場合、または画面内にまだ余裕がある場合に次チャンクを追加
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 900) {
    appendPhotoGridChunk();
    if (renderedGridCount < state.photos.length && container.scrollHeight <= container.clientHeight + 600) {
      if (renderGridTaskId) cancelAnimationFrame(renderGridTaskId);
      renderGridTaskId = requestAnimationFrame(() => {
        renderGridTaskId = null;
        checkAndAppendGridChunksIfNeeded();
      });
    }
  }
}

/**
 * 写真グリッドの描画（300枚超の固定列レイアウトでは2D仮想スクロール、少枚数・びっしりモードはチャンク描画）
 */
function renderPhotoGrid() {
  if (renderGridTaskId) {
    cancelAnimationFrame(renderGridTaskId);
    renderGridTaskId = null;
  }
  if (_gridScrollRafId) {
    cancelAnimationFrame(_gridScrollRafId);
    _gridScrollRafId = null;
  }

  // スクロールコンテナおよびリサイズ監視へのイベント登録（初回のみ・rAFスロットル）
  if (!_gridScrollListenerBound && elements.photoGrid && elements.photoGrid.parentElement) {
    _gridScrollListenerBound = true;
    elements.photoGrid.parentElement.addEventListener('scroll', () => {
      _scheduleGridViewportSync(false, false);
    }, { passive: true });
    window.addEventListener('resize', () => {
      if (_gridResizeRafId) return;
      _gridResizeRafId = requestAnimationFrame(() => {
        _gridResizeRafId = null;
        _gridVirtualState.metricsDirty = true;
        _gridVirtualState.calibrated = false;
        checkAndAppendGridChunksIfNeeded();
      });
    }, { passive: true });
    if (typeof ResizeObserver === 'function' && !_gridResizeObserver) {
      _gridResizeObserver = new ResizeObserver(() => {
        if (!elements.photoGrid || elements.photoGrid.clientWidth === _gridVirtualState.lastGridWidth) return;
        if (_gridResizeRafId) return;
        _gridResizeRafId = requestAnimationFrame(() => {
          _gridResizeRafId = null;
          _gridVirtualState.metricsDirty = true;
          _gridVirtualState.calibrated = false;
          checkAndAppendGridChunksIfNeeded();
        });
      });
      _gridResizeObserver.observe(elements.photoGrid);
    }
  }

  // 選択中フォルダの未接続警告バナーの更新
  updateFolderWarningBanner();

  // 画面外となった写真（フィルタ等で除外された写真）の選択IDを自動クリーンアップ
  if (state.selectedPhotoIds.size > 0) {
    const currentIdSet = new Set(state.photos.map(p => p.id));
    let hasRemoved = false;
    state.selectedPhotoIds.forEach(id => {
      if (!currentIdSet.has(id)) {
        state.selectedPhotoIds.delete(id);
        hasRemoved = true;
      }
    });
    if (hasRemoved) {
      updateCardSelectionClasses();
      updateSelectionUI();
    }
  }

  _resetVirtualGridState();
  elements.photoGrid.innerHTML = '';
  renderedGridCount = 0;
  // 再生成されるカードは createPhotoCard で現在の選択状態を反映するため、差分基準も現在の選択集合に同期
  lastSelectedPhotoIds = new Set(state.selectedPhotoIds);

  if (state.photos.length === 0) {
    if (elements.emptyState) {
      const titleEl = elements.emptyState.querySelector('h2');
      const descEl = elements.emptyState.querySelector('p');
      const iconEl = elements.emptyState.querySelector('.empty-icon');

      if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
        const curNorm = state.currentFilter.value.replace(/\\/g, '/').toLowerCase();
        const matched = (state.rawFoldersData || []).find(f => (f.directory_path || '').replace(/\\/g, '/').toLowerCase() === curNorm);
        const isLoomeDir = (typeof window.isStoragePath === 'function' && window.isStoragePath(state.currentFilter.value));
        const folderStatus = matched ? matched.status : (isLoomeDir ? 'managed' : 'unmanaged');
        const isFolderMissing = matched ? !!matched.is_missing : false;

        if (isFolderMissing) {
          if (iconEl) iconEl.textContent = '!';
          if (titleEl) titleEl.textContent = '実フォルダが見つかりません（未接続）';
          if (descEl) descEl.textContent = `実フォルダ（${state.currentFilter.value}）が存在しないか、ドライブが未接続です。ドライブの接続状態を確認してください。`;
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '接続を再確認';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              showToast('ドライブ・フォルダの接続状態を確認中...', 'info');
              await fetchFolders();
              await fetchPhotos();
              showToast('接続状態を更新しました', 'success');
            };
          }
        } else if (folderStatus === 'unmanaged') {
          if (iconEl) iconEl.textContent = '';
          if (titleEl) titleEl.textContent = 'このフォルダはライブラリ未登録です';
          if (descEl) descEl.textContent = '実ディスク上に存在する未登録フォルダです。「管理に追加」を押すと写真をスキャンしてライブラリに登録します。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '管理に追加してスキャン';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              showToast(`「${state.currentFilter.value}」を管理に追加・スキャン中...`, 'info');
              await executeScan(state.currentFilter.value, false, false);
            };
          }
        } else if (folderStatus === 'ignored') {
          if (iconEl) iconEl.textContent = '';
          if (titleEl) titleEl.textContent = 'このフォルダは管理対象外（除外設定中）です';
          if (descEl) descEl.textContent = '自動スキャンの対象から除外されています。「除外を解除」を押すと未登録状態に戻せます。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '除外を解除する';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              try {
                const res = await fetch('/api/folders/ignore', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ folder_path: state.currentFilter.value }),
                });
                if (res.ok) {
                  showToast('除外を解除しました', 'success');
                  await refreshAll();
                }
              } catch (err) {
                showToast(`エラー: ${err.message}`, 'error');
              }
            };
          }
        } else {
          if (iconEl) iconEl.textContent = '';
          if (titleEl) titleEl.textContent = '写真が見つかりません';
          if (descEl) descEl.textContent = '指定された条件の写真がないか、まだスキャンされていません。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = 'フォルダ一覧を開く';
            elements.emptyStateActionBtn.onclick = () => {
              if (window.openSidebarSection) window.openSidebarSection('folder');
            };
          }
        }
      } else {
        if (iconEl) iconEl.textContent = '';
        if (titleEl) titleEl.textContent = '写真が見つかりません';
        if (descEl) descEl.textContent = '指定された条件の写真がないか、まだスキャンされていません。';
        if (elements.emptyStateActionBtn) {
          elements.emptyStateActionBtn.textContent = 'フォルダ一覧を開く';
          elements.emptyStateActionBtn.onclick = () => {
            if (window.openSidebarSection) window.openSidebarSection('folder');
          };
        }
      }

      elements.emptyState.style.display = 'flex';
    }
    updateSelectionUI();
    return;
  }

  elements.emptyState.style.display = 'none';

  // Slap & Sweep: Sweep (>0%) の場合はグリッド切替時にソフトフェードを発火
  const sweepDeg = typeof window.getMotionSweepDegree === 'function' ? window.getMotionSweepDegree() : 60;
  elements.photoGrid.classList.remove('grid-sweep-enter');
  if (sweepDeg > 0) {
    void elements.photoGrid.offsetWidth;
    elements.photoGrid.classList.add('grid-sweep-enter');
  }

  if (_canUseVirtualPhotoGrid()) {
    _initVirtualPhotoGridDom();
    syncVirtualPhotoGrid({ forceRemount: true });
    updateSelectionUI();
    return;
  }

  // 少枚数またはびっしりモード時は段階的チャンク描画
  appendPhotoGridChunk(GRID_INITIAL_CHUNK);
  updateSelectionUI();

  if (renderedGridCount < state.photos.length) {
    renderGridTaskId = requestAnimationFrame(() => {
      renderGridTaskId = null;
      checkAndAppendGridChunksIfNeeded();
    });
  }
}

/**
 * 評価フィルタが「棄 (-1)」のみ選択されているか判定
 */
function isDiscardOnlyFilter() {
  return Boolean(state.ratingFilter && state.ratingFilter.size === 1 && state.ratingFilter.has(-1));
}

/**
 * 実効的なスタック表示ON/OFF判定（「棄」単体フィルタ時は自動でスタック表示を解除）
 */
function isEffectiveStacked() {
  if (isDiscardOnlyFilter()) return false;
  return Boolean(state.isStacked);
}
window.isEffectiveStacked = isEffectiveStacked;

/**
 * ヘッダーの「スタック」切替ボタンの有効/無効およびアクティブ表示を同期
 */
function syncStackToggleButtonUI() {
  if (!elements.toggleStackBtn) return;
  const discardOnly = isDiscardOnlyFilter();
  elements.toggleStackBtn.classList.toggle('active', isEffectiveStacked());
  elements.toggleStackBtn.disabled = discardOnly;
  elements.toggleStackBtn.style.opacity = discardOnly ? '0.45' : '';
  elements.toggleStackBtn.title = discardOnly
    ? '「棄」フィルタ表示中はスタック表示が自動解除されます'
    : '露出ブラケット・連写のスタック表示切り替え (ONで束ねて表示、OFFで全枚数展開)';
}
window.syncStackToggleButtonUI = syncStackToggleButtonUI;

/**
 * 評価フィルタトグル同期関数
 */
function updateRatingFilterUI() {
  document.querySelectorAll('.rating-filter-toggles .rating-toggle').forEach(btn => {
    const rv = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle('active', state.ratingFilter.has(rv));
  });
  syncStackToggleButtonUI();
}

/**
 * 属性フィルタ（すべて / RAW / 調整済 / 詳細属性セレクト）のUI同期関数
 */
function syncAttrFilterButtons() {
  const cur = state.attrFilter || 'all';
  document.querySelectorAll('#attrFilterToggles .attr-toggle, .attr-toggle[data-attr]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.attr === cur);
  });
  const headerAttrSel = elements.headerAttrSelect || document.getElementById('headerAttrSelect');
  if (headerAttrSel) {
    headerAttrSel.value = ['all', 'raw', 'raw_pair', 'raw_any', 'jpeg', 'adjusted', 'xmp'].includes(cur) ? cur : 'all';
    headerAttrSel.classList.toggle('is-filtered', cur !== 'all');
    updateHeaderSelectTooltip(headerAttrSel);
  }
  const subSelect = elements.attrSubFilterSelect || document.getElementById('attrSubFilterSelect');
  if (subSelect) {
    if (['jpeg', 'raw_pair', 'raw_any', 'xmp'].includes(cur)) {
      subSelect.value = cur;
      subSelect.classList.add('active');
    } else {
      subSelect.value = '';
      subSelect.classList.remove('active');
    }
  }
}
const updateAttrFilterUI = syncAttrFilterButtons;

/**
 * 属性フィルタ（すべて / RAW / 調整済 / JPEG / RAW+JPGペア / XMP）の切替
 */
function setAttrFilter(attr) {
  const nextAttr = attr || 'all';
  // 同じピル（all以外）を再クリックした場合は 'all' に戻すトグル動作
  if (state.attrFilter === nextAttr && nextAttr !== 'all') {
    state.attrFilter = 'all';
  } else {
    state.attrFilter = nextAttr;
  }
  syncAttrFilterButtons();
  fetchPhotos();
}
window.syncAttrFilterButtons = syncAttrFilterButtons;
window.updateAttrFilterUI = updateAttrFilterUI;
window.setAttrFilter = setAttrFilter;

/**
 * 評価フィルタの6パターン遷移ロジック
 * デフォルト: 優・良・可 [0, 1, 2] (棄以外すべて)
 * パターン1: 優・良・可 [0, 1, 2]
 * パターン2: 優と良 [1, 2]
 * パターン3: 優だけ [2]
 * パターン4: 良だけ [1]
 * パターン5: 可だけ [0] (他と独立)
 * パターン6: 棄だけ [-1] (他と独立)
 */
function toggleRatingFilter(rating) {
  const isDefault = (state.ratingFilter.size === 3 &&
    state.ratingFilter.has(0) && state.ratingFilter.has(1) && state.ratingFilter.has(2));

  if (rating === 0) {
    // 「可」をクリック
    if (isDefault) {
      state.ratingFilter = new Set([1, 2]);
    } else if (state.ratingFilter.size === 1 && state.ratingFilter.has(0)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([0]);
    }
  } else if (rating === -1) {
    // 「棄」をクリック
    if (state.ratingFilter.size === 1 && state.ratingFilter.has(-1)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([-1]);
    }
  } else if (rating === 2) {
    // 「優」をクリック
    if (isDefault) {
      state.ratingFilter = new Set([2]);
    } else if (state.ratingFilter.has(0) || state.ratingFilter.has(-1)) {
      state.ratingFilter = new Set([2]);
    } else if (state.ratingFilter.has(1) && state.ratingFilter.has(2)) {
      state.ratingFilter = new Set([1]);
    } else if (state.ratingFilter.has(2) && !state.ratingFilter.has(1)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([1, 2]);
    }
  } else if (rating === 1) {
    // 「良」をクリック
    if (isDefault) {
      state.ratingFilter = new Set([1]);
    } else if (state.ratingFilter.has(0) || state.ratingFilter.has(-1)) {
      state.ratingFilter = new Set([1]);
    } else if (state.ratingFilter.has(1) && state.ratingFilter.has(2)) {
      state.ratingFilter = new Set([2]);
    } else if (state.ratingFilter.has(1) && !state.ratingFilter.has(2)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([1, 2]);
    }
  }
}

/**
 * 接続状態フィルタUIの更新関数
 */
function updateConnectionFilterUI() {
  const onlineNav = elements.onlineOnlyNavItem || document.getElementById('onlineOnlyNavItem');
  const offlineNav = elements.offlineOnlyNavItem || document.getElementById('offlineOnlyNavItem');
  const unlinkedNav = elements.unlinkedOnlyNavItem || document.getElementById('unlinkedOnlyNavItem');
  const folderTreeUnlinked = elements.folderTreeUnlinkedItem || document.getElementById('folderTreeUnlinkedItem');
  const dupNav = elements.duplicatesOnlyNavItem || document.getElementById('duplicatesOnlyNavItem');

  if (onlineNav) onlineNav.classList.toggle('active', state.connectionFilter === 'online');
  if (offlineNav) offlineNav.classList.toggle('active', state.connectionFilter === 'offline');
  if (unlinkedNav) unlinkedNav.classList.toggle('active', state.connectionFilter === 'unlinked');
  if (folderTreeUnlinked) folderTreeUnlinked.classList.toggle('active', state.connectionFilter === 'unlinked');
  if (dupNav) dupNav.classList.toggle('active', state.connectionFilter === 'duplicates');

  const allNav = elements.allPhotosNavItem || document.getElementById('allPhotosNavItem');
  const connSet = (state.connectionStates instanceof Set && state.connectionStates.size > 0)
    ? state.connectionStates
    : new Set(['online', 'offline', 'unlinked']);
  const isDup = (state.connectionFilter === 'duplicates');
  const isAllThree = !isDup && connSet.size === 3;
  const isTopAllContext = (!state.currentFilter || state.currentFilter.type === 'all') && !state.untaggedOnly && !isDup;

  if (allNav) {
    allNav.classList.toggle('active', isTopAllContext && isAllThree);
  }

  [
    { el: onlineNav, key: 'online' },
    { el: offlineNav, key: 'offline' },
    { el: unlinkedNav, key: 'unlinked' },
  ].forEach(({ el, key }) => {
    if (!el) return;
    const isOn = !isDup && connSet.has(key);
    const isSingle = !isDup && connSet.size === 1 && connSet.has(key);
    el.classList.toggle('is-conn-on', isOn);
    el.classList.toggle('is-conn-off', !isOn);
    el.classList.toggle('active', isSingle);
  });
  if (folderTreeUnlinked) {
    folderTreeUnlinked.classList.toggle('active', !isDup && connSet.size === 1 && connSet.has('unlinked'));
  }
  syncHeaderScopeSelect();
  syncAttrFilterButtons();
  updateRatingFilterUI();
}

/**
 * フッター/ヘッダーの4つのドロップダウンのツールチップ（title属性）に現在の選択項目名を反映する
 */
function updateHeaderSelectTooltip(sel) {
  if (!sel || !sel.options || sel.selectedIndex < 0) return;
  const opt = sel.options[sel.selectedIndex];
  const optText = opt ? (opt.textContent || '').trim() : '';
  if (!optText) return;
  const isEn = Boolean(window.pmI18n && typeof window.pmI18n.getLang === 'function' && window.pmI18n.getLang() === 'en');
  const prefixMapJa = {
    headerScopeSelect: '表示対象',
    headerAttrSelect: '形式・状態',
    sortBySelect: '並び替え',
    viewModeSelect: 'レイアウト',
  };
  const prefixMapEn = {
    headerScopeSelect: 'Scope',
    headerAttrSelect: 'Format / State',
    sortBySelect: 'Sort By',
    viewModeSelect: 'Layout',
  };
  const prefix = (isEn ? prefixMapEn[sel.id] : prefixMapJa[sel.id]) || '';
  const nextTitle = prefix ? `${prefix}: ${optText}` : optText;
  if (sel.__pmAttrOrig) delete sel.__pmAttrOrig.title;
  if (sel.__pmAttrEn) delete sel.__pmAttrEn.title;
  sel.setAttribute('title', nextTitle);
}

function syncHeaderSelectTooltips() {
  ['headerScopeSelect', 'headerAttrSelect', 'sortBySelect', 'viewModeSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (el) updateHeaderSelectTooltip(el);
  });
}
window.syncHeaderSelectTooltips = syncHeaderSelectTooltips;

/**
 * ヘッダーの表示対象（スコープ）ドロップダウン（#headerScopeSelect）を現在の state と同期する
 */
function syncHeaderScopeSelect() {
  const sel = elements.headerScopeSelect || document.getElementById('headerScopeSelect');
  if (!sel) return;
  let targetVal = 'all';
  if (state.untaggedOnly) {
    targetVal = 'untagged';
  } else if (state.connectionFilter === 'duplicates') {
    targetVal = 'duplicates';
  } else if (state.connectionFilter === 'online') {
    targetVal = 'online';
  } else if (state.connectionFilter === 'offline') {
    targetVal = 'offline';
  } else if (state.connectionFilter === 'unlinked' || state.connectionFilter === 'missing') {
    targetVal = 'unlinked';
  }
  if (sel.value !== targetVal) {
    sel.value = targetVal;
  }
  updateHeaderSelectTooltip(sel);
}
window.syncHeaderScopeSelect = syncHeaderScopeSelect;

/**
 * ヘッダーの表示対象（スコープ）ドロップダウン（#headerScopeSelect）変更時の適用処理
 */
function applyHeaderScopeFilter(scopeValue) {
  const val = scopeValue || 'all';
  if (val === 'untagged') {
    state.untaggedOnly = true;
    state.tagFilters.clear();
    if (state.tagAndRoots) state.tagAndRoots.clear();
    state.tagInterGroupMode = 'and';
    state.connectionFilter = 'all';
    state.connectionStates = new Set(['online', 'offline', 'unlinked']);
    state.onlineOnly = false;
    if (!state.currentFilter || state.currentFilter.type === 'all' || state.currentFilter.type === 'untagged') {
      state.currentFilter = { type: 'untagged', value: null, titleText: '未分類の写真' };
      if (elements.viewTitle) elements.viewTitle.textContent = '未分類の写真';
    }
    if (elements.untaggedNavItem) elements.untaggedNavItem.classList.add('active');
    updateConnectionFilterUI();
    renderTagList();
    fetchPhotos();
    return;
  }

  if (state.untaggedOnly) {
    state.untaggedOnly = false;
    if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');
    if (state.currentFilter && state.currentFilter.type === 'untagged') {
      state.currentFilter = { type: 'all', value: null, titleText: 'すべての写真' };
    }
    renderTagList();
  }

  if (val === 'all') {
    state.connectionStates = new Set(['online', 'offline', 'unlinked']);
    _syncConnectionFilterAndTitleFromSet();
  } else if (val === 'online' || val === 'offline' || val === 'unlinked') {
    if (val === 'unlinked' && state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude')) {
      state.currentFilter = { type: 'all', value: null, titleText: 'リンク消失の写真（実体パス未登録）' };
      document.querySelectorAll('.sidebar .nav-item, .sidebar .folder-tree-item').forEach(el => {
        el.classList.remove('active', 'active-exclude');
      });
      if (typeof window.syncFolderTreeFilterStates === 'function') window.syncFolderTreeFilterStates();
      if (typeof window.syncSidebarMediaActiveStates === 'function') window.syncSidebarMediaActiveStates();
    }
    state.connectionStates = new Set([val]);
    _syncConnectionFilterAndTitleFromSet();
  } else if (val === 'duplicates') {
    state.connectionFilter = 'duplicates';
    state.onlineOnly = false;
    if (elements.viewTitle) elements.viewTitle.textContent = '重複のある写真';
  }
  updateConnectionFilterUI();
  fetchPhotos();
}
window.applyHeaderScopeFilter = applyHeaderScopeFilter;

/**
 * 接続状態フィルタの切替（トグル）
 */
function _syncConnectionFilterAndTitleFromSet() {
  const connSet = (state.connectionStates instanceof Set && state.connectionStates.size > 0)
    ? state.connectionStates
    : new Set(['online', 'offline', 'unlinked']);
  state.connectionStates = connSet;

  if (connSet.size >= 3) {
    state.connectionFilter = 'all';
    state.onlineOnly = false;
    if (!state.currentFilter || state.currentFilter.type === 'all') {
      elements.viewTitle.textContent = 'すべての写真';
    }
  } else if (connSet.size === 1) {
    const onlyKey = Array.from(connSet)[0];
    state.connectionFilter = onlyKey;
    state.onlineOnly = (onlyKey === 'online');
    if (onlyKey === 'online') {
      elements.viewTitle.textContent = '接続中の写真';
    } else if (onlyKey === 'offline') {
      elements.viewTitle.textContent = '未接続の写真';
    } else if (onlyKey === 'unlinked') {
      elements.viewTitle.textContent = 'リンク消失の写真（実体パス未登録）';
    }
  } else {
    state.connectionFilter = 'custom_conn';
    state.onlineOnly = false;
    const parts = [];
    if (connSet.has('online')) parts.push('接続中');
    if (connSet.has('offline')) parts.push('未接続');
    if (connSet.has('unlinked')) parts.push('リンク消失');
    if (!state.currentFilter || state.currentFilter.type === 'all') {
      elements.viewTitle.textContent = `${parts.join('・')}の写真`;
    }
  }
}

/**
 * 左端インジケータークリックによる個別ON/OFFトグル（方式2）
 */
function toggleConnectionStateItem(key) {
  if (!(state.connectionStates instanceof Set) || state.connectionStates.size === 0 || state.connectionFilter === 'duplicates') {
    state.connectionStates = new Set(['online', 'offline', 'unlinked']);
  }
  if (state.connectionStates.has(key)) {
    state.connectionStates.delete(key);
    if (state.connectionStates.size === 0) {
      state.connectionStates = new Set(['online', 'offline', 'unlinked']);
    }
  } else {
    state.connectionStates.add(key);
  }
  _syncConnectionFilterAndTitleFromSet();
  updateConnectionFilterUI();
  fetchPhotos();
}
window.toggleConnectionStateItem = toggleConnectionStateItem;

function setConnectionFilter(type) {
  if (type === 'all') {
    state.connectionStates = new Set(['online', 'offline', 'unlinked']);
    _syncConnectionFilterAndTitleFromSet();
    updateConnectionFilterUI();
    fetchPhotos();
    return;
  }
  if (type === 'online' || type === 'offline' || type === 'unlinked' || type === 'missing') {
    const normKey = type === 'missing' ? 'unlinked' : type;
    const isAlreadySingle = state.connectionFilter !== 'duplicates'
      && state.connectionStates instanceof Set
      && state.connectionStates.size === 1
      && state.connectionStates.has(normKey);
    if (isAlreadySingle) {
      state.connectionStates = new Set(['online', 'offline', 'unlinked']);
    } else {
      if (normKey === 'unlinked' && state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude')) {
        state.currentFilter = { type: 'all', value: null, titleText: 'リンク消失の写真（実体パス未登録）' };
        document.querySelectorAll('.sidebar .nav-item, .sidebar .folder-tree-item').forEach(el => {
          el.classList.remove('active', 'active-exclude');
        });
        if (typeof window.syncFolderTreeFilterStates === 'function') window.syncFolderTreeFilterStates();
        if (typeof window.syncSidebarMediaActiveStates === 'function') window.syncSidebarMediaActiveStates();
      }
      state.connectionStates = new Set([normKey]);
    }
    _syncConnectionFilterAndTitleFromSet();
    updateConnectionFilterUI();
    fetchPhotos();
    return;
  }
  if (state.connectionFilter === type) {
    state.connectionFilter = 'all';
    state.connectionStates = new Set(['online', 'offline', 'unlinked']);
    if (state.currentFilter.type === 'all') {
      elements.viewTitle.textContent = 'すべての写真';
    }
  } else {
    state.connectionFilter = type;
    if (type === 'duplicates') {
      elements.viewTitle.textContent = '重複のある写真';
    }
  }
  state.onlineOnly = (state.connectionFilter === 'online');
  updateConnectionFilterUI();
  fetchPhotos();
}

/**
 * すべてのフィルタを一括解除して初期状態に戻す
 */
function resetAllFilters() {
  // 1. フィルタ条件のリセット
  state.ratingFilter = new Set([0, 1, 2]);
  updateRatingFilterUI();

  state.attrFilter = 'all';
  updateAttrFilterUI();

  state.searchQuery = '';
  if (elements.searchInput) elements.searchInput.value = '';
  if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = 'none';

  state.tagFilters.clear();
  if (state.tagAndRoots) state.tagAndRoots.clear();
  state.tagInterGroupMode = 'and';
  state.selectedYearMonths.clear();
  if (state.selectedDates) state.selectedDates.clear();
  state.lastClickedCalendarDate = null;
  state.selectedCameras.clear();
  if (state.cameraFilters) state.cameraFilters.clear();
  if (state.lensFilters) state.lensFilters.clear();
  if (state.selectedLenses) state.selectedLenses.clear();
  state.labFilter = null;
  state.onThisDay = null;
  state.focalRange = null;
  state.focalRangeLabel = null;
  state.apertureRange = null;
  state.apertureRangeLabel = null;
  if (typeof window.updateLabUIState === 'function') {
    window.updateLabUIState();
  }
  state.untaggedOnly = false;
  state.connectionFilter = 'all';
  state.onlineOnly = false;
  state.activeLocation = null;
  if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();

  // 2. 表示・ソート設定を標準状態にリセット
  // ソート順: 新しい順
  state.sortBy = 'date_taken DESC';
  if (elements.sortBySelect) elements.sortBySelect.value = 'date_taken DESC';
  localStorage.setItem('pm_sort_by', 'date_taken DESC');

  // サムネイルサイズ: 230px
  if (elements.thumbnailSizeSlider) elements.thumbnailSizeSlider.value = '230';
  document.documentElement.style.setProperty('--thumbnail-size', '230px');
  localStorage.setItem('pm_thumbnail_size', '230');

  // レイアウトモード: 通常グリッド
  setLayoutMode('grid');
  localStorage.setItem('pm_view_mode', 'grid');

  // 情報表示モード: 通常表示 (クリーン表示解除)
  if (state.isMinimalView) {
    toggleMinimalView(false);
  }
  localStorage.setItem('pm_minimal_view', 'false');

  // スタック表示: ON
  state.isStacked = true;
  if (elements.toggleStackBtn) elements.toggleStackBtn.classList.add('active');
  localStorage.setItem('pm_stacked', 'true');

  // タグ種別フィルタ: 手動 (デフォルト)
  state.tagSourceFilter = 'manual';
  localStorage.setItem('pm_tag_source_filter', 'manual');

  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');
  state.connectionStates = new Set(['online', 'offline', 'unlinked']);
  updateConnectionFilterUI();
  renderTagList();
  updateCameraActiveClasses();
  if (typeof updateTimelineActiveClasses === 'function') updateTimelineActiveClasses();
  if (state.activePresetId !== undefined) {
    state.activePresetId = null;
    if (window.renderFilterPresetsList) window.renderFilterPresetsList();
    if (window.renderPresetCurrentChips) window.renderPresetCurrentChips();
  }
  setFilter('all', null, 'すべての写真');
}

window.updateRatingFilterUI = updateRatingFilterUI;
window.toggleRatingFilter = toggleRatingFilter;
window.updateConnectionFilterUI = updateConnectionFilterUI;
window.setConnectionFilter = setConnectionFilter;
window.resetAllFilters = resetAllFilters;


/**
 * ヘッダー表示（タイトル・件数・フィルタチップ）の更新
 */
function updateViewHeader() {
  const countText = state.isLimitReached
    ? `${state.photos.length}+ 枚 (表示上限)`
    : `${state.photos.length} 枚`;
  elements.currentCountBadge.textContent = countText;
  syncHeaderScopeSelect();
  syncAttrFilterButtons();
  updateRatingFilterUI();

  // 適用中フィルタチップの描画
  renderActiveFilterChips();
  if (window.renderPresetCurrentChips) window.renderPresetCurrentChips();
}

function setFilter(type, value, titleText, options = {}) {
  if (type !== 'year_month' && type !== 'year_months') {
    state.selectedYearMonths.clear();
    if (state.selectedDates) state.selectedDates.clear();
  } else if (type === 'year_month' && value) {
    state.selectedYearMonths.clear();
    if (state.selectedDates) state.selectedDates.clear();
    state.selectedYearMonths.add(value);
    const yr = value.split('-')[0];
    if (yr) state.expandedTimelineYears.add(yr);
  }

  if (type !== 'camera' && type !== 'cameras') {
    state.selectedCameras.clear();
    if (state.cameraFilters) state.cameraFilters.clear();
    if (state.lensFilters) state.lensFilters.clear();
    if (state.selectedLenses) state.selectedLenses.clear();
  } else if (type === 'camera' && value) {
    state.selectedCameras.clear();
    state.selectedCameras.add(value);
    if (state.cameraFilters) {
      state.cameraFilters.clear();
      state.cameraFilters.set(value, 'include');
    }
  }

  // ジオタグフィルタのリセット（フォルダやクイックアクセス等への移動時）
  if (state.activeLocation) {
    state.activeLocation = null;
    if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();
  }

  if ((type === 'folder' || type === 'folder_exclude') && value) {
    revealFolderInTree(value);
    // リンク消失写真（実体パス未登録）のみ絞り込み中にフォルダを選択した場合は接続状態フィルタを「すべて」に戻す
    const isUnlinkedOnly = state.connectionFilter === 'unlinked'
      || state.connectionFilter === 'missing'
      || (state.connectionStates instanceof Set && state.connectionStates.size === 1 && state.connectionStates.has('unlinked'));
    if (isUnlinkedOnly) {
      state.connectionStates = new Set(['online', 'offline', 'unlinked']);
      state.connectionFilter = 'all';
      state.onlineOnly = false;
    }
  }

  state.currentFilter = {
    type,
    value,
    volumeSerial: (options && options.volumeSerial) || null,
    serialMode: (options && options.serialMode) || null,
    isOffline: Boolean(options && options.isOffline),
    titleText: titleText || '',
  };
  if (type === 'all' && !value) {
    state.untaggedOnly = false;
    if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');
  }
  elements.viewTitle.textContent = titleText;

  // サイドバーのアクティブクラス更新（通常nav-item ＆ フォルダツリー項目）
  document.querySelectorAll('.sidebar .nav-item, .sidebar .folder-tree-item').forEach(el => {
    const isFolderType = (type === 'folder' || type === 'folder_exclude') && el.dataset.filterType === 'folder';
    const isExactMatch = isFolderType ? (el.dataset.filterValue === value) : (el.dataset.filterType === type && (!value || el.dataset.filterValue === value));
    
    if (isExactMatch) {
      if (type === 'folder_exclude') {
        el.classList.remove('active');
        el.classList.add('active-exclude');
      } else {
        el.classList.remove('active-exclude');
        el.classList.add('active');
      }
    } else {
      el.classList.remove('active', 'active-exclude');
    }
  });

  updateConnectionFilterUI();
  if (typeof window.syncFolderTreeFilterStates === 'function') {
    window.syncFolderTreeFilterStates();
  }
  if (typeof window.syncSidebarMediaActiveStates === 'function') {
    window.syncSidebarMediaActiveStates();
  }
  updateTimelineActiveClasses();
  updateCameraActiveClasses();
  if (typeof pulseHeaderTetheract === 'function') {
    pulseHeaderTetheract(780);
  }
  fetchPhotos();
}

/**
 * 複数写真を現在の一覧から一括除去する（1パス O(N) で state.photos・Mapインデックス・DOM再採番を完結）。
 */
function removePhotosFromViewBatch(photoIds, options = {}) {
  const targetSet = new Set();
  if (Array.isArray(photoIds) || photoIds instanceof Set) {
    for (const id of photoIds) {
      const n = Number(id);
      if (n) targetSet.add(n);
    }
  }
  if (targetSet.size === 0 || !Array.isArray(state.photos) || state.photos.length === 0) return;

  const explicitAnchorId = options && options.anchorPhotoId ? Number(options.anchorPhotoId) : null;
  const autoAnchorInfo = explicitAnchorId
    ? { anchorId: explicitAnchorId }
    : findNextRemainingPhotoAfterTargets(targetSet, targetSet);
  const anchorPhotoId = autoAnchorInfo ? autoAnchorInfo.anchorId : null;

  const singleTargetId = targetSet.size === 1 ? targetSet.values().next().value : null;
  const wasSingleFocused = Boolean(
    singleTargetId !== null &&
    state.currentPhotoIndex < 0 &&
    ((state.selectedPhotoIds.size === 1 && state.selectedPhotoIds.has(singleTargetId)) ||
     (state.selectedPhotoIds.size === 0 && state.activeInspectorPhotoId === singleTargetId))
  );

  const oldPhotos = state.photos;
  const oldLen = oldPhotos.length;
  const oldRenderedCount = renderedGridCount;
  const oldLastSel = state.lastSelectedIndex;
  const oldAnchor = state.selectionAnchorIndex !== undefined ? state.selectionAnchorIndex : -1;
  const oldLbIdx = state.currentPhotoIndex;

  let removedCount = 0;
  let firstRemovedIdx = -1;
  let removedSinglePhoto = null;
  let removedRenderedCount = 0;
  let lastSelRemoved = false;
  let removedBeforeLastSel = 0;
  let anchorRemoved = false;
  let removedBeforeAnchor = 0;
  let lbCurrentRemoved = false;
  let removedBeforeLb = 0;

  // 単一ID削除時は findIndex + splice + O(1) Map delete ファストパス、複数ID時は 1パスフィルタ + 1回 rebuild
  if (singleTargetId !== null) {
    const idx = oldPhotos.findIndex(p => p.id === singleTargetId);
    if (idx === -1) return;
    removedCount = 1;
    firstRemovedIdx = idx;
    removedSinglePhoto = oldPhotos[idx];
    if (idx < oldRenderedCount) removedRenderedCount = 1;
    if (oldLastSel !== -1) {
      if (idx === oldLastSel) lastSelRemoved = true;
      else if (idx < oldLastSel) removedBeforeLastSel = 1;
    }
    if (oldAnchor !== -1) {
      if (idx === oldAnchor) anchorRemoved = true;
      else if (idx < oldAnchor) removedBeforeAnchor = 1;
    }
    if (oldLbIdx >= 0) {
      if (idx === oldLbIdx) lbCurrentRemoved = true;
      else if (idx < oldLbIdx) removedBeforeLb = 1;
    }
    oldPhotos.splice(idx, 1);
    if (typeof removePhotoFromByIdIndex === 'function') {
      removePhotoFromByIdIndex(removedSinglePhoto);
    } else if (typeof rebuildPhotoByIdIndex === 'function') {
      rebuildPhotoByIdIndex();
    }
  } else {
    const nextPhotos = [];
    for (let i = 0; i < oldLen; i++) {
      const p = oldPhotos[i];
      if (p && targetSet.has(p.id)) {
        removedCount++;
        if (firstRemovedIdx === -1) firstRemovedIdx = i;
        if (i < oldRenderedCount) removedRenderedCount++;
        if (oldLastSel !== -1) {
          if (i === oldLastSel) lastSelRemoved = true;
          else if (i < oldLastSel) removedBeforeLastSel++;
        }
        if (oldAnchor !== -1) {
          if (i === oldAnchor) anchorRemoved = true;
          else if (i < oldAnchor) removedBeforeAnchor++;
        }
        if (oldLbIdx >= 0) {
          if (i === oldLbIdx) lbCurrentRemoved = true;
          else if (i < oldLbIdx) removedBeforeLb++;
        }
      } else {
        nextPhotos.push(p);
      }
    }
    if (removedCount === 0) return;
    state.photos = nextPhotos;
    if (typeof rebuildPhotoByIdIndex === 'function') {
      rebuildPhotoByIdIndex();
    }
  }

  // 選択状態のクリーンアップ
  let selectionChanged = false;
  for (const pid of targetSet) {
    if (state.selectionBaseIds) state.selectionBaseIds.delete(pid);
    if (state.selectedPhotoIds.delete(pid)) {
      selectionChanged = true;
    }
  }
  if (selectionChanged) {
    updateCardSelectionClasses();
    updateSelectionUI();
  }

  // Shift範囲選択の起点インデックスの補正
  if (oldLastSel !== -1) {
    state.lastSelectedIndex = lastSelRemoved ? -1 : (oldLastSel - removedBeforeLastSel);
  }
  if (state.selectionAnchorIndex !== undefined && oldAnchor !== -1) {
    state.selectionAnchorIndex = anchorRemoved ? -1 : (oldAnchor - removedBeforeAnchor);
  }

  if (state.photos.length === 0) {
    renderPhotoGrid();
  } else {
    if (_gridVirtualState.enabled) {
      if (_canUseVirtualPhotoGrid()) {
        syncVirtualPhotoGrid({ forceRemount: true });
      } else {
        renderPhotoGrid();
      }
    } else {
      if (removedRenderedCount > 0) {
        renderedGridCount = Math.max(0, oldRenderedCount - removedRenderedCount);
        const grid = elements.photoGrid || document.getElementById('photoGrid');
        if (grid) {
          const cards = grid.querySelectorAll('.photo-card');
          let nextCardIdx = 0;
          for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const cid = Number(card.dataset.photoId);
            if (targetSet.has(cid)) {
              card.remove();
            } else {
              if (Number(card.dataset.index) !== nextCardIdx) {
                card.dataset.index = nextCardIdx;
              }
              nextCardIdx++;
            }
          }
        }
      }
      checkAndAppendGridChunksIfNeeded();
    }

    // 単一フォーカス中の写真が評価変更等で一覧から除外された場合、次の写真へ自動的にフォーカスを引き継ぐ
    if (wasSingleFocused && state.photos.length > 0) {
      const nextIdx = Math.min(firstRemovedIdx, state.photos.length - 1);
      const nextPhoto = state.photos[nextIdx];
      if (nextPhoto) {
        state.selectedPhotoIds.clear();
        state.selectedPhotoIds.add(nextPhoto.id);
        state.lastSelectedIndex = nextIdx;
        state.selectionAnchorIndex = nextIdx;
        state.activeInspectorPhotoId = nextPhoto.id;
        updateCardSelectionClasses();
        updateSelectionUI();
      }
    } else if (state.activeInspectorPhotoId && targetSet.has(Number(state.activeInspectorPhotoId))) {
      state.activeInspectorPhotoId = anchorPhotoId || (state.photos[0] ? state.photos[0].id : null);
    }

    if (oldLbIdx < 0 && anchorPhotoId && state.photos.length > 0) {
      const shouldForceAlign = removedCount > 1 || Boolean(options && options.forceAlign);
      scrollPhotoIntoComfortZone(anchorPhotoId, { forceAlign: shouldForceAlign });
    }
  }

  // ヘッダー件数表示の更新
  updateViewHeader();

  // ライトボックス表示中なら currentPhotoIndex との整合を調整
  if (oldLbIdx >= 0) {
    if (state.photos.length === 0) {
      closeLightbox();
    } else if (lbCurrentRemoved) {
      state.currentPhotoIndex = Math.min(oldLbIdx - removedBeforeLb, state.photos.length - 1);
      state.currentRotation = 0;
      resetLightboxZoom();
      loadLightboxPhoto();
      renderFilmstrip();
    } else {
      if (removedBeforeLb > 0) {
        state.currentPhotoIndex = oldLbIdx - removedBeforeLb;
      }
      renderFilmstrip();
    }
  }
}
window.removePhotosFromViewBatch = removePhotosFromViewBatch;

/**
 * 指定写真を現在の一覧から除去する（評価・タグフィルタ外になった単一写真用）。
 */
function removePhotoFromView(photoId) {
  removePhotosFromViewBatch([photoId]);
}

/**
 * スタックメンバー配列から評価優先（優 > 良 > 可 > 棄）で表紙となる代表写真を自動選出する
 */
function electBestStackMember(stackPhotos, stackType) {
  if (!Array.isArray(stackPhotos) || stackPhotos.length === 0) return null;
  const candidates = stackPhotos.filter(sp => !(sp.is_raw && sp.paired_raw_path));
  const list = candidates.length > 0 ? candidates : stackPhotos;
  const isBracket = (stackType === 'bracket');
  let best = list[0];
  let bestIdx = 0;
  for (let i = 1; i < list.length; i++) {
    const cur = list[i];
    const rBest = Number(best.rating ?? 0);
    const rCur = Number(cur.rating ?? 0);
    if (rCur > rBest) {
      best = cur;
      bestIdx = i;
    } else if (rCur === rBest && isBracket) {
      const biasBest = Math.abs(Number(best.exposure_bias || 0));
      const biasCur = Math.abs(Number(cur.exposure_bias || 0));
      if (biasCur < biasBest - 1e-4) {
        best = cur;
        bestIdx = i;
      }
    }
  }
  return best;
}
window.electBestStackMember = electBestStackMember;

/**
 * スタック内の写真の評価変更後に、表紙（代表写真）を自動再計算してグリッド・状態を同期する
 */
function syncStackCoverAfterRatingChange(ratedPhotoId) {
  const gridIdx = state.photos.findIndex(p =>
    p.id === ratedPhotoId || (Array.isArray(p.stack_photos) && p.stack_photos.some(sp => sp.id === ratedPhotoId))
  );
  if (gridIdx === -1) return { isStackMember: false, coverPhotoId: ratedPhotoId, coverRating: null };

  const gridPhoto = state.photos[gridIdx];
  const stackPhotos = gridPhoto.stack_photos;
  if (!isEffectiveStacked() || !Array.isArray(stackPhotos) || stackPhotos.length <= 1) {
    return { isStackMember: false, coverPhotoId: gridPhoto.id, coverRating: gridPhoto.rating ?? 0 };
  }

  const bestMember = electBestStackMember(stackPhotos, gridPhoto.stack_type);
  if (!bestMember) {
    return { isStackMember: false, coverPhotoId: gridPhoto.id, coverRating: gridPhoto.rating ?? 0 };
  }

  const oldPrimaryId = gridPhoto.id;
  const newPrimaryId = bestMember.id;

  stackPhotos.forEach(sp => {
    sp.stack_id = newPrimaryId;
    sp.is_stack_primary = (sp.id === newPrimaryId) ? 1 : 0;
  });
  if (Array.isArray(state.currentLightboxStackPhotos)) {
    state.currentLightboxStackPhotos.forEach(sp => {
      if (stackPhotos.some(m => m.id === sp.id)) {
        sp.stack_id = newPrimaryId;
        sp.is_stack_primary = (sp.id === newPrimaryId) ? 1 : 0;
      }
    });
  }

  if (newPrimaryId !== oldPrimaryId) {
    const oldMemberRef = stackPhotos.find(sp => sp && sp.id === oldPrimaryId);
    if (oldMemberRef && !oldMemberRef._detailLoaded) {
      for (const [k, v] of Object.entries(gridPhoto)) {
        if (k === 'stack_photos' || k === 'stack_count' || k === 'stack_id' || k === 'is_stack_primary') continue;
        if (!(k in oldMemberRef)) oldMemberRef[k] = v;
      }
      oldMemberRef._detailLoaded = true;
    }
    const inferredRawFormat = bestMember.raw_format ?? (
      bestMember.is_raw && bestMember.file_name && bestMember.file_name.includes('.')
        ? bestMember.file_name.slice(bestMember.file_name.lastIndexOf('.')).toLowerCase()
        : null
    );
    const newGridPhoto = {
      ...gridPhoto,
      ...bestMember,
      rotation: bestMember.rotation ?? 0,
      fine_angle: bestMember.fine_angle ?? 0,
      brightness: bestMember.brightness ?? 0,
      contrast: bestMember.contrast ?? 0,
      saturation: bestMember.saturation ?? 0,
      crop_x: bestMember.crop_x ?? null,
      crop_y: bestMember.crop_y ?? null,
      crop_w: bestMember.crop_w ?? null,
      crop_h: bestMember.crop_h ?? null,
      crop_aspect: bestMember.crop_aspect ?? null,
      thumb_width: bestMember.thumb_width ?? null,
      thumb_height: bestMember.thumb_height ?? null,
      paired_raw_path: bestMember.paired_raw_path ?? null,
      raw_format: inferredRawFormat,
      subsec_time: bestMember.subsec_time ?? null,
      has_xmp: bestMember.has_xmp ?? 0,
      tags: Array.isArray(bestMember.tags) ? [...bestMember.tags] : [],
      tag_details: Array.isArray(bestMember.tag_details) ? [...bestMember.tag_details] : [],
      _thumbBust: bestMember._thumbBust,
      stack_id: newPrimaryId,
      is_stack_primary: 1,
      stack_photos: stackPhotos,
      stack_count: gridPhoto.stack_count || stackPhotos.length,
      stack_type: gridPhoto.stack_type,
      duplicate_count: gridPhoto.duplicate_count,
    };
    state.photos[gridIdx] = newGridPhoto;
    if (typeof rebuildPhotoByIdIndex === 'function') {
      rebuildPhotoByIdIndex();
    }

    if (elements.photoGrid && typeof createPhotoCard === 'function') {
      const oldCard = elements.photoGrid.querySelector(`.photo-card[data-photo-id="${oldPrimaryId}"], .photo-card[data-index="${gridIdx}"]`);
      if (oldCard) {
        const newCard = createPhotoCard(newGridPhoto, gridIdx);
        oldCard.replaceWith(newCard);
      }
    }

    if (elements.filmstrip && elements.filmstrip.children[gridIdx]) {
      const stripItem = elements.filmstrip.children[gridIdx];
      const img = stripItem.querySelector('img');
      if (img) {
        img.src = getThumbnailUrl(newGridPhoto);
        img.alt = newGridPhoto.file_name || '';
      }
    }

    if (state.selectedPhotoIds && state.selectedPhotoIds.has(oldPrimaryId)) {
      state.selectedPhotoIds.delete(oldPrimaryId);
      state.selectedPhotoIds.add(newPrimaryId);
      updateCardSelectionClasses();
    }
    if (state.activeInspectorPhotoId === oldPrimaryId) {
      state.activeInspectorPhotoId = newPrimaryId;
    }

    // スリム化された stack_photos に未収録の個別メタデータ（has_xmp, tags, camera_model, 接続状態等）を非同期補完して再同期
    if (!bestMember._detailLoaded && typeof ensureStackMemberDetail === 'function') {
      ensureStackMemberDetail(bestMember).then((loadedMember) => {
        if (!loadedMember || !loadedMember._detailLoaded) return;
        let curIdx = (state.photos[gridIdx] && state.photos[gridIdx].id === newPrimaryId)
          ? gridIdx
          : state.photos.findIndex(p => p && p.id === newPrimaryId);
        if (curIdx < 0) return;
        const activeCover = state.photos[curIdx];
        const preserveKeys = new Set([
          'stack_id', 'is_stack_primary', 'stack_photos', 'stack_count',
          'stack_type', 'duplicate_count', 'rating', '_thumbBust',
        ]);
        for (const [k, v] of Object.entries(loadedMember)) {
          if (preserveKeys.has(k) || k.startsWith('_detail')) continue;
          activeCover[k] = v;
        }
        if (elements.photoGrid && typeof createPhotoCard === 'function') {
          const liveCard = elements.photoGrid.querySelector(`.photo-card[data-photo-id="${newPrimaryId}"]`);
          if (liveCard) {
            liveCard.replaceWith(createPhotoCard(activeCover, curIdx));
          }
        }
        if (state.isInspectorOpen && state.activeInspectorPhotoId === newPrimaryId && typeof updateInspectorView === 'function') {
          updateInspectorView();
        }
      });
    }
  } else {
    gridPhoto.rating = bestMember.rating ?? 0;
    updateCardRatingDirectly(gridPhoto.id, gridPhoto.rating);
  }

  return {
    isStackMember: true,
    coverPhotoId: newPrimaryId,
    coverRating: Number(bestMember.rating ?? 0),
  };
}
window.syncStackCoverAfterRatingChange = syncStackCoverAfterRatingChange;

/**
 * 評価の更新 (API送信)
 */
async function updatePhotoRating(photoId, newRating) {
  try {
    // ローカル状態の更新
    const target = typeof getPhotoById === 'function' ? getPhotoById(photoId) : state.photos.find(p => p.id === photoId);
    if (target) {
      target.rating = newRating;
    }

    // スタック内の該当写真オブジェクトも同期更新
    if (typeof findAllPhotoInstancesById === 'function') {
      findAllPhotoInstancesById(photoId).forEach(inst => {
        inst.rating = newRating;
      });
    } else {
      state.photos.forEach(p => {
        if (p.stack_photos) {
          const sm = p.stack_photos.find(sp => sp.id === photoId);
          if (sm) sm.rating = newRating;
        }
      });
      if (state.currentLightboxStackPhotos) {
        const sm = state.currentLightboxStackPhotos.find(sp => sp.id === photoId);
        if (sm) sm.rating = newRating;
      }
    }

    // プレビュー中ならライトボックス側の評価および下部スタックセレクタも更新
    const curLight = getCurrentLightboxPhoto();
    if (curLight && curLight.id === photoId) {
      curLight.rating = newRating;
      updateLightboxRating(newRating);
    }
    if (typeof window.syncLightboxBracketPillsRatingUI === 'function') {
      window.syncLightboxBracketPillsRatingUI();
    }

    // インスペクタで表示中の写真なら、インスペクタ内の評価ボタンactive状態も即時更新
    if (state.activeInspectorPhotoId === photoId && elements.inspectorRatingBtns) {
      elements.inspectorRatingBtns.querySelectorAll('.rating-btn').forEach(b => {
        const bVal = parseInt(b.dataset.rating, 10);
        b.classList.toggle('active', bVal === newRating);
      });
    }

    // スタック表示中は評価優先で表紙（代表）を自動再選出、単体時は写真カードDOMを直接更新
    const syncRes = syncStackCoverAfterRatingChange(photoId);
    if (!syncRes.isStackMember) {
      updateCardRatingDirectly(photoId, newRating);
    }

    // 新しい評価（スタック時は表紙の最高評価）が評価フィルタに含まれない場合は一覧から除去する
    const effectiveRating = syncRes.isStackMember ? syncRes.coverRating : newRating;
    const effectiveCardId = syncRes.isStackMember ? syncRes.coverPhotoId : photoId;
    const isFilteredOut = state.ratingFilter && state.ratingFilter.size > 0 && !state.ratingFilter.has(effectiveRating);
    if (isFilteredOut) {
      removePhotoFromView(effectiveCardId);
    }

    const response = await fetch(`/api/photo/${photoId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: newRating }),
    });

    if (!response.ok) throw new Error('評価の更新に失敗しました');

    state.calendarDaysMap = null;

    if (state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.has(photoId)) {
      state.activeInspectorPhotoId = photoId;
    }
  } catch (error) {
    console.error('評価更新エラー:', error);
    showToast('評価の更新に失敗しました', 'error');
  }
}

/**
 * ライトボックス (全画面プレビュー) を開く

 */
/**
 * アコーディオン式サイドバーの初期化（排他的制御: 展開できるメニューは1つのみ）
 */
function initSidebarAccordion() {
  const sidebar = document.getElementById('sidebar');
  const items = document.querySelectorAll('.sidebar-accordion .accordion-item');
  const railBtns = document.querySelectorAll('#sidebarRail .rail-tab-btn');
  if (!items.length || !sidebar) return;

  // 2段階サイドバー用：現在選択中のタブセクション名（常に1つを表示）
  const STORAGE_KEY = 'pm_accordion_active_section';
  const validSections = new Set(['quick', 'folder', 'tags', 'location', 'timeline', 'camera', 'lab', 'search']);
  let activeSection = 'quick';

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && validSections.has(saved)) {
      activeSection = saved;
    }
  } catch (e) {
    activeSection = 'quick';
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, activeSection || 'quick');
    } catch (e) {}
  }

  function syncRailButtons() {
    const isMenuVisible = state.isSidebarOpen || sidebar.classList.contains('is-overlay-open');
    railBtns.forEach(btn => {
      const sec = btn.dataset.section;
      btn.classList.toggle('active', isMenuVisible && sec === activeSection);
    });
  }
  window.syncSidebarRailActiveState = syncRailButtons;

  function applyActiveSection() {
    if (!activeSection || !validSections.has(activeSection)) {
      activeSection = 'quick';
    }
    items.forEach(item => {
      const sec = item.dataset.section;
      const isOpen = (sec === activeSection);
      item.classList.toggle('is-open', isOpen);
    });
    syncRailButtons();
    saveState();

    const isMenuVisible = state.isSidebarOpen || sidebar.classList.contains('is-overlay-open');
    if (!isMenuVisible) return;

    // 検索セクションが開いた場合は入力欄にフォーカス
    if (activeSection === 'search' && elements.searchInput) {
      setTimeout(() => elements.searchInput.focus(), 80);
    }
    // クイックアクセスが開いた場合はチップ描画
    if ((activeSection === 'quick' || activeSection === 'presets') && window.renderPresetCurrentChips) {
      window.renderPresetCurrentChips();
    }
    // フォルダセクションが開いた場合は初回ロード確認
    if (activeSection === 'folder' && typeof window.loadFolderTree === 'function') {
      const folderList = document.getElementById('folderList');
      if (!folderList || folderList.children.length === 0 || folderList.querySelector('.empty-hint')) {
        window.loadFolderTree();
      }
    }
    // 場所セクションが開いた場合はツリーを最新化
    if (activeSection === 'location' && window.loadLocationTree) {
      window.loadLocationTree();
    }
  }

  function setSectionOpen(sectionName, isOpen) {
    if (isOpen && validSections.has(sectionName)) {
      activeSection = sectionName;
      if (!state.isSidebarOpen) {
        sidebar.classList.add('is-overlay-open');
      }
    } else if (!isOpen && !state.isSidebarOpen) {
      sidebar.classList.remove('is-overlay-open');
    }
    applyActiveSection();
  }

  function toggleSection(sectionName) {
    if (!validSections.has(sectionName)) return;
    if (!state.isSidebarOpen) {
      // メニューオフ（アイコン列のみ）モード時：
      // 既にオーバーレイ表示中の同じタブを押したらオーバーレイを閉じ、別タブならオーバーレイ展開して切替
      const isOverlayOpen = sidebar.classList.contains('is-overlay-open');
      if (isOverlayOpen && activeSection === sectionName) {
        sidebar.classList.remove('is-overlay-open');
      } else {
        activeSection = sectionName;
        sidebar.classList.add('is-overlay-open');
      }
    } else {
      // 通常ドック表示モード時：即座にセクション切替
      activeSection = sectionName;
    }
    applyActiveSection();
  }

  // 初期開閉状態を反映
  applyActiveSection();

  // 左端 垂直タブレール (.rail-tab-btn) のクリックでメニューエリアを切替（メニューオフ時はオーバーレイ展開）
  railBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sectionName = btn.dataset.section;
      if (sectionName) {
        toggleSection(sectionName);
      }
    });
  });

  // オーバーレイ展開中にサイドバー外側（写真グリッドやヘッダー等）をクリックしたら自動でオーバーレイを閉じる
  document.addEventListener('mousedown', (e) => {
    if (!state.isSidebarOpen && sidebar.classList.contains('is-overlay-open')) {
      if (!sidebar.contains(e.target) && !e.target.closest('.modal-overlay, .context-menu')) {
        sidebar.classList.remove('is-overlay-open');
        syncRailButtons();
      }
    }
  });

  // 各セクションのヘッダークリック互換
  items.forEach(item => {
    const header = item.querySelector('.accordion-header');
    if (!header) return;
    header.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) {
        return;
      }
      const sectionName = item.dataset.section;
      if (sectionName) {
        toggleSection(sectionName);
      }
    });
  });

  // 外部公開・互換API
  window.openSidebarSection = (sectionName) => {
    setSectionOpen(sectionName, true);
    const item = document.getElementById(`accordionItem-${sectionName}`);
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
  window.closeSidebarSection = (sectionName) => {
    if (activeSection === sectionName) {
      setSectionOpen(sectionName, false);
    }
  };
  window.toggleSidebarSection = toggleSection;

  // 旧APIとの互換レイヤー
  window.openFilterDrawer = (tabName) => window.openSidebarSection(tabName);
  window.closeFilterDrawer = () => {};
  window.toggleFilterDrawer = (tabName) => window.toggleSidebarSection(tabName);
  window.isFilterDrawerOpen = () => false;
  window.switchSidebarTab = (tabName) => window.openSidebarSection(tabName);
}

/**
 * イベントリスナー設定
 */
function setupEventListeners() {
  // アコーディオン式サイドバーの初期化
  initSidebarAccordion();

  // ヘッダー右端「メニュー (⚙)」ドロップダウンの開閉制御
  const sysMenuBtn = document.getElementById('headerSystemMenuBtn');
  const sysDropdown = document.getElementById('headerSystemDropdown');
  const sysWrap = document.getElementById('headerSystemMenuWrap');
  if (sysMenuBtn && sysDropdown) {
    sysMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = sysDropdown.style.display !== 'none';
      sysDropdown.style.display = isOpen ? 'none' : 'flex';
      sysMenuBtn.classList.toggle('active', !isOpen);
    });
    // メニュー項目（設定・スマホ・ヘルプ・終了）クリック時にドロップダウンを自動で閉じる（テーマ・言語トグルは開いたまま確認可能）
    ['folderDbMaintenanceBtn', 'openMobileModalBtn', 'openHelpModalBtn', 'openShutdownModalBtn'].forEach(btnId => {
      const b = document.getElementById(btnId);
      if (b) {
        b.addEventListener('click', () => {
          sysDropdown.style.display = 'none';
          sysMenuBtn.classList.remove('active');
        });
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (sysDropdown.style.display !== 'none' && sysWrap && !sysWrap.contains(e.target)) {
        sysDropdown.style.display = 'none';
        sysMenuBtn.classList.remove('active');
      }
    });
  }

  // 左サイドバー開閉ボタン
  if (elements.toggleSidebarBtn) {
    elements.toggleSidebarBtn.addEventListener('click', () => toggleSidebar());
  }

  // インスペクタのタブ切替イベント初期化
  document.querySelectorAll('.inspector-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchInspectorTab(btn.dataset.tab);
    });
  });
  switchInspectorTab(state.inspectorActiveTab);

  // ウィンドウリサイズ時、連写・ブラケット展開状態であれば下部タブが隠れないよう高さを再調整
  window.addEventListener('resize', () => {
    if (elements.inspectorBracketList && !elements.inspectorBracketList.classList.contains('is-collapsed') && elements.inspectorBracketExpanderBtn && elements.inspectorBracketExpanderBtn.style.display !== 'none') {
      const safeMax = elements.inspectorBody ? Math.max(180, elements.inspectorBody.clientHeight - 150) : 380;
      elements.inspectorBracketList.style.maxHeight = `${Math.min(380, safeMax)}px`;
    }
  });

  // ヘッダーツールバーの自動レスポンシブ（幅が狭まった際の段階的なアイコン化判定）
  const appHeader = document.querySelector('.app-header');
  if (appHeader && window.ResizeObserver) {
    const headerObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        appHeader.classList.toggle('toolbar-compact-1', w < 1550);
        appHeader.classList.toggle('toolbar-compact-2', w < 1350);
        appHeader.classList.toggle('toolbar-compact-3', w < 1150);
      }
    });
    headerObserver.observe(appHeader);
  }

  // フォルダツリーの全展開 / 全折りたたみボタン
  const expandAllFoldersBtn = document.getElementById('expandAllFoldersBtn');
  const collapseAllFoldersBtn = document.getElementById('collapseAllFoldersBtn');

  if (expandAllFoldersBtn) {
    expandAllFoldersBtn.addEventListener('click', () => {
      expandFolderTreeToManaged();
    });
  }

  if (collapseAllFoldersBtn) {
    collapseAllFoldersBtn.addEventListener('click', () => {
      collapseFolderTree();
    });
  }

  // フォルダツリーの再読込（ドライブの抜き差し後やファイル削除後の再確認）
  const reloadFolderTreeBtn = document.getElementById('reloadFolderTreeBtn');
  if (reloadFolderTreeBtn) {
    reloadFolderTreeBtn.addEventListener('click', async () => {
      if (typeof refreshFolderTree === 'function') {
        await refreshFolderTree(true);
      }
      await fetchFolders();
      await fetchPhotos();
      if (state.currentFilter.type === 'folder' && state.currentFilter.value && !state.currentFilter.isOffline) {
        _dismissedFolderDiffSignatures.clear();
        const folderName = state.currentFilter.value.split(/[\\/]/).filter(Boolean).pop() || state.currentFilter.value;
        checkAndPromptFolderRefresh(state.currentFilter.value, folderName, {
          volumeSerial: state.currentFilter.volumeSerial || null,
          isOffline: false,
        });
      }
    });
  }

  // 表示レイアウト切替（グリッド / びっしり / マウント）
  const viewModeSel = elements.viewModeSelect || document.getElementById('viewModeSelect');
  if (viewModeSel) {
    viewModeSel.addEventListener('change', (e) => {
      setLayoutMode(e.target.value);
    });
  }
  elements.modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      setLayoutMode(mode);
    });
  });

  // カラーパレットエキスパンダの開閉イベント
  const colorHeader = elements.colorPaletteHeader || document.getElementById('colorPaletteHeader');
  if (colorHeader && !colorHeader.dataset.bound) {
    colorHeader.dataset.bound = 'true';
    colorHeader.addEventListener('click', () => {
      toggleColorPaletteExpander();
    });
    colorHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleColorPaletteExpander();
      }
    });
  }

  // タグアコーディオンの開閉（存在する場合）
  if (elements.tagAccordionHeader) {
    elements.tagAccordionHeader.addEventListener('click', (e) => {
      if (e.target.closest('#openAddTagInputBtn')) return;
      if (elements.tagSection) elements.tagSection.classList.toggle('collapsed');
    });
  }

  // タグ新規作成インライン入力のトグル
  if (elements.openAddTagInputBtn) {
    elements.openAddTagInputBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (elements.tagSection) elements.tagSection.classList.remove('collapsed');
      if (window.openSidebarSection) window.openSidebarSection('tags');
      if (elements.inlineTagCreate) elements.inlineTagCreate.style.display = 'flex';
      if (elements.newTagNameInput) elements.newTagNameInput.focus();
    });
  }

  elements.cancelCreateTagBtn.addEventListener('click', () => {
    elements.inlineTagCreate.style.display = 'none';
    elements.newTagNameInput.value = '';
  });

  // 新規タグ作成実行
  const executeCreateTag = async () => {
    const tagName = elements.newTagNameInput.value.trim();
    if (!tagName) return;

    try {
      const res = await fetch('/api/tags/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tagName }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'タグの作成に失敗しました');
      }
      elements.inlineTagCreate.style.display = 'none';
      elements.newTagNameInput.value = '';
      if (typeof expandTagAncestors === 'function') {
        expandTagAncestors(tagName);
      }
      applyTagsSummaryData(data);
      if (typeof showToast === 'function') {
        showToast(`タグ「${tagName}」を作成しました`, 'success', 2200);
      }
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast(`エラー: ${err.message}`, 'error', 3000);
      }
    }
  };

  elements.confirmCreateTagBtn.addEventListener('click', executeCreateTag);
  elements.newTagNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeCreateTag();
    if (e.key === 'Escape') elements.cancelCreateTagBtn.click();
  });

  // タグ名テキスト絞り込み (Enter確定)
  if (elements.tagSearchInput) {
    elements.tagSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        state.tagSearchQuery = elements.tagSearchInput.value.trim();
        if (elements.clearTagSearchBtn) {
          elements.clearTagSearchBtn.style.display = state.tagSearchQuery ? 'flex' : 'none';
        }
        renderTagList();
      } else if (e.key === 'Escape') {
        elements.tagSearchInput.value = '';
        state.tagSearchQuery = '';
        if (elements.clearTagSearchBtn) {
          elements.clearTagSearchBtn.style.display = 'none';
        }
        renderTagList();
        elements.tagSearchInput.blur();
      }
    });

    elements.tagSearchInput.addEventListener('input', () => {
      // 入力欄が完全に空になったら自動で全表示に戻す
      if (elements.tagSearchInput.value.trim() === '' && state.tagSearchQuery !== '') {
        state.tagSearchQuery = '';
        if (elements.clearTagSearchBtn) {
          elements.clearTagSearchBtn.style.display = 'none';
        }
        renderTagList();
      } else if (elements.clearTagSearchBtn) {
        elements.clearTagSearchBtn.style.display = elements.tagSearchInput.value ? 'flex' : 'none';
      }
    });
  }

  if (elements.clearTagSearchBtn) {
    elements.clearTagSearchBtn.addEventListener('click', () => {
      if (elements.tagSearchInput) {
        elements.tagSearchInput.value = '';
        elements.tagSearchInput.focus();
      }
      state.tagSearchQuery = '';
      elements.clearTagSearchBtn.style.display = 'none';
      renderTagList();
    });
  }

  // タグフィルタ一括クリア
  elements.clearTagFiltersBtn.addEventListener('click', () => {
    clearAllTagFilters();
  });

  // 未分類写真フィルタ (Untagged)
  elements.untaggedNavItem.addEventListener('click', () => {
    state.untaggedOnly = true;
    state.tagFilters.clear();
    state.currentFilter = { type: 'untagged', value: null };
    elements.viewTitle.textContent = '未分類の写真';

    document.querySelectorAll('.sidebar .nav-item').forEach(el => el.classList.remove('active'));
    elements.untaggedNavItem.classList.add('active');
    renderTagList();
    fetchPhotos();
  });

  // ライトボックス内タグ追加
  const executeLightboxAddTag = () => {
    const val = elements.lightboxNewTagInput.value.trim();
    if (!val || state.currentPhotoIndex < 0) return;
    const photo = getCurrentLightboxPhoto();
    if (photo) {
      addTagToCurrentPhoto(photo.id, val);
    }
  };

  elements.lightboxAddTagBtn.addEventListener('click', executeLightboxAddTag);
  elements.lightboxNewTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeLightboxAddTag();
  });

  // 露出ブラケット・連写スタック表示切替（色でON/OFFを識別）
  if (elements.toggleStackBtn) {
    elements.toggleStackBtn.addEventListener('click', () => {
      state.isStacked = !state.isStacked;
      elements.toggleStackBtn.classList.toggle('active', state.isStacked);
      localStorage.setItem('pm_stacked', state.isStacked ? 'true' : 'false');
      fetchPhotos();
    });
  }

  // 絞り込み全解除ボタン（左サイドバー最上部）
  const sidebarResetFilterBtn = document.getElementById('sidebarResetFilterBtn');
  if (sidebarResetFilterBtn) {
    sidebarResetFilterBtn.addEventListener('click', resetAllFilters);
  }

  // 情報表示切替（詳細 / クリーン）
  elements.toggleInfoBtn.addEventListener('click', () => {
    toggleMinimalView();
  });



  // フォルダごと取り込みボタン ＆ 写真ファイル選択ボタン
  const uploadFolderBtn = document.getElementById('uploadFolderBtn');
  if (uploadFolderBtn) {
    uploadFolderBtn.addEventListener('click', () => {
      if (typeof window.openLoomePickerModal === 'function') {
        window.openLoomePickerModal({ mode: 'import_folder' });
      }
    });
  }

  elements.uploadFilesBtn.addEventListener('click', () => {
    window._pendingUploadDest = null;
    elements.fileUploadInput.click();
  });

  elements.fileUploadInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    const pendingDest = window._pendingUploadDest || null;
    window._pendingUploadDest = null;
    if (files && files.length > 0) {
      await uploadPhotos(files, pendingDest);
      elements.fileUploadInput.value = '';
    }
  });

  // ドラッグ＆ドロップ アップロード処理（外部からの実ファイルドロップ時のみオーバーレイを表示）
  let dragCounter = 0;
  const isExternalFileDrag = (e) => {
    if (window._draggingPhotoIds && window._draggingPhotoIds.length > 0) return false;
    if (window._draggingTagNode) return false;
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    return Array.from(e.dataTransfer.types).includes('Files');
  };

  window.addEventListener('dragenter', (e) => {
    if (!isExternalFileDrag(e)) {
      dragCounter = 0;
      if (elements.dragDropOverlay) elements.dragDropOverlay.style.display = 'none';
      return;
    }
    e.preventDefault();
    dragCounter++;
    elements.dragDropOverlay.style.display = 'flex';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      elements.dragDropOverlay.style.display = 'none';
      dragCounter = 0;
    }
  });

  window.addEventListener('dragover', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    dragCounter = 0;
    elements.dragDropOverlay.style.display = 'none';

    if (
      e.dataTransfer &&
      typeof window.extractDroppedFilesWithPaths === 'function' &&
      typeof window.handleExternalFilesOrFoldersToLoome === 'function'
    ) {
      const { items } = await window.extractDroppedFilesWithPaths(e.dataTransfer);
      await window.handleExternalFilesOrFoldersToLoome(items);
      return;
    }

    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      await uploadPhotos(e.dataTransfer.files);
    }
  });

  // サムネイルサイズスライダー（rAFで1フレーム1回に統合して再計測）
  elements.thumbnailSizeSlider.addEventListener('input', (e) => {
    const size = e.target.value;
    document.documentElement.style.setProperty('--thumbnail-size', `${size}px`);
    localStorage.setItem('pm_thumbnail_size', size);
    _gridVirtualState.metricsDirty = true;
    _gridVirtualState.calibrated = false;
    if (!_gridSliderRafId) {
      _gridSliderRafId = requestAnimationFrame(() => {
        _gridSliderRafId = null;
        checkAndAppendGridChunksIfNeeded();
      });
    }
  });

  // 検索入力（デバウンス付き）
  let searchTimeout = null;
  elements.searchInput.addEventListener('input', (e) => {
    const val = e.target.value;
    elements.clearSearchBtn.style.display = val ? 'block' : 'none';
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.searchQuery = val;
      fetchPhotos();
    }, 250);
  });

  elements.clearSearchBtn.addEventListener('click', () => {
    elements.searchInput.value = '';
    elements.clearSearchBtn.style.display = 'none';
    state.searchQuery = '';
    fetchPhotos();
  });

  // 表示対象（スコープ）変更
  if (elements.headerScopeSelect) {
    elements.headerScopeSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (typeof e.target.blur === 'function') e.target.blur();
      applyHeaderScopeFilter(val);
    });
  }

  // ソート順変更
  elements.sortBySelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    updateHeaderSelectTooltip(e.target);
    if (typeof e.target.blur === 'function') e.target.blur();
    localStorage.setItem('pm_sort_by', state.sortBy);
    fetchPhotos();
  });

  // フッター/ヘッダーの4つのドロップダウンにホバー/フォーカス/変更時の動的ツールチップを設定
  ['headerScopeSelect', 'headerAttrSelect', 'sortBySelect', 'viewModeSelect'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.addEventListener('mouseenter', () => updateHeaderSelectTooltip(sel));
    sel.addEventListener('focus', () => updateHeaderSelectTooltip(sel));
    sel.addEventListener('change', () => updateHeaderSelectTooltip(sel));
  });
  syncHeaderSelectTooltips();

  // 評価フィルタトグルボタン（ヘッダー ＆ クイックタブ両方を一括監視・双方向同期）
  document.querySelectorAll('.rating-filter-toggles .rating-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const rv = parseInt(btn.dataset.rating, 10);
      if (typeof btn.blur === 'function') btn.blur();
      toggleRatingFilter(rv);
      updateRatingFilterUI();
      fetchPhotos();
    });
  });

  // 属性フィルタピル（すべて / RAW / 調整済）＆ 詳細属性セレクト（jpeg / raw_pair / xmp）
  document.querySelectorAll('#attrFilterToggles .attr-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      setAttrFilter(btn.dataset.attr || 'all');
    });
  });

  const headerAttrSel = elements.headerAttrSelect || document.getElementById('headerAttrSelect');
  if (headerAttrSel) {
    headerAttrSel.addEventListener('change', (e) => {
      state.attrFilter = e.target.value || 'all';
      if (typeof e.target.blur === 'function') e.target.blur();
      syncAttrFilterButtons();
      fetchPhotos();
    });
  }

  const attrSubSelect = elements.attrSubFilterSelect || document.getElementById('attrSubFilterSelect');
  if (attrSubSelect) {
    attrSubSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (typeof e.target.blur === 'function') e.target.blur();
      setAttrFilter(val || 'all');
    });
  }

  if (elements.onlineOnlyNavItem) {
    elements.onlineOnlyNavItem.addEventListener('click', (e) => {
      if (e.target.closest('.conn-toggle-hit')) {
        e.stopPropagation();
        toggleConnectionStateItem('online');
      } else {
        setConnectionFilter('online');
      }
    });
  }
  if (elements.offlineOnlyNavItem) {
    elements.offlineOnlyNavItem.addEventListener('click', (e) => {
      if (e.target.closest('.conn-toggle-hit')) {
        e.stopPropagation();
        toggleConnectionStateItem('offline');
      } else {
        setConnectionFilter('offline');
      }
    });
  }
  if (elements.unlinkedOnlyNavItem) {
    elements.unlinkedOnlyNavItem.addEventListener('click', (e) => {
      if (e.target.closest('.conn-toggle-hit')) {
        e.stopPropagation();
        toggleConnectionStateItem('unlinked');
      } else {
        setConnectionFilter('unlinked');
      }
    });
  }
  if (elements.folderTreeUnlinkedItem) {
    elements.folderTreeUnlinkedItem.addEventListener('click', (e) => {
      if (e.target.closest('#folderTreePurgeUnlinkedInlineBtn')) return;
      setConnectionFilter('unlinked');
    });
    elements.folderTreeUnlinkedItem.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await purgeUnlinkedPhotosAction(null, { purgeAllDirect: true });
    });
  }
  const purgeInlineBtn = document.getElementById('folderTreePurgeUnlinkedInlineBtn');
  if (purgeInlineBtn) {
    purgeInlineBtn.addEventListener('mouseenter', () => {
      purgeInlineBtn.style.color = 'var(--danger, #ef4444)';
      purgeInlineBtn.style.background = 'rgba(239, 68, 68, 0.14)';
      purgeInlineBtn.style.opacity = '1';
    });
    purgeInlineBtn.addEventListener('mouseleave', () => {
      purgeInlineBtn.style.color = 'var(--text-muted)';
      purgeInlineBtn.style.background = 'transparent';
      purgeInlineBtn.style.opacity = '0.8';
    });
    purgeInlineBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await purgeUnlinkedPhotosAction(null, { purgeAllDirect: true });
    });
  }
  if (elements.duplicatesOnlyNavItem) {
    elements.duplicatesOnlyNavItem.addEventListener('click', () => setConnectionFilter('duplicates'));
  }

  // リンク消失写真の完全消去ボタン（選択枚数連動・リンク情報なし画面限定）
  if (elements.purgeUnlinkedBtn) {
    elements.purgeUnlinkedBtn.addEventListener('click', async () => {
      await purgeUnlinkedPhotosAction(null);
    });
  }

  // サイドバーのクイックアクセス（すべての写真）
  document.querySelectorAll('.sidebar [data-filter-type="all"]').forEach(el => {
    el.addEventListener('click', () => {
      state.connectionStates = new Set(['online', 'offline', 'unlinked']);
      state.connectionFilter = 'all';
      state.onlineOnly = false;
      updateConnectionFilterUI();
      setFilter('all', null, 'すべての写真');
    });
  });

  // 空状態のアクションボタン（左サイドバーのフォルダ一覧タブを開く）
  if (elements.emptyStateActionBtn) {
    elements.emptyStateActionBtn.addEventListener('click', () => {
      if (window.openSidebarSection) window.openSidebarSection('folder');
    });
  }

  // --- フォルダ専用コンテキストメニューのイベント登録 ---
  // 消失フォルダのリンク削除（コンテキストメニューヘッダー横 ＆ 警告バナー ＆ インライン✕ボタン共通処理）
  const promptAndUnlinkMissingFolder = async (folderPath, folderName, volumeSerial) => {
    if (!folderPath) return;
    const confirmed = typeof showConfirmModal === 'function'
      ? await showConfirmModal({
          title: '消失フォルダのリンク削除',
          subtitle: '実体フォルダが見つからない写真のリンク整理',
          icon: 'unlink',
          targetName: folderName || folderPath,
          headingSuffix: 'の写真リンクを削除しますか？',
          subPath: folderPath,
          descriptionLines: [
            'このフォルダ（および配下）へのパス紐付け（リンク）を解除します。',
            '※ 他メディアにリンクがある写真はそちらのリンクが維持され、リンクが0本になる写真は「リンク消失の写真」へ移行します。',
            '※ 写真のサムネイル・タグ・評価は消去されずそのまま保持されます。',
          ],
          confirmText: 'リンクを削除する',
          confirmVariant: 'primary',
        })
      : confirm(`消失フォルダ「${folderName || folderPath}」の写真リンクを削除しますか？（サムネイル・タグ・評価は保持されます）`);
    if (!confirmed) return;

    try {
      const res = await fetch('/api/folders/unlink-missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder_path: folderPath,
          recursive: true,
          volume_serial: volumeSerial || null,
        }),
      });
      if (!res.ok) throw new Error(`リンク削除に失敗しました (HTTP ${res.status})`);
      const data = await res.json();
      showToast(`${data.unlinked || 0}枚の写真リンクを削除しました（サムネイル・タグは保持）`, 'success');
      if (state.currentFilter && state.currentFilter.type === 'folder' && state.currentFilter.value && state.currentFilter.value.toLowerCase() === String(folderPath).toLowerCase()) {
        setFilter('all', null, 'すべての写真');
      }
      if (typeof refreshAll === 'function') {
        await refreshAll();
      } else {
        await Promise.all([fetchPhotos(), refreshFolderTree()]);
      }
    } catch (err) {
      showToast(`リンク削除エラー: ${err.message}`, 'error');
    }
  };
  window.promptAndCleanupMissingFolder = promptAndUnlinkMissingFolder;

  const headerUnlinkBtn = elements.folderContextHeaderUnlinkBtn || document.getElementById('folderContextHeaderUnlinkBtn');
  if (headerUnlinkBtn) {
    headerUnlinkBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      await promptAndUnlinkMissingFolder(node.fullPath, node.name, node.volumeSerial || null);
    });
  }

  const bannerUnlinkBtn = elements.warningBannerUnlinkBtn || document.getElementById('warningBannerUnlinkBtn');
  if (bannerUnlinkBtn) {
    bannerUnlinkBtn.addEventListener('click', async () => {
      if (state.currentFilter.type !== 'folder' || !state.currentFilter.value) return;
      const folderPath = state.currentFilter.value;
      const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
      await promptAndUnlinkMissingFolder(folderPath, folderName, state.currentFilter.volumeSerial || null);
    });
  }

  const bannerUnmanageVolBtn = document.getElementById('warningBannerUnmanageVolumeBtn');
  if (bannerUnmanageVolBtn) {
    bannerUnmanageVolBtn.addEventListener('click', async () => {
      const cf = state.currentFilter || {};
      if (cf.type !== 'folder') return;
      if (cf.volumeSerial && typeof window.promptAndRemoveManagedVolume === 'function') {
        const displayHint = cf.titleText || cf.value || '';
        const countHint = Array.isArray(state.photos) ? state.photos.length : null;
        await window.promptAndRemoveManagedVolume(cf.volumeSerial, displayHint, countHint);
        return;
      }
      if (cf.value) {
        const folderPath = cf.value;
        const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
        const count = Array.isArray(state.photos) ? state.photos.length : 0;
        const confirmed = typeof showConfirmModal === 'function'
          ? await showConfirmModal({
              title: '未接続フォルダの管理解除',
              subtitle: 'ライブラリからの登録解除',
              icon: 'trash',
              headingPrefix: 'フォルダ',
              targetName: folderName,
              headingSuffix: `（写真 ${count.toLocaleString()} 枚）を管理から外しますか？`,
              subPath: folderPath,
              descriptionLines: [
                'ライブラリ上の登録（サムネイル・タグ情報）が解除されます。',
                '※ PC上の実ファイル本体は一切削除されません。',
              ],
              confirmText: '管理から外す',
              confirmVariant: 'danger',
            })
          : confirm(`フォルダ「${folderName}」をライブラリから外しますか？`);
        if (!confirmed) return;
        try {
          const res = await fetch('/api/folders', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              folder_path: folderPath,
              recursive: true,
              volume_serial: cf.volumeSerial || null,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || '管理解除に失敗しました');
          showToast(`「${folderName}」を管理から外しました (${data.deleted_count}枚解除)`, 'info');
          setFilter('all', null, 'すべての写真');
          await refreshAll();
          if (typeof fetchManagedVolumes === 'function') await fetchManagedVolumes();
        } catch (err) {
          showToast(`エラー: ${err.message}`, 'error');
        }
      }
    });
  }

  // 1. 再スキャン（直下のみ＋直下の消失写真リンク整理）
  if (elements.folderMenuRescanDirect) {
    elements.folderMenuRescanDirect.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing || node.isOffline) {
        showToast('実フォルダが存在しないか、ドライブが未接続のため再スキャンできません', 'warning');
        return;
      }
      showToast(`「${node.name}」を再スキャン中...`, 'info');
      await executeScan(node.fullPath, false, true, node.volumeSerial || null);
    });
  }

  // 2. 再スキャン（子を含む）（配下再帰スキャン＋消失写真リンク整理・時間警告付き）
  if (elements.folderMenuRescanRecursive) {
    elements.folderMenuRescanRecursive.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing || node.isOffline) {
        showToast('実フォルダが存在しないか、ドライブが未接続のため再スキャンできません', 'warning');
        return;
      }
      const isDriveRoot = /^[a-zA-Z]:\\?$/.test(node.fullPath);
      const confirmed = typeof showConfirmModal === 'function'
        ? await showConfirmModal({
            title: isDriveRoot ? 'ドライブ全体のスキャン確認' : '再スキャン（子を含む）の確認',
            subtitle: 'サブフォルダを含む再帰スキャンとリンク整理',
            icon: 'folder-refresh',
            targetName: node.name,
            headingSuffix: isDriveRoot
              ? 'はドライブ全体です。子フォルダも含めてスキャンしますか？'
              : 'を子フォルダも含めて再スキャンしますか？',
            subPath: node.fullPath,
            descriptionLines: [
              '配下のすべてのサブフォルダを走査するため、フォルダ数や写真枚数によっては時間がかかる場合があります。',
              '※ 移動・削除された写真のリンクは解除され、他メディアにリンクが無い写真は「リンク消失の写真」へ移行します（サムネイル・タグ・評価は保持）。',
            ],
            confirmText: '再スキャン開始',
            confirmVariant: 'primary',
          })
        : confirm(`「${node.name}」を子フォルダも含めて再スキャンしますか？\n（フォルダ数によっては時間がかかる場合があります）`);
      if (!confirmed) return;

      showToast(`「${node.name}」配下を再スキャン中...`, 'info');
      await executeScan(node.fullPath, true, true, node.volumeSerial || null);
    });
  }

  // 2-C. 🤖 AIタグ付け
  if (elements.folderMenuAiTag) {
    elements.folderMenuAiTag.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      const confirmed = typeof showConfirmModal === 'function'
        ? await showConfirmModal({
            title: 'AI自動タグ付け',
            subtitle: 'ローカルAI（CLIP Vision）による被写体・シーン認識',
            icon: 'ai',
            targetName: node.name,
            headingSuffix: '配下の写真にAIタグを付与しますか？',
            subPath: node.fullPath,
            descriptionLines: [
              '※ すでにタグ付け済みの写真はスキップされます。',
              '※ すべての推論処理はPC内部（オフライン）で完結します。',
            ],
            confirmText: 'AIタグ付けを開始',
            confirmVariant: 'primary',
          })
        : confirm(`フォルダ「${node.name}」配下の写真にAIタグを付与しますか？\n（※すでにタグ付け済みの写真はスキップされます）`);
      if (!confirmed) return;

      try {
        showToast(`「${node.name}」のAIタグ付けを開始しました...`, 'info');
        const res = await fetch('/api/ai/tag-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath, recursive: true }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || 'AIタグ付けの開始に失敗しました');
        }
        if (typeof window.startAiProgressPolling === 'function') {
          window.startAiProgressPolling();
        } else if (typeof startAiProgressPolling === 'function') {
          startAiProgressPolling();
        }
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 2-C-2. 🎨 AIカラータグのみ再判定
  if (elements.folderMenuAiColorTag) {
    elements.folderMenuAiColorTag.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      const confirmed = typeof showConfirmModal === 'function'
        ? await showConfirmModal({
            title: 'AIカラータグの再判定',
            subtitle: '12色カラーパレットの再解析',
            icon: 'palette',
            targetName: node.name,
            headingSuffix: '配下の写真に対してAIカラータグ（12色）を再判定しますか？',
            subPath: node.fullPath,
            descriptionLines: [
              '※ 手動タグおよびAI被写体タグは保護されます。',
            ],
            confirmText: 'カラー再判定を開始',
            confirmVariant: 'primary',
          })
        : confirm(`フォルダ「${node.name}」配下の写真に対して、AIカラータグ（12色）のみを再判定しますか？\n（※手動タグおよびAI被写体タグは保護されます）`);
      if (!confirmed) return;

      try {
        showToast(`「${node.name}」のAIカラータグ再判定を開始しました...`, 'info');
        const res = await fetch('/api/ai/tag-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_path: node.fullPath,
            force_retag: true,
            color_only: true,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || 'AIカラータグ再判定の開始に失敗しました');
        }
        if (typeof window.startAiProgressPolling === 'function') {
          window.startAiProgressPolling();
        } else if (typeof startAiProgressPolling === 'function') {
          startAiProgressPolling();
        }
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 3. 管理から外す（DB解除）※未接続フォルダ・登録メディアでも解除可能
  if (elements.folderMenuUnmanage) {
    elements.folderMenuUnmanage.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      const isRootKind = (node.kind === 'drive' || node.kind === 'shortcut' || node.kind === 'offline');
      const count = node.totalCount > 0 ? node.totalCount : node.count;

      // 登録メディア行やドライブ/未接続メディア自体の解除時は volumes テーブルも含め一括解除
      if ((node.isMediaItem || node.kind === 'offline' || node.kind === 'drive') && node.volumeSerial && typeof window.promptAndRemoveManagedVolume === 'function') {
        const displayHint = node.customName || node.volumeLabel || node.name || '';
        await window.promptAndRemoveManagedVolume(node.volumeSerial, displayHint, Number(count || 0));
        return;
      }

      const kindLabel = isRootKind ? 'ドライブ' : 'フォルダ';
      const confirmed = typeof showConfirmModal === 'function'
        ? await showConfirmModal({
            title: `${kindLabel}の管理解除`,
            subtitle: 'ライブラリからの登録解除',
            icon: 'folder',
            headingPrefix: kindLabel,
            targetName: node.name,
            headingSuffix: `（写真 ${(count || 0).toLocaleString()} 枚）をライブラリから外しますか？`,
            subPath: node.fullPath,
            descriptionLines: [
              'ライブラリ上の登録（サムネイル・タグ情報）が解除されます。',
              '※ PC上の実ファイル本体は一切削除されません。',
            ],
            confirmText: '管理から外す',
            confirmVariant: 'danger',
          })
        : confirm(`${kindLabel}「${node.name}」（写真 ${count}枚）をライブラリから除外しますか？\n\n（※PC上の実ファイル本体は削除されません）`);
      if (!confirmed) return;

      try {
        const res = await fetch('/api/folders', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_path: node.fullPath,
            recursive: true,
            volume_serial: node.volumeSerial || null,
            serial_mode: node.serialMode || 'any',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '除外に失敗しました');

        showToast(`「${node.name}」を管理から外しました (${data.deleted_count}枚解除)`, 'info');
        await refreshAll();
        if (typeof fetchManagedVolumes === 'function') {
          await fetchManagedVolumes();
        }
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 4. 管理対象外（除外設定）
  const handleIgnoreFolder = async () => {
    const node = _activeFolderNode;
    closeFolderContextMenu();
    if (!node) return;

    const confirmed = typeof showConfirmModal === 'function'
      ? await showConfirmModal({
          title: '管理対象外（除外）に設定',
          subtitle: '自動スキャン対象からの除外',
          icon: 'folder',
          targetName: node.name,
          headingSuffix: 'を管理対象外（除外）に設定しますか？',
          subPath: node.fullPath,
          descriptionLines: [
            '・ライブラリから登録解除されます',
            '・今後、親フォルダを再スキャンしても自動登録されなくなります',
            '※ PC上の実ファイル本体は一切削除されません。',
          ],
          confirmText: '除外に設定する',
          confirmVariant: 'danger',
        })
      : confirm(`フォルダ「${node.name}」を管理対象外（除外）に設定しますか？\n\n・ライブラリから登録解除されます\n・今後、親フォルダを再スキャンしても自動登録されなくなります\n（※PC上の実ファイル本体は削除されません）`);
    if (!confirmed) return;

    try {
      const res = await fetch('/api/folders/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: node.fullPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '除外設定に失敗しました');

      showToast(`「${node.name}」を管理対象外に設定しました`, 'info');
      await refreshAll();
    } catch (err) {
      showToast(`エラー: ${err.message}`, 'error');
    }
  };
  if (elements.folderMenuIgnoreFromManaged) {
    elements.folderMenuIgnoreFromManaged.addEventListener('click', handleIgnoreFolder);
  }
  if (elements.folderMenuIgnoreFromUnmanaged) {
    elements.folderMenuIgnoreFromUnmanaged.addEventListener('click', handleIgnoreFolder);
  }

  // 5. 除外を解除（未管理に戻す）
  if (elements.folderMenuUnignore) {
    elements.folderMenuUnignore.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      try {
        const res = await fetch('/api/folders/ignore', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '除外解除に失敗しました');

        showToast(`「${node.name}」の除外を解除しました`, 'success');
        await refreshAll();
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 6. 管理に追加してスキャン
  const handleAddAndScan = async () => {
    const node = _activeFolderNode;
    closeFolderContextMenu();
    if (!node) return;
    if (node.isMissing) {
      showToast('実フォルダが存在しないか、ドライブが未接続のためスキャンできません', 'warning');
      return;
    }

    let isRecursive = false;
    if (node.hasChildren && typeof showRegisterFolderModal === 'function') {
      let directDiskCount = 0;
      try {
        const diffRes = await fetch('/api/folders/check-diff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath, volume_serial: node.volumeSerial || null }),
        });
        if (diffRes.ok) {
          const diffData = await diffRes.json();
          directDiskCount = diffData.total_disk || 0;
        }
      } catch (_e) {}
      const choice = await showRegisterFolderModal(node.fullPath, node.name, directDiskCount);
      if (!choice) return;
      isRecursive = (choice === 'recursive');
    }

    const rangeText = isRecursive ? '（子フォルダ含む）' : '（直下のみ）';
    showToast(`「${node.name}」を管理に追加・スキャン中${rangeText}...`, 'info');
    await executeScan(node.fullPath, isRecursive, false);
  };
  if (elements.folderMenuAddAndScan) {
    elements.folderMenuAddAndScan.addEventListener('click', handleAddAndScan);
  }
  if (elements.folderMenuAddFromIgnored) {
    elements.folderMenuAddFromIgnored.addEventListener('click', handleAddAndScan);
  }

  // 6-B. メディアの識別名（ニックネーム）を設定
  if (elements.folderMenuRenameVolume) {
    elements.folderMenuRenameVolume.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node || !node.volumeSerial) return;
      if (typeof window.promptRenameVolume === 'function') {
        await window.promptRenameVolume(node.volumeSerial, node.customName || '', node.volumeLabel || '', node.letter || '');
      }
    });
  }

  // 7. エクスプローラーで開く
  if (elements.folderMenuOpenExplorer) {
    elements.folderMenuOpenExplorer.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing) {
        showToast('実フォルダが存在しないか、ドライブが未接続のためエクスプローラーで開けません', 'warning');
        return;
      }

      try {
        const res = await fetch('/api/folders/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || 'フォルダを開けませんでした');
        }
        if (typeof window.markExternalFolderOpened === 'function') {
          window.markExternalFolderOpened(node.fullPath);
        }
        showToast('フォルダを開きました', 'info', 2000);
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 8. メインエリア警告バナーの再確認ボタン
  if (elements.warningBannerReloadBtn) {
    elements.warningBannerReloadBtn.addEventListener('click', async () => {
      showToast('ドライブ・フォルダの接続状態を確認中...', 'info');
      try {
        await fetchFolders();
        if (state.currentFilter.type === 'folder') {
          await fetchPhotos();
          if (state.currentFilter.value && !state.currentFilter.isOffline) {
            _dismissedFolderDiffSignatures.clear();
            const folderName = state.currentFilter.value.split(/[\\/]/).filter(Boolean).pop() || state.currentFilter.value;
            checkAndPromptFolderRefresh(state.currentFilter.value, folderName, {
              volumeSerial: state.currentFilter.volumeSerial || null,
              isOffline: false,
            });
          }
        }
        showToast('接続状態を更新しました', 'success');
      } catch (err) {
        showToast(`更新エラー: ${err.message}`, 'error');
      }
    });
  }

  // キーボードショートカット (Picasa & Tiat流)
  window.addEventListener('keydown', (e) => {
    // モーダルや入力欄にフォーカスがある場合は無効
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    // ヘルプモーダル表示中
    if (elements.helpModal && elements.helpModal.style.display !== 'none') {
      if (e.key === 'Escape') {
        closeHelpModal();
      } else if (e.key === '?' || e.key === 'F1') {
        e.preventDefault();
        toggleHelpModal();
      }
      return;
    }

    // 終了モーダル表示中
    if (elements.shutdownModal && elements.shutdownModal.style.display !== 'none') {
      if (e.key === 'Escape') {
        closeShutdownModal();
      }
      return;
    }

    // スマホ連携モーダル表示中
    if (elements.mobileConnectModal && elements.mobileConnectModal.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeMobileModal === 'function') {
        closeMobileModal();
      }
      return;
    }

    // スマホ選別取り込み完了通知モーダル表示中
    const syncResultModalEl = document.getElementById('mobileSyncResultModal');
    if (syncResultModalEl && syncResultModalEl.style.display !== 'none') {
      if ((e.key === 'Escape' || e.key === 'Enter') && typeof closeMobileSyncResultModal === 'function') {
        closeMobileSyncResultModal();
      }
      return;
    }

    // DBメンテナンスモーダル表示中
    if (elements.dbMaintenanceModal && elements.dbMaintenanceModal.style.display !== 'none') {
      if (e.key === 'Escape') {
        elements.dbMaintenanceModal.style.display = 'none';
      }
      return;
    }

    // スマートテイクアウト / Art Framer モーダル表示中
    const smartTakeoutEl = document.getElementById('smartTakeoutModal');
    if (smartTakeoutEl && smartTakeoutEl.style.display !== 'none') {
      return;
    }
    const artFramerEl = document.getElementById('artFramerModal');
    if (artFramerEl && artFramerEl.style.display !== 'none') {
      return;
    }

    // メディア識別名＆ボリュームラベル設定モーダル表示中
    const volIdModalEl = document.getElementById('volumeIdentityModal');
    if (volIdModalEl && volIdModalEl.style.display !== 'none') {
      return;
    }

    // 登録メディア（SDカード・ドライブ）管理一覧モーダル表示中
    const managedMediaModalEl = document.getElementById('managedMediaModal');
    if (managedMediaModalEl && managedMediaModalEl.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeManagedMediaModal === 'function') {
        closeManagedMediaModal();
      }
      return;
    }

    // 撮影日時一括シフトモーダル表示中
    const dateShiftModalEl = elements.dateShiftModal || document.getElementById('dateShiftModal');
    if (dateShiftModalEl && dateShiftModalEl.style.display !== 'none') {
      if (e.key === 'Escape' && typeof window.closeDateShiftModal === 'function') {
        window.closeDateShiftModal();
      }
      return;
    }

    // タグ完全削除確認モーダル表示中
    if (elements.deleteTagModal && elements.deleteTagModal.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeDeleteTagModal === 'function') {
        closeDeleteTagModal(false);
      }
      return;
    }

    // フォルダ管理登録確認モーダル表示中 (v2.02)
    if (elements.registerFolderModal && elements.registerFolderModal.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeRegisterFolderModal === 'function') {
        closeRegisterFolderModal(null);
      }
      return;
    }

    // 汎用確認モーダル表示中
    if (elements.commonConfirmModal && elements.commonConfirmModal.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeConfirmModal === 'function') {
        closeConfirmModal(false);
      }
      return;
    }

    // その他の専用モーダル（拡大カレンダー・画像調整・スライドショー・2枚比較・ラボカルテ・地図・重複・ベタ焼き・ストレージ操作等）が表示中はグリッド/ライトボックスのショートカットを無効化
    const otherBlockingModalIds = [
      'securityLockOverlay',
      'foreignLoomeModal',
      'calendarModal',
      'imageAdjustModal',
      'slideshowModal',
      'compareModal',
      'labKarteModal',
      'locationMapModal',
      'contactSheetModal',
      'duplicatesModal',
      'storageRenameModal',
      'storageFolderModal',
      'gpsCandidateModal',
    ];
    for (const modalId of otherBlockingModalIds) {
      const mEl = document.getElementById(modalId);
      if (mEl && mEl.style.display && mEl.style.display !== 'none') {
        return;
      }
    }

    // ? または F1 キーでヘルプモーダル開閉
    if (e.key === '?' || e.key === 'F1') {
      e.preventDefault();
      toggleHelpModal();
      return;
    }

    // [ キー または b / B キー で左サイドバー開閉
    if ((e.key === '[' || e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.altKey && !e.metaKey && state.currentPhotoIndex === -1) {
      toggleSidebar();
      return;
    }
    // Ctrl+B でも左サイドバー開閉
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B') && state.currentPhotoIndex === -1) {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    // d キーで右インスペクタ開閉
    if ((e.key === 'd' || e.key === 'D') && state.currentPhotoIndex === -1) {
      toggleInspector();
      return;
    }

    // Ctrl+A で全選択
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      if (state.currentPhotoIndex === -1) {
        e.preventDefault();
        selectAllPhotos();
        return;
      }
    }

    // Esc でコンテキストメニュー・ドロワーまたは選択解除 (プレビュー外)
    if (e.key === 'Escape' && state.currentPhotoIndex === -1) {
      if (elements.contextMenu && elements.contextMenu.style.display !== 'none' && typeof closeContextMenu === 'function') {
        closeContextMenu();
        return;
      }
      if (typeof isFilterDrawerOpen === 'function' && isFilterDrawerOpen()) {
        closeFilterDrawer();
        return;
      }
      if (state.selectedPhotoIds.size > 0) {
        clearSelection();
        return;
      }
    }

    // Shiftキー押下時にホバー中カードがあれば即座に範囲プレビューを表示
    if (e.key === 'Shift' && state.currentPhotoIndex === -1) {
      if (currentHoveredCardIndex !== -1 && state.lastSelectedIndex !== -1 && state.selectedPhotoIds.size > 0) {
        updateShiftPreview(currentHoveredCardIndex);
      }
    }

    // トーン調整のコピー (Ctrl+Shift+C) / ペースト (Ctrl+Shift+V) / 画像クリップボードコピー (Ctrl+C)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        let targetPhoto = null;
        if (state.currentPhotoIndex >= 0) {
          targetPhoto = getCurrentLightboxPhoto();
        } else if (state.selectedPhotoIds.size > 0) {
          const firstId = Array.from(state.selectedPhotoIds)[0];
          targetPhoto = typeof getPhotoById === 'function' ? getPhotoById(firstId) : state.photos.find(p => p.id === firstId);
        } else if (state.activeInspectorPhotoId) {
          targetPhoto = typeof getPhotoById === 'function' ? getPhotoById(state.activeInspectorPhotoId) : state.photos.find(p => p.id === state.activeInspectorPhotoId);
        }
        if (targetPhoto && typeof window.copyPhotoToneAdjustments === 'function') {
          window.copyPhotoToneAdjustments(targetPhoto);
        }
        return;
      }
      if (e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        let targetIds = [];
        if (state.currentPhotoIndex >= 0) {
          const cur = getCurrentLightboxPhoto();
          if (cur) targetIds = [cur.id];
        } else if (state.selectedPhotoIds.size > 0) {
          targetIds = Array.from(state.selectedPhotoIds);
        } else if (state.activeInspectorPhotoId) {
          targetIds = [state.activeInspectorPhotoId];
        }
        if (targetIds.length > 0 && typeof window.batchPastePhotoToneAdjustments === 'function') {
          window.batchPastePhotoToneAdjustments(targetIds);
        }
        return;
      }
      if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        // テキスト選択中であればブラウザ標準のテキストコピーを優先
        const selText = window.getSelection ? window.getSelection().toString().trim() : '';
        if (!selText) {
          let targetPhoto = null;
          if (state.currentPhotoIndex >= 0) {
            targetPhoto = getCurrentLightboxPhoto();
          } else if (state.selectedPhotoIds.size > 0) {
            const firstId = Array.from(state.selectedPhotoIds)[0];
            targetPhoto = typeof getPhotoById === 'function' ? getPhotoById(firstId) : state.photos.find(p => p.id === firstId);
          } else if (state.activeInspectorPhotoId) {
            targetPhoto = typeof getPhotoById === 'function' ? getPhotoById(state.activeInspectorPhotoId) : state.photos.find(p => p.id === state.activeInspectorPhotoId);
          }
          if (targetPhoto && typeof window.copyPhotoImageToClipboard === 'function') {
            e.preventDefault();
            window.copyPhotoImageToClipboard(targetPhoto);
            return;
          }
        }
      }
    }

    // ライトボックス表示中のショートカット
    if (state.currentPhotoIndex >= 0) {
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        state._lightboxSkipFadeOnce = Boolean(e.repeat);
        navigatePhoto(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        state._lightboxSkipFadeOnce = Boolean(e.repeat);
        navigatePhoto(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateStackByVerticalKey('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateStackByVerticalKey('down');
      } else if (e.key === '1') {
        // 1キーで優 (rating = 2)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, 2);
        }
      } else if (e.key === '2') {
        // 2キーで良 (rating = 1)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, 1);
        }
      } else if (e.key === '3') {
        // 3キーで棄 (rating = -1)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, -1);
        }
      } else if (e.key === '0' || e.key === '4') {
        // 0 または 4キーでキャンセル (可: rating = 0)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, 0);
        }
      } else if (e.key === 'x' || e.key === 'X') {
        // Xキーで棄 (トグル)
        const current = getCurrentLightboxPhoto();
        if (current) {
          const newRating = current.rating === -1 ? 0 : -1;
          updatePhotoRating(current.id, newRating);
        }
      } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Rキーで時計回りに90度回転
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(current.id, 90);
        }
      } else if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Lキーで反時計回りに90度回転
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(current.id, -90);
        }
      } else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Cキーでクロップ・画像調整モーダルを開く
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.openImageAdjustModal === 'function') {
          window.openImageAdjustModal(current);
        }
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        closeLightbox();
      }
    } else {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        navigateGridByArrow(e.key, e.shiftKey);
      } else if (e.key === ' ' || e.key === 'Enter') {
        // 選択中の写真（または最初の写真）をライトボックスで開く
        if (state.photos.length > 0) {
          e.preventDefault();
          let targetIdx = state.lastSelectedIndex;
          if (targetIdx < 0 || targetIdx >= state.photos.length) {
            if (state.selectedPhotoIds.size > 0) {
              const firstId = Array.from(state.selectedPhotoIds)[0];
              targetIdx = state.photos.findIndex(p => p.id === firstId);
            }
          }
          if (targetIdx < 0 || targetIdx >= state.photos.length) {
            targetIdx = 0;
          }
          openLightbox(targetIdx);
        }
      } else if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // i キーで情報表示ON/OFFトグル
        toggleMinimalView();
      } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Rキーで選択写真を時計回りに90度回転
        e.preventDefault();
        const ids = Array.from(state.selectedPhotoIds);
        if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
          window.batchRotatePhotosQuick(ids, 90);
        } else if (state.activeInspectorPhotoId && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(state.activeInspectorPhotoId, 90);
        }
      } else if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Lキーで選択写真を反時計回りに90度回転
        e.preventDefault();
        const ids = Array.from(state.selectedPhotoIds);
        if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
          window.batchRotatePhotosQuick(ids, -90);
        } else if (state.activeInspectorPhotoId && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(state.activeInspectorPhotoId, -90);
        }
      } else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Cキーで選択写真（またはアクティブ写真）のクロップ・画像調整モーダルを開く
        e.preventDefault();
        let targetPhoto = null;
        if (state.selectedPhotoIds.size > 0) {
          const firstId = Array.from(state.selectedPhotoIds)[0];
          targetPhoto = typeof getPhotoById === 'function' ? getPhotoById(firstId) : state.photos.find(p => p.id === firstId);
        } else if (state.activeInspectorPhotoId) {
          targetPhoto = typeof getPhotoById === 'function' ? getPhotoById(state.activeInspectorPhotoId) : state.photos.find(p => p.id === state.activeInspectorPhotoId);
        }
        if (targetPhoto && typeof window.openImageAdjustModal === 'function') {
          window.openImageAdjustModal(targetPhoto);
        }
      } else if (e.key === '1') {
        // 選択写真に優
        applyRatingToSelection(2);
      } else if (e.key === '2') {
        // 選択写真に良
        applyRatingToSelection(1);
      } else if (e.key === '3') {
        // 選択写真に棄
        applyRatingToSelection(-1);
      } else if (e.key === '0' || e.key === '4') {
        // 選択写真の評価取消 (可)
        applyRatingToSelection(0);
      } else if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (typeof isStrictlyUnlinkedOnlyView === 'function' && isStrictlyUnlinkedOnlyView() && state.selectedPhotoIds.size > 0) {
          e.preventDefault();
          purgeUnlinkedPhotosAction(Array.from(state.selectedPhotoIds));
        }
      } else if (e.key === 'x' || e.key === 'X') {
        // 選択写真に棄
        applyRatingToSelection(-1);
      }
    }
  });

  // Shiftキーを離した際に範囲プレビューを解除し、ベース選択を確定
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      clearShiftPreview();
      state.selectionBaseIds = null;
    }
  });

  window.addEventListener('blur', () => {
    clearShiftPreview();
    state.selectionBaseIds = null;
  });

  // 写真グリッドへのイベント委譲を一括初期化（個別リスナー生成を排除）
  setupPhotoGridDelegation();
}

let _zoomBadgeTimer = null;

/**
 * ズーム倍率バッジの表示

 */
/**
 * 一覧グリッド表示中の矢印キー移動（← → ↑ ↓ ＆ Shift範囲選択）
 * 通常グリッド・びっしり（Justified）・スライドマウントのすべてで実座標から上下行を判定する。
 */
function navigateGridByArrow(key, isShift = false) {
  const total = state.photos.length;
  if (total === 0 || !elements.photoGrid) return;

  // 現在の基準インデックスを特定
  let curIdx = state.lastSelectedIndex;
  if (curIdx < 0 || curIdx >= total) {
    if (state.activeInspectorPhotoId) {
      curIdx = state.photos.findIndex(p => p.id === state.activeInspectorPhotoId);
    }
  }
  if (curIdx < 0 || curIdx >= total) {
    if (state.selectedPhotoIds.size > 0) {
      const firstId = Array.from(state.selectedPhotoIds)[0];
      curIdx = state.photos.findIndex(p => p.id === firstId);
    }
  }

  let targetIdx = 0;

  if (curIdx < 0) {
    // 未選択時は先頭カードを選択
    targetIdx = 0;
  } else if (key === 'ArrowRight') {
    targetIdx = Math.min(total - 1, curIdx + 1);
  } else if (key === 'ArrowLeft') {
    targetIdx = Math.max(0, curIdx - 1);
  } else if (key === 'ArrowDown' || key === 'ArrowUp') {
    // 基準カードと上下隣接行のカードがDOM上に描画されていることを保証
    if (_gridVirtualState.enabled) {
      const span = Math.max(24, (_gridVirtualState.cols || 4) * 3);
      ensureCardsRenderedUpTo(curIdx + 1);
      syncVirtualPhotoGrid({
        forceRemount: false,
        includeMinIdx: Math.max(0, curIdx - span),
        includeMaxIdx: Math.min(total - 1, curIdx + span),
      });
    } else if (key === 'ArrowDown') {
      ensureCardsRenderedUpTo(Math.min(total, curIdx + 40));
    } else {
      ensureCardsRenderedUpTo(curIdx + 1);
    }

    const curCard = elements.photoGrid.querySelector(`.photo-card[data-index="${curIdx}"]`);
    const curRect = curCard ? curCard.getBoundingClientRect() : null;

    if (curRect && (curRect.width > 0 || curRect.height > 0)) {
      const curCenterX = curRect.left + curRect.width / 2;
      const curCenterY = curRect.top + curRect.height / 2;
      const rowThreshold = Math.max(18, curRect.height * 0.45);

      let targetRowCenterY = null;
      let targetRowHeight = curRect.height;
      let bestIdx = curIdx;
      let bestDistX = Infinity;

      if (key === 'ArrowDown') {
        const searchEnd = _gridVirtualState.enabled ? _gridVirtualState.endIdx : renderedGridCount;
        for (let i = curIdx + 1; i < searchEnd; i++) {
          const c = elements.photoGrid.querySelector(`.photo-card[data-index="${i}"]`);
          if (!c) continue;
          const r = c.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          const cx = r.left + r.width / 2;

          if (targetRowCenterY === null) {
            if (cy - curCenterY > rowThreshold) {
              targetRowCenterY = cy;
              targetRowHeight = r.height || curRect.height;
              bestIdx = i;
              bestDistX = Math.abs(cx - curCenterX);
            }
          } else {
            if (Math.abs(cy - targetRowCenterY) <= Math.max(18, targetRowHeight * 0.45)) {
              const distX = Math.abs(cx - curCenterX);
              if (distX < bestDistX) {
                bestDistX = distX;
                bestIdx = i;
              }
            } else if (cy - targetRowCenterY > Math.max(18, targetRowHeight * 0.45)) {
              // さらに次の行に入ったので探索終了
              break;
            }
          }
        }
      } else {
        const searchStart = _gridVirtualState.enabled ? Math.max(0, _gridVirtualState.startIdx) : 0;
        for (let i = curIdx - 1; i >= searchStart; i--) {
          const c = elements.photoGrid.querySelector(`.photo-card[data-index="${i}"]`);
          if (!c) continue;
          const r = c.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          const cx = r.left + r.width / 2;

          if (targetRowCenterY === null) {
            if (curCenterY - cy > rowThreshold) {
              targetRowCenterY = cy;
              targetRowHeight = r.height || curRect.height;
              bestIdx = i;
              bestDistX = Math.abs(cx - curCenterX);
            }
          } else {
            if (Math.abs(cy - targetRowCenterY) <= Math.max(18, targetRowHeight * 0.45)) {
              const distX = Math.abs(cx - curCenterX);
              if (distX < bestDistX) {
                bestDistX = distX;
                bestIdx = i;
              }
            } else if (targetRowCenterY - cy > Math.max(18, targetRowHeight * 0.45)) {
              // さらに上の行に入ったので探索終了
              break;
            }
          }
        }
      }
      targetIdx = bestIdx;
    } else {
      // レイアウト座標が取得できない環境（テスト等）のフォールバック
      const fallbackCols = _gridVirtualState.enabled ? Math.max(1, _gridVirtualState.cols) : 4;
      targetIdx = key === 'ArrowDown'
        ? Math.min(total - 1, curIdx + fallbackCols)
        : Math.max(0, curIdx - fallbackCols);
    }
  }

  ensureCardsRenderedUpTo(targetIdx + 1);
  const targetPhoto = state.photos[targetIdx];
  if (!targetPhoto) return;

  if (isShift) {
    if (state.selectionAnchorIndex === undefined || state.selectionAnchorIndex < 0 || state.selectionAnchorIndex >= total) {
      state.selectionAnchorIndex = curIdx >= 0 ? curIdx : targetIdx;
    }
    const start = Math.min(state.selectionAnchorIndex, targetIdx);
    const end = Math.max(state.selectionAnchorIndex, targetIdx);
    state.selectedPhotoIds.clear();
    for (let i = start; i <= end; i++) {
      if (state.photos[i]) {
        state.selectedPhotoIds.add(state.photos[i].id);
      }
    }
    state.lastSelectedIndex = targetIdx;
    state.activeInspectorPhotoId = targetPhoto.id;
    clearShiftPreview();
    updateCardSelectionClasses();
    updateSelectionUI();
  } else {
    state.selectedPhotoIds.clear();
    state.selectedPhotoIds.add(targetPhoto.id);
    state.lastSelectedIndex = targetIdx;
    state.selectionAnchorIndex = targetIdx;
    state.selectionBaseIds = null;
    clearShiftPreview();
    state.activeInspectorPhotoId = targetPhoto.id;
    updateCardSelectionClasses();
    updateSelectionUI();
  }

  const targetCard = elements.photoGrid.querySelector(`.photo-card[data-index="${targetIdx}"]`);
  if (targetCard && typeof targetCard.scrollIntoView === 'function') {
    targetCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  _scheduleGridViewportSync(false, false);
}
window.navigateGridByArrow = navigateGridByArrow;

function setupPhotoGridDelegation() {
  if (!elements.photoGrid) return;

  // 0. グリッド余白（コンテナ背景）クリックで選択解除
  const gridContainer = elements.photoGrid.closest('.photo-grid-container');
  if (gridContainer) {
    gridContainer.addEventListener('click', (e) => {
      if (e.target.closest('.photo-card, #emptyState')) return;
      if (state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
        clearSelection();
      }
    });
  }

  // 1. クリックイベントの委譲
  elements.photoGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) {
      if (state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
        clearSelection();
      }
      return;
    }

    const photoId = parseInt(card.dataset.photoId, 10);
    const index = parseInt(card.dataset.index, 10);
    const photo = state.photos[index];
    if (!photo) return;

    // (A) スタックバッジ / フォーマットバッジクリック（インスペクタを開く）
    const badge = e.target.closest('.stack-badge, .format-badge');
    if (badge) {
      e.stopPropagation();
      state.selectedPhotoIds.clear();
      state.selectedPhotoIds.add(photo.id);
      state.lastSelectedIndex = index;
      state.selectionAnchorIndex = index;
      state.activeInspectorPhotoId = photo.id;
      updateCardSelectionClasses();
      updateSelectionUI();
      toggleInspector(true);
      showSingleInspector(photo);
      return;
    }

    // (B) チェックボックスクリック
    const checkbox = e.target.closest('.card-select-checkbox');
    if (checkbox) {
      e.stopPropagation();
      if (e.shiftKey) {
        rangeSelectPhotos(index);
      } else {
        togglePhotoSelection(photo.id, index);
      }
      return;
    }

    // (C) 評価バーボタンクリック
    const ratingBarBtn = e.target.closest('.card-rating-bar-btn');
    if (ratingBarBtn) {
      e.stopPropagation();
      if (ratingBarBtn.classList.contains('disabled') || (isEffectiveStacked() && ((photo.stack_count && photo.stack_count > 1) || (photo.stack_photos && photo.stack_photos.length > 1)))) {
        return;
      }
      const rating = parseInt(ratingBarBtn.dataset.rating, 10);
      const newRating = (photo.rating === rating) ? 0 : rating;
      photo.rating = newRating;
      updateCardRatingDirectly(photo.id, newRating);
      updatePhotoRating(photo.id, newRating);
      return;
    }

    // (D) カード本体クリック（選択・インスペクタ同期・またはビューワ）
    if (e.ctrlKey || e.metaKey) {
      togglePhotoSelection(photo.id, index);
    } else if (e.shiftKey) {
      rangeSelectPhotos(index);
    } else if (state.selectedPhotoIds.size > 1) {
      // 複数選択モード中のクリックはトグル
      togglePhotoSelection(photo.id, index);
    } else {
      // ダブルクリックの2回目クリック(e.detail >= 2)で既に同一写真が単一選択済みの場合は、
      // 直後の dblclick → openLightbox を妨げないようインスペクタ再構築をスキップ
      if (
        e.detail >= 2 &&
        state.selectedPhotoIds.size === 1 &&
        state.selectedPhotoIds.has(photo.id) &&
        state.activeInspectorPhotoId === photo.id
      ) {
        return;
      }
      // 単一選択（updateSelectionUI 内で updateInspectorView も1回呼ばれる）
      state.selectedPhotoIds.clear();
      state.selectedPhotoIds.add(photo.id);
      state.lastSelectedIndex = index;
      state.selectionAnchorIndex = index;
      state.selectionBaseIds = null;
      clearShiftPreview();
      state.activeInspectorPhotoId = photo.id;
      updateCardSelectionClasses();
      updateSelectionUI();
    }
  });

  // 1-2. マウスホバーによるShift範囲プレビュー（Googleフォト風）
  elements.photoGrid.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;
    const index = parseInt(card.dataset.index, 10);
    currentHoveredCardIndex = index;

    if (e.shiftKey && state.lastSelectedIndex !== -1 && state.selectedPhotoIds.size > 0) {
      updateShiftPreview(index);
    }
  });

  elements.photoGrid.addEventListener('mouseleave', () => {
    currentHoveredCardIndex = -1;
    clearShiftPreview();
  });

  // 2. ダブルクリックイベントの委譲（常にライトボックスを開く）
  elements.photoGrid.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;

    // チェックボックスや評価ボタンのクリック時はダブルクリック動作を無視
    if (e.target.closest('.card-select-checkbox, .card-rating-bar, .card-rating-icon')) return;

    const photoId = parseInt(card.dataset.photoId, 10);
    const index = parseInt(card.dataset.index, 10);
    const photo = state.photos[index];
    if (!photo) return;

    e.stopPropagation();
    const alreadySingleSelected = (
      state.selectedPhotoIds.size === 1 &&
      state.selectedPhotoIds.has(photo.id) &&
      state.activeInspectorPhotoId === photo.id
    );
    if (!alreadySingleSelected) {
      state.selectedPhotoIds.clear();
      state.selectedPhotoIds.add(photo.id);
      state.lastSelectedIndex = index;
      state.activeInspectorPhotoId = photo.id;
      updateCardSelectionClasses();
      updateSelectionUI();
    }

    openLightbox(index);
  });

  // 3. 右クリック（コンテキストメニュー）イベントの委譲
  elements.photoGrid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;

    e.preventDefault();
    e.stopPropagation();

    const photoId = parseInt(card.dataset.photoId, 10);
    const index = parseInt(card.dataset.index, 10);

    if (!state.selectedPhotoIds.has(photoId)) {
      if (!e.ctrlKey && !e.shiftKey) {
        state.selectedPhotoIds.clear();
      }
      state.selectedPhotoIds.add(photoId);
      state.lastSelectedIndex = index;
      updateCardSelectionClasses();
      updateSelectionUI();
    }
    openContextMenu(e.clientX, e.clientY);
  });
}

/**
 * レイアウトモード切り替え（grid / masonry / mount）
 */
function setLayoutMode(mode) {
  state.viewMode = mode;
  localStorage.setItem('pm_view_mode', mode);
  document.body.classList.remove('layout-masonry', 'layout-mount');

  if (mode === 'masonry') {
    document.body.classList.add('layout-masonry');
  } else if (mode === 'mount') {
    document.body.classList.add('layout-mount');
  }

  // セレクト・ボタンのアクティブ更新
  const viewModeSel = elements.viewModeSelect || document.getElementById('viewModeSelect');
  if (viewModeSel) {
    if (viewModeSel.value !== mode) viewModeSel.value = mode;
    updateHeaderSelectTooltip(viewModeSel);
  }
  elements.modeButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  _gridVirtualState.metricsDirty = true;
  _gridVirtualState.calibrated = false;
  if (_gridVirtualState.enabled && _canUseVirtualPhotoGrid()) {
    _measureVirtualGridMetrics(true);
  }
  checkAndAppendGridChunksIfNeeded();
}

/**
 * 情報表示ON/OFF（クリーン表示）切り替え（色でON/OFFを識別）
 */
function toggleMinimalView(forcedState) {
  state.isMinimalView = (forcedState !== undefined) ? forcedState : !state.isMinimalView;
  document.body.classList.toggle('minimal-view', state.isMinimalView);
  // 情報が表示されている状態（isMinimalView === false）を active（点灯）とする
  elements.toggleInfoBtn.classList.toggle('active', !state.isMinimalView);
  localStorage.setItem('pm_minimal_view', state.isMinimalView ? 'true' : 'false');
  _gridVirtualState.metricsDirty = true;
  _gridVirtualState.calibrated = false;
  if (_gridVirtualState.enabled && _canUseVirtualPhotoGrid()) {
    _measureVirtualGridMetrics(true);
  }
  checkAndAppendGridChunksIfNeeded();
}

/**
 * ファイルアップロード処理 (ドラッグ＆ドロップまたはファイル選択: Base64方式)
 */
async function uploadPhotos(fileList, explicitDestObj = null) {
  const validExtPattern = /\.(jpg|jpeg|png|webp|bmp|gif|tiff|tif|heic|heif|avif|rw2|arw|cr2|cr3|nef|nrw|dng|raf|orf|pef|srw|x3f|xmp|pp3|arp|dop|on1|cos|nksc|spd)$/i;
  const validFiles = Array.from(fileList || []).filter(f => (f.type && f.type.startsWith('image/')) || validExtPattern.test(f.name || ''));
  if (validFiles.length === 0) {
    showToast('画像ファイル（JPEG, PNG, WebP, RAW等）が選択されていません', 'warning');
    return;
  }

  const items = validFiles.map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
  if (typeof window.handleExternalFilesOrFoldersToLoome === 'function') {
    if (explicitDestObj && explicitDestObj.path !== undefined) {
      await window.handleExternalFilesOrFoldersToLoome(items, explicitDestObj.path, explicitDestObj.name || 'Loome');
    } else {
      await window.handleExternalFilesOrFoldersToLoome(items);
    }
    return;
  }
}
window.uploadPhotos = uploadPhotos;

// 起動実行
document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  if (typeof initPaneResize === 'function') initPaneResize();
  if (typeof initSelectionEvents === 'function') initSelectionEvents();
  if (typeof initInspectorEvents === 'function') initInspectorEvents();
  if (typeof initLightboxEvents === 'function') initLightboxEvents();
  if (typeof initScannerModalEvents === 'function') initScannerModalEvents();
  if (typeof initLocationTree === 'function') initLocationTree();
  if (typeof window.initLocationMapModal === 'function') window.initLocationMapModal();
  if (typeof window.initLabSection === 'function') window.initLabSection();
  if (typeof window.initCompareModal === 'function') window.initCompareModal();
});
