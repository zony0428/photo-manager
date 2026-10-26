# Walkthrough：ステップ3 残作業6項目の一括完遂（並列サブエージェント・オーケストレーション）

[ui-ux-diagnosis-and-roadmap.md](file:///c:/Users/zony0/Documents/photo-manager/docs/knowledge/ui-ux-diagnosis-and-roadmap.md) に残作業として記録していた未実施6項目を、ファイル競合ゼロの **3つの専門サブエージェント（🐍 Backend & DB / ⚡ Frontend JS & i18n / 🎨 Frontend HTML & CSS）** による並列オーケストレーションで一括実装・検証しました。

---

## 1. 実装した全6項目

### ① 「取り込み / storage / take_out / スマート・テイクアウト」の4重構造整理
- **入れる側の一本化 (`uploads/` ➜ `storage/`)**:
  - [server/app.py](file:///c:/Users/zony0/Documents/photo-manager/server/app.py) の `POST /api/upload`（`📥 取り込み` ボタンおよび画面へのファイルD&D）のデフォルト保存先を、従来の `uploads/` から **`storage/`（アプリ内ストレージ）** へ一本化しました（`storage/` 内のサブフォルダを開いている時はそのサブフォルダへ保存）。
- **出す側のスッキリ化（`📤 テイクアウト` メニューの2本柱化）**:
  - [frontend/index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html) の下部フローティングバーおよび右クリックの「📤 テイクアウト」メニューで、上段の **`⚡ スマート・テイクアウト...`** と **`🎞️ ベタ焼きHTML出力...`** を主役にし、下段を占領していた旧 `take_out/` フォルダ単純コピー欄を **`📂 簡易フォルダコピー (take_out/)`** の折りたたみ（`<details class="legacy-takeout-details">`）に格納しました。

### ② カメラ時計の「🕒 撮影日時の一括シフト補正（±日・時・分・秒 ＆ 元日時リセット）」
- **完全非破壊のDB日時シフト＆再スキャン保護**:
  - [server/database/schema.py](file:///c:/Users/zony0/Documents/photo-manager/server/database/schema.py) で `photos` テーブルに `original_date_taken TEXT` カラムを追加。
  - [server/database/photos.py](file:///c:/Users/zony0/Documents/photo-manager/server/database/photos.py) に [`batch_shift_photo_dates()`](file:///c:/Users/zony0/Documents/photo-manager/server/database/photos.py) を実装。初回シフト時に元のEXIF撮影日時を `original_date_taken` に自動退避し、複数回シフトしても初期値を保持します。またフォルダ再スキャン時（`upsert_photo`）もシフト済み日時が上書きされないよう保護し、`reset=True` でいつでも元のEXIF日時に100%復元できます。
- **リアルタイム5件プレビュー＆時差プリセット付きモーダル (`#dateShiftModal`)**:
  - 下部バー「`⋯ その他`」＞ **`🕒 撮影日時を一括補正...`**（または右クリックメニュー）から起動（[frontend/js/selection.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/selection.js)）。
  - `＋ 進める` / `－ 戻す` と「日・時間・分・秒」入力、および `-9時間` / `-1時間` / `-15分` / `+15分` / `+1時間` / `+9時間` のワンクリックプリセットを備え、先頭5件の「変更前 ➜ 変更後」をリアルタイム確認しながら適用・復元できます。

### ③ 左サイドバー「🗺️ ジオタグ」と「🧪 ラボ」の機能仕分け整理
- [frontend/index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html) の「🗺️ ジオタグ」ツールバー左側に **`🗾 制覇マップ`** ボタン（`#locationOpenMapBtn`）を配置し、地理系機能を「🗺️ ジオタグ」へ集約しました。
- 「🧪 ラボ」から重複ボタンを整理し、**`📊 撮影カルテ・選別発掘`**（勝ちレンズカルテ / 未整理ガチャ / 2枚比較）と **`🔭 光線・露出・記念日スマート抽出`**（歴代の今日 / マジックアワー / ブルーアワー / 夜景・星景 / 手ブレ注意）の2グループ構造に整理しました。

### ④ 上部メインヘッダー（`.app-header`）と `.view-header` の省スペース・レスポンシブ最適化
- [frontend/css/style.css](file:///c:/Users/zony0/Documents/photo-manager/frontend/css/style.css) に `@media (max-width: 1440px)` ルールを追加し、ノートPC等の画面幅でもツールバーが2行に折り返さず1行に美しく収まるようボタン余白・スライダー幅（`70px`）・セレクト幅を最適化しました。

### ⑤ シャッター速度順ソート（高速→低速 ／ 低速→高速）の追加（全14種）
- [server/database/photos.py](file:///c:/Users/zony0/Documents/photo-manager/server/database/photos.py) の `_shutter_speed_seconds_sql()` を活用し、分数表記（`"1/2000"` 等）と小数表記（`"0.5"` 等）を秒数換算して並べる `shutter_fast`（高速→低速）および `shutter_slow`（低速→高速）を追加しました。

### ⑥ 属性フィルタの細分化オプション（`🖼️ JPEG/一般のみ` / `🔗 RAW+JPGペア` / `📄 XMPあり`）
- `.view-header` の `[すべて]` `[RAW]` `[✂ 調整済]` ピルの右隣に、同じ高さ（`26px`）・角丸（`5px`）に統一された詳細属性セレクト（`#attrSubFilterSelect`）を追加し、JPEG単体・RAW+JPGペア・XMPサイドカー付き写真をワンクリックで抽出できるようにしました。

---

## 2. 統合検証結果（`verify_step3.py`）

自動検証スクリプトを実行し、バックエンドDB・API・フロントエンド契約のすべてがパスすることを確認しました：
- `batch_shift_photo_dates`: `+1時間` シフト ➜ `-15分` 累積シフト（`original_date_taken` 維持） ➜ 再スキャン時のシフト日時保護 ➜ `reset=True` による元日時復元：すべて正常
- `shutter_fast` (`1/2000` → `1/50` → `0.5`) ＆ `shutter_slow` (`0.5` → `1/50` → `1/2000`)：すべて正常
- `attr_filter` (`jpeg`, `raw_pair`, `xmp`)：すべて正常
- `POST /api/photos/batch-shift-date` ＆ `POST /api/upload` (`storage/` 保存先統一)：すべて正常
- HTML / JS / CSS / i18n 全17個のDOM IDおよび翻訳辞書整合性：すべて正常
