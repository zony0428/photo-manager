# Release Notes - v2.2.0

- **Tag**: `v2.2.0`
- **Title**: `TETHERACT pm v2.2.0 - 手許PhoneCase一括転送＆GPS補完・PC 2D仮想スクロール＆SQL高速化・Android並列DB＆一括保存・LANペアリング防御強化`
- **Release Date**: `2026-11-13`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v2.2.0diff.zip`）**:
>   - ダウンロードした `Tetheract_v2.2.0diff.zip` を解凍せずにそのままアプリフォルダ直下へ置き、`Tetheract.exe` を起動するだけで、古い不要プログラムファイルを整理してクリーン更新できます（既存の `cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保持されます）。
> - **Android 専用アプリ（`Tetheract_Android.apk`）**:
>   - 配布パッケージ内の `android/Tetheract_Android.apk` をスマートフォン・タブレットへ上書きインストールしてください（既存のロッカーDB・ペアリング設定・GPSフィールドログはそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v2.2.0.zip`）**:
>   - 解凍して `Tetheract.exe` を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v2.2.0diff.zip` & `Tetheract_Android.apk`)**:
>   - Place `Tetheract_v2.2.0diff.zip` (unextracted) directly into your application folder and launch `Tetheract.exe` to perform an automatic clean update while preserving `cache/`, `Loome/`, `storage/`, `python/`, `models/`, and security keys. On Android, install `android/Tetheract_Android.apk` over your existing app to retain your locker database, pairing credentials, and GPS field logs. For fresh installations, extract `Tetheract_v2.2.0.zip` and run `Tetheract.exe`.

---

## 日本語 (Japanese)

### 1. 手許 `PhoneCase` 一括転送ランナー ＆ Lv.2重複防止・外付け既存写真GPS補完
- **バックグラウンド一括転送ランナーとロッカー同期の直列化 (`PhoneCaseTransferRunner.kt` / `touch_phone_case.js`)**:
  - スマートフォン内フォルダ（Camera / Pictures 等）の写真を PC 母艦の `Loome/case/` へ送る Uplink 一括転送において、認証トークンの自動再取得、HTTPエラー種別の明確な分離、ドラフト評価・タグの確実な引き継ぎを実装し、転送完了後にロッカー差分同期を直列実行するよう統合しました。
- **Lv.2 カプセル化環境での重複防止と既存写真へのGPS直接補完 (`server/routers/mobile_case_router.py`)**:
  - Lv.2 フルロック（`TETHVLT1` カプセル化）環境において論理ファイルサイズ照合を導入し、転送済み写真の二重取り込みを防止しました。また、外付けドライブ等に登録済みの既存写真に対しては、ファイル重複保存を行わずに撮影時刻照合による GPS 位置情報の直接補完と SSE 画面自動更新を行います。

### 2. PC版 行単位2D仮想スクロール ＆ 一覧 `scandir` 全廃・SQL高速化・5系統キャッシュ世代分離
- **行単位2D仮想グリッド（常駐DOM 99%削減）とUI応答性の改善 (`grid.js` / `inspector.js` / `compare.js` / `tree_builder.js`)**:
  - 写真一覧グリッドを行単位の2D仮想スクロールへ刷新し、16,000枚超のライブラリでも可視行と前後バッファ（約80〜140枚）のみをDOMに常駐させることで常駐DOM要素数を約99%削減し、60fpsの滑らかなスクロールを維持します。
  - 2枚比較（Compare）下部フィルムストリップの1D仮想化、比較ズーム時の未定義参照エラー修正、右インスペクタのアイドル時遅延描画、`state.photoById` Map による $O(1)$ ルックアップ、単一タグ・複数選択評価の部分DOM更新、`fetchPhotos()` のマイクロタスク合流、および6箇所の階層ツリー構築処理の `TreeBuilder` 共通化を実施しました。
- **一覧取得時のフォルダ `os.scandir` 全廃・スリムペイロード・省I/O化 (`server/database/photos.py` / `sidecar.py` / `scanner.py` / `raw_loader.py`)**:
  - XMPサイドカー有無を `photos.has_xmp` カラムへ保持してスキャン・サイドカー操作と連動させることで、一覧取得時のフォルダ `os.scandir` 走査を完全撤廃し、コールドスタート時のディスク待ち時間を解消しました。
  - `stack_photos` の軽量化（スタック詳細取得 `GET /api/stacks/{id}` 分離）、定数時間ページング（`limit` / `offset`）、未変更ファイルの再スキャン時 `open()` 省略、および Lv.2 RAW読み込み時のオンメモリストリーム復号化（一時ファイル書き出しゼロ化）を導入しました。
- **SQLクエリ 450〜665倍高速化と5系統キャッシュ世代分離 (`server/database/` / `preload_thumbnails.py`)**:
  - 少数枚フォルダ絞り込みSQLの非相関 `UNION` インデックス化（約450倍高速化）、フォルダ・ボリューム別リンク水和の `COLLATE BINARY` チャンク最適化（約665倍高速化）、未生成サムネイル抽出での `idx_thumbnails_dims` 活用（約3.6倍高速化）、一覧標準ソートの一時B-Tree解消を実施しました。
  - キャッシュ無効化を5系統のドメイン別コミット世代へ分離し、ウィンドウ復帰（Alt-Tab）時の事前キャッシュ全消去を廃止しました。

### 3. Android `TETHERACT ld` データベース並列排他制御・一括保存バッチJNI・SAF非同期化・APK軽量化
- **`LockerDatabaseManager` の `ReentrantReadWriteLock` 並列化と同期原子化 (`LockerDatabaseManager.kt` / `mobile_sync_apply.py`)**:
  - ロッカーDBに `ReentrantReadWriteLock` を導入して並列読み取りと排他書き込みを分離し、`wifi_delta` 差分同期中も WAL 接続を閉じずに維持することで競合エラーを解消しました。あわせて PC 側のモバイル同期適用（`mobile_sync_apply.py`）を単一トランザクションへ原子化しました。
- **100枚一括保存バッチJNIとUIスレッド非ブロック化 (`TetheractNativeBridge.kt` / `SafUsbManager.kt` / `data_adapter.js`)**:
  - 複数選択時の評価・タグ一括変更を単一の JNI 呼び出しと単一トランザクションで処理する `savePhotoChangesBatchJson` を新設し、100枚一括操作時のUIスレッド拘束を解消しました。
  - SAF フォルダ状態確認のキャッシュ非同期化（`getLockerStatusJson`）、USB `Loome` 接続時の先頭窓＋前方スキップによる省メモリ RAW 埋め込み JPEG 抽出、OS標準 `alert()` の廃止とトースト通知への統一、および同梱Webアセットの厳選（74ファイル 4.05MB から 23ファイル 1.38MB へ66%削減）を実施しました。

### 4. ローカルネットワーク ＆ 単体HTMLのセキュリティ強化
- **`Origin: null` からの Private Network Access（PNA）越境遮断 (`server/app.py` / `lan_access.py` / `mobile_router.py`)**:
  - `Origin: null` リクエストに対する `Access-Control-Allow-Private-Network` 応答を廃止し、許可パスを単体HTML用の `/api/mobile/sync-import` 1本のみに限定した上で、ループバック経由を含め明示的な `LAN_TOKEN` 提示を必須化しました。
- **指定IPワンタイムペアリング承認化と無認証Cookie交付の廃止 (`server/lan_access.py` / `mobile_router.py`)**:
  - LANペアリング承認を同一LAN全体への時間窓口開放から「要求元プライベートIP限定のワンタイム承認（TCP `/api/mobile/discover` でのトークン引き渡し時に即時消費・UDP `8088` 探索応答へのトークン非同梱）」へ厳格化し、未認証状態での長期Cookie自動交付を廃止しました。
- **LAN TCPブリッジのフェイルクローズ化 (`server/lan_bridge.py`)**:
  - 32KBを超える未完結HTTPヘッダを受信した際に上流サーバーへ接続せず `431 Request Header Fields Too Large` で即時ソケットを切断する防御と、クライアントIP伝達ヘッダのサニタイズ強化を実施しました。

---

## English

### 1. `PhoneCase` Batch Uplink Runner, Lv.2 Deduplication & Direct GPS Completion
- **Background Batch Uplink Runner & Serialized Locker Sync (`PhoneCaseTransferRunner.kt` / `touch_phone_case.js`)**:
  - Enhanced `PhoneCase` Uplink batch transfers from device camera folders to `Loome/case/` on the PC host with automatic token refresh, distinct HTTP error classification, draft rating/tag preservation, and serialized locker delta sync immediately upon transfer completion.
- **Lv.2 Vault Deduplication & Direct GPS Completion for Existing Photos (`server/routers/mobile_case_router.py`)**:
  - Added logical file-size matching for Lv.2 (`TETHVLT1`) encapsulated files to prevent duplicate imports, and enabled timestamp-based direct GPS coordinate completion with live SSE UI refresh for photos already registered on external drives.

### 2. PC 2D Virtual Grid, Zero-`scandir` Listing, 450-665x Faster SQL & 5-Domain Cache Generations
- **Row-Based 2D Virtual Grid (99% Fewer Live DOM Nodes) & Responsive UI (`grid.js` / `inspector.js` / `compare.js` / `tree_builder.js`)**:
  - Replaced full-DOM grid rendering with a row-based 2D virtual scroller that mounts only visible rows plus buffer rows (approx. 80-140 cards even on 16,000+ photo libraries), cutting live DOM nodes by ~99% and sustaining 60fps scrolling.
  - Added 1D virtualization for the Compare filmstrip, fixed a zoom reference error in `compare.js`, deferred Inspector rendering to idle frames, introduced $O(1)$ `state.photoById` lookups, partial DOM updates for tag/multi-rating edits, microtask-coalesced `fetchPhotos()`, and a unified `TreeBuilder` across 6 hierarchy views.
- **Zero-`scandir` Photo Listing, Slimmer Payloads & In-Memory Vault RAW Decoding (`server/database/photos.py` / `sidecar.py` / `scanner.py` / `raw_loader.py`)**:
  - Persisted XMP sidecar presence in `photos.has_xmp` synchronized with scanning and sidecar writes, eliminating per-request `os.scandir` directory scans and cold-start stalls.
  - Slimmed `stack_photos` payloads (separating full stack detail into `GET /api/stacks/{id}`), added constant-time `limit`/`offset` pagination, skipped redundant `open()` calls on unchanged files during rescans, and switched Lv.2 RAW loading to in-memory stream decryption with zero temporary disk writes.
- **450-665x Faster SQL Queries & 5-Domain Cache Generation Isolation (`server/database/` / `preload_thumbnails.py`)**:
  - Rewrote folder filter queries using uncorrelated `UNION` index scans (~450x faster), optimized folder/volume link hydration with `COLLATE BINARY` chunking (~665x faster), enforced `idx_thumbnails_dims` for missing-thumbnail lookups (~3.6x faster), and removed temporary B-Tree sorts on default listings.
  - Partitioned backend cache invalidation into 5 independent domain generations and removed preemptive full-cache clears on Alt-Tab window focus.

### 3. Android `TETHERACT ld` ReadWriteLock Concurrency, Batch Save JNI, Async SAF & Slimmer APK
- **`ReentrantReadWriteLock` Concurrency & Atomic Sync Apply (`LockerDatabaseManager.kt` / `mobile_sync_apply.py`)**:
  - Guarded locker SQLite access with a `ReentrantReadWriteLock` to allow concurrent reads alongside exclusive writes while keeping WAL connections open across `wifi_delta` syncs, and wrapped PC-side `mobile_sync_apply.py` execution in a single atomic transaction.
- **100-Photo Batch Save JNI, Non-Blocking SAF & Memory-Lean RAW Preview (`TetheractNativeBridge.kt` / `SafUsbManager.kt` / `data_adapter.js`)**:
  - Added `savePhotoChangesBatchJson` to commit multi-select rating and tag edits in a single JNI call and single SQLite transaction instead of hundreds of per-item synchronous calls.
  - Made SAF folder status checks non-blocking (`getLockerStatusJson`), optimized USB `Loome` RAW embedded JPEG extraction via forward stream skipping, replaced native `alert()` dialogs with toast notifications, and trimmed bundled APK web assets by 66% (from 74 files / 4.05 MB to 23 files / 1.38 MB).

### 4. Local Network & Standalone HTML Security Hardening
- **Blocked `Origin: null` Private Network Access Cross-Origin Probes (`server/app.py` / `lan_access.py` / `mobile_router.py`)**:
  - Removed `Access-Control-Allow-Private-Network` headers for `Origin: null`, restricted null-origin access exclusively to `/api/mobile/sync-import` for standalone HTML imports, and required explicit `LAN_TOKEN` presentation even on loopback.
- **Per-IP One-Time Pairing Approval & Authenticated Cookie Issuance (`server/lan_access.py` / `mobile_router.py`)**:
  - Replaced global LAN-wide pairing time windows with strict per-IP one-time pairing approvals that are immediately consumed upon TCP `/api/mobile/discover` token delivery (with UDP `8088` discovery responses never carrying tokens), and eliminated unauthenticated `pm_lan_token` cookie issuance.
- **Fail-Closed LAN TCP Bridge Header Guard (`server/lan_bridge.py`)**:
  - Enforced immediate fail-closed `431 Request Header Fields Too Large` termination without upstream forwarding when HTTP headers exceed 32 KB without completion, alongside stricter `X-Tetheract-Lan-Client` header sanitization.
