# Photo Manager v3.1.0 Release Notes

- **Tag**: `v3.1.0`
- **Title**: `Photo Manager v3.1.0 - Filter Trail Indicators, Chip Click-to-Jump & UI Polish`
- **Date**: `2026-10-28`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v3.1.0diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけで更新できます（`cache/`・`storage/`・`python/`・`models/` はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v3.1.0.zip`）**: ポータブル Python 同梱版を解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v3.1.0diff.zip`)**: Extract and overwrite your existing `PhotoManager` directory. `cache/`, `storage/`, `python/`, and `models/` remain untouched.

---

## 日本語 (Japanese)

### 新機能・UI / UX 改善 (Features & UI/UX Improvements)

- **複合フィルタの「道標（トレイル）」表示（全階層ツリー対応）**:
  親タグ（例: `オフ会`）やカメラ機種、フォルダ、年、国・都道府県、`▸ カラー` パレットなどを折りたたんだ際、親自身は選択していないが配下の子・孫項目でフィルタ（`+` 含む / `−` 除外）が適用されている状態を視覚的に区別して表示する「道標（トレイル）」機構を導入しました。
  - 親の背景はベタ塗りせず（親全体の選択と誤認させない設計）、**破線ボーダー ＋ 左端 3px のカラーエッジ ＋ 開閉矢印（`▶`/`▼`）の着色 ＋ 右端の `+1` / `−1` ミニバッジ**を表示します。
  - タグ階層ツリー、カラーパレット折りたたみヘッダー、タグ種別セグメント（`手動 / AI / すべて`）、カメラ＞レンズ階層ツリー、撮影年月ツリー、撮影地ツリー、フォルダツリーの全6箇所で連動します。
- **左端アイコンバー（垂直タブレール）の通知ランプ強化**:
  各カテゴリ（フォルダ / タグ / ジオタグ / 年月 / 機材）にフィルタが適用されている際、非アクティブなタブでも発光ドットと枠・背景のほのかな強調が表示され、複合フィルタの適用カテゴリが一目で把握できるようになりました。
- **個別フィルタチップの「クリックで該当箇所へジャンプ」機能**:
  左サイドバー上部に並ぶアクティブフィルタチップのラベル部分をクリックすると、該当するサイドバータブを自動で開き、折りたたまれている親階層を自動展開して対象項目までスクロール＆パルス発光でハイライト表示します（「解除」ではなく「隣のタグや前後の月へ条件を変更したい」ときに即座にアクセス可能。右端の `×` で従来通り個別解除）。
- **「フィルタ全解除」ボタンの一本化と状態連動カラーリング**:
  重複していた小さな「すべて解除」ボタンおよび不要なサイドバー閉じるボタン（`<`）を撤去して視線動線を整理し、最上部の「**フィルタ全解除**」ボタンへ一本化しました。全件表示時は他のボタンと同様に無着色とし、**何らかのフィルタが掛かっている時のみアクセントカラーで着色**します。
- **インスペクタのミニビュー改善 ＆ 全画面ツールチップ・マニュアル整合性統一**:
  - 右インスペクタのミニビューから不要な下部オーバーレイ表示を撤去し、ホバー説明とクリック動作を「**ダブルクリックでライトボックスを開く**」に統一しました。
  - アプリ全体のホバーツールチップ（`title`）、ショートカット案内、アプリ内ヘルプ（`#helpModal`）、`MANUAL.md`、および英語UI翻訳辞書（`i18n.js`）を総点検し、表記揺れを解消しました。

---

## English

### Features & UI/UX Improvements

- **Hierarchical Filter "Trail" Indicators Across All Trees**:
  When a parent item (parent tag, camera body, folder, year, country/prefecture, or the `▸ Color` expander) is collapsed while one or more of its descendant items are actively filtered (`+` Include or `−` Exclude), the parent row now displays a distinct **trail indicator** without filling its background (preventing confusion with selecting the parent itself):
  - Shows a **dashed colored border + 3px solid left edge + colored expander arrow (`▶`/`▼`) + compact `+1` / `−1` count badge** on the right.
  - Supported across all 6 hierarchical/collapsible filter areas: Tag Tree, Color Palette header, `Manual / AI / All` tag segment buttons, Camera & Lens Tree, Timeline Year/Month Tree, Geotag Location Tree, and Folder Tree.
- **Enhanced Filter Notification Lamps on Left Icon Rail**:
  Category tabs on the 54px left icon rail now display a glowing accent dot and subtle border/background highlight whenever a filter is active in that category.
- **Click-to-Jump on Active Filter Chips**:
  Clicking the label of any active filter chip at the top of the left sidebar automatically switches to the corresponding sidebar tab, expands any collapsed ancestor nodes, scrolls smoothly to the active item, and highlights it with a pulse animation—making it effortless to *modify* a filter condition (e.g., switch to a sibling tag or adjacent month) rather than just removing it (`×` still removes the individual filter).
- **Streamlined "Reset Filters" Button with Active-State Coloring**:
  Removed the redundant small "Clear All" button and sidebar `<` button, consolidating filter reset into the top **Reset Filters (`フィルタ全解除`)** button, which remains uncolored in All Photos view and lights up in the accent color only when one or more filters are active.
- **Inspector Mini-View Cleanup & Tooltip / Manual Audit**:
  - Removed the redundant bottom overlay on the Inspector mini-view and unified its behavior and tooltip to **"Double-click to open Lightbox"**.
  - Audited and synchronized all hover tooltips (`title`), keyboard shortcut descriptions, the in-app Help modal (`#helpModal`), `MANUAL.md`, and the English translation dictionary (`i18n.js`).
