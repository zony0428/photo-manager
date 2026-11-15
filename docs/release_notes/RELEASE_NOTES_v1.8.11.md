# TETHERACT pm v1.8.11 Release Notes

- **Tag**: `v1.8.11`
- **Title**: `TETHERACT pm v1.8.11 - Pinpoint Folder Diff Refresh & Unmanaged Folder Isolation Fix`
- **Date**: `2026-11-15`

---

> [!CAUTION]
> **【重要】v1.7.0 以降を起動すると、旧バージョン（v1.6.1以前）との後方互換性がなくなります（特に差分アップデートの場合）**
>
> - **v1.7.0 以降で一度でも起動したデータベース（`cache/library.db`）には新しいセキュリティ＆エシカル保護スキーマが自動適用されるため、それ以降は v1.6.1 以前の旧バージョンでは起動できなくなります。**
> - 万が一 v1.6.1 以前へ戻す可能性がある場合は、アップデート前にあらかじめ `cache/library.db` を別場所へコピーしてバックアップしておくことを推奨します。
>
> **[IMPORTANT] Launching v1.7.0+ Removes Backward Compatibility with Older Versions (v1.6.1 or Earlier)**
> - Once launched in v1.7.0+, `cache/library.db` is upgraded to the new security & ethical protection schema and **can no longer be opened or launched by v1.6.1 or earlier**.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.8.11diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.11diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.11diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.11.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.11diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.11diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. フォルダ差分リフレッシュのピンポイント高速化 ＆ 全件再走査の解消（v1.8.11）
- **変更ディレクトリ・変更ファイルのみを対象とするピンポイント差分更新（`server/folder_diff.py` / `server/app.py` / `frontend/js/media_volumes.js` / `frontend/js/folder_tree.js`）**:
  - 数万枚の写真を抱える管理フォルダをクリックして「数枚の差分あり」と検出された際、「リフレッシュ（最新化）」を押すと配下の全サブフォルダ再列挙・全件 `os.path.exists` 照合・全フォルダのスタック再計算が走り、数万枚規模のフルスキャンになっていた不具合を解消しました。
  - `check_folder_diff` が特定した「実際に増減・更新のあったディレクトリ」「新規追加されたサブフォルダ」「削除されたフォルダ」のみをピンポイントで処理する `refresh_folder_diff`（`/api/scan` の `diff_only: true`）を新設し、無変更サブフォルダへのアクセスおよび未変更ファイルのオープンを完全にスキップします。
  - 進捗モーダルも実際に処理が必要な変更ファイル数（例: `42枚`）のみを分母として表示し、スタック再計算・Exifなし画像統合・レンズ名補完も変更が発生したディレクトリだけに限定して高速完了します。
- **通常スキャン（`scan_directory`）自体の単一パス `os.scandir` 化と未変更ファイル事前除外（`server/scanner.py` / `server/database/photos.py` / `server/database/stacks.py`）**:
  - 明示的なフルスキャン実行時にも `os.scandir` の `DirEntry.stat` でサイズ・更新日時を同時取得して未変更ファイルをメモリ上で事前除外し、消失リンク整理での重複 `os.path.exists` 呼び出しを廃止しました。

### 2. 上位コンテナ親フォルダ・ドライブルートでの「未登録フォルダ巻き込みスキャン」防止（v1.8.11）
- **管理下スコープと通り道フォルダ・直下限定ルートの厳密分離（`server/database/schema.py` / `server/database/folders.py` / `server/folder_diff.py`）**:
  - 一部のサブフォルダのみを管理登録している上位親フォルダやドライブルートを選択した際、同じ階層に同居している未登録（`[未登録]`）の別フォルダ群を「新規追加された子フォルダ」と誤判定し、リフレッシュ実行時に配下の未登録フォルダまで全件再帰スキャンしてしまっていた問題を修正しました。
  - `scan_roots` に再帰登録フラグ（`is_recursive`）を記録し、通り道の上位コンテナ親フォルダやドライブルート、および「直下のみ（非再帰）」で登録されたフォルダでは未登録の兄弟・子フォルダを差分検知やリフレッシュの対象へ一切巻き込まないよう保護しました（配下の再帰管理ルート内部で増えた新規サブフォルダのみを正確に検知します）。
  - 時間上限により新規サブフォルダ内の枚数プレビュー集計を途中打ち切りした場合は、確認ダイアログの枚数表示に `+` を付記して正確な状態を伝えるよう改善しました。

---

## English

### 1. Pinpoint Folder Diff Refresh & Elimination of Unnecessary Full Rescans (v1.8.11)
- **Targeted Diff Refresh Only on Dirty Directories & Changed Files (`server/folder_diff.py` / `server/app.py` / `frontend/js/media_volumes.js` / `frontend/js/folder_tree.js`)**:
  - Fixed an issue where clicking "Refresh" on a large managed folder (e.g., 50,000+ photos) after detecting a small diff (e.g., 42 files) triggered a full recursive rescan, re-checking file existence and recalculating stacks across all unchanged subfolders.
  - Introduced `refresh_folder_diff` (`diff_only: true` on `/api/scan`), which processes strictly the directories with actual file additions/modifications/deletions, newly added managed subfolders, and removed folders—skipping unchanged subfolders and unchanged files entirely.
  - Scan progress now reports only the actual number of changed/added files to process, and scopes stack recalculation, EXIF-less deduplication, and lens backfilling strictly to affected directories.
- **Single-Pass `os.scandir` & In-Memory Unchanged Filtering in `scan_directory` (`server/scanner.py` / `server/database/photos.py` / `server/database/stacks.py`)**:
  - Upgraded standard directory scans to reuse `DirEntry.stat` metadata in a single pass, pre-filter unchanged files in memory without opening files, and reuse enumerated path sets during orphan link cleanup.

### 2. Prevention of Unmanaged Sibling Folder Drag-In on Container Parents & Drive Roots (v1.8.11)
- **Strict Scope Isolation Between Recursive Scan Roots, Pass-Through Parents & Direct-Only Roots (`server/database/schema.py` / `server/database/folders.py` / `server/folder_diff.py`)**:
  - Fixed a bug where selecting a pass-through parent folder or drive root containing both managed subfolders and unmanaged (`[Unmanaged]`) sibling folders falsely treated unmanaged folders as newly added subfolders and recursively scanned all files across unmanaged directories on refresh.
  - Persisted `is_recursive` registration scope in `scan_roots` so pass-through container folders, drive roots, and non-recursive (`recursive=False`) roots never pull in unmanaged sibling or child folders, while still accurately detecting new subfolders created inside descendant recursive scan roots.
