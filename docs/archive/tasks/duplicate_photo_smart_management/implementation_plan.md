# 実装計画: 重複写真スマート管理（Step 2: 重複検知・サムネ共有・品質スコア代表選定・メタデータ連携）

本計画は、ユーザーからの要求に基づき、複数フォルダに同一画像が存在する環境において、
「危険な自動付け替えの完全停止」に続く **Step 2（スマートな重複連携機能）** を実現するための詳細設計書である。

---

## 1. 目的とゴール

1. **重複（同一画像・類似コピー）の確実かつ高速な検知**:
   - ファイルサイズ、Exif撮影日時、カメラ機種、解像度、および軽量フィンガープリントにより、同一画像を確実にグループ化する。
2. **サムネイル生成の高速化＆BLOB共有（大幅なリソース節約）**:
   - 別フォルダに同一画像が既に存在しサムネイル生成済みの場合、重い画像デコード・リサイズ・WebP圧縮を完全にスキップ。
   - 既存のサムネイルBLOBを高速再利用（DB内コピー）することで、スキャン時間とCPU負荷を劇的に削減する。
3. **スマート品質スコア（Quality Score）による代表選定**:
   - 「Exifの充実度」「解像度（画素数）」「解像度比ファイルサイズ（低圧縮率）」「RAW原版」を総合評価したスコアリングを実装。
   - 同一画像グループの中で、最もマスター（原版）にふさわしい写真を客観的・自動的にサジェスト可能にする。
4. **タグ・星評価・お気に入りのスマート連携**:
   - 新規写真のスキャン時、同一画像がすでにライブラリ内に存在し評価やタグが付与されている場合、それらを初期値として自動連携する。

---

## 2. アーキテクチャと設計方針

### 2.1 モジュール構成
- **新規モジュール**: `server/database/duplicates.py`
  - `find_duplicate_photo_match(file_size, date_taken, camera_model, width, height, ...)`: 同一画像の既存レコードを高速検索。
  - `compute_photo_quality_score(photo_dict)`: 品質スコア算出。
  - `get_duplicate_groups(folder_path=None)`: 重複写真グループと代表写真の一覧取得。
  - `copy_metadata_from_duplicate(source_id, target_id)`: タグ・星評価・お気に入りの連携。
- **改修モジュール**:
  - `server/database/thumbnails.py`:
    - `find_existing_thumbnail_for_duplicate(...)`: 同一画像の既存サムネイル検索。
    - `clone_thumbnail(source_photo_id, target_photo_id)`: サムネイルBLOBの高速複製。
  - `server/scanner.py`:
    - `ensure_thumbnail`: 重複写真のサムネイル即時再利用の組み込み。
    - `smart_sync_photo` / `scan_directory`: 新規写真追加時のメタデータ（タグ・星・お気に入り）連携とサムネイルスキップ処理。
  - `server/preload_thumbnails.py`:
    - 一括生成時の重複サムネイル即時コピー処理。
  - `server/app.py`:
    - 重複写真一覧・代表サジェスト確認用API（`/api/duplicates`）の追加。

---

## 3. スマート品質スコア（Quality Score）算出仕様

同一写真グループ内で「どちらが真のオリジナル（原版）か」を判別するための算出式：

$$ \text{Quality Score} = S_{\text{resolution}} + S_{\text{exif}} + S_{\text{density}} + S_{\text{format}} $$

| 項目 | 算出方法 | 重み・配点理由 |
| :--- | :--- | :--- |
| **解像度（画素数）** | $(\text{width} \times \text{height}) \div 10,000$ | 縮小コピー（SNS用等）より原寸大を確実に優先。 |
| **Exif充実度** | 撮影日時 (+20,000)<br>カメラ機種名が不明以外 (+10,000)<br>レンズ名あり (+10,000)<br>露出値 (F値, SS, ISO, 露出補正) 各+5,000<br>GPS位置情報あり (+15,000) | SNS経由や画像編集でメタデータが剥落したものを避け、カメラ撮影直後のオリジナルを特定。最大75,000点。 |
| **圧縮密度（ビットレート）** | $(\text{file\_size} \div \max(1, \text{width} \times \text{height})) \times 100,000$ | 同じ解像度でも過剰圧縮された低画質版より高画質保存されたものを優遇。 |
| **RAW原版ボーナス** | `is_raw == 1` の場合 +100,000 | RAWファイルは現像元データとして最高位に位置づける。 |

---

## 4. 実装ステップと検証項目

### Step 2.1: 重複判定・品質スコアモジュールの新設 (`server/database/duplicates.py`)
- 高速なインデックスを活用した重複検索（`idx_photos_name_size`, `idx_photos_date_taken`）。
- 単体テストで品質スコアの挙動（オリジナル vs 縮小版 vs Exif欠落版）を検証。

### Step 2.2: サムネイル共有処理の実装 (`server/database/thumbnails.py`, `server/scanner.py`)
- `ensure_thumbnail` 時に同一写真の既存サムネイルがあれば画像デコードをスキップ。
- スキャン処理の負荷測定（重複画像でCPU使用率と処理時間が劇的に低下することを確認）。

### Step 2.3: メタデータ（タグ・評価）の初期連携
- フォルダAに星5を付けた写真がある状態で、同一写真を別フォルダBにスキャンした際、フォルダBの写真にも星5とタグが自動初期設定されることを確認。

### Step 2.4: APIエンドポイントの提供 (`server/app.py`)
- 重複グループの確認・取得API（`/api/duplicates`）を追加。

---

## 6. Step 4: フォルダリフレッシュ・フォルダ絞り込みとの整合性強化

### 課題
1. **フォルダ絞り込み時の非表示問題**:
   重複スタックにおいて、代表写真（`is_stack_primary = 1`）が別フォルダに存在する場合、コピー写真（`is_stack_primary = 0`）が置かれたフォルダを開いた際に `WHERE (is_stack_primary = 1 OR stack_id IS NULL)` により写真が0件になってしまう。
2. **手動代表選定のリセット防止**:
   ユーザーがインスペクター等で同等スコアの写真同士の間で手動で代表を切り替えた後、フォルダリフレッシュが実行されるとID昇順などで元に戻ってしまう。

### 解決策
1. `server/database/photos.py`:
   `folder` が指定されている場合、`stack_type = 'duplicate'` の写真については「指定フォルダ内に代表写真が存在しない場合、フォルダ内のメンバーを代表としてフォールバック表示」するスコープ対応クエリを導入。同一フォルダ内に重複が複数ある場合も1枚に集約。
2. `server/database/stacks.py`:
   `recalculate_duplicate_stacks` において、同点スコアタイ（最高スコア）の写真の中にすでに代表（`is_stack_primary = 1`）として確立されている写真がある場合は、その既存代表を優先維持する。
