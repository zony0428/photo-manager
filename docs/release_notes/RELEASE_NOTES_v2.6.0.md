# Release Notes - v2.6.0

- **Tag**: `v2.6.0`
- **Title**: `TETHERACT pm v2.6.0 - Art Framer 5ステップ化（非破壊調整・ぐるぐる/バブルボケ演出）・最前面フォルダ選択ダイアログ刷新＆全体監査強化`
- **Release Date**: `2026-11-25`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.6.0 の主な変更点](#1-v260-の主な変更点) — Art Framer の 5 ステップ統合（`[0. 調整]` 非破壊バックトラック ＆ `[2. 演出]` ピント保護付き光学レンズ演出＋ステップ非使用設定）、Windows 最前面 COM フォルダ選択ダイアログ刷新と全モーダル誤閉鎖防止ガード、全体セキュリティ・非破壊保護・パフォーマンス監査強化。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱 Android アプリ、オンデバイス ONNX プライバシー検出対応 Art Framer、Wi-Fi ロッカー双方向同期、USB 直挿し閲覧＆自動差分取込（Read-Only）、GPS フィールドログ補完、2D 仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版 ZIP、解凍不要の差分 `diff.zip`、Android アプリの導入・更新方法（`v1.8.x` と DB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.6.0 の主な変更点
- **Art Framer 5ステップ統合 `[0. 調整] [1. 修正] [2. 演出] [3. 額装] [4. 出力]` と「演出」着脱設定**（`server/lens_effects.py`, `frontend/js/core/art_framer_step0.js`, `frontend/js/core/art_framer_effect.js`, `frontend/js/privacy_mask_editor.js`, `frontend/js/art_framer.js`, `frontend/js/views/touch/touch_art_framer.js`）：
  - **開始位置を `[1. 修正]` に保ったまま `[0. 調整]` へ非破壊バックトラック**：作業途中で露出・コントラスト・彩度・水平傾き・90°回転を直したくなった際、いつでも `[0. 調整]` へ戻って修正できるようになりました（PC・タブレット・スマホすべて対応）。トーン変更のみなら配置済みマスクをそのまま保持し、90°回転や傾き変更で配置済みマスクが影響を受ける場合は「AIで再検出して反映 / マスク位置を維持 / 変更を取り消す」の 3 択確認を表示します。
  - **`[2. 演出]` 光学レンズ表現（外部ライブラリ不要の自前実装）**：`Pillow + NumPy`（PC 書き出し）および Canvas `Float32Array`（リアルタイムプレビュー／モバイル書き出し）により、**ぐるぐるボケ (`swirl`)**・**バブルボケ (`bubble`)**・**オールドソフト (`soft`)**・**周辺光量 / ビネット**・**ブラックミスト風ハレーション**を追加しました。キャンバス上でピント保護円の中心 `(cx, cy)` と半径をドラッグ調整でき、保護円内は原画のシャープさを維持します。`[0. 調整]` での 90°回転時はピント保護中心も自動追従し、別の写真へ効果が残らないようモーダル起動時は自動で OFF リセットされます。
  - **「Art Framer の『演出』は使用しない」設定トグル**：PC・モバイル両方の設定画面にチェックボックスを追加しました。ON にすると `[2. 演出]` タブが非表示となり、`[3. 額装]` / `[4. 出力]` が自動的に `2. 額装` / `3. 出力` に繰り上がって従来の 4 ステップ運用へ切り替えられます。
- **Windows 最前面 COM フォルダ／ファイル選択ダイアログ刷新と全モーダル誤閉鎖防止**（`server/native_dialog.py`, `server/exporter.py`, `frontend/js/common.js`, `frontend/js/takeout.js`, `frontend/js/loome_picker.js`, `frontend/js/storage.js`, `frontend/css/style.css`）：
  - 従来のオーナー指定なし PowerShell `FolderBrowserDialog` がブラウザウィンドウの背面に隠れて 60 秒タイムアウトし、「ボタンが効かないように見えて連打するとモーダルが閉じる」原因になっていた問題を解消しました。標準 `ctypes` の **`IFileOpenDialog`**（`WS_EX_TOPMOST` オーナー HWND ＋ 多重起動防止ロック付き）へ刷新し、最前面にエクスプローラー型ダイアログを即座に表示します。
  - `.btn:disabled` スタイルの追加、ダイアログ待機中のボタン表示（`ダイアログ表示中...`）と背景クリック・`Esc` 抑止、全モーダル共通の「カード内 `pointerdown` → 背景 `click` 抜け」誤閉鎖防止ガード（`setupGlobalModalBackdropDragGuard`）、スマート・テイクアウト／Art Framer 保存先パス入力欄の直接貼り付け対応、および `Loome` 取り込み／書き出し側の選択待機フロー整理と残存 `alert()` 除去を実施しました。
- **全体監査に基づくセキュリティ境界・非破壊保護・性能 ＆ ライセンス／設計ドキュメント整理**（`server/app.py`, `server/lan_access.py`, `server/scanner.py`, `server/database/`, `LICENSES/`, `docs/knowledge/`）：
  - 未認可エンドポイントへの誤露出防止・SQL パラメータの 999 件チャンク分割・オフライン時の非破壊境界・テスト DB の完全隔離・サードパーティ OSS ライセンス一覧および設計ドキュメントの最新同期を反映しました。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル＋ArtFramer下部メニュー、オンデバイス `YuNet` / `LPD-YuNet` ONNXプライバシー検出、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期・UI自動ホットアップデートと『母艦に収納（PhoneCase）』：自宅Wi-Fiで写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップで双方向マージ。リンク時のUI自動更新、手許写真の事前選別とカメラアプリ連携のスマートRAW信号同期・`thmod_*` 自動スタックに対応します。
- 外付けUSBドライブのスマホ直挿し閲覧＆自動差分ダウンリンク（100% Read-Only）：`Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しし、書き込みゼロのままフル解像度画像・RAWプレビュー（`Lv.1` / `Lv.2` オンメモリ復号）の閲覧と母艦カタログの片方向自動差分取り込みを行えます。
- Context Tether（GPSフィールドログ）：端末GPSだけで日次軌跡を記録し、撮影時刻照合・線形補間でGPS非搭載カメラの写真へ非破壊で撮影地を付与します。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：数万枚規模でも滑らかな60fpsスクロールとミリ秒単位のフィルタ切替を実現しています。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.6.0.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.6.0diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、設定の「データベース・保守」タブ内「GitHubで更新を確認」から取得して適用するか、ダウンロードした `Tetheract_v2.6.0diff.zip` を解凍せずに `Tetheract.exe` と同じフォルダへ置いて起動してください（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- **Android版の更新**：今回バージョン表記を更新し **`android/Tetheract_Android.apk` (`v2.6.0`)** を再ビルドしています。アプリ内「DB/同期」の通知バナーまたは母艦フォルダ内の `android/Tetheract_Android.apk` から上書きインストールしてご利用ください（ロッカー DB・ペアリング鍵・フィールドログはすべて保持されます）。

---

## English

### 1. What's New in v2.6.0
- **5-Step Art Framer Workflow `[0. Adjust] [1. Fix] [2. Lens Effect] [3. Frame] [4. Export]` & Skip-Effect Preference** (`server/lens_effects.py`, `frontend/js/core/art_framer_step0.js`, `frontend/js/core/art_framer_effect.js`, `frontend/js/privacy_mask_editor.js`, `frontend/js/art_framer.js`, `frontend/js/views/touch/touch_art_framer.js`):
  - **Non-Destructive Backtracking to `[0. Adjust]`**: While always starting on `[1. Fix]`, users on Desktop, Tablet, and Phone can now jump back to `[0. Adjust]` at any time to fine-tune exposure, contrast, saturation, horizon tilt, and 90° rotation. Tone-only edits preserve existing privacy masks automatically; geometry edits trigger a 3-choice prompt (Re-detect AI / Keep & adjust / Cancel) and automatically rotate the Step 2 focus spot `(cx, cy)`.
  - **`[2. Lens Effect]` Built-In Optical Simulation**: Vectorized `Pillow + NumPy` backend and `Float32Array` Canvas renderer supporting **Swirl Bokeh**, **Bubble Bokeh**, **Old Soft**, **Vignette**, and **Halation** without third-party native dependencies. Drag the focus protection circle on the canvas to reposition `(cx, cy)` or resize the sharp focus radius; lens effects automatically reset to OFF when opening each new session.
  - **"Do not use Art Framer `[2. Lens Effect]`" Setting**: Available in both PC and Mobile Settings. Enabling this option hides the Lens Effect tab and collapses subsequent step numbers cleanly back to a 4-step workflow (`0. Adjust / 1. Fix / 2. Frame / 3. Export`).
- **Always-On-Top Windows COM Folder/File Dialog & Modal Backdrop Guards** (`server/native_dialog.py`, `server/exporter.py`, `frontend/js/common.js`, `frontend/js/takeout.js`, `frontend/js/loome_picker.js`, `frontend/js/storage.js`, `frontend/css/style.css`):
  - Replaced the unowned PowerShell `FolderBrowserDialog` (which could hide behind the `--app` browser window and hang for 60 seconds, causing repeated clicks to hit the backdrop and close the modal) with an in-house `ctypes` COM **`IFileOpenDialog`** hosted in an STA child process with a `WS_EX_TOPMOST` owner window and single-instance `_DIALOG_LOCK`.
  - Added `.btn:disabled` styling, `ダイアログ表示中...` button feedback, `pointerdown`-to-`click` backdrop drag-out protection across all modals (`setupGlobalModalBackdropDragGuard`), direct path paste/editing for export destination inputs, cleaner `Loome` folder import/export picker sequencing, and removal of remaining `alert()` fallbacks.
- **Full-Repo Audit Hardening, License Inventory & Documentation Sync**:
  - Applied security boundary tightening, 999-param SQLite chunking, test DB isolation, third-party `LICENSES/` updates, and design knowledge updates.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the center GPS dial, 5-step Art Framer with on-device `YuNet` / `LPD-YuNet` ONNX detection, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync, Auto UI Hot-Updates & `PhoneCase`: One-tap bidirectional Wi-Fi merge, live LAN streaming, automatic UI bundle hot-updates, and role-aware `Uplink` with smart RAW signal matching.
- 100% Read-Only USB Drive Viewing & Auto Downlink on Android: Zero-write browsing of full-res photos and RAW previews with in-memory `Lv.1` / `Lv.2` decryption and automatic one-way catalog downlink from mother-ship USB drives.
- Context Tether (GPS FieldLog): Offline GPS tracking with timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: Smooth 60fps browsing and instant filtering across tens of thousands of photos.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.6.0.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.6.0diff.zip`): Use Settings -> Database & Maintenance -> "Check GitHub Updates", or place `Tetheract_v2.6.0diff.zip` (unextracted) into your app folder and launch `Tetheract.exe` (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Install the bundled `v2.6.0` APK from the PC "Mobile Sync" page or `android/` folder to keep your Android app in sync (existing locker DB, pairing keys, and FieldLogs are preserved).
