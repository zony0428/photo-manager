# Context Tether 設計仕様：採取（フィールドログ）と再会 (v2.0.3+ / v2.1+)

本ドキュメントは、v2系（Android 連携・タッチ UI ライン）において、スマートフォンを「PC 母艦の縮小リモコン」から「撮影現場の文脈を記録し、場所と日付で写真を呼び戻す相棒（Context Tether）」へと進化させるための設計思想、v2.0.3 で実施した同期・ジャーナル基盤の改修、および第1期「採取」・第2期「再会」の技術仕様と実現可能性の精査結果をまとめたナレッジである。

---

## 1. 背景と設計思想：「リモコン」から「Context Tether」へ

### 1.1 従来の課題（v2.0.2 時点）
v2.0.2 までの Android 版は、PC 母艦から `library.db`（または `mobile_delta.db`）を受け取って閲覧し、評価・タグ・トーン調整の差分を PC へ返す「PC の縮小窓（リモコン）」として構成されていた。
そのため、スマートフォンだけが持つ以下の特性が活用されていなかった。

1. **撮影の現場に立ち会っていること**（GPS のない一眼カメラ・フィルムカメラで撮影している最中も、ポケットの中で位置と時刻を把握できる）
2. **場所や日常と結びついた端末であること**（今立っている場所で過去に撮った写真や、歴代の同じ月日の写真にその場で再会できる）

### 1.2 Context Tether のコンセプトと2本柱
> カメラは光を記録する。スマホは文脈を記録する。PC がその二つを結び合わせる。

ユーザーとの検討を経て、「溜める・分類するだけの利用者にとっては負担になる機能（クイズ形式の判断キュー等）」は採用せず、以下の **2本柱** に絞って実装する方針を確定した。

| 柱 | 役割 | 主な機能 |
| :--- | :--- | :--- |
| **採取 (Collect)** | 撮影現場の足跡を記録し、GPS のないカメラ写真に非破壊で位置と地名を結ぶ | クイック設定タイル（トグルスイッチ）で ON/OFF する GPS フィールドログ、日付別 JSONL 保存と簡単な削除、Wi-Fi / USB 同期、PC 側での時刻照合・プレビュー・一括付与・Undo、GPX 書き出し |
| **再会 (Revisit)** | 場所と日付を手がかりに、眠っている過去の写真と再び出会う | 「ここで撮った写真」（現在地の近傍検索・距離と方角表示）、スマホ版「歴代の今日」、充電中の写真立てモード（Android 標準 `DreamService`） |

---

## 2. v2.0.3 で完了した同期・ジャーナル基盤の補強

新機能でスマホと PC の双方向連携を拡張するにあたり、v2.0.2 のコード監査で判明した同期・セキュリティ上の基礎課題を v2.0.3（コミット `5a600af` / `29890a4` / `c1c9045`）にて先行解決した。

1. **同期中の変更消失防止（世代番号 `rev` の導入）**:
   - 従来は Wi-Fi 同期や USB 書き出しの完了時に `clearPendingJournal()` で全件削除していたため、送信中にユーザーが付けた評価やタグまで消えていた。
   - `pending_changes` テーブルに単調増加する `rev` 列を導入し、スナップショット作成時点の `sentRev` 以下のみを削除する `clearPendingJournalUpTo(maxRev)` に変更した。
2. **ジャーナルのモジュール分離（800行制限の遵守）**:
   - `LockerDatabaseManager.kt` からジャーナル管理責務を [`PendingJournalStore.kt`](../../android/app/src/main/java/com/tetheract/pm/PendingJournalStore.kt)（250行）へ切り出し、各クラスの行数を上限（800行）以下に保った。
3. **クロップ・お気に入り・タグキー（`add_tag_keys`）の完全同期と PC サムネイル再生成**:
   - スマホ側で行ったトリミング（`crop_*`）とお気に入り（`is_favorite`）、およびタグ改名に追従するための `add_tag_keys` をネイティブジャーナルと PC 側 `sync-import`（[`server/routers/mobile_router.py`](../../server/routers/mobile_router.py)）の双方で受け渡し、回転・クロップ・トーン変更時は PC 側のサムネイル BLOB も非同期で再生成するようにした。
4. **未照合変更の保護と同名写真への誤適用防止**:
   - ファイル名のみでの曖昧なフォールバック照合を廃止し（`content_key` または `file_name + date_taken` 一致を要求）、PC 側でまだ取り込まれていない写真の変更は `unmatched_keys` としてスマホ側のジャーナルに残すようにした。
5. **WebView ブリッジからの任意 SQL 書き込み遮断**:
   - `TetheractNativeBridge.execSqlJson` を廃止し、`rawQueryJson` 側でも `SELECT` / `WITH` / 読み取り専用 `PRAGMA` 以外の書き込み系 SQL を正規表現で拒否する防御層と回帰テスト（`tests/test_security.py`）を追加した。

---

## 3. プライバシー保護と日付別ファイル設計

位置履歴は機微な情報であるため、「4つの設計原則（特に柱2：非破壊、柱4：クラウド非依存・ポータブル）」およびユーザーの明示的方針に基づき、以下の設計原則を徹底する。

1. **日付別 JSONL ファイルによる保存**:
   - スマホ内は `filesDir/fieldlog/YYYY-MM-DD.jsonl`、PC 内は `cache/field_logs/<device_id>/YYYY-MM-DD.jsonl` として **1日1ファイル** で保存する。
   - 日付は記録時点の端末ローカル日付とし、UTC 基準の `toISOString()` は使用しない。
2. **データベースへの非格納**:
   - フィールドログの生データは `library.db` にも `mobile_delta.db` にも一切格納しない。これにより、DB のバックアップや持ち出し時に位置履歴が意図せず複製・拡散されることを防ぐ。
3. **簡単な削除と自動削除（既定：PC送信済み かつ 30日経過）**:
   - スマホ・PC の双方の UI から「日別の選択削除」「全削除」をいつでも行える。
   - スマホ側では「PC へ送信済み かつ 30日経過（7日 / 30日 / 90日 / 無効から選択可）」のログを同期完了時に自動削除する。
   - PC 側ではエクスプローラーから `cache/field_logs/` 内のファイルを直接削除しても動作に支障が出ない設計とする。
4. **写真への位置付与とログ削除の独立性**:
   - PC で照合・適用した位置情報は `photos` テーブルの `latitude / longitude / gps_source='fieldlog' / country / state / city` に非破壊で記録され、適用前の値は `cache/field_logs/_batches/<batch_id>.json` に保存される。
   - フィールドログのファイルを削除しても写真に付与済みの位置は消えず、位置を戻したい場合はバッチ単位の「適用の取り消し（Undo）」で行う。

---

## 4. 実現可能性の精査と技術的ガード（Android 14 / SAF / 3層UI / DB共有）

実装計画（[`docs/archive/tasks/v2-field-log-and-recall/implementation_plan.md`](../archive/tasks/v2-field-log-and-recall/implementation_plan.md)）を実コードと照合し、以下の5つの技術的課題と対策を確立した。

### 4.1 Android 14 (targetSdk 34) の位置情報 Foreground Service と TileService 制約
- **課題**:
  - Android 14 では `TileService.onClick()` から直接 `foregroundServiceType="location"` の前面サービスを起動すると `ForegroundServiceStartNotAllowedException` となる。また API 34 以上では `startActivityAndCollapse(Intent)` が廃止され `PendingIntent` 版が必須となる。
  - Android 12 以降ではユーザーが「おおよその位置情報（`ACCESS_COARSE_LOCATION` のみ）」を選択でき、その状態で `LocationManager.GPS_PROVIDER` を購読すると `SecurityException` が発生する。
  - ロック画面上からタイルをタップされた場合、権限未許可だと権限ダイアログがロック画面の背後に隠れる。
- **対策**:
  - タイルからの記録開始時は透明なトランポリン Activity（`FieldLogStartActivity`）を `PendingIntent`（API 34+）で起動し、`ACCESS_FINE_LOCATION`（および API 33+ の `POST_NOTIFICATIONS`）を確認・要求してから `startForegroundService` を呼ぶ。停止時はタイルから直接 `ACTION_STOP` を送る。
  - ロック画面上（`isLocked == true`）かつ権限未許可時は `unlockAndRun` を経由する。
  - `FieldLogService` 側でも `ACCESS_FINE_LOCATION` の保持確認と `try-catch (SecurityException)` による保護を行う。
  - OS による強制終了（`interrupted`）を正確に検知するため、`FieldLogService` 内にプロセス内 `@Volatile var isRunningInMemory = false` を持ち、SharedPreferences の `recording == true` かつ `isRunningInMemory == false` の状態を強制終了と判定して `session stop (reason="killed")` を補完追記する。

### 4.2 ローカル時刻 `date_taken` と UTC エポックのタイムゾーン照合
- **課題**:
  - PC の `photos.date_taken` はタイムゾーン情報を持たないローカル時刻文字列（`YYYY:MM:DD HH:MM:SS` または `YYYY-MM-DD HH:MM:SS`）である一方、Android の `Location.time` は UTC エポックミリ秒である。
- **対策**:
  - 各ログ点 `pt` に記録時点の端末 UTC オフセット分 `tz`（JST なら `540`）を併記する。
  - PC 側の純粋関数 `match_photos`（`server/field_log_match.py`）では、写真の時刻に最も近いログ点の `tz` とカメラ機種別秒補正 `camera_offsets` を用いて UTC エポックへ変換し、前後2点間の線形補間（既定 300秒以内）または最寄り点（既定 120秒以内）で座標を算出する。日付境界（23:59 等）を跨ぐ撮影に対応するため、照合時は前後1日分のログファイルも同時に読み込む。

### 4.3 SAF（USB 直書き）の拡張子付与仕様と Wi-Fi 同期フック
- **課題**:
  - Android の SAF（`DocumentFile.createFile(mimeType, displayName)`）に `"application/json"` と `"2026-11-09.jsonl"` を渡すと、プロバイダ実装によっては `.jsonl.json` と拡張子が二重付与される。
  - `WifiLockerSyncManager.kt` で写真評価等の未送信変更が 0 件（`pendingCount == 0`）のときにもフィールドログが送信される必要がある。
- **対策**:
  - SAF で `.jsonl` ファイルを作成する際は MIME タイプに `"application/octet-stream"` を指定する。
  - Wi-Fi 同期では `if (pendingCount > 0)` ブロックの外（直後の段階 2b）で `FieldLogUploader.uploadPending` を呼び出す。

### 4.4 凍結ファイル `mobile.js` を汚さない Lab パネル複数カード登録と戻る操作フック
- **課題**:
  - 第1期（採取）と第2期（再会）の両方が [`touch_layout.js`](../../frontend/js/views/touch/touch_layout.js) の `lab` パースペクティブパネルにカードを配置するため、単一関数登録だと第2期が第1期のカードを上書きしてしまう。
- **対策**:
  - `TetheractTouchUI.registerPerspectiveRenderer(id, fn)` は `id` ごとに描画関数の配列を保持し、`lab` パネルでは既存の「DB読込・Wi-Fi/USB同期を開く」ボタンの下に各モジュールのカード（採取・再会）を順次追加描画する構造とする。
  - また Android の戻るジェスチャーで各専用画面を閉じられるよう、`mobile.js` の `window.__handleAndroidBack` 冒頭に `window.__extraBackHandlers` を走査する 3 行のフックのみを追加する。

### 4.5 第2期 `PhotoFrameDreamService` と `MainActivity.onDestroy()` の DB クローズ競合防止
- **課題**:
  - `MainActivity.onDestroy()` で `lockerDbManager.closeLibraryDatabase()` を無条件に呼ぶと、`LockerRegistry` で同一の `LockerDatabaseManager` を共有している `PhotoFrameDreamService`（充電中の写真立てスクリーンセーバー）の稼働中に DB が閉じられてしまう。
- **対策**:
  - 第2期（WP-A3）で `LockerRegistry` シングルトンを導入する際、`MainActivity.onDestroy()` での直接クローズを外し、DB クローズは USB / Wi-Fi フル同期で DB ファイルを入れ替える瞬間（`synchronized(lock)` 内）のみ行う。

---

## 5. 関連ドキュメント・コード参照

- **実装計画書（ワークパッケージ・契約定義）**: [`docs/archive/tasks/v2-field-log-and-recall/implementation_plan.md`](../archive/tasks/v2-field-log-and-recall/implementation_plan.md)
- **Android アプリ＆タッチ UI 仕様書**: [`docs/knowledge/android-app-and-touch-architecture.md`](android-app-and-touch-architecture.md)
- **モジュール分割・マルチエージェント分業規約**: [`.agents/rules/modularization-and-multi-agent.md`](../../.agents/rules/modularization-and-multi-agent.md)
- **v1/v2 ブランチ・dist 分離規約**: [`.agents/rules/branch-and-dist-separation.md`](../../.agents/rules/branch-and-dist-separation.md)
