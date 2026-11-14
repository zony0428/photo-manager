# Tetheract Photo Manager (v2系) モダナイゼーション＆高速化 実装計画書

本計画書は、[audit_report.md](file:///c:/Users/zony0/Documents/photo-manager/docs/codebase_audit_and_modernization/audit_report.md) で特定された「v2系の改修・問題解決速度の低下」および「体感パフォーマンスの乱高下」を根治するため、ユーザー合意に基づき再編した4段階（Phase 1〜Phase 4）の実行ロードマップである。

> [!IMPORTANT]
> **優先度再編の基本方針**
> 1. **開発速度の足かせ除去を最優先（Phase 1）**: これ以降の全改修（パフォーマンス改善・バグ修正）の速度と精度を倍増させるため、AIを誤誘導している32本の肥大化ルール/KIのスリム化、Git汚染ビルドの浄化、歪な800行制限の撤廃、および本番DBを汚染しない高速テスト基盤を最初に確立する。
> 2. **進行中の未コミット変更の保護**: 現在ワーキングツリーにある `PhoneCase*` 周りの未コミット変更には一切手を触れず（Phase 1 では所有ファイルを完全分離）、潜在バグ修正は Phase 2 で安全に実施する。
> 3. **セキュリティ封鎖の適切なフェーズ配置（Phase 4）**: 現在はクローズドテスト運用中であるため、ローカル連携の試験自由度を損なわないよう `Origin: null` PNA遮断やペアリング窓口厳格化は一般公開・外部配布前の必須ゲート（Phase 4）として配置する。

---

## Phase 1 (P1 - 最優先・今回実施): 開発速度倍増・AIルール/KI浄化・ビルド非汚染化・テスト隔離

### 1.1 AIルール・スキル・エージェント定義の70%超スリム化（32本・3,285行 → アクティブ10本・約900行）
- **`AGENTS.md`（約100〜120行へ凝縮・制御文字除去）**:
  - 混入していた制御文字（`0x0c`, `0x08`）と存在しない `server/run.py` 誤記を除去。
  - 残す不変コア原則：①旧名維持対象（`photo-manager`, `cache/library.db`, `photo_manager.*`, `PhotoManager`）、②ポータブル相対パス＆`resolve_portable_path`、③非破壊原則＆開発フォルダ外（`P:\`, `%LOCALAPPDATA%` 等）干渉厳禁、④セキュリティ境界（localhost既定・Origin検証・LANホワイトリスト・XSSエスケープ・リスト形式 `subprocess`）、⑤JS鉄則（`Date.toISOString()` 禁止・`showConfirmModal`/`showToast`・テーマ属性 `data-scheme` 4種 / `data-theme` 2種）、⑥SQLite鉄則（WHERE必須・相関サブクエリ回避・親テーブル再構築時 `foreign_keys=OFF` 二重保護）、⑦PowerShell UTF-8鉄則（5〜6行）、⑧`main`(v1.8系) / `v2`(v2.x系) と `dist` / `dist_v2` 分離。
  - **ワークフロー適正化**:
    - 日常コミットでの `VERSION`・`?v=`・`MANUAL.md`・`#helpModal` 同期義務を**撤廃**し、「日常は1コミット1目的で軽快に進め、バージョン更新・キャッシュバスター同期・マニュアル/ヘルプ同期・リリースノート作成は**リリース実行時のみ一括実施**」へ改める。
    - 固定4ロール分業強制と機械的800行上限を撤廃し、「単一責務でモジュールを切り出し、**呼び出し元への配線完了・不要旧コード除去・検証までをEnd-to-Endで完結させる（未配線の死にモジュールを作らない）**」原則へ改める。
    - AI作業計画ドキュメント（`task.md`, `implementation_plan.md`, `walkthrough.md`）の保存先をユーザーグローバルルールと一致させ `docs/<topic>/` に統一。
- **`.agents/` の統合整理（12本 → 3本）**:
  - `.agents/rules/branch-and-dist-separation.md` のみ残し、`v2.0系` / `2.0.x` 表記を `v2系` / `2.x` へ更新。重複7本は `docs/archive/rules_legacy/` へ退避。
  - `.agents/skills/license-management/SKILL.md`: 85行目の禁止コマンド `findstr` を Python ワンライナー例へ修正し、パッケージ追加・更新時のみ参照と明記。
  - `.agents/skills/documentation-manual/SKILL.md`: リリース時（または明示指示時）の同期チェックリストへ改組し、81行目の絵文字推奨記述を削除。
  - `.agents/agents/` の2本（`oss-editorial-director`, `ui-design-critic`）は `docs/archive/agents_legacy/` へ退避。
- **`docs/README.md` の修復**: `RELEASE_NOTES_v3.0.1.md` 等のリンク切れ6本を実在ファイル名へ修正し、新しい `docs/knowledge/` 6本構成へ更新。

### 1.2 `docs/knowledge/` の現行v2仕様への刷新（19本 → コア6本＋`README.md`）
- 誤誘導・重複・旧仕様の12本（`feature-code-map.md` 51KB 等）を `docs/archive/knowledge/` へ退避し、関数・ルート特定はAIの実コード検索を正とする。
- アクティブ維持するコア6本を現行実装に合わせて更新：
  1. `design-philosophy-four-pillars.md`（`#filterFooterBar` 誤記を実在の `#viewHeaderChipBar` へ修正）
  2. `portable-storage-patterns.md`（VSN・`photos`/`photo_links`・`Loome` に `server/sidecar.py` と現行評価値 `2/1/0/-1` を統合）
  3. `security-architecture.md`（Lv.0/1/2保護・鍵サルベージ・LAN/Origin境界）
  4. `ui-design-system-and-tiat-guidelines.md`（テーマ2階建て属性・単色SVG・`showConfirmModal`・`#viewHeaderChipBar`・タグツリー要点を統合し、旧 `v3.00` 表記を整理）
  5. `architecture-scalability-and-side-effects.md`（過去Phase完了ログを除去し、SQLite/スキャン/UIの禁止アンチパターンとテストDB隔離原則のみに凝縮）
  6. `android-app-and-touch-architecture.md`（現行v2.1.7+ の `TETHERACT ld`・`PhoneCase*`/Uplink・`mobile_case_router.py`・`lan_bridge.py`・FieldLog要点を統合し、かつ「現在 `mobile.js` が実動本体であり `core/journal_sync.js` 等は未配線なのでP3統合まで誤って編集しないこと」を明記）。

### 1.3 `scripts/build_android_apk.py` のGit汚染廃止＆不要PC資産除外＆800行制限撤廃
- **Git追跡ファイルの書き換え廃止**: ビルド時刻スタンプはコピー先の `android/app/src/main/assets/mobile.html`（`.gitignore` 配下）側にのみ注入し、原紙 `frontend/mobile.html` を汚さない。`android/app/build.gradle` も `VERSION` から算出した `versionName` / `versionCode` が一致済みなら書き換えない。
- **PC専用資産のAPK除外**: `FRONTEND_SYNC_TARGETS` を見直し、モバイル側（`mobile.html` およびモバイル系JS/CSS）から一切参照されないPC専用ファイル（`index.html`, `js/app.js`, `js/inspector.js`, `js/sidebar_filters.js`, `js/folder_tree.js`, `js/selection.js`, `js/lightbox.js`, `js/compare.js`, `js/lab.js`, `js/adjust.js` 等）をコピー対象から除外（共通資産は厳密に残す）。
- **歪な800行ハードエラー撤廃**: `L234-254` の `<= 800` 行アサーションを削除。

### 1.4 テストの本番DB完全隔離・高速化・ライブクラッシュ修正・JS整合性検査導入
- **`tests/test_security.py` の完全隔離・高速化・800行制限撤廃**:
  - `setUpModule` / `tearDownModule` で一時ディレクトリの一時DBへ `switch_database_path()` し、本番 `cache/library.db` やルート `Tetheract_Mobile.html` に一切触れないよう隔離。実LAN待受（`ensure_lan_listeners`）もモック化。
  - テスト実行中は `security.PBKDF2_ITERATIONS` を軽量値にパッチして実行時間（33秒）を大幅短縮（本番定数値 `200_000` 自体のアサーションは維持）。
  - `L622-642` の歪な800行上限アサーションを撤廃。
- **ライブクラッシュ即時修正**: `frontend/js/compare.js:515` の未定義呼び出し `hasBakedAdjustments(photo)` を `hasBakedViewAdjustments(photo)` に修正。
- **`tests/test_js_integrity.py`（新規）**: 同梱Python標準ライブラリのみで1秒以内に回るスモーク検査（`index.html` / `mobile.html` の全ローカルJS/CSS実在検証、既知のチェリーピック漏れ・未定義グローバル呼び出し・括弧バランス検査）を導入。

### 1.5 Phase 1 検証計画
1. 全編集ファイルのリンク実在・制御文字ゼロ・既存の未コミット変更（`PhoneCase*` 等）が無傷であることを確認。
2. `.\python\python.exe -m unittest discover -s tests -p "test_*.py"` を実行し、全テスト合格・実行時間短縮・本番 `cache/library.db` の `mtime` 不変を実測確認。
3. `scripts/build_android_apk.py` のアセット同期・検証処理がエラーなく動作し、`frontend/mobile.html` 原紙を汚さないことを確認。

---

## Phase 2 (P2 - 次回実施): 体感パフォーマンス即効止血 ＆ 未コミット変更・サイレントバグ一掃

### 2.1 バックエンド＆SQLite 即効止血（Quick Wins）
- **Alt-Tab 事前キャッシュ爆破の廃止＆スレッドプール化**: `server/app.py:675` (`api_check_external_updates`) を同期 `def` へ変更し、`L693-695` の事前キャッシュ全消去を廃止（実際に差分があった対象のみ無効化）。
- **遅延スキャン自爆クリアの廃止**: `server/app.py:941` (`_bg_warm_dir_scan`) 完了時の `_API_PHOTOS_RESPONSE_CACHE.clear()` を削除。
- **キャッシュ世代のドメイン分離**: `connection.py` の単一 `_DB_COMMIT_SEQ` を `photos_seq` / `tags_seq` / `folders_seq` に分離。`thumbnails.py:71-75` (`save_thumbnail`) の不要な `UPDATE photos` と、`clear_online_cache` / `clear_folders_fs_cache` からの世代更新を廃止し、タグ変更時に `GET /api/tags` 内の `get_connection_counts()` がミスしないようにする。
- **モバイル背景監視・Uplink負荷の適正化**: `server/app.py:269` (`_bg_mobile_delta_watcher`) は未ペアリング時に完全休止し、ペアリング中も4秒ポーリングを廃止してオンデマンド/アイドルデバウンス生成へ変更。`api_mobile_case_upload` / `api_mobile_sync_import` の重処理をスレッドプールへ移し、Uplink中のキャッシュ消去・SSE通知をバッチ完了時へ集約。
- **SQL 183倍高速化＆欠落インデックス補完**:
  - `server/database/photos.py:258-305, 984-994`: フォルダ絞り込みを相関 `EXISTS` から `p.id IN (SELECT ... idx_photo_links_dir_nocase UNION SELECT ... idx_photo_links_vsn_reldir)` へ変更（`47.72ms → 0.26ms`、※`rel_dir` 先頭 `\` を維持）し、`L1370-1382` のリンク水和にも `pl.photo_id IN (...)` を適用。
  - `server/database/photos.py:1326` の既定ソートに一致する複合インデックス `(is_unlinked, date_taken DESC, file_name ASC)` を追加。
  - `server/preload_thumbnails.py:97` と `server/database/photos.py:2864` に欠落していた `INDEXED BY idx_thumbnails_dims` を追加。

### 2.2 PCフロントエンド 即効止血（Quick Wins）
- **外部更新IDリーク解消**: `frontend/js/common.js:1141` で `check-external-updates` 完了後に `_pendingExternalPhotoIds.clear()` を実行。
- **送信前マイクロタスク合流**: `frontend/js/app.js:179` (`fetchPhotos`) 先頭に `queueMicrotask` 合流を入れ、`lab.js:108, 113, 459` 等の2〜3連発をHTTP送出前に1回へ統合（重複呼び出し自体も整理）。
- **$O(1)$ インデックス導入**: `state.photoById = new Map()` を構築し、`selection.js` / `storage.js` の大量選択・右クリック時 $O(N^2)$ 線形探索を解消。
- **全DOM破棄・全再取得の撤廃**: `inspector.js:2310, 2328` / `lightbox.js` の単一タグ操作時 `renderPhotoGrid()` 全破棄2回、および `selection.js:900` の複数枚評価変更時 `fetchPhotos()` 全再取得を廃止し、対象カードDOMの直接部分更新に統一。
- **無駄な通信・死にコード除去**: `location_tree.js` のローカル開閉化、`folder_tree.js:2194` 設定モーダルのアクティブタブ遅延ロード＆二重実行除去、`media_volumes.js:484-656` の二重 `renderFolderTree` と170行死にコード削除、`selection.js:1548-1563` の異物コピペ削除。

### 2.3 未コミット `PhoneCase*` バグ7件・バックエンドサイレントバグ4件・チェリーピック漏れの修正
- **未コミット `PhoneCase*` 7件**: ①`PhoneCaseTransferRunner.kt` の `wifiSyncManager.getConfiguredToken()` 参照、②`TetheractNativeBridge.kt` の転送完了後同期直列化、③`postJson` のHTTPステータス確認、④`mode=delta` と `is_case_upload_active` クールダウンの整合、⑤`mobile_case_router.py` の Lv.2 暗号化サイズ判定＆外付け既存写真レコードへのGPS直接更新＆安全な移動処理、⑥ドラフト個別評価のフォールバック修正、⑦`phone_case_adapter.js` タイマー解放・`MainActivity.kt` `updateKeepScreenOn` スレッド内評価。
- **バックエンドサイレントバグ4件**: ①`schema.py:167` `_FAST_BOOT_REQUIRED_MIGRATIONS` への `cross_volume_raw_jpeg_pair_v1` 追加、②`ai/worker.py:226-235` の `ensure_thumbnail` 呼び出し修正、③`security.py:1432` の `root_path` → `folder_path` 修正、④`mobile_sync_apply.py` の単一トランザクション化（および `test_core_regression.py` 背景サムネイルスレッドの同期/モック隔離）。
- **`main`↔`v2` チェリーピック漏れ**: `compare.js` / `lightbox.js` の90°/270°回転寸法補正、`compare.js:1075` の `state.ratingFilter.has(...)`、`photos.py:2166, 2184` の `invalidate_fast_cache()` とスタックSQL `COALESCE` 補完。

---

## Phase 3 (P3 - 中期構造改善): 定数時間アーキテクチャ＆モノリス計画分割

### 3.1 Android / Touch モバイル基盤の抜本治療
- **`LockerDatabaseManager.kt` の排他制御＆バッチJNI**: 全読取/書込に `ReentrantReadWriteLock` を導入し、`wifi_delta` 適用後の不要な `closeLibraryDatabase()` + `-wal` 削除を廃止。100枚評価・タグ変更を1トランザクション・1 JNIで処理する `savePhotoChangesBatchJson` を新設し、`getLockerStatusJson` からUIスレッドSAF探索を分離、RAWプレビュー抽出をヘッダ範囲読みへ変更。
- **幽霊モジュールの整理と単一Adapter・イベントバス化**: 未使用の `core/journal_sync.js`・不整合な `core/filter_engine.js`・死にジェスチャを整理し、`mobile.js` の偽装生SQLプロキシ（52箇所の `TetheractNative` 直叩き）を `LockerDatabaseManager.queryPhotosJson`（必須 `LIMIT/OFFSET` ページング）ベースの単一 `TetheractDataAdapter` と `CustomEvent` バスへ統合。`mobile.js`（5,436行）を責務別4モジュールへ分割。

### 3.2 バックエンド定数時間化＆モジュール分割
- **`/api/photos` の軽量化（33.45MB → 数MB以下）と一覧時 `os.scandir` 全廃**: 一覧APIから全メンバー `stack_photos` 同梱（17,470行・+12MB）を分離して展開時オンデマンド `/api/stacks/{stack_id}` 化し、カーソル/ページングを導入。`has_xmp` をDBカラム化して一覧時の `os.scandir` を全廃。
- **スキャン＆RAW解析高速化**: `scan_directory` で `DirEntry.stat()` 一致時の `open()+read(8)` をスキップ、`lens_model` 探索済みフラグ導入（2,774枚の毎回再open根絶）、Lv.2 RAW解析の `BytesIO` / 範囲復号化（`%TEMP%` フルサイズ書出廃止）。
- **バックエンド分割＆配布ガード**: `photos.py`（5分割）・`app.py`（ルーター分離＋`CacheCoordinator` 集約）を段階実施し、`scripts/publish_release.py` のブランチ/バージョン系列ガードと `build_dist.bat`（v2時）のAPK鮮度チェックを統合。

### 3.3 PCフロントエンド仮想スクロール＆UI共通化
- **2D仮想スクロール**: 写真グリッドに行単位の2D仮想スクロール（画面外DOM回収）＋ `rAF` スクロール制御＋`onThumbImageLoad` 差分ガードを導入。インスペクタ非表示タブの遅延描画＋Leaflet破棄漏れ修正、Lightbox/Compare の純粋 CSS `transform` 化、英語 `i18n` の動的データ領域 `MutationObserver` 除外を実施。
- **タグツリー共通化＆CSS整理**: `core/tree_builder.js` を `index.html` に正式配線して6箇所コピペのタグツリーUIを共通 `TagTreeView` へ統合。`StateStore` 導入と `ui-unify.css` の `@layer` 統合（`!important` 537箇所の段階撤廃）を推進。

---

## Phase 4 (P4 - クローズドテスト後・一般公開前必須): セキュリティ封鎖（Release Gate）

1. **`Origin: null` + PNA CORS の遮断 (`server/app.py:297-318, 360, 372-383, 409-413`)**:
   - `_NULL_ORIGIN_ALLOWED_PATHS` から `info` / `pair-info` / `locker-sync` / `discover` / `case-*` / `field-logs` を除去し、`Origin: null` リクエストには `Access-Control-Allow-Private-Network: true` を一切返さない（単体HTMLからの同期も有効な `LAN_TOKEN` 提示を必須化）。
2. **LANペアリング窓口の指定IPワンタイム承認化 (`server/lan_access.py:186-202`, `server/app.py:366-370, 407-408`)**:
   - グローバル `_pairing_window_until` による同一LAN全IP開放を廃止し、`approve-pair` は指定 `client_ip` のみを短時間（60秒・ワンタイム消費）許可する。無認証リクエストへの365日 `pm_lan_token` Cookie 自動交付も撤廃。
3. **`server/lan_bridge.py:98-120` のフェイルクローズ化と回帰テスト拡充**:
   - 初回32KB読取で `\r\n\r\n` 未検出時は上流へ転送せず即時切断するフェイルクローズ実装へ変更し、`tests/test_security.py` に Drive-by `Origin: null`・第三者LAN IP混入・巨大ヘッダの回帰テストを追加。
