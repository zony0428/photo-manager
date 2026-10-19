/**
 * Photo Manager - フルスクリーンスライドショービューア (Slideshow Viewer)
 * Picasa / Tiar のような直感的で美しい写真鑑賞体験を提供
 */

(function() {
  'use strict';

  // 保存された設定の読み込み
  const savedInterval = parseInt(localStorage.getItem('pm_slideshow_interval'), 10);
  const savedShuffle = localStorage.getItem('pm_slideshow_shuffle');
  const savedInfo = localStorage.getItem('pm_slideshow_info');

  // スライドショーの内部状態
  const ssState = {
    isOpen: false,
    photos: [],
    currentIndex: 0,
    isPlaying: true,
    intervalSec: (savedInterval && [3, 5, 10].includes(savedInterval)) ? savedInterval : 5,
    isShuffle: savedShuffle === 'true',
    showInfo: savedInfo !== null ? savedInfo === 'true' : true,
    activeSlot: 'A', // 'A' または 'B' (ダブルバッファ)
    shuffledOrder: [],
    slideTimer: null,
    idleTimer: null,
    progressRafId: null,
    progressStartTime: null,
    pausedRemainingMs: null,
    title: '',
  };

  // DOM要素キャッシュ
  let ssModal, progressBar, headerBar, titleEl, counterEl, closeBtn;
  let stageEl, imgA, imgB, hitboxLeft, hitboxRight, exifBadge, exifFilename, exifDetails;
  let controlsEl, prevBtn, playPauseBtn, playIcon, nextBtn, speedBtns, shuffleBtn, infoBtn, fsBtn;

  function initDOMElements() {
    ssModal = document.getElementById('slideshowModal');
    if (!ssModal) return false;

    progressBar = document.getElementById('slideshowProgressBar');
    headerBar = document.getElementById('slideshowHeaderBar');
    titleEl = document.getElementById('slideshowTitle');
    counterEl = document.getElementById('slideshowCounter');
    closeBtn = document.getElementById('slideshowCloseBtn');

    stageEl = document.getElementById('slideshowStage');
    imgA = document.getElementById('slideshowImgA');
    imgB = document.getElementById('slideshowImgB');
    hitboxLeft = document.getElementById('slideshowHitboxLeft');
    hitboxRight = document.getElementById('slideshowHitboxRight');

    exifBadge = document.getElementById('slideshowExifBadge');
    exifFilename = document.getElementById('slideshowExifFilename');
    exifDetails = document.getElementById('slideshowExifDetails');

    controlsEl = document.getElementById('slideshowControls');
    prevBtn = document.getElementById('slideshowPrevBtn');
    playPauseBtn = document.getElementById('slideshowPlayPauseBtn');
    playIcon = document.getElementById('slideshowPlayIcon');
    nextBtn = document.getElementById('slideshowNextBtn');
    speedBtns = document.querySelectorAll('.slideshow-speed-btn');
    shuffleBtn = document.getElementById('slideshowShuffleBtn');
    infoBtn = document.getElementById('slideshowInfoBtn');
    fsBtn = document.getElementById('slideshowFullscreenBtn');

    return true;
  }

  /**
   * シャッフル順序の生成 (Fisher-Yates)
   */
  function generateShuffledOrder(length, startIndex = 0) {
    const indices = Array.from({ length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const pos = indices.indexOf(startIndex);
    if (pos > -1) {
      indices.splice(pos, 1);
      indices.unshift(startIndex);
    }
    return indices;
  }

  /**
   * 現在表示すべき写真オブジェクトを取得
   */
  function getCurrentPhoto() {
    if (!ssState.photos || ssState.photos.length === 0) return null;
    let idx = ssState.currentIndex;
    if (ssState.isShuffle && ssState.shuffledOrder.length === ssState.photos.length) {
      idx = ssState.shuffledOrder[ssState.currentIndex];
    }
    return ssState.photos[idx] || null;
  }

  /**
   * Exif情報バッジの更新
   */
  function updateExifBadge(photo) {
    if (!exifBadge || !photo) return;

    if (!ssState.showInfo) {
      exifBadge.classList.add('hidden');
      return;
    }
    exifBadge.classList.remove('hidden');

    const fn = photo.filename || (photo.file_path ? photo.file_path.replaceAll('\\', '/').split('/').pop() : 'Photo');
    if (exifFilename) exifFilename.textContent = fn;

    const details = [];
    if (photo.date_taken) {
      details.push(photo.date_taken);
    }
    const cam = [photo.camera_make, photo.camera_model].filter(Boolean).join(' ');
    if (cam) details.push(cam);
    if (photo.lens_model) details.push(photo.lens_model);

    const shotSettings = [];
    if (photo.f_number) shotSettings.push(`f/${photo.f_number}`);
    if (photo.exposure_time) shotSettings.push(`${photo.exposure_time}s`);
    if (photo.iso) shotSettings.push(`ISO ${photo.iso}`);
    if (photo.focal_length) shotSettings.push(`${photo.focal_length}mm`);
    if (shotSettings.length > 0) details.push(shotSettings.join('  '));

    // 評価表示
    if (photo.rating !== undefined && photo.rating !== null) {
      const rMap = { 2: '\u2605\u2605 (\u30d9\u30b9\u30c8)', 1: '\u2605 \u597d\u304d', 0: '\u7121\u5370', '-1': '\u2715 \u9664\u5916' };
      if (rMap[photo.rating]) details.push(rMap[photo.rating]);
    }

    if (exifDetails) {
      exifDetails.innerHTML = details.map(d => `<div>${escapeHtml(d)}</div>`).join('');
    }
  }

  /**
   * HTMLエスケープヘルパー
   */
  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m]);
  }

  /**
   * 現在のスライドを表示 (クロスフェード)
   */
  function renderCurrentSlide() {
    const photo = getCurrentPhoto();
    if (!photo) return;

    // カウンター更新
    if (counterEl) {
      counterEl.textContent = `${ssState.currentIndex + 1} / ${ssState.photos.length}`;
    }

    // Exif情報更新
    updateExifBadge(photo);

    const targetUrl = getPhotoViewUrl(photo);
    const nextSlot = ssState.activeSlot === 'A' ? imgB : imgA;
    const curSlot = ssState.activeSlot === 'A' ? imgA : imgB;

    // 先行読み込み後にクロスフェード
    const preloader = new Image();
    preloader.src = targetUrl;
    preloader.onload = () => {
      nextSlot.src = targetUrl;
      nextSlot.classList.add('active');
      curSlot.classList.remove('active');
      ssState.activeSlot = ssState.activeSlot === 'A' ? 'B' : 'A';
    };
    preloader.onerror = () => {
      nextSlot.src = targetUrl;
      nextSlot.classList.add('active');
      curSlot.classList.remove('active');
      ssState.activeSlot = ssState.activeSlot === 'A' ? 'B' : 'A';
    };

    // 次の写真をプリロード
    preloadNextSlide();

    // 再生中ならプログレスバー再開
    if (ssState.isPlaying) {
      startProgressBarAnimation();
    }
  }

  /**
   * 次のスライドをプリロード
   */
  function preloadNextSlide() {
    if (ssState.photos.length <= 1) return;
    const nextIdx = (ssState.currentIndex + 1) % ssState.photos.length;
    let actualIdx = nextIdx;
    if (ssState.isShuffle && ssState.shuffledOrder.length === ssState.photos.length) {
      actualIdx = ssState.shuffledOrder[nextIdx];
    }
    const nextPhoto = ssState.photos[actualIdx];
    if (nextPhoto) {
      const cacheImg = new Image();
      cacheImg.src = getPhotoViewUrl(nextPhoto);
    }
  }

  /**
   * プログレスバーのアニメーション
   */
  function startProgressBarAnimation(durationMs = null) {
    cancelAnimationFrame(ssState.progressRafId);
    const totalDuration = durationMs || (ssState.intervalSec * 1000);
    const startTime = performance.now();
    ssState.progressStartTime = startTime;

    function step(now) {
      if (!ssState.isPlaying || !ssState.isOpen) return;
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / totalDuration, 1);
      if (progressBar) {
        progressBar.style.width = `${progress * 100}%`;
      }
      if (progress < 1) {
        ssState.progressRafId = requestAnimationFrame(step);
      }
    }
    ssState.progressRafId = requestAnimationFrame(step);
  }

  /**
   * 次のスライドをスケジュール
   */
  function scheduleNextSlide(delayMs = null) {
    clearTimeout(ssState.slideTimer);
    if (!ssState.isPlaying || !ssState.isOpen) return;

    const delay = delayMs !== null ? delayMs : (ssState.intervalSec * 1000);
    startProgressBarAnimation(delay);

    ssState.slideTimer = setTimeout(() => {
      nextSlide();
    }, delay);
  }

  /**
   * 次の写真へ進む
   */
  function nextSlide() {
    if (ssState.photos.length <= 1) return;
    ssState.currentIndex = (ssState.currentIndex + 1) % ssState.photos.length;
    renderCurrentSlide();
    if (ssState.isPlaying) {
      scheduleNextSlide();
    }
  }

  /**
   * 前の写真へ戻る
   */
  function prevSlide() {
    if (ssState.photos.length <= 1) return;
    ssState.currentIndex = (ssState.currentIndex - 1 + ssState.photos.length) % ssState.photos.length;
    renderCurrentSlide();
    if (ssState.isPlaying) {
      scheduleNextSlide();
    }
  }

  /**
   * 再生 / 一時停止の切り替え
   */
  function togglePlayPause() {
    ssState.isPlaying = !ssState.isPlaying;

    if (playIcon) {
      playIcon.innerHTML = ssState.isPlaying ? '&#x23f8;&#xfe0e;' : '&#x25b6;&#xfe0e;';
    }
    if (playPauseBtn) {
      playPauseBtn.title = ssState.isPlaying ? '一時停止 (Space)' : '再生 (Space)';
    }

    if (ssState.isPlaying) {
      scheduleNextSlide();
    } else {
      clearTimeout(ssState.slideTimer);
      cancelAnimationFrame(ssState.progressRafId);
      if (progressBar) progressBar.style.width = '0%';
    }
  }

  /**
   * 秒数変更 (3s, 5s, 10s)
   */
  function setIntervalSec(sec) {
    ssState.intervalSec = sec;
    localStorage.setItem('pm_slideshow_interval', sec);
    if (speedBtns) {
      speedBtns.forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.sec, 10) === sec);
      });
    }
    if (ssState.isPlaying) {
      scheduleNextSlide();
    }
  }

  /**
   * シャッフル切り替え
   */
  function toggleShuffle() {
    ssState.isShuffle = !ssState.isShuffle;
    localStorage.setItem('pm_slideshow_shuffle', ssState.isShuffle ? 'true' : 'false');
    if (shuffleBtn) {
      shuffleBtn.classList.toggle('active', ssState.isShuffle);
    }
    if (ssState.isShuffle) {
      ssState.shuffledOrder = generateShuffledOrder(ssState.photos.length, ssState.currentIndex);
      ssState.currentIndex = 0;
    }
  }

  /**
   * Exif情報の表示切り替え
   */
  function toggleInfo() {
    ssState.showInfo = !ssState.showInfo;
    localStorage.setItem('pm_slideshow_info', ssState.showInfo ? 'true' : 'false');
    if (infoBtn) {
      infoBtn.classList.toggle('active', ssState.showInfo);
    }
    if (exifBadge) {
      exifBadge.classList.toggle('hidden', !ssState.showInfo);
    }
  }

  /**
   * 全画面モード切り替え
   */
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      if (ssModal && ssModal.requestFullscreen) {
        ssModal.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }

  /**
   * アイドル判定 (マウス停止でコントロールを隠す)
   */
  function resetIdleTimer() {
    if (!ssModal) return;
    ssModal.classList.remove('idle');
    clearTimeout(ssState.idleTimer);
    ssState.idleTimer = setTimeout(() => {
      if (ssState.isOpen && ssState.isPlaying) {
        ssModal.classList.add('idle');
      }
    }, 3000);
  }

  /**
   * キーボードショートカット
   */
  function handleKeyDown(e) {
    if (!ssState.isOpen) return;

    resetIdleTimer();

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlayPause();
        break;
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        nextSlide();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        prevSlide();
        break;
      case 'Escape':
        e.preventDefault();
        closeSlideshow();
        break;
      case 'KeyF':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'KeyI':
        e.preventDefault();
        toggleInfo();
        break;
      case 'KeyS':
        e.preventDefault();
        toggleShuffle();
        break;
    }
  }

  /**
   * スライドショー開始 (公開関数)
   * @param {Array} photos - 表示対象の写真リスト
   * @param {number} startIndex - 開始インデックス
   * @param {string} title - スライドショーのタイトル
   */
  function startSlideshow(photos, startIndex = 0, title = '') {
    if (!photos || photos.length === 0) {
      if (typeof showToast === 'function') {
        showToast('スライドショーの対象写真がありません', 'warning');
      }
      return;
    }

    if (!initDOMElements()) return;

    ssState.isOpen = true;
    ssState.photos = [...photos];
    ssState.currentIndex = Math.max(0, Math.min(startIndex, photos.length - 1));
    ssState.isPlaying = true;
    ssState.activeSlot = 'A';
    ssState.title = title || 'スライドショー';

    if (titleEl) titleEl.textContent = ssState.title;
    if (playIcon) playIcon.innerHTML = '&#x23f8;&#xfe0e;';

    // バッファ初期化
    if (imgA) { imgA.src = ''; imgA.className = 'slideshow-img'; }
    if (imgB) { imgB.src = ''; imgB.className = 'slideshow-img'; }

    // UI状態同期（速度・シャッフル・Exif）
    if (speedBtns) {
      speedBtns.forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.sec, 10) === ssState.intervalSec);
      });
    }
    if (shuffleBtn) {
      shuffleBtn.classList.toggle('active', ssState.isShuffle);
    }
    if (infoBtn) {
      infoBtn.classList.toggle('active', ssState.showInfo);
    }
    if (exifBadge) {
      exifBadge.classList.toggle('hidden', !ssState.showInfo);
    }

    if (ssState.isShuffle) {
      ssState.shuffledOrder = generateShuffledOrder(ssState.photos.length, ssState.currentIndex);
      ssState.currentIndex = 0;
    }

    // モーダル表示
    ssModal.style.display = 'flex';
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousemove', resetIdleTimer);
    resetIdleTimer();

    // 最初の写真を表示＆タイマー開始
    renderCurrentSlide();
    scheduleNextSlide();
  }

  /**
   * スライドショー終了 (公開関数)
   */
  function closeSlideshow() {
    if (!ssState.isOpen) return;

    ssState.isOpen = false;
    clearTimeout(ssState.slideTimer);
    clearTimeout(ssState.idleTimer);
    cancelAnimationFrame(ssState.progressRafId);

    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }

    if (ssModal) {
      ssModal.style.display = 'none';
      ssModal.classList.remove('idle');
    }

    if (imgA) { imgA.src = ''; imgA.className = 'slideshow-img'; }
    if (imgB) { imgB.src = ''; imgB.className = 'slideshow-img'; }

    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('mousemove', resetIdleTimer);
  }

  /**
   * イベントリスナーの登録
   */
  function setupSlideshowEvents() {
    initDOMElements();

    if (closeBtn) closeBtn.addEventListener('click', closeSlideshow);
    if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlayPause);
    if (prevBtn) prevBtn.addEventListener('click', prevSlide);
    if (nextBtn) nextBtn.addEventListener('click', nextSlide);

    if (hitboxLeft) hitboxLeft.addEventListener('click', prevSlide);
    if (hitboxRight) hitboxRight.addEventListener('click', nextSlide);

    if (speedBtns) {
      speedBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sec = parseInt(btn.dataset.sec, 10);
          if (sec) setIntervalSec(sec);
        });
      });
    }

    if (shuffleBtn) shuffleBtn.addEventListener('click', toggleShuffle);
    if (infoBtn) infoBtn.addEventListener('click', toggleInfo);
    if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);

    // ヘッダーのスライドショー開始ボタン
    const headerStartBtn = document.getElementById('startSlideshowBtn');
    if (headerStartBtn) {
      headerStartBtn.addEventListener('click', () => {
        if (typeof state !== 'undefined' && state.photos && state.photos.length > 0) {
          const title = (state.viewTitle ? state.viewTitle.textContent : '表示中の写真');
          startSlideshow(state.photos, 0, title);
        } else {
          if (typeof showToast === 'function') {
            showToast('表示できる写真がありません', 'warning');
          }
        }
      });
    }
  }

  // グローバル公開
  window.startSlideshow = startSlideshow;
  window.closeSlideshow = closeSlideshow;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSlideshowEvents);
  } else {
    setupSlideshowEvents();
  }
})();
