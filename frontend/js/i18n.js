/**
 * Photo Manager - マルチランゲージ（日本語 JP ⇄ English EN）リアルタイム切替モジュール (i18n.js)
 *
 * 特徴:
 * 1. DBスキーマや既存18モジュールの状態管理ロジックに一切触れず、DOM TextNode と属性（title / placeholder / aria-label）を
 *    双方向トラッキング（__pmOrigJa / __pmLastEn）して0.01秒で日英即時切替を行う。
 * 2. MutationObserver により、非同期描画される写真カード・インスペクタ・ライトボックス・2枚比較(Duel)・
 *    勝ちレンズカルテ(Kami-Lens Karte)・47都道府県制覇マップ(Seiha Map)・トースト通知までリアルタイムに自動翻訳する。
 * 3. カメラ文化・日本発祥スラング（Washi / Urusi, Ex / Gd / Nm / Rj, Lens Shaker, Kami-Lens Karte,
 *    Gear & Numa, Gacha, Osanpo Trail, Seiha Map, Betayaki HTML, Duel）を取り入れた小粋な英語UIを提供する。
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'pm_lang';
  let currentLang = localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'ja';
  let isApplying = false;

  const _dict = window._PM_I18N_DICT || {};
  const EXACT_MAP = _dict.EXACT_MAP || {};
  const MONTH_NAMES_SHORT = _dict.MONTH_NAMES_SHORT || [];
  const PREF_ROMAJI_MAP = _dict.PREF_ROMAJI_MAP || {};
  const PATTERN_RULES = _dict.PATTERN_RULES || [];

  /**
   * 文字列を日本語から英語に変換する
   * @param {string} raw
   * @returns {string}
   */
  function translateString(raw) {
    if (!raw || typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    // 日本語文字（ひらがな・カタカナ・漢字）を1文字も含まない場合（絵文字のみ・英数字のみ）は無変換で即座に返す
    if (!/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(trimmed)) return raw;

    // 1. 完全一致辞書
    if (Object.prototype.hasOwnProperty.call(EXACT_MAP, trimmed)) {
      const target = EXACT_MAP[trimmed];
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      return lead + target + trail;
    }

    // 2. 都道府県名（47都道府県白地図のSVGセル等）
    if (Object.prototype.hasOwnProperty.call(PREF_ROMAJI_MAP, trimmed)) {
      const target = PREF_ROMAJI_MAP[trimmed];
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      return lead + target + trail;
    }

    // 3. パターンルール
    for (let i = 0; i < PATTERN_RULES.length; i++) {
      const [regex, replacement] = PATTERN_RULES[i];
      if (regex.test(trimmed)) {
        const converted = trimmed.replace(regex, replacement);
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        return lead + converted + trail;
      }
    }

    return raw;
  }

  /**
   * 翻訳対象外とすべき要素か判定する（スクリプト・スタイル・ファイルパス表示セル・言語切替ボタン自身）
   * @param {Element|null} el
   * @returns {boolean}
   */
  function shouldSkipElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
      return true;
    }
    if (el.id === 'langToggleBtn' || el.closest('#langToggleBtn')) {
      return true;
    }
    if (
      el.classList &&
      (el.classList.contains('path-val') ||
        el.classList.contains('path-cell') ||
        el.classList.contains('raw-filename') ||
        el.classList.contains('card-filename') ||
        el.classList.contains('lightbox-filename') ||
        el.classList.contains('compare-filename'))
    ) {
      return true;
    }
    return false;
  }

  /**
   * 単一のTextNodeを現在の言語設定（en / ja）に合わせて変換または復元する
   * @param {Text} textNode
   */
  function processTextNode(textNode) {
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const parent = textNode.parentElement;
    if (shouldSkipElement(parent)) return;

    const val = textNode.nodeValue;
    if (!val || !val.trim()) return;

    if (currentLang === 'en') {
      // 既に直近で変換した英語文字列そのものであればスキップ（無限ループ防止）
      if (textNode.__pmLastEn !== undefined && val === textNode.__pmLastEn) {
        return;
      }
      // 新しい日本語文字列（または初期値）として記憶し、英語へ変換
      textNode.__pmOrigJa = val;
      const enVal = translateString(val);
      if (enVal !== val) {
        textNode.__pmLastEn = enVal;
        textNode.nodeValue = enVal;
      }
    } else {
      // 日本語モード: 英語に変換されていた場合は元の日本語へ復元
      if (textNode.__pmOrigJa !== undefined && val === textNode.__pmLastEn) {
        textNode.nodeValue = textNode.__pmOrigJa;
      }
    }
  }

  const TARGET_ATTRS = ['title', 'placeholder', 'aria-label'];

  /**
   * 要素の属性（title / placeholder / aria-label）を変換または復元する
   * @param {Element} el
   */
  function processElementAttributes(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (el.id === 'langToggleBtn' || el.closest('#langToggleBtn')) return;

    for (let i = 0; i < TARGET_ATTRS.length; i++) {
      const attr = TARGET_ATTRS[i];
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr);
      if (!val || !val.trim()) continue;

      if (!el.__pmAttrOrig) el.__pmAttrOrig = {};
      if (!el.__pmAttrEn) el.__pmAttrEn = {};

      if (currentLang === 'en') {
        if (el.__pmAttrEn[attr] !== undefined && val === el.__pmAttrEn[attr]) {
          continue;
        }
        el.__pmAttrOrig[attr] = val;
        const enVal = translateString(val);
        if (enVal !== val) {
          el.__pmAttrEn[attr] = enVal;
          el.setAttribute(attr, enVal);
        }
      } else {
        if (el.__pmAttrOrig[attr] !== undefined && val === el.__pmAttrEn[attr]) {
          el.setAttribute(attr, el.__pmAttrOrig[attr]);
        }
      }
    }
  }

  /**
   * 指定されたルートノード配下のすべてのTextNodeおよび属性を一括走査する
   * @param {Node} root
   */
  function processSubtree(root) {
    if (!root) return;
    isApplying = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) {
        processTextNode(root);
        return;
      }
      if (root.nodeType === Node.ELEMENT_NODE) {
        processElementAttributes(root);
      }

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        null
      );

      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          processElementAttributes(node);
        }
        node = walker.nextNode();
      }
    } finally {
      isApplying = false;
    }
  }

  /**
   * ヘッダーの言語切替ボタン（#langToggleBtn）の表示を更新する
   */
  function updateLangToggleButton() {
    const btn = document.getElementById('langToggleBtn');
    const iconEl = document.getElementById('langToggleIcon');
    const labelEl = document.getElementById('langToggleLabel');

    document.documentElement.lang = currentLang;
    document.documentElement.setAttribute('data-lang', currentLang);

    if (!btn) return;
    if (currentLang === 'en') {
      if (iconEl) iconEl.textContent = '';
      if (labelEl) labelEl.textContent = 'EN';
      btn.title = 'Switch UI Language (English ⇄ 日本語)';
      btn.classList.add('is-en');
    } else {
      if (iconEl) iconEl.textContent = '';
      if (labelEl) labelEl.textContent = 'JP';
      btn.title = 'UI言語切り替え (日本語 ⇄ English)';
      btn.classList.remove('is-en');
    }
  }

  /**
   * 言語を切り替えて即時反映する
   * @param {'ja'|'en'} lang
   */
  let _i18nObserver = null;

  function syncObserverState() {
    if (!_i18nObserver || !document.body) return;
    if (currentLang === 'en') {
      _i18nObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TARGET_ATTRS,
      });
    } else {
      _i18nObserver.disconnect();
    }
  }

  function setLanguage(lang) {
    currentLang = lang === 'en' ? 'en' : 'ja';
    localStorage.setItem(STORAGE_KEY, currentLang);
    updateLangToggleButton();
    syncObserverState();
    processSubtree(document.body);
  }

  /**
   * 日本語 ⇄ 英語をトグルする
   */
  function toggleLanguage() {
    const nextLang = currentLang === 'ja' ? 'en' : 'ja';
    setLanguage(nextLang);
    if (typeof showToast === 'function') {
      if (nextLang === 'en') {
        showToast('Switched UI language to English', 'info', 2200);
      } else {
        showToast('表示言語を日本語に切り替えました', 'info', 2200);
      }
    }
  }

  /**
   * 初期化＆MutationObserver監視開始
   */
  function initI18n() {
    const btn = document.getElementById('langToggleBtn');
    if (btn && !btn.dataset.i18nBound) {
      btn.dataset.i18nBound = 'true';
      btn.addEventListener('click', toggleLanguage);
    }

    updateLangToggleButton();
    if (currentLang === 'en') {
      processSubtree(document.body);
    }

    const observer = new MutationObserver((mutations) => {
      if (isApplying || currentLang !== 'en') return;
      isApplying = true;
      try {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.type === 'characterData') {
            processTextNode(m.target);
          } else if (m.type === 'attributes') {
            processElementAttributes(m.target);
          } else if (m.type === 'childList') {
            for (let j = 0; j < m.addedNodes.length; j++) {
              const added = m.addedNodes[j];
              if (added.nodeType === Node.TEXT_NODE) {
                processTextNode(added);
              } else if (added.nodeType === Node.ELEMENT_NODE) {
                processSubtree(added);
              }
            }
          }
        }
      } finally {
        isApplying = false;
      }
    });

    _i18nObserver = observer;
    syncObserverState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initI18n);
  } else {
    initI18n();
  }

  // グローバルAPI公開
  window.pmI18n = {
    getLang: () => currentLang,
    setLanguage,
    toggleLanguage,
    translateString,
  };
  window.t = function (_key, fallbackJa) {
    const base = fallbackJa !== undefined ? String(fallbackJa) : String(_key || '');
    return currentLang === 'en' ? translateString(base) : base;
  };
})();
