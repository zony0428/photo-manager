/**
 * フローティング・フィルタ条件変更ポップオーバーの状態管理
 */
let _nlPopoverState = {
  key: null,
  anchorEl: null,
  globalBound: false,
};

function closeNlFilterPopover() {
  const pop = document.getElementById('nlFilterPopover');
  if (pop) {
    pop.style.display = 'none';
    pop.innerHTML = '';
  }
  _nlPopoverState.key = null;
  _nlPopoverState.anchorEl = null;
}
window.closeNlFilterPopover = closeNlFilterPopover;

function _ensureNlPopoverGlobalListeners() {
  if (_nlPopoverState.globalBound) return;
  _nlPopoverState.globalBound = true;

  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('nlFilterPopover');
    if (!pop || pop.style.display === 'none') return;
    if (pop.contains(e.target)) return;
    if (e.target.closest('#viewHeaderChipBar')) return;
    closeNlFilterPopover();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const pop = document.getElementById('nlFilterPopover');
      if (pop && pop.style.display !== 'none') {
        e.stopPropagation();
        closeNlFilterPopover();
      }
    }
  }, true);
}

function _positionNlPopover(anchorEl) {
  const pop = document.getElementById('nlFilterPopover');
  const contentArea = document.querySelector('.content-area');
  if (!pop || !contentArea) return;

  pop.style.left = '50%';
  pop.style.transform = 'translateX(-50%)';

  if (!anchorEl || !anchorEl.getBoundingClientRect) return;
  requestAnimationFrame(() => {
    if (pop.style.display === 'none') return;
    const areaRect = contentArea.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const footerEl = document.getElementById('viewHeaderChipBar');
    const footerRect = footerEl ? footerEl.getBoundingClientRect() : null;

    if (areaRect.width <= 0) return;
    const desiredCenterX = (anchorRect.left + anchorRect.width / 2) - areaRect.left;
    const halfPop = popRect.width / 2;
    const minCenter = halfPop + 12;
    const maxCenter = Math.max(minCenter, areaRect.width - halfPop - 12);
    const clampedCenter = Math.max(minCenter, Math.min(maxCenter, desiredCenterX));
    pop.style.left = `${Math.round(clampedCenter)}px`;
    pop.style.transform = 'translateX(-50%)';

    if (footerRect && footerRect.height > 0) {
      const bottomOffset = Math.max(58, Math.round(areaRect.bottom - footerRect.top + 8));
      pop.style.bottom = `${bottomOffset}px`;
    } else {
      pop.style.bottom = '62px';
    }
  });
}

function openNlFilterPopover(key, anchorEl, builderFn) {
  _ensureNlPopoverGlobalListeners();
  const pop = document.getElementById('nlFilterPopover');
  if (!pop) return;

  if (_nlPopoverState.key === key && pop.style.display !== 'none') {
    closeNlFilterPopover();
    return;
  }

  _nlPopoverState.key = key;
  _nlPopoverState.anchorEl = anchorEl;
  pop.innerHTML = '';
  builderFn(pop);
  pop.style.display = 'flex';
  _positionNlPopover(anchorEl);
}

/**
 * タグフィルタのモードを直接指定して更新するヘルパー ('include' | 'exclude' | null)
 */
function setTagFilterModeDirect(tagPath, mode) {
  if (!tagPath) return;
  state.untaggedOnly = false;
  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');

  const isColor = typeof COLOR_TAG_MAP !== 'undefined' && (tagPath in COLOR_TAG_MAP);
  if (isColor) {
    Object.keys(COLOR_TAG_MAP).forEach(cName => state.tagFilters.delete(cName));
    if (mode === 'include' || mode === 'exclude') {
      state.tagFilters.set(tagPath, mode);
    }
  } else {
    if (mode === 'include' || mode === 'exclude') {
      state.tagFilters.set(tagPath, mode);
      if (typeof expandTagAncestors === 'function') expandTagAncestors(tagPath);
    } else {
      state.tagFilters.delete(tagPath);
    }
  }
  if (state.tagFilters.size === 0) {
    if (state.tagAndRoots) state.tagAndRoots.clear();
    state.tagInterGroupMode = 'and';
  }
  if (typeof renderTagList === 'function') renderTagList();
  fetchPhotos();
}

/**
 * カメラフィルタのモードを直接指定して更新するヘルパー ('include' | 'exclude' | null)
 */
function setCameraFilterModeDirect(camModel, mode) {
  if (!camModel) return;
  if (!state.cameraFilters) state.cameraFilters = new Map();
  if (mode === 'include' || mode === 'exclude') {
    state.cameraFilters.set(camModel, mode);
    if (mode === 'include') state.selectedCameras.add(camModel);
    else state.selectedCameras.delete(camModel);
  } else {
    state.cameraFilters.delete(camModel);
    state.selectedCameras.delete(camModel);
  }
  if (typeof syncCameraAndLensFilterTitle === 'function') {
    syncCameraAndLensFilterTitle();
  } else {
    fetchPhotos();
  }
}

/**
 * レンズフィルタのモードを直接指定して更新するヘルパー ('include' | 'exclude' | null)
 */
function setLensFilterModeDirect(lensKey, mode) {
  if (!lensKey) return;
  if (!state.lensFilters) state.lensFilters = new Map();
  if (mode === 'include' || mode === 'exclude') {
    state.lensFilters.set(lensKey, mode);
    if (mode === 'include') state.selectedLenses.add(lensKey);
    else state.selectedLenses.delete(lensKey);
  } else {
    state.lensFilters.delete(lensKey);
    state.selectedLenses.delete(lensKey);
  }
  if (typeof syncCameraAndLensFilterTitle === 'function') {
    syncCameraAndLensFilterTitle();
  } else {
    fetchPhotos();
  }
}

/**
 * 適用中フィルタ・フローティングフッターバーの描画
 * （写真グリッドを一切上下にずらさず、日本語の条件文として表示・直接変更/反転/解除可能）
 */
function renderActiveFilterChips() {
  const container = document.getElementById('activeFilterChips');
  if (!container) return;
  container.innerHTML = '';

  _ensureNlPopoverGlobalListeners();

  // フローティングバーの「すべて解除」ボタン初期化（初回のみ）
  const clearAllBtn = document.getElementById('floatingClearAllFiltersBtn');
  if (clearAllBtn && !clearAllBtn.dataset.bound) {
    clearAllBtn.dataset.bound = '1';
    clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNlFilterPopover();
      resetAllFilters();
    });
  }

  let hasFilter = false;
  let clauseCount = 0;
  let prevClauseIsTagInclude = false;

  function flashAndScrollToElement(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('filter-jump-highlight');
    void el.offsetWidth;
    el.classList.add('filter-jump-highlight');
    setTimeout(() => el.classList.remove('filter-jump-highlight'), 1300);
  }

  function appendClause(clauseEl, options = {}) {
    if (!clauseEl) return;
    hasFilter = true;
    const isTagInclude = Boolean(options && options.isTagIncludeClause);
    if (clauseCount > 0) {
      if (prevClauseIsTagInclude && isTagInclude) {
        const isInterOr = state.tagInterGroupMode === 'or';
        const conjBtn = document.createElement('button');
        conjBtn.type = 'button';
        conjBtn.className = `nl-conjunction is-interactive${isInterOr ? ' is-toggled' : ''}`;
        conjBtn.textContent = isInterOr ? 'または' : 'かつ';
        conjBtn.title = isInterOr
          ? '異グループ間: OR検索（いずれかのタグ条件に一致）\nクリックで「かつ (AND)」に戻す'
          : '異グループ間: AND検索（両方のタグ条件に一致）\nクリックで「または (OR)」に切り替える';
        conjBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeNlFilterPopover();
          state.tagInterGroupMode = (state.tagInterGroupMode === 'or') ? 'and' : 'or';
          fetchPhotos();
        });
        container.appendChild(conjBtn);
      } else {
        const conj = document.createElement('span');
        conj.className = 'nl-conjunction';
        conj.textContent = 'かつ';
        container.appendChild(conj);
      }
    }
    container.appendChild(clauseEl);
    clauseCount++;
    prevClauseIsTagInclude = isTagInclude;
  }

  function createClauseBox(prefixText = '', onPrefixClick = null, prefixTitle = '') {
    const box = document.createElement('span');
    box.className = 'nl-clause';
    if (prefixText) {
      const pref = document.createElement('span');
      pref.className = `nl-clause-prefix${onPrefixClick ? ' is-clickable' : ''}`;
      pref.textContent = prefixText;
      if (prefixTitle) pref.title = prefixTitle;
      if (onPrefixClick) {
        pref.addEventListener('click', (e) => {
          e.stopPropagation();
          onPrefixClick(pref);
        });
      }
      box.appendChild(pref);
    }
    return box;
  }

  function createOrSpan() {
    const sp = document.createElement('span');
    sp.className = 'nl-or';
    sp.textContent = (typeof t === 'function' && window.currentLang === 'en') ? 'or' : 'または';
    return sp;
  }

  function createPill({ labelHtml, onRemove, extraClass = '', title = '', onClick = null, onRightClick = null }) {
    const chip = document.createElement('span');
    chip.className = `filter-chip ${extraClass}`.trim();
    chip.title = title || '左クリック: 条件を変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除';
    chip.innerHTML = `
      <span class="chip-label">${labelHtml}</span>
      ${onClick ? '<span class="chip-caret">▾</span>' : ''}
      <button class="chip-remove-btn" type="button" title="この条件を解除">&times;</button>
    `;
    if (onClick) {
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.chip-remove-btn')) return;
        e.stopPropagation();
        onClick(chip);
      });
    }
    if (onRightClick) {
      chip.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.chip-remove-btn')) return;
        e.preventDefault();
        e.stopPropagation();
        closeNlFilterPopover();
        onRightClick();
      });
    }
    chip.querySelector('.chip-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeNlFilterPopover();
      onRemove();
    });
    return chip;
  }

  function buildPopoverHeader(pop, titleText, onJump = null, jumpLabel = 'ツリーで開く') {
    const hdr = document.createElement('div');
    hdr.className = 'nl-pop-header';
    hdr.innerHTML = `
      <span class="nl-pop-title">${escapeHtml(titleText)}</span>
      <div class="nl-pop-header-actions">
        ${onJump ? `<button type="button" class="nl-pop-jump-btn">${escapeHtml(jumpLabel)}</button>` : ''}
        <button type="button" class="nl-pop-close-btn" title="閉じる">&times;</button>
      </div>
    `;
    if (onJump) {
      hdr.querySelector('.nl-pop-jump-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        closeNlFilterPopover();
        onJump();
      });
    }
    hdr.querySelector('.nl-pop-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeNlFilterPopover();
    });
    pop.appendChild(hdr);
  }

  function appendPopoverOptionGrid(pop, items) {
    const body = document.createElement('div');
    body.className = 'nl-pop-body';
    const grid = document.createElement('div');
    grid.className = 'nl-pop-option-grid';
    items.forEach((item) => {
      if (!item) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `nl-pop-option-btn${item.active ? ' active' : ''}`;
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        closeNlFilterPopover();
        item.onClick();
      });
      grid.appendChild(btn);
    });
    body.appendChild(grid);
    pop.appendChild(body);
  }

  function createThreeStatePopRow({ labelText, titleText = '', count = 0, mode = null, paddingLeft = '', bold = false, onSelectMode }) {
    const row = document.createElement('div');
    row.className = 'nl-pop-row';
    if (paddingLeft) row.style.paddingLeft = paddingLeft;
    const styleAttr = bold ? ' style="font-weight:600;"' : '';
    row.innerHTML = `
      <span class="nl-pop-row-label"${styleAttr} title="${escapeHtml(titleText || labelText)}">${escapeHtml(labelText)}</span>
      <span class="nl-pop-row-count">${count}</span>
      <div class="nl-pop-state-group">
        <button type="button" class="nl-pop-state-btn is-include${mode === 'include' ? ' active' : ''}" data-act="include" title="含む [+]">+</button>
        <button type="button" class="nl-pop-state-btn is-exclude${mode === 'exclude' ? ' active' : ''}" data-act="exclude" title="除外 [−]">−</button>
      </div>
    `;
    row.querySelector('.nl-pop-row-label').addEventListener('click', () => onSelectMode(mode === 'include' ? null : 'include'));
    row.querySelector('[data-act="include"]').addEventListener('click', () => onSelectMode(mode === 'include' ? null : 'include'));
    row.querySelector('[data-act="exclude"]').addEventListener('click', () => onSelectMode(mode === 'exclude' ? null : 'exclude'));
    return row;
  }

  function appendExcludePillsToClause(clause, excludeItems, hasIncludes, pillBuilder) {
    if (!excludeItems || excludeItems.length === 0) return;
    if (hasIncludes) {
      const exWrap = document.createElement('span');
      exWrap.className = 'nl-except-wrap';
      const openParen = document.createElement('span');
      openParen.textContent = '（除く:';
      exWrap.appendChild(openParen);
      excludeItems.forEach((item) => exWrap.appendChild(pillBuilder(item)));
      const closeParen = document.createElement('span');
      closeParen.textContent = '）';
      exWrap.appendChild(closeParen);
      clause.appendChild(exWrap);
    } else {
      excludeItems.forEach((item, idx) => {
        if (idx > 0) {
          const dot = document.createElement('span');
          dot.className = 'nl-or';
          dot.textContent = '・';
          clause.appendChild(dot);
        }
        clause.appendChild(pillBuilder(item));
      });
      const exSuffix = document.createElement('span');
      exSuffix.className = 'nl-except-wrap';
      exSuffix.textContent = 'を除く';
      clause.appendChild(exSuffix);
    }
  }

  // =========================================================================
  // 1. フォルダ条件
  // =========================================================================
  if ((state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude') && (state.currentFilter.value || state.currentFilter.volumeSerial)) {
    const rawP = state.currentFilter.value || '';
    const curVolOpts = { volumeSerial: state.currentFilter.volumeSerial || null, serialMode: state.currentFilter.serialMode || null, isOffline: !!state.currentFilter.isOffline };
    const isExclude = state.currentFilter.type === 'folder_exclude';
    const name = rawP ? (rawP.split(/[/\\]/).filter(Boolean).pop() || rawP) : (state.currentFilter.titleText || `メディア [ID:${state.currentFilter.volumeSerial}]`);

    const jumpToFolder = () => {
      if (typeof window.openSidebarSection === 'function') window.openSidebarSection('folder');
      if (typeof revealFolderInTree === 'function') revealFolderInTree(rawP);
      setTimeout(() => {
        const targetEl = typeof _ftFindItemByPath === 'function' ? _ftFindItemByPath(rawP) : null;
        flashAndScrollToElement(targetEl);
      }, 120);
    };

    const clearOnlyFolder = () => {
      state.currentFilter = { type: 'all', value: null };
      if (elements.viewTitle) elements.viewTitle.textContent = 'すべての写真';
      document.querySelectorAll('.sidebar .nav-item, .sidebar .folder-tree-item').forEach(el => {
        el.classList.remove('active', 'active-exclude');
      });
      updateConnectionFilterUI();
  if (typeof window.syncFolderTreeFilterStates === 'function') {
        window.syncFolderTreeFilterStates();
      }
      if (typeof window.syncSidebarMediaActiveStates === 'function') {
        window.syncSidebarMediaActiveStates();
      }
      fetchPhotos();
    };

    const openFolderPopover = (anchor) => {
      openNlFilterPopover(`folder:${rawP}`, anchor, (pop) => {
        buildPopoverHeader(pop, `フォルダ条件: ${name}`, jumpToFolder);
        const normParts = rawP.replace(/\\/g, '/').split('/').filter(Boolean);
        let parentOption = null;
        if (normParts.length > 1) {
          const parentPath = rawP.includes('\\')
            ? normParts.slice(0, -1).join('\\')
            : normParts.slice(0, -1).join('/');
          const parentName = normParts[normParts.length - 2];
          if (parentName && !/^[A-Za-z]:$/.test(parentName)) {
            parentOption = {
              label: `親フォルダ「${parentName}」へ広げる`,
              onClick: () => setFilter('folder', parentPath, parentName, curVolOpts),
            };
          }
        }
        appendPopoverOptionGrid(pop, [
          { label: '[+] このフォルダのみ表示', active: !isExclude, onClick: () => setFilter('folder', rawP, name, curVolOpts) },
          { label: '[-] このフォルダを除外', active: isExclude, onClick: () => setFilter('folder_exclude', rawP, `除外: ${name}`, curVolOpts) },
          { label: '解除（全フォルダ対象）', onClick: clearOnlyFolder },
          parentOption,
        ]);
      });
    };

    const clause = createClauseBox(rawP ? 'フォルダ:' : 'メディア:', openFolderPopover, 'クリックでフォルダ・メディア条件を変更');
    const pill = createPill({
      labelHtml: escapeHtml(isExclude ? `− ${name}` : name),
      extraClass: isExclude ? 'chip-tag-exclude' : 'chip-tag-include',
      title: `${rawP}\n左クリック: フォルダ条件を変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除`,
      onRemove: clearOnlyFolder,
      onClick: openFolderPopover,
      onRightClick: () => {
        if (isExclude) setFilter('folder', rawP, name, curVolOpts);
        else setFilter('folder_exclude', rawP, `除外: ${name}`, curVolOpts);
      },
    });
    clause.appendChild(pill);
    if (isExclude) {
      const exTxt = document.createElement('span');
      exTxt.className = 'nl-except-wrap';
      exTxt.textContent = 'を除く';
      clause.appendChild(exTxt);
    }
    appendClause(clause);
  }

  // =========================================================================
  // 2. タイムライン年月・日付 (OR条件)
  // =========================================================================
  const hasSelectedYms = Boolean(state.selectedYearMonths && state.selectedYearMonths.size > 0);
  const hasSelectedDates = Boolean(state.selectedDates && state.selectedDates.size > 0);
  if (hasSelectedYms || hasSelectedDates) {
    const sortedYms = hasSelectedYms
      ? Array.from(state.selectedYearMonths).sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
        )
      : [];
    const sortedDates = hasSelectedDates
      ? Array.from(state.selectedDates).sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
        )
      : [];

    const formatYm = (ym) => {
      const parts = String(ym).split('-');
      if (parts.length === 2 && !isNaN(parseInt(parts[1], 10))) {
        return `${parts[0]}年${parseInt(parts[1], 10)}月`;
      }
      return String(ym);
    };

    const formatDateLabel = (dateStr) => {
      const parts = String(dateStr).split('-');
      if (parts.length === 3) {
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        if (!isNaN(m) && !isNaN(d)) {
          return `${parts[0]}年${m}月${d}日`;
        }
      }
      return String(dateStr);
    };

    const openTimelinePopover = (anchor, focusYm = null) => {
      openNlFilterPopover(`timeline:${focusYm || 'group'}`, anchor, (pop) => {
        const jumpTimeline = () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('timeline');
          const fallbackYm = sortedDates[0] ? sortedDates[0].slice(0, 7) : null;
          const targetYm = focusYm || sortedYms[0] || fallbackYm;
          const yr = String(targetYm || '').split('-')[0];
          if (yr && state.expandedTimelineYears) state.expandedTimelineYears.add(yr);
          const groupEl = document.querySelector(`.timeline-year-header[data-year="${CSS.escape(yr)}"]`)?.parentElement;
          if (groupEl) {
            groupEl.querySelector('.tree-toggle-btn')?.classList.remove('collapsed');
            groupEl.querySelector('.timeline-month-list')?.classList.remove('hidden');
          }
          setTimeout(() => {
            const itemEl = targetYm
              ? document.querySelector(`.timeline-month-item[data-filter-value="${CSS.escape(targetYm)}"]`)
              : document.getElementById('sidebarMiniCalendarBox');
            flashAndScrollToElement(itemEl);
          }, 80);
        };

        buildPopoverHeader(pop, '撮影年月・日付の変更・追加 (OR検索)', jumpTimeline);

        const body = document.createElement('div');
        body.className = 'nl-pop-body';

        // 拡大カレンダー起動ボタン
        const calBar = document.createElement('div');
        calBar.className = 'nl-pop-option-grid';
        const openCalBtn = document.createElement('button');
        openCalBtn.type = 'button';
        openCalBtn.className = 'nl-pop-option-btn';
        openCalBtn.textContent = '拡大カレンダーを開いて日付・年月を選択...';
        openCalBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          if (typeof window.openCalendarModal === 'function') {
            window.openCalendarModal('month');
          }
        });
        calBar.appendChild(openCalBtn);
        body.appendChild(calBar);

        // もし特定の月（例: 10月）が選択されている場合、「すべての年の〇月を一括選択」ショートカットを表示
        const targetMonthStr = focusYm ? String(focusYm).split('-')[1] : (sortedYms[0] ? String(sortedYms[0]).split('-')[1] : null);
        const allDomMonths = Array.from(document.querySelectorAll('#timelineTree .timeline-month-item')).map(el => ({
          ym: el.dataset.filterValue,
          count: el.querySelector('.nav-count')?.textContent || '',
        })).filter(x => x.ym);

        if (targetMonthStr && allDomMonths.length > 0) {
          const sameMonthYms = allDomMonths.filter(x => String(x.ym).split('-')[1] === targetMonthStr).map(x => x.ym);
          if (sameMonthYms.length > 1) {
            const mNum = parseInt(targetMonthStr, 10);
            const allChecked = sameMonthYms.every(ym => state.selectedYearMonths.has(ym));
            const quickBar = document.createElement('div');
            quickBar.className = 'nl-pop-option-grid';
            const sameMonthBtn = document.createElement('button');
            sameMonthBtn.type = 'button';
            sameMonthBtn.className = `nl-pop-option-btn${allChecked ? ' active' : ''}`;
            sameMonthBtn.textContent = allChecked
              ? `全年の「${mNum}月」(${sameMonthYms.length}件) を選択中`
              : `すべての年の「${mNum}月」(${sameMonthYms.length}件) を一括選択`;
            sameMonthBtn.addEventListener('click', () => {
              sameMonthYms.forEach(ym => state.selectedYearMonths.add(ym));
              if (typeof updateTimelineFilterState === 'function') updateTimelineFilterState();
              else fetchPhotos();
              closeNlFilterPopover();
            });
            quickBar.appendChild(sameMonthBtn);
            body.appendChild(quickBar);
          }
        }

        allDomMonths.forEach(item => {
          const row = document.createElement('div');
          row.className = 'nl-pop-row';
          const isSel = state.selectedYearMonths.has(item.ym);
          row.innerHTML = `
            <span class="nl-pop-row-label">${escapeHtml(formatYm(item.ym))}</span>
            <span class="nl-pop-row-count">${escapeHtml(item.count)}</span>
            <div class="nl-pop-state-group">
              <button type="button" class="nl-pop-state-btn is-include${isSel ? ' active' : ''}">${isSel ? '選択中' : '+ 追加'}</button>
            </div>
          `;
          const toggleThisYm = () => {
            toggleTimelineYearMonth(item.ym);
            const nowSel = state.selectedYearMonths.has(item.ym);
            const btn = row.querySelector('.nl-pop-state-btn');
            if (btn) {
              btn.classList.toggle('active', nowSel);
              btn.textContent = nowSel ? '選択中' : '+ 追加';
            }
          };
          row.querySelector('.nl-pop-row-label').addEventListener('click', toggleThisYm);
          row.querySelector('.nl-pop-state-btn').addEventListener('click', toggleThisYm);
          body.appendChild(row);
        });

        pop.appendChild(body);
      });
    };

    // 年単位で全月が選択されている場合は「YYYY年 (全体)」ピルに集約表示
    const availByYear = new Map();
    if (Array.isArray(state.availableTimeline)) {
      state.availableTimeline.forEach(item => {
        if (!item || !item.year_month || item.year_month === '不明') return;
        const yr = String(item.year_month).split('-')[0];
        if (!yr) return;
        if (!availByYear.has(yr)) availByYear.set(yr, []);
        availByYear.get(yr).push(item.year_month);
      });
    }

    const consolidatedYears = new Set();
    const pillsToRender = [];

    availByYear.forEach((ymsInYear, yr) => {
      if (ymsInYear.length >= 2 && ymsInYear.every(ym => state.selectedYearMonths.has(ym))) {
        consolidatedYears.add(yr);
        pillsToRender.push({
          sortKey: `${yr}-00`,
          labelHtml: escapeHtml(`${yr}年 (全体)`),
          title: `${yr}年の全${ymsInYear.length}ヶ月を選択中\n左クリック: 他の年月を追加・変更 ｜ ×: ${yr}年を解除`,
          onRemove: () => {
            if (typeof window.toggleYearMonths === 'function') {
              window.toggleYearMonths(ymsInYear, yr);
            } else {
              ymsInYear.forEach(ym => state.selectedYearMonths.delete(ym));
              fetchPhotos();
            }
          },
          onClick: (chip) => openTimelinePopover(chip, ymsInYear[0]),
        });
      }
    });

    sortedYms.forEach(ym => {
      const yr = String(ym).split('-')[0];
      if (consolidatedYears.has(yr)) return;
      pillsToRender.push({
        sortKey: ym,
        labelHtml: escapeHtml(formatYm(ym)),
        title: `${ym}\n左クリック: 他の年月を追加・変更 ｜ ×: 解除`,
        onRemove: () => toggleTimelineYearMonth(ym),
        onClick: (chip) => openTimelinePopover(chip, ym),
      });
    });

    sortedDates.forEach(dStr => {
      pillsToRender.push({
        sortKey: dStr,
        labelHtml: escapeHtml(formatDateLabel(dStr)),
        title: `${dStr}\n左クリック: カレンダーで変更 ｜ ×: 解除`,
        onRemove: () => {
          if (typeof window.toggleTimelineDate === 'function') {
            window.toggleTimelineDate(dStr, false);
          } else {
            state.selectedDates.delete(dStr);
            fetchPhotos();
          }
        },
        onClick: () => {
          state.miniCalendarYm = dStr.slice(0, 7);
          if (typeof window.openCalendarModal === 'function') {
            window.openCalendarModal('month');
          }
        },
      });
    });

    pillsToRender.sort((a, b) =>
      String(a.sortKey).localeCompare(String(b.sortKey), undefined, { numeric: true, sensitivity: 'base' })
    );

    const clause = createClauseBox('年月:', (pref) => openTimelinePopover(pref, null), 'クリックで撮影年月・日付を追加・変更');
    pillsToRender.forEach((pItem, idx) => {
      if (idx > 0) clause.appendChild(createOrSpan());
      clause.appendChild(createPill({
        labelHtml: pItem.labelHtml,
        extraClass: 'chip-tag-include',
        title: pItem.title,
        onRemove: pItem.onRemove,
        onClick: pItem.onClick,
      }));
    });

    const addYmBtn = document.createElement('button');
    addYmBtn.type = 'button';
    addYmBtn.className = 'nl-group-add-btn';
    addYmBtn.title = '別の撮影年月・日付をOR条件で追加';
    addYmBtn.textContent = '+';
    addYmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTimelinePopover(addYmBtn, sortedYms[0] || (sortedDates[0] ? sortedDates[0].slice(0, 7) : null));
    });
    clause.appendChild(addYmBtn);
    appendClause(clause);
  }

  // =========================================================================
  // 3. ジオタグ（撮影場所）条件
  // =========================================================================
  if (state.activeLocation) {
    const loc = state.activeLocation;
    const isNoLoc = Boolean(loc.no_location);
    const locLabel = isNoLoc
      ? 'ジオタグなし'
      : (loc.label || [loc.country, loc.state, loc.city].filter(Boolean).join(' › '));

    const jumpToLocation = async () => {
      if (typeof window.openSidebarSection === 'function') window.openSidebarSection('location');
      if (isNoLoc) {
        setTimeout(() => flashAndScrollToElement(document.getElementById('noLocationNavItem')), 120);
        return;
      }
      if (typeof window.revealActiveLocationInTree === 'function') {
        await window.revealActiveLocationInTree();
      }
      setTimeout(() => {
        const activeRow = document.querySelector('#locationTree .location-node-row.active');
        flashAndScrollToElement(activeRow);
      }, 120);
    };

    const openLocationPopover = (anchor) => {
      openNlFilterPopover('location', anchor, (pop) => {
        buildPopoverHeader(pop, `撮影場所条件: ${locLabel}`, jumpToLocation);
        const applyLoc = (nextLoc) => {
          state.activeLocation = nextLoc;
          if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();
          fetchPhotos();
        };
        appendPopoverOptionGrid(pop, [
          (!isNoLoc && loc.city && loc.state) ? {
            label: `「${loc.state}」全域に広げる`,
            onClick: () => applyLoc({ country: loc.country, state: loc.state, city: null, label: `${loc.country} > ${loc.state}` }),
          } : null,
          (!isNoLoc && loc.state && loc.country) ? {
            label: `「${loc.country}」全域に広げる`,
            onClick: () => applyLoc({ country: loc.country, state: null, city: null, label: loc.country }),
          } : null,
          {
            label: 'ジオタグなしの写真のみ',
            active: isNoLoc,
            onClick: () => applyLoc({ no_location: true, label: 'ジオタグなし' }),
          },
          {
            label: '場所フィルタを解除',
            onClick: () => {
              if (typeof clearLocationFilter === 'function') clearLocationFilter();
              else applyLoc(null);
            },
          },
        ]);
      });
    };

    const clause = createClauseBox('場所:', openLocationPopover, 'クリックで場所条件を変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(locLabel),
      extraClass: 'chip-tag-include',
      title: `場所: ${locLabel}\n左クリック: 範囲の変更・解除 ｜ ×: 解除`,
      onRemove: () => {
        if (typeof clearLocationFilter === 'function') clearLocationFilter();
        else {
          state.activeLocation = null;
          fetchPhotos();
        }
      },
      onClick: openLocationPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 4. カラータグ条件 & 階層タグ条件（第1階層ルートごとにグループ化）
  //    - 同じ親（ルート）配下の [+] タグは「または (OR)」で結合
  //    - 除外 [-] タグは「（除く: ...）」として明示
  //    - 異なる親（ルート）同士は別文節となり「かつ (AND)」で結合
  // =========================================================================
  if (state.tagFilters && state.tagFilters.size > 0) {
    const colorEntries = [];
    const rootGroups = new Map(); // rootName -> { includes: [], excludes: [] }

    state.tagFilters.forEach((mode, tag) => {
      if (typeof COLOR_TAG_MAP !== 'undefined' && (tag in COLOR_TAG_MAP)) {
        colorEntries.push({ tag, mode });
      } else {
        const root = String(tag).split('/')[0].trim();
        if (!rootGroups.has(root)) {
          rootGroups.set(root, { includes: [], excludes: [] });
        }
        const grp = rootGroups.get(root);
        if (mode === 'include') grp.includes.push(tag);
        else if (mode === 'exclude') grp.excludes.push(tag);
      }
    });

    // 4a. カラータグ文節
    if (colorEntries.length > 0) {
      const openColorPopover = (anchor, focusColor) => {
        openNlFilterPopover(`color:${focusColor}`, anchor, (pop) => {
          const jumpColor = () => {
            if (typeof window.openSidebarSection === 'function') window.openSidebarSection('tags');
            if (typeof toggleColorPaletteExpander === 'function') toggleColorPaletteExpander(true);
            setTimeout(() => flashAndScrollToElement(document.getElementById('colorPaletteSection')), 80);
          };
          buildPopoverHeader(pop, 'カラー条件の変更（左クリック: 含む / 右クリック: 除外）', jumpColor, 'パレットを開く');

          const curMode = state.tagFilters.get(focusColor) || null;
          const curBar = document.createElement('div');
          curBar.className = 'nl-pop-current-bar';
          curBar.innerHTML = `
            <span class="nl-pop-current-name">選択中: ${escapeHtml(focusColor)}</span>
            <div class="nl-pop-state-group">
              <button type="button" class="nl-pop-state-btn is-include${curMode === 'include' ? ' active' : ''}" data-mode="include">+ 含む</button>
              <button type="button" class="nl-pop-state-btn is-exclude${curMode === 'exclude' ? ' active' : ''}" data-mode="exclude">− 除外</button>
              <button type="button" class="nl-pop-state-btn" data-mode="off">解除</button>
            </div>
          `;
          curBar.querySelectorAll('.nl-pop-state-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const m = btn.dataset.mode;
              setTagFilterModeDirect(focusColor, m === 'off' ? null : m);
              closeNlFilterPopover();
            });
          });
          pop.appendChild(curBar);

          const body = document.createElement('div');
          body.className = 'nl-pop-body';
          const grid = document.createElement('div');
          grid.className = 'nl-pop-option-grid';

          Object.keys(COLOR_TAG_MAP).forEach(cName => {
            const conf = COLOR_TAG_MAP[cName];
            const cMode = state.tagFilters.get(cName);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `nl-pop-option-btn${cMode ? ' active' : ''}`;
            btn.style.display = 'inline-flex';
            btn.style.alignItems = 'center';
            btn.style.gap = '5px';
            const sign = cMode === 'include' ? '[+] ' : (cMode === 'exclude' ? '[-] ' : '');
            btn.innerHTML = `<span class="tag-color-dot" style="background:${conf.color}; width:10px; height:10px; border-radius:50%; display:inline-block; border:1px solid rgba(255,255,255,0.35);"></span><span>${escapeHtml(sign + cName)}</span>`;
            btn.title = `${cName}\n左クリック: この色を含む [+] ｜ 右クリック: この色を除外 [-]`;
            btn.addEventListener('click', () => {
              setTagFilterModeDirect(cName, 'include');
              closeNlFilterPopover();
            });
            btn.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              setTagFilterModeDirect(cName, 'exclude');
              closeNlFilterPopover();
            });
            grid.appendChild(btn);
          });

          body.appendChild(grid);
          pop.appendChild(body);
        });
      };

      const colorClause = createClauseBox('色:', (pref) => openColorPopover(pref, colorEntries[0].tag), 'クリックでカラー条件を変更');
      colorEntries.forEach(({ tag, mode }, idx) => {
        if (idx > 0) colorClause.appendChild(createOrSpan());
        const conf = COLOR_TAG_MAP[tag];
        const dotHtml = conf ? `<span class="tag-color-dot" style="background:${conf.color}; width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:4px;"></span>` : '';
        const labelHtml = `${mode === 'exclude' ? '− ' : ''}${dotHtml}${escapeHtml(tag)}`;
        colorClause.appendChild(createPill({
          labelHtml,
          extraClass: mode === 'include' ? 'chip-tag-include' : 'chip-tag-exclude',
          title: `カラー: ${tag}\n左クリック: 色の変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除`,
          onRemove: () => removeTagFilter(tag),
          onClick: (chip) => openColorPopover(chip, tag),
          onRightClick: () => setTagFilterModeDirect(tag, mode === 'include' ? 'exclude' : 'include'),
        }));
        if (mode === 'exclude') {
          const exSpan = document.createElement('span');
          exSpan.className = 'nl-except-wrap';
          exSpan.textContent = 'を除く';
          colorClause.appendChild(exSpan);
        }
      });
      appendClause(colorClause);
    }

    // 4b. 階層タグ・一般タグ文節（ルート親ごとに1つの文節を構築し、すべて自然順で整列）
    const allAvailTags = state.availableTags || [];
    const compareNaturalPath = (pathA, pathB) => {
      const partsA = String(pathA || '').split('/');
      const partsB = String(pathB || '').split('/');
      const minLen = Math.min(partsA.length, partsB.length);
      for (let i = 0; i < minLen; i++) {
        const cmp = partsA[i].localeCompare(partsB[i], undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
      }
      return partsA.length - partsB.length;
    };

    const sortedRootKeys = Array.from(rootGroups.keys()).sort((a, b) => {
      const aHasInc = (rootGroups.get(a)?.includes?.length || 0) > 0 ? 0 : 1;
      const bHasInc = (rootGroups.get(b)?.includes?.length || 0) > 0 ? 0 : 1;
      if (aHasInc !== bHasInc) return aHasInc - bHasInc;
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    });

    sortedRootKeys.forEach((root) => {
      const grp = rootGroups.get(root);
      const includes = [...grp.includes].sort(compareNaturalPath);
      const excludes = [...grp.excludes].sort(compareNaturalPath);
      const isIntraAnd = Boolean(state.tagAndRoots && state.tagAndRoots.has(root));
      const rootHasSubTags = allAvailTags.some(t => {
        const tn = t.tag || t.name || '';
        return tn.startsWith(root + '/');
      }) || includes.some(t => t.includes('/')) || excludes.some(t => t.includes('/'));

      const jumpToTagInTree = (targetTag) => {
        const tagToReveal = targetTag || includes[0] || excludes[0] || root;
        if (typeof window.openSidebarSection === 'function') window.openSidebarSection('tags');
        if (typeof expandTagAncestors === 'function') expandTagAncestors(tagToReveal);
        if (rootHasSubTags) state.expandedTagPaths.add(root);
        const tagObj = allAvailTags.find(t => (t.tag || t.name) === tagToReveal);
        if (tagObj && state.tagSourceFilter !== 'all') {
          if (state.tagSourceFilter === 'manual' && tagObj.source === 'ai') state.tagSourceFilter = 'all';
          else if (state.tagSourceFilter === 'ai' && tagObj.source === 'manual') state.tagSourceFilter = 'all';
        }
        if (typeof renderTagList === 'function') renderTagList();
        setTimeout(() => {
          const pillEl = document.querySelector(`#tagList .tag-pill-item[data-tag-path="${CSS.escape(tagToReveal)}"]`);
          flashAndScrollToElement(pillEl);
        }, 80);
      };

      const openTagGroupPopover = (anchor, focusTag = null) => {
        const popKey = `tag:${root}:${focusTag || 'group'}`;
        openNlFilterPopover(popKey, anchor, (pop) => {
          const nowIntraAnd = Boolean(state.tagAndRoots && state.tagAndRoots.has(root));
          const headerTitle = rootHasSubTags
            ? `タグ条件: ${root}（同グループ内は${nowIntraAnd ? 'AND' : 'OR'}・除外はNOT）`
            : `タグ条件: ${focusTag || root}`;
          buildPopoverHeader(pop, headerTitle, () => jumpToTagInTree(focusTag));

          // クリックされた個別タグの即時切替バー
          if (focusTag) {
            const curMode = state.tagFilters.get(focusTag) || null;
            const curBar = document.createElement('div');
            curBar.className = 'nl-pop-current-bar';
            curBar.innerHTML = `
              <span class="nl-pop-current-name" title="${escapeHtml(focusTag)}">${escapeHtml(focusTag)}</span>
              <div class="nl-pop-state-group">
                <button type="button" class="nl-pop-state-btn is-include${curMode === 'include' ? ' active' : ''}" data-mode="include">+ 含む</button>
                <button type="button" class="nl-pop-state-btn is-exclude${curMode === 'exclude' ? ' active' : ''}" data-mode="exclude">− 除外</button>
                <button type="button" class="nl-pop-state-btn" data-mode="off">解除</button>
              </div>
            `;
            curBar.querySelectorAll('.nl-pop-state-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const m = btn.dataset.mode;
                setTagFilterModeDirect(focusTag, m === 'off' ? null : m);
                const updated = state.tagFilters.get(focusTag) || null;
                curBar.querySelectorAll('.nl-pop-state-btn').forEach(b => {
                  if (b.dataset.mode === 'include') b.classList.toggle('active', updated === 'include');
                  else if (b.dataset.mode === 'exclude') b.classList.toggle('active', updated === 'exclude');
                });
                renderCandidateList(searchInput.value);
              });
            });
            pop.appendChild(curBar);
          }

          // グループ内（OR ⇄ AND）および異グループ間（AND ⇄ OR）の結合モード切替バー
          const includeGroupCount = sortedRootKeys.filter(k => (rootGroups.get(k)?.includes?.length || 0) > 0).length;
          if (rootHasSubTags || includes.length >= 2 || includeGroupCount >= 2) {
            const logicBar = document.createElement('div');
            logicBar.className = 'nl-pop-current-bar nl-pop-logic-bar';

            if (rootHasSubTags || includes.length >= 2) {
              const intraRow = document.createElement('div');
              intraRow.className = 'nl-pop-logic-row';
              const curIntraAnd = Boolean(state.tagAndRoots && state.tagAndRoots.has(root));
              intraRow.innerHTML = `
                <span class="nl-pop-logic-label">同グループ内の結合:</span>
                <div class="nl-pop-state-group">
                  <button type="button" class="nl-pop-state-btn${!curIntraAnd ? ' active is-logic-active' : ''}" data-intra="or">または (OR)</button>
                  <button type="button" class="nl-pop-state-btn${curIntraAnd ? ' active is-logic-active' : ''}" data-intra="and">かつ (AND)</button>
                </div>
              `;
              intraRow.querySelectorAll('button[data-intra]').forEach(btn => {
                btn.addEventListener('click', () => {
                  if (!state.tagAndRoots) state.tagAndRoots = new Set();
                  if (btn.dataset.intra === 'and') state.tagAndRoots.add(root);
                  else state.tagAndRoots.delete(root);
                  closeNlFilterPopover();
                  fetchPhotos();
                });
              });
              logicBar.appendChild(intraRow);
            }

            if (includeGroupCount >= 2) {
              const interRow = document.createElement('div');
              interRow.className = 'nl-pop-logic-row';
              const curInterOr = state.tagInterGroupMode === 'or';
              interRow.innerHTML = `
                <span class="nl-pop-logic-label">別グループとの結合:</span>
                <div class="nl-pop-state-group">
                  <button type="button" class="nl-pop-state-btn${!curInterOr ? ' active is-logic-active' : ''}" data-inter="and">かつ (AND)</button>
                  <button type="button" class="nl-pop-state-btn${curInterOr ? ' active is-logic-active' : ''}" data-inter="or">または (OR)</button>
                </div>
              `;
              interRow.querySelectorAll('button[data-inter]').forEach(btn => {
                btn.addEventListener('click', () => {
                  state.tagInterGroupMode = btn.dataset.inter === 'or' ? 'or' : 'and';
                  closeNlFilterPopover();
                  fetchPhotos();
                });
              });
              logicBar.appendChild(interRow);
            }

            pop.appendChild(logicBar);
          }

          // 検索フィルタ欄
          const searchWrap = document.createElement('div');
          searchWrap.className = 'nl-pop-search-wrap';
          const searchInput = document.createElement('input');
          searchInput.type = 'text';
          searchInput.className = 'nl-pop-search-input';
          searchInput.placeholder = rootHasSubTags
            ? `「${root}」内のタグを検索（他のタグ名も検索可）...`
            : '追加・変更するタグを検索...';
          searchWrap.appendChild(searchInput);
          pop.appendChild(searchWrap);

          const body = document.createElement('div');
          body.className = 'nl-pop-body';
          pop.appendChild(body);

          function renderCandidateList(queryText = '') {
            body.innerHTML = '';
            const q = String(queryText || '').trim().toLowerCase();

            let candidates = allAvailTags.filter(t => {
              const tn = t.tag || t.name || '';
              if (!tn || (typeof COLOR_TAG_MAP !== 'undefined' && (tn in COLOR_TAG_MAP))) return false;
              if (q) return tn.toLowerCase().includes(q);
              if (rootHasSubTags) return tn === root || tn.startsWith(root + '/');
              return !tn.includes('/') || tn === root || state.tagFilters.has(tn);
            });

            // 現在のルート配下を優先して辞書順ソート
            candidates.sort((a, b) => {
              const na = a.tag || a.name || '';
              const nb = b.tag || b.name || '';
              const aInRoot = (na === root || na.startsWith(root + '/')) ? 0 : 1;
              const bInRoot = (nb === root || nb.startsWith(root + '/')) ? 0 : 1;
              if (aInRoot !== bInRoot) return aInRoot - bInRoot;
              return compareNaturalPath(na, nb);
            });

            if (candidates.length === 0) {
              const emptyEl = document.createElement('div');
              emptyEl.className = 'nl-pop-hint';
              emptyEl.textContent = '一致するタグがありません';
              body.appendChild(emptyEl);
              return;
            }

            candidates.slice(0, 80).forEach(tObj => {
              const tPath = tObj.tag || tObj.name;
              const cnt = tObj.count || 0;
              const depth = (tPath.match(/\//g) || []).length;
              const displayRel = (rootHasSubTags && !q && tPath.startsWith(root + '/'))
                ? tPath.slice(root.length + 1)
                : tPath;
              const curM = state.tagFilters.get(tPath) || null;

              const row = createThreeStatePopRow({
                labelText: tPath === root && rootHasSubTags ? `${root} (親全体)` : displayRel,
                titleText: tPath,
                count: cnt,
                mode: curM,
                paddingLeft: `${Math.min(36, 6 + depth * 10)}px`,
                onSelectMode: (nextMode) => {
                  setTagFilterModeDirect(tPath, nextMode);
                  renderCandidateList(searchInput.value);
                },
              });
              body.appendChild(row);
            });
          }

          searchInput.addEventListener('input', () => renderCandidateList(searchInput.value));
          renderCandidateList('');
        });
      };

      const formatTagInGroup = (tagPath) => {
        if (!rootHasSubTags) return tagPath;
        if (tagPath === root) {
          const hasSpecificChildInc = includes.some(other => other !== root && other.startsWith(root + '/'));
          return hasSpecificChildInc ? '全体(子タグ優先)' : 'すべて';
        }
        return tagPath.startsWith(root + '/') ? tagPath.slice(root.length + 1) : tagPath;
      };

      const clausePrefix = rootHasSubTags ? `${root}:` : '';
      const clause = createClauseBox(
        clausePrefix,
        rootHasSubTags ? (pref) => openTagGroupPopover(pref, null) : null,
        rootHasSubTags ? `クリックで「${root}」配下のタグ条件を追加・変更` : ''
      );

      // [+] 含むタグ（同ルート内は既定「または」、クリックで「かつ」へ切替可能）
      includes.forEach((tag, idx) => {
        if (idx > 0) {
          const intraBtn = document.createElement('button');
          intraBtn.type = 'button';
          intraBtn.className = `nl-or is-interactive${isIntraAnd ? ' is-toggled' : ''}`;
          intraBtn.textContent = isIntraAnd ? 'かつ' : 'または';
          intraBtn.title = isIntraAnd
            ? `「${root}」内: AND検索（すべて含む写真のみ）\nクリックで「または (OR)」に戻す`
            : `「${root}」内: OR検索（いずれかを含む写真）\nクリックで「かつ (AND)」に切り替える`;
          intraBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeNlFilterPopover();
            if (!state.tagAndRoots) state.tagAndRoots = new Set();
            if (state.tagAndRoots.has(root)) state.tagAndRoots.delete(root);
            else state.tagAndRoots.add(root);
            fetchPhotos();
          });
          clause.appendChild(intraBtn);
        }
        const disp = formatTagInGroup(tag);
        clause.appendChild(createPill({
          labelHtml: escapeHtml(disp),
          extraClass: 'chip-tag-include',
          title: `タグ: ${tag} (含む)\n左クリック: 同グループのタグ追加・変更 ｜ 右クリック: 除外[−]へ反転 ｜ ×: 解除`,
          onRemove: () => removeTagFilter(tag),
          onClick: (chip) => openTagGroupPopover(chip, tag),
          onRightClick: () => setTagFilterModeDirect(tag, 'exclude'),
        }));
      });

      // [-] 除外タグ
      appendExcludePillsToClause(clause, excludes, includes.length > 0, (tag) => {
        const disp = formatTagInGroup(tag);
        return createPill({
          labelHtml: escapeHtml(`− ${disp}`),
          extraClass: 'chip-tag-exclude',
          title: `タグ: ${tag} (除外)\n左クリック: 条件を変更 ｜ 右クリック: 含む[+]へ反転 ｜ ×: 解除`,
          onRemove: () => removeTagFilter(tag),
          onClick: (chip) => openTagGroupPopover(chip, tag),
          onRightClick: () => setTagFilterModeDirect(tag, 'include'),
        });
      });

      // 階層タググループには「+」追加ボタンを表示
      if (rootHasSubTags) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'nl-group-add-btn';
        addBtn.title = `「${root}」内の別タグを追加 (${isIntraAnd ? 'AND' : 'OR'}) または除外 (NOT)`;
        addBtn.textContent = '+';
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openTagGroupPopover(addBtn, null);
        });
        clause.appendChild(addBtn);
      }

      appendClause(clause, { isTagIncludeClause: includes.length > 0 });
    });
  }

  // =========================================================================
  // 5. カメラ機種 & レンズ条件
  // =========================================================================
  const camIncludes = [];
  const camExcludes = [];
  const handledCams = new Set();

  if (state.cameraFilters && state.cameraFilters.size > 0) {
    state.cameraFilters.forEach((mode, cam) => {
      handledCams.add(cam);
      const entry = { kind: 'camera', key: cam, label: cam, mode };
      if (mode === 'include') camIncludes.push(entry);
      else if (mode === 'exclude') camExcludes.push(entry);
    });
  }
  if (state.selectedCameras && state.selectedCameras.size > 0) {
    Array.from(state.selectedCameras).sort().forEach(cam => {
      if (handledCams.has(cam)) return;
      camIncludes.push({ kind: 'camera', key: cam, label: cam, mode: 'include' });
    });
  }
  if (state.lensFilters && state.lensFilters.size > 0) {
    state.lensFilters.forEach((mode, lensKey) => {
      const displayName = lensKey.includes('::') ? lensKey.replace('::', ' / ') : lensKey;
      const entry = { kind: 'lens', key: lensKey, label: displayName, mode };
      if (mode === 'include') camIncludes.push(entry);
      else if (mode === 'exclude') camExcludes.push(entry);
    });
  }

  if (camIncludes.length > 0 || camExcludes.length > 0) {
    const compareEquipEntry = (a, b) =>
      String(a.label || '').localeCompare(String(b.label || ''), undefined, { numeric: true, sensitivity: 'base' });
    camIncludes.sort(compareEquipEntry);
    camExcludes.sort(compareEquipEntry);
    const openEquipmentPopover = (anchor, focusItem = null) => {
      openNlFilterPopover(`equip:${focusItem ? focusItem.key : 'all'}`, anchor, (pop) => {
        const jumpCamera = () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('camera');
          if (focusItem && focusItem.kind === 'lens' && focusItem.key.includes('::')) {
            const camModel = focusItem.key.split('::')[0];
            if (camModel && state.expandedCameras) {
              state.expandedCameras.add(camModel);
              if (typeof renderCameras === 'function') renderCameras(state.availableCameras);
            }
            setTimeout(() => {
              const lensEl = document.querySelector(`.camera-lens-item[data-lens-key="${CSS.escape(focusItem.key)}"]`);
              flashAndScrollToElement(lensEl);
            }, 80);
          } else if (focusItem && focusItem.kind === 'camera') {
            setTimeout(() => {
              const camEl = document.querySelector(`.camera-tree-item[data-camera="${CSS.escape(focusItem.key)}"]`);
              flashAndScrollToElement(camEl);
            }, 80);
          }
        };

        buildPopoverHeader(pop, '機材（カメラ・レンズ）条件の変更', jumpCamera);

        const body = document.createElement('div');
        body.className = 'nl-pop-body';

        function renderEquipList() {
          body.innerHTML = '';
          const sortedEquipCams = [...(state.availableCameras || [])].sort((a, b) => {
            const ca = String(a.camera_model || '');
            const cb = String(b.camera_model || '');
            const aLast = (ca === '不明' || ca === 'Unknown' || ca === '__NONE__') ? 1 : 0;
            const bLast = (cb === '不明' || cb === 'Unknown' || cb === '__NONE__') ? 1 : 0;
            if (aLast !== bLast) return aLast - bLast;
            return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: 'base' });
          });
          sortedEquipCams.forEach(camObj => {
            const camModel = camObj.camera_model;
            const cMode = (state.cameraFilters && state.cameraFilters.get(camModel)) ||
              (state.selectedCameras && state.selectedCameras.has(camModel) ? 'include' : null);

            const camRow = createThreeStatePopRow({
              labelText: camModel,
              titleText: camModel,
              count: camObj.count || 0,
              mode: cMode,
              bold: true,
              onSelectMode: (nextMode) => {
                setCameraFilterModeDirect(camModel, nextMode);
                renderEquipList();
              },
            });
            body.appendChild(camRow);

            const sortedEquipLenses = [...(camObj.lenses || [])].sort((a, b) => {
              const la = String(a.label || a.lens_model || '');
              const lb = String(b.label || b.lens_model || '');
              const aLast = (a.lens_model === '__NONE__' || la === 'レンズ情報なし' || la === '----') ? 1 : 0;
              const bLast = (b.lens_model === '__NONE__' || lb === 'レンズ情報なし' || lb === '----') ? 1 : 0;
              if (aLast !== bLast) return aLast - bLast;
              return la.localeCompare(lb, undefined, { numeric: true, sensitivity: 'base' });
            });
            sortedEquipLenses.forEach(lens => {
              const lensKey = `${camModel}::${lens.lens_model}`;
              const lensLabel = lens.label || lens.lens_model;
              const lMode = (state.lensFilters && state.lensFilters.get(lensKey)) || null;
              const lensRow = createThreeStatePopRow({
                labelText: `└ ${lensLabel}`,
                titleText: `${camModel} / ${lensLabel}`,
                count: lens.count || 0,
                mode: lMode,
                paddingLeft: '18px',
                onSelectMode: (nextMode) => {
                  setLensFilterModeDirect(lensKey, nextMode);
                  renderEquipList();
                },
              });
              body.appendChild(lensRow);
            });
          });
        }

        renderEquipList();
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('機材:', (pref) => openEquipmentPopover(pref, null), 'クリックでカメラ・レンズ条件を変更');

    const createEquipPill = (item) => createPill({
      labelHtml: escapeHtml(item.mode === 'exclude' ? `− ${item.label}` : item.label),
      extraClass: item.mode === 'include' ? 'chip-tag-include' : 'chip-tag-exclude',
      title: `${item.label}\n左クリック: 機材条件を変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除`,
      onRemove: () => {
        if (item.kind === 'camera') setCameraFilterModeDirect(item.key, null);
        else setLensFilterModeDirect(item.key, null);
      },
      onClick: (chip) => openEquipmentPopover(chip, item),
      onRightClick: () => {
        const nextM = item.mode === 'include' ? 'exclude' : 'include';
        if (item.kind === 'camera') setCameraFilterModeDirect(item.key, nextM);
        else setLensFilterModeDirect(item.key, nextM);
      },
    });

    camIncludes.forEach((item, idx) => {
      if (idx > 0) clause.appendChild(createOrSpan());
      clause.appendChild(createEquipPill(item));
    });

    appendExcludePillsToClause(clause, camExcludes, camIncludes.length > 0, createEquipPill);

    const addEquipBtn = document.createElement('button');
    addEquipBtn.type = 'button';
    addEquipBtn.className = 'nl-group-add-btn';
    addEquipBtn.title = '別のカメラ・レンズ条件を追加';
    addEquipBtn.textContent = '+';
    addEquipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEquipmentPopover(addEquipBtn, null);
    });
    clause.appendChild(addEquipBtn);
    appendClause(clause);
  }

  // =========================================================================
  // 6. ラボ抽出条件（太陽高度・手ブレ注意・歴代の今日・焦点距離帯・F値帯）
  // =========================================================================
  if (state.labFilter || state.onThisDay || state.focalRange || state.apertureRange) {
    const labLabels = {
      golden_hour: 'マジックアワー',
      blue_hour: 'ブルーアワー',
      magic_all: 'マジック＋ブルーアワー',
      night: '夜景・星景',
      shake_risk: '手ブレ注意',
    };

    const openLabPopover = (anchor) => {
      openNlFilterPopover('lab', anchor, (pop) => {
        buildPopoverHeader(pop, 'ラボ抽出条件の変更', () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('lab');
        }, 'ラボを開く');
        appendPopoverOptionGrid(pop, [
          ...Object.entries(labLabels).map(([key, label]) => ({
            label,
            active: state.labFilter === key,
            onClick: () => {
              state.labFilter = (state.labFilter === key) ? null : key;
              if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
              fetchPhotos();
            },
          })),
          {
            label: 'ラボ抽出をすべて解除',
            onClick: () => {
              state.labFilter = null;
              state.onThisDay = null;
              state.focalRange = null;
              state.focalRangeLabel = null;
              state.apertureRange = null;
              state.apertureRangeLabel = null;
              if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
              fetchPhotos();
            },
          },
        ]);
      });
    };

    const clause = createClauseBox('ラボ:', openLabPopover, 'クリックでラボ抽出条件を変更');
    if (state.labFilter) {
      clause.appendChild(createPill({
        labelHtml: escapeHtml(labLabels[state.labFilter] || state.labFilter),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.labFilter = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    if (state.onThisDay) {
      const parts = String(state.onThisDay).split('-');
      const otdLabel = parts.length === 2 ? `歴代の${parseInt(parts[0], 10)}月${parseInt(parts[1], 10)}日` : `歴代の今日: ${state.onThisDay}`;
      clause.appendChild(createPill({
        labelHtml: escapeHtml(otdLabel),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.onThisDay = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    if (state.focalRange) {
      clause.appendChild(createPill({
        labelHtml: escapeHtml(`焦点距離: ${state.focalRangeLabel || state.focalRange}`),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.focalRange = null;
          state.focalRangeLabel = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    if (state.apertureRange) {
      clause.appendChild(createPill({
        labelHtml: escapeHtml(`F値: ${state.apertureRangeLabel || state.apertureRange}`),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.apertureRange = null;
          state.apertureRangeLabel = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    appendClause(clause);
  }

  // =========================================================================
  // 7. 評価（レーティング: 標準[0, 1, 2]以外の場合）
  // =========================================================================
  const isDefaultRating = (state.ratingFilter.size === 3 &&
    state.ratingFilter.has(0) && state.ratingFilter.has(1) && state.ratingFilter.has(2));
  if (!isDefaultRating) {
    const rNames = [];
    if (state.ratingFilter.has(2)) rNames.push('優');
    if (state.ratingFilter.has(1)) rNames.push('良');
    if (state.ratingFilter.has(0)) rNames.push('可');
    if (state.ratingFilter.has(-1)) rNames.push('棄');
    const rText = rNames.length > 0 ? `${rNames.join('・')}のみ` : 'なし';

    const openRatingPopover = (anchor) => {
      openNlFilterPopover('rating', anchor, (pop) => {
        buildPopoverHeader(pop, '評価（レーティング）条件の変更');
        const presets = [
          { label: '優のみ', set: [2] },
          { label: '優・良のみ', set: [1, 2] },
          { label: '良のみ', set: [1] },
          { label: '可のみ', set: [0] },
          { label: '棄のみ', set: [-1] },
          { label: '標準に戻す（優・良・可）', set: [0, 1, 2] },
        ];
        appendPopoverOptionGrid(pop, presets.map((p) => ({
          label: p.label,
          active: state.ratingFilter.size === p.set.length && p.set.every((v) => state.ratingFilter.has(v)),
          onClick: () => {
            state.ratingFilter = new Set(p.set);
            updateRatingFilterUI();
            fetchPhotos();
          },
        })));
      });
    };

    const clause = createClauseBox('評価:', openRatingPopover, 'クリックで評価条件を変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(rText),
      extraClass: 'chip-tag-include',
      title: `評価: ${rText}\n左クリック: 評価条件を変更 ｜ ×: 標準(優・良・可)に戻す`,
      onRemove: () => {
        state.ratingFilter = new Set([0, 1, 2]);
        updateRatingFilterUI();
        fetchPhotos();
      },
      onClick: openRatingPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 8. ファイル種別・属性条件（RAWのみ / 調整済みのみ / JPEGのみ / RAW+JPGペア / XMPあり）
  // =========================================================================
  if (state.attrFilter && state.attrFilter !== 'all') {
    const attrLabels = {
      raw: 'RAWのみ',
      adjusted: '調整済みのみ',
      jpeg: 'JPEG/一般のみ',
      raw_pair: 'RAW+JPGペア',
      xmp: 'XMPあり',
    };

    const openAttrPopover = (anchor) => {
      openNlFilterPopover('attr', anchor, (pop) => {
        buildPopoverHeader(pop, 'ファイル種別・属性条件の変更');
        appendPopoverOptionGrid(pop, [
          ...Object.entries(attrLabels).map(([key, label]) => ({
            label,
            active: state.attrFilter === key,
            onClick: () => setAttrFilter(key),
          })),
          { label: 'すべて表示（解除）', onClick: () => setAttrFilter('all') },
        ]);
      });
    };

    const clause = createClauseBox('種別:', openAttrPopover, 'クリックでファイル種別条件を変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(attrLabels[state.attrFilter] || state.attrFilter),
      extraClass: 'chip-tag-include',
      title: '左クリック: ファイル種別を変更 ｜ ×: 解除',
      onRemove: () => setAttrFilter('all'),
      onClick: openAttrPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 9. 未分類 / 接続状態 / 重複条件
  // =========================================================================
  if (state.untaggedOnly) {
    const clause = createClauseBox('タグ:');
    clause.appendChild(createPill({
      labelHtml: '未分類のみ',
      extraClass: 'chip-tag-include',
      onRemove: () => clearAllTagFilters(),
      onClick: () => {
        const scopeSel = elements.headerScopeSelect || document.getElementById('headerScopeSelect');
        if (scopeSel) scopeSel.focus();
      },
    }));
    appendClause(clause);
  }

  if (state.connectionFilter && state.connectionFilter !== 'all') {
    const connSetForChip = (state.connectionStates instanceof Set) ? state.connectionStates : new Set(['online', 'offline', 'unlinked']);
    const customConnParts = [];
    if (connSetForChip.has('online')) customConnParts.push('接続中');
    if (connSetForChip.has('offline')) customConnParts.push('未接続');
    if (connSetForChip.has('unlinked')) customConnParts.push('リンク消失');
    const connLabels = {
      custom_conn: customConnParts.join('・') || '接続状態指定',
      online: '接続中のみ',
      offline: '未接続のみ',
      duplicates: '重複のある写真',
      unlinked: 'リンク消失の写真',
      missing: 'リンク消失の写真',
    };

    const openConnPopover = (anchor) => {
      openNlFilterPopover('conn', anchor, (pop) => {
        buildPopoverHeader(pop, '状態・重複フィルタの変更');
        const opts = [
          { key: 'online', label: '接続中のみ' },
          { key: 'offline', label: '未接続のみ' },
          { key: 'duplicates', label: '重複のある写真' },
          { key: 'unlinked', label: 'リンク消失の写真' },
        ];
        appendPopoverOptionGrid(pop, [
          ...opts.map((opt) => ({
            label: opt.label,
            active: state.connectionFilter === opt.key,
            onClick: () => setConnectionFilter(opt.key),
          })),
          { label: '解除（すべて）', onClick: () => setConnectionFilter('all') },
        ]);
      });
    };

    const clause = createClauseBox('状態:', openConnPopover, 'クリックで状態フィルタを変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(connLabels[state.connectionFilter] || state.connectionFilter),
      extraClass: 'chip-tag-include',
      onRemove: () => setConnectionFilter('all'),
      onClick: openConnPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 10. ファイル名検索クエリ
  // =========================================================================
  if (state.searchQuery && state.searchQuery.trim() !== '') {
    const qText = state.searchQuery.trim();
    const openSearchPopover = (anchor) => {
      openNlFilterPopover('search', anchor, (pop) => {
        buildPopoverHeader(pop, 'ファイル名検索キーワードの変更', () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('search');
        });
        const wrap = document.createElement('div');
        wrap.className = 'nl-pop-search-wrap';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'nl-pop-search-input';
        inp.value = state.searchQuery;
        inp.placeholder = 'ファイル名を入力してEnter...';
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            state.searchQuery = inp.value.trim();
            if (elements.searchInput) elements.searchInput.value = state.searchQuery;
            if (elements.clearSearchBtn) {
              elements.clearSearchBtn.style.display = state.searchQuery ? 'block' : 'none';
            }
            closeNlFilterPopover();
            fetchPhotos();
          }
        });
        wrap.appendChild(inp);
        pop.appendChild(wrap);
        setTimeout(() => { inp.focus(); inp.select(); }, 30);
      });
    };

    const clause = createClauseBox('検索:', openSearchPopover, 'クリックで検索キーワードを編集');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(`"${qText}"`),
      extraClass: 'chip-tag-include',
      onRemove: () => {
        if (elements.clearSearchBtn) elements.clearSearchBtn.click();
        else {
          state.searchQuery = '';
          fetchPhotos();
        }
      },
      onClick: openSearchPopover,
    }));
    appendClause(clause);
  }

  // アコーディオンヘッダーのフィルタ適用状態（has-filter）同期
  const camAccordion = document.getElementById('accordionItem-camera');
  if (camAccordion) {
    const hasCam = Boolean(
      (state.cameraFilters && state.cameraFilters.size > 0) ||
      (state.lensFilters && state.lensFilters.size > 0) ||
      (state.selectedCameras && state.selectedCameras.size > 0)
    );
    camAccordion.classList.toggle('has-filter', hasCam);
  }
  const labAccordion = document.getElementById('accordionItem-lab');
  if (labAccordion) {
    const hasLab = Boolean(state.labFilter || state.onThisDay || state.focalRange || state.apertureRange);
    labAccordion.classList.toggle('has-filter', hasLab);
  }

  const timelineAccordion = document.getElementById('accordionItem-timeline');
  if (timelineAccordion) {
    const hasTimeline = Boolean(
      (state.selectedYearMonths && state.selectedYearMonths.size > 0) ||
      (state.selectedDates && state.selectedDates.size > 0)
    );
    timelineAccordion.classList.toggle('has-filter', hasTimeline);
  }

  // 垂直タブレール (.rail-tab-btn) へのフィルタ適用インジケータ同期
  const sectionFilterMap = {
    quick: Boolean(state.activePresetId),
    folder: Boolean(state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude' || state.currentFilter.type === 'unlinked')),
    tags: Boolean(state.tagFilters && state.tagFilters.size > 0),
    location: Boolean(state.activeLocation),
    timeline: Boolean((state.selectedYearMonths && state.selectedYearMonths.size > 0) || (state.selectedDates && state.selectedDates.size > 0)),
    camera: Boolean((state.cameraFilters && state.cameraFilters.size > 0) || (state.lensFilters && state.lensFilters.size > 0) || (state.selectedCameras && state.selectedCameras.size > 0)),
    lab: Boolean(state.labFilter || state.onThisDay || state.focalRange || state.apertureRange),
    search: Boolean(state.searchQuery && state.searchQuery.trim().length > 0),
  };
  document.querySelectorAll('#sidebarRail .rail-tab-btn').forEach(btn => {
    const sec = btn.dataset.section;
    if (sec && sec in sectionFilterMap) {
      btn.classList.toggle('has-filter', sectionFilterMap[sec]);
    }
  });

  // サイドバーリセットボタンとフローティングフッターバーの表示制御
  const chipBar = document.getElementById('viewHeaderChipBar');
  const purgeBtn = document.getElementById('purgeUnlinkedBtn');
  const contentArea = document.querySelector('.content-area');
  const isPurgeVisible = purgeBtn && purgeBtn.style.display !== 'none';
  const showFooterBar = Boolean(hasFilter || isPurgeVisible);

  if (chipBar) {
    chipBar.style.display = showFooterBar ? 'flex' : 'none';
  }
  if (clearAllBtn) {
    clearAllBtn.style.display = hasFilter ? 'inline-flex' : 'none';
  }
  if (contentArea) {
    contentArea.classList.toggle('has-floating-filter', showFooterBar);
  }
  if (!showFooterBar) {
    closeNlFilterPopover();
  }

  const resetBtn = document.getElementById('sidebarResetFilterBtn');
  if (resetBtn) {
    resetBtn.classList.toggle('has-active-filter', hasFilter);
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
