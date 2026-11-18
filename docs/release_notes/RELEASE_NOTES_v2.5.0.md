# Release Notes - v2.5.0

- **Tag**: `v2.5.0`
- **Title**: `TETHERACT pm v2.5.0 - 母艦リンク連動Android UI自動ホットアップデート・ネイティブ更新通知・PC母艦セルフアップデータ＆ポータブル差分パック生成`
- **Release Date**: `2026-11-18`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.5.0 の主な変更点](#1-v250-の主な変更点) — PC母艦とのWi-Fiリンク連動による Android UI 自動ホットアップデート（APK再インストール不要化）、Kotlin ネイティブ層変更検知（`native_revision`）と標準ブラウザ経由のワンタップ APK 取得導線、PC母艦の GitHub Releases 連動セルフアップデータおよびポータブル差分パック（`diff.zip`）のオンデマンド生成・読み込み、SONY `.ARW` 等の TIFF IFD 解析精度向上とサムネイル並列再取得・近傍フォルダ横断 RAW+JPEG ペアリングの強化。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱Androidアプリ、モバイル版 Art Framer（オンデバイス ONNX プライバシー検出）、Wi-Fiロッカー双方向同期、USB直挿し閲覧（Read-Only）、GPSフィールドログ補完、2D仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版ZIP、解凍不要の差分 `diff.zip`、Androidアプリの導入・更新方法（`v1.8.x` とDB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.5.0 の主な変更点
- **PC母艦との Wi-Fi リンク連動による Android UI 自動ホットアップデート（APK 再インストール不要）**：
  - モバイルUIアセット群（`mobile.html`・CSS・JS・`sql.js` 等）と `VERSION` から決定論的リビジョン `ui_revision` を算出し、APK 内蔵メタデータ（`assets/ui_bundle_meta.json`）および母艦の配信用バンドル（`GET /api/mobile/ui-bundle`）で共通管理する仕組みを実装しました。
  - Android アプリ（`TETHERACT ld`）が Wi-Fi ロッカー同期を実行したタイミング、およびアプリ起動・復帰・定期リンク監視で PC 母艦とのオンライン接続が確立したタイミングで、UI リビジョンの差分を検知すると `tetheract_ui_bundle.zip` を自動取得・展開して WebView を即時リロードします。これにより、HTML / CSS / JS レベルの機能追加や修正において毎回 `.apk` を再インストールする手間と OS 警告確認が不要になります。
- **Android ネイティブ層（`native_revision`）の変更検知とワンタップ APK ダウンロード導線**：
  - Kotlin コード・`AndroidManifest.xml`・Gradle 設定から算出したネイティブ層リビジョン `native_revision` を APK 内蔵メタデータへ刻印しました。
  - 母艦側のネイティブ層に更新が含まれる場合のみ、スマホ画面へトースト通知と「DB/同期」カード内の更新バナー（`本体アプリ (APK) のネイティブ更新があります`）を表示します。自己インストール権限（`REQUEST_INSTALL_PACKAGES`）を追加せず、端末の標準ブラウザ経由で母艦の `/api/mobile/apk` から最新 APK を安全にダウンロードできます。
- **PC母艦の GitHub Releases 連動アップデート ＆ ポータブル差分パック（`diff.zip`）のオンデマンド生成**：
  - 設定モーダルの「データベース・保守」タブに **「ソフトウェア更新 ＆ ポータブル母艦同期」** カードを新設し、新しい更新を検出した際はヘッダーのバージョン横に `UPDATE` バッジを表示するようにしました。
  - GitHub Releases 上の同一メジャー系列最新版の自動確認・公式URL検証付きダウンロード・`Tetheract.exe` を起動してのクリーンアップデート適用に対応しました（`.git` や `build_dist.bat` が存在する開発リポジトリ環境ではソース保護のため自己上書きを自動ブロックします）。
  - 現在稼働中の母艦から個人データ（`cache/`・`Loome/`・認証鍵等）を除外した軽量差分パッケージ `Tetheract_v*diff.zip`（`Tetheract_Mobile.html`・`Tetheract_Android.apk`・`tetheract_ui_bundle.zip` 同梱）をその場で生成して書き出す機能と、手元の `diff.zip` を画面から検証配置する機能を追加しました（すべての `/api/system/*` エンドポイントは `localhost` 専用で、LAN からのアクセスは遮断されます）。
- **RAW / ARW 解析・サムネイル並列再取得・近傍フォルダ横断 RAW+JPEG ペアリングの改善**：
  - `server/raw_loader.py` の TIFF IFD 解析で圧縮タグ（`0x0103`）を判定し、非圧縮RAWストリップをプレビュー候補と誤認するケースを解消しました。
  - サムネイル一括再取得（`POST /api/photos/refresh-thumbnails`）をマルチスレッド並列処理へ高速化し、RAW ファイルで解像度・カメラ機種が未取得だった場合のメタデータ自動補完、およびクラウドダウンロードフォールバック（オンデマンド時の再取得対応）を追加しました。
  - フォルダ横断 RAW+JPEG ペアリングにおいて、同一・親子・兄弟ディレクトリ間の近接判定と ±2 秒の撮影日時許容照合を導入し、高速起動時の `scan_roots` カラム（`fingerprint` / `is_recursive`）自動補完も整備しました。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル＋ArtFramer下部メニュー、オンデバイス `YuNet` / `LPD-YuNet` ONNXプライバシー検出、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期・UI自動ホットアップデートと『母艦に収納（PhoneCase）』：自宅Wi-Fiで写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップで双方向マージ。リンク時のUI自動更新、手許写真の事前選別とカメラアプリ連携のスマートRAW信号同期・`thmod_*` 自動スタックに対応します。
- 外付けUSBドライブのスマホ直挿し閲覧（100% Read-Only）：`Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しし、書き込みゼロのままフル解像度画像やRAWプレビュー（`Lv.1` / `Lv.2` オンメモリ復号）を閲覧できます。
- Context Tether（GPSフィールドログ）：端末GPSだけで日次軌跡を記録し、撮影時刻照合・線形補間でGPS非搭載カメラの写真へ非破壊で撮影地を付与します。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：数万枚規模でも滑らかな60fpsスクロールとミリ秒単位のフィルタ切替を実現しています。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.5.0.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.5.0diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、ダウンロードした `Tetheract_v2.5.0diff.zip` を解凍せずにそのまま `Tetheract.exe` と同じフォルダへ置いて起動するか、設定の「データベース・保守」タブ内「ソフトウェア更新 ＆ ポータブル母艦同期」から取り込んで適用してください（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- Android版の導入・更新：今回の `native_revision` 照合・UI自動ホットアップデート機構を取り込むため、初回は PC 画面「スマホ連携」の QR コード（または `android/Tetheract_Android.apk`）から上書きインストールしてください。以降の UI 更新は PC 母艦との Wi-Fi リンク時に自動適用され、ネイティブ変更時のみアプリ内の通知バナーから最新 APK を取得できます（ロッカーDB・ペアリング鍵・フィールドログは保持されます）。

---

## English

### 1. What's New in v2.5.0
- **Automatic Wi-Fi Link UI Hot-Update for Android (No APK Reinstall Needed for UI Updates)**:
  - Introduced deterministic `ui_revision` hashing across all mobile Web assets (`mobile.html`, CSS, JS, `sql.js`) and `VERSION`, bundled into `assets/ui_bundle_meta.json` and served via `GET /api/mobile/ui-bundle`.
  - Whenever `TETHERACT ld` syncs or establishes a live Wi-Fi link with the desktop mother-ship, any UI revision mismatch triggers a background download and Zip-Slip-verified extraction of `tetheract_ui_bundle.zip` followed by an immediate WebView reload—eliminating repeated APK sideload prompts for HTML/CSS/JS updates.
- **Native Layer Change Detection (`native_revision`) & 1-Tap Browser APK Download**:
  - Computed a deterministic `native_revision` from Kotlin sources, `AndroidManifest.xml`, and Gradle scripts, stamped into the APK's built-in `assets/ui_bundle_meta.json` (and read from the bundled APK on distributed desktop installations).
  - Only when native code/permissions actually change does the Android app display an alert banner inside the sync sheet (`DB/Sync`) allowing 1-tap download of `/api/mobile/apk` via the device's system browser without requiring `REQUEST_INSTALL_PACKAGES`.
- **Desktop Self-Updater (GitHub Releases) & On-Demand Portable `diff.zip` Sync**:
  - Added a **Software Update & Portable Mother-Ship Sync** card under Settings → Database & Maintenance, paired with an `UPDATE` header badge when an update is available or staged.
  - Supports checking GitHub Releases within the same major series, verifying and staging official `Tetheract_v*diff.zip` packages, and launching `Tetheract.exe` for clean self-updates (guarded against self-overwrite in development repositories).
  - Also supports generating a clean, personal-data-free `Tetheract_v*diff.zip` (including `Tetheract_Mobile.html`, `Tetheract_Android.apk`, and `tetheract_ui_bundle.zip`) directly from a running desktop instance to update offline/USB mother-ships, as well as importing a local `diff.zip` from the UI. All `/api/system/*` endpoints are strictly restricted to `localhost`.
- **RAW / ARW Parsing, Parallel Thumbnail Refresh & Cross-Folder RAW+JPEG Pairing Improvements**:
  - Refined TIFF IFD compression tag (`0x0103`) checks in `server/raw_loader.py` to avoid misidentifying uncompressed RAW strips as JPEG previews.
  - Parallelized `POST /api/photos/refresh-thumbnails` with thread-safe connection cleanup, automatic metadata backfill for incomplete RAW records, and `allow_cloud_download=True` fallback.
  - Added nearby-directory proximity and ±2s timestamp tolerance matching to cross-folder RAW+JPEG pairing, plus fast-boot `scan_roots` schema migration guards.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the center GPS dial, 1-tap Art Framer with on-device `YuNet` / `LPD-YuNet` ONNX detection, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync, Auto UI Hot-Updates & `PhoneCase`: One-tap bidirectional Wi-Fi merge, live LAN streaming, automatic UI bundle hot-updates, and role-aware `Uplink` with smart RAW signal matching.
- 100% Read-Only USB Drive Viewing on Android: Zero-write direct browsing of full-res photos and RAW previews with in-memory `Lv.1` / `Lv.2` decryption.
- Context Tether (GPS FieldLog): Offline GPS tracking with timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and instant filtering across tens of thousands of photos.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.5.0.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.5.0diff.zip`): Place `Tetheract_v2.5.0diff.zip` (unextracted) into your app folder and launch `Tetheract.exe`, or stage/apply it directly from Settings → Database & Maintenance (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Install this build once via the PC "Mobile Sync" QR code or `android/Tetheract_Android.apk` to enable Wi-Fi UI hot-updates and native-revision notifications; subsequent UI updates will apply automatically when linked to your desktop mother-ship.
