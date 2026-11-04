# TETHERACT pm v1.6.1 Release Notes

- **Tag**: `v1.6.1`
- **Title**: `TETHERACT pm v1.6.1 - Selective Unlinked Photo Purge, Exifless Image Body Hash Deduplication & Footer Filter Stability`
- **Date**: `2026-11-04`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.6.1diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.6.1.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.6.1diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 「リンク情報なし（リンク消失の写真）」の選択削除 ＆ 絞り込み削除の強化
- **選択したリンク消失写真だけのDB完全消去**: 左サイドバー `Folder` の「リンク情報なし」一覧、または画面下部フッター三大フィルタの「リンク消失の写真」で絞り込んでいる際、一部の写真だけを選択して下部バー右端の「選択したリンク消失写真を完全消去 (N枚)」ボタン、右クリックメニュー「選択した写真をDBから完全消去」、または `Delete` キーでデータベースから完全に削除できるようになりました。
- **他フィルタ併用時の安全な「表示中のみ消去」**: 「リンク消失の写真」に評価（`棄` など）・タグ・ファイル形式などのフィルタを掛け合わせている状態で写真を未選択のまま消去ボタンを押した場合は、隠れている他のリンク消失写真を誤って消さないよう、現在絞り込み表示されている写真のみを対象（`表示中のリンク消失写真を完全消去 (N枚)`）として安全に消去します。

### 2. 実体ファイル不在写真の矛盾操作排除 ＆ リンクあり写真との混在選択時スキップ通知
- **実行不能な操作メニューの自動非表示・ガード**: リンク消失写真（実体ファイルなし）のみを選択している場合、`Loome` へのコピー／移動、スマート・テイクアウト、ベタ焼きHTML出力、非破壊画像調整・回転、トーン調整の貼り付け、クリップボードへの画像コピー、サムネイル再生成、AIカラータグ再判定、エクスプローラー起動など、実体ファイルを必要とする操作を右クリックメニューおよびインスペクタ上で非表示・無効化しました。
- **混在選択時の自動スキップとトースト通知**: 実体ファイルがある通常の写真とリンク消失写真を複数選択して上記の操作を実行した際は、実体のある写真だけを処理したうえで「（実体のない 〇〇 枚はスキップしました）」と分かりやすくトースト通知します。

### 3. Exif（撮影日時）欠落画像のサンプリングハッシュ同一認識 ＆ 既存DBの重複自動統合
- **ヘッダを避けた画像ボディサンプリング BLAKE2b ハッシュ (`content_key`)**: SNS保存画像やスクリーンショット、書き出し画像など Exif の撮影日時（`date_taken`）を持たない画像について、ファイルの更新日時（`mtime`）ではなく、先頭 4KB のヘッダ領域を避けた中間4箇所（20%・40%・60%・80% 位置から各 4KB）＋末尾 4KB ＋ ファイルサイズから高速な BLAKE2b 64-bit ハッシュを算出し、別フォルダへコピー・再スキャンしても分裂せず同一画像（複数 `photo_links`）として認識されるようになりました。
- **進捗・完了通知付きの自動マイグレーション＆統合**: 初回起動時およびフォルダスキャン時に、既存の Exif 欠落写真の識別キー更新と重複レコードの統合（タグ・高評価・非破壊調整・リンクの無損失マージ）を自動実行し、処理中・完了時にスプラッシュ画面やトースト通知で進行状況を明示します。

### 4. フッター三大フィルタの意図しない解除・競合の防止
- **ドロップダウン選択後の矢印キー誤作動防止**: フッターの「表示対象」「形式・状態」「並び順」ドロップダウンを選択した直後に自動でフォーカスを解除（`blur()`）し、そのまま矢印キー（`←` `→` `↑` `↓`）で写真一覧を移動してもドロップダウンが勝手に切り替わらないよう改善しました。
- **サイドバー操作時の「未分類の写真」維持 ＆ フォルダと「リンク消失」の排他切り替え**: フォルダ・撮影日・カメラ・場所を選択した際に「未分類の写真」スコープが勝手に解除されていた問題を修正し、またフォルダ選択中に「リンク消失の写真」を選んだ際（およびその逆）に0件にならないよう自動で排他切り替えを行います。

---

## English

### 1. Selective & Filtered Purge for Unlinked Photos
- **Selective Database Purge**: When viewing "Unlinked Photos" (via the `Folder` sidebar menu or the footer scope filter), you can now select specific unlinked records and permanently delete only those items using the bottom action button, the right-click context menu, or the `Delete` key.
- **Filter-Safe Subset Purge**: When combining "Unlinked Photos" with other filters (such as Rating `Reject`, Tags, or Format) without an explicit selection, the purge button targets only the currently displayed subset (`Purge N displayed unlinked photos`), protecting hidden unlinked records from accidental deletion.

### 2. Guarding File-Dependent Actions & Mixed-Selection Skip Notifications
- **Hiding Unavailable Actions on Unlinked Records**: File-dependent operations (`Loome` copy/move, Smart Takeout, Contact Sheet export, non-destructive adjustments/rotation, tone paste, clipboard image copy, thumbnail regeneration, AI color re-tagging, and opening in Explorer) are automatically hidden or disabled when only unlinked photos are selected.
- **Clear Skip Toast on Mixed Selections**: When a multi-selection contains both normal photos and unlinked photos, file-dependent batch operations process the valid photos and notify you with a toast (`Skipped N unlinked photo(s)`).

### 3. Body-Sampled BLAKE2b Hash Deduplication for Exifless Images
- **Header-Skipping Image Body Hash (`content_key`)**: Images lacking Exif capture timestamps (`date_taken`)—such as screenshots or downloaded images—now compute a fast 64-bit BLAKE2b hash sampled from four interior 4KB blocks (at 20%, 40%, 60%, and 80% offsets after skipping the first 4KB header) plus the last 4KB, preventing duplicate splitting when copied across folders regardless of file modification time (`mtime`).
- **Automated Migration & Deduplication with Progress Notifications**: Existing exifless records in `library.db` are automatically upgraded and merged (preserving all tags, highest ratings, adjustments, and `photo_links`) with explicit progress and completion notifications during startup and folder scans.

### 4. Footer 3-Main Filters Stability Improvements
- **Auto-Blur on Dropdown Change**: Selecting an option in the footer scope, format, or sort dropdowns now automatically blurs focus so subsequent Arrow key presses navigate the photo grid instead of unintentionally changing the dropdown filter.
- **Preserving "Untagged" Scope & Resolving Folder/Unlinked Conflicts**: Clicking folders, timeline dates, cameras, or locations no longer resets the "Untagged Photos" scope filter, and switching between a folder filter and "Unlinked Photos" cleanly resolves mutual exclusivity so results never unexpectedly drop to zero.
