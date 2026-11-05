# TETHERACT pm v1.7.0 Release Notes

- **Tag**: `v1.7.0`
- **Title**: `TETHERACT pm v1.7.0 - Three-Tier Security & Ethical Protection (Lv.0 / Lv.1 / Lv.2), Foreign Loome Guard & Self-Healing Key Salvage`
- **Date**: `2026-11-05`

---

> [!CAUTION]
> **⚠️【重要】一度 v1.7.0 を起動すると、旧バージョン（v1.6.1以前）との後方互換性がなくなります（特に差分アップデートの場合）**
>
> - **v1.7.0 以降で一度でも起動したデータベース（`cache/library.db`）には新しいセキュリティ＆エシカル保護スキーマが自動適用されるため、それ以降は v1.6.1 以前の旧バージョンでは起動できなくなります。**
> - 特に既存環境へ**軽量差分版（`Tetheract_v1.7.0diff.zip`）を上書きして `Tetheract.exe` を起動した場合**、既存の `cache/library.db` がそのまま v1.7.0 仕様へ更新されるため、後から旧バージョンの実行ファイルだけを上書きで戻しても起動しなくなります。
> - 初回起動時に移行前のバックアップ（`cache/backups/library_pre_v170_security_<日時>.db`）が自動保存されますが、アップデート前に念のため `cache/library.db`（またはフォルダ全体）を別場所へバックアップしておくことを推奨します。
>
> **⚠️ [IMPORTANT] Launching v1.7.0 Removes Backward Compatibility with Older Versions (v1.6.1 or Earlier)**
> - Once launched in v1.7.0+, `cache/library.db` is upgraded to the new security & ethical protection schema and **can no longer be opened or launched by v1.6.1 or earlier** (especially when overwriting an existing installation with `Tetheract_v1.7.0diff.zip`). An automatic pre-upgrade backup is saved to `cache/backups/library_pre_v170_security_<timestamp>.db`, and backing up `cache/library.db` before updating is recommended.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.7.0diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`Loome/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.7.0.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.7.0diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 3段階セキュリティ ＆ エシカル保護モデルの導入（Lv.0 / Lv.1 / Lv.2）
- **Lv.0: エシカルモード（標準保護・パスワード不要・常時有効）**:
  1. **他人の `Loome` が存在するドライブの完全拒否**: 友人や同僚から借りた外付けSSD/USBメモリ内に相手の `Loome` フォルダが存在する場合、電子刻印（`.loome_seal` の HMAC 署名）または非空フォルダ検知によって「他環境の `Loome`（保護中）」と自動判定し、その `Loome` の閲覧・そのドライブ全体の管理下への登録・`Loome` の上書き作成をシステムレベルで完全拒否します。
  2. **別PCで作成した自分の外付け `Loome` のパスワード／復旧コード承認**: 自宅PCと外出先ノートPCなど、別の Tetheract 環境で作成した自分の外付け `Loome` を接続した際は、ロック案内モーダルから同じパスワードまたはリカバリーコードを入力することで自分の `Loome` として承認・統合できます。
  3. **`library.db` 単体引き抜き検知ロック ＆ 本体USB故障時の3つの救済手段**: `cache/library.db` だけが単体で引き抜かれて別の Tetheract 環境に差し込まれた場合、パスワード未設定（Lv.0）であっても本体個体鍵（`.tetheract_instance`）の不一致を検知してロックし、サムネイルの無断閲覧を防ぎます。一方、本体入りUSBメモリが故障してバックアップDBを新しい本体へ引き継ぐ際は、**①パスワード**、**②所有メディア（VSN＋実在写真ファイルサイズ）のワンクリック自動照合**、**③16桁リカバリーコード（`TETH-XXXX-XXXX-XXXX-XXXX`）**の3通りの方法で安全に引き継げます。
- **Lv.1: 起動ロック ＆ DBロックモード（パスワード必要）**:
  - アプリ起動時にパスワードロック画面（全データAPI `423 Locked` 遮断）を表示し、上部バーの鍵アイコンから離席時の「今すぐロック」も行えます。
  - **2段階鍵方式（256-bit `DEK` + `PBKDF2-HMAC-SHA256` 200,000反復 `KEK`）**により、`library.db` 内の全サムネイル BLOB（`thumbnails.data`）を認証付き暗号化（`TENC\x01`）したうえで `VACUUM` を実行し、SQLite 空きページの平文痕跡も完全消去します（パスワード変更時は KEK ラップのみを更新するため一瞬で完了します）。
- **Lv.2: フルロックモード（Lv.1 ＋ `Loome` カプセル化ロック・パスワード必要）**:
  - Lv.1 の保護に加え、`Loome`（本体および接続中の自分の外付け `Loome`）内の画像・RAWファイルの先頭最大 64KB をインプレース暗号化（`TETHVLT1` マジック置換 ＋ 末尾 72B 認証フッター付与、更新日時 `mtime` 維持）し、Windows エクスプローラーや外部ビューアからの直接閲覧も遮断します。
  - Tetheract 解錠中はオンメモリで透過的に復号表示し、スマート・テイクアウトや外部フォルダへの書き出し時、および Lv.0/Lv.1 への変更時には元の無加工ファイルへ 1 ビット単位で完全復元します。

### 2. 鍵ロスト（セルフブリック）を100%防ぐ自己修復フェイルセーフ設計
- **`library.db` 誤削除時の `Loome/.loome_seal` からの鍵自動サルベージ**: 万一 Lv.2 運用中に `cache/library.db` を誤って削除・紛失して再起動した場合でも、新しい乱数鍵で上書きせず、本体 `Loome/.loome_seal` にバックアップされている鍵カプセル（および `previous_seals` 履歴）から元の `owner_id`・セキュリティレベル・ラップ鍵一式を新しい `library.db` へ自動サルベージします。パスワードまたはリカバリーコードを入力するだけで元の暗号化鍵（`DEK`）が復活し、`Loome` 内の暗号化写真を 100% 復号できます。
- **フル版ZIPへのフォルダ引っ越し時の自動ペアリング**: Lv.0 で新しいフル版ZIP展開フォルダへ `cache/` と `Loome/` をセットで手動コピペ引っ越しした際、隠しファイル `.tetheract_instance` をコピーし忘れても、`Loome/.loome_seal` とのコヒージョン証明により正当な引っ越しと自動判定してロックなしで起動します。
- **先行鍵コミット（Write-Ahead Key Commit）と重複統合耐性**: マイグレーション開始前の先行鍵コミット、フッター先行フラッシュ、固定AAD（`TETH_THUMB_V1`）による重複統合後のサムネイル復号保証、および Lv.2 カプセル化ファイルのサンプリングハッシュ平文一致性を実装しました。
- **旧バージョン（v1.6.1以前）とのダウングレード非互換化**: v1.7.0 以降の保護スキーマが適用された `library.db` は、セキュリティ維持のため v1.6.1 以前の旧バージョンへ戻して開くことはできません（旧バージョンから v1.7.0 以降へのアップグレードはそのまま自動移行されます）。

---

## English

### 1. Three-Tier Security & Ethical Protection Model (Lv.0 / Lv.1 / Lv.2)
- **Lv.0: Ethical Mode (Default Protection / No Password Required)**:
  1. **Complete Rejection of Drives Containing Another User's `Loome`**: When connecting an external drive that contains another environment's `Loome` (detected via `.loome_seal` HMAC signature or non-empty unsealed directory detection), Tetheract ethically blocks browsing that `Loome`, registering any folder on that drive, or creating/overwriting `Loome` on it.
  2. **Password / Recovery Code Approval for Your Own External `Loome` from Another PC**: If you connect your own external `Loome` created on another PC, you can enter your password or recovery code in the prompt modal to verify ownership and seamlessly integrate it.
  3. **Standalone `library.db` Extraction Detection & 3 Recovery Methods**: If `cache/library.db` alone is copied into another Tetheract environment, `.tetheract_instance` pairing mismatch locks the database (`423 Locked`). If your main USB drive fails and you restore a backup `library.db` into a new Tetheract folder, you can recover it via **(1) Password**, **(2) One-click Owned Media VSN + Photo File Verification**, or **(3) 16-character Recovery Code (`TETH-XXXX-XXXX-XXXX-XXXX`)**.
- **Lv.1: Startup Lock & DB Lock Mode (Password Required)**:
  - Requires password authentication on startup (`423 Locked` API gate) and provides an instant "Lock Now" button in the header.
  - Encrypts all thumbnail BLOBs (`thumbnails.data`) using two-tier AEAD encryption (256-bit `DEK` wrapped by a 200,000-iteration `PBKDF2-HMAC-SHA256` `KEK`) followed by `VACUUM` to purge plaintext pages.
- **Lv.2: Full Lock Mode (Lv.1 + `Loome` File Encapsulation)**:
  - In addition to Lv.1, encrypts the first 64KB of all image/RAW files inside `Loome` in-place (`TETHVLT1` header + 72-byte authenticated footer while preserving original `mtime`), preventing direct viewing from Windows Explorer or external apps.
  - Transparently decrypts in memory while unlocked and restores bit-identical original files when exporting via Smart Takeout or switching back to Lv.0/Lv.1.

### 2. Self-Healing Key Salvage & Anti-Self-Brick Failsafes
- **Automatic Key Salvage from `Loome/.loome_seal` on Accidental DB Deletion**: If `cache/library.db` is accidentally deleted while Lv.2 is active, Tetheract automatically salvages the original `owner_id`, security level, and wrapped key bundles (including `previous_seals` history) from `Loome/.loome_seal` into the new DB so your encrypted `Loome` files remain 100% recoverable with your password or recovery code.
- **Zero-Friction Lv.0 Folder Migration (`cache/` + `Loome/`)**: Moving `cache/` and `Loome/` together into a newly extracted full-ZIP folder automatically pairs the new `.tetheract_instance` via `.loome_seal` cohesion verification even if the hidden `.tetheract_instance` file was omitted, while still blocking standalone `library.db` extraction.
