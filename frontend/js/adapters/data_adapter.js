/**
 * Tetheract Photo Manager - Layer 1: Data Adapter (window.TetheractAdapter)
 *
 * 3つの実行モード（android_native / http_api / wasm_sqlite）を自動判別し、
 * 上位レイヤー（Core Domain / View）に対して統一された非同期データAPIを提供する。
 * ※ Layer 1 規約により、本ファイル内で DOM 要素の直接参照・操作は一切行わない。
 */

(function (global) {
  'use strict';

  const PENDING_STORAGE_KEY = 'pm_mobile_pending_changes_v1';
  const COLOR_TAGS = [
    '赤', '青', '緑', '黄色', '黒', '白',
    '銀・シルバー', '金・ゴールド', '茶色', '紫', 'オレンジ', 'ピンク',
  ];

  const adapterState = {
    mode: null,
    wasmDb: null,
    wasmDbFileName: '',
    wasmLastCachedAt: '',
    thumbUrlCache: new Map(),
    pendingChanges: _loadPendingFromLocalStorage(),
    usbSyncWaiters: [],
  };

  /**
   * ローカルタイムで YYYY-MM-DD HH:MM:SS 文字列を生成する（Date.toISOString 禁止規約準拠）
   */
  function formatLocalTimestamp(dateObj) {
    const d = dateObj instanceof Date ? dateObj : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function _safeGetStorage(key, fallback = null) {
    try {
      const val = global.localStorage ? global.localStorage.getItem(key) : null;
      return val !== null ? val : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function _safeSetStorage(key, val) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(key, String(val));
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function _safeParseJson(jsonStr, fallback = null) {
    if (!jsonStr || typeof jsonStr !== 'string') return fallback;
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      return fallback;
    }
  }

  function _expandTagAncestors(tagStr) {
    const parts = String(tagStr || '').split('/').map((s) => s.trim()).filter(Boolean);
    return parts.map((_, idx) => parts.slice(0, idx + 1).join('/'));
  }

  function _loadPendingFromLocalStorage() {
    const parsed = _safeParseJson(_safeGetStorage(PENDING_STORAGE_KEY, null), null);
    if (parsed && typeof parsed === 'object' && parsed.items) return parsed;
    return { updated_at: formatLocalTimestamp(new Date()), db_name: '', items: {} };
  }

  function _savePendingToLocalStorage() {
    adapterState.pendingChanges.updated_at = formatLocalTimestamp(new Date());
    _safeSetStorage(PENDING_STORAGE_KEY, JSON.stringify(adapterState.pendingChanges));
  }

  function _hasNativeBridge() {
    return Boolean(global.TetheractNative && typeof global.TetheractNative.getLockerStatusJson === 'function');
  }

  function _isLocalStandaloneOrigin() {
    if (!global.location) return true;
    const { protocol: p, hostname: h, port } = global.location;
    const isLocalNonServer = (h === '127.0.0.1' || h === 'localhost') && port && port !== '8088';
    return Boolean(
      global.__PM_STANDALONE_HTML__ ||
        (p !== 'http:' && p !== 'https:') ||
        h === 'appassets.tetheract.local' ||
        isLocalNonServer
    );
  }

  function _dispatchUsbSyncCompleted(resultJson) {
    const result = typeof resultJson === 'string' ? _safeParseJson(resultJson, { ok: false }) : (resultJson || { ok: false });
    for (const resolve of adapterState.usbSyncWaiters.splice(0)) {
      try {
        resolve(result);
      } catch (e) {}
    }
    if (typeof global.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      global.dispatchEvent(new CustomEvent('tetheract:usb-sync-completed', { detail: result }));
    }
  }

  global.__dispatchTetheractUsbSyncCompleted = _dispatchUsbSyncCompleted;
  global.__onTetheractUsbSyncCompleted = _dispatchUsbSyncCompleted;

  /**
   * 現在の実行モード（'android_native' | 'http_api' | 'wasm_sqlite'）を判別する
   */
  async function detectRuntimeMode(options = {}) {
    if (_hasNativeBridge()) {
      adapterState.mode = 'android_native';
      return 'android_native';
    }
    if (!options.forceRecheck && adapterState.mode) return adapterState.mode;
    if (_isLocalStandaloneOrigin()) {
      adapterState.mode = 'wasm_sqlite';
      return 'wasm_sqlite';
    }
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 1500) : null;
      const res = await fetch('/api/version', ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (res && res.ok) {
        adapterState.mode = 'http_api';
        return 'http_api';
      }
    } catch (e) {}
    adapterState.mode = 'wasm_sqlite';
    return 'wasm_sqlite';
  }

  function getRuntimeModeSync() {
    if (_hasNativeBridge()) return 'android_native';
    return adapterState.mode || (_isLocalStandaloneOrigin() ? 'wasm_sqlite' : 'http_api');
  }

  /**
   * スマホ内専用ロッカー・USB接続・未同期件数・アップデート有無のステータスを返す
   */
  async function getLockerStatus() {
    const mode = await detectRuntimeMode();
    if (mode === 'android_native') {
      const p = _safeParseJson(global.TetheractNative.getLockerStatusJson(), {});
      return {
        mode: 'android_native',
        hasLockerDb: Boolean(p.hasLockerDb),
        usbConnected: Boolean(p.usbConnected),
        usbFolderName: String(p.usbFolderName || ''),
        wifiConfigured: Boolean(p.wifiConfigured),
        wifiServerUrl: String(p.wifiServerUrl || ''),
        lastWifiSyncAt: String(p.lastWifiSyncAt || ''),
        dbPhotoCount: Number(p.dbPhotoCount || 0),
        lastCachedAt: String(p.lastCachedAt || ''),
        pendingChangeCount: Number(p.pendingChangeCount || 0),
        availableUpdate: p.availableUpdate || null,
      };
    }
    if (mode === 'http_api') {
      let count = 0;
      try {
        const res = await fetch('/api/stats');
        if (res.ok) {
          const d = await res.json();
          count = Number(d.total_photos || d.count || 0);
        }
      } catch (e) {}
      return {
        mode: 'http_api',
        hasLockerDb: true,
        usbConnected: true,
        usbFolderName: 'PC Server (HTTP)',
        dbPhotoCount: count,
        lastCachedAt: formatLocalTimestamp(new Date()),
        pendingChangeCount: Object.keys(adapterState.pendingChanges.items || {}).length,
        availableUpdate: null,
      };
    }
    const rows = adapterState.wasmDb
      ? _queryWasmObjects(
          "SELECT COUNT(*) AS cnt FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND NOT (COALESCE(is_raw, 0) = 1 AND paired_raw_path IS NOT NULL AND paired_raw_path != '')"
        )
      : [];
    return {
      mode: 'wasm_sqlite',
      hasLockerDb: Boolean(adapterState.wasmDb),
      usbConnected: Boolean(adapterState.wasmDb),
      usbFolderName: adapterState.wasmDbFileName || '',
      dbPhotoCount: rows[0] ? Number(rows[0].cnt || 0) : 0,
      lastCachedAt: adapterState.wasmLastCachedAt || '',
      pendingChangeCount: Object.keys(adapterState.pendingChanges.items || {}).length,
      availableUpdate: null,
    };
  }

  /**
   * SAFでUSBフォルダを選択して永続権限を取得し、library.db をロッカーへ同期＋ジャーナルを再適用する
   */
  async function selectUsbFolderAndSyncLocker() {
    const mode = await detectRuntimeMode();
    if (mode === 'android_native') {
      const res = _safeParseJson(global.TetheractNative.selectUsbFolderAndSync(), { ok: false });
      if (res && res.status === 'picker_launched') {
        return new Promise((resolve) => adapterState.usbSyncWaiters.push(resolve));
      }
      return res;
    }
    return { ok: Boolean(adapterState.wasmDb), mode, status: adapterState.wasmDb ? 'ready' : 'require_file_input' };
  }

  /**
   * 記憶済みSAF URIからUSB内 cache/library.db の更新を確認し、更新時のみ差分コピー＆ジャーナル再適用を行う
   */
  async function refreshLockerFromUsbIfUpdated() {
    const mode = await detectRuntimeMode();
    if (mode === 'android_native' && typeof global.TetheractNative.refreshLockerFromUsbJson === 'function') {
      return _safeParseJson(global.TetheractNative.refreshLockerFromUsbJson(), { ok: false, updated: false });
    }
    return { ok: true, updated: false, mode };
  }

  /**
   * フィルタ状態オブジェクトから SQLite 用の WHERE / ORDER 句を構築する
   */
  function _buildSqlWhereAndOrder(filterState = {}) {
    const clauses = [
      'IFNULL(p.is_unlinked, 0) = 0',
      "NOT (COALESCE(p.is_raw, 0) = 1 AND p.paired_raw_path IS NOT NULL AND p.paired_raw_path != '')",
    ];
    const params = [];
    const rf = filterState.ratingFilter !== undefined ? filterState.ratingFilter : 'default';
    if (rf === 'default') {
      clauses.push('IFNULL(p.rating, 0) IN (0, 1, 2)');
    } else if (Array.isArray(rf) && rf.length > 0) {
      clauses.push(`IFNULL(p.rating, 0) IN (${rf.map(() => '?').join(',')})`);
      params.push(...rf.map(Number));
    } else if (rf !== 'all' && rf !== null && rf !== '') {
      clauses.push('IFNULL(p.rating, 0) = ?');
      params.push(Number(rf));
    }

    const dirFilter = String(filterState.directoryPath || '').trim().replace(/[\\/]+$/, '');
    const isPhoneDirFilter = dirFilter.startsWith('📱 ');
    if (filterState.stacked !== false && !isPhoneDirFilter) {
      clauses.push('(p.stack_id IS NULL OR IFNULL(p.is_stack_primary, 1) = 1)');
    }
    if (filterState.searchQuery) {
      clauses.push('p.file_name LIKE ?');
      params.push(`%${String(filterState.searchQuery).trim()}%`);
    }
    if (filterState.yearMonth) {
      clauses.push('p.year_month = ?');
      params.push(String(filterState.yearMonth));
    }
    if (filterState.cameraModel) {
      clauses.push('p.camera_model = ?');
      params.push(String(filterState.cameraModel));
    }
    if (filterState.lensModel) {
      clauses.push('p.lens_model = ?');
      params.push(String(filterState.lensModel));
    }
    if (dirFilter) {
      const relPhone = isPhoneDirFilter ? dirFilter.slice('📱 '.length).trim().replace(/[\\/]+$/, '') : '';
      if (relPhone) {
        clauses.push(
          "(p.directory_path = ? OR p.directory_path LIKE ? OR p.directory_path LIKE ? OR EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id AND (pl.directory_path = ? OR pl.directory_path LIKE ? OR pl.directory_path LIKE ? OR (pl.volume_serial = 'ANDROID_LOCAL' AND (pl.rel_path LIKE ? OR pl.rel_path LIKE ?)))))"
        );
        params.push(dirFilter, `${dirFilter}/%`, `${dirFilter}\\%`, dirFilter, `${dirFilter}/%`, `${dirFilter}\\%`, `${relPhone}/%`, `${relPhone}\\%`);
      } else {
        clauses.push(
          '(p.directory_path = ? OR p.directory_path LIKE ? OR p.directory_path LIKE ? OR EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id AND (pl.directory_path = ? OR pl.directory_path LIKE ? OR pl.directory_path LIKE ?)))'
        );
        params.push(dirFilter, `${dirFilter}/%`, `${dirFilter}\\%`, dirFilter, `${dirFilter}/%`, `${dirFilter}\\%`);
      }
    }

    if (filterState.noLocationOnly) {
      clauses.push("(p.latitude IS NULL OR p.country IS NULL OR p.country = '' OR (ABS(p.latitude) < 0.0001 AND ABS(p.longitude) < 0.0001))");
    } else {
      if (filterState.country) {
        clauses.push('p.country = ?');
        params.push(String(filterState.country));
      }
      if (filterState.stateName || filterState.state) {
        clauses.push('p.state = ?');
        params.push(String(filterState.stateName || filterState.state));
      }
      if (filterState.city) {
        clauses.push('p.city = ?');
        params.push(String(filterState.city));
      }
    }

    if (filterState.untaggedOnly) {
      clauses.push(`NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND IFNULL(pt.source, 'manual') != 'ai' AND pt.tag NOT IN (${COLOR_TAGS.map(() => '?').join(',')}))`);
      params.push(...COLOR_TAGS);
    } else {
      for (const tag of filterState.includeTags || []) {
        if (tag) {
          clauses.push('EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag = ?)');
          params.push(String(tag));
        }
      }
      for (const tag of filterState.excludeTags || []) {
        if (tag) {
          clauses.push('NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag = ?)');
          params.push(String(tag));
        }
      }
    }

    const allowedSorts = {
      'date_taken DESC': 'p.date_taken DESC, p.file_name ASC',
      'date_taken ASC': 'p.date_taken ASC, p.file_name ASC',
      'rating DESC': 'p.rating DESC, p.date_taken DESC',
      'file_name ASC': 'p.file_name ASC',
    };
    return {
      whereSql: clauses.join(' AND '),
      params,
      orderSql: allowedSorts[filterState.sortBy] || 'p.date_taken DESC, p.file_name ASC',
    };
  }

  /**
   * フィルタ条件に基づいて写真一覧を取得する
   */
  async function queryPhotos(filterState = {}, options = { limit: 500, offset: 0 }) {
    const mode = await detectRuntimeMode();
    const limit = Number(options?.limit || 500);
    const offset = Number(options?.offset || 0);
    const { whereSql, params, orderSql } = _buildSqlWhereAndOrder(filterState);

    if (mode === 'android_native') {
      const raw = global.TetheractNative.queryPhotosJson(whereSql, JSON.stringify(params), orderSql, limit, offset);
      const parsed = _safeParseJson(raw, { photos: [] });
      return Array.isArray(parsed) ? parsed : (parsed.photos || []);
    }

    if (mode === 'http_api') {
      const q = new URLSearchParams();
      const rf = filterState.ratingFilter !== undefined ? filterState.ratingFilter : 'default';
      q.set('ratings', rf === 'default' ? '0,1,2' : rf === 'all' ? '-1,0,1,2' : Array.isArray(rf) ? rf.join(',') : String(rf));
      q.set('stacked', String(filterState.stacked !== false));
      q.set('sort_by', filterState.sortBy || 'date_taken DESC');
      if (filterState.searchQuery) q.set('search', filterState.searchQuery);
      if (filterState.yearMonth) q.set('year_month', filterState.yearMonth);
      if (filterState.cameraModel) q.set('cameras', filterState.cameraModel);
      if (filterState.lensModel) q.set('lenses', filterState.lensModel);
      if (filterState.directoryPath) q.set('directory', filterState.directoryPath);
      if (filterState.untaggedOnly) {
        q.set('untagged', 'true');
      } else {
        if (filterState.includeTags?.length) q.set('include_tags', filterState.includeTags.join(','));
        if (filterState.excludeTags?.length) q.set('exclude_tags', filterState.excludeTags.join(','));
      }
      if (filterState.noLocationOnly) {
        q.set('no_location', 'true');
      } else {
        if (filterState.country) q.set('country', filterState.country);
        if (filterState.stateName || filterState.state) q.set('state', filterState.stateName || filterState.state);
        if (filterState.city) q.set('city', filterState.city);
      }
      const res = await fetch(`/api/photos?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP API Error: ${res.status}`);
      const data = await res.json();
      const list = data.photos || [];
      return limit > 0 ? list.slice(offset, offset + limit) : list;
    }

    if (!adapterState.wasmDb) return [];
    const rows = _queryWasmObjects(
      `SELECT p.* FROM photos p WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    _hydrateWasmTagsAndStacks(rows);
    return rows;
  }

  /**
   * タグ・年月・機材・場所・フォルダの集計ツリー用データを一括取得する
   */
  async function getFilterTrees() {
    const mode = await detectRuntimeMode();
    let rawTrees = {
      tags: [], untaggedCount: 0, timeline: [], cameras: [], lenses: [],
      locations: [], noLocationCount: 0, folders: [], binders: [],
    };

    if (mode === 'android_native') {
      const parsed = _safeParseJson(global.TetheractNative.getFilterTreesJson(), null);
      if (parsed) rawTrees = Object.assign(rawTrees, parsed);
    } else if (mode === 'http_api') {
      const [tagsRes, tlRes, camRes, locRes, fldRes] = await Promise.all([
        fetch('/api/tags').catch(() => null),
        fetch('/api/timeline').catch(() => null),
        fetch('/api/cameras').catch(() => null),
        fetch('/api/locations/tree').catch(() => null),
        fetch('/api/folders').catch(() => null),
      ]);
      if (tagsRes?.ok) {
        const d = await tagsRes.json();
        rawTrees.tags = d.tags || [];
        rawTrees.untaggedCount = Number(d.untagged_count || 0);
      }
      if (tlRes?.ok) rawTrees.timeline = (await tlRes.json()).timeline || [];
      if (camRes?.ok) {
        const d = await camRes.json();
        rawTrees.cameras = d.cameras || [];
        rawTrees.lenses = d.lenses || [];
      }
      if (locRes?.ok) {
        const d = await locRes.json();
        rawTrees.locations = d.tree || d.locations || [];
        rawTrees.noLocationCount = Number(d.no_location_count || 0);
      }
      if (fldRes?.ok) {
        const d = await fldRes.json();
        rawTrees.folders = d.folders || d.tree || [];
      }
    } else if (adapterState.wasmDb) {
      rawTrees = _collectWasmFilterTrees();
    }

    const tb = global.TetheractCore?.TreeBuilder;
    if (tb) {
      if (typeof tb.buildAllFilterTrees === 'function') return tb.buildAllFilterTrees(rawTrees);
      if (typeof tb.buildTagTree === 'function') rawTrees.tagTree = tb.buildTagTree(rawTrees.tags);
      if (typeof tb.buildTimelineTree === 'function') rawTrees.timelineTree = tb.buildTimelineTree(rawTrees.timeline);
    }
    return rawTrees;
  }

  /**
   * 写真ID（または写真オブジェクト）から高速表示用サムネイルURLを返す
   */
  function getThumbnailUrl(photoOrId) {
    const id = photoOrId && typeof photoOrId === 'object' ? photoOrId.id : photoOrId;
    if (!id) return '';
    const mode = getRuntimeModeSync();
    if (mode === 'android_native') return `https://appassets.tetheract.local/thumb/${encodeURIComponent(id)}`;
    if (mode === 'http_api') return `/api/photo/${encodeURIComponent(id)}/thumbnail`;

    const numId = Number(id);
    if (adapterState.thumbUrlCache.has(numId)) return adapterState.thumbUrlCache.get(numId);
    if (!adapterState.wasmDb) return '';
    try {
      const stmt = adapterState.wasmDb.prepare('SELECT data FROM thumbnails WHERE photo_id = ? LIMIT 1');
      stmt.bind([numId]);
      if (stmt.step()) {
        const u8 = stmt.get()[0];
        stmt.free();
        if (u8 && u8.length > 0) {
          const url = URL.createObjectURL(new Blob([u8], { type: 'image/webp' }));
          adapterState.thumbUrlCache.set(numId, url);
          return url;
        }
      } else {
        stmt.free();
      }
    } catch (e) {}
    return '';
  }

  function getFullImageUrl(photoOrId) {
    const id = photoOrId && typeof photoOrId === 'object' ? photoOrId.id : photoOrId;
    if (!id) return '';
    const mode = getRuntimeModeSync();
    if (mode === 'android_native') return `https://appassets.tetheract.local/usb_photo/${encodeURIComponent(id)}`;
    if (mode === 'http_api') return `/api/photo/${encodeURIComponent(id)}/image`;
    return getThumbnailUrl(id);
  }

  /**
   * 評価・タグ・非破壊調整の変更を即時反映し、未同期ジャーナルへ永続記録する
   */
  async function savePhotoChanges(photo, changePatch = {}) {
    const photoObj = photo && typeof photo === 'object' ? photo : { id: Number(photo) };
    const photoId = Number(photoObj.id);
    if (!photoId) return { ok: false, error: 'Invalid photo id' };

    const mode = await detectRuntimeMode();
    const payload = {
      photo_id: photoId,
      content_key: photoObj.content_key || '',
      file_path: photoObj.file_path || '',
      file_name: photoObj.file_name || '',
      file_size: Number(photoObj.file_size || 0),
      date_taken: photoObj.date_taken || '',
      updated_at: formatLocalTimestamp(new Date()),
      ...changePatch,
    };

    if (mode === 'android_native') {
      return _safeParseJson(global.TetheractNative.savePhotoChangeJson(JSON.stringify(payload)), { ok: false });
    }
    if (mode === 'http_api') {
      if (changePatch.rating !== undefined) {
        await fetch(`/api/photo/${photoId}/rate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: Number(changePatch.rating) }),
        });
      }
      if (
        changePatch.brightness !== undefined ||
        changePatch.contrast !== undefined ||
        changePatch.saturation !== undefined ||
        changePatch.fine_angle !== undefined
      ) {
        await fetch(`/api/photo/${photoId}/adjustments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brightness: changePatch.brightness,
            contrast: changePatch.contrast,
            saturation: changePatch.saturation,
            fine_angle: changePatch.fine_angle,
          }),
        });
      }
      for (const tag of changePatch.add_tags || []) {
        await fetch(`/api/photo/${photoId}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag }),
        });
      }
      for (const tag of changePatch.remove_tags || []) {
        await fetch(`/api/photo/${photoId}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
      }
      return { ok: true, mode: 'http_api', photo_id: photoId };
    }

    _applyPatchToWasmAndStorage(payload);
    return {
      ok: true,
      mode: 'wasm_sqlite',
      photo_id: photoId,
      pendingChangeCount: Object.keys(adapterState.pendingChanges.items || {}).length,
    };
  }

  /**
   * 複数写真の評価・タグ変更を単一JNI呼び出し・単一トランザクション（または一括HTTP API）で高速保存する
   */
  async function savePhotoChangesBatch(photos, changePatch = {}) {
    const list = Array.isArray(photos) ? photos : [];
    const items = [];
    for (const p of list) {
      const obj = p && typeof p === 'object' ? p : { id: Number(p) };
      const pid = Number(obj.photo_id || obj.id || 0);
      if (!pid) continue;
      items.push({
        photo_id: pid,
        content_key: obj.content_key || '',
        file_path: obj.file_path || '',
        file_name: obj.file_name || '',
        file_size: Number(obj.file_size || 0),
        date_taken: obj.date_taken || '',
      });
    }
    if (items.length === 0) return { ok: true, updatedCount: 0 };

    const mode = await detectRuntimeMode();
    if (mode === 'android_native') {
      if (typeof global.TetheractNative.savePhotoChangesBatchJson === 'function') {
        const batchPayload = {
          items,
          updated_at: formatLocalTimestamp(new Date()),
          ...changePatch,
        };
        return _safeParseJson(
          global.TetheractNative.savePhotoChangesBatchJson(JSON.stringify(batchPayload)),
          { ok: false }
        );
      }
      let okCount = 0;
      for (const it of items) {
        const r = await savePhotoChanges({ id: it.photo_id, ...it }, changePatch);
        if (r && r.ok) okCount++;
      }
      return { ok: okCount === items.length, updatedCount: okCount };
    }

    const photoIds = items.map((it) => it.photo_id);
    if (mode === 'http_api') {
      if (changePatch.rating !== undefined) {
        const res = await fetch('/api/photos/batch-rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: photoIds, rating: Number(changePatch.rating) }),
        });
        if (!res.ok) return { ok: false, error: 'Batch rating failed' };
      }
      for (const tag of changePatch.add_tags || []) {
        const tKey = changePatch.add_tag_keys ? Object.keys(changePatch.add_tag_keys).find((k) => changePatch.add_tag_keys[k] === tag) : undefined;
        const res = await fetch('/api/photos/batch-tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: photoIds, tag, tag_key: tKey || undefined, action: 'add' }),
        });
        if (!res.ok) return { ok: false, error: 'Batch tag add failed' };
      }
      for (const tag of changePatch.remove_tags || []) {
        const res = await fetch('/api/photos/batch-tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_ids: photoIds, tag, action: 'remove' }),
        });
        if (!res.ok) return { ok: false, error: 'Batch tag remove failed' };
      }
      return { ok: true, mode: 'http_api', updatedCount: photoIds.length };
    }

    const nowTs = formatLocalTimestamp(new Date());
    for (const it of items) {
      _applyPatchToWasmAndStorage({ ...it, updated_at: nowTs, ...changePatch });
    }
    return {
      ok: true,
      mode: 'wasm_sqlite',
      updatedCount: items.length,
      pendingChangeCount: Object.keys(adapterState.pendingChanges.items || {}).length,
    };
  }

  /**
   * 未同期の変更ジャーナルを USB (cache/mobile_sync.json) または PC サーバーへ同期する
   */
  async function syncPendingChangesToUsbOrServer(options = {}) {
    const mode = await detectRuntimeMode();
    if (mode === 'android_native') {
      const res = _safeParseJson(global.TetheractNative.exportSyncJsonToUsb(), { ok: false });
      if (res && res.ok) return res;
      if (options.serverUrl && typeof global.TetheractNative.getPendingChangesJson === 'function') {
        const pendingData = _safeParseJson(global.TetheractNative.getPendingChangesJson(), { changes: [] });
        return _postSyncChangesToHttpServer(
          options.serverUrl,
          pendingData.changes || [],
          true,
          Number(pendingData.journal_rev || 0)
        );
      }
      return res;
    }

    const changes = Object.values(adapterState.pendingChanges.items || {});
    if (mode === 'http_api' || options.serverUrl) {
      return _postSyncChangesToHttpServer(options.serverUrl || '', changes, false);
    }
    return {
      ok: true,
      mode: 'wasm_sqlite',
      exportedCount: changes.length,
      syncJson: JSON.stringify(
        {
          format: 'photo-manager-mobile-sync-v1',
          exported_at: formatLocalTimestamp(new Date()),
          source_db: adapterState.wasmDbFileName || 'library.db',
          changes,
        },
        null,
        2
      ),
    };
  }

  async function _postSyncChangesToHttpServer(baseUrl, changes, isNative, journalRev = 0) {
    const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
    const res = await fetch(`${cleanBase}/api/mobile/sync-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    if (!res.ok) throw new Error(`Sync HTTP Error: ${res.status}`);
    const data = await res.json();
    if (isNative && typeof global.TetheractNative.clearPendingChangesUpToJson === 'function') {
      // 送信時点の journal_rev 以下だけを消し、送信中に記録された変更は残す
      global.TetheractNative.clearPendingChangesUpToJson(journalRev);
    } else if (isNative && typeof global.TetheractNative.clearPendingChangesJson === 'function') {
      global.TetheractNative.clearPendingChangesJson();
    } else {
      adapterState.pendingChanges.items = {};
      _savePendingToLocalStorage();
    }
    return { ok: true, mode: 'http_api', syncedCount: changes.length, serverResponse: data };
  }

  /**
   * USB内の UI バンドル (Stage 1) および Tetheract_Android.apk (Stage 2) を確認・実行する
   */
  async function checkAndTriggerUsbUpdate(options = { autoApplyUi: true, triggerApkInstall: false }) {
    const mode = await detectRuntimeMode();
    if (mode === 'android_native' && typeof global.TetheractNative.checkAndTriggerUsbUpdateJson === 'function') {
      return _safeParseJson(global.TetheractNative.checkAndTriggerUsbUpdateJson(JSON.stringify(options || {})), { ok: false });
    }
    return { ok: false, mode, reason: 'not_android_native' };
  }

  function setWasmDatabase(dbInstance, fileName = 'library.db') {
    if (dbInstance && typeof dbInstance.create_function === 'function') {
      try {
        dbInstance.create_function('tetheract_v170_guard', () => 1);
      } catch (e) {}
    }
    adapterState.wasmDb = dbInstance;
    adapterState.wasmDbFileName = fileName;
    adapterState.wasmLastCachedAt = formatLocalTimestamp(new Date());
    for (const url of adapterState.thumbUrlCache.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
    }
    adapterState.thumbUrlCache.clear();
  }

  function _queryWasmObjects(sql, params = []) {
    if (!adapterState.wasmDb) return [];
    const stmt = adapterState.wasmDb.prepare(sql);
    const results = [];
    try {
      stmt.bind(params);
      while (stmt.step()) results.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return results;
  }

  function _hydrateWasmTagsAndStacks(rows) {
    if (!rows?.length || !adapterState.wasmDb) return;
    const ids = rows.map((r) => r.id);
    const tagRows = _queryWasmObjects(
      `SELECT photo_id, tag FROM photo_tags WHERE photo_id IN (${ids.map(() => '?').join(',')}) ORDER BY tag`,
      ids
    );
    const tagMap = new Map();
    for (const tr of tagRows) {
      if (!tagMap.has(tr.photo_id)) tagMap.set(tr.photo_id, []);
      tagMap.get(tr.photo_id).push(tr.tag);
    }
    for (const r of rows) {
      r.tags = tagMap.get(r.id) || [];
      r.stack_count = r.stack_count || 1;
    }
  }

  function _collectWasmFilterTrees() {
    return {
      tags: _queryWasmObjects("SELECT pt.tag, COUNT(DISTINCT pt.photo_id) AS count, SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) AS ai_count, SUM(CASE WHEN pt.source = 'manual' OR pt.source IS NULL THEN 1 ELSE 0 END) AS manual_count, CASE WHEN SUM(CASE WHEN pt.source = 'manual' OR pt.source IS NULL THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) > 0 THEN 'both' WHEN SUM(CASE WHEN pt.source = 'ai' THEN 1 ELSE 0 END) > 0 THEN 'ai' ELSE 'manual' END AS source FROM photo_tags pt INNER JOIN photos p ON p.id = pt.photo_id WHERE IFNULL(p.is_unlinked, 0) = 0 GROUP BY pt.tag ORDER BY pt.tag ASC"),
      untaggedCount: 0,
      timeline: _queryWasmObjects("SELECT year_month, COUNT(*) AS count FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND year_month IS NOT NULL AND year_month != '' GROUP BY year_month ORDER BY year_month DESC"),
      cameras: _queryWasmObjects("SELECT camera_model, COUNT(*) AS count FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND camera_model IS NOT NULL AND camera_model != '' GROUP BY camera_model ORDER BY count DESC"),
      lenses: [],
      locations: [],
      noLocationCount: 0,
      folders: _queryWasmObjects("SELECT directory_path, COUNT(*) AS count FROM photos WHERE IFNULL(is_unlinked, 0) = 0 AND directory_path IS NOT NULL AND directory_path != '' GROUP BY directory_path ORDER BY directory_path ASC"),
      binders: [],
    };
  }

  function _applyPatchToWasmAndStorage(payload) {
    const pid = Number(payload.photo_id);
    const key = String(pid);
    if (!adapterState.pendingChanges.items[key]) {
      adapterState.pendingChanges.items[key] = {
        photo_id: pid,
        content_key: payload.content_key || '',
        file_path: payload.file_path || '',
        file_name: payload.file_name || '',
        date_taken: payload.date_taken || '',
        rating: undefined,
        add_tags: [],
        remove_tags: [],
      };
    }
    const item = adapterState.pendingChanges.items[key];
    if (payload.rating !== undefined) {
      item.rating = Number(payload.rating);
      adapterState.wasmDb?.run('UPDATE photos SET rating = ? WHERE id = ?', [item.rating, pid]);
    }
    for (const tag of payload.add_tags || []) {
      item.remove_tags = item.remove_tags.filter((t) => t !== tag);
      if (!item.add_tags.includes(tag)) item.add_tags.push(tag);
      for (const anc of _expandTagAncestors(tag)) {
        adapterState.wasmDb?.run("INSERT OR IGNORE INTO photo_tags (photo_id, tag, source, confidence) VALUES (?, ?, 'manual', 1.0)", [pid, anc]);
      }
    }
    for (const tag of payload.remove_tags || []) {
      item.add_tags = item.add_tags.filter((t) => t !== tag);
      if (!item.remove_tags.includes(tag)) item.remove_tags.push(tag);
      adapterState.wasmDb?.run('DELETE FROM photo_tags WHERE photo_id = ? AND (tag = ? OR tag LIKE ?)', [pid, tag, `${tag}/%`]);
      for (const anc of _expandTagAncestors(tag).slice(0, -1).reverse()) {
        adapterState.wasmDb?.run(
          'DELETE FROM photo_tags WHERE photo_id = ? AND tag = ? AND NOT EXISTS (SELECT 1 FROM photo_tags pt2 WHERE pt2.photo_id = ? AND pt2.tag LIKE ?)',
          [pid, anc, pid, `${anc}/%`]
        );
      }
    }
    _savePendingToLocalStorage();
  }

  async function saveWifiPairing(urlOrQrInput) {
    const mode = await detectRuntimeMode();
    if (mode === 'android_native' && typeof global.TetheractNative.saveWifiPairingJson === 'function') {
      return _safeParseJson(global.TetheractNative.saveWifiPairingJson(String(urlOrQrInput || '')), { ok: false });
    }
    return { ok: false, mode };
  }

  async function syncLockerOverWifi(forceFull = false) {
    const mode = await detectRuntimeMode();
    if (mode === 'android_native' && typeof global.TetheractNative.triggerWifiSyncAsyncJson === 'function') {
      const res = _safeParseJson(global.TetheractNative.triggerWifiSyncAsyncJson(Boolean(forceFull)), { ok: false });
      if (res && res.status === 'wifi_sync_started') {
        return new Promise((resolve) => adapterState.usbSyncWaiters.push(resolve));
      }
      return res;
    }
    return { ok: false, mode };
  }

  const TetheractAdapter = {
    detectRuntimeMode,
    getRuntimeModeSync,
    getLockerStatus,
    selectUsbFolderAndSyncLocker,
    refreshLockerFromUsbIfUpdated,
    saveWifiPairing,
    syncLockerOverWifi,
    queryPhotos,
    getFilterTrees,
    getThumbnailUrl,
    getFullImageUrl,
    savePhotoChanges,
    savePhotoChangesBatch,
    syncPendingChangesToUsbOrServer,
    checkAndTriggerUsbUpdate,
    setWasmDatabase,
    formatLocalTimestamp,
  };

  global.TetheractAdapter = TetheractAdapter;
  global.TetheractDataAdapter = TetheractAdapter;
})(typeof window !== 'undefined' ? window : globalThis);
