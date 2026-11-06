/**
 * ローカルタイム基準の今日の日付文字列 (YYYY-MM-DD) を返す
 */
function _getLocalTodayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * バックアップ保存先フォルダ (cache/backups) をエクスプローラーで開く
 */
async function openBackupFolderInExplorer() {
  try {
    const res = await fetch('/api/database/open-backup-dir', { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || 'バックアップフォルダを開けませんでした');
    }
    showToast('バックアップ保存先フォルダ (cache/backups) を開きました', 'info', 3000);
  } catch (err) {
    showToast(`エラー: ${err.message}`, 'error');
  }
}
window.openBackupFolderInExplorer = openBackupFolderInExplorer;

/**
 * 起動時に前回のバックアップから1週間（7日）以上経過している場合、
 * 確認モーダルでバックアップ作成と外部保管（別ドライブへのコピー）を案内する
 */
async function checkWeeklyBackupReminderOnStartup() {
  try {
    const todayStr = _getLocalTodayDateString();
    if (localStorage.getItem('pm_backup_reminder_dismissed_date') === todayStr) {
      return;
    }

    const res = await fetch('/api/database/stats');
    if (!res.ok) return;
    const data = await res.json();
    const stats = data.stats || data;
    const bi = stats && stats.backup_info;
    if (!bi || !bi.is_overdue) return;

    // 他のモーダル（スマホ同期完了モーダル等）が表示中の場合は閉じてから表示する
    for (let waitIdx = 0; waitIdx < 60; waitIdx++) {
      const anyModalOpen = Array.from(document.querySelectorAll('.modal-overlay')).some((el) => {
        const disp = el.style && el.style.display;
        return disp && disp !== 'none';
      });
      if (!anyModalOpen) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const photoCount = Number(stats.photo_count || 0);
    const dbSizeFmt = stats.file_size_formatted || '';
    const backupDirPath = bi.backup_dir_path || 'cache\\backups';
    const hasLatest = Boolean(bi.latest);
    const daysElapsed = hasLatest ? Number(bi.days_since_last_backup || 7) : Number(bi.library_age_days || 7);

    const confirmed = await showConfirmModal({
      title: 'データベースの定期バックアップのお勧め',
      subtitle: '1週間以上バックアップが作成されていません — 大切な評価・タグ・アルバム情報の保護',
      icon: 'database',
      headingText: hasLatest
        ? `前回のバックアップから ${daysElapsed} 日が経過しています`
        : 'まだデータベースの定期バックアップが作成されていません',
      subPath: `保存先フォルダ: ${backupDirPath}`,
      detailRows: [
        {
          label: '現在の登録データ:',
          value: `${photoCount.toLocaleString()} 枚 (${dbSizeFmt})`,
          color: '#3b82f6',
        },
        {
          label: '最終バックアップ:',
          value: hasLatest ? `${bi.latest.created_at} (${daysElapsed}日前)` : '未作成',
          subText: hasLatest ? bi.latest.filename : '',
          color: '#f59e0b',
        },
        {
          label: '別ドライブへ保管推奨:',
          value: 'library_backup_*.db ＆ recovery_key.txt',
          subText: '（または cache\\library.db）',
          color: '#22c55e',
          actionText: '📂 保存先フォルダを開く',
          onAction: () => openBackupFolderInExplorer(),
        },
      ],
      descriptionLines: [
        '万が一のドライブ故障や誤操作に備え、「今すぐバックアップを作成」で最新のバックアップを保存することをお勧めします。',
        '💡 ポータブルSSDやUSBメモリ自体の故障・紛失に備え、作成後に「📂 保存先フォルダを開く」から cache/backups/ 内の最新ファイル（library_backup_*.db と recovery_key.txt）をPC本体や別ドライブ・クラウド等へコピーして保管しておくと万全です。',
      ],
      cancelText: 'あとで (Esc)',
      confirmText: '今すぐバックアップを作成 (Enter)',
    });

    // 当日中は再表示しないよう記録
    localStorage.setItem('pm_backup_reminder_dismissed_date', todayStr);

    if (!confirmed) return;

    if (typeof setGlobalActivity === 'function') {
      setGlobalActivity('maint', {
        title: 'データベースをバックアップ中...',
        indeterminate: true,
      });
    }
    let backupResData = null;
    try {
      const bRes = await fetch('/api/database/backup', { method: 'POST' });
      backupResData = await bRes.json();
      if (!bRes.ok) {
        throw new Error(backupResData.detail || 'バックアップの作成に失敗しました');
      }
      showToast(`バックアップを作成しました (${backupResData.filename || ''})`, 'success', 4500);
    } finally {
      if (typeof clearGlobalActivity === 'function') {
        clearGlobalActivity('maint');
      }
    }

    if (backupResData && backupResData.filename) {
      const openNow = await showConfirmModal({
        title: 'バックアップ作成完了 — 別ドライブへの退避案内',
        subtitle: '作成されたバックアップファイルを別のドライブやPC本体へコピーしておくと安心です',
        icon: 'database',
        headingPrefix: '最新のバックアップ ',
        targetName: backupResData.filename,
        headingSuffix: ' を保存しました',
        subPath: `${backupDirPath}\\${backupResData.filename}`,
        detailRows: [
          {
            label: 'バックアップDB:',
            value: `${backupResData.filename} (${backupResData.size_formatted || ''})`,
            color: '#22c55e',
          },
          {
            label: '復旧キーファイル:',
            value: 'recovery_key.txt',
            subText: '（同じ cache/backups/ フォルダ内に自動保存済み）',
            color: '#3b82f6',
          },
        ],
        descriptionLines: [
          '現在のドライブ（USBメモリやSSD）自体が故障した場合でもデータを100%復元できるよう、上記2つのファイルをPC本体や別ドライブへコピーして保管しておくことをお勧めします。',
          '今すぐ保存先フォルダ（エクスプローラー）を開きますか？',
        ],
        cancelText: '閉じる (Esc)',
        confirmText: '📂 保存先フォルダを開く (Enter)',
      });
      if (openNow) {
        await openBackupFolderInExplorer();
      }
    }
  } catch (err) {
    console.warn('定期バックアップ確認エラー:', err);
  }
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
    if (data.total_count !== undefined && elements.totalPhotosCount) {
      elements.totalPhotosCount.textContent = data.total_count;
    }
    if (data.online_count !== undefined && elements.onlinePhotosCount) {
      elements.onlinePhotosCount.textContent = data.online_count;
    }
    if (data.offline_count !== undefined && elements.offlinePhotosCount) {
      elements.offlinePhotosCount.textContent = data.offline_count;
    }

    // クイックアクセスのバッジ更新（0件でもメニュー自体は常時表示してアクセス可能にする）
    if (elements.unlinkedOnlyNavItem) {
      elements.unlinkedOnlyNavItem.style.display = 'flex';
    }
    if (elements.unlinkedPhotosCount) {
      elements.unlinkedPhotosCount.textContent = count;
      elements.unlinkedPhotosCount.style.display = 'inline-block';
      elements.unlinkedPhotosCount.classList.toggle('badge-warning', count > 0);
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
 * 現在ギャラリーに表示されている写真群から「リンク消失（is_unlinked）」の全photo_idを重複なく取得する（スタック内も含む）
 */
function getDisplayedUnlinkedPhotoIds() {
  if (!Array.isArray(state.photos) || state.photos.length === 0) return [];
  const idSet = new Set();
  const isUnlinkedFn = typeof isPhotoUnlinkedRecord === 'function'
    ? isPhotoUnlinkedRecord
    : (p) => Boolean(p && (p.is_unlinked || p.is_missing || !p.file_path));
  for (const p of state.photos) {
    if (!p) continue;
    if (isUnlinkedFn(p) && p.id) idSet.add(Number(p.id));
    if (Array.isArray(p.stack_photos)) {
      for (const sp of p.stack_photos) {
        if (sp && isUnlinkedFn(sp) && sp.id) idSet.add(Number(sp.id));
      }
    }
  }
  return Array.from(idSet).filter(Boolean);
}
window.getDisplayedUnlinkedPhotoIds = getDisplayedUnlinkedPhotoIds;

/**
 * 「リンク情報なし（リンク消失の写真）」絞り込み時の完全消去ボタン（#purgeUnlinkedBtn）の表示・ラベルを選択枚数や他フィルタと同期する
 */
function syncPurgeUnlinkedButtonUI() {
  const btn = elements.purgeUnlinkedBtn || document.getElementById('purgeUnlinkedBtn');
  if (!btn) return;
  const isUnlinkedView = typeof isStrictlyUnlinkedOnlyView === 'function'
    ? isStrictlyUnlinkedOnlyView()
    : (state.connectionFilter === 'unlinked');
  if (!isUnlinkedView || !Array.isArray(state.photos) || state.photos.length === 0) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = 'inline-flex';
  const selCount = state.selectedPhotoIds ? state.selectedPhotoIds.size : 0;
  if (selCount > 0) {
    btn.textContent = `選択したリンク消失写真を完全消去 (${selCount}枚)`;
  } else {
    const dispIds = getDisplayedUnlinkedPhotoIds();
    const totalUnlinked = Number(
      elements.unlinkedPhotosCount?.textContent
      || elements.folderTreeUnlinkedCount?.textContent
      || dispIds.length
    );
    if (totalUnlinked > 0 && dispIds.length < totalUnlinked) {
      btn.textContent = `表示中のリンク消失写真を完全消去 (${dispIds.length}枚)`;
    } else if (dispIds.length > 0) {
      btn.textContent = `リンク消失写真をすべて完全消去 (${dispIds.length}枚)`;
    } else {
      btn.textContent = 'リンク消失写真をすべて完全消去';
    }
  }
}
window.syncPurgeUnlinkedButtonUI = syncPurgeUnlinkedButtonUI;

/**
 * 「リンク情報なし（リンク消失の写真）」絞り込み時に、選択した写真（または未選択時は現在表示中の対象写真）をDBから完全消去する
 */
async function purgeUnlinkedPhotosAction(explicitPhotoIds = null) {
  const isUnlinkedView = typeof isStrictlyUnlinkedOnlyView === 'function'
    ? isStrictlyUnlinkedOnlyView()
    : (state.connectionFilter === 'unlinked');
  if (!isUnlinkedView) {
    showToast('データの完全消去は「リンク情報なし（リンク消失の写真）」の絞り込み表示中のみ実行できます', 'warning');
    return;
  }

  let targetIds = null;
  let isSelectedMode = false;
  if (Array.isArray(explicitPhotoIds) && explicitPhotoIds.length > 0) {
    targetIds = explicitPhotoIds.map(Number).filter(Boolean);
    isSelectedMode = true;
  } else if (state.selectedPhotoIds && state.selectedPhotoIds.size > 0) {
    targetIds = Array.from(state.selectedPhotoIds).map(Number).filter(Boolean);
    isSelectedMode = true;
  }

  const dispIds = getDisplayedUnlinkedPhotoIds();
  const totalUnlinked = Number(
    elements.unlinkedPhotosCount?.textContent
    || elements.folderTreeUnlinkedCount?.textContent
    || dispIds.length
  );
  const isFilteredSubset = !isSelectedMode && dispIds.length > 0 && totalUnlinked > dispIds.length;
  if (isFilteredSubset) {
    targetIds = dispIds;
  }

  const isPartial = Array.isArray(targetIds) && targetIds.length > 0;
  let headingText = 'リンク消失しているすべての写真レコードをDBから完全に消去しますか？';
  let modalTitle = 'リンク消失写真の完全消去';
  let modalSubtitle = 'データベースからのレコード一括消去';
  let confirmBtnText = 'すべて完全に消去する';

  if (isSelectedMode && isPartial) {
    headingText = `選択した ${targetIds.length} 枚のリンク消失写真レコードをDBから完全に消去しますか？`;
    modalTitle = '選択したリンク消失写真の完全消去';
    modalSubtitle = `選択中の ${targetIds.length} 枚をデータベースから消去`;
    confirmBtnText = `選択した ${targetIds.length} 枚を消去する`;
  } else if (isFilteredSubset && isPartial) {
    headingText = `現在絞り込み表示されている ${targetIds.length} 枚のリンク消失写真レコードをDBから完全に消去しますか？`;
    modalTitle = '表示中のリンク消失写真の完全消去';
    modalSubtitle = `絞り込み表示中の ${targetIds.length} 枚をデータベースから消去（非表示の ${totalUnlinked - targetIds.length} 枚は保持）`;
    confirmBtnText = `表示中の ${targetIds.length} 枚を消去する`;
  }

  const confirmed = typeof showConfirmModal === 'function'
    ? await showConfirmModal({
        title: modalTitle,
        subtitle: modalSubtitle,
        icon: 'trash',
        headingText,
        descriptionLines: [
          'サムネイル・タグ・評価を含むすべての登録情報がデータベースから削除されます。',
          '※ この操作は取り消せません。',
        ],
        confirmText: confirmBtnText,
        confirmVariant: 'danger',
      })
    : confirm(`${headingText}\nこの操作は取り消せません。`);
  if (!confirmed) return;

  try {
    const payload = isPartial ? { photo_ids: targetIds } : {};
    const res = await fetch('/api/photos/purge-unlinked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '消去に失敗しました');
    showToast(`${data.purged}枚の写真レコードを完全に消去しました`, 'success');
    if (state.selectedPhotoIds) state.selectedPhotoIds.clear();
    state.lastSelectedIndex = -1;
    state.activeInspectorPhotoId = null;
    const purgedCount = Number(data.purged || 0);
    if (!isPartial || (totalUnlinked > 0 && totalUnlinked <= purgedCount)) {
      setConnectionFilter('all');
    }
    await refreshAll();
  } catch (err) {
    showToast('消去エラー: ' + err.message, 'error');
  }
}
window.purgeUnlinkedPhotosAction = purgeUnlinkedPhotosAction;

/**
 * 重複写真（同一撮影日時＋サイズで他フォルダコピーあり）件数の取得とクイックアクセス表示更新
 */
async function fetchDuplicatesCount() {
  try {
    const res = await fetch('/api/photos/duplicates-count');
    if (!res.ok) return;
    const data = await res.json();
    const count = data.count || 0;
    if (data.total_count !== undefined && elements.totalPhotosCount) {
      elements.totalPhotosCount.textContent = data.total_count;
    }
    if (data.online_count !== undefined && elements.onlinePhotosCount) {
      elements.onlinePhotosCount.textContent = data.online_count;
    }
    if (data.offline_count !== undefined && elements.offlinePhotosCount) {
      elements.offlinePhotosCount.textContent = data.offline_count;
    }

    if (elements.duplicatesOnlyNavItem) {
      elements.duplicatesOnlyNavItem.style.display = 'flex';
    }
    if (elements.duplicatePhotosCount) {
      elements.duplicatePhotosCount.textContent = count;
      elements.duplicatePhotosCount.style.display = 'inline-block';
      elements.duplicatePhotosCount.classList.toggle('badge-info', count > 0);
    }
  } catch (err) {
    console.warn('[WARN] fetchDuplicatesCount エラー:', err);
  }
}
window.fetchDuplicatesCount = fetchDuplicatesCount;
