# Release Notes - v2.5.2

- **Tag**: `v2.5.2`
- **Title**: `TETHERACT pm v2.5.2 - モバイル非破壊調整ダイヤル＆傾きガイドライン刷新・Art Framerプリント枠エキスパンダ整理`
- **Release Date**: `2026-11-22`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.5.2 の主な変更点](#1-v252-の主な変更点) — モバイル非破壊調整の中央 HUD 撤廃＆下部ダイヤル・写真枠内水平垂直ガイドライン・内接自動ズーム対応、モバイル版 Art Framer の余白/文字サイズ＆表示項目エキスパンダ整理。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱 Android アプリ、モバイル版 Art Framer（オンデバイス ONNX プライバシー検出）、Wi-Fi ロッカー双方向同期、USB 直挿し閲覧（Read-Only）、GPS フィールドログ補完、2D 仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版 ZIP、解凍不要の差分 `diff.zip`、Android アプリの導入・更新方法（`v1.8.x` と DB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.5.2 の主な変更点
- **モバイル版・非破壊調整 UI の刷新 ＆ 写真枠内水平垂直ガイドライン（`touch_adjust.js`）**：
  - 画面中央に数値オーバーレイを表示して被写体の確認を妨げていた `#tCanvasScrubHud` を廃止し、ビューア下部へ独立した調整コントロールストリップ（`#tAdjustControlStrip`）を新設しました。数値表示（タップでその項目のみ 0 リセット）・`−` / `＋` の 1 ステップ微調整・ガイドライン切替・長押し「元画像」比較・目盛り付き水平ダイヤルを備え、写真全体の見通しを保ったまま微調整できます。
  - 水平傾き調整の視認性を高めるため、写真領域の内側（`#mViewerPhotoFrame`）に収まる水平・垂直ガイドライン（`#tViewerLevelGrid`：3×3 三分割線 ＋ 中央基準十字線 ＋ 傾き調整中専用の 9×9 補助グリッド）を追加しました。「傾き」選択時は自動で表示され、指で傾けている間だけ補助線が明瞭化します。
  - 傾きプレビューの回転時に PC 母艦の保存処理と同じ内接自動ズーム（`autoScale`）および写真枠クリッピングを適用し、回転で四隅が欠けたり実際の書き出し結果と構図がズレたりしないようにしました。
- **モバイル版 Art Framer のプリント枠コントロール整理（`touch_art_framer.js`）**：
  - 「プリント枠・EXIFキャプションを付ける」パネル内の「余白幅」「文字サイズ」スライダ（`#mAfFrameSizeExpander`）とキャプション「表示項目」チェックボックス群（`#mAfCaptionFieldsExpander`）を、モーダル起動時に折りたたまれた状態のエキスパンダ（現在値サマリ常時表示付き）へ格納し、画面スクロール時の意図しないスライダ誤接触を防ぎました。
  - キャプション右端用のフリーテキスト欄（`#mAfCustomNoteRow`）や透かしテキスト欄はエキスパンダの外に配置したままとして、必要なときにそのまま直接入力できるようにしています。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル＋ArtFramer下部メニュー、オンデバイス `YuNet` / `LPD-YuNet` ONNXプライバシー検出、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期・UI自動ホットアップデートと『母艦に収納（PhoneCase）』：自宅Wi-Fiで写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップで双方向マージ。リンク時のUI自動更新、手許写真の事前選別とカメラアプリ連携のスマートRAW信号同期・`thmod_*` 自動スタックに対応します。
- 外付けUSBドライブのスマホ直挿し閲覧（100% Read-Only）：`Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しし、書き込みゼロのままフル解像度画像やRAWプレビュー（`Lv.1` / `Lv.2` オンメモリ復号）を閲覧できます。
- Context Tether（GPSフィールドログ）：端末GPSだけで日次軌跡を記録し、撮影時刻照合・線形補間でGPS非搭載カメラの写真へ非破壊で撮影地を付与します。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：数万枚規模でも滑らかな60fpsスクロールとミリ秒単位のフィルタ切替を実現しています。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.5.2.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.5.2diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、ダウンロードした `Tetheract_v2.5.2diff.zip` を解凍せずにそのまま `Tetheract.exe` と同じフォルダへ置いて起動するか、設定の「データベース・保守」タブ内「ソフトウェア更新 ＆ ポータブル母艦同期」から取り込んで適用してください（`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- Android版の更新：`v2.5.1` 以前の APK をお使いの場合は `android/Tetheract_Android.apk` を上書きインストールしてください（ロッカー DB・ペアリング鍵・フィールドログは保持されます。なお、既に `v2.5.1` APK を導入済みの環境ではネイティブ層の `native_revision` が共通のため、更新後の母艦との Wi-Fi 接続による UI 自動ホットアップデートでも最新の `v2.5.2` UI が反映されます）。

---

## English

### 1. What's New in v2.5.2
- **Redesigned Mobile Non-Destructive Adjustment Bar & Photo-Bounded Horizon Guidelines (`touch_adjust.js`)**:
  - Replaced the center-screen `#tCanvasScrubHud` overlay (which obscured the subject during tilt adjustments) with a dedicated bottom control strip (`#tAdjustControlStrip`) featuring tap-to-zero readout, `−` / `＋` single-step fine buttons, grid toggle, press-and-hold original comparison, and a graduated horizontal dial.
  - Added photo-bounded horizontal and vertical alignment guidelines (`#tViewerLevelGrid` inside `#mViewerPhotoFrame`: rule-of-thirds, center crosshair, and a 9×9 fine leveling sub-grid active in tilt mode) that stay level while the photo rotates with backend-matching inscribed auto-zoom (`autoScale`) clipping.
- **Collapsible Print-Frame & Caption Expanders in Mobile Art Framer (`touch_art_framer.js`)**:
  - Placed the `Border Width` and `Font Scale` sliders (`#mAfFrameSizeExpander`) and the caption display-field checkboxes (`#mAfCaptionFieldsExpander`) inside collapsed-by-default expanders with live summary text to prevent accidental slider drags while scrolling.
  - Kept the free-text custom note input (`#mAfCustomNoteRow`) and watermark text input directly accessible outside the expanders.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the center GPS dial, 1-tap Art Framer with on-device `YuNet` / `LPD-YuNet` ONNX detection, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync, Auto UI Hot-Updates & `PhoneCase`: One-tap bidirectional Wi-Fi merge, live LAN streaming, automatic UI bundle hot-updates, and role-aware `Uplink` with smart RAW signal matching.
- 100% Read-Only USB Drive Viewing on Android: Zero-write direct browsing of full-res photos and RAW previews with in-memory `Lv.1` / `Lv.2` decryption.
- Context Tether (GPS FieldLog): Offline GPS tracking with timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and instant filtering across tens of thousands of photos.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.5.2.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.5.2diff.zip`): Place `Tetheract_v2.5.2diff.zip` (unextracted) into your app folder and launch `Tetheract.exe`, or stage/apply it directly from Settings → Database & Maintenance (`cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Overwrite-install `Tetheract_Android.apk` from the PC "Mobile Sync" QR code or LAN banner when updating from `v2.5.0` or earlier (`v2.5.1` APK users also receive the `v2.5.2` UI automatically via Wi-Fi hot-update).
