# Release Notes - v2.4.0

- **Tag**: `v2.4.0`
- **Title**: `TETHERACT pm v2.4.0 - モバイル版『Art Framer』搭載・オンデバイス YuNet/LPD-YuNet AI検出・カメラ転送フォルダのスマートRAW連携`
- **Release Date**: `2026-11-18`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.4.0 の主な変更点](#1-v240-の主な変更点) — Android / モバイル版『Art Framer』の新規搭載（下部「ArtFramer」からの1タップ選択起動、オンデバイス `YuNet` / `LPD-YuNet` ONNX 推論エンジン＆4辺精密スナップ、Step2/3ピンチ拡大・EXIFオンデマンド補完・OS共有シート連携）、スマホフォルダの役割分離（`[本体収納]` vs `[信号+加工]`）と異サイズスマート照合・待機シグナル・`thmod_` フォルダ横断自動スタック、母艦収納アクション一本化、タグ編集時スクロール追従。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱Androidアプリ、Wi-Fiロッカー双方向同期、USB直挿し閲覧（Read-Only）、GPSフィールドログ補完、2D仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版ZIP、解凍不要の差分 `diff.zip`（プライバシー検出ONNXモデル同梱）、Androidアプリの導入方法（`v1.8.x` とDB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.4.0 の主な変更点
- **モバイル / Android 版『Art Framer』の搭載とワンタップ選択導線**：
  - スマホ画面下部メニューの右ボタンを **「ArtFramer」** へ刷新し（ラボ項目は「フィルタ」ドロワーへ整理）、タップして一覧から1枚選ぶだけですぐに Art Framer ウィザードを起動できるようにしました（拡大ビュー上部メニューや複数選択からの起動にも対応）。
  - **100% オフライン・オンデバイス AI プライバシー検出（`OnnxPrivacyEngine`）**：Android アプリ内に母艦と同一の軽量 ONNX モデル（`YuNet` 顔検出 ＋ `LPD-YuNet` 4頂点ナンバープレート検出）を動かす専用 CPU 並列推論エンジンを組み込みました。さらに夜間・白バンパー密着車両・太字ナンバーに対応した高解像度 2段文字補完と左右グリル対比 4辺精密スナップを組み合わせ、道路標識等の誤検出を抑えながら 4G 外出先でも高い精度で自動検出します（実行中はプログレスバーで進捗を表示します）。
  - **Step 2 / 3 拡大プレビュー、EXIF / 撮影地オンデマンド補完、OS 共有シート連携**：プリント枠確認ステップ（Step 2 / 3）でも2本指ピンチやダブルタップで拡大して細部・キャプションを確認できるようにしました。スマホ内のローカル写真では開いた瞬間にカメラ機種・レンズ・露出設定・シャッター速度・撮影地（ジオコーディング補完）をオンデマンド読込して枠内キャプションへ反映します。仕上げた画像は端末の公開フォルダ（`Pictures/Tetheract`）への書き出しと OS 共有シートからの即時 SNS 共有に加え、`thmod_*` 派生画像として母艦連携キューへ自動登録されます。
- **スマホフォルダの役割モード分離（`[本体収納]` ⇄ `[信号+加工]`）とスマート RAW 連携**：
  - スマホ「手許（PhoneCase）」に登録したフォルダごとに役割を切り替えられるようになりました（`Creators' App` / `SnapBridge` / `Canon Camera Connect` / `LUMIX Sync` 等は自動で `[信号+加工]` を初期選択）。
  - **`[信号+加工]` モード**：カメラからスマホへ一時転送した 2MP 縮小画像を PC へ重複保存せず、スマホで付けた **評価（優・良・可・棄）・タグ・GPS** および Art Framer で作成した **`thmod_*` 加工画像のみ** を送信します。
  - **異サイズ・別拡張子スマート照合と先行待機シグナル（`mobile_pending_signals`）**：母艦側でファイル名語幹・撮影時刻（±3秒）・カメラ機種を照合し、2MP 縮小版で付けた評価・タグ・GPS を PC や SD カードのフルサイズ JPEG ＋ ペア RAW 原本の両方へ自動反映します。SD カード取り込み前でも評価・タグを待機シグナルとして保持し、後日 PC で SD カードをスキャンした瞬間に自動で合流します。さらに、`Loome/case/` へ入った `thmod_*` 画像（EXIF保持時）も、別フォルダにある元写真と自動でフォルダ横断スタック化されます。
- **UI・操作性の改善**：
  - スマホ画面の「母艦に収納」導線を中央丸型ダイヤル上方向の一本化構成へ整理し、重複していた旧手動選択モーダルを廃止してレイアウト崩れ（ボタンの2段折り返し）を解消しました。
  - PC版一覧において、タグの付与・削除・編集後に全件リロードを行わず画面を更新し、処理対象末尾の次コマへ自然にスクロール追従するよう改善しました。
  - Art Framer のプライバシー顔モヤスタンプの強度補正・スライダー一括連動、および夜間照明下の太字ナンバー（`99-09` 等）への 2段補完パラメータを調整しました。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル＋ArtFramer下部メニュー、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期と『母艦に収納（PhoneCase）』：自宅Wi-Fiで写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップで双方向マージ。手許写真の事前選別とカメラアプリ連携のスマートRAW信号同期・`thmod_*` 自動スタックに対応します。
- 外付けUSBドライブのスマホ直挿し閲覧（100% Read-Only）：`Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しし、書き込みゼロのままフル解像度画像やRAWプレビュー（`Lv.1` / `Lv.2` オンメモリ復号）を閲覧できます。
- Context Tether（GPSフィールドログ）：端末GPSだけで日次軌跡を記録し、撮影時刻照合・線形補間でGPS非搭載カメラの写真へ非破壊で撮影地を付与します。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：数万枚規模でも滑らかな60fpsスクロールとミリ秒単位のフィルタ切替を実現しています。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.4.0.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.4.0diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、ダウンロードした `Tetheract_v2.4.0diff.zip` を解凍せずにそのまま `Tetheract.exe` と同じフォルダへ置いて起動するだけで、古い不要ファイルを一掃してクリーン更新されます（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- Android版の導入・更新：PC画面「スマホ連携」のQRコード（または `android/Tetheract_Android.apk`）から上書きインストールするか、スマホ設定の「アプリ更新を確認」から自宅Wi-Fi経由で更新してください（ロッカーDB・ペアリング鍵・フィールドログは保持されます）。

---

## English

### 1. What's New in v2.4.0
- **Mobile & Android `Art Framer` with 1-Tap Photo Selection**:
  - Replaced the bottom-right `Lab` button with **ArtFramer** (moving Lab views into the Filter drawer). Tapping `ArtFramer` enters an instant 1-tap photo pick mode so tapping any photo launches the 3-step Art Framer wizard directly.
  - **100% Offline On-Device ONNX Detection (`OnnxPrivacyEngine`)**: Embedded a dependency-free parallel CPU inference engine inside the Android app that executes the exact same bundled `YuNet` (face) and `LPD-YuNet` (license plate) ONNX models as the desktop mother-ship, paired with high-resolution Japanese 2-row plate refinement and side-grille contrast snapping. Runs fully offline on cellular connections without misidentifying street signs as faces, with live progress feedback.
  - **Step 2/3 Preview Zoom, On-Demand EXIF/Geocode Hydration & OS Share**: Step 2 (Print Frame / Watermark) and Step 3 now support pinch-to-zoom and double-tap zoom. Phone-local photos automatically hydrate missing EXIF (camera, lens, shutter speed, exposure) and geocoded location names on demand for frame captions. Exported results save directly to `Pictures/Tetheract`, launch the native Android Share Sheet, and queue as `thmod_*` derivatives for mother-ship sync.
- **PhoneCase Folder Role Modes (`[Case]` vs `[Signal+Edit]`) & Smart RAW Matching**:
  - Each linked phone folder can now be assigned either **`[Case]`** (archive original photos + signals into `Loome/case/`) or **`[Signal+Edit]`** (auto-selected for camera companion app folders such as `Creators' App`, `SnapBridge`, `Canon Camera Connect`, and `LUMIX Sync`, skipping redundant 2MP JPEG uploads and sending only ratings/tags/GPS signals plus `thmod_*` exports).
  - **Cross-Size Smart Matching & Deferred Pending Signals (`mobile_pending_signals`)**: Desktop preflight matches culled 2MP transfers against full-size JPEG + RAW pairs by camera stem normalization, capture timestamp (±3s), and model. Signals rated before importing your SD card are stored in `mobile_pending_signals` and auto-applied on subsequent scans; `thmod_*` edits synced into `Loome/case/` also auto-stack across folders under their original photo.
- **UI & Workflow Refinements**:
  - Unified all mobile upload actions into the center dial's swipe-up `Uplink to PC` slot, removing the legacy duplicate manual picker modal and fixing 2-row button wrapping in toolbars.
  - Eliminated full-grid reloads after tag edits on desktop and smoothly tracked focus/scroll to the next item.
  - Improved night-scene and bold Japanese plate detection parameters and irreversible face haze masking synchronization.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the center GPS dial, 1-tap Art Framer launch, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync & `PhoneCase`: One-tap bidirectional Wi-Fi merge, live LAN streaming at home, and role-aware `Uplink` with smart RAW signal matching.
- 100% Read-Only USB Drive Viewing on Android: Zero-write direct browsing of full-res photos and RAW previews with in-memory `Lv.1` / `Lv.2` decryption.
- Context Tether (GPS FieldLog): Offline GPS tracking with timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and instant filtering across tens of thousands of photos.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.4.0.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.4.0diff.zip`): Place `Tetheract_v2.4.0diff.zip` (unextracted) into your app folder and launch `Tetheract.exe` (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Install over your existing app via the PC "Mobile Sync" QR code, the `android/` folder, or in-app Wi-Fi update check.
