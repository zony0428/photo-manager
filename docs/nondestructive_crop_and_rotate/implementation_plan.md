# 実装計画書: 非破壊画像調整（90度回転・X/Twitter風クロップ調整）

## 1. 目的と設計思想
Photo Manager は「元ファイルを1バイトも汚さない（タイムスタンプも変更しない）」という非破壊原則を貫いている。
本改修では、スマホや古いデジカメの誤った向き判定によって横倒しになった写真を即座に正位置へ修正できる「爆速90度回転」と、構図を直感的にトリミングできる「Twitter (X) 風の画像調整モーダル」を導入する。
これにより、将来予定している「テイクアウト時のリサイズ・リネーム連携（マーシャリング・エクスポート）」の基礎となる。

## 2. 変更対象コンポーネント

### (1) バックエンド (Python / SQLite)
- **`server/database/schema.py`**:
  - `photos` テーブルへのカラム追加マイグレーション：
    - `rotation`: `INTEGER DEFAULT 0` (0, 90, 180, 270)
    - `crop_x`: `REAL DEFAULT NULL` (0.0〜1.0)
    - `crop_y`: `REAL DEFAULT NULL` (0.0〜1.0)
    - `crop_w`: `REAL DEFAULT NULL` (0.0〜1.0)
    - `crop_h`: `REAL DEFAULT NULL` (0.0〜1.0)
    - `crop_aspect`: `TEXT DEFAULT NULL` ('original', '1:1', '16:9', '4:3', '3:2', 'free')
- **`server/database/photos.py`**:
  - `update_photo_adjustments(photo_id, rotation, crop_x, crop_y, crop_w, crop_h, crop_aspect) -> bool`
  - `rotate_photo(photo_id, delta_degrees=90) -> Dict[str, Any]`
  - `reset_photo_adjustments(photo_id) -> bool`
  - `batch_rotate_photos(photo_ids, delta_degrees=90) -> int`
- **`server/scanner.py`**:
  - サムネイル生成関数 `render_thumbnail_webp` で、引数またはメタデータに応じた回転・クロップ切り抜きを適用
- **`server/app.py`**:
  - `POST /api/photo/{photo_id}/rotate`
  - `POST /api/photos/batch-rotate`
  - `POST /api/photo/{photo_id}/adjust`
  - `POST /api/photo/{photo_id}/adjust/reset`
  - サムネイルETag生成に `rotation` と `crop` のハッシュ値を付与

### (2) フロントエンド (Vanilla JS / CSS / HTML)
- **`frontend/index.html`**:
  - `#imageAdjustModal` のHTML構造追加（プレビューキャンバス、クロップオーバーレイ、三分割線、比率セレクタ、回転ボタン、リセット、保存）
  - 右インスペクタおよびライトボックスに回転・調整ボタン追加
- **`frontend/css/style.css`**:
  - Hinomaru Ink UI準拠のモーダル、三分割グリッド、8点リサイズハンドル、比率ボタンスタイリング
- **`frontend/js/adjust.js` (新規作成)**:
  - Twitter風の直感的クロップ操作エンジン（ドラッグ移動、ハンドルドラッグ、アスペクト比拘束、三分割線描画、回転アニメーション）
- **`frontend/js/lightbox.js`**:
  - ライトボックス表示時の回転CSS適用、キーボードショートカット連携
- **`frontend/js/inspector.js`**:
  - インスペクタ上のプレビュー回転・回転ボタン配置
- **`frontend/js/selection.js`**:
  - 複数選択フローティングバーおよび右クリックメニューへの回転項目追加
- **`frontend/js/app.js`**:
  - グローバルキーボードショートカット `R`（時計回り90度）/ `L`（反時計回り90度）のバインド、サムネイル描画への回転反映

### (3) ドキュメンテーション & バージョン
- **`VERSION`**: `2.11` → `2.12`
- **`MANUAL.md`**: 操作マニュアル更新
- **`frontend/index.html`**: `#helpModal` 更新

## 3. 検証手順
1. **DBマイグレーション検証**: サーバー起動時に `photos` テーブルに新カラムがエラーなく追加されること。
2. **回転動作検証**:
   - 一覧表示で写真を選び `R` キーで90度回転 → 0遅延でサムネイルが回転し、DBに保存されること。
   - `L` キーで反時計回り回転。
   - ライトボックスで開き、`R` / `L` で回転 → ズームやパンが正常に動作すること。
   - 複数写真を選択し、フローティングバーから一括回転できること。
3. **X風画像調整モーダル検証**:
   - 「✂ 調整」ボタンでモーダルがスムーズに開くこと。
   - 比率プリセット（1:1, 16:9, 4:3, 自由）を切り替えたとき、クロップ枠が比率を維持してリサイズできること。
   - クロップ枠をドラッグして構図を選べること。
   - 「回転」ボタンでモーダル内でも90度回転すること。
   - 「適用」で保存され、一覧およびライトボックスに即座に反映されること。
   - 「リセット」で元の未編集状態に戻ること。
4. **元画像の非破壊検証**: 元のJPEG/RAWファイルのMD5ハッシュおよび更新日時（mtime）が一切変化していないことを確認。
