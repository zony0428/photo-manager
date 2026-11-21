/**
 * Tetheract Touch & Mobile Art Framer Controller (Layer 3)
 *
 * モバイル / Android (`TETHERACT ld`) 向けの3ステップコンベア型 Art Framer:
 * 1. プライバシーマスク (ナンバープレート4頂点枠・顔モヤ放射スタンプ・800%無劣化ズーム & ×3.5指先ルーペ)
 * 2. プリント枠・EXIFキャプション・ウォーターマーク (PC版と完全互換の描画＆設定共有)
 * 3. SNSプリセット出力 (`for X` / `for INSTA 4:5` / `for INSTA 1:1` / `Full Size`)、
 *    ギャラリー保存・OS共有・母艦自動スタック用 `thmod_` 収納キュー連携
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'photo_manager_art_framer_options_v1';

  let modalEl = null;
  let editor = null;
  let photoQueue = [];
  let queueIndex = 0;
  let exportedCount = 0;
  let isBusy = false;
  let loadReqSeq = 0;
  let backHandlerRegistered = false;

  const cfg = {
    artPreset: 'for_x',
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
    },
  };

  let watermarkAssets = [];
  let pendingDeleteWmId = '';
  let pendingDeleteWmTimer = null;

  function _showToast(msg, durationMs = 2800) {
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

  function _loadSavedSettings() {
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed.autoDetectOnOpen === 'boolean') cfg.autoDetectOnOpen = parsed.autoDetectOnOpen;
      if (typeof parsed.detectPlates === 'boolean') cfg.detectPlates = parsed.detectPlates;
      if (typeof parsed.detectFaces === 'boolean') cfg.detectFaces = parsed.detectFaces;
      if (typeof parsed.plateFeather === 'number' && !isNaN(parsed.plateFeather)) {
        cfg.plateFeather = Math.max(0, Math.min(1, parsed.plateFeather));
      }
      if (typeof parsed.faceStyle === 'string' && parsed.faceStyle) cfg.faceStyle = parsed.faceStyle;
      if (typeof parsed.faceRadius === 'number' && !isNaN(parsed.faceRadius)) {
        cfg.faceRadius = Math.max(0.015, Math.min(0.35, parsed.faceRadius));
      }
      if (typeof parsed.faceStrength === 'number' && !isNaN(parsed.faceStrength)) {
        cfg.faceStrength = Math.max(0.4, Math.min(1.0, parsed.faceStrength));
      }
      if (parsed.frame && typeof parsed.frame === 'object') {
        Object.assign(cfg.frame, parsed.frame);
      }
      if (parsed.watermark && typeof parsed.watermark === 'object') {
        Object.assign(cfg.watermark, parsed.watermark);
      }
      if (parsed.output && typeof parsed.output === 'object') {
        Object.assign(cfg.output, parsed.output);
        if (!cfg.output.naming_rule || cfg.output.naming_rule === 'original' || cfg.output.naming_rule === 'mod_original') {
          cfg.output.naming_rule = 'thmod_original';
        }
      }
    } catch (err) {
      console.warn('[TOUCH_ART_FRAMER] 設定読込スキップ:', err);
    }
  }

  function _saveSettings() {
    try {
      const wmToSave = {
        ...cfg.watermark,
        image_url: String(cfg.watermark.image_url || '').startsWith('data:') ? '' : (cfg.watermark.image_url || ''),
        preview_data_url: '',
      };
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
        watermark: wmToSave,
        output: cfg.output,
      };
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn('[TOUCH_ART_FRAMER] 設定保存スキップ:', err);
    }
  }

  function _buildModalHtml() {
    return `
      <div class="t-af-dialog" role="dialog" aria-modal="true" aria-labelledby="mAfTitle">
        <div class="t-af-header">
          <button type="button" id="mAfCloseBtn" class="t-af-icon-btn" aria-label="閉じる">✕</button>
          <div class="t-af-title-block">
            <div class="t-af-title-row">
              <span id="mAfTitle" class="t-af-title-main">Art Framer</span>
              <span id="mAfQueueCounterBadge" class="t-af-counter-badge">1 / 1</span>
            </div>
            <div id="mAfCurrentFileName" class="t-af-filename">photo.jpg</div>
          </div>
          <div class="t-af-header-nav">
            <button type="button" id="mAfPrevPhotoBtn" class="t-af-nav-mini-btn" aria-label="前の写真" title="前の写真">◀</button>
            <button type="button" id="mAfNextPhotoBtn" class="t-af-nav-mini-btn" aria-label="次の写真" title="次の写真">▶</button>
          </div>
        </div>

        <div class="t-af-preset-bar">
          <button type="button" class="t-af-preset-pill active" data-preset="for_x">for X</button>
          <button type="button" class="t-af-preset-pill" data-preset="for_insta">for INSTA 4:5</button>
          <button type="button" class="t-af-preset-pill" data-preset="for_insta_sq">for INSTA 1:1</button>
          <button type="button" class="t-af-preset-pill" data-preset="full_size">Full Size</button>
          <span id="mAfLiveDimBadge" class="t-af-dim-badge">--</span>
        </div>

        <div class="t-af-step-tabs" role="tablist">
          <button type="button" class="t-af-step-tab active" data-step="1">1. マスク</button>
          <button type="button" class="t-af-step-tab" data-step="2">2. 枠・透かし</button>
          <button type="button" class="t-af-step-tab" data-step="3">3. 出力・共有</button>
        </div>

        <div class="t-af-workspace">
          <div class="t-af-canvas-pane">
            <div id="mAfZoomToolbar" class="t-af-zoom-toolbar">
              <div class="t-af-zoom-group">
                <button type="button" id="mAfZoomOutBtn" class="t-af-zoom-btn" aria-label="縮小">-</button>
                <span id="mAfZoomPctBadge" class="t-af-zoom-pct">100%</span>
                <button type="button" id="mAfZoomInBtn" class="t-af-zoom-btn" aria-label="拡大">+</button>
                <button type="button" id="mAfZoomFitBtn" class="t-af-mini-btn">全体</button>
                <button type="button" id="mAfZoomFocusBtn" class="t-af-mini-btn is-accent">選択枠</button>
              </div>
              <div class="t-af-zoom-group">
                <label class="t-af-check-mini">
                  <input type="checkbox" id="mAfLoupeCheck" checked>
                  <span>ルーペ</span>
                </label>
                <button type="button" id="mAfHoldCleanBtn" class="t-af-mini-btn">枠隠す</button>
              </div>
            </div>
            <div class="t-af-canvas-wrap">
              <canvas id="mAfCanvas" class="t-af-canvas"></canvas>
            </div>
          </div>

          <div class="t-af-controls-pane">
            <!-- Step 1: プライバシーマスク -->
            <div id="mAfStep1Panel" class="t-af-step-panel">
              <div class="t-af-card">
                <div class="t-af-card-head">
                  <span class="t-af-card-title">操作モード（親指タップ切替）</span>
                  <button type="button" id="mAfRunDetectBtn" class="t-af-mini-btn is-accent">AI自動検出</button>
                </div>
                <div id="mAfDetectProgressWrap" class="t-af-progress-wrap" style="display:none;">
                  <div id="mAfDetectProgressBar" class="t-af-progress-bar">
                    <div id="mAfDetectProgressFill" class="t-af-progress-fill" style="width:0%;"></div>
                  </div>
                  <span id="mAfDetectProgressPct" class="t-af-progress-pct">0%</span>
                </div>
                <div id="mAfDetectStatusText" class="t-af-note-line">四つ角・スタンプ・移動でマスクを編集できます</div>
                <div class="t-af-seg-grid3">
                  <button type="button" class="t-af-tool-btn active" data-mode="edit">四つ角・移動</button>
                  <button type="button" class="t-af-tool-btn" data-mode="stamp">顔モヤ貼付</button>
                  <button type="button" class="t-af-tool-btn" data-mode="pan">画面移動</button>
                </div>
                <div class="t-af-btn-row">
                  <button type="button" id="mAfAddPlateBtn" class="t-af-btn">＋ ナンバー枠</button>
                  <button type="button" id="mAfDeleteMaskBtn" class="t-af-btn" disabled>選択削除</button>
                  <button type="button" id="mAfClearMasksBtn" class="t-af-btn">全消去</button>
                </div>
                <div id="mAfMaskItemList" class="t-af-mask-pills"></div>
              </div>

              <div class="t-af-card">
                <div class="t-af-card-head">
                  <span class="t-af-card-title">ナンバー枠スタイル・色</span>
                  <select id="mAfPlateStyleSelect" class="t-af-select-sm">
                    <option value="solid">カラー塗り</option>
                    <option value="blur">すりガラス強ぼかし</option>
                    <option value="mosaic">モザイク</option>
                  </select>
                </div>
                <div class="t-af-color-row">
                  <button type="button" class="t-af-color-swatch" data-color="#F4F6F9" style="background:#F4F6F9;" aria-label="白"></button>
                  <button type="button" class="t-af-color-swatch" data-color="#1A1D24" style="background:#1A1D24;" aria-label="黒"></button>
                  <button type="button" class="t-af-color-swatch" data-color="#525B69" style="background:#525B69;" aria-label="グレー"></button>
                  <button type="button" class="t-af-color-swatch" data-color="#EAB308" style="background:#EAB308;" aria-label="黄色"></button>
                  <input type="color" id="mAfCustomPlateColor" value="#F4F6F9" class="t-af-color-picker">
                  <button type="button" id="mAfEyedropBtn" class="t-af-mini-btn">スポイト</button>
                </div>
                <label class="t-af-slider-row">
                  <span>境界なじみ</span>
                  <input type="range" id="mAfPlateFeatherSlider" min="0" max="100" step="5" value="45">
                  <span id="mAfPlateFeatherVal" class="t-af-slider-val">45%</span>
                </label>
              </div>

              <div class="t-af-card">
                <div class="t-af-card-head">
                  <span class="t-af-card-title">顔モヤスタンプ質感・サイズ</span>
                  <select id="mAfHazeStyleSelect" class="t-af-select-sm">
                    <option value="frosted">自然すりガラス</option>
                    <option value="milky">白モヤ</option>
                    <option value="smoke">スモークモヤ</option>
                  </select>
                </div>
                <label class="t-af-slider-row">
                  <span>半径</span>
                  <input type="range" id="mAfStampRadiusSlider" min="1.5" max="15.0" step="0.3" value="5.2">
                  <span id="mAfStampRadiusVal" class="t-af-slider-val">5.2%</span>
                </label>
                <label class="t-af-slider-row">
                  <span>濃さ</span>
                  <input type="range" id="mAfStampStrengthSlider" min="40" max="100" step="2" value="92">
                  <span id="mAfStampStrengthVal" class="t-af-slider-val">92%</span>
                </label>
              </div>
            </div>

            <!-- Step 2: プリント枠・透かし -->
            <div id="mAfStep2Panel" class="t-af-step-panel" style="display:none;">
              <div class="t-af-card">
                <label class="t-af-toggle-head">
                  <input type="checkbox" id="mAfFrameEnableCheck" checked>
                  <span>プリント枠・EXIFキャプションを付ける</span>
                </label>
                <div id="mAfFrameControlsBody" class="t-af-subblock">
                  <div class="t-af-seg-grid4">
                    <button type="button" class="t-af-layout-btn active" data-layout="classic">Classic</button>
                    <button type="button" class="t-af-layout-btn" data-layout="editorial">Editorial</button>
                    <button type="button" class="t-af-layout-btn" data-layout="polaroid">Instant</button>
                    <button type="button" class="t-af-layout-btn" data-layout="border_only">枠のみ</button>
                  </div>
                  <div class="t-af-field-grid2">
                    <label class="t-af-field-col">
                      <span>台紙カラー</span>
                      <select id="mAfMatteSelect" class="t-af-select-sm">
                        <option value="white">白 (White)</option>
                        <option value="paper">和紙 (Paper)</option>
                        <option value="sumi">夜墨 (Sumi)</option>
                        <option value="charcoal">チャコール</option>
                      </select>
                    </label>
                    <label class="t-af-field-col">
                      <span>SNS台紙比率</span>
                      <select id="mAfAspectSelect" class="t-af-select-sm">
                        <option value="original">元比率を維持</option>
                        <option value="1:1">1:1 正方形</option>
                        <option value="4:5">4:5 縦長</option>
                        <option value="16:9">16:9 横長</option>
                      </select>
                    </label>
                  </div>
                  <div class="t-af-checks-wrap">
                    <label class="t-af-check-mini"><input type="checkbox" id="mAfInnerBorderCheck" checked><span>極細内枠</span></label>
                    <label class="t-af-check-mini"><input type="checkbox" id="mAfPhotoShadowCheck"><span>落とし影</span></label>
                  </div>
                  <details id="mAfFrameSizeExpander" class="t-af-expander">
                    <summary class="t-af-expander-summary">
                      <span class="t-af-expander-title">余白幅・文字サイズ</span>
                      <span class="t-af-expander-right">
                        <span id="mAfFrameSizeSummary" class="t-af-expander-meta">5.0% · 100%</span>
                        <svg class="t-af-expander-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                      </span>
                    </summary>
                    <div class="t-af-expander-body">
                      <label class="t-af-slider-row">
                        <span>余白幅</span>
                        <input type="range" id="mAfBorderSlider" min="1.5" max="15.0" step="0.5" value="5.0">
                        <span id="mAfBorderVal" class="t-af-slider-val">5.0%</span>
                      </label>
                      <label class="t-af-slider-row">
                        <span>文字サイズ</span>
                        <input type="range" id="mAfFontScaleSlider" min="70" max="140" step="5" value="100">
                        <span id="mAfFontScaleVal" class="t-af-slider-val">100%</span>
                      </label>
                    </div>
                  </details>
                  <details id="mAfCaptionFieldsExpander" class="t-af-expander">
                    <summary class="t-af-expander-summary">
                      <span class="t-af-expander-title">表示項目</span>
                      <span class="t-af-expander-right">
                        <span id="mAfCaptionFieldsSummary" class="t-af-expander-meta">機種・レンズ・露出</span>
                        <svg class="t-af-expander-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                      </span>
                    </summary>
                    <div class="t-af-expander-body">
                      <div id="mAfCaptionFieldsGroup" class="t-af-checks-wrap">
                        <label class="t-af-check-mini"><input type="checkbox" id="mAfShowCameraCheck" checked><span>カメラ機種</span></label>
                        <label class="t-af-check-mini"><input type="checkbox" id="mAfShowLensCheck" checked><span>レンズ名</span></label>
                        <label class="t-af-check-mini"><input type="checkbox" id="mAfShowExposureCheck" checked><span>露出設定</span></label>
                        <label class="t-af-check-mini"><input type="checkbox" id="mAfShowDateCheck"><span>撮影日</span></label>
                        <label class="t-af-check-mini"><input type="checkbox" id="mAfShowLocationCheck"><span>撮影地</span></label>
                        <label class="t-af-check-mini"><input type="checkbox" id="mAfShowNoteCheck"><span>メモ</span></label>
                      </div>
                    </div>
                  </details>
                  <div id="mAfCustomNoteRow" style="display:none;">
                    <input type="text" id="mAfCustomNoteInput" class="t-af-input" placeholder="キャプション右端に表示する一言...">
                  </div>
                </div>
              </div>

              <div class="t-af-card">
                <label class="t-af-toggle-head">
                  <input type="checkbox" id="mAfWmEnableCheck">
                  <span>ウォーターマーク（透かし）を入れる</span>
                </label>
                <div id="mAfWmControlsBody" class="t-af-subblock">
                  <div class="t-af-seg-grid2">
                    <button type="button" class="t-af-wm-type-btn active" data-wm-type="text">テキスト</button>
                    <button type="button" class="t-af-wm-type-btn" data-wm-type="image">画像ロゴ (透過PNG)</button>
                  </div>
                  <div id="mAfWmTextGroup" class="t-af-subblock" style="gap:8px;">
                    <div class="t-af-field-grid2">
                      <input type="text" id="mAfWmTextInput" class="t-af-input" value="© 2026" placeholder="© Author">
                      <select id="mAfWmColorSelect" class="t-af-select-sm">
                        <option value="light">白文字 (Shadow)</option>
                        <option value="dark">黒文字 (Light)</option>
                      </select>
                    </div>
                    <div class="t-af-checks-wrap">
                      <label class="t-af-check-mini"><input type="checkbox" id="mAfWmShadowCheck" checked><span>ドロップシャドウ</span></label>
                    </div>
                  </div>
                  <div id="mAfWmImageGroup" class="t-af-subblock" style="display:none; gap:8px;">
                    <div class="t-af-wm-gallery-head">
                      <span id="mAfWmImageNameLabel" class="t-af-wm-name-label">未選択</span>
                      <button type="button" id="mAfWmAddLogoBtn" class="t-af-mini-btn">＋ ロゴを追加</button>
                      <input type="file" id="mAfWmFileInput" accept="image/png,image/webp,image/jpeg" style="display:none;">
                    </div>
                    <div id="mAfWmAssetList" class="t-af-wm-asset-grid"></div>
                  </div>
                  <div class="t-af-seg-grid3">
                    <button type="button" class="t-af-wm-pos-btn" data-pos="top-left">左上</button>
                    <button type="button" class="t-af-wm-pos-btn" data-pos="top-right">右上</button>
                    <button type="button" class="t-af-wm-pos-btn" data-pos="bottom-left">左下</button>
                    <button type="button" class="t-af-wm-pos-btn" data-pos="bottom-center">中央下</button>
                    <button type="button" class="t-af-wm-pos-btn active" data-pos="bottom-right">右下</button>
                    <button type="button" class="t-af-wm-pos-btn" data-pos="center">中央</button>
                  </div>
                  <label class="t-af-slider-row">
                    <span id="mAfWmSizeLabel">文字サイズ</span>
                    <input type="range" id="mAfWmSizeSlider" min="0.8" max="6.0" step="0.2" value="1.8">
                    <span id="mAfWmSizeVal" class="t-af-slider-val">1.8%</span>
                  </label>
                  <label class="t-af-slider-row">
                    <span>不透明度</span>
                    <input type="range" id="mAfWmOpacitySlider" min="10" max="100" step="2" value="58">
                    <span id="mAfWmOpacityVal" class="t-af-slider-val">58%</span>
                  </label>
                </div>
              </div>
            </div>

            <!-- Step 3: 出力・共有・母艦キュー -->
            <div id="mAfStep3Panel" class="t-af-step-panel" style="display:none;">
              <div class="t-af-card">
                <div class="t-af-card-title">仕上がりサマリ</div>
                <div class="t-af-summary-grid">
                  <div class="t-af-summary-row"><span>プリセット</span><strong id="mAfSummaryPresetVal">for X</strong></div>
                  <div class="t-af-summary-row"><span>出力解像度</span><strong id="mAfSummaryDimVal">--</strong></div>
                  <div class="t-af-summary-row"><span>マスク</span><strong id="mAfSummaryMaskVal">なし</strong></div>
                  <div class="t-af-summary-row"><span>枠・透かし</span><strong id="mAfSummaryFrameVal">枠ON</strong></div>
                </div>
              </div>

              <div class="t-af-card">
                <div class="t-af-card-title">ファイル名・画質・安全設定</div>
                <label class="t-af-field-col">
                  <span>ファイル名規則</span>
                  <select id="mAfNamingSelect" class="t-af-select-sm">
                    <option value="thmod_original">thmod_&lt;元ファイル名&gt; (母艦自動スタック推奨)</option>
                    <option value="framed">&lt;元ファイル名&gt;_framed</option>
                  </select>
                </label>
                <div class="t-af-field-grid2">
                  <label class="t-af-field-col">
                    <span>保存形式</span>
                    <select id="mAfFormatSelect" class="t-af-select-sm">
                      <option value="jpeg">JPEG (SNS推奨)</option>
                      <option value="png">PNG (高画質)</option>
                    </select>
                  </label>
                  <div class="t-af-field-col" id="mAfQualityCol">
                    <span>JPEG画質 (<strong id="mAfQualityVal">92%</strong>)</span>
                    <input type="range" id="mAfQualitySlider" min="65" max="100" step="1" value="92">
                  </div>
                </div>
                <label class="t-af-check-mini" style="padding:4px 0;">
                  <input type="checkbox" id="mAfExifRemoveAllCheck">
                  <span id="mAfExifPrivacyLabel">すべてのEXIFを完全消去（OFF時: GPS・シリアルのみ消去し撮影日時・機種名で母艦自動スタック対応）</span>
                </label>
                <div class="t-af-note-line" id="mAfOutputDestHint">
                  端末ギャラリー (Pictures/Tetheract) と母艦収納キューへ保存され、次回「母艦に収納」時に元写真と自動スタックされます。
                </div>
              </div>

              <div class="t-af-export-actions">
                <button type="button" id="mAfSaveAndShareBtn" class="t-af-action-btn is-primary">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                  <span>保存してSNS共有</span>
                </button>
                <button type="button" id="mAfSaveQueueBtn" class="t-af-action-btn is-secondary">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  <span id="mAfSaveQueueBtnLabel">保存 (母艦収納キューへ)</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="t-af-footer">
          <button type="button" id="mAfPrevStepBtn" class="t-af-btn" disabled>← 戻る</button>
          <button type="button" id="mAfSkipPhotoBtn" class="t-af-btn" style="display:none;">スキップ ▶</button>
          <button type="button" id="mAfNextStepBtn" class="t-af-btn is-primary">次へ：枠・透かし →</button>
        </div>
      </div>
    `;
  }

  function _getActivePresetPillKey() {
    if (cfg.artPreset === 'for_insta') {
      return cfg.frame.aspect_mode === '1:1' ? 'for_insta_sq' : 'for_insta';
    }
    if (cfg.artPreset === 'full_size') return 'full_size';
    return 'for_x';
  }

  function _resolveActiveWatermarkLogoUrl() {
    if (cfg.watermark.asset_id) {
      const hit = watermarkAssets.find((a) => a.id === cfg.watermark.asset_id);
      if (hit && hit.image_url) return hit.image_url;
    }
    return cfg.watermark.image_url || cfg.watermark.preview_data_url || '';
  }

  function _selectWatermarkAsset(asset) {
    if (!asset) {
      cfg.watermark.asset_id = '';
      cfg.watermark.image_url = '';
      cfg.watermark.image_name = '';
      cfg.watermark.preview_data_url = '';
      return;
    }
    cfg.watermark.asset_id = asset.id;
    cfg.watermark.image_url = asset.image_url || '';
    cfg.watermark.image_name = asset.name || 'logo.png';
    cfg.watermark.preview_data_url = '';
  }

  function _renderWatermarkAssetGallery() {
    const container = document.getElementById('mAfWmAssetList');
    if (!container) return;
    container.textContent = '';

    if (!watermarkAssets.length) {
      const empty = document.createElement('div');
      empty.className = 't-af-wm-asset-empty';
      empty.textContent = 'ロゴ未登録。「＋ ロゴを追加」から透過PNGを登録できます。';
      container.appendChild(empty);
      return;
    }

    watermarkAssets.forEach((asset) => {
      const isSel = cfg.watermark.asset_id === asset.id;
      const isPendingDel = pendingDeleteWmId === asset.id;
      const card = document.createElement('div');
      card.className = `t-af-wm-asset-card${isSel ? ' is-selected' : ''}`;
      card.setAttribute('role', 'button');
      card.tabIndex = 0;

      const thumb = document.createElement('div');
      thumb.className = 't-af-wm-asset-thumb';
      const img = document.createElement('img');
      img.src = asset.image_url || '';
      img.alt = asset.name || 'logo';
      img.loading = 'lazy';
      thumb.appendChild(img);

      const nameEl = document.createElement('div');
      nameEl.className = 't-af-wm-asset-name';
      nameEl.textContent = asset.name || 'logo.png';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = `t-af-wm-asset-del${isPendingDel ? ' is-confirm' : ''}`;
      delBtn.setAttribute('aria-label', `${asset.name || 'ロゴ'}を削除`);
      delBtn.textContent = isPendingDel ? '削除?' : '×';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (pendingDeleteWmId !== asset.id) {
          pendingDeleteWmId = asset.id;
          clearTimeout(pendingDeleteWmTimer);
          pendingDeleteWmTimer = setTimeout(() => {
            pendingDeleteWmId = '';
            _renderWatermarkAssetGallery();
          }, 2600);
          _renderWatermarkAssetGallery();
          return;
        }
        clearTimeout(pendingDeleteWmTimer);
        pendingDeleteWmId = '';
        _deleteWatermarkAsset(asset);
      });

      card.addEventListener('click', () => {
        pendingDeleteWmId = '';
        _selectWatermarkAsset(asset);
        cfg.watermark.type = 'image';
        if (cfg.watermark.size_ratio < 0.03) cfg.watermark.size_ratio = 0.16;
        _syncFormFromState();
        _pushDecoratorToEditor();
        _saveSettings();
      });

      card.appendChild(thumb);
      card.appendChild(nameEl);
      card.appendChild(delBtn);
      container.appendChild(card);
    });
  }

  async function _loadWatermarkAssets() {
    const adapter = global.TetheractWatermarkAdapter;
    if (!adapter || typeof adapter.listWatermarks !== 'function') return;
    try {
      const res = await adapter.listWatermarks();
      watermarkAssets = Array.isArray(res && res.watermarks) ? res.watermarks : [];
      const curHit = watermarkAssets.find((a) => a.id === cfg.watermark.asset_id);
      if (curHit) {
        _selectWatermarkAsset(curHit);
      } else if (watermarkAssets.length > 0) {
        _selectWatermarkAsset(watermarkAssets[0]);
      } else {
        _selectWatermarkAsset(null);
      }
      _renderWatermarkAssetGallery();
    } catch (e) {
      console.warn('[TOUCH_ART_FRAMER] ウォーターマーク一覧取得スキップ:', e);
    }
  }

  async function _uploadWatermarkLogoFile(file) {
    if (!file) return;
    const adapter = global.TetheractWatermarkAdapter;
    if (!adapter || typeof adapter.saveWatermark !== 'function') {
      _showToast('ロゴ登録機能を利用できません');
      return;
    }
    const btn = document.getElementById('mAfWmAddLogoBtn');
    try {
      if (btn) btn.disabled = true;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        reader.readAsDataURL(file);
      });
      const res = await adapter.saveWatermark(file.name || 'logo.png', dataUrl);
      if (!res || !res.ok) {
        _showToast((res && res.error) || 'ロゴ画像の保存に失敗しました');
        return;
      }
      watermarkAssets = Array.isArray(res.watermarks) ? res.watermarks : watermarkAssets;
      if (res.asset) {
        _selectWatermarkAsset(res.asset);
        cfg.watermark.type = 'image';
        if (cfg.watermark.size_ratio < 0.03) cfg.watermark.size_ratio = 0.16;
      }
      _syncFormFromState();
      _pushDecoratorToEditor();
      _saveSettings();
      _showToast(`ロゴ「${(res.asset && res.asset.name) || file.name}」を保存しました`);
    } catch (e) {
      _showToast('ロゴ画像の登録に失敗しました');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function _deleteWatermarkAsset(asset) {
    if (!asset || !asset.id) return;
    const adapter = global.TetheractWatermarkAdapter;
    if (!adapter || typeof adapter.deleteWatermark !== 'function') return;
    try {
      const res = await adapter.deleteWatermark(asset.id);
      if (!res || !res.ok) {
        _showToast((res && res.error) || 'ロゴの削除に失敗しました');
        return;
      }
      watermarkAssets = Array.isArray(res.watermarks) ? res.watermarks : [];
      if (cfg.watermark.asset_id === asset.id) {
        _selectWatermarkAsset(watermarkAssets[0] || null);
      }
      _syncFormFromState();
      _pushDecoratorToEditor();
      _saveSettings();
      _showToast('ロゴを削除しました');
    } catch (e) {
      _showToast('ロゴの削除に失敗しました');
    }
  }

  function _pushDecoratorToEditor() {
    if (!editor) return;
    editor.setDecoratorState({
      viewMode: cfg.step === 1 ? 'mask' : 'decorated',
      frameConfig: cfg.frame,
      watermarkConfig: cfg.watermark,
      artPreset: cfg.artPreset,
      logoDataUrl: _resolveActiveWatermarkLogoUrl(),
    });
  }

  function _syncFrameExpanderSummaries() {
    const sizeSum = document.getElementById('mAfFrameSizeSummary');
    if (sizeSum) {
      const bPct = (cfg.frame.border_ratio * 100).toFixed(1);
      const fPct = Math.round((cfg.frame.font_scale || 1.0) * 100);
      sizeSum.textContent = `${bPct}% · ${fPct}%`;
    }
    const isBorderOnly = cfg.frame.layout === 'border_only';
    const capExp = document.getElementById('mAfCaptionFieldsExpander');
    if (capExp) {
      capExp.classList.toggle('is-disabled', isBorderOnly);
    }
    const capSum = document.getElementById('mAfCaptionFieldsSummary');
    if (capSum) {
      if (isBorderOnly) {
        capSum.textContent = '枠のみ';
      } else {
        const labels = [];
        if (cfg.frame.show_camera) labels.push('機種');
        if (cfg.frame.show_lens) labels.push('レンズ');
        if (cfg.frame.show_exposure) labels.push('露出');
        if (cfg.frame.show_date) labels.push('撮影日');
        if (cfg.frame.show_location) labels.push('撮影地');
        if (cfg.frame.show_note) labels.push('メモ');
        capSum.textContent = labels.length > 0 ? labels.join('・') : 'なし';
      }
    }
  }

  function _syncFormFromState() {
    if (!modalEl) return;
    const activePill = _getActivePresetPillKey();
    modalEl.querySelectorAll('.t-af-preset-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === activePill);
    });

    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el && v !== undefined && v !== null) el.value = String(v);
    };
    const setChk = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.checked = Boolean(v);
    };
    const setTxt = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };

    const pfPct = Math.round((cfg.plateFeather ?? 0.45) * 100);
    setVal('mAfPlateFeatherSlider', pfPct);
    setTxt('mAfPlateFeatherVal', `${pfPct}%`);
    setVal('mAfHazeStyleSelect', cfg.faceStyle || 'frosted');
    const frPct = ((cfg.faceRadius ?? 0.052) * 100).toFixed(1);
    setVal('mAfStampRadiusSlider', frPct);
    setTxt('mAfStampRadiusVal', `${frPct}%`);
    const fsPct = Math.round((cfg.faceStrength ?? 0.92) * 100);
    setVal('mAfStampStrengthSlider', fsPct);
    setTxt('mAfStampStrengthVal', `${fsPct}%`);

    if (editor) {
      editor.defaultPlateFeather = cfg.plateFeather ?? 0.45;
      editor.defaultHazeStyle = cfg.faceStyle || 'frosted';
      editor.defaultStampRadius = cfg.faceRadius ?? 0.052;
      editor.defaultStampStrength = cfg.faceStrength ?? 0.92;
    }

    setChk('mAfFrameEnableCheck', cfg.frame.enabled);
    document.getElementById('mAfFrameControlsBody')?.classList.toggle('is-disabled', !cfg.frame.enabled);
    modalEl.querySelectorAll('.t-af-layout-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.layout === cfg.frame.layout);
    });
    setVal('mAfMatteSelect', cfg.frame.matte);
    setVal('mAfAspectSelect', cfg.frame.aspect_mode);

    const bPct = (cfg.frame.border_ratio * 100).toFixed(1);
    setVal('mAfBorderSlider', bPct);
    setTxt('mAfBorderVal', `${bPct}%`);

    const fPct = Math.round((cfg.frame.font_scale || 1.0) * 100);
    setVal('mAfFontScaleSlider', fPct);
    setTxt('mAfFontScaleVal', `${fPct}%`);

    setChk('mAfInnerBorderCheck', cfg.frame.inner_border);
    setChk('mAfPhotoShadowCheck', cfg.frame.photo_shadow);
    setChk('mAfShowCameraCheck', cfg.frame.show_camera);
    setChk('mAfShowLensCheck', cfg.frame.show_lens);
    setChk('mAfShowExposureCheck', cfg.frame.show_exposure);
    setChk('mAfShowDateCheck', cfg.frame.show_date);
    setChk('mAfShowLocationCheck', cfg.frame.show_location);
    setChk('mAfShowNoteCheck', cfg.frame.show_note);
    setVal('mAfCustomNoteInput', cfg.frame.custom_note || '');
    const noteRow = document.getElementById('mAfCustomNoteRow');
    if (noteRow) noteRow.style.display = cfg.frame.show_note ? 'block' : 'none';
    document.getElementById('mAfCaptionFieldsGroup')?.classList.toggle('is-disabled', cfg.frame.layout === 'border_only');
    _syncFrameExpanderSummaries();

    setChk('mAfWmEnableCheck', cfg.watermark.enabled);
    document.getElementById('mAfWmControlsBody')?.classList.toggle('is-disabled', !cfg.watermark.enabled);
    const isLogo = cfg.watermark.type === 'image';
    modalEl.querySelectorAll('.t-af-wm-type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.wmType === (isLogo ? 'image' : 'text'));
    });
    const textGrp = document.getElementById('mAfWmTextGroup');
    const imgGrp = document.getElementById('mAfWmImageGroup');
    if (textGrp) textGrp.style.display = isLogo ? 'none' : 'flex';
    if (imgGrp) imgGrp.style.display = isLogo ? 'flex' : 'none';

    setVal('mAfWmTextInput', cfg.watermark.text || '');
    setVal('mAfWmColorSelect', cfg.watermark.color || 'light');
    setChk('mAfWmShadowCheck', cfg.watermark.shadow !== false);
    setTxt('mAfWmImageNameLabel', cfg.watermark.image_name || '未選択');
    modalEl.querySelectorAll('.t-af-wm-pos-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.pos === cfg.watermark.position);
    });

    const opPct = Math.round((cfg.watermark.opacity ?? 0.58) * 100);
    setVal('mAfWmOpacitySlider', opPct);
    setTxt('mAfWmOpacityVal', `${opPct}%`);

    const szRatio = isLogo
      ? Math.max(0.03, Math.min(0.50, Number(cfg.watermark.size_ratio || 0.16)))
      : Math.max(0.008, Math.min(0.06, Number(cfg.watermark.size_ratio || 0.018)));
    const szPct = isLogo ? Math.round(szRatio * 100).toString() : (szRatio * 100).toFixed(1);
    const szSlider = document.getElementById('mAfWmSizeSlider');
    if (szSlider) {
      szSlider.min = isLogo ? '3' : '0.8';
      szSlider.max = isLogo ? '50' : '6.0';
      szSlider.step = isLogo ? '1' : '0.2';
      szSlider.value = szPct;
    }
    setTxt('mAfWmSizeLabel', isLogo ? '大きさ(長辺)' : '文字サイズ');
    setTxt('mAfWmSizeVal', `${szPct}%`);
    _renderWatermarkAssetGallery();

    setVal('mAfNamingSelect', cfg.output.naming_rule === 'framed' ? 'framed' : 'thmod_original');
    setVal('mAfFormatSelect', cfg.output.format === 'png' ? 'png' : 'jpeg');
    setVal('mAfQualitySlider', cfg.output.quality || 92);
    setTxt('mAfQualityVal', `${cfg.output.quality || 92}%`);
    const qCol = document.getElementById('mAfQualityCol');
    if (qCol) qCol.style.display = cfg.output.format === 'png' ? 'none' : 'flex';
    setChk('mAfExifRemoveAllCheck', cfg.output.exif_remove_all);
  }

  function _applyTargetPreset(presetKey) {
    if (presetKey === 'for_insta_sq') {
      cfg.artPreset = 'for_insta';
      cfg.frame.enabled = true;
      cfg.frame.aspect_mode = '1:1';
      cfg.output.quality = 92;
    } else if (presetKey === 'for_insta') {
      cfg.artPreset = 'for_insta';
      cfg.frame.enabled = true;
      if (cfg.frame.aspect_mode !== '1:1') cfg.frame.aspect_mode = '4:5';
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
    _syncFormFromState();
    _pushDecoratorToEditor();
    _updateStep3SummaryUI();
  }

  function _updateFooterButtonsUI() {
    if (!modalEl) return;
    const total = photoQueue.length;
    const isLast = queueIndex >= total - 1;

    const prevPhotoBtn = document.getElementById('mAfPrevPhotoBtn');
    const nextPhotoBtn = document.getElementById('mAfNextPhotoBtn');
    if (prevPhotoBtn) prevPhotoBtn.disabled = isBusy || queueIndex <= 0;
    if (nextPhotoBtn) nextPhotoBtn.disabled = isBusy || isLast;

    const prevStepBtn = document.getElementById('mAfPrevStepBtn');
    const nextStepBtn = document.getElementById('mAfNextStepBtn');
    const skipBtn = document.getElementById('mAfSkipPhotoBtn');
    const shareBtn = document.getElementById('mAfSaveAndShareBtn');
    const saveBtn = document.getElementById('mAfSaveQueueBtn');
    const saveLabel = document.getElementById('mAfSaveQueueBtnLabel');

    if (prevStepBtn) prevStepBtn.disabled = isBusy || cfg.step === 1;
    if (skipBtn) {
      skipBtn.style.display = total > 1 ? 'inline-flex' : 'none';
      skipBtn.disabled = isBusy;
    }
    if (shareBtn) shareBtn.disabled = isBusy;
    if (saveBtn) saveBtn.disabled = isBusy;
    if (saveLabel) {
      saveLabel.textContent = !isLast && total > 1
        ? `保存して次へ (${queueIndex + 1}/${total})`
        : '保存 (母艦収納キューへ)';
    }
    if (nextStepBtn) {
      nextStepBtn.disabled = isBusy;
      if (cfg.step === 1) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.textContent = '次へ：枠・透かし →';
      } else if (cfg.step === 2) {
        nextStepBtn.style.display = 'inline-flex';
        nextStepBtn.textContent = '次へ：出力・共有 →';
      } else {
        nextStepBtn.style.display = 'none';
      }
    }
  }

  function _updateStep3SummaryUI() {
    const presetLabels = {
      for_x: 'for X (長辺最大 2048px)',
      for_insta: 'for INSTA (4:5 1080×1350)',
      for_insta_sq: 'for INSTA (1:1 1080×1080)',
      full_size: 'Full Size (高解像度維持)',
    };
    const presetEl = document.getElementById('mAfSummaryPresetVal');
    const dimEl = document.getElementById('mAfSummaryDimVal');
    const maskEl = document.getElementById('mAfSummaryMaskVal');
    const frameEl = document.getElementById('mAfSummaryFrameVal');

    if (presetEl) presetEl.textContent = presetLabels[_getActivePresetPillKey()] || 'for X';
    if (dimEl && editor) {
      const dims = editor.getEstimatedOutputDimensions();
      dimEl.textContent = dims && dims.width > 0 ? `${dims.width} × ${dims.height} px` : '--';
    }
    if (maskEl && editor) {
      const pCnt = editor.plates.length;
      const fCnt = editor.faces.length;
      maskEl.textContent = pCnt === 0 && fCnt === 0 ? 'なし' : `ナンバー:${pCnt} / 顔モヤ:${fCnt}`;
    }
    if (frameEl) {
      const parts = [cfg.frame.enabled ? `枠ON (${cfg.frame.layout})` : '枠OFF'];
      if (cfg.watermark.enabled) parts.push('透かしON');
      frameEl.textContent = parts.join(' + ');
    }
  }

  function _setStep(stepNum) {
    cfg.step = Math.max(1, Math.min(3, Number(stepNum) || 1));
    if (!modalEl) return;

    modalEl.querySelectorAll('.t-af-step-tab').forEach((tab) => {
      tab.classList.toggle('active', parseInt(tab.dataset.step, 10) === cfg.step);
    });

    const p1 = document.getElementById('mAfStep1Panel');
    const p2 = document.getElementById('mAfStep2Panel');
    const p3 = document.getElementById('mAfStep3Panel');
    if (p1) p1.style.display = cfg.step === 1 ? 'flex' : 'none';
    if (p2) p2.style.display = cfg.step === 2 ? 'flex' : 'none';
    if (p3) p3.style.display = cfg.step === 3 ? 'flex' : 'none';

    const zoomBar = document.getElementById('mAfZoomToolbar');
    if (zoomBar) zoomBar.style.display = 'flex';
    const focusBtn = document.getElementById('mAfZoomFocusBtn');
    if (focusBtn) focusBtn.style.display = cfg.step === 1 ? 'inline-flex' : 'none';
    const loupeWrap = document.getElementById('mAfLoupeCheck')?.closest('.t-af-check-mini');
    if (loupeWrap) loupeWrap.style.display = cfg.step === 1 ? 'inline-flex' : 'none';
    const cleanBtn = document.getElementById('mAfHoldCleanBtn');
    if (cleanBtn) cleanBtn.style.display = cfg.step === 1 ? 'inline-flex' : 'none';

    _updateFooterButtonsUI();
    _updateStep3SummaryUI();
    _pushDecoratorToEditor();
  }

  function _refreshMaskPillsUI(info) {
    const box = document.getElementById('mAfMaskItemList');
    const delBtn = document.getElementById('mAfDeleteMaskBtn');
    if (delBtn) delBtn.disabled = !info || !info.selected;
    if (!box) return;

    box.innerHTML = '';
    const plates = (info && info.plates) || [];
    const faces = (info && info.faces) || [];
    const sel = info && info.selected;

    if (plates.length === 0 && faces.length === 0) {
      const note = document.createElement('span');
      note.className = 't-af-note-line';
      note.textContent = 'マスクなし（「＋ナンバー枠追加」や「顔モヤ貼付」で配置できます）';
      box.appendChild(note);
      return;
    }

    plates.forEach((pl, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isAct = Boolean(sel && sel.type === 'plate' && sel.id === pl.id);
      if (isAct) {
        const stSel = document.getElementById('mAfPlateStyleSelect');
        if (stSel && pl.style) stSel.value = pl.style;
        const cIn = document.getElementById('mAfCustomPlateColor');
        if (cIn && pl.color) cIn.value = pl.color;
        const fPct = Math.round((pl.feather ?? cfg.plateFeather ?? 0.45) * 100);
        const fSl = document.getElementById('mAfPlateFeatherSlider');
        const fLb = document.getElementById('mAfPlateFeatherVal');
        if (fSl) fSl.value = String(fPct);
        if (fLb) fLb.textContent = `${fPct}%`;
      }
      btn.className = `t-af-mask-pill${isAct ? ' active' : ''}`;
      btn.textContent = `ナンバー #${i + 1}`;
      btn.addEventListener('click', () => editor?.selectAndFocusMask('plate', pl.id));
      box.appendChild(btn);
    });

    faces.forEach((fc, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isAct = Boolean(sel && sel.type === 'face' && sel.id === fc.id);
      if (isAct) {
        const hzSel = document.getElementById('mAfHazeStyleSelect');
        if (hzSel && fc.style) hzSel.value = fc.style;
        const rPct = ((fc.r ?? cfg.faceRadius ?? 0.052) * 100).toFixed(1);
        const rSl = document.getElementById('mAfStampRadiusSlider');
        const rLb = document.getElementById('mAfStampRadiusVal');
        if (rSl) rSl.value = String(rPct);
        if (rLb) rLb.textContent = `${rPct}%`;
        const sPct = Math.round((fc.strength ?? cfg.faceStrength ?? 0.92) * 100);
        const sSl = document.getElementById('mAfStampStrengthSlider');
        const sLb = document.getElementById('mAfStampStrengthVal');
        if (sSl) sSl.value = String(sPct);
        if (sLb) sLb.textContent = `${sPct}%`;
      }
      btn.className = `t-af-mask-pill is-face${isAct ? ' active' : ''}`;
      btn.textContent = `顔モヤ #${i + 1}`;
      btn.addEventListener('click', () => editor?.selectAndFocusMask('face', fc.id));
      box.appendChild(btn);
    });
  }

  let _detectProgressHideTimer = null;

  function _setDetectProgress(pct, statusText = null) {
    clearTimeout(_detectProgressHideTimer);
    const wrap = document.getElementById('mAfDetectProgressWrap');
    const fill = document.getElementById('mAfDetectProgressFill');
    const pctEl = document.getElementById('mAfDetectProgressPct');
    const statusEl = document.getElementById('mAfDetectStatusText');
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    if (wrap) wrap.style.display = 'flex';
    if (fill) fill.style.width = `${clamped}%`;
    if (pctEl) pctEl.textContent = `${clamped}%`;
    if (statusText !== null && statusEl) statusEl.textContent = statusText;
  }

  function _hideDetectProgress(delayMs = 0) {
    clearTimeout(_detectProgressHideTimer);
    const wrap = document.getElementById('mAfDetectProgressWrap');
    if (!wrap) return;
    if (delayMs <= 0) {
      wrap.style.display = 'none';
      return;
    }
    _detectProgressHideTimer = setTimeout(() => {
      const el = document.getElementById('mAfDetectProgressWrap');
      if (el) el.style.display = 'none';
    }, delayMs);
  }

  function _nextPaintYield() {
    return new Promise((resolve) => setTimeout(resolve, 16));
  }

  function _orderPtsCwJs(pts) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i += 1) {
      cx += pts[i].x;
      cy += pts[i].y;
    }
    cx /= pts.length;
    cy /= pts.length;
    const cw = pts
      .map((p) => ({ x: p.x, y: p.y, ang: Math.atan2(p.y - cy, p.x - cx) }))
      .sort((a, b) => a.ang - b.ang)
      .map((p) => ({ x: p.x, y: p.y }));
    const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    const len01_23 = 0.5 * (d(cw[0], cw[1]) + d(cw[2], cw[3]));
    const len12_30 = 0.5 * (d(cw[1], cw[2]) + d(cw[3], cw[0]));
    let out = cw;
    if (len12_30 > len01_23 * 1.03) {
      out = [cw[1], cw[2], cw[3], cw[0]];
    }
    const midY01 = 0.5 * (out[0].y + out[1].y);
    const midY23 = 0.5 * (out[2].y + out[3].y);
    if (midY01 > midY23) {
      out = [out[2], out[3], out[0], out[1]];
    }
    return out;
  }

  function _boxBlurSeparable(src, w, h, rad) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const rowPref = new Float32Array(w + 1);
    for (let y = 0; y < h; y += 1) {
      const rowOff = y * w;
      rowPref[0] = 0;
      for (let x = 0; x < w; x += 1) {
        rowPref[x + 1] = rowPref[x] + src[rowOff + x];
      }
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.max(0, x - rad);
        const x1 = Math.min(w, x + rad + 1);
        tmp[rowOff + x] = (rowPref[x1] - rowPref[x0]) / Math.max(1, x1 - x0);
      }
    }
    const colPref = new Float32Array(h + 1);
    for (let x = 0; x < w; x += 1) {
      colPref[0] = 0;
      for (let y = 0; y < h; y += 1) {
        colPref[y + 1] = colPref[y] + tmp[y * w + x];
      }
      for (let y = 0; y < h; y += 1) {
        const y0 = Math.max(0, y - rad);
        const y1 = Math.min(h, y + rad + 1);
        out[y * w + x] = (colPref[y1] - colPref[y0]) / Math.max(1, y1 - y0);
      }
    }
    return out;
  }

  function _morphDilate3(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y += 1) {
      const r = y * w;
      for (let x = 1; x < w - 1; x += 1) {
        const i = r + x;
        if (
          mask[i] ||
          mask[i - 1] || mask[i + 1] ||
          mask[i - w] || mask[i - w - 1] || mask[i - w + 1] ||
          mask[i + w] || mask[i + w - 1] || mask[i + w + 1]
        ) {
          out[i] = 1;
        }
      }
    }
    return out;
  }

  function _morphErode3(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y += 1) {
      const r = y * w;
      for (let x = 1; x < w - 1; x += 1) {
        const i = r + x;
        if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) {
          out[i] = 1;
        }
      }
    }
    return out;
  }

  function _extractBlobs8(mask, w, h, minPx, maxPx) {
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    const blobs = [];
    for (let idx = 0; idx < w * h; idx += 1) {
      if (!mask[idx] || visited[idx]) continue;
      visited[idx] = 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = idx;
      let minX = w;
      let maxX = 0;
      let minY = h;
      let maxY = 0;
      while (head < tail) {
        const cur = queue[head++];
        const cy = (cur / w) | 0;
        const cx = cur - cy * w;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const y0 = cy > 0 ? cy - 1 : 0;
        const y1 = cy + 1 < h ? cy + 1 : h - 1;
        const x0 = cx > 0 ? cx - 1 : 0;
        const x1 = cx + 1 < w ? cx + 1 : w - 1;
        for (let ny = y0; ny <= y1; ny += 1) {
          const row = ny * w;
          for (let nx = x0; nx <= x1; nx += 1) {
            const ni = row + nx;
            if (mask[ni] && !visited[ni]) {
              visited[ni] = 1;
              queue[tail++] = ni;
            }
          }
        }
      }
      if (tail >= minPx && tail <= maxPx) {
        const xs = new Float32Array(tail);
        const ys = new Float32Array(tail);
        for (let k = 0; k < tail; k += 1) {
          const p = queue[k];
          const py = (p / w) | 0;
          xs[k] = p - py * w;
          ys[k] = py;
        }
        blobs.push({ xs, ys, count: tail, minX, maxX, minY, maxY });
      }
    }
    return blobs;
  }

  function _fitMinAreaQuadJs(xs, ys, count) {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < count; i += 1) {
      mx += xs[i];
      my += ys[i];
    }
    mx /= count;
    my /= count;

    // -42度〜+42度を1度刻みで全点走査し、最小面積外接長方形を求める
    const step = count > 600 ? Math.max(1, Math.floor(count / 450)) : 1;
    let bestArea = Infinity;
    let bestCa = 1;
    let bestSa = 0;
    for (let deg = -42; deg <= 42; deg += 1) {
      const rad = (deg * Math.PI) / 180;
      const ca = Math.cos(rad);
      const sa = Math.sin(rad);
      let uMin = Infinity;
      let uMax = -Infinity;
      let vMin = Infinity;
      let vMax = -Infinity;
      for (let i = 0; i < count; i += step) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        const u = ca * dx + sa * dy;
        const v = -sa * dx + ca * dy;
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      }
      const area = Math.max(1, uMax - uMin + 1) * Math.max(1, vMax - vMin + 1);
      if (area < bestArea) {
        bestArea = area;
        bestCa = ca;
        bestSa = sa;
      }
    }

    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = 0; i < count; i += 1) {
      const dx = xs[i] - mx;
      const dy = ys[i] - my;
      const u = bestCa * dx + bestSa * dy;
      const v = -bestSa * dx + bestCa * dy;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const bw = Math.max(1, u1 - u0 + 1);
    const bh = Math.max(1, v1 - v0 + 1);
    const ux = bestCa;
    const uy = bestSa;
    const vx = -bestSa;
    const vy = bestCa;
    const quad = _orderPtsCwJs([
      { x: mx + ux * u0 + vx * v0, y: my + uy * u0 + vy * v0 },
      { x: mx + ux * u1 + vx * v0, y: my + uy * u1 + vy * v0 },
      { x: mx + ux * u1 + vx * v1, y: my + uy * u1 + vy * v1 },
      { x: mx + ux * u0 + vx * v1, y: my + uy * u0 + vy * v1 },
    ]);
    return { quad, bw, bh, rectFill: count / Math.max(1, bw * bh) };
  }

  function _percentileJs(arr, pct) {
    if (!arr || !arr.length) return 0;
    const sorted = Array.from(arr).sort((a, b) => a - b);
    const pos = ((sorted.length - 1) * Math.max(0, Math.min(100, pct))) / 100;
    const lo = Math.floor(pos);
    const hi = Math.min(sorted.length - 1, lo + 1);
    const frac = pos - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
  }

  function _medianArray(arr) {
    return _percentileJs(arr, 50);
  }

  function _quadIsWellFormedJs(ptsPx, minSinAngle = 0.58, minOppRatio = 0.56) {
    const ordered = _orderPtsCwJs(ptsPx);
    const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    const lens = [
      d(ordered[0], ordered[1]),
      d(ordered[1], ordered[2]),
      d(ordered[2], ordered[3]),
      d(ordered[3], ordered[0]),
    ];
    if (Math.min(...lens) <= 1e-4) return false;
    if (Math.min(lens[0], lens[2]) / Math.max(lens[0], lens[2]) < minOppRatio) return false;
    if (Math.min(lens[1], lens[3]) / Math.max(lens[1], lens[3]) < minOppRatio) return false;

    let posCount = 0;
    let negCount = 0;
    for (let k = 0; k < 4; k += 1) {
      const prev = ordered[(k + 3) % 4];
      const cur = ordered[k];
      const next = ordered[(k + 1) % 4];
      const e1x = cur.x - prev.x;
      const e1y = cur.y - prev.y;
      const e2x = next.x - cur.x;
      const e2y = next.y - cur.y;
      const n1 = Math.hypot(e1x, e1y);
      const n2 = Math.hypot(e2x, e2y);
      if (n1 <= 1e-4 || n2 <= 1e-4) return false;
      const crossZ = e1x * e2y - e1y * e2x;
      if (Math.abs(crossZ) / (n1 * n2) < minSinAngle) return false;
      if (crossZ >= 0) posCount += 1;
      else negCount += 1;
    }
    return posCount === 4 || negCount === 4;
  }

  function _hasPlateSignatureJs(rgba, w, h, normQuad, requireFourSide, extraStrict) {
    const rawPx = normQuad.map((p) => ({ x: p.x * w, y: p.y * h }));
    const pts = _orderPtsCwJs(rawPx);
    const vecWx = 0.5 * ((pts[1].x - pts[0].x) + (pts[2].x - pts[3].x));
    const vecWy = 0.5 * ((pts[1].y - pts[0].y) + (pts[2].y - pts[3].y));
    const vecHx = 0.5 * ((pts[3].x - pts[0].x) + (pts[2].x - pts[1].x));
    const vecHy = 0.5 * ((pts[3].y - pts[0].y) + (pts[2].y - pts[1].y));
    const pw = Math.hypot(vecWx, vecWy);
    const ph = Math.hypot(vecHx, vecHy);
    if (pw < 12 || ph < 8) return { ok: false, score: 0 };

    const ux = vecWx / pw;
    const uy = vecWy / pw;
    let vx = -uy;
    let vy = ux;
    if (vx * vecHx + vy * vecHy < 0) {
      vx = -vx;
      vy = -vy;
    }
    const cx = 0.25 * (pts[0].x + pts[1].x + pts[2].x + pts[3].x);
    const cy = 0.25 * (pts[0].y + pts[1].y + pts[2].y + pts[3].y);

    const nu = 84;
    const nv = 44;
    const pR = new Float32Array(nu * nv);
    const pG = new Float32Array(nu * nv);
    const pB = new Float32Array(nu * nv);
    const pLum = new Float32Array(nu * nv);

    for (let iv = 0; iv < nv; iv += 1) {
      const vv = (-0.66 + (1.32 * iv) / (nv - 1)) * ph;
      for (let iu = 0; iu < nu; iu += 1) {
        const uu = (-0.92 + (1.84 * iu) / (nu - 1)) * pw;
        const sx = Math.max(0, Math.min(w - 1, Math.round(cx + uu * ux + vv * vx)));
        const sy = Math.max(0, Math.min(h - 1, Math.round(cy + uu * uy + vv * vy)));
        const off = (sy * w + sx) * 4;
        const idx = iv * nu + iu;
        const r = rgba[off];
        const g = rgba[off + 1];
        const b = rgba[off + 2];
        pR[idx] = r;
        pG[idx] = g;
        pB[idx] = b;
        pLum[idx] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
    }

    const cu0 = Math.floor(nu * 0.27);
    const cu1 = Math.floor(nu * 0.73);
    const cv0 = Math.floor(nv * 0.20);
    const cv1 = Math.floor(nv * 0.80);
    const cw = Math.max(1, cu1 - cu0);
    const ch = Math.max(1, cv1 - cv0);
    const coreLum = new Float32Array(cw * ch);
    let k = 0;
    for (let r = cv0; r < cv1; r += 1) {
      for (let c = cu0; c < cu1; c += 1) {
        coreLum[k++] = pLum[r * nu + c];
      }
    }
    const baseLum = _percentileJs(coreLum, 85);
    const darkInk = _percentileJs(coreLum, 5);
    const dynRange = baseLum - darkInk;
    if (baseLum < 95 || dynRange < (extraStrict ? 70 : 60)) {
      return { ok: false, score: 0 };
    }

    const leftOut = [];
    const rightOut = [];
    const uL = Math.floor(nu * 0.19);
    const uR = Math.floor(nu * 0.81);
    for (let r = cv0; r < cv1; r += 1) {
      for (let c = 0; c < uL; c += 1) leftOut.push(pLum[r * nu + c]);
      for (let c = uR; c < nu; c += 1) rightOut.push(pLum[r * nu + c]);
    }
    const topOut = [];
    const botOut = [];
    for (let c = cu0; c < cu1; c += 1) {
      for (let r = 0; r < 5; r += 1) topOut.push(pLum[r * nu + c]);
      for (let r = nv - 5; r < nv; r += 1) botOut.push(pLum[r * nu + c]);
    }
    const leftMed = _medianArray(leftOut);
    const rightMed = _medianArray(rightOut);
    const topMed = _medianArray(topOut);
    const botMed = _medianArray(botOut);
    if (requireFourSide) {
      const minSideGap = extraStrict ? 38 : 30;
      if (baseLum - leftMed < minSideGap || baseLum - rightMed < minSideGap) {
        return { ok: false, score: 0 };
      }
      const maxTbGap = Math.max(baseLum - topMed, baseLum - botMed);
      const minTbGap = Math.min(baseLum - topMed, baseLum - botMed);
      if (maxTbGap < 36 || minTbGap < (extraStrict ? 28 : 16)) {
        return { ok: false, score: 0 };
      }
    }

    const brightCut = _percentileJs(coreLum, 58);
    let bCnt = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumR2 = 0;
    let sumG2 = 0;
    let sumB2 = 0;
    for (let r = cv0; r < cv1; r += 1) {
      for (let c = cu0; c < cu1; c += 1) {
        const idx = r * nu + c;
        if (pLum[idx] >= brightCut) {
          const rr = pR[idx];
          const gg = pG[idx];
          const bb = pB[idx];
          bCnt += 1;
          sumR += rr;
          sumG += gg;
          sumB += bb;
          sumR2 += rr * rr;
          sumG2 += gg * gg;
          sumB2 += bb * bb;
        }
      }
    }
    if (bCnt > 4) {
      const stdR = Math.sqrt(Math.max(0, sumR2 / bCnt - (sumR / bCnt) ** 2));
      const stdG = Math.sqrt(Math.max(0, sumG2 / bCnt - (sumG / bCnt) ** 2));
      const stdB = Math.sqrt(Math.max(0, sumB2 / bCnt - (sumB / bCnt) ** 2));
      if ((stdR + stdG + stdB) / 3 > 24) return { ok: false, score: 0 };
    }

    const inkThr = baseLum - Math.max(26, dynRange * 0.35);
    let inkTotal = 0;
    const midR = Math.max(2, Math.floor(ch * 0.44));
    let topInk = 0;
    let botInk = 0;
    const colInks = new Float32Array(cw);
    const rowInks = new Float32Array(ch);
    const stepThr = Math.max(18, dynRange * 0.22);
    let topSharp = 0;
    let botSharp = 0;

    for (let r = 0; r < ch; r += 1) {
      for (let c = 0; c < cw; c += 1) {
        const lumVal = coreLum[r * cw + c];
        const isInk = lumVal < inkThr ? 1 : 0;
        inkTotal += isInk;
        colInks[c] += isInk;
        rowInks[r] += isInk;
        if (r < midR) topInk += isInk;
        else botInk += isInk;
        if (c > 0 && Math.abs(lumVal - coreLum[r * cw + c - 1]) >= stepThr) {
          if (r < midR) topSharp += 1;
          else botSharp += 1;
        }
      }
    }

    const totalPx = cw * ch;
    const inkRatio = inkTotal / Math.max(1, totalPx);
    if (inkRatio < 0.032 || inkRatio > 0.44) return { ok: false, score: 0 };

    const cStart = cw > 12 ? 4 : 0;
    const cEnd = cw > 12 ? cw - 4 : cw;
    for (let c = cStart; c < cEnd; c += 1) {
      if (colInks[c] / ch > 0.85) return { ok: false, score: 0 };
    }

    const topInkRatio = topInk / Math.max(1, midR * cw);
    const botInkRatio = botInk / Math.max(1, (ch - midR) * cw);
    if (topInkRatio < 0.015 || botInkRatio < 0.020) {
      return { ok: false, score: 0 };
    }

    const sepR0 = Math.max(1, Math.floor(ch * 0.28));
    const sepR1 = Math.min(ch - 1, Math.max(2, Math.floor(ch * 0.58)));
    let minSepRow = 1;
    for (let r = sepR0; r < sepR1; r += 1) {
      minSepRow = Math.min(minSepRow, rowInks[r] / cw);
    }
    if (minSepRow > 0.36) return { ok: false, score: 0 };

    const sharpTopRatio = topSharp / Math.max(1, midR * Math.max(1, cw - 1));
    const sharpBotRatio = botSharp / Math.max(1, (ch - midR) * Math.max(1, cw - 1));
    if (sharpBotRatio < 0.030) return { ok: false, score: 0 };
    if (sharpTopRatio < 0.022 && !(topInkRatio >= 0.055 && sharpBotRatio >= 0.080 && minSepRow <= 0.16)) {
      return { ok: false, score: 0 };
    }

    const sideGap = Math.min(baseLum - leftMed, baseLum - rightMed);
    const score = Math.min(0.86, 0.65 + Math.min(0.21, Math.max(0, sideGap) / 280));
    return { ok: true, score };
  }

  /** 左右外側の暗枠・グリル輝度差プロファイルからプレート4頂点を精密検出する */
  function _snapBySideGrilleContrastJs(roiLum, sw, sh, cxS, cyS, hwS, hhS, plateLum) {
    const my0 = Math.max(0, Math.round(cyS - hhS * 0.50));
    const my1 = Math.min(sh, Math.max(my0 + 4, Math.round(cyS + hhS * 0.50)));
    if (my1 - my0 < 4 || sw < 20) return null;

    const colP85 = new Float32Array(sw);
    for (let x = 0; x < sw; x += 1) {
      const col = [];
      for (let y = my0; y < my1; y += 1) col.push(roiLum[y * sw + x]);
      colP85[x] = _percentileJs(col, 85);
    }
    const sideSpanX = Math.max(3, Math.floor(sw * 0.16));
    const gLeft = _medianArray(colP85.subarray(0, sideSpanX));
    const gRight = _medianArray(colP85.subarray(sw - sideSpanX));
    if (plateLum - gLeft < 28 || plateLum - gRight < 28) return null;

    const gLum = Math.max(gLeft, gRight);
    const thrX = gLum + 0.44 * (plateLum - gLum);
    const cxI = Math.max(2, Math.min(sw - 3, Math.round(cxS)));
    if (colP85[cxI] < thrX) return null;

    let xl = cxI;
    while (xl > 0 && colP85[xl - 1] >= thrX) xl -= 1;
    let xr = cxI;
    while (xr + 1 < sw && colP85[xr + 1] >= thrX) xr += 1;

    const detW = xr - xl + 1;
    if (xl < 2 || xr > sw - 3 || detW < hwS * 1.32 || detW > hwS * 2.75) return null;

    const sideW = Math.max(5, Math.round(detW * 0.22));
    const sl0 = Math.max(0, xl - sideW - 2);
    const sl1 = Math.max(2, xl - 2);
    const sr0 = Math.min(sw - 2, xr + 3);
    const sr1 = Math.min(sw, xr + sideW + 3);
    if (sl1 <= sl0 || sr1 <= sr0) return null;

    const rowSideL = new Float32Array(sh);
    const rowSideR = new Float32Array(sh);
    const rowContrast = new Float32Array(sh);
    for (let y = 0; y < sh; y += 1) {
      const base = y * sw;
      const inVals = [];
      for (let x = xl; x <= xr; x += 1) inVals.push(roiLum[base + x]);
      const lVals = [];
      for (let x = sl0; x < sl1; x += 1) lVals.push(roiLum[base + x]);
      const rVals = [];
      for (let x = sr0; x < sr1; x += 1) rVals.push(roiLum[base + x]);
      const rIn = _percentileJs(inVals, 85);
      const rSL = _medianArray(lVals);
      const rSR = _medianArray(rVals);
      rowSideL[y] = rSL;
      rowSideR[y] = rSR;
      rowContrast[y] = rIn - 0.5 * (rSL + rSR);
    }

    const peakC = _percentileJs(rowContrast.subarray(my0, my1), 80);
    if (peakC < 28) return null;
    const thrY = Math.max(20, peakC * 0.42);
    const cyI = Math.max(2, Math.min(sh - 3, Math.round(cyS)));
    if (rowContrast[cyI] < thrY) return null;

    let yt = cyI;
    while (yt > 0 && rowContrast[yt - 1] >= thrY) yt -= 1;
    let yb = cyI;
    while (yb + 1 < sh && rowContrast[yb + 1] >= thrY) yb += 1;

    const detH = yb - yt + 1;
    const detAspect = detW / Math.max(1, detH);
    if (yt < 1 || yb > sh - 2 || detAspect < 1.02 || detAspect > 3.55) return null;

    const midX = (xl + xr) >> 1;
    const midY = (yt + yb) >> 1;
    let ytL = yt;
    let ybL = yb;
    let ytR = yt;
    let ybR = yb;
    let xlT = xl;
    let xrT = xr;
    let xlB = xl;
    let xrB = xr;

    if (midX - xl >= 6 && xr - midX >= 6) {
      const rcL = new Float32Array(sh);
      const rcR = new Float32Array(sh);
      for (let y = 0; y < sh; y += 1) {
        const base = y * sw;
        const lv = [];
        for (let x = xl + 1; x < midX; x += 1) lv.push(roiLum[base + x]);
        const rv = [];
        for (let x = midX + 1; x < xr; x += 1) rv.push(roiLum[base + x]);
        rcL[y] = _percentileJs(lv, 85) - rowSideL[y];
        rcR[y] = _percentileJs(rv, 85) - rowSideR[y];
      }
      let tl = midY;
      while (tl > Math.max(0, yt - 4) && rcL[tl - 1] >= thrY * 0.92) tl -= 1;
      let bl = midY;
      while (bl + 1 < Math.min(sh, yb + 5) && rcL[bl + 1] >= thrY * 0.92) bl += 1;
      let tr = midY;
      while (tr > Math.max(0, yt - 4) && rcR[tr - 1] >= thrY * 0.92) tr -= 1;
      let br = midY;
      while (br + 1 < Math.min(sh, yb + 5) && rcR[br + 1] >= thrY * 0.92) br += 1;
      if (Math.abs(tl - yt) <= detH * 0.25 && Math.abs(tr - yt) <= detH * 0.25) {
        ytL = tl;
        ytR = tr;
      }
      if (Math.abs(bl - yb) <= detH * 0.25 && Math.abs(br - yb) <= detH * 0.25) {
        ybL = bl;
        ybR = br;
      }
    }

    if (midY - yt >= 4 && yb - midY >= 4) {
      const cpT = new Float32Array(sw);
      const cpB = new Float32Array(sw);
      for (let x = 0; x < sw; x += 1) {
        const tv = [];
        for (let y = yt + 1; y < midY; y += 1) tv.push(roiLum[y * sw + x]);
        const bv = [];
        for (let y = midY + 1; y < yb; y += 1) bv.push(roiLum[y * sw + x]);
        cpT[x] = _percentileJs(tv, 85);
        cpB[x] = _percentileJs(bv, 85);
      }
      let lt = midX;
      while (lt > Math.max(0, xl - 4) && cpT[lt - 1] >= thrX * 0.95) lt -= 1;
      let rt = midX;
      while (rt + 1 < Math.min(sw, xr + 5) && cpT[rt + 1] >= thrX * 0.95) rt += 1;
      let lb = midX;
      while (lb > Math.max(0, xl - 4) && cpB[lb - 1] >= thrX * 0.95) lb -= 1;
      let rb = midX;
      while (rb + 1 < Math.min(sw, xr + 5) && cpB[rb + 1] >= thrX * 0.95) rb += 1;
      if (Math.abs(lt - xl) <= detW * 0.20 && Math.abs(lb - xl) <= detW * 0.20) {
        xlT = lt;
        xlB = lb;
      }
      if (Math.abs(rt - xr) <= detW * 0.20 && Math.abs(rb - xr) <= detW * 0.20) {
        xrT = rt;
        xrB = rb;
      }
    }

    // 正面構図の微小ノイズ傾きを完全水平・垂直へロック
    if (Math.abs(ytL - ytR) <= Math.max(2.2, detH * 0.055) && Math.abs(ybL - ybR) <= Math.max(2.2, detH * 0.055)) {
      ytL = yt;
      ytR = yt;
      ybL = yb;
      ybR = yb;
    }
    if (Math.abs(xlT - xlB) <= Math.max(2.2, detW * 0.045) && Math.abs(xrT - xrB) <= Math.max(2.2, detW * 0.045)) {
      xlT = xl;
      xlB = xl;
      xrT = xr;
      xrB = xr;
    }

    return [
      { x: xlT, y: ytL },
      { x: xrT, y: ytR },
      { x: xrB, y: ybR },
      { x: xlB, y: ybL },
    ];
  }

  function _extractBestPlateComponentJs(mask, w, h, ix0, ix1, iy0, iy1) {
    const blobs = _extractBlobs8(mask, w, h, 24, w * h);
    let best = null;
    let bestScore = 0;
    for (let i = 0; i < blobs.length; i += 1) {
      const b = blobs[i];
      if (b.minX < 2 || b.maxX > w - 3 || b.minY < 2 || b.maxY > h - 3) continue;
      let inCore = false;
      for (let k = 0; k < b.count; k += 1) {
        if (b.xs[k] >= ix0 && b.xs[k] < ix1 && b.ys[k] >= iy0 && b.ys[k] < iy1) {
          inCore = true;
          break;
        }
      }
      if (!inCore) continue;
      const bboxArea = (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1);
      const sc = b.count + bboxArea * 0.25;
      if (sc > bestScore) {
        bestScore = sc;
        best = b;
      }
    }
    return best;
  }

  /** 候補4頂点を検証し、実画像のプレート板4辺へ精密スナップ補正する (snap_quad_to_plate_surface のJS移植) */
  function _snapQuadToPlateSurfaceJs(rgba, w, h, normQuad, score = 0.75, expandFactor = 1.055, strictIsolation = false) {
    const rawPx = normQuad.map((p) => ({ x: p.x * w, y: p.y * h }));
    const ptsPx = _orderPtsCwJs(rawPx);
    const xsAll = ptsPx.map((p) => p.x);
    const ysAll = ptsPx.map((p) => p.y);
    const bboxW = Math.max(...xsAll) - Math.min(...xsAll);
    const bboxH = Math.max(...ysAll) - Math.min(...ysAll);
    const wellFormedIn = _quadIsWellFormedJs(ptsPx);

    let vecWx;
    let vecWy;
    let vecHx;
    let vecHy;
    let pw;
    let ph;
    if (wellFormedIn) {
      vecWx = 0.5 * ((ptsPx[1].x - ptsPx[0].x) + (ptsPx[2].x - ptsPx[3].x));
      vecWy = 0.5 * ((ptsPx[1].y - ptsPx[0].y) + (ptsPx[2].y - ptsPx[3].y));
      vecHx = 0.5 * ((ptsPx[3].x - ptsPx[0].x) + (ptsPx[2].x - ptsPx[1].x));
      vecHy = 0.5 * ((ptsPx[3].y - ptsPx[0].y) + (ptsPx[2].y - ptsPx[1].y));
      pw = Math.hypot(vecWx, vecWy);
      ph = Math.hypot(vecHx, vecHy);
    } else {
      vecWx = bboxW;
      vecWy = 0;
      vecHx = 0;
      vecHy = bboxH;
      pw = bboxW;
      ph = bboxH;
    }

    if (pw < 10 || ph < 6) return { ok: false, pts: null };
    const aspect = pw / Math.max(1, ph);
    if (aspect < 0.85 || aspect > 5.8) return { ok: false, pts: null };

    const center = {
      x: 0.25 * (ptsPx[0].x + ptsPx[1].x + ptsPx[2].x + ptsPx[3].x),
      y: 0.25 * (ptsPx[0].y + ptsPx[1].y + ptsPx[2].y + ptsPx[3].y),
    };

    let checkQuad = ptsPx.map((p) => ({ x: p.x / w, y: p.y / h }));
    if (ph / pw < 0.43) {
      const utx = vecWx / pw;
      const uty = vecWy / pw;
      let vtx = -uty;
      let vty = utx;
      if (vtx * vecHx + vty * vecHy < 0) {
        vtx = -vtx;
        vty = -vty;
      }
      const hhTmp = pw * 0.25;
      const hwTmp = pw * 0.5;
      checkQuad = [
        { x: Math.max(0, Math.min(1, (center.x - utx * hwTmp - vtx * hhTmp) / w)), y: Math.max(0, Math.min(1, (center.y - uty * hwTmp - vty * hhTmp) / h)) },
        { x: Math.max(0, Math.min(1, (center.x + utx * hwTmp - vtx * hhTmp) / w)), y: Math.max(0, Math.min(1, (center.y + uty * hwTmp - vty * hhTmp) / h)) },
        { x: Math.max(0, Math.min(1, (center.x + utx * hwTmp + vtx * hhTmp) / w)), y: Math.max(0, Math.min(1, (center.y + uty * hwTmp + vty * hhTmp) / h)) },
        { x: Math.max(0, Math.min(1, (center.x - utx * hwTmp + vtx * hhTmp) / w)), y: Math.max(0, Math.min(1, (center.y - uty * hwTmp + vty * hhTmp) / h)) },
      ];
    }

    if (strictIsolation || score < 0.78) {
      const sigRes = _hasPlateSignatureJs(rgba, w, h, checkQuad, strictIsolation || score < 0.72, false);
      if (!sigRes.ok) return { ok: false, pts: null };
    }

    const refHw = pw * 0.5;
    const refHh = Math.max(ph * 0.5, pw * 0.26);
    const uIx = vecWx / pw;
    const uIy = vecWy / pw;
    let vIx = -uIy;
    let vIy = uIx;
    if (vIx * vecHx + vIy * vecHy < 0) {
      vIx = -vIx;
      vIy = -vIy;
    }
    const tiltDeg = Math.abs((Math.atan2(uIy, uIx) * 180) / Math.PI);
    let snappedPx = null;

    if (tiltDeg > 12) {
      const uLim = refHw * 1.55;
      const vLim = refHh * 1.65;
      const swR = Math.max(40, Math.min(200, Math.round(uLim * 2)));
      const shR = Math.max(30, Math.min(150, Math.round(vLim * 2)));
      const rotR = new Float32Array(swR * shR);
      const rotG = new Float32Array(swR * shR);
      const rotB = new Float32Array(swR * shR);
      const rotLum = new Float32Array(swR * shR);
      for (let vy = 0; vy < shR; vy += 1) {
        const vv = -vLim + (2 * vLim * vy) / Math.max(1, shR - 1);
        for (let ux = 0; ux < swR; ux += 1) {
          const uu = -uLim + (2 * uLim * ux) / Math.max(1, swR - 1);
          const sx = Math.max(0, Math.min(w - 1, Math.round(center.x + uu * uIx + vv * vIx)));
          const sy = Math.max(0, Math.min(h - 1, Math.round(center.y + uu * uIy + vv * vIy)));
          const off = (sy * w + sx) * 4;
          const idx = vy * swR + ux;
          rotR[idx] = rgba[off];
          rotG[idx] = rgba[off + 1];
          rotB[idx] = rgba[off + 2];
          rotLum[idx] = 0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2];
        }
      }
      const cxR = (swR - 1) * 0.5;
      const cyR = (shR - 1) * 0.5;
      const hwR = refHw * (swR / Math.max(1, uLim * 2));
      const hhR = refHh * (shR / Math.max(1, vLim * 2));
      const ix0R = Math.max(0, Math.round(cxR - hwR * 0.62));
      const ix1R = Math.min(swR, Math.max(ix0R + 2, Math.round(cxR + hwR * 0.62)));
      const iy0R = Math.max(0, Math.round(cyR - hhR * 0.58));
      const iy1R = Math.min(shR, Math.max(iy0R + 2, Math.round(cyR + hhR * 0.58)));
      const inLum = [];
      const inR = [];
      const inG = [];
      const inB = [];
      for (let y = iy0R; y < iy1R; y += 1) {
        for (let x = ix0R; x < ix1R; x += 1) {
          const id = y * swR + x;
          inLum.push(rotLum[id]);
          inR.push(rotR[id]);
          inG.push(rotG[id]);
          inB.push(rotB[id]);
        }
      }
      if (inLum.length < 16) return { ok: false, pts: null };
      const dynR = _percentileJs(inLum, 85) - _percentileJs(inLum, 4);
      const meanR = inLum.reduce((a, b) => a + b, 0) / inLum.length;
      const stdR = Math.sqrt(inLum.reduce((a, b) => a + (b - meanR) ** 2, 0) / inLum.length);
      if (dynR < 50 || stdR < 11) return { ok: false, pts: null };

      const pLumR = 0.299 * _percentileJs(inR, 82) + 0.587 * _percentileJs(inG, 82) + 0.114 * _percentileJs(inB, 82);
      const profQ = _snapBySideGrilleContrastJs(rotLum, swR, shR, cxR, cyR, hwR, hhR, pLumR);
      if (profQ) {
        snappedPx = profQ.map((pt) => {
          const du = (pt.x / Math.max(1, swR - 1) - 0.5) * (uLim * 2);
          const dv = (pt.y / Math.max(1, shR - 1) - 0.5) * (vLim * 2);
          return { x: center.x + du * uIx + dv * vIx, y: center.y + du * uIy + dv * vIy };
        });
      }
    }

    const roiPadX = refHw * 1.55;
    const roiPadY = refHh * 1.65;
    const rx0 = Math.max(0, Math.floor(center.x - roiPadX));
    const ry0 = Math.max(0, Math.floor(center.y - roiPadY));
    const rx1 = Math.min(w, Math.ceil(center.x + roiPadX));
    const ry1 = Math.min(h, Math.ceil(center.y + roiPadY));
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;

    if (!snappedPx && tiltDeg <= 12 && rw >= 16 && rh >= 12) {
      const scaleR = Math.min(1, 240 / rw);
      const sw = scaleR < 0.999 ? Math.max(32, Math.round(rw * scaleR)) : rw;
      const sh = scaleR < 0.999 ? Math.max(24, Math.round(rh * scaleR)) : rh;
      const roiR = new Float32Array(sw * sh);
      const roiG = new Float32Array(sw * sh);
      const roiB = new Float32Array(sw * sh);
      const roiLum = new Float32Array(sw * sh);
      for (let sy = 0; sy < sh; sy += 1) {
        const srcY = Math.max(0, Math.min(h - 1, Math.floor(ry0 + ((sy + 0.5) * rh) / sh)));
        for (let sx = 0; sx < sw; sx += 1) {
          const srcX = Math.max(0, Math.min(w - 1, Math.floor(rx0 + ((sx + 0.5) * rw) / sw)));
          const off = (srcY * w + srcX) * 4;
          const idx = sy * sw + sx;
          roiR[idx] = rgba[off];
          roiG[idx] = rgba[off + 1];
          roiB[idx] = rgba[off + 2];
          roiLum[idx] = 0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2];
        }
      }

      const cxS = ((center.x - rx0) * sw) / rw;
      const cyS = ((center.y - ry0) * sh) / rh;
      const hwS = (refHw * sw) / rw;
      const hhS = (refHh * sh) / rh;
      const ix0 = Math.max(0, Math.round(cxS - hwS * 0.62));
      const ix1 = Math.min(sw, Math.max(ix0 + 2, Math.round(cxS + hwS * 0.62)));
      const iy0 = Math.max(0, Math.round(cyS - hhS * 0.58));
      const iy1 = Math.min(sh, Math.max(iy0 + 2, Math.round(cyS + hhS * 0.58)));

      const inLum = [];
      const inR = [];
      const inG = [];
      const inB = [];
      for (let y = iy0; y < iy1; y += 1) {
        for (let x = ix0; x < ix1; x += 1) {
          const id = y * sw + x;
          inLum.push(roiLum[id]);
          inR.push(roiR[id]);
          inG.push(roiG[id]);
          inB.push(roiB[id]);
        }
      }
      if (inLum.length < 16) return { ok: false, pts: null };
      const dynInner = _percentileJs(inLum, 85) - _percentileJs(inLum, 4);
      const meanIn = inLum.reduce((a, b) => a + b, 0) / inLum.length;
      const stdIn = Math.sqrt(inLum.reduce((a, b) => a + (b - meanIn) ** 2, 0) / inLum.length);
      if (dynInner < 50 || stdIn < 11) return { ok: false, pts: null };

      const p82R = _percentileJs(inR, 82);
      const p82G = _percentileJs(inG, 82);
      const p82B = _percentileJs(inB, 82);
      const plateLum = 0.299 * p82R + 0.587 * p82G + 0.114 * p82B;
      const darkRef = _percentileJs(roiLum, 15);

      if (plateLum >= 88 && plateLum - darkRef >= 26) {
        const profLocal = _snapBySideGrilleContrastJs(roiLum, sw, sh, cxS, cyS, hwS, hhS, plateLum);
        if (profLocal) {
          snappedPx = profLocal.map((pt) => ({
            x: rx0 + ((pt.x + 0.5) * rw) / sw,
            y: ry0 + ((pt.y + 0.5) * rh) / sh,
          }));
        } else {
          const lumThr = darkRef + 0.48 * (plateLum - darkRef);
          const colThr = Math.max(44, (plateLum - darkRef) * 0.56);
          const baseMask = new Uint8Array(sw * sh);
          for (let i = 0; i < sw * sh; i += 1) {
            const cDist = Math.max(Math.abs(roiR[i] - p82R), Math.abs(roiG[i] - p82G), Math.abs(roiB[i] - p82B));
            if (roiLum[i] >= lumThr && cDist <= colThr) baseMask[i] = 1;
          }
          const comp = _extractBestPlateComponentJs(baseMask, sw, sh, ix0, ix1, iy0, iy1);
          if (comp && comp.count >= 24) {
            const worldXs = new Float32Array(comp.count);
            const worldYs = new Float32Array(comp.count);
            for (let k = 0; k < comp.count; k += 1) {
              worldXs[k] = rx0 + ((comp.xs[k] + 0.5) * rw) / sw;
              worldYs[k] = ry0 + ((comp.ys[k] + 0.5) * rh) / sh;
            }
            const fitComp = _fitMinAreaQuadJs(worldXs, worldYs, comp.count);
            const fitAsp = fitComp.bw / Math.max(1, fitComp.bh);
            if (fitComp.rectFill >= 0.48 && fitComp.bw >= pw * 0.72 && fitComp.bh >= ph * 0.68 && fitAsp >= 1.32 && fitAsp <= 3.5) {
              snappedPx = fitComp.quad;
            }
          }
        }
      }
    }

    if (!snappedPx) {
      let uvx = vecWx / pw;
      let uvy = vecWy / pw;
      if (Math.abs(uvy) < 0.096) {
        uvx = uvx >= 0 ? 1 : -1;
        uvy = 0;
      }
      let vvx = -uvy;
      let vvy = uvx;
      if (vvx * vecHx + vvy * vecHy < 0) {
        vvx = -vvx;
        vvy = -vvy;
      }
      const targetHh = ph / pw < 0.43 ? Math.max(ph * 0.5, pw * 0.25) : ph * 0.5;
      snappedPx = [
        { x: center.x - uvx * refHw - vvx * targetHh, y: center.y - uvy * refHw - vvy * targetHh },
        { x: center.x + uvx * refHw - vvx * targetHh, y: center.y + uvy * refHw - vvy * targetHh },
        { x: center.x + uvx * refHw + vvx * targetHh, y: center.y + uvy * refHw + vvy * targetHh },
        { x: center.x - uvx * refHw + vvx * targetHh, y: center.y - uvy * refHw + vvy * targetHh },
      ];
    }

    let cFx = 0;
    let cFy = 0;
    for (let i = 0; i < 4; i += 1) {
      cFx += snappedPx[i].x;
      cFy += snappedPx[i].y;
    }
    cFx *= 0.25;
    cFy *= 0.25;
    const expandedPx = _orderPtsCwJs(
      snappedPx.map((p) => ({
        x: cFx + (p.x - cFx) * expandFactor,
        y: cFy + (p.y - cFy) * expandFactor,
      }))
    );
    const outNorm = expandedPx.map((p) => ({
      x: Math.max(0, Math.min(1, p.x / w)),
      y: Math.max(0, Math.min(1, p.y / h)),
    }));
    return { ok: true, pts: outNorm };
  }

  function _samplePlateColorJs(rgba, w, h, pts) {
    const xs = pts.map((p) => p.x * w);
    const ys = pts.map((p) => p.y * h);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const x1 = Math.min(w, Math.ceil(Math.max(...xs)) + 1);
    const y1 = Math.min(h, Math.ceil(Math.max(...ys)) + 1);
    if (x1 - x0 < 4 || y1 - y0 < 4) return '#F4F6F9';
    const rs = [];
    const gs = [];
    const bs = [];
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const off = (y * w + x) * 4;
        rs.push(rgba[off]);
        gs.push(rgba[off + 1]);
        bs.push(rgba[off + 2]);
      }
    }
    if (!rs.length) return '#F4F6F9';
    const rVal = _percentileJs(rs, 75);
    const gVal = _percentileJs(gs, 75);
    const bVal = _percentileJs(bs, 75);
    if (rVal > 165 && gVal > 140 && bVal < 105 && (rVal - bVal) > 70) return '#EAB308';
    if (Math.max(rVal, gVal, bVal) < 95) return '#1A1D24';
    return '#F4F6F9';
  }

  function _nmsPlateCandsJs(cands, iouThr = 0.32) {
    const sorted = [...cands].sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of sorted) {
      let overlaps = false;
      for (const k of kept) {
        const ix1 = Math.max(c.minX, k.minX);
        const iy1 = Math.max(c.minY, k.minY);
        const ix2 = Math.min(c.maxX, k.maxX);
        const iy2 = Math.min(c.maxY, k.maxY);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
        const areaA = Math.max(1e-6, (c.maxX - c.minX) * (c.maxY - c.minY));
        const areaB = Math.max(1e-6, (k.maxX - k.minX) * (k.maxY - k.minY));
        if (inter / Math.max(1e-6, areaA + areaB - inter) > iouThr) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        kept.push(c);
        if (kept.length >= 16) break;
      }
    }
    return kept;
  }

  /** 日本の2段・希望ナンバー補完候補抽出 ＋ LPD-YuNet 生候補合流 ＋ 実画像4辺精密スナップ */
  async function _detectPlatesClientSideAsync(sourceImg, nativePlateCands = []) {
    const origW = sourceImg.naturalWidth || sourceImg.width || 0;
    const origH = sourceImg.naturalHeight || sourceImg.height || 0;
    if (origW < 100 || origH < 80) return [];

    // 1. 文字シグネチャ・4辺スナップ検証用の高解像度キャンバスを取得 (最大長辺 1600px)
    const fullScale = Math.min(1, 1600 / Math.max(origW, origH));
    const fullW = Math.max(120, Math.round(origW * fullScale));
    const fullH = Math.max(90, Math.round(origH * fullScale));
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = fullW;
    fullCanvas.height = fullH;
    const fCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
    fCtx.drawImage(sourceImg, 0, 0, fullW, fullH);
    const fullRgba = fCtx.getImageData(0, 0, fullW, fullH).data;

    // 2. 候補生成リスト: (pts, score, strictIsolation)
    const rawCands = [];
    for (let i = 0; i < (nativePlateCands || []).length; i += 1) {
      const np = nativePlateCands[i];
      if (np && Array.isArray(np.pts) && np.pts.length === 4) {
        rawCands.push({
          pts: np.pts.map((pt) => ({ x: Number(pt.x), y: Number(pt.y) })),
          score: Number(np.score || 0.65),
          strict: Boolean(np.strictIsolation),
        });
      }
    }

    // 3. 日本の2段プレート幾何補完検出 (母艦 plate_refiner.py と同一パラメータ: boxBlur on lum, thr=(25,40), lum>=96)
    const workW = Math.min(800, fullW);
    const workH = Math.max(60, Math.round(fullH * (workW / fullW)));
    const workCanvas = document.createElement('canvas');
    workCanvas.width = workW;
    workCanvas.height = workH;
    const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    wCtx.drawImage(fullCanvas, 0, 0, workW, workH);
    const wRgba = wCtx.getImageData(0, 0, workW, workH).data;

    const total = workW * workH;
    const lum = new Float32Array(total);
    const lumBoost = new Float32Array(total);
    for (let i = 0; i < total; i += 1) {
      const off = i * 4;
      const r = wRgba[off];
      const g = wRgba[off + 1];
      const b = wRgba[off + 2];
      const lVal = 0.299 * r + 0.587 * g + 0.114 * b;
      const yb = Math.min(120, Math.max(0, (r + g) * 0.5 - b)) * 0.35;
      lum[i] = lVal;
      lumBoost[i] = lVal + yb;
    }

    const radii = [Math.max(7, Math.floor(workW / 38)), Math.max(22, Math.floor(workW / 11))];
    const thresholds = [25, 40];
    const yMinScan = Math.floor(workH * 0.10);
    const yMaxScan = Math.floor(workH * 0.96);
    const maxBlobPx = Math.floor(total * 0.07);

    for (let rIdx = 0; rIdx < radii.length; rIdx += 1) {
      // 背景推定は pure lum から行い、黄色加点は前景差分側のみに適用して周辺癒着を防ぐ
      const blur = _boxBlurSeparable(lum, workW, workH, radii[rIdx]);
      for (let tIdx = 0; tIdx < thresholds.length; tIdx += 1) {
        const thr = thresholds[tIdx];
        const fg = new Uint8Array(total);
        for (let y = yMinScan; y < yMaxScan; y += 1) {
          const row = y * workW;
          for (let x = 0; x < workW; x += 1) {
            const idx = row + x;
            if (lumBoost[idx] - blur[idx] >= thr && lum[idx] >= 96) {
              fg[idx] = 1;
            }
          }
        }
        const closed = _morphErode3(_morphDilate3(_morphDilate3(fg, workW, workH), workW, workH), workW, workH);
        const blobs = _extractBlobs8(closed, workW, workH, 20, maxBlobPx);
        for (let bIdx = 0; bIdx < blobs.length; bIdx += 1) {
          const b = blobs[bIdx];
          const bwBox = b.maxX - b.minX + 1;
          const bhBox = b.maxY - b.minY + 1;
          if (bwBox < workW * 0.016 || bwBox > workW * 0.36) continue;
          if (bhBox < workH * 0.014 || bhBox > workH * 0.28) continue;
          const roughAspect = bwBox / Math.max(1, bhBox);
          if (roughAspect < 0.72 || roughAspect > 2.95) continue;

          const fit = _fitMinAreaQuadJs(b.xs, b.ys, b.count);
          const rw = Math.max(fit.bw, fit.bh);
          const rh = Math.min(fit.bw, fit.bh);
          const rotAspect = rw / Math.max(1, rh);
          if (rotAspect < 1.05 || rotAspect > 2.55 || fit.rectFill < 0.72) continue;

          const normQ = fit.quad.map((pt) => ({
            x: Math.max(0, Math.min(1, pt.x / workW)),
            y: Math.max(0, Math.min(1, pt.y / workH)),
          }));
          const cyNorm = ((b.minY + b.maxY) * 0.5) / workH;
          const extraStrict = rotAspect < 1.38 || cyNorm < 0.24 || bwBox < workW * 0.025;
          const sig = _hasPlateSignatureJs(fullRgba, fullW, fullH, normQ, true, extraStrict);
          if (sig.ok) {
            rawCands.push({ pts: normQ, score: sig.score, strict: true });
          }
        }
      }
      await _nextPaintYield();
    }

    if (!rawCands.length) return [];

    // 4. 全候補 (LPD-YuNet ＋ 日本2段) に対し実画像の4辺スナップ補正と独立文字検証を実施
    const snappedCands = [];
    for (let i = 0; i < rawCands.length; i += 1) {
      const c = rawCands[i];
      const snapRes = _snapQuadToPlateSurfaceJs(fullRgba, fullW, fullH, c.pts, c.score, 1.055, c.strict);
      if (!snapRes.ok || !snapRes.pts) continue;
      const xsN = snapRes.pts.map((p) => p.x);
      const ysN = snapRes.pts.map((p) => p.y);
      const bwPx = (Math.max(...xsN) - Math.min(...xsN)) * fullW;
      const bhPx = (Math.max(...ysN) - Math.min(...ysN)) * fullH;
      if (bwPx < 10 || bhPx < 6) continue;
      snappedCands.push({
        pts: snapRes.pts.map((p) => ({ x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)) })),
        style: 'solid',
        color: _samplePlateColorJs(fullRgba, fullW, fullH, snapRes.pts),
        feather: cfg.plateFeather ?? 0.45,
        score: Number(c.score.toFixed(3)),
        minX: Math.min(...xsN),
        maxX: Math.max(...xsN),
        minY: Math.min(...ysN),
        maxY: Math.max(...ysN),
      });
    }

    return _nmsPlateCandsJs(snappedCands, 0.32).map((c) => ({
      pts: c.pts,
      style: c.style,
      color: c.color,
      feather: c.feather,
      score: c.score,
    }));
  }

  /** ネイティブ (YuNet / LPD-YuNet) またはブラウザ FaceDetector で人物顔＋ナンバー生候補を一括推論する */
  async function _detectNativePrivacyAsync(sourceImg) {
    const origW = sourceImg.naturalWidth || sourceImg.width || 0;
    const origH = sourceImg.naturalHeight || sourceImg.height || 0;
    if (origW < 24 || origH < 24) return { faces: [], plates: [] };

    const scale = Math.min(1, 1024 / Math.max(origW, origH));
    const dw = Math.max(24, Math.round(origW * scale) & ~1);
    const dh = Math.max(24, Math.round(origH * scale));
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = dw;
    tmpCanvas.height = dh;
    const tCtx = tmpCanvas.getContext('2d');
    tCtx.drawImage(sourceImg, 0, 0, dw, dh);

    const adapter = global.TetheractPhoneCaseAdapter;
    if (adapter && typeof adapter.detectFacesFromDataUrl === 'function') {
      try {
        const dataUrl = tmpCanvas.toDataURL('image/jpeg', 0.88);
        const res = await adapter.detectFacesFromDataUrl(dataUrl);
        if (res && res.ok) {
          return {
            faces: Array.isArray(res.faces) ? res.faces : [],
            plates: Array.isArray(res.plates) ? res.plates : [],
          };
        }
      } catch (e) {
        console.warn('[TOUCH_ART_FRAMER] ネイティブプライバシー検出警告:', e);
      }
    }

    // 非ネイティブブラウザ等で Web Shape Detection API (FaceDetector) が利用可能な場合のフォールバック
    if (cfg.detectFaces && typeof global.FaceDetector === 'function') {
      try {
        const DetectorCtor = global.FaceDetector;
        const det = new DetectorCtor({ fastMode: false, maxDetectedFaces: 16 });
        const hits = await det.detect(tmpCanvas);
        const longEdge = Math.max(dw, dh);
        const faces = (hits || []).slice(0, 24).map((h) => {
          const bb = h.boundingBox || {};
          const cx = ((bb.left || 0) + (bb.width || 0) * 0.5) / dw;
          const cy = ((bb.top || 0) + (bb.height || 0) * 0.5) / dh;
          const r = Math.max(0.018, Math.min(0.35, (Math.max(bb.width || 0, bb.height || 0) * 0.74) / longEdge));
          return {
            x: Number(Math.max(0, Math.min(1, cx)).toFixed(5)),
            y: Number(Math.max(0, Math.min(1, cy)).toFixed(5)),
            r: Number(r.toFixed(5)),
            style: 'frosted',
            strength: 0.92,
            score: 0.8,
          };
        });
        return { faces, plates: [] };
      } catch (e) {
        console.warn('[TOUCH_ART_FRAMER] Shape Detection フォールバック警告:', e);
      }
    }

    return { faces: [], plates: [] };
  }

  async function _runAiDetectionForCurrentPhoto(silentIfZero = false) {
    if (!photoQueue.length || !editor) return;
    const meta = photoQueue[queueIndex];
    const detectBtn = document.getElementById('mAfRunDetectBtn');
    const reqToken = loadReqSeq;

    const finishWithMasks = (plates, faces, engineLabel) => {
      if (reqToken !== loadReqSeq) return;
      const pList = (plates || []).map((p) => ({ ...p, feather: cfg.plateFeather ?? 0.45 }));
      const fList = (faces || []).map((f) => ({
        ...f,
        style: cfg.faceStyle || f.style || 'frosted',
        strength: cfg.faceStrength ?? f.strength ?? 0.92,
      }));
      editor.setMasks(pList, fList);
      _setDetectProgress(
        100,
        `${engineLabel}完了 (ナンバー:${pList.length} / 顔:${fList.length})`
      );
      _hideDetectProgress(700);
      if (!silentIfZero && pList.length === 0 && fList.length === 0) {
        _showToast('候補は検出されませんでした（手動追加も可能です）', 2600);
      }
    };

    try {
      if (detectBtn) {
        detectBtn.disabled = true;
        detectBtn.textContent = '検出中...';
      }

      if (meta && meta.isServerMode) {
        _setDetectProgress(25, 'PC母艦AIでマスク位置を検出中...');
        try {
          const res = await fetch('/api/export/detect-privacy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              photo_id: meta.id,
              apply_adjustments: true,
              detect_plates: cfg.detectPlates,
              detect_faces: cfg.detectFaces,
            }),
          });
          if (reqToken !== loadReqSeq) return;
          if (!res.ok) throw new Error('検出APIエラー');
          const data = await res.json();
          if (reqToken !== loadReqSeq) return;
          finishWithMasks(data.plates || [], data.faces || [], 'AI提案');
          return;
        } catch (srvErr) {
          console.warn('[TOUCH_ART_FRAMER] PC母艦AIフォールバック → オンデバイス検出:', srvErr);
        }
      }

      if (!editor.sourceImg) {
        _setDetectProgress(0, '画像の読み込み完了後に検出できます');
        _hideDetectProgress(0);
        return;
      }

      let foundFaces = [];
      let foundPlates = [];
      let nativePlatesRaw = [];

      if (cfg.detectFaces || cfg.detectPlates) {
        _setDetectProgress(28, 'AIモデル (YuNet / LPD-YuNet) でオンデバイス推論中...');
        await _nextPaintYield();
        if (reqToken !== loadReqSeq) return;
        const nativeRes = await _detectNativePrivacyAsync(editor.sourceImg);
        if (reqToken !== loadReqSeq) return;
        if (cfg.detectFaces) foundFaces = nativeRes.faces || [];
        nativePlatesRaw = nativeRes.plates || [];
      }

      if (cfg.detectPlates) {
        _setDetectProgress(68, 'ナンバー4辺を精密スナップ・2段文字補完中...');
        await _nextPaintYield();
        if (reqToken !== loadReqSeq) return;
        foundPlates = await _detectPlatesClientSideAsync(editor.sourceImg, nativePlatesRaw);
        if (reqToken !== loadReqSeq) return;
      }

      _setDetectProgress(94, '検出結果を反映中...');
      await _nextPaintYield();
      finishWithMasks(foundPlates, foundFaces, 'オンデバイスAI検出');
    } catch (err) {
      if (reqToken !== loadReqSeq) return;
      console.warn('[TOUCH_ART_FRAMER] 自動検出エラー:', err);
      _setDetectProgress(0, '手動配置モード（「＋ ナンバー枠」で配置できます）');
      _hideDetectProgress(0);
      if (!silentIfZero) _showToast('自動検出を完了できなかったため手動モードで継続します', 2400);
    } finally {
      if (detectBtn && reqToken === loadReqSeq) {
        detectBtn.disabled = false;
        detectBtn.textContent = 'AI自動検出';
      }
    }
  }

  function _updateCanvasDatasetBounds() {
    const canvasEl = document.getElementById('mAfCanvas');
    if (!canvasEl) return;
    const isNarrow = (global.innerWidth || 400) < 840;
    if (isNarrow) {
      const targetH = (global.innerHeight || 720) < 740 ? 255 : 310;
      canvasEl.dataset.maxHeight = String(targetH);
    } else {
      delete canvasEl.dataset.maxHeight;
    }
  }

  async function _loadCurrentQueuePhoto() {
    if (!photoQueue.length || !editor) return;
    const mySeq = ++loadReqSeq;
    const meta = photoQueue[queueIndex];

    const counterEl = document.getElementById('mAfQueueCounterBadge');
    const nameEl = document.getElementById('mAfCurrentFileName');
    const statusEl = document.getElementById('mAfDetectStatusText');

    if (counterEl) counterEl.textContent = `${queueIndex + 1} / ${photoQueue.length}`;
    if (nameEl) nameEl.textContent = meta.file_name || `ID:${meta.id}`;
    _hideDetectProgress(0);
    if (statusEl) statusEl.textContent = '高解像度画像を読み込み中...';

    _updateCanvasDatasetBounds();
    editor.setPhotoSource(null, meta, { plates: [], faces: [] });
    _refreshMaskPillsUI({ plates: [], faces: [], selected: null });
    _setStep(1);

    const primaryUrl = meta.hdUrl || meta.thumbUrl || '';
    const fallbackUrl = meta.thumbUrl && meta.thumbUrl !== primaryUrl ? meta.thumbUrl : '';
    if (!primaryUrl) {
      if (statusEl) statusEl.textContent = '画像URLを取得できません';
      _showToast('プレビュー画像を読み込めません', 2600);
      return;
    }

    const loadImg = (url, isFallback) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (mySeq !== loadReqSeq) return;
        editor.setPhotoSource(img, meta, { plates: [], faces: [] });
        _pushDecoratorToEditor();
        if (cfg.autoDetectOnOpen) {
          _runAiDetectionForCurrentPhoto(true);
        } else if (isFallback && statusEl) {
          statusEl.textContent = 'オフラインのためサムネイル解像度で編集しています';
        } else if (statusEl) {
          statusEl.textContent = 'マスク編集待機中（「＋ ナンバー枠」または「顔モヤ貼付」）';
        }
      };
      img.onerror = () => {
        if (mySeq !== loadReqSeq) return;
        if (!isFallback && fallbackUrl) {
          loadImg(fallbackUrl, true);
          return;
        }
        if (statusEl) statusEl.textContent = '画像読込エラー';
        _showToast('画像の読み込みに失敗しました', 2800);
      };
      img.src = url;
    };

    loadImg(primaryUrl, false);
  }

  function _buildOutputFileName(meta) {
    const origName = String((meta && meta.file_name) || `photo_${(meta && meta.id) || Date.now()}`);
    const dotIdx = origName.lastIndexOf('.');
    const rawStem = dotIdx > 0 ? origName.slice(0, dotIdx) : origName;
    const cleanStem = rawStem.replace(/^thmod_/i, '');
    const ext = cfg.output.format === 'png' ? 'png' : 'jpg';
    if (cfg.output.naming_rule === 'framed') {
      return `${cleanStem}_framed.${ext}`;
    }
    return `thmod_${cleanStem}.${ext}`;
  }

  function _triggerBrowserDownload(dataUrl, fileName) {
    let href = dataUrl;
    let objUrl = '';
    try {
      const commaIdx = String(dataUrl || '').indexOf(',');
      if (commaIdx >= 0) {
        const header = dataUrl.slice(0, commaIdx);
        const m = header.match(/data:([^;]+);/i);
        const mime = m ? m[1] : 'image/jpeg';
        const bin = global.atob(dataUrl.slice(commaIdx + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        objUrl = global.URL.createObjectURL(new Blob([bytes], { type: mime }));
        href = objUrl;
      }
    } catch (e) {
      href = dataUrl;
    }
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (objUrl) {
      setTimeout(() => {
        try { global.URL.revokeObjectURL(objUrl); } catch (e) {}
      }, 30000);
    }
  }

  async function _executeSaveOutput(shareImmediate = false) {
    if (isBusy || !photoQueue.length || !editor) return;
    _saveSettings();
    isBusy = true;
    _updateFooterButtonsUI();

    const meta = photoQueue[queueIndex];
    const isLast = queueIndex >= photoQueue.length - 1;
    const mimeType = cfg.output.format === 'png' ? 'image/png' : 'image/jpeg';
    const quality = Math.max(0.6, Math.min(1.0, Number(cfg.output.quality || 92) / 100));

    try {
      const dataUrl = editor.exportFinalDataUrl(mimeType, quality);
      if (!dataUrl) throw new Error('仕上がり画像の生成に失敗しました');
      const fileName = _buildOutputFileName(meta);

      const adapter = global.TetheractPhoneCaseAdapter;
      if (!adapter || typeof adapter.saveArtFramerOutput !== 'function') {
        _triggerBrowserDownload(dataUrl, fileName);
        _showToast(`✓ ${fileName} をダウンロードしました`);
      } else {
        const res = await adapter.saveArtFramerOutput({
          fileName,
          dataUrl,
          mimeType,
          parentPhotoId: meta.id,
          dateTaken: meta.original_date_taken || meta.date_taken || '',
          cameraModel: meta.camera_model || '',
          rating: Number(meta.rating || 0),
          tags: Array.isArray(meta.tags) ? meta.tags : [],
          stripAllExif: Boolean(cfg.output.exif_remove_all),
          shareImmediate: Boolean(shareImmediate),
          isServerMode: Boolean(meta.isServerMode),
        });
        if (!res || !res.ok) {
          throw new Error((res && res.error) || '保存処理に失敗しました');
        }
        if (res.needsBrowserDownload) {
          _triggerBrowserDownload(dataUrl, fileName);
        }
        if (res.shareError) {
          _showToast(`${fileName} を保存しました（${res.shareError}）`, 3500);
        } else if (shareImmediate) {
          _showToast(`✓ ${fileName} を保存し共有画面を開きました`);
        } else if (res.uploadedToServer) {
          _showToast(`✓ ${fileName} を母艦収納・スタックしました`);
        } else {
          _showToast(`✓ ${fileName} をギャラリーと母艦収納キューへ保存しました`);
        }
      }

      exportedCount += 1;
      const syncHook =
        typeof global.__refreshMobileAfterArtFramerSave === 'function'
          ? global.__refreshMobileAfterArtFramerSave
          : global.__onTetheractPhoneCatalogSynced;
      if (typeof syncHook === 'function') {
        try {
          await syncHook();
        } catch (syncErr) {
          console.warn('[TOUCH_ART_FRAMER] カタログ再同期警告:', syncErr);
        }
      }

      if (!isLast) {
        queueIndex += 1;
        isBusy = false;
        await _loadCurrentQueuePhoto();
      } else {
        isBusy = false;
        close(true);
      }
    } catch (err) {
      console.error('[TOUCH_ART_FRAMER] 書き出しエラー:', err);
      _showToast(`! 書き出しエラー: ${err.message || err}`, 3600);
      isBusy = false;
      _updateFooterButtonsUI();
    }
  }

  async function _skipCurrentPhoto() {
    if (isBusy) return;
    if (queueIndex < photoQueue.length - 1) {
      queueIndex += 1;
      await _loadCurrentQueuePhoto();
    } else {
      close(true);
    }
  }

  function _bindModalEvents() {
    document.getElementById('mAfCloseBtn')?.addEventListener('click', () => close(false));
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close(false);
    });

    modalEl.querySelectorAll('.t-af-preset-pill').forEach((btn) => {
      btn.addEventListener('click', () => _applyTargetPreset(btn.dataset.preset));
    });
    modalEl.querySelectorAll('.t-af-step-tab').forEach((tab) => {
      tab.addEventListener('click', () => _setStep(parseInt(tab.dataset.step, 10)));
    });

    document.getElementById('mAfPrevPhotoBtn')?.addEventListener('click', async () => {
      if (isBusy || queueIndex <= 0) return;
      queueIndex -= 1;
      await _loadCurrentQueuePhoto();
    });
    document.getElementById('mAfNextPhotoBtn')?.addEventListener('click', async () => {
      if (isBusy || queueIndex >= photoQueue.length - 1) return;
      queueIndex += 1;
      await _loadCurrentQueuePhoto();
    });

    document.getElementById('mAfPrevStepBtn')?.addEventListener('click', () => _setStep(cfg.step - 1));
    document.getElementById('mAfNextStepBtn')?.addEventListener('click', () => _setStep(cfg.step + 1));
    document.getElementById('mAfSkipPhotoBtn')?.addEventListener('click', _skipCurrentPhoto);
    document.getElementById('mAfSaveAndShareBtn')?.addEventListener('click', () => _executeSaveOutput(true));
    document.getElementById('mAfSaveQueueBtn')?.addEventListener('click', () => _executeSaveOutput(false));

    // ズーム・ルーペ
    document.getElementById('mAfZoomInBtn')?.addEventListener('click', () => editor?.zoomByFactor(1.45));
    document.getElementById('mAfZoomOutBtn')?.addEventListener('click', () => editor?.zoomByFactor(1 / 1.45));
    document.getElementById('mAfZoomFitBtn')?.addEventListener('click', () => editor?.resetZoom());
    document.getElementById('mAfZoomFocusBtn')?.addEventListener('click', () => editor?.focusOnSelectedMask());
    document.getElementById('mAfLoupeCheck')?.addEventListener('change', (e) => {
      if (editor) editor.loupeEnabled = e.target.checked;
    });
    const cleanBtn = document.getElementById('mAfHoldCleanBtn');
    if (cleanBtn) {
      cleanBtn.addEventListener('pointerdown', () => {
        if (editor) { editor.hideGuides = true; editor.render(); }
      });
      global.addEventListener('pointerup', () => {
        if (editor && editor.hideGuides) { editor.hideGuides = false; editor.render(); }
      });
    }

    // Step 1
    document.getElementById('mAfRunDetectBtn')?.addEventListener('click', () => _runAiDetectionForCurrentPhoto(false));
    modalEl.querySelectorAll('.t-af-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => editor?.setToolMode(btn.dataset.mode));
    });
    document.getElementById('mAfAddPlateBtn')?.addEventListener('click', () => editor?.addPlateAtViewportCenter());
    document.getElementById('mAfDeleteMaskBtn')?.addEventListener('click', () => editor?.deleteSelected());
    document.getElementById('mAfClearMasksBtn')?.addEventListener('click', () => editor?.clearAll());

    document.getElementById('mAfPlateStyleSelect')?.addEventListener('change', (e) => {
      editor?.applyPlateStyle(e.target.value, null);
    });
    modalEl.querySelectorAll('.t-af-color-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        const hex = sw.dataset.color;
        const cIn = document.getElementById('mAfCustomPlateColor');
        if (cIn) cIn.value = hex;
        const stSel = document.getElementById('mAfPlateStyleSelect');
        if (stSel) stSel.value = 'solid';
        editor?.applyPlateStyle('solid', hex);
      });
    });
    document.getElementById('mAfCustomPlateColor')?.addEventListener('input', (e) => {
      const stSel = document.getElementById('mAfPlateStyleSelect');
      if (stSel) stSel.value = 'solid';
      editor?.applyPlateStyle('solid', e.target.value);
    });
    document.getElementById('mAfEyedropBtn')?.addEventListener('click', () => {
      if (editor) editor.setToolMode(editor.toolMode === 'eyedrop' ? 'edit' : 'eyedrop');
    });
    document.getElementById('mAfPlateFeatherSlider')?.addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10);
      const valNorm = Math.max(0, Math.min(1, (isNaN(pct) ? 45 : pct) / 100));
      cfg.plateFeather = valNorm;
      const lbl = document.getElementById('mAfPlateFeatherVal');
      if (lbl) lbl.textContent = `${Math.round(valNorm * 100)}%`;
      editor?.applyPlateStyle(null, null, valNorm);
    });
    document.getElementById('mAfPlateFeatherSlider')?.addEventListener('change', _saveSettings);

    document.getElementById('mAfHazeStyleSelect')?.addEventListener('change', (e) => {
      cfg.faceStyle = e.target.value;
      editor?.applyFaceStyle({ style: cfg.faceStyle });
      _saveSettings();
    });
    document.getElementById('mAfStampRadiusSlider')?.addEventListener('input', (e) => {
      const pct = parseFloat(e.target.value);
      cfg.faceRadius = Math.max(0.015, Math.min(0.35, (isNaN(pct) ? 5.2 : pct) / 100));
      const lbl = document.getElementById('mAfStampRadiusVal');
      if (lbl) lbl.textContent = `${(cfg.faceRadius * 100).toFixed(1)}%`;
      editor?.applyFaceStyle({ radius: cfg.faceRadius });
    });
    document.getElementById('mAfStampRadiusSlider')?.addEventListener('change', _saveSettings);

    document.getElementById('mAfStampStrengthSlider')?.addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10);
      cfg.faceStrength = Math.max(0.4, Math.min(1.0, (isNaN(pct) ? 92 : pct) / 100));
      const lbl = document.getElementById('mAfStampStrengthVal');
      if (lbl) lbl.textContent = `${Math.round(cfg.faceStrength * 100)}%`;
      editor?.applyFaceStyle({ strength: cfg.faceStrength });
    });
    document.getElementById('mAfStampStrengthSlider')?.addEventListener('change', _saveSettings);

    // Step 2
    document.getElementById('mAfFrameEnableCheck')?.addEventListener('change', (e) => {
      cfg.frame.enabled = e.target.checked;
      _syncFormFromState();
      _pushDecoratorToEditor();
      _saveSettings();
    });
    modalEl.querySelectorAll('.t-af-layout-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        cfg.frame.layout = btn.dataset.layout;
        _syncFormFromState();
        _pushDecoratorToEditor();
        _saveSettings();
      });
    });
    document.getElementById('mAfMatteSelect')?.addEventListener('change', (e) => {
      cfg.frame.matte = e.target.value;
      _pushDecoratorToEditor();
      _saveSettings();
    });
    document.getElementById('mAfAspectSelect')?.addEventListener('change', (e) => {
      cfg.frame.aspect_mode = e.target.value;
      _syncFormFromState();
      _pushDecoratorToEditor();
      _saveSettings();
    });
    document.getElementById('mAfBorderSlider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.frame.border_ratio = v / 100;
      const lbl = document.getElementById('mAfBorderVal');
      if (lbl) lbl.textContent = `${v.toFixed(1)}%`;
      _syncFrameExpanderSummaries();
      _pushDecoratorToEditor();
    });
    document.getElementById('mAfBorderSlider')?.addEventListener('change', _saveSettings);
    document.getElementById('mAfFontScaleSlider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.frame.font_scale = v / 100;
      const lbl = document.getElementById('mAfFontScaleVal');
      if (lbl) lbl.textContent = `${v}%`;
      _syncFrameExpanderSummaries();
      _pushDecoratorToEditor();
    });
    document.getElementById('mAfFontScaleSlider')?.addEventListener('change', _saveSettings);

    const bindFrameCheck = (id, key) => {
      document.getElementById(id)?.addEventListener('change', (e) => {
        cfg.frame[key] = e.target.checked;
        _syncFormFromState();
        _pushDecoratorToEditor();
        _saveSettings();
      });
    };
    bindFrameCheck('mAfInnerBorderCheck', 'inner_border');
    bindFrameCheck('mAfPhotoShadowCheck', 'photo_shadow');
    bindFrameCheck('mAfShowCameraCheck', 'show_camera');
    bindFrameCheck('mAfShowLensCheck', 'show_lens');
    bindFrameCheck('mAfShowExposureCheck', 'show_exposure');
    bindFrameCheck('mAfShowDateCheck', 'show_date');
    bindFrameCheck('mAfShowLocationCheck', 'show_location');
    bindFrameCheck('mAfShowNoteCheck', 'show_note');

    document.getElementById('mAfCustomNoteInput')?.addEventListener('input', (e) => {
      cfg.frame.custom_note = e.target.value;
      _pushDecoratorToEditor();
    });
    document.getElementById('mAfCustomNoteInput')?.addEventListener('change', _saveSettings);

    document.getElementById('mAfWmEnableCheck')?.addEventListener('change', (e) => {
      cfg.watermark.enabled = e.target.checked;
      _syncFormFromState();
      _pushDecoratorToEditor();
      _saveSettings();
    });
    modalEl.querySelectorAll('.t-af-wm-type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextType = btn.dataset.wmType === 'image' ? 'image' : 'text';
        if (cfg.watermark.type !== nextType) {
          cfg.watermark.type = nextType;
          cfg.watermark.size_ratio = nextType === 'image' ? 0.16 : 0.018;
        }
        if (nextType === 'image' && !cfg.watermark.asset_id && watermarkAssets.length > 0) {
          _selectWatermarkAsset(watermarkAssets[0]);
        }
        _syncFormFromState();
        _pushDecoratorToEditor();
        _saveSettings();
      });
    });
    document.getElementById('mAfWmAddLogoBtn')?.addEventListener('click', () => {
      const inp = document.getElementById('mAfWmFileInput');
      if (inp) {
        inp.value = '';
        inp.click();
      }
    });
    document.getElementById('mAfWmFileInput')?.addEventListener('change', (e) => {
      const file = e.target && e.target.files ? e.target.files[0] : null;
      if (file) _uploadWatermarkLogoFile(file);
    });
    document.getElementById('mAfWmTextInput')?.addEventListener('input', (e) => {
      cfg.watermark.type = 'text';
      cfg.watermark.text = e.target.value;
      _pushDecoratorToEditor();
    });
    document.getElementById('mAfWmTextInput')?.addEventListener('change', _saveSettings);
    document.getElementById('mAfWmColorSelect')?.addEventListener('change', (e) => {
      cfg.watermark.color = e.target.value;
      _pushDecoratorToEditor();
      _saveSettings();
    });
    document.getElementById('mAfWmShadowCheck')?.addEventListener('change', (e) => {
      cfg.watermark.shadow = e.target.checked;
      _pushDecoratorToEditor();
      _saveSettings();
    });
    modalEl.querySelectorAll('.t-af-wm-pos-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        cfg.watermark.position = btn.dataset.pos;
        _syncFormFromState();
        _pushDecoratorToEditor();
        _saveSettings();
      });
    });
    document.getElementById('mAfWmOpacitySlider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.watermark.opacity = v / 100;
      const lbl = document.getElementById('mAfWmOpacityVal');
      if (lbl) lbl.textContent = `${v}%`;
      _pushDecoratorToEditor();
    });
    document.getElementById('mAfWmOpacitySlider')?.addEventListener('change', _saveSettings);
    document.getElementById('mAfWmSizeSlider')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      cfg.watermark.size_ratio = v / 100;
      const lbl = document.getElementById('mAfWmSizeVal');
      if (lbl) {
        lbl.textContent = cfg.watermark.type === 'image' ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
      }
      _pushDecoratorToEditor();
    });
    document.getElementById('mAfWmSizeSlider')?.addEventListener('change', _saveSettings);

    // Step 3
    document.getElementById('mAfNamingSelect')?.addEventListener('change', (e) => {
      cfg.output.naming_rule = e.target.value;
      _saveSettings();
    });
    document.getElementById('mAfFormatSelect')?.addEventListener('change', (e) => {
      cfg.output.format = e.target.value;
      _syncFormFromState();
      _saveSettings();
    });
    document.getElementById('mAfQualitySlider')?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      cfg.output.quality = v;
      const lbl = document.getElementById('mAfQualityVal');
      if (lbl) lbl.textContent = `${v}%`;
    });
    document.getElementById('mAfQualitySlider')?.addEventListener('change', _saveSettings);
    document.getElementById('mAfExifRemoveAllCheck')?.addEventListener('change', (e) => {
      cfg.output.exif_remove_all = e.target.checked;
      _saveSettings();
    });

    global.addEventListener('resize', () => {
      if (modalEl && modalEl.style.display === 'flex' && editor) {
        _updateCanvasDatasetBounds();
        editor.render();
      }
    });
  }

  function _initModalOnce() {
    if (modalEl && editor) return true;
    if (typeof global.PrivacyMaskCanvasEditor !== 'function') {
      _showToast('Art Framer Canvasエンジンを読み込めません');
      return false;
    }

    let host = document.getElementById('mArtFramerModal');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mArtFramerModal';
      host.className = 't-af-modal';
      host.style.display = 'none';
      host.innerHTML = _buildModalHtml();
      document.body.appendChild(host);
    }
    modalEl = host;

    const canvasEl = document.getElementById('mAfCanvas');
    if (!canvasEl) return false;
    _updateCanvasDatasetBounds();

    editor = new global.PrivacyMaskCanvasEditor(canvasEl, {
      onMasksChange: (info) => {
        _refreshMaskPillsUI(info);
        _updateStep3SummaryUI();
      },
      onZoomChange: (z) => {
        const zEl = document.getElementById('mAfZoomPctBadge');
        if (zEl) zEl.textContent = `${Math.round(z * 100)}%`;
      },
      onToolModeChange: (mode) => {
        modalEl.querySelectorAll('.t-af-tool-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.mode === mode);
        });
        const eyeBtn = document.getElementById('mAfEyedropBtn');
        if (eyeBtn) {
          eyeBtn.classList.toggle('active', mode === 'eyedrop');
          eyeBtn.textContent = mode === 'eyedrop' ? '写真をタップ...' : 'スポイト';
        }
      },
      onEyedropColor: (hex) => {
        const cIn = document.getElementById('mAfCustomPlateColor');
        if (cIn) cIn.value = hex;
      },
      onDimensionsUpdate: (dims) => {
        const badge = document.getElementById('mAfLiveDimBadge');
        if (badge && dims && dims.width > 0) {
          badge.textContent = `${dims.width}×${dims.height}`;
        }
        _updateStep3SummaryUI();
      },
    });

    _bindModalEvents();
    if (!backHandlerRegistered) {
      backHandlerRegistered = true;
      global.__extraBackHandlers = global.__extraBackHandlers || [];
      global.__extraBackHandlers.push(() => {
        if (!modalEl || modalEl.style.display !== 'flex') return undefined;
        if (cfg.step > 1) {
          _setStep(cfg.step - 1);
          return 'handled';
        }
        close(false);
        return 'handled';
      });
    }
    return true;
  }

  /**
   * 選択写真または表示中の写真を対象に Art Framer モーダルを開く
   */
  async function open(explicitIds = null, presetKey = 'for_x') {
    const targets = typeof global.__getMobileArtFramerTargets === 'function'
      ? global.__getMobileArtFramerTargets(explicitIds)
      : [];
    if (!Array.isArray(targets) || targets.length === 0) {
      _showToast('Art Framer で仕上げる写真を選択してください');
      return false;
    }
    if (!_initModalOnce()) return false;

    _loadSavedSettings();
    await _loadWatermarkAssets();
    photoQueue = targets;
    queueIndex = 0;
    exportedCount = 0;
    isBusy = false;

    document.getElementById('mAfFrameSizeExpander')?.removeAttribute('open');
    document.getElementById('mAfCaptionFieldsExpander')?.removeAttribute('open');
    modalEl.style.display = 'flex';
    _applyTargetPreset(presetKey || 'for_x');
    await _loadCurrentQueuePhoto();
    return true;
  }

  function close(force = false) {
    if (!modalEl) return;
    if (!force && isBusy) return;
    loadReqSeq += 1;
    modalEl.style.display = 'none';
  }

  const artFramerApi = {
    open,
    close,
    isOpen: () => Boolean(modalEl && modalEl.style.display === 'flex'),
  };

  global.TetheractTouchUI = Object.assign(global.TetheractTouchUI || {}, {
    artFramer: artFramerApi,
  });
})(window);
