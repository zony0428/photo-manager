# 実装計画書: AI自動タグ付け機能 (AI Auto-Tagging)

Photo Manager の「USBメモリで自律動作する高速ローカル写真管理ツール」というコア原則を堅持しつつ、CPUのみで毎秒20〜30枚の高速推論を実現する「AI自動タグ付け」を設計・実装する。

---

## 1. 全体アーキテクチャ

```text
[写真スキャン / フォルダ登録]
       │
       ▼
[SQLite: photos / thumbnails]  ◀── WebPサムネイル（320px）を直接利用（RAW現像不要）
       │
       ▼
[AI推論ワーカー (バックグラウンド)]
       ├─ 画像前処理: PIL で 224x224 リサイズ ＆ 正規化 (NumPy)
       ├─ ONNX Runtime: vision_model_quantized.onnx (INT8, 約85MB) ➜ 512次元画像Embedding
       └─ コサイン類似度計算: 事前キャッシュ済みテキストEmbedding (日本語厳選50語) との内積
       │
       ▼
[SQLite: photo_tags]
       ├─ source = 'ai'
       └─ confidence = 0.85
       │
       ▼
[フロントエンド UI]
       ├─ フォルダマネージャ: [☑ 🤖 AI自動タグ付け] スイッチ
       ├─ フィルタードロワー: [すべて | 手動 | AI] 切替 ＆ [AI]🏷️ バッジ
       └─ 写真詳細インスペクタ: AIタグ表示、手動昇格ボタン、再生成ボタン
```

---

## 2. 要素技術とライブラリ

1. **推論ランタイム**:
   - `onnxruntime` (v1.20+ CPU版, MITライセンス)
   - 追加依存: `protobuf` (BSD-3-Clause), `flatbuffers` (Apache-2.0)
   - 外部GPU（CUDA/cuDNN等）一切不要、CPUのみで完全動作。

2. **ビジョンモデル**:
   - `Xenova/clip-vit-base-patch32` の `onnx/vision_model_quantized.onnx`（約85MB）。
   - INT8量子化により、モデルサイズを1/4に削減しつつ精度を維持。
   - モデルファイルは `models/clip/vision_model_quantized.onnx` に配置。存在しない場合は初回に自動ダウンロード（プログレス付き）。

3. **テキスト埋め込み（日本語厳選タグ辞書）**:
   - CLIPのテキストエンコーダで事前に埋め込みベクトル（512次元Float）を計算し、`models/clip/tags_embeddings.json`（約50KB）に保存。
   - 推論時は画像エンコーダのみを動かし、事前計算済みベクトルと行列積（NumPy `@`）を一瞬（0.001秒）で計算。

---

## 3. データベース設計変更

### `photo_tags` テーブルの拡張
```sql
ALTER TABLE photo_tags ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE photo_tags ADD COLUMN confidence REAL DEFAULT 1.0;
CREATE INDEX IF NOT EXISTS idx_photo_tags_source ON photo_tags(source);
```

- `source`: `'manual'` (手動) または `'ai'` (AI自動)
- `confidence`: 類似度スコア（0.0〜1.0）

---

## 4. 実装フェーズ詳細

### Phase 1: モデル取得・タグ辞書・推論モジュール
- `server/ai/vocabulary.py`: 日本語タグ定義（風景・シーン・被写体など約50語）
- `server/ai/model_manager.py`: モデルのダウンロード、ONNX Runtimeセッションの初期化・管理
- `server/ai/tagger.py`: WebPバイナリからのタグ付け推論ロジック

### Phase 2: DB更新・CRUD関数
- `server/database/tags.py`（または `server/database/schema.py`）:
  - マイグレーション（`source`, `confidence` カラム追加）
  - `add_photo_ai_tags(photo_id, tags_with_scores)`
  - `get_tags_summary(filter_source=None)`
  - `clear_all_ai_tags(folder_path=None)`
  - `promote_ai_tag_to_manual(photo_id, tag)`

### Phase 3: バックグラウンド実行 & APIエンドポイント
- `server/ai/worker.py`: スキャン後の未タグ写真へのバックグラウンドタグ付けワーカー
- `server/app.py`:
  - `POST /api/ai/tag-folder`: フォルダ一括AIタグ付け
  - `POST /api/ai/tag-photo`: 単一写真AIタグ付け
  - `DELETE /api/ai/tags`: AIタグ一括消去
  - `POST /api/ai/promote-tag`: 手動タグへの昇格
  - `GET /api/ai/status`: モデル状態・進捗取得

### Phase 4: フロントエンド UI/UX 実装
- `frontend/index.html`:
  - フォルダマネージャに `[☑ 🤖 AI自動タグ付け]` チェックボックス
  - 右ペイン（インスペクタ）のタグUI拡張
- `frontend/css/style.css`:
  - `[AI]🏷️` バッジスタイル（オーバーレイアイコン・パープル系グラデーション）
- `frontend/js/app.js`:
  - フィルタードロワーでのAIタグと手動タグの切り替え・表示
  - インスペクタでのAIタグ昇格・削除・再生成ハンドラー

---

## 5. 検証手順

1. **推論テスト**:
   - `python\python.exe` からサンプル画像（猫、夕焼け等）を推論し、正しいタグとスコアが返ることを確認。
   - 速度が 1枚あたり 50ms 前後であることを確認。
2. **フォルダスキャン連携テスト**:
   - フォルダマネージャで「AI自動タグ付け」をONにしてスキャンし、写真表示後にバックグラウンドでタグが生成されることを確認。
3. **UI確認**:
   - ドロワーやインスペクタで `[AI]🏷️` バッジが美しく表示されることを確認。
   - 手動昇格ボタンを押すと通常タグに変わることを確認。
   - 「AIタグ削除」を押すとAIタグだけが綺麗に消え、手動タグが残ることを確認。
