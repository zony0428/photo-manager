# TETHERACT pm v1.8.4 Release Notes

- **Tag**: `v1.8.4`
- **Title**: `TETHERACT pm v1.8.4 - Lightbox Smooth Full-Res Display & Mouse Back Support, 300ms Context Submenu Delay, In-Process LAN Relay & 1GB+ DB Fast Startup`
- **Date**: `2026-11-09`

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
> - **既存環境（軽量差分版 `Tetheract_v1.8.4diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.4diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.4diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.4.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.4diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.4diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. ライトボックス（拡大表示）のちらつき解消・サムネイル最大2倍拡大・マウス「戻る」ボタン対応（v1.8.4）
- **オンライン写真の低解像度サムネイル一瞬表示（ちらつき）を解消**:
  - 実ファイルが接続されている写真（オンライン時）をライトボックスで開いた際、先に小さなサムネイルを一瞬引き伸ばして表示してから高画質画像へ切り替わることで発生していた「ボケた画像のちらつき」を廃止し、フルサイズ画像を直接読み込んでソフトフェードイン（`0.22秒`）で滑らかに表示するよう改善しました。
- **未接続・リンク消失時のサムネイル表示上限（最大200%まで拡大）**:
  - 外付けドライブ未接続時やリンク消失時などサムネイル（長辺 300px）のみで拡大表示する場合、小さいまま表示されるのを防ぎつつ過度な引き伸ばしによる画質破綻を抑えるため、画面サイズに合わせて元のサムネイル解像度の最大 **200%（2倍・最大 600px）** まで自動拡大表示するよう調整しました。
- **マウスの「戻る」ボタン（サイドボタン）でライトボックスを閉じる動作に対応**:
  - ライトボックス表示中（または画像調整モーダル表示中）にマウスの「戻る」ボタン（第4ボタン）を押した際、ブラウザの意図しない履歴バックが発火するのを防ぎ、<kbd>Esc</kbd> / <kbd>Space</kbd> キーと同様に拡大表示（または調整モーダル）を閉じて一覧画面へ戻るようにしました。

### 2. 右クリック＆Loomeカスケードサブメニューの「0.3秒ホバー遅延＋ソフトフェードイン」と場所ツリー初期表示の修正（v1.8.4）
- **サブメニュー展開の0.3秒ディレイ＆ソフトフェードイン**:
  - 写真の右クリックメニュー（「テイクアウト ▶」「Loomeへコピー ▶」「Loome内で移動 ▶」）およびカスケード階層サブメニューにおいて、カーソルが通過した瞬間にサブメニューが即座に開閉してちらつく問題を解消。**0.3秒（300ms）** カーソルを乗せ続けた時（またはクリック時は即時）に **`0.18秒` のソフトフェードイン** で滑らかに展開されるよう改善しました。
- **撮影地（Place）ツリーの意図しない初期自動展開を修正**:
  - 初回読込時に先頭の国（例：「日本」）が自動的に開いてしまう挙動を廃止し、ユーザーがクリックした階層のみが開く一貫したツリー操作に統一しました。

### 3. スマホ連携（`/m`）のインプロセスTCPリレー化とオフライン単体HTML（`sql.js`）の大規模DB読込高速化（v1.8.4 / v1.8.2）
- **Wi-Fi QR連携（`/m`）のイベントループ競合解消**:
  - 「スマホ連携」モーダルを開いた際に別スレッドで2つ目の `uvicorn.Server` を起動していた方式を廃止し、メインサーバー（`127.0.0.1:8088`）へ転送する軽量なインプロセスTCPソケットリレー方式へ刷新。Windows の `ProactorEventLoop` 競合によるスマホブラウザからの接続ハングアップを根本解消しました（30分無通信時の自動停止および `X-Tetheract-Lan-Client` による厳格なトークン・ホワイトリスト検証はそのまま維持）。
- **`Tetheract_Mobile.html`（`sql.js` オフラインDB直読モード）の初期読込高速化 ＆ v1.7.0+ スキーマ互換修正**:
  - 数千〜数万枚規模の `library.db` を読み込んだ際、全写真のタグとスタック内訳を900件ずつチャンククエリで一括取得していた処理を廃止。初期一覧取得時は1回の `LEFT JOIN` でスタック枚数のみを高速集計し、個別写真のタグ・スタック詳細は写真をタップして開いた時にオンデマンド取得する方式へ改善しました。
  - あわせて、`sql.js`（WebAssembly SQLite）で v1.7.0 以降の `library.db`（`GENERATED VIRTUAL` 列 `tetheract_v170_guard` 搭載）を開く際および書き出す際に `SQLITE_DETERMINISTIC` フラグ付きで関数登録を行うことで、スキーマエラーなく読み書きできるよう修正しました（v1.8.2）。

### 4. 1GB超の大規模DBにおける2回目以降の起動高速化 ＆ Exif欠落統合マイグレーションの改善（v1.8.3）
- **大容量DB（1GB以上）での2回目以降の起動を大幅に高速化**:
  - 完了済みマイグレーションの再チェック省略、起動時の `sqlite_master` 事前確認による不要なDDLロック回避、および初期一覧・フォルダ集計クエリの最適化により、1GBを超えるライブラリDBでも2回目以降の起動が瞬時に完了するよう改善しました。
- **Exif欠落画像の重複統合マイグレーションの対象絞り込み修正**:
  - Exifを持たない画像のサンプリングハッシュ統合マイグレーションが対象レコードのみを正確に抽出して処理するよう修正しました。

---

## English

### 1. Smooth Full-Resolution Lightbox Opening, 200% Thumbnail Cap & Mouse Back Button Support (v1.8.4)
- **Eliminated Low-Res Thumbnail Flash for Online Photos**:
  - When opening an online photo in the lightbox, the viewer no longer flashes a stretched low-resolution thumbnail before the full-size image finishes loading. Instead, it loads the full-resolution image directly with a smooth `0.22s` fade-in.
- **Up to 200% (2x) Enlargement Cap for Offline/Unlinked Thumbnails**:
  - When only a 300px thumbnail is available (e.g., offline external drive or unlinked entry), the lightbox enlarges it up to **200% (2x, max 600px)** to balance visibility and image sharpness.
- **Mouse Back Button Closes Lightbox**:
  - Pressing the Mouse Back button (side button) while the lightbox or image adjustment modal is open now cleanly closes the overlay and returns to the grid instead of triggering browser history navigation.

### 2. 300ms Hover Delay & Soft Fade-In for Context Submenus & Location Tree Fix (v1.8.4)
- **300ms Submenu Hover Delay + 0.18s Soft Fade-In**:
  - Right-click context submenus (`Takeout`, `Copy to Loome`, `Move in Loome`) and nested folder cascades now wait `300ms` on hover (or open immediately on click) with a `0.18s` soft fade-in, preventing accidental menu flicker when moving the cursor across items.
- **Fixed Location Tree Auto-Expansion**:
  - Removed the unintended automatic expansion of the first country node on initial load in the `Place` tree.

### 3. In-Process LAN TCP Relay for `/m` & Fast `sql.js` Mobile DB Loading (v1.8.4 / v1.8.2)
- **Conflict-Free In-Process LAN Relay**:
  - Replaced the secondary `uvicorn.Server` thread in `ensure_lan_listeners()` with a lightweight in-process TCP socket relay to `127.0.0.1:8088`, resolving Windows `ProactorEventLoop` conflicts that could hang mobile QR connections while preserving the 30-minute idle auto-stop and strict token/whitelist security.
- **On-Demand Tag/Stack Loading & v1.7.0+ Schema Compatibility in `Tetheract_Mobile.html`**:
  - Eliminated slow chunked startup queries for `photo_tags` and `stack_photos` when opening large `library.db` files in `sql.js` mode by loading tag/stack details on demand when viewing a photo, and registered `tetheract_v170_guard` with `SQLITE_DETERMINISTIC` so v1.7.0+ databases load and export cleanly.

### 4. Fast 2nd+ Startup on 1GB+ Databases & Exifless Migration Filter Fix (v1.8.3)
- **Instant Subsequent Startups on Large (1GB+) Databases**:
  - Skipped redundant completed migration checks and optimized startup queries so subsequent launches on 1GB+ databases finish almost instantaneously.
