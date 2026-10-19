# 実装計画: フィルタセット機能 (Saved Filter Presets)

## 概要
ユーザーが写真一覧画面で設定した複数のフィルタ条件（タグ、年月、カメラ機種、レーティング、フォルダ、検索キーワード、並び順など）を、名前付きの「フィルタセット」として保存し、左ペインの専用タブからワンクリックで復元・適用できる機能を実装する。

## 構成と設計

### 1. データベース (server/database/)
- **テーブル定義**: ilter_presets
  - id: INTEGER PRIMARY KEY AUTOINCREMENT
  - 
ame: TEXT NOT NULL UNIQUE
  - description: TEXT DEFAULT ''
  - ilters: TEXT NOT NULL (JSONシリアライズ文字列)
  - created_at: TEXT NOT NULL (ISO/Localtime)
  - updated_at: TEXT NOT NULL (ISO/Localtime)
- **モジュール追加**: server/database/presets.py
  - get_filter_presets() -> list[dict]
  - get_filter_preset(preset_id: int) -> dict | None
  - create_filter_preset(name: str, filters: str, description: str = '') -> dict
  - update_filter_preset(preset_id: int, name: str, filters: str, description: str = '') -> dict | None
  - delete_filter_preset(preset_id: int) -> bool

### 2. バックエンドAPI (server/app.py)
FastAPIルーターに以下のエンドポイントを追加する。
- GET /api/filter-presets: 保存済みフィルタセットの一覧取得
- POST /api/filter-presets: 新規保存（{ name, filters, description }）
- PUT /api/filter-presets/{preset_id}: 更新
- DELETE /api/filter-presets/{preset_id}: 削除

### 3. フロントエンドUI (rontend/index.html, rontend/css/style.css)
- **タブ追加**:
  - sidebarIndexTabs に ★ セット (	ab-presets) タブボタンを追加。
- **パネル追加**:
  - 	abPanel-presets:
    - **現在条件サマリーエリア**: タグ、年月、カメラ、評価等の現在適用されている条件を小さなチップで可視化。
    - **保存フォーム**: プリセット名入力欄 + 「💾 現在のフィルター設定を保存」ボタン。
    - **一覧エリア**: 保存済みプリセットがカード形式で一覧表示される。
      - 各カード: タイトル、条件サマリー、［適用］ボタン、［🗑️］削除ボタン、（将来の［▶ スライドショー］連携ボタン）
- **スタイル定義**:
  - プリセットカード、バッジ、適用中ハイライトのCSS定義。

### 4. フロントエンドロジック (rontend/js/app.js)
- **状態管理**:
  - 現在のフィルタ条件を抽出してJSON化するヘルパー getCurrentFiltersObject()
  - プリセットをUIに反映するヘルパー pplyFilterPreset(filters)
    - タグ（include/exclude）、年月、カメラ、評価、フォルダ、検索語を復元し、UIコンポーネント（ツリーやトグル）のアクティブ表示を更新、etchPhotos() を呼び出し。
- **データ連携**:
  - loadFilterPresets(): APIから取得してリスト描画。
  - saveCurrentFilterPreset(): API経由で保存。
  - deleteFilterPreset(id): API経由で削除。

## 検証計画
1. バックエンド単体確認（PythonインタプリタでのCRUDテスト）
2. サーバー起動およびAPI疎通確認（curlまたはテストスクリプト）
3. ブラウザ表示・UI動作確認（タブ切り替え、保存、リスト表示、適用、リセット）
