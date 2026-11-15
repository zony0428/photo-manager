/**
 * Tetheract Photo Manager - Layer 1: Phone Case Adapter (window.TetheractPhoneCaseAdapter)
 *
 * スマホ内画像フォルダ（Camera / Pictures 等）のリンク管理、未収納スキャン、
 * 転送前ドラフト（評価・タグ）保存、および母艦 Loome\case\YYYY-MM-DD への原本転送を仲介する。
 * Layer 1 規約に基づき DOM 参照・操作は一切行わない。
 */

(function (global) {
  'use strict';

  const folderScanStartedListeners = new Set();
  const folderPickedListeners = new Set();
  const progressListeners = new Set();
  const completedListeners = new Set();
  const pendingScanResolvers = new Map();
  let scanReqSeq = 0;

  function _safeParseJson(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn('PhoneCaseAdapter JSON parse error:', err);
      return fallback;
    }
  }

  /**
   * Android ネイティブのスマホフォルダ連携が利用可能か判定する
   */
  function isNativeAvailable() {
    return Boolean(
      global.TetheractNative &&
        typeof global.TetheractNative.phoneCaseListFoldersJson === 'function'
    );
  }

  /**
   * リンク済みのスマホ内画像フォルダ一覧を取得する
   */
  async function listFolders() {
    if (!isNativeAvailable()) {
      return { ok: true, mode: 'browser', folders: [] };
    }
    try {
      const res = _safeParseJson(global.TetheractNative.phoneCaseListFoldersJson(), { ok: false, folders: [] });
      return {
        ok: Boolean(res && res.ok),
        mode: 'native',
        folders: Array.isArray(res && res.folders) ? res.folders : [],
        error: res && res.error ? String(res.error) : '',
      };
    } catch (err) {
      return { ok: false, mode: 'native', folders: [], error: String(err) };
    }
  }

  /**
   * Android SAF フォルダピッカーを起動してスマホ内の画像フォルダ（Camera等）をリンク追加する
   */
  async function pickFolder() {
    if (!isNativeAvailable()) {
      return { ok: false, error: 'native_unavailable' };
    }
    try {
      const res = _safeParseJson(global.TetheractNative.phoneCasePickFolderJson(), { ok: false });
      return res && typeof res === 'object' ? res : { ok: false };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Android 端末の標準カメラアプリを起動する（未対応・ブラウザ時は mode='browser' を返す）
   */
  async function launchCameraApp() {
    if (!global.TetheractNative || typeof global.TetheractNative.launchCameraAppJson !== 'function') {
      return { ok: false, mode: 'browser', error: 'native_camera_unavailable' };
    }
    try {
      const res = _safeParseJson(global.TetheractNative.launchCameraAppJson(), { ok: false });
      return {
        ok: Boolean(res && res.ok),
        mode: 'native',
        error: res && res.error ? String(res.error) : '',
      };
    } catch (err) {
      return { ok: false, mode: 'native', error: String(err) };
    }
  }

  /**
   * リンク済みのスマホ内画像フォルダを登録解除する（実ファイルは削除しない）
   */
  async function removeFolder(folderId) {
    if (!isNativeAvailable()) {
      return { ok: false, error: 'native_unavailable' };
    }
    try {
      const res = _safeParseJson(
        global.TetheractNative.phoneCaseRemoveFolderJson(String(folderId || '')),
        { ok: false, folders: [] }
      );
      const scanRes = await scanPhotos('all', { includeItems: false, force: true });
      return {
        ok: Boolean(res && res.ok),
        folders: Array.isArray(scanRes && scanRes.folders)
          ? scanRes.folders
          : (Array.isArray(res && res.folders) ? res.folders : []),
      };
    } catch (err) {
      return { ok: false, folders: [], error: String(err) };
    }
  }

  function _normalizeScanResponse(res, fallbackFolderId) {
    const items = Array.isArray(res && res.items) ? res.items : [];
    return {
      ok: Boolean(res && res.ok),
      folderId: String((res && res.folderId) || fallbackFolderId || 'all'),
      scannedCount: Number((res && res.scannedCount) ?? items.length),
      totalCount: Number((res && res.totalCount) ?? items.length),
      unstoredCount: Number((res && res.unstoredCount) || 0),
      catalogChanged: Boolean(res && res.catalogChanged),
      folders: Array.isArray(res && res.folders) ? res.folders : undefined,
      scanError: res && res.scanError ? String(res.scanError) : '',
      items,
      error: res && res.error ? String(res.error) : '',
    };
  }

  /**
   * 指定したスマホ内フォルダ（または 'all'）内の写真を非同期走査し、母艦DBとの重複照合結果付きで返す
   */
  async function scanPhotos(folderId, options = {}) {
    if (!isNativeAvailable()) {
      return { ok: false, totalCount: 0, unstoredCount: 0, items: [] };
    }
    const targetId = String(folderId || 'all');
    const includeItems = options.includeItems !== false;
    const forceFresh = Boolean(options.force);
    try {
      if (typeof global.TetheractNative.phoneCaseScanPhotosAsyncJson === 'function') {
        const reqId = `ps_${++scanReqSeq}_${Date.now()}`;
        let timer = null;
        const asyncPromise = new Promise((resolve) => {
          timer = setTimeout(() => {
            pendingScanResolvers.delete(reqId);
            resolve({ ok: false, error: 'フォルダ走査がタイムアウトしました', items: [] });
          }, 180000);
          pendingScanResolvers.set(reqId, (payload) => {
            clearTimeout(timer);
            resolve(payload);
          });
        });
        const startRes = _safeParseJson(
          global.TetheractNative.phoneCaseScanPhotosAsyncJson(reqId, targetId, includeItems, forceFresh),
          { ok: false }
        );
        if (!startRes || !startRes.ok) {
          if (timer !== null) {
            clearTimeout(timer);
          }
          pendingScanResolvers.delete(reqId);
          return _normalizeScanResponse(startRes, targetId);
        }
        const doneRes = await asyncPromise;
        return _normalizeScanResponse(doneRes, targetId);
      }
      const raw = global.TetheractNative.phoneCaseScanPhotosJson(targetId);
      return _normalizeScanResponse(_safeParseJson(raw, { ok: false, items: [] }), targetId);
    } catch (err) {
      return { ok: false, totalCount: 0, unstoredCount: 0, items: [], error: String(err) };
    }
  }

  /**
   * スマホ内写真に対する転送前ドラフト（評価・タグ）を保存する
   */
  async function saveDraft(params) {
    if (!isNativeAvailable()) {
      return { ok: false, error: 'native_unavailable' };
    }
    try {
      const payload = JSON.stringify({
        docKeys: Array.isArray(params && params.docKeys) ? params.docKeys : [],
        rating: params && params.rating !== undefined ? params.rating : null,
        addTags: Array.isArray(params && params.addTags) ? params.addTags : [],
        removeTags: Array.isArray(params && params.removeTags) ? params.removeTags : [],
      });
      const res = _safeParseJson(global.TetheractNative.phoneCaseSaveDraftJson(payload), { ok: false });
      return res && typeof res === 'object' ? res : { ok: false };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * スマホ内写真のサムネイルまたはフル画像URLを返す
   */
  function getPhotoUrl(docKey, isThumb = true) {
    const cleanKey = encodeURIComponent(String(docKey || ''));
    return `https://appassets.tetheract.local/phone_photo/${cleanKey}?thumb=${isThumb ? '1' : '0'}`;
  }

  /**
   * 選択されたスマホ内写真群を母艦の \Loome\case\YYYY-MM-DD へ非同期転送する
   */
  async function transferToMotherShip(params) {
    if (!isNativeAvailable()) {
      return { ok: false, error: 'native_unavailable' };
    }
    try {
      const payload = JSON.stringify({
        items: Array.isArray(params && params.items) ? params.items : [],
        commonTags: Array.isArray(params && params.commonTags) ? params.commonTags : [],
        commonRating: params && params.commonRating !== undefined ? params.commonRating : null,
      });
      const res = _safeParseJson(global.TetheractNative.phoneCaseTransferAsyncJson(payload), { ok: false });
      return res && typeof res === 'object' ? res : { ok: false };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * ブラウザモード (/m) で選択された File オブジェクト配列を母艦 \Loome\case\YYYY-MM-DD へ転送する
   */
  async function transferBrowserFiles(files, options = {}) {
    const fileList = Array.from(files || []);
    if (!fileList.length) return { ok: false, error: 'ファイルが選択されていません' };

    const commonTags = Array.isArray(options.commonTags) ? options.commonTags : [];
    const commonRating = options.commonRating !== undefined ? options.commonRating : null;
    const draftMap = options.draftMap || {};
    const customDocKeys = Array.isArray(options.docKeys) ? options.docKeys : [];

    const preflightItems = fileList.map((f, idx) => {
      const cid = customDocKeys[idx] || `bf_${idx}_${f.name}_${f.size}`;
      const d = draftMap[cid] || {};
      const rating = commonRating !== null && commonRating !== 0 ? commonRating : (d.rating || 0);
      const tags = Array.from(new Set([...(Array.isArray(d.tags) ? d.tags : []), ...commonTags]));
      return {
        client_id: cid,
        file_name: f.name,
        file_size: f.size,
        last_modified_ms: Number(f.lastModified || 0),
        rating,
        tags,
      };
    });

    const skipSet = new Set();
    let appliedToExisting = 0;
    const chunkSize = 500;
    for (let c = 0; c < preflightItems.length; c += chunkSize) {
      const chunk = preflightItems.slice(c, c + chunkSize);
      let preRes = null;
      try {
        preRes = await fetch('/api/mobile/case-preflight', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: chunk }),
        }).then((r) => r.json());
      } catch (err) {
        const failObj = { ok: false, error: `母艦PCへの接続に失敗しました (${String(err)})` };
        completedListeners.forEach((fn) => { try { fn(failObj); } catch (e) {} });
        return failObj;
      }
      if (!preRes || !preRes.ok) {
        const failObj = { ok: false, error: (preRes && (preRes.detail || preRes.error)) || 'プリフライト照合に失敗しました' };
        completedListeners.forEach((fn) => { try { fn(failObj); } catch (e) {} });
        return failObj;
      }
      if (Array.isArray(preRes.skipped_client_ids)) {
        preRes.skipped_client_ids.forEach((id) => skipSet.add(id));
      }
      appliedToExisting += Number(preRes.applied_to_existing || 0);
    }

    let importedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let consecutiveFailures = 0;
    let aborted = false;
    let lastError = '';
    const succeededDocKeys = [];
    const total = fileList.length;
    let lastProgTs = 0;

    for (let i = 0; i < fileList.length; i += 1) {
      const f = fileList[i];
      const meta = preflightItems[i];
      const isSkip = skipSet.has(meta.client_id);
      const nowTs = Date.now();
      if (!isSkip || i === 0 || i === total - 1 || nowTs - lastProgTs >= 120) {
        lastProgTs = nowTs;
        progressListeners.forEach((fn) => {
          try {
            fn({ current: i + 1, total, fileName: f.name, importedCount, skippedCount, errorCount });
          } catch (e) {}
        });
      }

      if (isSkip) {
        skippedCount += 1;
        succeededDocKeys.push(meta.client_id);
        continue;
      }

      const qs = new URLSearchParams({
        file_name: f.name,
        last_modified_ms: String(meta.last_modified_ms || 0),
        rating: String(meta.rating || 0),
        tags_json: JSON.stringify(meta.tags || []),
      });

      let uploadedOk = false;
      let dupSkipped = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const upResp = await fetch(`/api/mobile/case-upload?${qs.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: f,
          });
          const upJson = await upResp.json();
          if (upResp.ok && upJson && upJson.ok) {
            uploadedOk = true;
            dupSkipped = upJson.status === 'skipped_duplicate';
            break;
          }
          lastError = (upJson && (upJson.detail || upJson.error)) || `HTTP ${upResp.status}`;
          if ([400, 401, 403, 413, 423].includes(upResp.status)) break;
        } catch (e) {
          lastError = String(e && e.message ? e.message : e);
        }
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 800));
        }
      }

      if (uploadedOk) {
        consecutiveFailures = 0;
        if (dupSkipped) skippedCount += 1;
        else importedCount += 1;
        succeededDocKeys.push(meta.client_id);
      } else {
        errorCount += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          aborted = true;
          break;
        }
      }
    }

    const allOk = !aborted && errorCount === 0;
    const finalRes = {
      ok: allOk,
      partial: !allOk && (importedCount > 0 || skippedCount > 0),
      aborted,
      totalCount: total,
      importedCount,
      skippedCount,
      errorCount,
      remainingCount: Math.max(0, total - importedCount - skippedCount),
      appliedToExisting,
      succeededDocKeys,
      error: allOk ? '' : (lastError || '通信が中断されました'),
    };
    completedListeners.forEach((fn) => {
      try { fn(finalRes); } catch (e) {}
    });
    return finalRes;
  }

  function onFolderScanStarted(fn) {
    if (typeof fn === 'function') folderScanStartedListeners.add(fn);
    return () => folderScanStartedListeners.delete(fn);
  }

  function onFolderPicked(fn) {
    if (typeof fn === 'function') folderPickedListeners.add(fn);
    return () => folderPickedListeners.delete(fn);
  }

  function onTransferProgress(fn) {
    if (typeof fn === 'function') progressListeners.add(fn);
    return () => progressListeners.delete(fn);
  }

  function onTransferCompleted(fn) {
    if (typeof fn === 'function') completedListeners.add(fn);
    return () => completedListeners.delete(fn);
  }

  global.__onTetheractPhoneFolderScanStarted = function () {
    folderScanStartedListeners.forEach((fn) => {
      try { fn(); } catch (e) {}
    });
  };

  global.__onTetheractPhoneScanCompleted = function (resObj) {
    const parsed = _safeParseJson(resObj, { ok: false, items: [] });
    const reqId = parsed && parsed.requestId ? String(parsed.requestId) : '';
    const resolver = reqId ? pendingScanResolvers.get(reqId) : null;
    if (resolver) {
      pendingScanResolvers.delete(reqId);
      resolver(parsed);
    }
  };

  global.__onTetheractPhoneFolderPicked = function (resObj) {
    const parsed = _safeParseJson(resObj, { ok: false });
    folderPickedListeners.forEach((fn) => {
      try { fn(parsed); } catch (e) {}
    });
  };

  global.__onTetheractCaseTransferProgress = function (progObj) {
    const parsed = _safeParseJson(progObj, {});
    progressListeners.forEach((fn) => {
      try { fn(parsed); } catch (e) {}
    });
  };

  global.__onTetheractCaseTransferCompleted = function (resObj) {
    const parsed = _safeParseJson(resObj, { ok: false });
    completedListeners.forEach((fn) => {
      try { fn(parsed); } catch (e) {}
    });
  };

  global.TetheractPhoneCaseAdapter = {
    isNativeAvailable,
    listFolders,
    pickFolder,
    launchCameraApp,
    removeFolder,
    scanPhotos,
    saveDraft,
    getPhotoUrl,
    transferToMotherShip,
    transferBrowserFiles,
    onFolderScanStarted,
    onFolderPicked,
    onTransferProgress,
    onTransferCompleted,
  };
})(window);
