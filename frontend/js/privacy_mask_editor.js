/**
 * privacy_mask_editor.js - Art Framer 共通インタラクティブ Canvas 編集・プレビューエンジン
 *
 * 責務:
 * - 正規化座標 (0.0〜1.0) による無劣化ズーム (100%〜800%) ＆ パン制御
 * - 2本指ピンチズーム・2本指パン・マウスホイールズーム・手のひら移動
 * - 画面空間 (Screen Space) 一定サイズのナンバープレート4頂点ハンドル・顔スタンプ描画
 * - 指先で隠れない ×3.5倍 十字クロスヘア付き自動拡大ルーペ (Fat Finger 対策)
 * - 放射状フェザー減衰モヤ・4頂点マスク・ウォーターマーク・プリント枠キャプションのリアルタイム合成描画
 * - PC母艦および将来のモバイル (TETHERACT ld) 双方で再利用可能な DOM 非依存クラス設計
 */

(function () {
  'use strict';

  const MATTE_PALETTES = {
    white: {
      bg: '#FFFFFF',
      textMain: '#1A1A1A',
      textSub: '#6B7280',
      divider: '#D1D5DB',
      innerBorder: 'rgba(0, 0, 0, 0.10)',
      shadowColor: 'rgba(0, 0, 0, 0.20)',
    },
    paper: {
      bg: '#F6F4EE',
      textMain: '#2A2926',
      textSub: '#6E6A61',
      divider: '#CFCBC0',
      innerBorder: 'rgba(42, 41, 38, 0.13)',
      shadowColor: 'rgba(30, 28, 24, 0.22)',
    },
    sumi: {
      bg: '#151619',
      textMain: '#ECEAE4',
      textSub: '#8E95A2',
      divider: '#343842',
      innerBorder: 'rgba(255, 255, 255, 0.14)',
      shadowColor: 'rgba(0, 0, 0, 0.65)',
    },
  };

  function clamp(val, minVal, maxVal) {
    return Math.max(minVal, Math.min(maxVal, val));
  }

  function pointInQuad(nx, ny, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x;
      const yi = pts[i].y;
      const xj = pts[j].x;
      const yj = pts[j].y;
      const intersect = ((yi > ny) !== (yj > ny)) &&
        (nx < ((xj - xi) * (ny - yi)) / ((yj - yi) || 1e-7) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b]
      .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  class PrivacyMaskCanvasEditor {
    /**
     * @param {HTMLCanvasElement} canvasEl 描画先キャンバス要素
     * @param {Object} callbacks イベントコールバック群
     */
    constructor(canvasEl, callbacks = {}) {
      this.canvas = canvasEl;
      this.ctx = canvasEl.getContext('2d');
      this.callbacks = callbacks || {};

      this.sourceImg = null;
      this.photoMeta = {};
      this.viewMode = 'mask'; // 'mask' (Step1: ズーム編集) | 'decorated' (Step2/3: 仕上がり全体)
      this.toolMode = 'edit'; // 'edit' | 'stamp' | 'pan' | 'eyedrop'

      this.zoom = 1.0;
      this.panX = 0;
      this.panY = 0;
      this.loupeEnabled = true;
      this.hideGuides = false;

      this.plates = [];
      this.faces = [];
      this.selected = null; // { type: 'plate' | 'face', id: number }
      this._nextId = 1;

      this.defaultPlateStyle = 'solid';
      this.defaultPlateColor = '#F4F6F9';
      this.defaultPlateFeather = 0.45;
      this.defaultHazeStyle = 'frosted';
      this.defaultStampRadius = 0.048;
      this.defaultStampStrength = 0.88;

      this.frameConfig = { enabled: true };
      this.watermarkConfig = { enabled: false };
      this.artPreset = 'for_x';
      this.logoImageEl = null;

      // オフスクリーンバッファ
      this._maskedOff = document.createElement('canvas');
      this._maskedCtx = this._maskedOff.getContext('2d');
      this._blurOff = document.createElement('canvas');
      this._blurCtx = this._blurOff.getContext('2d');
      this._stampOff = document.createElement('canvas');
      this._stampCtx = this._stampOff.getContext('2d');
      this._mosaicOff = document.createElement('canvas');
      this._mosaicCtx = this._mosaicOff.getContext('2d');
      this._decoratedOff = document.createElement('canvas');
      this._decoratedCtx = this._decoratedOff.getContext('2d');
      this._colorSampleOff = document.createElement('canvas');
      this._colorSampleCtx = this._colorSampleOff.getContext('2d', { willReadFrequently: true });

      this._blurCacheKey = '';
      this._vp = { fitScale: 1, scale: 1, originX: 0, originY: 0, pw: 1200, ph: 800, pLong: 1200 };
      this._lastFinalDimensions = { width: 0, height: 0 };

      this._pointers = new Map();
      this._pinch = null;
      this._activeDrag = null;
      this._loupeFocus = null;

      this._bindCanvasEvents();
    }

    setPhotoSource(imgEl, photoMeta = {}, masks = null) {
      this.sourceImg = imgEl;
      this.photoMeta = photoMeta || {};
      this.zoom = 1.0;
      this.panX = 0;
      this.panY = 0;
      this._blurCacheKey = '';
      this._activeDrag = null;
      this._loupeFocus = null;

      if (masks) {
        this.setMasks(masks.plates || [], masks.faces || []);
      } else {
        this.plates = [];
        this.faces = [];
        this.selected = null;
      }
      this.render();
    }

    setMasks(plates, faces) {
      this.plates = (plates || []).map((p) => ({
        id: p.id || this._nextId++,
        pts: (p.pts || []).slice(0, 4).map((pt) => ({
          x: clamp(Number(pt.x) || 0, 0, 1),
          y: clamp(Number(pt.y) || 0, 0, 1),
        })),
        style: p.style || this.defaultPlateStyle,
        color: p.color || this.defaultPlateColor,
        feather: clamp(Number(p.feather ?? this.defaultPlateFeather), 0, 1),
      })).filter((p) => p.pts.length === 4);

      this.faces = (faces || []).map((f) => ({
        id: f.id || this._nextId++,
        x: clamp(Number(f.x) || 0.5, 0, 1),
        y: clamp(Number(f.y) || 0.5, 0, 1),
        r: clamp(Number(f.r) || this.defaultStampRadius, 0.012, 0.35),
        style: f.style || this.defaultHazeStyle,
        strength: clamp(Number(f.strength ?? this.defaultStampStrength), 0.35, 1.0),
      }));

      if (this.plates.length > 0) {
        this.selected = { type: 'plate', id: this.plates[0].id };
      } else if (this.faces.length > 0) {
        this.selected = { type: 'face', id: this.faces[0].id };
      } else {
        this.selected = null;
      }
      this._notifyChange();
      this.render();
    }

    getMasksPayload() {
      return {
        enabled: true,
        plate_feather: Number(this.defaultPlateFeather.toFixed(3)),
        plates: this.plates.map((p) => ({
          pts: p.pts.map((pt) => ({ x: Number(pt.x.toFixed(5)), y: Number(pt.y.toFixed(5)) })),
          style: p.style,
          color: p.color,
          feather: Number(clamp(Number(p.feather ?? this.defaultPlateFeather), 0, 1).toFixed(3)),
        })),
        faces: this.faces.map((f) => ({
          x: Number(f.x.toFixed(5)),
          y: Number(f.y.toFixed(5)),
          r: Number(f.r.toFixed(5)),
          style: f.style,
          strength: Number((f.strength ?? 0.88).toFixed(3)),
        })),
      };
    }

    setDecoratorState({ viewMode, frameConfig, watermarkConfig, artPreset, logoDataUrl }) {
      if (viewMode) this.viewMode = viewMode;
      if (frameConfig) this.frameConfig = frameConfig;
      if (watermarkConfig) this.watermarkConfig = watermarkConfig;
      if (artPreset !== undefined) this.artPreset = artPreset;

      if (logoDataUrl !== undefined) {
        if (!logoDataUrl) {
          this.logoImageEl = null;
          this.render();
        } else if (!this.logoImageEl || this.logoImageEl._srcKey !== logoDataUrl) {
          const img = new Image();
          img._srcKey = logoDataUrl;
          img.onload = () => {
            this.logoImageEl = img;
            this.render();
          };
          img.src = logoDataUrl;
          return;
        }
      }
      this.render();
    }

    setToolMode(mode) {
      this.toolMode = mode;
      if (typeof this.callbacks.onToolModeChange === 'function') {
        this.callbacks.onToolModeChange(mode);
      }
      this.render();
    }

    addPlateAtViewportCenter() {
      const vp = this._vp;
      const cw = this.canvas.width || 800;
      const ch = this.canvas.height || 540;
      const cxNorm = vp.scale > 0
        ? clamp((cw * 0.5 - vp.originX) / (vp.pw * vp.scale), 0.12, 0.88)
        : 0.5;
      const cyNorm = vp.scale > 0
        ? clamp((ch * 0.5 - vp.originY) / (vp.ph * vp.scale), 0.12, 0.88)
        : 0.62;
      const halfW = clamp(0.085 / Math.max(1, this.zoom * 0.65), 0.02, 0.18);
      const halfH = clamp(0.046 / Math.max(1, this.zoom * 0.65), 0.012, 0.12);

      const newPlate = {
        id: this._nextId++,
        pts: [
          { x: clamp(cxNorm - halfW, 0, 1), y: clamp(cyNorm - halfH, 0, 1) },
          { x: clamp(cxNorm + halfW, 0, 1), y: clamp(cyNorm - halfH, 0, 1) },
          { x: clamp(cxNorm + halfW, 0, 1), y: clamp(cyNorm + halfH, 0, 1) },
          { x: clamp(cxNorm - halfW, 0, 1), y: clamp(cyNorm + halfH, 0, 1) },
        ],
        style: this.defaultPlateStyle,
        color: this.defaultPlateColor,
        feather: this.defaultPlateFeather,
      };
      this.plates.push(newPlate);
      this.selected = { type: 'plate', id: newPlate.id };
      this.setToolMode('edit');
      this._notifyChange();
      this.render();
    }

    deleteSelected() {
      if (!this.selected) return;
      if (this.selected.type === 'plate') {
        this.plates = this.plates.filter((p) => p.id !== this.selected.id);
      } else {
        this.faces = this.faces.filter((f) => f.id !== this.selected.id);
      }
      this.selected = null;
      this._notifyChange();
      this.render();
    }

    clearAll() {
      this.plates = [];
      this.faces = [];
      this.selected = null;
      this._notifyChange();
      this.render();
    }

    selectAndFocusMask(type, id) {
      this.selected = { type, id };
      this.focusOnSelectedMask();
      this._notifyChange();
    }

    focusOnSelectedMask() {
      if (!this.selected) {
        if (this.plates.length > 0) this.selected = { type: 'plate', id: this.plates[0].id };
        else if (this.faces.length > 0) this.selected = { type: 'face', id: this.faces[0].id };
        else return;
      }

      let minX = 1;
      let maxX = 0;
      let minY = 1;
      let maxY = 0;

      if (this.selected.type === 'plate') {
        const p = this.plates.find((x) => x.id === this.selected.id);
        if (!p) return;
        p.pts.forEach((pt) => {
          minX = Math.min(minX, pt.x);
          maxX = Math.max(maxX, pt.x);
          minY = Math.min(minY, pt.y);
          maxY = Math.max(maxY, pt.y);
        });
      } else {
        const f = this.faces.find((x) => x.id === this.selected.id);
        if (!f) return;
        minX = f.x - f.r;
        maxX = f.x + f.r;
        minY = f.y - f.r;
        maxY = f.y + f.r;
      }

      const cxNorm = (minX + maxX) * 0.5;
      const cyNorm = (minY + maxY) * 0.5;
      const spanNorm = Math.max(0.055, maxX - minX, maxY - minY);
      const targetZoom = clamp(0.36 / spanNorm, 2.2, 7.0);

      this.zoom = targetZoom;
      const vw = this.canvas.width;
      const vh = this.canvas.height;
      const newScale = this._vp.fitScale * this.zoom;
      this.panX = vw * 0.5 - cxNorm * this._vp.pw * newScale - (vw - this._vp.pw * newScale) * 0.5;
      this.panY = vh * 0.5 - cyNorm * this._vp.ph * newScale - (vh - this._vp.ph * newScale) * 0.5;
      this.render();
      this._notifyZoom();
    }

    resetZoom() {
      this.zoom = 1.0;
      this.panX = 0;
      this.panY = 0;
      this.render();
      this._notifyZoom();
    }

    zoomByFactor(factor, centerVx, centerVy) {
      const vw = this.canvas.width;
      const vh = this.canvas.height;
      const vx = centerVx !== undefined ? centerVx : vw * 0.5;
      const vy = centerVy !== undefined ? centerVy : vh * 0.5;
      this._setZoomAroundPoint(this.zoom * factor, vx, vy);
    }

    applyPlateStyle(style, hexColor, feather) {
      if (style) this.defaultPlateStyle = style;
      if (hexColor) this.defaultPlateColor = hexColor;
      if (feather !== undefined && feather !== null) {
        this.defaultPlateFeather = clamp(Number(feather), 0, 1);
      }
      if (this.selected && this.selected.type === 'plate') {
        const p = this.plates.find((x) => x.id === this.selected.id);
        if (p) {
          if (style) p.style = style;
          if (hexColor) p.color = hexColor;
          if (feather !== undefined && feather !== null) p.feather = this.defaultPlateFeather;
        }
      } else if (feather !== undefined && feather !== null) {
        this.plates.forEach((p) => {
          p.feather = this.defaultPlateFeather;
        });
      }
      this._notifyChange();
      this.render();
    }

    applyFaceStyle({ style, radius, strength }) {
      if (style) this.defaultHazeStyle = style;
      if (radius !== undefined) this.defaultStampRadius = radius;
      if (strength !== undefined) this.defaultStampStrength = strength;

      if (this.selected && this.selected.type === 'face') {
        const f = this.faces.find((x) => x.id === this.selected.id);
        if (f) {
          if (style) f.style = style;
          if (radius !== undefined) f.r = radius;
          if (strength !== undefined) f.strength = strength;
        }
      }
      this._notifyChange();
      this.render();
    }

    getEstimatedOutputDimensions() {
      return this._lastFinalDimensions;
    }

    _setZoomAroundPoint(nextZoom, vx, vy) {
      const clamped = clamp(nextZoom, 1.0, 8.0);
      const { fitScale, scale, originX, originY, pw, ph } = this._vp;
      const vw = this.canvas.width;
      const vh = this.canvas.height;

      const nx0 = scale > 0 ? (vx - originX) / (pw * scale) : 0.5;
      const ny0 = scale > 0 ? (vy - originY) / (ph * scale) : 0.5;

      if (clamped <= 1.01) {
        this.zoom = 1.0;
        this.panX = 0;
        this.panY = 0;
      } else {
        this.zoom = clamped;
        const newScale = fitScale * clamped;
        this.panX = vx - nx0 * pw * newScale - (vw - pw * newScale) * 0.5;
        this.panY = vy - ny0 * ph * newScale - (vh - ph * newScale) * 0.5;
      }
      this.render();
      this._notifyZoom();
    }

    _syncCanvasResolution() {
      const rect = this.canvas.parentElement
        ? this.canvas.parentElement.getBoundingClientRect()
        : { width: 820, height: 520 };
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cssW = Math.max(300, Math.floor(rect.width || 820));
      const isCompact = cssW < 540;
      const cssH = isCompact ? Math.min(430, Math.max(300, Math.round(cssW * 0.92))) : 520;

      const targetW = Math.round(cssW * dpr);
      const targetH = Math.round(cssH * dpr);
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        this.canvas.style.height = `${cssH}px`;
      }
      return dpr;
    }

    _buildMaskedOffscreen() {
      const src = this.sourceImg;
      if (!src) return null;
      const origW = src.naturalWidth || src.width || 1200;
      const origH = src.naturalHeight || src.height || 800;

      const maxPreviewLong = 1440;
      let pw;
      let ph;
      if (origW >= origH) {
        pw = Math.min(origW, maxPreviewLong);
        ph = Math.max(1, Math.round(origH * (pw / origW)));
      } else {
        ph = Math.min(origH, maxPreviewLong);
        pw = Math.max(1, Math.round(origW * (ph / origH)));
      }
      const pLong = Math.max(pw, ph);

      this._maskedOff.width = pw;
      this._maskedOff.height = ph;
      const mCtx = this._maskedCtx;
      mCtx.drawImage(src, 0, 0, pw, ph);

      const cacheKey = `${this.photoMeta.id || 0}_${origW}_${origH}_${pw}_${ph}`;
      if (this._blurCacheKey !== cacheKey) {
        this._blurOff.width = pw;
        this._blurOff.height = ph;
        const bPx = Math.max(12, Math.round(pLong * 0.022));
        this._blurCtx.filter = `blur(${bPx}px)`;
        this._blurCtx.drawImage(src, -bPx, -bPx, pw + bPx * 2, ph + bPx * 2);
        this._blurCtx.filter = 'none';

        this._colorSampleOff.width = 320;
        this._colorSampleOff.height = Math.max(1, Math.round(320 * (ph / pw)));
        this._colorSampleCtx.drawImage(src, 0, 0, this._colorSampleOff.width, this._colorSampleOff.height);
        this._blurCacheKey = cacheKey;
      }

      const expandPtsPx = (srcPts, deltaPx) => {
        if (deltaPx <= 0) return srcPts;
        const cx = (srcPts[0].x + srcPts[1].x + srcPts[2].x + srcPts[3].x) * 0.25;
        const cy = (srcPts[0].y + srcPts[1].y + srcPts[2].y + srcPts[3].y) * 0.25;
        return srcPts.map((pt) => {
          const dx = pt.x - cx;
          const dy = pt.y - cy;
          const dist = Math.hypot(dx, dy);
          if (dist < 1e-3) return { x: pt.x, y: pt.y };
          const sc = (dist + deltaPx) / dist;
          return { x: cx + dx * sc, y: cy + dy * sc };
        });
      };

      // 1. ナンバープレート4頂点合成（フチのモヤ・ソフトフェザー対応）
      this.plates.forEach((plate) => {
        const pts = plate.pts.map((p) => ({ x: p.x * pw, y: p.y * ph }));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const plateShort = Math.max(6, Math.min(maxX - minX, maxY - minY));
        const feather = clamp(Number(plate.feather ?? this.defaultPlateFeather), 0, 1);
        const featherPx = feather > 0.02 ? Math.max(1.4, plateShort * 0.22 * feather) : 0;

        if (featherPx <= 0) {
          mCtx.save();
          mCtx.beginPath();
          mCtx.moveTo(pts[0].x, pts[0].y);
          mCtx.lineTo(pts[1].x, pts[1].y);
          mCtx.lineTo(pts[2].x, pts[2].y);
          mCtx.lineTo(pts[3].x, pts[3].y);
          mCtx.closePath();

          if (plate.style === 'blur') {
            mCtx.clip();
            mCtx.drawImage(this._blurOff, 0, 0);
          } else if (plate.style === 'mosaic') {
            mCtx.clip();
            const mw = Math.max(16, Math.round(pw / 46));
            const mh = Math.max(12, Math.round(ph / 46));
            this._mosaicOff.width = mw;
            this._mosaicOff.height = mh;
            this._mosaicCtx.drawImage(src, 0, 0, mw, mh);
            mCtx.imageSmoothingEnabled = false;
            mCtx.drawImage(this._mosaicOff, 0, 0, mw, mh, 0, 0, pw, ph);
            mCtx.imageSmoothingEnabled = true;
          } else {
            mCtx.fillStyle = plate.color || '#F4F6F9';
            mCtx.fill();
          }
          mCtx.restore();
          return;
        }

        const pad = Math.ceil(featherPx * 3.5 + 8);
        const bx1 = Math.max(0, Math.floor(minX) - pad);
        const by1 = Math.max(0, Math.floor(minY) - pad);
        const bx2 = Math.min(pw, Math.ceil(maxX) + pad);
        const by2 = Math.min(ph, Math.ceil(maxY) + pad);
        const bw = bx2 - bx1;
        const bh = by2 - by1;
        if (bw < 2 || bh < 2) return;

        const sCtx = this._stampCtx;
        this._stampOff.width = bw;
        this._stampOff.height = bh;

        if (plate.style === 'blur' || plate.style === 'mosaic') {
          sCtx.clearRect(0, 0, bw, bh);
          sCtx.globalCompositeOperation = 'source-over';
          sCtx.filter = 'none';
          if (plate.style === 'blur') {
            sCtx.drawImage(this._blurOff, bx1, by1, bw, bh, 0, 0, bw, bh);
          } else {
            const mw = Math.max(16, Math.round(pw / 46));
            const mh = Math.max(12, Math.round(ph / 46));
            this._mosaicOff.width = mw;
            this._mosaicOff.height = mh;
            this._mosaicCtx.drawImage(src, 0, 0, mw, mh);
            sCtx.imageSmoothingEnabled = false;
            sCtx.drawImage(this._mosaicOff, 0, 0, mw, mh, -bx1, -by1, pw, ph);
            sCtx.imageSmoothingEnabled = true;
          }
          const corePts = expandPtsPx(pts, featherPx * 0.55);
          sCtx.globalCompositeOperation = 'destination-in';
          sCtx.filter = `blur(${featherPx.toFixed(1)}px)`;
          sCtx.fillStyle = '#000000';
          sCtx.beginPath();
          sCtx.moveTo(corePts[0].x - bx1, corePts[0].y - by1);
          sCtx.lineTo(corePts[1].x - bx1, corePts[1].y - by1);
          sCtx.lineTo(corePts[2].x - bx1, corePts[2].y - by1);
          sCtx.lineTo(corePts[3].x - bx1, corePts[3].y - by1);
          sCtx.closePath();
          sCtx.fill();
          sCtx.filter = 'none';
          sCtx.globalCompositeOperation = 'source-over';
          mCtx.drawImage(this._stampOff, bx1, by1);
        } else {
          // カラー塗り＋フチモヤ: 先に下地すりガラスモヤを敷いてからソフトフェザー塗りを重ねる
          const underPts = expandPtsPx(pts, featherPx * 1.15);
          sCtx.clearRect(0, 0, bw, bh);
          sCtx.globalCompositeOperation = 'source-over';
          sCtx.filter = 'none';
          sCtx.drawImage(this._blurOff, bx1, by1, bw, bh, 0, 0, bw, bh);
          sCtx.globalCompositeOperation = 'destination-in';
          sCtx.filter = `blur(${(featherPx * 1.35).toFixed(1)}px)`;
          sCtx.fillStyle = 'rgba(0, 0, 0, 0.88)';
          sCtx.beginPath();
          sCtx.moveTo(underPts[0].x - bx1, underPts[0].y - by1);
          sCtx.lineTo(underPts[1].x - bx1, underPts[1].y - by1);
          sCtx.lineTo(underPts[2].x - bx1, underPts[2].y - by1);
          sCtx.lineTo(underPts[3].x - bx1, underPts[3].y - by1);
          sCtx.closePath();
          sCtx.fill();
          sCtx.filter = 'none';
          sCtx.globalCompositeOperation = 'source-over';
          mCtx.drawImage(this._stampOff, bx1, by1);

          const corePts = expandPtsPx(pts, featherPx * 0.55);
          sCtx.clearRect(0, 0, bw, bh);
          sCtx.filter = `blur(${featherPx.toFixed(1)}px)`;
          sCtx.fillStyle = plate.color || '#F4F6F9';
          sCtx.beginPath();
          sCtx.moveTo(corePts[0].x - bx1, corePts[0].y - by1);
          sCtx.lineTo(corePts[1].x - bx1, corePts[1].y - by1);
          sCtx.lineTo(corePts[2].x - bx1, corePts[2].y - by1);
          sCtx.lineTo(corePts[3].x - bx1, corePts[3].y - by1);
          sCtx.closePath();
          sCtx.fill();
          sCtx.filter = 'none';
          mCtx.drawImage(this._stampOff, bx1, by1);
        }
      });

      // 2. 放射状フェザー減衰の顔モヤスタンプ合成
      this.faces.forEach((face) => {
        const cx = face.x * pw;
        const cy = face.y * ph;
        const rad = Math.max(10, face.r * pLong);
        const box = Math.ceil(rad * 2.4);
        const sx = Math.round(cx - box * 0.5);
        const sy = Math.round(cy - box * 0.5);

        this._stampOff.width = box;
        this._stampOff.height = box;
        const sCtx = this._stampCtx;
        sCtx.clearRect(0, 0, box, box);
        sCtx.globalCompositeOperation = 'source-over';
        sCtx.drawImage(this._blurOff, sx, sy, box, box, 0, 0, box, box);

        const str = face.strength ?? 0.88;
        if (face.style === 'milky') {
          sCtx.fillStyle = `rgba(248, 250, 252, ${(0.45 * str).toFixed(2)})`;
          sCtx.fillRect(0, 0, box, box);
        } else if (face.style === 'smoke') {
          sCtx.fillStyle = `rgba(28, 32, 40, ${(0.42 * str).toFixed(2)})`;
          sCtx.fillRect(0, 0, box, box);
        }

        sCtx.globalCompositeOperation = 'destination-in';
        const half = box * 0.5;
        const grad = sCtx.createRadialGradient(half, half, rad * 0.25, half, half, rad);
        grad.addColorStop(0, `rgba(0, 0, 0, ${Math.min(1, str * 1.08).toFixed(2)})`);
        grad.addColorStop(0.58, `rgba(0, 0, 0, ${(str * 0.86).toFixed(2)})`);
        grad.addColorStop(0.85, `rgba(0, 0, 0, ${(str * 0.30).toFixed(2)})`);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        sCtx.fillStyle = grad;
        sCtx.fillRect(0, 0, box, box);

        mCtx.drawImage(this._stampOff, sx, sy);
      });

      return { pw, ph, pLong, origW, origH };
    }

    _computeEstimatedFinalSize(origW, origH) {
      const fc = this.frameConfig || {};
      const frameOn = Boolean(fc.enabled);
      const aspect = fc.aspect_mode || 'original';

      if (this.artPreset === 'for_insta') {
        if (frameOn) {
          return { width: 1080, height: aspect === '1:1' ? 1080 : 1350 };
        }
        const sc = Math.min(1, 1350 / Math.max(origW, origH));
        return { width: Math.round(origW * sc), height: Math.round(origH * sc) };
      }

      // 単位キャンバス寸法を算出
      const borderRatio = clamp(Number(fc.border_ratio) || 0.05, 0.015, 0.18);
      const layout = fc.layout || 'classic';
      let cW = origW;
      let cH = origH;

      if (frameOn) {
        const pad = Math.round(Math.max(origW, origH) * borderRatio);
        let extraBot = pad;
        if (layout === 'classic' || layout === 'editorial') extraBot = Math.round(pad * 2.35);
        else if (layout === 'polaroid') extraBot = Math.round(pad * 3.75);

        if (aspect === '1:1' || aspect === '4:5' || aspect === '16:9') {
          const [aw, ah] = aspect.split(':').map(Number);
          const ratio = aw / ah;
          const minW = origW + pad * 2;
          const minH = origH + pad + extraBot;
          if (minW / minH > ratio) {
            cW = minW;
            cH = Math.round(minW / ratio);
          } else {
            cH = minH;
            cW = Math.round(minH * ratio);
          }
        } else {
          cW = origW + pad * 2;
          cH = origH + pad + extraBot;
        }
      }

      if (this.artPreset === 'for_x') {
        const longLim = 2048;
        const curLong = Math.max(cW, cH);
        if (curLong > longLim) {
          const r = longLim / curLong;
          return { width: Math.round(cW * r), height: Math.round(cH * r) };
        }
      }
      return { width: cW, height: cH };
    }

    _buildDecoratedOffscreen(pw, ph, pLong) {
      const fc = this.frameConfig || {};
      const wc = this.watermarkConfig || {};
      const frameOn = Boolean(fc.enabled);
      const pal = MATTE_PALETTES[fc.matte || 'white'] || MATTE_PALETTES.white;
      const layout = fc.layout || 'classic';
      const aspect = fc.aspect_mode || 'original';
      const borderRatio = clamp(Number(fc.border_ratio) || 0.05, 0.015, 0.18);

      let outW = pw;
      let outH = ph;
      let ox = 0;
      let oy = 0;
      let botSpace = 0;
      let drawPw = pw;
      let drawPh = ph;

      if (this.artPreset === 'for_insta' && frameOn) {
        outW = 1080;
        outH = aspect === '1:1' ? 1080 : 1350;
        const padPx = Math.max(16, Math.round(Math.max(outW, outH) * borderRatio * 0.85));
        let botPx = padPx;
        if (layout === 'classic' || layout === 'editorial') botPx = Math.round(padPx * 2.35);
        else if (layout === 'polaroid') botPx = Math.round(padPx * 3.6);

        const availW = Math.max(64, outW - padPx * 2);
        const availH = Math.max(64, outH - padPx - botPx);
        const sc = Math.min(availW / pw, availH / ph);
        drawPw = Math.max(1, Math.round(pw * sc));
        drawPh = Math.max(1, Math.round(ph * sc));
        ox = Math.round((outW - drawPw) * 0.5);
        const availV = Math.max(0, outH - drawPh);
        oy = layout === 'border_only'
          ? Math.round(availV * 0.5)
          : Math.max(padPx, Math.round((availV - (botPx - padPx)) * 0.5));
        botSpace = Math.max(0, outH - (oy + drawPh));
      } else if (frameOn) {
        const pad = Math.max(8, Math.round(pLong * borderRatio));
        let extraBot = pad;
        if (layout === 'classic' || layout === 'editorial') extraBot = Math.round(pad * 2.35);
        else if (layout === 'polaroid') extraBot = Math.round(pad * 3.75);

        if (aspect === '1:1' || aspect === '4:5' || aspect === '16:9') {
          const [aw, ah] = aspect.split(':').map(Number);
          const ratio = aw / ah;
          const minW = pw + pad * 2;
          const minH = ph + pad + extraBot;
          if (minW / minH > ratio) {
            outW = minW;
            outH = Math.round(minW / ratio);
          } else {
            outH = minH;
            outW = Math.round(minH * ratio);
          }
          ox = Math.round((outW - pw) * 0.5);
          const availV = outH - ph;
          oy = layout === 'border_only'
            ? Math.round(availV * 0.5)
            : Math.max(pad, Math.round((availV - (extraBot - pad)) * 0.5));
          botSpace = Math.max(0, outH - (oy + ph));
        } else {
          outW = pw + pad * 2;
          outH = ph + pad + extraBot;
          ox = pad;
          oy = pad;
          botSpace = extraBot;
        }
      }

      this._decoratedOff.width = outW;
      this._decoratedOff.height = outH;
      const dCtx = this._decoratedCtx;

      if (frameOn) {
        dCtx.fillStyle = pal.bg;
        dCtx.fillRect(0, 0, outW, outH);
      } else {
        dCtx.clearRect(0, 0, outW, outH);
      }

      const drawLong = Math.max(drawPw, drawPh);

      // ドロップシャドウ
      if (frameOn && fc.photo_shadow) {
        dCtx.save();
        dCtx.shadowColor = pal.shadowColor;
        dCtx.shadowBlur = Math.max(6, Math.round(drawLong * 0.016));
        dCtx.shadowOffsetY = Math.max(2, Math.round(drawLong * 0.0045));
        dCtx.fillStyle = pal.bg;
        dCtx.fillRect(ox, oy, drawPw, drawPh);
        dCtx.restore();
      }

      // マスク適用済み写真を描画
      dCtx.drawImage(this._maskedOff, 0, 0, pw, ph, ox, oy, drawPw, drawPh);

      // ウォーターマーク合成
      if (wc.enabled) {
        dCtx.save();
        dCtx.beginPath();
        dCtx.rect(ox, oy, drawPw, drawPh);
        dCtx.clip();

        const opacity = clamp(Number(wc.opacity ?? 0.58), 0.05, 1.0);
        const margin = Math.max(10, Math.round(drawLong * 0.024));
        const pos = wc.position || 'bottom-right';
        dCtx.globalAlpha = opacity;

        if (wc.type === 'image' && this.logoImageEl) {
          const scaleRatio = clamp(Number(wc.size_ratio || 0.12), 0.03, 0.45);
          const lw = Math.max(24, Math.round(drawLong * scaleRatio));
          const lh = Math.max(12, Math.round(lw * (this.logoImageEl.naturalHeight / Math.max(1, this.logoImageEl.naturalWidth))));
          const { x: lx, y: ly } = this._anchorRect(ox, oy, drawPw, drawPh, lw, lh, pos, margin);
          dCtx.drawImage(this.logoImageEl, lx, ly, lw, lh);
        } else if ((wc.text || '').trim()) {
          const txt = wc.text.trim();
          const sizeRatio = clamp(Number(wc.size_ratio || 0.018), 0.008, 0.08);
          const fontPx = Math.max(13, Math.round(drawLong * sizeRatio));
          dCtx.font = `500 ${fontPx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          const darkTxt = wc.color === 'dark';
          dCtx.fillStyle = darkTxt ? '#14161A' : '#FFFFFF';
          if (wc.shadow !== false) {
            dCtx.shadowColor = darkTxt ? 'rgba(255,255,255,0.58)' : 'rgba(0,0,0,0.68)';
            dCtx.shadowBlur = Math.max(3, Math.round(fontPx * 0.24));
            dCtx.shadowOffsetY = Math.max(1, Math.round(fontPx * 0.06));
          }
          let wx = ox + drawPw - margin;
          let wy = oy + drawPh - margin;
          dCtx.textAlign = 'right';
          dCtx.textBaseline = 'bottom';
          if (pos === 'top-left') { wx = ox + margin; wy = oy + margin; dCtx.textAlign = 'left'; dCtx.textBaseline = 'top'; }
          else if (pos === 'top-right') { wx = ox + drawPw - margin; wy = oy + margin; dCtx.textAlign = 'right'; dCtx.textBaseline = 'top'; }
          else if (pos === 'bottom-left') { wx = ox + margin; wy = oy + drawPh - margin; dCtx.textAlign = 'left'; dCtx.textBaseline = 'bottom'; }
          else if (pos === 'bottom-center') { wx = ox + drawPw * 0.5; wy = oy + drawPh - margin; dCtx.textAlign = 'center'; dCtx.textBaseline = 'bottom'; }
          else if (pos === 'center') { wx = ox + drawPw * 0.5; wy = oy + drawPh * 0.5; dCtx.textAlign = 'center'; dCtx.textBaseline = 'middle'; }
          dCtx.fillText(txt, wx, wy);
        }
        dCtx.restore();
      }

      // 極細1px境界線
      if (frameOn && fc.inner_border !== false) {
        dCtx.save();
        dCtx.strokeStyle = pal.innerBorder;
        dCtx.lineWidth = Math.max(1, Math.round(drawLong * 0.0009));
        dCtx.strokeRect(ox + 0.5, oy + 0.5, drawPw - 1, drawPh - 1);
        dCtx.restore();
      }

      // EXIF キャプション描画
      if (frameOn && layout !== 'border_only' && botSpace >= 18) {
        this._drawCaptionOnContext(dCtx, outW, outH, ox, oy, drawPw, drawPh, botSpace, pal, fc);
      }
    }

    _anchorRect(ox, oy, w, h, iw, ih, pos, margin) {
      if (pos === 'top-left') return { x: ox + margin, y: oy + margin };
      if (pos === 'top-right') return { x: ox + w - iw - margin, y: oy + margin };
      if (pos === 'bottom-left') return { x: ox + margin, y: oy + h - ih - margin };
      if (pos === 'bottom-center') return { x: ox + (w - iw) * 0.5, y: oy + h - ih - margin };
      if (pos === 'center') return { x: ox + (w - iw) * 0.5, y: oy + (h - ih) * 0.5 };
      return { x: ox + w - iw - margin, y: oy + h - ih - margin };
    }

    _buildCaptionStrings(fc) {
      const m = this.photoMeta || {};
      let camera = '';
      if (fc.show_camera !== false) {
        const rawCam = String(m.camera_model || '').trim();
        if (rawCam && rawCam !== '不明' && rawCam !== 'RAW写真') camera = rawCam;
      }
      let lens = '';
      if (fc.show_lens !== false) {
        const rawLens = String(m.lens_model || '').trim();
        if (rawLens && rawLens !== '不明' && rawLens !== '----') lens = rawLens;
      }
      let exposure = '';
      if (fc.show_exposure !== false) {
        const ex = [];
        if (m.focal_length != null && m.focal_length !== '') {
          const fl = Number(m.focal_length);
          if (!isNaN(fl) && fl > 0) ex.push(Number.isInteger(fl) ? `${fl}mm` : `${fl.toFixed(1)}mm`);
        }
        if (m.f_number != null && m.f_number !== '') {
          const fn = Number(m.f_number);
          if (!isNaN(fn) && fn > 0) ex.push(`F${fn.toFixed(1).replace(/\.0$/, '')}`);
        }
        if (m.shutter_speed) {
          const ss = String(m.shutter_speed).trim();
          ex.push(ss.endsWith('s') ? ss : `${ss}s`);
        }
        if (m.iso) ex.push(`ISO${m.iso}`);
        exposure = ex.join('  ');
      }
      const extraArr = [];
      if (fc.show_date && m.date_taken && String(m.date_taken).length >= 10) {
        extraArr.push(String(m.date_taken).slice(0, 10).replace(/[-:]/g, '.'));
      }
      if (fc.show_location) {
        const locs = [m.city, m.state, m.country]
          .map((v) => String(v || '').trim())
          .filter((v) => v && v !== '不明' && v !== 'Unknown');
        if (locs.length > 0) extraArr.push(locs.slice(0, 2).join(', '));
      }
      if (fc.show_note && (fc.custom_note || '').trim()) {
        extraArr.push(fc.custom_note.trim());
      }
      return { camera, lens, exposure, extra: extraArr.join('  ·  ') };
    }

    _drawCaptionOnContext(dCtx, outW, outH, ox, oy, pw, ph, botSpace, pal, fc) {
      const parts = this._buildCaptionStrings(fc);
      const baseRef = Math.min(outW, outH);
      const fontScale = clamp(Number(fc.font_scale || 1.0), 0.65, 1.5);
      const titlePx = Math.max(12, Math.round(baseRef * 0.020 * fontScale));
      const subPx = Math.max(10, Math.round(baseRef * 0.0145 * fontScale));
      const areaCy = oy + ph + Math.round(botSpace * 0.52);
      const layout = fc.layout || 'classic';

      dCtx.save();
      if (layout === 'editorial') {
        const leftP = parts.camera || parts.lens;
        const leftS = parts.camera ? parts.lens : '';
        const rightP = parts.exposure || parts.extra;
        const rightS = parts.exposure ? parts.extra : '';

        const leftEdge = pw >= outW * 0.62 ? ox : Math.max(24, Math.round(outW * 0.06));
        const rightEdge = pw >= outW * 0.62 ? ox + pw : outW - leftEdge;
        const maxColW = Math.max(60, Math.round((rightEdge - leftEdge) * 0.48));

        dCtx.textAlign = 'left';
        if (leftP && leftS) {
          dCtx.fillStyle = pal.textMain;
          dCtx.font = `600 ${titlePx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          dCtx.textBaseline = 'bottom';
          dCtx.fillText(leftP, leftEdge, areaCy - Math.round(subPx * 0.2), maxColW);

          dCtx.fillStyle = pal.textSub;
          dCtx.font = `400 ${subPx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          dCtx.textBaseline = 'top';
          dCtx.fillText(leftS, leftEdge, areaCy + Math.round(subPx * 0.22), maxColW);
        } else if (leftP) {
          dCtx.fillStyle = pal.textMain;
          dCtx.font = `600 ${titlePx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          dCtx.textBaseline = 'middle';
          dCtx.fillText(leftP, leftEdge, areaCy, maxColW);
        }

        dCtx.textAlign = 'right';
        let maxRw = 0;
        if (rightP && rightS) {
          dCtx.fillStyle = pal.textMain;
          dCtx.font = `500 ${Math.round(titlePx * 0.9)}px "Inter", "Segoe UI", sans-serif`;
          dCtx.textBaseline = 'bottom';
          dCtx.fillText(rightP, rightEdge, areaCy - Math.round(subPx * 0.2), maxColW);
          maxRw = Math.max(maxRw, Math.min(maxColW, dCtx.measureText(rightP).width));

          dCtx.fillStyle = pal.textSub;
          dCtx.font = `400 ${subPx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          dCtx.textBaseline = 'top';
          dCtx.fillText(rightS, rightEdge, areaCy + Math.round(subPx * 0.22), maxColW);
          maxRw = Math.max(maxRw, Math.min(maxColW, dCtx.measureText(rightS).width));
        } else if (rightP) {
          dCtx.fillStyle = pal.textMain;
          dCtx.font = `500 ${Math.round(titlePx * 0.9)}px "Inter", "Segoe UI", sans-serif`;
          dCtx.textBaseline = 'middle';
          dCtx.fillText(rightP, rightEdge, areaCy, maxColW);
          maxRw = Math.min(maxColW, dCtx.measureText(rightP).width);
        }

        if (leftP && rightP && maxRw > 0) {
          const sepX = rightEdge - maxRw - Math.round(titlePx * 0.92);
          const sepH = Math.round(titlePx * 0.92);
          if (sepX > leftEdge + 40) {
            dCtx.strokeStyle = pal.divider;
            dCtx.lineWidth = Math.max(1, Math.round(Math.max(pw, ph) * 0.0011));
            dCtx.beginPath();
            dCtx.moveTo(sepX, areaCy - sepH);
            dCtx.lineTo(sepX, areaCy + sepH);
            dCtx.stroke();
          }
        }
      } else {
        const line1 = parts.camera || parts.lens;
        const l2Arr = [];
        if (parts.camera && parts.lens) l2Arr.push(parts.lens);
        if (parts.exposure) l2Arr.push(parts.exposure);
        if (parts.extra) l2Arr.push(parts.extra);
        const line2 = l2Arr.join('  ·  ');
        const maxW = Math.max(80, outW - Math.round(outW * 0.08));
        const cx = outW * 0.5;
        dCtx.textAlign = 'center';

        if (line1 && line2) {
          dCtx.fillStyle = pal.textMain;
          dCtx.font = `600 ${titlePx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          dCtx.textBaseline = 'bottom';
          dCtx.fillText(line1, cx, areaCy - Math.round(subPx * 0.22), maxW);

          dCtx.fillStyle = pal.textSub;
          dCtx.font = `400 ${subPx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          dCtx.textBaseline = 'top';
          dCtx.fillText(line2, cx, areaCy + Math.round(subPx * 0.24), maxW);
        } else if (line1 || line2) {
          const single = line1 || line2;
          dCtx.fillStyle = line1 ? pal.textMain : pal.textSub;
          dCtx.font = `${line1 ? 600 : 400} ${line1 ? titlePx : subPx}px "Inter", "Segoe UI", "Yu Gothic UI", sans-serif`;
          dCtx.textBaseline = 'middle';
          dCtx.fillText(single, cx, areaCy, maxW);
        }
      }
      dCtx.restore();
    }

    render() {
      const dpr = this._syncCanvasResolution();
      const vw = this.canvas.width;
      const vh = this.canvas.height;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, vw, vh);

      if (!this.sourceImg) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
        ctx.font = `${Math.round(13 * dpr)}px "Inter", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('写真を読み込んでいます...', vw * 0.5, vh * 0.5);
        return;
      }

      const built = this._buildMaskedOffscreen();
      if (!built) return;
      const { pw, ph, pLong, origW, origH } = built;

      this._lastFinalDimensions = this._computeEstimatedFinalSize(origW, origH);
      if (typeof this.callbacks.onDimensionsUpdate === 'function') {
        this.callbacks.onDimensionsUpdate(this._lastFinalDimensions);
      }

      if (this.viewMode === 'mask') {
        const margin = Math.round(20 * dpr);
        const fitScale = Math.min((vw - margin * 2) / pw, (vh - margin * 2) / ph);
        const scale = fitScale * this.zoom;

        const maxPanX = Math.max(0, (pw * scale - vw * 0.45) * 0.65);
        const maxPanY = Math.max(0, (ph * scale - vh * 0.45) * 0.65);
        this.panX = clamp(this.panX, -maxPanX, maxPanX);
        this.panY = clamp(this.panY, -maxPanY, maxPanY);

        const originX = (vw - pw * scale) * 0.5 + this.panX;
        const originY = (vh - ph * scale) * 0.5 + this.panY;
        this._vp = { fitScale, scale, originX, originY, pw, ph, pLong, dpr };

        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
        ctx.shadowBlur = 16 * dpr;
        ctx.drawImage(this._maskedOff, originX, originY, pw * scale, ph * scale);
        ctx.restore();

        if (!this.hideGuides) {
          this._drawScreenSpaceGuides(originX, originY, pw, ph, pLong, scale, dpr);
        }
        if (this.loupeEnabled && this._loupeFocus && !this.hideGuides) {
          this._drawMagnifierLoupe(vw, vh, dpr);
        }
      } else {
        this._buildDecoratedOffscreen(pw, ph, pLong);
        const outW = this._decoratedOff.width;
        const outH = this._decoratedOff.height;
        const margin = Math.round(20 * dpr);
        const fit = Math.min((vw - margin * 2) / outW, (vh - margin * 2) / outH);
        const dw = outW * fit;
        const dh = outH * fit;
        const dx = (vw - dw) * 0.5;
        const dy = (vh - dh) * 0.5;

        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.34)';
        ctx.shadowBlur = 18 * dpr;
        ctx.drawImage(this._decoratedOff, dx, dy, dw, dh);
        ctx.restore();
      }
    }

    _drawScreenSpaceGuides(ox, oy, pw, ph, pLong, scale, dpr) {
      const ctx = this.ctx;
      const handleR = 7.5 * dpr;

      this.plates.forEach((plate, idx) => {
        const isSel = this.selected && this.selected.type === 'plate' && this.selected.id === plate.id;
        const sPts = plate.pts.map((p) => ({
          x: ox + p.x * pw * scale,
          y: oy + p.y * ph * scale,
        }));

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(sPts[0].x, sPts[0].y);
        ctx.lineTo(sPts[1].x, sPts[1].y);
        ctx.lineTo(sPts[2].x, sPts[2].y);
        ctx.lineTo(sPts[3].x, sPts[3].y);
        ctx.closePath();

        ctx.lineWidth = (isSel ? 2.2 : 1.5) * dpr;
        ctx.strokeStyle = isSel ? '#F59E0B' : 'rgba(245, 158, 11, 0.75)';
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 番号タグ
        const tagW = 34 * dpr;
        const tagH = 16 * dpr;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        ctx.fillRect(sPts[0].x, sPts[0].y - tagH - 4 * dpr, tagW, tagH);
        ctx.fillStyle = '#FBBF24';
        ctx.font = `600 ${Math.round(10.5 * dpr)}px "Inter", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`P#${idx + 1}`, sPts[0].x + tagW * 0.5, sPts[0].y - tagH * 0.5 - 4 * dpr);

        const edgeW = Math.hypot(sPts[1].x - sPts[0].x, sPts[1].y - sPts[0].y);
        const edgeH = Math.hypot(sPts[3].x - sPts[0].x, sPts[3].y - sPts[0].y);
        const plateHandleR = clamp(Math.min(edgeW, edgeH) * 0.22, 4.0 * dpr, handleR);

        sPts.forEach((pt) => {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, plateHandleR, 0, Math.PI * 2);
          ctx.fillStyle = isSel ? '#F59E0B' : '#FFFFFF';
          ctx.fill();
          ctx.lineWidth = 1.6 * dpr;
          ctx.strokeStyle = '#0F172A';
          ctx.stroke();
        });
        ctx.restore();
      });

      this.faces.forEach((face) => {
        const isSel = this.selected && this.selected.type === 'face' && this.selected.id === face.id;
        const sx = ox + face.x * pw * scale;
        const sy = oy + face.y * ph * scale;
        const sr = Math.max(10, face.r * pLong) * scale;

        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.lineWidth = (isSel ? 2.0 : 1.4) * dpr;
        ctx.strokeStyle = isSel ? '#38BDF8' : 'rgba(56, 189, 248, 0.72)';
        ctx.setLineDash([5 * dpr, 5 * dpr]);
        ctx.stroke();
        ctx.setLineDash([]);

        if (isSel) {
          ctx.beginPath();
          ctx.arc(sx + sr, sy, handleR, 0, Math.PI * 2);
          ctx.fillStyle = '#38BDF8';
          ctx.fill();
          ctx.lineWidth = 1.8 * dpr;
          ctx.strokeStyle = '#0F172A';
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    _drawMagnifierLoupe(vw, vh, dpr) {
      const src = this.sourceImg;
      if (!src) return;
      const { nx, ny, vx } = this._loupeFocus;
      const loupeR = 64 * dpr;
      const pad = 14 * dpr;
      const lx = vx < vw * 0.48 ? vw - loupeR - pad : loupeR + pad;
      const ly = loupeR + pad;

      const origW = src.naturalWidth || src.width;
      const origH = src.naturalHeight || src.height;
      const cropSpanNorm = 0.072 / Math.max(1, this.zoom * 0.45);
      const cropW = origW * cropSpanNorm;
      const cropH = cropW;
      const sx = nx * origW - cropW * 0.5;
      const sy = ny * origH - cropH * 0.5;

      const ctx = this.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, loupeR + 2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 12 * dpr;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(lx, ly, loupeR, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = '#0F172A';
      ctx.fillRect(lx - loupeR, ly - loupeR, loupeR * 2, loupeR * 2);
      ctx.drawImage(src, sx, sy, cropW, cropH, lx - loupeR, ly - loupeR, loupeR * 2, loupeR * 2);

      if (this.selected && this.selected.type === 'plate') {
        const selPlate = this.plates.find((p) => p.id === this.selected.id);
        if (selPlate) {
          ctx.beginPath();
          selPlate.pts.forEach((pt, i) => {
            const pxL = lx + ((pt.x * origW - nx * origW) / (cropW * 0.5)) * loupeR;
            const pyL = ly + ((pt.y * origH - ny * origH) / (cropH * 0.5)) * loupeR;
            if (i === 0) ctx.moveTo(pxL, pyL);
            else ctx.lineTo(pxL, pyL);
          });
          ctx.closePath();
          ctx.fillStyle = 'rgba(245, 158, 11, 0.24)';
          ctx.fill();
          ctx.lineWidth = 2 * dpr;
          ctx.strokeStyle = '#F59E0B';
          ctx.stroke();
        }
      }

      // 十字レティクル
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath();
      ctx.moveTo(lx - 14 * dpr, ly);
      ctx.lineTo(lx + 14 * dpr, ly);
      ctx.moveTo(lx, ly - 14 * dpr);
      ctx.lineTo(lx, ly + 14 * dpr);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(lx, ly, loupeR, 0, Math.PI * 2);
      ctx.lineWidth = 2.4 * dpr;
      ctx.strokeStyle = '#F59E0B';
      ctx.stroke();
    }

    _clientToViewport(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const vx = (clientX - rect.left) * (this.canvas.width / Math.max(1, rect.width));
      const vy = (clientY - rect.top) * (this.canvas.height / Math.max(1, rect.height));
      const { originX, originY, pw, ph, scale } = this._vp;
      const nx = scale > 0 ? (vx - originX) / (pw * scale) : 0.5;
      const ny = scale > 0 ? (vy - originY) / (ph * scale) : 0.5;
      return { vx, vy, nx, ny };
    }

    _bindCanvasEvents() {
      this.canvas.addEventListener('wheel', (ev) => {
        if (this.viewMode !== 'mask' || !this.sourceImg) return;
        ev.preventDefault();
        const { vx, vy } = this._clientToViewport(ev.clientX, ev.clientY);
        const factor = ev.deltaY < 0 ? 1.18 : 1 / 1.18;
        this._setZoomAroundPoint(this.zoom * factor, vx, vy);
      }, { passive: false });

      this.canvas.addEventListener('pointerdown', (ev) => {
        if (this.viewMode !== 'mask' || !this.sourceImg) return;
        this.canvas.setPointerCapture(ev.pointerId);
        this._pointers.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });

        // 2本指マルチタッチ：ピンチズーム ＆ 2本指パンを即時優先
        if (this._pointers.size === 2) {
          this._activeDrag = null;
          this._loupeFocus = null;
          const pts = Array.from(this._pointers.values());
          const dist = Math.max(10, Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY));
          const mid = this._clientToViewport((pts[0].clientX + pts[1].clientX) * 0.5, (pts[0].clientY + pts[1].clientY) * 0.5);
          this._pinch = { startDist: dist, startZoom: this.zoom, lastMidVx: mid.vx, lastMidVy: mid.vy };
          this.render();
          return;
        }
        if (this._pointers.size > 2) return;

        const { vx, vy, nx, ny } = this._clientToViewport(ev.clientX, ev.clientY);
        const dpr = this._vp.dpr || 1;

        if (this.toolMode === 'pan' || ev.button === 1) {
          this._activeDrag = { kind: 'pan', startVx: vx, startVy: vy, origPanX: this.panX, origPanY: this.panY };
          return;
        }

        if (this.toolMode === 'eyedrop') {
          if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
            const sw = this._colorSampleOff.width;
            const sh = this._colorSampleOff.height;
            const sx = clamp(Math.floor(nx * sw), 0, sw - 1);
            const sy = clamp(Math.floor(ny * sh), 0, sh - 1);
            const px = this._colorSampleCtx.getImageData(sx, sy, 1, 1).data;
            const hex = rgbToHex(px[0], px[1], px[2]);
            this.applyPlateStyle('solid', hex);
            if (typeof this.callbacks.onEyedropColor === 'function') {
              this.callbacks.onEyedropColor(hex);
            }
            this.setToolMode('edit');
          }
          return;
        }

        const hitScreenPx = (ev.pointerType === 'touch' ? 24 : 15) * dpr;

        // 1. 四つ角ハンドルのヒットテスト
        for (let i = this.plates.length - 1; i >= 0; i--) {
          const plate = this.plates[i];
          for (let c = 0; c < 4; c++) {
            const hx = this._vp.originX + plate.pts[c].x * this._vp.pw * this._vp.scale;
            const hy = this._vp.originY + plate.pts[c].y * this._vp.ph * this._vp.scale;
            if (Math.hypot(hx - vx, hy - vy) <= hitScreenPx) {
              this.selected = { type: 'plate', id: plate.id };
              this._activeDrag = { kind: 'corner', plate, idx: c };
              this._loupeFocus = { nx: plate.pts[c].x, ny: plate.pts[c].y, vx, vy };
              this._notifyChange();
              this.render();
              return;
            }
          }
        }

        // 2. 顔スタンプのリサイズハンドル
        if (this.selected && this.selected.type === 'face') {
          const sf = this.faces.find((f) => f.id === this.selected.id);
          if (sf) {
            const srScreen = Math.max(10, sf.r * this._vp.pLong) * this._vp.scale;
            const hx = this._vp.originX + sf.x * this._vp.pw * this._vp.scale + srScreen;
            const hy = this._vp.originY + sf.y * this._vp.ph * this._vp.scale;
            if (Math.hypot(hx - vx, hy - vy) <= hitScreenPx) {
              this._activeDrag = { kind: 'face_resize', face: sf };
              return;
            }
          }
        }

        // 3. 顔スタンプ移動
        for (let i = this.faces.length - 1; i >= 0; i--) {
          const f = this.faces[i];
          const cx = this._vp.originX + f.x * this._vp.pw * this._vp.scale;
          const cy = this._vp.originY + f.y * this._vp.ph * this._vp.scale;
          const sr = Math.max(10, f.r * this._vp.pLong) * this._vp.scale;
          if (Math.hypot(cx - vx, cy - vy) <= Math.max(sr, hitScreenPx * 0.8)) {
            this.selected = { type: 'face', id: f.id };
            this._activeDrag = { kind: 'face_move', face: f, offNx: f.x - nx, offNy: f.y - ny };
            this._loupeFocus = { nx: f.x, ny: f.y, vx, vy };
            this._notifyChange();
            this.render();
            return;
          }
        }

        // 4. プレート枠全体の移動
        for (let i = this.plates.length - 1; i >= 0; i--) {
          const plate = this.plates[i];
          if (pointInQuad(nx, ny, plate.pts)) {
            this.selected = { type: 'plate', id: plate.id };
            this._activeDrag = {
              kind: 'plate_move',
              plate,
              startNx: nx,
              startNy: ny,
              origPts: plate.pts.map((p) => ({ x: p.x, y: p.y })),
            };
            this._notifyChange();
            this.render();
            return;
          }
        }

        // 5. 顔モヤスタンプ新規貼付
        if (this.toolMode === 'stamp' && nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
          const nf = {
            id: this._nextId++,
            x: nx,
            y: ny,
            r: this.defaultStampRadius,
            style: this.defaultHazeStyle,
            strength: this.defaultStampStrength,
          };
          this.faces.push(nf);
          this.selected = { type: 'face', id: nf.id };
          this._activeDrag = { kind: 'face_move', face: nf, offNx: 0, offNy: 0 };
          this._loupeFocus = { nx, ny, vx, vy };
          this._notifyChange();
          this.render();
          return;
        }

        // ズームイン中に余白をドラッグした場合は自然に画面パン
        if (this.zoom > 1.02) {
          this._activeDrag = { kind: 'pan', startVx: vx, startVy: vy, origPanX: this.panX, origPanY: this.panY };
        } else {
          this.selected = null;
          this._notifyChange();
          this.render();
        }
      });

      this.canvas.addEventListener('pointermove', (ev) => {
        if (!this._pointers.has(ev.pointerId)) return;
        this._pointers.set(ev.pointerId, { clientX: ev.clientX, clientY: ev.clientY });

        if (this._pointers.size === 2 && this._pinch) {
          const pts = Array.from(this._pointers.values());
          const dist = Math.max(10, Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY));
          const mid = this._clientToViewport((pts[0].clientX + pts[1].clientX) * 0.5, (pts[0].clientY + pts[1].clientY) * 0.5);
          this.panX += mid.vx - this._pinch.lastMidVx;
          this.panY += mid.vy - this._pinch.lastMidVy;
          this._pinch.lastMidVx = mid.vx;
          this._pinch.lastMidVy = mid.vy;
          const nextZ = this._pinch.startZoom * (dist / this._pinch.startDist);
          this._setZoomAroundPoint(nextZ, mid.vx, mid.vy);
          return;
        }

        if (!this._activeDrag) return;
        const { vx, vy, nx, ny } = this._clientToViewport(ev.clientX, ev.clientY);
        const d = this._activeDrag;

        if (d.kind === 'pan') {
          this.panX = d.origPanX + (vx - d.startVx);
          this.panY = d.origPanY + (vy - d.startVy);
          this.render();
        } else if (d.kind === 'corner') {
          const cx = clamp(nx, 0, 1);
          const cy = clamp(ny, 0, 1);
          d.plate.pts[d.idx] = { x: cx, y: cy };
          this._loupeFocus = { nx: cx, y: cy, ny: cy, vx, vy };
          this.render();
        } else if (d.kind === 'plate_move') {
          const dx = nx - d.startNx;
          const dy = ny - d.startNy;
          d.plate.pts = d.origPts.map((p) => ({
            x: clamp(p.x + dx, 0, 1),
            y: clamp(p.y + dy, 0, 1),
          }));
          this.render();
        } else if (d.kind === 'face_move') {
          d.face.x = clamp(nx + d.offNx, 0, 1);
          d.face.y = clamp(ny + d.offNy, 0, 1);
          this._loupeFocus = { nx: d.face.x, ny: d.face.y, vx, vy };
          this.render();
        } else if (d.kind === 'face_resize') {
          const cxScreen = this._vp.originX + d.face.x * this._vp.pw * this._vp.scale;
          const cyScreen = this._vp.originY + d.face.y * this._vp.ph * this._vp.scale;
          const distScreen = Math.hypot(vx - cxScreen, vy - cyScreen);
          d.face.r = clamp((distScreen / this._vp.scale) / this._vp.pLong, 0.014, 0.22);
          this.defaultStampRadius = d.face.r;
          this._notifyChange();
          this.render();
        }
      });

      const finishPointer = (ev) => {
        this._pointers.delete(ev.pointerId);
        if (this._pointers.size < 2) this._pinch = null;
        if (this._pointers.size === 0) {
          this._activeDrag = null;
          this._loupeFocus = null;
          this.render();
        }
      };
      this.canvas.addEventListener('pointerup', finishPointer);
      this.canvas.addEventListener('pointercancel', finishPointer);
    }

    _notifyChange() {
      if (typeof this.callbacks.onMasksChange === 'function') {
        this.callbacks.onMasksChange({
          plates: this.plates,
          faces: this.faces,
          selected: this.selected,
        });
      }
    }

    _notifyZoom() {
      if (typeof this.callbacks.onZoomChange === 'function') {
        this.callbacks.onZoomChange(this.zoom);
      }
    }
  }

  window.PrivacyMaskCanvasEditor = PrivacyMaskCanvasEditor;
})();
