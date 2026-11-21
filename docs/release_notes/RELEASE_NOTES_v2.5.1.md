# Release Notes - v2.5.1

- **Tag**: `v2.5.1`
- **Title**: `TETHERACT pm v2.5.1 - ライトボックスSNSクイック共有ランチャー集約・library.db画像ウォーターマーク管理＆スマホ同期`
- **Release Date**: `2026-11-22`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.5.1 の主な変更点](#1-v251-の主な変更点) — モバイルライトボックス操作のアクションランチャー集約とギャラリーを汚さないクイックSNS共有、`library.db` による複数透過PNGウォーターマーク管理・PC⇄スマホ自動同期・PC/モバイル間のロゴサイズ比率統一、Google ドライブ仮想ドライブ原本表示修正、Android UI ホット更新互換ガード＆APK ダウンロード修正。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱Androidアプリ、モバイル版 Art Framer（オンデバイス ONNX プライバシー検出）、Wi-Fiロッカー双方向同期、USB直挿し閲覧（Read-Only）、GPSフィールドログ補完、2D仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版ZIP、解凍不要の差分 `diff.zip`、Androidアプリの導入・更新方法（`v1.8.x` とDB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.5.1 の主な変更点
- **モバイルライトボックスのアクションランチャー集約 ＆ ギャラリー非汚染クイック SNS 共有**：
  - ライトボックス上部バー右側の操作ボタン群を単一のアクションランチャーボタン（`#mViewerLauncherBtn`）へ集約し、ポップオーバーから「SNSへ共有」「Art Framer」「非破壊調整」「タグ・Exif詳細」「評価後の自動次送り」を迷わず呼び出せるようにしました。
  - 新設の「SNSへ共有」は、非破壊の露出・コントラスト・彩度・傾き・90°回転を焼き込んだ長辺最大 2048px・GPS 除去済みの JPEG を `cacheDir/share/` へ一時出力し、`FileProvider`（`QuickShareHelper.kt`）経由で Android の共有シートを直接起動します。`Pictures/Tetheract` へ重複ファイルを残さないため、端末のギャラリーを汚さずに素早く SNS 共有を行えます。
- **`library.db` 画像ウォーターマークライブラリ ＆ PC ⇄ スマホ同期・サイズ基準統一**：
  - Art Framer で使う透過 PNG ロゴを `library.db` の `watermark_assets` テーブルで複数登録・管理できるようになりました（初回起動時は標準の `TETHERACT` ロゴを自動登録し、ユーザーが削除した後は `default_watermark_seeded_v1` フラグにより再復活しません）。
  - PC 母艦で登録したロゴは `mobile_delta.db` 経由の Wi-Fi ロッカー同期でスマホへ自動配信され、スマホ側で登録したロゴ（`origin = 'mobile'`）は差分同期・フル同期のいずれでも自動退避されて消えずに保持されます。
  - PC 書き出し（Pillow）とモバイル書き出し（Canvas）の双方で、画像ウォーターマークのサイズ計算を **「写真の長辺 × % ＝ ロゴの長辺（3%〜50%）」** に統一し、端末間で仕上がりの大きさが揃うようにしました。

- **Google ドライブ仮想ドライブ・ライトボックス原本読み込み修正**：
  - Google ドライブ（`\その他のパソコン`、仮想シリアル番号 `19831116`、オンデマンド領域等）の接続時に、アクセス不能ルートでの `PermissionError` を回避してクラウド候補ドライブを正しく探索できるよう改善しました。
  - `/api/photo/{id}/view` でオフライン時サムネイル応答への `ETag` 固定を撤廃し（`Cache-Control: no-store`＋`X-Photo-Offline: true`）、ペアオンライン RAW へのフォールバック、オンデマンド実体読込（`X-Photo-View-Source: original`）、およびライトボックス表示・ダブルクリック時の原本再取得を整備しました。
- **Android UI ホットアップデート `native_revision` 保護＆APK ダウンロード修正**：
  - APK 本体のネイティブ更新が必要な場合は互換しない UI ホットアップデートをスキップ（起動時の不一致キャッシュ自動復旧付き）するよう修正しました。
  - LAN ブラウザ上の APK ダウンロードボタンへ認証トークン `?t=` を付与し、Android WebView に `DownloadListener` を実装しました。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル＋ArtFramer下部メニュー、オンデバイス `YuNet` / `LPD-YuNet` ONNXプライバシー検出、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期・UI自動ホットアップデートと『母艦に収納（PhoneCase）』：自宅Wi-Fiで写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップで双方向マージ。リンク時のUI自動更新、手許写真の事前選別とカメラアプリ連携のスマートRAW信号同期・`thmod_*` 自動スタックに対応します。
- 外付けUSBドライブのスマホ直挿し閲覧（100% Read-Only）：`Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しし、書き込みゼロのままフル解像度画像やRAWプレビュー（`Lv.1` / `Lv.2` オンメモリ復号）を閲覧できます。
- Context Tether（GPSフィールドログ）：端末GPSだけで日次軌跡を記録し、撮影時刻照合・線形補間でGPS非搭載カメラの写真へ非破壊で撮影地を付与します。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：数万枚規模でも滑らかな60fpsスクロールとミリ秒単位のフィルタ切替を実現しています。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.5.1.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.5.1diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、ダウンロードした `Tetheract_v2.5.1diff.zip` を解凍せずにそのまま `Tetheract.exe` と同じフォルダへ置いて起動するか、設定の「データベース・保守」タブ内「ソフトウェア更新 ＆ ポータブル母艦同期」から取り込んで適用してください（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- Android版の更新：今回は `QuickShareHelper.kt`・`WatermarkAssetStore.kt`・`AndroidManifest.xml` 等を含むネイティブ層の更新が含まれるため、PC 画面「スマホ連携」の QR コード・アプリ内の更新バナー、または `android/Tetheract_Android.apk` から上書きインストールしてください（ロッカーDB・ペアリング鍵・フィールドログは保持されます）。

---

## English

### 1. What's New in v2.5.1
- **Mobile Lightbox Action Launcher & Gallery-Clean Quick SNS Share**:
  - Consolidated the right-side lightbox controls into a single action launcher button (`#mViewerLauncherBtn`), giving quick popover access to **Share to SNS**, **Art Framer**, **Non-destructive Adjustments**, **Tags & EXIF Details**, and **Auto-Advance**.
  - **Share to SNS** renders a temporary JPEG (max 2048px long edge, GPS metadata stripped, with non-destructive exposure/contrast/saturation/straighten/90° rotation applied) into `cacheDir/share/` and opens the Android share sheet via `FileProvider` (`QuickShareHelper.kt`) without saving duplicate files to `Pictures/Tetheract`.
- **`library.db` Image Watermark Library, PC⇄Mobile Sync & Unified Sizing**:
  - Multiple transparent PNG logos can now be registered and managed in the `watermark_assets` table inside `library.db`, pre-seeded once with a default `TETHERACT` logo (`default_watermark_seeded_v1` ensures it is not re-added if deleted).
  - Desktop logos are synced to Android automatically inside `mobile_delta.db`, while mobile-registered logos (`origin = 'mobile'`) are preserved across both delta and full locker syncs.
  - Unified watermark logo sizing across PC (Pillow) and Mobile (Canvas) to **photo long-edge × % = logo long-edge (3%–50%)**.
- **Google Drive virtual-drive & Lightbox original-view fixes**: Fixed path resolution across cloud mounts (`\その他のパソコン`, virtual VSN `19831116`) with `PermissionError` guards, removed fallback-thumbnail `ETag` pinning in `/api/photo/{id}/view`, added online paired-RAW fallback and `X-Photo-View-Source: original` on-demand reads, and wired Lightbox probe/double-click original reload.
- **Android UI hot-update `native_revision` guard & APK download fixes**: Blocked incompatible `tetheract_ui_bundle.zip` hot-updates when `native_revision` differs (with startup self-healing), appended `?t=` auth token to the LAN APK download button, and wired Android WebView `DownloadListener`.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the center GPS dial, 1-tap Art Framer with on-device `YuNet` / `LPD-YuNet` ONNX detection, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync, Auto UI Hot-Updates & `PhoneCase`: One-tap bidirectional Wi-Fi merge, live LAN streaming, automatic UI bundle hot-updates, and role-aware `Uplink` with smart RAW signal matching.
- 100% Read-Only USB Drive Viewing on Android: Zero-write direct browsing of full-res photos and RAW previews with in-memory `Lv.1` / `Lv.2` decryption.
- Context Tether (GPS FieldLog): Offline GPS tracking with timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and instant filtering across tens of thousands of photos.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.5.1.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.5.1diff.zip`): Place `Tetheract_v2.5.1diff.zip` (unextracted) into your app folder and launch `Tetheract.exe`, or stage/apply it directly from Settings → Database & Maintenance (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Because v2.5.1 includes Kotlin/Manifest native updates (`QuickShareHelper.kt`, `WatermarkAssetStore.kt`, `AndroidManifest.xml`), overwrite-install `Tetheract_Android.apk` once via the PC "Mobile Sync" QR code or the in-app update banner (your locker DB, pairing keys, and FieldLogs are preserved).
