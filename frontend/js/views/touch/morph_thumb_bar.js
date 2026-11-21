/**
 * Tetheract Context-Morphing Thumb Bar Controller (Layer 3)
 * 写真選択時（単一選択・複数選択）または Duel 比較時のみ画面下部に表示されるコンテキストフッターバー。
 * - PC版と同一の「優・良・可・棄」順（記号なし）
 * - Duel比較はスタック写真選択時または2枚以上選択時のみ表示
 */
(function (global) {
  'use strict';

  const VALID_MODES = ['cull', 'duel', 'adjust', 'batch'];

  const state = {
    mode: 'cull', // 'cull' | 'duel' | 'adjust' | 'batch'
    hasTargetPhoto: false, // 単一写真（インスペクタ等）が選択中か
    canDuel: false, // スタック写真（2枚以上）または複数選択2枚以上か
    activeRating: null, // 2 | 1 | 0 | -1 | null
    activeAdjustParam: 'exposure', // 'exposure' | 'contrast' | 'saturation' | 'tilt'
    duelSyncZoom: true,
    selectedCount: 0,
    callbacks: {
      onRate: null,
      onOpenTag: null,
      onOpenArtFramer: null,
      onStartDuel: null,
      onClearSelection: null,
      onDuelKeepA: null,
      onDuelKeepB: null,
      onDuelToggleSync: null,
      onDuelSwap: null,
      onDuelClose: null,
      onAdjustParamSelect: null,
      onAdjustReset: null,
      onAdjustDone: null,
      onBatchRate: null,
      onBatchTag: null,
      onBatchClear: null,
    },
  };

  function _shouldShowBar() {
    if (state.mode === 'duel' || state.mode === 'adjust') return true;
    if (state.mode === 'batch' && state.selectedCount > 0) return true;
    const isPhone = document.documentElement.getAttribute('data-device-mode') === 'phone';
    if (!isPhone && state.mode === 'cull' && state.hasTargetPhoto) return true;
    return false;
  }

  function _syncBarVisibility(barEl) {
    const bar = barEl || document.getElementById('tMorphThumbBar');
    if (!bar) return;
    const visible = _shouldShowBar();
    bar.style.display = visible ? 'flex' : 'none';
    document.body.classList.toggle('has-visible-thumb-bar', visible);
  }

  /**
   * モード別のフッターバー内部HTMLを生成する（評価順序: 優・良・可・棄、記号なし）
   */
  function _renderBarContentHtml(mode) {
    if (mode === 'duel') {
      return `
        <div class="t-thumb-slot-group t-thumb-group-duel" data-morph-mode="duel">
          <button type="button" class="t-thumb-btn is-keep-btn" data-thumb-action="duel-keep-a" title="Aを残して比較を続ける">
            <span>Aを残す</span>
          </button>
          <button type="button" class="t-thumb-btn ${state.duelSyncZoom ? 'is-active' : ''}" data-thumb-action="duel-sync-zoom" title="ピンチズーム＆パンをA/Bで完全同期">
            <span>同期ズーム固定</span>
          </button>
          <button type="button" class="t-thumb-btn" data-thumb-action="duel-swap" title="AとBの位置を入れ替え">
            <span>A/B入れ替え</span>
          </button>
          <button type="button" class="t-thumb-btn is-keep-btn" data-thumb-action="duel-keep-b" title="Bを残して比較を続ける">
            <span>Bを残す</span>
          </button>
          <button type="button" class="t-thumb-btn is-exit-btn" data-thumb-action="duel-close" title="2枚比較を終了">
            <span>比較終了</span>
          </button>
        </div>
      `;
    }

    if (mode === 'adjust') {
      const p = state.activeAdjustParam;
      const isMod = (k) => (global.TetheractTouchUI?.isParamModified?.(k) ? 'is-modified' : '');
      return `
        <div class="t-thumb-slot-group t-thumb-group-adjust" data-morph-mode="adjust">
          <button type="button" class="t-thumb-btn ${p === 'exposure' ? 'is-active' : ''} ${isMod('exposure')}" data-thumb-action="adjust-param" data-param="exposure">
            <span>露光量</span>
          </button>
          <button type="button" class="t-thumb-btn ${p === 'contrast' ? 'is-active' : ''} ${isMod('contrast')}" data-thumb-action="adjust-param" data-param="contrast">
            <span>コントラスト</span>
          </button>
          <button type="button" class="t-thumb-btn ${p === 'saturation' ? 'is-active' : ''} ${isMod('saturation')}" data-thumb-action="adjust-param" data-param="saturation">
            <span>彩度</span>
          </button>
          <button type="button" class="t-thumb-btn ${p === 'tilt' ? 'is-active' : ''} ${isMod('tilt')}" data-thumb-action="adjust-param" data-param="tilt">
            <span>傾き</span>
          </button>
          <button type="button" class="t-thumb-btn" data-thumb-action="adjust-reset" title="調整値を初期状態にリセット">
            <span>リセット</span>
          </button>
          <button type="button" class="t-thumb-btn is-primary-btn" data-thumb-action="adjust-done" title="調整を確定して閉じる">
            <span>完了</span>
          </button>
        </div>
      `;
    }

    if (mode === 'batch') {
      const duelHtml = state.canDuel
        ? `<button type="button" class="t-thumb-btn is-primary-btn" data-thumb-action="start-duel" title="選択した写真を2枚比較（Duel）"><span>Duel比較</span></button>`
        : '';
      return `
        <div class="t-thumb-slot-group t-thumb-group-batch" data-morph-mode="batch">
          <div class="t-thumb-selection-badge" id="tThumbSelectedBadge">
            <span class="t-thumb-selection-num">${Number(state.selectedCount || 0)}</span>
            <span class="t-thumb-selection-unit">枚</span>
          </div>
          <button type="button" class="t-thumb-btn is-rate-excellent" data-thumb-action="batch-rate-apply" data-rate="2"><span>優</span></button>
          <button type="button" class="t-thumb-btn is-rate-good" data-thumb-action="batch-rate-apply" data-rate="1"><span>良</span></button>
          <button type="button" class="t-thumb-btn is-rate-normal" data-thumb-action="batch-rate-apply" data-rate="0"><span>可</span></button>
          <button type="button" class="t-thumb-btn is-rate-discard" data-thumb-action="batch-rate-apply" data-rate="-1"><span>棄</span></button>
          <div class="t-thumb-divider"></div>
          <button type="button" class="t-thumb-btn" data-thumb-action="batch-tag"><span>タグ</span></button>
          ${duelHtml}
          <button type="button" class="t-thumb-btn" data-thumb-action="batch-select-all"><span>全選択</span></button>
          <button type="button" class="t-thumb-btn is-exit-btn" data-thumb-action="batch-clear"><span>解除</span></button>
        </div>
      `;
    }

    // 'cull'（単一写真選択時）: [優] [良] [可] [棄] | [タグ] [枠(ArtFramer)] [Duel比較(スタック時のみ)] [解除]
    const r = state.activeRating;
    const duelBtnHtml = state.canDuel
      ? `<button type="button" class="t-thumb-btn is-primary-btn" data-thumb-action="start-duel" title="スタック内写真を2枚比較（Duel）"><span>Duel比較</span></button>`
      : '';
    return `
      <div class="t-thumb-slot-group t-thumb-group-cull" data-morph-mode="cull">
        <button type="button" class="t-thumb-btn is-rate-excellent ${r === 2 ? 'is-active' : ''}" data-thumb-action="cull-rate" data-rate="2" title="評価「優」">
          <span>優</span>
        </button>
        <button type="button" class="t-thumb-btn is-rate-good ${r === 1 ? 'is-active' : ''}" data-thumb-action="cull-rate" data-rate="1" title="評価「良」">
          <span>良</span>
        </button>
        <button type="button" class="t-thumb-btn is-rate-normal ${r === 0 ? 'is-active' : ''}" data-thumb-action="cull-rate" data-rate="0" title="評価「可」">
          <span>可</span>
        </button>
        <button type="button" class="t-thumb-btn is-rate-discard ${r === -1 ? 'is-active' : ''}" data-thumb-action="cull-rate" data-rate="-1" title="評価「棄」">
          <span>棄</span>
        </button>
        <div class="t-thumb-divider"></div>
        <button type="button" class="t-thumb-btn" data-thumb-action="open-tag" title="選択中の写真のタグを編集">
          <span>タグ</span>
        </button>
        <button type="button" class="t-thumb-btn" data-thumb-action="open-art-framer" title="Art Framer（プライバシーマスク・プリント枠・共有）">
          <span>枠</span>
        </button>
        ${duelBtnHtml}
        <button type="button" class="t-thumb-btn is-exit-btn" data-thumb-action="clear-selection" title="選択を解除">
          <span>解除</span>
        </button>
      </div>
    `;
  }

  function mountMorphThumbBar(containerSelectorOrEl) {
    let bar = document.getElementById('tMorphThumbBar');
    if (bar) {
      _syncBarVisibility(bar);
      return bar;
    }

    const host =
      typeof containerSelectorOrEl === 'string'
        ? document.querySelector(containerSelectorOrEl)
        : containerSelectorOrEl || document.querySelector('.m-app') || document.body;
    if (!host) return null;

    bar = document.createElement('nav');
    bar.id = 'tMorphThumbBar';
    bar.className = 't-morph-thumb-bar';
    bar.setAttribute('aria-label', '選択写真アクションバー');
    bar.setAttribute('data-thumb-mode', state.mode);
    bar.innerHTML = _renderBarContentHtml(state.mode);

    host.appendChild(bar);
    _bindThumbBarEvents(bar);
    _syncBarVisibility(bar);
    return bar;
  }

  function _bindThumbBarEvents(barEl) {
    barEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-thumb-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-thumb-action');

      switch (action) {
        case 'cull-rate': {
          const rate = Number(btn.getAttribute('data-rate'));
          setActiveRating(rate);
          if (typeof state.callbacks.onRate === 'function') {
            state.callbacks.onRate(rate);
          } else if (typeof global.__onTabletInspectorRate === 'function') {
            global.__onTabletInspectorRate(rate);
          }
          global.dispatchEvent(new CustomEvent('tetheract:thumb-rate', { detail: { rating: rate } }));
          break;
        }

        case 'open-tag': {
          if (typeof state.callbacks.onOpenTag === 'function') {
            state.callbacks.onOpenTag();
          } else if (typeof global.__onTabletInspectorOpenTagSheet === 'function') {
            global.__onTabletInspectorOpenTagSheet();
          }
          break;
        }

        case 'open-art-framer': {
          if (typeof state.callbacks.onOpenArtFramer === 'function') {
            state.callbacks.onOpenArtFramer();
          } else if (global.TetheractTouchUI && global.TetheractTouchUI.artFramer && typeof global.TetheractTouchUI.artFramer.open === 'function') {
            global.TetheractTouchUI.artFramer.open();
          }
          break;
        }

        case 'clear-selection': {
          setTargetPhotoState({ hasTarget: false, rating: null, canDuel: false });
          if (typeof state.callbacks.onClearSelection === 'function') {
            state.callbacks.onClearSelection();
          } else if (typeof global.__onClearSingleSelection === 'function') {
            global.__onClearSingleSelection();
          }
          break;
        }

        case 'start-duel': {
          setThumbBarMode('duel');
          if (typeof state.callbacks.onStartDuel === 'function') {
            state.callbacks.onStartDuel();
          } else if (typeof global.__onStartContextualDuel === 'function') {
            global.__onStartContextualDuel();
          } else if (global.TetheractTouchUI && global.TetheractTouchUI.duel) {
            global.TetheractTouchUI.duel.openDuel();
          }
          break;
        }

        case 'duel-keep-a': {
          if (typeof state.callbacks.onDuelKeepA === 'function') state.callbacks.onDuelKeepA();
          else if (global.TetheractTouchUI && global.TetheractTouchUI.duel) global.TetheractTouchUI.duel.keepCandidate('A');
          break;
        }

        case 'duel-keep-b': {
          if (typeof state.callbacks.onDuelKeepB === 'function') state.callbacks.onDuelKeepB();
          else if (global.TetheractTouchUI && global.TetheractTouchUI.duel) global.TetheractTouchUI.duel.keepCandidate('B');
          break;
        }

        case 'duel-sync-zoom': {
          state.duelSyncZoom = !state.duelSyncZoom;
          btn.classList.toggle('is-active', state.duelSyncZoom);
          if (typeof state.callbacks.onDuelToggleSync === 'function') state.callbacks.onDuelToggleSync(state.duelSyncZoom);
          else if (global.TetheractTouchUI && global.TetheractTouchUI.duel) global.TetheractTouchUI.duel.setSyncZoom(state.duelSyncZoom);
          break;
        }

        case 'duel-swap': {
          if (typeof state.callbacks.onDuelSwap === 'function') state.callbacks.onDuelSwap();
          else if (global.TetheractTouchUI && global.TetheractTouchUI.duel) global.TetheractTouchUI.duel.swapCandidates();
          break;
        }

        case 'duel-close': {
          if (typeof state.callbacks.onDuelClose === 'function') state.callbacks.onDuelClose();
          else if (global.TetheractTouchUI && global.TetheractTouchUI.duel) global.TetheractTouchUI.duel.closeDuel();
          setThumbBarMode(state.selectedCount > 0 ? 'batch' : 'cull');
          break;
        }

        case 'adjust-param': {
          const param = btn.getAttribute('data-param') || 'exposure';
          state.activeAdjustParam = param;
          barEl.querySelectorAll('[data-thumb-action="adjust-param"]').forEach((el) => {
            el.classList.toggle('is-active', el.getAttribute('data-param') === param);
          });
          if (global.TetheractTouchUI && typeof global.TetheractTouchUI.setActiveAdjustParam === 'function') {
            global.TetheractTouchUI.setActiveAdjustParam(param);
          }
          if (typeof state.callbacks.onAdjustParamSelect === 'function') state.callbacks.onAdjustParamSelect(param);
          break;
        }

        case 'adjust-reset': {
          if (global.TetheractTouchUI && typeof global.TetheractTouchUI.resetAdjustValues === 'function') {
            global.TetheractTouchUI.resetAdjustValues();
          }
          if (typeof state.callbacks.onAdjustReset === 'function') state.callbacks.onAdjustReset();
          break;
        }

        case 'adjust-done': {
          if (global.TetheractTouchUI && typeof global.TetheractTouchUI.setAdjustModeEnabled === 'function') {
            global.TetheractTouchUI.setAdjustModeEnabled(false);
          }
          if (typeof state.callbacks.onAdjustDone === 'function') state.callbacks.onAdjustDone();
          setThumbBarMode(state.selectedCount > 0 ? 'batch' : 'cull');
          break;
        }

        case 'batch-rate-apply': {
          const batchRate = Number(btn.getAttribute('data-rate'));
          if (typeof state.callbacks.onBatchRate === 'function') {
            state.callbacks.onBatchRate(batchRate);
          } else {
            const legacyBtn = document.querySelector(`[data-batch-rate="${batchRate}"]`);
            if (legacyBtn) legacyBtn.click();
          }
          break;
        }

        case 'batch-tag': {
          if (typeof state.callbacks.onBatchTag === 'function') {
            state.callbacks.onBatchTag();
          } else {
            const legacyTagBtn = document.getElementById('mBatchTagBtn');
            if (legacyTagBtn) legacyTagBtn.click();
          }
          break;
        }

        case 'batch-select-all': {
          const selAllBtn = document.getElementById('mBatchSelectAllBtn');
          if (selAllBtn) selAllBtn.click();
          const allCards = document.querySelectorAll('.m-card.selected, .photo-card.selected');
          updateSelectionCount(allCards.length);
          break;
        }

        case 'batch-clear': {
          state.selectedCount = 0;
          state.canDuel = false;
          if (typeof state.callbacks.onBatchClear === 'function') {
            state.callbacks.onBatchClear();
          } else {
            const clearBtn = document.getElementById('mBatchClearBtn');
            const exitBtn = document.getElementById('mBatchExitBtn');
            if (clearBtn) clearBtn.click();
            if (exitBtn) exitBtn.click();
          }
          document.body.classList.remove('m-select-mode');
          setThumbBarMode('cull');
          break;
        }
      }
    });
  }

  function _refreshBarDom() {
    const bar = mountMorphThumbBar();
    if (!bar) return;
    bar.setAttribute('data-thumb-mode', state.mode);
    bar.innerHTML = _renderBarContentHtml(state.mode);
    _syncBarVisibility(bar);
  }

  function setThumbBarMode(nextMode) {
    if (!VALID_MODES.includes(nextMode)) return state.mode;
    const prevMode = state.mode;
    state.mode = nextMode;

    const isAdj = nextMode === 'adjust';
    document.body.classList.toggle('is-viewer-adjust-mode', isAdj);
    document.getElementById('mViewerAdjustBtn')?.classList.toggle('active', isAdj);
    if (global.TetheractTouchUI && typeof global.TetheractTouchUI.setAdjustModeEnabled === 'function') {
      global.TetheractTouchUI.setAdjustModeEnabled(isAdj, state.activeAdjustParam);
    }

    _refreshBarDom();

    if (prevMode !== nextMode) {
      global.dispatchEvent(
        new CustomEvent('tetheract:thumb-mode-change', {
          detail: { prevMode, mode: nextMode },
        })
      );
    }
    return state.mode;
  }

  /**
   * 単一写真の選択状態（インスペクタ選択時・スタック有無）を更新する
   */
  function setTargetPhotoState(opts = {}) {
    state.hasTargetPhoto = Boolean(opts.hasTarget);
    if (opts.rating !== undefined) {
      state.activeRating = opts.rating === null ? null : Number(opts.rating);
    }
    if (state.mode === 'cull') {
      state.canDuel = Boolean(opts.canDuel);
      _refreshBarDom();
    } else {
      _syncBarVisibility();
    }
  }

  /**
   * 複数選択枚数バッジを更新する（2枚以上選択時のみ Duel比較 を有効化）
   */
  function updateSelectionCount(count, extraOpts = {}) {
    state.selectedCount = Math.max(0, Number(count) || 0);
    if (state.selectedCount > 0) {
      state.canDuel = state.selectedCount >= 2 || Boolean(extraOpts.canDuel);
      state.mode = 'batch';
      _refreshBarDom();
    } else if (state.mode === 'batch') {
      state.canDuel = false;
      setThumbBarMode('cull');
    } else {
      _syncBarVisibility();
    }
  }

  function setActiveRating(rating) {
    state.activeRating = rating;
    if (state.mode !== 'cull') return;
    const bar = document.getElementById('tMorphThumbBar');
    if (!bar) return;
    bar.querySelectorAll('[data-thumb-action="cull-rate"]').forEach((btn) => {
      const btnRate = Number(btn.getAttribute('data-rate'));
      btn.classList.toggle('is-active', btnRate === rating);
    });
  }

  let _usbToastTimer = null;
  function _showUsbMountToast(msg, durationMs = 3500) {
    const el = document.getElementById('mToast');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    if (_usbToastTimer) clearTimeout(_usbToastTimer);
    _usbToastTimer = setTimeout(() => {
      el.style.display = 'none';
    }, durationMs);
  }

  let _syncingModeBadge = false;
  let _pcOnlineOverride = null;
  let _lastIsPcLinked = null;
  let _lastKnownLinkKey = '';
  let _cachedPcConnRev = '';
  let _cachedUsbVsn = '';

  /**
   * 母艦PCと現在LINK（オンライン疎通）しているかを返す
   */
  function isMotherShipLinked() {
    if (global.TetheractNative && typeof global.TetheractNative.getLockerStatusJson === 'function') {
      try {
        const st = JSON.parse(global.TetheractNative.getLockerStatusJson() || '{}');
        if (typeof st.pcOnline === 'boolean') {
          _pcOnlineOverride = st.pcOnline;
          _lastIsPcLinked = st.pcOnline;
          return st.pcOnline;
        }
      } catch (e) {}
    }
    if (_lastIsPcLinked !== null) return Boolean(_lastIsPcLinked);
    if (_pcOnlineOverride !== null) return Boolean(_pcOnlineOverride);
    const badge = document.getElementById('mModeBadge');
    if (badge) {
      const txt = (badge.textContent || '').trim();
      return txt === '● Wi-Fi接続' || txt === '● LINK';
    }
    return false;
  }

  /**
   * バナー横のステータスバッジ (#mModeBadge) を以下の4状態で統一表示する：
   * - LINK中 + Loome接続中 : 「● Loome」（ブルー: mode-localdb）
   * - LINK中 (Loome未接続) : 「● LINK」 （ブルー: mode-localdb）
   * - 未LINK + Loome接続中 : 「● Loome」（グリーン: mode-server）
   * - 未LINK + Loome未接続 : 「○ UNLINK」（グレー: mode-offline）
   */
  function _syncBrandLinkBadge(overrideUsbConnected = null) {
    if (_syncingModeBadge) return;
    const badge = document.getElementById('mModeBadge');
    if (!badge) return;

    _syncingModeBadge = true;
    try {
      let isPcLinked = false;
      let usbConnected = overrideUsbConnected;
      let pcConnRevision = _cachedPcConnRev;
      let usbVsn = _cachedUsbVsn;

      if (global.TetheractNative && typeof global.TetheractNative.getLockerStatusJson === 'function') {
        try {
          const st = JSON.parse(global.TetheractNative.getLockerStatusJson() || '{}');
          isPcLinked = st.pcOnline !== undefined ? Boolean(st.pcOnline) : Boolean(_pcOnlineOverride);
          _pcOnlineOverride = isPcLinked;
          if (usbConnected === null) usbConnected = Boolean(st.usbConnected);
          pcConnRevision = String(st.pcConnRevision || _cachedPcConnRev || '');
          _cachedPcConnRev = pcConnRevision;
          usbVsn = String(st.usbVsn || _cachedUsbVsn || '').toUpperCase();
          _cachedUsbVsn = usbVsn;
        } catch (e) {
          isPcLinked = Boolean(_pcOnlineOverride);
        }
      } else {
        // ブラウザアクセス時: PCサーバー直結は LINK、ローカルDB読込は Loome (グリーン)
        isPcLinked = _pcOnlineOverride !== null ? Boolean(_pcOnlineOverride) : badge.textContent === '● Wi-Fi接続' || badge.textContent === '● LINK';
        if (usbConnected === null) usbConnected = badge.textContent === '● USB DB' || badge.textContent === '● Loome';
      }

      let nextClass = 'm-mode-badge mode-offline';
      let nextText = '○ UNLINK';
      if (isPcLinked && usbConnected) {
        nextClass = 'm-mode-badge mode-localdb';
        nextText = '● Loome';
      } else if (isPcLinked) {
        nextClass = 'm-mode-badge mode-localdb';
        nextText = '● LINK';
      } else if (usbConnected) {
        nextClass = 'm-mode-badge mode-server';
        nextText = '● Loome';
      }

      if (badge.className !== nextClass) badge.className = nextClass;
      if (badge.textContent !== nextText) badge.textContent = nextText;

      const prevLinked = _lastIsPcLinked;
      _lastIsPcLinked = Boolean(isPcLinked);

      const linkKey = `${isPcLinked ? 1 : 0}:${usbConnected ? 1 : 0}:${pcConnRevision}:${usbVsn}`;
      if (linkKey !== _lastKnownLinkKey || prevLinked !== _lastIsPcLinked) {
        _lastKnownLinkKey = linkKey;
        if (typeof global.__refreshMobileOfflineGridState === 'function') {
          global.__refreshMobileOfflineGridState({
            isPcLinked,
            usbConnected: Boolean(usbConnected),
            pcConnRevision,
            usbVsn,
          });
        }
        global.dispatchEvent(
          new CustomEvent('tetheract:link-state-changed', {
            detail: {
              isPcLinked: Boolean(isPcLinked),
              usbConnected: Boolean(usbConnected),
            },
          })
        );
      }
    } finally {
      _syncingModeBadge = false;
    }
  }

  function _installBrandHeaderEvents() {
    const badge = document.getElementById('mModeBadge');
    if (badge && !badge.dataset.linkObserverBound) {
      badge.dataset.linkObserverBound = '1';
      const obs = new MutationObserver(() => _syncBrandLinkBadge());
      obs.observe(badge, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      _syncBrandLinkBadge();
    }
  }

  let _origPcDiscovered =
    typeof global.__onTetheractPcDiscovered === 'function' ? global.__onTetheractPcDiscovered : null;
  let _usbHookInstalled = false;

  /**
   * Loome USB の読み取り専用マウント・鍵解錠・取り外し通知および PC 検出通知を購読する
   */
  function _installUsbSyncCompletedHook() {
    if (_usbHookInstalled) return;
    _usbHookInstalled = true;

    const wrappedPcDiscovered = function (disc) {
      _pcOnlineOverride = Boolean(disc && disc.found);
      _syncBrandLinkBadge();
      if (typeof _origPcDiscovered === 'function') {
        _origPcDiscovered(disc);
      }
    };

    try {
      Object.defineProperty(global, '__onTetheractPcDiscovered', {
        configurable: true,
        enumerable: true,
        get() {
          return wrappedPcDiscovered;
        },
        set(fn) {
          if (fn !== wrappedPcDiscovered && typeof fn === 'function') {
            _origPcDiscovered = fn;
          }
        },
      });
    } catch (e) {
      global.__onTetheractPcDiscovered = wrappedPcDiscovered;
    }

    global.addEventListener('tetheract:usb-sync-completed', (ev) => {
      const res = (ev && ev.detail) || {};
      if (res && (res.syncMode === 'loome_detached' || res.usbDetached)) {
        const loadingEl = document.getElementById('mLoadingState');
        if (loadingEl) loadingEl.style.display = 'none';
        if (global.TetheractTouchUI && typeof global.TetheractTouchUI.updateLockerStatus === 'function') {
          global.TetheractTouchUI.updateLockerStatus({ usbConnected: false });
        }
        _syncBrandLinkBadge(false);
        _showUsbMountToast('Loome USBを取り外しました（メモリ上の鍵を消去しました）', 3500);
        return;
      }

      if (res && typeof res.syncMode === 'string' && res.syncMode.startsWith('wifi_')) {
        _pcOnlineOverride = Boolean(res.ok);
      } else if (res && !res.ok && (res.reason === 'network_error' || res.reason === 'pc_not_found')) {
        _pcOnlineOverride = false;
      }

      if (res && res.ok && res.syncMode === 'loome_mount') {
        _syncBrandLinkBadge(true);
        const msg = res.unlocked
          ? '鍵付きLoomeを解錠しました（抜くと自動ロック）'
          : '● Loome USB直結：原本データを直接表示できます';
        _showUsbMountToast(msg, 3600);
      } else {
        _syncBrandLinkBadge();
      }
    });

    global.__onTetheractLinkStateChanged = function (st) {
      if (st && typeof st.pcOnline === 'boolean') {
        _pcOnlineOverride = st.pcOnline;
      }
      if (st && typeof st.pcConnRevision === 'string') {
        _cachedPcConnRev = st.pcConnRevision;
      }
      if (st && typeof st.usbVsn === 'string') {
        _cachedUsbVsn = st.usbVsn.toUpperCase();
      }
      const usbArg = st && typeof st.usbConnected === 'boolean' ? st.usbConnected : null;
      _syncBrandLinkBadge(usbArg);
    };
  }

  let _globalEventsBound = false;

  function initMorphThumbBar(options = {}) {
    if (options.callbacks && typeof options.callbacks === 'object') {
      Object.assign(state.callbacks, options.callbacks);
    }
    _installUsbSyncCompletedHook();
    _installBrandHeaderEvents();
    mountMorphThumbBar(options.container);

    if (_globalEventsBound) return;
    _globalEventsBound = true;

    document.addEventListener('click', (e) => {
      const brandBtn = e.target.closest('.m-brand');
      if (brandBtn) {
        if (global.TetheractTouchUI && typeof global.TetheractTouchUI.closePerspectiveSheet === 'function') {
          global.TetheractTouchUI.closePerspectiveSheet();
        }
        document.getElementById('mOpenDbModalBtn')?.click();
        return;
      }
      const pickBtn = e.target.closest('#mNativeUsbPickFolderBtn');
      if (pickBtn) {
        if (global.TetheractNative && typeof global.TetheractNative.triggerUsbSyncAsyncJson === 'function') {
          const res = JSON.parse(global.TetheractNative.triggerUsbSyncAsyncJson() || '{}');
          if (res.status === 'usb_sync_started' || res.status === 'picker_launched') {
            document.getElementById('mCloseDbSyncBtn')?.click();
          }
        } else {
          document.getElementById('mSelectDbFileBtn')?.click();
        }
        return;
      }
      const clrBtn = e.target.closest('#mNativeClearPendingProxyBtn');
      if (clrBtn) {
        document.getElementById('mClearPendingBtn')?.click();
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest('.m-brand')) {
        e.preventDefault();
        document.getElementById('mOpenDbModalBtn')?.click();
      }
    });

    global.addEventListener('tetheract:grid-drag-select', () => {
      const selectedCards = document.querySelectorAll('.m-card.selected, .photo-card.selected');
      updateSelectionCount(selectedCards.length);
    });

    const syncAdjustModifiedPills = () => {
      const bar = document.getElementById('tMorphThumbBar');
      if (!bar || state.mode !== 'adjust') return;
      bar.querySelectorAll('[data-thumb-action="adjust-param"]').forEach((el) => {
        const key = el.getAttribute('data-param');
        el.classList.toggle('is-modified', Boolean(global.TetheractTouchUI?.isParamModified?.(key)));
      });
    };
    global.addEventListener('tetheract:canvas-scrub-change', syncAdjustModifiedPills);
    global.addEventListener('tetheract:adjust-values-loaded', syncAdjustModifiedPills);
  }

  const thumbBarApi = {
    VALID_MODES,
    initMorphThumbBar,
    mountMorphThumbBar,
    setThumbBarMode,
    setMode: setThumbBarMode,
    getThumbBarMode: () => state.mode,
    getMode: () => state.mode,
    updateSelectionCount,
    setActiveRating,
    setTargetPhotoState,
  };

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, {
    initMorphThumbBar,
    isMotherShipLinked,
    setThumbBarMode,
    getThumbBarMode: thumbBarApi.getThumbBarMode,
    updateSelectionCount,
    setActiveRating,
    setTargetPhotoState,
    thumbBar: thumbBarApi,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initMorphThumbBar());
  } else {
    initMorphThumbBar();
  }
})(window);
