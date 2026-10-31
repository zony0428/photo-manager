/**
 * フォルダツリー（左ペイン「📁 フォルダ」タブ）
 * ショートカット → 接続中ドライブ → 区切り線 → 未接続ボリューム（キャッシュのみ）の順に、
 * 遅延展開ツリーとして表示する。データは /api/folder-tree/roots と /api/folder-tree/children から取得する。
 */

const folderTreeState = {
  roots: null,                 // /api/folder-tree/roots の取得結果
  childrenData: new Map(),     // ノードキー → 子フォルダ取得結果（取得済み）
  childrenPromises: new Map(), // ノードキー → 取得中の Promise（重複リクエスト防止）
  expanded: new Map(),         // 展開中のノードキー → ノード情報（再取得時のパラメータに使う）
  renderToken: 0,              // 古い取得結果で描画し直さないための世代番号
};

const FOLDER_SVG_CLOSED = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const FOLDER_SVG_OPEN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="2" y1="10" x2="22" y2="10"/></svg>';
const DRIVE_SVG_DEFAULT = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>';

const FOLDER_TREE_SHORTCUT_ICONS = {
  storage: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  pictures: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  documents: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  desktop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
};
const FOLDER_TREE_DRIVE_ICONS = {
  fixed: DRIVE_SVG_DEFAULT,
  removable: DRIVE_SVG_DEFAULT,
  network: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  cdrom: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
  ramdisk: DRIVE_SVG_DEFAULT,
};

/** 比較用のパス正規化（区切りを \ に統一・末尾区切り除去・小文字化） */
function _ftNormPath(path) {
  return String(path || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** ノードキー（表示グループ＋正規化パス）。同じパスでもショートカット配下とドライブ配下は別々に開閉する */
function _ftKey(scope, path) {
  return `${scope}|${_ftNormPath(path)}`;
}

function _ftFormatCount(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

/* --------------------------------------------------------------------------
   ノード情報の生成
   -------------------------------------------------------------------------- */
function _ftShortcutNode(s) {
  const isStorage = !!s.is_storage || s.key === 'storage';
  const isStorageRoot = !!s.is_storage_root || s.key === 'storage';
  return {
    kind: 'shortcut', scope: 'sc', key: _ftKey('sc', s.path), name: s.name, path: s.path,
    icon: FOLDER_TREE_SHORTCUT_ICONS[s.key] || (isStorage ? FOLDER_TREE_SHORTCUT_ICONS.storage : FOLDER_SVG_CLOSED), status: isStorage ? 'managed' : 'root', count: 0, total: s.total,
    hasManaged: !!s.has_managed || isStorage, hasChildren: true, isMissing: false, isOffline: false,
    volumeSerial: null, serialMode: 'any', isStorage, isStorageRoot,
  };
}

function _ftDriveNode(d) {
  return {
    kind: 'drive', scope: 'on', key: _ftKey('on', d.path), name: d.name, path: d.path,
    icon: FOLDER_TREE_DRIVE_ICONS[d.drive_type] || DRIVE_SVG_DEFAULT, status: 'root', count: 0, total: d.total,
    hasManaged: !!d.has_managed, hasChildren: true, isMissing: false, isOffline: false,
    volumeSerial: d.volume_serial || null, serialMode: d.serial_mode || 'any', driveType: d.drive_type,
  };
}

function _ftOfflineNode(v) {
  const scope = `off:${v.key}`;
  return {
    kind: 'offline', scope, key: _ftKey(scope, v.path), name: v.name, path: v.path,
    icon: DRIVE_SVG_DEFAULT, status: 'root', count: 0, total: v.total, hasManaged: true, hasChildren: true,
    isMissing: false, isOffline: true, volumeSerial: v.volume_serial || null,
    serialMode: v.serial_mode || 'any', letter: v.letter, label: v.label,
  };
}

function _ftChildNode(parent, c) {
  const isStorage = !!c.is_storage || !!parent?.isStorage;
  return {
    kind: 'folder', scope: parent.scope, key: _ftKey(parent.scope, c.path), name: c.name, path: c.path,
    icon: FOLDER_SVG_CLOSED, status: c.status, count: c.count, total: c.total, hasManaged: !!c.has_managed || isStorage,
    hasChildren: !!c.has_children, isMissing: !!c.is_missing, isOffline: parent.isOffline,
    volumeSerial: parent.volumeSerial, serialMode: parent.serialMode, isStorage, isStorageRoot: false,
  };
}

function _ftRootNodes() {
  const roots = folderTreeState.roots || {};
  return [
    ...(roots.shortcuts || []).map(_ftShortcutNode),
    ...(roots.drives || []).map(_ftDriveNode),
    ...(roots.offline_volumes || []).map(_ftOfflineNode),
  ];
}

/* --------------------------------------------------------------------------
   データ取得
   -------------------------------------------------------------------------- */
async function _ftFetchChildren(node) {
  if (folderTreeState.childrenData.has(node.key)) return folderTreeState.childrenData.get(node.key);
  if (folderTreeState.childrenPromises.has(node.key)) return folderTreeState.childrenPromises.get(node.key);

  const params = new URLSearchParams({ path: node.path, serial_mode: node.serialMode || 'any' });
  if (node.volumeSerial) params.append('volume_serial', node.volumeSerial);
  if (node.isOffline) params.append('offline', 'true');

  const promise = fetch(`/api/folder-tree/children?${params.toString()}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      folderTreeState.childrenData.set(node.key, data);
      return data;
    })
    .finally(() => {
      folderTreeState.childrenPromises.delete(node.key);
    });
  folderTreeState.childrenPromises.set(node.key, promise);
  return promise;
}

/** 現在のルート一覧に属さない展開状態（外したドライブ等）を破棄する */
function _ftPruneExpanded() {
  const rootKeys = _ftRootNodes().map(r => r.key);
  for (const key of Array.from(folderTreeState.expanded.keys())) {
    const alive = rootKeys.some(rk => key === rk || key.startsWith(rk + '\\'));
    if (!alive) folderTreeState.expanded.delete(key);
  }
}

/**
 * ツリー全体を再取得して描画する（スキャン・管理状態変更・ドライブ抜き差し後に呼ぶ）。
 * 展開中のノードは子を先に読み込んでから描画し、ちらつきを防ぐ。
 */
async function refreshFolderTree() {
  const token = ++folderTreeState.renderToken;
  try {
    const res = await fetch('/api/folder-tree/roots');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const roots = await res.json();
    if (token !== folderTreeState.renderToken) return;

    folderTreeState.roots = roots;
    folderTreeState.childrenData.clear();
    folderTreeState.childrenPromises.clear();
    _ftPruneExpanded();

    await Promise.all(
      Array.from(folderTreeState.expanded.values()).map(n => _ftFetchChildren(n).catch((err) => {
        console.warn('フォルダツリー: 子フォルダの先読みに失敗しました', n.path, err);
        return null;
      }))
    );
    if (token !== folderTreeState.renderToken) return;
    renderFolderTree();
  } catch (err) {
    console.error('フォルダツリー取得エラー:', err);
    if (token === folderTreeState.renderToken && elements.folderList) {
      elements.folderList.replaceChildren(_ftHintLi('フォルダツリーの取得に失敗しました'));
    }
  }
}

/* --------------------------------------------------------------------------
   描画
   -------------------------------------------------------------------------- */
function _ftHintLi(text) {
  const li = document.createElement('li');
  li.className = 'empty-hint folder-tree-hint';
  li.textContent = text;
  return li;
}

function _ftSectionLi(text) {
  const li = document.createElement('li');
  li.className = 'folder-tree-section';
  li.textContent = text;
  return li;
}

function _ftSeparatorLi() {
  const li = document.createElement('li');
  li.className = 'folder-tree-separator';
  li.setAttribute('role', 'separator');
  return li;
}

/** 取得済みデータを使ってツリー全体を描画する（未取得の展開ノードは読み込み中表示の後に追従描画） */
function renderFolderTree() {
  const container = elements.folderList;
  if (!container || !folderTreeState.roots) return;

  const roots = folderTreeState.roots;
  const shortcuts = roots.shortcuts || [];
  const drives = roots.drives || [];
  const offline = roots.offline_volumes || [];

  const frag = document.createDocumentFragment();
  if (shortcuts.length > 0) {
    frag.appendChild(_ftSectionLi('ショートカット'));
    shortcuts.forEach(s => frag.appendChild(_ftBuildNodeLi(_ftShortcutNode(s))));
  }
  frag.appendChild(_ftSectionLi('接続中のドライブ'));
  if (drives.length > 0) {
    drives.forEach(d => frag.appendChild(_ftBuildNodeLi(_ftDriveNode(d))));
  } else {
    frag.appendChild(_ftHintLi('接続中のドライブがありません'));
  }
  if (offline.length > 0) {
    frag.appendChild(_ftSeparatorLi());
    frag.appendChild(_ftSectionLi('未接続（キャッシュのみ）'));
    offline.forEach(v => frag.appendChild(_ftBuildNodeLi(_ftOfflineNode(v))));
  }
  container.replaceChildren(frag);
  syncFolderTreeFilterStates();
  // スキャン中の場合、再描画後も対象ノードの直下にインライン進捗バーを再アタッチ
  if (_activeScanningPath) {
    const reItem = _ftFindItemByPath(_activeScanningPath);
    if (reItem) {
      reItem.classList.add('is-scanning-target');
      _ftGetOrCreateInlineProgress(reItem);
    }
  }
}

function _ftIcon(node, isExpanded) {
  if (node.kind === 'folder') return isExpanded ? FOLDER_SVG_OPEN : FOLDER_SVG_CLOSED;
  return node.icon || FOLDER_SVG_CLOSED;
}

function _ftTooltip(node) {
  const lines = [node.path];
  if (node.kind === 'offline') {
    lines.push(`未接続のドライブです（前回 ${node.letter}${node.label ? ` / ${node.label}` : ''}）`);
    lines.push('保存済みのサムネイルで閲覧・絞り込みができます');
  } else if (node.isOffline) {
    lines.push('未接続のドライブ上のフォルダです（キャッシュのみ）');
  } else if (node.isMissing) {
    lines.push('ライブラリに写真がありますが、実フォルダが見つかりません');
  } else if (node.status === 'managed') {
    lines.push('管理中のフォルダ');
  } else if (node.status === 'ignored') {
    lines.push('管理対象外（除外）');
  } else if (node.status === 'unmanaged') {
    lines.push('未登録のフォルダ（右クリックで管理に追加）');
  }
  if (node.total > 0) {
    const direct = node.count > 0 && node.count !== node.total ? `（直下 ${_ftFormatCount(node.count)} 枚）` : '';
    lines.push(`写真: 配下 ${_ftFormatCount(node.total)} 枚${direct}`);
  } else if (node.hasManaged) {
    lines.push('● 配下に管理フォルダがあります');
  }
  return lines.join('\n');
}

function _ftBadges(node) {
  const badges = [];
  if (node.status === 'ignored') {
    const b = document.createElement('span');
    b.className = 'badge-folder-status ignored';
    b.textContent = '除外';
    badges.push(b);
  }
  if (node.isMissing) {
    const b = document.createElement('span');
    b.className = 'badge-folder-missing';
    b.textContent = '消失';
    badges.push(b);
  }
  if (node.total > 0) {
    const b = document.createElement('span');
    b.className = 'nav-count';
    b.textContent = _ftFormatCount(node.total);
    badges.push(b);
  } else if (node.hasManaged) {
    const b = document.createElement('span');
    b.className = 'folder-managed-dot';
    b.textContent = '●';
    badges.push(b);
  }
  return badges;
}

function _ftFilterState(node) {
  if (!state.currentFilter || !state.currentFilter.value) return null;
  if (_ftNormPath(state.currentFilter.value) !== _ftNormPath(node.path)) return null;
  if (state.currentFilter.type === 'folder') return 'include';
  if (state.currentFilter.type === 'folder_exclude') return 'exclude';
  return null;
}

/**
 * フォルダツリー内のすべての .folder-tree-item に対して、
 * 自身の選択状態（active / active-exclude）および配下サブフォルダの選択状態（has-active-child-* ＆ 道しるべバッジ）を同期する
 */
function syncFolderTreeFilterStates() {
  const isFolderFilter = state.currentFilter &&
    (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude') &&
    Boolean(state.currentFilter.value);
  const targetNorm = isFolderFilter ? _ftNormPath(state.currentFilter.value) : '';
  const isExclude = isFolderFilter && state.currentFilter.type === 'folder_exclude';

  document.querySelectorAll('#folderList .folder-tree-item').forEach(el => {
    const itemPath = _ftNormPath(el.dataset.filterValue || '');
    const isExact = isFolderFilter && itemPath && itemPath === targetNorm;
    const isAncestor = isFolderFilter && itemPath && !isExact && targetNorm.startsWith(itemPath + '\\');

    el.classList.toggle('active', isExact && !isExclude);
    el.classList.toggle('active-exclude', isExact && isExclude);
    el.classList.toggle('has-active-child-include', isAncestor && !isExclude);
    el.classList.toggle('has-active-child-exclude', isAncestor && isExclude);

    el.querySelectorAll('.child-filter-badge').forEach(b => b.remove());
    if (isAncestor) {
      const badge = document.createElement('span');
      badge.className = `child-filter-badge ${isExclude ? 'is-exclude' : 'is-include'}`;
      badge.textContent = isExclude ? '−1' : '+1';
      badge.title = isExclude
        ? `配下のサブフォルダ（${state.currentFilter.value}）を除外中`
        : `配下のサブフォルダ（${state.currentFilter.value}）で絞り込み中`;
      const countEl = el.querySelector('.nav-count, .folder-managed-dot');
      if (countEl) el.insertBefore(badge, countEl);
      else el.appendChild(badge);
    }
  });
}
window.syncFolderTreeFilterStates = syncFolderTreeFilterStates;

function _ftBuildNodeLi(node) {
  const li = document.createElement('li');
  li.className = 'folder-tree-node';

  const isExpanded = node.hasChildren && folderTreeState.expanded.has(node.key);
  const item = document.createElement('div');
  const classes = ['folder-tree-item', `status-${node.status}`, `kind-${node.kind}`];
  if (node.hasManaged) classes.push('has-managed');
  if (node.isMissing) classes.push('is-missing');
  if (node.isOffline) classes.push('is-offline');
  if (node.isStorage) classes.push('is-storage-folder');
  if (node.isStorageRoot) classes.push('is-storage-root');
  const filterState = _ftFilterState(node);
  if (filterState === 'include') classes.push('active');
  else if (filterState === 'exclude') classes.push('active-exclude');
  item.className = classes.join(' ');
  // setFilter() のアクティブ表示更新と互換を保つための属性
  item.dataset.filterType = 'folder';
  item.dataset.filterValue = node.path;
  item.dataset.status = node.status;
  if (node.isStorage) {
    item.dataset.storagePath = node.path;
  }

  const toggle = document.createElement('span');
  if (node.hasChildren) {
    toggle.className = `folder-toggle-btn ${isExpanded ? '' : 'collapsed'}`.trim();
    toggle.textContent = isExpanded ? '▼' : '▶';
    toggle.title = isExpanded ? '折りたたむ' : '展開';
  } else {
    toggle.className = 'folder-toggle-spacer';
  }

  const icon = document.createElement('span');
  icon.className = 'folder-tree-icon';
  icon.innerHTML = _ftIcon(node, isExpanded);

  const name = document.createElement('span');
  name.className = 'folder-tree-name';
  name.textContent = node.name;
  name.title = _ftTooltip(node);

  item.append(toggle, icon, name, ..._ftBadges(node));

  item.addEventListener('click', (e) => {
    if (e.target.closest('.folder-toggle-btn')) return;
    _ftHandleClick(node);
  });
  item.addEventListener('contextmenu', (e) => _ftHandleContextMenu(e, node));
  if (node.isStorage) {
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      item.classList.add('drag-over-storage');
    });
    item.addEventListener('dragleave', (e) => {
      if (!item.contains(e.relatedTarget)) {
        item.classList.remove('drag-over-storage');
      }
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over-storage');
      let explicitIds = null;
      if (e.dataTransfer) {
        const raw = e.dataTransfer.getData('application/x-photomanager-photos') || e.dataTransfer.getData('text/plain');
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) explicitIds = parsed;
          } catch (_err) {
            // JSONでない場合は window._draggingPhotoIds を使用
          }
        }
      }
      if (typeof window.handleDropPhotosToStorageFolder === 'function') {
        window.handleDropPhotosToStorageFolder(node.path, node.name, explicitIds);
      }
    });
  }
  if (node.hasChildren) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      _ftToggle(node, li);
    });
  }

  li.appendChild(item);
  if (isExpanded) li.appendChild(_ftBuildChildrenUl(node));
  return li;
}

function _ftBuildChildrenUl(node) {
  const ul = document.createElement('ul');
  ul.className = 'folder-tree-children';

  const data = folderTreeState.childrenData.get(node.key);
  if (data) {
    _ftFillChildren(ul, node, data);
    return ul;
  }

  ul.appendChild(_ftHintLi('読み込み中...'));
  _ftFetchChildren(node)
    .then((d) => {
      if (!ul.isConnected) return;  // 再描画済みの古い要素には反映しない
      ul.replaceChildren();
      _ftFillChildren(ul, node, d);
    })
    .catch((err) => {
      console.error('フォルダツリー: 子フォルダ取得エラー', node.path, err);
      if (ul.isConnected) ul.replaceChildren(_ftHintLi('読み込みに失敗しました'));
    });
  return ul;
}

function _ftFillChildren(ul, node, data) {
  const children = (data && data.children) || [];
  if (children.length === 0) {
    ul.appendChild(_ftHintLi('サブフォルダはありません'));
    return;
  }
  const frag = document.createDocumentFragment();
  children.forEach(c => frag.appendChild(_ftBuildNodeLi(_ftChildNode(node, c))));
  ul.appendChild(frag);
  syncFolderTreeFilterStates();
}

/** 指定キー自身とその配下の展開状態を破棄する */
function _ftCollapseKey(key) {
  for (const k of Array.from(folderTreeState.expanded.keys())) {
    if (k === key || k.startsWith(key + '\\')) folderTreeState.expanded.delete(k);
  }
}

/** ▶/▼ による開閉（そのノードの子だけを差し替え、ツリー全体は描画し直さない） */
function _ftToggle(node, li) {
  const toggle = li.querySelector(':scope > .folder-tree-item > .folder-toggle-btn');
  const icon = li.querySelector(':scope > .folder-tree-item > .folder-tree-icon');
  const existing = li.querySelector(':scope > .folder-tree-children');
  const willExpand = !folderTreeState.expanded.has(node.key);

  if (willExpand) {
    folderTreeState.expanded.set(node.key, node);
    li.appendChild(_ftBuildChildrenUl(node));
  } else {
    _ftCollapseKey(node.key);
    if (existing) existing.remove();
  }
  if (toggle) {
    toggle.classList.toggle('collapsed', !willExpand);
    toggle.textContent = willExpand ? '▼' : '▶';
    toggle.title = willExpand ? '折りたたむ' : '展開';
  }
  if (icon) icon.innerHTML = _ftIcon(node, willExpand);
  syncFolderTreeFilterStates();
}

/* --------------------------------------------------------------------------
   操作
   -------------------------------------------------------------------------- */
/** 左クリック: 1回目でそのフォルダ（配下含む）に絞り込み、2回目で除外絞り込み、3回目で解除 */
function _ftHandleClick(node) {
  const current = _ftFilterState(node);
  if (current === 'include') {
    // 2回目: 除外絞り込み
    setFilter('folder_exclude', node.path, `除外: ${node.name}`);
    return;
  }
  if (current === 'exclude') {
    // 3回目: 解除
    setFilter('all', null, 'すべての写真');
    return;
  }
  // 1回目: 通常絞り込み
  let prefix = '';
  if (node.isOffline) prefix = '[未接続] ';
  else if (node.isMissing) prefix = '[消失] ';
  else if (node.status === 'ignored') prefix = '[除外] ';
  else if (node.status === 'unmanaged' && !node.hasManaged && !node.isStorage) prefix = '[未登録] ';
  setFilter('folder', node.path, `${prefix}${node.name}`);

  // 接続中かつ実フォルダが存在する場合、バックグラウンドで差分または管理登録判定
  if (!node.isOffline && !node.isMissing && typeof checkAndPromptFolderRefresh === 'function') {
    checkAndPromptFolderRefresh(node.path, node.name, node);
  }
}

/** 右クリック: フォルダ・ドライブ・ショートカット共通のコンテキストメニューを開く */
function _ftHandleContextMenu(e, node) {
  e.preventDefault();
  e.stopPropagation();
  openFolderContextMenu(e.clientX, e.clientY, {
    name: node.name,
    fullPath: node.path,
    status: node.status,
    kind: node.kind,
    isMissing: node.isMissing || node.isOffline,
    isOffline: node.isOffline,
    count: node.count,
    totalCount: node.total,
    hasManaged: node.hasManaged,
    isStorage: !!node.isStorage,
    isStorageRoot: !!node.isStorageRoot,
  });
}

/**
 * 指定フォルダが見えるよう、祖先ノードを展開状態にする（描画はしない）。
 * 対象を含むルートのうち最も深いもの（ショートカット → ドライブ → 未接続の順で同じ深さなら先勝ち）を使う。
 * 展開状態が変わった場合は true を返す。
 */
function _ftExpandAncestors(path) {
  const target = _ftNormPath(path);
  let root = null;
  let rootLen = -1;
  _ftRootNodes().forEach((r) => {
    const rp = _ftNormPath(r.path);
    if ((target === rp || target.startsWith(rp + '\\')) && rp.length > rootLen) {
      root = r;
      rootLen = rp.length;
    }
  });
  if (!root || target === _ftNormPath(root.path)) return false;

  let changed = false;
  if (!folderTreeState.expanded.has(root.key)) {
    folderTreeState.expanded.set(root.key, root);
    changed = true;
  }
  const rootBase = String(root.path).replace(/\//g, '\\').replace(/\\+$/, '');
  const segments = String(path).replace(/\//g, '\\').replace(/\\+$/, '')
    .slice(rootBase.length).split('\\').filter(Boolean);
  let acc = rootBase;
  for (let i = 0; i < segments.length - 1; i++) {
    acc += '\\' + segments[i];
    const key = _ftKey(root.scope, acc);
    if (!folderTreeState.expanded.has(key)) {
      folderTreeState.expanded.set(key, {
        kind: 'folder', scope: root.scope, key, name: segments[i], path: acc,
        isOffline: root.isOffline, volumeSerial: root.volumeSerial, serialMode: root.serialMode,
      });
      changed = true;
    }
  }
  return changed;
}

/** 指定フォルダの行がツリー上に表示されているか */
function _ftIsVisible(path) {
  if (!elements.folderList) return false;
  const target = _ftNormPath(path);
  return Array.from(elements.folderList.querySelectorAll('.folder-tree-item'))
    .some(el => _ftNormPath(el.dataset.filterValue) === target);
}

/** フォルダ絞り込み時（プリセット適用など）に、そのフォルダまでツリーを開いて表示する */
function revealFolderInTree(path) {
  if (!path || !folderTreeState.roots || _ftIsVisible(path)) return;
  if (_ftExpandAncestors(path)) renderFolderTree();
}

/** 「展開」ボタン: 管理中のフォルダがすべて見えるところまで開く */
function expandFolderTreeToManaged() {
  if (!folderTreeState.roots) return;
  let changed = false;
  (state.rawFoldersData || []).forEach((f) => {
    if (f.status === 'managed' && f.count > 0 && f.directory_path) {
      if (_ftExpandAncestors(f.directory_path)) changed = true;
    }
  });
  if (changed) renderFolderTree();
}

/** 「閉じる」ボタン: すべて折りたたむ */
function collapseFolderTree() {
  folderTreeState.expanded.clear();
  renderFolderTree();
}

/* --------------------------------------------------------------------------
   スキャン進捗表示 ＆ スキャン実行（DOM非依存・グローバル進捗バー連動）
   -------------------------------------------------------------------------- */
let _ftScanPollTimer = null;
let _ftLastTreeRefreshTime = 0;
let _activeScanningPath = null;
let _inlineScanProgressEl = null;

/**
 * フォルダツリー内から指定パスに対応する .folder-tree-item 要素を探す
 */
function _ftFindItemByPath(folderPath) {
  if (!folderPath) return null;
  const targetNorm = _ftNormPath(folderPath);
  const items = document.querySelectorAll('#folderList .folder-tree-item');
  for (const it of items) {
    if (_ftNormPath(it.dataset.filterValue) === targetNorm) {
      return it;
    }
  }
  return null;
}

/**
 * インラインプログレス要素を取得または生成して対象ノードの直下に挿入する
 */
function _ftGetOrCreateInlineProgress(targetItem) {
  if (!_inlineScanProgressEl) {
    _inlineScanProgressEl = document.createElement('div');
    _inlineScanProgressEl.className = 'folder-inline-scan-progress';
    _inlineScanProgressEl.id = 'folderInlineScanProgress';
    _inlineScanProgressEl.innerHTML = `
      <div class="folder-inline-progress-header">
        <span class="folder-inline-progress-title">スキャン準備中...</span>
        <span class="folder-inline-progress-count"></span>
      </div>
      <div class="folder-inline-progress-track">
        <div class="folder-inline-progress-fill indeterminate"></div>
      </div>
      <div class="folder-inline-progress-filename"></div>
    `;
  }

  if (targetItem && targetItem.parentElement) {
    const parentLi = targetItem.parentElement; // li.folder-tree-node
    // item の直後（かつ子フォルダ ul の前）に挿入
    if (_inlineScanProgressEl.parentElement !== parentLi || targetItem.nextSibling !== _inlineScanProgressEl) {
      parentLi.insertBefore(_inlineScanProgressEl, targetItem.nextSibling);
    }
    _inlineScanProgressEl.style.display = 'block';
  }
  return _inlineScanProgressEl;
}

/**
 * インラインプログレス要素とスキャン対象ハイライトを解除する
 */
function _ftRemoveInlineScanProgress() {
  if (_inlineScanProgressEl && _inlineScanProgressEl.parentElement) {
    _inlineScanProgressEl.remove();
  }
  document.querySelectorAll('#folderList .is-scanning-target').forEach(el => {
    el.classList.remove('is-scanning-target');
  });
}

function _ftRenderScanProgress(status) {
  const card = elements.folderScanProgressCard;
  const banner = elements.globalScanBanner;

  if (!status || !status.is_scanning) {
    if (card) card.style.display = 'none';
    if (banner) banner.style.display = 'none';
    document.body.classList.remove('has-scan-banner');
    _ftRemoveInlineScanProgress();
    _activeScanningPath = null;
    return;
  }

  document.body.classList.add('has-scan-banner');

  // 1. 左ドロワー内カードの表示
  if (card) card.style.display = 'block';

  // 2. 画面最下部グローバルフッターの表示（全画面常時視認ステータスバー）
  if (banner) banner.style.display = 'flex';

  // 3. クリックしたフォルダの直下にインラインプログレスバーを直接表示 (v2.02 視線移動ゼロ)
  const scanFolder = status.folder_path || _activeScanningPath;
  const targetItem = _ftFindItemByPath(scanFolder);
  let inlineTitleEl = null;
  let inlineCountEl = null;
  let inlineFillEl = null;
  let inlineFileEl = null;

  if (targetItem) {
    targetItem.classList.add('is-scanning-target');
    const inlineEl = _ftGetOrCreateInlineProgress(targetItem);
    inlineTitleEl = inlineEl.querySelector('.folder-inline-progress-title');
    inlineCountEl = inlineEl.querySelector('.folder-inline-progress-count');
    inlineFillEl = inlineEl.querySelector('.folder-inline-progress-fill');
    inlineFileEl = inlineEl.querySelector('.folder-inline-progress-filename');
  } else {
    _ftRemoveInlineScanProgress();
  }

  if (status.phase === 'listing') {
    const listingText = '写真ファイルを検索中...';
    if (elements.folderScanProgressTitle) elements.folderScanProgressTitle.textContent = listingText;
    if (elements.folderScanProgressCount) elements.folderScanProgressCount.textContent = '';
    if (elements.folderScanProgressFill) elements.folderScanProgressFill.classList.add('indeterminate');
    if (elements.folderScanProgressCurrent) elements.folderScanProgressCurrent.textContent = status.folder_path || '';

    if (elements.globalScanTitle) elements.globalScanTitle.textContent = listingText;
    if (elements.globalScanCount) elements.globalScanCount.textContent = '';
    if (elements.globalScanFill) elements.globalScanFill.classList.add('indeterminate');
    if (elements.globalScanFilename) elements.globalScanFilename.textContent = status.folder_path || '';

    if (inlineTitleEl) inlineTitleEl.textContent = listingText;
    if (inlineCountEl) inlineCountEl.textContent = '';
    if (inlineFillEl) {
      inlineFillEl.classList.add('indeterminate');
      inlineFillEl.style.width = '50%';
    }
    if (inlineFileEl) inlineFileEl.textContent = status.folder_path || '';
  } else if (status.phase === 'stacks') {
    const stackText = '連写・露出グループ化中...';
    if (elements.folderScanProgressTitle) elements.folderScanProgressTitle.textContent = stackText;
    if (elements.folderScanProgressCount) elements.folderScanProgressCount.textContent = '';
    if (elements.folderScanProgressFill) elements.folderScanProgressFill.classList.add('indeterminate');
    if (elements.folderScanProgressCurrent) elements.folderScanProgressCurrent.textContent = '';

    if (elements.globalScanTitle) elements.globalScanTitle.textContent = stackText;
    if (elements.globalScanCount) elements.globalScanCount.textContent = '';
    if (elements.globalScanFill) elements.globalScanFill.classList.add('indeterminate');
    if (elements.globalScanFilename) elements.globalScanFilename.textContent = '';

    if (inlineTitleEl) inlineTitleEl.textContent = stackText;
    if (inlineCountEl) inlineCountEl.textContent = '';
    if (inlineFillEl) {
      inlineFillEl.classList.add('indeterminate');
      inlineFillEl.style.width = '50%';
    }
    if (inlineFileEl) inlineFileEl.textContent = '';
  } else {
    if (elements.folderScanProgressFill) elements.folderScanProgressFill.classList.remove('indeterminate');
    if (elements.globalScanFill) elements.globalScanFill.classList.remove('indeterminate');
    if (inlineFillEl) inlineFillEl.classList.remove('indeterminate');

    const total = status.total_files || 0;
    const current = (status.scanned !== undefined ? status.scanned : status.scanned_files) || 0;
    const pct = typeof status.percent === 'number' && status.percent >= 0
      ? status.percent
      : (total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0);
    const scanTitle = '写真スキャン中...';
    const countText = total > 0 ? `${current.toLocaleString()} / ${total.toLocaleString()} 枚 (${pct}%)` : `${current.toLocaleString()} 枚`;
    const fileName = status.current_file || '';

    // 左ドロワー内カード
    if (elements.folderScanProgressTitle) elements.folderScanProgressTitle.textContent = scanTitle;
    if (elements.folderScanProgressCount) elements.folderScanProgressCount.textContent = countText;
    if (elements.folderScanProgressFill) elements.folderScanProgressFill.style.width = `${pct}%`;
    if (elements.folderScanProgressCurrent) {
      elements.folderScanProgressCurrent.textContent = fileName;
      elements.folderScanProgressCurrent.title = fileName;
    }

    // 画面下部グローバルバナー
    if (elements.globalScanTitle) elements.globalScanTitle.textContent = scanTitle;
    if (elements.globalScanCount) elements.globalScanCount.textContent = countText;
    if (elements.globalScanFill) elements.globalScanFill.style.width = `${pct}%`;
    if (elements.globalScanFilename) {
      elements.globalScanFilename.textContent = fileName;
      elements.globalScanFilename.title = fileName;
    }

    // クリックフォルダ直下のインライン進捗バー
    if (inlineTitleEl) inlineTitleEl.textContent = scanTitle;
    if (inlineCountEl) inlineCountEl.textContent = countText;
    if (inlineFillEl) inlineFillEl.style.width = `${pct}%`;
    if (inlineFileEl) {
      inlineFileEl.textContent = fileName;
      inlineFileEl.title = fileName;
    }
  }
}

function _ftStartScanPolling() {
  _ftStopScanPolling();
  _ftLastTreeRefreshTime = Date.now();

  fetch('/api/scan/status')
    .then(r => r.ok ? r.json() : null)
    .then(s => { if (s && s.is_scanning) _ftRenderScanProgress(s); })
    .catch(() => {});

  _ftScanPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/scan/status');
      if (!res.ok) return;
      const status = await res.json();
      if (status.is_scanning) {
        _ftRenderScanProgress(status);

        // スキャン中、2秒ごとにフォルダツリー枚数をリアルタイム更新！
        const now = Date.now();
        if (now - _ftLastTreeRefreshTime >= 2000) {
          _ftLastTreeRefreshTime = now;
          refreshFolderTree();
        }
      } else {
        _ftStopScanPolling();
        _ftRenderScanProgress(null);
        refreshFolderTree();
      }
    } catch (_) {}
  }, 250);
}

function _ftStopScanPolling() {
  if (_ftScanPollTimer) {
    clearInterval(_ftScanPollTimer);
    _ftScanPollTimer = null;
  }
}

function _ftStartAiPolling() {
  if (typeof startAiProgressPolling === 'function') {
    startAiProgressPolling();
  } else if (typeof window.startAiProgressPolling === 'function') {
    window.startAiProgressPolling();
  }
}

/**
 * フォルダスキャン実行（共通）
 */
async function executeScan(folderPath, recursive = true, cleanupOrphans = false) {
  if (!folderPath) {
    showToast('フォルダパスが指定されていません', 'warning');
    return;
  }
  const autoAi = (localStorage.getItem('pm_auto_ai_tag') === 'true');

  if (elements.folderPathScanBtn) elements.folderPathScanBtn.disabled = true;

  // クリックしたフォルダの直下に即座にインライン進捗バーを先行表示 (0遅延フィードバック)
  _activeScanningPath = folderPath;
  const immediateItem = _ftFindItemByPath(folderPath);
  if (immediateItem) {
    immediateItem.classList.add('is-scanning-target');
    const inlineEl = _ftGetOrCreateInlineProgress(immediateItem);
    const titleEl = inlineEl.querySelector('.folder-inline-progress-title');
    const fillEl = inlineEl.querySelector('.folder-inline-progress-fill');
    if (titleEl) titleEl.textContent = 'スキャン準備中...';
    if (fillEl) fillEl.classList.add('indeterminate');
  }

  _ftStartScanPolling();

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder_path: folderPath,
        recursive: recursive,
        cleanup_orphans: cleanupOrphans,
        auto_ai_tag: autoAi,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'スキャンに失敗しました');
    }

    _ftStopScanPolling();

    // スキャン完了演出（1.8秒間完了を表示してフェードアウト）
    if (elements.globalScanTitle) elements.globalScanTitle.textContent = 'スキャン完了';
    if (elements.globalScanFill) elements.globalScanFill.style.width = '100%';
    if (_inlineScanProgressEl) {
      const inlineTitle = _inlineScanProgressEl.querySelector('.folder-inline-progress-title');
      const inlineFill = _inlineScanProgressEl.querySelector('.folder-inline-progress-fill');
      if (inlineTitle) inlineTitle.textContent = 'スキャン完了';
      if (inlineFill) {
        inlineFill.classList.remove('indeterminate');
        inlineFill.style.width = '100%';
      }
    }
    setTimeout(() => {
      _ftRenderScanProgress(null);
    }, 1800);

    if (elements.folderScanProgressCard) elements.folderScanProgressCard.style.display = 'none';

    const cleanedInfo = (data.result && data.result.cleaned > 0) ? ` / ${data.result.cleaned}枚 削除` : '';
    const scanned = data.result ? data.result.scanned : 0;
    const updated = data.result ? data.result.added_or_updated : 0;
    showToast(`スキャン完了: ${scanned}枚検出 (${updated}枚更新${cleanedInfo})`, 'success');

    await Promise.all([
      typeof refreshAll === 'function' ? refreshAll() : null,
      refreshFolderTree(),
    ]);

    if (autoAi) {
      _ftStartAiPolling();
    }
  } catch (err) {
    _ftStopScanPolling();
    _ftRenderScanProgress(null);
    if (elements.folderScanProgressCard) elements.folderScanProgressCard.style.display = 'none';
    showToast(`スキャンエラー: ${err.message}`, 'error');
  } finally {
    if (elements.folderPathScanBtn) elements.folderPathScanBtn.disabled = false;
  }
}
window.executeScan = executeScan;

/* --------------------------------------------------------------------------
   UI初期化（AI自動タグトグル / パス直接入力 / DBメンテナンスモーダル）
   -------------------------------------------------------------------------- */
function _ftInitAutoAiToggle() {
  const btn = elements.folderAutoAiToggleBtn;
  if (!btn) return;
  const isAuto = localStorage.getItem('pm_auto_ai_tag') === 'true';
  const updateUi = (on) => {
    btn.classList.toggle('active', on);
    btn.textContent = on ? 'AI: ON' : 'AI: OFF';
    btn.title = on
      ? 'スキャン完了後にAI自動タグ付けを実行します（クリックでOFF）'
      : 'スキャン完了後にAI自動タグ付けを実行しません（クリックでON）';
  };
  updateUi(isAuto);
  btn.addEventListener('click', () => {
    const current = localStorage.getItem('pm_auto_ai_tag') === 'true';
    const next = !current;
    localStorage.setItem('pm_auto_ai_tag', next ? 'true' : 'false');
    updateUi(next);
    showToast(next ? 'スキャン後のAI自動タグ付けを有効にしました' : 'スキャン後のAI自動タグ付けを無効にしました', 'info');
  });
}

function _ftInitPathInput() {
  const input = elements.folderPathInput;
  const btn = elements.folderPathScanBtn;
  if (!input || !btn) return;

  const doScanFromInput = () => {
    const raw = (input.value || '').trim();
    if (!raw) {
      showToast('フォルダのパスを入力してください', 'warning');
      input.focus();
      return;
    }
    // ドライブ直下の警告
    if (/^[a-zA-Z]:\\?$/.test(raw)) {
      if (!confirm(`「${raw}」はドライブ全体です。配下のすべてのサブフォルダをスキャンすると時間がかかる場合があります。\n\nスキャンを開始しますか？`)) {
        return;
      }
    }
    executeScan(raw, true, false);
  };

  btn.addEventListener('click', doScanFromInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doScanFromInput();
    }
  });
}

function _ftInitDbMaintenanceModal() {
  const openBtn = elements.folderDbMaintenanceBtn;
  const modal = elements.dbMaintenanceModal;
  const closeBtn = elements.closeDbMaintenanceModalBtn;
  const footerCloseBtn = elements.closeDbMaintenanceFooterBtn;
  if (!openBtn || !modal) return;

  const formatBytes = (bytes) => {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let b = Number(bytes);
    while (b >= 1024 && i < units.length - 1) {
      b /= 1024;
      i++;
    }
    return `${b.toFixed(1)} ${units[i]}`;
  };

  const loadStats = async () => {
    try {
      const res = await fetch('/api/database/stats');
      if (!res.ok) return;
      const data = await res.json();
      const stats = data.stats || data;
      if (elements.dbMaintPhotoCount) {
        elements.dbMaintPhotoCount.textContent = `${Number(stats.photo_count || 0).toLocaleString()} 枚`;
      }
      if (elements.dbMaintDbSize) {
        elements.dbMaintDbSize.textContent = stats.file_size_formatted || formatBytes(stats.file_size);
      }
      if (elements.dbMaintThumbCount) {
        elements.dbMaintThumbCount.textContent = `${Number(stats.thumbnail_count || 0).toLocaleString()} 件`;
      }
      if (elements.dbMaintWalSize) {
        const pct = stats.reclaimable_percent ? ` (${stats.reclaimable_percent}%)` : '';
        elements.dbMaintWalSize.textContent = `${stats.freelist_size_formatted || '0 B'}${pct}`;
      }
      if (elements.dbMaintBackupInfoText) {
        const bi = stats.backup_info;
        if (bi && bi.latest) {
          elements.dbMaintBackupInfoText.textContent = `最新: ${bi.latest.created_at_short || bi.latest.filename} (${bi.latest.size_formatted}) / 全${bi.count}世代保存中`;
        } else {
          elements.dbMaintBackupInfoText.textContent = 'バックアップ: まだ作成されていません';
        }
      }
    } catch (e) {
      console.error('DB統計の取得に失敗しました', e);
    }
  };

  // --- 右ペイン: タグツリーエディタ描画 & ドラッグ＆ドロップ階層変更 ---
  let draggedTagNode = null;

  const expandTagAncestorsInAllTrees = (fullTagPath) => {
    if (!fullTagPath) return;
    if (!state.settingsTagTreeExpandedPaths) state.settingsTagTreeExpandedPaths = new Set();
    if (!state.expandedTagPaths) state.expandedTagPaths = new Set();
    if (!state.inspectorQuickTreeExpandedPaths) state.inspectorQuickTreeExpandedPaths = new Set();
    const parts = fullTagPath.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      let cur = '';
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i];
        state.settingsTagTreeExpandedPaths.add(cur);
        state.expandedTagPaths.add(cur);
        state.inspectorQuickTreeExpandedPaths.add(cur);
      }
    }
  };

  const replaceTagPrefixInLocalPhotos = (oldPrefix, newPrefix) => {
    if (!Array.isArray(state.photos) || !oldPrefix) return;
    const newAncestors = [];
    if (newPrefix) {
      const parts = newPrefix.split('/').map(p => p.trim()).filter(Boolean);
      for (let i = 0; i < parts.length - 1; i++) {
        newAncestors.push(parts.slice(0, i + 1).join('/'));
      }
    }
    state.photos.forEach(p => {
      if (!Array.isArray(p.tags)) return;
      const hadMatch = p.tags.some(t => t === oldPrefix || t.startsWith(oldPrefix + '/'));
      if (!hadMatch) return;
      if (!newPrefix) {
        // 削除時
        p.tags = p.tags.filter(t => t !== oldPrefix && !t.startsWith(oldPrefix + '/'));
        if (Array.isArray(p.tag_details)) {
          p.tag_details = p.tag_details.filter(d => d.tag !== oldPrefix && !d.tag.startsWith(oldPrefix + '/'));
        }
      } else {
        // リネーム・移動時
        const nextTags = new Set();
        p.tags.forEach(t => {
          if (t === oldPrefix) nextTags.add(newPrefix);
          else if (t.startsWith(oldPrefix + '/')) nextTags.add(newPrefix + t.slice(oldPrefix.length));
          else nextTags.add(t);
        });
        newAncestors.forEach(anc => nextTags.add(anc));
        p.tags = Array.from(nextTags);

        if (Array.isArray(p.tag_details)) {
          const detailMap = new Map();
          p.tag_details.forEach(d => {
            let tName = d.tag;
            if (tName === oldPrefix) tName = newPrefix;
            else if (tName && tName.startsWith(oldPrefix + '/')) tName = newPrefix + tName.slice(oldPrefix.length);
            detailMap.set(tName, { ...d, tag: tName });
          });
          newAncestors.forEach(anc => {
            if (!detailMap.has(anc)) {
              detailMap.set(anc, { tag: anc, source: 'manual', confidence: 1.0 });
            }
          });
          p.tag_details = Array.from(detailMap.values());
        }
      }
    });
  };

  const syncAfterTagMutation = async (apiResponseData = null) => {
    // 1. APIレスポンスに最新タグ集計が含まれていれば0msで即時反映、なければ /api/tags を取得
    if (apiResponseData && Array.isArray(apiResponseData.tags) && typeof window.applyTagsSummaryData === 'function') {
      window.applyTagsSummaryData(apiResponseData);
    } else if (typeof fetchTags === 'function') {
      await fetchTags();
    }
    renderSettingsTagTreeEditor();
    if (typeof renderPhotoGrid === 'function') {
      renderPhotoGrid();
    }
    if (state.selectedPhotoIds && state.selectedPhotoIds.size > 1 && typeof showBatchInspector === 'function') {
      showBatchInspector();
    } else if (state.activeInspectorPhotoId && typeof showSingleInspector === 'function') {
      const p = state.photos.find(x => x.id === state.activeInspectorPhotoId);
      if (p) showSingleInspector(p);
    }

    // 2. 写真一覧のDB再取得はバックグラウンドで非同期に行い、UI操作を一切ブロックしない
    if (typeof fetchPhotos === 'function') {
      fetchPhotos().catch(err => console.warn('タグ変更後の背景写真同期エラー:', err));
    }
  };

  const executeTagMoveOrRename = async (oldFullPath, newFullPath, successMsg) => {
    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(oldFullPath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_tag: newFullPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'タグの更新に失敗しました');
      }
      // 移動先の親階層を全ツリー（設定・左サイドバー・右インスペクタ）で展開状態にする
      expandTagAncestorsInAllTrees(newFullPath);
      if (state.settingsTagTreeExpandedPaths && state.settingsTagTreeExpandedPaths.has(oldFullPath)) {
        state.settingsTagTreeExpandedPaths.delete(oldFullPath);
        state.settingsTagTreeExpandedPaths.add(newFullPath);
      }
      if (state.expandedTagPaths && state.expandedTagPaths.has(oldFullPath)) {
        state.expandedTagPaths.delete(oldFullPath);
        state.expandedTagPaths.add(newFullPath);
      }
      // 適用中フィルタに旧タグが含まれていれば新タグへ引き継ぐ
      if (state.tagFilters && state.tagFilters.size > 0) {
        for (const [k, mode] of Array.from(state.tagFilters.entries())) {
          if (k === oldFullPath) {
            state.tagFilters.delete(k);
            state.tagFilters.set(newFullPath, mode);
          } else if (k.startsWith(oldFullPath + '/')) {
            state.tagFilters.delete(k);
            state.tagFilters.set(newFullPath + k.slice(oldFullPath.length), mode);
          }
        }
      }
      replaceTagPrefixInLocalPhotos(oldFullPath, newFullPath);
      await syncAfterTagMutation(data);
      if (typeof fetchFilterPresets === 'function') {
        fetchFilterPresets().catch(() => {});
      }
      if (typeof showToast === 'function') {
        showToast(successMsg || `タグを「${newFullPath}」に更新しました`, 'success', 2600);
      }
      return true;
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast(`エラー: ${err.message}`, 'error', 3200);
      } else {
        alert('エラー: ' + err.message);
      }
      return false;
    }
  };

  const executeCreateNewTag = async (fullTag) => {
    const cleanTag = (fullTag || '').replace(/^\/+|\/+$/g, '').trim();
    if (!cleanTag) return false;
    try {
      const res = await fetch('/api/tags/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: cleanTag }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'タグの作成に失敗しました');
      }
      expandTagAncestorsInAllTrees(cleanTag);
      await syncAfterTagMutation(data);
      if (typeof showToast === 'function') {
        showToast(`タグ「${cleanTag}」を作成しました`, 'success', 2200);
      }
      return true;
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast(`エラー: ${err.message}`, 'error', 3000);
      }
      return false;
    }
  };

  function renderSettingsTagTreeEditor() {
    const container = elements.settingsTagTreeContainer || document.getElementById('settingsTagTreeContainer');
    if (!container) return;
    container.innerHTML = '';

    if (!state.settingsTagTreeExpandedPaths) {
      state.settingsTagTreeExpandedPaths = new Set();
    }

    const manualTags = (state.availableTags || []).filter(t => {
      const isAi = t.source === 'ai';
      const isColor = (typeof COLOR_TAG_MAP !== 'undefined') && ((t.tag || t.name) in COLOR_TAG_MAP);
      return !isAi && !isColor;
    });

    if (manualTags.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-hint';
      emptyEl.style.cssText = 'font-size:0.8rem; padding:16px 10px; text-align:center;';
      emptyEl.textContent = '手動タグはまだ登録されていません。下の入力欄から作成できます。';
      container.appendChild(emptyEl);
      return;
    }

    const settingsSortBtn = document.getElementById('settingsTagSortToggleBtn');
    if (settingsSortBtn) {
      const isCount = Boolean(state.settingsTagSortByCount);
      settingsSortBtn.classList.toggle('active', isCount);
      settingsSortBtn.setAttribute('aria-pressed', isCount ? 'true' : 'false');
      settingsSortBtn.textContent = isCount ? '枚数順' : '名前順';
      if (!settingsSortBtn.dataset.bound) {
        settingsSortBtn.dataset.bound = 'true';
        settingsSortBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.settingsTagSortByCount = !state.settingsTagSortByCount;
          renderSettingsTagTreeEditor();
        });
      }
    }

    const treeRoot = typeof buildTagTree === 'function' ? buildTagTree(manualTags, { sortByCount: Boolean(state.settingsTagSortByCount) }) : { children: new Map() };

    function appendInlineChildCreator(targetEl, parentFullPath, parentDisplayName, indent) {
      const addRow = document.createElement('div');
      addRow.className = 'inspector-tree-inline-add settings-tree-inline-add';
      addRow.style.paddingLeft = `${indent * 16 + 8}px`;
      addRow.innerHTML = `
        <div class="inspector-tree-inline-left">
          <span class="tree-toggle-spacer"></span>
          <input type="text" class="inspector-tree-inline-input" placeholder="${escapeHtml(parentDisplayName)} の子タグ名..." autocomplete="off">
        </div>
        <button type="button" class="apply-badge inspector-tree-inline-btn">+追加</button>
      `;
      const inputEl = addRow.querySelector('.inspector-tree-inline-input');
      const btnEl = addRow.querySelector('.inspector-tree-inline-btn');
      const submitChild = async () => {
        if (!inputEl) return;
        const val = inputEl.value.replace(/^\/+|\/+$/g, '').trim();
        if (!val) return;
        inputEl.value = '';
        await executeCreateNewTag(`${parentFullPath}/${val}`);
      };
      addRow.addEventListener('click', (e) => e.stopPropagation());
      if (btnEl) {
        btnEl.addEventListener('click', (e) => {
          e.stopPropagation();
          submitChild();
        });
      }
      if (inputEl) {
        inputEl.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            submitChild();
          }
        });
      }
      targetEl.appendChild(addRow);
    }

    function startSettingsInlineRename(itemEl, node) {
      const nameSpan = itemEl.querySelector('.inspector-tree-name');
      if (!nameSpan || itemEl.querySelector('.tag-rename-input')) return;

      const oldName = node.name;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tag-rename-input inspector-tag-rename-input';
      input.value = oldName;

      nameSpan.style.display = 'none';
      nameSpan.parentNode.insertBefore(input, nameSpan.nextSibling);
      input.focus();
      input.select();

      let committed = false;
      async function commitRename() {
        if (committed) return;
        committed = true;
        const newName = input.value.replace(/^\/+|\/+$/g, '').trim();
        if (!newName || newName === oldName) {
          input.remove();
          nameSpan.style.display = '';
          return;
        }
        const parts = node.fullPath.split('/');
        parts[parts.length - 1] = newName;
        const newFullPath = parts.join('/');
        const ok = await executeTagMoveOrRename(
          node.fullPath,
          newFullPath,
          `タグを「${newFullPath}」にリネームしました`
        );
        if (!ok) {
          input.remove();
          nameSpan.style.display = '';
        }
      }

      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename();
        } else if (e.key === 'Escape') {
          committed = true;
          input.remove();
          nameSpan.style.display = '';
        }
      });
      input.addEventListener('blur', () => {
        setTimeout(() => commitRename(), 100);
      });
      input.addEventListener('click', (e) => e.stopPropagation());
    }

    function appendEditorTreeNodes(parentNode, targetEl, indent = 0) {
      parentNode.children.forEach(node => {
        const nodeWrapper = document.createElement('div');
        nodeWrapper.className = 'inspector-tree-node settings-tag-tree-node';

        const hasChildren = node.children.size > 0;
        const isExpanded = state.settingsTagTreeExpandedPaths.has(node.fullPath);

        const item = document.createElement('div');
        item.className = 'inspector-tree-item settings-tag-tree-item';
        item.style.paddingLeft = `${indent * 16 + 8}px`;
        item.setAttribute('draggable', 'true');
        item.dataset.fullPath = node.fullPath;

        let toggleBtnHtml = '<span class="tree-toggle-spacer"></span>';
        if (hasChildren) {
          toggleBtnHtml = `<span class="tree-toggle-btn ${isExpanded ? '' : 'collapsed'}" title="${isExpanded ? '折りたたむ' : '展開する'}">▼</span>`;
        }
        const icon = hasChildren
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="10" y="10" width="7.5" height="7.5"/><line x1="3.6" y1="3.6" x2="10" y2="10"/><line x1="20.4" y1="3.6" x2="17.5" y2="10"/><line x1="20.4" y1="20.4" x2="17.5" y2="17.5"/><line x1="3.6" y1="20.4" x2="10" y2="17.5"/></svg>';
        const countVal = node.count || 0;
        const shortNameVal = (node.short_name || '').trim();
        const isPinnedVal = Boolean(node.is_pinned);
        const shortBadgeHtml = shortNameVal
          ? `<span class="settings-tag-short-badge" title="スマホ・クイック表示用の略称: ${escapeHtml(shortNameVal)}" style="font-size:0.68rem; color:var(--accent-primary); background:rgba(212,163,115,0.12); border:1px solid rgba(212,163,115,0.3); border-radius:4px; padding:0 5px; margin-left:4px; flex-shrink:0;">📱${escapeHtml(shortNameVal)}</span>`
          : '';
        const pinBtnStyle = isPinnedVal
          ? 'color:#f59e0b; border-color:rgba(245,158,11,0.45); background:rgba(245,158,11,0.12);'
          : '';

        item.innerHTML = `
          <div class="inspector-tree-item-left">
            <span class="settings-tag-drag-handle" title="ドラッグして他のタグ配下やルートへ移動">⋮⋮</span>
            ${toggleBtnHtml}
            <span style="flex-shrink:0; display:inline-flex; align-items:center;">${icon}</span>
            <span class="inspector-tree-name" title="${escapeHtml(node.fullPath)}${node.tag_key ? ' [' + escapeHtml(node.tag_key) + ']' : ''}">${escapeHtml(node.name)}</span>
            ${shortBadgeHtml}
            <span class="inspector-tree-count" title="付与されている写真枚数">${countVal}枚</span>
          </div>
          <div class="inspector-tree-item-actions settings-tag-item-actions">
            <button type="button" class="inspector-tag-edit-btn settings-tag-pin-btn${isPinnedVal ? ' active' : ''}" title="${isPinnedVal ? 'ピン留め解除（クイックタグから外す）' : 'ピン留め（インスペクタ・スマホの上部に常時表示）'}" style="${pinBtnStyle}">${isPinnedVal ? '★' : '☆'}</button>
            <button type="button" class="inspector-tag-edit-btn settings-tag-short-btn" title="スマホ・クイック表示用のショート名（略称）を設定">略称</button>
            <button type="button" class="inspector-tag-edit-btn settings-tag-subadd-btn" title="「${escapeHtml(node.name)}」の子タグを作成">+子</button>
            <button type="button" class="inspector-tag-edit-btn settings-tag-rename-btn" title="タグ「${escapeHtml(node.name)}」の名前を変更">編集</button>
            <button type="button" class="inspector-tag-edit-btn settings-tag-delete-btn" title="タグ「${escapeHtml(node.fullPath)}」をライブラリ全体から削除">削除</button>
          </div>
        `;

        nodeWrapper.appendChild(item);

        const childrenContainer = document.createElement('div');
        childrenContainer.className = `inspector-tree-children${(hasChildren && isExpanded) ? '' : ' hidden'}`;
        if (hasChildren) {
          appendEditorTreeNodes(node, childrenContainer, indent + 1);
        }
        appendInlineChildCreator(childrenContainer, node.fullPath, node.name, indent + 1);
        nodeWrapper.appendChild(childrenContainer);

        // --- Drag & Drop イベント ---
        item.addEventListener('dragstart', (e) => {
          if (e.target.closest('input, button')) {
            e.preventDefault();
            return;
          }
          draggedTagNode = { fullPath: node.fullPath, name: node.name };
          window._draggingTagNode = draggedTagNode;
          if (elements.dragDropOverlay) {
            elements.dragDropOverlay.style.display = 'none';
          }
          item.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', node.fullPath);
          }
          const rootZone = elements.settingsTagRootDropZone || document.getElementById('settingsTagRootDropZone');
          if (rootZone && node.fullPath.includes('/')) {
            rootZone.classList.add('drop-eligible');
          }
        });

        item.addEventListener('dragend', () => {
          item.classList.remove('dragging');
          draggedTagNode = null;
          window._draggingTagNode = null;
          container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
          const rootZone = elements.settingsTagRootDropZone || document.getElementById('settingsTagRootDropZone');
          if (rootZone) {
            rootZone.classList.remove('drop-eligible', 'drag-over');
          }
        });

        const getActiveDraggedNode = (e) => {
          if (draggedTagNode && draggedTagNode.fullPath) return draggedTagNode;
          if (window._draggingTagNode && window._draggingTagNode.fullPath) return window._draggingTagNode;
          const dtPath = e && e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
          if (dtPath) {
            const parts = dtPath.split('/');
            return { fullPath: dtPath, name: parts[parts.length - 1] };
          }
          return null;
        };

        const isValidDropTarget = (e) => {
          const activeSrc = getActiveDraggedNode(e);
          if (!activeSrc) return false;
          if (activeSrc.fullPath === node.fullPath) return false;
          // 自身の子孫へ移動するのは禁止
          if (node.fullPath.startsWith(activeSrc.fullPath + '/')) return false;
          // 既に直下の親である場合は不要
          const srcParent = activeSrc.fullPath.includes('/')
            ? activeSrc.fullPath.slice(0, activeSrc.fullPath.lastIndexOf('/'))
            : '';
          if (srcParent === node.fullPath) return false;
          return true;
        };

        item.addEventListener('dragover', (e) => {
          if (!isValidDropTarget(e)) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          item.classList.add('drag-over');
        });

        item.addEventListener('dragleave', () => {
          item.classList.remove('drag-over');
        });

        item.addEventListener('drop', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('drag-over');
          const src = getActiveDraggedNode(e);
          if (!src || !isValidDropTarget(e)) return;
          draggedTagNode = null;
          window._draggingTagNode = null;
          const newFullPath = `${node.fullPath}/${src.name}`;
          await executeTagMoveOrRename(
            src.fullPath,
            newFullPath,
            `タグ「${src.fullPath}」を「${newFullPath}」へ移動しました`
          );
        });

        // --- ボタン操作イベント ---
        const subAddBtn = item.querySelector('.settings-tag-subadd-btn');
        if (subAddBtn) {
          subAddBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            childrenContainer.classList.remove('hidden');
            state.settingsTagTreeExpandedPaths.add(node.fullPath);
            const toggleBtn = item.querySelector('.tree-toggle-btn');
            if (toggleBtn) toggleBtn.classList.remove('collapsed');
            const subInput = childrenContainer.querySelector(':scope > .inspector-tree-inline-add .inspector-tree-inline-input');
            if (subInput) setTimeout(() => subInput.focus(), 30);
          });
        }

        const pinBtn = item.querySelector('.settings-tag-pin-btn');
        if (pinBtn) {
          pinBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              const res = await fetch('/api/tags-meta', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  tag: node.fullPath,
                  tag_key: node.tag_key || null,
                  is_pinned: !Boolean(node.is_pinned),
                }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.detail || 'ピン留め設定の更新に失敗しました');
              await syncAfterTagMutation(data);
              if (typeof showToast === 'function') {
                showToast(
                  !node.is_pinned
                    ? `「${node.name}」をクイックタグにピン留めしました`
                    : `「${node.name}」のピン留めを解除しました`,
                  'info',
                  2000
                );
              }
            } catch (err) {
              if (typeof showToast === 'function') showToast(`エラー: ${err.message}`, 'error');
            }
          });
        }

        const shortBtn = item.querySelector('.settings-tag-short-btn');
        if (shortBtn) {
          shortBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (item.querySelector('.tag-short-input')) return;
            const leftDiv = item.querySelector('.inspector-tree-item-left');
            if (!leftDiv) return;
            const oldShort = (node.short_name || '').trim();
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'tag-rename-input inspector-tag-rename-input tag-short-input';
            input.placeholder = 'スマホ略称 (空で解除)';
            input.value = oldShort;
            input.style.maxWidth = '130px';
            leftDiv.appendChild(input);
            input.focus();
            input.select();

            let done = false;
            const commitShort = async () => {
              if (done) return;
              done = true;
              const nextShort = input.value.trim();
              input.remove();
              if (nextShort === oldShort) return;
              try {
                const res = await fetch('/api/tags-meta', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    tag: node.fullPath,
                    tag_key: node.tag_key || null,
                    short_name: nextShort,
                  }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || '略称の保存に失敗しました');
                await syncAfterTagMutation(data);
                if (typeof showToast === 'function') {
                  showToast(
                    nextShort
                      ? `「${node.name}」の略称を「${nextShort}」に設定しました`
                      : `「${node.name}」の略称を解除しました`,
                    'success',
                    2200
                  );
                }
              } catch (err) {
                if (typeof showToast === 'function') showToast(`エラー: ${err.message}`, 'error');
              }
            };
            input.addEventListener('keydown', (ke) => {
              ke.stopPropagation();
              if (ke.key === 'Enter') {
                ke.preventDefault();
                commitShort();
              } else if (ke.key === 'Escape') {
                done = true;
                input.remove();
              }
            });
            input.addEventListener('blur', () => setTimeout(commitShort, 100));
            input.addEventListener('click', (ce) => ce.stopPropagation());
          });
        }

        const renameBtn = item.querySelector('.settings-tag-rename-btn');
        if (renameBtn) {
          renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            startSettingsInlineRename(item, node);
          });
        }

        const deleteBtn = item.querySelector('.settings-tag-delete-btn');
        if (deleteBtn) {
          deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = typeof showDeleteTagModal === 'function'
              ? await showDeleteTagModal(node.fullPath, countVal)
              : confirm(`タグ「${node.fullPath}」（およびその子階層タグ）をすべての写真から完全に削除しますか？`);
            if (!confirmed) return;
            try {
              const res = await fetch(`/api/tags/${encodeURIComponent(node.fullPath)}`, {
                method: 'DELETE',
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.detail || 'タグ削除に失敗しました');
              }
              if (state.tagFilters) {
                for (const key of Array.from(state.tagFilters.keys())) {
                  if (key === node.fullPath || key.startsWith(node.fullPath + '/')) {
                    state.tagFilters.delete(key);
                  }
                }
              }
              state.settingsTagTreeExpandedPaths.delete(node.fullPath);
              replaceTagPrefixInLocalPhotos(node.fullPath, null);
              await syncAfterTagMutation(data);
              if (typeof showToast === 'function') {
                showToast(`タグ「${node.fullPath}」をライブラリ全体から削除しました`, 'info', 2500);
              }
            } catch (err) {
              if (typeof showToast === 'function') {
                showToast(`削除エラー: ${err.message}`, 'error');
              }
            }
          });
        }

        // 行クリックで展開・折りたたみ
        if (hasChildren) {
          item.addEventListener('click', (e) => {
            if (e.target.closest('.inspector-tree-item-actions') || e.target.closest('.tag-rename-input')) return;
            e.stopPropagation();
            const toggleBtn = item.querySelector('.tree-toggle-btn');
            const nowCollapsed = toggleBtn ? toggleBtn.classList.toggle('collapsed') : false;
            if (nowCollapsed) {
              state.settingsTagTreeExpandedPaths.delete(node.fullPath);
            } else {
              state.settingsTagTreeExpandedPaths.add(node.fullPath);
            }
            childrenContainer.classList.toggle('hidden', nowCollapsed);
            if (toggleBtn) {
              toggleBtn.title = nowCollapsed ? '展開する' : '折りたたむ';
            }
          });
        }

        targetEl.appendChild(nodeWrapper);
      });
    }

    appendEditorTreeNodes(treeRoot, container, 0);
  }
  window.renderSettingsTagTreeEditor = renderSettingsTagTreeEditor;

  // ルート階層へのドロップゾーン
  const rootDropZone = elements.settingsTagRootDropZone || document.getElementById('settingsTagRootDropZone');
  if (rootDropZone && !rootDropZone.dataset.bound) {
    rootDropZone.dataset.bound = 'true';
    rootDropZone.addEventListener('dragover', (e) => {
      const src = draggedTagNode || window._draggingTagNode;
      if (!src || !src.fullPath.includes('/')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      rootDropZone.classList.add('drag-over');
    });
    rootDropZone.addEventListener('dragleave', () => {
      rootDropZone.classList.remove('drag-over');
    });
    rootDropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      rootDropZone.classList.remove('drag-over', 'drop-eligible');
      let src = draggedTagNode || window._draggingTagNode;
      if (!src && e.dataTransfer) {
        const dtPath = e.dataTransfer.getData('text/plain');
        if (dtPath) {
          const parts = dtPath.split('/');
          src = { fullPath: dtPath, name: parts[parts.length - 1] };
        }
      }
      if (!src || !src.fullPath.includes('/')) return;
      draggedTagNode = null;
      window._draggingTagNode = null;
      const newFullPath = src.name;
      await executeTagMoveOrRename(
        src.fullPath,
        newFullPath,
        `タグ「${src.fullPath}」を最上位ルート「${newFullPath}」へ独立移動しました`
      );
    });
  }

  // 全展開 / 全折りたたみボタン
  const expandAllBtn = elements.settingsTagExpandAllBtn || document.getElementById('settingsTagExpandAllBtn');
  if (expandAllBtn && !expandAllBtn.dataset.bound) {
    expandAllBtn.dataset.bound = 'true';
    expandAllBtn.addEventListener('click', () => {
      if (!state.settingsTagTreeExpandedPaths) state.settingsTagTreeExpandedPaths = new Set();
      (state.availableTags || []).forEach(t => {
        const tagStr = t.tag || t.name || '';
        const parts = tagStr.split('/');
        if (parts.length > 1) {
          let cur = '';
          for (let i = 0; i < parts.length - 1; i++) {
            cur = cur ? `${cur}/${parts[i]}` : parts[i];
            state.settingsTagTreeExpandedPaths.add(cur);
          }
        }
      });
      renderSettingsTagTreeEditor();
    });
  }

  const collapseAllBtn = elements.settingsTagCollapseAllBtn || document.getElementById('settingsTagCollapseAllBtn');
  if (collapseAllBtn && !collapseAllBtn.dataset.bound) {
    collapseAllBtn.dataset.bound = 'true';
    collapseAllBtn.addEventListener('click', () => {
      if (state.settingsTagTreeExpandedPaths) state.settingsTagTreeExpandedPaths.clear();
      renderSettingsTagTreeEditor();
    });
  }

  // 下部ルート新規タグ追加フォーム
  const newRootInput = elements.settingsNewRootTagInput || document.getElementById('settingsNewRootTagInput');
  const addRootBtn = elements.settingsAddRootTagBtn || document.getElementById('settingsAddRootTagBtn');
  if (newRootInput && addRootBtn && !addRootBtn.dataset.bound) {
    addRootBtn.dataset.bound = 'true';
    const submitNewRoot = async () => {
      const val = (newRootInput.value || '').replace(/^\/+|\/+$/g, '').trim();
      if (!val) return;
      newRootInput.value = '';
      await executeCreateNewTag(val);
    };
    addRootBtn.addEventListener('click', submitNewRoot);
    newRootInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitNewRoot();
      }
    });
  }

  const openModal = () => {
    const themeSelect = document.getElementById('settingThemeSelect');
    if (themeSelect) {
      themeSelect.value = document.documentElement.getAttribute('data-scheme') || localStorage.getItem('pm_theme_scheme') || 'tetheract-d';
    }
    const winSelect = elements.settingStartupWindowModeSelect || document.getElementById('settingStartupWindowModeSelect');
    if (winSelect) {
      winSelect.value = localStorage.getItem('pm_startup_window_mode') || 'maximized';
      fetch('/api/window/settings')
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (d && d.startup_mode) {
            winSelect.value = d.startup_mode;
            localStorage.setItem('pm_startup_window_mode', d.startup_mode);
          }
        })
        .catch(() => {});
    }
    const sortSelect = elements.settingTagSortModeSelect || document.getElementById('settingTagSortModeSelect');
    if (sortSelect) {
      sortSelect.value = (state.tagSortMode && state.tagSortMode !== 'count_desc')
        ? state.tagSortMode
        : 'natural';
    }
    modal.style.display = 'flex';
    loadStats();
    renderSettingsTagTreeEditor();
    if (typeof fetchTags === 'function') {
      fetchTags();
    }
  };

  const closeModal = () => {
    modal.style.display = 'none';
  };

  const winSelectEl = elements.settingStartupWindowModeSelect || document.getElementById('settingStartupWindowModeSelect');
  if (winSelectEl && !winSelectEl.dataset.bound) {
    winSelectEl.dataset.bound = 'true';
    winSelectEl.value = localStorage.getItem('pm_startup_window_mode') || 'maximized';
    winSelectEl.addEventListener('change', async () => {
      const winMode = winSelectEl.value || 'maximized';
      localStorage.setItem('pm_startup_window_mode', winMode);
      if (typeof window.applyClientWindowMode === 'function') {
        window.applyClientWindowMode(winMode, true);
      }
      try {
        await fetch('/api/window/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startup_mode: winMode, apply_now: true }),
        });
        if (typeof showToast === 'function') {
          showToast('起動時のウィンドウサイズを保存・反映しました', 'success', 2200);
        }
      } catch (err) {
        if (typeof showToast === 'function') {
          showToast(`ウィンドウ設定エラー: ${err.message}`, 'error');
        }
      }
    });
  }

  const sortSelectEl = elements.settingTagSortModeSelect || document.getElementById('settingTagSortModeSelect');
  if (sortSelectEl && !sortSelectEl.dataset.bound) {
    sortSelectEl.dataset.bound = 'true';
    sortSelectEl.value = (state.tagSortMode && state.tagSortMode !== 'count_desc')
      ? state.tagSortMode
      : 'lexical';
    sortSelectEl.addEventListener('change', () => {
      const mode = sortSelectEl.value || 'natural';
      state.tagSortMode = mode;
      localStorage.setItem('pm_tag_sort_mode', mode);
      localStorage.setItem('pm_tag_sort_mode_v2', mode);
      state.tagSortByCount = false;
      localStorage.setItem('pm_tag_sort_by_count_v2', 'false');
      if (typeof renderTagList === 'function') {
        renderTagList();
      }
      renderSettingsTagTreeEditor();
      if (state.selectedPhotoIds && state.selectedPhotoIds.size > 1 && typeof showBatchInspector === 'function') {
        showBatchInspector();
      } else if (state.activeInspectorPhotoId && typeof showSingleInspector === 'function') {
        const p = state.photos.find(x => x.id === state.activeInspectorPhotoId);
        if (p) showSingleInspector(p);
      }
      if (typeof showToast === 'function') {
        showToast('タグツリーの名前順ルールを保存・反映しました', 'success', 2200);
      }
    });
  }

  openBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (footerCloseBtn) footerCloseBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // 最適化（VACUUM）ボタン
  if (elements.dbMaintVacuumBtn) {
    elements.dbMaintVacuumBtn.addEventListener('click', async () => {
      elements.dbMaintVacuumBtn.disabled = true;
      const originalText = elements.dbMaintVacuumBtn.textContent;
      elements.dbMaintVacuumBtn.textContent = '最適化中...';
      try {
        const res = await fetch('/api/database/vacuum', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '最適化に失敗しました');
        showToast('データベースの最適化（VACUUM）が完了しました', 'success');
        await loadStats();
      } catch (err) {
        showToast(`最適化エラー: ${err.message}`, 'error');
      } finally {
        elements.dbMaintVacuumBtn.disabled = false;
        elements.dbMaintVacuumBtn.textContent = originalText;
      }
    });
  }

  // バックアップ作成ボタン
  if (elements.dbMaintBackupBtn) {
    elements.dbMaintBackupBtn.addEventListener('click', async () => {
      elements.dbMaintBackupBtn.disabled = true;
      const originalText = elements.dbMaintBackupBtn.textContent;
      elements.dbMaintBackupBtn.textContent = '作成中...';
      try {
        const res = await fetch('/api/database/backup', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'バックアップ作成に失敗しました');
        showToast(`バックアップを作成しました (${data.filename || ''})`, 'success');
        await loadStats();
      } catch (err) {
        showToast(`バックアップエラー: ${err.message}`, 'error');
      } finally {
        elements.dbMaintBackupBtn.disabled = false;
        elements.dbMaintBackupBtn.textContent = originalText;
      }
    });
  }

  // バックアップフォルダを開くボタン
  if (elements.dbMaintOpenBackupDirBtn) {
    elements.dbMaintOpenBackupDirBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/database/open-backup-dir', { method: 'POST' });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || 'バックアップフォルダを開けませんでした');
        }
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }
}

function _ftCheckInitialScan() {
  fetch('/api/scan/status')
    .then(r => r.ok ? r.json() : null)
    .then(s => {
      if (s && s.is_scanning) {
        _ftStartScanPolling();
      }
    })
    .catch(() => {});
}

// DOMContentLoaded 時に初期化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    _ftInitAutoAiToggle();
    _ftInitPathInput();
    _ftInitDbMaintenanceModal();
    _ftCheckInitialScan();
  });
} else {
  _ftInitAutoAiToggle();
  _ftInitPathInput();
  _ftInitDbMaintenanceModal();
  _ftCheckInitialScan();
}
