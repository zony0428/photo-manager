const _FORBIDDEN_VOL_LABEL_REGEX = /[*?/\\|.,;:+=[\]<>"]/;

function validatePhysicalVolumeLabelInput(rawVal) {
  const val = String(rawVal || '').trim();
  if (!val) {
    return { valid: true, cleaned: '', error: '' };
  }
  for (let i = 0; i < val.length; i++) {
    const code = val.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      return {
        valid: false,
        cleaned: val,
        error: '2バイト文字（日本語・全角文字・環境依存文字）は使用できません。半角英数字・ハイフン(-)・アンダースコア(_)のみで入力してください。',
      };
    }
  }
  if (_FORBIDDEN_VOL_LABEL_REGEX.test(val)) {
    return {
      valid: false,
      cleaned: val,
      error: '使用できない記号が含まれています。半角英数字・ハイフン(-)・アンダースコア(_)のみ使用できます。',
    };
  }
  if (val.length > 11) {
    return {
      valid: false,
      cleaned: val,
      error: `半角11文字以内で指定してください（現在 ${val.length} 文字）。`,
    };
  }
  return { valid: true, cleaned: val, error: '' };
}

async function promptRenameVolume(volumeSerial, currentCustomName = '', volumeLabel = '', driveLetter = '') {
  if (!volumeSerial) {
    showToast('このメディアにはボリュームシリアル番号(VSN)が記録されていません', 'warning');
    return null;
  }

  const modal = document.getElementById('volumeIdentityModal');
  if (!modal) return null;

  const onlineBadgeEl = document.getElementById('volModalOnlineBadge');
  const currentLabelEl = document.getElementById('volModalCurrentLabel');
  const serialTextEl = document.getElementById('volModalSerialText');
  const customInputEl = document.getElementById('volModalCustomNameInput');
  const writeCheckEl = document.getElementById('volModalWriteLabelCheck');
  const offlineHintEl = document.getElementById('volModalOfflineHint');
  const writePanelEl = document.getElementById('volModalWriteLabelPanel');
  const physInputEl = document.getElementById('volModalPhysicalLabelInput');
  const charCountEl = document.getElementById('volModalLabelCharCount');
  const labelErrorEl = document.getElementById('volModalLabelError');
  const targetPinEl = document.getElementById('volModalTargetPin');
  const pinInputEl = document.getElementById('volModalPinInput');
  const closeBtnEl = document.getElementById('closeVolumeIdentityModalBtn');
  const cancelBtnEl = document.getElementById('btnCancelVolumeIdentityModal');
  const submitBtnEl = document.getElementById('btnSubmitVolumeIdentityModal');

  const shortId = volumeSerial.length === 8 ? `${volumeSerial.slice(0, 4)}-${volumeSerial.slice(4)}` : volumeSerial;
  let statusData = {
    custom_name: currentCustomName || '',
    volume_label: volumeLabel || '',
    drive_letter: driveLetter || '',
    filesystem: '',
    is_online: false,
    approval_pin: '',
  };

  try {
    const sRes = await fetch(`/api/volumes/${encodeURIComponent(volumeSerial)}/status`);
    if (sRes.ok) {
      const sJson = await sRes.json();
      statusData = { ...statusData, ...sJson };
    }
  } catch (e) {
    console.warn('ボリューム状態取得スキップ:', e);
  }

  const isOnline = Boolean(statusData.is_online);
  const driveStr = statusData.drive_letter ? `${statusData.drive_letter}` : '';
  const fsStr = statusData.filesystem ? ` / ${statusData.filesystem}` : '';
  if (onlineBadgeEl) {
    onlineBadgeEl.textContent = isOnline
      ? `● 接続中 (${driveStr}${fsStr})`
      : '○ 未接続';
    onlineBadgeEl.style.color = isOnline ? '#22c55e' : 'var(--warning, #e67e22)';
  }
  if (currentLabelEl) {
    currentLabelEl.textContent = statusData.volume_label || '（ラベルなし）';
  }
  if (serialTextEl) {
    serialTextEl.textContent = shortId;
  }
  if (customInputEl) {
    customInputEl.value = statusData.custom_name || currentCustomName || '';
  }
  if (writeCheckEl) {
    writeCheckEl.checked = false;
    writeCheckEl.disabled = !isOnline;
  }
  if (offlineHintEl) {
    offlineHintEl.style.display = isOnline ? 'none' : 'block';
  }
  if (writePanelEl) {
    writePanelEl.style.display = 'none';
  }
  if (physInputEl) {
    physInputEl.value = statusData.volume_label || '';
  }
  if (targetPinEl) {
    targetPinEl.textContent = statusData.approval_pin || '----';
  }
  if (pinInputEl) {
    pinInputEl.value = '';
  }

  const updateValidationState = () => {
    const wantWrite = Boolean(writeCheckEl && writeCheckEl.checked && isOnline);
    if (writePanelEl) {
      writePanelEl.style.display = wantWrite ? 'flex' : 'none';
    }
    if (!wantWrite) {
      if (labelErrorEl) labelErrorEl.style.display = 'none';
      if (submitBtnEl) {
        submitBtnEl.disabled = false;
        submitBtnEl.textContent = '保存する';
      }
      return true;
    }

    const rawPhys = physInputEl ? physInputEl.value : '';
    const vRes = validatePhysicalVolumeLabelInput(rawPhys);
    if (charCountEl) {
      charCountEl.textContent = `${vRes.cleaned.length} / 11`;
      charCountEl.style.color = vRes.cleaned.length > 11 ? '#ef4444' : 'var(--text-dim, #64748b)';
    }
    if (labelErrorEl) {
      if (!vRes.valid) {
        labelErrorEl.textContent = vRes.error;
        labelErrorEl.style.display = 'block';
      } else {
        labelErrorEl.style.display = 'none';
      }
    }

    const pinVal = pinInputEl ? pinInputEl.value.trim() : '';
    const pinMatched = Boolean(statusData.approval_pin && pinVal === statusData.approval_pin);
    if (submitBtnEl) {
      submitBtnEl.disabled = !(vRes.valid && pinMatched);
      submitBtnEl.textContent = pinMatched ? 'ラベル書き込み ＆ 保存' : 'PIN承認待ち...';
    }
    return vRes.valid && pinMatched;
  };

  updateValidationState();
  modal.style.display = 'flex';
  setTimeout(() => {
    if (customInputEl) {
      customInputEl.focus();
      customInputEl.select();
    }
  }, 30);

  return new Promise((resolve) => {
    const cleanup = () => {
      modal.style.display = 'none';
      if (writeCheckEl) writeCheckEl.onchange = null;
      if (physInputEl) physInputEl.oninput = null;
      if (pinInputEl) pinInputEl.oninput = null;
      if (closeBtnEl) closeBtnEl.onclick = null;
      if (cancelBtnEl) cancelBtnEl.onclick = null;
      if (submitBtnEl) submitBtnEl.onclick = null;
      modal.onclick = null;
      window.removeEventListener('keydown', onKeyDown);
    };

    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    const handleSubmit = async () => {
      const wantWrite = Boolean(writeCheckEl && writeCheckEl.checked && isOnline);
      if (wantWrite && !updateValidationState()) {
        showToast('ボリュームラベルの文字種（半角11文字以内・2バイト文字不可）および4桁PIN番号を確認してください', 'warning');
        return;
      }

      const trimmedCustom = customInputEl ? customInputEl.value.trim() : '';
      const physLabelVal = physInputEl ? physInputEl.value.trim() : '';
      const pinVal = pinInputEl ? pinInputEl.value.trim() : '';

      if (submitBtnEl) submitBtnEl.disabled = true;
      try {
        const res = await fetch(`/api/volumes/${encodeURIComponent(volumeSerial)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            custom_name: trimmedCustom,
            write_volume_label: wantWrite,
            new_volume_label: wantWrite ? physLabelVal : null,
            approval_pin: wantWrite ? pinVal : null,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.detail || 'メディア設定の保存に失敗しました');
        }

        const savedName = data.custom_name || '';
        const savedLabel = data.volume_label !== undefined ? data.volume_label : statusData.volume_label;

        (state.photos || []).forEach(p => {
          if (p.volume_serial === volumeSerial) {
            p.volume_custom_name = savedName;
            if (wantWrite) p.volume_label = savedLabel;
          }
          if (Array.isArray(p.duplicates)) {
            p.duplicates.forEach(d => {
              if (d.volume_serial === volumeSerial) {
                d.volume_custom_name = savedName;
                if (wantWrite) d.volume_label = savedLabel;
              }
            });
          }
          if (Array.isArray(p.stack_photos)) {
            p.stack_photos.forEach(sp => {
              if (sp.volume_serial === volumeSerial) {
                sp.volume_custom_name = savedName;
                if (wantWrite) sp.volume_label = savedLabel;
              }
            });
          }
        });

        cleanup();
        if (data.wrote_physical_label) {
          showToast(
            `メディア本体のボリュームラベルを「${savedLabel || '（なし）'}」に書き込み${savedName ? `、識別名「${savedName}」を保存` : ''}しました`,
            'success',
            3500
          );
        } else {
          showToast(
            savedName ? `メディア識別名を「${savedName}」に設定しました（メディア本体は未変更）` : 'メディア識別名を解除しました',
            'success'
          );
        }
        await fetchFolders();
        updateInspectorView();
        resolve(savedName);
      } catch (err) {
        if (submitBtnEl) submitBtnEl.disabled = false;
        showToast(`エラー: ${err.message}`, 'error', 4000);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      } else if (e.key === 'Enter' && document.activeElement !== cancelBtnEl) {
        e.preventDefault();
        handleSubmit();
      }
    };

    if (writeCheckEl) {
      writeCheckEl.onchange = () => {
        updateValidationState();
        if (writeCheckEl.checked && physInputEl) {
          physInputEl.focus();
          physInputEl.select();
        }
      };
    }
    if (physInputEl) physInputEl.oninput = updateValidationState;
    if (pinInputEl) pinInputEl.oninput = updateValidationState;
    if (closeBtnEl) closeBtnEl.onclick = handleCancel;
    if (cancelBtnEl) cancelBtnEl.onclick = handleCancel;
    if (submitBtnEl) submitBtnEl.onclick = handleSubmit;
    modal.onclick = (e) => {
      if (e.target === modal) handleCancel();
    };
    window.addEventListener('keydown', onKeyDown);
  });
}
window.promptRenameVolume = promptRenameVolume;

let _managedMediaControlsBound = false;

function _bindManagedMediaStaticControls() {
  if (_managedMediaControlsBound) return;
  _managedMediaControlsBound = true;

  const openBtn = document.getElementById('openManagedMediaModalBtn');
  if (openBtn) {
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openManagedMediaModal();
    });
  }

  const sidebarHeader = document.getElementById('sidebarMediaHeader');
  const sidebarBody = document.getElementById('sidebarMediaBody');
  const sidebarArrow = document.getElementById('sidebarMediaArrow');
  if (sidebarHeader && sidebarBody) {
    sidebarHeader.addEventListener('click', () => {
      const isHidden = sidebarBody.style.display === 'none';
      sidebarBody.style.display = isHidden ? 'block' : 'none';
      if (sidebarArrow) {
        sidebarArrow.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
      }
    });
  }

  const modal = document.getElementById('managedMediaModal');
  const closeBtn = document.getElementById('closeManagedMediaModalBtn');
  const closeFooterBtn = document.getElementById('closeManagedMediaModalFooterBtn');
  const refreshBtn = document.getElementById('refreshManagedMediaModalBtn');

  if (closeBtn) closeBtn.addEventListener('click', () => closeManagedMediaModal());
  if (closeFooterBtn) closeFooterBtn.addEventListener('click', () => closeManagedMediaModal());
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await fetchFolders();
      showToast('メディア接続状態・一覧を更新しました', 'info', 1800);
    });
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeManagedMediaModal();
    });
  }
}

/**
 * サイドバー「登録メディア」一覧の選択状態（active / active-exclude）を同期
 */
function syncSidebarMediaActiveStates() {
  const listEl = document.getElementById('sidebarMediaList');
  if (!listEl) return;
  const cf = state.currentFilter || {};
  const isMediaOnlyFilter = (cf.type === 'folder' || cf.type === 'folder_exclude') && !cf.value && Boolean(cf.volumeSerial);
  const activeVsn = isMediaOnlyFilter ? String(cf.volumeSerial).toUpperCase() : '';
  const isExclude = cf.type === 'folder_exclude';

  listEl.querySelectorAll('.sidebar-media-item').forEach(row => {
    const vsn = String(row.dataset.volumeSerial || '').toUpperCase();
    row.classList.remove('active', 'active-exclude');
    if (activeVsn && vsn === activeVsn) {
      row.classList.add(isExclude ? 'active-exclude' : 'active');
      row.style.background = isExclude ? 'rgba(239,68,68,0.16)' : 'rgba(59,130,246,0.18)';
      row.style.borderColor = isExclude ? 'rgba(239,68,68,0.45)' : 'rgba(59,130,246,0.45)';
    } else {
      row.style.background = 'rgba(255,255,255,0.03)';
      row.style.borderColor = 'transparent';
    }
  });
}
window.syncSidebarMediaActiveStates = syncSidebarMediaActiveStates;

/**
 * 管理対象メディア（SDカード・ドライブ）一覧を取得し、サイドバーおよびモーダルを更新
 */
async function fetchManagedVolumes() {
  _bindManagedMediaStaticControls();
  try {
    const res = await fetch('/api/volumes');
    if (!res.ok) return;
    const data = await res.json();
    state.managedVolumes = Array.isArray(data.volumes) ? data.volumes : [];
    renderSidebarMediaList();
    const modal = document.getElementById('managedMediaModal');
    if (modal && modal.style.display !== 'none') {
      renderManagedMediaModalList();
    }
  } catch (err) {
    console.warn('[WARN] fetchManagedVolumes エラー:', err);
  }
}
window.fetchManagedVolumes = fetchManagedVolumes;

/**
 * サイドバー上部の「登録メディア」コンパクトリストを描画
 */
function renderSidebarMediaList() {
  const sectionEl = document.getElementById('sidebarMediaSection');
  const listEl = document.getElementById('sidebarMediaList');
  const badgeEl = document.getElementById('sidebarMediaCountBadge');
  if (!sectionEl || !listEl) return;

  const volumes = Array.isArray(state.managedVolumes) ? state.managedVolumes : [];
  if (volumes.length === 0) {
    sectionEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  sectionEl.style.display = 'block';
  const onlineCount = volumes.filter(v => v.is_online).length;
  if (badgeEl) {
    badgeEl.textContent = `${onlineCount}/${volumes.length} 接続中`;
  }

  listEl.innerHTML = '';
  volumes.forEach(v => {
    const vsn = v.volume_serial;
    const shortId = v.short_serial || vsn;
    const primaryName = v.custom_name || v.volume_label || `メディア [${shortId}]`;
    const subTag = v.is_online && v.drive_letter
      ? `${v.drive_letter}`
      : `ID:${shortId}`;
    const filterTitle = `${primaryName} (${subTag})`;

    const dateRangeStr = v.min_date
      ? (v.min_date === v.max_date ? v.min_date : `${v.min_date} 〜 ${v.max_date}`)
      : '日付記録なし';
    const camStr = (v.cameras && v.cameras.length > 0) ? v.cameras.join(', ') : 'カメラ記録なし';

    const row = document.createElement('div');
    row.className = 'sidebar-media-item';
    row.dataset.volumeSerial = vsn;
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:6px; padding:4px 6px; border-radius:5px; border:1px solid transparent; cursor:pointer; font-size:11.5px; background:rgba(255,255,255,0.03); transition:background 0.15s;';
    row.title = [
      `メディア: ${primaryName}`,
      v.custom_name && v.volume_label ? `ボリュームラベル: ${v.volume_label}` : null,
      `シリアルID: ${shortId}${v.drive_letter ? ` (${v.is_online ? '現在' : '最終'}: ${v.drive_letter})` : ''}`,
      `登録写真: ${v.photo_count} 枚 (優:${v.excellent_count || 0} / 良:${v.good_count || 0})`,
      `撮影期間: ${dateRangeStr}`,
      `使用機材: ${camStr}`,
      '左クリック: このメディアの写真のみ表示（再クリックで解除）',
      '右クリック: このメディアの写真を除外 [-]',
    ].filter(Boolean).join('\n');

    const left = document.createElement('div');
    left.style.cssText = 'display:flex; align-items:center; gap:5px; min-width:0; flex:1; overflow:hidden;';

    const dot = document.createElement('span');
    dot.textContent = v.is_online ? '●' : '○';
    dot.style.cssText = `font-size:10px; flex-shrink:0; color:${v.is_online ? '#22c55e' : 'var(--warning, #e67e22)'};`;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = primaryName;
    nameSpan.style.cssText = 'font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

    const tagSpan = document.createElement('span');
    tagSpan.textContent = subTag;
    tagSpan.style.cssText = 'font-size:10px; color:var(--text-muted); font-family:monospace; flex-shrink:0;';

    left.appendChild(dot);
    left.appendChild(nameSpan);
    left.appendChild(tagSpan);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex; align-items:center; gap:4px; flex-shrink:0;';

    const countSpan = document.createElement('span');
    countSpan.textContent = `${v.photo_count}`;
    countSpan.style.cssText = 'font-size:10.5px; color:var(--text-secondary); padding:0 4px; border-radius:8px; background:rgba(255,255,255,0.06);';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '✎';
    editBtn.title = 'メディア識別名・ボリュームラベルを設定';
    editBtn.style.cssText = 'background:transparent; border:none; color:var(--text-muted); cursor:pointer; font-size:11px; padding:1px 3px; border-radius:3px; line-height:1;';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      promptRenameVolume(vsn, v.custom_name || '', v.volume_label || '', v.drive_letter || '');
    });

    right.appendChild(countSpan);
    right.appendChild(editBtn);

    row.appendChild(left);
    row.appendChild(right);

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const cf = state.currentFilter || {};
      if (cf.type === 'folder' && !cf.value && String(cf.volumeSerial || '').toUpperCase() === vsn) {
        state.currentFilter = { type: 'all', value: null };
        if (elements.viewTitle) elements.viewTitle.textContent = 'すべての写真';
        syncSidebarMediaActiveStates();
        if (typeof window.syncFolderTreeFilterStates === 'function') window.syncFolderTreeFilterStates();
        fetchPhotos();
      } else {
        setFilter('folder', '', filterTitle, {
          volumeSerial: vsn,
          serialMode: 'match',
          isOffline: !v.is_online,
        });
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cf = state.currentFilter || {};
      if (cf.type === 'folder_exclude' && !cf.value && String(cf.volumeSerial || '').toUpperCase() === vsn) {
        state.currentFilter = { type: 'all', value: null };
        if (elements.viewTitle) elements.viewTitle.textContent = 'すべての写真';
        syncSidebarMediaActiveStates();
        if (typeof window.syncFolderTreeFilterStates === 'function') window.syncFolderTreeFilterStates();
        fetchPhotos();
      } else {
        setFilter('folder_exclude', '', `除外: ${filterTitle}`, {
          volumeSerial: vsn,
          serialMode: 'match',
          isOffline: !v.is_online,
        });
      }
    });

    listEl.appendChild(row);
  });

  syncSidebarMediaActiveStates();
}

/**
 * 登録メディア（SDカード・ドライブ）管理一覧モーダルを開く
 */
async function openManagedMediaModal() {
  _bindManagedMediaStaticControls();
  const modal = document.getElementById('managedMediaModal');
  if (!modal) return;
  modal.style.display = 'flex';
  await fetchManagedVolumes();
  renderManagedMediaModalList();
}
window.openManagedMediaModal = openManagedMediaModal;

/**
 * 登録メディア管理一覧モーダルを閉じる
 */
function closeManagedMediaModal() {
  const modal = document.getElementById('managedMediaModal');
  if (modal) modal.style.display = 'none';
}
window.closeManagedMediaModal = closeManagedMediaModal;

/**
 * 登録メディア管理一覧モーダル内のカードリストを描画
 */
function renderManagedMediaModalList() {
  const container = document.getElementById('managedMediaListContainer');
  if (!container) return;

  const volumes = Array.isArray(state.managedVolumes) ? state.managedVolumes : [];
  if (volumes.length === 0) {
    container.innerHTML = `
      <div style="padding:28px 16px; text-align:center; color:var(--text-muted); font-size:13px;">
        現在登録されているメディア（SDカード・ドライブ）はありません。<br>
        フォルダ追加やスキャンを実行すると自動的にメディアが識別・登録されます。
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  volumes.forEach(v => {
    const vsn = v.volume_serial;
    const shortId = v.short_serial || vsn;
    const primaryName = v.custom_name || v.volume_label || '名称未設定メディア';
    const subLabel = (v.custom_name && v.volume_label) ? `（物理ラベル: ${v.volume_label}）` : (!v.custom_name && !v.volume_label ? '（ラベル未設定）' : '');
    const statusText = v.is_online
      ? `● 接続中 (${v.drive_letter || '?'}${v.filesystem ? ' / ' + v.filesystem : ''})`
      : `○ 未接続${v.drive_letter ? ' (最終認識: ' + v.drive_letter + ')' : ''}`;
    const statusColor = v.is_online ? '#22c55e' : 'var(--warning, #e67e22)';

    const dateRangeStr = v.min_date
      ? (v.min_date === v.max_date ? v.min_date : `${v.min_date} 〜 ${v.max_date}`)
      : '撮影日記録なし';
    const camStr = (v.cameras && v.cameras.length > 0) ? v.cameras.join(' / ') : 'カメラ情報なし';
    const ratingStr = (v.excellent_count || v.good_count)
      ? `（優: ${v.excellent_count || 0} / 良: ${v.good_count || 0}）`
      : '';

    const card = document.createElement('div');
    card.className = 'managed-media-card';
    card.dataset.volumeSerial = vsn;
    card.style.cssText = 'padding:12px 14px; border-radius:8px; background:rgba(255,255,255,0.035); border:1px solid var(--border-color, #333); display:flex; flex-direction:column; gap:8px;';

    // 上段: ステータス・メディア名・シリアルID
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;';
    const loomeBadgeHtml = v.loome_enabled
      ? `<span style="font-size:11px; font-weight:600; color:var(--accent-primary, #c89d66); background:rgba(200,157,102,0.14); border:1px solid rgba(200,157,102,0.35); padding:1px 6px; border-radius:4px;" title="${escapeHtml(v.loome_path || 'Loome 有効')}">📦 Loome 有効</span>`
      : '';
    topRow.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="font-size:12px; font-weight:700; color:${statusColor};">${escapeHtml(statusText)}</span>
        <span style="font-size:14px; font-weight:700; color:var(--text-primary);">${escapeHtml(primaryName)}</span>
        ${subLabel ? `<span style="font-size:11.5px; color:var(--text-secondary);">${escapeHtml(subLabel)}</span>` : ''}
        ${loomeBadgeHtml}
      </div>
      <span style="font-size:11px; font-family:monospace; color:var(--text-muted); background:rgba(255,255,255,0.05); padding:2px 7px; border-radius:4px;">ID: ${escapeHtml(shortId)}</span>
    `;

    // 中段: 写真枚数・期間・カメラ機種（どのSDカードか見分ける手がかり）
    const metaRow = document.createElement('div');
    metaRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:var(--text-secondary); padding:6px 10px; border-radius:6px; background:rgba(0,0,0,0.2);';
    metaRow.innerHTML = `
      <span>📷 登録写真: <strong style="color:var(--text-primary);">${v.photo_count} 枚</strong> ${escapeHtml(ratingStr)}</span>
      <span>📅 撮影期間: <strong style="color:var(--text-primary);">${escapeHtml(dateRangeStr)}</strong></span>
      <span>🔭 使用機材: <strong style="color:var(--text-primary);">${escapeHtml(camStr)}</strong></span>
    `;

    // 下段: 操作ボタン群
    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-top:2px;';

    const leftBtns = document.createElement('div');
    leftBtns.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap;';

    const filterTitle = `${primaryName} (${v.is_online && v.drive_letter ? v.drive_letter : 'ID:' + shortId})`;

    const showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.className = 'btn btn-primary';
    showBtn.style.cssText = 'font-size:11.5px; padding:4px 10px;';
    showBtn.textContent = `このメディアの写真を表示 (${v.photo_count})`;
    showBtn.disabled = v.photo_count === 0;
    showBtn.addEventListener('click', () => {
      closeManagedMediaModal();
      setFilter('folder', '', filterTitle, {
        volumeSerial: vsn,
        serialMode: 'match',
        isOffline: !v.is_online,
      });
    });

    const excludeBtn = document.createElement('button');
    excludeBtn.type = 'button';
    excludeBtn.className = 'btn btn-secondary';
    excludeBtn.style.cssText = 'font-size:11.5px; padding:4px 10px;';
    excludeBtn.textContent = '除外 [-]';
    excludeBtn.disabled = v.photo_count === 0;
    excludeBtn.addEventListener('click', () => {
      closeManagedMediaModal();
      setFilter('folder_exclude', '', `除外: ${filterTitle}`, {
        volumeSerial: vsn,
        serialMode: 'match',
        isOffline: !v.is_online,
      });
    });

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn btn-secondary';
    renameBtn.style.cssText = 'font-size:11.5px; padding:4px 10px;';
    renameBtn.textContent = '✎ 識別名・ラベル設定';
    renameBtn.addEventListener('click', async () => {
      await promptRenameVolume(vsn, v.custom_name || '', v.volume_label || '', v.drive_letter || '');
      await fetchManagedVolumes();
    });

    leftBtns.appendChild(showBtn);
    leftBtns.appendChild(excludeBtn);
    leftBtns.appendChild(renameBtn);

    if (v.loome_enabled) {
      const removeLoomeBtn = document.createElement('button');
      removeLoomeBtn.type = 'button';
      removeLoomeBtn.className = 'btn btn-secondary';
      removeLoomeBtn.style.cssText = 'font-size:11.5px; padding:4px 10px;';
      removeLoomeBtn.textContent = '📦 Loome 解除';
      removeLoomeBtn.title = 'このドライブの Loome ショートカット登録を解除します（実ファイルは残ります）';
      removeLoomeBtn.addEventListener('click', async () => {
        if (typeof window.removeLoomeFromVolume === 'function') {
          await window.removeLoomeFromVolume(vsn, primaryName);
          await fetchManagedVolumes();
        }
      });
      leftBtns.appendChild(removeLoomeBtn);
    } else if (v.is_online && v.drive_letter) {
      const createLoomeBtn = document.createElement('button');
      createLoomeBtn.type = 'button';
      createLoomeBtn.className = 'btn btn-secondary';
      createLoomeBtn.style.cssText = 'font-size:11.5px; padding:4px 10px;';
      createLoomeBtn.textContent = '📦 Loome を作成';
      createLoomeBtn.title = `${v.drive_letter}\\Loome を作成し、左ペインの Loome として登録します`;
      createLoomeBtn.addEventListener('click', async () => {
        if (typeof window.createLoomeOnVolume === 'function') {
          await window.createLoomeOnVolume(vsn, v.drive_letter, primaryName);
          await fetchManagedVolumes();
        }
      });
      leftBtns.appendChild(createLoomeBtn);
    }

    const unmanageBtn = document.createElement('button');
    unmanageBtn.type = 'button';
    unmanageBtn.className = 'btn btn-secondary';
    unmanageBtn.style.cssText = 'font-size:11.5px; padding:4px 10px; color:#ef4444; border-color:rgba(239,68,68,0.35);';
    unmanageBtn.textContent = '一覧から登録解除';
    unmanageBtn.addEventListener('click', async () => {
      const ok = typeof showConfirmModal === 'function'
        ? await showConfirmModal({
            title: '登録メディアの管理解除',
            subtitle: 'SDカード・外部メディアの登録解除',
            icon: 'folder',
            headingPrefix: 'メディア',
            targetName: `${primaryName} [ID:${shortId}]`,
            headingSuffix: `（写真 ${(v.photo_count || 0).toLocaleString()} 枚）を管理対象から解除しますか？`,
            descriptionLines: [
              'ライブラリ上の登録インデックスが解除されます。',
              '※ SDカードやドライブ内の実際の写真ファイルは一切削除されません。',
            ],
            confirmText: '登録を解除する',
            confirmVariant: 'danger',
          })
        : window.confirm(
            `メディア「${primaryName} [ID:${shortId}]」の登録（写真インデックス ${v.photo_count} 枚分）を Tetheract Photo Manager の管理対象から解除しますか？\n\n※SDカードやドライブ内の実際の写真ファイルは一切削除されません。`
          );
      if (!ok) return;
      try {
        unmanageBtn.disabled = true;
        const delRes = await fetch(`/api/volumes/${encodeURIComponent(vsn)}`, { method: 'DELETE' });
        const delData = await delRes.json().catch(() => ({}));
        if (!delRes.ok) {
          throw new Error(delData.detail || 'メディア登録解除に失敗しました');
        }
        showToast(`メディア「${primaryName}」の管理登録を解除しました（${delData.removed_count || 0}枚）`, 'info');
        if (state.currentFilter && String(state.currentFilter.volumeSerial || '').toUpperCase() === vsn) {
          state.currentFilter = { type: 'all', value: null };
          if (elements.viewTitle) elements.viewTitle.textContent = 'すべての写真';
        }
        await refreshAll();
        await fetchManagedVolumes();
      } catch (err) {
        unmanageBtn.disabled = false;
        showToast(`エラー: ${err.message}`, 'error');
      }
    });

    actionRow.appendChild(leftBtns);
    actionRow.appendChild(unmanageBtn);

    card.appendChild(topRow);
    card.appendChild(metaRow);
    card.appendChild(actionRow);
    container.appendChild(card);
  });
}

let _diffChecking = false;
const _dismissedFolderDiffSignatures = new Map();
window._dismissedFolderDiffSignatures = _dismissedFolderDiffSignatures;

/**
 * フォルダ選択時にバックグラウンドで差分または管理状態を高速判定し、
 * 未登録フォルダなら登録確認、管理下フォルダでファイル・子フォルダの増減があれば段階的リフレッシュを提案する
 */
async function checkAndPromptFolderRefresh(folderPath, folderName, node) {
  if (!folderPath || _diffChecking) return;
  _diffChecking = true;
  try {
    const res = await fetch('/api/folders/check-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath, volume_serial: (node && node.volumeSerial) || null }),
    });
    if (!res.ok) return;
    const diff = await res.json();
    if (!diff.is_valid) return;

    const name = folderName || folderPath;

    // 【ケース1: 管理外フォルダをクリックした場合 (v2.02: 子フォルダ含む/直下のみ/キャンセル 3段階選択)】
    if (!diff.is_managed) {
      // ドライブ全体（C:\ など）やショートカット、Loome（内部ストレージ）、除外設定フォルダなら登録確認はスキップ
      if (node && (node.kind === 'drive' || node.kind === 'shortcut' || node.isStorage || node.status === 'managed' || node.status === 'ignored')) return;
      if (/^[a-zA-Z]:\\?$/.test(folderPath)) return;

      const choice = typeof showRegisterFolderModal === 'function'
        ? await showRegisterFolderModal(folderPath, name, diff.total_disk || 0)
        : (confirm(`管理外のフォルダです。管理フォルダとして登録しますか？`) ? 'direct' : null);

      if (!choice) {
        if (node && node._prevFilter && state.currentFilter && state.currentFilter.value === folderPath) {
          const pf = node._prevFilter;
          setFilter(pf.type || 'all', pf.value || null, pf.titleText || 'すべての写真', {
            volumeSerial: pf.volumeSerial || null,
            serialMode: pf.serialMode || null,
            isOffline: Boolean(pf.isOffline),
          });
        }
        return;
      }

      const isRecursive = choice === 'recursive';
      const rangeText = isRecursive ? '（子フォルダ含む）' : '（直下のみ）';
      showToast(`「${name}」を管理フォルダとして登録・スキャン中${rangeText}...`, 'info');
      await executeScan(folderPath, isRecursive, false);
      return;
    }

    // 【ケース2: 管理下フォルダをクリックした場合（ファイルや子フォルダの増減・変更がある場合のみ更新提案）】
    if (!diff.has_changes) return;

    const normKey = String(folderPath).toLowerCase();
    const diffSignature = JSON.stringify({
      af: diff.added_folders || [],
      df: diff.deleted_folders || [],
      a: diff.added || 0,
      d: diff.deleted || 0,
      m: diff.modified || 0,
    });
    if (_dismissedFolderDiffSignatures.get(normKey) === diffSignature) {
      return;
    }

    // 第1モーダル: リフレッシュ提案（子フォルダおよびファイルの増減内訳を表示）
    const detailRows = [];
    if (diff.added_folders_count > 0) {
      const names = (diff.added_folders || []).slice(0, 3).join(', ');
      const suffix = diff.added_folders_count > 3 ? ' 他' : '';
      detailRows.push({
        label: '新規フォルダ:',
        value: `${diff.added_folders_count} 件`,
        subText: names ? `[${names}${suffix}]` : '',
        color: '#22c55e',
      });
    }
    if (diff.deleted_folders_count > 0) {
      const names = (diff.deleted_folders || []).slice(0, 3).join(', ');
      const suffix = diff.deleted_folders_count > 3 ? ' 他' : '';
      detailRows.push({
        label: '消失フォルダ:',
        value: `${diff.deleted_folders_count} 件`,
        subText: names ? `[${names}${suffix}]` : '',
        color: '#f59e0b',
      });
    }
    if (diff.added > 0) {
      detailRows.push({
        label: '新規追加:',
        value: `${diff.added.toLocaleString()} 枚`,
        color: '#22c55e',
      });
    }
    if (diff.deleted > 0) {
      detailRows.push({
        label: '削除・消失:',
        value: `${diff.deleted.toLocaleString()} 枚`,
        color: '#f59e0b',
      });
    }
    if (diff.modified > 0) {
      detailRows.push({
        label: '変更・更新:',
        value: `${diff.modified.toLocaleString()} 枚`,
        color: '#3b82f6',
      });
    }

    const descriptionLines = [
      '変更内容をスキャンして、ライブラリをリフレッシュ（最新化）しますか？',
    ];
    if (diff.deleted > 0 || diff.folder_deleted) {
      descriptionLines.push('※ 削除・消失した写真のリンクは解除され、他メディアにリンクが無い写真は「リンク消失の写真」へ移行します（サムネイル・タグ・評価は保持）。');
    }

    const shouldRefresh = typeof showConfirmModal === 'function'
      ? await showConfirmModal({
          title: 'フォルダの更新（差分検出）',
          subtitle: 'フォルダ内の変更をライブラリへ反映',
          icon: 'folder-refresh',
          targetName: name,
          headingSuffix: diff.folder_deleted ? 'のフォルダまたは写真が見つかりません' : 'の内容が更新されています',
          subPath: folderPath,
          detailRows,
          descriptionLines,
          cancelText: 'あとで (Esc)',
          confirmText: 'リフレッシュ（最新化）',
          confirmVariant: 'primary',
        })
      : confirm(`フォルダ「${name}」の内容が更新された可能性があります。\n\nライブラリをリフレッシュ（最新化）しますか？`);

    if (!shouldRefresh) {
      _dismissedFolderDiffSignatures.set(normKey, diffSignature);
      return;
    }
    _dismissedFolderDiffSignatures.delete(normKey);

    const useRecursive = Boolean(diff.has_subfolder_changes || diff.folder_deleted || /^[a-zA-Z]:\\?$/.test(folderPath));
    showToast(`「${name}」をリフレッシュ中...`, 'info');
    // 差分スキャン＋消失写真リンクの自動整理を一括実行
    await executeScan(folderPath, useRecursive, true, (node && node.volumeSerial) || null);
  } catch (err) {
    console.warn('[WARN] checkAndPromptFolderRefresh エラー:', err);
  } finally {
    _diffChecking = false;
  }
}
window.checkAndPromptFolderRefresh = checkAndPromptFolderRefresh;
