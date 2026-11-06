/* ==========================================================================
   3段階セキュリティ（Lv.0 エシカル / Lv.1 起動＆DBロック / Lv.2 フルロック）UI制御
   ========================================================================== */
let _securityUnlockWaitPromise = null;
let _securityUnlockResolve = null;
let _currentForeignLoomeNode = null;

function _formatSecurityLevelBadge(level) {
  const lv = Number(level || 0);
  if (lv === 2) return 'Lv.2: フルロック（Loomeカプセル化）';
  if (lv === 1) return 'Lv.1: 起動＆DBロック';
  return 'Lv.0: エシカルモード';
}

/**
 * 設定モーダルのセキュリティレベル選択に応じた説明テキストを更新する
 */
function _updateSecurityLevelDesc(level) {
  const descEl = document.getElementById('secLevelDescText');
  if (!descEl) return;
  const lv = Number(level || 0);
  if (lv === 2) {
    descEl.textContent = 'Lv.1の保護に加え、Loome内の実ファイルもカプセル化保護し、外部からの直接閲覧を遮断します。';
  } else if (lv === 1) {
    descEl.textContent = 'Lv.0の保護に加え、アプリ起動時のパスワード要求とDB内サムネイルの暗号化を行います。';
  } else {
    descEl.textContent = 'パスワード不要。他人のLoome保護と、library.db単体の不正コピー・引き抜き防止が有効になります。';
  }
}

function showSecurityLockOverlay(secStatus) {
  const overlay = document.getElementById('securityLockOverlay');
  if (!overlay) return;

  if (typeof dismissStartupSplash === 'function') {
    dismissStartupSplash();
  }

  const isForeignDb = Boolean(secStatus && secStatus.db_foreign_locked);
  const lv = Number((secStatus && secStatus.security_level) || 0);

  const titleEl = document.getElementById('secLockOverlayTitle');
  const subEl = document.getElementById('secLockOverlaySubtitle');
  const unlockBox = document.getElementById('secUnlockFormBox');
  const foreignBox = document.getElementById('secDbForeignRecoveryBox');
  const badgeEl = document.getElementById('secUnlockLevelBadge');
  const mediaSec = document.getElementById('secRecoverMediaSection');
  const err1 = document.getElementById('secUnlockErrorMsg');
  const err2 = document.getElementById('secRecoverErrorMsg');

  if (err1) err1.style.display = 'none';
  if (err2) err2.style.display = 'none';

  if (isForeignDb) {
    if (titleEl) titleEl.innerHTML = '<span>🛡️</span> <span>データベース引き継ぎ・オーナー確認</span>';
    if (subEl) subEl.textContent = '別のTetheract本体で作成された library.db を検出しました';
    if (unlockBox) unlockBox.style.display = 'none';
    if (foreignBox) foreignBox.style.display = 'flex';
    if (mediaSec) mediaSec.style.display = lv === 0 ? 'flex' : 'none';
    const secInput = document.getElementById('secRecoverSecretInput');
    if (secInput) {
      secInput.value = '';
      setTimeout(() => secInput.focus(), 60);
    }
  } else {
    if (titleEl) titleEl.innerHTML = '<span>🔒</span> <span>Tetheract セキュリティロック</span>';
    if (subEl) subEl.textContent = 'パスワードまたはリカバリーコードを入力してロックを解除してください';
    if (unlockBox) unlockBox.style.display = 'flex';
    if (foreignBox) foreignBox.style.display = 'none';
    if (badgeEl) {
      badgeEl.textContent = lv === 2
        ? '🛡️ Lv.2 フルロック保護中（起動・DB・Loome実ファイル保護）'
        : '🛡️ Lv.1 起動＆DBロック保護中';
    }
    const pwInput = document.getElementById('secUnlockPasswordInput');
    if (pwInput) {
      pwInput.value = '';
      setTimeout(() => pwInput.focus(), 60);
    }
  }

  overlay.style.display = 'flex';
}

function hideSecurityLockOverlay() {
  const overlay = document.getElementById('securityLockOverlay');
  if (overlay) overlay.style.display = 'none';
  if (_securityUnlockResolve) {
    const fn = _securityUnlockResolve;
    _securityUnlockResolve = null;
    _securityUnlockWaitPromise = null;
    fn(true);
    setTimeout(() => {
      if (typeof loadMobileConnectionInfo === 'function') {
        loadMobileConnectionInfo(true);
      }
    }, 900);
  }
}

async function ensureAppUnlockedOnStartup() {
  initSecurityUI();
  try {
    const res = await fetch('/api/security/status');
    if (!res.ok) return true;
    const st = await res.json();
    if (!st || !st.is_locked) {
      return true;
    }
    showSecurityLockOverlay(st);
    if (!_securityUnlockWaitPromise) {
      _securityUnlockWaitPromise = new Promise((resolve) => {
        _securityUnlockResolve = resolve;
      });
    }
    return await _securityUnlockWaitPromise;
  } catch (err) {
    console.warn('[Security] 起動ロック状態確認スキップ:', err);
    return true;
  }
}
window.ensureAppUnlockedOnStartup = ensureAppUnlockedOnStartup;

async function refreshSecuritySettingsUI() {
  try {
    const res = await fetch('/api/security/status');
    if (!res.ok) return;
    const st = await res.json();
    const lv = Number(st.security_level || 0);
    const badge = document.getElementById('secSettingsCurrentBadge');
    if (badge) {
      badge.textContent = _formatSecurityLevelBadge(lv);
    }
    const lockBtn = document.getElementById('secLockNowBtn');
    if (lockBtn) {
      lockBtn.style.display = lv >= 1 ? 'inline-flex' : 'none';
    }
    const sel = document.getElementById('secLevelSelect');
    if (sel) {
      sel.value = String(lv);
    }
    _updateSecurityLevelDesc(lv);
    const curPass = document.getElementById('secCurrentPassInput');
    const newPass = document.getElementById('secNewPassInput');
    if (curPass) {
      curPass.value = '';
      curPass.style.display = lv >= 1 ? 'block' : 'none';
    }
    if (newPass) {
      newPass.value = '';
      newPass.style.display = Number(sel ? sel.value : lv) >= 1 ? 'block' : 'none';
    }
    const recText = document.getElementById('secRecoveryCodeText');
    if (recText) {
      recText.textContent = st.recovery_code || '（ロック解除後に表示）';
    }
  } catch (err) {
    console.warn('[Security] 設定UI更新エラー:', err);
  }
}
window.refreshSecuritySettingsUI = refreshSecuritySettingsUI;

function openForeignLoomeModal(node) {
  _currentForeignLoomeNode = node || null;
  const modal = document.getElementById('foreignLoomeModal');
  if (!modal) return;
  const drvLabel = document.getElementById('foreignLoomeDriveLabel');
  if (drvLabel) {
    drvLabel.textContent = (node && (node.name || node.path)) || '対象ドライブ';
  }
  const pwInput = document.getElementById('foreignLoomePasswordInput');
  if (pwInput) pwInput.value = '';
  const errEl = document.getElementById('foreignLoomeErrorMsg');
  if (errEl) errEl.style.display = 'none';
  modal.style.display = 'flex';
}
window.openForeignLoomeModal = openForeignLoomeModal;

function closeForeignLoomeModal() {
  const modal = document.getElementById('foreignLoomeModal');
  if (modal) modal.style.display = 'none';
  _currentForeignLoomeNode = null;
}
window.closeForeignLoomeModal = closeForeignLoomeModal;

function initSecurityUI() {
  const overlay = document.getElementById('securityLockOverlay');
  if (!overlay || overlay.dataset.boundSecurity) return;
  overlay.dataset.boundSecurity = 'true';

  // 1. 通常パスワードロック解除
  const submitUnlock = async () => {
    const pwInput = document.getElementById('secUnlockPasswordInput');
    const errEl = document.getElementById('secUnlockErrorMsg');
    const btn = document.getElementById('secUnlockSubmitBtn');
    const val = (pwInput ? pwInput.value : '').trim();
    if (!val) {
      if (errEl) {
        errEl.textContent = 'パスワードまたはリカバリーコードを入力してください。';
        errEl.style.display = 'block';
      }
      return;
    }
    try {
      if (btn) btn.disabled = true;
      if (errEl) errEl.style.display = 'none';
      const res = await fetch('/api/security/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: val }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || 'ロック解除に失敗しました');
      }
      const hadPromise = Boolean(_securityUnlockResolve);
      hideSecurityLockOverlay();
      if (typeof showToast === 'function') {
        showToast('セキュリティロックを解除しました', 'success', 2500);
      }
      if (!hadPromise && typeof refreshAll === 'function') {
        await refreshAll();
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  document.getElementById('secUnlockSubmitBtn')?.addEventListener('click', submitUnlock);
  document.getElementById('secUnlockPasswordInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitUnlock();
    }
  });

  // 2. DB引き継ぎ救済（所有メディア照合）
  document.getElementById('secRecoverByMediaBtn')?.addEventListener('click', async () => {
    const errEl = document.getElementById('secRecoverErrorMsg');
    const btn = document.getElementById('secRecoverByMediaBtn');
    try {
      if (btn) btn.disabled = true;
      if (errEl) errEl.style.display = 'none';
      const res = await fetch('/api/security/recover-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'owned_media' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || '所有メディアの照合に失敗しました');
      }
      const hadPromise = Boolean(_securityUnlockResolve);
      hideSecurityLockOverlay();
      if (typeof showToast === 'function') {
        showToast(`所有メディア（VSN: ${data.matched_volume_serial || ''}）を確認し、DBを引き継ぎました`, 'success', 4000);
      }
      if (!hadPromise && typeof refreshAll === 'function') {
        await refreshAll();
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // 3. DB引き継ぎ救済（パスワード / リカバリーコード）
  const submitRecoverSecret = async () => {
    const inp = document.getElementById('secRecoverSecretInput');
    const errEl = document.getElementById('secRecoverErrorMsg');
    const btn = document.getElementById('secRecoverBySecretBtn');
    const val = (inp ? inp.value : '').trim();
    if (!val) {
      if (errEl) {
        errEl.textContent = 'パスワードまたはリカバリーコードを入力してください。';
        errEl.style.display = 'block';
      }
      return;
    }
    try {
      if (btn) btn.disabled = true;
      if (errEl) errEl.style.display = 'none';
      const res = await fetch('/api/security/recover-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'password', secret: val }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || '引き継ぎ認証に失敗しました');
      }
      const hadPromise = Boolean(_securityUnlockResolve);
      hideSecurityLockOverlay();
      if (typeof showToast === 'function') {
        showToast('オーナー認証に成功し、データベースをこの本体へ引き継ぎました', 'success', 4000);
      }
      if (!hadPromise && typeof refreshAll === 'function') {
        await refreshAll();
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  document.getElementById('secRecoverBySecretBtn')?.addEventListener('click', submitRecoverSecret);
  document.getElementById('secRecoverSecretInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitRecoverSecret();
    }
  });

  // 4. 設定モーダル内のセキュリティレベル変更
  const secSelect = document.getElementById('secLevelSelect');
  secSelect?.addEventListener('change', () => {
    const nextLv = Number(secSelect.value || 0);
    _updateSecurityLevelDesc(nextLv);
    const newPass = document.getElementById('secNewPassInput');
    if (newPass) {
      newPass.style.display = nextLv >= 1 ? 'block' : 'none';
    }
  });

  document.getElementById('secApplyConfigBtn')?.addEventListener('click', async () => {
    const sel = document.getElementById('secLevelSelect');
    const curPass = document.getElementById('secCurrentPassInput');
    const newPass = document.getElementById('secNewPassInput');
    const btn = document.getElementById('secApplyConfigBtn');
    const targetLevel = Number(sel ? sel.value : 0);
    const currentPassword = curPass ? curPass.value : '';
    const newPassword = newPass ? newPass.value : '';

    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '適用中...';
      }
      const res = await fetch('/api/security/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_level: targetLevel,
          current_password: currentPassword || null,
          new_password: newPassword || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || 'セキュリティ設定の変更に失敗しました');
      }
      await refreshSecuritySettingsUI();
      if (typeof showToast === 'function') {
        showToast(
          `セキュリティ設定を「${_formatSecurityLevelBadge(targetLevel)}」に更新しました`,
          'success',
          4000
        );
      }
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast(`設定エラー: ${err.message}`, 'error', 4000);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '設定を適用';
      }
    }
  });

  document.getElementById('secLockNowBtn')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/security/lock', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'ロックに失敗しました');
      const maintModal = document.getElementById('dbMaintenanceModal');
      if (maintModal) maintModal.style.display = 'none';
      const stRes = await fetch('/api/security/status');
      const st = stRes.ok ? await stRes.json() : { is_locked: true, security_level: data.security_level || 1 };
      showSecurityLockOverlay(st);
    } catch (err) {
      if (typeof showToast === 'function') showToast(`エラー: ${err.message}`, 'error');
    }
  });

  document.getElementById('secCopyRecoveryCodeBtn')?.addEventListener('click', async () => {
    const codeEl = document.getElementById('secRecoveryCodeText');
    const codeText = codeEl ? codeEl.textContent.trim() : '';
    if (!codeText || codeText.startsWith('（')) return;
    try {
      await navigator.clipboard.writeText(codeText);
      if (typeof showToast === 'function') {
        showToast('リカバリーコード（救済キー）をクリップボードにコピーしました', 'success', 3000);
      }
    } catch (_) {
      if (typeof showToast === 'function') showToast(codeText, 'info', 5000);
    }
  });

  // 5. 他人のLoome保護モーダル（およびパスワード承認）
  document.getElementById('closeForeignLoomeModalBtn')?.addEventListener('click', closeForeignLoomeModal);
  document.getElementById('closeForeignLoomeFooterBtn')?.addEventListener('click', closeForeignLoomeModal);
  document.getElementById('foreignLoomeModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'foreignLoomeModal') closeForeignLoomeModal();
  });

  const submitForeignLoomeUnlock = async () => {
    if (!_currentForeignLoomeNode || !_currentForeignLoomeNode.volumeSerial) return;
    const pwInput = document.getElementById('foreignLoomePasswordInput');
    const errEl = document.getElementById('foreignLoomeErrorMsg');
    const btn = document.getElementById('foreignLoomeUnlockBtn');
    const pw = (pwInput ? pwInput.value : '').trim();
    if (!pw) {
      if (errEl) {
        errEl.textContent = 'パスワードを入力してください。';
        errEl.style.display = 'block';
      }
      return;
    }
    try {
      if (btn) btn.disabled = true;
      if (errEl) errEl.style.display = 'none';
      const res = await fetch('/api/security/unlock-foreign-loome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          volume_serial: _currentForeignLoomeNode.volumeSerial,
          password: pw,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || 'パスワードが一致しません');
      }
      closeForeignLoomeModal();
      if (typeof showToast === 'function') {
        showToast('ご自身の Loome メディアとして承認しました！', 'success', 3500);
      }
      if (typeof refreshFolderTree === 'function') await refreshFolderTree();
      if (typeof refreshAll === 'function') await refreshAll();
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  document.getElementById('foreignLoomeUnlockBtn')?.addEventListener('click', submitForeignLoomeUnlock);
  document.getElementById('foreignLoomePasswordInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitForeignLoomeUnlock();
    }
  });
}
window.initSecurityUI = initSecurityUI;
