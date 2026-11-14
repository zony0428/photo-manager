# Tetheract Photo Manager モダナイゼーション＆高速化 タスクリスト

## 事前監査フェーズ（完了）
- [x] 全32本のAIルール・KI・スキル・開発ワークフローの監査（`rules-ki` / `verifier-arch`）
- [x] v2モバイルUI・Touch 3層・Androidネイティブ・未コミット変更の監査（`v2-mobile-arch` / `verifier-arch`）
- [x] PCフロントエンド描画・状態管理・CSS肥大化の監査（`frontend-pc` / `verifier-perf`）
- [x] バックエンド・SQLite実DB `EXPLAIN QUERY PLAN` ベンチマーク・スキャン性能監査（`backend-perf` / `verifier-perf`）
- [x] テスト隔離・`main`↔`v2` ブランチ乖離・ビルド＆セキュリティ横断監査（`qa-git-debt` / `verifier-arch`）
- [x] 監査決定版レポート（`audit_report.md`）・実装計画書（`implementation_plan.md`）・タスクリスト（`task.md`）の保存（`audit-scribe`）

---

## Phase 1 (P1 - 完了 / ローカルコミット `6d1abb8`): 開発速度回復・AIルール浄化・ビルド非汚染化・テスト隔離
- [x] **`AGENTS.md` ＆ `.agents/` の70%超スリム化とコミット儀式適正化**（担当: `rules-ki`）
  - [x] `AGENTS.md` を 240行 → **88行（11.4KB）** へ凝縮（制御文字 `0x0c`/`0x08` 除去、日常コミットからの版数/マニュアル更新分離、機械的800行＆4ロール強制撤廃、計画書保存先 `docs/<topic>/` 統一）
  - [x] `.agents/rules/` を `branch-and-dist-separation.md`（46行、`UDP自動発見 8088` 等更新）1本へ集約し、重複7本を `docs/archive/rules_legacy/` へ退避
  - [x] `.agents/skills/` 2本（`findstr` 修正・リリース時専用化・絵文字推奨記述削除）の整備と `.agents/agents/` 2本の `docs/archive/agents_legacy/` 退避
  - [x] `docs/README.md` のリンク切れ6本修復と新索引への更新
- [x] **`docs/knowledge/` 現行v2仕様への刷新 ＆ `build_android_apk.py` 浄化**（担当: `v2-mobile-arch`）
  - [x] 陳腐化・重複KI 12本（`feature-code-map.md` 等）を `docs/archive/knowledge/` へ退避し、コア6本＋`README.md`（計681行）を現行v2仕様（`TETHERACT ld`, `PhoneCase*`, `/api/mobile/case-preflight`, インプロセスTCP中継 `lan_bridge`, `UDP 8088`, `#viewHeaderChipBar`, 未配線モジュール注意書き）へ更新（全体 **32本 3,285行 → アクティブ11本 962行［70.7%削減］**）
  - [x] `scripts/build_android_apk.py` による `frontend/mobile.html` 原紙・一致済み `android/app/build.gradle` の書き換え廃止（`assets/mobile.html` ＆バンドルZIPのみ時刻刻印）
  - [x] `FRONTEND_SYNC_TARGETS` を厳選（**74本 4.05MB → 25本 1.41MB［65.2%削減］**）し、`L234-254` の歪な800行ハードエラーを撤廃
- [x] **テスト完全隔離・高速化・ライブクラッシュ修正・JS整合性検査新設**（担当: `qa-git-debt`）
  - [x] `tests/test_security.py` の一時DB隔離（本番 `cache/library.db` / `Tetheract_Mobile.html` 非汚染、`stats.DB_PATH` パッチ含む）、`ensure_lan_listeners` モック化、`PBKDF2_ITERATIONS` テスト時軽量化（本番定数値アサーション維持）、`L622-642` の800行テスト撤廃（単体 **27.0s → 0.99s**）
  - [x] `frontend/js/compare.js:515` の未定義 `hasBakedAdjustments(photo)` → `hasBakedViewAdjustments(photo)` クラッシュ修正
  - [x] `tests/test_js_integrity.py`（HTML参照ローカルJS/CSS実在検査・未定義グローバル呼び出し＆括弧バランス検査：4 tests / 0.71s）の新規追加
- [x] **Phase 1 横断検証＆完了記録**（担当: `verifier-arch` / `audit-scribe`）
  - [x] 全編集ファイルの整合性・リンク実在・制御文字ゼロ・未コミット変更15ファイル（`PhoneCase*` 等）のSHA256完全一致確認
  - [x] `unittest discover` **全66件合格 / 6.10秒（81.7%短縮）**・本番 `cache/library.db` `st_mtime_ns` 不変・`build_android_apk.py --check-only --sync-assets` 合格＆非汚染の実測確認
  - [x] `walkthrough.md` の作成と `task.md` 完了更新、Phase 1 変更分のみのクリーンコミット作成（`6d1abb8`）

---

## Phase 2 (P2 - 完了 / ローカルコミット `dbbccb5`, `2eaf991`): 体感パフォーマンス即効止血 ＆ 未コミット変更・サイレントバグ修正
- [x] **バックエンド「無変更キャッシュ自爆」と不要バックグラウンド負荷の停止**（担当: `backend-perf` / `v2-mobile-arch`）
  - [x] `server/app.py` `api_check_external_updates` の `run_in_threadpool` スレッドプール化＆事前キャッシュ3種無条件全消去の廃止（実変更ディレクトリのみピンポイント破棄）
  - [x] `server/app.py` `_bg_warm_dir_scan` 完了時の自爆 `_API_PHOTOS_RESPONSE_CACHE.clear()` 廃止
  - [x] 5系統ドメイン別コミット世代分離（`db` / `photos` / `tags` / `links` / `thumbnails`）、`save_thumbnail` の不要 `UPDATE photos` 廃止、FSクリアからの世代更新廃止、および `/api/photos` `resp_cache_key` への `get_links_seq()` 連動（USB抜去即時反映）
  - [x] 未ペアリング時の `_bg_mobile_delta_watcher` 完全休止（ペアリング中も15秒静穏＆45秒間隔へ抑制）、および `api_mobile_case_upload` / `api_mobile_sync_import` のスレッドプール化＆Uplink通知1.0秒デバウンス集約
- [x] **SQL 450〜665倍高速化＆欠落インデックス補完**（担当: `backend-perf`）
  - [x] `server/database/photos.py` フォルダ絞り込みの非相関 `UNION` サブクエリ化（実DB 2枚フォルダ **`47.72ms → 0.106ms`［約450倍高速化］**、912クエリ結果不一致 `0件`）と、リンク水和 `pl.photo_id IN (...)` ＋ `COLLATE BINARY` 整合（**`13.97ms → 0.021ms`［約665倍高速化］**）
  - [x] 既定ソート用複合インデックス `idx_photos_unlinked_date_fname(is_unlinked, date_taken DESC, file_name ASC)` 追加（`TEMP B-TREE` 完全解消）と、`preload_thumbnails.py:97` / `photos.py` `get_existing_photos_map` への `INDEXED BY idx_thumbnails_dims` 追加（**`84.82ms → 23.47ms`［約3.6倍高速化］**）
- [x] **PCフロントエンド多重発火・全DOM破棄・$O(N^2)$ フリーズ止血**（担当: `frontend-pc`）
  - [x] `common.js` `/api/photos/check-external-updates` 完了後の `_pendingExternalPhotoIds` 検査済みID削除による Alt-Tab 永久通信リーク止血
  - [x] `app.js` `fetchPhotos()` の `queueMicrotask` 送信前合流、`state.photoById` / `state.stackPhotoById` Map（$O(1)$ ルックアップ＆差分除去 `removePhotoFromByIdIndex`）導入、`onThumbImageLoad` 同値スキップガード
  - [x] 単一タグ操作（`inspector.js` / `lightbox.js`、バックエンドSQL完全一致の `doesPhotoMatchActiveTagFilter` 付き）と複数枚評価変更（`selection.js`、`removePhotosFromViewBatch` 1パス $O(N)$ 除外付き）のカード部分DOM更新化、右クリックサブメニュー遅延構築、GPS候補モーダル `candidateMap.remove()` 解放
  - [x] `lab.js` 重複発火整理、`location_tree.js` ローカル開閉化＆全展開修正、設定モーダル遅延ロード＆二重実行除去、`media_volumes.js` 二重描画＆約170行死にコード削除、`selection.js` 異物コピペ削除
- [x] **未コミット `PhoneCase*` 潜在バグ7件・バックエンドサイレントバグ4件・チェリーピック漏れの修正**（担当: `v2-mobile-arch` / `backend-perf` / `frontend-pc`）
  - [x] `PhoneCaseTransferRunner.kt` の `wifiSyncManager.getConfiguredToken()` 動的参照・HTTP 4xx/5xx と通信切断の分離（6.5秒誤探索防止）・ドラフト個別評価/タグ上書き防止、`TetheractNativeBridge.kt` / `MainActivity.kt` 転送完了後同期の1.5秒遅延直列化＆`updateKeepScreenOn` CASスレッド内評価、`phone_case_adapter.js` `clearTimeout(timer)` 修正、`mobile_case_router.py` Lv.2 論理サイズ判定（`_1.JPG` 増殖防止）＆連番退避＆外付け既存写真GPS直接更新
  - [x] `schema.py` `_FAST_BOOT_REQUIRED_MIGRATIONS` への `cross_volume_raw_jpeg_pair_v1` 追加、`ai/worker.py` `ensure_thumbnail` `bytes` 対応、`security.py` `scan_roots.folder_path` 修正、`mobile_sync_apply.py` 単一トランザクション原子化＆`wal_checkpoint(PASSIVE)`、`stats.py` `_db_conn.DB_PATH` 動的参照化
  - [x] `main`↔`v2` チェリーピック漏れ（`compare.js`/`lightbox.js` 90°/270°焼き込み回転寸法スワップ、`compare.js` `state.ratingFilter instanceof Set` 対応、`photos.py` `invalidate_fast_cache` ＆ スタックSQL 3箇所 `COALESCE(rotation, 0)`）の解消
- [x] **Phase 2 回帰テスト新設・実DBベンチマーク検証・完了記録**（担当: `qa-git-debt` / `verifier-perf` / `verifier-arch` / `audit-scribe`）
  - [x] `tests/test_p2_performance_and_fixes.py` 新規作成（6テスト / 0.66s）＆全テストスイート **72 tests in 6.95s — ALL OK**・本番DB非接触確認
  - [x] 実DB（`file:cache/library.db?mode=ro`）での `EXPLAIN QUERY PLAN` ＆速度計測、`build_android_apk.py --check-only --sync-assets` 全4フェーズ合格（25ファイル 1.41MB 同期）
  - [x] `walkthrough.md` への Phase 2 実測成果追記と `task.md` 完了更新、クリーン2コミット（`dbbccb5`, `2eaf991`）確定

---

## Phase 3 (P3 - 完了 / ローカルコミット `c039cfe`, `65063f5`): 定数時間アーキテクチャ＆Android排他/バッチJNI＆2D仮想スクロール＆共通配線
- [x] **Slice P3-A: バックエンド定数時間化・一覧時 `os.scandir` 全廃・ペイロード軽量化・スキャン＆Lv.2高速化**（担当: `backend-perf`）
  - [x] `photos.has_xmp` DBカラム化（`fast_boot` 対応）＆`scanner.py`/`sidecar.py`（書出/削除/移動/改名/コピー）同期、一覧取得時の304フォルダ `os.scandir` ループおよび `_bg_warm_dir_scan` 全廃（ディスクI/O **0回**・コールドハング根絶）
  - [x] `/api/photos` の `stack_photos` スリム属性化（`volume_serial` 常時付与含む・`stack_photos` **`-30.6%`** / 非スタック **`-22.86MB [-23.7%]`**）・チャンク `IN` 化、`limit`/`offset` 定数時間ページング（100件 **`4.7ms`**）、`GET /api/stacks/{stack_id}` 詳細API整備
  - [x] `scan_directory` 単一パス `os.scandir` ＆未変更ファイルの `open()+read(8)` スキップ（`0回`）、`lens_model = ''` 空文字センチネルによる2,774枚の永久再open根絶、差分0件時の再計算スキップ＆`recalculate_stacks_for_directories` 一括化
  - [x] Lv.2 カプセル化RAW解析の `_VaultDecryptedStream`（先頭64KB復号シーク）＆ `decrypted_bytes_context`（`BytesIO`）化による `%TEMP%` フルサイズ一時書出の完全ゼロ化
- [x] **Slice P3-B: PC 2D仮想スクロール・インスペクタ遅延描画・`tree_builder.js` 6箇所共通配線**（担当: `frontend-pc`）
  - [x] 写真グリッドの行単位 2D 仮想スクロール（top/bottom スペーサー・常駐DOM **16,287枚 → 約80〜140枚［99%削減］**・選択状態100%復元・`ensureCardsRenderedUpTo` 即時ジャンプ・300枚以下フォールバック・`rAF` スロットル・小バッジ `backdrop-filter` 除去）、およびスリム `stack_photos` 代表交代時の属性漏洩防止＆`ensureStackMemberDetail` 非同期補完
  - [x] インスペクタ非表示タブ（`tags` / `exif` / `map`）の dirty 遅延描画＆65〜75msデバウンス、`renderCompareStrip` の1D横仮想ウィンドウ化＆クローズ時DOM解放、Lightbox/Compare パン・ズームの同期レイアウト読取キャッシュ化、英語 `i18n` `MutationObserver` のユーザーデータ/SVG走査除外
  - [x] `core/tree_builder.js` の `index.html` 正式配線（モバイル互換100%維持）と、PC側6箇所（`sidebar_filters`, `inspector`, `folder_tree`, `selection`, `sidebar_cascade_flyout`, `filter_chips`）のタグツリー構築共通化
- [x] **Slice P3-C: Android `ReentrantReadWriteLock`・バッチJNI・SAF分離・RAW範囲読み・幽霊モジュール退避**（担当: `v2-mobile-arch`）
  - [x] `LockerDatabaseManager.kt` の `ReentrantReadWriteLock`（並列共有 `readLock` / 排他 `writeLock` / 昇格デッドロック防止ガード・ロック外復号）導入、および `WifiLockerSyncManager.kt` の `wifi_delta` 後 `close()` 廃止・`wifi_full` 原子置換化
  - [x] 一括保存JNI `savePhotoChangesBatchJson` 新設・配線（100枚操作時の400回超JNI＋100トランザクションを **1 JNI＋1トランザクション** へ短縮）＆ `_computeSelectedBatchTagSummary` の単一 `WHERE photo_id IN (...)` クエリ化
  - [x] `getLockerStatusJson` のUIスレッド同期SAF走査分離（キャッシュ＋背景更新）、`extractEmbeddedJpegFromRawStream` の2MBヘッダ＋前方スキップ省メモリ化（`input.readBytes()` OOM根絶）
  - [x] 幽霊モジュール `core/journal_sync.js` / `core/filter_engine.js` の `docs/archive/js_legacy/` 退避（APK Webアセット **25本 → 23本 / 1.38MB** へさらに削減）、`CustomEvent('tetheract:usb-sync-completed')` バス統一、`refreshAllData` single-flight 合流、残存 `alert()` 4箇所のトースト置換＆ `onJsAlert` 安全弁追加
- [x] **Slice P3-D & 横断検証: 配布安全ガード・回帰テスト・実DBベンチマーク・完了記録**（担当: `qa-git-debt` / `verifier-perf` / `verifier-arch` / `audit-scribe`）
  - [x] `scripts/publish_release.py` のブランチ＆`VERSION` 二重安全ガード（`v2`/`2.x` から `public/main` への誤プッシュ完全遮断）＋ `--check-v2-apk` 鮮度検査、`build_dist.bat`（v2時）のAPK存在/鮮度チェック＆開発ルート `Tetheract.exe` 誤上書き保護
  - [x] `tests/test_security.py` / `tests/test_js_integrity.py` 更新および `tests/test_p3_architecture.py`（7テスト）新規作成、全テストスイート **79 tests in 6.79s — ALL OK**・`:app:compileDebugKotlin` `BUILD SUCCESSFUL` 確認
  - [x] 実DB Read-only ベンチマーク・APK同期検証（`rc=0`）・本番 `cache/library.db` `st_mtime_ns` 完全不変確認、`walkthrough.md` ＆ `task.md` 完了更新、クリーン2コミット（`c039cfe`, `65063f5`）確定

---

## Phase 4 (P4 - 完了 / ユーザー確認待ち未コミット維持): セキュリティ封鎖（Release Gate）
- [x] **`[SEC-1]` Drive-by `Origin: null` + PNA 越境攻撃の完全遮断**（担当: `v2-mobile-arch`）
  - [x] `server/app.py` の `_NULL_ORIGIN_ALLOWED_PATHS` を `{"/api/mobile/sync-import"}` 1本のみへ最小化（`locker-sync` / `info` / `pair-info` / `discover` / `case-*` / `field-logs` 等は `OPTIONS`・実リクエストとも即 `403` 遮断）
  - [x] `Origin == "null"` に対する `Access-Control-Allow-Private-Network: true` の完全不付与、および `127.0.0.1` / `::1` ループバック発でも無認証特権・Cookie単体認証を剥奪し明示 `LAN_TOKEN`（`?t=` / `X-Tetheract-Lan-Token` / `Authorization: Bearer`）提示を必須化（`use_detected_file=True` も `Origin: null` からは `403` 遮断）
- [x] **`[SEC-2]` LANペアリング窓口の指定IPワンタイム承認化＆無認証Cookie自動交付撤廃**（担当: `v2-mobile-arch`）
  - [x] `server/lan_access.py` / `mobile_router.py` のグローバル `_pairing_window_until` 全IP無差別開放を完全廃止（`enable_lan=1` はLANリスナー起動のみ）
  - [x] `normalize_lan_client_ip()` 検証済みの特定プライベート/ループバック `client_ip` のみを短時間（90秒）承認（`approve_lan_pairing_ip`）し、TCP `/api/mobile/discover` で `pair_token` を引き渡した瞬間に `consume_lan_pairing_approval()` でワンタイム失効（UDP `8088` 探索は承認未消費かつ `pair_token: ""` 固定）
  - [x] `server/app.py` ミドルウェアの `is_lan_pairing_approved_for` バイパスおよび無認証リクエストへの365日 `pm_lan_token` Cookie 自動交付を完全撤廃（有効な `LAN_TOKEN` 明示提示時のみ交付）
- [x] **`[SEC-3]` `lan_bridge.py` フェイルクローズ化・設計書更新・攻撃シミュレーション回帰テスト**（担当: `v2-mobile-arch` / `qa-git-debt` / `verifier-arch` / `audit-scribe`）
  - [x] `server/lan_bridge.py` の初回32KB超未完結ヘッダ時の上流非接続・`HTTP/1.1 431` 即時切断（フェイルクローズ化）と偽装 `X-Tetheract-Lan-Client` 除去強化、`docs/knowledge/security-architecture.md` 同期
  - [x] `tests/test_security.py` への `[SEC-1]`/`[SEC-2]`/`[SEC-3]` 攻撃シミュレーション＆正規4フロー互換テスト拡充（`test_security.py` 全19件 / 全スイート **82 tests in 6.82s — ALL OK**）、APK 23ファイル整合＆本番DB完全非接触確認、`walkthrough.md` ＆ `task.md` 全4フェーズ完結更新（※`HEAD = 65063f5` 上で未コミット維持）
