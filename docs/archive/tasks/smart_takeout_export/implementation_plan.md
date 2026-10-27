# スマート・テイクアウト（高機能エクスポート / マーシャリング）実装計画書

## 1. 概要 & 目的
Photo Manager の「元画像完全非破壊」思想を堅持しつつ、ユーザーが選別した写真を相手への納品、SNS/Web投稿、ブログ、知人共有などに活用できるよう、**回転・クロップ・リサイズ・リネーム・Exifメタデータ制御（撮影条件・カメラ情報・位置情報の選択的消去）** をワンストップで一括処理して出力する「スマート・テイクアウト（高機能エクスポート / マーシャリング）」を構築する。

---

## 2. 要件定義

### 2.1 ユーザー要件
1. **非破壊調整の適用（6番連携）**:
   - カタログDBに保存されている回転角度（`rotation`）およびクロップ範囲（`crop_x, crop_y, crop_w, crop_h`）を元画像に適用して切り抜き・正立出力。
   - クロップや回転を施していない写真はそのまま等倍または指定リサイズで出力。
   - RAW単体写真（Sony ARW, Canon CR2/CR3, Nikon NEF, Fujifilm RAF等）も、高解像度プレビューから美しいJPEGとして自動現像出力。
2. **リサイズ・解像度制御（3番）**:
   - オリジナル解像度（等倍）
   - 長辺 2048px（Web / SNS標準推奨）
   - 長辺 1920px（Full HD）
   - 長辺 1280px（軽量共有）
   - カスタム長辺指定（例: 2400px）
3. **書き出し時ファイル名ルール（4番：元ファイル無傷）**:
   - 元のファイル名のまま（例: `DSC01234.jpg`）
   - 撮影日時 ＋ 元ファイル名（例: `20261013_143000_DSC01234.jpg`）
   - 撮影日時 ＋ 連番（例: `20261013_001.jpg`）
   - 自由プレフィックス ＋ 連番（例: `小樽旅行_001.jpg`）
   - ※ 同名ファイルが保存先に存在する場合は自動ナンバリング（`_1`, `_2`）で上書き回避。
4. **Exifメタデータの選択的消去制御（★ユーザー特別要望）**:
   - チェックボックスで「消す情報」を選択（すべてOFFならExifは全部残す）：
     - `[ ] 📍 位置情報（GPS座標）を消去`（SNS投稿時のプライバシー保護）
     - `[ ] ⏱️ 撮影条件（SS・F値・ISO・露出・焦点距離）を消去`
     - `[ ] 📷 カメラ・レンズ情報（機種名・レンズ型番・シリアル等）を消去`
     - `[ ] 🗑️ その他すべてのメタデータを消去`（完全クリーン化）
5. **出力形式・品質**:
   - JPEG（品質 90% 標準） / WebP
6. **保存先**:
   - 従来の `take_out/` フォルダ配下のサブフォルダ、または任意の出力先フォルダ（Windowsフォルダ選択ダイアログ）

---

## 3. アーキテクチャ設計

### 3.1 バックエンド (`server/exporter.py`)
- **外部依存ライブラリ追加なし**（Pillow + 標準ライブラリで完結。GPL感染リスクゼロ）。
- **Exifタグフィルタリングロジック**:
  - `Pillow` の `image.getexif()` を使用。
  - **GPS消去**: IFD `0x8825` (GPSInfo) を削除。
  - **撮影条件消去**: Exif IFD (`0x8769`) 内の `ExposureTime (0x829a)`, `FNumber (0x829d)`, `ISOSpeedRatings (0x8827)`, `ExposureBiasValue (0x9204)`, `FocalLength (0x920a)` 等を削除。
  - **カメラ情報消去**: 0th IFD 内の `Make (0x010f)`, `Model (0x0110)`, `Software (0x0131)`, `Artist (0x013b)`、Exif IFD 内の `LensModel (0xa434)`, `BodySerialNumber (0xa431)` 等を削除。
  - **全消去**: `exif=None` で保存。
  - **全保持**: すべてのチェックボックスがOFFの場合、オリジナルのExifバイナリを完全維持。
- **画像パイプライン**:
  1. 元画像ファイル（またはRAW埋め込みフルサイズプレビュー）を読み込み。
  2. `photo.rotation` があれば Pillow の `Image.Transpose` で回転。
  3. `photo.crop_*` があれば画像の実解像度に合わせてピクセル矩形を計算し、`image.crop(...)` で切り抜き。
  4. 指定長辺に合わせて `image.resize(..., Image.Resampling.LANCZOS)` で高品質縮小。
  5. フィルタリング済みExifを付与して保存。

### 3.2 APIエンドポイント (`server/app.py`)
- `POST /api/export/smart`:
  - リクエストパラメータ:
    ```json
    {
      "photo_ids": [1, 2, 3],
      "apply_adjustments": true,
      "resize_mode": "original" | "2048" | "1920" | "1280" | "custom",
      "custom_long_edge": 2400,
      "format": "jpeg" | "webp",
      "quality": 90,
      "naming_rule": "original" | "date_original" | "date_seq" | "prefix_seq",
      "prefix": "小樽旅行",
      "exif_remove_gps": true,
      "exif_remove_exposure": false,
      "exif_remove_camera": false,
      "exif_remove_all": false,
      "destination_mode": "takeout" | "custom",
      "subfolder_name": "SNS投稿用",
      "custom_dir_path": ""
    }
    ```
  - レスポンス: 書き出し成功枚数、スキップ数、エラー一覧、出力先パス。
- `POST /api/export/select-dir`:
  - Windows のフォルダ選択ダイアログ（PowerShell または ctypes / tkinter）を前面に出して任意の保存先パスを取得。

### 3.3 フロントエンド (`frontend/js/takeout.js`, `index.html`, `style.css`)
- 下部フローティングバーの「📤 テイクアウト」または右クリックメニュー「📤 テイクアウト」をクリックすると、美しい **スマート・テイクアウトモーダル（`#smartTakeoutModal`）** が開く。
- カード型ラジオボタングループ（リサイズ・リネーム・形式）と、ご要望の「消す情報を選ぶ」Exifチェックボックス群を配置。
- 「エクスポート開始」ボタンを押すと、リアルタイムに進捗バーが表示され、完了後に「📁 フォルダを開く」ボタンでエクスプローラーから即座に確認可能。
- 設定内容は `localStorage` に自動保存され、次回も同じ設定が引き継がれる。

---

## 4. 検証計画
1. **JPEG/RAW両方での書き出し**:
   - RAWファイルも問題なく回転・クロップされたJPEGとして書き出されることを確認。
2. **Exif消去の網羅テスト**:
   - GPSのみ消去時: 撮影条件やカメラ名は残り、GPS座標だけが消えていることを確認。
   - 撮影条件のみ消去時: カメラ名やGPSは残り、F値やSSが消えていることを確認。
   - 全部OFF時: 元のExifが完全に維持されていることを確認。
3. **ファイル名とナンバリング**:
   - 撮影日時順の連番、同名衝突時の自動ナンバリング確認。
