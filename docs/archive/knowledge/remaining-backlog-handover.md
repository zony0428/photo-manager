# Tetheract Photo Manager - 残課題・今後の構想 引き継ぎ設計書 (Remaining Backlog & Handover)

本ドキュメントは、v1.8.3（Android専用アプリ・Wi-Fi自動発見＆双方向ロッカー同期・タッチUI刷新）完了時点において、**未実装のまま残されている機能群（Android版の4原則パリティ残課題 ＆ `README.md`「今後の構想」5項目）**を整理し、次期開発セッションで迷わず実装に着手できるよう対象ファイルと実装指針をまとめた引き継ぎ資料である。

---

## 1. v1.8.3 時点で実装完了済みの範囲（前提確認）

以下の機能はすでに PC母艦 ⇄ Androidロッカー（USB SAF ＆ Wi-Fi LAN の両経路）でエンドツーエンド実装・テスト済みである：

1. **Wi-Fi ゼロコンフィグ自動発見 ＆ ワンタップ認証（USBケーブルレス同期）**:
   - UDP ブロードキャスト（Port `51888`）による同一LAN内PC自動検出、PC画面での承認モーダル（またはQR読取）によるペアリング、`mobile_delta.db` を使った1〜2秒の差分双方向同期。
2. **一覧表示 3レイアウト切替 ＆ ピンチイン・ピンチアウト列数変更**:
   - `標準グリッド（正方形）` / `びっしり表示（アスペクト比維持）` / `マウント表示（スライドフィルム枠＋ファイル名）` の3種切替（`#mGridLayoutBtn`）および2本指ピンチによる列数変更（アンカー位置維持）。
3. **スマートスタックの代表（表紙コマ）変更・即時反映・同期**:
   - フルスクリーンビューア下部のスタック比較バー（`#mViewerStackBar`）での `★ 表紙に設定` ボタン、一覧グリッドカードDOMの即時差し替え、`pending_journal.db` ＆ `/api/mobile/sync-import` への永続同期。
4. **実ファイル（フル解像度JPEG・RAW埋込プレビュー）のプログレッシブ拡大表示**:
   - ビューア起動時は0秒で `library.db` 内のWebPサムネイルを表示し、バックグラウンドで **USB SAF直結** または **Wi-Fi LAN（`/api/photo/{id}/view`）** から実ファイル（フル解像度JPEG / RAWフルプレビュー）を読み込んで自動差し替え（`HD 実ファイル` バッジ表示・Duel比較モード対応）。
5. **非破壊調整（露出・コントラスト・彩度・微細傾き）＆ 4段階評価（優・良・可・棄）・階層タグの双方向同期**:
   - キャンバススクラブ調整のDB保存・ジャーナル記録・PC側 `/api/mobile/sync-import` 反映、および PC側で保存した `filter_presets`（バインダー）のAndroid引き継ぎ。

---

## 2. パートA：Android版（Phone / Tablet）における「4つの設計原則」残課題

PC版で実装済みの機能のうち、Android版（`mobile.html` / `mobile.js` / `touch_*.js`）にまだ移植されていない項目と実装指針は以下の通り。

### A-1. Lab（分析ラボ）のモバイル・タブレット実装（第1の柱）
- **現状**: タブレット左レール等の `Lab` パネルは現在「DB読込・Wi-Fi/USB同期」のショートカットのみを表示している。
- **不足機能**:
  - **47都道府県制覇マップ（Japan Conquest Map）**: `photos.country = 'Japan'` の `state`（都道府県）別撮影枚数を集計し、SVG日本地図を塗り分ける機能（タップで該当都道府県の写真を絞り込み）。
  - **撮影統計サマリー＆レンズ活用カルテ**: カメラ機種別・レンズ別・焦点距離帯別の撮影枚数と「優・良」歩留まり率（Keeper Rate）の可視化。
- **実装対象ファイル**:
  - `frontend/js/views/touch/touch_lab.js`（新規切り出し推奨・800行制限厳守）
  - `frontend/js/mobile.js`（`window.__renderTabletPerspectivePanel('lab', container)` からの呼び出し）

### A-2. Gear（機材）の「カメラ ＞ レンズ」2階層ツリーと除外（NOT）操作（第1の柱）
- **現状**: カメラ機種（`camera_model`）のフラット一覧による単一選択のみ。
- **不足機能**:
  - カメラ機種を展開すると、そのカメラで使用されたレンズ（`lens_model`）が子階層として並ぶ2階層ツリー表示。
  - タグと同様に「1回タップ＝含む（AND）」「2回タップまたは除外ボタン＝除く（NOT）」の排他絞り込み。
- **実装対象ファイル**:
  - `android/app/src/main/java/com/tetheract/pm/LockerDatabaseManager.kt`（`queryPhotosJson` に `lens_model` / `exclude_cameras` / `exclude_lenses` 条件を追加）
  - `frontend/js/mobile.js`（`mState.lensModel`, `renderDrawerFilters` 内のカメラ・レンズ階層描画）

### A-3. 検索・絞り込みのフル機能化（第1の柱）
- **不足機能**:
  1. **12色カラーパレットUI**: `MOBILE_COLOR_TAGS`（赤・青・緑・黄色・黒・白・銀・金・茶色・紫・オレンジ・ピンク）を視覚的な丸型カラースウォッチでタップ選択・除外できるパレット。
  2. **ファイル種別フィルタ**: `すべて / JPEGのみ / RAWのみ / RAW+JPEGペア` の絞り込みピル。
  3. **EXIF数値ソート7種**: 現在の5種（撮影日時・ファイル名・評価）に加え、`ISO感度順` / `F値順` / `シャッター速度順` / `焦点距離順` / `ファイルサイズ順` を追加。
  4. **自然な日本語フィルタバー**: 複数条件で絞り込んだ際、画面上部に「2026年10月に / 東京で / 優・良の / 『猫』を含む写真（42枚）」のように自然な文章で条件を表示するバー。
  5. **現在条件の新規バインダー保存**: スマホ・タブレット上で組み立てた絞り込み条件に名前を付けて `filter_presets` へ新規保存し、PC母艦へ逆同期する機能。
- **実装対象ファイル**:
  - `frontend/mobile.html`（`#mSortSelect` の `<option>` 追加、ドロワー内カラーパレット＆ファイル種別枠）
  - `frontend/js/mobile.js`（クエリビルダーおよび `renderActiveFilterChips` の自然文生成）
  - `server/routers/mobile_router.py`（`mobile_sync.json` 経由での新規 `filter_presets` インポート対応）

### A-4. ビューア・非破壊調整の残項目（第2・第3の柱）
- **不足機能**:
  1. **90°ステップ回転ボタン**: ビューアの調整モード（`adjust`）内に90°左/右回転ボタンを配置し、`photos.rotation` を更新・同期。
  2. **タッチ自由クロップ枠（アスペクト比固定対応）**: `Original / 1:1 / 4:3 / 3:2 / 16:9` の比率ピルと、四隅ドラッグによる `crop_x, crop_y, crop_w, crop_h` の非破壊保存。
  3. **キャンバス長押しによる Before / After 比較**: 調整済み写真を指でホールドしている間だけ `filter` / `transform` を一時解除して元画像と比較する機能。
  4. **調整値のコピー＆複数写真への一括ペースト**: 1枚の写真で決めた露出・傾き・彩度をコピーし、複数選択した写真へ一括適用する機能。
  5. **タブレット右インスペクタの RGB ヒストグラム描画**: インスペクタ上部の 4:3 サムネイルから `<canvas>` でR/G/B輝度分布を算出・描画する機能。
- **実装対象ファイル**:
  - `frontend/js/views/touch/touch_gestures.js` / `frontend/js/views/touch/touch_inspector.js`

### A-5. 4テーマ（`Tetheract D / L / 夜墨 / 和紙`）＆ 日英切替（`JP / EN`）の統一（第3の柱）
- **現状**: Android版は `sumi`（夜墨）と `paper`（和紙）の2トグルのみで、UI文字列は日本語固定。
- **不足機能**:
  - PC版と同じ `data-scheme="tetheract-d | tetheract-l | sumi | paper"` の4テーマ選択。
  - `frontend/js/i18n_dict.js` を使った日英（`JP / EN`）表示切替。
- **実装対象ファイル**:
  - `frontend/css/mobile.css`、`frontend/js/mobile.js`、`frontend/mobile.html`

---

## 3. パートB：`README.md`「今後の構想」に記載された5大未実装機能

プロジェクトルートの `README.md`（「今後の構想」節）に掲げられている5つの未実装機能と、Tetheract のアーキテクチャ（完全オフライン・非破壊・ポータブル）に沿った実装設計図は以下の通り。

### B-1. ローカル類似画像検索（AI特徴量コサイン類似度検索）
- **概要**: お気に入りの1枚（基準写真）から、構図・色合い・被写体の雰囲気が似ている写真をローカルAIで高速検索する機能。
- **設計指針**:
  - すでに `server/ai/` に同梱されている CLIP Vision エンコーダ（ONNX Runtime）の最終512次元正規化特徴量ベクトル（`float16` 約1KB/枚）を `photo_embeddings (photo_id INTEGER PRIMARY KEY, vec BLOB)` テーブルへ保存する。
  - インスペクタまたは右クリックメニューに「似た写真を探す」ボタンを追加し、`GET /api/photo/{id}/similar?limit=60` で内積（コサイン類似度）上位の写真IDリストを返却してグリッドに表示する。

### B-2. フォーカスピーキング（ピント輪郭ハイライト補助）
- **概要**: フルスクリーン拡大表示や Duel（2枚比較）時に、ピントが合っている高周波エッジ（輪郭）をシアン・赤・黄などでハイライト表示する補助機能。
- **設計指針**:
  - サーバー通信不要。フロントエンドのオフスクリーン `<canvas>` で表示中画像の輝度勾配（Sobel / Laplacian フィルタ）を算出し、閾値以上の高コントラスト輪郭ピクセルのみを着色した透過レイヤーを画像上に重ねる。
  - PC版ライトボックス（`P` キー）および Android版ビューア／Duel画面のトグルボタンで ON/OFF できるようにする。

### B-3. GPSロガー（`.gpx`）連携（時刻照合ジオタグ紐付け）
- **概要**: 撮影時刻（`date_taken`）と外部GPSロガーやスマホGPSアプリが出力した `.gpx` トラックログを照合し、GPS非搭載カメラの写真にも緯度・経度および市区町村名（オフライン逆ジオコーディング）を一括紐付けする機能。
- **設計指針**:
  - `server/routers/gps_lab_router.py` に `POST /api/gps/import-gpx` を追加し、Python標準の `xml.etree.ElementTree` で `.gpx` 内の `<trkpt lat="..." lon="..."><time>...</time></trkpt>` をパースする。
  - 前後のトラックポイント間を線形時間補間して撮影時刻の座標を求め、`server/geocoder/` で国・都道府県・市区町村を逆引きして `photos` テーブル（および必要に応じてXMPサイドカー）へ反映する。

### B-4. 外部RAW現像ソフト連携（ショートカット直接起動）
- **概要**: Tetheract で高速選別した写真（または `paired_raw_path` のペアRAWファイル）を、ショートカットキー（例: `E` キー）や右クリックメニューから Lightroom / Capture One / Darktable / SILKYPIX / 純正現像ソフトへ直接渡して開く機能。
- **設計指針**:
  - 設定モーダルで外部現像ソフトの実行ファイルパス（`.exe`）を登録可能にし、`POST /api/photo/{id}/open-external-editor`（localhost専用）で `subprocess.Popen([editor_exe, target_raw_or_img_path])`（シェル連結禁止・引数リスト形式厳守）により安全に起動する。

### B-5. 余白フレーム・EXIF付き書き出し（マット枠合成エクスポート）
- **概要**: 写真の周囲に美術館のマット台紙のような余白フレーム（白・黒・和紙色）を設け、下部にカメラ機種名・レンズ名・焦点距離・F値・シャッター速度・ISO感度を控えめなタイポグラフィで添えてJPEG出力する機能。
- **設計指針**:
  - `server/routers/export_import_router.py` のスマートテイクアウト（エクスポート機能）のオプションとして「マットフレーム＆EXIF刻印」を追加する。
  - バックエンドで `Pillow`（`Image`, `ImageDraw`, `ImageFont`）を用い、非破壊調整（クロップ・傾き・露出・彩度）適用後の画像に対して余白キャンパスを生成し、`frontend/vendor/fonts/` 同梱フォントでEXIF文字列を描画して書き出す。
