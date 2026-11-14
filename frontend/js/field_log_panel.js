/**
 * PC フィールドログ管理・撮影時刻照合・位置付与・Undo モーダル (field_log_panel.js)
 * Layer 1 (FieldLogApi 通信アダプタ) と Layer 3 (モーダル View / Controller) を分離して構成する。
 */
(function () {
  'use strict';

  // Layer 1: FieldLogApi（HTTP 通信アダプタ — DOM 操作禁止）
  const FieldLogApi = {
    async req(url, options = {}) {
      const res = await fetch(url, options);
      let data = null;
      try { data = await res.json(); } catch (_e) { data = null; }
      if (!res.ok) {
        const msg = (data && (data.detail || data.error || data.message)) || `HTTP ${res.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      return data || {};
    },
    post(url, body) { return this.req(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    fetchLogs() { return this.req('/api/field-logs'); },
    deleteLogs(payload) { return this.post('/api/field-logs/delete', payload); },
    buildGpxUrl(devId, dt) { return `/api/field-logs/${encodeURIComponent(String(devId || ''))}/${encodeURIComponent(String(dt || ''))}.gpx`; },
    previewMatch(params) { return this.post('/api/field-logs/match/preview', params); },
    applyMatch(params) { return this.post('/api/field-logs/match/apply', params); },
    fetchBatches() { return this.req('/api/field-logs/match/batches'); },
    undoBatch(batchId) { return this.post('/api/field-logs/match/undo', { batch_id: String(batchId || '') }); },
  };

  // 共通フォーマッタ・エスケープ（ローカル時刻方式徹底）
  const $id = (id) => document.getElementById(id);
  const _pad2 = (n) => String(n).padStart(2, '0');
  function _esc(val) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(val);
    if (val === null || val === undefined) return '';
    return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _toEpochMs(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e11 ? raw : raw * 1000;
    const str = String(raw).trim();
    if (/^\d+(\.\d+)?$/.test(str)) {
      const num = Number(str);
      if (Number.isFinite(num) && num > 0) return num > 1e11 ? num : num * 1000;
    }
    return null;
  }

  function formatTimeShort(val) {
    if (val === null || val === undefined || val === '') return '-';
    const ms = _toEpochMs(val);
    if (ms !== null) {
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
    }
    const s = String(val).trim();
    const m = s.match(/(\d{2}:\d{2})(:\d{2})?/);
    return m ? m[1] : s;
  }

  function formatLocalDateTime(val) {
    if (val === null || val === undefined || val === '') return '-';
    const ms = _toEpochMs(val);
    if (ms !== null) {
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())} ${_pad2(d.getHours())}:${_pad2(d.getMinutes())}:${_pad2(d.getSeconds())}`;
    }
    return String(val).trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  }

  function formatDistance(meters) {
    const m = Number(meters);
    if (!Number.isFinite(m) || m < 0) return '-';
    return m < 1000 ? `${Math.round(m).toLocaleString()} m` : `${(m / 1000).toFixed(2)} km`;
  }

  function formatSize(bytes) {
    const b = Number(bytes);
    if (!Number.isFinite(b) || b < 0) return '-';
    if (typeof window.formatBytes === 'function') return window.formatBytes(b);
    return b < 1024 ? `${b} B` : (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(2)} MB`);
  }

  const notify = (msg, type = 'info', duration = 3500) => { if (typeof window.showToast === 'function') window.showToast(msg, type, duration); };

  // =========================================================================
  // Layer 3: モーダル状態 & View / Input Controller
  // =========================================================================
  const panelState = {
    mounted: false, isOpen: false, busy: false, activeTab: 'logs',
    devices: [], checkedTargets: new Set(), batches: [],
    matchScope: 'dates', matchDates: new Set(), folderPath: '', includeStackMembers: true,
    deviceId: '', overwrite: 'missing_only', maxGapSec: 300, maxNearestSec: 120,
    cameraOffsets: new Map(), knownCameras: new Set(),
    previewResult: null, previewFilter: 'all', previewShowAllRows: false,
  };

  let modalBackdropEl = null;
  const makeTargetKey = (devId, dt) => `${devId}\t${dt}`;
  const parseTargetKey = (key) => {
    const idx = key.indexOf('\t');
    return idx < 0 ? null : { device_id: key.slice(0, idx), date: key.slice(idx + 1) };
  };

  function getAllAvailableDates() {
    const dateSet = new Set();
    panelState.devices.forEach((dev) => (dev.days || []).forEach((d) => { if (d && d.date) dateSet.add(String(d.date)); }));
    return Array.from(dateSet).sort().reverse();
  }

  function getCurrentFolderFromAppState() {
    if (typeof state !== 'undefined' && state.currentFilter && state.currentFilter.type === 'folder' && state.currentFilter.value) {
      return String(state.currentFilter.value);
    }
    return '';
  }

  function collectSelectedPhotoIds(expandStacks) {
    if (typeof state === 'undefined') return [];
    const baseIds = (state.selectedPhotoIds && state.selectedPhotoIds.size > 0)
      ? Array.from(state.selectedPhotoIds)
      : (state.activeInspectorPhotoId ? [Number(state.activeInspectorPhotoId)] : []);
    const out = [];
    const seen = new Set();
    const pushId = (raw) => {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
    };
    baseIds.forEach((id) => {
      pushId(id);
      if (expandStacks && Array.isArray(state.photos)) {
        const card = state.photos.find((p) => p && p.id === Number(id));
        if (card && Array.isArray(card.stack_photos)) card.stack_photos.forEach((sp) => { if (sp && sp.id) pushId(sp.id); });
      }
    });
    return out;
  }

  function collectCandidateCamerasFromApp() {
    if (typeof state === 'undefined') return;
    const ids = collectSelectedPhotoIds(true);
    if (ids.length > 0 && typeof window.findPhotoByIdAnywhere === 'function') {
      ids.forEach((id) => {
        const p = window.findPhotoByIdAnywhere(id);
        if (p && p.camera_model) panelState.knownCameras.add(String(p.camera_model).trim());
      });
    }
    if (panelState.knownCameras.size === 0 && Array.isArray(state.availableCameras)) {
      state.availableCameras.slice(0, 8).forEach((c) => {
        const name = typeof c === 'string' ? c : (c && (c.camera_model || c.name));
        if (name && name !== '不明') panelState.knownCameras.add(String(name).trim());
      });
    }
  }

  async function refreshMainLibraryViews() {
    const tasks = [];
    if (typeof window.fetchPhotos === 'function') tasks.push(window.fetchPhotos());
    else if (typeof fetchPhotos === 'function') tasks.push(fetchPhotos());
    if (typeof window.loadLocationTree === 'function') tasks.push(window.loadLocationTree());
    try { await Promise.all(tasks); } catch (err) { console.warn('[FieldLog] 一覧更新エラー:', err); }
    if (typeof window.updateInspectorView === 'function') window.updateInspectorView();
    else if (typeof updateInspectorView === 'function') updateInspectorView();
    if (typeof window.renderFilterChips === 'function') window.renderFilterChips();
  }

  // =========================================================================
  // DOM マウント & イベント結線
  // =========================================================================
  function ensureModalMounted() {
    if (panelState.mounted && modalBackdropEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'field-log-modal-backdrop';
    wrap.id = 'fieldLogModal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `<div class="field-log-modal-card">
      <div class="fl-modal-header">
        <div class="fl-modal-title-wrap">
          <h2 class="fl-modal-title"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg><span>GPSフィールドログ（管理・時刻照合・位置付与）</span></h2>
          <span class="fl-modal-subtitle">スマホで記録した日付別GPSログから、カメラ写真へ非破壊で位置情報と地名を結び合わせます</span>
        </div>
        <button type="button" class="fl-modal-close-btn" id="flCloseModalBtn" title="閉じる (Esc)">&times;</button>
      </div>
      <div class="fl-tabs-bar">
        <div class="fl-tabs-group" id="flTabsGroup">
          <button type="button" class="fl-tab-btn active" data-fl-tab="logs"><span>① ログ一覧・削除</span><span class="fl-pill" id="flTabLogsCount">0日</span></button>
          <button type="button" class="fl-tab-btn" data-fl-tab="match"><span>② 写真と時刻照合・位置付与</span></button>
          <button type="button" class="fl-tab-btn" data-fl-tab="batches"><span>③ 適用履歴・取り消し</span><span class="fl-pill" id="flTabBatchesCount">0</span></button>
        </div>
        <button type="button" class="btn btn-secondary btn-xs" id="flReloadCurrentTabBtn" title="最新の状態を再読み込み">再読込</button>
      </div>
      <div class="fl-modal-body">
        <div class="fl-tab-pane active" id="flPane-logs">
          <div class="fl-notice-box"><strong>削除と位置取り消しの違い：</strong>※フィールドログのファイルを削除しても、すでに写真へ適用済みの位置情報は消えません。写真の位置を元に戻したい場合は<button type="button" class="fl-inline-link-btn" id="flJumpToBatchesLink">「適用履歴・取り消し」タブ</button>から取り消してください。</div>
          <div class="fl-toolbar-row">
            <div class="fl-toolbar-group"><button type="button" class="btn btn-secondary btn-xs" id="flSelectAllLogsBtn">すべて選択</button><button type="button" class="btn btn-secondary btn-xs" id="flClearLogsSelBtn">選択解除</button><button type="button" class="btn btn-primary btn-xs" id="flGoMatchSelectedBtn" disabled>選択した日で時刻照合へ ▶</button></div>
            <div class="fl-toolbar-group"><button type="button" class="btn btn-danger btn-xs" id="flDeleteSelectedLogsBtn" disabled>選択した日を削除</button><button type="button" class="btn btn-secondary btn-xs" id="flDeleteAllLogsBtn" style="color: #ef4444;">すべてのログを削除</button></div>
          </div>
          <div id="flDevicesContainer" style="display: flex; flex-direction: column; gap: 10px;"></div>
        </div>
        <div class="fl-tab-pane" id="flPane-match">
          <div class="fl-config-grid">
            <div class="fl-section-card">
              <div class="fl-section-title">1. 照合する写真の対象範囲</div>
              <div class="fl-scope-list" id="flScopeList">
                <label class="fl-scope-option is-active" data-scope-card="dates"><input type="radio" name="flMatchScope" value="dates" checked><div><div style="font-weight: 700;">ログ記録日の写真</div><div style="font-size: 0.73rem; color: var(--text-muted);">選択した日付に撮影された写真を照合します（日付境界の前後も自動考慮）</div></div></label>
                <label class="fl-scope-option" data-scope-card="folder"><input type="radio" name="flMatchScope" value="folder"><div><div style="font-weight: 700;">現在開いているフォルダの写真</div><div style="font-size: 0.73rem; color: var(--text-muted);">指定フォルダ内の写真をまとめて照合します</div></div></label>
                <label class="fl-scope-option" data-scope-card="selection"><input type="radio" name="flMatchScope" value="selection"><div><div style="font-weight: 700;">現在選択中の写真</div><div style="font-size: 0.73rem; color: var(--text-muted);" id="flSelectionCountHint">グリッドで選択中の写真を照合します</div></div></label>
              </div>
              <div class="fl-scope-detail" id="flScopeDetailDates">
                <div class="fl-toolbar-row"><span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted);">対象日（クリックで選択/解除）:</span><div style="display: flex; gap: 4px;"><button type="button" class="btn btn-secondary btn-xs" id="flMatchSelectAllDatesBtn">全ログ日を選択</button><button type="button" class="btn btn-secondary btn-xs" id="flMatchClearDatesBtn">クリア</button></div></div>
                <div class="fl-date-chip-list" id="flMatchDateChips"></div>
                <div class="fl-field-row"><input type="date" class="fl-input" id="flCustomDateInput" title="任意の日付を追加"><button type="button" class="btn btn-secondary btn-xs" id="flAddCustomDateBtn">日付を追加</button></div>
              </div>
              <div class="fl-scope-detail" id="flScopeDetailFolder" style="display: none;"><div class="fl-field-row"><input type="text" class="fl-input" id="flFolderPathInput" placeholder="対象フォルダのパス..." style="flex: 1; min-width: 180px;"><button type="button" class="btn btn-secondary btn-xs" id="flSyncCurrentFolderBtn" title="左ペインで現在開いているフォルダを反映">現在フォルダを取得</button></div></div>
              <div class="fl-scope-detail" id="flScopeDetailSelection" style="display: none;"><label style="display: flex; align-items: center; gap: 6px; font-size: 0.77rem; cursor: pointer;"><input type="checkbox" id="flIncludeStackCheck" checked style="accent-color: var(--accent-primary);"><span>連写・ブラケット等のスタック内コマも含める</span></label></div>
            </div>
            <div class="fl-section-card">
              <div class="fl-section-title">2. 補間・上書き方針・時計ズレ補正</div>
              <div class="fl-field-row"><label class="fl-field-label" for="flDeviceSelect">参照ログ端末</label><select class="fl-select" id="flDeviceSelect" style="flex: 1; min-width: 150px;"><option value="">すべての端末</option></select></div>
              <div class="fl-field-row"><label class="fl-field-label" for="flOverwriteSelect">上書き方針</label><select class="fl-select" id="flOverwriteSelect" style="flex: 1; min-width: 150px;"><option value="missing_only" selected>GPSのない写真のみ（既定）</option><option value="replace_inferred">推定・フィールドログ由来のみ上書き</option><option value="all">手動設定（manual）以外すべて上書き</option></select></div>
              <div class="fl-field-row"><label class="fl-field-label" for="flMaxGapInput" title="前後2点の間隔がこの秒数以下なら線形補間で算出">線形補間の許容間隔</label><input type="number" class="fl-input fl-input-num" id="flMaxGapInput" min="10" max="7200" step="10" value="300"><span style="color: var(--text-muted); font-size: 0.75rem;">秒以内</span></div>
              <div class="fl-field-row"><label class="fl-field-label" for="flMaxNearestInput" title="線形補間できない場合に最寄り1点を採用する最大秒差">最寄り点の許容差</label><input type="number" class="fl-input fl-input-num" id="flMaxNearestInput" min="0" max="3600" step="10" value="120"><span style="color: var(--text-muted); font-size: 0.75rem;">秒以内</span></div>
              <div style="border-top: 1px solid var(--border-soft); padding-top: 6px; margin-top: 2px;">
                <div class="fl-toolbar-row" style="margin-bottom: 4px;"><span style="font-size: 0.76rem; font-weight: 700;">カメラ機種別の時計補正（秒）</span><span style="font-size: 0.7rem; color: var(--text-dim);">※30秒進みなら -30</span></div>
                <div class="fl-cam-offset-list" id="flCameraOffsetsList"></div>
                <div class="fl-field-row" style="margin-top: 5px;"><input type="text" class="fl-input" id="flNewCamModelInput" list="flCameraModelSuggestions" placeholder="機種名を追加 (例: ILCE-7M4)" style="flex: 1; min-width: 120px; font-size: 0.74rem; padding: 3px 7px;"><datalist id="flCameraModelSuggestions"></datalist><button type="button" class="btn btn-secondary btn-xs" id="flAddCamModelBtn">+ 機種追加</button></div>
              </div>
            </div>
          </div>
          <div class="fl-match-action-bar">
            <div class="fl-toolbar-group"><button type="button" class="btn btn-secondary btn-sm" id="flRunPreviewBtn">照合プレビュー</button><div id="flPreviewSummaryPills" class="fl-toolbar-group"><span style="font-size: 0.77rem; color: var(--text-muted);">条件を選んで「照合プレビュー」を押してください</span></div></div>
            <div class="fl-toolbar-group"><select class="fl-select" id="flPreviewFilterSelect" style="font-size: 0.74rem; padding: 3px 6px; display: none;"><option value="all">すべて表示</option><option value="matched">一致のみ</option><option value="other">未一致・スキップ</option></select><button type="button" class="btn btn-primary btn-sm" id="flApplyMatchBtn" disabled>この内容で位置を付与</button></div>
          </div>
          <div id="flPreviewContainer"></div>
        </div>
        <div class="fl-tab-pane" id="flPane-batches">
          <div class="fl-notice-box">過去の「位置を付与」実行ごとに適用前の座標・地名がバックアップされています。「適用を取り消す」を実行すると、そのバッチで変更された写真を適用前の状態へ安全に戻せます。</div>
          <div id="flBatchesContainer" class="fl-batch-list"></div>
        </div>
      </div>
      <div class="fl-modal-footer"><span class="fl-footer-hint">元画像ファイルは一切書き換えません（DB上の非破壊記録 ＆ スマート・テイクアウト時にEXIF反映可）</span><button type="button" class="btn btn-secondary" id="flFooterCloseBtn">閉じる (Esc)</button></div>
    </div>`;
    document.body.appendChild(wrap);
    modalBackdropEl = wrap;
    panelState.mounted = true;
    bindModalEvents();
  }

  function bindModalEvents() {
    $id('flCloseModalBtn')?.addEventListener('click', closeFieldLogModal);
    $id('flFooterCloseBtn')?.addEventListener('click', closeFieldLogModal);
    modalBackdropEl.addEventListener('click', (e) => { if (e.target === modalBackdropEl) closeFieldLogModal(); });
    $id('flTabsGroup')?.addEventListener('click', (e) => { const b = e.target.closest('.fl-tab-btn'); if (b) switchTab(b.dataset.flTab || 'logs'); });
    $id('flJumpToBatchesLink')?.addEventListener('click', () => switchTab('batches'));
    $id('flReloadCurrentTabBtn')?.addEventListener('click', () => (panelState.activeTab === 'batches' ? loadBatches() : loadFieldLogs()));

    $id('flSelectAllLogsBtn')?.addEventListener('click', () => {
      panelState.devices.forEach((dev) => (dev.days || []).forEach((d) => { if (d && d.date) panelState.checkedTargets.add(makeTargetKey(dev.device_id, d.date)); }));
      renderLogsPane();
    });
    $id('flClearLogsSelBtn')?.addEventListener('click', () => { panelState.checkedTargets.clear(); renderLogsPane(); });
    $id('flGoMatchSelectedBtn')?.addEventListener('click', () => {
      panelState.matchDates.clear();
      const devIds = new Set();
      panelState.checkedTargets.forEach((k) => { const p = parseTargetKey(k); if (p) { panelState.matchDates.add(p.date); devIds.add(p.device_id); } });
      panelState.matchScope = 'dates';
      panelState.deviceId = devIds.size === 1 ? Array.from(devIds)[0] : '';
      switchTab('match');
      runMatchPreview();
    });
    $id('flDeleteSelectedLogsBtn')?.addEventListener('click', handleDeleteSelectedLogs);
    $id('flDeleteAllLogsBtn')?.addEventListener('click', handleDeleteAllLogs);

    document.querySelectorAll('input[name="flMatchScope"]').forEach((radio) => {
      radio.addEventListener('change', () => { if (radio.checked) { panelState.matchScope = radio.value; invalidatePreviewResult(); renderMatchConfigState(); } });
    });
    $id('flMatchSelectAllDatesBtn')?.addEventListener('click', () => { getAllAvailableDates().forEach((dt) => panelState.matchDates.add(dt)); invalidatePreviewResult(); renderMatchDateChips(); });
    $id('flMatchClearDatesBtn')?.addEventListener('click', () => { panelState.matchDates.clear(); invalidatePreviewResult(); renderMatchDateChips(); });
    $id('flAddCustomDateBtn')?.addEventListener('click', () => {
      const val = String($id('flCustomDateInput')?.value || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) { notify('日付を YYYY-MM-DD 形式で選択してください', 'warning'); return; }
      panelState.matchDates.add(val);
      invalidatePreviewResult();
      renderMatchDateChips();
    });
    $id('flFolderPathInput')?.addEventListener('input', (e) => { panelState.folderPath = e.target.value; invalidatePreviewResult(); });
    $id('flSyncCurrentFolderBtn')?.addEventListener('click', () => {
      const cur = getCurrentFolderFromAppState();
      if (!cur) { notify('現在左ペインでフォルダが選択されていません', 'info'); return; }
      panelState.folderPath = cur;
      if ($id('flFolderPathInput')) $id('flFolderPathInput').value = cur;
      invalidatePreviewResult();
    });
    $id('flIncludeStackCheck')?.addEventListener('change', (e) => { panelState.includeStackMembers = Boolean(e.target.checked); invalidatePreviewResult(); renderMatchConfigState(); });
    $id('flDeviceSelect')?.addEventListener('change', (e) => { panelState.deviceId = e.target.value || ''; invalidatePreviewResult(); });
    $id('flOverwriteSelect')?.addEventListener('change', (e) => { panelState.overwrite = e.target.value || 'missing_only'; invalidatePreviewResult(); });
    $id('flMaxGapInput')?.addEventListener('change', (e) => { panelState.maxGapSec = Math.max(1, parseInt(e.target.value, 10) || 300); invalidatePreviewResult(); });
    $id('flMaxNearestInput')?.addEventListener('change', (e) => { panelState.maxNearestSec = Math.max(0, parseInt(e.target.value, 10) || 120); invalidatePreviewResult(); });
    $id('flAddCamModelBtn')?.addEventListener('click', () => {
      const inp = $id('flNewCamModelInput');
      const name = inp ? String(inp.value || '').trim() : '';
      if (!name) return;
      panelState.knownCameras.add(name);
      if (!panelState.cameraOffsets.has(name)) panelState.cameraOffsets.set(name, 0);
      inp.value = '';
      renderCameraOffsetsList();
    });
    $id('flPreviewFilterSelect')?.addEventListener('change', (e) => { panelState.previewFilter = e.target.value || 'all'; renderPreviewTable(); });
    $id('flRunPreviewBtn')?.addEventListener('click', runMatchPreview);
    $id('flApplyMatchBtn')?.addEventListener('click', handleApplyMatch);

    window.addEventListener('keydown', (e) => {
      if (!panelState.isOpen) return;
      const cm = $id('commonConfirmModal');
      if (cm && cm.style.display && cm.style.display !== 'none') return;
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
        if (e.key === 'Escape') { document.activeElement.blur(); e.stopImmediatePropagation(); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeFieldLogModal(); return; }
      if (!e.altKey && e.key !== 'Tab' && e.key !== 'F5' && e.key !== 'F12') e.stopPropagation();
    }, true);
  }

  function switchTab(tabName) {
    panelState.activeTab = ['logs', 'match', 'batches'].includes(tabName) ? tabName : 'logs';
    document.querySelectorAll('#flTabsGroup .fl-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.flTab === panelState.activeTab));
    ['logs', 'match', 'batches'].forEach((t) => $id(`flPane-${t}`)?.classList.toggle('active', t === panelState.activeTab));
    if (panelState.activeTab === 'match') {
      if (panelState.matchDates.size === 0) getAllAvailableDates().forEach((dt) => panelState.matchDates.add(dt));
      if (!panelState.folderPath) panelState.folderPath = getCurrentFolderFromAppState();
      collectCandidateCamerasFromApp();
      renderMatchConfigState();
      renderCameraOffsetsList();
    } else if (panelState.activeTab === 'batches') {
      loadBatches();
    }
  }

  // =========================================================================
  // ① ログ一覧・削除・GPX書き出し
  // =========================================================================
  async function loadFieldLogs() {
    const container = $id('flDevicesContainer');
    if (container) container.innerHTML = '<div class="fl-empty-box">読み込み中...</div>';
    try {
      const data = await FieldLogApi.fetchLogs();
      const rawDevices = Array.isArray(data.devices) ? data.devices : (Array.isArray(data) ? data : []);
      panelState.devices = rawDevices.map((d) => ({
        device_id: String(d.device_id || ''),
        device_name: String(d.device_name || d.device_id || 'Android端末'),
        days: Array.isArray(d.days) ? d.days : [],
      }));
      const validKeys = new Set();
      let totalDays = 0;
      panelState.devices.forEach((dev) => dev.days.forEach((day) => {
        if (day && day.date) { validKeys.add(makeTargetKey(dev.device_id, day.date)); totalDays += 1; }
      }));
      Array.from(panelState.checkedTargets).forEach((k) => { if (!validKeys.has(k)) panelState.checkedTargets.delete(k); });
      if (panelState.matchDates.size === 0) getAllAvailableDates().forEach((dt) => panelState.matchDates.add(dt));
      if ($id('flTabLogsCount')) $id('flTabLogsCount').textContent = `${totalDays}日`;

      renderLogsPane();
      renderDeviceSelectOptions();
      if (panelState.activeTab === 'match') renderMatchDateChips();
    } catch (err) {
      if (container) container.innerHTML = `<div class="fl-empty-box">ログ一覧の取得に失敗しました: ${_esc(err.message)}</div>`;
    }
  }

  function renderLogsPane() {
    const container = $id('flDevicesContainer');
    if (!container) return;
    const checkedCount = panelState.checkedTargets.size;
    const totalDays = panelState.devices.reduce((acc, d) => acc + (d.days ? d.days.length : 0), 0);

    const delSelBtn = $id('flDeleteSelectedLogsBtn');
    if (delSelBtn) {
      delSelBtn.disabled = checkedCount === 0 || panelState.busy;
      delSelBtn.textContent = checkedCount > 0 ? `選択した日を削除 (${checkedCount})` : '選択した日を削除';
    }
    if ($id('flGoMatchSelectedBtn')) $id('flGoMatchSelectedBtn').disabled = checkedCount === 0 || panelState.busy;
    if ($id('flDeleteAllLogsBtn')) $id('flDeleteAllLogsBtn').disabled = totalDays === 0 || panelState.busy;

    if (panelState.devices.length === 0 || totalDays === 0) {
      container.innerHTML = `<div class="fl-empty-box">保存されているGPSフィールドログはありません。<br><span style="font-size: 0.76rem; color: var(--text-dim);">Androidアプリのクイック設定タイル「GPSログ」またはアプリ内の採取画面で記録し、Wi-Fi同期またはUSB書き出しを行うとここに表示されます。</span></div>`;
      return;
    }

    container.innerHTML = panelState.devices.map((dev) => {
      const days = dev.days || [];
      if (days.length === 0) return '';
      const totalPts = days.reduce((s, d) => s + (Number(d.points ?? d.point_count) || 0), 0);
      const shortId = dev.device_id.length > 12 ? `${dev.device_id.slice(0, 8)}…` : dev.device_id;
      const rowsHtml = days.map((d) => {
        const dateStr = String(d.date || '');
        const isChecked = panelState.checkedTargets.has(makeTargetKey(dev.device_id, dateStr));
        const pts = Number(d.points ?? d.point_count ?? 0);
        const fStr = formatTimeShort(d.first ?? d.first_t ?? d.first_time);
        const lStr = formatTimeShort(d.last ?? d.last_t ?? d.last_time);
        const timeRange = (fStr !== '-' || lStr !== '-') ? `${fStr} 〜 ${lStr}` : '-';
        const gpxHref = FieldLogApi.buildGpxUrl(dev.device_id, dateStr);
        const safeDlName = `${dev.device_name}_${dateStr}.gpx`.replace(/[\\/:*?"<>|]/g, '_');
        return `<tr>
          <td style="width: 32px;"><input type="checkbox" class="fl-day-check" data-dev="${_esc(dev.device_id)}" data-date="${_esc(dateStr)}" ${isChecked ? 'checked' : ''} style="accent-color: var(--accent-primary); cursor: pointer;"></td>
          <td class="fl-mono" style="font-weight: 700;">${_esc(dateStr)}</td>
          <td class="col-num">${pts.toLocaleString()} 点</td>
          <td>${_esc(timeRange)}</td>
          <td class="col-num">${_esc(formatDistance(d.distance_m ?? d.distanceM))}</td>
          <td class="col-num">${_esc(formatSize(d.bytes ?? d.size_bytes))}</td>
          <td class="col-actions"><div style="display: inline-flex; gap: 6px; align-items: center;">
            <a class="fl-gpx-link" href="${_esc(gpxHref)}" download="${_esc(safeDlName)}" title="GPX 1.1 ファイルとしてダウンロード">GPX出力</a>
            <button type="button" class="btn btn-secondary btn-xs fl-quick-match-btn" data-dev="${_esc(dev.device_id)}" data-date="${_esc(dateStr)}" title="この日の写真を時刻照合プレビュー">照合 ▶</button>
          </div></td>
        </tr>`;
      }).join('');
      return `<div class="fl-device-card">
        <div class="fl-device-header"><div class="fl-device-title"><span>${_esc(dev.device_name)}</span><span class="fl-device-id" title="端末ID: ${_esc(dev.device_id)}">(${_esc(shortId)})</span></div><span class="fl-pill">${days.length} 日分 ・ 計 ${totalPts.toLocaleString()} 点</span></div>
        <div class="fl-table-wrap"><table class="fl-table"><thead><tr><th style="width: 32px;">選択</th><th>記録日</th><th class="col-num">記録点数</th><th>時間帯</th><th class="col-num">移動距離</th><th class="col-num">サイズ</th><th class="col-actions">操作</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      </div>`;
    }).join('');

    container.querySelectorAll('.fl-day-check').forEach((chk) => chk.addEventListener('change', () => {
      const key = makeTargetKey(chk.dataset.dev || '', chk.dataset.date || '');
      if (chk.checked) panelState.checkedTargets.add(key); else panelState.checkedTargets.delete(key);
      renderLogsPane();
    }));
    container.querySelectorAll('.fl-quick-match-btn').forEach((btn) => btn.addEventListener('click', () => {
      panelState.matchScope = 'dates';
      panelState.matchDates = new Set(btn.dataset.date ? [btn.dataset.date] : []);
      panelState.deviceId = btn.dataset.dev || '';
      switchTab('match');
      runMatchPreview();
    }));
  }

  async function handleDeleteSelectedLogs() {
    const targets = [];
    panelState.checkedTargets.forEach((k) => { const p = parseTargetKey(k); if (p) targets.push(p); });
    if (targets.length === 0) return;
    const ok = await window.showConfirmModal({
      title: 'フィールドログの選択削除', subtitle: 'PC内の日付別ログファイル (.jsonl) の削除', icon: 'trash',
      targetName: `${targets.length} 日分のGPSフィールドログ`, headingSuffix: 'を削除しますか？',
      descriptionLines: [
        '選択した日付のログファイルをPC（cache/field_logs/）から削除します。',
        '※フィールドログのファイルを削除しても、すでに写真へ適用済みの位置情報は消えません。',
        '※写真の位置を元に戻したい場合は「適用履歴・取り消し」タブから取り消してください。',
      ],
      confirmText: '削除する', confirmVariant: 'danger',
    });
    if (!ok) return;
    panelState.busy = true;
    try {
      const res = await FieldLogApi.deleteLogs({ targets });
      const delCnt = res.deleted ?? res.deleted_count ?? res.count ?? targets.length;
      targets.forEach((t) => panelState.matchDates.delete(t.date));
      panelState.checkedTargets.clear();
      notify(`${delCnt} 日分のフィールドログを削除しました`, 'success');
      await loadFieldLogs();
    } catch (err) { notify(`削除エラー: ${err.message}`, 'error'); }
    finally { panelState.busy = false; renderLogsPane(); }
  }

  async function handleDeleteAllLogs() {
    const ok = await window.showConfirmModal({
      title: 'すべてのフィールドログを削除', subtitle: '全端末・全日程のGPSログ一括削除', icon: 'trash',
      targetName: 'すべてのGPSフィールドログ', headingSuffix: 'を完全に削除しますか？',
      descriptionLines: [
        'PC内に保存されている全端末・全日程のフィールドログ（.jsonl）をすべて削除します。',
        '※すでに写真へ適用済みの位置情報や適用履歴（取り消し用データ）は消えません。',
      ],
      confirmText: 'すべて削除する', confirmVariant: 'danger',
    });
    if (!ok) return;
    panelState.busy = true;
    try {
      const res = await FieldLogApi.deleteLogs({ all: true });
      const delCnt = res.deleted ?? res.deleted_count ?? res.count ?? 0;
      panelState.checkedTargets.clear();
      panelState.matchDates.clear();
      notify(`すべてのフィールドログ（${delCnt}件）を削除しました`, 'success');
      await loadFieldLogs();
    } catch (err) { notify(`全削除エラー: ${err.message}`, 'error'); }
    finally { panelState.busy = false; renderLogsPane(); }
  }

  // ② 写真との撮影時刻照合・プレビュー・位置付与
  function renderDeviceSelectOptions() {
    const sel = $id('flDeviceSelect');
    if (!sel) return;
    const prev = panelState.deviceId;
    const opts = ['<option value="">すべての端末</option>'];
    panelState.devices.forEach((dev) => {
      const shortId = dev.device_id.length > 10 ? `${dev.device_id.slice(0, 8)}…` : dev.device_id;
      opts.push(`<option value="${_esc(dev.device_id)}">${_esc(dev.device_name)} (${_esc(shortId)})</option>`);
    });
    sel.innerHTML = opts.join('');
    sel.value = panelState.devices.some((d) => d.device_id === prev) ? prev : '';
    panelState.deviceId = sel.value;
  }

  function renderMatchConfigState() {
    document.querySelectorAll('#flScopeList .fl-scope-option').forEach((lbl) => {
      const active = lbl.getAttribute('data-scope-card') === panelState.matchScope;
      lbl.classList.toggle('is-active', active);
      const radio = lbl.querySelector('input[type="radio"]');
      if (radio) radio.checked = active;
    });
    if ($id('flScopeDetailDates')) $id('flScopeDetailDates').style.display = panelState.matchScope === 'dates' ? 'flex' : 'none';
    if ($id('flScopeDetailFolder')) $id('flScopeDetailFolder').style.display = panelState.matchScope === 'folder' ? 'flex' : 'none';
    if ($id('flScopeDetailSelection')) $id('flScopeDetailSelection').style.display = panelState.matchScope === 'selection' ? 'flex' : 'none';
    if ($id('flFolderPathInput') && $id('flFolderPathInput').value !== panelState.folderPath) $id('flFolderPathInput').value = panelState.folderPath;
    const selIds = collectSelectedPhotoIds(panelState.includeStackMembers);
    if ($id('flSelectionCountHint')) $id('flSelectionCountHint').textContent = selIds.length > 0 ? `現在 ${selIds.length.toLocaleString()} 枚の写真が対象です` : '現在グリッドで写真が選択されていません';
    renderMatchDateChips();
    renderCameraSuggestionsDatalist();
  }

  function renderMatchDateChips() {
    const wrap = $id('flMatchDateChips');
    if (!wrap) return;
    const sorted = Array.from(new Set([...getAllAvailableDates(), ...panelState.matchDates])).sort().reverse();
    if (sorted.length === 0) { wrap.innerHTML = '<span style="font-size: 0.74rem; color: var(--text-dim);">利用可能なログ日付がありません（下の入力欄から直接日付を指定できます）</span>'; return; }
    wrap.innerHTML = sorted.map((dt) => `<button type="button" class="fl-date-chip ${panelState.matchDates.has(dt) ? 'active' : ''}" data-chip-date="${_esc(dt)}">${_esc(dt)}</button>`).join('');
    wrap.querySelectorAll('.fl-date-chip').forEach((chip) => chip.addEventListener('click', () => {
      const dt = chip.getAttribute('data-chip-date') || '';
      if (!dt) return;
      if (panelState.matchDates.has(dt)) panelState.matchDates.delete(dt); else panelState.matchDates.add(dt);
      invalidatePreviewResult();
      renderMatchDateChips();
    }));
  }

  function renderCameraSuggestionsDatalist() {
    const dl = $id('flCameraModelSuggestions');
    if (!dl || typeof state === 'undefined' || !Array.isArray(state.availableCameras)) return;
    dl.innerHTML = state.availableCameras.map((c) => (typeof c === 'string' ? c : (c && (c.camera_model || c.name)))).filter((n) => n && n !== '不明').map((n) => `<option value="${_esc(n)}"></option>`).join('');
  }

  function renderCameraOffsetsList() {
    const listEl = $id('flCameraOffsetsList');
    if (!listEl) return;
    const cams = Array.from(panelState.knownCameras).filter(Boolean).sort();
    if (cams.length === 0) { listEl.innerHTML = '<div style="font-size: 0.74rem; color: var(--text-dim);">「照合プレビュー」を実行すると対象写真のカメラ機種が自動で並びます</div>'; return; }
    listEl.innerHTML = cams.map((cam) => {
      const sec = Number(panelState.cameraOffsets.get(cam)) || 0;
      return `<div class="fl-cam-offset-row"><span class="fl-cam-name" title="${_esc(cam)}">${_esc(cam)}</span><div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;"><input type="number" class="fl-input fl-input-num fl-cam-offset-input" data-cam="${_esc(cam)}" step="1" min="-86400" max="86400" value="${sec}" style="width: 72px; padding: 2px 6px; font-size: 0.76rem;"><span style="font-size: 0.72rem; color: var(--text-muted);">秒</span></div></div>`;
    }).join('');
    listEl.querySelectorAll('.fl-cam-offset-input').forEach((inp) => inp.addEventListener('change', () => {
      panelState.cameraOffsets.set(inp.getAttribute('data-cam') || '', parseInt(inp.value, 10) || 0);
      invalidatePreviewResult();
    }));
  }

  function buildMatchRequestPayload() {
    const scope = panelState.matchScope;
    const dates = scope === 'dates' ? Array.from(panelState.matchDates).sort() : null;
    const directoryPath = scope === 'folder' ? (String(panelState.folderPath || '').trim() || null) : null;
    const photoIds = scope === 'selection' ? collectSelectedPhotoIds(panelState.includeStackMembers) : null;
    if (scope === 'dates' && (!dates || dates.length === 0)) { notify('照合する対象日を1日以上選択してください', 'warning'); return null; }
    if (scope === 'folder' && !directoryPath) { notify('照合するフォルダパスを指定してください', 'warning'); return null; }
    if (scope === 'selection' && (!photoIds || photoIds.length === 0)) { notify('グリッドで写真が選択されていません', 'warning'); return null; }
    const offsetsObj = {};
    panelState.cameraOffsets.forEach((sec, cam) => { const n = parseInt(sec, 10) || 0; if (cam && n !== 0) offsetsObj[cam] = n; });
    return {
      dates, directory_path: directoryPath, photo_ids: photoIds, device_id: panelState.deviceId || null,
      camera_offsets: offsetsObj, max_gap_sec: Math.max(1, parseInt(panelState.maxGapSec, 10) || 300),
      max_nearest_sec: Math.max(0, parseInt(panelState.maxNearestSec, 10) || 120), overwrite: panelState.overwrite || 'missing_only',
    };
  }

  function invalidatePreviewResult() {
    const hadResult = Boolean(panelState.previewResult);
    panelState.previewResult = null;
    if ($id('flApplyMatchBtn')) { $id('flApplyMatchBtn').disabled = true; $id('flApplyMatchBtn').textContent = 'この内容で位置を付与'; }
    if (hadResult && $id('flPreviewSummaryPills')) $id('flPreviewSummaryPills').innerHTML = '<span style="font-size: 0.76rem; color: var(--accent-primary);">条件が変更されました。「照合プレビュー」を再実行してください</span>';
  }

  function enrichPhotoInfo(rawItem, defaultStatus) {
    const isIdOnly = typeof rawItem === 'number' || typeof rawItem === 'string';
    const pid = Number(isIdOnly ? rawItem : (rawItem.photo_id ?? rawItem.id));
    const local = (!isNaN(pid) && pid > 0 && typeof window.findPhotoByIdAnywhere === 'function') ? window.findPhotoByIdAnywhere(pid) : null;
    const cam = (!isIdOnly && rawItem.camera_model) || (local && local.camera_model) || '';
    if (cam) panelState.knownCameras.add(String(cam).trim());
    return {
      status: defaultStatus, photo_id: pid,
      file_name: (!isIdOnly && rawItem.file_name) || (local && local.file_name) || (pid ? `ID:${pid}` : '-'),
      date_taken: (!isIdOnly && rawItem.date_taken) || (local && local.date_taken) || '-', camera_model: cam || '-',
      lat: !isIdOnly && rawItem.lat != null ? Number(rawItem.lat) : (!isIdOnly && rawItem.latitude != null ? Number(rawItem.latitude) : null),
      lon: !isIdOnly && rawItem.lon != null ? Number(rawItem.lon) : (!isIdOnly && rawItem.longitude != null ? Number(rawItem.longitude) : null),
      method: (!isIdOnly && rawItem.method) || '', gap_sec: !isIdOnly && rawItem.gap_sec != null ? Number(rawItem.gap_sec) : null,
      acc_m: !isIdOnly && rawItem.acc_m != null ? Number(rawItem.acc_m) : (!isIdOnly && rawItem.acc != null ? Number(rawItem.acc) : null),
      reason: (!isIdOnly && rawItem.reason) || '',
    };
  }

  async function runMatchPreview() {
    const payload = buildMatchRequestPayload();
    if (!payload) return;
    const previewBtn = $id('flRunPreviewBtn');
    const container = $id('flPreviewContainer');
    if (previewBtn) { previewBtn.disabled = true; previewBtn.textContent = '照合計算中...'; }
    if (container) container.innerHTML = '<div class="fl-empty-box">ログと撮影時刻を照合しています...</div>';
    try {
      const data = await FieldLogApi.previewMatch(payload);
      if (Array.isArray(data.cameras || data.camera_models)) (data.cameras || data.camera_models).forEach((c) => { if (c) panelState.knownCameras.add(String(c).trim()); });
      const rawMatched = Array.isArray(data.items) ? data.items : (Array.isArray(data.matched) ? data.matched : []);
      const rawUnmatched = Array.isArray(data.unmatched) ? data.unmatched : [];
      const rawSkipped = Array.isArray(data.skipped) ? data.skipped : [];
      panelState.previewResult = {
        payload, matchedRows: rawMatched.map((it) => enrichPhotoInfo(it, 'matched')),
        unmatchedRows: rawUnmatched.map((it) => enrichPhotoInfo(it, 'unmatched')), skippedRows: rawSkipped.map((it) => enrichPhotoInfo(it, 'skipped')),
      };
      panelState.previewShowAllRows = false;
      renderCameraOffsetsList();
      renderPreviewSummaryAndControls();
      renderPreviewTable();
    } catch (err) {
      panelState.previewResult = null;
      if (container) container.innerHTML = `<div class="fl-empty-box">プレビューに失敗しました: ${_esc(err.message)}</div>`;
      notify(`照合エラー: ${err.message}`, 'error');
    } finally { if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = '照合プレビュー'; } }
  }

  function renderPreviewSummaryAndControls() {
    const res = panelState.previewResult;
    if (!res) return;
    const interpCnt = res.matchedRows.filter((r) => r.method === 'interpolated').length;
    const nearCnt = res.matchedRows.length - interpCnt;
    if ($id('flPreviewSummaryPills')) {
      $id('flPreviewSummaryPills').innerHTML = `<span class="fl-pill fl-pill-interp">一致 ${res.matchedRows.length.toLocaleString()} 件（補間 ${interpCnt} / 最寄り ${nearCnt}）</span><span class="fl-pill fl-pill-unmatched">未一致 ${res.unmatchedRows.length.toLocaleString()} 件</span><span class="fl-pill fl-pill-skipped">スキップ ${res.skippedRows.length.toLocaleString()} 件</span>`;
    }
    if ($id('flPreviewFilterSelect')) { $id('flPreviewFilterSelect').style.display = 'inline-block'; $id('flPreviewFilterSelect').value = panelState.previewFilter; }
    if ($id('flApplyMatchBtn')) {
      $id('flApplyMatchBtn').disabled = res.matchedRows.length === 0 || panelState.busy;
      $id('flApplyMatchBtn').textContent = res.matchedRows.length > 0 ? `この内容で位置を付与 (${res.matchedRows.length}枚)` : 'この内容で位置を付与';
    }
  }

  function formatSkipReason(reason) {
    const map = { already_has_gps: '既存GPSあり', has_gps: '既存GPSあり', existing_gps: '既存GPSあり', manual_protected: '手動設定を保護', manual: '手動設定を保護', manual_gps: '手動設定を保護', exif_or_copied_protected: 'EXIF・準用GPSを保護', exif_gps: 'EXIF GPSを保護', no_date_taken: '撮影日時なし', no_date: '撮影日時なし' };
    return map[reason] || reason || '対象外';
  }

  function renderPreviewTable() {
    const container = $id('flPreviewContainer');
    const res = panelState.previewResult;
    if (!container || !res) return;
    const rows = panelState.previewFilter === 'matched' ? res.matchedRows : (panelState.previewFilter === 'other' ? [...res.unmatchedRows, ...res.skippedRows] : [...res.matchedRows, ...res.unmatchedRows, ...res.skippedRows]);
    if (rows.length === 0) { container.innerHTML = '<div class="fl-empty-box">表示条件に該当する写真はありません。</div>'; return; }
    const visibleRows = rows.slice(0, panelState.previewShowAllRows ? rows.length : 400);
    const hiddenCount = rows.length - visibleRows.length;
    const tbodyHtml = visibleRows.map((r) => {
      const coord = (r.lat !== null && r.lon !== null && Number.isFinite(r.lat) && Number.isFinite(r.lon)) ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : '-';
      const badge = r.status === 'matched'
        ? (r.method === 'interpolated' ? '<span class="fl-pill fl-pill-interp">線形補間</span>' : '<span class="fl-pill fl-pill-nearest">最寄り点</span>')
        : (r.status === 'unmatched' ? '<span class="fl-pill fl-pill-unmatched">未一致（許容時間外）</span>' : `<span class="fl-pill fl-pill-skipped">スキップ (${_esc(formatSkipReason(r.reason))})</span>`);
      const gapText = (r.gap_sec !== null && Number.isFinite(r.gap_sec)) ? `${Math.round(r.gap_sec)} 秒` : '-';
      const accText = (r.acc_m !== null && Number.isFinite(r.acc_m)) ? `±${Math.round(r.acc_m)} m` : '-';
      return `<tr><td class="fl-mono" style="font-weight: 600;">${_esc(r.file_name)}</td><td class="fl-mono">${_esc(formatLocalDateTime(r.date_taken))}</td><td>${_esc(r.camera_model)}</td><td class="fl-mono">${_esc(coord)}</td><td>${badge}</td><td class="col-num">${_esc(gapText)}</td><td class="col-num">${_esc(accText)}</td></tr>`;
    }).join('');
    const moreHtml = hiddenCount > 0 ? `<div style="padding: 8px; text-align: center;"><button type="button" class="btn btn-secondary btn-xs" id="flShowAllPreviewRowsBtn">残り ${hiddenCount.toLocaleString()} 件もすべて表示</button></div>` : '';
    container.innerHTML = `<div class="fl-preview-table-wrap"><table class="fl-table"><thead><tr><th>ファイル名</th><th>撮影日時</th><th>カメラ機種</th><th>算出座標 (緯度, 経度)</th><th>判定・方式</th><th class="col-num">前後間隔</th><th class="col-num">推定精度</th></tr></thead><tbody>${tbodyHtml}</tbody></table>${moreHtml}</div>`;
    $id('flShowAllPreviewRowsBtn')?.addEventListener('click', () => { panelState.previewShowAllRows = true; renderPreviewTable(); });
  }

  async function handleApplyMatch() {
    const res = panelState.previewResult;
    const payload = res ? res.payload : buildMatchRequestPayload();
    if (!payload) return;
    const targetCount = res ? res.matchedRows.length : 0;
    if (targetCount === 0) { notify('位置を付与できる一致写真がありません', 'warning'); return; }
    const ok = await window.showConfirmModal({
      title: '写真への位置情報・地名の付与', subtitle: 'DBへの非破壊ジオタグ書き込み', icon: 'map-pin',
      targetName: `${targetCount.toLocaleString()} 枚の写真`, headingSuffix: 'にフィールドログから位置情報を付与しますか？',
      descriptionLines: [
        '元の写真ファイル自体は一切書き換えません（Tetheract のDB上に座標と市区町村名を記録します）。',
        '適用前の状態は自動保存され、「適用履歴・取り消し」タブからいつでも一括で元に戻せます。',
      ],
      confirmText: '位置を付与する',
    });
    if (!ok) return;
    const applyBtn = $id('flApplyMatchBtn');
    panelState.busy = true;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = '書き込み中...'; }
    try {
      const data = await FieldLogApi.applyMatch(payload);
      const applied = Number(data.applied ?? data.applied_count ?? data.count ?? targetCount);
      notify(`${applied.toLocaleString()} 枚の写真に位置情報と地名を付与しました`, 'success', 4500);
      await Promise.all([refreshMainLibraryViews(), loadBatches(true)]);
      await runMatchPreview();
    } catch (err) { notify(`位置付与エラー: ${err.message}`, 'error'); }
    finally { panelState.busy = false; renderPreviewSummaryAndControls(); }
  }

  // ③ 適用履歴と取り消し（Undo）
  async function loadBatches(silent = false) {
    const container = $id('flBatchesContainer');
    if (container && !silent) container.innerHTML = '<div class="fl-empty-box">適用履歴を読み込み中...</div>';
    try {
      const data = await FieldLogApi.fetchBatches();
      const list = Array.isArray(data.batches) ? data.batches : (Array.isArray(data) ? data : []);
      panelState.batches = list;
      const activeCount = list.filter((b) => !(b && (b.undone || b.undone_at || b.status === 'undone'))).length;
      if ($id('flTabBatchesCount')) $id('flTabBatchesCount').textContent = String(activeCount);
      renderBatchesPane();
    } catch (err) { if (container && !silent) container.innerHTML = `<div class="fl-empty-box">適用履歴の取得に失敗しました: ${_esc(err.message)}</div>`; }
  }

  function renderBatchesPane() {
    const container = $id('flBatchesContainer');
    if (!container) return;
    if (!Array.isArray(panelState.batches) || panelState.batches.length === 0) { container.innerHTML = '<div class="fl-empty-box">位置付与の適用履歴はまだありません。</div>'; return; }
    container.innerHTML = panelState.batches.map((b) => {
      const batchId = String(b.batch_id || b.id || '');
      const createdAt = formatLocalDateTime(b.created_at ?? b.applied_at ?? b.timestamp ?? '');
      const count = Number(b.applied ?? b.applied_count ?? b.photo_count ?? b.count ?? (Array.isArray(b.items) ? b.items.length : (Array.isArray(b.photos) ? b.photos.length : 0)));
      const isUndone = Boolean(b.undone || b.undone_at || b.status === 'undone');
      const detailParts = [];
      if (Array.isArray(b.dates) && b.dates.length > 0) detailParts.push(`対象日: ${b.dates.join(', ')}`);
      if (b.directory_path) detailParts.push(`フォルダ: ${b.directory_path}`);
      if (b.device_id) detailParts.push(`端末: ${b.device_id}`);
      if (b.overwrite) detailParts.push(`方針: ${b.overwrite}`);
      const detailStr = detailParts.length > 0 ? detailParts.join(' ／ ') : `バッチID: ${batchId}`;
      return `<div class="fl-batch-card"><div class="fl-batch-meta"><div class="fl-batch-title"><span>${_esc(createdAt)}</span><span class="fl-pill ${isUndone ? 'fl-pill-undone' : 'fl-pill-interp'}">${count.toLocaleString()} 枚に適用</span>${isUndone ? '<span class="fl-pill fl-pill-undone">取り消し済み</span>' : ''}</div><div class="fl-batch-desc">${_esc(detailStr)} <span class="fl-mono" style="opacity: 0.7;">[${_esc(batchId)}]</span></div></div><button type="button" class="btn btn-secondary btn-sm fl-undo-batch-btn" data-batch-id="${_esc(batchId)}" data-count="${count}" ${isUndone || panelState.busy ? 'disabled' : ''}>${isUndone ? '取り消し済み' : '適用を取り消す'}</button></div>`;
    }).join('');
    container.querySelectorAll('.fl-undo-batch-btn').forEach((btn) => btn.addEventListener('click', () => {
      const bid = btn.getAttribute('data-batch-id') || '';
      if (bid) handleUndoBatch(bid, Number(btn.getAttribute('data-count') || 0));
    }));
  }

  async function handleUndoBatch(batchId, count) {
    const ok = await window.showConfirmModal({
      title: '位置情報付与の取り消し（Undo）', subtitle: '適用前の座標・地名への復元', icon: 'map-pin',
      targetName: `バッチ ${batchId}（${count.toLocaleString()}枚）`, headingSuffix: 'の適用を取り消しますか？',
      descriptionLines: [
        'このバッチで付与・上書きされた写真の位置情報と市区町村名を、適用前の状態に戻します。',
        '※元の写真ファイルやフィールドログ自体は変更されません。',
      ],
      confirmText: '適用を取り消す', confirmVariant: 'danger',
    });
    if (!ok) return;
    panelState.busy = true;
    renderBatchesPane();
    try {
      const res = await FieldLogApi.undoBatch(batchId);
      const restored = Number(res.restored ?? res.restored_count ?? res.undone ?? res.reverted ?? res.count ?? count);
      notify(`適用を取り消し、${restored.toLocaleString()} 枚の位置情報を元に戻しました`, 'success', 4500);
      await Promise.all([loadBatches(), refreshMainLibraryViews()]);
    } catch (err) { notify(`取り消しエラー: ${err.message}`, 'error'); }
    finally { panelState.busy = false; renderBatchesPane(); }
  }

  // =========================================================================
  // 公開エントリポイント & 起動ボタン結線
  // =========================================================================
  async function openFieldLogModal(initialTab) {
    ensureModalMounted();
    panelState.isOpen = true;
    panelState.folderPath = getCurrentFolderFromAppState() || panelState.folderPath;
    collectCandidateCamerasFromApp();
    modalBackdropEl.classList.add('is-open');
    switchTab(initialTab && ['logs', 'match', 'batches'].includes(initialTab) ? initialTab : (panelState.activeTab || 'logs'));
    await Promise.all([loadFieldLogs(), loadBatches(true)]);
  }

  function closeFieldLogModal() {
    panelState.isOpen = false;
    if (modalBackdropEl) modalBackdropEl.classList.remove('is-open');
  }

  function initFieldLogEntryButton() {
    const btn = $id('openFieldLogModalBtn');
    if (btn && !btn.dataset.flBound) {
      btn.dataset.flBound = 'true';
      btn.addEventListener('click', (e) => { e.stopPropagation(); openFieldLogModal(); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initFieldLogEntryButton);
  else initFieldLogEntryButton();

  window.openFieldLogModal = openFieldLogModal;
  window.closeFieldLogModal = closeFieldLogModal;
})();
