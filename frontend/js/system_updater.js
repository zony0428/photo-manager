/**
 * PC母艦ソフトウェア更新・ポータブル差分パッケージ同期UI制御モジュール
 */
(function () {
  'use strict';

  let _latestStatus = null;
  let _busy = false;
  let _startupNotified = false;
  let _startupTriggered = false;

  function _esc(str) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(str);
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function _notify(msg, type = 'info', durationMs = 3500) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type, durationMs);
    }
  }

  function _renderStatusUI(data) {
    _latestStatus = data || null;
    const badgeEl = document.getElementById('headerUpdateAvailBadge');
    const devBadgeEl = document.getElementById('sysUpdateDevBadge');
    const infoEl = document.getElementById('sysUpdateCurrentInfo');
    const boxEl = document.getElementById('sysUpdateStatusBox');
    const dlBtn = document.getElementById('sysDownloadGithubUpdateBtn');
    const applyBtn = document.getElementById('sysApplyStagedUpdateBtn');

    if (!data || !data.ok) {
      if (boxEl) boxEl.textContent = '更新状態を取得できませんでした。';
      return;
    }

    const staged = data.staged_update || null;
    const remote = data.remote_release || {};
    const hasStagedNewer = Boolean(staged && staged.is_newer);
    const hasRemoteAvail = Boolean(remote && remote.remote_update_available && remote.diff_asset_url);

    if (badgeEl) {
      badgeEl.style.display = (hasStagedNewer || hasRemoteAvail) ? 'inline-block' : 'none';
      if (hasRemoteAvail) {
        badgeEl.title = `新しいアップデート (v${remote.latest_version}) があります（クリックして開く）`;
      } else if (hasStagedNewer) {
        badgeEl.title = `適用待ちのアップデート (${staged.file_name}) があります（クリックして開く）`;
      }
    }

    if (devBadgeEl) {
      devBadgeEl.style.display = data.is_dev_repository ? 'inline-block' : 'none';
    }

    if (infoEl) {
      const apkTxt = data.apk_available ? 'APK配信可' : 'APK未配置';
      const natTxt = data.native_revision || '-';
      infoEl.textContent = `v${data.current_version || '-'} | UI:${data.ui_revision || '-'} | Native:${natTxt} | ${apkTxt}`;
    }

    if (dlBtn) {
      dlBtn.style.display = hasRemoteAvail ? 'inline-flex' : 'none';
      if (hasRemoteAvail) {
        dlBtn.textContent = `v${remote.latest_version} を取得 (${remote.diff_asset_size_mb || '?'} MB)`;
      }
    }

    if (applyBtn) {
      applyBtn.style.display = (staged && data.can_self_apply) ? 'inline-flex' : 'none';
      if (staged) {
        applyBtn.textContent = `再起動して v${staged.version} へ更新`;
      }
    }

    if (boxEl) {
      const lines = [];
      if (staged) {
        const tag = staged.is_newer ? '適用待機中（新バージョン）' : '配置済み（現在版と同等以下）';
        lines.push(
          `<div><strong>${_esc(tag)}:</strong> <code>${_esc(staged.file_name)}</code> (v${_esc(staged.version)} / ${_esc(staged.size_mb)} MB)</div>`
        );
        if (data.is_dev_repository) {
          lines.push('<div style="color:#60a5fa; margin-top:2px;">開発リポジトリ環境のため、自己上書き適用は保護ブロックされています。</div>');
        } else if (!data.can_self_apply) {
          lines.push('<div style="color:#fbbf24; margin-top:2px;">Tetheract.exe がルートに見つからないため手動起動が必要です。</div>');
        }
      }

      const checkedAtTxt = remote.checked_at ? `（${_esc(remote.checked_at)} 確認）` : '';
      if (hasRemoteAvail) {
        lines.push(
          `<div style="color:var(--accent-primary, #e14d2a); margin-top:4px;"><strong>新しいリリースが公開されています:</strong> v${_esc(remote.latest_version)} (<code>${_esc(remote.diff_asset_name)}</code>)${checkedAtTxt}</div>`
        );
      } else if (remote && remote.checked && !remote.error) {
        const latestTxt = remote.latest_version ? `（最新: v${_esc(remote.latest_version)}）` : '';
        lines.push(`<div>GitHub Releases 確認済み${checkedAtTxt}: 現在の系列は最新です ${latestTxt}</div>`);
        if (remote.other_series_version) {
          lines.push(
            `<div style="font-size:0.75rem; margin-top:2px;">参考: 別メジャー系列の v${_esc(remote.other_series_version)} が公開されています。</div>`
          );
        }
      } else if (remote && remote.error) {
        lines.push(`<div style="color:#fbbf24;">GitHub 確認エラー: ${_esc(remote.error)}</div>`);
      } else if (!staged) {
        lines.push('<div>「GitHubで更新を確認」を押すと最新リリースを確認します。オフライン環境では下から <code>diff.zip</code> を書き出し・読み込みできます。</div>');
      }
      boxEl.innerHTML = lines.join('');
    }
  }

  async function refreshSystemUpdaterUI(checkRemote = false, forceRemote = false, options = {}) {
    try {
      const url = `/api/system/update-status?check_remote=${checkRemote ? 1 : 0}&force_remote=${forceRemote ? 1 : 0}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 423) return null;
        const errData = await res.json().catch(() => ({}));
        const boxEl = document.getElementById('sysUpdateStatusBox');
        if (boxEl) {
          const detail = errData.detail ? `: ${_esc(errData.detail)}` : '';
          boxEl.innerHTML = `<div style="color:#fbbf24;">更新状態の確認に失敗しました (HTTP ${res.status})${detail}</div>`;
        }
        return null;
      }
      const data = await res.json();
      _renderStatusUI(data);

      if (options && options.notifyIfAvailable && !_startupNotified) {
        const staged = data.staged_update || null;
        const remote = data.remote_release || {};
        const hasStagedNewer = Boolean(staged && staged.is_newer);
        const hasRemoteAvail = Boolean(remote && remote.remote_update_available && remote.diff_asset_url);
        if (hasRemoteAvail) {
          _startupNotified = true;
          _notify(`新バージョン v${remote.latest_version} が公開されています（ロゴ → データベース・保守 から更新できます）`, 'info', 6000);
        } else if (hasStagedNewer) {
          _startupNotified = true;
          _notify(`適用待ちのアップデート (${staged.file_name}) があります（ロゴ → データベース・保守 から適用できます）`, 'info', 6000);
        }
      }
      return data;
    } catch (e) {
      if (!_latestStatus) {
        const boxEl = document.getElementById('sysUpdateStatusBox');
        if (boxEl) {
          boxEl.innerHTML = '<div style="color:#fbbf24;">更新状態の確認中に通信エラーが発生しました。</div>';
        }
      }
      return null;
    }
  }
  window.refreshSystemUpdaterUI = refreshSystemUpdaterUI;

  async function _handleCheckGithubClick() {
    if (_busy) return;
    const btn = document.getElementById('sysCheckGithubUpdateBtn');
    _busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '確認中...';
    }
    try {
      const data = await refreshSystemUpdaterUI(true, true);
      if (!data) {
        _notify('更新確認に失敗しました', 'error');
      } else if (data.remote_release && data.remote_release.error) {
        _notify(`GitHub に接続できませんでした: ${data.remote_release.error}`, 'warning', 4500);
      } else if (data.remote_release && data.remote_release.remote_update_available) {
        _notify(`新バージョン v${data.remote_release.latest_version} が見つかりました`, 'success', 4000);
      } else {
        _notify('現在お使いのバージョンは最新です', 'success', 3000);
      }
    } finally {
      _busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'GitHubで更新を確認';
      }
    }
  }

  async function _handleDownloadGithubClick() {
    if (_busy) return;
    const btn = document.getElementById('sysDownloadGithubUpdateBtn');
    const url = (_latestStatus && _latestStatus.remote_release && _latestStatus.remote_release.diff_asset_url) || '';
    _busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'ダウンロード中...';
    }
    try {
      const res = await fetch('/api/system/download-github-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ download_url: url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        _notify(data.detail || data.error || '更新パッケージの取得に失敗しました', 'error', 4500);
        return;
      }
      _notify(`${data.file_name} を配置しました`, 'success', 4000);
      await refreshSystemUpdaterUI(false);
    } finally {
      _busy = false;
      if (btn) btn.disabled = false;
      if (_latestStatus) _renderStatusUI(_latestStatus);
    }
  }

  async function _handleApplyStagedClick() {
    if (_busy || !_latestStatus || !_latestStatus.staged_update) return;
    const staged = _latestStatus.staged_update;
    const ok = typeof window.showConfirmModal === 'function'
      ? await window.showConfirmModal({
          title: 'クリーンアップデートの適用',
          subtitle: 'Tetheract.exe を起動してアップデート確認へ進みます',
          headingText: `${staged.file_name} (v${staged.version}) を適用しますか？`,
          descriptionLines: [
            '「OK」を押すと Tetheract.exe のクリーンアップデート確認ダイアログが開きます。',
            '※ 登録済みの写真データ・Loome保管庫・データベースは一切消えません。',
          ],
          confirmText: '適用を開始する',
        })
      : false;
    if (!ok) return;

    _busy = true;
    try {
      const res = await fetch('/api/system/trigger-clean-update', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        _notify(data.detail || data.error || 'クリーンアップデートの起動に失敗しました', 'error', 4500);
        return;
      }
      _notify('Tetheract.exe のアップデート確認を起動しました', 'success', 4500);
    } finally {
      _busy = false;
    }
  }

  async function _handleExportPortableDiffZip() {
    if (_busy) return;
    const btn = document.getElementById('sysExportPortableDiffZipBtn');
    _busy = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '生成中...';
    }
    try {
      const res = await fetch('/api/system/export-diff-zip', { cache: 'no-store' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        _notify(errData.detail || '更新パックの生成に失敗しました', 'error', 4500);
        return;
      }
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename="([^"]+)"/i);
      const fileName = (m && m[1]) || 'Tetheract_diff.zip';
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
      _notify(`${fileName} を書き出しました（別母艦のフォルダへコピーして起動すると更新できます）`, 'success', 5000);
    } catch (e) {
      _notify('更新パックの書き出し中にエラーが発生しました', 'error', 4000);
    } finally {
      _busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'USB/別母艦用の更新パック (diff.zip) を書き出す';
      }
    }
  }

  async function _handleImportDiffZipFile(file) {
    if (!file || _busy) return;
    _busy = true;
    const btn = document.getElementById('sysImportDiffZipBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '検証中...';
    }
    try {
      const res = await fetch(`/api/system/stage-diff-zip?file_name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        _notify(data.detail || data.error || 'diff.zip の検証に失敗しました', 'error', 4500);
        return;
      }
      _notify(`${data.file_name} (v${data.version}) を配置しました`, 'success', 4000);
      await refreshSystemUpdaterUI(false);
    } catch (e) {
      _notify('diff.zip の読み込み中にエラーが発生しました', 'error', 4000);
    } finally {
      _busy = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '手元の diff.zip を読み込む';
      }
    }
  }

  function _refreshOnSettingsOpen() {
    const needsRemote = !(_latestStatus && _latestStatus.remote_release && _latestStatus.remote_release.checked);
    refreshSystemUpdaterUI(needsRemote, false);
  }

  function _bindEvents() {
    const badgeEl = document.getElementById('headerUpdateAvailBadge');
    if (badgeEl && !badgeEl.dataset.bound) {
      badgeEl.dataset.bound = 'true';
      badgeEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof window.openSettingsModal === 'function') {
          window.openSettingsModal('database');
        }
        _refreshOnSettingsOpen();
      });
    }

    document.getElementById('sysCheckGithubUpdateBtn')?.addEventListener('click', _handleCheckGithubClick);
    document.getElementById('sysDownloadGithubUpdateBtn')?.addEventListener('click', _handleDownloadGithubClick);
    document.getElementById('sysApplyStagedUpdateBtn')?.addEventListener('click', _handleApplyStagedClick);
    document.getElementById('sysExportPortableDiffZipBtn')?.addEventListener('click', _handleExportPortableDiffZip);

    const impBtn = document.getElementById('sysImportDiffZipBtn');
    const impInput = document.getElementById('sysImportDiffZipInput');
    if (impBtn && impInput) {
      impBtn.addEventListener('click', () => impInput.click());
      impInput.addEventListener('change', () => {
        const f = impInput.files && impInput.files[0];
        impInput.value = '';
        if (f) _handleImportDiffZipFile(f);
      });
    }

    const vtabNav = document.getElementById('settingsVtabNav');
    if (vtabNav) {
      vtabNav.addEventListener('click', (e) => {
        const btn = e.target.closest('.settings-vtab-btn[data-settings-tab]');
        if (btn && btn.dataset.settingsTab === 'database') {
          _refreshOnSettingsOpen();
        }
      });
    }
    document.getElementById('folderDbMaintenanceBtn')?.addEventListener('click', _refreshOnSettingsOpen);
    document.getElementById('headerAppLogo')?.addEventListener('click', _refreshOnSettingsOpen);
  }

  function triggerStartupUpdateCheck() {
    if (_startupTriggered) return;
    _startupTriggered = true;
    refreshSystemUpdaterUI(true, false, { notifyIfAvailable: true });
  }
  window.triggerStartupUpdateCheck = triggerStartupUpdateCheck;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bindEvents);
  } else {
    _bindEvents();
  }
})();
