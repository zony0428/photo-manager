/**
 * Photo Manager Mobile - スマートフォン専用ビューア & 高速選別コントローラ
 *
 * 2つのデータ接続モードをシームレスに切り替えて動作する：
 * 1. 'server' モード : 同一Wi-Fi / Tailscale 経由でPCの FastAPI サーバーとリアルタイム直結
 * 2. 'localdb' モード: USBメモリや端末内の cache/library.db を sql.js (WebAssembly) で
 *                      メモリに一括ロードし、ファイルロックエラーなしで完全オフライン動作
 */

(function () {
  'use strict';

  // ==================== 定数 & 状態管理 ====================
  const GRID_CHUNK_SIZE = 72;
  const PENDING_STORAGE_KEY = 'pm_mobile_pending_changes_v1';
  const _NATIVE_SESSION_NONCE = Date.now().toString(36);
  const MOBILE_COLOR_TAGS = [
    '赤', '青', '緑', '黄色', '黒', '白',
    '銀・シルバー', '金・ゴールド', '茶色', '紫', 'オレンジ', 'ピンク',
  ];
  const MOBILE_COLOR_TAG_SET = new Set(MOBILE_COLOR_TAGS);
  const SQL_NOT_PAIRED_RAW =
    "NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL AND paired_raw_path != '')";
  const SQL_NOT_PAIRED_RAW_P =
    "NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')";

  const mState = {
    mode: 'checking', // 'checking' | 'server' | 'localdb' | 'offline'
    sqlJsInstance: null,
    localDb: null,
    localDbFileName: '',
    thumbUrlCache: new Map(), // photo_id -> ObjectURL (localdb用)

    // 写真データとグリッド段階描画
    photos: [],
    renderedCount: 0,

    // フィルタ条件 (-1:棄, 0:可, 1:良, 2:優)
    ratingFilter: 'default', // 'default'(0,1,2) | 'all'(-1,0,1,2) | -1 | 0 | 1 | 2
    stacked: true,
    gridCols: 3, // 2..6
    gridLayout: 'grid', // 'grid' | 'masonry' | 'mount'
    searchQuery: '',
    sortBy: 'date_taken DESC',
    includeTags: [],
    excludeTags: [],
    untaggedOnly: false,
    yearMonth: '',
    dateDay: '',
    cameraModel: '',
    lensModel: '',
    folderPath: '',
    country: '',
    stateName: '',
    city: '',
    noLocationOnly: false,

    // フィルタ候補一覧 & 階層ツリー開閉状態
    availableTags: [],
    tagSourceFilter: _safeGetStorage('pm_mobile_tag_source', 'manual'),
    untaggedCount: 0,
    timelineList: [],
    cameraList: [],
    gearList: [],
    folderList: [],
    locationTree: [],
    noLocationCount: 0,
    expandedFilterNodes: new Set(),
    monthDayCountsCache: new Map(),

    // 複数選択モード & Art Framer 1枚タップ待機モード & タブレットインスペクタ選択状態
    selectMode: false,
    artFramerPickMode: false,
    selectedIds: new Set(),
    inspectedIndex: -1,
    inspectedPhotoId: null,
    lastCardTapId: null,
    lastCardTapTime: 0,

    // フルスクリーンビューア状態
    viewerOpen: false,
    viewerIndex: -1, // mState.photos 内のインデックス
    viewerStackMember: null, // スタック内の特定コマを表示中の場合の写真オブジェクト
    autoAdvance: true,
    zoomScale: 1,
    panX: 0,
    panY: 0,

    // オフライン変更差分 & DBから取得したPCサーバー接続候補
    pendingChanges: loadPendingChangesFromStorage(),
    pendingBakedAdjustMap: { byId: {}, byKey: {} },
    lastServerUrl: '',
    serverCandidates: [],
    tagTreeExpandedPaths: new Set(),
    hasPhotoLinksTable: false,
    hasPhotoLinksDirCol: false,
    nativeLinkState: { isPcLinked: false, usbConnected: false, usbVsn: '' },
    pcConnectionSnapshot: null,
  };

  // ==================== ユーティリティ関数 ====================

  /**
   * HTMLエスケープ（XSS防止）
   */
  function _escHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * HTML属性用エスケープ
   */
  function _escAttr(val) {
    return _escHtml(val);
  }

  /**
   * ローカルタイム方式での日時文字列生成（UTCズレ防止・規約準拠）
   */
  function _formatLocalTimestamp(dateObj) {
    const d = dateObj || new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  /**
   * トースト通知を表示する
   */
  let _toastTimer = null;
  function showToast(msg, durationMs = 2000) {
    const el = document.getElementById('mToast');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      el.style.display = 'none';
    }, durationMs);
  }
  window.__showTetheractToast = showToast;

  /**
   * モバイル・タッチUI用の確認モーダル（window.confirm 禁止規約対応）
   */
  function confirmTouchAction(options = {}) {
    const title = options.title || '確認';
    const message = options.message || 'この操作を実行しますか？';
    const confirmText = options.confirmText || '実行する';
    const cancelText = options.cancelText || 'キャンセル';
    const isDanger = Boolean(options.danger);

    return new Promise((resolve) => {
      const old = document.getElementById('mTouchConfirmModalOverlay');
      if (old) old.remove();

      const overlay = document.createElement('div');
      overlay.id = 'mTouchConfirmModalOverlay';
      overlay.style.cssText = 'position:fixed; inset:0; z-index:12000; background:rgba(0,0,0,0.62); display:flex; align-items:center; justify-content:center; padding:18px; backdrop-filter:blur(4px);';
      overlay.innerHTML = `
        <div style="width:100%; max-width:340px; background:var(--bg-secondary, #1e1e1e); color:var(--text-primary, #f5f5f5); border:1px solid var(--border-color, rgba(255,255,255,0.14)); border-radius:14px; padding:18px 16px 14px; box-shadow:0 16px 40px rgba(0,0,0,0.5);">
          <div style="font-size:15px; font-weight:700; margin-bottom:8px;">${_escHtml(title)}</div>
          <div style="font-size:13px; color:var(--text-secondary, #cbd5e1); line-height:1.55; white-space:pre-line; margin-bottom:16px;">${_escHtml(message)}</div>
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button type="button" data-confirm-act="cancel" style="flex:1; height:38px; border-radius:8px; border:1px solid var(--border-color, rgba(255,255,255,0.16)); background:transparent; color:var(--text-primary, #f5f5f5); font-size:13px; font-weight:600; cursor:pointer;">${_escHtml(cancelText)}</button>
            <button type="button" data-confirm-act="ok" style="flex:1; height:38px; border-radius:8px; border:none; background:${isDanger ? '#ef4444' : 'var(--accent-primary, #e14d2a)'}; color:#fff; font-size:13px; font-weight:700; cursor:pointer;">${_escHtml(confirmText)}</button>
          </div>
        </div>
      `;

      const finish = (val) => {
        overlay.remove();
        resolve(val);
      };
      overlay.querySelector('[data-confirm-act="cancel"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        finish(false);
      });
      overlay.querySelector('[data-confirm-act="ok"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        finish(true);
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish(false);
      });
      document.body.appendChild(overlay);
    });
  }
  window.__confirmTouchAction = confirmTouchAction;

  /**
   * 階層タグ（例: "A/B/C"）から親階層を含む全タグリストを展開する
   */
  function expandTagAncestors(tagStr) {
    const parts = String(tagStr || '')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    const result = [];
    for (let i = 0; i < parts.length; i++) {
      result.push(parts.slice(0, i + 1).join('/'));
    }
    return result;
  }

  /**
   * Android content:// や file:// などの不透明オリジン環境でも SecurityError を起こさない安全なストレージ操作
   */
  function _safeGetStorage(key, fallback = null) {
    try {
      const val = window.localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function _safeSetStorage(key, val) {
    try {
      window.localStorage.setItem(key, String(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 単体HTMLファイル (file://, content://, Androidファイル管理アプリの 127.0.0.1:xxxxx 一時サーバー等) として開かれているか判定
   */
  function _isLocalFileOrigin() {
    const p = window.location.protocol;
    const h = window.location.hostname;
    const port = window.location.port;
    const isAndroidLocalFileServer =
      (h === '127.0.0.1' || h === 'localhost') &&
      port !== '8088';
    return Boolean(
      window.__PM_STANDALONE_HTML__ ||
        window.TetheractNative ||
        h === 'appassets.tetheract.local' ||
        (p !== 'http:' && p !== 'https:') ||
        isAndroidLocalFileServer ||
        mState.mode === 'localdb'
    );
  }

  // ==================== オフライン変更差分の永続化管理 ====================

  function loadPendingChangesFromStorage() {
    try {
      const raw = _safeGetStorage(PENDING_STORAGE_KEY, null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.items) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('変更履歴の読み込み失敗:', e);
    }
    return {
      updated_at: _formatLocalTimestamp(new Date()),
      db_name: '',
      items: {},
    };
  }

  function savePendingChangesToStorage() {
    try {
      mState.pendingChanges.updated_at = _formatLocalTimestamp(new Date());
      _safeSetStorage(PENDING_STORAGE_KEY, JSON.stringify(mState.pendingChanges));
    } catch (e) {
      console.warn('変更履歴の保存失敗:', e);
    }
    updatePendingBadgeUI();
  }

  function _findTagKey(tagName) {
    const found = (mState.availableTags || []).find((t) => t && t.tag === tagName);
    return (found && found.tag_key) ? String(found.tag_key) : '';
  }

  function _hasNativeJournal() {
    return Boolean(window.TetheractNative && typeof window.TetheractNative.savePhotoChangeJson === 'function');
  }

  /**
   * サムネイルも含め未焼き込みのスマホ原本写真かどうかを判定する（touch_adjust.js へ委譲可能）
   */
  function _isPhoneUnbakedPhoto(photo) {
    if (!photo) return false;
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.isPhoneUnbakedPhoto === 'function') {
      return window.TetheractTouchUI.isPhoneUnbakedPhoto(photo);
    }
    return Boolean(
      photo.is_phone_case ||
      Number(photo.id) >= 900000000 ||
      photo.volume_serial === 'ANDROID_LOCAL' ||
      String(photo.file_path || '').startsWith('phone://')
    );
  }

  /**
   * 非破壊調整の焼き込み基準値スナップショットを正規化する
   */
  function _normalizeAdjustSnapshot(src) {
    const obj = src || {};
    const snap = {
      brightness: Number(obj.brightness || 0),
      contrast: Number(obj.contrast || 0),
      saturation: Number(obj.saturation || 0),
      fine_angle: Number(obj.fine_angle || 0),
      rotation: Number(obj.rotation || 0),
    };
    if (obj.crop_x !== undefined) snap.crop_x = obj.crop_x;
    if (obj.crop_y !== undefined) snap.crop_y = obj.crop_y;
    if (obj.crop_w !== undefined) snap.crop_w = obj.crop_w;
    if (obj.crop_h !== undefined) snap.crop_h = obj.crop_h;
    return snap;
  }

  /**
   * 未同期ジャーナルが保持している「編集前の焼き込み基準値マップ」を再同期する
   */
  function _refreshPendingBakedAdjustMap() {
    if (_hasNativeJournal()) {
      if (typeof window.TetheractNative.getPendingBakedAdjustmentsMapJson === 'function') {
        try {
          const parsed = JSON.parse(window.TetheractNative.getPendingBakedAdjustmentsMapJson() || '{}');
          mState.pendingBakedAdjustMap = {
            byId: (parsed && typeof parsed.byId === 'object' && parsed.byId) || {},
            byKey: (parsed && typeof parsed.byKey === 'object' && parsed.byKey) || {},
          };
          return;
        } catch (e) {
          console.warn('未同期調整基準マップ読取警告:', e);
        }
      }
      if (getPendingChangesCount() === 0) {
        mState.pendingBakedAdjustMap = { byId: {}, byKey: {} };
      }
      return;
    }

    const byId = {};
    const byKey = {};
    const items = (mState.pendingChanges && mState.pendingChanges.items) || {};
    for (const item of Object.values(items)) {
      if (!item || typeof item !== 'object') continue;
      const hasAdj =
        item.brightness !== undefined ||
        item.contrast !== undefined ||
        item.saturation !== undefined ||
        item.fine_angle !== undefined ||
        item.rotation !== undefined;
      if (!hasAdj) continue;
      const base = _normalizeAdjustSnapshot(
        item.base_adjustments || { brightness: 0, contrast: 0, saturation: 0, fine_angle: 0, rotation: 0 }
      );
      if (item.photo_id) byId[String(item.photo_id)] = base;
      if (item.content_key) byKey[String(item.content_key)] = base;
    }
    mState.pendingBakedAdjustMap = { byId, byKey };
  }

  /**
   * 初回のモバイル調整編集前に現在の焼き込み済み基準値をメモリへ退避する（再描画・保存後リフレッシュ耐性）
   */
  function _rememberBakedAdjustForPhoto(photo) {
    if (!photo || !photo.id) return;
    if (!mState.pendingBakedAdjustMap || typeof mState.pendingBakedAdjustMap !== 'object') {
      mState.pendingBakedAdjustMap = { byId: {}, byKey: {} };
    }
    const { byId, byKey } = mState.pendingBakedAdjustMap;
    const pidKey = String(photo.id);
    const cKey = String(photo.content_key || '').trim();
    const existing = byId[pidKey] || (cKey ? byKey[cKey] : null);
    if (existing) return;
    const snap = _normalizeAdjustSnapshot(photo._bakedAdjust || photo);
    byId[pidKey] = snap;
    if (cKey) byKey[cKey] = snap;
  }

  /**
   * 写真オブジェクトに対する現在のサムネイル/PC側の焼き込み済み基準値を解決する
   */
  function _resolveBakedAdjustForPhoto(photo, fallbackSource = null) {
    if (!photo) return _normalizeAdjustSnapshot(fallbackSource);
    const map = mState.pendingBakedAdjustMap || { byId: {}, byKey: {} };
    const pidKey = photo.id != null ? String(photo.id) : '';
    const cKey = String(photo.content_key || '').trim();
    const fromJournal = (pidKey && map.byId[pidKey]) || (cKey && map.byKey[cKey]) || null;
    if (fromJournal) return _normalizeAdjustSnapshot(fromJournal);
    if (photo._bakedAdjust) return _normalizeAdjustSnapshot(photo._bakedAdjust);
    return _normalizeAdjustSnapshot(fallbackSource || photo);
  }

  /**
   * Android ネイティブ版では変更1件分の差分だけをネイティブジャーナルへ渡す（ロッカーDBへの反映もネイティブ側が行う）
   */
  function _recordNativePendingChange(photo, changeType, value) {
    const payload = {
      photo_id: photo.id,
      content_key: photo.content_key || '',
      file_path: photo.file_path || '',
      file_name: photo.file_name || '',
      file_size: photo.file_size || 0,
      date_taken: photo.date_taken || '',
    };
    if (changeType === 'rating') {
      payload.rating = Number(value);
    } else if (changeType === 'stack_primary') {
      payload.set_stack_primary = Boolean(value);
    } else if (changeType === 'adjustments' && value && typeof value === 'object') {
      if (value.rotation !== undefined) payload.rotation = Math.round(Number(value.rotation || 0));
      if (value.brightness !== undefined) payload.brightness = Math.round(Number(value.brightness || 0));
      if (value.contrast !== undefined) payload.contrast = Math.round(Number(value.contrast || 0));
      if (value.saturation !== undefined) payload.saturation = Math.round(Number(value.saturation || 0));
      if (value.fine_angle !== undefined) payload.fine_angle = Number(Number(value.fine_angle || 0).toFixed(2));
    } else if (changeType === 'add_tag' || changeType === 'remove_tag') {
      const tag = String(value).trim();
      if (!tag) return;
      const tKey = _findTagKey(tag);
      const isAdd = changeType === 'add_tag';
      payload[isAdd ? 'add_tags' : 'remove_tags'] = [tag];
      if (tKey) payload[isAdd ? 'add_tag_keys' : 'remove_tag_keys'] = { [tKey]: tag };
    } else {
      return;
    }
    try {
      const res = JSON.parse(window.TetheractNative.savePhotoChangeJson(JSON.stringify(payload)) || '{}');
      if (!res.ok) {
        console.warn('Android Native ジャーナル保存失敗:', res.error);
        showToast('! 変更の保存に失敗しました');
      }
    } catch (e) {
      console.warn('Android Native ジャーナル保存警告:', e);
    }
  }

  /**
   * 旧版で localStorage に二重記録していた未同期変更を破棄する（ネイティブジャーナルが常に正本のため）
   */
  function _discardLegacyJsJournalOnNative() {
    const cnt = Object.keys((mState.pendingChanges && mState.pendingChanges.items) || {}).length;
    if (cnt === 0) return;
    console.info(`Android Native: localStorage 側の旧ジャーナル ${cnt}件を破棄しました（ネイティブジャーナルを正本として使用）`);
    mState.pendingChanges.items = {};
    savePendingChangesToStorage();
  }

  function recordPendingChange(photo, changeType, value, options = {}) {
    if (!photo || !photo.id) return;
    if (_hasNativeJournal()) {
      _recordNativePendingChange(photo, changeType, value);
      if (!options.deferSave) updatePendingBadgeUI();
      return;
    }
    const key = String(photo.id);
    if (!mState.pendingChanges.items[key]) {
      mState.pendingChanges.items[key] = {
        photo_id: photo.id,
        content_key: photo.content_key || '',
        file_path: photo.file_path || '',
        file_name: photo.file_name || '',
        file_size: photo.file_size || 0,
        date_taken: photo.date_taken || '',
        rating: undefined,
        add_tags: [],
        remove_tags: [],
        add_tag_keys: {},
        remove_tag_keys: {},
      };
    }
    const item = mState.pendingChanges.items[key];
    if (!item.add_tag_keys || typeof item.add_tag_keys !== 'object') item.add_tag_keys = {};
    if (!item.remove_tag_keys || typeof item.remove_tag_keys !== 'object') item.remove_tag_keys = {};

    if (changeType === 'rating') {
      item.rating = Number(value);
    } else if (changeType === 'stack_primary') {
      item.set_stack_primary = Boolean(value);
    } else if (changeType === 'adjustments' && value && typeof value === 'object') {
      if (!item.base_adjustments) {
        item.base_adjustments = _normalizeAdjustSnapshot(photo._bakedAdjust || photo);
      }
      if (value.rotation !== undefined) item.rotation = Math.round(Number(value.rotation || 0));
      if (value.brightness !== undefined) item.brightness = Math.round(Number(value.brightness || 0));
      if (value.contrast !== undefined) item.contrast = Math.round(Number(value.contrast || 0));
      if (value.saturation !== undefined) item.saturation = Math.round(Number(value.saturation || 0));
      if (value.fine_angle !== undefined) item.fine_angle = Number(Number(value.fine_angle || 0).toFixed(2));
      _rememberBakedAdjustForPhoto(photo);
    } else if (changeType === 'add_tag') {
      const tag = String(value).trim();
      const tKey = _findTagKey(tag);
      item.remove_tags = (item.remove_tags || []).filter((t) => t !== tag);
      if (tKey) delete item.remove_tag_keys[tKey];
      if (!item.add_tags.includes(tag)) {
        item.add_tags.push(tag);
      }
      if (tKey) {
        item.add_tag_keys[tKey] = tag;
      }
    } else if (changeType === 'remove_tag') {
      const tag = String(value).trim();
      const tKey = _findTagKey(tag);
      item.add_tags = (item.add_tags || []).filter((t) => t !== tag);
      if (tKey) delete item.add_tag_keys[tKey];
      if (!item.remove_tags.includes(tag)) {
        item.remove_tags.push(tag);
      }
      if (tKey) {
        item.remove_tag_keys[tKey] = tag;
      }
    }
    if (!options.deferSave) savePendingChangesToStorage();
  }

  /**
   * 複数写真の評価・タグ変更を Android Native 一括JNI (savePhotoChangesBatch) または localStorage 1回保存で記録する
   */
  async function _saveNativeBatchChanges(ids, changePatch) {
    const targetPhotos = ids.map((pid) => mState.photos.find((p) => p.id === pid) || { id: pid });
    if (window.TetheractAdapter && typeof window.TetheractAdapter.savePhotoChangesBatch === 'function') {
      const res = await window.TetheractAdapter.savePhotoChangesBatch(targetPhotos, changePatch);
      updatePendingBadgeUI();
      return Boolean(res && res.ok);
    }
    if (window.TetheractNative && typeof window.TetheractNative.savePhotoChangesBatchJson === 'function') {
      const payload = {
        items: targetPhotos.map((p) => ({
          photo_id: p.id,
          content_key: p.content_key || '',
          file_path: p.file_path || '',
          file_name: p.file_name || '',
          file_size: p.file_size || 0,
          date_taken: p.date_taken || '',
        })),
        ...changePatch,
      };
      const res = JSON.parse(window.TetheractNative.savePhotoChangesBatchJson(JSON.stringify(payload)) || '{}');
      updatePendingBadgeUI();
      return Boolean(res && res.ok);
    }
    return false;
  }

  function getPendingChangesCount() {
    if (_hasNativeJournal()) {
      try {
        if (typeof window.TetheractNative.getPendingChangeCount === 'function') {
          return Number(window.TetheractNative.getPendingChangeCount() || 0);
        }
        if (typeof window.TetheractNative.getLockerStatusJson === 'function') {
          const st = JSON.parse(window.TetheractNative.getLockerStatusJson() || '{}');
          return Number(st.pendingChangeCount || 0);
        }
      } catch (e) {
        console.warn('Android Native 未同期件数の取得失敗:', e);
      }
      return 0;
    }
    return Object.keys((mState.pendingChanges && mState.pendingChanges.items) || {}).length;
  }

  function updatePendingBadgeUI() {
    const cnt = getPendingChangesCount();
    const badge = document.getElementById('mPendingBadge');
    if (badge) {
      if (cnt > 0) {
        badge.textContent = String(cnt);
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }
    const bnavBadge = document.getElementById('tBnavPendingBadge');
    if (bnavBadge) {
      if (cnt > 0) {
        bnavBadge.textContent = String(cnt);
        bnavBadge.style.display = 'inline-flex';
      } else {
        bnavBadge.style.display = 'none';
      }
    }
    const box = document.getElementById('mPendingSummaryBox');
    if (box) {
      box.innerHTML = `未反映の変更: <strong>${cnt}件の写真</strong>`;
    }
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.updateLockerStatus === 'function') {
      window.TetheractTouchUI.updateLockerStatus({ pendingCount: cnt });
    }
  }

  // ==================== 初期化 & モード判定 ====================

  async function initMobileApp() {
    if (window.TetheractNative) {
      document.documentElement.classList.add('is-native-app');
    }
    initTheme();
    initSavedPrefs();
    bindAllEvents();
    updatePendingBadgeUI();

    // 単体HTMLとしてファイルアプリから開かれた場合は単体HTML自身のダウンロードカードを非表示にする
    if (_isLocalFileOrigin()) {
      const dlCard = document.getElementById('mStandaloneDownloadCard');
      if (dlCard) dlCard.style.display = 'none';
    }

    // セキュアコンテキスト (HTTPS または localhost) かつ通常配信時のみ Service Worker を登録
    const isSecure =
      window.isSecureContext &&
      (window.location.protocol === 'https:' ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1');
    if ('serviceWorker' in navigator && isSecure && !window.__PM_STANDALONE_HTML__) {
      navigator.serviceWorker.register('/sw_mobile.js').catch((err) => {
        console.warn('Service Worker登録スキップ:', err);
      });
    }

    if (!document._pmConnVisibilityBound) {
      document._pmConnVisibilityBound = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && mState.mode === 'server') {
          _refreshServerConnectionStatus();
        }
      });
    }

    // PC上でのプレビュー表示 (/m) の場合のみ同一オリジンサーバー接続を試行
    if (window.TetheractNative) {
      await _initAndroidNativeLockerMode();
      return;
    }
    const connected = await tryConnectServer();
    if (!connected) {
      setAppMode('offline');
    }
  }

  function _createAndroidNativeSqlProxy() {
    return {
      isAndroidNative: true,
      // 書き込みは recordPendingChange 経由の savePhotoChangeJson に一本化しているため、ここでは何もしない
      run() {},
      exec(sql) {
        if (window.TetheractNative && typeof window.TetheractNative.rawQueryJson === 'function') {
          const rows = JSON.parse(window.TetheractNative.rawQueryJson(sql, '[]') || '[]');
          return rows.length > 0 ? [{ values: rows }] : [];
        }
        return [];
      },
      close() {},
    };
  }

  function _refreshLocalDbSchemaFlags() {
    if (!mState.localDb) {
      mState.hasPhotoLinksTable = false;
      mState.hasPhotoLinksDirCol = false;
      return;
    }
    try {
      const plCols = queryLocalDbObjects('PRAGMA table_info(photo_links)');
      mState.hasPhotoLinksTable = plCols.length > 0;
      mState.hasPhotoLinksDirCol = plCols.some((c) => c && c.name === 'directory_path');
    } catch (e) {
      mState.hasPhotoLinksTable = false;
      mState.hasPhotoLinksDirCol = false;
    }
  }

  async function _syncLinkedPhoneFoldersToLockerDb(targetFolderId = 'all') {
    if (!window.TetheractNative || typeof window.TetheractNative.phoneCaseListFoldersJson !== 'function') {
      return false;
    }
    try {
      const fRes = JSON.parse(window.TetheractNative.phoneCaseListFoldersJson() || '{}');
      if (!Array.isArray(fRes.folders) || fRes.folders.length === 0) return false;
      if (window.TetheractPhoneCaseAdapter && typeof window.TetheractPhoneCaseAdapter.scanPhotos === 'function') {
        const scanRes = await window.TetheractPhoneCaseAdapter.scanPhotos(String(targetFolderId || 'all'), { includeItems: false });
        return Boolean(scanRes && (scanRes.catalogChanged || scanRes.ok));
      }
      if (typeof window.TetheractNative.phoneCaseScanPhotosJson === 'function') {
        const scanRes = JSON.parse(window.TetheractNative.phoneCaseScanPhotosJson(String(targetFolderId || 'all')) || '{}');
        return Boolean(scanRes && scanRes.ok);
      }
    } catch (e) {
      console.warn('スマホ管理下フォルダの自動スキャン警告:', e);
    }
    return false;
  }

  async function _activateAndroidNativeLockerDb() {
    try {
      const st = JSON.parse(window.TetheractNative.getLockerStatusJson() || '{}');
      mState.nativeLinkState = {
        isPcLinked: Boolean(st.pcOnline),
        usbConnected: Boolean(st.usbConnected),
        usbVsn: String(st.usbVsn || '').toUpperCase(),
      };
      _syncPcConnectionSnapshotFromNative();
      if (window.TetheractTouchUI && typeof window.TetheractTouchUI.updateLockerStatus === 'function') {
        window.TetheractTouchUI.updateLockerStatus({
          usbConnected: Boolean(st.usbConnected),
          cachedCount: Number(st.dbPhotoCount || 0),
          pendingCount: Number(st.pendingChangeCount || 0),
        });
      }
      if (!st.hasLockerDb) {
        setAppMode('offline');
        return false;
      }
      mState.localDb = _createAndroidNativeSqlProxy();
      _refreshLocalDbSchemaFlags();
      mState.stackCountsMap = null;
      mState.monthDayCountsCache = new Map();
      mState.localDbFileName = st.usbFolderName ? `${st.usbFolderName} (Locker)` : 'library.db (Locker)';
      setAppMode('localdb');
      await refreshAllData();
      _refreshWifiStatusBox(st);
      const statusBox = document.getElementById('mLoadedDbStatus');
      if (statusBox) {
        statusBox.innerHTML = `✓ <strong>専用ロッカーDB</strong> (${Number(st.dbPhotoCount || 0).toLocaleString()}枚) を高速オープン完了`;
      }
      return true;
    } catch (e) {
      console.error('Android Locker 起動エラー:', e);
      setAppMode('offline');
      return false;
    }
  }

  function _refreshWifiStatusBox(stObj) {
    let st = stObj;
    if (!st && window.TetheractNative && typeof window.TetheractNative.getLockerStatusJson === 'function') {
      try {
        st = JSON.parse(window.TetheractNative.getLockerStatusJson() || '{}');
      } catch (e) {
        st = {};
      }
    }
    if (st && st.appVersion) {
      const verText = st.appVersion.startsWith('v') ? st.appVersion : `v${st.appVersion}`;
      const badgeEl = document.getElementById('mAppBuildBadge');
      if (badgeEl) badgeEl.textContent = verText;
      const modalVerEl = document.getElementById('mModalAppBuildInfo');
      if (modalVerEl) modalVerEl.textContent = `TETHERACT pm · ${verText}`;
    }
    const wifiBox = document.getElementById('mWifiPairStatusBox');
    const wifiInput = document.getElementById('mWifiUrlInput');
    if (wifiBox && st) {
      if (st.wifiConfigured && st.wifiServerUrl) {
        const lastSync = st.lastWifiSyncAt ? ` (最終同期: ${_escHtml(st.lastWifiSyncAt)})` : '';
        wifiBox.innerHTML = `✓ 接続先PC: <strong>${_escHtml(st.wifiServerUrl)}</strong>${lastSync}`;
        if (wifiInput && !wifiInput.value) {
          wifiInput.value = st.wifiServerUrl;
        }
      } else {
        wifiBox.innerHTML = '「今すぐWi-Fi同期」を押すと同一Wi-Fi内のPC母艦を自動検出して接続します（PC側で「許可する」を押すかQRコード読み取りでも接続できます）。';
      }
    }
    const nativeBox = document.getElementById('mNativeApkUpdateBox');
    if (nativeBox) {
      nativeBox.style.display = Boolean(st && st.nativeApkUpdateRequired) ? 'block' : 'none';
    }
  }

  async function _triggerAndroidWifiLockerSync(rawUrlInput = '') {
    if (!window.TetheractNative || typeof window.TetheractNative.triggerWifiSyncAsyncJson !== 'function') {
      showToast('Wi-Fiロッカー同期はAndroid専用アプリで利用できます');
      return;
    }
    if (rawUrlInput && typeof window.TetheractNative.saveWifiPairingJson === 'function') {
      const saveRes = JSON.parse(window.TetheractNative.saveWifiPairingJson(rawUrlInput) || '{}');
      if (!saveRes.ok) {
        showToast(saveRes.error || '接続URLの形式が正しくありません', 4000);
        return;
      }
      _refreshWifiStatusBox();
    }
    const st = JSON.parse(window.TetheractNative.getLockerStatusJson() || '{}');
    const dbOverlay = document.getElementById('mDbSyncOverlay');
    if (dbOverlay) dbOverlay.style.display = 'none';
    const hasLocker = Boolean(st.hasLockerDb);
    const configured = Boolean(st.wifiConfigured);
    setLoading(
      true,
      configured ? 'PC母艦とWi-Fiで双方向ロッカー同期中...' : '同一Wi-Fi内のPC母艦を自動検出中...',
      configured
        ? (hasLocker
          ? '選別データの送信と最新差分の取得を行っています（約1〜2秒）'
          : '初回ロッカーDBをWi-Fi経由で転送しています（しばらくお待ちください）')
        : 'PC画面に確認ダイアログが表示されたら「許可する」をクリックしてください'
    );
    window.TetheractNative.triggerWifiSyncAsyncJson(false);
  }

  let _nativeUsbSyncEventBound = false;

  function _formatWifiSyncDoneToast(res, quickSum, hasDbChanges) {
    const pushed = Number((res && res.pushedCount) || 0);
    const logDays = Number((res && res.uploadedFieldLogDays) || 0);
    const importedPhotos = Number((quickSum && quickSum.importedCount) || 0);
    const skippedPhotos = Number((quickSum && quickSum.skippedCount) || 0);
    const signalCount = Number((quickSum && quickSum.signalCount) || 0);
    const partialRem = Number((quickSum && quickSum.partialRemaining) || 0);
    const parts = [];
    if (importedPhotos > 0) parts.push(`写真${importedPhotos}枚収納`);
    if (skippedPhotos > 0) parts.push(`重複スキップ${skippedPhotos}枚`);
    if (signalCount > 0) parts.push(`信号${signalCount}件`);
    if (pushed > 0) parts.push(`選別${pushed}件`);
    if (logDays > 0) parts.push(`GPSログ${logDays}日分`);

    if (partialRem > 0) {
      return `✓ 母艦と同期完了（${parts.join('・') || '差分同期'} / 未転送残り${partialRem}枚）`;
    }
    if (parts.length > 0) {
      return (importedPhotos > 0 || signalCount > 0 || skippedPhotos > 0)
        ? `✓ 母艦に収納完了（${parts.join('・')}）`
        : `✓ 母艦と同期完了（${parts.join('・')}）`;
    }
    return hasDbChanges
      ? '✓ PCからWi-Fiで最新ロッカーへ高速同期しました'
      : '✓ Wi-Fi同期完了（変更なし・最新状態です）';
  }

  function _formatUsbDownlinkToast(res) {
    const syncMode = String((res && res.syncMode) || '');
    const added = Number((res && res.addedCount) || 0);
    const removed = Number((res && res.removedCount) || 0);
    const total = Number((res && res.dbPhotoCount) || 0);
    const pending = Number((res && res.pendingChangeCount) || 0);
    const unlockPrefix = res && res.unlocked ? '鍵付きLoome解錠＋' : '';
    const pendingWarn = pending > 0 ? ` / 未送信${pending}件の母艦反映はWi-Fi同期をご利用ください` : '';

    if (syncMode === 'usb_downlink_full') {
      return `✓ ${unlockPrefix}母艦USBからカタログを取込完了（全${total}枚・ダウンリンク専用）${pendingWarn}`;
    }
    if (syncMode === 'usb_downlink_delta' || syncMode === 'usb_downlink_diff') {
      if (added > 0) {
        return `✓ ${unlockPrefix}母艦USBから差分自動取込（+${added}枚・ダウンリンク専用）${pendingWarn}`;
      }
      if (removed > 0) {
        return `✓ ${unlockPrefix}母艦USBから差分自動取込（-${removed}枚整理・ダウンリンク専用）${pendingWarn}`;
      }
      return `✓ ${unlockPrefix}母艦USBから最新カタログを自動反映しました（ダウンリンク専用）${pendingWarn}`;
    }
    if (pending > 0) {
      return `● ${unlockPrefix}Loome USB直結（ダウンリンク専用・最新）${pendingWarn}`;
    }
    return `● ${unlockPrefix}Loome USB直結：原本表示可（母艦→モバイル専用・最新）`;
  }

  async function _handleNativeUsbSyncCompleted(res) {
    if (res && (res.syncMode === 'loome_detached' || res.usbDetached)) {
      setLoading(false);
      if (mState.nativeLinkState) mState.nativeLinkState.usbConnected = false;
      return;
    }
    setLoading(false);
    const syncMode = String((res && res.syncMode) || '');
    const isWifiMode = syncMode.startsWith('wifi_');
    const isUsbDownlink = syncMode.startsWith('usb_downlink_');
    const quickSum = isWifiMode ? (window.__pendingQuickUplinkSummary || null) : null;
    if (isWifiMode) window.__pendingQuickUplinkSummary = null;

    if (res && res.ok) {
      updatePendingBadgeUI();
      if (getPendingChangesCount() === 0) {
        mState.pendingBakedAdjustMap = { byId: {}, byKey: {} };
      }
      _refreshPendingBakedAdjustMap();
      const skipped = Number(res.skippedCount || 0);
      if (skipped > 0) {
        setTimeout(() => {
          showToast(`! ${skipped}件の変更はPC側で該当写真が見つからず反映できませんでした`, 5000);
        }, 4200);
      }
      if (isUsbDownlink || syncMode === 'loome_mount') {
        if (mState.nativeLinkState) mState.nativeLinkState.usbConnected = true;
      }
      if (syncMode === 'wifi_noop' && mState.localDb && mState.photos.length > 0) {
        _refreshWifiStatusBox();
        showToast(_formatWifiSyncDoneToast(res, quickSum, false), 3600);
        return;
      }
      if (syncMode === 'usb_downlink_noop' && mState.localDb && mState.photos.length > 0) {
        _refreshWifiStatusBox();
        showToast(_formatUsbDownlinkToast(res), Number(res.pendingChangeCount || 0) > 0 ? 5200 : 3800);
        return;
      }
      if (syncMode === 'loome_mount' && mState.localDb && mState.photos.length > 0) {
        if (res.catalogSkipReason === 'cache_not_accessible') {
          showToast('● Loome USB直結（原本表示可）※カタログ自動取込には cache を含む親フォルダを選択してください', 5200);
        }
        return;
      }
      await new Promise((r) => requestAnimationFrame(r));
      await _syncLinkedPhoneFoldersToLockerDb('all');
      const opened = await _activateAndroidNativeLockerDb();
      if (opened) {
        if (syncMode === 'wifi_delta' || syncMode === 'wifi_full' || syncMode === 'wifi_noop') {
          showToast(_formatWifiSyncDoneToast(res, quickSum, syncMode !== 'wifi_noop'), 4000);
        } else if (isUsbDownlink) {
          _refreshWifiStatusBox();
          showToast(_formatUsbDownlinkToast(res), Number(res.pendingChangeCount || 0) > 0 ? 5200 : 4200);
        } else if (syncMode === 'loome_mount' && res.catalogSkipReason === 'cache_not_accessible') {
          showToast('● Loome USB直結（原本表示可）※カタログ自動取込には cache を含む親フォルダを選択してください', 5200);
        } else if (syncMode !== 'loome_mount') {
          showToast('✓ USBから専用ロッカーへ高速同期しました', 3500);
        }
      }
    } else if (res && !res.cancelled) {
      const errMsg = res.error || (res.reason === 'library_db_not_found'
        ? '選択したフォルダ内に library.db が見つかりません'
        : 'ロッカー同期に失敗しました');
      showToast(errMsg, 4500);
    }
  }

  async function _initAndroidNativeLockerMode() {
    window.__onTetheractWifiSyncStarted = (serverUrl, customTitle, customSub) => {
      const dbOverlay = document.getElementById('mDbSyncOverlay');
      if (dbOverlay) dbOverlay.style.display = 'none';
      const titleText = customTitle || `PC (${serverUrl || 'Wi-Fi'}) と双方向同期中...`;
      const subText = customSub || '選別データの送信と最新差分の取得を行っています';
      setLoading(true, titleText, subText);
    };
    window.__onTetheractUsbDownlinkStarted = (customTitle, customSub) => {
      const dbOverlay = document.getElementById('mDbSyncOverlay');
      if (dbOverlay) dbOverlay.style.display = 'none';
      setLoading(
        true,
        customTitle || '母艦USBからカタログを自動取込中（読み取り専用）...',
        customSub || '安全のため母艦 → モバイルのダウンリンク専用です。USBへは書き込みません'
      );
    };
    window.__onTetheractPcDiscovered = (disc) => {
      if (!disc || !disc.found) return;
      _refreshWifiStatusBox();
      const hostLabel = disc.hostname ? `${disc.hostname} (${disc.serverUrl || ''})` : (disc.serverUrl || 'PC');
      const wifiBox = document.getElementById('mWifiPairStatusBox');
      if (wifiBox) {
        wifiBox.innerHTML = `<span style="color:#34d399;font-weight:700;">● 同一Wi-Fi上にPC母艦を検出:</span> <strong>${_escHtml(hostLabel)}</strong>`;
      }
      const welcomeBtnSpan = document.querySelector('#mWelcomeWifiSyncBtn span');
      if (welcomeBtnSpan && disc.hostname) {
        welcomeBtnSpan.textContent = `検出したPC (${disc.hostname}) とWi-Fiで同期`;
      }
      showToast(`● 同一Wi-Fi上にPC母艦「${disc.hostname || disc.serverUrl}」を検出しました`, 3000);
    };
    window.__onTetheractNativeApkUpdateRequired = (info) => {
      _refreshWifiStatusBox();
      const verLabel = info && info.uiVersion ? ` (v${info.uiVersion})` : '';
      showToast(`! 本体アプリ(APK)${verLabel}のネイティブ更新があります。「DB/同期」から最新APKを取得できます`, 5500);
    };
    if (!_nativeUsbSyncEventBound) {
      _nativeUsbSyncEventBound = true;
      window.addEventListener('tetheract:usb-sync-completed', (ev) => {
        _handleNativeUsbSyncCompleted((ev && ev.detail) || {});
      });
    }
    window.__onTetheractPhoneCatalogSynced = async () => {
      if (!mState.localDb || mState.mode === 'offline') {
        await _activateAndroidNativeLockerDb();
        return;
      }
      _refreshLocalDbSchemaFlags();
      mState.stackCountsMap = null;
      mState.monthDayCountsCache = new Map();
      await refreshAllData();
    };
    window.__getActiveMobileFolderPath = () => mState.folderPath || '';
    window.__getMobileFolderPhotoCount = (folderPath) => {
      const fp = String(folderPath || '').trim().replace(/[\\/]+$/, '');
      if (!fp) return 0;
      let sum = 0;
      for (const r of mState.folderList || []) {
        const dp = String((r && r.directory_path) || '').trim().replace(/[\\/]+$/, '');
        if (dp === fp || dp.startsWith(`${fp}/`) || dp.startsWith(`${fp}\\`)) {
          sum += Number(r.count || 0);
        }
      }
      if (sum > 0 || !mState.localDb) return sum;
      try {
        const qParams = [];
        const dirCond = _buildFolderFilterClause(fp, qParams);
        const cntRows = queryLocalDbObjects(
          `SELECT COUNT(*) AS cnt FROM photos p WHERE IFNULL(p.is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW_P} AND ${dirCond}`,
          qParams
        );
        return cntRows[0] ? Number(cntRows[0].cnt || 0) : 0;
      } catch (e) {
        return 0;
      }
    };
    window.__filterMobileGalleryByFolder = async (folderPath, options = {}) => {
      const target = String(folderPath || '').trim();
      const folderId = String((options && options.folderId) || 'all').trim() || 'all';
      const forceSelect = Boolean(options && options.forceSelect);
      if (window.TetheractNative && (!mState.localDb || mState.mode === 'offline')) {
        let opened = await _activateAndroidNativeLockerDb();
        if (!opened) {
          await _syncLinkedPhoneFoldersToLockerDb(folderId);
          opened = await _activateAndroidNativeLockerDb();
        }
      }
      mState.folderPath = forceSelect ? target : (mState.folderPath === target ? '' : target);
      if (window.TetheractTouchUI && typeof window.TetheractTouchUI.closePerspectiveSheet === 'function') {
        window.TetheractTouchUI.closePerspectiveSheet();
      }
      await fetchPhotosData();
      if (
        mState.folderPath &&
        mState.folderPath.startsWith('📱 ') &&
        mState.photos.length === 0 &&
        window.TetheractNative
      ) {
        const synced = await _syncLinkedPhoneFoldersToLockerDb(folderId);
        if (synced) {
          await _activateAndroidNativeLockerDb();
        }
        if (mState.photos.length === 0 && mState.ratingFilter === 'default') {
          const qParams = [];
          const dirCond = _buildFolderFilterClause(mState.folderPath, qParams);
          const anyRows = queryLocalDbObjects(
            `SELECT COUNT(*) AS cnt FROM photos p WHERE IFNULL(p.is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW_P} AND ${dirCond}`,
            qParams
          );
          if (anyRows[0] && Number(anyRows[0].cnt || 0) > 0) {
            mState.ratingFilter = 'all';
            document.querySelectorAll('.m-quick-scroll [data-rating]').forEach((btn) => {
              btn.classList.toggle('active', btn.dataset.rating === 'all');
            });
            await fetchPhotosData();
          }
        }
      }
      renderDrawerFilters();
    };
    _discardLegacyJsJournalOnNative();
    _refreshWifiStatusBox();
    let opened = await _activateAndroidNativeLockerDb();
    if (!opened) {
      const synced = await _syncLinkedPhoneFoldersToLockerDb('all');
      if (synced) {
        opened = await _activateAndroidNativeLockerDb();
      }
    }
    if (!opened) {
      setAppMode('offline');
    }
  }

  function initTheme() {
    const savedTheme = _safeGetStorage('pm_theme', 'sumi');
    applyTheme(savedTheme);
  }

  function applyTheme(theme) {
    const t = theme === 'paper' ? 'paper' : 'sumi';
    document.documentElement.setAttribute('data-theme', t);
    _safeSetStorage('pm_theme', t);
    const icon = document.getElementById('mThemeIcon');
    if (icon) {
      icon.innerHTML =
        t === 'paper'
          ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
          : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    }
    const metaTheme = document.getElementById('mMetaThemeColor');
    if (metaTheme) metaTheme.setAttribute('content', t === 'paper' ? '#e8e4d9' : '#16181b');
  }

  function initSavedPrefs() {
    const cols = Number(_safeGetStorage('pm_mobile_cols', '3'));
    if ([2, 3, 4, 5, 6].includes(cols)) {
      mState.gridCols = cols;
      updateGridColsUI();
    }
    const savedLayout = _safeGetStorage('pm_mobile_layout', 'grid');
    if (['grid', 'masonry', 'mount'].includes(savedLayout)) {
      mState.gridLayout = savedLayout;
    }
    updateGridLayoutUI();
    const savedAuto = _safeGetStorage('pm_mobile_auto_advance', null);
    if (savedAuto !== null) {
      mState.autoAdvance = savedAuto === '1';
      const chk = document.getElementById('mAutoAdvanceCheck');
      if (chk) chk.checked = mState.autoAdvance;
    }
    const autoBtn = document.getElementById('mViewerAutoAdvanceBtn');
    if (autoBtn) autoBtn.classList.toggle('active', Boolean(mState.autoAdvance));
  }

  function setAppMode(mode) {
    mState.mode = mode;
    const badge = document.getElementById('mModeBadge');
    const welcome = document.getElementById('mWelcomeCard');
    const grid = document.getElementById('mPhotoGrid');
    const exportFullBtn = document.getElementById('mExportFullDbBtn');

    if (badge) {
      badge.className = 'm-mode-badge';
      if (mode === 'server') {
        badge.classList.add('mode-server');
        badge.textContent = '● Wi-Fi接続';
      } else if (mode === 'localdb') {
        badge.classList.add('mode-localdb');
        badge.textContent = '● USB DB';
      } else {
        badge.classList.add('mode-offline');
        badge.textContent = '○ DB未読込';
      }
    }

    if (exportFullBtn) {
      exportFullBtn.style.display = mode === 'localdb' && mState.localDb ? 'inline-flex' : 'none';
    }

    if (mode === 'offline') {
      if (welcome) welcome.style.display = 'flex';
      if (grid) grid.innerHTML = '';
      document.getElementById('mPhotoCount').textContent = '0枚';
    } else {
      if (welcome) welcome.style.display = 'none';
    }
  }

  function setLoading(isLoading, title = '読み込み中...', sub = 'しばらくお待ちください') {
    const el = document.getElementById('mLoadingState');
    if (!el) return;
    if (isLoading) {
      document.getElementById('mLoadingText').textContent = title;
      document.getElementById('mLoadingSub').textContent = sub;
      el.style.display = 'flex';
      document.getElementById('mWelcomeCard').style.display = 'none';
      document.getElementById('mEmptyState').style.display = 'none';
    } else {
      el.style.display = 'none';
    }
  }

  /**
   * PCローカルプレビュー (/m) の接続試行（ローカルファイル起動時は待機時間ゼロでスキップ）
   */
  async function tryConnectServer() {
    if (_isLocalFileOrigin()) {
      return false;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch('/api/version', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;

      setAppMode('server');
      _setupBrowserToNativeAppBanner();
      await refreshAllData();
      _refreshServerConnectionStatus();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ==================== オフライン USB library.db (sql.js) エンジン ====================

  /**
   * Base64文字列を Uint8Array にデコードする
   */
  function _decodeBase64ToUint8Array(b64) {
    const binStr = window.atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * sql.js (WebAssembly) インスタンスを初期化する
   * 単体HTML (Tetheract_Mobile.html) では内蔵Base64から直接メモリ展開し、
   * 外部 .wasm ファイルへの fetch (CORS/content://制限) を100%回避する。
   */
  async function ensureSqlJsLoaded() {
    if (mState.sqlJsInstance) return mState.sqlJsInstance;
    if (typeof window.initSqlJs !== 'function') {
      throw new Error('sql.js ライブラリが読み込まれていません');
    }
    if (window.__PM_SQL_WASM_BASE64__) {
      const wasmBinary = _decodeBase64ToUint8Array(window.__PM_SQL_WASM_BASE64__);
      mState.sqlJsInstance = await window.initSqlJs({ wasmBinary });
    } else {
      mState.sqlJsInstance = await window.initSqlJs({
        locateFile: (file) => `/vendor/sqljs/${file}`,
      });
    }
    return mState.sqlJsInstance;
  }

  /**
   * 選択された library.db ファイルをメモリに一括ロードして開く
   */
  async function loadLocalSqliteFile(file) {
    if (!file) return;
    setLoading(
      true,
      `「${file.name}」を一括ロード中...`,
      `サイズ: ${(file.size / (1024 * 1024)).toFixed(1)} MB（ロックエラー防止のためメモリへ展開しています）`
    );

    try {
      const SQL = await ensureSqlJsLoaded();
      const arrayBuffer = await file.arrayBuffer();
      const u8 = new Uint8Array(arrayBuffer);

      // 既存のDBとObjectURLキャッシュを解放
      if (mState.localDb) {
        try {
          mState.localDb.close();
        } catch (e) {}
      }
      clearThumbUrlCache();

      const db = new SQL.Database(u8);
      if (typeof db.create_function === 'function') {
        db.create_function('tetheract_v170_guard', () => 1);
      }
      // photosテーブルの存在確認
      const check = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'");
      if (!check || check.length === 0) {
        db.close();
        throw new Error('有効な Tetheract データベース (photosテーブル) が見つかりません');
      }

      mState.localDb = db;
      _refreshLocalDbSchemaFlags();
      mState.stackCountsMap = null;
      mState.monthDayCountsCache = new Map();
      mState.localDbFileName = file.name;
      mState.pendingChanges.db_name = file.name;

      // もし端末内に未反映の変更履歴があれば、メモリ上のDBにも自動適用して状態を復元
      applyPendingChangesToLocalDb();

      setAppMode('localdb');
      await refreshAllData();

      const statusBox = document.getElementById('mLoadedDbStatus');
      if (statusBox) {
        statusBox.innerHTML = `✓ <strong>${_escHtml(file.name)}</strong> (${(file.size / 1024 / 1024).toFixed(1)} MB) を読込完了`;
      }
      showToast(`${file.name} を読み込みました`);
    } catch (err) {
      console.error('DBファイル読込エラー:', err);
      showToast('! DBの読み込みに失敗しました: ' + (err.message || err), 4500);
      if (mState.mode === 'checking') {
        setAppMode('offline');
      }
    } finally {
      setLoading(false);
    }
  }

  /**
   * 端末内に保存されている未反映の変更差分をメモリ上の localDb に適用する
   */
  function applyPendingChangesToLocalDb() {
    if (!mState.localDb || !mState.pendingChanges || !mState.pendingChanges.items) return;
    const db = mState.localDb;
    const items = Object.values(mState.pendingChanges.items);
    if (items.length === 0) return;

    try {
      db.run('BEGIN TRANSACTION');
      for (const item of items) {
        const pid = Number(item.photo_id);
        if (!pid) continue;
        if (item.rating !== undefined && item.rating !== null) {
          db.run('UPDATE photos SET rating = ? WHERE id = ?', [Number(item.rating), pid]);
        }
        if (item.set_stack_primary) {
          const stRows = queryLocalDbObjects('SELECT stack_id FROM photos WHERE id = ? LIMIT 1', [pid]);
          const oldStackId = stRows.length > 0 ? Number(stRows[0].stack_id || 0) : 0;
          if (oldStackId > 0) {
            db.run(
              'UPDATE photos SET stack_id = ?, is_stack_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE stack_id = ?',
              [pid, pid, oldStackId]
            );
          }
        }
        if (
          item.brightness !== undefined ||
          item.contrast !== undefined ||
          item.saturation !== undefined ||
          item.fine_angle !== undefined ||
          item.rotation !== undefined
        ) {
          if (!item.base_adjustments) {
            const baseRows = queryLocalDbObjects('SELECT * FROM photos WHERE id = ? LIMIT 1', [pid]);
            if (baseRows && baseRows.length > 0) {
              item.base_adjustments = _normalizeAdjustSnapshot(baseRows[0]);
            }
          }
          db.run(
            'UPDATE photos SET brightness = COALESCE(?, brightness), contrast = COALESCE(?, contrast), saturation = COALESCE(?, saturation), fine_angle = COALESCE(?, fine_angle), rotation = COALESCE(?, rotation) WHERE id = ?',
            [
              item.brightness !== undefined ? Number(item.brightness) : null,
              item.contrast !== undefined ? Number(item.contrast) : null,
              item.saturation !== undefined ? Number(item.saturation) : null,
              item.fine_angle !== undefined ? Number(item.fine_angle) : null,
              item.rotation !== undefined ? Number(item.rotation) : null,
              pid,
            ]
          );
        }
        if (Array.isArray(item.remove_tags)) {
          for (const t of item.remove_tags) {
            db.run('DELETE FROM photo_tags WHERE photo_id = ? AND (tag = ? OR tag LIKE ?)', [
              pid,
              t,
              `${t}/%`,
            ]);
          }
        }
        if (Array.isArray(item.add_tags)) {
          for (const rawTag of item.add_tags) {
            for (const anc of expandTagAncestors(rawTag)) {
              db.run(
                "INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)",
                [pid, anc]
              );
            }
          }
        }
      }
      db.run('COMMIT');
      _refreshPendingBakedAdjustMap();
    } catch (e) {
      try {
        db.run('ROLLBACK');
      } catch (re) {}
      console.warn('未反映差分のメモリDB適用エラー:', e);
    }
  }

  function clearThumbUrlCache() {
    for (const url of mState.thumbUrlCache.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }
    mState.thumbUrlCache.clear();
  }

  /**
   * sql.js からプリペアドステートメントでオブジェクト配列を取得するヘルパー
   */
  function queryLocalDbObjects(sql, params = []) {
    if (!mState.localDb) return [];
    if (mState.localDb.isAndroidNative && window.TetheractNative && typeof window.TetheractNative.rawQueryJson === 'function') {
      try {
        return JSON.parse(window.TetheractNative.rawQueryJson(sql, JSON.stringify(params || [])) || '[]');
      } catch (e) {
        console.warn('Android Native SQL Query Error:', e);
        return [];
      }
    }
    const stmt = mState.localDb.prepare(sql);
    const results = [];
    try {
      stmt.bind(params);
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
    } finally {
      stmt.free();
    }
    return results;
  }

  function _buildMobilePhotoVersionKey(photo) {
    const rot = photo.rotation || 0;
    const fa = Math.round((Number(photo.fine_angle) || 0) * 10);
    const mtime = Math.floor(photo.file_mtime || 0);
    const crop = photo.crop_w
      ? `${Math.round((photo.crop_x || 0) * 1000)}_${Math.round((photo.crop_y || 0) * 1000)}_${Math.round(photo.crop_w * 1000)}_${Math.round((photo.crop_h || 0) * 1000)}`
      : '0';
    const tone = `${photo.brightness || 0}_${photo.contrast || 0}_${photo.saturation || 0}`;
    return `${photo.file_size || photo.id}_${mtime}_r${rot}_fa${fa}_c${crop}_t${tone}`;
  }

  /**
   * 焼き込み済み基準値に基づくバージョンキーを生成する（スクラブ中URL再読込を抑え、PC同期後のキャッシュだけ破棄する）
   */
  function _buildMobilePhotoBakedVersionKey(photo) {
    if (!photo) return '0';
    const baked = photo._bakedAdjust || _resolveBakedAdjustForPhoto(photo);
    return _buildMobilePhotoVersionKey({
      ...photo,
      rotation: baked.rotation !== undefined ? baked.rotation : photo.rotation,
      fine_angle: baked.fine_angle !== undefined ? baked.fine_angle : photo.fine_angle,
      brightness: baked.brightness !== undefined ? baked.brightness : photo.brightness,
      contrast: baked.contrast !== undefined ? baked.contrast : photo.contrast,
      saturation: baked.saturation !== undefined ? baked.saturation : photo.saturation,
      crop_x: baked.crop_x !== undefined ? baked.crop_x : photo.crop_x,
      crop_y: baked.crop_y !== undefined ? baked.crop_y : photo.crop_y,
      crop_w: baked.crop_w !== undefined ? baked.crop_w : photo.crop_w,
      crop_h: baked.crop_h !== undefined ? baked.crop_h : photo.crop_h,
    });
  }

  /**
   * 写真のサムネイルURLを取得する（serverモード時はAPI URL、localdbモード時はBLOBからObjectURLを生成）
   */
  function getMobileThumbnailUrl(photo) {
    if (!photo) return '';
    if (mState.mode === 'server') {
      return `/api/photo/${photo.id}/thumbnail?v=${_buildMobilePhotoVersionKey(photo)}`;
    }

    // localdb モード: thumbnails テーブルの BLOB (WebP) から ObjectURL を生成してキャッシュ
    const pid = Number(photo.id);
    if (mState.localDb && mState.localDb.isAndroidNative) {
      return `https://appassets.tetheract.local/thumb/${pid}?v=${_buildMobilePhotoBakedVersionKey(photo)}`;
    }
    if (mState.thumbUrlCache.has(pid)) {
      return mState.thumbUrlCache.get(pid);
    }
    if (!mState.localDb) return '';

    try {
      const stmt = mState.localDb.prepare(
        'SELECT data FROM thumbnails WHERE photo_id = ? ORDER BY created_at DESC LIMIT 1'
      );
      stmt.bind([pid]);
      if (stmt.step()) {
        const row = stmt.get();
        const u8 = row[0];
        stmt.free();
        if (u8 && u8.length > 0) {
          const blob = new Blob([u8], { type: 'image/webp' });
          const objUrl = URL.createObjectURL(blob);
          mState.thumbUrlCache.set(pid, objUrl);
          return objUrl;
        }
      } else {
        stmt.free();
      }
    } catch (e) {
      console.warn('サムネイルBLOB抽出失敗:', pid, e);
    }
    return '';
  }

  /**
   * 拡大ビューア・Duel比較用の実ファイル（フル解像度JPEG・RAW埋込プレビュー）URLを取得する
   * Androidネイティブ時は USB SAF 直結 → Wi-Fi LAN 経由の PC (/api/photo/{id}/view) の順で解決し、
   * どちらもオフラインの場合は 404 (only_hd=1) となって即座に既存のWebPサムネイルを維持する
   */
  function getMobileFullPhotoUrl(photo) {
    if (!photo || !photo.id) return '';
    const pid = Number(photo.id);
    if (mState.mode === 'server') {
      return `/api/photo/${pid}/view?v=${_buildMobilePhotoVersionKey(photo)}`;
    }
    if (window.TetheractNative || (mState.localDb && mState.localDb.isAndroidNative)) {
      const linkTag = `${mState.nativeLinkState?.usbConnected ? 'u1' : 'u0'}_${mState.nativeLinkState?.isPcLinked ? 'w1' : 'w0'}`;
      return `https://appassets.tetheract.local/usb_photo/${pid}?only_hd=1&s=${_NATIVE_SESSION_NONCE}_${linkTag}&v=${_buildMobilePhotoBakedVersionKey(photo)}`;
    }
    return '';
  }

  // ==================== データ取得（Server / LocalDB 統一レイヤー） ====================

  let _refreshInFlightPromise = null;
  let _refreshQueuedAgain = false;

  async function refreshAllData() {
    if (mState.mode === 'offline') return;
    if (_refreshInFlightPromise) {
      _refreshQueuedAgain = true;
      return _refreshInFlightPromise;
    }
    _refreshInFlightPromise = (async () => {
      try {
        do {
          _refreshQueuedAgain = false;
          if (mState.mode === 'offline') break;
          await Promise.all([fetchPhotosData(), fetchFilterSummaries()]);
        } while (_refreshQueuedAgain);
      } finally {
        _refreshInFlightPromise = null;
        _refreshQueuedAgain = false;
      }
    })();
    return _refreshInFlightPromise;
  }

  /**
   * 現在のフィルタ条件で写真一覧を取得してグリッドを描画する
   */
  async function fetchPhotosData() {
    if (mState.mode === 'server') {
      await fetchPhotosFromServer();
    } else if (mState.mode === 'localdb') {
      fetchPhotosFromLocalDb();
    }
  }

  async function fetchPhotosFromServer() {
    try {
      const params = new URLSearchParams();
      if (mState.ratingFilter === 'default') {
        params.set('ratings', '0,1,2');
      } else if (mState.ratingFilter === 'all') {
        params.set('ratings', '-1,0,1,2');
      } else {
        params.set('ratings', String(mState.ratingFilter));
      }
      params.set('stacked', String(mState.stacked));
      params.set('sort_by', mState.sortBy);

      if (mState.searchQuery) params.set('search', mState.searchQuery);
      if (mState.untaggedOnly) {
        params.set('untagged', 'true');
      } else {
        if (mState.includeTags.length > 0) params.set('include_tags', mState.includeTags.join(','));
        if (mState.excludeTags.length > 0) params.set('exclude_tags', mState.excludeTags.join(','));
      }
      if (mState.dateDay) params.set('dates', mState.dateDay);
      else if (mState.yearMonth) params.set('year_month', mState.yearMonth);
      if (mState.cameraModel) params.set('cameras', mState.cameraModel);
      if (mState.lensModel) params.set('lenses', mState.lensModel);
      if (mState.folderPath) params.set('folder', mState.folderPath);
      if (mState.noLocationOnly) {
        params.set('no_location', 'true');
      } else {
        if (mState.country) params.set('country', mState.country);
        if (mState.stateName) params.set('state', mState.stateName);
        if (mState.city) params.set('city', mState.city);
      }

      const res = await fetch(`/api/photos?${params.toString()}`);
      if (!res.ok) throw new Error('写真一覧取得失敗');
      const data = await res.json();
      mState.photos = (data.photos || []).map((p) => {
        p._bakedAdjust = _normalizeAdjustSnapshot(p);
        return p;
      });
      renderPhotoGrid();
      updateHeaderCounters();
      renderActiveFilterChips();
    } catch (e) {
      console.error('サーバーからの写真取得エラー:', e);
      showToast('⚠️ サーバー通信エラー');
    }
  }

  /**
   * フォルダ階層フィルタ用のSQL条件式を構築する（photos.directory_path と photo_links の双方を照合）
   */
  function _buildFolderFilterClause(folderPath, params) {
    const fp = String(folderPath || '').trim().replace(/[\\/]+$/, '');
    if (!fp) return '1 = 1';
    params.push(fp, `${fp}/%`, `${fp}\\%`);
    if (!mState.hasPhotoLinksTable) {
      return '(p.directory_path = ? OR p.directory_path LIKE ? OR p.directory_path LIKE ?)';
    }
    const linkConds = [];
    if (mState.hasPhotoLinksDirCol) {
      linkConds.push('pl.directory_path = ? OR pl.directory_path LIKE ? OR pl.directory_path LIKE ?');
      params.push(fp, `${fp}/%`, `${fp}\\%`);
    }
    if (fp.startsWith('📱 ')) {
      const relFolder = fp.slice('📱 '.length).trim().replace(/[\\/]+$/, '');
      if (relFolder) {
        linkConds.push("(pl.volume_serial = 'ANDROID_LOCAL' AND (pl.rel_path LIKE ? OR pl.rel_path LIKE ?))");
        params.push(`${relFolder}/%`, `${relFolder}\\%`);
      }
    }
    if (linkConds.length === 0) {
      return '(p.directory_path = ? OR p.directory_path LIKE ? OR p.directory_path LIKE ?)';
    }
    return `(p.directory_path = ? OR p.directory_path LIKE ? OR p.directory_path LIKE ? OR EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id AND (${linkConds.join(' OR ')})))`;
  }

  /**
   * オフライン localdb (sql.js) から写真一覧をSQL検索する
   */
  function fetchPhotosFromLocalDb() {
    if (!mState.localDb) return;
    _refreshPendingBakedAdjustMap();

    if (!mState.stackCountsMap) {
      const stackRows = queryLocalDbObjects(
        `SELECT stack_id, COUNT(*) AS cnt FROM photos WHERE stack_id IS NOT NULL AND IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} GROUP BY stack_id HAVING COUNT(*) > 1`
      );
      mState.stackCountsMap = new Map(stackRows.map((r) => [r.stack_id, Number(r.cnt || 1)]));
    }

    const phoneLocalExpr = mState.hasPhotoLinksTable
      ? "CASE WHEN p.volume_serial = 'ANDROID_LOCAL' OR p.id >= 900000000 OR EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id AND pl.volume_serial = 'ANDROID_LOCAL') THEN 1 ELSE 0 END AS is_phone_local"
      : "CASE WHEN p.volume_serial = 'ANDROID_LOCAL' OR p.id >= 900000000 THEN 1 ELSE 0 END AS is_phone_local";

    let sql = `
      SELECT p.id, p.file_name, p.rating, p.width, p.height, p.rotation,
             p.fine_angle, p.brightness, p.contrast, p.saturation, p.crop_x, p.crop_y, p.crop_w, p.crop_h,
             CASE WHEN p.is_raw = 1 OR (p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '') THEN 1 ELSE 0 END AS is_raw,
             p.stack_id, COALESCE(p.content_key, '') AS content_key, COALESCE(p.file_path, '') AS file_path,
             COALESCE(p.file_size, 0) AS file_size, COALESCE(p.file_mtime, 0) AS file_mtime,
             COALESCE(p.volume_serial, '') AS volume_serial,
             COALESCE(p.directory_path, '') AS directory_path, ${phoneLocalExpr}
      FROM photos p
      WHERE IFNULL(p.is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW_P}
    `;
    const params = [];

    // 評価フィルタ (-1:棄, 0:可, 1:良, 2:優)
    if (mState.ratingFilter === 'default') {
      sql += ' AND IFNULL(p.rating, 0) IN (0, 1, 2)';
    } else if (mState.ratingFilter !== 'all') {
      sql += ' AND IFNULL(p.rating, 0) = ?';
      params.push(Number(mState.ratingFilter));
    }

    // スタック集約（スマホ管理下フォルダ選択時は母艦側でサブコマ扱いになっていた写真も非表示にしない）
    const isPhoneFolderSelected = Boolean(mState.folderPath && mState.folderPath.startsWith('📱 '));
    if (mState.stacked && !isPhoneFolderSelected) {
      sql += ' AND (p.stack_id IS NULL OR IFNULL(p.is_stack_primary, 1) = 1)';
    }

    // ファイル名・フォルダ名検索
    if (mState.searchQuery) {
      if (mState.hasPhotoLinksTable && mState.hasPhotoLinksDirCol) {
        sql += ' AND (p.file_name LIKE ? OR p.directory_path LIKE ? OR EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id AND (pl.file_name LIKE ? OR pl.directory_path LIKE ?)))';
        params.push(`%${mState.searchQuery}%`, `%${mState.searchQuery}%`, `%${mState.searchQuery}%`, `%${mState.searchQuery}%`);
      } else {
        sql += ' AND (p.file_name LIKE ? OR p.directory_path LIKE ?)';
        params.push(`%${mState.searchQuery}%`, `%${mState.searchQuery}%`);
      }
    }

    // 年・年月・日付(カレンダー)フィルタ
    if (mState.dateDay) {
      const colonDay = mState.dateDay.replace(/-/g, ':');
      sql += ' AND (p.date_taken LIKE ? OR p.date_taken LIKE ?)';
      params.push(`${mState.dateDay}%`, `${colonDay}%`);
    } else if (mState.yearMonth) {
      if (mState.yearMonth.length === 4) {
        sql += ' AND p.year_month LIKE ?';
        params.push(`${mState.yearMonth}-%`);
      } else {
        sql += ' AND p.year_month = ?';
        params.push(mState.yearMonth);
      }
    }

    // カメラ機種 & レンズフィルタ
    if (mState.cameraModel) {
      sql += ' AND p.camera_model = ?';
      params.push(mState.cameraModel);
    }
    if (mState.lensModel) {
      sql += ' AND p.lens_model = ?';
      params.push(mState.lensModel);
    }

    // フォルダ階層フィルタ
    if (mState.folderPath) {
      sql += ` AND ${_buildFolderFilterClause(mState.folderPath, params)}`;
    }

    // 撮影地フィルタ
    if (mState.noLocationOnly) {
      sql +=
        " AND (p.latitude IS NULL OR p.country IS NULL OR p.country = '' OR (ABS(p.latitude) < 0.0001 AND ABS(p.longitude) < 0.0001))";
    } else {
      if (mState.country) {
        sql += ' AND p.country = ?';
        params.push(mState.country);
      }
      if (mState.stateName) {
        sql += ' AND p.state = ?';
        params.push(mState.stateName);
      }
      if (mState.city) {
        sql += ' AND p.city = ?';
        params.push(mState.city);
      }
    }

    // タグフィルタ（最上位の親が同じタグ同士は OR 条件、異なるグループ間・最上位タグ同士は AND 条件）
    if (mState.untaggedOnly) {
      const cPh = MOBILE_COLOR_TAGS.map(() => '?').join(',');
      sql += ` AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND IFNULL(pt.source, 'manual') != 'ai' AND pt.tag NOT IN (${cPh}))`;
      params.push(...MOBILE_COLOR_TAGS);
    } else {
      const cleanInc = (mState.includeTags || []).map((t) => String(t || '').trim()).filter(Boolean);
      const effectiveInc = cleanInc.filter(
        (t) => !cleanInc.some((other) => other !== t && other.startsWith(`${t}/`))
      );
      const tagGroups = new Map();
      for (const incTag of effectiveInc) {
        const rootParent = incTag.split('/')[0].trim();
        if (!tagGroups.has(rootParent)) tagGroups.set(rootParent, []);
        const grp = tagGroups.get(rootParent);
        if (!grp.includes(incTag)) grp.push(incTag);
      }
      for (const grpTags of tagGroups.values()) {
        if (grpTags.length === 1) {
          sql += ' AND EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag = ?)';
          params.push(grpTags[0]);
        } else {
          const ph = grpTags.map(() => '?').join(',');
          sql += ` AND EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag IN (${ph}))`;
          params.push(...grpTags);
        }
      }
      for (const excTag of mState.excludeTags) {
        sql +=
          ' AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag = ?)';
        params.push(excTag);
      }
    }

    // ソート順
    const allowedSorts = {
      'date_taken DESC': 'p.date_taken DESC, p.file_name ASC',
      'date_taken ASC': 'p.date_taken ASC, p.file_name ASC',
      'rating DESC': 'p.rating DESC, p.date_taken DESC',
      'file_name ASC': 'p.file_name ASC',
    };
    const orderClause = allowedSorts[mState.sortBy] || 'p.date_taken DESC, p.file_name ASC';
    sql += ` ORDER BY ${orderClause}`;

    const rows = queryLocalDbObjects(sql, params);

    // 一覧グリッド描画を高速化するため、初期状態では必要最小限カラム＋stack_countのみ保持し、Exif・tags・stack_photosはオンデマンド取得する
    const scMap = mState.stackCountsMap;
    for (const r of rows) {
      r.tags = [];
      r.stack_count = mState.stacked && r.stack_id && scMap ? (scMap.get(r.stack_id) || 1) : 1;
      r.stack_photos = [];
      r._detailsLoaded = false;
      r._bakedAdjust = _resolveBakedAdjustForPhoto(r);
    }

    mState.photos = rows;
    renderPhotoGrid();
    updateHeaderCounters();
    renderActiveFilterChips();
  }

  /**
   * スマホ内写真の未取得EXIF・露出設定・GPS地名をネイティブ層からオンデマンド補完する
   */
  function _hydratePhonePhotoExifIfNeeded(photo) {
    if (!photo || !photo.id || photo._exifHydrated) return;
    const isPhoneOrig =
      Number(photo.id) >= 900000000 ||
      photo.volume_serial === 'ANDROID_LOCAL' ||
      Boolean(photo.is_phone_local) ||
      String(photo.file_path || '').startsWith('phone://');
    photo._exifHydrated = true;
    if (!isPhoneOrig) return;

    const missingExif =
      !photo.camera_model ||
      !photo.lens_model ||
      (!photo.f_number && !photo.shutter_speed && !photo.iso && !photo.focal_length) ||
      (photo.latitude != null && photo.longitude != null && !photo.city && !photo.state && !photo.country);
    if (!missingExif) return;

    if (
      window.TetheractPhoneCaseAdapter &&
      typeof window.TetheractPhoneCaseAdapter.ensurePhotoExif === 'function'
    ) {
      const hydrated = window.TetheractPhoneCaseAdapter.ensurePhotoExif(photo.id);
      if (hydrated) {
        const fields = [
          'date_taken', 'camera_model', 'lens_model', 'focal_length',
          'f_number', 'shutter_speed', 'iso', 'width', 'height',
          'latitude', 'longitude', 'country', 'state', 'city',
        ];
        for (const k of fields) {
          if (hydrated[k] !== undefined && hydrated[k] !== null && hydrated[k] !== '') {
            photo[k] = hydrated[k];
          }
        }
      }
    }
  }

  /**
   * 単一写真（およびスタック内メンバー）の全メタデータ・タグ一覧・スタック内訳をオンデマンドでロードする
   */
  function ensureLocalPhotoDetails(photo) {
    if (!photo || mState.mode !== 'localdb' || !mState.localDb) {
      return photo;
    }
    if (photo._detailsLoaded) {
      _hydratePhonePhotoExifIfNeeded(photo);
      return photo;
    }
    photo._detailsLoaded = true;
    const prevRate = photo.rating;
    const prevBaked = photo._bakedAdjust || null;
    const fullRows = queryLocalDbObjects('SELECT * FROM photos WHERE id = ? LIMIT 1', [photo.id]);
    if (fullRows && fullRows.length > 0) {
      Object.assign(photo, fullRows[0]);
      if (prevRate !== undefined) photo.rating = prevRate;
    }
    _hydratePhonePhotoExifIfNeeded(photo);
    photo._bakedAdjust = _resolveBakedAdjustForPhoto(photo, prevBaked || photo);
    const tagRows = queryLocalDbObjects(
      'SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag',
      [photo.id]
    );
    photo.tags = tagRows.map((r) => r.tag);
    photo._tagsLoaded = true;

    if (photo.stack_id != null && Number(photo.stack_count || 1) > 1) {
      const memberRows = queryLocalDbObjects(
        `SELECT * FROM photos WHERE stack_id = ? AND IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} ORDER BY date_taken ASC, subsec_time ASC, id ASC`,
        [photo.stack_id]
      );
      for (const mr of memberRows) {
        if (mr.id === photo.id) {
          mr.tags = photo.tags;
          mr._bakedAdjust = photo._bakedAdjust;
        } else {
          const mTags = queryLocalDbObjects(
            'SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag',
            [mr.id]
          );
          mr.tags = mTags.map((r) => r.tag);
          mr._bakedAdjust = _resolveBakedAdjustForPhoto(mr);
        }
        mr._detailsLoaded = true;
      }
      photo.stack_photos = memberRows;
      photo.stack_count = memberRows.length;
    } else {
      photo.stack_photos = [];
      photo.stack_count = Number(photo.stack_count || 1);
    }
    return photo;
  }

  /**
   * photos.directory_path と photo_links (ANDROID_LOCAL 等) の双方からフォルダ集計を取得する
   */
  function _queryLocalFolderSummaries() {
    if (!mState.localDb) return [];
    if (!mState.hasPhotoLinksTable) {
      return queryLocalDbObjects(`
        SELECT directory_path, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} AND directory_path IS NOT NULL AND directory_path != ''
        GROUP BY directory_path
        ORDER BY directory_path ASC
      `);
    }
    const linkDirExpr = mState.hasPhotoLinksDirCol
      ? `CASE
           WHEN pl.directory_path IS NOT NULL AND pl.directory_path != '' THEN pl.directory_path
           WHEN pl.volume_serial = 'ANDROID_LOCAL' AND instr(pl.rel_path, '/') > 0 THEN '📱 ' || substr(pl.rel_path, 1, instr(pl.rel_path, '/') - 1)
           ELSE ''
         END`
      : `CASE
           WHEN pl.volume_serial = 'ANDROID_LOCAL' AND instr(pl.rel_path, '/') > 0 THEN '📱 ' || substr(pl.rel_path, 1, instr(pl.rel_path, '/') - 1)
           ELSE ''
         END`;
    return queryLocalDbObjects(`
      SELECT directory_path, COUNT(DISTINCT photo_id) AS count
      FROM (
        SELECT id AS photo_id, directory_path
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} AND directory_path IS NOT NULL AND directory_path != ''
        UNION ALL
        SELECT pl.photo_id AS photo_id, ${linkDirExpr} AS directory_path
        FROM photo_links pl
        INNER JOIN photos p ON p.id = pl.photo_id
        WHERE IFNULL(p.is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW_P}
      )
      WHERE directory_path IS NOT NULL AND directory_path != ''
      GROUP BY directory_path
      ORDER BY directory_path ASC
    `);
  }

  /**
   * タグ・タイムライン・ジオタグ・カメラ機種の集計を取得する
   */
  async function fetchFilterSummaries() {
    if (mState.mode === 'server') {
      try {
        const [tagsRes, tlRes, camRes, locRes, fldRes, preRes] = await Promise.all([
          fetch('/api/tags'),
          fetch('/api/timeline'),
          fetch('/api/cameras'),
          fetch('/api/locations/tree'),
          fetch('/api/folders?fast=1').catch(() => null),
          fetch('/api/filter-presets').catch(() => null),
        ]);
        if (tagsRes && tagsRes.ok) {
          const d = await tagsRes.json();
          mState.availableTags = d.tags || [];
          mState.untaggedCount = d.untagged_count || 0;
        }
        if (tlRes && tlRes.ok) {
          const d = await tlRes.json();
          mState.timelineList = d.timeline || [];
        }
        if (camRes && camRes.ok) {
          const d = await camRes.json();
          mState.cameraList = d.cameras || [];
          mState.gearList = (mState.cameraList || []).map((c) => ({
            camera_model: c.camera_model,
            lens_model: '',
            count: Number(c.count || 0),
          }));
        }
        if (locRes && locRes.ok) {
          const d = await locRes.json();
          mState.locationTree = d.tree || d.locations || [];
          mState.noLocationCount = d.no_location_count || 0;
        }
        if (fldRes && fldRes.ok) {
          const d = await fldRes.json();
          mState.folderList = (d.folders || []).map((f) => ({
            directory_path: f.path || f.directory_path || '',
            count: Number(f.count || 0),
          }));
        }
        if (preRes && preRes.ok) {
          const d = await preRes.json();
          mState.savedBinders = d.presets || [];
        }
      } catch (e) {
        console.warn('フィルタ集計の取得エラー:', e);
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      // タグ集計 (tag_definitions の tag_key / short_name / is_pinned メタデータ・手動/AI種別も統合)
      const ptRows = queryLocalDbObjects(`
        SELECT pt.tag,
               COUNT(DISTINCT pt.photo_id) AS count,
               SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) AS ai_count,
               SUM(CASE WHEN pt.source = 'manual' OR pt.source IS NULL THEN 1 ELSE 0 END) AS manual_count,
               CASE
                 WHEN SUM(CASE WHEN pt.source = 'manual' OR pt.source IS NULL THEN 1 ELSE 0 END) > 0
                  AND SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) > 0 THEN 'both'
                 WHEN SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) > 0 THEN 'ai'
                 ELSE 'manual'
               END AS source
        FROM photo_tags pt
        INNER JOIN photos p ON p.id = pt.photo_id
        WHERE IFNULL(p.is_unlinked, 0) = 0
          AND ${SQL_NOT_PAIRED_RAW_P}
        GROUP BY pt.tag
        ORDER BY pt.tag ASC
      `);
      const defMap = new Map();
      try {
        const colRows = queryLocalDbObjects('PRAGMA table_info(tag_definitions)');
        if (colRows.length > 0) {
          const colNames = new Set(colRows.map((c) => c.name));
          const selKey = colNames.has('tag_key') ? 'tag_key' : "'' AS tag_key";
          const selShort = colNames.has('short_name') ? "COALESCE(short_name, '') AS short_name" : "'' AS short_name";
          const selPin = colNames.has('is_pinned') ? 'COALESCE(is_pinned, 0) AS is_pinned' : '0 AS is_pinned';
          const defRows = queryLocalDbObjects(
            `SELECT tag, ${selKey}, ${selShort}, ${selPin} FROM tag_definitions ORDER BY tag ASC`
          );
          for (const dr of defRows) {
            if (dr.tag) {
              defMap.set(dr.tag, {
                tag_key: dr.tag_key || '',
                short_name: dr.short_name || '',
                is_pinned: Boolean(dr.is_pinned),
              });
            }
          }
        }
      } catch (e) {
        console.debug('tag_definitions 参照スキップ:', e);
      }

      const mergedTagsMap = new Map();
      for (const r of ptRows) {
        const meta = defMap.get(r.tag) || {};
        mergedTagsMap.set(r.tag, {
          tag: r.tag,
          count: r.count || 0,
          ai_count: r.ai_count || 0,
          manual_count: r.manual_count || 0,
          source: r.source || 'manual',
          tag_key: meta.tag_key || '',
          short_name: meta.short_name || '',
          is_pinned: Boolean(meta.is_pinned),
        });
      }
      for (const [defTag, meta] of defMap.entries()) {
        if (!mergedTagsMap.has(defTag)) {
          mergedTagsMap.set(defTag, {
            tag: defTag,
            count: 0,
            ai_count: 0,
            manual_count: 0,
            source: 'manual',
            tag_key: meta.tag_key || '',
            short_name: meta.short_name || '',
            is_pinned: Boolean(meta.is_pinned),
          });
        }
      }
      mState.availableTags = Array.from(mergedTagsMap.values()).sort((a, b) =>
        String(a.tag).localeCompare(String(b.tag), undefined, { numeric: true, sensitivity: 'base' })
      );

      const cPh = MOBILE_COLOR_TAGS.map(() => '?').join(',');
      const untaggedRow = queryLocalDbObjects(
        `SELECT COUNT(*) AS cnt FROM photos p
         WHERE IFNULL(p.is_unlinked, 0) = 0
           AND ${SQL_NOT_PAIRED_RAW_P}
           AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND IFNULL(pt.source, 'manual') != 'ai' AND pt.tag NOT IN (${cPh}))`,
        MOBILE_COLOR_TAGS
      );
      mState.untaggedCount = untaggedRow[0] ? untaggedRow[0].cnt : 0;

      // タイムライン集計
      mState.timelineList = queryLocalDbObjects(`
        SELECT year_month, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} AND year_month IS NOT NULL AND year_month != ''
        GROUP BY year_month
        ORDER BY year_month DESC
      `);

      // カメラ機種 & レンズ2階層集計
      mState.cameraList = queryLocalDbObjects(`
        SELECT camera_model, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} AND camera_model IS NOT NULL AND camera_model != ''
        GROUP BY camera_model
        ORDER BY count DESC
      `);
      mState.gearList = queryLocalDbObjects(`
        SELECT camera_model, COALESCE(lens_model, '') AS lens_model, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} AND camera_model IS NOT NULL AND camera_model != ''
        GROUP BY camera_model, lens_model
        ORDER BY count DESC
      `);
      mState.folderList = _queryLocalFolderSummaries();

      // ジオタグ集計
      const locRows = queryLocalDbObjects(`
        SELECT country, state, city, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} AND country IS NOT NULL AND country != ''
        GROUP BY country, state, city
        ORDER BY country ASC, state ASC, city ASC
      `);
      const countryMap = new Map();
      for (const r of locRows) {
        if (!countryMap.has(r.country)) {
          countryMap.set(r.country, { country: r.country, count: 0, states: new Map() });
        }
        const cObj = countryMap.get(r.country);
        cObj.count += r.count;
        const stName = r.state || 'その他';
        if (!cObj.states.has(stName)) {
          cObj.states.set(stName, { state: stName, count: 0, cities: [] });
        }
        const sObj = cObj.states.get(stName);
        sObj.count += r.count;
        if (r.city) {
          sObj.cities.push({ city: r.city, count: r.count });
        }
      }
      mState.locationTree = Array.from(countryMap.values()).map((c) => ({
        country: c.country,
        count: c.count,
        states: Array.from(c.states.values()),
      }));

      const noLocRow = queryLocalDbObjects(`
        SELECT COUNT(*) AS cnt FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW}
          AND (latitude IS NULL OR country IS NULL OR country = '' OR (ABS(latitude) < 0.0001 AND ABS(longitude) < 0.0001))
      `);
      mState.noLocationCount = noLocRow[0] ? noLocRow[0].cnt : 0;

      // 保存済みバインダー (filter_presets) の取得
      try {
        const hasPresets = queryLocalDbObjects(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='filter_presets'"
        );
        if (hasPresets.length > 0) {
          mState.savedBinders = queryLocalDbObjects(
            'SELECT id, name, description, filters FROM filter_presets ORDER BY updated_at DESC, name ASC'
          );
        } else {
          mState.savedBinders = [];
        }
      } catch (e) {
        mState.savedBinders = [];
      }
    }

    renderDrawerFilters();
  }

  // ==================== グリッド描画（スクロール連動チャンク追加） ====================

  function isTabletMode() {
    return document.documentElement.getAttribute('data-device-mode') === 'tablet';
  }

  /**
   * 選択中の複数写真に対して未読込のタグだけを単一 IN (...) クエリで一括プリロードする
   */
  function _batchEnsureSelectedTagsLoaded(photosList) {
    if (mState.mode !== 'localdb' || !mState.localDb || !Array.isArray(photosList) || photosList.length === 0) {
      return;
    }
    const missing = photosList.filter((p) => p && p.id && !p._detailsLoaded && !p._tagsLoaded);
    if (missing.length === 0) return;

    const byId = new Map();
    for (const p of missing) {
      p.tags = [];
      p._tagsLoaded = true;
      byId.set(Number(p.id), p);
    }
    const allIds = Array.from(byId.keys());
    for (let offset = 0; offset < allIds.length; offset += 500) {
      const chunk = allIds.slice(offset, offset + 500);
      const ph = chunk.map(() => '?').join(',');
      const rows = queryLocalDbObjects(
        `SELECT photo_id, tag FROM photo_tags WHERE photo_id IN (${ph}) ORDER BY tag`,
        chunk
      );
      for (const r of rows) {
        const target = byId.get(Number(r.photo_id));
        if (target && r.tag) target.tags.push(r.tag);
      }
    }
  }

  function _computeSelectedBatchTagSummary() {
    const selPhotos = Array.from(mState.selectedIds)
      .map((pid) => mState.photos.find((p) => p.id === pid))
      .filter(Boolean);
    const total = selPhotos.length;
    if (total === 0) return { count: 0, commonTags: [], partialTags: [], commonRating: null, previewPhoto: null };

    _batchEnsureSelectedTagsLoaded(selPhotos);

    const fullCounts = new Map();
    const leafUnion = new Set();
    let firstRate = null;
    let sameRate = true;

    selPhotos.forEach((p, idx) => {
      const r = Number(p.rating || 0);
      if (idx === 0) firstRate = r;
      else if (r !== firstRate) sameRate = false;

      const tags = Array.isArray(p.tags) ? p.tags : [];
      const uniq = new Set(tags);
      uniq.forEach((t) => fullCounts.set(t, (fullCounts.get(t) || 0) + 1));
      const leaves = tags.filter((t) => !tags.some((o) => o !== t && o.startsWith(`${t}/`)));
      leaves.forEach((t) => leafUnion.add(t));
    });

    const allTags = Array.from(fullCounts.keys());
    const displaySet = new Set(leafUnion);
    allTags.forEach((t) => {
      if (fullCounts.get(t) === total) {
        const hasCommonDesc = allTags.some((d) => d !== t && d.startsWith(`${t}/`) && fullCounts.get(d) === total);
        if (!hasCommonDesc) displaySet.add(t);
        else displaySet.delete(t);
      }
    });

    const commonTags = [];
    const partialTags = [];
    Array.from(displaySet)
      .sort((a, b) => String(a).localeCompare(String(b), 'ja', { numeric: true }))
      .forEach((t) => {
        const cnt = fullCounts.get(t) || 0;
        if (cnt === total) commonTags.push(t);
        else if (cnt > 0) partialTags.push({ tag: t, cnt });
      });
    partialTags.sort((a, b) => b.cnt - a.cnt || String(a.tag).localeCompare(String(b.tag), 'ja', { numeric: true }));

    return {
      count: total,
      commonTags,
      partialTags,
      commonRating: sameRate ? firstRate : null,
      previewPhoto: selPhotos[selPhotos.length - 1] || selPhotos[0],
    };
  }

  function syncTabletInspectorCurrentPhoto() {
    if (!window.TetheractTouchUI || typeof window.TetheractTouchUI.updateTabletInspector !== 'function') {
      return;
    }
    if (mState.selectMode && mState.selectedIds.size > 1) {
      const batchInfo = _computeSelectedBatchTagSummary();
      const pv = batchInfo.previewPhoto ? ensureLocalPhotoDetails(batchInfo.previewPhoto) : null;
      window.TetheractTouchUI.updateTabletInspector(
        pv ? { ...pv, thumbUrl: getMobileThumbnailUrl(pv) } : null,
        batchInfo
      );
      return;
    }
    const idx = mState.inspectedIndex >= 0 ? mState.inspectedIndex : mState.viewerIndex;
    const photo = idx >= 0 && idx < mState.photos.length ? mState.photos[idx] : null;
    if (!photo) {
      window.TetheractTouchUI.updateTabletInspector(null);
      return;
    }
    ensureLocalPhotoDetails(photo);
    window.TetheractTouchUI.updateTabletInspector({
      ...photo,
      thumbUrl: getMobileThumbnailUrl(photo),
    });
  }

  function clearSingleSelection() {
    mState.inspectedIndex = -1;
    mState.inspectedPhotoId = null;
    document.querySelectorAll('.m-card.is-inspected').forEach((el) => el.classList.remove('is-inspected'));
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.setTargetPhotoState === 'function') {
      window.TetheractTouchUI.setTargetPhotoState({
        hasTarget: false,
        rating: null,
        canDuel: false,
      });
    }
    syncTabletInspectorCurrentPhoto();
  }

  function inspectPhotoAt(index) {
    if (index < 0 || index >= mState.photos.length) return;
    const photo = mState.photos[index];
    mState.inspectedIndex = index;
    mState.inspectedPhotoId = photo ? photo.id : null;
    mState.viewerIndex = index;
    mState.viewerStackMember = null;

    document.querySelectorAll('.m-card.is-inspected').forEach((el) => el.classList.remove('is-inspected'));
    if (photo) {
      const cardEl = document.querySelector(`.m-card[data-id="${photo.id}"]`);
      if (cardEl) cardEl.classList.add('is-inspected');
      const isStackPhoto = Number(photo.stack_count || 1) > 1;
      if (window.TetheractTouchUI && typeof window.TetheractTouchUI.setTargetPhotoState === 'function') {
        window.TetheractTouchUI.setTargetPhotoState({
          hasTarget: true,
          rating: Number(photo.rating || 0),
          canDuel: isStackPhoto,
        });
      } else if (window.TetheractTouchUI && typeof window.TetheractTouchUI.setActiveRating === 'function') {
        window.TetheractTouchUI.setActiveRating(Number(photo.rating || 0));
      }
    }
    syncTabletInspectorCurrentPhoto();
  }

  function renderPhotoGrid() {
    const grid = document.getElementById('mPhotoGrid');
    const empty = document.getElementById('mEmptyState');
    if (!grid) return;

    grid.innerHTML = '';
    mState.renderedCount = 0;

    if (mState.photos.length === 0) {
      clearSingleSelection();
      if (mState.mode !== 'offline') {
        if (empty) empty.style.display = 'flex';
      }
      return;
    }
    if (empty) empty.style.display = 'none';

    updateMasonryRowHeight();
    appendNextGridChunk();

    // 以前ユーザーが明示的に選択していた写真があれば引き継ぐ（初期状態では自動選択せずフッターバーを隠す）
    let targetIdx = -1;
    if (mState.inspectedPhotoId != null) {
      targetIdx = mState.photos.findIndex((p) => p.id === mState.inspectedPhotoId);
    }
    if (targetIdx >= 0) {
      inspectPhotoAt(targetIdx);
    } else {
      clearSingleSelection();
    }
  }

  function appendNextGridChunk() {
    const grid = document.getElementById('mPhotoGrid');
    if (!grid || mState.renderedCount >= mState.photos.length) return;

    const end = Math.min(mState.renderedCount + GRID_CHUNK_SIZE, mState.photos.length);
    const frag = document.createDocumentFragment();

    for (let i = mState.renderedCount; i < end; i++) {
      const photo = mState.photos[i];
      frag.appendChild(createMobilePhotoCard(photo, i));
    }

    grid.appendChild(frag);
    mState.renderedCount = end;
  }

  function _parsePcConnectionSnapshot(rawJson) {
    if (!rawJson) return null;
    try {
      const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
      if (!data || !data.ok) return null;
      const mode = data.mode === 'online_ids' ? 'online_ids' : 'offline_ids';
      const idSet = new Set(Array.isArray(data.ids) ? data.ids.map((v) => Number(v)) : []);
      const onlineVolumes = new Set(
        Array.isArray(data.online_volumes)
          ? data.online_volumes.map((v) => String(v || '').toUpperCase()).filter(Boolean)
          : []
      );
      return {
        revision: String(data.revision || ''),
        mode,
        idSet,
        onlineVolumes,
        totalCount: Number(data.total_count || 0),
        onlineCount: Number(data.online_count || 0),
        offlineCount: Number(data.offline_count || 0),
      };
    } catch (e) {
      return null;
    }
  }

  function _syncPcConnectionSnapshotFromNative() {
    if (!window.TetheractNative || typeof window.TetheractNative.getPcConnectionStatusJson !== 'function') {
      return false;
    }
    const parsed = _parsePcConnectionSnapshot(window.TetheractNative.getPcConnectionStatusJson());
    const prevRev = mState.pcConnectionSnapshot ? mState.pcConnectionSnapshot.revision : '';
    const nextRev = parsed ? parsed.revision : '';
    mState.pcConnectionSnapshot = parsed;
    return prevRev !== nextRev;
  }

  async function _refreshServerConnectionStatus() {
    if (mState.mode !== 'server') return false;
    try {
      const res = await fetch('/api/mobile/connection-status', { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      const parsed = _parsePcConnectionSnapshot(data);
      if (!parsed) return false;
      const prevRev = mState.pcConnectionSnapshot ? mState.pcConnectionSnapshot.revision : '';
      mState.pcConnectionSnapshot = parsed;
      if (prevRev !== parsed.revision && window.__refreshMobileOfflineGridState) {
        window.__refreshMobileOfflineGridState();
      }
      return prevRev !== parsed.revision;
    } catch (e) {
      return false;
    }
  }

  function _isPhotoOnlineInPcSnapshot(photo, snap) {
    if (!photo || !snap) return null;
    const pid = Number(photo.id || 0);
    if (pid <= 0) return null;
    if (snap.mode === 'offline_ids') return !snap.idSet.has(pid);
    if (snap.mode === 'online_ids') return snap.idSet.has(pid);
    return null;
  }

  function isMobilePhotoOriginalOnline(photo) {
    if (!photo) return false;
    const isPhoneLocal =
      Boolean(photo.is_phone_local) ||
      Number(photo.id) >= 900000000 ||
      photo.volume_serial === 'ANDROID_LOCAL';
    if (isPhoneLocal) return true;
    if (mState.mode === 'server') {
      const snapOnline = _isPhotoOnlineInPcSnapshot(photo, mState.pcConnectionSnapshot);
      if (snapOnline !== null) return snapOnline;
      return !Boolean(photo.is_offline);
    }
    if (mState.mode === 'localdb') {
      if (mState.nativeLinkState.usbConnected) {
        const usbVsn = String(mState.nativeLinkState.usbVsn || '').trim().toUpperCase();
        const photoVsn = String(photo.volume_serial || '').trim().toUpperCase();
        if (!usbVsn || !photoVsn || usbVsn === photoVsn) {
          return true;
        }
      }
      if (mState.nativeLinkState.isPcLinked) {
        const snapOnline = _isPhotoOnlineInPcSnapshot(photo, mState.pcConnectionSnapshot);
        if (snapOnline !== null) return snapOnline;
        return true;
      }
      return false;
    }
    return false;
  }

  window.__refreshMobileOfflineGridState = function (linkState) {
    if (linkState && typeof linkState === 'object') {
      mState.nativeLinkState = {
        isPcLinked: Boolean(linkState.isPcLinked),
        usbConnected: Boolean(linkState.usbConnected),
        usbVsn: String(linkState.usbVsn || '').toUpperCase(),
      };
      if (!mState.nativeLinkState.isPcLinked) {
        mState.pcConnectionSnapshot = null;
      } else {
        const curRev = mState.pcConnectionSnapshot ? mState.pcConnectionSnapshot.revision : '';
        if (!curRev || (typeof linkState.pcConnRevision === 'string' && linkState.pcConnRevision !== curRev)) {
          _syncPcConnectionSnapshotFromNative();
        }
      }
    }
    const grid = document.getElementById('mPhotoGrid');
    if (grid) {
      const photoById = new Map(mState.photos.map((p) => [String(p.id), p]));
      const fallbackOnline = Boolean(mState.nativeLinkState.isPcLinked || mState.nativeLinkState.usbConnected);
      grid.querySelectorAll('.m-card').forEach((card) => {
        const photo = photoById.get(String(card.dataset.id || ''));
        if (photo) {
          card.classList.toggle('is-offline-cache', !isMobilePhotoOriginalOnline(photo));
        } else if (card.classList.contains('is-phone-local')) {
          card.classList.remove('is-offline-cache');
        } else if (mState.mode === 'localdb') {
          card.classList.toggle('is-offline-cache', !fallbackOnline);
        }
      });
    }
    if (mState.viewerOpen) {
      const activePhoto = getActiveViewerPhoto();
      const imgEl = document.getElementById('mViewerImg');
      const srcBadge = document.getElementById('mViewerSourceBadge');
      if (activePhoto) {
        const online = isMobilePhotoOriginalOnline(activePhoto);
        if (online && imgEl && imgEl.dataset.hdLoaded !== '1') {
          renderViewerCurrentPhoto();
        } else if (!online && srcBadge && !srcBadge.classList.contains('is-hd')) {
          srcBadge.textContent =
            mState.mode === 'server' || mState.nativeLinkState.isPcLinked || mState.nativeLinkState.usbConnected
              ? 'サムネイル (母艦未接続)'
              : 'サムネイル';
        }
      }
    }
  };

  function createMobilePhotoCard(photo, index) {
    const card = document.createElement('div');
    card.className = 'm-card';
    const isPhoneLocal =
      Boolean(photo.is_phone_local) ||
      Number(photo.id) >= 900000000 ||
      photo.volume_serial === 'ANDROID_LOCAL';
    const isOnline = isMobilePhotoOriginalOnline(photo);
    if (isPhoneLocal) card.classList.add('is-phone-local');
    if (!isOnline) card.classList.add('is-offline-cache');
    if (photo.rating === -1) card.classList.add('is-discarded');
    if (mState.selectedIds.has(photo.id)) card.classList.add('selected');
    if (mState.inspectedPhotoId === photo.id) card.classList.add('is-inspected');
    card.dataset.id = String(photo.id);
    card.dataset.index = String(index);

    const thumbUrl = getMobileThumbnailUrl(photo);
    const rateBadgeHtml = getRateBadgeHtml(photo.rating);

    let ratio = 1.333;
    if (photo._realAspect > 0) {
      ratio = photo._realAspect;
    } else if (Number(photo.thumb_width) > 0 && Number(photo.thumb_height) > 0) {
      ratio = Number(photo.thumb_width) / Number(photo.thumb_height);
    } else {
      const rawW = Number(photo.width || 0);
      const rawH = Number(photo.height || 0);
      const rot = ((Number(photo.rotation || 0) % 360) + 360) % 360;
      let effW = rot === 90 || rot === 270 ? rawH : rawW;
      let effH = rot === 90 || rot === 270 ? rawW : rawH;
      if (effW > 0 && effH > 0 && Number(photo.crop_w) > 0 && Number(photo.crop_h) > 0) {
        effW *= Number(photo.crop_w);
        effH *= Number(photo.crop_h);
      }
      if (effW > 0 && effH > 0) {
        ratio = effW / effH;
      }
    }
    ratio = Math.max(0.35, Math.min(3.2, ratio));
    const ratioStr = ratio.toFixed(4);
    card.style.setProperty('--card-aspect', ratioStr);
    card.style.setProperty('--card-grow', ratioStr);

    const topBadges = [];
    if (isPhoneLocal) {
      topBadges.push(`<span class="m-mini-badge phone-badge" title="スマホ機内の原本写真">📱</span>`);
    }
    if (photo.stack_count && photo.stack_count > 1) {
      topBadges.push(`<span class="m-mini-badge stack-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:2px;"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/></svg>${photo.stack_count}</span>`);
    }
    if (photo.is_raw || photo.paired_raw_path) {
      topBadges.push(`<span class="m-mini-badge">RAW</span>`);
    }

    card.innerHTML = `
      <img src="${_escAttr(thumbUrl)}" alt="${_escAttr(photo.file_name)}" loading="lazy" decoding="async">
      <div class="m-card-check">✓</div>
      <div class="m-card-top-badges">${topBadges.join('')}</div>
      <span class="m-card-offline-dot" title="DBサムネイルのみ（未接続）"></span>
      ${rateBadgeHtml}
      <div class="m-card-mount-caption">${_escHtml(photo.file_name || '')}</div>
    `;

    // 実デコード済みサムネイル寸法 (Exif回転・クロップ反映済み) から正確な縦横比を自動補正
    const imgEl = card.querySelector('img');
    if (imgEl) {
      imgEl.dataset.unbakedSource = _isPhoneUnbakedPhoto(photo) ? '1' : '0';
      window.TetheractTouchUI?.applyPhotoCssAdjustmentsToElement?.(imgEl, photo);
      const syncNaturalAspect = () => {
        if (!imgEl.naturalWidth || !imgEl.naturalHeight) return;
        const realRatio = Math.max(0.35, Math.min(3.2, imgEl.naturalWidth / imgEl.naturalHeight));
        photo._realAspect = realRatio;
        const rStr = realRatio.toFixed(4);
        card.style.setProperty('--card-aspect', rStr);
        card.style.setProperty('--card-grow', rStr);
      };
      if (imgEl.complete && imgEl.naturalWidth > 0) {
        syncNaturalAspect();
      } else {
        imgEl.addEventListener('load', syncNaturalAspect, { once: true });
      }
    }

    card.addEventListener('click', () => {
      if (window.__tetheractJustPinchedUntil && Date.now() < window.__tetheractJustPinchedUntil) {
        return;
      }
      if (window.__tetheractJustDragSelectedUntil && Date.now() < window.__tetheractJustDragSelectedUntil) {
        return;
      }
      if (mState.artFramerPickMode) {
        setArtFramerPickMode(false);
        window.TetheractTouchUI?.artFramer?.open?.([photo.id]);
        return;
      }
      if (mState.selectMode || document.body.classList.contains('m-select-mode')) {
        if (!mState.selectMode) {
          mState.selectMode = true;
          document.body.classList.add('m-select-mode');
          document.getElementById('mSelectModeBtn')?.classList.add('active');
        }
        toggleSelectPhoto(photo.id, card);
        if (isTabletMode() && mState.selectMode) {
          inspectPhotoAt(index);
        }
        return;
      }
      if (isTabletMode()) {
        // タブレットモード: シングルタップで右インスペクタ選択、ダブルタップ(320ms以内)で拡大ビューアを開く
        const now = Date.now();
        if (mState.lastCardTapId === photo.id && now - mState.lastCardTapTime < 320) {
          mState.lastCardTapId = null;
          mState.lastCardTapTime = 0;
          openViewerAt(index);
          return;
        }
        mState.lastCardTapId = photo.id;
        mState.lastCardTapTime = now;
        inspectPhotoAt(index);
      } else {
        openViewerAt(index);
      }
    });

    return card;
  }

  function getRateBadgeHtml(rating) {
    const r = Number(rating || 0);
    if (r === 2) return '<span class="m-card-badge-rate rate-2">優</span>';
    if (r === 1) return '<span class="m-card-badge-rate rate-1">良</span>';
    if (r === -1) return '<span class="m-card-badge-rate rate-neg1">棄</span>';
    return '';
  }

  function updateCardRateBadgeInDom(photoId, newRating) {
    const card = document.querySelector(`.m-card[data-id="${photoId}"]`);
    if (!card) return;
    card.classList.toggle('is-discarded', Number(newRating) === -1);
    const oldBadge = card.querySelector('.m-card-badge-rate');
    if (oldBadge) oldBadge.remove();
    const html = getRateBadgeHtml(newRating);
    if (html) {
      card.insertAdjacentHTML('beforeend', html);
    }
  }

  function updateHeaderCounters() {
    const el = document.getElementById('mPhotoCount');
    if (el) {
      el.textContent = `${mState.photos.length.toLocaleString()}枚`;
    }
  }

  function updateMasonryRowHeight() {
    const grid = document.getElementById('mPhotoGrid');
    if (!grid) return;
    const scrollEl = document.getElementById('mScrollContainer');
    const availW =
      (grid.clientWidth > 40
        ? grid.clientWidth
        : scrollEl && scrollEl.clientWidth > 40
        ? scrollEl.clientWidth - 8
        : window.innerWidth) || 360;
    const scrollH = (scrollEl && scrollEl.clientHeight > 80 ? scrollEl.clientHeight : window.innerHeight) || 640;
    const cols = Math.max(1, Number(mState.gridCols || 3));
    const maxRowH = Math.max(96, Math.round(scrollH * 0.68));
    const rowH = Math.max(64, Math.min(maxRowH, Math.round(availW / (cols * 1.25))));
    grid.style.setProperty('--masonry-row-height', `${rowH}px`);
  }

  function updateGridColsUI() {
    const grid = document.getElementById('mPhotoGrid');
    const btn = document.getElementById('mGridColsBtn');
    if (grid) {
      grid.classList.remove('cols-1', 'cols-2', 'cols-3', 'cols-4', 'cols-5', 'cols-6');
      grid.classList.add(`cols-${mState.gridCols}`);
    }
    if (btn) {
      btn.textContent = `⊞ ${mState.gridCols}列`;
    }
    updateMasonryRowHeight();
  }

  function updateGridLayoutUI() {
    const grid = document.getElementById('mPhotoGrid');
    const btn = document.getElementById('mGridLayoutBtn');
    const layout = mState.gridLayout || 'grid';
    if (grid) {
      grid.classList.remove('layout-grid', 'layout-masonry', 'layout-mount');
      grid.classList.add(`layout-${layout}`);
    }
    if (btn) {
      const labels = {
        grid: '⊞ 標準',
        masonry: '▤ びっしり',
        mount: '▣ マウント',
      };
      btn.textContent = labels[layout] || '⊞ 標準';
      btn.classList.toggle('active', layout !== 'grid');
    }
    updateMasonryRowHeight();
  }

  function stepMobileGridCols(deltaCols, midX, midY) {
    const minCols = 2;
    const maxCols = isTabletMode() ? 6 : 5;
    const nextCols = Math.max(minCols, Math.min(maxCols, Number(mState.gridCols || 3) + Number(deltaCols || 0)));
    if (nextCols === mState.gridCols) return;

    const scrollContainer = document.getElementById('mScrollContainer');
    let anchorCard = null;
    let prevTop = 0;
    if (scrollContainer && typeof midX === 'number' && typeof midY === 'number') {
      const hit = document.elementFromPoint(midX, midY);
      anchorCard = hit ? hit.closest('.m-card') : null;
      if (anchorCard) {
        prevTop = anchorCard.getBoundingClientRect().top;
      }
    }

    mState.gridCols = nextCols;
    _safeSetStorage('pm_mobile_cols', String(mState.gridCols));
    updateGridColsUI();

    if (scrollContainer && anchorCard) {
      const newTop = anchorCard.getBoundingClientRect().top;
      scrollContainer.scrollTop += newTop - prevTop;
    }
    if (
      scrollContainer &&
      scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 900
    ) {
      appendNextGridChunk();
    }
    if (navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch (e) {}
    }
    showToast(`グリッド: ${nextCols}列`, 1000);
  }

  // ==================== フィルタドロワー & アクティブチップ描画 ====================

  /**
   * フィルタ項目リスト（ドロワー内およびタブレット/スマホのPerspectiveステージへ複製されたDOM）にタップイベントをバインドする
   */
  /**
   * 指定した年月 (YYYY-MM) の日別写真枚数マップ (dayInt -> count) を取得する（キャッシュ付き）
   */
  function getMonthDayCountsMap(ym) {
    if (!ym || ym.length < 7) return new Map();
    if (mState.monthDayCountsCache.has(ym)) {
      return mState.monthDayCountsCache.get(ym);
    }
    const dayMap = new Map();
    if (mState.mode === 'localdb' && mState.localDb) {
      const rows = queryLocalDbObjects(
        `SELECT SUBSTR(REPLACE(date_taken, ':', '-'), 1, 10) AS ymd, COUNT(*) AS cnt FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND ${SQL_NOT_PAIRED_RAW} AND year_month = ? GROUP BY ymd`,
        [ym]
      );
      for (const r of rows) {
        const ymd = String(r.ymd || '');
        const dNum = Number(ymd.slice(8, 10));
        if (dNum >= 1 && dNum <= 31) {
          dayMap.set(dNum, (dayMap.get(dNum) || 0) + Number(r.cnt || 0));
        }
      }
    } else {
      for (const p of mState.photos) {
        const dt = String(p.date_taken || '').replace(/:/g, '-');
        if (dt.startsWith(ym)) {
          const dNum = Number(dt.slice(8, 10));
          if (dNum >= 1 && dNum <= 31) {
            dayMap.set(dNum, (dayMap.get(dNum) || 0) + 1);
          }
        }
      }
    }
    mState.monthDayCountsCache.set(ym, dayMap);
    return dayMap;
  }

  /**
   * 指定した年月 (YYYY-MM) の7列ミニカレンダーHTMLを生成する
   */
  function buildMiniCalendarHtml(ym) {
    const parts = String(ym || '').split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    if (!year || !month || month < 1 || month > 12) return '';

    const dayCounts = getMonthDayCountsMap(ym);
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    let cellsHtml = '';
    for (let i = 0; i < firstWeekday; i++) {
      cellsHtml += '<div class="m-mini-cal-cell"></div>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dd = String(d).padStart(2, '0');
      const fullDate = `${ym}-${dd}`;
      const cnt = dayCounts.get(d) || 0;
      const isAct = mState.dateDay === fullDate;
      if (cnt > 0) {
        cellsHtml += `
          <div class="m-mini-cal-cell has-photos ${isAct ? 'active-day' : ''}" data-cal-day="${_escAttr(fullDate)}" data-cal-ym="${_escAttr(ym)}">
            <span>${d}</span>
            <span class="m-mini-cal-cnt">${cnt}</span>
          </div>
        `;
      } else {
        cellsHtml += `<div class="m-mini-cal-cell"><span>${d}</span></div>`;
      }
    }

    const clearDayBtn = mState.dateDay && mState.dateDay.startsWith(ym)
      ? `<button type="button" class="m-tree-tool-btn" data-clear-cal-day="${_escAttr(ym)}">日指定解除</button>`
      : '';

    return `
      <div class="m-mini-cal-wrap">
        <div class="m-mini-cal-title">
          <span>📅 ${year}年${month}月 カレンダー</span>
          ${clearDayBtn}
        </div>
        <div class="m-mini-cal-weekdays">
          <span>日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span>
        </div>
        <div class="m-mini-cal-grid">${cellsHtml}</div>
      </div>
    `;
  }

  /**
   * フィルタ項目リスト（ドロワー内およびタブレット/スマホのPerspectiveステージへ複製されたDOM）にタップ＆ツリー開閉イベントをバインドする
   */
  function bindFilterListEvents(rootEl) {
    if (!rootEl) return;

    // 1. ツリー展開/折りたたみボタン (▶ / ▼)
    rootEl.querySelectorAll('[data-tree-toggle]').forEach((btn) => {
      if (btn._toggleBound) return;
      btn._toggleBound = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.getAttribute('data-tree-toggle') || '';
        if (!key) return;
        if (mState.expandedFilterNodes.has(key)) {
          mState.expandedFilterNodes.delete(key);
        } else {
          mState.expandedFilterNodes.add(key);
        }
        renderDrawerFilters();
      });
    });

    // 2. タグ種別切替 (手動 / AI / すべて) ＆ タグツリー全展開 / 全折りたたみツールボタン
    rootEl.querySelectorAll('[data-tag-source]').forEach((btn) => {
      if (btn._srcBound) return;
      btn._srcBound = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        mState.tagSourceFilter = btn.getAttribute('data-tag-source') || 'manual';
        _safeSetStorage('pm_mobile_tag_source', mState.tagSourceFilter);
        renderDrawerFilters();
      });
    });

    rootEl.querySelectorAll('[data-tree-action]').forEach((btn) => {
      if (btn._actionBound) return;
      btn._actionBound = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.getAttribute('data-tree-action');
        if (act === 'expand-all-tags') {
          for (const item of mState.availableTags) {
            const parts = String(item.tag || '').split('/').filter(Boolean);
            let cur = '';
            for (let i = 0; i < parts.length - 1; i++) {
              cur = cur ? `${cur}/${parts[i]}` : parts[i];
              mState.expandedFilterNodes.add(`tag:${cur}`);
            }
          }
        } else if (act === 'collapse-all-tags') {
          for (const k of Array.from(mState.expandedFilterNodes)) {
            if (k.startsWith('tag:')) mState.expandedFilterNodes.delete(k);
          }
        }
        renderDrawerFilters();
      });
    });

    // 3. ミニカレンダーの日付セルタップ
    rootEl.querySelectorAll('[data-cal-day]').forEach((cell) => {
      if (cell._calBound) return;
      cell._calBound = true;
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const fullDate = cell.getAttribute('data-cal-day') || '';
        const ym = cell.getAttribute('data-cal-ym') || '';
        if (mState.dateDay === fullDate) {
          mState.dateDay = '';
        } else {
          mState.dateDay = fullDate;
          if (ym) mState.yearMonth = ym;
        }
        renderDrawerFilters();
        fetchPhotosData();
      });
    });

    rootEl.querySelectorAll('[data-clear-cal-day]').forEach((btn) => {
      if (btn._clearCalBound) return;
      btn._clearCalBound = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        mState.dateDay = '';
        renderDrawerFilters();
        fetchPhotosData();
      });
    });

    // 4. 各フィルタ行 (.m-filter-item) のタップ
    rootEl.querySelectorAll('.m-filter-item').forEach((el) => {
      if (el._filterBound) return;
      el._filterBound = true;
      el.addEventListener('click', () => {
        if (el.dataset.justSwiped === '1') return;
        if (el.dataset.untagged === '1') {
          mState.untaggedOnly = !mState.untaggedOnly;
          if (mState.untaggedOnly) {
            mState.includeTags = [];
            mState.excludeTags = [];
          }
          renderDrawerFilters();
          fetchPhotosData();
          return;
        }
        if (el.dataset.tag != null) {
          const tag = el.dataset.tag;
          mState.untaggedOnly = false;
          if (mState.includeTags.includes(tag)) {
            mState.includeTags = mState.includeTags.filter((x) => x !== tag);
            mState.excludeTags.push(tag);
          } else if (mState.excludeTags.includes(tag)) {
            mState.excludeTags = mState.excludeTags.filter((x) => x !== tag);
          } else {
            mState.includeTags.push(tag);
            mState.expandedFilterNodes.add(`tag:${tag}`);
          }
          renderDrawerFilters();
          fetchPhotosData();
          return;
        }
        if (el.dataset.ym != null) {
          const ym = el.dataset.ym;
          mState.dateDay = '';
          if (mState.yearMonth === ym) {
            mState.yearMonth = '';
          } else {
            mState.yearMonth = ym;
            if (ym.length === 4) {
              mState.expandedFilterNodes.add(`ym:${ym}`);
            } else if (ym.length >= 7) {
              mState.expandedFilterNodes.add(`ym:${ym.slice(0, 4)}`);
              mState.expandedFilterNodes.add(`cal:${ym}`);
            }
          }
          renderDrawerFilters();
          fetchPhotosData();
          return;
        }
        if (el.dataset.noloc === '1') {
          mState.noLocationOnly = !mState.noLocationOnly;
          mState.country = '';
          mState.stateName = '';
          mState.city = '';
          renderDrawerFilters();
          fetchPhotosData();
          return;
        }
        if (el.dataset.country != null) {
          mState.noLocationOnly = false;
          const c = el.dataset.country || '';
          const s = el.dataset.state || '';
          const city = el.dataset.city || '';
          if (mState.country === c && mState.stateName === s && mState.city === city) {
            mState.country = '';
            mState.stateName = '';
            mState.city = '';
          } else {
            mState.country = c;
            mState.stateName = s;
            mState.city = city;
            if (c && !s) mState.expandedFilterNodes.add(`loc:${c}`);
            if (c && s && !city) mState.expandedFilterNodes.add(`loc:${c}/${s}`);
          }
          renderDrawerFilters();
          fetchPhotosData();
          return;
        }
        if (el.dataset.cam != null) {
          const cm = el.dataset.cam || '';
          const lm = el.dataset.lens || '';
          if (mState.cameraModel === cm && mState.lensModel === lm) {
            mState.cameraModel = '';
            mState.lensModel = '';
          } else {
            mState.cameraModel = cm;
            mState.lensModel = lm;
            if (cm && !lm) mState.expandedFilterNodes.add(`cam:${cm}`);
          }
          renderDrawerFilters();
          fetchPhotosData();
        }
      });
    });
  }
  window.__bindClonedFilterEvents = bindFilterListEvents;

  function renderDrawerFilters() {
    const TB = window.TetheractCore && window.TetheractCore.TreeBuilder;

    // 1. タグ階層ツリー（手動 / AI / すべて 切替式）
    const tagContainer = document.getElementById('mTagFilterList');
    if (tagContainer) {
      const srcMode = mState.tagSourceFilter || 'manual';
      const filteredTags = TB && typeof TB.filterTagsBySource === 'function'
        ? TB.filterTagsBySource(mState.availableTags, srcMode)
        : mState.availableTags;
      let html = `
        <div class="m-tree-toolbar" style="justify-content:space-between;gap:6px;flex-wrap:wrap;">
          <div class="t-mode-switch-group" role="group" aria-label="タグ種別切替">
            <button type="button" class="t-mode-switch-btn ${srcMode === 'manual' ? 'is-active' : ''}" data-tag-source="manual" data-no-dismiss="1">手動</button>
            <button type="button" class="t-mode-switch-btn ${srcMode === 'ai' ? 'is-active' : ''}" data-tag-source="ai" data-no-dismiss="1">AI</button>
            <button type="button" class="t-mode-switch-btn ${srcMode === 'all' ? 'is-active' : ''}" data-tag-source="all" data-no-dismiss="1">すべて</button>
          </div>
          <div style="display:inline-flex;gap:4px;">
            <button type="button" class="m-tree-tool-btn" data-tree-action="expand-all-tags" data-no-dismiss="1">すべて展開</button>
            <button type="button" class="m-tree-tool-btn" data-tree-action="collapse-all-tags" data-no-dismiss="1">折りたたむ</button>
          </div>
        </div>
        <div class="m-filter-item ${mState.untaggedOnly ? 'active-include' : ''}" data-untagged="1">
          <span class="m-filter-item-left"><span class="m-tree-toggle-spacer"></span><span class="m-filter-item-label">未分類の写真</span></span>
          <span class="m-filter-count">${mState.untaggedCount}</span>
        </div>
      `;
      const tagTree = TB && typeof TB.buildTagHierarchy === 'function'
        ? TB.buildTagHierarchy(filteredTags, { preAggregated: true })
        : [];

      const renderTagNodes = (nodes, depth) => {
        for (const node of nodes) {
          const t = node.fullPath;
          const hasChildren = Array.isArray(node.children) && node.children.length > 0;
          const toggleKey = `tag:${t}`;
          const isOpen = mState.expandedFilterNodes.has(toggleKey);
          const isInc = mState.includeTags.includes(t);
          const isExc = mState.excludeTags.includes(t);
          const cls = isInc ? 'active-include' : isExc ? 'active-exclude' : '';
          const prefix = isInc ? '✓ ' : isExc ? '− ' : '';
          const toggleHtml = hasChildren
            ? `<button type="button" class="m-tree-toggle-btn" data-tree-toggle="${_escAttr(toggleKey)}">${isOpen ? '▼' : '▶'}</button>`
            : '<span class="m-tree-toggle-spacer"></span>';
          const shortDisp = node.short_name ? `${_escHtml(node.short_name)} (${_escHtml(node.name)})` : _escHtml(node.name);
          html += `
            <div class="m-filter-item ${cls}" data-tag="${_escAttr(t)}">
              <span class="m-filter-item-left">
                ${toggleHtml}
                <span class="m-filter-item-label">${prefix}${shortDisp}</span>
              </span>
              <span class="m-filter-count">${node.count}</span>
            </div>
          `;
          if (hasChildren && isOpen) {
            html += '<div class="m-tree-sublist">';
            renderTagNodes(node.children, depth + 1);
            html += '</div>';
          }
        }
      };
      renderTagNodes(tagTree, 0);
      tagContainer.innerHTML = html;
      bindFilterListEvents(tagContainer);
    }

    // 2. タイムライン (年 > 月 > 7列ミニカレンダー)
    const tlContainer = document.getElementById('mTimelineFilterList');
    if (tlContainer) {
      const yearTree = TB && typeof TB.buildTimelineTree === 'function'
        ? TB.buildTimelineTree(mState.timelineList)
        : [];

      let html = '';
      for (const yNode of yearTree) {
        const yKey = `ym:${yNode.year}`;
        const isYOpen = mState.expandedFilterNodes.has(yKey);
        const isYAct = !mState.dateDay && mState.yearMonth === yNode.year ? 'active-include' : '';
        html += `
          <div class="m-filter-item ${isYAct}" data-ym="${_escAttr(yNode.year)}">
            <span class="m-filter-item-left">
              <button type="button" class="m-tree-toggle-btn" data-tree-toggle="${_escAttr(yKey)}">${isYOpen ? '▼' : '▶'}</button>
              <span class="m-filter-item-label">📅 ${_escHtml(yNode.year)}年</span>
            </span>
            <span class="m-filter-count">${yNode.count}</span>
          </div>
        `;
        if (isYOpen) {
          html += '<div class="m-tree-sublist">';
          for (const mNode of yNode.months || []) {
            const ym = mNode.ym;
            const calKey = `cal:${ym}`;
            const isCalOpen = mState.expandedFilterNodes.has(calKey);
            const isMAct = !mState.dateDay && mState.yearMonth === ym ? 'active-include' : '';
            html += `
              <div class="m-filter-item ${isMAct}" data-ym="${_escAttr(ym)}">
                <span class="m-filter-item-left">
                  <button type="button" class="m-tree-toggle-btn" data-tree-toggle="${_escAttr(calKey)}">${isCalOpen ? '▼' : '▶'}</button>
                  <span class="m-filter-item-label">${_escHtml( Number(mNode.month) + '月' )} (${_escHtml(ym)})</span>
                </span>
                <span class="m-filter-count">${mNode.count}</span>
              </div>
            `;
            if (isCalOpen) {
              html += buildMiniCalendarHtml(ym);
            }
          }
          html += '</div>';
        }
      }
      tlContainer.innerHTML = html || '<div class="m-center-sub">データなし</div>';
      bindFilterListEvents(tlContainer);
    }

    // 3. ジオタグ（国 > 都道府県 > 市区町村 3階層開閉ツリー）
    const locContainer = document.getElementById('mLocationFilterList');
    if (locContainer) {
      let html = `
        <div class="m-filter-item ${mState.noLocationOnly ? 'active-include' : ''}" data-noloc="1">
          <span class="m-filter-item-left"><span class="m-tree-toggle-spacer"></span><span class="m-filter-item-label">ジオタグなし</span></span>
          <span class="m-filter-count">${mState.noLocationCount}</span>
        </div>
      `;
      for (const c of mState.locationTree) {
        const states = c.states || [];
        const hasStates = states.length > 0;
        const cKey = `loc:${c.country}`;
        const isCOpen = mState.expandedFilterNodes.has(cKey);
        const cActive =
          !mState.noLocationOnly && mState.country === c.country && !mState.stateName && !mState.city
            ? 'active-include'
            : '';
        const cToggle = hasStates
          ? `<button type="button" class="m-tree-toggle-btn" data-tree-toggle="${_escAttr(cKey)}">${isCOpen ? '▼' : '▶'}</button>`
          : '<span class="m-tree-toggle-spacer"></span>';
        html += `
          <div class="m-filter-item ${cActive}" data-country="${_escAttr(c.country)}">
            <span class="m-filter-item-left">
              ${cToggle}
              <span class="m-filter-item-label">🌏 ${_escHtml(c.country)}</span>
            </span>
            <span class="m-filter-count">${c.count}</span>
          </div>
        `;
        if (hasStates && isCOpen) {
          html += '<div class="m-tree-sublist">';
          for (const s of states) {
            const cities = s.cities || [];
            const hasCities = cities.length > 0;
            const sKey = `loc:${c.country}/${s.state}`;
            const isSOpen = mState.expandedFilterNodes.has(sKey);
            const sActive =
              !mState.noLocationOnly &&
              mState.country === c.country &&
              mState.stateName === s.state &&
              !mState.city
                ? 'active-include'
                : '';
            const sToggle = hasCities
              ? `<button type="button" class="m-tree-toggle-btn" data-tree-toggle="${_escAttr(sKey)}">${isSOpen ? '▼' : '▶'}</button>`
              : '<span class="m-tree-toggle-spacer"></span>';
            html += `
              <div class="m-filter-item ${sActive}" data-country="${_escAttr(c.country)}" data-state="${_escAttr(s.state)}">
                <span class="m-filter-item-left">
                  ${sToggle}
                  <span class="m-filter-item-label">${_escHtml(s.state)}</span>
                </span>
                <span class="m-filter-count">${s.count}</span>
              </div>
            `;
            if (hasCities && isSOpen) {
              html += '<div class="m-tree-sublist">';
              for (const cityObj of cities) {
                const cityActive =
                  !mState.noLocationOnly &&
                  mState.country === c.country &&
                  mState.stateName === s.state &&
                  mState.city === cityObj.city
                    ? 'active-include'
                    : '';
                html += `
                  <div class="m-filter-item ${cityActive}" data-country="${_escAttr(c.country)}" data-state="${_escAttr(s.state)}" data-city="${_escAttr(cityObj.city)}">
                    <span class="m-filter-item-left">
                      <span class="m-tree-toggle-spacer"></span>
                      <span class="m-filter-item-label">📍 ${_escHtml(cityObj.city)}</span>
                    </span>
                    <span class="m-filter-count">${cityObj.count}</span>
                  </div>
                `;
              }
              html += '</div>';
            }
          }
          html += '</div>';
        }
      }
      locContainer.innerHTML = html;
      bindFilterListEvents(locContainer);
    }

    // 4. カメラ機種 > レンズ 2階層ツリー
    const camContainer = document.getElementById('mCameraFilterList');
    if (camContainer) {
      const gearSource = Array.isArray(mState.gearList) && mState.gearList.length > 0 ? mState.gearList : mState.cameraList;
      const gearTree = TB && typeof TB.buildGearTree === 'function'
        ? TB.buildGearTree(gearSource, { sortByCount: true })
        : mState.cameraList.map((c) => ({ camera: c.camera_model, count: c.count, lenses: [] }));
      let html = '';
      for (const gNode of gearTree) {
        const cm = gNode.camera;
        const lenses = gNode.lenses || [];
        const hasLenses = lenses.length > 0;
        const camKey = `cam:${cm}`;
        const isCOpen = mState.expandedFilterNodes.has(camKey);
        const active = mState.cameraModel === cm && !mState.lensModel ? 'active-include' : '';
        const cToggle = hasLenses
          ? `<button type="button" class="m-tree-toggle-btn" data-tree-toggle="${_escAttr(camKey)}">${isCOpen ? '▼' : '▶'}</button>`
          : '<span class="m-tree-toggle-spacer"></span>';
        html += `
          <div class="m-filter-item ${active}" data-cam="${_escAttr(cm)}">
            <span class="m-filter-item-left">
              ${cToggle}
              <span class="m-filter-item-label">📷 ${_escHtml(cm)}</span>
            </span>
            <span class="m-filter-count">${gNode.count}</span>
          </div>
        `;
        if (hasLenses && isCOpen) {
          html += '<div class="m-tree-sublist">';
          for (const lObj of lenses) {
            const lAct = mState.cameraModel === cm && mState.lensModel === lObj.lens ? 'active-include' : '';
            html += `
              <div class="m-filter-item ${lAct}" data-cam="${_escAttr(cm)}" data-lens="${_escAttr(lObj.lens)}">
                <span class="m-filter-item-left">
                  <span class="m-tree-toggle-spacer"></span>
                  <span class="m-filter-item-label">◎ ${_escHtml(lObj.lens)}</span>
                </span>
                <span class="m-filter-count">${lObj.count}</span>
              </div>
            `;
          }
          html += '</div>';
        }
      }
      camContainer.innerHTML = html || '<div class="m-center-sub">データなし</div>';
      bindFilterListEvents(camContainer);
    }

    // タブレット左ステージ / スマホボトムシートが開いている場合は最新状態のリスト＆イベントへ再同期
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.refreshActivePerspective === 'function') {
      window.TetheractTouchUI.refreshActivePerspective();
    }
  }

  function renderActiveFilterChips() {
    const bar = document.getElementById('mActiveFiltersBar');
    const dot = document.getElementById('mFilterDot');
    if (!bar) return;

    const chips = [];
    if (mState.searchQuery) {
      chips.push({
        label: `"${mState.searchQuery}"`,
        clear: () => {
          mState.searchQuery = '';
          document.getElementById('mSearchInput').value = '';
        },
      });
    }
    if (mState.untaggedOnly) {
      chips.push({
        label: '未分類のみ',
        clear: () => {
          mState.untaggedOnly = false;
        },
      });
    }
    for (const t of mState.includeTags) {
      chips.push({
        label: `+#${t}`,
        clear: () => {
          mState.includeTags = mState.includeTags.filter((x) => x !== t);
        },
      });
    }
    for (const t of mState.excludeTags) {
      chips.push({
        label: `-#${t}`,
        exclude: true,
        clear: () => {
          mState.excludeTags = mState.excludeTags.filter((x) => x !== t);
        },
      });
    }
    if (mState.dateDay) {
      chips.push({
        label: `📅 ${mState.dateDay}`,
        clear: () => {
          mState.dateDay = '';
        },
      });
    } else if (mState.yearMonth) {
      chips.push({
        label: `📅 ${mState.yearMonth}`,
        clear: () => {
          mState.yearMonth = '';
        },
      });
    }
    if (mState.noLocationOnly) {
      chips.push({
        label: 'ジオタグなし',
        clear: () => {
          mState.noLocationOnly = false;
        },
      });
    } else if (mState.country) {
      const locLabel = [mState.country, mState.stateName, mState.city].filter(Boolean).join('/');
      chips.push({
        label: `${locLabel}`,
        clear: () => {
          mState.country = '';
          mState.stateName = '';
          mState.city = '';
        },
      });
    }
    if (mState.cameraModel) {
      const gearLabel = mState.lensModel ? `${mState.cameraModel} / ${mState.lensModel}` : mState.cameraModel;
      chips.push({
        label: gearLabel,
        clear: () => {
          mState.cameraModel = '';
          mState.lensModel = '';
        },
      });
    }
    if (mState.folderPath) {
      const fShort = mState.folderPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || mState.folderPath;
      chips.push({
        label: `📁 ${fShort}`,
        clear: () => {
          mState.folderPath = '';
        },
      });
    }

    if (dot) {
      dot.style.display = chips.length > 0 ? 'block' : 'none';
    }
    const bnavDot = document.getElementById('tBnavFilterDot');
    if (bnavDot) {
      bnavDot.style.display = chips.length > 0 ? 'block' : 'none';
    }

    if (chips.length === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }

    bar.style.display = 'flex';
    bar.innerHTML = chips
      .map(
        (c, idx) =>
          `<span class="m-filter-chip ${c.exclude ? 'exclude' : ''}" data-chip-idx="${idx}">${_escHtml(c.label)} ✕</span>`
      )
      .join('');

    bar.querySelectorAll('.m-filter-chip').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.chipIdx);
        if (chips[idx]) {
          chips[idx].clear();
          renderDrawerFilters();
          fetchPhotosData();
        }
      });
    });
  }

  function resetAllFilters() {
    mState.ratingFilter = 'default';
    mState.searchQuery = '';
    mState.includeTags = [];
    mState.excludeTags = [];
    mState.untaggedOnly = false;
    mState.yearMonth = '';
    mState.dateDay = '';
    mState.cameraModel = '';
    mState.lensModel = '';
    mState.folderPath = '';
    mState.country = '';
    mState.stateName = '';
    mState.city = '';
    mState.noLocationOnly = false;

    const sInput = document.getElementById('mSearchInput');
    if (sInput) sInput.value = '';
    document.querySelectorAll('.m-quick-scroll [data-rating]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.rating === 'default');
    });

    renderDrawerFilters();
    fetchPhotosData();
  }

  // ==================== 複数選択 & 一括操作 ====================

  function setArtFramerPickMode(enabled) {
    const next = Boolean(enabled);
    mState.artFramerPickMode = next;
    document.body.classList.toggle('is-af-pick-mode', next);
    document.querySelectorAll('#tPhoneBottomNav [data-bnav="artframer"], #tTabletRail [data-perspective-id="artframer"]').forEach((btn) => {
      btn.classList.toggle('is-active', next);
    });
  }

  function setSelectMode(enabled) {
    if (enabled && mState.artFramerPickMode) {
      setArtFramerPickMode(false);
    }
    mState.selectMode = enabled;
    document.body.classList.toggle('m-select-mode', enabled);
    document.getElementById('mSelectModeBtn')?.classList.toggle('active', enabled);
    const batchBar = document.getElementById('mBatchBar');
    if (batchBar) batchBar.style.display = 'none';
    if (!enabled) {
      mState.selectedIds.clear();
      document.querySelectorAll('.m-card.selected').forEach((el) => el.classList.remove('selected'));
    }
    updateBatchCountLabel();
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.updateSelectionCount === 'function') {
      window.TetheractTouchUI.updateSelectionCount(mState.selectedIds.size);
    }
    syncTabletInspectorCurrentPhoto();
  }

  function toggleSelectPhoto(photoId, cardEl) {
    const numId = Number(photoId);
    if (mState.selectedIds.has(numId)) {
      mState.selectedIds.delete(numId);
      if (cardEl) cardEl.classList.remove('selected');
    } else {
      mState.selectedIds.add(numId);
      if (cardEl) cardEl.classList.add('selected');
    }
    updateBatchCountLabel();
    if (mState.selectedIds.size === 0) {
      setSelectMode(false);
      return;
    }
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.updateSelectionCount === 'function') {
      window.TetheractTouchUI.updateSelectionCount(mState.selectedIds.size);
    }
    syncTabletInspectorCurrentPhoto();
  }

  function updateBatchCountLabel() {
    const lbl = document.getElementById('mBatchCountLabel');
    if (lbl) lbl.textContent = `${mState.selectedIds.size}枚選択中`;
  }

  async function applyBatchRating(newRating) {
    const ids = Array.from(mState.selectedIds);
    if (ids.length === 0) {
      showToast('写真を選択してください');
      return;
    }

    const r = Number(newRating);
    if (mState.mode === 'server') {
      try {
        const res = await fetch('/api/photos/batch-rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: ids, rating: r }),
        });
        if (!res.ok) throw new Error('一括評価失敗');
      } catch (e) {
        showToast('! サーバー更新エラー');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      if (_hasNativeJournal()) {
        const ok = await _saveNativeBatchChanges(ids, { rating: r });
        if (!ok) {
          showToast('! ロッカーDBの一括評価更新に失敗しました');
          return;
        }
      } else {
        mState.localDb.run('BEGIN TRANSACTION');
        try {
          for (const pid of ids) {
            mState.localDb.run('UPDATE photos SET rating = ? WHERE id = ?', [r, pid]);
            const pObj = mState.photos.find((p) => p.id === pid);
            if (pObj) {
              recordPendingChange(pObj, 'rating', r, { deferSave: true });
            }
          }
          mState.localDb.run('COMMIT');
          savePendingChangesToStorage();
        } catch (e) {
          console.error('[MobileDB] 一括評価更新エラー:', e);
          try {
            mState.localDb.run('ROLLBACK');
          } catch (re) {}
          showToast('! ローカルDBの更新に失敗しました');
          return;
        }
      }
    }

    // メモリ上の配列とDOMを更新
    for (const pid of ids) {
      const pObj = mState.photos.find((p) => p.id === pid);
      if (pObj) pObj.rating = r;
      updateCardRateBadgeInDom(pid, r);
    }

    const rateNames = { 2: '優', 1: '良', 0: '可', '-1': '棄' };
    showToast(`${ids.length}枚を「${rateNames[r]}」に設定しました`);
  }

  // ==================== フルスクリーン選別ビューア ====================

  function getActiveViewerPhoto() {
    if (mState.viewerStackMember) return ensureLocalPhotoDetails(mState.viewerStackMember);
    if (mState.viewerIndex >= 0 && mState.viewerIndex < mState.photos.length) {
      return ensureLocalPhotoDetails(mState.photos[mState.viewerIndex]);
    }
    if (mState.inspectedIndex >= 0 && mState.inspectedIndex < mState.photos.length) {
      return ensureLocalPhotoDetails(mState.photos[mState.inspectedIndex]);
    }
    return null;
  }

  function _getCardTransformRelativeToStage(photoId) {
    if (photoId == null) return null;
    const card = document.querySelector(`.m-card[data-id="${photoId}"]`);
    const stage = document.getElementById('mViewerStage');
    if (!card || !stage) return null;
    const cRect = card.getBoundingClientRect();
    const sRect = stage.getBoundingClientRect();
    if (!cRect.width || !sRect.width) return null;
    if (cRect.bottom < 0 || cRect.top > window.innerHeight) return null;
    const cCx = cRect.left + cRect.width / 2;
    const cCy = cRect.top + cRect.height / 2;
    const sCx = sRect.left + sRect.width / 2;
    const sCy = sRect.top + sRect.height / 2;
    const scale = Math.max(0.18, Math.min(0.85, cRect.width / sRect.width));
    return {
      dx: Math.round(cCx - sCx),
      dy: Math.round(cCy - sCy),
      scale,
    };
  }

  function openViewerAt(index) {
    if (index < 0 || index >= mState.photos.length) return;
    if (mState.artFramerPickMode) setArtFramerPickMode(false);
    const photo = mState.photos[index];
    mState.viewerIndex = index;
    mState.inspectedIndex = index;
    mState.inspectedPhotoId = photo ? photo.id : null;
    mState.viewerStackMember = null;
    mState.viewerOpen = true;

    const modal = document.getElementById('mViewerModal');
    const wrap = document.getElementById('mViewerImgWrapper');
    if (modal) {
      modal.classList.remove('is-dragging-dismiss');
      modal.style.backgroundColor = 'rgba(13, 15, 18, 1)';
      modal.style.display = 'flex';
    }
    renderViewerCurrentPhoto();
    syncTabletInspectorCurrentPhoto();

    const rel = photo ? _getCardTransformRelativeToStage(photo.id) : null;
    mState.zoomScale = 1;
    mState.panX = 0;
    mState.panY = 0;
    _updateViewerZoomHint();

    if (wrap && rel) {
      wrap.classList.remove('is-animating');
      wrap.style.opacity = '0.65';
      wrap.style.transform = `translate3d(${rel.dx}px, ${rel.dy}px, 0) scale(${rel.scale})`;
      requestAnimationFrame(() => {
        wrap.classList.add('is-animating');
        wrap.style.opacity = '1';
        wrap.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
      });
    } else {
      resetViewerZoom(false);
    }
  }

  function closeViewer(animateToGrid = true) {
    if (!mState.viewerOpen) return;
    window.__flushMobilePendingAdjustSave?.();
    window.TetheractTouchUI?.viewerLauncher?.close?.();
    mState.viewerOpen = false;
    const closingPhoto = mState.photos[mState.viewerIndex];
    mState.viewerStackMember = null;
    document.body.classList.remove('is-viewer-adjust-mode');
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.getThumbBarMode === 'function' && window.TetheractTouchUI.getThumbBarMode() === 'adjust') {
      window.TetheractTouchUI.setThumbBarMode('cull');
    }
    if (!isTabletMode()) {
      clearSingleSelection();
    }
    const modal = document.getElementById('mViewerModal');
    const wrap = document.getElementById('mViewerImgWrapper');
    if (!modal) return;
    modal.classList.remove('is-immersive');

    const rel = animateToGrid && closingPhoto ? _getCardTransformRelativeToStage(closingPhoto.id) : null;
    if (wrap && rel) {
      modal.classList.add('is-dragging-dismiss');
      modal.style.backgroundColor = 'rgba(13, 15, 18, 0)';
      wrap.classList.add('is-animating');
      wrap.style.opacity = '0.2';
      wrap.style.transform = `translate3d(${rel.dx}px, ${rel.dy}px, 0) scale(${rel.scale})`;
      setTimeout(() => {
        if (!mState.viewerOpen) {
          modal.style.display = 'none';
          modal.classList.remove('is-dragging-dismiss');
          modal.style.backgroundColor = 'rgba(13, 15, 18, 1)';
          wrap.classList.remove('is-animating');
          wrap.style.opacity = '1';
          wrap.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
        }
      }, 200);
    } else {
      modal.style.display = 'none';
      modal.classList.remove('is-dragging-dismiss');
      modal.style.backgroundColor = 'rgba(13, 15, 18, 1)';
      if (wrap) {
        wrap.classList.remove('is-animating');
        wrap.style.opacity = '1';
        wrap.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
      }
    }
  }

  function stepViewer(delta) {
    window.__flushMobilePendingAdjustSave?.();
    window.TetheractTouchUI?.viewerLauncher?.close?.();
    const nextIdx = mState.viewerIndex + delta;
    if (nextIdx < 0 || nextIdx >= mState.photos.length) {
      if (delta > 0) showToast('最後の写真です');
      return;
    }
    mState.viewerIndex = nextIdx;
    mState.inspectedIndex = nextIdx;
    mState.inspectedPhotoId = mState.photos[nextIdx] ? mState.photos[nextIdx].id : null;
    mState.viewerStackMember = null;
    mState.zoomScale = 1;
    mState.panX = 0;
    mState.panY = 0;
    _updateViewerZoomHint();

    // グリッド側も未描画領域に入ったらチャンクを追加しておく
    if (nextIdx >= mState.renderedCount - 15) {
      appendNextGridChunk();
    }
    renderViewerCurrentPhoto();
    inspectPhotoAt(nextIdx);

    const wrap = document.getElementById('mViewerImgWrapper');
    if (wrap) {
      const startOffset = delta > 0 ? 40 : -40;
      wrap.classList.remove('is-animating');
      wrap.style.opacity = '0.78';
      wrap.style.transform = `translate3d(${startOffset}px, 0px, 0) scale(1)`;
      requestAnimationFrame(() => {
        wrap.classList.add('is-animating');
        wrap.style.opacity = '1';
        wrap.style.transform = 'translate3d(0px, 0px, 0) scale(1)';
      });
    }
  }

  function renderViewerCurrentPhoto() {
    const primaryPhoto = ensureLocalPhotoDetails(mState.photos[mState.viewerIndex]);
    const activePhoto = getActiveViewerPhoto();
    if (!activePhoto || !primaryPhoto) return;

    document.getElementById('mViewerFileName').textContent = activePhoto.file_name || '';
    document.getElementById('mViewerCounter').textContent = `${mState.viewerIndex + 1} / ${mState.photos.length}`;

    const imgEl = document.getElementById('mViewerImg');
    const srcBadge = document.getElementById('mViewerSourceBadge');
    const thumbUrl = getMobileThumbnailUrl(activePhoto);
    const isPhotoOnline = isMobilePhotoOriginalOnline(activePhoto);
    activePhoto._loadedNaturalW = 0;
    activePhoto._loadedNaturalH = 0;
    const bakedSnap = _resolveBakedAdjustForPhoto(activePhoto);
    activePhoto._bakedAdjust = { ...bakedSnap };
    activePhoto._viewerLoadedBakedAdjust = { ...bakedSnap };
    if (imgEl) {
      imgEl.dataset.photoId = String(activePhoto.id);
      imgEl.dataset.unbakedSource = _isPhoneUnbakedPhoto(activePhoto) ? '1' : '0';
      imgEl.dataset.hdLoaded = '0';
      imgEl.src = thumbUrl;
    }
    if (srcBadge) {
      if (!isPhotoOnline && (mState.mode === 'server' || mState.nativeLinkState.isPcLinked || mState.nativeLinkState.usbConnected)) {
        srcBadge.textContent = 'サムネイル (母艦未接続)';
      } else {
        srcBadge.textContent = 'サムネイル';
      }
      srcBadge.classList.remove('is-hd');
      srcBadge.style.display = 'inline-block';
    }
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.loadPhotoAdjustValues === 'function') {
      window.TetheractTouchUI.loadPhotoAdjustValues(activePhoto);
    }
    _updateViewerZoomHint();
    applyViewerTransform(false);
    const hdUrl = isPhotoOnline ? getMobileFullPhotoUrl(activePhoto) : '';
    if (hdUrl && imgEl) {
      const targetId = String(activePhoto.id);
      const preloadImg = new Image();
      preloadImg.onload = () => {
        if (!mState.viewerOpen || imgEl.dataset.photoId !== targetId) return;
        if (preloadImg.naturalWidth > 420 || preloadImg.naturalHeight > 420) {
          activePhoto._loadedNaturalW = preloadImg.naturalWidth;
          activePhoto._loadedNaturalH = preloadImg.naturalHeight;
          const srcKind = window.TetheractNative?.getLastPhotoSource
            ? window.TetheractNative.getLastPhotoSource(Number(activePhoto.id))
            : '';
          imgEl.dataset.unbakedSource = (srcKind === 'usb' || srcKind === 'phone' || _isPhoneUnbakedPhoto(activePhoto)) ? '1' : '0';
          imgEl.dataset.hdLoaded = '1';
          activePhoto._viewerLoadedBakedAdjust = { ...(activePhoto._bakedAdjust || bakedSnap) };
          imgEl.src = hdUrl;
          if (srcBadge) {
            srcBadge.textContent = srcKind === 'phone' ? '📱 スマホ原本' : 'HD 実ファイル';
            srcBadge.classList.add('is-hd');
          }
          window.TetheractTouchUI?.loadPhotoAdjustValues?.(activePhoto);
          _updateViewerZoomHint();
          applyViewerTransform(false);
        }
      };
      preloadImg.src = hdUrl;
    }

    // 評価ボタンのアクティブ状態更新
    const currentRate = Number(activePhoto.rating || 0);
    document.querySelectorAll('[data-viewer-rate]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.viewerRate) === currentRate);
    });

    // 簡易Exif & タグ表示
    const exifParts = [];
    if (activePhoto.date_taken) exifParts.push(activePhoto.date_taken.slice(0, 16));
    if (activePhoto.camera_model) exifParts.push(activePhoto.camera_model);
    if (activePhoto.focal_length) exifParts.push(`${Math.round(activePhoto.focal_length)}mm`);
    if (activePhoto.f_number) exifParts.push(`F${activePhoto.f_number}`);
    if (activePhoto.shutter_speed) exifParts.push(`${activePhoto.shutter_speed}s`);
    if (activePhoto.iso) exifParts.push(`ISO${activePhoto.iso}`);
    const locStr = [activePhoto.country, activePhoto.state, activePhoto.city]
      .filter(Boolean)
      .join(' ');
    if (locStr) exifParts.push(locStr);

    document.getElementById('mViewerExifBrief').textContent =
      exifParts.join(' · ') || 'Exif情報なし';

    const tagsBrief = document.getElementById('mViewerTagsBrief');
    const tags = activePhoto.tags || [];
    if (tagsBrief) {
      if (tags.length > 0) {
        tagsBrief.innerHTML = tags
          .map((t) => `<span class="m-mini-tag">#${_escHtml(t)}</span>`)
          .join('');
      } else {
        tagsBrief.innerHTML = '<span style="font-size:11px; color:#687487;">タグ未設定</span>';
      }
    }

    // スタック（連写・ブラケット・RAW+JPG）内コマ比較バーの描画
    const stackBar = document.getElementById('mViewerStackBar');
    const stackList = document.getElementById('mViewerStackList');
    const members = primaryPhoto.stack_photos || [];
    if (stackBar && stackList) {
      if (members.length > 1) {
        stackBar.style.display = 'block';
        const isCurrentPrimary = activePhoto.id === primaryPhoto.id;
        const primaryActionHtml = isCurrentPrimary
          ? '<button type="button" class="m-stack-primary-btn is-current-primary" disabled>★ 表紙コマ</button>'
          : '<button type="button" class="m-stack-primary-btn" id="mSetStackPrimaryBtn">★ 表紙に設定</button>';

        stackList.innerHTML =
          members
            .map((m, idx) => {
              const isAct = m.id === activePhoto.id ? 'active' : '';
              const rIcon =
                m.rating === 2 ? '優' : m.rating === 1 ? '良' : m.rating === -1 ? '棄' : '';
              const pMark = m.id === primaryPhoto.id ? '★' : '';
              let label = `${pMark}#${idx + 1}`;
              if (primaryPhoto.stack_type === 'bracket' && m.exposure_bias != null) {
                const ev = Number(m.exposure_bias);
                label = `${pMark}${ev > 0 ? '+' : ''}${ev.toFixed(1)}EV`;
              } else if (m.is_raw) {
                label += ' RAW';
              }
              return `<button class="m-stack-pill ${isAct}" data-member-idx="${idx}">${_escHtml(label)} ${rIcon}</button>`;
            })
            .join('') + primaryActionHtml;

        stackList.querySelectorAll('.m-stack-pill').forEach((btn) => {
          btn.addEventListener('click', () => {
            const mIdx = Number(btn.dataset.memberIdx);
            if (members[mIdx]) {
              mState.viewerStackMember = members[mIdx];
              resetViewerZoom();
              renderViewerCurrentPhoto();
            }
          });
        });

        stackList.querySelector('#mSetStackPrimaryBtn')?.addEventListener('click', () => {
          setStackPrimaryPhoto(activePhoto);
        });
      } else {
        stackBar.style.display = 'none';
        stackList.innerHTML = '';
      }
    }
  }

  /**
   * スタック内の現在表示中コマを代表（表紙コマ）に設定し、一覧グリッドとDB/同期ジャーナルへ即時反映する
   */
  async function setStackPrimaryPhoto(memberPhoto) {
    const primaryPhoto = mState.photos[mState.viewerIndex];
    if (!primaryPhoto || !memberPhoto || memberPhoto.id === primaryPhoto.id) return;

    const oldPrimaryId = primaryPhoto.id;
    const newPrimaryId = memberPhoto.id;
    const oldStackId = Number(primaryPhoto.stack_id || oldPrimaryId);

    if (mState.mode === 'server') {
      try {
        const res = await fetch(`/api/photo/${newPrimaryId}/set-primary`, { method: 'POST' });
        if (!res.ok) throw new Error('スタック代表変更失敗');
      } catch (e) {
        showToast('! スタック代表の変更に失敗しました');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      try {
        mState.localDb.run(
          'UPDATE photos SET stack_id = ?, is_stack_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE stack_id = ?',
          [newPrimaryId, newPrimaryId, oldStackId]
        );
        recordPendingChange(memberPhoto, 'stack_primary', true);
      } catch (e) {
        console.error('ローカルDBスタック代表更新エラー:', e);
      }
    }

    const members = (primaryPhoto.stack_photos || []).map((m) => ({
      ...m,
      stack_id: newPrimaryId,
      is_stack_primary: m.id === newPrimaryId ? 1 : 0,
    }));
    const updatedPrimary = {
      ...memberPhoto,
      stack_id: newPrimaryId,
      is_stack_primary: 1,
      stack_count: members.length,
      stack_type: primaryPhoto.stack_type,
      stack_photos: members,
    };

    if (mState.stackCountsMap) {
      if (oldStackId !== newPrimaryId) mState.stackCountsMap.delete(oldStackId);
      mState.stackCountsMap.set(newPrimaryId, members.length);
    }

    mState.photos[mState.viewerIndex] = updatedPrimary;
    mState.inspectedPhotoId = newPrimaryId;
    mState.viewerStackMember = null;

    const oldCard = document.querySelector(`.m-card[data-id="${oldPrimaryId}"]`);
    if (oldCard) {
      const newCard = createMobilePhotoCard(updatedPrimary, mState.viewerIndex);
      oldCard.replaceWith(newCard);
    }

    renderViewerCurrentPhoto();
    syncTabletInspectorCurrentPhoto();
    showToast(`★ 「${memberPhoto.file_name || '#' + newPrimaryId}」をスタックの表紙に設定しました`);
  }

  /**
   * ビューア上で現在の写真に4段階評価を設定する
   */
  async function rateCurrentViewerPhoto(newRating) {
    const photo = getActiveViewerPhoto();
    if (!photo) return;
    const r = Number(newRating);

    if (mState.mode === 'server') {
      try {
        const res = await fetch(`/api/photo/${photo.id}/rate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: r }),
        });
        if (!res.ok) throw new Error('評価更新失敗');
      } catch (e) {
        showToast('! 評価の保存に失敗しました');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      try {
        mState.localDb.run('UPDATE photos SET rating = ? WHERE id = ?', [r, photo.id]);
        recordPendingChange(photo, 'rating', r);
      } catch (e) {
        console.error('ローカルDB評価更新エラー:', e);
      }
    }

    photo.rating = r;
    updateCardRateBadgeInDom(photo.id, r);
    renderViewerCurrentPhoto();
    if (window.TetheractTouchUI && typeof window.TetheractTouchUI.setActiveRating === 'function') {
      window.TetheractTouchUI.setActiveRating(r);
    }
    syncTabletInspectorCurrentPhoto();

    // ⚡ ビューア表示中かつ自動送りONの場合のみ次の写真へ自動進行
    if (mState.viewerOpen && mState.autoAdvance && mState.viewerIndex < mState.photos.length - 1) {
      setTimeout(() => {
        if (mState.viewerOpen) stepViewer(1);
      }, 160);
    }
  }

  // ==================== ビューアの2本指ピンチズーム・下スワイプクローズ・ダブルタップ拡大 ====================

  function _getViewerPhotoMetrics(stageEl) {
    const stage = stageEl || document.getElementById('mViewerStage');
    const imgEl = document.getElementById('mViewerImg');
    const photo = getActiveViewerPhoto();
    const sw = Math.max(120, (stage && stage.clientWidth) || window.innerWidth || 360);
    const sh = Math.max(120, (stage && stage.clientHeight) || (window.innerHeight - 160) || 480);
    let origW = Number(photo?._loadedNaturalW) || (imgEl && imgEl.naturalWidth > 420 ? imgEl.naturalWidth : 0);
    let origH = Number(photo?._loadedNaturalH) || (imgEl && imgEl.naturalHeight > 420 ? imgEl.naturalHeight : 0);
    if (origW <= 0 || origH <= 0) {
      let pw = Number(photo?.width) || (imgEl && imgEl.naturalWidth) || 1600;
      let ph = Number(photo?.height) || (imgEl && imgEl.naturalHeight) || 1200;
      if (Math.abs(Number(photo?.rotation || 0)) % 180 === 90) { const t = pw; pw = ph; ph = t; }
      const cw = Number(photo?.crop_w ?? 1), ch = Number(photo?.crop_h ?? 1);
      origW = Math.max(1, Math.round(pw * (cw > 0 && cw < 1 ? cw : 1)));
      origH = Math.max(1, Math.round(ph * (ch > 0 && ch < 1 ? ch : 1)));
    }
    const isCssRot90 = Boolean(imgEl && imgEl.dataset.unbakedSource === '1' && Math.abs(Number(photo?.rotation || 0)) % 180 === 90);
    const fitScale = isCssRot90 ? Math.min(sw / origH, sh / origW) : Math.min(sw / origW, sh / origH);
    const fitW = Math.max(1, origW * fitScale);
    const fitH = Math.max(1, origH * fitScale);
    const visW = isCssRot90 ? fitH : fitW;
    const visH = isCssRot90 ? fitW : fitH;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const fitRatio = Math.max(0.02, (fitScale * dpr));
    const oneToOneScale = fitRatio < 0.92 ? (1.0 / fitRatio) : (2.0 / fitRatio);
    const maxScale = Math.max(6, 3.0 / fitRatio);
    return { sw, sh, origW, origH, fitW, fitH, visW, visH, fitRatio, oneToOneScale, maxScale };
  }

  function _updateViewerZoomHint() {
    const m = _getViewerPhotoMetrics();
    const pct = Math.max(1, Math.round(m.fitRatio * (mState.zoomScale || 1) * 100));
    const isOneToOne = Math.abs(pct - 100) <= 2;
    const hint = document.getElementById('mViewerZoomHint');
    if (hint) {
      hint.textContent = mState.zoomScale > 1.03
        ? `${pct}% ${isOneToOne ? '(等倍 1:1)' : '拡大中'}`
        : `${pct}% (縮小フィット) · ダブルタップで等倍`;
    }
    const zoomBadge = document.getElementById('mViewerZoomBadge');
    if (zoomBadge) {
      zoomBadge.textContent = mState.zoomScale > 1.03
        ? `${pct}%${isOneToOne ? ' (等倍)' : ''} · タップで全体`
        : `${pct}% (FIT)`;
      zoomBadge.style.display = 'inline-flex';
    }
  }

  function _clampViewerPan(stageEl, scale, panX, panY) {
    if (scale <= 1.01) return { x: 0, y: 0 };
    const m = _getViewerPhotoMetrics(stageEl);
    const maxX = Math.max(0, (m.visW * scale - m.sw) / 2);
    const maxY = Math.max(0, (m.visH * scale - m.sh) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, panX)), y: Math.max(-maxY, Math.min(maxY, panY)) };
  }

  function resetViewerZoom(animate = true) {
    mState.zoomScale = 1;
    mState.panX = 0;
    mState.panY = 0;
    _updateViewerZoomHint();
    applyViewerTransform(animate);
  }

  function applyViewerTransform(animate = false) {
    const wrap = document.getElementById('mViewerImgWrapper');
    const photoFrame = document.getElementById('mViewerPhotoFrame');
    const imgEl = document.getElementById('mViewerImg');
    if (!wrap) return;
    const m = _getViewerPhotoMetrics();
    const z = Math.max(1, mState.zoomScale || 1);
    const wPx = `${Math.round(m.fitW * z)}px`;
    const hPx = `${Math.round(m.fitH * z)}px`;
    if (photoFrame) {
      photoFrame.style.width = wPx;
      photoFrame.style.height = hPx;
    }
    if (imgEl) {
      imgEl.style.width = wPx;
      imgEl.style.height = hPx;
    }
    wrap.classList.toggle('is-animating', Boolean(animate));
    wrap.style.opacity = '1';
    wrap.style.transform = `translate3d(${Math.round(mState.panX)}px, ${Math.round(mState.panY)}px, 0)`;
  }

  function setupViewerTouchGestures() {
    const stage = document.getElementById('mViewerStage');
    const modal = document.getElementById('mViewerModal');
    const wrap = document.getElementById('mViewerImgWrapper');
    if (!stage) return;

    let startX = 0;
    let startY = 0;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let lastTapTime = 0;
    let singleTapTimer = null;
    let isDragging = false;
    let isPinching = false;
    let isDismissDragging = false;
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let pinchStartMidX = 0;
    let pinchStartMidY = 0;
    let pinchStartPanX = 0;
    let pinchStartPanY = 0;

    function _getDist(t0, t1) {
      return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    }

    stage.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          isPinching = true;
          isDragging = false;
          isDismissDragging = false;
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          pinchStartDist = Math.max(20, _getDist(t0, t1));
          pinchStartScale = mState.zoomScale || 1;
          const sRect = stage.getBoundingClientRect();
          pinchStartMidX = (t0.clientX + t1.clientX) / 2 - (sRect.left + sRect.width / 2);
          pinchStartMidY = (t0.clientY + t1.clientY) / 2 - (sRect.top + sRect.height / 2);
          pinchStartPanX = mState.panX || 0;
          pinchStartPanY = mState.panY || 0;
          if (wrap) wrap.classList.remove('is-animating');
          return;
        }
        if (e.touches.length !== 1) return;
        if (
          window.TetheractTouchUI &&
          typeof window.TetheractTouchUI.getThumbBarMode === 'function' &&
          window.TetheractTouchUI.getThumbBarMode() === 'adjust'
        ) {
          isDragging = false;
          isDismissDragging = false;
          return;
        }
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        lastTouchX = startX;
        lastTouchY = startY;
        isDragging = true;
        isDismissDragging = false;
        if (wrap) wrap.classList.remove('is-animating');
      },
      { passive: true }
    );

    stage.addEventListener(
      'touchmove',
      (e) => {
        if (isPinching && e.touches.length === 2) {
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const dist = _getDist(t0, t1);
          const m = _getViewerPhotoMetrics(stage);
          const nextScale = Math.max(1, Math.min(m.maxScale, pinchStartScale * (dist / pinchStartDist)));
          const sRect = stage.getBoundingClientRect();
          const curMidX = (t0.clientX + t1.clientX) / 2 - (sRect.left + sRect.width / 2);
          const curMidY = (t0.clientY + t1.clientY) / 2 - (sRect.top + sRect.height / 2);
          const scaleRatio = nextScale / pinchStartScale;
          const rawPanX = curMidX - (pinchStartMidX - pinchStartPanX) * scaleRatio;
          const rawPanY = curMidY - (pinchStartMidY - pinchStartPanY) * scaleRatio;
          const clamped = _clampViewerPan(stage, nextScale, rawPanX, rawPanY);
          mState.zoomScale = nextScale;
          mState.panX = clamped.x;
          mState.panY = clamped.y;
          _updateViewerZoomHint();
          applyViewerTransform(false);
          return;
        }

        if (!isDragging || isPinching || e.touches.length !== 1) return;
        const curX = e.touches[0].clientX;
        const curY = e.touches[0].clientY;
        const totalDx = curX - startX;
        const totalDy = curY - startY;

        if (mState.zoomScale > 1.01) {
          const stepDx = curX - lastTouchX;
          const stepDy = curY - lastTouchY;
          lastTouchX = curX;
          lastTouchY = curY;
          const clamped = _clampViewerPan(stage, mState.zoomScale, mState.panX + stepDx, mState.panY + stepDy);
          mState.panX = clamped.x;
          mState.panY = clamped.y;
          applyViewerTransform(false);
          return;
        }

        // 等倍時に下方向へドラッグした際は「下スワイプで一覧へ戻る」物理追従モードを起動
        if (!isDismissDragging && totalDy > 14 && Math.abs(totalDy) > Math.abs(totalDx) * 1.2) {
          isDismissDragging = true;
          if (modal) modal.classList.add('is-dragging-dismiss');
        }
        if (isDismissDragging && wrap) {
          const dampY = Math.max(0, totalDy);
          const scale = Math.max(0.66, 1 - dampY / 680);
          const bgAlpha = Math.max(0.18, 1 - dampY / 340);
          if (modal) modal.style.backgroundColor = `rgba(13, 15, 18, ${bgAlpha.toFixed(2)})`;
          wrap.style.transform = `translate3d(${Math.round(totalDx * 0.35)}px, ${Math.round(dampY)}px, 0) scale(${scale.toFixed(3)})`;
        }
      },
      { passive: true }
    );

    stage.addEventListener('touchend', (e) => {
      if (isPinching) {
        if (e.touches.length === 0) {
          isPinching = false;
          if (mState.zoomScale < 1.06) {
            resetViewerZoom(true);
          }
        }
        return;
      }
      if (!isDragging) return;
      isDragging = false;

      const now = Date.now();
      const endTouch = e.changedTouches[0];
      const dx = endTouch ? endTouch.clientX - startX : 0;
      const dy = endTouch ? endTouch.clientY - startY : 0;

      if (isDismissDragging) {
        isDismissDragging = false;
        if (dy > 88) {
          closeViewer(true);
        } else {
          if (modal) {
            modal.classList.remove('is-dragging-dismiss');
            modal.style.backgroundColor = 'rgba(13, 15, 18, 1)';
          }
          resetViewerZoom(true);
        }
        return;
      }

      // ダブルタップ判定（全体フィット ⇄ 原本100%等倍）＆シングルタップで上下バー表示/非表示（没入モード）トグル
      if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
        if (now - lastTapTime < 260) {
          if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
          if (mState.zoomScale > 1.05) {
            resetViewerZoom(true);
          } else {
            const sRect = stage.getBoundingClientRect();
            const tapOffsetX = endTouch ? endTouch.clientX - (sRect.left + sRect.width / 2) : 0;
            const tapOffsetY = endTouch ? endTouch.clientY - (sRect.top + sRect.height / 2) : 0;
            const m = _getViewerPhotoMetrics(stage);
            const targetScale = m.oneToOneScale;
            const clamped = _clampViewerPan(stage, targetScale, -tapOffsetX * (targetScale - 1), -tapOffsetY * (targetScale - 1));
            mState.zoomScale = targetScale;
            mState.panX = clamped.x;
            mState.panY = clamped.y;
            _updateViewerZoomHint();
            applyViewerTransform(false);
          }
          lastTapTime = 0;
          return;
        }
        lastTapTime = now;
        if (singleTapTimer) clearTimeout(singleTapTimer);
        singleTapTimer = setTimeout(() => {
          singleTapTimer = null;
          if (modal && mState.viewerOpen) {
            modal.classList.toggle('is-immersive');
          }
        }, 260);
        return;
      }

      // 等倍時の上スワイプでタグ・Exif詳細シートを開く
      if (mState.zoomScale <= 1.02 && dy < -72 && Math.abs(dy) > Math.abs(dx) * 1.25) {
        openInfoSheet(false);
        return;
      }

      // 等倍時の左右スワイプで前後の写真へ移動
      if (mState.zoomScale <= 1.02 && Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        if (dx < 0) {
          stepViewer(1);
        } else {
          stepViewer(-1);
        }
      }
    });
  }

  // ==================== タグ編集 & Exif詳細ボトムシート ====================

  function openInfoSheet(isBatchMode = false) {
    const overlay = document.getElementById('mInfoSheetOverlay');
    const exifSec = document.getElementById('mExifSection');
    const titleEl = document.getElementById('mInfoSheetTitle');
    if (!overlay) return;

    if (isBatchMode) {
      if (titleEl) titleEl.textContent = `選択中の ${mState.selectedIds.size}枚 にタグ一括付与`;
      if (exifSec) exifSec.style.display = 'none';
      renderBatchTagSheet();
    } else {
      const photo = getActiveViewerPhoto();
      if (!photo) return;
      if (titleEl) titleEl.textContent = 'タグ編集 & Exif詳細';
      if (exifSec) exifSec.style.display = 'block';
      renderSinglePhotoInfoSheet(photo);
    }

    overlay.style.display = 'flex';
  }

  function closeInfoSheet() {
    const overlay = document.getElementById('mInfoSheetOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  /**
   * スラッシュ区切りのタグ一覧からスマホ用階層ツリーを構築する
   */
  function buildMobileTagTree(tagItems) {
    const root = { children: new Map(), count: 0 };
    (tagItems || []).forEach((item) => {
      const raw = String(item.tag || '').trim();
      if (!raw) return;
      const parts = raw.split('/').map((p) => p.trim()).filter(Boolean);
      let current = root;
      let currentPath = '';
      parts.forEach((part, idx) => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!current.children.has(part)) {
          current.children.set(part, {
            name: part,
            fullPath: currentPath,
            count: 0,
            children: new Map(),
          });
        }
        const childNode = current.children.get(part);
        if (idx === parts.length - 1) {
          childNode.count = item.count || 0;
          childNode.tag_key = item.tag_key || '';
          childNode.short_name = item.short_name || '';
          childNode.is_pinned = Boolean(item.is_pinned);
        }
        current = childNode;
      });
    });

    function sortNodes(node) {
      if (!node.children || node.children.size === 0) return;
      const sorted = Array.from(node.children.entries()).sort((a, b) =>
        a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' })
      );
      node.children = new Map(sorted);
      node.children.forEach((c) => sortNodes(c));
    }
    sortNodes(root);
    return root;
  }

  /**
   * 新規追加されたタグ・親階層タグが availableTags に未登録なら即時反映する
   */
  function ensureMobileTagInAvailableList(expandedTags) {
    if (!Array.isArray(mState.availableTags)) mState.availableTags = [];
    for (const anc of expandedTags) {
      if (!mState.availableTags.some((item) => item.tag === anc)) {
        mState.availableTags.push({ tag: anc, count: 1 });
      }
    }
  }

  /**
   * スマホ用タグツリー＆インライン子タグ追加・ルートタグ追加を描画する
   */
  function renderMobileQuickTagTree(container, photoTags, isBatchMode, onTagAction) {
    if (!container) return;
    container.innerHTML = '';

    if (!(mState.tagTreeExpandedPaths instanceof Set)) {
      mState.tagTreeExpandedPaths = new Set();
    }

    const manualTagsForAssign = window.TetheractCore?.TreeBuilder?.filterTagsBySource
      ? window.TetheractCore.TreeBuilder.filterTagsBySource(mState.availableTags || [], 'manual')
      : (mState.availableTags || []);
    const treeRoot = buildMobileTagTree(manualTagsForAssign);

    function appendInlineAddRow(targetEl, parentFullPath, parentDisplayName, indent) {
      const formRow = document.createElement('div');
      formRow.className = 'm-tree-inline-add' + (parentFullPath ? ' is-child' : ' is-root');
      formRow.style.paddingLeft = `${indent * 14 + 8}px`;

      const placeholderText = parentFullPath
        ? `${parentDisplayName} の子タグ名...`
        : '新しいタグ名 (階層は 親/子)...';

      formRow.innerHTML = `
        <input type="text" class="m-tree-inline-input" placeholder="${_escAttr(placeholderText)}" autocomplete="off">
        <button type="button" class="m-tree-inline-btn">＋追加</button>
      `;

      const inputEl = formRow.querySelector('.m-tree-inline-input');
      const addBtn = formRow.querySelector('.m-tree-inline-btn');

      const submitInlineTag = () => {
        if (!inputEl) return;
        const rawVal = inputEl.value.trim().replace(/^\/+|\/+$/g, '');
        if (!rawVal) return;
        const fullTag = parentFullPath ? `${parentFullPath}/${rawVal}` : rawVal;
        if (parentFullPath) {
          mState.tagTreeExpandedPaths.add(parentFullPath);
        }
        if (fullTag.includes('/')) {
          const parts = fullTag.split('/').map((p) => p.trim()).filter(Boolean);
          let cur = '';
          for (let i = 0; i < parts.length - 1; i++) {
            cur = cur ? `${cur}/${parts[i]}` : parts[i];
            mState.tagTreeExpandedPaths.add(cur);
          }
        }
        inputEl.value = '';
        onTagAction(fullTag, true);
      };

      if (inputEl) {
        inputEl.addEventListener('click', (e) => e.stopPropagation());
        inputEl.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            submitInlineTag();
          }
        });
      }
      if (addBtn) {
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          submitInlineTag();
        });
      }

      targetEl.appendChild(formRow);
    }

    function appendTreeItems(nodeMap, targetEl, indent = 0) {
      nodeMap.forEach((node) => {
        const hasChildren = node.children && node.children.size > 0;
        const isExpanded = mState.tagTreeExpandedPaths.has(node.fullPath);
        const hasTag = !isBatchMode && (photoTags || []).includes(node.fullPath);

        const nodeWrapper = document.createElement('div');
        nodeWrapper.className = 'm-tree-node';

        const row = document.createElement('div');
        row.className = 'm-tree-row';
        row.style.paddingLeft = `${indent * 14 + 8}px`;

        const arrowHtml = hasChildren
          ? `<span class="m-tree-arrow">${isExpanded ? '▼' : '▶'}</span>`
          : `<span class="m-tree-arrow"></span>`;
        const icon = hasChildren
          ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-2px;margin-right:3px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
          : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-1px;margin-right:3px;"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="10" y="10" width="7.5" height="7.5"/><line x1="3.6" y1="3.6" x2="10" y2="10"/><line x1="20.4" y1="3.6" x2="17.5" y2="10"/><line x1="20.4" y1="20.4" x2="17.5" y2="17.5"/><line x1="3.6" y1="20.4" x2="10" y2="17.5"/></svg>';
        const badgeLabel = isBatchMode
          ? '＋ 一括追加'
          : hasTag
          ? '✓ 付与中'
          : hasChildren
          ? '＋ 親付与'
          : '＋ 追加';

        const shortLabel = (node.short_name || '').trim();
        const displayTitle = shortLabel
          ? `${_escHtml(shortLabel)} <small style="opacity:0.65;font-weight:400;">(${_escHtml(node.name)})</small>`
          : _escHtml(node.name);
        row.innerHTML = `
          <span class="m-tree-row-left">
            ${arrowHtml}
            <span class="m-tree-name">${icon} ${displayTitle}</span>
          </span>
          <span class="m-tree-badge ${hasTag ? 'has-tag' : ''}">${badgeLabel}</span>
        `;

        nodeWrapper.appendChild(row);

        let childrenContainer = null;
        if (hasChildren) {
          childrenContainer = document.createElement('div');
          childrenContainer.className = `m-tree-children${isExpanded ? '' : ' hidden'}`;
          appendTreeItems(node.children, childrenContainer, indent + 1);
          // 親フォルダの子タグ一覧の最下段（次の親フォルダとの間）にインライン子タグ作成フォームを配置
          appendInlineAddRow(childrenContainer, node.fullPath, node.name, indent + 1);
          nodeWrapper.appendChild(childrenContainer);

          // 右側のバッジタップ時は親タグ自体を付与/解除
          const badgeEl = row.querySelector('.m-tree-badge');
          if (badgeEl) {
            badgeEl.addEventListener('click', (e) => {
              e.stopPropagation();
              onTagAction(node.fullPath, false);
            });
          }

          // フォルダ行本体タップ時は子要素の開閉を切り替え
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            const nowOpen = childrenContainer.classList.toggle('hidden') === false;
            if (nowOpen) {
              mState.tagTreeExpandedPaths.add(node.fullPath);
            } else {
              mState.tagTreeExpandedPaths.delete(node.fullPath);
            }
            const arrowEl = row.querySelector('.m-tree-arrow');
            if (arrowEl) arrowEl.textContent = nowOpen ? '▼' : '▶';
          });
        } else {
          // リーフノードは行全体のタップで即時ON/OFF
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            onTagAction(node.fullPath, false);
          });
        }

        targetEl.appendChild(nodeWrapper);
      });
    }

    const pinnedList = (mState.availableTags || []).filter(
      (t) => Boolean(t.is_pinned) && !MOBILE_COLOR_TAG_SET.has(t.tag)
    );
    if (pinnedList.length > 0) {
      const pinStrip = document.createElement('div');
      pinStrip.className = 'm-pinned-tag-strip';
      pinStrip.style.cssText =
        'display:flex; flex-wrap:wrap; gap:6px; padding:6px 8px 8px 8px; margin-bottom:6px; border-bottom:1px dashed rgba(255,255,255,0.12);';
      pinnedList.forEach((pt) => {
        const fullTag = pt.tag;
        const leaf = fullTag.split('/').pop();
        const disp = (pt.short_name && pt.short_name.trim()) ? pt.short_name.trim() : leaf;
        const hasTag = !isBatchMode && (photoTags || []).includes(fullTag);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = hasTag
          ? 'font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid #10b981; background:rgba(16,185,129,0.2); color:#10b981; font-weight:600;'
          : 'font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid rgba(245,158,11,0.45); background:rgba(245,158,11,0.12); color:var(--text-primary, #f3f4f6);';
        btn.textContent = `${hasTag ? '✓ ' : '★ '}${disp}`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          onTagAction(fullTag, false);
        });
        pinStrip.appendChild(btn);
      });
      container.appendChild(pinStrip);
    }

    appendTreeItems(treeRoot.children, container, 0);
    // ツリー全体の最下段にルート新規タグ追加フォームを配置
    appendInlineAddRow(container, '', '', 0);
  }

  function renderSinglePhotoInfoSheet(photo) {
    const currentTagsEl = document.getElementById('mCurrentPhotoTags');
    const quickTagsEl = document.getElementById('mQuickTagSelector');
    const exifTableEl = document.getElementById('mExifTable');
    const photoTags = photo.tags || [];

    if (currentTagsEl) {
      if (photoTags.length === 0) {
        currentTagsEl.innerHTML =
          '<span style="font-size:12px; color:var(--text-muted, #9ca6b5);">タグが付いていません</span>';
      } else {
        currentTagsEl.innerHTML = photoTags
          .map(
            (t) => `
          <span class="m-tag-chip">
            #${_escHtml(t)}
            <button data-remove-tag="${_escAttr(t)}" title="削除">✕</button>
          </span>
        `
          )
          .join('');
        currentTagsEl.querySelectorAll('[data-remove-tag]').forEach((btn) => {
          btn.addEventListener('click', () => {
            removeTagFromPhotoAction(photo, btn.dataset.removeTag);
          });
        });
      }
    }

    if (quickTagsEl) {
      renderMobileQuickTagTree(quickTagsEl, photoTags, false, (tagName, forceAdd) => {
        if (!forceAdd && (photo.tags || []).includes(tagName)) {
          removeTagFromPhotoAction(photo, tagName);
        } else {
          addTagToPhotoAction(photo, tagName);
        }
      });
    }

    if (exifTableEl) {
      const loc = [photo.country, photo.state, photo.city].filter(Boolean).join(' / ') || '未設定';
      const sizeMb = photo.file_size ? `${(photo.file_size / (1024 * 1024)).toFixed(2)} MB` : '-';
      const dim = photo.width && photo.height ? `${photo.width} × ${photo.height}` : '-';
      const rows = [
        ['ファイル名', photo.file_name || '-'],
        ['撮影日時', photo.date_taken || '-'],
        ['カメラ機種', photo.camera_model || '-'],
        ['レンズ', photo.lens_model || '-'],
        ['焦点距離', photo.focal_length ? `${photo.focal_length} mm` : '-'],
        ['絞り (F値)', photo.f_number ? `F/${photo.f_number}` : '-'],
        ['シャッター', photo.shutter_speed ? `${photo.shutter_speed} 秒` : '-'],
        ['ISO感度', photo.iso ? `ISO ${photo.iso}` : '-'],
        ['露出補正', photo.exposure_bias != null ? `${photo.exposure_bias} EV` : '-'],
        ['画像サイズ', `${dim} (${sizeMb})`],
        ['撮影地域', loc],
        ['保存パス', photo.file_path || '-'],
      ];
      exifTableEl.innerHTML = rows
        .map(
          ([k, v]) =>
            `<div class="m-exif-key">${_escHtml(k)}</div><div class="m-exif-val">${_escHtml(v)}</div>`
        )
        .join('');
    }
  }

  function renderBatchTagSheet() {
    const currentTagsEl = document.getElementById('mCurrentPhotoTags');
    const quickTagsEl = document.getElementById('mQuickTagSelector');
    if (currentTagsEl) {
      const summary = _computeSelectedBatchTagSummary();
      if (summary.commonTags.length === 0 && summary.partialTags.length === 0) {
        currentTagsEl.innerHTML =
          '<span style="font-size:12px; color:var(--text-muted, #9ca6b5);">選択写真に付与されているタグはありません（下のツリーから一括追加できます）</span>';
      } else {
        const cHtml = summary.commonTags
          .map(
            (t) => `<span class="m-tag-chip">#${_escHtml(t)} <small style="opacity:0.72;">(${summary.count}/${summary.count})</small><button data-remove-batch-tag="${_escAttr(t)}" title="一括削除">✕</button></span>`
          )
          .join('');
        const pHtml = summary.partialTags
          .map(
            (it) => `<span class="m-tag-chip is-partial" title="一部の写真のみに付与">#${_escHtml(it.tag)} <small style="opacity:0.72;">(${it.cnt}/${summary.count})</small></span>`
          )
          .join('');
        currentTagsEl.innerHTML = cHtml + pHtml;
        currentTagsEl.querySelectorAll('[data-remove-batch-tag]').forEach((btn) => {
          btn.addEventListener('click', () => {
            removeTagBatchAction(btn.dataset.removeBatchTag);
          });
        });
      }
    }
    if (quickTagsEl) {
      renderMobileQuickTagTree(quickTagsEl, [], true, (tagName) => {
        addTagBatchAction(tagName);
      });
    }
  }

  async function addTagToPhotoAction(photo, rawTag) {
    const tag = String(rawTag || '').trim();
    if (!tag || !photo) return;
    const expanded = expandTagAncestors(tag);
    ensureMobileTagInAvailableList(expanded);

    if (mState.mode === 'server') {
      try {
        const tKey = _findTagKey(tag);
        const res = await fetch(`/api/photo/${photo.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag, tag_key: tKey || undefined }),
        });
        if (!res.ok) throw new Error('タグ追加失敗');
        const data = await res.json();
        photo.tags = data.tags || [...new Set([...(photo.tags || []), ...expanded])];
      } catch (e) {
        showToast('! タグ追加エラー');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      for (const anc of expanded) {
        mState.localDb.run(
          "INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)",
          [photo.id, anc]
        );
      }
      photo.tags = [...new Set([...(photo.tags || []), ...expanded])].sort();
      recordPendingChange(photo, 'add_tag', tag);
    }

    renderSinglePhotoInfoSheet(photo);
    renderViewerCurrentPhoto();
    syncTabletInspectorCurrentPhoto();
    await fetchFilterSummaries();
    renderSinglePhotoInfoSheet(photo);
    syncTabletInspectorCurrentPhoto();
    showToast(`#${tag} を追加しました`);
  }

  function _pruneRemovedTagAndOrphanAncestors(tags, removedTag) {
    if (!Array.isArray(tags)) return [];
    const clean = String(removedTag || '').trim().replace(/^\/+|\/+$/g, '');
    if (!clean) return tags;
    let next = tags.filter((t) => t !== clean && !t.startsWith(`${clean}/`));
    const parts = clean.split('/').map((p) => p.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 1; i--) {
      const anc = parts.slice(0, i).join('/');
      if (!next.some((t) => t.startsWith(`${anc}/`))) {
        next = next.filter((t) => t !== anc);
      }
    }
    return next;
  }

  function _deleteTagAndOrphanAncestorsFromLocalDb(pid, tag) {
    if (!mState.localDb) return;
    mState.localDb.run('DELETE FROM photo_tags WHERE photo_id = ? AND (tag = ? OR tag LIKE ?)', [
      pid,
      tag,
      `${tag}/%`,
    ]);
    const ancList = expandTagAncestors(tag).slice(0, -1).reverse();
    for (const anc of ancList) {
      mState.localDb.run(
        'DELETE FROM photo_tags WHERE photo_id = ? AND tag = ? AND NOT EXISTS (SELECT 1 FROM photo_tags pt2 WHERE pt2.photo_id = ? AND pt2.tag LIKE ?)',
        [pid, anc, pid, `${anc}/%`]
      );
    }
  }

  async function removeTagFromPhotoAction(photo, rawTag) {
    const tag = String(rawTag || '').trim();
    if (!tag || !photo) return;

    if (mState.mode === 'server') {
      try {
        const res = await fetch(`/api/photo/${photo.id}/tags/${encodeURIComponent(tag)}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error('タグ削除失敗');
        const data = await res.json();
        photo.tags = data.tags || _pruneRemovedTagAndOrphanAncestors(photo.tags || [], tag);
      } catch (e) {
        showToast('! タグ削除エラー');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      _deleteTagAndOrphanAncestorsFromLocalDb(photo.id, tag);
      photo.tags = _pruneRemovedTagAndOrphanAncestors(photo.tags || [], tag);
      recordPendingChange(photo, 'remove_tag', tag);
    }

    renderSinglePhotoInfoSheet(photo);
    renderViewerCurrentPhoto();
    syncTabletInspectorCurrentPhoto();
    await fetchFilterSummaries();
    renderSinglePhotoInfoSheet(photo);
    syncTabletInspectorCurrentPhoto();
    showToast(`#${tag} を解除しました`);
  }

  async function addTagBatchAction(rawTag) {
    const tag = String(rawTag || '').trim();
    const ids = Array.from(mState.selectedIds);
    if (!tag || ids.length === 0) return;
    const expanded = expandTagAncestors(tag);
    ensureMobileTagInAvailableList(expanded);

    if (mState.mode === 'server') {
      try {
        const tKey = _findTagKey(tag);
        const res = await fetch('/api/photos/batch-tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: ids, tag, tag_key: tKey || undefined, action: 'add' }),
        });
        if (!res.ok) throw new Error('一括タグ追加失敗');
      } catch (e) {
        showToast('! 一括タグ追加エラー');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      const tKey = _findTagKey(tag);
      if (_hasNativeJournal()) {
        const patch = { add_tags: [tag] };
        if (tKey) patch.add_tag_keys = { [tKey]: tag };
        const ok = await _saveNativeBatchChanges(ids, patch);
        if (!ok) {
          showToast('! ロッカーDBの一括タグ追加に失敗しました');
          return;
        }
      } else {
        mState.localDb.run('BEGIN TRANSACTION');
        try {
          for (const pid of ids) {
            for (const anc of expanded) {
              mState.localDb.run(
                "INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)",
                [pid, anc]
              );
            }
            const pObj = mState.photos.find((p) => p.id === pid);
            if (pObj) {
              recordPendingChange(pObj, 'add_tag', tag, { deferSave: true });
            }
          }
          mState.localDb.run('COMMIT');
          savePendingChangesToStorage();
        } catch (e) {
          console.error('[MobileDB] 一括タグ追加エラー:', e);
          try {
            mState.localDb.run('ROLLBACK');
          } catch (re) {}
          showToast('! ローカルDBのタグ更新に失敗しました');
          return;
        }
      }
    }

    const selObjs = ids.map((pid) => mState.photos.find((p) => p.id === pid)).filter(Boolean);
    _batchEnsureSelectedTagsLoaded(selObjs);
    for (const pObj of selObjs) {
      pObj.tags = [...new Set([...(pObj.tags || []), ...expanded])].sort();
      pObj._tagsLoaded = true;
    }
    await fetchFilterSummaries();
    renderBatchTagSheet();
    syncTabletInspectorCurrentPhoto();
    showToast(`${ids.length}枚に #${tag} を追加しました`);
  }

  async function removeTagBatchAction(rawTag) {
    const tag = String(rawTag || '').trim();
    const ids = Array.from(mState.selectedIds);
    if (!tag || ids.length === 0) return;

    if (mState.mode === 'server') {
      try {
        const res = await fetch('/api/photos/batch-tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: ids, tag, action: 'remove' }),
        });
        if (!res.ok) throw new Error('一括タグ削除失敗');
      } catch (e) {
        showToast('! 一括タグ削除エラー');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      const tKey = _findTagKey(tag);
      if (_hasNativeJournal()) {
        const patch = { remove_tags: [tag] };
        if (tKey) patch.remove_tag_keys = { [tKey]: tag };
        const ok = await _saveNativeBatchChanges(ids, patch);
        if (!ok) {
          showToast('! ロッカーDBの一括タグ削除に失敗しました');
          return;
        }
      } else {
        mState.localDb.run('BEGIN TRANSACTION');
        try {
          for (const pid of ids) {
            _deleteTagAndOrphanAncestorsFromLocalDb(pid, tag);
            const pObj = mState.photos.find((p) => p.id === pid);
            if (pObj) {
              recordPendingChange(pObj, 'remove_tag', tag, { deferSave: true });
            }
          }
          mState.localDb.run('COMMIT');
          savePendingChangesToStorage();
        } catch (e) {
          console.error('[MobileDB] 一括タグ削除エラー:', e);
          try {
            mState.localDb.run('ROLLBACK');
          } catch (re) {}
          showToast('! ローカルDBのタグ削除に失敗しました');
          return;
        }
      }
    }

    const selObjs = ids.map((pid) => mState.photos.find((p) => p.id === pid)).filter(Boolean);
    _batchEnsureSelectedTagsLoaded(selObjs);
    for (const pObj of selObjs) {
      if (Array.isArray(pObj.tags)) {
        pObj.tags = _pruneRemovedTagAndOrphanAncestors(pObj.tags, tag);
      }
      pObj._tagsLoaded = true;
    }
    await fetchFilterSummaries();
    renderBatchTagSheet();
    syncTabletInspectorCurrentPhoto();
    showToast(`${ids.length}枚から #${tag} を一括解除しました`);
  }

  // ==================== 差分JSON出力 / DB丸ごと出力（完全クローズ＆検証保証） ====================

  let _lastExportBlobUrl = null;

  function _createPersistentBlobUrl(blob) {
    if (_lastExportBlobUrl) {
      try {
        URL.revokeObjectURL(_lastExportBlobUrl);
      } catch (e) {}
      _lastExportBlobUrl = null;
    }
    _lastExportBlobUrl = URL.createObjectURL(blob);
    return _lastExportBlobUrl;
  }

  function _showExportCompleteNotice(titleText, descHtml) {
    const box = document.getElementById('mExportCompleteBox');
    const titleEl = document.getElementById('mExportCompleteTitle');
    const descEl = document.getElementById('mExportCompleteDesc');
    if (titleEl && titleText) titleEl.textContent = titleText;
    if (descEl && descHtml) descEl.innerHTML = descHtml;
    if (box) box.style.display = 'block';
    const dbOverlay = document.getElementById('mDbSyncOverlay');
    if (dbOverlay) dbOverlay.style.display = 'flex';
  }

  /**
   * 選別差分ペイロードのJSON文字列を構築する（末尾改行付き）
   */
  function _buildSyncJsonString() {
    if (_hasNativeJournal() && typeof window.TetheractNative.getPendingChangesJson === 'function') {
      return window.TetheractNative.getPendingChangesJson();
    }
    const payload = {
      format: 'photo-manager-mobile-sync-v1',
      exported_at: _formatLocalTimestamp(new Date()),
      source_db: mState.pendingChanges.db_name || mState.localDbFileName || 'library.db',
      changes: Object.values(mState.pendingChanges.items),
    };
    return JSON.stringify(payload, null, 2) + '\n';
  }

  /**
   * 選別差分ファイル (mobile_sync.json) を保存し、確実にクローズ・検証・フラッシュ待機する
   */
  async function exportSyncJsonFile() {
    const cnt = getPendingChangesCount();
    if (cnt === 0) {
      showToast('未反映の変更はありません');
      return;
    }

    const jsonStr = _buildSyncJsonString();
    const utf8Bytes = new TextEncoder().encode(jsonStr);

    // 0. Android ネイティブアプリ（専用ロッカー）の場合は SAF 経由で USB 内の cache/mobile_sync.json へ直接書き出し
    if (window.TetheractNative && typeof window.TetheractNative.exportSyncJsonToUsb === 'function') {
      try {
        const res = JSON.parse(window.TetheractNative.exportSyncJsonToUsb() || '{}');
        if (res && res.ok) {
          updatePendingBadgeUI();
          _showExportCompleteNotice(
            `✓ USB内の ${res.fileName || 'cache/mobile_sync.json'} (${cnt}件) へ直接書き込み・フラッシュが完了しました！`,
            '<strong>【重要】スマホからUSBを抜く前に：</strong><br>スマホ画面の上から通知バーを下ろし、<strong>「USBドライブを取り外す（マウント解除）」</strong>をタップしてからUSBを抜き、PCの母艦へ挿してください。'
          );
          showToast(`✓ USB内の cache/mobile_sync.json へ同期完了 (${cnt}件)`, 3500);
          return;
        } else {
          showToast(res.error || 'USBメモリを接続してから再度お試しください', 3500);
          return;
        }
      } catch (e) {
        console.error('Android Native USB書き出しエラー:', e);
      }
    }

    // 1. 保存先フォルダ（USBメモリ等）を直接選べる場合はネイティブ保存ダイアログを開く
    if (typeof window.showSaveFilePicker === 'function') {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: 'mobile_sync.json',
          types: [
            {
              description: 'Tetheract 選別差分ファイル',
              accept: { 'application/json': ['.json'] },
            },
          ],
        });
      } catch (pickerErr) {
        if (pickerErr && pickerErr.name === 'AbortError') {
          // ユーザーが保存ダイアログをキャンセルした場合
          return;
        }
        // 非対応コンテキスト等の場合は下の通常ダウンロードへフォールバック
        handle = null;
      }

      if (handle) {
        setLoading(
          true,
          'mobile_sync.json を書き込み・ファイルクローズ中...',
          '! 完了画面が出るまで、絶対にUSBメモリを抜かないでください！'
        );
        try {
          const writable = await handle.createWritable({ keepExistingData: false });
          await writable.write(utf8Bytes);
          await writable.close();

          // 書き込まれたファイルを再オープンしてサイズと中身を検証し、OS側のファイルディスクリプタ確定を促す
          const savedFile = await handle.getFile();
          const savedText = await savedFile.text();
          if (
            !savedFile ||
            savedFile.size === 0 ||
            !savedText.includes('"photo-manager-mobile-sync-v1"')
          ) {
            throw new Error('保存後のファイル検証でサイズが0バイトでした');
          }

          // Android OS の VFAT/exFAT 書き込みキャッシュがUSBフラッシュへ書き出されるまで安全待機
          setLoading(
            true,
            'USBメモリの書き込みキャッシュを確定（フラッシュ）中...',
            '! あと2秒そのままお待ちください（まだUSBを抜かないでください）'
          );
          await new Promise((resolve) => setTimeout(resolve, 2500));

          setLoading(false);
          _showExportCompleteNotice(
            `✓ ${savedFile.name} (${savedFile.size.toLocaleString()} B / ${cnt}件) の書き込み・クローズが完了しました！`,
            '<strong>【重要】スマホからUSBを抜く前に：</strong><br>スマホ画面の上から通知バーを下ろし、<strong>「USBドライブを取り外す（マウント解除）」</strong>をタップしてからUSBを抜いてください。その後PCに挿して起動すると自動で取り込まれます。'
          );
          showToast(`✓ ${savedFile.name} の書き込み・クローズが完了しました！`, 4000);
          return;
        } catch (writeErr) {
          setLoading(false);
          console.error('showSaveFilePicker 書き込みエラー:', writeErr);
          showToast(
            '! 直接書き込みを確認できないため通常ダウンロードに切り替えます: ' +
              (writeErr.message || writeErr),
            4500
          );
          // 失敗時は下の標準ダウンロードへ自動フォールバック
        }
      }
    }

    // 2. 標準ブラウザダウンロード（Blob URL を早期破棄せず保持し、0バイト破損を防止）
    const a = document.createElement('a');
    a.download = 'mobile_sync.json';

    if (!window.location.origin || window.location.origin === 'null') {
      a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);
    } else {
      const blob = new Blob([utf8Bytes], { type: 'application/json;charset=utf-8' });
      a.href = _createPersistentBlobUrl(blob);
    }
    document.body.appendChild(a);
    a.click();
    a.remove();

    _showExportCompleteNotice(
      `✓ mobile_sync.json (${utf8Bytes.byteLength.toLocaleString()} B / ${cnt}件) を出力しました！`,
      'ダウンロード先（またはUSBメモリ）へ保存が完了したら、スマホの通知バーから<strong>「USBドライブを取り外す（マウント解除）」</strong>をタップしてからUSBを抜いてください。'
    );
    showToast('✓ mobile_sync.json を保存しました', 3500);
  }

  /**
   * Android等のOS標準共有シート (Web Share API) を使って mobile_sync.json を保存・送信する
   */
  async function shareSyncJsonFile() {
    const cnt = getPendingChangesCount();
    if (cnt === 0) {
      showToast('未反映の変更はありません');
      return;
    }
    const jsonStr = _buildSyncJsonString();

    if (navigator.share) {
      try {
        const file = new File([jsonStr], 'mobile_sync.json', { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: 'mobile_sync.json',
            text: `Tetheract 選別差分データ (${cnt}件)`,
            files: [file],
          });
          _showExportCompleteNotice(
            `✓ 共有アプリへ mobile_sync.json (${cnt}件) を渡しました`,
            'ファイル管理アプリ等でUSBメモリへの保存が完了したら、スマホの通知バーから<strong>「USBドライブを取り外す（マウント解除）」</strong>をタップしてからUSBを抜いてください。'
          );
          return;
        }
        await navigator.share({
          title: 'mobile_sync.json',
          text: jsonStr,
        });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    exportSyncJsonFile();
  }

  /**
   * 選別差分JSONをクリップボードへコピーする
   */
  async function copySyncJsonToClipboard() {
    const cnt = getPendingChangesCount();
    if (cnt === 0) {
      showToast('未反映の変更はありません');
      return;
    }
    const jsonStr = _buildSyncJsonString();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(jsonStr);
        showToast(`✓ 選別データ (${cnt}件) をコピーしました`);
        return;
      }
    } catch (e) {}

    // フォールバックコピー
    const ta = document.createElement('textarea');
    ta.value = jsonStr;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(`✓ 選別データ (${cnt}件) をコピーしました`);
    } catch (e) {
      showToast('! コピーに失敗しました。ファイル保存をご利用ください', 3500);
    } finally {
      ta.remove();
    }
  }

  /**
   * メモリ上で更新された library.db 本体を丸ごとバイナリ書き出しする
   */
  function exportFullSqliteDbFile() {
    if (!mState.localDb) {
      showToast('ローカルDBが読み込まれていません');
      return;
    }
    try {
      const binaryArray = mState.localDb.export();
      if (typeof mState.localDb.create_function === 'function') mState.localDb.create_function('tetheract_v170_guard', () => 1);
      const blob = new Blob([binaryArray], { type: 'application/octet-stream' });
      const url = _createPersistentBlobUrl(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = mState.localDbFileName || 'library.db';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('✓ 更新済み library.db を書き出しました');
    } catch (e) {
      showToast('! DB書き出しエラー: ' + (e.message || e), 4500);
    }
  }

  // ==================== イベントリスナー登録 ====================

  function bindAllEvents() {
    // テーマ切替
    document.getElementById('mThemeBtn')?.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'paper' ? 'sumi' : 'paper');
    });

    // ドロワー開閉
    const openDrawer = () => {
      document.getElementById('mDrawerOverlay').style.display = 'block';
      requestAnimationFrame(() => document.getElementById('mDrawer').classList.add('open'));
    };
    const closeDrawer = () => {
      document.getElementById('mDrawer').classList.remove('open');
      setTimeout(() => {
        document.getElementById('mDrawerOverlay').style.display = 'none';
      }, 220);
    };
    document.getElementById('mOpenDrawerBtn')?.addEventListener('click', () => {
      if (!isTabletMode() && window.TetheractTouchUI && typeof window.TetheractTouchUI.openPerspectiveSheet === 'function') {
        window.TetheractTouchUI.openPerspectiveSheet();
        return;
      }
      openDrawer();
    });
    document.getElementById('mHeaderSearchBtn')?.addEventListener('click', () => {
      if (window.TetheractTouchUI && typeof window.TetheractTouchUI.openPerspectiveSheet === 'function') {
        window.TetheractTouchUI.openPerspectiveSheet('search');
        setTimeout(() => {
          document.getElementById('tPerspectiveSearchInput')?.focus();
        }, 120);
        return;
      }
      openDrawer();
      setTimeout(() => {
        document.getElementById('mSearchInput')?.focus();
      }, 150);
    });
    document.getElementById('mCloseDrawerBtn')?.addEventListener('click', closeDrawer);
    document.getElementById('mDrawerOverlay')?.addEventListener('click', closeDrawer);
    document.getElementById('mDrawerApplyCloseBtn')?.addEventListener('click', closeDrawer);
    document.getElementById('mDrawerResetBtn')?.addEventListener('click', () => {
      resetAllFilters();
      closeDrawer();
    });
    document.getElementById('mEmptyResetFilterBtn')?.addEventListener('click', resetAllFilters);

    // 検索ボックス
    let searchTimer = null;
    const searchInput = document.getElementById('mSearchInput');
    const searchClear = document.getElementById('mSearchClearBtn');
    searchInput?.addEventListener('input', () => {
      const v = searchInput.value.trim();
      if (searchClear) searchClear.style.display = v ? 'block' : 'none';
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        mState.searchQuery = v;
        fetchPhotosData();
      }, 250);
    });
    searchClear?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      searchClear.style.display = 'none';
      mState.searchQuery = '';
      fetchPhotosData();
    });

    // ソート順（ヘッダーのクイックセレクトとドロワー内セレクトを双方向同期）
    const syncSortChange = (val) => {
      mState.sortBy = val;
      const s1 = document.getElementById('mSortSelect');
      const s2 = document.getElementById('mQuickSortSelect');
      if (s1 && s1.value !== val) s1.value = val;
      if (s2 && s2.value !== val) s2.value = val;
      fetchPhotosData();
    };
    document.getElementById('mSortSelect')?.addEventListener('change', (e) => syncSortChange(e.target.value));
    document.getElementById('mQuickSortSelect')?.addEventListener('change', (e) => syncSortChange(e.target.value));

    // クイック評価フィルタピル
    document.querySelectorAll('.m-quick-scroll [data-rating]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = btn.dataset.rating;
        mState.ratingFilter = r === 'all' || r === 'default' ? r : Number(r);
        document.querySelectorAll('.m-quick-scroll [data-rating]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        fetchPhotosData();
      });
    });

    // スタック集約トグル
    document.getElementById('mStackToggleBtn')?.addEventListener('click', (e) => {
      mState.stacked = !mState.stacked;
      e.currentTarget.classList.toggle('active', mState.stacked);
      fetchPhotosData();
    });

    // 一覧レイアウト切替 (標準グリッド -> びっしり表示 -> マウント表示)
    document.getElementById('mGridLayoutBtn')?.addEventListener('click', () => {
      const order = ['grid', 'masonry', 'mount'];
      const curIdx = order.indexOf(mState.gridLayout || 'grid');
      mState.gridLayout = order[(curIdx + 1) % order.length];
      _safeSetStorage('pm_mobile_layout', mState.gridLayout);
      updateGridLayoutUI();
      const names = {
        grid: '標準グリッド表示',
        masonry: 'びっしり表示（アスペクト比維持）',
        mount: 'マウント表示（スライドフィルム枠）',
      };
      showToast(names[mState.gridLayout] || '標準グリッド表示');
    });

    // グリッド列数切替 (2 -> 3 -> 4 -> 2)
    document.getElementById('mGridColsBtn')?.addEventListener('click', () => {
      mState.gridCols = mState.gridCols === 2 ? 3 : mState.gridCols === 3 ? 4 : 2;
      _safeSetStorage('pm_mobile_cols', String(mState.gridCols));
      updateGridColsUI();
    });

    // 複数選択モード切替
    document.getElementById('mSelectModeBtn')?.addEventListener('click', () => {
      setSelectMode(!mState.selectMode);
    });
    document.getElementById('mBatchSelectAllBtn')?.addEventListener('click', () => {
      for (const p of mState.photos) mState.selectedIds.add(p.id);
      document.querySelectorAll('.m-card').forEach((el) => el.classList.add('selected'));
      updateBatchCountLabel();
    });
    document.getElementById('mBatchClearBtn')?.addEventListener('click', () => {
      mState.selectedIds.clear();
      document.querySelectorAll('.m-card.selected').forEach((el) => el.classList.remove('selected'));
      updateBatchCountLabel();
    });
    document.getElementById('mBatchExitBtn')?.addEventListener('click', () => setSelectMode(false));

    // 長押し開始・ドラッグ選択時に mState.selectMode と mState.selectedIds を同期し、2枚目以降をワンタップ選択可能にする
    window.addEventListener('tetheract:grid-drag-select', (e) => {
      const numId = Number(e?.detail?.photoId);
      const selected = Boolean(e?.detail?.selected);
      if (!numId) return;
      if (!mState.selectMode) {
        if (mState.artFramerPickMode) setArtFramerPickMode(false);
        mState.selectMode = true;
        document.body.classList.add('m-select-mode');
        document.getElementById('mSelectModeBtn')?.classList.add('active');
      }
      if (selected) {
        mState.selectedIds.add(numId);
      } else {
        mState.selectedIds.delete(numId);
      }
      updateBatchCountLabel();
      if (mState.selectedIds.size === 0) {
        setSelectMode(false);
      } else if (window.TetheractTouchUI && typeof window.TetheractTouchUI.updateSelectionCount === 'function') {
        window.TetheractTouchUI.updateSelectionCount(mState.selectedIds.size);
      }
    });

    document.querySelectorAll('[data-batch-rate]').forEach((btn) => {
      btn.addEventListener('click', () => applyBatchRating(btn.dataset.batchRate));
    });
    document.getElementById('mBatchTagBtn')?.addEventListener('click', () => {
      if (mState.selectedIds.size === 0) {
        showToast('写真を選択してください');
        return;
      }
      openInfoSheet(true);
    });
    document.getElementById('mBatchArtFramerBtn')?.addEventListener('click', () => {
      if (mState.selectedIds.size === 0) {
        showToast('Art Framer で仕上げる写真を選択してください');
        return;
      }
      window.TetheractTouchUI?.artFramer?.open?.();
    });

    // スクロール連動チャンク描画 ＆ 画面回転・ペイン開閉連動のびっしり行高さ自動再計算
    const scrollContainer = document.getElementById('mScrollContainer');
    let scrollTicking = false;
    scrollContainer?.addEventListener(
      'scroll',
      () => {
        if (scrollTicking) return;
        scrollTicking = true;
        requestAnimationFrame(() => {
          scrollTicking = false;
          if (
            scrollContainer.scrollTop + scrollContainer.clientHeight >=
            scrollContainer.scrollHeight - 900
          ) {
            appendNextGridChunk();
          }
        });
      },
      { passive: true }
    );

    let resizeRaf = null;
    const scheduleMasonryRecalc = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        updateMasonryRowHeight();
        if (
          scrollContainer &&
          scrollContainer.scrollTop + scrollContainer.clientHeight >=
            scrollContainer.scrollHeight - 900
        ) {
          appendNextGridChunk();
        }
      });
    };
    if (typeof ResizeObserver === 'function' && scrollContainer) {
      const ro = new ResizeObserver(scheduleMasonryRecalc);
      ro.observe(scrollContainer);
    }
    window.addEventListener('resize', scheduleMasonryRecalc, { passive: true });
    window.addEventListener('orientationchange', () => {
      setTimeout(scheduleMasonryRecalc, 120);
    });

    // 2本指ピンチイン・ピンチアウトによる列数変更フック & タブレット操作フック
    window.__stepMobileGridCols = stepMobileGridCols;
    window.__onClearSingleSelection = () => {
      clearSingleSelection();
    };
    window.__getMobileArtFramerTargets = (explicitIds = null) => {
      let rawList = [];
      if (Array.isArray(explicitIds) && explicitIds.length > 0) {
        const wanted = new Set(explicitIds.map((x) => String(x)));
        for (const p of mState.photos || []) {
          if (wanted.has(String(p.id))) {
            rawList.push(p);
          } else if (Array.isArray(p.stack_photos)) {
            for (const sp of p.stack_photos) {
              if (wanted.has(String(sp.id))) rawList.push(sp);
            }
          }
        }
      } else if (mState.viewerOpen) {
        const vp = getActiveViewerPhoto();
        if (vp) rawList = [vp];
      } else if (mState.selectMode && mState.selectedIds.size > 0) {
        for (const id of mState.selectedIds) {
          const hit = (mState.photos || []).find((p) => String(p.id) === String(id));
          if (hit) rawList.push(hit);
        }
      } else if (mState.inspectedIndex >= 0 && mState.photos[mState.inspectedIndex]) {
        rawList = [mState.photos[mState.inspectedIndex]];
      }

      return rawList
        .map((rawP) => {
          const p = ensureLocalPhotoDetails(rawP) || rawP;
          if (!p || !p.id) return null;
          return {
            ...p,
            _bakedAdjust: _resolveBakedAdjustForPhoto(p),
            tags: Array.isArray(p.tags) ? [...p.tags] : [],
            thumbUrl: getMobileThumbnailUrl(p),
            hdUrl: getMobileFullPhotoUrl(p),
            isServerMode: mState.mode === 'server',
          };
        })
        .filter(Boolean);
    };
    window.__refreshMobileAfterArtFramerSave = async () => {
      if (mState.mode === 'server') {
        await refreshAllData();
        return;
      }
      if (typeof window.__onTetheractPhoneCatalogSynced === 'function') {
        await window.__onTetheractPhoneCatalogSynced();
      } else if (mState.mode === 'localdb' && mState.localDb) {
        mState.stackCountsMap = null;
        await refreshAllData();
      }
    };
    window.__openOrSelectForMobileArtFramer = () => {
      if (mState.artFramerPickMode) {
        setArtFramerPickMode(false);
        showToast('Art Framer 選択モードを解除しました', 1800);
        return false;
      }
      const hasReadyTarget = Boolean(
        mState.viewerOpen ||
        (mState.selectMode && mState.selectedIds.size > 0) ||
        (isTabletMode() && mState.inspectedIndex >= 0 && mState.photos[mState.inspectedIndex])
      );
      if (hasReadyTarget) {
        setArtFramerPickMode(false);
        const targets = typeof window.__getMobileArtFramerTargets === 'function'
          ? window.__getMobileArtFramerTargets()
          : [];
        if (targets.length > 0) {
          window.TetheractTouchUI?.artFramer?.open?.();
          return true;
        }
      }
      if (!mState.photos || mState.photos.length === 0) {
        showToast('仕上げる写真がありません');
        return false;
      }
      if (mState.selectMode && mState.selectedIds.size === 0) {
        setSelectMode(false);
      }
      setArtFramerPickMode(true);
      showToast('仕上げる写真を1枚タップすると Art Framer が開きます（もう一度タップで解除）', 2600);
      return false;
    };
    window.__onStartContextualDuel = () => {
      if (!window.TetheractTouchUI || !window.TetheractTouchUI.duel) return;
      let rawCandidates = [];
      if (mState.selectedIds.size >= 2) {
        const selIds = Array.from(mState.selectedIds);
        rawCandidates = selIds
          .map((id) => mState.photos.find((p) => p.id === id))
          .filter(Boolean)
          .slice(0, 12);
      } else {
        const basePhoto = mState.viewerOpen
          ? mState.photos[mState.viewerIndex]
          : (mState.inspectedIndex >= 0 ? mState.photos[mState.inspectedIndex] : mState.photos[0]);
        if (basePhoto) ensureLocalPhotoDetails(basePhoto);
        const currentPhoto = getActiveViewerPhoto() || basePhoto;
        if (basePhoto && Array.isArray(basePhoto.stack_photos) && basePhoto.stack_photos.length >= 2) {
          rawCandidates = basePhoto.stack_photos.slice(0, 12);
        } else if (currentPhoto && Array.isArray(currentPhoto.stack_photos) && currentPhoto.stack_photos.length >= 2) {
          rawCandidates = currentPhoto.stack_photos.slice(0, 12);
        } else if (mState.photos.length >= 2) {
          const baseIdx = mState.inspectedIndex >= 0 && mState.inspectedIndex < mState.photos.length - 1
            ? mState.inspectedIndex
            : 0;
          rawCandidates = mState.photos.slice(baseIdx, baseIdx + 2);
        }
      }
      if (rawCandidates.length < 2) {
        showToast('比較する写真が2枚以上ありません');
        return;
      }
      const candidates = rawCandidates.map((rawP) => {
        const p = ensureLocalPhotoDetails(rawP) || rawP;
        const exifParts = [
          p.camera_model || '',
          p.focal_length ? `${Math.round(Number(p.focal_length))}mm` : '',
          p.f_number ? `F${p.f_number}` : '',
          p.shutter_speed ? `${p.shutter_speed}s` : '',
          p.iso ? `ISO${p.iso}` : '',
        ].filter(Boolean);
        return {
          ...p,
          _bakedAdjust: _resolveBakedAdjustForPhoto(p),
          thumbUrl: getMobileThumbnailUrl(p),
          hdUrl: getMobileFullPhotoUrl(p),
          isServerMode: mState.mode === 'server',
          exifSummary: exifParts.join(' · '),
        };
      });
      window.TetheractTouchUI.duel.openDuel(candidates);
      if (typeof window.TetheractTouchUI.setThumbBarMode === 'function') {
        window.TetheractTouchUI.setThumbBarMode('duel');
      }
    };
    window.addEventListener('tetheract:filter-row-exclude', (e) => {
      const value = e?.detail?.value;
      if (!value) return;
      mState.untaggedOnly = false;
      mState.includeTags = mState.includeTags.filter((x) => x !== value);
      if (mState.excludeTags.includes(value)) {
        mState.excludeTags = mState.excludeTags.filter((x) => x !== value);
      } else {
        mState.excludeTags.push(value);
      }
      renderDrawerFilters();
      fetchPhotosData();
    });

    window.__renderTabletPerspectivePanel = (perspectiveId, container) => {
      if (!container) return false;
      if (perspectiveId === 'search') {
        container.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px;padding:6px 4px;">
            <input type="search" id="tPerspectiveSearchInput" class="m-input" placeholder="ファイル名・フォルダ名で検索..." value="${_escAttr(mState.searchQuery || '')}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-secondary);color:var(--text-primary);font-size:13px;">
            <button type="button" class="m-btn" id="tPerspectiveSearchClearBtn" style="width:100%;">検索クリア</button>
          </div>
        `;
        const inp = container.querySelector('#tPerspectiveSearchInput');
        let timer = null;
        inp?.addEventListener('input', () => {
          const v = inp.value.trim();
          const mainInp = document.getElementById('mSearchInput');
          if (mainInp) mainInp.value = v;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            mState.searchQuery = v;
            fetchPhotosData();
          }, 250);
        });
        container.querySelector('#tPerspectiveSearchClearBtn')?.addEventListener('click', () => {
          if (inp) inp.value = '';
          const mainInp = document.getElementById('mSearchInput');
          if (mainInp) mainInp.value = '';
          mState.searchQuery = '';
          fetchPhotosData();
        });
        return true;
      }
      if (perspectiveId === 'folder') {
        const TB = window.TetheractCore && window.TetheractCore.TreeBuilder;
        const rawFolderSource = Array.isArray(mState.folderList) && mState.folderList.length > 0
          ? mState.folderList
          : _queryLocalFolderSummaries();
        // M-2: 上部カード（touch_phone_case.js）にスマホ管理下フォルダが表示されている場合は、下部ツリーとの二重表示を防ぐ
        const hasTopPhoneCard = Boolean(window.TetheractTouchUI && typeof window.TetheractTouchUI.triggerQuickDeltaUplink === 'function' && window.TetheractNative);
        const folderSource = hasTopPhoneCard
          ? rawFolderSource.filter((f) => !String(f.directory_path || f.path || f.name || '').startsWith('📱'))
          : rawFolderSource;
        let fTree = TB && typeof TB.buildFolderTree === 'function' ? TB.buildFolderTree(folderSource) : [];
        // ルートから単一子フォルダが続く場合（例: P: -> Loome）は自動展開しておく
        const autoExpandSingleChain = (nodes) => {
          for (const n of nodes) {
            if (Array.isArray(n.children) && n.children.length > 0 && !mState._folderInitialExpanded) {
              mState.expandedFilterNodes.add(`dir:${n.fullPath}`);
              if (n.children.length === 1) autoExpandSingleChain(n.children);
            }
          }
        };
        if (!mState._folderInitialExpanded && fTree.length > 0) {
          autoExpandSingleChain(fTree);
          mState._folderInitialExpanded = true;
        }
        let html = `
          <div class="m-filter-item ${!mState.folderPath ? 'active-include' : ''}" data-folder-path="">
            <span class="m-filter-item-left"><span class="m-tree-toggle-spacer"></span><span class="m-filter-item-label">すべてのフォルダ</span></span>
          </div>
        `;
        const renderFolderNodes = (nodes, depth) => {
          for (const node of nodes) {
            const hasChildren = Array.isArray(node.children) && node.children.length > 0;
            const dirKey = `dir:${node.fullPath}`;
            const isOpen = mState.expandedFilterNodes.has(dirKey);
            const act = mState.folderPath === node.fullPath ? 'active-include' : '';
            const toggleHtml = hasChildren
              ? `<button type="button" class="m-tree-toggle-btn" data-folder-toggle="${_escAttr(dirKey)}">${isOpen ? '▼' : '▶'}</button>`
              : '<span class="m-tree-toggle-spacer"></span>';
            const iconPrefix = String(node.name || '').startsWith('📱') ? '' : '📁 ';
            html += `
              <div class="m-filter-item ${act}" data-folder-path="${_escAttr(node.fullPath)}">
                <span class="m-filter-item-left">
                  ${toggleHtml}
                  <span class="m-filter-item-label">${iconPrefix}${_escHtml(node.name)}</span>
                </span>
                <span class="m-filter-count">${node.count}</span>
              </div>
            `;
            if (hasChildren && isOpen) {
              html += '<div class="m-tree-sublist">';
              renderFolderNodes(node.children, depth + 1);
              html += '</div>';
            }
          }
        };
        renderFolderNodes(fTree, 0);
        container.innerHTML = `<div class="m-filter-list">${html}</div>`;
        container.querySelectorAll('[data-folder-toggle]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const k = btn.getAttribute('data-folder-toggle') || '';
            if (mState.expandedFilterNodes.has(k)) mState.expandedFilterNodes.delete(k);
            else mState.expandedFilterNodes.add(k);
            window.TetheractTouchUI?.refreshActivePerspective?.();
          });
        });
        container.querySelectorAll('[data-folder-path]').forEach((el) => {
          el.addEventListener('click', async () => {
            const fp = el.getAttribute('data-folder-path') || '';
            if (fp && fp.startsWith('📱 ') && typeof window.__filterMobileGalleryByFolder === 'function') {
              await window.__filterMobileGalleryByFolder(fp);
              return;
            }
            if (mState.folderPath === fp) {
              mState.folderPath = '';
            } else {
              mState.folderPath = fp;
              if (fp) mState.expandedFilterNodes.add(`dir:${fp}`);
            }
            fetchPhotosData();
            window.TetheractTouchUI?.refreshActivePerspective?.();
          });
        });
        return true;
      } else if (perspectiveId === 'binder') {
        const saved = Array.isArray(mState.savedBinders) ? mState.savedBinders : [];
        let savedHtml = '';
        if (saved.length > 0) {
          savedHtml =
            '<div style="font-size:11px;font-weight:700;color:var(--text-muted);padding:4px 8px 2px;">保存済みバインダー (PC同期)</div>' +
            saved
              .map(
                (b, idx) =>
                  `<div class="m-filter-item" data-saved-binder-idx="${idx}"><span>🔖 ${_escHtml(b.name || 'Binder')}</span></div>`
              )
              .join('') +
            '<div style="height:1px;background:var(--border-color);margin:6px 4px;"></div>';
        }
        container.innerHTML = `
          <div class="m-filter-list">
            ${savedHtml}
            <div style="font-size:11px;font-weight:700;color:var(--text-muted);padding:4px 8px 2px;">スマートバインダー</div>
            <div class="m-filter-item ${mState.ratingFilter === 'default' && !mState.untaggedOnly ? 'active-include' : ''}" data-smart-binder="default"><span>すべて（棄以外）</span></div>
            <div class="m-filter-item ${String(mState.ratingFilter) === '2' ? 'active-include' : ''}" data-smart-binder="rate2"><span>優 コレクション</span></div>
            <div class="m-filter-item ${String(mState.ratingFilter) === '1' ? 'active-include' : ''}" data-smart-binder="rate1"><span>良 セレクト</span></div>
            <div class="m-filter-item ${mState.untaggedOnly ? 'active-include' : ''}" data-smart-binder="untagged"><span>未分類（タグなし）</span><span class="m-filter-count">${mState.untaggedCount}</span></div>
            <div class="m-filter-item ${mState.noLocationOnly ? 'active-include' : ''}" data-smart-binder="noloc"><span>ジオタグなし</span><span class="m-filter-count">${mState.noLocationCount}</span></div>
          </div>
        `;
        container.querySelectorAll('[data-saved-binder-idx]').forEach((el) => {
          el.addEventListener('click', () => {
            const b = saved[Number(el.getAttribute('data-saved-binder-idx'))];
            if (!b) return;
            let fObj = b.filters;
            if (typeof fObj === 'string') {
              try { fObj = JSON.parse(fObj); } catch (e) { fObj = {}; }
            }
            fObj = fObj || {};
            resetAllFilters();
            if (fObj.tagFilters && typeof fObj.tagFilters === 'object') {
              for (const [tName, mode] of Object.entries(fObj.tagFilters)) {
                if (mode === 'exclude') mState.excludeTags.push(tName);
                else mState.includeTags.push(tName);
              }
            }
            if (fObj.searchQuery) mState.searchQuery = String(fObj.searchQuery);
            renderDrawerFilters();
            fetchPhotosData();
            showToast(`バインダー「${b.name}」を適用しました`);
          });
        });
        container.querySelectorAll('[data-smart-binder]').forEach((el) => {
          el.addEventListener('click', () => {
            const kind = el.getAttribute('data-smart-binder');
            mState.untaggedOnly = false;
            mState.noLocationOnly = false;
            if (kind === 'rate2') mState.ratingFilter = '2';
            else if (kind === 'rate1') mState.ratingFilter = '1';
            else if (kind === 'untagged') { mState.ratingFilter = 'default'; mState.untaggedOnly = true; }
            else if (kind === 'noloc') { mState.ratingFilter = 'default'; mState.noLocationOnly = true; }
            else mState.ratingFilter = 'default';
            document.querySelectorAll('.m-quick-scroll [data-rating]').forEach((btn) => {
              btn.classList.toggle('active', btn.dataset.rating === String(mState.ratingFilter));
            });
            renderDrawerFilters();
            fetchPhotosData();
          });
        });
        return true;
      }
      return false;
    };
    window.__onTabletInspectorOpenViewer = () => {
      const idx = mState.inspectedIndex >= 0 ? mState.inspectedIndex : 0;
      if (idx < mState.photos.length) openViewerAt(idx);
    };
    window.__onTabletInspectorRate = async (rate) => {
      if (mState.selectMode && mState.selectedIds.size > 1) {
        await applyBatchRating(rate);
        syncTabletInspectorCurrentPhoto();
        return;
      }
      rateCurrentViewerPhoto(rate);
    };
    window.__onTabletInspectorOpenTagSheet = () => {
      if (mState.selectMode && mState.selectedIds.size > 1) {
        openInfoSheet(true);
        return;
      }
      if (getActiveViewerPhoto()) openInfoSheet(false);
    };
    window.__onTabletInspectorAddTag = (tag) => {
      if (mState.selectMode && mState.selectedIds.size > 1) {
        addTagBatchAction(tag);
        return;
      }
      const photo = getActiveViewerPhoto();
      if (photo) addTagToPhotoAction(photo, tag);
    };
    window.__onTabletInspectorRemoveTag = (tag) => {
      if (mState.selectMode && mState.selectedIds.size > 1) {
        removeTagBatchAction(tag);
        return;
      }
      const photo = getActiveViewerPhoto();
      if (photo) removeTagFromPhotoAction(photo, tag);
    };
    window.addEventListener('tetheract:device-mode-change', () => {
      updateMasonryRowHeight();
      if (mState.inspectedIndex >= 0 && mState.inspectedIndex < mState.photos.length) {
        inspectPhotoAt(mState.inspectedIndex);
      } else {
        clearSingleSelection();
      }
    });

    let adjustSaveTimer = null;
    let pendingAdjustTask = null;
    let adjustSaveInFlight = null;

    async function _commitAdjustSaveTask(task) {
      if (!task || !task.photo) return;
      const { photo, nextBrightness, nextContrast, nextSaturation, nextFineAngle } = task;
      const cardImg = document.querySelector(`.m-card[data-id="${photo.id}"] img`);
      if (mState.mode === 'server') {
        try {
          const res = await fetch(`/api/photo/${photo.id}/adjustments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              rotation: Number(photo.rotation || 0),
              fine_angle: nextFineAngle,
              brightness: nextBrightness,
              contrast: nextContrast,
              saturation: nextSaturation,
            }),
          });
          if (res.ok) {
            photo._bakedAdjust = _normalizeAdjustSnapshot({
              ...photo,
              brightness: nextBrightness,
              contrast: nextContrast,
              saturation: nextSaturation,
              fine_angle: nextFineAngle,
              rotation: Number(photo.rotation || 0),
            });
            if (cardImg) {
              cardImg.src = getMobileThumbnailUrl(photo);
              window.TetheractTouchUI?.applyPhotoCssAdjustmentsToElement?.(cardImg, photo);
            }
          }
        } catch (err) {
          console.warn('サーバー調整値保存エラー:', err);
        }
      } else if (mState.mode === 'localdb' && mState.localDb) {
        try {
          ensureLocalPhotoDetails(photo);
          mState.localDb.run(
            'UPDATE photos SET brightness = ?, contrast = ?, saturation = ?, fine_angle = ? WHERE id = ?',
            [nextBrightness, nextContrast, nextSaturation, nextFineAngle, photo.id]
          );
          recordPendingChange(photo, 'adjustments', {
            brightness: nextBrightness,
            contrast: nextContrast,
            saturation: nextSaturation,
            fine_angle: nextFineAngle,
          });
        } catch (err) {
          console.warn('ローカルDB調整値保存エラー:', err);
        }
      }
    }

    window.__flushMobilePendingAdjustSave = async () => {
      if (adjustSaveTimer) {
        clearTimeout(adjustSaveTimer);
        adjustSaveTimer = null;
      }
      if (adjustSaveInFlight) {
        try {
          await adjustSaveInFlight;
        } catch (e) {}
      }
      while (pendingAdjustTask) {
        const task = pendingAdjustTask;
        pendingAdjustTask = null;
        adjustSaveInFlight = _commitAdjustSaveTask(task);
        try {
          await adjustSaveInFlight;
        } finally {
          adjustSaveInFlight = null;
        }
      }
    };

    window.addEventListener('tetheract:canvas-scrub-change', (e) => {
      const photo = getActiveViewerPhoto();
      if (!photo || !e || !e.detail || !e.detail.values) return;
      _rememberBakedAdjustForPhoto(photo);
      photo._bakedAdjust = _resolveBakedAdjustForPhoto(photo);
      const vals = e.detail.values;
      const nextBrightness = Math.max(-100, Math.min(100, Math.round(Number(vals.exposure || 0) * 10)));
      const nextContrast = Math.max(-100, Math.min(100, Math.round(Number(vals.contrast || 0))));
      const nextSaturation = Math.max(-100, Math.min(100, Math.round(Number(vals.saturation || 0))));
      const nextFineAngle = Number(Math.max(-45, Math.min(45, Number(vals.tilt || 0))).toFixed(2));
      photo.brightness = nextBrightness;
      photo.contrast = nextContrast;
      photo.saturation = nextSaturation;
      photo.fine_angle = nextFineAngle;

      const cardImg = document.querySelector(`.m-card[data-id="${photo.id}"] img`);
      if (cardImg) {
        window.TetheractTouchUI?.applyPhotoCssAdjustmentsToElement?.(cardImg, photo);
      }
      syncTabletInspectorCurrentPhoto();

      pendingAdjustTask = {
        photo,
        nextBrightness,
        nextContrast,
        nextSaturation,
        nextFineAngle,
      };
      if (adjustSaveTimer) clearTimeout(adjustSaveTimer);
      adjustSaveTimer = setTimeout(() => {
        adjustSaveTimer = null;
        window.__flushMobilePendingAdjustSave?.();
      }, 180);
    });

    window.addEventListener('tetheract:duel-keep', async (e) => {
      const winner = e && e.detail ? e.detail.winner : null;
      if (!winner || !winner.id) return;
      let idx = mState.photos.findIndex((p) => String(p.id) === String(winner.id));
      if (idx < 0) {
        const parentIdx = mState.photos.findIndex(
          (p) => Array.isArray(p.stack_photos) && p.stack_photos.some((sp) => String(sp.id) === String(winner.id))
        );
        if (parentIdx >= 0) {
          mState.viewerIndex = parentIdx;
          const memberObj = mState.photos[parentIdx].stack_photos.find((sp) => String(sp.id) === String(winner.id)) || winner;
          await setStackPrimaryPhoto(memberObj);
          idx = parentIdx;
        }
      }
      if (idx >= 0) {
        inspectPhotoAt(idx);
        const targetPhoto = mState.photos[idx];
        if (Number(targetPhoto.rating || 0) <= 0) {
          rateCurrentViewerPhoto(1);
          showToast(`「${targetPhoto.file_name}」を良に選別しました`);
        } else {
          showToast(`「${targetPhoto.file_name}」を残しました`);
        }
      }
    });

    // ビューア操作
    document.getElementById('mViewerCloseBtn')?.addEventListener('click', closeViewer);
    document.getElementById('mViewerPrevBtn')?.addEventListener('click', () => stepViewer(-1));
    document.getElementById('mViewerNextBtn')?.addEventListener('click', () => stepViewer(1));
    document.getElementById('mViewerArtFramerBtn')?.addEventListener('click', () => {
      window.TetheractTouchUI?.artFramer?.open?.();
    });
    document.getElementById('mViewerAdjustBtn')?.addEventListener('click', () => {
      if (!window.TetheractTouchUI || typeof window.TetheractTouchUI.setThumbBarMode !== 'function') return;
      const curMode = typeof window.TetheractTouchUI.getThumbBarMode === 'function'
        ? window.TetheractTouchUI.getThumbBarMode()
        : 'cull';
      window.TetheractTouchUI.setThumbBarMode(curMode === 'adjust' ? 'cull' : 'adjust');
    });
    window.addEventListener('tetheract:thumb-mode-change', (e) => {
      const modal = document.getElementById('mViewerModal');
      if (modal && e && e.detail && e.detail.mode === 'adjust') {
        modal.classList.remove('is-immersive');
        window.TetheractTouchUI?.viewerLauncher?.close?.();
      }
      requestAnimationFrame(() => {
        if (mState.viewerOpen) {
          _updateViewerZoomHint();
          applyViewerTransform(false);
        }
      });
    });
    document
      .getElementById('mViewerOpenInfoBtn')
      ?.addEventListener('click', () => openInfoSheet(false));

    document.getElementById('mViewerZoomBadge')?.addEventListener('click', () => {
      if (mState.zoomScale > 1.05) {
        resetViewerZoom(true);
      } else {
        const m = _getViewerPhotoMetrics();
        mState.zoomScale = m.oneToOneScale;
        mState.panX = 0;
        mState.panY = 0;
        _updateViewerZoomHint();
        applyViewerTransform(false);
      }
    });
    document.getElementById('mViewerImg')?.addEventListener('load', () => {
      if (mState.viewerOpen) { _updateViewerZoomHint(); applyViewerTransform(false); }
    });

    const setAutoAdvanceState = (enabled, notify = false) => {
      mState.autoAdvance = Boolean(enabled);
      _safeSetStorage('pm_mobile_auto_advance', mState.autoAdvance ? '1' : '0');
      const chk = document.getElementById('mAutoAdvanceCheck');
      if (chk) chk.checked = mState.autoAdvance;
      const btn = document.getElementById('mViewerAutoAdvanceBtn');
      if (btn) {
        btn.classList.toggle('active', mState.autoAdvance);
        btn.setAttribute('aria-checked', mState.autoAdvance ? 'true' : 'false');
      }
      if (notify) {
        showToast(mState.autoAdvance ? '⚡ 評価後の自動次送りをONにしました' : '評価後の自動次送りをOFFにしました', 1800);
      }
    };
    document.getElementById('mAutoAdvanceCheck')?.addEventListener('change', (e) => {
      setAutoAdvanceState(e.target.checked, false);
    });
    document.getElementById('mViewerAutoAdvanceBtn')?.addEventListener('click', () => {
      setAutoAdvanceState(!mState.autoAdvance, true);
    });

    document.querySelectorAll('[data-viewer-rate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        rateCurrentViewerPhoto(btn.dataset.viewerRate);
      });
    });

    setupViewerTouchGestures();

    // タグ & Exif ボトムシート
    document.getElementById('mCloseInfoSheetBtn')?.addEventListener('click', closeInfoSheet);
    document.getElementById('mInfoSheetOverlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'mInfoSheetOverlay') closeInfoSheet();
    });
    document.getElementById('mAddNewTagBtn')?.addEventListener('click', () => {
      const input = document.getElementById('mNewTagInput');
      const val = input ? input.value.trim() : '';
      if (!val) return;
      input.value = '';
      if (mState.selectMode && !mState.viewerOpen) {
        addTagBatchAction(val);
      } else {
        const photo = getActiveViewerPhoto();
        if (photo) addTagToPhotoAction(photo, val);
      }
    });

    // DB読込 & 同期モーダル
    const dbOverlay = document.getElementById('mDbSyncOverlay');
    const openDbModal = () => {
      updatePendingBadgeUI();
      if (typeof _refreshWifiStatusBox === 'function') _refreshWifiStatusBox();
      if (dbOverlay) dbOverlay.style.display = 'flex';
    };
    const closeDbModal = () => {
      if (dbOverlay) dbOverlay.style.display = 'none';
    };
    document.getElementById('mOpenDbModalBtn')?.addEventListener('click', openDbModal);
    document.getElementById('mCloseDbSyncBtn')?.addEventListener('click', closeDbModal);
    document.getElementById('mOpenFieldLogFromSettingsBtn')?.addEventListener('click', () => {
      closeDbModal();
      window.TetheractTouchUI?.openFieldLogScreen?.();
    });
    dbOverlay?.addEventListener('click', (e) => {
      if (e.target === dbOverlay) closeDbModal();
    });

    const dbFileInput = document.getElementById('mDbFileInput');
    document.getElementById('mSelectDbFileBtn')?.addEventListener('click', () => {
      if (window.TetheractNative && typeof window.TetheractNative.selectUsbFolderAndSync === 'function') {
        closeDbModal();
        setLoading(true, 'USBフォルダを選択してください...', 'Tetheract フォルダ（cache と Loome を含む親フォルダ）を選択すると原本リンクとカタログ自動取込（母艦→モバイル専用）が有効になります');
        window.TetheractNative.selectUsbFolderAndSync();
        return;
      }
      dbFileInput?.click();
    });
    const runUnifiedUplink = async (rawUrlInput = '') => {
      if (rawUrlInput && window.TetheractNative && typeof window.TetheractNative.saveWifiPairingJson === 'function') {
        const saveRes = JSON.parse(window.TetheractNative.saveWifiPairingJson(rawUrlInput) || '{}');
        if (!saveRes.ok) {
          showToast(saveRes.error || '接続URLの形式が正しくありません', 4000);
          return;
        }
        _refreshWifiStatusBox();
      }
      closeDbModal();
      if (window.TetheractTouchUI && typeof window.TetheractTouchUI.triggerQuickDeltaUplink === 'function') {
        await window.TetheractTouchUI.triggerQuickDeltaUplink();
      } else {
        await _triggerAndroidWifiLockerSync('');
      }
    };
    document.getElementById('mWelcomeWifiSyncBtn')?.addEventListener('click', () => {
      runUnifiedUplink('');
    });
    document.getElementById('mRunWifiSyncBtn')?.addEventListener('click', () => {
      const inp = document.getElementById('mWifiUrlInput');
      const val = inp ? inp.value.trim() : '';
      runUnifiedUplink(val);
    });
    document.getElementById('mDownloadNativeApkBtn')?.addEventListener('click', async () => {
      if (!window.TetheractAdapter || typeof window.TetheractAdapter.openPcApkDownloadInBrowser !== 'function') {
        showToast('この環境ではAPKの直接ダウンロードに対応していません');
        return;
      }
      const res = await window.TetheractAdapter.openPcApkDownloadInBrowser();
      if (res && res.ok) {
        showToast('ブラウザで最新APKのダウンロードを開始しました', 4000);
      } else {
        showToast((res && res.error) || 'APKダウンロードの起動に失敗しました', 4000);
      }
    });
    document.getElementById('mSaveWifiUrlBtn')?.addEventListener('click', () => {
      const inp = document.getElementById('mWifiUrlInput');
      const val = inp ? inp.value.trim() : '';
      if (!val) {
        showToast('PCの接続URL（http://192.168.x.x:8088/m?t=...）を入力してください');
        inp?.focus();
        return;
      }
      runUnifiedUplink(val);
    });
    document.getElementById('mWelcomeLoadDbBtn')?.addEventListener('click', () => {
      if (window.TetheractNative && typeof window.TetheractNative.selectUsbFolderAndSync === 'function') {
        closeDbModal();
        setLoading(true, 'USBフォルダを選択してください...', 'Tetheract フォルダ（cache と Loome を含む親フォルダ）を選択すると原本リンクとカタログ自動取込（母艦→モバイル専用）が有効になります');
        window.TetheractNative.selectUsbFolderAndSync();
        return;
      }
      dbFileInput?.click();
    });
    dbFileInput?.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        closeDbModal();
        loadLocalSqliteFile(file);
      }
      e.target.value = '';
    });

    document.getElementById('mExportSyncJsonBtn')?.addEventListener('click', exportSyncJsonFile);
    document.getElementById('mShareSyncJsonBtn')?.addEventListener('click', shareSyncJsonFile);
    document.getElementById('mCopySyncJsonBtn')?.addEventListener('click', copySyncJsonToClipboard);
    document.getElementById('mExportFullDbBtn')?.addEventListener('click', exportFullSqliteDbFile);

    let clearConfirmUntil = 0;
    document.getElementById('mClearPendingBtn')?.addEventListener('click', () => {
      if (getPendingChangesCount() === 0) return;
      const now = Date.now();
      if (now > clearConfirmUntil) {
        clearConfirmUntil = now + 3500;
        showToast('もう一度タップすると未反映の変更履歴をリセットします', 3200);
        return;
      }
      clearConfirmUntil = 0;
      if (_hasNativeJournal() && typeof window.TetheractNative.clearPendingChangesJson === 'function') {
        window.TetheractNative.clearPendingChangesJson();
      }
      mState.pendingChanges.items = {};
      mState.pendingBakedAdjustMap = { byId: {}, byKey: {} };
      savePendingChangesToStorage();
      _refreshPendingBakedAdjustMap();
      const completeBox = document.getElementById('mExportCompleteBox');
      if (completeBox) completeBox.style.display = 'none';
      showToast('変更履歴をリセットしました');
    });

    // Android ジェスチャーナビゲーション（戻る操作）の階層ハンドラ
    window.__handleAndroidBack = function () {
      if (Array.isArray(window.__extraBackHandlers)) {
        for (const fn of [...window.__extraBackHandlers].reverse()) { if (fn() === 'handled') return 'handled'; }
      }
      const infoOverlay = document.getElementById('mInfoSheetOverlay');
      if (infoOverlay && infoOverlay.style.display !== 'none') {
        closeInfoSheet();
        return 'handled';
      }
      if (dbOverlay && dbOverlay.style.display !== 'none') {
        closeDbModal();
        return 'handled';
      }
      const duelModal = document.getElementById('tTouchDuelModal') || document.querySelector('.t-duel-modal');
      if (duelModal && duelModal.style.display !== 'none') {
        if (window.TetheractTouchUI && window.TetheractTouchUI.duel && typeof window.TetheractTouchUI.duel.closeDuel === 'function') {
          window.TetheractTouchUI.duel.closeDuel();
        } else {
          duelModal.style.display = 'none';
        }
        if (window.TetheractTouchUI && typeof window.TetheractTouchUI.setThumbBarMode === 'function') {
          window.TetheractTouchUI.setThumbBarMode('cull');
        }
        return 'handled';
      }
      if (window.TetheractTouchUI && typeof window.TetheractTouchUI.getThumbBarMode === 'function' && window.TetheractTouchUI.getThumbBarMode() === 'adjust') {
        window.TetheractTouchUI.setThumbBarMode('cull');
        return 'handled';
      }
      const viewerModal = document.getElementById('mViewerModal');
      if (mState.viewerOpen || (viewerModal && viewerModal.style.display !== 'none')) {
        closeViewer();
        return 'handled';
      }
      const navSheetOverlay = document.getElementById('tTouchNavSheetOverlay');
      if (navSheetOverlay && navSheetOverlay.style.display !== 'none') {
        if (window.TetheractTouchUI && typeof window.TetheractTouchUI.closePerspectiveSheet === 'function') {
          window.TetheractTouchUI.closePerspectiveSheet();
        } else {
          navSheetOverlay.style.display = 'none';
        }
        return 'handled';
      }
      const tabletStage = document.getElementById('tTabletStage');
      if (tabletStage && tabletStage.classList.contains('is-open')) {
        document.getElementById('tTabletStageCloseBtn')?.click();
        return 'handled';
      }
      const drawer = document.getElementById('mDrawer');
      if (drawer && drawer.classList.contains('open')) {
        closeDrawer();
        return 'handled';
      }
      if (mState.artFramerPickMode) {
        setArtFramerPickMode(false);
        return 'handled';
      }
      if (mState.selectMode) {
        setSelectMode(false);
        if (window.TetheractTouchUI && typeof window.TetheractTouchUI.updateSelectionCount === 'function') {
          window.TetheractTouchUI.updateSelectionCount(0);
        }
        return 'handled';
      }
      return 'root';
    };

    window.__showAndroidExitHint = function () {
      showToast('もう一度戻る操作をするとアプリを終了します');
    };
    window.__exportSyncToAndroidUsb = exportSyncJsonFile;
    window.__syncLockerOverWifi = () => _triggerAndroidWifiLockerSync('');
  }

  async function _setupBrowserToNativeAppBanner() {
    if (window.TetheractNative) return;
    const banner = document.getElementById('mOpenInNativeAppBanner');
    const btn = document.getElementById('mOpenInNativeAppBtn');
    const apkBtn = document.getElementById('mDownloadApkBannerBtn');
    if (!banner || !btn) return;
    try {
      const u = new URL(window.location.href);
      const qToken = u.searchParams.get('t') || '';
      const serverOrigin = `${u.protocol}//${u.host}`;
      let deepLink = `tetheract://pair?server=${encodeURIComponent(serverOrigin)}&token=${encodeURIComponent(qToken)}`;
      let effectiveToken = qToken;
      try {
        const res = await fetch('/api/mobile/pair-info');
        if (res.ok) {
          const info = await res.json();
          if (info && info.deep_link) {
            deepLink = info.deep_link;
            if (!effectiveToken) {
              try {
                effectiveToken = new URL(info.deep_link).searchParams.get('token') || '';
              } catch (parseErr) {}
            }
          }
        }
      } catch (e) {}
      btn.setAttribute('href', deepLink);
      // LANダウンロードは認証トークン必須のためAPKリンクにも有効トークンを付与する
      if (apkBtn && effectiveToken) {
        apkBtn.setAttribute('href', `/api/mobile/apk?t=${encodeURIComponent(effectiveToken)}`);
      }
      banner.style.display = 'flex';
    } catch (e) {}
  }

  // DOMContentLoaded で起動
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileApp);
  } else {
    initMobileApp();
  }
})();
