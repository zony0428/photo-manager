/**
 * Photo Manager - 複数選択 & コンテキストメニュー & 一括操作 (Selection & Batch Actions)
 * 単一/Shift範囲選択、右クリックメニュー、フローティング一括操作バー、写真削除を管理する。
 */

/* ==========================================================================
   マルチ選択（複数選択）管理ロジック
   ========================================================================== */
let currentHoveredCardIndex = -1;

/**
 * Shiftキー範囲選択のプレビュー表示をクリアする
 */
function clearShiftPreview() {
  document.querySelectorAll('.photo-card.shift-preview').forEach(card => {
    card.classList.remove('shift-preview');
  });
}

/**
 * Shiftキー押下中の範囲選択プレビューを更新する (Googleフォト風)
 */
function updateShiftPreview(targetIndex) {
  if (state.lastSelectedIndex === -1 || targetIndex === -1) {
    clearShiftPreview();
    return;
  }
  const start = Math.min(state.lastSelectedIndex, targetIndex);
  const end = Math.max(state.lastSelectedIndex, targetIndex);

  document.querySelectorAll('.photo-card').forEach(card => {
    const idx = parseInt(card.dataset.index, 10);
    const inRange = idx >= start && idx <= end;
    card.classList.toggle('shift-preview', inRange);
  });
}

function togglePhotoSelection(photoId, index) {
  state.selectionBaseIds = null;
  if (state.selectedPhotoIds.has(photoId)) {
    state.selectedPhotoIds.delete(photoId);
    if (state.selectedPhotoIds.size === 0) {
      state.lastSelectedIndex = -1;
      state.selectionAnchorIndex = -1;
    }
  } else {
    state.selectedPhotoIds.add(photoId);
    state.lastSelectedIndex = index;
    state.selectionAnchorIndex = index;
  }
  clearShiftPreview();
  updateCardSelectionClasses();
  updateSelectionUI();
}

function rangeSelectPhotos(targetIndex) {
  if (state.lastSelectedIndex === -1) {
    state.lastSelectedIndex = targetIndex;
  }
  // Shift範囲選択直前の選択状態を保持（未保持なら現在の選択セットをスナップショット保存）
  if (!state.selectionBaseIds) {
    state.selectionBaseIds = new Set(state.selectedPhotoIds);
  }

  const start = Math.min(state.lastSelectedIndex, targetIndex);
  const end = Math.max(state.lastSelectedIndex, targetIndex);

  // ベース選択を元に今回の範囲 [start, end] を一括選択（Googleフォト同等の再調整対応）
  state.selectedPhotoIds = new Set(state.selectionBaseIds);
  for (let i = start; i <= end; i++) {
    if (state.photos[i]) {
      state.selectedPhotoIds.add(state.photos[i].id);
    }
  }
  clearShiftPreview();
  updateCardSelectionClasses();
  updateSelectionUI();
}

function selectAllPhotos() {
  state.selectionBaseIds = null;
  state.photos.forEach(p => state.selectedPhotoIds.add(p.id));
  clearShiftPreview();
  updateCardSelectionClasses();
  updateSelectionUI();
}

function clearSelection() {
  state.selectedPhotoIds.clear();
  state.lastSelectedIndex = -1;
  state.selectionAnchorIndex = -1;
  state.selectionBaseIds = null;
  clearShiftPreview();
  updateCardSelectionClasses();
  updateSelectionUI();
  closeContextMenu();
  closeAllFloatingPopovers();
}

// 直前の選択写真IDセット（差分更新用）
let lastSelectedPhotoIds = new Set();

function updateCardSelectionClasses() {
  const isAnySelected = state.selectedPhotoIds.size > 0;
  document.body.classList.toggle('selection-active', isAnySelected);

  const grid = elements.photoGrid || document.getElementById('photoGrid');
  if (!grid) return;

  // 差分（追加されたID・削除されたID）を算出
  const addedIds = [];
  const removedIds = [];

  for (const id of state.selectedPhotoIds) {
    if (!lastSelectedPhotoIds.has(id)) {
      addedIds.push(id);
    }
  }
  for (const id of lastSelectedPhotoIds) {
    if (!state.selectedPhotoIds.has(id)) {
      removedIds.push(id);
    }
  }

  const diffCount = addedIds.length + removedIds.length;

  // 差分が50件を超える場合、または全選択・全解除など差分が大きい場合は全走査にフォールバック
  if (diffCount > 50) {
    grid.querySelectorAll('.photo-card').forEach(card => {
      const pid = parseInt(card.dataset.photoId, 10);
      card.classList.toggle('selected', state.selectedPhotoIds.has(pid));
    });
  } else {
    // 差分カードのみ photoGrid 内の data-photo-id セレクタで取得して classList を更新
    for (let i = 0; i < addedIds.length; i++) {
      const card = grid.querySelector(`.photo-card[data-photo-id="${addedIds[i]}"]`);
      if (card) card.classList.add('selected');
    }
    for (let i = 0; i < removedIds.length; i++) {
      const card = grid.querySelector(`.photo-card[data-photo-id="${removedIds[i]}"]`);
      if (card) card.classList.remove('selected');
    }
  }

  // 直前選択集合を同期
  lastSelectedPhotoIds = new Set(state.selectedPhotoIds);
}

/**
 * 選択中の写真の中にサムネイル未取得（プレースホルダー）のものが含まれるか判定する
 */
function hasMissingThumbnailsInSelection() {
  if (state.selectedPhotoIds.size === 0) return false;
  for (const id of state.selectedPhotoIds) {
    const photo = state.photos.find(p => p.id === id);
    if (!photo) continue;
    // DBフラグが未生成 (0/false) の場合
    if (!photo.has_thumbnail) return true;
    // DOM上の画像が未ロードまたは自然幅0（読込失敗）の場合も未取得とみなす
    const card = document.querySelector(`.photo-card[data-photo-id="${id}"]`);
    if (card) {
      if (card.classList.contains('thumb-placeholder')) return true;
      const img = card.querySelector('.card-thumb-img');
      if (img && (!img.complete || img.naturalWidth === 0)) {
        return true;
      }
    }
  }
  return false;
}

function updateSelectionUI() {
  document.body.classList.toggle('inspector-collapsed', !state.isInspectorOpen);
  const count = state.selectedPhotoIds.size;
  if (elements.floatingSelectedCount) {
    elements.floatingSelectedCount.textContent = count;
  }
  if (elements.selectionFloatingBar) {
    elements.selectionFloatingBar.style.display = 'none';
  }
  if (elements.contextMenuSelectedCount) {
    elements.contextMenuSelectedCount.textContent = `${count}枚の写真を選択中`;
  }

  // storage 関連ボタンの表示・ラベル動的更新
  if (typeof window.updateStorageSelectionUI === 'function') {
    window.updateStorageSelectionUI();
  }

  // 右ペインにも現在の選択状態を即座に反映
  updateInspectorView();
}

/* ==========================================================================
   右クリック コンテキストメニュー ＆ 一括タグ付け / インポート (送る)
   ========================================================================== */
function openContextMenu(x, y) {
  renderContextTagSubmenu();
  if (typeof window.updateStorageContextMenu === 'function') {
    window.updateStorageContextMenu();
  }
  if (elements.contextImportFolderList) {
    loadAndRenderContextImportSubmenu();
  }

  // サムネイルメニュー項目の動的ラベル更新
  const count = state.selectedPhotoIds.size;
  const hasMissing = hasMissingThumbnailsInSelection();
  if (elements.contextMenuRefreshThumbLabel) {
    const actionText = hasMissing ? 'サムネイルを取得' : 'サムネイルを更新';
    const countText = count > 1 ? ` (${count}枚)` : '';
    const icon = hasMissing ? '🖼️' : '🔄';
    elements.contextMenuRefreshThumbLabel.textContent = `${icon} ${actionText}${countText}`;
  }

  // 単一選択専用の項目（クロップ画面・トーンコピー・画像コピー）の表示制御
  const ctxCropEl = document.getElementById('contextMenuCrop');
  if (ctxCropEl) ctxCropEl.style.display = count <= 1 ? 'flex' : 'none';
  const ctxCopyToneEl = document.getElementById('contextMenuCopyTone');
  if (ctxCopyToneEl) ctxCopyToneEl.style.display = count <= 1 ? 'flex' : 'none';
  const ctxCopyImgEl = document.getElementById('contextMenuCopyImageItem');
  if (ctxCopyImgEl) ctxCopyImgEl.style.display = count <= 1 ? 'flex' : 'none';

  // トーン調整ペースト項目の状態更新
  const ctxPasteToneEl = document.getElementById('contextMenuPasteTone');
  if (ctxPasteToneEl) {
    const copiedTone = typeof window.getCopiedToneAdjustments === 'function'
      ? window.getCopiedToneAdjustments()
      : null;
    ctxPasteToneEl.style.opacity = copiedTone ? '1' : '0.55';
    ctxPasteToneEl.title = copiedTone
      ? `コピー中のトーン（明:${copiedTone.brightness} / コ:${copiedTone.contrast} / 彩:${copiedTone.saturation}）を選択中の${count}枚に適用`
      : '先に写真のトーン調整をコピーしてください (Ctrl+Shift+C)';
  }

  elements.contextMenu.style.display = 'block';

  // 画面端からはみ出さないように位置調整
  const menuWidth = 220;
  const menuHeight = elements.contextMenu.offsetHeight || 200;
  const winWidth = window.innerWidth;
  const winHeight = window.innerHeight;

  let left = x;
  let top = y;

  if (x + menuWidth > winWidth - 10) {
    left = Math.max(10, winWidth - menuWidth - 10);
  }
  if (y + menuHeight > winHeight - 10) {
    top = Math.max(10, winHeight - menuHeight - 10);
  }

  // サブメニューが画面右端をはみ出る場合は左側に展開
  elements.contextMenu.classList.toggle('submenu-left', left + menuWidth + 240 > winWidth);

  elements.contextMenu.style.left = `${left}px`;
  elements.contextMenu.style.top = `${top}px`;
}

function closeContextMenu() {
  elements.contextMenu.style.display = 'none';
}

// フォルダ用コンテキストメニューの対象ノード
let _activeFolderNode = null;

function openFolderContextMenu(x, y, node) {
  closeContextMenu();
  _activeFolderNode = node;
  state.contextFolderTarget = {
    path: node.fullPath,
    name: node.name || node.fullPath,
    isStorage: !!node.isStorage,
    isStorageRoot: !!node.isStorageRoot,
    ...node,
  };

  if (!elements.folderContextMenu) return;

  const folderPath = node.fullPath;
  const folderName = node.name || folderPath;
  const status = node.status || 'managed';
  const kind = node.kind || 'folder';
  const isMissing = !!node.isMissing;
  const isOffline = !!node.isOffline;
  const total = Number(node.totalCount || node.count || 0);
  const isRootKind = (kind === 'drive' || kind === 'shortcut' || kind === 'offline');

  if (elements.folderContextMenuPath) {
    let prefix = '';
    if (isOffline) prefix = '🔌 [未接続] ';
    else if (isMissing) prefix = '⚠️ [消失] ';
    elements.folderContextMenuPath.textContent = `${prefix}${folderName}`;
    elements.folderContextMenuPath.title = `${folderPath}${isOffline ? '（ドライブ未接続）' : (isMissing ? '（実フォルダ消失）' : '')}`;
  }

  // 補助関数: 要素の有効/無効化
  const setDisabled = (el, disabled, reason = '') => {
    if (!el) return;
    el.classList.toggle('disabled', disabled);
    if (disabled && reason) {
      el.setAttribute('title', reason);
    } else {
      el.removeAttribute('title');
    }
  };

  // 補助関数: 要素の表示/非表示
  const setVisible = (el, visible) => {
    if (el) el.style.display = visible ? 'block' : 'none';
  };

  // ドライブ・ショートカット・オフライン、または管理中フォルダ
  if (isRootKind || status === 'managed' || status === 'root') {
    setVisible(elements.folderMenuManagedGroup, true);
    setVisible(elements.folderMenuUnmanagedGroup, false);
    setVisible(elements.folderMenuIgnoredGroup, false);

    // ドライブ・ショートカットでは直下のみ再スキャンは隠す（配下スキャンを促す）
    setVisible(elements.folderMenuRescanDirect, !isRootKind);
    // 配下再スキャンのラベル切り替え（未登録ドライブなら「配下をスキャンして管理に追加」）
    if (elements.folderMenuRescanRecursive) {
      const labelSpan = elements.folderMenuRescanRecursive.querySelector('span');
      if (labelSpan) {
        labelSpan.textContent = (isRootKind && total === 0 && !node.hasManaged)
          ? '➕ 配下をスキャンして管理に追加'
          : '🔄 配下も含めて再スキャン';
      }
    }
    // 写真がある場合のみリフレッシュ・AIタグ・管理解除を表示
    const hasPhotos = total > 0 || !!node.hasManaged;
    setVisible(elements.folderMenuRefresh, hasPhotos && !isOffline);
    setVisible(elements.folderMenuAiTag, hasPhotos);
    setVisible(elements.folderMenuUnmanage, hasPhotos);
    // ドライブ・ショートカット自体は「除外」できないので非表示
    setVisible(elements.folderMenuIgnoreFromManaged, !isRootKind);

    // 未接続・消失時の無効化
    setDisabled(elements.folderMenuRescanDirect, isMissing || isOffline, '実フォルダが存在しないか、ドライブが未接続のため再スキャンできません');
    setDisabled(elements.folderMenuRescanRecursive, isMissing || isOffline, '実フォルダが存在しないか、ドライブが未接続のため再スキャンできません');
    setDisabled(elements.folderMenuRefresh, isMissing || isOffline, '未接続のためリフレッシュできません');
  } else if (status === 'unmanaged') {
    setVisible(elements.folderMenuManagedGroup, false);
    setVisible(elements.folderMenuUnmanagedGroup, true);
    setVisible(elements.folderMenuIgnoredGroup, false);
    setDisabled(elements.folderMenuAddAndScan, isMissing || isOffline, '実フォルダが存在しないためスキャンできません');
  } else if (status === 'ignored') {
    setVisible(elements.folderMenuManagedGroup, false);
    setVisible(elements.folderMenuUnmanagedGroup, false);
    setVisible(elements.folderMenuIgnoredGroup, true);
    setDisabled(elements.folderMenuAddFromIgnored, isMissing || isOffline, '実フォルダが存在しないためスキャンできません');
  }

  // storage（アプリ内ストレージ）専用メニュー項目の表示制御
  const storageGroupEl = document.getElementById('folderMenuStorageGroup');
  const storageRenameEl = document.getElementById('folderMenuStorageRename');
  const storageDeleteEl = document.getElementById('folderMenuStorageDelete');
  const isStorage = !!node.isStorage;
  const isStorageRoot = !!node.isStorageRoot;
  if (storageGroupEl) {
    storageGroupEl.style.display = isStorage ? 'block' : 'none';
  }
  if (storageRenameEl) {
    storageRenameEl.style.display = (isStorage && !isStorageRoot) ? 'block' : 'none';
  }
  if (storageDeleteEl) {
    storageDeleteEl.style.display = (isStorage && !isStorageRoot) ? 'block' : 'none';
  }

  // エクスプローラーで開く
  setVisible(elements.folderMenuOpenExplorer, true);
  setDisabled(elements.folderMenuOpenExplorer, isMissing || isOffline, '実フォルダが存在しないか、ドライブが未接続のため開けません');

  elements.folderContextMenu.style.display = 'block';

  // 画面端はみ出し防止
  const menuWidth = 240;
  const menuHeight = elements.folderContextMenu.offsetHeight || 180;
  const winWidth = window.innerWidth;
  const winHeight = window.innerHeight;

  let left = x;
  let top = y;

  if (x + menuWidth > winWidth - 10) {
    left = Math.max(10, winWidth - menuWidth - 10);
  }
  if (y + menuHeight > winHeight - 10) {
    top = Math.max(10, winHeight - menuHeight - 10);
  }

  elements.folderContextMenu.style.left = `${left}px`;
  elements.folderContextMenu.style.top = `${top}px`;
}

function closeFolderContextMenu() {
  if (elements.folderContextMenu) {
    elements.folderContextMenu.style.display = 'none';
  }
  _activeFolderNode = null;
}



/**
 * コンテキストメニュー内のテイクアウト（送信）先フォルダ一覧を取得・描画
 */
async function loadAndRenderContextImportSubmenu() {
  if (!elements.contextImportFolderList) return;
  elements.contextImportFolderList.innerHTML = '<div class="submenu-folder-loading">読み込み中...</div>';

  try {
    const res = await fetch('/api/import/destinations');
    if (!res.ok) throw new Error('テイクアウト先フォルダの取得に失敗しました');
    const data = await res.json();
    const destinations = data.destinations || [];

    elements.contextImportFolderList.innerHTML = '';

    destinations.forEach(item => {
      const row = document.createElement('div');
      row.className = `submenu-folder-node ${item.is_root ? 'root-folder' : ''}`;
      row.dataset.path = item.path;
      row.innerHTML = `
        <div class="submenu-folder-label">
          <span>${item.is_root ? '📥' : '📁'}</span>
          <span class="submenu-folder-name">${escapeHtml(item.name)}</span>
          <span class="folder-count-badge">${item.count}枚</span>
        </div>
        <span class="send-badge">+送信</span>
      `;

      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeContextMenu();
        await importSelectedPhotos(item.path, item.name);
      });

      elements.contextImportFolderList.appendChild(row);
    });
  } catch (err) {
    console.error('[TAKEOUT] load destinations error:', err);
    elements.contextImportFolderList.innerHTML = '<div class="submenu-folder-empty">取得に失敗しました</div>';
  }
}

/**
 * 選択中の写真（JPG限定）を指定テイクアウト先フォルダにコピー
 */
async function importSelectedPhotos(destinationPath = '', displayName = '') {
  const photoIds = Array.from(state.selectedPhotoIds);
  if (photoIds.length === 0) return;

  const targetLabel = displayName || (destinationPath ? destinationPath : 'take_out (直下)');

  try {
    const res = await fetch('/api/import/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: photoIds,
        destination: destinationPath || '',
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || '写真のテイクアウトに失敗しました');
    }

    if (data.copied_count === 0) {
      showToast('選択された写真にJPGがありません（RAW単体は除外されます）', 'warning', 4000);
    } else if (data.skipped_count > 0) {
      showToast(`📤 ${data.copied_count}枚のJPGを「${targetLabel}」にテイクアウトしました（※非JPGの${data.skipped_count}枚はスキップ）`, 'success', 4500);
      clearSelection();
    } else {
      showToast(`📤 ${data.copied_count}枚のJPGを「${targetLabel}」にテイクアウトしました`, 'success', 3500);
      clearSelection();
    }
  } catch (err) {
    console.error('[TAKEOUT] copy error:', err);
    showToast(`エラー: ${err.message}`, 'error', 4500);
  }
}

/**
 * 新規フォルダを作成して選択写真をテイクアウト
 */
async function createNewImportFolderAndImport() {
  if (!elements.contextNewImportFolderInput) return;
  const folderName = elements.contextNewImportFolderInput.value.trim();
  if (!folderName) return;

  try {
    const res = await fetch('/api/import/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_name: folderName }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'フォルダ作成に失敗しました');
    }

    elements.contextNewImportFolderInput.value = '';
    closeContextMenu();
    await importSelectedPhotos(data.folder_name, data.folder_name);
  } catch (err) {
    console.error('[TAKEOUT] create folder error:', err);
    showToast(`エラー: ${err.message}`, 'error', 4500);
  }
}

/**
 * Windowsエクスプローラーでtake_outフォルダを開く
 */
async function openImportFolderInExplorer() {
  closeContextMenu();
  try {
    const res = await fetch('/api/import/open', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'フォルダを開けませんでした');
    }
    showToast('📂 take_outフォルダを開きました', 'info', 2000);
  } catch (err) {
    console.error('[TAKEOUT] open folder error:', err);
    showToast(`エラー: ${err.message}`, 'error', 4500);
  }
}

/**
 * コンテキストメニュー内の階層タグツリーを描画
 */
function renderContextTagSubmenu() {
  elements.contextTagTreeContainer.innerHTML = '';
  // 既存タグから選択: AIが付けたタグおよび色タグは除外（手動タグのみ表示）
  const manualTags = (state.availableTags || []).filter(t => {
    const isAi = t.source === 'ai';
    const isColor = (t.tag || t.name) in COLOR_TAG_MAP;
    return !isAi && !isColor;
  });
  const treeRoot = buildTagTree(manualTags);

  function appendSubmenuNodes(parentNode, container, indent = 0) {
    parentNode.children.forEach(node => {
      const row = document.createElement('div');
      row.className = 'submenu-tag-node';
      row.style.paddingLeft = `${indent * 12 + 8}px`;

      const hasChildren = node.children.size > 0;
      row.innerHTML = `
        <span class="submenu-tag-label">${hasChildren ? '📁' : '🏷️'} ${escapeHtml(node.name)}</span>
        <span class="apply-badge">+付与</span>
      `;

      // クリックで選択全写真にタグ付与！
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        await batchAddTagToSelection(node.fullPath);
        closeContextMenu();
      });

      container.appendChild(row);

      if (hasChildren) {
        appendSubmenuNodes(node, container, indent + 1);
      }
    });
  }

  appendSubmenuNodes(treeRoot, elements.contextTagTreeContainer);
}

/**
 * 選択中の写真に一括でタグを追加
 */
async function batchAddTagToSelection(tagName) {
  if (state.selectedPhotoIds.size === 0 || !tagName.trim()) return;

  const photoIds = Array.from(state.selectedPhotoIds);
  const cleanTag = tagName.trim();
  try {
    const res = await fetch('/api/photos/batch-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: photoIds,
        tag: cleanTag,
        action: 'add',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '一括タグ付け失敗');

    if (typeof showToast === 'function') {
      showToast(`🏷️ ${photoIds.length}枚の写真にタグ「${cleanTag}」を付与しました`, 'success', 2500);
    }
    clearSelection();
    await Promise.all([fetchPhotos(), fetchTags()]);
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast(`エラー: ${err.message}`, 'error');
    } else {
      alert('エラー: ' + err.message);
    }
  }
}

/**
 * 選択中の写真の評価を一括更新
 */
async function batchRateSelection(rating) {
  if (state.selectedPhotoIds.size === 0) return;

  const photoIds = Array.from(state.selectedPhotoIds);
  const rateLabels = { 2: '🏅 優', 1: '⭐ 良', 0: '⚪ 可（解除）', '-1': '🗑️ 棄' };
  try {
    const res = await fetch('/api/photos/batch-rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: photoIds,
        rating: rating,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '一括評価失敗');

    if (typeof showToast === 'function') {
      showToast(`${photoIds.length}枚の評価を「${rateLabels[String(rating)] || rating}」に設定しました`, 'success', 2500);
    }
    clearSelection();
    await fetchPhotos();
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast(`エラー: ${err.message}`, 'error');
    } else {
      alert('エラー: ' + err.message);
    }
  }
}

/**
 * 一覧表示中: 選択中またはインスペクタ表示中の写真に評価を適用
 */
async function applyRatingToSelection(rating) {
  if (state.selectedPhotoIds.size > 1) {
    await batchRateSelection(rating);
  } else if (state.selectedPhotoIds.size === 1) {
    const photoId = Array.from(state.selectedPhotoIds)[0];
    await updatePhotoRating(photoId, rating);
    const photo = state.photos.find(p => p.id === photoId);
    if (photo && state.activeInspectorPhotoId === photoId) {
      showSingleInspector(photo);
    }
  } else if (state.activeInspectorPhotoId) {
    await updatePhotoRating(state.activeInspectorPhotoId, rating);
    const photo = state.photos.find(p => p.id === state.activeInspectorPhotoId);
    if (photo) {
      showSingleInspector(photo);
    }
  }
}

/* ==========================================================================
   右ペイン (インスペクタ / 詳細・一括編集) ロジック
   ========================================================================== */
/**
 * 右ペインの開閉トグル


/* ==========================================================================
   フローティング選択バー 専用ポップオーバー (v1.85)
   ========================================================================== */

/**
 * すべてのフローティングポップオーバーを閉じる
 */
function closeAllFloatingPopovers() {
  if (elements.floatingTagPopover) elements.floatingTagPopover.style.display = 'none';
  if (elements.floatingRatePopover) elements.floatingRatePopover.style.display = 'none';
  if (elements.floatingImportPopover) elements.floatingImportPopover.style.display = 'none';
  const rotatePopover = document.getElementById('floatingRotatePopover');
  if (rotatePopover) rotatePopover.style.display = 'none';
  const morePopover = document.getElementById('floatingMorePopover');
  if (morePopover) morePopover.style.display = 'none';
  if (elements.floatingAddTagBtn) elements.floatingAddTagBtn.classList.remove('active');
  if (elements.floatingRateBtn) elements.floatingRateBtn.classList.remove('active');
  if (elements.floatingImportBtn) elements.floatingImportBtn.classList.remove('active');
  const rotateBtn = document.getElementById('floatingRotateBtn');
  if (rotateBtn) rotateBtn.classList.remove('active');
  const moreBtn = document.getElementById('floatingMoreBtn');
  if (moreBtn) moreBtn.classList.remove('active');
  const storageImportPopover = document.getElementById('floatingStorageImportPopover');
  if (storageImportPopover) storageImportPopover.style.display = 'none';
  const storageImportBtn = document.getElementById('floatingStorageImportBtn');
  if (storageImportBtn) storageImportBtn.classList.remove('active');
  const storageMovePopover = document.getElementById('floatingStorageMovePopover');
  if (storageMovePopover) storageMovePopover.style.display = 'none';
  const storageMoveBtn = document.getElementById('floatingStorageMoveBtn');
  if (storageMoveBtn) storageMoveBtn.classList.remove('active');
}

/**
 * その他の操作ポップオーバーの開閉トグル
 */
function toggleFloatingMorePopover(e) {
  if (e) e.stopPropagation();
  const popover = document.getElementById('floatingMorePopover');
  const btn = document.getElementById('floatingMoreBtn');
  if (!popover) return;

  const isOpen = popover.style.display === 'flex';
  closeAllFloatingPopovers();

  if (!isOpen) {
    popover.style.display = 'flex';
    if (btn) btn.classList.add('active');
  }
}

/**
 * 写真回転ポップオーバーの開閉トグル
 */
function toggleFloatingRotatePopover(e) {
  if (e) e.stopPropagation();
  const popover = document.getElementById('floatingRotatePopover');
  const btn = document.getElementById('floatingRotateBtn');
  if (!popover) return;

  const isOpen = popover.style.display === 'flex';
  closeAllFloatingPopovers();

  if (!isOpen) {
    popover.style.display = 'flex';
    if (btn) btn.classList.add('active');
  }
}

/**
 * 評価設定ポップオーバーの開閉トグル (v1.86)
 */
function toggleFloatingRatePopover(e) {
  if (e) e.stopPropagation();
  if (!elements.floatingRatePopover) return;

  const isOpen = elements.floatingRatePopover.style.display === 'flex';
  closeAllFloatingPopovers();

  if (!isOpen) {
    elements.floatingRatePopover.style.display = 'flex';
    if (elements.floatingRateBtn) elements.floatingRateBtn.classList.add('active');
  }
}

/**
 * タグ付与ポップオーバーの開閉トグル
 */
function toggleFloatingTagPopover(e) {
  if (e) e.stopPropagation();
  if (!elements.floatingTagPopover) return;

  const isOpen = elements.floatingTagPopover.style.display === 'flex';
  closeAllFloatingPopovers();

  if (!isOpen) {
    elements.floatingTagPopover.style.display = 'flex';
    if (elements.floatingAddTagBtn) elements.floatingAddTagBtn.classList.add('active');
    renderFloatingTagTree();
    if (elements.floatingTagInput) {
      elements.floatingTagInput.value = '';
      setTimeout(() => elements.floatingTagInput.focus(), 60);
    }
  }
}

/**
 * タグ付与ポップオーバー内のタグツリー描画（リアルタイムインクリメンタルフィルタ・展開式ツリー対応 v2.01）
 */
function renderFloatingTagTree(filterText = '') {
  if (!elements.floatingTagTreeContainer) return;
  elements.floatingTagTreeContainer.innerHTML = '';

  // 既存タグから選択: AI自動タグおよび色タグは除外（通常の手動タグのみ表示）
  const manualTags = (state.availableTags || []).filter(t => {
    const isAi = t.source === 'ai';
    const isColor = (t.tag || t.name) in COLOR_TAG_MAP;
    return !isAi && !isColor;
  });

  if (manualTags.length === 0) {
    elements.floatingTagTreeContainer.innerHTML = `
      <div class="submenu-folder-empty" style="padding: 10px; font-size: 0.75rem; color: var(--text-dim, #64748b); text-align: center;">
        登録済みタグがありません
      </div>
    `;
    return;
  }

  // 展開状態キャッシュの初期化
  if (!state.floatingTagTreeExpandedPaths) {
    state.floatingTagTreeExpandedPaths = new Set();
  }

  const treeRoot = buildTagTree(manualTags);
  const query = (filterText || '').trim().toLowerCase();

  // クエリがある場合、自身または子孫にマッチするかチェックする関数
  function nodeMatchesQuery(node) {
    if (!query) return true;
    if (node.name.toLowerCase().includes(query) || node.fullPath.toLowerCase().includes(query)) {
      return true;
    }
    for (const child of node.children.values()) {
      if (nodeMatchesQuery(child)) return true;
    }
    return false;
  }

  let matchCount = 0;

  function appendPopoverNodes(parentNode, container, indent = 0) {
    parentNode.children.forEach(node => {
      // 検索中なら自身または子孫がマッチするもののみ処理
      if (query && !nodeMatchesQuery(node)) {
        return;
      }

      matchCount++;
      const hasChildren = node.children.size > 0;
      // 検索クエリ入力中はマッチしたノードを見せるため自動展開、通常時は保存された展開状態に従う
      const isExpanded = query ? true : state.floatingTagTreeExpandedPaths.has(node.fullPath);

      const nodeWrapper = document.createElement('div');
      nodeWrapper.className = 'popover-tree-node';

      const row = document.createElement('div');
      row.className = 'submenu-tag-node';
      row.style.paddingLeft = `${indent * 12 + 6}px`;

      // 展開矢印またはスペーサー (親フォルダはデフォルト閉)
      let toggleBtnHtml = '<span class="tree-toggle-spacer"></span>';
      if (hasChildren) {
        toggleBtnHtml = `<span class="tree-toggle-btn ${isExpanded ? '' : 'collapsed'}" title="${isExpanded ? '折りたたむ' : '展開する'}">▼</span>`;
      }
      const icon = hasChildren ? '📁' : '🏷️';

      row.innerHTML = `
        <div class="submenu-tag-left">
          ${toggleBtnHtml}
          <span class="submenu-tag-icon">${icon}</span>
          <span class="submenu-tag-label" title="${escapeHtml(node.fullPath)}">${escapeHtml(node.name)}</span>
        </div>
        <span class="apply-badge" title="「${escapeHtml(node.fullPath)}」を選択写真に付与">+付与</span>
      `;

      nodeWrapper.appendChild(row);

      // 子ノードコンテナ
      let childrenContainer = null;
      if (hasChildren) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = `popover-tree-children${isExpanded ? '' : ' hidden'}`;
        appendPopoverNodes(node, childrenContainer, indent + 1);
        nodeWrapper.appendChild(childrenContainer);
      }

      // イベントリスナー
      if (hasChildren) {
        // 親ノード:
        // 1. 右端の「+付与」バッジをクリック ➜ その親タグ自体を選択写真に付与
        const applyBadge = row.querySelector('.apply-badge');
        if (applyBadge) {
          applyBadge.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeAllFloatingPopovers();
            await batchAddTagToSelection(node.fullPath);
          });
        }

        // 2. 行（トグル矢印・アイコン・ラベル）をクリック ➜ 展開/折りたたみのトグル
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const toggleBtn = row.querySelector('.tree-toggle-btn');
          const nowCollapsed = toggleBtn ? toggleBtn.classList.toggle('collapsed') : false;
          if (nowCollapsed) {
            state.floatingTagTreeExpandedPaths.delete(node.fullPath);
          } else {
            state.floatingTagTreeExpandedPaths.add(node.fullPath);
          }
          if (childrenContainer) {
            childrenContainer.classList.toggle('hidden', nowCollapsed);
          }
          if (toggleBtn) {
            toggleBtn.title = nowCollapsed ? '展開する' : '折りたたむ';
          }
        });
      } else {
        // リーフノード: 行クリックで即タグ付与
        row.addEventListener('click', async (e) => {
          e.stopPropagation();
          closeAllFloatingPopovers();
          await batchAddTagToSelection(node.fullPath);
        });
      }

      container.appendChild(nodeWrapper);
    });
  }

  appendPopoverNodes(treeRoot, elements.floatingTagTreeContainer);

  if (matchCount === 0) {
    const emptyMsg = query ? `「${escapeHtml(query)}」に一致するタグはありません` : '登録済みタグがありません';
    elements.floatingTagTreeContainer.innerHTML = `
      <div class="submenu-folder-empty" style="padding: 10px; font-size: 0.75rem; color: var(--text-dim, #64748b); text-align: center;">
        ${emptyMsg}
      </div>
    `;
  }
}

/**
 * タグ付与ポップオーバー: 入力値からタグ付与実行
 */
async function executeFloatingNewTag() {
  if (!elements.floatingTagInput) return;
  const val = elements.floatingTagInput.value.trim();
  if (!val || state.selectedPhotoIds.size === 0) return;
  closeAllFloatingPopovers();
  await batchAddTagToSelection(val);
}

/**
 * テイクアウト（持ち出し）ポップオーバーの開閉トグル
 */
function toggleFloatingImportPopover(e) {
  if (e) e.stopPropagation();
  if (!elements.floatingImportPopover) return;

  const isOpen = elements.floatingImportPopover.style.display === 'flex';
  closeAllFloatingPopovers();

  if (!isOpen) {
    elements.floatingImportPopover.style.display = 'flex';
    if (elements.floatingImportBtn) elements.floatingImportBtn.classList.add('active');
    if (elements.floatingImportFolderList) {
      loadAndRenderFloatingImportFolders();
    }
    if (elements.floatingImportFolderInput) {
      elements.floatingImportFolderInput.value = '';
      setTimeout(() => elements.floatingImportFolderInput.focus(), 60);
    }
  }
}

/**
 * テイクアウトポップオーバー内の送り先フォルダ一覧を描画
 */
async function loadAndRenderFloatingImportFolders() {
  if (!elements.floatingImportFolderList) return;
  elements.floatingImportFolderList.innerHTML = '<div class="submenu-folder-loading">読み込み中...</div>';

  try {
    const res = await fetch('/api/import/destinations');
    if (!res.ok) throw new Error('送り先フォルダの取得に失敗しました');
    const data = await res.json();
    const destinations = data.destinations || [];

    elements.floatingImportFolderList.innerHTML = '';

    destinations.forEach(item => {
      const row = document.createElement('div');
      row.className = `submenu-folder-node ${item.is_root ? 'root-folder' : ''}`;
      row.dataset.path = item.path;
      row.innerHTML = `
        <div class="submenu-folder-label">
          <span>${item.is_root ? '📥' : '📁'}</span>
          <span class="submenu-folder-name">${escapeHtml(item.name)}</span>
          <span class="folder-count-badge">${item.count}枚</span>
        </div>
        <span class="send-badge">+送信</span>
      `;

      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeAllFloatingPopovers();
        await importSelectedPhotos(item.path, item.name);
      });

      elements.floatingImportFolderList.appendChild(row);
    });
  } catch (err) {
    console.error('[IMPORT] load destinations error:', err);
    elements.floatingImportFolderList.innerHTML = '<div class="submenu-folder-empty">取得に失敗しました</div>';
  }
}

/**
 * テイクアウトポップオーバー: 新規フォルダ作成して送信
 */
async function executeFloatingNewImportFolder() {
  if (!elements.floatingImportFolderInput) return;
  const folderName = elements.floatingImportFolderInput.value.trim();
  if (!folderName) return;

  try {
    const res = await fetch('/api/import/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_name: folderName }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'フォルダ作成に失敗しました');
    }

    elements.floatingImportFolderInput.value = '';
    closeAllFloatingPopovers();
    await importSelectedPhotos(data.folder_name, data.folder_name);
  } catch (err) {
    console.error('[IMPORT] create folder error:', err);
    showToast(`エラー: ${err.message}`, 'error', 4500);
  }
}

/**
 * 複数選択 & コンテキストメニュー関連イベントリスナーの登録
 */
function initSelectionEvents() {
  // 画面クリックでコンテキストメニューおよびフローティングポップオーバーを閉じる
  window.addEventListener('click', (e) => {
    if (!e.target.closest('#contextMenu')) {
      closeContextMenu();
    }
    if (!e.target.closest('#folderContextMenu')) {
      closeFolderContextMenu();
    }
    if (!e.target.closest('.floating-action-group')) {
      closeAllFloatingPopovers();
    }
  });

  // Escキーでフローティングポップオーバー・日時シフトモーダルを閉じる
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllFloatingPopovers();
      const shiftModal = elements.dateShiftModal || document.getElementById('dateShiftModal');
      if (shiftModal && shiftModal.style.display !== 'none') {
        closeDateShiftModal();
      }
    }
  });

  // フローティングポップオーバー内のクリック伝播停止
  if (elements.floatingTagPopover) {
    elements.floatingTagPopover.addEventListener('click', (e) => e.stopPropagation());
  }
  if (elements.floatingRatePopover) {
    elements.floatingRatePopover.addEventListener('click', (e) => e.stopPropagation());
  }
  if (elements.floatingImportPopover) {
    elements.floatingImportPopover.addEventListener('click', (e) => e.stopPropagation());
  }
  const floatMorePopover = document.getElementById('floatingMorePopover');
  if (floatMorePopover) {
    floatMorePopover.addEventListener('click', (e) => e.stopPropagation());
  }

  // コンテキストメニュー内: 新規タグ追加
  const executeContextNewTag = async () => {
    const val = elements.contextNewTagInput ? elements.contextNewTagInput.value.trim() : '';
    if (!val || state.selectedPhotoIds.size === 0) return;
    await batchAddTagToSelection(val);
    if (elements.contextNewTagInput) elements.contextNewTagInput.value = '';
    closeContextMenu();
  };

  if (elements.contextConfirmNewTagBtn) elements.contextConfirmNewTagBtn.addEventListener('click', executeContextNewTag);
  if (elements.contextNewTagInput) {
    elements.contextNewTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') executeContextNewTag();
    });
  }

  // コンテキストメニュー内: 新規インポートフォルダ作成
  if (elements.contextConfirmNewImportFolderBtn) {
    elements.contextConfirmNewImportFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      createNewImportFolderAndImport();
    });
  }
  if (elements.contextNewImportFolderInput) {
    elements.contextNewImportFolderInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        createNewImportFolderAndImport();
      }
    });
  }

  // 送り先フォルダをエクスプローラーで開く
  if (elements.contextOpenImportFolderBtn) {
    elements.contextOpenImportFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openImportFolderInExplorer();
    });
  }

  // コンテキストメニュー: プレビュー (ライトボックスで開く)
  if (elements.contextMenuPreviewItem) {
    elements.contextMenuPreviewItem.addEventListener('click', () => {
      closeContextMenu();
      if (state.selectedPhotoIds.size > 0) {
        const firstSelectedId = Array.from(state.selectedPhotoIds)[0];
        const idx = state.photos.findIndex(p => p.id === firstSelectedId);
        if (idx !== -1 && typeof openLightbox === 'function') openLightbox(idx);
      }
    });
  }

  // コンテキストメニュー: 選択解除
  if (elements.contextMenuClearSelection) {
    elements.contextMenuClearSelection.addEventListener('click', () => {
      clearSelection();
      closeContextMenu();
    });
  }

  // コンテキストメニュー: 回転 (右90° / 左90°)
  const ctxRotRight = document.getElementById('contextMenuRotateRight');
  if (ctxRotRight) {
    ctxRotRight.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
        window.batchRotatePhotosQuick(ids, 90);
      }
    });
  }
  const ctxRotLeft = document.getElementById('contextMenuRotateLeft');
  if (ctxRotLeft) {
    ctxRotLeft.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
        window.batchRotatePhotosQuick(ids, -90);
      }
    });
  }
  const ctxReset = document.getElementById('contextMenuResetAdjust');
  if (ctxReset) {
    ctxReset.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchResetPhotoAdjustmentsQuick === 'function') {
        window.batchResetPhotoAdjustmentsQuick(ids);
      }
    });
  }

  // コンテキストメニュー: 画像の調整・クロップ (Crop)
  const ctxCrop = document.getElementById('contextMenuCrop') || document.getElementById('contextMenuAdjustItem');
  if (ctxCrop) {
    ctxCrop.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      if (state.selectedPhotoIds.size > 0) {
        const firstSelectedId = Array.from(state.selectedPhotoIds)[0];
        const photo = state.photos.find(p => p.id === firstSelectedId);
        if (photo && typeof window.openImageAdjustModal === 'function') {
          window.openImageAdjustModal(photo);
        }
      } else if (state.activeInspectorPhotoId) {
        const photo = state.photos.find(p => p.id === state.activeInspectorPhotoId);
        if (photo && typeof window.openImageAdjustModal === 'function') {
          window.openImageAdjustModal(photo);
        }
      }
    });
  }

  // コンテキストメニュー: トーン調整をコピー (明るさ・コントラスト・彩度)
  const ctxCopyTone = document.getElementById('contextMenuCopyTone');
  if (ctxCopyTone) {
    ctxCopyTone.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      let targetPhoto = null;
      if (state.selectedPhotoIds.size > 0) {
        const firstId = Array.from(state.selectedPhotoIds)[0];
        targetPhoto = state.photos.find(p => p.id === firstId);
      } else if (state.activeInspectorPhotoId) {
        targetPhoto = state.photos.find(p => p.id === state.activeInspectorPhotoId);
      }
      if (targetPhoto && typeof window.copyPhotoToneAdjustments === 'function') {
        window.copyPhotoToneAdjustments(targetPhoto);
      }
    });
  }

  // コンテキストメニュー: トーン調整をペースト
  const ctxPasteTone = document.getElementById('contextMenuPasteTone');
  if (ctxPasteTone) {
    ctxPasteTone.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchPastePhotoToneAdjustments === 'function') {
        window.batchPastePhotoToneAdjustments(ids);
      }
    });
  }

  // コンテキストメニュー: 画像をクリップボードにコピー (Ctrl+C)
  const ctxCopyImg = document.getElementById('contextMenuCopyImageItem');
  if (ctxCopyImg) {
    ctxCopyImg.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      let targetPhoto = null;
      if (state.selectedPhotoIds.size > 0) {
        const firstId = Array.from(state.selectedPhotoIds)[0];
        targetPhoto = state.photos.find(p => p.id === firstId);
      } else if (state.activeInspectorPhotoId) {
        targetPhoto = state.photos.find(p => p.id === state.activeInspectorPhotoId);
      }
      if (targetPhoto && typeof window.copyPhotoImageToClipboard === 'function') {
        window.copyPhotoImageToClipboard(targetPhoto);
      }
    });
  }

  // フローティングバー: 回転ポップオーバートグル
  const floatRotBtn = document.getElementById('floatingRotateBtn');
  if (floatRotBtn) {
    floatRotBtn.addEventListener('click', toggleFloatingRotatePopover);
  }
  const closeFloatRotBtn = document.getElementById('closeFloatingRotatePopoverBtn');
  if (closeFloatRotBtn) {
    closeFloatRotBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
    });
  }
  const floatRotRightBtn = document.getElementById('floatingRotateRightBtn');
  if (floatRotRightBtn) {
    floatRotRightBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
        window.batchRotatePhotosQuick(ids, 90);
      }
    });
  }
  const floatRotLeftBtn = document.getElementById('floatingRotateLeftBtn');
  if (floatRotLeftBtn) {
    floatRotLeftBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
        window.batchRotatePhotosQuick(ids, -90);
      }
    });
  }
  const floatPasteToneBtn = document.getElementById('floatingPasteToneBtn');
  if (floatPasteToneBtn) {
    floatPasteToneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchPastePhotoToneAdjustments === 'function') {
        window.batchPastePhotoToneAdjustments(ids);
      }
    });
  }
  const floatResetBtn = document.getElementById('floatingResetAdjustBtn');
  if (floatResetBtn) {
    floatResetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
      const ids = Array.from(state.selectedPhotoIds);
      if (ids.length > 0 && typeof window.batchResetPhotoAdjustmentsQuick === 'function') {
        window.batchResetPhotoAdjustmentsQuick(ids);
      }
    });
  }

  // 選択写真の削除
  if (elements.contextMenuDeleteItem && typeof deleteSelectedPhotos === 'function') {
    elements.contextMenuDeleteItem.addEventListener('click', deleteSelectedPhotos);
  }
  if (elements.floatingDeleteBtn && typeof deleteSelectedPhotos === 'function') {
    elements.floatingDeleteBtn.addEventListener('click', deleteSelectedPhotos);
  }

  // フローティングバー: 選択解除
  if (elements.floatingClearSelectionBtn) {
    elements.floatingClearSelectionBtn.addEventListener('click', () => {
      clearSelection();
    });
  }

  // フローティングバー: その他の操作ポップオーバートグル
  const floatMoreBtn = document.getElementById('floatingMoreBtn');
  if (floatMoreBtn) {
    floatMoreBtn.addEventListener('click', toggleFloatingMorePopover);
  }
  const closeFloatMoreBtn = document.getElementById('closeFloatingMorePopoverBtn');
  if (closeFloatMoreBtn) {
    closeFloatMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
    });
  }

  // フローティングバー: GPS一括準用
  if (elements.floatingInferGpsBtn) {
    elements.floatingInferGpsBtn.addEventListener('click', () => {
      closeAllFloatingPopovers();
      executeBatchInferGps();
    });
  }

  // フローティングバー: GPS一括削除
  if (elements.floatingClearGpsBtn) {
    elements.floatingClearGpsBtn.addEventListener('click', () => {
      closeAllFloatingPopovers();
      executeBatchClearGps();
    });
  }

  // フローティングバー: タグ追加ポップオーバートグル
  if (elements.floatingAddTagBtn) {
    elements.floatingAddTagBtn.addEventListener('click', toggleFloatingTagPopover);
  }
  if (elements.closeFloatingTagPopoverBtn) {
    elements.closeFloatingTagPopoverBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
    });
  }
  if (elements.floatingConfirmTagBtn) {
    elements.floatingConfirmTagBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      executeFloatingNewTag();
    });
  }
  if (elements.floatingTagInput) {
    elements.floatingTagInput.addEventListener('input', (e) => {
      renderFloatingTagTree(e.target.value);
    });
    elements.floatingTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        executeFloatingNewTag();
      }
    });
  }

  // フローティングバー: テイクアウトポップオーバートグル
  if (elements.floatingImportBtn) {
    elements.floatingImportBtn.addEventListener('click', toggleFloatingImportPopover);
  }
  if (elements.closeFloatingImportPopoverBtn) {
    elements.closeFloatingImportPopoverBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
    });
  }
  if (elements.floatingConfirmImportFolderBtn) {
    elements.floatingConfirmImportFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      executeFloatingNewImportFolder();
    });
  }
  if (elements.floatingImportFolderInput) {
    elements.floatingImportFolderInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        executeFloatingNewImportFolder();
      }
    });
  }
  if (elements.floatingOpenImportFolderBtn) {
    elements.floatingOpenImportFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
      openImportFolderInExplorer();
    });
  }

  // フローティングバー: 評価設定ポップオーバートグル (v1.86)
  if (elements.floatingRateBtn) {
    elements.floatingRateBtn.addEventListener('click', toggleFloatingRatePopover);
  }
  if (elements.closeFloatingRatePopoverBtn) {
    elements.closeFloatingRatePopoverBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
    });
  }
  if (elements.floatingRatePopover) {
    elements.floatingRatePopover.querySelectorAll('.popover-rate-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const rate = parseInt(btn.dataset.rating, 10);
        closeAllFloatingPopovers();
        await batchRateSelection(rate);
      });
    });
  }

  // フローティングバー: 旧評価ドロップダウン変更（フォールバック）
  if (elements.floatingRateSelect) {
    elements.floatingRateSelect.addEventListener('change', async (e) => {
      if (!e.target.value) return;
      const rate = parseInt(e.target.value, 10);
      await batchRateSelection(rate);
      elements.floatingRateSelect.value = '';
    });
  }

  // コンテキストメニュー: サムネイル取得・更新
  if (elements.contextMenuRefreshThumbItem) {
    elements.contextMenuRefreshThumbItem.addEventListener('click', () => {
      refreshSelectedThumbnails();
    });
  }

  // フローティングバー: サムネイル取得・更新
  if (elements.floatingRefreshThumbBtn) {
    elements.floatingRefreshThumbBtn.addEventListener('click', () => {
      closeAllFloatingPopovers();
      refreshSelectedThumbnails();
    });
  }

  // コンタクトシート（ベタ焼きHTML）出力ボタン（フォールバック連携）
  const floatingContactBtn = document.getElementById('floatingTriggerContactSheetBtn');
  if (floatingContactBtn && !floatingContactBtn.dataset.boundSelection) {
    floatingContactBtn.dataset.boundSelection = '1';
    floatingContactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
      if (typeof window.exportContactSheetHtml === 'function') {
        window.exportContactSheetHtml(Array.from(state.selectedPhotoIds));
      }
    });
  }

  const contextContactBtn = document.getElementById('contextTriggerContactSheetBtn');
  if (contextContactBtn && !contextContactBtn.dataset.boundSelection) {
    contextContactBtn.dataset.boundSelection = '1';
    contextContactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      if (typeof window.exportContactSheetHtml === 'function') {
        window.exportContactSheetHtml(Array.from(state.selectedPhotoIds));
      }
    });
  }

  // フローティングバー: 撮影日時一括シフト補正
  const floatShiftDateBtn = elements.floatingShiftDateBtn || document.getElementById('floatingShiftDateBtn');
  if (floatShiftDateBtn && !floatShiftDateBtn.dataset.boundShiftDate) {
    floatShiftDateBtn.dataset.boundShiftDate = '1';
    floatShiftDateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllFloatingPopovers();
      openDateShiftModal();
    });
  }

  // コンテキストメニュー: 撮影日時一括シフト補正
  const ctxShiftDateItem = elements.contextMenuShiftDateItem || document.getElementById('contextMenuShiftDateItem');
  if (ctxShiftDateItem && !ctxShiftDateItem.dataset.boundShiftDate) {
    ctxShiftDateItem.dataset.boundShiftDate = '1';
    ctxShiftDateItem.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      openDateShiftModal();
    });
  }

  // 撮影日時一括シフト補正モーダルのイベント登録
  initDateShiftModalEvents();
}

/**
 * 選択中の写真をライブラリ（DB）から削除する（実ファイルは削除しない）。
 * スタック表示中は、選択カードが代表するスタックメンバー（RAWペア・ブラケット）もまとめて削除する。
 */
async function deleteSelectedPhotos() {
  closeContextMenu();
  if (state.selectedPhotoIds.size === 0) return;

  const targetIds = new Set(state.selectedPhotoIds);
  if (state.isStacked) {
    for (const id of state.selectedPhotoIds) {
      const photo = state.photos.find(p => p.id === id);
      if (photo && Array.isArray(photo.stack_photos)) {
        photo.stack_photos.forEach(m => targetIds.add(m.id));
      }
    }
  }

  const selectedCount = state.selectedPhotoIds.size;
  const extraCount = targetIds.size - selectedCount;
  const confirmed = confirm(
    `選択中の ${selectedCount} 枚をライブラリから削除しますか？\n` +
    (extraCount > 0 ? `（スタック内の写真 ${extraCount} 枚も含みます）\n` : '') +
    `\n※ 写真ファイル自体は削除されません。\n` +
    `※ タグ・評価・サムネイルの情報は失われます。\n` +
    `※ 同じフォルダを再スキャンすると再登録されます。`
  );
  if (!confirmed) return;

  try {
    const res = await fetch('/api/photos/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: Array.from(targetIds) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'ライブラリからの削除に失敗しました');

    if (typeof showToast === 'function') {
      showToast(`🗑️ ${data.deleted || targetIds.size}枚の写真をライブラリから削除しました`, 'info', 3000);
    }
    clearSelection();
    await refreshAll();
  } catch (err) {
    if (typeof showToast === 'function') {
      showToast(`エラー: ${err.message}`, 'error');
    } else {
      alert('エラー: ' + err.message);
    }
  }
}

/**
 * 選択中の写真のサムネイルをサーバーに要求して再生成・取得する
 */
async function refreshSelectedThumbnails() {
  closeContextMenu();
  const photoIds = Array.from(state.selectedPhotoIds);
  if (photoIds.length === 0) return;

  const hasMissing = hasMissingThumbnailsInSelection();
  const actionName = hasMissing ? '取得' : '更新';
  if (typeof showToast === 'function') {
    showToast(`${photoIds.length}枚のサムネイルを${actionName}中...`, 'info', 3000);
  }

  // 対象カードにローディングクラスを付与
  const targetCards = [];
  photoIds.forEach(id => {
    const card = document.querySelector(`.photo-card[data-photo-id="${id}"]`);
    if (card) {
      card.classList.add('thumb-refreshing');
      targetCards.push(card);
    }
  });

  try {
    const res = await fetch('/api/thumbnails/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds, force: true }),
    });

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }

    const data = await res.json();
    const successSet = new Set(data.success_ids || []);

    // 成功した写真のサムネイル画像をキャッシュバスター付きURLで即時更新
    const now = Date.now();
    targetCards.forEach(card => {
      card.classList.remove('thumb-refreshing');
      const pid = parseInt(card.dataset.photoId, 10);
      if (successSet.has(pid)) {
        // 写真データオブジェクトの has_thumbnail とキャッシュバスターを更新
        const pObj = state.photos.find(p => p.id === pid);
        if (pObj) {
          pObj.has_thumbnail = 1;
          pObj._thumbBust = now;
        }

        const thumbUrl = pObj ? getThumbnailUrl(pObj) : `/api/photo/${pid}/thumbnail?t=${now}`;
        const img = card.querySelector('.card-thumb-img');
        if (img) {
          img.src = thumbUrl;
        }
        card.classList.remove('thumb-placeholder');

        // インスペクタ（右ペイン）で開いている写真ならインスペクタの画像も更新
        if (state.activeInspectorPhotoId === pid && elements.inspectorThumb) {
          elements.inspectorThumb.src = thumbUrl;
        }
      }
    });

    if (data.success_ids && data.success_ids.length > 0) {
      clearSelection();
      if (data.failed_ids && data.failed_ids.length > 0) {
        if (typeof showToast === 'function') {
          showToast(`${data.success_ids.length}枚のサムネイルを${actionName}しました（${data.failed_ids.length}枚失敗）`, 'warning', 4000);
        }
      } else {
        if (typeof showToast === 'function') {
          showToast(`${data.success_ids.length}枚のサムネイルを${actionName}しました`, 'success', 3000);
        }
      }
    } else {
      updateSelectionUI();
      if (typeof showToast === 'function') {
        showToast(`サムネイルの${actionName}に失敗しました（元ファイル未接続など）`, 'error', 4000);
      }
    }
  } catch (err) {
    console.error('サムネイル更新エラー:', err);
    targetCards.forEach(card => card.classList.remove('thumb-refreshing'));
    if (typeof showToast === 'function') {
      showToast(`サムネイルの${actionName}処理でエラーが発生しました`, 'error', 4000);
    }
  }
}

/**
 * 選択中の写真（GPSなし）に対して、撮影時刻が近いスマホ写真のGPS（±1時間）を一括準用する
 */
async function executeBatchInferGps() {
  const photoIds = Array.from(state.selectedPhotoIds);
  if (photoIds.length === 0) return;

  const confirmed = confirm(
    `選択中の ${photoIds.length} 枚の写真のうち、ジオタグがない写真に対して\n` +
    `撮影時刻が近いスマホ写真のジオタグ（±1時間以内）を一括準用しますか？\n\n` +
    `※ 元の写真ファイル（EXIF）は書き換えません。\n` +
    `※ 準用されたジオタグは後から解除することも可能です。`
  );
  if (!confirmed) return;

  if (typeof showToast === 'function') {
    showToast(`${photoIds.length}枚のジオタグ準用を処理中...`, 'info', 3000);
  }

  try {
    const res = await fetch('/api/photos/batch-infer-gps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds, max_minutes: 60 }),
    });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();

    if (data.inferred_count > 0) {
      if (typeof showToast === 'function') {
        showToast(`📍 ${data.inferred_count} 枚の写真にジオタグを準用しました`, 'success', 3500);
      }
      clearSelection();
      // 再読み込みしてメタデータを画面に反映
      if (typeof refreshAll === 'function') {
        await refreshAll();
      }
    } else {
      if (typeof showToast === 'function') {
        showToast('±1時間以内にジオタグ付きの写真が見つかりませんでした', 'warning', 3500);
      }
    }
  } catch (err) {
    console.error('一括ジオタグ準用エラー:', err);
    if (typeof showToast === 'function') {
      showToast('ジオタグ準用処理でエラーが発生しました', 'error', 4000);
    }
  }
}

/**
 * 選択中の写真から、SQLiteデータベース上のジオタグ情報（緯度・経度・地名）を一括削除する
 */
async function executeBatchClearGps() {
  const photoIds = Array.from(state.selectedPhotoIds);
  if (photoIds.length === 0) return;

  const confirmed = confirm(
    `選択中の ${photoIds.length} 枚の写真から、SQLiteデータベース上のジオタグ情報（緯度・経度・地名）を一括削除しますか？\n\n` +
    `※ 元の写真ファイル（EXIF）は変更されません。\n` +
    `※ ジオタグがついていない写真はスキップされます。`
  );
  if (!confirmed) return;

  if (typeof showToast === 'function') {
    showToast(`${photoIds.length}枚のジオタグ削除を処理中...`, 'info', 2000);
  }

  try {
    const res = await fetch('/api/photos/clear-gps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    });
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = await res.json();

    const count = data.cleared_count || 0;
    if (count > 0) {
      if (typeof showToast === 'function') {
        showToast(`🗑️ ${count} 枚の写真からジオタグを削除しました`, 'success', 3500);
      }
      clearSelection();
      // 再読み込みしてメタデータおよびツリーを画面に反映
      if (typeof refreshAll === 'function') {
        await refreshAll();
      }
    } else {
      if (typeof showToast === 'function') {
        showToast('選択中の写真にはジオタグが設定されていませんでした', 'info', 3000);
      }
    }
  } catch (err) {
    console.error('一括ジオタグ削除エラー:', err);
    if (typeof showToast === 'function') {
      showToast('ジオタグ削除処理でエラーが発生しました', 'error', 4000);
    }
  }
}
window.executeBatchClearGps = executeBatchClearGps;

/* ==========================================================================
   撮影日時の一括シフト補正モーダル (#dateShiftModal)
   ========================================================================== */
let _dateShiftTargetIds = [];

/**
 * ローカルタイム基準で "YYYY-MM-DD HH:MM:SS" 文字列に offsetSeconds を加算してフォーマットする
 * ※ Date.toISOString() は UTC ズレを起こすため使用禁止
 */
function _formatShiftedDateLocal(dateStr, offsetSeconds) {
  if (!dateStr) return '';
  const str = String(dateStr).trim();
  const m = str.match(/^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return str;

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = parseInt(m[6], 10);

  const dt = new Date(year, month - 1, day, hour, minute, second);
  if (isNaN(dt.getTime())) return str;

  const shifted = new Date(dt.getTime() + (Number(offsetSeconds) || 0) * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const yStr = String(shifted.getFullYear()).padStart(4, '0');
  const moStr = pad2(shifted.getMonth() + 1);
  const dStr = pad2(shifted.getDate());
  const hStr = pad2(shifted.getHours());
  const miStr = pad2(shifted.getMinutes());
  const sStr = pad2(shifted.getSeconds());

  return `${yStr}-${moStr}-${dStr} ${hStr}:${miStr}:${sStr}`;
}

/**
 * モーダル入力欄から現在のシフト秒数（符号付き整数）を算出する
 */
function _getDateShiftOffsetSeconds() {
  const dirEl = elements.dateShiftDirection || document.getElementById('dateShiftDirection');
  const daysEl = elements.dateShiftDays || document.getElementById('dateShiftDays');
  const hoursEl = elements.dateShiftHours || document.getElementById('dateShiftHours');
  const minutesEl = elements.dateShiftMinutes || document.getElementById('dateShiftMinutes');
  const secondsEl = elements.dateShiftSeconds || document.getElementById('dateShiftSeconds');

  const dir = (dirEl && String(dirEl.value) === '-1') ? -1 : 1;
  const d = Math.max(0, parseInt(daysEl ? daysEl.value : '0', 10) || 0);
  const h = Math.max(0, parseInt(hoursEl ? hoursEl.value : '0', 10) || 0);
  const m = Math.max(0, parseInt(minutesEl ? minutesEl.value : '0', 10) || 0);
  const s = Math.max(0, parseInt(secondsEl ? secondsEl.value : '0', 10) || 0);

  return dir * (d * 86400 + h * 3600 + m * 60 + s);
}

/**
 * 指定された写真ID配列に対応する写真オブジェクト一覧を取得する（スタック内写真も探索）
 */
function _getDateShiftTargetPhotoObjects(ids) {
  const result = [];
  const seen = new Set();
  const idSet = new Set((ids || []).map(id => Number(id)));

  for (const p of (state.photos || [])) {
    if (idSet.has(Number(p.id)) && !seen.has(Number(p.id))) {
      seen.add(Number(p.id));
      result.push(p);
    }
    if (Array.isArray(p.stack_photos)) {
      for (const sp of p.stack_photos) {
        if (idSet.has(Number(sp.id)) && !seen.has(Number(sp.id))) {
          seen.add(Number(sp.id));
          result.push(sp);
        }
      }
    }
  }
  return result;
}

/**
 * 撮影日時一括シフト補正モーダルを開く
 */
function openDateShiftModal(targetPhotoIds) {
  let ids = [];
  if (Array.isArray(targetPhotoIds) && targetPhotoIds.length > 0) {
    ids = targetPhotoIds.map(id => Number(id)).filter(Boolean);
  } else if (targetPhotoIds instanceof Set && targetPhotoIds.size > 0) {
    ids = Array.from(targetPhotoIds).map(id => Number(id)).filter(Boolean);
  } else if (state.selectedPhotoIds && state.selectedPhotoIds.size > 0) {
    ids = Array.from(state.selectedPhotoIds).map(id => Number(id)).filter(Boolean);
  } else if (state.currentPhotoIndex >= 0 && typeof getCurrentLightboxPhoto === 'function') {
    const cur = getCurrentLightboxPhoto();
    if (cur && cur.id) ids = [Number(cur.id)];
  } else if (state.activeInspectorPhotoId) {
    ids = [Number(state.activeInspectorPhotoId)];
  }

  if (ids.length === 0) {
    if (typeof showToast === 'function') {
      showToast('撮影日時を補正する写真を選択してください', 'warning', 3000);
    }
    return;
  }

  _dateShiftTargetIds = ids;
  initDateShiftModalEvents();

  const modal = elements.dateShiftModal || document.getElementById('dateShiftModal');
  if (!modal) return;

  const countEl = elements.dateShiftTargetCount || document.getElementById('dateShiftTargetCount');
  if (countEl) {
    countEl.textContent = String(ids.length);
  }

  // 入力欄を初期値にリセット
  const dirEl = elements.dateShiftDirection || document.getElementById('dateShiftDirection');
  const daysEl = elements.dateShiftDays || document.getElementById('dateShiftDays');
  const hoursEl = elements.dateShiftHours || document.getElementById('dateShiftHours');
  const minutesEl = elements.dateShiftMinutes || document.getElementById('dateShiftMinutes');
  const secondsEl = elements.dateShiftSeconds || document.getElementById('dateShiftSeconds');

  if (dirEl) dirEl.value = '1';
  if (daysEl) daysEl.value = '0';
  if (hoursEl) hoursEl.value = '0';
  if (minutesEl) minutesEl.value = '0';
  if (secondsEl) secondsEl.value = '0';

  const presetGroup = elements.dateShiftPresetGroup || document.getElementById('dateShiftPresetGroup');
  if (presetGroup) {
    presetGroup.querySelectorAll('.date-shift-preset-btn').forEach(btn => {
      btn.classList.remove('active');
    });
  }

  // 元のEXIF日時に戻すボタンの有効/無効制御
  const resetBtn = elements.dateShiftResetOrigBtn || document.getElementById('dateShiftResetOrigBtn');
  if (resetBtn) {
    const targetPhotos = _getDateShiftTargetPhotoObjects(ids);
    const hasOrig = targetPhotos.some(p => Boolean(p && p.original_date_taken));
    resetBtn.disabled = !hasOrig;
    resetBtn.style.opacity = hasOrig ? '1' : '0.5';
    resetBtn.title = hasOrig
      ? 'シフト補正前の元のEXIF撮影日時に復元します'
      : '選択中の写真にシフト補正履歴（元のEXIF日時）はありません';
  }

  updateDateShiftPreview();
  modal.style.display = 'flex';
}

/**
 * 撮影日時一括シフト補正モーダルを閉じる
 */
function closeDateShiftModal() {
  const modal = elements.dateShiftModal || document.getElementById('dateShiftModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

/**
 * 撮影日時シフトのプレビューリスト（先頭最大5件）をリアルタイム描画する
 */
function updateDateShiftPreview() {
  const previewList = elements.dateShiftPreviewList || document.getElementById('dateShiftPreviewList');
  if (!previewList) return;

  const offsetSeconds = _getDateShiftOffsetSeconds();
  const targetPhotos = _getDateShiftTargetPhotoObjects(_dateShiftTargetIds);
  const samplePhotos = targetPhotos.slice(0, 5);

  if (samplePhotos.length === 0) {
    previewList.innerHTML = `<div class="date-shift-preview-empty" style="padding: 8px; color: var(--text-dim, #64748b); font-size: 0.78rem;">対象写真がありません</div>`;
    return;
  }

  const rowsHtml = samplePhotos.map(p => {
    const fname = _escHtml(p.file_name || `ID:${p.id}`);
    const curDate = p.date_taken ? String(p.date_taken) : '';
    const origDate = p.original_date_taken ? String(p.original_date_taken) : '';
    const origBadge = origDate
      ? ` <span class="date-shift-orig-note" style="font-size: 0.7rem; color: var(--text-dim, #64748b);">(元: ${_escHtml(origDate)})</span>`
      : '';

    if (!curDate) {
      return `
        <div class="date-shift-preview-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; font-size: 0.78rem; border-bottom: 1px solid var(--border-soft, rgba(255,255,255,0.06));">
          <span class="preview-fname" style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;" title="${fname}">${fname}</span>
          <span style="color: var(--text-dim, #64748b);">撮影日時なし${origBadge}</span>
        </div>
      `;
    }

    const shiftedDate = _formatShiftedDateLocal(curDate, offsetSeconds);
    const isChanged = shiftedDate !== curDate;
    const afterColor = isChanged ? 'var(--accent-primary, #e14d2a)' : 'var(--text-main, #eceae4)';

    return `
      <div class="date-shift-preview-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; font-size: 0.78rem; border-bottom: 1px solid var(--border-soft, rgba(255,255,255,0.06)); flex-wrap: wrap;">
        <span class="preview-fname" style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px;" title="${fname}">${fname}</span>
        <div class="preview-dates" style="display: flex; align-items: center; gap: 6px; font-family: monospace; font-size: 0.76rem; flex-wrap: wrap;">
          <span class="preview-date-before" style="color: var(--text-muted, #94a3b8);">${_escHtml(curDate)}${origBadge}</span>
          <span class="preview-arrow" style="color: var(--text-dim, #64748b);">➜</span>
          <span class="preview-date-after" style="font-weight: 700; color: ${afterColor};">${_escHtml(shiftedDate)}</span>
        </div>
      </div>
    `;
  }).join('');

  const moreCount = Math.max(0, targetPhotos.length - samplePhotos.length);
  const moreHtml = moreCount > 0
    ? `<div class="date-shift-preview-more" style="padding: 4px 6px; font-size: 0.72rem; color: var(--text-dim, #64748b); text-align: right;">…他 ${moreCount} 枚</div>`
    : '';

  previewList.innerHTML = rowsHtml + moreHtml;
}

/**
 * 撮影日時一括シフト補正（または元のEXIF日時へのリセット）をAPIへ送信して即時反映する
 */
async function submitDateShift(resetMode = false) {
  if (!_dateShiftTargetIds || _dateShiftTargetIds.length === 0) return;

  const offsetSeconds = resetMode ? 0 : _getDateShiftOffsetSeconds();
  if (!resetMode && offsetSeconds === 0) {
    if (typeof showToast === 'function') {
      showToast('シフトする時間（日・時・分・秒）を指定してください', 'warning', 3000);
    }
    return;
  }

  const submitBtn = elements.dateShiftSubmitBtn || document.getElementById('dateShiftSubmitBtn');
  const resetBtn = elements.dateShiftResetOrigBtn || document.getElementById('dateShiftResetOrigBtn');
  if (submitBtn) submitBtn.disabled = true;
  if (resetBtn) resetBtn.disabled = true;

  try {
    const res = await fetch('/api/photos/batch-shift-date', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: _dateShiftTargetIds,
        offset_seconds: offsetSeconds,
        reset: Boolean(resetMode),
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || '撮影日時の更新に失敗しました');
    }

    // サーバーから返却された個別更新マップを構築（updated_photos が配列またはオブジェクトの場合に対応）
    const serverUpdatedMap = new Map();
    const _srvPhotos = data.photos || data.updated_photos;
    if (Array.isArray(_srvPhotos)) {
      _srvPhotos.forEach(item => {
        if (item && item.id != null) {
          serverUpdatedMap.set(Number(item.id), item);
        }
      });
    } else if (data.updated_photos && typeof data.updated_photos === 'object') {
      Object.entries(data.updated_photos).forEach(([k, v]) => {
        serverUpdatedMap.set(Number(k), v);
      });
    }

    const targetIdSet = new Set(_dateShiftTargetIds.map(id => Number(id)));

    // 写真オブジェクト1件にシフト結果を即時反映するヘルパー
    const applyUpdateToPhotoObj = (p) => {
      if (!p || !targetIdSet.has(Number(p.id))) return;
      const srv = serverUpdatedMap.get(Number(p.id));
      if (srv) {
        if (srv.date_taken !== undefined) p.date_taken = srv.date_taken;
        if (srv.year_month !== undefined) {
          p.year_month = srv.year_month;
        } else if (p.date_taken) {
          p.year_month = String(p.date_taken).substring(0, 7);
        }
        if ('original_date_taken' in srv) {
          p.original_date_taken = srv.original_date_taken;
        }
      } else if (resetMode) {
        if (p.original_date_taken) {
          p.date_taken = p.original_date_taken;
          p.year_month = String(p.date_taken).substring(0, 7);
          p.original_date_taken = null;
        }
      } else if (p.date_taken) {
        if (!p.original_date_taken) {
          p.original_date_taken = p.date_taken;
        }
        p.date_taken = _formatShiftedDateLocal(p.date_taken, offsetSeconds);
        p.year_month = String(p.date_taken).substring(0, 7);
      }
    };

    // state.photos および stack_photos 内の該当写真を更新
    (state.photos || []).forEach(p => {
      applyUpdateToPhotoObj(p);
      if (Array.isArray(p.stack_photos)) {
        p.stack_photos.forEach(sp => applyUpdateToPhotoObj(sp));
      }
    });

    // DOM上のカード日付表示を即時更新
    const grid = elements.photoGrid || document.getElementById('photoGrid');
    if (grid) {
      _dateShiftTargetIds.forEach(pid => {
        const card = grid.querySelector(`.photo-card[data-photo-id="${pid}"]`);
        const pObj = (state.photos || []).find(p => Number(p.id) === Number(pid));
        if (card && pObj && pObj.date_taken) {
          const dateShort = String(pObj.date_taken).substring(0, 10);
          card.querySelectorAll('.card-date').forEach(el => {
            el.textContent = dateShort;
          });
        }
      });
    }

    // 右インスペクタの表示更新
    if (typeof updateInspectorView === 'function') {
      updateInspectorView();
    }

    // ライトボックスが開いている場合はライトボックスの日時表示も更新
    if (state.currentPhotoIndex >= 0 && typeof getCurrentLightboxPhoto === 'function') {
      const curLight = getCurrentLightboxPhoto();
      if (curLight && targetIdSet.has(Number(curLight.id))) {
        if (elements.exifDateTaken) {
          elements.exifDateTaken.textContent = curLight.date_taken || '-';
        }
        if (elements.lightboxMeta) {
          const datePart = curLight.date_taken || '日付不明';
          const camPart = curLight.camera_model || 'カメラ不明';
          elements.lightboxMeta.textContent = `${datePart} | ${camPart}`;
        }
      }
    }

    // タイムラインツリーの再取得・更新
    if (typeof fetchTimeline === 'function') {
      fetchTimeline();
    }

    const updatedCount = data.updated_count != null ? data.updated_count : _dateShiftTargetIds.length;
    if (typeof showToast === 'function') {
      if (resetMode) {
        showToast(`↩️ ${updatedCount}枚の写真の撮影日時を元のEXIF日時に戻しました`, 'success', 3500);
      } else {
        showToast(`🕒 ${updatedCount}枚の写真の撮影日時を一括シフト補正しました`, 'success', 3500);
      }
    }

    closeDateShiftModal();
  } catch (err) {
    console.error('[DATE_SHIFT] error:', err);
    if (typeof showToast === 'function') {
      showToast(`エラー: ${err.message}`, 'error', 4000);
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
  }
}

/**
 * 撮影日時一括シフト補正モーダルのイベントリスナー登録
 */
function initDateShiftModalEvents() {
  const modal = elements.dateShiftModal || document.getElementById('dateShiftModal');
  const closeBtn = elements.closeDateShiftModalBtn || document.getElementById('closeDateShiftModalBtn');
  const cancelBtn = elements.cancelDateShiftModalBtn || document.getElementById('cancelDateShiftModalBtn');
  const dirEl = elements.dateShiftDirection || document.getElementById('dateShiftDirection');
  const daysEl = elements.dateShiftDays || document.getElementById('dateShiftDays');
  const hoursEl = elements.dateShiftHours || document.getElementById('dateShiftHours');
  const minutesEl = elements.dateShiftMinutes || document.getElementById('dateShiftMinutes');
  const secondsEl = elements.dateShiftSeconds || document.getElementById('dateShiftSeconds');
  const presetGroup = elements.dateShiftPresetGroup || document.getElementById('dateShiftPresetGroup');
  const submitBtn = elements.dateShiftSubmitBtn || document.getElementById('dateShiftSubmitBtn');
  const resetBtn = elements.dateShiftResetOrigBtn || document.getElementById('dateShiftResetOrigBtn');

  if (closeBtn && !closeBtn.dataset.boundShift) {
    closeBtn.dataset.boundShift = '1';
    closeBtn.addEventListener('click', closeDateShiftModal);
  }
  if (cancelBtn && !cancelBtn.dataset.boundShift) {
    cancelBtn.dataset.boundShift = '1';
    cancelBtn.addEventListener('click', closeDateShiftModal);
  }
  if (modal && !modal.dataset.boundShift) {
    modal.dataset.boundShift = '1';
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDateShiftModal();
    });
  }

  // 入力変更時にリアルタイムプレビュー更新
  [dirEl, daysEl, hoursEl, minutesEl, secondsEl].forEach(el => {
    if (el && !el.dataset.boundShift) {
      el.dataset.boundShift = '1';
      el.addEventListener('input', updateDateShiftPreview);
      el.addEventListener('change', updateDateShiftPreview);
    }
  });

  // プリセットボタンクリック処理 (.date-shift-preset-btn[data-offset-sec])
  if (presetGroup && !presetGroup.dataset.boundShift) {
    presetGroup.dataset.boundShift = '1';
    presetGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('.date-shift-preset-btn[data-offset-sec]');
      if (!btn) return;
      e.preventDefault();

      const offsetSec = parseInt(btn.dataset.offsetSec, 10) || 0;
      const dEl = elements.dateShiftDirection || document.getElementById('dateShiftDirection');
      const dyEl = elements.dateShiftDays || document.getElementById('dateShiftDays');
      const hrEl = elements.dateShiftHours || document.getElementById('dateShiftHours');
      const mnEl = elements.dateShiftMinutes || document.getElementById('dateShiftMinutes');
      const scEl = elements.dateShiftSeconds || document.getElementById('dateShiftSeconds');

      if (dEl) {
        dEl.value = offsetSec < 0 ? '-1' : '1';
      }
      let absSec = Math.abs(offsetSec);
      const days = Math.floor(absSec / 86400);
      absSec %= 86400;
      const hours = Math.floor(absSec / 3600);
      absSec %= 3600;
      const minutes = Math.floor(absSec / 60);
      const seconds = absSec % 60;

      if (dyEl) dyEl.value = String(days);
      if (hrEl) hrEl.value = String(hours);
      if (mnEl) mnEl.value = String(minutes);
      if (scEl) scEl.value = String(seconds);

      presetGroup.querySelectorAll('.date-shift-preset-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });

      updateDateShiftPreview();
    });
  }

  if (submitBtn && !submitBtn.dataset.boundShift) {
    submitBtn.dataset.boundShift = '1';
    submitBtn.addEventListener('click', () => submitDateShift(false));
  }
  if (resetBtn && !resetBtn.dataset.boundShift) {
    resetBtn.dataset.boundShift = '1';
    resetBtn.addEventListener('click', () => submitDateShift(true));
  }
}

window._formatShiftedDateLocal = _formatShiftedDateLocal;
window.openDateShiftModal = openDateShiftModal;
window.closeDateShiftModal = closeDateShiftModal;
window.updateDateShiftPreview = updateDateShiftPreview;
window.submitDateShift = submitDateShift;



