/**
 * Photo Manager - ライトボックス & ズーム & フィルムストリップ (Lightbox Viewer)
 * 全画面写真プレビュー、EXIFドロワー、スタック切替、ズーム・パン、フィルムストリップを管理する。
 */

let _lightboxOpenRafId = null;
let _lightboxViewPreloadImg = null;

function openLightbox(index) {
  if (index < 0 || index >= state.photos.length) return;

  const photo = state.photos[index];
  state.currentPhotoIndex = index;
  state.currentRotation = photo ? (photo.rotation || 0) : 0;
  resetLightboxZoom();
  elements.lightboxModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // 1. メイン画像・EXIF・スタックバーを最優先で即時反映（0msでモーダル描画開始）
  loadLightboxPhoto(true, true);

  // 2. フィルムストリップが構築済みなら即時スクロール、未構築（1万枚超の初回等）なら次フレームで非同期構築
  const currentKey = `${state.photos.length}-${state.photos[0]?.id || 0}`;
  if (filmstripRenderedPhotosKey === currentKey && elements.filmstrip && elements.filmstrip.children.length === state.photos.length) {
    updateFilmstripActive(true);
  } else {
    if (_lightboxOpenRafId) {
      cancelAnimationFrame(_lightboxOpenRafId);
    }
    _lightboxOpenRafId = requestAnimationFrame(() => {
      _lightboxOpenRafId = null;
      if (state.currentPhotoIndex >= 0 && elements.lightboxModal.style.display !== 'none') {
        renderFilmstrip(true);
      }
    });
  }
}

/**
 * 現在ライトボックスで表示中の写真オブジェクトを取得（スタックメンバー表示中ならそのメンバー）
 */
function getCurrentLightboxPhoto() {
  if (state.currentPhotoIndex < 0) return null;
  if (state.currentLightboxStackPhotos && state.currentLightboxStackPhotos.length > 0 && state.currentLightboxStackIndex >= 0) {
    return state.currentLightboxStackPhotos[state.currentLightboxStackIndex] || state.photos[state.currentPhotoIndex];
  }
  return state.photos[state.currentPhotoIndex];
}

/**
 * ライトボックスの写真をロード
 * @param {boolean} [instantFilmstrip=false] trueの場合はフィルムストリップをアニメーションなしで即座に中央配置
 * @param {boolean} [skipFilmstrip=false] trueの場合はフィルムストリップ更新を呼び出し側に委ねる
 */
function loadLightboxPhoto(instantFilmstrip = false, skipFilmstrip = false) {
  const photo = state.photos[state.currentPhotoIndex];
  if (!photo) return;

  // 前の写真のスタック選択状態をクリアしてから露出ブラケット / 連写バースト比較バーを初期化＆描画
  state.currentLightboxStackPhotos = [];
  state.currentLightboxStackIndex = -1;
  state.currentLightboxStackType = null;
  renderLightboxBracketBar(photo);

  // 写真の表示内容（画像・EXIF・評価・代表バッジ・タグ）を更新
  updateLightboxContent(photo);

  // フィルムストリップのアクティブ更新＆ドック波形スクロール
  if (!skipFilmstrip) {
    updateFilmstripActive(instantFilmstrip);
  }
}

/**
 * ライトボックス内の写真コンテンツ（画像、EXIF、評価、タグ等）を更新
 */
function updateLightboxContent(photo) {
  if (!photo) return;

  elements.lightboxFileName.textContent = photo.file_name;
  if (photo.is_offline) {
    const volInfo = photo.volume_label ? ` — ${escapeHtml(photo.volume_label)}` : '';
    elements.lightboxMeta.innerHTML = `<span class="lightbox-offline-pill">プレビュー表示${volInfo}</span>${escapeHtml(photo.date_taken || '日付不明')} | ${escapeHtml(photo.camera_model || 'カメラ不明')}`;
  } else {
    elements.lightboxMeta.textContent = `${photo.date_taken || '日付不明'} | ${photo.camera_model || 'カメラ不明'}`;
  }

  // 実画像読み込み:
  // 1) グリッドで既にキャッシュ済みのサムネイルを即時表示して前回の残像や空白待ち時間をゼロにする
  // 2) フル解像度画像 (/view) をバックグラウンドでロードし、完了次第シームレスに差し替える
  const viewSrc = getPhotoViewUrl(photo);
  const thumbSrc = getThumbnailUrl(photo);
  const currentSrc = elements.lightboxImage.getAttribute('src') || '';
  if (currentSrc !== viewSrc) {
    if (_lightboxViewPreloadImg) {
      _lightboxViewPreloadImg.onload = null;
      _lightboxViewPreloadImg.onerror = null;
      _lightboxViewPreloadImg = null;
    }
    if (thumbSrc && currentSrc !== thumbSrc) {
      elements.lightboxImage.src = thumbSrc;
    }
    const targetPhotoId = photo.id;
    const preloader = new Image();
    _lightboxViewPreloadImg = preloader;
    preloader.onload = () => {
      if (_lightboxViewPreloadImg !== preloader) return;
      _lightboxViewPreloadImg = null;
      const activePhoto = getCurrentLightboxPhoto();
      if (activePhoto && activePhoto.id === targetPhotoId && elements.lightboxImage) {
        elements.lightboxImage.src = viewSrc;
      }
    };
    preloader.onerror = () => {
      if (_lightboxViewPreloadImg !== preloader) return;
      _lightboxViewPreloadImg = null;
      const activePhoto = getCurrentLightboxPhoto();
      if (activePhoto && activePhoto.id === targetPhotoId && elements.lightboxImage) {
        elements.lightboxImage.src = viewSrc;
      }
    };
    preloader.src = viewSrc;
    // ブラウザキャッシュに既にフル解像度画像がある場合は同期で即時反映
    if (preloader.complete && preloader.naturalWidth > 0) {
      _lightboxViewPreloadImg = null;
      elements.lightboxImage.src = viewSrc;
    }
  }
  if (elements.lightboxImage.complete && typeof window.refreshLightboxHistogram === 'function') {
    window.refreshLightboxHistogram();
  }
  state.currentRotation = (typeof hasBakedViewAdjustments === 'function' && hasBakedViewAdjustments(photo)) ? 0 : (photo.rotation || 0);
  applyLightboxTransform();

  // 評価ウィジェット＆スタック代表バッジ更新
  updateLightboxRating(photo.rating);
  updateLightboxPrimaryBtn(photo);

  // EXIFテーブル更新
  elements.exifFileName.textContent = photo.file_name;

  if (elements.exifFormat) {
    if (photo.paired_raw_path) {
      elements.exifFormat.textContent = 'JPEG + RAW (ペア)';
      if (elements.exifRawPairRow) {
        elements.exifRawPairRow.style.display = 'table-row';
        elements.exifRawPair.textContent = photo.paired_raw_path;
        elements.exifRawPair.title = photo.paired_raw_path;
      }
    } else if (photo.is_raw) {
      const fmt = (photo.raw_format || 'RAW').toUpperCase().replace('.', '');
      elements.exifFormat.textContent = `RAW (${fmt})`;
      if (elements.exifRawPairRow) elements.exifRawPairRow.style.display = 'none';
    } else {
      elements.exifFormat.textContent = 'JPEG / 一般画像';
      if (elements.exifRawPairRow) elements.exifRawPairRow.style.display = 'none';
    }
  }

  elements.exifDateTaken.textContent = photo.date_taken || '-';
  elements.exifCamera.textContent = photo.camera_model || '-';

  if (elements.exifLensRow && elements.exifLens) {
    if (photo.lens_model) {
      elements.exifLensRow.style.display = 'table-row';
      elements.exifLens.textContent = photo.lens_model;
      elements.exifLens.title = photo.lens_model;
    } else {
      elements.exifLensRow.style.display = 'none';
    }
  }

  if (elements.exifExposureRow && elements.exifExposureParams) {
    const hasExp = renderExposureTags(elements.exifExposureParams, photo);
    elements.exifExposureRow.style.display = hasExp ? 'table-row' : 'none';
  }

  if (elements.exifFocalRow && elements.exifFocalLength) {
    if (photo.focal_length != null) {
      elements.exifFocalRow.style.display = 'table-row';
      elements.exifFocalLength.textContent = `${photo.focal_length} mm`;
    } else {
      elements.exifFocalRow.style.display = 'none';
    }
  }

  elements.exifDimensions.textContent = (photo.width && photo.height) ? `${photo.width} x ${photo.height} px` : '-';
  elements.exifFileSize.textContent = formatBytes(photo.file_size);
  elements.exifPath.textContent = photo.file_path;

  // 写真タグ一覧の描画
  renderLightboxTags(photo);
}

/**
 * ライトボックス内の露出ブラケット / 連写バースト比較バーの描画
 */
function renderLightboxBracketBar(photo, initialMemberId = null) {
  if (!elements.lightboxBracketBar) return;
  const rawStackPhotos = photo.stack_photos || [];
  if (rawStackPhotos.length <= 1) {
    elements.lightboxBracketBar.style.display = 'none';
    state.currentLightboxStackPhotos = [];
    state.currentLightboxStackIndex = -1;
    state.currentLightboxStackType = null;
    return;
  }

  // スタック種別の判定:
  // 1. stack_type === 'duplicate'
  // 2. stack_type === 'burst'
  // 3. または、全写真の露出補正値 (exposure_bias) に差がない場合 (差 <= 0.05)
  const isDuplicate = (photo.stack_type === 'duplicate');
  const biases = rawStackPhotos.map(sp => sp.exposure_bias || 0.0);
  const minBias = Math.min(...biases);
  const maxBias = Math.max(...biases);
  const hasExposureDiff = (maxBias - minBias) > 0.05;
  const isBurst = !isDuplicate && ((photo.stack_type === 'burst') || (!hasExposureDiff));

  elements.lightboxBracketBar.style.display = 'flex';
  elements.lightboxBracketPills.innerHTML = '';

  // 並び順の決定:
  // ・連写バースト: 「左がスタート（0.00s）、右に向かって進行（++++）」になるよう時系列昇順で厳格にソート
  // ・露出ブラケット: カメラの撮影順（0 → - → + 等）によらず「左がEV-、右がEV+」になるよう露出補正値昇順でソート
  let stackPhotos = [...rawStackPhotos];
  if (isBurst) {
    stackPhotos.sort((a, b) => {
      const ta = getPhotoExactTimestamp(a);
      const tb = getPhotoExactTimestamp(b);
      if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 0.0001) {
        return ta - tb;
      }
      // タイムスタンプが取得できない、または等しい場合はファイル名自然順（連番）昇順
      const nameCmp = (a.file_name || '').localeCompare(b.file_name || '', undefined, { numeric: true, sensitivity: 'base' });
      if (nameCmp !== 0) return nameCmp;
      return (a.id || 0) - (b.id || 0);
    });
  } else if (!isDuplicate) {
    stackPhotos.sort((a, b) => {
      const ba = Number(a.exposure_bias) || 0.0;
      const bb = Number(b.exposure_bias) || 0.0;
      if (Math.abs(ba - bb) > 0.001) {
        return ba - bb;
      }
      const ta = getPhotoExactTimestamp(a);
      const tb = getPhotoExactTimestamp(b);
      if (ta > 0 && tb > 0 && Math.abs(ta - tb) > 0.0001) {
        return ta - tb;
      }
      return (a.id || 0) - (b.id || 0);
    });
  }

  // スタック状態を保持
  state.currentLightboxStackPhotos = stackPhotos;
  state.currentLightboxStackType = isDuplicate ? 'duplicate' : (isBurst ? 'burst' : 'bracket');
  const targetId = initialMemberId || photo.id;
  let activeIdx = stackPhotos.findIndex(sp => sp.id === targetId);
  if (activeIdx === -1) activeIdx = 0;
  state.currentLightboxStackIndex = activeIdx;

  if (elements.lightboxBracketBarLabel) {
    if (isDuplicate) {
      elements.lightboxBracketBarLabel.textContent = `重複写真グループ (${stackPhotos.length}枚) [↑/↓ または ホイールで比較]:`;
    } else if (isBurst) {
      elements.lightboxBracketBarLabel.textContent = `連写バースト (${stackPhotos.length}コマ) [↑:時間戻り / ↓:時間進み または ホイール]:`;
    } else {
      elements.lightboxBracketBarLabel.textContent = `露出ブラケット (${stackPhotos.length}枚) [↑:EV+ / ↓:EV- または ホイール]:`;
    }
  }

  if (isDuplicate) {
    // --- 重複スタック: 各コピーの保存先フォルダ名と解像度・サイズを表示 ---
    stackPhotos.forEach((sp, idx) => {
      const pill = document.createElement('button');
      pill.className = 'bracket-pill bracket-pill-dup';
      if (idx === activeIdx) pill.classList.add('active');

      const rawDir = sp.directory_path || '';
      const folderParts = rawDir.split(/[\\/]/).filter(Boolean);
      const folderName = folderParts.length > 0 ? folderParts[folderParts.length - 1] : `コピー${idx + 1}`;
      const isPri = Number(sp.is_stack_primary) === 1;
      if (isPri) pill.classList.add('is-primary');
      const labelText = isPri ? `[代表] ${folderName}` : folderName;

      pill.innerHTML = `
        <div class="bracket-pill-thumb">
          <img src="${getThumbnailUrl(sp)}" alt="${escapeHtml(sp.file_name)}" loading="lazy">
        </div>
        <span class="bracket-pill-label" title="${escapeHtml(sp.directory_path || '')}">${escapeHtml(labelText)}</span>
      `;

      const sizeStr = sp.file_size ? `${(sp.file_size / (1024 * 1024)).toFixed(2)}MB` : '';
      const resStr = (sp.width && sp.height) ? `${sp.width}×${sp.height}` : '';
      pill.title = `${sp.file_name}\n保存先: ${sp.directory_path || '不明'}\n解像度: ${resStr || '-'}\nサイズ: ${sizeStr || '-'}${isPri ? '\n(代表マスター写真)' : ''}`;

      pill.addEventListener('click', () => {
        selectLightboxStackMember(idx);
      });

      elements.lightboxBracketPills.appendChild(pill);
    });
  } else if (isBurst) {
    // --- 連写バースト: スタート写真からの秒ズレ (0.00s, +0.17s, +0.34s 等) を表示 ---
    const timestamps = stackPhotos.map(sp => getPhotoExactTimestamp(sp));
    const validTimestamps = timestamps.filter(t => t > 0);
    const startT = validTimestamps.length > 0 ? validTimestamps[0] : 0;
    // タイムスタンプに差分があるか（ミリ秒・秒が進んでいるか）
    const hasDiff = (startT > 0) && timestamps.some(t => Math.abs(t - startT) > 0.005);

    stackPhotos.forEach((sp, idx) => {
      const pill = document.createElement('button');
      pill.className = 'bracket-pill';
      if (idx === activeIdx) pill.classList.add('active');
      if (Number(sp.is_stack_primary) === 1) pill.classList.add('is-primary');

      let labelText = '';
      let diffSec = 0;

      if (idx === 0) {
        // 先頭コマは必ずスタート (0.00s)
        labelText = '0.00s';
      } else if (hasDiff && timestamps[idx] > 0 && startT > 0) {
        diffSec = timestamps[idx] - startT;
        if (diffSec <= 0.005) {
          // 同一秒・微小差
          labelText = `+${Math.max(0, diffSec).toFixed(2)}s`;
        } else {
          labelText = `+${diffSec.toFixed(2)}s`;
        }
      } else {
        // サブセック情報がなく撮影秒が同一、またはタイムスタンプ未取得の場合のフォールバック
        labelText = `+${idx}`;
      }

      pill.innerHTML = `
        <div class="bracket-pill-thumb">
          <img src="${getThumbnailUrl(sp)}" alt="${escapeHtml(sp.file_name)}" loading="lazy">
        </div>
        <span class="bracket-pill-label">${labelText}</span>
      `;

      const subStr = sp.subsec_time ? `.${sp.subsec_time}` : '';
      const timeStr = sp.date_taken ? `${sp.date_taken}${subStr}` : '';
      const diffStr = (idx === 0)
        ? '連写スタートコマ (0.000s)'
        : (diffSec > 0 ? `開始から +${diffSec.toFixed(3)}s` : `連写 #${idx + 1} コマ目`);
      pill.title = `${sp.file_name} (${labelText})\n${diffStr}\n撮影時刻: ${timeStr || '不明'}\n露出: ${sp.shutter_speed || '-'} ${sp.f_number ? 'F' + sp.f_number : ''}`;

      pill.addEventListener('click', () => {
        selectLightboxStackMember(idx);
      });

      elements.lightboxBracketPills.appendChild(pill);
    });
  } else {
    // --- 露出ブラケット: EV補正値 (-1.00 EV, ±0.00 EV, +1.00 EV) を表示 ---
    stackPhotos.forEach((sp, idx) => {
      const pill = document.createElement('button');
      pill.className = 'bracket-pill';
      if (idx === activeIdx) pill.classList.add('active');
      if (Number(sp.is_stack_primary) === 1) pill.classList.add('is-primary');

      const biasVal = sp.exposure_bias || 0.0;
      const sign = biasVal > 0 ? '+' : '';
      const labelText = `${sign}${biasVal.toFixed(2)} EV`;
      let biasClass = 'normal';
      if (biasVal > 0.05) biasClass = 'over';
      else if (biasVal < -0.05) biasClass = 'under';

      pill.innerHTML = `
        <div class="bracket-pill-thumb">
          <img src="${getThumbnailUrl(sp)}" alt="${escapeHtml(sp.file_name)}" loading="lazy">
        </div>
        <span class="bracket-pill-label ${biasClass}">${labelText}</span>
      `;
      pill.title = `${sp.file_name} (${sign}${biasVal.toFixed(2)} EV)\n${sp.shutter_speed || '-'} ${sp.f_number ? 'F' + sp.f_number : ''}`;

      pill.addEventListener('click', () => {
        selectLightboxStackMember(idx);
      });

      elements.lightboxBracketPills.appendChild(pill);
    });
  }
}

/**
 * スタックメンバー（一覧APIでは軽量項目のみ）の詳細メタデータを /api/photo/{id} から遅延取得して sp に補完する。
 * ローカルで更新済みの値（評価など）を古いサーバー値で上書きしないよう、sp に無い項目だけを追加する。
 * 取得失敗時も sp をそのまま返し、表示は軽量項目のまま継続する。
 */
function ensureStackMemberDetail(sp) {
  if (!sp || sp._detailLoaded) return Promise.resolve(sp);
  if (sp._detailPromise) return sp._detailPromise;

  sp._detailPromise = fetch(`/api/photo/${sp.id}`)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(detail => {
      for (const [key, value] of Object.entries(detail)) {
        // 入れ子のスタック情報は不要（親側で管理）
        if (key === 'stack_photos' || key === 'stack_count') continue;
        if (!(key in sp)) sp[key] = value;
      }
      sp._detailLoaded = true;
      return sp;
    })
    .catch(err => {
      console.error('スタックメンバー詳細の取得に失敗しました:', err);
      return sp;
    })
    .finally(() => {
      sp._detailPromise = null;
    });
  return sp._detailPromise;
}

/**
 * ライトボックス内で特定のスタックメンバーを選択表示する
 */
function selectLightboxStackMember(index) {
  if (!state.currentLightboxStackPhotos || index < 0 || index >= state.currentLightboxStackPhotos.length) {
    return;
  }
  state.currentLightboxStackIndex = index;
  const sp = state.currentLightboxStackPhotos[index];

  resetLightboxZoom();
  // ライトボックスの表示要素を sp で更新
  updateLightboxContent(sp);

  // 一覧APIのスタックメンバーは軽量項目のみのため、詳細（カメラ・レンズ・ISO・パス等）を遅延取得して再描画
  if (!sp._detailLoaded) {
    ensureStackMemberDetail(sp).then(() => {
      // 取得中に別のコマへ移動した、またはライトボックスを閉じた場合は描画しない
      const isStillActive = state.currentPhotoIndex >= 0
        && state.currentLightboxStackPhotos
        && state.currentLightboxStackPhotos[state.currentLightboxStackIndex] === sp;
      if (isStillActive) updateLightboxContent(sp);
    });
  }

  // ピルの active 表示を更新＆必要に応じてスクロール同期
  if (elements.lightboxBracketPills) {
    const pills = elements.lightboxBracketPills.querySelectorAll('.bracket-pill');
    pills.forEach((p, idx) => {
      const isActive = (idx === index);
      p.classList.toggle('active', isActive);
      if (isActive) {
        p.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    });
  }
}

/**
 * ライトボックス内でBKTまたはバーストの前後コマへ移動
 * @param {number} direction -1 (前のピル) または 1 (次のピル)
 */
function navigateStackMember(direction) {
  if (!state.currentLightboxStackPhotos || state.currentLightboxStackPhotos.length <= 1) {
    // スタックがない単独写真の場合は何もしない
    return;
  }
  const nextIndex = state.currentLightboxStackIndex + direction;
  // 端で止まる（0未満または要素数以上には進まない）
  if (nextIndex < 0 || nextIndex >= state.currentLightboxStackPhotos.length) {
    return;
  }
  selectLightboxStackMember(nextIndex);
}

/**
 * ライトボックス内で上下カーソルキー（↑/↓）によりスタック内メンバーを切り替える
 * - ↑ (up):   露出ブラケットは EV+ 方向、連写バースト/重複は 時間戻り(前) 方向
 * - ↓ (down): 露出ブラケットは EV- 方向、連写バースト/重複は 時間進み(次) 方向
 * @param {'up'|'down'} keyDir
 */
function navigateStackByVerticalKey(keyDir) {
  if (!state.currentLightboxStackPhotos || state.currentLightboxStackPhotos.length <= 1) {
    return;
  }
  const isBracket = state.currentLightboxStackType === 'bracket';
  let delta = 0;
  if (keyDir === 'up') {
    delta = isBracket ? 1 : -1;
  } else {
    delta = isBracket ? -1 : 1;
  }
  navigateStackMember(delta);
}

/**
 * ライトボックス内でスタックメンバー写真に表示を切り替える (後方互換ラッパー)
 */
function switchLightboxStackMember(sp, parentPhoto) {
  if (!sp) return;
  if (state.currentLightboxStackPhotos && state.currentLightboxStackPhotos.length > 0) {
    const idx = state.currentLightboxStackPhotos.findIndex(p => p.id === sp.id);
    if (idx !== -1) {
      selectLightboxStackMember(idx);
      return;
    }
  }
  updateLightboxContent(sp);
}

/**
 * スタック内の特定メンバー写真（sp）を指定してライトボックスを開く
 */
function openLightboxForStackMember(sp, parentPhoto) {
  if (!sp) return;

  // 1. グリッド一覧（state.photos）内で該当写真を検索
  let targetIndex = state.photos.findIndex(p => p.id === sp.id);

  // 2. なければスタック親（代表写真）または同一stack_idの写真を探す
  if (targetIndex === -1 && parentPhoto) {
    targetIndex = state.photos.findIndex(p => p.id === parentPhoto.id || (p.stack_id && p.stack_id === sp.stack_id));
  }

  // 3. ライトボックスを開く
  if (targetIndex >= 0) {
    openLightbox(targetIndex);
    // 開いた写真と sp が異なる場合は即座に sp に切り替える
    if (state.photos[targetIndex].id !== sp.id) {
      // ブラケットバーのピル生成＆アクティブ設定
      renderLightboxBracketBar(state.photos[targetIndex], sp.id);
      const memberIdx = state.currentLightboxStackPhotos.findIndex(p => p.id === sp.id);
      if (memberIdx !== -1) {
        selectLightboxStackMember(memberIdx);
      } else {
        updateLightboxContent(sp);
      }
    }
  } else if (state.photos.length > 0) {
    openLightbox(Math.max(0, state.currentPhotoIndex));
    updateLightboxContent(sp);
  }
}


/**
 * ライトボックス内タグ一覧の描画
 */
function renderLightboxTags(photo) {
  elements.photoTagsContainer.innerHTML = '';
  const tags = photo.tags || [];
  const leafTags = getLeafTags(tags);

  const detailsMap = {};
  if (photo.tag_details) {
    photo.tag_details.forEach(d => { detailsMap[d.tag] = d; });
  }

  if (leafTags.length === 0) {
    elements.photoTagsContainer.innerHTML = '<span style="font-size:0.75rem; color:var(--text-dim); font-style:italic;">タグなし</span>';
  } else {
    leafTags.forEach(t => {
      const detail = detailsMap[t];
      const isAi = detail && detail.source === 'ai';
      const confidence = detail && detail.confidence ? Math.round(detail.confidence * 100) : null;

      const chip = document.createElement('span');
      chip.className = `photo-tag-chip${isAi ? ' ai-tag' : ''}`;

      const icon = isAi ? '<span class="ai-tag-pill-badge">AI</span> ' : '';
      const confSpan = (isAi && confidence) ? `<span class="ai-confidence-label">${confidence}%</span>` : '';
      const promoteBtn = isAi ? `<button type="button" class="promote-chip-btn" title="手動タグとして確定（昇格）">✓</button>` : '';

      chip.innerHTML = `
        <span style="display:inline-flex; align-items:center; gap:2px;">${icon}${escapeHtml(t)}${confSpan}</span>
        <span style="display:inline-flex; align-items:center; gap:2px; margin-left:4px;">
          ${promoteBtn}
          <button type="button" class="remove-chip-btn" title="タグを削除">&times;</button>
        </span>
      `;

      if (isAi) {
        const pBtn = chip.querySelector('.promote-chip-btn');
        if (pBtn) {
          pBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await promoteTagForPhoto(photo.id, t);
          });
        }
      }

      chip.querySelector('.remove-chip-btn').addEventListener('click', async () => {
        await removeTagFromCurrentPhoto(photo.id, t);
      });

      elements.photoTagsContainer.appendChild(chip);
    });
  }

  // ライトボックス内AIタグ付けボタン
  if (elements.lightboxAiTagBtn) {
    elements.lightboxAiTagBtn.onclick = async () => {
      await triggerAiTagForSinglePhoto(photo.id, elements.lightboxAiTagBtn);
    };
  }
}

/**
 * 写真にタグを追加
 */
async function addTagToCurrentPhoto(photoId, tag) {
  if (!tag.trim()) return;
  try {
    const res = await fetch(`/api/photo/${photoId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: tag.trim() }),
    });
    if (!res.ok) throw new Error('タグ追加失敗');

    const photo = state.photos[state.currentPhotoIndex];
    if (photo) {
      if (!photo.tags) photo.tags = [];
      if (!photo.tags.includes(tag.trim())) {
        photo.tags.push(tag.trim());
      }
      renderLightboxTags(photo);
      renderPhotoGrid();
      fetchTags(); // サイドバーの件数も更新
    }
    elements.lightboxNewTagInput.value = '';
  } catch (err) {
    alert('エラー: ' + err.message);
  }
}

/**
 * 写真からタグを削除 (ライトボックス用)
 */
async function removeTagFromCurrentPhoto(photoId, tag) {
  try {
    const res = await fetch(`/api/photo/${photoId}/tags/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('タグ削除失敗');

    const photo = state.photos[state.currentPhotoIndex];
    if (photo) {
      if (photo.tags) photo.tags = photo.tags.filter(t => t !== tag && !t.startsWith(tag + '/'));
      if (photo.tag_details) photo.tag_details = photo.tag_details.filter(d => d.tag !== tag && !d.tag.startsWith(tag + '/'));
      renderLightboxTags(photo);
      if (state.isInspectorOpen && state.activeInspectorPhotoId === photoId) {
        updateInspectorView();
      }
      renderPhotoGrid();
      fetchTags();
    }
  } catch (err) {
    alert('エラー: ' + err.message);
  }
}

/**
 * AIタグを手動タグとして確定（昇格）する
 */
async function promoteTagForPhoto(photoId, tag) {
  try {
    const res = await fetch('/api/ai/promote-tag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_id: photoId, tag: tag }),
    });
    if (!res.ok) throw new Error('タグ昇格に失敗しました');

    // キャッシュ更新
    const photo = state.photos.find(p => p.id === photoId);
    if (photo && photo.tag_details) {
      const detail = photo.tag_details.find(d => d.tag === tag);
      if (detail) {
        detail.source = 'manual';
        detail.confidence = 1.0;
      }
    }
    if (state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
      state.activeInspectorPhotoId = photoId;
      clearSelection();
    } else if (state.isInspectorOpen && state.activeInspectorPhotoId === photoId) {
      updateInspectorView();
    }
    // ライトボックス再描画
    const curLight = state.photos[state.currentPhotoIndex];
    if (curLight && curLight.id === photoId) {
      renderLightboxTags(curLight);
    }
    renderPhotoGrid();
    fetchTags();
    showToast(`「${tag}」を手動タグとして確定しました`, 'success');
  } catch (err) {
    alert('エラー: ' + err.message);
  }
}

/**
 * 単体写真へのAI自動タグ付けをオンデマンド実行
 */
async function triggerAiTagForSinglePhoto(photoId, btnElement) {
  if (btnElement) {
    btnElement.disabled = true;
    btnElement.textContent = '解析中...';
  }
  try {
    const res = await fetch(`/api/ai/tag-photo/${photoId}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'AIタグ付けに失敗しました');

    const photo = state.photos.find(p => p.id === photoId);
    if (photo) {
      photo.tag_details = data.tags || [];
      photo.tags = photo.tag_details.map(d => d.tag);
    }

    if (state.currentPhotoIndex < 0 && state.selectedPhotoIds && state.selectedPhotoIds.size > 0 && typeof clearSelection === 'function') {
      state.activeInspectorPhotoId = photoId;
      clearSelection();
    } else if (state.isInspectorOpen && state.activeInspectorPhotoId === photoId) {
      updateInspectorView();
    }
    const curLight = state.photos[state.currentPhotoIndex];
    if (curLight && curLight.id === photoId) {
      renderLightboxTags(curLight);
    }
    renderPhotoGrid();
    fetchTags();

    const addedTags = (data.predicted || []).map(p => p.tag).join(', ');
    if (addedTags) {
      showToast(`AIタグを付与しました: ${addedTags}`, 'success');
    } else {
      showToast('この写真に該当するタグは見つかりませんでした', 'info');
    }
  } catch (err) {
    alert('AIタグ付けエラー: ' + err.message);
  } finally {
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.textContent = 'AIタグ';
    }
  }
}

/**
 * ライトボックス評価ウィジェットの更新
 */
function updateLightboxRating(rating) {
  const curRating = rating || 0;
  const btns = elements.lightboxRatingWidget.querySelectorAll('.rating-btn');
  btns.forEach(btn => {
    const ratingVal = parseInt(btn.dataset.rating, 10);
    btn.classList.toggle('active', ratingVal === curRating);
  });
}

/**
 * ライトボックス上部「代表」バッジボタンの表示・点灯状態を更新する
 */
function updateLightboxPrimaryBtn(photo) {
  const btn = elements.lightboxPrimaryBtn || document.getElementById('lightboxPrimaryBtn');
  if (!btn) return;

  const parentPhoto = state.photos[state.currentPhotoIndex];
  const hasStack = (state.currentLightboxStackPhotos && state.currentLightboxStackPhotos.length > 1)
    || (parentPhoto && Array.isArray(parentPhoto.stack_photos) && parentPhoto.stack_photos.length > 1)
    || (photo && Array.isArray(photo.stack_photos) && photo.stack_photos.length > 1);

  if (!photo || !hasStack) {
    btn.style.display = 'none';
    btn.classList.remove('active');
    return;
  }

  btn.style.display = 'inline-flex';
  const isPrimary = Number(photo.is_stack_primary) === 1;
  btn.classList.toggle('active', isPrimary);
  btn.title = isPrimary
    ? '現在のグループ代表写真です'
    : 'クリックしてこの写真をグループの代表に設定';
}

/**
 * 現在ライトボックスで表示中のスタックメンバーをグループの代表（Primary）に設定する
 */
async function setCurrentLightboxPhotoAsPrimary() {
  const current = getCurrentLightboxPhoto();
  if (!current) return;
  if (!state.currentLightboxStackPhotos || state.currentLightboxStackPhotos.length <= 1) return;
  if (Number(current.is_stack_primary) === 1) return;

  const btn = elements.lightboxPrimaryBtn || document.getElementById('lightboxPrimaryBtn');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/photo/${current.id}/set-primary`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const newPrimaryId = current.id;
    const oldPrimary = state.currentLightboxStackPhotos.find(p => Number(p.is_stack_primary) === 1);
    const oldPrimaryId = oldPrimary ? oldPrimary.id : (current.stack_id || newPrimaryId);

    // 1. ライトボックス内のスタック配列の代表フラグと stack_id を更新
    state.currentLightboxStackPhotos.forEach(sp => {
      sp.stack_id = newPrimaryId;
      sp.is_stack_primary = (sp.id === newPrimaryId) ? 1 : 0;
    });
    current.stack_id = newPrimaryId;
    current.is_stack_primary = 1;

    // 2. 上部「代表」バッジを即時ON（色つき）に更新
    updateLightboxPrimaryBtn(current);

    // 3. 下部ブラケット/バースト比較バーのピル表示（is-primary クラスや重複スタックの [代表] 表記）を更新
    if (elements.lightboxBracketPills) {
      const pills = elements.lightboxBracketPills.querySelectorAll('.bracket-pill');
      const isDuplicate = (state.currentLightboxStackType === 'duplicate');
      pills.forEach((pill, idx) => {
        const sp = state.currentLightboxStackPhotos[idx];
        if (!sp) return;
        const isPri = Number(sp.is_stack_primary) === 1;
        pill.classList.toggle('is-primary', isPri);
        if (isDuplicate) {
          const rawDir = sp.directory_path || '';
          const folderParts = rawDir.split(/[\\/]/).filter(Boolean);
          const folderName = folderParts.length > 0 ? folderParts[folderParts.length - 1] : `コピー${idx + 1}`;
          const labelEl = pill.querySelector('.bracket-pill-label');
          if (labelEl) {
            labelEl.textContent = isPri ? `[代表] ${folderName}` : folderName;
          }
          const sizeStr = sp.file_size ? `${(sp.file_size / (1024 * 1024)).toFixed(2)}MB` : '';
          const resStr = (sp.width && sp.height) ? `${sp.width}×${sp.height}` : '';
          pill.title = `${sp.file_name}\n保存先: ${sp.directory_path || '不明'}\n解像度: ${resStr || '-'}\nサイズ: ${sizeStr || '-'}${isPri ? '\n(代表マスター写真)' : ''}`;
        }
      });
    }

    // 4. 一覧（state.photos）・グリッドカード・フィルムストリップ・右インスペクタの同期更新
    await ensureStackMemberDetail(current);

    if (state.isStacked) {
      const idx = state.currentPhotoIndex;
      const oldGridPhoto = state.photos[idx];
      if (oldGridPhoto) {
        const syncedStackPhotos = (oldGridPhoto.stack_photos || state.currentLightboxStackPhotos).map(sp => {
          sp.stack_id = newPrimaryId;
          sp.is_stack_primary = (sp.id === newPrimaryId) ? 1 : 0;
          return sp;
        });
        const newGridPhoto = {
          ...oldGridPhoto,
          ...current,
          stack_id: newPrimaryId,
          is_stack_primary: 1,
          stack_photos: syncedStackPhotos,
          stack_count: oldGridPhoto.stack_count || state.currentLightboxStackPhotos.length,
          stack_type: oldGridPhoto.stack_type || state.currentLightboxStackType,
          duplicate_count: oldGridPhoto.duplicate_count,
        };
        state.photos[idx] = newGridPhoto;

        // メイングリッド上の該当カードを新しい代表写真カードに差し替え
        if (elements.photoGrid && typeof createPhotoCard === 'function') {
          const oldCard = elements.photoGrid.querySelector(`.photo-card[data-id="${oldPrimaryId}"], .photo-card[data-index="${idx}"]`);
          if (oldCard) {
            const newCard = createPhotoCard(newGridPhoto, idx);
            oldCard.replaceWith(newCard);
          }
        }

        // フィルムストリップ上の該当サムネイルを新しい代表写真に差し替え
        if (elements.filmstrip && elements.filmstrip.children[idx]) {
          const stripItem = elements.filmstrip.children[idx];
          const img = stripItem.querySelector('img');
          if (img) {
            img.src = getThumbnailUrl(newGridPhoto);
            img.alt = newGridPhoto.file_name || '';
          }
        }

        // 選択状態・右インスペクタの対象IDも新代表へ引き継ぎ
        if (state.selectedPhotoIds && state.selectedPhotoIds.has(oldPrimaryId)) {
          state.selectedPhotoIds.delete(oldPrimaryId);
          state.selectedPhotoIds.add(newPrimaryId);
        }
        if (state.activeInspectorPhotoId === oldPrimaryId) {
          state.activeInspectorPhotoId = newPrimaryId;
        }
      }
    } else {
      // スタック展開表示中（state.isStacked === false）は該当グループの全要素の stack_id / is_stack_primary を更新
      const memberIdSet = new Set(state.currentLightboxStackPhotos.map(sp => sp.id));
      state.photos.forEach(p => {
        if (memberIdSet.has(p.id) || p.stack_id === oldPrimaryId) {
          p.stack_id = newPrimaryId;
          p.is_stack_primary = (p.id === newPrimaryId) ? 1 : 0;
        }
        if (Array.isArray(p.stack_photos)) {
          p.stack_photos.forEach(sp => {
            if (memberIdSet.has(sp.id) || sp.stack_id === oldPrimaryId) {
              sp.stack_id = newPrimaryId;
              sp.is_stack_primary = (sp.id === newPrimaryId) ? 1 : 0;
            }
          });
        }
      });
    }

    if (state.isInspectorOpen && typeof updateInspectorView === 'function') {
      updateInspectorView();
    }

    if (typeof showToast === 'function') {
      showToast('グループの代表写真に設定しました', 'success');
    }
  } catch (err) {
    console.error('代表変更失敗:', err);
    if (typeof showToast === 'function') {
      showToast('代表写真の変更に失敗しました', 'warning');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

let isFilmstripDragging = false;
let filmstripHasDragged = false;
let filmstripStartX = 0;
let filmstripScrollStart = 0;

/**
 * フィルムストリップのインタラクション初期化（マウスホイール横スクロール & ドラッグスクロール）
 */
function initFilmstripInteractions() {
  if (!elements.filmstrip) return;

  // マウスホイールによる写真切替（ミニミニサムネイルと同様に1ノッチ1コマで前後の写真・スタックへ移動）
  let _filmstripWheelDelta = 0;
  let _lastFilmstripStepTime = 0;
  let _filmstripResetTimer = null;
  const FILMSTRIP_WHEEL_THRESHOLD = 80;   // 1写真進めるために必要なスクロール量
  const FILMSTRIP_STEP_INTERVAL = 110;    // コマ送りの最小間隔 (ms) : 暴走を防ぎ目視できるパラパラ送りに

  elements.filmstrip.addEventListener('wheel', (e) => {
    if (state.currentPhotoIndex < 0) return;
    if (!state.photos || state.photos.length <= 1) return;

    e.preventDefault();
    e.stopPropagation();

    const now = performance.now();
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    _filmstripWheelDelta += delta;

    // 閾値到達 ＆ 前回のコマ送りから適切なインターバルが経過している場合に移動
    if (Math.abs(_filmstripWheelDelta) >= FILMSTRIP_WHEEL_THRESHOLD) {
      if (now - _lastFilmstripStepTime >= FILMSTRIP_STEP_INTERVAL) {
        const direction = _filmstripWheelDelta > 0 ? 1 : -1;
        navigatePhoto(direction);
        _lastFilmstripStepTime = now;
        _filmstripWheelDelta = 0;
      }
    }

    // スクロール停止から200ms経過で半端な蓄積をクリア
    clearTimeout(_filmstripResetTimer);
    _filmstripResetTimer = setTimeout(() => {
      _filmstripWheelDelta = 0;
    }, 200);
  }, { passive: false });

  // マウスドラッグによる横スクロール
  elements.filmstrip.addEventListener('mousedown', (e) => {
    isFilmstripDragging = true;
    filmstripHasDragged = false;
    if (filmstripScrollRafId) {
      cancelAnimationFrame(filmstripScrollRafId);
      filmstripScrollRafId = null;
    }
    filmstripStartX = e.pageX - elements.filmstrip.offsetLeft;
    filmstripScrollStart = elements.filmstrip.scrollLeft;
    filmstripCurrentScroll = elements.filmstrip.scrollLeft;
    elements.filmstrip.classList.add('grabbing');
  });

  window.addEventListener('mouseup', () => {
    if (!isFilmstripDragging) return;
    isFilmstripDragging = false;
    elements.filmstrip.classList.remove('grabbing');
    // クリックイベントが直後に発火するため、微小遅延でドラッグ判定をリセット
    setTimeout(() => {
      filmstripHasDragged = false;
    }, 50);
  });

  elements.filmstrip.addEventListener('mousemove', (e) => {
    if (!isFilmstripDragging) return;
    const x = e.pageX - elements.filmstrip.offsetLeft;
    const walk = x - filmstripStartX;
    if (Math.abs(walk) > 5) {
      filmstripHasDragged = true;
    }
    elements.filmstrip.scrollLeft = filmstripScrollStart - walk;
    filmstripCurrentScroll = elements.filmstrip.scrollLeft;
    filmstripTargetScroll = filmstripCurrentScroll;
    updateFilmstripDockWave();
  });

  // スクロールバー直接操作時にもドック波形を同期更新
  elements.filmstrip.addEventListener('scroll', () => {
    if (!filmstripScrollRafId && !isFilmstripDragging) {
      filmstripCurrentScroll = elements.filmstrip.scrollLeft;
      updateFilmstripDockWave();
    }
  }, { passive: true });

  // ウィンドウリサイズ時に中央位置を再計算
  window.addEventListener('resize', () => {
    if (state.currentPhotoIndex >= 0 && elements.lightboxModal && elements.lightboxModal.style.display !== 'none') {
      scrollToActiveFilmstrip(true);
    }
  });

  // フィルムストリップのクリック委譲（個々のアイテムにリスナーを貼らず親で一括処理）
  elements.filmstrip.addEventListener('click', (e) => {
    if (filmstripHasDragged) return;
    const item = e.target.closest('.filmstrip-item');
    if (!item) return;
    const idx = parseInt(item.dataset.index, 10);
    if (!isNaN(idx) && idx >= 0 && idx < state.photos.length) {
      state.currentPhotoIndex = idx;
      state.currentRotation = 0;
      loadLightboxPhoto(false);
    }
  });
}

// フィルムストリップのObserver・キャッシュキー・連続Dock波形＆スムーズスクロール管理
let filmstripObserver = null;
let filmstripRenderedPhotosKey = null;
let filmstripScrollRafId = null;
let filmstripCurrentScroll = 0;
let filmstripTargetScroll = 0;
let lastWaveStartIdx = -1;
let lastWaveEndIdx = -1;
const DOCK_WAVE_RADIUS_PX = 290;  // 画面中央から左右290pxの範囲で滑らかに拡大・縮小
const DOCK_WAVE_INDEX_SPAN = 9;   // 中央インデックスから前後9枚のみ計算（O(1)負荷）
const FILMSTRIP_BASE_HEIGHT = 82; // サムネイルの基本高さ(px)

/**
 * フィルムストリップの現在スクロール位置（画面中央）に基づき、
 * 中央を通過するサムネイルがMacのDockのように滑らかに膨らみ、離れると縮む連続コサイン波形を適用する
 */
function updateFilmstripDockWave() {
  const strip = elements.filmstrip;
  if (!strip) return;
  const children = strip.children;
  const len = children.length;
  if (len === 0) return;

  const viewportCenter = strip.scrollLeft + strip.clientWidth * 0.5;

  // 二分探索で現在画面中央に最も近いアイテムのインデックスを O(log N) で特定
  let low = 0;
  let high = len - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    const midEl = children[mid];
    const midCenter = midEl.offsetLeft + midEl.offsetWidth * 0.5;
    if (midCenter < viewportCenter) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const centerIdx = low;
  const startIdx = Math.max(0, centerIdx - DOCK_WAVE_INDEX_SPAN);
  const endIdx = Math.min(len - 1, centerIdx + DOCK_WAVE_INDEX_SPAN);

  // 前回波形を適用していた範囲のうち、今回範囲外になった要素を初期状態へリセット
  if (lastWaveStartIdx >= 0 && lastWaveEndIdx >= 0) {
    for (let i = lastWaveStartIdx; i <= lastWaveEndIdx; i++) {
      if (i < startIdx || i > endIdx) {
        const el = children[i];
        if (el) {
          el.style.transform = '';
          el.style.opacity = '';
          el.style.zIndex = '';
          el.style.boxShadow = '';
          el.style.filter = '';
          el.classList.remove('active');
        }
      }
    }
  }

  // 画面中央付近（±18枚）のサムネイル<img>をオンデマンド生成・ロード（1万枚超でも初期DOM生成を極小化）
  const loadStart = Math.max(0, centerIdx - 18);
  const loadEnd = Math.min(len - 1, centerIdx + 18);
  for (let i = loadStart; i <= loadEnd; i++) {
    const el = children[i];
    if (!el) continue;
    if (!el.firstChild) {
      const p = state.photos[i];
      if (p) {
        const img = document.createElement('img');
        img.src = getThumbnailUrl(p);
        img.alt = p.file_name || '';
        el.appendChild(img);
      }
    } else if (el.firstChild.dataset && el.firstChild.dataset.src) {
      el.firstChild.src = el.firstChild.dataset.src;
      el.firstChild.removeAttribute('data-src');
    }
  }

  // 画面中央付近（±9枚）のみ連続コサイン・ベルカーブで scale / opacity をリアルタイム反映
  for (let i = startIdx; i <= endIdx; i++) {
    const el = children[i];
    if (!el) continue;

    const itemCenter = el.offsetLeft + el.offsetWidth * 0.5;
    const distPx = Math.abs(itemCenter - viewportCenter);

    if (i === state.currentPhotoIndex) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }

    if (distPx < DOCK_WAVE_RADIUS_PX) {
      const t = distPx / DOCK_WAVE_RADIUS_PX;
      // MacのDockと同じコサイン・ベルカーブ: 中央(t=0)で1.0、外側(t=1)で0.0へ滑らかに減衰
      const wave = 0.5 * (1 + Math.cos(Math.PI * t));
      const scale = 0.72 + wave * (1.16 - 0.72);
      const opacity = 0.30 + wave * (1.00 - 0.30);

      el.style.transform = `scale(${scale.toFixed(3)})`;
      el.style.opacity = opacity.toFixed(3);
      el.style.zIndex = String(Math.round(2 + wave * 10));
      el.style.filter = wave > 0.35 ? 'none' : `grayscale(${((1 - wave / 0.35) * 0.35).toFixed(2)})`;

      if (wave > 0.78) {
        const shadowIntensity = (wave - 0.78) / 0.22;
        el.style.boxShadow = `0 6px 18px rgba(0, 0, 0, ${(0.72 * shadowIntensity).toFixed(2)}), 0 0 0 1px rgba(255, 255, 255, ${(0.24 * shadowIntensity).toFixed(2)})`;
      } else {
        el.style.boxShadow = 'none';
      }
    } else {
      el.style.transform = '';
      el.style.opacity = '';
      el.style.zIndex = '';
      el.style.boxShadow = '';
      el.style.filter = '';
    }
  }

  lastWaveStartIdx = startIdx;
  lastWaveEndIdx = endIdx;
}

/**
 * フィルムストリップ（下部サムネイル列）の描画
 * - 同一の写真リストであればDOMを再構築せずアクティブ状態の更新のみ行う
 * - DBの寸法データから各サムネイルの横幅を事前確定し、遅延ロード時のガタつきを防止する
 * @param {boolean} [instant=false] trueの場合は初期表示として即座に中央へ配置
 */
function renderFilmstrip(instant = false) {
  if (!elements.filmstrip) return;

  // 写真リストが同一なら再構築せずアクティブ更新のみ
  const currentKey = `${state.photos.length}-${state.photos[0]?.id || 0}`;
  if (filmstripRenderedPhotosKey === currentKey && elements.filmstrip.children.length === state.photos.length) {
    updateFilmstripActive(instant);
    return;
  }
  filmstripRenderedPhotosKey = currentKey;
  lastWaveStartIdx = -1;
  lastWaveEndIdx = -1;

  // 既存のObserverとアニメーションをクリア
  if (filmstripObserver) {
    filmstripObserver.disconnect();
  }
  if (filmstripScrollRafId) {
    cancelAnimationFrame(filmstripScrollRafId);
    filmstripScrollRafId = null;
  }

  elements.filmstrip.innerHTML = '';

  const fragment = document.createDocumentFragment();
  const photos = state.photos;
  const total = photos.length;
  const curIdx = state.currentPhotoIndex;

  for (let idx = 0; idx < total; idx++) {
    const photo = photos[idx];
    const item = document.createElement('div');
    item.className = 'filmstrip-item';
    item.dataset.index = idx;

    // DBの寸法・回転・クロップからアスペクト比を算出し、画像ロード前から正確な横幅を確定
    let pw = Number(photo.width) || 0;
    let ph = Number(photo.height) || 0;
    const rot = ((Number(photo.rotation) || 0) % 360 + 360) % 360;
    if (rot === 90 || rot === 270) {
      const tmp = pw; pw = ph; ph = tmp;
    }
    if (photo.crop_w != null && photo.crop_h != null && pw > 0 && ph > 0) {
      pw = pw * Number(photo.crop_w);
      ph = ph * Number(photo.crop_h);
    }
    const ar = (pw > 0 && ph > 0) ? Math.max(0.45, Math.min(2.4, pw / ph)) : 1.333;
    const itemWidth = Math.round(FILMSTRIP_BASE_HEIGHT * ar);
    item.style.width = `${itemWidth}px`;

    // 現在選択中インデックスの前後12枚のみ初期<img>を生成し、それ以外は updateFilmstripDockWave で遅延生成
    if (Math.abs(idx - curIdx) <= 12) {
      const img = document.createElement('img');
      img.src = getThumbnailUrl(photo);
      img.alt = photo.file_name || '';
      item.appendChild(img);
    }
    fragment.appendChild(item);
  }
  elements.filmstrip.appendChild(fragment);
  scrollToActiveFilmstrip(true);
}

/**
 * requestAnimationFrame による滑らかなイージング追従スクロール
 */
function stepFilmstripScroll() {
  if (!elements.filmstrip || isFilmstripDragging) {
    filmstripScrollRafId = null;
    return;
  }
  const diff = filmstripTargetScroll - filmstripCurrentScroll;
  if (Math.abs(diff) <= 0.5) {
    filmstripCurrentScroll = filmstripTargetScroll;
    elements.filmstrip.scrollLeft = Math.round(filmstripCurrentScroll);
    updateFilmstripDockWave();
    filmstripScrollRafId = null;
    return;
  }
  // 連続入力時にも速度がリセットされず滑らかに追従する減衰補間
  filmstripCurrentScroll += diff * 0.22;
  elements.filmstrip.scrollLeft = filmstripCurrentScroll;
  updateFilmstripDockWave();
  filmstripScrollRafId = requestAnimationFrame(stepFilmstripScroll);
}

/**
 * フィルムストリップのアクティブ要素が画面の正中央に来るようスクロール
 * @param {boolean} [instant=false] trueの場合はアニメーションなしで即座に中央へ移動
 */
function scrollToActiveFilmstrip(instant = false) {
  const strip = elements.filmstrip;
  if (!strip) return;
  const activeEl = strip.children[state.currentPhotoIndex];
  if (!activeEl) return;

  const targetScroll = Math.max(
    0,
    activeEl.offsetLeft + activeEl.offsetWidth * 0.5 - strip.clientWidth * 0.5
  );
  filmstripTargetScroll = targetScroll;

  if (instant) {
    if (filmstripScrollRafId) {
      cancelAnimationFrame(filmstripScrollRafId);
      filmstripScrollRafId = null;
    }
    filmstripCurrentScroll = targetScroll;
    strip.scrollLeft = Math.round(targetScroll);
    updateFilmstripDockWave();
  } else {
    if (!filmstripScrollRafId) {
      filmstripCurrentScroll = strip.scrollLeft;
      filmstripScrollRafId = requestAnimationFrame(stepFilmstripScroll);
    }
  }
}

function updateFilmstripActive(instant = false) {
  scrollToActiveFilmstrip(instant);
}

/**
 * ライトボックスを閉じる
 */
function closeLightbox() {
  if (_lightboxOpenRafId) {
    cancelAnimationFrame(_lightboxOpenRafId);
    _lightboxOpenRafId = null;
  }
  if (_lightboxViewPreloadImg) {
    _lightboxViewPreloadImg.onload = null;
    _lightboxViewPreloadImg.onerror = null;
    _lightboxViewPreloadImg = null;
  }
  if (filmstripScrollRafId) {
    cancelAnimationFrame(filmstripScrollRafId);
    filmstripScrollRafId = null;
  }
  elements.lightboxModal.style.display = 'none';
  elements.exifDrawer.style.display = 'none';
  state.currentPhotoIndex = -1;
  state.currentLightboxStackPhotos = [];
  state.currentLightboxStackIndex = -1;
  state.currentLightboxStackType = null;
  resetLightboxZoom();
  document.body.style.overflow = '';
}

/**
 * 前後の写真へ移動
 */
function navigatePhoto(direction) {
  if (state.currentPhotoIndex === -1) return;
  const newIndex = state.currentPhotoIndex + direction;
  if (newIndex >= 0 && newIndex < state.photos.length) {
    state.currentPhotoIndex = newIndex;
    state.currentRotation = 0;
    resetLightboxZoom();
    loadLightboxPhoto();
  }
}

/**
 * フィルタードロワー（手帳風インデックスタブ ＆ オーバーラップ開閉 ＆ ピン留め固定）制御

 */
function showZoomBadge(percent) {
  if (!elements.lightboxZoomBadge) return;
  elements.lightboxZoomBadge.textContent = `${percent}%`;
  elements.lightboxZoomBadge.style.display = 'block';
  clearTimeout(_zoomBadgeTimer);
  _zoomBadgeTimer = setTimeout(() => {
    if (elements.lightboxZoomBadge) {
      elements.lightboxZoomBadge.style.display = 'none';
    }
  }, 900);
}

/**
 * ライトボックス画像の変形（パン・回転・ズーム）を一括適用
 */
function applyLightboxTransform(isImmediate = false) {
  if (!elements.lightboxImage) return;
  if (isImmediate) {
    elements.lightboxImage.style.transition = 'none';
  }
  const { lightboxPanX, lightboxPanY, currentRotation, lightboxZoom } = state;
  elements.lightboxImage.style.transform = `translate(${lightboxPanX}px, ${lightboxPanY}px) rotate(${currentRotation}deg) scale(${lightboxZoom})`;
  elements.lightboxImage.style.cursor = lightboxZoom > 1.02 ? (state.isLightboxPanning ? 'grabbing' : 'grab') : 'default';
}

/**
 * ライトボックスのズーム・パンを等倍・中央にリセット
 */
function resetLightboxZoom() {
  state.lightboxZoom = 1.0;
  state.lightboxPanX = 0;
  state.lightboxPanY = 0;
  state.isLightboxPanning = false;
  if (elements.lightboxImage) {
    elements.lightboxImage.style.transition = 'transform 0.15s ease';
    elements.lightboxImage.style.cursor = 'default';
  }
  applyLightboxTransform();
  if (elements.lightboxZoomBadge) {
    elements.lightboxZoomBadge.style.display = 'none';
  }
}

let _lightboxZoomInitialized = false;

/**
 * ライトボックスのズーム＆パン操作、およびミニサムネイル上でのコマ送りホイール操作の初期化
 */
function initLightboxZoomInteractions() {
  if (_lightboxZoomInitialized) return;
  if (!elements.imageStage || !elements.lightboxImage) return;
  _lightboxZoomInitialized = true;

  const zoomContainer = elements.imageStage.closest('.lightbox-body') || elements.imageStage;

  // 1. ネイティブの画像ドラッグ禁止
  elements.lightboxImage.addEventListener('dragstart', (e) => e.preventDefault());

  // 2. メイン画像・ステージ全体でのマウスホイール操作: 拡大縮小 (カーソル位置追従ズーム)
  zoomContainer.addEventListener('wheel', (e) => {
    if (state.currentPhotoIndex < 0) return;
    // ブラケットバー、EXIFドロワー、前後矢印ボタン上でのスクロールは除外
    if (e.target.closest('#lightboxBracketBar, #exifDrawer, .nav-arrow')) return;

    e.preventDefault();

    const oldZoom = (typeof state.lightboxZoom === 'number' && !isNaN(state.lightboxZoom)) ? state.lightboxZoom : 1.0;

    // 連続発火や高解像度ホイールでの暴走を防ぐため、1回のdeltaYを穏やかに正規化
    const clampedDelta = Math.max(-80, Math.min(80, e.deltaY));
    // 1ノッチ(約80)あたり約8%の穏やかな変化率
    const zoomRatio = Math.exp(-clampedDelta * 0.001);
    let newZoom = Math.max(1.0, Math.min(4.0, oldZoom * zoomRatio));

    // 縮小操作（clampedDelta > 0）時のみ、100%付近（1.03以下）で等倍フィットへ自然に吸着
    // ※拡大開始時に 1.03 以下でリセットされて拡大がブロックされるデグレを防止
    if (clampedDelta > 0 && newZoom <= 1.03) {
      resetLightboxZoom();
      showZoomBadge(100);
      return;
    }

    // カーソル位置へ向かって拡大するパン補正
    const rect = elements.imageStage.getBoundingClientRect();
    const cursorX = e.clientX - (rect.left + rect.width / 2);
    const cursorY = e.clientY - (rect.top + rect.height / 2);

    const ratio = newZoom / oldZoom;
    state.lightboxPanX = cursorX - (cursorX - state.lightboxPanX) * ratio;
    state.lightboxPanY = cursorY - (cursorY - state.lightboxPanY) * ratio;
    state.lightboxZoom = newZoom;

    if (elements.lightboxImage) {
      elements.lightboxImage.style.transition = 'transform 0.06s ease-out';
    }
    applyLightboxTransform();
    showZoomBadge(Math.round(newZoom * 100));
  }, { passive: false });

  // 3. 露出ブラケット / 連写バーストのミニサムネイルバー上でのホイール操作 (コマ送り)
  if (elements.lightboxBracketBar) {
    let _bracketWheelDelta = 0;
    let _lastBracketStepTime = 0;
    let _bracketResetTimer = null;
    const WHEEL_THRESHOLD = 80;    // 1コマ送りに必要なスクロール量 (標準マウス1ノッチ≒100〜120)
    const MIN_STEP_INTERVAL = 110;  // コマ送りの最小間隔 (ms) : 暴走を防ぎ目視できるパラパラ送りに

    elements.lightboxBracketBar.addEventListener('wheel', (e) => {
      if (state.currentPhotoIndex < 0) return;
      if (!state.currentLightboxStackPhotos || state.currentLightboxStackPhotos.length <= 1) return;

      e.preventDefault();
      e.stopPropagation();

      const now = performance.now();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      _bracketWheelDelta += delta;

      // 閾値到達 ＆ 前回のコマ送りから適切なインターバルが経過している場合に移動
      if (Math.abs(_bracketWheelDelta) >= WHEEL_THRESHOLD) {
        if (now - _lastBracketStepTime >= MIN_STEP_INTERVAL) {
          const direction = _bracketWheelDelta > 0 ? 1 : -1;
          navigateStackMember(direction);
          _lastBracketStepTime = now;
          _bracketWheelDelta = 0;
        }
      }

      // スクロール停止から200ms経過で半端な蓄積をクリア
      clearTimeout(_bracketResetTimer);
      _bracketResetTimer = setTimeout(() => {
        _bracketWheelDelta = 0;
      }, 200);
    }, { passive: false });
  }

  // 4. 拡大中のマウスクリック＆ドラッグによるパン移動
  zoomContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 左クリックのみ
    if (e.target.closest('#lightboxBracketBar, #exifDrawer, .nav-arrow, .lightbox-tags-section, button, input')) return;
    if (state.lightboxZoom > 1.02) {
      state.isLightboxPanning = true;
      state.lightboxPanStartX = e.clientX - state.lightboxPanX;
      state.lightboxPanStartY = e.clientY - state.lightboxPanY;
      applyLightboxTransform(true);
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.isLightboxPanning) return;
    state.lightboxPanX = e.clientX - state.lightboxPanStartX;
    state.lightboxPanY = e.clientY - state.lightboxPanStartY;
    applyLightboxTransform(true);
  });

  window.addEventListener('mouseup', () => {
    if (state.isLightboxPanning) {
      state.isLightboxPanning = false;
      if (elements.lightboxImage) {
        elements.lightboxImage.style.transition = 'transform 0.15s ease';
      }
      applyLightboxTransform();
    }
  });

  // 5. ダブルクリックで 1.0倍 ⇔ 2.0倍 のトグル
  zoomContainer.addEventListener('dblclick', (e) => {
    if (e.target.closest('#lightboxBracketBar, #exifDrawer, .nav-arrow, .lightbox-tags-section, button, input')) return;
    if (state.lightboxZoom > 1.05) {
      resetLightboxZoom();
      showZoomBadge(100);
    } else {
      const rect = elements.imageStage.getBoundingClientRect();
      const cursorX = e.clientX - (rect.left + rect.width / 2);
      const cursorY = e.clientY - (rect.top + rect.height / 2);
      state.lightboxZoom = 2.0;
      state.lightboxPanX = -cursorX * 1.0;
      state.lightboxPanY = -cursorY * 1.0;
      if (elements.lightboxImage) {
        elements.lightboxImage.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
      }
      applyLightboxTransform();
      showZoomBadge(200);
    }
  });
}

/**
 * 写真グリッド親コンテナへのイベント委譲（カードごとのリスナー生成を完全撤廃し、メモリとレンダリング負荷を最小化）


/**
 * ライトボックス関連イベントリスナーの登録
 */
function initLightboxEvents() {
  if (elements.closeLightboxBtn) elements.closeLightboxBtn.addEventListener('click', closeLightbox);
  if (elements.prevPhotoBtn) elements.prevPhotoBtn.addEventListener('click', () => navigatePhoto(-1));
  if (elements.nextPhotoBtn) elements.nextPhotoBtn.addEventListener('click', () => navigatePhoto(1));

  if (elements.rotateBtn) {
    elements.rotateBtn.addEventListener('click', () => {
      const current = getCurrentLightboxPhoto();
      if (current && typeof window.rotatePhotoQuick === 'function') {
        window.rotatePhotoQuick(current.id, 90);
      } else {
        state.currentRotation = (state.currentRotation + 90) % 360;
        applyLightboxTransform();
      }
    });
  }

  const rotLeftBtn = document.getElementById('lightboxRotateLeftBtn');
  if (rotLeftBtn) {
    rotLeftBtn.addEventListener('click', () => {
      const current = getCurrentLightboxPhoto();
      if (current && typeof window.rotatePhotoQuick === 'function') {
        window.rotatePhotoQuick(current.id, -90);
      } else {
        state.currentRotation = (state.currentRotation - 90 + 360) % 360;
        applyLightboxTransform();
      }
    });
  }

  const resetAdjustBtn = document.getElementById('lightboxResetAdjustBtn');
  if (resetAdjustBtn) {
    resetAdjustBtn.addEventListener('click', () => {
      const current = getCurrentLightboxPhoto();
      if (current && typeof window.resetPhotoAdjustmentsQuick === 'function') {
        window.resetPhotoAdjustmentsQuick(current.id);
      } else {
        state.currentRotation = 0;
        applyLightboxTransform();
      }
    });
  }

  const adjustBtn = document.getElementById('lightboxAdjustBtn');
  if (adjustBtn) {
    adjustBtn.addEventListener('click', () => {
      const current = getCurrentLightboxPhoto();
      if (current && typeof window.openImageAdjustModal === 'function') {
        window.openImageAdjustModal(current);
      }
    });
  }

  if (elements.toggleExifBtn) {
    elements.toggleExifBtn.addEventListener('click', () => {
      if (elements.exifDrawer) {
        const isHidden = elements.exifDrawer.style.display === 'none' || !elements.exifDrawer.style.display;
        elements.exifDrawer.style.display = isHidden ? 'block' : 'none';
        elements.toggleExifBtn.classList.toggle('active', isHidden);
      }
    });
  }

  const primaryBtn = elements.lightboxPrimaryBtn || document.getElementById('lightboxPrimaryBtn');
  if (primaryBtn) {
    primaryBtn.addEventListener('click', () => {
      setCurrentLightboxPhotoAsPrimary();
    });
  }

  if (elements.lightboxRatingWidget) {
    elements.lightboxRatingWidget.querySelectorAll('.rating-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const rating = parseInt(btn.dataset.rating, 10);
        const current = getCurrentLightboxPhoto();
        if (current) {
          const newRating = (current.rating === rating) ? 0 : rating;
          updatePhotoRating(current.id, newRating);
        }
      });
    });
  }

  initFilmstripInteractions();
  initLightboxZoomInteractions();
}
