/**
 * Photo Manager - コアオーケストレータ & メインビュー
 * 定数・state・elements・ヘルパー: /js/common.js
 * 複数選択・コンテキストメニュー:   /js/selection.js
 * インスペクター・EXIF・GPS:       /js/inspector.js
 * ライトボックス・ズーム・フィルム: /js/lightbox.js
 * スキャンモーダル・フォルダ探索:   /js/scanner_modal.js
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
  setupEventListeners();
  initUserSettings();
  initHeartbeat();
  await refreshAll();
}


/**
 * 実体パスとの紐付けが外れた（リンク消失）写真の件数を取得してバッジ更新
 */
async function fetchUnlinkedCount() {
  try {
    const res = await fetch('/api/photos/unlinked-count');
    if (!res.ok) return;
    const data = await res.json();
    const count = data.count || 0;

    // クイックアクセスのバッジ更新
    if (elements.unlinkedOnlyNavItem) {
      elements.unlinkedOnlyNavItem.style.display = count > 0 ? 'flex' : 'none';
    }
    if (elements.unlinkedPhotosCount) {
      elements.unlinkedPhotosCount.textContent = count;
      elements.unlinkedPhotosCount.style.display = count > 0 ? 'inline-block' : 'none';
    }

    // フォルダツリー下部のリンク情報なしナビ項目の更新
    if (elements.folderTreeUnlinkedSection) {
      elements.folderTreeUnlinkedSection.style.display = count > 0 ? 'block' : 'none';
    }
    if (elements.folderTreeUnlinkedCount) {
      elements.folderTreeUnlinkedCount.textContent = count;
    }
  } catch (err) {
    console.warn('[WARN] fetchUnlinkedCount エラー:', err);
  }
}
window.fetchUnlinkedCount = fetchUnlinkedCount;
window.fetchMissingCount = fetchUnlinkedCount; // 互換性エイリアス

/**
 * 重複写真（同一撮影日時＋サイズで他フォルダコピーあり）件数の取得とクイックアクセス表示更新
 */
async function fetchDuplicatesCount() {
  try {
    const res = await fetch('/api/photos/duplicates-count');
    if (!res.ok) return;
    const data = await res.json();
    const count = data.count || 0;

    if (elements.duplicatesOnlyNavItem) {
      elements.duplicatesOnlyNavItem.style.display = count > 0 ? 'flex' : 'none';
    }
    if (elements.duplicatePhotosCount) {
      elements.duplicatePhotosCount.textContent = count;
      elements.duplicatePhotosCount.style.display = count > 0 ? 'inline-block' : 'none';
    }
  } catch (err) {
    console.warn('[WARN] fetchDuplicatesCount エラー:', err);
  }
}
window.fetchDuplicatesCount = fetchDuplicatesCount;

/**
 * 全データの取得と画面更新
 */
async function refreshAll() {
  await Promise.all([
    fetchPhotos(),
    fetchTags(),
    fetchTimeline(),
    fetchFolders(),
    fetchCameras(),
    fetchUnlinkedCount(),
    fetchDuplicatesCount(),
    (window.fetchFilterPresets ? window.fetchFilterPresets() : Promise.resolve()),
    (window.loadLocationTree ? window.loadLocationTree() : Promise.resolve()),
  ]);
}

/**
 * 写真一覧の取得 (タグの排他検索・複数年月OR・カメラ機種ORパラメータ対応)
 */
async function fetchPhotos() {
  try {
    const params = new URLSearchParams();
    if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
      params.append('folder', state.currentFilter.value);
    } else if (state.currentFilter.type === 'folder_exclude' && state.currentFilter.value) {
      params.append('exclude_folder', state.currentFilter.value);
    }
    
    if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
      params.append('year_months', Array.from(state.selectedYearMonths).join(','));
    } else if (state.currentFilter.type === 'year_month' && state.currentFilter.value) {
      params.append('year_month', state.currentFilter.value);
    }

    if (state.selectedCameras && state.selectedCameras.size > 0) {
      params.append('cameras', Array.from(state.selectedCameras).join(','));
    } else if (state.currentFilter.type === 'camera' && state.currentFilter.value) {
      params.append('cameras', state.currentFilter.value);
    }
    
    if (state.ratingFilter && state.ratingFilter.size > 0) {
      params.append('ratings', Array.from(state.ratingFilter).join(','));
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
      }
      if (excludeList.length > 0) {
        params.append('exclude_tags', excludeList.join(','));
      }
    }

    params.append('sort_by', state.sortBy);
    params.append('stacked', state.isStacked ? 'true' : 'false');

    if (state.connectionFilter === 'missing') {
      params.append('missing_only', 'true');
    } else if (state.connectionFilter === 'unlinked') {
      params.append('unlinked_only', 'true');
    } else if (state.connectionFilter === 'duplicates') {
      params.append('duplicates_only', 'true');
    }

    const response = await fetch(`/api/photos?${params.toString()}`);

    if (!response.ok) throw new Error('写真の取得に失敗しました');
    const data = await response.json();

    // 接続状態フィルタ（接続中のみ / 未接続のみ / 見つからない写真 / リンク消失）
    if (state.connectionFilter === 'online') {
      state.photos = data.photos.filter(p => !p.is_offline && !p.is_missing && !p.is_unlinked);
    } else if (state.connectionFilter === 'offline') {
      state.photos = data.photos.filter(p => p.is_offline);
    } else if (state.connectionFilter === 'missing') {
      state.photos = data.photos.filter(p => p.is_missing);
    } else if (state.connectionFilter === 'unlinked') {
      state.photos = data.photos;
    } else {
      state.photos = data.photos;
    }
    state.isLimitReached = data.photos.length >= MAX_DISPLAY_PHOTOS;
    renderPhotoGrid();
    updateViewHeader();
    updateInspectorView();

    // リンク消失写真一括消去ボタンの表示切替
    if (elements.purgeUnlinkedBtn) {
      elements.purgeUnlinkedBtn.style.display = (state.connectionFilter === 'unlinked' && state.photos.length > 0) ? 'inline-flex' : 'none';
    }
  } catch (error) {
    console.error('写真読み込みエラー:', error);
  }
}

/**
 * タグ一覧および未分類件数の取得と描画
 */
async function fetchTags() {
  try {
    const response = await fetch('/api/tags');
    if (!response.ok) throw new Error('タグ一覧取得失敗');
    const data = await response.json();

    state.availableTags = data.tags;
    elements.untaggedPhotosCount.textContent = data.untagged_count;
    if (data.total_count !== undefined) {
      elements.totalPhotosCount.textContent = data.total_count;
    }
    renderTagList();
  } catch (error) {
    console.error('タグ読み込みエラー:', error);
  }
}

/**
 * タイムライン情報の取得と描画
 */
async function fetchTimeline() {
  try {
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
async function fetchFolders() {
  const loadFolderSummary = async () => {
    try {
      const response = await fetch('/api/folders');
      if (!response.ok) throw new Error('フォルダ一覧取得失敗');
      const data = await response.json();
      state.rawFoldersData = data.folders || [];
    } catch (error) {
      console.error('フォルダ取得エラー:', error);
    }
  };
  await Promise.all([loadFolderSummary(), refreshFolderTree()]);
}

/**
 * タイムラインの描画 (年別エキスパンダ・複数月選択対応)
 */
function renderTimeline(timelineItems) {
  const container = elements.timelineTree || elements.timelineList;
  if (!container) return;

  if (!timelineItems || timelineItems.length === 0) {
    container.innerHTML = '<div class="empty-hint">日付情報なし</div>';
    return;
  }

  // 年ごとにグルーピング
  const yearGroups = new Map();
  timelineItems.forEach(item => {
    const parts = (item.year_month || '').split('-');
    const year = parts[0] || '不明';
    const month = parts[1] || '';
    if (!yearGroups.has(year)) {
      yearGroups.set(year, { year, totalCount: 0, months: [] });
    }
    const group = yearGroups.get(year);
    group.totalCount += item.count;
    group.months.push({ ...item, month });
  });

  container.innerHTML = '';

  yearGroups.forEach((group, year) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'timeline-year-group';

    // デフォルトは閉じた状態。ユーザーが手動で展開したか、その年内の月が選択されている場合のみ展開
    const hasSelectedMonth = group.months.some(m => state.selectedYearMonths.has(m.year_month));
    const isExpanded = state.expandedTimelineYears.has(year) || hasSelectedMonth;
    const isCollapsed = !isExpanded;

    // その年のすべての月が選択されているか判定
    const allMonthsSelected = group.months.length > 0 && group.months.every(m => state.selectedYearMonths.has(m.year_month));

    // 年ヘッダー
    const headerEl = document.createElement('div');
    headerEl.className = `timeline-year-header ${allMonthsSelected ? 'active-all' : ''}`;
    headerEl.dataset.year = year;

    headerEl.innerHTML = `
      <span class="tree-toggle-btn ${isCollapsed ? 'collapsed' : ''}" title="展開/折りたたみ">▼</span>
      <span class="timeline-year-title">${escapeHtml(year)}年</span>
      <span class="nav-count">${group.totalCount}</span>
    `;

    // 矢印クリックで開閉トグル
    const toggleBtn = headerEl.querySelector('.tree-toggle-btn');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const monthListEl = groupEl.querySelector('.timeline-month-list');
      const isNowCollapsed = toggleBtn.classList.toggle('collapsed');
      if (isNowCollapsed) {
        state.expandedTimelineYears.delete(year);
      } else {
        state.expandedTimelineYears.add(year);
      }
      if (monthListEl) {
        monthListEl.classList.toggle('hidden', isNowCollapsed);
      }
    });

    // 年ヘッダーのクリックでその年の全月を一括選択/解除（トグル）
    headerEl.addEventListener('click', () => {
      toggleYearMonths(group.months.map(m => m.year_month));
    });

    groupEl.appendChild(headerEl);

    // 月リスト
    const monthListEl = document.createElement('ul');
    monthListEl.className = `timeline-month-list ${isCollapsed ? 'hidden' : ''}`;

    group.months.forEach(m => {
      const monthLi = document.createElement('li');
      monthLi.className = 'nav-item timeline-month-item';
      if (state.selectedYearMonths.has(m.year_month)) {
        monthLi.classList.add('active');
      }
      monthLi.dataset.filterType = 'year_month';
      monthLi.dataset.filterValue = m.year_month;

      const displayMonth = m.month ? `${m.month}月` : m.year_month;
      monthLi.innerHTML = `
        <span class="nav-icon">📅</span>
        <span class="nav-text">${escapeHtml(displayMonth)}</span>
        <span class="nav-count">${m.count}</span>
      `;

      monthLi.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTimelineYearMonth(m.year_month);
      });

      monthListEl.appendChild(monthLi);
    });

    groupEl.appendChild(monthListEl);
    container.appendChild(groupEl);
  });
}

/**
 * 年内の月を一括トグル選択 (全選択 ⇄ 全解除)
 */
function toggleYearMonths(yearMonthsList) {
  const allAlreadySelected = yearMonthsList.every(ym => state.selectedYearMonths.has(ym));
  if (allAlreadySelected) {
    yearMonthsList.forEach(ym => state.selectedYearMonths.delete(ym));
  } else {
    yearMonthsList.forEach(ym => state.selectedYearMonths.add(ym));
  }
  updateTimelineFilterState();
}

/**
 * タイムライン年月のトグル処理 (複数月選択 / OR条件フィルタ)
 */
function toggleTimelineYearMonth(yearMonth) {
  if (state.selectedYearMonths.has(yearMonth)) {
    state.selectedYearMonths.delete(yearMonth);
  } else {
    state.selectedYearMonths.add(yearMonth);
  }
  updateTimelineFilterState();
}

/**
 * タイムライン選択状態の共通更新（タイトル・アクティブクラス・再取得）
 */
function updateTimelineFilterState() {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  // カメラ・フォルダ選択を確実にリセット（排他化）
  if (state.selectedCameras && state.selectedCameras.size > 0) {
    state.selectedCameras.clear();
    updateCameraActiveClasses();
  }
  if (elements.folderList) {
    elements.folderList.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  }

  const selectedCount = state.selectedYearMonths.size;
  if (selectedCount === 0) {
    state.currentFilter = { type: 'all', value: null };
    elements.viewTitle.textContent = 'すべての写真';
  } else if (selectedCount === 1) {
    const singleYm = Array.from(state.selectedYearMonths)[0];
    state.currentFilter = { type: 'year_month', value: singleYm };
    elements.viewTitle.textContent = `📅 ${singleYm}`;
  } else {
    const sortedYearMonths = Array.from(state.selectedYearMonths).sort();
    state.currentFilter = { type: 'year_months', value: sortedYearMonths };
    elements.viewTitle.textContent = `📅 複数月選択 (${selectedCount}ヶ月: ${sortedYearMonths.join(', ')})`;
  }

  updateTimelineActiveClasses();
  fetchPhotos();
}

/**
 * タイムラインおよび関連サイドバー要素のアクティブ表示を更新
 */
function updateTimelineActiveClasses() {
  const hasSelection = state.selectedYearMonths.size > 0;

  // 「すべての写真」のアクティブ表示切替
  document.querySelectorAll('.sidebar [data-filter-type="all"]').forEach(el => {
    if (!hasSelection && state.currentFilter.type === 'all' && state.selectedCameras.size === 0) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  // フォルダ選択の解除
  if (hasSelection) {
    elements.folderList.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  }

  // タイムライン年ヘッダー & 月項目のアクティブ状態更新
  const container = elements.timelineTree || elements.timelineList;
  if (container) {
    container.querySelectorAll('.timeline-year-group').forEach(groupEl => {
      const monthItems = groupEl.querySelectorAll('.timeline-month-item');
      let allSelected = monthItems.length > 0;
      monthItems.forEach(itemEl => {
        const ym = itemEl.dataset.filterValue;
        if (ym && state.selectedYearMonths.has(ym)) {
          itemEl.classList.add('active');
        } else {
          itemEl.classList.remove('active');
          allSelected = false;
        }
      });
      const headerEl = groupEl.querySelector('.timeline-year-header');
      if (headerEl) {
        headerEl.classList.toggle('active-all', allSelected);
      }
    });
  }
}

/**
 * カメラ機種情報の取得と描画
 */
async function fetchCameras() {
  try {
    const response = await fetch('/api/cameras');
    if (!response.ok) throw new Error('カメラ一覧取得失敗');
    const data = await response.json();
    state.availableCameras = data.cameras;
    renderCameras(data.cameras);
  } catch (error) {
    console.error('カメラ一覧読み込みエラー:', error);
  }
}

/**
 * カメラ機種リストの描画 (複数選択・OR条件対応)
 */
function renderCameras(cameraItems) {
  if (!elements.cameraList) return;

  if (!cameraItems || cameraItems.length === 0) {
    elements.cameraList.innerHTML = '<li class="empty-hint">カメラ情報なし</li>';
    return;
  }

  elements.cameraList.innerHTML = '';
  cameraItems.forEach(item => {
    const li = document.createElement('li');
    li.className = 'nav-item';
    if (state.selectedCameras && state.selectedCameras.has(item.camera_model)) {
      li.classList.add('active');
    }
    li.dataset.filterType = 'camera';
    li.dataset.filterValue = item.camera_model;

    li.innerHTML = `
      <span class="nav-icon">📷</span>
      <span class="nav-text" title="${escapeHtml(item.camera_model)}">${escapeHtml(item.camera_model)}</span>
      <span class="nav-count">${item.count}</span>
    `;

    li.addEventListener('click', () => {
      toggleCameraFilter(item.camera_model);
    });

    elements.cameraList.appendChild(li);
  });
}

/**
 * カメラ機種のトグル選択処理 (複数選択 / OR条件フィルタ)
 */
function toggleCameraFilter(cameraModel) {
  if (state.selectedCameras.has(cameraModel)) {
    state.selectedCameras.delete(cameraModel);
  } else {
    state.selectedCameras.add(cameraModel);
  }

  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  // タイムライン・フォルダ選択を確実にリセット（排他化）
  if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
    state.selectedYearMonths.clear();
    updateTimelineActiveClasses();
  }
  if (elements.folderList) {
    elements.folderList.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  }

  const count = state.selectedCameras.size;
  if (count === 0) {
    if (state.currentFilter.type === 'cameras' || state.currentFilter.type === 'camera') {
      state.currentFilter = { type: 'all', value: null };
      elements.viewTitle.textContent = 'すべての写真';
    }
  } else if (count === 1) {
    const singleCam = Array.from(state.selectedCameras)[0];
    state.currentFilter = { type: 'camera', value: singleCam };
    elements.viewTitle.textContent = `📷 ${singleCam}`;
  } else {
    const sortedCams = Array.from(state.selectedCameras).sort();
    state.currentFilter = { type: 'cameras', value: sortedCams };
    elements.viewTitle.textContent = `📷 複数カメラ (${count}機種: ${sortedCams.join(', ')})`;
  }

  updateCameraActiveClasses();
  fetchPhotos();
}

/**
 * カメラリストのアクティブ表示更新
 */
function updateCameraActiveClasses() {
  if (!elements.cameraList) return;
  elements.cameraList.querySelectorAll('.nav-item').forEach(el => {
    const cam = el.dataset.filterValue;
    if (cam && state.selectedCameras.has(cam)) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
}

/**
 * ディレクトリパス一覧から階層ツリー構造を構築する
 * （Windowsのドライブ文字やフォルダー名の大文字小文字の揺れを同一フォルダとして統合）
 */
function buildFolderTree(folderItems) {
  const root = { children: new Map(), count: 0, fullPath: '' };

  folderItems.forEach(item => {
    let rawPath = (item.directory_path || '').trim();
    if (!rawPath) return;

    // Windowsドライブレター (例: "g:" や "g:\...") を大文字 "G:" に正規化
    if (/^[a-z]:/i.test(rawPath)) {
      rawPath = rawPath[0].toUpperCase() + rawPath.slice(1);
    }

    // パス区切りを / で統一してセグメント分解
    const isUnc = rawPath.startsWith('\\\\') || rawPath.startsWith('//');
    let normalized = rawPath.replace(/\\/g, '/');
    let prefix = '';
    if (isUnc) {
      normalized = normalized.replace(/^\/+/, '');
      prefix = '\\\\';
    }

    const segments = normalized.split('/').filter(Boolean);
    let current = root;
    let accumulatedPath = prefix;

    segments.forEach((seg, idx) => {
      // ドライブレターセグメント（例: "g:"）を大文字化
      let displaySeg = seg;
      if (idx === 0 && /^[a-z]:$/i.test(seg)) {
        displaySeg = seg.toUpperCase();
      }

      if (idx === 0) {
        accumulatedPath += displaySeg;
      } else {
        const sep = (accumulatedPath.endsWith('\\') || accumulatedPath.endsWith('/')) ? '' : '\\';
        accumulatedPath += sep + displaySeg;
      }

      // 大文字小文字を区別せず同一フォルダとして束ねるため、キーは小文字を使用
      const lookupKey = displaySeg.toLowerCase();

      if (!current.children.has(lookupKey)) {
        current.children.set(lookupKey, {
          name: displaySeg,
          fullPath: accumulatedPath,
          rawPath: rawPath,
          count: 0,
          totalCount: 0,
          status: 'unmanaged',
          isMissing: false,
          children: new Map(),
        });
      }

      const childNode = current.children.get(lookupKey);

      // 管理中（写真が存在する）またはより具体的な大文字表記があれば表示名をアップデート
      if (item.status === 'managed' || (item.count && item.count > 0)) {
        childNode.name = displaySeg;
        childNode.fullPath = accumulatedPath;
      }

      if (idx === segments.length - 1) {
        // 葉ノード（末端）の場合
        if (item.status === 'managed' || (item.count && item.count > 0)) {
          childNode.status = 'managed';
          childNode.count = item.count || 0;
          childNode.isMissing = !!item.is_missing;
        } else if (childNode.status !== 'managed') {
          childNode.count = item.count || 0;
          childNode.status = item.status || 'unmanaged';
          childNode.isMissing = !!item.is_missing;
        }
      }
      current = childNode;
    });
  });

  // 各ノードの配下写真総数（自身＋子孫）およびステータスを再帰計算
  function calculateTotals(node) {
    let sum = node.count;
    let hasManagedChild = false;
    let hasUnmanagedChild = false;
    let allIgnored = (node.children.size > 0);

    node.children.forEach(child => {
      sum += calculateTotals(child);
      if (child.status === 'managed' || child.totalCount > 0) hasManagedChild = true;
      if (child.status === 'unmanaged') hasUnmanagedChild = true;
      if (child.status !== 'ignored') allIgnored = false;
    });

    node.totalCount = sum;

    // ノード自身のstatusが明示されていない親ノードの状態推論
    if (!node.status || node.status === 'unmanaged') {
      if (sum > 0 || hasManagedChild) {
        node.status = 'managed';
      } else if (allIgnored && node.children.size > 0) {
        node.status = 'ignored';
      } else if (hasUnmanagedChild) {
        node.status = 'unmanaged';
      }
    }

    // 子孫がすべて未接続なら親も未接続扱い
    if (node.children.size > 0 && Array.from(node.children.values()).every(c => c.isMissing)) {
      node.isMissing = true;
    }

    return sum;
  }
  root.children.forEach(child => calculateTotals(child));

  return root;
}

/**
 * スラッシュ区切りのタグ一覧から階層ツリー構造を構築する
 * 各階層の子ノードは自然順（数字なら小さい方が上・昇順）にソートされる (v2.11)
 */
function buildTagTree(tagItems) {
  const root = { children: new Map(), count: 0 };

  tagItems.forEach(item => {
    const parts = item.tag.split('/').map(p => p.trim()).filter(Boolean);
    let current = root;
    let currentPath = '';

    parts.forEach((part, idx) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath: currentPath,
          count: 0,
          children: new Map(),
        });
      }
      const childNode = current.children.get(part);
      // 祖先ノード独立保存: 各ノードはDB上の自身の件数のみを表示（累計しない）
      if (idx === parts.length - 1) {
        childNode.count = item.count;
        childNode.source = item.source || 'manual';
      }
      current = childNode;
    });
  });

  // 各階層の子ノードを自然順ソート（数字なら小さい方が上・昇順）で再帰的に整列
  function sortTreeNodes(node) {
    if (!node.children || node.children.size === 0) return;
    const sortedEntries = Array.from(node.children.entries()).sort((a, b) => {
      return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' });
    });
    node.children = new Map(sortedEntries);
    node.children.forEach(child => sortTreeNodes(child));
  }
  sortTreeNodes(root);

  return root;
}

/**
 * 写真に付いているタグ一覧から、リーフタグ（子孫タグを持たない最深のタグ）のみを抽出する。
 * 祖先ノード独立保存方式のため、表示時は末端のタグだけをチップ表示し、
 * 中間ノードは省略する（削除操作で親ノードが自然に現れる）。
 */
function getLeafTags(tags) {
  if (!tags || tags.length === 0) return [];
  return tags.filter(tag =>
    !tags.some(other => other !== tag && other.startsWith(tag + '/'))
  );
}

/**
 * 指定したタグパスのすべての祖先階層を展開状態（expandedTagPaths）にする
 * 例: "車/mazda/CX-5" ➜ "車", "車/mazda" を expandedTagPaths に追加
 */
function expandTagAncestors(fullPath) {
  if (!fullPath) return;
  const parts = fullPath.split('/').map(p => p.trim()).filter(Boolean);
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    state.expandedTagPaths.add(acc);
  }
}

/**
 * カラーパレット専用 左クリック操作 (単一選択制御)
 * - 既にその色が 'include' ➜ 解除 (OFF)
 * - 別の色または未選択 ➜ 他のカラータグを解除した上で、この色を 'include' にセット
 * ※ 被写体タグ等の通常タグフィルタは維持されます
 */
function handleColorFilterLeftClick(colorName) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(colorName);
  
  // 他のカラータグのフィルタをすべて解除（単一選択）
  Object.keys(COLOR_TAG_MAP).forEach(cName => {
    state.tagFilters.delete(cName);
  });

  if (current !== 'include') {
    state.tagFilters.set(colorName, 'include');
  }

  renderTagList();
  fetchPhotos();
}

/**
 * カラーパレット専用 右クリック操作 (単一選択制御)
 * - 既にその色が 'exclude' ➜ 解除 (OFF)
 * - 別の色または未選択 ➜ 他のカラータグを解除した上で、この色を 'exclude' にセット
 */
function handleColorFilterRightClick(colorName) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(colorName);
  
  // 他のカラータグのフィルタをすべて解除（単一選択）
  Object.keys(COLOR_TAG_MAP).forEach(cName => {
    state.tagFilters.delete(cName);
  });

  if (current !== 'exclude') {
    state.tagFilters.set(colorName, 'exclude');
  }

  renderTagList();
  fetchPhotos();
}

/**
 * カラータグ・パレットの開閉トグル (エキスパンダ)
 */
function toggleColorPaletteExpander(isOpen) {
  const section = elements.colorPaletteSection || document.getElementById('colorPaletteSection');
  const body = elements.colorPaletteBody || document.getElementById('colorPaletteBody');
  if (!section) return;

  if (isOpen === undefined) {
    isOpen = !section.classList.contains('is-open');
  }

  section.classList.toggle('is-open', isOpen);
  if (body) {
    body.style.display = isOpen ? 'block' : 'none';
  }
  localStorage.setItem('pm_color_filter_expanded', isOpen ? 'true' : 'false');
}

/**
 * カラータグ・パレットの描画 (上部集約 ＆ 3ステート連動)
 */
function renderColorPalette() {
  if (!elements.colorPaletteSection || !elements.colorSwatchGrid) return;

  const colorTagNames = Object.keys(COLOR_TAG_MAP);

  // 現在のタグソースフィルタに応じたカウント集計
  let available = state.availableTags || [];
  if (state.tagSourceFilter === 'manual') {
    available = available.filter(t => t.source === 'manual' || t.source === 'both');
  } else if (state.tagSourceFilter === 'ai') {
    available = available.filter(t => t.source === 'ai' || t.source === 'both');
  }

  const tagCountMap = new Map();
  available.forEach(t => {
    const tagName = t.tag || t.name;
    tagCountMap.set(tagName, t.count || 0);
  });

  const activeColorFilters = colorTagNames.filter(name => state.tagFilters.has(name));

  // 常時表示してカラーによる絞り込みを直感的に提供
  elements.colorPaletteSection.style.display = 'block';

  if (elements.colorPaletteActiveCount) {
    if (activeColorFilters.length > 0) {
      const activeColor = activeColorFilters[0];
      const mode = state.tagFilters.get(activeColor);
      const modeText = mode === 'exclude' ? '除外' : '含む';
      elements.colorPaletteActiveCount.textContent = `(${activeColor}: ${modeText})`;
    } else {
      elements.colorPaletteActiveCount.textContent = '';
    }
  }

  elements.colorSwatchGrid.innerHTML = '';

  colorTagNames.forEach(colorName => {
    const conf = COLOR_TAG_MAP[colorName];
    const count = tagCountMap.get(colorName) || 0;
    const currentMode = state.tagFilters.get(colorName); // 'include' | 'exclude' | undefined

    const chip = document.createElement('div');
    chip.className = 'color-swatch-chip';
    if (currentMode === 'include') {
      chip.classList.add('state-include');
    } else if (currentMode === 'exclude') {
      chip.classList.add('state-exclude');
    }

    // ボタンフェイスそのものをその色（カラータイル）として鮮明に表示
    chip.style.background = conf.bg;
    chip.style.borderColor = conf.border;
    chip.style.color = conf.text;
    if (conf.shadow) {
      chip.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.6)';
    } else {
      chip.style.textShadow = 'none';
    }

    let badgeIcon = '';
    if (currentMode === 'include') badgeIcon = '<span class="color-swatch-badge badge-include">+</span>';
    else if (currentMode === 'exclude') badgeIcon = '<span class="color-swatch-badge badge-exclude">−</span>';

    chip.innerHTML = `
      ${badgeIcon}
      <span class="color-swatch-label" title="${escapeHtml(colorName)}">${escapeHtml(conf.label || colorName)}</span>
      <span class="color-swatch-count">${count}</span>
    `;

    chip.setAttribute('title', `${colorName} (${count}枚)\nクリック: この色で絞り込み ｜ 右クリック: 除外`);

    // 左クリック: 単一選択で含む/解除
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      handleColorFilterLeftClick(colorName);
    });

    // 右クリック: 単一選択で除外/解除
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleColorFilterRightClick(colorName);
    });

    elements.colorSwatchGrid.appendChild(chip);
  });
}

/**
 * 3ステート階層タグツリーの描画 (親タグ包括 ＆ 子タグ排他対応 ＆ AI/手動フィルタ)
 */
function renderTagList() {
  const hasActiveFilters = state.tagFilters.size > 0;
  elements.clearTagFiltersBtn.style.display = hasActiveFilters ? 'inline' : 'none';

  // カラータグパレットの描画（上部に集約）
  renderColorPalette();

  // セグメントボタンのアクティブ同期
  if (elements.tagTypeSegmentedControl) {
    elements.tagTypeSegmentedControl.querySelectorAll('.tag-segment-btn').forEach(b => {
      b.classList.toggle('active', (b.dataset.sourceFilter || 'manual') === state.tagSourceFilter);
    });
  }

  // セグメントボタンのイベントバインド（未バインド時のみ）
  if (elements.tagTypeSegmentedControl && !elements.tagTypeSegmentedControl.dataset.bound) {
    elements.tagTypeSegmentedControl.dataset.bound = 'true';
    elements.tagTypeSegmentedControl.querySelectorAll('.tag-segment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        elements.tagTypeSegmentedControl.querySelectorAll('.tag-segment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.tagSourceFilter = btn.dataset.sourceFilter || 'manual';
        localStorage.setItem('pm_tag_source_filter', state.tagSourceFilter);
        renderTagList();
      });
    });
  }

  let tagsToDisplay = state.availableTags || [];
  if (state.tagSourceFilter === 'manual') {
    tagsToDisplay = tagsToDisplay.filter(t => t.source === 'manual' || t.source === 'both');
  } else if (state.tagSourceFilter === 'ai') {
    tagsToDisplay = tagsToDisplay.filter(t => t.source === 'ai' || t.source === 'both');
  }

  // カラータグは上部パレットに集約されているため、下部の通常ツリー一覧からは除外
  tagsToDisplay = tagsToDisplay.filter(t => !((t.tag || t.name) in COLOR_TAG_MAP));

  // テキスト絞り込み (Enter確定クエリによる部分一致フィルタ)
  if (state.tagSearchQuery && state.tagSearchQuery.trim()) {
    const q = state.tagSearchQuery.trim().toLowerCase();
    tagsToDisplay = tagsToDisplay.filter(t => {
      const name = (t.tag || t.name || '').toLowerCase();
      return name.includes(q);
    });
  }

  if (tagsToDisplay.length === 0) {
    let emptyMsg = '';
    if (state.tagSearchQuery && state.tagSearchQuery.trim()) {
      emptyMsg = `「${escapeHtml(state.tagSearchQuery.trim())}」に一致するタグはありません`;
    } else {
      emptyMsg = state.tagSourceFilter === 'ai' 
        ? 'その他のAIタグはありません' 
        : 'その他のタグなし (＋で作成)';
    }
    elements.tagList.innerHTML = `<li class="empty-hint">${emptyMsg}</li>`;
    return;
  }

  elements.tagList.innerHTML = '';
  const treeRoot = buildTagTree(tagsToDisplay);

  // 選択中フィルタがある場合、そのタグの祖先を展開
  if (state.tagFilters && state.tagFilters.size > 0) {
    state.tagFilters.forEach((mode, tagPath) => {
      expandTagAncestors(tagPath);
    });
  }

  // テキスト絞り込みがある場合、ヒットしたタグの祖先を展開
  if (state.tagSearchQuery && state.tagSearchQuery.trim()) {
    tagsToDisplay.forEach(t => {
      expandTagAncestors(t.tag || t.name);
    });
  }

  // ツリーノードを再帰的にDOM構築
  function appendTreeNodes(parentNode, container) {
    parentNode.children.forEach(node => {
      const nodeEl = document.createElement('li');
      nodeEl.className = 'tag-tree-node';

      const hasChildren = node.children.size > 0;
      const currentMode = state.tagFilters.get(node.fullPath);

      // ピル行
      const pillItem = document.createElement('div');
      pillItem.className = 'tag-pill-item';
      if (node.source === 'ai') {
        pillItem.classList.add('is-ai-tag');
      }

      let stateIcon = '';
      if (currentMode === 'include') {
        pillItem.classList.add('state-include');
        stateIcon = '+';
      } else if (currentMode === 'exclude') {
        pillItem.classList.add('state-exclude');
        stateIcon = '−';
      }

      const isExpanded = state.expandedTagPaths.has(node.fullPath);

      // ツリー展開矢印またはスペーサー (デフォルトは閉: collapsed)
      let arrowHtml = '<span class="tree-toggle-spacer"></span>';
      if (hasChildren) {
        arrowHtml = `<span class="tree-toggle-btn ${isExpanded ? '' : 'collapsed'}">▼</span>`;
      }

      // AIバッジ
      let aiIconHtml = '';
      if (node.source === 'ai') {
        aiIconHtml = '<span class="ai-tag-pill-badge" style="margin-right: 3px;">AI</span>';
      }

      pillItem.innerHTML = `
        <div class="tag-pill-main">
          ${arrowHtml}
          <span class="tag-state-icon">${stateIcon}</span>
          ${aiIconHtml}
          <span class="tag-name-text" title="${escapeHtml(node.fullPath)}">${escapeHtml(node.name)}</span>
        </div>
        <div class="tag-pill-right">
          <span class="tag-pill-count">${node.count}</span>
          <span class="tag-rename-btn" title="タグ「${escapeHtml(node.name)}」をリネーム">✏</span>
          <span class="tag-delete-btn" title="タグ「${escapeHtml(node.fullPath)}」を削除">&times;</span>
        </div>
      `;

      // 展開・折りたたみイベント (1段ずつ展開・折りたたみ)
      if (hasChildren) {
        const toggleBtn = pillItem.querySelector('.tree-toggle-btn');
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const childrenContainer = nodeEl.querySelector('.tag-tree-children');
          const isNowCollapsed = toggleBtn.classList.toggle('collapsed');
          if (isNowCollapsed) {
            state.expandedTagPaths.delete(node.fullPath);
          } else {
            state.expandedTagPaths.add(node.fullPath);
          }
          if (childrenContainer) {
            childrenContainer.classList.toggle('hidden', isNowCollapsed);
          }
        });
      }

      pillItem.setAttribute('title', `${node.fullPath}\n左クリック: 含む/解除 ｜ 右クリック: 除外`);

      // 左クリック: フィルタOFF ➜ 含む(+) / フィルタON(除外含む) ➜ OFF(解除)
      pillItem.addEventListener('click', (e) => {
        if (e.target.closest('.tree-toggle-btn') || e.target.closest('.tag-delete-btn') || e.target.closest('.tag-rename-btn') || e.target.closest('.tag-rename-input')) return;
        handleTagLeftClick(node.fullPath);
      });

      // 右クリック: 除外(-)のトグル（OFFまたは含む ➜ 除外 / 既に除外 ➜ OFF）
      pillItem.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.tree-toggle-btn') || e.target.closest('.tag-delete-btn') || e.target.closest('.tag-rename-btn') || e.target.closest('.tag-rename-input')) return;
        e.preventDefault();
        e.stopPropagation();
        handleTagRightClick(node.fullPath);
      });

      // タグ削除ボタン
      const deleteBtn = pillItem.querySelector('.tag-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
        deleteBtn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
        });
        deleteBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          deleteTagCompletely(node.fullPath, node.count);
        });
      }

      // タグリネームボタン
      const renameBtn = pillItem.querySelector('.tag-rename-btn');
      if (renameBtn) {
        renameBtn.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
        renameBtn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
        });
        renameBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          startInlineRename(pillItem, node);
        });
      }

      nodeEl.appendChild(pillItem);

      // 子ノードがある場合は再帰 (デフォルトは閉: hidden)
      if (hasChildren) {
        const childrenContainer = document.createElement('ul');
        childrenContainer.className = `tag-tree-children ${isExpanded ? '' : 'hidden'}`;
        appendTreeNodes(node, childrenContainer);
        nodeEl.appendChild(childrenContainer);
      }


      container.appendChild(nodeEl);
    });
  }

  appendTreeNodes(treeRoot, elements.tagList);
}

/**
 * タグのインラインリネームを開始する
 */
function startInlineRename(pillItem, node) {
  const nameSpan = pillItem.querySelector('.tag-name-text');
  if (!nameSpan) return;

  // 既にinputが表示されている場合は何もしない
  if (pillItem.querySelector('.tag-rename-input')) return;

  const oldName = node.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-rename-input';
  input.value = oldName;

  nameSpan.style.display = 'none';
  nameSpan.parentNode.insertBefore(input, nameSpan.nextSibling);
  input.focus();
  input.select();

  let committed = false;

  async function commitRename() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();

    // 変更なしまたは空ならキャンセル
    if (!newName || newName === oldName) {
      input.remove();
      nameSpan.style.display = '';
      return;
    }

    // 新しいfullPathを構築（親パスを維持してノード名だけ変更）
    const parts = node.fullPath.split('/');
    parts[parts.length - 1] = newName;
    const newFullPath = parts.join('/');

    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(node.fullPath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_tag: newFullPath }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'リネームに失敗しました');
      }
      await refreshAll();
    } catch (err) {
      alert('エラー: ' + err.message);
      input.remove();
      nameSpan.style.display = '';
    }
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      committed = true;
      input.remove();
      nameSpan.style.display = '';
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => commitRename(), 100);
  });

  // input内のクリックが親に伝搬しないようにする
  input.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * タグを全写真から一括削除する
 */
async function deleteTagCompletely(tagPath, photoCount = 0) {
  let confirmed = false;
  if (typeof showDeleteTagModal === 'function') {
    confirmed = await showDeleteTagModal(tagPath, photoCount);
  } else {
    const countMsg = photoCount > 0
      ? `\n\n※ ${photoCount} 枚の写真からこのタグ（およびその子孫タグ）が削除されます。`
      : '\n\n※ このタグ（およびその子孫タグ）が全写真から削除されます。';
    confirmed = confirm(`タグ「${tagPath}」を削除しますか？${countMsg}\n※ 写真ファイル自体は削除されません。`);
  }
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/tags/${encodeURIComponent(tagPath)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.detail || 'タグの削除に失敗しました');
    }
    // フィルタ状態からも削除
    state.tagFilters.delete(tagPath);
    await refreshAll();
  } catch (err) {
    alert('エラー: ' + err.message);
  }
}

/**
 * タグツリー 左クリック操作
 * - フィルタOFF ➜ 含む (include [+])
 * - フィルタON (含む[+] または 除外[-]) ➜ 解除 (OFF)
 */
function handleTagLeftClick(tag) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(tag);
  if (current) {
    state.tagFilters.delete(tag);
  } else {
    state.tagFilters.set(tag, 'include');
    expandTagAncestors(tag);
  }

  renderTagList();
  fetchPhotos();
}

/**
 * タグツリー 右クリック操作
 * - フィルタOFF または 含む[+] ➜ 除外 (exclude [-])
 * - 既に除外[-] ➜ 解除 (OFF)
 */
function handleTagRightClick(tag) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(tag);
  if (current === 'exclude') {
    state.tagFilters.delete(tag);
  } else {
    state.tagFilters.set(tag, 'exclude');
    expandTagAncestors(tag);
  }

  renderTagList();
  fetchPhotos();
}

// 後方互換性エイリアス
const toggleTagFilter = handleTagLeftClick;

/**
 * 特定のタグフィルタを解除（削除）
 */
function removeTagFilter(tag) {
  state.tagFilters.delete(tag);
  renderTagList();
  fetchPhotos();
}

/**
 * すべてのタグフィルタをクリア
 */
function clearAllTagFilters() {
  state.tagFilters.clear();
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');
  renderTagList();
  fetchPhotos();
}

// グリッドの段階的チャンク描画状態（現在DOMに生成済みのカード枚数）
let renderedGridCount = 0;
let renderGridTaskId = null;
let _gridScrollListenerBound = false;

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
  card.classList.toggle('is-portrait', isPort);
  card.classList.toggle('is-landscape', !isPort);
  card.style.setProperty('--photo-aspect', `${img.naturalWidth} / ${img.naturalHeight}`);
  card.style.setProperty('--photo-aspect-ratio', ratio.toFixed(4));
}
window.onThumbImageLoad = onThumbImageLoad;

/**
 * 写真カードのDOM要素を生成する（イベントリスナーは委譲するため一切登録しない軽量・高速版）
 */
function createPhotoCard(photo, index) {
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.dataset.photoId = photo.id;
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
  if (photo.is_offline) {
    card.classList.add('is-offline');
    const volName = photo.volume_label ? `（ボリューム: ${photo.volume_label}）` : '';
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

  // ホバー時評価バーの生成
  const ratingBarHtml = `
    <div class="card-rating-bar">
      <span class="card-rating-bar-btn${photo.rating === 2 ? ' active' : ''}" data-rating="2">優</span>
      <span class="card-rating-bar-btn${photo.rating === 1 ? ' active' : ''}" data-rating="1">良</span>
      <span class="card-rating-bar-btn${photo.rating === -1 ? ' active' : ''}" data-rating="-1">棄</span>
    </div>
  `;

  const dateFormatted = photo.date_taken ? photo.date_taken.substring(0, 10) : '日付不明';

  // タグバッジHTML (サムネイルギャラリーの情報パネルにはAIタグを表示せず、手動タグのみ表示)
  let tagsHtml = '';
  const detailsMap = {};
  if (photo.tag_details) {
    photo.tag_details.forEach(d => { detailsMap[d.tag] = d; });
  }
  const manualLeafTags = getLeafTags(photo.tags).filter(t => {
    const detail = detailsMap[t];
    return !(detail && detail.source === 'ai');
  });

  if (manualLeafTags.length > 0) {
    tagsHtml = '<div class="card-tags">' +
      manualLeafTags.slice(0, 3).map(t => {
        const colorConf = COLOR_TAG_MAP[t];
        const colorDot = colorConf ? `<span class="tag-color-dot" style="background:${colorConf.color};"></span>` : '';
        return `<span class="card-tag-badge">${colorDot}${escapeHtml(t)}</span>`;
      }).join('') +
      (manualLeafTags.length > 3 ? `<span class="card-tag-badge">+${manualLeafTags.length - 3}</span>` : '') +
      '</div>';
  }

  // フォーマットバッジHTML (RAW / RAW+JPG)
  let formatBadgeHtml = '';
  const hasRawPair = Boolean(photo.paired_raw_path || (photo.stack_photos && photo.stack_photos.some(sp => sp.is_raw)));
  if (hasRawPair) {
    formatBadgeHtml = `<span class="format-badge raw-jpg-badge" title="RAW+JPEGペア写真">RAW+JPG</span>`;
  } else if (photo.is_raw) {
    const rawFmt = (photo.raw_format || 'RAW').toUpperCase().replace('.', '');
    formatBadgeHtml = `<span class="format-badge raw-badge" title="RAW画像 (${rawFmt})">${rawFmt}</span>`;
  }

  // スタックバッジHTML (ブラケット / 連写 / 重複)
  let stackBadgeHtml = '';
  if (state.isStacked && photo.stack_count > 1) {
    if (photo.stack_type === 'duplicate') {
      stackBadgeHtml = `<span class="stack-badge stack-badge-dup" data-photo-id="${photo.id}" title="重複写真 ${photo.stack_count}枚 (他フォルダにコピーあり・クリックで一覧表示)">📋 重複 ${photo.stack_count}</span>`;
    } else {
      const bktType = photo.stack_type === 'burst' ? 'BURST' : 'BKT';
      const isWithRaw = hasRawPair ? ' (RAW+JPG)' : '';
      stackBadgeHtml = `<span class="stack-badge" data-photo-id="${photo.id}" title="グループ ${photo.stack_count}枚${isWithRaw} (クリックで露出一覧を表示)">⚡ ${bktType} ${photo.stack_count}</span>`;
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

  if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
    const curNorm = state.currentFilter.value.replace(/\\/g, '/').toLowerCase();
    const matched = (state.rawFoldersData || []).find(f => (f.directory_path || '').replace(/\\/g, '/').toLowerCase() === curNorm);
    if (matched && matched.is_missing) {
      if (elements.warningBannerDesc) {
        elements.warningBannerDesc.textContent = `実フォルダ（${state.currentFilter.value}）が存在しないか、ドライブが未接続です。（保存済みサムネイルをキャッシュから表示中）`;
      }
      elements.folderWarningBanner.style.display = 'flex';
      return;
    }
  }
  elements.folderWarningBanner.style.display = 'none';
}

const GRID_INITIAL_CHUNK = 200;
const GRID_CHUNK_SIZE = 200;

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
 * 指定したインデックスの写真カードがDOM上に確実に存在するようチャンクを描画する
 */
function ensureCardsRenderedUpTo(targetIndex) {
  if (targetIndex >= renderedGridCount && renderedGridCount < state.photos.length) {
    appendPhotoGridChunk(targetIndex + 1);
  }
}
window.ensureCardsRenderedUpTo = ensureCardsRenderedUpTo;

/**
 * スクロール位置やコンテナ高さに応じて、下端余白が近づいていれば次チャンクを自動追加する
 */
function checkAndAppendGridChunksIfNeeded() {
  if (renderedGridCount >= state.photos.length || !elements.photoGrid) return;
  const container = elements.photoGrid.parentElement;
  if (!container) return;

  // 下端から 900px 以内に近づいた場合、または画面内にまだ余裕がある場合に次チャンクを追加
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 900) {
    appendPhotoGridChunk();
    // 大画面・極小サムネイル時に1チャンクではまだ画面が埋まらない場合は次フレームで継続チェック
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
 * 写真グリッドの描画（初期200枚を即座に表示し、以降はスクロールに連動して段階的にチャンク追加）
 */
function renderPhotoGrid() {
  // 進行中のバックグラウンド描画があればキャンセル
  if (renderGridTaskId) {
    cancelAnimationFrame(renderGridTaskId);
    renderGridTaskId = null;
  }

  // スクロールコンテナへのイベント登録（初回のみ）
  if (!_gridScrollListenerBound && elements.photoGrid && elements.photoGrid.parentElement) {
    _gridScrollListenerBound = true;
    elements.photoGrid.parentElement.addEventListener('scroll', () => {
      checkAndAppendGridChunksIfNeeded();
    }, { passive: true });
    window.addEventListener('resize', () => {
      checkAndAppendGridChunksIfNeeded();
    }, { passive: true });
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
        const folderStatus = matched ? matched.status : 'managed';
        const isFolderMissing = matched ? !!matched.is_missing : false;

        if (isFolderMissing) {
          if (iconEl) iconEl.textContent = '⚠️';
          if (titleEl) titleEl.textContent = '実フォルダが見つかりません（未接続）';
          if (descEl) descEl.textContent = `実フォルダ（${state.currentFilter.value}）が存在しないか、ドライブが未接続です。ドライブの接続状態を確認してください。`;
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '🔄 接続を再確認';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              showToast('🔄 ドライブ・フォルダの接続状態を確認中...', 'info');
              await fetchFolders();
              await fetchPhotos();
              showToast('接続状態を更新しました', 'success');
            };
          }
        } else if (folderStatus === 'unmanaged') {
          if (iconEl) iconEl.textContent = '📁';
          if (titleEl) titleEl.textContent = 'このフォルダはライブラリ未登録です';
          if (descEl) descEl.textContent = '実ディスク上に存在する未登録フォルダです。「管理に追加」を押すと写真をスキャンしてライブラリに登録します。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '➕ 管理に追加してスキャン';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              showToast(`➕ 「${state.currentFilter.value}」を管理に追加・スキャン中...`, 'info');
              await executeScan(state.currentFilter.value, false, false);
            };
          }
        } else if (folderStatus === 'ignored') {
          if (iconEl) iconEl.textContent = '🚫';
          if (titleEl) titleEl.textContent = 'このフォルダは管理対象外（除外設定中）です';
          if (descEl) descEl.textContent = '自動スキャンの対象から除外されています。「除外を解除」を押すと未登録状態に戻せます。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '↩️ 除外を解除する';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              try {
                const res = await fetch('/api/folders/ignore', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ folder_path: state.currentFilter.value }),
                });
                if (res.ok) {
                  showToast('↩️ 除外を解除しました', 'success');
                  await refreshAll();
                }
              } catch (err) {
                showToast(`エラー: ${err.message}`, 'error');
              }
            };
          }
        } else {
          if (iconEl) iconEl.textContent = '📷';
          if (titleEl) titleEl.textContent = '写真が見つかりません';
          if (descEl) descEl.textContent = '指定された条件の写真がないか、まだスキャンされていません。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '📁 フォルダ一覧を開く';
            elements.emptyStateActionBtn.onclick = () => {
              if (window.openSidebarSection) window.openSidebarSection('folder');
            };
          }
        }
      } else {
        if (iconEl) iconEl.textContent = '📷';
        if (titleEl) titleEl.textContent = '写真が見つかりません';
        if (descEl) descEl.textContent = '指定された条件の写真がないか、まだスキャンされていません。';
        if (elements.emptyStateActionBtn) {
          elements.emptyStateActionBtn.textContent = '📁 フォルダ一覧を開く';
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

  // 初期表示チャンク（先頭200枚）を即座に同期描画
  appendPhotoGridChunk(GRID_INITIAL_CHUNK);
  updateSelectionUI();

  // 大画面・極小サムネイル等でさらに画面内に入る余地がある場合は次フレームで補完
  if (renderedGridCount < state.photos.length) {
    renderGridTaskId = requestAnimationFrame(() => {
      renderGridTaskId = null;
      checkAndAppendGridChunksIfNeeded();
    });
  }
}

/**
 * 適用中フィルタチップバーの描画（各チップの✕で個別解除可能）
 */
function renderActiveFilterChips() {
  const container = document.getElementById('activeFilterChips');
  if (!container) return;
  container.innerHTML = '';

  let hasFilter = false;

  function createChip(icon, text, onRemove, extraClass = '') {
    hasFilter = true;
    const chip = document.createElement('span');
    chip.className = `filter-chip ${extraClass}`.trim();
    chip.innerHTML = `
      <span class="chip-label">${escapeHtml(icon)} ${escapeHtml(text)}</span>
      <button class="chip-remove-btn" title="このフィルタを解除">&times;</button>
    `;
    chip.querySelector('.chip-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
    container.appendChild(chip);
  }

  // 1. フォルダ
  if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
    const rawP = state.currentFilter.value;
    const name = rawP.split(/[/\\]/).filter(Boolean).pop() || rawP;
    createChip('📁', name, () => {
      setFilter('all', null, 'すべての写真');
    });
  } else if (state.currentFilter.type === 'folder_exclude' && state.currentFilter.value) {
    const rawP = state.currentFilter.value;
    const name = rawP.split(/[/\\]/).filter(Boolean).pop() || rawP;
    createChip('🚫', `除外: ${name}`, () => {
      setFilter('all', null, 'すべての写真');
    }, 'chip-tag-exclude');
  }

  // 2. タイムライン年月 (OR条件)
  if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
    Array.from(state.selectedYearMonths).sort().forEach(ym => {
      createChip('📅', ym, () => {
        toggleTimelineYearMonth(ym);
      });
    });
  }

  // 3. カメラ機種 (OR条件)
  if (state.selectedCameras && state.selectedCameras.size > 0) {
    Array.from(state.selectedCameras).sort().forEach(cam => {
      createChip('📷', cam, () => {
        toggleCameraFilter(cam);
      });
    });
  }

  // 4. タグ (3ステート)
  if (state.tagFilters && state.tagFilters.size > 0) {
    state.tagFilters.forEach((mode, tag) => {
      const prefix = mode === 'include' ? '+' : '−';
      const chipClass = mode === 'include' ? 'chip-tag-include' : 'chip-tag-exclude';
      createChip('🏷️', `${prefix}${tag}`, () => {
        removeTagFilter(tag);
      }, chipClass);
    });
  }

  // 5. 未分類
  if (state.untaggedOnly) {
    createChip('🏷️', '未分類', () => {
      clearAllTagFilters();
    });
  }

  // 6. 接続状態 (接続中 / 未接続)
  if (state.connectionFilter === 'online') {
    createChip('🟢', '接続中のみ', () => {
      setConnectionFilter('online');
    });
  } else if (state.connectionFilter === 'offline') {
    createChip('⚪', '未接続のみ', () => {
      setConnectionFilter('offline');
    });
  }

  // 7. ファイル名検索
  if (state.searchQuery && state.searchQuery.trim() !== '') {
    createChip('🔍', `"${state.searchQuery.trim()}"`, () => {
      elements.clearSearchBtn.click();
    });
  }

  // 8. 評価（レーティング: デフォルト[0, 1, 2]以外の場合）
  const isDefaultRating = (state.ratingFilter.size === 3 &&
    state.ratingFilter.has(0) && state.ratingFilter.has(1) && state.ratingFilter.has(2));
  if (!isDefaultRating) {
    const rNames = [];
    if (state.ratingFilter.has(2)) rNames.push('優');
    if (state.ratingFilter.has(1)) rNames.push('良');
    if (state.ratingFilter.has(0)) rNames.push('可');
    if (state.ratingFilter.has(-1)) rNames.push('棄');
    const rText = rNames.length > 0 ? rNames.join(',') : 'なし';
    createChip('⭐', `評価: ${rText}`, () => {
      state.ratingFilter = new Set([0, 1, 2]);
      updateRatingFilterUI();
      fetchPhotos();
    });
  }

  // 9. ジオタグツリーフィルタ
  if (state.activeLocation) {
    if (state.activeLocation.no_location) {
      createChip('🗺️', 'ジオタグなし', () => {
        if (typeof clearLocationFilter === 'function') clearLocationFilter();
      });
    } else {
      const locLabel = state.activeLocation.label || state.activeLocation.city || state.activeLocation.state || state.activeLocation.country;
      createChip('🗺️', `ジオタグ: ${locLabel}`, () => {
        if (typeof clearLocationFilter === 'function') clearLocationFilter();
      });
    }
  }

  // すべて解除ボタンとサイドバーリセットボタンの表示制御
  if (elements.clearFilterBtn) {
    elements.clearFilterBtn.style.display = hasFilter ? 'inline-flex' : 'none';
  }

  const resetBtn = document.getElementById('sidebarResetFilterBtn');
  const resetDot = document.getElementById('sidebarResetDot');
  if (resetBtn) {
    resetBtn.classList.toggle('has-active-filter', hasFilter);
  }
  if (resetDot) {
    resetDot.style.display = hasFilter ? 'block' : 'none';
  }
}

/**
 * サイドバーのリセットドット更新ヘルパー
 */
function updateSidebarResetDot() {
  renderActiveFilterChips();
}
window.updateSidebarResetDot = updateSidebarResetDot;
window.renderFilterChips = renderActiveFilterChips;
window.renderActiveFilterChips = renderActiveFilterChips;

/**
 * 評価フィルタトグル同期関数
 */
function updateRatingFilterUI() {
  document.querySelectorAll('.rating-filter-toggles .rating-toggle').forEach(btn => {
    const rv = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle('active', state.ratingFilter.has(rv));
  });
}

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
}

/**
 * 接続状態フィルタの切替（トグル）
 */
function setConnectionFilter(type) {
  if (state.connectionFilter === type) {
    state.connectionFilter = 'all';
    if (state.currentFilter.type === 'all') {
      elements.viewTitle.textContent = 'すべての写真';
    }
  } else {
    state.connectionFilter = type;
    if (type === 'online') {
      elements.viewTitle.textContent = '🟢 接続中の写真';
    } else if (type === 'offline') {
      elements.viewTitle.textContent = '⚪ 未接続の写真';
    } else if (type === 'unlinked' || type === 'missing') {
      elements.viewTitle.textContent = '🔗 リンク消失の写真（実体パス未登録）';
    } else if (type === 'duplicates') {
      elements.viewTitle.textContent = '📋 重複のある写真';
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

  state.searchQuery = '';
  if (elements.searchInput) elements.searchInput.value = '';
  if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = 'none';

  state.tagFilters.clear();
  state.selectedYearMonths.clear();
  state.selectedCameras.clear();
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

  // 適用中フィルタチップの描画
  renderActiveFilterChips();
  if (window.renderPresetCurrentChips) window.renderPresetCurrentChips();
}

function setFilter(type, value, titleText) {
  if (type !== 'year_month' && type !== 'year_months') {
    state.selectedYearMonths.clear();
  } else if (type === 'year_month' && value) {
    state.selectedYearMonths.clear();
    state.selectedYearMonths.add(value);
    const yr = value.split('-')[0];
    if (yr) state.expandedTimelineYears.add(yr);
  }

  if (type !== 'camera' && type !== 'cameras') {
    state.selectedCameras.clear();
  } else if (type === 'camera' && value) {
    state.selectedCameras.clear();
    state.selectedCameras.add(value);
  }

  // ジオタグフィルタのリセット（フォルダやクイックアクセス等への移動時）
  if (state.activeLocation) {
    state.activeLocation = null;
    if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();
  }

  if ((type === 'folder' || type === 'folder_exclude') && value) {
    revealFolderInTree(value);
  }

  state.currentFilter = { type, value };
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');
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

  updateTimelineActiveClasses();
  updateCameraActiveClasses();
  fetchPhotos();
}

/**
 * 指定写真を現在の一覧から除去する（評価フィルタ外になった写真用）。
 * グリッドは該当カードのみ削除し、選択状態・Shift範囲選択の起点・ライトボックス位置を補正する。
 */
function removePhotoFromView(photoId) {
  const photoIdx = state.photos.findIndex(p => p.id === photoId);
  if (photoIdx === -1) return;  // スタック展開中のメンバー等、一覧に無い写真は対象外
  state.photos.splice(photoIdx, 1);

  // 選択状態のクリーンアップ
  if (state.selectionBaseIds) state.selectionBaseIds.delete(photoId);
  if (state.selectedPhotoIds.has(photoId)) {
    state.selectedPhotoIds.delete(photoId);
    updateCardSelectionClasses();
    updateSelectionUI();
  }

  // Shift範囲選択の起点インデックスの補正
  if (state.lastSelectedIndex !== -1) {
    if (state.lastSelectedIndex === photoIdx) {
      state.lastSelectedIndex = -1;
    } else if (photoIdx < state.lastSelectedIndex) {
      state.lastSelectedIndex--;
    }
  }

  if (state.photos.length === 0) {
    // 0枚になった場合（空状態UI）は安全に全再描画する
    renderPhotoGrid();
  } else {
    if (photoIdx < renderedGridCount) {
      renderedGridCount = Math.max(0, renderedGridCount - 1);
    }
    // 該当カードのみDOMから削除し、以降のカードの dataset.index を振り直す
    const grid = elements.photoGrid || document.getElementById('photoGrid');
    const card = grid ? grid.querySelector(`.photo-card[data-photo-id="${photoId}"]`) : null;
    if (card) {
      let sibling = card.nextElementSibling;
      while (sibling) {
        if (sibling.classList && sibling.classList.contains('photo-card')) {
          const curIdx = parseInt(sibling.dataset.index, 10);
          if (!isNaN(curIdx)) sibling.dataset.index = curIdx - 1;
        }
        sibling = sibling.nextElementSibling;
      }
      card.remove();
    }
    checkAndAppendGridChunksIfNeeded();
  }

  // ヘッダー件数表示の更新
  updateViewHeader();

  // ライトボックス表示中なら currentPhotoIndex との整合を調整
  if (state.currentPhotoIndex >= 0) {
    if (state.photos.length === 0) {
      closeLightbox();
    } else if (photoIdx === state.currentPhotoIndex) {
      // 表示中の写真自体が除外された場合は次の写真（末尾なら直前の写真）を表示
      if (state.currentPhotoIndex >= state.photos.length) {
        state.currentPhotoIndex = state.photos.length - 1;
      }
      state.currentRotation = 0;
      resetLightboxZoom();
      loadLightboxPhoto();
      renderFilmstrip();
    } else {
      if (photoIdx < state.currentPhotoIndex) state.currentPhotoIndex--;
      renderFilmstrip();
    }
  }
}

/**
 * 評価の更新 (API送信)
 */
async function updatePhotoRating(photoId, newRating) {
  try {
    // ローカル状態の更新
    const target = state.photos.find(p => p.id === photoId);
    if (target) {
      target.rating = newRating;
    }

    // スタック内の該当写真オブジェクトも同期更新
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

    // プレビュー中ならライトボックス側の評価も更新
    const curLight = getCurrentLightboxPhoto();
    if (curLight && curLight.id === photoId) {
      curLight.rating = newRating;
      updateLightboxRating(newRating);
    }

    // インスペクタで表示中の写真なら、インスペクタ内の評価ボタンactive状態も即時更新
    if (state.activeInspectorPhotoId === photoId && elements.inspectorRatingBtns) {
      elements.inspectorRatingBtns.querySelectorAll('.rating-btn').forEach(b => {
        const bVal = parseInt(b.dataset.rating, 10);
        b.classList.toggle('active', bVal === newRating);
      });
    }

    // グリッド上の写真カードDOMを直接更新（超高速・チラつきなし）
    updateCardRatingDirectly(photoId, newRating);

    // 新しい評価が評価フィルタに含まれない場合（既定では「棄」）は、その写真だけを一覧から除去する。
    // フィルタに含まれる場合は上記のDOM部分更新のみで、グリッドの全再描画は行わない。
    const isFilteredOut = state.ratingFilter && state.ratingFilter.size > 0 && !state.ratingFilter.has(newRating);
    if (isFilteredOut) {
      removePhotoFromView(photoId);
    }

    const response = await fetch(`/api/photo/${photoId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: newRating }),
    });

    if (!response.ok) throw new Error('評価の更新に失敗しました');
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
  const resetBtn = document.getElementById('sidebarResetFilterBtn');
  const toggleAllBtn = document.getElementById('sidebarToggleAllBtn');
  if (!items.length || !sidebar) return;

  // 排他開閉状態の永続化キー（現在開いているセクション名、全閉じ時は null）
  const STORAGE_KEY = 'pm_accordion_active_section';
  let activeSection = 'quick'; // デフォルトはクイックアクセス

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      activeSection = saved || null;
    }
  } catch (e) {
    activeSection = 'quick';
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, activeSection || '');
    } catch (e) {}
  }

  function applyActiveSection() {
    items.forEach(item => {
      const sec = item.dataset.section;
      const isOpen = (sec === activeSection);
      item.classList.toggle('is-open', isOpen);
    });
    saveState();

    if (toggleAllBtn) {
      toggleAllBtn.title = activeSection ? '開いているメニューを閉じる' : 'クイックアクセスを開く';
    }

    // 検索セクションが開いた場合は入力欄にフォーカス
    if (activeSection === 'search' && elements.searchInput) {
      setTimeout(() => elements.searchInput.focus(), 100);
    }
    // クイックアクセス（プリセット統合）が開いた場合はチップ描画
    if ((activeSection === 'quick' || activeSection === 'presets') && window.renderPresetCurrentChips) {
      window.renderPresetCurrentChips();
    }
    // 場所セクションが開いた場合はツリーを最新化
    if (activeSection === 'location' && window.loadLocationTree) {
      window.loadLocationTree();
    }
  }

  function setSectionOpen(sectionName, isOpen) {
    if (isOpen) {
      activeSection = sectionName;
    } else if (activeSection === sectionName) {
      activeSection = null;
    }
    applyActiveSection();
  }

  function toggleSection(sectionName) {
    if (activeSection === sectionName) {
      // 既に開いているセクションをクリックした場合は閉じる（全折りたたみ可能）
      activeSection = null;
    } else {
      // 別のセクションをクリックした場合は他を閉じてこれだけ開く（排他制御）
      activeSection = sectionName;
    }
    applyActiveSection();
  }

  // 初期開閉状態を反映
  applyActiveSection();

  // 各セクションのヘッダークリックで排他開閉
  items.forEach(item => {
    const header = item.querySelector('.accordion-header');
    if (!header) return;
    header.addEventListener('click', (e) => {
      // 内部のアクションボタン・入力欄クリック時は開閉を防止
      if (e.target.closest('button') || e.target.closest('input')) {
        return;
      }
      const sectionName = item.dataset.section;
      if (sectionName) {
        toggleSection(sectionName);
      }
    });
  });

  // 開いているメニューを閉じるトグルボタン
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', () => {
      if (activeSection) {
        activeSection = null;
      } else {
        activeSection = 'quick';
      }
      applyActiveSection();
    });
  }

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
  window.isFilterDrawerOpen = () => true;
  window.switchSidebarTab = (tabName) => window.openSidebarSection(tabName);
}

/**
 * イベントリスナー設定
 */
function setupEventListeners() {
  // アコーディオン式サイドバーの初期化
  initSidebarAccordion();

  // 左サイドバー開閉ボタン
  if (elements.toggleSidebarBtn) {
    elements.toggleSidebarBtn.addEventListener('click', () => toggleSidebar());
  }
  if (elements.sidebarCloseBtn) {
    elements.sidebarCloseBtn.addEventListener('click', () => toggleSidebar(false));
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

  // ヘッダーツールバー＆下部選択バーの自動レスポンシブ（幅が狭まった際の段階的なアイコン化判定）
  const appHeader = document.querySelector('.app-header');
  const floatingBar = document.getElementById('selectionFloatingBar');
  if (appHeader && window.ResizeObserver) {
    const headerObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        appHeader.classList.toggle('toolbar-compact-1', w < 1550);
        appHeader.classList.toggle('toolbar-compact-2', w < 1350);
        appHeader.classList.toggle('toolbar-compact-3', w < 1150);
        if (floatingBar) {
          floatingBar.classList.toggle('floating-compact-1', w < 1150);
          floatingBar.classList.toggle('floating-compact-2', w < 860);
          floatingBar.classList.toggle('floating-compact-3', w < 640);
        }
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

  // フォルダツリーの再読込（ドライブの抜き差し後など）
  const reloadFolderTreeBtn = document.getElementById('reloadFolderTreeBtn');
  if (reloadFolderTreeBtn) {
    reloadFolderTreeBtn.addEventListener('click', () => {
      fetchFolders();
    });
  }

  // 表示レイアウト切替（グリッド / びっしり / マウント）
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

    // 現在選択中の写真があればそれに追加、なければ単にリストに反映
    if (state.photos.length > 0) {
      await fetch(`/api/photo/${state.photos[0].id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tagName }),
      });
    }
    elements.inlineTagCreate.style.display = 'none';
    elements.newTagNameInput.value = '';
    await fetchTags();
    await fetchPhotos();
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
    elements.viewTitle.textContent = '🏷️ 未分類の写真';

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

  // 絞り込み解除ボタン（タイトル横 ＆ サイドバータブ最下部リセットボタン）
  if (elements.clearFilterBtn) {
    elements.clearFilterBtn.addEventListener('click', resetAllFilters);
  }

  const sidebarResetFilterBtn = document.getElementById('sidebarResetFilterBtn');
  if (sidebarResetFilterBtn) {
    sidebarResetFilterBtn.addEventListener('click', resetAllFilters);
  }

  // 情報表示切替（詳細 / クリーン）
  elements.toggleInfoBtn.addEventListener('click', () => {
    toggleMinimalView();
  });



  // 写真ファイル選択ボタン & input
  elements.uploadFilesBtn.addEventListener('click', () => {
    elements.fileUploadInput.click();
  });

  elements.fileUploadInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await uploadPhotos(files);
      elements.fileUploadInput.value = '';
    }
  });

  // ドラッグ＆ドロップ アップロード処理
  let dragCounter = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    elements.dragDropOverlay.style.display = 'flex';
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      elements.dragDropOverlay.style.display = 'none';
      dragCounter = 0;
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    elements.dragDropOverlay.style.display = 'none';

    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      await uploadPhotos(e.dataTransfer.files);
    }
  });

  // サムネイルサイズスライダー
  elements.thumbnailSizeSlider.addEventListener('input', (e) => {
    const size = e.target.value;
    document.documentElement.style.setProperty('--thumbnail-size', `${size}px`);
    localStorage.setItem('pm_thumbnail_size', size);
    checkAndAppendGridChunksIfNeeded();
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

  // ソート順変更
  elements.sortBySelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    localStorage.setItem('pm_sort_by', state.sortBy);
    fetchPhotos();
  });

  // 評価フィルタトグルボタン（ヘッダー ＆ クイックタブ両方を一括監視・双方向同期）
  document.querySelectorAll('.rating-filter-toggles .rating-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const rv = parseInt(btn.dataset.rating, 10);
      toggleRatingFilter(rv);
      updateRatingFilterUI();
      fetchPhotos();
    });
  });

  if (elements.onlineOnlyNavItem) {
    elements.onlineOnlyNavItem.addEventListener('click', () => setConnectionFilter('online'));
  }
  if (elements.offlineOnlyNavItem) {
    elements.offlineOnlyNavItem.addEventListener('click', () => setConnectionFilter('offline'));
  }
  if (elements.unlinkedOnlyNavItem) {
    elements.unlinkedOnlyNavItem.addEventListener('click', () => setConnectionFilter('unlinked'));
  }
  if (elements.folderTreeUnlinkedItem) {
    elements.folderTreeUnlinkedItem.addEventListener('click', () => setConnectionFilter('unlinked'));
  }
  if (elements.duplicatesOnlyNavItem) {
    elements.duplicatesOnlyNavItem.addEventListener('click', () => setConnectionFilter('duplicates'));
  }

  // リンク消失写真の一括完全消去ボタン
  if (elements.purgeUnlinkedBtn) {
    elements.purgeUnlinkedBtn.addEventListener('click', async () => {
      const confirmed = confirm(
        '🗑️ リンク消失しているすべての写真レコード（サムネイル・タグ含む）をDBから完全に消去しますか？\n' +
        'この操作は取り消せません。'
      );
      if (!confirmed) return;

      try {
        const res = await fetch('/api/photos/purge-unlinked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '消去に失敗しました');
        showToast(`🗑️ ${data.purged}枚の写真レコードを完全に消去しました`, 'success');
        setConnectionFilter('all');
        await refreshAll();
      } catch (err) {
        showToast('消去エラー: ' + err.message, 'error');
      }
    });
  }

  // サイドバーのクイックアクセス（すべての写真）
  document.querySelectorAll('.sidebar [data-filter-type="all"]').forEach(el => {
    el.addEventListener('click', () => {
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
  // 1. 直下のみ再スキャン
  if (elements.folderMenuRescanDirect) {
    elements.folderMenuRescanDirect.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing) {
        showToast('⚠️ 実フォルダが存在しないか、ドライブが未接続のため再スキャンできません', 'warning');
        return;
      }
      showToast(`🔄 「${node.name}」の直下を再スキャン中...`, 'info');
      await executeScan(node.fullPath, false, false);
    });
  }

  // 2. 配下も含めて再スキャン
  if (elements.folderMenuRescanRecursive) {
    elements.folderMenuRescanRecursive.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing) {
        showToast('⚠️ 実フォルダが存在しないか、ドライブが未接続のため再スキャンできません', 'warning');
        return;
      }
      // ドライブ全体やルート種別の場合は警告ダイアログを表示
      const isDriveRoot = /^[a-zA-Z]:\\?$/.test(node.fullPath);
      if (isDriveRoot) {
        const msg = `「${node.name}」はドライブ全体です。配下のすべてのサブフォルダをスキャンすると時間がかかる場合があります。\n\nスキャンを開始しますか？`;
        if (!confirm(msg)) return;
      }
      showToast(`🔄 「${node.name}」配下を再帰スキャン中...`, 'info');
      await executeScan(node.fullPath, true, false);
    });
  }

  // 2-B. ♻️ リフレッシュ（再スキャン＋消失写真のDB削除・配下含む）
  if (elements.folderMenuRefresh) {
    elements.folderMenuRefresh.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing || node.isOffline) {
        showToast('⚠️ ドライブが未接続または実フォルダが存在しないためリフレッシュできません', 'warning');
        return;
      }
      const msg = `フォルダ「${node.name}」内の写真フォルダを再スキャンし、PC上から移動・削除された写真をライブラリから削除（リフレッシュ）します。\n\nよろしいですか？`;
      if (!confirm(msg)) return;

      showToast(`♻️ 「${node.name}」をリフレッシュ中（消失写真のDB整理を含む）...`, 'info');
      await executeScan(node.fullPath, true, true);
    });
  }

  // 2-C. 🤖 AIタグ付け
  if (elements.folderMenuAiTag) {
    elements.folderMenuAiTag.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      const msg = `フォルダ「${node.name}」配下の写真にAIタグを付与しますか？\n（※すでにタグ付け済みの写真はスキップされます）`;
      if (!confirm(msg)) return;

      try {
        showToast(`🤖 「${node.name}」のAIタグ付けを開始しました...`, 'info');
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

  // 3. 管理から外す（DB解除）※未接続フォルダでも解除可能
  if (elements.folderMenuUnmanage) {
    elements.folderMenuUnmanage.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      const isRootKind = (node.kind === 'drive' || node.kind === 'shortcut' || node.kind === 'offline');
      const count = node.totalCount > 0 ? node.totalCount : node.count;
      const msg = `${isRootKind ? 'ドライブ' : 'フォルダ'}「${node.name}」（写真 ${count}枚）をライブラリから除外しますか？\n\n（※PC上の実ファイル本体は削除されません）`;
      if (!confirm(msg)) return;

      try {
        const res = await fetch('/api/folders', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath, recursive: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '除外に失敗しました');

        showToast(`🗑️ 「${node.name}」を管理から外しました (${data.deleted_count}枚解除)`, 'info');
        await refreshAll();
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

    const msg = `フォルダ「${node.name}」を管理対象外（除外）に設定しますか？\n\n・ライブラリから登録解除されます\n・今後、親フォルダを再スキャンしても自動登録されなくなります\n（※PC上の実ファイル本体は削除されません）`;
    if (!confirm(msg)) return;

    try {
      const res = await fetch('/api/folders/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: node.fullPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '除外設定に失敗しました');

      showToast(`🚫 「${node.name}」を管理対象外に設定しました`, 'info');
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

        showToast(`↩️ 「${node.name}」の除外を解除しました`, 'success');
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
      showToast('⚠️ 実フォルダが存在しないか、ドライブが未接続のためスキャンできません', 'warning');
      return;
    }

    showToast(`➕ 「${node.name}」を管理に追加・スキャン中...`, 'info');
    await executeScan(node.fullPath, false, false);
  };
  if (elements.folderMenuAddAndScan) {
    elements.folderMenuAddAndScan.addEventListener('click', handleAddAndScan);
  }
  if (elements.folderMenuAddFromIgnored) {
    elements.folderMenuAddFromIgnored.addEventListener('click', handleAddAndScan);
  }

  // 7. エクスプローラーで開く
  if (elements.folderMenuOpenExplorer) {
    elements.folderMenuOpenExplorer.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing) {
        showToast('⚠️ 実フォルダが存在しないか、ドライブが未接続のためエクスプローラーで開けません', 'warning');
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
        showToast('📁 フォルダを開きました', 'info', 2000);
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 8. メインエリア警告バナーの再確認ボタン
  if (elements.warningBannerReloadBtn) {
    elements.warningBannerReloadBtn.addEventListener('click', async () => {
      showToast('🔄 ドライブ・フォルダの接続状態を確認中...', 'info');
      try {
        await fetchFolders();
        if (state.currentFilter.type === 'folder') {
          await fetchPhotos();
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

    // スマートテイクアウトモーダル表示中
    const smartTakeoutEl = document.getElementById('smartTakeoutModal');
    if (smartTakeoutEl && smartTakeoutEl.style.display !== 'none') {
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

    // Esc でドロワーまたは選択解除 (プレビュー外)
    if (e.key === 'Escape' && state.currentPhotoIndex === -1) {
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

    // ライトボックス表示中のショートカット
    if (state.currentPhotoIndex >= 0) {
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigatePhoto(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
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
      } else if (e.key === 'r' || e.key === 'R') {
        // Rキーで時計回りに90度回転
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(current.id, 90);
        }
      } else if (e.key === 'l' || e.key === 'L') {
        // Lキーで反時計回りに90度回転
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(current.id, -90);
        }
      } else if (e.key === 'c' || e.key === 'C') {
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
      if (e.key === ' ' || e.key === 'Enter') {
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
      } else if (e.key === 'i' || e.key === 'I') {
        // i キーで情報表示ON/OFFトグル
        toggleMinimalView();
      } else if (e.key === 'r' || e.key === 'R') {
        // Rキーで選択写真を時計回りに90度回転
        e.preventDefault();
        const ids = Array.from(state.selectedPhotoIds);
        if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
          window.batchRotatePhotosQuick(ids, 90);
        } else if (state.activeInspectorPhotoId && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(state.activeInspectorPhotoId, 90);
        }
      } else if (e.key === 'l' || e.key === 'L') {
        // Lキーで選択写真を反時計回りに90度回転
        e.preventDefault();
        const ids = Array.from(state.selectedPhotoIds);
        if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
          window.batchRotatePhotosQuick(ids, -90);
        } else if (state.activeInspectorPhotoId && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(state.activeInspectorPhotoId, -90);
        }
      } else if (e.key === 'c' || e.key === 'C') {
        // Cキーで選択写真（またはアクティブ写真）のクロップ・画像調整モーダルを開く
        e.preventDefault();
        let targetPhoto = null;
        if (state.selectedPhotoIds.size > 0) {
          const firstId = Array.from(state.selectedPhotoIds)[0];
          targetPhoto = state.photos.find(p => p.id === firstId);
        } else if (state.activeInspectorPhotoId) {
          targetPhoto = state.photos.find(p => p.id === state.activeInspectorPhotoId);
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

  // フィルムストリップのインタラクション初期化（ホイール横スクロール & ドラッグスクロール）
  initFilmstripInteractions();

  // ライトボックスのズーム＆パン操作（ホイール・ドラッグ・ダブルクリック）初期化
  initLightboxZoomInteractions();
}

let _zoomBadgeTimer = null;

/**
 * ズーム倍率バッジの表示

 */
function setupPhotoGridDelegation() {
  if (!elements.photoGrid) return;

  // 1. クリックイベントの委譲
  elements.photoGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;

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
      // 単一選択
      state.selectedPhotoIds.clear();
      state.selectedPhotoIds.add(photo.id);
      state.lastSelectedIndex = index;
      state.selectionBaseIds = null;
      clearShiftPreview();
      state.activeInspectorPhotoId = photo.id;
      updateCardSelectionClasses();
      updateSelectionUI();

      if (state.isInspectorOpen) {
        updateInspectorView();
      }
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
    state.selectedPhotoIds.clear();
    state.selectedPhotoIds.add(photo.id);
    state.lastSelectedIndex = index;
    state.activeInspectorPhotoId = photo.id;
    updateCardSelectionClasses();
    updateSelectionUI();

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

  // ボタンのアクティブ更新
  elements.modeButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
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
  checkAndAppendGridChunksIfNeeded();
}

/**
 * ファイルアップロード処理 (ドラッグ＆ドロップまたはファイル選択: Base64方式)
 */
async function uploadPhotos(fileList) {
  const validFiles = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (validFiles.length === 0) {
    alert('画像ファイル（JPEG, PNG, WebP等）が選択されていません');
    return;
  }

  try {
    elements.uploadFilesBtn.disabled = true;
    elements.uploadFilesBtn.textContent = '取り込み中...';

    // 各ファイルをBase64に変換
    const readAsBase64 = (file) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ filename: file.name, content_base64: reader.result });
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
      });
    };

    const payloadFiles = await Promise.all(validFiles.map(readAsBase64));

    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: payloadFiles }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || '取り込み失敗');

    console.log(`[UPLOAD] ${data.uploaded_count}枚の写真を取り込みました`);
    showToast(`📥 ${data.uploaded_count}枚の写真を取り込みました`, 'success', 3500);
    await refreshAll();
  } catch (err) {
    showToast(`取り込みエラー: ${err.message}`, 'error');
  } finally {
    elements.uploadFilesBtn.disabled = false;
    elements.uploadFilesBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      <span class="btn-label">取り込み</span>
    `;
  }
}

let _diffChecking = false;

/**
 * フォルダ選択時にバックグラウンドで差分または管理状態を高速判定し、
 * 未登録フォルダなら登録確認、管理下フォルダで変更があれば段階的リフレッシュを提案する
 */
async function checkAndPromptFolderRefresh(folderPath, folderName, node) {
  if (!folderPath || _diffChecking) return;
  _diffChecking = true;
  try {
    const res = await fetch('/api/folders/check-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
    });
    if (!res.ok) return;
    const diff = await res.json();
    if (!diff.is_valid) return;

    const name = folderName || folderPath;

    // 【ケース1: 管理外フォルダをクリックした場合 (v2.02: 子フォルダ含む/直下のみ/キャンセル 3段階選択)】
    if (!diff.is_managed) {
      // ドライブ全体（C:\ など）やショートカット、除外設定フォルダなら登録確認はスキップ
      if (node && (node.kind === 'drive' || node.status === 'ignored')) return;
      if (/^[a-zA-Z]:\\?$/.test(folderPath)) return;

      const choice = typeof showRegisterFolderModal === 'function'
        ? await showRegisterFolderModal(folderPath, name, diff.total_disk || 0)
        : (confirm(`管理外のフォルダです。管理フォルダとして登録しますか？`) ? 'direct' : null);

      if (!choice) return;

      const isRecursive = choice === 'recursive';
      const rangeText = isRecursive ? '（子フォルダ含む）' : '（直下のみ）';
      showToast(`📂 「${name}」を管理フォルダとして登録・スキャン中${rangeText}...`, 'info');
      await executeScan(folderPath, isRecursive, false);
      return;
    }

    // 【ケース2: 管理下フォルダをクリックした場合（差分がある場合のみ更新提案）】
    if (!diff.has_changes) return;

    // 第1ダイアログ: リフレッシュ提案
    const changeDetails = [];
    if (diff.added > 0) changeDetails.push(`新規追加: ${diff.added}枚`);
    if (diff.deleted > 0) changeDetails.push(`削除・消失: ${diff.deleted}枚`);
    if (diff.modified > 0) changeDetails.push(`変更: ${diff.modified}枚`);
    const detailText = changeDetails.length > 0 ? `\n（${changeDetails.join(' / ')}）` : '';

    const msg1 = `フォルダ「${name}」の内容が更新された可能性があります。${detailText}\n\nライブラリをリフレッシュ（最新化）しますか？`;
    if (!confirm(msg1)) return;

    showToast(`♻️ 「${name}」の変更を取り込み中...`, 'info');
    // 直下の差分スキャン（cleanupなしで安全に取り込み）
    await executeScan(folderPath, false, false);

    if (diff.added > 0) {
      showToast(`✅ ${diff.added}枚の写真が新しく追加されました`, 'success');
    }

    // もし削除（見つからない写真）がある場合: 第2ダイアログでリンク解除（リンク消失）確認
    if (diff.deleted > 0) {
      setTimeout(async () => {
        const msg2 = `🔗 フォルダ「${name}」内に実体ファイルが見つからない写真が ${diff.deleted}枚 あります。\n\n実体へのパス紐付けを解除（リンク消失）しますか？\n※写真のサムネイルやタグ、評価は保持されます。\n※後からクイックアクセスやフォルダツリーの「🔗 リンク消失の写真」で確認・完全消去が可能です。\n（「キャンセル」を押すと、パスの紐付けをそのまま残します）`;
        if (confirm(msg2)) {
          try {
            const cleanRes = await fetch('/api/folders/unlink-missing', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder_path: folderPath, recursive: false }),
            });
            const cleanData = await cleanRes.json();
            showToast(`🔗 ${cleanData.unlinked || diff.deleted}枚の写真のリンクを解除しました（サムネイル・タグは保持）`, 'success');
            await fetchPhotos();
            await refreshFolderTree();
            if (typeof fetchUnlinkedCount === 'function') fetchUnlinkedCount();
          } catch (err) {
            showToast(`リンク解除エラー: ${err.message}`, 'error');
          }
        }
      }, 500);
    }
  } catch (err) {
    console.warn('[WARN] checkAndPromptFolderRefresh エラー:', err);
  } finally {
    _diffChecking = false;
  }
}
window.checkAndPromptFolderRefresh = checkAndPromptFolderRefresh;

// 起動実行
document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  if (typeof initPaneResize === 'function') initPaneResize();
  if (typeof initSelectionEvents === 'function') initSelectionEvents();
  if (typeof initInspectorEvents === 'function') initInspectorEvents();
  if (typeof initLightboxEvents === 'function') initLightboxEvents();
  if (typeof initScannerModalEvents === 'function') initScannerModalEvents();
  if (typeof initLocationTree === 'function') initLocationTree();
});
