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
  const GRID_CHUNK_SIZE = 120;
  const PENDING_STORAGE_KEY = 'pm_mobile_pending_changes_v1';

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
    gridCols: 3, // 2 | 3 | 4
    searchQuery: '',
    sortBy: 'date_taken DESC',
    includeTags: [],
    excludeTags: [],
    untaggedOnly: false,
    yearMonth: '',
    cameraModel: '',
    country: '',
    stateName: '',
    city: '',
    noLocationOnly: false,

    // フィルタ候補一覧
    availableTags: [],
    untaggedCount: 0,
    timelineList: [],
    cameraList: [],
    locationTree: [],
    noLocationCount: 0,

    // 複数選択モード
    selectMode: false,
    selectedIds: new Set(),

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
    lastServerUrl: '',
    serverCandidates: [],
    tagTreeExpandedPaths: new Set(),
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
      (port !== '8088' || /Android/i.test(navigator.userAgent || ''));
    return Boolean(
      window.__PM_STANDALONE_HTML__ ||
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

  function recordPendingChange(photo, changeType, value) {
    if (!photo || !photo.id) return;
    const key = String(photo.id);
    if (!mState.pendingChanges.items[key]) {
      mState.pendingChanges.items[key] = {
        photo_id: photo.id,
        file_path: photo.file_path || '',
        file_name: photo.file_name || '',
        date_taken: photo.date_taken || '',
        rating: undefined,
        add_tags: [],
        remove_tags: [],
      };
    }
    const item = mState.pendingChanges.items[key];
    if (changeType === 'rating') {
      item.rating = Number(value);
    } else if (changeType === 'add_tag') {
      const tag = String(value).trim();
      item.remove_tags = (item.remove_tags || []).filter((t) => t !== tag);
      if (!item.add_tags.includes(tag)) {
        item.add_tags.push(tag);
      }
    } else if (changeType === 'remove_tag') {
      const tag = String(value).trim();
      item.add_tags = (item.add_tags || []).filter((t) => t !== tag);
      if (!item.remove_tags.includes(tag)) {
        item.remove_tags.push(tag);
      }
    }
    savePendingChangesToStorage();
  }

  function getPendingChangesCount() {
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
    const box = document.getElementById('mPendingSummaryBox');
    if (box) {
      box.innerHTML = `未反映の変更: <strong>${cnt}件の写真</strong>`;
    }
  }

  // ==================== 初期化 & モード判定 ====================

  async function initMobileApp() {
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

    // PC上でのプレビュー表示 (/m) の場合のみ同一オリジンサーバー接続を試行
    const connected = await tryConnectServer();
    if (!connected) {
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
    if ([2, 3, 4].includes(cols)) {
      mState.gridCols = cols;
      updateGridColsUI();
    }
    const savedAuto = _safeGetStorage('pm_mobile_auto_advance', null);
    if (savedAuto !== null) {
      mState.autoAdvance = savedAuto === '1';
      const chk = document.getElementById('mAutoAdvanceCheck');
      if (chk) chk.checked = mState.autoAdvance;
    }
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
      await refreshAllData();
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
   * 単体HTML (PhotoManager_Mobile.html) では内蔵Base64から直接メモリ展開し、
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
      // photosテーブルの存在確認
      const check = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='photos'");
      if (!check || check.length === 0) {
        db.close();
        throw new Error('有効な Photo Manager データベース (photosテーブル) が見つかりません');
      }

      mState.localDb = db;
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
      alert('DBの読み込みに失敗しました: ' + (err.message || err));
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

  /**
   * 写真のサムネイルURLを取得する（serverモード時はAPI URL、localdbモード時はBLOBからObjectURLを生成）
   */
  function getMobileThumbnailUrl(photo) {
    if (!photo) return '';
    if (mState.mode === 'server') {
      const rot = photo.rotation || 0;
      const fa = Math.round((Number(photo.fine_angle) || 0) * 10);
      const mtime = Math.floor(photo.file_mtime || 0);
      const crop = photo.crop_w
        ? `${Math.round((photo.crop_x || 0) * 1000)}_${Math.round((photo.crop_y || 0) * 1000)}_${Math.round(photo.crop_w * 1000)}_${Math.round((photo.crop_h || 0) * 1000)}`
        : '0';
      const tone = `${photo.brightness || 0}_${photo.contrast || 0}_${photo.saturation || 0}`;
      const ver = `${photo.file_size || photo.id}_${mtime}_r${rot}_fa${fa}_c${crop}_t${tone}`;
      return `/api/photo/${photo.id}/thumbnail?v=${ver}`;
    }

    // localdb モード: thumbnails テーブルの BLOB (WebP) から ObjectURL を生成してキャッシュ
    const pid = Number(photo.id);
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

  // ==================== データ取得（Server / LocalDB 統一レイヤー） ====================

  async function refreshAllData() {
    if (mState.mode === 'offline') return;
    await Promise.all([fetchPhotosData(), fetchFilterSummaries()]);
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
      if (mState.yearMonth) params.set('year_month', mState.yearMonth);
      if (mState.cameraModel) params.set('cameras', mState.cameraModel);
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
      mState.photos = data.photos || [];
      renderPhotoGrid();
      updateHeaderCounters();
      renderActiveFilterChips();
    } catch (e) {
      console.error('サーバーからの写真取得エラー:', e);
      showToast('⚠️ サーバー通信エラー');
    }
  }

  /**
   * オフライン localdb (sql.js) から写真一覧をSQL検索する
   */
  function fetchPhotosFromLocalDb() {
    if (!mState.localDb) return;

    let sql = `
      SELECT p.*
      FROM photos p
      WHERE IFNULL(p.is_unlinked, 0) = 0
    `;
    const params = [];

    // 評価フィルタ (-1:棄, 0:可, 1:良, 2:優)
    if (mState.ratingFilter === 'default') {
      sql += ' AND p.rating IN (0, 1, 2)';
    } else if (mState.ratingFilter !== 'all') {
      sql += ' AND p.rating = ?';
      params.push(Number(mState.ratingFilter));
    }

    // スタック集約
    if (mState.stacked) {
      sql += ' AND (p.stack_id IS NULL OR p.is_stack_primary = 1)';
    }

    // ファイル名検索
    if (mState.searchQuery) {
      sql += ' AND p.file_name LIKE ?';
      params.push(`%${mState.searchQuery}%`);
    }

    // 年月フィルタ
    if (mState.yearMonth) {
      sql += ' AND p.year_month = ?';
      params.push(mState.yearMonth);
    }

    // カメラ機種フィルタ
    if (mState.cameraModel) {
      sql += ' AND p.camera_model = ?';
      params.push(mState.cameraModel);
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
      sql += ' AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)';
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

    // タグ一覧とスタック情報を一括付与
    if (rows.length > 0) {
      const photoIds = rows.map((r) => r.id);
      const tagsMap = new Map();

      // 900件ずつチャンク化して photo_tags を取得
      for (let i = 0; i < photoIds.length; i += 900) {
        const chunk = photoIds.slice(i, i + 900);
        const ph = chunk.map(() => '?').join(',');
        const tagRows = queryLocalDbObjects(
          `SELECT photo_id, tag FROM photo_tags WHERE photo_id IN (${ph}) ORDER BY tag`,
          chunk
        );
        for (const tr of tagRows) {
          if (!tagsMap.has(tr.photo_id)) tagsMap.set(tr.photo_id, []);
          tagsMap.get(tr.photo_id).push(tr.tag);
        }
      }

      // スタックメンバー情報の取得
      const stackIds = [
        ...new Set(rows.filter((r) => r.stack_id != null).map((r) => r.stack_id)),
      ];
      const stackMembersMap = new Map();
      if (mState.stacked && stackIds.length > 0) {
        for (let i = 0; i < stackIds.length; i += 900) {
          const chunk = stackIds.slice(i, i + 900);
          const ph = chunk.map(() => '?').join(',');
          const memberRows = queryLocalDbObjects(
            `SELECT * FROM photos WHERE stack_id IN (${ph}) AND IFNULL(is_unlinked, 0) = 0 ORDER BY date_taken ASC, subsec_time ASC, id ASC`,
            chunk
          );
          for (const mr of memberRows) {
            mr.tags = tagsMap.get(mr.id) || [];
            if (!stackMembersMap.has(mr.stack_id)) stackMembersMap.set(mr.stack_id, []);
            stackMembersMap.get(mr.stack_id).push(mr);
          }
        }
      }

      for (const r of rows) {
        r.tags = tagsMap.get(r.id) || [];
        if (mState.stacked && r.stack_id && stackMembersMap.has(r.stack_id)) {
          const members = stackMembersMap.get(r.stack_id);
          r.stack_count = members.length;
          r.stack_photos = members;
        } else {
          r.stack_count = 1;
          r.stack_photos = [];
        }
      }
    }

    mState.photos = rows;
    renderPhotoGrid();
    updateHeaderCounters();
    renderActiveFilterChips();
  }

  /**
   * タグ・タイムライン・ジオタグ・カメラ機種の集計を取得する
   */
  async function fetchFilterSummaries() {
    if (mState.mode === 'server') {
      try {
        const [tagsRes, tlRes, camRes, locRes] = await Promise.all([
          fetch('/api/tags'),
          fetch('/api/timeline'),
          fetch('/api/cameras'),
          fetch('/api/locations/tree'),
        ]);
        if (tagsRes.ok) {
          const d = await tagsRes.json();
          mState.availableTags = d.tags || [];
          mState.untaggedCount = d.untagged_count || 0;
        }
        if (tlRes.ok) {
          const d = await tlRes.json();
          mState.timelineList = d.timeline || [];
        }
        if (camRes.ok) {
          const d = await camRes.json();
          mState.cameraList = d.cameras || [];
        }
        if (locRes.ok) {
          const d = await locRes.json();
          mState.locationTree = d.tree || d.locations || [];
          mState.noLocationCount = d.no_location_count || 0;
        }
      } catch (e) {
        console.warn('フィルタ集計の取得エラー:', e);
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      // タグ集計
      mState.availableTags = queryLocalDbObjects(`
        SELECT pt.tag, COUNT(DISTINCT pt.photo_id) AS count
        FROM photo_tags pt
        INNER JOIN photos p ON p.id = pt.photo_id
        WHERE IFNULL(p.is_unlinked, 0) = 0
        GROUP BY pt.tag
        ORDER BY pt.tag ASC
      `);
      const untaggedRow = queryLocalDbObjects(`
        SELECT COUNT(*) AS cnt FROM photos p
        WHERE IFNULL(p.is_unlinked, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)
      `);
      mState.untaggedCount = untaggedRow[0] ? untaggedRow[0].cnt : 0;

      // タイムライン集計
      mState.timelineList = queryLocalDbObjects(`
        SELECT year_month, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND year_month IS NOT NULL AND year_month != ''
        GROUP BY year_month
        ORDER BY year_month DESC
      `);

      // カメラ機種集計
      mState.cameraList = queryLocalDbObjects(`
        SELECT camera_model, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND camera_model IS NOT NULL AND camera_model != ''
        GROUP BY camera_model
        ORDER BY count DESC
      `);

      // ジオタグ集計
      const locRows = queryLocalDbObjects(`
        SELECT country, state, city, COUNT(*) AS count
        FROM photos
        WHERE IFNULL(is_unlinked, 0) = 0 AND country IS NOT NULL AND country != ''
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
        WHERE IFNULL(is_unlinked, 0) = 0
          AND (latitude IS NULL OR country IS NULL OR country = '' OR (ABS(latitude) < 0.0001 AND ABS(longitude) < 0.0001))
      `);
      mState.noLocationCount = noLocRow[0] ? noLocRow[0].cnt : 0;
    }

    renderDrawerFilters();
  }

  // ==================== グリッド描画（スクロール連動チャンク追加） ====================

  function renderPhotoGrid() {
    const grid = document.getElementById('mPhotoGrid');
    const empty = document.getElementById('mEmptyState');
    if (!grid) return;

    grid.innerHTML = '';
    mState.renderedCount = 0;

    if (mState.photos.length === 0) {
      if (mState.mode !== 'offline') {
        if (empty) empty.style.display = 'flex';
      }
      return;
    }
    if (empty) empty.style.display = 'none';

    appendNextGridChunk();
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

  function createMobilePhotoCard(photo, index) {
    const card = document.createElement('div');
    card.className = 'm-card';
    if (photo.rating === -1) card.classList.add('is-discarded');
    if (mState.selectedIds.has(photo.id)) card.classList.add('selected');
    card.dataset.id = String(photo.id);
    card.dataset.index = String(index);

    const thumbUrl = getMobileThumbnailUrl(photo);
    const rateBadgeHtml = getRateBadgeHtml(photo.rating);

    const topBadges = [];
    if (photo.stack_count && photo.stack_count > 1) {
      topBadges.push(`<span class="m-mini-badge stack-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:2px;"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/></svg>${photo.stack_count}</span>`);
    }
    if (photo.is_raw || photo.paired_raw_path) {
      topBadges.push(`<span class="m-mini-badge">RAW</span>`);
    }

    card.innerHTML = `
      <img src="${_escAttr(thumbUrl)}" alt="${_escAttr(photo.file_name)}" loading="lazy">
      <div class="m-card-check">✓</div>
      <div class="m-card-top-badges">${topBadges.join('')}</div>
      ${rateBadgeHtml}
    `;

    card.addEventListener('click', () => {
      if (mState.selectMode) {
        toggleSelectPhoto(photo.id, card);
      } else {
        openViewerAt(index);
      }
    });

    return card;
  }

  function getRateBadgeHtml(rating) {
    const r = Number(rating || 0);
    if (r === 2) return '<span class="m-card-badge-rate rate-2">★ 優</span>';
    if (r === 1) return '<span class="m-card-badge-rate rate-1">● 良</span>';
    if (r === -1) return '<span class="m-card-badge-rate rate-neg1">✕ 棄</span>';
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

  function updateGridColsUI() {
    const grid = document.getElementById('mPhotoGrid');
    const btn = document.getElementById('mGridColsBtn');
    if (grid) {
      grid.classList.remove('cols-2', 'cols-3', 'cols-4');
      grid.classList.add(`cols-${mState.gridCols}`);
    }
    if (btn) {
      btn.textContent = `⊞ ${mState.gridCols}列`;
    }
  }

  // ==================== フィルタドロワー & アクティブチップ描画 ====================

  function renderDrawerFilters() {
    // 1. タグリスト
    const tagContainer = document.getElementById('mTagFilterList');
    if (tagContainer) {
      let html = `
        <div class="m-filter-item ${mState.untaggedOnly ? 'active-include' : ''}" data-untagged="1">
          <span>未分類の写真</span>
          <span class="m-filter-count">${mState.untaggedCount}</span>
        </div>
      `;
      for (const item of mState.availableTags) {
        const t = item.tag;
        const depth = t.split('/').length - 1;
        const indentPx = depth * 12;
        const isInc = mState.includeTags.includes(t);
        const isExc = mState.excludeTags.includes(t);
        const cls = isInc ? 'active-include' : isExc ? 'active-exclude' : '';
        const prefix = isInc ? '✓ ' : isExc ? '− ' : '';
        html += `
          <div class="m-filter-item ${cls}" style="padding-left:${10 + indentPx}px;" data-tag="${_escAttr(t)}">
            <span>${prefix}${_escHtml(t)}</span>
            <span class="m-filter-count">${item.count}</span>
          </div>
        `;
      }
      tagContainer.innerHTML = html;

      tagContainer.querySelectorAll('.m-filter-item').forEach((el) => {
        el.addEventListener('click', () => {
          if (el.dataset.untagged === '1') {
            mState.untaggedOnly = !mState.untaggedOnly;
            if (mState.untaggedOnly) {
              mState.includeTags = [];
              mState.excludeTags = [];
            }
          } else {
            const tag = el.dataset.tag;
            mState.untaggedOnly = false;
            if (mState.includeTags.includes(tag)) {
              // 含む -> 除外へ遷移
              mState.includeTags = mState.includeTags.filter((x) => x !== tag);
              mState.excludeTags.push(tag);
            } else if (mState.excludeTags.includes(tag)) {
              // 除外 -> 解除へ遷移
              mState.excludeTags = mState.excludeTags.filter((x) => x !== tag);
            } else {
              // 未選択 -> 含むへ遷移
              mState.includeTags.push(tag);
            }
          }
          renderDrawerFilters();
          fetchPhotosData();
        });
      });
    }

    // 2. タイムライン
    const tlContainer = document.getElementById('mTimelineFilterList');
    if (tlContainer) {
      let html = '';
      for (const item of mState.timelineList) {
        const ym = item.year_month;
        const active = mState.yearMonth === ym ? 'active-include' : '';
        html += `
          <div class="m-filter-item ${active}" data-ym="${_escAttr(ym)}">
            <span>${_escHtml(ym)}</span>
            <span class="m-filter-count">${item.count}</span>
          </div>
        `;
      }
      tlContainer.innerHTML = html || '<div class="m-center-sub">データなし</div>';
      tlContainer.querySelectorAll('.m-filter-item').forEach((el) => {
        el.addEventListener('click', () => {
          const ym = el.dataset.ym;
          mState.yearMonth = mState.yearMonth === ym ? '' : ym;
          renderDrawerFilters();
          fetchPhotosData();
        });
      });
    }

    // 3. ジオタグ（撮影地）
    const locContainer = document.getElementById('mLocationFilterList');
    if (locContainer) {
      let html = `
        <div class="m-filter-item ${mState.noLocationOnly ? 'active-include' : ''}" data-noloc="1">
          <span>ジオタグなし</span>
          <span class="m-filter-count">${mState.noLocationCount}</span>
        </div>
      `;
      for (const c of mState.locationTree) {
        const cActive =
          !mState.noLocationOnly && mState.country === c.country && !mState.stateName
            ? 'active-include'
            : '';
        html += `
          <div class="m-filter-item ${cActive}" data-country="${_escAttr(c.country)}">
            <span>${_escHtml(c.country)}</span>
            <span class="m-filter-count">${c.count}</span>
          </div>
        `;
        for (const s of c.states || []) {
          const sActive =
            !mState.noLocationOnly &&
            mState.country === c.country &&
            mState.stateName === s.state &&
            !mState.city
              ? 'active-include'
              : '';
          html += `
            <div class="m-filter-item ${sActive}" style="padding-left:22px;" data-country="${_escAttr(c.country)}" data-state="${_escAttr(s.state)}">
              <span>└ ${_escHtml(s.state)}</span>
              <span class="m-filter-count">${s.count}</span>
            </div>
          `;
        }
      }
      locContainer.innerHTML = html;
      locContainer.querySelectorAll('.m-filter-item').forEach((el) => {
        el.addEventListener('click', () => {
          if (el.dataset.noloc === '1') {
            mState.noLocationOnly = !mState.noLocationOnly;
            mState.country = '';
            mState.stateName = '';
            mState.city = '';
          } else {
            mState.noLocationOnly = false;
            const c = el.dataset.country || '';
            const s = el.dataset.state || '';
            if (mState.country === c && mState.stateName === s) {
              mState.country = '';
              mState.stateName = '';
              mState.city = '';
            } else {
              mState.country = c;
              mState.stateName = s;
              mState.city = '';
            }
          }
          renderDrawerFilters();
          fetchPhotosData();
        });
      });
    }

    // 4. カメラ機種
    const camContainer = document.getElementById('mCameraFilterList');
    if (camContainer) {
      let html = '';
      for (const item of mState.cameraList) {
        const cm = item.camera_model;
        const active = mState.cameraModel === cm ? 'active-include' : '';
        html += `
          <div class="m-filter-item ${active}" data-cam="${_escAttr(cm)}">
            <span>${_escHtml(cm)}</span>
            <span class="m-filter-count">${item.count}</span>
          </div>
        `;
      }
      camContainer.innerHTML = html || '<div class="m-center-sub">データなし</div>';
      camContainer.querySelectorAll('.m-filter-item').forEach((el) => {
        el.addEventListener('click', () => {
          const cm = el.dataset.cam;
          mState.cameraModel = mState.cameraModel === cm ? '' : cm;
          renderDrawerFilters();
          fetchPhotosData();
        });
      });
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
    if (mState.yearMonth) {
      chips.push({
        label: `${mState.yearMonth}`,
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
      chips.push({
        label: `${mState.cameraModel}`,
        clear: () => {
          mState.cameraModel = '';
        },
      });
    }

    if (dot) {
      dot.style.display = chips.length > 0 ? 'block' : 'none';
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
    mState.cameraModel = '';
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

  function setSelectMode(enabled) {
    mState.selectMode = enabled;
    document.body.classList.toggle('m-select-mode', enabled);
    document.getElementById('mSelectModeBtn').classList.toggle('active', enabled);
    document.getElementById('mBatchBar').style.display = enabled ? 'block' : 'none';
    if (!enabled) {
      mState.selectedIds.clear();
      document.querySelectorAll('.m-card.selected').forEach((el) => el.classList.remove('selected'));
    }
    updateBatchCountLabel();
  }

  function toggleSelectPhoto(photoId, cardEl) {
    if (mState.selectedIds.has(photoId)) {
      mState.selectedIds.delete(photoId);
      if (cardEl) cardEl.classList.remove('selected');
    } else {
      mState.selectedIds.add(photoId);
      if (cardEl) cardEl.classList.add('selected');
    }
    updateBatchCountLabel();
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
      mState.localDb.run('BEGIN TRANSACTION');
      try {
        for (const pid of ids) {
          mState.localDb.run('UPDATE photos SET rating = ? WHERE id = ?', [r, pid]);
          const pObj = mState.photos.find((p) => p.id === pid);
          if (pObj) recordPendingChange(pObj, 'rating', r);
        }
        mState.localDb.run('COMMIT');
      } catch (e) {
        try {
          mState.localDb.run('ROLLBACK');
        } catch (re) {}
      }
    }

    // メモリ上の配列とDOMを更新
    for (const pid of ids) {
      const pObj = mState.photos.find((p) => p.id === pid);
      if (pObj) pObj.rating = r;
      updateCardRateBadgeInDom(pid, r);
    }

    const rateNames = { 2: '★ 優', 1: '● 良', 0: '○ 可', '-1': '✕ 棄' };
    showToast(`${ids.length}枚を「${rateNames[r]}」に設定しました`);
  }

  // ==================== フルスクリーン選別ビューア ====================

  function getActiveViewerPhoto() {
    if (mState.viewerStackMember) return mState.viewerStackMember;
    if (mState.viewerIndex >= 0 && mState.viewerIndex < mState.photos.length) {
      return mState.photos[mState.viewerIndex];
    }
    return null;
  }

  function openViewerAt(index) {
    if (index < 0 || index >= mState.photos.length) return;
    mState.viewerIndex = index;
    mState.viewerStackMember = null;
    mState.viewerOpen = true;
    resetViewerZoom();

    const modal = document.getElementById('mViewerModal');
    if (modal) modal.style.display = 'flex';
    renderViewerCurrentPhoto();
  }

  function closeViewer() {
    mState.viewerOpen = false;
    mState.viewerStackMember = null;
    const modal = document.getElementById('mViewerModal');
    if (modal) modal.style.display = 'none';
  }

  function stepViewer(delta) {
    const nextIdx = mState.viewerIndex + delta;
    if (nextIdx < 0 || nextIdx >= mState.photos.length) {
      if (delta > 0) showToast('最後の写真です');
      return;
    }
    mState.viewerIndex = nextIdx;
    mState.viewerStackMember = null;
    resetViewerZoom();

    // グリッド側も未描画領域に入ったらチャンクを追加しておく
    if (nextIdx >= mState.renderedCount - 15) {
      appendNextGridChunk();
    }
    renderViewerCurrentPhoto();
  }

  function renderViewerCurrentPhoto() {
    const primaryPhoto = mState.photos[mState.viewerIndex];
    const activePhoto = getActiveViewerPhoto();
    if (!activePhoto || !primaryPhoto) return;

    document.getElementById('mViewerFileName').textContent = activePhoto.file_name || '';
    document.getElementById('mViewerCounter').textContent = `${mState.viewerIndex + 1} / ${mState.photos.length}`;

    const imgEl = document.getElementById('mViewerImg');
    if (imgEl) {
      imgEl.src = getMobileThumbnailUrl(activePhoto);
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
        stackList.innerHTML = members
          .map((m, idx) => {
            const isAct = m.id === activePhoto.id ? 'active' : '';
            const rIcon =
              m.rating === 2 ? '★' : m.rating === 1 ? '●' : m.rating === -1 ? '✕' : '';
            let label = `#${idx + 1}`;
            if (primaryPhoto.stack_type === 'bracket' && m.exposure_bias != null) {
              const ev = Number(m.exposure_bias);
              label = `${ev > 0 ? '+' : ''}${ev.toFixed(1)}EV`;
            } else if (m.is_raw) {
              label += ' RAW';
            }
            return `<button class="m-stack-pill ${isAct}" data-member-idx="${idx}">${_escHtml(label)} ${rIcon}</button>`;
          })
          .join('');

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
      } else {
        stackBar.style.display = 'none';
        stackList.innerHTML = '';
      }
    }
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

    // ⚡ 自動送りONかつスタック個別コマ選択中でなければ次の写真へ自動進行
    if (mState.autoAdvance && mState.viewerIndex < mState.photos.length - 1) {
      setTimeout(() => {
        if (mState.viewerOpen) stepViewer(1);
      }, 160);
    }
  }

  // ==================== ビューアのタッチスワイプ & ダブルタップズーム ====================

  function resetViewerZoom() {
    mState.zoomScale = 1;
    mState.panX = 0;
    mState.panY = 0;
    applyViewerTransform();
  }

  function applyViewerTransform() {
    const wrap = document.getElementById('mViewerImgWrapper');
    if (!wrap) return;
    wrap.style.transform = `translate3d(${mState.panX}px, ${mState.panY}px, 0) scale(${mState.zoomScale})`;
  }

  function setupViewerTouchGestures() {
    const stage = document.getElementById('mViewerStage');
    if (!stage) return;

    let startX = 0;
    let startY = 0;
    let lastTapTime = 0;
    let isDragging = false;

    stage.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        isDragging = true;
      },
      { passive: true }
    );

    stage.addEventListener(
      'touchmove',
      (e) => {
        if (!isDragging || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;

        if (mState.zoomScale > 1) {
          mState.panX += dx;
          mState.panY += dy;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
          applyViewerTransform();
        }
      },
      { passive: true }
    );

    stage.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      isDragging = false;

      const now = Date.now();
      const endTouch = e.changedTouches[0];
      const dx = endTouch ? endTouch.clientX - startX : 0;
      const dy = endTouch ? endTouch.clientY - startY : 0;

      // ダブルタップ判定（移動量が小さい場合）
      if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
        if (now - lastTapTime < 280) {
          if (mState.zoomScale > 1) {
            resetViewerZoom();
          } else {
            mState.zoomScale = 2.5;
            mState.panX = 0;
            mState.panY = 0;
            applyViewerTransform();
          }
          lastTapTime = 0;
          return;
        }
        lastTapTime = now;
      }

      // 等倍時の左右スワイプで前後の写真へ移動
      if (mState.zoomScale === 1 && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
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

    const treeRoot = buildMobileTagTree(mState.availableTags || []);

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
          : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" style="vertical-align:-1px;margin-right:3px;"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
        const badgeLabel = isBatchMode
          ? '＋ 一括追加'
          : hasTag
          ? '✓ 付与中'
          : hasChildren
          ? '＋ 親付与'
          : '＋ 追加';

        row.innerHTML = `
          <span class="m-tree-row-left">
            ${arrowHtml}
            <span class="m-tree-name">${icon} ${_escHtml(node.name)}</span>
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
      currentTagsEl.innerHTML =
        '<span style="font-size:12px; color:var(--text-muted, #9ca6b5);">下のタグツリーをタップまたは子タグ入力すると選択中の全写真に一括追加されます</span>';
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
        const res = await fetch(`/api/photo/${photo.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag }),
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
    await fetchFilterSummaries();
    renderSinglePhotoInfoSheet(photo);
    showToast(`#${tag} を追加しました`);
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
        photo.tags =
          data.tags || (photo.tags || []).filter((t) => t !== tag && !t.startsWith(`${tag}/`));
      } catch (e) {
        showToast('! タグ削除エラー');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
      mState.localDb.run('DELETE FROM photo_tags WHERE photo_id = ? AND (tag = ? OR tag LIKE ?)', [
        photo.id,
        tag,
        `${tag}/%`,
      ]);
      photo.tags = (photo.tags || []).filter((t) => t !== tag && !t.startsWith(`${tag}/`));
      recordPendingChange(photo, 'remove_tag', tag);
    }

    renderSinglePhotoInfoSheet(photo);
    renderViewerCurrentPhoto();
    await fetchFilterSummaries();
    renderSinglePhotoInfoSheet(photo);
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
        const res = await fetch('/api/photos/batch-tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: ids, tag, action: 'add' }),
        });
        if (!res.ok) throw new Error('一括タグ追加失敗');
      } catch (e) {
        showToast('! 一括タグ追加エラー');
        return;
      }
    } else if (mState.mode === 'localdb' && mState.localDb) {
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
          if (pObj) recordPendingChange(pObj, 'add_tag', tag);
        }
        mState.localDb.run('COMMIT');
      } catch (e) {
        try {
          mState.localDb.run('ROLLBACK');
        } catch (re) {}
      }
    }

    for (const pid of ids) {
      const pObj = mState.photos.find((p) => p.id === pid);
      if (pObj) {
        pObj.tags = [...new Set([...(pObj.tags || []), ...expanded])].sort();
      }
    }
    renderBatchTagSheet();
    await fetchFilterSummaries();
    renderBatchTagSheet();
    showToast(`${ids.length}枚に #${tag} を追加しました`);
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

    // 1. 保存先フォルダ（USBメモリ等）を直接選べる場合はネイティブ保存ダイアログを開く
    if (typeof window.showSaveFilePicker === 'function') {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: 'mobile_sync.json',
          types: [
            {
              description: 'Photo Manager 選別差分ファイル',
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
          alert(
            'USBへの直接書き込み完了確認に失敗したため、通常のファイルダウンロードに切り替えます。\n詳細: ' +
              (writeErr.message || writeErr)
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
            text: `Photo Manager 選別差分データ (${cnt}件)`,
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
      alert('コピーに失敗しました。ファイル保存をご利用ください。');
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
      alert('DB書き出しエラー: ' + e.message);
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
    document.getElementById('mOpenDrawerBtn')?.addEventListener('click', openDrawer);
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

    // ソート順
    document.getElementById('mSortSelect')?.addEventListener('change', (e) => {
      mState.sortBy = e.target.value;
      fetchPhotosData();
    });

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

    // スクロール連動チャンク描画
    const scrollContainer = document.getElementById('mScrollContainer');
    scrollContainer?.addEventListener(
      'scroll',
      () => {
        if (
          scrollContainer.scrollTop + scrollContainer.clientHeight >=
          scrollContainer.scrollHeight - 600
        ) {
          appendNextGridChunk();
        }
      },
      { passive: true }
    );

    // ビューア操作
    document.getElementById('mViewerCloseBtn')?.addEventListener('click', closeViewer);
    document.getElementById('mViewerPrevBtn')?.addEventListener('click', () => stepViewer(-1));
    document.getElementById('mViewerNextBtn')?.addEventListener('click', () => stepViewer(1));
    document
      .getElementById('mViewerOpenInfoBtn')
      ?.addEventListener('click', () => openInfoSheet(false));

    document.getElementById('mAutoAdvanceCheck')?.addEventListener('change', (e) => {
      mState.autoAdvance = e.target.checked;
      _safeSetStorage('pm_mobile_auto_advance', mState.autoAdvance ? '1' : '0');
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
      if (dbOverlay) dbOverlay.style.display = 'flex';
    };
    const closeDbModal = () => {
      if (dbOverlay) dbOverlay.style.display = 'none';
    };
    document.getElementById('mOpenDbModalBtn')?.addEventListener('click', openDbModal);
    document.getElementById('mCloseDbSyncBtn')?.addEventListener('click', closeDbModal);
    dbOverlay?.addEventListener('click', (e) => {
      if (e.target === dbOverlay) closeDbModal();
    });

    const dbFileInput = document.getElementById('mDbFileInput');
    document.getElementById('mSelectDbFileBtn')?.addEventListener('click', () => {
      dbFileInput?.click();
    });
    document.getElementById('mWelcomeLoadDbBtn')?.addEventListener('click', () => {
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

    document.getElementById('mClearPendingBtn')?.addEventListener('click', () => {
      if (getPendingChangesCount() === 0) return;
      if (confirm('端末内に記録されている未反映の変更履歴をリセットしますか？')) {
        mState.pendingChanges.items = {};
        savePendingChangesToStorage();
        const completeBox = document.getElementById('mExportCompleteBox');
        if (completeBox) completeBox.style.display = 'none';
        showToast('変更履歴をリセットしました');
      }
    });
  }

  // DOMContentLoaded で起動
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileApp);
  } else {
    initMobileApp();
  }
})();
