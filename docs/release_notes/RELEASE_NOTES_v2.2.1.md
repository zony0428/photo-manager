# Release Notes - v2.2.1

- **Tag**: `v2.2.1`
- **Title**: `TETHERACT pm v2.2.1 - Android連携・タッチUI・GPSフィールドログ統合版（新アイコン・Slap & Sweep・スタックタグ引き継ぎ）`
- **Release Date**: `2026-11-15`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.2.1 の主な変更点](#1-v221-の主な変更点) — 新シルエットアイコン（C-2）、モーション調整（`Slap & Sweep`）、レタッチ派生画像のタグ自動引き継ぎ、F5不要の即時反映。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱Androidアプリ、Wi-Fiロッカー双方向同期、USB直挿し閲覧（Read-Only）、GPSフィールドログ補完、2D仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版ZIP、解凍不要の差分 `diff.zip`、Androidアプリの導入方法（`v1.8.x` とDB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.2.1 の主な変更点
- 新シルエットアイコン（C-2）と画面エディションロゴ（`Ed / Ld / Rg`）：外周枠を排した光と影の超立方体アイコンへ刷新し、画面モードに応じてヘッダーロゴが PC版 `TETHERACT Ed` / タブレット版 `TETHERACT Ld` / スマホ版 `TETHERACT Rg` へ自動で切り替わります。
- モーション調整（`Slap & Sweep`）の搭載：設定の「外観」タブに、画面遷移のキレと余韻を調整できるスライダーを新設しました。残像ゼロで即座に切り替わる `Slap (0%)` から、暗室のような滑らかな余韻を残す `Sweep (100%)`（初期値 `60%`）まで好みに合わせられます。
- レタッチ派生画像・連写スタックのタグ自動引き継ぎ：テイクアウト（書き出し）した画像を外部アプリでレタッチして管理フォルダへ戻した際や、連写・ブラケット・RAW+JPEGペアがスタック編成された際、元の写真に付いていたタグが全メンバーへ自動で引き継がれます。
- RAW+JPEGペアのオンライン判定と保存先表示の改善：RAWとJPEGが別フォルダにあるペアでも、JPEG側が接続されていればオンラインとして正確に判定し、右インスペクタに両方の保存先パスを個別表示します（スマホ側の接続状態表示も同期）。
- F5（再読み込み）不要の画面即時同期：タグの削除・リネーム・階層移動、スタック代表コマの変更、一括評価・回転・トーン調整・リセット、日時シフト、`Loome` 移動を行った際、ブラウザの再読み込みなしで一覧・ライトボックス・インスペクタへ即座に反映されます。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、下部56pxのモーフィング・サムバー、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期と『PhoneCase』転送：自宅Wi-Fiで指定フォルダや条件の写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップでPCへ双方向マージできます。スマホ内の写真を事前選別してPCの `Loome/case/` へ一括転送する『PhoneCase』や、在宅時のLANライブ閲覧にも対応しています。
- 外付けUSBドライブのスマホ直挿し閲覧（100% Read-Only）：外出先で `Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しすると、ドライブへ1バイトも書き込まない完全読み取り専用のままフル解像度画像やRAWプレビューを閲覧できます（`Lv.1` / `Lv.2` 暗号化データのオンメモリ復号対応）。
- Context Tether（GPSフィールドログ）：Androidクイック設定パネルの `FieldLog` タイルを1タップするだけで、省電力・オフラインのまま日次軌跡を記録します。帰宅後にWi-FiでPCへ送信し、時計ズレ補正と線形補間によってGPS非搭載カメラの写真へも非破壊で撮影地を付与できます（一括取り消し・`.gpx` 入出力対応）。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：画面外のDOM要素を99%削減する行単位の2D仮想スクロールとSQLクエリ最適化により、数万枚規模のライブラリでも滑らかなスクロールと数ミリ秒のフィルタ切替を維持します。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.2.1.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.2.1diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、ダウンロードした `Tetheract_v2.2.1diff.zip` を解凍せずにそのまま `Tetheract.exe` と同じフォルダへ置いて起動するだけで、古い不要ファイルを一掃してクリーン更新されます（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- Android版の導入・更新：PC画面「モバイル同期」のQRコード（または `android/Tetheract_Android.apk`）からインストールしてください（既存のロッカーDB・ペアリング設定・フィールドログはそのまま引き継がれます）。

---

## English

### 1. What's New in v2.2.1
- New Silhouette Icon (C-2) & Edition Logos (`Ed / Ld / Rg`): Updated the app icon to a borderless light-and-shadow hypercube silhouette, with automatic header wordmark switching across PC (`TETHERACT Ed`), Tablet (`TETHERACT Ld`), and Phone (`TETHERACT Rg`).
- Motion Adjuster (`Slap & Sweep`): Added a transition slider in Settings > Appearance to tune UI transitions from zero-delay instant switching (`Slap 0%`) to smooth darkroom afterglow (`Sweep 100%`, default `60%`).
- Automatic Tag Inheritance for Retouched & Stacked Photos: Externally retouched Takeout derivatives placed back into managed folders, as well as bursts, brackets, and RAW+JPEG pairs, now automatically inherit and sync existing tags across all stack members.
- Improved RAW+JPEG Online Detection & Path Display: RAW+JPEG pairs across folders accurately report online status based on JPEG availability, display separate file paths in the Inspector, and sync connection status to mobile.
- Live UI Sync Without F5 Reload: Tag edits, stack primary changes, batch rating/rotation/tone edits, resets, timestamp shifts, and `Loome` file operations now update the grid, Lightbox, and Inspector immediately without reloading.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with a 56px morphing thumb bar, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync & `PhoneCase` Uplink: Offline culling with one-tap bidirectional Wi-Fi merge, live LAN streaming at home, and batch Uplink transfer of culled phone photos into `Loome/case/`.
- 100% Read-Only USB Drive Viewing on Android: Direct viewing of full-resolution photos and RAW previews from external USB `Loome` drives with zero writes and in-memory `Lv.1` / `Lv.2` decryption.
- Context Tether (GPS FieldLog): One-tap offline track logging from the Android Quick Settings tile with non-destructive timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and 450–665x faster SQL queries for smooth 60fps scrolling on 16,000+ photo libraries.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.2.1.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.2.1diff.zip`): Place `Tetheract_v2.2.1diff.zip` (unextracted) into your app folder and launch `Tetheract.exe` (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Install via the PC "Mobile Sync" QR code or directly from the `android/` folder.
