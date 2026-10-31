/**
 * Photo Manager - コアオーケストレータ & メインビュー
 * 定数・state・elements・ヘルパー: /js/common.js
 * 複数選択・コンテキストメニュー:   /js/selection.js
 * インスペクター・EXIF・GPS:       /js/inspector.js
 * ライトボックス・ズーム・フィルム: /js/lightbox.js
 * スキャンモーダル・フォルダ探索:   /js/scanner_modal.js
 * フィルタプリセット:               /js/presets.js
 * スライドショー:                   /js/slideshow.js
 */

/**
 * 永続化されたユーザー表示設定の復元
 */
function initUserSettings() {
  // 1. ソート順
  const savedSort = localStorage.getItem('pm_sort_by');
  if (savedSort) {
    state.sortBy = savedSort;
    if (elements.sortBySelect) elements.sortBySelect.value = savedSort;
  }

  // 2. サムネイルサイズ
  const savedSize = localStorage.getItem('pm_thumbnail_size');
  if (savedSize) {
    if (elements.thumbnailSizeSlider) elements.thumbnailSizeSlider.value = savedSize;
    document.documentElement.style.setProperty('--thumbnail-size', `${savedSize}px`);
  }

  // 3. 表示レイアウトモード
  const savedViewMode = localStorage.getItem('pm_view_mode');
  if (savedViewMode && ['grid', 'masonry', 'mount'].includes(savedViewMode)) {
    setLayoutMode(savedViewMode);
  }

  // 4. 情報表示モード (クリーン表示)
  const savedMinimal = localStorage.getItem('pm_minimal_view');
  if (savedMinimal === 'true') {
    toggleMinimalView(true);
  }

  // 5. スタック表示
  const savedStacked = localStorage.getItem('pm_stacked');
  if (savedStacked !== null) {
    state.isStacked = savedStacked === 'true';
    if (elements.toggleStackBtn) {
      elements.toggleStackBtn.classList.toggle('active', state.isStacked);
    }
  }

  // 5.5 左ペイン（サイドバー）の開閉
  const savedSidebar = localStorage.getItem('pm_sidebar_open');
  const isSidebarOpen = savedSidebar !== null ? savedSidebar === 'true' : true;
  toggleSidebar(isSidebarOpen);

  // 6. 右ペイン（インスペクタ）の開閉
  const savedInspector = localStorage.getItem('pm_inspector_open');
  const isInspectorOpen = savedInspector !== null ? savedInspector === 'true' : true;
  toggleInspector(isInspectorOpen);

  // 7. タグ種別フィルタ (manual / ai / all) - デフォルトは 'manual'
  const savedTagSrc = localStorage.getItem('pm_tag_source_filter');
  if (savedTagSrc && ['manual', 'ai', 'all'].includes(savedTagSrc)) {
    state.tagSourceFilter = savedTagSrc;
  } else {
    state.tagSourceFilter = 'manual';
  }
  const segControl = document.getElementById('tagTypeSegmentedControl');
  if (segControl) {
    segControl.querySelectorAll('.tag-segment-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sourceFilter === state.tagSourceFilter);
    });
  }

  // 8. カラーフィルタエキスパンダの開閉状態復元 (デフォルトは閉じ: false)
  const savedColorExp = localStorage.getItem('pm_color_filter_expanded');
  const isColorExp = savedColorExp === 'true'; // 未設定は false (閉じ)
  toggleColorPaletteExpander(isColorExp);
}

/**
 * バージョン情報の取得と表示
 */

/**
 * 初期化処理
 */
async function initializeApp() {
  initTheme();
  initAppVersion();
  setupEventListeners();
  initUserSettings();
  initHeartbeat();
  await refreshAll();
}


/**
 * 実体パスとの紐付けが外れた（リンク消失）写真の件数を取得してバッジ更新
 */
async function fetchUnlinkedCount() {
  try {
    const res = await fetch('/api/photos/unlinked-count');
    if (!res.ok) return;
    const data = await res.json();
    const count = data.count || 0;

    // クイックアクセスのバッジ更新
    if (elements.unlinkedOnlyNavItem) {
      elements.unlinkedOnlyNavItem.style.display = count > 0 ? 'flex' : 'none';
    }
    if (elements.unlinkedPhotosCount) {
      elements.unlinkedPhotosCount.textContent = count;
      elements.unlinkedPhotosCount.style.display = count > 0 ? 'inline-block' : 'none';
    }

    // フォルダツリー下部のリンク情報なしナビ項目の更新
    if (elements.folderTreeUnlinkedSection) {
      elements.folderTreeUnlinkedSection.style.display = count > 0 ? 'block' : 'none';
    }
    if (elements.folderTreeUnlinkedCount) {
      elements.folderTreeUnlinkedCount.textContent = count;
    }
  } catch (err) {
    console.warn('[WARN] fetchUnlinkedCount エラー:', err);
  }
}
window.fetchUnlinkedCount = fetchUnlinkedCount;
window.fetchMissingCount = fetchUnlinkedCount; // 互換性エイリアス

/**
 * 重複写真（同一撮影日時＋サイズで他フォルダコピーあり）件数の取得とクイックアクセス表示更新
 */
async function fetchDuplicatesCount() {
  try {
    const res = await fetch('/api/photos/duplicates-count');
    if (!res.ok) return;
    const data = await res.json();
    const count = data.count || 0;

    if (elements.duplicatesOnlyNavItem) {
      elements.duplicatesOnlyNavItem.style.display = count > 0 ? 'flex' : 'none';
    }
    if (elements.duplicatePhotosCount) {
      elements.duplicatePhotosCount.textContent = count;
      elements.duplicatePhotosCount.style.display = count > 0 ? 'inline-block' : 'none';
    }
  } catch (err) {
    console.warn('[WARN] fetchDuplicatesCount エラー:', err);
  }
}
window.fetchDuplicatesCount = fetchDuplicatesCount;

/**
 * 全データの取得と画面更新
 */
async function refreshAll() {
  // 1. まずメイン画面の写真一覧とタグ（件数バッジ）を最優先で取得・描画し、
  //    起動直後のバックエンドGIL・ディスクI/O競合を回避して体感表示速度を最大化する
  await Promise.all([
    fetchPhotos(),
    fetchTags(),
  ]);

  // 2. 写真グリッドの初期描画完了後、サイドバーのフォルダツリー・タイムライン等を取得する
  await Promise.all([
    fetchTimeline(),
    fetchFolders(),
    fetchCameras(),
    fetchUnlinkedCount(),
    fetchDuplicatesCount(),
    (window.fetchFilterPresets ? window.fetchFilterPresets() : Promise.resolve()),
    (window.loadLocationTree ? window.loadLocationTree() : Promise.resolve()),
  ]);
}

/**
 * 写真一覧の取得 (タグの排他検索・複数年月OR・カメラ機種ORパラメータ対応)
 */
async function fetchPhotos() {
  try {
    const params = new URLSearchParams();
    if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
      params.append('folder', state.currentFilter.value);
    } else if (state.currentFilter.type === 'folder_exclude' && state.currentFilter.value) {
      params.append('exclude_folder', state.currentFilter.value);
    }
    
    if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
      params.append('year_months', Array.from(state.selectedYearMonths).join(','));
    } else if (state.currentFilter.type === 'year_month' && state.currentFilter.value) {
      params.append('year_month', state.currentFilter.value);
    }

    if (state.selectedDates && state.selectedDates.size > 0) {
      params.append('dates', Array.from(state.selectedDates).join(','));
    }

    // カメラ機種フィルタ（3ステート: 含む / 除外 ＋ 後方互換 selectedCameras）
    const includeCams = new Set();
    const excludeCams = new Set();
    if (state.cameraFilters && state.cameraFilters.size > 0) {
      state.cameraFilters.forEach((mode, cam) => {
        if (mode === 'include') includeCams.add(cam);
        else if (mode === 'exclude') excludeCams.add(cam);
      });
    }
    if (state.selectedCameras && state.selectedCameras.size > 0) {
      state.selectedCameras.forEach(cam => {
        if (!excludeCams.has(cam)) includeCams.add(cam);
      });
    }
    if (state.currentFilter.type === 'camera' && state.currentFilter.value) {
      includeCams.add(state.currentFilter.value);
    }
    if (includeCams.size > 0) {
      params.append('cameras', Array.from(includeCams).join(','));
    }
    if (excludeCams.size > 0) {
      params.append('excluded_cameras', Array.from(excludeCams).join(','));
    }

    // レンズフィルタ（3ステート: 含む / 除外）
    const includeLenses = new Set();
    const excludeLenses = new Set();
    if (state.lensFilters && state.lensFilters.size > 0) {
      state.lensFilters.forEach((mode, lensKey) => {
        if (mode === 'include') includeLenses.add(lensKey);
        else if (mode === 'exclude') excludeLenses.add(lensKey);
      });
    }
    if (state.selectedLenses && state.selectedLenses.size > 0) {
      state.selectedLenses.forEach(lensKey => {
        if (!excludeLenses.has(lensKey)) includeLenses.add(lensKey);
      });
    }
    if (includeLenses.size > 0) {
      params.append('lenses', Array.from(includeLenses).join(','));
    }
    if (excludeLenses.size > 0) {
      params.append('excluded_lenses', Array.from(excludeLenses).join(','));
    }

    // ラボ抽出フィルタ（太陽高度・手ブレ注意・歴代の今日・焦点距離帯・F値帯）
    if (state.labFilter) {
      params.append('lab_filter', state.labFilter);
    }
    if (state.onThisDay) {
      params.append('on_this_day', state.onThisDay);
    }
    if (state.focalRange) {
      params.append('focal_range', state.focalRange);
    }
    if (state.apertureRange) {
      params.append('aperture_range', state.apertureRange);
    }
    
    if (state.ratingFilter && state.ratingFilter.size > 0) {
      params.append('ratings', Array.from(state.ratingFilter).join(','));
    }

    if (state.attrFilter && state.attrFilter !== 'all') {
      params.append('attr_filter', state.attrFilter);
    }

    if (state.searchQuery.trim()) {
      params.append('search', state.searchQuery.trim());
    }

    // 場所フィルタ
    if (state.activeLocation) {
      if (state.activeLocation.no_location) {
        params.append('no_location', 'true');
      } else {
        if (state.activeLocation.country) params.append('country', state.activeLocation.country);
        if (state.activeLocation.state) params.append('state', state.activeLocation.state);
        if (state.activeLocation.city) params.append('city', state.activeLocation.city);
      }
    }

    // 未分類フィルタ
    if (state.untaggedOnly) {
      params.append('untagged', 'true');
    } else {
      // 3ステートタグ排他フィルタ（含む / 除外）
      const includeList = [];
      const excludeList = [];
      state.tagFilters.forEach((mode, tag) => {
        if (mode === 'include') includeList.push(tag);
        else if (mode === 'exclude') excludeList.push(tag);
      });

      if (includeList.length > 0) {
        params.append('include_tags', includeList.join(','));
        if (state.tagAndRoots && state.tagAndRoots.size > 0) {
          params.append('tag_and_roots', Array.from(state.tagAndRoots).join(','));
        }
        if (state.tagInterGroupMode === 'or') {
          params.append('tag_group_op', 'or');
        }
      }
      if (excludeList.length > 0) {
        params.append('exclude_tags', excludeList.join(','));
      }
    }

    params.append('sort_by', state.sortBy);
    params.append('stacked', state.isStacked ? 'true' : 'false');

    if (state.connectionFilter === 'missing') {
      params.append('missing_only', 'true');
    } else if (state.connectionFilter === 'unlinked') {
      params.append('unlinked_only', 'true');
    } else if (state.connectionFilter === 'duplicates') {
      params.append('duplicates_only', 'true');
    }

    const response = await fetch(`/api/photos?${params.toString()}`);

    if (!response.ok) throw new Error('写真の取得に失敗しました');
    const data = await response.json();

    // 接続状態フィルタ（接続中のみ / 未接続のみ / 見つからない写真 / リンク消失）
    if (state.connectionFilter === 'online') {
      state.photos = data.photos.filter(p => !p.is_offline && !p.is_missing && !p.is_unlinked);
    } else if (state.connectionFilter === 'offline') {
      state.photos = data.photos.filter(p => p.is_offline);
    } else if (state.connectionFilter === 'missing') {
      state.photos = data.photos.filter(p => p.is_missing);
    } else if (state.connectionFilter === 'unlinked') {
      state.photos = data.photos;
    } else {
      state.photos = data.photos;
    }
    state.isLimitReached = MAX_DISPLAY_PHOTOS > 0 && data.photos.length >= MAX_DISPLAY_PHOTOS;
    renderPhotoGrid();
    updateViewHeader();
    updateInspectorView();

    // リンク消失写真一括消去ボタンの表示切替
    if (elements.purgeUnlinkedBtn) {
      elements.purgeUnlinkedBtn.style.display = (state.connectionFilter === 'unlinked' && state.photos.length > 0) ? 'inline-flex' : 'none';
    }
  } catch (error) {
    console.error('写真読み込みエラー:', error);
  }
}

/**
 * タグ集計データを state および全関連UI（左ペイン・設定タグツリーエディタ・右インスペクタ）へ即時反映する
 */
function applyTagsSummaryData(data) {
  if (!data || !Array.isArray(data.tags)) return;
  state.availableTags = data.tags;
  if (elements.untaggedPhotosCount && data.untagged_count !== undefined) {
    elements.untaggedPhotosCount.textContent = data.untagged_count;
  }
  if (elements.totalPhotosCount && data.total_count !== undefined) {
    elements.totalPhotosCount.textContent = data.total_count;
  }
  renderTagList();

  // 設定＆タグツリーエディタが開いていれば即時再描画
  const settingsModal = elements.dbMaintenanceModal || document.getElementById('dbMaintenanceModal');
  if (settingsModal && settingsModal.style.display !== 'none' && typeof window.renderSettingsTagTreeEditor === 'function') {
    window.renderSettingsTagTreeEditor();
  }

  // 右インスペクタのクイックタグツリーも即時同期
  if (state.isInspectorOpen && typeof renderInspectorQuickTree === 'function') {
    if (state.selectedPhotoIds && state.selectedPhotoIds.size > 1 && elements.batchQuickTree && typeof batchToggleTag === 'function') {
      renderInspectorQuickTree(elements.batchQuickTree, (tName) => {
        batchToggleTag(tName, true);
      });
    } else if (state.activeInspectorPhotoId && elements.inspectorQuickTree && typeof addTagToPhoto === 'function') {
      const activePhoto = state.photos.find(p => p.id === state.activeInspectorPhotoId);
      if (activePhoto) {
        renderInspectorQuickTree(elements.inspectorQuickTree, (tName) => {
          addTagToPhoto(activePhoto.id, tName, activePhoto);
        });
      }
    }
  }
}
window.applyTagsSummaryData = applyTagsSummaryData;

/**
 * タグ一覧および未分類件数の取得と描画
 */
async function fetchTags() {
  try {
    const response = await fetch('/api/tags', { cache: 'no-store' });
    if (!response.ok) throw new Error('タグ一覧取得失敗');
    const data = await response.json();
    applyTagsSummaryData(data);
  } catch (error) {
    console.error('タグ読み込みエラー:', error);
  }
}
window.fetchTags = fetchTags;
window.fetchPhotos = fetchPhotos;
window.loadPhotos = fetchPhotos;

/**
 * タイムライン情報の取得と描画
 */
async function fetchTimeline() {
  try {
    if (typeof window.fetchCalendarSummary === 'function') {
      window.fetchCalendarSummary();
    }
    const response = await fetch('/api/timeline');
    if (!response.ok) throw new Error('タイムライン取得失敗');
    const data = await response.json();
    renderTimeline(data.timeline);
  } catch (error) {
    console.error('タイムライン取得エラー:', error);
  }
}

/**
 * フォルダ一覧の取得と描画
 * ツリー表示は folder_tree.js（/api/folder-tree）が担う。/api/folders の結果は
 * 未接続警告バナー・空状態表示・「展開」ボタン用に state.rawFoldersData へ保持する。
 */
async function fetchFolders() {
  const loadFolderSummary = async () => {
    try {
      const response = await fetch('/api/folders');
      if (!response.ok) throw new Error('フォルダ一覧取得失敗');
      const data = await response.json();
      state.rawFoldersData = data.folders || [];
    } catch (error) {
      console.error('フォルダ取得エラー:', error);
    }
  };
  await Promise.all([loadFolderSummary(), refreshFolderTree()]);
}


// グリッドの段階的チャンク描画状態（現在DOMに生成済みのカード枚数）
let renderedGridCount = 0;
let renderGridTaskId = null;
let _gridScrollListenerBound = false;

/**
 * サムネイル画像のロード完了時にアスペクト比を自動補正
 * ブラウザが実際にデコードした実寸法（naturalWidth / naturalHeight）はExif回転・クロップ適用済みの絶対値であるため、
 * DB寸法と万一差異があった場合でも常に正確なアスペクト比へ同期する。
 */
function onThumbImageLoad(img) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  const card = img.closest('.photo-card');
  if (!card) return;
  const isPort = img.naturalHeight > img.naturalWidth;
  const ratio = Math.max(0.2, Math.min(5.0, img.naturalWidth / img.naturalHeight));
  card.classList.toggle('is-portrait', isPort);
  card.classList.toggle('is-landscape', !isPort);
  card.style.setProperty('--photo-aspect', `${img.naturalWidth} / ${img.naturalHeight}`);
  card.style.setProperty('--photo-aspect-ratio', ratio.toFixed(4));
}
window.onThumbImageLoad = onThumbImageLoad;

/**
 * 写真カードのDOM要素を生成する（イベントリスナーは委譲するため一切登録しない軽量・高速版）
 */
function createPhotoCard(photo, index) {
  const card = document.createElement('div');
  card.className = 'photo-card';
  card.dataset.photoId = photo.id;
  card.draggable = true;
  card.dataset.index = index;

  // DBメタデータ（サムネイル寸法・元寸法・回転・クロップ）から正確なプレースホルダ縦横比を事前設定
  const aspectInfo = (typeof getPhotoAspectInfo === 'function')
    ? getPhotoAspectInfo(photo)
    : { isPortrait: false, aspectCss: '3 / 2', aspectRatio: '1.5000' };
  card.classList.add(aspectInfo.isPortrait ? 'is-portrait' : 'is-landscape');
  card.style.setProperty('--photo-aspect', aspectInfo.aspectCss);
  card.style.setProperty('--photo-aspect-ratio', aspectInfo.aspectRatio);

  if (state.selectedPhotoIds.has(photo.id)) {
    card.classList.add('selected');
  }

  // オフライン写真はカード全体をデサチュレーション表示（テキストバッジ不要）
  if (photo.is_offline) {
    card.classList.add('is-offline');
    const volName = photo.volume_label ? `（ボリューム: ${photo.volume_label}）` : '';
    card.title = `元ファイルが未接続です${volName} — サムネイルプレビューで表示中`;
  }

  // 棄の写真はサムネイルを薄暗く表示
  if (photo.rating === -1) {
    card.classList.add('is-discarded');
  }

  // 重複写真（他フォルダにコピーあり）判定
  const hasDuplicates = Boolean(photo.duplicate_count && photo.duplicate_count > 1);
  if (hasDuplicates) {
    card.classList.add('has-duplicate');
  }

  // 評価アイコンオーバーレイの生成
  let ratingIconHtml = '';
  if (photo.rating === 2) {
    ratingIconHtml = '<span class="card-rating-icon rating-excellent">優</span>';
  } else if (photo.rating === 1) {
    ratingIconHtml = '<span class="card-rating-icon rating-good">良</span>';
  } else if (photo.rating === -1) {
    ratingIconHtml = '<span class="card-rating-icon rating-discard">棄</span>';
  }

  // ホバー時評価バーの生成
  const ratingBarHtml = `
    <div class="card-rating-bar">
      <span class="card-rating-bar-btn${photo.rating === 2 ? ' active' : ''}" data-rating="2">優</span>
      <span class="card-rating-bar-btn${photo.rating === 1 ? ' active' : ''}" data-rating="1">良</span>
      <span class="card-rating-bar-btn${photo.rating === -1 ? ' active' : ''}" data-rating="-1">棄</span>
    </div>
  `;

  const dateFormatted = photo.date_taken ? photo.date_taken.substring(0, 10) : '日付不明';

  // タグバッジHTML (サムネイルギャラリーの情報パネルにはAIタグを表示せず、手動タグのみ表示)
  let tagsHtml = '';
  const detailsMap = {};
  if (photo.tag_details) {
    photo.tag_details.forEach(d => { detailsMap[d.tag] = d; });
  }
  const manualLeafTags = getLeafTags(photo.tags).filter(t => {
    const detail = detailsMap[t];
    return !(detail && detail.source === 'ai');
  });

  if (manualLeafTags.length > 0) {
    tagsHtml = '<div class="card-tags">' +
      manualLeafTags.slice(0, 3).map(t => {
        const colorConf = COLOR_TAG_MAP[t];
        const colorDot = colorConf ? `<span class="tag-color-dot" style="background:${colorConf.color};"></span>` : '';
        return `<span class="card-tag-badge">${colorDot}${escapeHtml(t)}</span>`;
      }).join('') +
      (manualLeafTags.length > 3 ? `<span class="card-tag-badge">+${manualLeafTags.length - 3}</span>` : '') +
      '</div>';
  }

  // フォーマットバッジHTML (RAW / RAW+JPG)
  let formatBadgeHtml = '';
  const hasRawPair = Boolean(photo.paired_raw_path || (photo.stack_photos && photo.stack_photos.some(sp => sp.is_raw)));
  if (hasRawPair) {
    formatBadgeHtml = `<span class="format-badge raw-jpg-badge" title="RAW+JPEGペア写真">RAW+JPG</span>`;
  } else if (photo.is_raw) {
    const rawFmt = (photo.raw_format || 'RAW').toUpperCase().replace('.', '');
    formatBadgeHtml = `<span class="format-badge raw-badge" title="RAW画像 (${rawFmt})">${rawFmt}</span>`;
  }

  // スタックバッジHTML (ブラケット / 連写 / 重複)
  let stackBadgeHtml = '';
  if (state.isStacked && photo.stack_count > 1) {
    if (photo.stack_type === 'duplicate') {
      stackBadgeHtml = `<span class="stack-badge stack-badge-dup" data-photo-id="${photo.id}" title="重複写真 ${photo.stack_count}枚 (他フォルダにコピーあり・クリックで一覧表示)">重複 ${photo.stack_count}</span>`;
    } else {
      const bktType = photo.stack_type === 'burst' ? 'BURST' : 'BKT';
      const isWithRaw = hasRawPair ? ' (RAW+JPG)' : '';
      stackBadgeHtml = `<span class="stack-badge" data-photo-id="${photo.id}" title="グループ ${photo.stack_count}枚${isWithRaw} (クリックで露出一覧を表示)">${bktType} ${photo.stack_count}</span>`;
    }
  }

  // スライドマウント用の上部・下部スタンプ（上段: 機種名・日付 / 下段: ファイル名・BKTバッジ・RAWバッジ）
  const cameraLabel = (photo.camera_model || '35mm SLIDE').trim();
  const mountTopHtml = `
    <div class="card-mount-top">
      <div class="mount-stamp-left">
        <span class="mount-stamp-brand" title="${escapeHtml(cameraLabel)}">${escapeHtml(cameraLabel)}</span>
      </div>
      <span class="card-date">${dateFormatted}</span>
    </div>
  `;
  const mountBottomHtml = `
    <div class="card-mount-bottom">
      <div class="mount-stamp-left">
        <span class="card-filename" title="${escapeHtml(photo.file_name)}">${escapeHtml(photo.file_name)}</span>
        ${stackBadgeHtml}
      </div>
      ${formatBadgeHtml}
    </div>
  `;

  card.innerHTML = `
    ${mountTopHtml}
    <div class="card-thumb-wrapper">
      <div class="card-select-checkbox" title="選択 (Ctrl/Shiftクリック対応)">✓</div>
      ${hasDuplicates ? `<div class="thumb-corner-cut" title="他フォルダに重複コピーあり (計 ${photo.duplicate_count} 箇所)"></div>` : ''}
      ${formatBadgeHtml}
      <img class="card-thumb-img" src="${getThumbnailUrl(photo)}" alt="${escapeHtml(photo.file_name)}" loading="lazy" onload="onThumbImageLoad(this)">
      <div class="card-rating-overlay">
        ${ratingIconHtml}
      </div>
      ${ratingBarHtml}
    </div>
    ${mountBottomHtml}
    <div class="card-info">
      <div class="card-title-row">
        <div class="card-filename" title="${escapeHtml(photo.file_name)}">${escapeHtml(photo.file_name)}</div>
      </div>
      <div class="card-meta">
        <div class="card-meta-left">
          ${stackBadgeHtml}
        </div>
        <div class="card-meta-right">
          <span class="card-date">${dateFormatted}</span>
          <span class="card-camera">${escapeHtml(photo.camera_model || '')}</span>
        </div>
      </div>
      ${tagsHtml}
    </div>
  `;

  return card;
}

/**
 * 選択中フォルダの未接続（消失・ドライブ切断）警告バナーを更新する
 */
function updateFolderWarningBanner() {
  if (!elements.folderWarningBanner) return;

  if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
    const curNorm = state.currentFilter.value.replace(/\\/g, '/').toLowerCase();
    const matched = (state.rawFoldersData || []).find(f => (f.directory_path || '').replace(/\\/g, '/').toLowerCase() === curNorm);
    if (matched && matched.is_missing) {
      if (elements.warningBannerDesc) {
        elements.warningBannerDesc.textContent = `実フォルダ（${state.currentFilter.value}）が存在しないか、ドライブが未接続です。（保存済みサムネイルをキャッシュから表示中）`;
      }
      elements.folderWarningBanner.style.display = 'flex';
      return;
    }
  }
  elements.folderWarningBanner.style.display = 'none';
}

const GRID_INITIAL_CHUNK = 200;
const GRID_CHUNK_SIZE = 200;

/**
 * 未描画の写真カードチャンクを指定インデックス（または1チャンク分）までDOMに追加する
 */
function appendPhotoGridChunk(targetCount = null) {
  const total = state.photos.length;
  if (renderedGridCount >= total || !elements.photoGrid) return;

  const nextEnd = targetCount !== null
    ? Math.min(Math.max(renderedGridCount + GRID_CHUNK_SIZE, targetCount), total)
    : Math.min(renderedGridCount + GRID_CHUNK_SIZE, total);

  const fragment = document.createDocumentFragment();
  for (let i = renderedGridCount; i < nextEnd; i++) {
    fragment.appendChild(createPhotoCard(state.photos[i], i));
  }
  elements.photoGrid.appendChild(fragment);
  renderedGridCount = nextEnd;
}

/**
 * 指定したインデックスの写真カードがDOM上に確実に存在するようチャンクを描画する
 */
function ensureCardsRenderedUpTo(targetIndex) {
  if (targetIndex >= renderedGridCount && renderedGridCount < state.photos.length) {
    appendPhotoGridChunk(targetIndex + 1);
  }
}
window.ensureCardsRenderedUpTo = ensureCardsRenderedUpTo;

/**
 * スクロール位置やコンテナ高さに応じて、下端余白が近づいていれば次チャンクを自動追加する
 */
function checkAndAppendGridChunksIfNeeded() {
  if (renderedGridCount >= state.photos.length || !elements.photoGrid) return;
  const container = elements.photoGrid.parentElement;
  if (!container) return;

  // 下端から 900px 以内に近づいた場合、または画面内にまだ余裕がある場合に次チャンクを追加
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 900) {
    appendPhotoGridChunk();
    // 大画面・極小サムネイル時に1チャンクではまだ画面が埋まらない場合は次フレームで継続チェック
    if (renderedGridCount < state.photos.length && container.scrollHeight <= container.clientHeight + 600) {
      if (renderGridTaskId) cancelAnimationFrame(renderGridTaskId);
      renderGridTaskId = requestAnimationFrame(() => {
        renderGridTaskId = null;
        checkAndAppendGridChunksIfNeeded();
      });
    }
  }
}

/**
 * 写真グリッドの描画（初期200枚を即座に表示し、以降はスクロールに連動して段階的にチャンク追加）
 */
function renderPhotoGrid() {
  // 進行中のバックグラウンド描画があればキャンセル
  if (renderGridTaskId) {
    cancelAnimationFrame(renderGridTaskId);
    renderGridTaskId = null;
  }

  // スクロールコンテナへのイベント登録（初回のみ）
  if (!_gridScrollListenerBound && elements.photoGrid && elements.photoGrid.parentElement) {
    _gridScrollListenerBound = true;
    elements.photoGrid.parentElement.addEventListener('scroll', () => {
      checkAndAppendGridChunksIfNeeded();
    }, { passive: true });
    window.addEventListener('resize', () => {
      checkAndAppendGridChunksIfNeeded();
    }, { passive: true });
  }

  // 選択中フォルダの未接続警告バナーの更新
  updateFolderWarningBanner();

  // 画面外となった写真（フィルタ等で除外された写真）の選択IDを自動クリーンアップ
  if (state.selectedPhotoIds.size > 0) {
    const currentIdSet = new Set(state.photos.map(p => p.id));
    let hasRemoved = false;
    state.selectedPhotoIds.forEach(id => {
      if (!currentIdSet.has(id)) {
        state.selectedPhotoIds.delete(id);
        hasRemoved = true;
      }
    });
    if (hasRemoved) {
      updateCardSelectionClasses();
      updateSelectionUI();
    }
  }

  elements.photoGrid.innerHTML = '';
  renderedGridCount = 0;
  // 再生成されるカードは createPhotoCard で現在の選択状態を反映するため、差分基準も現在の選択集合に同期
  lastSelectedPhotoIds = new Set(state.selectedPhotoIds);

  if (state.photos.length === 0) {
    if (elements.emptyState) {
      const titleEl = elements.emptyState.querySelector('h2');
      const descEl = elements.emptyState.querySelector('p');
      const iconEl = elements.emptyState.querySelector('.empty-icon');

      if (state.currentFilter.type === 'folder' && state.currentFilter.value) {
        const curNorm = state.currentFilter.value.replace(/\\/g, '/').toLowerCase();
        const matched = (state.rawFoldersData || []).find(f => (f.directory_path || '').replace(/\\/g, '/').toLowerCase() === curNorm);
        const folderStatus = matched ? matched.status : 'managed';
        const isFolderMissing = matched ? !!matched.is_missing : false;

        if (isFolderMissing) {
          if (iconEl) iconEl.textContent = '!';
          if (titleEl) titleEl.textContent = '実フォルダが見つかりません（未接続）';
          if (descEl) descEl.textContent = `実フォルダ（${state.currentFilter.value}）が存在しないか、ドライブが未接続です。ドライブの接続状態を確認してください。`;
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '接続を再確認';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              showToast('ドライブ・フォルダの接続状態を確認中...', 'info');
              await fetchFolders();
              await fetchPhotos();
              showToast('接続状態を更新しました', 'success');
            };
          }
        } else if (folderStatus === 'unmanaged') {
          if (iconEl) iconEl.textContent = '';
          if (titleEl) titleEl.textContent = 'このフォルダはライブラリ未登録です';
          if (descEl) descEl.textContent = '実ディスク上に存在する未登録フォルダです。「管理に追加」を押すと写真をスキャンしてライブラリに登録します。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '管理に追加してスキャン';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              showToast(`「${state.currentFilter.value}」を管理に追加・スキャン中...`, 'info');
              await executeScan(state.currentFilter.value, false, false);
            };
          }
        } else if (folderStatus === 'ignored') {
          if (iconEl) iconEl.textContent = '';
          if (titleEl) titleEl.textContent = 'このフォルダは管理対象外（除外設定中）です';
          if (descEl) descEl.textContent = '自動スキャンの対象から除外されています。「除外を解除」を押すと未登録状態に戻せます。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = '除外を解除する';
            elements.emptyStateActionBtn.onclick = async (e) => {
              e.stopPropagation();
              try {
                const res = await fetch('/api/folders/ignore', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ folder_path: state.currentFilter.value }),
                });
                if (res.ok) {
                  showToast('除外を解除しました', 'success');
                  await refreshAll();
                }
              } catch (err) {
                showToast(`エラー: ${err.message}`, 'error');
              }
            };
          }
        } else {
          if (iconEl) iconEl.textContent = '';
          if (titleEl) titleEl.textContent = '写真が見つかりません';
          if (descEl) descEl.textContent = '指定された条件の写真がないか、まだスキャンされていません。';
          if (elements.emptyStateActionBtn) {
            elements.emptyStateActionBtn.textContent = 'フォルダ一覧を開く';
            elements.emptyStateActionBtn.onclick = () => {
              if (window.openSidebarSection) window.openSidebarSection('folder');
            };
          }
        }
      } else {
        if (iconEl) iconEl.textContent = '';
        if (titleEl) titleEl.textContent = '写真が見つかりません';
        if (descEl) descEl.textContent = '指定された条件の写真がないか、まだスキャンされていません。';
        if (elements.emptyStateActionBtn) {
          elements.emptyStateActionBtn.textContent = 'フォルダ一覧を開く';
          elements.emptyStateActionBtn.onclick = () => {
            if (window.openSidebarSection) window.openSidebarSection('folder');
          };
        }
      }

      elements.emptyState.style.display = 'flex';
    }
    updateSelectionUI();
    return;
  }

  elements.emptyState.style.display = 'none';

  // 初期表示チャンク（先頭200枚）を即座に同期描画
  appendPhotoGridChunk(GRID_INITIAL_CHUNK);
  updateSelectionUI();

  // 大画面・極小サムネイル等でさらに画面内に入る余地がある場合は次フレームで補完
  if (renderedGridCount < state.photos.length) {
    renderGridTaskId = requestAnimationFrame(() => {
      renderGridTaskId = null;
      checkAndAppendGridChunksIfNeeded();
    });
  }
}

/**
 * フローティング・フィルタ条件変更ポップオーバーの状態管理
 */
let _nlPopoverState = {
  key: null,
  anchorEl: null,
  globalBound: false,
};

function closeNlFilterPopover() {
  const pop = document.getElementById('nlFilterPopover');
  if (pop) {
    pop.style.display = 'none';
    pop.innerHTML = '';
  }
  _nlPopoverState.key = null;
  _nlPopoverState.anchorEl = null;
}
window.closeNlFilterPopover = closeNlFilterPopover;

function _ensureNlPopoverGlobalListeners() {
  if (_nlPopoverState.globalBound) return;
  _nlPopoverState.globalBound = true;

  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('nlFilterPopover');
    if (!pop || pop.style.display === 'none') return;
    if (pop.contains(e.target)) return;
    if (e.target.closest('#viewHeaderChipBar')) return;
    closeNlFilterPopover();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const pop = document.getElementById('nlFilterPopover');
      if (pop && pop.style.display !== 'none') {
        e.stopPropagation();
        closeNlFilterPopover();
      }
    }
  }, true);
}

function _positionNlPopover(anchorEl) {
  const pop = document.getElementById('nlFilterPopover');
  const contentArea = document.querySelector('.content-area');
  if (!pop || !contentArea) return;

  pop.style.left = '50%';
  pop.style.transform = 'translateX(-50%)';

  if (!anchorEl || !anchorEl.getBoundingClientRect) return;
  requestAnimationFrame(() => {
    if (pop.style.display === 'none') return;
    const areaRect = contentArea.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const footerEl = document.getElementById('viewHeaderChipBar');
    const footerRect = footerEl ? footerEl.getBoundingClientRect() : null;

    if (areaRect.width <= 0) return;
    const desiredCenterX = (anchorRect.left + anchorRect.width / 2) - areaRect.left;
    const halfPop = popRect.width / 2;
    const minCenter = halfPop + 12;
    const maxCenter = Math.max(minCenter, areaRect.width - halfPop - 12);
    const clampedCenter = Math.max(minCenter, Math.min(maxCenter, desiredCenterX));
    pop.style.left = `${Math.round(clampedCenter)}px`;
    pop.style.transform = 'translateX(-50%)';

    if (footerRect && footerRect.height > 0) {
      const bottomOffset = Math.max(58, Math.round(areaRect.bottom - footerRect.top + 8));
      pop.style.bottom = `${bottomOffset}px`;
    } else {
      pop.style.bottom = '62px';
    }
  });
}

function openNlFilterPopover(key, anchorEl, builderFn) {
  _ensureNlPopoverGlobalListeners();
  const pop = document.getElementById('nlFilterPopover');
  if (!pop) return;

  if (_nlPopoverState.key === key && pop.style.display !== 'none') {
    closeNlFilterPopover();
    return;
  }

  _nlPopoverState.key = key;
  _nlPopoverState.anchorEl = anchorEl;
  pop.innerHTML = '';
  builderFn(pop);
  pop.style.display = 'flex';
  _positionNlPopover(anchorEl);
}

/**
 * タグフィルタのモードを直接指定して更新するヘルパー ('include' | 'exclude' | null)
 */
function setTagFilterModeDirect(tagPath, mode) {
  if (!tagPath) return;
  state.untaggedOnly = false;
  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');

  const isColor = typeof COLOR_TAG_MAP !== 'undefined' && (tagPath in COLOR_TAG_MAP);
  if (isColor) {
    Object.keys(COLOR_TAG_MAP).forEach(cName => state.tagFilters.delete(cName));
    if (mode === 'include' || mode === 'exclude') {
      state.tagFilters.set(tagPath, mode);
    }
  } else {
    if (mode === 'include' || mode === 'exclude') {
      state.tagFilters.set(tagPath, mode);
      if (typeof expandTagAncestors === 'function') expandTagAncestors(tagPath);
    } else {
      state.tagFilters.delete(tagPath);
    }
  }
  if (state.tagFilters.size === 0) {
    if (state.tagAndRoots) state.tagAndRoots.clear();
    state.tagInterGroupMode = 'and';
  }
  if (typeof renderTagList === 'function') renderTagList();
  fetchPhotos();
}

/**
 * カメラフィルタのモードを直接指定して更新するヘルパー ('include' | 'exclude' | null)
 */
function setCameraFilterModeDirect(camModel, mode) {
  if (!camModel) return;
  if (!state.cameraFilters) state.cameraFilters = new Map();
  if (mode === 'include' || mode === 'exclude') {
    state.cameraFilters.set(camModel, mode);
    if (mode === 'include') state.selectedCameras.add(camModel);
    else state.selectedCameras.delete(camModel);
  } else {
    state.cameraFilters.delete(camModel);
    state.selectedCameras.delete(camModel);
  }
  if (typeof syncCameraAndLensFilterTitle === 'function') {
    syncCameraAndLensFilterTitle();
  } else {
    fetchPhotos();
  }
}

/**
 * レンズフィルタのモードを直接指定して更新するヘルパー ('include' | 'exclude' | null)
 */
function setLensFilterModeDirect(lensKey, mode) {
  if (!lensKey) return;
  if (!state.lensFilters) state.lensFilters = new Map();
  if (mode === 'include' || mode === 'exclude') {
    state.lensFilters.set(lensKey, mode);
    if (mode === 'include') state.selectedLenses.add(lensKey);
    else state.selectedLenses.delete(lensKey);
  } else {
    state.lensFilters.delete(lensKey);
    state.selectedLenses.delete(lensKey);
  }
  if (typeof syncCameraAndLensFilterTitle === 'function') {
    syncCameraAndLensFilterTitle();
  } else {
    fetchPhotos();
  }
}

/**
 * 適用中フィルタ・フローティングフッターバーの描画
 * （写真グリッドを一切上下にずらさず、日本語の条件文として表示・直接変更/反転/解除可能）
 */
function renderActiveFilterChips() {
  const container = document.getElementById('activeFilterChips');
  if (!container) return;
  container.innerHTML = '';

  _ensureNlPopoverGlobalListeners();

  // フローティングバーの「すべて解除」ボタン初期化（初回のみ）
  const clearAllBtn = document.getElementById('floatingClearAllFiltersBtn');
  if (clearAllBtn && !clearAllBtn.dataset.bound) {
    clearAllBtn.dataset.bound = '1';
    clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNlFilterPopover();
      resetAllFilters();
    });
  }

  let hasFilter = false;
  let clauseCount = 0;
  let prevClauseIsTagInclude = false;

  function flashAndScrollToElement(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('filter-jump-highlight');
    void el.offsetWidth;
    el.classList.add('filter-jump-highlight');
    setTimeout(() => el.classList.remove('filter-jump-highlight'), 1300);
  }

  function appendClause(clauseEl, options = {}) {
    if (!clauseEl) return;
    hasFilter = true;
    const isTagInclude = Boolean(options && options.isTagIncludeClause);
    if (clauseCount > 0) {
      if (prevClauseIsTagInclude && isTagInclude) {
        const isInterOr = state.tagInterGroupMode === 'or';
        const conjBtn = document.createElement('button');
        conjBtn.type = 'button';
        conjBtn.className = `nl-conjunction is-interactive${isInterOr ? ' is-toggled' : ''}`;
        conjBtn.textContent = isInterOr ? 'または' : 'かつ';
        conjBtn.title = isInterOr
          ? '異グループ間: OR検索（いずれかのタグ条件に一致）\nクリックで「かつ (AND)」に戻す'
          : '異グループ間: AND検索（両方のタグ条件に一致）\nクリックで「または (OR)」に切り替える';
        conjBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeNlFilterPopover();
          state.tagInterGroupMode = (state.tagInterGroupMode === 'or') ? 'and' : 'or';
          fetchPhotos();
        });
        container.appendChild(conjBtn);
      } else {
        const conj = document.createElement('span');
        conj.className = 'nl-conjunction';
        conj.textContent = 'かつ';
        container.appendChild(conj);
      }
    }
    container.appendChild(clauseEl);
    clauseCount++;
    prevClauseIsTagInclude = isTagInclude;
  }

  function createClauseBox(prefixText = '', onPrefixClick = null, prefixTitle = '') {
    const box = document.createElement('span');
    box.className = 'nl-clause';
    if (prefixText) {
      const pref = document.createElement('span');
      pref.className = `nl-clause-prefix${onPrefixClick ? ' is-clickable' : ''}`;
      pref.textContent = prefixText;
      if (prefixTitle) pref.title = prefixTitle;
      if (onPrefixClick) {
        pref.addEventListener('click', (e) => {
          e.stopPropagation();
          onPrefixClick(pref);
        });
      }
      box.appendChild(pref);
    }
    return box;
  }

  function createOrSpan() {
    const sp = document.createElement('span');
    sp.className = 'nl-or';
    sp.textContent = (typeof t === 'function' && window.currentLang === 'en') ? 'or' : 'または';
    return sp;
  }

  function createPill({ labelHtml, onRemove, extraClass = '', title = '', onClick = null, onRightClick = null }) {
    const chip = document.createElement('span');
    chip.className = `filter-chip ${extraClass}`.trim();
    chip.title = title || '左クリック: 条件を変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除';
    chip.innerHTML = `
      <span class="chip-label">${labelHtml}</span>
      ${onClick ? '<span class="chip-caret">▾</span>' : ''}
      <button class="chip-remove-btn" type="button" title="この条件を解除">&times;</button>
    `;
    if (onClick) {
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.chip-remove-btn')) return;
        e.stopPropagation();
        onClick(chip);
      });
    }
    if (onRightClick) {
      chip.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.chip-remove-btn')) return;
        e.preventDefault();
        e.stopPropagation();
        closeNlFilterPopover();
        onRightClick();
      });
    }
    chip.querySelector('.chip-remove-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeNlFilterPopover();
      onRemove();
    });
    return chip;
  }

  function buildPopoverHeader(pop, titleText, onJump = null, jumpLabel = 'ツリーで開く') {
    const hdr = document.createElement('div');
    hdr.className = 'nl-pop-header';
    hdr.innerHTML = `
      <span class="nl-pop-title">${escapeHtml(titleText)}</span>
      <div class="nl-pop-header-actions">
        ${onJump ? `<button type="button" class="nl-pop-jump-btn">${escapeHtml(jumpLabel)}</button>` : ''}
        <button type="button" class="nl-pop-close-btn" title="閉じる">&times;</button>
      </div>
    `;
    if (onJump) {
      hdr.querySelector('.nl-pop-jump-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        closeNlFilterPopover();
        onJump();
      });
    }
    hdr.querySelector('.nl-pop-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeNlFilterPopover();
    });
    pop.appendChild(hdr);
  }

  // =========================================================================
  // 1. フォルダ条件
  // =========================================================================
  if ((state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude') && state.currentFilter.value) {
    const rawP = state.currentFilter.value;
    const isExclude = state.currentFilter.type === 'folder_exclude';
    const name = rawP.split(/[/\\]/).filter(Boolean).pop() || rawP;

    const jumpToFolder = () => {
      if (typeof window.openSidebarSection === 'function') window.openSidebarSection('folder');
      if (typeof revealFolderInTree === 'function') revealFolderInTree(rawP);
      setTimeout(() => {
        const targetEl = typeof _ftFindItemByPath === 'function' ? _ftFindItemByPath(rawP) : null;
        flashAndScrollToElement(targetEl);
      }, 120);
    };

    const clearOnlyFolder = () => {
      state.currentFilter = { type: 'all', value: null };
      if (elements.viewTitle) elements.viewTitle.textContent = 'すべての写真';
      document.querySelectorAll('.sidebar .nav-item, .sidebar .folder-tree-item').forEach(el => {
        el.classList.remove('active', 'active-exclude');
      });
      if (typeof window.syncFolderTreeFilterStates === 'function') {
        window.syncFolderTreeFilterStates();
      }
      fetchPhotos();
    };

    const openFolderPopover = (anchor) => {
      openNlFilterPopover(`folder:${rawP}`, anchor, (pop) => {
        buildPopoverHeader(pop, `フォルダ条件: ${name}`, jumpToFolder);
        const body = document.createElement('div');
        body.className = 'nl-pop-body';

        const grid = document.createElement('div');
        grid.className = 'nl-pop-option-grid';

        const incBtn = document.createElement('button');
        incBtn.type = 'button';
        incBtn.className = `nl-pop-option-btn${!isExclude ? ' active' : ''}`;
        incBtn.textContent = '[+] このフォルダのみ表示';
        incBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          setFilter('folder', rawP, name);
        });

        const excBtn = document.createElement('button');
        excBtn.type = 'button';
        excBtn.className = `nl-pop-option-btn${isExclude ? ' active' : ''}`;
        excBtn.textContent = '[-] このフォルダを除外';
        excBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          setFilter('folder_exclude', rawP, `除外: ${name}`);
        });

        const clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'nl-pop-option-btn';
        clrBtn.textContent = '解除（全フォルダ対象）';
        clrBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          clearOnlyFolder();
        });

        grid.appendChild(incBtn);
        grid.appendChild(excBtn);
        grid.appendChild(clrBtn);

        // 親フォルダへの切り替えボタン
        const normParts = rawP.replace(/\\/g, '/').split('/').filter(Boolean);
        if (normParts.length > 1) {
          const parentPath = rawP.includes('\\')
            ? normParts.slice(0, -1).join('\\')
            : normParts.slice(0, -1).join('/');
          const parentName = normParts[normParts.length - 2];
          if (parentName && !/^[A-Za-z]:$/.test(parentName)) {
            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'nl-pop-option-btn';
            upBtn.textContent = `親フォルダ「${parentName}」へ広げる`;
            upBtn.addEventListener('click', () => {
              closeNlFilterPopover();
              setFilter('folder', parentPath, parentName);
            });
            grid.appendChild(upBtn);
          }
        }

        body.appendChild(grid);
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('フォルダ:', openFolderPopover, 'クリックでフォルダ条件を変更');
    const pill = createPill({
      labelHtml: escapeHtml(isExclude ? `− ${name}` : name),
      extraClass: isExclude ? 'chip-tag-exclude' : 'chip-tag-include',
      title: `${rawP}\n左クリック: フォルダ条件を変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除`,
      onRemove: clearOnlyFolder,
      onClick: openFolderPopover,
      onRightClick: () => {
        if (isExclude) setFilter('folder', rawP, name);
        else setFilter('folder_exclude', rawP, `除外: ${name}`);
      },
    });
    clause.appendChild(pill);
    if (isExclude) {
      const exTxt = document.createElement('span');
      exTxt.className = 'nl-except-wrap';
      exTxt.textContent = 'を除く';
      clause.appendChild(exTxt);
    }
    appendClause(clause);
  }

  // =========================================================================
  // 2. タイムライン年月・日付 (OR条件)
  // =========================================================================
  const hasSelectedYms = Boolean(state.selectedYearMonths && state.selectedYearMonths.size > 0);
  const hasSelectedDates = Boolean(state.selectedDates && state.selectedDates.size > 0);
  if (hasSelectedYms || hasSelectedDates) {
    const sortedYms = hasSelectedYms
      ? Array.from(state.selectedYearMonths).sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
        )
      : [];
    const sortedDates = hasSelectedDates
      ? Array.from(state.selectedDates).sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
        )
      : [];

    const formatYm = (ym) => {
      const parts = String(ym).split('-');
      if (parts.length === 2 && !isNaN(parseInt(parts[1], 10))) {
        return `${parts[0]}年${parseInt(parts[1], 10)}月`;
      }
      return String(ym);
    };

    const formatDateLabel = (dateStr) => {
      const parts = String(dateStr).split('-');
      if (parts.length === 3) {
        const m = parseInt(parts[1], 10);
        const d = parseInt(parts[2], 10);
        if (!isNaN(m) && !isNaN(d)) {
          return `${parts[0]}年${m}月${d}日`;
        }
      }
      return String(dateStr);
    };

    const openTimelinePopover = (anchor, focusYm = null) => {
      openNlFilterPopover(`timeline:${focusYm || 'group'}`, anchor, (pop) => {
        const jumpTimeline = () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('timeline');
          const fallbackYm = sortedDates[0] ? sortedDates[0].slice(0, 7) : null;
          const targetYm = focusYm || sortedYms[0] || fallbackYm;
          const yr = String(targetYm || '').split('-')[0];
          if (yr && state.expandedTimelineYears) state.expandedTimelineYears.add(yr);
          const groupEl = document.querySelector(`.timeline-year-header[data-year="${CSS.escape(yr)}"]`)?.parentElement;
          if (groupEl) {
            groupEl.querySelector('.tree-toggle-btn')?.classList.remove('collapsed');
            groupEl.querySelector('.timeline-month-list')?.classList.remove('hidden');
          }
          setTimeout(() => {
            const itemEl = targetYm
              ? document.querySelector(`.timeline-month-item[data-filter-value="${CSS.escape(targetYm)}"]`)
              : document.getElementById('sidebarMiniCalendarBox');
            flashAndScrollToElement(itemEl);
          }, 80);
        };

        buildPopoverHeader(pop, '撮影年月・日付の変更・追加 (OR検索)', jumpTimeline);

        const body = document.createElement('div');
        body.className = 'nl-pop-body';

        // 拡大カレンダー起動ボタン
        const calBar = document.createElement('div');
        calBar.className = 'nl-pop-option-grid';
        const openCalBtn = document.createElement('button');
        openCalBtn.type = 'button';
        openCalBtn.className = 'nl-pop-option-btn';
        openCalBtn.textContent = '拡大カレンダーを開いて日付・年月を選択...';
        openCalBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          if (typeof window.openCalendarModal === 'function') {
            window.openCalendarModal('month');
          }
        });
        calBar.appendChild(openCalBtn);
        body.appendChild(calBar);

        // もし特定の月（例: 10月）が選択されている場合、「すべての年の〇月を一括選択」ショートカットを表示
        const targetMonthStr = focusYm ? String(focusYm).split('-')[1] : (sortedYms[0] ? String(sortedYms[0]).split('-')[1] : null);
        const allDomMonths = Array.from(document.querySelectorAll('#timelineTree .timeline-month-item')).map(el => ({
          ym: el.dataset.filterValue,
          count: el.querySelector('.nav-count')?.textContent || '',
        })).filter(x => x.ym);

        if (targetMonthStr && allDomMonths.length > 0) {
          const sameMonthYms = allDomMonths.filter(x => String(x.ym).split('-')[1] === targetMonthStr).map(x => x.ym);
          if (sameMonthYms.length > 1) {
            const mNum = parseInt(targetMonthStr, 10);
            const allChecked = sameMonthYms.every(ym => state.selectedYearMonths.has(ym));
            const quickBar = document.createElement('div');
            quickBar.className = 'nl-pop-option-grid';
            const sameMonthBtn = document.createElement('button');
            sameMonthBtn.type = 'button';
            sameMonthBtn.className = `nl-pop-option-btn${allChecked ? ' active' : ''}`;
            sameMonthBtn.textContent = allChecked
              ? `全年の「${mNum}月」(${sameMonthYms.length}件) を選択中`
              : `すべての年の「${mNum}月」(${sameMonthYms.length}件) を一括選択`;
            sameMonthBtn.addEventListener('click', () => {
              sameMonthYms.forEach(ym => state.selectedYearMonths.add(ym));
              if (typeof updateTimelineFilterState === 'function') updateTimelineFilterState();
              else fetchPhotos();
              closeNlFilterPopover();
            });
            quickBar.appendChild(sameMonthBtn);
            body.appendChild(quickBar);
          }
        }

        allDomMonths.forEach(item => {
          const row = document.createElement('div');
          row.className = 'nl-pop-row';
          const isSel = state.selectedYearMonths.has(item.ym);
          row.innerHTML = `
            <span class="nl-pop-row-label">${escapeHtml(formatYm(item.ym))}</span>
            <span class="nl-pop-row-count">${escapeHtml(item.count)}</span>
            <div class="nl-pop-state-group">
              <button type="button" class="nl-pop-state-btn is-include${isSel ? ' active' : ''}">${isSel ? '選択中' : '+ 追加'}</button>
            </div>
          `;
          const toggleThisYm = () => {
            toggleTimelineYearMonth(item.ym);
            const nowSel = state.selectedYearMonths.has(item.ym);
            const btn = row.querySelector('.nl-pop-state-btn');
            if (btn) {
              btn.classList.toggle('active', nowSel);
              btn.textContent = nowSel ? '選択中' : '+ 追加';
            }
          };
          row.querySelector('.nl-pop-row-label').addEventListener('click', toggleThisYm);
          row.querySelector('.nl-pop-state-btn').addEventListener('click', toggleThisYm);
          body.appendChild(row);
        });

        pop.appendChild(body);
      });
    };

    // 年単位で全月が選択されている場合は「YYYY年 (全体)」ピルに集約表示
    const availByYear = new Map();
    if (Array.isArray(state.availableTimeline)) {
      state.availableTimeline.forEach(item => {
        if (!item || !item.year_month || item.year_month === '不明') return;
        const yr = String(item.year_month).split('-')[0];
        if (!yr) return;
        if (!availByYear.has(yr)) availByYear.set(yr, []);
        availByYear.get(yr).push(item.year_month);
      });
    }

    const consolidatedYears = new Set();
    const pillsToRender = [];

    availByYear.forEach((ymsInYear, yr) => {
      if (ymsInYear.length >= 2 && ymsInYear.every(ym => state.selectedYearMonths.has(ym))) {
        consolidatedYears.add(yr);
        pillsToRender.push({
          sortKey: `${yr}-00`,
          labelHtml: escapeHtml(`${yr}年 (全体)`),
          title: `${yr}年の全${ymsInYear.length}ヶ月を選択中\n左クリック: 他の年月を追加・変更 ｜ ×: ${yr}年を解除`,
          onRemove: () => {
            if (typeof window.toggleYearMonths === 'function') {
              window.toggleYearMonths(yr, ymsInYear);
            } else {
              ymsInYear.forEach(ym => state.selectedYearMonths.delete(ym));
              fetchPhotos();
            }
          },
          onClick: (chip) => openTimelinePopover(chip, ymsInYear[0]),
        });
      }
    });

    sortedYms.forEach(ym => {
      const yr = String(ym).split('-')[0];
      if (consolidatedYears.has(yr)) return;
      pillsToRender.push({
        sortKey: ym,
        labelHtml: escapeHtml(formatYm(ym)),
        title: `${ym}\n左クリック: 他の年月を追加・変更 ｜ ×: 解除`,
        onRemove: () => toggleTimelineYearMonth(ym),
        onClick: (chip) => openTimelinePopover(chip, ym),
      });
    });

    sortedDates.forEach(dStr => {
      pillsToRender.push({
        sortKey: dStr,
        labelHtml: escapeHtml(formatDateLabel(dStr)),
        title: `${dStr}\n左クリック: カレンダーで変更 ｜ ×: 解除`,
        onRemove: () => {
          if (typeof window.toggleTimelineDate === 'function') {
            window.toggleTimelineDate(dStr, false);
          } else {
            state.selectedDates.delete(dStr);
            fetchPhotos();
          }
        },
        onClick: () => {
          state.miniCalendarYm = dStr.slice(0, 7);
          if (typeof window.openCalendarModal === 'function') {
            window.openCalendarModal('month');
          }
        },
      });
    });

    pillsToRender.sort((a, b) =>
      String(a.sortKey).localeCompare(String(b.sortKey), undefined, { numeric: true, sensitivity: 'base' })
    );

    const clause = createClauseBox('年月:', (pref) => openTimelinePopover(pref, null), 'クリックで撮影年月・日付を追加・変更');
    pillsToRender.forEach((pItem, idx) => {
      if (idx > 0) clause.appendChild(createOrSpan());
      clause.appendChild(createPill({
        labelHtml: pItem.labelHtml,
        extraClass: 'chip-tag-include',
        title: pItem.title,
        onRemove: pItem.onRemove,
        onClick: pItem.onClick,
      }));
    });

    const addYmBtn = document.createElement('button');
    addYmBtn.type = 'button';
    addYmBtn.className = 'nl-group-add-btn';
    addYmBtn.title = '別の撮影年月・日付をOR条件で追加';
    addYmBtn.textContent = '+';
    addYmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTimelinePopover(addYmBtn, sortedYms[0] || (sortedDates[0] ? sortedDates[0].slice(0, 7) : null));
    });
    clause.appendChild(addYmBtn);
    appendClause(clause);
  }

  // =========================================================================
  // 3. ジオタグ（撮影場所）条件
  // =========================================================================
  if (state.activeLocation) {
    const loc = state.activeLocation;
    const isNoLoc = Boolean(loc.no_location);
    const locLabel = isNoLoc
      ? 'ジオタグなし'
      : (loc.label || [loc.country, loc.state, loc.city].filter(Boolean).join(' › '));

    const jumpToLocation = async () => {
      if (typeof window.openSidebarSection === 'function') window.openSidebarSection('location');
      if (isNoLoc) {
        setTimeout(() => flashAndScrollToElement(document.getElementById('noLocationNavItem')), 120);
        return;
      }
      if (typeof window.revealActiveLocationInTree === 'function') {
        await window.revealActiveLocationInTree();
      }
      setTimeout(() => {
        const activeRow = document.querySelector('#locationTree .location-node-row.active');
        flashAndScrollToElement(activeRow);
      }, 120);
    };

    const openLocationPopover = (anchor) => {
      openNlFilterPopover('location', anchor, (pop) => {
        buildPopoverHeader(pop, `撮影場所条件: ${locLabel}`, jumpToLocation);
        const body = document.createElement('div');
        body.className = 'nl-pop-body';
        const grid = document.createElement('div');
        grid.className = 'nl-pop-option-grid';

        if (!isNoLoc && loc.city && loc.state) {
          const stateBtn = document.createElement('button');
          stateBtn.type = 'button';
          stateBtn.className = 'nl-pop-option-btn';
          stateBtn.textContent = `「${loc.state}」全域に広げる`;
          stateBtn.addEventListener('click', () => {
            closeNlFilterPopover();
            state.activeLocation = { country: loc.country, state: loc.state, city: null, label: `${loc.country} > ${loc.state}` };
            if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();
            fetchPhotos();
          });
          grid.appendChild(stateBtn);
        }

        if (!isNoLoc && loc.state && loc.country) {
          const countryBtn = document.createElement('button');
          countryBtn.type = 'button';
          countryBtn.className = 'nl-pop-option-btn';
          countryBtn.textContent = `「${loc.country}」全域に広げる`;
          countryBtn.addEventListener('click', () => {
            closeNlFilterPopover();
            state.activeLocation = { country: loc.country, state: null, city: null, label: loc.country };
            if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();
            fetchPhotos();
          });
          grid.appendChild(countryBtn);
        }

        const noLocBtn = document.createElement('button');
        noLocBtn.type = 'button';
        noLocBtn.className = `nl-pop-option-btn${isNoLoc ? ' active' : ''}`;
        noLocBtn.textContent = 'ジオタグなしの写真のみ';
        noLocBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          state.activeLocation = { no_location: true, label: 'ジオタグなし' };
          if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();
          fetchPhotos();
        });
        grid.appendChild(noLocBtn);

        const clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'nl-pop-option-btn';
        clrBtn.textContent = '場所フィルタを解除';
        clrBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          if (typeof clearLocationFilter === 'function') clearLocationFilter();
          else {
            state.activeLocation = null;
            fetchPhotos();
          }
        });
        grid.appendChild(clrBtn);

        body.appendChild(grid);
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('場所:', openLocationPopover, 'クリックで場所条件を変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(locLabel),
      extraClass: 'chip-tag-include',
      title: `場所: ${locLabel}\n左クリック: 範囲の変更・解除 ｜ ×: 解除`,
      onRemove: () => {
        if (typeof clearLocationFilter === 'function') clearLocationFilter();
        else {
          state.activeLocation = null;
          fetchPhotos();
        }
      },
      onClick: openLocationPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 4. カラータグ条件 & 階層タグ条件（第1階層ルートごとにグループ化）
  //    - 同じ親（ルート）配下の [+] タグは「または (OR)」で結合
  //    - 除外 [-] タグは「（除く: ...）」として明示
  //    - 異なる親（ルート）同士は別文節となり「かつ (AND)」で結合
  // =========================================================================
  if (state.tagFilters && state.tagFilters.size > 0) {
    const colorEntries = [];
    const rootGroups = new Map(); // rootName -> { includes: [], excludes: [] }

    state.tagFilters.forEach((mode, tag) => {
      if (typeof COLOR_TAG_MAP !== 'undefined' && (tag in COLOR_TAG_MAP)) {
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

    // 4a. カラータグ文節
    if (colorEntries.length > 0) {
      const openColorPopover = (anchor, focusColor) => {
        openNlFilterPopover(`color:${focusColor}`, anchor, (pop) => {
          const jumpColor = () => {
            if (typeof window.openSidebarSection === 'function') window.openSidebarSection('tags');
            if (typeof toggleColorPaletteExpander === 'function') toggleColorPaletteExpander(true);
            setTimeout(() => flashAndScrollToElement(document.getElementById('colorPaletteSection')), 80);
          };
          buildPopoverHeader(pop, 'カラー条件の変更（左クリック: 含む / 右クリック: 除外）', jumpColor, 'パレットを開く');

          const curMode = state.tagFilters.get(focusColor) || null;
          const curBar = document.createElement('div');
          curBar.className = 'nl-pop-current-bar';
          curBar.innerHTML = `
            <span class="nl-pop-current-name">選択中: ${escapeHtml(focusColor)}</span>
            <div class="nl-pop-state-group">
              <button type="button" class="nl-pop-state-btn is-include${curMode === 'include' ? ' active' : ''}" data-mode="include">+ 含む</button>
              <button type="button" class="nl-pop-state-btn is-exclude${curMode === 'exclude' ? ' active' : ''}" data-mode="exclude">− 除外</button>
              <button type="button" class="nl-pop-state-btn" data-mode="off">解除</button>
            </div>
          `;
          curBar.querySelectorAll('.nl-pop-state-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const m = btn.dataset.mode;
              setTagFilterModeDirect(focusColor, m === 'off' ? null : m);
              closeNlFilterPopover();
            });
          });
          pop.appendChild(curBar);

          const body = document.createElement('div');
          body.className = 'nl-pop-body';
          const grid = document.createElement('div');
          grid.className = 'nl-pop-option-grid';

          Object.keys(COLOR_TAG_MAP).forEach(cName => {
            const conf = COLOR_TAG_MAP[cName];
            const cMode = state.tagFilters.get(cName);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `nl-pop-option-btn${cMode ? ' active' : ''}`;
            btn.style.display = 'inline-flex';
            btn.style.alignItems = 'center';
            btn.style.gap = '5px';
            const sign = cMode === 'include' ? '[+] ' : (cMode === 'exclude' ? '[-] ' : '');
            btn.innerHTML = `<span class="tag-color-dot" style="background:${conf.color}; width:10px; height:10px; border-radius:50%; display:inline-block; border:1px solid rgba(255,255,255,0.35);"></span><span>${escapeHtml(sign + cName)}</span>`;
            btn.title = `${cName}\n左クリック: この色を含む [+] ｜ 右クリック: この色を除外 [-]`;
            btn.addEventListener('click', () => {
              setTagFilterModeDirect(cName, 'include');
              closeNlFilterPopover();
            });
            btn.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              setTagFilterModeDirect(cName, 'exclude');
              closeNlFilterPopover();
            });
            grid.appendChild(btn);
          });

          body.appendChild(grid);
          pop.appendChild(body);
        });
      };

      const colorClause = createClauseBox('色:', (pref) => openColorPopover(pref, colorEntries[0].tag), 'クリックでカラー条件を変更');
      colorEntries.forEach(({ tag, mode }, idx) => {
        if (idx > 0) colorClause.appendChild(createOrSpan());
        const conf = COLOR_TAG_MAP[tag];
        const dotHtml = conf ? `<span class="tag-color-dot" style="background:${conf.color}; width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:4px;"></span>` : '';
        const labelHtml = `${mode === 'exclude' ? '− ' : ''}${dotHtml}${escapeHtml(tag)}`;
        colorClause.appendChild(createPill({
          labelHtml,
          extraClass: mode === 'include' ? 'chip-tag-include' : 'chip-tag-exclude',
          title: `カラー: ${tag}\n左クリック: 色の変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除`,
          onRemove: () => removeTagFilter(tag),
          onClick: (chip) => openColorPopover(chip, tag),
          onRightClick: () => setTagFilterModeDirect(tag, mode === 'include' ? 'exclude' : 'include'),
        }));
        if (mode === 'exclude') {
          const exSpan = document.createElement('span');
          exSpan.className = 'nl-except-wrap';
          exSpan.textContent = 'を除く';
          colorClause.appendChild(exSpan);
        }
      });
      appendClause(colorClause);
    }

    // 4b. 階層タグ・一般タグ文節（ルート親ごとに1つの文節を構築し、すべて自然順で整列）
    const allAvailTags = state.availableTags || [];
    const compareNaturalPath = (pathA, pathB) => {
      const partsA = String(pathA || '').split('/');
      const partsB = String(pathB || '').split('/');
      const minLen = Math.min(partsA.length, partsB.length);
      for (let i = 0; i < minLen; i++) {
        const cmp = partsA[i].localeCompare(partsB[i], undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
      }
      return partsA.length - partsB.length;
    };

    const sortedRootKeys = Array.from(rootGroups.keys()).sort((a, b) => {
      const aHasInc = (rootGroups.get(a)?.includes?.length || 0) > 0 ? 0 : 1;
      const bHasInc = (rootGroups.get(b)?.includes?.length || 0) > 0 ? 0 : 1;
      if (aHasInc !== bHasInc) return aHasInc - bHasInc;
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    });

    sortedRootKeys.forEach((root) => {
      const grp = rootGroups.get(root);
      const includes = [...grp.includes].sort(compareNaturalPath);
      const excludes = [...grp.excludes].sort(compareNaturalPath);
      const isIntraAnd = Boolean(state.tagAndRoots && state.tagAndRoots.has(root));
      const rootHasSubTags = allAvailTags.some(t => {
        const tn = t.tag || t.name || '';
        return tn.startsWith(root + '/');
      }) || includes.some(t => t.includes('/')) || excludes.some(t => t.includes('/'));

      const jumpToTagInTree = (targetTag) => {
        const tagToReveal = targetTag || includes[0] || excludes[0] || root;
        if (typeof window.openSidebarSection === 'function') window.openSidebarSection('tags');
        if (typeof expandTagAncestors === 'function') expandTagAncestors(tagToReveal);
        if (rootHasSubTags) state.expandedTagPaths.add(root);
        const tagObj = allAvailTags.find(t => (t.tag || t.name) === tagToReveal);
        if (tagObj && state.tagSourceFilter !== 'all') {
          if (state.tagSourceFilter === 'manual' && tagObj.source === 'ai') state.tagSourceFilter = 'all';
          else if (state.tagSourceFilter === 'ai' && tagObj.source === 'manual') state.tagSourceFilter = 'all';
        }
        if (typeof renderTagList === 'function') renderTagList();
        setTimeout(() => {
          const pillEl = document.querySelector(`#tagList .tag-pill-item[data-tag-path="${CSS.escape(tagToReveal)}"]`);
          flashAndScrollToElement(pillEl);
        }, 80);
      };

      const openTagGroupPopover = (anchor, focusTag = null) => {
        const popKey = `tag:${root}:${focusTag || 'group'}`;
        openNlFilterPopover(popKey, anchor, (pop) => {
          const nowIntraAnd = Boolean(state.tagAndRoots && state.tagAndRoots.has(root));
          const headerTitle = rootHasSubTags
            ? `タグ条件: ${root}（同グループ内は${nowIntraAnd ? 'AND' : 'OR'}・除外はNOT）`
            : `タグ条件: ${focusTag || root}`;
          buildPopoverHeader(pop, headerTitle, () => jumpToTagInTree(focusTag));

          // クリックされた個別タグの即時切替バー
          if (focusTag) {
            const curMode = state.tagFilters.get(focusTag) || null;
            const curBar = document.createElement('div');
            curBar.className = 'nl-pop-current-bar';
            curBar.innerHTML = `
              <span class="nl-pop-current-name" title="${escapeHtml(focusTag)}">${escapeHtml(focusTag)}</span>
              <div class="nl-pop-state-group">
                <button type="button" class="nl-pop-state-btn is-include${curMode === 'include' ? ' active' : ''}" data-mode="include">+ 含む</button>
                <button type="button" class="nl-pop-state-btn is-exclude${curMode === 'exclude' ? ' active' : ''}" data-mode="exclude">− 除外</button>
                <button type="button" class="nl-pop-state-btn" data-mode="off">解除</button>
              </div>
            `;
            curBar.querySelectorAll('.nl-pop-state-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const m = btn.dataset.mode;
                setTagFilterModeDirect(focusTag, m === 'off' ? null : m);
                const updated = state.tagFilters.get(focusTag) || null;
                curBar.querySelectorAll('.nl-pop-state-btn').forEach(b => {
                  if (b.dataset.mode === 'include') b.classList.toggle('active', updated === 'include');
                  else if (b.dataset.mode === 'exclude') b.classList.toggle('active', updated === 'exclude');
                });
                renderCandidateList(searchInput.value);
              });
            });
            pop.appendChild(curBar);
          }

          // グループ内（OR ⇄ AND）および異グループ間（AND ⇄ OR）の結合モード切替バー
          const includeGroupCount = sortedRootKeys.filter(k => (rootGroups.get(k)?.includes?.length || 0) > 0).length;
          if (rootHasSubTags || includes.length >= 2 || includeGroupCount >= 2) {
            const logicBar = document.createElement('div');
            logicBar.className = 'nl-pop-current-bar nl-pop-logic-bar';

            if (rootHasSubTags || includes.length >= 2) {
              const intraRow = document.createElement('div');
              intraRow.className = 'nl-pop-logic-row';
              const curIntraAnd = Boolean(state.tagAndRoots && state.tagAndRoots.has(root));
              intraRow.innerHTML = `
                <span class="nl-pop-logic-label">同グループ内の結合:</span>
                <div class="nl-pop-state-group">
                  <button type="button" class="nl-pop-state-btn${!curIntraAnd ? ' active is-logic-active' : ''}" data-intra="or">または (OR)</button>
                  <button type="button" class="nl-pop-state-btn${curIntraAnd ? ' active is-logic-active' : ''}" data-intra="and">かつ (AND)</button>
                </div>
              `;
              intraRow.querySelectorAll('button[data-intra]').forEach(btn => {
                btn.addEventListener('click', () => {
                  if (!state.tagAndRoots) state.tagAndRoots = new Set();
                  if (btn.dataset.intra === 'and') state.tagAndRoots.add(root);
                  else state.tagAndRoots.delete(root);
                  closeNlFilterPopover();
                  fetchPhotos();
                });
              });
              logicBar.appendChild(intraRow);
            }

            if (includeGroupCount >= 2) {
              const interRow = document.createElement('div');
              interRow.className = 'nl-pop-logic-row';
              const curInterOr = state.tagInterGroupMode === 'or';
              interRow.innerHTML = `
                <span class="nl-pop-logic-label">別グループとの結合:</span>
                <div class="nl-pop-state-group">
                  <button type="button" class="nl-pop-state-btn${!curInterOr ? ' active is-logic-active' : ''}" data-inter="and">かつ (AND)</button>
                  <button type="button" class="nl-pop-state-btn${curInterOr ? ' active is-logic-active' : ''}" data-inter="or">または (OR)</button>
                </div>
              `;
              interRow.querySelectorAll('button[data-inter]').forEach(btn => {
                btn.addEventListener('click', () => {
                  state.tagInterGroupMode = btn.dataset.inter === 'or' ? 'or' : 'and';
                  closeNlFilterPopover();
                  fetchPhotos();
                });
              });
              logicBar.appendChild(interRow);
            }

            pop.appendChild(logicBar);
          }

          // 検索フィルタ欄
          const searchWrap = document.createElement('div');
          searchWrap.className = 'nl-pop-search-wrap';
          const searchInput = document.createElement('input');
          searchInput.type = 'text';
          searchInput.className = 'nl-pop-search-input';
          searchInput.placeholder = rootHasSubTags
            ? `「${root}」内のタグを検索（他のタグ名も検索可）...`
            : '追加・変更するタグを検索...';
          searchWrap.appendChild(searchInput);
          pop.appendChild(searchWrap);

          const body = document.createElement('div');
          body.className = 'nl-pop-body';
          pop.appendChild(body);

          function renderCandidateList(queryText = '') {
            body.innerHTML = '';
            const q = String(queryText || '').trim().toLowerCase();

            let candidates = allAvailTags.filter(t => {
              const tn = t.tag || t.name || '';
              if (!tn || (typeof COLOR_TAG_MAP !== 'undefined' && (tn in COLOR_TAG_MAP))) return false;
              if (q) return tn.toLowerCase().includes(q);
              if (rootHasSubTags) return tn === root || tn.startsWith(root + '/');
              return !tn.includes('/') || tn === root || state.tagFilters.has(tn);
            });

            // 現在のルート配下を優先して辞書順ソート
            candidates.sort((a, b) => {
              const na = a.tag || a.name || '';
              const nb = b.tag || b.name || '';
              const aInRoot = (na === root || na.startsWith(root + '/')) ? 0 : 1;
              const bInRoot = (nb === root || nb.startsWith(root + '/')) ? 0 : 1;
              if (aInRoot !== bInRoot) return aInRoot - bInRoot;
              return compareNaturalPath(na, nb);
            });

            if (candidates.length === 0) {
              const emptyEl = document.createElement('div');
              emptyEl.className = 'nl-pop-hint';
              emptyEl.textContent = '一致するタグがありません';
              body.appendChild(emptyEl);
              return;
            }

            candidates.slice(0, 80).forEach(tObj => {
              const tPath = tObj.tag || tObj.name;
              const cnt = tObj.count || 0;
              const depth = (tPath.match(/\//g) || []).length;
              const displayRel = (rootHasSubTags && !q && tPath.startsWith(root + '/'))
                ? tPath.slice(root.length + 1)
                : tPath;
              const curM = state.tagFilters.get(tPath) || null;

              const row = document.createElement('div');
              row.className = 'nl-pop-row';
              row.style.paddingLeft = `${Math.min(36, 6 + depth * 10)}px`;
              row.innerHTML = `
                <span class="nl-pop-row-label" title="${escapeHtml(tPath)}">${escapeHtml(tPath === root && rootHasSubTags ? `${root} (親全体)` : displayRel)}</span>
                <span class="nl-pop-row-count">${cnt}</span>
                <div class="nl-pop-state-group">
                  <button type="button" class="nl-pop-state-btn is-include${curM === 'include' ? ' active' : ''}" data-act="include" title="含む [+]">+</button>
                  <button type="button" class="nl-pop-state-btn is-exclude${curM === 'exclude' ? ' active' : ''}" data-act="exclude" title="除外 [−]">−</button>
                </div>
              `;

              const updateRowState = (nextMode) => {
                setTagFilterModeDirect(tPath, nextMode);
                renderCandidateList(searchInput.value);
              };

              row.querySelector('.nl-pop-row-label').addEventListener('click', () => {
                const nowM = state.tagFilters.get(tPath) || null;
                updateRowState(nowM === 'include' ? null : 'include');
              });
              row.querySelector('[data-act="include"]').addEventListener('click', () => {
                const nowM = state.tagFilters.get(tPath) || null;
                updateRowState(nowM === 'include' ? null : 'include');
              });
              row.querySelector('[data-act="exclude"]').addEventListener('click', () => {
                const nowM = state.tagFilters.get(tPath) || null;
                updateRowState(nowM === 'exclude' ? null : 'exclude');
              });

              body.appendChild(row);
            });
          }

          searchInput.addEventListener('input', () => renderCandidateList(searchInput.value));
          renderCandidateList('');
        });
      };

      const formatTagInGroup = (tagPath) => {
        if (!rootHasSubTags) return tagPath;
        if (tagPath === root) {
          const hasSpecificChildInc = includes.some(other => other !== root && other.startsWith(root + '/'));
          return hasSpecificChildInc ? '全体(子タグ優先)' : 'すべて';
        }
        return tagPath.startsWith(root + '/') ? tagPath.slice(root.length + 1) : tagPath;
      };

      const clausePrefix = rootHasSubTags ? `${root}:` : '';
      const clause = createClauseBox(
        clausePrefix,
        rootHasSubTags ? (pref) => openTagGroupPopover(pref, null) : null,
        rootHasSubTags ? `クリックで「${root}」配下のタグ条件を追加・変更` : ''
      );

      // [+] 含むタグ（同ルート内は既定「または」、クリックで「かつ」へ切替可能）
      includes.forEach((tag, idx) => {
        if (idx > 0) {
          const intraBtn = document.createElement('button');
          intraBtn.type = 'button';
          intraBtn.className = `nl-or is-interactive${isIntraAnd ? ' is-toggled' : ''}`;
          intraBtn.textContent = isIntraAnd ? 'かつ' : 'または';
          intraBtn.title = isIntraAnd
            ? `「${root}」内: AND検索（すべて含む写真のみ）\nクリックで「または (OR)」に戻す`
            : `「${root}」内: OR検索（いずれかを含む写真）\nクリックで「かつ (AND)」に切り替える`;
          intraBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeNlFilterPopover();
            if (!state.tagAndRoots) state.tagAndRoots = new Set();
            if (state.tagAndRoots.has(root)) state.tagAndRoots.delete(root);
            else state.tagAndRoots.add(root);
            fetchPhotos();
          });
          clause.appendChild(intraBtn);
        }
        const disp = formatTagInGroup(tag);
        clause.appendChild(createPill({
          labelHtml: escapeHtml(disp),
          extraClass: 'chip-tag-include',
          title: `タグ: ${tag} (含む)\n左クリック: 同グループのタグ追加・変更 ｜ 右クリック: 除外[−]へ反転 ｜ ×: 解除`,
          onRemove: () => removeTagFilter(tag),
          onClick: (chip) => openTagGroupPopover(chip, tag),
          onRightClick: () => setTagFilterModeDirect(tag, 'exclude'),
        }));
      });

      // [-] 除外タグ
      if (excludes.length > 0) {
        if (includes.length > 0) {
          const exWrap = document.createElement('span');
          exWrap.className = 'nl-except-wrap';
          const openParen = document.createElement('span');
          openParen.textContent = '（除く:';
          exWrap.appendChild(openParen);

          excludes.forEach((tag) => {
            const disp = formatTagInGroup(tag);
            exWrap.appendChild(createPill({
              labelHtml: escapeHtml(`− ${disp}`),
              extraClass: 'chip-tag-exclude',
              title: `タグ: ${tag} (除外)\n左クリック: 条件を変更 ｜ 右クリック: 含む[+]へ反転 ｜ ×: 解除`,
              onRemove: () => removeTagFilter(tag),
              onClick: (chip) => openTagGroupPopover(chip, tag),
              onRightClick: () => setTagFilterModeDirect(tag, 'include'),
            }));
          });

          const closeParen = document.createElement('span');
          closeParen.textContent = '）';
          exWrap.appendChild(closeParen);
          clause.appendChild(exWrap);
        } else {
          excludes.forEach((tag, idx) => {
            if (idx > 0) {
              const dot = document.createElement('span');
              dot.className = 'nl-or';
              dot.textContent = '・';
              clause.appendChild(dot);
            }
            const disp = formatTagInGroup(tag);
            clause.appendChild(createPill({
              labelHtml: escapeHtml(`− ${disp}`),
              extraClass: 'chip-tag-exclude',
              title: `タグ: ${tag} (除外)\n左クリック: 条件を変更 ｜ 右クリック: 含む[+]へ反転 ｜ ×: 解除`,
              onRemove: () => removeTagFilter(tag),
              onClick: (chip) => openTagGroupPopover(chip, tag),
              onRightClick: () => setTagFilterModeDirect(tag, 'include'),
            }));
          });
          const exSuffix = document.createElement('span');
          exSuffix.className = 'nl-except-wrap';
          exSuffix.textContent = 'を除く';
          clause.appendChild(exSuffix);
        }
      }

      // 階層タググループには「+」追加ボタンを表示
      if (rootHasSubTags) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'nl-group-add-btn';
        addBtn.title = `「${root}」内の別タグを追加 (${isIntraAnd ? 'AND' : 'OR'}) または除外 (NOT)`;
        addBtn.textContent = '+';
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openTagGroupPopover(addBtn, null);
        });
        clause.appendChild(addBtn);
      }

      appendClause(clause, { isTagIncludeClause: includes.length > 0 });
    });
  }

  // =========================================================================
  // 5. カメラ機種 & レンズ条件
  // =========================================================================
  const camIncludes = [];
  const camExcludes = [];
  const handledCams = new Set();

  if (state.cameraFilters && state.cameraFilters.size > 0) {
    state.cameraFilters.forEach((mode, cam) => {
      handledCams.add(cam);
      const entry = { kind: 'camera', key: cam, label: cam, mode };
      if (mode === 'include') camIncludes.push(entry);
      else if (mode === 'exclude') camExcludes.push(entry);
    });
  }
  if (state.selectedCameras && state.selectedCameras.size > 0) {
    Array.from(state.selectedCameras).sort().forEach(cam => {
      if (handledCams.has(cam)) return;
      camIncludes.push({ kind: 'camera', key: cam, label: cam, mode: 'include' });
    });
  }
  if (state.lensFilters && state.lensFilters.size > 0) {
    state.lensFilters.forEach((mode, lensKey) => {
      const displayName = lensKey.includes('::') ? lensKey.replace('::', ' / ') : lensKey;
      const entry = { kind: 'lens', key: lensKey, label: displayName, mode };
      if (mode === 'include') camIncludes.push(entry);
      else if (mode === 'exclude') camExcludes.push(entry);
    });
  }

  if (camIncludes.length > 0 || camExcludes.length > 0) {
    const compareEquipEntry = (a, b) =>
      String(a.label || '').localeCompare(String(b.label || ''), undefined, { numeric: true, sensitivity: 'base' });
    camIncludes.sort(compareEquipEntry);
    camExcludes.sort(compareEquipEntry);
    const openEquipmentPopover = (anchor, focusItem = null) => {
      openNlFilterPopover(`equip:${focusItem ? focusItem.key : 'all'}`, anchor, (pop) => {
        const jumpCamera = () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('camera');
          if (focusItem && focusItem.kind === 'lens' && focusItem.key.includes('::')) {
            const camModel = focusItem.key.split('::')[0];
            if (camModel && state.expandedCameras) {
              state.expandedCameras.add(camModel);
              if (typeof renderCameras === 'function') renderCameras(state.availableCameras);
            }
            setTimeout(() => {
              const lensEl = document.querySelector(`.camera-lens-item[data-lens-key="${CSS.escape(focusItem.key)}"]`);
              flashAndScrollToElement(lensEl);
            }, 80);
          } else if (focusItem && focusItem.kind === 'camera') {
            setTimeout(() => {
              const camEl = document.querySelector(`.camera-tree-item[data-camera="${CSS.escape(focusItem.key)}"]`);
              flashAndScrollToElement(camEl);
            }, 80);
          }
        };

        buildPopoverHeader(pop, '機材（カメラ・レンズ）条件の変更', jumpCamera);

        const body = document.createElement('div');
        body.className = 'nl-pop-body';

        function renderEquipList() {
          body.innerHTML = '';
          const sortedEquipCams = [...(state.availableCameras || [])].sort((a, b) => {
            const ca = String(a.camera_model || '');
            const cb = String(b.camera_model || '');
            const aLast = (ca === '不明' || ca === 'Unknown' || ca === '__NONE__') ? 1 : 0;
            const bLast = (cb === '不明' || cb === 'Unknown' || cb === '__NONE__') ? 1 : 0;
            if (aLast !== bLast) return aLast - bLast;
            return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: 'base' });
          });
          sortedEquipCams.forEach(camObj => {
            const camModel = camObj.camera_model;
            const cMode = (state.cameraFilters && state.cameraFilters.get(camModel)) ||
              (state.selectedCameras && state.selectedCameras.has(camModel) ? 'include' : null);

            const camRow = document.createElement('div');
            camRow.className = 'nl-pop-row';
            camRow.innerHTML = `
              <span class="nl-pop-row-label" style="font-weight:600;" title="${escapeHtml(camModel)}">${escapeHtml(camModel)}</span>
              <span class="nl-pop-row-count">${camObj.count || 0}</span>
              <div class="nl-pop-state-group">
                <button type="button" class="nl-pop-state-btn is-include${cMode === 'include' ? ' active' : ''}" data-act="include">+</button>
                <button type="button" class="nl-pop-state-btn is-exclude${cMode === 'exclude' ? ' active' : ''}" data-act="exclude">−</button>
              </div>
            `;
            camRow.querySelector('.nl-pop-row-label').addEventListener('click', () => {
              setCameraFilterModeDirect(camModel, cMode === 'include' ? null : 'include');
              renderEquipList();
            });
            camRow.querySelector('[data-act="include"]').addEventListener('click', () => {
              setCameraFilterModeDirect(camModel, cMode === 'include' ? null : 'include');
              renderEquipList();
            });
            camRow.querySelector('[data-act="exclude"]').addEventListener('click', () => {
              setCameraFilterModeDirect(camModel, cMode === 'exclude' ? null : 'exclude');
              renderEquipList();
            });
            body.appendChild(camRow);

            const sortedEquipLenses = [...(camObj.lenses || [])].sort((a, b) => {
              const la = String(a.label || a.lens_model || '');
              const lb = String(b.label || b.lens_model || '');
              const aLast = (a.lens_model === '__NONE__' || la === 'レンズ情報なし' || la === '----') ? 1 : 0;
              const bLast = (b.lens_model === '__NONE__' || lb === 'レンズ情報なし' || lb === '----') ? 1 : 0;
              if (aLast !== bLast) return aLast - bLast;
              return la.localeCompare(lb, undefined, { numeric: true, sensitivity: 'base' });
            });
            sortedEquipLenses.forEach(lens => {
              const lensKey = `${camModel}::${lens.lens_model}`;
              const lensLabel = lens.label || lens.lens_model;
              const lMode = (state.lensFilters && state.lensFilters.get(lensKey)) || null;
              const lensRow = document.createElement('div');
              lensRow.className = 'nl-pop-row';
              lensRow.style.paddingLeft = '18px';
              lensRow.innerHTML = `
                <span class="nl-pop-row-label" title="${escapeHtml(camModel)} / ${escapeHtml(lensLabel)}">└ ${escapeHtml(lensLabel)}</span>
                <span class="nl-pop-row-count">${lens.count || 0}</span>
                <div class="nl-pop-state-group">
                  <button type="button" class="nl-pop-state-btn is-include${lMode === 'include' ? ' active' : ''}" data-act="include">+</button>
                  <button type="button" class="nl-pop-state-btn is-exclude${lMode === 'exclude' ? ' active' : ''}" data-act="exclude">−</button>
                </div>
              `;
              lensRow.querySelector('.nl-pop-row-label').addEventListener('click', () => {
                setLensFilterModeDirect(lensKey, lMode === 'include' ? null : 'include');
                renderEquipList();
              });
              lensRow.querySelector('[data-act="include"]').addEventListener('click', () => {
                setLensFilterModeDirect(lensKey, lMode === 'include' ? null : 'include');
                renderEquipList();
              });
              lensRow.querySelector('[data-act="exclude"]').addEventListener('click', () => {
                setLensFilterModeDirect(lensKey, lMode === 'exclude' ? null : 'exclude');
                renderEquipList();
              });
              body.appendChild(lensRow);
            });
          });
        }

        renderEquipList();
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('機材:', (pref) => openEquipmentPopover(pref, null), 'クリックでカメラ・レンズ条件を変更');

    const createEquipPill = (item) => createPill({
      labelHtml: escapeHtml(item.mode === 'exclude' ? `− ${item.label}` : item.label),
      extraClass: item.mode === 'include' ? 'chip-tag-include' : 'chip-tag-exclude',
      title: `${item.label}\n左クリック: 機材条件を変更 ｜ 右クリック: 含む/除外を反転 ｜ ×: 解除`,
      onRemove: () => {
        if (item.kind === 'camera') setCameraFilterModeDirect(item.key, null);
        else setLensFilterModeDirect(item.key, null);
      },
      onClick: (chip) => openEquipmentPopover(chip, item),
      onRightClick: () => {
        const nextM = item.mode === 'include' ? 'exclude' : 'include';
        if (item.kind === 'camera') setCameraFilterModeDirect(item.key, nextM);
        else setLensFilterModeDirect(item.key, nextM);
      },
    });

    camIncludes.forEach((item, idx) => {
      if (idx > 0) clause.appendChild(createOrSpan());
      clause.appendChild(createEquipPill(item));
    });

    if (camExcludes.length > 0) {
      if (camIncludes.length > 0) {
        const exWrap = document.createElement('span');
        exWrap.className = 'nl-except-wrap';
        const op = document.createElement('span');
        op.textContent = '（除く:';
        exWrap.appendChild(op);
        camExcludes.forEach(item => exWrap.appendChild(createEquipPill(item)));
        const cp = document.createElement('span');
        cp.textContent = '）';
        exWrap.appendChild(cp);
        clause.appendChild(exWrap);
      } else {
        camExcludes.forEach((item, idx) => {
          if (idx > 0) {
            const dot = document.createElement('span');
            dot.className = 'nl-or';
            dot.textContent = '・';
            clause.appendChild(dot);
          }
          clause.appendChild(createEquipPill(item));
        });
        const exSuf = document.createElement('span');
        exSuf.className = 'nl-except-wrap';
        exSuf.textContent = 'を除く';
        clause.appendChild(exSuf);
      }
    }

    const addEquipBtn = document.createElement('button');
    addEquipBtn.type = 'button';
    addEquipBtn.className = 'nl-group-add-btn';
    addEquipBtn.title = '別のカメラ・レンズ条件を追加';
    addEquipBtn.textContent = '+';
    addEquipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEquipmentPopover(addEquipBtn, null);
    });
    clause.appendChild(addEquipBtn);
    appendClause(clause);
  }

  // =========================================================================
  // 6. ラボ抽出条件（太陽高度・手ブレ注意・歴代の今日・焦点距離帯・F値帯）
  // =========================================================================
  if (state.labFilter || state.onThisDay || state.focalRange || state.apertureRange) {
    const labLabels = {
      golden_hour: 'マジックアワー',
      blue_hour: 'ブルーアワー',
      magic_all: 'マジック＋ブルーアワー',
      night: '夜景・星景',
      shake_risk: '手ブレ注意',
    };

    const openLabPopover = (anchor) => {
      openNlFilterPopover('lab', anchor, (pop) => {
        buildPopoverHeader(pop, 'ラボ抽出条件の変更', () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('lab');
        }, 'ラボを開く');
        const body = document.createElement('div');
        body.className = 'nl-pop-body';
        const grid = document.createElement('div');
        grid.className = 'nl-pop-option-grid';

        Object.entries(labLabels).forEach(([key, label]) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `nl-pop-option-btn${state.labFilter === key ? ' active' : ''}`;
          btn.textContent = label;
          btn.addEventListener('click', () => {
            state.labFilter = (state.labFilter === key) ? null : key;
            if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
            closeNlFilterPopover();
            fetchPhotos();
          });
          grid.appendChild(btn);
        });

        const clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'nl-pop-option-btn';
        clrBtn.textContent = 'ラボ抽出をすべて解除';
        clrBtn.addEventListener('click', () => {
          state.labFilter = null;
          state.onThisDay = null;
          state.focalRange = null;
          state.focalRangeLabel = null;
          state.apertureRange = null;
          state.apertureRangeLabel = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          closeNlFilterPopover();
          fetchPhotos();
        });
        grid.appendChild(clrBtn);

        body.appendChild(grid);
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('ラボ:', openLabPopover, 'クリックでラボ抽出条件を変更');
    if (state.labFilter) {
      clause.appendChild(createPill({
        labelHtml: escapeHtml(labLabels[state.labFilter] || state.labFilter),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.labFilter = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    if (state.onThisDay) {
      const parts = String(state.onThisDay).split('-');
      const otdLabel = parts.length === 2 ? `歴代の${parseInt(parts[0], 10)}月${parseInt(parts[1], 10)}日` : `歴代の今日: ${state.onThisDay}`;
      clause.appendChild(createPill({
        labelHtml: escapeHtml(otdLabel),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.onThisDay = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    if (state.focalRange) {
      clause.appendChild(createPill({
        labelHtml: escapeHtml(`焦点距離: ${state.focalRangeLabel || state.focalRange}`),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.focalRange = null;
          state.focalRangeLabel = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    if (state.apertureRange) {
      clause.appendChild(createPill({
        labelHtml: escapeHtml(`F値: ${state.apertureRangeLabel || state.apertureRange}`),
        extraClass: 'chip-tag-include',
        onRemove: () => {
          state.apertureRange = null;
          state.apertureRangeLabel = null;
          if (typeof window.updateLabUIState === 'function') window.updateLabUIState();
          fetchPhotos();
        },
        onClick: openLabPopover,
      }));
    }
    appendClause(clause);
  }

  // =========================================================================
  // 7. 評価（レーティング: 標準[0, 1, 2]以外の場合）
  // =========================================================================
  const isDefaultRating = (state.ratingFilter.size === 3 &&
    state.ratingFilter.has(0) && state.ratingFilter.has(1) && state.ratingFilter.has(2));
  if (!isDefaultRating) {
    const rNames = [];
    if (state.ratingFilter.has(2)) rNames.push('優');
    if (state.ratingFilter.has(1)) rNames.push('良');
    if (state.ratingFilter.has(0)) rNames.push('可');
    if (state.ratingFilter.has(-1)) rNames.push('棄');
    const rText = rNames.length > 0 ? `${rNames.join('・')}のみ` : 'なし';

    const openRatingPopover = (anchor) => {
      openNlFilterPopover('rating', anchor, (pop) => {
        buildPopoverHeader(pop, '評価（レーティング）条件の変更');
        const body = document.createElement('div');
        body.className = 'nl-pop-body';
        const grid = document.createElement('div');
        grid.className = 'nl-pop-option-grid';

        const presets = [
          { label: '優のみ', set: [2] },
          { label: '優・良のみ', set: [1, 2] },
          { label: '良のみ', set: [1] },
          { label: '可のみ', set: [0] },
          { label: '棄のみ', set: [-1] },
          { label: '標準に戻す（優・良・可）', set: [0, 1, 2] },
        ];

        presets.forEach(p => {
          const isMatch = state.ratingFilter.size === p.set.length && p.set.every(v => state.ratingFilter.has(v));
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `nl-pop-option-btn${isMatch ? ' active' : ''}`;
          btn.textContent = p.label;
          btn.addEventListener('click', () => {
            state.ratingFilter = new Set(p.set);
            updateRatingFilterUI();
            closeNlFilterPopover();
            fetchPhotos();
          });
          grid.appendChild(btn);
        });

        body.appendChild(grid);
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('評価:', openRatingPopover, 'クリックで評価条件を変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(rText),
      extraClass: 'chip-tag-include',
      title: `評価: ${rText}\n左クリック: 評価条件を変更 ｜ ×: 標準(優・良・可)に戻す`,
      onRemove: () => {
        state.ratingFilter = new Set([0, 1, 2]);
        updateRatingFilterUI();
        fetchPhotos();
      },
      onClick: openRatingPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 8. ファイル種別・属性条件（RAWのみ / 調整済みのみ / JPEGのみ / RAW+JPGペア / XMPあり）
  // =========================================================================
  if (state.attrFilter && state.attrFilter !== 'all') {
    const attrLabels = {
      raw: 'RAWのみ',
      adjusted: '調整済みのみ',
      jpeg: 'JPEG/一般のみ',
      raw_pair: 'RAW+JPGペア',
      xmp: 'XMPあり',
    };

    const openAttrPopover = (anchor) => {
      openNlFilterPopover('attr', anchor, (pop) => {
        buildPopoverHeader(pop, 'ファイル種別・属性条件の変更');
        const body = document.createElement('div');
        body.className = 'nl-pop-body';
        const grid = document.createElement('div');
        grid.className = 'nl-pop-option-grid';

        Object.entries(attrLabels).forEach(([key, label]) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `nl-pop-option-btn${state.attrFilter === key ? ' active' : ''}`;
          btn.textContent = label;
          btn.addEventListener('click', () => {
            closeNlFilterPopover();
            setAttrFilter(key);
          });
          grid.appendChild(btn);
        });

        const clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'nl-pop-option-btn';
        clrBtn.textContent = 'すべて表示（解除）';
        clrBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          setAttrFilter('all');
        });
        grid.appendChild(clrBtn);

        body.appendChild(grid);
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('種別:', openAttrPopover, 'クリックでファイル種別条件を変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(attrLabels[state.attrFilter] || state.attrFilter),
      extraClass: 'chip-tag-include',
      title: '左クリック: ファイル種別を変更 ｜ ×: 解除',
      onRemove: () => setAttrFilter('all'),
      onClick: openAttrPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 9. 未分類 / 接続状態 / 重複条件
  // =========================================================================
  if (state.untaggedOnly) {
    const clause = createClauseBox('タグ:');
    clause.appendChild(createPill({
      labelHtml: '未分類のみ',
      extraClass: 'chip-tag-include',
      onRemove: () => clearAllTagFilters(),
      onClick: () => {
        if (typeof window.openSidebarSection === 'function') window.openSidebarSection('quick');
        setTimeout(() => flashAndScrollToElement(document.getElementById('untaggedNavItem')), 80);
      },
    }));
    appendClause(clause);
  }

  if (state.connectionFilter && state.connectionFilter !== 'all') {
    const connLabels = {
      online: '接続中のみ',
      offline: '未接続のみ',
      duplicates: '重複のある写真',
      unlinked: 'リンク消失の写真',
      missing: 'リンク消失の写真',
    };

    const openConnPopover = (anchor) => {
      openNlFilterPopover('conn', anchor, (pop) => {
        buildPopoverHeader(pop, '状態・重複フィルタの変更');
        const body = document.createElement('div');
        body.className = 'nl-pop-body';
        const grid = document.createElement('div');
        grid.className = 'nl-pop-option-grid';

        [
          { key: 'online', label: '接続中のみ' },
          { key: 'offline', label: '未接続のみ' },
          { key: 'duplicates', label: '重複のある写真' },
          { key: 'unlinked', label: 'リンク消失の写真' },
        ].forEach(opt => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `nl-pop-option-btn${state.connectionFilter === opt.key ? ' active' : ''}`;
          btn.textContent = opt.label;
          btn.addEventListener('click', () => {
            closeNlFilterPopover();
            setConnectionFilter(opt.key);
          });
          grid.appendChild(btn);
        });

        const clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'nl-pop-option-btn';
        clrBtn.textContent = '解除（すべて）';
        clrBtn.addEventListener('click', () => {
          closeNlFilterPopover();
          setConnectionFilter(state.connectionFilter);
        });
        grid.appendChild(clrBtn);

        body.appendChild(grid);
        pop.appendChild(body);
      });
    };

    const clause = createClauseBox('状態:', openConnPopover, 'クリックで状態フィルタを変更');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(connLabels[state.connectionFilter] || state.connectionFilter),
      extraClass: 'chip-tag-include',
      onRemove: () => setConnectionFilter(state.connectionFilter),
      onClick: openConnPopover,
    }));
    appendClause(clause);
  }

  // =========================================================================
  // 10. ファイル名検索クエリ
  // =========================================================================
  if (state.searchQuery && state.searchQuery.trim() !== '') {
    const qText = state.searchQuery.trim();
    const openSearchPopover = (anchor) => {
      openNlFilterPopover('search', anchor, (pop) => {
        buildPopoverHeader(pop, 'ファイル名検索キーワードの変更', () => {
          if (typeof window.openSidebarSection === 'function') window.openSidebarSection('search');
        });
        const wrap = document.createElement('div');
        wrap.className = 'nl-pop-search-wrap';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'nl-pop-search-input';
        inp.value = state.searchQuery;
        inp.placeholder = 'ファイル名を入力してEnter...';
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            state.searchQuery = inp.value.trim();
            if (elements.searchInput) elements.searchInput.value = state.searchQuery;
            if (elements.clearSearchBtn) {
              elements.clearSearchBtn.style.display = state.searchQuery ? 'block' : 'none';
            }
            closeNlFilterPopover();
            fetchPhotos();
          }
        });
        wrap.appendChild(inp);
        pop.appendChild(wrap);
        setTimeout(() => { inp.focus(); inp.select(); }, 30);
      });
    };

    const clause = createClauseBox('検索:', openSearchPopover, 'クリックで検索キーワードを編集');
    clause.appendChild(createPill({
      labelHtml: escapeHtml(`"${qText}"`),
      extraClass: 'chip-tag-include',
      onRemove: () => {
        if (elements.clearSearchBtn) elements.clearSearchBtn.click();
        else {
          state.searchQuery = '';
          fetchPhotos();
        }
      },
      onClick: openSearchPopover,
    }));
    appendClause(clause);
  }

  // アコーディオンヘッダーのフィルタ適用状態（has-filter）同期
  const camAccordion = document.getElementById('accordionItem-camera');
  if (camAccordion) {
    const hasCam = Boolean(
      (state.cameraFilters && state.cameraFilters.size > 0) ||
      (state.lensFilters && state.lensFilters.size > 0) ||
      (state.selectedCameras && state.selectedCameras.size > 0)
    );
    camAccordion.classList.toggle('has-filter', hasCam);
  }
  const labAccordion = document.getElementById('accordionItem-lab');
  if (labAccordion) {
    const hasLab = Boolean(state.labFilter || state.onThisDay || state.focalRange || state.apertureRange);
    labAccordion.classList.toggle('has-filter', hasLab);
  }

  const timelineAccordion = document.getElementById('accordionItem-timeline');
  if (timelineAccordion) {
    const hasTimeline = Boolean(
      (state.selectedYearMonths && state.selectedYearMonths.size > 0) ||
      (state.selectedDates && state.selectedDates.size > 0)
    );
    timelineAccordion.classList.toggle('has-filter', hasTimeline);
  }

  // 垂直タブレール (.rail-tab-btn) へのフィルタ適用インジケータ同期
  const sectionFilterMap = {
    quick: Boolean(state.untaggedOnly || (state.connectionFilter && state.connectionFilter !== 'all') || (state.currentFilter && state.currentFilter.type === 'duplicates')),
    folder: Boolean(state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude' || state.currentFilter.type === 'unlinked')),
    tags: Boolean(state.tagFilters && state.tagFilters.size > 0),
    location: Boolean(state.activeLocation),
    timeline: Boolean((state.selectedYearMonths && state.selectedYearMonths.size > 0) || (state.selectedDates && state.selectedDates.size > 0)),
    camera: Boolean((state.cameraFilters && state.cameraFilters.size > 0) || (state.lensFilters && state.lensFilters.size > 0) || (state.selectedCameras && state.selectedCameras.size > 0)),
    lab: Boolean(state.labFilter || state.onThisDay || state.focalRange || state.apertureRange),
    search: Boolean(state.searchQuery && state.searchQuery.trim().length > 0),
  };
  document.querySelectorAll('#sidebarRail .rail-tab-btn').forEach(btn => {
    const sec = btn.dataset.section;
    if (sec && sec in sectionFilterMap) {
      btn.classList.toggle('has-filter', sectionFilterMap[sec]);
    }
  });

  // サイドバーリセットボタンとフローティングフッターバーの表示制御
  const chipBar = document.getElementById('viewHeaderChipBar');
  const purgeBtn = document.getElementById('purgeUnlinkedBtn');
  const contentArea = document.querySelector('.content-area');
  const isPurgeVisible = purgeBtn && purgeBtn.style.display !== 'none';
  const showFooterBar = Boolean(hasFilter || isPurgeVisible);

  if (chipBar) {
    chipBar.style.display = showFooterBar ? 'flex' : 'none';
  }
  if (clearAllBtn) {
    clearAllBtn.style.display = hasFilter ? 'inline-flex' : 'none';
  }
  if (contentArea) {
    contentArea.classList.toggle('has-floating-filter', showFooterBar);
  }
  if (!showFooterBar) {
    closeNlFilterPopover();
  }

  const resetBtn = document.getElementById('sidebarResetFilterBtn');
  if (resetBtn) {
    resetBtn.classList.toggle('has-active-filter', hasFilter);
  }
}

/**
 * サイドバーのリセットドット更新ヘルパー
 */
function updateSidebarResetDot() {
  renderActiveFilterChips();
}
window.updateSidebarResetDot = updateSidebarResetDot;
window.renderFilterChips = renderActiveFilterChips;
window.renderActiveFilterChips = renderActiveFilterChips;

/**
 * 評価フィルタトグル同期関数
 */
function updateRatingFilterUI() {
  document.querySelectorAll('.rating-filter-toggles .rating-toggle').forEach(btn => {
    const rv = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle('active', state.ratingFilter.has(rv));
  });
}

/**
 * 属性フィルタ（すべて / RAW / 調整済 / 詳細属性セレクト）のUI同期関数
 */
function syncAttrFilterButtons() {
  const cur = state.attrFilter || 'all';
  document.querySelectorAll('#attrFilterToggles .attr-toggle, .attr-toggle[data-attr]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.attr === cur);
  });
  const subSelect = elements.attrSubFilterSelect || document.getElementById('attrSubFilterSelect');
  if (subSelect) {
    if (['jpeg', 'raw_pair', 'xmp'].includes(cur)) {
      subSelect.value = cur;
      subSelect.classList.add('active');
    } else {
      subSelect.value = '';
      subSelect.classList.remove('active');
    }
  }
}
const updateAttrFilterUI = syncAttrFilterButtons;

/**
 * 属性フィルタ（すべて / RAW / 調整済 / JPEG / RAW+JPGペア / XMP）の切替
 */
function setAttrFilter(attr) {
  const nextAttr = attr || 'all';
  // 同じピル（all以外）を再クリックした場合は 'all' に戻すトグル動作
  if (state.attrFilter === nextAttr && nextAttr !== 'all') {
    state.attrFilter = 'all';
  } else {
    state.attrFilter = nextAttr;
  }
  syncAttrFilterButtons();
  fetchPhotos();
}
window.syncAttrFilterButtons = syncAttrFilterButtons;
window.updateAttrFilterUI = updateAttrFilterUI;
window.setAttrFilter = setAttrFilter;

/**
 * 評価フィルタの6パターン遷移ロジック
 * デフォルト: 優・良・可 [0, 1, 2] (棄以外すべて)
 * パターン1: 優・良・可 [0, 1, 2]
 * パターン2: 優と良 [1, 2]
 * パターン3: 優だけ [2]
 * パターン4: 良だけ [1]
 * パターン5: 可だけ [0] (他と独立)
 * パターン6: 棄だけ [-1] (他と独立)
 */
function toggleRatingFilter(rating) {
  const isDefault = (state.ratingFilter.size === 3 &&
    state.ratingFilter.has(0) && state.ratingFilter.has(1) && state.ratingFilter.has(2));

  if (rating === 0) {
    // 「可」をクリック
    if (isDefault) {
      state.ratingFilter = new Set([1, 2]);
    } else if (state.ratingFilter.size === 1 && state.ratingFilter.has(0)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([0]);
    }
  } else if (rating === -1) {
    // 「棄」をクリック
    if (state.ratingFilter.size === 1 && state.ratingFilter.has(-1)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([-1]);
    }
  } else if (rating === 2) {
    // 「優」をクリック
    if (isDefault) {
      state.ratingFilter = new Set([2]);
    } else if (state.ratingFilter.has(0) || state.ratingFilter.has(-1)) {
      state.ratingFilter = new Set([2]);
    } else if (state.ratingFilter.has(1) && state.ratingFilter.has(2)) {
      state.ratingFilter = new Set([1]);
    } else if (state.ratingFilter.has(2) && !state.ratingFilter.has(1)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([1, 2]);
    }
  } else if (rating === 1) {
    // 「良」をクリック
    if (isDefault) {
      state.ratingFilter = new Set([1]);
    } else if (state.ratingFilter.has(0) || state.ratingFilter.has(-1)) {
      state.ratingFilter = new Set([1]);
    } else if (state.ratingFilter.has(1) && state.ratingFilter.has(2)) {
      state.ratingFilter = new Set([2]);
    } else if (state.ratingFilter.has(1) && !state.ratingFilter.has(2)) {
      state.ratingFilter = new Set([0, 1, 2]);
    } else {
      state.ratingFilter = new Set([1, 2]);
    }
  }
}

/**
 * 接続状態フィルタUIの更新関数
 */
function updateConnectionFilterUI() {
  const onlineNav = elements.onlineOnlyNavItem || document.getElementById('onlineOnlyNavItem');
  const offlineNav = elements.offlineOnlyNavItem || document.getElementById('offlineOnlyNavItem');
  const unlinkedNav = elements.unlinkedOnlyNavItem || document.getElementById('unlinkedOnlyNavItem');
  const folderTreeUnlinked = elements.folderTreeUnlinkedItem || document.getElementById('folderTreeUnlinkedItem');
  const dupNav = elements.duplicatesOnlyNavItem || document.getElementById('duplicatesOnlyNavItem');

  if (onlineNav) onlineNav.classList.toggle('active', state.connectionFilter === 'online');
  if (offlineNav) offlineNav.classList.toggle('active', state.connectionFilter === 'offline');
  if (unlinkedNav) unlinkedNav.classList.toggle('active', state.connectionFilter === 'unlinked');
  if (folderTreeUnlinked) folderTreeUnlinked.classList.toggle('active', state.connectionFilter === 'unlinked');
  if (dupNav) dupNav.classList.toggle('active', state.connectionFilter === 'duplicates');
}

/**
 * 接続状態フィルタの切替（トグル）
 */
function setConnectionFilter(type) {
  if (state.connectionFilter === type) {
    state.connectionFilter = 'all';
    if (state.currentFilter.type === 'all') {
      elements.viewTitle.textContent = 'すべての写真';
    }
  } else {
    state.connectionFilter = type;
    if (type === 'online') {
      elements.viewTitle.textContent = '接続中の写真';
    } else if (type === 'offline') {
      elements.viewTitle.textContent = '未接続の写真';
    } else if (type === 'unlinked' || type === 'missing') {
      elements.viewTitle.textContent = 'リンク消失の写真（実体パス未登録）';
    } else if (type === 'duplicates') {
      elements.viewTitle.textContent = '重複のある写真';
    }
  }
  state.onlineOnly = (state.connectionFilter === 'online');
  updateConnectionFilterUI();
  fetchPhotos();
}

/**
 * すべてのフィルタを一括解除して初期状態に戻す
 */
function resetAllFilters() {
  // 1. フィルタ条件のリセット
  state.ratingFilter = new Set([0, 1, 2]);
  updateRatingFilterUI();

  state.attrFilter = 'all';
  updateAttrFilterUI();

  state.searchQuery = '';
  if (elements.searchInput) elements.searchInput.value = '';
  if (elements.clearSearchBtn) elements.clearSearchBtn.style.display = 'none';

  state.tagFilters.clear();
  if (state.tagAndRoots) state.tagAndRoots.clear();
  state.tagInterGroupMode = 'and';
  state.selectedYearMonths.clear();
  if (state.selectedDates) state.selectedDates.clear();
  state.lastClickedCalendarDate = null;
  state.selectedCameras.clear();
  if (state.cameraFilters) state.cameraFilters.clear();
  if (state.lensFilters) state.lensFilters.clear();
  if (state.selectedLenses) state.selectedLenses.clear();
  state.labFilter = null;
  state.onThisDay = null;
  state.focalRange = null;
  state.focalRangeLabel = null;
  state.apertureRange = null;
  state.apertureRangeLabel = null;
  if (typeof window.updateLabUIState === 'function') {
    window.updateLabUIState();
  }
  state.untaggedOnly = false;
  state.connectionFilter = 'all';
  state.onlineOnly = false;
  state.activeLocation = null;
  if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();

  // 2. 表示・ソート設定を標準状態にリセット
  // ソート順: 新しい順
  state.sortBy = 'date_taken DESC';
  if (elements.sortBySelect) elements.sortBySelect.value = 'date_taken DESC';
  localStorage.setItem('pm_sort_by', 'date_taken DESC');

  // サムネイルサイズ: 230px
  if (elements.thumbnailSizeSlider) elements.thumbnailSizeSlider.value = '230';
  document.documentElement.style.setProperty('--thumbnail-size', '230px');
  localStorage.setItem('pm_thumbnail_size', '230');

  // レイアウトモード: 通常グリッド
  setLayoutMode('grid');
  localStorage.setItem('pm_view_mode', 'grid');

  // 情報表示モード: 通常表示 (クリーン表示解除)
  if (state.isMinimalView) {
    toggleMinimalView(false);
  }
  localStorage.setItem('pm_minimal_view', 'false');

  // スタック表示: ON
  state.isStacked = true;
  if (elements.toggleStackBtn) elements.toggleStackBtn.classList.add('active');
  localStorage.setItem('pm_stacked', 'true');

  // タグ種別フィルタ: 手動 (デフォルト)
  state.tagSourceFilter = 'manual';
  localStorage.setItem('pm_tag_source_filter', 'manual');

  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');
  updateConnectionFilterUI();
  renderTagList();
  updateCameraActiveClasses();
  if (typeof updateTimelineActiveClasses === 'function') updateTimelineActiveClasses();
  if (state.activePresetId !== undefined) {
    state.activePresetId = null;
    if (window.renderFilterPresetsList) window.renderFilterPresetsList();
    if (window.renderPresetCurrentChips) window.renderPresetCurrentChips();
  }
  setFilter('all', null, 'すべての写真');
}

window.updateRatingFilterUI = updateRatingFilterUI;
window.toggleRatingFilter = toggleRatingFilter;
window.updateConnectionFilterUI = updateConnectionFilterUI;
window.setConnectionFilter = setConnectionFilter;
window.resetAllFilters = resetAllFilters;


/**
 * ヘッダー表示（タイトル・件数・フィルタチップ）の更新
 */
function updateViewHeader() {
  const countText = state.isLimitReached
    ? `${state.photos.length}+ 枚 (表示上限)`
    : `${state.photos.length} 枚`;
  elements.currentCountBadge.textContent = countText;

  // 適用中フィルタチップの描画
  renderActiveFilterChips();
  if (window.renderPresetCurrentChips) window.renderPresetCurrentChips();
}

function setFilter(type, value, titleText) {
  if (type !== 'year_month' && type !== 'year_months') {
    state.selectedYearMonths.clear();
    if (state.selectedDates) state.selectedDates.clear();
  } else if (type === 'year_month' && value) {
    state.selectedYearMonths.clear();
    if (state.selectedDates) state.selectedDates.clear();
    state.selectedYearMonths.add(value);
    const yr = value.split('-')[0];
    if (yr) state.expandedTimelineYears.add(yr);
  }

  if (type !== 'camera' && type !== 'cameras') {
    state.selectedCameras.clear();
    if (state.cameraFilters) state.cameraFilters.clear();
    if (state.lensFilters) state.lensFilters.clear();
    if (state.selectedLenses) state.selectedLenses.clear();
  } else if (type === 'camera' && value) {
    state.selectedCameras.clear();
    state.selectedCameras.add(value);
    if (state.cameraFilters) {
      state.cameraFilters.clear();
      state.cameraFilters.set(value, 'include');
    }
  }

  // ジオタグフィルタのリセット（フォルダやクイックアクセス等への移動時）
  if (state.activeLocation) {
    state.activeLocation = null;
    if (typeof updateLocationTreeActiveState === 'function') updateLocationTreeActiveState();
  }

  if ((type === 'folder' || type === 'folder_exclude') && value) {
    revealFolderInTree(value);
  }

  state.currentFilter = { type, value };
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');
  elements.viewTitle.textContent = titleText;

  // サイドバーのアクティブクラス更新（通常nav-item ＆ フォルダツリー項目）
  document.querySelectorAll('.sidebar .nav-item, .sidebar .folder-tree-item').forEach(el => {
    const isFolderType = (type === 'folder' || type === 'folder_exclude') && el.dataset.filterType === 'folder';
    const isExactMatch = isFolderType ? (el.dataset.filterValue === value) : (el.dataset.filterType === type && (!value || el.dataset.filterValue === value));
    
    if (isExactMatch) {
      if (type === 'folder_exclude') {
        el.classList.remove('active');
        el.classList.add('active-exclude');
      } else {
        el.classList.remove('active-exclude');
        el.classList.add('active');
      }
    } else {
      el.classList.remove('active', 'active-exclude');
    }
  });

  if (typeof window.syncFolderTreeFilterStates === 'function') {
    window.syncFolderTreeFilterStates();
  }
  updateTimelineActiveClasses();
  updateCameraActiveClasses();
  fetchPhotos();
}

/**
 * 指定写真を現在の一覧から除去する（評価フィルタ外になった写真用）。
 * グリッドは該当カードのみ削除し、選択状態・Shift範囲選択の起点・ライトボックス位置を補正する。
 */
function removePhotoFromView(photoId) {
  const photoIdx = state.photos.findIndex(p => p.id === photoId);
  if (photoIdx === -1) return;  // スタック展開中のメンバー等、一覧に無い写真は対象外
  const wasSingleFocused = (
    state.currentPhotoIndex < 0 &&
    ((state.selectedPhotoIds.size === 1 && state.selectedPhotoIds.has(photoId)) ||
     (state.selectedPhotoIds.size === 0 && state.activeInspectorPhotoId === photoId))
  );
  state.photos.splice(photoIdx, 1);

  // 選択状態のクリーンアップ
  if (state.selectionBaseIds) state.selectionBaseIds.delete(photoId);
  if (state.selectedPhotoIds.has(photoId)) {
    state.selectedPhotoIds.delete(photoId);
    updateCardSelectionClasses();
    updateSelectionUI();
  }

  // Shift範囲選択の起点インデックスの補正
  if (state.lastSelectedIndex !== -1) {
    if (state.lastSelectedIndex === photoIdx) {
      state.lastSelectedIndex = -1;
    } else if (photoIdx < state.lastSelectedIndex) {
      state.lastSelectedIndex--;
    }
  }
  if (state.selectionAnchorIndex !== undefined && state.selectionAnchorIndex !== -1) {
    if (state.selectionAnchorIndex === photoIdx) {
      state.selectionAnchorIndex = -1;
    } else if (photoIdx < state.selectionAnchorIndex) {
      state.selectionAnchorIndex--;
    }
  }

  if (state.photos.length === 0) {
    // 0枚になった場合（空状態UI）は安全に全再描画する
    renderPhotoGrid();
  } else {
    if (photoIdx < renderedGridCount) {
      renderedGridCount = Math.max(0, renderedGridCount - 1);
    }
    // 該当カードのみDOMから削除し、以降のカードの dataset.index を振り直す
    const grid = elements.photoGrid || document.getElementById('photoGrid');
    const card = grid ? grid.querySelector(`.photo-card[data-photo-id="${photoId}"]`) : null;
    if (card) {
      let sibling = card.nextElementSibling;
      while (sibling) {
        if (sibling.classList && sibling.classList.contains('photo-card')) {
          const curIdx = parseInt(sibling.dataset.index, 10);
          if (!isNaN(curIdx)) sibling.dataset.index = curIdx - 1;
        }
        sibling = sibling.nextElementSibling;
      }
      card.remove();
    }
    checkAndAppendGridChunksIfNeeded();

    // 単一フォーカス中の写真が評価変更等で一覧から除外された場合、次の写真へ自動的にフォーカスを引き継ぐ
    if (wasSingleFocused && state.photos.length > 0) {
      const nextIdx = Math.min(photoIdx, state.photos.length - 1);
      const nextPhoto = state.photos[nextIdx];
      if (nextPhoto) {
        state.selectedPhotoIds.clear();
        state.selectedPhotoIds.add(nextPhoto.id);
        state.lastSelectedIndex = nextIdx;
        state.selectionAnchorIndex = nextIdx;
        state.activeInspectorPhotoId = nextPhoto.id;
        updateCardSelectionClasses();
        updateSelectionUI();
      }
    }
  }

  // ヘッダー件数表示の更新
  updateViewHeader();

  // ライトボックス表示中なら currentPhotoIndex との整合を調整
  if (state.currentPhotoIndex >= 0) {
    if (state.photos.length === 0) {
      closeLightbox();
    } else if (photoIdx === state.currentPhotoIndex) {
      // 表示中の写真自体が除外された場合は次の写真（末尾なら直前の写真）を表示
      if (state.currentPhotoIndex >= state.photos.length) {
        state.currentPhotoIndex = state.photos.length - 1;
      }
      state.currentRotation = 0;
      resetLightboxZoom();
      loadLightboxPhoto();
      renderFilmstrip();
    } else {
      if (photoIdx < state.currentPhotoIndex) state.currentPhotoIndex--;
      renderFilmstrip();
    }
  }
}

/**
 * 評価の更新 (API送信)
 */
async function updatePhotoRating(photoId, newRating) {
  try {
    // ローカル状態の更新
    const target = state.photos.find(p => p.id === photoId);
    if (target) {
      target.rating = newRating;
    }

    // スタック内の該当写真オブジェクトも同期更新
    state.photos.forEach(p => {
      if (p.stack_photos) {
        const sm = p.stack_photos.find(sp => sp.id === photoId);
        if (sm) sm.rating = newRating;
      }
    });
    if (state.currentLightboxStackPhotos) {
      const sm = state.currentLightboxStackPhotos.find(sp => sp.id === photoId);
      if (sm) sm.rating = newRating;
    }

    // プレビュー中ならライトボックス側の評価も更新
    const curLight = getCurrentLightboxPhoto();
    if (curLight && curLight.id === photoId) {
      curLight.rating = newRating;
      updateLightboxRating(newRating);
    }

    // インスペクタで表示中の写真なら、インスペクタ内の評価ボタンactive状態も即時更新
    if (state.activeInspectorPhotoId === photoId && elements.inspectorRatingBtns) {
      elements.inspectorRatingBtns.querySelectorAll('.rating-btn').forEach(b => {
        const bVal = parseInt(b.dataset.rating, 10);
        b.classList.toggle('active', bVal === newRating);
      });
    }

    // グリッド上の写真カードDOMを直接更新（超高速・チラつきなし）
    updateCardRatingDirectly(photoId, newRating);

    // 新しい評価が評価フィルタに含まれない場合（既定では「棄」）は、その写真だけを一覧から除去する。
    // フィルタに含まれる場合は上記のDOM部分更新のみで、グリッドの全再描画は行わない。
    const isFilteredOut = state.ratingFilter && state.ratingFilter.size > 0 && !state.ratingFilter.has(newRating);
    if (isFilteredOut) {
      removePhotoFromView(photoId);
    }

    const response = await fetch(`/api/photo/${photoId}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: newRating }),
    });

    if (!response.ok) throw new Error('評価の更新に失敗しました');

    if (state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.has(photoId)) {
      state.activeInspectorPhotoId = photoId;
    }
  } catch (error) {
    console.error('評価更新エラー:', error);
    showToast('評価の更新に失敗しました', 'error');
  }
}

/**
 * ライトボックス (全画面プレビュー) を開く

 */
/**
 * アコーディオン式サイドバーの初期化（排他的制御: 展開できるメニューは1つのみ）
 */
function initSidebarAccordion() {
  const sidebar = document.getElementById('sidebar');
  const items = document.querySelectorAll('.sidebar-accordion .accordion-item');
  const railBtns = document.querySelectorAll('#sidebarRail .rail-tab-btn');
  if (!items.length || !sidebar) return;

  // 2段階サイドバー用：現在選択中のタブセクション名（常に1つを表示）
  const STORAGE_KEY = 'pm_accordion_active_section';
  const validSections = new Set(['quick', 'folder', 'tags', 'location', 'timeline', 'camera', 'lab', 'search']);
  let activeSection = 'quick';

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && validSections.has(saved)) {
      activeSection = saved;
    }
  } catch (e) {
    activeSection = 'quick';
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, activeSection || 'quick');
    } catch (e) {}
  }

  function syncRailButtons() {
    const isMenuVisible = state.isSidebarOpen || sidebar.classList.contains('is-overlay-open');
    railBtns.forEach(btn => {
      const sec = btn.dataset.section;
      btn.classList.toggle('active', isMenuVisible && sec === activeSection);
    });
  }
  window.syncSidebarRailActiveState = syncRailButtons;

  function applyActiveSection() {
    if (!activeSection || !validSections.has(activeSection)) {
      activeSection = 'quick';
    }
    items.forEach(item => {
      const sec = item.dataset.section;
      const isOpen = (sec === activeSection);
      item.classList.toggle('is-open', isOpen);
    });
    syncRailButtons();
    saveState();

    const isMenuVisible = state.isSidebarOpen || sidebar.classList.contains('is-overlay-open');
    if (!isMenuVisible) return;

    // 検索セクションが開いた場合は入力欄にフォーカス
    if (activeSection === 'search' && elements.searchInput) {
      setTimeout(() => elements.searchInput.focus(), 80);
    }
    // クイックアクセスが開いた場合はチップ描画
    if ((activeSection === 'quick' || activeSection === 'presets') && window.renderPresetCurrentChips) {
      window.renderPresetCurrentChips();
    }
    // フォルダセクションが開いた場合は初回ロード確認
    if (activeSection === 'folder' && typeof window.loadFolderTree === 'function') {
      const folderList = document.getElementById('folderList');
      if (!folderList || folderList.children.length === 0 || folderList.querySelector('.empty-hint')) {
        window.loadFolderTree();
      }
    }
    // 場所セクションが開いた場合はツリーを最新化
    if (activeSection === 'location' && window.loadLocationTree) {
      window.loadLocationTree();
    }
  }

  function setSectionOpen(sectionName, isOpen) {
    if (isOpen && validSections.has(sectionName)) {
      activeSection = sectionName;
      if (!state.isSidebarOpen) {
        sidebar.classList.add('is-overlay-open');
      }
    } else if (!isOpen && !state.isSidebarOpen) {
      sidebar.classList.remove('is-overlay-open');
    }
    applyActiveSection();
  }

  function toggleSection(sectionName) {
    if (!validSections.has(sectionName)) return;
    if (!state.isSidebarOpen) {
      // メニューオフ（アイコン列のみ）モード時：
      // 既にオーバーレイ表示中の同じタブを押したらオーバーレイを閉じ、別タブならオーバーレイ展開して切替
      const isOverlayOpen = sidebar.classList.contains('is-overlay-open');
      if (isOverlayOpen && activeSection === sectionName) {
        sidebar.classList.remove('is-overlay-open');
      } else {
        activeSection = sectionName;
        sidebar.classList.add('is-overlay-open');
      }
    } else {
      // 通常ドック表示モード時：即座にセクション切替
      activeSection = sectionName;
    }
    applyActiveSection();
  }

  // 初期開閉状態を反映
  applyActiveSection();

  // 左端 垂直タブレール (.rail-tab-btn) のクリックでメニューエリアを切替（メニューオフ時はオーバーレイ展開）
  railBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sectionName = btn.dataset.section;
      if (sectionName) {
        toggleSection(sectionName);
      }
    });
  });

  // オーバーレイ展開中にサイドバー外側（写真グリッドやヘッダー等）をクリックしたら自動でオーバーレイを閉じる
  document.addEventListener('mousedown', (e) => {
    if (!state.isSidebarOpen && sidebar.classList.contains('is-overlay-open')) {
      if (!sidebar.contains(e.target) && !e.target.closest('.modal-overlay, .context-menu')) {
        sidebar.classList.remove('is-overlay-open');
        syncRailButtons();
      }
    }
  });

  // 各セクションのヘッダークリック互換
  items.forEach(item => {
    const header = item.querySelector('.accordion-header');
    if (!header) return;
    header.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) {
        return;
      }
      const sectionName = item.dataset.section;
      if (sectionName) {
        toggleSection(sectionName);
      }
    });
  });

  // 外部公開・互換API
  window.openSidebarSection = (sectionName) => {
    setSectionOpen(sectionName, true);
    const item = document.getElementById(`accordionItem-${sectionName}`);
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
  window.closeSidebarSection = (sectionName) => {
    if (activeSection === sectionName) {
      setSectionOpen(sectionName, false);
    }
  };
  window.toggleSidebarSection = toggleSection;

  // 旧APIとの互換レイヤー
  window.openFilterDrawer = (tabName) => window.openSidebarSection(tabName);
  window.closeFilterDrawer = () => {};
  window.toggleFilterDrawer = (tabName) => window.toggleSidebarSection(tabName);
  window.isFilterDrawerOpen = () => true;
  window.switchSidebarTab = (tabName) => window.openSidebarSection(tabName);
}

/**
 * イベントリスナー設定
 */
function setupEventListeners() {
  // アコーディオン式サイドバーの初期化
  initSidebarAccordion();

  // ヘッダー右端「メニュー (⚙)」ドロップダウンの開閉制御
  const sysMenuBtn = document.getElementById('headerSystemMenuBtn');
  const sysDropdown = document.getElementById('headerSystemDropdown');
  const sysWrap = document.getElementById('headerSystemMenuWrap');
  if (sysMenuBtn && sysDropdown) {
    sysMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = sysDropdown.style.display !== 'none';
      sysDropdown.style.display = isOpen ? 'none' : 'flex';
      sysMenuBtn.classList.toggle('active', !isOpen);
    });
    // メニュー項目（設定・スマホ・ヘルプ・終了）クリック時にドロップダウンを自動で閉じる（テーマ・言語トグルは開いたまま確認可能）
    ['folderDbMaintenanceBtn', 'openMobileModalBtn', 'openHelpModalBtn', 'openShutdownModalBtn'].forEach(btnId => {
      const b = document.getElementById(btnId);
      if (b) {
        b.addEventListener('click', () => {
          sysDropdown.style.display = 'none';
          sysMenuBtn.classList.remove('active');
        });
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (sysDropdown.style.display !== 'none' && sysWrap && !sysWrap.contains(e.target)) {
        sysDropdown.style.display = 'none';
        sysMenuBtn.classList.remove('active');
      }
    });
  }

  // 左サイドバー開閉ボタン
  if (elements.toggleSidebarBtn) {
    elements.toggleSidebarBtn.addEventListener('click', () => toggleSidebar());
  }

  // インスペクタのタブ切替イベント初期化
  document.querySelectorAll('.inspector-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchInspectorTab(btn.dataset.tab);
    });
  });
  switchInspectorTab(state.inspectorActiveTab);

  // ウィンドウリサイズ時、連写・ブラケット展開状態であれば下部タブが隠れないよう高さを再調整
  window.addEventListener('resize', () => {
    if (elements.inspectorBracketList && !elements.inspectorBracketList.classList.contains('is-collapsed') && elements.inspectorBracketExpanderBtn && elements.inspectorBracketExpanderBtn.style.display !== 'none') {
      const safeMax = elements.inspectorBody ? Math.max(180, elements.inspectorBody.clientHeight - 150) : 380;
      elements.inspectorBracketList.style.maxHeight = `${Math.min(380, safeMax)}px`;
    }
  });

  // ヘッダーツールバーの自動レスポンシブ（幅が狭まった際の段階的なアイコン化判定）
  const appHeader = document.querySelector('.app-header');
  if (appHeader && window.ResizeObserver) {
    const headerObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        appHeader.classList.toggle('toolbar-compact-1', w < 1550);
        appHeader.classList.toggle('toolbar-compact-2', w < 1350);
        appHeader.classList.toggle('toolbar-compact-3', w < 1150);
      }
    });
    headerObserver.observe(appHeader);
  }

  // フォルダツリーの全展開 / 全折りたたみボタン
  const expandAllFoldersBtn = document.getElementById('expandAllFoldersBtn');
  const collapseAllFoldersBtn = document.getElementById('collapseAllFoldersBtn');

  if (expandAllFoldersBtn) {
    expandAllFoldersBtn.addEventListener('click', () => {
      expandFolderTreeToManaged();
    });
  }

  if (collapseAllFoldersBtn) {
    collapseAllFoldersBtn.addEventListener('click', () => {
      collapseFolderTree();
    });
  }

  // フォルダツリーの再読込（ドライブの抜き差し後など）
  const reloadFolderTreeBtn = document.getElementById('reloadFolderTreeBtn');
  if (reloadFolderTreeBtn) {
    reloadFolderTreeBtn.addEventListener('click', () => {
      fetchFolders();
    });
  }

  // 表示レイアウト切替（グリッド / びっしり / マウント）
  elements.modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      setLayoutMode(mode);
    });
  });

  // カラーパレットエキスパンダの開閉イベント
  const colorHeader = elements.colorPaletteHeader || document.getElementById('colorPaletteHeader');
  if (colorHeader && !colorHeader.dataset.bound) {
    colorHeader.dataset.bound = 'true';
    colorHeader.addEventListener('click', () => {
      toggleColorPaletteExpander();
    });
    colorHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleColorPaletteExpander();
      }
    });
  }

  // タグアコーディオンの開閉（存在する場合）
  if (elements.tagAccordionHeader) {
    elements.tagAccordionHeader.addEventListener('click', (e) => {
      if (e.target.closest('#openAddTagInputBtn')) return;
      if (elements.tagSection) elements.tagSection.classList.toggle('collapsed');
    });
  }

  // タグ新規作成インライン入力のトグル
  if (elements.openAddTagInputBtn) {
    elements.openAddTagInputBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (elements.tagSection) elements.tagSection.classList.remove('collapsed');
      if (window.openSidebarSection) window.openSidebarSection('tags');
      if (elements.inlineTagCreate) elements.inlineTagCreate.style.display = 'flex';
      if (elements.newTagNameInput) elements.newTagNameInput.focus();
    });
  }

  elements.cancelCreateTagBtn.addEventListener('click', () => {
    elements.inlineTagCreate.style.display = 'none';
    elements.newTagNameInput.value = '';
  });

  // 新規タグ作成実行
  const executeCreateTag = async () => {
    const tagName = elements.newTagNameInput.value.trim();
    if (!tagName) return;

    // 現在選択中の写真があればそれに追加、なければ単にリストに反映
    if (state.photos.length > 0) {
      await fetch(`/api/photo/${state.photos[0].id}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tagName }),
      });
    }
    elements.inlineTagCreate.style.display = 'none';
    elements.newTagNameInput.value = '';
    await fetchTags();
    await fetchPhotos();
  };

  elements.confirmCreateTagBtn.addEventListener('click', executeCreateTag);
  elements.newTagNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeCreateTag();
    if (e.key === 'Escape') elements.cancelCreateTagBtn.click();
  });

  // タグ名テキスト絞り込み (Enter確定)
  if (elements.tagSearchInput) {
    elements.tagSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        state.tagSearchQuery = elements.tagSearchInput.value.trim();
        if (elements.clearTagSearchBtn) {
          elements.clearTagSearchBtn.style.display = state.tagSearchQuery ? 'flex' : 'none';
        }
        renderTagList();
      } else if (e.key === 'Escape') {
        elements.tagSearchInput.value = '';
        state.tagSearchQuery = '';
        if (elements.clearTagSearchBtn) {
          elements.clearTagSearchBtn.style.display = 'none';
        }
        renderTagList();
        elements.tagSearchInput.blur();
      }
    });

    elements.tagSearchInput.addEventListener('input', () => {
      // 入力欄が完全に空になったら自動で全表示に戻す
      if (elements.tagSearchInput.value.trim() === '' && state.tagSearchQuery !== '') {
        state.tagSearchQuery = '';
        if (elements.clearTagSearchBtn) {
          elements.clearTagSearchBtn.style.display = 'none';
        }
        renderTagList();
      } else if (elements.clearTagSearchBtn) {
        elements.clearTagSearchBtn.style.display = elements.tagSearchInput.value ? 'flex' : 'none';
      }
    });
  }

  if (elements.clearTagSearchBtn) {
    elements.clearTagSearchBtn.addEventListener('click', () => {
      if (elements.tagSearchInput) {
        elements.tagSearchInput.value = '';
        elements.tagSearchInput.focus();
      }
      state.tagSearchQuery = '';
      elements.clearTagSearchBtn.style.display = 'none';
      renderTagList();
    });
  }

  // タグフィルタ一括クリア
  elements.clearTagFiltersBtn.addEventListener('click', () => {
    clearAllTagFilters();
  });

  // 未分類写真フィルタ (Untagged)
  elements.untaggedNavItem.addEventListener('click', () => {
    state.untaggedOnly = true;
    state.tagFilters.clear();
    state.currentFilter = { type: 'untagged', value: null };
    elements.viewTitle.textContent = '未分類の写真';

    document.querySelectorAll('.sidebar .nav-item').forEach(el => el.classList.remove('active'));
    elements.untaggedNavItem.classList.add('active');
    renderTagList();
    fetchPhotos();
  });

  // ライトボックス内タグ追加
  const executeLightboxAddTag = () => {
    const val = elements.lightboxNewTagInput.value.trim();
    if (!val || state.currentPhotoIndex < 0) return;
    const photo = getCurrentLightboxPhoto();
    if (photo) {
      addTagToCurrentPhoto(photo.id, val);
    }
  };

  elements.lightboxAddTagBtn.addEventListener('click', executeLightboxAddTag);
  elements.lightboxNewTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeLightboxAddTag();
  });

  // 露出ブラケット・連写スタック表示切替（色でON/OFFを識別）
  if (elements.toggleStackBtn) {
    elements.toggleStackBtn.addEventListener('click', () => {
      state.isStacked = !state.isStacked;
      elements.toggleStackBtn.classList.toggle('active', state.isStacked);
      localStorage.setItem('pm_stacked', state.isStacked ? 'true' : 'false');
      fetchPhotos();
    });
  }

  // 絞り込み全解除ボタン（左サイドバー最上部）
  const sidebarResetFilterBtn = document.getElementById('sidebarResetFilterBtn');
  if (sidebarResetFilterBtn) {
    sidebarResetFilterBtn.addEventListener('click', resetAllFilters);
  }

  // 情報表示切替（詳細 / クリーン）
  elements.toggleInfoBtn.addEventListener('click', () => {
    toggleMinimalView();
  });



  // 写真ファイル選択ボタン & input
  elements.uploadFilesBtn.addEventListener('click', () => {
    elements.fileUploadInput.click();
  });

  elements.fileUploadInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await uploadPhotos(files);
      elements.fileUploadInput.value = '';
    }
  });

  // ドラッグ＆ドロップ アップロード処理（外部からの実ファイルドロップ時のみオーバーレイを表示）
  let dragCounter = 0;
  const isExternalFileDrag = (e) => {
    if (window._draggingPhotoIds && window._draggingPhotoIds.length > 0) return false;
    if (window._draggingTagNode) return false;
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    return Array.from(e.dataTransfer.types).includes('Files');
  };

  window.addEventListener('dragenter', (e) => {
    if (!isExternalFileDrag(e)) {
      dragCounter = 0;
      if (elements.dragDropOverlay) elements.dragDropOverlay.style.display = 'none';
      return;
    }
    e.preventDefault();
    dragCounter++;
    elements.dragDropOverlay.style.display = 'flex';
  });

  window.addEventListener('dragleave', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      elements.dragDropOverlay.style.display = 'none';
      dragCounter = 0;
    }
  });

  window.addEventListener('dragover', (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    if (!isExternalFileDrag(e)) return;
    e.preventDefault();
    dragCounter = 0;
    elements.dragDropOverlay.style.display = 'none';

    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      await uploadPhotos(e.dataTransfer.files);
    }
  });

  // サムネイルサイズスライダー
  elements.thumbnailSizeSlider.addEventListener('input', (e) => {
    const size = e.target.value;
    document.documentElement.style.setProperty('--thumbnail-size', `${size}px`);
    localStorage.setItem('pm_thumbnail_size', size);
    checkAndAppendGridChunksIfNeeded();
  });

  // 検索入力（デバウンス付き）
  let searchTimeout = null;
  elements.searchInput.addEventListener('input', (e) => {
    const val = e.target.value;
    elements.clearSearchBtn.style.display = val ? 'block' : 'none';
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.searchQuery = val;
      fetchPhotos();
    }, 250);
  });

  elements.clearSearchBtn.addEventListener('click', () => {
    elements.searchInput.value = '';
    elements.clearSearchBtn.style.display = 'none';
    state.searchQuery = '';
    fetchPhotos();
  });

  // ソート順変更
  elements.sortBySelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    localStorage.setItem('pm_sort_by', state.sortBy);
    fetchPhotos();
  });

  // 評価フィルタトグルボタン（ヘッダー ＆ クイックタブ両方を一括監視・双方向同期）
  document.querySelectorAll('.rating-filter-toggles .rating-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const rv = parseInt(btn.dataset.rating, 10);
      toggleRatingFilter(rv);
      updateRatingFilterUI();
      fetchPhotos();
    });
  });

  // 属性フィルタピル（すべて / RAW / 調整済）＆ 詳細属性セレクト（jpeg / raw_pair / xmp）
  document.querySelectorAll('#attrFilterToggles .attr-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      setAttrFilter(btn.dataset.attr || 'all');
    });
  });

  const attrSubSelect = elements.attrSubFilterSelect || document.getElementById('attrSubFilterSelect');
  if (attrSubSelect) {
    attrSubSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      setAttrFilter(val || 'all');
    });
  }

  if (elements.onlineOnlyNavItem) {
    elements.onlineOnlyNavItem.addEventListener('click', () => setConnectionFilter('online'));
  }
  if (elements.offlineOnlyNavItem) {
    elements.offlineOnlyNavItem.addEventListener('click', () => setConnectionFilter('offline'));
  }
  if (elements.unlinkedOnlyNavItem) {
    elements.unlinkedOnlyNavItem.addEventListener('click', () => setConnectionFilter('unlinked'));
  }
  if (elements.folderTreeUnlinkedItem) {
    elements.folderTreeUnlinkedItem.addEventListener('click', () => setConnectionFilter('unlinked'));
  }
  if (elements.duplicatesOnlyNavItem) {
    elements.duplicatesOnlyNavItem.addEventListener('click', () => setConnectionFilter('duplicates'));
  }

  // リンク消失写真の一括完全消去ボタン
  if (elements.purgeUnlinkedBtn) {
    elements.purgeUnlinkedBtn.addEventListener('click', async () => {
      const confirmed = confirm(
        'リンク消失しているすべての写真レコード（サムネイル・タグ含む）をDBから完全に消去しますか？\n' +
        'この操作は取り消せません。'
      );
      if (!confirmed) return;

      try {
        const res = await fetch('/api/photos/purge-unlinked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '消去に失敗しました');
        showToast(`${data.purged}枚の写真レコードを完全に消去しました`, 'success');
        setConnectionFilter('all');
        await refreshAll();
      } catch (err) {
        showToast('消去エラー: ' + err.message, 'error');
      }
    });
  }

  // サイドバーのクイックアクセス（すべての写真）
  document.querySelectorAll('.sidebar [data-filter-type="all"]').forEach(el => {
    el.addEventListener('click', () => {
      state.connectionFilter = 'all';
      state.onlineOnly = false;
      updateConnectionFilterUI();
      setFilter('all', null, 'すべての写真');
    });
  });

  // 空状態のアクションボタン（左サイドバーのフォルダ一覧タブを開く）
  if (elements.emptyStateActionBtn) {
    elements.emptyStateActionBtn.addEventListener('click', () => {
      if (window.openSidebarSection) window.openSidebarSection('folder');
    });
  }

  // --- フォルダ専用コンテキストメニューのイベント登録 ---
  // 1. 直下のみ再スキャン
  if (elements.folderMenuRescanDirect) {
    elements.folderMenuRescanDirect.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing) {
        showToast('実フォルダが存在しないか、ドライブが未接続のため再スキャンできません', 'warning');
        return;
      }
      showToast(`「${node.name}」の直下を再スキャン中...`, 'info');
      await executeScan(node.fullPath, false, false);
    });
  }

  // 2. 配下も含めて再スキャン
  if (elements.folderMenuRescanRecursive) {
    elements.folderMenuRescanRecursive.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing) {
        showToast('実フォルダが存在しないか、ドライブが未接続のため再スキャンできません', 'warning');
        return;
      }
      // ドライブ全体やルート種別の場合は警告ダイアログを表示
      const isDriveRoot = /^[a-zA-Z]:\\?$/.test(node.fullPath);
      if (isDriveRoot) {
        const msg = `「${node.name}」はドライブ全体です。配下のすべてのサブフォルダをスキャンすると時間がかかる場合があります。\n\nスキャンを開始しますか？`;
        if (!confirm(msg)) return;
      }
      showToast(`「${node.name}」配下を再帰スキャン中...`, 'info');
      await executeScan(node.fullPath, true, false);
    });
  }

  // 2-B. ♻️ リフレッシュ（再スキャン＋消失写真のDB削除・配下含む）
  if (elements.folderMenuRefresh) {
    elements.folderMenuRefresh.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing || node.isOffline) {
        showToast('ドライブが未接続または実フォルダが存在しないためリフレッシュできません', 'warning');
        return;
      }
      const msg = `フォルダ「${node.name}」内の写真フォルダを再スキャンし、PC上から移動・削除された写真をライブラリから削除（リフレッシュ）します。\n\nよろしいですか？`;
      if (!confirm(msg)) return;

      showToast(`「${node.name}」をリフレッシュ中（消失写真のDB整理を含む）...`, 'info');
      await executeScan(node.fullPath, true, true);
    });
  }

  // 2-C. 🤖 AIタグ付け
  if (elements.folderMenuAiTag) {
    elements.folderMenuAiTag.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      const msg = `フォルダ「${node.name}」配下の写真にAIタグを付与しますか？\n（※すでにタグ付け済みの写真はスキップされます）`;
      if (!confirm(msg)) return;

      try {
        showToast(`「${node.name}」のAIタグ付けを開始しました...`, 'info');
        const res = await fetch('/api/ai/tag-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath, recursive: true }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || 'AIタグ付けの開始に失敗しました');
        }
        if (typeof window.startAiProgressPolling === 'function') {
          window.startAiProgressPolling();
        } else if (typeof startAiProgressPolling === 'function') {
          startAiProgressPolling();
        }
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 3. 管理から外す（DB解除）※未接続フォルダでも解除可能
  if (elements.folderMenuUnmanage) {
    elements.folderMenuUnmanage.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      const isRootKind = (node.kind === 'drive' || node.kind === 'shortcut' || node.kind === 'offline');
      const count = node.totalCount > 0 ? node.totalCount : node.count;
      const msg = `${isRootKind ? 'ドライブ' : 'フォルダ'}「${node.name}」（写真 ${count}枚）をライブラリから除外しますか？\n\n（※PC上の実ファイル本体は削除されません）`;
      if (!confirm(msg)) return;

      try {
        const res = await fetch('/api/folders', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath, recursive: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '除外に失敗しました');

        showToast(`「${node.name}」を管理から外しました (${data.deleted_count}枚解除)`, 'info');
        await refreshAll();
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 4. 管理対象外（除外設定）
  const handleIgnoreFolder = async () => {
    const node = _activeFolderNode;
    closeFolderContextMenu();
    if (!node) return;

    const msg = `フォルダ「${node.name}」を管理対象外（除外）に設定しますか？\n\n・ライブラリから登録解除されます\n・今後、親フォルダを再スキャンしても自動登録されなくなります\n（※PC上の実ファイル本体は削除されません）`;
    if (!confirm(msg)) return;

    try {
      const res = await fetch('/api/folders/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: node.fullPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '除外設定に失敗しました');

      showToast(`「${node.name}」を管理対象外に設定しました`, 'info');
      await refreshAll();
    } catch (err) {
      showToast(`エラー: ${err.message}`, 'error');
    }
  };
  if (elements.folderMenuIgnoreFromManaged) {
    elements.folderMenuIgnoreFromManaged.addEventListener('click', handleIgnoreFolder);
  }
  if (elements.folderMenuIgnoreFromUnmanaged) {
    elements.folderMenuIgnoreFromUnmanaged.addEventListener('click', handleIgnoreFolder);
  }

  // 5. 除外を解除（未管理に戻す）
  if (elements.folderMenuUnignore) {
    elements.folderMenuUnignore.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;

      try {
        const res = await fetch('/api/folders/ignore', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '除外解除に失敗しました');

        showToast(`「${node.name}」の除外を解除しました`, 'success');
        await refreshAll();
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 6. 管理に追加してスキャン
  const handleAddAndScan = async () => {
    const node = _activeFolderNode;
    closeFolderContextMenu();
    if (!node) return;
    if (node.isMissing) {
      showToast('実フォルダが存在しないか、ドライブが未接続のためスキャンできません', 'warning');
      return;
    }

    showToast(`「${node.name}」を管理に追加・スキャン中...`, 'info');
    await executeScan(node.fullPath, false, false);
  };
  if (elements.folderMenuAddAndScan) {
    elements.folderMenuAddAndScan.addEventListener('click', handleAddAndScan);
  }
  if (elements.folderMenuAddFromIgnored) {
    elements.folderMenuAddFromIgnored.addEventListener('click', handleAddAndScan);
  }

  // 7. エクスプローラーで開く
  if (elements.folderMenuOpenExplorer) {
    elements.folderMenuOpenExplorer.addEventListener('click', async () => {
      const node = _activeFolderNode;
      closeFolderContextMenu();
      if (!node) return;
      if (node.isMissing) {
        showToast('実フォルダが存在しないか、ドライブが未接続のためエクスプローラーで開けません', 'warning');
        return;
      }

      try {
        const res = await fetch('/api/folders/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder_path: node.fullPath }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.detail || 'フォルダを開けませんでした');
        }
        showToast('フォルダを開きました', 'info', 2000);
      } catch (err) {
        showToast(`エラー: ${err.message}`, 'error');
      }
    });
  }

  // 8. メインエリア警告バナーの再確認ボタン
  if (elements.warningBannerReloadBtn) {
    elements.warningBannerReloadBtn.addEventListener('click', async () => {
      showToast('ドライブ・フォルダの接続状態を確認中...', 'info');
      try {
        await fetchFolders();
        if (state.currentFilter.type === 'folder') {
          await fetchPhotos();
        }
        showToast('接続状態を更新しました', 'success');
      } catch (err) {
        showToast(`更新エラー: ${err.message}`, 'error');
      }
    });
  }

  // キーボードショートカット (Picasa & Tiat流)
  window.addEventListener('keydown', (e) => {
    // モーダルや入力欄にフォーカスがある場合は無効
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    // ヘルプモーダル表示中
    if (elements.helpModal && elements.helpModal.style.display !== 'none') {
      if (e.key === 'Escape') {
        closeHelpModal();
      } else if (e.key === '?' || e.key === 'F1') {
        e.preventDefault();
        toggleHelpModal();
      }
      return;
    }

    // 終了モーダル表示中
    if (elements.shutdownModal && elements.shutdownModal.style.display !== 'none') {
      if (e.key === 'Escape') {
        closeShutdownModal();
      }
      return;
    }

    // スマホ連携モーダル表示中
    if (elements.mobileConnectModal && elements.mobileConnectModal.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeMobileModal === 'function') {
        closeMobileModal();
      }
      return;
    }

    // スマホ選別取り込み完了通知モーダル表示中
    const syncResultModalEl = document.getElementById('mobileSyncResultModal');
    if (syncResultModalEl && syncResultModalEl.style.display !== 'none') {
      if ((e.key === 'Escape' || e.key === 'Enter') && typeof closeMobileSyncResultModal === 'function') {
        closeMobileSyncResultModal();
      }
      return;
    }

    // DBメンテナンスモーダル表示中
    if (elements.dbMaintenanceModal && elements.dbMaintenanceModal.style.display !== 'none') {
      if (e.key === 'Escape') {
        elements.dbMaintenanceModal.style.display = 'none';
      }
      return;
    }

    // スマートテイクアウトモーダル表示中
    const smartTakeoutEl = document.getElementById('smartTakeoutModal');
    if (smartTakeoutEl && smartTakeoutEl.style.display !== 'none') {
      return;
    }

    // 撮影日時一括シフトモーダル表示中
    const dateShiftModalEl = elements.dateShiftModal || document.getElementById('dateShiftModal');
    if (dateShiftModalEl && dateShiftModalEl.style.display !== 'none') {
      if (e.key === 'Escape' && typeof window.closeDateShiftModal === 'function') {
        window.closeDateShiftModal();
      }
      return;
    }

    // タグ完全削除確認モーダル表示中
    if (elements.deleteTagModal && elements.deleteTagModal.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeDeleteTagModal === 'function') {
        closeDeleteTagModal(false);
      }
      return;
    }

    // フォルダ管理登録確認モーダル表示中 (v2.02)
    if (elements.registerFolderModal && elements.registerFolderModal.style.display !== 'none') {
      if (e.key === 'Escape' && typeof closeRegisterFolderModal === 'function') {
        closeRegisterFolderModal(null);
      }
      return;
    }

    // ? または F1 キーでヘルプモーダル開閉
    if (e.key === '?' || e.key === 'F1') {
      e.preventDefault();
      toggleHelpModal();
      return;
    }

    // [ キー または b / B キー で左サイドバー開閉
    if ((e.key === '[' || e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.altKey && !e.metaKey && state.currentPhotoIndex === -1) {
      toggleSidebar();
      return;
    }
    // Ctrl+B でも左サイドバー開閉
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B') && state.currentPhotoIndex === -1) {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    // d キーで右インスペクタ開閉
    if ((e.key === 'd' || e.key === 'D') && state.currentPhotoIndex === -1) {
      toggleInspector();
      return;
    }

    // Ctrl+A で全選択
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      if (state.currentPhotoIndex === -1) {
        e.preventDefault();
        selectAllPhotos();
        return;
      }
    }

    // Esc でドロワーまたは選択解除 (プレビュー外)
    if (e.key === 'Escape' && state.currentPhotoIndex === -1) {
      if (typeof isFilterDrawerOpen === 'function' && isFilterDrawerOpen()) {
        closeFilterDrawer();
        return;
      }
      if (state.selectedPhotoIds.size > 0) {
        clearSelection();
        return;
      }
    }

    // Shiftキー押下時にホバー中カードがあれば即座に範囲プレビューを表示
    if (e.key === 'Shift' && state.currentPhotoIndex === -1) {
      if (currentHoveredCardIndex !== -1 && state.lastSelectedIndex !== -1 && state.selectedPhotoIds.size > 0) {
        updateShiftPreview(currentHoveredCardIndex);
      }
    }

    // トーン調整のコピー (Ctrl+Shift+C) / ペースト (Ctrl+Shift+V) / 画像クリップボードコピー (Ctrl+C)
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        let targetPhoto = null;
        if (state.currentPhotoIndex >= 0) {
          targetPhoto = getCurrentLightboxPhoto();
        } else if (state.selectedPhotoIds.size > 0) {
          const firstId = Array.from(state.selectedPhotoIds)[0];
          targetPhoto = state.photos.find(p => p.id === firstId);
        } else if (state.activeInspectorPhotoId) {
          targetPhoto = state.photos.find(p => p.id === state.activeInspectorPhotoId);
        }
        if (targetPhoto && typeof window.copyPhotoToneAdjustments === 'function') {
          window.copyPhotoToneAdjustments(targetPhoto);
        }
        return;
      }
      if (e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        let targetIds = [];
        if (state.currentPhotoIndex >= 0) {
          const cur = getCurrentLightboxPhoto();
          if (cur) targetIds = [cur.id];
        } else if (state.selectedPhotoIds.size > 0) {
          targetIds = Array.from(state.selectedPhotoIds);
        } else if (state.activeInspectorPhotoId) {
          targetIds = [state.activeInspectorPhotoId];
        }
        if (targetIds.length > 0 && typeof window.batchPastePhotoToneAdjustments === 'function') {
          window.batchPastePhotoToneAdjustments(targetIds);
        }
        return;
      }
      if (!e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        // テキスト選択中であればブラウザ標準のテキストコピーを優先
        const selText = window.getSelection ? window.getSelection().toString().trim() : '';
        if (!selText) {
          let targetPhoto = null;
          if (state.currentPhotoIndex >= 0) {
            targetPhoto = getCurrentLightboxPhoto();
          } else if (state.selectedPhotoIds.size > 0) {
            const firstId = Array.from(state.selectedPhotoIds)[0];
            targetPhoto = state.photos.find(p => p.id === firstId);
          } else if (state.activeInspectorPhotoId) {
            targetPhoto = state.photos.find(p => p.id === state.activeInspectorPhotoId);
          }
          if (targetPhoto && typeof window.copyPhotoImageToClipboard === 'function') {
            e.preventDefault();
            window.copyPhotoImageToClipboard(targetPhoto);
            return;
          }
        }
      }
    }

    // ライトボックス表示中のショートカット
    if (state.currentPhotoIndex >= 0) {
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigatePhoto(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigatePhoto(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateStackByVerticalKey('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateStackByVerticalKey('down');
      } else if (e.key === '1') {
        // 1キーで優 (rating = 2)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, 2);
        }
      } else if (e.key === '2') {
        // 2キーで良 (rating = 1)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, 1);
        }
      } else if (e.key === '3') {
        // 3キーで棄 (rating = -1)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, -1);
        }
      } else if (e.key === '0' || e.key === '4') {
        // 0 または 4キーでキャンセル (可: rating = 0)
        const current = getCurrentLightboxPhoto();
        if (current) {
          updatePhotoRating(current.id, 0);
        }
      } else if (e.key === 'x' || e.key === 'X') {
        // Xキーで棄 (トグル)
        const current = getCurrentLightboxPhoto();
        if (current) {
          const newRating = current.rating === -1 ? 0 : -1;
          updatePhotoRating(current.id, newRating);
        }
      } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Rキーで時計回りに90度回転
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(current.id, 90);
        }
      } else if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Lキーで反時計回りに90度回転
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(current.id, -90);
        }
      } else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Cキーでクロップ・画像調整モーダルを開く
        e.preventDefault();
        const current = getCurrentLightboxPhoto();
        if (current && typeof window.openImageAdjustModal === 'function') {
          window.openImageAdjustModal(current);
        }
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        closeLightbox();
      }
    } else {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        navigateGridByArrow(e.key, e.shiftKey);
      } else if (e.key === ' ' || e.key === 'Enter') {
        // 選択中の写真（または最初の写真）をライトボックスで開く
        if (state.photos.length > 0) {
          e.preventDefault();
          let targetIdx = state.lastSelectedIndex;
          if (targetIdx < 0 || targetIdx >= state.photos.length) {
            if (state.selectedPhotoIds.size > 0) {
              const firstId = Array.from(state.selectedPhotoIds)[0];
              targetIdx = state.photos.findIndex(p => p.id === firstId);
            }
          }
          if (targetIdx < 0 || targetIdx >= state.photos.length) {
            targetIdx = 0;
          }
          openLightbox(targetIdx);
        }
      } else if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // i キーで情報表示ON/OFFトグル
        toggleMinimalView();
      } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Rキーで選択写真を時計回りに90度回転
        e.preventDefault();
        const ids = Array.from(state.selectedPhotoIds);
        if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
          window.batchRotatePhotosQuick(ids, 90);
        } else if (state.activeInspectorPhotoId && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(state.activeInspectorPhotoId, 90);
        }
      } else if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Lキーで選択写真を反時計回りに90度回転
        e.preventDefault();
        const ids = Array.from(state.selectedPhotoIds);
        if (ids.length > 0 && typeof window.batchRotatePhotosQuick === 'function') {
          window.batchRotatePhotosQuick(ids, -90);
        } else if (state.activeInspectorPhotoId && typeof window.rotatePhotoQuick === 'function') {
          window.rotatePhotoQuick(state.activeInspectorPhotoId, -90);
        }
      } else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Cキーで選択写真（またはアクティブ写真）のクロップ・画像調整モーダルを開く
        e.preventDefault();
        let targetPhoto = null;
        if (state.selectedPhotoIds.size > 0) {
          const firstId = Array.from(state.selectedPhotoIds)[0];
          targetPhoto = state.photos.find(p => p.id === firstId);
        } else if (state.activeInspectorPhotoId) {
          targetPhoto = state.photos.find(p => p.id === state.activeInspectorPhotoId);
        }
        if (targetPhoto && typeof window.openImageAdjustModal === 'function') {
          window.openImageAdjustModal(targetPhoto);
        }
      } else if (e.key === '1') {
        // 選択写真に優
        applyRatingToSelection(2);
      } else if (e.key === '2') {
        // 選択写真に良
        applyRatingToSelection(1);
      } else if (e.key === '3') {
        // 選択写真に棄
        applyRatingToSelection(-1);
      } else if (e.key === '0' || e.key === '4') {
        // 選択写真の評価取消 (可)
        applyRatingToSelection(0);
      } else if (e.key === 'x' || e.key === 'X') {
        // 選択写真に棄
        applyRatingToSelection(-1);
      }
    }
  });

  // Shiftキーを離した際に範囲プレビューを解除し、ベース選択を確定
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      clearShiftPreview();
      state.selectionBaseIds = null;
    }
  });

  window.addEventListener('blur', () => {
    clearShiftPreview();
    state.selectionBaseIds = null;
  });

  // 写真グリッドへのイベント委譲を一括初期化（個別リスナー生成を排除）
  setupPhotoGridDelegation();

  // フィルムストリップのインタラクション初期化（ホイール横スクロール & ドラッグスクロール）
  initFilmstripInteractions();

  // ライトボックスのズーム＆パン操作（ホイール・ドラッグ・ダブルクリック）初期化
  initLightboxZoomInteractions();
}

let _zoomBadgeTimer = null;

/**
 * ズーム倍率バッジの表示

 */
/**
 * 一覧グリッド表示中の矢印キー移動（← → ↑ ↓ ＆ Shift範囲選択）
 * 通常グリッド・びっしり（Justified）・スライドマウントのすべてで実座標から上下行を判定する。
 */
function navigateGridByArrow(key, isShift = false) {
  const total = state.photos.length;
  if (total === 0 || !elements.photoGrid) return;

  // 現在の基準インデックスを特定
  let curIdx = state.lastSelectedIndex;
  if (curIdx < 0 || curIdx >= total) {
    if (state.activeInspectorPhotoId) {
      curIdx = state.photos.findIndex(p => p.id === state.activeInspectorPhotoId);
    }
  }
  if (curIdx < 0 || curIdx >= total) {
    if (state.selectedPhotoIds.size > 0) {
      const firstId = Array.from(state.selectedPhotoIds)[0];
      curIdx = state.photos.findIndex(p => p.id === firstId);
    }
  }

  let targetIdx = 0;

  if (curIdx < 0) {
    // 未選択時は先頭カードを選択
    targetIdx = 0;
  } else if (key === 'ArrowRight') {
    targetIdx = Math.min(total - 1, curIdx + 1);
  } else if (key === 'ArrowLeft') {
    targetIdx = Math.max(0, curIdx - 1);
  } else if (key === 'ArrowDown' || key === 'ArrowUp') {
    // 下方向移動時は十分なチャンクがDOM上に描画されていることを保証
    if (key === 'ArrowDown') {
      ensureCardsRenderedUpTo(Math.min(total, curIdx + 40));
    } else {
      ensureCardsRenderedUpTo(curIdx + 1);
    }

    const curCard = elements.photoGrid.querySelector(`.photo-card[data-index="${curIdx}"]`);
    const curRect = curCard ? curCard.getBoundingClientRect() : null;

    if (curRect && (curRect.width > 0 || curRect.height > 0)) {
      const curCenterX = curRect.left + curRect.width / 2;
      const curCenterY = curRect.top + curRect.height / 2;
      const rowThreshold = Math.max(18, curRect.height * 0.45);

      let targetRowCenterY = null;
      let targetRowHeight = curRect.height;
      let bestIdx = curIdx;
      let bestDistX = Infinity;

      if (key === 'ArrowDown') {
        for (let i = curIdx + 1; i < renderedGridCount; i++) {
          const c = elements.photoGrid.querySelector(`.photo-card[data-index="${i}"]`);
          if (!c) continue;
          const r = c.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          const cx = r.left + r.width / 2;

          if (targetRowCenterY === null) {
            if (cy - curCenterY > rowThreshold) {
              targetRowCenterY = cy;
              targetRowHeight = r.height || curRect.height;
              bestIdx = i;
              bestDistX = Math.abs(cx - curCenterX);
            }
          } else {
            if (Math.abs(cy - targetRowCenterY) <= Math.max(18, targetRowHeight * 0.45)) {
              const distX = Math.abs(cx - curCenterX);
              if (distX < bestDistX) {
                bestDistX = distX;
                bestIdx = i;
              }
            } else if (cy - targetRowCenterY > Math.max(18, targetRowHeight * 0.45)) {
              // さらに次の行に入ったので探索終了
              break;
            }
          }
        }
      } else {
        for (let i = curIdx - 1; i >= 0; i--) {
          const c = elements.photoGrid.querySelector(`.photo-card[data-index="${i}"]`);
          if (!c) continue;
          const r = c.getBoundingClientRect();
          const cy = r.top + r.height / 2;
          const cx = r.left + r.width / 2;

          if (targetRowCenterY === null) {
            if (curCenterY - cy > rowThreshold) {
              targetRowCenterY = cy;
              targetRowHeight = r.height || curRect.height;
              bestIdx = i;
              bestDistX = Math.abs(cx - curCenterX);
            }
          } else {
            if (Math.abs(cy - targetRowCenterY) <= Math.max(18, targetRowHeight * 0.45)) {
              const distX = Math.abs(cx - curCenterX);
              if (distX < bestDistX) {
                bestDistX = distX;
                bestIdx = i;
              }
            } else if (targetRowCenterY - cy > Math.max(18, targetRowHeight * 0.45)) {
              // さらに上の行に入ったので探索終了
              break;
            }
          }
        }
      }
      targetIdx = bestIdx;
    } else {
      // レイアウト座標が取得できない環境（テスト等）のフォールバック（4列換算）
      targetIdx = key === 'ArrowDown'
        ? Math.min(total - 1, curIdx + 4)
        : Math.max(0, curIdx - 4);
    }
  }

  ensureCardsRenderedUpTo(targetIdx + 1);
  const targetPhoto = state.photos[targetIdx];
  if (!targetPhoto) return;

  if (isShift) {
    if (state.selectionAnchorIndex === undefined || state.selectionAnchorIndex < 0 || state.selectionAnchorIndex >= total) {
      state.selectionAnchorIndex = curIdx >= 0 ? curIdx : targetIdx;
    }
    const start = Math.min(state.selectionAnchorIndex, targetIdx);
    const end = Math.max(state.selectionAnchorIndex, targetIdx);
    state.selectedPhotoIds.clear();
    for (let i = start; i <= end; i++) {
      if (state.photos[i]) {
        state.selectedPhotoIds.add(state.photos[i].id);
      }
    }
    state.lastSelectedIndex = targetIdx;
    state.activeInspectorPhotoId = targetPhoto.id;
    clearShiftPreview();
    updateCardSelectionClasses();
    updateSelectionUI();
  } else {
    state.selectedPhotoIds.clear();
    state.selectedPhotoIds.add(targetPhoto.id);
    state.lastSelectedIndex = targetIdx;
    state.selectionAnchorIndex = targetIdx;
    state.selectionBaseIds = null;
    clearShiftPreview();
    state.activeInspectorPhotoId = targetPhoto.id;
    updateCardSelectionClasses();
    updateSelectionUI();
  }

  const targetCard = elements.photoGrid.querySelector(`.photo-card[data-index="${targetIdx}"]`);
  if (targetCard && typeof targetCard.scrollIntoView === 'function') {
    targetCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  checkAndAppendGridChunksIfNeeded();
}
window.navigateGridByArrow = navigateGridByArrow;

function setupPhotoGridDelegation() {
  if (!elements.photoGrid) return;

  // 1. クリックイベントの委譲
  elements.photoGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;

    const photoId = parseInt(card.dataset.photoId, 10);
    const index = parseInt(card.dataset.index, 10);
    const photo = state.photos[index];
    if (!photo) return;

    // (A) スタックバッジ / フォーマットバッジクリック（インスペクタを開く）
    const badge = e.target.closest('.stack-badge, .format-badge');
    if (badge) {
      e.stopPropagation();
      state.selectedPhotoIds.clear();
      state.selectedPhotoIds.add(photo.id);
      state.lastSelectedIndex = index;
      state.selectionAnchorIndex = index;
      state.activeInspectorPhotoId = photo.id;
      updateCardSelectionClasses();
      updateSelectionUI();
      toggleInspector(true);
      showSingleInspector(photo);
      return;
    }

    // (B) チェックボックスクリック
    const checkbox = e.target.closest('.card-select-checkbox');
    if (checkbox) {
      e.stopPropagation();
      if (e.shiftKey) {
        rangeSelectPhotos(index);
      } else {
        togglePhotoSelection(photo.id, index);
      }
      return;
    }

    // (C) 評価バーボタンクリック
    const ratingBarBtn = e.target.closest('.card-rating-bar-btn');
    if (ratingBarBtn) {
      e.stopPropagation();
      const rating = parseInt(ratingBarBtn.dataset.rating, 10);
      const newRating = (photo.rating === rating) ? 0 : rating;
      photo.rating = newRating;
      updateCardRatingDirectly(photo.id, newRating);
      updatePhotoRating(photo.id, newRating);
      return;
    }

    // (D) カード本体クリック（選択・インスペクタ同期・またはビューワ）
    if (e.ctrlKey || e.metaKey) {
      togglePhotoSelection(photo.id, index);
    } else if (e.shiftKey) {
      rangeSelectPhotos(index);
    } else if (state.selectedPhotoIds.size > 1) {
      // 複数選択モード中のクリックはトグル
      togglePhotoSelection(photo.id, index);
    } else {
      // ダブルクリックの2回目クリック(e.detail >= 2)で既に同一写真が単一選択済みの場合は、
      // 直後の dblclick → openLightbox を妨げないようインスペクタ再構築をスキップ
      if (
        e.detail >= 2 &&
        state.selectedPhotoIds.size === 1 &&
        state.selectedPhotoIds.has(photo.id) &&
        state.activeInspectorPhotoId === photo.id
      ) {
        return;
      }
      // 単一選択（updateSelectionUI 内で updateInspectorView も1回呼ばれる）
      state.selectedPhotoIds.clear();
      state.selectedPhotoIds.add(photo.id);
      state.lastSelectedIndex = index;
      state.selectionAnchorIndex = index;
      state.selectionBaseIds = null;
      clearShiftPreview();
      state.activeInspectorPhotoId = photo.id;
      updateCardSelectionClasses();
      updateSelectionUI();
    }
  });

  // 1-2. マウスホバーによるShift範囲プレビュー（Googleフォト風）
  elements.photoGrid.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;
    const index = parseInt(card.dataset.index, 10);
    currentHoveredCardIndex = index;

    if (e.shiftKey && state.lastSelectedIndex !== -1 && state.selectedPhotoIds.size > 0) {
      updateShiftPreview(index);
    }
  });

  elements.photoGrid.addEventListener('mouseleave', () => {
    currentHoveredCardIndex = -1;
    clearShiftPreview();
  });

  // 2. ダブルクリックイベントの委譲（常にライトボックスを開く）
  elements.photoGrid.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;

    // チェックボックスや評価ボタンのクリック時はダブルクリック動作を無視
    if (e.target.closest('.card-select-checkbox, .card-rating-bar, .card-rating-icon')) return;

    const photoId = parseInt(card.dataset.photoId, 10);
    const index = parseInt(card.dataset.index, 10);
    const photo = state.photos[index];
    if (!photo) return;

    e.stopPropagation();
    const alreadySingleSelected = (
      state.selectedPhotoIds.size === 1 &&
      state.selectedPhotoIds.has(photo.id) &&
      state.activeInspectorPhotoId === photo.id
    );
    if (!alreadySingleSelected) {
      state.selectedPhotoIds.clear();
      state.selectedPhotoIds.add(photo.id);
      state.lastSelectedIndex = index;
      state.activeInspectorPhotoId = photo.id;
      updateCardSelectionClasses();
      updateSelectionUI();
    }

    openLightbox(index);
  });

  // 3. 右クリック（コンテキストメニュー）イベントの委譲
  elements.photoGrid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.photo-card');
    if (!card) return;

    e.preventDefault();
    e.stopPropagation();

    const photoId = parseInt(card.dataset.photoId, 10);
    const index = parseInt(card.dataset.index, 10);

    if (!state.selectedPhotoIds.has(photoId)) {
      if (!e.ctrlKey && !e.shiftKey) {
        state.selectedPhotoIds.clear();
      }
      state.selectedPhotoIds.add(photoId);
      state.lastSelectedIndex = index;
      updateCardSelectionClasses();
      updateSelectionUI();
    }
    openContextMenu(e.clientX, e.clientY);
  });
}

/**
 * レイアウトモード切り替え（grid / masonry / mount）
 */
function setLayoutMode(mode) {
  state.viewMode = mode;
  localStorage.setItem('pm_view_mode', mode);
  document.body.classList.remove('layout-masonry', 'layout-mount');

  if (mode === 'masonry') {
    document.body.classList.add('layout-masonry');
  } else if (mode === 'mount') {
    document.body.classList.add('layout-mount');
  }

  // ボタンのアクティブ更新
  elements.modeButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  checkAndAppendGridChunksIfNeeded();
}

/**
 * 情報表示ON/OFF（クリーン表示）切り替え（色でON/OFFを識別）
 */
function toggleMinimalView(forcedState) {
  state.isMinimalView = (forcedState !== undefined) ? forcedState : !state.isMinimalView;
  document.body.classList.toggle('minimal-view', state.isMinimalView);
  // 情報が表示されている状態（isMinimalView === false）を active（点灯）とする
  elements.toggleInfoBtn.classList.toggle('active', !state.isMinimalView);
  localStorage.setItem('pm_minimal_view', state.isMinimalView ? 'true' : 'false');
  checkAndAppendGridChunksIfNeeded();
}

/**
 * ファイルアップロード処理 (ドラッグ＆ドロップまたはファイル選択: Base64方式)
 */
async function uploadPhotos(fileList) {
  const validExtPattern = /\.(jpg|jpeg|png|webp|bmp|gif|tiff|tif|heic|heif|avif|rw2|arw|cr2|cr3|nef|nrw|dng|raf|orf|pef|srw|x3f|xmp|pp3|arp|dop|on1|cos|nksc|spd)$/i;
  const validFiles = Array.from(fileList).filter(f => (f.type && f.type.startsWith('image/')) || validExtPattern.test(f.name || ''));
  if (validFiles.length === 0) {
    alert('画像ファイル（JPEG, PNG, WebP等）が選択されていません');
    return;
  }

  try {
    elements.uploadFilesBtn.disabled = true;
    elements.uploadFilesBtn.textContent = '取り込み中...';

    // 各ファイルをBase64に変換
    const readAsBase64 = (file) => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ filename: file.name, content_base64: reader.result });
        reader.onerror = error => reject(error);
        reader.readAsDataURL(file);
      });
    };

    const payloadFiles = await Promise.all(validFiles.map(readAsBase64));
    const uploadBody = { files: payloadFiles };
    if (
      state.currentFilter &&
      state.currentFilter.type === 'folder' &&
      state.currentFilter.value &&
      typeof window.isStoragePath === 'function' &&
      window.isStoragePath(state.currentFilter.value)
    ) {
      uploadBody.destination = state.currentFilter.value;
    }

    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uploadBody),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || '取り込み失敗');

    console.log(`[UPLOAD] ${data.uploaded_count}枚の写真を取り込みました`);
    showToast(`${data.uploaded_count}枚の写真を storage に取り込みました`, 'success', 3500);
    if (typeof window.refreshStorageFolders === 'function') {
      await window.refreshStorageFolders();
    }
    await refreshAll();
  } catch (err) {
    showToast(`取り込みエラー: ${err.message}`, 'error');
  } finally {
    elements.uploadFilesBtn.disabled = false;
    const isEn = (window.pmI18n && typeof window.pmI18n.getLang === 'function' && window.pmI18n.getLang() === 'en');
    elements.uploadFilesBtn.textContent = isEn ? 'Import' : '取り込み';
  }
}
const handleFileUpload = uploadPhotos;
window.uploadPhotos = uploadPhotos;
window.handleFileUpload = handleFileUpload;

let _diffChecking = false;

/**
 * フォルダ選択時にバックグラウンドで差分または管理状態を高速判定し、
 * 未登録フォルダなら登録確認、管理下フォルダで変更があれば段階的リフレッシュを提案する
 */
async function checkAndPromptFolderRefresh(folderPath, folderName, node) {
  if (!folderPath || _diffChecking) return;
  _diffChecking = true;
  try {
    const res = await fetch('/api/folders/check-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
    });
    if (!res.ok) return;
    const diff = await res.json();
    if (!diff.is_valid) return;

    const name = folderName || folderPath;

    // 【ケース1: 管理外フォルダをクリックした場合 (v2.02: 子フォルダ含む/直下のみ/キャンセル 3段階選択)】
    if (!diff.is_managed) {
      // ドライブ全体（C:\ など）やショートカット、除外設定フォルダなら登録確認はスキップ
      if (node && (node.kind === 'drive' || node.status === 'ignored')) return;
      if (/^[a-zA-Z]:\\?$/.test(folderPath)) return;

      const choice = typeof showRegisterFolderModal === 'function'
        ? await showRegisterFolderModal(folderPath, name, diff.total_disk || 0)
        : (confirm(`管理外のフォルダです。管理フォルダとして登録しますか？`) ? 'direct' : null);

      if (!choice) return;

      const isRecursive = choice === 'recursive';
      const rangeText = isRecursive ? '（子フォルダ含む）' : '（直下のみ）';
      showToast(`「${name}」を管理フォルダとして登録・スキャン中${rangeText}...`, 'info');
      await executeScan(folderPath, isRecursive, false);
      return;
    }

    // 【ケース2: 管理下フォルダをクリックした場合（差分がある場合のみ更新提案）】
    if (!diff.has_changes) return;

    // 第1ダイアログ: リフレッシュ提案
    const changeDetails = [];
    if (diff.added > 0) changeDetails.push(`新規追加: ${diff.added}枚`);
    if (diff.deleted > 0) changeDetails.push(`削除・消失: ${diff.deleted}枚`);
    if (diff.modified > 0) changeDetails.push(`変更: ${diff.modified}枚`);
    const detailText = changeDetails.length > 0 ? `\n（${changeDetails.join(' / ')}）` : '';

    const msg1 = `フォルダ「${name}」の内容が更新された可能性があります。${detailText}\n\nライブラリをリフレッシュ（最新化）しますか？`;
    if (!confirm(msg1)) return;

    showToast(`「${name}」の変更を取り込み中...`, 'info');
    // 直下の差分スキャン（cleanupなしで安全に取り込み）
    await executeScan(folderPath, false, false);

    if (diff.added > 0) {
      showToast(`${diff.added}枚の写真が新しく追加されました`, 'success');
    }

    // もし削除（見つからない写真）がある場合: 第2ダイアログでリンク解除（リンク消失）確認
    if (diff.deleted > 0) {
      setTimeout(async () => {
        const msg2 = `フォルダ「${name}」内に実体ファイルが見つからない写真が ${diff.deleted}枚 あります。\n\n実体へのパス紐付けを解除（リンク消失）しますか？\n※写真のサムネイルやタグ、評価は保持されます。\n※後からクイックアクセスやフォルダツリーの「リンク消失の写真」で確認・完全消去が可能です。\n（「キャンセル」を押すと、パスの紐付けをそのまま残します）`;
        if (confirm(msg2)) {
          try {
            const cleanRes = await fetch('/api/folders/unlink-missing', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder_path: folderPath, recursive: false }),
            });
            if (!cleanRes.ok) throw new Error(`リンク解除に失敗しました (HTTP ${cleanRes.status})`);
            const cleanData = await cleanRes.json();
            showToast(`${cleanData.unlinked || diff.deleted}枚の写真のリンクを解除しました（サムネイル・タグは保持）`, 'success');
            await fetchPhotos();
            await refreshFolderTree();
            if (typeof fetchUnlinkedCount === 'function') fetchUnlinkedCount();
          } catch (err) {
            showToast(`リンク解除エラー: ${err.message}`, 'error');
          }
        }
      }, 500);
    }
  } catch (err) {
    console.warn('[WARN] checkAndPromptFolderRefresh エラー:', err);
  } finally {
    _diffChecking = false;
  }
}
window.checkAndPromptFolderRefresh = checkAndPromptFolderRefresh;

// 起動実行
document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  if (typeof initPaneResize === 'function') initPaneResize();
  if (typeof initSelectionEvents === 'function') initSelectionEvents();
  if (typeof initInspectorEvents === 'function') initInspectorEvents();
  if (typeof initLightboxEvents === 'function') initLightboxEvents();
  if (typeof initScannerModalEvents === 'function') initScannerModalEvents();
  if (typeof initLocationTree === 'function') initLocationTree();
  if (typeof window.initLocationMapModal === 'function') window.initLocationMapModal();
  if (typeof window.initLabSection === 'function') window.initLabSection();
  if (typeof window.initCompareModal === 'function') window.initCompareModal();
});
