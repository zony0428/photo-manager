/**
 * Tetheract Touch Image Adjustment Controller (Layer 3)
 * モバイル版ライトボックス向けの非破壊調整（露光量・コントラスト・彩度・水平傾き）を制御する。
 * - 画面中央を覆うHUDを廃止し、下部ダイヤルストリップ（#tAdjustControlStrip）に数値・±微調整・元画像比較を集約する。
 * - 水平傾きモード時は写真枠内（#mViewerPhotoFrame）に水平・垂直ガイドライン（#tViewerLevelGrid）を重ね、内接自動ズーム付きで傾きプレビューを行う。
 */
(function (global) {
  'use strict';

  const ADJUST_SPECS = {
    exposure: {
      key: 'exposure',
      label: '露光量',
      shortLabel: 'EV',
      min: -3.0,
      max: 3.0,
      step: 0.1,
      defaultVal: 0.0,
      sensitivity: 0.015,
      minLabel: '-3.0',
      zeroLabel: '0',
      maxLabel: '+3.0',
      format: (v) => `${v > 0.005 ? '+' : ''}${v.toFixed(1)} EV`,
    },
    contrast: {
      key: 'contrast',
      label: 'コントラスト',
      shortLabel: 'Contrast',
      min: -100,
      max: 100,
      step: 1,
      defaultVal: 0,
      sensitivity: 0.45,
      minLabel: '-100',
      zeroLabel: '0',
      maxLabel: '+100',
      format: (v) => `${Math.round(v) > 0 ? '+' : ''}${Math.round(v)}`,
    },
    saturation: {
      key: 'saturation',
      label: '彩度',
      shortLabel: 'Saturation',
      min: -100,
      max: 100,
      step: 1,
      defaultVal: 0,
      sensitivity: 0.45,
      minLabel: '-100',
      zeroLabel: '0',
      maxLabel: '+100',
      format: (v) => `${Math.round(v) > 0 ? '+' : ''}${Math.round(v)}`,
    },
    tilt: {
      key: 'tilt',
      label: '水平傾き',
      shortLabel: 'Tilt',
      min: -15.0,
      max: 15.0,
      step: 0.1,
      defaultVal: 0.0,
      sensitivity: 0.055,
      minLabel: '-15°',
      zeroLabel: '0°',
      maxLabel: '+15°',
      format: (v) => `${v > 0.005 ? '+' : ''}${v.toFixed(1)}°`,
    },
  };

  const MAJOR_GRID_PCTS = ['33.3333', '66.6667'];
  const SUB_GRID_PCTS = ['11.1111', '22.2222', '44.4444', '55.5556', '77.7778', '88.8889'];

  const adjustState = {
    enabled: false,
    activeParam: 'exposure',
    values: { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0 },
    bakedValues: { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0, rotation: 0 },
    currentRotation: 0,
    aspectRatio: 1.3333,
    tiltGridEnabled: true,
    toneGridEnabled: false,
    isScrubbing: false,
    isComparingOriginal: false,
    onChange: null,
  };

  let compareResetTimer = null;

  function _isGridActiveForParam(paramKey) {
    return paramKey === 'tilt' ? adjustState.tiltGridEnabled : adjustState.toneGridEnabled;
  }

  function isParamModified(paramKey, valuesObj) {
    const spec = ADJUST_SPECS[paramKey];
    if (!spec) return false;
    const src = valuesObj || adjustState.values;
    const cur = Number(src[paramKey] || 0);
    return Math.abs(cur - spec.defaultVal) > (spec.step < 1 ? 0.01 : 0.4);
  }

  function _resolveAspectRatio(imgEl, photo) {
    if (imgEl && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
      return imgEl.naturalWidth / imgEl.naturalHeight;
    }
    if (photo && Number(photo.width) > 0 && Number(photo.height) > 0) {
      return Number(photo.width) / Number(photo.height);
    }
    return adjustState.aspectRatio || 1.3333;
  }

  /**
   * 調整パラメータの視覚プレビュー（CSS filter と内接自動ズーム付き回転）を計算する
   * ※ server/scanner.py および frontend/js/adjust.js と同じ座標・拡大式に揃える
   */
  function _computeCssFilterAndTransform(cur, baked, isUnbaked, aspectRatio) {
    const effEv = isUnbaked ? (cur.exposure || 0) : (cur.exposure || 0) - (baked.exposure || 0);
    const effCt = isUnbaked ? (cur.contrast || 0) : (cur.contrast || 0) - (baked.contrast || 0);
    const effSat = isUnbaked ? (cur.saturation || 0) : (cur.saturation || 0) - (baked.saturation || 0);
    const effTilt = isUnbaked ? (cur.tilt || 0) : (cur.tilt || 0) - (baked.tilt || 0);
    const curRot = ((Math.round(Number(cur.rotation !== undefined ? cur.rotation : (baked.rotation || 0))) % 360) + 360) % 360;
    const bakedRot = ((Math.round(Number(baked.rotation || 0)) % 360) + 360) % 360;
    const effRot90 = isUnbaked ? curRot : (((curRot - bakedRot) % 360) + 360) % 360;
    const effDeg = effRot90 + effTilt;

    let filterStr = '';
    if (Math.abs(effEv) > 0.005 || Math.abs(effCt) > 0.1 || Math.abs(effSat) > 0.1) {
      const clampedEv = Math.max(-3.0, Math.min(3.0, effEv));
      const bFactor = Math.max(0.1, Math.min(4.0, Math.pow(2.0, clampedEv / 2.2))).toFixed(4);
      const cFactor = Math.max(0.1, Math.min(2.5, 1.0 + (effCt / 100.0) * 0.75)).toFixed(3);
      const sFactor = Math.max(0.0, Math.min(3.0, 1.0 + effSat / 100.0)).toFixed(3);
      filterStr = `brightness(${bFactor}) contrast(${cFactor}) saturate(${sFactor})`;
    }

    let autoScale = 1.0;
    if (Math.abs(effTilt) > 0.01) {
      const rad = (Math.abs(effTilt) * Math.PI) / 180.0;
      const ar = Number(aspectRatio) > 0 ? Number(aspectRatio) : 1.3333;
      const aspectMax = Math.max(ar, 1.0 / ar);
      autoScale = Math.cos(rad) + Math.sin(rad) * aspectMax;
    }

    let transformStr = '';
    if (Math.abs(effDeg) > 0.01 || autoScale > 1.0005) {
      const parts = [];
      if (Math.abs(effDeg) > 0.01) parts.push(`rotate(${effDeg.toFixed(2)}deg)`);
      if (autoScale > 1.0005) parts.push(`scale(${autoScale.toFixed(4)})`);
      transformStr = parts.join(' ');
    }
    return { filterStr, transformStr };
  }

  /**
   * サムネイルも含めて完全に未焼き込みのスマホ原本写真かどうかを判定する
   */
  function isPhoneUnbakedPhoto(photo) {
    if (!photo) return false;
    return Boolean(
      photo.is_phone_case ||
      Number(photo.id) >= 900000000 ||
      photo.volume_serial === 'ANDROID_LOCAL' ||
      String(photo.file_path || '').startsWith('phone://')
    );
  }

  /**
   * 読み込んだ画像（HD原本またはサムネイル）が非破壊調整未適用の生画像かどうかを判定する
   */
  function resolveImageUnbakedState(photo, options = {}) {
    const isFallback = Boolean(options && options.isFallback);
    const isServerMode = Boolean(options && options.isServerMode);
    if (isServerMode) return false;
    if (isFallback) return isPhoneUnbakedPhoto(photo);
    const nativeSrc = (options && options.nativeSource) ||
      (global.TetheractNative?.getLastPhotoSource ? global.TetheractNative.getLastPhotoSource(Number((photo && photo.id) || 0)) : '');
    return nativeSrc === 'usb' || nativeSrc === 'phone' || isPhoneUnbakedPhoto(photo);
  }

  /**
   * server/scanner.py の apply_photo_adjustments_pil と同一座標・計算式で
   * 非破壊調整（90°回転・水平傾き内接クロップ・トリミング・露出/コントラスト/彩度）を Canvas へ描画する
   */
  function renderAdjustedPhotoCanvas(img, photo, options = {}) {
    const srcW = Math.max(1, (img && (img.naturalWidth || img.width)) || 1);
    const srcH = Math.max(1, (img && (img.naturalHeight || img.height)) || 1);
    const isUnbaked = Boolean(options && options.isUnbaked);
    const maxLong = Math.max(0, Number((options && options.maxLongEdge) || 0));

    const baked = (photo && photo._bakedAdjust) || {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      fine_angle: 0,
      rotation: 0,
    };

    const curEv = Number((photo && photo.brightness) || 0) / 10.0;
    const bakedEv = Number(baked.brightness || 0) / 10.0;
    const effEv = isUnbaked ? curEv : (curEv - bakedEv);
    const effCt = isUnbaked ? Number((photo && photo.contrast) || 0) : (Number((photo && photo.contrast) || 0) - Number(baked.contrast || 0));
    const effSat = isUnbaked ? Number((photo && photo.saturation) || 0) : (Number((photo && photo.saturation) || 0) - Number(baked.saturation || 0));
    const effTilt = isUnbaked ? Number((photo && photo.fine_angle) || 0) : (Number((photo && photo.fine_angle) || 0) - Number(baked.fine_angle || 0));
    const curRot = ((Math.round(Number((photo && photo.rotation) || 0)) % 360) + 360) % 360;
    const bakedRot = ((Math.round(Number(baked.rotation || 0)) % 360) + 360) % 360;
    const effRot90 = isUnbaked ? curRot : (((curRot - bakedRot) % 360) + 360) % 360;

    let cx = 0.0;
    let cy = 0.0;
    let cw = 1.0;
    let ch = 1.0;
    let hasCrop = false;
    const rawCw = photo && photo.crop_w;
    const rawCh = photo && photo.crop_h;
    if (rawCw != null && rawCh != null && Number(rawCw) > 0 && Number(rawCh) > 0) {
      cx = Math.max(0.0, Math.min(1.0, Number(photo.crop_x || 0)));
      cy = Math.max(0.0, Math.min(1.0, Number(photo.crop_y || 0)));
      cw = Math.max(0.01, Math.min(1.0 - cx, Number(rawCw)));
      ch = Math.max(0.01, Math.min(1.0 - cy, Number(rawCh)));
      const hasGeomCrop = cw < 0.999 || ch < 0.999 || cx > 0.001 || cy > 0.001;
      if (hasGeomCrop) {
        if (isUnbaked) {
          hasCrop = true;
        } else {
          const hasBakedCropFields = baked && (
            baked.crop_w !== undefined ||
            baked.crop_h !== undefined ||
            baked.crop_x !== undefined ||
            baked.crop_y !== undefined
          );
          const cropMatchesBaked = !hasBakedCropFields || (
            Math.abs(Number(baked.crop_x || 0) - cx) < 0.001 &&
            Math.abs(Number(baked.crop_y || 0) - cy) < 0.001 &&
            Math.abs(Number(baked.crop_w || 0) - cw) < 0.001 &&
            Math.abs(Number(baked.crop_h || 0) - ch) < 0.001
          );
          hasCrop = !cropMatchesBaked;
        }
      }
    }

    const hasRot90 = effRot90 !== 0;
    const hasTilt = Math.abs(effTilt) > 0.01;
    const hasTone = Math.abs(effEv) > 0.005 || Math.abs(effCt) > 0.1 || Math.abs(effSat) > 0.1;
    const needsResize = maxLong > 0 && Math.max(srcW, srcH) > maxLong;

    if (!hasRot90 && !hasTilt && !hasCrop && !hasTone && !needsResize) {
      return { source: img, width: srcW, height: srcH, adjusted: false };
    }

    const isSwap90 = effRot90 === 90 || effRot90 === 270;
    const rotW = isSwap90 ? srcH : srcW;
    const rotH = isSwap90 ? srcW : srcH;

    let autoScale = 1.0;
    if (hasTilt) {
      const rad = (Math.abs(effTilt) * Math.PI) / 180.0;
      const aspectMax = Math.max(rotW / Math.max(1, rotH), rotH / Math.max(1, rotW));
      autoScale = Math.cos(rad) + Math.sin(rad) * aspectMax;
    }

    const useCx = hasCrop ? cx : 0.0;
    const useCy = hasCrop ? cy : 0.0;
    const useCw = hasCrop ? cw : 1.0;
    const useCh = hasCrop ? ch : 1.0;

    const baseOutW = Math.max(1, Math.round((rotW / autoScale) * useCw));
    const baseOutH = Math.max(1, Math.round((rotH / autoScale) * useCh));
    const baseLong = Math.max(baseOutW, baseOutH);
    const outScale = maxLong > 0 && baseLong > maxLong ? (maxLong / baseLong) : 1.0;
    const outW = Math.max(1, Math.round(baseOutW * outScale));
    const outH = Math.max(1, Math.round(baseOutH * outScale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { source: img, width: srcW, height: srcH, adjusted: false };
    }

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    ctx.save();
    if (hasTone && typeof ctx.filter === 'string') {
      const clampedEv = Math.max(-3.0, Math.min(3.0, effEv));
      const bFactor = Math.max(0.1, Math.min(4.0, Math.pow(2.0, clampedEv / 2.2))).toFixed(4);
      const cFactor = Math.max(0.1, Math.min(2.5, 1.0 + (effCt / 100.0) * 0.75)).toFixed(3);
      const sFactor = Math.max(0.0, Math.min(3.0, 1.0 + effSat / 100.0)).toFixed(3);
      ctx.filter = `brightness(${bFactor}) contrast(${cFactor}) saturate(${sFactor})`;
    }

    const fullInscribedW = outW / useCw;
    const fullInscribedH = outH / useCh;
    const drawScale = Math.max((fullInscribedW * autoScale) / rotW, (fullInscribedH * autoScale) / rotH);
    ctx.translate((0.5 - useCx) * fullInscribedW, (0.5 - useCy) * fullInscribedH);
    const totalRad = ((effRot90 + effTilt) * Math.PI) / 180.0;
    if (Math.abs(totalRad) > 0.0001) {
      ctx.rotate(totalRad);
    }
    const drawW = srcW * drawScale;
    const drawH = srcH * drawScale;
    ctx.drawImage(img, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    ctx.restore();

    return { source: canvas, width: outW, height: outH, adjusted: true };
  }

  function _applyLivePreviewToImage(imgEl) {
    const target = imgEl || document.getElementById('mViewerImg');
    if (!target) return;
    const isUnbaked = target.dataset.unbakedSource === '1';
    const baseValues = adjustState.isComparingOriginal
      ? { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0 }
      : adjustState.values;
    const displayValues = { ...baseValues, rotation: adjustState.currentRotation || 0 };
    const ar = _resolveAspectRatio(target, null);
    const { filterStr, transformStr } = _computeCssFilterAndTransform(
      displayValues,
      adjustState.bakedValues,
      isUnbaked,
      ar
    );
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
        crop_x: photo.crop_x ?? null,
        crop_y: photo.crop_y ?? null,
        crop_w: photo.crop_w ?? null,
        crop_h: photo.crop_h ?? null,
      };
    }
    const cur = {
      exposure: Number(photo.brightness || 0) / 10.0,
      contrast: Number(photo.contrast || 0),
      saturation: Number(photo.saturation || 0),
      tilt: Number(photo.fine_angle || 0),
      rotation: Number(photo.rotation || 0),
    };
    const isViewerImg = imgEl.id === 'mViewerImg';
    const bakedSrc = isViewerImg && photo._viewerLoadedBakedAdjust ? photo._viewerLoadedBakedAdjust : photo._bakedAdjust;
    const baked = {
      exposure: Number(bakedSrc.brightness || 0) / 10.0,
      contrast: Number(bakedSrc.contrast || 0),
      saturation: Number(bakedSrc.saturation || 0),
      tilt: Number(bakedSrc.fine_angle || 0),
      rotation: Number(bakedSrc.rotation || 0),
    };
    const isUnbaked = imgEl.dataset.unbakedSource === '1';
    const ar = _resolveAspectRatio(imgEl, photo);
    const { filterStr, transformStr } = _computeCssFilterAndTransform(cur, baked, isUnbaked, ar);
    imgEl.style.filter = filterStr;
    imgEl.style.transform = transformStr;
  }

  function _ensureLevelGrid() {
    const gridEl = document.getElementById('tViewerLevelGrid');
    if (!gridEl) return null;
    if (gridEl.dataset.populated === '1') return gridEl;

    const lines = [];
    SUB_GRID_PCTS.forEach((pct) => {
      lines.push(`<span class="t-level-line is-h is-sub" style="top:${pct}%;"></span>`);
      lines.push(`<span class="t-level-line is-v is-sub" style="left:${pct}%;"></span>`);
    });
    MAJOR_GRID_PCTS.forEach((pct) => {
      lines.push(`<span class="t-level-line is-h is-major" style="top:${pct}%;"></span>`);
      lines.push(`<span class="t-level-line is-v is-major" style="left:${pct}%;"></span>`);
    });
    lines.push('<span class="t-level-line is-h is-center" style="top:50%;"></span>');
    lines.push('<span class="t-level-line is-v is-center" style="left:50%;"></span>');

    gridEl.innerHTML = lines.join('');
    gridEl.dataset.populated = '1';
    return gridEl;
  }

  function _syncLevelGrid() {
    const gridEl = _ensureLevelGrid();
    if (!gridEl) return;
    const isTilt = adjustState.activeParam === 'tilt';
    const shouldShow =
      adjustState.enabled &&
      !adjustState.isComparingOriginal &&
      _isGridActiveForParam(adjustState.activeParam);

    gridEl.classList.toggle('is-visible', shouldShow);
    gridEl.classList.toggle('is-tilt-mode', shouldShow && isTilt);
    gridEl.classList.toggle('is-scrubbing', shouldShow && adjustState.isScrubbing);
  }

  function _buildDialTicksHtml() {
    const items = [];
    for (let i = 0; i <= 30; i += 1) {
      const cls = ['t-adjust-dial-tick'];
      if (i === 15) cls.push('is-zero');
      else if (i % 5 === 0) cls.push('is-major');
      items.push(`<span class="${cls.join(' ')}"></span>`);
    }
    return items.join('');
  }

  function _ensureControlStrip() {
    const strip = document.getElementById('tAdjustControlStrip');
    if (!strip) return null;
    if (strip.dataset.populated === '1') return strip;

    strip.innerHTML = `
      <div class="t-adjust-strip-header">
        <button type="button" id="tAdjustValueResetBtn" class="t-adjust-value-btn" title="タップでこの項目を0に戻す">
          <span id="tAdjustParamLabel" class="t-adjust-param-label">露光量</span>
          <span id="tAdjustParamValue" class="t-adjust-param-value">0.0 EV</span>
          <span id="tAdjustResetHint" class="t-adjust-reset-hint">0に戻す</span>
        </button>
        <div class="t-adjust-strip-actions">
          <button type="button" id="tAdjustStepMinusBtn" class="t-adjust-mini-btn" aria-label="1ステップ減らす" title="1ステップ減らす">−</button>
          <button type="button" id="tAdjustStepPlusBtn" class="t-adjust-mini-btn" aria-label="1ステップ増やす" title="1ステップ増やす">＋</button>
          <button type="button" id="tAdjustGridToggleBtn" class="t-adjust-mini-btn t-adjust-pill-btn" aria-label="ガイドライン表示切替" title="水平・三分割ガイド">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="1.5"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
              <line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
            <span>ガイド</span>
          </button>
          <button type="button" id="tAdjustCompareBtn" class="t-adjust-mini-btn t-adjust-pill-btn" aria-label="長押しで元画像と比較" title="長押しで調整前と比較">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <span>元画像</span>
          </button>
        </div>
      </div>
      <div class="t-adjust-dial-wrap">
        <div class="t-adjust-dial-scale-labels" aria-hidden="true">
          <span id="tAdjustMinLabel">-3.0</span>
          <span id="tAdjustZeroLabel">0</span>
          <span id="tAdjustMaxLabel">+3.0</span>
        </div>
        <div id="tAdjustDialTrack" class="t-adjust-dial-track" role="slider" aria-label="非破壊調整ダイヤル" aria-valuemin="-3" aria-valuemax="3" aria-valuenow="0">
          <div class="t-adjust-dial-ticks" aria-hidden="true">${_buildDialTicksHtml()}</div>
          <div id="tAdjustDialFill" class="t-adjust-dial-fill"></div>
          <div id="tAdjustDialThumb" class="t-adjust-dial-thumb"></div>
        </div>
      </div>
    `;
    strip.dataset.populated = '1';
    _bindControlStripEvents(strip);
    return strip;
  }

  function _emitAdjustChange(spec, val) {
    const detail = {
      param: spec.key,
      value: val,
      formatted: spec.format(val),
      values: { ...adjustState.values },
    };
    if (typeof adjustState.onChange === 'function') {
      adjustState.onChange(detail);
    }
    global.dispatchEvent(new CustomEvent('tetheract:canvas-scrub-change', { detail }));
  }

  function _commitAdjustValue(spec, nextVal) {
    const clamped = Math.max(spec.min, Math.min(spec.max, nextVal));
    const normalized = spec.step < 1 ? Number(clamped.toFixed(1)) : Math.round(clamped);
    adjustState.values[spec.key] = normalized;
    _applyLivePreviewToImage();
    _syncAdjustUi();
    _emitAdjustChange(spec, normalized);
  }

  function _setCompareHolding(isHolding) {
    const next = Boolean(isHolding);
    if (compareResetTimer) {
      clearTimeout(compareResetTimer);
      compareResetTimer = null;
    }
    if (adjustState.isComparingOriginal === next) return;
    adjustState.isComparingOriginal = next;
    _applyLivePreviewToImage();
    _syncAdjustUi();
  }

  function _bindControlStripEvents(strip) {
    if (!strip || strip.dataset.eventsBound === '1') return;
    strip.dataset.eventsBound = '1';

    strip.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    strip.addEventListener('touchend', (e) => e.stopPropagation(), { passive: true });
    strip.addEventListener('click', (e) => e.stopPropagation());

    strip.querySelector('#tAdjustValueResetBtn')?.addEventListener('click', () => {
      resetSingleAdjustParam(adjustState.activeParam);
    });
    strip.querySelector('#tAdjustStepMinusBtn')?.addEventListener('click', () => {
      stepActiveAdjustParam(-1);
    });
    strip.querySelector('#tAdjustStepPlusBtn')?.addEventListener('click', () => {
      stepActiveAdjustParam(1);
    });
    strip.querySelector('#tAdjustGridToggleBtn')?.addEventListener('click', () => {
      if (adjustState.activeParam === 'tilt') {
        adjustState.tiltGridEnabled = !adjustState.tiltGridEnabled;
      } else {
        adjustState.toneGridEnabled = !adjustState.toneGridEnabled;
      }
      _syncAdjustUi();
    });

    const compareBtn = strip.querySelector('#tAdjustCompareBtn');
    if (compareBtn) {
      const startHold = () => _setCompareHolding(true);
      const endHold = () => _setCompareHolding(false);
      compareBtn.addEventListener('touchstart', startHold, { passive: true });
      compareBtn.addEventListener('touchend', endHold, { passive: true });
      compareBtn.addEventListener('touchcancel', endHold, { passive: true });
      compareBtn.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') startHold();
      });
      compareBtn.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'touch') endHold();
      });
      compareBtn.addEventListener('pointercancel', endHold);
      compareBtn.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'touch') endHold();
      });
      compareBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    const dialTrack = strip.querySelector('#tAdjustDialTrack');
    if (dialTrack) {
      let dialScrubbing = false;
      let startX = 0;
      let initialVal = 0;

      const onDialStart = (clientX) => {
        if (!adjustState.enabled) return;
        const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
        dialScrubbing = true;
        adjustState.isScrubbing = true;
        startX = clientX;
        initialVal = Number(adjustState.values[spec.key] || 0);
        _syncLevelGrid();
      };

      const onDialMove = (clientX) => {
        if (!dialScrubbing || !adjustState.enabled) return;
        const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
        const rect = dialTrack.getBoundingClientRect();
        const spanPx = Math.max(200, rect.width * 0.85);
        const perPx = (spec.max - spec.min) / spanPx;
        const rawNext = initialVal + (clientX - startX) * perPx;
        const stepped = _snapWithZeroDetent(spec, rawNext, initialVal);
        _commitAdjustValue(spec, stepped);
      };

      const onDialEnd = () => {
        if (!dialScrubbing) return;
        dialScrubbing = false;
        adjustState.isScrubbing = false;
        _syncLevelGrid();
      };

      dialTrack.addEventListener(
        'touchstart',
        (e) => {
          e.stopPropagation();
          if (e.touches.length !== 1) return;
          onDialStart(e.touches[0].clientX);
        },
        { passive: true }
      );
      dialTrack.addEventListener(
        'touchmove',
        (e) => {
          e.stopPropagation();
          if (!dialScrubbing || e.touches.length !== 1) return;
          if (e.cancelable) e.preventDefault();
          onDialMove(e.touches[0].clientX);
        },
        { passive: false }
      );
      dialTrack.addEventListener('touchend', onDialEnd, { passive: true });
      dialTrack.addEventListener('touchcancel', onDialEnd, { passive: true });

      dialTrack.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') return;
        e.stopPropagation();
        onDialStart(e.clientX);
      });
      dialTrack.addEventListener('pointermove', (e) => {
        if (!dialScrubbing || e.pointerType === 'touch') return;
        onDialMove(e.clientX);
      });
      dialTrack.addEventListener('pointerup', onDialEnd);
      dialTrack.addEventListener('pointercancel', onDialEnd);
    }
  }

  function _snapWithZeroDetent(spec, rawNext, initialVal) {
    // すでに0以外の値から戻すときのみゼロ付近に軽い吸着を持たせ、0からの±0.1°微調整を妨げない
    if (Math.abs(initialVal) > spec.step * 1.5 && Math.abs(rawNext) < spec.step * 0.75) {
      return spec.defaultVal;
    }
    const stepped = Math.round(rawNext / spec.step) * spec.step;
    return Math.max(spec.min, Math.min(spec.max, Number(stepped.toFixed(2))));
  }

  function _syncAdjustUi() {
    _syncLevelGrid();

    const strip = _ensureControlStrip();
    if (!strip) return;

    strip.style.display = adjustState.enabled ? 'flex' : 'none';
    if (!adjustState.enabled) return;

    const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
    const val = Number(adjustState.values[spec.key] || 0);
    const modified = isParamModified(spec.key);

    const labelEl = strip.querySelector('#tAdjustParamLabel');
    const valEl = strip.querySelector('#tAdjustParamValue');
    const resetBtn = strip.querySelector('#tAdjustValueResetBtn');
    const minEl = strip.querySelector('#tAdjustMinLabel');
    const zeroEl = strip.querySelector('#tAdjustZeroLabel');
    const maxEl = strip.querySelector('#tAdjustMaxLabel');
    const trackEl = strip.querySelector('#tAdjustDialTrack');
    const fillEl = strip.querySelector('#tAdjustDialFill');
    const thumbEl = strip.querySelector('#tAdjustDialThumb');
    const gridBtn = strip.querySelector('#tAdjustGridToggleBtn');
    const compareBtn = strip.querySelector('#tAdjustCompareBtn');

    if (labelEl) labelEl.textContent = spec.label;
    if (valEl) {
      valEl.textContent = spec.format(val);
      valEl.classList.toggle('is-modified', modified);
    }
    if (resetBtn) resetBtn.classList.toggle('is-modified', modified);
    if (minEl) minEl.textContent = spec.minLabel;
    if (zeroEl) zeroEl.textContent = spec.zeroLabel;
    if (maxEl) maxEl.textContent = spec.maxLabel;

    const span = spec.max - spec.min;
    const pct = span > 0 ? Math.max(0, Math.min(100, ((val - spec.min) / span) * 100)) : 50;
    const zeroPct = span > 0 ? Math.max(0, Math.min(100, ((0 - spec.min) / span) * 100)) : 50;
    if (fillEl) {
      fillEl.style.left = `${Math.min(zeroPct, pct)}%`;
      fillEl.style.width = `${Math.abs(pct - zeroPct)}%`;
    }
    if (thumbEl) thumbEl.style.left = `${pct}%`;
    if (trackEl) {
      trackEl.setAttribute('aria-valuemin', String(spec.min));
      trackEl.setAttribute('aria-valuemax', String(spec.max));
      trackEl.setAttribute('aria-valuenow', String(val));
      trackEl.setAttribute('aria-valuetext', spec.format(val));
    }

    if (gridBtn) {
      const gridOn = _isGridActiveForParam(spec.key);
      gridBtn.classList.toggle('is-active', gridOn);
      gridBtn.setAttribute('aria-pressed', gridOn ? 'true' : 'false');
    }
    if (compareBtn) {
      compareBtn.classList.toggle('is-holding', adjustState.isComparingOriginal);
      compareBtn.setAttribute('aria-pressed', adjustState.isComparingOriginal ? 'true' : 'false');
    }
  }

  function bindCanvasScrubAdjust(stageElOrSelector, callbacks = {}) {
    const stageEl =
      typeof stageElOrSelector === 'string'
        ? document.querySelector(stageElOrSelector)
        : stageElOrSelector || document.getElementById('mViewerStage');
    if (!stageEl || stageEl.dataset.touchCanvasScrubBound === '1') return;
    stageEl.dataset.touchCanvasScrubBound = '1';

    if (callbacks.onChange) adjustState.onChange = callbacks.onChange;

    let pointerActive = false;
    let scrubCommitted = false;
    let startX = 0;
    let initialVal = 0;

    const beginCandidate = (clientX) => {
      if (!adjustState.enabled) return;
      const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
      pointerActive = true;
      scrubCommitted = false;
      startX = clientX;
      initialVal = Number(adjustState.values[spec.key] || 0);
    };

    const moveCandidate = (clientX) => {
      if (!pointerActive || !adjustState.enabled) return;
      const dx = clientX - startX;
      if (!scrubCommitted) {
        if (Math.abs(dx) < 4) return;
        scrubCommitted = true;
        adjustState.isScrubbing = true;
        _syncLevelGrid();
      }
      const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
      const rawNext = initialVal + dx * spec.sensitivity;
      const stepped = _snapWithZeroDetent(spec, rawNext, initialVal);
      _commitAdjustValue(spec, stepped);
    };

    const finishCandidate = () => {
      if (!pointerActive) return;
      pointerActive = false;
      scrubCommitted = false;
      if (adjustState.isScrubbing) {
        adjustState.isScrubbing = false;
        _syncLevelGrid();
      }
    };

    stageEl.addEventListener(
      'touchstart',
      (e) => {
        if (!adjustState.enabled) return;
        if (e.touches.length !== 1) {
          finishCandidate();
          return;
        }
        beginCandidate(e.touches[0].clientX);
      },
      { passive: true }
    );

    stageEl.addEventListener(
      'touchmove',
      (e) => {
        if (!pointerActive || !adjustState.enabled) return;
        if (e.touches.length !== 1) {
          finishCandidate();
          return;
        }
        if (e.cancelable) e.preventDefault();
        moveCandidate(e.touches[0].clientX);
      },
      { passive: false }
    );

    stageEl.addEventListener('touchend', finishCandidate, { passive: true });
    stageEl.addEventListener('touchcancel', finishCandidate, { passive: true });

    stageEl.addEventListener('pointerdown', (e) => {
      if (!adjustState.enabled || e.pointerType === 'touch') return;
      beginCandidate(e.clientX);
    });
    stageEl.addEventListener('pointermove', (e) => {
      if (!pointerActive || !adjustState.enabled || e.pointerType === 'touch') return;
      moveCandidate(e.clientX);
    });
    stageEl.addEventListener('pointerup', finishCandidate);
    stageEl.addEventListener('pointercancel', finishCandidate);
  }

  function setAdjustModeEnabled(enabled, initialParam) {
    adjustState.enabled = Boolean(enabled);
    adjustState.isScrubbing = false;
    adjustState.isComparingOriginal = false;
    if (initialParam && ADJUST_SPECS[initialParam]) {
      adjustState.activeParam = initialParam;
    }
    _applyLivePreviewToImage();
    _syncAdjustUi();
  }

  function setActiveAdjustParam(paramKey) {
    if (!ADJUST_SPECS[paramKey]) return;
    adjustState.activeParam = paramKey;
    _setCompareHolding(false);
    _syncAdjustUi();
  }

  function resetSingleAdjustParam(paramKey) {
    const spec = ADJUST_SPECS[paramKey];
    if (!spec) return;
    _setCompareHolding(false);
    _commitAdjustValue(spec, spec.defaultVal);
  }

  function stepActiveAdjustParam(direction) {
    const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
    _setCompareHolding(false);
    const cur = Number(adjustState.values[spec.key] || 0);
    const dir = direction >= 0 ? 1 : -1;
    const raw = cur + dir * spec.step;
    const stepped = Math.round(raw / spec.step) * spec.step;
    _commitAdjustValue(spec, Number(stepped.toFixed(2)));
  }

  function resetAdjustValues() {
    adjustState.values = { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0 };
    adjustState.isComparingOriginal = false;
    _applyLivePreviewToImage();
    _syncAdjustUi();
    const spec = ADJUST_SPECS[adjustState.activeParam] || ADJUST_SPECS.exposure;
    _emitAdjustChange(spec, adjustState.values[spec.key]);
  }

  function getAdjustValues() {
    return { ...adjustState.values };
  }

  function loadPhotoAdjustValues(photo) {
    if (!photo) {
      adjustState.values = { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0 };
      adjustState.bakedValues = { exposure: 0.0, contrast: 0, saturation: 0, tilt: 0.0, rotation: 0 };
      adjustState.currentRotation = 0;
      adjustState.aspectRatio = 1.3333;
    } else {
      if (!photo._bakedAdjust) {
        photo._bakedAdjust = {
          brightness: Number(photo.brightness || 0),
          contrast: Number(photo.contrast || 0),
          saturation: Number(photo.saturation || 0),
          fine_angle: Number(photo.fine_angle || 0),
          rotation: Number(photo.rotation || 0),
          crop_x: photo.crop_x ?? null,
          crop_y: photo.crop_y ?? null,
          crop_w: photo.crop_w ?? null,
          crop_h: photo.crop_h ?? null,
        };
      }
      const imgEl = document.getElementById('mViewerImg');
      adjustState.aspectRatio = _resolveAspectRatio(imgEl, photo);

      const b = Number(photo.brightness || 0);
      adjustState.currentRotation = Number(photo.rotation || 0);
      adjustState.values = {
        exposure: Number((b / 10.0).toFixed(2)),
        contrast: Math.round(Number(photo.contrast || 0)),
        saturation: Math.round(Number(photo.saturation || 0)),
        tilt: Number(Number(photo.fine_angle || 0).toFixed(2)),
      };
      const viewerBaked = photo._viewerLoadedBakedAdjust || photo._bakedAdjust;
      adjustState.bakedValues = {
        exposure: Number((Number(viewerBaked.brightness || 0) / 10.0).toFixed(2)),
        contrast: Math.round(Number(viewerBaked.contrast || 0)),
        saturation: Math.round(Number(viewerBaked.saturation || 0)),
        tilt: Number(Number(viewerBaked.fine_angle || 0).toFixed(2)),
        rotation: Number(viewerBaked.rotation || 0),
      };
    }
    adjustState.isComparingOriginal = false;
    adjustState.isScrubbing = false;
    _applyLivePreviewToImage();
    _syncAdjustUi();
    global.dispatchEvent(new CustomEvent('tetheract:adjust-values-loaded', { detail: { values: { ...adjustState.values } } }));
  }

  function initTouchAdjust() {
    _ensureLevelGrid();
    _ensureControlStrip();
    bindCanvasScrubAdjust('#mViewerStage');
    _syncAdjustUi();
  }

  const adjustApi = {
    ADJUST_SPECS,
    bindCanvasScrubAdjust,
    setAdjustModeEnabled,
    setActiveAdjustParam,
    resetAdjustValues,
    resetSingleAdjustParam,
    stepActiveAdjustParam,
    getAdjustValues,
    isParamModified,
    loadPhotoAdjustValues,
    applyPhotoCssAdjustmentsToElement,
    isPhoneUnbakedPhoto,
    resolveImageUnbakedState,
    renderAdjustedPhotoCanvas,
    syncAdjustUi: _syncAdjustUi,
  };

  const existing = global.TetheractTouchUI || {};
  global.TetheractTouchUI = Object.assign(existing, adjustApi, {
    adjust: adjustApi,
    gestures: Object.assign({}, existing.gestures || {}, adjustApi),
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTouchAdjust);
  } else {
    initTouchAdjust();
  }
})(window);
