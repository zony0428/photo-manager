# TETHERACT pm v1.8.10 Release Notes

- **Tag**: `v1.8.10`
- **Title**: `TETHERACT pm v1.8.10 - Automatic Tag Synchronization on Burst/Bracket/Duplicate Stack Formation`
- **Date**: `2026-11-14`

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
> - **既存環境（軽量差分版 `Tetheract_v1.8.10diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.10diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.10diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.10.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.10diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.10diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. バースト・ブラケット・重複スタックおよびRAW+JPEGペア編成時の既存タグ自動同期（v1.8.10）
- **外部レタッチ画像や後から合流したスタックメンバーへのタグ自動引き継ぎ（`server/database/stacks.py`）**:
  - すでにタグが付与されている写真をテイクアウトして外部アプリでレタッチし、元フォルダ（管理下）へ戻してスキャンした際、同一撮影日時・別ファイルサイズの画像として連写バースト（`burst`）に編成されるものの、元画像のタグがレタッチ後画像へ反映されなかった問題を修正しました。
  - スタック再計算時（連写 `burst`・露出ブラケット `bracket`・同一フォルダおよび別フォルダ間の RAW+JPEG ペア・重複スタック `duplicate`）に、グループ内の既存メンバーが保持しているタグ（親・祖先階層タグを含む）を全メンバーへ自動マージ同期するよう改善しました。
  - これにより、レタッチ後の画像や後から追加されたペア画像がスタック代表（`is_stack_primary = 1`）になった場合でも、タグ絞り込み検索から漏れることなく確実にヒットします。また、過去にバースト編成済みでタグが未反映だった画像も、フォルダの再スキャン（リフレッシュ）によって自動的にタグが補完されます。
- **スタック再計算・代表写真切り替え時の一覧キャッシュ即時無効化（`server/database/stacks.py`）**:
  - スタック再計算および `set_stack_primary` による代表写真切り替え完了時に高速レスポンスキャッシュを即時無効化し、変更直後の一覧・タグ検索へ即座に反映されるようにしました。

### 2. ドキュメント整備（v1.8.10）
- **GitHub README（日本語版・英語版）の最新仕様同期（`README.md` / `README_EN.md`）**:
  - 4つの設計原則（4本の柱）および v1.8 系の最新機能仕様に合わせてドキュメントを更新しました。

---

## English

### 1. Automatic Tag Synchronization Across Burst, Bracket, Duplicate Stacks & RAW+JPEG Pairs (v1.8.10)
- **Automatic Tag Inheritance for Retouched Photos & Newly Joined Stack Members (`server/database/stacks.py`)**:
  - Fixed an issue where taking out a tagged photo, retouching it in an external editor, and placing it back into a managed folder grouped the retouched file into a `burst` stack with the original photo (matching capture timestamp with a different file size) without inheriting the original photo's tags.
  - During stack recalculation (`burst`, `bracket`, intra-folder and cross-folder RAW+JPEG pairs, and `duplicate` stacks), existing tags (including ancestor hierarchy tags) held by any member in the group are now automatically merged and synchronized across all members in the group.
  - This ensures that even when a retouched image becomes the stack primary (`is_stack_primary = 1`), the stack remains searchable by its tags. Existing stacks with unsynchronized tags are also automatically repaired upon folder refresh.
- **Immediate Fast Cache Invalidation on Stack Recalculation & Primary Switching (`server/database/stacks.py`)**:
  - Added immediate response cache invalidation upon completing stack recalculation and switching stack primary photos (`set_stack_primary`).

### 2. Documentation Updates (v1.8.10)
- **Updated Japanese & English GitHub READMEs (`README.md` / `README_EN.md`)**:
  - Updated project documentation to reflect the Four Design Pillars and the latest v1.8 feature set.
