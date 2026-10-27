# 実装計画書: 左ペイン幅調整の復活とヘッダー表記のクリーンアップ (v1.70)

## 1. ユーザー要望と対応方針
1. **「タグのメニューに[+]で新しいタグを作成は変。削除。」**
   - タグアコーディオンヘッダー右端の `[+]` ボタン（`#openAddTagInputBtn`）を削除。
   - タグのヘッダーを「▶ 🏷️ タグ (アルバム)」のシンプルな横書き構成に統一する。
2. **「'タイムライン(年月)'は'タイムライン'に変更。」**
   - アコーディオンタイトル「タイムライン (年月)」を「タイムライン」に簡素化。
3. **「左ペインの巾調整が出来なくなってるけど、これ仕方ない？」**
   - **完全に対応可能**。旧コードの「手帳風インデックスタブのピン留め（`.is-pinned`）」を前提としていたリサイズロジックを、現行のアコーディオン式サイドバー（`.sidebar.accordion-sidebar`）に適合させ、左右の境界境界線をドラッグして幅を自由自在に伸縮できるように復活させる。

---

## 2. 改修詳細

### ① `frontend/index.html`
- `#accordionItem-tags .accordion-header`:
  - `<button class="btn-mini" id="openAddTagInputBtn" ...>+</button>` を削除。
- `#accordionItem-timeline .accordion-header`:
  - `タイムライン (年月)` → `タイムライン` に変更。

### ② `frontend/css/style.css`
- `#resizeHandleLeft`:
  - `display: none;` を撤去し、通常ブロック表示（5px幅のドラッグハンドル）とする。
  - ホバー時に朱色（`--accent-primary`）にハイライトされ、マウスカーソルが `col-resize` になる標準挙動を有効化。

### ③ `frontend/js/common.js`
- `initPaneResize()`:
  - 左サイドバー用リサイズ処理をリファクタリング。
  - 起動時に `localStorage`（キー: `pm_sidebar_width`）から保存幅を復元。
  - ドラッグ時に `sidebar.style.width` と CSS変数 `--sidebar-width` をリアルタイム更新（最小200px、最大600px）。
  - ドラッグ終了時に `localStorage` へ自動保存。

### ④ バージョン & マニュアル同期
- `VERSION`: `1.70`
- `frontend/index.html`: `?v=1.70`
- `MANUAL.md`: タイムライン表記とリサイズ機能の説明を反映。
