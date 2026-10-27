# 実装計画書: storage フォルダ管理・移動・リネーム・エクスポート機能

## 1. 背景と目的
従来、ブラウザへのドラッグ＆ドロップや上部「取り込み」ボタンから追加された画像は `carry/` フォルダに格納されていたが、フォルダツリーに表示されず、サブフォルダ整理やリネーム・移動を行う手段がなかった。
本改修では以下の2点を実現する：
1. インポート先フォルダを `carry/` から **`storage/`（アプリ内専用ストレージ）** に変更する（既存の `carry/` 内データは起動時に自動で `storage/` へ移行する）。
2. 外部参照フォルダの写真に対する「完全非破壊原則」は厳守しつつ、**`storage/` 内にインポートされた写真・フォルダに限り、`storage/` 内でのサブフォルダ作成・フォルダリネーム・写真のフォルダ間移動・写真ファイル名リネーム（単一／一括連番）・外部エクスポート** をシームレスに行えるインターフェイスを提供する。

---

## 2. アーキテクチャ & インターフェイス設計

### 2.1 安全境界（サンドボックス原則）
- すべてのファイル移動・リネーム・フォルダ操作APIは、対象パスが必ず `BASE_DIR / "storage"` 配下であることを `Path.resolve()` ベースで厳格に検証する（パストラバーサル `..` や外部ドライブ上のファイル変更を100%遮断）。
- 外部フォルダの写真が選択されている場合は「移動」「リネーム」を表示せず、代わりに **「📥 storageへインポート（コピー）」** を表示する。

### 2.2 バックエンド構成 (`server/`)
1. **`server/storage_manager.py`（新規モジュール）**
   - `STORAGE_DIR = BASE_DIR / "storage"`
   - `migrate_carry_to_storage()`: `carry/` に残っているファイル・サブフォルダを `storage/` に移動し、SQLite `photos` テーブルの `file_path`, `directory_path`, `paired_raw_path` を一括更新する。
   - `is_path_in_storage(path_str)` / `is_photo_in_storage(photo)`: 対象が `storage/` 配下かを高速判定。
   - `get_storage_folders()`: `storage/` 直下および全サブフォルダ階層（相対パス・絶対パス・写真枚数）を返却。
   - `create_storage_subfolder(parent_path, folder_name)`: サブフォルダ作成。
   - `rename_storage_subfolder(folder_path, new_name)`: サブフォルダ名を変更し、DB内の該当フォルダ配下にある全写真の `file_path` / `directory_path` / `paired_raw_path` をトランザクション内で一括更新。
   - `delete_storage_subfolder(folder_path)`: 空のサブフォルダを削除。
   - `import_photos_to_storage(photo_ids, destination)`: 外部フォルダの写真を `storage/` 指定フォルダへコピーしてDB登録し、元の評価（`rating`）・タグ（`photo_tags`）・非破壊調整・GPS・サムネイルBLOBをそのまま引き継ぐ。
   - `move_photos_in_storage(photo_ids, destination)`: `storage/` 内の写真を別サブフォルダへ `shutil.move` し、DBの `file_path` / `directory_path` / `paired_raw_path` を更新（ID不変のため評価・タグ・サムネイルを完全維持）。
   - `rename_photo_in_storage(photo_id, new_name)`: 拡張子を保護して単一ファイルをリネーム（同フォルダ内のペアRAWも連動）し、DBの `file_name` / `file_path` を更新。
   - `batch_rename_photos_in_storage(photo_ids, naming_rule, custom_prefix, start_number)`: 複数写真を撮影日時順にソートし、2段階リネーム（一時名経由）で衝突を防ぎながら一括連番リネーム。
   - `export_storage_folder(folder_path, destination_dir, open_after)`: 指定した `storage` フォルダを外部フォルダへ丸ごとコピー出力。

2. **`server/folder_tree.py`（フォルダツリー拡張）**
   - `build_roots()` のショートカット先頭に `📦 storage (アプリ内ストレージ)` ノード（`kind: "storage"`, `is_storage: True`）を常時含める。
   - `list_children()` で `storage/` 配下の子フォルダを展開した際、各ノードに `is_storage: True` を付与し、写真が0枚の空サブフォルダでも `status: "managed"` として表示する。

3. **`server/app.py`（APIルーティング）**
   - `/api/photos` および `/api/photo/{photo_id}` の返却オブジェクトに `is_storage: bool` を付与。
   - `/api/upload` で `destination` パラメータを受け取り、左ツリーで選択中の `storage` サブフォルダへ直接取り込めるようにする。
   - `/api/storage/*` エンドポイントを登録し、`_LOCAL_ONLY_PATH_PREFIXES` に `"/api/storage"` を追加してLAN経由の不正操作を遮断。

### 2.3 フロントエンド構成 (`frontend/`)
1. **`frontend/js/storage.js`（新規モジュール）**
   - **左ツリー連携**:
     - `storage` ルートおよび配下サブフォルダの右クリックメニュー（新規サブフォルダ作成・フォルダ名変更・フォルダごと外部エクスポート・空フォルダ削除）。
     - グリッド上の写真カードから左ツリーの `storage` フォルダへのドラッグ＆ドロップ（`storage` 内写真なら移動、外部写真ならコピーインポート）。
   - **選択コンテキストメニュー ＆ 下部フローティングバー連携**:
     - `storage` 内の写真選択時：「📦 storage内で移動」（フォルダ選択＋新規フォルダ作成＆移動）、「✏️ ファイル名を変更 (<kbd>F2</kbd>)」（1枚なら個別リネーム、複数なら一括連番リネームモーダル）。
     - 外部フォルダの写真選択時：「📥 storageへインポート」（フォルダ選択＋新規フォルダ作成＆インポート）。
   - **右インスペクタ連携**:
     - `storage` 内の写真を表示中、ファイル名の横に `✏️` リネームボタンを表示。
   - **キーボードショートカット**:
     - <kbd>F2</kbd> キーで選択中の `storage` 写真のリネーム（単一／一括連番）を起動。

2. **ドキュメント・配布スクリプト同期**
   - `build_dist.bat` の作業用フォルダ作成を `carry` から `storage` に変更。
   - `MANUAL.md`、`frontend/index.html` (`#helpModal`)、`frontend/js/i18n.js` を更新。

3. **XMP サイドカー自動追従 ＆ ホールドプレビュー・メタデータ取込・書き出し連携**
   - **サイドカー自動追従**: `storage` のインポート・移動・単一／一括連番リネーム・エクスポート時に、写真と同名のサイドカーファイル（`.xmp`, `.pp3`, `.dop`, `.on1`, `.cos`, `.acr`, `.mie` 等、`basename.xmp` および `basename.ext.xmp` 両形式）を検出して自動追従させる。
   - **右インスペクタ `#inspectorXmpBar` (`frontend/index.html`, `frontend/js/inspector.js`, `frontend/css/modals-features.css`)**:
     - `/api/photo/{id}` が返す `xmp_info` に基づき、XMP サイドカーが存在する写真で `#inspectorXmpBar` を表示。
     - `xmp_info.adjustments.has_adjustments` が真の場合、`[👁️ XMPプレビュー]` ホールドボタンを表示し、`/api/photo/{id}/xmp-preview?mode=thumb` をバックグラウンドでプリロード。ボタンを押している間だけ Photo Manager の調整をオフにして XMP の調整（露出・コントラスト・彩度・クロップ・角度）を反映した画像へ切り替え、ヒストグラムおよびライトボックス表示も連動させる。
     - `xmp_info.rating.has_rating` または `xmp_info.tags` が存在する場合、`[📥 評価・タグ取込]` ボタンを表示し、`POST /api/photo/{id}/import-xmp-metadata` を呼び出して4段階評価への変換および `XMP/` ルート配下への階層タグ取り込みを実行する。
   - **スマート・テイクアウト `.xmp` サイドカー出力 (`#smartTakeoutModal`, `frontend/js/takeout.js`)**:
     - `#exportXmpSidecarCheck` チェックボックスを追加し、`/api/export/smart` ペイロードに `export_xmp_sidecar` を渡して書き出し画像と同名の `.xmp` サイドカーを同時出力できるようにする。

---

## 3. 検証計画
1. **マイグレーション検証**: `carry/` にダミー画像を置いた状態で起動し、`storage/` へ自動移行されDBパスが追従することを確認。
2. **フォルダ管理検証**: `storage/` 内のサブフォルダ作成、リネーム（配下写真のパス・タグ・評価維持）、空フォルダ削除、外部エクスポートをテスト。
3. **インポート・移動・リネーム検証**:
   - PCファイルのD&D取り込み（サブフォルダ直入れ含む）
   - 外部写真の `storage` へのコピーインポート（評価・タグ引き継ぎ確認）
   - `storage` 内でのフォルダ間移動（ポップオーバー＆D&D）
   - 単一リネームおよび複数一括連番リネームの動作確認
