# タスクリスト: storage フォルダ管理・移動・リネーム・エクスポート機能の実装

## 1. 設計・ドキュメント作成
- [x] 既存コードベース（`carry` / `take_out` / フォルダツリー / 選択メニュー）の調査
- [x] ユーザーとのインターフェイス仕様の合意形成
- [x] `docs/storage_folder_management/task.md` および `implementation_plan.md` の作成

## 2. バックエンド実装 (`server/`)
- [x] `server/storage_manager.py` の新規作成
  - [x] `STORAGE_DIR` (`BASE_DIR / "storage"`) の定義とパス境界チェック (`is_path_in_storage`, `is_photo_in_storage`)
  - [x] 旧 `carry/` フォルダから `storage/` への自動マイグレーション処理（ファイル移動＋DBパス一括更新）
  - [x] `storage/` 内のサブフォルダ一覧取得 (`get_storage_folders`)
  - [x] `storage/` 内のサブフォルダ作成 (`create_storage_subfolder`)・リネーム (`rename_storage_subfolder` ＋ DB内写真のパス一括追従更新)・空フォルダ削除 (`delete_storage_subfolder`)
  - [x] 外部写真の `storage/` へのコピー＆インポート処理 (`import_photos_to_storage`：評価・タグ・調整値・サムネイル引き継ぎ）
  - [x] `storage/` 内写真のフォルダ間移動処理 (`move_photos_in_storage`：実ファイル移動＋DBパス更新）
  - [x] `storage/` 内写真の単一リネーム (`rename_photo_in_storage`) および複数一括連番リネーム (`batch_rename_photos_in_storage`)
  - [x] `storage/` 内フォルダの外部エクスポート処理 (`export_storage_folder`)
- [x] `server/app.py` の更新
  - [x] `UPLOAD_DIR` を `BASE_DIR / "storage"` に変更し、起動時マイグレーション＆クリーンアップを組み込み
  - [x] `/api/photos` および `/api/photo/{photo_id}` で `is_storage` フラグを付与
  - [x] `/api/upload` に保存先サブフォルダ指定 (`destination`) を追加
  - [x] `/api/storage/*` エンドポイント群の追加と `_LOCAL_ONLY_PATH_PREFIXES` への登録
- [x] `server/folder_tree.py` & `server/database/photos.py` の更新
  - [x] 左ペインのフォルダツリー最上部（ショートカット先頭）に `📦 storage (アプリ内ストレージ)` を常時表示し、配下ノードに `is_storage: True` を付与
  - [x] `cleanup_missing_upload_photos` をサブフォルダ階層対応に改善

## 3. フロントエンド実装 (`frontend/`)
- [x] `frontend/js/storage.js` の新規作成
  - [x] `storage` 移動／インポート用フォルダ選択ポップオーバー＆コンテキストサブメニュー描画
  - [x] 単一ファイル名変更モーダル（<kbd>F2</kbd> キー / 右クリック / インスペクタ `✏️` ボタン連動）
  - [x] 複数写真の一括連番リネームモーダル（ルール選択＋リアルタイムプレビュー付き）
  - [x] `storage` サブフォルダの新規作成・名前変更・空フォルダ削除・外部エクスポート処理
  - [x] 写真カードのドラッグ開始と左ツリー `storage` フォルダへのドロップ移動／インポート処理
- [x] `frontend/index.html` & CSS の更新
  - [x] コンテキストメニュー (`#contextMenu`, `#folderContextMenu`) と下部フローティングバー (`#selectionFloatingBar`) への `storage` 操作アイテム追加
  - [x] 単一リネーム・一括連番リネーム・フォルダ入力用のモーダルおよびスタイルの追加
- [x] 既存JSモジュール (`folder_tree.js`, `selection.js`, `inspector.js`, `app.js`, `i18n.js`) の連携更新

## 4. 配布スクリプト・マニュアル更新・検証
- [x] `build_dist.bat` の `carry` → `storage` 変更
- [x] `MANUAL.md` および `frontend/index.html` (`#helpModal`) の同期更新
- [x] 自動テスト・API動作検証および `walkthrough.md` の作成

## 5. XMP サイドカー自動追従 & ホールドプレビュー・メタデータ取込・書き出し連携
- [x] `storage` へのインポート・フォルダ間移動・単一／一括連番リネーム・外部エクスポート時における同名サイドカーファイル（`.xmp` 等）の自動追従
- [x] 右インスペクタ上部 `#inspectorXmpBar`（`📄 XMP` バッジ、`👁️ XMPプレビュー` ホールドボタン、`📥 評価・タグ取込` ボタン）の実装
- [x] `[👁️ XMPプレビュー]` 押下中のオンデマンドXMP調整プレビュー（インスペクタサムネイル・ヒストグラム・ライトボックス連動、プリロード対応）
- [x] `[📥 評価・タグ取込]` による XMP 評価の4段階変換取り込みおよび `XMP/` ルート配下への階層タグ隔離インポート
- [x] スマート・テイクアウト（`#smartTakeoutModal` / `frontend/js/takeout.js`）への `export_xmp_sidecar` チェックボックス追加
- [x] `MANUAL.md`、`#helpModal`、`frontend/js/i18n.js` へのサイドカー＆XMPプレビュー機能ドキュメント・日英翻訳同期
