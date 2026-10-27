/**
 * パーソナル撮影ラボ（🧪 ラボ）＆ 🏆 勝ちレンズ・得意設定カルテ モジュール
 *
 * 機能概要:
 * - 左サイドバー「🧪 ラボ」セクション（#accordionItem-lab）内の特殊フィルタ・発掘ツール制御
 * - ラボ特殊フィルタ:
 *   - マジックアワー (golden_hour) / ブルーアワー (blue_hour) / ✨ マジック全域 (magic_all) / 🌃 夜景 (night)
 *   - 手ブレ危険度 (shake_risk: シャッター秒数 × 焦点距離 >= 1.0)
 *   - 🎂 歴代の今日 (onThisDay: MM-DD 形式、月セレクト1〜12月＋日セレクト1〜31日＋今日ボタン)
 *   - 📐 焦点距離レンジ (focalRange) / 絞りF値レンジ (apertureRange)
 * - 🎲 未整理フォルダ発掘ガチャ (GET /api/lab/random-unrated-folder)
 * - 🏆 勝ちレンズ・得意設定カルテ モーダル (#labKarteModal / GET /api/lab/karte):
 *   - タブ1: 🏆 勝ちレンズ＆カメラ番付 (#karteTabLenses)
 *   - タブ2: 📐 黄金の焦点距離 & F値分析 (#karteTabSettings)
 *   - タブ3:  撮影時間帯 & 光の傾向 (#karteTabHours)
 */

(function () {
  'use strict';

  /** カルテAPIの最新レスポンスキャッシュ */
  let latestKarteData = null;

  /** 現在選択中のカルテタブ ('lenses' | 'settings' | 'hours') */
  let activeKarteTab = 'lenses';

  /** ラボ特殊フィルタの表示名マップ */
  const LAB_FILTER_LABELS = {
    golden_hour: 'マジックアワー',
    blue_hour: 'ブルーアワー',
    magic_all: 'マジック＆ブルーアワー',
    night: '夜景・天体',
    shake_risk: '手ブレ注意領域',
  };

  /**
   * HTMLエスケープヘルパー（_escHtml / escapeHtml フォールバック付き）
   * @param {*} str エスケープ対象
   * @returns {string} エスケープ済み文字列
   */
  function escHtml(str) {
    if (str === null || str === undefined) return '';
    if (typeof _escHtml === 'function') return _escHtml(String(str));
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(str));
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * ローカルタイム基準で今日の「MM-DD」文字列と月・日オブジェクトを取得する
   * ※ Date.toISOString() は使用禁止（UTC基準による日付ズレ防止）
   * @returns {{ mmdd: string, month: number, day: number, label: string }}
   */
  function getTodayLocalMmDd() {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return {
      mmdd: `${mm}-${dd}`,
      month,
      day,
      label: `${month}月${day}日`,
    };
  }

  /**
   * 月・日の数値からゼロ埋め「MM-DD」文字列を生成する
   * @param {number|string} month 1〜12
   * @param {number|string} day 1〜31
   * @returns {string} "MM-DD"
   */
  function formatMmDd(month, day) {
    const m = Math.max(1, Math.min(12, parseInt(month, 10) || 1));
    const d = Math.max(1, Math.min(31, parseInt(day, 10) || 1));
    return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /**
   * "MM-DD" 文字列を「M月D日」形式に整形する
   * @param {string} mmdd "MM-DD"
   * @returns {string}
   */
  function formatMmDdJapanese(mmdd) {
    if (!mmdd || typeof mmdd !== 'string' || !mmdd.includes('-')) return '';
    const parts = mmdd.split('-');
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    if (isNaN(m) || isNaN(d)) return mmdd;
    return `${m}月${d}日`;
  }

  /**
   * グローバル state にラボ関連プロパティが未定義の場合に初期化する
   */
  function ensureLabStateInitialized() {
    if (typeof state === 'undefined' || !state) return;
    if (state.labFilter === undefined) state.labFilter = null;
    if (state.onThisDay === undefined) state.onThisDay = null;
    if (state.focalRange === undefined) state.focalRange = null;
    if (state.focalRangeLabel === undefined) state.focalRangeLabel = null;
    if (state.apertureRange === undefined) state.apertureRange = null;
    if (state.apertureRangeLabel === undefined) state.apertureRangeLabel = null;
    if (state.selectedLenses === undefined) state.selectedLenses = new Set();
  }

  /**
   * ラボフィルタ変更時にメイングリッド・タイムライン・フィルタチップ・UI状態を同期更新する
   */
  function notifyLabFilterChanged() {
    if (typeof state !== 'undefined' && state) {
      state.currentPage = 1;
    }
    if (typeof fetchPhotos === 'function') {
      fetchPhotos();
    }
    if (typeof updateTimelineFilterState === 'function') {
      updateTimelineFilterState();
    }
    if (typeof renderActiveFilterChips === 'function') {
      renderActiveFilterChips();
    }
    updateLabUIState();
  }

  /**
   * 左サイドバー「🧪 ラボ」セクションのDOM要素を確認し、未構築であれば構築・補完する
   */
  function ensureLabSidebarControls() {
    const labItem = document.getElementById('accordionItem-lab');
    if (!labItem) return;

    const body = labItem.querySelector('.accordion-body');
    if (!body) return;

    const today = getTodayLocalMmDd();

    // もし accordion-body 内にボタンがまだ配置されていない場合は標準ラボUIを構築
    if (!body.querySelector('[data-lab-filter], #labOnThisDayBtn, #openLabKarteModalBtn, #labGachaBtn')) {
      body.innerHTML = `
        <div class="lab-sidebar-panel" style="display: flex; flex-direction: column; gap: 10px;">
          <!-- 1. 勝ちレンズ・得意設定カルテ & 2枚比較 -->
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <button type="button" class="btn btn-secondary btn-sm" id="openLabKarteModalBtn" style="width: 100%; justify-content: center; gap: 6px; font-weight: 600;">
              <span>勝ちレンズ・得意設定カルテ</span>
            </button>
            <div style="display: flex; gap: 6px;">
              <button type="button" class="btn btn-secondary btn-sm" id="labGachaBtn" style="flex: 1; justify-content: center; gap: 4px;" title="未整理（可）の写真が残っているフォルダをランダムに1つ引き当てます">
                <span>未整理ガチャ</span>
              </button>
              <button type="button" class="btn btn-secondary btn-sm" id="labOpenCompareBtn" style="flex: 1; justify-content: center; gap: 4px;" title="選択した2枚の写真を並べて同期ズーム＆Exif比較 (V)">
                <span>2枚比較 (V)</span>
              </button>
            </div>
          </div>

          <!-- 2. 歴代の今日 (On This Day) -->
          <div class="lab-otd-box" style="padding: 8px; border-radius: 6px; background: var(--bg-tertiary, #252b34); border: 1px solid var(--border-soft, #2f3642);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <span style="font-size: 0.76rem; font-weight: 600; color: var(--text-secondary, #cbd5e1);">歴代の今日・記念日</span>
              <button type="button" class="btn-mini-text" id="labOnThisDayTodayBtn" title="今日の日付（${escHtml(today.label)}）に戻す">今日</button>
            </div>
            <div style="display: flex; align-items: center; gap: 4px;">
              <select id="labOnThisDayMonth" class="form-select-sm" style="flex: 1; padding: 4px; border-radius: 4px; background: var(--bg-secondary, #1b2028); color: var(--text-primary, #f1f5f9); border: 1px solid var(--border-soft, #2f3642); font-size: 0.78rem;" title="月を選択"></select>
              <select id="labOnThisDayDay" class="form-select-sm" style="flex: 1; padding: 4px; border-radius: 4px; background: var(--bg-secondary, #1b2028); color: var(--text-primary, #f1f5f9); border: 1px solid var(--border-soft, #2f3642); font-size: 0.78rem;" title="日を選択"></select>
              <button type="button" class="btn btn-secondary btn-xs" id="labOnThisDayBtn" data-lab-action="on-this-day" style="white-space: nowrap; padding: 4px 8px;" title="指定した月日の歴代写真を抽出・解除">
                抽出
              </button>
            </div>
          </div>

          <!-- 3. 光のマジックアワー＆手ブレ抽出 -->
          <div style="display: flex; flex-direction: column; gap: 5px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span style="font-size: 0.74rem; color: var(--text-muted, #94a3b8); font-weight: 600;">太陽高度・露出ラボ抽出</span>
              <button type="button" class="btn-mini-text" id="clearLabFilterBtn" style="display: none;" title="ラボの絞り込み条件をすべて解除">クリア</button>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
              <button type="button" class="btn btn-secondary btn-xs lab-filter-btn" id="labBtnGoldenHour" data-lab-filter="golden_hour" title="太陽高度 -4°〜+6° のドラマチックな光（朝焼け・夕焼け）で撮影した写真を抽出">
                マジックアワー
              </button>
              <button type="button" class="btn btn-secondary btn-xs lab-filter-btn" id="labBtnBlueHour" data-lab-filter="blue_hour" title="太陽高度 -8°〜-4° の静謐な蒼い薄明時間帯の写真を抽出">
                ブルーアワー
              </button>
              <button type="button" class="btn btn-secondary btn-xs lab-filter-btn" id="labBtnNight" data-lab-filter="night" title="太陽高度 -8°未満の夜景・星景写真を抽出">
                夜景・星景
              </button>
              <button type="button" class="btn btn-secondary btn-xs lab-filter-btn" id="labBtnShakeRisk" data-lab-filter="shake_risk" title="シャッター速度 < 1/焦点距離 秒 の微ブレ危険領域にある写真を抽出">
                手ブレ注意
              </button>
            </div>
          </div>
        </div>
      `;
    }

    // 月・日セレクトボックスの選択肢生成と初期値（今日）設定
    const monthSelect = document.getElementById('labOnThisDayMonth') || document.getElementById('onThisDayMonthSelect') || document.getElementById('labMonthSelect');
    const daySelect = document.getElementById('labOnThisDayDay') || document.getElementById('onThisDayDaySelect') || document.getElementById('labDaySelect');

    if (monthSelect && monthSelect.options.length === 0) {
      for (let m = 1; m <= 12; m++) {
        const opt = document.createElement('option');
        opt.value = String(m).padStart(2, '0');
        opt.textContent = `${m}月`;
        monthSelect.appendChild(opt);
      }
      monthSelect.value = String(today.month).padStart(2, '0');
    }

    if (daySelect && daySelect.options.length === 0) {
      for (let d = 1; d <= 31; d++) {
        const opt = document.createElement('option');
        opt.value = String(d).padStart(2, '0');
        opt.textContent = `${d}日`;
        daySelect.appendChild(opt);
      }
      daySelect.value = String(today.day).padStart(2, '0');
    }
  }

  /**
   * 「🏆 勝ちレンズ・得意設定カルテ」モーダル（#labKarteModal）のDOMが存在しない場合は生成し、
   * 内部のタブ・コンテナ構造を保証する
   * @returns {HTMLElement}
   */
  function ensureLabKarteModalDom() {
    let modal = document.getElementById('labKarteModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'labKarteModal';
      modal.className = 'modal-backdrop';
      modal.style.display = 'none';
      document.body.appendChild(modal);
    }

    if (!modal.querySelector('#karteTabLenses') || !modal.querySelector('#karteTabSettings') || !modal.querySelector('#karteTabHours')) {
      modal.innerHTML = `
        <div class="modal-card modal-card-lg lab-karte-modal-card" style="max-width: 960px; width: 94vw; max-height: 88vh; display: flex; flex-direction: column;">
          <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border-soft, #2f3642);">
            <div class="modal-header-title">
              <h2 style="margin: 0; font-size: 1.12rem; display: flex; align-items: center; gap: 8px;">
                <span>勝ちレンズ・得意設定カルテ（パーソナル撮影ラボ）</span>
              </h2>
              <span class="modal-subtitle" style="font-size: 0.78rem; color: var(--text-muted, #94a3b8);">
                これまでの評価（優・良）から、あなたと最も相性の良い機材・焦点距離・F値・時間帯を診断します
              </span>
            </div>
            <button type="button" class="modal-close-btn" id="closeLabKarteModalBtn" title="閉じる (Esc)">&times;</button>
          </div>

          <!-- 上部サマリーバー（クリック不可の静的な統計枠 .lab-stat-box） -->
          <div id="labKarteSummaryBar" class="lab-karte-summary-bar" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 12px 20px; background: var(--bg-tertiary, #252b34); border-bottom: 1px solid var(--border-soft, #2f3642);"></div>

          <!-- アンダーラインタブバー（四角い枠線を持たない .lab-tab-btn） -->
          <div class="lab-tabs-nav" id="labKarteTabsNav" style="display: flex; gap: 20px; padding: 0 20px; border-bottom: 1px solid var(--border-soft, #2f3642); background: var(--bg-secondary, #1b2028);">
            <button type="button" class="lab-tab-btn active" data-karte-tab="lenses" style="padding: 11px 4px; background: transparent; border: none; border-bottom: 2px solid var(--accent-primary, #e14d2a); color: var(--text-primary, #f1f5f9); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
              勝ちレンズ＆カメラ番付
            </button>
            <button type="button" class="lab-tab-btn" data-karte-tab="settings" style="padding: 11px 4px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #94a3b8); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
              黄金の焦点距離 &amp; F値分析
            </button>
            <button type="button" class="lab-tab-btn" data-karte-tab="hours" style="padding: 11px 4px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #94a3b8); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
               撮影時間帯 &amp; 光の傾向
            </button>
          </div>

          <!-- タブコンテンツ本体 -->
          <div class="modal-body lab-karte-modal-body" style="padding: 18px 20px; overflow-y: auto; flex: 1;">
            <div id="karteTabLenses" class="lab-tab-pane active"></div>
            <div id="karteTabSettings" class="lab-tab-pane" style="display: none;"></div>
            <div id="karteTabHours" class="lab-tab-pane" style="display: none;"></div>
          </div>
        </div>
      `;
    }

    return modal;
  }

  /**
   * カルテモーダル内のタブを切り替える
   * @param {string} tabName 'lenses' | 'settings' | 'hours'
   */
  function switchKarteTab(tabName) {
    activeKarteTab = tabName || 'lenses';
    const modal = document.getElementById('labKarteModal');
    if (!modal) return;

    const tabBtns = modal.querySelectorAll('.lab-tab-btn[data-karte-tab], .lab-tab-btn[data-tab]');
    tabBtns.forEach(btn => {
      const t = btn.dataset.karteTab || btn.dataset.tab;
      const isActive = t === activeKarteTab;
      btn.classList.toggle('active', isActive);
      btn.style.borderBottomColor = isActive ? 'var(--accent-primary, #e14d2a)' : 'transparent';
      btn.style.color = isActive ? 'var(--text-primary, #f1f5f9)' : 'var(--text-muted, #94a3b8)';
    });

    const panes = {
      lenses: document.getElementById('karteTabLenses'),
      settings: document.getElementById('karteTabSettings'),
      hours: document.getElementById('karteTabHours'),
    };
    Object.keys(panes).forEach(key => {
      const el = panes[key];
      if (!el) return;
      const isMatch = key === activeKarteTab;
      el.classList.toggle('active', isMatch);
      el.style.display = isMatch ? 'block' : 'none';
    });
  }

  /**
   * カルテモーダルを閉じる
   */
  function closeLabKarteModal() {
    const modal = document.getElementById('labKarteModal');
    if (modal) {
      modal.style.display = 'none';
    }
  }
  window.closeLabKarteModal = closeLabKarteModal;

  /**
   * ラボ特殊フィルタの適用・解除を行う
   * @param {string|null} filterType 'shake_risk' | 'golden_hour' | 'blue_hour' | 'magic_all' | 'night' | 'on_this_day' | 'focal_range' | 'aperture_range' | 'clear_all' | null
   * @param {*} extraValue 追加パラメータ（MM-DD文字列やレンジオブジェクト等）
   */
  function applyLabFilter(filterType, extraValue) {
    ensureLabStateInitialized();
    if (typeof state === 'undefined' || !state) return;

    if (!filterType || filterType === 'clear_all' || filterType === 'clear') {
      state.labFilter = null;
      state.onThisDay = null;
      state.focalRange = null;
      state.focalRangeLabel = null;
      state.apertureRange = null;
      state.apertureRangeLabel = null;
      notifyLabFilterChanged();
      return;
    }

    if (filterType === 'on_this_day') {
      // extraValue が明示指定されていれば設定、同じ値またはトグル指定なら解除
      const monthSelect = document.getElementById('labOnThisDayMonth') || document.getElementById('onThisDayMonthSelect') || document.getElementById('labMonthSelect');
      const daySelect = document.getElementById('labOnThisDayDay') || document.getElementById('onThisDayDaySelect') || document.getElementById('labDaySelect');
      let targetMmDd = typeof extraValue === 'string' && extraValue.includes('-') ? extraValue.trim() : null;
      if (!targetMmDd) {
        if (monthSelect && daySelect && monthSelect.value && daySelect.value) {
          targetMmDd = formatMmDd(monthSelect.value, daySelect.value);
        } else {
          targetMmDd = getTodayLocalMmDd().mmdd;
        }
      }

      if (extraValue === null || (state.onThisDay === targetMmDd && !extraValue)) {
        state.onThisDay = null;
      } else {
        state.onThisDay = targetMmDd;
        // セレクトボックスの表示も同期
        const parts = targetMmDd.split('-');
        if (monthSelect && parts[0]) monthSelect.value = parts[0];
        if (daySelect && parts[1]) daySelect.value = parts[1];
        if (typeof showToast === 'function') {
          showToast(`歴代の ${formatMmDdJapanese(targetMmDd)} に撮影された写真を表示します`, 'info', 2600);
        }
      }
      notifyLabFilterChanged();
      return;
    }

    if (filterType === 'focal_range') {
      if (!extraValue) {
        state.focalRange = null;
        state.focalRangeLabel = null;
      } else if (typeof extraValue === 'object') {
        const rangeKey = extraValue.range || extraValue.key || null;
        if (state.focalRange === rangeKey) {
          state.focalRange = null;
          state.focalRangeLabel = null;
        } else {
          state.focalRange = rangeKey;
          state.focalRangeLabel = extraValue.label || rangeKey;
        }
      } else {
        const rangeStr = String(extraValue);
        state.focalRange = state.focalRange === rangeStr ? null : rangeStr;
        state.focalRangeLabel = state.focalRange;
      }
      notifyLabFilterChanged();
      return;
    }

    if (filterType === 'aperture_range') {
      if (!extraValue) {
        state.apertureRange = null;
        state.apertureRangeLabel = null;
      } else if (typeof extraValue === 'object') {
        const rangeKey = extraValue.range || extraValue.key || null;
        if (state.apertureRange === rangeKey) {
          state.apertureRange = null;
          state.apertureRangeLabel = null;
        } else {
          state.apertureRange = rangeKey;
          state.apertureRangeLabel = extraValue.label || rangeKey;
        }
      } else {
        const rangeStr = String(extraValue);
        state.apertureRange = state.apertureRange === rangeStr ? null : rangeStr;
        state.apertureRangeLabel = state.apertureRange;
      }
      notifyLabFilterChanged();
      return;
    }

    // 太陽高度・露出リスク系フィルタ ('shake_risk' | 'golden_hour' | 'blue_hour' | 'magic_all' | 'night')
    const normalized = String(filterType).trim().toLowerCase();
    if (state.labFilter === normalized && extraValue !== true) {
      state.labFilter = null;
    } else {
      state.labFilter = normalized;
      const label = LAB_FILTER_LABELS[normalized] || normalized;
      if (typeof showToast === 'function') {
        showToast(`${label} で写真を絞り込みました`, 'info', 2500);
      }
    }
    notifyLabFilterChanged();
  }
  window.applyLabFilter = applyLabFilter;

  /**
   * カルテ内の「🔍 このレンズで絞り込む」ボタン押下時の処理
   * @param {Object} lensItem カルテのレンズ行データ
   */
  function applyLensFilterFromKarte(lensItem) {
    if (!lensItem || typeof state === 'undefined' || !state) return;
    ensureLabStateInitialized();

    const filterKey = lensItem.filter_key || `${lensItem.camera_model || '不明'}::${lensItem.lens_model || '__NONE__'}`;
    const fullLabel = lensItem.full_label || `${lensItem.camera_model || ''} / ${lensItem.label || lensItem.lens_model || ''}`;

    // 既存のカメラ・レンズ選択をクリアしてこのレンズをセット
    if (state.cameraFilters instanceof Map) {
      state.cameraFilters.clear();
    }
    if (state.selectedCameras instanceof Set) {
      state.selectedCameras.clear();
    }
    if (state.lensFilters instanceof Map) {
      state.lensFilters.clear();
      state.lensFilters.set(filterKey, 'include');
    }
    if (!(state.selectedLenses instanceof Set)) {
      state.selectedLenses = new Set();
    } else {
      state.selectedLenses.clear();
    }
    state.selectedLenses.add(filterKey);
    state.selectedLensLabel = fullLabel;

    // 外部ヘルパーが定義されている場合は呼び出す
    if (typeof window.selectLensFilter === 'function') {
      window.selectLensFilter(filterKey, fullLabel);
    } else if (typeof window.renderCameras === 'function' && state.availableCameras) {
      window.renderCameras(state.availableCameras);
    }
    if (typeof updateCameraActiveClasses === 'function') {
      updateCameraActiveClasses();
    }

    closeLabKarteModal();
    notifyLabFilterChanged();

    if (typeof showToast === 'function') {
      showToast(`レンズ「${fullLabel}」で絞り込みました`, 'info', 2800);
    }
  }

  /**
   * カルテ内の「🔍 このカメラで絞り込む」ボタン押下時の処理
   * @param {string} cameraModel カメラモデル名
   */
  function applyCameraFilterFromKarte(cameraModel) {
    if (!cameraModel || typeof state === 'undefined' || !state) return;
    ensureLabStateInitialized();

    if (state.lensFilters instanceof Map) {
      state.lensFilters.clear();
    }
    if (state.selectedLenses instanceof Set) {
      state.selectedLenses.clear();
    }
    if (state.cameraFilters instanceof Map) {
      state.cameraFilters.clear();
      state.cameraFilters.set(cameraModel, 'include');
    }
    if (!(state.selectedCameras instanceof Set)) {
      state.selectedCameras = new Set();
    } else {
      state.selectedCameras.clear();
    }
    state.selectedCameras.add(cameraModel);
    state.currentFilter = { type: 'camera', value: cameraModel };

    if (typeof updateCameraActiveClasses === 'function') {
      updateCameraActiveClasses();
    }

    closeLabKarteModal();
    notifyLabFilterChanged();

    if (typeof showToast === 'function') {
      showToast(`カメラ「${cameraModel}」で絞り込みました`, 'info', 2800);
    }
  }

  /**
   * 「🎲 未整理フォルダ発掘ガチャ」を実行する
   * GET /api/lab/random-unrated-folder を呼び出し、未整理写真（可:0）が残るフォルダへジャンプ
   */
  async function triggerRandomUnratedFolderGacha() {
    ensureLabStateInitialized();
    try {
      const response = await fetch('/api/lab/random-unrated-folder');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();

      if (!data || !data.found || !data.folder_path) {
        if (typeof showToast === 'function') {
          showToast('未整理（評価：可）の写真が残っているフォルダはありません！すべて整理済みです。', 'success', 3500);
        }
        return;
      }

      if (typeof state !== 'undefined' && state) {
        // 仕様通り state.selectedFolders と state.selectedRating を設定
        state.selectedFolders = new Set([data.folder_path]);
        state.selectedRating = '0';

        // 既存のフォルダフィルタ・評価トグルとも完全同期
        state.currentFilter = { type: 'folder', value: data.folder_path };
        state.unlinkedOnly = false;
        state.duplicatesOnly = false;
        state.untaggedOnly = false;
        if (state.selectedYearMonths instanceof Set) {
          state.selectedYearMonths.clear();
        }
        if (state.activeRatings instanceof Set) {
          state.activeRatings.add(0);
        }
      }

      const viewTitleEl = document.getElementById('viewTitle');
      if (viewTitleEl) {
        viewTitleEl.textContent = `${data.folder_name || data.folder_path}`;
      }

      // フォルダツリーの選択ハイライト同期（存在すれば）
      if (typeof window.highlightSelectedFolderInTree === 'function') {
        window.highlightSelectedFolderInTree(data.folder_path);
      }

      notifyLabFilterChanged();

      if (typeof showToast === 'function') {
        showToast(
          `発掘ガチャ: 「${data.folder_name}」（未整理 ${data.unrated_count}枚）を引き当てました`,
          'success',
          4000
        );
      }
    } catch (err) {
      console.error('未整理フォルダ発掘ガチャエラー:', err);
      if (typeof showToast === 'function') {
        showToast(`未整理フォルダの抽選に失敗しました: ${err.message}`, 'error', 3000);
      }
    }
  }
  window.triggerRandomUnratedFolderGacha = triggerRandomUnratedFolderGacha;

  /**
   * state.labFilter, state.onThisDay, state.focalRange, state.apertureRange に応じて
   * 左サイドバー内の各ボタン .active 状態と #accordionItem-lab の .has-filter クラスを更新する
   */
  function updateLabUIState() {
    ensureLabStateInitialized();
    if (typeof state === 'undefined' || !state) return;

    const labAccordion = document.getElementById('accordionItem-lab');
    const hasAnyLabFilter = Boolean(
      state.labFilter || state.onThisDay || state.focalRange || state.apertureRange
    );

    if (labAccordion) {
      labAccordion.classList.toggle('has-filter', hasAnyLabFilter);
    }

    // 太陽高度・手ブレ等のラボフィルタボタン (.active 切替)
    document.querySelectorAll('[data-lab-filter]').forEach(btn => {
      const fType = (btn.dataset.labFilter || '').trim().toLowerCase();
      if (fType === 'on_this_day') {
        btn.classList.toggle('active', Boolean(state.onThisDay));
      } else {
        btn.classList.toggle('active', state.labFilter === fType);
      }
    });

    // 🎂 歴代の今日ボタン
    const otdBtns = document.querySelectorAll('#labOnThisDayBtn, #labBtnOnThisDay, [data-lab-action="on-this-day"]');
    otdBtns.forEach(btn => {
      const isOtdActive = Boolean(state.onThisDay);
      btn.classList.toggle('active', isOtdActive);
      if (btn.id === 'labOnThisDayBtn') {
        btn.textContent = isOtdActive ? `抽出中` : `抽出`;
      }
    });

    // 歴代の今日が有効な場合、セレクトボックスの値も同期
    if (state.onThisDay && state.onThisDay.includes('-')) {
      const [mm, dd] = state.onThisDay.split('-');
      const monthSelect = document.getElementById('labOnThisDayMonth') || document.getElementById('onThisDayMonthSelect') || document.getElementById('labMonthSelect');
      const daySelect = document.getElementById('labOnThisDayDay') || document.getElementById('onThisDayDaySelect') || document.getElementById('labDaySelect');
      if (monthSelect && mm) monthSelect.value = mm;
      if (daySelect && dd) daySelect.value = dd;
    }

    // クリアボタンの表示切替
    const clearBtns = document.querySelectorAll('#clearLabFilterBtn, #labClearFilterBtn, [data-lab-action="clear"]');
    clearBtns.forEach(btn => {
      btn.style.display = hasAnyLabFilter ? 'inline-flex' : 'none';
    });
  }
  window.updateLabUIState = updateLabUIState;

  /**
   * カルテモーダル上部のサマリーバー（静的枠 .lab-stat-box）を描画する
   * @param {Object} summary
   */
  function renderKarteSummaryBar(summary) {
    const bar = document.getElementById('labKarteSummaryBar') || document.getElementById('karteSummaryBar');
    if (!bar || !summary) return;

    const total = Number(summary.total_photos || 0);
    const exc = Number(summary.excellent_count || 0);
    const good = Number(summary.good_count || 0);
    const excRate = Number(summary.overall_excellent_rate || 0).toFixed(1);
    const hitRate = Number(summary.overall_hit_rate || 0).toFixed(1);
    const magicCount = Number(summary.magic_all_count ?? (Number(summary.golden_hour_count || 0) + Number(summary.blue_hour_count || 0)));

    bar.innerHTML = `
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">分析対象写真</div>
        <div style="font-size: 1.08rem; font-weight: 700; color: var(--text-primary, #f1f5f9); margin-top: 2px;">
          ${total.toLocaleString()} <span style="font-size: 0.76rem; font-weight: 400; color: var(--text-muted, #94a3b8);">枚</span>
        </div>
      </div>
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">「優」獲得数 / 打率</div>
        <div style="font-size: 1.08rem; font-weight: 700; color: var(--accent-primary, #e14d2a); margin-top: 2px;">
          ${exc.toLocaleString()}枚 <span class="badge-sub" style="margin-left: 4px;">${excRate}%</span>
        </div>
      </div>
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">好評価（優＋良）率</div>
        <div style="font-size: 1.08rem; font-weight: 700; color: #f59e0b; margin-top: 2px;">
          ${(exc + good).toLocaleString()}枚 <span class="badge-sub" style="margin-left: 4px;">${hitRate}%</span>
        </div>
      </div>
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">薄明マジック＆ブルー</div>
        <div style="font-size: 1.08rem; font-weight: 700; color: var(--text-primary, #f1f5f9); margin-top: 2px;">
          ${magicCount.toLocaleString()} <span style="font-size: 0.76rem; font-weight: 400; color: var(--text-muted, #94a3b8);">枚</span>
        </div>
      </div>
    `;
  }

  /**
   * タブ1: 🏆 勝ちレンズ＆カメラ番付 (#karteTabLenses) を描画する
   * @param {Object} data カルテAPIレスポンス
   */
  function renderKarteLensesTab(data) {
    const container = document.getElementById('karteTabLenses');
    if (!container) return;

    const lenses = Array.isArray(data.lenses) ? data.lenses : [];
    const cameras = Array.isArray(data.cameras) ? data.cameras : [];

    if (lenses.length === 0 && cameras.length === 0) {
      container.innerHTML = `<div class="empty-hint" style="padding: 32px; text-align: center;">レンズ・カメラ情報が記録された写真がありません</div>`;
      return;
    }

    // レンズランキングの最大枚数（バー比率計算用）
    const maxLensTotal = Math.max(1, ...lenses.map(l => Number(l.total || 0)));

    const lensRowsHtml = lenses.map((item, idx) => {
      const rank = idx + 1;
      const medal = `${rank}.`;
      const excRate = Number(item.excellent_rate || 0).toFixed(1);
      const hitRate = Number(item.hit_rate || 0).toFixed(1);
      const totalPct = Math.min(100, Math.round((Number(item.total || 0) / maxLensTotal) * 100));

      return `
        <div class="lab-karte-row" style="display: grid; grid-template-columns: 36px minmax(200px, 1.6fr) minmax(170px, 1.2fr) minmax(150px, 1fr) auto; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border-soft, #2f3642); background: var(--bg-secondary, #1b2028);">
          <div style="font-weight: 700; font-size: 0.92rem; text-align: center; color: var(--text-secondary, #cbd5e1);">${medal}</div>
          <div style="min-width: 0;">
            <div style="font-weight: 600; font-size: 0.88rem; color: var(--text-primary, #f1f5f9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(item.label)}">
              ${escHtml(item.label)}
            </div>
            <div style="font-size: 0.74rem; color: var(--text-muted, #94a3b8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(item.camera_model)}">
              ${escHtml(item.camera_model)}
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span class="badge-sub" title="総撮影枚数">${Number(item.total || 0).toLocaleString()}枚</span>
            <span class="badge-sub" style="color: var(--accent-primary, #e14d2a);" title="優 (Excellent) 枚数">優 ${Number(item.excellent || 0)}</span>
            <span class="badge-sub" style="color: #f59e0b;" title="良 (Good) 枚数">良 ${Number(item.good || 0)}</span>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; font-size: 0.74rem; margin-bottom: 3px;">
              <span style="color: var(--accent-primary, #e14d2a); font-weight: 700;">優打率 ${excRate}%</span>
              <span style="color: var(--text-muted, #94a3b8);">好評価 ${hitRate}%</span>
            </div>
            <div style="height: 7px; border-radius: 4px; background: var(--bg-tertiary, #252b34); overflow: hidden; position: relative;" title="優打率: ${excRate}% / 好評価率: ${hitRate}% (出動比率: ${totalPct}%)">
              <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.min(100, Number(item.hit_rate || 0))}%; background: rgba(245, 158, 11, 0.45);"></div>
              <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.min(100, Number(item.excellent_rate || 0))}%; background: var(--accent-primary, #e14d2a);"></div>
            </div>
          </div>
          <div style="text-align: right;">
            <button type="button" class="btn btn-secondary btn-xs js-karte-filter-lens-btn" data-lens-index="${idx}" title="このカメラ＆レンズの組み合わせでメイングリッドを絞り込む">
              このレンズで絞り込む
            </button>
          </div>
        </div>
      `;
    }).join('');

    const cameraRowsHtml = cameras.map((cam, idx) => {
      const rank = idx + 1;
      const excRate = Number(cam.excellent_rate || 0).toFixed(1);
      const hitRate = Number(cam.hit_rate || 0).toFixed(1);
      return `
        <div class="lab-karte-row" style="display: grid; grid-template-columns: 36px minmax(180px, 1.5fr) minmax(160px, 1.1fr) minmax(140px, 1fr) auto; align-items: center; gap: 12px; padding: 9px 12px; border-bottom: 1px solid var(--border-soft, #2f3642); background: var(--bg-secondary, #1b2028);">
          <div style="font-weight: 700; font-size: 0.85rem; text-align: center; color: var(--text-muted, #94a3b8);">${rank}.</div>
          <div style="font-weight: 600; font-size: 0.86rem; color: var(--text-primary, #f1f5f9); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(cam.camera_model)}">
            ${escHtml(cam.camera_model)}
          </div>
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span class="badge-sub">${Number(cam.total || 0).toLocaleString()}枚</span>
            <span class="badge-sub" style="color: var(--accent-primary, #e14d2a);">優 ${Number(cam.excellent || 0)}</span>
            <span class="badge-sub" style="color: #f59e0b;">良 ${Number(cam.good || 0)}</span>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; font-size: 0.73rem; margin-bottom: 3px;">
              <span style="color: var(--accent-primary, #e14d2a); font-weight: 700;">優打率 ${excRate}%</span>
              <span style="color: var(--text-muted, #94a3b8);">好評価 ${hitRate}%</span>
            </div>
            <div style="height: 6px; border-radius: 3px; background: var(--bg-tertiary, #252b34); overflow: hidden; position: relative;">
              <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.min(100, Number(cam.hit_rate || 0))}%; background: rgba(245, 158, 11, 0.45);"></div>
              <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.min(100, Number(cam.excellent_rate || 0))}%; background: var(--accent-primary, #e14d2a);"></div>
            </div>
          </div>
          <div style="text-align: right;">
            <button type="button" class="btn btn-secondary btn-xs js-karte-filter-camera-btn" data-camera-model="${escHtml(cam.camera_model)}">
              このカメラで絞り込む
            </button>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 18px;">
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <h3 style="margin: 0; font-size: 0.95rem; color: var(--text-primary, #f1f5f9);">レンズ別「優」獲得打率ランキング</h3>
            <span class="badge-sub">${lenses.length} 本のレンズを分析</span>
          </div>
          <div style="border: 1px solid var(--border-soft, #2f3642); border-radius: 8px; overflow: hidden;">
            ${lensRowsHtml}
          </div>
        </div>

        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <h3 style="margin: 0; font-size: 0.95rem; color: var(--text-primary, #f1f5f9);">カメラボディ別 歩留まり番付</h3>
            <span class="badge-sub">${cameras.length} 機種</span>
          </div>
          <div style="border: 1px solid var(--border-soft, #2f3642); border-radius: 8px; overflow: hidden;">
            ${cameraRowsHtml}
          </div>
        </div>
      </div>
    `;

    // レンズ絞り込みボタンのイベント登録
    container.querySelectorAll('.js-karte-filter-lens-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.lensIndex, 10);
        if (!isNaN(idx) && lenses[idx]) {
          applyLensFilterFromKarte(lenses[idx]);
        }
      });
    });

    // カメラ絞り込みボタンのイベント登録
    container.querySelectorAll('.js-karte-filter-camera-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const camModel = btn.dataset.cameraModel;
        if (camModel) {
          applyCameraFilterFromKarte(camModel);
        }
      });
    });
  }

  /**
   * タブ2: 📐 黄金の焦点距離 & F値分析 (#karteTabSettings) を描画する
   * @param {Object} data カルテAPIレスポンス
   */
  function renderKarteSettingsTab(data) {
    const container = document.getElementById('karteTabSettings');
    if (!container) return;

    const focalRanges = Array.isArray(data.focal_ranges) ? data.focal_ranges : [];
    const apertureRanges = Array.isArray(data.aperture_ranges) ? data.aperture_ranges : [];

    const maxFocalTotal = Math.max(1, ...focalRanges.map(r => Number(r.total || 0)));
    const maxApertureTotal = Math.max(1, ...apertureRanges.map(r => Number(r.total || 0)));

    // 最も優打率が高いスイートスポットを検出（最低3枚以上撮影している区分を優先）
    const bestFocal = [...focalRanges]
      .filter(r => Number(r.total || 0) >= 3)
      .sort((a, b) => Number(b.excellent_rate || 0) - Number(a.excellent_rate || 0))[0]
      || [...focalRanges].sort((a, b) => Number(b.total || 0) - Number(a.total || 0))[0];

    const bestAperture = [...apertureRanges]
      .filter(r => Number(r.total || 0) >= 3)
      .sort((a, b) => Number(b.excellent_rate || 0) - Number(a.excellent_rate || 0))[0]
      || [...apertureRanges].sort((a, b) => Number(b.total || 0) - Number(a.total || 0))[0];

    const buildRangeRows = (ranges, maxTotal, rangeType) => {
      return ranges.map((item, idx) => {
        const rKey = item.range || item.key || '';
        const tot = Number(item.total || 0);
        const exc = Number(item.excellent || 0);
        const good = Number(item.good || 0);
        const excRate = Number(item.excellent_rate || 0).toFixed(1);
        const hitRate = Number(item.hit_rate || 0).toFixed(1);
        const countPct = Math.min(100, Math.round((tot / maxTotal) * 100));
        const isCurrentActive =
          (rangeType === 'focal' && state.focalRange === rKey) ||
          (rangeType === 'aperture' && state.apertureRange === rKey);

        return `
          <div class="lab-karte-setting-row" style="display: grid; grid-template-columns: minmax(175px, 1.3fr) minmax(130px, 1fr) minmax(170px, 1.4fr) auto; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border-soft, #2f3642); background: var(--bg-secondary, #1b2028);">
            <div>
              <div style="font-weight: 600; font-size: 0.86rem; color: var(--text-primary, #f1f5f9);">${escHtml(item.label)}</div>
              <div style="display: flex; gap: 6px; margin-top: 3px;">
                <span class="badge-sub">${tot.toLocaleString()}枚</span>
                <span class="badge-sub" style="color: var(--accent-primary, #e14d2a);">優 ${exc}</span>
                <span class="badge-sub" style="color: #f59e0b;">良 ${good}</span>
              </div>
            </div>
            <div>
              <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8); margin-bottom: 3px;">撮影枚数シェア</div>
              <div style="height: 6px; border-radius: 3px; background: var(--bg-tertiary, #252b34); overflow: hidden;">
                <div style="height: 100%; width: ${countPct}%; background: #3b82f6;"></div>
              </div>
            </div>
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 0.73rem; margin-bottom: 3px;">
                <span style="color: var(--accent-primary, #e14d2a); font-weight: 700;">優打率 ${excRate}%</span>
                <span style="color: var(--text-muted, #94a3b8);">好評価 ${hitRate}%</span>
              </div>
              <div style="height: 7px; border-radius: 4px; background: var(--bg-tertiary, #252b34); overflow: hidden; position: relative;">
                <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.min(100, Number(item.hit_rate || 0))}%; background: rgba(245, 158, 11, 0.45);"></div>
                <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.min(100, Number(item.excellent_rate || 0))}%; background: var(--accent-primary, #e14d2a);"></div>
              </div>
            </div>
            <div style="text-align: right;">
              <button type="button" class="btn ${isCurrentActive ? 'btn-primary' : 'btn-secondary'} btn-xs js-karte-range-btn" data-range-type="${rangeType}" data-range-index="${idx}">
                絞り込む
              </button>
            </div>
          </div>
        `;
      }).join('');
    };

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 18px;">
        <!-- スイートスポット診断カード (静的枠 .lab-stat-box) -->
        <div class="lab-stat-box" style="padding: 12px 16px; border-radius: 8px; background: var(--bg-tertiary, #252b34); border: 1px solid var(--border-soft, #2f3642); display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between;">
          <div>
            <div style="font-size: 0.75rem; color: var(--text-muted, #94a3b8);">あなたの黄金スイートスポット診断</div>
            <div style="font-size: 0.9rem; color: var(--text-primary, #f1f5f9); margin-top: 4px;">
              焦点距離は <strong style="color: var(--accent-primary, #e14d2a);">${escHtml(bestFocal ? bestFocal.label : '-')}</strong>（優打率 ${bestFocal ? Number(bestFocal.excellent_rate || 0).toFixed(1) : '0.0'}%）、
              絞りは <strong style="color: var(--accent-primary, #e14d2a);">${escHtml(bestAperture ? bestAperture.label : '-')}</strong>（優打率 ${bestAperture ? Number(bestAperture.excellent_rate || 0).toFixed(1) : '0.0'}%）で最高傑作が生まれやすい傾向にあります。
            </div>
          </div>
        </div>

        <!-- 焦点距離 5区分 -->
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <h3 style="margin: 0; font-size: 0.95rem; color: var(--text-primary, #f1f5f9);">焦点距離5区分別 枚数 &amp;「優」打率</h3>
            <span class="badge-sub">超広角 〜 超望遠</span>
          </div>
          <div style="border: 1px solid var(--border-soft, #2f3642); border-radius: 8px; overflow: hidden;">
            ${buildRangeRows(focalRanges, maxFocalTotal, 'focal')}
          </div>
        </div>

        <!-- 絞り F値 5区分 -->
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <h3 style="margin: 0; font-size: 0.95rem; color: var(--text-primary, #f1f5f9);">F値（絞り）5区分別 枚数 &amp;「優」打率</h3>
            <span class="badge-sub">開放ボケ 〜 パンフォーカス・小絞り</span>
          </div>
          <div style="border: 1px solid var(--border-soft, #2f3642); border-radius: 8px; overflow: hidden;">
            ${buildRangeRows(apertureRanges, maxApertureTotal, 'aperture')}
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('.js-karte-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const rType = btn.dataset.rangeType;
        const idx = parseInt(btn.dataset.rangeIndex, 10);
        if (rType === 'focal' && focalRanges[idx]) {
          const item = focalRanges[idx];
          state.focalRange = item.range || item.key;
          state.focalRangeLabel = item.label;
          closeLabKarteModal();
          notifyLabFilterChanged();
          if (typeof showToast === 'function') {
            showToast(`焦点距離「${item.label}」で絞り込みました`, 'info', 2600);
          }
        } else if (rType === 'aperture' && apertureRanges[idx]) {
          const item = apertureRanges[idx];
          state.apertureRange = item.range || item.key;
          state.apertureRangeLabel = item.label;
          closeLabKarteModal();
          notifyLabFilterChanged();
          if (typeof showToast === 'function') {
            showToast(`絞り「${item.label}」で絞り込みました`, 'info', 2600);
          }
        }
      });
    });
  }

  /**
   * タブ3:  撮影時間帯 & 光の傾向 (#karteTabHours) を描画する
   * @param {Object} data カルテAPIレスポンス
   */
  function renderKarteHoursTab(data) {
    const container = document.getElementById('karteTabHours');
    if (!container) return;

    const hours = Array.isArray(data.hourly_distribution) ? data.hourly_distribution : [];
    const summary = data.summary || {};

    const maxHourCount = Math.max(1, ...hours.map(h => Number(h.count || h.total || 0)));

    // 最もシャッターを切る時間帯と、最も「優」が出やすい時間帯を算出
    const mostActiveHour = [...hours].sort((a, b) => Number(b.count || 0) - Number(a.count || 0))[0];
    const bestQualityHour = [...hours]
      .filter(h => Number(h.count || 0) >= 3)
      .sort((a, b) => Number(b.excellent_rate || 0) - Number(a.excellent_rate || 0))[0]
      || mostActiveHour;

    let goldenTimeComment = 'まだ時間帯別の撮影データが十分にありません。';
    if (mostActiveHour && Number(mostActiveHour.count || 0) > 0) {
      const activeHrStr = `${mostActiveHour.hour}時台（${mostActiveHour.count}枚）`;
      const bestHrStr = bestQualityHour
        ? `${bestQualityHour.hour}時台（優打率 ${Number(bestQualityHour.excellent_rate || 0).toFixed(1)}%）`
        : activeHrStr;
      goldenTimeComment = `最も多くシャッターを切る時間帯は <strong>${escHtml(activeHrStr)}</strong>、最も「優」が生まれやすいあなたのゴールデンタイムは <strong style="color: var(--accent-primary, #e14d2a);">${escHtml(bestHrStr)}</strong> です！`;
    }

    const barsHtml = hours.map(h => {
      const hr = Number(h.hour || 0);
      const cnt = Number(h.count || h.total || 0);
      const exc = Number(h.excellent || h.excellent_count || 0);
      const excRate = Number(h.excellent_rate || 0).toFixed(1);
      const heightPct = cnt > 0 ? Math.max(4, Math.round((cnt / maxHourCount) * 100)) : 0;
      const excHeightPct = exc > 0 ? Math.max(3, Math.round((exc / maxHourCount) * 100)) : 0;

      return `
        <div class="lab-hour-bar-col" style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 22px;" title="${hr}時台: 計 ${cnt}枚 / 優 ${exc}枚 (優打率 ${excRate}%)">
          <div style="font-size: 0.66rem; color: var(--text-muted, #94a3b8); height: 14px;">${cnt > 0 ? cnt : ''}</div>
          <div style="width: 100%; max-width: 20px; height: 130px; background: var(--bg-tertiary, #252b34); border-radius: 4px 4px 0 0; position: relative; display: flex; align-items: flex-end; overflow: hidden;">
            <div style="width: 100%; height: ${heightPct}%; background: rgba(59, 130, 246, 0.55); border-radius: 3px 3px 0 0; position: relative;"></div>
            <div style="width: 100%; height: ${excHeightPct}%; background: var(--accent-primary, #e14d2a); position: absolute; bottom: 0; left: 0;"></div>
          </div>
          <div style="font-size: 0.68rem; color: var(--text-secondary, #cbd5e1); font-variant-numeric: tabular-nums;">${hr}</div>
        </div>
      `;
    }).join('');

    const goldenCount = Number(summary.golden_hour_count || 0);
    const blueCount = Number(summary.blue_hour_count || 0);
    const shakeCount = Number(summary.shake_risk_count || 0);
    const nightCount = Number(summary.night_count || 0);

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 18px;">
        <!-- ゴールデンタイム自動診断コメント (静的枠 .lab-stat-box) -->
        <div class="lab-stat-box" style="padding: 12px 16px; border-radius: 8px; background: var(--bg-tertiary, #252b34); border: 1px solid var(--border-soft, #2f3642);">
          <div style="font-size: 0.75rem; color: var(--text-muted, #94a3b8); margin-bottom: 4px;"> あなたのゴールデンタイム分析</div>
          <div style="font-size: 0.9rem; color: var(--text-primary, #f1f5f9); line-height: 1.5;">${goldenTimeComment}</div>
        </div>

        <!-- 0時〜23時 24時間ヒストグラム -->
        <div style="padding: 14px 16px; border-radius: 8px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <h3 style="margin: 0; font-size: 0.94rem; color: var(--text-primary, #f1f5f9);">24時間シャッターリズム（0時〜23時）</h3>
            <div style="display: flex; gap: 12px; font-size: 0.75rem; color: var(--text-muted, #94a3b8);">
              <span><span style="display: inline-block; width: 10px; height: 10px; background: rgba(59, 130, 246, 0.65); border-radius: 2px; margin-right: 4px;"></span>総撮影枚数</span>
              <span><span style="display: inline-block; width: 10px; height: 10px; background: var(--accent-primary, #e14d2a); border-radius: 2px; margin-right: 4px;"></span>優 獲得枚数</span>
            </div>
          </div>
          <div style="display: flex; align-items: flex-end; gap: 4px; overflow-x: auto; padding-bottom: 4px;">
            ${barsHtml}
          </div>
        </div>

        <!-- ワンクリック光・露出リスク抽出ボタン群 -->
        <div style="padding: 14px 16px; border-radius: 8px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
          <div style="font-size: 0.84rem; font-weight: 600; color: var(--text-primary, #f1f5f9); margin-bottom: 10px;">
            太陽高度（天文計算）＆ 露出条件でワンクリック抽出
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 10px;">
            <button type="button" class="btn btn-secondary btn-sm js-karte-quick-filter" data-lab-filter="golden_hour">
              マジックアワー (${goldenCount.toLocaleString()}枚)
            </button>
            <button type="button" class="btn btn-secondary btn-sm js-karte-quick-filter" data-lab-filter="blue_hour">
              ブルーアワー (${blueCount.toLocaleString()}枚)
            </button>
            <button type="button" class="btn btn-secondary btn-sm js-karte-quick-filter" data-lab-filter="night">
              夜景・星景 (${nightCount.toLocaleString()}枚)
            </button>
            <button type="button" class="btn btn-secondary btn-sm js-karte-quick-filter" data-lab-filter="shake_risk">
              手ブレ危険度 (${shakeCount.toLocaleString()}枚)
            </button>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('.js-karte-quick-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        const fType = btn.dataset.labFilter;
        if (fType) {
          closeLabKarteModal();
          applyLabFilter(fType, true);
        }
      });
    });
  }

  /**
   * GET /api/lab/karte を取得し、#labKarteModal を開いて描画する
   * @param {string} [initialTab='lenses']
   */
  async function openLabKarteModal(initialTab = 'lenses') {
    ensureLabStateInitialized();
    const modal = ensureLabKarteModalDom();
    modal.style.display = 'flex';

    if (typeof initialTab === 'string' && ['lenses', 'settings', 'hours'].includes(initialTab)) {
      switchKarteTab(initialTab);
    } else {
      switchKarteTab(activeKarteTab || 'lenses');
    }

    const lensesPane = document.getElementById('karteTabLenses');
    if (lensesPane && !latestKarteData) {
      lensesPane.innerHTML = `<div class="empty-hint" style="padding: 36px; text-align: center;">撮影カルテを集計中...</div>`;
    }

    try {
      const todayMmDd = (typeof state !== 'undefined' && state && state.onThisDay)
        ? state.onThisDay
        : getTodayLocalMmDd().mmdd;
      const response = await fetch(`/api/lab/karte?today_mmdd=${encodeURIComponent(todayMmDd)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      latestKarteData = data;

      renderKarteSummaryBar(data.summary || {});
      renderKarteLensesTab(data);
      renderKarteSettingsTab(data);
      renderKarteHoursTab(data);
    } catch (err) {
      console.error('撮影カルテ取得エラー:', err);
      if (lensesPane) {
        lensesPane.innerHTML = `<div class="empty-hint" style="padding: 24px; color: var(--danger, #ef4444);">カルテデータの読み込みに失敗しました (${escHtml(err.message)})</div>`;
      }
    }
  }
  window.openLabKarteModal = openLabKarteModal;

  /**
   * 左サイドバー「🧪 ラボ」セクションおよび #labKarteModal のイベントリスナーを初期化する
   */
  function initLabSection() {
    ensureLabStateInitialized();
    ensureLabSidebarControls();
    const modal = ensureLabKarteModalDom();

    // 1. サイドバー内の特殊フィルタボタン ([data-lab-filter])
    document.querySelectorAll('#accordionItem-lab [data-lab-filter]').forEach(btn => {
      if (btn.dataset.labBound) return;
      btn.dataset.labBound = 'true';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const fType = btn.dataset.labFilter;
        if (fType) {
          applyLabFilter(fType);
        }
      });
    });

    // 2. 🎂 歴代の今日（On This Day）セレクト＆ボタン連動
    const monthSelect = document.getElementById('labOnThisDayMonth') || document.getElementById('onThisDayMonthSelect') || document.getElementById('labMonthSelect');
    const daySelect = document.getElementById('labOnThisDayDay') || document.getElementById('onThisDayDaySelect') || document.getElementById('labDaySelect');
    const otdBtn = document.getElementById('labOnThisDayBtn') || document.getElementById('labBtnOnThisDay') || document.querySelector('[data-lab-action="on-this-day"]');
    const todayBtn = document.getElementById('labOnThisDayTodayBtn') || document.getElementById('onThisDayTodayBtn');

    if (otdBtn && !otdBtn.dataset.labBound) {
      otdBtn.dataset.labBound = 'true';
      otdBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const mmdd = (monthSelect && daySelect)
          ? formatMmDd(monthSelect.value, daySelect.value)
          : getTodayLocalMmDd().mmdd;
        if (state.onThisDay === mmdd) {
          applyLabFilter('on_this_day', null);
        } else {
          applyLabFilter('on_this_day', mmdd);
        }
      });
    }

    const onDateSelectChange = () => {
      if (!monthSelect || !daySelect) return;
      const mmdd = formatMmDd(monthSelect.value, daySelect.value);
      // 既にOnThisDayが有効、または月日セレクトを直接変更したときに即座にその月日の歴代写真を抽出
      applyLabFilter('on_this_day', mmdd);
    };

    if (monthSelect && !monthSelect.dataset.labBound) {
      monthSelect.dataset.labBound = 'true';
      monthSelect.addEventListener('change', onDateSelectChange);
    }
    if (daySelect && !daySelect.dataset.labBound) {
      daySelect.dataset.labBound = 'true';
      daySelect.addEventListener('change', onDateSelectChange);
    }

    if (todayBtn && !todayBtn.dataset.labBound) {
      todayBtn.dataset.labBound = 'true';
      todayBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const today = getTodayLocalMmDd();
        if (monthSelect) monthSelect.value = String(today.month).padStart(2, '0');
        if (daySelect) daySelect.value = String(today.day).padStart(2, '0');
        applyLabFilter('on_this_day', today.mmdd);
      });
    }

    // 3. 🎲 未整理フォルダ発掘ガチャボタン
    document.querySelectorAll('#labGachaBtn, #labRandomFolderBtn, #randomUnratedFolderBtn, [data-lab-action="gacha"]').forEach(btn => {
      if (btn.dataset.labBound) return;
      btn.dataset.labBound = 'true';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        triggerRandomUnratedFolderGacha();
      });
    });

    // 4. 🏆 勝ちレンズ・得意設定カルテ起動ボタン
    document.querySelectorAll('#openLabKarteModalBtn, #labKarteBtn, #openLabKarteBtn, [data-lab-action="karte"]').forEach(btn => {
      if (btn.dataset.labBound) return;
      btn.dataset.labBound = 'true';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openLabKarteModal('lenses');
      });
    });

    // 5. ⚖️ 2枚比較ボタン（サイドバー内に配置されている場合）
    document.querySelectorAll('#labOpenCompareBtn, #openCompareModalBtn, [data-lab-action="compare"]').forEach(btn => {
      if (btn.dataset.labBound) return;
      btn.dataset.labBound = 'true';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof window.openCompareModal === 'function') {
          window.openCompareModal();
        }
      });
    });

    // 6. ラボフィルタクリアボタン
    document.querySelectorAll('#clearLabFilterBtn, #labClearFilterBtn, [data-lab-action="clear"]').forEach(btn => {
      if (btn.dataset.labBound) return;
      btn.dataset.labBound = 'true';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        applyLabFilter('clear_all');
      });
    });

    // 7. カルテモーダル内のイベント（閉じるボタン・背景クリック・タブ切替）
    if (modal && !modal.dataset.labModalBound) {
      modal.dataset.labModalBound = 'true';

      modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.closest('#closeLabKarteModalBtn') || e.target.closest('.modal-close-btn')) {
          closeLabKarteModal();
          return;
        }
        const tabBtn = e.target.closest('.lab-tab-btn[data-karte-tab], .lab-tab-btn[data-tab]');
        if (tabBtn) {
          const targetTab = tabBtn.dataset.karteTab || tabBtn.dataset.tab;
          if (targetTab) {
            switchKarteTab(targetTab);
          }
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display !== 'none') {
          closeLabKarteModal();
        }
      });
    }

    updateLabUIState();
  }
  window.initLabSection = initLabSection;

  // DOMContentLoaded 時に自動初期化（app.js から明示的に呼ばれた場合もべき等に動作）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initLabSection());
  } else {
    initLabSection();
  }
})();
