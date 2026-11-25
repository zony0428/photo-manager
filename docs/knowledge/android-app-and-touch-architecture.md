# Android アプリ（`TETHERACT ld` / `.apk`）・Touch UI・PhoneCase ＆ フィールドログ設計書

本ドキュメントは、v2系（`v2` ブランチ / `dist_v2/`）で展開されている Android ネイティブアプリ（画面ブランド呼称 **`TETHERACT ld`**）、スマホ／タブレット可変タッチUI、Wi-Fiロッカー双方向同期、手許スマホ写真の管理・母艦転送（**PhoneCase / Uplink**）、USBドライブ稼働時の WFP 回避ブリッジ、および GPS フィールドログ（**Context Tether**）の現行アーキテクチャを定義する。

- **関連規約**: [v1.8系とv2系のブランチ・dist分離規約](../../.agents/rules/branch-and-dist-separation.md) ／ [セキュリティアーキテクチャ](security-architecture.md)

---

## 1. 最重要：現行フロントエンドの実動ファイル構成とアーカイブ済み旧モジュール

> [!IMPORTANT]
> モバイル／Android WebView UI の実動ファイル群と責務分担は以下の通り整理されている。かつて未配線のまま併存していた旧モジュール（`journal_sync.js` / `filter_engine.js`）は `docs/archive/js_legacy/` へ退避済みであり、`frontend/js/core/` には再配置しないこと。

| 区分 | ファイルパス | 現在の稼働状態と扱い |
| :--- | :--- | :--- |
| **実動本体（メイン制御）** | `frontend/mobile.html`<br>`frontend/js/mobile.js` | **現役の本丸**。画面初期化（多重 `refreshAllData` 単一フライト集約）、Android Native SQLプロキシ（`TetheractNative.rawQueryJson` 呼び出し）、グリッド描画、全画面ビューア・ジェスチャー（`setupViewerTouchGestures`）、評価・タグ一括更新（`savePhotoChangesBatch` 配線）、Wi-Fi/USB同期モーダル制御を担う。 |
| **実動モジュール（Touch / Adapter / Core）** | `frontend/js/views/touch/touch_layout.js`<br>`frontend/js/views/touch/touch_gestures.js`<br>`frontend/js/views/touch/touch_adjust.js`<br>`frontend/js/views/touch/morph_thumb_bar.js`<br>`frontend/js/views/touch/touch_duel.js`<br>`frontend/js/views/touch/touch_field_log.js`<br>`frontend/js/views/touch/touch_phone_case.js`<br>`frontend/js/views/touch/touch_center_dial.js`<br>`frontend/js/views/touch/touch_art_framer.js`<br>`frontend/js/views/touch/touch_viewer_launcher.js`<br>`frontend/js/privacy_mask_editor.js`<br>`frontend/js/adapters/data_adapter.js`<br>`frontend/js/adapters/field_log_adapter.js`<br>`frontend/js/adapters/phone_case_adapter.js`<br>`frontend/js/adapters/watermark_adapter.js`<br>`frontend/js/core/tree_builder.js`<br>`frontend/js/core/art_framer_step0.js` | **現役で稼働中**。Phone/Tablet可変レイアウト、グリッド長押し選択・ピンチ列数変更・非破壊調整（`touch_adjust.js` / `art_framer_step0.js`）、変身する親指バー、2枚比較（Duel）、フィールドログUI/Adapter、手許写真（PhoneCase）UI/Adapter、Art Framer 4ステップ（0.調整〜3.出力）＆画像ウォーターマークライブラリ、ライトボックス・アクションランチャー＆クイックSNS共有、バッチ保存・`CustomEvent('tetheract:usb-sync-completed')` イベントバス統合（`data_adapter.js`）、および階層ツリー構築を担う。 |
| **退避済みレガシー（非読込）** | `docs/archive/js_legacy/journal_sync.js`<br>`docs/archive/js_legacy/filter_engine.js` | **参照専用の退避コード**。実動ジャーナルは Android 側 `PendingJournalStore.kt`（およびブラウザ単体用 `mobile.js`）に一本化済み。`touch_gestures.js` 内の未使用 `bindViewerGestures` も除去済み。 |

---

## 2. ハイブリッド・ネイティブシェル全体構成 (`android/` ⇄ `frontend/` ⇄ `server/`)

WebView 上で HTML/CSS/JS UI を動かし（`https://appassets.tetheract.local/` を `MainActivity.shouldInterceptRequest` でローカル配信）、SQLite 駆動・SAF I/O・暗号復号・バックグラウンド通信・GPS記録を Kotlin ネイティブ層（`android/app/src/main/java/com/tetheract/pm/`）が担う。

| Android Kotlin クラス | 主な責務 | 対応する WebView JS / PC サーバー実装 |
| :--- | :--- | :--- |
| `MainActivity.kt` | WebView 初期化（`onJsAlert` トースト安全弁含む）、ローカルアセット・`/thumb/{id}`・`/watermark/{id}`・`/usb_photo/{id}`・`/phone_photo/{key}` ストリーム応答、`tetheract:usb-sync-completed` 通知 | `frontend/mobile.html`, `frontend/js/mobile.js` |
| `TetheractNativeBridge.kt` | `window.TetheractNative` (`@JavascriptInterface`) 公開メソッド群。UIスレッド非ブロックのキャッシュ参照 `getLockerStatusJson`、読取SQL（`rawQueryJson`）、単体/一括更新（`savePhotoChangeJson` / `savePhotoChangesBatchJson`）、ウォーターマークCRUD・SNSクイック共有を公開 | `mobile.js`, `adapters/*.js`, `views/touch/*.js` |
| `LockerDatabaseManager.kt`<br>`PendingJournalStore.kt`<br>`WatermarkAssetStore.kt` | `ReentrantReadWriteLock` による並列読取／排他書込分離、`wifi_delta` 時の無停止 WAL 維持、単一トランザクション一括更新、世代番号 `rev` 付き `pending_journal.db` 管理、`watermark_assets` CRUD＆同期保護 | `server/mobile_delta.py`<br>`server/mobile_sync_apply.py`<br>`server/database/watermarks.py` |
| `QuickShareHelper.kt` | `FileProvider`（`cacheDir/share/` 一時ファイル）経由で端末ギャラリーを汚さずに `Intent.ACTION_SEND` 共有シートを起動（GPS除去済みExif整形・古い一時ファイル自動掃除） | `adapters/watermark_adapter.js`<br>`views/touch/touch_viewer_launcher.js` |
| `WifiLockerSyncManager.kt` | UDP `8088` 母艦自動発見、ペアリング、`mobile_delta.db` 無停止差分同期（`wifi_full` 時のみ原子的DBファイル置換）、未同期ジャーナル送信、PC接続中写真のLANストリーミング | `server/routers/mobile_router.py`<br>`server/lan_access.py`, `server/lan_bridge.py` |
| `PhoneCatalogEngine.kt`<br>`PhoneCaseManager.kt`<br>`PhoneCaseTransferRunner.kt` | スマホ内撮影フォルダ（DCIM/Pictures 等）のSAF増分スキャン・EXIF解析、ドラフト評価/タグ保持（`phone_case_drafts.json`）、PC母艦へのマルチパートUplink転送・重複照合 | `adapters/phone_case_adapter.js`<br>`views/touch/touch_phone_case.js`<br>`server/routers/mobile_case_router.py` |
| `OnnxPrivacyEngine.kt` | Art Framer Step 1 向けのオンデバイスプライバシー推論（YuNet 人物顔検出 ＆ LPD-YuNet ナンバープレート4頂点生候補検出、JNI経由） | `views/touch/touch_art_framer.js`<br>`adapters/phone_case_adapter.js`<br>`server/ai/privacy_detector.py` |
| `SafUsbManager.kt`<br>`LoomeVaultCrypto.kt` | 外付けUSB `Loome` への完全Read-Onlyアクセス、先頭窓＋前方スキップによる省メモリRAW埋め込みJPEG抽出、`.loome_seal` オーナー照合、オンメモリDEK展開、Lv.2 `TETHVLT1` 復号 | `server/security.py` |
| `UsbOfflineUpdater.kt` | USB内の `tetheract_ui_bundle.zip`（または `Tetheract_Mobile.html`）ホット更新と `Tetheract_Android.apk` の `PackageInstaller` 起動 | `scripts/build_android_apk.py`<br>`server/mobile_bundle.py` |
| `FieldLogTileService.kt`<br>`FieldLogStartActivity.kt`<br>`FieldLogService.kt`<br>`FieldLogStore.kt`<br>`FieldLogUploader.kt` | クイック設定タイルからのGPS採取（Android 14 `targetSdk 34` 対応トランポリン起動）、日付別 `YYYY-MM-DD.jsonl` 保存・自動削除、PC母艦へのWi-Fiアップロード | `adapters/field_log_adapter.js`<br>`views/touch/touch_field_log.js`<br>`server/field_log_store.py`, `field_log_match.py`<br>`server/routers/field_log_router.py`<br>`frontend/js/field_log_panel.js` |

---

## 3. 主要サブシステム仕様

### 3.1 Wi-Fi ロッカー同期 ＆ USBドライブ WFP 回避ブリッジ (`lan_bridge.py`)
1. **双方向ロッカー同期 (`/api/mobile/locker-sync`, `/api/mobile/sync-import`)**:
   - スマホ側の評価・タグ・非破壊調整（クロップ・傾き・トーン含む）は `pending_journal.db` に単調増加 `rev` 付きで記録され、同期送信時にスナップショット時点の `sentRev` 以下のみを消去することで同期中の操作消失を防ぐ。
   - PC側への適用（`server/mobile_sync_apply.py`）ではファイル名単体の曖昧一致を行わず、`content_key` または `file_name + date_taken` 一致を要求し、未取込写真の変更は `unmatched_keys` としてスマホ側に保持する。また `library_id` 照合により別母艦との誤混在を防止する。
2. **USBメモリ稼働時の WFP 遮断回避 (`server/lan_bridge.py`)**:
   - Windows 環境でリムーバブルドライブ上の `python.exe` が Windows Filtering Platform によりLAN受信をブロックされる問題に対し、インプロセスTCP中継スレッドがLAN IPポートを受けて `127.0.0.1:8088` へフォワードする。その際 `X-Tetheract-Lan-Client` ヘッダで実クライアントIPを伝達し、LAN認証・ホワイトリスト制御を維持する。

### 3.2 手許スマホ写真管理（PhoneCase）＆ PC母艦 Uplink 転送
- **目的**: スマホ本体（カメラロール等）で撮影した写真をアプリ内の「手許（PhoneCase）」ビューで即座に閲覧・事前選別（優/良/可/棄・タグドラフト付与）し、自宅Wi-FiでPC母艦の専用保管庫（`Loome/case/` 等）へ安全にUplink転送する。
- **仕組み**:
  1. `PhoneCatalogEngine.kt` が許可済みSAFツリーを増分走査し、サムネイルとEXIF・重複照合キーをカタログ化する。
  2. 転送前に `/api/mobile/case-preflight`（`server/routers/mobile_case_router.py`）で母艦DBと照合して転送済み写真を判別し、未転送分またはGPS補完対象を `PhoneCaseTransferRunner.kt` が `/api/mobile/case-upload` へストリーミング送信する。
  3. 母艦側ではファイル保存と同時にドラフト評価・タグ・GPSを取り込み、Lv.2 フルロック環境では自動的にカプセル化保護を適用する。

### 3.3 Read-Only USB `Loome` 原本直結（書き込みゼロ・オンメモリ復号）
- スマホ・タブレットにUSBメモリ／外付けSSDを挿した際、USB側へは1バイトも書き込まない完全 Read-Only とすることで、アンマウントなしの抜去でもファイル破損を起こさない。
- 鍵付き `Loome`（Lv.1 / Lv.2）の場合は `Loome/.loome_seal` からパスワード／リカバリーコードで `DEK` をプロセスメモリ上にのみ展開し、USB抜去（`ACTION_USB_DEVICE_DETACHED`）またはアプリ終了時に `Arrays.fill(dek, 0)` で即時ゼロ消去する。

### 3.4 Context Tether：GPS フィールドログ採取と非破壊位置付与
- **プライバシーとファイル分離**: 位置履歴生データは `library.db` に一切入れず、スマホ内 `filesDir/fieldlog/YYYY-MM-DD.jsonl` およびPC内 `cache/field_logs/<device_id>/YYYY-MM-DD.jsonl` にローカル日付単位（`toISOString()` 禁止）で保存する。各測位点 `pt` には記録時の端末UTCオフセット分 `tz`（JSTは `540`）を記録する。
- **Android 14 (`targetSdk 34`) 制約対応**: クイック設定タイル（`FieldLogTileService`）から直接 location Foreground Service を起動せず、透明な `FieldLogStartActivity` を `PendingIntent` で経由して `ACCESS_FINE_LOCATION` 権限を確認した上で `FieldLogService` を起動する。
- **PC側時刻補間とUndo (`server/field_log_match.py`)**: カメラ別時刻オフセット補正を加味して前後ログ点から線形補間（または最寄り点）で座標を算出し、`photos` に `gps_source='fieldlog'` として非破壊記録する。適用前状態はバッチJSONに退避し、いつでもバッチ単位で Undo 可能とする（GPX書き出しにも対応）。

### 3.5 ライトボックス・アクションランチャー ＆ クイック SNS 共有 ＆ 画像ウォーターマーク
- **アクションランチャー (`touch_viewer_launcher.js`)**: ライトボックス上部バー右側の操作ボタン群を単一のメインボタン（`#mViewerLauncherBtn`）へ集約し、ポップオーバーから「SNSへ共有」「Art Framer」「非破壊調整」「タグ・Exif詳細」「評価後の自動次送り」を呼び出す。
- **ギャラリー非汚染クイック SNS 共有 (`QuickShareHelper.kt`, `file_paths.xml`)**: ライトボックスから共有する際、非破壊調整（露出・コントラスト・彩度・傾き・90°回転）を Canvas 焼き込みした長辺最大 2048px・GPS非含有の JPEG を `cacheDir/share/` に一時生成し、`FileProvider` 経由の `Intent.ACTION_SEND` で共有シートを開く（`Pictures/Tetheract` へ重複保存しない）。
- **画像ウォーターマーク同期 (`WatermarkAssetStore.kt`, `watermark_adapter.js`)**: `library.db` の `watermark_assets` テーブルで透過 PNG ロゴを複数管理し、初回のみデフォルトの `TETHERACT` ロゴ（`frontend/icons/tetheract-watermark-default.png`）を投入する（`app_meta` の `default_watermark_seeded_v1` によりユーザー削除後は復活しない）。PC 登録ロゴは `mobile_delta.db` で自動配信し、スマホ登録ロゴ（`origin = 'mobile'`）は差分・フル同期双方で退避・保護する。サイズ指定は PC（Pillow）・モバイル（Canvas）共通で **「写真の長辺 × % ＝ ロゴの長辺（3%〜50%）」** に統一している。

---

## 4. スマホ／タブレット可変レイアウトとビルド・配布パイプライン

1. **Phone / Tablet 可変レイアウト (`touch_layout.js`, `morph_thumb_bar.js`, `touch-responsive.css`)**:
   - 画面幅に応じて `data-device-mode="phone"`（1ペイン全画面グリッド＋下部56pxの変身する親指バー＋自動収納シート）と `data-device-mode="tablet"`（左アイコンレール＋中央グリッド＋右インスペクタ／Duel 2画面比較）を自動または手動で切り替える。
2. **APK・UIバンドル・単体HTMLのビルド同期 (`scripts/build_android_apk.py`, `server/mobile_bundle.py`)**:
   - `scripts/build_android_apk.py` はモバイルUIから実際に参照されるWebアセットのみを `android/app/src/main/assets/`（`.gitignore` 管理外）および Stage 1 ホット更新用 `tetheract_ui_bundle.zip` へ同期する。
   - ビルド時刻スタンプはコピー先の `assets/mobile.html`（およびバンドルZIP内）にのみ刻印し、Git追跡対象の原紙 `frontend/mobile.html` は汚さない。また `android/app/build.gradle` の `versionCode` / `versionName` も `VERSION` ファイルから決定論的に算出し、一致時は書き換えない。
   - ブラウザ単体オフライン用の `Tetheract_Mobile.html` は `server/mobile_bundle.py` が `frontend/mobile.html` とモバイルCSS/JS/`sql-wasm` を1ファイルにインライン結合して生成する。
