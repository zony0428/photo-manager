/**
 * Photo Manager - 右ペイン（インスペクター / 詳細・一括編集） (Inspector)
 * 単一写真EXIF表示、露出タグ、地図・MiniMap、GPS候補照合モーダル、
 * 一括選択時のタグ編集・評価操作を管理する。
 */

function toggleInspector(forcedState) {
  state.isInspectorOpen = (forcedState !== undefined) ? forcedState : !state.isInspectorOpen;
  elements.inspectorPane.style.display = state.isInspectorOpen ? 'flex' : 'none';
  elements.toggleInspectorBtn.classList.toggle('active', state.isInspectorOpen);
  localStorage.setItem('pm_inspector_open', state.isInspectorOpen ? 'true' : 'false');

  if (state.isInspectorOpen) {
    updateInspectorView();
  }
}

/**
 * 右ペインの表示内容を現在の選択状態に合わせて更新
 */
function updateInspectorView() {
  if (!state.isInspectorOpen) return;

  const count = state.selectedPhotoIds.size;
  if (count > 1) {
    showBatchInspector();
  } else if (count === 1) {
    const selectedId = Array.from(state.selectedPhotoIds)[0];
    const photo = state.photos.find(p => p.id === selectedId);
    if (photo) {
      state.activeInspectorPhotoId = photo.id;
      showSingleInspector(photo);
    }
  } else {
    // 選択なし時: 直前のアクティブ写真、または最初の写真を表示
    let photo = state.photos.find(p => p.id === state.activeInspectorPhotoId);
    if (!photo && state.photos.length > 0) {
      photo = state.photos[0];
      state.activeInspectorPhotoId = photo.id;
    }
    if (photo) {
      showSingleInspector(photo);
    }
  }
}

/**
 * グリッド上の写真カードの評価表示（アイコン・棄スタイル・評価バー）をDOMレベルで即時部分更新
 */
function updateCardRatingDirectly(photoId, rating) {
  const card = document.querySelector(`.photo-card[data-photo-id="${photoId}"]`);
  if (!card) return;

  // 1. 棄（-1）のときはカードを薄暗く
  card.classList.toggle('is-discarded', rating === -1);

  // 2. 評価アイコンの更新
  const overlay = card.querySelector('.card-rating-overlay');
  if (overlay) {
    if (rating === 2) {
      overlay.innerHTML = '<span class="card-rating-icon rating-excellent">優</span>';
    } else if (rating === 1) {
      overlay.innerHTML = '<span class="card-rating-icon rating-good">良</span>';
    } else if (rating === -1) {
      overlay.innerHTML = '<span class="card-rating-icon rating-discard">棄</span>';
    } else {
      overlay.innerHTML = '';
    }
  }

  // 3. ホバー評価バーの active クラス更新
  card.querySelectorAll('.card-rating-bar-btn').forEach(btn => {
    const bVal = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle('active', bVal === rating);
  });
}

/**
 * インスペクタのタブ切替 ('tags' | 'exif' | 'map')
 */
function switchInspectorTab(tabName) {
  if (!['tags', 'exif', 'map'].includes(tabName)) {
    tabName = 'tags';
  }
  state.inspectorActiveTab = tabName;
  localStorage.setItem('pm_inspector_tab', tabName);

  // タブボタンのアクティブ更新
  document.querySelectorAll('.inspector-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // タブペインの表示切り替え
  const paneTags = document.getElementById('inspectorTabPaneTags');
  const paneExif = document.getElementById('inspectorTabPaneExif');
  const paneMap = document.getElementById('inspectorTabPaneMap');

  if (paneTags) paneTags.style.display = (tabName === 'tags') ? 'flex' : 'none';
  if (paneExif) paneExif.style.display = (tabName === 'exif') ? 'flex' : 'none';
  if (paneMap) paneMap.style.display = (tabName === 'map') ? 'flex' : 'none';

  // マップタブが表示された場合、Leafletマップのサイズを再計算
  if (tabName === 'map' && state._inspectorMap) {
    setTimeout(() => {
      if (state._inspectorMap) {
        state._inspectorMap.invalidateSize();
      }
    }, 50);
  }
}

/**
 * 写真が格納されているフォルダをOS標準のエクスプローラーで開く
 */
async function openPhotoFolder(photoId) {
  try {
    const res = await fetch(`/api/photo/${photoId}/open-folder`, { method: 'POST' });
    if (res.ok) {
      showToast('📁 フォルダを開きました', 'info');
    } else {
      const err = await res.json();
      showToast(err.detail || 'フォルダを開けませんでした', 'warning');
    }
  } catch (err) {
    console.error('フォルダを開く際のエラー:', err);
    showToast('フォルダを開けませんでした', 'error');
  }
}

/**
 * 写真の実ファイルをOSの規定アプリケーションで開く
 */
async function openPhotoFile(photoId) {
  try {
    const res = await fetch(`/api/photo/${photoId}/open-file`, { method: 'POST' });
    if (res.ok) {
      showToast('🖼️ 規定のアプリで写真を開きました', 'info');
    } else {
      const err = await res.json();
      showToast(err.detail || 'ファイルを開けませんでした', 'warning');
    }
  } catch (err) {
    console.error('ファイルを開く際のエラー:', err);
    showToast('ファイルを開けませんでした', 'error');
  }
}

/**
 * 露出パラメータ（シャッター速度・F値・ISO・露出補正）のタグ要素を生成する
 */
function renderExposureTags(container, photo) {
  if (!container) return false;
  container.innerHTML = '';
  const tags = [];

  // シャッタースピード
  if (photo.shutter_speed) {
    tags.push(`<span class="meta-exposure-tag is-shutter" title="シャッター速度">⏱️ ${escapeHtml(photo.shutter_speed)}</span>`);
  }
  // 絞り（F値）
  if (photo.f_number != null) {
    tags.push(`<span class="meta-exposure-tag is-aperture" title="絞り値 (F値)">ƒ/${escapeHtml(String(photo.f_number))}</span>`);
  }
  // ISO感度
  if (photo.iso != null) {
    tags.push(`<span class="meta-exposure-tag is-iso" title="ISO感度">ISO ${escapeHtml(String(photo.iso))}</span>`);
  }
  // 露出補正
  if (photo.exposure_bias !== undefined && photo.exposure_bias !== null && Math.abs(photo.exposure_bias) > 0.001) {
    const sign = photo.exposure_bias > 0 ? '+' : '';
    tags.push(`<span class="meta-exposure-tag is-bias" title="露出補正">${sign}${photo.exposure_bias.toFixed(2)} EV</span>`);
  }

  if (tags.length > 0) {
    container.innerHTML = tags.join('');
    return true;
  }
  return false;
}

/**
 * 単一写真の詳細・編集モード表示
 */
function showSingleInspector(photo) {
  // 重複詳細情報（全保存パス・全ボリューム）・XMPサイドカー情報や完全メタデータが未取得の場合は非同期取得して再描画
  if ((photo.duplicates === undefined || photo.xmp_info === undefined) && !photo._xmpDetailFetched) {
    const currentId = photo.id;
    photo._xmpDetailFetched = true;
    fetch(`/api/photo/${currentId}`)
      .then(res => res.ok ? res.json() : null)
      .then(detail => {
        if (detail && state.activeInspectorPhotoId === currentId) {
          Object.assign(photo, detail);
          showSingleInspector(photo);
        }
      })
      .catch(err => console.warn('[WARN] 詳細メタデータ取得失敗:', err));
  }

  elements.inspectorSingleView.style.display = 'block';
  elements.inspectorBatchView.style.display = 'none';
  if (elements.inspectorFixedPreview) elements.inspectorFixedPreview.style.display = 'block';
  elements.inspectorTitle.textContent = photo.file_name;
  elements.inspectorTitle.title = photo.file_name;

  // プレビューサムネイル
  if (elements.inspectorPreviewWrapper) {
    elements.inspectorPreviewWrapper.classList.remove('is-xmp-preview-active');
  }
  elements.inspectorThumb.src = getThumbnailUrl(photo);
  elements.inspectorThumb.style.transform = '';
  if (elements.inspectorThumb.complete && typeof window.refreshInspectorHistogram === 'function') {
    window.refreshInspectorHistogram();
  }

  elements.inspectorPreviewWrapper.onclick = () => {
    const idx = state.photos.findIndex(p => p.id === photo.id);
    if (idx >= 0) openLightbox(idx);
  };

  // XMPサイドカー検出・ホールドプレビュー・評価/タグ取込バーの表示制御
  const xmpBar = document.getElementById('inspectorXmpBar');
  const xmpBadge = document.getElementById('inspectorXmpBadge');
  const xmpPreviewBtn = document.getElementById('inspectorXmpPreviewBtn');
  const xmpImportBtn = document.getElementById('inspectorXmpImportMetaBtn');
  if (xmpBar) {
    const xmpInfo = photo.xmp_info;
    if (xmpInfo && xmpInfo.has_xmp) {
      xmpBar.style.display = 'flex';
      if (xmpBadge) {
        const xmpName = xmpInfo.xmp_name || '.xmp';
        const hwParts = [];
        if (xmpInfo.hardware) {
          if (xmpInfo.hardware.camera_model) hwParts.push(xmpInfo.hardware.camera_model);
          if (xmpInfo.hardware.lens_model) hwParts.push(xmpInfo.hardware.lens_model);
        }
        xmpBadge.title = hwParts.length > 0
          ? `XMPサイドカー検出: ${xmpName} (${hwParts.join(' / ')})`
          : `XMPサイドカーファイルが検出されました (${xmpName})`;
      }

      // 1) [👁️ XMPプレビュー] ホールドボタン
      const hasXmpAdj = !!(xmpInfo.adjustments && xmpInfo.adjustments.has_adjustments);
      if (xmpPreviewBtn) {
        xmpPreviewBtn.classList.remove('is-pressing');
        xmpPreviewBtn.style.display = hasXmpAdj ? 'inline-flex' : 'none';
        if (hasXmpAdj) {
          const adjSummary = Array.isArray(xmpInfo.adjustments.summary) ? xmpInfo.adjustments.summary : [];
          xmpPreviewBtn.title = adjSummary.length > 0
            ? `押している間だけXMPの調整データを反映します (${adjSummary.join(' / ')})`
            : '押している間だけPhotoManagerの調整をオフにし、XMPの調整データを反映して表示します';

          const xmpThumbUrl = `/api/photo/${photo.id}/xmp-preview?mode=thumb&t=${photo.file_mtime || 0}`;
          const xmpViewUrl = `/api/photo/${photo.id}/xmp-preview?mode=view&t=${photo.file_mtime || 0}`;

          // 押した瞬間にラグなく切り替わるようバックグラウンドでプリロード
          const preloadImg = new Image();
          preloadImg.src = xmpThumbUrl;

          const startXmpPreview = (e) => {
            if (e && e.type === 'mousedown' && e.button !== 0) return;
            if (e && e.type === 'touchstart') e.preventDefault();
            if (xmpPreviewBtn.classList.contains('is-pressing')) return;

            xmpPreviewBtn.classList.add('is-pressing');
            if (elements.inspectorPreviewWrapper) {
              elements.inspectorPreviewWrapper.classList.add('is-xmp-preview-active');
            }

            const prevOnload = elements.inspectorThumb.onload;
            elements.inspectorThumb.onload = () => {
              if (typeof window.refreshInspectorHistogram === 'function') {
                window.refreshInspectorHistogram();
              }
              elements.inspectorThumb.onload = prevOnload;
            };
            elements.inspectorThumb.src = xmpThumbUrl;
            elements.inspectorThumb.style.transform = '';
            if (elements.inspectorThumb.complete && typeof window.refreshInspectorHistogram === 'function') {
              window.refreshInspectorHistogram();
            }

            // ライトボックスが開いており同じ写真を表示中の場合はライトボックス画像も一時切替
            if (elements.lightboxModal && elements.lightboxModal.style.display !== 'none') {
              const lbPhoto = typeof getCurrentLightboxPhoto === 'function' ? getCurrentLightboxPhoto() : null;
              if (lbPhoto && lbPhoto.id === photo.id) {
                const lbImg = elements.lightboxImage || elements.lightboxImg || document.getElementById('lightboxImage');
                if (lbImg) {
                  lbImg.src = xmpViewUrl;
                }
              }
            }
          };

          const stopXmpPreview = () => {
            if (!xmpPreviewBtn.classList.contains('is-pressing')) return;
            xmpPreviewBtn.classList.remove('is-pressing');
            if (elements.inspectorPreviewWrapper) {
              elements.inspectorPreviewWrapper.classList.remove('is-xmp-preview-active');
            }

            const prevOnload = elements.inspectorThumb.onload;
            elements.inspectorThumb.onload = () => {
              if (typeof window.refreshInspectorHistogram === 'function') {
                window.refreshInspectorHistogram();
              }
              elements.inspectorThumb.onload = prevOnload;
            };
            elements.inspectorThumb.src = getThumbnailUrl(photo);
            elements.inspectorThumb.style.transform = '';
            if (elements.inspectorThumb.complete && typeof window.refreshInspectorHistogram === 'function') {
              window.refreshInspectorHistogram();
            }

            // ライトボックスが開いており同じ写真を表示中の場合は元の表示へ復元
            if (elements.lightboxModal && elements.lightboxModal.style.display !== 'none') {
              const lbPhoto = typeof getCurrentLightboxPhoto === 'function' ? getCurrentLightboxPhoto() : null;
              if (lbPhoto && lbPhoto.id === photo.id) {
                const lbImg = elements.lightboxImage || elements.lightboxImg || document.getElementById('lightboxImage');
                if (lbImg) {
                  lbImg.src = getPhotoViewUrl(photo);
                  if (typeof applyLightboxTransform === 'function') {
                    applyLightboxTransform();
                  }
                }
              }
            }
          };

          xmpPreviewBtn.onmousedown = startXmpPreview;
          xmpPreviewBtn.ontouchstart = startXmpPreview;
          xmpPreviewBtn.onmouseup = stopXmpPreview;
          xmpPreviewBtn.onmouseleave = stopXmpPreview;
          xmpPreviewBtn.ontouchend = stopXmpPreview;
          xmpPreviewBtn.ontouchcancel = stopXmpPreview;
          xmpPreviewBtn.onblur = stopXmpPreview;
        } else {
          xmpPreviewBtn.onmousedown = null;
          xmpPreviewBtn.ontouchstart = null;
          xmpPreviewBtn.onmouseup = null;
          xmpPreviewBtn.onmouseleave = null;
          xmpPreviewBtn.ontouchend = null;
          xmpPreviewBtn.ontouchcancel = null;
          xmpPreviewBtn.onblur = null;
        }
      }

      // 2) [📥 評価・タグ取込] ボタン
      const hasXmpRating = !!(xmpInfo.rating && xmpInfo.rating.has_rating);
      const xmpTags = Array.isArray(xmpInfo.tags) ? xmpInfo.tags : [];
      const hasXmpTags = xmpTags.length > 0;
      const hasImportableMeta = hasXmpRating || hasXmpTags;
      if (xmpImportBtn) {
        xmpImportBtn.style.display = hasImportableMeta ? 'inline-flex' : 'none';
        if (hasImportableMeta) {
          const ratingLabelMap = { 2: '優', 1: '良', 0: '可', '-1': '棄' };
          const metaDescParts = [];
          if (hasXmpRating) {
            const rawR = xmpInfo.rating.raw_rating !== undefined ? xmpInfo.rating.raw_rating : '?';
            const pmLabel = ratingLabelMap[String(xmpInfo.rating.pm_rating)] || '可';
            metaDescParts.push(`評価: XMP(${rawR}) → ${pmLabel}`);
          }
          if (hasXmpTags) {
            metaDescParts.push(`タグ: ${xmpTags.length}件 (XMP/配下)`);
          }
          xmpImportBtn.title = `XMPサイドカーから取り込み (${metaDescParts.join(' / ')})`;

          xmpImportBtn.onclick = async (e) => {
            e.stopPropagation();
            const confirmLines = [`「${photo.file_name}」のXMPサイドカーから以下の情報を取り込みますか？\n`];
            if (hasXmpRating) {
              const rawR = xmpInfo.rating.raw_rating !== undefined ? xmpInfo.rating.raw_rating : '?';
              const pmLabel = ratingLabelMap[String(xmpInfo.rating.pm_rating)] || '可';
              confirmLines.push(`・評価: XMP評価 (${rawR}) → Photo Manager 4段階評価「${pmLabel}」`);
            }
            if (hasXmpTags) {
              const previewTags = xmpTags.slice(0, 5).join(', ') + (xmpTags.length > 5 ? ' ほか' : '');
              confirmLines.push(`・タグ (${xmpTags.length}件): ${previewTags}\n  ※ 既存タグと混ざらないよう「XMP/」ルート配下に登録されます`);
            }
            if (!confirm(confirmLines.join('\n'))) return;

            try {
              const res = await fetch(`/api/photo/${photo.id}/import-xmp-metadata`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  import_rating: hasXmpRating,
                  import_tags: hasXmpTags,
                }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const result = await res.json();

              // 最新詳細データを再取得して画面へ反映
              const detailRes = await fetch(`/api/photo/${photo.id}`);
              if (detailRes.ok) {
                const detailData = await detailRes.json();
                Object.assign(photo, detailData);
              }
              if (typeof updateCardRatingBadge === 'function' && photo.rating !== undefined) {
                updateCardRatingBadge(photo.id, photo.rating);
              }
              showSingleInspector(photo);
              if (typeof fetchTags === 'function') fetchTags();
              if (typeof fetchPhotos === 'function') fetchPhotos();
              if (typeof showToast === 'function') {
                const importedTagCount = Array.isArray(result.imported_tags) ? result.imported_tags.length : xmpTags.length;
                showToast(`📥 XMPからメタデータを取り込みました（タグ ${importedTagCount}件）`, 'success');
              }
            } catch (err) {
              console.error('[ERROR] XMPメタデータ取込失敗:', err);
              if (typeof showToast === 'function') {
                showToast('XMPメタデータの取り込みに失敗しました', 'error');
              }
            }
          };
        } else {
          xmpImportBtn.onclick = null;
        }
      }
    } else {
      xmpBar.style.display = 'none';
      if (xmpPreviewBtn) xmpPreviewBtn.style.display = 'none';
      if (xmpImportBtn) xmpImportBtn.style.display = 'none';
    }
  }

  // ヘッダーのフォルダ・ファイルを開くボタン
  if (elements.inspectorOpenFolderBtn) {
    elements.inspectorOpenFolderBtn.style.display = 'inline-flex';
    elements.inspectorOpenFolderBtn.onclick = (e) => {
      e.stopPropagation(); // 大画面ビューワが開かないようにする
      openPhotoFolder(photo.id);
    };
  }
  if (elements.inspectorOpenFileBtn) {
    elements.inspectorOpenFileBtn.style.display = 'inline-flex';
    elements.inspectorOpenFileBtn.onclick = (e) => {
      e.stopPropagation();
      openPhotoFile(photo.id);
    };
  }

  // storage内写真のみファイル名変更ボタン（✏️）を表示
  const renameHeaderBtn = document.getElementById('inspectorRenameHeaderBtn');
  const renameExifBtn = document.getElementById('inspectorRenameExifBtn');
  const inStorage = typeof window.isPhotoInStorage === 'function' ? window.isPhotoInStorage(photo) : false;
  if (renameHeaderBtn) {
    renameHeaderBtn.style.display = inStorage ? 'inline-flex' : 'none';
    renameHeaderBtn.onclick = (e) => {
      e.stopPropagation();
      if (typeof window.openStorageRenameModal === 'function') {
        window.openStorageRenameModal([photo.id]);
      }
    };
  }
  if (renameExifBtn) {
    renameExifBtn.style.display = inStorage ? 'inline-flex' : 'none';
    renameExifBtn.onclick = (e) => {
      e.stopPropagation();
      if (typeof window.openStorageRenameModal === 'function') {
        window.openStorageRenameModal([photo.id]);
      }
    };
  }

  // 評価ボタンの描画（即時反映）
  elements.inspectorRatingBtns.querySelectorAll('.rating-btn').forEach(btn => {
    const ratingVal = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle('active', photo.rating === ratingVal);
    btn.onclick = async (e) => {
      e.stopPropagation();
      const newRating = (photo.rating === ratingVal) ? 0 : ratingVal;

      // 1. オブジェクト自身の評価プロパティを即時更新
      photo.rating = newRating;

      // 2. インスペクタ上の評価ボタンの active クラスを即時更新
      elements.inspectorRatingBtns.querySelectorAll('.rating-btn').forEach(b => {
        const bVal = parseInt(b.dataset.rating, 10);
        b.classList.toggle('active', bVal === newRating);
      });

      // 3. グリッド上の写真カードDOMを即時更新
      updateCardRatingDirectly(photo.id, newRating);

      // 4. API送信 & グローバル同期
      await updatePhotoRating(photo.id, newRating);
    };
  });

  // GPS情報の有無によるタブバッジ表示
  const hasGps = photo.latitude != null && photo.longitude != null;
  if (elements.inspectorTabGpsDot) {
    elements.inspectorTabGpsDot.style.display = hasGps ? 'inline-block' : 'none';
  }

  // 現在選択中のタブを反映
  switchInspectorTab(state.inspectorActiveTab);

  // 露出ブラケット / 連写スタックの描画（RAW+JPEGペアはスタックから分離済み）
  if (elements.inspectorBracketSection) {
    const stackPhotos = photo.stack_photos || [];
    if (stackPhotos.length > 1) {
      elements.inspectorBracketSection.style.display = 'block';
      // スタック種別判定（重複、連写、または露出ブラケット）
      const isDuplicate = (photo.stack_type === 'duplicate');
      const biases = stackPhotos.map(sp => sp.exposure_bias || 0.0);
      const minBias = Math.min(...biases);
      const maxBias = Math.max(...biases);
      const hasExposureDiff = (maxBias - minBias) > 0.05;
      const isBurst = !isDuplicate && ((photo.stack_type === 'burst') || (!hasExposureDiff));
      const hasRaw = stackPhotos.some(sp => sp.is_raw);
      const hasJpg = stackPhotos.some(sp => !sp.is_raw);

      // 連写バーストの場合は時系列昇順（上から下へスタート→進行）で厳格にソート
      if (isBurst) {
        stackPhotos.sort((a, b) => {
          const ta = getPhotoExactTimestamp(a);
          const tb = getPhotoExactTimestamp(b);
          if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 0.0001) return ta - tb;
          const nameCmp = (a.file_name || '').localeCompare(b.file_name || '', undefined, { numeric: true, sensitivity: 'base' });
          if (nameCmp !== 0) return nameCmp;
          return (a.id || 0) - (b.id || 0);
        });
      }

      const timestamps = isBurst ? stackPhotos.map(sp => getPhotoExactTimestamp(sp)) : [];
      const validTimestamps = timestamps.filter(t => t > 0);
      const startT = validTimestamps.length > 0 ? validTimestamps[0] : 0;
      const hasDiff = (startT > 0) && timestamps.some(t => Math.abs(t - startT) > 0.005);

      if (isDuplicate) {
        elements.inspectorBracketLabel.textContent = `📋 重複写真グループ (${stackPhotos.length}枚)`;
        elements.inspectorBracketTypeBadge.textContent = 'DUP';
      } else if (isBurst) {
        elements.inspectorBracketLabel.textContent = `⚡ 連写グループ (${stackPhotos.length}枚)`;
        elements.inspectorBracketTypeBadge.textContent = 'BURST';
      } else {
        const rawSuffix = (hasRaw && hasJpg) ? ' | RAW+JPG' : '';
        elements.inspectorBracketLabel.textContent = `⚡ 露出ブラケット (${stackPhotos.length}枚${rawSuffix})`;
        elements.inspectorBracketTypeBadge.textContent = 'BKT';
      }
      elements.inspectorBracketList.innerHTML = '';

      stackPhotos.forEach((sp, idx) => {
        const item = document.createElement('div');
        item.className = 'inspector-bracket-item';
        if (sp.id === photo.id) item.classList.add('active');

        // 露出補正、連写秒ズレ、またはフォルダ名
        let biasClass = 'normal';
        let biasText = '±0.0 EV';

        if (isDuplicate) {
          const rawDir = sp.directory_path || '';
          const folderParts = rawDir.split(/[\\/]/).filter(Boolean);
          const folderName = folderParts.length > 0 ? folderParts[folderParts.length - 1] : 'フォルダ';
          biasText = `📁 ${folderName}`;
        } else if (isBurst) {
          if (idx === 0) {
            biasText = '0.00s';
          } else if (hasDiff && timestamps[idx] > 0 && startT > 0) {
            const diffSec = timestamps[idx] - startT;
            biasText = `+${diffSec.toFixed(2)}s`;
          } else {
            biasText = `+${idx}`;
          }
        } else {
          const biasVal = sp.exposure_bias || 0.0;
          if (biasVal > 0.05) {
            biasClass = 'over';
            biasText = `+${biasVal.toFixed(2)} EV`;
          } else if (biasVal < -0.05) {
            biasClass = 'under';
            biasText = `${biasVal.toFixed(2)} EV`;
          }
        }

        const isPrimary = sp.is_stack_primary === 1;
        const primaryHtml = isPrimary 
          ? '<span class="bracket-primary-badge">★ 代表</span>' 
          : `<button class="btn-make-primary" data-photo-id="${sp.id}" title="この写真を一覧の代表写真にする">代表に設定</button>`;

        const formatPill = sp.is_raw 
          ? `<span class="bracket-format-pill raw">${sp.raw_format ? sp.raw_format.replace('.', '').toUpperCase() : 'RAW'}</span>`
          : `<span class="bracket-format-pill jpg">JPG</span>`;

        let detailsHtml = '';
        if (isDuplicate) {
          const sizeStr = sp.file_size ? `${(sp.file_size / (1024 * 1024)).toFixed(2)}MB` : '';
          const resStr = (sp.width && sp.height) ? `${sp.width}×${sp.height}` : '';
          detailsHtml = `
            <span>${escapeHtml(sp.file_name)}</span>
            ${resStr ? `<span>・${resStr}</span>` : ''}
            ${sizeStr ? `<span>・${sizeStr}</span>` : ''}
          `;
        } else {
          detailsHtml = `
            <span>${escapeHtml(sp.file_name)}</span>
            ${sp.shutter_speed ? `<span>・${sp.shutter_speed}</span>` : ''}
            ${sp.f_number ? `<span>・F${sp.f_number}</span>` : ''}
          `;
        }

        item.innerHTML = `
          <div class="bracket-thumb">
            <img src="${getThumbnailUrl(sp)}" alt="${escapeHtml(sp.file_name)}" loading="lazy">
          </div>
          <div class="bracket-info">
            <div class="bracket-exp-bias ${biasClass}">
              <span title="${escapeHtml(sp.directory_path || '')}">${biasText}</span>
              ${formatPill}
              ${primaryHtml}
            </div>
            <div class="bracket-details" title="${escapeHtml(sp.file_path || '')}">
              ${detailsHtml}
            </div>
          </div>
        `;

        // 「代表に設定」ボタン
        const makePrimaryBtn = item.querySelector('.btn-make-primary');
        if (makePrimaryBtn) {
          makePrimaryBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              const res = await fetch(`/api/photo/${sp.id}/set-primary`, { method: 'POST' });
              if (res.ok) {
                await fetchPhotos();
                const spInStorage = typeof window.isPhotoInStorage === 'function' ? window.isPhotoInStorage(sp) : false;
          if (renameHeaderBtn) {
            renameHeaderBtn.style.display = spInStorage ? 'inline-flex' : 'none';
            renameHeaderBtn.onclick = (e) => {
              e.stopPropagation();
              if (typeof window.openStorageRenameModal === 'function') {
                window.openStorageRenameModal([sp.id]);
              }
            };
          }
          if (renameExifBtn) {
            renameExifBtn.style.display = spInStorage ? 'inline-flex' : 'none';
            renameExifBtn.onclick = (e) => {
              e.stopPropagation();
              if (typeof window.openStorageRenameModal === 'function') {
                window.openStorageRenameModal([sp.id]);
              }
            };
          }

          state.activeInspectorPhotoId = sp.id;
                const updated = state.photos.find(p => p.id === sp.id);
                if (updated) showSingleInspector(updated);
              }
            } catch (err) {
              console.error('代表変更失敗:', err);
            }
          });
        }

        item.title = `${sp.file_name} (${biasText})\nクリック: 上部にプレビュー表示\nダブルクリック: ライトボックスで全画面表示`;

        // 1. アイテム全体のシングルクリックで即座に上部プレビューを切り替え
        item.addEventListener('click', async (e) => {
          if (e.target.closest('.btn-make-primary')) return;

          // 角ボタンのアクティブ表示（オレンジ枠）を即時切り替え
          elements.inspectorBracketList.querySelectorAll('.inspector-bracket-item').forEach(it => it.classList.remove('active'));
          item.classList.add('active');

          // 上部の固定プレビュー画像とタイトルを即時更新
          if (elements.inspectorThumb) {
            elements.inspectorThumb.src = getThumbnailUrl(sp);
            if (elements.inspectorThumb.complete && typeof window.refreshInspectorHistogram === 'function') {
              window.refreshInspectorHistogram();
            }
          }
          if (elements.inspectorTitle) {
            elements.inspectorTitle.textContent = sp.file_name;
            elements.inspectorTitle.title = sp.file_name;
          }

          // 上部プレビュー枠クリック時のライトボックス対象もこの sp に切り替え
          if (elements.inspectorPreviewWrapper) {
            elements.inspectorPreviewWrapper.onclick = () => {
              openLightboxForStackMember(sp, photo);
            };
          }

          // ヘッダーのフォルダ・ファイルを開くボタンの対象もこの sp に切り替え
          if (elements.inspectorOpenFolderBtn) {
            elements.inspectorOpenFolderBtn.onclick = (e) => {
              e.stopPropagation();
              openPhotoFolder(sp.id);
            };
          }
          if (elements.inspectorOpenFileBtn) {
            elements.inspectorOpenFileBtn.onclick = (e) => {
              e.stopPropagation();
              openPhotoFile(sp.id);
            };
          }

          const spInStorage = typeof window.isPhotoInStorage === 'function' ? window.isPhotoInStorage(sp) : false;
          if (renameHeaderBtn) {
            renameHeaderBtn.style.display = spInStorage ? 'inline-flex' : 'none';
            renameHeaderBtn.onclick = (e) => {
              e.stopPropagation();
              if (typeof window.openStorageRenameModal === 'function') {
                window.openStorageRenameModal([sp.id]);
              }
            };
          }
          if (renameExifBtn) {
            renameExifBtn.style.display = spInStorage ? 'inline-flex' : 'none';
            renameExifBtn.onclick = (e) => {
              e.stopPropagation();
              if (typeof window.openStorageRenameModal === 'function') {
                window.openStorageRenameModal([sp.id]);
              }
            };
          }

          state.activeInspectorPhotoId = sp.id;

          // バックグラウンドで完全な詳細メタデータを取得してインスペクタ全体を同期
          if (sp.id !== photo.id) {
            try {
              let detailPhoto = null;
              const res = await fetch(`/api/photo/${sp.id}`);
              if (res.ok) {
                detailPhoto = await res.json();
              } else {
                const photoRes = await fetch(`/api/photos?search=${encodeURIComponent(sp.file_name)}&stacked=false`);
                const pData = await photoRes.json();
                if (pData.photos && pData.photos.length > 0) {
                  detailPhoto = pData.photos[0];
                }
              }
              if (detailPhoto) {
                if (!detailPhoto.stack_photos || detailPhoto.stack_photos.length === 0) {
                  detailPhoto.stack_photos = photo.stack_photos;
                  detailPhoto.stack_id = photo.stack_id;
                  detailPhoto.stack_type = photo.stack_type;
                }
                showSingleInspector(detailPhoto);
              }
            } catch (err) {
              console.error('写真切り替え失敗:', err);
            }
          }
        });

        // 2. ダブルクリックで直接ライトボックスで全画面表示
        item.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (e.target.closest('.btn-make-primary')) return;
          openLightboxForStackMember(sp, photo);
        });

        elements.inspectorBracketList.appendChild(item);
      });

      // 3枚より多い場合はエキスパンダ（4コマ目以降を折りたたみ・展開）
      const MAX_COLLAPSED_COUNT = 3;
      const isLargeStack = stackPhotos.length > MAX_COLLAPSED_COUNT;

      if (elements.inspectorBracketExpanderBtn) {
        if (isLargeStack) {
          elements.inspectorBracketExpanderBtn.style.display = 'flex';

          // 展開時に下部タブバーが画面内にしっかり残る理想の最大高さを算出
          // （約6コマ分を快適に一覧できる約380pxを上限とし、画面が小さい場合はさらに縮小）
          const calcAvailableMaxHeight = () => {
            const IDEAL_HEIGHT = 380;
            if (!elements.inspectorBody) return IDEAL_HEIGHT;

            // inspectorBodyの表示高さから、下部タブとマージンの最低必要分（約150px）を確保
            const safeMax = Math.max(180, elements.inspectorBody.clientHeight - 150);
            return Math.min(IDEAL_HEIGHT, safeMax);
          };

          // アクティブなコマが4枚目以降にあれば最初から展開、そうでなければ初期状態は折りたたみ
          const activeIdx = stackPhotos.findIndex(sp => sp.id === photo.id);
          let isCollapsed = (activeIdx < 0 || activeIdx < MAX_COLLAPSED_COUNT);

          const updateExpanderState = () => {
            elements.inspectorBracketList.classList.toggle('is-collapsed', isCollapsed);
            const hiddenCount = stackPhotos.length - MAX_COLLAPSED_COUNT;
            elements.inspectorBracketExpanderBtn.textContent = isCollapsed
              ? `▼ 他 ${hiddenCount} 枚を表示`
              : `▲ 折りたたむ`;

            if (isCollapsed) {
              elements.inspectorBracketList.style.maxHeight = '';
            } else {
              const maxH = calcAvailableMaxHeight();
              if (maxH) {
                elements.inspectorBracketList.style.maxHeight = `${maxH}px`;
              }
              // 展開時にアクティブコマが見える位置へ自動スクロール
              requestAnimationFrame(() => {
                const activeItem = elements.inspectorBracketList.querySelector('.inspector-bracket-item.active');
                if (activeItem) {
                  activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
              });
            }
          };

          updateExpanderState();

          elements.inspectorBracketExpanderBtn.onclick = (e) => {
            e.stopPropagation();
            isCollapsed = !isCollapsed;
            updateExpanderState();
          };
        } else {
          elements.inspectorBracketList.classList.remove('is-collapsed');
          elements.inspectorBracketList.style.maxHeight = '';
          elements.inspectorBracketExpanderBtn.style.display = 'none';
        }
      }
    } else {
      elements.inspectorBracketSection.style.display = 'none';
      if (elements.inspectorBracketExpanderBtn) {
        elements.inspectorBracketExpanderBtn.style.display = 'none';
      }
    }
  }

  // タグ一覧の描画
  renderInspectorTagChips(photo);

  // 独立カラーパレットの描画 (複数選択トグル可能)
  if (elements.inspectorColorGrid) {
    renderInspectorColorPalette(elements.inspectorColorGrid, photo, false);
  }

  // 単体写真へのAI自動タグ付けボタンイベント
  const aiBtn = elements.inspectorAiTagBtn || document.getElementById('inspectorAiTagBtn');
  if (aiBtn) {
    aiBtn.onclick = async () => {
      await triggerAiTagForSinglePhoto(photo.id, aiBtn);
    };
  }

  // クイック選択ツリーの描画 (AIタグおよびカラータグは除外)
  renderInspectorQuickTree(elements.inspectorQuickTree, async (chosenTag) => {
    await addTagToPhoto(photo.id, chosenTag, photo);
  });

  // メタデータEXIFテーブル
  elements.inspectorFileName.textContent = photo.file_name;

  // RAWペア情報の表示（スタックとは分離した独立セクション）
  if (elements.inspectorFormat) {
    if (photo.paired_raw_path) {
      elements.inspectorFormat.textContent = 'JPEG + RAW (ペア)';
      if (elements.inspectorRawPairRow) {
        elements.inspectorRawPairRow.style.display = 'block';
        // ファイル名のみ抽出して見やすく表示
        const rawFileName = photo.paired_raw_path.split(/[/\\]/).pop() || photo.paired_raw_path;
        elements.inspectorRawPairPath.textContent = rawFileName;
        elements.inspectorRawPairPath.title = photo.paired_raw_path;
      }
      // 「RAWを開く」ボタンイベント
      if (elements.inspectorOpenRawBtn) {
        elements.inspectorOpenRawBtn.onclick = async () => {
          try {
            const res = await fetch(`/api/photo/${photo.id}/open-raw`, { method: 'POST' });
            if (!res.ok) {
              const err = await res.json();
              alert(err.detail || 'RAWファイルを開けませんでした');
            }
          } catch (e) {
            console.error('RAWファイルを開く際のエラー:', e);
          }
        };
      }
    } else if (photo.is_raw) {
      const fmt = (photo.raw_format || 'RAW').toUpperCase().replace('.', '');
      elements.inspectorFormat.textContent = `RAW (${fmt})`;
      if (elements.inspectorRawPairRow) elements.inspectorRawPairRow.style.display = 'none';
    } else {
      elements.inspectorFormat.textContent = 'JPEG / 一般画像';
      if (elements.inspectorRawPairRow) elements.inspectorRawPairRow.style.display = 'none';
    }
  }

  elements.inspectorDateTaken.textContent = photo.date_taken ? photo.date_taken.replace('T', ' ') : '不明';
  elements.inspectorCamera.textContent = photo.camera_model || '不明';

  // レンズ機種
  if (elements.inspectorLensRow && elements.inspectorLens) {
    if (photo.lens_model) {
      elements.inspectorLensRow.style.display = '';
      elements.inspectorLens.textContent = photo.lens_model;
      elements.inspectorLens.title = photo.lens_model;
    } else {
      elements.inspectorLensRow.style.display = 'none';
    }
  }

  // 露出設定（シャッター速度・絞り・ISO・補正）
  if (elements.inspectorExposureRow && elements.inspectorExposureParams) {
    const hasExp = renderExposureTags(elements.inspectorExposureParams, photo);
    elements.inspectorExposureRow.style.display = hasExp ? '' : 'none';
  }

  // 焦点距離
  if (elements.inspectorFocalLengthRow && elements.inspectorFocalLength) {
    if (photo.focal_length != null) {
      elements.inspectorFocalLengthRow.style.display = '';
      elements.inspectorFocalLength.textContent = `${photo.focal_length} mm`;
    } else {
      elements.inspectorFocalLengthRow.style.display = 'none';
    }
  }

  elements.inspectorDimensions.textContent = (photo.width && photo.height) ? `${photo.width} × ${photo.height}` : '不明';
  elements.inspectorFileSize.textContent = formatBytes(photo.file_size);

  // 親ディレクトリパス抽出ヘルパー
  const getParentDirPath = (fp) => {
    if (!fp) return '-';
    const match = fp.match(/^(.*)[/\\][^/\\]+$/);
    let dir = match ? match[1] : fp;
    if (/^[a-zA-Z]:$/.test(dir)) dir += '\\';
    return dir;
  };

  const dups = photo.duplicates || [];
  const hasDuplicates = dups.length > 1;

  // 1. 保存パスの表示（重複時は全コピーのパスを件数分すべて一覧表示）
  if (hasDuplicates) {
    if (elements.inspectorPathLabel) {
      elements.inspectorPathLabel.textContent = `保存パス (${dups.length}件)`;
    }
    if (elements.inspectorPathRow) {
      elements.inspectorPathRow.classList.add('is-multi-row');
    }
    elements.inspectorPath.innerHTML = `
      <div class="multi-meta-list">
        ${dups.map((dup) => {
          const isCurrent = (dup.id === photo.id);
          const dir = dup.is_unlinked ? '🔗 実体パス未登録（リンク消失）' : getParentDirPath(dup.file_path);
          const fullPath = dup.file_path || '';
          return `
            <div class="multi-meta-item${isCurrent ? ' active' : ''}" data-photo-id="${dup.id}">
              ${dup.is_unlinked ? `
                <span class="multi-meta-text" style="color:var(--warning, #e67e22);">🔗 実体パス未登録</span>
              ` : `
                <a href="javascript:void(0)" class="multi-meta-link" data-photo-id="${dup.id}" title="${escapeHtml(fullPath)}&#10;クリックでフォルダを開く">${escapeHtml(dir)}</a>
              `}
            </div>
          `;
        }).join('')}
      </div>
    `;
    elements.inspectorPath.title = '';
  } else {
    if (elements.inspectorPathLabel) {
      elements.inspectorPathLabel.textContent = '保存パス';
    }
    if (elements.inspectorPathRow) {
      elements.inspectorPathRow.classList.remove('is-multi-row');
    }
    if (photo.is_unlinked) {
      elements.inspectorPath.innerHTML = '<span style="color:var(--warning, #e67e22);">🔗 実体パス未登録（リンク消失）</span>';
      elements.inspectorPath.title = photo.file_path ? `元の保存パス: ${photo.file_path}` : '実体ファイルとの紐付けが外れています';
    } else if (photo.file_path) {
      elements.inspectorPath.textContent = getParentDirPath(photo.file_path);
      elements.inspectorPath.title = photo.file_path;
    } else {
      elements.inspectorPath.textContent = '-';
      elements.inspectorPath.title = '';
    }
  }

  // 2. ボリューム情報の表示（重複時は全コピーのボリュームを件数分すべて一覧表示）
  if (elements.inspectorVolumeRow) {
    if (hasDuplicates) {
      if (elements.inspectorVolumeLabel) {
        elements.inspectorVolumeLabel.textContent = `保存ボリューム (${dups.length}件)`;
      }
      elements.inspectorVolumeRow.classList.add('is-multi-row');
      elements.inspectorVolumeRow.style.display = '';
      elements.inspectorVolume.innerHTML = `
        <div class="multi-meta-list">
          ${dups.map((dup) => {
            const isCurrent = (dup.id === photo.id);
            const icon = dup.is_offline ? '🔴' : '🟢';
            const driveInfo = dup.volume_drive ? ` (${dup.volume_drive})` : '';
            const label = dup.volume_label || 'ラベルなし';
            return `
              <div class="multi-meta-item${isCurrent ? ' active' : ''}" data-photo-id="${dup.id}" title="クリックで写真切り替え">
                <span class="multi-meta-text">${icon} ${escapeHtml(label)}${escapeHtml(driveInfo)}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
      elements.inspectorVolume.title = '';
    } else {
      if (elements.inspectorVolumeLabel) {
        elements.inspectorVolumeLabel.textContent = '保存ボリューム';
      }
      elements.inspectorVolumeRow.classList.remove('is-multi-row');
      if (photo.volume_label !== undefined && photo.volume_label !== null) {
        elements.inspectorVolumeRow.style.display = '';
        const driveInfo = photo.volume_drive ? ` (${photo.volume_drive})` : '';
        const icon = photo.is_offline ? '🔴' : '🟢';
        elements.inspectorVolume.textContent = `${icon} ${photo.volume_label || 'ラベルなし'}${driveInfo}`;
        elements.inspectorVolume.title = `ボリュームシリアル: ${photo.volume_serial || '不明'}`;
      } else {
        elements.inspectorVolumeRow.style.display = 'none';
      }
    }
  }

  // --- GPS 位置情報の表示 ---
  if (photo.latitude != null && photo.longitude != null) {
    // GPS あり: ミニマップを表示
    elements.inspectorGpsRow.style.display = '';
    const sourceLabel = photo.gps_source === 'copied'
      ? '<span class="gps-source-badge copied">COPIED</span>'
      : photo.gps_source === 'inferred'
        ? '<span class="gps-source-badge inferred" title="スマホ写真から準用">準用</span>'
        : photo.gps_source === 'exif'
          ? '<span class="gps-source-badge exif">EXIF</span>'
          : '';
    elements.inspectorGpsVal.innerHTML = `${photo.latitude.toFixed(5)}, ${photo.longitude.toFixed(5)} ${sourceLabel}`;

    // 撮影地域名
    const locParts = [photo.country, photo.state, photo.city].filter(Boolean);
    if (elements.inspectorLocationRow && elements.inspectorLocationVal) {
      if (locParts.length > 0) {
        elements.inspectorLocationRow.style.display = '';
        elements.inspectorLocationVal.textContent = locParts.join(' / ');
      } else {
        elements.inspectorLocationRow.style.display = 'none';
      }
    }

    elements.inspectorMiniMap.style.display = 'block';
    if (elements.inspectorGpsBtnBar) elements.inspectorGpsBtnBar.style.display = 'flex';
    elements.inspectorGpsActions.style.display = 'none';

    // Leaflet マップの初期化または更新
    if (typeof L !== 'undefined') {
      setTimeout(() => {
        if (state._inspectorMap) {
          state._inspectorMap.setView([photo.latitude, photo.longitude], 14);
          if (state._inspectorMarker) {
            state._inspectorMarker.setLatLng([photo.latitude, photo.longitude]);
          }
        } else {
          state._inspectorMap = L.map(elements.inspectorMiniMap, {
            zoomControl: false,
            attributionControl: false,
            dragging: true,
            scrollWheelZoom: false,
          }).setView([photo.latitude, photo.longitude], 14);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
          }).addTo(state._inspectorMap);
          state._inspectorMarker = L.marker([photo.latitude, photo.longitude]).addTo(state._inspectorMap);
        }
        state._inspectorMap.invalidateSize();
      }, 100);
    }
  } else {
    // GPS なし: コピーボタンを表示
    elements.inspectorGpsRow.style.display = 'none';
    if (elements.inspectorLocationRow) elements.inspectorLocationRow.style.display = 'none';
    elements.inspectorMiniMap.style.display = 'none';
    if (elements.inspectorGpsBtnBar) elements.inspectorGpsBtnBar.style.display = 'none';
    elements.inspectorGpsActions.style.display = 'flex';

    // マップをクリーンアップ
    if (state._inspectorMap) {
      state._inspectorMap.remove();
      state._inspectorMap = null;
      state._inspectorMarker = null;
    }

    elements.inspectorCopyGpsBtn.onclick = () => showGpsCandidateModal(photo);
  }
}


// --- GPS コピー候補モーダル ---

// --- GPS コピー候補モーダル ---

async function showGpsCandidateModal(photo) {
  try {
    const res = await fetch(`/api/photo/${photo.id}/gps-candidates?minutes=60`);
    const data = await res.json();
    const candidates = data.candidates || [];
    const beforeCand = data.before || null;
    const afterCand = data.after || null;

    // モーダルを生成
    const overlay = document.createElement('div');
    overlay.className = 'gps-candidate-overlay';

    const modal = document.createElement('div');
    modal.className = 'gps-candidate-modal';

    const header = document.createElement('div');
    header.className = 'gps-candidate-header';
    header.innerHTML = `
      <h3>📍 近隣のジオタグ付き写真 (±60分)</h3>
      <button class="modal-close-btn gps-close-btn">&times;</button>
    `;
    modal.appendChild(header);

    // 共通コピー処理
    const applyCandidate = async (c) => {
      try {
        const copyRes = await fetch(`/api/photo/${photo.id}/copy-gps`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_photo_id: c.id }),
        });
        if (copyRes.ok) {
          overlay.remove();
          photo.latitude = c.latitude;
          photo.longitude = c.longitude;
          photo.gps_source = 'copied';
          photo.country = c.country;
          photo.state = c.state;
          photo.city = c.city;

          const statePhoto = state.photos.find(p => p.id === photo.id);
          if (statePhoto) {
            statePhoto.latitude = c.latitude;
            statePhoto.longitude = c.longitude;
            statePhoto.gps_source = 'copied';
            statePhoto.country = c.country;
            statePhoto.state = c.state;
            statePhoto.city = c.city;
          }
          showSingleInspector(photo);
          if (typeof showToast === 'function') {
            showToast('📍 スマホ写真からジオタグを準用しました', 'success', 3000);
          }
        } else {
          const err = await copyRes.json();
          if (typeof showToast === 'function') {
            showToast(err.detail || 'GPSコピーに失敗しました', 'error');
          } else {
            alert(err.detail || 'GPSコピーに失敗しました');
          }
        }
      } catch (e) {
        console.error('GPS copy error:', e);
      }
    };

    const bodyContainer = document.createElement('div');
    bodyContainer.className = 'gps-candidate-body';

    if (candidates.length === 0) {
      bodyContainer.innerHTML = '<div class="gps-candidate-empty">±60分以内にGPS付き写真が見つかりませんでした。<br>スマホで撮影した写真をスキャンしてみてください。</div>';
    } else {
      // 1. 直前 / 直後 比較セクション（どっちにする？）
      if (beforeCand || afterCand) {
        const compareSection = document.createElement('div');
        compareSection.className = 'gps-compare-section';
        compareSection.innerHTML = `
          <div class="gps-compare-title">
            <span>🎯 直前 / 直後の候補から選ぶ</span>
          </div>
          <div class="gps-compare-grid"></div>
        `;
        const grid = compareSection.querySelector('.gps-compare-grid');

        const formatLoc = (c) => [c.state, c.city].filter(Boolean).join(' ') || c.country || '場所不明';

        if (beforeCand) {
          const bCard = document.createElement('div');
          bCard.className = 'gps-compare-card card-before';
          const diffMin = Math.abs(beforeCand.time_diff_signed || 0).toFixed(0);
          bCard.innerHTML = `
            <div class="gps-compare-badge">◀ 撮影前 (${diffMin}分前)</div>
            <img class="gps-compare-thumb" src="${getThumbnailUrl(beforeCand)}" alt="" loading="lazy">
            <div class="gps-compare-info">
              <div class="gps-compare-loc">📍 ${escapeHtml(formatLoc(beforeCand))}</div>
              <div class="gps-compare-meta">📷 ${escapeHtml(beforeCand.camera_model || '不明')}</div>
              <div class="gps-compare-time">${escapeHtml(beforeCand.date_taken || '')}</div>
            </div>
            <button class="btn btn-primary btn-sm gps-adopt-btn">この位置を採用</button>
          `;
          bCard.querySelector('.gps-adopt-btn').addEventListener('click', () => applyCandidate(beforeCand));
          grid.appendChild(bCard);
        }

        if (afterCand) {
          const aCard = document.createElement('div');
          aCard.className = 'gps-compare-card card-after';
          const diffMin = Math.abs(afterCand.time_diff_signed || 0).toFixed(0);
          aCard.innerHTML = `
            <div class="gps-compare-badge">撮影後 ▶ (${diffMin}分後)</div>
            <img class="gps-compare-thumb" src="${getThumbnailUrl(afterCand)}" alt="" loading="lazy">
            <div class="gps-compare-info">
              <div class="gps-compare-loc">📍 ${escapeHtml(formatLoc(afterCand))}</div>
              <div class="gps-compare-meta">📷 ${escapeHtml(afterCand.camera_model || '不明')}</div>
              <div class="gps-compare-time">${escapeHtml(afterCand.date_taken || '')}</div>
            </div>
            <button class="btn btn-primary btn-sm gps-adopt-btn">この位置を採用</button>
          `;
          aCard.querySelector('.gps-adopt-btn').addEventListener('click', () => applyCandidate(afterCand));
          grid.appendChild(aCard);
        }

        bodyContainer.appendChild(compareSection);
      }

      // 2. その他のすべての候補一覧
      if (candidates.length > 2) {
        const subListTitle = document.createElement('div');
        subListTitle.className = 'gps-all-candidates-title';
        subListTitle.textContent = `📋 その他の候補 (${candidates.length}件)`;
        bodyContainer.appendChild(subListTitle);

        const list = document.createElement('div');
        list.className = 'gps-candidate-list';

        candidates.forEach(c => {
          const item = document.createElement('div');
          item.className = 'gps-candidate-item';
          const timeDiff = c.time_diff_min != null ? c.time_diff_min.toFixed(1) : '?';
          const locStr = [c.state, c.city].filter(Boolean).join(' ') || '';
          item.innerHTML = `
            <img class="gps-candidate-thumb" src="${getThumbnailUrl(c)}" alt="" loading="lazy">
            <div class="gps-candidate-info">
              <div class="gps-candidate-name">${escapeHtml(c.file_name)} ${locStr ? `<span class="badge-sub">📍 ${escapeHtml(locStr)}</span>` : ''}</div>
              <div class="gps-candidate-meta">
                📷 ${escapeHtml(c.camera_model || '不明')} ・ ⏱ ${timeDiff}分差 ・ 📍 ${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}
              </div>
            </div>
          `;
          item.addEventListener('click', () => applyCandidate(c));
          list.appendChild(item);
        });
        bodyContainer.appendChild(list);
      }
    }

    modal.appendChild(bodyContainer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // 閉じるボタン
    header.querySelector('.gps-close-btn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // 候補ミニマップに全候補をプロット
    if (typeof L !== 'undefined' && candidates.length > 0) {
      setTimeout(() => {
        const candidateMap = L.map(mapContainer, {
          zoomControl: true,
          attributionControl: false,
          scrollWheelZoom: true,
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
        }).addTo(candidateMap);
        const bounds = L.latLngBounds([]);
        candidates.forEach(c => {
          const marker = L.marker([c.latitude, c.longitude]).addTo(candidateMap);
          marker.bindTooltip(c.file_name, { direction: 'top' });
          bounds.extend([c.latitude, c.longitude]);
        });
        if (bounds.isValid()) {
          candidateMap.fitBounds(bounds, { padding: [20, 20], maxZoom: 15 });
        }
        candidateMap.invalidateSize();
      }, 150);
    } else {
      mapContainer.style.display = 'none';
    }
  } catch (err) {
    console.error('GPS candidates error:', err);
  }
}

/**
 * 複数写真の一括編集モード表示 (マルチ選択時)
 */
function showBatchInspector() {
  elements.inspectorSingleView.style.display = 'none';
  elements.inspectorBatchView.style.display = 'block';
  if (elements.inspectorFixedPreview) elements.inspectorFixedPreview.style.display = 'none';
  elements.inspectorTitle.textContent = '一括編集';
  const renameHeaderBtn = document.getElementById('inspectorRenameHeaderBtn');
  if (renameHeaderBtn) {
    renameHeaderBtn.style.display = 'none';
  }
  if (elements.inspectorOpenFolderBtn) {
    elements.inspectorOpenFolderBtn.style.display = 'none';
  }
  if (elements.inspectorOpenFileBtn) {
    elements.inspectorOpenFileBtn.style.display = 'none';
  }

  const count = state.selectedPhotoIds.size;
  elements.batchCountBadge.textContent = count;

  // 選択された写真オブジェクト一覧を取得
  const selectedPhotos = state.photos.filter(p => state.selectedPhotoIds.has(p.id));

  // ミニサムネイルのフィルムストリップ
  elements.batchThumbnailsStrip.innerHTML = '';
  selectedPhotos.slice(0, 12).forEach(photo => {
    const item = document.createElement('div');
    item.className = 'batch-thumb-item';
    item.title = photo.file_name;
    item.innerHTML = `<img src="${getThumbnailUrl(photo)}" alt="" loading="lazy">`;
    elements.batchThumbnailsStrip.appendChild(item);
  });
  if (selectedPhotos.length > 12) {
    const more = document.createElement('div');
    more.className = 'batch-thumb-item';
    more.style.display = 'flex';
    more.style.alignItems = 'center';
    more.style.justifyContent = 'center';
    more.style.fontSize = '0.72rem';
    more.style.color = 'var(--text-muted)';
    more.textContent = `+${selectedPhotos.length - 12}`;
    elements.batchThumbnailsStrip.appendChild(more);
  }

  // 一括星評価ボタン
  if (elements.batchRateButtons) {
    elements.batchRateButtons.querySelectorAll('button').forEach(btn => {
      btn.onclick = async () => {
        const rate = parseInt(btn.dataset.rating, 10);
        await batchRateSelection(rate);
      };
    });
  }

  // 一括カラーパレット
  if (elements.batchColorGrid) {
    renderInspectorColorPalette(elements.batchColorGrid, null, true);
  }

  // クイックタグツリー (AIタグおよびカラータグは除外)
  if (elements.batchQuickTree) {
    renderInspectorQuickTree(elements.batchQuickTree, async (chosenTag) => {
      await batchToggleTag(chosenTag, true);
    });
  }

  // 選択中の全写真に付いているタグの集計（通常タグ・AIタグに加え、色タグも視認性向上のため色ドット付きで集計表示）
  const commonTagsListEl = elements.batchCommonTagsList || document.getElementById('batchCommonTagsList');
  if (commonTagsListEl) {
    commonTagsListEl.innerHTML = '';
    const tagCounts = new Map();
    selectedPhotos.forEach(p => {
      getLeafTags(p.tags).forEach(t => {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      });
    });

    if (tagCounts.size === 0) {
      commonTagsListEl.innerHTML = '<span class="empty-hint" style="font-size:0.75rem;">タグ付きの写真はありません</span>';
    } else {
      tagCounts.forEach((cnt, tag) => {
        const chip = document.createElement('div');
        chip.className = 'inspector-tag-chip batch-tag-chip';
        const isAll = (cnt === count);
        chip.style.opacity = isAll ? '1' : '0.8';
        chip.title = isAll 
          ? `全写真(${cnt}枚)に付与されています。クリックで一括解除` 
          : `一部の写真(${cnt}/${count}枚)に付与されています。クリックで一括解除`;

        const colorConf = COLOR_TAG_MAP[tag];
        const iconOrDot = colorConf 
          ? `<span class="tag-color-dot" style="background:${colorConf.color}; margin-right:4px;"></span>` 
          : '🏷️ ';

        chip.innerHTML = `
          <span style="display:inline-flex; align-items:center;">${iconOrDot}${escapeHtml(tag)} <small style="opacity:0.7; margin-left:4px;">(${cnt}/${count})</small></span>
          <span class="inspector-tag-del" title="一括解除">&times;</span>
        `;

        // チップをクリックで一括解除
        chip.addEventListener('click', async (e) => {
          e.stopPropagation();
          chip.style.opacity = '0.3';
          chip.style.pointerEvents = 'none';
          await batchToggleTag(tag, false);
        });

        commonTagsListEl.appendChild(chip);
      });
    }
  }
}

/**
 * 単一インスペクタ内のタグチップ一覧を描画
 */
function renderInspectorTagChips(photo) {
  const tagListEl = elements.inspectorTagList || document.getElementById('inspectorTagList');
  if (!tagListEl || !photo) return;
  tagListEl.innerHTML = '';
  // 色タグは独立したカラーパレットで表示・操作するため、通常タグ一覧からは除外
  const leafTags = getLeafTags(photo.tags || []).filter(tag => !(tag in COLOR_TAG_MAP));
  if (elements.inspectorTagCount) {
    elements.inspectorTagCount.textContent = `${leafTags.length}個`;
  }

  const detailsMap = {};
  if (photo.tag_details) {
    photo.tag_details.forEach(d => { detailsMap[d.tag] = d; });
  }

  if (leafTags.length === 0) {
    tagListEl.innerHTML = '<span class="empty-hint" style="font-size:0.75rem;">タグなし</span>';
    return;
  }

  leafTags.forEach(tag => {
    const detail = detailsMap[tag];
    const isAi = detail && detail.source === 'ai';
    const confidence = detail && detail.confidence ? Math.round(detail.confidence * 100) : null;

    const chip = document.createElement('div');
    chip.className = `inspector-tag-chip${isAi ? ' ai-tag' : ''}`;

    const colorConf = COLOR_TAG_MAP[tag];
    const colorDot = colorConf ? `<span class="tag-color-dot" style="background:${colorConf.color};"></span>` : '';
    const icon = isAi ? '<span class="ai-tag-pill-badge">AI</span> ' : (colorConf ? '' : '🏷️ ');
    const confSpan = (isAi && confidence) ? `<span class="ai-confidence-label">${confidence}%</span>` : '';
    const promoteBtn = isAi ? `<button type="button" class="promote-chip-btn" title="手動タグとして確定（昇格）">✓</button>` : '';

    chip.innerHTML = `
      <span style="display:inline-flex; align-items:center; gap:4px;">${colorDot}${icon}${escapeHtml(tag)}${confSpan}</span>
      <div style="display:inline-flex; align-items:center; gap:2px;">
        ${promoteBtn}
        <span class="inspector-tag-del" title="タグを削除">&times;</span>
      </div>
    `;

    if (isAi) {
      const pBtn = chip.querySelector('.promote-chip-btn');
      if (pBtn) {
        pBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await promoteTagForPhoto(photo.id, tag);
        });
      }
    }

    chip.querySelector('.inspector-tag-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeTagFromPhoto(photo.id, tag, chip, photo);
    });
    tagListEl.appendChild(chip);
  });
}

/**
 * インスペクタ内の手動タグツリーを共通描画 (折りたたみ・階層ツリー構造、各親フォルダ末尾およびルート最下段にインライン新規追加フォーム内蔵)
 */
function renderInspectorQuickTree(container, onSelect) {
  if (!container) return;
  container.innerHTML = '';

  // 展開状態キャッシュの初期化
  if (!state.inspectorQuickTreeExpandedPaths) {
    state.inspectorQuickTreeExpandedPaths = new Set();
  }

  // 手動タグのみ抽出し、カラーパレットに属する色タグも除外
  const manualTags = (state.availableTags || []).filter(t => {
    const isAi = t.source === 'ai';
    const isColor = (t.tag || t.name) in COLOR_TAG_MAP;
    return !isAi && !isColor;
  });

  function appendInlineAddRow(targetEl, parentFullPath = '', parentDisplayName = '', indent = 0) {
    const addRow = document.createElement('div');
    addRow.className = 'inspector-tree-inline-add';
    addRow.style.paddingLeft = `${indent * 12 + 6}px`;

    const placeholderText = parentFullPath
      ? `${parentDisplayName} の子タグ...`
      : '新しいタグ名を入力...';
    const titleText = parentFullPath
      ? `「${parentFullPath}/...」の子タグを作成して付与`
      : '新しいタグを作成して付与 (親/子 も可)';

    addRow.innerHTML = `
      <div class="inspector-tree-inline-left">
        <span class="tree-toggle-spacer"></span>
        <input type="text" class="inspector-tree-inline-input" placeholder="${escapeHtml(placeholderText)}" autocomplete="off" title="${escapeHtml(titleText)}">
      </div>
      <button type="button" class="apply-badge inspector-tree-inline-btn" title="${escapeHtml(titleText)}">+追加</button>
    `;

    const inputEl = addRow.querySelector('.inspector-tree-inline-input');
    const btnEl = addRow.querySelector('.inspector-tree-inline-btn');

    const submitInlineTag = () => {
      if (!inputEl) return;
      const cleanVal = inputEl.value.replace(/^\/+|\/+$/g, '').trim();
      if (!cleanVal) return;
      const fullTag = parentFullPath ? `${parentFullPath}/${cleanVal}` : cleanVal;

      // 追加したタグの親階層をすべて展開状態キャッシュに登録し、再描画後も開いたままにする
      const parts = fullTag.split('/');
      if (parts.length > 1) {
        let cur = '';
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur ? `${cur}/${parts[i]}` : parts[i];
          state.inspectorQuickTreeExpandedPaths.add(cur);
        }
      }

      inputEl.value = '';
      onSelect(fullTag);
    };

    addRow.addEventListener('click', (e) => e.stopPropagation());
    if (btnEl) {
      btnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        submitInlineTag();
      });
    }
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          submitInlineTag();
        }
      });
    }

    targetEl.appendChild(addRow);
  }

  // 「⚙️ ツリー編集」ショートカットボタンのイベントバインド
  document.querySelectorAll('.inspector-open-tag-editor-btn').forEach(btn => {
    if (!btn.dataset.bound) {
      btn.dataset.bound = 'true';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (elements.folderDbMaintenanceBtn) {
          elements.folderDbMaintenanceBtn.click();
        }
      });
    }
  });

  if (manualTags.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-hint';
    emptyEl.style.cssText = 'font-size:0.75rem; padding:6px 6px 4px 6px;';
    emptyEl.textContent = '手動タグはありません';
    container.appendChild(emptyEl);
    appendInlineAddRow(container, '', '', 0);
    return;
  }

  const treeRoot = buildTagTree(manualTags);

  // 単一表示時の対象写真に既に付いているタグ集合
  const activeSinglePhoto = (state.selectedPhotoIds.size <= 1 && state.activeInspectorPhotoId)
    ? state.photos.find(p => p.id === state.activeInspectorPhotoId)
    : null;
  const assignedTagsSet = new Set((activeSinglePhoto && Array.isArray(activeSinglePhoto.tags)) ? activeSinglePhoto.tags : []);

  function appendTreeItems(parentNode, targetEl, indent = 0) {
    parentNode.children.forEach(node => {
      const nodeWrapper = document.createElement('div');
      nodeWrapper.className = 'inspector-tree-node';

      const hasChildren = node.children.size > 0;
      const isExpanded = state.inspectorQuickTreeExpandedPaths.has(node.fullPath);
      const isAssigned = assignedTagsSet.has(node.fullPath);

      const item = document.createElement('div');
      item.className = `inspector-tree-item${isAssigned ? ' is-assigned-row' : ''}`;
      item.style.paddingLeft = `${indent * 12 + 6}px`;

      // 展開矢印またはスペーサー (親フォルダはデフォルト閉)
      let toggleBtnHtml = '<span class="tree-toggle-spacer"></span>';
      if (hasChildren) {
        toggleBtnHtml = `<span class="tree-toggle-btn ${isExpanded ? '' : 'collapsed'}" title="${isExpanded ? '折りたたむ' : '展開する'}">▼</span>`;
      }
      const icon = hasChildren ? '📁' : '🏷️';
      const countText = node.count != null ? `<span class="inspector-tree-count" title="付与されている写真枚数">${node.count}</span>` : '';
      const badgeText = isAssigned ? '✓付与済' : '+追加';
      const badgeTitle = isAssigned
        ? `「${escapeHtml(node.fullPath)}」はこの写真に付与済みです`
        : `「${escapeHtml(node.fullPath)}」を写真に付与`;

      item.innerHTML = `
        <div class="inspector-tree-item-left">
          ${toggleBtnHtml}
          <span style="flex-shrink:0;">${icon}</span>
          <span class="inspector-tree-name" title="${escapeHtml(node.fullPath)}">${escapeHtml(node.name)}</span>
          ${countText}
        </div>
        <div class="inspector-tree-item-actions">
          <button type="button" class="inspector-tag-edit-btn inspector-tag-subadd-btn" title="「${escapeHtml(node.name)}」の子タグを作成">+子</button>
          <span class="apply-badge${isAssigned ? ' is-assigned' : ''}" title="${badgeTitle}">${badgeText}</span>
        </div>
      `;

      nodeWrapper.appendChild(item);

      // 子ノードコンテナ（親ノードは常設、葉ノードも「+子」クリックでオンデマンド展開可能）
      let childrenContainer = document.createElement('div');
      childrenContainer.className = `inspector-tree-children${(hasChildren && isExpanded) ? '' : ' hidden'}`;
      if (hasChildren) {
        appendTreeItems(node, childrenContainer, indent + 1);
      }
      appendInlineAddRow(childrenContainer, node.fullPath, node.name, indent + 1);
      nodeWrapper.appendChild(childrenContainer);

      // アクションボタン群のイベント設定
      const subAddBtn = item.querySelector('.inspector-tag-subadd-btn');
      if (subAddBtn) {
        subAddBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          childrenContainer.classList.remove('hidden');
          state.inspectorQuickTreeExpandedPaths.add(node.fullPath);
          const toggleBtn = item.querySelector('.tree-toggle-btn');
          if (toggleBtn) toggleBtn.classList.remove('collapsed');
          const subInput = childrenContainer.querySelector(':scope > .inspector-tree-inline-add .inspector-tree-inline-input');
          if (subInput) setTimeout(() => subInput.focus(), 30);
        });
      }

      const applyBadge = item.querySelector('.apply-badge');
      if (applyBadge) {
        applyBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelect(node.fullPath);
        });
      }

      // 行クリック時の動作（親ノードの展開・折りたたみのみ。タグ付与は右端の「+追加」ボタン明示クリック時のみ実行）
      if (hasChildren) {
        item.addEventListener('click', (e) => {
          if (e.target.closest('.inspector-tree-item-actions') || e.target.closest('.tag-rename-input')) return;
          e.stopPropagation();
          const toggleBtn = item.querySelector('.tree-toggle-btn');
          const nowCollapsed = toggleBtn ? toggleBtn.classList.toggle('collapsed') : false;
          if (nowCollapsed) {
            state.inspectorQuickTreeExpandedPaths.delete(node.fullPath);
          } else {
            state.inspectorQuickTreeExpandedPaths.add(node.fullPath);
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

  appendTreeItems(treeRoot, container, 0);
  // ツリー全体の最下段にルート新規タグ追加フォームを配置
  appendInlineAddRow(container, '', '', 0);
}

/**
 * インスペクタ内のカラーパレット（色合い独立セクション）を描画
 * - 12色カラータイルで複数選択トグル可能 (一枚の画像に複数の色合いを自由に付与/解除)
 */
function renderInspectorColorPalette(container, photo = null, isBatch = false) {
  if (!container) return;
  container.innerHTML = '';

  const colorTagNames = Object.keys(COLOR_TAG_MAP);

  // 複数選択（バッチ）時の集計
  let batchActiveCounts = new Map();
  let totalSelected = 0;
  if (isBatch && state.selectedPhotoIds.size > 0) {
    totalSelected = state.selectedPhotoIds.size;
    const selectedPhotos = state.photos.filter(p => state.selectedPhotoIds.has(p.id));
    selectedPhotos.forEach(p => {
      if (p.tags) {
        colorTagNames.forEach(cName => {
          if (p.tags.includes(cName)) {
            batchActiveCounts.set(cName, (batchActiveCounts.get(cName) || 0) + 1);
          }
        });
      }
    });
  }

  colorTagNames.forEach(colorName => {
    const conf = COLOR_TAG_MAP[colorName];
    const chip = document.createElement('div');
    chip.className = 'inspector-color-chip';

    chip.style.background = conf.bg;
    chip.style.borderColor = conf.border;
    chip.style.color = conf.text;
    if (conf.shadow) {
      chip.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.6)';
    }

    let isActive = false;
    let isIndeterminate = false;

    if (!isBatch && photo) {
      isActive = !!(photo.tags && photo.tags.includes(colorName));
    } else if (isBatch && totalSelected > 0) {
      const count = batchActiveCounts.get(colorName) || 0;
      if (count === totalSelected) {
        isActive = true;
      } else if (count > 0) {
        isIndeterminate = true;
      }
    }

    if (isActive) {
      chip.classList.add('active');
    } else if (isIndeterminate) {
      chip.classList.add('indeterminate');
    }

    const checkIcon = isActive ? '<span class="inspector-color-chip-check">✓</span>' : (isIndeterminate ? '<span class="inspector-color-chip-check">-</span>' : '');
    chip.innerHTML = `${checkIcon}<span class="inspector-color-chip-label">${escapeHtml(conf.label || colorName)}</span>`;

    chip.setAttribute('title', isBatch
      ? `${colorName}\nクリック: 選択中写真(${totalSelected}枚)に一括${isActive ? '解除' : '付与'}`
      : `${colorName}\nクリックでこの写真に${isActive ? '解除' : '付与'}`);

    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!isBatch && photo) {
        // 単一写真: トグル操作
        if (isActive) {
          await removeTagFromPhoto(photo.id, colorName, null, photo);
        } else {
          await addTagToPhoto(photo.id, colorName, photo);
        }
      } else if (isBatch) {
        // バッチ写真: 一括トグル操作
        const shouldAdd = !isActive;
        await batchToggleTag(colorName, shouldAdd);
      }
    });

    container.appendChild(chip);
  });

  // アクティブ色数バッジの更新 (単一・一括)
  if (!isBatch) {
    if (elements.inspectorColorActiveCount) {
      const activeCount = photo && photo.tags ? colorTagNames.filter(c => photo.tags.includes(c)).length : 0;
      elements.inspectorColorActiveCount.textContent = activeCount > 0 ? `${activeCount}色` : '';
    }
  } else {
    if (elements.batchColorActiveCount) {
      let activeCount = 0;
      batchActiveCounts.forEach((c) => { if (c > 0) activeCount++; });
      elements.batchColorActiveCount.textContent = activeCount > 0 ? `${activeCount}色` : '';
    }
  }
}

/**
 * 単一写真にタグを追加 (即時DOM反映 ＆ キャッシュ即時同期)
 */
async function addTagToPhoto(photoId, tag, photoObj = null) {
  if (!tag || !tag.trim()) return;
  const tagName = tag.trim();
  const photo = photoObj || state.photos.find(p => p.id === photoId);
  if (photo) {
    if (!photo.tags) photo.tags = [];
    if (!photo.tags.includes(tagName)) {
      photo.tags.push(tagName);
    }
    if (!photo.tag_details) photo.tag_details = [];
    if (!photo.tag_details.some(d => d.tag === tagName)) {
      photo.tag_details.push({ tag: tagName, source: 'manual', confidence: 1.0 });
    }
    // スタックメンバーのキャッシュも同期
    if (photo.stack_photos && Array.isArray(photo.stack_photos)) {
      photo.stack_photos.forEach(sp => {
        if (!sp.tags) sp.tags = [];
        if (!sp.tags.includes(tagName)) sp.tags.push(tagName);
      });
    }
  }

  // 新規タグ・親階層タグが availableTags に未登録なら即時追加してツリーにも反映
  if (Array.isArray(state.availableTags)) {
    const parts = tagName.split('/').map(p => p.trim()).filter(Boolean);
    let curPath = '';
    parts.forEach(part => {
      curPath = curPath ? `${curPath}/${part}` : part;
      if (!state.availableTags.some(item => item.tag === curPath)) {
        state.availableTags.push({ tag: curPath, count: 1, source: 'manual' });
      }
    });
  }

  // インスペクタのタグ一覧・カラーパレット・クイックツリーを即時更新
  if (photo && state.activeInspectorPhotoId === photoId) {
    renderInspectorTagChips(photo);
    if (elements.inspectorColorGrid) {
      renderInspectorColorPalette(elements.inspectorColorGrid, photo, false);
    }
    if (elements.inspectorQuickTree) {
      renderInspectorQuickTree(elements.inspectorQuickTree, (tName) => {
        addTagToPhoto(photoId, tName, photo);
      });
    }
  }

  // ライトボックス側も同期
  const curLight = state.photos[state.currentPhotoIndex];
  if (curLight && curLight.id === photoId) {
    renderLightboxTags(curLight);
  }

  try {
    const res = await fetch(`/api/photo/${photoId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: tagName }),
    });
    if (!res.ok) throw new Error('タグの追加に失敗しました');

    await fetchTags();
    if (photo && state.activeInspectorPhotoId === photoId && elements.inspectorQuickTree) {
      renderInspectorQuickTree(elements.inspectorQuickTree, (tName) => {
        addTagToPhoto(photoId, tName, photo);
      });
    }
    renderPhotoGrid();
  } catch (err) {
    console.error('タグ追加エラー:', err);
    alert('エラー: ' + err.message);
  }
}

/**
 * 選択中写真に一括でタグを追加または削除する (カラーパレット一括操作・クイックツリー・新規タグ用)
 * 設定完了後に選択を解除し、現在のフィルタを再適用する (v2.02)
 */
async function batchToggleTag(tagName, shouldAdd) {
  if (state.selectedPhotoIds.size === 0 || !tagName) return;
  const photoIds = Array.from(state.selectedPhotoIds);

  // Optimistic UI: キャッシュのタグを即時更新
  photoIds.forEach(id => {
    const photo = state.photos.find(p => p.id === id);
    if (photo) {
      if (shouldAdd) {
        if (!photo.tags) photo.tags = [];
        if (!photo.tags.includes(tagName)) photo.tags.push(tagName);
        if (!photo.tag_details) photo.tag_details = [];
        if (!photo.tag_details.some(d => d.tag === tagName)) {
          photo.tag_details.push({ tag: tagName, source: 'manual', confidence: 1.0 });
        }
      } else {
        if (photo.tags) {
          photo.tags = photo.tags.filter(t => t !== tagName);
        }
        if (photo.tag_details) {
          photo.tag_details = photo.tag_details.filter(d => d.tag !== tagName);
        }
      }
      // スタックメンバーのキャッシュも同期
      if (photo.stack_photos && Array.isArray(photo.stack_photos)) {
        photo.stack_photos.forEach(sp => {
          if (shouldAdd) {
            if (!sp.tags) sp.tags = [];
            if (!sp.tags.includes(tagName)) sp.tags.push(tagName);
          } else if (sp.tags) {
            sp.tags = sp.tags.filter(t => t !== tagName);
          }
        });
      }
    }
  });

  try {
    const res = await fetch('/api/photos/batch-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: photoIds,
        tag: tagName,
        action: shouldAdd ? 'add' : 'remove',
      }),
    });
    if (!res.ok) throw new Error('一括タグ処理に失敗しました');

    // 設定完了後、選択を解除し、現在のフィルタ条件を再適用してグリッドとタグツリーを最新化
    clearSelection();
    await Promise.all([fetchPhotos(), fetchTags()]);
  } catch (err) {
    console.error('一括タグ更新エラー:', err);
    alert('エラー: ' + err.message);
    await Promise.all([fetchPhotos(), fetchTags()]);
  }
}

// 後方互換性エイリアス
const batchToggleTagWithoutClearing = batchToggleTag;

/**
 * 単一写真からタグを削除 (即時DOM反映 ＆ キャッシュ即時同期)
 */
async function removeTagFromPhoto(photoId, tag, chipEl = null, photoObj = null) {
  // 1. 即時DOM反映 (Optimistic UI - クリックされた瞬間にチップを削除)
  if (chipEl) {
    chipEl.remove();
  }

  // 2. メモリ上キャッシュの即時同期
  const photo = photoObj || state.photos.find(p => p.id === photoId);
  if (photo) {
    if (photo.tags) {
      photo.tags = photo.tags.filter(t => t !== tag && !t.startsWith(tag + '/'));
    }
    if (photo.tag_details) {
      photo.tag_details = photo.tag_details.filter(d => d.tag !== tag && !d.tag.startsWith(tag + '/'));
    }
    // スタックメンバーのキャッシュも同期
    if (photo.stack_photos && Array.isArray(photo.stack_photos)) {
      photo.stack_photos.forEach(sp => {
        if (sp.tags) {
          sp.tags = sp.tags.filter(t => t !== tag && !t.startsWith(tag + '/'));
        }
      });
    }
  }

  // インスペクタのタグ件数・空ヒント表示を即時更新 (色タグは除外)
  if (photo && elements.inspectorTagCount) {
    const leafTags = getLeafTags(photo.tags || []).filter(t => !(t in COLOR_TAG_MAP));
    elements.inspectorTagCount.textContent = `${leafTags.length}個`;
    if (leafTags.length === 0 && elements.inspectorTagList) {
      elements.inspectorTagList.innerHTML = '<span class="empty-hint" style="font-size:0.75rem;">タグなし</span>';
    }
  }

  // もしカラータグが削除された場合は、インスペクタ内のカラーパレットも同期再描画
  if (photo && (tag in COLOR_TAG_MAP) && elements.inspectorColorGrid) {
    renderInspectorColorPalette(elements.inspectorColorGrid, photo, false);
  }

  // ライトボックスが開いている場合はライトボックス側も同期
  const curLight = state.photos[state.currentPhotoIndex];
  if (curLight && curLight.id === photoId) {
    renderLightboxTags(curLight);
  }

  // 3. バックエンドAPI呼び出し
  try {
    const res = await fetch(`/api/photo/${photoId}/tags/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      // フォールバック: batch-tags API
      const fallbackRes = await fetch('/api/photos/batch-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photo_ids: [photoId],
          tag: tag,
          action: 'remove',
        }),
      });
      if (!fallbackRes.ok) throw new Error('タグ削除に失敗しました');
    }

    // サイドバーのタグ件数・カラーパレット更新
    fetchTags();

    // もし現在そのタグでフィルタリング中ならグリッドを再取得
    if (state.tagFilters.has(tag)) {
      fetchPhotos();
    } else {
      renderPhotoGrid();
    }
  } catch (err) {
    console.error('タグ削除エラー:', err);
    alert('エラー: ' + err.message);
    await Promise.all([fetchPhotos(), fetchTags()]);
  }
}

/**
 * 選択中の写真すべてからタグを一括削除
 */
async function batchRemoveTagFromSelection(tag) {
  if (state.selectedPhotoIds.size === 0) return;
  try {
    const res = await fetch('/api/photos/batch-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo_ids: Array.from(state.selectedPhotoIds),
        tag: tag,
        action: 'remove',
      }),
    });
    if (!res.ok) throw new Error('一括タグ削除に失敗しました');
    clearSelection();
    await Promise.all([fetchPhotos(), fetchTags()]);
  } catch (err) {
    alert('エラー: ' + err.message);
  }
}

/**
 * フィルタ切り替え


/**
 * インスペクター関連イベントリスナーの登録
 */
function initInspectorEvents() {
  if (elements.toggleInspectorBtn) {
    elements.toggleInspectorBtn.addEventListener('click', () => toggleInspector());
  }
  if (elements.closeInspectorBtn) {
    elements.closeInspectorBtn.addEventListener('click', () => toggleInspector(false));
  }

  // 単一インスペクタ: 新規タグ追加
  const executeInspectorNewTag = async () => {
    const val = elements.inspectorNewTagInput ? elements.inspectorNewTagInput.value.trim() : '';
    if (!val || !state.activeInspectorPhotoId) return;
    await addTagToPhoto(state.activeInspectorPhotoId, val);
    if (elements.inspectorNewTagInput) elements.inspectorNewTagInput.value = '';
  };

  if (elements.inspectorAddTagBtn) elements.inspectorAddTagBtn.addEventListener('click', executeInspectorNewTag);
  if (elements.inspectorNewTagInput) {
    elements.inspectorNewTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') executeInspectorNewTag();
    });
  }

  // 単一インスペクタ: 色合いパレットエキスパンダ開閉 (デフォルト閉じ v1.88)
  if (elements.inspectorColorHeader && elements.inspectorColorBody && elements.inspectorColorArrow) {
    elements.inspectorColorHeader.addEventListener('click', () => {
      const isHidden = elements.inspectorColorBody.style.display === 'none';
      elements.inspectorColorBody.style.display = isHidden ? 'block' : 'none';
      elements.inspectorColorArrow.textContent = isHidden ? '▼' : '▶';
      if (elements.inspectorColorPaletteBlock) {
        elements.inspectorColorPaletteBlock.classList.toggle('is-open', isHidden);
      }
    });
  }

  // 一括インスペクタ: 色合いパレットエキスパンダ開閉 (デフォルト閉じ v1.88)
  if (elements.batchColorHeader && elements.batchColorBody && elements.batchColorArrow) {
    elements.batchColorHeader.addEventListener('click', () => {
      const isHidden = elements.batchColorBody.style.display === 'none';
      elements.batchColorBody.style.display = isHidden ? 'block' : 'none';
      elements.batchColorArrow.textContent = isHidden ? '▼' : '▶';
      if (elements.batchColorPaletteBlock) {
        elements.batchColorPaletteBlock.classList.toggle('is-open', isHidden);
      }
    });
  }

  // 単一インスペクタ: AI自動タグ付けエキスパンダ開閉 (デフォルト閉じ)
  const aiHeader = elements.inspectorAiTagHeader || document.getElementById('inspectorAiTagHeader');
  const aiBody = elements.inspectorAiTagBody || document.getElementById('inspectorAiTagBody');
  const aiArrow = elements.inspectorAiTagArrow || document.getElementById('inspectorAiTagArrow');
  const aiBlock = elements.inspectorAiTagBlock || document.getElementById('inspectorAiTagBlock');

  if (aiHeader && aiBody && aiArrow) {
    aiHeader.addEventListener('click', () => {
      const isHidden = aiBody.style.display === 'none';
      aiBody.style.display = isHidden ? 'block' : 'none';
      aiArrow.textContent = isHidden ? '▼' : '▶';
      if (aiBlock) {
        aiBlock.classList.toggle('is-open', isHidden);
      }
    });
  }

  // 一括インスペクタ: 新規タグ追加
  const batchAddBtnEl = elements.batchAddTagBtn || document.getElementById('batchAddTagBtn');
  const batchNewTagInputEl = elements.batchNewTagInput || document.getElementById('batchNewTagInput');

  const executeBatchNewTag = async () => {
    const input = batchNewTagInputEl || document.getElementById('batchNewTagInput');
    const val = input ? input.value.trim() : '';
    if (!val || state.selectedPhotoIds.size === 0) return;
    if (input) input.value = '';
    await batchToggleTag(val, true);
  };

  if (batchAddBtnEl) batchAddBtnEl.addEventListener('click', executeBatchNewTag);
  if (batchNewTagInputEl) {
    batchNewTagInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') executeBatchNewTag();
    });
  }

  // 一括インスペクタ: 選択全解除
  if (elements.batchClearSelectionBtn) {
    elements.batchClearSelectionBtn.addEventListener('click', clearSelection);
  }

  // 詳細情報タブ: 重複写真の保存パスクリックイベント（パステキストリンクでフォルダを開く / 行クリックで写真切り替え）
  if (elements.inspectorPath) {
    elements.inspectorPath.addEventListener('click', (e) => {
      const link = e.target.closest('.multi-meta-link');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const pid = parseInt(link.dataset.photoId, 10);
        if (pid) openPhotoFolder(pid);
        return;
      }

      const item = e.target.closest('.multi-meta-item');
      if (item && !item.classList.contains('active')) {
        const pid = parseInt(item.dataset.photoId, 10);
        if (pid) {
          fetch(`/api/photo/${pid}`)
            .then(res => res.json())
            .then(p => {
              state.activeInspectorPhotoId = p.id;
              showSingleInspector(p);
            })
            .catch(err => console.error('写真切り替え失敗:', err));
        }
      }
    });
  }

  // 詳細情報タブ: 重複写真の保存ボリュームクリックイベント（写真切り替え）
  if (elements.inspectorVolume) {
    elements.inspectorVolume.addEventListener('click', (e) => {
      const item = e.target.closest('.multi-meta-item');
      if (item && !item.classList.contains('active')) {
        const pid = parseInt(item.dataset.photoId, 10);
        if (pid) {
          fetch(`/api/photo/${pid}`)
            .then(res => res.json())
            .then(p => {
              state.activeInspectorPhotoId = p.id;
              showSingleInspector(p);
            })
            .catch(err => console.error('写真切り替え失敗:', err));
        }
      }
    });
  }

  // 単一インスペクタ: ジオタグ削除
  const clearGpsBtn = elements.inspectorClearGpsBtn || document.getElementById('inspectorClearGpsBtn');
  if (clearGpsBtn) {
    clearGpsBtn.addEventListener('click', async () => {
      const pid = state.activeInspectorPhotoId;
      if (!pid) return;
      const photo = state.photos.find(p => p.id === pid);
      if (!photo) return;

      const confirmed = confirm(
        `「${photo.file_name}」のジオタグ情報（緯度・経度・地名）をSQLiteデータベースから削除しますか？\n\n` +
        `※ 元の写真ファイル（EXIF）は変更されません。`
      );
      if (!confirmed) return;

      try {
        const res = await fetch(`/api/photo/${pid}/gps`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);

        // 状態更新
        photo.latitude = null;
        photo.longitude = null;
        photo.gps_source = null;
        photo.country = null;
        photo.state = null;
        photo.city = null;

        showSingleInspector(photo);
        if (typeof showToast === 'function') {
          showToast('🗑️ ジオタグ情報を削除しました', 'info');
        }
        if (window.loadLocationTree) window.loadLocationTree();
      } catch (err) {
        console.error('ジオタグ削除エラー:', err);
        if (typeof showToast === 'function') {
          showToast('ジオタグの削除に失敗しました', 'error');
        }
      }
    });
  }

  // 一括インスペクタ: ジオタグ削除
  const batchClearGpsBtnEl = elements.batchClearGpsBtn || document.getElementById('batchClearGpsBtn');
  if (batchClearGpsBtnEl) {
    batchClearGpsBtnEl.addEventListener('click', () => {
      if (typeof executeBatchClearGps === 'function') executeBatchClearGps();
    });
  }

  // 一括インスペクタ: ジオタグ準用
  const batchInferGpsBtnEl = elements.batchInferGpsBtn || document.getElementById('batchInferGpsBtn');
  if (batchInferGpsBtnEl) {
    batchInferGpsBtnEl.addEventListener('click', () => {
      const floatingInferBtn = document.getElementById('floatingInferGpsBtn');
      if (floatingInferBtn) floatingInferBtn.click();
      else if (typeof executeBatchInferGps === 'function') executeBatchInferGps();
    });
  }
}
