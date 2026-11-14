/**
 * Tetheract Photo Manager - Core Tree Builder (Layer 2)
 * PC版・単体モバイルHTML版・Androidネイティブアプリ版で共通利用する階層ツリー構築モジュール。
 * タグ階層・タイムライン（年＞月）・機材（カメラ＞レンズ）・撮影地（国＞都道府県＞市区町村）・フォルダ階層を
 * DOM非依存の純粋関数として構築する。
 */

(function (globalScope) {
  'use strict';

  /**
   * 自然順（数値考慮・大小文字非区別）で文字列を比較する
   */
  function _naturalCompare(a, b) {
    return String(a ?? '').localeCompare(String(b ?? ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  /**
   * タグ一覧から親子階層ツリーを構築する
   *
   * @param {Array<{tag: string, count?: number, color?: string}>} tagRows
   * @param {Object} [options] { sortByCount: boolean, preAggregated: boolean }
   * @returns {Array<{name: string, fullPath: string, count: number, color: string|null, children: Array}>}
   */
  function buildTagHierarchy(tagRows, options = { sortByCount: false }) {
    if (!Array.isArray(tagRows) || tagRows.length === 0) return [];
    const sortByCount = Boolean(options && options.sortByCount);
    const preAggregated = Boolean(options && options.preAggregated);

    const rootMap = new Map();

    for (let i = 0; i < tagRows.length; i++) {
      const row = tagRows[i];
      if (!row) continue;
      const rawTag = typeof row === 'string' ? row : String(row.tag ?? row.fullPath ?? row.name ?? '');
      const parts = rawTag
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) continue;

      const rowCount = Number(row.count || 0);
      const rowColor = row.color || null;

      let currentMap = rootMap;
      let currentPath = '';

      for (let depth = 0; depth < parts.length; depth++) {
        const part = parts[depth];
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        if (!currentMap.has(part)) {
          currentMap.set(part, {
            name: part,
            fullPath: currentPath,
            count: 0,
            _explicitCount: 0,
            color: null,
            tag_key: '',
            short_name: '',
            is_pinned: false,
            source: 'manual',
            _childrenMap: new Map(),
            children: [],
          });
        }

        const node = currentMap.get(part);
        if (depth === parts.length - 1) {
          node._explicitCount += rowCount;
          if (rowColor) node.color = rowColor;
          if (row.tag_key) node.tag_key = String(row.tag_key);
          if (row.short_name) node.short_name = String(row.short_name);
          if (row.is_pinned !== undefined) node.is_pinned = Boolean(row.is_pinned);
          if (row.source) node.source = String(row.source);
        } else if (!node.color && rowColor) {
          node.color = rowColor;
        }

        currentMap = node._childrenMap;
      }
    }

    function finalizeNodes(nodeMap) {
      const list = [];
      nodeMap.forEach((node) => {
        const childNodes = finalizeNodes(node._childrenMap);
        let childrenSum = 0;
        for (let i = 0; i < childNodes.length; i++) {
          childrenSum += childNodes[i].count;
          if (!node.color && childNodes[i].color) {
            node.color = childNodes[i].color;
          }
        }

        const totalCount = preAggregated
          ? Math.max(node._explicitCount, childrenSum)
          : node._explicitCount + childrenSum;

        list.push({
          name: node.name,
          fullPath: node.fullPath,
          count: totalCount,
          directCount: node._explicitCount,
          color: node.color,
          tag_key: node.tag_key,
          short_name: node.short_name,
          is_pinned: node.is_pinned,
          source: node.source,
          children: childNodes,
        });
      });

      list.sort((a, b) => {
        if (sortByCount) {
          const diff = (b.count || 0) - (a.count || 0);
          if (diff !== 0) return diff;
        }
        return _naturalCompare(a.name, b.name);
      });

      return list;
    }

    return finalizeNodes(rootMap);
  }

  /**
   * 撮影年月一覧から 年＞月 の2階層ツリーを構築する
   *
   * @param {Array<{ym?: string, year_month?: string, count?: number}>} ymRows
   * @param {Object} [options] { order: 'desc' | 'asc' }
   * @returns {Array<{year: string, count: number, months: Array<{ym: string, month: string, count: number}>}>}
   */
  function buildTimelineTree(ymRows, options = {}) {
    if (!Array.isArray(ymRows) || ymRows.length === 0) return [];
    const asc = options && options.order === 'asc';
    const yearMap = new Map();

    for (let i = 0; i < ymRows.length; i++) {
      const row = ymRows[i];
      if (!row) continue;
      const rawYm = String(row.ym ?? row.year_month ?? '').trim();
      if (!rawYm) continue;

      const normalizedYm = rawYm.replace(':', '-');
      const parts = normalizedYm.split('-');
      const year = parts[0] || '不明';
      const month = parts[1] ? parts[1].padStart(2, '0') : '';
      const count = Number(row.count || 0);

      if (!yearMap.has(year)) {
        yearMap.set(year, {
          year,
          count: 0,
          monthsMap: new Map(),
        });
      }
      const yGroup = yearMap.get(year);
      yGroup.count += count;

      const ymKey = month ? `${year}-${month}` : year;
      if (!yGroup.monthsMap.has(ymKey)) {
        yGroup.monthsMap.set(ymKey, {
          ym: ymKey,
          year_month: ymKey,
          month: month || '01',
          count: 0,
        });
      }
      yGroup.monthsMap.get(ymKey).count += count;
    }

    const years = Array.from(yearMap.values()).map((yGroup) => {
      const months = Array.from(yGroup.monthsMap.values());
      months.sort((a, b) => (asc ? _naturalCompare(a.ym, b.ym) : _naturalCompare(b.ym, a.ym)));
      return {
        year: yGroup.year,
        count: yGroup.count,
        months,
      };
    });

    years.sort((a, b) => (asc ? _naturalCompare(a.year, b.year) : _naturalCompare(b.year, a.year)));
    return years;
  }

  /**
   * 機材一覧から カメラ＞レンズ の2階層ツリーを構築する
   *
   * @param {Array<{camera?: string, camera_model?: string, lens?: string, lens_model?: string, count?: number}>} gearRows
   * @param {Object} [options] { sortByCount: boolean }
   * @returns {Array<{camera: string, camera_model: string, name: string, count: number, lenses: Array, children: Array}>}
   */
  function buildGearTree(gearRows, options = { sortByCount: false }) {
    if (!Array.isArray(gearRows) || gearRows.length === 0) return [];
    const sortByCount = options && options.sortByCount !== undefined ? Boolean(options.sortByCount) : false;
    const camMap = new Map();

    for (let i = 0; i < gearRows.length; i++) {
      const row = gearRows[i];
      if (!row) continue;
      const camera = String(row.camera ?? row.camera_model ?? '不明').trim() || '不明';
      const count = Number(row.count || 0);

      if (!camMap.has(camera)) {
        camMap.set(camera, {
          camera,
          count: 0,
          lensMap: new Map(),
        });
      }
      const cGroup = camMap.get(camera);

      if (Array.isArray(row.lenses) && row.lenses.length > 0) {
        let lensSum = 0;
        for (let j = 0; j < row.lenses.length; j++) {
          const lRow = row.lenses[j];
          const lensName = String(lRow?.lens ?? lRow?.lens_model ?? '').trim();
          const lCount = Number(lRow?.count || 0);
          lensSum += lCount;
          if (lensName) {
            cGroup.lensMap.set(lensName, (cGroup.lensMap.get(lensName) || 0) + lCount);
          }
        }
        cGroup.count += count > 0 ? count : lensSum;
      } else {
        cGroup.count += count;
        const lens = String(row.lens ?? row.lens_model ?? '').trim();
        if (lens) {
          cGroup.lensMap.set(lens, (cGroup.lensMap.get(lens) || 0) + count);
        }
      }
    }

    const result = Array.from(camMap.values()).map((cGroup) => {
      const lenses = Array.from(cGroup.lensMap.entries()).map(([lensName, lCount]) => ({
        lens: lensName,
        lens_model: lensName,
        name: lensName,
        camera: cGroup.camera,
        count: lCount,
      }));

      lenses.sort((a, b) => {
        if (sortByCount) {
          const diff = (b.count || 0) - (a.count || 0);
          if (diff !== 0) return diff;
        }
        return _naturalCompare(a.lens, b.lens);
      });

      return {
        camera: cGroup.camera,
        camera_model: cGroup.camera,
        name: cGroup.camera,
        count: cGroup.count,
        lenses,
        children: lenses,
      };
    });

    result.sort((a, b) => {
      const aUnknown = a.camera === '不明' || a.camera === 'Unknown' ? 1 : 0;
      const bUnknown = b.camera === '不明' || b.camera === 'Unknown' ? 1 : 0;
      if (aUnknown !== bUnknown) return aUnknown - bUnknown;
      if (sortByCount) {
        const diff = (b.count || 0) - (a.count || 0);
        if (diff !== 0) return diff;
      }
      return _naturalCompare(a.camera, b.camera);
    });

    return result;
  }

  /**
   * 撮影地一覧から 国＞都道府県＞市区町村 の3階層ツリーを構築する
   *
   * @param {Array<{country?: string, prefecture?: string, state?: string, city?: string, count?: number}>} placeRows
   * @param {Object} [options] { sortByCount: boolean }
   * @returns {Array<{country: string, name: string, count: number, prefectures: Array, states: Array, children: Array}>}
   */
  function buildPlaceTree(placeRows, options = { sortByCount: false }) {
    if (!Array.isArray(placeRows) || placeRows.length === 0) return [];
    const sortByCount = Boolean(options && options.sortByCount);
    const countryMap = new Map();

    for (let i = 0; i < placeRows.length; i++) {
      const row = placeRows[i];
      if (!row) continue;
      const country = String(row.country || '不明').trim() || '不明';
      const prefecture = String(row.prefecture ?? row.state ?? '').trim();
      const city = String(row.city || '').trim();
      const count = Number(row.count || 0);

      if (!countryMap.has(country)) {
        countryMap.set(country, {
          country,
          count: 0,
          prefMap: new Map(),
        });
      }
      const cObj = countryMap.get(country);
      cObj.count += count;

      if (prefecture) {
        if (!cObj.prefMap.has(prefecture)) {
          cObj.prefMap.set(prefecture, {
            prefecture,
            count: 0,
            cityMap: new Map(),
          });
        }
        const pObj = cObj.prefMap.get(prefecture);
        pObj.count += count;

        if (city) {
          pObj.cityMap.set(city, (pObj.cityMap.get(city) || 0) + count);
        }
      }
    }

    const countries = Array.from(countryMap.values()).map((cObj) => {
      const prefectures = Array.from(cObj.prefMap.values()).map((pObj) => {
        const cities = Array.from(pObj.cityMap.entries()).map(([cityName, cityCount]) => ({
          city: cityName,
          name: cityName,
          prefecture: pObj.prefecture,
          country: cObj.country,
          count: cityCount,
        }));

        cities.sort((a, b) => {
          if (sortByCount) {
            const diff = (b.count || 0) - (a.count || 0);
            if (diff !== 0) return diff;
          }
          return _naturalCompare(a.city, b.city);
        });

        return {
          prefecture: pObj.prefecture,
          state: pObj.prefecture,
          name: pObj.prefecture,
          country: cObj.country,
          count: pObj.count,
          cities,
          children: cities,
        };
      });

      prefectures.sort((a, b) => {
        if (sortByCount) {
          const diff = (b.count || 0) - (a.count || 0);
          if (diff !== 0) return diff;
        }
        return _naturalCompare(a.prefecture, b.prefecture);
      });

      return {
        country: cObj.country,
        name: cObj.country,
        count: cObj.count,
        prefectures,
        states: prefectures,
        children: prefectures,
      };
    });

    countries.sort((a, b) => {
      if (sortByCount) {
        const diff = (b.count || 0) - (a.count || 0);
        if (diff !== 0) return diff;
      }
      return _naturalCompare(a.country, b.country);
    });

    return countries;
  }

  /**
   * フォルダパス一覧から階層ツリーを構築する
   *
   * @param {Array<string|{folder?: string, directory?: string, directory_path?: string, path?: string, count?: number}>} folderRows
   * @param {Object} [options] { sortByCount: boolean }
   * @returns {Array<{name: string, path: string, fullPath: string, count: number, directCount: number, children: Array}>}
   */
  function buildFolderTree(folderRows, options = { sortByCount: false }) {
    if (!Array.isArray(folderRows) || folderRows.length === 0) return [];
    const sortByCount = Boolean(options && options.sortByCount);
    const rootMap = new Map();

    for (let i = 0; i < folderRows.length; i++) {
      const item = folderRows[i];
      if (!item) continue;
      const rawPath =
        typeof item === 'string'
          ? item
          : String(item.folder ?? item.directory ?? item.directory_path ?? item.path ?? '');
      const trimmed = rawPath.trim().replace(/[\\/]+$/, '');
      if (!trimmed) continue;

      const isBackslash = trimmed.includes('\\') && !trimmed.includes('/');
      const sep = isBackslash ? '\\' : '/';
      const hasLeadingSlash = trimmed.startsWith('/');
      const segments = trimmed
        .split(/[\\/]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (segments.length === 0) continue;

      const rowCount = typeof item === 'object' && item !== null ? Number(item.count ?? 1) : 1;

      let currentMap = rootMap;
      let currentPath = '';

      for (let depth = 0; depth < segments.length; depth++) {
        const seg = segments[depth];
        if (depth === 0) {
          currentPath = hasLeadingSlash ? `/${seg}` : seg;
        } else {
          currentPath = `${currentPath}${sep}${seg}`;
        }

        if (!currentMap.has(seg)) {
          currentMap.set(seg, {
            name: seg,
            path: currentPath,
            fullPath: currentPath,
            _directCount: 0,
            _childrenMap: new Map(),
          });
        }

        const node = currentMap.get(seg);
        if (depth === segments.length - 1) {
          node._directCount += rowCount;
        }
        currentMap = node._childrenMap;
      }
    }

    function finalizeFolderNodes(nodeMap) {
      const list = [];
      nodeMap.forEach((node) => {
        const children = finalizeFolderNodes(node._childrenMap);
        let childSum = 0;
        for (let i = 0; i < children.length; i++) {
          childSum += children[i].count;
        }
        const total = node._directCount + childSum;
        list.push({
          name: node.name,
          path: node.path,
          fullPath: node.fullPath,
          folder: node.fullPath,
          count: total,
          directCount: node._directCount,
          children,
        });
      });

      list.sort((a, b) => {
        if (sortByCount) {
          const diff = (b.count || 0) - (a.count || 0);
          if (diff !== 0) return diff;
        }
        return _naturalCompare(a.name, b.name);
      });

      return list;
    }

    return finalizeFolderNodes(rootMap);
  }

  /**
   * タグ一覧を種別（'manual' | 'ai' | 'all'）で絞り込む純粋関数
   */
  function filterTagsBySource(tagRows, sourceFilter = 'manual') {
    if (!Array.isArray(tagRows) || tagRows.length === 0) return [];
    const sf = String(sourceFilter || 'manual');
    if (sf === 'all') return tagRows;
    const out = [];
    for (let i = 0; i < tagRows.length; i++) {
      const t = tagRows[i];
      if (!t) continue;
      const src = String(t.source || 'manual');
      if (sf === 'ai') {
        if (src === 'ai' || src === 'both') {
          const cnt = t.ai_count !== undefined && Number(t.ai_count) > 0 ? Number(t.ai_count) : Number(t.count || 0);
          out.push({ ...t, count: cnt });
        }
      } else if (src === 'manual' || src === 'both') {
        const cnt = t.manual_count !== undefined && Number(t.count || 0) > 0 ? Number(t.manual_count) : Number(t.count || 0);
        out.push({ ...t, count: cnt });
      }
    }
    return out;
  }

  /**
   * スラッシュ区切りのタグパス同士を各階層セグメントの自然順で比較する
   */
  function compareTagPathNatural(pathA, pathB) {
    const partsA = String(pathA || '').split('/');
    const partsB = String(pathB || '').split('/');
    const minLen = Math.min(partsA.length, partsB.length);
    for (let i = 0; i < minLen; i++) {
      const cmp = _naturalCompare(partsA[i], partsB[i]);
      if (cmp !== 0) return cmp;
    }
    return partsA.length - partsB.length;
  }

  /**
   * PC側のタグツリー表示・編集向けにタグ配列をフィルタリングする純粋関数
   */
  function filterTagsForPcTree(tagRows, options = {}) {
    if (!Array.isArray(tagRows) || tagRows.length === 0) return [];
    const sourceFilter = options.sourceFilter || 'all';
    const colorTagMap = options.colorTagMap || null;
    const q = options.searchQuery ? String(options.searchQuery).trim().toLowerCase() : '';

    const out = [];
    for (let i = 0; i < tagRows.length; i++) {
      const t = tagRows[i];
      if (!t) continue;
      const tagName = String(t.tag ?? t.name ?? '');
      if (!tagName) continue;
      if (colorTagMap && Object.prototype.hasOwnProperty.call(colorTagMap, tagName)) continue;

      const src = t.source || 'manual';
      if (sourceFilter === 'manual_only') {
        if (src === 'ai') continue;
      } else if (sourceFilter === 'manual') {
        if (src !== 'manual' && src !== 'both') continue;
      } else if (sourceFilter === 'ai') {
        if (src !== 'ai' && src !== 'both') continue;
      }

      if (q && !tagName.toLowerCase().includes(q)) continue;
      out.push(t);
    }
    return out;
  }

  /**
   * PC側のMapベース階層タグツリー（各ノードの独立件数・メタデータ保持）を構築する純粋関数
   */
  function buildTagTreeMap(tagItems, options = {}) {
    const root = { children: new Map(), count: 0 };
    if (!Array.isArray(tagItems) || tagItems.length === 0) return root;

    const sortMode = options.sortMode || 'natural';
    const sortByCount = Boolean(options.sortByCount);

    for (let i = 0; i < tagItems.length; i++) {
      const item = tagItems[i];
      if (!item) continue;
      const rawTag = String(item.tag ?? item.name ?? '');
      const parts = rawTag.split('/').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) continue;

      let current = root;
      let currentPath = '';

      for (let idx = 0; idx < parts.length; idx++) {
        const part = parts[idx];
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
          childNode.count = Number(item.count || 0);
          childNode.source = item.source || 'manual';
          childNode.tag_key = item.tag_key || '';
          childNode.short_name = item.short_name || '';
          childNode.is_pinned = Boolean(item.is_pinned);
        }
        current = childNode;
      }
    }

    function compareTagNames(nameA, nameB) {
      if (sortMode === 'lexical_desc') {
        return nameB.localeCompare(nameA, undefined, { numeric: false, sensitivity: 'base' });
      }
      if (sortMode === 'natural') {
        return _naturalCompare(nameA, nameB);
      }
      if (sortMode === 'natural_desc') {
        return _naturalCompare(nameB, nameA);
      }
      return nameA.localeCompare(nameB, undefined, { numeric: false, sensitivity: 'base' });
    }

    function sortTreeNodes(node) {
      if (!node.children || node.children.size === 0) return;
      const sortedEntries = Array.from(node.children.entries()).sort((a, b) => {
        if (sortByCount) {
          const diff = (b[1].count || 0) - (a[1].count || 0);
          if (diff !== 0) return diff;
        }
        return compareTagNames(a[0], b[0]);
      });
      node.children = new Map(sortedEntries);
      node.children.forEach((child) => sortTreeNodes(child));
    }
    sortTreeNodes(root);

    return root;
  }

  /**
   * タグノード配下の子孫に適用中のフィルタ件数（include / exclude）を再帰集計する
   */
  function countDescendantTagFilters(node, tagFilters) {
    let inc = 0;
    let exc = 0;
    if (!node || !node.children || !tagFilters || typeof tagFilters.get !== 'function') {
      return { inc, exc };
    }
    node.children.forEach((child) => {
      const m = tagFilters.get(child.fullPath);
      if (m === 'include') inc++;
      else if (m === 'exclude') exc++;
      const sub = countDescendantTagFilters(child, tagFilters);
      inc += sub.inc;
      exc += sub.exc;
    });
    return { inc, exc };
  }

  /**
   * Mapベースのタグツリーから指定フルパスのノードを検索する
   */
  function findTagNodeByPath(treeRoot, fullPath) {
    if (!treeRoot || !treeRoot.children || !fullPath) return null;
    const parts = String(fullPath).split('/').map((p) => p.trim()).filter(Boolean);
    let cur = treeRoot;
    for (let i = 0; i < parts.length; i++) {
      if (!cur.children || typeof cur.children.get !== 'function') return null;
      cur = cur.children.get(parts[i]);
      if (!cur) return null;
    }
    return cur;
  }

  /**
   * 選択中のタグフィルタMapをカラータグと第1階層ルートグループへ構造化・整列する
   */
  function groupTagFiltersByRoot(tagFilters, availableTags = [], colorTagMap = null) {
    const colorEntries = [];
    const rootGroups = new Map();
    if (!tagFilters || typeof tagFilters.forEach !== 'function') {
      return { colorEntries, groups: [] };
    }

    tagFilters.forEach((mode, tag) => {
      if (colorTagMap && Object.prototype.hasOwnProperty.call(colorTagMap, tag)) {
        colorEntries.push({ tag, mode });
      } else {
        const root = String(tag).split('/')[0].trim();
        if (!rootGroups.has(root)) {
          rootGroups.set(root, { includes: [], excludes: [] });
        }
        const grp = rootGroups.get(root);
        if (mode === 'include') grp.includes.push(tag);
        else if (mode === 'exclude') grp.excludes.push(tag);
      }
    });

    const sortedRootKeys = Array.from(rootGroups.keys()).sort((a, b) => {
      const aHasInc = (rootGroups.get(a)?.includes?.length || 0) > 0 ? 0 : 1;
      const bHasInc = (rootGroups.get(b)?.includes?.length || 0) > 0 ? 0 : 1;
      if (aHasInc !== bHasInc) return aHasInc - bHasInc;
      return _naturalCompare(a, b);
    });

    const availList = Array.isArray(availableTags) ? availableTags : [];
    const subTagRoots = new Set();
    for (let i = 0; i < availList.length; i++) {
      const tn = String(availList[i]?.tag ?? availList[i]?.name ?? '');
      const slashIdx = tn.indexOf('/');
      if (slashIdx > 0) {
        subTagRoots.add(tn.slice(0, slashIdx).trim());
      }
    }

    const groups = sortedRootKeys.map((root) => {
      const grp = rootGroups.get(root);
      const includes = [...grp.includes].sort(compareTagPathNatural);
      const excludes = [...grp.excludes].sort(compareTagPathNatural);
      const rootHasSubTags =
        subTagRoots.has(root) ||
        includes.some((t) => t.includes('/')) ||
        excludes.some((t) => t.includes('/'));
      return { root, includes, excludes, rootHasSubTags };
    });

    return { colorEntries, groups };
  }

  /**
   * フィルタチップのグループポップオーバー向けに階層順で候補タグ一覧を抽出する
   */
  function collectGroupTagCandidates(availableTags, options = {}) {
    const availList = Array.isArray(availableTags) ? availableTags : [];
    const root = String(options.root || '');
    const rootHasSubTags = Boolean(options.rootHasSubTags);
    const q = String(options.queryText || '').trim().toLowerCase();
    const tagFilters = options.tagFilters || null;
    const colorTagMap = options.colorTagMap || null;

    const candidates = availList.filter((t) => {
      const tn = String(t?.tag ?? t?.name ?? '');
      if (!tn || (colorTagMap && Object.prototype.hasOwnProperty.call(colorTagMap, tn))) return false;
      if (q) return tn.toLowerCase().includes(q);
      if (rootHasSubTags) return tn === root || tn.startsWith(root + '/');
      return !tn.includes('/') || tn === root || Boolean(tagFilters && tagFilters.has(tn));
    });

    candidates.sort((a, b) => {
      const na = String(a?.tag ?? a?.name ?? '');
      const nb = String(b?.tag ?? b?.name ?? '');
      const aInRoot = (na === root || na.startsWith(root + '/')) ? 0 : 1;
      const bInRoot = (nb === root || nb.startsWith(root + '/')) ? 0 : 1;
      if (aInRoot !== bInRoot) return aInRoot - bInRoot;
      return compareTagPathNatural(na, nb);
    });

    return candidates;
  }

  const TreeBuilder = {
    filterTagsBySource,
    filterTagsForPcTree,
    buildTagHierarchy,
    buildTagTreeMap,
    countDescendantTagFilters,
    findTagNodeByPath,
    compareTagPathNatural,
    groupTagFiltersByRoot,
    collectGroupTagCandidates,
    buildTimelineTree,
    buildGearTree,
    buildPlaceTree,
    buildFolderTree,
  };

  globalScope.TetheractCore = globalScope.TetheractCore || {};
  globalScope.TetheractCore.TreeBuilder = TreeBuilder;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TreeBuilder;
  }
})(typeof window !== 'undefined' ? window : globalThis);
