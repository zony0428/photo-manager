/**
 * Tetheract Photo Manager - Core Filter Engine (Layer 2)
 * PC版・単体モバイルHTML版・Androidネイティブアプリ版で共通利用するフィルタ条件・SQL構築・メモリ判定モジュール。
 * DOM操作や通信処理（fetch等）を一切含まない純粋関数で構成する。
 */

(function (globalScope) {
  'use strict';

  /**
   * デフォルトのフィルタ状態オブジェクトを生成して返す
   */
  function createDefaultFilterState() {
    return {
      ratings: [],
      ratingUnrated: false,
      search: '',
      tagInclude: [],
      tagExclude: [],
      folder: '',
      gearCamera: '',
      gearLens: '',
      yearMonth: '',
      placePrefecture: '',
      placeCity: '',
      sortBy: 'date_desc',
      attrFilter: 'all',
    };
  }

  /**
   * 文字列配列を正規化する（空白除去・空要素除外・重複排除）
   */
  function _normalizeStringArray(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      const s = String(arr[i] ?? '').trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        result.push(s);
      }
    }
    return result;
  }

  /**
   * 数値配列を正規化する（NaN除外・重複排除）
   */
  function _normalizeNumberArray(arr) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const result = [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === null || arr[i] === undefined || arr[i] === '') continue;
      const n = Number(arr[i]);
      if (!Number.isNaN(n) && !seen.has(n)) {
        seen.add(n);
        result.push(n);
      }
    }
    return result;
  }

  /**
   * フォルダパスを比較用に正規化する（末尾スラッシュ除去）
   */
  function _trimTrailingSeparator(folderPath) {
    const raw = String(folderPath || '').trim();
    if (!raw) return '';
    return raw.replace(/[\\/]+$/, '');
  }

  /**
   * 撮影日時文字列から YYYY-MM または YYYY 比較用のプレフィックス（ハイフン区切り）を返す
   */
  function _normalizeDatePrefix(dateStr) {
    if (!dateStr) return '';
    return String(dateStr)
      .trim()
      .replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
      .replace(/^(\d{4}):(\d{2})/, '$1-$2');
  }

  /**
   * 写真オブジェクトが非破壊調整済みかどうかを判定する
   */
  function _isPhotoAdjusted(photo) {
    if (!photo || typeof photo !== 'object') return false;
    if (
      Number(photo.rotation || 0) !== 0 ||
      Number(photo.fine_angle || 0) !== 0 ||
      Number(photo.brightness || 0) !== 0 ||
      Number(photo.contrast || 0) !== 0 ||
      Number(photo.saturation || 0) !== 0 ||
      (photo.crop_w !== null && photo.crop_w !== undefined && Number(photo.crop_w) > 0 && Number(photo.crop_w) < 1)
    ) {
      return true;
    }
    if (photo.adjustParams && typeof photo.adjustParams === 'object') {
      const ap = photo.adjustParams;
      return Boolean(
        Number(ap.rotation || 0) !== 0 ||
        Number(ap.fine_angle || 0) !== 0 ||
        Number(ap.brightness || 0) !== 0 ||
        Number(ap.contrast || 0) !== 0 ||
        Number(ap.saturation || 0) !== 0 ||
        Number(ap.exposure || 0) !== 0 ||
        (ap.crop_w !== null && ap.crop_w !== undefined)
      );
    }
    return false;
  }

  /**
   * SQLite (Android Native SQLite / sql.js) の photos / photo_tags テーブルに対する
   * パラメータ化 WHERE 句と ORDER BY 句を構築して返す
   *
   * @param {Object} filterState フィルタ状態オブジェクト
   * @param {Object} [options] オプション設定 (includeUnlinked, tableAlias, folderColumn, prefectureColumn 等)
   * @returns {{ whereSql: string, params: Array<any>, orderSql: string }}
   */
  function buildSqlWhereAndOrder(filterState = {}, options = {}) {
    const state = { ...createDefaultFilterState(), ...(filterState || {}) };
    const alias = options.tableAlias ? `${String(options.tableAlias).trim()}.` : '';
    const col = (name) => `${alias}${name}`;
    const folderCol = options.folderColumn || 'directory';
    const prefCol = options.prefectureColumn || 'prefecture';

    const clauses = [];
    const params = [];

    // 1. リンク切れおよびRAW+JPEGペアの従属RAWレコード除外
    if (!options.includeUnlinked && !state.includeUnlinked) {
      clauses.push(`${col('is_unlinked')} = 0`);
    }
    if (!options.includePairedRaw) {
      clauses.push(
        `NOT (COALESCE(${col('is_raw')}, 0) = 1 AND ${col('paired_raw_path')} IS NOT NULL AND ${col('paired_raw_path')} != '')`
      );
    }

    // 2. 評価フィルタ（ratings: 5=優, 4=良, 3=可, -1=棄 等 / ratingUnrated: rating = 0 OR rating IS NULL）
    const ratings = _normalizeNumberArray(state.ratings);
    const ratingUnrated = Boolean(state.ratingUnrated);
    if (ratings.length > 0 && ratingUnrated) {
      const ph = ratings.map(() => '?').join(', ');
      clauses.push(`(${col('rating')} IN (${ph}) OR ${col('rating')} = 0 OR ${col('rating')} IS NULL)`);
      params.push(...ratings);
    } else if (ratings.length > 0) {
      const ph = ratings.map(() => '?').join(', ');
      clauses.push(`${col('rating')} IN (${ph})`);
      params.push(...ratings);
    } else if (ratingUnrated) {
      clauses.push(`(${col('rating')} = 0 OR ${col('rating')} IS NULL)`);
    }

    // 3. タグ含む（AND条件: 指定した全タグを持つ photo_id。階層タグの前方一致対応）
    const tagInclude = _normalizeStringArray(state.tagInclude || state.includeTags);
    for (let i = 0; i < tagInclude.length; i++) {
      const t = tagInclude[i];
      clauses.push(
        `${col('id')} IN (SELECT photo_id FROM photo_tags WHERE tag = ? OR tag LIKE ? || '/%')`
      );
      params.push(t, t);
    }

    // 4. タグ除外（NOT条件: 指定したタグおよび子孫タグを持たない photo_id）
    const tagExclude = _normalizeStringArray(state.tagExclude || state.excludeTags);
    for (let i = 0; i < tagExclude.length; i++) {
      const t = tagExclude[i];
      clauses.push(
        `${col('id')} NOT IN (SELECT photo_id FROM photo_tags WHERE tag = ? OR tag LIKE ? || '/%')`
      );
      params.push(t, t);
    }

    // 5. フォルダ指定（directory = ? OR directory LIKE ?）
    const folder = _trimTrailingSeparator(state.folder);
    if (folder) {
      const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
      clauses.push(`(${col(folderCol)} = ? OR ${col(folderCol)} LIKE ?)`);
      params.push(folder, `${folder}${sep}%`);
    }

    // 6. 機材（カメラ・レンズ）
    const gearCamera = String(state.gearCamera || '').trim();
    if (gearCamera) {
      clauses.push(`${col('camera_model')} = ?`);
      params.push(gearCamera);
    }

    const gearLens = String(state.gearLens || '').trim();
    if (gearLens) {
      clauses.push(`${col('lens_model')} = ?`);
      params.push(gearLens);
    }

    // 7. 撮影年月・年（substr(date_taken, 1, 7) = ? または 4桁年 substr(date_taken, 1, 4) = ?）
    const yearMonth = String(state.yearMonth || '').trim();
    if (yearMonth) {
      if (yearMonth.length === 4) {
        clauses.push(`substr(${col('date_taken')}, 1, 4) = ?`);
        params.push(yearMonth);
      } else {
        clauses.push(`substr(${col('date_taken')}, 1, 7) = ?`);
        params.push(yearMonth);
      }
    }

    // 8. 撮影地（都道府県・市区町村）
    const placePrefecture = String(state.placePrefecture || '').trim();
    if (placePrefecture) {
      clauses.push(`${col(prefCol)} = ?`);
      params.push(placePrefecture);
    }

    const placeCity = String(state.placeCity || '').trim();
    if (placeCity) {
      clauses.push(`${col('city')} = ?`);
      params.push(placeCity);
    }

    // 9. テキスト検索（file_name / camera_model / lens_model / タグ一致）
    const search = String(state.search || '').trim();
    if (search) {
      const likeVal = `%${search}%`;
      clauses.push(
        `(${col('file_name')} LIKE ? OR ${col('camera_model')} LIKE ? OR ${col('lens_model')} LIKE ? OR ${col('id')} IN (SELECT photo_id FROM photo_tags WHERE tag LIKE ?))`
      );
      params.push(likeVal, likeVal, likeVal, likeVal);
    }

    // 10. 属性フィルタ（attrFilter: 'raw', 'jpeg', 'adjusted' 等）
    const attrFilter = String(state.attrFilter || 'all').trim().toLowerCase();
    if (attrFilter === 'raw') {
      clauses.push(`(COALESCE(${col('is_raw')}, 0) = 1 AND (${col('paired_raw_path')} IS NULL OR ${col('paired_raw_path')} = ''))`);
    } else if (attrFilter === 'raw_pair') {
      clauses.push(`(${col('paired_raw_path')} IS NOT NULL AND ${col('paired_raw_path')} != '')`);
    } else if (attrFilter === 'raw_any') {
      clauses.push(`(COALESCE(${col('is_raw')}, 0) = 1 OR (${col('paired_raw_path')} IS NOT NULL AND ${col('paired_raw_path')} != ''))`);
    } else if (attrFilter === 'jpeg' || attrFilter === 'jpg') {
      clauses.push(`(COALESCE(${col('is_raw')}, 0) = 0 AND (${col('paired_raw_path')} IS NULL OR ${col('paired_raw_path')} = ''))`);
    } else if (attrFilter === 'adjusted') {
      clauses.push(
        `(${col('rotation')} != 0 OR ${col('fine_angle')} != 0 OR ${col('crop_w')} IS NOT NULL OR ${col('brightness')} != 0 OR ${col('contrast')} != 0 OR ${col('saturation')} != 0)`
      );
    } else if (attrFilter === 'gps' || attrFilter === 'has_gps') {
      clauses.push(`(${col('latitude')} IS NOT NULL AND ${col('longitude')} IS NOT NULL)`);
    } else if (attrFilter === 'no_gps' || attrFilter === 'no_location') {
      clauses.push(`(${col('latitude')} IS NULL OR ${col('longitude')} IS NULL)`);
    }

    // 11. ソート順（sortBy）
    const sortMap = {
      date_desc: `${col('date_taken')} DESC, ${col('id')} DESC`,
      date_asc: `${col('date_taken')} ASC, ${col('id')} ASC`,
      name_asc: `${col('file_name')} ASC, ${col('id')} ASC`,
      name_desc: `${col('file_name')} DESC, ${col('id')} DESC`,
      rating_desc: `${col('rating')} DESC, ${col('date_taken')} DESC, ${col('id')} DESC`,
      rating_asc: `${col('rating')} ASC, ${col('date_taken')} DESC, ${col('id')} DESC`,
      iso_desc: `${col('iso')} DESC, ${col('date_taken')} DESC, ${col('id')} DESC`,
      iso_asc: `${col('iso')} ASC, ${col('date_taken')} DESC, ${col('id')} DESC`,
      focal_desc: `${col('focal_length')} DESC, ${col('date_taken')} DESC, ${col('id')} DESC`,
      aperture_asc: `${col('f_number')} ASC, ${col('date_taken')} DESC, ${col('id')} DESC`,
    };
    const sortKey = String(state.sortBy || 'date_desc').trim();
    const orderSql = sortMap[sortKey] || sortMap.date_desc;
    const whereSql = clauses.length > 0 ? clauses.join(' AND ') : '1 = 1';

    return {
      whereSql,
      params,
      orderSql,
    };
  }

  /**
   * メモリ上の写真オブジェクトがフィルタ条件に一致するか高速判定する
   *
   * @param {Object} photo 写真レコードオブジェクト
   * @param {Object} filterState フィルタ状態オブジェクト
   * @returns {boolean}
   */
  function matchesPhotoInMemory(photo, filterState = {}) {
    if (!photo || typeof photo !== 'object') return false;
    const state = { ...createDefaultFilterState(), ...(filterState || {}) };

    // 1. リンク切れチェック
    if (!state.includeUnlinked && photo.is_unlinked !== undefined && Number(photo.is_unlinked) !== 0) {
      return false;
    }

    // 2. 評価フィルタ
    const ratings = _normalizeNumberArray(state.ratings);
    const ratingUnrated = Boolean(state.ratingUnrated);
    if (ratings.length > 0 || ratingUnrated) {
      const rawRating = photo.rating;
      const isNullOrZero = rawRating === null || rawRating === undefined || Number(rawRating) === 0;
      const numRating = isNullOrZero ? 0 : Number(rawRating);
      const matchedUnrated = ratingUnrated && isNullOrZero;
      const matchedRated = ratings.includes(numRating);
      if (!matchedUnrated && !matchedRated) {
        return false;
      }
    }

    // 写真が保持するタグ配列を取得
    const photoTags = Array.isArray(photo.tags)
      ? photo.tags.map((t) => (typeof t === 'string' ? t : String(t?.tag || t?.name || ''))).filter(Boolean)
      : [];

    // 3. タグ含む（AND条件・階層前方一致対応）
    const tagInclude = _normalizeStringArray(state.tagInclude || state.includeTags);
    if (tagInclude.length > 0) {
      for (let i = 0; i < tagInclude.length; i++) {
        const reqTag = tagInclude[i];
        const prefix = `${reqTag}/`;
        const hasMatch = photoTags.some((pt) => pt === reqTag || pt.startsWith(prefix));
        if (!hasMatch) return false;
      }
    }

    // 4. タグ除外（NOT条件・階層前方一致対応）
    const tagExclude = _normalizeStringArray(state.tagExclude || state.excludeTags);
    if (tagExclude.length > 0) {
      for (let i = 0; i < tagExclude.length; i++) {
        const excTag = tagExclude[i];
        const prefix = `${excTag}/`;
        const hasExcluded = photoTags.some((pt) => pt === excTag || pt.startsWith(prefix));
        if (hasExcluded) return false;
      }
    }

    // 5. フォルダ一致（自身またはサブフォルダ）
    const folder = _trimTrailingSeparator(state.folder).replace(/\\/g, '/');
    if (folder) {
      const pDir = _trimTrailingSeparator(photo.directory ?? photo.directory_path ?? '').replace(/\\/g, '/');
      if (pDir !== folder && !pDir.startsWith(`${folder}/`)) {
        return false;
      }
    }

    // 6. 機材（カメラ・レンズ）
    const gearCamera = String(state.gearCamera || '').trim();
    if (gearCamera) {
      const pCam = String(photo.camera_model ?? photo.camera ?? '').trim();
      if (pCam !== gearCamera) return false;
    }

    const gearLens = String(state.gearLens || '').trim();
    if (gearLens) {
      const pLens = String(photo.lens_model ?? photo.lens ?? '').trim();
      if (pLens !== gearLens) return false;
    }

    // 7. 撮影年月・年
    const yearMonth = String(state.yearMonth || '').trim();
    if (yearMonth) {
      const pYm = String(photo.year_month || '').trim();
      const normDate = _normalizeDatePrefix(photo.date_taken || pYm);
      if (yearMonth.length === 4) {
        if (normDate.slice(0, 4) !== yearMonth && pYm.slice(0, 4) !== yearMonth) {
          return false;
        }
      } else if (normDate.slice(0, 7) !== yearMonth && pYm !== yearMonth) {
        return false;
      }
    }

    // 8. 撮影地（都道府県・市区町村）
    const placePrefecture = String(state.placePrefecture || '').trim();
    if (placePrefecture) {
      const pPref = String(photo.prefecture ?? photo.state ?? '').trim();
      if (pPref !== placePrefecture) return false;
    }

    const placeCity = String(state.placeCity || '').trim();
    if (placeCity) {
      const pCity = String(photo.city ?? '').trim();
      if (pCity !== placeCity) return false;
    }

    // 9. テキスト検索（ファイル名・カメラ・レンズ・タグの部分一致）
    const search = String(state.search || '').trim().toLowerCase();
    if (search) {
      const fName = String(photo.file_name || '').toLowerCase();
      const cModel = String(photo.camera_model ?? photo.camera ?? '').toLowerCase();
      const lModel = String(photo.lens_model ?? photo.lens ?? '').toLowerCase();
      const matchedText =
        fName.includes(search) ||
        cModel.includes(search) ||
        lModel.includes(search) ||
        photoTags.some((pt) => pt.toLowerCase().includes(search));
      if (!matchedText) return false;
    }

    // 10. 属性フィルタ
    const attrFilter = String(state.attrFilter || 'all').trim().toLowerCase();
    if (attrFilter && attrFilter !== 'all') {
      const hasPair = Boolean(photo.paired_raw_path && String(photo.paired_raw_path).trim() !== '');
      const isRawFile = Boolean(
        Number(photo.is_raw || 0) === 1 ||
        /\.(arw|cr2|cr3|nef|nrw|orf|raf|rw2|pef|srw|dng|x3f)$/i.test(String(photo.file_name || ''))
      );
      if (attrFilter === 'raw' && !(isRawFile && !hasPair)) return false;
      if (attrFilter === 'raw_pair' && !hasPair) return false;
      if (attrFilter === 'raw_any' && !(isRawFile || hasPair)) return false;
      if ((attrFilter === 'jpeg' || attrFilter === 'jpg') && (isRawFile || hasPair)) return false;
      if (attrFilter === 'adjusted' && !_isPhotoAdjusted(photo)) return false;
      if (attrFilter === 'gps' || attrFilter === 'has_gps') {
        if (photo.latitude === null || photo.latitude === undefined || photo.longitude === null || photo.longitude === undefined) {
          return false;
        }
      }
      if (attrFilter === 'no_gps' || attrFilter === 'no_location') {
        if (photo.latitude !== null && photo.latitude !== undefined && photo.longitude !== null && photo.longitude !== undefined) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * メモリ上の写真配列を指定のソート順で並び替えた新しい配列を返す
   */
  function sortPhotosInMemory(photos, sortBy = 'date_desc') {
    if (!Array.isArray(photos)) return [];
    const list = photos.slice();
    const key = String(sortBy || 'date_desc').trim();

    list.sort((a, b) => {
      if (key === 'date_asc') {
        const cmp = String(a?.date_taken || '').localeCompare(String(b?.date_taken || ''));
        return cmp !== 0 ? cmp : (Number(a?.id || 0) - Number(b?.id || 0));
      }
      if (key === 'name_asc') {
        return String(a?.file_name || '').localeCompare(String(b?.file_name || ''), undefined, { numeric: true, sensitivity: 'base' });
      }
      if (key === 'name_desc') {
        return String(b?.file_name || '').localeCompare(String(a?.file_name || ''), undefined, { numeric: true, sensitivity: 'base' });
      }
      if (key === 'rating_desc') {
        const rDiff = Number(b?.rating || 0) - Number(a?.rating || 0);
        if (rDiff !== 0) return rDiff;
        return String(b?.date_taken || '').localeCompare(String(a?.date_taken || ''));
      }
      if (key === 'iso_desc') {
        const iDiff = Number(b?.iso || 0) - Number(a?.iso || 0);
        if (iDiff !== 0) return iDiff;
        return String(b?.date_taken || '').localeCompare(String(a?.date_taken || ''));
      }
      // デフォルト: date_desc
      const cmp = String(b?.date_taken || '').localeCompare(String(a?.date_taken || ''));
      return cmp !== 0 ? cmp : (Number(b?.id || 0) - Number(a?.id || 0));
    });

    return list;
  }

  const FilterEngine = {
    createDefaultFilterState,
    buildSqlWhereAndOrder,
    matchesPhotoInMemory,
    sortPhotosInMemory,
  };

  globalScope.TetheractCore = globalScope.TetheractCore || {};
  globalScope.TetheractCore.FilterEngine = FilterEngine;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FilterEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
