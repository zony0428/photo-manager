/**
 * Tetheract Photo Manager - Layer 1: Watermark & Quick Share Adapter (window.TetheractWatermarkAdapter)
 *
 * library.db (watermark_assets) のロゴ画像一覧取得・登録・削除、および
 * Android FileProvider / Web Share API を用いた SNS クイック共有を抽象化する。
 * Layer 1 規約に基づき DOM 参照・操作および Date.toISOString() は使用しない。
 */
(function (global) {
  'use strict';

  const IDB_NAME = 'tetheract_watermark_local_v1';
  const IDB_STORE = 'assets';
  const IDB_META_STORE = 'meta';
  const DEFAULT_ID = 'default_tetheract_logo';
  const DEFAULT_SEED_KEY = 'default_watermark_seeded_v1';

  function _safeParseJson(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn('WatermarkAdapter JSON parse error:', err);
      return fallback;
    }
  }

  function _formatLocalNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function _isNativeWatermarkAvailable() {
    return Boolean(
      global.TetheractNative &&
        typeof global.TetheractNative.listWatermarkAssetsJson === 'function' &&
        typeof global.TetheractNative.saveWatermarkAssetJson === 'function' &&
        typeof global.TetheractNative.deleteWatermarkAssetJson === 'function'
    );
  }

  function _isNativeShareAvailable() {
    return Boolean(
      global.TetheractNative &&
        typeof global.TetheractNative.sharePhotoToSnsJson === 'function'
    );
  }

  function _isHttpServerOrigin() {
    try {
      const proto = String(global.location && global.location.protocol || '');
      const host = String(global.location && global.location.hostname || '');
      return (proto === 'http:' || proto === 'https:') && host !== 'appassets.tetheract.local';
    } catch (e) {
      return false;
    }
  }

  function _openIdb() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = global.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(IDB_META_STORE)) {
          db.createObjectStore(IDB_META_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
  }

  async function _idbGetAll(storeName) {
    try {
      const db = await _openIdb();
      return await new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      });
    } catch (e) {
      return [];
    }
  }

  async function _idbPut(storeName, value) {
    const db = await _openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB put failed'));
    });
  }

  async function _idbDelete(storeName, key) {
    const db = await _openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
    });
  }

  async function _idbGet(storeName, key) {
    try {
      const db = await _openIdb();
      return await new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  function _dataUrlToBlob(dataUrl) {
    const raw = String(dataUrl || '');
    const commaIdx = raw.indexOf(',');
    if (commaIdx < 0) return null;
    const header = raw.slice(0, commaIdx);
    const m = header.match(/data:([^;]+);/i);
    const mime = m ? m[1] : 'image/jpeg';
    const bin = global.atob(raw.slice(commaIdx + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { blob: new Blob([bytes], { type: mime }), mime };
  }

  async function listWatermarks() {
    if (_isNativeWatermarkAvailable()) {
      try {
        const res = _safeParseJson(global.TetheractNative.listWatermarkAssetsJson(), { ok: false, watermarks: [] });
        return {
          ok: Boolean(res && res.ok),
          mode: 'native',
          watermarks: Array.isArray(res && res.watermarks) ? res.watermarks : [],
          error: res && res.error ? String(res.error) : '',
        };
      } catch (err) {
        return { ok: false, mode: 'native', watermarks: [], error: String(err) };
      }
    }

    const merged = [];
    const seen = new Set();

    if (_isHttpServerOrigin()) {
      try {
        const resp = await global.fetch('/api/watermarks', { credentials: 'same-origin' });
        if (resp.ok) {
          const data = await resp.json();
          const list = Array.isArray(data && data.watermarks) ? data.watermarks : [];
          list.forEach((item) => {
            if (item && item.id && !seen.has(item.id)) {
              seen.add(item.id);
              merged.push(item);
            }
          });
        }
      } catch (e) {
        console.warn('WatermarkAdapter HTTP list skip:', e);
      }
    }

    const localItems = await _idbGetAll(IDB_STORE);
    localItems.forEach((item) => {
      if (item && item.id && !seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    });

    // 非ネイティブかつ HTTP 未取得時のみ、初回デフォルトロゴをアイコンURLから補完
    if (merged.length === 0 && _isHttpServerOrigin()) {
      const seeded = await _idbGet(IDB_META_STORE, DEFAULT_SEED_KEY);
      if (!seeded) {
        merged.push({
          id: DEFAULT_ID,
          name: 'TETHERACT',
          mime_type: 'image/png',
          width: 1068,
          height: 234,
          origin: 'default',
          image_url: '/icons/tetheract-watermark-default.png',
          created_at: _formatLocalNow(),
        });
      }
    }

    return { ok: true, mode: _isHttpServerOrigin() ? 'http' : 'local', watermarks: merged };
  }

  async function saveWatermark(name, dataUrl) {
    const cleanName = String(name || 'logo.png').trim() || 'logo.png';
    if (_isNativeWatermarkAvailable()) {
      try {
        const res = _safeParseJson(
          global.TetheractNative.saveWatermarkAssetJson(JSON.stringify({ name: cleanName, dataUrl: String(dataUrl || '') })),
          { ok: false }
        );
        return {
          ok: Boolean(res && res.ok),
          asset: res && res.asset ? res.asset : null,
          watermarks: Array.isArray(res && res.watermarks) ? res.watermarks : [],
          error: res && res.error ? String(res.error) : '',
        };
      } catch (err) {
        return { ok: false, asset: null, watermarks: [], error: String(err) };
      }
    }

    const aid = `mob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      id: aid,
      name: cleanName,
      mime_type: 'image/png',
      width: 0,
      height: 0,
      origin: 'mobile',
      image_url: String(dataUrl || ''),
      created_at: _formatLocalNow(),
    };
    try {
      await _idbPut(IDB_STORE, item);
      const listRes = await listWatermarks();
      return { ok: true, asset: item, watermarks: listRes.watermarks || [item] };
    } catch (err) {
      return { ok: false, asset: null, watermarks: [], error: String(err) };
    }
  }

  async function deleteWatermark(assetId) {
    const aid = String(assetId || '').trim();
    if (!aid) return { ok: false, watermarks: [], error: 'IDが未指定です' };

    if (_isNativeWatermarkAvailable()) {
      try {
        const res = _safeParseJson(global.TetheractNative.deleteWatermarkAssetJson(aid), { ok: false });
        return {
          ok: Boolean(res && res.ok),
          deleted_id: aid,
          watermarks: Array.isArray(res && res.watermarks) ? res.watermarks : [],
          error: res && res.error ? String(res.error) : '',
        };
      } catch (err) {
        return { ok: false, watermarks: [], error: String(err) };
      }
    }

    try {
      await _idbDelete(IDB_STORE, aid);
      if (aid === DEFAULT_ID) {
        await _idbPut(IDB_META_STORE, { key: DEFAULT_SEED_KEY, value: '1' });
      }
      if (_isHttpServerOrigin() && !aid.startsWith('mob_')) {
        await global.fetch(`/api/watermarks/${encodeURIComponent(aid)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        }).catch(() => {});
      }
      const listRes = await listWatermarks();
      return { ok: true, deleted_id: aid, watermarks: listRes.watermarks || [] };
    } catch (err) {
      return { ok: false, watermarks: [], error: String(err) };
    }
  }

  /**
   * 調整・GPS除去済みの画像 DataURL を OS 共有シートへ引き渡す
   */
  async function sharePhotoToSns(payload) {
    const req = payload && typeof payload === 'object' ? payload : {};
    if (_isNativeShareAvailable()) {
      try {
        const res = _safeParseJson(
          global.TetheractNative.sharePhotoToSnsJson(JSON.stringify(req)),
          { ok: false }
        );
        return {
          ok: Boolean(res && res.ok),
          mode: 'native',
          fileName: res && res.fileName ? String(res.fileName) : '',
          error: res && res.error ? String(res.error) : '',
        };
      } catch (err) {
        return { ok: false, mode: 'native', error: String(err) };
      }
    }

    const parsed = _dataUrlToBlob(req.dataUrl);
    if (!parsed) {
      return { ok: false, mode: 'browser', error: '共有用画像データを生成できませんでした' };
    }
    const fileName = String(req.fileName || 'tetheract_share.jpg');
    const file = new File([parsed.blob], fileName, { type: parsed.mime });

    if (global.navigator && typeof global.navigator.share === 'function') {
      try {
        if (!global.navigator.canShare || global.navigator.canShare({ files: [file] })) {
          await global.navigator.share({ files: [file], title: fileName });
          return { ok: true, mode: 'web_share', fileName };
        }
      } catch (err) {
        if (err && err.name === 'AbortError') {
          return { ok: true, mode: 'cancelled', fileName };
        }
        return { ok: false, mode: 'web_share', error: String(err && err.message || err) };
      }
    }
    return { ok: false, mode: 'fallback_download', fileName, error: 'Web Share API 未対応のためダウンロードに切替えます' };
  }

  global.TetheractWatermarkAdapter = {
    isNativeWatermarkAvailable: _isNativeWatermarkAvailable,
    isNativeShareAvailable: _isNativeShareAvailable,
    listWatermarks,
    saveWatermark,
    deleteWatermark,
    sharePhotoToSns,
  };
})(window);
