# 左ペイン タグ削除（×ボタン）不具合の修正 実装計画 (Implementation Plan)

## 1. 概要・背景
左サイドバー（左ペイン）のアコーディオン「🏷️ タグ (アルバム)」セクション（`#tagList`）において、タグ行右端の「×」ボタンをクリックした際に、タグ削除が発火せずフィルタ選択（枠線の青/朱色トグル）に吸い取られたり、ダイアログが表示されない問題に対処する。

## 2. 原因分析
1. **ホバー依存の `display: none` によるレイアウトシフトと消滅**:
   - `.tag-delete-btn` および `.tag-rename-btn` が通常 `display: none`。
   - ホバー時に突然 `display: inline-block` になり、幅が伸びてボタン位置が動く。
   - カーソルがボタンへ向かうわずかな間にホバーが外れるとボタンが消滅し、親のタグ行（`.tag-pill-item`）にクリックイベントが吸い取られてしまう。
2. **極小のヒット領域（16px × 16px）**:
   - ヒット領域が小さく、マウスクリック（down/up）のズレでボタン外をクリックしたと判定される。
3. **イベント伝播（mousedown/pointerdown）の未遮断**:
   - `deleteBtn` で `click` のみ `e.stopPropagation()` されており、`mousedown` 等が親へ漏れている。
4. **ブラウザ標準 `window.confirm()` のリスク**:
   - Edge/Chrome の `--app` モード下でのダイアログ抑制、フォーカス外れ、背後隠蔽の懸念。

## 3. 実装詳細

### (1) CSS改善 (`frontend/css/style.css`)
- `.tag-delete-btn` と `.tag-rename-btn` のスタイル：
  - `display: none` を廃止し、`display: inline-flex; align-items: center; justify-content: center;` に統一。
  - 通常時は `opacity: 0; pointer-events: none;`、親ホバー時に `opacity: 0.7; pointer-events: auto;`、ボタン自身ホバー時に `opacity: 1;` にする。
  - 幅・高さを `22px × 22px` に拡大し、角丸（`border-radius: 4px`）で押しやすい領域を確保。
  - これにより、ホバー前後でタグ行の幅が一切動かず、狙った位置のボタンを確実にクリックできるようにする。

### (2) アプリ内削除確認モーダルの追加 (`frontend/index.html`)
- `#deleteTagModal` を追加（Hinomaru Ink UI kit スタイル）。
  - タイトル：🏷️ タグの完全削除
  - 本文：タグ「**<tagPath>**」をすべての写真から削除しますか？（対象写真枚数の表示）
  - 注意書き：※ 写真ファイル自体は削除されません。
  - アクションボタン：
    - キャンセル（Esc / 背景クリック対応）
    - タグを削除（赤色デンジャーボタン）

### (3) JavaScript の改修 (`frontend/js/app.js`, `frontend/js/common.js`)
- `deleteBtn` に `mousedown` / `pointerdown` / `click` での `e.stopPropagation()` を追加。
- `pillItem` のクリックハンドラで `e.target.closest('.tag-delete-btn')` や `.tag-rename-btn` を確実にガード。
- `deleteTagCompletely(tagPath, photoCount)` を `deleteTagModal` を使用したプロミスベースの非同期モーダルに変更（モーダルがない場合は `confirm` に安全フォールバック）。
- 削除完了後に `state.tagFilters.delete(tagPath)` および `await refreshAll()` を実行。

## 4. 検証手順
1. ブラウザで左サイドバーの「タグ (アルバム)」を開く。
2. タグ行にマウスを乗せ、レイアウトがガタつかずに「×」と「✏」が安定して表示されることを確認。
3. 「×」ボタンをクリックした際、親のタグ選択枠が反応せず、即座に「🏷️ タグの完全削除」モーダルが表示されることを確認。
4. 「キャンセル」を押して安全に閉じられることを確認。
5. 再度「×」を押し、モーダルの「タグを削除」を押してタグがDB・画面から確実に削除されることを確認。
