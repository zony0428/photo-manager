/**
 * Tetheract Touch Center Action Dial (Layer 3)
 * スマホ下部メニュー中央の大型・地球モチーフ丸型ダイヤルボタン（直径86px）。
 * - 上下スワイプで1コマずつ循環切替［母艦に収納 (上) ⇄ GPSロガー (既定・中央) ⇄ カメラ (下)］
 * - GPSロガー: タップで記録ON/OFF、長押しでGPSログ管理・設定画面を開く
 * - 母艦に収納: LINK時はタップで差分一括収納、未LINK時はグレーアウト（長押しで手動Uplink画面は常時開ける）
 * - カメラ: タップで標準カメラを起動（カメラ・母艦収納の実行後は自動でGPSロガー表示へ復帰）
 */
(function (global) {
  'use strict';

  const SWIPE_STEP_PX = 18;
  const LONG_PRESS_CANCEL_PX = 12;
  const LONG_PRESS_MS = 440;

  // 0: 母艦に収納 / 1 (既定): GPSロガー / 2: カメラ（上下スワイプで1コマずつ循環）
  const DIAL_MODES = [
    {
      id: 'uplink',
      label: '母艦に収納',
      recordingLabel: '母艦に収納',
      ariaHint: 'タップで差分一括収納、長押しで写真を手動選択（上下スワイプで機能切替）',
      svg: '<svg class="t-dial-svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    },
    {
      id: 'gps',
      label: 'GPSロガー',
      recordingLabel: 'GPS記録中',
      ariaHint: 'タップでGPS記録ON/OFF、長押しで管理画面（上スワイプで母艦に収納、下スワイプでカメラ）',
      svg: '<svg class="t-dial-svg t-dial-svg-globe" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.4"/><ellipse cx="12" cy="12" rx="4.2" ry="9.4"/><path d="M3.1 9.3h17.8"/><path d="M3.1 14.7h17.8"/></svg>',
    },
    {
      id: 'camera',
      label: 'カメラ',
      recordingLabel: 'カメラ',
      ariaHint: 'タップでカメラを起動（上下スワイプで機能切替）',
      svg: '<svg class="t-dial-svg" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.9"/></svg>',
    },
  ];

  const state = {
    modeIndex: 1, // 既定は中央 (GPSロガー)
    gpsRecording: false,
    gpsAvailable: false,
    gpsBusy: false,
    pcLinked: false,
    todayPoints: 0,
    suppressClickUntil: 0,
    slideAnimTimer: null,
  };

  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _vibrate(ms) {
    try {
      if (global.navigator && typeof global.navigator.vibrate === 'function') {
        global.navigator.vibrate(ms);
      }
    } catch (e) {}
  }

  function _showToast(msg, durationMs = 2600) {
    if (typeof global.showToast === 'function') {
      global.showToast(msg, durationMs);
      return;
    }
    const toast = document.getElementById('mToast');
    if (!toast) return;
    toast.textContent = String(msg || '');
    toast.style.display = 'block';
    clearTimeout(_showToast._timer);
    _showToast._timer = setTimeout(() => {
      toast.style.display = 'none';
    }, durationMs);
  }

  function _syncLinkState() {
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.isMotherShipLinked === 'function') {
      state.pcLinked = Boolean(global.TetheractTouchUI.isMotherShipLinked());
      return;
    }
    if (global.TetheractNative && typeof global.TetheractNative.getLockerStatusJson === 'function') {
      try {
        const st = JSON.parse(global.TetheractNative.getLockerStatusJson() || '{}');
        state.pcLinked = Boolean(st.pcOnline);
        return;
      } catch (e) {}
    }
    const badge = document.getElementById('mModeBadge');
    const txt = badge ? (badge.textContent || '').trim() : '';
    state.pcLinked = txt === '● Wi-Fi接続' || txt === '● LINK';
  }

  function _syncStateFromFieldLog() {
    const flApi = global.TetheractTouchUI && global.TetheractTouchUI.fieldLog;
    if (flApi && typeof flApi.getState === 'function') {
      const flState = flApi.getState();
      const st = (flState && flState.status) || {};
      state.gpsAvailable = Boolean(st.available);
      state.gpsRecording = Boolean(st.available && st.recording);
      state.gpsBusy = Boolean(flState && flState.busyToggle);
      state.todayPoints = Number(st.todayPoints || 0);
      return;
    }
    const adapter = global.TetheractFieldLogAdapter;
    state.gpsAvailable = Boolean(adapter && typeof adapter.isAvailable === 'function' && adapter.isAvailable());
  }

  function _getCurrentModeDef() {
    return DIAL_MODES[state.modeIndex] || DIAL_MODES[1];
  }

  function _buildDialInnerHtml() {
    const mode = _getCurrentModeDef();
    const labelText = mode.id === 'gps' && state.gpsRecording ? mode.recordingLabel : mode.label;

    const dotsHtml = DIAL_MODES.map(
      (m, idx) =>
        `<span class="t-center-dial-dot ${idx === state.modeIndex ? 'is-active' : ''} ${m.id === 'gps' && state.gpsRecording ? 'is-rec' : ''} ${m.id === 'uplink' && !state.pcLinked ? 'is-offline' : ''}"></span>`
    ).join('');

    return `
      <span class="t-center-dial-ring" aria-hidden="true"></span>
      <span class="t-center-dial-cue is-up" aria-hidden="true">
        <svg viewBox="0 0 12 6" width="12" height="6" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 4.6 6 1.4 10 4.6"/></svg>
      </span>
      <span class="t-center-dial-face" id="tCenterDialFace">
        <span class="t-center-dial-icon-wrap">
          ${mode.svg}
          <span class="t-center-dial-rec-dot" aria-hidden="true"></span>
        </span>
        <span class="t-center-dial-label">${_escHtml(labelText)}</span>
      </span>
      <span class="t-center-dial-cue is-down" aria-hidden="true">
        <svg viewBox="0 0 12 6" width="12" height="6" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 1.4 6 4.6 10 1.4"/></svg>
      </span>
      <span class="t-center-dial-dots" aria-hidden="true">${dotsHtml}</span>
    `;
  }

  function _renderDialButton(slideDirection = '') {
    const btn = document.getElementById('tCenterDialBtn');
    if (!btn) return;

    const mode = _getCurrentModeDef();
    const isUplinkOffline = mode.id === 'uplink' && !state.pcLinked;
    const hintText = isUplinkOffline
      ? '母艦と未接続 — 長押しで手動メニューを開けます（上下スワイプで機能切替）'
      : mode.ariaHint;
    btn.setAttribute('data-dial-mode', mode.id);
    btn.setAttribute('aria-label', `${mode.label} — ${hintText}`);
    btn.setAttribute('aria-disabled', isUplinkOffline ? 'true' : 'false');
    btn.title = hintText;
    btn.classList.toggle('is-uplink-offline', isUplinkOffline);
    btn.classList.toggle('is-gps-recording', Boolean(state.gpsRecording));
    btn.classList.toggle('is-gps-busy', Boolean(state.gpsBusy));
    btn.innerHTML = _buildDialInnerHtml();

    if (slideDirection) {
      const face = btn.querySelector('#tCenterDialFace');
      if (face) {
        const cls = slideDirection === 'up' ? 'is-slide-from-bottom' : 'is-slide-from-top';
        face.classList.add(cls);
        if (state.slideAnimTimer) clearTimeout(state.slideAnimTimer);
        state.slideAnimTimer = setTimeout(() => {
          face.classList.remove('is-slide-from-bottom', 'is-slide-from-top');
        }, 180);
      }
    }
  }

  /**
   * ダイヤルの選択モードを変更する ('uplink' | 'gps' | 'camera')
   */
  function setMode(modeIdOrIndex, slideDir = '', options = {}) {
    const len = DIAL_MODES.length;
    let nextIdx = state.modeIndex;
    if (typeof modeIdOrIndex === 'number') {
      nextIdx = ((modeIdOrIndex % len) + len) % len;
    } else {
      const foundIdx = DIAL_MODES.findIndex((m) => m.id === modeIdOrIndex);
      if (foundIdx >= 0) nextIdx = foundIdx;
    }
    if (nextIdx === state.modeIndex) {
      _renderDialButton('');
      return _getCurrentModeDef().id;
    }
    const dir = slideDir || (nextIdx < state.modeIndex ? 'up' : 'down');
    state.modeIndex = nextIdx;
    if (!options.silent) {
      _vibrate(8);
    }
    _renderDialButton(options.silent ? '' : dir);
    global.dispatchEvent(
      new CustomEvent('tetheract:center-dial-change', {
        detail: { mode: _getCurrentModeDef().id, index: state.modeIndex },
      })
    );
    return _getCurrentModeDef().id;
  }

  /**
   * 上下スワイプ量に応じて1コマずつ循環切り替えする（飛び越し防止のため常に1ステップ移動）
   * - 上スワイプ (dy < 0): GPS(1) -> 母艦に収納(0) -> カメラ(2) -> GPS(1)
   * - 下スワイプ (dy > 0): GPS(1) -> カメラ(2) -> 母艦に収納(0) -> GPS(1)
   */
  function _stepModeBySwipe(dy) {
    if (Math.abs(dy) < SWIPE_STEP_PX) return false;
    const len = DIAL_MODES.length;
    if (dy < 0) {
      setMode((state.modeIndex - 1 + len) % len, 'up');
    } else {
      setMode((state.modeIndex + 1) % len, 'down');
    }
    return true;
  }

  async function _executeActiveModeAction() {
    const mode = _getCurrentModeDef();
    if (mode.id === 'gps') {
      const adapter = global.TetheractFieldLogAdapter;
      const canNativeToggle = Boolean(adapter && typeof adapter.isAvailable === 'function' && adapter.isAvailable());
      if (canNativeToggle && global.TetheractTouchUI && typeof global.TetheractTouchUI.toggleFieldLogRecording === 'function') {
        _vibrate(10);
        await global.TetheractTouchUI.toggleFieldLogRecording();
        return;
      }
      if (global.TetheractTouchUI && typeof global.TetheractTouchUI.openFieldLogScreen === 'function') {
        global.TetheractTouchUI?.closePerspectiveSheet?.();
        await global.TetheractTouchUI.openFieldLogScreen();
      }
      return;
    }

    if (mode.id === 'uplink') {
      _syncLinkState();
      if (!state.pcLinked) {
        _showToast('母艦と未接続です（長押しで手動メニューを開けます）', 2600);
        _renderDialButton('');
        return;
      }
      setMode('gps', '', { silent: true });
      global.TetheractTouchUI?.closePerspectiveSheet?.();
      _vibrate(10);
      if (global.TetheractTouchUI && typeof global.TetheractTouchUI.triggerQuickDeltaUplink === 'function') {
        await global.TetheractTouchUI.triggerQuickDeltaUplink();
      } else if (typeof global.__syncLockerOverWifi === 'function') {
        global.__syncLockerOverWifi();
      } else {
        document.getElementById('mOpenDbModalBtn')?.click();
      }
      return;
    }

    if (mode.id === 'camera') {
      setMode('gps', '', { silent: true });
      global.TetheractTouchUI?.closePerspectiveSheet?.();
      if (global.TetheractTouchUI && typeof global.TetheractTouchUI.openCameraCapture === 'function') {
        await global.TetheractTouchUI.openCameraCapture();
      }
    }
  }

  /**
   * 選択中のダイヤルモードに応じた長押しアクションを実行する
   */
  function _executeActiveModeLongPress() {
    _vibrate(14);
    const mode = _getCurrentModeDef();
    if (mode.id === 'uplink') {
      setMode('gps', '', { silent: true });
      global.TetheractTouchUI?.closePerspectiveSheet?.();
      if (global.TetheractTouchUI && typeof global.TetheractTouchUI.openPhoneCaseModal === 'function') {
        global.TetheractTouchUI.openPhoneCaseModal('all', 'Uplink — 母艦に収納');
      } else {
        document.getElementById('mOpenDbModalBtn')?.click();
      }
      return;
    }

    if (mode.id === 'camera') {
      setMode('gps', '', { silent: true });
      global.TetheractTouchUI?.closePerspectiveSheet?.();
      global.TetheractTouchUI?.openCameraCapture?.();
      return;
    }

    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.openFieldLogScreen === 'function') {
      global.TetheractTouchUI?.closePerspectiveSheet?.();
      global.TetheractTouchUI.openFieldLogScreen();
    }
  }

  function _bindDialInteractions(btn) {
    if (!btn || btn.dataset.dialBound === '1') return;
    btn.dataset.dialBound = '1';

    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let movedBeyondTap = false;
    let longPressFired = false;
    let longPressTimer = null;

    const clearLongPress = () => {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const resetFaceOffset = () => {
      const face = btn.querySelector('#tCenterDialFace');
      if (face) face.style.transform = '';
    };

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      movedBeyondTap = false;
      longPressFired = false;
      clearLongPress();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch (err) {}

      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (!movedBeyondTap && pointerId !== null) {
          longPressFired = true;
          state.suppressClickUntil = Date.now() + 450;
          resetFaceOffset();
          _executeActiveModeLongPress();
        }
      }, LONG_PRESS_MS);
    });

    btn.addEventListener('pointermove', (e) => {
      if (pointerId === null || e.pointerId !== pointerId || longPressFired) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.hypot(dx, dy) > LONG_PRESS_CANCEL_PX) {
        movedBeyondTap = true;
        clearLongPress();
      }
      if (Math.abs(dy) > 4 && Math.abs(dy) >= Math.abs(dx) * 0.65) {
        const damped = Math.max(-10, Math.min(10, dy * 0.28));
        const face = btn.querySelector('#tCenterDialFace');
        if (face) face.style.transform = `translateY(${damped.toFixed(1)}px)`;
      }
    });

    const finishGesture = (e, cancelled) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      clearLongPress();
      try {
        if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      } catch (err) {}
      pointerId = null;
      resetFaceOffset();

      if (cancelled || longPressFired) return;

      if (Math.abs(dy) >= SWIPE_STEP_PX && Math.abs(dy) >= Math.abs(dx) * 0.65) {
        state.suppressClickUntil = Date.now() + 360;
        _stepModeBySwipe(dy);
      }
    };

    btn.addEventListener('pointerup', (e) => finishGesture(e, false));
    btn.addEventListener('pointercancel', (e) => finishGesture(e, true));

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (Date.now() < state.suppressClickUntil) {
        e.preventDefault();
        return;
      }
      _executeActiveModeAction();
    });

    // PCブラウザ検証時のマウスホイール・上下矢印キー切替にも対応
    btn.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) < 6) return;
        e.preventDefault();
        _stepModeBySwipe(e.deltaY > 0 ? SWIPE_STEP_PX + 2 : -(SWIPE_STEP_PX + 2));
      },
      { passive: false }
    );

    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        _stepModeBySwipe(-(SWIPE_STEP_PX + 2));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        _stepModeBySwipe(SWIPE_STEP_PX + 2);
      }
    });
  }

  /**
   * ボトムナビ中央スロット (#tCenterDialSlot) へ丸型ダイヤルボタンをマウントする
   */
  function mountCenterDial(slotElOrSelector) {
    const slot =
      typeof slotElOrSelector === 'string'
        ? document.querySelector(slotElOrSelector)
        : slotElOrSelector || document.getElementById('tCenterDialSlot');
    if (!slot) return null;

    let btn = document.getElementById('tCenterDialBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'tCenterDialBtn';
      btn.className = 't-center-dial-btn';
      slot.innerHTML = '';
      slot.appendChild(btn);
    }
    _syncStateFromFieldLog();
    _syncLinkState();
    _renderDialButton('');
    _bindDialInteractions(btn);
    return btn;
  }

  function _initCenterDial() {
    mountCenterDial();

    global.addEventListener('tetheract:fieldlog-ui-state', (e) => {
      const detail = (e && e.detail) || {};
      const st = detail.status || {};
      state.gpsAvailable = Boolean(st.available);
      state.gpsRecording = Boolean(st.available && st.recording);
      state.gpsBusy = Boolean(detail.busyToggle);
      state.todayPoints = Number(st.todayPoints || 0);
      _renderDialButton('');
    });

    global.addEventListener('tetheract:link-state-changed', (e) => {
      const detail = (e && e.detail) || {};
      if (typeof detail.isPcLinked === 'boolean') {
        state.pcLinked = detail.isPcLinked;
      } else {
        _syncLinkState();
      }
      _renderDialButton('');
    });
  }

  const centerDialApi = {
    DIAL_MODES,
    mountCenterDial,
    getMode: () => _getCurrentModeDef().id,
    setMode,
  };

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, {
    mountCenterDial,
    centerDial: centerDialApi,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initCenterDial);
  } else {
    _initCenterDial();
  }
})(window);
