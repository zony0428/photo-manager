/**
 * art_framer.js - Art Framer ウィザードモーダル ＆ 右クリックプリセット導線制御
 *
 * 責務:
 * - 右クリック「テイクアウト ＞ Art Framer ＞ for X / for INSTA / Full Size」およびインスペクタからの起動
 * - ターゲットプリセット (for X / for INSTA 4:5 / for INSTA 1:1 / Full Size) による解像度・台紙比率連動
 * - 1枚ずつ確定出力して次の写真へ進むコンベア型3ステップ・ウィザード制御 (中間保存不要)
 * - ローカルONNXプライバシー自動検出 API (/api/export/detect-privacy) との非同期連携
 * - プリント枠・EXIFキャプション・ウォーターマーク (テキスト / 透過PNGロゴ) の設定記憶と一括出力ショートカット
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'photo_manager_art_framer_options_v1';

  let modalEl = null;
  let editor = null;
  let photoQueue = [];
  let queueIndex = 0;
  let exportedCount = 0;
  let lastExportedDir = '';
  let isBusy = false;
  let loadReqSeq = 0;

  // セッション設定状態
  const cfg = {
    artPreset: 'for_x', // 'for_x' | 'for_insta' | 'full_size'
    step: 1,
    autoDetectOnOpen: true,
    detectPlates: true,
    detectFaces: true,
    plateFeather: 0.45,
    faceStyle: 'frosted',
    faceRadius: 0.052,
    faceStrength: 0.92,
    frame: {
      enabled: true,
      layout: 'classic',
      matte: 'white',
      aspect_mode: 'original',
      border_ratio: 0.05,
      font_scale: 1.0,
      inner_border: true,
      photo_shadow: false,
      show_camera: true,
      show_lens: true,
      show_exposure: true,
      show_date: false,
      show_location: false,
      show_note: false,
      custom_note: '',
    },
    watermark: {
      enabled: false,
      type: 'text',
      text: '© 2026',
      image_path: '',
      image_name: '',
      preview_data_url: '',
      position: 'bottom-right',
      opacity: 0.58,
      size_ratio: 0.018,
      color: 'light',
      shadow: true,
    },
    output: {
      format: 'jpeg',
      quality: 92,
      naming_rule: 'thmod_original',
      custom_prefix: 'ArtFrame',
      exif_remove_gps: true,
      exif_remove_all: false,
      destination: '',
      open_folder_after: true,
    },
  };

  function toast(msg, type = 'info', duration = 3500) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type, duration);
    }
  }

  function findPhotoMeta(photoId) {
    const pid = Number(photoId);
    if (typeof window.findPhotoByIdAnywhere === 'function') {
      const p = window.findPhotoByIdAnywhere(pid);
      if (p) return p;
    }
    const appState = (typeof state !== 'undefined' && state) ? state : (window.state || null);
    if (appState) {
      if (Array.isArray(appState.photos)) {
        const hit = appState.photos.find((x) => x.id === pid);
        if (hit) return hit;
      }
      if (Array.isArray(appState.filteredPhotos)) {
        const hit2 = appState.filteredPhotos.find((x) => x.id === pid);
        if (hit2) return hit2;
      }
    }
    return { id: pid, file_name: `photo_${pid}` };
  }

  function resolveSelectedIds(explicitIds) {
    if (Array.isArray(explicitIds) && explicitIds.length > 0) {
      return explicitIds.map(Number).filter((n) => !isNaN(n) && n > 0);
    }
    if (typeof explicitIds === 'number' && explicitIds > 0) {
      return [explicitIds];
    }
    const appState = (typeof state !== 'undefined' && state) ? state : (window.state || null);
    if (appState) {
      if (appState.selectedPhotoIds && appState.selectedPhotoIds.size > 0) {
        return Array.from(appState.selectedPhotoIds);
      }
      if (appState.activeInspectorPhotoId) {
        return [appState.activeInspectorPhotoId];
      }
      if (typeof window.getCurrentLightboxPhoto === 'function') {
        const lb = window.getCurrentLightboxPhoto();
        if (lb && lb.id) return [lb.id];
      }
    }
    const cards = document.querySelectorAll('.photo-card.selected, .photo-card.active');
    const domIds = [];
    cards.forEach((c) => {
      const id = parseInt(c.dataset.photoId, 10);
      if (!isNaN(id) && !domIds.includes(id)) domIds.push(id);
    });
    return domIds;
  }

  function loadSavedSettings() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed.autoDetectOnOpen === 'boolean') cfg.autoDetectOnOpen = parsed.autoDetectOnOpen;
      if (typeof parsed.detectPlates === 'boolean') cfg.detectPlates = parsed.detectPlates;
      if (typeof parsed.detectFaces === 'boolean') cfg.detectFaces = parsed.detectFaces;
      if (typeof parsed.plateFeather === 'number' && !isNaN(parsed.plateFeather)) {
        cfg.plateFeather = Math.max(0, Math.min(1, parsed.plateFeather));
      }
      if (typeof parsed.faceStyle === 'string' && parsed.faceStyle) {
        cfg.faceStyle = parsed.faceStyle;
      }
      if (typeof parsed.faceRadius === 'number' && !isNaN(parsed.faceRadius)) {
        cfg.faceRadius = Math.max(0.015, Math.min(0.35, parsed.faceRadius));
      }
      if (typeof parsed.faceStrength === 'number' && !isNaN(parsed.faceStrength)) {
        cfg.faceStrength = Math.max(0.40, Math.min(1.0, parsed.faceStrength));
      }
      if (!parsed._faceHazeV2Migrated) {
        if (cfg.faceStrength < 0.92) cfg.faceStrength = 0.92;
      }
      if (parsed.frame && typeof parsed.frame === 'object') {
        Object.assign(cfg.frame, parsed.frame);
      }
      if (parsed.watermark && typeof parsed.watermark === 'object') {
        Object.assign(cfg.watermark, parsed.watermark);
      }
      if (parsed.output && typeof parsed.output === 'object') {
        Object.assign(cfg.output, parsed.output);
        if (!parsed._thmodNamingMigrated) {
          if (!cfg.output.naming_rule || cfg.output.naming_rule === 'original' || cfg.output.naming_rule === 'mod_original') {
            cfg.output.naming_rule = 'thmod_original';
          }
          saveSettings();
        }
      }
    } catch (e) {
      console.warn('[ART_FRAMER] 設定読込スキップ:', e);
    }
  }

  function saveSettings() {
    try {
      const payload = {
        _thmodNamingMigrated: true,
        _faceHazeV2Migrated: true,
        autoDetectOnOpen: cfg.autoDetectOnOpen,
        detectPlates: cfg.detectPlates,
        detectFaces: cfg.detectFaces,
        plateFeather: cfg.plateFeather,
        faceStyle: cfg.faceStyle,
        faceRadius: cfg.faceRadius,
        faceStrength: cfg.faceStrength,
        frame: cfg.frame,
        watermark: cfg.watermark,
        output: cfg.output,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('[ART_FRAMER] 設定保存スキップ:', e);
    }
  }

  /**
   * プリセットキー ('for_x' | 'for_insta' | 'for_insta_sq' | 'full_size') を適用して解像度・比率を連動させる
   */
  function applyTargetPreset(presetKey) {
    if (presetKey === 'for_insta_sq') {
      cfg.artPreset = 'for_insta';
      cfg.frame.enabled = true;
      cfg.frame.aspect_mode = '1:1';
      cfg.output.quality = 92;
    } else if (presetKey === 'for_insta') {
      cfg.artPreset = 'for_insta';
      cfg.frame.enabled = true;
      if (cfg.frame.aspect_mode !== '1:1') {
        cfg.frame.aspect_mode = '4:5';
      }
      cfg.output.quality = 92;
    } else if (presetKey === 'full_size') {
      cfg.artPreset = 'full_size';
      cfg.frame.aspect_mode = 'original';
      cfg.output.quality = 95;
    } else {
      cfg.artPreset = 'for_x';
      cfg.frame.aspect_mode = 'original';
      cfg.output.quality = 92;
    }
    syncFormFromState();
    pushDecoratorToEditor();
  }

  function getActivePresetPillKey() {
    if (cfg.artPreset === 'for_insta') {
      return cfg.frame.aspect_mode === '1:1' ? 'for_insta_sq' : 'for_insta';
    }
    if (cfg.artPreset === 'full_size') return 'full_size';
    return 'for_x';
  }

  function pushDecoratorToEditor() {
    if (!editor) return;
    editor.setDecoratorState({
      viewMode: cfg.step === 1 ? 'mask' : 'decorated',
      frameConfig: cfg.frame,
      watermarkConfig: cfg.watermark,
      artPreset: cfg.artPreset,
      logoDataUrl: cfg.watermark.preview_data_url || '',
    });
  }

  function syncFormFromState() {
    if (!modalEl) return;

    // プリセットピル強調
    const activePill = getActivePresetPillKey();
    modalEl.querySelectorAll('.af-preset-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === activePill);
    });

    // Step 1
    const setChk = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.checked = Boolean(val);
    };
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.value = String(val);
    };
    const setTxt = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(val);
    };

    setChk('afAutoDetectCheck', cfg.autoDetectOnOpen);
    setChk('afDetectPlatesCheck', cfg.detectPlates);
    setChk('afDetectFacesCheck', cfg.detectFaces);
    const pfPct = Math.round((cfg.plateFeather ?? 0.45) * 100);
    setVal('afPlateFeatherSlider', pfPct);
    setTxt('afPlateFeatherVal', `${pfPct}%`);
    setVal('afHazeStyleSelect', cfg.faceStyle || 'frosted');
    const frPct = ((cfg.faceRadius ?? 0.052) * 100).toFixed(1);
    setVal('afStampRadiusSlider', frPct);
    setTxt('afStampRadiusVal', `${frPct}%`);
    const fsPct = Math.round((cfg.faceStrength ?? 0.92) * 100);
    setVal('afStampStrengthSlider', fsPct);
    setTxt('afStampStrengthVal', `${fsPct}%`);
    if (editor) {
      editor.defaultPlateFeather = cfg.plateFeather ?? 0.45;
      editor.defaultHazeStyle = cfg.faceStyle || 'frosted';
      editor.defaultStampRadius = cfg.faceRadius ?? 0.052;
      editor.defaultStampStrength = cfg.faceStrength ?? 0.92;
    }

    // Step 2: プリント枠
    setChk('afFrameEnableCheck', cfg.frame.enabled);
    const frameBody = document.getElementById('afFrameControlsBody');
    if (frameBody) frameBody.classList.toggle('is-disabled-block', !cfg.frame.enabled);

    modalEl.querySelectorAll('.af-layout-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.layout === cfg.frame.layout);
    });
    setVal('afMatteSelect', cfg.frame.matte);
    setVal('afAspectSelect', cfg.frame.aspect_mode);

    const bPct = (cfg.frame.border_ratio * 100).toFixed(1);
    setVal('afBorderSlider', bPct);
    setTxt('afBorderVal', `${bPct}%`);

    const fPct = Math.round((cfg.frame.font_scale || 1.0) * 100);
    setVal('afFontScaleSlider', fPct);
    setTxt('afFontScaleVal', `${fPct}%`);

    setChk('afInnerBorderCheck', cfg.frame.inner_border);
    setChk('afPhotoShadowCheck', cfg.frame.photo_shadow);
    setChk('afShowCameraCheck', cfg.frame.show_camera);
    setChk('afShowLensCheck', cfg.frame.show_lens);
    setChk('afShowExposureCheck', cfg.frame.show_exposure);
    setChk('afShowDateCheck', cfg.frame.show_date);
    setChk('afShowLocationCheck', cfg.frame.show_location);
    setChk('afShowNoteCheck', cfg.frame.show_note);
    setVal('afCustomNoteInput', cfg.frame.custom_note);
    const noteRow = document.getElementById('afCustomNoteRow');
    if (noteRow) noteRow.style.display = cfg.frame.show_note ? 'block' : 'none';

    const captionGroup = document.getElementById('afCaptionFieldsGroup');
    if (captionGroup) {
      captionGroup.classList.toggle('is-disabled-block', cfg.frame.layout === 'border_only');
    }

    // Step 2: ウォーターマーク
    setChk('afWmEnableCheck', cfg.watermark.enabled);
    const wmBody = document.getElementById('afWmControlsBody');
    if (wmBody) wmBody.classList.toggle('is-disabled-block', !cfg.watermark.enabled);

    setVal('afWmTypeSelect', cfg.watermark.type);
    const isLogo = cfg.watermark.type === 'image';
    const wmTextGroup = document.getElementById('afWmTextGroup');
    const wmImageGroup = document.getElementById('afWmImageGroup');
    if (wmTextGroup) wmTextGroup.style.display = isLogo ? 'none' : 'flex';
    if (wmImageGroup) wmImageGroup.style.display = isLogo ? 'flex' : 'none';

    setVal('afWmTextInput', cfg.watermark.text);
    setVal('afWmColorSelect', cfg.watermark.color);
    setChk('afWmShadowCheck', cfg.watermark.shadow);
    setTxt('afWmImageNameLabel', cfg.watermark.image_name || '未選択');

    modalEl.querySelectorAll('.af-wm-pos-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pos === cfg.watermark.position);
    });

    const opPct = Math.round((cfg.watermark.opacity ?? 0.58) * 100);
    setVal('afWmOpacitySlider', opPct);
    setTxt('afWmOpacityVal', `${opPct}%`);

    const szPct = ((cfg.watermark.size_ratio || (isLogo ? 0.12 : 0.018)) * 100).toFixed(1);
    const szSlider = document.getElementById('afWmSizeSlider');
    if (szSlider) {
      szSlider.min = isLogo ? '4.0' : '0.8';
      szSlider.max = isLogo ? '35.0' : '6.0';
      szSlider.step = isLogo ? '1.0' : '0.2';
      szSlider.value = szPct;
    }
    setTxt('afWmSizeVal', `${szPct}%`);

    // Step 3: 出力
    setVal('afFormatSelect', cfg.output.format);
    setVal('afQualitySlider', cfg.output.quality);
    setTxt('afQualityVal', `${cfg.output.quality}%`);
    setVal('afNamingSelect', cfg.output.naming_rule);
    setVal('afCustomPrefixInput', cfg.output.custom_prefix);
    const prefixRow = document.getElementById('afCustomPrefixRow');
    if (prefixRow) prefixRow.style.display = cfg.output.naming_rule === 'custom_seq' ? 'flex' : 'none';

    setChk('afExifRemoveGpsCheck', cfg.output.exif_remove_gps);
    setChk('afExifRemoveAllCheck', cfg.output.exif_remove_all);
    const gpsLabel = document.getElementById('afExifRemoveGpsLabel');
    const gpsChk = document.getElementById('afExifRemoveGpsCheck');
    if (gpsChk) gpsChk.disabled = cfg.output.exif_remove_all;
    if (gpsLabel) gpsLabel.classList.toggle('is-disabled', cfg.output.exif_remove_all);

    setVal('afDestInput', cfg.output.destination);
    setChk('afOpenAfterCheck', cfg.output.open_folder_after);
  }

  function setStep(stepNum) {
    cfg.step = Math.max(1, Math.min(3, stepNum));
    if (!modalEl) return;

    modalEl.querySelectorAll('.af-step-tab').forEach((tab) => {
      tab.classList.toggle('active', parseInt(tab.dataset.step, 10) === cfg.step);
    });

    const p1 = document.getElementById('afStep1Panel');
    const p2 = document.getElementById('afStep2Panel');
    const p3 = document.getElementById('afStep3Panel');
    if (p1) p1.style.display = cfg.step === 1 ? 'flex' : 'none';
    if (p2) p2.style.display = cfg.step === 2 ? 'flex' : 'none';
    if (p3) p3.style.display = cfg.step === 3 ? 'flex' : 'none';

    const zoomBar = document.getElementById('afMaskZoomToolbar');
    if (zoomBar) zoomBar.style.display = cfg.step === 1 ? 'flex' : 'none';

    updateFooterButtonsUI();
    updateStep3SummaryUI();
    pushDecoratorToEditor();
  }

  function updateFooterButtonsUI() {
    if (!modalEl) return;
    const total = photoQueue.length;
    const isLastPhoto = queueIndex >= total - 1;
    const remaining = Math.max(0, total - queueIndex);

    const prevStepBtn = document.getElementById('afPrevStepBtn');
    const nextStepBtn = document.getElementById('afNextStepBtn');
    const quickExportBtn = document.getElementById('afQuickExportBtn');
    const skipPhotoBtn = document.getElementById('afSkipPhotoBtn');
    const batchRestBtn = document.getElementById('afBatchRestBtn');

    if (prevStepBtn) prevStepBtn.disabled = isBusy || cfg.step === 1;
    if (skipPhotoBtn) {
      skipPhotoBtn.style.display = total > 1 ? 'inline-flex' : 'none';
      skipPhotoBtn.disabled = isBusy;
      skipPhotoBtn.textContent = isLastPhoto ? 'この写真をスキップして終了' : 'この写真をスキップ ▶';
    }
    if (batchRestBtn) {
      batchRestBtn.style.display = (total > 1 && remaining > 1 && cfg.step >= 2) ? 'inline-flex' : 'none';
      batchRestBtn.disabled = isBusy;
      batchRestBtn.textContent = `残り ${remaining} 枚を一括出力 (マスクなし)`;
    }

    const actionText = isLastPhoto
      ? (total > 1 ? `最後の1枚を出力して完了 (${queueIndex + 1}/${total})` : 'この写真を書き出す')
      : `この1枚を出力して次へ (${queueIndex + 1}/${total}) ▶`;

    if (cfg.step === 1) {
      if (nextStepBtn) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.disabled = isBusy;
        nextStepBtn.textContent = '次へ：プリント枠・透かし →';
      }
      if (quickExportBtn) quickExportBtn.style.display = 'none';
    } else if (cfg.step === 2) {
      if (nextStepBtn) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.disabled = isBusy;
        nextStepBtn.textContent = '出力設定を確認 →';
      }
      if (quickExportBtn) {
        quickExportBtn.style.display = 'inline-flex';
        quickExportBtn.disabled = isBusy;
        quickExportBtn.textContent = actionText;
      }
    } else {
      if (nextStepBtn) nextStepBtn.style.display = 'none';
      if (quickExportBtn) {
        quickExportBtn.style.display = 'inline-flex';
        quickExportBtn.disabled = isBusy;
        quickExportBtn.textContent = actionText;
      }
    }
  }

  function updateStep3SummaryUI() {
    const presetBadge = document.getElementById('afSummaryPresetVal');
    const dimBadge = document.getElementById('afSummaryDimVal');
    const maskBadge = document.getElementById('afSummaryMaskVal');
    const frameBadge = document.getElementById('afSummaryFrameVal');

    const pillKey = getActivePresetPillKey();
    const presetLabels = {
      for_x: 'for X (長辺最大 2048px)',
      for_insta: 'for INSTA (4:5 1080×1350)',
      for_insta_sq: 'for INSTA (1:1 1080×1080)',
      full_size: 'Full Size (オリジナル解像度)',
    };
    if (presetBadge) presetBadge.textContent = presetLabels[pillKey] || pillKey;

    if (dimBadge && editor) {
      const dims = editor.getEstimatedOutputDimensions();
      dimBadge.textContent = dims && dims.width > 0 ? `${dims.width} × ${dims.height} px` : '--';
    }
    if (maskBadge && editor) {
      const pCnt = editor.plates.length;
      const fCnt = editor.faces.length;
      maskBadge.textContent = (pCnt === 0 && fCnt === 0) ? 'なし' : `ナンバー: ${pCnt} / 顔モヤ: ${fCnt}`;
    }
    if (frameBadge) {
      const parts = [];
      parts.push(cfg.frame.enabled ? `枠ON (${cfg.frame.layout})` : '枠OFF');
      if (cfg.watermark.enabled) parts.push('透かしON');
      frameBadge.textContent = parts.join(' + ');
    }
  }

  function refreshMaskPillsUI(info) {
    const box = document.getElementById('afMaskItemList');
    const delBtn = document.getElementById('afDeleteMaskBtn');
    if (delBtn) delBtn.disabled = !info || !info.selected;
    if (!box) return;

    box.innerHTML = '';
    const plates = (info && info.plates) || [];
    const faces = (info && info.faces) || [];
    const sel = info && info.selected;

    if (plates.length === 0 && faces.length === 0) {
      const span = document.createElement('span');
      span.className = 'af-muted-note';
      span.textContent = 'マスクなし（自動検出または手動追加）';
      box.appendChild(span);
      return;
    }

    plates.forEach((pl, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isAct = Boolean(sel && sel.type === 'plate' && sel.id === pl.id);
      if (isAct) {
        const stSel = document.getElementById('afPlateStyleSelect');
        if (stSel && pl.style) stSel.value = pl.style;
        const cIn = document.getElementById('afCustomPlateColor');
        if (cIn && pl.color) cIn.value = pl.color;
        const fPct = Math.round((pl.feather ?? cfg.plateFeather ?? 0.45) * 100);
        const fSl = document.getElementById('afPlateFeatherSlider');
        const fLb = document.getElementById('afPlateFeatherVal');
        if (fSl) fSl.value = String(fPct);
        if (fLb) fLb.textContent = `${fPct}%`;
      }
      btn.className = `af-mask-pill${isAct ? ' active' : ''}`;
      btn.textContent = `ナンバー #${i + 1} 拡大`;
      btn.addEventListener('click', () => {
        if (editor) editor.selectAndFocusMask('plate', pl.id);
      });
      box.appendChild(btn);
    });

    faces.forEach((fc, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isAct = Boolean(sel && sel.type === 'face' && sel.id === fc.id);
      if (isAct) {
        const hzSel = document.getElementById('afHazeStyleSelect');
        if (hzSel && fc.style) hzSel.value = fc.style;
        const rPct = ((fc.r ?? cfg.faceRadius ?? 0.052) * 100).toFixed(1);
        const rSl = document.getElementById('afStampRadiusSlider');
        const rLb = document.getElementById('afStampRadiusVal');
        if (rSl) rSl.value = String(rPct);
        if (rLb) rLb.textContent = `${rPct}%`;
        const sPct = Math.round((fc.strength ?? cfg.faceStrength ?? 0.92) * 100);
        const sSl = document.getElementById('afStampStrengthSlider');
        const sLb = document.getElementById('afStampStrengthVal');
        if (sSl) sSl.value = String(sPct);
        if (sLb) sLb.textContent = `${sPct}%`;
      }
      btn.className = `af-mask-pill is-face${isAct ? ' active' : ''}`;
      btn.textContent = `顔モヤ #${i + 1} 拡大`;
      btn.addEventListener('click', () => {
        if (editor) editor.selectAndFocusMask('face', fc.id);
      });
      box.appendChild(btn);
    });
  }

  async function runAiDetectionForCurrentPhoto(silentIfZero = false) {
    if (!photoQueue.length || !editor) return;
    const pid = photoQueue[queueIndex];
    const reqToken = loadReqSeq;
    const detectBtn = document.getElementById('afRunDetectBtn');
    const statusEl = document.getElementById('afDetectStatusText');

    try {
      if (detectBtn) detectBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'ローカルAIで検出中...';

      const res = await fetch('/api/export/detect-privacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photo_id: pid,
          apply_adjustments: true,
          detect_plates: cfg.detectPlates,
          detect_faces: cfg.detectFaces,
        }),
      });
      if (reqToken !== loadReqSeq) return;

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || '自動検出エラー');
      }
      const data = await res.json();
      if (reqToken !== loadReqSeq) return;

      const pList = (data.plates || []).map((p) => ({
        ...p,
        feather: cfg.plateFeather ?? 0.45,
      }));
      const fList = (data.faces || []).map((f) => ({
        ...f,
        style: cfg.faceStyle || f.style || 'frosted',
        strength: cfg.faceStrength ?? f.strength ?? 0.92,
      }));
      editor.setMasks(pList, fList);

      if (statusEl) {
        statusEl.textContent = `提案完了 (ナンバー:${pList.length} / 顔:${fList.length})`;
      }
      if (!silentIfZero && pList.length === 0 && fList.length === 0) {
        toast('自動検出候補は見つかりませんでした（「＋ナンバー枠追加」や「顔モヤ貼付」で手動配置できます）', 'info', 3500);
      }
    } catch (e) {
      console.warn('[ART_FRAMER] 自動検出スキップ:', e);
      if (statusEl) statusEl.textContent = '手動配置モード';
      if (!silentIfZero) {
        toast(`自動検出を実行できませんでした: ${e.message}`, 'warning');
      }
    } finally {
      if (detectBtn) detectBtn.disabled = false;
    }
  }

  async function loadCurrentQueuePhoto() {
    if (!photoQueue.length || !editor) return;
    const mySeq = ++loadReqSeq;
    const pid = photoQueue[queueIndex];
    const meta = findPhotoMeta(pid);

    const counterEl = document.getElementById('afQueueCounterBadge');
    const nameEl = document.getElementById('afCurrentFileName');
    const statusEl = document.getElementById('afDetectStatusText');

    if (counterEl) counterEl.textContent = `${queueIndex + 1} / ${photoQueue.length} 枚目`;
    if (nameEl) nameEl.textContent = meta.file_name || `ID:${pid}`;
    if (statusEl) statusEl.textContent = '画像読込中...';

    editor.setPhotoSource(null, meta, { plates: [], faces: [] });
    refreshMaskPillsUI({ plates: [], faces: [], selected: null });
    setStep(1);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (mySeq !== loadReqSeq) return;
      editor.setPhotoSource(img, meta, { plates: [], faces: [] });
      pushDecoratorToEditor();
      if (cfg.autoDetectOnOpen && (cfg.detectPlates || cfg.detectFaces)) {
        runAiDetectionForCurrentPhoto(true);
      } else if (statusEl) {
        statusEl.textContent = '待機中';
      }
    };
    img.onerror = () => {
      if (mySeq !== loadReqSeq) return;
      if (statusEl) statusEl.textContent = '画像読込エラー';
      toast('プレビュー画像の読み込みに失敗しました', 'error');
    };
    img.src = `/api/photo/${pid}/view?t=${meta._thumbBust || Date.now()}`;
  }

  function buildExportPayload(targetIds, includeCurrentMasks, openAfterFlag) {
    return {
      photo_ids: targetIds,
      destination: cfg.output.destination || null,
      format: cfg.output.format,
      quality: cfg.output.quality,
      resize_mode: 'original',
      naming_rule: cfg.output.naming_rule,
      custom_prefix: cfg.output.custom_prefix || 'ArtFrame',
      apply_adjustments: true,
      exif_sync_db: !cfg.output.exif_remove_all,
      exif_remove_gps: cfg.output.exif_remove_gps,
      exif_remove_exposure: false,
      exif_remove_camera: false,
      exif_remove_other: false,
      exif_remove_all: cfg.output.exif_remove_all,
      export_xmp_sidecar: false,
      export_raw_original: false,
      open_folder_after: Boolean(openAfterFlag),
      art_preset: cfg.artPreset,
      seq_offset: exportedCount,
      privacy_masks: includeCurrentMasks && editor ? editor.getMasksPayload() : null,
      watermark: cfg.watermark.enabled ? {
        enabled: true,
        type: cfg.watermark.type,
        text: cfg.watermark.text,
        image_path: cfg.watermark.image_path,
        position: cfg.watermark.position,
        opacity: cfg.watermark.opacity,
        size_ratio: cfg.watermark.size_ratio,
        color: cfg.watermark.color,
        shadow: cfg.watermark.shadow,
      } : { enabled: false },
      print_frame: cfg.frame.enabled ? { ...cfg.frame, enabled: true } : { enabled: false },
    };
  }

  async function exportCurrentAndAdvance() {
    if (isBusy || !photoQueue.length) return;
    saveSettings();
    isBusy = true;
    updateFooterButtonsUI();

    const pid = photoQueue[queueIndex];
    const isLast = queueIndex >= photoQueue.length - 1;
    const shouldOpenNow = isLast && cfg.output.open_folder_after;

    try {
      const payload = buildExportPayload([pid], true, shouldOpenNow);
      const res = await fetch('/api/export/smart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 'ok' || !data.success_count) {
        const reason = (data.failed_files && data.failed_files[0] && data.failed_files[0].error) || data.detail || data.message || '書き出し失敗';
        throw new Error(reason);
      }

      exportedCount += data.success_count;
      if (data.destination) lastExportedDir = data.destination;

      if (!isLast) {
        toast(`${queueIndex + 1} / ${photoQueue.length} 枚目を出力しました — 次の写真へ進みます`, 'success', 2600);
        queueIndex += 1;
        isBusy = false;
        await loadCurrentQueuePhoto();
      } else {
        toast(`Art Framer: 計 ${exportedCount} 枚の書き出しが完了しました`, 'success', 4500);
        isBusy = false;
        closeArtFramerModal(true);
      }
    } catch (e) {
      console.error('[ART_FRAMER] 出力エラー:', e);
      toast(`書き出しエラー: ${e.message}`, 'error', 5000);
      isBusy = false;
      updateFooterButtonsUI();
    }
  }

  async function exportRemainingBatchWithoutMasks() {
    if (isBusy || !photoQueue.length) return;
    const remainingIds = photoQueue.slice(queueIndex);
    if (remainingIds.length === 0) return;

    saveSettings();
    isBusy = true;
    updateFooterButtonsUI();

    try {
      const payload = buildExportPayload(remainingIds, false, cfg.output.open_folder_after);
      const res = await fetch('/api/export/smart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.status !== 'ok') {
        throw new Error(data.detail || data.message || '一括書き出しに失敗しました');
      }
      exportedCount += (data.success_count || 0);
      toast(`Art Framer: 計 ${exportedCount} 枚の一括書き出しが完了しました`, 'success', 4500);
      isBusy = false;
      closeArtFramerModal(true);
    } catch (e) {
      console.error('[ART_FRAMER] 一括出力エラー:', e);
      toast(`一括書き出しエラー: ${e.message}`, 'error', 5000);
      isBusy = false;
      updateFooterButtonsUI();
    }
  }

  async function skipCurrentPhoto() {
    if (isBusy) return;
    if (queueIndex < photoQueue.length - 1) {
      queueIndex += 1;
      await loadCurrentQueuePhoto();
    } else {
      if (exportedCount > 0 && cfg.output.open_folder_after && lastExportedDir) {
        fetch('/api/export/open-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: lastExportedDir }),
        }).catch(() => {});
      }
      closeArtFramerModal(true);
    }
  }

  async function ensureDefaultDestination() {
    if (cfg.output.destination) return;
    try {
      const res = await fetch('/api/export/default-dir');
      if (res.ok) {
        const d = await res.json();
        if (d.default_dir) {
          cfg.output.destination = d.default_dir;
          const destEl = document.getElementById('afDestInput');
          if (destEl) destEl.value = d.default_dir;
        }
      }
    } catch (e) {
      console.warn('[ART_FRAMER] デフォルト保存先取得スキップ:', e);
    }
  }

  async function openArtFramerModal(explicitIds, presetKey = 'for_x') {
    if (!initModalOnce()) return;

    let ids = resolveSelectedIds(explicitIds);
    const linkPart = typeof window.partitionPhotosByLinkStatus === 'function'
      ? window.partitionPhotosByLinkStatus(ids)
      : { linkedIds: ids, unlinkedIds: [] };

    if (linkPart.linkedIds.length === 0 && ids.length > 0) {
      toast('リンク情報なしの写真は実体ファイルがないため出力できません', 'warning');
      return;
    }
    if (linkPart.unlinkedIds.length > 0) {
      ids = linkPart.linkedIds;
      toast(`実体のない ${linkPart.unlinkedIds.length} 枚はスキップしました（${ids.length}枚を対象にします）`, 'info');
    }
    if (!ids.length) {
      toast('Art Framer で仕上げる写真を選択してください', 'warning');
      return;
    }

    loadSavedSettings();
    await ensureDefaultDestination();

    photoQueue = ids;
    queueIndex = 0;
    exportedCount = 0;
    lastExportedDir = '';
    isBusy = false;

    modalEl.style.display = 'flex';
    applyTargetPreset(presetKey || 'for_x');
    await loadCurrentQueuePhoto();
  }

  async function closeArtFramerModal(force = false) {
    if (!modalEl) return;
    if (!force && isBusy) return;
    loadReqSeq += 1;
    modalEl.style.display = 'none';
  }

  async function pickDestFolder() {
    const btn = document.getElementById('afPickDirBtn');
    try {
      if (btn) btn.disabled = true;
      const res = await fetch('/api/export/pick-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial_dir: cfg.output.destination || null }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d.selected_path) {
          cfg.output.destination = d.selected_path;
          const el = document.getElementById('afDestInput');
          if (el) el.value = d.selected_path;
          saveSettings();
        }
      }
    } catch (e) {
      toast('フォルダ選択ダイアログを開けませんでした', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function pickLogoImage() {
    const btn = document.getElementById('afPickWmLogoBtn');
    try {
      if (btn) btn.disabled = true;
      const res = await fetch('/api/export/pick-watermark-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial_path: cfg.watermark.image_path || null }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d.error) {
          toast(d.error, 'warning');
          return;
        }
        if (d.selected_path) {
          cfg.watermark.image_path = d.selected_path;
          cfg.watermark.image_name = d.file_name || 'logo.png';
          cfg.watermark.preview_data_url = d.preview_data_url || '';
          if (cfg.watermark.size_ratio < 0.04) cfg.watermark.size_ratio = 0.12;
          syncFormFromState();
          pushDecoratorToEditor();
          saveSettings();
        }
      }
    } catch (e) {
      toast('ロゴ画像の選択に失敗しました', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  let initialized = false;
  function initModalOnce() {
    if (initialized && modalEl) return true;
    modalEl = document.getElementById('artFramerModal');
    const canvasEl = document.getElementById('artFramerCanvas');
    if (!modalEl || !canvasEl || typeof window.PrivacyMaskCanvasEditor !== 'function') {
      return false;
    }

    editor = new window.PrivacyMaskCanvasEditor(canvasEl, {
      onMasksChange: (info) => {
        refreshMaskPillsUI(info);
        updateStep3SummaryUI();
      },
      onZoomChange: (z) => {
        const zEl = document.getElementById('afZoomPctBadge');
        if (zEl) zEl.textContent = `${Math.round(z * 100)}%`;
      },
      onToolModeChange: (mode) => {
        modalEl.querySelectorAll('.af-tool-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.mode === mode);
        });
        const eyeBtn = document.getElementById('afEyedropBtn');
        if (eyeBtn) {
          eyeBtn.classList.toggle('active', mode === 'eyedrop');
          eyeBtn.textContent = mode === 'eyedrop' ? '写真をクリック...' : 'スポイト吸取';
        }
      },
      onEyedropColor: (hex) => {
        const cIn = document.getElementById('afCustomPlateColor');
        if (cIn) cIn.value = hex;
      },
      onDimensionsUpdate: (dims) => {
        const badge = document.getElementById('afLiveDimBadge');
        if (badge && dims && dims.width > 0) {
          badge.textContent = `出力目安: ${dims.width} × ${dims.height} px`;
        }
      },
    });

    // 閉じる・Esc
    document.getElementById('closeArtFramerBtn')?.addEventListener('click', () => closeArtFramerModal(false));
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) closeArtFramerModal(false);
    });
    window.addEventListener('keydown', (e) => {
      if (!modalEl || modalEl.style.display !== 'flex') return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeArtFramerModal(false);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement?.tagName !== 'INPUT') {
        if (cfg.step === 1 && editor) editor.deleteSelected();
      }
    });
    window.addEventListener('resize', () => {
      if (modalEl && modalEl.style.display === 'flex' && editor) editor.render();
    });

    // プリセット切替ピル
    modalEl.querySelectorAll('.af-preset-pill').forEach((btn) => {
      btn.addEventListener('click', () => applyTargetPreset(btn.dataset.preset));
    });

    // ステップタブ・フッターボタン
    modalEl.querySelectorAll('.af-step-tab').forEach((tab) => {
      tab.addEventListener('click', () => setStep(parseInt(tab.dataset.step, 10)));
    });
    document.getElementById('afPrevStepBtn')?.addEventListener('click', () => setStep(cfg.step - 1));
    document.getElementById('afNextStepBtn')?.addEventListener('click', () => setStep(cfg.step + 1));
    document.getElementById('afQuickExportBtn')?.addEventListener('click', exportCurrentAndAdvance);
    document.getElementById('afSkipPhotoBtn')?.addEventListener('click', skipCurrentPhoto);
    document.getElementById('afBatchRestBtn')?.addEventListener('click', exportRemainingBatchWithoutMasks);

    // ズームツールバー
    document.getElementById('afZoomInBtn')?.addEventListener('click', () => editor.zoomByFactor(1.45));
    document.getElementById('afZoomOutBtn')?.addEventListener('click', () => editor.zoomByFactor(1 / 1.45));
    document.getElementById('afZoomFitBtn')?.addEventListener('click', () => editor.resetZoom());
    document.getElementById('afZoomFocusBtn')?.addEventListener('click', () => editor.focusOnSelectedMask());
    document.getElementById('afLoupeCheck')?.addEventListener('change', (e) => {
      editor.loupeEnabled = e.target.checked;
    });

    const cleanBtn = document.getElementById('afHoldCleanBtn');
    if (cleanBtn) {
      cleanBtn.addEventListener('pointerdown', () => { editor.hideGuides = true; editor.render(); });
      window.addEventListener('pointerup', () => {
        if (editor && editor.hideGuides) { editor.hideGuides = false; editor.render(); }
      });
    }

    // Step 1: マスク操作
    document.getElementById('afRunDetectBtn')?.addEventListener('click', () => runAiDetectionForCurrentPhoto(false));
    document.getElementById('afAutoDetectCheck')?.addEventListener('change', (e) => {
      cfg.autoDetectOnOpen = e.target.checked;
      saveSettings();
    });
    document.getElementById('afDetectPlatesCheck')?.addEventListener('change', (e) => {
      cfg.detectPlates = e.target.checked;
      saveSettings();
    });
    document.getElementById('afDetectFacesCheck')?.addEventListener('change', (e) => {
      cfg.detectFaces = e.target.checked;
      saveSettings();
    });

    modalEl.querySelectorAll('.af-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => editor.setToolMode(btn.dataset.mode));
    });
    document.getElementById('afAddPlateBtn')?.addEventListener('click', () => editor.addPlateAtViewportCenter());
    document.getElementById('afDeleteMaskBtn')?.addEventListener('click', () => editor.deleteSelected());
    document.getElementById('afClearMasksBtn')?.addEventListener('click', () => editor.clearAll());

    document.getElementById('afPlateStyleSelect')?.addEventListener('change', (e) => {
      editor.applyPlateStyle(e.target.value, null);
    });
    modalEl.querySelectorAll('.af-color-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        const hex = sw.dataset.color;
        const cIn = document.getElementById('afCustomPlateColor');
        if (cIn) cIn.value = hex;
        const stSel = document.getElementById('afPlateStyleSelect');
        if (stSel) stSel.value = 'solid';
        editor.applyPlateStyle('solid', hex);
      });
    });
    document.getElementById('afCustomPlateColor')?.addEventListener('input', (e) => {
      const stSel = document.getElementById('afPlateStyleSelect');
      if (stSel) stSel.value = 'solid';
      editor.applyPlateStyle('solid', e.target.value);
    });
    document.getElementById('afEyedropBtn')?.addEventListener('click', () => {
      editor.setToolMode(editor.toolMode === 'eyedrop' ? 'edit' : 'eyedrop');
    });
    document.getElementById('afPlateFeatherSlider')?.addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10);
      const valNorm = Math.max(0, Math.min(1, (isNaN(pct) ? 45 : pct) / 100));
      cfg.plateFeather = valNorm;
      const lbl = document.getElementById('afPlateFeatherVal');
      if (lbl) lbl.textContent = `${Math.round(valNorm * 100)}%`;
      editor.applyPlateStyle(null, null, valNorm);
    });
    document.getElementById('afPlateFeatherSlider')?.addEventListener('change', () => {
      saveSettings();
    });

    document.getElementById('afHazeStyleSelect')?.addEventListener('change', (e) => {
      cfg.faceStyle = e.target.value;
      editor.applyFaceStyle({ style: cfg.faceStyle });
      saveSettings();
    });
    document.getElementById('afStampRadiusSlider')?.addEventListener('input', (e) => {
      const pct = parseFloat(e.target.value);
      cfg.faceRadius = Math.max(0.015, Math.min(0.35, (isNaN(pct) ? 5.2 : pct) / 100));
      const lbl = document.getElementById('afStampRadiusVal');
      if (lbl) lbl.textContent = `${(cfg.faceRadius * 100).toFixed(1)}%`;
      editor.applyFaceStyle({ radius: cfg.faceRadius });
    });
    document.getElementById('afStampRadiusSlider')?.addEventListener('change', () => {
      saveSettings();
    });
    document.getElementById('afStampStrengthSlider')?.addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10);
      cfg.faceStrength = Math.max(0.40, Math.min(1.0, (isNaN(pct) ? 92 : pct) / 100));
      const lbl = document.getElementById('afStampStrengthVal');
      if (lbl) lbl.textContent = `${Math.round(cfg.faceStrength * 100)}%`;
      editor.applyFaceStyle({ strength: cfg.faceStrength });
    });
    document.getElementById('afStampStrengthSlider')?.addEventListener('change', () => {
      saveSettings();
    });

    // Step 2: プリント枠イベント
    document.getElementById('afFrameEnableCheck')?.addEventListener('change', (e) => {
      cfg.frame.enabled = e.target.checked;
      syncFormFromState();
      pushDecoratorToEditor();
    });
    modalEl.querySelectorAll('.af-layout-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        cfg.frame.layout = btn.dataset.layout;
        syncFormFromState();
        pushDecoratorToEditor();
      });
    });
    document.getElementById('afMatteSelect')?.addEventListener('change', (e) => {
      cfg.frame.matte = e.target.value;
      pushDecoratorToEditor();
    });
    document.getElementById('afAspectSelect')?.addEventListener('change', (e) => {
      cfg.frame.aspect_mode = e.target.value;
      syncFormFromState();
      pushDecoratorToEditor();
    });
    document.getElementById('afBorderSlider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.frame.border_ratio = v / 100;
      const lbl = document.getElementById('afBorderVal');
      if (lbl) lbl.textContent = `${v.toFixed(1)}%`;
      pushDecoratorToEditor();
    });
    document.getElementById('afFontScaleSlider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.frame.font_scale = v / 100;
      const lbl = document.getElementById('afFontScaleVal');
      if (lbl) lbl.textContent = `${v}%`;
      pushDecoratorToEditor();
    });

    const bindFrameChk = (id, key) => {
      document.getElementById(id)?.addEventListener('change', (e) => {
        cfg.frame[key] = e.target.checked;
        syncFormFromState();
        pushDecoratorToEditor();
      });
    };
    bindFrameChk('afInnerBorderCheck', 'inner_border');
    bindFrameChk('afPhotoShadowCheck', 'photo_shadow');
    bindFrameChk('afShowCameraCheck', 'show_camera');
    bindFrameChk('afShowLensCheck', 'show_lens');
    bindFrameChk('afShowExposureCheck', 'show_exposure');
    bindFrameChk('afShowDateCheck', 'show_date');
    bindFrameChk('afShowLocationCheck', 'show_location');
    bindFrameChk('afShowNoteCheck', 'show_note');

    document.getElementById('afCustomNoteInput')?.addEventListener('input', (e) => {
      cfg.frame.custom_note = e.target.value;
      pushDecoratorToEditor();
    });

    // Step 2: ウォーターマークイベント
    document.getElementById('afWmEnableCheck')?.addEventListener('change', (e) => {
      cfg.watermark.enabled = e.target.checked;
      syncFormFromState();
      pushDecoratorToEditor();
    });
    document.getElementById('afWmTypeSelect')?.addEventListener('change', (e) => {
      cfg.watermark.type = e.target.value;
      cfg.watermark.size_ratio = cfg.watermark.type === 'image' ? 0.12 : 0.018;
      syncFormFromState();
      pushDecoratorToEditor();
    });
    document.getElementById('afWmTextInput')?.addEventListener('input', (e) => {
      cfg.watermark.text = e.target.value;
      pushDecoratorToEditor();
    });
    document.getElementById('afWmColorSelect')?.addEventListener('change', (e) => {
      cfg.watermark.color = e.target.value;
      pushDecoratorToEditor();
    });
    document.getElementById('afWmShadowCheck')?.addEventListener('change', (e) => {
      cfg.watermark.shadow = e.target.checked;
      pushDecoratorToEditor();
    });
    document.getElementById('afPickWmLogoBtn')?.addEventListener('click', pickLogoImage);
    modalEl.querySelectorAll('.af-wm-pos-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        cfg.watermark.position = btn.dataset.pos;
        syncFormFromState();
        pushDecoratorToEditor();
      });
    });
    document.getElementById('afWmOpacitySlider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.watermark.opacity = v / 100;
      const lbl = document.getElementById('afWmOpacityVal');
      if (lbl) lbl.textContent = `${v}%`;
      pushDecoratorToEditor();
    });
    document.getElementById('afWmSizeSlider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.watermark.size_ratio = v / 100;
      const lbl = document.getElementById('afWmSizeVal');
      if (lbl) lbl.textContent = `${v.toFixed(1)}%`;
      pushDecoratorToEditor();
    });

    // Step 3: 出力設定イベント
    document.getElementById('afFormatSelect')?.addEventListener('change', (e) => {
      cfg.output.format = e.target.value;
    });
    document.getElementById('afQualitySlider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.output.quality = v;
      const lbl = document.getElementById('afQualityVal');
      if (lbl) lbl.textContent = `${v}%`;
    });
    document.getElementById('afNamingSelect')?.addEventListener('change', (e) => {
      cfg.output.naming_rule = e.target.value;
      syncFormFromState();
    });
    document.getElementById('afCustomPrefixInput')?.addEventListener('input', (e) => {
      cfg.output.custom_prefix = e.target.value;
    });
    document.getElementById('afExifRemoveGpsCheck')?.addEventListener('change', (e) => {
      cfg.output.exif_remove_gps = e.target.checked;
    });
    document.getElementById('afExifRemoveAllCheck')?.addEventListener('change', (e) => {
      cfg.output.exif_remove_all = e.target.checked;
      syncFormFromState();
    });
    document.getElementById('afPickDirBtn')?.addEventListener('click', pickDestFolder);
    document.getElementById('afOpenAfterCheck')?.addEventListener('change', (e) => {
      cfg.output.open_folder_after = e.target.checked;
    });

    initialized = true;
    return true;
  }

  /**
   * 右クリックメニュー（インライン3連プリセット）、ライトボックス（1枚直行ドロップダウン）、およびインスペクタの配線
   */
  function setupEntryTriggers() {
    // 1. 右クリックメニュー「テイクアウト ＞ Art Framer」カード ＆ 3プリセットボタン
    const ctxHeadBtn = document.getElementById('contextArtFramerHeadBtn');
    if (ctxHeadBtn) {
      ctxHeadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof window.closeContextMenu === 'function') window.closeContextMenu();
        openArtFramerModal(null, 'for_x');
      });
    }
    document.querySelectorAll('.af-context-preset-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const preset = btn.dataset.preset || 'for_x';
        if (typeof window.closeContextMenu === 'function') window.closeContextMenu();
        openArtFramerModal(null, preset);
      });
    });

    // 2. ライトボックス上部ツールバーからの1枚直行起動
    const lbWrap = document.getElementById('lightboxArtFramerWrap');
    const lbBtn = document.getElementById('lightboxArtFramerBtn');
    const lbMenu = document.getElementById('lightboxArtFramerMenu');
    if (lbWrap && lbBtn && lbMenu) {
      const closeLbMenu = () => lbMenu.classList.remove('is-open');
      lbBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        lbMenu.classList.toggle('is-open');
      });
      lbMenu.querySelectorAll('.lightbox-af-opt').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          closeLbMenu();
          const preset = opt.dataset.preset || 'for_x';
          const cur = typeof window.getCurrentLightboxPhoto === 'function' ? window.getCurrentLightboxPhoto() : null;
          if (!cur || !cur.id) {
            toast('表示中の写真が見つかりません', 'warning');
            return;
          }
          if (cur.is_unlinked || cur.is_offline || cur.is_missing) {
            toast('オフラインまたはリンク消失中の写真は元ファイルがないため Art Framer を実行できません', 'warning');
            return;
          }
          openArtFramerModal([cur.id], preset);
        });
      });
      document.addEventListener('click', (e) => {
        if (!lbWrap.contains(e.target)) closeLbMenu();
      });
    }

    // 3. スマート・テイクアウトモーダル内からのジャンプボタン
    document.getElementById('switchToArtFramerBtn')?.addEventListener('click', () => {
      if (typeof window.closeSmartTakeoutModal === 'function') {
        window.closeSmartTakeoutModal();
      }
      openArtFramerModal(null, 'for_x');
    });

    // 4. 右インスペクタの Art Framer ボタン (単一・一括)
    document.getElementById('inspectorArtFramerBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtFramerModal(null, 'for_x');
    });
    document.getElementById('batchArtFramerBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openArtFramerModal(null, 'for_x');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupEntryTriggers);
  } else {
    setupEntryTriggers();
  }

  window.openArtFramerModal = openArtFramerModal;
  window.closeArtFramerModal = closeArtFramerModal;
})();
