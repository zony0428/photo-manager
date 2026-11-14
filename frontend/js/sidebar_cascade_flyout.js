/**
 * Tetheract Photo Manager - 左ペイン NeXTSTEP 風カスケード・フライアウトメニュー
 * - 各フィルタカード（Tag / Place / Historia / Gear / Folder）を1.0秒マウスオーバーすると、
 *   マウスカーソル（対象カード）の高さ基点で右側に NeXTSTEP パネルを展開する。
 * - Folder のみ黒い NeXTSTEP タイトルバー（.ns-menu-titlebar）にパス・VSN・直下/子枚数内訳のプロパティを統合表示し、
 *   Tag / Place / Historia / Gear はシンプルな1行タイトルバー＋子要素リストのみを表示する。
 */
(function () {
  'use strict';

  const HOVER_OPEN_DELAY_MS = 300;  // 左ペインカード上の基準ホバー発火遅延（ms）
  const SUB_CASCADE_DELAY_MS = 300; // フライアウト内部での子→孫カスケード展開遅延（ms）
  const LEAF_PROP_DELAY_MS = 300;   // Folder 内部でのサブフォルダなし項目プロパティ展開遅延（ms）
  const CLOSE_GRACE_MS = 220;       // カードからフライアウトへ斜め移動する際の猶予時間

  function _scaledHoverDelay(baseMs) {
    const deg = typeof window.getMotionSweepDegree === 'function' ? window.getMotionSweepDegree() : 60;
    if (deg <= 0) return 0;
    // カスケードメニューは応答性重視のため他の演出の半分（0% -> 0ms、60% -> 90ms、100% -> 150ms）に抑える
    return Math.round(baseMs * 0.5 * (deg / 100));
  }

  const CARD_SELECTOR = [
    '.tag-pill-item',
    '.location-node-row',
    '.timeline-year-header',
    '.timeline-month-item',
    '.camera-tree-item',
    '.folder-tree-item',
  ].join(', ');

  const ARROW_SELECTOR = [
    '.tree-toggle-btn',
    '.location-node-toggle:not(.is-leaf)',
    '.camera-tree-expander:not(.empty)',
    '.folder-toggle-btn',
  ].join(', ');

  let _flyoutRootEl = null;
  let _hoveredCardEl = null;
  let _activeCardKey = null;
  let _openTimer = null;
  let _closeTimer = null;

  function _esc(str) {
    if (typeof escapeHtml === 'function') return escapeHtml(String(str ?? ''));
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _getCardIdentityKey(cardEl) {
    if (!cardEl) return '';
    if (cardEl.classList.contains('tag-pill-item')) {
      return `tag:${cardEl.dataset.tagPath || ''}`;
    }
    if (cardEl.classList.contains('location-node-row')) {
      const n = cardEl._locationNode;
      return n ? `loc:${n.level}:${n.country || ''}/${n.state || ''}/${n.city || ''}` : '';
    }
    if (cardEl.classList.contains('timeline-year-header')) {
      return `tl-year:${cardEl.dataset.year || ''}`;
    }
    if (cardEl.classList.contains('timeline-month-item')) {
      return `tl-month:${cardEl.dataset.filterValue || ''}`;
    }
    if (cardEl.classList.contains('camera-tree-item')) {
      return `cam:${cardEl.dataset.camera || cardEl.dataset.filterValue || ''}`;
    }
    if (cardEl.classList.contains('folder-tree-item')) {
      const fn = cardEl._ftNode;
      return fn ? `folder:${fn.key || fn.path || ''}` : '';
    }
    return '';
  }

  /**
   * 対象カードがカスケードパネルを展開可能か判定する
   * - Tag / Place / Historia / Gear は子要素を持つ親カードのみ展開
   * - Folder はパス・VSN・枚数内訳プロパティ確認も兼ねるため全フォルダで展開可能
   */
  function _resolveCardTagNode(cardEl) {
    if (!cardEl) return null;
    if (cardEl._tagNode) return cardEl._tagNode;
    const tagPath = cardEl.dataset ? cardEl.dataset.tagPath : '';
    const tb = window.TetheractCore && window.TetheractCore.TreeBuilder;
    if (tagPath && tb && typeof tb.findTagNodeByPath === 'function' && state._lastSidebarTagTreeRoot) {
      return tb.findTagNodeByPath(state._lastSidebarTagTreeRoot, tagPath);
    }
    return null;
  }

  function _canOpenCardPanel(cardEl) {
    if (!cardEl) return false;
    if (cardEl.classList.contains('tag-pill-item')) {
      const tagNode = _resolveCardTagNode(cardEl);
      return Boolean(tagNode && tagNode.children && tagNode.children.size > 0);
    }
    if (cardEl.classList.contains('location-node-row')) {
      const n = cardEl._locationNode;
      if (!n) return false;
      if (n.level === 'country') return Array.isArray(n.states) && n.states.length > 0;
      if (n.level === 'state') return Array.isArray(n.cities) && n.cities.length > 0;
      return false;
    }
    if (cardEl.classList.contains('timeline-year-header')) {
      return Boolean(cardEl._yearGroup && Array.isArray(cardEl._yearGroup.months) && cardEl._yearGroup.months.length > 0);
    }
    if (cardEl.classList.contains('timeline-month-item')) {
      return Boolean(cardEl._monthItem && cardEl._monthItem.year_month);
    }
    if (cardEl.classList.contains('camera-tree-item')) {
      return Boolean(cardEl._cameraItem && Array.isArray(cardEl._cameraItem.lenses) && cardEl._cameraItem.lenses.length > 0);
    }
    if (cardEl.classList.contains('folder-tree-item')) {
      const fn = cardEl._ftNode;
      return Boolean(fn && !fn.foreignLoome);
    }
    return false;
  }

  function _clearOpenTimer() {
    if (_openTimer) {
      clearTimeout(_openTimer);
      _openTimer = null;
    }
  }

  function _clearCloseTimer() {
    if (_closeTimer) {
      clearTimeout(_closeTimer);
      _closeTimer = null;
    }
  }

  function _destroyFlyoutDomOnly() {
    _clearCloseTimer();
    _activeCardKey = null;
    document.querySelectorAll('.sidebar .is-ns-flyout-open').forEach(el => {
      el.classList.remove('is-ns-flyout-open');
    });
    if (_flyoutRootEl && _flyoutRootEl.parentNode) {
      _flyoutRootEl.parentNode.removeChild(_flyoutRootEl);
    }
    _flyoutRootEl = null;
  }

  function closeFilterCascadeFlyout() {
    _clearOpenTimer();
    _destroyFlyoutDomOnly();
  }
  window.closeFilterCascadeFlyout = closeFilterCascadeFlyout;

  function _scheduleCloseFlyout(delay = CLOSE_GRACE_MS) {
    _clearCloseTimer();
    _closeTimer = setTimeout(() => {
      _destroyFlyoutDomOnly();
    }, delay);
  }

  function _mountChildCascadePanel(parentPanel, rowEl, subPanel) {
    const panelRect = parentPanel.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const rawTop = Math.round(rowRect.top - panelRect.top - 2);
    subPanel.style.top = `${rawTop}px`;
    parentPanel.appendChild(subPanel);

    const clampPos = () => {
      if (!subPanel.isConnected) return;
      const subRect = subPanel.getBoundingClientRect();
      if (subRect.right > window.innerWidth - 10) {
        subPanel.classList.add('open-left');
      }
      let adjustedTop = rawTop;
      if (subRect.bottom > window.innerHeight - 8) {
        adjustedTop -= (subRect.bottom - (window.innerHeight - 8));
      }
      const nextParentRect = parentPanel.getBoundingClientRect();
      if (nextParentRect.top + adjustedTop < 8) {
        adjustedTop = 8 - nextParentRect.top;
      }
      subPanel.style.top = `${Math.round(adjustedTop)}px`;
    };
    clampPos();
    requestAnimationFrame(clampPos);
  }

  function _createIntegratedTitlebar({ icon, title, badgeText, metaLines, onClick, onContextMenu, syncStateFn }) {
    const titlebar = document.createElement('div');
    titlebar.className = 'ns-menu-titlebar ns-integrated-titlebar ns-filter-item';
    const metaHtml = Array.isArray(metaLines) && metaLines.length > 0
      ? `<div class="ns-titlebar-meta">${metaLines.map(l => `<div class="ns-titlebar-meta-line">${l}</div>`).join('')}</div>`
      : '';
    titlebar.innerHTML = `
      <div class="ns-titlebar-top">
        <span class="ns-title-text">${icon ? `${icon} ` : ''}${_esc(title)}</span>
        <span class="ns-filter-state-holder"></span>
        ${badgeText !== undefined && badgeText !== '' ? `<span class="ns-title-badge">${_esc(badgeText)}</span>` : ''}
      </div>
      ${metaHtml}
    `;
    if (typeof syncStateFn === 'function') {
      titlebar._syncState = () => syncStateFn(titlebar);
      titlebar._syncState();
    }
    if (typeof onClick === 'function') {
      titlebar.addEventListener('click', e => {
        e.stopPropagation();
        onClick(e);
      });
    }
    if (typeof onContextMenu === 'function') {
      titlebar.addEventListener('contextmenu', e => {
        onContextMenu(e);
      });
    }
    return titlebar;
  }

  /* ==========================================================================
     1. Tag（階層タグツリー）カスケードパネル生成（黒いバー内の付加情報は無し）
     ========================================================================== */
  function _countDescendantTagFilters(node) {
    const tb = window.TetheractCore && window.TetheractCore.TreeBuilder;
    if (tb && typeof tb.countDescendantTagFilters === 'function') {
      return tb.countDescendantTagFilters(node, state.tagFilters);
    }
    let inc = 0;
    let exc = 0;
    if (!node || !node.children || !state.tagFilters) return { inc, exc };
    node.children.forEach(child => {
      const m = state.tagFilters.get(child.fullPath);
      if (m === 'include') inc++;
      else if (m === 'exclude') exc++;
      const sub = _countDescendantTagFilters(child);
      inc += sub.inc;
      exc += sub.exc;
    });
    return { inc, exc };
  }

  function _syncTagRowState(rowEl, tagNode) {
    const mode = state.tagFilters ? state.tagFilters.get(tagNode.fullPath) : null;
    const desc = tagNode.children && tagNode.children.size > 0
      ? _countDescendantTagFilters(tagNode)
      : { inc: 0, exc: 0 };

    rowEl.classList.toggle('is-filter-include', mode === 'include');
    rowEl.classList.toggle('is-filter-exclude', mode === 'exclude');
    rowEl.classList.toggle('has-child-filter', !mode && (desc.inc > 0 || desc.exc > 0));

    const badgeHolder = rowEl.querySelector('.ns-filter-state-holder');
    if (badgeHolder) {
      let html = '';
      if (mode === 'include') {
        html += '<span class="ns-state-pill is-include">[+]</span>';
      } else if (mode === 'exclude') {
        html += '<span class="ns-state-pill is-exclude">[-]</span>';
      }
      if (desc.inc > 0) {
        html += `<span class="child-filter-badge is-include">+${desc.inc}</span>`;
      }
      if (desc.exc > 0) {
        html += `<span class="child-filter-badge is-exclude">−${desc.exc}</span>`;
      }
      badgeHolder.innerHTML = html;
    }
  }

  function _createTagCascadePanel(tagNode, isChildPanel) {
    const hasChildren = Boolean(tagNode.children && tagNode.children.size > 0);
    const panel = document.createElement('div');
    panel.className = `ns-cascade-panel ns-filter-panel${isChildPanel ? ' ns-child-panel' : ''}`;
    panel.addEventListener('click', e => e.stopPropagation());

    let activeChildPanel = null;
    let activeRowEl = null;
    let subHoverTimer = null;

    const closeSubPanel = () => {
      if (subHoverTimer) {
        clearTimeout(subHoverTimer);
        subHoverTimer = null;
      }
      if (activeChildPanel && activeChildPanel.parentNode) {
        activeChildPanel.parentNode.removeChild(activeChildPanel);
      }
      activeChildPanel = null;
      if (activeRowEl) {
        activeRowEl.classList.remove('is-active-cascade');
        activeRowEl = null;
      }
    };

    const titlebar = _createIntegratedTitlebar({
      icon: '🏷️',
      title: tagNode.name,
      badgeText: `${Number(tagNode.count || 0)}`,
      metaLines: [],
      syncStateFn: el => _syncTagRowState(el, tagNode),
      onClick: () => {
        if (typeof handleTagLeftClick === 'function') {
          handleTagLeftClick(tagNode.fullPath);
          _refreshAllOpenFlyoutRowStates();
        }
      },
      onContextMenu: e => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof handleTagRightClick === 'function') {
          handleTagRightClick(tagNode.fullPath);
          _refreshAllOpenFlyoutRowStates();
        }
      },
    });
    titlebar.addEventListener('mouseenter', () => closeSubPanel());
    panel.appendChild(titlebar);

    if (!hasChildren) return panel;

    const body = document.createElement('div');
    body.className = 'ns-menu-body';
    body.addEventListener('scroll', () => closeSubPanel(), { passive: true });

    tagNode.children.forEach(childNode => {
      const hasGrandChildren = childNode.children && childNode.children.size > 0;
      const row = document.createElement('div');
      row.className = 'ns-menu-item ns-filter-item';
      row._syncState = () => _syncTagRowState(row, childNode);

      const aiHtml = childNode.source === 'ai'
        ? '<span class="ai-tag-pill-badge" style="margin-right:3px;">AI</span>'
        : '';

      row.innerHTML = `
        <span class="ns-item-main" style="flex-direction:row; align-items:center; gap:5px;">
          ${aiHtml}
          <span class="ns-item-label">${_esc(childNode.name)}</span>
        </span>
        <span class="ns-filter-state-holder"></span>
        <span class="ns-item-count">${Number(childNode.count || 0)}</span>
        ${hasGrandChildren ? '<span class="ns-item-arrow">▸</span>' : ''}
      `;
      row._syncState();

      row.addEventListener('mouseenter', () => {
        if (subHoverTimer) { clearTimeout(subHoverTimer); subHoverTimer = null; }
        if (activeRowEl === row && activeChildPanel) return;
        subHoverTimer = setTimeout(() => {
          closeSubPanel();
          if (!hasGrandChildren) return;
          activeRowEl = row;
          row.classList.add('is-active-cascade');
          const subPanel = _createTagCascadePanel(childNode, true);
          activeChildPanel = subPanel;
          _mountChildCascadePanel(panel, row, subPanel);
        }, _scaledHoverDelay(SUB_CASCADE_DELAY_MS));
      });

      row.addEventListener('click', e => {
        e.stopPropagation();
        if (subHoverTimer) {
          clearTimeout(subHoverTimer);
          subHoverTimer = null;
        }
        if (typeof handleTagLeftClick === 'function') {
          handleTagLeftClick(childNode.fullPath);
          _refreshAllOpenFlyoutRowStates();
        }
      });

      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof handleTagRightClick === 'function') {
          handleTagRightClick(childNode.fullPath);
          _refreshAllOpenFlyoutRowStates();
        }
      });

      body.appendChild(row);
    });

    panel.appendChild(body);
    return panel;
  }

  /* ==========================================================================
     2. Place（国 → 都道府県 → 市区町村）カスケードパネル生成
     ========================================================================== */
  function _isLocationSelected(country, st, city) {
    const loc = state.activeLocation;
    if (!loc || loc.no_location) return { exact: false, ancestor: false };
    if (city) {
      return {
        exact: loc.country === country && loc.state === st && loc.city === city,
        ancestor: false,
      };
    }
    if (st) {
      return {
        exact: loc.country === country && loc.state === st && !loc.city,
        ancestor: loc.country === country && loc.state === st && Boolean(loc.city),
      };
    }
    return {
      exact: loc.country === country && !loc.state && !loc.city,
      ancestor: loc.country === country && Boolean(loc.state),
    };
  }

  function _createLocationCitiesPanel(countryName, stateObj, isChildPanel) {
    const cities = Array.isArray(stateObj.cities) ? stateObj.cities : [];
    const panel = document.createElement('div');
    panel.className = `ns-cascade-panel ns-filter-panel${isChildPanel ? ' ns-child-panel' : ''}`;
    panel.addEventListener('click', e => e.stopPropagation());

    const titlebar = _createIntegratedTitlebar({
      icon: '📍',
      title: stateObj.state,
      badgeText: Number(stateObj.count || 0).toLocaleString(),
      metaLines: [],
      syncStateFn: el => {
        const sel = _isLocationSelected(countryName, stateObj.state, null);
        el.classList.toggle('is-filter-include', sel.exact);
        el.classList.toggle('has-child-filter', sel.ancestor);
      },
      onClick: () => {
        if (typeof window.selectLocationFilter === 'function') {
          window.selectLocationFilter({
            country: countryName,
            state: stateObj.state,
            city: null,
            label: `${countryName} > ${stateObj.state}`,
          });
          _refreshAllOpenFlyoutRowStates();
        }
      },
    });
    panel.appendChild(titlebar);

    const body = document.createElement('div');
    body.className = 'ns-menu-body';

    cities.forEach(ci => {
      const row = document.createElement('div');
      row.className = 'ns-menu-item ns-filter-item';
      row._syncState = () => {
        const sel = _isLocationSelected(countryName, stateObj.state, ci.city);
        row.classList.toggle('is-filter-include', sel.exact);
      };
      row.innerHTML = `
        <span class="ns-item-main">
          <span class="ns-item-label">${_esc(ci.city)}</span>
        </span>
        <span class="ns-item-count">${Number(ci.count || 0).toLocaleString()}</span>
      `;
      row._syncState();

      row.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof window.selectLocationFilter === 'function') {
          window.selectLocationFilter({
            country: countryName,
            state: stateObj.state,
            city: ci.city,
            label: `${stateObj.state} > ${ci.city}`,
          });
          _refreshAllOpenFlyoutRowStates();
        }
      });

      body.appendChild(row);
    });

    panel.appendChild(body);
    return panel;
  }

  function _createLocationStatesPanel(countryObj, isChildPanel) {
    const states = Array.isArray(countryObj.states) ? countryObj.states : [];
    const panel = document.createElement('div');
    panel.className = `ns-cascade-panel ns-filter-panel${isChildPanel ? ' ns-child-panel' : ''}`;
    panel.addEventListener('click', e => e.stopPropagation());

    let activeChildPanel = null;
    let activeRowEl = null;
    let subHoverTimer = null;

    const closeSubPanel = () => {
      if (subHoverTimer) {
        clearTimeout(subHoverTimer);
        subHoverTimer = null;
      }
      if (activeChildPanel && activeChildPanel.parentNode) {
        activeChildPanel.parentNode.removeChild(activeChildPanel);
      }
      activeChildPanel = null;
      if (activeRowEl) {
        activeRowEl.classList.remove('is-active-cascade');
        activeRowEl = null;
      }
    };

    const titlebar = _createIntegratedTitlebar({
      icon: '🗺️',
      title: countryObj.country,
      badgeText: Number(countryObj.count || 0).toLocaleString(),
      metaLines: [],
      syncStateFn: el => {
        const sel = _isLocationSelected(countryObj.country, null, null);
        el.classList.toggle('is-filter-include', sel.exact);
        el.classList.toggle('has-child-filter', sel.ancestor);
      },
      onClick: () => {
        if (typeof window.selectLocationFilter === 'function') {
          window.selectLocationFilter({
            country: countryObj.country,
            state: null,
            city: null,
            label: countryObj.country,
          });
          _refreshAllOpenFlyoutRowStates();
        }
      },
    });
    titlebar.addEventListener('mouseenter', () => closeSubPanel());
    panel.appendChild(titlebar);

    const body = document.createElement('div');
    body.className = 'ns-menu-body';
    body.addEventListener('scroll', () => closeSubPanel(), { passive: true });

    states.forEach(st => {
      const hasCities = Array.isArray(st.cities) && st.cities.length > 0;
      const row = document.createElement('div');
      row.className = 'ns-menu-item ns-filter-item';
      row._syncState = () => {
        const sel = _isLocationSelected(countryObj.country, st.state, null);
        row.classList.toggle('is-filter-include', sel.exact);
        row.classList.toggle('has-child-filter', sel.ancestor);
        const holder = row.querySelector('.ns-filter-state-holder');
        if (holder) {
          holder.innerHTML = sel.ancestor ? '<span class="child-filter-badge is-accent">●</span>' : '';
        }
      };

      row.innerHTML = `
        <span class="ns-item-main">
          <span class="ns-item-label">${_esc(st.state)}</span>
        </span>
        <span class="ns-filter-state-holder"></span>
        <span class="ns-item-count">${Number(st.count || 0).toLocaleString()}</span>
        ${hasCities ? '<span class="ns-item-arrow">▸</span>' : ''}
      `;
      row._syncState();

      row.addEventListener('mouseenter', () => {
        if (subHoverTimer) { clearTimeout(subHoverTimer); subHoverTimer = null; }
        if (activeRowEl === row && activeChildPanel) return;
        subHoverTimer = setTimeout(() => {
          closeSubPanel();
          if (!hasCities) return;
          activeRowEl = row;
          row.classList.add('is-active-cascade');
          const subPanel = _createLocationCitiesPanel(countryObj.country, st, true);
          activeChildPanel = subPanel;
          _mountChildCascadePanel(panel, row, subPanel);
        }, _scaledHoverDelay(SUB_CASCADE_DELAY_MS));
      });

      row.addEventListener('click', e => {
        e.stopPropagation();
        if (subHoverTimer) {
          clearTimeout(subHoverTimer);
          subHoverTimer = null;
        }
        if (typeof window.selectLocationFilter === 'function') {
          window.selectLocationFilter({
            country: countryObj.country,
            state: st.state,
            city: null,
            label: `${countryObj.country} > ${st.state}`,
          });
          _refreshAllOpenFlyoutRowStates();
        }
      });

      body.appendChild(row);
    });

    panel.appendChild(body);
    return panel;
  }

  /* ==========================================================================
     3. Historia（年 → 月 → 7列ミニカレンダー）カスケードパネル生成
     ========================================================================== */
  function _createHistoriaMiniCalPanel(monthItem, isChildPanel) {
    const ym = monthItem.year_month;
    const [yearStr, monthStr] = String(ym || '').split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    const panel = document.createElement('div');
    panel.className = `ns-cascade-panel ns-filter-panel ns-cal-flyout-panel${isChildPanel ? ' ns-child-panel' : ''}`;
    panel.addEventListener('click', e => e.stopPropagation());

    let maxDayCountInMonth = 1;
    if (state.calendarDaysMap && state.calendarDaysMap.size > 0) {
      state.calendarDaysMap.forEach((info, dKey) => {
        if (dKey.startsWith(ym + '-')) {
          const c = info.count || 0;
          if (c > maxDayCountInMonth) maxDayCountInMonth = c;
        }
      });
    }

    const titlebar = _createIntegratedTitlebar({
      icon: '📅',
      title: `${year}年${month}月`,
      badgeText: `${Number(monthItem.count || 0)}`,
      metaLines: [],
      syncStateFn: el => {
        const isMonthSel = Boolean(state.selectedYearMonths && state.selectedYearMonths.has(ym));
        el.classList.toggle('is-filter-include', isMonthSel);
      },
      onClick: () => {
        if (typeof toggleTimelineYearMonth === 'function') {
          toggleTimelineYearMonth(ym);
          _refreshAllOpenFlyoutRowStates();
        }
      },
    });
    panel.appendChild(titlebar);

    const body = document.createElement('div');
    body.className = 'ns-menu-body ns-cal-flyout-body';

    const calWrap = document.createElement('div');
    calWrap.className = 'ns-flyout-minical-wrap';

    const wkEl = document.createElement('div');
    wkEl.className = 'mini-cal-weekdays';
    wkEl.innerHTML = '<span class="is-sun">日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span class="is-sat">土</span>';
    calWrap.appendChild(wkEl);

    const gridEl = document.createElement('div');
    gridEl.className = 'mini-cal-grid';

    const firstDayDow = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    for (let i = 0; i < firstDayDow; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'mini-cal-cell is-empty';
      gridEl.appendChild(emptyCell);
    }

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    for (let day = 1; day <= daysInMonth; day++) {
      const ddStr = String(day).padStart(2, '0');
      const dateStr = `${yearStr}-${monthStr}-${ddStr}`;
      const dow = (firstDayDow + day - 1) % 7;
      const dayInfo = state.calendarDaysMap ? state.calendarDaysMap.get(dateStr) : null;
      const cnt = dayInfo ? (dayInfo.count || 0) : 0;

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'mini-cal-cell';
      cell.dataset.date = dateStr;
      if (dow === 0) cell.classList.add('is-sun');
      else if (dow === 6) cell.classList.add('is-sat');
      if (dateStr === todayStr) cell.classList.add('is-today');

      if (cnt > 0) {
        cell.classList.add('has-photos');
        const ratio = Math.min(1, Math.log10(cnt + 1) / Math.log10(Math.max(5, maxDayCountInMonth) + 1));
        const lv = ratio >= 0.78 ? 4 : ratio >= 0.52 ? 3 : ratio >= 0.28 ? 2 : 1;
        cell.classList.add(`cal-lv-${lv}`);
      }

      cell._syncState = () => {
        const isDateSelected = Boolean(state.selectedDates && state.selectedDates.has(dateStr));
        const isMonthSelected = Boolean(state.selectedYearMonths && state.selectedYearMonths.has(ym));
        cell.classList.toggle('is-selected', isDateSelected);
        cell.classList.toggle('is-in-selected-month', !isDateSelected && isMonthSelected && cnt > 0);
      };
      cell._syncState();

      cell.innerHTML = `
        <span class="mini-cal-day-num">${day}</span>
        ${cnt > 0 ? '<span class="mini-cal-day-dot"></span>' : ''}
      `;

      cell.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof toggleTimelineDate === 'function') {
          toggleTimelineDate(dateStr, e.shiftKey);
          _refreshAllOpenFlyoutRowStates();
        }
      });

      gridEl.appendChild(cell);
    }

    calWrap.appendChild(gridEl);
    body.appendChild(calWrap);
    panel.appendChild(body);
    return panel;
  }

  function _createHistoriaMonthsPanel(yearGroup, isChildPanel) {
    const months = Array.isArray(yearGroup.months) ? yearGroup.months : [];
    const panel = document.createElement('div');
    panel.className = `ns-cascade-panel ns-filter-panel${isChildPanel ? ' ns-child-panel' : ''}`;
    panel.addEventListener('click', e => e.stopPropagation());

    let activeChildPanel = null;
    let activeRowEl = null;
    let subHoverTimer = null;

    const closeSubPanel = () => {
      if (subHoverTimer) {
        clearTimeout(subHoverTimer);
        subHoverTimer = null;
      }
      if (activeChildPanel && activeChildPanel.parentNode) {
        activeChildPanel.parentNode.removeChild(activeChildPanel);
      }
      activeChildPanel = null;
      if (activeRowEl) {
        activeRowEl.classList.remove('is-active-cascade');
        activeRowEl = null;
      }
    };

    const titlebar = _createIntegratedTitlebar({
      icon: '📅',
      title: `${yearGroup.year}年`,
      badgeText: `${Number(yearGroup.totalCount || 0)}`,
      metaLines: [],
      syncStateFn: el => {
        const allSel = months.length > 0 && months.every(m => state.selectedYearMonths && state.selectedYearMonths.has(m.year_month));
        el.classList.toggle('is-filter-include', allSel);
      },
      onClick: () => {
        if (typeof toggleYearMonths === 'function') {
          const firstMonth = months[0]?.year_month;
          if (firstMonth) state.miniCalendarYm = firstMonth;
          toggleYearMonths(months.map(m => m.year_month), yearGroup.year);
          _refreshAllOpenFlyoutRowStates();
        }
      },
    });
    titlebar.addEventListener('mouseenter', () => closeSubPanel());
    panel.appendChild(titlebar);

    const body = document.createElement('div');
    body.className = 'ns-menu-body';
    body.addEventListener('scroll', () => closeSubPanel(), { passive: true });

    months.forEach(m => {
      const row = document.createElement('div');
      row.className = 'ns-menu-item ns-filter-item';
      const displayMonth = m.month ? `${parseInt(m.month, 10)}月` : m.year_month;

      row._syncState = () => {
        const isMonthActive = Boolean(state.selectedYearMonths && state.selectedYearMonths.has(m.year_month));
        const datesInMonth = state.selectedDates
          ? Array.from(state.selectedDates).filter(d => d.startsWith(`${m.year_month}-`)).length
          : 0;
        row.classList.toggle('is-filter-include', isMonthActive);
        row.classList.toggle('has-child-filter', !isMonthActive && datesInMonth > 0);
        const holder = row.querySelector('.ns-filter-state-holder');
        if (holder) {
          holder.innerHTML = (!isMonthActive && datesInMonth > 0)
            ? `<span class="child-filter-badge is-accent">+${datesInMonth}日</span>`
            : '';
        }
      };

      row.innerHTML = `
        <span class="ns-item-main">
          <span class="ns-item-label">${_esc(displayMonth)}</span>
        </span>
        <span class="ns-filter-state-holder"></span>
        <span class="ns-item-count">${Number(m.count || 0)}</span>
        <span class="ns-item-arrow">▸</span>
      `;
      row._syncState();

      row.addEventListener('mouseenter', () => {
        if (subHoverTimer) { clearTimeout(subHoverTimer); subHoverTimer = null; }
        if (activeRowEl === row && activeChildPanel) return;
        subHoverTimer = setTimeout(() => {
          closeSubPanel();
          activeRowEl = row;
          row.classList.add('is-active-cascade');
          const subPanel = _createHistoriaMiniCalPanel(m, true);
          activeChildPanel = subPanel;
          _mountChildCascadePanel(panel, row, subPanel);
        }, _scaledHoverDelay(SUB_CASCADE_DELAY_MS));
      });

      row.addEventListener('click', e => {
        e.stopPropagation();
        if (subHoverTimer) {
          clearTimeout(subHoverTimer);
          subHoverTimer = null;
        }
        if (typeof toggleTimelineYearMonth === 'function') {
          state.miniCalendarYm = m.year_month;
          toggleTimelineYearMonth(m.year_month);
          _refreshAllOpenFlyoutRowStates();
        }
      });

      body.appendChild(row);
    });

    panel.appendChild(body);
    return panel;
  }

  /* ==========================================================================
     4. Gear（カメラ → レンズ）カスケードパネル生成
     ========================================================================== */
  function _createCameraLensesPanel(cameraItem, isChildPanel) {
    const camModel = cameraItem.camModel;
    const lenses = Array.isArray(cameraItem.lenses) ? cameraItem.lenses : [];
    const panel = document.createElement('div');
    panel.className = `ns-cascade-panel ns-filter-panel${isChildPanel ? ' ns-child-panel' : ''}`;
    panel.addEventListener('click', e => e.stopPropagation());

    const titlebar = _createIntegratedTitlebar({
      icon: '📷',
      title: camModel,
      badgeText: `${Number(cameraItem.count || 0)}`,
      metaLines: [],
      syncStateFn: el => {
        const mode = (state.cameraFilters && state.cameraFilters.get(camModel)) ||
          (state.selectedCameras && state.selectedCameras.has(camModel) ? 'include' : null);
        el.classList.toggle('is-filter-include', mode === 'include');
        el.classList.toggle('is-filter-exclude', mode === 'exclude');
        const holder = el.querySelector('.ns-filter-state-holder');
        if (holder) {
          holder.innerHTML = mode === 'include'
            ? '<span class="ns-state-pill is-include">[+]</span>'
            : (mode === 'exclude' ? '<span class="ns-state-pill is-exclude">[-]</span>' : '');
        }
      },
      onClick: () => {
        if (typeof toggleCameraFilter === 'function') {
          toggleCameraFilter(camModel);
          _refreshAllOpenFlyoutRowStates();
        }
      },
    });
    panel.appendChild(titlebar);

    const body = document.createElement('div');
    body.className = 'ns-menu-body';

    lenses.forEach(lens => {
      const lensModel = lens.lens_model;
      const lensLabel = lens.label || lensModel;
      const lensKey = `${camModel}::${lensModel}`;

      const row = document.createElement('div');
      row.className = 'ns-menu-item ns-filter-item';
      row._syncState = () => {
        const mode = state.lensFilters ? (state.lensFilters.get(lensKey) || state.lensFilters.get(lensModel) || null) : null;
        row.classList.toggle('is-filter-include', mode === 'include');
        row.classList.toggle('is-filter-exclude', mode === 'exclude');
        const holder = row.querySelector('.ns-filter-state-holder');
        if (holder) {
          holder.innerHTML = mode === 'include'
            ? '<span class="ns-state-pill is-include">[+]</span>'
            : (mode === 'exclude' ? '<span class="ns-state-pill is-exclude">[-]</span>' : '');
        }
      };

      row.innerHTML = `
        <span class="ns-item-main">
          <span class="ns-item-label">${_esc(lensLabel)}</span>
        </span>
        <span class="ns-filter-state-holder"></span>
        <span class="ns-item-count">${Number(lens.count || 0)}</span>
      `;
      row._syncState();

      row.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof toggleLensFilter === 'function') {
          toggleLensFilter(lensKey, lensLabel);
          _refreshAllOpenFlyoutRowStates();
        }
      });

      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        if (!state.lensFilters) state.lensFilters = new Map();
        const cur = state.lensFilters.get(lensKey);
        if (cur === 'exclude') {
          state.lensFilters.delete(lensKey);
        } else {
          state.lensFilters.set(lensKey, 'exclude');
        }
        if (typeof syncCameraAndLensFilterTitle === 'function') {
          syncCameraAndLensFilterTitle();
        }
        _refreshAllOpenFlyoutRowStates();
      });

      body.appendChild(row);
    });

    panel.appendChild(body);
    return panel;
  }

  /* ==========================================================================
     5. Folder（ドライブ・ショートカット・サブフォルダ）カスケードパネル生成
     ========================================================================== */
  function _buildFolderTitlebarMetaLines(folderNode) {
    const lines = [];
    if (folderNode.path) {
      lines.push(`<span class="ns-meta-mono">${_esc(folderNode.path)}</span>`);
    }
    const subParts = [];
    if (folderNode.volumeSerial) {
      subParts.push(`VSN:${_esc(folderNode.shortSerial || folderNode.volumeSerial)}`);
    }
    const total = Number(folderNode.total || 0);
    if (total > 0 && folderNode.kind === 'folder') {
      const directCnt = Number(folderNode.count || 0);
      const subCnt = folderNode.subCount !== undefined
        ? Number(folderNode.subCount || 0)
        : Math.max(0, total - directCnt);
      subParts.push(`直下 ${directCnt.toLocaleString()} · 子 ${subCnt.toLocaleString()}`);
    }
    if (folderNode.kind === 'offline' || folderNode.isOffline) {
      subParts.push('未接続');
    } else if (folderNode.isMissing) {
      subParts.push('消失');
    } else if (folderNode.isStorage) {
      subParts.push('Loome');
    } else if (folderNode.status === 'ignored') {
      subParts.push('除外');
    } else if (folderNode.status === 'unmanaged') {
      subParts.push('未登録');
    }
    if (subParts.length > 0) {
      lines.push(subParts.join(' · '));
    }
    return lines;
  }

  function _createFolderCascadePanel(folderNode, isChildPanel) {
    const api = window._ftCascadeApi;
    const panel = document.createElement('div');
    panel.className = `ns-cascade-panel ns-filter-panel${isChildPanel ? ' ns-child-panel' : ''}${folderNode.hasChildren ? '' : ' is-leaf-panel'}`;
    panel.addEventListener('click', e => e.stopPropagation());

    let activeChildPanel = null;
    let activeRowEl = null;
    let subHoverTimer = null;

    const closeSubPanel = () => {
      if (subHoverTimer) {
        clearTimeout(subHoverTimer);
        subHoverTimer = null;
      }
      if (activeChildPanel && activeChildPanel.parentNode) {
        activeChildPanel.parentNode.removeChild(activeChildPanel);
      }
      activeChildPanel = null;
      if (activeRowEl) {
        activeRowEl.classList.remove('is-active-cascade');
        activeRowEl = null;
      }
    };

    const iconChar = folderNode.isStorage ? '📦' : (folderNode.kind === 'drive' ? '💾' : '📁');
    const countNum = Number(folderNode.total || folderNode.count || 0);

    const titlebar = _createIntegratedTitlebar({
      icon: iconChar,
      title: folderNode.name,
      badgeText: countNum > 0 ? countNum.toLocaleString() : '',
      metaLines: _buildFolderTitlebarMetaLines(folderNode),
      syncStateFn: el => {
        const fState = api && api.filterState ? api.filterState(folderNode) : null;
        el.classList.toggle('is-filter-include', fState === 'include');
        el.classList.toggle('is-filter-exclude', fState === 'exclude');
        const holder = el.querySelector('.ns-filter-state-holder');
        if (holder) {
          holder.innerHTML = fState === 'include'
            ? '<span class="ns-state-pill is-include">[+]</span>'
            : (fState === 'exclude' ? '<span class="ns-state-pill is-exclude">[-]</span>' : '');
        }
      },
      onClick: () => {
        if (api && typeof api.handleClick === 'function') {
          api.handleClick(folderNode);
          _refreshAllOpenFlyoutRowStates();
        }
      },
      onContextMenu: e => {
        if (api && typeof api.handleContextMenu === 'function') {
          api.handleContextMenu(e, folderNode);
        }
      },
    });
    titlebar.addEventListener('mouseenter', () => closeSubPanel());
    panel.appendChild(titlebar);

    if (!folderNode.hasChildren) {
      return panel;
    }

    const body = document.createElement('div');
    body.className = 'ns-menu-body';
    body.innerHTML = '<div class="submenu-folder-loading" style="padding:8px 11px; font-size:0.74rem; color:var(--text-muted,#94a3b8);">読み込み中...</div>';
    panel.appendChild(body);

    body.addEventListener('scroll', () => closeSubPanel(), { passive: true });

    if (api && typeof api.fetchChildren === 'function') {
      api.fetchChildren(folderNode)
        .then(data => {
          if (!panel.isConnected) return;
          const rawChildren = (data && data.children) || [];
          body.innerHTML = '';

          if (rawChildren.length === 0) {
            body.style.display = 'none';
            panel.classList.add('is-leaf-panel');
            return;
          }

          rawChildren.forEach(c => {
            const childNode = api.makeChildNode(folderNode, c);
            const row = document.createElement('div');
            row.className = 'ns-menu-item ns-filter-item';
            if (childNode.isMissing) row.classList.add('is-missing');
            if (childNode.status === 'ignored') row.classList.add('is-ignored');

            row._syncState = () => {
              const fState = api.filterState ? api.filterState(childNode) : null;
              row.classList.toggle('is-filter-include', fState === 'include');
              row.classList.toggle('is-filter-exclude', fState === 'exclude');
              const holder = row.querySelector('.ns-filter-state-holder');
              if (holder) {
                holder.innerHTML = fState === 'include'
                  ? '<span class="ns-state-pill is-include">[+]</span>'
                  : (fState === 'exclude' ? '<span class="ns-state-pill is-exclude">[-]</span>' : '');
              }
            };

            const totalCnt = Number(childNode.total || 0);
            const countBadgeHtml = totalCnt > 0
              ? `<span class="ns-item-count">${totalCnt.toLocaleString()}</span>`
              : (childNode.hasManaged ? '<span class="folder-managed-dot">●</span>' : '');

            row.innerHTML = `
              <span class="ns-item-icon" style="font-size:0.84rem;">📁</span>
              <span class="ns-item-main">
                <span class="ns-item-label">${_esc(childNode.name)}</span>
              </span>
              <span class="ns-filter-state-holder"></span>
              ${countBadgeHtml}
              ${childNode.hasChildren ? '<span class="ns-item-arrow">▸</span>' : ''}
            `;
            row._syncState();

            row.addEventListener('mouseenter', () => {
              if (subHoverTimer) { clearTimeout(subHoverTimer); subHoverTimer = null; }
              if (activeRowEl === row && activeChildPanel) return;
              const delay = childNode.hasChildren ? _scaledHoverDelay(SUB_CASCADE_DELAY_MS) : _scaledHoverDelay(LEAF_PROP_DELAY_MS);
              subHoverTimer = setTimeout(() => {
                closeSubPanel();
                activeRowEl = row;
                row.classList.add('is-active-cascade');
                const subPanel = _createFolderCascadePanel(childNode, true);
                activeChildPanel = subPanel;
                _mountChildCascadePanel(panel, row, subPanel);
              }, delay);
            });

            row.addEventListener('click', e => {
              e.stopPropagation();
              if (subHoverTimer) {
                clearTimeout(subHoverTimer);
                subHoverTimer = null;
              }
              api.handleClick(childNode);
              _refreshAllOpenFlyoutRowStates();
            });

            row.addEventListener('contextmenu', e => {
              api.handleContextMenu(e, childNode);
            });

            body.appendChild(row);
          });
        })
        .catch(() => {
          if (panel.isConnected) {
            body.style.display = 'none';
          }
        });
    }

    return panel;
  }

  function _refreshAllOpenFlyoutRowStates() {
    if (!_flyoutRootEl) return;
    _flyoutRootEl.querySelectorAll('.ns-filter-item, .ns-direct-dest-item, .mini-cal-cell').forEach(el => {
      if (typeof el._syncState === 'function') {
        el._syncState();
      }
    });
  }

  /* ==========================================================================
     ルートフライアウトの表示制御
     ========================================================================== */
  function _openRootFlyoutForCard(cardEl) {
    if (!cardEl || !cardEl.isConnected || !_canOpenCardPanel(cardEl)) return;

    const sidebarEl = document.querySelector('.sidebar');
    if (!sidebarEl || sidebarEl.classList.contains('collapsed')) return;

    _destroyFlyoutDomOnly();

    let rootPanel = null;
    if (cardEl.classList.contains('tag-pill-item')) {
      const resolvedTagNode = _resolveCardTagNode(cardEl);
      if (resolvedTagNode) {
        rootPanel = _createTagCascadePanel(resolvedTagNode, false);
      }
    } else if (cardEl.classList.contains('location-node-row') && cardEl._locationNode) {
      if (cardEl._locationNode.level === 'country') {
        rootPanel = _createLocationStatesPanel(cardEl._locationNode, false);
      } else if (cardEl._locationNode.level === 'state') {
        rootPanel = _createLocationCitiesPanel(cardEl._locationNode.country, cardEl._locationNode, false);
      }
    } else if (cardEl.classList.contains('timeline-year-header') && cardEl._yearGroup) {
      rootPanel = _createHistoriaMonthsPanel(cardEl._yearGroup, false);
    } else if (cardEl.classList.contains('timeline-month-item') && cardEl._monthItem) {
      rootPanel = _createHistoriaMiniCalPanel(cardEl._monthItem, false);
    } else if (cardEl.classList.contains('camera-tree-item') && cardEl._cameraItem) {
      rootPanel = _createCameraLensesPanel(cardEl._cameraItem, false);
    } else if (cardEl.classList.contains('folder-tree-item') && cardEl._ftNode) {
      rootPanel = _createFolderCascadePanel(cardEl._ftNode, false);
    }

    if (!rootPanel) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'nsFilterFlyoutRoot';
    wrapper.className = 'ns-filter-flyout-root';
    wrapper.appendChild(rootPanel);

    wrapper.addEventListener('mouseenter', () => {
      _clearCloseTimer();
    });
    wrapper.addEventListener('mouseleave', e => {
      const nextTarget = e.relatedTarget;
      if (nextTarget && nextTarget.closest && nextTarget.closest('.sidebar')) {
        return;
      }
      _scheduleCloseFlyout(CLOSE_GRACE_MS);
    });

    const sidebarRect = sidebarEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const leftPx = Math.round(sidebarRect.right + 2);
    const rawTopPx = Math.max(8, Math.round(cardRect.top - 2));

    wrapper.style.left = `${leftPx}px`;
    wrapper.style.top = `${rawTopPx}px`;
    document.body.appendChild(wrapper);

    _flyoutRootEl = wrapper;
    _activeCardKey = _getCardIdentityKey(cardEl);
    cardEl.classList.add('is-ns-flyout-open');

    const clampRootPos = () => {
      if (!wrapper.isConnected) return;
      const rect = rootPanel.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - 8) {
        const shiftedTop = Math.max(8, rawTopPx - (rect.bottom - (window.innerHeight - 8)));
        wrapper.style.top = `${Math.round(shiftedTop)}px`;
      }
    };
    clampRootPos();
    requestAnimationFrame(clampRootPos);
  }

  /* ==========================================================================
     イベント初期化
     ========================================================================== */
  function _initSidebarCascadeFlyout() {
    const sidebarEl = document.querySelector('.sidebar');
    if (!sidebarEl || sidebarEl.dataset.nsCascadeBound === '1') return;
    sidebarEl.dataset.nsCascadeBound = '1';

    const handlePointerOnSidebar = e => {
      const cardEl = e.target.closest ? e.target.closest(CARD_SELECTOR) : null;

      if (!cardEl) {
        _hoveredCardEl = null;
        _clearOpenTimer();
        if (_flyoutRootEl) {
          _scheduleCloseFlyout(CLOSE_GRACE_MS);
        }
        return;
      }

      // カードおよび内包テキストのブラウザ標準ツールチップ（title）を除去して画面汚染を防止
      if (cardEl.hasAttribute('title')) {
        cardEl.removeAttribute('title');
      }

      if (e.target.closest && e.target.closest(ARROW_SELECTOR)) {
        _clearOpenTimer();
        return;
      }

      const cardKey = _getCardIdentityKey(cardEl);

      if (_flyoutRootEl && cardKey && cardKey === _activeCardKey) {
        _hoveredCardEl = cardEl;
        _clearCloseTimer();
        return;
      }

      if (cardEl !== _hoveredCardEl || !_openTimer) {
        _hoveredCardEl = cardEl;
        _clearOpenTimer();

        if (_canOpenCardPanel(cardEl)) {
          _clearCloseTimer();
          _openTimer = setTimeout(() => {
            _openTimer = null;
            if (_hoveredCardEl === cardEl && cardEl.isConnected) {
              _openRootFlyoutForCard(cardEl);
            }
          }, _scaledHoverDelay(HOVER_OPEN_DELAY_MS));
        } else if (_flyoutRootEl && cardKey !== _activeCardKey) {
          _scheduleCloseFlyout(CLOSE_GRACE_MS);
        }
      }
    };

    sidebarEl.addEventListener('mouseover', handlePointerOnSidebar, { passive: true });
    sidebarEl.addEventListener('mousemove', handlePointerOnSidebar, { passive: true });

    sidebarEl.addEventListener('mouseleave', e => {
      _hoveredCardEl = null;
      _clearOpenTimer();
      const nextTarget = e.relatedTarget;
      if (nextTarget && nextTarget.closest && nextTarget.closest('#nsFilterFlyoutRoot')) {
        return;
      }
      if (_flyoutRootEl) {
        _scheduleCloseFlyout(CLOSE_GRACE_MS);
      }
    });

    sidebarEl.addEventListener('mousedown', e => {
      _clearOpenTimer();
      if (e.target.closest && e.target.closest(ARROW_SELECTOR)) {
        closeFilterCascadeFlyout();
      }
    }, true);

    sidebarEl.addEventListener('click', e => {
      _clearOpenTimer();
      if (e.target.closest && e.target.closest(ARROW_SELECTOR)) {
        closeFilterCascadeFlyout();
      } else if (_flyoutRootEl) {
        setTimeout(() => _refreshAllOpenFlyoutRowStates(), 0);
      }
    }, true);

    const scrollArea = sidebarEl.querySelector('.sidebar-scroll-area');
    if (scrollArea) {
      scrollArea.addEventListener('scroll', () => {
        _clearOpenTimer();
        if (_flyoutRootEl) _destroyFlyoutDomOnly();
      }, { passive: true });
    }

    window.addEventListener('mousedown', e => {
      if (!_flyoutRootEl) return;
      if (e.target.closest && (e.target.closest('#nsFilterFlyoutRoot') || e.target.closest('.sidebar'))) {
        return;
      }
      closeFilterCascadeFlyout();
    });

    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _flyoutRootEl) {
        closeFilterCascadeFlyout();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initSidebarCascadeFlyout);
  } else {
    _initSidebarCascadeFlyout();
  }
})();
