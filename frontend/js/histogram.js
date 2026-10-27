/**
 * Photo Manager - オンデマンド RGB・輝度ヒストグラム モジュール (histogram.js)
 *
 * 特徴:
 * 1. デフォルト非表示（常時表示による視界圧迫や通常閲覧時のCPU負荷ゼロ）
 * 2. 3つのシーン（右インスペクタ / ライトボックス / 画像調整モーダル）で [H] キーまたは 📊 ボタンから即座に呼び出し可能
 * 3. 画像調整モーダルでは「明るさ(EV)・コントラスト・彩度」スライダーや「クロップ枠」に0msでリアルタイム連動
 * 4. 3種の表示モード（RGB重畳 / 輝度Luma / RGB 3段パレード）＋ 白飛び・黒つぶれクリッピング警告インジケータ搭載
 */

(function () {
  'use strict';

  const histState = {
    inspectorOpen: false,
    lightboxOpen: false,
    adjustOpen: false,
    mode: localStorage.getItem('pm_hist_mode') || 'rgb', // 'rgb' | 'luma' | 'parade'
    adjustScope: 'crop', // 'crop' | 'full'
    lastInspectorData: null,
    lastLightboxData: null,
    lastAdjustData: null,
  };

  if (!['rgb', 'luma', 'parade'].includes(histState.mode)) {
    histState.mode = 'rgb';
  }

  // 高速サンプリング用オフスクリーンCanvas（最大長辺 220px）
  const SAMPLE_MAX_DIM = 220;
  let _sampleCanvas = null;
  let _sampleCtx = null;

  function getSampleContext(w, h) {
    if (!_sampleCanvas) {
      _sampleCanvas = document.createElement('canvas');
      _sampleCtx = _sampleCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (_sampleCanvas.width !== w || _sampleCanvas.height !== h) {
      _sampleCanvas.width = w;
      _sampleCanvas.height = h;
    }
    return _sampleCtx;
  }

  /**
   * 共通ヒストグラムウィジェット内部HTMLを生成
   * @param {string} prefix 要素IDプレフィックス ('inspHist' | 'lbHist' | 'adjHist')
   * @param {boolean} [withScopeToggle=false] クロップ枠内/全体切替ボタンを表示するか
   */
  function buildHistogramWidgetHtml(prefix, withScopeToggle = false) {
    const scopeBtnHtml = withScopeToggle
      ? `<button type="button" class="hist-scope-pill is-crop" id="${prefix}ScopeBtn" title="集計範囲の切替（切り抜き枠内のみ ⇔ 写真全体）">枠内</button>`
      : '';

    return `
      <div class="hist-widget-header" id="${prefix}Header">
        <div class="hist-widget-title">
          <span>ヒストグラム</span>
          ${scopeBtnHtml}
        </div>
        <div class="hist-widget-controls">
          <div class="hist-mode-pills" role="group" aria-label="ヒストグラム表示モード">
            <button type="button" class="hist-mode-btn" data-mode="rgb" title="RGB重畳 + 輝度ライン">RGB</button>
            <button type="button" class="hist-mode-btn" data-mode="luma" title="輝度 (Luminance) のみ">輝度</button>
            <button type="button" class="hist-mode-btn" data-mode="parade" title="R・G・B 3段分離パレード表示">3色</button>
          </div>
          <button type="button" class="hist-close-btn" id="${prefix}CloseBtn" title="ヒストグラムを閉じる (H)">&times;</button>
        </div>
      </div>
      <div class="hist-canvas-wrap" id="${prefix}CanvasWrap" title="クリックで表示モード切替 (RGB → 輝度 → 3色) / ホバーで階調値確認">
        <canvas class="hist-canvas" id="${prefix}Canvas"></canvas>
        <div class="hist-hover-readout" id="${prefix}Readout"></div>
      </div>
      <div class="hist-stats-row">
        <span class="hist-clip-badge is-shadow" id="${prefix}ShadowBadge" title="黒つぶれ領域（階調 0〜3 のピクセル割合）">
          <span class="hist-clip-dot"></span>
          <span>黒 <strong id="${prefix}ShadowPct">0.0%</strong></span>
        </span>
        <span class="hist-mean-badge" id="${prefix}MeanBadge" title="平均輝度 (0〜255) と露出傾向">
          平均 <strong id="${prefix}MeanVal">-</strong>
        </span>
        <span class="hist-clip-badge is-highlight" id="${prefix}HighlightBadge" title="白飛び領域（階調 252〜255 のピクセル割合）">
          <span>白 <strong id="${prefix}HighlightPct">0.0%</strong></span>
          <span class="hist-clip-dot"></span>
        </span>
      </div>
    `;
  }

  /**
   * 画像要素からRGB・輝度ヒストグラムおよびクリッピング統計を高速算出する（約0.5〜1.5ms）
   * @param {HTMLImageElement} imgEl
   * @param {Object} [options]
   * @param {Object} [options.adjustState] adjust.js の状態オブジェクト（クロップ範囲＆トーン補正反映用）
   * @param {string} [options.scope] 'crop' | 'full'
   */
  function computeHistogramFromImage(imgEl, options = {}) {
    if (!imgEl || !imgEl.complete || !imgEl.naturalWidth || !imgEl.naturalHeight) {
      return null;
    }

    const natW = imgEl.naturalWidth;
    const natH = imgEl.naturalHeight;
    const adj = options.adjustState || null;
    const useCrop = adj && options.scope === 'crop' && adj.containerSize && adj.containerSize.w > 0 && adj.containerSize.h > 0;

    // サンプリング元領域 (sx, sy, sw, sh) の決定
    let sx = 0;
    let sy = 0;
    let sw = natW;
    let sh = natH;

    if (useCrop && adj.crop) {
      const cw = adj.containerSize.w;
      const ch = adj.containerSize.h;
      const rx = Math.max(0, Math.min(1, adj.crop.x / cw));
      const ry = Math.max(0, Math.min(1, adj.crop.y / ch));
      const rw = Math.max(0.05, Math.min(1 - rx, adj.crop.w / cw));
      const rh = Math.max(0.05, Math.min(1 - ry, adj.crop.h / ch));

      // 90度/270度回転時の座標変換
      const rot = ((adj.rotation || 0) % 360 + 360) % 360;
      let nRx = rx, nRy = ry, nRw = rw, nRh = rh;
      if (rot === 90) {
        nRx = ry;
        nRy = 1 - rx - rw;
        nRw = rh;
        nRh = rw;
      } else if (rot === 180) {
        nRx = 1 - rx - rw;
        nRy = 1 - ry - rh;
      } else if (rot === 270) {
        nRx = 1 - ry - rh;
        nRy = rx;
        nRw = rh;
        nRh = rw;
      }

      sx = Math.round(nRx * natW);
      sy = Math.round(nRy * natH);
      sw = Math.max(8, Math.round(nRw * natW));
      sh = Math.max(8, Math.round(nRh * natH));
    }

    const scale = Math.min(1.0, SAMPLE_MAX_DIM / Math.max(sw, sh));
    const dstW = Math.max(16, Math.round(sw * scale));
    const dstH = Math.max(16, Math.round(sh * scale));

    const ctx = getSampleContext(dstW, dstH);
    ctx.clearRect(0, 0, dstW, dstH);

    try {
      ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, dstW, dstH);
    } catch (err) {
      console.warn('[Histogram] drawImage 失敗:', err);
      return null;
    }

    let imgData;
    try {
      imgData = ctx.getImageData(0, 0, dstW, dstH);
    } catch (err) {
      console.warn('[Histogram] getImageData 失敗:', err);
      return null;
    }

    const pixels = imgData.data;
    const rBins = new Uint32Array(256);
    const gBins = new Uint32Array(256);
    const bBins = new Uint32Array(256);
    const yBins = new Uint32Array(256);

    // 画像調整モーダル用のトーン補正パラメータ（adjust.js の CSS filter と完全一致する変換式）
    let hasToneAdjust = false;
    let bFactor = 1.0;
    let cFactor = 1.0;
    let sFactor = 1.0;

    if (adj) {
      const bVal = Number(adj.brightness) || 0;
      const cVal = Number(adj.contrast) || 0;
      const sVal = Number(adj.saturation) || 0;
      if (bVal !== 0 || cVal !== 0 || sVal !== 0) {
        hasToneAdjust = true;
        const ev = Math.max(-3.0, Math.min(3.0, bVal / 10.0));
        bFactor = Math.max(0.1, Math.pow(2.0, ev / 2.2));
        cFactor = Math.max(0.1, 1.0 + (cVal / 100.0) * 0.75);
        sFactor = Math.max(0.0, 1.0 + (sVal / 100.0));
      }
    }

    let validCount = 0;
    let sumY = 0;
    let shadowClipCount = 0;
    let highlightClipCount = 0;

    const len = pixels.length;
    for (let i = 0; i < len; i += 4) {
      const a = pixels[i + 3];
      if (a < 32) continue; // 透明ピクセルは除外

      let r = pixels[i];
      let g = pixels[i + 1];
      let b = pixels[i + 2];

      if (hasToneAdjust) {
        // 1. Brightness
        r *= bFactor;
        g *= bFactor;
        b *= bFactor;

        // 2. Contrast
        if (cFactor !== 1.0) {
          r = (r - 127.5) * cFactor + 127.5;
          g = (g - 127.5) * cFactor + 127.5;
          b = (b - 127.5) * cFactor + 127.5;
        }

        // 3. Saturation (Rec.709 Luma)
        if (sFactor !== 1.0) {
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = lum + (r - lum) * sFactor;
          g = lum + (g - lum) * sFactor;
          b = lum + (b - lum) * sFactor;
        }

        r = r <= 0 ? 0 : (r >= 255 ? 255 : (r + 0.5) | 0);
        g = g <= 0 ? 0 : (g >= 255 ? 255 : (g + 0.5) | 0);
        b = b <= 0 ? 0 : (b >= 255 ? 255 : (b + 0.5) | 0);
      }

      // Rec.709 輝度 (Y = 0.2126 R + 0.7152 G + 0.0722 B) の整数近似
      const y = ((54 * r + 183 * g + 19 * b) >> 8);

      rBins[r]++;
      gBins[g]++;
      bBins[b]++;
      yBins[y]++;

      validCount++;
      sumY += y;

      // 黒つぶれ判定 (輝度 0〜3) / 白飛び判定 (輝度 252〜255 または いずれかの色チャンネル飽和)
      if (y <= 3) {
        shadowClipCount++;
      }
      if (y >= 252 || (r >= 254 && g >= 254 && b >= 254)) {
        highlightClipCount++;
      }
    }

    if (validCount === 0) return null;

    // 波形スケーリング用の基準ピーク値を算出
    // ※0や255の極端なクリッピングスパイクで中間調の山が潰れないよう、階調 2〜253 の最大値を優先参照
    let innerPeakRGB = 1;
    let innerPeakY = 1;
    for (let k = 2; k <= 253; k++) {
      if (rBins[k] > innerPeakRGB) innerPeakRGB = rBins[k];
      if (gBins[k] > innerPeakRGB) innerPeakRGB = gBins[k];
      if (bBins[k] > innerPeakRGB) innerPeakRGB = bBins[k];
      if (yBins[k] > innerPeakY) innerPeakY = yBins[k];
    }

    // もし全体が単色ベタ塗りで端しか無い場合のフォールバック
    const minPeakThreshold = validCount * 0.002;
    if (innerPeakRGB < minPeakThreshold) {
      for (let k = 0; k < 256; k++) {
        if (rBins[k] > innerPeakRGB) innerPeakRGB = rBins[k];
        if (gBins[k] > innerPeakRGB) innerPeakRGB = gBins[k];
        if (bBins[k] > innerPeakRGB) innerPeakRGB = bBins[k];
      }
    }
    if (innerPeakY < minPeakThreshold) {
      for (let k = 0; k < 256; k++) {
        if (yBins[k] > innerPeakY) innerPeakY = yBins[k];
      }
    }

    const meanY = Math.round(sumY / validCount);
    const shadowPct = (shadowClipCount / validCount) * 100;
    const highlightPct = (highlightClipCount / validCount) * 100;

    return {
      rBins,
      gBins,
      bBins,
      yBins,
      peakRGB: Math.max(1, innerPeakRGB * 1.06),
      peakY: Math.max(1, innerPeakY * 1.06),
      validCount,
      meanY,
      shadowPct,
      highlightPct,
    };
  }

  /**
   * 1チャンネルの波形パスを描画するヘルパー
   */
  function drawChannelCurve(ctx, bins, peak, x0, y0, w, h, fillStyle, strokeStyle, lineWidth = 1.25) {
    ctx.beginPath();
    ctx.moveTo(x0, y0 + h);

    const stepX = w / 255;
    for (let i = 0; i < 256; i++) {
      const ratio = Math.min(1.0, bins[i] / peak);
      // 微小値でも視認しやすいよう緩やかなガンマ補正 (0.85乗) を適用
      const norm = Math.pow(ratio, 0.85);
      const px = x0 + i * stepX;
      const py = y0 + h - norm * (h - 3);
      ctx.lineTo(px, py);
    }

    ctx.lineTo(x0 + w, y0 + h);
    ctx.closePath();

    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }

    if (strokeStyle) {
      ctx.beginPath();
      for (let i = 0; i < 256; i++) {
        const ratio = Math.min(1.0, bins[i] / peak);
        const norm = Math.pow(ratio, 0.85);
        const px = x0 + i * stepX;
        const py = y0 + h - norm * (h - 3);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  /**
   * Canvasへヒストグラム波形を描画
   */
  function renderHistogramToCanvas(canvas, data, mode, hoverBin = -1) {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(180, Math.round(rect.width || 236));
    const cssH = Math.max(60, Math.round(rect.height || 82));

    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // 1. 背景の4分割階調グリッド線（シャドウ / 中間調 / ハイライト境界）
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    for (let q = 1; q <= 3; q++) {
      const gx = Math.round((cssW * q) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, cssH);
      ctx.stroke();
    }

    if (!data) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      const loadingText = (window.pmI18n && typeof window.pmI18n.translateString === 'function' && window.pmI18n.getLang() === 'en')
        ? window.pmI18n.translateString('画像読み込み中...')
        : '画像読み込み中...';
      ctx.fillText(loadingText, cssW / 2, cssH / 2 + 4);
      ctx.restore();
      return;
    }

    // 2. モード別波形描画
    if (mode === 'luma') {
      // 輝度単体モード
      const grad = ctx.createLinearGradient(0, 0, 0, cssH);
      grad.addColorStop(0, 'rgba(236, 234, 228, 0.62)');
      grad.addColorStop(1, 'rgba(236, 234, 228, 0.08)');
      drawChannelCurve(ctx, data.yBins, data.peakY, 0, 0, cssW, cssH, grad, 'rgba(255, 255, 255, 0.92)', 1.4);
    } else if (mode === 'parade') {
      // R・G・B 3段パレードモード
      const bandH = cssH / 3;
      const channels = [
        { bins: data.rBins, fill: 'rgba(255, 77, 77, 0.38)', stroke: '#ff5c5c', label: 'R' },
        { bins: data.gBins, fill: 'rgba(56, 211, 104, 0.38)', stroke: '#4ce07a', label: 'G' },
        { bins: data.bBins, fill: 'rgba(77, 148, 255, 0.42)', stroke: '#5ea0ff', label: 'B' },
      ];
      channels.forEach((ch, idx) => {
        const yTop = idx * bandH;
        if (idx > 0) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(yTop) + 0.5);
          ctx.lineTo(cssW, Math.round(yTop) + 0.5);
          ctx.stroke();
        }
        drawChannelCurve(ctx, ch.bins, data.peakRGB, 0, yTop, cssW, bandH, ch.fill, ch.stroke, 1.1);
        ctx.fillStyle = ch.stroke;
        ctx.font = 'bold 9px Inter, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(ch.label, 4, yTop + 10);
      });
    } else {
      // 標準 RGB重畳 + 輝度オーバーレイモード（加算スクリーン合成）
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      drawChannelCurve(
        ctx,
        data.rBins,
        data.peakRGB,
        0,
        0,
        cssW,
        cssH,
        'rgba(255, 68, 68, 0.46)',
        'rgba(255, 96, 96, 0.92)',
        1.2
      );
      drawChannelCurve(
        ctx,
        data.gBins,
        data.peakRGB,
        0,
        0,
        cssW,
        cssH,
        'rgba(46, 204, 102, 0.44)',
        'rgba(72, 228, 124, 0.92)',
        1.2
      );
      drawChannelCurve(
        ctx,
        data.bBins,
        data.peakRGB,
        0,
        0,
        cssW,
        cssH,
        'rgba(64, 140, 255, 0.48)',
        'rgba(96, 165, 255, 0.95)',
        1.2
      );
      ctx.restore();

      // 輝度 Luma の繊細な白銀ラインを上に重ねる
      drawChannelCurve(ctx, data.yBins, data.peakY, 0, 0, cssW, cssH, null, 'rgba(255, 255, 255, 0.65)', 1.0);
    }

    // 3. 両端クリッピング警告バー（黒つぶれ・白飛びが顕著な場合に端1.5pxをハイライト）
    if (data.shadowPct >= 0.5) {
      ctx.fillStyle = 'rgba(56, 189, 248, 0.75)';
      ctx.fillRect(0, 0, 2, cssH);
    }
    if (data.highlightPct >= 0.2) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.fillRect(cssW - 2, 0, 2, cssH);
    }

    // 4. ホバー中の階調インスペクト縦ライン
    if (hoverBin >= 0 && hoverBin <= 255) {
      const hx = Math.round((hoverBin / 255) * cssW) + 0.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, cssH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  /**
   * 統計バー（黒つぶれ％・平均輝度・白飛び％）のDOM表示を更新
   */
  function updateWidgetStatsDom(prefix, data) {
    const shadowBadge = document.getElementById(`${prefix}ShadowBadge`);
    const shadowPctEl = document.getElementById(`${prefix}ShadowPct`);
    const meanValEl = document.getElementById(`${prefix}MeanVal`);
    const highlightBadge = document.getElementById(`${prefix}HighlightBadge`);
    const highlightPctEl = document.getElementById(`${prefix}HighlightPct`);

    if (!data) {
      if (shadowPctEl) shadowPctEl.textContent = '-';
      if (meanValEl) meanValEl.textContent = '-';
      if (highlightPctEl) highlightPctEl.textContent = '-';
      if (shadowBadge) shadowBadge.classList.remove('is-clipped');
      if (highlightBadge) highlightBadge.classList.remove('is-clipped');
      return;
    }

    if (shadowPctEl) {
      shadowPctEl.textContent = `${data.shadowPct.toFixed(1)}%`;
    }
    if (shadowBadge) {
      shadowBadge.classList.toggle('is-clipped', data.shadowPct >= 0.5);
    }

    if (meanValEl) {
      let toneLabel = '';
      if (data.meanY < 75) toneLabel = ' (暗め)';
      else if (data.meanY > 180) toneLabel = ' (明るめ)';
      meanValEl.textContent = `${data.meanY}${toneLabel}`;
    }

    if (highlightPctEl) {
      highlightPctEl.textContent = `${data.highlightPct.toFixed(1)}%`;
    }
    if (highlightBadge) {
      highlightBadge.classList.toggle('is-clipped', data.highlightPct >= 0.2);
    }
  }

  /**
   * 全ウィジェットのモードピル選択状態を同期し再描画
   */
  function setHistogramMode(newMode) {
    if (!['rgb', 'luma', 'parade'].includes(newMode)) return;
    histState.mode = newMode;
    localStorage.setItem('pm_hist_mode', newMode);

    document.querySelectorAll('.hist-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });

    if (histState.inspectorOpen) {
      const c = document.getElementById('inspHistCanvas');
      renderHistogramToCanvas(c, histState.lastInspectorData, histState.mode);
    }
    if (histState.lightboxOpen) {
      const c = document.getElementById('lbHistCanvas');
      renderHistogramToCanvas(c, histState.lastLightboxData, histState.mode);
    }
    if (histState.adjustOpen) {
      const c = document.getElementById('adjHistCanvas');
      renderHistogramToCanvas(c, histState.lastAdjustData, histState.mode);
    }
    if (typeof window.refreshCompareHistograms === 'function') {
      window.refreshCompareHistograms();
    }
  }

  /**
   * 階調値 (0〜255) からゾーン名を返す
   */
  function getToneZoneName(bin) {
    if (bin <= 15) return '黒';
    if (bin <= 75) return 'シャドウ';
    if (bin <= 180) return '中間調';
    if (bin <= 240) return 'ハイライト';
    return '白';
  }

  /**
   * ウィジェット共通のイベント（モード切替、キャンバスクリック・ホバーインスペクト、閉じるボタン）をバインド
   */
  function bindWidgetInteractions(containerEl, prefix, getLatestDataFn, onCloseFn, onScopeToggleFn = null) {
    if (!containerEl) return;

    // フローティングHUD上でホイールやドラッグ・ダブルクリックをしても背後のズーム/パンが暴発しないよう伝播遮断
    ['mousedown', 'pointerdown', 'dblclick', 'wheel', 'click'].forEach(evtName => {
      containerEl.addEventListener(evtName, (e) => {
        e.stopPropagation();
      });
    });

    // モードピルボタン
    containerEl.querySelectorAll('.hist-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === histState.mode);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setHistogramMode(btn.dataset.mode);
      });
    });

    // 閉じるボタン
    const closeBtn = document.getElementById(`${prefix}CloseBtn`);
    if (closeBtn && onCloseFn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onCloseFn();
      });
    }

    // スコープ切替ボタン（画像調整モーダル用: 枠内 ⇔ 全体）
    const scopeBtn = document.getElementById(`${prefix}ScopeBtn`);
    if (scopeBtn && onScopeToggleFn) {
      scopeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onScopeToggleFn(scopeBtn);
      });
    }

    // キャンバスクリックでモード順送り & マウス移動で階調値インスペクト
    const canvasWrap = document.getElementById(`${prefix}CanvasWrap`);
    const canvas = document.getElementById(`${prefix}Canvas`);
    const readout = document.getElementById(`${prefix}Readout`);

    if (canvasWrap && canvas) {
      canvasWrap.addEventListener('click', () => {
        const order = ['rgb', 'luma', 'parade'];
        const nextIdx = (order.indexOf(histState.mode) + 1) % order.length;
        setHistogramMode(order[nextIdx]);
      });

      canvasWrap.addEventListener('mousemove', (e) => {
        const data = getLatestDataFn();
        if (!data) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0) return;
        const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const bin = Math.round(relX * 255);
        renderHistogramToCanvas(canvas, data, histState.mode, bin);

        if (readout) {
          const zone = getToneZoneName(bin);
          const pct = ((data.yBins[bin] / data.validCount) * 100).toFixed(2);
          readout.textContent = `Lv.${bin} (${zone}) ${pct}%`;
          readout.style.display = 'block';
        }
      });

      canvasWrap.addEventListener('mouseleave', () => {
        const data = getLatestDataFn();
        renderHistogramToCanvas(canvas, data, histState.mode, -1);
        if (readout) readout.style.display = 'none';
      });
    }
  }

  /**
   * フローティングHUDのヘッダードラッグ移動を有効化
   */
  function enableHudDragging(hudEl, headerEl) {
    if (!hudEl || !headerEl) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    headerEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      const parentRect = hudEl.offsetParent ? hudEl.offsetParent.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const rect = hudEl.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left - parentRect.left;
      origTop = rect.top - parentRect.top;

      hudEl.classList.add('is-user-dragged');
      hudEl.style.right = 'auto';
      hudEl.style.left = `${origLeft}px`;
      hudEl.style.top = `${origTop}px`;

      const onMove = (ev) => {
        if (!dragging) return;
        const pRect = hudEl.offsetParent ? hudEl.offsetParent.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
        const maxLeft = Math.max(8, pRect.width - hudEl.offsetWidth - 8);
        const maxTop = Math.max(8, pRect.height - hudEl.offsetHeight - 8);
        const nx = Math.max(8, Math.min(maxLeft, origLeft + (ev.clientX - startX)));
        const ny = Math.max(8, Math.min(maxTop, origTop + (ev.clientY - startY)));
        hudEl.style.left = `${nx}px`;
        hudEl.style.top = `${ny}px`;
      };

      const onUp = () => {
        dragging = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // =========================================================================
  // 1. 右インスペクタ用ヒストグラム制御
  // =========================================================================

  function refreshInspectorHistogram() {
    if (!histState.inspectorOpen) return;
    const thumbImg = document.getElementById('inspectorThumb');
    const canvas = document.getElementById('inspHistCanvas');
    if (!thumbImg || !canvas) return;

    const data = computeHistogramFromImage(thumbImg);
    histState.lastInspectorData = data;
    renderHistogramToCanvas(canvas, data, histState.mode);
    updateWidgetStatsDom('inspHist', data);
  }

  function toggleInspectorHistogram(forceState) {
    histState.inspectorOpen = (forceState !== undefined) ? Boolean(forceState) : !histState.inspectorOpen;

    const drawer = document.getElementById('inspectorHistogramDrawer');
    const quickHistBtn = document.getElementById('inspectorQuickHistBtn');

    if (drawer) {
      drawer.style.display = histState.inspectorOpen ? 'block' : 'none';
    }
    if (quickHistBtn) {
      quickHistBtn.classList.toggle('active', histState.inspectorOpen);
    }

    if (histState.inspectorOpen) {
      requestAnimationFrame(refreshInspectorHistogram);
    }
  }

  // =========================================================================
  // 2. ライトボックス用ヒストグラム制御
  // =========================================================================

  function syncLightboxHudOffset() {
    const hud = document.getElementById('lightboxHistogramHud');
    const exifDrawer = document.getElementById('exifDrawer');
    if (!hud || !exifDrawer) return;
    const isDrawerVisible = exifDrawer.style.display !== 'none' && exifDrawer.style.display !== '';
    hud.classList.toggle('exif-drawer-offset', isDrawerVisible);
  }

  function refreshLightboxHistogram() {
    if (!histState.lightboxOpen) return;
    const lbImg = document.getElementById('lightboxImage');
    const canvas = document.getElementById('lbHistCanvas');
    if (!lbImg || !canvas) return;

    syncLightboxHudOffset();
    const data = computeHistogramFromImage(lbImg);
    histState.lastLightboxData = data;
    renderHistogramToCanvas(canvas, data, histState.mode);
    updateWidgetStatsDom('lbHist', data);
  }

  function toggleLightboxHistogram(forceState) {
    histState.lightboxOpen = (forceState !== undefined) ? Boolean(forceState) : !histState.lightboxOpen;

    const hud = document.getElementById('lightboxHistogramHud');
    const toggleBtn = document.getElementById('toggleLightboxHistogramBtn');

    if (hud) {
      hud.style.display = histState.lightboxOpen ? 'block' : 'none';
    }
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', histState.lightboxOpen);
    }

    if (histState.lightboxOpen) {
      syncLightboxHudOffset();
      requestAnimationFrame(refreshLightboxHistogram);
    }
  }

  // =========================================================================
  // 3. 画像調整モーダル (Crop & Tone) 用リアルタイムヒストグラム制御
  // =========================================================================

  let _lastAdjustRef = null;

  function refreshAdjustHistogram(imgEl, adjustStateObj) {
    if (imgEl && adjustStateObj) {
      _lastAdjustRef = { imgEl, adjustStateObj };
    }
    if (!histState.adjustOpen) return;

    const targetImg = (imgEl) || (_lastAdjustRef && _lastAdjustRef.imgEl) || document.getElementById('imageAdjustImg');
    const targetState = (adjustStateObj) || (_lastAdjustRef && _lastAdjustRef.adjustStateObj) || null;
    const canvas = document.getElementById('adjHistCanvas');
    if (!targetImg || !canvas) return;

    const data = computeHistogramFromImage(targetImg, {
      adjustState: targetState,
      scope: histState.adjustScope,
    });
    histState.lastAdjustData = data;
    renderHistogramToCanvas(canvas, data, histState.mode);
    updateWidgetStatsDom('adjHist', data);
  }

  function toggleAdjustHistogram(forceState) {
    histState.adjustOpen = (forceState !== undefined) ? Boolean(forceState) : !histState.adjustOpen;

    const hud = document.getElementById('adjustHistogramHud');
    const toggleBtn = document.getElementById('adjustHistogramToggleBtn');

    if (hud) {
      hud.style.display = histState.adjustOpen ? 'block' : 'none';
    }
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', histState.adjustOpen);
    }

    if (histState.adjustOpen) {
      requestAnimationFrame(() => refreshAdjustHistogram());
    }
  }

  // =========================================================================
  // 4. DOM初期化 & イベント配線
  // =========================================================================

  function initHistogramModule() {
    // --- A. 右インスペクタへのヒストグラムドロワー注入 ---
    const fixedPreview = document.getElementById('inspectorFixedPreview');
    if (fixedPreview && !document.getElementById('inspectorHistogramDrawer')) {
      const drawer = document.createElement('div');
      drawer.id = 'inspectorHistogramDrawer';
      drawer.className = 'inspector-histogram-drawer';
      drawer.style.display = 'none';
      drawer.innerHTML = buildHistogramWidgetHtml('inspHist', false);
      const quickActionsBar = document.getElementById('inspectorQuickActionsBar');
      if (quickActionsBar) {
        quickActionsBar.insertAdjacentElement('afterend', drawer);
      } else {
        fixedPreview.appendChild(drawer);
      }

      bindWidgetInteractions(
        drawer,
        'inspHist',
        () => histState.lastInspectorData,
        () => toggleInspectorHistogram(false)
      );

      // インスペクタのサムネイル画像がロードされるたびに（開いていれば）波形を自動更新
      const inspThumb = document.getElementById('inspectorThumb');
      if (inspThumb) {
        inspThumb.addEventListener('load', () => {
          if (histState.inspectorOpen) {
            refreshInspectorHistogram();
          }
        });
      }
    }

    // --- B. ライトボックスへのヒストグラム注入 ---
    const toggleExifBtn = document.getElementById('toggleExifBtn');
    const lightboxBody = document.querySelector('#lightboxModal .lightbox-body');
    if (toggleExifBtn && lightboxBody && !document.getElementById('toggleLightboxHistogramBtn')) {
      const lbBtn = document.createElement('button');
      lbBtn.type = 'button';
      lbBtn.className = 'icon-action-btn';
      lbBtn.id = 'toggleLightboxHistogramBtn';
      lbBtn.title = 'RGBヒストグラム表示/非表示 (H)';
      lbBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 20h18M6 16v-5M10 16V6M14 16v-9M18 16v-4"/>
        </svg>
      `;
      lbBtn.addEventListener('click', () => toggleLightboxHistogram());
      toggleExifBtn.insertAdjacentElement('beforebegin', lbBtn);

      // EXIFドロワー開閉時にヒストグラムの位置オフセットを連動
      toggleExifBtn.addEventListener('click', () => {
        requestAnimationFrame(syncLightboxHudOffset);
      });

      const lbHud = document.createElement('div');
      lbHud.id = 'lightboxHistogramHud';
      lbHud.className = 'histogram-floating-hud';
      lbHud.style.display = 'none';
      lbHud.innerHTML = buildHistogramWidgetHtml('lbHist', false);
      lightboxBody.appendChild(lbHud);

      bindWidgetInteractions(
        lbHud,
        'lbHist',
        () => histState.lastLightboxData,
        () => toggleLightboxHistogram(false)
      );
      enableHudDragging(lbHud, document.getElementById('lbHistHeader'));

      const lbImg = document.getElementById('lightboxImage');
      if (lbImg) {
        lbImg.addEventListener('load', () => {
          if (histState.lightboxOpen) {
            refreshLightboxHistogram();
          }
        });
      }
    }

    // --- C. 画像調整モーダルへのリアルタイムヒストグラム注入 ---
    const adjustCloseBtn = document.getElementById('closeImageAdjustBtn');
    const adjustStage = document.getElementById('imageAdjustStage');
    if (adjustCloseBtn && adjustStage && !document.getElementById('adjustHistogramToggleBtn')) {
      const headerParent = adjustCloseBtn.parentElement;
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'image-adjust-header-actions';

      const adjBtn = document.createElement('button');
      adjBtn.type = 'button';
      adjBtn.id = 'adjustHistogramToggleBtn';
      adjBtn.className = 'adjust-hist-toggle-btn';
      adjBtn.title = 'トーン調整・切り抜き枠にリアルタイム連動するRGBヒストグラムを表示/非表示 (H)';
      adjBtn.innerHTML = `<span>ヒストグラム (H)</span>`;
      adjBtn.addEventListener('click', () => toggleAdjustHistogram());

      headerParent.insertBefore(actionsWrap, adjustCloseBtn);
      actionsWrap.appendChild(adjBtn);
      actionsWrap.appendChild(adjustCloseBtn);

      const adjHud = document.createElement('div');
      adjHud.id = 'adjustHistogramHud';
      adjHud.className = 'histogram-floating-hud';
      adjHud.style.display = 'none';
      adjHud.innerHTML = buildHistogramWidgetHtml('adjHist', true);
      adjustStage.appendChild(adjHud);

      bindWidgetInteractions(
        adjHud,
        'adjHist',
        () => histState.lastAdjustData,
        () => toggleAdjustHistogram(false),
        (scopeBtn) => {
          histState.adjustScope = (histState.adjustScope === 'crop') ? 'full' : 'crop';
          const isCrop = histState.adjustScope === 'crop';
          scopeBtn.textContent = isCrop ? '枠内' : '全体';
          scopeBtn.classList.toggle('is-crop', isCrop);
          refreshAdjustHistogram();
        }
      );
      enableHudDragging(adjHud, document.getElementById('adjHistHeader'));
    }

    // --- D. グローバル [H] キーショートカット ---
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key !== 'h' && e.key !== 'H') return;

      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable)) {
        return;
      }

      // 他のモーダル（ヘルプ・テイクアウト・DBメンテ等）が開いている時は無視
      const blockingModals = ['helpModal', 'smartTakeoutModal', 'dbMaintenanceModal', 'mobileConnectModal', 'gpsCandidateModal', 'locationMapModal', 'labKarteModal'];
      for (const mId of blockingModals) {
        const mEl = document.getElementById(mId);
        if (mEl && mEl.style.display !== 'none' && mEl.style.display !== '') return;
      }

      // 0. 2枚比較モーダル (Side-by-Side) 表示中なら比較画面のヒストグラムをトグル
      const compareModal = document.getElementById('compareModal');
      if (compareModal && compareModal.style.display !== 'none' && compareModal.style.display !== '') {
        e.preventDefault();
        if (typeof window.toggleCompareHistogram === 'function') {
          window.toggleCompareHistogram();
        }
        return;
      }

      // 1. 画像調整モーダル表示中なら調整モーダルのヒストグラムをトグル
      const adjustModal = document.getElementById('imageAdjustModal');
      if (adjustModal && adjustModal.style.display !== 'none' && adjustModal.style.display !== '') {
        e.preventDefault();
        toggleAdjustHistogram();
        return;
      }

      // 2. スライドショー表示中は無視
      const slideshowModal = document.getElementById('slideshowModal');
      if (slideshowModal && slideshowModal.style.display !== 'none' && slideshowModal.style.display !== '') {
        return;
      }

      // 3. ライトボックス表示中ならライトボックスのヒストグラムをトグル
      if (typeof state !== 'undefined' && state.currentPhotoIndex >= 0) {
        e.preventDefault();
        toggleLightboxHistogram();
        return;
      }

      // 4. 通常一覧画面なら右インスペクタのヒストグラムをトグル（インスペクタが閉じていれば自動で開く）
      if (typeof state !== 'undefined') {
        e.preventDefault();
        if (!state.isInspectorOpen && typeof toggleInspector === 'function') {
          toggleInspector(true);
          toggleInspectorHistogram(true);
        } else {
          toggleInspectorHistogram();
        }
      }
    });
  }

  // グローバル公開API
  window.initHistogramModule = initHistogramModule;
  window.refreshInspectorHistogram = refreshInspectorHistogram;
  window.refreshLightboxHistogram = refreshLightboxHistogram;
  window.updateAdjustHistogram = refreshAdjustHistogram;
  window.toggleInspectorHistogram = toggleInspectorHistogram;
  window.toggleLightboxHistogram = toggleLightboxHistogram;
  window.toggleAdjustHistogram = toggleAdjustHistogram;
  window.computeHistogramFromImage = computeHistogramFromImage;
  window.renderHistogramToCanvas = renderHistogramToCanvas;
  window.updateHistogramStatsDom = updateWidgetStatsDom;
  window.buildHistogramWidgetHtml = buildHistogramWidgetHtml;
  window.bindHistogramWidgetInteractions = bindWidgetInteractions;
  window.getHistogramMode = () => histState.mode;
  window.setHistogramMode = setHistogramMode;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHistogramModule);
  } else {
    initHistogramModule();
  }
})();
