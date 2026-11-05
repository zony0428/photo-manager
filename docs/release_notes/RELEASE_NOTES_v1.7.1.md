# TETHERACT pm v1.7.1 Release Notes

- **Tag**: `v1.7.1`
- **Title**: `TETHERACT pm v1.7.1 - Ethical Mode False-Lock Fix, Non-Destructive DB Lock & Weekly Backup Reminder`
- **Date**: `2026-11-05`

---

> [!CAUTION]
> **⚠️【重要】v1.7.0 以降を起動すると、旧バージョン（v1.6.1以前）との後方互換性がなくなります（特に差分アップデートの場合）**
>
> - **v1.7.0 以降で一度でも起動したデータベース（`cache/library.db`）には新しいセキュリティ＆エシカル保護スキーマが自動適用されるため、それ以降は v1.6.1 以前の旧バージョンでは起動できなくなります。**
> - 特に既存環境へ**軽量差分版（`Tetheract_v1.7.1diff.zip`）を上書きして `Tetheract.exe` を起動した場合**、既存の `cache/library.db` がそのまま v1.7.0+ 仕様へ更新されるため、後から旧バージョンの実行ファイルだけを上書きで戻しても起動しなくなります。
> - 万が一 v1.6.1 以前へ戻す可能性がある場合は、アップデート前にあらかじめ `cache/library.db` を別場所へコピーしてバックアップしておくことを推奨します。
>
> **⚠️ [IMPORTANT] Launching v1.7.0+ Removes Backward Compatibility with Older Versions (v1.6.1 or Earlier)**
> - Once launched in v1.7.0+, `cache/library.db` is upgraded to the new security & ethical protection schema and **can no longer be opened or launched by v1.6.1 or earlier** (especially when overwriting an existing installation with `Tetheract_v1.7.1diff.zip`).

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.7.1diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`Loome/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.7.1.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.7.1diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. Lv.0 エシカルモードの誤ロック修正・DB非破壊オンメモリロック・自己修復 ＆ 大容量DB起動高速化
- **旧版（v1.6.1以前）の正規バックアップDBや別DBを差し替えた際の誤ロック修正**:
  - 一度 v1.7.0 を起動して `Loome/.loome_seal` が作成された環境に対し、v1.6.1 以前の正規バックアップDB（`security_meta` 未作成）を戻して起動した際や、テスト等で複数のDBを差し替えた際に「他環境のDB」と誤判定されてエシカル保護ロック（`423 Locked`）がかかってしまう不具合を修正しました。
  - ポータブルドライブ（`C:` 以外）で稼働している場合、またはDB内の管理フォルダ（`scan_roots`）・写真パス・接続中ドライブのVSNが現在の環境に1つでも実在する場合は、正当な自環境DBとして即座にペアリングします。
- **他環境DB検知時の元DBファイル完全非破壊化（オンメモリロック）＆ 自己修復**:
  - 未シールDBが別環境由来と判定された場合でも、DBファイル自体に空のペアリング情報（`bound_instances: "{}"`）を書き込んで永続汚染しないよう、オンメモリのみでロック状態を保持する方式へ変更しました。
  - また、v1.7.0 で誤って空の `bound_instances` が書き込まれてしまった Lv.0 DB についても、起動時に自動で自己修復・再ペアリングしてそのまま開けるようにしました。
- **Lv.0 自動ペアリング範囲の拡大（`.loome_seal` 履歴 ＆ `recovery_key.txt` 自動照合）**:
  - 本体 `Loome/.loome_seal` 内の `previous_seals` 履歴およびローカルの `cache/recovery_key.txt` を起動時に自動照合し、同じ環境内でバックアップDBを戻した際にロック画面を出さずに自動再ペアリングするよう強化しました。
- **大容量DB（数百MB〜1GB超）読み込み時の起動高速化**:
  - 未シールDBの初回読み込み時に毎回実行されていた全量ファイルコピー（`library_pre_v170_security_*.db` 生成）を廃止し、ポータブルSSD/USB上の約1GBのDBでも数分間待たされることなく即座に起動するよう改善しました。

### 2. 起動時の定期バックアップ警告モーダル（1週間未実施リマインド）＆ DBバックアップの高速コピー化（Win32 `CopyFileExW`）
- **DBバックアップの超高速化（`WAL` 完全フラッシュ ＋ Win32 `CopyFileExW` カーネルコピー）**:
  - 従来の SQLite `backup()` API による 4KB ページ単位の細切れ書き込みから、**`PRAGMA wal_checkpoint(TRUNCATE)` による WAL 完全フラッシュ ＋ 書き込み排他ロック下の Win32 `CopyFileExW` 大ブロック一括転送**へ刷新しました（万一別スレッドがビジーな場合のみ Online Backup API に自動フォールバック）。約 900MB の大型DBでも、外付けドライブ上で数分かかっていたバックアップが約十数秒（約15倍高速）で完了します。
- **1週間（7日）バックアップ未実施時の起動時リマインド**:
  - ライブラリに写真が登録されており、前回の手動バックアップ（`cache/backups/library_backup_*.db`）から **7日（1週間）以上経過している場合**（またはライブラリ運用開始から7日以上一度もバックアップが作成されていない場合）、アプリ起動時に確認モーダルを表示します。
  - モーダル内で **「現在の登録データ枚数・DBサイズ」「最終バックアップ日時」** を確認でき、**`[今すぐバックアップを作成 (Enter)]`** を押すだけで設定画面を開かずにその場で最新のオンラインバックアップと復旧キー（`recovery_key.txt`）を作成できます（`[あとで (Esc)]` を選んだ場合は当日中は再表示しません）。
- **外部保管（別ドライブへの退避）対象ファイルの案内とワンクリックでフォルダを開く導線**:
  - ポータブルSSDやUSBメモリ自体の物理故障・紛失に備え、どのファイルを別ドライブやPC本体へコピーして保管しておけばよいか（`cache/backups/` 内の最新 `library_backup_*.db` と `recovery_key.txt`、または `cache/library.db`）をモーダル内に明示し、**`[📂 保存先フォルダを開く]`** ボタン（およびバックアップ作成完了直後の案内モーダル）からワンクリックで Windows エクスプローラーを開けるようにしました。
- **設定モーダルのホバー説明ツールチップ化 ＆ セキュリティレベル別動的ガイド**:
  - 設定画面の各項目見出しにマウスオーバーで説明がふわっと表示されるツールチップ（`ⓘ`）を導入して縦幅を省スペース化し、セキュリティ設定では選択中のレベル（Lv.0 / Lv.1 / Lv.2）に応じて保護内容の説明文が動的に切り替わるよう改善しました。

---

## English

### 1. Fix for Lv.0 Ethical Mode False-Positive Lock, Non-Destructive In-Memory Lock, Self-Healing & Fast Large-DB Startup
- **Fixed False-Positive Lock When Restoring v1.6.1 Backup DBs or Switching DBs**:
  - Fixed an issue where restoring an unsealed backup DB from v1.6.1 or earlier into an installation that already had `Loome/.loome_seal` caused it to be falsely flagged as a foreign DB (`423 Locked`).
  - Portable drive installations (`drive != C:`) and any DB whose `scan_roots`, photo paths, or connected physical drive VSNs exist on the current machine are now immediately recognized and paired as legitimate.
- **Non-Destructive In-Memory Lock & Automatic Self-Healing**:
  - When an unsealed DB is detected as foreign, Tetheract now holds the lock state strictly in memory without writing `bound_instances: "{}"` to the DB file, ensuring the original DB file is never modified or polluted.
  - Added automatic self-healing on startup for Lv.0 DBs that previously had an empty `bound_instances` written to them in v1.7.0, as well as automatic Lv.0 re-pairing via `previous_seals` in `.loome_seal` and local `cache/recovery_key.txt`.
- **Instant Startup for Large (~1GB+) Unsealed Databases**:
  - Removed the redundant full-file copy (`library_pre_v170_security_*.db`) during security initialization so multi-hundred-MB / 1GB+ portable databases launch immediately without multi-minute I/O stalls.

### 2. Startup Weekly Database Backup Reminder Modal, High-Speed `CopyFileExW` DB Backup & Compact Settings Tooltips
- **High-Speed Database Backup (`WAL` Checkpoint + Win32 `CopyFileExW`)**:
  - Replaced page-by-page 4KB SQLite `backup()` writes with a full `PRAGMA wal_checkpoint(TRUNCATE)` flush followed by a write-locked Win32 `CopyFileExW` kernel copy (with automatic fallback to the SQLite Online Backup API if busy), speeding up backups of ~900MB portable databases by up to 15x.
- **7-Day Backup Reminder on Startup**:
  - When your library contains photos and **7 or more days** have passed since the last database backup (`cache/backups/library_backup_*.db`), Tetheract displays a confirmation modal on startup showing your current library photo count, DB size, and last backup timestamp.
  - Press **`Backup Now (Enter)`** to immediately create a fresh online backup alongside `recovery_key.txt` without opening the Settings dialog (choosing `Later (Esc)` snoozes the reminder for the rest of the day).
- **One-Click Explorer Link & Off-Drive Backup Guidance**:
  - Clearly highlights which files should be copied to another drive or PC (`library_backup_*.db` and `recovery_key.txt` inside `cache/backups/`, or `cache/library.db`) to protect against portable USB/SSD hardware failure, with an inline **`📂 Open Backup Folder`** button and a post-backup completion prompt to open the folder in Windows Explorer with a single click.
- **Compact Settings Modal Hover Tooltips & Dynamic Security Level Descriptions**:
  - Added hover tooltips (`ⓘ`) to Settings modal item captions for a cleaner, more compact layout, and dynamic description text that updates as you switch between Security Levels Lv.0, Lv.1, and Lv.2.
