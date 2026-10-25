/**
 * Photo Manager - storage（アプリ内ストレージ）管理・D&D・フォルダ操作・リネーム機能
 * - 外部写真から storage へのコピー＆インポート
 * - storage 内でのサブフォルダ作成・リネーム・空フォルダ削除・外部エクスポート
 * - storage 内写真のサブフォルダ間移動（ポップオーバー・右クリック・左ツリーD&D）
 * - storage 内写真の単一リネーム＆一括連番リネーム（F2 ショートカット対応）
 */

const storageState = {
  storageRoot: null,         // GET /api/storage/folders で取得した storage ルートパス
  folders: [],               // storage 内のフォルダ階層リスト
  renamePhotoIds: [],        // リネーム対象の photo_id 配列
  renameMode: 'single',      // 'single' | 'batch'
  singlePhotoExt: '',        // 単一リネーム時の拡張子（例: '.JPG'）
  folderModalMode: 'create', // 'create' | 'rename'
  folderModalTargetPath: '', // 作成時の親パス または リネーム対象パス
  folderModalTargetName: '', // 対象フォルダの表示名
};

// 内部写真カードドラッグ中の写真ID配列（外部ファイルドロップオーバーレイとの区別用）
window._draggingPhotoIds = [];

/**
 * 指定パスが storage（アプリ内ストレージ）配下かどうかを判定する
 */
function isStoragePath(path) {
  if (!path) return false;
  const norm = String(path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  if (storageState.storageRoot) {
    const rootNorm = String(storageState.storageRoot).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    if (norm === rootNorm || norm.startsWith(rootNorm + '\\')) {
      return true;
    }
  }
  return /(^|\\)storage(\\|$)/i.test(norm);
}
window.isStoragePath = isStoragePath;

/**
 * 写真オブジェクトが storage 内の写真かどうかを判定する
 */
function isPhotoInStorage(photo) {
  if (!photo) return false;
  if (photo.is_storage === true) return true;
  const filePath = photo.file_path || photo.directory_path || '';
  return isStoragePath(filePath);
}
window.isPhotoInStorage = isPhotoInStorage;

/**
 * ファイル名からベース名（stem）と拡張子（.ext）を分離する
 */
function _splitFilenameExt(filename) {
  const name = String(filename || '');
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    return { stem: name, ext: '' };
  }
  return {
    stem: name.slice(0, lastDot),
    ext: name.slice(lastDot),
  };
}

/**
 * 写真の撮影日時（またはファイル更新日時・現在日時）からローカルタイムの日付・時刻文字列を生成する
 * ※ Date.toISOString() は UTC ズレを起こすため絶対に使用しない
 */
function _formatPhotoLocalDateParts(photo) {
  const raw = photo?.date_taken || photo?.file_modified_at || null;
  let d = null;
  if (raw) {
    // EXIF形式 "YYYY:MM:DD HH:MM:SS" または ISO/SQLite形式 "YYYY-MM-DD HH:MM:SS" をパース
    const cleaned = String(raw).trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
      d = parsed;
    }
  }
  if (!d) {
    d = new Date();
  }
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return {
    dateStr: `${yyyy}${mm}${dd}`,
    dateTimeStr: `${yyyy}${mm}${dd}_${hh}${mi}${ss}`,
  };
}

/**
 * 現在選択中の写真を storage 内写真と外部写真に分類して返す
 */
function getSelectedPhotosStorageBreakdown() {
  const selectedIds = Array.from(state.selectedPhotoIds || []);
  const storagePhotos = [];
  const storagePhotoIds = [];
  const externalPhotos = [];
  const externalPhotoIds = [];

  for (const id of selectedIds) {
    const p = (state.photos || []).find(item => item.id === id);
    if (!p) continue;
    if (isPhotoInStorage(p)) {
      storagePhotos.push(p);
      storagePhotoIds.push(p.id);
    } else {
      externalPhotos.push(p);
      externalPhotoIds.push(p.id);
    }
  }

  return {
    totalCount: selectedIds.length,
    storagePhotos,
    storagePhotoIds,
    externalPhotos,
    externalPhotoIds,
  };
}
window.getSelectedPhotosStorageBreakdown = getSelectedPhotosStorageBreakdown;

/**
 * F2 キーやリネーム起動時に、対象となる storage 内写真ID配列を取得する
 * 優先順位:
 *  1. ライトボックス表示中ならその1枚（storage 内の場合）
 *  2. 複数選択中なら選択中の storage 内写真すべて
 *  3. インスペクタ表示中の単一写真（storage 内の場合）
 */
function getTargetStoragePhotoIdsForRename() {
  // 1. ライトボックスが開いている場合は表示中の写真を最優先
  const lbModal = document.getElementById('lightboxModal');
  if (lbModal && lbModal.style.display !== 'none' && state.lightboxIndex >= 0) {
    const lbPhoto = (state.photos || [])[state.lightboxIndex];
    if (lbPhoto && isPhotoInStorage(lbPhoto)) {
      return [lbPhoto.id];
    }
  }

  // 2. 選択中の写真に storage 内写真がある場合
  const { storagePhotoIds } = getSelectedPhotosStorageBreakdown();
  if (storagePhotoIds.length > 0) {
    return storagePhotoIds;
  }

  // 3. インスペクタで単一表示中の写真
  if (state.activeInspectorPhotoId) {
    const activePhoto = (state.photos || []).find(p => p.id === state.activeInspectorPhotoId);
    if (activePhoto && isPhotoInStorage(activePhoto)) {
      return [activePhoto.id];
    }
  }

  return [];
}

/* ==========================================================================
   /api/storage/folders 取得 & フォルダリスト描画
   ========================================================================== */

/**
 * storage 内のフォルダ階層一覧をサーバーから取得してキャッシュを更新する
 */
async function fetchStorageFolders() {
  try {
    const res = await fetch('/api/storage/folders');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.storage_root) {
      storageState.storageRoot = data.storage_root;
    }
    storageState.folders = Array.isArray(data.folders) ? data.folders : [];
    return storageState.folders;
  } catch (err) {
    console.warn('storage フォルダ一覧の取得に失敗しました:', err);
    return storageState.folders || [];
  }
}
window.fetchStorageFolders = fetchStorageFolders;

/**
 * 指定されたコンテナ群に storage フォルダ一覧を描画する
 * @param {HTMLElement[]} containers 描画対象のDOM要素配列
 * @param {'import'|'move'} actionMode クリック時の動作モード
 */
async function renderStorageFolderListInContainers(containers, actionMode) {
  const validContainers = (containers || []).filter(Boolean);
  if (validContainers.length === 0) return;

  validContainers.forEach(c => {
    c.innerHTML = '<div class="submenu-folder-loading">読み込み中...</div>';
  });

  const folders = await fetchStorageFolders();

  validContainers.forEach(container => {
    container.innerHTML = '';
    if (!folders || folders.length === 0) {
      // フォールバック: ルート1件のみ表示
      const item = document.createElement('div');
      item.className = 'submenu-folder-item';
      item.innerHTML = `
        <span class="submenu-folder-name" title="storage (ルート)">📦 storage (ルート)</span>
        <span class="submenu-folder-count">${actionMode === 'move' ? '移動' : '保存'}</span>
      `;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (actionMode === 'move') {
          executeStorageMoveFromSelection('', 'storage (ルート)');
        } else {
          executeStorageImportFromSelection('', 'storage (ルート)');
        }
      });
      container.appendChild(item);
      return;
    }

    folders.forEach(folder => {
      const item = document.createElement('div');
      item.className = 'submenu-folder-item storage-folder-option';
      const depth = Number(folder.depth || 0);
      item.style.paddingLeft = `${8 + depth * 14}px`;

      const isRoot = !!folder.is_root || depth === 0 && (!folder.rel_path || folder.rel_path === '.');
      const icon = isRoot ? '📦' : '📁';
      const displayName = isRoot ? 'storage (ルート)' : (folder.name || folder.rel_path || 'storage');
      const targetDest = folder.path || folder.rel_path || '';
      const countText = folder.count !== undefined ? `${Number(folder.count)}枚` : '';

      item.innerHTML = `
        <span class="submenu-folder-name" title="${escapeHtml(folder.rel_path || displayName)}">${icon} ${escapeHtml(displayName)}</span>
        <span class="submenu-folder-count">${escapeHtml(countText)}</span>
      `;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (actionMode === 'move') {
          executeStorageMoveFromSelection(targetDest, displayName);
        } else {
          executeStorageImportFromSelection(targetDest, displayName);
        }
      });
      container.appendChild(item);
    });
  });
}

/* ==========================================================================
   選択状態に応じた右クリックメニュー＆下部フローティングバー出し分け
   ========================================================================== */

/**
 * 選択中の写真構成に応じて、下部フローティングバーの storage 関連ボタン表示を更新する
 */
function updateStorageSelectionUI() {
  const { storagePhotoIds, externalPhotoIds } = getSelectedPhotosStorageBreakdown();
  const isEn = typeof currentLang !== 'undefined' && currentLang === 'en';

  const moveGroup = document.getElementById('floatingStorageMoveGroup');
  const renameBtn = document.getElementById('floatingStorageRenameBtn');
  const renameLabel = document.getElementById('floatingStorageRenameLabel');
  const importGroup = document.getElementById('floatingStorageImportGroup');

  if (moveGroup) {
    moveGroup.style.display = storagePhotoIds.length > 0 ? '' : 'none';
  }

  if (renameBtn) {
    if (storagePhotoIds.length > 0) {
      renameBtn.style.display = '';
      if (storagePhotoIds.length === 1) {
        if (renameLabel) renameLabel.textContent = isEn ? 'Rename' : 'ファイル名変更';
        renameBtn.title = isEn ? 'Rename file in storage (F2)' : 'storage内のファイル名を変更 (F2)';
      } else {
        if (renameLabel) renameLabel.textContent = isEn ? 'Batch Rename' : '一括リネーム';
        renameBtn.title = isEn ? `Batch sequential rename ${storagePhotoIds.length} photos (F2)` : `${storagePhotoIds.length}枚の写真を一括連番リネーム... (F2)`;
      }
    } else {
      renameBtn.style.display = 'none';
    }
  }

  if (importGroup) {
    importGroup.style.display = externalPhotoIds.length > 0 ? '' : 'none';
  }
}
window.updateStorageSelectionUI = updateStorageSelectionUI;

/**
 * 右クリックメニューオープン時に storage 関連メニュー項目の表示・文言・サブメニュー一覧を更新する
 */
function updateStorageContextMenu() {
  const { storagePhotoIds, externalPhotoIds } = getSelectedPhotosStorageBreakdown();
  const isEn = typeof currentLang !== 'undefined' && currentLang === 'en';

  const moveItem = document.getElementById('contextMenuStorageMoveItem');
  const renameItem = document.getElementById('contextMenuStorageRenameItem');
  const renameLabel = document.getElementById('contextMenuStorageRenameLabel');
  const importItem = document.getElementById('contextMenuStorageImportItem');

  if (moveItem) {
    if (storagePhotoIds.length > 0) {
      moveItem.style.display = '';
      const moveList = document.getElementById('contextStorageMoveFolderList');
      if (moveList) {
        renderStorageFolderListInContainers([moveList], 'move');
      }
    } else {
      moveItem.style.display = 'none';
    }
  }

  if (renameItem) {
    if (storagePhotoIds.length > 0) {
      renameItem.style.display = '';
      if (renameLabel) {
        if (storagePhotoIds.length === 1) {
          renameLabel.textContent = isEn ? '✏️ Rename File (F2)' : '✏️ ファイル名を変更 (F2)';
        } else {
          renameLabel.textContent = isEn ? '✏️ Batch Sequential Rename... (F2)' : '✏️ 一括連番リネーム... (F2)';
        }
      }
    } else {
      renameItem.style.display = 'none';
    }
  }

  if (importItem) {
    if (externalPhotoIds.length > 0) {
      importItem.style.display = '';
      const importList = document.getElementById('contextStorageImportFolderList');
      if (importList) {
        renderStorageFolderListInContainers([importList], 'import');
      }
    } else {
      importItem.style.display = 'none';
    }
  }
}
window.updateStorageContextMenu = updateStorageContextMenu;

/* ==========================================================================
   storage へのインポート & storage 内でのフォルダ間移動
   ========================================================================== */

/**
 * 外部写真を storage 指定フォルダへコピー＆インポートする
 */
async function importPhotosToStorage(photoIds, destination, displayName = '') {
  const ids = Array.isArray(photoIds) ? photoIds : [];
  if (ids.length === 0) {
    if (typeof showToast === 'function') showToast('インポートする写真が選択されていません', 'info');
    return;
  }

  if (typeof closeContextMenu === 'function') closeContextMenu();
  if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();

  if (typeof showToast === 'function') {
    showToast(`📥 ${ids.length}枚の写真を storage へインポート中...`, 'info', 2000);
  }

  try {
    const res = await fetch('/api/storage/import-photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: ids,
        destination: destination || '',
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'storage へのインポートに失敗しました');
    }

    const destLabel = displayName || data.destination_name || 'storage';
    const importedCount = Number(data.imported_count || 0);
    const skippedCount = Number(data.skipped_count || 0);
    const skipMsg = skippedCount > 0 ? `（スキップ: ${skippedCount}枚）` : '';

    if (typeof showToast === 'function') {
      showToast(`📥 ${importedCount}枚の写真を「${destLabel}」へインポートしました${skipMsg}`, 'success', 4000);
    }

    // フォルダ一覧・左ツリー・写真一覧・集計を最新化
    await fetchStorageFolders();
    if (typeof refreshFolderTree === 'function') {
      await refreshFolderTree();
    }
    if (typeof fetchPhotos === 'function') {
      await fetchPhotos();
    }
    Promise.all([
      typeof fetchFolders === 'function' ? fetchFolders() : Promise.resolve(),
      typeof fetchTimeline === 'function' ? fetchTimeline() : Promise.resolve(),
      typeof fetchCameras === 'function' ? fetchCameras() : Promise.resolve(),
      typeof fetchDuplicatesCount === 'function' ? fetchDuplicatesCount() : Promise.resolve(),
    ]).catch(() => {});
  } catch (err) {
    console.error('storage インポートエラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'storage へのインポートに失敗しました'}`, 'error', 4000);
    }
  }
}
window.importPhotosToStorage = importPhotosToStorage;

/**
 * 選択中の外部写真を storage へインポートする
 */
async function executeStorageImportFromSelection(destination, displayName = '') {
  const { externalPhotoIds } = getSelectedPhotosStorageBreakdown();
  const targetIds = externalPhotoIds.length > 0 ? externalPhotoIds : Array.from(state.selectedPhotoIds || []);
  await importPhotosToStorage(targetIds, destination, displayName);
}

/**
 * storage 内の写真を別サブフォルダへ移動する
 */
async function movePhotosInStorage(photoIds, destination, displayName = '') {
  const ids = Array.isArray(photoIds) ? photoIds : [];
  if (ids.length === 0) {
    if (typeof showToast === 'function') showToast('移動する storage 内の写真が選択されていません', 'info');
    return;
  }

  if (typeof closeContextMenu === 'function') closeContextMenu();
  if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();

  try {
    const res = await fetch('/api/storage/move-photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: ids,
        destination: destination || '',
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'storage 内の移動に失敗しました');
    }

    const destLabel = displayName || data.destination_name || 'storage';
    const movedCount = Number(data.moved_count || 0);
    const skippedCount = Number(data.skipped_count || 0);
    const skipMsg = skippedCount > 0 ? `（スキップ: ${skippedCount}枚）` : '';

    if (typeof showToast === 'function') {
      showToast(`📦 ${movedCount}枚の写真を「${destLabel}」へ移動しました${skipMsg}`, 'success', 3500);
    }

    await fetchStorageFolders();
    if (typeof refreshFolderTree === 'function') {
      await refreshFolderTree();
    }
    if (typeof fetchPhotos === 'function') {
      await fetchPhotos();
    }
    Promise.all([
      typeof fetchFolders === 'function' ? fetchFolders() : Promise.resolve(),
      typeof fetchTimeline === 'function' ? fetchTimeline() : Promise.resolve(),
    ]).catch(() => {});
  } catch (err) {
    console.error('storage 移動エラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'storage 内の移動に失敗しました'}`, 'error', 4000);
    }
  }
}
window.movePhotosInStorage = movePhotosInStorage;

/**
 * 選択中の storage 写真を指定フォルダへ移動する
 */
async function executeStorageMoveFromSelection(destination, displayName = '') {
  const { storagePhotoIds } = getSelectedPhotosStorageBreakdown();
  const targetIds = storagePhotoIds.length > 0 ? storagePhotoIds : Array.from(state.selectedPhotoIds || []);
  await movePhotosInStorage(targetIds, destination, displayName);
}

/**
 * 左サイドバーの storage フォルダへ写真カードがドラッグ＆ドロップされた際の処理
 * - storage 内の写真なら「移動 (move-photos)」
 * - 外部フォルダの写真なら「インポート (import-photos)」
 */
async function handleDropPhotosToStorageFolder(targetPath, targetName, explicitPhotoIds = null) {
  const rawIds = (Array.isArray(explicitPhotoIds) && explicitPhotoIds.length > 0)
    ? explicitPhotoIds
    : (Array.isArray(window._draggingPhotoIds) && window._draggingPhotoIds.length > 0)
      ? window._draggingPhotoIds
      : Array.from(state.selectedPhotoIds || []);

  window._draggingPhotoIds = [];
  if (rawIds.length === 0) return;

  const storageIds = [];
  const externalIds = [];
  for (const id of rawIds) {
    const numId = Number(id);
    const p = (state.photos || []).find(item => item.id === numId);
    if (p && isPhotoInStorage(p)) {
      storageIds.push(numId);
    } else if (numId) {
      externalIds.push(numId);
    }
  }

  if (storageIds.length > 0) {
    await movePhotosInStorage(storageIds, targetPath, targetName);
  }
  if (externalIds.length > 0) {
    await importPhotosToStorage(externalIds, targetPath, targetName);
  }
}
window.handleDropPhotosToStorageFolder = handleDropPhotosToStorageFolder;

/**
 * エクスプローラーで storage フォルダを開く
 */
async function openStorageFolderInExplorer(targetPath = '') {
  if (typeof closeContextMenu === 'function') closeContextMenu();
  if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();

  let pathToOpen = targetPath || storageState.storageRoot || '';
  if (!pathToOpen) {
    await fetchStorageFolders();
    pathToOpen = storageState.storageRoot || '';
  }
  if (!pathToOpen) {
    if (typeof showToast === 'function') showToast('storage フォルダのパスを取得できませんでした', 'error');
    return;
  }

  try {
    const res = await fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: pathToOpen }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'フォルダを開けませんでした');
    }
    if (typeof showToast === 'function') {
      showToast('📂 エクスプローラーで storage フォルダを開きました', 'info', 2000);
    }
  } catch (err) {
    console.error('storage フォルダオープンエラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'フォルダを開けませんでした'}`, 'error');
    }
  }
}
window.openStorageFolderInExplorer = openStorageFolderInExplorer;

/* ==========================================================================
   storage フォルダ操作（サブフォルダ作成・リネーム・エクスポート・空削除）
   ========================================================================== */

/**
 * サブフォルダ作成 または フォルダ名変更モーダルを開く（モーダルが無い場合は prompt フォールバック）
 */
function openStorageFolderModal(mode, targetPath, currentName = '') {
  if (typeof closeFolderContextMenu === 'function') closeFolderContextMenu();

  storageState.folderModalMode = mode;
  storageState.folderModalTargetPath = targetPath || '';
  storageState.folderModalTargetName = currentName || '';

  const modal = document.getElementById('storageFolderModal');
  const titleEl = document.getElementById('storageFolderModalTitle');
  const subtitleEl = document.getElementById('storageFolderModalSubtitle');
  const labelEl = document.getElementById('storageFolderInputLabel');
  const inputEl = document.getElementById('storageFolderNameInput');
  const submitBtn = document.getElementById('storageFolderSubmitBtn');

  if (!modal || !inputEl) {
    // フォールバック: ブラウザ標準 prompt
    if (mode === 'create') {
      const name = window.prompt(`「${currentName || 'storage'}」内に作成する新しいサブフォルダ名を入力してください:`, '');
      if (name && name.trim()) {
        submitCreateStorageSubfolder(targetPath, name.trim());
      }
    } else if (mode === 'rename') {
      const name = window.prompt('新しいフォルダ名を入力してください:', currentName || '');
      if (name && name.trim() && name.trim() !== currentName) {
        submitRenameStorageFolder(targetPath, name.trim());
      }
    }
    return;
  }

  if (mode === 'create') {
    if (titleEl) titleEl.textContent = '📁 新規サブフォルダを作成';
    if (subtitleEl) subtitleEl.textContent = `親フォルダ: ${currentName || 'storage (ルート)'}`;
    if (labelEl) labelEl.textContent = '新しいサブフォルダ名';
    inputEl.value = '';
    inputEl.placeholder = '例: 2026_北海道旅行, セレクト済み...';
    if (submitBtn) submitBtn.textContent = '作成する';
  } else {
    if (titleEl) titleEl.textContent = '✏️ フォルダ名を変更';
    if (subtitleEl) subtitleEl.textContent = `現在のフォルダ名: ${currentName}`;
    if (labelEl) labelEl.textContent = '新しいフォルダ名';
    inputEl.value = currentName || '';
    inputEl.placeholder = '新しいフォルダ名を入力...';
    if (submitBtn) submitBtn.textContent = '変更を保存';
  }

  modal.style.display = 'flex';
  setTimeout(() => {
    inputEl.focus();
    inputEl.select();
  }, 40);
}
window.openStorageFolderModal = openStorageFolderModal;

function closeStorageFolderModal() {
  const modal = document.getElementById('storageFolderModal');
  if (modal) modal.style.display = 'none';
}
window.closeStorageFolderModal = closeStorageFolderModal;

/**
 * サブフォルダ作成APIを実行する (POST /api/storage/folders)
 */
async function submitCreateStorageSubfolder(parentPath, folderName) {
  const trimmed = String(folderName || '').trim();
  if (!trimmed) {
    if (typeof showToast === 'function') showToast('フォルダ名を入力してください', 'info');
    return null;
  }

  try {
    const res = await fetch('/api/storage/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_path: parentPath || null,
        folder_name: trimmed,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'サブフォルダの作成に失敗しました');
    }

    closeStorageFolderModal();
    if (typeof showToast === 'function') {
      showToast(`📁 サブフォルダ「${data.folder?.name || trimmed}」を作成しました`, 'success', 3000);
    }

    await fetchStorageFolders();
    // 作成したサブフォルダがツリー上で即見えるよう、親ノード（storage ルート等）を展開状態にする
    if (typeof folderTreeState !== 'undefined' && folderTreeState && folderTreeState.expanded && storageState.rootPath) {
      const targetParent = parentPath || storageState.rootPath;
      const scKey = `sc|${String(targetParent).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()}`;
      if (!folderTreeState.expanded.has(scKey)) {
        folderTreeState.expanded.set(scKey, {
          key: scKey,
          scope: 'sc',
          path: targetParent,
          serialMode: 'any',
          volumeSerial: null,
          isOffline: false,
          isStorage: true,
        });
      }
    }
    if (typeof refreshFolderTree === 'function') {
      await refreshFolderTree();
    }
    return data.folder || { name: trimmed, path: parentPath ? `${parentPath}\\${trimmed}` : trimmed };
  } catch (err) {
    console.error('サブフォルダ作成エラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'サブフォルダの作成に失敗しました'}`, 'error', 4000);
    }
    return null;
  }
}
window.submitCreateStorageSubfolder = submitCreateStorageSubfolder;

/**
 * サブフォルダ名変更APIを実行する (PUT /api/storage/folders/rename)
 */
async function submitRenameStorageFolder(folderPath, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) {
    if (typeof showToast === 'function') showToast('新しいフォルダ名を入力してください', 'info');
    return;
  }

  try {
    const res = await fetch('/api/storage/folders/rename', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder_path: folderPath,
        new_name: trimmed,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'フォルダ名の変更に失敗しました');
    }

    closeStorageFolderModal();
    if (typeof showToast === 'function') {
      showToast(`✏️ フォルダ名を「${data.new_name || trimmed}」に変更しました`, 'success', 3500);
    }

    // 現在表示中のフォルダがリネーム対象だった場合はフィルタパスを更新
    if (state.currentFilter && state.currentFilter.type === 'folder' && data.old_path && data.new_path) {
      const curNorm = String(state.currentFilter.value || '').replace(/\//g, '\\').replace(/\\+$/, '');
      const oldNorm = String(data.old_path).replace(/\//g, '\\').replace(/\\+$/, '');
      if (curNorm.toLowerCase() === oldNorm.toLowerCase()) {
        state.currentFilter.value = data.new_path;
        state.currentFilter.label = `📦 ${data.new_name || trimmed}`;
      }
    }

    await fetchStorageFolders();
    // 展開中だったフォルダがリネームされた場合、expanded Map のキーも新パスへ移行
    if (typeof folderTreeState !== 'undefined' && folderTreeState && folderTreeState.expanded && data.old_path && data.new_path) {
      const oldPrefix = String(data.old_path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const newPrefix = String(data.new_path).replace(/\//g, '\\').replace(/\\+$/, '');
      const updates = [];
      for (const [k, info] of folderTreeState.expanded.entries()) {
        const pNorm = String(info.path || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        if (pNorm === oldPrefix || pNorm.startsWith(oldPrefix + '\\')) {
          const suffix = String(info.path || '').replace(/\//g, '\\').replace(/\\+$/, '').slice(oldPrefix.length);
          const updatedPath = newPrefix + suffix;
          const updatedKey = `${info.scope || 'sc'}|${updatedPath.toLowerCase()}`;
          updates.push({ oldKey: k, newKey: updatedKey, info: { ...info, key: updatedKey, path: updatedPath } });
        }
      }
      updates.forEach(u => {
        folderTreeState.expanded.delete(u.oldKey);
        folderTreeState.expanded.set(u.newKey, u.info);
      });
    }
    if (typeof refreshFolderTree === 'function') {
      await refreshFolderTree();
    }
    if (typeof fetchPhotos === 'function') {
      await fetchPhotos();
    }
    if (typeof updateViewHeader === 'function') {
      updateViewHeader();
    }
  } catch (err) {
    console.error('フォルダリネームエラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'フォルダ名の変更に失敗しました'}`, 'error', 4000);
    }
  }
}
window.submitRenameStorageFolder = submitRenameStorageFolder;

/**
 * storage フォルダを外部へ丸ごとエクスポートする (POST /api/storage/export-folder)
 */
async function exportStorageFolderToExternal(folderPath, folderName = '') {
  if (typeof closeFolderContextMenu === 'function') closeFolderContextMenu();

  if (typeof showToast === 'function') {
    showToast(`📤 「${folderName || 'storage'}」の書き出し先フォルダを選択してください...`, 'info', 3000);
  }

  try {
    const res = await fetch('/api/storage/export-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder_path: folderPath,
        open_after: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'フォルダのエクスポートに失敗しました');
    }

    if (data.status === 'cancelled') {
      if (typeof showToast === 'function') {
        showToast('フォルダのエクスポートをキャンセルしました', 'info', 2500);
      }
      return;
    }

    if (typeof showToast === 'function') {
      showToast(`📤 ${data.exported_files || 0}個のファイルを「${data.exported_path || '外部フォルダ'}」へエクスポートしました`, 'success', 4500);
    }
  } catch (err) {
    console.error('storage フォルダエクスポートエラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'フォルダのエクスポートに失敗しました'}`, 'error', 4000);
    }
  }
}
window.exportStorageFolderToExternal = exportStorageFolderToExternal;

/**
 * 空の storage サブフォルダを削除する (DELETE /api/storage/folders)
 */
async function deleteEmptyStorageFolder(folderPath, folderName = '') {
  if (typeof closeFolderContextMenu === 'function') closeFolderContextMenu();
  if (!folderPath) return;

  const ok = window.confirm(`空のサブフォルダ「${folderName || folderPath}」を削除しますか？\n（※フォルダ内に写真がある場合は削除されません）`);
  if (!ok) return;

  try {
    const res = await fetch('/api/storage/folders', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || '空フォルダの削除に失敗しました');
    }

    if (typeof showToast === 'function') {
      showToast(`🗑️ 空フォルダ「${folderName || ''}」を削除しました`, 'success', 3000);
    }

    // 削除したフォルダを表示中だった場合は全写真表示へ戻す
    if (state.currentFilter && state.currentFilter.type === 'folder') {
      const curNorm = String(state.currentFilter.value || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      const delNorm = String(folderPath).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      if (curNorm === delNorm) {
        if (typeof setFilter === 'function') {
          setFilter('all', null, 'すべての写真');
        }
      }
    }

    await fetchStorageFolders();
    if (typeof folderTreeState !== 'undefined' && folderTreeState && folderTreeState.expanded) {
      const delKey = `sc|${String(folderPath).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()}`;
      folderTreeState.expanded.delete(delKey);
    }
    if (typeof refreshFolderTree === 'function') {
      await refreshFolderTree();
    }
  } catch (err) {
    console.error('storage フォルダ削除エラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'フォルダの削除に失敗しました'}`, 'error', 4000);
    }
  }
}
window.deleteEmptyStorageFolder = deleteEmptyStorageFolder;

/* ==========================================================================
   写真ファイル名変更モーダル（単一リネーム ＆ 一括連番リネーム）+ F2 ショートカット
   ========================================================================== */

/**
 * 単一リネーム または 一括連番リネームモーダルを開く
 * @param {number[]=} explicitPhotoIds 明示的に指定された写真IDリスト（省略時は現在の選択/表示から自動判定）
 */
function openStorageRenameModal(explicitPhotoIds = null) {
  if (typeof closeContextMenu === 'function') closeContextMenu();
  if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();

  let targetIds = [];
  if (Array.isArray(explicitPhotoIds) && explicitPhotoIds.length > 0) {
    targetIds = explicitPhotoIds.filter(id => {
      const p = (state.photos || []).find(item => item.id === id);
      return p ? isPhotoInStorage(p) : true;
    });
  } else {
    targetIds = getTargetStoragePhotoIdsForRename();
  }

  if (targetIds.length === 0) {
    if (typeof showToast === 'function') {
      showToast('📦 storage（アプリ内ストレージ）内の写真のみファイル名を変更できます', 'info', 3000);
    }
    return;
  }

  storageState.renamePhotoIds = targetIds;
  const modal = document.getElementById('storageRenameModal');
  const singleSection = document.getElementById('storageRenameSingleSection');
  const batchSection = document.getElementById('storageRenameBatchSection');
  const titleEl = document.getElementById('storageRenameModalTitle');
  const subtitleEl = document.getElementById('storageRenameModalSubtitle');
  const submitBtn = document.getElementById('storageRenameSubmitBtn');

  if (targetIds.length === 1) {
    // 単一写真リネームモード
    storageState.renameMode = 'single';
    const photo = (state.photos || []).find(p => p.id === targetIds[0]);
    const currentFilename = photo?.file_name || photo?.filename || (photo?.file_path ? photo.file_path.split(/[\\/]/).pop() : '');
    const { stem, ext } = _splitFilenameExt(currentFilename);
    storageState.singlePhotoExt = ext;

    if (!modal) {
      // フォールバック: prompt
      const newStem = window.prompt(`新しいファイル名を入力してください（拡張子 ${ext} は自動付与）:`, stem);
      if (newStem && newStem.trim() && (newStem.trim() + ext) !== currentFilename) {
        submitSinglePhotoRename(targetIds[0], newStem.trim() + ext);
      }
      return;
    }

    if (titleEl) titleEl.textContent = '✏️ ファイル名を変更';
    if (subtitleEl) subtitleEl.textContent = 'storage 内の写真ファイル名を変更します（Enter で確定）';
    if (singleSection) singleSection.style.display = 'block';
    if (batchSection) batchSection.style.display = 'none';
    if (submitBtn) submitBtn.textContent = '変更を保存 (Enter)';

    const currentNameEl = document.getElementById('storageRenameCurrentName');
    const singleInput = document.getElementById('storageRenameSingleInput');
    const extBadge = document.getElementById('storageRenameExtBadge');

    if (currentNameEl) currentNameEl.textContent = currentFilename || '-';
    if (extBadge) extBadge.textContent = ext || '';
    if (singleInput) {
      singleInput.value = stem;
    }

    modal.style.display = 'flex';
    setTimeout(() => {
      if (singleInput) {
        singleInput.focus();
        singleInput.select();
      }
    }, 40);
  } else {
    // 複数写真の一括連番リネームモード
    storageState.renameMode = 'batch';

    if (!modal) {
      const prefix = window.prompt(`${targetIds.length}枚の写真を一括連番リネームします。接頭辞（空欄で撮影日付）を入力してください:`, '');
      if (prefix !== null) {
        const rule = prefix.trim() ? 'custom_seq' : 'date_seq';
        submitBatchPhotoRename(targetIds, rule, prefix.trim(), 1);
      }
      return;
    }

    if (titleEl) titleEl.textContent = `✏️ 一括連番リネーム（${targetIds.length}枚）`;
    if (subtitleEl) subtitleEl.textContent = '選択した storage 内の写真をルールに従って一括で連番リネームします';
    if (singleSection) singleSection.style.display = 'none';
    if (batchSection) batchSection.style.display = 'block';
    if (submitBtn) submitBtn.textContent = `一括リネーム実行 (${targetIds.length}枚)`;

    const batchCountEl = document.getElementById('storageRenameBatchCount');
    if (batchCountEl) batchCountEl.textContent = String(targetIds.length);

    updateStorageBatchRenamePreview();
    modal.style.display = 'flex';
  }
}
window.openStorageRenameModal = openStorageRenameModal;

function closeStorageRenameModal() {
  const modal = document.getElementById('storageRenameModal');
  if (modal) modal.style.display = 'none';
}
window.closeStorageRenameModal = closeStorageRenameModal;

/**
 * 一括連番リネームモーダルのリアルタイムプレビュー（先頭3〜5件）を更新する
 */
function updateStorageBatchRenamePreview() {
  const previewList = document.getElementById('storageRenamePreviewList');
  const customOptionsBox = document.getElementById('storageRenameCustomOptions');
  if (!previewList) return;

  const selectedRadio = document.querySelector('input[name="storageBatchNamingRule"]:checked');
  const rule = selectedRadio ? selectedRadio.value : 'date_seq';

  if (customOptionsBox) {
    customOptionsBox.style.display = rule === 'custom_seq' ? 'grid' : 'none';
  }

  const prefixInput = document.getElementById('storageRenameCustomPrefix');
  const startNumInput = document.getElementById('storageRenameStartNum');
  const customPrefix = (prefixInput?.value || '').trim() || 'Photo';
  const startNum = Math.max(1, parseInt(startNumInput?.value || '1', 10) || 1);

  const ids = storageState.renamePhotoIds || [];
  const previewCount = Math.min(ids.length, 5);
  previewList.innerHTML = '';

  for (let i = 0; i < previewCount; i++) {
    const id = ids[i];
    const photo = (state.photos || []).find(p => p.id === id);
    const oldName = photo?.file_name || photo?.filename || (photo?.file_path ? photo.file_path.split(/[\\/]/).pop() : `photo_${id}.jpg`);
    const { stem, ext } = _splitFilenameExt(oldName);
    const { dateStr, dateTimeStr } = _formatPhotoLocalDateParts(photo);
    const seqStr = String(startNum + i).padStart(3, '0');

    let newName = '';
    if (rule === 'date_seq') {
      newName = `${dateStr}_${seqStr}${ext}`;
    } else if (rule === 'date_original') {
      newName = `${dateTimeStr}_${stem}${ext}`;
    } else {
      newName = `${customPrefix}_${seqStr}${ext}`;
    }

    const row = document.createElement('div');
    row.className = 'storage-rename-preview-row';
    row.innerHTML = `
      <span class="preview-old-name" title="${escapeHtml(oldName)}">${escapeHtml(oldName)}</span>
      <span class="preview-arrow">→</span>
      <span class="preview-new-name" title="${escapeHtml(newName)}">${escapeHtml(newName)}</span>
    `;
    previewList.appendChild(row);
  }

  if (ids.length > previewCount) {
    const more = document.createElement('div');
    more.className = 'storage-rename-preview-more';
    more.textContent = `...他 ${ids.length - previewCount} 枚も同様にリネームされます`;
    previewList.appendChild(more);
  }
}
window.updateStorageBatchRenamePreview = updateStorageBatchRenamePreview;

/**
 * 単一写真のリネームを実行する (POST /api/storage/rename-photo)
 */
async function submitSinglePhotoRename(photoId, newFullName) {
  const trimmed = String(newFullName || '').trim();
  if (!trimmed) {
    if (typeof showToast === 'function') showToast('ファイル名を入力してください', 'info');
    return;
  }

  try {
    const res = await fetch('/api/storage/rename-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_id: photoId,
        new_name: trimmed,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'ファイル名の変更に失敗しました');
    }

    closeStorageRenameModal();

    // ローカル state.photos の該当写真を即時更新
    const photo = (state.photos || []).find(p => p.id === photoId);
    if (photo) {
      if (data.new_name) {
        photo.file_name = data.new_name;
        photo.filename = data.new_name;
      }
      if (data.new_path) photo.file_path = data.new_path;
    }

    // グリッド上のカード表示を更新
    const card = document.querySelector(`.photo-card[data-photo-id="${photoId}"], .photo-card[data-id="${photoId}"]`);
    if (card && data.new_name) {
      const nameEl = card.querySelector('.card-filename, .photo-info-name');
      if (nameEl) {
        nameEl.textContent = data.new_name;
        nameEl.title = data.new_name;
      }
    }

    // インスペクタが開いていれば再描画
    if (state.isInspectorOpen && typeof updateInspectorView === 'function') {
      updateInspectorView();
    }

    // ライトボックスが開いていればファイル名表示を更新
    if (elements.lightboxFilename && state.lightboxIndex >= 0) {
      const lbPhoto = (state.photos || [])[state.lightboxIndex];
      if (lbPhoto && lbPhoto.id === photoId && data.new_name) {
        elements.lightboxFilename.textContent = data.new_name;
      }
    }

    if (typeof showToast === 'function') {
      showToast(`✏️ ファイル名を「${data.new_name || trimmed}」に変更しました`, 'success', 3500);
    }
  } catch (err) {
    console.error('単一写真リネームエラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || 'ファイル名の変更に失敗しました'}`, 'error', 4000);
    }
  }
}

/**
 * 複数写真の一括連番リネームを実行する (POST /api/storage/batch-rename-photos)
 */
async function submitBatchPhotoRename(photoIds, namingRule, customPrefix, startNumber) {
  const ids = Array.isArray(photoIds) ? photoIds : [];
  if (ids.length === 0) return;

  try {
    const res = await fetch('/api/storage/batch-rename-photos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: ids,
        naming_rule: namingRule || 'date_seq',
        custom_prefix: customPrefix || '',
        start_number: Number(startNumber) || 1,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || '一括連番リネームに失敗しました');
    }

    closeStorageRenameModal();

    const renamedCount = Number(data.renamed_count || 0);
    const skippedCount = Number(data.skipped_count || 0);
    const skipMsg = skippedCount > 0 ? `（スキップ: ${skippedCount}枚）` : '';

    if (typeof showToast === 'function') {
      showToast(`✏️ ${renamedCount}枚の写真を一括リネームしました${skipMsg}`, 'success', 4000);
    }

    if (typeof fetchPhotos === 'function') {
      await fetchPhotos();
    }
    if (state.isInspectorOpen && typeof updateInspectorView === 'function') {
      updateInspectorView();
    }
  } catch (err) {
    console.error('一括リネームエラー:', err);
    if (typeof showToast === 'function') {
      showToast(`❌ ${err.message || '一括連番リネームに失敗しました'}`, 'error', 4000);
    }
  }
}

/**
 * リネームモーダルの確定ボタン処理
 */
async function handleStorageRenameSubmit() {
  if (storageState.renameMode === 'single') {
    const photoId = storageState.renamePhotoIds[0];
    const singleInput = document.getElementById('storageRenameSingleInput');
    const stem = (singleInput?.value || '').trim();
    if (!stem) {
      if (typeof showToast === 'function') showToast('ファイル名を入力してください', 'info');
      return;
    }
    const ext = storageState.singlePhotoExt || '';
    const fullName = stem.toLowerCase().endsWith(ext.toLowerCase()) ? stem : `${stem}${ext}`;
    await submitSinglePhotoRename(photoId, fullName);
  } else {
    const selectedRadio = document.querySelector('input[name="storageBatchNamingRule"]:checked');
    const rule = selectedRadio ? selectedRadio.value : 'date_seq';
    const prefixInput = document.getElementById('storageRenameCustomPrefix');
    const startNumInput = document.getElementById('storageRenameStartNum');
    const customPrefix = (prefixInput?.value || '').trim();
    const startNum = Math.max(1, parseInt(startNumInput?.value || '1', 10) || 1);

    if (rule === 'custom_seq' && !customPrefix) {
      if (typeof showToast === 'function') showToast('接頭辞（プレフィックス）を入力してください', 'info');
      prefixInput?.focus();
      return;
    }

    await submitBatchPhotoRename(storageState.renamePhotoIds, rule, customPrefix, startNum);
  }
}

/* ==========================================================================
   イベントリスナー初期化（DOM構築後）
   ========================================================================== */

function initStorageFeatureEvents() {
  // 初回に storage ルート・フォルダ一覧を取得しておく
  fetchStorageFolders();

  // --- 1. 写真カードのドラッグ開始・終了（グリッドイベント委譲） ---
  const photoGrid = document.getElementById('photoGrid');
  if (photoGrid) {
    photoGrid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.photo-card');
      if (!card) return;
      const photoId = parseInt(card.dataset.photoId || card.dataset.id, 10);
      if (!photoId) return;

      // ドラッグ開始したカードが選択済みなら選択中の全写真ID、未選択ならその1枚のみ
      const dragIds = (state.selectedPhotoIds && state.selectedPhotoIds.has(photoId))
        ? Array.from(state.selectedPhotoIds)
        : [photoId];

      window._draggingPhotoIds = dragIds;
      card.classList.add('is-dragging-card');

      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', JSON.stringify(dragIds));
        e.dataTransfer.setData('application/x-photomanager-photos', JSON.stringify(dragIds));
      }
    });

    photoGrid.addEventListener('dragend', (e) => {
      window._draggingPhotoIds = [];
      document.querySelectorAll('.photo-card.is-dragging-card').forEach(el => {
        el.classList.remove('is-dragging-card');
      });
      document.querySelectorAll('.folder-tree-item.drag-over-storage').forEach(el => {
        el.classList.remove('drag-over-storage');
      });
    });
  }

  // --- 2. 右クリックメニュー内の storage インポート / 移動 / リネーム ---
  const ctxStorageImportInput = document.getElementById('contextNewStorageImportFolderInput');
  const ctxStorageImportBtn = document.getElementById('contextConfirmNewStorageImportFolderBtn');
  if (ctxStorageImportBtn && ctxStorageImportInput) {
    const handleCtxCreateAndImport = async (e) => {
      e.stopPropagation();
      const folderName = ctxStorageImportInput.value.trim();
      if (!folderName) {
        if (typeof showToast === 'function') showToast('新規フォルダ名を入力してください', 'info');
        return;
      }
      ctxStorageImportInput.value = '';
      await executeStorageImportFromSelection(folderName, folderName);
    };
    ctxStorageImportBtn.addEventListener('click', handleCtxCreateAndImport);
    ctxStorageImportInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCtxCreateAndImport(e);
      }
    });
    ctxStorageImportInput.addEventListener('click', (e) => e.stopPropagation());
  }

  const ctxOpenStorageImportBtn = document.getElementById('contextOpenStorageImportFolderBtn');
  if (ctxOpenStorageImportBtn) {
    ctxOpenStorageImportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStorageFolderInExplorer();
    });
  }

  const ctxStorageMoveInput = document.getElementById('contextNewStorageMoveFolderInput');
  const ctxStorageMoveBtn = document.getElementById('contextConfirmNewStorageMoveFolderBtn');
  if (ctxStorageMoveBtn && ctxStorageMoveInput) {
    const handleCtxCreateAndMove = async (e) => {
      e.stopPropagation();
      const folderName = ctxStorageMoveInput.value.trim();
      if (!folderName) {
        if (typeof showToast === 'function') showToast('移動先の新規フォルダ名を入力してください', 'info');
        return;
      }
      ctxStorageMoveInput.value = '';
      await executeStorageMoveFromSelection(folderName, folderName);
    };
    ctxStorageMoveBtn.addEventListener('click', handleCtxCreateAndMove);
    ctxStorageMoveInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCtxCreateAndMove(e);
      }
    });
    ctxStorageMoveInput.addEventListener('click', (e) => e.stopPropagation());
  }

  const ctxOpenStorageMoveBtn = document.getElementById('contextOpenStorageMoveFolderBtn');
  if (ctxOpenStorageMoveBtn) {
    ctxOpenStorageMoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStorageFolderInExplorer();
    });
  }

  const ctxStorageRenameItem = document.getElementById('contextMenuStorageRenameItem');
  if (ctxStorageRenameItem) {
    ctxStorageRenameItem.addEventListener('click', (e) => {
      e.stopPropagation();
      const { storagePhotoIds } = getSelectedPhotosStorageBreakdown();
      openStorageRenameModal(storagePhotoIds);
    });
  }

  // --- 3. 下部フローティングバーの storage インポート / 移動 / リネーム ---
  const floatingStorageImportBtn = document.getElementById('floatingStorageImportBtn');
  const floatingStorageImportPopover = document.getElementById('floatingStorageImportPopover');
  const closeFloatingStorageImportBtn = document.getElementById('closeFloatingStorageImportPopoverBtn');
  if (floatingStorageImportBtn && floatingStorageImportPopover) {
    floatingStorageImportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = floatingStorageImportPopover.style.display === 'block';
      if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();
      if (!isVisible) {
        floatingStorageImportPopover.style.display = 'block';
        floatingStorageImportBtn.classList.add('active');
        const listEl = document.getElementById('floatingStorageImportFolderList');
        if (listEl) renderStorageFolderListInContainers([listEl], 'import');
      }
    });
    floatingStorageImportPopover.addEventListener('click', (e) => e.stopPropagation());
  }
  if (closeFloatingStorageImportBtn) {
    closeFloatingStorageImportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();
    });
  }

  const floatingStorageImportInput = document.getElementById('floatingStorageImportFolderInput');
  const floatingConfirmStorageImportBtn = document.getElementById('floatingConfirmStorageImportFolderBtn');
  if (floatingConfirmStorageImportBtn && floatingStorageImportInput) {
    const handleFloatingCreateAndImport = async () => {
      const folderName = floatingStorageImportInput.value.trim();
      if (!folderName) {
        if (typeof showToast === 'function') showToast('新規フォルダ名を入力してください', 'info');
        return;
      }
      floatingStorageImportInput.value = '';
      await executeStorageImportFromSelection(folderName, folderName);
    };
    floatingConfirmStorageImportBtn.addEventListener('click', handleFloatingCreateAndImport);
    floatingStorageImportInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFloatingCreateAndImport();
      }
    });
  }

  const floatingOpenStorageImportBtn = document.getElementById('floatingOpenStorageImportFolderBtn');
  if (floatingOpenStorageImportBtn) {
    floatingOpenStorageImportBtn.addEventListener('click', () => openStorageFolderInExplorer());
  }

  const floatingStorageMoveBtn = document.getElementById('floatingStorageMoveBtn');
  const floatingStorageMovePopover = document.getElementById('floatingStorageMovePopover');
  const closeFloatingStorageMoveBtn = document.getElementById('closeFloatingStorageMovePopoverBtn');
  if (floatingStorageMoveBtn && floatingStorageMovePopover) {
    floatingStorageMoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = floatingStorageMovePopover.style.display === 'block';
      if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();
      if (!isVisible) {
        floatingStorageMovePopover.style.display = 'block';
        floatingStorageMoveBtn.classList.add('active');
        const listEl = document.getElementById('floatingStorageMoveFolderList');
        if (listEl) renderStorageFolderListInContainers([listEl], 'move');
      }
    });
    floatingStorageMovePopover.addEventListener('click', (e) => e.stopPropagation());
  }
  if (closeFloatingStorageMoveBtn) {
    closeFloatingStorageMoveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof closeAllFloatingPopovers === 'function') closeAllFloatingPopovers();
    });
  }

  const floatingStorageMoveInput = document.getElementById('floatingStorageMoveFolderInput');
  const floatingConfirmStorageMoveBtn = document.getElementById('floatingConfirmStorageMoveFolderBtn');
  if (floatingConfirmStorageMoveBtn && floatingStorageMoveInput) {
    const handleFloatingCreateAndMove = async () => {
      const folderName = floatingStorageMoveInput.value.trim();
      if (!folderName) {
        if (typeof showToast === 'function') showToast('移動先の新規フォルダ名を入力してください', 'info');
        return;
      }
      floatingStorageMoveInput.value = '';
      await executeStorageMoveFromSelection(folderName, folderName);
    };
    floatingConfirmStorageMoveBtn.addEventListener('click', handleFloatingCreateAndMove);
    floatingStorageMoveInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFloatingCreateAndMove();
      }
    });
  }

  const floatingOpenStorageMoveBtn = document.getElementById('floatingOpenStorageMoveFolderBtn');
  if (floatingOpenStorageMoveBtn) {
    floatingOpenStorageMoveBtn.addEventListener('click', () => openStorageFolderInExplorer());
  }

  const floatingStorageRenameBtn = document.getElementById('floatingStorageRenameBtn');
  if (floatingStorageRenameBtn) {
    floatingStorageRenameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { storagePhotoIds } = getSelectedPhotosStorageBreakdown();
      openStorageRenameModal(storagePhotoIds);
    });
  }

  // --- 4. フォルダ右クリックメニュー (#folderMenuStorageGroup) ---
  const folderCreateSubBtn = document.getElementById('folderMenuStorageCreateSub');
  if (folderCreateSubBtn) {
    folderCreateSubBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = state.contextFolderTarget;
      if (!target) return;
      openStorageFolderModal('create', target.path, target.name);
    });
  }

  const folderRenameBtn = document.getElementById('folderMenuStorageRename');
  if (folderRenameBtn) {
    folderRenameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = state.contextFolderTarget;
      if (!target || target.isStorageRoot) return;
      openStorageFolderModal('rename', target.path, target.name);
    });
  }

  const folderExportBtn = document.getElementById('folderMenuStorageExport');
  if (folderExportBtn) {
    folderExportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = state.contextFolderTarget;
      if (!target) return;
      exportStorageFolderToExternal(target.path, target.name);
    });
  }

  const folderDeleteBtn = document.getElementById('folderMenuStorageDelete');
  if (folderDeleteBtn) {
    folderDeleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = state.contextFolderTarget;
      if (!target || target.isStorageRoot) return;
      deleteEmptyStorageFolder(target.path, target.name);
    });
  }

  // --- 5. サブフォルダ作成・名前変更モーダル (#storageFolderModal) ---
  const closeFolderModalBtn = document.getElementById('closeStorageFolderModalBtn');
  const cancelFolderModalBtn = document.getElementById('cancelStorageFolderModalBtn');
  const submitFolderModalBtn = document.getElementById('storageFolderSubmitBtn');
  const folderNameInput = document.getElementById('storageFolderNameInput');
  const storageFolderModal = document.getElementById('storageFolderModal');

  if (closeFolderModalBtn) closeFolderModalBtn.addEventListener('click', closeStorageFolderModal);
  if (cancelFolderModalBtn) cancelFolderModalBtn.addEventListener('click', closeStorageFolderModal);
  if (storageFolderModal) {
    storageFolderModal.addEventListener('click', (e) => {
      if (e.target === storageFolderModal) closeStorageFolderModal();
    });
  }
  const handleFolderModalSubmit = () => {
    const val = (folderNameInput?.value || '').trim();
    if (storageState.folderModalMode === 'create') {
      submitCreateStorageSubfolder(storageState.folderModalTargetPath, val);
    } else {
      submitRenameStorageFolder(storageState.folderModalTargetPath, val);
    }
  };
  if (submitFolderModalBtn) submitFolderModalBtn.addEventListener('click', handleFolderModalSubmit);
  if (folderNameInput) {
    folderNameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFolderModalSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeStorageFolderModal();
      }
    });
  }

  // --- 6. 写真リネームモーダル (#storageRenameModal) ---
  const closeRenameModalBtn = document.getElementById('closeStorageRenameModalBtn');
  const cancelRenameModalBtn = document.getElementById('cancelStorageRenameModalBtn');
  const submitRenameModalBtn = document.getElementById('storageRenameSubmitBtn');
  const singleRenameInput = document.getElementById('storageRenameSingleInput');
  const storageRenameModal = document.getElementById('storageRenameModal');

  if (closeRenameModalBtn) closeRenameModalBtn.addEventListener('click', closeStorageRenameModal);
  if (cancelRenameModalBtn) cancelRenameModalBtn.addEventListener('click', closeStorageRenameModal);
  if (storageRenameModal) {
    storageRenameModal.addEventListener('click', (e) => {
      if (e.target === storageRenameModal) closeStorageRenameModal();
    });
  }
  if (submitRenameModalBtn) {
    submitRenameModalBtn.addEventListener('click', handleStorageRenameSubmit);
  }
  if (singleRenameInput) {
    singleRenameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleStorageRenameSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeStorageRenameModal();
      }
    });
  }

  document.querySelectorAll('input[name="storageBatchNamingRule"]').forEach(radio => {
    radio.addEventListener('change', updateStorageBatchRenamePreview);
  });
  const prefixInput = document.getElementById('storageRenameCustomPrefix');
  const startNumInput = document.getElementById('storageRenameStartNum');
  if (prefixInput) {
    prefixInput.addEventListener('input', updateStorageBatchRenamePreview);
    prefixInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleStorageRenameSubmit();
      }
    });
  }
  if (startNumInput) {
    startNumInput.addEventListener('input', updateStorageBatchRenamePreview);
    startNumInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleStorageRenameSubmit();
      }
    });
  }

  // --- 7. F2 キーボードショートカット ---
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F2') return;
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
      return;
    }
    // すでにリネームモーダルやフォルダモーダルが開いている場合は無視
    if (storageRenameModal && storageRenameModal.style.display !== 'none') return;
    if (storageFolderModal && storageFolderModal.style.display !== 'none') return;

    const targetIds = getTargetStoragePhotoIdsForRename();
    if (targetIds.length > 0) {
      e.preventDefault();
      openStorageRenameModal(targetIds);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStorageFeatureEvents);
} else {
  initStorageFeatureEvents();
}
