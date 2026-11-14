# Phase 1〜Phase 4 全フェーズ完結記録・検証レポート（Walkthrough）

- **実施日**: 2026-11-12 〜 2026-11-13
- **対象ブランチ**: `v2`
  - **Phase 1 (P1)**: ローカルコミット `6d1abb8`（AIルール/KI 70.7%スリム化・APK同期資産削減・テスト完全隔離＆高速化）として確定済み。
  - **Phase 2 (P2)**: ローカルコミット `dbbccb5`（手許PhoneCase一括転送・Lv.2重複防止・同期原子化）および `2eaf991`（SQL 450〜665倍高速化・5系統キャッシュ世代分離・PC部分DOM更新＆$O(1)$化）として確定済み。
  - **Phase 3 (P3)**: ローカルコミット `c039cfe`（LockerDB ReadWriteLock化・一括保存JNI・SAF非同期化・未配線JS退避）および `65063f5`（一覧`scandir`全廃・スリム`stack_photos`・PC 2D仮想スクロール・共通`TreeBuilder`配線・配布安全ガード）として確定済み。
  - **Phase 4 (P4)**: セキュリティ封鎖（`[SEC-1]` / `[SEC-2]` / `[SEC-3]`）＋正規4フロー互換検証＋攻撃シミュレーション回帰テスト全82件合格まで完了し、**ユーザー確認用に `HEAD = 65063f5` 上のワーキングツリーで未コミット維持**。
- **関連ドキュメント**:
  - [audit_report.md](file:///c:/Users/zony0/Documents/photo-manager/docs/codebase_audit_and_modernization/audit_report.md) — 全方位コードベース監査・パフォーマンス解剖レポート
  - [implementation_plan.md](file:///c:/Users/zony0/Documents/photo-manager/docs/codebase_audit_and_modernization/implementation_plan.md) — Phase 1〜Phase 4 実行ロードマップ
  - [task.md](file:///c:/Users/zony0/Documents/photo-manager/docs/codebase_audit_and_modernization/task.md) — 全体進捗チェックリスト（**事前監査〜Phase 4 全項目 `[x]` 完結**）

---

## 第1部：Phase 1 (P1) — AIルール/KI浄化・APKビルド非汚染化・テスト完全隔離（Commit `6d1abb8`）

| 指標 | Phase 1 実施前 | Phase 1 実施後 | 改善効果 |
| :--- | :--- | :--- | :--- |
| **AIルール・スキル・KI 総量** | 32ファイル / 3,285行（約381.0 KB） | **アクティブ11ファイル / 962行（114.6 KB）** | **行数 70.7% 削減 / 容量 69.9% 削減**（旧21本は `docs/archive/` 保全） |
| **`AGENTS.md` サイズ・制御文字破損** | 240行（26.1 KB）・制御文字3箇所混入 | **88行（11.4 KB）・制御文字 0件** | 初回コンテキスト負荷半減・文字破損根絶 |
| **APK同期時のGit追跡ファイル汚染** | 毎回 `mobile.html` 原紙・`build.gradle` を書換 | **原紙・一致済み `build.gradle` SHA256 完全不変** | ビルド起因の `git status` 汚染・競合を根絶 |
| **`tests/test_security.py` 単体実行時間** | 27.0秒（本番595MB DBへ5回 `VACUUM` 誤爆） | **0.99秒**（完全一時DB隔離） | **約27倍高速化**・本番DB汚染ゼロ |
| **PC比較画面ズーム時クラッシュ** | `compare.js:515` で即 `ReferenceError` | **`hasBakedViewAdjustments` 修正＋回帰検査化** | ライブクラッシュ解消＆ [test_js_integrity.py](file:///c:/Users/zony0/Documents/photo-manager/tests/test_js_integrity.py) 新設 |

---

## 第2部：Phase 2 (P2) — 体感パフォーマンス即効止血 ＆ 未コミット変更・サイレントバグ一掃（Commits `dbbccb5`, `2eaf991`）

| 検証対象クエリ・経路 | Before（改修前） | After（P2 改修後） | 改善倍率・効果 |
| :--- | :--- | :--- | :--- |
| **少数枚フォルダ絞り込み** (`Loome` 2枚, VSN `C81405C1`) | **`47.72 ms`** (`SCAN p` + 相関サブクエリ) | **`0.106 ms`** (非相関 `UNION` インデックス検索) | **約450倍高速化**（912クエリ結果不一致 `0件`） |
| **フォルダ/ボリューム別リンク水和** (`photos.py`) | **`13.97 ms`** (`SCAN pl` 34,090行 + 自動一時索引) | **`0.021 ms`** (`IN` チャンク + `COLLATE BINARY`) | **約665倍高速化** |
| **未生成サムネイル抽出** (`preload_thumbnails.py:97`) | **`84.82 ms`** (568MB BLOBページシーク) | **`23.47 ms`** (`INDEXED BY idx_thumbnails_dims`) | **約3.6倍高速化** |
| **一覧標準ソート** (`idx_photos_unlinked_date_fname`) | `USE TEMP B-TREE FOR ORDER BY` | インデックス順直読み | **`TEMP B-TREE` 完全解消** |

- **主な成果**: 5系統ドメイン別コミット世代分離、Alt-Tab時の事前キャッシュ全消去廃止＆`_pendingExternalPhotoIds` 解放、`fetchPhotos()` の `queueMicrotask` 合流、`state.photoById` Map（$O(1)$ ルックアップ＆1パス `removePhotosFromViewBatch`）、単一タグ・複数枚評価の部分DOM更新、`PhoneCaseTransferRunner.kt` トークン再取得・HTTPエラー分離、`mobile_case_router.py` の Lv.2 論理サイズ判定＆外付け既存写真GPS直接更新、`mobile_sync_apply.py` 単一トランザクション原子化、サイレントバグ4件解消、[test_p2_performance_and_fixes.py](file:///c:/Users/zony0/Documents/photo-manager/tests/test_p2_performance_and_fixes.py) 新設。

---

## 第3部：Phase 3 (P3) — 定数時間アーキテクチャ・PC 2D仮想スクロール・Android並列排他/一括JNI・配布安全ガード（Commits `c039cfe`, `65063f5`）

| 計測指標 | Before P3 (`HEAD=2eaf991`) | After P3（確定実測値） | 改善効果 |
| :--- | :--- | :--- | :--- |
| **一覧取得時 `os.scandir` 呼び出し回数** | **304 フォルダ走査**（コールド時 **>10,000 ms**） | **0 回**（完全DB `has_xmp` / VSN判定のみ） | **ディスクI/O 100%撤廃（コールドハング根絶）** |
| **`get_photos(stacked=True)` (16,287カード)** | `517.66 ms`（ウォーム） / `>10,000 ms`（コールド） | **`377.85 ms`**（OSキャッシュ非依存） | **-27.0%（ウォーム比） / コールド 25倍以上高速化** |
| **JSON ペイロード (`stacked=True` / `False`)** | `34.64 MB` / `96.63 MB` | **実ワイヤ `26.21 MB` / `68.61 MB`** | **`stack_photos` -30.6% / 非スタック -22.86 MB** |
| **定数時間ページング `get_photos(limit=100, offset=0)`** | 未対応（`offset` なし） | **`2.97 ms`**（JSON化 `1.73 ms` / `232.17 KB`） | **計 4.7 ms 定数時間ページング確立** |
| **未変更再スキャン `open()` / レンズ再open / Lv.2 `%TEMP%`** | 全件 `open()` / 2,774枚再open / 50〜80MB書出 | **すべて `0 回`** | **不要I/O・ホスト一時書出の完全ゼロ化** |
| **PC 写真グリッド常駐 DOM カード数（16,287枚時）** | 最大 **16,287 枚** | **可視行＋前後8〜9行のみ常駐（約80〜140枚）** | **常駐DOM 99%削減・スクロール60fps維持** |
| **Android 100枚一括評価・タグ保存 JNI / Tx 数** | 400回超の同期JNI ＋ 100トランザクション | **`savePhotoChangesBatchJson` 1 JNI ＋ 1 Tx** | **UIスレッド拘束の劇的解消** |
| **APK 同梱 Web アセット数・容量** | 74本 / 4.05 MB（P1前） | **23ファイル / 1.38 MB（1,446,657 bytes）** | **計 66.0% 削減** |

- **主な成果**: `has_xmp` DBカラム化＆`sidecar.py`/`scanner.py` 同期、スリム `stack_photos` ＆ `GET /api/stacks/{id}`、`_VaultDecryptedStream` / `BytesIO` 復号、PC行単位2D仮想グリッド・インスペクタ遅延描画・Compare 1D仮想化・[tree_builder.js](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/core/tree_builder.js) 6箇所共通配線、`LockerDatabaseManager.kt` `ReentrantReadWriteLock`・無停止 `wifi_delta`・SAF非同期化・RAW前方スキップ抽出・`CustomEvent` バス統一・`alert()` 全廃、[publish_release.py](file:///c:/Users/zony0/Documents/photo-manager/scripts/publish_release.py) ＆ [build_dist.bat](file:///c:/Users/zony0/Documents/photo-manager/build_dist.bat) 安全ガード、[test_p3_architecture.py](file:///c:/Users/zony0/Documents/photo-manager/tests/test_p3_architecture.py) 新設。

---

## 第4部：Phase 4 (P4) — セキュリティ封鎖（Release Gate）＆ 攻撃シミュレーション検証（`HEAD = 65063f5` 上で未コミット維持）

> [!NOTE]
> Phase 4 の変更（全6ファイル）はユーザー最終確認のため、`HEAD = 65063f5` 上のワーキングツリーに未コミット状態で保持している。

### 4.1 封鎖した3大脆弱性と実装詳細

1. **`[SEC-1]` Drive-by `Origin: null` + PNA CORS による全DB窃取・改ざんの完全遮断**:
   - **対象**: [app.py](file:///c:/Users/zony0/Documents/photo-manager/server/app.py), [lan_access.py](file:///c:/Users/zony0/Documents/photo-manager/server/lan_access.py), [mobile_router.py](file:///c:/Users/zony0/Documents/photo-manager/server/routers/mobile_router.py)
   - `_NULL_ORIGIN_ALLOWED_PATHS` を単体HTML（`Tetheract_Mobile.html`）が実際に使用する `{"/api/mobile/sync-import"}` **1本のみ** に縮小し、`/api/mobile/locker-sync`, `/api/mobile/info`, `/api/mobile/pair-info`, `/api/mobile/discover`, `/api/mobile/case-*`, `/api/mobile/field-logs`, `/api/heartbeat`, `/api/version` は `OPTIONS` プリフライト・実リクエストとも即 `403` 遮断。
   - `Origin == "null"` には `OPTIONS` でも通常応答でも `Access-Control-Allow-Private-Network: true` を一切付与せず、外部悪意サイトの `<iframe sandbox="allow-scripts">` からの Private Network Access 越境をブラウザレベルで封鎖。
   - さらに多層防御として、`Origin == "null"` リクエストはたとえ `127.0.0.1` / `::1`（ループバック）発であっても無認証特権および Cookie アンビエント認証を拒否し、**明示的な `LAN_TOKEN`（`?t=` / `X-Tetheract-Lan-Token` / `Authorization: Bearer`）提示を必須化**（`use_detected_file=True` も `Origin: null` からは `403` 拒否）。

2. **`[SEC-2]` LANペアリング窓口のグローバル全IP開放廃止・指定IPワンタイム承認化・無認証Cookie交付撤廃**:
   - **対象**: [lan_access.py](file:///c:/Users/zony0/Documents/photo-manager/server/lan_access.py), [mobile_router.py](file:///c:/Users/zony0/Documents/photo-manager/server/routers/mobile_router.py), [lan_bridge.py](file:///c:/Users/zony0/Documents/photo-manager/server/lan_bridge.py), [app.py](file:///c:/Users/zony0/Documents/photo-manager/server/app.py)
   - 同一LAN全IPを無差別開放していたグローバル `_pairing_window_until` を**完全廃止**（QR表示 `enable_lan=1` はLANリスナー起動のみ）。
   - `approve-pair` は `normalize_lan_client_ip()` で検証済みの特定プライベート/ループバック `client_ip` のみを短時間（既定90秒・上限120秒）登録し（空文字・`*`・外部IPは `400` 拒否）、TCP `/api/mobile/discover` で当該 `client_ip` に `pair_token` を引き渡した瞬間に `consume_lan_pairing_approval()` で**即時ワンタイム消費・失効**。
   - 同一LAN上の第三者IPからは承認中であってもトークン取得・API通過・承認エントリ枯渇（DoS）のいずれも不可。UDP `8088` 探索（`udp=1`）は承認状態を消費せず応答の `pair_token` も常時 `""` 固定とし、UDP送信元IP詐称による奪取・枯渇を防止。
   - ミドルウェアの `is_lan_pairing_approved_for` 通過＆365日有効 `pm_lan_token` Cookie 無認証自動交付バイパスを完全撤廃（通常オリジンで有効な `LAN_TOKEN` を明示提示して検証通過したリクエストのみ Cookie 交付）。

3. **`[SEC-3]` `lan_bridge.py` 32KB超未完結HTTPヘッダ即時切断（フェイルクローズ化）**:
   - **対象**: [lan_bridge.py](file:///c:/Users/zony0/Documents/photo-manager/server/lan_bridge.py), [security-architecture.md](file:///c:/Users/zony0/Documents/photo-manager/docs/knowledge/security-architecture.md)
   - 初回 `MAX_HTTP_HEADER_BYTES = 32768` 読取ループで `\r\n\r\n` 未検出のまま上限到達（または未完結EOF切断）した場合は、上流 `127.0.0.1` へ一切接続・転送せず `HTTP/1.1 431 Request Header Fields Too Large` を返して即時ソケット切断。LF単独改行・先頭空白を含む偽装 `X-Tetheract-Lan-Client` ヘッダの除去も強化。

### 4.2 正規4フロー互換性 ＆ 最終ランタイム検証結果（`verifier-arch` 実測）

1. **正規利用4フローの 100% 互換確認**:
   - ① **PC本体UI**: `common.js` が要求元 `client_ip` を保持して `approve-pair` へ送信しそのまま動作。
   - ② **QRコード `?t=<LAN_TOKEN>` 接続**: 初回アクセスで `pm_lan_token` Cookie 交付後、同一オリジンAPI・ディープリンク起動がそのまま動作。
   - ③ **Android `TETHERACT ld`**: `WifiLockerSyncManager.kt`（UDP探索→直後のTCP `probeDiscoverEndpoint` によるワンタイムトークン受領＆保存→Wi-Fi同期）および `PhoneCaseTransferRunner.kt`（`?t=`＋Cookie付きUplink）がコード変更ゼロで100%互換動作。
   - ④ **単体HTML `Tetheract_Mobile.html`**: 明示トークン提示時の `/api/mobile/sync-import` 送信が正常動作。
2. **攻撃シミュレーション回帰テスト＆全自動テストスイート**:
   - [tests/test_security.py](file:///c:/Users/zony0/Documents/photo-manager/tests/test_security.py) に `[SEC-1]` / `[SEC-2]` / `[SEC-3]` 攻撃遮断＆正規フロー検証を追加：**`19 tests in 0.961s — OK`**。
   - 全自動テストスイート（`.\python\python.exe -B -X utf8 -m unittest discover -s tests -p "test_*.py" -v`）：**`Ran 82 tests in 6.817s — OK (rc=0)`**（Phase 1前の61件/33.34秒から、21テスト増強しつつ実行時間 **79.6% 短縮**）。
3. **Android 整合性 ＆ 本番資産完全非接触確認**:
   - `.\python\python.exe scripts\build_android_apk.py --check-only --sync-assets` → **`rc=0` `[SUCCESS]`**（Webアセット 23ファイル / 1.38 MB、`frontend/mobile.html` 原紙 SHA256 不変）。
   - `cache/library.db` (`st_mtime_ns = 1794496341057368100`, `601,636,864 bytes`)、`cache/.mobile_lan_auth.json` (`1794060510000000000`)、`Tetheract_Mobile.html` (`1794495926404427000`) すべて **完全不変 `True`**。
