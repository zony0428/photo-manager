# アプリ内ストレージ (`storage/`) 完結管理 ＆ XMPサイドカー非破壊連携アーキテクチャ (v2.42+)

本ドキュメントは、Photo Manager におけるアプリ内ストレージ（`storage/`）のファイル・フォルダ管理、付随サイドカー/ペアRAWの自動追従、および外部現像ソフト（Lightroom / Adobe Camera Raw 等）の `.xmp` サイドカーファイルとの非破壊連携・プレビュー設計を記録した技術ナレッジである。

---

## 1. `storage/`（アプリ内ストレージ）完結管理と自動マイグレーション

### 設計背景
外部ドライブやPC内フォルダの写真に対しては「元のファイル・フォルダ構造に1バイトも手を触れない（完全非破壊）」原則を守る一方、アプリ内にコピーして持ち歩く専用領域 **`storage/`**（旧称 `carry/`）内の写真については、エクスプローラーを開かずにアプリUI上だけでフォルダ整理・ファイル名変更・外部書き出しまで完結できる設計とした。

### 自動移行（`carry/` ➔ `storage/`）
- 起動時（`server/app.py` の `_migrate_carry_to_storage()`）に旧 `carry/` フォルダが存在する場合、`storage/` へ自動統合し、DB内の `photos.file_path` / `photos.directory_path` / `managed_folders.folder_path` のパス参照も一括で `storage/` へマイグレーションする。
- 旧APIエンドポイント（`/api/carry-folders` 等）も内部で新エンドポイント（`/api/storage-folders`）へ委譲し、後方互換性を維持している。

### 主な機能とエンドポイント (`server/app.py`)
1. **インポート (`POST /api/photos/import-to-storage`)**:
   - 選択した写真を `storage/<サブフォルダ>` へコピーし、その場でスキャン＆DB登録。
   - 元写真の評価（`rating`）・非破壊調整パラメータ・GPS座標（コピー/準用分）・手動/AIタグ（`photo_tags`）を新レコードへ完全引き継ぎ。
2. **storage内での移動 (`POST /api/storage/move-photos`)**:
   - `storage/` 内の写真を別の `storage` サブフォルダへ物理移動（左サイドバーの `storage` フォルダツリーへのドラッグ＆ドロップにも対応）。
   - `os.replace` 実行後、`update_photo_file_location()` により `photo_id` やサムネイルキャッシュを維持したままDBパスを更新し、スタックも自動再計算。
3. **ファイル名変更 (`POST /api/storage/rename-photo`, `POST /api/storage/batch-rename-photos`)**:
   - `storage/` 内の写真のみ <kbd>F2</kbd> キー（またはインスペクタ/右クリック）を有効化。
   - **単一リネーム**: 拡張子を固定保護したベース名変更（同名ペアの RAW+JPG は拡張子違いで同時リネーム）。
   - **一括連番リネーム**: 選択写真を撮影日時昇順（ミリ秒精度）でソートし、3つのルール（① `YYYYMMDD_HHMMSS_連番` / ② `YYYYMMDD_元ファイル名` / ③ `自由な接頭辞_連番`）とリアルタイムプレビュー付きで一括変更。2パスの一時ファイル経由リネームにより、既存ファイル名との衝突事故を防止。
4. **サブフォルダ管理 (`POST /api/storage-folders`, `PUT /api/storage-folders/rename`, `DELETE /api/storage-folders`, `POST /api/storage-folders/export`)**:
   - サブフォルダの新規作成・名前変更（配下全写真のDBパス一括更新）・空フォルダ削除・指定外部フォルダへの丸ごとエクスポートに対応。

---

## 2. サイドカーファイル (`.xmp` 等) ＆ ペアRAWの自動追従

カメラや現像ソフトが生成するサイドカーファイル（`.xmp`, `.acr`, `.pp3`, `.dop`, `.cos`, `.on1`, `.pto`, `.thm`, `.ctg`）およびペアRAWファイルが、写真の移動やリネームで迷子にならないよう、`server/app.py` の `_find_companion_sidecars(file_path)` で自動検出・追従させる。

- **命名パターン両対応**:
  - `<stem>.xmp`（例: `DSC0001.xmp`）
  - `<filename>.xmp`（例: `DSC0001.ARW.xmp`）
  - 同一親フォルダ内の `RAW/` サブフォルダ等に分離保存されたペアRAWと、そのRAWに付随するサイドカーも自動走査。
- **追従タイミング**:
  - `storage/` へのインポート時（コピー追従）
  - `storage/` 内でのサブフォルダ移動時（移動追従）
  - `storage/` 内での単一・一括連番リネーム時（新ファイル名に合わせてサイドカー名も自動リネーム追従）
  - `storage/` フォルダの外部エクスポート時（コピー追従）

---

## 3. XMPサイドカー非破壊連携 (`server/xmp_sidecar.py`)

### 設計ポリシー：「混ぜない・壊さない・比較できる」
外部現像ソフトの `.xmp` サイドカーが存在する場合でも、**Photo Manager 自身の評価や非破壊調整、手動タグツリーに無断で上書き・混入させない**ことを最優先とする。

### 3-1. `[👁️ XMPプレビュー]` ホールド比較（長押し中だけXMP調整を表示）
- **バックエンド (`server/xmp_sidecar.py` + `GET /api/photo/{photo_id}/xmp-preview`)**:
  - 標準ライブラリの `xml.etree.ElementTree` のみで `.xmp`（属性形式および子要素形式の双方）を高速パース。
  - Camera Raw パラメータ（`crs:Exposure2012`, `crs:Contrast2012`, `crs:Saturation`, `crs:Vibrance`, `crs:CropTop/Left/Bottom/Right`, `crs:CropAngle`, `tiff:Orientation`）を Photo Manager の描画パイプライン（`apply_photo_adjustments_pil()`）のスケールへ変換し、オンデマンドでプレビューWebP画像を返却する（DBは一切書き換えない）。
- **フロントエンド (`frontend/js/inspector.js` の `_bindXmpSidecarControls`)**:
  - 右インスペクタのプレビュー枠下に `📄 XMP` バッジと **`[👁️ XMPプレビュー]`** ボタンを表示。
  - ボタンを押している間（` pointerdown` / `mousedown` / `touchstart`）だけ、Photo Manager の調整を一時オフにして XMP 調整適用後の画像へ差し替え、指を離すと即座に元の表示へ復帰する。
  - プレビュー切り替え中はインスペクタのRGBヒストグラムおよび開いているライトボックス画像もリアルタイム連動して切り替わる。

### 3-2. `📥 評価・タグ取込`（`XMP/...` ルート隔離）
- **`POST /api/photo/{photo_id}/xmp-import` / `POST /api/photos/batch-xmp-import`**:
  - **評価マッピング**: `xmp:Label="Rejected"` または `crs:Pick="-1"` は `3`（棄）、`xmp:Rating >= 4` または `Pick="1"` は `5`（優）、`Rating >= 2` は `4`（良）、`Rating == 1` は `0`（可）へ変換。
  - **階層タグの隔離取り込み**: `dc:subject` および Lightroom の階層キーワード `lr:hierarchicalSubject`（`親|子` 形式）は、すべて **`XMP/親/子`** のように **`XMP/` ルート配下**へプレフィックスを付与して登録する。これにより、ユーザーが育てた既存のタグツリーと外部ソフトのタグが混ざって散らかるのを防ぐ。

### 3-3. スマート・テイクアウトでの `.xmp` サイドカー同時出力
- スマート・テイクアウト（`#smartTakeoutModal` の `#takeoutExportXmp`）で「📄 XMPサイドカー (.xmp) も一緒に出力する」を有効にすると、`server/xmp_sidecar.py` の `generate_xmp_sidecar_xml()` により、書き出し画像と同名の `.xmp` ファイルを生成する（4段階評価、`XMP/` プレフィックスを除いた階層タグ、GPS座標、非破壊調整値を Adobe Camera Raw / Lightroom 互換形式で出力）。
