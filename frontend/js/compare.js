/**
 * Photo Manager - Side-by-Side 2枚並列比較ビューモジュール (compare.js)
 *
 * 特徴:
 * 1. ライトボックス中・複数選択中・スタック表示中どこからでも [V] キーまたは「⚖️ 比較」ボタンで即座に2枚並列比較へ突入
 * 2. 完全シンクロ・ズーム＆パン（100%〜400%）：片方の瞳を拡大・移動すると、もう片方も同じ位置・倍率で連動
 *    （※ Alt+ドラッグ または「🔗 同期」OFFで片方だけの位置微調整にも対応）
 * 3. トーナメント勝ち抜き方式：左(A)に基準写真をピン留めしたまま、[←]/[→]キーで右(B)の候補だけを次々切り替え、
 *    「👑 Bを基準(A)にする ([W]キー)」で勝ち抜き選別が可能
 * 4. 左右それぞれのペインでの直接4段階評価（優/良/可/棄）＆ [H]キーでの左右同時RGBヒストグラム比較
 */

(function () {
  'use strict';

  const cmpState = {
    isOpen: false,
    pool: [],           // 比較対象の写真配列
    sourceLabel: '',    // ヘッダーに表示する比較元ラベル
    poolMode: 'list',   // 'stack' | 'selected' | 'list'
    idxA: 0,            // 左ペイン (基準 A) の pool 内インデックス
    idxB: 1,            // 右ペイン (候補 B) の pool 内インデックス
    activeSide: 'B',    // キーボード評価の対象ペイン ('A' | 'B')
    syncView: true,     // ビュー位置（パン移動）の左右同期ON/OFF
    syncZoom: true,     // ズーム倍率（ホイール拡大）の左右同期ON/OFF
    zoomA: 1.0,
    zoomB: 1.0,
    panAX: 0,
    panAY: 0,
    panBX: 0,
    panBY: 0,
    isPanning: false,
    panSide: 'A',
    panIndividual: false,
    panStartX: 0,
    panStartY: 0,
    histOpen: false,
    histDataA: null,
    histDataB: null,
  };

  let modalEl = null;

  /**
   * 比較モーダルDOMを初期化生成して body に追加
   */
  function ensureCompareModalDom() {
    if (modalEl) return modalEl;

    modalEl = document.createElement('div');
    modalEl.id = 'compareModal';
    modalEl.className = 'compare-modal';
    modalEl.style.display = 'none';

    const histHtmlA = typeof window.buildHistogramWidgetHtml === 'function'
      ? window.buildHistogramWidgetHtml('cmpHistA', false)
      : '';
    const histHtmlB = typeof window.buildHistogramWidgetHtml === 'function'
      ? window.buildHistogramWidgetHtml('cmpHistB', false)
      : '';

    modalEl.innerHTML = `
      <!-- 上部ヘッダー -->
      <div class="compare-header">
        <div class="compare-header-left">
          <div class="compare-title">
            <span>⚖️</span>
            <span>2枚比較 (Side-by-Side)</span>
          </div>
          <span class="compare-source-badge" id="compareSourceBadge">比較モード</span>
        </div>

        <div class="compare-toolbar">
          <div class="compare-sync-group" title="点灯している項目が左右で連動します（Altキー押下中は一時的に片側のみ操作）">
            <span class="compare-sync-group-label">同期:</span>
            <button type="button" class="compare-tool-btn active" id="compareSyncViewBtn" title="ビュー位置（ドラッグ移動）を左右で同期します。OFFにすると片方だけドラッグして構図のズレを合わせられます">
              <span>🖐️</span>
              <span>ビュー</span>
            </button>
            <button type="button" class="compare-tool-btn active" id="compareSyncZoomBtn" title="ズーム倍率（ホイール拡大）を左右で同期します。OFFにすると片方だけ倍率を変えて被写体の大きさを揃えられます">
              <span>🔍</span>
              <span>ズーム</span>
            </button>
          </div>
          <button type="button" class="compare-zoom-readout" id="compareZoomResetBtn" title="クリックで100%（等倍・位置中央）にリセット">100%</button>
          <button type="button" class="compare-tool-btn" id="compareSwapBtn" title="左(A)と右(B)の写真を入れ替えます (Sキー)">
            <span>⇄</span>
            <span>左右入替 (S)</span>
          </button>
          <button type="button" class="compare-tool-btn is-promote" id="comparePromoteBBtn" title="右(B)の写真を左(A:基準)の座に据え、右(B)には次の候補を呼び出します (Wキー)">
            <span>👑</span>
            <span>右(B)を基準にして次へ (W)</span>
          </button>
          <button type="button" class="compare-tool-btn is-hist" id="compareHistToggleBtn" title="左右両方のRGBヒストグラムを同時表示して露出・階調を比較します (Hキー)">
            <span>📊</span>
            <span>波形比較 (H)</span>
          </button>
        </div>

        <div class="compare-header-right">
          <span class="compare-shortcut-hint">ホイール:拡大 / ←→:右(B)切替 / 1・2・3:評価</span>
          <button type="button" class="compare-close-btn" id="compareCloseBtn" title="比較モードを閉じる (Esc / V)">&times;</button>
        </div>
      </div>

      <!-- 中央2分割ステージ -->
      <div class="compare-stage-grid" id="compareStageGrid">
        <!-- 左ペイン: A (基準) -->
        <div class="compare-pane" id="comparePaneA" data-side="A">
          <div class="compare-pane-topbar">
            <div class="compare-pane-meta">
              <span class="compare-slot-badge slot-a">📌 A : 基準</span>
              <span class="compare-filename" id="compareFileNameA">-</span>
              <div class="compare-exif-pills" id="compareExifPillsA"></div>
            </div>
            <div class="compare-pane-actions">
              <div class="compare-rate-group" id="compareRateGroupA">
                <button type="button" class="compare-rate-btn" data-rating="2" title="左(A)に「優」を設定">優</button>
                <button type="button" class="compare-rate-btn" data-rating="1" title="左(A)に「良」を設定">良</button>
                <button type="button" class="compare-rate-btn" data-rating="0" title="左(A)の評価を「可（解除）」に設定">可</button>
                <button type="button" class="compare-rate-btn" data-rating="-1" title="左(A)に「棄」を設定">棄</button>
              </div>
            </div>
          </div>
          <div class="compare-viewport" id="compareViewportA" data-side="A">
            <img class="compare-img" id="compareImgA" src="" alt="比較画像 A">
            <div class="compare-hist-overlay" id="compareHistHudA" style="display: none;">
              ${histHtmlA}
            </div>
            <div class="compare-active-indicator">⌨️ 数字キー (1:優 / 2:良 / 3:棄) の評価対象</div>
          </div>
        </div>

        <!-- 右ペイン: B (比較候補) -->
        <div class="compare-pane is-active-target" id="comparePaneB" data-side="B">
          <div class="compare-pane-topbar">
            <div class="compare-pane-meta">
              <span class="compare-slot-badge slot-b">🔍 B : 比較候補</span>
              <span class="compare-filename" id="compareFileNameB">-</span>
              <div class="compare-exif-pills" id="compareExifPillsB"></div>
            </div>
            <div class="compare-pane-actions">
              <div class="compare-rate-group" id="compareRateGroupB">
                <button type="button" class="compare-rate-btn" data-rating="2" title="右(B)に「優」を設定">優</button>
                <button type="button" class="compare-rate-btn" data-rating="1" title="右(B)に「良」を設定">良</button>
                <button type="button" class="compare-rate-btn" data-rating="0" title="右(B)の評価を「可（解除）」に設定">可</button>
                <button type="button" class="compare-rate-btn" data-rating="-1" title="右(B)に「棄」を設定">棄</button>
              </div>
            </div>
          </div>
          <div class="compare-viewport" id="compareViewportB" data-side="B">
            <img class="compare-img" id="compareImgB" src="" alt="比較画像 B">
            <div class="compare-hist-overlay" id="compareHistHudB" style="display: none;">
              ${histHtmlB}
            </div>
            <div class="compare-active-indicator">⌨️ 数字キー (1:優 / 2:良 / 3:棄) の評価対象</div>
          </div>
        </div>
      </div>

      <!-- 下部候補サムネイルストリップ -->
      <div class="compare-footer">
        <div class="compare-footer-guide">
          <span>💡 サムネイルを<strong>クリックで 🔍右(B)</strong> に表示 ／ <strong>Shift+クリックで 📌左(A)</strong> に固定 ／ <strong>Alt+ドラッグ・ホイール</strong>で一時的に片方だけ操作</span>
          <span id="compareCounterText">1 &amp; 2 / 2 枚</span>
        </div>
        <div class="compare-strip" id="compareStrip"></div>
      </div>
    `;

    document.body.appendChild(modalEl);
    bindCompareModalEvents();
    return modalEl;
  }

  /**
   * 比較モーダル内の各種イベントバインド
   */
  function bindCompareModalEvents() {
    const closeBtn = document.getElementById('compareCloseBtn');
    const syncViewBtn = document.getElementById('compareSyncViewBtn');
    const syncZoomBtn = document.getElementById('compareSyncZoomBtn');
    const zoomResetBtn = document.getElementById('compareZoomResetBtn');
    const swapBtn = document.getElementById('compareSwapBtn');
    const promoteBBtn = document.getElementById('comparePromoteBBtn');
    const histToggleBtn = document.getElementById('compareHistToggleBtn');

    if (closeBtn) closeBtn.addEventListener('click', closeCompareModal);
    if (syncViewBtn) {
      syncViewBtn.addEventListener('click', () => {
        cmpState.syncView = !cmpState.syncView;
        syncViewBtn.classList.toggle('active', cmpState.syncView);
      });
    }
    if (syncZoomBtn) {
      syncZoomBtn.addEventListener('click', () => {
        cmpState.syncZoom = !cmpState.syncZoom;
        syncZoomBtn.classList.toggle('active', cmpState.syncZoom);
      });
    }
    if (zoomResetBtn) {
      zoomResetBtn.addEventListener('click', () => resetCompareZoom());
    }
    if (swapBtn) {
      swapBtn.addEventListener('click', () => swapCompareSides());
    }
    if (promoteBBtn) {
      promoteBBtn.addEventListener('click', () => promoteRightToLeftAndAdvance());
    }
    if (histToggleBtn) {
      histToggleBtn.addEventListener('click', () => toggleCompareHistogram());
    }

    // 左右ペインのホバー・クリックでアクティブ対象（数字キー評価先）を切り替え
    ['A', 'B'].forEach(side => {
      const paneEl = document.getElementById(`comparePane${side}`);
      const rateGroup = document.getElementById(`compareRateGroup${side}`);
      const imgEl = document.getElementById(`compareImg${side}`);

      if (paneEl) {
        paneEl.addEventListener('mouseenter', () => setActiveCompareSide(side));
        paneEl.addEventListener('mousedown', () => setActiveCompareSide(side));
      }

      if (rateGroup) {
        rateGroup.querySelectorAll('.compare-rate-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rVal = parseInt(btn.dataset.rating, 10);
            rateComparePhoto(side, rVal);
          });
        });
      }

      if (imgEl) {
        imgEl.addEventListener('load', () => {
          if (cmpState.histOpen) {
            refreshCompareHistograms();
          }
        });
      }
    });

    // ヒストグラムウィジェットの操作バインド
    if (typeof window.bindHistogramWidgetInteractions === 'function') {
      window.bindHistogramWidgetInteractions(
        document.getElementById('compareHistHudA'),
        'cmpHistA',
        () => cmpState.histDataA,
        () => toggleCompareHistogram(false)
      );
      window.bindHistogramWidgetInteractions(
        document.getElementById('compareHistHudB'),
        'cmpHistB',
        () => cmpState.histDataB,
        () => toggleCompareHistogram(false)
      );
    }

    // ビューポートでのホイールズーム＆ドラッグパン操作
    ['A', 'B'].forEach(side => {
      const vp = document.getElementById(`compareViewport${side}`);
      if (!vp) return;

      vp.addEventListener('wheel', (e) => {
        if (!cmpState.isOpen) return;
        if (e.target.closest('.compare-hist-overlay')) return;
        e.preventDefault();

        const syncZ = cmpState.syncZoom && !e.altKey;
        const syncV = cmpState.syncView && !e.altKey;
        const clampedDelta = Math.max(-80, Math.min(80, e.deltaY));
        const zoomFactor = Math.exp(-clampedDelta * 0.0012);

        const rect = vp.getBoundingClientRect();
        const cursorX = e.clientX - (rect.left + rect.width / 2);
        const cursorY = e.clientY - (rect.top + rect.height / 2);

        const zoomSingleSide = (targetSide, useCursorOrigin) => {
          const oldZ = targetSide === 'A' ? cmpState.zoomA : cmpState.zoomB;
          let newZ = Math.max(1.0, Math.min(4.0, oldZ * zoomFactor));
          if (clampedDelta > 0 && newZ <= 1.03) {
            newZ = 1.0;
          }
          const ratio = newZ / oldZ;
          if (targetSide === 'A') {
            if (newZ === 1.0 && syncV && Math.abs(cmpState.zoomB - 1.0) <= 0.03) {
              cmpState.panAX = 0;
              cmpState.panAY = 0;
            } else if (useCursorOrigin) {
              cmpState.panAX = cursorX - (cursorX - cmpState.panAX) * ratio;
              cmpState.panAY = cursorY - (cursorY - cmpState.panAY) * ratio;
            } else {
              cmpState.panAX *= ratio;
              cmpState.panAY *= ratio;
            }
            cmpState.zoomA = newZ;
          } else {
            if (newZ === 1.0 && syncV && Math.abs(cmpState.zoomA - 1.0) <= 0.03) {
              cmpState.panBX = 0;
              cmpState.panBY = 0;
            } else if (useCursorOrigin) {
              cmpState.panBX = cursorX - (cursorX - cmpState.panBX) * ratio;
              cmpState.panBY = cursorY - (cursorY - cmpState.panBY) * ratio;
            } else {
              cmpState.panBX *= ratio;
              cmpState.panBY *= ratio;
            }
            cmpState.zoomB = newZ;
          }
        };

        if (syncZ) {
          zoomSingleSide('A', syncV || side === 'A');
          zoomSingleSide('B', syncV || side === 'B');
          if (cmpState.zoomA === 1.0 && cmpState.zoomB === 1.0 && syncV) {
            cmpState.panAX = 0;
            cmpState.panAY = 0;
            cmpState.panBX = 0;
            cmpState.panBY = 0;
          }
        } else {
          zoomSingleSide(side, true);
        }

        applyCompareTransforms(false);
      }, { passive: false });

      vp.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.compare-hist-overlay, button')) return;
        e.preventDefault();

        const individual = e.altKey || !cmpState.syncView;
        const curSideZoom = side === 'A' ? cmpState.zoomA : cmpState.zoomB;
        const maxZoom = Math.max(cmpState.zoomA, cmpState.zoomB);
        if (maxZoom <= 1.02 && curSideZoom <= 1.02 && !individual) return;

        cmpState.isPanning = true;
        cmpState.panSide = side;
        cmpState.panIndividual = individual;
        cmpState.panStartX = e.clientX;
        cmpState.panStartY = e.clientY;
      });

      vp.addEventListener('dblclick', (e) => {
        if (e.target.closest('.compare-hist-overlay, button')) return;
        const syncZ = cmpState.syncZoom && !e.altKey;
        const syncV = cmpState.syncView && !e.altKey;
        const rect = vp.getBoundingClientRect();
        const cursorX = e.clientX - (rect.left + rect.width / 2);
        const cursorY = e.clientY - (rect.top + rect.height / 2);

        if (syncZ) {
          if (cmpState.zoomA > 1.05 || cmpState.zoomB > 1.05) {
            resetCompareZoom();
          } else {
            cmpState.zoomA = 2.0;
            cmpState.zoomB = 2.0;
            cmpState.panAX = -cursorX;
            cmpState.panAY = -cursorY;
            if (syncV) {
              cmpState.panBX = -cursorX;
              cmpState.panBY = -cursorY;
            }
            applyCompareTransforms(false);
          }
        } else {
          const curZ = side === 'A' ? cmpState.zoomA : cmpState.zoomB;
          if (curZ > 1.05) {
            if (side === 'A') {
              cmpState.zoomA = 1.0;
              cmpState.panAX = 0;
              cmpState.panAY = 0;
            } else {
              cmpState.zoomB = 1.0;
              cmpState.panBX = 0;
              cmpState.panBY = 0;
            }
          } else {
            if (side === 'A') {
              cmpState.zoomA = 2.0;
              cmpState.panAX = -cursorX;
              cmpState.panAY = -cursorY;
            } else {
              cmpState.zoomB = 2.0;
              cmpState.panBX = -cursorX;
              cmpState.panBY = -cursorY;
            }
          }
          applyCompareTransforms(false);
        }
      });
    });

    window.addEventListener('mousemove', (e) => {
      if (!cmpState.isPanning || !cmpState.isOpen) return;
      const dx = e.clientX - cmpState.panStartX;
      const dy = e.clientY - cmpState.panStartY;
      cmpState.panStartX = e.clientX;
      cmpState.panStartY = e.clientY;

      if (cmpState.panIndividual) {
        if (cmpState.panSide === 'A') {
          cmpState.panAX += dx;
          cmpState.panAY += dy;
        } else {
          cmpState.panBX += dx;
          cmpState.panBY += dy;
        }
      } else {
        cmpState.panAX += dx;
        cmpState.panAY += dy;
        cmpState.panBX += dx;
        cmpState.panBY += dy;
      }
      applyCompareTransforms(true);
    });

    window.addEventListener('mouseup', () => {
      if (cmpState.isPanning) {
        cmpState.isPanning = false;
        applyCompareTransforms(false);
      }
    });

    // 下部フィルムストリップ上でのホイール回転で右(B)の候補を次々送り
    const stripEl = document.getElementById('compareStrip');
    if (stripEl) {
      let wheelAcc = 0;
      let lastStep = 0;
      stripEl.addEventListener('wheel', (e) => {
        if (!cmpState.isOpen) return;
        e.preventDefault();
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        wheelAcc += delta;
        const now = performance.now();
        if (Math.abs(wheelAcc) >= 70 && now - lastStep >= 100) {
          stepCandidateB(wheelAcc > 0 ? 1 : -1);
          wheelAcc = 0;
          lastStep = now;
        }
      }, { passive: false });
    }
  }

  /**
   * アクティブペイン（数字キーの評価対象）を設定
   */
  function setActiveCompareSide(side) {
    cmpState.activeSide = (side === 'A') ? 'A' : 'B';
    const paneA = document.getElementById('comparePaneA');
    const paneB = document.getElementById('comparePaneB');
    if (paneA) paneA.classList.toggle('is-active-target', cmpState.activeSide === 'A');
    if (paneB) paneB.classList.toggle('is-active-target', cmpState.activeSide === 'B');
  }

  /**
   * ズームと位置を100%にリセット
   */
  function resetCompareZoom() {
    cmpState.zoomA = 1.0;
    cmpState.zoomB = 1.0;
    cmpState.panAX = 0;
    cmpState.panAY = 0;
    cmpState.panBX = 0;
    cmpState.panBY = 0;
    applyCompareTransforms(false);
  }

  /**
   * 左右の画像要素へズーム・パン・回転の CSS transform を適用
   */
  function applyCompareTransforms(immediate = false) {
    const imgA = document.getElementById('compareImgA');
    const imgB = document.getElementById('compareImgB');
    const zoomReadout = document.getElementById('compareZoomResetBtn');

    if (zoomReadout) {
      const zA = Math.round(cmpState.zoomA * 100);
      const zB = Math.round(cmpState.zoomB * 100);
      zoomReadout.textContent = (zA === zB) ? `${zA}%` : `${zA}% | ${zB}%`;
    }

    const photoA = cmpState.pool[cmpState.idxA];
    const photoB = cmpState.pool[cmpState.idxB];

    if (imgA && photoA) {
      imgA.style.transition = immediate ? 'none' : 'transform 0.12s ease-out';
      const rotA = (typeof hasBakedViewAdjustments === 'function' && hasBakedViewAdjustments(photoA)) ? 0 : (photoA.rotation || 0);
      imgA.style.transform = `translate(${cmpState.panAX}px, ${cmpState.panAY}px) rotate(${rotA}deg) scale(${cmpState.zoomA})`;
    }

    if (imgB && photoB) {
      imgB.style.transition = immediate ? 'none' : 'transform 0.12s ease-out';
      const rotB = (typeof hasBakedViewAdjustments === 'function' && hasBakedViewAdjustments(photoB)) ? 0 : (photoB.rotation || 0);
      imgB.style.transform = `translate(${cmpState.panBX}px, ${cmpState.panBY}px) rotate(${rotB}deg) scale(${cmpState.zoomB})`;
    }
  }

  /**
   * ペイン上部の撮影条件ピル（SS, F値, ISO, EV）を生成
   */
  function renderCompareExifPills(container, photo) {
    if (!container || !photo) return;
    const pills = [];
    if (photo.shutter_speed) {
      pills.push(`<span class="compare-exif-pill">${escapeHtml(String(photo.shutter_speed))}</span>`);
    }
    if (photo.f_number != null) {
      pills.push(`<span class="compare-exif-pill">F${escapeHtml(String(photo.f_number))}</span>`);
    }
    if (photo.iso != null) {
      pills.push(`<span class="compare-exif-pill">ISO ${escapeHtml(String(photo.iso))}</span>`);
    }
    if (photo.exposure_bias !== undefined && photo.exposure_bias !== null && Math.abs(photo.exposure_bias) > 0.001) {
      const b = Number(photo.exposure_bias);
      const sign = b > 0 ? '+' : '';
      const cls = b > 0.05 ? 'is-ev-plus' : (b < -0.05 ? 'is-ev-minus' : '');
      pills.push(`<span class="compare-exif-pill ${cls}">${sign}${b.toFixed(2)} EV</span>`);
    }
    container.innerHTML = pills.join('');
  }

  /**
   * 左右ペインの内容（画像・メタデータ・評価ボタン）を更新
   */
  function updateComparePanesUI() {
    const photoA = cmpState.pool[cmpState.idxA];
    const photoB = cmpState.pool[cmpState.idxB];

    // スタックメンバーで詳細メタデータが未取得なら非同期補完
    [photoA, photoB].forEach(p => {
      if (p && !p._detailLoaded && typeof ensureStackMemberDetail === 'function') {
        ensureStackMemberDetail(p).then(() => {
          if (cmpState.isOpen) updateCompareMetaAndStripOnly();
        });
      }
    });

    const imgA = document.getElementById('compareImgA');
    const imgB = document.getElementById('compareImgB');

    if (imgA && photoA) {
      const urlA = getPhotoViewUrl(photoA);
      if (imgA.getAttribute('src') !== urlA) {
        imgA.src = urlA;
      } else if (imgA.complete && cmpState.histOpen) {
        refreshCompareHistograms();
      }
    }

    if (imgB && photoB) {
      const urlB = getPhotoViewUrl(photoB);
      if (imgB.getAttribute('src') !== urlB) {
        imgB.src = urlB;
      } else if (imgB.complete && cmpState.histOpen) {
        refreshCompareHistograms();
      }
    }

    applyCompareTransforms(true);
    updateCompareMetaAndStripOnly();
  }

  /**
   * 画像再読み込みを伴わないメタ情報・評価ボタン・下部ストリップの更新
   */
  function updateCompareMetaAndStripOnly() {
    const photoA = cmpState.pool[cmpState.idxA];
    const photoB = cmpState.pool[cmpState.idxB];

    const renderSideMeta = (side, photo) => {
      if (!photo) return;
      const paneEl = document.getElementById(`comparePane${side}`);
      const nameEl = document.getElementById(`compareFileName${side}`);
      const pillsEl = document.getElementById(`compareExifPills${side}`);
      const rateGroup = document.getElementById(`compareRateGroup${side}`);

      if (paneEl) {
        paneEl.classList.toggle('is-discarded-photo', photo.rating === -1);
      }
      if (nameEl) {
        nameEl.textContent = photo.file_name || '-';
        nameEl.title = photo.file_path || photo.file_name || '';
      }
      renderCompareExifPills(pillsEl, photo);

      if (rateGroup) {
        const curRating = photo.rating || 0;
        rateGroup.querySelectorAll('.compare-rate-btn').forEach(btn => {
          const r = parseInt(btn.dataset.rating, 10);
          btn.classList.toggle('active', r === curRating);
        });
      }
    };

    renderSideMeta('A', photoA);
    renderSideMeta('B', photoB);

    const counterEl = document.getElementById('compareCounterText');
    if (counterEl) {
      counterEl.textContent = `📌 A: #${cmpState.idxA + 1}  vs  🔍 B: #${cmpState.idxB + 1} （全 ${cmpState.pool.length} 枚）`;
    }

    renderCompareStrip();
  }

  /**
   * 下部候補サムネイル帯の描画
   */
  function renderCompareStrip() {
    const stripEl = document.getElementById('compareStrip');
    if (!stripEl) return;

    // プールが変わっていない場合はクラスとバッジだけ差分更新して高速化
    const existingItems = stripEl.querySelectorAll('.compare-strip-item');
    if (existingItems.length !== cmpState.pool.length) {
      stripEl.innerHTML = '';
      cmpState.pool.forEach((p, idx) => {
        const item = document.createElement('div');
        item.className = 'compare-strip-item';
        item.dataset.idx = String(idx);

        let subText = p.file_name || `#${idx + 1}`;
        if (p.exposure_bias !== undefined && p.exposure_bias !== null && Math.abs(p.exposure_bias) > 0.01) {
          const b = Number(p.exposure_bias);
          subText = `${b > 0 ? '+' : ''}${b.toFixed(1)}EV`;
        }

        item.innerHTML = `
          <img src="${getThumbnailUrl(p)}" alt="${escapeHtml(p.file_name || '')}" loading="lazy">
          <span class="compare-strip-slot-tag" style="display: none;"></span>
          <span class="compare-strip-rate-dot" style="display: none;"></span>
          <span class="compare-strip-sub-label">${escapeHtml(subText)}</span>
        `;

        item.title = `${p.file_name}\nクリック: 🔍右(B)に表示\nShift+クリック: 📌左(A)に固定`;
        item.addEventListener('click', (e) => {
          if (e.shiftKey) {
            if (idx === cmpState.idxB) {
              swapCompareSides();
            } else {
              cmpState.idxA = idx;
              updateComparePanesUI();
            }
          } else {
            if (idx === cmpState.idxA) {
              swapCompareSides();
            } else {
              cmpState.idxB = idx;
              updateComparePanesUI();
            }
          }
        });

        stripEl.appendChild(item);
      });
    }

    // スロットA/B枠と評価バッジの同期
    const items = stripEl.querySelectorAll('.compare-strip-item');
    items.forEach((item, idx) => {
      const p = cmpState.pool[idx];
      const isA = idx === cmpState.idxA;
      const isB = idx === cmpState.idxB;
      item.classList.toggle('is-slot-a', isA);
      item.classList.toggle('is-slot-b', isB);

      const slotTag = item.querySelector('.compare-strip-slot-tag');
      if (slotTag) {
        if (isA) {
          slotTag.style.display = 'inline-block';
          slotTag.className = 'compare-strip-slot-tag tag-a';
          slotTag.textContent = '📌 A';
        } else if (isB) {
          slotTag.style.display = 'inline-block';
          slotTag.className = 'compare-strip-slot-tag tag-b';
          slotTag.textContent = '🔍 B';
        } else {
          slotTag.style.display = 'none';
        }
      }

      const rateDot = item.querySelector('.compare-strip-rate-dot');
      if (rateDot && p) {
        const r = p.rating || 0;
        if (r === 2) {
          rateDot.style.display = 'inline-block';
          rateDot.className = 'compare-strip-rate-dot r-2';
          rateDot.textContent = '優';
        } else if (r === 1) {
          rateDot.style.display = 'inline-block';
          rateDot.className = 'compare-strip-rate-dot r-1';
          rateDot.textContent = '良';
        } else if (r === -1) {
          rateDot.style.display = 'inline-block';
          rateDot.className = 'compare-strip-rate-dot r--1';
          rateDot.textContent = '棄';
        } else {
          rateDot.style.display = 'none';
        }
      }

      if (isB) {
        item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    });
  }

  /**
   * 右(B)の候補写真を前後へ切り替え（現在 A に入っている写真は自動スキップ）
   */
  function stepCandidateB(delta) {
    const len = cmpState.pool.length;
    if (len <= 2) return;

    let nextIdx = cmpState.idxB + delta;
    if (nextIdx === cmpState.idxA) {
      nextIdx += delta;
    }
    if (nextIdx < 0 || nextIdx >= len) {
      return;
    }
    cmpState.idxB = nextIdx;
    updateComparePanesUI();
  }

  /**
   * 左(A)と右(B)の写真を入れ替え (Sキー)
   */
  function swapCompareSides() {
    const tmpIdx = cmpState.idxA;
    cmpState.idxA = cmpState.idxB;
    cmpState.idxB = tmpIdx;

    // 個別に調整したズーム倍率・ビュー座標も写真と一緒に左右入れ替え
    const tmpZ = cmpState.zoomA;
    cmpState.zoomA = cmpState.zoomB;
    cmpState.zoomB = tmpZ;

    const tmpPX = cmpState.panAX;
    const tmpPY = cmpState.panAY;
    cmpState.panAX = cmpState.panBX;
    cmpState.panAY = cmpState.panBY;
    cmpState.panBX = tmpPX;
    cmpState.panBY = tmpPY;

    updateComparePanesUI();
  }

  /**
   * トーナメント勝ち抜き：右(B)の写真を左(A:基準)に昇格させ、右(B)には次の候補を入れる (Wキー)
   */
  function promoteRightToLeftAndAdvance() {
    const len = cmpState.pool.length;
    const winnerIdx = cmpState.idxB;
    const oldA = cmpState.idxA;
    cmpState.idxA = winnerIdx;

    // 昇格した右(B)のズーム倍率・ビュー位置を左(A)に引き継ぐ
    cmpState.zoomA = cmpState.zoomB;
    cmpState.panAX = cmpState.panBX;
    cmpState.panAY = cmpState.panBY;

    if (len > 2) {
      let nextB = Math.max(oldA, winnerIdx) + 1;
      if (nextB >= len) {
        // 末尾に達していたら、まだ比較していない別のインデックスまたは oldA を表示
        nextB = (winnerIdx + 1) % len;
        if (nextB === cmpState.idxA) nextB = oldA;
      }
      cmpState.idxB = nextB;
    } else {
      cmpState.idxB = oldA;
    }

    updateComparePanesUI();
    if (typeof showToast === 'function') {
      const p = cmpState.pool[cmpState.idxA];
      showToast(`👑 「${p ? p.file_name : ''}」を左(A:基準)にセットしました`, 'info', 1800);
    }
  }

  /**
   * 指定ペイン ('A' | 'B') の写真に評価を付与し、メイン画面・DBとも完全同期
   */
  async function rateComparePhoto(side, ratingVal) {
    const idx = (side === 'A') ? cmpState.idxA : cmpState.idxB;
    const photo = cmpState.pool[idx];
    if (!photo) return;

    const newRating = (photo.rating === ratingVal) ? 0 : ratingVal;
    photo.rating = newRating;

    // state.photos 内の該当オブジェクトおよびスタック内オブジェクトも同期
    if (typeof state !== 'undefined' && Array.isArray(state.photos)) {
      const mainPhoto = state.photos.find(p => p.id === photo.id);
      if (mainPhoto) mainPhoto.rating = newRating;
    }
    if (typeof updateCardRatingDirectly === 'function') {
      updateCardRatingDirectly(photo.id, newRating);
    }

    updateCompareMetaAndStripOnly();

    // APIへ保存（グリッド全体のフィルタ除外による強制ジャンプを避けるため直接API送信）
    try {
      await fetch(`/api/photo/${photo.id}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: newRating }),
      });
    } catch (err) {
      console.error('[Compare] 評価更新エラー:', err);
    }
  }

  /**
   * 比較画面内の左右RGBヒストグラムの表示/非表示トグル
   */
  function toggleCompareHistogram(forceState) {
    cmpState.histOpen = (forceState !== undefined) ? Boolean(forceState) : !cmpState.histOpen;
    const hudA = document.getElementById('compareHistHudA');
    const hudB = document.getElementById('compareHistHudB');
    const btn = document.getElementById('compareHistToggleBtn');

    if (hudA) hudA.style.display = cmpState.histOpen ? 'block' : 'none';
    if (hudB) hudB.style.display = cmpState.histOpen ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', cmpState.histOpen);

    if (cmpState.histOpen) {
      requestAnimationFrame(refreshCompareHistograms);
    }
  }

  /**
   * 左右両方のヒストグラムを計算・描画
   */
  function refreshCompareHistograms() {
    if (!cmpState.isOpen || !cmpState.histOpen) return;
    if (typeof window.computeHistogramFromImage !== 'function' || typeof window.renderHistogramToCanvas !== 'function') {
      return;
    }

    const mode = typeof window.getHistogramMode === 'function' ? window.getHistogramMode() : 'rgb';
    const imgA = document.getElementById('compareImgA');
    const imgB = document.getElementById('compareImgB');
    const canvasA = document.getElementById('cmpHistACanvas');
    const canvasB = document.getElementById('cmpHistBCanvas');

    if (imgA && canvasA) {
      cmpState.histDataA = window.computeHistogramFromImage(imgA);
      window.renderHistogramToCanvas(canvasA, cmpState.histDataA, mode);
      if (typeof window.updateHistogramStatsDom === 'function') {
        window.updateHistogramStatsDom('cmpHistA', cmpState.histDataA);
      }
    }

    if (imgB && canvasB) {
      cmpState.histDataB = window.computeHistogramFromImage(imgB);
      window.renderHistogramToCanvas(canvasB, cmpState.histDataB, mode);
      if (typeof window.updateHistogramStatsDom === 'function') {
        window.updateHistogramStatsDom('cmpHistB', cmpState.histDataB);
      }
    }
  }

  /**
   * 現在のコンテキスト（ライトボックス / 複数選択 / スタック / 一覧）から最適な写真プールを選んで比較画面を開く
   */
  function openCompareModal() {
    if (typeof state === 'undefined' || !Array.isArray(state.photos) || state.photos.length === 0) {
      if (typeof showToast === 'function') showToast('比較できる写真がありません', 'warning');
      return;
    }

    ensureCompareModalDom();

    let pool = [];
    let idxA = 0;
    let idxB = 1;
    let sourceLabel = '';

    // 1. ライトボックスが開いている場合
    if (state.currentPhotoIndex >= 0) {
      if (Array.isArray(state.currentLightboxStackPhotos) && state.currentLightboxStackPhotos.length >= 2) {
        pool = [...state.currentLightboxStackPhotos];
        idxA = Math.max(0, state.currentLightboxStackIndex);
        idxB = (idxA + 1 < pool.length) ? idxA + 1 : Math.max(0, idxA - 1);
        const stType = state.currentLightboxStackType;
        if (stType === 'bracket') sourceLabel = `⚡ 露出ブラケット比較 (${pool.length}枚)`;
        else if (stType === 'duplicate') sourceLabel = `📋 重複グループ比較 (${pool.length}枚)`;
        else sourceLabel = `⚡ 連写グループ比較 (${pool.length}コマ)`;
      } else {
        pool = state.photos;
        idxA = state.currentPhotoIndex;
        idxB = (idxA + 1 < pool.length) ? idxA + 1 : Math.max(0, idxA - 1);
        sourceLabel = `🖼️ 前後写真の比較 (${pool.length}枚)`;
      }
    }
    // 2. 一覧画面で2枚以上選択されている場合
    else if (state.selectedPhotoIds && state.selectedPhotoIds.size >= 2) {
      pool = state.photos.filter(p => state.selectedPhotoIds.has(p.id));
      idxA = 0;
      idxB = 1;
      sourceLabel = `✓ 選択中の写真を比較 (${pool.length}枚)`;
    }
    // 3. 一覧画面で1枚選択（または未選択）の場合
    else {
      let targetPhoto = null;
      let targetGridIdx = 0;
      if (state.selectedPhotoIds && state.selectedPhotoIds.size === 1) {
        const selId = Array.from(state.selectedPhotoIds)[0];
        targetGridIdx = Math.max(0, state.photos.findIndex(p => p.id === selId));
        targetPhoto = state.photos[targetGridIdx];
      } else if (state.activeInspectorPhotoId) {
        targetGridIdx = Math.max(0, state.photos.findIndex(p => p.id === state.activeInspectorPhotoId));
        targetPhoto = state.photos[targetGridIdx];
      } else {
        targetPhoto = state.photos[0];
        targetGridIdx = 0;
      }

      // もしその1枚がスタック（連写・ブラケット）を持っていればスタック内比較へ！
      if (targetPhoto && Array.isArray(targetPhoto.stack_photos) && targetPhoto.stack_photos.length >= 2) {
        pool = [...targetPhoto.stack_photos];
        idxA = Math.max(0, pool.findIndex(sp => sp.id === targetPhoto.id));
        idxB = (idxA + 1 < pool.length) ? idxA + 1 : Math.max(0, idxA - 1);
        sourceLabel = `⚡ スタック内比較 (${pool.length}枚)`;
      } else {
        pool = state.photos;
        idxA = targetGridIdx;
        idxB = (idxA + 1 < pool.length) ? idxA + 1 : Math.max(0, idxA - 1);
        sourceLabel = `🖼️ 写真一覧の比較 (${pool.length}枚)`;
      }
    }

    if (pool.length < 2) {
      if (typeof showToast === 'function') {
        showToast('比較するには2枚以上の写真が必要です', 'warning');
      }
      return;
    }

    cmpState.pool = pool;
    cmpState.idxA = idxA;
    cmpState.idxB = idxB === idxA ? ((idxA + 1) % pool.length) : idxB;
    cmpState.sourceLabel = sourceLabel;
    cmpState.isOpen = true;
    cmpState.activeSide = 'B';

    const badgeEl = document.getElementById('compareSourceBadge');
    if (badgeEl) badgeEl.textContent = sourceLabel;

    // ストリップを一旦クリアして新規プールで構築させる
    const stripEl = document.getElementById('compareStrip');
    if (stripEl) stripEl.innerHTML = '';

    resetCompareZoom();
    setActiveCompareSide('B');
    modalEl.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    updateComparePanesUI();
  }

  /**
   * 比較モーダルを閉じる
   */
  function closeCompareModal() {
    if (!cmpState.isOpen) return;
    cmpState.isOpen = false;
    if (modalEl) modalEl.style.display = 'none';

    // 比較中に変更された評価によって現在の評価フィルタ条件から外れた写真をグリッドから即座に除外
    if (typeof state !== 'undefined' && Array.isArray(cmpState.pool)) {
      let removedAny = false;
      for (const p of cmpState.pool) {
        if (!p) continue;
        const r = Number(p.rating || 0);
        const shouldRemove =
          (state.ratingFilter === 'normal' && r === -1) ||
          (state.ratingFilter === 1 && r !== 1) ||
          (state.ratingFilter === 2 && r !== 2) ||
          (state.ratingFilter === -1 && r !== -1);
        if (shouldRemove && typeof removePhotoFromView === 'function') {
          removePhotoFromView(p.id);
          removedAny = true;
        }
      }
      if (!removedAny && typeof updateInspectorView === 'function' && state.isInspectorOpen) {
        updateInspectorView();
      }
    }

    // ライトボックスが開いていなければ body の overflow を戻す
    if (typeof state !== 'undefined' && state.currentPhotoIndex < 0) {
      document.body.style.overflow = '';
    }
  }

  /**
   * 既存UI（ライトボックスヘッダー、下部選択フローティングバー、右クリックメニュー）へのボタン注入 & キーボード配線
   */
  function initCompareModule() {
    // 1. ライトボックスヘッダー（✂ 調整ボタンの左隣）に「⚖️ 2枚比較 (V)」ボタンを追加
    const lbAdjustBtn = document.getElementById('lightboxAdjustBtn');
    if (lbAdjustBtn && !document.getElementById('lightboxCompareBtn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-action-btn';
      btn.id = 'lightboxCompareBtn';
      btn.title = '2枚並べてピント・構図・露出を比較 (Vキー)';
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="4" width="9" height="16" rx="1.5"/>
          <rect x="13" y="4" width="9" height="16" rx="1.5"/>
        </svg>
      `;
      btn.addEventListener('click', () => openCompareModal());
      lbAdjustBtn.insertAdjacentElement('beforebegin', btn);
    }

    // 2. 下部フローティング選択バーに「⚖️ 2枚比較 (V)」ボタンを追加
    const floatingRefreshBtn = document.getElementById('floatingRefreshThumbBtn');
    if (floatingRefreshBtn && !document.getElementById('floatingCompareBtn')) {
      const fBtn = document.createElement('button');
      fBtn.type = 'button';
      fBtn.className = 'btn btn-secondary btn-sm';
      fBtn.id = 'floatingCompareBtn';
      fBtn.title = '選択中の写真を左右2枚並べて同時ズーム比較します (Vキー)';
      fBtn.innerHTML = `
        <span class="btn-icon">⚖️</span>
        <span class="btn-label">2枚比較 (V)</span>
      `;
      fBtn.addEventListener('click', () => openCompareModal());
      floatingRefreshBtn.insertAdjacentElement('beforebegin', fBtn);
    }

    // 3. 右クリックメニューの「🔍 プレビューを開く」の下に「⚖️ 2枚並べて比較 (V)」を追加
    const ctxPreviewItem = document.getElementById('contextMenuPreviewItem');
    if (ctxPreviewItem && !document.getElementById('contextMenuCompareItem')) {
      const cItem = document.createElement('div');
      cItem.className = 'context-menu-item';
      cItem.id = 'contextMenuCompareItem';
      cItem.innerHTML = `
        <div class="menu-item-content">
          <span>⚖️ 2枚並べて比較 (V)</span>
        </div>
      `;
      cItem.addEventListener('click', () => {
        if (typeof closeContextMenu === 'function') closeContextMenu();
        openCompareModal();
      });
      ctxPreviewItem.insertAdjacentElement('afterend', cItem);
    }

    // 4. キーボードショートカット（キャプチャフェーズで比較モーダル操作＆ [V] キートグルを処理）
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable)) {
        return;
      }

      // 比較モーダルが開いている時の専用キーバインド
      if (cmpState.isOpen) {
        if (e.key === 'Escape' || e.key === 'v' || e.key === 'V' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          closeCompareModal();
          return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          stepCandidateB(1);
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          stepCandidateB(-1);
          return;
        }
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          e.stopPropagation();
          swapCompareSides();
          return;
        }
        if (e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          e.stopPropagation();
          promoteRightToLeftAndAdvance();
          return;
        }
        if (e.key === '1') {
          e.preventDefault();
          e.stopPropagation();
          rateComparePhoto(cmpState.activeSide, 2);
          return;
        }
        if (e.key === '2') {
          e.preventDefault();
          e.stopPropagation();
          rateComparePhoto(cmpState.activeSide, 1);
          return;
        }
        if (e.key === '3' || e.key === 'x' || e.key === 'X') {
          e.preventDefault();
          e.stopPropagation();
          rateComparePhoto(cmpState.activeSide, -1);
          return;
        }
        if (e.key === '0' || e.key === '4') {
          e.preventDefault();
          e.stopPropagation();
          rateComparePhoto(cmpState.activeSide, 0);
          return;
        }
        return;
      }

      // 比較モーダルが閉じている時: [V] キーで比較モーダルを起動
      if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'v' || e.key === 'V')) {
        // 他のモーダルが開いている時は無視
        const blockingModals = ['helpModal', 'smartTakeoutModal', 'dbMaintenanceModal', 'mobileConnectModal', 'gpsCandidateModal', 'imageAdjustModal', 'slideshowModal', 'locationMapModal', 'labKarteModal'];
        for (const mId of blockingModals) {
          const mEl = document.getElementById(mId);
          if (mEl && mEl.style.display !== 'none' && mEl.style.display !== '') return;
        }

        e.preventDefault();
        openCompareModal();
      }
    }, true);
  }

  // グローバル公開API
  window.openCompareModal = openCompareModal;
  window.closeCompareModal = closeCompareModal;
  window.toggleCompareHistogram = toggleCompareHistogram;
  window.refreshCompareHistograms = refreshCompareHistograms;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCompareModule);
  } else {
    initCompareModule();
  }
})();
