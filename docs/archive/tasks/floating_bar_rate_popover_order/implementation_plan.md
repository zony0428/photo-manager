# 実装計画: 評価設定ポップオーバー化・フローティングバー並び順再編 (v1.86)

## 1. 概要・背景

### ユーザー要望
1. **メニュー展開方向の統一**:
   - 現在、「タグを付ける」「テイクアウト」はボタンの上に展開されるが、「評価設定」は `<select>` 要素のため下にドロップダウンされる。
   - すべて「上」に展開するよう統一する。
2. **ボタンの並び順の再編**:
   - 並び順を以下に再編する：
     1. 🏷️ タグを付ける
     2. ⭐ 評価設定
     3. 📤 テイクアウト
     4. 🔄 サムネイル更新
     5. ✕ 選択解除
     6. 🗑️ 削除

---

## 2. 変更対象ファイル

| ファイルパス | 変更内容 |
|---|---|
| `frontend/index.html` | 評価設定をボタン＋ポップオーバー構造（`#floatingRatePopover`）に刷新、ボタン並び順を変更（タグ → 評価 → テイクアウト → サムネイル → 選択解除 → 削除）、バージョンを `v1.86`、キャッシュバスター更新 |
| `frontend/css/style.css` | 評価設定ポップオーバーのスタイル（縦またはグリッド状の押しやすい評価ボタンスタイル）、レスポンシブメディアクエリの調整 |
| `frontend/js/common.js` | `elements` に `floatingRateBtn`, `floatingRatePopover` 等を追加（旧 `floatingRateSelect` 置換） |
| `frontend/js/selection.js` | 評価ポップオーバーのトグル、評価選択時の `batchRateSelection` 呼出、排他制御・自動クローズ |
| `VERSION` | `1.85` → `1.86` へインクリメント |
| `MANUAL.md` | 操作マニュアルの並び順および評価ポップオーバー仕様を更新 |

---

## 3. 詳細実装設計

### 3.1 評価設定ポップオーバーのHTML設計
```html
<div class="floating-action-group">
  <button class="btn btn-secondary btn-sm" id="floatingRateBtn" title="選択中の写真の評価を一括設定">
    <span class="btn-icon">⭐</span>
    <span class="btn-label">評価設定</span>
  </button>
  <div class="floating-popover floating-rate-popover" id="floatingRatePopover" style="display: none;">
    <div class="floating-popover-header">
      <span class="floating-popover-title">⭐ 評価を一括設定</span>
      <button class="floating-popover-close" id="closeFloatingRatePopoverBtn" title="閉じる">&times;</button>
    </div>
    <div class="floating-popover-body">
      <div class="popover-rate-list">
        <button class="popover-rate-btn rate-opt-excellent" data-rating="2">
          <span class="rate-icon">🏅</span>
          <span class="rate-name">優 (Excellent)</span>
        </button>
        <button class="popover-rate-btn rate-opt-good" data-rating="1">
          <span class="rate-icon">⭐</span>
          <span class="rate-name">良 (Good)</span>
        </button>
        <button class="popover-rate-btn rate-opt-fair" data-rating="0">
          <span class="rate-icon">⚪</span>
          <span class="rate-name">可 (解除・普通)</span>
        </button>
        <button class="popover-rate-btn rate-opt-discard" data-rating="-1">
          <span class="rate-icon">🗑️</span>
          <span class="rate-name">棄 (非表示候補)</span>
        </button>
      </div>
    </div>
  </div>
</div>
```

### 3.2 ボタンの全体並び順
`#selectionFloatingBar .selection-bar-actions` の中身：
1. `タグを付ける` グループ (`#floatingAddTagBtn`, `#floatingTagPopover`)
2. `評価設定` グループ (`#floatingRateBtn`, `#floatingRatePopover`)
3. `テイクアウト` グループ (`#floatingImportBtn`, `#floatingImportPopover`)
4. `サムネイル更新` ボタン (`#floatingRefreshThumbBtn`)
5. `選択解除` ボタン (`#floatingClearSelectionBtn`)
6. `削除` ボタン (`#floatingDeleteBtn`)

### 3.3 CSSスタイル設計
- 幅はコンパクトに 200px〜220px 程度。
- 各ボタンは押しやすいパディング、ホバーエフェクト、評価ごとのアクセントカラー（優: 金/アンバー、良: 青/スカイ、可: スレート、棄: 赤/クリムゾン）。

---

## 4. 検証手順
1. 写真選択時のバー表示とボタン並び順（タグ → 評価 → テイクアウト → サムネイル → 解除 → 削除）を確認。
2. 「評価設定」ボタンをクリックして、直上に評価ポップオーバーが展開することを確認。
3. 「優」「良」「可」「棄」の各ボタンをクリックして、選択写真に評価が即時反映され、ポップオーバーが閉じることを確認。
4. タグ、評価、テイクアウトの展開方向がすべて「上」に統一されていることを確認。
5. 排他制御・外側クリック・Escキーでのクローズを確認。
