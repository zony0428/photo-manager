# TETHERACT pm v1.1.0 Release Notes

- **Tag**: `v1.1.0`
- **Title**: `TETHERACT pm v1.1.0 - Multi-SD Card VSN Management, Metadata Inheritance, Calendar & AI Color Re-Tagging`
- **Date**: `2026-11-01`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.1.0diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.1.0.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.1.0diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 複数SDカード・外部メディアの個体識別（VSN）＆ 登録メディア一覧
- **同一ドライブ文字での複数SDカード独立管理**: ボリュームシリアル番号（VSN）により、同じドライブ文字（例：`E:\DCIM`）で複数のSDカードを入れ替えてスキャンしても混ざらずに個別管理されます。
- **登録メディア一覧モーダル ＆ クイック絞り込み**: 左サイドバー `フォルダ` 上部の「登録メディア」および「メディア一覧」から、全メディアの接続状態・枚数・撮影期間・使用カメラを一覧確認し、ワンクリックで絞り込み・除外・登録解除が行えます。
- **識別名（ニックネーム）とボリュームラベル設定**: メディアごとにアプリ内ニックネーム（日本語可・非破壊）を設定可能。希望する場合は確認用4桁PIN承認付きで物理ボリュームラベル（半角ASCII 11文字以内）の書き込みにも対応しています。

### 2. SDカードからPC移動時の全メタデータ自動引き継ぎ ＆ クラウドパス追従
- **全メタデータ・サムネイルの自動引き継ぎ**: SDカード上で先に付与した評価・タグ・非破壊調整（回転・傾き・トリミング・トーン）・日時シフト補正・スマホGPS準用・調整済みサムネイルが、後からPCの別フォルダへファイルを移動・コピーしてスキャンした際にも自動で引き継がれます（RAW+JPGペアからRAW単体のみ移動した場合にも対応）。
- **クラウド同期フォルダの別PC間追従**: Google Drive / OneDrive / iCloud Drive / Dropbox 等の同期フォルダも、相対パス照合により別PC間で自動追従します。

### 3. 撮影カレンダー表示 ＆ 年月・日付のOR結合フィルタ
- **月間ミニカレンダー ＆ 拡大フォトカレンダー**: 左サイドバー `年月` にカレンダー表示を追加。拡大カレンダーでは日別の代表写真サムネイル・撮影枚数・優枚数・撮影地を確認しながら、複数年・複数月・特定日のOR組み合わせで絞り込めます。

### 4. AIカラータグ（12色）の単独再判定 ＆ 階層タグ整合性の改善
- **AIカラータグのみの再判定**: 写真・フォルダの右クリックメニューおよびインスペクタに「AIカラータグを再判定」を追加。手動タグやAI被写体タグを保護したまま、12色のAIカラータグのみを再判定・更新できます。あわせてAIタグ埋め込み辞書（`tags_embeddings.json`）の起動時自動同期を追加しました。
- **階層タグの親・祖先レコード自己修復**: タグのリネーム・階層移動時やAIタグ昇格時に親階層のレコードを自動補完し、起動時にも欠損した親タグ行を自己修復するよう改善しました。これにより親タグ除外 `[-]` 時に子孫タグを持つ写真が確実に除外されます。

---

## English

### 1. Multi-SD Card & External Media Isolation (VSN) & Managed Media List
- **Multi-SD Card Isolation on the Same Drive Letter**: Tracks Volume Serial Numbers (VSN) so multiple SD cards scanned on the same drive letter (e.g., `E:\DCIM`) are managed separately without path collisions.
- **Managed Media List & Quick Filtering**: View connection status, photo counts, capture date ranges, and camera models for all registered SD cards and drives from "Registered Media" / "Media List" in the Folders sidebar, with one-click filtering, exclusion, and unmanaging.
- **Custom Nicknames & Volume Label Writing**: Assign non-destructive in-app nicknames (Unicode supported) to each media volume, or optionally write an 11-char ASCII physical volume label with 4-digit PIN approval.

### 2. Full Metadata Inheritance When Moving from SD to PC & Cloud Drive Tracking
- **Automatic Metadata & Thumbnail Inheritance**: Ratings, tags, non-destructive edits (rotate, tilt, crop, tone), shifted timestamps, copied phone GPS, and adjusted thumbnails applied on an SD card automatically carry over when files are moved or copied to a PC folder (including when moving only the RAW file from a RAW+JPG pair).
- **Cross-PC Cloud Folder Resolution**: Automatically resolves relative paths across PCs for Google Drive, OneDrive, iCloud Drive, and Dropbox folders.

### 3. Shooting Calendar View & Multi-Date OR Filtering
- **Mini Calendar & Expanded Photo Calendar**: Added a monthly mini calendar and expanded photo calendar modal (displaying daily representative thumbnails, shot counts, Ex counts, and locations) under the Date sidebar tab, supporting flexible OR filtering across years, months, and specific dates.

### 4. AI Color Tag (12-Color) Re-Evaluation & Hierarchical Tag Integrity
- **Re-evaluate AI Color Tags Only**: Added "Re-evaluate AI Color Tag" to photo/folder context menus and the Inspector to re-judge only the 12 dominant color tags while preserving manual and AI subject tags. Also added automatic startup sync for `tags_embeddings.json`.
- **Hierarchical Tag Ancestor Self-Healing**: Automatically ensures parent/ancestor tag records during tag renames, moves, AI tag promotions, and startup checks so excluding `[-]` a parent tag reliably excludes all descendant photos.
