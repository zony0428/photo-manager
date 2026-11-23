# Release Notes - v2.5.4

- **Tag**: `v2.5.4`
- **Title**: `TETHERACT pm v2.5.4 - モバイルArt Framer非破壊調整反映・未同期基準値永続化＆クイック共有/同期サムネイル整合修正`
- **Release Date**: `2026-11-23`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.5.4 の主な変更点](#1-v254-の主な変更点) — モバイル版 Art Framer への非破壊調整（回転・水平傾き・クロップ・トーン）の完全反映、Android ネイティブジャーナルにおける未同期調整基準値の永続化、クイック SNS 共有・Duel・グリッド・PC 同期後サムネイルの一貫性修正。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱 Android アプリ、モバイル版 Art Framer（オンデバイス ONNX プライバシー検出）、Wi-Fi ロッカー双方向同期、USB 直挿し閲覧＆自動差分取込（Read-Only）、GPS フィールドログ補完、2D 仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版 ZIP、解凍不要の差分 `diff.zip`、Android アプリの導入・更新方法（`v1.8.x` と DB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.5.4 の主な変更点
- **モバイル版 Art Framer への非破壊調整（回転・傾き・クロップ・トーン）の事前焼き込み対応**（`touch_adjust.js`, `touch_art_framer.js`, `mobile.js`）：
  - モバイル版 Art Framer が読み込んだ画像（USB 直結原本・スマホ内写真・Wi-Fi / オフライン画像）へ、90度回転・水平傾き補正（内接自動ズーム付き）・トリミング・露出・コントラスト・彩度の有効差分を事前に適用せずそのままキャンバスへ渡していたため、非破壊調整がキャンセルされていた不具合を修正しました。
  - PC 側（`server/scanner.py` の `apply_photo_adjustments_pil`）と同一の数式・適用順（90度回転 → 水平傾き内接自動ズーム → トリミング → 露出 `2^(ev/2.2)` / コントラスト `1 + (ct/100)*0.75` / 彩度 `1 + sat/100`）を共通エンジン `renderAdjustedPhotoCanvas()` として統合し、Step 1 からのプレビュー表示・オンデバイス AI 検出座標・最終書き出し画像のすべてに非破壊調整が正確に反映されるようになりました。
  - 調整スライダー／ダイヤル操作直後の 180ms デバウンス保存完了前に Art Framer やクイック共有を開いた場合でも、`__flushMobilePendingAdjustSave()` で保存を完了させてから読み込むようにしました。
- **Android ジャーナルの編集前焼き込み基準値（`base_adjustments_json`）永続化による調整消失防止**（`PendingJournalStore.kt`, `LockerDatabaseManager.kt`, `TetheractNativeBridge.kt`, `mobile.js`）：
  - モバイルで非破壊調整を編集したあと Art Framer で保存（カタログ再読込）したり、フィルタ切替・アプリ再起動を行ったりすると、編集前の「サムネイル／PC 側焼き込み済み基準値 (`_bakedAdjust`)」が失われて編集後の値で上書きされ、調整差分が `0` となって画面全体から調整が消えて見えていた問題を修正しました。
  - `pending_journal.db` に `base_adjustments_json` 列を追加し、単発・一括・USB/Wi-Fi リプレイ時に編集前スナップショットを保存するとともに、`getPendingBakedAdjustmentsMapJson()` ブリッジ経由で一覧再描画や再起動後も未同期差分を正確に維持します。
- **クイック SNS 共有・Duel・グリッド・タブレットインスペクタ・WebView キャッシュの横並び修正**（`touch_viewer_launcher.js`, `touch_duel.js`, `touch_layout.js`, `mobile.js`）：
  - ライトボックス「SNSへ共有」を共通の `renderAdjustedPhotoCanvas()` へ統合し、PC 版と異なっていた露出・コントラスト係数、`crop_*` 未対応、`!isUnbaked` 時の 90度回転差分無視、フォールバック／別写真参照時の `unbakedSource` 誤判定をすべて解消しました。
  - 存在しない `is_phone_case` プロパティ単独参照を排してスマホ原本判定を統一し、`fetchPhotosFromLocalDb()` がトーン・傾き・クロップ全列を取得するよう改善。Android ネイティブの `/thumb/` と `/usb_photo/` には焼き込み基準・接続状態・セッションノンスを含むキャッシュバスターを付与しました。
- **PC 側モバイル同期時のサムネイル再生成・差分配布の競合解消**（`server/mobile_sync_apply.py`, `server/scanner.py`, `server/routers/mobile_router.py`）：
  - `apply_mobile_sync_changes()` で非破壊調整を受け取った際、先頭 20 件のサムネイル再生成を `ensure_mobile_delta_db` より前に同期完了（および `bump_db_commit_seq(("thumbnails",))` 発行）するよう修正し、直後の Wi-Fi 差分ダウンロードへ古いサムネイルが混入する競合を解消しました。また `mode=delta` が `max_thumb_created_at` の変化でも差分 DB 再構築を行うよう改善しました。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル＋ArtFramer下部メニュー、オンデバイス `YuNet` / `LPD-YuNet` ONNXプライバシー検出、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期・UI自動ホットアップデートと『母艦に収納（PhoneCase）』：自宅Wi-Fiで写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップで双方向マージ。リンク時のUI自動更新、手許写真の事前選別とカメラアプリ連携のスマートRAW信号同期・`thmod_*` 自動スタックに対応します。
- 外付けUSBドライブのスマホ直挿し閲覧＆自動差分ダウンリンク（100% Read-Only）：`Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しし、書き込みゼロのままフル解像度画像・RAWプレビュー（`Lv.1` / `Lv.2` オンメモリ復号）の閲覧と母艦カタログの片方向自動差分取り込みを行えます。
- Context Tether（GPSフィールドログ）：端末GPSだけで日次軌跡を記録し、撮影時刻照合・線形補間でGPS非搭載カメラの写真へ非破壊で撮影地を付与します。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：数万枚規模でも滑らかな60fpsスクロールとミリ秒単位のフィルタ切替を実現しています。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.5.4.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.5.4diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、設定の「データベース・保守」タブ内「GitHubで更新を確認」から取得して適用するか、ダウンロードした `Tetheract_v2.5.4diff.zip` を解凍せずに `Tetheract.exe` と同じフォルダへ置いて起動してください（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- **Android版の更新（重要）**：今回の `v2.5.4` では Kotlin ネイティブ層（`PendingJournalStore.kt`・`LockerDatabaseManager.kt`・`TetheractNativeBridge.kt`）を更新しているため、`native_revision` が更新されています。アプリ内「DB/同期」の通知バナーまたは母艦フォルダ内の **`android/Tetheract_Android.apk`** から最新版を上書きインストールしてご利用ください（ロッカー DB・ペアリング鍵・フィールドログはすべて保持されます）。

---

## English

### 1. What's New in v2.5.4
- **Non-Destructive Adjustments Applied in Mobile Art Framer** (`touch_adjust.js`, `touch_art_framer.js`, `mobile.js`):
  - Fixed a bug where mobile Art Framer loaded raw or partially baked image streams directly without applying effective non-destructive adjustments (90° rotation, tilt straighten with inscribed auto-zoom, crop box, exposure, contrast, and saturation).
  - Extracted a shared Canvas renderer (`renderAdjustedPhotoCanvas`) matching PC backend math (`server/scanner.py:apply_photo_adjustments_pil`: 90° rotation -> tilt inscribed auto-zoom -> normalized crop -> exposure `2^(ev/2.2)`, contrast `1 + (ct/100)*0.75`, saturation `1 + sat/100`). AI privacy detection coordinates, live previews, and final exports now consistently preserve all adjustments, and pending 180ms scrub saves are flushed (`__flushMobilePendingAdjustSave`) before loading.
- **Persistent Pre-Edit Baked Baseline in Android Journal** (`PendingJournalStore.kt`, `LockerDatabaseManager.kt`, `TetheractNativeBridge.kt`, `mobile.js`):
  - Fixed a follow-up regression where reloading the mobile catalog after Art Framer save, switching filters, or restarting the Android app caused unsynced mobile adjustments to visually reset to zero because `_bakedAdjust` was re-initialized from the already-mutated `photos` row.
  - Added `base_adjustments_json` to `pending_changes` (recording pre-edit baselines across single/batch edits and journal replays) and exposed `getPendingBakedAdjustmentsMapJson()` so grid cards, viewer, Duel, Quick Share, and Art Framer retain exact baselines until synced with PC.
- **Unified Quick SNS Share, Duel, Grid, Inspector & WebView Cache Busting** (`touch_viewer_launcher.js`, `touch_duel.js`, `touch_layout.js`, `mobile.js`):
  - Unified Quick SNS Share onto `renderAdjustedPhotoCanvas` (fixing diverged exposure/contrast formulas, missing crops, missing 90° rotation deltas, and fallback/stale `mViewerImg` `unbakedSource` reads).
  - Unified phone-original source detection via `isPhoneUnbakedPhoto` / `resolveImageUnbakedState` across grid cards (now selecting tone/tilt/crop columns in `fetchPhotosFromLocalDb`), tablet inspector, viewer, and Duel, and added baked-version + link-state + session cache busters to native `/thumb/` and `/usb_photo/` URLs.
- **Synchronous Thumbnail Regen Before `mobile_delta.db` Build** (`server/mobile_sync_apply.py`, `server/scanner.py`, `server/routers/mobile_router.py`):
  - Regenerates the first 20 adjusted thumbnails synchronously (and bumps `thumbnails` commit sequence) before `ensure_mobile_delta_db` runs after `apply_mobile_sync_changes`, eliminating race conditions during immediate Wi-Fi delta pulls, and honors `max_thumb_created_at` changes in `/api/mobile/locker-sync?mode=delta`.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the center GPS dial, 1-tap Art Framer with on-device `YuNet` / `LPD-YuNet` ONNX detection, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync, Auto UI Hot-Updates & `PhoneCase`: One-tap bidirectional Wi-Fi merge, live LAN streaming, automatic UI bundle hot-updates, and role-aware `Uplink` with smart RAW signal matching.
- 100% Read-Only USB Drive Viewing & Auto Downlink on Android: Zero-write browsing of full-res photos and RAW previews with in-memory `Lv.1` / `Lv.2` decryption and automatic one-way catalog downlink from mother-ship USB drives.
- Context Tether (GPS FieldLog): Offline GPS tracking with timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and instant filtering across tens of thousands of photos.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.5.4.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.5.4diff.zip`): Use Settings -> Database & Maintenance -> "Check GitHub Updates", or place `Tetheract_v2.5.4diff.zip` (unextracted) into your app folder and launch `Tetheract.exe` (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): **APK update is required for `v2.5.4`** because Kotlin native sources (`PendingJournalStore.kt`, `LockerDatabaseManager.kt`, `TetheractNativeBridge.kt`) were updated (`native_revision` bumped). Install the updated `Tetheract_Android.apk` from the PC "Mobile Sync" QR page or in-app update banner (existing locker DB, pairing keys, and FieldLogs are preserved).
