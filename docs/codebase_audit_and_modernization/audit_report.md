# Tetheract Photo Manager (v2系) 全方位コードベース監査・パフォーマンス解剖レポート

- **監査実施日**: 2026-11-12
- **対象ブランチ**: `v2`（`v2.1.7+` 現行ワークツリー・未コミット変更16件＋新規1件を含む）
- **監査手法**: 5領域専門エージェント（AIルール/KI・v2モバイル/Android・PCフロントエンド・バックエンド/SQLite・QA/Git/セキュリティ）による全ファイル走査・実DB Read-only `EXPLAIN QUERY PLAN` ベンチマーク、および2名の検証官（Architecture Verifier / Performance Verifier）による実コード裏付け・誤認訂正

---

## 0. エグゼクティブサマリー

### 0.1 コードベース＆実DB定量プロファイル

| 区分 | 規模・計測値 | 備考 |
| :--- | :--- | :--- |
| **Backend Python (`server/`)** | 56ファイル / **34,538行** | 最大: `database/photos.py` (3,888行), `app.py` (2,926行), `security.py` (2,346行), `storage_manager.py` (2,321行), `scanner.py` (2,227行) |
| **Frontend JS (`frontend/js/`)** | 39ファイル / **51,170行** | PC側32本 (41,451行) + モバイル/Touch系 (`mobile.js` 単体 **5,436行**) |
| **Frontend HTML / CSS** | `index.html` 3,409行 / CSS 14本 **18,979行** | `!important` 計 **537箇所**（うち `ui-unify.css` 単体で288箇所） |
| **Android Native (`android/.../java`)** | 16ファイル / **7,986行** | 776〜798行の800行寸止めファイルが集中 |
| **自動テスト (`tests/`)** | 3ファイル / **5,198行**（61 tests） | 生産コード計 **93,694行** に対し API未テスト率 **65%**（99/153ルート）、JS/Kotlin実行テスト **0件**、実測 **33.34秒** |
| **AIルール・KI・スキル群** | 32ファイル / **3,285行（約381 KB）** | `AGENTS.md` + `.agents/` 12本 + `docs/knowledge/` 19本 |
| **実DB (`cache/library.db`)** | **567.79 MB**（WAL等含め最大595MB） | `photos` **31,864行**（一覧トップ表示 **18,724件**）、`photo_links` **34,090行**（Google Drive `G:\`・NAS `Z:\` 含む **304フォルダ**）、`thumbnails` **31,862行**（約550MB WebP BLOB）、**4,333スタック**（所属17,470行）、RAW+JPEGペア 749件、`lens_model IS NULL` **2,774枚** |

### 0.2 なぜ「v2系の改善や問題解決に時間が掛かるようになった」のか？

調査の結果、単一の原因ではなく **4つの構造要因が掛け算で増幅し合う負のフィードバックループ** が特定された。

1. **古い地図（381KBのルール/KI）と重すぎるコミット儀式によるAIの迷走・巨大バッチ化**:
   - ルール群が「まず `feature-code-map.md`（51KB）と3層分離仕様を参照せよ」と命じるが、肝心のv2中核モジュール35ファイル超が言及ゼロであり、逆に外部参照ゼロの「幽霊モジュール（計1,772行）」を正規アーキテクチャとして解説している。AIは毎回ダミー層を読んでから実動する `mobile.js`（5,436行）を探し直す二重調査を強いられている。
   - さらに毎コミットの `VERSION`・`?v=`・`MANUAL.md`・`#helpModal`・`mobile_bundle.py`・全件テスト（33秒）同期義務（Full Path）が重すぎるため、「1コミット1目的」が崩壊し、1コミットに5〜6機能を詰め込む巨大バッチ化と切り分け困難を招いている。
2. **歪な800行ハードテスト × 単一IIFE閉鎖構造 × 7重データストア**:
   - `tests/test_security.py:622-642` と `scripts/build_android_apk.py:234-254` が新規モジュールと `*.kt` にのみ `<= 800行` のハードアサーション（超過でテスト/ビルド失敗）を課し、既存の `mobile.js`（5,436行）と `photos.py`（3,888行）を検査対象外にしたため、770〜798行の寸止めファイル9本が乱立し、溢れたロジックが既存モノリスへ逆流した。
   - 状態が7つのデータストアに分散し、同一ビジネスルール（RAWペア除外・タグ階層・非破壊調整・重複照合）が Python / JS 3系統 / Kotlin の **6〜9ファイルに手動複写** されているため、1つの仕様変更が20ファイル修正と片方漏れ（モグラ叩き）を引き起こす。
3. **ノーロックDB競合と単一世代キャッシュ崩壊による非決定的な挙動**:
   - Android側のノーロックSQL読取と `closeLibraryDatabase()` の競合や、PC側の単一 `_DB_COMMIT_SEQ` 全キャッシュ破棄により、タイミング次第で `<1ms` と `数秒フリーズ / 空配列 [] 返却` が切り替わるため、対症療法のリトライや強制再取得が積み増され、さらに競合を悪化させている。
4. **テスト空白（JS/Kotlin実行テスト0件）とビルド毎のGit追跡ファイル汚染**:
   - APKビルドのたびに `android/app/build.gradle` と原紙 `frontend/mobile.html` のタイムスタンプが書き換わってGitコンフリクトを量産し、`main`↔`v2` チェリーピック時の取りこぼし（`compare.js:515` の未定義関数クラッシュ等）がテスト不在で素通りしている。

### 0.3 なぜ「手を入れる毎に体感速度が良くなったり悪くなったり乱高下する」のか？

1. **「`<1ms` 丸ごとキャッシュ」と「`1.8秒 + 33.45MB JSON` フル再構築」の極端な二値断崖**:
   - 基底処理（`limit=0` 全件返却・スタック17,470行の毎回同梱・一覧取得時の304フォルダ `os.scandir`）を重いまま残し、単一カウンタ `_DB_COMMIT_SEQ` と60秒TTLの丸ごとキャッシュで覆い隠している。そのため「表示更新漏れを防ぐため `clear_*_cache()` や `fetchPhotos()` を1行足す」と一気に2秒フリーズへ転落し、抜くと古い表示が残るシーソーゲームになっている。
2. **隠れたステップ関数（閾値分岐）の罠**:
   - `選択1枚 vs 2枚`、`20フォルダ vs 21フォルダ`、`800スタック`、`1,500枚タグ`、`日本語UI vs 英語UI` で実行経路が激変するため、少数データの開発検証では高速なのに、実DB規模（31,864枚・304フォルダ・4,333スタック・Google Drive `G:\` / NAS `Z:\`）では突如フリーズする。

---

## 1. AIルール・KI・スキル・開発ワークフロー監査

対象全32ファイル（`AGENTS.md` + `.agents/` 12本 + `docs/knowledge/` 19本 = 計3,285行 / 約381KB）の実コード照合結果。

### [R-1] 重すぎるコミット／リリース儀式（Full Path 同期義務）による開発サイクル鈍化 — **Severity: Critical**
- **箇所**: `AGENTS.md:108-135`, `.agents/rules/documentation.md:12-45`, `.agents/skills/documentation-manual/SKILL.md:34-71`, `docs/knowledge/feature-code-map.md:294-296`
- **実態**: 機能追加・操作変更のコミットごとに `git fetch`/`ls-remote` 全行確認、`VERSION` 更新、`index.html` / `mobile.html` / `Launcher.cs` の `?v=` 等同期、`MANUAL.md` 更新、`index.html` 内 `#helpModal` 更新、`mobile_bundle.py` 実行、`unittest` 全件実行（33秒）を要求。結果として `AGENTS.md:42` の「1コミット1目的」が崩壊し、1コミットに複数機能を詰め込む巨大バッチ化（例: `69ecf82` `v2.1.7`, `963f363` `v2.1.5`）を誘発している。

### [R-2] 硬直的な4ロール分業と「歪な800行ハードアサーション」の逆機能 — **Severity: High**
- **箇所**: `AGENTS.md:54`, `.agents/rules/modularization-and-multi-agent.md:9-25, 57-90`, `.agents/rules/coding-standards.md:112-116`, **`tests/test_security.py:622-642`**, **`scripts/build_android_apk.py:234-254`**
- **実態（検証官裏付け済み）**:
  - AIの自主忖度だけでなく、`tests/test_security.py:622-642` と `scripts/build_android_apk.py:237-254` が新規14モジュールと `*.kt` にだけ `<= 800` 行のハードアサーションを課し、`frontend/js/mobile.js`（実測 **5,436行**）と `server/database/photos.py`（**3,888行**）を検査対象外にしていたことが、既存モノリスへのコード流入を直接強制していた。
  - 結果として `WifiLockerSyncManager.kt`(798L), `field_log_panel.js`(790L), `MainActivity.kt`(786L), `touch_phone_case.js`(784L), `data_adapter.js`(782L), `LockerDatabaseManager.kt`(782L), `touch_layout.js`(776L), `PhoneCatalogEngine.kt`(776L), `touch_gestures.js`(770L) と **770〜798行の寸止めファイル9本** が乱立し、1行圧縮による可読性低下と未配線モジュールの放置（Goodhart's Law）を引き起こしている。

### [R-3] `.agents/rules/` の frontmatter 不備による二重読み込みと冗長解説 — **Severity: Medium**
- **箇所**: `.agents/rules/*.md`（全8本）、`AGENTS.md:216-238`
- **実態**: YAML frontmatter（`trigger: always_on`）を持つのは `branch-and-dist-separation.md:1-4` の1本のみで、残り7本（計548行）は `AGENTS.md` から参照誘導して毎回 `read_file` させており、ローマ字関数名のダメ出し例（`coding-standards.md:17-61`）等の初歩的講義でコンテキストを浪費している。

### [R-4] `feature-code-map.md`（51KB）と `AGENTS.md` の大規模陳腐化 — **Severity: Critical**
- **箇所**: `docs/knowledge/feature-code-map.md:4, 248-260`, `AGENTS.md:155-212`
- **実態**: 「まず本マップを参照して該当コードを特定すること」と指示しながら、v2.1.4〜v2.1.7 の中核機能・モジュール **35ファイル超が全32ドキュメント中で言及ゼロ（0件）**：
  - ブランド呼称 `TETHERACT ld`（`frontend/mobile.html:11, 33, 102`）
  - 手許スマホ写真管理＆Uplink転送一式：`PhoneCaseManager.kt`(556L), `PhoneCaseTransferRunner.kt`(577L), `PhoneCatalogEngine.kt`(776L), `server/routers/mobile_case_router.py`(748L), `frontend/js/adapters/phone_case_adapter.js`(371L), `frontend/js/views/touch/touch_phone_case.js`(784L)
  - USBドライブWFP遮断回避インプロセスブリッジ：`server/lan_bridge.py`(273L)
  - Loomeピッカー・フォルダ取込：`frontend/js/loome_picker.js`(908L), `server/storage_folder_import.py`(480L)
  - さらに `feature-code-map.md` には `android/` 全Kotlinファイル、`frontend/js/{core,adapters,views/touch}/*`、`field_log_*` 系、`server/mobile_delta.py`、`server/mobile_sync_apply.py`、`server/media_watcher.py`、`tests/test_field_log.py` が一切未記載。

### [R-5] 実在しないパス・誤ったDOM ID・旧系列バージョン番号による直接的な誤誘導 — **Severity: High**
1. **存在しないファイル・リンク切れ**:
   - `server/xmp_sidecar.py`（`docs/knowledge/storage-and-xmp-sidecar-architecture.md:48, 54, 68`）→ 実体は `server/sidecar.py`（同 `:64` の評価値 `5/4/0/3` も旧仕様で、現行は `2/1/0/-1`）。
   - `server/run.py`（`AGENTS.md:20`, `.agents/rules/architecture-and-performance.md:68`, `feature-code-map.md:243`）→ 実在しない（ルートの `run.py` のみ）。
   - `docs/README.md:19-21, 89-94` の `RELEASE_NOTES_v3.0.1.md` 等6本 → 実ファイルは `RELEASE_NOTES_v0.3.1.md` 等へ改名済みでリンク切れ。
2. **存在しないDOM ID・逆転したセキュリティ記述**:
   - `#filterFooterBar`（`ui-design-system-and-tiat-guidelines.md:53`, `design-philosophy-four-pillars.md:33`）→ 実在せず、`frontend/index.html:838` の `#viewHeaderChipBar` が現役。
   - `#headerScopeFilterSelect` / `#headerFormatFilterSelect` / `#photoCountBadge`（`feature-code-map.md:90`）→ 正しくは `frontend/index.html:236, 244, 261` の `#headerScopeSelect` / `#headerAttrSelect` / `#currentCountBadge`。
   - `BIND_HOST = "0.0.0.0"`（`mobile-hybrid-architecture.md:80`）→ 現行 `run.py:51` は `BIND_HOST = "127.0.0.1"`。
3. **旧系列バージョン番号の混在と実装済みバックログの残置**:
   - 旧称時代の `v2.20+`, `v2.30`, `v2.43`, `v3.00` 表記が現行 `v2.1.7` より大きく見えAIが新旧を誤認。`.agents/rules/branch-and-dist-separation.md:24, 42` も `2.0.x` 固定のまま。
   - `remaining-backlog-handover.md` で未実装扱いされているレンズ絞込・12色タグ・回転/クロップ・GPX出力の大半が実装済み。

### [R-6] ルールファイル自体の制御文字破損・直接矛盾・8領域3〜5重定義 — **Severity: High**
- **制御文字混入**: `AGENTS.md` Raw L122/125 に `0x0c` (FormFeed: `\frontend/...`)、Raw L126 に `0x08` (Backspace: `\x08uild_dist.bat`)、`.agents/rules/documentation.md` Raw L13 に `0x0c` が混入。`.agents/skills/license-management/SKILL.md:85` に禁止コマンド `findstr` を記載。
- **ルール間の正面衝突**:
  1. 絵文字全面禁止（`ui-design-system.md:13, 50` 等） vs `documentation-manual/SKILL.md:81` の絵文字バッジ推奨記述。
  2. 未使用の非表示DOM残置禁止（`AGENTS.md:51`） vs `ui-design-system.md:34, 41` の旧DOM常時非表示維持指示。
  3. ユーザーグローバルルール（`docs/<topic>/` 保存） vs `AGENTS.md:187`（`docs/archive/tasks/<topic>/` に置き `docs` 直下には置かない）。

---

## 2. v2アーキテクチャ・モノリス肥大化・保守性低下の構造解剖

### [ARCH-1] 「幽霊3層アーキテクチャ（Dead Layer 1 & 2）」と `mobile.js`（5,436行）の乖離 — **Severity: Critical**
- **未配線のコア・アダプタ層**:
  - `frontend/js/core/journal_sync.js:1-513`: `mobile.html:534` と `mobile_bundle.py:54` で毎回ロード・バンドルされるが、**全コードベースから外部参照 0回の100%デッドコード**。
  - `frontend/js/adapters/data_adapter.js:1-782`: `build_android_apk.py:320-336` で10関数の契約検査までしているが、**実動本体 `mobile.js` からの呼び出しは 0回**（`touch_phone_case.js:79` の `getFilterTrees()` 1箇所のみ）。
  - `frontend/js/core/filter_engine.js:128-155`: 実DBに存在しないカラム名（`directory` / `prefecture`）と旧評価値（`5/4`）前提のまま放置。
  - PC版 `frontend/index.html` からは `core/*.js`・`adapters/*.js` ともに **1本も読み込まれていない**。
- **単一IIFEクロージャと偽装SQLトンネル**:
  - `frontend/js/mobile.js:10-5436` は全体が単一 `(function () { ... })()` クロージャで `mState` と全110関数（最大 `bindAllEvents()` 853行: `L4555-5407`）を閉じ込めており、`L495-509` (`_createAndroidNativeSqlProxy`) で sql.js を偽装して `window.TetheractNative.rawQueryJson` へ生SQLを流し込み、`mobile.js` 単体で `TetheractNative.*` を **52箇所** 直叩きしている（Layer 3 の `morph_thumb_bar.js` でも6箇所、`touch_duel.js` でも2箇所直叩き）。

### [ARCH-2] グローバル変数モンキーパッチ破綻・DOM複製再バインド・死にジェスチャ — **Severity: High**
- **`__onTetheractUsbSyncCompleted` 上書きによる Promise 永久ハング**: `frontend/mobile.html:536-546` の読込順により、①`data_adapter.js:99` が関数定義 → ②`morph_thumb_bar.js:512, 582-593` が `Object.defineProperty` の setter で横取り → ③`mobile.js:669` が再代入して `_origUsbSyncCompleted` を上書きするため、**`data_adapter.js` の `usbSyncWaiters` 解決と `CustomEvent` 発火がチェーンから完全脱落**している。
- **暗黙フックとDOM複製**: 20個超の `window.__*` フック、非表示ボタン `#mOpenDbModalBtn` (`mobile.html:90`) の `.click()` 間接発火 (`morph_thumb_bar.js:626`)、ドロワー内 `#mTagFilterList` 等の `innerHTML` を `#tTabletStageBody` / `#tNavSheetBody` へ複製して毎回イベントを再バインドする構造 (`touch_layout.js:565-583`, `mobile.js:2502-2754`)、`touch_gestures.js:46-97` の死にコード化、および `mobile.js:1011, 4421, 4518, 4545` の禁止 `alert()` 残存（`MainActivity.kt:128-148` の `WebChromeClient` に `onJsAlert` 未実装）。

### [ARCH-3] 7重データストアと仕様変更の波及爆発（Ripple Matrix） — **Severity: Critical**
状態が ①PC `library.db`、②PC `mobile_delta.db`、③WebView `sql.js`、④`localStorage` ジャーナル、⑤Android `locker/library.db`（母艦ID `< 900,000,000` とローカルID `>= 900,000,000` 混在）、⑥`pending_journal.db`、⑦`phone_case_drafts.json` + `SharedPreferences` の **7箇所** に分散（変更ジャーナルは4重、検索SQL構築は5重実装）：
- **RAW+JPEGペア除外 (`NOT_PAIRED_RAW`)**: `mobile.js:1285,1300`, `data_adapter.js:250`, `LockerDatabaseManager.kt:23-24,266,346,417,426-438`, `PhoneCatalogEngine.kt:602,759-775`, `SafUsbManager.kt:54-221` + PC DB層（**7ファイル以上**）。
- **タグ階層・12色タグ・AI/手動分離**: `mobile_sync_apply.py`, `tree_builder.js`, `filter_engine.js`, `data_adapter.js`, `mobile.js`, `LockerDatabaseManager.kt`, `PendingJournalStore.kt`, `PhoneCatalogEngine.kt` + PC DB層（**9ファイル以上**）。
- **非破壊調整（EV/トーン/回転/クロップ）**: **8ファイル** に分散。
- **PhoneCase/Uplink 重複照合 (`normalizeDupFileName` 等)**: Python/Kotlin/JS **6ファイル** に重複実装。

### [ARCH-4] APKアセット無選別コピーとビルド時のGit追跡ファイル汚染 — **Severity: High**
- **アセット複製の実態（検証官による訂正反映済み）**: `android/app/src/main/assets/` は `.gitignore:66` で除外されたビルド生成先でありGit管理下ではない（`git ls-files` は0件）。しかし `scripts/build_android_apk.py:80-89` (`FRONTEND_SYNC_TARGETS`) がPC専用の `index.html`, `app.js`, `i18n_dict.js`, Leaflet, PCフォント, `sql-wasm.wasm` を含む74ファイル（計4,148KB、うちモバイル未使用資産 **約1,037KB**）を `assets/` と `tetheract_ui_bundle.zip` に毎回複製しており、`frontend/` 編集後に再同期するまでローカル `assets/` 側にドリフトが生じる。
- **Git追跡ファイルの毎回書き換え**: `scripts/build_android_apk.py:114-135` がビルド毎に **Git追跡対象である** `android/app/build.gradle` と原紙 `frontend/mobile.html` のビルド時刻スタンプを直接書き換えるため、`git status` の常時汚染とブランチ間コンフリクト（`mobile.html` 32回、`build.gradle` 26回更新）を招いている。また `server/mobile_bundle.py:33-43, 119` の `CSP_META_TAG` 挿入は `frontend/mobile.html:5` に既存CSPがあるため常時スキップされる死にコード。

### [ARCH-5] PCフロントエンド（非モジュール26本・6重コピペ・CSS `!important` 戦争）とバックエンド肥大化 — **Severity: High**
- **PC JS**: `frontend/index.html:3382-3407` で26本のクラシック `<script>`（38,395行）をグローバル直読みし無スキーマ `state` を暗黙共有。`core/tree_builder.js` が `index.html` 未配線のまま、タグツリーUIが **6箇所**（`sidebar_filters.js:2270`, `inspector.js:1823`, `folder_tree.js:1713`, `selection.js:672`, `sidebar_cascade_flyout.js:249`, `filter_chips.js:1050`）にコピペ実装されている。
- **PC CSS**: 計18,979行・`!important` **537箇所**（`ui-unify.css:1-1891` 単体で288箇所、`modals-tools.css` で81箇所）。`grid-lightbox.css:574-669` と `ui-unify.css:179-265` で同一セレクタ群が丸ごと重複。
- **Backend**: `server/database/photos.py`（3,888行）に7責務（パス正規化・Upsert・798行の `get_photos`・評価/調整・GPS/場所ツリー・リンク切れ/レンズ補完・EXIF無し統合）が同居し、`server/app.py`（2,926行）では約70エンドポイントが6系統のキャッシュクリア関数を手動でバラバラに呼んでいる。

---

## 3. PC/バックエンド＆Android 体感パフォーマンス乱高下のメカニズムと実DB計測値

### 3.1 レイヤー横断の4大増幅ループ

1. **【Loop A】Alt-Tab フォーカス復帰 → 無変更キャッシュ全爆破 → 二段フリーズループ**:
   - 写真を1度でも外部アプリ/Explorerで開くと `_pendingExternalPhotoIds` (`frontend/js/common.js:1001`) がアプリ終了まで解放されず、以後1.5秒以上の別ウィンドウ閲覧から戻るたび `checkOnFocus` (`common.js:1113-1204`) が ①`POST /api/media/check`、②`POST /api/photos/check-external-updates`、③フォルダ表示中の `checkAndPromptFolderRefresh()` を3並列発火。
   - `api_check_external_updates` (`server/app.py:675-779`) は `async def` でメインイベントループをブロックしつつ、**外部変更の有無を調べる前の `L693-695` で無条件に全キャッシュ消去＋`_DB_COMMIT_SEQ` を+2更新**。
   - これにより ①4秒以内に `_bg_mobile_delta_watcher` が全3.1万枚のコピーを開始、②直後のUIクリックがキャッシュミスして **1.5秒＋33.45MB JSON** 再生成、③裏の6スレッド `_bg_warm_dir_scan` が `G:\`/`Z:\` 含む304フォルダ走査を終えた数秒後に **`_API_PHOTOS_RESPONSE_CACHE.clear()` (`app.py:941`) でレスポンスキャッシュを自爆**させ、2回目のフリーズを引き起こす。
2. **【Loop B】「1枚 vs 2枚」「タグ1個」で `<2ms` から `2,000ms` へ1,000倍跳ね上がる急崖ループ**:
   - 1枚評価はカードDOM直接更新で即完了するが、2枚選択評価 (`selection.js:900`) や1枚タグ付け (`inspector.js:2310-2329`) を行った瞬間、書き込みコミットが `_DB_COMMIT_SEQ` を進めて全キャッシュを無効化した直後にフロントが `fetchPhotos()`（33.45MB JSON）や `fetchTags()`（内部の `get_connection_counts()` で304フォルダ死活走査）＋ `renderPhotoGrid()`（全DOM破棄×2回）を発火する。
3. **【Loop C】フロント多重発火 × バックエンド非キャンセル並走ループ**:
   - `app.js:173-185` に `AbortController` はあるが **送信前のマイクロタスク合流が無いため**、`lab.js:108-114, 459, 468` の2〜3連発等で旧リクエストがUvicornへ到達し、ブラウザがTCPを `abort()` しても同期 `def api_get_photos` スレッドはSQLite走査〜33.45MB JSON生成を最後まで止められず並列競合する。
4. **【Loop D】スマホ Uplink 連続転送 × メインループ拘束 × `refreshAll()` 衝突ループ**:
   - `api_mobile_case_upload` (`mobile_case_router.py:517, 710-724`) が `async def` 上で1枚毎に同期EXIF/サムネ/暗号化・5種キャッシュ全消去・SSE送出を実行し、PC側がコールド状態で `refreshAll()`（10並列API）を連打する。

### 3.2 バックエンド・SQLite ボトルネック詳細（実DB検証済み）

| ID | 深刻度 | 箇所 | 実測値・問題メカニズム（検証官訂正反映済み） |
| :--- | :--- | :--- | :--- |
| **B-1** | Critical | `server/database/connection.py:167-191`, `server/app.py:828-994`, `thumbnails.py:71-75`, `scanner.py:229`, `folders.py:741` | 単一 `_DB_COMMIT_SEQ` に全読み取りキャッシュが依存。サムネ1枚保存（`save_thumbnail` の不要な `UPDATE photos`）やFSキャッシュクリアでも全キャッシュが崩壊し、`/api/photos`（`limit=0` 既定）のミス時に **約1.3〜1.8秒CPU拘束 ＋ 33.45MB JSON生成** が発生。 |
| **B-2** | High | `server/preload_thumbnails.py:97`, `server/database/photos.py:2864`（※`photos.py:901, 3151`, `folders.py:515, 822` は対応済み） | **【検証官訂正】** `get_photos` (`photos.py:901`) 等では既に `INDEXED BY idx_thumbnails_dims` が機能中（31,113行実測 `263.7ms`）。実際に `INDEXED BY` が欠落し 550MB BLOB の ROWID シーク（`SEARCH t USING INTEGER PRIMARY KEY`）を起こしているのは `preload_thumbnails.py:97`（実測 `84.82ms → 19.04ms`、Cold USB時は31,862件BLOBシーク）と `photos.py:2864`（`get_existing_photos_map`）の2箇所。 |
| **B-3** | Critical | `server/app.py:675-779` | `POST /api/photos/check-external-updates` が `async def` でイベントループをブロックし、変更確認前の `L693-695` で全キャッシュを無条件破壊。 |
| **B-4** | Critical | `server/app.py:249-274`, `server/mobile_delta.py:51-241`, `mobile_router.py:269`, `mobile_sync_apply.py:343` | `_bg_mobile_delta_watcher` に **`is_lan_device_paired()` ガードが無く**、スマホ未ペアリングのPC単体運用でも4秒周期で稼働し、`_DB_COMMIT_SEQ` 変化のたび `photos` (31,864行) / `photo_tags` / `photo_links` 全件を `mobile_delta.db.tmp` へ丸ごとコピー。`api_mobile_sync_import` も `async def` 上でブロッキング `wal_checkpoint(TRUNCATE)` を実行。 |
| **B-5** | Critical | `server/database/photos.py:258-305, 984-994` | フォルダ絞り込みが相関 `EXISTS` + `SUBSTR(pl.directory_path, 3)` のため `SCAN p`（31,864行）＋相関サブクエリ31,864回を実行。実DB 2枚フォルダで **`47.72ms` → `UNION` + `idx_photo_links_dir_nocase` / `idx_photo_links_vsn_reldir` 化で `0.26ms`（183倍高速化）** を実証（※`rel_dir` は先頭 `\` 付き格納のためバインド時維持必須）。 |
| **B-6** | Critical | `server/database/photos.py:1370-1382, 1478-1608`, `server/app.py:935-945` | ①実DB 4,333スタックが閾値 `800` を常時超え毎回17,470行全33カラムを再取得して `stack_photos` 同梱（**+11.98MB肥大 / 185ms**）、②1,500枚超で `photo_tags` 全件読込、③リンク水和（`L1370-1382`）が `SCAN pl`（34,090行フルスキャン）＋ `volumes.volume_serial` 照合順序不一致（`NOCASE` vs `BINARY`）による `AUTOMATIC COVERING INDEX` 再構築、④20フォルダ超の `_bg_warm_dir_scan` 完了時に `app.py:941` で自爆キャッシュクリア。 |
| **V-1** | High | `server/app.py:1237-1243`, `server/database/photos.py:3359-3443` | **【検証官新規特定】** タグ1個追加/削除のたびに `_DB_COMMIT_SEQ` が進み、直後の `GET /api/tags` 内の無関係な `get_connection_counts()` が100%キャッシュミスして全31,864枚×304フォルダ（`G:\`/`Z:\` 含む）の接続死活集計を毎回再計算。 |
| **V-3** | High | `server/app.py:838, 899`, `server/database/folders.py:757, 790` | **【検証官新規特定】** 60秒TTL（`_PHOTO_DIR_SCAN_TTL = 60.0`）により無操作でも60秒毎に `/api/photos` と全FSキャッシュが一斉失効し、仮想FS `G:\`・NAS `Z:\` を含む304フォルダ走査が突発。 |
| **B-7** | High | `server/scanner.py:1650-1865`, `security.py:1765-1774`, `photos.py:2741-2822, 3078-3081`, `stacks.py:445, 453` | `scan_directory` が未変更ファイル全件に `open()+read(8)` を実行、レンズ情報を持たない **2,774枚** をスキャンのたび毎回2回再open、差分0件でも全DB対象の `pair_cross_folder_raw_jpeg` + `recalculate_duplicate_stacks` を実行（削除時はフォルダ数分ループ）。 |
| **B-8** | High | `server/security.py:2016-2037`, `server/raw_loader.py:242, 539, 704` | Lv.2保護は先頭64KB＋末尾72Bのみにもかかわらず、50〜80MBのRAW全体をRAM読込してホスト `%TEMP%` にフルサイズ一時ファイルを書き出し（ポータブル無痕跡原則にも抵触）。 |
| **B-10** | High | `server/folder_tree.py:227-334`, `server/database/folders.py:976-1062` | `build_roots()` が毎回 `force_refresh=True`、`get_directory_counts_under` 4〜6回走査、`UPPER(pl.volume_serial)` によるインデックス無効化（実測 `83.02ms`）、同一ドライブへの `inspect_drive_loome_ownership` 3回重複実行。 |
| **B-11** | High | `server/database/tags.py:774-827`, `photos.py:3125-3223, 3809-3818` | `GET /api/tags` 内の毎回DDL＋`conn.commit()`（＋非表示写真を含む件数不整合）、`GET /api/locations/tree` 内の同期5,000件逆ジオコーディング＋DB書込、`GET /api/photos/missing-count` が整数1個のために全件 `get_missing_photos()` を実行。 |
| **B-12** | Medium | `server/database/photos.py:1077, 1108, 1326, 1344`, `ai/worker.py:174`, `connection.py:248`, `security.py:2139` | **【検証官訂正】** 既定ソート `p.date_taken DESC, p.file_name ASC` (`photos.py:1326, 1344`) に対応する複合インデックス `(is_unlinked, date_taken DESC, file_name ASC)` が無く毎回 `USE TEMP B-TREE` 発生。日付 `SUBSTR(REPLACE(...))`・レンズ `TRIM()`・AI未処理 `NOT IN` のフルスキャン、`close_all_connections()` の他スレッド切断競合、サムネ暗号化移行の全件 `fetchall()`（1GB超RAM）。 |

### 3.3 PCフロントエンド ボトルネック詳細

- **[F-1] 非仮想スクロール（無限追記DOM肥大）＋ 強制同期リフロー**: `MAX_DISPLAY_PHOTOS = 0` (`common.js:34`) で画面外DOMを破棄せず200枚ずつ追記 (`app.js:777-791`) し、軽微操作では `innerHTML = ''` (`L847`) で全破棄リセット。`checkAndAppendGridChunksIfNeeded()` (`app.js:806-823`) は `L813` のDOM挿入直後の `L815` で `container.scrollHeight` を読む強制同期リフローを発生させ、`onThumbImageLoad()` (`app.js:544-554`) は `createPhotoCard` (`L568-573`) の事前設定値と一致していても差分確認なく全カードで `style.setProperty` × 2 を再実行。小バッジ群 (`grid-lightbox.css:807, 844`) の `backdrop-filter: blur()` もGPU合成負荷を増大。
- **[F-2] 単一タグ操作での全DOM破棄2回＋ツリー3回構築 ＆ 2枚評価の急崖**: `addTagToPhoto` / `removeTagFromPhoto` (`inspector.js:2258-2528`, `lightbox.js:717-909`) が1タグ操作ごとに `renderPhotoGrid()` 2回＋タグツリー構築3回を実行。複数枚評価変更 (`selection.js:900`) は2枚以上になった瞬間に全件 `fetchPhotos()` へ転落。
- **[F-3] 大量選択右クリック・Shiftホバーの $O(N^2)$ 線形探索**: `state.photoById` Mapが無く、`openContextMenu` (`selection.js:188-276`, `storage.js:112-116`) が `state.photos.find()` ループを3連発（1万枚選択で最大3億回比較）＋毎回タグサブメニュー全DOM構築＆API通信を実行。`updateShiftPreview` (`selection.js:23-36`) もホバー毎に全 `.photo-card` を走査。
- **[F-4] API多重発火と設定モーダル二重実行**: `lab.js:105-119, 459, 468` の `fetchPhotos` 2〜3連発、`location_tree.js:130-208` の開閉トグル毎API再取得、`refreshAll()` 直後の重複呼び出し（`folder_tree.js:1235-1238`, `app.js:2640-2643`, `media_volumes.js:457-485` の二重 `renderFolderTree` ＆ `L486-656` の170行死にコード）、設定モーダル `openModal` (`folder_tree.js:2194-2241`) の全タブ一括通信＆2〜3重実行。
- **[F-5〜F-8] 監視重複・英語UI `MutationObserver`・非表示インスペクタ・比較画面**: `_pendingExternalPhotoIds` 未解放 (`common.js:1001`) と3秒ハートビート (`L1342`)、英語UI時の `document.body` 全域 `MutationObserver` + 正規表現総当たり (`i18n.js:249-323`)、非表示インスペクタタブの毎回タグツリー構築/Leaflet通信と `candidateMap.remove()` 漏れ (`inspector.js:1091, 1309, 1540-1559`)、Lightbox/Compare の `width/height` 実サイズ変更リフロー・比較ストリップ全枚数 `<img>` 生成 (`compare.js:685-724`)・ヒストグラム同期 `getImageData` (`histogram.js:98`)。

### 3.4 Android / Touch モバイル体感パフォーマンス詳細

1. **[Critical] `LockerDatabaseManager` のノーロック読取 × `wifi_delta` 直後の `close()` 競合**: `LockerDatabaseManager.kt` の読取系（`getPhotoCount`:L263, `getThumbnailBlob`:L271, `getPhotoFileMeta`:L288, `queryPhotosJson`:L337, `getFilterTreesJson`:L402, `rawQuerySafeJson`:L701）がロックを取らない一方、`WifiLockerSyncManager.kt:306, 352` が差分適用直後に毎回 `onNewDatabaseCopied()`（`libraryDb.close()` + `-wal`/`-shm` 削除）を呼ぶため、同時読取が `already-closed` 例外を起こし `L739-741` で黙って `"[]"` を返却（一覧・サムネイルがランダムに消失）。
2. **[Critical] UIスレッド同期JNI SQL 12連発 ＆ `LIMIT` なし全件JSON化**: `refreshAllData()` (`mobile.js:1198-1201`) のたびに9本の集計SQL (`L2143-2248`) ＋ `LIMIT` なし全件 `SELECT` (`L1305-1432`) がUIスレッドを同期ブロック。さらに `mobile.html:20` がネイティブ時も不要な `sql-wasm.js` を同期読込し、`MainActivity.kt:501` が全アセットに `Cache-Control: no-cache` を付与。
3. **[Critical] 起動・復帰時の多重 `refreshAllData()` ストームとUIスレッドSAF IPC**: `onPageFinished` (`MainActivity.kt:166`)、`onResume` (`L187`)、`mobile.js:789-808`、`touch_phone_case.js:153-158` が競合し、`getLockerStatusJson` (`TetheractNativeBridge.kt:53-71`) がUIスレッド上で同期的に重いSAF `DocumentFile` 探索と `COUNT(*)` SQLを実行。
4. **[High] バッチ操作の $O(N)$ 個別同期JNI ＆ RAW丸ごとヒープ読込**: Native時は `BEGIN TRANSACTION` が空関数 (`mobile.js:499`) のため100枚評価/タグ変更で300回超の個別同期JNI往復が発生 (`L2973, 4193, 4250`)。また `SafUsbManager.kt:54-56` が数十MBのRAW全体を `input.readBytes()` で丸ごとヒープ確保しGCストール/OOMリスクがある。

---

## 4. 品質・バグ・未コミット変更・テスト隔離・セキュリティ監査

### 4.1 ライブクラッシュ・`main`↔`v2` チェリーピック漏れ・フロントエンド腐敗バグ

1. **[Critical] PC比較画面ズーム時の即 `ReferenceError` クラッシュ (`frontend/js/compare.js:515`)**:
   - `common.js:650` の関数名は `hasBakedViewAdjustments(photo)` だが、`compare.js:515` (`_getCompareSideMetrics`) だけ未定義の `hasBakedAdjustments(photo)` をガード無しで呼んでおり、`applyCompareTransforms` 全経路で即クラッシュする。
2. **[High] `main` (`c888081` 等) ↔ `v2` のチェリーピック取りこぼし**:
   - `main` 側で修正済みの 90°/270° 回転時 `metaW/metaH` 入れ替え（`compare.js:503-524`, `lightbox.js:107-113`）、および `server/database/photos.py:2166, 2184`（`batch_update_photo_tone`, `rotate_photo`）の `invalidate_fast_cache()` 呼び出し・スタックサブ写真SQL（`photos.py:1595, 1617, 1839`）の `COALESCE(rotation, 0)...` が `v2` で欠落（逆に `v2` の `update_photo_gps` `photos.py:2286-2289` の `invalidate_fast_cache()` は `main` で欠落）。
3. **[Medium] 型不整合・誤コピペ・旧API残存**:
   - `compare.js:1075-1080`: `state.ratingFilter`（`Set` 型）を文字列/数値と `===` 比較しており、「棄」にした写真の閉鎖時除外が不動作。
   - `selection.js:1548-1563`: `openDateShiftModal()` 内にコンテキストメニュー初期化コードが誤コピペ混入。
   - `app.js:2213-2229`: 左ペイン新規タグ作成 `executeCreateTag()` が無関係な先頭写真 `state.photos[0].id` にPOSTする旧実装のまま残存。

### 4.2 バックエンドのサイレントバグ（4件・すべて実機確認済み）

1. **[BUG-1 / High] 高速起動 (`fast_boot=True`) でマイグレーション `cross_volume_raw_jpeg_pair_v1` が永久スキップ**: `server/database/schema.py:167-202` の `_FAST_BOOT_REQUIRED_MIGRATIONS` から漏れており、**実DB (`cache/library.db`) でも未適用であることを実証確認済み**。
2. **[BUG-2 / High] AI自動タグ付けワーカーがサムネイル未生成写真を100%スキップ**: `server/ai/worker.py:226-235` が `ensure_thumbnail()` に未定義キーワード引数を渡し、かつ `bytes` 戻り値に `.get("data")` を呼んで `TypeError` を握りつぶしている。
3. **[BUG-3 / Medium] 所有権フォールバック判定のカラム名誤り**: `server/security.py:1431-1438` が存在しない `scan_roots.root_path`（正しくは `schema.py:94` の `folder_path`）を `SELECT` し常時 `OperationalError` → `False` になっている。
4. **[BUG-4 / Medium] モバイル同期適用のトランザクション原子性崩壊**: `server/mobile_sync_apply.py:79-341` の外側トランザクション内で呼ぶ `update_rating` / `add_tag_to_photo` 等が勝手に `conn.commit()` を繰り返す。

### 4.3 現在進行中の未コミット変更（PhoneCase / Uplink 周り）の潜在バグ（全7件）

1. **[High] トークン再発行後の401永久回復不能バグ (`PhoneCaseTransferRunner.kt:87, 187, 442`)**: 再探索結果の `disc.optString("pairToken")` を読んでいるが、`WifiLockerSyncManager.kt:601-608` (`probeDiscoverEndpoint`) の返却JSONには `pairToken` キーが存在しない（`prefs` 保存のみ）ため、常に旧トークンを使い続ける（`wifiSyncManager.getConfiguredToken()` の取得が必要）。
2. **[High] 転送完了直後の3並列DB競合 (`TetheractNativeBridge.kt:555-564` × `touch_phone_case.js:767-769`)**: `onRescanAfterTransfer()` 直後に `__onTetheractCaseTransferCompleted`（→ 同期SQL 12連発）と `onTriggerWifiSyncAsync(false)`（→ `closeLibraryDatabase()`）が同時発火しノーロック読取と正面衝突する。
3. **[High / Verifier追加発見] Lv.2 暗号化モードでの重複 `_1.JPG` 増殖＆無条件上書き＆外付けGPS補完漏れ (`server/routers/mobile_case_router.py:609-610, 649-663, 705-706`)**: Lv.2（`TETHVLT1` カプセル化）時は既存ファイルの `st_size` が暗号化ヘッダ＋タグ分大きくなるため、GPS補完再送時に `L651 (dest_file.stat().st_size == total_written)` が偽となって `_1.JPG` 重複ファイルを生成する。また `L662 except Exception:` が無条件 `shutil.move`（先客上書き）であり、外付けドライブ上の既存写真へのGPS補完 (`L609`) も既存レコード更新ではなく `Loome\case\` への新規複製へフォールスルーする。
4. **[Medium] 非JSONエラー応答時の6.5秒LAN総当たり誤探索 (`PhoneCaseTransferRunner.kt:511-533`)**: `postJson` がHTTPステータス未確認で `JSONObject(txt)` をパースするため、500エラー等で `JSONException` → `L183 catch` が254ホストスキャン後に「PCが起動しているか確認」と誤表示する。
5. **[Medium] `is_case_upload_active` 12秒クールダウンの貫通 (`mobile_case_router.py:67-74` vs `mobile_router.py:494`)**: 背景スレッドを抑止しても、転送0ms後にAndroidが叩く `GET /api/mobile/locker-sync?mode=delta` がリクエスト内で同期的に `ensure_mobile_delta_db()` をビルドしてしまう。
6. **[Medium / Verifier追加発見] ドラフト個別評価の `0` 上書きリスク (`PhoneCaseTransferRunner.kt:122-126`)**: `it.optInt("rating", draft?.optInt("rating", 0) ?: 0)` により、`items` 要素に未評価デフォルト `"rating": 0` が入っていると `drafts` 保存済みの個別評価（優/良）が無視される。
7. **[Low] スレッド・タイマー・フラグ微欠陥**: `TetheractNativeBridge.kt:513-541` の呼出毎の生 `Thread` 生成＆巨大JSON二重エスケープ、`phone_case_adapter.js:144` の開始失敗時 `clearTimeout(timer)` 漏れ、`MainActivity.kt:200-207` `updateKeepScreenOn` のクロージャ順序逆転、`server/lan_bridge.py` の `except Exception: pass` 13箇所。

### 4.4 テスト網の隔離欠陥・配布スクリプトの安全網欠如

- **[QA-1 / Critical] テスト実行による本番環境汚染と背景スレッド競合**:
  - `tests/test_security.py:21, 138-166` が `switch_database_path()` 無しで `TestClient(app)` を動かすため、**本番 `cache/library.db` の mtime 更新・本番ルート `Tetheract_Mobile.html` の上書き・実LAN TCP/UDPリスナー起動**を引き起こす。
  - `tests/test_core_regression.py:3075` 等のサムネイル再生成デーモンスレッドがモックされておらず、`tearDownClass` (`L55`) で `DB_PATH` が本番DBへ戻った直後に走って本番サムネイルBLOBを上書きし得る競合（実測でも `FOREIGN KEY constraint failed` 警告を確認）。
  - テスト中も `PBKDF2_ITERATIONS = 200_000` (`server/security.py:55, 93`) がそのまま回り実行時間 **33.34秒** を要している。
- **[BUILD-1 / High] リリース誤プッシュ＆古いAPKサイレント同梱リスク**:
  - `scripts/publish_release.py:118-138` にブランチ・バージョン系列ガードが無く、`v2` 上で誤実行すると `public/main` を `v2` ツリーで強制上書き可能。
  - `build_dist.bat:225-228` は既存の `dist_v2\android` をコピーするだけでAPK鮮度を検証しないため、古い `Tetheract_Android.apk` を最新ZIPにサイレント同梱するリスクがある。

### 4.5 セキュリティ指摘事項（※現在クローズドテスト運用のため Phase 4 配置・一般公開前必須）

> [!WARNING]
> 以下の3件は現在は閉じた開発・クローズドテスト環境で運用中であるため、ユーザー合意に基づき Phase 4（一般公開・配布前の必須ゲート）へ配置している。不特定多数への配布や公衆Wi-Fiでの利用前に必ず封鎖すること。

1. **[SEC-1 / Critical] `Origin: null` ＋ PNA CORS 許可による外部悪意サイトからの Drive-by Localhost 全DB窃取・改ざん (`server/app.py:297-318, 360, 372-383, 409-413`)**:
   - 任意の外部Webページは `<iframe sandbox="allow-scripts">` から `Origin: null` の `fetch("http://127.0.0.1:8088/...")` を送出できる。`_NULL_ORIGIN_ALLOWED_PATHS` に `/api/mobile/locker-sync`, `/api/mobile/info`, `/api/mobile/case-upload` 等が含まれ、`127.0.0.1` 発のため `L360` でLANトークン検証がスキップされた上、`Access-Control-Allow-Origin: null` + `Access-Control-Allow-Private-Network: true` を返却するため、Tetheract起動中のPCで悪意サイトを開くだけで全 `library.db` 窃取・`LAN_TOKEN` 漏洩・ファイル注入が成立する。
2. **[SEC-2 / High] LANペアリング窓口のグローバル全IP開放＆無認証端末への365日Cookie自動交付 (`server/lan_access.py:186-202`, `server/app.py:366-370, 407-408`)**:
   - `open_lan_pairing_window(3600, client_ip=...)` が `L190` でグローバル `_pairing_window_until` を更新するため、`is_lan_pairing_approved_for()` (`L198`) が `_approved_client_ips` 判定前に同一LAN上の全IPへ `True` を返し、トークン無しの第三者端末にも365日有効の `pm_lan_token` Cookie を自動発行してしまう。
3. **[SEC-3 / Medium] `server/lan_bridge.py:98-120` の32KB超ヘッダ未注入フェイルオープン分岐**:
   - 初回読取ループで32KBに達しても `\r\n\r\n` が無い場合、`L118-119` の `else` 分岐が `X-Tetheract-Lan-Client` を注入しないまま `127.0.0.1` 上流へ転送する実装になっている（未完結ヘッダは即切断するフェイルクローズ化が必要）。
