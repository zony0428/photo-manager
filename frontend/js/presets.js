/**
 * Photo Manager - \u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8 (Saved Filter Presets)
 */

if (typeof state !== 'undefined') {
  if (!('activePresetId' in state)) state.activePresetId = null;
  if (!('filterPresets' in state)) state.filterPresets = [];
}

function getCurrentFilterState() {
  const tagFiltersObj = {};
  if (state.tagFilters) {
    state.tagFilters.forEach((val, key) => {
      tagFiltersObj[key] = val;
    });
  }

  const cameraFiltersObj = {};
  if (state.cameraFilters) {
    state.cameraFilters.forEach((val, key) => {
      cameraFiltersObj[key] = val;
    });
  }

  const lensFiltersObj = {};
  if (state.lensFilters) {
    state.lensFilters.forEach((val, key) => {
      lensFiltersObj[key] = val;
    });
  }

  return {
    currentFilter: state.currentFilter ? { ...state.currentFilter } : { type: 'all', value: null },
    ratingFilter: Array.from(state.ratingFilter || []),
    searchQuery: state.searchQuery || '',
    sortBy: state.sortBy || 'date_taken DESC',
    untaggedOnly: !!state.untaggedOnly,
    connectionFilter: state.connectionFilter || 'all',
    selectedYearMonths: Array.from(state.selectedYearMonths || []),
    selectedCameras: Array.from(state.selectedCameras || []),
    selectedLenses: Array.from(state.selectedLenses || []),
    cameraFilters: cameraFiltersObj,
    lensFilters: lensFiltersObj,
    labFilter: state.labFilter || null,
    onThisDay: state.onThisDay || null,
    focalRange: state.focalRange || null,
    focalRangeLabel: state.focalRangeLabel || null,
    apertureRange: state.apertureRange || null,
    apertureRangeLabel: state.apertureRangeLabel || null,
    isStacked: state.isStacked !== undefined ? state.isStacked : true,
    tagFilters: tagFiltersObj,
  };
}

function renderPresetCurrentChips() {
  const container = document.getElementById('presetCurrentChips');
  if (!container) return;
  container.innerHTML = '';

  const chips = [];

  // 1. folder
  if (state.currentFilter && state.currentFilter.type === 'folder' && state.currentFilter.value) {
    const rawP = state.currentFilter.value;
    const name = rawP.replaceAll('\\', '/').split('/').filter(Boolean).pop() || rawP;
    chips.push({ icon: '\u{1F4C1}', label: name });
  }

  // 2. year_months
  if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
    Array.from(state.selectedYearMonths).sort().forEach(ym => {
      chips.push({ icon: '\u{1F4C5}', label: ym });
    });
  }

  // 3. cameras & lenses
  if (state.cameraFilters && state.cameraFilters.size > 0) {
    state.cameraFilters.forEach((mode, cam) => {
      const prefix = mode === 'include' ? '+' : '\u2212';
      chips.push({ icon: '\u{1F4F7}', label: `${prefix}${cam}` });
    });
  } else if (state.selectedCameras && state.selectedCameras.size > 0) {
    Array.from(state.selectedCameras).sort().forEach(cam => {
      chips.push({ icon: '\u{1F4F7}', label: cam });
    });
  }

  if (state.lensFilters && state.lensFilters.size > 0) {
    state.lensFilters.forEach((mode, lensKey) => {
      const prefix = mode === 'include' ? '+' : '\u2212';
      const displayLens = lensKey.includes('::') ? lensKey.split('::')[1] : lensKey;
      chips.push({ icon: '\u{1F52D}', label: `${prefix}${displayLens}` });
    });
  }

  // 3b. lab filters
  if (state.labFilter) {
    const labNames = {
      golden_hour: 'マジックアワー',
      blue_hour: 'ブルーアワー',
      magic_all: 'マジック＋ブルー',
      night: '夜景・星景',
      shake_risk: '手ブレ注意',
    };
    chips.push({ icon: '\u{1F9EA}', label: labNames[state.labFilter] || state.labFilter });
  }
  if (state.onThisDay) {
    chips.push({ icon: '\u{1F382}', label: state.onThisDay });
  }
  if (state.focalRange) {
    chips.push({ icon: '\u{1F52D}', label: state.focalRangeLabel || state.focalRange });
  }
  if (state.apertureRange) {
    chips.push({ icon: '\u{1F4A0}', label: state.apertureRangeLabel || state.apertureRange });
  }

  // 4. tags
  if (state.tagFilters && state.tagFilters.size > 0) {
    state.tagFilters.forEach((mode, tag) => {
      const prefix = mode === 'include' ? '+' : '\u2212';
      chips.push({ icon: '\u{1F3F7}\uFE0F', label: `${prefix}${tag}` });
    });
  }

  // 5. untagged
  if (state.untaggedOnly) {
    chips.push({ icon: '\u{1F3F7}\uFE0F', label: '\u672A\u5206\u985E' });
  }

  // 6. connection
  if (state.connectionFilter === 'online') {
    chips.push({ icon: '\u{1F7E2}', label: '\u63A5\u7D9A\u4E2D\u306E\u307F' });
  } else if (state.connectionFilter === 'offline') {
    chips.push({ icon: '\u26AA', label: '\u672A\u63A5\u7D9A\u306E\u307F' });
  }

  // 7. search
  if (state.searchQuery && state.searchQuery.trim() !== '') {
    chips.push({ icon: '\u{1F50D}', label: `"${state.searchQuery.trim()}"` });
  }

  // 8. rating
  const isDefaultRating = state.ratingFilter &&
    state.ratingFilter.size === 3 &&
    state.ratingFilter.has(0) && state.ratingFilter.has(1) && state.ratingFilter.has(2);
  if (state.ratingFilter && !isDefaultRating) {
    const labels = [];
    if (state.ratingFilter.has(2)) labels.push('\u511A');
    if (state.ratingFilter.has(1)) labels.push('\u826F');
    if (state.ratingFilter.has(0)) labels.push('\u53EF');
    if (state.ratingFilter.has(-1)) labels.push('\u68C4');
    chips.push({ icon: '\u2B50', label: labels.join('/') });
  }

  if (chips.length === 0) {
    container.innerHTML = '<span class="preset-empty-chip">\u6761\u4EF6\u306A\u3057\uFF08\u3059\u3079\u3066\u306E\u5199\u771F\uFF09</span>';
    return;
  }

  chips.forEach(c => {
    const el = document.createElement('span');
    el.className = 'preset-mini-chip';
    el.innerHTML = `${escapeHtml(c.icon)} ${escapeHtml(c.label)}`;
    container.appendChild(el);
  });
}

function renderFilterPresetsList() {
  const container = document.getElementById('presetListContainer');
  const badge = document.getElementById('presetCountBadge');
  if (!container) return;

  const presets = state.filterPresets || [];
  if (badge) badge.textContent = `${presets.length}\u4EF6`;

  if (presets.length === 0) {
    container.innerHTML = '<div class="preset-empty-message">\u4FDD\u5B58\u3055\u308C\u305F\u30BB\u30C3\u30C8\u306F\u3042\u308A\u307E\u305B\u3093</div>';
    return;
  }

  container.innerHTML = '';
  presets.forEach(p => {
    const card = document.createElement('div');
    card.className = `preset-item-card ${state.activePresetId === p.id ? 'active' : ''}`;
    card.dataset.presetId = p.id;

    const f = p.filters || {};
    const condBadges = [];
    if (f.currentFilter && f.currentFilter.type === 'folder' && f.currentFilter.value) {
      const name = f.currentFilter.value.replaceAll('\\', '/').split('/').filter(Boolean).pop() || f.currentFilter.value;
      condBadges.push(`\u{1F4C1} ${escapeHtml(name)}`);
    }
    if (f.selectedYearMonths && f.selectedYearMonths.length > 0) {
      condBadges.push(`\u{1F4C5} ${escapeHtml(f.selectedYearMonths.join(', '))}`);
    }
    if (f.cameraFilters && Object.keys(f.cameraFilters).length > 0) {
      const cams = Object.keys(f.cameraFilters).map(c => (f.cameraFilters[c] === 'include' ? `+${c}` : `\u2212${c}`));
      condBadges.push(`\u{1F4F7} ${escapeHtml(cams.join(' '))}`);
    } else if (f.selectedCameras && f.selectedCameras.length > 0) {
      condBadges.push(`\u{1F4F7} ${escapeHtml(f.selectedCameras.join(', '))}`);
    }
    if (f.lensFilters && Object.keys(f.lensFilters).length > 0) {
      const lenses = Object.keys(f.lensFilters).map(k => {
        const name = k.includes('::') ? k.split('::')[1] : k;
        return f.lensFilters[k] === 'include' ? `+${name}` : `\u2212${name}`;
      });
      condBadges.push(`\u{1F52D} ${escapeHtml(lenses.join(' '))}`);
    }
    if (f.labFilter) {
      const labNames = {
        golden_hour: 'マジックアワー',
        blue_hour: 'ブルーアワー',
        magic_all: 'マジック＋ブルー',
        night: '夜景・星景',
        shake_risk: '手ブレ注意',
      };
      condBadges.push(`\u{1F9EA} ${escapeHtml(labNames[f.labFilter] || f.labFilter)}`);
    }
    if (f.onThisDay) {
      condBadges.push(`\u{1F382} ${escapeHtml(f.onThisDay)}`);
    }
    if (f.focalRange) {
      condBadges.push(`\u{1F52D} ${escapeHtml(f.focalRangeLabel || f.focalRange)}`);
    }
    if (f.apertureRange) {
      condBadges.push(`\u{1F4A0} ${escapeHtml(f.apertureRangeLabel || f.apertureRange)}`);
    }
    if (f.tagFilters) {
      const tags = Object.keys(f.tagFilters).map(t => (f.tagFilters[t] === 'include' ? `+${t}` : `\u2212${t}`));
      if (tags.length > 0) condBadges.push(`\u{1F3F7}\uFE0F ${escapeHtml(tags.join(' '))}`);
    }
    if (f.untaggedOnly) condBadges.push('\u{1F3F7}\uFE0F \u672A\u5206\u985E');
    if (f.searchQuery) condBadges.push(`\u{1F50D} "${escapeHtml(f.searchQuery)}"`);
    if (f.ratingFilter && f.ratingFilter.length > 0 && f.ratingFilter.length < 3) {
      const rMap = { 2: '\u511A', 1: '\u826F', 0: '\u53EF', '-1': '\u68C4' };
      condBadges.push(`\u2B50 ${f.ratingFilter.map(r => rMap[r] || r).join('/')}`);
    }

    const condHtml = condBadges.length > 0
      ? condBadges.map(b => `<span class="preset-cond-badge">${b}</span>`).join('')
      : '<span class="preset-cond-badge">\u3059\u3079\u3066\u306E\u5199\u771F</span>';

    const dateStr = p.updated_at ? p.updated_at.substring(0, 10) : '';

    card.innerHTML = `
      <div class="preset-item-header">
        <span class="preset-item-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
        <span class="preset-item-date">${escapeHtml(dateStr)}</span>
      </div>
      <div class="preset-item-conditions">
        ${condHtml}
      </div>
      <div class="preset-item-actions">
        <button type="button" class="preset-action-btn apply-btn" title="\u3053\u306E\u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8\u3092\u9069\u7528">
          <span>\u9069\u7528</span>
        </button>
        <button type="button" class="preset-action-btn play-btn" title="\u3053\u306E\u30BB\u30C3\u30C8\u3067\u30B9\u30E9\u30A4\u30C9\u30B7\u30E7\u30FC\u3092\u518D\u751F">
          <span>\u25B6\uFE0E \u518D\u751F</span>
        </button>
        <button type="button" class="preset-action-btn delete-btn" title="\u3053\u306E\u30BB\u30C3\u30C8\u3092\u524A\u9664">
          <span>\u{1F5D1}\uFE0F</span>
        </button>
      </div>
    `;

    card.querySelector('.apply-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      applyFilterPreset(p);
    });

    card.querySelector('.play-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      applyFilterPreset(p);
      setTimeout(() => {
        if (window.startSlideshow && typeof state !== 'undefined' && state.photos) {
          window.startSlideshow(state.photos, 0, `\u2605 ${p.name}`);
        }
      }, 400);
    });

    card.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFilterPreset(p.id, p.name);
    });

    container.appendChild(card);
  });
}

async function fetchFilterPresets() {
  try {
    const res = await fetch('/api/filter-presets');
    if (!res.ok) throw new Error('\u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8\u306E\u53D6\u5F97\u306B\u5931\u6557\u3057\u307E\u3057\u305F');
    const data = await res.json();
    state.filterPresets = data.presets || [];
    renderFilterPresetsList();
  } catch (err) {
    console.error('fetchFilterPresets error:', err);
  }
}

async function saveCurrentFilterPreset() {
  const nameInput = document.getElementById('newPresetNameInput');
  const name = (nameInput?.value || '').trim();
  if (!name) {
    showToast('\u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8\u306E\u540D\u524D\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044', 'warning');
    nameInput?.focus();
    return;
  }

  const filters = getCurrentFilterState();

  try {
    const res = await fetch('/api/filter-presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filters }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || '\u4FDD\u5B58\u306B\u5931\u6557\u3057\u307E\u3057\u305F');
    }

    showToast(`\u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8\u300C${name}\u300D\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F`, 'success');
    if (nameInput) nameInput.value = '';
    state.activePresetId = data.preset?.id || null;
    await fetchFilterPresets();
  } catch (err) {
    console.error('saveCurrentFilterPreset error:', err);
    showToast(err.message, 'error');
  }
}

function applyFilterPreset(preset) {
  if (!preset || !preset.filters) return;
  const f = preset.filters;

  // 1. rating
  state.ratingFilter = new Set(f.ratingFilter || [0, 1, 2]);
  document.querySelectorAll('.rating-filter-toggles .rating-toggle').forEach(btn => {
    const rv = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle('active', state.ratingFilter.has(rv));
  });

  // 2. search
  state.searchQuery = f.searchQuery || '';
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  if (searchInput) searchInput.value = state.searchQuery;
  if (clearSearchBtn) {
    clearSearchBtn.style.display = state.searchQuery ? 'block' : 'none';
  }

  // 3. tags
  state.tagFilters.clear();
  if (f.tagFilters) {
    Object.entries(f.tagFilters).forEach(([tag, mode]) => {
      state.tagFilters.set(tag, mode);
    });
  }
  state.untaggedOnly = !!f.untaggedOnly;
  const untaggedNavItem = document.getElementById('untaggedNavItem');
  if (untaggedNavItem) {
    untaggedNavItem.classList.toggle('active', state.untaggedOnly);
  }
  if (typeof renderTagList === 'function') renderTagList();

  // 4. timeline
  state.selectedYearMonths = new Set(f.selectedYearMonths || []);
  if (typeof updateTimelineActiveClasses === 'function') updateTimelineActiveClasses();

  // 5. cameras & lenses
  state.selectedCameras = new Set(f.selectedCameras || []);
  state.selectedLenses = new Set(f.selectedLenses || []);
  if (state.cameraFilters) state.cameraFilters.clear();
  if (f.cameraFilters && state.cameraFilters) {
    Object.entries(f.cameraFilters).forEach(([cam, mode]) => {
      state.cameraFilters.set(cam, mode);
      if (mode === 'include') state.selectedCameras.add(cam);
    });
  } else if (f.selectedCameras && state.cameraFilters) {
    f.selectedCameras.forEach(cam => state.cameraFilters.set(cam, 'include'));
  }

  if (state.lensFilters) state.lensFilters.clear();
  if (f.lensFilters && state.lensFilters) {
    Object.entries(f.lensFilters).forEach(([lensKey, mode]) => {
      state.lensFilters.set(lensKey, mode);
      if (mode === 'include') state.selectedLenses.add(lensKey);
    });
  }
  if (typeof updateCameraActiveClasses === 'function') updateCameraActiveClasses();

  // 5b. lab filters
  state.labFilter = f.labFilter || null;
  state.onThisDay = f.onThisDay || null;
  state.focalRange = f.focalRange || null;
  state.focalRangeLabel = f.focalRangeLabel || null;
  state.apertureRange = f.apertureRange || null;
  state.apertureRangeLabel = f.apertureRangeLabel || null;
  if (typeof window.updateLabUIState === 'function') {
    window.updateLabUIState();
  }

  // 6. connection
  state.connectionFilter = f.connectionFilter || 'all';
  const onlineNav = document.getElementById('onlineOnlyNavItem');
  const offlineNav = document.getElementById('offlineOnlyNavItem');
  if (onlineNav) onlineNav.classList.toggle('active', state.connectionFilter === 'online');
  if (offlineNav) offlineNav.classList.toggle('active', state.connectionFilter === 'offline');

  // 7. sort
  if (f.sortBy) {
    state.sortBy = f.sortBy;
    const sortBySelect = document.getElementById('sortBySelect');
    if (sortBySelect) sortBySelect.value = state.sortBy;
  }

  // 8. stacked
  if (f.isStacked !== undefined) {
    state.isStacked = f.isStacked;
  }

  // 9. folder
  state.currentFilter = f.currentFilter || { type: 'all', value: null };

  const viewTitle = document.getElementById('viewTitle');
  if (viewTitle) {
    viewTitle.textContent = `\u2605 ${preset.name}`;
  }

  state.activePresetId = preset.id;
  renderFilterPresetsList();
  renderPresetCurrentChips();

  if (typeof fetchPhotos === 'function') fetchPhotos();
  showToast(`\u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8\u300C${preset.name}\u300D\u3092\u9069\u7528\u3057\u307E\u3057\u305F`, 'info');
}

async function deleteFilterPreset(presetId, presetName) {
  if (!confirm(`\u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8\u300C${presetName}\u300D\u3092\u524A\u9664\u3057\u3066\u3082\u3088\u308D\u3057\u3044\u3067\u3059\u304B\uFF1F`)) {
    return;
  }

  try {
    const res = await fetch(`/api/filter-presets/${presetId}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('\u524A\u9664\u306B\u5931\u6557\u3057\u307E\u3057\u305F');

    if (state.activePresetId === presetId) {
      state.activePresetId = null;
    }
    showToast(`\u30D5\u30A3\u30EB\u30BF\u30BB\u30C3\u30C8\u300C${presetName}\u300D\u3092\u524A\u9664\u3057\u307E\u3057\u305F`, 'success');
    await fetchFilterPresets();
  } catch (err) {
    console.error('deleteFilterPreset error:', err);
    showToast(err.message, 'error');
  }
}

function initPresets() {
  const saveBtn = document.getElementById('savePresetBtn');
  const nameInput = document.getElementById('newPresetNameInput');

  if (saveBtn) {
    saveBtn.addEventListener('click', saveCurrentFilterPreset);
  }
  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveCurrentFilterPreset();
      }
    });
  }
}

window.getCurrentFilterState = getCurrentFilterState;
window.renderPresetCurrentChips = renderPresetCurrentChips;
window.renderFilterPresetsList = renderFilterPresetsList;
window.fetchFilterPresets = fetchFilterPresets;
window.saveCurrentFilterPreset = saveCurrentFilterPreset;
window.applyFilterPreset = applyFilterPreset;
window.deleteFilterPreset = deleteFilterPreset;
window.initPresets = initPresets;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPresets);
} else {
  initPresets();
}
