/**
 * Tetheract Photo Manager - Core Journal Sync (Layer 2)
 * スマホ内専用ロッカーの library.db がUSBから再キャッシュ（上書き更新）された際にも、
 * 未同期のスマホ側変更（評価・タグ追加/削除・非破壊調整パラメータ）を失わずに再適用（Replay）し、
 * PC側のモバイル同期APIおよび cache/mobile_sync.json と完全互換のJSONを生成する純粋ロジックモジュール。
 */

(function (globalScope) {
  'use strict';

  /**
   * ローカルタイムで YYYY-MM-DD HH:MM:SS 形式の日時文字列を生成する
   * （UTC基準の日時変換による日付ズレを防ぐためローカル時刻メソッドで連結する）
   *
   * @param {Date} [date]
   * @returns {string}
   */
  function formatLocalDateTime(date = new Date()) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  /**
   * 写真オブジェクトから一意のジャーナル識別キーを算出する
   * 優先順: content_key -> photo_id -> file_name + file_size
   */
  function _resolveJournalKey(photo) {
    if (!photo || typeof photo !== 'object') return '';
    const contentKey = String(photo.content_key || '').trim();
    if (contentKey) return `ck:${contentKey}`;
    const pid = photo.id !== undefined && photo.id !== null ? photo.id : photo.photo_id;
    if (pid !== undefined && pid !== null && String(pid).trim() !== '') {
      return `id:${Number(pid)}`;
    }
    const fName = String(photo.file_name || '').trim();
    const fSize = photo.file_size !== undefined && photo.file_size !== null ? Number(photo.file_size) : 0;
    if (fName) {
      return `fn:${fName}::${fSize}`;
    }
    return '';
  }

  /**
   * ジャーナル格納先（Map または Object）から写真に対応する既存エントリとキーを検索する
   */
  function _findExistingEntry(journalMap, photo) {
    const primaryKey = _resolveJournalKey(photo);
    const contentKey = String(photo?.content_key || '').trim();
    const pid = photo?.id !== undefined && photo?.id !== null ? Number(photo.id) : (
      photo?.photo_id !== undefined && photo?.photo_id !== null ? Number(photo.photo_id) : null
    );
    const fName = String(photo?.file_name || '').trim();
    const fSize = photo?.file_size !== undefined && photo?.file_size !== null ? Number(photo.file_size) : null;

    if (journalMap instanceof Map) {
      if (primaryKey && journalMap.has(primaryKey)) {
        return { key: primaryKey, entry: journalMap.get(primaryKey) };
      }
      if (contentKey && journalMap.has(contentKey)) {
        return { key: contentKey, entry: journalMap.get(contentKey) };
      }
      if (pid !== null && journalMap.has(pid)) {
        return { key: pid, entry: journalMap.get(pid) };
      }
      if (pid !== null && journalMap.has(String(pid))) {
        return { key: String(pid), entry: journalMap.get(String(pid)) };
      }
      for (const [k, v] of journalMap.entries()) {
        if (!v || typeof v !== 'object') continue;
        if (contentKey && v.content_key && String(v.content_key) === contentKey) {
          return { key: k, entry: v };
        }
        if (pid !== null && v.photo_id !== null && v.photo_id !== undefined && Number(v.photo_id) === pid) {
          return { key: k, entry: v };
        }
        if (fName && fSize !== null && v.file_name === fName && Number(v.file_size) === fSize) {
          return { key: k, entry: v };
        }
      }
      return { key: primaryKey, entry: null };
    }

    if (journalMap && typeof journalMap === 'object') {
      const targetObj = journalMap.items && typeof journalMap.items === 'object' ? journalMap.items : journalMap;
      if (primaryKey && Object.prototype.hasOwnProperty.call(targetObj, primaryKey)) {
        return { key: primaryKey, entry: targetObj[primaryKey] };
      }
      if (contentKey && Object.prototype.hasOwnProperty.call(targetObj, contentKey)) {
        return { key: contentKey, entry: targetObj[contentKey] };
      }
      if (pid !== null && Object.prototype.hasOwnProperty.call(targetObj, String(pid))) {
        return { key: String(pid), entry: targetObj[String(pid)] };
      }
      const keys = Object.keys(targetObj);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = targetObj[k];
        if (!v || typeof v !== 'object') continue;
        if (contentKey && v.content_key && String(v.content_key) === contentKey) {
          return { key: k, entry: v };
        }
        if (pid !== null && v.photo_id !== null && v.photo_id !== undefined && Number(v.photo_id) === pid) {
          return { key: k, entry: v };
        }
        if (fName && fSize !== null && v.file_name === fName && Number(v.file_size) === fSize) {
          return { key: k, entry: v };
        }
      }
    }

    return { key: primaryKey, entry: null };
  }

  /**
   * タグ入力（文字列または配列）を正規化配列に変換する
   */
  function _toTagList(val) {
    if (!val) return [];
    const raw = Array.isArray(val) ? val : [val];
    const result = [];
    for (let i = 0; i < raw.length; i++) {
      const t = String(raw[i] ?? '').trim();
      if (t && !result.includes(t)) {
        result.push(t);
      }
    }
    return result;
  }

  /**
   * 写真に対する変更（評価・タグ追加/削除・非破壊調整パラメータ）をジャーナルにマージ記録する
   *
   * @param {Map|Object} journalMap ジャーナル格納用の Map または Object
   * @param {Object} photo 対象の写真オブジェクト
   * @param {Object} changePatch 変更内容 { rating, tagsAdded, tagsRemoved, adjustParams, updatedAt }
   * @returns {Object} マージ後のジャーナルエントリ
   */
  function recordPhotoChange(journalMap, photo, changePatch = {}) {
    if (!journalMap || !photo || typeof photo !== 'object') return null;
    const patch = changePatch || {};

    const pid = photo.id !== undefined && photo.id !== null ? Number(photo.id) : (
      photo.photo_id !== undefined && photo.photo_id !== null ? Number(photo.photo_id) : null
    );
    const contentKey = String(photo.content_key || '').trim();
    const fileName = String(photo.file_name || '').trim();
    const fileSize = photo.file_size !== undefined && photo.file_size !== null ? Number(photo.file_size) : null;
    const filePath = String(photo.file_path || '').trim();
    const dateTaken = String(photo.date_taken || '').trim();

    const { key, entry: existing } = _findExistingEntry(journalMap, photo);
    if (!key) return null;

    const nowStr = patch.updatedAt || patch.updated_at || formatLocalDateTime(new Date());

    const merged = existing
      ? {
          ...existing,
          tagsAdded: Array.isArray(existing.tagsAdded)
            ? existing.tagsAdded.slice()
            : Array.isArray(existing.add_tags)
              ? existing.add_tags.slice()
              : [],
          tagsRemoved: Array.isArray(existing.tagsRemoved)
            ? existing.tagsRemoved.slice()
            : Array.isArray(existing.remove_tags)
              ? existing.remove_tags.slice()
              : [],
          adjustParams: existing.adjustParams ? { ...existing.adjustParams } : null,
        }
      : {
          key,
          photo_id: pid,
          content_key: contentKey,
          file_name: fileName,
          file_size: fileSize,
          file_path: filePath,
          date_taken: dateTaken,
          rating: undefined,
          tagsAdded: [],
          tagsRemoved: [],
          add_tags: [],
          remove_tags: [],
          add_tag_keys: {},
          remove_tag_keys: {},
          adjustParams: null,
          updatedAt: nowStr,
        };

    // メタデータの補完更新
    if (pid !== null && !Number.isNaN(pid)) merged.photo_id = pid;
    if (contentKey) merged.content_key = contentKey;
    if (fileName) merged.file_name = fileName;
    if (fileSize !== null && !Number.isNaN(fileSize)) merged.file_size = fileSize;
    if (filePath) merged.file_path = filePath;
    if (dateTaken) merged.date_taken = dateTaken;

    // 1. 評価の更新
    if (patch.rating !== undefined) {
      merged.rating = patch.rating === null ? null : Number(patch.rating);
    }

    // 2. タグ追加のマージ（tagsRemoved から該当タグを除外）
    const addList = _toTagList(patch.tagsAdded ?? patch.add_tags ?? patch.addTag);
    for (let i = 0; i < addList.length; i++) {
      const t = addList[i];
      merged.tagsRemoved = merged.tagsRemoved.filter((rem) => rem !== t);
      if (!merged.tagsAdded.includes(t)) {
        merged.tagsAdded.push(t);
      }
    }

    // 3. タグ削除のマージ（tagsAdded から該当タグおよび子孫タグを除外）
    const remList = _toTagList(patch.tagsRemoved ?? patch.remove_tags ?? patch.removeTag);
    for (let i = 0; i < remList.length; i++) {
      const t = remList[i];
      const prefix = `${t}/`;
      merged.tagsAdded = merged.tagsAdded.filter((add) => add !== t && !add.startsWith(prefix));
      if (!merged.tagsRemoved.includes(t)) {
        merged.tagsRemoved.push(t);
      }
    }

    // 互換フィールド同期
    merged.add_tags = merged.tagsAdded.slice();
    merged.remove_tags = merged.tagsRemoved.slice();

    if (patch.add_tag_keys && typeof patch.add_tag_keys === 'object') {
      merged.add_tag_keys = { ...(merged.add_tag_keys || {}), ...patch.add_tag_keys };
    }
    if (patch.remove_tag_keys && typeof patch.remove_tag_keys === 'object') {
      merged.remove_tag_keys = { ...(merged.remove_tag_keys || {}), ...patch.remove_tag_keys };
    }

    // 4. 非破壊調整パラメータのマージ
    const incomingAdjust = patch.adjustParams ?? patch.adjust_params ?? patch.adjustments;
    if (incomingAdjust && typeof incomingAdjust === 'object') {
      merged.adjustParams = {
        ...(merged.adjustParams || {}),
        ...incomingAdjust,
      };
    }

    merged.updatedAt = nowStr;
    merged.updated_at = nowStr;

    if (journalMap instanceof Map) {
      journalMap.set(key, merged);
    } else if (journalMap.items && typeof journalMap.items === 'object') {
      journalMap.items[key] = merged;
    } else if (typeof journalMap === 'object') {
      journalMap[key] = merged;
    }

    return merged;
  }

  /**
   * 任意の形式（Map / Array / Object）で渡されたジャーナルからエントリ配列を取り出す
   */
  function _extractEntriesArray(journalEntries) {
    if (!journalEntries) return [];
    if (Array.isArray(journalEntries)) return journalEntries.filter(Boolean);
    if (journalEntries instanceof Map) return Array.from(journalEntries.values()).filter(Boolean);
    if (typeof journalEntries === 'object') {
      if (Array.isArray(journalEntries.changes)) {
        return journalEntries.changes.filter(Boolean);
      }
      if (journalEntries.items && typeof journalEntries.items === 'object') {
        return Object.values(journalEntries.items).filter(Boolean);
      }
      // 単一エントリオブジェクトが直接渡された場合の判定
      if (
        'photo_id' in journalEntries ||
        'content_key' in journalEntries ||
        'tagsAdded' in journalEntries ||
        'add_tags' in journalEntries
      ) {
        return [journalEntries];
      }
      return Object.values(journalEntries).filter((v) => v && typeof v === 'object');
    }
    return [];
  }

  /**
   * DBから読み込んだ写真配列に対し、未同期ジャーナルの変更を上書き適用（Replay）して返す
   * 照合優先順:
   *   1. content_key 一致
   *   2. photo_id 一致
   *   3. file_name + file_size 一致
   *
   * @param {Array<Object>} photos 写真オブジェクト配列
   * @param {Map|Array|Object} journalEntries 未同期ジャーナル
   * @returns {Array<Object>} ジャーナル反映済みの写真オブジェクト配列
   */
  function replayJournalOnPhotos(photos, journalEntries) {
    if (!Array.isArray(photos)) return [];
    const entries = _extractEntriesArray(journalEntries);
    if (entries.length === 0) return photos;

    const byContentKey = new Map();
    const byPhotoId = new Map();
    const byNameAndSize = new Map();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') continue;
      const ck = String(entry.content_key || '').trim();
      if (ck) byContentKey.set(ck, entry);

      const pid = entry.photo_id !== undefined && entry.photo_id !== null ? Number(entry.photo_id) : null;
      if (pid !== null && !Number.isNaN(pid)) {
        byPhotoId.set(pid, entry);
      }

      const fn = String(entry.file_name || '').trim();
      const fs = entry.file_size !== undefined && entry.file_size !== null ? Number(entry.file_size) : null;
      if (fn && fs !== null && !Number.isNaN(fs)) {
        byNameAndSize.set(`${fn}::${fs}`, entry);
      }
    }

    const TOP_ADJUST_KEYS = [
      'rotation',
      'fine_angle',
      'crop_x',
      'crop_y',
      'crop_w',
      'crop_h',
      'crop_aspect',
      'brightness',
      'contrast',
      'saturation',
      'exposure',
    ];

    return photos.map((photo) => {
      if (!photo || typeof photo !== 'object') return photo;

      // 1. content_key 優先一致
      let matched = null;
      const pContentKey = String(photo.content_key || '').trim();
      if (pContentKey && byContentKey.has(pContentKey)) {
        matched = byContentKey.get(pContentKey);
      }

      // 2. photo_id 一致フォールバック
      if (!matched) {
        const rawPid = photo.id !== undefined && photo.id !== null ? photo.id : photo.photo_id;
        if (rawPid !== undefined && rawPid !== null) {
          const pId = Number(rawPid);
          if (!Number.isNaN(pId) && byPhotoId.has(pId)) {
            matched = byPhotoId.get(pId);
          }
        }
      }

      // 3. file_name + file_size 一致フォールバック
      if (!matched) {
        const fn = String(photo.file_name || '').trim();
        const fs = photo.file_size !== undefined && photo.file_size !== null ? Number(photo.file_size) : null;
        if (fn && fs !== null && !Number.isNaN(fs)) {
          const nsKey = `${fn}::${fs}`;
          if (byNameAndSize.has(nsKey)) {
            matched = byNameAndSize.get(nsKey);
          }
        }
      }

      if (!matched) return photo;

      // 評価の上書き
      if (matched.rating !== undefined && matched.rating !== null) {
        photo.rating = Number(matched.rating);
      }

      // タグの上書き（削除 -> 追加）
      const currentTags = Array.isArray(photo.tags)
        ? photo.tags.map((t) => String(t ?? '').trim()).filter(Boolean)
        : [];
      const remTags = _toTagList(matched.tagsRemoved ?? matched.remove_tags);
      const addTags = _toTagList(matched.tagsAdded ?? matched.add_tags);

      let nextTags = currentTags;
      if (remTags.length > 0) {
        nextTags = nextTags.filter(
          (pt) => !remTags.some((rem) => pt === rem || pt.startsWith(`${rem}/`))
        );
      }
      if (addTags.length > 0) {
        for (let i = 0; i < addTags.length; i++) {
          const addTag = addTags[i];
          if (!nextTags.includes(addTag)) {
            nextTags.push(addTag);
          }
        }
      }
      if (remTags.length > 0 || addTags.length > 0 || Array.isArray(photo.tags)) {
        photo.tags = nextTags;
      }

      // 非破壊調整パラメータの上書き
      const adj = matched.adjustParams ?? matched.adjust_params;
      if (adj && typeof adj === 'object') {
        photo.adjustParams = {
          ...(photo.adjustParams || {}),
          ...adj,
        };
        for (let i = 0; i < TOP_ADJUST_KEYS.length; i++) {
          const k = TOP_ADJUST_KEYS[i];
          if (adj[k] !== undefined) {
            photo[k] = adj[k];
          }
        }
      }

      if (matched.updatedAt || matched.updated_at) {
        photo.updated_at = matched.updatedAt || matched.updated_at;
      }
      photo._journalReplayed = true;

      return photo;
    });
  }

  /**
   * PC側の /api/mobile/sync (/api/mobile/sync-import) および cache/mobile_sync.json と
   * 完全互換の同期データオブジェクトおよびJSON文字列を構築する
   *
   * @param {Map|Array|Object} journalEntries 未同期ジャーナル
   * @param {Object} [meta] メタ情報 { version, source_db, exported_at }
   * @returns {Object} { format, version, exported_at, source_db, changes, json, jsonString, payload }
   */
  function buildMobileSyncJson(journalEntries, meta = {}) {
    const entries = _extractEntriesArray(journalEntries);
    const exportedAt = (meta && meta.exported_at) ? String(meta.exported_at) : formatLocalDateTime(new Date());
    const version = (meta && meta.version !== undefined) ? meta.version : 1;
    const sourceDb = (meta && (meta.source_db || meta.dbName)) ? String(meta.source_db || meta.dbName) : 'library.db';

    const changes = entries.map((entry) => {
      const addTags = _toTagList(entry.tagsAdded ?? entry.add_tags);
      const removeTags = _toTagList(entry.tagsRemoved ?? entry.remove_tags);
      const adjustParams = entry.adjustParams ?? entry.adjust_params ?? null;
      const pid = entry.photo_id !== undefined && entry.photo_id !== null ? Number(entry.photo_id) : null;
      const fSize = entry.file_size !== undefined && entry.file_size !== null ? Number(entry.file_size) : null;

      return {
        photo_id: pid !== null && !Number.isNaN(pid) ? pid : null,
        content_key: String(entry.content_key || ''),
        file_path: String(entry.file_path || ''),
        file_name: String(entry.file_name || ''),
        file_size: fSize !== null && !Number.isNaN(fSize) ? fSize : null,
        date_taken: String(entry.date_taken || ''),
        rating: entry.rating !== undefined && entry.rating !== null ? Number(entry.rating) : null,
        add_tags: addTags,
        remove_tags: removeTags,
        tagsAdded: addTags.slice(),
        tagsRemoved: removeTags.slice(),
        add_tag_keys: entry.add_tag_keys && typeof entry.add_tag_keys === 'object' ? { ...entry.add_tag_keys } : {},
        remove_tag_keys:
          entry.remove_tag_keys && typeof entry.remove_tag_keys === 'object' ? { ...entry.remove_tag_keys } : {},
        adjust_params: adjustParams ? { ...adjustParams } : null,
        adjustParams: adjustParams ? { ...adjustParams } : null,
        updated_at: String(entry.updatedAt || entry.updated_at || exportedAt),
      };
    });

    const payload = {
      format: 'photo-manager-mobile-sync-v1',
      version,
      exported_at: exportedAt,
      source_db: sourceDb,
      changes,
    };

    const jsonString = JSON.stringify(payload, null, 2) + '\n';

    return {
      format: payload.format,
      version: payload.version,
      exported_at: payload.exported_at,
      source_db: payload.source_db,
      changes: payload.changes,
      payload,
      json: jsonString,
      jsonString,
      toJSON() {
        return payload;
      },
    };
  }

  const JournalSync = {
    formatLocalDateTime,
    recordPhotoChange,
    replayJournalOnPhotos,
    buildMobileSyncJson,
  };

  globalScope.TetheractCore = globalScope.TetheractCore || {};
  globalScope.TetheractCore.JournalSync = JournalSync;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = JournalSync;
  }
})(typeof window !== 'undefined' ? window : globalThis);
