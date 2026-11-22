# Release Notes - v2.5.3

- **Tag**: `v2.5.3`
- **Title**: `TETHERACT pm v2.5.3 - Android USB自動差分ダウンリンク（完全Read-Only）＆母艦収納の重複スキップ表示改善`
- **Release Date**: `2026-11-23`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.5.3 の主な変更点](#1-v253-の主な変更点) — Android USB 接続時の母艦カタログ完全 Read-Only 自動差分ダウンリンク（母艦 → モバイル片方向専用＋安全警告 UI）、およびモバイル版「母艦へ収納」の重複スキップ 0 件表示整理・進捗計上修正。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱 Android アプリ、モバイル版 Art Framer（オンデバイス ONNX プライバシー検出）、Wi-Fi ロッカー双方向同期、USB 直挿し閲覧＆自動差分取込（Read-Only）、GPS フィールドログ補完、2D 仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版 ZIP、解凍不要の差分 `diff.zip`、Android アプリの導入・更新方法（`v1.8.x` と DB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.5.3 の主な変更点
- **Android USB 接続時の母艦カタログ自動差分ダウンリンク（完全 Read-Only・母艦 → モバイル片方向専用）**（`UsbDownlinkSyncManager.kt`, `SafUsbManager.kt`, `LockerDatabaseManager.kt`, `MainActivity.kt`, `mobile.html`, `mobile.js`, `morph_thumb_bar.js`）：
  - 母艦 PC で写真を新規追加・スキャンした USB メモリ／ポータブル SSD を Android 版へ接続した際、自宅 Wi-Fi で事前同期していなくても、USB 内の `cache/` から最新カタログを完全読み取り専用（USB 側への書き込みゼロ）で自動取り込みできるようにしました。
  - 既存ロッカーがあり `cache/mobile_delta.db` が最新であれば軽量差分パックを高速適用し（Tier 1）、未更新・初回接続・`Loome` 解錠後などは `cache/library.db`（＋存在する場合は `library.db-wal` をアプリ専用一時領域内で安全にチェックポイント化）から新規・変更サムネイルとメタデータを差分マージ（Tier 2）します。再接続時に USB 側が未更新なら指紋比較（`usb_last_downlink_sig`）により 0ms でスキップします。
  - 取り込み後はスマホ側の未送信変更（`pending_journal.db`）と `PhoneCase`（`id >= 900000000`）・モバイル登録透かしを自動維持し、`owner_id` によるエシカル保護および別 `library_id` 切替確認ダイアログにも対応しています。
  - USB メディア破損防止のため、Android USB 同期は**「母艦 → モバイル」のダウンリンク専用**（スマホ側変更の母艦反映は **Wi-Fi 同期** を利用）である旨を設定画面の警告ボックス（`#mNativeUsbDownlinkNotice`）・初回 USB 検出ダイアログ・結果トーストで明示しました。なお、`Loome` フォルダ単体のみを SAF 許可している環境では `cache/` が権限範囲外となるため、`cache` と `Loome` を含む親フォルダ（USB ルートまたは `Tetheract` フォルダ）を選び直す案内と再選択導線を備えています。
- **モバイル版「母艦へ収納」の重複スキップ表示整理と進捗・完了計上修正**（`touch_phone_case.js`, `PhoneCaseTransferRunner.kt`, `phone_case_adapter.js`, `mobile.js`）：
  - モバイル版「母艦へ収納」は事前照合で未収納分のみを転送キューに入れる設計のため、通常フローで常に `0` になっていた `重複スキップ: 0枚` 表示を廃止し、実際にサーバー側で重複スキップが検出された場合（`skippedCount > 0`）のみ表示するよう PC 版と統一しました。
  - あわせて、ネイティブ／ブラウザ転送ループで加算前に進捗通知を行っていたため表示が 1 件遅れていた点、`signalSyncedCount` が進捗 JSON に含まれていなかった点、および Wi-Fi 同期完了トースト（`_formatWifiSyncDoneToast`）に実重複スキップ件数（`quickSum.skippedCount`）が反映されていなかった不具合を修正しました。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル＋ArtFramer下部メニュー、オンデバイス `YuNet` / `LPD-YuNet` ONNXプライバシー検出、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期・UI自動ホットアップデートと『母艦に収納（PhoneCase）』：自宅Wi-Fiで写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップで双方向マージ。リンク時のUI自動更新、手許写真の事前選別とカメラアプリ連携のスマートRAW信号同期・`thmod_*` 自動スタックに対応します。
- 外付けUSBドライブのスマホ直挿し閲覧＆自動差分ダウンリンク（100% Read-Only）：`Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しし、書き込みゼロのままフル解像度画像・RAWプレビュー（`Lv.1` / `Lv.2` オンメモリ復号）の閲覧と母艦カタログの片方向自動差分取り込みを行えます。
- Context Tether（GPSフィールドログ）：端末GPSだけで日次軌跡を記録し、撮影時刻照合・線形補間でGPS非搭載カメラの写真へ非破壊で撮影地を付与します。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：数万枚規模でも滑らかな60fpsスクロールとミリ秒単位のフィルタ切替を実現しています。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.5.3.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.5.3diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、設定の「データベース・保守」タブ内「GitHubで更新を確認」から取得して適用するか、ダウンロードした `Tetheract_v2.5.3diff.zip` を解凍せずに `Tetheract.exe` と同じフォルダへ置いて起動してください（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- **Android版の更新（重要）**：今回の `v2.5.3` では Kotlin ネイティブ層（`UsbDownlinkSyncManager.kt`・`LockerDatabaseManager.kt`・`SafUsbManager.kt`・`MainActivity.kt`・`PhoneCaseTransferRunner.kt`）を更新しているため、`native_revision` が更新されています。アプリ内「DB/同期」の通知バナーまたは母艦フォルダ内の **`android/Tetheract_Android.apk`** から最新版を上書きインストールしてご利用ください（ロッカー DB・ペアリング鍵・フィールドログはすべて保持されます）。また USB 自動差分ダウンリンクを有効にする場合は、USB の `Loome` 単体ではなく `cache` と `Loome` を含む親フォルダ（USBルートまたは `Tetheract` フォルダ）を選択してください。

---

## English

### 1. What's New in v2.5.3
- **Automatic Read-Only USB Catalog Downlink on Android (One-Way Mother-Ship -> Mobile)** (`UsbDownlinkSyncManager.kt`, `SafUsbManager.kt`, `LockerDatabaseManager.kt`, `MainActivity.kt`, `mobile.html`, `mobile.js`, `morph_thumb_bar.js`):
  - Connecting a mother-ship USB drive after scanning new photos on PC now automatically imports catalog and thumbnail updates into the Android locker over 100% Read-Only SAF streams without writing a single byte to the USB drive.
  - Uses a two-tier pipeline: fast delta import via `cache/mobile_delta.db` when fresh (Tier 1), and Read-Only copy of `cache/library.db` (plus temporary in-app WAL checkpointing when `library.db-wal` is present) with thumbnail diff-merge or full schema swap fallback (Tier 2). Unchanged drives skip in 0ms via file signature matching (`usb_last_downlink_sig`).
  - Preserves pending mobile edits (`replayPendingJournal`), local `PhoneCase` items, and mobile watermarks while enforcing `owner_id` ethical guards and `library_id` switch prompts.
  - Displays clear safety notices in the USB attach dialog, settings panel (`#mNativeUsbDownlinkNotice`), and completion toasts warning that USB sync is strictly one-way (Mother-Ship -> Mobile) to protect removable media, and guides re-selecting a parent folder containing both `cache` and `Loome` if only `Loome` was previously granted.
- **Cleaner Duplicate-Skip UI & Accurate Progress Counting for Mobile `PhoneCase` Uplink** (`touch_phone_case.js`, `PhoneCaseTransferRunner.kt`, `phone_case_adapter.js`, `mobile.js`):
  - Removed the confusing constant `重複スキップ: 0枚` text when pre-filtered unstored uploads skip 0 duplicates; duplicate skip counts now appear only when `skippedCount > 0`, matching desktop behavior.
  - Fixed progress events firing before incrementing `skippedCount` / `signalSyncedCount`, added `signalSyncedCount` to progress payloads, and surfaced `quickSum.skippedCount` in `_formatWifiSyncDoneToast` when duplicates actually occur.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the center GPS dial, 1-tap Art Framer with on-device `YuNet` / `LPD-YuNet` ONNX detection, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync, Auto UI Hot-Updates & `PhoneCase`: One-tap bidirectional Wi-Fi merge, live LAN streaming, automatic UI bundle hot-updates, and role-aware `Uplink` with smart RAW signal matching.
- 100% Read-Only USB Drive Viewing & Auto Downlink on Android: Zero-write browsing of full-res photos and RAW previews with in-memory `Lv.1` / `Lv.2` decryption and automatic one-way catalog downlink from mother-ship USB drives.
- Context Tether (GPS FieldLog): Offline GPS tracking with timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and instant filtering across tens of thousands of photos.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.5.3.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.5.3diff.zip`): Use Settings -> Database & Maintenance -> "Check GitHub Updates", or place `Tetheract_v2.5.3diff.zip` (unextracted) into your app folder and launch `Tetheract.exe` (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): **APK update is required for `v2.5.3`** because Kotlin native sources were updated (`native_revision` bumped). Install the updated `Tetheract_Android.apk` from the PC "Mobile Sync" QR page or in-app update banner (existing locker DB, pairing keys, and FieldLogs are preserved), and select the USB parent folder containing both `cache` and `Loome` to enable automatic USB downlink.
