/**
 * 場所（国・都道府県・市区町村）ツリー管理モジュール (location_tree.js)
 * 左ペインのアコーディオン「🗺️ 場所」の階層ツリー描画、展開/折りたたみ、クリック絞り込みを制御する。
 */

// 展開状態のパス（Set: "country", "country/state"）
const locationExpandedPaths = new Set();

/**
 * 場所ツリーの初期化
 */
function initLocationTree() {
  const reloadBtn = document.getElementById('reloadLocationTreeBtn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadLocationTree();
    });
  }

  const expandBtn = document.getElementById('expandAllLocationsBtn');
  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      expandAllLocations();
    });
  }

  const collapseBtn = document.getElementById('collapseAllLocationsBtn');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapseAllLocations();
    });
  }

  const noLocItem = document.getElementById('noLocationNavItem');
  if (noLocItem) {
    noLocItem.addEventListener('click', () => {
      toggleNoLocationFilter();
    });
  }
}

/**
 * サーバーから場所ツリーデータを取得してDOMを構築する
 */
async function loadLocationTree() {
  const treeContainer = document.getElementById('locationTree');
  if (!treeContainer) return;

  try {
    const res = await fetch('/api/locations/tree');
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();

    const tree = data.tree || [];
    const noLocCount = data.no_location_count || 0;

    // 位置情報なしバッジの更新
    const noLocBadge = document.getElementById('noLocationCountBadge');
    if (noLocBadge) {
      noLocBadge.textContent = noLocCount.toLocaleString();
    }
    const noLocSection = document.getElementById('locationTreeNoGpsSection');
    if (noLocSection) {
      noLocSection.style.display = noLocCount > 0 ? '' : 'none';
    }

    if (tree.length === 0) {
      treeContainer.innerHTML = '<li class="empty-hint">ジオタグ付きの写真がありません</li>';
      return;
    }

    // 初回ロード時: 最も写真枚数が多い国（通常は日本）をデフォルト展開
    if (locationExpandedPaths.size === 0 && tree.length > 0) {
      locationExpandedPaths.add(tree[0].country);
    }

    renderLocationTree(tree);
  } catch (err) {
    console.error('ジオタグツリー取得エラー:', err);
    treeContainer.innerHTML = '<li class="empty-hint">ジオタグ情報の読み込みに失敗しました</li>';
  }
}

/**
 * 場所ツリーのDOMレンダリング
 */
function renderLocationTree(tree) {
  const treeContainer = document.getElementById('locationTree');
  if (!treeContainer) return;

  treeContainer.innerHTML = '';

  tree.forEach(country => {
    const countryLi = createCountryNode(country);
    treeContainer.appendChild(countryLi);
  });

  updateLocationTreeActiveState();
}

/**
 * 国ノードの生成
 */
function createCountryNode(country) {
  const li = document.createElement('li');
  li.className = 'location-tree-node location-country-node';
  const cPath = country.country;
  li.dataset.locationPath = cPath;

  const isExpanded = locationExpandedPaths.has(cPath);

  const row = document.createElement('div');
  row.className = 'location-node-row';

  // 矢印（子要素がある場合）
  const hasStates = country.states && country.states.length > 0;
  const toggle = document.createElement('span');
  toggle.className = `location-node-toggle ${isExpanded ? 'is-expanded' : ''}`;
  toggle.textContent = hasStates ? (isExpanded ? '▼' : '▶') : '•';
  if (hasStates) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (locationExpandedPaths.has(cPath)) {
        locationExpandedPaths.delete(cPath);
      } else {
        locationExpandedPaths.add(cPath);
      }
      loadLocationTree();
    });
  }
  row.appendChild(toggle);

  // 国フラグアイコン（国名に応じて絵文字）
  const icon = document.createElement('span');
  icon.className = 'location-node-icon';
  icon.textContent = getCountryEmoji(country.country);
  row.appendChild(icon);

  // 国名テキスト
  const nameSpan = document.createElement('span');
  nameSpan.className = 'location-node-name';
  nameSpan.textContent = country.country;
  row.appendChild(nameSpan);

  // 写真枚数
  const countBadge = document.createElement('span');
  countBadge.className = 'location-node-count';
  countBadge.textContent = country.count.toLocaleString();
  row.appendChild(countBadge);

  // クリックで国全体絞り込み
  row.addEventListener('click', () => {
    selectLocationFilter({
      country: country.country,
      state: null,
      city: null,
      label: country.country,
    });
  });

  li.appendChild(row);

  // 都道府県リスト（展開時のみ）
  if (hasStates && isExpanded) {
    const subUl = document.createElement('ul');
    subUl.className = 'location-sub-tree';
    country.states.forEach(st => {
      const stateLi = createStateNode(country.country, st);
      subUl.appendChild(stateLi);
    });
    li.appendChild(subUl);
  }

  return li;
}

/**
 * 都道府県（州）ノードの生成
 */
function createStateNode(countryName, state) {
  const li = document.createElement('li');
  li.className = 'location-tree-node location-state-node';
  const sPath = `${countryName}/${state.state}`;
  li.dataset.locationPath = sPath;

  const isExpanded = locationExpandedPaths.has(sPath);

  const row = document.createElement('div');
  row.className = 'location-node-row';

  const hasCities = state.cities && state.cities.length > 0;
  const toggle = document.createElement('span');
  toggle.className = `location-node-toggle ${isExpanded ? 'is-expanded' : ''}`;
  toggle.textContent = hasCities ? (isExpanded ? '▼' : '▶') : '•';
  if (hasCities) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (locationExpandedPaths.has(sPath)) {
        locationExpandedPaths.delete(sPath);
      } else {
        locationExpandedPaths.add(sPath);
      }
      loadLocationTree();
    });
  }
  row.appendChild(toggle);

  const icon = document.createElement('span');
  icon.className = 'location-node-icon';
  icon.textContent = '📍';
  row.appendChild(icon);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'location-node-name';
  nameSpan.textContent = state.state;
  row.appendChild(nameSpan);

  const countBadge = document.createElement('span');
  countBadge.className = 'location-node-count';
  countBadge.textContent = state.count.toLocaleString();
  row.appendChild(countBadge);

  // クリックで都道府県絞り込み
  row.addEventListener('click', () => {
    selectLocationFilter({
      country: countryName,
      state: state.state,
      city: null,
      label: `${countryName} > ${state.state}`,
    });
  });

  li.appendChild(row);

  // 市区町村リスト（展開時のみ）
  if (hasCities && isExpanded) {
    const subUl = document.createElement('ul');
    subUl.className = 'location-sub-tree';
    state.cities.forEach(ci => {
      const cityLi = createCityNode(countryName, state.state, ci);
      subUl.appendChild(cityLi);
    });
    li.appendChild(subUl);
  }

  return li;
}

/**
 * 市区町村ノードの生成
 */
function createCityNode(countryName, stateName, city) {
  const li = document.createElement('li');
  li.className = 'location-tree-node location-city-node';
  const ciPath = `${countryName}/${stateName}/${city.city}`;
  li.dataset.locationPath = ciPath;

  const row = document.createElement('div');
  row.className = 'location-node-row';

  const dot = document.createElement('span');
  dot.className = 'location-node-toggle';
  dot.textContent = '•';
  row.appendChild(dot);

  const icon = document.createElement('span');
  icon.className = 'location-node-icon';
  icon.textContent = '🏙️';
  row.appendChild(icon);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'location-node-name';
  nameSpan.textContent = city.city;
  row.appendChild(nameSpan);

  const countBadge = document.createElement('span');
  countBadge.className = 'location-node-count';
  countBadge.textContent = city.count.toLocaleString();
  row.appendChild(countBadge);

  // クリックで市区町村絞り込み
  row.addEventListener('click', () => {
    selectLocationFilter({
      country: countryName,
      state: stateName,
      city: city.city,
      label: `${stateName} > ${city.city}`,
    });
  });

  li.appendChild(row);
  return li;
}

/**
 * 場所フィルタの選択・解除
 */
function selectLocationFilter(loc) {
  // すでに同じ場所が選択されている場合は解除
  if (state.activeLocation &&
      state.activeLocation.country === loc.country &&
      state.activeLocation.state === loc.state &&
      state.activeLocation.city === loc.city &&
      !state.activeLocation.no_location) {
    clearLocationFilter();
    return;
  }

  // フォルダ選択・未分類等をリセット（排他化）
  if (state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude')) {
    state.currentFilter = { type: 'all', value: null };
    document.querySelectorAll('.sidebar .folder-tree-item, .sidebar .nav-item').forEach(el => {
      el.classList.remove('active', 'active-exclude');
    });
  }
  state.untaggedOnly = false;
  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');

  state.activeLocation = {
    country: loc.country,
    state: loc.state,
    city: loc.city,
    label: loc.label,
    no_location: false,
  };

  if (elements.viewTitle) {
    elements.viewTitle.textContent = `🗺️ ${loc.label}`;
  }

  updateLocationTreeActiveState();
  if (typeof updateSidebarResetDot === 'function') updateSidebarResetDot();
  if (typeof fetchPhotos === 'function') fetchPhotos();
}

/**
 * 「位置情報なし」フィルタのトグル
 */
function toggleNoLocationFilter() {
  if (state.activeLocation && state.activeLocation.no_location) {
    clearLocationFilter();
    return;
  }

  // フォルダ選択・未分類等をリセット（排他化）
  if (state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude')) {
    state.currentFilter = { type: 'all', value: null };
    document.querySelectorAll('.sidebar .folder-tree-item, .sidebar .nav-item').forEach(el => {
      el.classList.remove('active', 'active-exclude');
    });
  }
  state.untaggedOnly = false;
  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');

  state.activeLocation = {
    country: null,
    state: null,
    city: null,
    label: 'ジオタグなし',
    no_location: true,
  };

  if (elements.viewTitle) {
    elements.viewTitle.textContent = '🗺️ ジオタグなしの写真';
  }

  updateLocationTreeActiveState();
  if (typeof updateSidebarResetDot === 'function') updateSidebarResetDot();
  if (typeof fetchPhotos === 'function') fetchPhotos();
}

/**
 * 場所フィルタの解除
 */
function clearLocationFilter() {
  state.activeLocation = null;
  if (elements.viewTitle && elements.viewTitle.textContent.startsWith('🗺️')) {
    elements.viewTitle.textContent = 'すべての写真';
  }
  updateLocationTreeActiveState();
  if (typeof updateSidebarResetDot === 'function') updateSidebarResetDot();
  if (typeof fetchPhotos === 'function') fetchPhotos();
}

/**
 * ツリー上のアクティブ項目のハイライト更新
 */
function updateLocationTreeActiveState() {
  // ツリー項目
  const rows = document.querySelectorAll('.location-tree .location-node-row');
  rows.forEach(r => r.classList.remove('active'));

  const noLocItem = document.getElementById('noLocationNavItem');
  if (noLocItem) noLocItem.classList.remove('active');

  if (!state.activeLocation) return;

  if (state.activeLocation.no_location) {
    if (noLocItem) noLocItem.classList.add('active');
    return;
  }

  const { country, state: st, city } = state.activeLocation;
  let targetPath = country;
  if (st && city) targetPath = `${country}/${st}/${city}`;
  else if (st) targetPath = `${country}/${st}`;

  const targetNode = document.querySelector(`.location-tree-node[data-location-path="${CSS.escape(targetPath)}"] > .location-node-row`);
  if (targetNode) {
    targetNode.classList.add('active');
  }
}

/**
 * すべての場所階層を展開する
 */
function expandAllLocations() {
  const treeContainer = document.getElementById('locationTree');
  if (!treeContainer) return;
  const nodes = treeContainer.querySelectorAll('.location-tree-node');
  nodes.forEach(n => {
    if (n.dataset.locationPath) {
      locationExpandedPaths.add(n.dataset.locationPath);
    }
  });
  loadLocationTree();
}

/**
 * すべての場所階層を折りたたむ
 */
function collapseAllLocations() {
  locationExpandedPaths.clear();
  loadLocationTree();
}

/**
 * 国名から絵文字国旗を取得（フォールバックあり）
 */
function getCountryEmoji(countryName) {
  if (countryName === '日本') return '🇯🇵';
  if (countryName.includes('アメリカ')) return '🇺🇸';
  if (countryName.includes('フランス')) return '🇫🇷';
  if (countryName.includes('イギリス')) return '🇬🇧';
  if (countryName.includes('イタリア')) return '🇮🇹';
  if (countryName.includes('ドイツ')) return '🇩🇪';
  if (countryName.includes('韓国')) return '🇰🇷';
  if (countryName.includes('台湾')) return '🇹🇼';
  if (countryName.includes('中国')) return '🇨🇳';
  if (countryName.includes('オーストラリア')) return '🇦🇺';
  if (countryName.includes('カナダ')) return '🇨🇦';
  if (countryName.includes('スペイン')) return '🇪🇸';
  return '🗺️';
}

// グローバル公開
window.initLocationTree = initLocationTree;
window.loadLocationTree = loadLocationTree;
window.clearLocationFilter = clearLocationFilter;
window.updateLocationTreeActiveState = updateLocationTreeActiveState;
window.selectLocationFilter = selectLocationFilter;
window.toggleNoLocationFilter = toggleNoLocationFilter;

