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
  let isPickingFolder = false;
  let isAfBackdropPointerDown = false;
  let loadReqSeq = 0;

  // Step 0（非破壊調整）作業状態
  let step0CommittedAdjust = null;
  let step0DraftAdjust = null;
  let step0RawImg = null;
  let step0RawPhotoId = 0;
  let step0RawLoading = false;
  let step0ShowGrid = true;
  let step0CompareBefore = false;
  let step0Busy = false;
  let step0ImpactResolver = null;

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
    effect: {
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
    },
    watermark: {
      enabled: false,
      type: 'text',
      text: '© 2026',
      asset_id: '',
      image_url: '',
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

  let watermarkAssets = [];

  const WM_POS_LABELS = {
    'top-left': '左上',
    'top-center': '中央上',
    'top-right': '右上',
    'middle-left': '左中',
    center: '中央',
    'middle-right': '右中',
    'bottom-left': '左下',
    'bottom-center': '中央下',
    'bottom-right': '右下',
  };

  function encodeWmTextStyle(wm) {
    const colorPart = wm && wm.color === 'dark' ? 'dark' : 'light';
    const shadowPart = wm && wm.shadow === false ? 'plain' : 'shadow';
    return `${colorPart}_${shadowPart}`;
  }

  function applyWmTextStyle(wm, styleVal) {
    if (!wm) return;
    const raw = String(styleVal || 'light_shadow');
    wm.color = raw.startsWith('dark') ? 'dark' : 'light';
    wm.shadow = raw.endsWith('_shadow');
  }

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

  function resolveActiveWatermarkLogoUrl() {
    if (cfg.watermark.asset_id) {
      const hit = watermarkAssets.find((a) => a.id === cfg.watermark.asset_id);
      if (hit && hit.image_url) return hit.image_url;
    }
    return cfg.watermark.image_url || cfg.watermark.preview_data_url || '';
  }

  function _effectApi() {
    return window.TetheractArtFramerEffect || null;
  }

  function _isEffectStepDisabled() {
    const api = _effectApi();
    return Boolean(api && typeof api.isEffectStepDisabled === 'function' && api.isEffectStepDisabled());
  }

  function _resetEffectForSession() {
    const api = _effectApi();
    cfg.effect = api && typeof api.createDefaultEffectConfig === 'function'
      ? api.createDefaultEffectConfig()
      : { presetKey: 'none', bokeh_mode: 'none', strength: 0, specular: 0.65, radius: 0.32, feather: 0.36, cx: 0.5, cy: 0.5, vignette: 0, halation: 0 };
  }

  function _getEffectiveLensEffectPayload() {
    if (_isEffectStepDisabled()) return { enabled: false };
    const api = _effectApi();
    return api ? api.normalizeEffectConfig(cfg.effect) : { enabled: false };
  }

  function syncEffectStepVisibilityUI() {
    if (!modalEl) return;
    const disabled = _isEffectStepDisabled();
    const api = _effectApi();
    const effOn = !disabled && Boolean(api && api.isEffectActive(cfg.effect));

    modalEl.querySelectorAll('.af-step-tab').forEach((tab) => {
      const logical = parseInt(tab.dataset.step, 10);
      if (logical === 2) {
        tab.style.display = disabled ? 'none' : 'inline-flex';
        tab.classList.toggle('has-effect-on', effOn);
      } else {
        tab.style.display = 'inline-flex';
      }
      const numEl = tab.querySelector('.af-step-num');
      if (numEl) {
        const disp = api ? api.getDisplayStepNumber(logical, disabled) : logical;
        numEl.textContent = String(disp);
      }
    });
  }

  function syncEffectControlsUI() {
    if (!modalEl) return;
    const fx = cfg.effect || {};
    const activePreset = String(fx.presetKey || 'none');
    modalEl.querySelectorAll('.af-effect-preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.effectPreset === activePreset);
    });
    const setV = (id, val) => { const el = document.getElementById(id); if (el) el.value = String(val); };
    const setT = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };

    setV('afEffectBokehSelect', fx.bokeh_mode || 'none');
    const stPct = Math.round((fx.strength || 0) * 100);
    setV('afEffectStrengthSlider', stPct);
    setT('afEffectStrengthVal', `${stPct}%`);
    const spPct = Math.round((fx.specular ?? 0.65) * 100);
    setV('afEffectSpecularSlider', spPct);
    setT('afEffectSpecularVal', `${spPct}%`);
    const rPct = Math.round((fx.radius ?? 0.32) * 100);
    setV('afEffectRadiusSlider', rPct);
    setT('afEffectRadiusVal', `${rPct}%`);
    const fPct = Math.round((fx.feather ?? 0.36) * 100);
    setV('afEffectFeatherSlider', fPct);
    setT('afEffectFeatherVal', `${fPct}%`);
    const vVal = Math.round((fx.vignette || 0) * 100);
    setV('afEffectVignetteSlider', vVal);
    setT('afEffectVignetteVal', `${vVal > 0 ? '+' : ''}${vVal}`);
    const hPct = Math.round((fx.halation || 0) * 100);
    setV('afEffectHalationSlider', hPct);
    setT('afEffectHalationVal', `${hPct}%`);

    syncEffectStepVisibilityUI();
  }

  function pushDecoratorToEditor() {
    if (!editor) return;
    let mode = 'decorated';
    if (cfg.step === 0) mode = 'adjust';
    else if (cfg.step === 1) mode = 'mask';
    else if (cfg.step === 2) mode = 'effect';
    editor.setDecoratorState({
      viewMode: mode,
      effectConfig: _getEffectiveLensEffectPayload(),
      frameConfig: cfg.frame,
      watermarkConfig: cfg.watermark,
      artPreset: cfg.artPreset,
      logoDataUrl: resolveActiveWatermarkLogoUrl(),
    });
    if (typeof editor.setAdjustOverlayState === 'function') {
      editor.setAdjustOverlayState({
        showLevelGrid: cfg.step === 0 && step0ShowGrid,
        fineGrid: cfg.step === 0,
        isComparingBefore: cfg.step === 0 && step0CompareBefore,
      });
    }
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
    const wmEnabled = Boolean(cfg.watermark.enabled);
    const wmPos = WM_POS_LABELS[cfg.watermark.position] ? cfg.watermark.position : 'bottom-right';
    const wmBody = document.getElementById('afWmControlsBody');
    if (wmBody) wmBody.style.display = wmEnabled ? 'flex' : 'none';

    const wmStatusEl = document.getElementById('afWmStatusLabel');
    if (wmStatusEl) {
      wmStatusEl.textContent = wmEnabled ? (WM_POS_LABELS[wmPos] || 'ON') : 'なし（位置を選択でON）';
      wmStatusEl.classList.toggle('is-on', wmEnabled);
    }
    const wmClearBtn = document.getElementById('afWmClearBtn');
    if (wmClearBtn) wmClearBtn.style.display = wmEnabled ? 'inline-flex' : 'none';
    document.getElementById('afWmPosMap')?.classList.toggle('is-active', wmEnabled);

    setVal('afWmTypeSelect', cfg.watermark.type);
    const isLogo = cfg.watermark.type === 'image';
    const wmTextGroup = document.getElementById('afWmTextGroup');
    const wmImageGroup = document.getElementById('afWmImageGroup');
    if (wmTextGroup) wmTextGroup.style.display = isLogo ? 'none' : 'flex';
    if (wmImageGroup) wmImageGroup.style.display = isLogo ? 'flex' : 'none';

    setVal('afWmTextInput', cfg.watermark.text);
    setVal('afWmColorSelect', encodeWmTextStyle(cfg.watermark));
    setTxt('afWmImageNameLabel', cfg.watermark.image_name || '未選択');

    modalEl.querySelectorAll('.af-wm-pos-btn').forEach((btn) => {
      const isAct = wmEnabled && btn.dataset.pos === wmPos;
      btn.classList.toggle('active', isAct);
      btn.setAttribute('aria-pressed', isAct ? 'true' : 'false');
    });

    const opPct = Math.round((cfg.watermark.opacity ?? 0.58) * 100);
    setVal('afWmOpacitySlider', opPct);
    setTxt('afWmOpacityVal', `${opPct}%`);

    const szRatio = isLogo
      ? Math.max(0.03, Math.min(0.50, Number(cfg.watermark.size_ratio || 0.16)))
      : Math.max(0.008, Math.min(0.06, Number(cfg.watermark.size_ratio || 0.018)));
    const szPct = isLogo ? Math.round(szRatio * 100).toString() : (szRatio * 100).toFixed(1);
    const szSlider = document.getElementById('afWmSizeSlider');
    if (szSlider) {
      szSlider.min = isLogo ? '3' : '0.8';
      szSlider.max = isLogo ? '50' : '6.0';
      szSlider.step = isLogo ? '1' : '0.2';
      szSlider.value = szPct;
    }
    setTxt('afWmSizeLabel', isLogo ? '大きさ(長辺)' : '大きさ');
    setTxt('afWmSizeVal', `${szPct}%`);
    renderWatermarkAssetGallery();

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

    syncEffectControlsUI();
  }

  function _step0Api() {
    return window.TetheractArtFramerStep0 || null;
  }

  function _normalizeAdjust(meta) {
    const api = _step0Api();
    if (api && typeof api.normalizeAdjustSnapshot === 'function') {
      return api.normalizeAdjustSnapshot(meta);
    }
    const src = meta || {};
    return {
      rotation: ((Math.round(Number(src.rotation || 0)) % 360) + 360) % 360,
      fine_angle: Number(Number(src.fine_angle || 0).toFixed(2)),
      brightness: Math.round(Number(src.brightness || 0)),
      contrast: Math.round(Number(src.contrast || 0)),
      saturation: Math.round(Number(src.saturation || 0)),
      crop_x: src.crop_x ?? null,
      crop_y: src.crop_y ?? null,
      crop_w: src.crop_w ?? null,
      crop_h: src.crop_h ?? null,
      crop_aspect: src.crop_aspect ?? null,
    };
  }

  function _syncStep0FormUI() {
    if (!modalEl) return;
    const api = _step0Api();
    const d = step0DraftAdjust || _normalizeAdjust(null);
    const committed = step0CommittedAdjust || d;
    const diff = api && typeof api.classifyAdjustDiff === 'function'
      ? api.classifyAdjustDiff(committed, d)
      : { hasAnyChange: false };

    const tiltEl = document.getElementById('afStep0TiltSlider');
    const tiltVal = document.getElementById('afStep0TiltVal');
    const fa = Number(d.fine_angle || 0);
    if (tiltEl) tiltEl.value = String(Math.max(-15, Math.min(15, fa)));
    if (tiltVal) {
      tiltVal.textContent = api ? api.formatFineAngle(fa) : `${fa.toFixed(1)}°`;
      tiltVal.classList.toggle('is-modified', Math.abs(fa) > 0.015);
    }

    const expEl = document.getElementById('afStep0ExpSlider');
    const expVal = document.getElementById('afStep0ExpVal');
    const dialIdx = api ? api.brightnessToDialIndex(d.brightness) : 0;
    const snappedB = api ? api.dialIndexToBrightness(dialIdx) : (d.brightness || 0);
    if (expEl) expEl.value = String(dialIdx);
    if (expVal) {
      expVal.textContent = api ? api.formatBrightnessEv(d.brightness) : `${(snappedB / 10).toFixed(1)}EV`;
      expVal.classList.toggle('is-modified', Math.round(Number(d.brightness || 0)) !== 0);
    }

    const conEl = document.getElementById('afStep0ConSlider');
    const conVal = document.getElementById('afStep0ConVal');
    const c = Math.round(Number(d.contrast || 0));
    if (conEl) conEl.value = String(c);
    if (conVal) {
      conVal.textContent = `${c > 0 ? '+' : ''}${c}`;
      conVal.classList.toggle('is-modified', c !== 0);
    }

    const satEl = document.getElementById('afStep0SatSlider');
    const satVal = document.getElementById('afStep0SatVal');
    const s = Math.round(Number(d.saturation || 0));
    if (satEl) satEl.value = String(s);
    if (satVal) {
      satVal.textContent = `${s > 0 ? '+' : ''}${s}`;
      satVal.classList.toggle('is-modified', s !== 0);
    }

    const gridChk = document.getElementById('afStep0GridCheck');
    if (gridChk) gridChk.checked = Boolean(step0ShowGrid);

    const cmpBtn = document.getElementById('afStep0CompareBtn');
    if (cmpBtn) cmpBtn.classList.toggle('is-holding', Boolean(step0CompareBefore));

    const revBtn = document.getElementById('afStep0RevertBtn');
    if (revBtn) revBtn.disabled = step0Busy || !diff.hasAnyChange;

    const pasteBtn = document.getElementById('afStep0PasteToneBtn');
    if (pasteBtn) {
      const copied = typeof window.getCopiedToneAdjustments === 'function' ? window.getCopiedToneAdjustments() : null;
      pasteBtn.disabled = step0Busy || !copied;
    }

    const noteEl = document.getElementById('afStep0StatusNote');
    if (noteEl) {
      noteEl.textContent = step0RawLoading
        ? '元画像を読み込み中...'
        : (diff.hasAnyChange ? '未反映の変更あり（他ステップで保存）' : '元画像は変更されません');
    }
  }

  function _renderStep0Preview() {
    if (!editor || cfg.step !== 0 || !step0RawImg) return;
    if (step0CompareBefore) {
      editor.updateSourceImageOnly(step0RawImg);
      return;
    }
    const api = _step0Api();
    const previewCanvas = api && typeof api.renderStep0AdjustedCanvas === 'function'
      ? api.renderStep0AdjustedCanvas(step0RawImg, step0DraftAdjust, { maxLongEdge: 1600 })
      : null;
    if (previewCanvas) {
      editor.updateSourceImageOnly(previewCanvas);
    } else {
      editor.updateSourceImageOnly(step0RawImg);
    }
  }

  function _ensureStep0RawImage(pid, seqToken) {
    if (!pid) return;
    if (step0RawImg && step0RawPhotoId === Number(pid)) {
      _renderStep0Preview();
      return;
    }
    step0RawLoading = true;
    _syncStep0FormUI();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (seqToken !== loadReqSeq) return;
      step0RawImg = img;
      step0RawPhotoId = Number(pid);
      step0RawLoading = false;
      _syncStep0FormUI();
      if (cfg.step === 0) {
        _renderStep0Preview();
      }
    };
    img.onerror = () => {
      if (seqToken !== loadReqSeq) return;
      step0RawLoading = false;
      _syncStep0FormUI();
      toast('調整用の元画像読み込みに失敗しました', 'warning');
    };
    img.src = `/api/photo/${pid}/view?raw=1`;
  }

  function _closeStep0MaskImpactModal(choice = 'cancel') {
    const dlg = document.getElementById('afStep0MaskImpactDialog');
    if (dlg) dlg.style.display = 'none';
    const res = step0ImpactResolver;
    step0ImpactResolver = null;
    if (typeof res === 'function') res(choice);
  }

  function _openStep0MaskImpactModal() {
    const dlg = document.getElementById('afStep0MaskImpactDialog');
    if (!dlg) return Promise.resolve('redetect');
    const descEl = document.getElementById('afStep0ImpactDesc');
    if (descEl && editor) {
      descEl.textContent =
        `1. 修正 に配置済みのマスク（ナンバー ${editor.plates.length} / 顔 ${editor.faces.length}）は、` +
        '回転・水平傾き・切り抜きの変更により位置がずれる可能性があります。反映方法を選んでください。';
    }
    dlg.style.display = 'flex';
    return new Promise((resolve) => {
      step0ImpactResolver = resolve;
    });
  }

  function _applyAdjustStateToAppPhoto(pid, snap) {
    const meta = findPhotoMeta(pid);
    const nowBust = Date.now();
    const instances = typeof window.findAllPhotoInstancesById === 'function'
      ? window.findAllPhotoInstancesById(pid)
      : [meta];
    if (!instances.includes(meta)) instances.push(meta);
    instances.forEach((inst) => {
      if (!inst) return;
      inst.rotation = snap.rotation;
      inst.fine_angle = snap.fine_angle;
      inst.crop_x = snap.crop_x;
      inst.crop_y = snap.crop_y;
      inst.crop_w = snap.crop_w;
      inst.crop_h = snap.crop_h;
      inst.crop_aspect = snap.crop_aspect;
      inst.brightness = snap.brightness;
      inst.contrast = snap.contrast;
      inst.saturation = snap.saturation;
      inst._thumbBust = nowBust;
    });
    if (typeof window.applyTransformToPhotoViews === 'function') {
      window.applyTransformToPhotoViews(instances[0] || meta);
    }
    return instances[0] || meta;
  }

  async function _persistStep0Adjustments(pid, nextDraft) {
    const snap = _normalizeAdjust(nextDraft);
    const payload = {
      rotation: snap.rotation,
      fine_angle: snap.fine_angle,
      crop_x: snap.crop_x,
      crop_y: snap.crop_y,
      crop_w: snap.crop_w,
      crop_h: snap.crop_h,
      crop_aspect: snap.crop_aspect,
      brightness: snap.brightness,
      contrast: snap.contrast,
      saturation: snap.saturation,
    };
    const res = await fetch(`/api/photo/${pid}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || '非破壊調整の保存に失敗しました');
    }
    const updatedMeta = _applyAdjustStateToAppPhoto(pid, snap);
    step0CommittedAdjust = { ...snap };
    step0DraftAdjust = { ...snap };
    return updatedMeta;
  }

  function _reloadBakedViewForCurrentPhoto(pid, seqToken, meta, preserveMasks, runDetectAfter) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (seqToken !== loadReqSeq) { resolve(false); return; }
        if (preserveMasks && typeof editor.updateSourceImageOnly === 'function') {
          editor.updateSourceImageOnly(img, meta);
        } else {
          editor.setPhotoSource(img, meta, { plates: [], faces: [] });
        }
        pushDecoratorToEditor();
        if (runDetectAfter && (cfg.detectPlates || cfg.detectFaces)) {
          runAiDetectionForCurrentPhoto(true);
        }
        resolve(true);
      };
      img.onerror = () => {
        if (seqToken !== loadReqSeq) { resolve(false); return; }
        toast('調整後の画像再読み込みに失敗しました', 'error');
        resolve(false);
      };
      img.src = `/api/photo/${pid}/view?t=${(meta && meta._thumbBust) || Date.now()}`;
    });
  }

  async function requestStepChange(targetStep) {
    const disabled = _isEffectStepDisabled();
    let nextStep = Math.max(0, Math.min(4, Number(targetStep)));
    if (disabled && nextStep === 2) nextStep = 3;
    if (isBusy || step0Busy) return false;
    if (nextStep === cfg.step) return true;

    const pid = photoQueue[queueIndex];
    const seqToken = loadReqSeq;

    if (cfg.step === 0 && nextStep !== 0 && pid) {
      step0CompareBefore = false;
      const api = _step0Api();
      const diff = api && typeof api.classifyAdjustDiff === 'function'
        ? api.classifyAdjustDiff(step0CommittedAdjust, step0DraftAdjust)
        : { hasAnyChange: false, toneChanged: false, geometryChanged: false };

      if (!diff.hasAnyChange) {
        await _reloadBakedViewForCurrentPhoto(pid, seqToken, findPhotoMeta(pid), true, false);
        setStep(nextStep);
        return true;
      }

      const maskCount = editor ? (editor.plates.length + editor.faces.length) : 0;
      let maskAction = 'keep';
      if (diff.geometryChanged && maskCount > 0) {
        const choice = await _openStep0MaskImpactModal();
        if (choice === 'cancel' || seqToken !== loadReqSeq) {
          return false;
        }
        maskAction = choice;
      } else if (diff.geometryChanged && maskCount === 0 && cfg.autoDetectOnOpen) {
        maskAction = 'redetect';
      }

      step0Busy = true;
      updateFooterButtonsUI();
      try {
        const prevRot = step0CommittedAdjust ? step0CommittedAdjust.rotation : 0;
        const updatedMeta = await _persistStep0Adjustments(pid, step0DraftAdjust);
        if (seqToken !== loadReqSeq) return false;
        const fxApi = _effectApi();
        if (fxApi && cfg.effect && prevRot !== updatedMeta.rotation) {
          const moved = fxApi.transformSpotByRotation(cfg.effect.cx, cfg.effect.cy, prevRot, updatedMeta.rotation);
          cfg.effect.cx = moved.cx;
          cfg.effect.cy = moved.cy;
        }
        const preserve = maskAction === 'keep';
        const redetect = maskAction === 'redetect';
        await _reloadBakedViewForCurrentPhoto(pid, seqToken, updatedMeta, preserve, redetect);
        if (diff.toneChanged && !diff.geometryChanged && maskCount > 0) {
          toast('トーン調整を反映しました（マスク位置を維持）', 'success', 2600);
        } else if (redetect && maskCount > 0) {
          toast('調整を保存し、新しい構図でAIマスクを再検出しています', 'info', 2800);
        } else if (diff.geometryChanged && preserve && maskCount > 0) {
          toast('調整を保存しました（1. 修正でマスク位置をご確認ください）', 'info', 3000);
        } else {
          toast('非破壊調整を反映しました', 'success', 2200);
        }
        setStep(nextStep);
        return true;
      } catch (err) {
        console.error('[ART_FRAMER] Step 0 保存エラー:', err);
        toast(`調整の保存に失敗しました: ${err.message || err}`, 'error');
        return false;
      } finally {
        step0Busy = false;
        updateFooterButtonsUI();
        _syncStep0FormUI();
      }
    }

    setStep(nextStep);
    if (nextStep === 0 && pid) {
      step0CompareBefore = false;
      _syncStep0FormUI();
      _ensureStep0RawImage(pid, seqToken);
    }
    return true;
  }

  function setStep(stepNum) {
    const disabled = _isEffectStepDisabled();
    let parsed = Math.max(0, Math.min(4, Number(stepNum)));
    if (disabled && parsed === 2) parsed = 3;
    cfg.step = parsed;
    if (!modalEl) return;

    syncEffectStepVisibilityUI();
    modalEl.querySelectorAll('.af-step-tab').forEach((tab) => {
      tab.classList.toggle('active', parseInt(tab.dataset.step, 10) === cfg.step);
    });

    const p0 = document.getElementById('afStep0Panel');
    const p1 = document.getElementById('afStep1Panel');
    const p2 = document.getElementById('afStep2Panel');
    const p3 = document.getElementById('afStep3Panel');
    const p4 = document.getElementById('afStep4Panel');
    if (p0) p0.style.display = cfg.step === 0 ? 'flex' : 'none';
    if (p1) p1.style.display = cfg.step === 1 ? 'flex' : 'none';
    if (p2) p2.style.display = (cfg.step === 2 && !disabled) ? 'flex' : 'none';
    if (p3) p3.style.display = cfg.step === 3 ? 'flex' : 'none';
    if (p4) p4.style.display = cfg.step === 4 ? 'flex' : 'none';

    const zoomBar = document.getElementById('afMaskZoomToolbar');
    if (zoomBar) zoomBar.style.display = (cfg.step === 0 || cfg.step === 1 || cfg.step === 2) ? 'flex' : 'none';
    const focusBtn = document.getElementById('afZoomFocusBtn');
    if (focusBtn) focusBtn.style.display = cfg.step === 1 ? 'inline-flex' : 'none';
    const loupeWrap = document.getElementById('afLoupeCheck')?.closest('.af-inline-check');
    if (loupeWrap) loupeWrap.style.display = cfg.step === 1 ? 'inline-flex' : 'none';
    const cleanBtn = document.getElementById('afHoldCleanBtn');
    if (cleanBtn) {
      cleanBtn.style.display = (cfg.step === 1 || cfg.step === 2) ? 'inline-flex' : 'none';
      cleanBtn.textContent = cfg.step === 2 ? '枠線を隠す' : '枠線を隠して確認';
    }

    updateFooterButtonsUI();
    updateStep3SummaryUI();
    pushDecoratorToEditor();
  }

  function updateFooterButtonsUI() {
    if (!modalEl) return;
    const total = photoQueue.length;
    const isLastPhoto = queueIndex >= total - 1;
    const remaining = Math.max(0, total - queueIndex);
    const locked = isBusy || step0Busy;
    const disabled = _isEffectStepDisabled();
    const api = _effectApi();
    const dispStep = (s) => (api ? api.getDisplayStepNumber(s, disabled) : s);

    const prevStepBtn = document.getElementById('afPrevStepBtn');
    const nextStepBtn = document.getElementById('afNextStepBtn');
    const quickExportBtn = document.getElementById('afQuickExportBtn');
    const skipPhotoBtn = document.getElementById('afSkipPhotoBtn');
    const batchRestBtn = document.getElementById('afBatchRestBtn');

    if (prevStepBtn) {
      prevStepBtn.disabled = locked || cfg.step <= 0;
      prevStepBtn.textContent = cfg.step === 1 ? '← 0. 調整' : '← 戻る';
    }
    if (skipPhotoBtn) {
      skipPhotoBtn.style.display = total > 1 ? 'inline-flex' : 'none';
      skipPhotoBtn.disabled = locked;
      skipPhotoBtn.textContent = isLastPhoto ? 'この写真をスキップして終了' : 'この写真をスキップ ▶';
    }
    if (batchRestBtn) {
      batchRestBtn.style.display = (total > 1 && remaining > 1 && cfg.step >= 3) ? 'inline-flex' : 'none';
      batchRestBtn.disabled = locked;
      batchRestBtn.textContent = `残り ${remaining} 枚を一括出力 (マスクなし)`;
    }

    const actionText = isLastPhoto
      ? (total > 1 ? `最後の1枚を出力して完了 (${queueIndex + 1}/${total})` : 'この写真を書き出す')
      : `この1枚を出力して次へ (${queueIndex + 1}/${total}) ▶`;

    if (cfg.step === 0) {
      if (nextStepBtn) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.disabled = locked;
        nextStepBtn.textContent = '調整を反映して 1. 修正へ →';
      }
      if (quickExportBtn) quickExportBtn.style.display = 'none';
    } else if (cfg.step === 1) {
      if (nextStepBtn) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.disabled = locked;
        nextStepBtn.textContent = disabled
          ? `次へ：${dispStep(3)}. 額装 →`
          : `次へ：${dispStep(2)}. 演出 →`;
      }
      if (quickExportBtn) quickExportBtn.style.display = 'none';
    } else if (cfg.step === 2) {
      if (nextStepBtn) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.disabled = locked;
        nextStepBtn.textContent = `次へ：${dispStep(3)}. 額装 →`;
      }
      if (quickExportBtn) quickExportBtn.style.display = 'none';
    } else if (cfg.step === 3) {
      if (nextStepBtn) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.disabled = locked;
        nextStepBtn.textContent = `次へ：${dispStep(4)}. 出力 →`;
      }
      if (quickExportBtn) {
        quickExportBtn.style.display = 'inline-flex';
        quickExportBtn.disabled = locked;
        quickExportBtn.textContent = actionText;
      }
    } else {
      if (nextStepBtn) nextStepBtn.style.display = 'none';
      if (quickExportBtn) {
        quickExportBtn.style.display = 'inline-flex';
        quickExportBtn.disabled = locked;
        quickExportBtn.textContent = actionText;
      }
    }
  }

  function updateStep3SummaryUI() {
    const presetBadge = document.getElementById('afSummaryPresetVal');
    const dimBadge = document.getElementById('afSummaryDimVal');
    const maskBadge = document.getElementById('afSummaryMaskVal');
    const effectBadge = document.getElementById('afSummaryEffectVal');
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
    if (effectBadge) {
      const fxApi = _effectApi();
      effectBadge.textContent = _isEffectStepDisabled()
        ? '未使用（設定でOFF）'
        : (fxApi ? fxApi.formatEffectSummary(cfg.effect) : 'なし');
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

    step0CommittedAdjust = _normalizeAdjust(meta);
    step0DraftAdjust = { ...step0CommittedAdjust };
    step0RawImg = null;
    step0RawPhotoId = 0;
    step0RawLoading = false;
    step0CompareBefore = false;
    step0Busy = false;
    _closeStep0MaskImpactModal('cancel');
    _syncStep0FormUI();

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
      lens_effect: _getEffectiveLensEffectPayload(),
      watermark: cfg.watermark.enabled ? {
        enabled: true,
        type: cfg.watermark.type,
        text: cfg.watermark.text,
        asset_id: cfg.watermark.asset_id || '',
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
    _resetEffectForSession();
    await ensureDefaultDestination();
    await loadWatermarkAssets();

    photoQueue = ids;
    queueIndex = 0;
    exportedCount = 0;
    lastExportedDir = '';
    isBusy = false;
    isPickingFolder = false;
    isAfBackdropPointerDown = false;
    const pickBtn = document.getElementById('afPickDirBtn');
    if (pickBtn) {
      pickBtn.disabled = false;
      pickBtn.textContent = '選択...';
    }

    modalEl.style.display = 'flex';
    applyTargetPreset(presetKey || 'for_x');
    await loadCurrentQueuePhoto();
  }

  async function closeArtFramerModal(force = false) {
    if (!modalEl) return;
    if (!force && isPickingFolder) {
      toast('フォルダ選択ダイアログが開いています', 'info');
      return;
    }
    if (!force && (isBusy || step0Busy)) return;
    loadReqSeq += 1;
    step0CompareBefore = false;
    _closeStep0MaskImpactModal('cancel');
    modalEl.style.display = 'none';
  }

  async function pickDestFolder() {
    if (isPickingFolder || isBusy) return;
    const btn = document.getElementById('afPickDirBtn');
    isPickingFolder = true;
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '表示中...';
      }
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
      isPickingFolder = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '選択...';
      }
    }
  }

  function _selectWatermarkAsset(asset) {
    if (!asset) {
      cfg.watermark.asset_id = '';
      cfg.watermark.image_url = '';
      cfg.watermark.image_name = '';
      cfg.watermark.image_path = '';
      cfg.watermark.preview_data_url = '';
      return;
    }
    cfg.watermark.asset_id = asset.id;
    cfg.watermark.image_url = asset.image_url || `/api/watermarks/${asset.id}/image`;
    cfg.watermark.image_name = asset.name || 'logo.png';
    cfg.watermark.image_path = '';
    cfg.watermark.preview_data_url = '';
  }

  function renderWatermarkAssetGallery() {
    const container = document.getElementById('afWmAssetList');
    if (!container) return;
    container.textContent = '';

    if (!watermarkAssets.length) {
      const empty = document.createElement('div');
      empty.className = 'af-wm-asset-empty';
      empty.textContent = '登録済みロゴがありません。「＋ ロゴを追加」から透過PNG等を登録できます。';
      container.appendChild(empty);
      return;
    }

    watermarkAssets.forEach((asset) => {
      const isSel = cfg.watermark.asset_id === asset.id;
      const card = document.createElement('div');
      card.className = `af-wm-asset-card${isSel ? ' is-selected' : ''}`;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.title = `${asset.name} (${asset.width}×${asset.height})`;

      const thumb = document.createElement('div');
      thumb.className = 'af-wm-asset-thumb';
      const img = document.createElement('img');
      img.src = asset.image_url || `/api/watermarks/${asset.id}/image`;
      img.alt = asset.name || 'logo';
      img.loading = 'lazy';
      thumb.appendChild(img);

      const nameEl = document.createElement('div');
      nameEl.className = 'af-wm-asset-name';
      nameEl.textContent = asset.name || 'logo.png';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'af-wm-asset-del';
      delBtn.title = 'このロゴを削除';
      delBtn.setAttribute('aria-label', `${asset.name || 'ロゴ'}を削除`);
      delBtn.textContent = '×';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteWatermarkAssetById(asset);
      });

      const onSelect = () => {
        _selectWatermarkAsset(asset);
        cfg.watermark.enabled = true;
        cfg.watermark.type = 'image';
        if (cfg.watermark.size_ratio < 0.03) {
          cfg.watermark.size_ratio = 0.16;
        }
        syncFormFromState();
        pushDecoratorToEditor();
        updateStep3SummaryUI();
        saveSettings();
      };
      card.addEventListener('click', onSelect);
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onSelect();
        }
      });

      card.appendChild(thumb);
      card.appendChild(nameEl);
      card.appendChild(delBtn);
      container.appendChild(card);
    });
  }

  async function loadWatermarkAssets() {
    try {
      const res = await fetch('/api/watermarks');
      if (!res.ok) return;
      const d = await res.json();
      watermarkAssets = Array.isArray(d.watermarks) ? d.watermarks : [];
      const currentHit = watermarkAssets.find((a) => a.id === cfg.watermark.asset_id);
      if (currentHit) {
        _selectWatermarkAsset(currentHit);
      } else if (watermarkAssets.length > 0) {
        _selectWatermarkAsset(watermarkAssets[0]);
      } else if (!cfg.watermark.image_path) {
        _selectWatermarkAsset(null);
      }
      renderWatermarkAssetGallery();
    } catch (e) {
      console.warn('[ART_FRAMER] ウォーターマーク一覧取得スキップ:', e);
    }
  }

  async function uploadLogoFile(file) {
    if (!file) return;
    const btn = document.getElementById('afPickWmLogoBtn');
    try {
      if (btn) btn.disabled = true;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/watermarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name || 'logo.png', data_url: dataUrl }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(d.detail || 'ロゴ画像の登録に失敗しました', 'warning');
        return;
      }
      watermarkAssets = Array.isArray(d.watermarks) ? d.watermarks : watermarkAssets;
      if (d.asset) {
        _selectWatermarkAsset(d.asset);
        cfg.watermark.enabled = true;
        cfg.watermark.type = 'image';
        if (cfg.watermark.size_ratio < 0.03) cfg.watermark.size_ratio = 0.16;
      }
      syncFormFromState();
      pushDecoratorToEditor();
      updateStep3SummaryUI();
      saveSettings();
      toast(`ロゴ「${(d.asset && d.asset.name) || file.name}」を登録しました`, 'success');
    } catch (e) {
      toast('ロゴ画像の登録に失敗しました', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function deleteWatermarkAssetById(asset) {
    if (!asset || !asset.id) return;
    let ok = true;
    if (typeof window.showConfirmModal === 'function') {
      ok = await window.showConfirmModal({
        title: 'ロゴ画像の削除',
        subtitle: '登録済みウォーターマークの削除',
        headingPrefix: '登録済みロゴ',
        targetName: asset.name || asset.id,
        headingSuffix: 'を削除しますか？',
        confirmText: '削除する',
        cancelText: 'キャンセル',
        confirmVariant: 'danger',
      });
    }
    if (!ok) return;
    try {
      const res = await fetch(`/api/watermarks/${encodeURIComponent(asset.id)}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(d.detail || 'ロゴの削除に失敗しました', 'error');
        return;
      }
      watermarkAssets = Array.isArray(d.watermarks) ? d.watermarks : [];
      if (cfg.watermark.asset_id === asset.id) {
        _selectWatermarkAsset(watermarkAssets[0] || null);
      }
      syncFormFromState();
      pushDecoratorToEditor();
      saveSettings();
      toast('ロゴを削除しました', 'info');
    } catch (e) {
      toast('ロゴの削除に失敗しました', 'error');
    }
  }

  function pickLogoImage() {
    const fileInput = document.getElementById('afWmFileInput');
    if (fileInput) {
      fileInput.value = '';
      fileInput.click();
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
      onEffectSpotChange: (spot, isLiveDrag) => {
        if (!cfg.effect) return;
        if (spot.cx !== undefined) cfg.effect.cx = spot.cx;
        if (spot.cy !== undefined) cfg.effect.cy = spot.cy;
        if (spot.radius !== undefined) {
          cfg.effect.radius = spot.radius;
          const rPct = Math.round(spot.radius * 100);
          const rSl = document.getElementById('afEffectRadiusSlider');
          const rLb = document.getElementById('afEffectRadiusVal');
          if (rSl) rSl.value = String(rPct);
          if (rLb) rLb.textContent = `${rPct}%`;
        }
        if (!isLiveDrag) updateStep3SummaryUI();
      },
    });

    // 閉じる・Esc
    document.getElementById('closeArtFramerBtn')?.addEventListener('click', () => closeArtFramerModal(false));
    modalEl.addEventListener('pointerdown', (e) => {
      isAfBackdropPointerDown = (e.target === modalEl);
    });
    modalEl.addEventListener('click', (e) => {
      const startedOnBackdrop = isAfBackdropPointerDown;
      isAfBackdropPointerDown = false;
      if (startedOnBackdrop && e.target === modalEl) closeArtFramerModal(false);
    });
    window.addEventListener('keydown', (e) => {
      if (!modalEl || modalEl.style.display !== 'flex') return;
      const adjustModal = document.getElementById('imageAdjustModal');
      if (adjustModal && adjustModal.style.display !== 'none') return;
      const confirmModal = document.getElementById('commonConfirmModal');
      if (confirmModal && confirmModal.style.display !== 'none') return;
      const impactDlg = document.getElementById('afStep0MaskImpactDialog');
      if (impactDlg && impactDlg.style.display !== 'none') {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          _closeStep0MaskImpactModal('cancel');
        }
        return;
      }
      if (e.key === 'Escape') {
        if (isPickingFolder) return;
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
      tab.addEventListener('click', () => requestStepChange(parseInt(tab.dataset.step, 10)));
    });
    document.getElementById('afPrevStepBtn')?.addEventListener('click', () => {
      const api = _effectApi();
      const prev = api ? api.getPrevStep(cfg.step, _isEffectStepDisabled()) : cfg.step - 1;
      requestStepChange(prev);
    });
    document.getElementById('afNextStepBtn')?.addEventListener('click', () => {
      const api = _effectApi();
      const next = api ? api.getNextStep(cfg.step, _isEffectStepDisabled()) : cfg.step + 1;
      requestStepChange(next);
    });
    document.getElementById('afQuickExportBtn')?.addEventListener('click', exportCurrentAndAdvance);
    document.getElementById('afSkipPhotoBtn')?.addEventListener('click', skipCurrentPhoto);
    document.getElementById('afBatchRestBtn')?.addEventListener('click', exportRemainingBatchWithoutMasks);

    window.addEventListener('tetheract:af-effect-step-pref-change', () => {
      if (!modalEl) return;
      syncEffectControlsUI();
      if (_isEffectStepDisabled() && cfg.step === 2) {
        setStep(1);
      } else {
        updateFooterButtonsUI();
        updateStep3SummaryUI();
        pushDecoratorToEditor();
      }
    });

    // Step 2: 演出（レンズ効果）イベント
    const refreshEffectPreview = () => {
      syncEffectControlsUI();
      updateStep3SummaryUI();
      pushDecoratorToEditor();
    };
    modalEl.querySelectorAll('.af-effect-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.effectPreset;
        const api = _effectApi();
        const preset = api && api.EFFECT_PRESETS ? api.EFFECT_PRESETS[key] : null;
        if (!preset) return;
        cfg.effect.presetKey = preset.key;
        cfg.effect.bokeh_mode = preset.bokeh_mode;
        cfg.effect.strength = preset.strength;
        cfg.effect.specular = preset.specular;
        if (preset.radius !== undefined) cfg.effect.radius = preset.radius;
        if (preset.feather !== undefined) cfg.effect.feather = preset.feather;
        cfg.effect.vignette = preset.vignette;
        cfg.effect.halation = preset.halation;
        refreshEffectPreview();
      });
    });
    document.getElementById('afEffectSpotResetBtn')?.addEventListener('click', () => {
      if (!cfg.effect) return;
      cfg.effect.cx = 0.50;
      cfg.effect.cy = 0.50;
      cfg.effect.radius = 0.32;
      cfg.effect.feather = 0.36;
      refreshEffectPreview();
    });
    document.getElementById('afEffectBokehSelect')?.addEventListener('change', (e) => {
      cfg.effect.bokeh_mode = e.target.value;
      cfg.effect.presetKey = 'custom';
      if (cfg.effect.bokeh_mode !== 'none' && cfg.effect.strength < 0.05) {
        cfg.effect.strength = 0.58;
      }
      refreshEffectPreview();
    });
    const bindEffectPctSlider = (id, key, scale = 0.01, defaultModeWhenPositive = null) => {
      document.getElementById(id)?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) * scale;
        cfg.effect[key] = val;
        cfg.effect.presetKey = 'custom';
        if (defaultModeWhenPositive && val > 0.02 && cfg.effect.bokeh_mode === 'none') {
          cfg.effect.bokeh_mode = defaultModeWhenPositive;
        }
        refreshEffectPreview();
      });
    };
    bindEffectPctSlider('afEffectStrengthSlider', 'strength', 0.01, 'swirl');
    bindEffectPctSlider('afEffectSpecularSlider', 'specular', 0.01);
    bindEffectPctSlider('afEffectRadiusSlider', 'radius', 0.01);
    bindEffectPctSlider('afEffectFeatherSlider', 'feather', 0.01);
    bindEffectPctSlider('afEffectVignetteSlider', 'vignette', 0.01);
    bindEffectPctSlider('afEffectHalationSlider', 'halation', 0.01);

    // Step 0 幾何変更影響確認ダイアログ
    document.getElementById('afImpactRedetectBtn')?.addEventListener('click', () => _closeStep0MaskImpactModal('redetect'));
    document.getElementById('afImpactKeepBtn')?.addEventListener('click', () => _closeStep0MaskImpactModal('keep'));
    document.getElementById('afImpactCancelBtn')?.addEventListener('click', () => _closeStep0MaskImpactModal('cancel'));

    // Step 0: 非破壊調整コントロール
    const applyStep0DraftChange = () => {
      _syncStep0FormUI();
      _renderStep0Preview();
    };
    document.getElementById('afRotLeftBtn')?.addEventListener('click', () => {
      if (!step0DraftAdjust || step0Busy) return;
      step0DraftAdjust.rotation = (((Number(step0DraftAdjust.rotation || 0) - 90) % 360) + 360) % 360;
      applyStep0DraftChange();
    });
    document.getElementById('afRotRightBtn')?.addEventListener('click', () => {
      if (!step0DraftAdjust || step0Busy) return;
      step0DraftAdjust.rotation = (((Number(step0DraftAdjust.rotation || 0) + 90) % 360) + 360) % 360;
      applyStep0DraftChange();
    });
    document.getElementById('afStep0GridCheck')?.addEventListener('change', (e) => {
      step0ShowGrid = e.target.checked;
      pushDecoratorToEditor();
    });
    const cmpBtn = document.getElementById('afStep0CompareBtn');
    if (cmpBtn) {
      cmpBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        step0CompareBefore = true;
        _syncStep0FormUI();
        _renderStep0Preview();
        pushDecoratorToEditor();
      });
      window.addEventListener('pointerup', () => {
        if (!step0CompareBefore) return;
        step0CompareBefore = false;
        _syncStep0FormUI();
        _renderStep0Preview();
        pushDecoratorToEditor();
      });
    }
    document.getElementById('afOpenCropModalBtn')?.addEventListener('click', () => {
      const pid = photoQueue[queueIndex];
      if (!pid || typeof window.openImageAdjustModal !== 'function') return;
      const meta = findPhotoMeta(pid);
      const prevMasks = editor ? (editor.plates.length + editor.faces.length) : 0;
      window.openImageAdjustModal(meta, {
        initialDraft: step0DraftAdjust ? { ...step0DraftAdjust } : null,
        onApplied: async (updatedPhoto) => {
          if (!updatedPhoto) return;
          const nextSnap = _normalizeAdjust(updatedPhoto);
          const api = _step0Api();
          const diff = api ? api.classifyAdjustDiff(step0CommittedAdjust, nextSnap) : { geometryChanged: true };
          step0CommittedAdjust = { ...nextSnap };
          step0DraftAdjust = { ...nextSnap };
          _syncStep0FormUI();
          if (diff.geometryChanged && prevMasks > 0) {
            const choice = await _openStep0MaskImpactModal();
            await _reloadBakedViewForCurrentPhoto(pid, loadReqSeq, updatedPhoto, choice === 'keep', choice === 'redetect');
            setStep(1);
          } else {
            await _reloadBakedViewForCurrentPhoto(pid, loadReqSeq, updatedPhoto, true, diff.geometryChanged && cfg.autoDetectOnOpen);
            if (cfg.step === 0) _renderStep0Preview();
          }
        },
      });
    });

    document.getElementById('afStep0TiltSlider')?.addEventListener('input', (e) => {
      if (!step0DraftAdjust) return;
      const v = Number(e.target.value || 0);
      step0DraftAdjust.fine_angle = Math.abs(v) <= 0.01 ? 0.0 : Number(v.toFixed(2));
      applyStep0DraftChange();
    });
    document.getElementById('afStep0ExpSlider')?.addEventListener('input', (e) => {
      if (!step0DraftAdjust) return;
      const api = _step0Api();
      const idx = parseInt(e.target.value, 10) || 0;
      step0DraftAdjust.brightness = api ? api.dialIndexToBrightness(idx) : idx * 3;
      applyStep0DraftChange();
    });
    document.getElementById('afStep0ConSlider')?.addEventListener('input', (e) => {
      if (!step0DraftAdjust) return;
      step0DraftAdjust.contrast = Math.max(-100, Math.min(100, parseInt(e.target.value, 10) || 0));
      applyStep0DraftChange();
    });
    document.getElementById('afStep0SatSlider')?.addEventListener('input', (e) => {
      if (!step0DraftAdjust) return;
      step0DraftAdjust.saturation = Math.max(-100, Math.min(100, parseInt(e.target.value, 10) || 0));
      applyStep0DraftChange();
    });
    modalEl.querySelectorAll('.af-step0-nudge-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (!step0DraftAdjust) return;
        const key = btn.dataset.step0Nudge;
        const rawDelta = Number(btn.dataset.delta || 0);
        const mult = e.shiftKey ? 5 : 1;
        const api = _step0Api();
        if (key === 'brightness' && api) {
          const curIdx = api.brightnessToDialIndex(step0DraftAdjust.brightness);
          const nextIdx = Math.max(-6, Math.min(6, curIdx + Math.sign(rawDelta)));
          step0DraftAdjust.brightness = api.dialIndexToBrightness(nextIdx);
        } else if (key === 'fine_angle') {
          const v = Math.max(-15, Math.min(15, Number(step0DraftAdjust.fine_angle || 0) + rawDelta * mult));
          step0DraftAdjust.fine_angle = Math.abs(v) <= 0.01 ? 0.0 : Number(v.toFixed(2));
        } else if (key === 'contrast' || key === 'saturation') {
          step0DraftAdjust[key] = Math.max(-100, Math.min(100, Math.round(Number(step0DraftAdjust[key] || 0) + rawDelta * mult)));
        }
        applyStep0DraftChange();
      });
    });
    document.getElementById('afStep0CopyToneBtn')?.addEventListener('click', () => {
      const pid = photoQueue[queueIndex];
      if (!pid || !step0DraftAdjust) return;
      const meta = findPhotoMeta(pid);
      if (typeof window.copyPhotoToneAdjustments === 'function') {
        window.copyPhotoToneAdjustments({ ...meta, ...step0DraftAdjust });
        _syncStep0FormUI();
      }
    });
    document.getElementById('afStep0PasteToneBtn')?.addEventListener('click', () => {
      if (!step0DraftAdjust) return;
      const copied = typeof window.getCopiedToneAdjustments === 'function' ? window.getCopiedToneAdjustments() : null;
      if (!copied) return;
      step0DraftAdjust.brightness = Math.round(Number(copied.brightness || 0));
      step0DraftAdjust.contrast = Math.round(Number(copied.contrast || 0));
      step0DraftAdjust.saturation = Math.round(Number(copied.saturation || 0));
      applyStep0DraftChange();
      toast('コピーしたトーン調整をプレビューに反映しました', 'info', 2200);
    });
    document.getElementById('afStep0RevertBtn')?.addEventListener('click', () => {
      if (!step0CommittedAdjust) return;
      step0DraftAdjust = { ...step0CommittedAdjust };
      applyStep0DraftChange();
      toast('未反映の変更を元に戻しました', 'info', 2000);
    });
    document.getElementById('afStep0ResetAllBtn')?.addEventListener('click', () => {
      const api = _step0Api();
      step0DraftAdjust = api ? api.createResetAdjustSnapshot() : _normalizeAdjust(null);
      applyStep0DraftChange();
      toast('調整値を初期化しました（「1. 修正へ」等で反映）', 'info', 2400);
    });

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
    document.getElementById('afWmClearBtn')?.addEventListener('click', () => {
      cfg.watermark.enabled = false;
      syncFormFromState();
      pushDecoratorToEditor();
      updateStep3SummaryUI();
      saveSettings();
    });
    document.getElementById('afWmTypeSelect')?.addEventListener('change', (e) => {
      cfg.watermark.type = e.target.value;
      cfg.watermark.size_ratio = cfg.watermark.type === 'image' ? 0.16 : 0.018;
      if (cfg.watermark.type === 'image' && !cfg.watermark.asset_id && watermarkAssets.length > 0) {
        _selectWatermarkAsset(watermarkAssets[0]);
      }
      syncFormFromState();
      pushDecoratorToEditor();
      saveSettings();
    });
    document.getElementById('afWmTextInput')?.addEventListener('input', (e) => {
      cfg.watermark.type = 'text';
      cfg.watermark.text = e.target.value;
      pushDecoratorToEditor();
    });
    document.getElementById('afWmTextInput')?.addEventListener('change', saveSettings);
    document.getElementById('afWmColorSelect')?.addEventListener('change', (e) => {
      applyWmTextStyle(cfg.watermark, e.target.value);
      pushDecoratorToEditor();
      saveSettings();
    });
    document.getElementById('afPickWmLogoBtn')?.addEventListener('click', pickLogoImage);
    document.getElementById('afWmFileInput')?.addEventListener('change', (e) => {
      const file = e.target && e.target.files ? e.target.files[0] : null;
      if (file) uploadLogoFile(file);
    });
    modalEl.querySelectorAll('.af-wm-pos-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pos = btn.dataset.pos;
        if (cfg.watermark.enabled && cfg.watermark.position === pos) {
          cfg.watermark.enabled = false;
        } else {
          cfg.watermark.enabled = true;
          cfg.watermark.position = pos;
        }
        syncFormFromState();
        pushDecoratorToEditor();
        updateStep3SummaryUI();
        saveSettings();
      });
    });
    document.getElementById('afWmOpacitySlider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.watermark.opacity = v / 100;
      const lbl = document.getElementById('afWmOpacityVal');
      if (lbl) lbl.textContent = `${v}%`;
      pushDecoratorToEditor();
    });
    document.getElementById('afWmOpacitySlider')?.addEventListener('change', saveSettings);
    document.getElementById('afWmSizeSlider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.watermark.size_ratio = v / 100;
      const lbl = document.getElementById('afWmSizeVal');
      if (lbl) {
        lbl.textContent = cfg.watermark.type === 'image' ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
      }
      pushDecoratorToEditor();
    });
    document.getElementById('afWmSizeSlider')?.addEventListener('change', saveSettings);

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
    document.getElementById('afDestInput')?.addEventListener('change', (e) => {
      cfg.output.destination = e.target.value.trim();
      saveSettings();
    });
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
