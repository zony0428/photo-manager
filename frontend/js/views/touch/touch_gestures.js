/**
 * Tetheract Touch Gestures Controller (Layer 3)
 * PC向けの極小ボタン群（[×]・チェックボックス・[+][-]・細スライダー）を廃止し、
 * 1) ビューア全面スワイプ（下＝縮小透過クローズ / 上＝EXIF・ヒストグラムシート / 左右＝前後移動）
 * 2) グリッド長押し（350ms）＋なぞり連続選択（elementFromPoint）
 * 3) フィルタ行（44px高）タップ＝含む[+]/AND ＆ 左スワイプ/長押し＝除外[-]/NOT
 * 4) 画像調整のキャンバス全面スクラブ（中央透過HUD表示・指を離すとHUD自動消去）
 * に置き換えるジェスチャー制御モジュール。
 */
(function (global) {
  'use strict';

  const LONG_PRESS_MS = 350;
  const FILTER_SWIPE_EXCLUDE_PX = -54;

  // 非破壊画像調整項目の仕様定義
  const ADJUST_SPECS = {
    exposure: { key: 'exposure', label: '露光量', shortLabel: 'EV', min: -3.0, max: 3.0, step: 0.1, defaultVal: 0.0, sensitivity: 0.015, format: (v) => `EV ${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
    contrast: { key: 'contrast', label: 'コントラスト', shortLabel: 'Contrast', min: -100, max: 100, step: 1, defaultVal: 0, sensitivity: 0.45, format: (v) => `Contrast ${v >= 0 ? '+' : ''}${Math.round(v)}` },
    saturation: { key: 'saturation', label: '彩度', shortLabel: 'Saturation', min: -100, max: 100, step: 1, defaultVal: 0, sensitivity: 0.45, format: (v) => `Saturation ${v >= 0 ? '+' : ''}${Math.round(v)}` },
    tilt: { key: 'tilt', label: '水平傾き', shortLabel: 'Tilt', min: -15.0, max: 15.0, step: 0.1, defaultVal: 0.0, sensitivity: 0.06, format: (v) => `Tilt ${v >= 0 ? '+' : ''}${v.toFixed(1)}°` },
  };

  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const adjustState = {
    enabled: false,
    activeParam: 'exposure',
    values: { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0 },
    bakedValues: { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0, rotation: 0 },
    onChange: null,
  };

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

  /**
   * 4. 画像調整のキャンバス全面スクラブ (`bindCanvasScrubAdjust`)
   * - 細いスライダーつまみを廃止し、画像調整モード中は写真のどこでも左右に指を滑らせるだけで
   *   選択中の項目（露光量 EV / コントラスト / 彩度 / 水平傾き）を微調整する。
   * - ドラッグ中は画面中央に現在値HUD（例: `EV +0.7`）を透過表示し、指を離すとHUDが消えて写真全体を確認できる。
   */
  function _ensureScrubHud(stageEl) {
    let hud = document.getElementById('tCanvasScrubHud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'tCanvasScrubHud';
      hud.className = 't-canvas-scrub-hud';
      hud.style.display = 'none';
      hud.innerHTML = `
        <div class="t-scrub-hud-header">
          <span class="t-scrub-hud-label" id="tScrubHudLabel">露光量</span>
          <span class="t-scrub-hud-value" id="tScrubHudValue">EV +0.0</span>
        </div>
        <div class="t-scrub-hud-track">
          <div class="t-scrub-hud-center-tick"></div>
          <div class="t-scrub-hud-fill" id="tScrubHudFill"></div>
        </div>
      `;
      (stageEl || document.body).appendChild(hud);
    }
    return hud;
  }

  function _renderScrubHud(spec, val) {
    const hud = _ensureScrubHud(document.getElementById('mViewerStage'));
    const labelEl = hud.querySelector('#tScrubHudLabel');
    const valEl = hud.querySelector('#tScrubHudValue');
    const fillEl = hud.querySelector('#tScrubHudFill');

    if (labelEl) labelEl.textContent = spec.label;
    if (valEl) valEl.textContent = spec.format(val);
    if (fillEl) {
      const span = spec.max - spec.min;
      const ratio = ((val - spec.min) / span) * 100;
      const clamped = Math.max(0, Math.min(100, ratio));
      const left = Math.min(50, clamped);
      const width = Math.abs(clamped - 50);
      fillEl.style.left = `${left}%`;
      fillEl.style.width = `${width}%`;
    }

    hud.style.display = 'flex';
    hud.classList.add('is-visible');
  }

  function _hideScrubHud() {
    const hud = document.getElementById('tCanvasScrubHud');
    if (!hud) return;
    hud.classList.remove('is-visible');
    setTimeout(() => {
      if (!hud.classList.contains('is-visible')) {
        hud.style.display = 'none';
      }
    }, 150);
  }

  /**
   * 調整パラメータの視覚プレビュー（CSS filter & rotate）を対象画像にリアルタイム反映する
   */
  function _computeCssFilterAndTransform(cur, baked, isUnbaked) {
    const effEv = isUnbaked ? (cur.exposure || 0) : (cur.exposure || 0) - (baked.exposure || 0);
    const effCt = isUnbaked ? (cur.contrast || 0) : (cur.contrast || 0) - (baked.contrast || 0);
    const effSat = isUnbaked ? (cur.saturation || 0) : (cur.saturation || 0) - (baked.saturation || 0);
    const effDeg = isUnbaked
      ? (baked.rotation || 0) + (cur.tilt || 0)
      : (cur.tilt || 0) - (baked.tilt || 0);

    let filterStr = '';
    if (Math.abs(effEv) > 0.005 || Math.abs(effCt) > 0.1 || Math.abs(effSat) > 0.1) {
      const bFactor = Math.max(0.1, Math.min(4.0, Math.pow(2.0, effEv / 2.2))).toFixed(4);
      const cFactor = Math.max(0.1, Math.min(2.5, 1.0 + (effCt / 100.0) * 0.75)).toFixed(3);
      const sFactor = Math.max(0.0, Math.min(3.0, 1.0 + effSat / 100.0)).toFixed(3);
      filterStr = `brightness(${bFactor}) contrast(${cFactor}) saturate(${sFactor})`;
    }
    const transformStr = Math.abs(effDeg) > 0.01 ? `rotate(${effDeg.toFixed(2)}deg)` : '';
    return { filterStr, transformStr };
  }

  function _applyLivePreviewToImage(imgEl) {
    const target = imgEl || document.getElementById('mViewerImg');
    if (!target) return;
    const isUnbaked = target.dataset.unbakedSource === '1';
    const { filterStr, transformStr } = _computeCssFilterAndTransform(adjustState.values, adjustState.bakedValues, isUnbaked);
    target.style.filter = filterStr;
    target.style.transform = transformStr;
  }

  function applyPhotoCssAdjustmentsToElement(imgEl, photo) {
    if (!imgEl || !photo) return;
    if (!photo._bakedAdjust) {
      photo._bakedAdjust = {
        brightness: Number(photo.brightness || 0),
        contrast: Number(photo.contrast || 0),
        saturation: Number(photo.saturation || 0),
        fine_angle: Number(photo.fine_angle || 0),
        rotation: Number(photo.rotation || 0),
      };
    }
    const cur = {
      exposure: Number(photo.brightness || 0) / 10.0,
      contrast: Number(photo.contrast || 0),
      saturation: Number(photo.saturation || 0),
      tilt: Number(photo.fine_angle || 0),
    };
    const baked = {
      exposure: Number(photo._bakedAdjust.brightness || 0) / 10.0,
      contrast: Number(photo._bakedAdjust.contrast || 0),
      saturation: Number(photo._bakedAdjust.saturation || 0),
      tilt: Number(photo._bakedAdjust.fine_angle || 0),
      rotation: Number(photo.rotation ?? photo._bakedAdjust.rotation ?? 0),
    };
    const isUnbaked = imgEl.dataset.unbakedSource === '1';
    const { filterStr, transformStr } = _computeCssFilterAndTransform(cur, baked, isUnbaked);
    imgEl.style.filter = filterStr;
    imgEl.style.transform = transformStr;
  }

  function bindCanvasScrubAdjust(stageElOrSelector, callbacks = {}) {
    const stageEl =
      typeof stageElOrSelector === 'string'
        ? document.querySelector(stageElOrSelector)
        : stageElOrSelector || document.getElementById('mViewerStage');
    if (!stageEl || stageEl.dataset.touchCanvasScrubBound === '1') return;
    stageEl.dataset.touchCanvasScrubBound = '1';

    if (callbacks.onChange) adjustState.onChange = callbacks.onChange;

    let scrubbing = false;
    let startX = 0;
    let initialVal = 0;

    const onStart = (clientX) => {
      if (!adjustState.enabled) return;
      const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
      scrubbing = true;
      startX = clientX;
      initialVal = Number(adjustState.values[spec.key] || 0);
      _renderScrubHud(spec, initialVal);
    };

    const onMove = (clientX) => {
      if (!scrubbing || !adjustState.enabled) return;
      const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
      const dx = clientX - startX;
      const rawNext = initialVal + dx * spec.sensitivity;
      const stepped = Math.round(rawNext / spec.step) * spec.step;
      const clamped = Math.max(spec.min, Math.min(spec.max, Number(stepped.toFixed(2))));

      adjustState.values[spec.key] = clamped;
      _renderScrubHud(spec, clamped);
      _applyLivePreviewToImage(callbacks.imageEl);

      if (typeof adjustState.onChange === 'function') {
        adjustState.onChange({
          param: spec.key,
          value: clamped,
          formatted: spec.format(clamped),
          values: { ...adjustState.values },
        });
      }
      global.dispatchEvent(
        new CustomEvent('tetheract:canvas-scrub-change', {
          detail: {
            param: spec.key,
            value: clamped,
            formatted: spec.format(clamped),
            values: { ...adjustState.values },
          },
        })
      );
    };

    const onEnd = () => {
      if (!scrubbing) return;
      scrubbing = false;
      _hideScrubHud();
    };

    stageEl.addEventListener(
      'touchstart',
      (e) => {
        if (!adjustState.enabled || e.touches.length !== 1) return;
        onStart(e.touches[0].clientX);
      },
      { passive: true }
    );

    stageEl.addEventListener(
      'touchmove',
      (e) => {
        if (!scrubbing || !adjustState.enabled || e.touches.length !== 1) return;
        if (e.cancelable) e.preventDefault();
        onMove(e.touches[0].clientX);
      },
      { passive: false }
    );

    stageEl.addEventListener('touchend', onEnd, { passive: true });
    stageEl.addEventListener('touchcancel', onEnd, { passive: true });

    // タブレットでのスタイラス / マウスドラッグにも共通対応
    stageEl.addEventListener('pointerdown', (e) => {
      if (!adjustState.enabled || e.pointerType === 'touch') return;
      onStart(e.clientX);
    });
    stageEl.addEventListener('pointermove', (e) => {
      if (!scrubbing || !adjustState.enabled || e.pointerType === 'touch') return;
      onMove(e.clientX);
    });
    stageEl.addEventListener('pointerup', onEnd);
  }

  function setAdjustModeEnabled(enabled, initialParam) {
    adjustState.enabled = Boolean(enabled);
    if (initialParam && ADJUST_SPECS[initialParam]) adjustState.activeParam = initialParam;
    if (!adjustState.enabled) _hideScrubHud();
  }

  function setActiveAdjustParam(paramKey) {
    if (!ADJUST_SPECS[paramKey]) return;
    adjustState.activeParam = paramKey;
    const spec = ADJUST_SPECS[paramKey];
    _renderScrubHud(spec, Number(adjustState.values[paramKey] || 0));
    setTimeout(_hideScrubHud, 950);
  }

  function resetAdjustValues() {
    adjustState.values = { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0 };
    _applyLivePreviewToImage();
    const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
    _renderScrubHud(spec, 0);
    setTimeout(_hideScrubHud, 700);
    global.dispatchEvent(
      new CustomEvent('tetheract:canvas-scrub-change', {
        detail: { param: spec.key, value: 0, formatted: spec.format(0), values: { ...adjustState.values } },
      })
    );
  }

  function getAdjustValues() {
    return { ...adjustState.values };
  }

  function loadPhotoAdjustValues(photo) {
    if (!photo) {
      adjustState.values = { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0 };
      adjustState.bakedValues = { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0, rotation: 0 };
    } else {
      if (!photo._bakedAdjust) {
        photo._bakedAdjust = {
          brightness: Number(photo.brightness || 0),
          contrast: Number(photo.contrast || 0),
          saturation: Number(photo.saturation || 0),
          fine_angle: Number(photo.fine_angle || 0),
          rotation: Number(photo.rotation || 0),
        };
      }
      const b = Number(photo.brightness || 0);
      adjustState.values = {
        exposure: Number((b / 10.0).toFixed(2)),
        contrast: Math.round(Number(photo.contrast || 0)),
        saturation: Math.round(Number(photo.saturation || 0)),
        tilt: Number(Number(photo.fine_angle || 0).toFixed(2)),
      };
      adjustState.bakedValues = {
        exposure: Number((Number(photo._bakedAdjust.brightness || 0) / 10.0).toFixed(2)),
        contrast: Math.round(Number(photo._bakedAdjust.contrast || 0)),
        saturation: Math.round(Number(photo._bakedAdjust.saturation || 0)),
        tilt: Number(Number(photo._bakedAdjust.fine_angle || 0).toFixed(2)),
        rotation: Number(photo.rotation ?? photo._bakedAdjust.rotation ?? 0),
      };
    }
    _applyLivePreviewToImage();
  }

  function initTouchGestures() {
    // ビューアのピンチ拡大・ダブルタップ拡大・上下左右スワイプ・シングルタップ没入切替は
    // mobile.js の setupViewerTouchGestures() に一元化（二重発火・ズーム解除競合を防止）
    bindGridDragSelect('#mPhotoGrid');
    bindGridPinchZoom('#mPhotoGrid');
    bindFilterRowGestures('.m-drawer-body');
    bindFilterRowGestures('#tPerspectivePanel_tags');
    bindCanvasScrubAdjust('#mViewerStage');
  }

  const gesturesApi = {
    ADJUST_SPECS, initTouchGestures, bindGridDragSelect,
    bindGridPinchZoom, bindFilterRowGestures, bindCanvasScrubAdjust,
    setAdjustModeEnabled, setActiveAdjustParam, resetAdjustValues, getAdjustValues,
    loadPhotoAdjustValues, applyPhotoCssAdjustmentsToElement,
  };

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, gesturesApi, { gestures: gesturesApi });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTouchGestures);
  } else {
    initTouchGestures();
  }
})(window);
