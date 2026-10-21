/**
 * Photo Manager - サイドバーツリー＆フィルタ管理モジュール (sidebar_filters.js)
 * タイムライン（年月ツリー）、カメラ＆レンズ階層ツリー（[+]/[-]排他検索）、
 * フォルダ階層データ構築、階層タグツリー・12色カラーパレット管理を担当する。
 */

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

  // カメラ・レンズ・フォルダ選択を確実にリセット（排他化）
  if ((state.selectedCameras && state.selectedCameras.size > 0) ||
      (state.cameraFilters && state.cameraFilters.size > 0) ||
      (state.lensFilters && state.lensFilters.size > 0) ||
      (state.selectedLenses && state.selectedLenses.size > 0)) {
    state.selectedCameras.clear();
    if (state.cameraFilters) state.cameraFilters.clear();
    if (state.lensFilters) state.lensFilters.clear();
    if (state.selectedLenses) state.selectedLenses.clear();
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
  const hasCamOrLens = (state.selectedCameras && state.selectedCameras.size > 0) ||
    (state.cameraFilters && state.cameraFilters.size > 0) ||
    (state.lensFilters && state.lensFilters.size > 0);

  // 「すべての写真」のアクティブ表示切替
  document.querySelectorAll('.sidebar [data-filter-type="all"]').forEach(el => {
    if (!hasSelection && state.currentFilter.type === 'all' && !hasCamOrLens) {
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
 * カメラツリー操作ツールバー（再読み込み・全展開・全折りたたみ）のイベント登録
 */
function initCameraToolbarEvents() {
  const reloadBtn = document.getElementById('reloadCameraTreeBtn');
  if (reloadBtn && !reloadBtn.dataset.bound) {
    reloadBtn.dataset.bound = '1';
    reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fetchCameras();
    });
  }

  const expandBtn = document.getElementById('expandAllCamerasBtn');
  if (expandBtn && !expandBtn.dataset.bound) {
    expandBtn.dataset.bound = '1';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.expandedCameras) state.expandedCameras = new Set();
      (state.availableCameras || []).forEach(item => {
        if (item.lenses && item.lenses.length > 0) {
          state.expandedCameras.add(item.camera_model);
        }
      });
      renderCameras(state.availableCameras);
    });
  }

  const collapseBtn = document.getElementById('collapseAllCamerasBtn');
  if (collapseBtn && !collapseBtn.dataset.bound) {
    collapseBtn.dataset.bound = '1';
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.expandedCameras) state.expandedCameras.clear();
      renderCameras(state.availableCameras);
    });
  }
}

/**
 * カメラ機種・レンズ階層情報の取得と描画
 */
async function fetchCameras() {
  initCameraToolbarEvents();
  try {
    const response = await fetch('/api/cameras');
    if (!response.ok) throw new Error('カメラ一覧取得失敗');
    const data = await response.json();
    state.availableCameras = data.cameras || [];
    renderCameras(state.availableCameras);
  } catch (error) {
    console.error('カメラ一覧読み込みエラー:', error);
  }
}

/**
 * カメラ機種＆レンズ2階層ツリーの描画 (3ステート排他選択対応)
 */
function renderCameras(cameraItems) {
  initCameraToolbarEvents();
  if (!elements.cameraList) return;

  if (!cameraItems || cameraItems.length === 0) {
    elements.cameraList.innerHTML = '<li class="empty-hint">カメラ情報なし</li>';
    return;
  }

  if (!state.expandedCameras) state.expandedCameras = new Set();
  if (!state.cameraFilters) state.cameraFilters = new Map();
  if (!state.lensFilters) state.lensFilters = new Map();

  elements.cameraList.innerHTML = '';
  cameraItems.forEach(item => {
    const camModel = item.camera_model;
    const lenses = Array.isArray(item.lenses) ? item.lenses : [];
    const hasLenses = lenses.length > 0;

    // 子レンズにフィルタが適用されているかチェック
    const hasActiveChildLens = lenses.some(l => state.lensFilters.has(`${camModel}::${l.lens_model}`));
    const isExpanded = state.expandedCameras.has(camModel) || hasActiveChildLens;

    const groupLi = document.createElement('li');
    groupLi.className = 'camera-tree-group';
    groupLi.dataset.cameraGroup = camModel;

    const camMode = state.cameraFilters.get(camModel) || (state.selectedCameras.has(camModel) ? 'include' : null);
    const rowDiv = document.createElement('div');
    rowDiv.className = 'nav-item camera-tree-item';
    if (camMode === 'include') rowDiv.classList.add('active', 'include');
    else if (camMode === 'exclude') rowDiv.classList.add('exclude');
    rowDiv.dataset.filterType = 'camera';
    rowDiv.dataset.filterValue = camModel;
    rowDiv.dataset.camera = camModel;

    const badgeText = camMode === 'include' ? '[+]' : (camMode === 'exclude' ? '[-]' : '');
    const expanderChar = hasLenses ? (isExpanded ? '▼' : '▶') : '•';

    rowDiv.innerHTML = `
      <span class="camera-tree-expander ${hasLenses ? '' : 'empty'}" data-camera="${escapeHtml(camModel)}" title="${hasLenses ? 'レンズ一覧を展開/折りたたみ' : ''}">${expanderChar}</span>
      <span class="nav-icon">📷</span>
      <span class="nav-text" title="${escapeHtml(camModel)}">${escapeHtml(camModel)}</span>
      <span class="camera-state-badge">${badgeText}</span>
      <span class="nav-count">${item.count}</span>
    `;

    // エキスパンダ矢印のクリック（フィルタを発火させずに子レンズ一覧を開閉）
    const expanderEl = rowDiv.querySelector('.camera-tree-expander');
    if (expanderEl && hasLenses) {
      expanderEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const subList = groupLi.querySelector('.camera-lens-sublist');
        const currentlyExpanded = state.expandedCameras.has(camModel) || (subList && subList.style.display !== 'none');
        if (currentlyExpanded) {
          state.expandedCameras.delete(camModel);
          if (subList) subList.style.display = 'none';
          expanderEl.textContent = '▶';
        } else {
          state.expandedCameras.add(camModel);
          if (subList) subList.style.display = 'block';
          expanderEl.textContent = '▼';
        }
      });
    }

    // カメラ親行クリックで3ステート遷移 (解除 -> [+]含む -> [-]除外 -> 解除)
    rowDiv.addEventListener('click', (e) => {
      if (e.target.closest('.camera-tree-expander') && hasLenses) return;
      toggleCameraFilter(camModel);
    });

    groupLi.appendChild(rowDiv);

    // 子レンズ一覧の構築
    if (hasLenses) {
      const subUl = document.createElement('ul');
      subUl.className = 'camera-lens-sublist';
      subUl.style.display = isExpanded ? 'block' : 'none';

      lenses.forEach(lens => {
        const lensModel = lens.lens_model;
        const lensLabel = lens.label || lensModel;
        const lensKey = `${camModel}::${lensModel}`;
        const lensMode = state.lensFilters.get(lensKey) || state.lensFilters.get(lensModel) || null;
        const lensBadge = lensMode === 'include' ? '[+]' : (lensMode === 'exclude' ? '[-]' : '');

        const lensLi = document.createElement('li');
        lensLi.className = 'nav-item camera-lens-item';
        if (lensMode === 'include') lensLi.classList.add('active', 'include');
        else if (lensMode === 'exclude') lensLi.classList.add('exclude');
        lensLi.dataset.lensKey = lensKey;
        lensLi.dataset.camera = camModel;
        lensLi.dataset.lens = lensModel;
        lensLi.dataset.lensLabel = lensLabel;

        lensLi.innerHTML = `
          <span class="lens-tree-icon">🔭</span>
          <span class="nav-text lens-nav-text" title="${escapeHtml(camModel)} / ${escapeHtml(lensModel)}">${escapeHtml(lensLabel)}</span>
          <span class="camera-state-badge">${lensBadge}</span>
          <span class="nav-count">${lens.count}</span>
        `;

        lensLi.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleLensFilter(lensKey, lensLabel);
        });

        subUl.appendChild(lensLi);
      });

      groupLi.appendChild(subUl);
    }

    elements.cameraList.appendChild(groupLi);
  });

  updateCameraActiveClasses();
}

/**
 * カメラ・レンズフィルタ状態から selectedCameras / selectedLenses およびビュータイトルを同期する内部ヘルパー
 */
function syncCameraAndLensFilterTitle() {
  state.selectedCameras.clear();
  if (state.cameraFilters) {
    state.cameraFilters.forEach((mode, cam) => {
      if (mode === 'include') state.selectedCameras.add(cam);
    });
  }

  state.selectedLenses.clear();
  if (state.lensFilters) {
    state.lensFilters.forEach((mode, key) => {
      if (mode === 'include') state.selectedLenses.add(key);
    });
  }

  state.untaggedOnly = false;
  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');

  // タイムライン・フォルダ選択をリセット
  if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
    state.selectedYearMonths.clear();
    updateTimelineActiveClasses();
  }
  if (elements.folderList) {
    elements.folderList.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  }

  const camCount = state.cameraFilters ? state.cameraFilters.size : 0;
  const lensCount = state.lensFilters ? state.lensFilters.size : 0;

  if (camCount === 0 && lensCount === 0) {
    if (state.currentFilter.type === 'cameras' || state.currentFilter.type === 'camera') {
      state.currentFilter = { type: 'all', value: null };
      elements.viewTitle.textContent = 'すべての写真';
    }
  } else if (lensCount === 1 && camCount === 0) {
    const [lensKey, mode] = Array.from(state.lensFilters.entries())[0];
    const displayName = lensKey.includes('::') ? lensKey.split('::')[1] : lensKey;
    state.currentFilter = { type: 'cameras', value: [lensKey] };
    elements.viewTitle.textContent = mode === 'exclude' ? `🔭 除外: ${displayName}` : `🔭 ${displayName}`;
  } else if (camCount === 1 && lensCount === 0) {
    const [singleCam, mode] = Array.from(state.cameraFilters.entries())[0];
    state.currentFilter = { type: 'camera', value: mode === 'include' ? singleCam : null };
    elements.viewTitle.textContent = mode === 'exclude' ? `📷 除外: ${singleCam}` : `📷 ${singleCam}`;
  } else {
    state.currentFilter = { type: 'cameras', value: Array.from(state.selectedCameras) };
    elements.viewTitle.textContent = `📷 カメラ・レンズ絞り込み (${camCount + lensCount}件)`;
  }

  updateCameraActiveClasses();
  fetchPhotos();
}

/**
 * カメラ機種の3ステートトグル選択処理 (解除 -> [+]含む -> [-]除外 -> 解除)
 */
function toggleCameraFilter(cameraModel, forceRemove = false) {
  if (!state.cameraFilters) state.cameraFilters = new Map();
  const current = state.cameraFilters.get(cameraModel) || (state.selectedCameras.has(cameraModel) ? 'include' : null);

  if (forceRemove) {
    state.cameraFilters.delete(cameraModel);
  } else if (!current) {
    state.cameraFilters.set(cameraModel, 'include');
  } else if (current === 'include') {
    state.cameraFilters.set(cameraModel, 'exclude');
  } else {
    state.cameraFilters.delete(cameraModel);
  }

  syncCameraAndLensFilterTitle();
}

/**
 * レンズの3ステートトグル選択処理 (解除 -> [+]含む -> [-]除外 -> 解除)
 */
function toggleLensFilter(lensKey, label, forceRemove = false) {
  if (!state.lensFilters) state.lensFilters = new Map();
  const current = state.lensFilters.get(lensKey) || null;

  if (forceRemove) {
    state.lensFilters.delete(lensKey);
  } else if (!current) {
    state.lensFilters.set(lensKey, 'include');
  } else if (current === 'include') {
    state.lensFilters.set(lensKey, 'exclude');
  } else {
    state.lensFilters.delete(lensKey);
  }

  syncCameraAndLensFilterTitle();
}

/**
 * 外部モジュール（ラボの勝ちレンズカルテ等）から特定レンズで一発抽出するグローバル関数
 */
function selectLensFilter(filterKey, label) {
  if (!filterKey) return;
  if (!state.cameraFilters) state.cameraFilters = new Map();
  if (!state.lensFilters) state.lensFilters = new Map();
  if (!state.expandedCameras) state.expandedCameras = new Set();

  state.cameraFilters.clear();
  state.selectedCameras.clear();
  state.lensFilters.clear();
  state.selectedLenses.clear();

  state.lensFilters.set(filterKey, 'include');
  state.selectedLenses.add(filterKey);

  if (filterKey.includes('::')) {
    const camModel = filterKey.split('::')[0];
    if (camModel) state.expandedCameras.add(camModel);
  }

  renderCameras(state.availableCameras);
  syncCameraAndLensFilterTitle();
  if (label && elements.viewTitle) {
    elements.viewTitle.textContent = `🔭 ${label}`;
  }
}
window.selectLensFilter = selectLensFilter;
window.renderCameras = renderCameras;

/**
 * カメラ・レンズツリーのアクティブ表示（include / exclude クラスとバッジ）およびアコーディオン状態更新
 */
function updateCameraActiveClasses() {
  const camAccordion = document.getElementById('accordionItem-camera');
  const hasCamFilter = Boolean(
    (state.cameraFilters && state.cameraFilters.size > 0) ||
    (state.lensFilters && state.lensFilters.size > 0) ||
    (state.selectedCameras && state.selectedCameras.size > 0)
  );
  if (camAccordion) {
    camAccordion.classList.toggle('has-filter', hasCamFilter);
  }

  if (!elements.cameraList) return;

  // カメラ親行の更新
  elements.cameraList.querySelectorAll('.camera-tree-item').forEach(el => {
    const cam = el.dataset.camera || el.dataset.filterValue;
    const mode = (state.cameraFilters && state.cameraFilters.get(cam)) ||
      (state.selectedCameras && state.selectedCameras.has(cam) ? 'include' : null);
    el.classList.toggle('active', mode === 'include');
    el.classList.toggle('include', mode === 'include');
    el.classList.toggle('exclude', mode === 'exclude');
    const badge = el.querySelector('.camera-state-badge');
    if (badge) {
      badge.textContent = mode === 'include' ? '[+]' : (mode === 'exclude' ? '[-]' : '');
    }
  });

  // 子レンズ行の更新
  elements.cameraList.querySelectorAll('.camera-lens-item').forEach(el => {
    const lensKey = el.dataset.lensKey;
    const lensModel = el.dataset.lens;
    const mode = (state.lensFilters && (state.lensFilters.get(lensKey) || state.lensFilters.get(lensModel))) || null;
    el.classList.toggle('active', mode === 'include');
    el.classList.toggle('include', mode === 'include');
    el.classList.toggle('exclude', mode === 'exclude');
    const badge = el.querySelector('.camera-state-badge');
    if (badge) {
      badge.textContent = mode === 'include' ? '[+]' : (mode === 'exclude' ? '[-]' : '');
    }
  });
}
window.updateCameraActiveClasses = updateCameraActiveClasses;

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

