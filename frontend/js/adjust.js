/**
 * adjust.js - 非破壊画像調整（90度回転 ＆ Twitter (X) 風クロップ調整）モジュール
 * 元画像ファイルを一切変更せず、回転・クロップ設定をSQLiteデータベースおよびUIに反映する。
 */

(function () {
  'use strict';

  // 調整状態
  const adjustState = {
    photo: null,
    rotation: 0,
    fineAngle: 0.0,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    aspect: 'original',
    crop: { x: 0, y: 0, w: 0, h: 0 }, // コンテナ内のピクセル値
    containerSize: { w: 0, h: 0 },
    naturalSize: { w: 0, h: 0 },
    isDragging: false,
    dragMode: null, // 'move' またはハンドル名 ('nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w')
    dragStart: { mouseX: 0, mouseY: 0, cropX: 0, cropY: 0, cropW: 0, cropH: 0 },
    isComparingOriginal: false, // 👁️ 元画像と比較 (Before) ホールド中フラグ
  };

  // DOM要素キャッシュ
  let modalEl = null;
  let stageEl = null;
  let containerEl = null;
  let imgEl = null;
  let cropBoxEl = null;
  let cropOverlayEl = null;
  let beforeBadgeEl = null;
  let compareOrigBtnEl = null;
  let copyToneBtnEl = null;
  let pasteToneBtnEl = null;
  let aspectBtns = [];
  let fineAngleRangeEl = null;
  let fineAngleValEl = null;
  let brightnessRangeEl = null;
  let brightnessValEl = null;
  let contrastRangeEl = null;
  let contrastValEl = null;
  let saturationRangeEl = null;
  let saturationValEl = null;

  // カメラ露出補正ダイヤル（1/3段ステップ: -2.0EV 〜 +2.0EV、DB保存用の内部値は EV×10 の整数）
  // ダイヤル位置 -6 〜 +6 に対応する EV×10 値:
  // [-2.0, -1.7, -1.3, -1.0, -0.7, -0.3, 0.0, +0.3, +0.7, +1.0, +1.3, +1.7, +2.0]
  const BRIGHTNESS_EV_STEPS = [-20, -17, -13, -10, -7, -3, 0, 3, 7, 10, 13, 17, 20];

  /**
   * 内部brightness値（EV×10整数）からカメラ露出ダイヤルのインデックス（-6〜+6）へ変換する
   */
  function brightnessToDialIndex(bVal) {
    const num = Number(bVal) || 0;
    let bestIdx = 6;
    let minDiff = Infinity;
    for (let i = 0; i < BRIGHTNESS_EV_STEPS.length; i++) {
      const diff = Math.abs(BRIGHTNESS_EV_STEPS[i] - num);
      if (diff < minDiff) {
        minDiff = diff;
        bestIdx = i;
      }
    }
    return bestIdx - 6;
  }

  /**
   * カメラ露出ダイヤルのインデックス（-6〜+6）から内部brightness値（EV×10整数）へ変換する
   */
  function dialIndexToBrightness(dialIdx) {
    const clampedIdx = Math.max(-6, Math.min(6, Math.round(Number(dialIdx) || 0)));
    return BRIGHTNESS_EV_STEPS[clampedIdx + 6];
  }

  /**
   * 微調整スライダー（水平傾き・明るさ・コントラスト・彩度）のUI表示を同期する
   */
  function syncFineSlidersUI() {
    const fa = Number(adjustState.fineAngle) || 0;
    const b = Number(adjustState.brightness) || 0;
    const c = Number(adjustState.contrast) || 0;
    const s = Number(adjustState.saturation) || 0;

    if (fineAngleRangeEl) fineAngleRangeEl.value = String(fa);
    if (fineAngleValEl) {
      const sign = fa > 0.01 ? '+' : '';
      fineAngleValEl.textContent = `${sign}${fa.toFixed(1)}°`;
      fineAngleValEl.classList.toggle('is-modified', Math.abs(fa) > 0.01);
    }

    const dialIdx = brightnessToDialIndex(b);
    const snappedB = BRIGHTNESS_EV_STEPS[dialIdx + 6];
    if (brightnessRangeEl) brightnessRangeEl.value = String(dialIdx);
    if (brightnessValEl) {
      const evStr = (snappedB / 10.0).toFixed(1);
      const sign = snappedB > 0 ? '+' : '';
      brightnessValEl.textContent = `${sign}${evStr}EV`;
      brightnessValEl.classList.toggle('is-modified', snappedB !== 0);
    }

    if (contrastRangeEl) contrastRangeEl.value = String(c);
    if (contrastValEl) {
      contrastValEl.textContent = `${c > 0 ? '+' : ''}${c}`;
      contrastValEl.classList.toggle('is-modified', c !== 0);
    }

    if (saturationRangeEl) saturationRangeEl.value = String(s);
    if (saturationValEl) {
      saturationValEl.textContent = `${s > 0 ? '+' : ''}${s}`;
      saturationValEl.classList.toggle('is-modified', s !== 0);
    }
  }

  /**
   * ステージ上の画像に対して回転・水平傾き補正（内接自動ズーム付き）・トーン微調整フィルタを即時反映する
   */
  function setCompareOriginalMode(isComparing) {
    const nextVal = Boolean(isComparing);
    if (adjustState.isComparingOriginal === nextVal) return;
    adjustState.isComparingOriginal = nextVal;
    if (compareOrigBtnEl) {
      compareOrigBtnEl.classList.toggle('is-holding', nextVal);
    }
    if (cropOverlayEl) {
      cropOverlayEl.style.opacity = nextVal ? '0' : '1';
    }
    if (beforeBadgeEl) {
      beforeBadgeEl.style.display = nextVal ? 'inline-flex' : 'none';
    }
    applyImageStagePreview(true);
  }

  function applyImageStagePreview(isImmediate = false) {
    if (!imgEl || !adjustState.photo) return;
    imgEl.style.transition = isImmediate ? 'none' : 'transform 0.15s ease-out';

    if (adjustState.isComparingOriginal) {
      const baseDeg = adjustState.rotation || 0;
      imgEl.style.transform = `translate(-50%, -50%) rotate(${baseDeg}deg) scale(1)`;
      imgEl.style.filter = 'none';
      return;
    }

    const fa = Number(adjustState.fineAngle) || 0;
    let autoScale = 1.0;
    if (Math.abs(fa) > 0.01) {
      const isTransposed = (adjustState.rotation % 180 !== 0);
      const w = isTransposed ? adjustState.naturalSize.h : adjustState.naturalSize.w;
      const h = isTransposed ? adjustState.naturalSize.w : adjustState.naturalSize.h;
      const rad = Math.abs(fa) * Math.PI / 180.0;
      const aspectMax = (w > 0 && h > 0) ? Math.max(w / h, h / w) : 1.333;
      autoScale = Math.cos(rad) + Math.sin(rad) * aspectMax;
    }

    const totalDeg = (adjustState.rotation || 0) + fa;
    imgEl.style.transform = `translate(-50%, -50%) rotate(${totalDeg}deg) scale(${autoScale.toFixed(4)})`;

    const b = Number(adjustState.brightness) || 0;
    const c = Number(adjustState.contrast) || 0;
    const s = Number(adjustState.saturation) || 0;
    if (b !== 0 || c !== 0 || s !== 0) {
      const ev = Math.max(-3.0, Math.min(3.0, b / 10.0));
      const bFactor = Math.max(0.1, Math.pow(2.0, ev / 2.2)).toFixed(4);
      const cFactor = Math.max(0.1, 1.0 + (c / 100.0) * 0.75).toFixed(3);
      const sFactor = Math.max(0.0, 1.0 + (s / 100.0)).toFixed(3);
      imgEl.style.filter = `brightness(${bFactor}) contrast(${cFactor}) saturate(${sFactor})`;
    } else {
      imgEl.style.filter = 'none';
    }

    if (typeof window.updateAdjustHistogram === 'function') {
      window.updateAdjustHistogram(imgEl, adjustState);
    }
  }

  /**
   * 初期化処理
   */
  function initAdjustModule() {
    modalEl = document.getElementById('imageAdjustModal');
    stageEl = document.getElementById('imageAdjustStage');
    containerEl = document.getElementById('imageAdjustContainer');
    imgEl = document.getElementById('imageAdjustImg');
    cropBoxEl = document.getElementById('cropBox');
    cropOverlayEl = document.getElementById('cropOverlay');
    beforeBadgeEl = document.getElementById('adjustBeforeBadge');
    compareOrigBtnEl = document.getElementById('adjustCompareOrigBtn');
    copyToneBtnEl = document.getElementById('adjustCopyToneBtn');
    pasteToneBtnEl = document.getElementById('adjustPasteToneBtn');

    fineAngleRangeEl = document.getElementById('adjustFineAngleRange');
    fineAngleValEl = document.getElementById('adjustFineAngleVal');
    brightnessRangeEl = document.getElementById('adjustBrightnessRange');
    brightnessValEl = document.getElementById('adjustBrightnessVal');
    contrastRangeEl = document.getElementById('adjustContrastRange');
    contrastValEl = document.getElementById('adjustContrastVal');
    saturationRangeEl = document.getElementById('adjustSaturationRange');
    saturationValEl = document.getElementById('adjustSaturationVal');

    if (!modalEl) return;

    // 閉じるボタン
    const closeBtn = document.getElementById('closeImageAdjustBtn');
    const cancelBtn = document.getElementById('adjustCancelBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeImageAdjustModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeImageAdjustModal);

    // 比率ボタン
    const aspectGroup = document.getElementById('adjustAspectGroup');
    if (aspectGroup) {
      aspectBtns = Array.from(aspectGroup.querySelectorAll('.adjust-aspect-btn'));
      aspectBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const aspect = btn.dataset.aspect;
          setCropAspect(aspect);
        });
      });
    }

    // 微調整スライダー（水平傾き・明るさ・コントラスト・彩度）
    if (fineAngleRangeEl) {
      fineAngleRangeEl.addEventListener('input', () => {
        adjustState.fineAngle = parseFloat(fineAngleRangeEl.value) || 0.0;
        syncFineSlidersUI();
        applyImageStagePreview(true);
      });
      const angleItem = fineAngleRangeEl.closest('.adjust-fine-item');
      if (angleItem) {
        angleItem.addEventListener('dblclick', (e) => {
          if (e.target.closest('.adjust-step-btn')) return;
          adjustState.fineAngle = 0.0;
          syncFineSlidersUI();
          applyImageStagePreview(false);
        });
      }
    }

    if (brightnessRangeEl) {
      brightnessRangeEl.addEventListener('input', () => {
        const dialIdx = parseInt(brightnessRangeEl.value, 10) || 0;
        adjustState.brightness = dialIndexToBrightness(dialIdx);
        syncFineSlidersUI();
        applyImageStagePreview(true);
      });
      const bItem = brightnessRangeEl.closest('.adjust-fine-item');
      if (bItem) {
        bItem.addEventListener('dblclick', (e) => {
          if (e.target.closest('.adjust-step-btn')) return;
          adjustState.brightness = 0;
          syncFineSlidersUI();
          applyImageStagePreview(false);
        });
      }
    }

    if (contrastRangeEl) {
      contrastRangeEl.addEventListener('input', () => {
        adjustState.contrast = parseInt(contrastRangeEl.value, 10) || 0;
        syncFineSlidersUI();
        applyImageStagePreview(true);
      });
      const cItem = contrastRangeEl.closest('.adjust-fine-item');
      if (cItem) {
        cItem.addEventListener('dblclick', (e) => {
          if (e.target.closest('.adjust-step-btn')) return;
          adjustState.contrast = 0;
          syncFineSlidersUI();
          applyImageStagePreview(false);
        });
      }
    }

    if (saturationRangeEl) {
      saturationRangeEl.addEventListener('input', () => {
        adjustState.saturation = parseInt(saturationRangeEl.value, 10) || 0;
        syncFineSlidersUI();
        applyImageStagePreview(true);
      });
      const sItem = saturationRangeEl.closest('.adjust-fine-item');
      if (sItem) {
        sItem.addEventListener('dblclick', (e) => {
          if (e.target.closest('.adjust-step-btn')) return;
          adjustState.saturation = 0;
          syncFineSlidersUI();
          applyImageStagePreview(false);
        });
      }
    }

    // 微調整の「−」「＋」ステップボタン（Shift+クリックで大きく増減）
    const fineBarEl = document.getElementById('imageAdjustFineBar');
    if (fineBarEl) {
      fineBarEl.querySelectorAll('.adjust-step-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetId = btn.dataset.target;
          const rawDelta = parseFloat(btn.dataset.delta) || 0;
          if (!targetId || rawDelta === 0) return;

          if (targetId === 'adjustFineAngleRange') {
            const step = e.shiftKey ? rawDelta * 10 : rawDelta; // 通常±0.1°、Shift時±1.0°
            const nextVal = Math.round(((Number(adjustState.fineAngle) || 0) + step) * 10) / 10;
            adjustState.fineAngle = Math.max(-15.0, Math.min(15.0, nextVal));
          } else if (targetId === 'adjustBrightnessRange') {
            // カメラ露出補正ダイヤル: 通常クリックで ±1目盛り(1/3段EV)、Shift+クリックで ±3目盛り(1.0EV)
            const curDialIdx = brightnessToDialIndex(adjustState.brightness);
            const dialDelta = e.shiftKey ? Math.sign(rawDelta) * 3 : Math.sign(rawDelta) * 1;
            adjustState.brightness = dialIndexToBrightness(curDialIdx + dialDelta);
          } else {
            const step = e.shiftKey ? rawDelta * 5 : rawDelta; // 通常±1、Shift時±5
            const clamped = (val) => Math.max(-100, Math.min(100, Math.round(val)));
            if (targetId === 'adjustContrastRange') {
              adjustState.contrast = clamped((Number(adjustState.contrast) || 0) + step);
            } else if (targetId === 'adjustSaturationRange') {
              adjustState.saturation = clamped((Number(adjustState.saturation) || 0) + step);
            }
          }
          syncFineSlidersUI();
          applyImageStagePreview(false);
        });
      });
    }

    // 回転ボタン
    const rotLeftBtn = document.getElementById('adjustRotateLeftBtn');
    const rotRightBtn = document.getElementById('adjustRotateRightBtn');
    if (rotLeftBtn) rotLeftBtn.addEventListener('click', () => rotateInModal(-90));
    if (rotRightBtn) rotRightBtn.addEventListener('click', () => rotateInModal(90));

    // リセットボタン
    const resetBtn = document.getElementById('adjustResetBtn');
    if (resetBtn) resetBtn.addEventListener('click', handleResetAdjustments);

    // 適用ボタン
    const applyBtn = document.getElementById('adjustApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', handleApplyAdjustments);

    // クロップ枠のドラッグ・リサイズイベント
    setupCropInteractions();

    // ウィンドウリサイズ連動
    window.addEventListener('resize', () => {
      if (modalEl && modalEl.style.display !== 'none' && adjustState.photo) {
        updateStageLayout();
      }
    });

    // 👁️ 元画像と比較 (Before/After) ホールドボタン
    if (compareOrigBtnEl) {
      compareOrigBtnEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        setCompareOriginalMode(true);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(evName => {
        compareOrigBtnEl.addEventListener(evName, () => {
          setCompareOriginalMode(false);
        });
      });
    }

    // 📋 トーン調整をコピー / 🎨 ペースト ボタン（モーダル内）
    if (copyToneBtnEl) {
      copyToneBtnEl.addEventListener('click', () => {
        copyCurrentModalToneAdjustments();
      });
    }
    if (pasteToneBtnEl) {
      pasteToneBtnEl.addEventListener('click', () => {
        pasteToneAdjustmentsToModal();
      });
    }

    // キーボード操作（Escで閉じる、R/Lで回転、\ または Space ホールドで元画像比較、Ctrl+Shift+C/V でトーンコピー＆ペースト）
    window.addEventListener('keydown', (e) => {
      if (modalEl && modalEl.style.display !== 'none') {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeImageAdjustModal();
        } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
          e.preventDefault();
          e.stopPropagation();
          copyCurrentModalToneAdjustments();
        } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
          e.preventDefault();
          e.stopPropagation();
          pasteToneAdjustmentsToModal();
        } else if (e.key === '\\' || e.key === '¥' || e.code === 'Backslash' || e.code === 'IntlYen' || e.code === 'IntlRo' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          setCompareOriginalMode(true);
        } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          rotateInModal(90);
        } else if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          rotateInModal(-90);
        }
      }
    }, true);

    window.addEventListener('keyup', (e) => {
      if (modalEl && modalEl.style.display !== 'none' && adjustState.isComparingOriginal) {
        if (e.key === '\\' || e.key === '¥' || e.code === 'Backslash' || e.code === 'IntlYen' || e.code === 'IntlRo' || e.key === ' ') {
          setCompareOriginalMode(false);
        }
      }
    }, true);
  }

  /**
   * モーダルを開いて編集を開始する
   */
  function openImageAdjustModal(photo) {
    if (!photo) return;
    if (!modalEl) initAdjustModule();

    adjustState.photo = photo;
    adjustState.rotation = photo.rotation || 0;
    adjustState.fineAngle = Number(photo.fine_angle) || 0.0;
    adjustState.brightness = dialIndexToBrightness(brightnessToDialIndex(Number(photo.brightness) || 0));
    adjustState.contrast = Number(photo.contrast) || 0;
    adjustState.saturation = Number(photo.saturation) || 0;
    adjustState.aspect = photo.crop_aspect || 'original';

    setCompareOriginalMode(false);

    // 比率ボタン・微調整スライダーの初期状態反映
    aspectBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.aspect === adjustState.aspect);
    });
    syncFineSlidersUI();
    syncPasteToneButtonsUI();

    // 先にモーダルを表示してステージのレンダリング寸法を確定させる
    modalEl.style.display = 'flex';

    // プレビュー画像のURL（常に未加工の元画像を読み込んで非破壊編集を行う）
    const previewUrl = `/api/photo/${photo.id}/view?raw=1`;
    imgEl.onload = () => {
      adjustState.naturalSize = {
        w: imgEl.naturalWidth || photo.width || 800,
        h: imgEl.naturalHeight || photo.height || 600,
      };
      requestAnimationFrame(updateStageLayout);
    };
    imgEl.src = previewUrl;

    if (imgEl.complete && imgEl.naturalWidth) {
      adjustState.naturalSize = {
        w: imgEl.naturalWidth,
        h: imgEl.naturalHeight,
      };
      requestAnimationFrame(updateStageLayout);
    }
  }

  /**
   * モーダルを閉じる
   */
  function closeImageAdjustModal() {
    setCompareOriginalMode(false);
    if (modalEl) modalEl.style.display = 'none';
    adjustState.photo = null;
    if (imgEl) {
      imgEl.style.filter = 'none';
      imgEl.src = '';
    }
  }

  /**
   * ステージと画像の配置・サイズを計算し、クロップ枠を初期化
   */
  function updateStageLayout() {
    if (!adjustState.photo || !imgEl.complete) return;

    // 回転が90度または270度のときは表示上の縦横比が反転
    const isTransposed = (adjustState.rotation % 180 !== 0);
    const naturalW = isTransposed ? adjustState.naturalSize.h : adjustState.naturalSize.w;
    const naturalH = isTransposed ? adjustState.naturalSize.w : adjustState.naturalSize.h;

    // ステージの利用可能領域
    const stageRect = stageEl.getBoundingClientRect();
    const maxW = Math.max(100, (stageRect.width || 800) - 32);
    const maxH = Math.max(100, (stageRect.height || 500) - 32);

    // アスペクト比を維持して最大表示サイズを算出
    const scale = Math.min(maxW / naturalW, maxH / naturalH, 1.0);
    const renderW = Math.max(50, Math.round(naturalW * scale));
    const renderH = Math.max(50, Math.round(naturalH * scale));

    // コンテナを画像表示エリアに完全に一致させる
    containerEl.style.width = `${renderW}px`;
    containerEl.style.height = `${renderH}px`;
    adjustState.containerSize = { w: renderW, h: renderH };

    // imgEl をコンテナの中央に配置し、回転状態に合わせて完全に一致させる
    if (isTransposed) {
      imgEl.style.width = `${renderH}px`;
      imgEl.style.height = `${renderW}px`;
    } else {
      imgEl.style.width = `${renderW}px`;
      imgEl.style.height = `${renderH}px`;
    }
    applyImageStagePreview(false);

    // 既存のクロップ情報があれば復元、なければ画像全体（100%）を選択
    const p = adjustState.photo;
    if (p.crop_w && p.crop_h && p.crop_w > 0 && p.crop_h > 0) {
      adjustState.crop = {
        x: Math.round((p.crop_x || 0) * renderW),
        y: Math.round((p.crop_y || 0) * renderH),
        w: Math.round(p.crop_w * renderW),
        h: Math.round(p.crop_h * renderH),
      };
    } else {
      // 初期状態は画像全体（100%）を選択
      adjustState.crop = { x: 0, y: 0, w: renderW, h: renderH };
    }

    renderCropBox();
  }

  /**
   * モーダル内での90度回転
   */
  function rotateInModal(delta) {
    adjustState.rotation = ((adjustState.rotation + delta) % 360 + 360) % 360;
    // 回転後はクロップ枠を画像全体にリセットし再レイアウト
    adjustState.photo.crop_w = null;
    adjustState.photo.crop_h = null;
    updateStageLayout();
  }

  /**
   * 比率プリセットの切り替え
   */
  function setCropAspect(aspect) {
    adjustState.aspect = aspect;
    aspectBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.aspect === aspect);
    });
    applyAspectToCrop(aspect);
    renderCropBox();
  }

  /**
   * 現在のコンテナサイズに合わせてアスペクト比をクロップ枠に適用
   */
  function applyAspectToCrop(aspect) {
    const { w: contW, h: contH } = adjustState.containerSize;
    if (contW <= 0 || contH <= 0) return;

    if (aspect === 'free') {
      return; // 自由変更モード（現在の枠のまま）
    }

    if (aspect === 'original') {
      // 元の比率: 画像全体（100%）にフィット
      adjustState.crop = { x: 0, y: 0, w: contW, h: contH };
      return;
    }

    let targetRatio = 1.0;
    switch (aspect) {
      case '1:1': targetRatio = 1.0; break;
      case '16:9': targetRatio = 16 / 9; break;
      case '4:3': targetRatio = 4 / 3; break;
      case '3:2': targetRatio = 3 / 2; break;
      default: targetRatio = 1.0; break;
    }

    // コンテナ内に収まる最大矩形を中央配置
    let newW = contW;
    let newH = Math.round(newW / targetRatio);

    if (newH > contH) {
      newH = contH;
      newW = Math.round(newH * targetRatio);
    }

    adjustState.crop = {
      x: Math.round((contW - newW) / 2),
      y: Math.round((contH - newH) / 2),
      w: Math.max(30, newW),
      h: Math.max(30, newH),
    };
  }

  /**
   * クロップ枠DOMの位置・サイズを更新
   */
  function renderCropBox() {
    if (!cropBoxEl) return;
    const { x, y, w, h } = adjustState.crop;
    cropBoxEl.style.left = `${Math.max(0, x)}px`;
    cropBoxEl.style.top = `${Math.max(0, y)}px`;
    cropBoxEl.style.width = `${Math.max(20, w)}px`;
    cropBoxEl.style.height = `${Math.max(20, h)}px`;

    if (typeof window.updateAdjustHistogram === 'function') {
      window.updateAdjustHistogram(imgEl, adjustState);
    }
  }

  /**
   * クロップ枠のドラッグ＆リサイズ操作設定
   */
  function setupCropInteractions() {
    if (!cropBoxEl || !containerEl) return;

    // ハンドルまたはクロップ枠上で mousedown
    cropBoxEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const handle = e.target.dataset.handle;
      adjustState.isDragging = true;
      adjustState.dragMode = handle || 'move';
      adjustState.dragStart = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        cropX: adjustState.crop.x,
        cropY: adjustState.crop.y,
        cropW: adjustState.crop.w,
        cropH: adjustState.crop.h,
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });

    function onPointerMove(e) {
      if (!adjustState.isDragging) return;
      e.preventDefault();

      const dx = e.clientX - adjustState.dragStart.mouseX;
      const dy = e.clientY - adjustState.dragStart.mouseY;
      const { cropX, cropY, cropW, cropH } = adjustState.dragStart;
      const { w: contW, h: contH } = adjustState.containerSize;
      const minSize = 30;

      if (adjustState.dragMode === 'move') {
        // 全体移動
        let newX = Math.max(0, Math.min(cropX + dx, contW - cropW));
        let newY = Math.max(0, Math.min(cropY + dy, contH - cropH));
        adjustState.crop.x = newX;
        adjustState.crop.y = newY;
        renderCropBox();
        return;
      }

      // ハンドルリサイズ
      const mode = adjustState.dragMode;
      const isFree = (!adjustState.aspect || adjustState.aspect === 'free');

      if (isFree) {
        // 自由変形モード
        let x1 = cropX;
        let y1 = cropY;
        let x2 = cropX + cropW;
        let y2 = cropY + cropH;

        if (mode.includes('e')) x2 = Math.max(x1 + minSize, Math.min(contW, x2 + dx));
        if (mode.includes('s')) y2 = Math.max(y1 + minSize, Math.min(contH, y2 + dy));
        if (mode.includes('w')) x1 = Math.max(0, Math.min(x2 - minSize, x1 + dx));
        if (mode.includes('n')) y1 = Math.max(0, Math.min(y2 - minSize, y1 + dy));

        adjustState.crop = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      } else {
        // 比率固定変形モード
        let targetRatio = 1.0;
        const isTransposed = (adjustState.rotation % 180 !== 0);
        const origW = isTransposed ? adjustState.naturalSize.h : adjustState.naturalSize.w;
        const origH = isTransposed ? adjustState.naturalSize.w : adjustState.naturalSize.h;
        if (adjustState.aspect === 'original') targetRatio = origW / origH;
        else if (adjustState.aspect === '1:1') targetRatio = 1.0;
        else if (adjustState.aspect === '16:9') targetRatio = 16 / 9;
        else if (adjustState.aspect === '4:3') targetRatio = 4 / 3;
        else if (adjustState.aspect === '3:2') targetRatio = 3 / 2;

        let x1 = cropX;
        let y1 = cropY;
        let x2 = cropX + cropW;
        let y2 = cropY + cropH;

        if (mode === 'se') {
          // 左上固定、右下を拡縮
          let maxAllowedW = contW - x1;
          let maxAllowedH = contH - y1;
          let newW = Math.max(minSize, cropW + dx);
          let newH = Math.round(newW / targetRatio);
          if (newH > maxAllowedH) {
            newH = maxAllowedH;
            newW = Math.round(newH * targetRatio);
          }
          if (newW > maxAllowedW) {
            newW = maxAllowedW;
            newH = Math.round(newW / targetRatio);
          }
          adjustState.crop = { x: x1, y: y1, w: Math.max(minSize, newW), h: Math.max(minSize, newH) };
        } else if (mode === 'nw') {
          // 右下固定、左上を拡縮
          let maxAllowedW = x2;
          let maxAllowedH = y2;
          let newW = Math.max(minSize, cropW - dx);
          let newH = Math.round(newW / targetRatio);
          if (newH > maxAllowedH) {
            newH = maxAllowedH;
            newW = Math.round(newH * targetRatio);
          }
          if (newW > maxAllowedW) {
            newW = maxAllowedW;
            newH = Math.round(newW / targetRatio);
          }
          adjustState.crop = { x: x2 - newW, y: y2 - newH, w: Math.max(minSize, newW), h: Math.max(minSize, newH) };
        } else if (mode === 'ne') {
          // 左下固定、右上を拡縮
          let maxAllowedW = contW - x1;
          let maxAllowedH = y2;
          let newW = Math.max(minSize, cropW + dx);
          let newH = Math.round(newW / targetRatio);
          if (newH > maxAllowedH) {
            newH = maxAllowedH;
            newW = Math.round(newH * targetRatio);
          }
          if (newW > maxAllowedW) {
            newW = maxAllowedW;
            newH = Math.round(newW / targetRatio);
          }
          adjustState.crop = { x: x1, y: y2 - newH, w: Math.max(minSize, newW), h: Math.max(minSize, newH) };
        } else if (mode === 'sw') {
          // 右上固定、左下を拡縮
          let maxAllowedW = x2;
          let maxAllowedH = contH - y1;
          let newW = Math.max(minSize, cropW - dx);
          let newH = Math.round(newW / targetRatio);
          if (newH > maxAllowedH) {
            newH = maxAllowedH;
            newW = Math.round(newH * targetRatio);
          }
          if (newW > maxAllowedW) {
            newW = maxAllowedW;
            newH = Math.round(newW / targetRatio);
          }
          adjustState.crop = { x: x2 - newW, y: y1, w: Math.max(minSize, newW), h: Math.max(minSize, newH) };
        } else if (mode === 'e' || mode === 'w') {
          // 左右から比率拡縮（中心基準）
          let newW = (mode === 'e') ? Math.max(minSize, cropW + dx) : Math.max(minSize, cropW - dx);
          let newH = Math.round(newW / targetRatio);
          let cy = cropY + cropH / 2;
          let newY = Math.round(cy - newH / 2);
          if (newY < 0) { newY = 0; newH = Math.min(contH, Math.round(newW / targetRatio)); }
          if (newY + newH > contH) { newH = contH - newY; newW = Math.round(newH * targetRatio); }
          let newX = (mode === 'e') ? cropX : cropX + (cropW - newW);
          newX = Math.max(0, Math.min(newX, contW - newW));
          adjustState.crop = { x: newX, y: Math.max(0, newY), w: Math.min(contW, newW), h: Math.min(contH, newH) };
        } else if (mode === 'n' || mode === 's') {
          // 上下から比率拡縮（中心基準）
          let newH = (mode === 's') ? Math.max(minSize, cropH + dy) : Math.max(minSize, cropH - dy);
          let newW = Math.round(newH * targetRatio);
          let cx = cropX + cropW / 2;
          let newX = Math.round(cx - newW / 2);
          if (newX < 0) { newX = 0; newW = Math.min(contW, Math.round(newH * targetRatio)); }
          if (newX + newW > contW) { newW = contW - newX; newH = Math.round(newW / targetRatio); }
          let newY = (mode === 's') ? cropY : cropY + (cropH - newH);
          newY = Math.max(0, Math.min(newY, contH - newH));
          adjustState.crop = { x: Math.max(0, newX), y: newY, w: Math.min(contW, newW), h: Math.min(contH, newH) };
        }
      }

      renderCropBox();
    }

    function onPointerUp(e) {
      adjustState.isDragging = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }
  }

  /**
   * 調整内容（回転・水平出し・クロップ・トーン微調整）をサーバーに送信して保存
   */
  async function handleApplyAdjustments() {
    const photo = adjustState.photo;
    if (!photo) return;

    const { w: contW, h: contH } = adjustState.containerSize;
    if (contW <= 0 || contH <= 0) return;

    // 相対座標（0.0〜1.0）を算出
    const cropX = parseFloat((adjustState.crop.x / contW).toFixed(4));
    const cropY = parseFloat((adjustState.crop.y / contH).toFixed(4));
    const cropW = parseFloat((adjustState.crop.w / contW).toFixed(4));
    const cropH = parseFloat((adjustState.crop.h / contH).toFixed(4));

    const isFull = (cropX <= 0.001 && cropY <= 0.001 && cropW >= 0.998 && cropH >= 0.998);
    const fineAngleVal = parseFloat((Number(adjustState.fineAngle) || 0).toFixed(2));
    const brightnessVal = Math.round(Number(adjustState.brightness) || 0);
    const contrastVal = Math.round(Number(adjustState.contrast) || 0);
    const saturationVal = Math.round(Number(adjustState.saturation) || 0);

    const payload = {
      rotation: adjustState.rotation,
      fine_angle: Math.abs(fineAngleVal) <= 0.01 ? 0.0 : fineAngleVal,
      crop_x: isFull ? null : cropX,
      crop_y: isFull ? null : cropY,
      crop_w: isFull ? null : cropW,
      crop_h: isFull ? null : cropH,
      crop_aspect: isFull ? null : adjustState.aspect,
      brightness: brightnessVal,
      contrast: contrastVal,
      saturation: saturationVal,
    };

    try {
      const res = await fetch(`/api/photo/${photo.id}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('調整の保存に失敗しました');

      // state.photos 内の該当データを更新
      photo.rotation = payload.rotation;
      photo.fine_angle = payload.fine_angle;
      photo.crop_x = payload.crop_x;
      photo.crop_y = payload.crop_y;
      photo.crop_w = payload.crop_w;
      photo.crop_h = payload.crop_h;
      photo.crop_aspect = payload.crop_aspect;
      photo.brightness = payload.brightness;
      photo.contrast = payload.contrast;
      photo.saturation = payload.saturation;
      photo._thumbBust = Date.now();

      // サムネイルおよびライトボックス表示に即時反映
      applyTransformToPhotoViews(photo);

      if (typeof state !== 'undefined' && state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
        state.activeInspectorPhotoId = photo.id;
        clearSelection();
      }

      if (typeof showToast === 'function') {
        showToast('画像の調整を保存しました');
      }

      closeImageAdjustModal();
    } catch (e) {
      console.error(e);
      if (typeof showToast === 'function') {
        showToast('画像の調整保存に失敗しました', 'error');
      }
    }
  }

  /**
   * 調整内容を初期状態（回転0、傾き0、クロップなし、トーン0）にリセット
   */
  async function handleResetAdjustments() {
    const photo = adjustState.photo;
    if (!photo) return;

    try {
      const res = await fetch(`/api/photo/${photo.id}/adjust/reset`, {
        method: 'POST',
      });

      if (!res.ok) throw new Error('リセットに失敗しました');

      photo.rotation = 0;
      photo.fine_angle = 0.0;
      photo.crop_x = null;
      photo.crop_y = null;
      photo.crop_w = null;
      photo.crop_h = null;
      photo.crop_aspect = null;
      photo.brightness = 0;
      photo.contrast = 0;
      photo.saturation = 0;
      photo._thumbBust = Date.now();

      applyTransformToPhotoViews(photo);

      if (typeof state !== 'undefined' && state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
        state.activeInspectorPhotoId = photo.id;
        clearSelection();
      }

      if (typeof showToast === 'function') {
        showToast('調整を初期状態に戻しました');
      }

      closeImageAdjustModal();
    } catch (e) {
      console.error(e);
      if (typeof showToast === 'function') {
        showToast('リセットに失敗しました', 'error');
      }
    }
  }

  /**
   * モーダルを開かず、その場で即座に90度回転する（爆速ショートカット / ボタン用）
   */
  async function rotatePhotoQuick(photoId, delta = 90) {
    if (!photoId) return;

    // 対象写真オブジェクトを取得
    const photo = (typeof state !== 'undefined' && state.photos)
      ? state.photos.find(p => p.id === photoId)
      : null;

    const currentRot = photo ? (photo.rotation || 0) : 0;
    const newRot = ((currentRot + delta) % 360 + 360) % 360;

    // 0遅延体感のため、写真カードのimgを一時的にCSS回転
    const cardEl = document.querySelector(`.photo-card[data-photo-id="${photoId}"]`);
    let thumbImg = null;
    if (cardEl) {
      thumbImg = cardEl.querySelector('.card-thumb-img') || cardEl.querySelector('img');
      if (thumbImg) {
        thumbImg.style.transition = 'transform 0.15s ease';
        thumbImg.style.transform = `rotate(${delta}deg)`;
      }
    }

    // ライトボックス表示中であれば即時回転
    if (photo) {
      photo.rotation = newRot;
      if (typeof getCurrentLightboxPhoto === 'function') {
        const cur = getCurrentLightboxPhoto();
        if (cur && cur.id === photo.id) {
          if (typeof state !== 'undefined') {
            state.currentRotation = (typeof hasBakedViewAdjustments === 'function' && hasBakedViewAdjustments(photo))
              ? (((state.currentRotation || 0) + delta) % 360 + 360) % 360
              : newRot;
          }
          if (typeof applyLightboxTransform === 'function') {
            applyLightboxTransform();
          }
        }
      }
    }

    try {
      const res = await fetch(`/api/photo/${photoId}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta }),
      });

      if (!res.ok) throw new Error('回転に失敗しました');
      const data = await res.json();

      if (photo) {
        photo.rotation = data.rotation;
        photo._thumbBust = Date.now();
        applyTransformToPhotoViews(photo);
      }

      if (typeof state !== 'undefined' && state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.has(photoId) && typeof clearSelection === 'function') {
        state.activeInspectorPhotoId = photoId;
        clearSelection();
      }

      const dirName = delta > 0 ? '右へ90°' : '左へ90°';
      if (typeof showToast === 'function') {
        showToast(`${dirName}回転しました`);
      }
    } catch (e) {
      console.error(e);
      if (thumbImg) {
        thumbImg.style.transition = '';
        thumbImg.style.transform = '';
      }
      if (typeof showToast === 'function') {
        showToast('写真の回転に失敗しました', 'error');
      }
    }
  }

  /**
   * 複数写真の一括回転
   */
  async function batchRotatePhotosQuick(photoIds, delta = 90) {
    if (!photoIds || !photoIds.length) return;

    // 先にUI上の写真カードを一時CSS回転
    photoIds.forEach(pid => {
      const cardEl = document.querySelector(`.photo-card[data-photo-id="${pid}"]`);
      if (cardEl) {
        const thumbImg = cardEl.querySelector('.card-thumb-img') || cardEl.querySelector('img');
        if (thumbImg) {
          thumbImg.style.transition = 'transform 0.15s ease';
          thumbImg.style.transform = `rotate(${delta}deg)`;
        }
      }
    });

    try {
      const res = await fetch('/api/photos/batch-rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_ids: photoIds, delta }),
      });

      if (!res.ok) throw new Error('一括回転に失敗しました');
      const data = await res.json();

      // 各写真の rotation を更新し、再生成されたサムネイルを反映
      if (typeof state !== 'undefined' && state.photos) {
        state.photos.forEach(p => {
          if (photoIds.includes(p.id)) {
            p.rotation = (((p.rotation || 0) + delta) % 360 + 360) % 360;
            p._thumbBust = Date.now();
            applyTransformToPhotoViews(p);
          }
        });
      }

      if (typeof state !== 'undefined' && state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
        clearSelection();
      } else if (typeof updateInspectorView === 'function' && typeof state !== 'undefined' && state.isInspectorOpen) {
        updateInspectorView();
      }

      const dirName = delta > 0 ? '右へ90°' : '左へ90°';
      if (typeof showToast === 'function') {
        showToast(`${data.affected || photoIds.length}枚を${dirName}一括回転しました`);
      }
    } catch (e) {
      console.error(e);
      // エラー時は一時スタイルをリセット
      photoIds.forEach(pid => {
        const cardEl = document.querySelector(`.photo-card[data-photo-id="${pid}"]`);
        if (cardEl) {
          const thumbImg = cardEl.querySelector('.card-thumb-img') || cardEl.querySelector('img');
          if (thumbImg) {
            thumbImg.style.transition = '';
            thumbImg.style.transform = '';
          }
        }
      });
      if (typeof showToast === 'function') {
        showToast('一括回転に失敗しました', 'error');
      }
    }
  }

  /**
   * 単一写真の回転・傾き・クロップ・トーンを即座にリセット（0度・無加工に戻す）
   */
  async function resetPhotoAdjustmentsQuick(photoId) {
    if (!photoId) return;

    const photo = (typeof state !== 'undefined' && state.photos)
      ? state.photos.find(p => p.id === photoId)
      : null;

    try {
      const res = await fetch(`/api/photo/${photoId}/adjust/reset`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('リセットに失敗しました');

      if (photo) {
        photo.rotation = 0;
        photo.fine_angle = 0.0;
        photo.crop_x = null;
        photo.crop_y = null;
        photo.crop_w = null;
        photo.crop_h = null;
        photo.crop_aspect = null;
        photo.brightness = 0;
        photo.contrast = 0;
        photo.saturation = 0;
        photo._thumbBust = Date.now();
        applyTransformToPhotoViews(photo);
      }

      if (typeof state !== 'undefined' && state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.has(photoId) && typeof clearSelection === 'function') {
        state.activeInspectorPhotoId = photoId;
        clearSelection();
      } else if (typeof updateInspectorView === 'function' && typeof state !== 'undefined' && state.isInspectorOpen) {
        updateInspectorView();
      }

      if (typeof showToast === 'function') {
        showToast('回転・調整をリセットしました');
      }
    } catch (e) {
      console.error(e);
      if (typeof showToast === 'function') {
        showToast('リセットに失敗しました', 'error');
      }
    }
  }

  /**
   * 複数写真の回転・傾き・クロップ・トーンを一括リセット
   */
  async function batchResetPhotoAdjustmentsQuick(photoIds) {
    if (!photoIds || !photoIds.length) return;

    try {
      const res = await fetch('/api/photos/batch-reset-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_ids: photoIds }),
      });
      if (!res.ok) throw new Error('一括リセットに失敗しました');
      const data = await res.json();

      if (typeof state !== 'undefined' && state.photos) {
        state.photos.forEach(p => {
          if (photoIds.includes(p.id)) {
            p.rotation = 0;
            p.fine_angle = 0.0;
            p.crop_x = null;
            p.crop_y = null;
            p.crop_w = null;
            p.crop_h = null;
            p.crop_aspect = null;
            p.brightness = 0;
            p.contrast = 0;
            p.saturation = 0;
            p._thumbBust = Date.now();
            applyTransformToPhotoViews(p);
          }
        });
      }

      if (typeof state !== 'undefined' && state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
        clearSelection();
      } else if (typeof updateInspectorView === 'function' && typeof state !== 'undefined' && state.isInspectorOpen) {
        updateInspectorView();
      }

      if (typeof showToast === 'function') {
        showToast(`${data.affected || photoIds.length}枚の回転・調整をリセットしました`);
      }
    } catch (e) {
      console.error(e);
      if (typeof showToast === 'function') {
        showToast('一括リセットに失敗しました', 'error');
      }
    }
  }

  /**
   * 写真の回転・傾き・クロップ・トーンをサムネイルカードおよびライトボックス、インスペクタに反映
   */
  function applyTransformToPhotoViews(photo) {
    if (!photo) return;

    // クライアント上で回転・クロップが変更された直後は、再生成サムネイルがロードされるまで
    // 元寸法(width/height)＋新rotation＋新cropから正確な比率を計算させるため古いthumb寸法を一旦クリア
    photo.thumb_width = null;
    photo.thumb_height = null;

    // 1. 中央グリッド内の写真カードの <img>
    const cardEl = document.querySelector(`.photo-card[data-photo-id="${photo.id}"]`);
    if (cardEl) {
      // 縦横比とカードの portrait/landscape を最新の回転・クロップ状態に合わせて即時更新
      if (typeof getPhotoAspectInfo === 'function') {
        const aspectInfo = getPhotoAspectInfo(photo);
        cardEl.classList.toggle('is-portrait', aspectInfo.isPortrait);
        cardEl.classList.toggle('is-landscape', !aspectInfo.isPortrait);
        cardEl.style.setProperty('--photo-aspect', aspectInfo.aspectCss);
        cardEl.style.setProperty('--photo-aspect-ratio', aspectInfo.aspectRatio);
      }

      const thumbImg = cardEl.querySelector('.card-thumb-img') || cardEl.querySelector('img');
      if (thumbImg) {
        const newSrc = typeof getThumbnailUrl === 'function'
          ? `${getThumbnailUrl(photo)}&t=${Date.now()}`
          : `/api/photo/${photo.id}/thumbnail?t=${Date.now()}`;

        // 新しいサムネイルをプリロードして、ロード完了時に差し替え（ちらつき・二重回転ゼロ）
        const loader = new Image();
        loader.onload = () => {
          if (loader.naturalWidth > 0 && loader.naturalHeight > 0) {
            photo.thumb_width = loader.naturalWidth;
            photo.thumb_height = loader.naturalHeight;
          }
          thumbImg.style.transition = '';
          thumbImg.style.transform = '';
          thumbImg.src = newSrc;
          if (typeof onThumbImageLoad === 'function') {
            onThumbImageLoad(thumbImg);
          }
        };
        loader.src = newSrc;
      }
    }

    // 2. 右インスペクタのプレビュー
    const inspectorThumb = document.getElementById('inspectorThumb');
    if (inspectorThumb && typeof state !== 'undefined' && (state.selectedPhotoIds.has(photo.id) || state.activeInspectorPhotoId === photo.id)) {
      const newSrc = typeof getThumbnailUrl === 'function'
        ? `${getThumbnailUrl(photo)}&t=${Date.now()}`
        : `/api/photo/${photo.id}/thumbnail?t=${Date.now()}`;
      const loader = new Image();
      loader.onload = () => {
        inspectorThumb.style.transform = '';
        inspectorThumb.src = newSrc;
      };
      loader.src = newSrc;
    }

    // 3. ライトボックス表示中であればライトボックス画像・フィルムストリップを更新
    if (typeof getCurrentLightboxPhoto === 'function') {
      const cur = getCurrentLightboxPhoto();
      if (cur && cur.id === photo.id) {
        if (typeof updateLightboxContent === 'function') {
          updateLightboxContent(photo);
        } else {
          if (typeof state !== 'undefined') {
            state.currentRotation = (typeof hasBakedViewAdjustments === 'function' && hasBakedViewAdjustments(photo)) ? 0 : (photo.rotation || 0);
          }
          if (typeof applyLightboxTransform === 'function') {
            applyLightboxTransform();
          }
        }
        if (typeof elements !== 'undefined' && elements.filmstrip && typeof state !== 'undefined' && state.currentPhotoIndex >= 0) {
          const filmItem = elements.filmstrip.children[state.currentPhotoIndex];
          if (filmItem) {
            const filmImg = filmItem.querySelector('img');
            if (filmImg && typeof getThumbnailUrl === 'function') {
              filmImg.src = getThumbnailUrl(photo);
            }
          }
        }
      }
    }
  }

  // 初期化登録
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdjustModule);
  } else {
    initAdjustModule();
  }

  /* ==========================================================================
     トーン調整（明るさ・コントラスト・彩度）のコピー＆一括ペースト ＋ 画像クリップボードコピー
     ※ユーザー指定により、コピー・ペースト対象はトーン3項目（明・比・彩）のみとし、
       水平傾き（fine_angle）・90度回転（rotation）・クロップ枠（crop_*）は各写真の既存値を維持する。
     ========================================================================== */

  const TONE_CLIPBOARD_KEY = 'pm_copied_tone_adjust';

  /**
   * コピー済みのトーン調整値 ({ brightness, contrast, saturation }) を取得する
   */
  function getCopiedToneAdjustments() {
    if (typeof state !== 'undefined' && state.copiedToneAdjustments) {
      return state.copiedToneAdjustments;
    }
    try {
      const raw = localStorage.getItem(TONE_CLIPBOARD_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const clean = {
            brightness: dialIndexToBrightness(brightnessToDialIndex(Number(parsed.brightness) || 0)),
            contrast: Math.max(-100, Math.min(100, Math.round(Number(parsed.contrast) || 0))),
            saturation: Math.max(-100, Math.min(100, Math.round(Number(parsed.saturation) || 0))),
          };
          if (typeof state !== 'undefined') state.copiedToneAdjustments = clean;
          return clean;
        }
      }
    } catch (e) {}
    return null;
  }

  /**
   * トーン調整値を保存し、関連UIボタンのツールチップ等を同期する
   */
  function setCopiedToneAdjustments(tone) {
    const clean = {
      brightness: dialIndexToBrightness(brightnessToDialIndex(Number(tone.brightness) || 0)),
      contrast: Math.max(-100, Math.min(100, Math.round(Number(tone.contrast) || 0))),
      saturation: Math.max(-100, Math.min(100, Math.round(Number(tone.saturation) || 0))),
    };
    if (typeof state !== 'undefined') {
      state.copiedToneAdjustments = clean;
    }
    try {
      localStorage.setItem(TONE_CLIPBOARD_KEY, JSON.stringify(clean));
    } catch (e) {}
    syncPasteToneButtonsUI();
    return clean;
  }

  /**
   * トーン調整値の人間向けサマリー文字列を生成する
   */
  function formatToneSummary(tone) {
    if (!tone) return '';
    const b = Number(tone.brightness) || 0;
    const c = Number(tone.contrast) || 0;
    const s = Number(tone.saturation) || 0;
    const evStr = `${b > 0 ? '+' : ''}${(b / 10.0).toFixed(1)}EV`;
    const cStr = `${c > 0 ? '+' : ''}${c}`;
    const sStr = `${s > 0 ? '+' : ''}${s}`;
    const isEn = typeof window.getCurrentLang === 'function' && window.getCurrentLang() === 'en';
    if (isEn) {
      return `EV:${evStr} / Con:${cStr} / Sat:${sStr}`;
    }
    return `明:${evStr} / 比:${cStr} / 彩:${sStr}`;
  }

  /**
   * ペーストボタンの有効状態・ツールチップを同期する
   */
  function syncPasteToneButtonsUI() {
    const copied = getCopiedToneAdjustments();
    const summary = copied ? ` (${formatToneSummary(copied)})` : '';
    if (pasteToneBtnEl) {
      pasteToneBtnEl.disabled = !copied;
      pasteToneBtnEl.style.opacity = copied ? '1' : '0.55';
      pasteToneBtnEl.title = copied
        ? `コピー済みのトーン調整をペースト${summary} (Ctrl+Shift+V)`
        : '先に「トーンをコピー」を実行してください (Ctrl+Shift+C)';
    }
  }

  /**
   * 画像調整モーダル内の現在スライダー値からトーン3項目（明・比・彩）をコピーする
   */
  function copyCurrentModalToneAdjustments() {
    const saved = setCopiedToneAdjustments({
      brightness: adjustState.brightness,
      contrast: adjustState.contrast,
      saturation: adjustState.saturation,
    });
    if (typeof showToast === 'function') {
      showToast(`📋 トーン調整をコピーしました（${formatToneSummary(saved)}）`, 'info');
    }
  }

  /**
   * 画像調整モーダル内のスライダーへコピー済みトーン3項目をペーストする（傾き・回転・クロップは維持）
   */
  function pasteToneAdjustmentsToModal() {
    const copied = getCopiedToneAdjustments();
    if (!copied) {
      if (typeof showToast === 'function') {
        showToast('⚠️ コピーされたトーン調整がありません（先にコピーしてください）', 'warning');
      }
      return;
    }
    adjustState.brightness = copied.brightness;
    adjustState.contrast = copied.contrast;
    adjustState.saturation = copied.saturation;
    syncFineSlidersUI();
    applyImageStagePreview(false);
    if (typeof showToast === 'function') {
      showToast(`🎨 トーン調整を反映しました（${formatToneSummary(copied)}）`, 'info');
    }
  }

  /**
   * 指定写真（一覧・ライトボックス）のトーン調整値（明・比・彩）をコピーする
   */
  function copyPhotoToneAdjustments(photoOrId) {
    let photo = null;
    if (photoOrId && typeof photoOrId === 'object') {
      photo = photoOrId;
    } else if (photoOrId && typeof state !== 'undefined' && state.photos) {
      photo = state.photos.find(p => p.id === Number(photoOrId));
    }
    if (!photo) return;

    const saved = setCopiedToneAdjustments({
      brightness: Number(photo.brightness) || 0,
      contrast: Number(photo.contrast) || 0,
      saturation: Number(photo.saturation) || 0,
    });
    if (typeof showToast === 'function') {
      showToast(`📋 「${photo.file_name}」のトーン調整をコピーしました（${formatToneSummary(saved)}）`, 'info');
    }
  }

  /**
   * コピー済みのトーン調整値（明・比・彩）を複数写真へ一括ペーストする（各写真の回転・傾き・クロップは維持）
   */
  async function batchPastePhotoToneAdjustments(photoIds) {
    if (!photoIds || !photoIds.length) return;
    const copied = getCopiedToneAdjustments();
    if (!copied) {
      if (typeof showToast === 'function') {
        showToast('⚠️ 先にトーン調整をコピーしてください (Ctrl+Shift+C)', 'warning');
      }
      return;
    }

    try {
      const res = await fetch('/api/photos/batch-adjust-tone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photo_ids: photoIds,
          brightness: copied.brightness,
          contrast: copied.contrast,
          saturation: copied.saturation,
        }),
      });
      if (!res.ok) throw new Error('トーン調整の一括ペーストに失敗しました');
      const data = await res.json();

      if (typeof state !== 'undefined' && state.photos) {
        state.photos.forEach(p => {
          if (photoIds.includes(p.id)) {
            p.brightness = copied.brightness;
            p.contrast = copied.contrast;
            p.saturation = copied.saturation;
            p._thumbBust = Date.now();
            applyTransformToPhotoViews(p);
          }
        });
      }

      if (typeof updateInspectorView === 'function' && typeof state !== 'undefined' && state.isInspectorOpen) {
        updateInspectorView();
      }

      if (typeof showToast === 'function') {
        showToast(`🎨 ${data.affected || photoIds.length}枚にトーン調整をペーストしました（${formatToneSummary(copied)}）`, 'success');
      }
    } catch (e) {
      console.error(e);
      if (typeof showToast === 'function') {
        showToast('トーン調整の一括ペーストに失敗しました', 'error');
      }
    }
  }

  /**
   * 指定写真（非破壊調整反映済み）をOSのクリップボードへPNG画像としてコピーする (Ctrl+C)
   */
  async function copyPhotoImageToClipboard(photoOrId) {
    let photo = null;
    if (photoOrId && typeof photoOrId === 'object') {
      photo = photoOrId;
    } else if (photoOrId && typeof state !== 'undefined' && state.photos) {
      photo = state.photos.find(p => p.id === Number(photoOrId));
    }
    if (!photo) return;

    if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
      if (typeof showToast === 'function') {
        showToast('⚠️ お使いのブラウザ環境ではクリップボードへの画像コピーに対応していません', 'warning');
      }
      return;
    }

    try {
      const pngBlobPromise = new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            // /api/photo/{id}/view はクロップ・傾き・トーン調整がある場合は回転ごと焼き込み済みを返し、
            // 90度単位の回転のみの場合は元画像を返すため、未焼き込みの90度回転のみCanvas上で適用する
            const hasBaked = (typeof hasBakedViewAdjustments === 'function') && hasBakedViewAdjustments(photo);
            const clientRot = hasBaked ? 0 : (((photo.rotation || 0) % 360 + 360) % 360);
            const swapDim = (clientRot === 90 || clientRot === 270);
            const srcW = img.naturalWidth || img.width || 800;
            const srcH = img.naturalHeight || img.height || 600;
            const canvas = document.createElement('canvas');
            canvas.width = swapDim ? srcH : srcW;
            canvas.height = swapDim ? srcW : srcH;
            const ctx = canvas.getContext('2d');
            if (clientRot !== 0) {
              ctx.translate(canvas.width / 2, canvas.height / 2);
              ctx.rotate((clientRot * Math.PI) / 180);
              ctx.drawImage(img, -srcW / 2, -srcH / 2, srcW, srcH);
            } else {
              ctx.drawImage(img, 0, 0, srcW, srcH);
            }
            canvas.toBlob((blob) => {
              if (blob) resolve(blob);
              else reject(new Error('PNG変換に失敗しました'));
            }, 'image/png');
          } catch (err) {
            reject(err);
          }
        };
        img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        img.src = `/api/photo/${photo.id}/view?t=${photo._thumbBust || Date.now()}`;
      });

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlobPromise }),
      ]);

      if (typeof showToast === 'function') {
        showToast(`📋 「${photo.file_name}」をクリップボードにコピーしました (Ctrl+V で貼り付け可能)`, 'success');
      }
    } catch (e) {
      console.error('Clipboard image copy error:', e);
      if (typeof showToast === 'function') {
        showToast('クリップボードへの画像コピーに失敗しました', 'error');
      }
    }
  }

  // グローバル公開
  window.openImageAdjustModal = openImageAdjustModal;
  window.closeImageAdjustModal = closeImageAdjustModal;
  window.rotatePhotoQuick = rotatePhotoQuick;
  window.batchRotatePhotosQuick = batchRotatePhotosQuick;
  window.resetPhotoAdjustmentsQuick = resetPhotoAdjustmentsQuick;
  window.batchResetPhotoAdjustmentsQuick = batchResetPhotoAdjustmentsQuick;
  window.applyTransformToPhotoViews = applyTransformToPhotoViews;
  window.getCopiedToneAdjustments = getCopiedToneAdjustments;
  window.copyPhotoToneAdjustments = copyPhotoToneAdjustments;
  window.batchPastePhotoToneAdjustments = batchPastePhotoToneAdjustments;
  window.copyPhotoImageToClipboard = copyPhotoImageToClipboard;

})();
