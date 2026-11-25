/**
 * Photo Manager - Loome 保存先選択モーダル（小窓） ＆ フォルダ単位取り込み制御
 * - 右クリック等からの「Loomeへコピー」「Loome内で移動」時のエクスプローラー風フォルダ選択小窓
 * - Loome（本体・外付けドライブ）切替、パンくず移動、ダブルクリックでの子フォルダ展開、その場での新規フォルダ作成
 * - 外部フォルダ単位（サブフォルダ構造・RAW+JPEGペア・サイドカー維持）での Loome 取り込み＆フォルダD&D解析
 */

(function () {
  'use strict';

  const VALID_UPLOAD_EXT_RE = /\.(jpg|jpeg|png|webp|bmp|gif|tiff|tif|heic|heif|avif|rw2|arw|cr2|cr3|nef|nrw|dng|raf|orf|pef|srw|x3f|xmp|pp3|arp|dop|on1|cos|nksc|spd)$/i;

  const pickerState = {
    isOpen: false,
    mode: 'import',          // 'import' | 'move' | 'import_folder' | 'upload_files'
    photoIds: [],
    sourceDir: null,
    sourceName: '',
    uploadFiles: [],         // Array<{ file: File, relPath: string }>
    roots: [],               // Loome ドライブ・ルート配列
    nodeByKey: new Map(),    // cleanPath.toLowerCase() -> node
    parentByKey: new Map(),  // childKey -> parentNode
    activeRootKey: '',
    currentKey: '',          // 現在開いているフォルダの key
    selectedChildKey: '',    // リスト内でシングルクリック選択中の子フォルダ key（未選択時は空＝currentKey直下）
    isCreatingFolder: false,
    isPickingFolder: false,
    isSubmitting: false,
  };

  function _isEn() {
    return (typeof currentLang !== 'undefined' && currentLang === 'en') ||
      Boolean(window.pmI18n && typeof window.pmI18n.getLang === 'function' && window.pmI18n.getLang() === 'en');
  }

  function _normPath(p) {
    return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '');
  }

  function _normKey(p) {
    return _normPath(p).toLowerCase();
  }

  /**
   * /api/storage/folders のフラット配列から Loome ドライブ別の階層ツリーと逆引きマップを構築する
   */
  function buildLoomeHierarchy(folders) {
    const roots = [];
    const nodeByKey = new Map();
    const parentByKey = new Map();

    (folders || []).forEach(f => {
      const cleanPath = _normPath(f.path);
      const key = _normKey(cleanPath);
      if (!key) return;
      const isRoot = !!f.is_root || Number(f.depth || 0) === 0;
      const driveLabel = f.root_name || (f.name ? String(f.name).replace(/\s*\((?:直下|Root)\)\s*$/i, '') : 'Loome');
      const node = {
        ...f,
        cleanPath,
        key,
        isRoot,
        driveLabel,
        displayName: isRoot ? driveLabel : (f.name || cleanPath.split('\\').pop() || 'Folder'),
        count: Number(f.count || 0),
        totalCount: Number(f.count || 0),
        children: [],
      };
      nodeByKey.set(key, node);
      if (isRoot) {
        roots.push(node);
      }
    });

    (folders || []).forEach(f => {
      const isRoot = !!f.is_root || Number(f.depth || 0) === 0;
      if (isRoot) return;
      const cleanPath = _normPath(f.path);
      const key = _normKey(cleanPath);
      const node = nodeByKey.get(key);
      if (!node) return;

      const lastSlash = cleanPath.lastIndexOf('\\');
      if (lastSlash > 0) {
        const pKey = cleanPath.slice(0, lastSlash).toLowerCase();
        const pNode = nodeByKey.get(pKey);
        if (pNode && pNode !== node) {
          pNode.children.push(node);
          parentByKey.set(key, pNode);
          return;
        }
      }
      const fallbackRoot = roots.find(r => key.startsWith(r.key + '\\')) || roots[0];
      if (fallbackRoot && fallbackRoot !== node) {
        fallbackRoot.children.push(node);
        parentByKey.set(key, fallbackRoot);
      }
    });

    const sortAndSum = (n) => {
      n.children.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), 'ja', { numeric: true }));
      let sum = Number(n.count || 0);
      for (const ch of n.children) {
        sum += sortAndSum(ch);
      }
      n.totalCount = sum;
      return sum;
    };
    if (roots.length === 0) {
      const fallback = {
        path: '',
        cleanPath: '',
        key: '__loome_primary__',
        isRoot: true,
        is_root: true,
        is_primary_loome: true,
        driveLabel: 'Loome',
        displayName: 'Loome',
        count: 0,
        totalCount: 0,
        children: [],
      };
      roots.push(fallback);
      nodeByKey.set(fallback.key, fallback);
    } else {
      roots.forEach(sortAndSum);
    }

    return { roots, nodeByKey, parentByKey };
  }
  window.buildLoomeHierarchy = buildLoomeHierarchy;

  /**
   * 指定ノードのルートからのパンくず配列 [rootNode, ..., node] を返す
   */
  function _getBreadcrumbNodes(key) {
    const trail = [];
    let cur = pickerState.nodeByKey.get(key);
    const guard = new Set();
    while (cur && !guard.has(cur.key)) {
      guard.add(cur.key);
      trail.unshift(cur);
      cur = pickerState.parentByKey.get(cur.key) || null;
    }
    return trail;
  }

  /**
   * 現在の確定対象ノード（シングル選択中の子フォルダがあればそれ、なければ現在開いているフォルダ）を返す
   */
  function _getEffectiveTargetNode() {
    if (pickerState.selectedChildKey && pickerState.nodeByKey.has(pickerState.selectedChildKey)) {
      return pickerState.nodeByKey.get(pickerState.selectedChildKey);
    }
    return pickerState.nodeByKey.get(pickerState.currentKey) || pickerState.roots[0] || null;
  }

  function _formatNodeTrailLabel(node) {
    if (!node) return 'Loome';
    const trail = _getBreadcrumbNodes(node.key);
    if (trail.length === 0) return node.displayName || 'Loome';
    if (trail.length === 1) {
      return `${trail[0].displayName} (${_isEn() ? 'Root' : '直下'})`;
    }
    return trail.map(n => n.displayName).join(' / ');
  }

  /**
   * モーダル内の全パーツを再描画する
   */
  function renderLoomePicker() {
    const isEn = _isEn();
    const driveTabsEl = document.getElementById('loomePickerDriveTabs');
    const upBtn = document.getElementById('loomePickerUpBtn');
    const breadcrumbsEl = document.getElementById('loomePickerBreadcrumbs');
    const newFolderBar = document.getElementById('loomePickerNewFolderBar');
    const listEl = document.getElementById('loomePickerFolderList');
    const targetPreviewEl = document.getElementById('loomePickerTargetPreview');
    const submitBtn = document.getElementById('loomePickerSubmitBtn');
    const titleEl = document.getElementById('loomePickerModalTitle');
    const subtitleEl = document.getElementById('loomePickerModalSubtitle');

    if (!listEl) return;

    // 1. タイトル・サブタイトル
    if (titleEl && subtitleEl) {
      if (pickerState.mode === 'move') {
        const cnt = pickerState.photoIds.length;
        titleEl.textContent = isEn ? 'Move within Loome' : 'Loome 内で移動';
        subtitleEl.textContent = isEn
          ? `Select destination folder for ${cnt} photo(s) (Double-click folder to open)`
          : `選択中の ${cnt} 枚の移動先フォルダを選択（ダブルクリックで子フォルダを開く）`;
      } else if (pickerState.mode === 'import_folder') {
        titleEl.textContent = isEn ? 'Import Folder into Loome' : 'フォルダごと Loome へ取り込み';
        subtitleEl.textContent = pickerState.sourceName
          ? (isEn
            ? `Copy folder "${pickerState.sourceName}" (including subfolders) into Loome`
            : `フォルダ「${pickerState.sourceName}」をサブフォルダ構造ごとコピー取り込みします`)
          : (isEn
            ? 'Choose Loome parent folder, then select a folder from PC'
            : '取り込み先の Loome フォルダを選び、PC内のフォルダを丸ごと取り込みます');
      } else if (pickerState.mode === 'upload_files') {
        const fCnt = pickerState.uploadFiles.length;
        titleEl.textContent = isEn ? 'Import into Loome' : 'Loome へ取り込み';
        subtitleEl.textContent = isEn
          ? `Choose destination in Loome for ${fCnt} file(s)`
          : `${fCnt} 個のファイルの取り込み先フォルダを選択してください`;
      } else {
        const cnt = pickerState.photoIds.length;
        titleEl.textContent = isEn ? 'Copy to Loome' : 'Loome へコピー';
        subtitleEl.textContent = isEn
          ? `Select destination folder for ${cnt} photo(s) (Double-click folder to open)`
          : `選択中の ${cnt} 枚の取り込み先フォルダを選択（ダブルクリックで子フォルダを開く）`;
      }
    }

    // 2. Loome ドライブ選択タブ
    if (driveTabsEl) {
      driveTabsEl.innerHTML = '';
      pickerState.roots.forEach(rootNode => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = rootNode.key === pickerState.activeRootKey;
        btn.className = `loome-picker-drive-tab${isActive ? ' active' : ''}`;
        const icon = rootNode.is_primary_loome ? '📦' : '💾';
        const countLabel = `${Number(rootNode.totalCount || 0)}${isEn ? '' : '枚'}`;
        btn.title = rootNode.cleanPath;
        btn.innerHTML = `
          <span>${icon} ${escapeHtml(rootNode.displayName)}</span>
          <span class="loome-picker-drive-count">${escapeHtml(countLabel)}</span>
        `;
        btn.addEventListener('click', () => {
          if (pickerState.activeRootKey === rootNode.key && pickerState.currentKey === rootNode.key) {
            pickerState.selectedChildKey = '';
            renderLoomePicker();
            return;
          }
          pickerState.activeRootKey = rootNode.key;
          pickerState.currentKey = rootNode.key;
          pickerState.selectedChildKey = '';
          pickerState.isCreatingFolder = false;
          renderLoomePicker();
        });
        driveTabsEl.appendChild(btn);
      });
    }

    const currentNode = pickerState.nodeByKey.get(pickerState.currentKey) || pickerState.roots[0] || null;
    const parentNode = currentNode ? (pickerState.parentByKey.get(currentNode.key) || null) : null;

    // 3. 「↑ 上へ」ボタン ＆ パンくずリスト
    if (upBtn) {
      upBtn.disabled = !parentNode;
      upBtn.title = parentNode
        ? (isEn ? `Up to "${parentNode.displayName}" (Backspace)` : `上の階層「${parentNode.displayName}」へ戻る (Backspace)`)
        : (isEn ? 'Already at Loome root' : '最上位の Loome ルートです');
    }

    if (breadcrumbsEl && currentNode) {
      breadcrumbsEl.innerHTML = '';
      const trail = _getBreadcrumbNodes(currentNode.key);
      trail.forEach((tNode, idx) => {
        if (idx > 0) {
          const sep = document.createElement('span');
          sep.className = 'loome-picker-bc-sep';
          sep.textContent = '›';
          breadcrumbsEl.appendChild(sep);
        }
        const crumb = document.createElement('button');
        crumb.type = 'button';
        const isCurrent = idx === trail.length - 1;
        crumb.className = `loome-picker-bc-item${isCurrent ? ' is-current' : ''}`;
        const prefix = idx === 0 ? (tNode.is_primary_loome ? '📦 ' : '💾 ') : '';
        crumb.textContent = `${prefix}${tNode.displayName}`;
        crumb.title = tNode.cleanPath;
        crumb.addEventListener('click', () => {
          pickerState.currentKey = tNode.key;
          pickerState.selectedChildKey = '';
          renderLoomePicker();
        });
        breadcrumbsEl.appendChild(crumb);
      });
    }

    // 4. 新規フォルダ作成インラインバー表示制御
    if (newFolderBar) {
      newFolderBar.style.display = pickerState.isCreatingFolder ? 'flex' : 'none';
    }

    // 5. 子フォルダ一覧の描画
    listEl.innerHTML = '';
    if (!currentNode) {
      listEl.innerHTML = `<div class="loome-picker-empty">${isEn ? 'Loome folder is not available' : '利用可能な Loome フォルダが見つかりません'}</div>`;
    } else {
      // 先頭行: 現在開いている階層（直下）を明示選択できる行
      const hereRow = document.createElement('div');
      const isHereSelected = !pickerState.selectedChildKey;
      hereRow.className = `loome-picker-row is-current-dir-row${isHereSelected ? ' is-selected' : ''}`;
      const hereDirectText = `${Number(currentNode.count || 0)}${isEn ? '' : '枚'}`;
      const hereLabel = currentNode.isRoot
        ? (isEn ? `Save directly in ${currentNode.displayName} (Root)` : `${currentNode.displayName}（直下）を選択`)
        : (isEn ? `Save directly in "${currentNode.displayName}"` : `この「${currentNode.displayName}」直下を選択`);
      hereRow.innerHTML = `
        <span class="loome-picker-row-icon">📥</span>
        <span class="loome-picker-row-name">${escapeHtml(hereLabel)}</span>
        <span class="loome-picker-row-meta">${escapeHtml(hereDirectText)}</span>
      `;
      hereRow.addEventListener('click', () => {
        pickerState.selectedChildKey = '';
        renderLoomePicker();
      });
      listEl.appendChild(hereRow);

      if (currentNode.children.length === 0) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'loome-picker-empty';
        emptyHint.textContent = isEn
          ? 'No subfolders in this folder. Click "+ New Folder" above to create one, or import directly here.'
          : 'この階層に子フォルダはありません（右上の「＋新規フォルダ」で作成するか、このままここへ取り込めます）';
        listEl.appendChild(emptyHint);
      } else {
        currentNode.children.forEach(child => {
          const row = document.createElement('div');
          const isSel = pickerState.selectedChildKey === child.key;
          row.className = `loome-picker-row${isSel ? ' is-selected' : ''}`;
          const subFolderCount = child.children.length;
          const countStr = subFolderCount > 0 && child.totalCount !== child.count
            ? `${child.count}${isEn ? '' : '枚'} (${isEn ? 'Total ' : '計'}${child.totalCount})`
            : `${child.count}${isEn ? '' : '枚'}`;
          const subBadgeHtml = subFolderCount > 0
            ? `<span class="loome-picker-sub-badge" title="${isEn ? 'Double-click to open subfolders' : 'ダブルクリックで子フォルダを展開'}">📁×${subFolderCount}</span>`
            : '';

          row.innerHTML = `
            <span class="loome-picker-row-icon">📁</span>
            <span class="loome-picker-row-name" title="${escapeHtml(child.cleanPath)}">${escapeHtml(child.displayName)}</span>
            ${subBadgeHtml}
            <span class="loome-picker-row-meta">${escapeHtml(countStr)}</span>
            <button type="button" class="loome-picker-open-btn" title="${isEn ? 'Open this folder' : 'このフォルダの中を開く'}">${isEn ? 'Open ▸' : '開く ▸'}</button>
          `;

          // シングルクリック: この子フォルダを選択（再クリックで選択解除）
          row.addEventListener('click', (e) => {
            if (e.target && e.target.closest('.loome-picker-open-btn')) return;
            pickerState.selectedChildKey = (pickerState.selectedChildKey === child.key) ? '' : child.key;
            renderLoomePicker();
          });

          // ダブルクリック: この子フォルダの中へ入る
          row.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            pickerState.currentKey = child.key;
            pickerState.selectedChildKey = '';
            pickerState.isCreatingFolder = false;
            renderLoomePicker();
          });

          // 右端「開く ▸」ボタン: タッチ操作やシングルクリック派でもワンクリックで階層展開可能
          const openBtn = row.querySelector('.loome-picker-open-btn');
          if (openBtn) {
            openBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              pickerState.currentKey = child.key;
              pickerState.selectedChildKey = '';
              pickerState.isCreatingFolder = false;
              renderLoomePicker();
            });
          }

          listEl.appendChild(row);
        });
      }
    }

    // 6. フッターの保存先プレビュー ＆ 確定ボタン文言
    const targetNode = _getEffectiveTargetNode();
    const baseTrailLabel = _formatNodeTrailLabel(targetNode);
    if (targetPreviewEl) {
      if (pickerState.mode === 'import_folder' && pickerState.sourceName) {
        const cleanParent = targetNode && !targetNode.isRoot
          ? _getBreadcrumbNodes(targetNode.key).map(n => n.displayName).join(' / ')
          : (targetNode ? targetNode.displayName : 'Loome');
        targetPreviewEl.textContent = `${cleanParent} / ${pickerState.sourceName}`;
      } else {
        targetPreviewEl.textContent = baseTrailLabel;
      }
      if (targetNode) targetPreviewEl.title = targetNode.cleanPath;
    }

    if (submitBtn) {
      submitBtn.disabled = !targetNode || pickerState.isSubmitting || pickerState.isPickingFolder;
      if (pickerState.isPickingFolder) {
        submitBtn.textContent = isEn ? 'Selecting folder...' : 'ダイアログ表示中...';
      } else if (pickerState.mode === 'move') {
        submitBtn.textContent = isEn ? 'Move Here' : 'ここへ移動';
      } else if (pickerState.mode === 'import_folder') {
        submitBtn.textContent = pickerState.sourceDir
          ? (isEn ? `Import "${pickerState.sourceName}" Here` : `「${pickerState.sourceName}」をここへ取り込む`)
          : (isEn ? 'Select Folder & Import Here...' : '取り込むフォルダを選択...');
      } else {
        submitBtn.textContent = isEn ? 'Import Here' : 'ここへ取り込む';
      }
    }
  }

  /**
   * Loome 保存先選択モーダル（小窓）を開く
   */
  async function openLoomePickerModal(options = {}) {
    if (typeof closeContextMenu === 'function') closeContextMenu();
    if (typeof closeFolderContextMenu === 'function') closeFolderContextMenu();

    const mode = options.mode || 'import';
    let photoIds = Array.isArray(options.photoIds) ? [...options.photoIds] : [];

    if (mode === 'import' || mode === 'move') {
      if (photoIds.length === 0 && typeof window.getSelectedPhotosStorageBreakdown === 'function') {
        const { storagePhotoIds, externalPhotoIds } = window.getSelectedPhotosStorageBreakdown();
        if (mode === 'move') {
          photoIds = storagePhotoIds.length > 0 ? storagePhotoIds : Array.from((window.state && window.state.selectedPhotoIds) || []);
        } else {
          const linkPart = typeof partitionPhotosByLinkStatus === 'function'
            ? partitionPhotosByLinkStatus((window.state && window.state.selectedPhotoIds) || [])
            : { linkedIds: [], unlinkedIds: [] };
          const baseIds = externalPhotoIds.length > 0 ? externalPhotoIds : storagePhotoIds;
          photoIds = [...baseIds, ...linkPart.unlinkedIds];
        }
      }
      if (photoIds.length === 0) {
        if (typeof showToast === 'function') {
          showToast(mode === 'move' ? '移動する写真が選択されていません' : 'コピーする写真が選択されていません', 'info');
        }
        return;
      }
    }

    const modal = document.getElementById('loomePickerModal');
    if (!modal) return;

    pickerState.mode = mode;
    pickerState.photoIds = photoIds;
    pickerState.sourceDir = options.sourceDir || null;
    pickerState.sourceName = options.sourceName || (options.sourceDir ? _normPath(options.sourceDir).split('\\').pop() : '');
    pickerState.uploadFiles = Array.isArray(options.uploadFiles) ? options.uploadFiles : [];
    pickerState.selectedChildKey = '';
    pickerState.isCreatingFolder = false;
    pickerState.isSubmitting = false;

    const folders = typeof window.fetchStorageFolders === 'function'
      ? await window.fetchStorageFolders()
      : [];
    const { roots, nodeByKey, parentByKey } = buildLoomeHierarchy(folders);
    pickerState.roots = roots;
    pickerState.nodeByKey = nodeByKey;
    pickerState.parentByKey = parentByKey;

    // 初期表示ドライブ＆階層の決定
    let startRoot = roots.find(r => r.is_primary_loome) || roots[0] || null;
    let startNode = startRoot;
    const hintPath = options.initialDest ||
      ((window.state && window.state.currentFilter && window.state.currentFilter.type === 'folder' && typeof window.isStoragePath === 'function' && window.isStoragePath(window.state.currentFilter.value))
        ? window.state.currentFilter.value
        : '');

    if (hintPath) {
      const hintKey = _normKey(hintPath);
      const matchedRoot = roots.find(r => hintKey === r.key || hintKey.startsWith(r.key + '\\'));
      if (matchedRoot) {
        startRoot = matchedRoot;
        if (options.initialDest && nodeByKey.has(hintKey)) {
          startNode = nodeByKey.get(hintKey);
        } else {
          startNode = matchedRoot;
        }
      }
    }

    pickerState.activeRootKey = startRoot ? startRoot.key : '';
    pickerState.currentKey = startNode ? startNode.key : '';
    pickerState.isPickingFolder = false;
    pickerState.isOpen = true;

    renderLoomePicker();
    modal.style.display = 'flex';
  }
  window.openLoomePickerModal = openLoomePickerModal;

  function closeLoomePickerModal() {
    if (pickerState.isPickingFolder) {
      if (typeof showToast === 'function') {
        showToast(_isEn() ? 'Folder dialog is open' : 'フォルダ選択ダイアログが開いています', 'info', 2200);
      }
      return;
    }
    pickerState.isOpen = false;
    pickerState.isCreatingFolder = false;
    pickerState.uploadFiles = [];
    const modal = document.getElementById('loomePickerModal');
    if (modal) modal.style.display = 'none';
  }
  window.closeLoomePickerModal = closeLoomePickerModal;

  /**
   * 外部フォルダをフォルダ単位で Loome 指定先へ取り込む
   */
  async function importExternalFolderToLoome(sourceDir, destination, displayName = '') {
    const isEn = _isEn();
    if (!sourceDir && typeof showToast === 'function') {
      showToast(
        isEn ? 'Select a folder to import into Loome...' : 'Loome へ丸ごと取り込むフォルダを選択してください...',
        'info',
        3000
      );
    }

    try {
      const runTask = async () => {
        const res = await fetch('/api/storage/import-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_dir: sourceDir || null,
            destination: destination || '',
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.detail || 'フォルダの取り込みに失敗しました');
        }
        return json;
      };

      const data = typeof window._withStorageProgressPolling === 'function'
        ? await window._withStorageProgressPolling(
            isEn ? 'Importing folder into Loome...' : 'フォルダごと Loome へ取り込み中...',
            0,
            displayName || destination || 'Loome',
            runTask
          )
        : await runTask();

      if (data.status === 'cancelled') {
        if (typeof showToast === 'function') {
          showToast(isEn ? 'Folder import cancelled' : 'フォルダの取り込みをキャンセルしました', 'info', 2200);
        }
        return null;
      }

      const importedCount = Number(data.imported_count || 0);
      const folderLabel = data.destination_name || data.folder_name || displayName || 'Loome';
      if (typeof showToast === 'function') {
        showToast(
          isEn
            ? `Imported folder "${data.folder_name || ''}" (${importedCount} photos) into Loome`
            : `フォルダ「${folderLabel}」へ ${importedCount} 枚の写真を取り込みました`,
          'success',
          4200
        );
      }

      if (typeof window.fetchStorageFolders === 'function') await window.fetchStorageFolders();
      if (typeof refreshFolderTree === 'function') await refreshFolderTree();
      if (typeof fetchPhotos === 'function') await fetchPhotos();
      Promise.all([
        typeof fetchFolders === 'function' ? fetchFolders() : Promise.resolve(),
        typeof fetchTimeline === 'function' ? fetchTimeline() : Promise.resolve(),
        typeof fetchCameras === 'function' ? fetchCameras() : Promise.resolve(),
        typeof fetchDuplicatesCount === 'function' ? fetchDuplicatesCount() : Promise.resolve(),
      ]).catch(() => {});
      return data;
    } catch (err) {
      console.error('Loome フォルダ取り込みエラー:', err);
      if (typeof showToast === 'function') {
        showToast(`${err.message || 'フォルダの取り込みに失敗しました'}`, 'error', 4200);
      }
      return null;
    }
  }
  window.importExternalFolderToLoome = importExternalFolderToLoome;

  /**
   * FileSystemEntry ツリーを再帰走査して { file, relPath } 一覧を取得する（100件超のディレクトリも全件読込）
   */
  async function _traverseEntry(entry, prefix = '') {
    if (!entry) return [];
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file(
          (file) => {
            const relPath = prefix ? `${prefix}/${file.name}` : file.name;
            resolve([{ file, relPath }]);
          },
          () => resolve([])
        );
      });
    }
    if (entry.isDirectory) {
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) return [];
      const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const allEntries = [];
      const readNextBatch = () => new Promise((resolve) => {
        reader.readEntries((batch) => resolve(batch || []), () => resolve([]));
      });
      while (true) {
        const batch = await readNextBatch();
        if (!batch || batch.length === 0) break;
        allEntries.push(...batch);
      }
      const nested = await Promise.all(allEntries.map(ch => _traverseEntry(ch, dirPrefix)));
      return nested.flat();
    }
    return [];
  }

  /**
   * DataTransfer からファイルおよびドロップされたフォルダ階層を { file, relPath, hasDirectory } として抽出する
   */
  async function extractDroppedFilesWithPaths(dataTransfer) {
    if (!dataTransfer) return { items: [], hasDirectory: false };
    const dtItems = dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const entries = dtItems
      .filter(it => it.kind === 'file' && typeof it.webkitGetAsEntry === 'function')
      .map(it => it.webkitGetAsEntry())
      .filter(Boolean);

    if (entries.length > 0) {
      const hasDirectory = entries.some(en => en.isDirectory);
      const collected = (await Promise.all(entries.map(en => _traverseEntry(en, '')))).flat();
      const valid = collected.filter(({ file }) =>
        (file.type && file.type.startsWith('image/')) || VALID_UPLOAD_EXT_RE.test(file.name || '')
      );
      return { items: valid, hasDirectory };
    }

    const rawFiles = Array.from(dataTransfer.files || []);
    const valid = rawFiles
      .filter(f => (f.type && f.type.startsWith('image/')) || VALID_UPLOAD_EXT_RE.test(f.name || ''))
      .map(f => ({ file: f, relPath: f.webkitRelativePath || f.name }));
    const hasDirectory = valid.some(v => v.relPath && v.relPath.includes('/'));
    return { items: valid, hasDirectory };
  }
  window.extractDroppedFilesWithPaths = extractDroppedFilesWithPaths;

  /**
   * { file, relPath } 配列を指定 Loome フォルダへアップロードする（大量ファイル時はバッチ分割送信）
   */
  async function executeUploadItemsToLoome(items, destination, displayLabel = '') {
    const validItems = (items || []).filter(it => it && it.file);
    if (validItems.length === 0) {
      if (typeof showToast === 'function') {
        showToast('対応する画像・RAWファイルが見つかりませんでした', 'warning');
      }
      return;
    }

    const readAsBase64 = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = err => reject(err);
      reader.readAsDataURL(file);
    });

    const isEn = _isEn();
    const total = validItems.length;
    let uploadedPhotos = 0;
    const chunkSize = 20;

    if (typeof setGlobalActivity === 'function') {
      setGlobalActivity('storage', {
        title: isEn ? 'Importing into Loome...' : 'Loome へ取り込み中...',
        countText: `0 / ${total.toLocaleString()}`,
        percent: 0,
        filename: displayLabel || destination || 'Loome',
        indeterminate: false,
      });
    }

    try {
      for (let i = 0; i < total; i += chunkSize) {
        const slice = validItems.slice(i, i + chunkSize);
        const payloadFiles = await Promise.all(
          slice.map(async ({ file, relPath }) => ({
            filename: file.name,
            rel_path: relPath && relPath.includes('/') ? relPath : null,
            content_base64: await readAsBase64(file),
          }))
        );
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: payloadFiles,
            destination: destination || '',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '取り込み失敗');
        uploadedPhotos += Number(data.uploaded_count || 0);

        if (typeof setGlobalActivity === 'function') {
          const done = Math.min(total, i + slice.length);
          setGlobalActivity('storage', {
            title: isEn ? 'Importing into Loome...' : 'Loome へ取り込み中...',
            countText: `${done.toLocaleString()} / ${total.toLocaleString()}`,
            percent: Math.round((done / total) * 100),
            filename: slice[slice.length - 1].relPath || slice[slice.length - 1].file.name,
            indeterminate: false,
          });
        }
      }

      if (typeof showToast === 'function') {
        const destText = displayLabel || 'Loome';
        showToast(`${uploadedPhotos}枚の写真を「${destText}」に取り込みました`, 'success', 3800);
      }
      if (typeof window.fetchStorageFolders === 'function') await window.fetchStorageFolders();
      if (typeof refreshAll === 'function') await refreshAll();
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast(`取り込みエラー: ${err.message}`, 'error');
      }
    } finally {
      if (typeof clearGlobalActivity === 'function') {
        clearGlobalActivity('storage');
      }
    }
  }
  window.executeUploadItemsToLoome = executeUploadItemsToLoome;

  /**
   * 外部D&Dまたはファイル選択からの取り込み共通エントリ（保存先未確定時は小窓を開く）
   */
  async function handleExternalFilesOrFoldersToLoome(items, explicitDest = null, explicitLabel = '') {
    if (!items || items.length === 0) {
      if (typeof showToast === 'function') {
        showToast('画像ファイル（JPEG, PNG, WebP, RAW等）が見つかりませんでした', 'warning');
      }
      return;
    }
    if (explicitDest !== null && explicitDest !== undefined) {
      await executeUploadItemsToLoome(items, explicitDest, explicitLabel || 'Loome');
      return;
    }
    if (
      window.state &&
      window.state.currentFilter &&
      window.state.currentFilter.type === 'folder' &&
      window.state.currentFilter.value &&
      typeof window.isStoragePath === 'function' &&
      window.isStoragePath(window.state.currentFilter.value)
    ) {
      await executeUploadItemsToLoome(
        items,
        window.state.currentFilter.value,
        window.state.currentFilter.label || 'Loome'
      );
      return;
    }
    await openLoomePickerModal({
      mode: 'upload_files',
      uploadFiles: items,
    });
  }
  window.handleExternalFilesOrFoldersToLoome = handleExternalFilesOrFoldersToLoome;

  /**
   * 小窓の新規フォルダ作成を実行し、作成したフォルダを即座に開く
   */
  async function _handleCreateSubfolderInPicker() {
    const inputEl = document.getElementById('loomePickerNewFolderInput');
    if (!inputEl) return;
    const name = inputEl.value.trim();
    if (!name) {
      if (typeof showToast === 'function') showToast('新しいフォルダ名を入力してください', 'info');
      inputEl.focus();
      return;
    }
    const currentNode = pickerState.nodeByKey.get(pickerState.currentKey) || pickerState.roots[0];
    if (!currentNode || typeof window.submitCreateStorageSubfolder !== 'function') return;

    const created = await window.submitCreateStorageSubfolder(currentNode.cleanPath, name);
    if (!created) return;

    inputEl.value = '';
    pickerState.isCreatingFolder = false;

    const folders = typeof window.fetchStorageFolders === 'function'
      ? await window.fetchStorageFolders()
      : [];
    const { roots, nodeByKey, parentByKey } = buildLoomeHierarchy(folders);
    pickerState.roots = roots;
    pickerState.nodeByKey = nodeByKey;
    pickerState.parentByKey = parentByKey;

    const newKey = _normKey(created.path || `${currentNode.cleanPath}\\${name}`);
    if (nodeByKey.has(newKey)) {
      pickerState.currentKey = newKey;
      pickerState.selectedChildKey = '';
    }
    renderLoomePicker();
  }

  /**
   * 小窓の確定ボタン実行
   */
  async function _handleSubmitPicker() {
    if (pickerState.isSubmitting || pickerState.isPickingFolder) return;
    const targetNode = _getEffectiveTargetNode();
    if (!targetNode) return;

    const destPath = targetNode.cleanPath || targetNode.path || '';
    const dispLabel = _formatNodeTrailLabel(targetNode);
    const mode = pickerState.mode;
    const photoIds = [...pickerState.photoIds];
    let sourceDir = pickerState.sourceDir;
    const uploadFiles = [...pickerState.uploadFiles];

    if (mode === 'import_folder' && !sourceDir) {
      const isEn = _isEn();
      pickerState.isPickingFolder = true;
      renderLoomePicker();
      try {
        const res = await fetch('/api/export/pick-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initial_dir: null }),
        });
        if (res.ok) {
          const data = await res.json();
          sourceDir = data.selected_path || null;
        }
      } catch (e) {
        console.error('[LOOME_PICKER] フォルダ選択ダイアログ呼び出し失敗:', e);
        if (typeof showToast === 'function') {
          showToast(isEn ? 'Failed to open folder dialog' : 'フォルダ選択ダイアログの表示に失敗しました', 'error', 3000);
        }
      } finally {
        pickerState.isPickingFolder = false;
        renderLoomePicker();
      }
      if (!sourceDir) {
        if (typeof showToast === 'function') {
          showToast(isEn ? 'Folder selection cancelled' : 'フォルダ選択をキャンセルしました', 'info', 2000);
        }
        return;
      }
    }

    pickerState.isSubmitting = true;
    closeLoomePickerModal();

    try {
      if (mode === 'move') {
        if (typeof window.movePhotosInStorage === 'function') {
          await window.movePhotosInStorage(photoIds, destPath, dispLabel);
        }
      } else if (mode === 'import_folder') {
        await importExternalFolderToLoome(sourceDir, destPath, dispLabel);
      } else if (mode === 'upload_files') {
        await executeUploadItemsToLoome(uploadFiles, destPath, dispLabel);
      } else {
        if (typeof window.importPhotosToStorage === 'function') {
          await window.importPhotosToStorage(photoIds, destPath, dispLabel);
        }
      }
    } finally {
      pickerState.isSubmitting = false;
    }
  }

  function initLoomePickerEvents() {
    const modal = document.getElementById('loomePickerModal');
    if (!modal) return;

    document.getElementById('closeLoomePickerModalBtn')?.addEventListener('click', closeLoomePickerModal);
    document.getElementById('cancelLoomePickerModalBtn')?.addEventListener('click', closeLoomePickerModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeLoomePickerModal();
    });

    document.getElementById('loomePickerUpBtn')?.addEventListener('click', () => {
      const parent = pickerState.parentByKey.get(pickerState.currentKey);
      if (parent) {
        pickerState.currentKey = parent.key;
        pickerState.selectedChildKey = '';
        renderLoomePicker();
      }
    });

    document.getElementById('loomePickerToggleNewFolderBtn')?.addEventListener('click', () => {
      pickerState.isCreatingFolder = !pickerState.isCreatingFolder;
      renderLoomePicker();
      if (pickerState.isCreatingFolder) {
        setTimeout(() => document.getElementById('loomePickerNewFolderInput')?.focus(), 30);
      }
    });

    document.getElementById('loomePickerCreateFolderBtn')?.addEventListener('click', _handleCreateSubfolderInPicker);
    document.getElementById('loomePickerCancelNewFolderBtn')?.addEventListener('click', () => {
      pickerState.isCreatingFolder = false;
      renderLoomePicker();
    });

    const newFolderInput = document.getElementById('loomePickerNewFolderInput');
    if (newFolderInput) {
      newFolderInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          _handleCreateSubfolderInPicker();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          pickerState.isCreatingFolder = false;
          renderLoomePicker();
        }
      });
    }

    document.getElementById('loomePickerSubmitBtn')?.addEventListener('click', _handleSubmitPicker);

    window.addEventListener('keydown', (e) => {
      if (!pickerState.isOpen) return;
      const activeTag = document.activeElement?.tagName?.toUpperCase() || '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (pickerState.isPickingFolder) return;
        e.preventDefault();
        e.stopPropagation();
        closeLoomePickerModal();
      } else if (e.key === 'Backspace') {
        const parent = pickerState.parentByKey.get(pickerState.currentKey);
        if (parent) {
          e.preventDefault();
          pickerState.currentKey = parent.key;
          pickerState.selectedChildKey = '';
          renderLoomePicker();
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLoomePickerEvents);
  } else {
    initLoomePickerEvents();
  }
})();
