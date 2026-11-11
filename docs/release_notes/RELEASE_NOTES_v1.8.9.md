# TETHERACT pm v1.8.9 Release Notes

- **Tag**: `v1.8.9`
- **Title**: `TETHERACT pm v1.8.9 - RAW+JPEG Pairing/Burst Stack Exclusion Fix & Multi-Select Common Tag Batch Removal`
- **Date**: `2026-11-12`

---

> [!CAUTION]
> **⚠️【重要】v1.7.0 以降を起動すると、旧バージョン（v1.6.1以前）との後方互換性がなくなります（特に差分アップデートの場合）**
>
> - **v1.7.0 以降で一度でも起動したデータベース（`cache/library.db`）には新しいセキュリティ＆エシカル保護スキーマが自動適用されるため、それ以降は v1.6.1 以前の旧バージョンでは起動できなくなります。**
> - 万が一 v1.6.1 以前へ戻す可能性がある場合は、アップデート前にあらかじめ `cache/library.db` を別場所へコピーしてバックアップしておくことを推奨します。
>
> **⚠️ [IMPORTANT] Launching v1.7.0+ Removes Backward Compatibility with Older Versions (v1.6.1 or Earlier)**
> - Once launched in v1.7.0+, `cache/library.db` is upgraded to the new security & ethical protection schema and **can no longer be opened or launched by v1.6.1 or earlier**.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.8.9diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.9diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.9diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.9.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.9diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.9diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. RAW+JPEG ペアおよび連写・ブラケットスタックにおける従属RAW除外の完全修正（v1.8.9）
- **スタック内サブコマ・全体一覧・サムネイル一括生成でのペア済みRAW除外（`server/database/photos.py` / `server/preload_thumbnails.py` / `frontend/js/app.js`）**:
  - RAW+JPEG 同時記録での連写・ブラケット撮影時に、JPEGとペア紐付け済みの従属RAWレコードがスタック内サブ写真（`stack_photos`）・詳細取得・未生成サムネイル走査へ混入していた問題を修正しました。
  - スタック展開時や単体モバイルHTML（`Tetheract_Mobile.html` / `frontend/js/mobile.js`）でのオフラインDB閲覧時にも、ペア済みRAWが重複カードや未生成黒カードとして現れず、常に正確な枚数と代表JPEGで表示されます。

### 2. 複数画像選択時の右ペイン「共通タグのみ `×` 一括削除」対応（v1.8.9）
- **一括編集インスペクタの上書き防止と共通タグ一括削除（`frontend/js/inspector.js` / `selection.js` / `folder_tree.js` / `mobile.js` / `server/app.py`）**:
  - 複数枚の画像を選択した際、遅延詳細取得コールバックによって単一写真インスペクタが上書き表示され、最初の1枚からしかタグが消えなかった不具合を解消しました。
  - 右ペインの付与済みタグバッジでは、**選択したすべての画像に共通するタグ**にのみ `×` ボタンを表示し、クリックすると複数選択を維持したまま全選択画像から一括削除できるよう改善しました（一部の画像のみに付いているタグは破線表示とし、誤削除防止のため `×` ボタンを非表示化）。
  - 単体・一括タグ更新時に `/api/photos` のレスポンスキャッシュを即時無効化し、タグ追加・削除直後のグリッド再取得へ確実に反映されるよう修正しました。

---

## English

### 1. Complete Fix for Paired RAW Exclusion in RAW+JPEG Pairs & Burst/Bracket Stacks (v1.8.9)
- **Excluded Paired Subordinate RAW Rows Across Stack Members, Photo Queries & Preload (`server/database/photos.py` / `server/preload_thumbnails.py` / `frontend/js/app.js` / `mobile.js`)**:
  - Fixed an issue where subordinate RAW rows already paired with a JPEG were included in `stack_photos` during RAW+JPEG burst/bracket shooting, standalone mobile `localdb` queries (`Tetheract_Mobile.html`), and background thumbnail preloading.
  - Stack counts, expanded stack views, and offline mobile views now consistently display only logical photos without duplicate or blank RAW cards.

### 2. Multi-Select Assigned Tag Badges: Batch Removal for Common Tags Only (v1.8.9)
- **Prevented Single-Photo Inspector Overwrite & Enabled Common-Only `×` Batch Deletion (`frontend/js/inspector.js` / `selection.js` / `folder_tree.js` / `mobile.js` / `server/app.py`)**:
  - Fixed a race condition where delayed detail fetches overwrote the multi-select batch inspector with a single-photo inspector, causing the tag `×` button to remove the tag from only the first photo.
  - In multi-photo selection, only tags **common to all selected photos** display the `×` button and remove the tag from all selected photos at once while keeping the selection active; partial tags (`M/N`) are shown with a dashed border without a `×` button to prevent accidental removal.
  - Added immediate `/api/photos` response cache invalidation on single and batch tag updates.
