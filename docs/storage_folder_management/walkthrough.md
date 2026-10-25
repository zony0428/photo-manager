# Walkthrough: `storage` フォルダ管理・移動・リネーム・エクスポート機能の実装

## 1. 実装概要
従来の `carry` フォルダによる単一フラット取り込み機能を刷新し、アプリ内専用ストレージ **`storage/`** として再設計しました。
外部フォルダ（PCや外付けHDD等）の元写真に対する「完全非破壊原則」はそのまま維持しつつ、`storage/` 内にインポートされた写真・サブフォルダに対しては、サブフォルダ作成・フォルダ名変更・フォルダ間移動・ファイル名変更（単一＆一括連番）・外部エクスポートをアプリ内で完結して行えるようになりました。

---

## 2. 主な変更ファイルと機能詳細

### 2.1 バックエンド (`server/`)
- **[server/storage_manager.py](file:///c:/Users/zony0/Documents/photo-manager/server/storage_manager.py)（新規作成）**
  - **旧 `carry/` からの自動移行 (`migrate_carry_to_storage`)**: 起動時に `carry/` 内の全ファイル・サブフォルダを `storage/` へ移動し、SQLite DB（`photos`, `scan_roots`, `ignored_folders`）のパス参照を一括更新します。
  - **安全境界チェック (`resolve_storage_target_dir`, `is_photo_in_storage`)**: すべてのファイル移動・リネーム・フォルダ操作が必ず `storage/` 配下に収まることを検証し、パストラバーサル（`..`）や外部フォルダの変更を防止します。
  - **サブフォルダ管理 (`get_storage_folders`, `create_storage_subfolder`, `rename_storage_subfolder`, `delete_storage_subfolder`)**: サブフォルダリネーム時には配下写真の `file_path` / `directory_path` / `paired_raw_path` をトランザクション内で一括更新し、評価やタグを維持します。
  - **外部写真のインポート (`import_photos_to_storage`)**: 外部写真を `storage/` 指定フォルダへコピー（ペアRAW連動）し、元の評価・タグ（手動/AI）・非破壊調整値・GPS・サムネイルBLOBをそのまま引き継ぎます。
  - **`storage` 内写真の移動 (`move_photos_in_storage`)**: `storage/` 内のサブフォルダ間で実ファイルを移動し、同一IDのDBレコードを更新します。
  - **単一 ＆ 一括連番リネーム (`rename_photo_in_storage`, `batch_rename_photos_in_storage`)**: 拡張子維持＆ペアRAW連動の単一リネームと、撮影日時昇順・2段階一時ファイル名経由で衝突を防止する一括連番リネーム（`date_seq`, `date_original`, `custom_seq`）を提供します。
  - **フォルダごとの外部エクスポート (`export_storage_folder`)**: 指定した `storage` サブフォルダを階層ごと外部フォルダへ書き出します。
- **[server/folder_tree.py](file:///c:/Users/zony0/Documents/photo-manager/server/folder_tree.py)**
  - 左サイドバー「📁 フォルダ」ツリーのショートカット最上部に `📦 storage (アプリ内ストレージ)` を常時表示し、配下の空サブフォルダも `status: "managed"` として即座に操作可能にしました。
- **[server/app.py](file:///c:/Users/zony0/Documents/photo-manager/server/app.py)**
  - `/api/storage/*` 全9エンドポイントの追加、`/api/upload` のサブフォルダ直接指定対応、`/api/photos` への `is_storage` フラグ付与、および `_LOCAL_ONLY_PATH_PREFIXES` によるLAN保護を実装しました。

### 2.2 フロントエンド (`frontend/`)
- **[frontend/js/storage.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/storage.js)（新規作成）**
  - **左ツリー連携 ＆ ドラッグ＆ドロップ**:
    - 写真カードを左サイドバーの `📦 storage`（または配下サブフォルダ）へドラッグ＆ドロップすると、`storage` 内写真なら「移動」、外部写真なら「コピー＆インポート」を実行します。
    - `storage` フォルダの右クリックメニューから「📁 新規サブフォルダを作成」「✏️ フォルダ名を変更」「📤 このフォルダを外部へエクスポート」「🗑️ 空フォルダを削除」を実行できます。
  - **選択メニュー ＆ 下部フローティングバー連携**:
    - `storage` 内写真を選択中：「📦 storage内で移動」（上部で新規フォルダ作成＆移動も可能）、「✏️ ファイル名変更 / 一括リネーム (<kbd>F2</kbd>)」を表示します。
    - 外部写真を選択中：「📥 storageへインポート」（上部で新規フォルダ作成＆インポートも可能）を表示します。
  - **右インスペクタ ＆ リネームモーダル (`#storageRenameModal`)**:
    - `storage` 内写真の詳細表示時にファイル名横へ `✏️` ボタンを表示。
    - 1枚選択時は拡張子保護付きの単一リネーム、2枚以上選択時はリアルタイムプレビュー付きの一括連番リネームモーダルが起動します（<kbd>F2</kbd> キー対応）。

### 2.3 配布スクリプト・ドキュメント (`build_dist.bat`, `MANUAL.md`, `#helpModal`, `i18n.js`)
- [build_dist.bat](file:///c:/Users/zony0/Documents/photo-manager/build_dist.bat) の作業フォルダ作成を `carry` から `storage` に更新しました。
- [MANUAL.md](file:///c:/Users/zony0/Documents/photo-manager/MANUAL.md)、[frontend/index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html) (`#helpModal`)、[frontend/js/i18n.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/i18n.js) に `storage` 機能、サイドカー自動追従、`[👁️ XMPプレビュー]` ホールド比較、および <kbd>F2</kbd> ショートカットの解説・日英翻訳を反映しました。

### 2.4 XMP サイドカー連携（ホールドプレビュー・評価/タグ取込・同時書き出し）
- **右インスペクタ XMP バー ([frontend/index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html), [frontend/js/inspector.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/inspector.js), [frontend/css/modals-features.css](file:///c:/Users/zony0/Documents/photo-manager/frontend/css/modals-features.css))**:
  - `#inspectorFixedPreview` 直下に `#inspectorXmpBar`（`#inspectorXmpBadge`, `#inspectorXmpPreviewBtn`, `#inspectorXmpImportMetaBtn`）を追加しました。
  - `showSingleInspector(photo)` にて `photo.xmp_info` を判定し、XMP 調整値がある場合は `/api/photo/{id}/xmp-preview?mode=thumb` をプリロードしたうえで、`[👁️ XMPプレビュー]` ボタンを押している間だけ XMP 調整反映画像（＋ヒストグラム再計算＋ライトボックス連動）に切り替わり、離すと元の表示へ即座に復帰します。
  - `[📥 評価・タグ取込]` ボタンから `POST /api/photo/{id}/import-xmp-metadata` を呼び出し、XMP 評価の4段階変換（優・良・可・棄）と `XMP/...` ルート配下への階層タグ取り込みを行えます。
- **スマート・テイクアウト `.xmp` 出力 ([frontend/index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html), [frontend/js/takeout.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/takeout.js))**:
  - `#smartTakeoutModal` に `#exportXmpSidecarCheck`（`📄 XMPサイドカー (.xmp) も一緒に出力する（評価・タグ・調整情報の保持）`）を追加し、`/api/export/smart` リクエストの `export_xmp_sidecar` パラメータおよび `localStorage` 設定保存に連動させました。

### 2.5 UI整理（左ペインの純粋フィルタ化・右インスペクタ「タグエディタ」・DB管理のヘッダー移動）
- **DB管理ボタンの右上ヘッダー移動 ([frontend/index.html](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html))**:
  - 左ペイン「📁 フォルダ」ツールバーにあった `#folderDbMaintenanceBtn` を右上ヘッダー（`スマホ連携` と `ヘルプ` の間）に `DB管理` ボタンとして移動しました。
- **左ペインの純粋フィルタ化 ＆ 右インスペクタ「タグエディタ」への統合 ([frontend/js/sidebar_filters.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/sidebar_filters.js), [frontend/js/inspector.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/inspector.js), [frontend/css/inspector.css](file:///c:/Users/zony0/Documents/photo-manager/frontend/css/inspector.css))**:
  - 左ペインのタグツリーから編集ボタン（`✏` / `×`）を撤去し、誤操作のない100%純粋な絞り込みUI（`[+]` 含む / `[-]` 除外）に統一しました。
  - 右インスペクタのタグツリーを「タグエディタ」に強化し、`+子`（子タグ作成）、`✏`（インラインリネーム）、および明示的な `+追加` ボタンクリック時のみのタグ付与（`✓付与済` バッジ表示付き）に整理しました。

---

## 3. 検証結果
- FastAPI `TestClient` による自動テストで以下を検証し、すべて正常にパスすることを確認しました：
  1. 旧 `carry` フォルダからのファイル移行＆DBパス自動書き換え
  2. `/api/folder-tree/roots` 先頭への `📦 storage` 表示および空サブフォルダのツリー展開
  3. サブフォルダの作成・リネーム（DB内写真パス追従）・空フォルダ削除
  4. 外部写真の `storage` インポート（評価・タグ・調整値・サムネイルBLOB引き継ぎ）
  5. `storage` 内でのサブフォルダ間移動
  6. 単一ファイル名変更（ペアRAW連動・拡張子維持）および複数写真の一括連番リネーム
  7. フォルダ単位の外部エクスポート
