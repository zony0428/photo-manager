/**
 * Tetheract Touch & Tablet Phone Camera Folder & Loome\case Transfer View (Layer 3)
 *
 * 「フォルダ (Folder)」タブの先頭にスマホ内の画像フォルダ（Camera / Pictures 等）を統合し、
 * 母艦DBとの事前重複照合（未収納スキャン）、スマホ上での評価・タグ付け、
 * および母艦 \Loome\case\YYYY-MM-DD への原本ストリーム転送を担う。
 */

(function (global) {
  'use strict';

  const state = {
    folders: [],
    folderCounts: {},
    rescanningFolders: false,
    autoScannedOnce: false,
    transferring: false,
    quickUplinkRunning: false,
    quickUplinkResolver: null,
    transferProgress: { current: 0, total: 0, fileName: '', importedCount: 0, skippedCount: 0, errorCount: 0, signalSyncedCount: 0, signalOnly: false },
    activeSlotEl: null,
  };

  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const _escAttr = _escHtml;

  function _getAdapter() { return global.TetheractPhoneCaseAdapter || null; }

  function _isMotherShipLinked() {
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.isMotherShipLinked === 'function') {
      return Boolean(global.TetheractTouchUI.isMotherShipLinked());
    }
    if (global.TetheractNative && typeof global.TetheractNative.getLockerStatusJson === 'function') {
      try {
        const st = JSON.parse(global.TetheractNative.getLockerStatusJson() || '{}');
        return Boolean(st.pcOnline);
      } catch (e) {}
    }
    const badge = document.getElementById('mModeBadge');
    const txt = badge ? (badge.textContent || '').trim() : '';
    return txt === '● Wi-Fi接続' || txt === '● LINK';
  }

  function _getFolderById(folderId) {
    if (!folderId || folderId === 'all' || folderId === 'browser' || !Array.isArray(state.folders)) return null;
    return state.folders.find((f) => f && f.id === folderId) || null;
  }

  function _isWorkingFolder(folder) {
    return Boolean(folder && folder.mode === 'working');
  }

  function _hasAnyWorkingFolder() {
    return Array.isArray(state.folders) && state.folders.some((f) => _isWorkingFolder(f));
  }

  function _isThmodItem(it) {
    return Boolean(it && (it.isThmod || /^thmod_/i.test(String(it.fileName || ''))));
  }

  function _getItemFolderMode(it) {
    if (it && it.folderMode) return String(it.folderMode) === 'working' ? 'working' : 'case';
    const f = _getFolderById(it && it.folderId);
    return _isWorkingFolder(f) ? 'working' : 'case';
  }

  function _isWorkingOnlyItem(it) {
    return _getItemFolderMode(it) === 'working' && !_isThmodItem(it);
  }

  function _isPendingUplink(it) {
    if (!it) return false;
    if (typeof it.pendingUplink === 'boolean') return it.pendingUplink;
    if (_isWorkingOnlyItem(it)) {
      if (it.inMotherShip) return false;
      if (typeof it.needsSignalUplink === 'boolean') return it.needsSignalUplink;
      const hasRating = Number(it.rating || 0) !== 0;
      const hasTags = Array.isArray(it.tags) && it.tags.length > 0;
      return hasRating || hasTags;
    }
    return !it.inMotherShip;
  }

  function _showToast(msg, durationMs = 2600) {
    if (typeof global.showToast === 'function') { global.showToast(msg, durationMs); return; }
    const toast = document.getElementById('mToast');
    if (!toast) return;
    toast.textContent = String(msg || '');
    toast.style.display = 'block';
    clearTimeout(_showToast._timer);
    _showToast._timer = setTimeout(() => { toast.style.display = 'none'; }, durationMs);
  }

  async function _toggleFolderMode(folderId, nextMode, slotEl) {
    const adapter = _getAdapter();
    if (!adapter || typeof adapter.setFolderMode !== 'function' || !folderId) return false;
    const res = await adapter.setFolderMode(folderId, nextMode);
    if (!res || !res.ok) {
      _showToast((res && res.error) || 'モードの切り替えに失敗しました', 2600);
      return false;
    }
    const resolvedMode = res.mode === 'working' ? 'working' : 'case';
    if (Array.isArray(res.folders) && res.folders.length > 0) {
      state.folders = res.folders;
    } else {
      state.folders = state.folders.map((f) => (f && f.id === folderId ? Object.assign({}, f, { mode: resolvedMode }) : f));
    }
    const targetSlot = slotEl || state.activeSlotEl;
    if (targetSlot && document.body.contains(targetSlot)) {
      _renderFolderCardInner(targetSlot);
    }
    await _rescanFoldersAndSyncCatalog({ folderId, silent: true });
    _showToast(
      resolvedMode === 'working'
        ? '「信号+加工」に切替: 評価・タグ信号と thmod_ 加工画のみ母艦へ送信します'
        : '「本体収納」に切替: 未収納写真を母艦 Loome\\case へ収納します',
      2800
    );
    return true;
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
    const workingNoticeHtml = _hasAnyWorkingFolder()
      ? `<div class="t-pcase-working-notice">「信号+加工」フォルダ内の元写真は母艦へコピーされません。評価・タグ（信号）と <code>thmod_</code> 加工画のみ母艦へ送られ、SDカード取り込み時に自動合流します。</div>`
      : '';
    const folderRowsHtml = hasFolders
      ? state.folders.map((f) => {
          const fp = `📱 ${f.name}`;
          const count = _getFolderPhotoCount(f);
          const isSel = activeFp === fp;
          const isWorking = _isWorkingFolder(f);
          const nextMode = isWorking ? 'case' : 'working';
          const isVirtual = Boolean(f.isVirtual);
          const countLabel = state.rescanningFolders && count === 0 ? '走査中...' : `${count}枚`;
          const actionsHtml = isVirtual
            ? '<span class="t-pcase-mode-pill" title="Art Framerで作成した速報画像は母艦収納キューへ自動登録されます">自動収納</span>'
            : `<button type="button" class="t-pcase-mode-pill ${isWorking ? 'is-working' : ''}" data-pcase-toggle-mode="${_escAttr(f.id)}" data-pcase-next-mode="${nextMode}" data-no-dismiss="1" title="${isWorking ? '現在: 信号+加工（タップで本体収納へ切替）' : '現在: 本体収納（タップで信号+加工へ切替）'}">${isWorking ? '信号+加工' : '本体収納'}</button>
              <button type="button" class="t-pcase-unlink-btn" data-pcase-unlink="${_escAttr(f.id)}" data-no-dismiss="1" title="管理下から解除（ファイルは消えません）">✕</button>`;
          return `<div class="t-pcase-folder-row ${isSel ? 'active-include' : ''}" data-pcase-filter-folder="${_escAttr(fp)}" data-pcase-folder-id="${_escAttr(f.id)}" data-no-dismiss="1" style="${isSel ? 'border-color:var(--accent-primary);' : ''}">
            <div class="t-pcase-folder-row-main" title="タップしてギャラリーにこのフォルダの写真を表示">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;color:var(--accent-primary);"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📱 ${_escHtml(f.name)}</span>
              <span class="m-filter-count" style="margin-left:6px;flex-shrink:0;">${_escHtml(countLabel)}</span>
            </div>
            <div class="t-pcase-folder-row-actions">
              ${actionsHtml}
            </div>
          </div>`;
        }).join('') + workingNoticeHtml
      : `<div class="t-pcase-card-sub">スマホ内のカメラフォルダ（<code>DCIM/Camera</code> や <code>Pictures</code> 等）を追加すると、自動スキャンしてTetheractのギャラリー管理下に表示し、下の「母艦に収納」から一括送信できます。</div>`;

    slotEl.innerHTML = `<div class="t-pcase-folder-card" data-no-dismiss="1">
      <div class="t-pcase-card-head">
        <span class="t-pcase-card-title"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg><span>スマホ管理下フォルダ</span></span>
        <div style="display:inline-flex;gap:5px;align-items:center;flex-shrink:0;">
          ${hasFolders ? `<button type="button" class="t-pcase-add-folder-btn" data-pcase-action="rescan-folders" data-no-dismiss="1" ${state.rescanningFolders ? 'disabled' : ''}><span>${state.rescanningFolders ? '走査中...' : '↻ 更新'}</span></button>` : ''}
          <button type="button" class="t-pcase-add-folder-btn" data-pcase-action="pick-folder" data-no-dismiss="1"><span>＋ 追加</span></button>
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

      const modeBtn = e.target.closest('[data-pcase-toggle-mode]');
      if (modeBtn) {
        await _toggleFolderMode(
          modeBtn.getAttribute('data-pcase-toggle-mode') || '',
          modeBtn.getAttribute('data-pcase-next-mode') || 'case',
          slotEl
        );
        return;
      }

      if (e.target.closest('[data-pcase-action="rescan-folders"]')) { await _rescanFoldersAndSyncCatalog({ folderId: 'all', silent: false }); return; }
      if (e.target.closest('[data-pcase-action="pick-folder"]')) { await adapter.pickFolder(); return; }
      if (e.target.closest('[data-pcase-action="browser-pick"]')) { _triggerBrowserFileInput(); return; }

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
        if (files.length) _transferSelectedBrowserFiles(files);
        inp.value = '';
      });
    }
    inp.click();
  }

  function _triggerBrowserCameraCapture() {
    let inp = document.getElementById('tPhoneCaseBrowserCameraInput');
    if (!inp) {
      inp = Object.assign(document.createElement('input'), {
        type: 'file', id: 'tPhoneCaseBrowserCameraInput', accept: 'image/*',
      });
      inp.setAttribute('capture', 'environment');
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', () => {
        const files = Array.from(inp.files || []);
        if (files.length) _transferSelectedBrowserFiles(files);
        inp.value = '';
      });
    }
    inp.click();
  }

  /**
   * 端末の標準カメラアプリを起動する（ブラウザ閲覧時はカメラ撮影入力を起動する）
   */
  async function openCameraCapture() {
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.closePerspectiveSheet === 'function') {
      global.TetheractTouchUI.closePerspectiveSheet();
    }
    const adapter = _getAdapter();
    if (adapter && typeof adapter.launchCameraApp === 'function') {
      const res = await adapter.launchCameraApp();
      if (res && res.ok) return true;
      if (res && res.mode === 'native' && res.error) {
        _showToast(res.error);
        return false;
      }
    }
    _triggerBrowserCameraCapture();
    return true;
  }

  /**
   * ワンタップ差分送信中の軽量プログレスオーバーレイを表示・更新する
   */
  function _showQuickUplinkOverlay(title, text, subText, percent = 15) {
    let overlay = document.getElementById('tQuickUplinkOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tQuickUplinkOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:11800;background:rgba(10,12,16,0.68);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px);';
      overlay.innerHTML = `
        <div style="width:100%;max-width:340px;background:var(--surface-card, #1e1e1e);color:var(--text-primary, #f5f5f5);border:1px solid var(--border-color, rgba(255,255,255,0.14));border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;box-shadow:0 16px 40px rgba(0,0,0,0.45);">
          <div style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent-primary, #e14d2a)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span id="tQuickUplinkTitle"></span>
          </div>
          <div id="tQuickUplinkText" style="font-size:12px;color:var(--text-muted, #9ca6b5);word-break:break-all;line-height:1.45;"></div>
          <div style="height:6px;border-radius:3px;background:var(--bg-tertiary, rgba(255,255,255,0.1));overflow:hidden;">
            <div id="tQuickUplinkBar" style="height:100%;background:var(--accent-primary, #e14d2a);width:15%;transition:width 0.14s ease;"></div>
          </div>
          <div id="tQuickUplinkSub" style="font-size:11px;color:var(--text-muted, #9ca6b5);"></div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    const titleEl = document.getElementById('tQuickUplinkTitle');
    const txtEl = document.getElementById('tQuickUplinkText');
    const barEl = document.getElementById('tQuickUplinkBar');
    const subEl = document.getElementById('tQuickUplinkSub');
    if (titleEl) titleEl.textContent = String(title || '');
    if (txtEl) txtEl.textContent = String(text || '');
    if (barEl) barEl.style.width = `${Math.max(6, Math.min(100, Number(percent || 15)))}%`;
    if (subEl) {
      subEl.textContent = String(subText || '');
      subEl.style.display = subText ? 'block' : 'none';
    }
  }

  function _hideQuickUplinkOverlay() {
    const overlay = document.getElementById('tQuickUplinkOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  /** 転送進捗オーバーレイ用の件数サマリー文字列を組み立てる（0件の重複スキップは非表示） */
  function _formatTransferProgressSub(p) {
    const prog = p || {};
    const imp = Number(prog.importedCount || 0);
    const sig = Number(prog.signalSyncedCount || 0);
    const skp = Number(prog.skippedCount || 0);
    const err = Number(prog.errorCount || 0);
    const parts = [];
    if (imp > 0 || (!prog.signalOnly && sig === 0)) {
      parts.push(`新規収納: ${imp}枚`);
    }
    if (sig > 0 || prog.signalOnly) {
      parts.push(`信号送信: ${sig}件`);
    }
    if (skp > 0) {
      parts.push(`重複スキップ: ${skp}枚`);
    }
    if (err > 0) {
      parts.push(`リトライ失敗: ${err}枚`);
    }
    return parts.join(' / ');
  }

  function _formatPartialUplinkToast(imp, totalSignalSynced, skp, rem, errorText) {
    const parts = [];
    if (imp > 0) parts.push(`${imp}枚収納`);
    if (totalSignalSynced > 0) parts.push(`信号${totalSignalSynced}件`);
    if (skp > 0) parts.push(`${skp}枚重複スキップ`);
    const head = parts.length > 0 ? parts.join('・') : '未完了';
    const errPart = errorText ? ` (${errorText})` : '';
    return `一部未完了: ${head} / 残り${rem}件が未送信です${errPart}`;
  }

  function _formatCompleteUplinkToast(imp, totalSignalSynced, skp) {
    const skipSuffix = skp > 0 ? `（重複スキップ: ${skp}枚）` : '';
    if (imp > 0 && totalSignalSynced > 0) {
      return `完了: ${imp}枚を母艦 \\Loome\\case へ収納・信号 ${totalSignalSynced}件を同期しました${skipSuffix}`;
    }
    if (imp === 0 && totalSignalSynced > 0) {
      return `完了: 評価・タグ信号 ${totalSignalSynced}件を母艦へ同期しました${skipSuffix}`;
    }
    if (imp === 0 && totalSignalSynced === 0 && skp > 0) {
      return `完了: ${skp}枚は母艦に既存のため重複スキップしました`;
    }
    return `完了: ${imp}枚を母艦 \\Loome\\case へ収納しました${skipSuffix}`;
  }

  /**
   * リンク済みスマホフォルダの未収納写真を走査し、未収納分があれば母艦 \Loome\case へ自動転送する
   */
  async function _scanAndTransferUnstoredPhotos() {
    const adapter = _getAdapter();
    if (!adapter || !adapter.isNativeAvailable()) {
      return { skippedNoFolders: true, unstoredCount: 0, importedCount: 0 };
    }
    const listRes = await adapter.listFolders();
    const readableFolders = (Array.isArray(listRes && listRes.folders) ? listRes.folders : []).filter(
      (f) => f && f.canRead !== false
    );
    if (readableFolders.length === 0) {
      return { skippedNoFolders: true, unstoredCount: 0, importedCount: 0 };
    }

    _showQuickUplinkOverlay('母艦への差分収納を準備中...', 'スマホ管理下フォルダの未収納写真を確認しています', '', 15);
    const scanRes = await adapter.scanPhotos('all', { includeItems: true, force: true });
    _updateFolderCountsFromScanResult(scanRes, 'all');
    if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) {
      _renderFolderCardInner(state.activeSlotEl);
    }

    const unstored = (Array.isArray(scanRes && scanRes.items) ? scanRes.items : []).filter((it) => _isPendingUplink(it));
    if (unstored.length === 0) {
      _hideQuickUplinkOverlay();
      return { ok: true, unstoredCount: 0, importedCount: 0, appliedToExisting: 0, queuedPendingSignals: 0, signalSyncedCount: 0 };
    }

    const allSignalOnly = unstored.every((it) => _isWorkingOnlyItem(it));
    state.transferring = true;
    state.transferProgress = {
      current: 0,
      total: unstored.length,
      fileName: '母艦DBと照合中...',
      importedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      signalSyncedCount: 0,
      signalOnly: allSignalOnly,
    };
    _showQuickUplinkOverlay(
      allSignalOnly ? '母艦へ評価・タグ信号を送信中...' : '母艦 \\Loome\\case へ未収納写真・信号を送信中...',
      `0 / ${unstored.length} 件 · 母艦DBと照合中...`,
      _formatTransferProgressSub(state.transferProgress),
      12
    );

    let timeoutId = null;
    const donePromise = new Promise((resolve) => {
      state.quickUplinkResolver = (res) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(res);
      };
      timeoutId = setTimeout(() => {
        if (state.quickUplinkResolver) {
          state.quickUplinkResolver = null;
          state.transferring = false;
          resolve({ ok: false, error: '転送待機がタイムアウトしました' });
        }
      }, 3600000);
    });

    const startRes = await adapter.transferToMotherShip({ items: unstored, commonTags: [] });
    if (!startRes || !startRes.ok) {
      if (timeoutId) clearTimeout(timeoutId);
      state.quickUplinkResolver = null;
      state.transferring = false;
      _hideQuickUplinkOverlay();
      return {
        ok: false,
        unstoredCount: unstored.length,
        importedCount: 0,
        error: (startRes && startRes.error) || '未収納写真の転送開始に失敗しました',
      };
    }

    const transferRes = await donePromise;
    _hideQuickUplinkOverlay();
    return Object.assign({ unstoredCount: unstored.length }, transferRes || {});
  }

  /**
   * ワンタップ差分一括収納:
   * スマホ管理フォルダの未収納写真転送 ＋ Wi-Fi双方向差分同期（GPSフィールドログ・選別変更・最新DB）を実行する
   */
  async function triggerQuickDeltaUplink() {
    global.TetheractTouchUI?.closePerspectiveSheet?.();
    if (state.transferring || state.quickUplinkRunning) {
      _showToast('現在すでに母艦への収納を実行中です');
      return false;
    }

    if (!global.TetheractNative) {
      if (
        (global.location.protocol === 'file:' || global.__PM_STANDALONE_HTML__) &&
        typeof global.__exportSyncToAndroidUsb === 'function'
      ) {
        global.__exportSyncToAndroidUsb();
        return true;
      }
      _triggerBrowserFileInput();
      return true;
    }

    state.quickUplinkRunning = true;
    try {
      let st = {};
      try {
        st = JSON.parse(global.TetheractNative.getLockerStatusJson?.() || '{}');
      } catch (e) {
        st = {};
      }

      if (!st.wifiConfigured || !st.hasLockerDb) {
        // 初回未ペアリング・DB未取得時はPC自動検出＆同期を先行し、成功後に未収納写真・信号を自動送信する
        const onPairedSyncDone = async (ev) => {
          global.removeEventListener('tetheract:usb-sync-completed', onPairedSyncDone);
          clearTimeout(cleanupTimer);
          const detail = (ev && ev.detail) || {};
          if (!detail.ok || state.transferring || state.quickUplinkRunning) return;
          state.quickUplinkRunning = true;
          try {
            const followRes = await _scanAndTransferUnstoredPhotos();
            if (followRes && followRes.unstoredCount > 0) {
              const imp = Number(followRes.importedCount || 0);
              const skp = Number(followRes.skippedCount || 0);
              const app = Number(followRes.appliedToExisting || 0);
              const qSig = Number(followRes.queuedPendingSignals || 0);
              const sigOk = Number(followRes.signalSyncedCount || 0);
              const totalSignalSynced = app + qSig + sigOk;
              const rem = Number(followRes.remainingCount || 0);
              if (imp > 0 || totalSignalSynced > 0) {
                global.__pendingQuickUplinkSummary = {
                  importedCount: imp,
                  skippedCount: skp,
                  queuedPendingSignals: qSig,
                  signalSyncedCount: sigOk,
                  signalCount: totalSignalSynced,
                  partialRemaining: rem,
                };
                if (typeof global.__onTetheractPhoneCatalogSynced === 'function') {
                  global.__onTetheractPhoneCatalogSynced();
                }
                if (imp > 0 && totalSignalSynced > 0) {
                  _showToast(`収納 ${imp}枚 / 信号送信 ${totalSignalSynced}件完了 — 続けてDB差分を同期中...`, 2400);
                } else if (imp > 0) {
                  _showToast(`未収納写真 ${imp}枚を収納完了 — 最新DBを反映中...`, 2400);
                } else {
                  _showToast(`評価・タグ信号 ${totalSignalSynced}件を母艦へ送信完了 — 最新DBを反映中...`, 2400);
                }
              } else if (!followRes.ok && followRes.error) {
                _showToast(followRes.error, 4200);
              }
            }
          } finally {
            _hideQuickUplinkOverlay();
            state.quickUplinkRunning = false;
          }
        };
        const cleanupTimer = setTimeout(() => {
          global.removeEventListener('tetheract:usb-sync-completed', onPairedSyncDone);
        }, 90000);
        global.addEventListener('tetheract:usb-sync-completed', onPairedSyncDone);
        if (typeof global.__syncLockerOverWifi === 'function') global.__syncLockerOverWifi();
        return true;
      }

      const upRes = await _scanAndTransferUnstoredPhotos();
      if (upRes && upRes.unstoredCount > 0) {
        const imp = Number(upRes.importedCount || 0);
        const skp = Number(upRes.skippedCount || 0);
        const app = Number(upRes.appliedToExisting || 0);
        const qSig = Number(upRes.queuedPendingSignals || 0);
        const sigOk = Number(upRes.signalSyncedCount || 0);
        const totalSignalSynced = app + qSig + sigOk;
        const errCnt = Number(upRes.errorCount || 0);
        const rem = Number(upRes.remainingCount || 0);

        if (!upRes.ok && imp === 0 && skp === 0 && totalSignalSynced === 0) {
          _showToast(upRes.error || '母艦PCへの接続に失敗しました', 4500);
          return false;
        }
        if (upRes.aborted) {
          if (imp > 0 || totalSignalSynced > 0 || skp > 0) {
            global.__pendingQuickUplinkSummary = {
              importedCount: imp,
              skippedCount: skp,
              queuedPendingSignals: qSig,
              signalSyncedCount: sigOk,
              signalCount: totalSignalSynced,
              partialRemaining: rem,
            };
          }
          _showToast(_formatPartialUplinkToast(imp, totalSignalSynced, skp, rem, upRes.error), 5500);
          return false;
        }

        global.__pendingQuickUplinkSummary = {
          importedCount: imp,
          skippedCount: skp,
          queuedPendingSignals: qSig,
          signalSyncedCount: sigOk,
          signalCount: totalSignalSynced,
          partialRemaining: errCnt > 0 ? rem : 0,
        };
        if (imp > 0 || totalSignalSynced > 0) {
          // ネイティブ側で転送完了後に自動でWi-Fi差分同期（GPSログ送信＋DB取得）が直列実行される
          if (imp > 0 && totalSignalSynced > 0) {
            _showToast(`収納 ${imp}枚 / 信号送信 ${totalSignalSynced}件完了 — 続けてGPSログ・DB差分を同期中...`, 2400);
          } else if (imp > 0) {
            _showToast(`未収納写真 ${imp}枚を収納完了 — 続けてGPSログ・DB差分を同期中...`, 2400);
          } else {
            _showToast(`評価・タグ信号 ${totalSignalSynced}件を母艦へ送信完了 — 続けてDB差分を同期中...`, 2400);
          }
          return true;
        }
      }

      if (typeof global.__syncLockerOverWifi === 'function') {
        global.__syncLockerOverWifi();
      }
      return true;
    } finally {
      _hideQuickUplinkOverlay();
      state.quickUplinkRunning = false;
    }
  }

  async function _transferSelectedBrowserFiles(files) {
    const adapter = _getAdapter();
    if (!adapter || !files || !files.length || state.transferring) return;
    state.transferring = true;
    state.quickUplinkRunning = true;
    state.transferProgress = {
      current: 0,
      total: files.length,
      fileName: '母艦DBと照合中...',
      importedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      signalSyncedCount: 0,
      signalOnly: false,
    };
    _showQuickUplinkOverlay(
      '母艦 \\Loome\\case へ写真を転送中...',
      `0 / ${files.length} 枚 · 準備中...`,
      _formatTransferProgressSub(state.transferProgress),
      12
    );
    try {
      const docKeys = files.map((f, idx) => `bf_${idx}_${f.name}_${f.size}`);
      await adapter.transferBrowserFiles(files, { commonTags: [], draftMap: {}, docKeys });
    } finally {
      _hideQuickUplinkOverlay();
      state.transferring = false;
      state.quickUplinkRunning = false;
    }
  }

  function _initTouchPhoneCase() {
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.registerPerspectiveRenderer === 'function') {
      global.TetheractTouchUI.registerPerspectiveRenderer('folder', renderFolderPerspectiveCard);
    }

    global.addEventListener('tetheract:link-state-changed', () => {
      if (state.activeSlotEl && document.body.contains(state.activeSlotEl)) {
        _renderFolderCardInner(state.activeSlotEl);
      }
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
        const err = res.scanError || '';
        _showToast(err ? `⚠️ フォルダ「${res.folderName || 'Camera'}」登録時エラー: ${err}` : `✓ スマホフォルダ「${res.folderName || 'Camera'}」を管理下に登録しました (${cnt}枚)`, 3600);
      });

      adapter.onTransferProgress((prog) => {
        if (!prog) return;
        const prevSignalOnly = Boolean(state.transferProgress && state.transferProgress.signalOnly);
        state.transferProgress = {
          current: Number(prog.current || 0),
          total: Number(prog.total || state.transferProgress.total || 0),
          fileName: String(prog.fileName || ''),
          importedCount: Number(prog.importedCount || 0),
          skippedCount: Number(prog.skippedCount || 0),
          errorCount: Number(prog.errorCount || 0),
          signalSyncedCount: Number(prog.signalSyncedCount || 0),
          signalOnly: prevSignalOnly,
        };
        if (state.quickUplinkRunning) {
          const p = state.transferProgress;
          const pct = p.total > 0 ? Math.min(100, Math.round((p.current / p.total) * 100)) : 20;
          const sub = _formatTransferProgressSub(p);
          _showQuickUplinkOverlay(
            p.signalOnly ? '母艦へ評価・タグ信号を送信中...' : '母艦 \\Loome\\case へ未収納写真を転送中...',
            `${p.current} / ${p.total} 枚 · ${p.fileName || '照合中...'}`,
            sub,
            pct
          );
        }
      });

      adapter.onTransferCompleted((res) => {
        state.transferring = false;
        if (typeof state.quickUplinkResolver === 'function') {
          const resolveFn = state.quickUplinkResolver;
          state.quickUplinkResolver = null;
          resolveFn(res || { ok: false });
          return;
        }
        _hideQuickUplinkOverlay();
        const imp = Number((res && res.importedCount) || 0);
        const skp = Number((res && res.skippedCount) || 0);
        const app = Number((res && res.appliedToExisting) || 0);
        const qSig = Number((res && res.queuedPendingSignals) || 0);
        const sigOk = Number((res && res.signalSyncedCount) || 0);
        const totalSignalSynced = app + qSig + sigOk;
        const errCnt = Number((res && res.errorCount) || 0);
        if ((imp > 0 || totalSignalSynced > 0) && typeof global.__onTetheractPhoneCatalogSynced === 'function') {
          global.__onTetheractPhoneCatalogSynced();
        }
        if (!res || (!res.ok && imp === 0 && skp === 0 && totalSignalSynced === 0)) {
          _showToast((res && res.error) || '母艦への転送中にエラーが発生しました', 4500);
          return;
        }
        if (!res.ok || errCnt > 0) {
          const rem = Number(res.remainingCount || 0);
          _showToast(`${_formatPartialUplinkToast(imp, totalSignalSynced, skp, rem, res.error)}。再度押すと続きから再開できます`, 5500);
          return;
        }
        _showToast(_formatCompleteUplinkToast(imp, totalSignalSynced, skp), imp > 0 && totalSignalSynced > 0 ? 4000 : 3800);
      });
    }
  }

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, {
    openCameraCapture,
    triggerQuickDeltaUplink,
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _initTouchPhoneCase);
  else _initTouchPhoneCase();
})(window);
