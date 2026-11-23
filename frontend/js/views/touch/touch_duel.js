/**
 * Tetheract Touch & Tablet Duel Comparison View (Layer 3)
 * スマホ・タブレット特化の2枚比較（Duel）ビュー：
 * - タブレット横向き / スマホ横向き: 左右2画面並列（Side-by-Side）
 * - スマホ縦向き: 上下2分割（Top-Bottom）または A/B フリップ比較に自動適応・ワンタップ切替
 * - ピンチズーム＆パンの完全同期: 片方の写真をピンチ拡大・ドラッグ移動すると、
 *   もう片方の写真も同じ倍率・同じ相対座標（normalized ratio）へリアルタイム追従する。
 */
(function (global) {
  'use strict';

  const MIN_ZOOM = 1.0;
  const MAX_ZOOM = 6.0;

  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _escAttr(val) {
    return _escHtml(val);
  }

  /**
   * Duel比較状態
   */
  const state = {
    isOpen: false,
    syncZoom: true,
    layoutOrientation: 'side-by-side', // 'side-by-side' | 'top-bottom' | 'flip'
    portraitPreferFlip: false,
    flipActiveSlot: 'A', // 'A' | 'B' (flipモード時)
    photoA: null,
    photoB: null,
    pool: [], // 3枚以上選択されていた場合の順次勝ち抜きキュー
    transformA: { scale: 1, normX: 0, normY: 0 },
    transformB: { scale: 1, normX: 0, normY: 0 },
    onWinnerSelected: null,
  };

  /**
   * 画面の向きとアスペクト比から最適レイアウト（side-by-side / top-bottom / flip）を算出
   */
  function resolveDuelLayout() {
    const w = global.innerWidth || document.documentElement.clientWidth || 375;
    const h = global.innerHeight || document.documentElement.clientHeight || 667;
    const isLandscape = w >= h || w >= 760;

    if (isLandscape) {
      state.layoutOrientation = 'side-by-side';
    } else {
      state.layoutOrientation = state.portraitPreferFlip ? 'flip' : 'top-bottom';
    }

    const modal = document.getElementById('tTouchDuelModal');
    if (modal) {
      modal.setAttribute('data-duel-layout', state.layoutOrientation);
      modal.setAttribute('data-duel-flip-slot', state.flipActiveSlot);
    }
    return state.layoutOrientation;
  }

  /**
   * Duel比較モーダルDOMを生成・マウントする
   */
  function _ensureDuelModal() {
    let modal = document.getElementById('tTouchDuelModal');
    if (modal) return modal;

    modal = document.createElement('section');
    modal.id = 'tTouchDuelModal';
    modal.className = 't-duel-modal';
    modal.style.display = 'none';
    modal.setAttribute('aria-label', 'Duel 2枚比較ビュー');
    modal.innerHTML = `
      <header class="t-duel-topbar">
        <div class="t-duel-topbar-left">
          <span class="t-duel-badge">DUEL</span>
          <span class="t-duel-sync-indicator" id="tDuelSyncStatusText">同期ズーム ON</span>
        </div>
        <div class="t-duel-topbar-right">
          <button type="button" class="t-duel-layout-btn" id="tDuelPortraitModeBtn" title="縦向き時の分割方式切替 (上下2分割 ⇄ A/Bフリップ)">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
            <span id="tDuelPortraitModeLabel">上下分割</span>
          </button>
          <button type="button" class="t-duel-close-btn" id="tDuelTopCloseBtn" aria-label="比較を閉じる">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </header>

      <div class="t-duel-stage" id="tDuelStage">
        <!-- スロット A -->
        <div class="t-duel-pane" id="tDuelPaneA" data-duel-slot="A">
          <div class="t-duel-pane-overlay-top">
            <span class="t-duel-slot-pill is-slot-a">A</span>
            <span class="t-duel-filename" id="tDuelFileA">-</span>
            <span class="t-duel-zoom-badge" id="tDuelZoomBadgeA">1.0x</span>
          </div>
          <div class="t-duel-canvas-wrap" id="tDuelWrapA">
            <img class="t-duel-img" id="tDuelImgA" src="" alt="比較候補 A" draggable="false">
          </div>
          <div class="t-duel-exif-strip" id="tDuelExifA"></div>
        </div>

        <div class="t-duel-divider"></div>

        <!-- スロット B -->
        <div class="t-duel-pane" id="tDuelPaneB" data-duel-slot="B">
          <div class="t-duel-pane-overlay-top">
            <span class="t-duel-slot-pill is-slot-b">B</span>
            <span class="t-duel-filename" id="tDuelFileB">-</span>
            <span class="t-duel-zoom-badge" id="tDuelZoomBadgeB">1.0x</span>
          </div>
          <div class="t-duel-canvas-wrap" id="tDuelWrapB">
            <img class="t-duel-img" id="tDuelImgB" src="" alt="比較候補 B" draggable="false">
          </div>
          <div class="t-duel-exif-strip" id="tDuelExifB"></div>
        </div>
      </div>

      <!-- フリップ比較モード用ワンタップ切替ピル -->
      <div class="t-duel-flip-switcher" id="tDuelFlipSwitcher">
        <button type="button" class="t-duel-flip-btn is-active" data-flip-target="A">A を表示</button>
        <button type="button" class="t-duel-flip-btn" data-flip-target="B">B を表示 (長押し比較)</button>
      </div>
    `;

    (document.querySelector('.m-app') || document.body).appendChild(modal);
    _bindDuelEvents(modal);
    return modal;
  }

  /**
   * 画面上の選択カードまたはグリッド先頭から比較対象2枚を自動収集する
   */
  function _collectDefaultCandidates() {
    const selectedCards = Array.from(
      document.querySelectorAll('.m-card.selected, .photo-card.selected')
    );
    const sourceCards =
      selectedCards.length >= 2
        ? selectedCards
        : Array.from(document.querySelectorAll('.m-card, .photo-card')).slice(0, 6);

    return sourceCards.map((card, idx) => {
      const img = card.querySelector('img');
      const id = card.getAttribute('data-id') || card.getAttribute('data-photo-id') || `p-${idx}`;
      const name = card.getAttribute('data-filename') || card.getAttribute('title') || `Photo #${id}`;
      const exif = card.getAttribute('data-exif') || '';
      return {
        id,
        file_name: name,
        src: img ? img.src : '',
        exifSummary: exif,
      };
    });
  }

  function _bindDuelSlotImage(imgEl, photo, slotKey) {
    if (!imgEl || !photo) return;
    const targetId = String(photo.id || slotKey);
    photo._loadedNaturalW = 0;
    photo._loadedNaturalH = 0;
    imgEl.dataset.photoId = targetId;
    const resolveUnbaked = global.TetheractTouchUI?.resolveImageUnbakedState;
    imgEl.dataset.unbakedSource = resolveUnbaked
      ? (resolveUnbaked(photo, { isFallback: true, isServerMode: Boolean(photo.isServerMode) }) ? '1' : '0')
      : '0';
    imgEl.onload = () => _applyTransforms();
    imgEl.src = photo.src || photo.thumbUrl || '';
    const tryLoadHd = (urlToTry, fallbackUrl) => {
      if (!urlToTry) return;
      const pre = new Image();
      pre.onload = () => {
        if (imgEl.dataset.photoId === targetId && (pre.naturalWidth > 420 || pre.naturalHeight > 420)) {
          photo._loadedNaturalW = pre.naturalWidth;
          photo._loadedNaturalH = pre.naturalHeight;
          const nativeSrc = global.TetheractNative?.getLastPhotoSource ? global.TetheractNative.getLastPhotoSource(Number(photo.id || 0)) : '';
          imgEl.dataset.unbakedSource = resolveUnbaked
            ? (resolveUnbaked(photo, { isFallback: false, isServerMode: Boolean(photo.isServerMode), nativeSource: nativeSrc }) ? '1' : '0')
            : ((nativeSrc === 'usb' || nativeSrc === 'phone') ? '1' : '0');
          imgEl.src = urlToTry;
          _applyTransforms();
        } else if (fallbackUrl) {
          tryLoadHd(fallbackUrl, '');
        }
      };
      pre.onerror = () => {
        if (imgEl.dataset.photoId === targetId && fallbackUrl) tryLoadHd(fallbackUrl, '');
      };
      pre.src = urlToTry;
    };
    tryLoadHd(photo.hdUrl || '', photo.fallbackHdUrl || '');
  }

  /**
   * スロットA / B のDOM表示を更新する
   */
  function _renderCandidates() {
    const fileA = document.getElementById('tDuelFileA');
    const fileB = document.getElementById('tDuelFileB');
    const imgA = document.getElementById('tDuelImgA');
    const imgB = document.getElementById('tDuelImgB');
    const exifA = document.getElementById('tDuelExifA');
    const exifB = document.getElementById('tDuelExifB');

    if (state.photoA) {
      if (fileA) fileA.textContent = state.photoA.file_name || state.photoA.fileName || 'Candidate A';
      _bindDuelSlotImage(imgA, state.photoA, 'A');
      if (exifA) exifA.textContent = state.photoA.exifSummary || '';
    }
    if (state.photoB) {
      if (fileB) fileB.textContent = state.photoB.file_name || state.photoB.fileName || 'Candidate B';
      _bindDuelSlotImage(imgB, state.photoB, 'B');
      if (exifB) exifB.textContent = state.photoB.exifSummary || '';
    }
    resetZoomAndPan();
  }

  function _getSlotMetrics(paneEl, imgEl, photo) {
    const rect = paneEl ? paneEl.getBoundingClientRect() : null;
    const pw = Math.max(120, (rect && rect.width) || 300);
    const ph = Math.max(120, (rect && rect.height) || 300);
    let origW = Number(photo?._loadedNaturalW) || (imgEl && imgEl.naturalWidth > 420 ? imgEl.naturalWidth : 0);
    let origH = Number(photo?._loadedNaturalH) || (imgEl && imgEl.naturalHeight > 420 ? imgEl.naturalHeight : 0);
    if (origW <= 0 || origH <= 0) {
      let bw = Number(photo?.width) || (imgEl && imgEl.naturalWidth) || 1600;
      let bh = Number(photo?.height) || (imgEl && imgEl.naturalHeight) || 1200;
      if (Math.abs(Number(photo?.rotation || 0)) % 180 === 90) { const t = bw; bw = bh; bh = t; }
      origW = bw;
      origH = bh;
    }
    const isCssRot90 = Boolean(imgEl && imgEl.dataset.unbakedSource === '1' && Math.abs(Number(photo?.rotation || 0)) % 180 === 90);
    const fitScale = isCssRot90 ? Math.min(pw / origH, ph / origW) : Math.min(pw / origW, ph / origH);
    const fitW = Math.max(1, origW * fitScale);
    const fitH = Math.max(1, origH * fitScale);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const fitRatio = Math.max(0.02, fitScale * dpr);
    const oneToOneScale = fitRatio < 0.92 ? (1.0 / fitRatio) : (2.0 / fitRatio);
    const maxScale = Math.max(MAX_ZOOM, 3.0 / fitRatio);
    return { pw, ph, fitW, fitH, fitRatio, oneToOneScale, maxScale };
  }

  /**
   * 正規化座標（normX, normY: -0.5〜+0.5）と倍率（scale）を各ペインの実ピクセルへ反映する
   */
  function _applyTransforms() {
    const paneA = document.getElementById('tDuelPaneA');
    const paneB = document.getElementById('tDuelPaneB');
    const imgA = document.getElementById('tDuelImgA');
    const imgB = document.getElementById('tDuelImgB');
    const badgeA = document.getElementById('tDuelZoomBadgeA');
    const badgeB = document.getElementById('tDuelZoomBadgeB');

    if (paneA && imgA) {
      const mA = _getSlotMetrics(paneA, imgA, state.photoA);
      const txA = state.transformA.normX * mA.pw;
      const tyA = state.transformA.normY * mA.ph;
      imgA.style.width = `${Math.round(mA.fitW * state.transformA.scale)}px`;
      imgA.style.height = `${Math.round(mA.fitH * state.transformA.scale)}px`;
      global.TetheractTouchUI?.applyPhotoCssAdjustmentsToElement?.(imgA, state.photoA);
      const rotA = imgA.style.transform || '';
      imgA.style.transform = `translate3d(${txA.toFixed(1)}px, ${tyA.toFixed(1)}px, 0)${rotA ? ' ' + rotA : ''}`;
      if (badgeA) badgeA.textContent = `${Math.max(1, Math.round(mA.fitRatio * state.transformA.scale * 100))}%`;
    }

    if (paneB && imgB) {
      const mB = _getSlotMetrics(paneB, imgB, state.photoB);
      const txB = state.transformB.normX * mB.pw;
      const tyB = state.transformB.normY * mB.ph;
      imgB.style.width = `${Math.round(mB.fitW * state.transformB.scale)}px`;
      imgB.style.height = `${Math.round(mB.fitH * state.transformB.scale)}px`;
      global.TetheractTouchUI?.applyPhotoCssAdjustmentsToElement?.(imgB, state.photoB);
      const rotB = imgB.style.transform || '';
      imgB.style.transform = `translate3d(${txB.toFixed(1)}px, ${tyB.toFixed(1)}px, 0)${rotB ? ' ' + rotB : ''}`;
      if (badgeB) badgeB.textContent = `${Math.max(1, Math.round(mB.fitRatio * state.transformB.scale * 100))}%`;
    }
  }

  /**
   * 片方のペインで行われたズーム・パン変更を、同期モードに応じて両方または単一ペインへ適用する
   */
  function _updateSlotTransform(slot, nextScale, nextNormX, nextNormY) {
    const paneEl = document.getElementById(slot === 'A' ? 'tDuelPaneA' : 'tDuelPaneB');
    const imgEl = document.getElementById(slot === 'A' ? 'tDuelImgA' : 'tDuelImgB');
    const m = _getSlotMetrics(paneEl, imgEl, slot === 'A' ? state.photoA : state.photoB);
    const clampedScale = Math.max(MIN_ZOOM, Math.min(m.maxScale, nextScale));
    const maxOffsetNorm = clampedScale <= 1.02 ? 0 : (clampedScale - 1) * 0.45;
    const clampedNormX = Math.max(-maxOffsetNorm, Math.min(maxOffsetNorm, nextNormX));
    const clampedNormY = Math.max(-maxOffsetNorm, Math.min(maxOffsetNorm, nextNormY));

    const updated = {
      scale: clampedScale,
      normX: clampedNormX,
      normY: clampedNormY,
    };

    if (state.syncZoom) {
      state.transformA = { ...updated };
      state.transformB = { ...updated };
    } else if (slot === 'A') {
      state.transformA = { ...updated };
    } else {
      state.transformB = { ...updated };
    }

    _applyTransforms();
  }

  function resetZoomAndPan() {
    state.transformA = { scale: 1, normX: 0, normY: 0 };
    state.transformB = { scale: 1, normX: 0, normY: 0 };
    _applyTransforms();
  }

  /**
   * 各ペインへのピンチズーム・1本指パン・ダブルタップ2.5xズーム登録
   */
  function _bindPaneTouchZoom(paneEl, slot) {
    let mode = 'idle'; // 'idle' | 'pan' | 'pinch'
    let startX = 0;
    let startY = 0;
    let startNormX = 0;
    let startNormY = 0;
    let startDistance = 0;
    let startScale = 1;
    let lastTapTime = 0;

    const getTouchDist = (t1, t2) => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.hypot(dx, dy);
    };

    paneEl.addEventListener(
      'touchstart',
      (e) => {
        const currentTf = slot === 'A' ? state.transformA : state.transformB;

        if (e.touches.length === 2) {
          mode = 'pinch';
          startDistance = getTouchDist(e.touches[0], e.touches[1]);
          startScale = currentTf.scale;
          startNormX = currentTf.normX;
          startNormY = currentTf.normY;
          return;
        }

        if (e.touches.length === 1) {
          const now = Date.now();
          if (now - lastTapTime < 280) {
            // ダブルタップで 全体フィット ⇄ 原本100%等倍 をトグル
            const imgEl = document.getElementById(slot === 'A' ? 'tDuelImgA' : 'tDuelImgB');
            const m = _getSlotMetrics(paneEl, imgEl, slot === 'A' ? state.photoA : state.photoB);
            const targetScale = currentTf.scale > 1.08 ? 1.0 : m.oneToOneScale;
            _updateSlotTransform(slot, targetScale, 0, 0);
            lastTapTime = 0;
            mode = 'idle';
            return;
          }
          lastTapTime = now;

          mode = 'pan';
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          startNormX = currentTf.normX;
          startNormY = currentTf.normY;
          startScale = currentTf.scale;
        }
      },
      { passive: true }
    );

    paneEl.addEventListener(
      'touchmove',
      (e) => {
        if (mode === 'idle') return;
        if (e.cancelable) e.preventDefault();

        const rect = paneEl.getBoundingClientRect();
        const w = Math.max(1, rect.width);
        const h = Math.max(1, rect.height);

        if (mode === 'pinch' && e.touches.length === 2) {
          const dist = getTouchDist(e.touches[0], e.touches[1]);
          if (startDistance > 8) {
            const nextScale = startScale * (dist / startDistance);
            _updateSlotTransform(slot, nextScale, startNormX, startNormY);
          }
        } else if (mode === 'pan' && e.touches.length === 1) {
          const dx = e.touches[0].clientX - startX;
          const dy = e.touches[0].clientY - startY;
          const nextNormX = startNormX + dx / w;
          const nextNormY = startNormY + dy / h;
          _updateSlotTransform(slot, startScale, nextNormX, nextNormY);
        }
      },
      { passive: false }
    );

    const endTouch = (e) => {
      if (!e.touches || e.touches.length === 0) {
        mode = 'idle';
      }
    };

    paneEl.addEventListener('touchend', endTouch, { passive: true });
    paneEl.addEventListener('touchcancel', endTouch, { passive: true });

    // マウスホイール＆ドラッグ（タブレット・PCハイブリッド操作）対応
    paneEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const currentTf = slot === 'A' ? state.transformA : state.transformB;
        const delta = e.deltaY < 0 ? 0.25 : -0.25;
        _updateSlotTransform(slot, currentTf.scale + delta, currentTf.normX, currentTf.normY);
      },
      { passive: false }
    );
  }

  function _bindDuelEvents(modal) {
    const closeBtn = modal.querySelector('#tDuelTopCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        closeDuel();
        if (global.TetheractTouchUI && global.TetheractTouchUI.thumbBar) {
          global.TetheractTouchUI.thumbBar.setMode('cull');
        }
      });
    }

    const portraitModeBtn = modal.querySelector('#tDuelPortraitModeBtn');
    if (portraitModeBtn) {
      portraitModeBtn.addEventListener('click', () => {
        state.portraitPreferFlip = !state.portraitPreferFlip;
        const labelEl = modal.querySelector('#tDuelPortraitModeLabel');
        if (labelEl) {
          labelEl.textContent = state.portraitPreferFlip ? 'A/Bフリップ' : '上下分割';
        }
        resolveDuelLayout();
      });
    }

    const flipSwitcher = modal.querySelector('#tDuelFlipSwitcher');
    if (flipSwitcher) {
      flipSwitcher.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-flip-target]');
        if (!btn) return;
        const targetSlot = btn.getAttribute('data-flip-target');
        state.flipActiveSlot = targetSlot === 'B' ? 'B' : 'A';
        modal.setAttribute('data-duel-flip-slot', state.flipActiveSlot);
        flipSwitcher.querySelectorAll('[data-flip-target]').forEach((el) => {
          el.classList.toggle('is-active', el.getAttribute('data-flip-target') === state.flipActiveSlot);
        });
      });
    }

    const paneA = modal.querySelector('#tDuelPaneA');
    const paneB = modal.querySelector('#tDuelPaneB');
    if (paneA) _bindPaneTouchZoom(paneA, 'A');
    if (paneB) _bindPaneTouchZoom(paneB, 'B');

    global.addEventListener('resize', () => {
      if (state.isOpen) {
        resolveDuelLayout();
        _applyTransforms();
      }
    });
  }

  /**
   * 2枚比較ビューを開く
   */
  function openDuel(candidates) {
    const modal = _ensureDuelModal();
    const list =
      Array.isArray(candidates) && candidates.length >= 2
        ? candidates.slice()
        : _collectDefaultCandidates();

    state.photoA = list[0] || { id: 'A', file_name: 'Photo A', src: '' };
    state.photoB = list[1] || { id: 'B', file_name: 'Photo B', src: '' };
    state.pool = list.slice(2);
    state.isOpen = true;

    resolveDuelLayout();
    _renderCandidates();
    modal.style.display = 'flex';

    if (global.TetheractTouchUI && global.TetheractTouchUI.thumbBar) {
      global.TetheractTouchUI.thumbBar.setMode('duel');
    }
  }

  function closeDuel() {
    state.isOpen = false;
    const modal = document.getElementById('tTouchDuelModal');
    if (modal) {
      modal.style.display = 'none';
    }
  }

  /**
   * AまたはBを残す（勝ち抜きプールに残りがある場合は敗者側スロットへ次の写真を投入）
   */
  function keepCandidate(winnerSlot) {
    const keepA = winnerSlot === 'A';
    const winner = keepA ? state.photoA : state.photoB;

    if (typeof state.onWinnerSelected === 'function' && winner) {
      state.onWinnerSelected(winner, winnerSlot);
    }
    global.dispatchEvent(
      new CustomEvent('tetheract:duel-keep', {
        detail: { slot: winnerSlot, winner },
      })
    );

    if (state.pool.length > 0) {
      const nextChallenger = state.pool.shift();
      if (keepA) {
        state.photoB = nextChallenger;
      } else {
        state.photoA = nextChallenger;
      }
      _renderCandidates();
    } else {
      closeDuel();
      if (global.TetheractTouchUI && global.TetheractTouchUI.thumbBar) {
        global.TetheractTouchUI.thumbBar.setMode('cull');
      }
    }
  }

  /**
   * AとBの位置を入れ替える
   */
  function swapCandidates() {
    const tmp = state.photoA;
    state.photoA = state.photoB;
    state.photoB = tmp;
    _renderCandidates();
  }

  /**
   * 同期ズームのON/OFFを切り替える
   */
  function setSyncZoom(enabled) {
    state.syncZoom = Boolean(enabled);
    const label = document.getElementById('tDuelSyncStatusText');
    if (label) {
      label.textContent = state.syncZoom ? '同期ズーム ON' : '個別ズーム';
    }
    if (state.syncZoom) {
      state.transformB = { ...state.transformA };
      _applyTransforms();
    }
  }

  const duelApi = {
    openDuel,
    closeDuel,
    keepCandidate,
    swapCandidates,
    setSyncZoom,
    resetZoomAndPan,
    resolveDuelLayout,
    getState: () => ({ ...state }),
  };

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, {
    openDuel,
    closeDuel,
    duel: duelApi,
  });
})(window);
