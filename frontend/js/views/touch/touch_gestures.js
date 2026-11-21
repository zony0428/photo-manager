/**
 * Tetheract Touch Gestures Controller (Layer 3)
 * PC向けの極小ボタン群（[×]・チェックボックス・[+][-]・細スライダー）を廃止し、
 * 1) グリッド長押し（350ms）＋なぞり連続選択（elementFromPoint）
 * 2) グリッドの2本指ピンチイン・ピンチアウトによる列数変更
 * 3) フィルタ行（44px高）タップ＝含む[+]/AND ＆ 左スワイプ/長押し＝除外[-]/NOT
 * に置き換えるジェスチャー制御モジュール（非破壊調整・ガイドラインは touch_adjust.js に分離）。
 */
(function (global) {
  'use strict';

  const LONG_PRESS_MS = 350;
  const FILTER_SWIPE_EXCLUDE_PX = -54;

  /**
   * 1. グリッドの長押し＋なぞり連続選択 (`bindGridDragSelect`)
   * - 写真カードを約350ms長押しすると複数選択モードに入り、
   *   指を離さずにそのまま上下左右になぞったカード（`document.elementFromPoint` で検出）を連続で選択/解除する。
   */
  function bindGridDragSelect(gridElOrSelector, callbacks = {}) {
    const gridEl =
      typeof gridElOrSelector === 'string'
        ? document.querySelector(gridElOrSelector)
        : gridElOrSelector || document.getElementById('mPhotoGrid');
    if (!gridEl || gridEl.dataset.touchDragSelectBound === '1') return;
    gridEl.dataset.touchDragSelectBound = '1';

    let longPressTimer = null;
    let isDragSelecting = false;
    let targetSelectValue = true; // true: 連続選択, false: 連続解除
    let startX = 0;
    let startY = 0;
    let lastTouchedPhotoId = null;
    let rafDragPending = false;
    let latestTouchX = 0;
    let latestTouchY = 0;
    const visitedInStroke = new Set();

    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const applyCardSelection = (cardEl) => {
      if (!cardEl) return;
      const photoId = cardEl.getAttribute('data-id') || cardEl.getAttribute('data-photo-id');
      if (!photoId || photoId === lastTouchedPhotoId || visitedInStroke.has(photoId)) return;
      lastTouchedPhotoId = photoId;
      visitedInStroke.add(photoId);

      cardEl.classList.toggle('selected', targetSelectValue);
      cardEl.classList.add('t-drag-select-pulse');
      setTimeout(() => cardEl.classList.remove('t-drag-select-pulse'), 180);

      if (typeof callbacks.onTogglePhotoSelect === 'function') {
        callbacks.onTogglePhotoSelect(photoId, targetSelectValue, cardEl);
      }
      global.dispatchEvent(
        new CustomEvent('tetheract:grid-drag-select', {
          detail: { photoId, selected: targetSelectValue },
        })
      );
    };

    // 長押し成立中のみ動的にアタッチする non-passive touchmove ハンドラ（通常スクロール時のGPUコンポジタ阻害を完全防止）
    const activeDragMoveHandler = (e) => {
      if (!isDragSelecting) return;
      if (e.cancelable) e.preventDefault();
      const touch = e.touches[0];
      if (!touch) return;
      latestTouchX = touch.clientX;
      latestTouchY = touch.clientY;
      if (rafDragPending) return;
      rafDragPending = true;
      requestAnimationFrame(() => {
        rafDragPending = false;
        if (!isDragSelecting) return;
        const hitEl = document.elementFromPoint(latestTouchX, latestTouchY);
        if (!hitEl) return;
        const card = hitEl.closest('.m-card, .photo-card, [data-photo-id]');
        if (card && gridEl.contains(card)) {
          applyCardSelection(card);
        }
      });
    };

    const detachActiveDragMove = () => {
      gridEl.removeEventListener('touchmove', activeDragMoveHandler, { passive: false });
    };

    gridEl.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) {
          clearTimer();
          if (isDragSelecting) endDragSelect();
          return;
        }
        const card = e.target.closest('.m-card, .photo-card, [data-photo-id]');
        if (!card) return;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        lastTouchedPhotoId = null;
        visitedInStroke.clear();

        clearTimer();
        longPressTimer = setTimeout(() => {
          isDragSelecting = true;
          global.__tetheractJustDragSelectedUntil = Date.now() + 450;
          gridEl.addEventListener('touchmove', activeDragMoveHandler, { passive: false });
          document.body.classList.add('m-select-mode', 't-drag-selecting');

          // 最初のカードが未選択なら「連続選択」、すでに選択済みなら「連続解除」モードにする
          targetSelectValue = !card.classList.contains('selected');

          if (typeof callbacks.onEnterSelectMode === 'function') {
            callbacks.onEnterSelectMode();
          }
          if (global.TetheractTouchUI && global.TetheractTouchUI.thumbBar) {
            global.TetheractTouchUI.thumbBar.setMode('batch');
          }

          applyCardSelection(card);
        }, LONG_PRESS_MS);
      },
      { passive: true }
    );

    // 通常スクロール時は passive: true で長押しタイマー解除のみ行い、WebView の GPU スクロールを一切ブロックしない
    gridEl.addEventListener(
      'touchmove',
      (e) => {
        if (isDragSelecting || !longPressTimer) return;
        if (e.touches.length !== 1) {
          clearTimer();
          return;
        }
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dx > 10 || dy > 10) {
          clearTimer();
        }
      },
      { passive: true }
    );

    function endDragSelect() {
      clearTimer();
      detachActiveDragMove();
      if (isDragSelecting) {
        global.__tetheractJustDragSelectedUntil = Date.now() + 450;
        isDragSelecting = false;
        lastTouchedPhotoId = null;
        visitedInStroke.clear();
        setTimeout(() => {
          document.body.classList.remove('t-drag-selecting');
        }, 80);
        if (typeof callbacks.onFinishDragSelect === 'function') {
          callbacks.onFinishDragSelect();
        }
      }
    }

    gridEl.addEventListener('touchend', endDragSelect, { passive: true });
    gridEl.addEventListener('touchcancel', endDragSelect, { passive: true });
    gridEl.addEventListener('contextmenu', (e) => { if (e.target.closest('.m-card')) e.preventDefault(); });
  }

  /**
   * 2b. グリッドの2本指ピンチイン・ピンチアウトによる列数（サムネイルサイズ）変更 (`bindGridPinchZoom`)
   * - ピンチアウト（2本指を広げる）: サムネイルを大きく（列数を -1）
   * - ピンチイン（2本指をつまむ）  : サムネイルを小さく一覧性UP（列数を +1）
   * - 全て passive: true で処理し、1本指スクロールのGPUコンポジタ処理を一切阻害しない
   */
  function bindGridPinchZoom(gridElOrSelector) {
    const gridEl =
      typeof gridElOrSelector === 'string'
        ? document.querySelector(gridElOrSelector)
        : gridElOrSelector || document.getElementById('mPhotoGrid');
    if (!gridEl || gridEl.dataset.touchPinchBound === '1') return;
    gridEl.dataset.touchPinchBound = '1';

    let isPinching = false;
    let startDist = 0;

    gridEl.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          startDist = Math.hypot(dx, dy);
          isPinching = startDist > 24;
        } else {
          isPinching = false;
        }
      },
      { passive: true }
    );

    gridEl.addEventListener(
      'touchmove',
      (e) => {
        if (!isPinching || e.touches.length !== 2) return;
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        if (startDist <= 24 || dist <= 12) return;

        const ratio = dist / startDist;
        let deltaCols = 0;
        if (ratio >= 1.24) {
          // ピンチアウト（広げる）＝写真を大きく＝列数を減らす
          deltaCols = -1;
        } else if (ratio <= 0.78) {
          // ピンチイン（狭める）＝写真を小さく＝列数を増やす
          deltaCols = 1;
        }

        if (deltaCols !== 0) {
          startDist = dist;
          const midX = (t0.clientX + t1.clientX) * 0.5;
          const midY = (t0.clientY + t1.clientY) * 0.5;
          global.__tetheractJustPinchedUntil = Date.now() + 280;
          if (typeof global.__stepMobileGridCols === 'function') {
            global.__stepMobileGridCols(deltaCols, midX, midY);
          }
          global.dispatchEvent(
            new CustomEvent('tetheract:grid-pinch-cols', {
              detail: { deltaCols, midX, midY },
            })
          );
        }
      },
      { passive: true }
    );

    const endPinch = (e) => {
      if (!e.touches || e.touches.length < 2) {
        isPinching = false;
        startDist = 0;
      }
    };

    gridEl.addEventListener('touchend', endPinch, { passive: true });
    gridEl.addEventListener('touchcancel', endPinch, { passive: true });
  }

  /**
   * 3. フィルタ行のタップ `[+]` ＆ 左スワイプ `[-]` (`bindFilterRowGestures`)
   * - タグ・機材・場所ツリーの極小 [+]/[-] ボタンを廃止し、
   *   行全体（高さ44px以上）のタップ＝「含む [+] (AND)」、左スワイプ（または長押し）＝「除外 [-] (NOT)」にする。
   */
  function bindFilterRowGestures(containerElOrSelector, callbacks = {}) {
    const container =
      typeof containerElOrSelector === 'string'
        ? document.querySelector(containerElOrSelector)
        : containerElOrSelector || document.querySelector('.m-drawer-body');
    if (!container || container.dataset.touchFilterGestureBound === '1') return;
    container.dataset.touchFilterGestureBound = '1';

    let activeRow = null;
    let startX = 0;
    let startY = 0;
    let deltaX = 0;
    let swiping = false;
    let longPressTimer = null;

    const clearTimer = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const ensureSwipeIndicator = (rowEl) => {
      let badge = rowEl.querySelector('.t-swipe-exclude-indicator');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 't-swipe-exclude-indicator';
        badge.innerHTML = `
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          <span>除外 (NOT)</span>
        `;
        rowEl.appendChild(badge);
      }
      return badge;
    };

    const triggerExcludeOnRow = (rowEl) => {
      if (!rowEl) return;
      const val = (rowEl.getAttribute('data-tag') || rowEl.getAttribute('data-filter-value') || '').trim();
      if (!val) return;
      rowEl.dataset.justSwiped = '1';
      setTimeout(() => { delete rowEl.dataset.justSwiped; }, 320);

      const isCurrentlyExcluded = rowEl.classList.contains('active-exclude');
      rowEl.classList.remove('active-include');
      rowEl.classList.toggle('active-exclude', !isCurrentlyExcluded);

      if (typeof callbacks.onExclude === 'function') {
        callbacks.onExclude(val, !isCurrentlyExcluded, rowEl);
      }
      global.dispatchEvent(
        new CustomEvent('tetheract:filter-row-exclude', {
          detail: { value: val, excluded: !isCurrentlyExcluded },
        })
      );
    };

    container.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        const row = e.target.closest('.m-filter-item[data-tag], .t-filter-row[data-tag], [data-filter-value]');
        if (!row) return;

        activeRow = row;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        deltaX = 0;
        swiping = false;

        clearTimer();
        longPressTimer = setTimeout(() => {
          if (!swiping && activeRow) {
            triggerExcludeOnRow(activeRow);
          }
        }, LONG_PRESS_MS + 100);
      },
      { passive: true }
    );

    container.addEventListener(
      'touchmove',
      (e) => {
        if (!activeRow || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        if (Math.abs(dy) > 14 && !swiping) {
          clearTimer();
          activeRow = null;
          return;
        }

        if (dx < -10) {
          clearTimer();
          swiping = true;
          deltaX = Math.max(-96, dx);
          ensureSwipeIndicator(activeRow);
          activeRow.classList.add('is-swiping-left');
          activeRow.style.transform = `translateX(${deltaX}px)`;
        }
      },
      { passive: true }
    );

    const endRowTouch = () => {
      clearTimer();
      if (!activeRow) return;
      const row = activeRow;
      activeRow = null;

      row.style.transition = 'transform 0.16s ease-out';
      row.style.transform = '';
      row.classList.remove('is-swiping-left');

      if (swiping && deltaX <= FILTER_SWIPE_EXCLUDE_PX) {
        triggerExcludeOnRow(row);
      }
      swiping = false;
      deltaX = 0;
    };

    container.addEventListener('touchend', endRowTouch, { passive: true });
    container.addEventListener('touchcancel', endRowTouch, { passive: true });
  }

  function initTouchGestures() {
    // ビューアのピンチ拡大・ダブルタップ拡大・上下左右スワイプ・シングルタップ没入切替は
    // mobile.js の setupViewerTouchGestures() に一元化（二重発火・ズーム解除競合を防止）
    bindGridDragSelect('#mPhotoGrid');
    bindGridPinchZoom('#mPhotoGrid');
    bindFilterRowGestures('.m-drawer-body');
    bindFilterRowGestures('#tPerspectivePanel_tags');
  }

  const gesturesApi = {
    initTouchGestures,
    bindGridDragSelect,
    bindGridPinchZoom,
    bindFilterRowGestures,
  };

  const existingUi = global.TetheractTouchUI || {};
  global.TetheractTouchUI = Object.assign(existingUi, gesturesApi, {
    gestures: Object.assign({}, existingUi.gestures || {}, gesturesApi),
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTouchGestures);
  } else {
    initTouchGestures();
  }
})(window);
