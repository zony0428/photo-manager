# Photo Manager v3.2.1 Release Notes

- **Tag**: `v3.2.1`
- **Title**: `Photo Manager v3.2.1 - Interactive AND/OR Conjunction Toggles in Floating Filter Bar`
- **Date**: `2026-10-30`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v3.2.1diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけで更新できます（`cache/`・`storage/`・`python/`・`models/` はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v3.2.1.zip`）**: ポータブル Python 同梱版を解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v3.2.1diff.zip`)**: Extract and overwrite your existing `PhotoManager` directory. `cache/`, `storage/`, `python/`, and `models/` remain untouched.

---

## 日本語 (Japanese)

### 新機能・UI / UX 改善 (Features & UI/UX Improvements)

- **フローティング・フィルタフッターバーでの AND ⇄ OR 接続詞クリック切替**:
  - **同グループ内の OR ⇄ AND 切替**: 同じ第1階層親グループ内で複数の `[+]` タグを選んだ際、フッターバーの文節内にある **`[ または ⇄ ]`** ボタンをクリックすると、そのグループ内の結合条件を **`[ かつ ⇄ ]`（AND：すべて含む写真のみ）** と **`[ または ⇄ ]`（OR・既定：いずれかを含む写真）** の間でワンタッチで切り替えられます。
  - **異グループ間の AND ⇄ OR 切替**: 異なる親グループ（または単体タグ）を複数 `[+]` 選択した際、フッターバーのタグ文節同士の間にある **`[ かつ ⇄ ]`** ボタンをクリックすると、グループ間の結合条件を **`[ または ⇄ ]`（OR：いずれかのグループ条件に一致）** と **`[ かつ ⇄ ]`（AND・既定：すべてのグループ条件に一致）** の間でワンタッチで切り替えられます。
  - **ポップオーバー内の結合モード切替バー**: タグ条件ピルや `+` ボタンをクリックして開くクイック変更ポップオーバーの上部にも、`同グループ内の結合: [ または (OR) ] [ かつ (AND) ]` および `別グループとの結合: [ かつ (AND) ] [ または (OR) ]` の切り替えボタンを配置しました。
  - **フィルタプリセット保存・英語 UI 完全対応**: 切り替えたグループ内・グループ間の AND/OR 状態は「フィルタセット（プリセット）」にもそのまま保存・復元され、`JP ⇄ EN` 言語切替時にも連動して翻訳されます。

---

## English

### Features & UI/UX Improvements

- **Interactive AND ⇄ OR Conjunction Toggles in Floating Filter Footer Bar**:
  - **Intra-Group OR ⇄ AND Toggle**: When multiple `[+]` tags under the same top-level group are selected, clicking the **`[ or ⇄ ]`** button inside the clause box toggles that group between **OR (default: match any tag in the group)** and **AND (must match all selected tags in the group)**.
  - **Inter-Group AND ⇄ OR Toggle**: When multiple tag groups (or standalone tags) are selected, clicking the **`[ AND ⇄ ]`** button between tag clause boxes toggles inter-group evaluation between **AND (default: match all tag groups)** and **OR (match any tag group, while preserving per-group `[-]` exclusions)**.
  - **Quick-Edit Popover Logic Bar**: Added explicit `Within this group: [ OR ] [ AND ]` and `Between tag groups: [ AND ] [ OR ]` toggle buttons inside the tag quick-edit popover.
  - **Saved Filter Preset & Bilingual UI Support**: Custom intra-group and inter-group AND/OR modes are preserved when saving and applying filter presets and fully supported in both Japanese and English UI modes.
