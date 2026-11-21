/**
 * Tetheract Touch Viewer Action Launcher & Quick SNS Share (Layer 3)
 * モバイル版ライトボックス上部バーのアクション群を単一メインボタンから展開する
 * ポップオーバーランチャーへ集約し、ワンタップSNSクイック共有（非破壊調整反映・GPS除去・FileProvider）を提供する。
 */
(function (global) {
  'use strict';

  const QUICK_SHARE_MAX_LONG_EDGE = 2048;
  const QUICK_SHARE_JPEG_QUALITY = 0.92;

  let isOpen = false;
  let isSharing = false;
  let initialized = false;

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

  function _updateLauncherTriggerState() {
    const btn = document.getElementById('mViewerLauncherBtn');
    if (!btn) return;
    btn.classList.toggle('is-open', isOpen);
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

    const adjBtn = document.getElementById('mViewerAdjustBtn');
    const isAdjustActive = Boolean(adjBtn && adjBtn.classList.contains('active'));
    btn.classList.toggle('has-active-tool', isAdjustActive);
  }

  function openMenu() {
    const menu = document.getElementById('mViewerLauncherMenu');
    const backdrop = document.getElementById('mViewerLauncherBackdrop');
    if (!menu) return;
    isOpen = true;
    if (backdrop) backdrop.style.display = 'block';
    menu.style.display = 'flex';
    global.requestAnimationFrame(() => {
      menu.classList.add('is-open');
    });
    _updateLauncherTriggerState();
  }

  function closeMenu() {
    const menu = document.getElementById('mViewerLauncherMenu');
    const backdrop = document.getElementById('mViewerLauncherBackdrop');
    if (!isOpen && (!menu || menu.style.display === 'none')) return;
    isOpen = false;
    if (menu) {
      menu.classList.remove('is-open');
      menu.style.display = 'none';
    }
    if (backdrop) backdrop.style.display = 'none';
    _updateLauncherTriggerState();
  }

  function toggleMenu() {
    if (isOpen) closeMenu();
    else openMenu();
  }

  function _loadImageWithFallback(primaryUrl, fallbackUrl) {
    return new Promise((resolve, reject) => {
      const tryLoad = (url, isFallback) => {
        if (!url) {
          reject(new Error('共有対象の画像URLが見つかりません'));
          return;
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve({ img, isFallback });
        img.onerror = () => {
          if (!isFallback && fallbackUrl && fallbackUrl !== url) {
            tryLoad(fallbackUrl, true);
          } else {
            reject(new Error('画像の読み込みに失敗しました'));
          }
        };
        img.src = url;
      };
      tryLoad(primaryUrl, false);
    });
  }

  /**
   * 原本画像へ非破壊調整（露出・コントラスト・彩度・傾き・90°回転）を適用し、
   * SNS投稿向けに長辺上限2048px・GPS非含有のJPEG DataURLを生成する。
   */
  function _renderAdjustedJpegDataUrl(img, photo, isUnbakedSource) {
    const srcW = Math.max(1, img.naturalWidth || img.width || 1);
    const srcH = Math.max(1, img.naturalHeight || img.height || 1);

    const baked = (photo && photo._bakedAdjust) || {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      fine_angle: 0,
      rotation: 0,
    };
    const curEv = Number((photo && photo.brightness) || 0) / 10.0;
    const curCt = Number((photo && photo.contrast) || 0);
    const curSat = Number((photo && photo.saturation) || 0);
    const curTilt = Number((photo && photo.fine_angle) || 0);
    const curRot = Number((photo && photo.rotation) || 0);

    const effEv = isUnbakedSource ? curEv : (curEv - Number(baked.brightness || 0) / 10.0);
    const effCt = isUnbakedSource ? curCt : (curCt - Number(baked.contrast || 0));
    const effSat = isUnbakedSource ? curSat : (curSat - Number(baked.saturation || 0));
    const effTilt = isUnbakedSource ? curTilt : (curTilt - Number(baked.fine_angle || 0));
    const effRot90 = isUnbakedSource ? ((curRot % 360) + 360) % 360 : 0;

    const isSwap90 = effRot90 === 90 || effRot90 === 270;
    const baseOutW = isSwap90 ? srcH : srcW;
    const baseOutH = isSwap90 ? srcW : srcH;
    const longEdge = Math.max(baseOutW, baseOutH);
    const resizeScale = longEdge > QUICK_SHARE_MAX_LONG_EDGE ? (QUICK_SHARE_MAX_LONG_EDGE / longEdge) : 1.0;

    const outW = Math.max(1, Math.round(baseOutW * resizeScale));
    const outH = Math.max(1, Math.round(baseOutH * resizeScale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvasコンテキストを取得できませんでした');

    const br = Math.max(0.25, Math.min(2.4, Math.pow(2, effEv * 0.45)));
    const ct = Math.max(0.25, Math.min(2.2, 1 + effCt / 100));
    const sa = Math.max(0, Math.min(2.4, 1 + effSat / 100));
    const hasFilter = Math.abs(br - 1) > 0.005 || Math.abs(ct - 1) > 0.005 || Math.abs(sa - 1) > 0.005;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    ctx.save();
    if (hasFilter && typeof ctx.filter === 'string') {
      ctx.filter = `brightness(${br.toFixed(3)}) contrast(${ct.toFixed(3)}) saturate(${sa.toFixed(3)})`;
    }

    ctx.translate(outW * 0.5, outH * 0.5);
    let totalRad = (effRot90 * Math.PI) / 180;
    let tiltScale = 1.0;
    if (Math.abs(effTilt) > 0.05) {
      const tiltRad = (effTilt * Math.PI) / 180;
      totalRad += tiltRad;
      const absSin = Math.abs(Math.sin(tiltRad));
      const absCos = Math.abs(Math.cos(tiltRad));
      const rAspect = outW / Math.max(1, outH);
      tiltScale = Math.max(absCos + absSin * rAspect, absCos + absSin / Math.max(0.01, rAspect));
    }
    if (Math.abs(totalRad) > 0.0001) ctx.rotate(totalRad);
    if (tiltScale > 1.0001) ctx.scale(tiltScale, tiltScale);

    const drawW = Math.max(1, Math.round(srcW * resizeScale));
    const drawH = Math.max(1, Math.round(srcH * resizeScale));
    ctx.drawImage(img, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
    ctx.restore();

    return {
      dataUrl: canvas.toDataURL('image/jpeg', QUICK_SHARE_JPEG_QUALITY),
      width: outW,
      height: outH,
    };
  }

  function _fallbackBrowserDownload(dataUrl, fileName) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function executeQuickShare() {
    if (isSharing) return;
    closeMenu();

    const targets = typeof global.__getMobileArtFramerTargets === 'function'
      ? global.__getMobileArtFramerTargets()
      : [];
    const photo = Array.isArray(targets) && targets.length > 0 ? targets[0] : null;
    if (!photo) {
      _showToast('共有する写真が見つかりません');
      return;
    }

    const viewerImg = document.getElementById('mViewerImg');
    const isUnbakedSource = Boolean(viewerImg && viewerImg.dataset.unbakedSource === '1');
    const primaryUrl = photo.hdUrl || (viewerImg && viewerImg.currentSrc) || photo.thumbUrl || '';
    const fallbackUrl = photo.thumbUrl || (viewerImg && viewerImg.currentSrc) || '';

    isSharing = true;
    _showToast('共有用の画像を準備中（GPS除去・調整反映）...', 2000);
    try {
      const { img, isFallback } = await _loadImageWithFallback(primaryUrl, fallbackUrl);
      if (isFallback || (img.naturalWidth <= 480 && img.naturalHeight <= 480)) {
        _showToast('オフラインのためサムネイル画質で共有します', 2600);
      }
      const rendered = _renderAdjustedJpegDataUrl(img, photo, isUnbakedSource);
      const origName = String(photo.file_name || `photo_${photo.id || Date.now()}`);
      const stem = origName.replace(/\.[^.]+$/, '');
      const shareFileName = `${stem}_share.jpg`;

      const adapter = global.TetheractWatermarkAdapter;
      if (adapter && typeof adapter.sharePhotoToSns === 'function') {
        const res = await adapter.sharePhotoToSns({
          dataUrl: rendered.dataUrl,
          fileName: shareFileName,
          mimeType: 'image/jpeg',
          dateTaken: photo.date_taken || '',
          cameraModel: photo.camera_model || '',
        });
        if (res && res.ok) {
          return;
        }
        if (res && res.mode === 'fallback_download') {
          _fallbackBrowserDownload(rendered.dataUrl, shareFileName);
          _showToast('共有用画像を保存しました（GPS除去済）');
          return;
        }
        _showToast((res && res.error) || '共有シートを開けませんでした');
      } else {
        _fallbackBrowserDownload(rendered.dataUrl, shareFileName);
        _showToast('共有用画像を保存しました（GPS除去済）');
      }
    } catch (err) {
      console.warn('[VIEWER_LAUNCHER] クイックSNS共有エラー:', err);
      _showToast((err && err.message) || '共有の準備に失敗しました');
    } finally {
      isSharing = false;
    }
  }

  function init() {
    if (initialized) return;
    const launcherBtn = document.getElementById('mViewerLauncherBtn');
    const menu = document.getElementById('mViewerLauncherMenu');
    if (!launcherBtn || !menu) return;
    initialized = true;

    launcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });

    document.getElementById('mViewerLauncherBackdrop')?.addEventListener('click', () => {
      closeMenu();
    });

    document.getElementById('mViewerQuickShareBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      executeQuickShare();
    });

    // 他のツール項目押下時はランチャーを閉じる（元イベントハンドラはそのまま実行される）
    ['mViewerArtFramerBtn', 'mViewerAdjustBtn', 'mViewerOpenInfoBtn'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => {
        closeMenu();
      });
    });

    // 調整ボタンの active 状態変化をランチャーボタンのドット表示へ同期
    const adjBtn = document.getElementById('mViewerAdjustBtn');
    if (adjBtn && typeof global.MutationObserver === 'function') {
      const obs = new global.MutationObserver(() => _updateLauncherTriggerState());
      obs.observe(adjBtn, { attributes: true, attributeFilter: ['class'] });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen) {
        closeMenu();
      }
    });

    global.__extraBackHandlers = global.__extraBackHandlers || [];
    global.__extraBackHandlers.push(() => {
      if (!isOpen) return undefined;
      closeMenu();
      return 'handled';
    });

    _updateLauncherTriggerState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, {
    viewerLauncher: {
      open: openMenu,
      close: closeMenu,
      toggle: toggleMenu,
      isOpen: () => isOpen,
      quickShare: executeQuickShare,
    },
  });
})(window);
