# Android / モバイル専用UI & ハイブリッドDB連携アーキテクチャ (v2.30)

本ドキュメントは、Photo Manager の SQLite データベース（`cache/library.db`）に Android スマートフォンからアクセス・閲覧・選別・同期するためのアーキテクチャ設計と技術ノウハウをまとめたものである。

---

## 1. 背景と技術的課題：Android USB直結での SQLite ファイルロック問題 & 隠しフォルダ問題

スマートフォンに専用アプリを入れて USB メモリ内の `cache/library.db` を直接開く方式には、Android OS（Storage Access Framework: SAF）および exFAT / FAT32 ファイルシステム特有の以下の壁が存在する：

1. **POSIX ファイルロックと WAL モードの非互換**:
   - Photo Manager の `library.db` は高速化のため `PRAGMA journal_mode=WAL` を採用しており、オープン時に `.db-wal` と `.db-shm`（共有メモリファイル）を生成・ロックする。
   - Android の USB OTG マウント（SAF 経由のファイルディスクリプタ）や FAT 系ファイルシステム上では `mmap` やファイル範囲ロックが正常に機能せず、`SQLITE_BUSY (database is locked)` や `disk I/O error`、最悪の場合は WAL ジャーナル不整合による DB 破損を引き起こす。
2. **Android におけるドット始まり（`.cache`）隠しフォルダ不可視問題**:
   - Linux ベースの Android OS では、先頭がドット（`.`）で始まるフォルダ（旧 `.cache`）はシステム標準のファイルピッカー（DocumentsUI）でデフォルト非表示（隠しフォルダ）となる。
   - そのため、保存先フォルダ名をドットなしの **`cache/library.db`** に統一し、既存の `.cache` フォルダが存在する場合は起動時に自動マイグレーション（リネーム移行）する仕組みを導入した。
3. **USB 給電と物理干渉**:
   - スマホの Type-C ポートに USB メモリやポータブル SSD を挿しっぱなしでベッドや移動中に長時間操作すると、バッテリーの急激な消費やコネクタ接触不良によるアンマウント事故が発生しやすい。

---

## 2. 解決アーキテクチャ：ハイブリッド・デュアルエンジン (`/m` / `mobile.html`)

専用ネイティブアプリを別途ビルド・保守するコストを排し、単一モバイル特化 HTML/CSS/JS（PWA対応）によって **2つの動作モードをシームレスに切り替えるハイブリッド方式** を採用した。

| モード | 接続経路 | 特徴・用途 |
|---|---|---|
| **🟢 モード1: `server` (PC直結モード)** | 同一Wi-Fi / Tailscale 経由で `http://<PC_IP>:8088/m` にアクセス | ファイルコピー不要（ゼロコピー）。スマホでの評価（優・良・可・棄）やタグ操作が即座にPC本体の `library.db` にリアルタイム反映される。 |
| **🔌 モード2: `localdb` (USB / ローカルDBモード)** | `sql.js` (WebAssembly SQLite) で `cache/library.db` をメモリ（RAM）へ一括ロード | **1回のシーケンシャルリード（約1秒）のみで完結**。OS のファイルロック（WAL/SHM）を一切使わないため `database is locked` が100%発生せず、**読み込み完了後はスマホからUSBメモリを抜いても操作を継続できる**。 |

---

## 3. コア技術仕様

### 3.1 完全インライン単体HTML (`PhotoManager_Mobile.html`) による非HTTPS・`content://` 制限の突破
- **ブラウザ仕様上の壁**:
  1. Android Chrome は `http://192.168.x.x:8088/m` のような非HTTPSオリジンでは Service Worker (`sw_mobile.js`) の登録を許可しないため、通常の「ホーム画面に追加」だけではPC電源OFF時にオフライン起動できない。
  2. Android のファイルアプリから HTML ファイルを直接開くと `content://`（不透明オリジン `null`）で開かれ、外部ファイル（`.css`, `.js`, `.wasm`）の読み込みがすべてブロックされるほか、`window.localStorage` への直接アクセスが `SecurityError` を投げる。
- **解決策 (`server/mobile_bundle.py`)**:
  - サーバー起動時および配布パッケージ作成時（`build_dist.bat`）に、`mobile.html` + `mobile.css` + `sql-wasm.js` + `sql-wasm.wasm`（Base64文字列化） + `mobile.js` を1つの自己完結型ファイル **`PhotoManager_Mobile.html`**（プロジェクト直下 / USBルート）へ自動バンドルする。
  - `mobile.js` の `ensureSqlJsLoaded()` では、`window.__PM_SQL_WASM_BASE64__` が存在する場合は Base64 を `Uint8Array` にデコードし、`initSqlJs({ wasmBinary })` でメモリから直接 WebAssembly をインスタンス化する（`fetch()` 不使用）。
  - `localStorage` アクセスはすべて `_safeGetStorage()` / `_safeSetStorage()` で保護し、Android `content://` 上でも `SecurityError` で停止しない設計とする。
  - セキュリティ対策として、生成される `PhotoManager_Mobile.html` にはユーザーデータやローカルIP等を一切含めず、厳格な `Content-Security-Policy` (CSP) メタタグを付与して外部スクリプト注入を遮断する。

### 3.2 `sql.js` (WebAssembly) によるメモリ展開と BLOB サムネイル抽出
- `frontend/vendor/sqljs/` に `sql-wasm.js` および `sql-wasm.wasm`（MITライセンス）をローカル同梱し、外部CDN非依存（完全オフライン動作）を実現。
- Photo Manager の `cache/library.db` は `thumbnails` テーブルの `data` カラムに WebP サムネイルバイナリを完全内蔵しているため、元写真ファイル（数百GB）が無くても `.db` ファイル1つだけで全写真のプレビューが可能。
- `localdb` モードでは、表示領域に入った写真の `thumbnails.data` (Uint8Array) をオンデマンドで取得し、`new Blob([u8], { type: 'image/webp' })` → `URL.createObjectURL(blob)` に変換して `mState.thumbUrlCache` (Map) にキャッシュする。

### 3.3 4段階評価の統一と親指ワンタップ自動送り UX
- PC版と完全に同一の評価値（`2` = ★優、`1` = ●良、`0` = ○可、`-1` = ✕棄、デフォルト表示フィルタ = `0, 1, 2`）を使用。
- フルスクリーン選別ビューアの下部（親指が自然に届くボトムドック）に4つの評価ボタンを大きく配置。
- **「⚡ 評価したら自動で次の写真へ進む」** トグル（デフォルトON）により、1タップで評価確定と同時に 160ms の視覚フィードバックを経て次の写真へ自動進行する。

### 3.4 差分同期 (`mobile_sync.json`) と3段階フォールバック照合
`localdb` モードで行った評価変更・タグ追加/削除は、インメモリ DB を即時更新すると同時に `mState.pendingChanges`（および利用可能な場合は `localStorage`）に差分として自動記録される。

PC本体への反映時は、Data URI ダウンロード（`content://` でもブロックされない方式）、Android 共有シート（`navigator.share`）、クリップボードコピー、または Wi-Fi 経由の直接送信（`POST /api/mobile/sync-import`）を使用する。
サーバー側の `api_mobile_sync_import`（`server/app.py`）では、タグ文字列のサニタイズ（制御文字・HTMLタグ記号除去・長さ制限）を行った上で、以下の **3段階フォールバック** によって対象写真を確実に特定・マージする：

1. **`photo_id` + `file_name` 一致**: 同一DBからの変更であれば主キーで即座に特定。
2. **`file_path` 完全一致**: ID が変わっていてもフルパスが一致すれば特定。
3. **`file_name` + `date_taken` 一致**: ドライブレター変動や再スキャンで ID・パスが変わっていても、ファイル名と撮影日時のペアで確実に特定。

---

## 4. 関連ファイル一覧

| ファイルパス | 役割 |
|---|---|
| `PhotoManager_Mobile.html` | **【単体完結型ファイル】** CSS・JS・WASMを全内蔵したオフライン起動用HTML（自動生成） |
| `server/mobile_bundle.py` | `mobile.html` と依存資産から `PhotoManager_Mobile.html` を自動生成するバンドラ |
| `frontend/mobile.html` | スマートフォン専用 UI ソーステンプレート（CSPヘッダ・同期メニュー付き） |
| `frontend/css/mobile.css` | Hinomaru Ink（夜墨・和紙）モバイル専用レスポンシブスタイル |
| `frontend/js/mobile.js` | `server` / `localdb` デュアルエンジン・WASMメモリ展開・差分同期コントローラ |
| `frontend/manifest_mobile.json` | PWA マニフェスト |
| `frontend/sw_mobile.js` | Service Worker（HTTPS / localhost 環境用） |
| `frontend/vendor/sqljs/` | WebAssembly SQLite (`sql-wasm.js`, `sql-wasm.wasm`) |
| `server/app.py` | `GET /m`, `GET /api/mobile/standalone`, `GET /api/mobile/info`, `POST /api/mobile/sync-import` |
| `run.py` | `BIND_HOST = "0.0.0.0"` による同一LAN / Tailscale からのモバイル接続許可 |
