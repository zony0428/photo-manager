/**
 * Tetheract Touch & Tablet Phone Camera Folder & Loome\case Transfer View (Layer 3)
 *
 * 「フォルダ (Folder)」タブの先頭にスマホ内の画像フォルダ（Camera / Pictures 等）を統合し、
 * 母艦DBとの事前重複照合（未収納スキャン）、スマホ上での評価・タグ付け、
 * および母艦 \Loome\case\YYYY-MM-DD への原本ストリーム転送を担う。
 */

(function (global) {
  'use strict';

  const RATE_LABELS = { 2: '優', 1: '良', 0: '可', '-1': '棄' };
  const GRID_BATCH_SIZE = 120;

  const state = {
    folders: [], folderCounts: {}, rescanningFolders: false, autoScannedOnce: false,
    modalOpen: false, previewOpen: false, previewIndex: 0, tagPickerOpen: false,
    activeFolderId: 'all', activeFolderName: 'スマホ内フォルダ', filterMode: 'unstored',
    items: [], renderLimit: GRID_BATCH_SIZE, selectedKeys: new Set(), commonTagText: '',
    availableMotherTags: [], loadingScan: false, transferring: false,
    transferProgress: { current: 0, total: 0, fileName: '', importedCount: 0, skippedCount: 0 },
    browserFilesMap: new Map(), browserDrafts: {}, activeSlotEl: null,
  };

  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const _escAttr = _escHtml;

  function _getAdapter() { return global.TetheractPhoneCaseAdapter || null; }

  function _showToast(msg, durationMs = 2600) {
    if (typeof global.showToast === 'function') { global.showToast(msg, durationMs); return; }
    const toast = document.getElementById('mToast');
    if (!toast) return;
    toast.textContent = String(msg || '');
    toast.style.display = 'block';
    clearTimeout(_showToast._timer);
    _showToast._timer = setTimeout(() => { toast.style.display = 'none'; }, durationMs);
  }

  function _formatSize(bytes) {
    const b = Number(bytes || 0);
    if (b <= 0) return '0 KB';
    return b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  }

  function _formatLocalDate(ms) {
    const n = Number(ms || 0);
    if (!n || n <= 0) return '';
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '';
    const p2 = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }

  function _getFilteredItems() {
    return state.filterMode === 'unstored' ? state.items.filter((it) => !it.inMotherShip) : state.items;
  }

  async function _loadMotherTagSuggestions() {
    try {
      const trees = await global.TetheractDataAdapter?.getFilterTrees?.();
      if (trees && Array.isArray(trees.tags)) {
        state.availableMotherTags = trees.tags.map((t) => String((t && (t.tag || t.name)) || '').trim()).filter(Boolean).slice(0, 60);
      }
    } catch (e) {}
  }

  function _updateFolderCountsFromScanResult(scanRes, targetFolderId = 'all') {
    if (!scanRes) return;
    if (Array.isArray(scanRes.folders)) {
      state.folders = scanRes.folders;
      scanRes.folders.forEach((f) => { if (f && f.id) state.folderCounts[f.id] = Number(f.photoCount ?? f.count ?? 0); });
      return;
    }
    if (!Array.isArray(scanRes.items)) return;
    if (!targetFolderId || targetFolderId === 'all') {
      const nextMap = {};
      state.folders.forEach((f) => { nextMap[f.id] = 0; });
      scanRes.items.forEach((it) => { const fid = String(it && it.folderId || ''); if (fid) nextMap[fid] = (nextMap[fid] || 0) + 1; });
      state.folderCounts = nextMap;
    } else {
      state.folderCounts[targetFolderId] = Number(scanRes.totalCount ?? scanRes.items.length);
    }
  }

  function _getFolderPhotoCount(f) {
    if (!f) return 0;
    const dbCnt = typeof global.__getMobileFolderPhotoCount === 'function' ? Number(global.__getMobileFolderPhotoCount(`📱 ${f.name}`) || 0) : 0;
    const cachedCnt = state.folderCounts[f.id] !== undefined ? Number(state.folderCounts[f.id] || 0) : 0;
    const nativeCnt = Number(f.photoCount ?? f.count ?? f.totalCount ?? f.scannedCount ?? 0);
    return Math.max(dbCnt, cachedCnt, nativeCnt, 0);
  }

  async function _rescanFoldersAndSyncCatalog(options = {}) {
    const adapter = _getAdapter();
    if (!adapter || !adapter.isNativeAvailable() || state.rescanningFolders) return null;
    const targetId = options.folderId || 'all';
    state.rescanningFolders = true;
    if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) _renderFolderCardInner(state.activeSlotEl);
    if (!options.silent) _showToast('スマホ管理下フォルダをスキャン中...', 2200);
    try {
      const scanRes = await adapter.scanPhotos(targetId, { includeItems: false, force: !options.silent });
      _updateFolderCountsFromScanResult(scanRes, targetId);
      if (typeof global.__onTetheractPhoneCatalogSynced === 'function') await global.__onTetheractPhoneCatalogSynced();
      if (!Array.isArray(scanRes && scanRes.folders)) {
        const listRes = await adapter.listFolders();
        if (Array.isArray(listRes.folders)) state.folders = listRes.folders;
      }
      if (!options.silent) {
        const err = (scanRes && (scanRes.error || scanRes.scanError)) || '';
        _showToast(err ? `⚠️ スキャンエラー: ${err}` : `✓ スマホ管理下フォルダを更新しました (${Number(scanRes?.totalCount || 0)}枚)`, err ? 4000 : 2600);
      }
      return scanRes;
    } finally {
      state.rescanningFolders = false;
      if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) _renderFolderCardInner(state.activeSlotEl);
    }
  }

  /**
   * 「フォルダ (Folder)」タブの先頭スロットへスマホ内フォルダカードを描画する
   */
  function renderFolderPerspectiveCard(slotEl) {
    state.activeSlotEl = slotEl;
    _renderFolderCardInner(slotEl);
    _refreshFoldersList();
    return slotEl;
  }

  async function _refreshFoldersList() {
    const adapter = _getAdapter();
    if (!adapter) return;
    const res = await adapter.listFolders();
    state.folders = Array.isArray(res.folders) ? res.folders : [];
    if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) {
      _renderFolderCardInner(state.activeSlotEl);
    }
    if (adapter.isNativeAvailable() && state.folders.length > 0 && !state.autoScannedOnce && !state.rescanningFolders) {
      const hasZeroFolder = state.folders.some((f) => _getFolderPhotoCount(f) === 0);
      if (hasZeroFolder) {
        state.autoScannedOnce = true;
        await _rescanFoldersAndSyncCatalog({ folderId: 'all', silent: true });
      }
    }
  }

  function _renderFolderCardInner(slotEl) {
    if (!slotEl) return;
    const adapter = _getAdapter();
    const isNative = Boolean(adapter && adapter.isNativeAvailable());

    if (!isNative) {
      slotEl.innerHTML = `<div class="t-pcase-folder-card" data-no-dismiss="1">
        <div class="t-pcase-card-head"><span class="t-pcase-card-title">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          <span>このスマホの写真 (→ Loome\\case)</span></span></div>
        <div class="t-pcase-card-sub">スマホ内の写真を選び、評価・タグを付けて母艦の <code>\\Loome\\case\\YYYY-MM-DD</code> へ転送します（母艦に既存の写真は自動スキップ）。</div>
        <button type="button" class="t-pcase-add-folder-btn" data-pcase-action="browser-pick" data-no-dismiss="1" style="justify-content:center;height:34px;"><span>＋ スマホの写真を選んで選別・母艦転送</span></button>
      </div>`;
      _bindFolderCardEvents(slotEl);
      return;
    }

    const hasFolders = state.folders.length > 0;
    const activeFp = typeof global.__getActiveMobileFolderPath === 'function' ? global.__getActiveMobileFolderPath() : '';
    const folderRowsHtml = hasFolders
      ? state.folders.map((f) => {
          const fp = `📱 ${f.name}`;
          const count = _getFolderPhotoCount(f);
          const isSel = activeFp === fp;
          const countLabel = state.rescanningFolders && count === 0 ? '走査中...' : `${count}枚`;
          return `<div class="t-pcase-folder-row ${isSel ? 'active-include' : ''}" data-pcase-filter-folder="${_escAttr(fp)}" data-pcase-folder-id="${_escAttr(f.id)}" data-no-dismiss="1" style="${isSel ? 'border-color:var(--accent-primary);' : ''}">
            <div class="t-pcase-folder-row-main" title="タップしてギャラリーにこのフォルダの写真を表示">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;color:var(--accent-primary);"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📱 ${_escHtml(f.name)}</span>
              <span class="m-filter-count" style="margin-left:6px;flex-shrink:0;">${_escHtml(countLabel)}</span>
            </div>
            <div class="t-pcase-folder-row-actions">
              <button type="button" class="t-pcase-open-pill" data-pcase-open-folder="${_escAttr(f.id)}" data-pcase-folder-name="${_escAttr(f.name)}" data-no-dismiss="1" style="border:none;cursor:pointer;">母艦に収納</button>
              <button type="button" class="t-pcase-unlink-btn" data-pcase-unlink="${_escAttr(f.id)}" data-no-dismiss="1" title="管理下から解除（ファイルは消えません）">✕</button>
            </div>
          </div>`;
        }).join('') + (state.folders.length > 1
          ? `<div class="t-pcase-folder-row" data-pcase-open-folder="all" data-pcase-folder-name="Uplink — 全スマホフォルダ" data-no-dismiss="1"><div class="t-pcase-folder-row-main"><span>📱 全スマホフォルダの未収納写真をまとめて母艦に収納</span></div><div class="t-pcase-folder-row-actions"><span class="t-pcase-open-pill">Uplink</span></div></div>`
          : '')
      : `<div class="t-pcase-card-sub">スマホ内のカメラフォルダ（<code>DCIM/Camera</code> や <code>Pictures</code> 等）を追加すると、起動時に自動スキャンしてTetheractのギャラリー管理下に表示し、手動で <code>\\Loome\\case\\YYYY-MM-DD</code> へ転送できます。</div>`;

    slotEl.innerHTML = `<div class="t-pcase-folder-card" data-no-dismiss="1">
      <div class="t-pcase-card-head">
        <span class="t-pcase-card-title"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg><span>スマホ管理下フォルダ (自動スキャン / 手動転送)</span></span>
        <div style="display:inline-flex;gap:5px;align-items:center;">
          ${hasFolders ? `<button type="button" class="t-pcase-add-folder-btn" data-pcase-action="rescan-folders" data-no-dismiss="1" ${state.rescanningFolders ? 'disabled' : ''}><span>${state.rescanningFolders ? '走査中...' : '↻ 再スキャン'}</span></button>` : ''}
          <button type="button" class="t-pcase-add-folder-btn" data-pcase-action="pick-folder" data-no-dismiss="1"><span>＋ フォルダ追加</span></button>
        </div>
      </div>
      <div class="t-pcase-folder-list">${folderRowsHtml}</div>
    </div>`;

    _bindFolderCardEvents(slotEl);
  }

  function _bindFolderCardEvents(slotEl) {
    if (!slotEl || slotEl.dataset.pcaseBound === '1') return;
    slotEl.dataset.pcaseBound = '1';

    slotEl.addEventListener('click', async (e) => {
      e.stopPropagation();
      const adapter = _getAdapter();
      if (!adapter) return;

      const unlinkBtn = e.target.closest('[data-pcase-unlink]');
      if (unlinkBtn) {
        const fid = unlinkBtn.getAttribute('data-pcase-unlink');
        const fObj = state.folders.find((x) => x.id === fid);
        const fName = (fObj && fObj.name) || 'スマホフォルダ';
        if (typeof global.__confirmTouchAction === 'function') {
          const ok = await global.__confirmTouchAction({ title: '管理下からの解除', message: `スマホフォルダ「${fName}」をTetheractの管理下から解除しますか？\n（※スマホ内の実ファイルは削除されません）`, confirmText: '解除する', danger: true });
          if (!ok) return;
        }
        const res = await adapter.removeFolder(fid);
        delete state.folderCounts[fid];
        state.folders = Array.isArray(res.folders) ? res.folders : [];
        _renderFolderCardInner(slotEl);
        if (typeof global.__onTetheractPhoneCatalogSynced === 'function') await global.__onTetheractPhoneCatalogSynced();
        _showToast(`スマホフォルダ「${fName}」を管理下から解除しました`);
        return;
      }

      if (e.target.closest('[data-pcase-action="rescan-folders"]')) { await _rescanFoldersAndSyncCatalog({ folderId: 'all', silent: false }); return; }
      if (e.target.closest('[data-pcase-action="pick-folder"]')) { await adapter.pickFolder(); return; }
      if (e.target.closest('[data-pcase-action="browser-pick"]')) { _triggerBrowserFileInput(); return; }

      const openRow = e.target.closest('[data-pcase-open-folder]');
      if (openRow) {
        openPhoneCaseModal(openRow.getAttribute('data-pcase-open-folder') || 'all', openRow.getAttribute('data-pcase-folder-name') || 'スマホ内フォルダ');
        return;
      }

      const filterRow = e.target.closest('[data-pcase-filter-folder]');
      if (filterRow && typeof global.__filterMobileGalleryByFolder === 'function') {
        const folderPath = filterRow.getAttribute('data-pcase-filter-folder') || '';
        const folderId = filterRow.getAttribute('data-pcase-folder-id') || 'all';
        const fObj = state.folders.find((x) => x.id === folderId) || { id: folderId, name: folderPath.replace(/^📱\s*/, '') };
        if (_getFolderPhotoCount(fObj) === 0 && adapter.isNativeAvailable()) {
          await _rescanFoldersAndSyncCatalog({ folderId: folderId || 'all', silent: false });
        }
        await global.__filterMobileGalleryByFolder(folderPath, { folderId });
      }
    });
  }

  function _triggerBrowserFileInput() {
    let inp = document.getElementById('tPhoneCaseBrowserFileInput');
    if (!inp) {
      inp = Object.assign(document.createElement('input'), {
        type: 'file', id: 'tPhoneCaseBrowserFileInput', multiple: true,
        accept: 'image/*,.dng,.arw,.cr2,.cr3,.nef,.orf,.raf,.rw2',
      });
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', () => {
        const files = Array.from(inp.files || []);
        if (files.length) _openBrowserFilesModal(files);
        inp.value = '';
      });
    }
    inp.click();
  }

  function _openBrowserFilesModal(files) {
    state.browserFilesMap.clear();
    const items = files.map((f, idx) => {
      const docKey = `bf_${idx}_${f.name}_${f.size}`;
      const blobUrl = URL.createObjectURL(f);
      state.browserFilesMap.set(docKey, { file: f, blobUrl });
      const draft = state.browserDrafts[docKey] || {};
      return {
        docKey, folderId: 'browser', folderName: '選択したスマホ写真', fileName: f.name, fileSize: f.size,
        lastModifiedMs: Number(f.lastModified || Date.now()), dateStr: _formatLocalDate(f.lastModified || Date.now()),
        mimeType: f.type || 'image/jpeg', inMotherShip: false, rating: Number(draft.rating || 0),
        tags: Array.isArray(draft.tags) ? [...draft.tags] : [], thumbUrl: blobUrl, fullUrl: blobUrl,
      };
    });
    state.activeFolderId = 'browser';
    state.activeFolderName = `選択した写真 (${items.length}枚)`;
    state.filterMode = 'all';
    state.items = items;
    state.renderLimit = GRID_BATCH_SIZE;
    state.selectedKeys = new Set(items.map((it) => it.docKey));
    _showModalAndRender();
  }

  async function openPhoneCaseModal(folderId = 'all', folderName = 'スマホ内フォルダ', forceRescan = false) {
    state.activeFolderId = folderId;
    state.activeFolderName = folderName;
    state.filterMode = 'unstored';
    state.renderLimit = GRID_BATCH_SIZE;
    state.selectedKeys.clear();
    state.loadingScan = true;
    _showModalAndRender();
    _loadMotherTagSuggestions();

    const adapter = _getAdapter();
    if (!adapter) return;
    const res = await adapter.scanPhotos(folderId, { includeItems: true, force: Boolean(forceRescan) });
    _updateFolderCountsFromScanResult(res, folderId);
    if (res && res.catalogChanged && typeof global.__onTetheractPhoneCatalogSynced === 'function') {
      await global.__onTetheractPhoneCatalogSynced();
    }
    state.loadingScan = false;
    state.items = (Array.isArray(res.items) ? res.items : []).map((it) => ({
      ...it,
      rating: Number(it.rating || 0),
      tags: Array.isArray(it.tags) ? it.tags : [],
      thumbUrl: adapter.getPhotoUrl(it.docKey, true),
      fullUrl: adapter.getPhotoUrl(it.docKey, false),
    }));

    const unstored = state.items.filter((it) => !it.inMotherShip);
    if (unstored.length === 0 && state.items.length > 0) state.filterMode = 'all';
    else unstored.forEach((it) => state.selectedKeys.add(it.docKey));
    _renderModalContent();
    if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) _renderFolderCardInner(state.activeSlotEl);
  }

  function _showModalAndRender() {
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.closePerspectiveSheet === 'function') {
      global.TetheractTouchUI.closePerspectiveSheet();
    }
    const modal = _ensurePhoneCaseModal();
    state.modalOpen = true;
    modal.style.display = 'flex';
    _renderModalContent();
  }

  function closePhoneCaseModal() {
    state.modalOpen = false;
    state.previewOpen = false;
    state.tagPickerOpen = false;
    const modal = document.getElementById('tPhoneCaseModal');
    if (modal) modal.style.display = 'none';
  }

  function _ensurePhoneCaseModal() {
    let modal = document.getElementById('tPhoneCaseModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'tPhoneCaseModal';
    modal.className = 't-pcase-modal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => _handleModalClick(e));
    modal.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'tPcaseCommonTagInput') state.commonTagText = e.target.value;
    });
    modal.addEventListener('scroll', (e) => {
      const sc = e.target;
      if (!sc || !sc.classList || !sc.classList.contains('t-pcase-scroll') || state.loadingScan) return;
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 420) _appendMoreGridCells(sc);
    }, { capture: true, passive: true });
    return modal;
  }

  function _buildCellHtml(it, idx) {
    const isSel = state.selectedKeys.has(it.docKey);
    const rateLabel = it.rating && RATE_LABELS[String(it.rating)] ? RATE_LABELS[String(it.rating)] : '';
    const tagCount = Array.isArray(it.tags) ? it.tags.length : 0;
    return `<div class="t-pcase-cell ${isSel ? 'is-selected' : ''} ${it.inMotherShip ? 'is-stored' : ''}" data-pcase-cell="${_escAttr(it.docKey)}" data-pcase-idx="${idx}">
      <img src="${_escAttr(it.thumbUrl)}" alt="${_escAttr(it.fileName)}" loading="lazy" decoding="async">
      <span class="t-pcase-check" data-pcase-toggle="${_escAttr(it.docKey)}">${isSel ? '✓' : ''}</span>
      <div class="t-pcase-badge-top-right">
        ${it.inMotherShip ? '<span class="t-pcase-stored-badge">✓ 収納済</span>' : ''}
        ${rateLabel ? `<span class="t-pcase-rate-badge">${_escHtml(rateLabel)}</span>` : ''}
        ${tagCount > 0 ? `<span class="t-pcase-tag-badge">#${tagCount}</span>` : ''}
      </div>
      <div class="t-pcase-cell-foot" data-pcase-preview="${idx}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escHtml(it.dateStr || it.fileName)}</span>
        <span style="flex-shrink:0;opacity:0.88;">🔍 拡大</span>
      </div>
    </div>`;
  }

  function _appendMoreGridCells(scrollEl) {
    const visibleItems = _getFilteredItems();
    if (state.renderLimit >= visibleItems.length) return;
    const gridEl = scrollEl.querySelector('.t-pcase-grid');
    if (!gridEl) return;
    const prevLimit = state.renderLimit;
    state.renderLimit = Math.min(visibleItems.length, prevLimit + GRID_BATCH_SIZE);
    const moreHtml = visibleItems.slice(prevLimit, state.renderLimit).map((it, i) => _buildCellHtml(it, prevLimit + i)).join('');
    if (moreHtml) gridEl.insertAdjacentHTML('beforeend', moreHtml);
  }

  function _renderModalContent() {
    const modal = document.getElementById('tPhoneCaseModal');
    if (!modal || !state.modalOpen) return;
    const prevScrollEl = modal.querySelector('.t-pcase-scroll');
    const prevScrollTop = prevScrollEl ? prevScrollEl.scrollTop : 0;
    const unstoredCount = state.items.filter((it) => !it.inMotherShip).length;
    const totalCount = state.items.length;
    const visibleItems = _getFilteredItems();
    const selCount = state.selectedKeys.size;
    const sliceLimit = Math.max(GRID_BATCH_SIZE, state.renderLimit);
    const renderedSlice = visibleItems.slice(0, sliceLimit);

    const isNative = Boolean(_getAdapter()?.isNativeAvailable());
    const emptyMsg = !isNative
      ? `<div>スマホ内の写真を選んで母艦に収納 (Uplink) できます</div><button type="button" class="t-pcase-add-folder-btn" data-pcase-action="browser-pick" style="margin:12px auto 0;">＋ スマホの写真を選択</button>`
      : state.folders.length === 0
      ? `<div>まだスマホ内フォルダが登録されていません</div><button type="button" class="t-pcase-add-folder-btn" data-pcase-action="pick-folder" style="margin:12px auto 0;">＋ カメラフォルダ (DCIM等) を追加</button>`
      : (state.filterMode === 'unstored' ? '未収納の新着写真はありません（すべて母艦に収納済みです）' : 'フォルダ内に画像が見つかりません');
    const gridHtml = state.loadingScan
      ? `<div style="grid-column:1/-1;padding:48px 16px;text-align:center;color:var(--text-muted);font-size:13px;">スマホ内フォルダをスキャンし、母艦DBと照合しています...</div>`
      : visibleItems.length === 0
      ? `<div style="grid-column:1/-1;padding:48px 16px;text-align:center;color:var(--text-muted);font-size:13px;">${emptyMsg}</div>`
      : renderedSlice.map((it, idx) => _buildCellHtml(it, idx)).join('');

    const progressOverlayHtml = state.transferring
      ? `<div id="tPcaseProgressOverlay" style="position:fixed;inset:0;z-index:160;background:rgba(12,13,16,0.82);display:flex;align-items:center;justify-content:center;padding:20px;">
           <div style="width:100%;max-width:340px;background:var(--surface-card);border:1px solid var(--border-color);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:10px;">
             <div style="font-size:14px;font-weight:700;">母艦 \\Loome\\case へ転送中...</div>
             <div id="tPcaseProgText" style="font-size:12px;color:var(--text-muted);word-break:break-all;">${state.transferProgress.current} / ${state.transferProgress.total} 枚 · ${_escHtml(state.transferProgress.fileName || '照合中...')}</div>
             <div style="height:6px;border-radius:3px;background:var(--bg-tertiary);overflow:hidden;">
               <div id="tPcaseProgBar" style="height:100%;background:var(--accent-primary);width:${state.transferProgress.total > 0 ? Math.round((state.transferProgress.current / state.transferProgress.total) * 100) : 15}%;transition:width 0.12s ease;"></div>
             </div>
             <div id="tPcaseProgSub" style="font-size:11px;color:var(--text-muted);">新規収納: ${state.transferProgress.importedCount}枚 / 重複スキップ: ${state.transferProgress.skippedCount}枚${state.transferProgress.errorCount > 0 ? ` / リトライ失敗: ${state.transferProgress.errorCount}枚` : ''}</div>
           </div>
         </div>`
      : '';

    const previewHtml = state.previewOpen ? _buildPreviewOverlayHtml(visibleItems) : '';
    const tagPickerHtml = state.tagPickerOpen ? _buildTagPickerOverlayHtml() : '';

    modal.innerHTML = `
      <div class="t-pcase-topbar">
        <button type="button" class="t-locker-action-btn" data-pcase-action="close-modal"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg><span>戻る</span></button>
        <div style="flex:1;min-width:0;text-align:center;">
          <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📱 ${_escHtml(state.activeFolderName)}</div>
          <div style="font-size:10.5px;color:var(--text-muted);">Uplink先: 母艦 <code>\\Loome\\case\\YYYY-MM-DD</code></div>
        </div>
        <div style="display:inline-flex;gap:4px;"><button type="button" class="t-locker-action-btn" data-pcase-action="rescan" title="スマホ内フォルダを再スキャンし、母艦DBの最新状態と照合します">🔄 再照合</button></div>
      </div>
      <div class="t-pcase-toolbar">
        <div style="display:inline-flex;gap:4px;">
          <button type="button" class="t-mode-switch-btn ${state.filterMode === 'unstored' ? 'is-active' : ''}" data-pcase-filter="unstored">未収納のみ (${unstoredCount})</button>
          <button type="button" class="t-mode-switch-btn ${state.filterMode === 'all' ? 'is-active' : ''}" data-pcase-filter="all">すべて (${totalCount})</button>
        </div>
        <div style="display:inline-flex;gap:6px;">
          <button type="button" class="m-text-btn" data-pcase-action="select-visible" style="font-size:11px;">表示中を全選択</button>
          <button type="button" class="m-text-btn" data-pcase-action="clear-selection" style="font-size:11px;">選択解除</button>
        </div>
      </div>
      <div class="t-pcase-scroll"><div class="t-pcase-grid">${gridHtml}</div></div>
      <div class="t-pcase-bottom-panel">
        <div class="t-pcase-curation-row">
          <span id="tPcaseSelCountLabel" style="font-size:11px;font-weight:700;color:var(--text-muted);flex-shrink:0;">選択${selCount}枚に付与:</span>
          <button type="button" class="t-inspector-rate-btn is-excellent" data-pcase-rate="2" style="padding:0 10px;height:28px;">優</button>
          <button type="button" class="t-inspector-rate-btn is-good" data-pcase-rate="1" style="padding:0 10px;height:28px;">良</button>
          <button type="button" class="t-inspector-rate-btn is-normal" data-pcase-rate="0" style="padding:0 10px;height:28px;">可</button>
          <button type="button" class="t-inspector-rate-btn is-discard" data-pcase-rate="-1" style="padding:0 10px;height:28px;">棄</button>
          <button type="button" class="t-pcase-add-folder-btn" data-pcase-action="open-tag-picker" style="height:28px;">＋ タグ選択</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;"><input type="text" id="tPcaseCommonTagInput" class="t-inspector-tag-input" value="${_escAttr(state.commonTagText)}" placeholder="転送分すべてに付ける共通タグ (カンマ区切り可: ロケハン, スナップ)..." autocomplete="off"></div>
        <button type="button" id="tPcaseSubmitBtn" class="t-pcase-submit-btn" data-pcase-action="submit-transfer" ${selCount === 0 || state.transferring ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span id="tPcaseSubmitBtnLabel">Uplink — 母艦に収納 (${selCount}枚 · 重複スキップ)</span></button>
      </div>
      ${previewHtml}${tagPickerHtml}${progressOverlayHtml}`;
    const nextScrollEl = modal.querySelector('.t-pcase-scroll');
    if (nextScrollEl && prevScrollTop > 0) nextScrollEl.scrollTop = prevScrollTop;
  }

  function _buildPreviewOverlayHtml(visibleItems) {
    const item = visibleItems[state.previewIndex];
    if (!item) return '';
    const rate = Number(item.rating || 0);
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return `<div style="position:fixed;inset:0;z-index:145;background:rgba(10,11,14,0.96);display:flex;flex-direction:column;">
      <div class="t-pcase-topbar" style="background:rgba(20,22,26,0.9);">
        <button type="button" class="m-viewer-back-btn" data-pcase-action="close-preview">✕ 閉じる</button>
        <div style="flex:1;min-width:0;text-align:center;">
          <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_escHtml(item.fileName)}</div>
          <div style="font-size:10.5px;color:var(--text-muted);">${state.previewIndex + 1} / ${visibleItems.length} · ${_escHtml(item.dateStr)} (${_formatSize(item.fileSize)})</div>
        </div>
        <button type="button" class="t-locker-action-btn" data-pcase-toggle="${_escAttr(item.docKey)}">${state.selectedKeys.has(item.docKey) ? '✓ 転送対象' : '＋ 選択する'}</button>
      </div>
      <div style="flex:1;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;">
        ${state.previewIndex > 0 ? '<button type="button" class="m-viewer-nav prev" data-pcase-action="prev-preview">‹</button>' : ''}
        <img src="${_escAttr(item.fullUrl)}" alt="${_escAttr(item.fileName)}" style="max-width:100%;max-height:100%;object-fit:contain;">
        ${state.previewIndex < visibleItems.length - 1 ? '<button type="button" class="m-viewer-nav next" data-pcase-action="next-preview">›</button>' : ''}
      </div>
      <div style="padding:10px 12px calc(12px + env(safe-area-inset-bottom,0px));background:var(--surface-card);border-top:1px solid var(--border-color);display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;">
          <span style="font-size:11px;color:var(--text-muted);">タグ:</span>
          ${tags.length ? tags.map((t) => `<span class="t-tag-pill">#${_escHtml(t)} <button type="button" class="t-tag-pill-del" data-pcase-del-single-tag="${_escAttr(t)}" data-pcase-target-key="${_escAttr(item.docKey)}">✕</button></span>`).join('') : '<span style="font-size:11px;color:var(--text-muted);">未付与</span>'}
          <button type="button" class="t-inspector-link-btn" data-pcase-action="open-tag-picker" data-pcase-single-key="${_escAttr(item.docKey)}">＋ タグ追加</button>
        </div>
        <div class="t-inspector-rate-bar">
          <button type="button" class="t-inspector-rate-btn is-excellent ${rate === 2 ? 'is-active' : ''}" data-pcase-single-rate="2" data-pcase-target-key="${_escAttr(item.docKey)}">優</button>
          <button type="button" class="t-inspector-rate-btn is-good ${rate === 1 ? 'is-active' : ''}" data-pcase-single-rate="1" data-pcase-target-key="${_escAttr(item.docKey)}">良</button>
          <button type="button" class="t-inspector-rate-btn is-normal ${rate === 0 ? 'is-active' : ''}" data-pcase-single-rate="0" data-pcase-target-key="${_escAttr(item.docKey)}">可</button>
          <button type="button" class="t-inspector-rate-btn is-discard ${rate === -1 ? 'is-active' : ''}" data-pcase-single-rate="-1" data-pcase-target-key="${_escAttr(item.docKey)}">棄</button>
        </div>
      </div>
    </div>`;
  }

  function _buildTagPickerOverlayHtml() {
    const targetKeys = state._tagTargetKeys || Array.from(state.selectedKeys);
    const pillsHtml = state.availableMotherTags.length
      ? state.availableMotherTags.map((t) => `<button type="button" class="t-tag-pill" data-pcase-pick-tag="${_escAttr(t)}" style="cursor:pointer;padding:5px 10px;font-size:12px;">＋ ${_escHtml(t)}</button>`).join('')
      : '<span style="font-size:11px;color:var(--text-muted);">母艦タグ候補がありません（下から直接入力できます）</span>';
    return `<div style="position:fixed;inset:0;z-index:155;background:rgba(10,11,14,0.76);display:flex;align-items:flex-end;justify-content:center;">
      <div style="width:100%;max-width:520px;max-height:75vh;background:var(--surface-card);border-top:1px solid var(--border-color);border-radius:14px 14px 0 0;padding:14px;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-size:13px;font-weight:700;">タグを付与 (${targetKeys.length}枚対象)</span><button type="button" class="t-icon-close-btn" data-pcase-action="close-tag-picker">✕</button></div>
        <div style="display:flex;gap:6px;"><input type="text" id="tPcaseCustomTagInput" class="t-inspector-tag-input" placeholder="新しいタグ名 (階層は 親/子)..." autocomplete="off"><button type="button" class="t-inspector-tag-add-btn" data-pcase-action="add-custom-tag">追加</button></div>
        <div style="font-size:11px;color:var(--text-muted);">母艦の既存タグからタップして追加:</div>
        <div style="flex:1;overflow-y:auto;display:flex;flex-wrap:wrap;gap:6px;padding:4px 0;">${pillsHtml}</div>
      </div>
    </div>`;
  }

  async function _applyDraftToKeys(docKeys, { rating, addTags, removeTags }) {
    if (!docKeys || !docKeys.length) return;
    const keySet = new Set(docKeys);
    state.items.forEach((it) => {
      if (!keySet.has(it.docKey)) return;
      if (rating !== undefined && rating !== null) it.rating = Number(rating);
      const tSet = new Set(Array.isArray(it.tags) ? it.tags : []);
      if (Array.isArray(removeTags)) removeTags.forEach((rt) => tSet.delete(rt));
      if (Array.isArray(addTags)) addTags.forEach((at) => { if (at) tSet.add(at); });
      it.tags = Array.from(tSet);

      if (state.activeFolderId === 'browser') state.browserDrafts[it.docKey] = { rating: it.rating, tags: [...it.tags] };
    });
    const adapter = _getAdapter();
    if (adapter && adapter.isNativeAvailable()) await adapter.saveDraft({ docKeys, rating, addTags, removeTags });
    _renderModalContent();
  }

  async function _handleModalClick(e) {
    const actionBtn = e.target.closest('[data-pcase-action]');
    if (actionBtn) {
      const act = actionBtn.getAttribute('data-pcase-action');
      if (act === 'close-modal') { closePhoneCaseModal(); return; }
      if (act === 'open-wifi-sync') { closePhoneCaseModal(); document.getElementById('mHeaderWifiSyncBtn')?.click(); return; }
      if (act === 'pick-folder') { await _getAdapter()?.pickFolder(); return; }
      if (act === 'browser-pick') { _triggerBrowserFileInput(); return; }
      if (act === 'rescan') {
        if (state.activeFolderId === 'browser') _triggerBrowserFileInput();
        else await openPhoneCaseModal(state.activeFolderId, state.activeFolderName, true);
        return;
      }
      if (act === 'select-visible') { _getFilteredItems().forEach((it) => state.selectedKeys.add(it.docKey)); _renderModalContent(); return; }
      if (act === 'clear-selection') { state.selectedKeys.clear(); _renderModalContent(); return; }
      if (act === 'close-preview') { state.previewOpen = false; _renderModalContent(); return; }
      if (act === 'prev-preview') { state.previewIndex = Math.max(0, state.previewIndex - 1); _renderModalContent(); return; }
      if (act === 'next-preview') { state.previewIndex = Math.min(_getFilteredItems().length - 1, state.previewIndex + 1); _renderModalContent(); return; }
      if (act === 'open-tag-picker') {
        const singleKey = actionBtn.getAttribute('data-pcase-single-key');
        state._tagTargetKeys = singleKey ? [singleKey] : Array.from(state.selectedKeys);
        if (!state._tagTargetKeys.length) { _showToast('先に写真を選択してください'); return; }
        state.tagPickerOpen = true;
        _renderModalContent();
        return;
      }
      if (act === 'close-tag-picker') { state.tagPickerOpen = false; _renderModalContent(); return; }
      if (act === 'add-custom-tag') {
        const inp = document.getElementById('tPcaseCustomTagInput');
        const val = inp ? inp.value.trim() : '';
        if (!val) return;
        const tags = val.split(',').map((s) => s.trim()).filter(Boolean);
        await _applyDraftToKeys(state._tagTargetKeys || Array.from(state.selectedKeys), { addTags: tags });
        _showToast(`タグ「${tags.join(', ')}」を付与しました`);
        return;
      }
      if (act === 'submit-transfer') { await _executeTransfer(); return; }
    }

    const filterBtn = e.target.closest('[data-pcase-filter]');
    if (filterBtn) {
      state.filterMode = filterBtn.getAttribute('data-pcase-filter') || 'unstored';
      state.renderLimit = GRID_BATCH_SIZE;
      _renderModalContent();
      return;
    }

    const pickTagBtn = e.target.closest('[data-pcase-pick-tag]');
    if (pickTagBtn) {
      const tag = pickTagBtn.getAttribute('data-pcase-pick-tag');
      if (tag) {
        await _applyDraftToKeys(state._tagTargetKeys || Array.from(state.selectedKeys), { addTags: [tag] });
        _showToast(`タグ「#${tag}」を付与しました`);
      }
      return;
    }

    const delSingleTagBtn = e.target.closest('[data-pcase-del-single-tag]');
    if (delSingleTagBtn) {
      const tag = delSingleTagBtn.getAttribute('data-pcase-del-single-tag');
      const key = delSingleTagBtn.getAttribute('data-pcase-target-key');
      if (tag && key) await _applyDraftToKeys([key], { removeTags: [tag] });
      return;
    }

    const singleRateBtn = e.target.closest('[data-pcase-single-rate]');
    if (singleRateBtn) {
      const rate = Number(singleRateBtn.getAttribute('data-pcase-single-rate'));
      const key = singleRateBtn.getAttribute('data-pcase-target-key');
      if (key) await _applyDraftToKeys([key], { rating: rate });
      return;
    }

    const batchRateBtn = e.target.closest('[data-pcase-rate]');
    if (batchRateBtn) {
      const keys = Array.from(state.selectedKeys);
      if (!keys.length) { _showToast('評価を付ける写真を選択してください'); return; }
      const rate = Number(batchRateBtn.getAttribute('data-pcase-rate'));
      await _applyDraftToKeys(keys, { rating: rate });
      _showToast(`選択中の ${keys.length} 枚を「${RATE_LABELS[String(rate)] || ''}」に設定しました`);
      return;
    }

    const previewTrigger = e.target.closest('[data-pcase-preview]');
    if (previewTrigger) {
      state.previewIndex = Number(previewTrigger.getAttribute('data-pcase-preview') || 0);
      state.previewOpen = true;
      _renderModalContent();
      return;
    }

    const toggleEl = e.target.closest('[data-pcase-toggle], [data-pcase-cell]');
    if (toggleEl) {
      const key = toggleEl.getAttribute('data-pcase-toggle') || toggleEl.getAttribute('data-pcase-cell');
      if (!key) return;
      const nowSel = !state.selectedKeys.has(key);
      if (nowSel) state.selectedKeys.add(key); else state.selectedKeys.delete(key);
      if (state.previewOpen) { _renderModalContent(); return; }
      const cellEl = toggleEl.closest('[data-pcase-cell]');
      if (cellEl) {
        cellEl.classList.toggle('is-selected', nowSel);
        const chk = cellEl.querySelector('.t-pcase-check');
        if (chk) chk.textContent = nowSel ? '✓' : '';
      }
      const selCount = state.selectedKeys.size;
      const cntLbl = document.getElementById('tPcaseSelCountLabel');
      const subBtn = document.getElementById('tPcaseSubmitBtn');
      const subLbl = document.getElementById('tPcaseSubmitBtnLabel');
      if (cntLbl) cntLbl.textContent = `選択${selCount}枚に付与:`;
      if (subBtn) subBtn.disabled = selCount === 0 || state.transferring;
      if (subLbl) subLbl.textContent = `Uplink — 母艦に収納 (${selCount}枚 · 重複スキップ)`;
    }
  }

  function _updateProgressOverlayInPlace() {
    const overlay = document.getElementById('tPcaseProgressOverlay');
    if (!overlay) return false;
    const p = state.transferProgress;
    const txtEl = document.getElementById('tPcaseProgText');
    const barEl = document.getElementById('tPcaseProgBar');
    const subEl = document.getElementById('tPcaseProgSub');
    if (txtEl) txtEl.textContent = `${p.current} / ${p.total} 枚 · ${p.fileName || '照合中...'}`;
    if (barEl) barEl.style.width = `${p.total > 0 ? Math.min(100, Math.round((p.current / p.total) * 100)) : 15}%`;
    if (subEl) {
      subEl.textContent = `新規収納: ${p.importedCount}枚 / 重複スキップ: ${p.skippedCount}枚${p.errorCount > 0 ? ` / リトライ失敗: ${p.errorCount}枚` : ''}`;
    }
    return true;
  }

  async function _executeTransfer() {
    const adapter = _getAdapter();
    if (!adapter || state.transferring) return;

    const selectedItems = state.items.filter((it) => state.selectedKeys.has(it.docKey));
    if (!selectedItems.length) { _showToast('転送する写真を選択してください'); return; }

    const commonTags = String(state.commonTagText || '').split(',').map((s) => s.trim()).filter(Boolean);
    state.transferring = true;
    state.transferProgress = { current: 0, total: selectedItems.length, fileName: '母艦DBと照合中...', importedCount: 0, skippedCount: 0, errorCount: 0 };
    _renderModalContent();

    if (state.activeFolderId === 'browser') {
      const validPairs = selectedItems.map((it) => ({ docKey: it.docKey, file: state.browserFilesMap.get(it.docKey)?.file })).filter((p) => Boolean(p.file));
      await adapter.transferBrowserFiles(
        validPairs.map((p) => p.file),
        { commonTags, draftMap: state.browserDrafts, docKeys: validPairs.map((p) => p.docKey) }
      );
      return;
    }

    const startRes = await adapter.transferToMotherShip({ items: selectedItems, commonTags });
    if (!startRes || !startRes.ok) {
      state.transferring = false;
      _renderModalContent();
      _showToast((startRes && startRes.error) || '転送の開始に失敗しました');
    }
  }

  function _initTouchPhoneCase() {
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.registerPerspectiveRenderer === 'function') {
      global.TetheractTouchUI.registerPerspectiveRenderer('folder', renderFolderPerspectiveCard);
    }

    global.__extraBackHandlers = global.__extraBackHandlers || [];
    global.__extraBackHandlers.push(function handlePhoneCaseBack() {
      if (state.tagPickerOpen) { state.tagPickerOpen = false; _renderModalContent(); return 'handled'; }
      if (state.previewOpen) { state.previewOpen = false; _renderModalContent(); return 'handled'; }
      if (state.modalOpen && !state.transferring) { closePhoneCaseModal(); return 'handled'; }
      return undefined;
    });

    const adapter = _getAdapter();
    if (adapter) {
      document.getElementById('mWelcomeAddPhoneFolderBtn')?.addEventListener('click', () => adapter.pickFolder());
      adapter.onFolderScanStarted?.(() => {
        state.rescanningFolders = true;
        if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) _renderFolderCardInner(state.activeSlotEl);
        _showToast('📱 スマホフォルダの写真を読み込んでいます...', 5000);
      });
      adapter.onFolderPicked(async (res) => {
        state.rescanningFolders = false;
        if (!res || res.cancelled) {
          if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) _renderFolderCardInner(state.activeSlotEl);
          return;
        }
        if (!res.ok) {
          if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) _renderFolderCardInner(state.activeSlotEl);
          _showToast(res.error || 'フォルダの追加に失敗しました');
          return;
        }
        state.autoScannedOnce = true;
        if (Array.isArray(res.folders)) state.folders = res.folders;
        const cnt = Math.max(0, Number(res.scannedCount ?? res.totalCount ?? 0));
        if (res.folderId) state.folderCounts[res.folderId] = cnt;
        if (typeof global.__onTetheractPhoneCatalogSynced === 'function') await global.__onTetheractPhoneCatalogSynced();
        if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) _renderFolderCardInner(state.activeSlotEl);
        if (state.modalOpen) await openPhoneCaseModal(res.folderId || 'all', res.folderName || 'Uplink — 母艦に収納');
        const err = res.scanError || '';
        _showToast(err ? `⚠️ フォルダ「${res.folderName || 'Camera'}」登録時エラー: ${err}` : `✓ スマホフォルダ「${res.folderName || 'Camera'}」を管理下に登録しました (${cnt}枚)`, 3600);
      });

      adapter.onTransferProgress((prog) => {
        if (!prog) return;
        state.transferProgress = {
          current: Number(prog.current || 0), total: Number(prog.total || state.transferProgress.total || 0),
          fileName: String(prog.fileName || ''), importedCount: Number(prog.importedCount || 0),
          skippedCount: Number(prog.skippedCount || 0), errorCount: Number(prog.errorCount || 0),
        };
        if (state.modalOpen && !_updateProgressOverlayInPlace()) _renderModalContent();
      });

      adapter.onTransferCompleted((res) => {
        state.transferring = false;
        const imp = Number((res && res.importedCount) || 0);
        const skp = Number((res && res.skippedCount) || 0);
        const errCnt = Number((res && res.errorCount) || 0);
        const succeededList = Array.isArray(res && res.succeededDocKeys) ? res.succeededDocKeys : null;
        if (succeededList && succeededList.length > 0) {
          const okSet = new Set(succeededList);
          state.items.forEach((it) => { if (okSet.has(it.docKey)) { it.inMotherShip = true; state.selectedKeys.delete(it.docKey); } });
        } else if (res && res.ok && errCnt === 0) {
          state.items.forEach((it) => { if (state.selectedKeys.has(it.docKey)) it.inMotherShip = true; });
          state.selectedKeys.clear();
        }
        _renderModalContent();
        if ((imp > 0 || Number((res && res.appliedToExisting) || 0) > 0) && typeof global.__onTetheractPhoneCatalogSynced === 'function') {
          global.__onTetheractPhoneCatalogSynced();
        }
        if (!res || (!res.ok && imp === 0 && skp === 0)) { _showToast((res && res.error) || '母艦への転送中にエラーが発生しました', 4500); return; }
        if (!res.ok || errCnt > 0) {
          const rem = Number(res.remainingCount || Math.max(0, state.selectedKeys.size));
          _showToast(`⚠️ 一部未完了: ${imp}枚収納・${skp}枚重複スキップ / 残り${rem}枚が未転送です${res.error ? ` (${res.error})` : ''}。再度押すと続きから再開できます`, 5500);
          return;
        }
        _showToast(`完了: ${imp}枚を母艦 \\Loome\\case へ収納しました（重複スキップ: ${skp}枚）`, 3800);
      });
    }
  }

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, { openPhoneCaseModal, closePhoneCaseModal });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _initTouchPhoneCase);
  else _initTouchPhoneCase();
})(window);
