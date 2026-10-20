/**
 * スマート・テイクアウト（高機能エクスポート / マーシャリング）
 * 元画像ファイルを一切変更せず、回転・クロップ・リサイズ・リネーム・Exif選択消去を一括適用して出力する。
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'photo_manager_smart_takeout_options_v1';

  let currentPhotoIds = [];
  let isExporting = false;

  // DOM要素キャッシュ
  let modalEl = null;
  let photoCountEl = null;
  let applyAdjustmentsEl = null;
  let exifSyncDbEl = null;
  let labelExifSyncDb = null;
  let customSizeInput = null;
  let qualitySlider = null;
  let qualityVal = null;
  let customPrefixInput = null;
  let exifGpsEl = null;
  let exifExposureEl = null;
  let exifCameraEl = null;
  let exifOtherEl = null;
  let exifAllEl = null;
  let labelExifGps = null;
  let labelExifExposure = null;
  let labelExifCamera = null;
  let labelExifOther = null;
  let destInput = null;
  let pickDirBtn = null;
  let openFolderAfterEl = null;
  let progressContainer = null;
  let progressStatus = null;
  let progressCount = null;
  let progressFill = null;
  let startBtn = null;
  let cancelBtn = null;
  let closeBtn = null;

  function initElements() {
    modalEl = document.getElementById('smartTakeoutModal');
    if (!modalEl) return false;

    photoCountEl = document.getElementById('smartTakeoutPhotoCount');
    applyAdjustmentsEl = document.getElementById('takeoutApplyAdjustments');
    exifSyncDbEl = document.getElementById('takeoutExifSyncDb');
    labelExifSyncDb = document.getElementById('labelExifSyncDb');
    customSizeInput = document.getElementById('takeoutCustomSize');
    qualitySlider = document.getElementById('takeoutQualitySlider');
    qualityVal = document.getElementById('takeoutQualityVal');
    customPrefixInput = document.getElementById('takeoutCustomPrefix');
    exifGpsEl = document.getElementById('takeoutExifGps');
    exifExposureEl = document.getElementById('takeoutExifExposure');
    exifCameraEl = document.getElementById('takeoutExifCamera');
    exifOtherEl = document.getElementById('takeoutExifOther');
    exifAllEl = document.getElementById('takeoutExifAll');
    labelExifGps = document.getElementById('labelExifGps');
    labelExifExposure = document.getElementById('labelExifExposure');
    labelExifCamera = document.getElementById('labelExifCamera');
    labelExifOther = document.getElementById('labelExifOther');
    destInput = document.getElementById('smartTakeoutDestInput');
    pickDirBtn = document.getElementById('smartTakeoutPickDirBtn');
    openFolderAfterEl = document.getElementById('takeoutOpenFolderAfter');
    progressContainer = document.getElementById('takeoutProgressContainer');
    progressStatus = document.getElementById('takeoutProgressStatus');
    progressCount = document.getElementById('takeoutProgressCount');
    progressFill = document.getElementById('takeoutProgressFill');
    startBtn = document.getElementById('startSmartTakeoutBtn');
    cancelBtn = document.getElementById('cancelSmartTakeoutBtn');
    closeBtn = document.getElementById('closeSmartTakeoutBtn');

    return true;
  }

  function _showToast(msg, type = 'info', duration = 3500) {
    const fn = (typeof showToast === 'function') ? showToast : (window.showToast || null);
    if (fn) {
      fn(msg, type, duration);
    } else {
      console.log(`[TOAST][${type}] ${msg}`);
    }
  }

  /**
   * localStorage から前回の設定をロード
   */
  function loadSavedOptions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /**
   * 現在の設定を localStorage に保存
   */
  function saveCurrentOptions() {
    try {
      const opts = getFormOptions();
      const toSave = {
        apply_adjustments: opts.apply_adjustments,
        exif_sync_db: opts.exif_sync_db,
        resize_mode: opts.resize_mode,
        custom_long_edge: opts.custom_long_edge,
        format: opts.format,
        quality: opts.quality,
        naming_rule: opts.naming_rule,
        custom_prefix: opts.custom_prefix,
        exif_remove_gps: opts.exif_remove_gps,
        exif_remove_exposure: opts.exif_remove_exposure,
        exif_remove_camera: opts.exif_remove_camera,
        exif_remove_other: opts.exif_remove_other,
        exif_remove_all: opts.exif_remove_all,
        destination: opts.destination,
        open_folder_after: opts.open_folder_after,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) {
      console.warn('[TAKEOUT] 設定の保存に失敗:', e);
    }
  }

  /**
   * フォーム値の取得
   */
  function getFormOptions() {
    const resizeRadio = document.querySelector('input[name="takeoutResize"]:checked');
    const resizeMode = resizeRadio ? resizeRadio.value : 'original';

    const formatRadio = document.querySelector('input[name="takeoutFormat"]:checked');
    const format = formatRadio ? formatRadio.value : 'jpeg';

    const namingRadio = document.querySelector('input[name="takeoutNaming"]:checked');
    const namingRule = namingRadio ? namingRadio.value : 'original';

    return {
      photo_ids: currentPhotoIds,
      destination: destInput ? destInput.value.trim() : '',
      format: format,
      quality: qualitySlider ? parseInt(qualitySlider.value, 10) : 90,
      resize_mode: resizeMode,
      custom_long_edge: customSizeInput ? parseInt(customSizeInput.value, 10) || 1600 : 1600,
      naming_rule: namingRule,
      custom_prefix: customPrefixInput ? customPrefixInput.value.trim() || 'Photo' : 'Photo',
      apply_adjustments: applyAdjustmentsEl ? applyAdjustmentsEl.checked : true,
      exif_sync_db: exifSyncDbEl ? exifSyncDbEl.checked : true,
      exif_remove_gps: exifGpsEl ? exifGpsEl.checked : false,
      exif_remove_exposure: exifExposureEl ? exifExposureEl.checked : false,
      exif_remove_camera: exifCameraEl ? exifCameraEl.checked : false,
      exif_remove_other: exifOtherEl ? exifOtherEl.checked : false,
      exif_remove_all: exifAllEl ? exifAllEl.checked : false,
      open_folder_after: openFolderAfterEl ? openFolderAfterEl.checked : true,
    };
  }

  /**
   * UIへ設定を反映
   */
  async function applyOptionsToUI(saved) {
    if (saved) {
      if (applyAdjustmentsEl && typeof saved.apply_adjustments === 'boolean') {
        applyAdjustmentsEl.checked = saved.apply_adjustments;
      }
      if (exifSyncDbEl && typeof saved.exif_sync_db === 'boolean') {
        exifSyncDbEl.checked = saved.exif_sync_db;
      }
      if (saved.resize_mode) {
        const r = document.querySelector(`input[name="takeoutResize"][value="${saved.resize_mode}"]`);
        if (r) r.checked = true;
      }
      if (customSizeInput && saved.custom_long_edge) {
        customSizeInput.value = saved.custom_long_edge;
      }
      if (saved.format) {
        const f = document.querySelector(`input[name="takeoutFormat"][value="${saved.format}"]`);
        if (f) f.checked = true;
      }
      if (qualitySlider && saved.quality) {
        qualitySlider.value = saved.quality;
        if (qualityVal) qualityVal.textContent = `${saved.quality}%`;
      }
      if (saved.naming_rule) {
        const n = document.querySelector(`input[name="takeoutNaming"][value="${saved.naming_rule}"]`);
        if (n) n.checked = true;
      }
      if (customPrefixInput && saved.custom_prefix) {
        customPrefixInput.value = saved.custom_prefix;
      }
      if (exifGpsEl && typeof saved.exif_remove_gps === 'boolean') {
        exifGpsEl.checked = saved.exif_remove_gps;
      }
      if (exifExposureEl && typeof saved.exif_remove_exposure === 'boolean') {
        exifExposureEl.checked = saved.exif_remove_exposure;
      }
      if (exifCameraEl && typeof saved.exif_remove_camera === 'boolean') {
        exifCameraEl.checked = saved.exif_remove_camera;
      }
      if (exifOtherEl && typeof saved.exif_remove_other === 'boolean') {
        exifOtherEl.checked = saved.exif_remove_other;
      }
      if (exifAllEl && typeof saved.exif_remove_all === 'boolean') {
        exifAllEl.checked = saved.exif_remove_all;
      }
      if (openFolderAfterEl && typeof saved.open_folder_after === 'boolean') {
        openFolderAfterEl.checked = saved.open_folder_after;
      }
      if (destInput && saved.destination) {
        destInput.value = saved.destination;
      }
    }

    // 保存先フォルダが未設定の場合はサーバーのデフォルトを取得
    if (destInput && !destInput.value) {
      try {
        const res = await fetch('/api/export/default-dir');
        if (res.ok) {
          const d = await res.json();
          if (d.default_dir) {
            destInput.value = d.default_dir;
          }
        }
      } catch (e) {
        console.warn('[TAKEOUT] デフォルトフォルダ取得失敗:', e);
      }
    }

    updateControlsState();
  }

  /**
   * ラジオボタン等の有効/無効状態を更新
   */
  function updateControlsState() {
    const resizeRadio = document.querySelector('input[name="takeoutResize"]:checked');
    if (customSizeInput) {
      customSizeInput.disabled = !resizeRadio || resizeRadio.value !== 'custom';
    }

    const namingRadio = document.querySelector('input[name="takeoutNaming"]:checked');
    if (customPrefixInput) {
      customPrefixInput.disabled = !namingRadio || namingRadio.value !== 'custom_seq';
    }

    // Exif全消去がONの場合、他も消去される旨をわかりやすく無効化
    const isAllChecked = !!(exifAllEl && exifAllEl.checked);
    const individualCheckboxes = [
      { el: exifSyncDbEl, label: labelExifSyncDb },
      { el: exifGpsEl, label: labelExifGps },
      { el: exifExposureEl, label: labelExifExposure },
      { el: exifCameraEl, label: labelExifCamera },
      { el: exifOtherEl, label: labelExifOther },
    ];

    individualCheckboxes.forEach(({ el, label }) => {
      if (el) {
        el.disabled = isAllChecked;
      }
      if (label) {
        if (isAllChecked) {
          label.classList.add('is-disabled');
        } else {
          label.classList.remove('is-disabled');
        }
      }
    });
  }

  /**
   * 対象写真IDの多重フォールバック解決
   * 複数選択中、1枚選択中、アクティブ表示中、DOM選択などを全てサポート
   */
  function resolveTargetPhotoIds(photoIds) {
    if (Array.isArray(photoIds) && photoIds.length > 0) {
      return photoIds;
    }
    if (typeof photoIds === 'number') {
      return [photoIds];
    }

    // 1. グローバル state からの取得 (const state は直接参照)
    try {
      const appState = (typeof state !== 'undefined' && state) ? state : (window.state || null);
      if (appState) {
        if (appState.selectedPhotoIds && appState.selectedPhotoIds.size > 0) {
          return Array.from(appState.selectedPhotoIds);
        }
        if (appState.activeInspectorPhotoId) {
          return [appState.activeInspectorPhotoId];
        }
        if (typeof appState.currentPhotoIndex === 'number' && appState.currentPhotoIndex >= 0) {
          const p = appState.filteredPhotos ? appState.filteredPhotos[appState.currentPhotoIndex] : null;
          if (p && p.id) {
            return [p.id];
          }
        }
      }
    } catch (e) {
      console.warn('[TAKEOUT] state参照エラー:', e);
    }

    // 2. DOMの選択カード（.photo-card.selected）から取得
    try {
      const selectedCards = document.querySelectorAll('.photo-card.selected');
      if (selectedCards && selectedCards.length > 0) {
        const ids = [];
        selectedCards.forEach(c => {
          const pid = parseInt(c.dataset.photoId, 10);
          if (!isNaN(pid)) ids.push(pid);
        });
        if (ids.length > 0) return ids;
      }

      // 3. DOMのアクティブカード（.photo-card.active）から取得
      const activeCard = document.querySelector('.photo-card.active');
      if (activeCard) {
        const pid = parseInt(activeCard.dataset.photoId, 10);
        if (!isNaN(pid)) return [pid];
      }
    } catch (e) {
      console.warn('[TAKEOUT] DOMカード探索エラー:', e);
    }

    return [];
  }

  /**
   * モーダルを開く
   */
  async function openSmartTakeoutModal(photoIds) {
    if (!initElements()) return;

    currentPhotoIds = resolveTargetPhotoIds(photoIds);

    if (!currentPhotoIds || currentPhotoIds.length === 0) {
      _showToast('テイクアウトする写真を選択してください', 'warning', 3500);
      return;
    }

    if (photoCountEl) {
      photoCountEl.textContent = currentPhotoIds.length;
    }

    // 進捗バーをリセット
    if (progressContainer) progressContainer.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.innerHTML = '<span>📤</span> テイクアウト開始';
    }
    isExporting = false;

    // 前回の保存設定を復元
    const saved = loadSavedOptions();
    await applyOptionsToUI(saved);

    modalEl.style.display = 'flex';
  }

  /**
   * モーダルを閉じる
   */
  function closeSmartTakeoutModal() {
    if (isExporting) {
      if (!confirm('現在テイクアウト処理中です。画面を閉じますか？（処理はバックグラウンドで続行されます）')) {
        return;
      }
    }
    if (modalEl) {
      modalEl.style.display = 'none';
    }
  }

  /**
   * Windowsフォルダ選択ダイアログを起動
   */
  async function pickDestinationFolder() {
    if (!destInput) return;
    const currentDir = destInput.value.trim();

    try {
      if (pickDirBtn) pickDirBtn.disabled = true;
      const res = await fetch('/api/export/pick-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial_dir: currentDir || null }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.selected_path) {
          destInput.value = data.selected_path;
          saveCurrentOptions();
        }
      }
    } catch (e) {
      console.error('[TAKEOUT] フォルダ選択エラー:', e);
      _showToast('フォルダ選択ダイアログの表示に失敗しました', 'error');
    } finally {
      if (pickDirBtn) pickDirBtn.disabled = false;
    }
  }

  /**
   * スマート・テイクアウト実行
   */
  async function startExport() {
    if (isExporting) return;
    if (!currentPhotoIds || currentPhotoIds.length === 0) {
      _showToast('エクスポート対象の写真がありません', 'warning');
      return;
    }

    const opts = getFormOptions();
    saveCurrentOptions();

    isExporting = true;
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.innerHTML = '<span class="takeout-progress-spinner">⏳</span> 処理中...';
    }
    if (progressContainer) {
      progressContainer.style.display = 'flex';
    }
    if (progressStatus) progressStatus.textContent = '写真を出力しています...';
    if (progressCount) progressCount.textContent = `0 / ${currentPhotoIds.length}`;
    if (progressFill) progressFill.style.width = '10%';

    try {
      // 処理進捗アニメーション
      let currentProgress = 10;
      const progressTimer = setInterval(() => {
        if (!isExporting) {
          clearInterval(progressTimer);
          return;
        }
        if (currentProgress < 90) {
          currentProgress += Math.max(1, Math.floor((90 - currentProgress) / 5));
          if (progressFill) progressFill.style.width = `${currentProgress}%`;
        }
      }, 300);

      const res = await fetch('/api/export/smart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });

      clearInterval(progressTimer);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'テイクアウト処理でエラーが発生しました');
      }

      const result = await res.json();
      if (progressFill) progressFill.style.width = '100%';
      if (progressStatus) progressStatus.textContent = '完了しました！';
      if (progressCount) progressCount.textContent = `${result.success_count} / ${result.total}`;

      const msg = `${result.success_count}枚の写真を「${opts.destination || 'take_out'}」に書き出しました！` +
        (result.failed_count > 0 ? ` (${result.failed_count}枚失敗)` : '');

      _showToast(msg, result.failed_count > 0 ? 'warning' : 'success', 5000);

      setTimeout(() => {
        closeSmartTakeoutModal();
      }, 1200);

    } catch (e) {
      console.error('[TAKEOUT] エクスポート失敗:', e);
      if (progressStatus) progressStatus.textContent = `エラー: ${e.message}`;
      _showToast(`エラー: ${e.message}`, 'error', 6000);
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.innerHTML = '<span>📤</span> テイクアウト開始';
      }
    } finally {
      isExporting = false;
    }
  }

  /**
   * イベントリスナーのセットアップ
   */
  function setupEventListeners() {
    if (!initElements()) return;

    // 閉じる・キャンセル
    if (closeBtn) closeBtn.addEventListener('click', closeSmartTakeoutModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeSmartTakeoutModal);

    // 背景クリックで閉じる
    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          closeSmartTakeoutModal();
        }
      });
    }

    // 品質スライダー
    if (qualitySlider && qualityVal) {
      qualitySlider.addEventListener('input', () => {
        qualityVal.textContent = `${qualitySlider.value}%`;
      });
    }

    // ラジオボタン変更時の有効・無効化
    document.querySelectorAll('input[name="takeoutResize"]').forEach((el) => {
      el.addEventListener('change', updateControlsState);
    });
    document.querySelectorAll('input[name="takeoutNaming"]').forEach((el) => {
      el.addEventListener('change', updateControlsState);
    });

    // Exif全消去チェックボックス変更
    if (exifAllEl) {
      exifAllEl.addEventListener('change', updateControlsState);
    }

    // 個別4項目がチェックされたら「すべて」を自動解除
    [exifGpsEl, exifExposureEl, exifCameraEl, exifOtherEl].forEach((el) => {
      if (el) {
        el.addEventListener('change', () => {
          if (el.checked && exifAllEl && exifAllEl.checked) {
            exifAllEl.checked = false;
          }
          updateControlsState();
        });
      }
    });

    // フォルダ選択ボタン
    if (pickDirBtn) {
      pickDirBtn.addEventListener('click', pickDestinationFolder);
    }

    // 開始ボタン
    if (startBtn) {
      startBtn.addEventListener('click', startExport);
    }

    // 静的トリガーボタン（フローティングポップオーバー内 & 右クリックサブメニュー内）
    const floatingTrigger = document.getElementById('floatingTriggerSmartTakeoutBtn');
    if (floatingTrigger) {
      floatingTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();
        openSmartTakeoutModal();
      });
    }

    const contextTrigger = document.getElementById('contextTriggerSmartTakeoutBtn');
    if (contextTrigger) {
      contextTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof closeContextMenu === 'function') closeContextMenu();
        openSmartTakeoutModal();
      });
    }

    // ベタ焼きHTML（コンタクトシート）出力トリガーボタン
    const floatingContactSheetBtn = document.getElementById('floatingTriggerContactSheetBtn');
    if (floatingContactSheetBtn) {
      floatingContactSheetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();
        exportContactSheetHtml();
      });
    }

    const contextContactSheetBtn = document.getElementById('contextTriggerContactSheetBtn');
    if (contextContactSheetBtn) {
      contextContactSheetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof closeContextMenu === 'function') closeContextMenu();
        exportContactSheetHtml();
      });
    }

    // キーボードショートカット (Escで閉じる)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalEl && modalEl.style.display === 'flex') {
        e.stopPropagation();
        closeSmartTakeoutModal();
      }
    });
  }

  /**
   * 選択中の写真（または引数で指定された写真IDリスト）から自己完結型ベタ焼きHTML（コンタクトシート）を生成して出力する
   * @param {number[]} [photoIds] - 対象写真ID配列（省略時は選択中またはライトボックス表示中の写真）
   */
  async function exportContactSheetHtml(photoIds) {
    let targetIds = [];
    if (Array.isArray(photoIds) && photoIds.length > 0) {
      targetIds = photoIds;
    } else if (typeof state !== 'undefined' && state.selectedPhotoIds && state.selectedPhotoIds.size > 0) {
      targetIds = Array.from(state.selectedPhotoIds);
    } else if (typeof getCurrentLightboxPhoto === 'function') {
      const current = getCurrentLightboxPhoto();
      if (current && current.id) {
        targetIds = [current.id];
      }
    }

    if (targetIds.length === 0) {
      if (typeof showToast === 'function') {
        showToast('コンタクトシートに出力する写真を選択してください', 'warning');
      }
      return;
    }

    if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();
    if (typeof closeContextMenu === 'function') closeContextMenu();

    if (typeof showToast === 'function') {
      showToast('🎞️ ベタ焼きHTML（コンタクトシート）を生成中...', 'info', 2000);
    }

    try {
      const response = await fetch('/api/export/contact-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photo_ids: targetIds,
          title: 'Photo Manager Contact Sheet',
          theme: 'darkroom',
          columns: 5,
          open_after: true
        })
      });

      const res = await response.json();
      if (!response.ok || res.status !== 'ok') {
        throw new Error(res.detail || res.message || `HTTP Error ${response.status}`);
      }

      if (typeof showToast === 'function') {
        showToast(`🎞️ ベタ焼きHTML（${res.exported_count}枚）を take_out に出力しました`, 'success', 4000);
      }
    } catch (err) {
      console.error('コンタクトシートHTML出力エラー:', err);
      if (typeof showToast === 'function') {
        showToast(`❌ コンタクトシート出力に失敗しました: ${err.message}`, 'error', 4000);
      }
    }
  }

  // 初期化実行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupEventListeners);
  } else {
    setupEventListeners();
  }

  // グローバル公開
  window.openSmartTakeoutModal = openSmartTakeoutModal;
  window.closeSmartTakeoutModal = closeSmartTakeoutModal;
  window.exportContactSheetHtml = exportContactSheetHtml;

})();
