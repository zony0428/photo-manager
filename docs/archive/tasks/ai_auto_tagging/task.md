# タスク管理: AI自動タグ付け機能 (AI Auto-Tagging)

## 概要
Photo Manager に、ローカル完結・軽量・高速な「AI自動タグ付け」機能を実装する。
ONNX Runtime (CPU) と軽量なビジョンモデルを活用し、DB内のWebPサムネイルを入力として、被写体やシーン（風景、猫、犬、料理、夕焼け、夜景など）を自動認識してタグ付けを行う。
手動タグとの識別性（`[AI]🏷️` バッジ）、フォルダマネージャからの自動・手動制御、および安全な一括管理（AIタグのみのクリーンアップなど）を提供する。

---

## タスクリスト

### Phase 1: AI推論バックエンド基盤
- [x] `onnxruntime` および依存ライブラリのライセンス確認と記録 (`LICENSES/`, `NOTICE.txt`)
- [x] 軽量ビジョンモデル（ONNX 約85MB）のダウンロードおよびロード機構の実装 (`server/ai/tagger.py`)
- [x] 日本語タグ辞書（厳選36語）の定義と事前計算テキスト埋め込みデータの準備 (`models/clip/tags_embeddings.json`)
- [x] サムネイル画像からの推論・タグスコアリング処理の実装 (`server/ai/tagger.py`)

### Phase 2: DBスキーマ & マイグレーション
- [x] `photo_tags` テーブルに `source` (TEXT, デフォルト 'manual') と `confidence` (REAL, デフォルト 1.0) を追加 (`server/database/schema.py`)
- [x] AIタグのCRUD・一括削除・手動タグ昇格関数の実装 (`server/database/tags.py`)
- [x] 写真取得APIで既存の文字列タグ配列を維持しつつ `tag_details` を付加 (`server/database/photos.py`)
- [x] タグ一覧取得APIで手動タグとAIタグを区別して返却 (`server/database/tags.py`)

### Phase 3: バックグラウンド実行 & APIエンドポイント
- [x] 未解析写真のバックグラウンドAIタグ付けワーカーの実装 (`server/ai/worker.py`)
- [x] APIエンドポイントの実装 (`server/app.py`):
  - `GET /api/ai/status`: AIモデル状態・解析進捗状況の取得
  - `POST /api/ai/tag-folder`: 指定フォルダの写真にAIタグ付け実行
  - `POST /api/ai/cancel`: 実行中のAIタグ付けジョブのキャンセル
  - `POST /api/ai/tag-photo/{photo_id}`: 指定写真に即座にAI推論・タグ付け実行
  - `POST /api/ai/promote-tag`: AIタグを手動タグに昇格
  - `DELETE /api/ai/tags`: AIタグの一括削除（手動タグ保護）
- [x] スキャン完了時の自動AIタグ付け連携 (`POST /api/scan` の `auto_ai_tag` フラグ)

### Phase 4: フロントエンド UI/UX
- [x] フォルダマネージャ（モーダル）に `[☑ 🤖 AI自動タグ付け]` トグルスイッチおよび進捗バーを追加 (`frontend/index.html`)
- [x] 登録済みフォルダ各行に `🤖 AIタグ` ボタンを追加 (`frontend/js/app.js`)
- [x] 写真グリッドカード上のタグバッジにAIタグ専用スタイル（`[AI]` ピルバッジ、パープルアクセント）を適用 (`frontend/js/app.js`, `frontend/css/style.css`)
- [x] 右ペイン（写真詳細インスペクタ）のタグ表示拡張:
  - AIタグのバッジ表示（信頼度スコア付き）
  - 手動タグへの昇格ボタン（`✓`）
  - 個別AIタグの削除ボタン（`✕`）
  - 「🤖 AIタグ」即時実行ボタン
- [x] ライトボックス（フルスクリーン表示）のタグ表示拡張（インスペクタと同様）
- [x] 左ペイン（フィルタードロワー「🏷️ タグ」タブ）のUI拡張:
  - タグ種別切替セグメントコントロール（`[すべて] [👤 手動] [🤖 AI]`）
  - AIタグ専用バッジ（`[AI]`）

### Phase 5: 検証・テスト
- [x] モデル初期化・推論速度のテスト（1枚あたり約22ms、毎秒45枚を記録）
- [x] 実際の写真でのタグ精度（車、昆虫、電車、人物、花、室内など）の検証
- [x] 手動タグの保護とAIタグの昇格・個別削除の検証
- [x] 全エンドポイントの総合動作検証スクリプトの作成・実行 (`scratch/verify_all.py`)
- [x] ウォークスルー文書 (`docs/ai_auto_tagging/walkthrough.md`) の作成
