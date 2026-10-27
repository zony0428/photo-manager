# タスクリスト: フォルダマネージャーの左ペイン集約と持ち出し/取り込みフォルダ整理 (v1.40)

- [x] **フェーズ1: バックエンド基盤整備** <!-- id: 1 -->
  - [x] `GET /api/folder-tree/roots` の実装（ショートカット、接続中ドライブ、未接続ボリュームの分離返却）
  - [x] `GET /api/folder-tree/children` の実装（遅延読み込み、実ディレクトリとDB写真情報のマージ）
  - [x] `GET /api/photos` に `exclude_folder` パラメータを追加（除外絞り込み対応）
  - [x] `POST /api/scan` のリフレッシュ機能強化（`cleanup_orphans=True` かつ `recursive=True` で消滅ファイルの配下再帰DB削除）
  - [x] `POST /api/photos/batch-delete` API の作成（選択写真・スタック・サムネイルの一括物理/DB削除）
  - [x] テストスクリプトによるバックエンド動作検証

- [x] **フェーズ2: 左ペインのツリー描画と遅延展開** <!-- id: 2 -->
  - [x] `frontend/js/folder_tree.js` の新規作成と `index.html` への登録
  - [x] フォルダツリーの3セクション構成（⭐ ショートカット、💻 接続中ドライブ、💾 未接続ボリューム）
  - [x] 遅延展開（クリック時の動的子要素取得とアイコン展開状態管理）
  - [x] フォルダステータス（管理中バッジ、配下管理あり印 ●、未登録の淡色化、除外の打ち消し線）の描画
  - [x] ブラウザでの表示・展開速度の動作検証

- [x] **フェーズ3: 操作・機能の集約** <!-- id: 3 -->
  - [x] 左クリック3段切替の実装（1回目: 通常絞り込み → 2回目: 除外絞り込み → 3回目: 絞り込み解除）
  - [x] 除外絞り込み時の視覚フィードバック（ツリーの朱色ダッシュ枠＋打ち消し線、上部除外チップ）
  - [x] 右クリックメニューの刷新（再スキャン、リフレッシュ、AI自動タグ付け、管理除外/解除、エクスプローラー起動）
  - [x] ドライブ直下等の広範囲スキャンに対する警告ダイアログ（キャンセル可能）
  - [x] フォルダタブ下部へのスキャン進捗バー（リアルタイム・スタック対応）と最下部固定パス直接入力バーの配置
  - [x] フォルダタブ見出しへの `[🤖 OFF / ON]` AI自動タグトグルおよび `[⚙️]` データベースメンテナンス画面の配置
  - [x] 独立した `#dbMaintenanceModal` によるDBサイズ・写真数・サムネイル数・VACUUM最適化・バックアップ機能の実装

- [x] **追加要件: フォルダ名変更と配布バッチ更新** <!-- id: 4 -->
  - [x] ヘッダー [取り込み] の保存先を `uploads` から `carry` に変更
  - [x] 右クリックメニュー [書き出し準備] の保存先を `import` から `take_out` に変更
  - [x] ディスク上の旧 `uploads` および `import` フォルダを削除し、新規 `carry` / `take_out` フォルダを作成
  - [x] `server/app.py`, `scanner.py`, `database/folders.py`, `database/photos.py`, `.gitignore` の該当パス・除外設定更新
  - [x] `build_dist.bat`（Dist_build.bat）を更新し、配布パッケージ内に `carry/` と `take_out/` の空フォルダを自動生成するよう対応

- [x] **フェーズ4: 旧モーダル・旧コードの撤去** <!-- id: 5 -->
  - [x] `frontend/index.html` から `#scanModal`（旧フォルダマネージャモーダル一式）を削除
  - [x] `frontend/index.html` から `<script src="/js/scanner_modal.js"></script>` を削除
  - [x] `frontend/js/scanner_modal.js` を非推奨・集約完了コメントに整理
  - [x] `frontend/js/common.js` から旧モーダル関連要素（`openScanModalBtn`, `scanModal`, `folderBrowser` 等）の登録を整理・削除
  - [x] `frontend/js/common.js` に共通モーダル（ヘルプ・終了）の制御関数を移設
  - [x] `frontend/js/app.js` の空状態ボタン（`emptyStateActionBtn`）の動作を、左ペインのフォルダタブを開く処理に更新

- [x] **フェーズ5: バージョンアップ & ドキュメント同期 & サーバー停止** <!-- id: 6 -->
  - [x] バージョンを `1.40` に更新（`VERSION`, `server/version.py`, `frontend/index.html` の全 CSS/JS クエリパラメータ）
  - [x] `MANUAL.md` を v1.40 の左ペインフォルダツリーおよび `carry`/`take_out` 保存先に同期更新
  - [x] `docs/knowledge/feature-code-map.md` を最新アーキテクチャに同期更新
  - [x] ブラウザサブエージェントによる表示・モーダル・コンソールエラー0件の最終検証完了
  - [x] 開発サーバー（FastAPI/Uvicorn）の安全停止
