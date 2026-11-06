# Photo Manager v3.2.0 Release Notes

- **Tag**: `v3.2.0`
- **Title**: `Photo Manager v3.2.0 - Floating Natural-Language Filter Bar, Hierarchical OR/AND Tag Search & Natural Sorting`
- **Date**: `2026-10-29`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v3.2.0diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけで更新できます（`cache/`・`storage/`・`python/`・`models/` はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v3.2.0.zip`）**: ポータブル Python 同梱版を解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v3.2.0diff.zip`)**: Extract and overwrite your existing `PhotoManager` directory. `cache/`, `storage/`, `python/`, and `models/` remain untouched.

---

## 日本語 (Japanese)

### 新機能・UI / UX 改善 (Features & UI/UX Improvements)

- **階層タグの論理検索（同一第1階層グループ内 OR ＋ 異グループ間 AND ＋ `[-]` 除外引き算）**:
  - 最上位の親（第1階層）が同じタグ同士（例: `車/Toyota` と `車/Mazda/Roadster`）を複数 `[+]` 選択した際は **OR 条件（または）** で結合し、異なる親グループ間（例: `車/...` と `季節/秋`）や単体タグ同士は **AND 条件（かつ）** で結合するよう検索エンジンを刷新しました。
  - 大まかに親タグを `[+]` で選んだあと、不要な子タグだけ右クリックで `[-]`（除外）にすることで、「プリウス以外のトヨタ車 ＋ ロードスター ＋ CX-5」のような引き算抽出が直感的に行えます。
- **フローティング・自然文フィルタフッターバー ＆ クイック変更ポップオーバー**:
  - 写真グリッドの表示位置を上下にずらすことなく、画面下部にフローティングのフィルタフッターバーを表示し、現在の絞り込み条件を「`車: Toyota または Mazda/CX-5 （除く: − Toyota/Prius） かつ 年月: 2025年10月`」のように自然な日本語（英語モード時は英語）の条件文として表示します。
  - 条件ピルの左クリック（または文節内の `+` ボタン）でその場にクイック変更ポップオーバーが開き、左サイドバーを開かなくても同グループの子タグの追加・除外、全年の同月一括選択、評価・種別の切り替え、または左サイドバー該当箇所へのジャンプが行えます。
  - 条件ピルの右クリックで「含む `[+]`」と「除外 `[-]`」をその場で反転できます。
- **全ツリーの自然順ソート（Natural Sort）統一と左右ペイン独立ソート切替**:
  - フォルダツリー、カメラ・レンズ階層、タグ一覧、ジオタグの並び順を自然順（文字列内の数値を整数比較する辞書順）に統一しました。
  - 左サイドバーのタグ一覧と右インスペクタのタグ付与ツリーそれぞれに独立した「名前順 / 枚数順」切替ボタンを設け、絞り込み側とタグ付け側で別々の並び順を維持できるようにしました。
- **モバイル UI の視覚ノイズ整理・フィルタ同期 ＆ 接続トラブルシューティング案内**:
  - スマホ画面（LAN 連携および USB オフライン単体 HTML）からも色付き絵文字を排除して単色 SVG アイコンへ統一し、PC 側と同じ階層タグの OR/AND/除外検索および自然順ソートを同期しました。
  - スマホ連携モーダルおよび操作マニュアルに、Wi-Fi 経由で接続できない場合の確認手順（Windows プライベートネットワーク設定・ファイアウォール許可・ゲスト SSID 確認）を追加しました。
- **README・スクリーンショット・操作ワークフローアニメーションの刷新**:
  - `README.md` / `README_EN.md` のスクリーンショットを現行 UI に更新し、片手レーティング選別からライトボックス拡大、連写コマ送り、2枚比較・波形比較までを収録したワークフローアニメーションを追加しました。

---

## English

### Features & UI/UX Improvements

- **Hierarchical OR / AND Tag Search with `[-]` Exclusion Subtraction**:
  - Sub-tags sharing the same top-level parent (e.g., `Car/Toyota` and `Car/Mazda/Roadster`) now combine with **OR** logic, while tags from different top-level groups (e.g., `Car/...` and `Season/Autumn`) combine with **AND** logic.
  - You can include a broad category with `[+]` and right-click specific child tags to exclude `[-]` them (e.g., "all Toyota cars except Prius, plus Roadster and CX-5").
- **Floating Natural-Language Filter Footer Bar & Quick-Edit Popover**:
  - Active filters now appear in a floating footer bar at the bottom of the viewport without shifting the photo grid vertically, rendering active conditions as a natural sentence.
  - Left-clicking any condition pill (or its `+` button) opens an inline popover to add/exclude sibling tags, select the same month across all years, switch ratings/formats, or jump to the sidebar tree without opening the left panel.
  - Right-clicking a condition pill toggles between Include `[+]` and Exclude `[-]` in place.
- **Natural Sorting Across All Trees & Independent Left/Right Tag Sort Toggles**:
  - Unified Folder, Camera & Lens, Tag, and Geotag trees to use natural alphanumeric sorting.
  - Added independent "Name / Count" sort toggle buttons to both the left sidebar tag list and the right Inspector tag tree.
- **Mobile UI Visual Cleanup, Filter Sync & Connection Troubleshooting Guide**:
  - Replaced colorful emojis in the Mobile UI with monochrome SVG icons and synchronized the hierarchical OR/AND/Exclude tag filter logic and natural sorting with the desktop app.
  - Added step-by-step troubleshooting guidance for LAN mobile connection (Windows Private network profile, firewall rule, and guest SSID isolation) to the Mobile modal and `MANUAL.md`.
- **Updated Screenshots & Animated Workflow Demo in README**:
  - Refreshed all screenshots in `README.md` / `README_EN.md` and added an animated workflow walkthrough covering one-handed rating, layout/theme switching, RAW Lightbox, burst frame flipping, and 2-Up Duel comparison with RGB histograms.
