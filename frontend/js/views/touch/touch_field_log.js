/**
 * Tetheract Touch & Tablet Field Log View (Layer 3)
 * Labパネル内「採取」カード・専用フルスクリーン管理画面・タイル長押し/通知起動・戻る操作階層を担う。
 */

(function (global) {
  'use strict';

  const INTERVAL_OPTIONS = [
    { value: 10, label: '10秒（高密度・徒歩や街歩き向け）' },
    { value: 15, label: '15秒' },
    { value: 30, label: '30秒（既定・標準バランス）' },
    { value: 60, label: '60秒（省電力）' },
    { value: 120, label: '120秒（2分）' },
    { value: 300, label: '300秒（5分・長時間移動向け）' },
  ];
  const AUTO_STOP_OPTIONS = [
    { value: 4, label: '4時間' },
    { value: 8, label: '8時間' },
    { value: 12, label: '12時間（既定）' },
    { value: 24, label: '24時間' },
  ];
  const AUTO_DELETE_OPTIONS = [
    { value: 7, label: 'PC送信済み かつ 7日経過で自動削除' },
    { value: 30, label: 'PC送信済み かつ 30日経過で自動削除（既定）' },
    { value: 90, label: 'PC送信済み かつ 90日経過で自動削除' },
    { value: 0, label: '自動削除しない' },
  ];
  const WEEKDAYS_JP = ['日', '月', '火', '水', '木', '金', '土'];

  const state = {
    screenOpen: false,
    confirmOpen: false,
    confirmHandler: null,
    busyToggle: false,
    busyDelete: false,
    busySettings: false,
    status: {
      available: false,
      recording: false,
      startedAt: 0,
      todayPoints: 0,
      settings: { intervalSec: 30, autoStopHours: 12, autoDeleteDays: 30 },
      permission: { location: false, notification: false },
      interrupted: false,
    },
    days: [],
    selectedDates: new Set(),
    activeLabSlot: null,
    tickTimer: null,
    lastPollMs: 0,
  };

  const _getAdapter = () => global.TetheractFieldLogAdapter || null;
  const _pad2 = (n) => String(n).padStart(2, '0');

  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const _escAttr = _escHtml;

  function _formatHm(epochMs) {
    const ms = Number(epochMs || 0);
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '—' : `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
  }

  function _formatStartedAt(epochMs) {
    const ms = Number(epochMs || 0);
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '—';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const hm = `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
    return sameDay ? hm : `${_pad2(d.getMonth() + 1)}/${_pad2(d.getDate())} ${hm}`;
  }

  function _formatElapsed(startedAtMs) {
    const start = Number(startedAtMs || 0);
    if (!Number.isFinite(start) || start <= 0) return '00:00';
    const totalSec = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0 ? `${h}:${_pad2(m)}:${_pad2(s)}` : `${_pad2(m)}:${_pad2(s)}`;
  }

  function _formatDateLabel(dateStr) {
    const raw = String(dateStr || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return raw;
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(dt.getTime()) ? raw : `${raw} (${WEEKDAYS_JP[dt.getDay()]})`;
  }

  function _formatTimeRange(firstT, lastT) {
    const f = _formatHm(firstT);
    const l = _formatHm(lastT);
    if (f === '—' && l === '—') return '時刻情報なし';
    return f === l ? f : `${f}〜${l}`;
  }

  function _formatDistance(distanceM) {
    const m = Number(distanceM || 0);
    if (!Number.isFinite(m) || m <= 0) return '0 m';
    return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km` : `${Math.round(m)} m`;
  }

  function _formatBytes(bytes) {
    const b = Number(bytes || 0);
    if (!Number.isFinite(b) || b <= 0) return '0 KB';
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    const kb = b / 1024;
    return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  }

  function _showToast(message, durationMs = 2200) {
    if (typeof global.showToast === 'function') {
      global.showToast(message, durationMs);
      return;
    }
    const toastEl = document.getElementById('mToast');
    if (!toastEl) return;
    toastEl.textContent = String(message || '');
    toastEl.style.display = 'block';
    if (toastEl._flTimer) clearTimeout(toastEl._flTimer);
    toastEl._flTimer = setTimeout(() => { toastEl.style.display = 'none'; }, durationMs);
  }

  const _isLabCardVisible = () => Boolean(state.activeLabSlot && state.activeLabSlot.isConnected);

  function _updateElapsedTextOnly() {
    if (!state.status.recording) return;
    const elapsedText = _formatElapsed(state.status.startedAt);
    const heroElapsed = document.getElementById('tFieldLogStatElapsed');
    if (heroElapsed) heroElapsed.textContent = elapsedText;
    if (_isLabCardVisible()) {
      const labElapsed = state.activeLabSlot.querySelector('[data-fl-lab-elapsed]');
      if (labElapsed) labElapsed.textContent = elapsedText;
    }
  }

  function _syncElapsedTicker() {
    const shouldRun = Boolean(state.status.available && state.status.recording);
    if (shouldRun && !state.tickTimer) {
      state.tickTimer = setInterval(() => {
        _updateElapsedTextOnly();
        const now = Date.now();
        if (now - state.lastPollMs >= 15000 && (state.screenOpen || _isLabCardVisible())) {
          state.lastPollMs = now;
          refreshStatusAndDays({ includeDays: state.screenOpen });
        }
      }, 1000);
    } else if (!shouldRun && state.tickTimer) {
      clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
  }

  async function refreshStatusAndDays(options = { includeDays: false }) {
    const adapter = _getAdapter();
    const available = Boolean(adapter && adapter.isAvailable());
    if (!adapter) {
      state.status.available = false;
      _renderLabCardSlot();
      if (state.screenOpen) _renderModalState();
      return state.status;
    }

    const nextStatus = await adapter.getStatus();
    state.status = { ...state.status, ...nextStatus, available };

    if (options && options.includeDays) {
      const days = await adapter.listDays();
      state.days = Array.isArray(days) ? days : [];
      const validDates = new Set(state.days.map((d) => d.date));
      for (const sel of Array.from(state.selectedDates)) {
        if (!validDates.has(sel)) state.selectedDates.delete(sel);
      }
    }

    _syncElapsedTicker();
    _renderLabCardSlot();
    if (state.screenOpen) {
      _renderModalState();
      if (options && options.includeDays) _renderDaysSection();
    }
    return state.status;
  }

  async function handleToggleRecording() {
    const adapter = _getAdapter();
    if (!adapter || !adapter.isAvailable() || state.busyToggle) return;
    state.busyToggle = true;
    _renderLabCardSlot();
    if (state.screenOpen) _renderModalState();

    try {
      if (state.status.recording) {
        const res = await adapter.stop();
        _showToast(res && res.ok ? 'GPSログの記録を停止しました' : 'GPSログの停止に失敗しました');
      } else {
        const res = await adapter.start();
        if (res && res.ok) {
          const reqPerm = res.status === 'permission_requested';
          _showToast(reqPerm ? '位置情報（正確な位置情報）と通知の権限を許可してください' : 'GPSログの記録を開始しました', reqPerm ? 3000 : 2200);
        } else {
          _showToast('GPSログの開始に失敗しました');
        }
      }
    } finally {
      state.busyToggle = false;
      await refreshStatusAndDays({ includeDays: state.screenOpen });
    }
  }

  /* ==================== 1. Lab パネル「採取」カード ==================== */

  function _renderLabCardSlot() {
    const slotEl = state.activeLabSlot;
    if (!slotEl || !slotEl.isConnected) return;

    const st = state.status;
    const isAvail = Boolean(st.available);
    const isRec = Boolean(isAvail && st.recording);
    const pts = Number(st.todayPoints || 0);

    let badgeHtml = '<span class="t-fl-badge">停止中</span>';
    if (isRec) {
      badgeHtml = `<span class="t-fl-badge is-recording"><span class="t-fl-pulse-dot"></span>記録中 · <span data-fl-lab-elapsed>${_escHtml(_formatElapsed(st.startedAt))}</span> · ${pts.toLocaleString()}点</span>`;
    } else if (isAvail && pts > 0) {
      badgeHtml = `<span class="t-fl-badge">停止中 · 本日 ${pts.toLocaleString()}点</span>`;
    }

    const summaryHtml = isRec
      ? `本日の記録: <strong>${pts.toLocaleString()} 点</strong>（開始 ${_escHtml(_formatStartedAt(st.startedAt))}）`
      : 'カメラ撮影中の足跡をオフライン記録し、PCで写真に位置情報を結びます。';
    const interruptHtml = isAvail && st.interrupted ? '<div class="t-fl-lab-interrupt">前回のGPSログ記録がOSにより中断されました</div>' : '';
    const browserNoteHtml = !isAvail ? '<div class="t-fl-lab-browser-note">Android 専用アプリ（APK）で利用できる機能です</div>' : '';
    const toggleBtnClass = isRec ? 't-fl-btn t-fl-btn-stop' : 't-fl-btn t-fl-btn-primary';
    const toggleLabel = isRec ? '記録を停止する' : 'GPSログ記録を開始';

    slotEl.innerHTML = `
      <div class="t-fl-lab-card ${isRec ? 'is-recording' : ''}">
        <div class="t-fl-lab-head">
          <span class="t-fl-lab-title-row">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 9.5c0 5.5-7.5 10.5-7.5 10.5S4.5 15 4.5 9.5a7.5 7.5 0 0 1 15 0z"/><circle cx="12" cy="9.5" r="2.6"/></svg>
            <span>採取（GPSフィールドログ）</span>
          </span>
          ${badgeHtml}
        </div>
        <div class="t-fl-lab-summary">${summaryHtml}</div>
        ${interruptHtml}
        ${browserNoteHtml}
        <div class="t-fl-lab-actions">
          <button type="button" class="${toggleBtnClass}" data-fl-lab-toggle ${!isAvail || state.busyToggle ? 'disabled' : ''}><span>${_escHtml(toggleLabel)}</span></button>
          <button type="button" class="t-fl-btn t-fl-btn-secondary" data-fl-lab-open><span>フィールドログ管理・設定を開く</span></button>
        </div>
      </div>`;

    slotEl.querySelector('[data-fl-lab-toggle]')?.addEventListener('click', (e) => { e.stopPropagation(); handleToggleRecording(); });
    slotEl.querySelector('[data-fl-lab-open]')?.addEventListener('click', (e) => { e.stopPropagation(); openFieldLogScreen(); });
  }

  function renderLabPerspectiveCard(slotEl) {
    state.activeLabSlot = slotEl;
    const adapter = _getAdapter();
    state.status.available = Boolean(adapter && adapter.isAvailable());
    _renderLabCardSlot();
    refreshStatusAndDays({ includeDays: false });
  }

  /* ==================== 2. フルスクリーン管理画面 ==================== */

  function _buildOptionListHtml(options, currentVal, suffixUnit) {
    const numCur = Number(currentVal);
    const merged = options.some((opt) => opt.value === numCur) ? options : [{ value: numCur, label: `${numCur}${suffixUnit}` }, ...options];
    return merged.map((opt) => `<option value="${_escAttr(opt.value)}" ${opt.value === numCur ? 'selected' : ''}>${_escHtml(opt.label)}</option>`).join('');
  }

  function _ensureFieldLogModal() {
    let modal = document.getElementById('tFieldLogModal');
    if (modal) return modal;

    modal = document.createElement('section');
    modal.id = 'tFieldLogModal';
    modal.className = 't-fl-modal';
    modal.style.display = 'none';
    modal.setAttribute('aria-label', 'GPSフィールドログ管理・設定');
    modal.innerHTML = `
      <header class="t-fl-topbar">
        <button type="button" id="tFieldLogBackBtn" class="t-fl-back-btn" aria-label="戻る">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          <span>戻る</span>
        </button>
        <div class="t-fl-topbar-title">採取 — GPSフィールドログ</div>
        <button type="button" id="tFieldLogRefreshBtn" class="t-fl-icon-btn" title="最新の状態に更新" aria-label="更新">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </header>
      <div class="t-fl-body">
        <div class="t-fl-scroll-inner">
          <div id="tFieldLogBrowserNotice" class="t-fl-notice-box" style="display:none;">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <div>Android 専用アプリ（APK）で利用できる機能です。ブラウザ閲覧時はGPS記録・削除・設定保存は行えません。</div>
          </div>
          <div id="tFieldLogInterruptBanner" class="t-fl-notice-box is-warning" style="display:none;">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div><div class="t-fl-notice-title">前回のGPSログ記録がOSにより中断されました</div><div>省電力機能やメモリ解放で停止した可能性があります。必要に応じて再度記録を開始してください。</div></div>
          </div>
          <div id="tFieldLogPermNotice" class="t-fl-notice-box is-info" style="display:none;">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M19.5 9.5c0 5.5-7.5 10.5-7.5 10.5S4.5 15 4.5 9.5a7.5 7.5 0 0 1 15 0z"/><circle cx="12" cy="9.5" r="2.6"/></svg>
            <div><div class="t-fl-notice-title">位置情報の権限が未許可です</div><div>下の「GPSログ記録を開始する」をタップし、確認ダイアログで<strong>「正確な位置情報」</strong>を許可してください（常駐通知表示のため通知権限も使用します）。</div></div>
          </div>
          <div id="tFieldLogHeroCard" class="t-fl-card">
            <div class="t-fl-hero-head">
              <div id="tFieldLogHeroState" class="t-fl-hero-state"><span class="t-fl-idle-dot"></span><span>停止中</span></div>
              <span class="t-fl-tile-tag">クイック設定タイル対応</span>
            </div>
            <div class="t-fl-stats-grid">
              <div class="t-fl-stat-cell"><span class="t-fl-stat-label">開始時刻</span><span id="tFieldLogStatStarted" class="t-fl-stat-val">—</span></div>
              <div class="t-fl-stat-cell"><span class="t-fl-stat-label">経過時間</span><span id="tFieldLogStatElapsed" class="t-fl-stat-val">—</span></div>
              <div class="t-fl-stat-cell"><span class="t-fl-stat-label">本日の記録点数</span><span id="tFieldLogStatPoints" class="t-fl-stat-val">0 点</span></div>
            </div>
            <button type="button" id="tFieldLogMainToggleBtn" class="t-fl-btn t-fl-btn-primary t-fl-hero-toggle-btn"><span>GPSログ記録を開始する</span></button>
            <div class="t-fl-sub-hint">通知パネルのクイック設定に<strong>「GPSログ」タイル</strong>を追加すると、アプリを開かずにワンタップでON/OFFできます（タイル長押しでこの画面が開きます）。</div>
          </div>
          <div class="t-fl-card">
            <div class="t-fl-section-head"><span class="t-fl-section-title">日別ログ一覧</span><span id="tFieldLogDayCountBadge" class="t-fl-count-pill">0 日</span></div>
            <div class="t-fl-safe-note"><strong>※ログを削除しても、PCで写真に付与済みの位置情報は消えません</strong><br>Wi-Fi同期やUSB書き出しを行うと、未送信の日別ログがPCへ自動送信されます。</div>
            <div id="tFieldLogDayToolbar" class="t-fl-day-toolbar" style="display:none;">
              <button type="button" id="tFieldLogSelectAllBtn" class="t-fl-mini-btn">すべて選択</button>
              <div class="t-fl-day-toolbar-right">
                <button type="button" id="tFieldLogDeleteSelectedBtn" class="t-fl-mini-btn is-danger" disabled>選択した日を削除</button>
                <button type="button" id="tFieldLogDeleteAllBtn" class="t-fl-mini-btn is-danger">すべて削除</button>
              </div>
            </div>
            <div id="tFieldLogDaysList" class="t-fl-days-list"><div class="t-fl-empty-days">保存されているGPSログはありません</div></div>
          </div>
          <div class="t-fl-card">
            <div class="t-fl-section-head"><span class="t-fl-section-title">記録・プライバシー設定</span></div>
            <div class="t-fl-setting-group">
              <div class="t-fl-setting-item"><label class="t-fl-setting-label" for="tFieldLogIntervalSelect">記録間隔</label><select id="tFieldLogIntervalSelect" class="t-fl-select"></select><div class="t-fl-setting-desc">水平精度50m超の誤差点は自動で除外し、静止中も時刻補間用に最低5分ごと記録します。</div></div>
              <div class="t-fl-setting-item"><label class="t-fl-setting-label" for="tFieldLogAutoStopSelect">自動停止時間</label><select id="tFieldLogAutoStopSelect" class="t-fl-select"></select><div class="t-fl-setting-desc">切り忘れ防止のため、指定時間の経過または電池残量15%未満で自動停止します。</div></div>
              <div class="t-fl-setting-item"><label class="t-fl-setting-label" for="tFieldLogAutoDeleteSelect">古いログの自動削除</label><select id="tFieldLogAutoDeleteSelect" class="t-fl-select"></select><div class="t-fl-setting-desc">PCへ送信完了したログのうち、指定日数を過ぎたものを同期完了時に端末から自動削除します。</div></div>
            </div>
          </div>
        </div>
      </div>
      <div id="tFieldLogConfirmOverlay" class="t-fl-confirm-overlay" style="display:none;" role="dialog" aria-modal="true">
        <div class="t-fl-confirm-dialog">
          <div id="tFieldLogConfirmTitle" class="t-fl-confirm-title">ログの削除確認</div>
          <div id="tFieldLogConfirmMsg" class="t-fl-confirm-msg"></div>
          <div class="t-fl-confirm-sub">※ログを削除しても、PCで写真に付与済みの位置情報は消えません。</div>
          <div class="t-fl-confirm-actions">
            <button type="button" id="tFieldLogConfirmCancelBtn" class="t-fl-btn t-fl-btn-secondary">キャンセル</button>
            <button type="button" id="tFieldLogConfirmOkBtn" class="t-fl-btn t-fl-btn-danger">削除する</button>
          </div>
        </div>
      </div>`;

    (document.querySelector('.m-app') || document.body).appendChild(modal);
    _bindModalEvents(modal);
    return modal;
  }

  function _renderModalState() {
    const st = state.status;
    const isAvail = Boolean(st.available);
    const isRec = Boolean(isAvail && st.recording);

    const browserNotice = document.getElementById('tFieldLogBrowserNotice');
    if (browserNotice) browserNotice.style.display = isAvail ? 'none' : 'flex';
    const interruptBanner = document.getElementById('tFieldLogInterruptBanner');
    if (interruptBanner) interruptBanner.style.display = isAvail && st.interrupted ? 'flex' : 'none';
    const permNotice = document.getElementById('tFieldLogPermNotice');
    if (permNotice) permNotice.style.display = isAvail && st.permission && !st.permission.location && !isRec ? 'flex' : 'none';

    document.getElementById('tFieldLogHeroCard')?.classList.toggle('is-recording-card', isRec);
    const heroState = document.getElementById('tFieldLogHeroState');
    if (heroState) {
      heroState.classList.toggle('is-recording', isRec);
      heroState.innerHTML = isRec ? '<span class="t-fl-pulse-dot"></span><span>GPSログ記録中</span>' : '<span class="t-fl-idle-dot"></span><span>停止中</span>';
    }

    const statStarted = document.getElementById('tFieldLogStatStarted');
    if (statStarted) statStarted.textContent = isRec ? _formatStartedAt(st.startedAt) : '—';
    const statElapsed = document.getElementById('tFieldLogStatElapsed');
    if (statElapsed) statElapsed.textContent = isRec ? _formatElapsed(st.startedAt) : '—';
    const statPoints = document.getElementById('tFieldLogStatPoints');
    if (statPoints) statPoints.textContent = `${Number(st.todayPoints || 0).toLocaleString()} 点`;

    const mainBtn = document.getElementById('tFieldLogMainToggleBtn');
    if (mainBtn) {
      mainBtn.disabled = !isAvail || state.busyToggle;
      mainBtn.className = isRec ? 't-fl-btn t-fl-btn-stop t-fl-hero-toggle-btn' : 't-fl-btn t-fl-btn-primary t-fl-hero-toggle-btn';
      mainBtn.innerHTML = `<span>${isRec ? 'GPSログ記録を停止する' : 'GPSログ記録を開始する'}</span>`;
    }

    const settings = st.settings || { intervalSec: 30, autoStopHours: 12, autoDeleteDays: 30 };
    const disableSelects = !isAvail || state.busySettings;
    const intervalSel = document.getElementById('tFieldLogIntervalSelect');
    const autoStopSel = document.getElementById('tFieldLogAutoStopSelect');
    const autoDelSel = document.getElementById('tFieldLogAutoDeleteSelect');
    if (intervalSel) { intervalSel.innerHTML = _buildOptionListHtml(INTERVAL_OPTIONS, settings.intervalSec, '秒'); intervalSel.disabled = disableSelects; }
    if (autoStopSel) { autoStopSel.innerHTML = _buildOptionListHtml(AUTO_STOP_OPTIONS, settings.autoStopHours, '時間'); autoStopSel.disabled = disableSelects; }
    if (autoDelSel) { autoDelSel.innerHTML = _buildOptionListHtml(AUTO_DELETE_OPTIONS, settings.autoDeleteDays, '日'); autoDelSel.disabled = disableSelects; }
  }

  function _renderDaysSection() {
    const countBadge = document.getElementById('tFieldLogDayCountBadge');
    const toolbar = document.getElementById('tFieldLogDayToolbar');
    const selectAllBtn = document.getElementById('tFieldLogSelectAllBtn');
    const delSelBtn = document.getElementById('tFieldLogDeleteSelectedBtn');
    const delAllBtn = document.getElementById('tFieldLogDeleteAllBtn');
    const listEl = document.getElementById('tFieldLogDaysList');
    if (!listEl) return;

    const days = state.days;
    if (countBadge) countBadge.textContent = `${days.length} 日`;
    if (days.length === 0) {
      if (toolbar) toolbar.style.display = 'none';
      listEl.innerHTML = '<div class="t-fl-empty-days">保存されているGPSログはありません</div>';
      return;
    }

    const selCount = state.selectedDates.size;
    if (toolbar) toolbar.style.display = 'flex';
    if (selectAllBtn) selectAllBtn.textContent = selCount === days.length ? '選択解除' : 'すべて選択';
    if (delSelBtn) {
      delSelBtn.disabled = !state.status.available || state.busyDelete || selCount === 0;
      delSelBtn.textContent = selCount > 0 ? `選択した日を削除 (${selCount})` : '選択した日を削除';
    }
    if (delAllBtn) delAllBtn.disabled = !state.status.available || state.busyDelete;

    listEl.innerHTML = days.map((day) => {
      const isSel = state.selectedDates.has(day.date);
      const upBadge = day.uploaded ? '<span class="t-fl-upload-badge is-uploaded">PC送信済み</span>' : '<span class="t-fl-upload-badge">未送信</span>';
      return `
        <div class="t-fl-day-row ${isSel ? 'is-selected' : ''}" data-fl-day-date="${_escAttr(day.date)}" role="checkbox" aria-checked="${isSel ? 'true' : 'false'}">
          <span class="t-fl-day-check" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>
          <div class="t-fl-day-main">
            <div class="t-fl-day-top"><span class="t-fl-day-date">${_escHtml(_formatDateLabel(day.date))}</span>${upBadge}</div>
            <div class="t-fl-day-meta">
              <span>${Number(day.points || 0).toLocaleString()} 点</span><span>·</span>
              <span>${_escHtml(_formatTimeRange(day.firstT, day.lastT))}</span><span>·</span>
              <span>${_escHtml(_formatDistance(day.distanceM))}</span><span>·</span>
              <span>${_escHtml(_formatBytes(day.bytes))}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  /* ==================== 3. タッチ専用 確認ダイアログ & イベント ==================== */

  function showTouchConfirmModal(options) {
    const overlay = document.getElementById('tFieldLogConfirmOverlay');
    const titleEl = document.getElementById('tFieldLogConfirmTitle');
    const msgEl = document.getElementById('tFieldLogConfirmMsg');
    const okBtn = document.getElementById('tFieldLogConfirmOkBtn');
    if (!overlay || !titleEl || !msgEl || !okBtn) return;

    titleEl.textContent = String((options && options.title) || '確認');
    msgEl.textContent = String((options && options.message) || '');
    okBtn.textContent = String((options && options.confirmLabel) || '削除する');
    state.confirmHandler = options && typeof options.onConfirm === 'function' ? options.onConfirm : null;
    state.confirmOpen = true;
    overlay.style.display = 'flex';
  }

  function closeTouchConfirmModal() {
    state.confirmOpen = false;
    state.confirmHandler = null;
    const overlay = document.getElementById('tFieldLogConfirmOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function _handleSaveSettingsFromUi() {
    const adapter = _getAdapter();
    if (!adapter || !adapter.isAvailable() || state.busySettings) return;
    const intervalSel = document.getElementById('tFieldLogIntervalSelect');
    const autoStopSel = document.getElementById('tFieldLogAutoStopSelect');
    const autoDelSel = document.getElementById('tFieldLogAutoDeleteSelect');
    if (!intervalSel || !autoStopSel || !autoDelSel) return;

    const nextSettings = { intervalSec: Number(intervalSel.value), autoStopHours: Number(autoStopSel.value), autoDeleteDays: Number(autoDelSel.value) };
    state.busySettings = true;
    _renderModalState();
    try {
      const res = await adapter.saveSettings(nextSettings);
      if (res && res.ok) {
        state.status.settings = res.settings || nextSettings;
        _showToast('フィールドログ設定を保存しました');
      } else {
        _showToast('設定の保存に失敗しました');
      }
    } finally {
      state.busySettings = false;
      _renderModalState();
    }
  }

  async function _executeDeleteSelectedDays() {
    const adapter = _getAdapter();
    const targets = Array.from(state.selectedDates);
    if (!adapter || !adapter.isAvailable() || targets.length === 0 || state.busyDelete) return;
    state.busyDelete = true;
    _renderDaysSection();
    try {
      const res = await adapter.deleteDays(targets);
      if (res && res.ok) {
        state.selectedDates.clear();
        _showToast(`${Number(res.deleted || targets.length)}日分のGPSログを削除しました`);
      } else {
        _showToast('ログの削除に失敗しました');
      }
    } finally {
      state.busyDelete = false;
      await refreshStatusAndDays({ includeDays: true });
    }
  }

  async function _executeDeleteAllDays() {
    const adapter = _getAdapter();
    if (!adapter || !adapter.isAvailable() || state.busyDelete) return;
    state.busyDelete = true;
    _renderDaysSection();
    try {
      const res = await adapter.deleteAll();
      if (res && res.ok) {
        state.selectedDates.clear();
        _showToast(`すべてのGPSログ（${Number(res.deleted || 0)}日分）を削除しました`);
      } else {
        _showToast('全削除に失敗しました');
      }
    } finally {
      state.busyDelete = false;
      await refreshStatusAndDays({ includeDays: true });
    }
  }

  function _bindModalEvents(modal) {
    modal.querySelector('#tFieldLogBackBtn')?.addEventListener('click', closeFieldLogScreen);
    modal.querySelector('#tFieldLogRefreshBtn')?.addEventListener('click', async () => {
      await refreshStatusAndDays({ includeDays: true });
      _showToast('最新のログ状態に更新しました', 1500);
    });
    modal.querySelector('#tFieldLogMainToggleBtn')?.addEventListener('click', handleToggleRecording);

    modal.querySelector('#tFieldLogDaysList')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-fl-day-date]');
      const dateStr = row ? row.getAttribute('data-fl-day-date') || '' : '';
      if (!dateStr) return;
      if (state.selectedDates.has(dateStr)) state.selectedDates.delete(dateStr);
      else state.selectedDates.add(dateStr);
      _renderDaysSection();
    });

    modal.querySelector('#tFieldLogSelectAllBtn')?.addEventListener('click', () => {
      if (state.selectedDates.size > 0 && state.selectedDates.size === state.days.length) state.selectedDates.clear();
      else state.days.forEach((d) => state.selectedDates.add(d.date));
      _renderDaysSection();
    });

    modal.querySelector('#tFieldLogDeleteSelectedBtn')?.addEventListener('click', () => {
      const count = state.selectedDates.size;
      if (count === 0) return;
      showTouchConfirmModal({
        title: '選択したログの削除',
        message: `選択した ${count} 日分のGPSログファイルをこの端末から削除しますか？`,
        confirmLabel: '削除する',
        onConfirm: _executeDeleteSelectedDays,
      });
    });

    modal.querySelector('#tFieldLogDeleteAllBtn')?.addEventListener('click', () => {
      if (state.days.length === 0) return;
      showTouchConfirmModal({
        title: 'すべてのログを削除',
        message: `端末内のすべてのGPSログ（全 ${state.days.length} 日分）を削除しますか？`,
        confirmLabel: 'すべて削除する',
        onConfirm: _executeDeleteAllDays,
      });
    });

    ['#tFieldLogIntervalSelect', '#tFieldLogAutoStopSelect', '#tFieldLogAutoDeleteSelect'].forEach((sel) => {
      modal.querySelector(sel)?.addEventListener('change', _handleSaveSettingsFromUi);
    });

    const confirmOverlay = modal.querySelector('#tFieldLogConfirmOverlay');
    confirmOverlay?.addEventListener('click', (e) => { if (e.target === confirmOverlay) closeTouchConfirmModal(); });
    modal.querySelector('#tFieldLogConfirmCancelBtn')?.addEventListener('click', closeTouchConfirmModal);
    modal.querySelector('#tFieldLogConfirmOkBtn')?.addEventListener('click', () => {
      const fn = state.confirmHandler;
      closeTouchConfirmModal();
      if (typeof fn === 'function') fn();
    });
  }

  async function openFieldLogScreen() {
    const modal = _ensureFieldLogModal();
    const layoutState = global.TetheractTouchUI?.getState?.();
    if (layoutState && layoutState.sheetOpen && typeof global.TetheractTouchUI.closePerspectiveSheet === 'function') {
      global.TetheractTouchUI.closePerspectiveSheet();
    }
    state.screenOpen = true;
    modal.style.display = 'flex';
    _renderModalState();
    _renderDaysSection();
    await refreshStatusAndDays({ includeDays: true });
  }

  function closeFieldLogScreen() {
    closeTouchConfirmModal();
    state.screenOpen = false;
    const modal = document.getElementById('tFieldLogModal');
    if (modal) modal.style.display = 'none';
    _syncElapsedTicker();
  }

  function _initTouchFieldLog() {
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.registerPerspectiveRenderer === 'function') {
      global.TetheractTouchUI.registerPerspectiveRenderer('lab', renderLabPerspectiveCard);
    }

    global.__extraBackHandlers = global.__extraBackHandlers || [];
    global.__extraBackHandlers.push(function handleFieldLogBack() {
      if (state.confirmOpen) { closeTouchConfirmModal(); return 'handled'; }
      if (state.screenOpen) { closeFieldLogScreen(); return 'handled'; }
      return undefined;
    });

    const adapter = _getAdapter();
    if (adapter) {
      adapter.onStatusChanged((nextStatus) => {
        state.status = { ...state.status, ...nextStatus, available: adapter.isAvailable() };
        _syncElapsedTicker();
        _renderLabCardSlot();
        if (state.screenOpen) {
          _renderModalState();
          adapter.listDays().then((days) => {
            state.days = Array.isArray(days) ? days : [];
            _renderDaysSection();
          });
        }
      });
      adapter.onOpenRequested(() => openFieldLogScreen());
      if (adapter.isAvailable()) refreshStatusAndDays({ includeDays: false });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (state.screenOpen || _isLabCardVisible())) {
        refreshStatusAndDays({ includeDays: state.screenOpen });
      }
    });
  }

  const fieldLogUiApi = {
    openFieldLogScreen,
    closeFieldLogScreen,
    refreshStatusAndDays,
    getState: () => ({ screenOpen: state.screenOpen, status: { ...state.status }, dayCount: state.days.length }),
  };

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, {
    openFieldLogScreen,
    closeFieldLogScreen,
    fieldLog: fieldLogUiApi,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initTouchFieldLog);
  } else {
    _initTouchFieldLog();
  }
})(window);
