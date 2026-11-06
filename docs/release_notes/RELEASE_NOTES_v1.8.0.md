# TETHERACT pm v1.8.0 Release Notes

- **Tag**: `v1.8.0`
- **Title**: `TETHERACT pm v1.8.0 - Local Clean Updater (diff.zip Auto-Apply), Root Directory Organization (tools/ & Loome/) & Autorun Setup Prompt`
- **Date**: `2026-11-06`

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
> - **既存環境（軽量差分版 `Tetheract_v1.8.0diff.zip`）**:
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.0diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
>   - **v1.8.0 導入後の次回アップデートから**: 次回以降はダウンロードした `Tetheract_v*diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
> - **初回導入（フル版 `Tetheract_v1.8.0.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.0diff.zip`)**: If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**. Starting from v1.8.0+, future updates can be applied cleanly simply by placing `Tetheract_v*diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. ローカル完結の「クリーン・アップデート」機構の実装（`Tetheract.exe`）
- **差分ZIP（`Tetheract_v*diff.zip`）の自動検知と古い不要ファイルの一掃**:
  - インターネット通信を一切行わない完全ローカル動作のまま、更新時に過去の廃止ファイルがフォルダ内に蓄積し続ける問題を解決しました。
  - v1.8.0 以降の `Tetheract.exe` と同じフォルダに `Tetheract_v*diff.zip` を（解凍せずに）置いて `Tetheract.exe` を起動すると、更新確認ダイアログを表示します。
  - 承認すると、ZIPアーカイブの正当性を事前検証し、稼働中のサーバーがあれば安全にシャットダウンさせたうえで、既存のプログラムフォルダ（`frontend/`・`server/`・`LICENSES/`・`tools/` および旧ルート残骸）を一度すべてクリーン削除してから最新ファイルを展開します。
  - ユーザーデータ（`cache/`・`Loome/`・`storage/`・`take_out/`・`.tetheract_instance`・`python/`・`models/`）には一切触れず、展開完了後は使用済みの `diff.zip` も自動で削除します。

### 2. 配布フォルダのルート階層整理（`tools/` 集約 ＆ `Loome/` 標準化）
- **トップ階層のスリム化と `tools/` フォルダへのツール集約**:
  - 配布パッケージのルート階層に露出していた自前コンパイル・予備起動用ファイル（`Build.bat`・`start.bat`・`Launcher.cs`）を **`tools/`** フォルダへ集約し、起動スクリプトを `server/run.py` に一本化しました（`tools/Build.bat` および `tools/start.bat` は `tools/` 内から直接実行しても自動的に親のアプリルートを認識して動作します）。
  - これにより、解凍直後のルート階層にある実行ファイルは **`Tetheract.exe`** ただ1つとなり、一般ユーザーにとって迷いのないフォルダ構成になりました。
  - 従来方式（ZIP解凍・上書きコピー）で v1.8.0 へ更新した環境でも、`Tetheract.exe` 起動時にルート直下の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` を自動で片付けます。
- **新規配布パッケージにおける `Loome/` および `take_out/` の標準化**:
  - 配布ビルド時に旧名称の空 `storage/` フォルダが生成されていた問題を修正し、標準保管庫 **`Loome/`** とスマート・テイクアウト出力先 **`take_out/`** が初期配置されるよう改善しました。

### 3. 初回起動時 ＆ アップデート完了時の `autorun.inf` 設置確認ダイアログ
- **ランチャー起動時の `autorun.inf` 生成サポート**:
  - これまで `Build.bat` 実行時にのみ提供されていた `autorun.inf`（エクスプローラーでの TETHERACT アイコンおよびラベル `TETHERACT pm` 表示設定）の作成確認を、`Tetheract.exe` 本体の初回起動時およびアップデート適用直後（`autorun.inf` 未設置時のみ）にダイアログからワンクリックで行えるよう改善しました。

---

## English

### 1. Local Clean Updater Built into `Tetheract.exe`
- **Automatic Detection of `Tetheract_v*diff.zip` & Obsolete File Cleanup**:
  - Solved the issue where deprecated `.py` / `.js` / `.css` files remained in user folders after manual ZIP overwrite updates, while maintaining 100% offline local operation.
  - Placing `Tetheract_v*diff.zip` (unextracted) into the app folder and launching `Tetheract.exe` (v1.8.0+) prompts a clean update confirmation.
  - Upon confirmation, `Tetheract.exe` validates the ZIP archive, gracefully stops any running local server on port 8088, completely removes old program directories (`frontend/`, `server/`, `LICENSES/`, `tools/`, and legacy root scripts), extracts the fresh files (including self-updating `Tetheract.exe`), and removes the used `diff.zip`—while leaving user data (`cache/`, `Loome/`, `storage/`, `take_out/`, `.tetheract_instance`, `python/`, `models/`) completely untouched.

### 2. Root Folder Organization (`tools/` Consolidation & Default `Loome/` Directory)
- **Clean Root Directory & `tools/` Folder**:
  - Moved self-compilation and fallback scripts (`Build.bat`, `start.bat`, `Launcher.cs`) into the **`tools/`** subfolder and unified the entry script into `server/run.py` (`tools/Build.bat` and `tools/start.bat` automatically resolve the parent app root when run).
  - **`Tetheract.exe`** is now the sole executable in the root directory. Existing installations updated via manual extraction also have legacy root files (`Build.bat`, `start.bat`, `run.py`, `launcher/`) automatically cleaned up on startup.
- **Standardized `Loome/` & `take_out/` Working Directories**:
  - Fixed the distribution builder creating an empty legacy `storage/` folder so that fresh installations start with **`Loome/`** and **`take_out/`** by default.

### 3. `autorun.inf` Setup Prompt on First Launch & After Updates
- **One-Click Drive Icon & Label Configuration**:
  - On first launch or right after applying an update, if `autorun.inf` is not yet present, `Tetheract.exe` asks whether to create `autorun.inf` to display the custom TETHERACT icon and `TETHERACT pm` label in Windows Explorer.
