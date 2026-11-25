/**
 * Art Framer Step 2（レンズ演出：ぐるぐるボケ・バブルボケ・ビネット・ハレーション）共通コア ＆ 設定制御
 *
 * 責務:
 * - PC版 (`art_framer.js`) とモバイル／タブレット版 (`touch_art_framer.js`)、
 *   および Canvas エディタ (`privacy_mask_editor.js`) への共通光学エフェクト提供
 * - 「Art Framer の『演出』は使用しない」設定の永続化と PC/モバイル設定画面バインド
 * - 5ステップ ([0.調整] [1.修正] [2.演出] [3.額装] [4.出力]) と 4ステップ縮退モードの進行管理
 */
(function (global) {
  'use strict';

  const DISABLE_EFFECT_STEP_KEY = 'photo_manager_art_framer_disable_effect_step_v1';

  const BOKEH_MODE_LABELS = {
    none: 'なし',
    swirl: 'ぐるぐるボケ',
    bubble: 'バブルボケ',
    soft: 'オールドソフト',
  };

  const EFFECT_PRESETS = {
    none: {
      key: 'none',
      label: 'OFF',
      bokeh_mode: 'none',
      strength: 0.0,
      specular: 0.65,
      vignette: 0.0,
      halation: 0.0,
    },
    swirl: {
      key: 'swirl',
      label: 'ぐるぐるボケ',
      bokeh_mode: 'swirl',
      strength: 0.62,
      specular: 0.72,
      radius: 0.30,
      feather: 0.36,
      vignette: -0.26,
      halation: 0.12,
    },
    bubble: {
      key: 'bubble',
      label: 'バブルボケ',
      bokeh_mode: 'bubble',
      strength: 0.64,
      specular: 0.78,
      radius: 0.30,
      feather: 0.34,
      vignette: -0.18,
      halation: 0.10,
    },
    mist: {
      key: 'mist',
      label: 'ブラックミスト',
      bokeh_mode: 'none',
      strength: 0.0,
      specular: 0.60,
      radius: 0.34,
      feather: 0.38,
      vignette: -0.20,
      halation: 0.56,
    },
    tunnel: {
      key: 'tunnel',
      label: 'トイ減光',
      bokeh_mode: 'soft',
      strength: 0.34,
      specular: 0.45,
      radius: 0.28,
      feather: 0.40,
      vignette: -0.68,
      halation: 0.10,
    },
  };

  function clamp(val, minVal, maxVal) {
    return Math.max(minVal, Math.min(maxVal, val));
  }

  function createDefaultEffectConfig() {
    return {
      presetKey: 'none',
      bokeh_mode: 'none',
      strength: 0.0,
      specular: 0.65,
      radius: 0.32,
      feather: 0.36,
      cx: 0.50,
      cy: 0.50,
      vignette: 0.0,
      halation: 0.0,
    };
  }

  function normalizeEffectConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const modeRaw = String(src.bokeh_mode || 'none').toLowerCase();
    const mode = BOKEH_MODE_LABELS[modeRaw] ? modeRaw : 'none';
    const strength = clamp(Number(src.strength || 0), 0, 1);
    const specular = clamp(src.specular !== undefined ? Number(src.specular) : 0.65, 0, 1);
    const radius = clamp(src.radius !== undefined ? Number(src.radius) : 0.32, 0.08, 0.80);
    const feather = clamp(src.feather !== undefined ? Number(src.feather) : 0.36, 0.10, 0.75);
    const cx = clamp(src.cx !== undefined ? Number(src.cx) : 0.50, 0, 1);
    const cy = clamp(src.cy !== undefined ? Number(src.cy) : 0.50, 0, 1);
    const vignette = clamp(Number(src.vignette || 0), -1, 1);
    const halation = clamp(Number(src.halation || 0), 0, 1);

    const hasBokeh = mode !== 'none' && strength > 0.01;
    const hasVig = Math.abs(vignette) > 0.01;
    const hasHal = halation > 0.01;
    const active = src.enabled !== false && (hasBokeh || hasVig || hasHal);

    return {
      enabled: active,
      presetKey: String(src.presetKey || 'none'),
      bokeh_mode: mode,
      strength,
      specular,
      radius,
      feather,
      cx,
      cy,
      vignette,
      halation,
    };
  }

  function isEffectActive(raw) {
    return Boolean(normalizeEffectConfig(raw).enabled);
  }

  function formatEffectSummary(raw) {
    const c = normalizeEffectConfig(raw);
    if (!c.enabled) return 'なし';
    const parts = [];
    if (c.bokeh_mode !== 'none' && c.strength > 0.01) {
      parts.push(BOKEH_MODE_LABELS[c.bokeh_mode] || c.bokeh_mode);
    }
    if (Math.abs(c.vignette) > 0.01) {
      parts.push(c.vignette < 0 ? '周辺減光' : '周辺光量+');
    }
    if (c.halation > 0.01) {
      parts.push('ハレーション');
    }
    return parts.join(' + ') || 'なし';
  }

  /**
   * 90°回転差に応じてピント中心座標 (cx, cy) を自動追従変換する
   */
  function transformSpotByRotation(cx, cy, prevRotDeg, nextRotDeg) {
    const p = ((Math.round(Number(prevRotDeg || 0)) % 360) + 360) % 360;
    const n = ((Math.round(Number(nextRotDeg || 0)) % 360) + 360) % 360;
    const delta = ((n - p) % 360 + 360) % 360;
    const x = clamp(Number(cx ?? 0.5), 0, 1);
    const y = clamp(Number(cy ?? 0.5), 0, 1);
    if (delta === 90) return { cx: Number((1 - y).toFixed(4)), cy: Number(x.toFixed(4)) };
    if (delta === 180) return { cx: Number((1 - x).toFixed(4)), cy: Number((1 - y).toFixed(4)) };
    if (delta === 270) return { cx: Number(y.toFixed(4)), cy: Number((1 - x).toFixed(4)) };
    return { cx: x, cy: y };
  }

  function isEffectStepDisabled() {
    try {
      return global.localStorage.getItem(DISABLE_EFFECT_STEP_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setEffectStepDisabled(disabled) {
    const flag = Boolean(disabled);
    try {
      global.localStorage.setItem(DISABLE_EFFECT_STEP_KEY, flag ? '1' : '0');
    } catch (e) {}
    _syncSettingsCheckboxes(flag);
    try {
      global.dispatchEvent(new CustomEvent('tetheract:af-effect-step-pref-change', {
        detail: { disabled: flag },
      }));
    } catch (e) {}
    return flag;
  }

  function _syncSettingsCheckboxes(disabled) {
    ['settingDisableAfEffectStepCheck', 'mDisableAfEffectStepCheck'].forEach((id) => {
      const el = global.document && global.document.getElementById(id);
      if (el) el.checked = Boolean(disabled);
    });
  }

  function _bindSettingsCheckboxes() {
    const val = isEffectStepDisabled();
    _syncSettingsCheckboxes(val);
    ['settingDisableAfEffectStepCheck', 'mDisableAfEffectStepCheck'].forEach((id) => {
      const el = global.document && global.document.getElementById(id);
      if (el && !el.dataset.afEffectBound) {
        el.dataset.afEffectBound = '1';
        el.addEventListener('change', (e) => {
          setEffectStepDisabled(Boolean(e.target.checked));
        });
      }
    });
  }

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', _bindSettingsCheckboxes);
    } else {
      _bindSettingsCheckboxes();
    }
  }

  function getActiveStepSequence(disabled = isEffectStepDisabled()) {
    return disabled ? [0, 1, 3, 4] : [0, 1, 2, 3, 4];
  }

  function getDisplayStepNumber(logicalStep, disabled = isEffectStepDisabled()) {
    const s = Number(logicalStep);
    if (disabled && s >= 3) return s - 1;
    return s;
  }

  function getNextStep(curStep, disabled = isEffectStepDisabled()) {
    const seq = getActiveStepSequence(disabled);
    const idx = seq.indexOf(Number(curStep));
    if (idx < 0) return 1;
    return seq[Math.min(seq.length - 1, idx + 1)];
  }

  function getPrevStep(curStep, disabled = isEffectStepDisabled()) {
    const seq = getActiveStepSequence(disabled);
    const idx = seq.indexOf(Number(curStep));
    if (idx <= 0) return seq[0];
    return seq[idx - 1];
  }

  function _smoothstep(edge0, edge1, x) {
    const span = Math.max(0.05, edge1 - edge0);
    const t = clamp((x - edge0) / span, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /**
   * 3チャンネルインターリーブ Float32Array [W*H*3] の高速分離ボックスブラー
   */
  function _boxBlurRgbF32(src, w, h, radius) {
    const r = Math.max(1, Math.round(radius));
    const k = 2 * r + 1;
    const invK = 1.0 / k;
    const tmp = new Float32Array(w * h * 3);
    const out = new Float32Array(w * h * 3);

    // 水平パス
    for (let y = 0; y < h; y += 1) {
      const rowOff = y * w * 3;
      let sum0 = 0;
      let sum1 = 0;
      let sum2 = 0;
      for (let i = -r; i <= r; i += 1) {
        const sx = clamp(i, 0, w - 1) * 3;
        sum0 += src[rowOff + sx];
        sum1 += src[rowOff + sx + 1];
        sum2 += src[rowOff + sx + 2];
      }
      for (let x = 0; x < w; x += 1) {
        const dstOff = rowOff + x * 3;
        tmp[dstOff] = sum0 * invK;
        tmp[dstOff + 1] = sum1 * invK;
        tmp[dstOff + 2] = sum2 * invK;
        const addX = clamp(x + r + 1, 0, w - 1) * 3;
        const subX = clamp(x - r, 0, w - 1) * 3;
        sum0 += src[rowOff + addX] - src[rowOff + subX];
        sum1 += src[rowOff + addX + 1] - src[rowOff + subX + 1];
        sum2 += src[rowOff + addX + 2] - src[rowOff + subX + 2];
      }
    }

    // 垂直パス
    const stride = w * 3;
    for (let x = 0; x < w; x += 1) {
      const colOff = x * 3;
      let sum0 = 0;
      let sum1 = 0;
      let sum2 = 0;
      for (let i = -r; i <= r; i += 1) {
        const sy = clamp(i, 0, h - 1) * stride + colOff;
        sum0 += tmp[sy];
        sum1 += tmp[sy + 1];
        sum2 += tmp[sy + 2];
      }
      for (let y = 0; y < h; y += 1) {
        const dstOff = y * stride + colOff;
        out[dstOff] = sum0 * invK;
        out[dstOff + 1] = sum1 * invK;
        out[dstOff + 2] = sum2 * invK;
        const addY = clamp(y + r + 1, 0, h - 1) * stride + colOff;
        const subY = clamp(y - r, 0, h - 1) * stride + colOff;
        sum0 += tmp[addY] - tmp[subY];
        sum1 += tmp[addY + 1] - tmp[subY + 1];
        sum2 += tmp[addY + 2] - tmp[subY + 2];
      }
    }
    return out;
  }

  function _computeSwirlBokehF32(workF32, w, h, cfg) {
    const total = w * h;
    const halfDiag = Math.max(1, 0.5 * Math.hypot(w, h));
    const cxPx = cfg.cx * w;
    const cyPx = cfg.cy * h;
    const maxTheta = ((2.5 + 13.5 * cfg.strength) * Math.PI) / 180.0;
    const squashScale = 1.0 - 0.015 * cfg.strength;

    const boosted = new Float32Array(total * 3);
    for (let i = 0; i < total; i += 1) {
      const o = i * 3;
      const r = workF32[o];
      const g = workF32[o + 1];
      const b = workF32[o + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const hlT = lum > 0.56 ? (lum - 0.56) / 0.44 : 0;
      const gain = 1.0 + 3.4 * cfg.specular * hlT * hlT;
      boosted[o] = r * gain;
      boosted[o + 1] = g * gain;
      boosted[o + 2] = b * gain;
    }

    const out = new Float32Array(total * 3);
    const taps = 13;
    const halfTaps = 6;
    const uArr = [];
    const wArr = [];
    let wSum = 0;
    for (let k = 0; k < taps; k += 1) {
      const u = (k - halfTaps) / halfTaps;
      const tw = 1.0 - 0.35 * u * u;
      uArr.push(u);
      wArr.push(tw);
      wSum += tw;
    }
    const invW = 1.0 / wSum;
    const maxW = w - 1;
    const maxH = h - 1;

    for (let y = 0; y < h; y += 1) {
      const dy = y - cyPx;
      for (let x = 0; x < w; x += 1) {
        const dx = x - cxPx;
        const dist = Math.hypot(dx, dy) / halfDiag;
        const wOuter = _smoothstep(cfg.radius * 0.85, cfg.radius + cfg.feather * 1.15, dist);
        const dstOff = (y * w + x) * 3;
        if (wOuter <= 0.001) {
          out[dstOff] = workF32[dstOff];
          out[dstOff + 1] = workF32[dstOff + 1];
          out[dstOff + 2] = workF32[dstOff + 2];
          continue;
        }
        const thetaMap = maxTheta * Math.min(1.35, wOuter * (0.45 + 0.65 * dist));
        const rSq = 1.0 - (1.0 - squashScale) * wOuter;

        let acc0 = 0;
        let acc1 = 0;
        let acc2 = 0;
        for (let k = 0; k < taps; k += 1) {
          const ang = uArr[k] * thetaMap;
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          let sx = cxPx + (dx * ca - dy * sa) * rSq;
          let sy = cyPx + (dx * sa + dy * ca) * rSq;
          if (sx < 0) sx = 0;
          else if (sx > maxW) sx = maxW;
          if (sy < 0) sy = 0;
          else if (sy > maxH) sy = maxH;
          const x0 = sx | 0;
          const y0 = sy | 0;
          const x1 = x0 < maxW ? x0 + 1 : maxW;
          const y1 = y0 < maxH ? y0 + 1 : maxH;
          const fx = sx - x0;
          const fy = sy - y0;
          const tw = wArr[k];

          const i00 = (y0 * w + x0) * 3;
          const i10 = (y0 * w + x1) * 3;
          const i01 = (y1 * w + x0) * 3;
          const i11 = (y1 * w + x1) * 3;

          const w00 = (1 - fx) * (1 - fy) * tw;
          const w10 = fx * (1 - fy) * tw;
          const w01 = (1 - fx) * fy * tw;
          const w11 = fx * fy * tw;

          acc0 += boosted[i00] * w00 + boosted[i10] * w10 + boosted[i01] * w01 + boosted[i11] * w11;
          acc1 += boosted[i00 + 1] * w00 + boosted[i10 + 1] * w10 + boosted[i01 + 1] * w01 + boosted[i11 + 1] * w11;
          acc2 += boosted[i00 + 2] * w00 + boosted[i10 + 2] * w10 + boosted[i01 + 2] * w01 + boosted[i11 + 2] * w11;
        }
        const r0 = acc0 * invW;
        const g0 = acc1 * invW;
        const b0 = acc2 * invW;
        out[dstOff] = clamp(r0 > 1.0 ? r0 / (1.0 + (r0 - 1.0) * 0.58) : r0, 0, 1);
        out[dstOff + 1] = clamp(g0 > 1.0 ? g0 / (1.0 + (g0 - 1.0) * 0.58) : g0, 0, 1);
        out[dstOff + 2] = clamp(b0 > 1.0 ? b0 / (1.0 + (b0 - 1.0) * 0.58) : b0, 0, 1);
      }
    }
    return out;
  }

  function _computeBubbleBokehF32(workF32, w, h, cfg) {
    const longEdge = Math.max(w, h);
    const blurR = Math.max(2, Math.round(longEdge * (0.006 + 0.016 * cfg.strength)));
    const ringR = Math.max(4, Math.round(longEdge * (0.008 + 0.020 * cfg.strength)));

    const base = _boxBlurRgbF32(_boxBlurRgbF32(workF32, w, h, blurR), w, h, Math.max(1, Math.floor(blurR * 0.5) + 1));
    const total = w * h;
    const spec = new Float32Array(total * 3);
    const specScale = 1.1 + 2.8 * cfg.specular;

    for (let i = 0; i < total; i += 1) {
      const o = i * 3;
      const r = workF32[o];
      const g = workF32[o + 1];
      const b = workF32[o + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const lt = lum > 0.46 ? (lum - 0.46) / 0.54 : 0;
      const wt = lt * specScale;
      const d0 = r - base[o] * 0.88;
      const d1 = g - base[o + 1] * 0.88;
      const d2 = b - base[o + 2] * 0.88;
      spec[o] = d0 > 0 ? d0 * wt : 0;
      spec[o + 1] = d1 > 0 ? d1 * wt : 0;
      spec[o + 2] = d2 > 0 ? d2 * wt : 0;
    }

    const innerGlow = _boxBlurRgbF32(spec, w, h, Math.max(2, Math.floor(ringR * 0.5)));
    const ringAccum = new Float32Array(total * 3);
    const nDirs = 24;
    const ox1Arr = [];
    const oy1Arr = [];
    const ox2Arr = [];
    const oy2Arr = [];
    for (let d = 0; d < nDirs; d += 1) {
      const ang = (2.0 * Math.PI * d) / nDirs;
      ox1Arr.push(Math.round(Math.cos(ang) * ringR));
      oy1Arr.push(Math.round(Math.sin(ang) * ringR));
      ox2Arr.push(Math.round(Math.cos(ang) * ringR * 0.85));
      oy2Arr.push(Math.round(Math.sin(ang) * ringR * 0.85));
    }

    const maxW = w - 1;
    const maxH = h - 1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dstOff = (y * w + x) * 3;
        let a0 = 0;
        let a1 = 0;
        let a2 = 0;
        for (let d = 0; d < nDirs; d += 1) {
          const sx1 = clamp(x + ox1Arr[d], 0, maxW);
          const sy1 = clamp(y + oy1Arr[d], 0, maxH);
          const sx2 = clamp(x + ox2Arr[d], 0, maxW);
          const sy2 = clamp(y + oy2Arr[d], 0, maxH);
          const p1 = (sy1 * w + sx1) * 3;
          const p2 = (sy2 * w + sx2) * 3;
          a0 += spec[p1] * 0.65 + spec[p2] * 0.35;
          a1 += spec[p1 + 1] * 0.65 + spec[p2 + 1] * 0.35;
          a2 += spec[p1 + 2] * 0.65 + spec[p2 + 2] * 0.35;
        }
        ringAccum[dstOff] = a0;
        ringAccum[dstOff + 1] = a1;
        ringAccum[dstOff + 2] = a2;
      }
    }

    const out = new Float32Array(total * 3);
    const invDirs = (1.25 + 1.45 * cfg.specular) / nDirs;
    for (let i = 0; i < total * 3; i += 1) {
      const glow = clamp(ringAccum[i] * invDirs + innerGlow[i] * 0.16, 0, 0.92);
      out[i] = clamp(1.0 - (1.0 - base[i]) * (1.0 - glow), 0, 1);
    }
    return out;
  }

  function _computeSoftBokehF32(workF32, w, h, cfg) {
    const longEdge = Math.max(w, h);
    const r = Math.max(2, Math.round(longEdge * (0.006 + 0.017 * cfg.strength)));
    const b1 = _boxBlurRgbF32(workF32, w, h, r);
    const b2 = _boxBlurRgbF32(b1, w, h, Math.max(1, Math.floor(r * 0.5) + 1));

    const total = w * h;
    const hlSrc = new Float32Array(total * 3);
    const hlScale = 0.65 * cfg.specular;
    for (let i = 0; i < total; i += 1) {
      const o = i * 3;
      const lum = 0.2126 * workF32[o] + 0.7152 * workF32[o + 1] + 0.0722 * workF32[o + 2];
      const wt = lum > 0.60 ? ((lum - 0.60) / 0.40) * hlScale : 0;
      hlSrc[o] = workF32[o] * wt;
      hlSrc[o + 1] = workF32[o + 1] * wt;
      hlSrc[o + 2] = workF32[o + 2] * wt;
    }
    const hlGlow = _boxBlurRgbF32(hlSrc, w, h, Math.max(2, Math.round(r * 1.4)));
    const out = new Float32Array(total * 3);
    for (let i = 0; i < total * 3; i += 1) {
      const g = Math.min(0.75, hlGlow[i]);
      out[i] = clamp(1.0 - (1.0 - b2[i]) * (1.0 - g), 0, 1);
    }
    return out;
  }

  function _computeHalationGlowF32(workF32, w, h, halation) {
    const total = w * h;
    const hl = new Float32Array(total * 3);
    for (let i = 0; i < total; i += 1) {
      const o = i * 3;
      const lum = 0.2126 * workF32[o] + 0.7152 * workF32[o + 1] + 0.0722 * workF32[o + 2];
      if (lum > 0.66) {
        const t = Math.pow((lum - 0.66) / 0.34, 1.35);
        hl[o] = workF32[o] * t * 1.0;
        hl[o + 1] = workF32[o + 1] * t * 0.86;
        hl[o + 2] = workF32[o + 2] * t * 0.76;
      }
    }
    const longEdge = Math.max(w, h);
    const r1 = Math.max(2, Math.round(longEdge * (0.012 + 0.024 * halation)));
    const r2 = Math.max(2, Math.round(r1 * 0.72));
    const g1 = _boxBlurRgbF32(hl, w, h, r1);
    const g2 = _boxBlurRgbF32(g1, w, h, r2);
    const g3 = _boxBlurRgbF32(g2, w, h, Math.max(1, Math.floor(r2 * 0.5)));
    const gain = 0.95 * halation;
    for (let i = 0; i < total * 3; i += 1) {
      g3[i] = clamp(g3[i] * gain, 0, 0.85);
    }
    return g3;
  }

  function _f32ToCanvas(f32Arr, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;
    const total = w * h;
    for (let i = 0; i < total; i += 1) {
      const srcO = i * 3;
      const dstO = i * 4;
      data[dstO] = clamp(Math.round(f32Arr[srcO] * 255), 0, 255);
      data[dstO + 1] = clamp(Math.round(f32Arr[srcO + 1] * 255), 0, 255);
      data[dstO + 2] = clamp(Math.round(f32Arr[srcO + 2] * 255), 0, 255);
      data[dstO + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return c;
  }

  /**
   * ソース画像/Canvas に対して Step 2 レンズ演出（ボケ・ビネット・ハレーション）を適用した Canvas を生成する
   */
  function renderLensEffectCanvas(sourceEl, effectCfg, options = {}) {
    if (!sourceEl) return null;
    const cfg = normalizeEffectConfig(effectCfg);
    const origW = Math.max(1, sourceEl.naturalWidth || sourceEl.width || 1);
    const origH = Math.max(1, sourceEl.naturalHeight || sourceEl.height || 1);

    const outCanvas = options.targetCanvas || document.createElement('canvas');
    outCanvas.width = origW;
    outCanvas.height = origH;
    const oCtx = outCanvas.getContext('2d', { willReadFrequently: true });
    oCtx.drawImage(sourceEl, 0, 0, origW, origH);

    if (!cfg.enabled) return outCanvas;

    const hasBokeh = cfg.bokeh_mode !== 'none' && cfg.strength > 0.01;
    const hasHal = cfg.halation > 0.01;
    const hasVig = Math.abs(cfg.vignette) > 0.01;

    if (hasBokeh || hasHal) {
      const maxWork = Math.max(160, Number(options.maxWorkLong || 760));
      const origLong = Math.max(origW, origH);
      const scale = origLong > maxWork ? (maxWork / origLong) : 1.0;
      const ww = Math.max(16, Math.round(origW * scale));
      const wh = Math.max(16, Math.round(origH * scale));

      const workCanvas = document.createElement('canvas');
      workCanvas.width = ww;
      workCanvas.height = wh;
      const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
      wCtx.drawImage(sourceEl, 0, 0, ww, wh);
      const wRgba = wCtx.getImageData(0, 0, ww, wh).data;

      const workF32 = new Float32Array(ww * wh * 3);
      for (let i = 0; i < ww * wh; i += 1) {
        const s = i * 4;
        const d = i * 3;
        workF32[d] = wRgba[s] / 255.0;
        workF32[d + 1] = wRgba[s + 1] / 255.0;
        workF32[d + 2] = wRgba[s + 2] / 255.0;
      }

      if (hasBokeh) {
        let bokehF32;
        if (cfg.bokeh_mode === 'swirl') {
          bokehF32 = _computeSwirlBokehF32(workF32, ww, wh, cfg);
        } else if (cfg.bokeh_mode === 'bubble') {
          bokehF32 = _computeBubbleBokehF32(workF32, ww, wh, cfg);
        } else {
          bokehF32 = _computeSoftBokehF32(workF32, ww, wh, cfg);
        }

        // ピント中心径内を無劣化で保護するため作業解像度のスポットアルファマスクを作成
        const bokehCanvas = _f32ToCanvas(bokehF32, ww, wh);
        const halfDiagW = Math.max(1, 0.5 * Math.hypot(ww, wh));
        const cxW = cfg.cx * ww;
        const cyW = cfg.cy * wh;
        const bCtx = bokehCanvas.getContext('2d');
        const bData = bCtx.getImageData(0, 0, ww, wh);
        const px = bData.data;
        for (let y = 0; y < wh; y += 1) {
          const dy = y - cyW;
          for (let x = 0; x < ww; x += 1) {
            const dist = Math.hypot(x - cxW, dy) / halfDiagW;
            const wSpot = _smoothstep(cfg.radius, cfg.radius + cfg.feather, dist);
            px[(y * ww + x) * 4 + 3] = Math.round(wSpot * 255);
          }
        }
        bCtx.putImageData(bData, 0, 0);

        oCtx.save();
        oCtx.imageSmoothingEnabled = true;
        oCtx.imageSmoothingQuality = 'high';
        oCtx.drawImage(bokehCanvas, 0, 0, origW, origH);
        oCtx.restore();
      }

      if (hasHal) {
        const halF32 = _computeHalationGlowF32(workF32, ww, wh, cfg.halation);
        const halCanvas = _f32ToCanvas(halF32, ww, wh);
        oCtx.save();
        oCtx.globalCompositeOperation = 'screen';
        oCtx.imageSmoothingEnabled = true;
        oCtx.imageSmoothingQuality = 'high';
        oCtx.drawImage(halCanvas, 0, 0, origW, origH);
        oCtx.restore();
      }
    }

    if (hasVig) {
      const halfDiag = Math.max(1, 0.5 * Math.hypot(origW, origH));
      const cxPx = cfg.cx * origW;
      const cyPx = cfg.cy * origH;
      const r0 = Math.max(1, (cfg.radius * 0.72) * halfDiag);
      const r1 = Math.max(r0 + 8, (cfg.radius * 0.72 + cfg.feather * 1.2 + 0.16) * halfDiag);

      oCtx.save();
      const grad = oCtx.createRadialGradient(cxPx, cyPx, r0, cxPx, cyPx, r1);
      if (cfg.vignette < 0) {
        const aMax = clamp(Math.abs(cfg.vignette) * 0.84, 0, 0.88);
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        grad.addColorStop(0.55, `rgba(0, 0, 0, ${(aMax * 0.45).toFixed(3)})`);
        grad.addColorStop(1, `rgba(0, 0, 0, ${aMax.toFixed(3)})`);
        oCtx.fillStyle = grad;
        oCtx.fillRect(0, 0, origW, origH);
      } else {
        const aMax = clamp(cfg.vignette * 0.36, 0, 0.40);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
        grad.addColorStop(0.55, `rgba(255, 255, 255, ${(aMax * 0.45).toFixed(3)})`);
        grad.addColorStop(1, `rgba(255, 255, 255, ${aMax.toFixed(3)})`);
        oCtx.globalCompositeOperation = 'screen';
        oCtx.fillStyle = grad;
        oCtx.fillRect(0, 0, origW, origH);
      }
      oCtx.restore();
    }

    return outCanvas;
  }

  global.TetheractArtFramerEffect = {
    DISABLE_EFFECT_STEP_KEY,
    BOKEH_MODE_LABELS,
    EFFECT_PRESETS,
    createDefaultEffectConfig,
    normalizeEffectConfig,
    isEffectActive,
    formatEffectSummary,
    transformSpotByRotation,
    isEffectStepDisabled,
    setEffectStepDisabled,
    syncSettingsCheckboxes: _bindSettingsCheckboxes,
    getActiveStepSequence,
    getDisplayStepNumber,
    getNextStep,
    getPrevStep,
    renderLensEffectCanvas,
  };
})(window);
