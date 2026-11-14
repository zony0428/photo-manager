/**
 * Tetheract Photo Manager - Layer 1: Field Log Adapter (window.TetheractFieldLogAdapter)
 *
 * Android ネイティブブリッジ経由で GPS フィールドログ（採取）の状態取得・開始・停止・
 * 日別一覧・削除・設定保存、およびネイティブからの状態変更・画面起動通知を仲介する。
 * Layer 1 規約に基づき DOM 参照・操作は一切行わない。
 */

(function (global) {
  'use strict';

  const DEFAULT_SETTINGS = {
    intervalSec: 30,
    autoStopHours: 12,
    autoDeleteDays: 30,
  };

  const statusListeners = new Set();
  const openListeners = new Set();
  let pendingOpenRequest = false;

  function _safeParseJson(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn('FieldLogAdapter JSON parse error:', err);
      return fallback;
    }
  }

  function _normalizeSettings(rawSettings) {
    const s = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const intervalSec = Number(s.intervalSec);
    const autoStopHours = Number(s.autoStopHours);
    const autoDeleteDays = Number(s.autoDeleteDays);
    return {
      intervalSec: Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : DEFAULT_SETTINGS.intervalSec,
      autoStopHours: Number.isFinite(autoStopHours) && autoStopHours > 0 ? autoStopHours : DEFAULT_SETTINGS.autoStopHours,
      autoDeleteDays: Number.isFinite(autoDeleteDays) && autoDeleteDays >= 0 ? autoDeleteDays : DEFAULT_SETTINGS.autoDeleteDays,
    };
  }

  function _normalizeStatus(rawStatus, available) {
    const src = rawStatus && typeof rawStatus === 'object' ? rawStatus : {};
    const perm = src.permission && typeof src.permission === 'object' ? src.permission : {};
    return {
      ...src,
      available: Boolean(available),
      recording: Boolean(src.recording),
      startedAt: Number(src.startedAt || 0),
      todayPoints: Number(src.todayPoints || 0),
      settings: _normalizeSettings(src.settings),
      permission: {
        location: Boolean(perm.location),
        notification: Boolean(perm.notification),
      },
      interrupted: Boolean(src.interrupted),
    };
  }

  function _normalizeDayItem(rawDay) {
    const d = rawDay && typeof rawDay === 'object' ? rawDay : {};
    return {
      date: String(d.date || ''),
      points: Number(d.points || 0),
      firstT: Number(d.firstT || 0),
      lastT: Number(d.lastT || 0),
      distanceM: Number(d.distanceM || 0),
      bytes: Number(d.bytes || 0),
      uploaded: Boolean(d.uploaded),
    };
  }

  /**
   * Android ネイティブのフィールドログ機能が利用可能か判定する
   */
  function isAvailable() {
    return Boolean(
      global.TetheractNative &&
        typeof global.TetheractNative.fieldLogGetStatusJson === 'function'
    );
  }

  /**
   * 現在の記録状態・設定・権限・中断フラグを取得する
   */
  async function getStatus() {
    if (!isAvailable()) {
      return _normalizeStatus(null, false);
    }
    try {
      const parsed = _safeParseJson(global.TetheractNative.fieldLogGetStatusJson(), null);
      return _normalizeStatus(parsed, true);
    } catch (err) {
      console.warn('fieldLogGetStatusJson failed:', err);
      return _normalizeStatus(null, true);
    }
  }

  /**
   * アプリ前面から GPS フィールドログの記録を開始する
   */
  async function start() {
    if (!isAvailable()) {
      return { ok: false, error: 'native_unavailable' };
    }
    try {
      const res = _safeParseJson(global.TetheractNative.fieldLogStartJson(), { ok: false });
      return res && typeof res === 'object' ? res : { ok: false };
    } catch (err) {
      console.warn('fieldLogStartJson failed:', err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * GPS フィールドログの記録を停止する
   */
  async function stop() {
    if (!isAvailable()) {
      return { ok: false, error: 'native_unavailable' };
    }
    try {
      const res = _safeParseJson(global.TetheractNative.fieldLogStopJson(), { ok: false });
      return res && typeof res === 'object' ? res : { ok: false };
    } catch (err) {
      console.warn('fieldLogStopJson failed:', err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * 端末内に保存されている日別ログ一覧を新しい日付順で取得する
   */
  async function listDays() {
    if (!isAvailable()) {
      return [];
    }
    try {
      const parsed = _safeParseJson(global.TetheractNative.fieldLogListDaysJson(), { days: [] });
      const rawList = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.days) ? parsed.days : []);
      return rawList.map(_normalizeDayItem).filter((item) => Boolean(item.date));
    } catch (err) {
      console.warn('fieldLogListDaysJson failed:', err);
      return [];
    }
  }

  /**
   * 指定した日付配列（YYYY-MM-DD）のログファイルを削除する
   */
  async function deleteDays(dates) {
    if (!isAvailable()) {
      return { ok: false, deleted: 0, error: 'native_unavailable' };
    }
    const cleanDates = Array.isArray(dates)
      ? dates.map((d) => String(d || '').trim()).filter(Boolean)
      : [];
    if (cleanDates.length === 0) {
      return { ok: true, deleted: 0 };
    }
    try {
      const res = _safeParseJson(
        global.TetheractNative.fieldLogDeleteDaysJson(JSON.stringify(cleanDates)),
        { ok: false, deleted: 0 }
      );
      return {
        ok: Boolean(res && res.ok),
        deleted: Number((res && res.deleted) || 0),
      };
    } catch (err) {
      console.warn('fieldLogDeleteDaysJson failed:', err);
      return { ok: false, deleted: 0, error: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * 端末内のすべてのフィールドログファイルを削除する
   */
  async function deleteAll() {
    if (!isAvailable()) {
      return { ok: false, deleted: 0, error: 'native_unavailable' };
    }
    try {
      const res = _safeParseJson(
        global.TetheractNative.fieldLogDeleteAllJson(),
        { ok: false, deleted: 0 }
      );
      return {
        ok: Boolean(res && res.ok),
        deleted: Number((res && res.deleted) || 0),
      };
    } catch (err) {
      console.warn('fieldLogDeleteAllJson failed:', err);
      return { ok: false, deleted: 0, error: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * 記録間隔・自動停止時間・自動削除日数の設定を保存する
   */
  async function saveSettings(settings) {
    if (!isAvailable()) {
      return { ok: false, error: 'native_unavailable' };
    }
    const payload = settings && typeof settings === 'object' ? settings : {};
    try {
      const res = _safeParseJson(
        global.TetheractNative.fieldLogSaveSettingsJson(JSON.stringify(payload)),
        { ok: false }
      );
      if (res && typeof res === 'object') {
        return {
          ...res,
          ok: Boolean(res.ok),
          settings: _normalizeSettings(res.settings || payload),
        };
      }
      return { ok: false };
    } catch (err) {
      console.warn('fieldLogSaveSettingsJson failed:', err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * 現在地の単発取得（第2期で本体実装予定の公開枠）
   */
  async function requestCurrentLocation() {
    return { ok: false, error: 'not_implemented_in_phase1' };
  }

  /**
   * ネイティブからの記録状態変更通知を購読する（解除関数を返す）
   */
  function onStatusChanged(callback) {
    if (typeof callback !== 'function') return function () {};
    statusListeners.add(callback);
    return function unsubscribe() {
      statusListeners.delete(callback);
    };
  }

  /**
   * クイック設定タイル長押しや通知タップによるログ画面オープン要求を購読する（解除関数を返す）
   */
  function onOpenRequested(callback) {
    if (typeof callback !== 'function') return function () {};
    openListeners.add(callback);
    if (pendingOpenRequest) {
      pendingOpenRequest = false;
      Promise.resolve().then(() => {
        try {
          callback();
        } catch (err) {
          console.warn('FieldLog open listener error:', err);
        }
      });
    }
    return function unsubscribe() {
      openListeners.delete(callback);
    };
  }

  const prevChangedHook =
    typeof global.__onTetheractFieldLogChanged === 'function'
      ? global.__onTetheractFieldLogChanged
      : null;

  global.__onTetheractFieldLogChanged = function (statusPayload) {
    if (prevChangedHook) {
      try {
        prevChangedHook(statusPayload);
      } catch (err) {
        console.warn('Previous __onTetheractFieldLogChanged hook error:', err);
      }
    }
    const parsed = _safeParseJson(statusPayload, null);
    const normalized = _normalizeStatus(parsed, isAvailable());
    statusListeners.forEach((fn) => {
      try {
        fn(normalized);
      } catch (err) {
        console.warn('FieldLog status listener error:', err);
      }
    });
  };

  const prevOpenHook =
    typeof global.__onTetheractOpenFieldLog === 'function'
      ? global.__onTetheractOpenFieldLog
      : null;

  global.__onTetheractOpenFieldLog = function () {
    if (prevOpenHook) {
      try {
        prevOpenHook();
      } catch (err) {
        console.warn('Previous __onTetheractOpenFieldLog hook error:', err);
      }
    }
    if (openListeners.size === 0) {
      pendingOpenRequest = true;
      return;
    }
    openListeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn('FieldLog open listener error:', err);
      }
    });
  };

  global.TetheractFieldLogAdapter = {
    isAvailable,
    getStatus,
    start,
    stop,
    listDays,
    deleteDays,
    deleteAll,
    saveSettings,
    requestCurrentLocation,
    onStatusChanged,
    onOpenRequested,
  };
})(typeof window !== 'undefined' ? window : globalThis);
