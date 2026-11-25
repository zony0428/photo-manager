/**
 * Art Framer Step 0（非破壊調整）共通コアロジック
 *
 * 責務:
 * - 調整値スナップショット正規化（90°回転・水平傾き・露出・コントラスト・彩度・クロップ）
 * - 変更差分種別（トーンのみ変更 vs 幾何変更）の判定による後工程マスク影響制御
 * - 未加工元画像に対する二重焼き込みゼロの非破壊プレビュー Canvas 合成
 * - PC版 (`art_framer.js`) とモバイル／タブレット版 (`touch_art_framer.js`) の双方で共有
 */
(function (global) {
  'use strict';

  const BRIGHTNESS_EV_STEPS = [-20, -17, -13, -10, -7, -3, 0, 3, 7, 10, 13, 17, 20];

  const STEP0_PARAM_SPECS = {
    brightness: {
      key: 'brightness',
      label: '露光量',
      min: -20,
      max: 20,
      step: 1,
      sliderMin: -6,
      sliderMax: 6,
      sensitivity: 0.14,
    },
    contrast: {
      key: 'contrast',
      label: 'コントラスト',
      min: -100,
      max: 100,
      step: 1,
      sensitivity: 0.45,
    },
    saturation: {
      key: 'saturation',
      label: '彩度',
      min: -100,
      max: 100,
      step: 1,
      sensitivity: 0.45,
    },
    fine_angle: {
      key: 'fine_angle',
      label: '傾き',
      min: -15.0,
      max: 15.0,
      step: 0.1,
      sensitivity: 0.055,
    },
  };

  function clamp(val, minVal, maxVal) {
    return Math.max(minVal, Math.min(maxVal, val));
  }

  function normalizeRotationDeg(rot) {
    const num = Math.round(Number(rot) || 0);
    const snapped = Math.round(num / 90) * 90;
    return ((snapped % 360) + 360) % 360;
  }

  function brightnessToDialIndex(bVal) {
    const num = Number(bVal) || 0;
    let bestIdx = 6;
    let minDiff = Infinity;
    for (let i = 0; i < BRIGHTNESS_EV_STEPS.length; i += 1) {
      const diff = Math.abs(BRIGHTNESS_EV_STEPS[i] - num);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx - 6;
  }

  function dialIndexToBrightness(dialIdx) {
    const clampedIdx = clamp(Math.round(Number(dialIdx) || 0), -6, 6);
    return BRIGHTNESS_EV_STEPS[clampedIdx + 6];
  }

  function formatBrightnessEv(bVal) {
    const num = clamp(Math.round(Number(bVal) || 0), -30, 30);
    const ev = num / 10.0;
    const sign = num > 0 ? '+' : '';
    return `${sign}${ev.toFixed(1)}EV`;
  }

  function formatSignedInt(val) {
    const num = Math.round(Number(val) || 0);
    return `${num > 0 ? '+' : ''}${num}`;
  }

  function formatFineAngle(angleVal) {
    const fa = Number(angleVal) || 0;
    const clean = Math.abs(fa) <= 0.01 ? 0 : fa;
    const sign = clean > 0 ? '+' : '';
    return `${sign}${clean.toFixed(1)}°`;
  }

  function createResetAdjustSnapshot() {
    return {
      rotation: 0,
      fine_angle: 0.0,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      crop_x: null,
      crop_y: null,
      crop_w: null,
      crop_h: null,
      crop_aspect: null,
    };
  }

  function normalizeAdjustSnapshot(meta) {
    const src = meta && typeof meta === 'object' ? meta : {};
    const faRaw = clamp(Number(src.fine_angle || 0), -45, 45);
    const fineAngle = Math.abs(faRaw) <= 0.01 ? 0.0 : Number(faRaw.toFixed(2));
    const hasCrop = (
      src.crop_w != null &&
      src.crop_h != null &&
      Number(src.crop_w) > 0 &&
      Number(src.crop_h) > 0
    );
    const cx = hasCrop ? clamp(Number(src.crop_x || 0), 0, 1) : null;
    const cy = hasCrop ? clamp(Number(src.crop_y || 0), 0, 1) : null;
    const cw = hasCrop ? clamp(Number(src.crop_w), 0.01, 1 - cx) : null;
    const ch = hasCrop ? clamp(Number(src.crop_h), 0.01, 1 - cy) : null;
    const isFullCrop = !hasCrop || (cw >= 0.999 && ch >= 0.999 && cx <= 0.001 && cy <= 0.001);

    return {
      rotation: normalizeRotationDeg(src.rotation),
      fine_angle: fineAngle,
      brightness: clamp(Math.round(Number(src.brightness || 0)), -100, 100),
      contrast: clamp(Math.round(Number(src.contrast || 0)), -100, 100),
      saturation: clamp(Math.round(Number(src.saturation || 0)), -100, 100),
      crop_x: isFullCrop ? null : Number(cx.toFixed(5)),
      crop_y: isFullCrop ? null : Number(cy.toFixed(5)),
      crop_w: isFullCrop ? null : Number(cw.toFixed(5)),
      crop_h: isFullCrop ? null : Number(ch.toFixed(5)),
      crop_aspect: isFullCrop ? null : (src.crop_aspect || null),
    };
  }

  function _cropKeyEqual(a, b) {
    const aHas = a.crop_w != null && a.crop_h != null;
    const bHas = b.crop_w != null && b.crop_h != null;
    if (!aHas && !bHas) return true;
    if (aHas !== bHas) return false;
    return (
      Math.abs((a.crop_x || 0) - (b.crop_x || 0)) < 0.0015 &&
      Math.abs((a.crop_y || 0) - (b.crop_y || 0)) < 0.0015 &&
      Math.abs((a.crop_w || 0) - (b.crop_w || 0)) < 0.0015 &&
      Math.abs((a.crop_h || 0) - (b.crop_h || 0)) < 0.0015
    );
  }

  /**
   * Step 0 入室時点と編集後スナップショットの差分種別（トーン変更・幾何変更）を判定する
   */
  function classifyAdjustDiff(committedMeta, draftMeta) {
    const a = normalizeAdjustSnapshot(committedMeta);
    const b = normalizeAdjustSnapshot(draftMeta);
    const rotChanged = a.rotation !== b.rotation;
    const tiltChanged = Math.abs(a.fine_angle - b.fine_angle) > 0.015;
    const cropChanged = !_cropKeyEqual(a, b);
    const toneChanged = (
      a.brightness !== b.brightness ||
      a.contrast !== b.contrast ||
      a.saturation !== b.saturation
    );
    const geometryChanged = rotChanged || tiltChanged || cropChanged;
    return {
      hasAnyChange: geometryChanged || toneChanged,
      toneChanged,
      geometryChanged,
      rotChanged,
      tiltChanged,
      cropChanged,
    };
  }

  function computeInscribedTiltScale(width, height, angleDeg) {
    const fa = Math.abs(Number(angleDeg) || 0);
    if (fa <= 0.01) return 1.0;
    const rad = (fa * Math.PI) / 180.0;
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    const aspectMax = Math.max(w / h, h / w);
    return Math.cos(rad) + Math.sin(rad) * aspectMax;
  }

  /**
   * server/scanner.py の apply_photo_adjustments_pil と同一幾何・階調式で
   * 未加工元画像 (rawImg) からプレビュー用 Canvas を生成する（二重焼き込み防止）
   */
  function renderStep0AdjustedCanvas(rawImg, targetMeta, options = {}) {
    if (!rawImg) return null;
    const srcW = Math.max(1, rawImg.naturalWidth || rawImg.width || 1);
    const srcH = Math.max(1, rawImg.naturalHeight || rawImg.height || 1);
    const snap = normalizeAdjustSnapshot(targetMeta);
    const maxLong = Math.max(0, Number(options.maxLongEdge || 1600));

    const hasCrop = snap.crop_w != null && snap.crop_h != null;
    const useCx = hasCrop ? snap.crop_x : 0.0;
    const useCy = hasCrop ? snap.crop_y : 0.0;
    const useCw = hasCrop ? snap.crop_w : 1.0;
    const useCh = hasCrop ? snap.crop_h : 1.0;

    const rot90 = snap.rotation;
    const isSwap90 = rot90 === 90 || rot90 === 270;
    const rotW = isSwap90 ? srcH : srcW;
    const rotH = isSwap90 ? srcW : srcH;

    const autoScale = computeInscribedTiltScale(rotW, rotH, snap.fine_angle);
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
    if (!ctx) return null;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    ctx.save();

    const ev = clamp(snap.brightness / 10.0, -3.0, 3.0);
    const hasTone = Math.abs(ev) > 0.005 || snap.contrast !== 0 || snap.saturation !== 0;
    if (hasTone && typeof ctx.filter === 'string') {
      const bFactor = clamp(Math.pow(2.0, ev / 2.2), 0.1, 4.0).toFixed(4);
      const cFactor = clamp(1.0 + (snap.contrast / 100.0) * 0.75, 0.1, 2.5).toFixed(3);
      const sFactor = clamp(1.0 + (snap.saturation / 100.0), 0.0, 3.0).toFixed(3);
      ctx.filter = `brightness(${bFactor}) contrast(${cFactor}) saturate(${sFactor})`;
    }

    const fullInscribedW = outW / useCw;
    const fullInscribedH = outH / useCh;
    const drawScale = Math.max((fullInscribedW * autoScale) / rotW, (fullInscribedH * autoScale) / rotH);
    ctx.translate((0.5 - useCx) * fullInscribedW, (0.5 - useCy) * fullInscribedH);
    const totalRad = ((rot90 + snap.fine_angle) * Math.PI) / 180.0;
    if (Math.abs(totalRad) > 0.0001) {
      ctx.rotate(totalRad);
    }
    const drawW = srcW * drawScale;
    const drawH = srcH * drawScale;
    ctx.drawImage(rawImg, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    ctx.restore();
    return canvas;
  }

  function isParamModified(paramKey, draft) {
    const d = draft || {};
    if (paramKey === 'fine_angle') return Math.abs(Number(d.fine_angle || 0)) > 0.015;
    if (paramKey === 'brightness') return Math.round(Number(d.brightness || 0)) !== 0;
    if (paramKey === 'contrast') return Math.round(Number(d.contrast || 0)) !== 0;
    if (paramKey === 'saturation') return Math.round(Number(d.saturation || 0)) !== 0;
    return false;
  }

  function formatParamValue(paramKey, draft) {
    const d = draft || {};
    if (paramKey === 'fine_angle') return formatFineAngle(d.fine_angle);
    if (paramKey === 'brightness') return formatBrightnessEv(d.brightness);
    if (paramKey === 'contrast') return formatSignedInt(d.contrast);
    if (paramKey === 'saturation') return formatSignedInt(d.saturation);
    return '';
  }

  global.TetheractArtFramerStep0 = {
    BRIGHTNESS_EV_STEPS,
    STEP0_PARAM_SPECS,
    normalizeRotationDeg,
    brightnessToDialIndex,
    dialIndexToBrightness,
    formatBrightnessEv,
    formatSignedInt,
    formatFineAngle,
    createResetAdjustSnapshot,
    normalizeAdjustSnapshot,
    classifyAdjustDiff,
    computeInscribedTiltScale,
    renderStep0AdjustedCanvas,
    isParamModified,
    formatParamValue,
  };
})(window);
