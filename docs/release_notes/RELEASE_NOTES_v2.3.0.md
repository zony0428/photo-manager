# Release Notes - v2.3.0

- **Tag**: `v2.3.0`
- **Title**: `TETHERACT pm v2.3.0 - Android連携・タッチUI・GPSフィールドログ統合版（Art Framer：プリント枠・EXIFキャプション・透かし・AIプライバシーマスク搭載）`
- **Release Date**: `2026-11-16`

---

### 概要（今回の更新と v2 系列のポイント）
- [v2.3.0 の主な変更点](#1-v230-の主な変更点) — 3ステップ作品書き出しウィザード「Art Framer」の新規搭載（外寸逆算プリセット、ローカルAIナンバープレート・顔検出＆フチのモヤ調整、プリント枠・EXIFキャプション組版・透かし合成、`thmod_` 派生画像の自動スタック＆AIタグ除外）。
- [v2 系列の主な特徴（v1.8 系列との違い）](#2-v2-系列の主な特徴v18-系列からの主な追加点) — 同梱Androidアプリ、Wi-Fiロッカー双方向同期、USB直挿し閲覧（Read-Only）、GPSフィールドログ補完、2D仮想グリッド。
- [導入とアップデート手順](#3-導入とアップデート手順) — 初回フル版ZIP、解凍不要の差分 `diff.zip`（プライバシー検出ONNXモデル同梱）、Androidアプリの導入方法（`v1.8.x` とDB・`Loome` 完全互換）。

---

## 日本語 (Japanese)

### 1. v2.3.0 の主な変更点
- **作品書き出しウィザード『Art Framer』の新規搭載（プリント枠・EXIFキャプション・透かし・プライバシーマスク統合）**：
  - 右クリックメニューの「テイクアウト」（インライン3プリセット直行ボタン付き）、拡大表示（ライトボックス）上部のテイクアウトメニュー、および右インスペクタから起動できる3ステップの書き出しウィザード **Art Framer** を搭載しました。
  - **外寸基準の逆算プリセット（`for X` / `for INSTA` / `Full Size`）**：プリント枠を含めた最終仕上がり外寸（`for X`：長辺最大 2048px、`for INSTA`：`1080×1350` 4:5 縦長または `1080×1080` 正方形、`Full Size`：元解像度基準）から内部写真の配置サイズを自動逆算し、SNS側の再圧縮による文字滲みや枠切れを防ぎます。
- **ローカルAIによる車両ナンバープレート・人物顔自動検出 ＆ 精密マスクエディタ**：
  - 外部クラウドへ写真を一切送信せず、同梱の軽量ONNXモデル（`YuNet` 顔検出 ＋ `LPD-YuNet` 4頂点ナンバープレート検出）と輪郭スナップ解析（白いバンパーと黒いグリル開口部の輝度差プロファイル解析・希望ナンバー等の文字ストローク検証）を組み合わせ、オフライン完結でナンバープレートと人物の顔を自動検出します。
  - 最大 **800% ズーム** と操作中に連動する **×3.5 指先ルーペ** を備え、遠景の小サイズプレートでも扱いやすい可変四つ角ハンドル、ボディ色を拾える「スポイト吸取」、すりガラスぼかし、境界を自然になじませる **「フチのモヤ（ソフトフェザー）」** スライダー、および境界の目立たない放射フェザー方式の「顔モヤスタンプ」に対応しています。
- **4種のプリント枠レイアウト・EXIFキャプション自動組版・透かし（ウォーターマーク）合成**：
  - `ギャラリー下余白` / `クラシック均等枠` / `フィルムコンタクト` / `枠なし` の4レイアウトと、`マット白` / `暖色バライタ` / `暗室黒` の3種類の台紙カラー、余白幅調整をリアルタイムプレビューで確認できます。
  - カメラ名・レンズ名・焦点距離・F値・シャッター速度・ISO・撮影日・任意のタイトルを組み合わせた EXIF キャプション自動組版と、テキストまたは透過 PNG ロゴによる9方向ウォーターマーク合成に対応しています。
- **`thmod_` 既定ファイル名と管理下フォルダ保存時のスマート連携**：
  - Art Framer の既定ファイル名ルールを `thmod_元のファイル名` に設定しました。書き出した画像を気に入って管理下フォルダや `Loome` へ保存した場合、EXIFを残していれば元の写真と自動でスタック編成され（同評価時は常に加工前の元写真がスタック代表を維持し、既存タグも自動継承）、EXIFを「すべて消去」した場合は独立した写真として登録されます。また、`thmod_` 派生画像は枠やマスクによる誤判定を防ぐため AI 自動タグ付け・カラー再判定から自動的にスキップされます。

### 2. v2 系列の主な特徴（v1.8 系列からの主な追加点）
PC単体安定版の `v1.8.x` 系列に対し、`v2.x` 系列には以下の機能が統合されています（`cache/library.db` と `Loome` は両系列でそのまま引き継げます）。

- 専用Androidアプリ（`Tetheract_Android.apk`）と親指タッチUI：外部ストアやクラウドを介さず同梱APK（またはQRコード）から直接導入でき、中央丸型GPSダイヤル付き下部メニュー、拡大時の親指評価ドック、ピンチ列数切替、タッチ2枚比較（Duel）、タブレット3ペイン表示を備えています。
- Wi-Fiロッカー双方向同期と『母艦に収納（PhoneCase）』：自宅Wi-Fiで指定フォルダや条件の写真をスマホ内ロッカーへ同期して外出先でオフライン選別し、帰宅後にワンタップでPCへ双方向マージできます。スマホ内の写真を事前選別してPCの `Loome/case/` へ差分転送する『母艦に収納』や、在宅時のLANライブ閲覧にも対応しています。
- 外付けUSBドライブのスマホ直挿し閲覧（100% Read-Only）：外出先で `Loome` 入りのUSBメモリやポータブルSSDをAndroid端末へ直挿しすると、ドライブへ1バイトも書き込まない完全読み取り専用のままフル解像度画像やRAWプレビューを閲覧できます（`Lv.1` / `Lv.2` 暗号化データのオンメモリ復号対応）。
- Context Tether（GPSフィールドログ）：画面中央の丸型GPSロガーボタン（またはAndroidクイック設定パネルの `FieldLog` タイル）を1タップするだけで、省電力・オフラインのまま日次軌跡を記録します。帰宅後にWi-FiでPCへ送信し、時計ズレ補正と線形補間によってGPS非搭載カメラの写真へも非破壊で撮影地を付与できます（一括取り消し・`.gpx` 入出力対応）。
- 2D仮想グリッドと5ドメイン世代キャッシュによる高速化：画面外のDOM要素を99%削減する行単位の2D仮想スクロールとSQLクエリ最適化により、数万枚規模のライブラリでも滑らかなスクロールと数ミリ秒のフィルタ切替を維持します。

### 3. 導入とアップデート手順
- 初回導入（フル版 `Tetheract_v2.3.0.zip`）：解凍して `Tetheract.exe` を起動してください（インストール不要）。
- PC版の更新（軽量差分版 `Tetheract_v2.3.0diff.zip`）：`v1.8.0` / `v2.0.0` 以降の環境では、ダウンロードした `Tetheract_v2.3.0diff.zip` を解凍せずにそのまま `Tetheract.exe` と同じフォルダへ置いて起動するだけで、古い不要ファイルを一掃してクリーン更新されます（プライバシー検出用の軽量ONNXモデルも同梱されており、`cache/`・`Loome/`・セキュリティ鍵はすべて保持されます）。
- Android版の導入・更新：PC画面「モバイル同期」のQRコード（または `android/Tetheract_Android.apk`）からインストールしてください（既存のロッカーDB・ペアリング設定・フィールドログはそのまま引き継がれます）。

---

## English

### 1. What's New in v2.3.0
- **New `Art Framer` 3-Step Export Wizard (Print Frames, EXIF Captions, Watermarks & Privacy Masks)**:
  - Added **Art Framer**, accessible from the right-click `Takeout` menu (with direct 3-preset pills), the Lightbox header dropdown, and the Right Inspector.
  - **Outer-Dimension Inverse Presets (`for X` / `for INSTA` / `Full Size`)**: Automatically calculates inner photo placement from the target outer dimensions (`for X`: up to 2048px long edge; `for INSTA`: `1080×1350` 4:5 portrait or `1080×1080` square; `Full Size`: native resolution) so borders and typography stay crisp without platform recompression artifacts.
- **100% Offline Local AI License Plate & Face Detection with Precision Canvas Editor**:
  - Combines bundled lightweight ONNX models (`YuNet` face detection + `LPD-YuNet` 4-vertex license plate detection) with classical CV contour refinement (including white-bumper vs. side-grille contrast snapping and character stroke verification) completely offline with zero cloud uploads.
  - Features up to **800% zoom**, an interactive **×3.5 magnifier loupe**, 4-corner perspective handles, canvas color eyedropper, frosted blur or solid fill, adjustable **Edge Feather (`フチのモヤ`)** blending, and radial-feathered face haze stamps.
- **4 Print Frame Layouts, Automated EXIF Caption Typesetting & Watermark Compositor**:
  - Supports `Gallery Bottom Matte`, `Classic Even Matte`, `Film Contact`, and `Frameless` layouts across `Matte White`, `Warm Baryta`, and `Darkroom Black` paper stocks with live preview.
  - Typesets selected EXIF metadata (camera, lens, focal length, aperture, shutter speed, ISO, date, custom title) and composites text or transparent PNG logo watermarks across 9 anchor positions.
- **Default `thmod_` Naming & Smart Managed-Folder Integration**:
  - Exports default to `thmod_<original_filename>`. When saved back into a managed folder or `Loome` with EXIF preserved, derivatives automatically stack under the original photo (keeping the unedited original as the stack primary on equal rating and inheriting existing tags) while stripping all EXIF keeps them independent. All `thmod_*` files are automatically skipped by AI auto-tagging and batch color re-tagging to prevent frames or masks from polluting tags.

### 2. Highlights of the v2 Series (Compared to v1.8 Standalone)
- Bundled Android App (`Tetheract_Android.apk`) & Touch UI: Direct local installation with the 3-column bottom bar & center GPS dial, fullscreen culling dock, pinch column zoom, Touch 2-Up Duel, and 3-pane tablet layout.
- Wi-Fi Locker Sync & `PhoneCase` Storage: Offline culling with one-tap bidirectional Wi-Fi merge, live LAN streaming at home, and one-tap delta Uplink of culled phone photos into `Loome/case/`.
- 100% Read-Only USB Drive Viewing on Android: Direct viewing of full-resolution photos and RAW previews from external USB `Loome` drives with zero writes and in-memory `Lv.1` / `Lv.2` decryption.
- Context Tether (GPS FieldLog): One-tap offline track logging from the center GPS dial or Android Quick Settings tile with non-destructive timestamp interpolation, clock-drift offset, batch undo, and `.gpx` import/export.
- 2D Virtual Grid & 5-Domain Cache: 99% fewer live DOM nodes and 450–665x faster SQL queries for smooth 60fps scrolling on large photo libraries.

### 3. Setup & Update Guide
- First-Time Setup (`Tetheract_v2.3.0.zip`): Extract the ZIP and run `Tetheract.exe`.
- PC Clean Update (`Tetheract_v2.3.0diff.zip`): Place `Tetheract_v2.3.0diff.zip` (unextracted) into your app folder and launch `Tetheract.exe` (includes the lightweight privacy ONNX models; `cache/`, `Loome/`, and security keys are preserved).
- Android App (`android/Tetheract_Android.apk`): Install via the PC "Mobile Sync" QR code or directly from the `android/` folder.
