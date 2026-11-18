/**
 * Tetheract Touch & Tablet Layout Controller (Layer 3)
 * スマホ（phone）⇄ タブレット（tablet）可変モード制御、PC版と完全統一された左垂直レール
 * （Folder / Binder / Tag / Historia / Place / Gear / Art Framer / Search）＆右インスペクタを担う。
 */
(function (global) {
  'use strict';

  const STORAGE_KEY_DEVICE_MODE = 'tetheract_touch_device_mode';
  const STORAGE_KEY_SHEET_PIN = 'tetheract_touch_sheet_pinned';

  // PC版 (index.html #sidebarRail) と完全同一の順序・アイコン定義（Binder先頭）
  const PERSPECTIVES = [
    { id: 'binder', label: 'Binder', subLabel: '条件セット', group: 'top', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="10" y="10" width="7.5" height="7.5"/><line x1="3.6" y1="3.6" x2="10" y2="10"/><line x1="20.4" y1="3.6" x2="17.5" y2="10"/><line x1="20.4" y1="20.4" x2="17.5" y2="17.5"/><line x1="3.6" y1="20.4" x2="10" y2="17.5"/></svg>' },
    { id: 'folder', label: 'Folder', subLabel: 'フォルダ', group: 'top', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' },
    { id: 'tag', label: 'Tag', subLabel: 'タグ', group: 'main', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>' },
    { id: 'historia', label: 'Historia', subLabel: '撮影年月', group: 'main', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' },
    { id: 'place', label: 'Place', subLabel: '撮影地', group: 'main', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 9.5c0 5.5-7.5 10.5-7.5 10.5S4.5 15 4.5 9.5a7.5 7.5 0 0 1 15 0z"/><circle cx="12" cy="9.5" r="2.6"/><path d="M17.9 19a7.5 2 0 1 1-11.8 0"/></svg>' },
    { id: 'gear', label: 'Gear', subLabel: 'カメラ・レンズ', group: 'main', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' },
    { id: 'artframer', label: 'Framer', subLabel: 'マスク・プリント枠', group: 'bottom', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="10" height="10" rx="1"/><circle cx="15" cy="9" r="0.9"/></svg>' },
    { id: 'search', label: 'Search', subLabel: 'ファイル名検索', group: 'bottom', svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' },
  ];

  // パースペクティブ別の外部カード・拡張セクション描画関数レジストリ（id -> Array<Function>）
  const perspectiveRenderers = {};

  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const _escAttr = _escHtml;

  // ローカルタイム文字列生成（UTCズレ防止・ローカル時刻規約準拠）
  function formatLocalTime(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  function _safeGetStorage(key, fallback = null) {
    try {
      const val = global.localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch (e) { return fallback; }
  }

  function _safeSetStorage(key, val) {
    try { global.localStorage.setItem(key, String(val)); } catch (e) {}
  }

  const state = {
    preferredMode: _safeGetStorage(STORAGE_KEY_DEVICE_MODE, 'auto'),
    resolvedMode: 'phone',
    activePerspective: 'tag',
    lastFilterPerspective: 'tag',
    sheetOpen: false,
    sheetPinned: _safeGetStorage(STORAGE_KEY_SHEET_PIN, '0') === '1',
    tabletStageOpen: false,
    tabletInspectorOpen: true,
    lockerStatus: { usbConnected: false, cachedCount: 0, pendingCount: 0, lastSyncedAt: '', updateAvailable: false, updateVersion: '' },
    onPerspectiveSelect: null,
    onConditionPicked: null,
  };

  function resolveDeviceMode(preference) {
    const pref = preference || state.preferredMode || 'auto';
    if (pref === 'phone' || pref === 'tablet') return pref;
    const w = global.innerWidth || document.documentElement.clientWidth || 375;
    const h = global.innerHeight || document.documentElement.clientHeight || 667;
    return Math.min(w, h) >= 600 ? 'tablet' : 'phone';
  }

  function applyDeviceMode(preference) {
    if (preference && ['auto', 'phone', 'tablet'].includes(preference)) {
      state.preferredMode = preference;
      _safeSetStorage(STORAGE_KEY_DEVICE_MODE, preference);
    }
    const prevResolved = state.resolvedMode;
    const resolved = resolveDeviceMode(state.preferredMode);
    state.resolvedMode = resolved;

    const w = global.innerWidth || document.documentElement.clientWidth || 375;
    const h = global.innerHeight || document.documentElement.clientHeight || 667;
    const root = document.documentElement;
    root.setAttribute('data-device-mode', resolved);
    root.setAttribute('data-device-mode-pref', state.preferredMode);
    root.setAttribute('data-orientation', w > h ? 'landscape' : 'portrait');

    const brandSuffix = resolved === 'tablet' ? 'Ld' : 'Rg';
    const suffixEl = document.getElementById('mBrandSuffixText');
    if (suffixEl && suffixEl.textContent !== brandSuffix) {
      suffixEl.textContent = brandSuffix;
    }
    const wordmarkSvg = document.getElementById('mBrandWordmarkSvg');
    if (wordmarkSvg) {
      wordmarkSvg.setAttribute('aria-label', `TETHERACT ${brandSuffix}`);
    }

    _syncModeToggleButtons();
    _syncResponsiveShellVisibility();

    if (prevResolved !== resolved) {
      global.dispatchEvent(
        new CustomEvent('tetheract:device-mode-change', {
          detail: { mode: resolved, preference: state.preferredMode, timestamp: formatLocalTime() },
        })
      );
    }
    return resolved;
  }

  function cycleDeviceMode(explicitMode) {
    const order = ['auto', 'phone', 'tablet'];
    const next =
      explicitMode && order.includes(explicitMode)
        ? explicitMode
        : order[(order.indexOf(state.preferredMode) + 1) % order.length];
    return applyDeviceMode(next);
  }

  function _syncModeToggleButtons() {
    document.querySelectorAll('[data-touch-mode-option]').forEach((btn) => {
      const isActive = btn.getAttribute('data-touch-mode-option') === state.preferredMode;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function _syncBottomNavActive() {
    if (document.body) {
      document.body.classList.toggle('has-open-nav-sheet', Boolean(state.sheetOpen));
    }
    const isAfPick = Boolean(document.body && document.body.classList.contains('is-af-pick-mode'));
    const activeTab = state.sheetOpen ? 'filter' : (isAfPick ? 'artframer' : '');
    document.querySelectorAll('#tPhoneBottomNav [data-bnav]').forEach((btn) => {
      btn.classList.toggle('is-active', Boolean(activeTab) && btn.getAttribute('data-bnav') === activeTab);
    });
  }

  function _syncResponsiveShellVisibility() {
    const rail = document.getElementById('tTabletRail');
    const stage = document.getElementById('tTabletStage');
    const inspector = document.getElementById('tTabletInspector');
    const inspectorBtn = document.getElementById('tTabletInspectorToggleBtn');
    const sheet = document.getElementById('tTouchNavSheet');

    if (state.resolvedMode === 'tablet') {
      if (rail) rail.style.display = 'flex';
      if (stage) stage.classList.toggle('is-open', state.tabletStageOpen);
      if (inspector) inspector.classList.toggle('is-collapsed', !state.tabletInspectorOpen);
      if (inspectorBtn) {
        inspectorBtn.style.display = 'inline-flex';
        inspectorBtn.classList.toggle('active', state.tabletInspectorOpen);
      }
      if (sheet && state.sheetOpen) closePerspectiveSheet();
    } else {
      if (rail) rail.style.display = 'none';
      if (stage) stage.classList.remove('is-open');
      if (inspectorBtn) inspectorBtn.style.display = 'none';
    }
  }

  function mountDeviceModeToggle(targetSelectorOrEl) {
    const headerRight = document.querySelector('.m-header-right');
    const settingsMount = document.getElementById('mDeviceModeSwitchMount');
    const container =
      typeof targetSelectorOrEl === 'string'
        ? document.querySelector(targetSelectorOrEl)
        : targetSelectorOrEl || settingsMount || headerRight;
    if (container && !container.querySelector('.t-mode-switch-group')) {
      const wrap = document.createElement('div');
      wrap.className = 't-mode-switch-group';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', '表示モード切替');
      wrap.innerHTML = `
        <button type="button" class="t-mode-switch-btn" data-touch-mode-option="auto" title="画面サイズで自動判定 (Auto)"><span>Auto (自動)</span></button>
        <button type="button" class="t-mode-switch-btn" data-touch-mode-option="phone" title="スマホ1ペイン表示 (Phone)"><span>Phone (スマホ)</span></button>
        <button type="button" class="t-mode-switch-btn" data-touch-mode-option="tablet" title="タブレット3ペイン表示 (Tablet)"><span>Tablet (3ペイン)</span></button>
      `;
      wrap.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-touch-mode-option]');
        if (btn) applyDeviceMode(btn.getAttribute('data-touch-mode-option'));
      });
      container.appendChild(wrap);
    }

    // タブレットモード時のみ表示する右インスペクタ開閉ボタンをヘッダー右端へ配置
    if (headerRight && !document.getElementById('tTabletInspectorToggleBtn')) {
      const inspBtn = document.createElement('button');
      inspBtn.type = 'button';
      inspBtn.id = 'tTabletInspectorToggleBtn';
      inspBtn.className = 'm-icon-btn active';
      inspBtn.title = '右インスペクタ（詳細パネル）を開閉';
      inspBtn.setAttribute('aria-label', '詳細パネルを開閉');
      inspBtn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.85"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>';
      inspBtn.addEventListener('click', () => {
        state.tabletInspectorOpen = !state.tabletInspectorOpen;
        inspBtn.classList.toggle('active', state.tabletInspectorOpen);
        const inspector = document.getElementById('tTabletInspector');
        if (inspector) inspector.classList.toggle('is-collapsed', !state.tabletInspectorOpen);
      });
      headerRight.appendChild(inspBtn);
    }

    _syncModeToggleButtons();
  }

  function _buildRailButtonsHtml() {
    let html = '';
    PERSPECTIVES.forEach((p, idx) => {
      if (idx === 1) html += '<div class="t-rail-divider" aria-hidden="true"></div>';
      if (idx === 2) html += '<div class="t-rail-gap" aria-hidden="true"></div>';
      if (p.id === 'artframer') html += '<div class="t-rail-spacer" aria-hidden="true"></div>';
      const active = p.id === state.activePerspective && state.tabletStageOpen ? 'is-active' : '';
      html += `
        <button type="button" class="t-rail-btn ${active}" data-perspective-id="${_escAttr(p.id)}" title="${_escAttr(p.label)} — ${_escAttr(p.subLabel)}">
          <span class="t-rail-icon">${p.svg}</span>
          <span class="t-rail-label">${_escHtml(p.label)}</span>
        </button>`;
    });
    return html;
  }

  function mountResponsiveWorkspace() {
    const appRoot = document.querySelector('.m-app') || document.body;
    if (!appRoot) return;

    // 1. Tablet用 3ペインラッパー（左54pxレール + 折りたたみツリーステージ + 中央グリッド + 右インスペクタ）
    const mainScroll = document.getElementById('mScrollContainer');
    if (mainScroll && !document.getElementById('tTabletWorkspace')) {
      const workspace = document.createElement('div');
      workspace.id = 'tTabletWorkspace';
      workspace.className = 't-tablet-workspace';
      mainScroll.parentNode.insertBefore(workspace, mainScroll);

      const rail = document.createElement('nav');
      rail.id = 'tTabletRail';
      rail.className = 't-tablet-rail';
      rail.setAttribute('aria-label', 'サイドバー切替タブ');
      rail.innerHTML = _buildRailButtonsHtml();

      const stage = document.createElement('aside');
      stage.id = 'tTabletStage';
      stage.className = 't-tablet-stage';
      stage.innerHTML = `
        <div class="t-stage-header">
          <span id="tTabletStageTitle" class="t-stage-title">Tag / タグ</span>
          <button type="button" id="tTabletStageCloseBtn" class="t-icon-close-btn" aria-label="ツリーを閉じる">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        </div>
        <div id="tTabletStageBody" class="t-stage-body"></div>`;

      // 右インスペクタ（評価順序: 優・良・可・棄、記号なし）
      const inspector = document.createElement('aside');
      inspector.id = 'tTabletInspector';
      inspector.className = 't-tablet-inspector';
      inspector.innerHTML = `
        <div class="t-inspector-preview-4x3" id="tInspectorPreviewBox" title="タップでフルスクリーンビューアを開く">
          <img id="tInspectorPreviewImg" class="t-inspector-preview-img" src="" alt="" style="display:none;" decoding="async">
          <button type="button" id="tInspectorOpenViewerBtn" class="t-inspector-expand-btn" style="display:none;" title="フルスクリーン拡大表示">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            <span>拡大</span>
          </button>
          <div id="tInspectorEmptyHint" class="t-inspector-empty">写真をタップするとインスペクタに表示、ダブルタップで拡大ビューアを開きます</div>
        </div>
        <div class="t-inspector-body">
          <div id="tInspectorFileTitle" class="t-inspector-filename">-</div>
          <div id="tInspectorSubMeta" class="t-inspector-submeta"></div>
          <div class="t-inspector-rate-bar" id="tInspectorRateBar">
            <button type="button" class="t-inspector-rate-btn is-excellent" data-inspector-rate="2">優</button>
            <button type="button" class="t-inspector-rate-btn is-good" data-inspector-rate="1">良</button>
            <button type="button" class="t-inspector-rate-btn is-normal" data-inspector-rate="0">可</button>
            <button type="button" class="t-inspector-rate-btn is-discard" data-inspector-rate="-1">棄</button>
          </div>
          <button type="button" id="tInspectorArtFramerBtn" class="t-inspector-af-btn" style="display:none;" title="Art Framer（プライバシーマスク・プリント枠・共有）">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="10" height="10" rx="1"/><circle cx="15" cy="9" r="1"/></svg>
            <span>Art Framer で仕上げる</span>
          </button>
          <div id="tInspectorQuickExif" class="t-inspector-quick-exif"></div>
          <div class="t-inspector-section-head">
            <span class="t-inspector-section-label">付与タグ</span>
            <button type="button" id="tInspectorOpenTagSheetBtn" class="t-inspector-link-btn">＋ ツリーから選ぶ</button>
          </div>
          <div id="tInspectorTags" class="t-inspector-tags"></div>
          <div class="t-inspector-inline-tag-form">
            <input type="text" id="tInspectorNewTagInput" class="t-inspector-tag-input" placeholder="タグを追加 (親/子)..." autocomplete="off">
            <button type="button" id="tInspectorAddTagBtn" class="t-inspector-tag-add-btn">追加</button>
          </div>
        </div>`;

      workspace.appendChild(rail);
      workspace.appendChild(stage);
      workspace.appendChild(mainScroll);
      workspace.appendChild(inspector);
      _bindTabletRailEvents(rail, stage);
      _bindTabletInspectorEvents(inspector);
    }

    // 2. Phone用 統合ボトムシート（絞り込み7視点）
    if (!document.getElementById('tTouchNavSheet')) {
      const sheetOverlay = document.createElement('div');
      sheetOverlay.id = 'tTouchNavSheetOverlay';
      sheetOverlay.className = 't-nav-sheet-overlay';
      sheetOverlay.style.display = 'none';

      const sheetTabs = PERSPECTIVES.filter((p) => p.id !== 'artframer');
      const shortJpMap = { folder: 'フォルダ', binder: '条件', tag: 'タグ', historia: '年月', place: '場所', gear: '機材', search: '検索' };
      const sheet = document.createElement('section');
      sheet.id = 'tTouchNavSheet';
      sheet.className = 't-nav-sheet';
      sheet.setAttribute('aria-label', '絞り込みシート');
      sheet.innerHTML = `
        <div class="t-nav-sheet-handle-wrap" id="tNavSheetDragHandle"><div class="t-nav-sheet-handle"></div></div>
        <div class="t-nav-sheet-body" id="tNavSheetBody"></div>
        <div class="t-nav-sheet-header">
          <div class="t-nav-sheet-title-group">
            <span class="t-nav-sheet-title" id="tNavSheetActiveTitle">絞り込み</span>
            <span class="t-nav-sheet-hint" id="tNavSheetDismissHint">${state.sheetPinned ? 'ピン留め中（連続選択）' : '条件タップで自動収納'}</span>
          </div>
          <div class="t-nav-sheet-actions">
            <button type="button" id="tTouchNavResetBtn" class="t-pin-toggle-btn" title="すべての絞り込み条件をリセット">
              <span>全解除</span>
            </button>
            <button type="button" id="tTouchNavPinBtn" class="t-pin-toggle-btn ${state.sheetPinned ? 'is-pinned' : ''}" title="複数条件を連続で選ぶ場合はピン留めON">
              <span>連続ピン</span>
            </button>
            <button type="button" id="tTouchNavCloseBtn" class="t-icon-close-btn" aria-label="閉じる">✕</button>
          </div>
        </div>
        <div class="t-perspective-tabs" id="tPerspectiveTabBar" role="tablist">
          ${sheetTabs.map(
            (p) => `
            <button type="button" role="tab" class="t-perspective-tab ${p.id === state.activePerspective ? 'is-active' : ''}"
                    data-perspective-id="${_escAttr(p.id)}" aria-selected="${p.id === state.activePerspective ? 'true' : 'false'}">
              <span class="t-perspective-tab-icon">${p.svg}</span>
              <span class="t-perspective-tab-label">${_escHtml(shortJpMap[p.id] || p.label)}</span>
            </button>`
          ).join('')}
        </div>`;

      sheetOverlay.appendChild(sheet);
      appRoot.appendChild(sheetOverlay);
      _bindPerspectiveSheetEvents(sheetOverlay, sheet);
    }

    // 3. Phone用 3カラム親指ボトムナビゲーションバー（左: フィルタ / 中央: 丸型GPSダイヤル / 右: ArtFramer）
    if (!document.getElementById('tPhoneBottomNav')) {
      const bnav = document.createElement('nav');
      bnav.id = 'tPhoneBottomNav';
      bnav.className = 't-phone-bottom-nav';
      bnav.setAttribute('aria-label', 'ボトムナビゲーション');
      bnav.innerHTML = `
        <button type="button" class="t-bnav-btn" data-bnav="filter" title="絞り込み条件シートを開閉">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          <span>フィルタ</span>
          <span id="tBnavFilterDot" class="t-bnav-dot" style="display:none;"></span>
        </button>
        <div id="tCenterDialSlot" class="t-center-dial-slot"></div>
        <button type="button" class="t-bnav-btn" data-bnav="artframer" title="Art Framer — プライバシーマスク・プリント枠・SNS共有">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="10" height="10" rx="1"/><circle cx="15" cy="9" r="0.9"/></svg>
          <span>ArtFramer</span>
        </button>
      `;
      appRoot.appendChild(bnav);
      global.TetheractTouchUI?.mountCenterDial?.(bnav.querySelector('#tCenterDialSlot'));

      bnav.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bnav]');
        if (!btn) return;
        const tab = btn.getAttribute('data-bnav');
        if (tab === 'filter') {
          if (state.sheetOpen) closePerspectiveSheet();
          else openPerspectiveSheet();
        } else if (tab === 'artframer') {
          closePerspectiveSheet();
          if (typeof global.__openOrSelectForMobileArtFramer === 'function') {
            global.__openOrSelectForMobileArtFramer();
          } else {
            global.TetheractTouchUI?.artFramer?.open?.();
          }
        }
      });
    }

    _bindExistingDrawerAutoDismiss();
  }

  function _bindExistingDrawerAutoDismiss() {
    const drawerBody = document.querySelector('.m-drawer-body');
    if (!drawerBody || drawerBody.dataset.touchAutoDismissBound === '1') return;
    drawerBody.dataset.touchAutoDismissBound = '1';

    drawerBody.addEventListener('click', (e) => {
      if (state.resolvedMode !== 'phone' || state.sheetPinned) return;
      if (e.target.closest('.m-tree-arrow, input, select, summary')) return;
      const item = e.target.closest('.m-filter-item, [data-filter-value]');
      if (!item || item.dataset.justSwiped === '1') return;
      setTimeout(() => {
        const closeBtn = document.getElementById('mCloseDrawerBtn');
        if (closeBtn) closeBtn.click();
      }, 110);
    });
  }

  function _bindPerspectiveSheetEvents(overlay, sheet) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePerspectiveSheet();
    });
    sheet.querySelector('#tTouchNavCloseBtn')?.addEventListener('click', closePerspectiveSheet);

    sheet.querySelector('#tTouchNavResetBtn')?.addEventListener('click', () => {
      document.getElementById('mDrawerResetBtn')?.click();
      setTimeout(() => _populatePerspectiveContent(state.activePerspective), 60);
    });

    const pinBtn = sheet.querySelector('#tTouchNavPinBtn');
    if (pinBtn) {
      pinBtn.addEventListener('click', () => {
        state.sheetPinned = !state.sheetPinned;
        _safeSetStorage(STORAGE_KEY_SHEET_PIN, state.sheetPinned ? '1' : '0');
        pinBtn.classList.toggle('is-pinned', state.sheetPinned);
        const hint = sheet.querySelector('#tNavSheetDismissHint');
        if (hint) {
          hint.textContent = state.sheetPinned ? 'ピン留め中（連続選択）' : '条件タップで自動収納';
        }
      });
    }

    sheet.querySelector('#tPerspectiveTabBar')?.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-perspective-id]');
      if (tab) selectPerspective(tab.getAttribute('data-perspective-id'));
    });

    const body = sheet.querySelector('#tNavSheetBody');
    if (body) {
      body.addEventListener('click', (e) => {
        if (e.target.closest('.m-tree-arrow, .m-tree-toggle-btn, .m-tree-tool-btn, .m-mini-cal-wrap, .t-tree-toggle, .t-perspective-ext-slot, input, select, button[data-no-dismiss]')) return;
        const condRow = e.target.closest('.m-filter-item, .t-filter-row, [data-filter-value]');
        if (!condRow || condRow.dataset.justSwiped === '1') return;
        if (!state.sheetPinned) setTimeout(closePerspectiveSheet, 90);
      });
    }
  }

  function _bindTabletRailEvents(rail, stage) {
    rail.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-perspective-id]');
      if (!btn) return;
      const pId = btn.getAttribute('data-perspective-id');
      if (pId === 'artframer') {
        if (typeof global.__openOrSelectForMobileArtFramer === 'function') {
          global.__openOrSelectForMobileArtFramer();
        } else {
          global.TetheractTouchUI?.artFramer?.open?.();
        }
        return;
      }
      if (state.activePerspective === pId && state.tabletStageOpen) {
        state.tabletStageOpen = false;
        stage.classList.remove('is-open');
        rail.querySelectorAll('[data-perspective-id]').forEach((el) => el.classList.remove('is-active'));
      } else {
        state.tabletStageOpen = true;
        stage.classList.add('is-open');
        selectPerspective(pId);
      }
    });

    stage.querySelector('#tTabletStageCloseBtn')?.addEventListener('click', () => {
      state.tabletStageOpen = false;
      stage.classList.remove('is-open');
      rail.querySelectorAll('[data-perspective-id]').forEach((el) => el.classList.remove('is-active'));
    });
  }

  function _syncSheetHeaderForPerspective() {
    const tabBar = document.getElementById('tPerspectiveTabBar');
    const resetBtn = document.getElementById('tTouchNavResetBtn');
    const pinBtn = document.getElementById('tTouchNavPinBtn');
    const hint = document.getElementById('tNavSheetDismissHint');
    if (tabBar) tabBar.style.display = '';
    if (resetBtn) resetBtn.style.display = '';
    if (pinBtn) pinBtn.style.display = '';
    if (hint) {
      hint.textContent = state.sheetPinned ? 'ピン留め中（連続選択）' : '条件タップで自動収納';
    }
  }

  function selectPerspective(perspectiveId) {
    const found = PERSPECTIVES.find((p) => p.id === perspectiveId && p.id !== 'artframer') || PERSPECTIVES[2];
    state.activePerspective = found.id;
    state.lastFilterPerspective = found.id;

    document.querySelectorAll('[data-perspective-id]').forEach((el) => {
      const isRailBtn = el.classList.contains('t-rail-btn');
      const active = el.getAttribute('data-perspective-id') === found.id && (!isRailBtn || state.tabletStageOpen);
      el.classList.toggle('is-active', active);
      if (el.getAttribute('role') === 'tab') el.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const stageTitle = document.getElementById('tTabletStageTitle');
    if (stageTitle) stageTitle.textContent = `${found.label} / ${found.subLabel}`;
    const sheetTitle = document.getElementById('tNavSheetActiveTitle');
    if (sheetTitle) sheetTitle.textContent = `${found.label} — ${found.subLabel}`;
    _syncSheetHeaderForPerspective();
    _syncBottomNavActive();

    _populatePerspectiveContent(found.id);
    if (typeof state.onPerspectiveSelect === 'function') state.onPerspectiveSelect(found.id);
    global.dispatchEvent(new CustomEvent('tetheract:perspective-change', { detail: { perspective: found.id } }));
  }

  function registerPerspectiveRenderer(perspectiveId, rendererFn) {
    if (!perspectiveId || typeof rendererFn !== 'function') return;
    const key = String(perspectiveId);
    if (!Array.isArray(perspectiveRenderers[key])) perspectiveRenderers[key] = [];
    if (!perspectiveRenderers[key].includes(rendererFn)) {
      perspectiveRenderers[key].push(rendererFn);
    }
    const isVisibleNow =
      state.activePerspective === key && (state.sheetOpen || (state.resolvedMode === 'tablet' && state.tabletStageOpen));
    if (isVisibleNow) _populatePerspectiveContent(key);
  }

  function _runRegisteredPerspectiveRenderers(perspectiveId, targetContainer) {
    const list = perspectiveRenderers[perspectiveId];
    if (!Array.isArray(list) || list.length === 0) return;
    list.forEach((fn) => {
      const slotEl = document.createElement('div');
      slotEl.className = 't-perspective-ext-slot';
      slotEl.setAttribute('data-perspective-slot', perspectiveId);
      if (perspectiveId === 'folder' && targetContainer.firstChild) {
        targetContainer.insertBefore(slotEl, targetContainer.firstChild);
      } else {
        targetContainer.appendChild(slotEl);
      }
      try {
        const res = fn(slotEl, targetContainer);
        if (res && typeof res === 'object' && res.nodeType === 1 && !slotEl.contains(res)) {
          slotEl.appendChild(res);
        } else if (typeof res === 'string' && res.trim() && !slotEl.innerHTML.trim()) {
          slotEl.innerHTML = res;
        }
      } catch (err) {
        console.warn(`Perspective renderer error (${perspectiveId}):`, err);
      }
      if (!slotEl.childNodes.length) slotEl.remove();
    });
  }

  function _populatePerspectiveContent(perspectiveId) {
    const targetContainer =
      state.resolvedMode === 'tablet'
        ? document.getElementById('tTabletStageBody')
        : document.getElementById('tNavSheetBody');
    if (!targetContainer) return;

    const samePerspective = state._lastPopulatedPerspective === perspectiveId;
    const prevScrollTop = samePerspective ? targetContainer.scrollTop : 0;
    state._lastPopulatedPerspective = perspectiveId;

    let baseRendered = false;
    if (typeof global.__renderTabletPerspectivePanel === 'function') {
      baseRendered = Boolean(global.__renderTabletPerspectivePanel(perspectiveId, targetContainer));
    }

    if (!baseRendered) {
      const sourceMap = {
        tag: '#mTagFilterList',
        historia: '#mTimelineFilterList',
        place: '#mLocationFilterList',
        gear: '#mCameraFilterList',
      };
      const selector = sourceMap[perspectiveId];
      if (selector) {
        const srcEl = document.querySelector(selector);
        if (srcEl && srcEl.innerHTML.trim()) {
          targetContainer.innerHTML = `<div class="t-perspective-cloned-list">${srcEl.innerHTML}</div>`;
          if (typeof global.__bindClonedFilterEvents === 'function') {
            global.__bindClonedFilterEvents(targetContainer);
          }
          if (global.TetheractTouchUI && typeof global.TetheractTouchUI.bindFilterRowGestures === 'function') {
            global.TetheractTouchUI.bindFilterRowGestures(targetContainer);
          }
          baseRendered = true;
        }
      }
    }

    if (!baseRendered) {
      const pInfo = PERSPECTIVES.find((p) => p.id === perspectiveId) || PERSPECTIVES[0];
      targetContainer.innerHTML = `
        <div class="t-perspective-placeholder" data-perspective-panel="${_escAttr(pInfo.id)}">
          <div class="t-perspective-placeholder-head">${pInfo.svg}<span>${_escHtml(pInfo.label)} (${_escHtml(pInfo.subLabel)})</span></div>
          <p class="t-perspective-placeholder-desc">項目をタップすると条件（AND）で絞り込みます。</p>
        </div>`;
    }

    _runRegisteredPerspectiveRenderers(perspectiveId, targetContainer);
    if (samePerspective && prevScrollTop > 0) targetContainer.scrollTop = prevScrollTop;
  }

  function openPerspectiveSheet(perspectiveId) {
    if (state.resolvedMode === 'tablet') {
      const stage = document.getElementById('tTabletStage');
      const rail = document.getElementById('tTabletRail');
      if (!perspectiveId && state.tabletStageOpen) {
        state.tabletStageOpen = false;
        if (stage) stage.classList.remove('is-open');
        rail?.querySelectorAll('[data-perspective-id]').forEach((el) => el.classList.remove('is-active'));
        return;
      }
      state.tabletStageOpen = true;
      if (stage) stage.classList.add('is-open');
      selectPerspective(perspectiveId || state.activePerspective);
      return;
    }

    const nextId = perspectiveId || state.activePerspective || state.lastFilterPerspective || 'tag';
    const overlay = document.getElementById('tTouchNavSheetOverlay');
    const sheet = document.getElementById('tTouchNavSheet');
    if (!overlay || !sheet) return;
    state.sheetOpen = true;
    selectPerspective(nextId);
    overlay.style.display = 'flex';
    requestAnimationFrame(() => sheet.classList.add('is-open'));
  }

  function closePerspectiveSheet() {
    const overlay = document.getElementById('tTouchNavSheetOverlay');
    const sheet = document.getElementById('tTouchNavSheet');
    state.sheetOpen = false;
    _syncBottomNavActive();
    if (sheet) sheet.classList.remove('is-open');
    if (overlay) {
      setTimeout(() => {
        if (!state.sheetOpen) overlay.style.display = 'none';
      }, 180);
    }
  }

  function updateLockerStatus(partialStatus) {
    if (!partialStatus || typeof partialStatus !== 'object') return;
    Object.assign(state.lockerStatus, partialStatus);
  }

  function _bindTabletInspectorEvents(inspector) {
    if (!inspector || inspector.dataset.inspectorEventsBound === '1') return;
    inspector.dataset.inspectorEventsBound = '1';

    inspector.querySelector('#tInspectorPreviewBox')?.addEventListener('click', () => {
      if (typeof global.__onTabletInspectorOpenViewer === 'function') global.__onTabletInspectorOpenViewer();
    });

    inspector.querySelector('#tInspectorRateBar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-inspector-rate]');
      if (!btn) return;
      const rate = Number(btn.getAttribute('data-inspector-rate'));
      if (typeof global.__onTabletInspectorRate === 'function') global.__onTabletInspectorRate(rate);
    });

    inspector.querySelector('#tInspectorOpenTagSheetBtn')?.addEventListener('click', () => {
      if (typeof global.__onTabletInspectorOpenTagSheet === 'function') global.__onTabletInspectorOpenTagSheet();
    });

    inspector.querySelector('#tInspectorArtFramerBtn')?.addEventListener('click', () => {
      if (global.TetheractTouchUI && global.TetheractTouchUI.artFramer && typeof global.TetheractTouchUI.artFramer.open === 'function') {
        global.TetheractTouchUI.artFramer.open();
      }
    });

    inspector.querySelector('#tInspectorTags')?.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-inspector-remove-tag]');
      if (!delBtn) return;
      const tag = delBtn.getAttribute('data-inspector-remove-tag');
      if (tag && typeof global.__onTabletInspectorRemoveTag === 'function') global.__onTabletInspectorRemoveTag(tag);
    });

    const tagInput = inspector.querySelector('#tInspectorNewTagInput');
    const tagAddBtn = inspector.querySelector('#tInspectorAddTagBtn');
    const submitInspectorTag = () => {
      if (!tagInput) return;
      const val = tagInput.value.trim().replace(/^\/+|\/+$/g, '');
      if (!val) return;
      tagInput.value = '';
      if (typeof global.__onTabletInspectorAddTag === 'function') global.__onTabletInspectorAddTag(val);
    };
    tagAddBtn?.addEventListener('click', submitInspectorTag);
    tagInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitInspectorTag();
      }
    });
  }

  function updateTabletInspector(photo, batchInfo = null) {
    const imgEl = document.getElementById('tInspectorPreviewImg');
    const openViewerBtn = document.getElementById('tInspectorOpenViewerBtn');
    const emptyEl = document.getElementById('tInspectorEmptyHint');
    const titleEl = document.getElementById('tInspectorFileTitle');
    const subMetaEl = document.getElementById('tInspectorSubMeta');
    const rateBarEl = document.getElementById('tInspectorRateBar');
    const afBtnEl = document.getElementById('tInspectorArtFramerBtn');
    const exifEl = document.getElementById('tInspectorQuickExif');
    const tagsEl = document.getElementById('tInspectorTags');
    if (!titleEl) return;

    const isBatch = Boolean(batchInfo && batchInfo.count > 1);
    if (!photo && !isBatch) {
      if (imgEl) imgEl.style.display = 'none';
      if (openViewerBtn) openViewerBtn.style.display = 'none';
      if (afBtnEl) afBtnEl.style.display = 'none';
      if (emptyEl) emptyEl.style.display = 'flex';
      titleEl.textContent = '-';
      if (subMetaEl) subMetaEl.textContent = '';
      rateBarEl?.querySelectorAll('[data-inspector-rate]').forEach((btn) => btn.classList.remove('is-active'));
      if (exifEl) exifEl.innerHTML = '';
      if (tagsEl) tagsEl.innerHTML = '';
      return;
    }
    if (afBtnEl) afBtnEl.style.display = 'flex';

    if (imgEl && photo && photo.thumbUrl) {
      imgEl.src = photo.thumbUrl;
      imgEl.style.display = 'block';
      global.TetheractTouchUI?.applyPhotoCssAdjustmentsToElement?.(imgEl, photo);
      if (openViewerBtn) openViewerBtn.style.display = isBatch ? 'none' : 'inline-flex';
      if (emptyEl) emptyEl.style.display = 'none';
    }
    titleEl.textContent = isBatch ? `${batchInfo.count}枚の写真を選択中` : (photo.file_name || photo.fileName || 'Photo');

    if (subMetaEl) {
      if (isBatch) {
        subMetaEl.textContent = '共通タグの ✕ で一括解除 · 評価・タグ追加も一括反映';
      } else {
        const loc = [photo.country, photo.state, photo.city].filter(Boolean).join(' ');
        const subParts = [photo.date_taken ? String(photo.date_taken).slice(0, 16) : '', (photo.width && photo.height) ? `${photo.width}×${photo.height}` : '', loc].filter(Boolean);
        subMetaEl.textContent = subParts.join(' · ');
      }
    }

    if (rateBarEl) {
      const curRate = isBatch ? batchInfo.commonRating : Number(photo.rating || 0);
      rateBarEl.querySelectorAll('[data-inspector-rate]').forEach((btn) => {
        btn.classList.toggle('is-active', curRate !== null && Number(btn.getAttribute('data-inspector-rate')) === curRate);
      });
    }

    if (exifEl) {
      const pills = isBatch ? [] : [photo.camera_model || photo.cameraModel, photo.lens_model || photo.lensModel, photo.focal_length ? `${Math.round(Number(photo.focal_length))}mm` : '', photo.f_number ? `F${photo.f_number}` : '', photo.shutter_speed ? `${photo.shutter_speed}s` : '', photo.iso ? `ISO ${photo.iso}` : ''].filter(Boolean);
      exifEl.innerHTML = pills.map((val) => `<span class="t-exif-pill">${_escHtml(val)}</span>`).join('');
    }

    if (tagsEl) {
      if (isBatch) {
        const cHtml = (batchInfo.commonTags || []).map((t) => `<span class="t-tag-pill is-common">#${_escHtml(t)} <small>(${batchInfo.count}/${batchInfo.count})</small><button type="button" class="t-tag-pill-del" data-inspector-remove-tag="${_escAttr(t)}" title="選択写真から一括削除">✕</button></span>`).join('');
        const pHtml = (batchInfo.partialTags || []).map((it) => `<span class="t-tag-pill is-partial" title="一部の写真のみに付与">#${_escHtml(it.tag)} <small>(${it.cnt}/${batchInfo.count})</small></span>`).join('');
        tagsEl.innerHTML = (cHtml || pHtml) ? (cHtml + pHtml) : '<span class="t-inspector-muted">タグなし</span>';
      } else {
        const tags = Array.isArray(photo.tags) ? photo.tags : [];
        tagsEl.innerHTML = tags.length ? tags.map((t) => `<span class="t-tag-pill">#${_escHtml(t)}<button type="button" class="t-tag-pill-del" data-inspector-remove-tag="${_escAttr(t)}" title="タグ解除">✕</button></span>`).join('') : '<span class="t-inspector-muted">タグなし</span>';
      }
    }
  }

  function initTouchLayout(options = {}) {
    if (options.onPerspectiveSelect) state.onPerspectiveSelect = options.onPerspectiveSelect;
    if (options.onConditionPicked) state.onConditionPicked = options.onConditionPicked;
    mountDeviceModeToggle(options.headerToggleTarget);
    mountResponsiveWorkspace();
    applyDeviceMode(state.preferredMode);
    global.addEventListener('resize', () => applyDeviceMode(state.preferredMode));
    global.addEventListener('orientationchange', () => setTimeout(() => applyDeviceMode(state.preferredMode), 60));
  }

  const layoutApi = {
    PERSPECTIVES, initTouchLayout, resolveDeviceMode, applyDeviceMode, cycleDeviceMode,
    mountDeviceModeToggle, mountResponsiveWorkspace, selectPerspective, registerPerspectiveRenderer,
    refreshActivePerspective: () => _populatePerspectiveContent(state.activePerspective),
    openPerspectiveSheet, closePerspectiveSheet, updateLockerStatus, updateTabletInspector,
    getState: () => ({ ...state }),
  };

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, layoutApi, { layout: layoutApi });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initTouchLayout());
  else initTouchLayout();
})(window);
