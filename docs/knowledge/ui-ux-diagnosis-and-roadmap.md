# Photo Manager - UI/UX 総合診断・機能配置整理 ＆ ステップ1〜3完全実装記録 (v2.44+)

本ドキュメントは、Photo Manager において段階的な機能追加に伴って発生していた「機能重複・ボタン過密・導線のねじれ」および「定番写真管理ソフト（Picasa / Tiat / FastStone / Lightroom / Eagle 等）との比較による基本操作のミッシングリンク」を総合診断し、**ステップ1（UIの交通整理）・ステップ2（基本ビューア体験の強化）・ステップ3（残作業6項目の一括完遂）**としてすべて実装・解決した設計記録（KI）である。

---

## 1. 【ステップ1】UIの交通整理（引き算・再配置）— 完了

1. **上部ヘッダーの整理 ＆ フォルダ欄への「📥 取り込み」移設**:
   - 上部ヘッダー右側の「📥 取り込み」ボタンを廃止し、左サイドバー「📁 フォルダ」ツールバー先頭へ移設（ドラッグ＆ドロップ取り込みは画面全体で維持）。
   - 上部ヘッダー右端のシステムボタン群（`📱 スマホ連携` / `⚙️ 設定` / `❓ ヘルプ` / `⏻ 終了`）をアイコンボタン化して視覚的ノイズを削減。
2. **左サイドバー「🔍 ファイル名検索」の最下部配置 ＆ 案内テキストサイズ統一**:
   - 「各種フィルタの組み合わせでビジュアル的に絞り込むアプリ」というコア思想に基づき、`🔍 ファイル名検索` を左サイドバー最下部（セクション8）へ配置。
   - 左ペイン内の操作案内・補助テキスト（`.tag-filter-hint`, `.tag-filter-mode-bar`, `.tag-mode-hint`, `.sidebar-hint-text`, `.empty-hint`, `.folder-tree-hint`, `.preset-empty-chip`, `.preset-empty-message`, `.location-empty`）をすべて小さい方のサイズ（`0.65rem`）に統一。
   - ジオタグ欄・カメラ欄・ラボ欄のミニボタン（`.btn-mini-text`）およびツールバー配置（`.location-toolbar`）をフォルダ欄と完全統一。
3. **右インスペクタ（`#inspectorPane`）へのクイックアクションバー新設**:
   - プレビュー画像直下に `[✂ 調整]` `[📊 波形]` `[↺]` `[↻]` の4ボタン（`#inspectorQuickActionsBar`）を常設し、詳細タブを開かなくても1クリックで非破壊調整・ヒストグラム・90°回転へアクセス可能に改善。
4. **下部フローティング選択バー（`#selectionFloatingBar`）のボタン過密解消**:
   - 使用頻度の低いメンテナンス系操作（`🔄 サムネイル更新` / `🕒 撮影日時を一括補正...` / `📍 ジオタグ準用 (スマホGPS)` / `🗑️ ジオタグ情報を削除`）を「`⋯ その他`」ポップオーバー（`#floatingMorePopover`）へ集約し、ゴミ箱アイコン2個並びによる誤操作リスクを解消。

---

## 2. 【ステップ2】基本ビューア体験の強化（他ソフト比較での弱点解消）— 完了

1. **一覧グリッド画面での矢印キー移動（`←` `→` `↑` `↓`）＆ `Shift + 矢印` 範囲選択**:
   - `frontend/js/app.js` に `navigateGridSelection()` を実装し、グリッド列数の動的計算による上下左右移動、`Shift + 矢印` による連続範囲選択、ビューポート内への自動スクロール追従、右インスペクタ即時連動を実現。
2. **画像調整モーダル（`#imageAdjustModal`）の「👁️ 元画像と比較」＆トーン調整のコピー/一括ペースト**:
   - ヘッダーの `[👁️ 元画像と比較]` ボタン長押しまたは `\` キー押下中、回転・傾き・クロップ・トーン補正を一時解除して元画像（Before）を確認可能に。
   - `[📋 調整コピー]`（`Ctrl+Shift+C`）および `[📥 調整ペースト]`（`Ctrl+Shift+V`、一覧・ライトボックス・右クリックからの複数枚一括ペースト対応、`POST /api/photos/batch-tone`）を実装。
3. **`Ctrl + C` で写真をクリップボードに画像コピー**:
   - 一覧グリッド・ライトボックス・右クリックメニュー（`📋 画像をクリップボードにコピー (Ctrl+C)`）から、非破壊調整反映済みの画像を PNG Blob として OS クリップボードへ即座にコピー可能に。
4. **ソート順拡充 ＆ ビューヘッダー属性フィルタピル（`すべて` / `RAW` / `✂ 調整済`）**:
   - `.view-header` に `[すべて]` `[RAW]` `[✂ 調整済]` ピル（`#attrFilterToggles`）を新設し、右隣の `評価フィルタ: [優] [良] [可] [棄]` とボタン高さ（`26px`）・角丸（`5px`）・枠線トーンを完全統一。

---

## 3. 【ステップ3】残作業6項目の一括完遂（並列サブエージェント・オーケストレーション）— 完了

### ✅ 完了1：「取り込み / storage / take_out / スマート・テイクアウト」の4重構造の整理・統合
- **入れる側の一本化 (`uploads/` -> `storage/`)**:
  - `server/app.py` (`api_upload_files`) のデフォルト保存先を従来の `UPLOADS_DIR` (`uploads/`) から **`STORAGE_DIR` (`storage/`)** に統一（選択中フォルダが `storage/` サブフォルダの場合はそのサブフォルダへ保存）。これにより「📥 取り込み」や外部ファイルD&Dで取り込んだ写真もすべて `storage`（アプリ内ストレージ）で一元管理・移動・リネーム可能になった。
- **出す側のスッキリ化 (`📤 テイクアウト` メニューの2本柱化)**:
  - `frontend/index.html` (`#floatingImportPopover`, `#contextImportSubmenu`) において、上段の主役2ボタン（`⚡ スマート・テイクアウト...` / `🎞️ ベタ焼きHTML出力...`）を目立たせ、下段の旧 `take_out/` フォルダ単純コピーUIを `<details class="legacy-takeout-details"><summary class="legacy-takeout-summary">📂 簡易フォルダコピー (take_out/)</summary>...</details>` に格納してデフォルト折りたたみ化。

### ✅ 完了2：カメラ時計の「撮影日時の一括シフト補正（±○時間○分 / タイムゾーン補正 ＆ 元日時リセット）」
- **完全非破壊のDB日時シフト方式**:
  - `server/database/schema.py`: `photos` テーブルに `original_date_taken TEXT` カラムを自動マイグレーション追加。
  - `server/database/photos.py`: `batch_shift_photo_dates(photo_ids, offset_seconds, reset)` を実装。初回シフト時に元の `date_taken` を `original_date_taken` に退避し、複数回シフトしても最初のEXIF日時を保持。さらに再スキャン時（`_UPSERT_PHOTO_SQL`）もシフト済み日時が上書きされないよう保護し、`reset=True` でいつでも初期状態へ100%復元可能にした。
  - `server/app.py`: `POST /api/photos/batch-shift-date` エンドポイントを追加。
  - `frontend/index.html` & `frontend/js/selection.js`: 下部バー「⋯ その他」および右クリックメニューから起動する `#dateShiftModal` を実装。`Date.toISOString()` を使わないローカルタイム計算（`_formatShiftedDateLocal`）による先頭5件のリアルタイム変更前後プレビュー、`±15分` / `±1時間` / `±9時間` のワンクリックプリセット、および `↩️ 元のEXIF日時に戻す` 復元ボタンを搭載。

### ✅ 完了3：左サイドバー「🧪 ラボ」と「🗺️ ジオタグ」の機能仕分け・再編成
- `frontend/index.html`:
  - 「🗺️ ジオタグ」セクション上部のツールバー（`#locationToolbar`）に **`🗾 制覇マップ`** ボタン（`#locationOpenMapBtn`）を配置し、地理系ナビゲーションを集約。
  - 「🧪 ラボ」セクション内から重複ボタンを整理し、**「📊 撮影カルテ・選別発掘」**（勝ちレンズカルテ・未整理ガチャ・2枚比較）と **「🔭 光線・露出・記念日スマート抽出」**（歴代の今日・マジックアワー・ブルーアワー・夜景・手ブレ注意）の2グループ構造に明確化。

### ✅ 完了4：上部メインヘッダー（`.app-header`）とビューヘッダー（`.view-header`）の省スペース・レスポンシブ最適化
- `frontend/css/style.css`: `@media (max-width: 1440px)` メディアクエリを追加し、ノートPC等の画面幅（1280px〜1440px）でも上部ツールバーや `.view-header` が2行に折り返さず美しく1行に収まるよう、パディング・スライダー幅（`70px`）・セレクト幅を最適化。

### ✅ 完了5：シャッター速度順ソート（`shutter_fast`: 高速→低速 ／ `shutter_slow`: 低速→高速）の追加
- `server/database/photos.py`: `_shutter_speed_seconds_sql("p.shutter_speed")` によるSQL分数→秒数換算式を `ORDER BY` 句に適用し、`shutter_fast`（高速→低速、NULLは末尾）と `shutter_slow`（低速→高速、NULLは末尾）を実装。
- `frontend/index.html` の `#sortBySelect` に2項目を追加し、全14種類のソート順を実現。

### ✅ 完了6：属性フィルタの細分化オプション（`jpeg` / `raw_pair` / `xmp`）
- `server/database/photos.py`: `attr_filter` に `jpeg`（JPEG/一般のみ）、`raw_pair`（RAW+JPGペアのみ）、`xmp`（`has_xmp == True`、ディレクトリキャッシュによるO(1)サイドカー判定）を追加。
- `frontend/index.html` & `frontend/css/grid-lightbox.css` & `frontend/js/app.js`: `.view-header` の `[すべて]` `[RAW]` `[✂ 調整済]` ピルの右隣に、同じ高さ（`26px`）・角丸（`5px`）に統一された詳細属性サブセレクト `#attrSubFilterSelect`（`🖼️ JPEG/一般のみ` / `🔗 RAW+JPGペア` / `📄 XMPあり`）を配置し、ピルと相互排他連動。

---

## 4. 関連ドキュメント・参照先
- **ステップ1（UIの交通整理）設計・検証記録**: `docs/ui_layout_declutter_step1/`
- **ステップ2（基本ビューア体験の強化）設計・検証記録**: `docs/viewer_ux_enhancement_step2/`
- **ステップ3（残作業6項目の一括完遂）設計・検証記録**: `docs/step3_backlog_completion/`
- **機能別コードマップ**: [feature-code-map.md](feature-code-map.md)
