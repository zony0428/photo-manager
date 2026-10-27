/**
 * ジオタグ 47都道府県 撮影制覇白地図 ＆ 🔥 撮影密度ヒートマップ ＆ 👣 撮影さんぽ軌跡ライン モジュール
 *
 * 機能概要:
 * - グローバル公開関数:
 *   - window.initLocationMapModal(): イベントリスナー登録（#openLocationMapModalBtn, #closeLocationMapModalBtn, タブ切替等）
 *   - window.openLocationMapModal(initialTab = 'whitemap'): #locationMapModal を開き、GET /api/locations/heatmap を取得して描画
 *   - window.closeLocationMapModal(): モーダルを閉じる
 * - タブ1 (#mapTabPaneWhitemap): 🗾 47都道府県 撮影制覇白地図（インラインSVGカルトグラム＋地方区分枠、撮影枚数/優枚数モード切替、ホバー詳細パネル、クリックで都道府県/海外国フィルタ適用）
 * - タブ2 (#mapTabPaneHeatmap): 🔥 撮影密度ヒートマップ（Leaflet + Custom Canvas Overlay による放射状グラデーション描画＋クリック可能なエリアサークル）
 * - タブ3 (#mapTabPaneTrajectory): 👣 撮影さんぽ軌跡ライン（日付セレクタ連動、時系列ポリライン、START/GOAL/番号/優スターマーカー、滞在ホットスポット自動検出、Haversine総移動距離・所要時間・歩数換算表示、写真ジャンプ）
 */

(function () {
  'use strict';

  /** 日本47都道府県のカルトグラム配置定義（全47都道府県・重複なし・地方区分付き） */
  const JP_PREF_CARTOGRAM = [
    // 北海道地方 (1)
    { full: '北海道', short: '北海道', region: '北海道', col: 12, row: 0, colSpan: 2, rowSpan: 2 },
    // 東北地方 (6)
    { full: '青森県', short: '青森', region: '東北', col: 12, row: 2, colSpan: 2, rowSpan: 1 },
    { full: '秋田県', short: '秋田', region: '東北', col: 12, row: 3, colSpan: 1, rowSpan: 1 },
    { full: '岩手県', short: '岩手', region: '東北', col: 13, row: 3, colSpan: 1, rowSpan: 1 },
    { full: '山形県', short: '山形', region: '東北', col: 12, row: 4, colSpan: 1, rowSpan: 1 },
    { full: '宮城県', short: '宮城', region: '東北', col: 13, row: 4, colSpan: 1, rowSpan: 1 },
    { full: '福島県', short: '福島', region: '東北', col: 12, row: 5, colSpan: 2, rowSpan: 1 },
    // 関東地方 (7)
    { full: '群馬県', short: '群馬', region: '関東', col: 11, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '栃木県', short: '栃木', region: '関東', col: 12, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '茨城県', short: '茨城', region: '関東', col: 13, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '埼玉県', short: '埼玉', region: '関東', col: 11, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '東京都', short: '東京', region: '関東', col: 12, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '千葉県', short: '千葉', region: '関東', col: 13, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '神奈川県', short: '神奈川', region: '関東', col: 12, row: 8, colSpan: 1, rowSpan: 1 },
    // 中部地方 (9)
    { full: '石川県', short: '石川', region: '中部', col: 8, row: 4, colSpan: 1, rowSpan: 1 },
    { full: '福井県', short: '福井', region: '中部', col: 8, row: 5, colSpan: 1, rowSpan: 1 },
    { full: '富山県', short: '富山', region: '中部', col: 9, row: 5, colSpan: 1, rowSpan: 1 },
    { full: '新潟県', short: '新潟', region: '中部', col: 10, row: 5, colSpan: 2, rowSpan: 1 },
    { full: '岐阜県', short: '岐阜', region: '中部', col: 9, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '長野県', short: '長野', region: '中部', col: 10, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '愛知県', short: '愛知', region: '中部', col: 9, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '山梨県', short: '山梨', region: '中部', col: 10, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '静岡県', short: '静岡', region: '中部', col: 10, row: 8, colSpan: 2, rowSpan: 1 },
    // 近畿地方 (7)
    { full: '兵庫県', short: '兵庫', region: '近畿', col: 6, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '京都府', short: '京都', region: '近畿', col: 7, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '滋賀県', short: '滋賀', region: '近畿', col: 8, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '大阪府', short: '大阪', region: '近畿', col: 6, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '奈良県', short: '奈良', region: '近畿', col: 7, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '三重県', short: '三重', region: '近畿', col: 8, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '和歌山県', short: '和歌山', region: '近畿', col: 6, row: 8, colSpan: 2, rowSpan: 1 },
    // 中国地方 (5)
    { full: '島根県', short: '島根', region: '中国', col: 4, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '鳥取県', short: '鳥取', region: '中国', col: 5, row: 6, colSpan: 1, rowSpan: 1 },
    { full: '広島県', short: '広島', region: '中国', col: 4, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '岡山県', short: '岡山', region: '中国', col: 5, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '山口県', short: '山口', region: '中国', col: 3, row: 6, colSpan: 1, rowSpan: 2 },
    // 四国地方 (4)
    { full: '愛媛県', short: '愛媛', region: '四国', col: 4, row: 9, colSpan: 1, rowSpan: 1 },
    { full: '香川県', short: '香川', region: '四国', col: 5, row: 9, colSpan: 1, rowSpan: 1 },
    { full: '高知県', short: '高知', region: '四国', col: 4, row: 10, colSpan: 1, rowSpan: 1 },
    { full: '徳島県', short: '徳島', region: '四国', col: 5, row: 10, colSpan: 1, rowSpan: 1 },
    // 九州・沖縄地方 (8)
    { full: '長崎県', short: '長崎', region: '九州・沖縄', col: 0, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '佐賀県', short: '佐賀', region: '九州・沖縄', col: 1, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '福岡県', short: '福岡', region: '九州・沖縄', col: 2, row: 7, colSpan: 1, rowSpan: 1 },
    { full: '熊本県', short: '熊本', region: '九州・沖縄', col: 1, row: 8, colSpan: 1, rowSpan: 1 },
    { full: '大分県', short: '大分', region: '九州・沖縄', col: 2, row: 8, colSpan: 1, rowSpan: 1 },
    { full: '鹿児島県', short: '鹿児島', region: '九州・沖縄', col: 1, row: 9, colSpan: 1, rowSpan: 1 },
    { full: '宮崎県', short: '宮崎', region: '九州・沖縄', col: 2, row: 9, colSpan: 1, rowSpan: 1 },
    { full: '沖縄県', short: '沖縄', region: '九州・沖縄', col: 0, row: 10, colSpan: 1, rowSpan: 1 },
  ];

  /** 地方区分ごとの背景フレーム定義 */
  const REGION_FRAMES = [
    { name: '北海道', col: 12, row: 0, colSpan: 2, rowSpan: 2 },
    { name: '東北', col: 12, row: 2, colSpan: 2, rowSpan: 4 },
    { name: '関東', col: 11, row: 6, colSpan: 3, rowSpan: 3 },
    { name: '中部', col: 8, row: 4, colSpan: 4, rowSpan: 5 },
    { name: '近畿', col: 6, row: 6, colSpan: 3, rowSpan: 3 },
    { name: '中国', col: 3, row: 6, colSpan: 3, rowSpan: 2 },
    { name: '四国', col: 4, row: 9, colSpan: 2, rowSpan: 2 },
    { name: '九州・沖縄', col: 0, row: 7, colSpan: 3, rowSpan: 4 },
  ];

  /** モーダル内部状態 */
  let activeMapTab = 'whitemap';
  let whitemapMode = 'count'; // 'count' (📷撮影枚数モード) | 'excellent' (🏅優枚数モード)
  let latestMapData = null;
  let selectedPrefFull = null;

  /** Leaflet マップインスタンス管理 */
  let heatmapLeaflet = null;
  let heatmapCanvasLayer = null;
  let heatmapMarkersGroup = null;

  let trajectoryLeaflet = null;
  let trajectoryLayerGroup = null;
  let currentTrajectoryDate = '';

  /**
   * HTMLエスケープヘルパー（_escHtml / escapeHtml フォールバック付き）
   * @param {*} str
   * @returns {string}
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
   * 制覇都道府県数に応じた称号ランクを返す
   * @param {number} conqueredCount 0〜47
   * @returns {{ title: string, badge: string }}
   */
  function getConquestRankTitle(conqueredCount) {
    const c = Number(conqueredCount || 0);
    if (c >= 47) return { title: '全国47都道府県 完全制覇グランドマスター', badge: 'Rank SSS' };
    if (c >= 35) return { title: '日本列島制覇マイスター', badge: 'Rank S' };
    if (c >= 24) return { title: '全国縦断フォトトラベラー', badge: 'Rank A' };
    if (c >= 12) return { title: '旅するフォトグラファー', badge: 'Rank B' };
    if (c >= 5) return { title: '地域開拓エクスプローラー', badge: 'Rank C' };
    if (c >= 1) return { title: '撮影旅の始まり', badge: 'Rank D' };
    return { title: '未踏の地図（GPS写真をスキャンしよう）', badge: '-' };
  }

  /**
   * 枚数に応じた5段階の日の丸朱色（#e14d2a）グラデーション塗りと文字色を返す
   * @param {number} val 対象枚数
   * @param {number} maxVal 最大枚数
   * @returns {{ fill: string, stroke: string, textColor: string, subColor: string, level: number }}
   */
  function getPrefectureColorStyle(val, maxVal) {
    const v = Number(val || 0);
    if (v <= 0) {
      return {
        fill: 'var(--bg-tertiary, #303844)',
        stroke: 'var(--border-soft, #2f3642)',
        textColor: 'var(--text-muted, #94a3b8)',
        subColor: 'var(--text-dim, #64748b)',
        level: 0,
      };
    }

    // 対数スケールまたは閾値で5段階（Level 1〜5）に分類
    const safeMax = Math.max(5, Number(maxVal || 1));
    const ratio = Math.min(1, Math.log10(v + 1) / Math.log10(safeMax + 1));

    if (ratio < 0.25 || v === 1) {
      return {
        fill: 'rgba(225, 77, 42, 0.28)',
        stroke: 'rgba(225, 77, 42, 0.55)',
        textColor: 'var(--text-primary, #f1f5f9)',
        subColor: 'var(--text-secondary, #cbd5e1)',
        level: 1,
      };
    }
    if (ratio < 0.48) {
      return {
        fill: 'rgba(225, 77, 42, 0.46)',
        stroke: 'rgba(225, 77, 42, 0.72)',
        textColor: '#ffffff',
        subColor: 'rgba(255, 255, 255, 0.88)',
        level: 2,
      };
    }
    if (ratio < 0.68) {
      return {
        fill: 'rgba(225, 77, 42, 0.64)',
        stroke: 'rgba(225, 77, 42, 0.86)',
        textColor: '#ffffff',
        subColor: 'rgba(255, 255, 255, 0.92)',
        level: 3,
      };
    }
    if (ratio < 0.86) {
      return {
        fill: 'rgba(225, 77, 42, 0.82)',
        stroke: '#e14d2a',
        textColor: '#ffffff',
        subColor: 'rgba(255, 255, 255, 0.95)',
        level: 4,
      };
    }
    return {
      fill: 'var(--accent-primary, #e14d2a)',
      stroke: '#ff785a',
      textColor: '#ffffff',
      subColor: '#fff7ed',
      level: 5,
    };
  }

  /**
   * 2点間の緯度・経度から Haversine 公式で距離（km）を算出する
   * @param {number} lat1
   * @param {number} lon1
   * @param {number} lat2
   * @param {number} lon2
   * @returns {number} 距離 (km)
   */
  function calcHaversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0; // 地球半径 (km)
    const toRad = deg => (deg * Math.PI) / 180.0;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return R * c;
  }

  /**
   * EXIF日時文字列 ("YYYY-MM-DD HH:MM:SS" または "YYYY:MM:DD HH:MM:SS") をミリ秒タイムスタンプに変換する
   * @param {string} dateStr
   * @returns {number|null}
   */
  function parsePhotoTimestampMs(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const cleaned = dateStr.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const m = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    const hr = parseInt(m[4] || '0', 10);
    const min = parseInt(m[5] || '0', 10);
    const sec = parseInt(m[6] || '0', 10);
    return new Date(year, month, day, hr, min, sec).getTime();
  }

  /**
   * #locationMapModal および内部要素が存在しない場合にDOM構造を生成・補完する
   * @returns {HTMLElement}
   */
  function ensureLocationMapModalDom() {
    let modal = document.getElementById('locationMapModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'locationMapModal';
      modal.className = 'modal-backdrop';
      modal.style.display = 'none';
      document.body.appendChild(modal);
    }

    if (
      !modal.querySelector('#mapTabPaneWhitemap') ||
      !modal.querySelector('#mapTabPaneHeatmap') ||
      !modal.querySelector('#mapTabPaneTrajectory')
    ) {
      modal.innerHTML = `
        <div class="modal-card modal-card-lg location-map-modal-card" style="max-width: 1120px; width: 95vw; max-height: 90vh; display: flex; flex-direction: column;">
          <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border-soft, #2f3642);">
            <div class="modal-header-title">
              <h2 style="margin: 0; font-size: 1.12rem; display: flex; align-items: center; gap: 8px;">
                <span>ジオタグ全国制覇マップ ＆ 撮影密度ヒートマップ ＆ 撮影さんぽ軌跡</span>
              </h2>
              <span class="modal-subtitle" style="font-size: 0.78rem; color: var(--text-muted, #94a3b8);">
                47都道府県の撮影制覇状況・よく撮るホットスポット・1日のフォトラリー移動軌跡を可視化します
              </span>
            </div>
            <button type="button" class="modal-close-btn" id="closeLocationMapModalBtn" title="閉じる (Esc)">&times;</button>
          </div>

          <!-- 上部サマリーバー（クリック不可の静的な統計枠 .lab-stat-box） -->
          <div id="locationMapSummaryBar" class="location-map-summary-bar" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; padding: 12px 20px; background: var(--bg-tertiary, #252b34); border-bottom: 1px solid var(--border-soft, #2f3642);"></div>

          <!-- アンダーラインタブバー（四角い枠線を持たない .map-tab-btn） -->
          <div class="map-tabs-nav" id="locationMapTabsNav" style="display: flex; gap: 22px; padding: 0 20px; border-bottom: 1px solid var(--border-soft, #2f3642); background: var(--bg-secondary, #1b2028);">
            <button type="button" class="map-tab-btn active" data-map-tab="whitemap" style="padding: 11px 4px; background: transparent; border: none; border-bottom: 2px solid var(--accent-primary, #e14d2a); color: var(--text-primary, #f1f5f9); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
              47都道府県 撮影制覇白地図
            </button>
            <button type="button" class="map-tab-btn" data-map-tab="heatmap" style="padding: 11px 4px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #94a3b8); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
              撮影密度ヒートマップ
            </button>
            <button type="button" class="map-tab-btn" data-map-tab="trajectory" style="padding: 11px 4px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #94a3b8); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
              撮影さんぽ軌跡ライン
            </button>
          </div>

          <!-- タブコンテンツ本体 -->
          <div class="modal-body location-map-modal-body" style="padding: 16px 20px; overflow-y: auto; flex: 1;">
            <!-- タブ1: 47都道府県 撮影制覇白地図 -->
            <div id="mapTabPaneWhitemap" class="map-tab-pane active">
              <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 0.8rem; color: var(--text-muted, #94a3b8); font-weight: 600;">塗り分け基準:</span>
                  <div class="whitemap-mode-group" id="whitemapModeGroup">
                    <button type="button" class="btn btn-primary btn-xs whitemap-mode-btn active" id="whitemapModeCountBtn" data-whitemap-mode="count">
                      撮影枚数モード
                    </button>
                    <button type="button" class="btn btn-secondary btn-xs whitemap-mode-btn" id="whitemapModeExcellentBtn" data-whitemap-mode="excellent">
                      優枚数モード
                    </button>
                  </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px; font-size: 0.75rem; color: var(--text-muted, #94a3b8);">
                  <span>未訪問 <span style="display: inline-block; width: 11px; height: 11px; background: var(--bg-tertiary, #303844); border: 1px solid var(--border-soft, #2f3642); border-radius: 2px; vertical-align: middle;"></span></span>
                  <span>少 <span style="display: inline-block; width: 11px; height: 11px; background: rgba(225, 77, 42, 0.28); border-radius: 2px; vertical-align: middle;"></span></span>
                  <span><span style="display: inline-block; width: 11px; height: 11px; background: rgba(225, 77, 42, 0.55); border-radius: 2px; vertical-align: middle;"></span></span>
                  <span><span style="display: inline-block; width: 11px; height: 11px; background: rgba(225, 77, 42, 0.80); border-radius: 2px; vertical-align: middle;"></span></span>
                  <span><span style="display: inline-block; width: 11px; height: 11px; background: var(--accent-primary, #e14d2a); border-radius: 2px; vertical-align: middle;"></span> 多（クリックで都道府県絞り込み）</span>
                </div>
              </div>

              <div style="display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; align-items: start;">
                <div id="whitemapSvgContainer" style="background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642); border-radius: 8px; padding: 10px; min-height: 430px; display: flex; align-items: center; justify-content: center;"></div>
                <div id="whitemapPrefDetail" style="background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 12px;"></div>
              </div>

              <!-- 海外・国別クイックフィルタチップ -->
              <div id="whitemapCountriesBar" style="margin-top: 12px;"></div>
            </div>

            <!-- タブ2: 撮影密度ヒートマップ -->
            <div id="mapTabPaneHeatmap" class="map-tab-pane" style="display: none;">
              <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 10px;">
                <span style="font-size: 0.8rem; color: var(--text-secondary, #cbd5e1);">
                  撮影密度が高い場所ほど <strong>青緑 → 黄 → 橙 → 朱赤（#e14d2a）</strong> に輝きます。サークルをクリックすると地域で絞り込めます。
                </span>
                <span class="badge-sub" id="heatmapPointsCountBadge">0 メッシュ</span>
              </div>
              <div id="heatmapLeafletContainer" style="width: 100%; height: 470px; border-radius: 8px; border: 1px solid var(--border-soft, #2f3642); background: var(--bg-secondary, #1b2028); position: relative;"></div>
            </div>

            <!-- タブ3: 撮影さんぽ軌跡ライン -->
            <div id="mapTabPaneTrajectory" class="map-tab-pane" style="display: none;">
              <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <label for="trajectoryDateSelect" style="font-size: 0.82rem; font-weight: 600; color: var(--text-secondary, #cbd5e1);">撮影日を選択:</label>
                  <select id="trajectoryDateSelect" style="padding: 5px 10px; border-radius: 6px; background: var(--bg-secondary, #1b2028); color: var(--text-primary, #f1f5f9); border: 1px solid var(--border-soft, #2f3642); font-size: 0.82rem; min-width: 240px;"></select>
                </div>
                <div id="trajectoryStatsBar" style="display: flex; flex-wrap: wrap; gap: 8px;"></div>
              </div>
              <div id="trajectoryLeafletContainer" style="width: 100%; height: 455px; border-radius: 8px; border: 1px solid var(--border-soft, #2f3642); background: var(--bg-secondary, #1b2028); position: relative;"></div>
            </div>
          </div>
        </div>
      `;
    }

    return modal;
  }

  /**
   * ジオタグツリーツールバー内に「🗾 制覇マップ」起動ボタンが未配置の場合に追加する
   */
  function ensureSidebarTriggerButton() {
    if (document.getElementById('openLocationMapModalBtn')) return;
    const locToolbar = document.getElementById('locationToolbar');
    if (!locToolbar) return;
    const firstGroup = locToolbar.querySelector('.location-toolbar-group') || locToolbar;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'openLocationMapModalBtn';
    btn.className = 'btn-mini-text';
    btn.title = '47都道府県 撮影制覇白地図・ヒートマップ・撮影さんぽ軌跡を開く';
    btn.innerHTML = '制覇マップ';
    firstGroup.insertBefore(btn, firstGroup.firstChild);
  }

  /**
   * モーダルを閉じる
   */
  function closeLocationMapModal() {
    const modal = document.getElementById('locationMapModal');
    if (modal) {
      modal.style.display = 'none';
    }
  }
  window.closeLocationMapModal = closeLocationMapModal;

  /**
   * 上部サマリーバー（#locationMapSummaryBar）を静的な統計カード（.lab-stat-box）で描画する
   * @param {Object} data
   */
  function renderLocationSummaryBar(data) {
    const bar = document.getElementById('locationMapSummaryBar');
    if (!bar || !data) return;

    const conquered = Number(data.conquered_prefectures_count || 0);
    const totalPrefs = Number(data.total_prefectures || 47);
    const pct = Math.round((conquered / totalPrefs) * 100);
    const totalGeo = Number(data.total_geotagged || 0);
    const countries = Array.isArray(data.countries) ? data.countries : [];
    const rankInfo = getConquestRankTitle(conquered);

    bar.innerHTML = `
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">全国47都道府県 制覇率</div>
        <div style="font-size: 1.08rem; font-weight: 700; color: var(--accent-primary, #e14d2a); margin-top: 2px;">
          ${conquered} / ${totalPrefs} 都道府県 <span class="badge-sub" style="margin-left: 4px;">${pct}%</span>
        </div>
      </div>
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">総ジオタグ写真枚数</div>
        <div style="font-size: 1.08rem; font-weight: 700; color: var(--text-primary, #f1f5f9); margin-top: 2px;">
          ${totalGeo.toLocaleString()} <span style="font-size: 0.76rem; font-weight: 400; color: var(--text-muted, #94a3b8);">枚</span>
          <span class="badge-sub" style="margin-left: 6px;">${countries.length}の国と地域</span>
        </div>
      </div>
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642); grid-column: span 2;">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">制覇ランク称号</div>
        <div style="font-size: 0.96rem; font-weight: 700; color: var(--text-primary, #f1f5f9); margin-top: 3px; display: flex; align-items: center; gap: 8px;">
          <span>${escHtml(rankInfo.title)}</span>
          <span class="badge-sub">${escHtml(rankInfo.badge)}</span>
        </div>
      </div>
    `;
  }

  /**
   * 都道府県をクリックしてメイングリッドを絞り込み、モーダルを閉じる
   * @param {string} prefFullName 都道府県正式名 (例: '東京都')
   * @param {Object} [prefRecord] APIから返された都道府県統計オブジェクト
   */
  function filterByPrefectureAndClose(prefFullName, prefRecord) {
    if (!prefFullName) return;
    // APIが raw_states を返している場合は先頭または正式名を優先利用
    const targetState =
      prefRecord && Array.isArray(prefRecord.raw_states) && prefRecord.raw_states.length > 0
        ? prefRecord.raw_states[0]
        : prefFullName;

    if (typeof window.selectLocationFilter === 'function') {
      window.selectLocationFilter({
        country: '日本',
        state: targetState,
        city: null,
        label: prefFullName,
      });
    } else if (typeof state !== 'undefined' && state) {
      state.locationFilter = {
        country: '日本',
        state: targetState,
        city: null,
        label: prefFullName,
      };
      if (typeof fetchPhotos === 'function') fetchPhotos();
    }

    closeLocationMapModal();
    if (typeof showToast === 'function') {
      showToast(`「${prefFullName}」で撮影された写真を表示します`, 'info', 2500);
    }
  }

  /**
   * 右サイド詳細パネル（#whitemapPrefDetail）を更新する
   * @param {Object} cartoItem JP_PREF_CARTOGRAM要素
   * @param {Object|null} prefStat APIの都道府県統計
   */
  function updateWhitemapPrefDetailPanel(cartoItem, prefStat) {
    const detailEl = document.getElementById('whitemapPrefDetail');
    if (!detailEl || !cartoItem) return;

    const count = prefStat ? Number(prefStat.count || 0) : 0;
    const exc = prefStat ? Number(prefStat.excellent_count || 0) : 0;
    const good = prefStat ? Number(prefStat.good_count || 0) : 0;
    const excRate = count > 0 ? ((exc * 100) / count).toFixed(1) : '0.0';

    detailEl.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-soft, #2f3642); padding-bottom: 8px;">
        <div>
          <span class="badge-sub" style="margin-bottom: 3px; display: inline-block;">${escHtml(cartoItem.region)}地方</span>
          <h3 style="margin: 0; font-size: 1.08rem; color: var(--text-primary, #f1f5f9);">${escHtml(cartoItem.full)}</h3>
        </div>
        <span class="badge-sub" style="color: ${count > 0 ? 'var(--accent-primary, #e14d2a)' : 'var(--text-muted, #94a3b8)'};">
          ${count > 0 ? '制覇済' : '未訪問'}
        </span>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div class="lab-stat-box" style="padding: 8px; border-radius: 6px; background: var(--bg-tertiary, #252b34); border: 1px solid var(--border-soft, #2f3642);">
          <div style="font-size: 0.7rem; color: var(--text-muted, #94a3b8);">総撮影枚数</div>
          <div style="font-size: 1rem; font-weight: 700; color: var(--text-primary, #f1f5f9); margin-top: 2px;">${count.toLocaleString()}枚</div>
        </div>
        <div class="lab-stat-box" style="padding: 8px; border-radius: 6px; background: var(--bg-tertiary, #252b34); border: 1px solid var(--border-soft, #2f3642);">
          <div style="font-size: 0.7rem; color: var(--text-muted, #94a3b8);">優 / 打率</div>
          <div style="font-size: 1rem; font-weight: 700; color: var(--accent-primary, #e14d2a); margin-top: 2px;">${exc.toLocaleString()}枚 (${excRate}%)</div>
        </div>
        <div class="lab-stat-box" style="padding: 8px; border-radius: 6px; background: var(--bg-tertiary, #252b34); border: 1px solid var(--border-soft, #2f3642); grid-column: span 2;">
          <div style="font-size: 0.7rem; color: var(--text-muted, #94a3b8);">良 (Good) 枚数</div>
          <div style="font-size: 0.92rem; font-weight: 600; color: #f59e0b; margin-top: 2px;">${good.toLocaleString()}枚</div>
        </div>
      </div>

      ${
        count > 0
          ? `<button type="button" class="btn btn-primary btn-sm" id="whitemapFilterSelectedPrefBtn" style="width: 100%; justify-content: center; gap: 6px;">
               ${escHtml(cartoItem.full)}の写真を表示 (${count.toLocaleString()}枚)
             </button>`
          : `<div style="font-size: 0.76rem; color: var(--text-muted, #94a3b8); text-align: center; padding: 6px 0;">
               この都道府県のジオタグ付き写真はまだ登録されていません
             </div>`
      }
    `;

    const filterBtn = detailEl.querySelector('#whitemapFilterSelectedPrefBtn');
    if (filterBtn) {
      filterBtn.addEventListener('click', () => {
        filterByPrefectureAndClose(cartoItem.full, prefStat);
      });
    }
  }

  /**
   * タブ1: 🗾 47都道府県 撮影制覇白地図 (#mapTabPaneWhitemap) をインラインSVGで描画する
   * @param {Object} data
   */
  function renderWhitemapTab(data) {
    const svgContainer = document.getElementById('whitemapSvgContainer');
    if (!svgContainer || !data) return;

    // モード切替ボタンのアクティブ状態同期
    const modeCountBtn = document.getElementById('whitemapModeCountBtn');
    const modeExcBtn = document.getElementById('whitemapModeExcellentBtn');
    if (modeCountBtn && modeExcBtn) {
      const isCount = whitemapMode !== 'excellent';
      modeCountBtn.className = `btn ${isCount ? 'btn-primary' : 'btn-secondary'} btn-xs`;
      modeExcBtn.className = `btn ${!isCount ? 'btn-primary' : 'btn-secondary'} btn-xs`;
    }

    const prefList = Array.isArray(data.prefectures) ? data.prefectures : [];
    const prefMap = new Map();
    prefList.forEach(p => {
      if (p && p.prefecture) {
        prefMap.set(p.prefecture, p);
      }
    });

    const getMetricValue = pStat => {
      if (!pStat) return 0;
      return whitemapMode === 'excellent'
        ? Number(pStat.excellent_count || 0)
        : Number(pStat.count || 0);
    };

    const maxMetric = Math.max(
      1,
      ...JP_PREF_CARTOGRAM.map(c => getMetricValue(prefMap.get(c.full)))
    );

    const cellW = 54;
    const cellH = 38;
    const gap = 5;
    const padX = 24;
    const padY = 20;
    const svgWidth = padX * 2 + 14 * (cellW + gap);
    const svgHeight = padY * 2 + 11 * (cellH + gap);

    // 地方区分背景枠SVG
    const regionFramesSvg = REGION_FRAMES.map(rf => {
      const x = padX + rf.col * (cellW + gap) - 3;
      const y = padY + rf.row * (cellH + gap) - 3;
      const w = rf.colSpan * (cellW + gap) - gap + 6;
      const h = rf.rowSpan * (cellH + gap) - gap + 6;
      return `
        <g class="whitemap-region-frame">
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" ry="7"
                fill="rgba(148, 163, 184, 0.04)" stroke="var(--border-soft, #2f3642)" stroke-dasharray="3,3" stroke-width="1" />
        </g>
      `;
    }).join('');

    // 47都道府県セルSVG
    const cellsSvg = JP_PREF_CARTOGRAM.map(item => {
      const pStat = prefMap.get(item.full) || null;
      const val = getMetricValue(pStat);
      const totalCount = pStat ? Number(pStat.count || 0) : 0;
      const style = getPrefectureColorStyle(val, maxMetric);

      const x = padX + item.col * (cellW + gap);
      const y = padY + item.row * (cellH + gap);
      const w = item.colSpan * (cellW + gap) - gap;
      const h = item.rowSpan * (cellH + gap) - gap;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const cursor = totalCount > 0 ? 'pointer' : 'default';

      return `
        <g class="whitemap-pref-cell" data-pref-full="${escHtml(item.full)}" style="cursor: ${cursor}; transition: opacity 0.15s ease;">
          <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" ry="5"
                fill="${style.fill}" stroke="${style.stroke}" stroke-width="${style.level > 0 ? '1.5' : '1'}" />
          <text x="${cx}" y="${cy - 4}" text-anchor="middle" dominant-baseline="central"
                fill="${style.textColor}" font-size="11.5" font-weight="700" style="pointer-events: none; user-select: none;">
            ${escHtml(item.short)}
          </text>
          <text x="${cx}" y="${cy + 10}" text-anchor="middle" dominant-baseline="central"
                fill="${style.subColor}" font-size="9.5" font-weight="600" style="pointer-events: none; user-select: none;">
            ${val > 0 ? (whitemapMode === 'excellent' ? `優${val}` : `${val}`) : '-'}
          </text>
        </g>
      `;
    }).join('');

    svgContainer.innerHTML = `
      <svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" height="100%" style="max-height: 440px; display: block;">
        ${regionFramesSvg}
        ${cellsSvg}
      </svg>
    `;

    // 初期選択都道府県（撮影枚数1位の都道府県、なければ東京都）を詳細パネルに表示
    const defaultPrefFull =
      selectedPrefFull ||
      (prefList.length > 0 ? prefList[0].prefecture : '東京都');
    selectedPrefFull = defaultPrefFull;
    const defaultCarto =
      JP_PREF_CARTOGRAM.find(c => c.full === defaultPrefFull) || JP_PREF_CARTOGRAM[11];
    updateWhitemapPrefDetailPanel(defaultCarto, prefMap.get(defaultCarto.full) || null);

    // 各都道府県セルのホバー・クリックイベント
    svgContainer.querySelectorAll('.whitemap-pref-cell').forEach(cellEl => {
      const prefFull = cellEl.dataset.prefFull;
      const cartoItem = JP_PREF_CARTOGRAM.find(c => c.full === prefFull);
      const pStat = prefMap.get(prefFull) || null;

      cellEl.addEventListener('mouseenter', () => {
        if (cartoItem) {
          selectedPrefFull = cartoItem.full;
          updateWhitemapPrefDetailPanel(cartoItem, pStat);
        }
      });

      cellEl.addEventListener('click', () => {
        if (!cartoItem) return;
        selectedPrefFull = cartoItem.full;
        updateWhitemapPrefDetailPanel(cartoItem, pStat);
        if (pStat && Number(pStat.count || 0) > 0) {
          filterByPrefectureAndClose(cartoItem.full, pStat);
        }
      });
    });

    // 海外・国一覧チップバーの描画
    const countriesBar = document.getElementById('whitemapCountriesBar');
    if (countriesBar) {
      const countries = Array.isArray(data.countries) ? data.countries : [];
      if (countries.length > 0) {
        const chipsHtml = countries.map(c => {
          const cName = c.country || '不明';
          const cnt = Number(c.count || 0);
          const exc = Number(c.excellent_count || 0);
          const icon = '';
          return `
            <button type="button" class="btn btn-secondary btn-xs js-whitemap-country-chip" data-country="${escHtml(cName)}" style="gap: 5px;">
              <span>${icon} ${escHtml(cName)}</span>
              <span class="badge-sub">${cnt.toLocaleString()}枚${exc > 0 ? ` / 優${exc}` : ''}</span>
            </button>
          `;
        }).join('');

        countriesBar.innerHTML = `
          <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 12px; border-radius: 8px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642);">
            <span style="font-size: 0.78rem; color: var(--text-muted, #94a3b8); font-weight: 600;">国・地域別クイック絞り込み:</span>
            ${chipsHtml}
          </div>
        `;

        countriesBar.querySelectorAll('.js-whitemap-country-chip').forEach(btn => {
          btn.addEventListener('click', () => {
            const cName = btn.dataset.country;
            if (!cName) return;
            if (typeof window.selectLocationFilter === 'function') {
              window.selectLocationFilter({
                country: cName,
                state: null,
                city: null,
                label: cName,
              });
            }
            closeLocationMapModal();
            if (typeof showToast === 'function') {
              showToast(`「${cName}」の写真で絞り込みました`, 'info', 2500);
            }
          });
        });
      } else {
        countriesBar.innerHTML = '';
      }
    }
  }

  /**
   * タブ2: 🔥 撮影密度ヒートマップ (#mapTabPaneHeatmap) を Leaflet + Custom Canvas Overlay で描画する
   * @param {Object} data
   */
  function renderHeatmapTab(data) {
    const container = document.getElementById('heatmapLeafletContainer');
    if (!container || !data) return;

    const gridPoints = Array.isArray(data.grid_points) ? data.grid_points : [];
    const badgeEl = document.getElementById('heatmapPointsCountBadge');
    if (badgeEl) {
      badgeEl.textContent = `${gridPoints.length.toLocaleString()} エリア`;
    }

    if (typeof window.L === 'undefined') {
      container.innerHTML = `<div class="empty-hint" style="padding: 40px; text-align: center;">Leaflet 地図ライブラリが読み込まれていません</div>`;
      return;
    }

    const L = window.L;

    if (!heatmapLeaflet) {
      heatmapLeaflet = L.map(container, {
        center: [36.2, 138.2],
        zoom: 5,
        zoomControl: true,
        attributionControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(heatmapLeaflet);

      heatmapMarkersGroup = L.layerGroup().addTo(heatmapLeaflet);
    }

    setTimeout(() => {
      if (heatmapLeaflet) {
        heatmapLeaflet.invalidateSize();
      }
    }, 60);

    // 既存のカスタムCanvasレイヤーがあれば削除
    if (heatmapCanvasLayer && heatmapLeaflet.hasLayer(heatmapCanvasLayer)) {
      heatmapLeaflet.removeLayer(heatmapCanvasLayer);
    }
    if (heatmapMarkersGroup) {
      heatmapMarkersGroup.clearLayers();
    }

    if (gridPoints.length === 0) return;

    const maxGridCount = Math.max(1, ...gridPoints.map(p => Number(p.count || 0)));

    // Custom Canvas Overlay レイヤー定義（青緑 ➔ 黄 ➔ 橙 ➔ 日の丸朱赤 #e14d2a の放射状グラデーション）
    const CustomHeatCanvasLayer = L.Layer.extend({
      onAdd: function (map) {
        this._map = map;
        const pane = map.getPanes().overlayPane;
        this._canvas = L.DomUtil.create('canvas', 'leaflet-heatmap-canvas-layer');
        this._canvas.style.position = 'absolute';
        this._canvas.style.pointerEvents = 'none';
        this._canvas.style.top = '0';
        this._canvas.style.left = '0';
        this._canvas.style.zIndex = '250';
        pane.appendChild(this._canvas);

        map.on('moveend zoomend resize', this._redraw, this);
        this._redraw();
      },
      onRemove: function (map) {
        if (this._canvas && this._canvas.parentNode) {
          this._canvas.parentNode.removeChild(this._canvas);
        }
        map.off('moveend zoomend resize', this._redraw, this);
      },
      _redraw: function () {
        if (!this._map || !this._canvas) return;
        const size = this._map.getSize();
        const bounds = this._map.getBounds();
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);

        L.DomUtil.setPosition(this._canvas, topLeft);
        this._canvas.width = size.x;
        this._canvas.height = size.y;

        const ctx = this._canvas.getContext('2d');
        ctx.clearRect(0, 0, size.x, size.y);

        const zoom = this._map.getZoom();
        const baseRadius = Math.max(14, Math.min(48, (zoom - 3) * 5.5));

        gridPoints.forEach(pt => {
          if (!bounds.contains([pt.lat, pt.lon])) return;
          const cp = this._map.latLngToContainerPoint([pt.lat, pt.lon]);
          const intensity = Math.min(1, Math.log10(Number(pt.count || 1) + 1) / Math.log10(maxGridCount + 1));
          const r = baseRadius * (0.75 + intensity * 0.65);

          const grad = ctx.createRadialGradient(cp.x, cp.y, r * 0.08, cp.x, cp.y, r);
          if (intensity >= 0.72) {
            // 高密度: 日の丸朱赤 (#e14d2a) ➔ 橙 ➔ 黄 ➔ 青緑
            grad.addColorStop(0, 'rgba(225, 77, 42, 0.88)');
            grad.addColorStop(0.38, 'rgba(249, 115, 22, 0.65)');
            grad.addColorStop(0.7, 'rgba(250, 204, 21, 0.35)');
            grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
          } else if (intensity >= 0.4) {
            // 中密度: 橙 ➔ 黄 ➔ 青緑
            grad.addColorStop(0, 'rgba(249, 115, 22, 0.76)');
            grad.addColorStop(0.5, 'rgba(250, 204, 21, 0.45)');
            grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
          } else {
            // 低密度: 黄 ➔ 青緑
            grad.addColorStop(0, 'rgba(250, 204, 21, 0.62)');
            grad.addColorStop(0.55, 'rgba(16, 185, 129, 0.38)');
            grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
          }

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
          ctx.fill();
        });
      },
    });

    heatmapCanvasLayer = new CustomHeatCanvasLayer();
    heatmapCanvasLayer.addTo(heatmapLeaflet);

    // 上位300箇所のクリック可能なサークルマーカーを重ねる
    const markerPoints = gridPoints.slice(0, 300);
    const latLngs = [];

    markerPoints.forEach(pt => {
      latLngs.push([pt.lat, pt.lon]);
      const cnt = Number(pt.count || 0);
      const exc = Number(pt.excellent_count || 0);
      const areaLabel = [pt.state, pt.city].filter(Boolean).join(' ') || `${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)}`;

      const marker = L.circleMarker([pt.lat, pt.lon], {
        radius: Math.max(5, Math.min(14, 4 + Math.log2(cnt + 1) * 1.6)),
        color: '#ffffff',
        weight: 1.2,
        fillColor: exc > 0 ? '#e14d2a' : '#f59e0b',
        fillOpacity: 0.75,
      });

      const popupDiv = document.createElement('div');
      popupDiv.style.minWidth = '170px';
      popupDiv.innerHTML = `
        <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 4px; color: #1e293b;">${escHtml(areaLabel)}</div>
        <div style="font-size: 0.78rem; color: #475569; margin-bottom: 8px;">
          撮影枚数: <strong>${cnt.toLocaleString()}枚</strong> / 優: <strong>${exc}枚</strong>
        </div>
        ${
          pt.state
            ? `<button type="button" class="btn btn-primary btn-xs js-heatmap-filter-btn" style="width: 100%; justify-content: center;">
                 ${escHtml(areaLabel)}で絞り込む
               </button>`
            : ''
        }
      `;

      const filterBtn = popupDiv.querySelector('.js-heatmap-filter-btn');
      if (filterBtn) {
        filterBtn.addEventListener('click', () => {
          if (typeof window.selectLocationFilter === 'function') {
            window.selectLocationFilter({
              country: '日本',
              state: pt.state || null,
              city: pt.city || null,
              label: areaLabel,
            });
          }
          closeLocationMapModal();
        });
      }

      marker.bindPopup(popupDiv);
      heatmapMarkersGroup.addLayer(marker);
    });

    if (latLngs.length > 0) {
      try {
        heatmapLeaflet.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30], maxZoom: 12 });
      } catch (e) {
        console.warn('ヒートマップ表示範囲調整スキップ:', e);
      }
    }
  }

  /**
   * 撮影軌跡ポイント配列から「🔥 滞在ホットスポット（半径100m以内に短時間で3枚以上撮影）」を自動検出する
   * @param {Array} points 時系列昇順の軌跡ポイント
   * @returns {Array<{ lat: number, lon: number, count: number, label: string }>}
   */
  function detectTrajectoryHotspots(points) {
    const hotspots = [];
    if (!Array.isArray(points) || points.length < 3) return hotspots;

    let i = 0;
    while (i < points.length) {
      const base = points[i];
      const baseTime = parsePhotoTimestampMs(base.date_taken);
      const cluster = [base];

      for (let j = i + 1; j < points.length; j++) {
        const cand = points[j];
        const distKm = calcHaversineKm(base.lat, base.lon, cand.lat, cand.lon);
        const candTime = parsePhotoTimestampMs(cand.date_taken);
        const timeDiffMin =
          baseTime !== null && candTime !== null
            ? Math.abs(candTime - baseTime) / 60000
            : 0;

        // 半径100m (0.1km) 以内 かつ 45分以内
        if (distKm <= 0.1 && timeDiffMin <= 45) {
          cluster.push(cand);
        } else {
          break;
        }
      }

      if (cluster.length >= 3) {
        const avgLat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
        const avgLon = cluster.reduce((s, p) => s + p.lon, 0) / cluster.length;
        const locName = [base.state, base.city].filter(Boolean).join(' ') || '撮影スポット';
        hotspots.push({
          lat: avgLat,
          lon: avgLon,
          count: cluster.length,
          label: locName,
        });
        i += cluster.length;
      } else {
        i += 1;
      }
    }

    return hotspots;
  }

  /**
   * タブ3: 👣 撮影さんぽ軌跡ライン (#mapTabPaneTrajectory) を描画する
   * @param {Object} data
   */
  function renderTrajectoryTab(data) {
    const container = document.getElementById('trajectoryLeafletContainer');
    const selectEl = document.getElementById('trajectoryDateSelect');
    const statsBar = document.getElementById('trajectoryStatsBar');
    if (!container || !data) return;

    // 日付セレクタの選択肢構築
    const dates = Array.isArray(data.trajectory_dates) ? data.trajectory_dates : [];
    if (selectEl) {
      const prevVal = currentTrajectoryDate || selectEl.value || '';
      selectEl.innerHTML = '';

      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = '主要な撮影軌跡すべて (最新1,500枚)';
      selectEl.appendChild(allOpt);

      dates.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.date;
        opt.textContent = d.label || `${d.date} (${d.count}枚)`;
        selectEl.appendChild(opt);
      });

      selectEl.value = prevVal;
    }

    const points = Array.isArray(data.trajectory_points) ? data.trajectory_points : [];

    // 総移動距離（Haversine公式）・所要時間・歩数換算の算出
    // ※「すべて」表示時は日付をまたぐ長距離ワープを除外し、同一日内の移動距離を合算する
    let totalDistanceKm = 0;
    for (let i = 1; i < points.length; i++) {
      const p1 = points[i - 1];
      const p2 = points[i];
      const d1 = (p1.date_taken || '').substring(0, 10);
      const d2 = (p2.date_taken || '').substring(0, 10);
      if (!currentTrajectoryDate && d1 && d2 && d1 !== d2) {
        continue;
      }
      totalDistanceKm += calcHaversineKm(p1.lat, p1.lon, p2.lat, p2.lon);
    }

    let durationText = '-';
    if (points.length >= 2) {
      const tStart = parsePhotoTimestampMs(points[0].date_taken);
      const tEnd = parsePhotoTimestampMs(points[points.length - 1].date_taken);
      if (tStart !== null && tEnd !== null && tEnd >= tStart) {
        const diffMin = Math.round((tEnd - tStart) / 60000);
        if (diffMin < 60) {
          durationText = `${diffMin}分`;
        } else if (diffMin < 1440) {
          const hrs = Math.floor(diffMin / 60);
          const mins = diffMin % 60;
          durationText = `${hrs}時間${mins}分`;
        } else {
          const days = Math.floor(diffMin / 1440);
          durationText = `${days}日間`;
        }
      }
    }

    // 歩数換算目安（1km あたり約1,300歩として算出、ただし車・鉄道移動を含む長距離時は参考表示）
    const estimatedSteps = Math.round(totalDistanceKm * 1300);
    const hotspots = detectTrajectoryHotspots(points);

    if (statsBar) {
      statsBar.innerHTML = `
        <div class="lab-stat-box" style="padding: 5px 10px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642); font-size: 0.78rem;">
          総移動距離: <strong style="color: var(--accent-primary, #e14d2a);">${totalDistanceKm.toFixed(1)} km</strong>
        </div>
        <div class="lab-stat-box" style="padding: 5px 10px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642); font-size: 0.78rem;">
          所要時間: <strong>${escHtml(durationText)}</strong>
        </div>
        <div class="lab-stat-box" style="padding: 5px 10px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642); font-size: 0.78rem;">
          歩数換算目安: <strong>約 ${estimatedSteps.toLocaleString()} 歩</strong>
        </div>
        <div class="lab-stat-box" style="padding: 5px 10px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, #2f3642); font-size: 0.78rem;">
          滞在ホットスポット: <strong>${hotspots.length} 箇所</strong>
        </div>
      `;
    }

    if (typeof window.L === 'undefined') {
      container.innerHTML = `<div class="empty-hint" style="padding: 40px; text-align: center;">Leaflet 地図ライブラリが読み込まれていません</div>`;
      return;
    }

    const L = window.L;

    if (!trajectoryLeaflet) {
      trajectoryLeaflet = L.map(container, {
        center: [35.68, 139.76],
        zoom: 12,
        zoomControl: true,
        attributionControl: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(trajectoryLeaflet);

      trajectoryLayerGroup = L.layerGroup().addTo(trajectoryLeaflet);
    }

    setTimeout(() => {
      if (trajectoryLeaflet) {
        trajectoryLeaflet.invalidateSize();
      }
    }, 60);

    trajectoryLayerGroup.clearLayers();

    if (points.length === 0) return;

    const latLngs = points.map(p => [p.lat, p.lon]);

    // 1. ベースライン（白縁＋朱色ポリライン＋破線オーバーレイで進行方向を視認しやすく描画）
    L.polyline(latLngs, {
      color: '#ffffff',
      weight: 5,
      opacity: 0.55,
      lineJoin: 'round',
    }).addTo(trajectoryLayerGroup);

    L.polyline(latLngs, {
      color: '#e14d2a',
      weight: 3.2,
      opacity: 0.9,
      dashArray: '8, 6',
      lineJoin: 'round',
    }).addTo(trajectoryLayerGroup);

    // 2. 滞在ホットスポット（半径100mに3枚以上）のハイライト円
    hotspots.forEach(hs => {
      const hsCircle = L.circle([hs.lat, hs.lon], {
        radius: 90,
        color: '#e14d2a',
        weight: 1.5,
        fillColor: '#e14d2a',
        fillOpacity: 0.18,
      });
      hsCircle.bindTooltip(`滞在ホットスポット (${hs.count}枚撮影)`, { direction: 'top' });
      trajectoryLayerGroup.addLayer(hsCircle);
    });

    // 3. 各撮影ポイントのマーカー配置（START / GOAL / 番号 / 🏅優スター）
    // ポイント数が非常に多い場合は間引きつつ、START・GOAL・優(rating===2)は必ず全件表示
    const step = points.length > 180 ? Math.ceil(points.length / 180) : 1;

    points.forEach((pt, idx) => {
      const isStart = idx === 0;
      const isGoal = idx === points.length - 1 && points.length > 1;
      const isExcellent = Number(pt.rating) === 2;

      if (!isStart && !isGoal && !isExcellent && idx % step !== 0) {
        return;
      }

      let badgeHtml = '';
      if (isStart) {
        badgeHtml = `<div style="background: #10b981; color: #fff; font-weight: 700; font-size: 10px; padding: 2px 6px; border-radius: 10px; border: 2px solid #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.4); white-space: nowrap;">START</div>`;
      } else if (isGoal) {
        badgeHtml = `<div style="background: #0f172a; color: #fff; font-weight: 700; font-size: 10px; padding: 2px 6px; border-radius: 10px; border: 2px solid #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.4); white-space: nowrap;">GOAL (#${idx + 1})</div>`;
      } else if (isExcellent) {
        badgeHtml = `<div style="background: #e14d2a; color: #fff; font-weight: 700; font-size: 10px; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #facc15; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.45);" title="優 #${idx + 1}">★</div>`;
      } else {
        badgeHtml = `<div style="background: #334155; color: #f8fafc; font-weight: 600; font-size: 10px; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 10px; border: 1.5px solid #fff; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 4px rgba(0,0,0,0.35);">${idx + 1}</div>`;
      }

      const icon = L.divIcon({
        className: 'trajectory-custom-marker',
        html: badgeHtml,
        iconSize: [null, null],
        iconAnchor: [12, 12],
      });

      const marker = L.marker([pt.lat, pt.lon], { icon });

      const popupEl = document.createElement('div');
      popupEl.style.minWidth = '185px';
      const timeLabel = pt.date_taken || '';
      const ratingBadge =
        Number(pt.rating) === 2 ? '優' : Number(pt.rating) === 1 ? '良' : '可';

      popupEl.innerHTML = `
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px;">
          <img src="/api/photo/${encodeURIComponent(pt.id)}/thumbnail" alt="" style="width: 54px; height: 54px; object-fit: cover; border-radius: 4px; background: #0f172a;">
          <div style="min-width: 0; flex: 1;">
            <div style="font-weight: 700; font-size: 0.8rem; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(pt.file_name)}">
              #${idx + 1} ${escHtml(pt.file_name)}
            </div>
            <div style="font-size: 0.72rem; color: #475569;">${escHtml(timeLabel)}</div>
            <div style="font-size: 0.72rem; color: #e14d2a; font-weight: 600;">${ratingBadge}</div>
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-xs js-trajectory-open-photo-btn" style="width: 100%; justify-content: center;">
          この写真を表示
        </button>
      `;

      const openBtn = popupEl.querySelector('.js-trajectory-open-photo-btn');
      if (openBtn) {
        openBtn.addEventListener('click', () => {
          jumpToTrajectoryPhoto(pt);
        });
      }

      marker.bindPopup(popupEl);
      trajectoryLayerGroup.addLayer(marker);
    });

    if (latLngs.length > 0) {
      try {
        trajectoryLeaflet.fitBounds(L.latLngBounds(latLngs), { padding: [36, 36], maxZoom: 16 });
      } catch (e) {
        console.warn('軌跡マップ表示範囲調整スキップ:', e);
      }
    }
  }

  /**
   * 軌跡マーカー内の「この写真を表示」ボタンを押した際にモーダルを閉じて openLightbox またはグリッド選択へジャンプする
   * @param {Object} pt 軌跡ポイント ({ id, file_name, date_taken, ... })
   */
  function jumpToTrajectoryPhoto(pt) {
    if (!pt || !pt.id) return;
    closeLocationMapModal();

    if (typeof state !== 'undefined' && state && Array.isArray(state.photos)) {
      const existingIdx = state.photos.findIndex(p => Number(p.id) === Number(pt.id));
      if (existingIdx >= 0) {
        if (typeof openLightbox === 'function') {
          openLightbox(existingIdx);
          return;
        }
      }
    }

    // 現在のグリッドに存在しない場合は、ファイル名検索または選択状態で写真を特定して表示
    if (typeof state !== 'undefined' && state) {
      state.selectedPhotoIds = new Set([Number(pt.id)]);
      if (pt.file_name) {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = pt.file_name;
        state.searchQuery = pt.file_name;
      }
      if (typeof fetchPhotos === 'function') {
        Promise.resolve(fetchPhotos()).then(() => {
          if (Array.isArray(state.photos)) {
            const idx = state.photos.findIndex(p => Number(p.id) === Number(pt.id));
            if (idx >= 0 && typeof openLightbox === 'function') {
              openLightbox(idx);
            }
          }
        });
      }
    }
  }

  /**
   * モーダル内のタブを切り替える ('whitemap' | 'heatmap' | 'trajectory')
   * @param {string} tabName
   */
  function switchLocationMapTab(tabName) {
    activeMapTab = tabName || 'whitemap';
    const modal = document.getElementById('locationMapModal');
    if (!modal) return;

    modal.querySelectorAll('.map-tab-btn[data-map-tab]').forEach(btn => {
      const isMatch = btn.dataset.mapTab === activeMapTab;
      btn.classList.toggle('active', isMatch);
      btn.style.borderBottomColor = isMatch ? 'var(--accent-primary, #e14d2a)' : 'transparent';
      btn.style.color = isMatch ? 'var(--text-primary, #f1f5f9)' : 'var(--text-muted, #94a3b8)';
    });

    const panes = {
      whitemap: document.getElementById('mapTabPaneWhitemap'),
      heatmap: document.getElementById('mapTabPaneHeatmap'),
      trajectory: document.getElementById('mapTabPaneTrajectory'),
    };

    Object.keys(panes).forEach(k => {
      const el = panes[k];
      if (!el) return;
      const isMatch = k === activeMapTab;
      el.classList.toggle('active', isMatch);
      el.style.display = isMatch ? 'block' : 'none';
    });

    if (latestMapData) {
      if (activeMapTab === 'whitemap') {
        renderWhitemapTab(latestMapData);
      } else if (activeMapTab === 'heatmap') {
        renderHeatmapTab(latestMapData);
      } else if (activeMapTab === 'trajectory') {
        renderTrajectoryTab(latestMapData);
      }
    }
  }

  /**
   * GET /api/locations/heatmap を取得してモーダル内を更新する
   * @param {string} [dateFilter=''] YYYY-MM-DD
   */
  async function fetchAndRenderLocationMapData(dateFilter = '') {
    const query = dateFilter ? `?date_filter=${encodeURIComponent(dateFilter)}` : '';
    const response = await fetch(`/api/locations/heatmap${query}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    latestMapData = data;

    renderLocationSummaryBar(data);
    if (activeMapTab === 'whitemap') {
      renderWhitemapTab(data);
    } else if (activeMapTab === 'heatmap') {
      renderHeatmapTab(data);
    } else if (activeMapTab === 'trajectory') {
      renderTrajectoryTab(data);
    }
  }

  /**
   * #locationMapModal を開き、GET /api/locations/heatmap を取得して描画する
   * @param {string} [initialTab='whitemap'] 'whitemap' | 'heatmap' | 'trajectory'
   */
  async function openLocationMapModal(initialTab = 'whitemap') {
    const modal = ensureLocationMapModalDom();
    modal.style.display = 'flex';

    const targetTab =
      typeof initialTab === 'string' && ['whitemap', 'heatmap', 'trajectory'].includes(initialTab)
        ? initialTab
        : 'whitemap';
    switchLocationMapTab(targetTab);

    const svgContainer = document.getElementById('whitemapSvgContainer');
    if (svgContainer && !latestMapData) {
      svgContainer.innerHTML = `<div class="empty-hint" style="padding: 36px; text-align: center;">全国制覇マップ＆軌跡データを集計中...</div>`;
    }

    try {
      await fetchAndRenderLocationMapData(currentTrajectoryDate);
    } catch (err) {
      console.error('ジオタグ制覇マップデータ取得エラー:', err);
      if (svgContainer) {
        svgContainer.innerHTML = `<div class="empty-hint" style="padding: 24px; color: var(--danger, #ef4444);">地図データの取得に失敗しました (${escHtml(err.message)})</div>`;
      }
    }
  }
  window.openLocationMapModal = openLocationMapModal;

  /**
   * ジオタグ全国制覇マップモーダルのイベントリスナーを初期化する
   */
  function initLocationMapModal() {
    const modal = ensureLocationMapModalDom();

    // 起動ボタン（ラボ内ショートカットまたはヘッダー等）
    document.querySelectorAll('#openLocationMapModalBtn, #labOpenMapShortcutBtn, [data-action="open-location-map"]').forEach(btn => {
      if (btn.dataset.locMapBound) return;
      btn.dataset.locMapBound = 'true';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLocationMapModal('whitemap');
      });
    });

    if (modal && !modal.dataset.locMapModalBound) {
      modal.dataset.locMapModalBound = 'true';

      modal.addEventListener('click', (e) => {
        // 背景クリックまたは閉じるボタン
        if (
          e.target === modal ||
          e.target.closest('#closeLocationMapModalBtn') ||
          e.target.closest('.modal-close-btn')
        ) {
          closeLocationMapModal();
          return;
        }

        // タブ切替 (.map-tab-btn)
        const tabBtn = e.target.closest('.map-tab-btn[data-map-tab]');
        if (tabBtn) {
          switchLocationMapTab(tabBtn.dataset.mapTab);
          return;
        }

        // 白地図の塗り分けモード切替（📷 撮影枚数モード / 🏅 優枚数モード）
        const modeBtn = e.target.closest('[data-whitemap-mode]');
        if (modeBtn) {
          whitemapMode = modeBtn.dataset.whitemapMode === 'excellent' ? 'excellent' : 'count';
          if (latestMapData) {
            renderWhitemapTab(latestMapData);
          }
        }
      });

      // 撮影さんぽ軌跡の日付セレクタ変更イベント
      const dateSelect = modal.querySelector('#trajectoryDateSelect');
      if (dateSelect) {
        dateSelect.addEventListener('change', async () => {
          currentTrajectoryDate = dateSelect.value || '';
          try {
            await fetchAndRenderLocationMapData(currentTrajectoryDate);
          } catch (err) {
            console.error('撮影軌跡の日付変更取得エラー:', err);
          }
        });
      }

      // Escキーでモーダルを閉じる
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display !== 'none') {
          closeLocationMapModal();
        }
      });
    }
  }
  window.initLocationMapModal = initLocationMapModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initLocationMapModal());
  } else {
    initLocationMapModal();
  }
})();
