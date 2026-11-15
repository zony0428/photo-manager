# Release Notes - v2.2.2

- **Tag**: `v2.2.2`
- **Title**: `TETHERACT pm v2.2.2 - Android連携・タッチUI・GPSフィールドログ統合版（フォルダ差分ピンポイント更新・中央丸型GPSダイヤル＆ワンタップ母艦収納）`
- **Release Date**: `2026-11-15`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.2.2 の主な変更点](#1-v222-の主な変更点) — 大規模フォルダのピンポイント差分リフレッシュ＆未登録フォルダ巻き込み防止、スマホ下部メニューの3構成刷新（丸型GPSダイヤル・上下スワイプ切替・ワンタップ『母艦に収納』・未接続時グレーアウト）。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱Androidアプリ、Wi-Fiロッカー双方向同期、USB直挿し閲覧（Read-Only）、GPSフィールドログ補完、2D仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版ZIP、解凍不要の差分 `diff.zip`、Androidアプリの導入方法（`v1.8.x` とDB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.2.2 の主な変更点
- フォルダ差分リフレッシュのピンポイント高速化 ＆ 全件再走査の解消（`v1.8.11` 共通修正）：
  - 数万枚の写真を抱える管理フォルダで少数の更新が検出された際、「リフレッシュ（最新化）」を押すと無変更のサブフォルダ再走査・全件存在確認・全体スタック再計算が走っていた問題を修正しました。変更が発生したディレクトリ・追加サブフォルダ・消失フォルダのみをピンポイント処理する `refresh_folder_diff` を新設し、変更枚数分だけを高速に反映します（通常スキャン時および `.xmp` フラグ同期の未変更スキップもあわせて高速化）。
- 上位親フォルダ・ドライブルート選択時の「未登録フォルダ巻き込みスキャン」防止（`v1.8.11` 共通修正）：
  - 管理下サブフォルダと未登録（`[未登録]`）の兄弟フォルダが同居する上位コンテナ親フォルダやドライブルートを選択した際、未登録フォルダを「新規追加」と誤判定して配下すべてを再帰スキャンしてしまう不具合を解消しました。`scan_roots.is_recursive` に基づき、管理下スコープ内の差分のみを厳密に検出・更新します。
- スマホ画面下部メニューの3構成刷新 ＆ 中央丸型「GPSロガー」ダイヤルの搭載：
  - スマートフォン版の下部メニューを **左「フィルタ」・中央の丸型ダイヤル（直径86px・地球グリッド意匠）・右「ラボ」** の3構成へ刷新し、親指での操作性を向上しました。
  - 中央の丸型ダイヤルは上下に1段ずつスワイプすることで **`母艦に収納` ⇄ `GPSロガー`（既定） ⇄ `カメラ`** の3機能を直感的に往復切り替えできます（GPSロガー記録中は緑色の呼吸リングとパルスドットが点灯し、カメラ起動時は撮影後のアプリ復帰で手許フォルダを自動再スキャンします）。
- 『母艦に収納』のワンタップ差分同期・長押し手動選択 ＆ 母艦未接続時のグレーアウト保護：
  - 中央ダイヤルを「母艦に収納」に切り替えてワンタップするだけで、手許（`PhoneCase`）の未収納・メタデータ変更分の写真だけを自動抽出してPC母艦の `Loome/case/` へバックグラウンド収納し、ロッカー差分同期まで一括完了します。長押しで従来のフォルダ・対象手動選択モーダルが開きます。
  - PC母艦とWi-Fi接続（LINK）されていない状態では、中央ダイヤルの「母艦に収納」表示および手動選択モーダル内の収納実行ボタンをグレーアウト（非アクティブ化）し、オフライン時の誤操作を防止します。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル付き下部メニュー、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期と『母艦に収納（PhoneCase）』：自宅Wi-Fiで指定フォルダや条件の写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップでPCへ双方向マージできます。スマホ内の写真を事前選別してPCの `Loome/case/` へ差分転送する『母艦に収納』や、在宅時のLANライブ閲覧にも対応しています。
- 外付けUSBドライブのスマホ直挿し閲覧（100% Read-Only）：外出先で `Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しすると、ドライブへ1バイトも書き込まない完全読み取り専用のままフル解像度画像やRAWプレビューを閲覧できます（`Lv.1` / `Lv.2` 暗号化データのオンメモリ復号対応）。
- Context Tether（GPSフィールドログ）：画面中央の丸型GPSロガーボタン（またはAndroidクイック設定パネルの `FieldLog` タイル）を1タップするだけで、省電力・オフラインのまま日次軌跡を記録します。帰宅後にWi-FiでPCへ送信し、時計ズレ補正と線形補間によってGPS非搭載カメラの写真へも非破壊で撮影地を付与できます（一括取り消し・`.gpx` 入出力対応）。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：画面外のDOM要素を99%削減する行単位の2D仮想スクロールとSQLクエリ最適化により、数万枚規模のライブラリでも滑らかなスクロールと数ミリ秒のフィルタ切替を維持します。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.2.2.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.2.2diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、ダウンロードした `Tetheract_v2.2.2diff.zip` を解凍せずにそのまま `Tetheract.exe` と同じフォルダへ置いて起動するだけで、古い不要ファイルを一掃してクリーン更新されます（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- Android版の導入・更新：PC画面「モバイル同期」のQRコード（または `android/Tetheract_Android.apk`）からインストールしてください（既存のロッカーDB・ペアリング設定・フィールドログはそのまま引き継がれます）。

---

## English

### 1. What's New in v2.2.2
- Pinpoint Folder Diff Refresh & Elimination of Full Rescans (Shared with `v1.8.11`):
  - Fixed an issue where pressing "Refresh" on a large managed folder (e.g., 50,000+ photos) with a small diff rescanned unchanged subfolders, re-checked file existence across all photos, and recalculated stacks globally. Added `refresh_folder_diff` (`diff_only: true`) to process strictly dirty directories, newly added managed subfolders, and removed folders, along with single-pass `os.scandir` pre-filtering and fast empty-directory `.xmp` sync.
- Prevention of Unmanaged Sibling Folder Drag-In on Container Parents & Drive Roots (Shared with `v1.8.11`):
  - Fixed a bug where selecting a pass-through parent folder or drive root containing both managed subfolders and unmanaged (`[Unmanaged]`) sibling folders falsely treated unmanaged folders as newly added and recursively scanned them on refresh. `scan_roots.is_recursive` now isolates diff checks strictly to managed scopes.
- Redesigned 3-Column Smartphone Bottom Bar with 86px Circular Globe GPS Dial:
  - Streamlined the phone bottom navigation into **Left `Filter` / Center 86px Circular Globe Dial / Right `Lab`**. Swiping the center dial one step up or down smoothly cycles between **`Store to Mothership (母艦に収納)` ⇄ `GPS Logger` (default) ⇄ `Camera`**, with an active green breathing ring while logging and automatic `PhoneCase` rescan upon returning from the camera.
- One-Tap Delta `Store to Mothership` & Disconnected Gray-Out Protection:
  - Tapping `Store to Mothership` immediately runs a background delta Uplink of unsent or metadata-updated `PhoneCase` photos into `Loome/case/` plus Locker delta sync, while long-pressing opens manual folder/selection settings. When the PC mothership LINK is offline, both the center dial in `Store to Mothership` mode and the manual modal's execute button are grayed out to prevent accidental offline triggers.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the 3-column bottom bar & center GPS dial, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync & `PhoneCase` Storage: Offline culling with one-tap bidirectional Wi-Fi merge, live LAN streaming at home, and one-tap delta Uplink of culled phone photos into `Loome/case/`.
- 100% Read-Only USB Drive Viewing on Android: Direct viewing of full-resolution photos and RAW previews from external USB `Loome` drives with zero writes and in-memory `Lv.1` / `Lv.2` decryption.
- Context Tether (GPS FieldLog): One-tap offline track logging from the center GPS dial or Android Quick Settings tile with non-destructive timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and 450–665x faster SQL queries for smooth 60fps scrolling on large photo libraries.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.2.2.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.2.2diff.zip`): Place `Tetheract_v2.2.2diff.zip` (unextracted) into your app folder and launch `Tetheract.exe` (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Install via the PC "Mobile Sync" QR code or directly from the `android/` folder.
