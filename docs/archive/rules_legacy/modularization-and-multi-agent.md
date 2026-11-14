# モジュール分割・モノリス防止・マルチエージェント分業規約

本ドキュメントは、Tetheract Photo Manager におけるコードの肥大化（モノリス化）を防ぎ、デスクトップ版・モバイルHTML版・Androidアプリ（`.apk`）版でロジックをクリーンに共有しつつ、複数のAIエージェント（サブエージェント）が衝突せずに並列開発を行うための設計・分業ルールを定義する。

---

## 1. モノリス防止とファイル行数・責務基準 (Anti-Monolith Rules)

### 1.1 ファイルサイズ基準値
- **新規作成モジュールの上限目安**: **1ファイル 400〜600行以内**（最大でも **800行** を超える場合は責務ごとにファイルを分割する）。
- **既存肥大化ファイルへの直接追記禁止（凍結リスト）**:
  以下のファイルはすでに1,500〜3,800行に達しているため、**新しい機能ブロックや別プラットフォーム（Android / タブレット等）の分岐コードを直接追記することを禁止**する：
  - `frontend/js/app.js`
  - `frontend/js/common.js`
  - `frontend/js/mobile.js`
  - `frontend/js/inspector.js`
  - `frontend/js/sidebar_filters.js`
  - `frontend/js/folder_tree.js`
  - `frontend/js/storage.js`
  - `server/app.py`

### 1.2 「追記する前に切り出す」原則 (Extract Before Extend)
既存の大型ファイルに関係する機能拡張やクロスプラットフォーム対応を行う場合は、必ず以下の2ステップを踏むこと：
1. **Step 1（純粋リファクタリング）**: 対象となる既存ロジックを専用モジュールへ切り出し、元のファイルからは関数呼び出しのみを残す（この時点で既存の挙動・テストが100%維持されていることを確認する）。
2. **Step 2（新機能の実装）**: 切り出した新モジュール、またはそれと対になる新ファイル上で機能追加を行う。

---

## 2. フロントエンド 3層分離アーキテクチャ規約

PC（HTTP API）、単体モバイルHTML（WASM `sql.js`）、Androidネイティブアプリ（Kotlin SQLite + SAF Bridge）の3環境で「同じ頭脳（ロジック）」と「デバイス別の手足（UI・入力）」を実現するため、以下の3層を混在させてはならない。

### Layer 1: Data Adapter 層（データ取得・永続化・OSブリッジ）
- **役割**: バックエンド通信（`fetch`）、WebAssembly SQLite（`sql.js`）、Android ネイティブブリッジ（`window.TetheractNative`）の違いを吸収し、共通の非同期インターフェースを提供する。
- **鉄則**:
  - Adapter 層のコード内で `document.querySelector` や `innerHTML` などの **DOM 操作を行ってはならない**。
  - UI層（Layer 3）から直接 `fetch('/api/...')` や `db.exec('SELECT ...')` を呼ばず、Adapter 関数を経由させる。

### Layer 2: Core Domain & State 層（共通ビジネスロジック）
- **役割**: フィルタ条件の組み立て、階層タグツリー・フォルダツリー・機材ツリー・年月ツリーの構築、未同期ジャーナルの差分マージ、ヒストグラム算出、非破壊調整の数値計算など、PC・スマホ・タブレットで100%共通の「頭脳」を担う。
- **鉄則**:
  - **純粋関数（Pure Functions）を中心**に構成し、入力データを受け取って計算結果のオブジェクト／配列を返す設計にする。
  - マウスイベント（`click`, `contextmenu`）やタッチイベント（`touchstart`, `pointermove`）、特定のHTML要素IDに依存してはならない。

### Layer 3: View & Input Controller 層（画面描画・デバイス別入力制御）
- **役割**:
  - **Desktop Controller**: 3ペイン描画、マウスホバー、右クリックメニュー、キーボードショートカット。
  - **Touch / Tablet Controller**: Phone 1ペイン ⇄ Tablet 3ペイン可変レイアウト、自動収納ドロワー／ボトムシート、スワイプ・長押しなぞり選択・キャンバス全面スクラブ、変身する親指バー（Context-Morphing Thumb Bar）。
- **鉄則**:
  - PC用の微細ボタン群をスマホ画面に無理やり縮小配置しない。タッチ環境では対応するジェスチャーコントローラおよびタッチ専用シートHTML/CSSへバインドを切り替える。
  - 外部由来文字列（ファイル名・タグ名・EXIF等）をDOMへ描画する際は、必ずエスケープ関数（`escapeHtml` / `_escHtml`）を通す。

---

## 3. マルチエージェント分業プロトコル (Multi-Agent Collaboration Rules)

大規模なリファクタリングや Android アプリ・タッチUI実装を行う際は、1つのエージェントが全ファイルを抱え込まず、`invoke_subagent` を活用して役割別に並列・分担作業を行う。

### 3.1 鉄則1：ファイル所有権の完全分離 (Strict File Ownership)
複数のサブエージェントを同時に走らせる場合、**同じファイルを2つ以上のエージェントに同時編集させてはならない**。タスクを割り振る親エージェント（オーケストレータ）は、各サブエージェントのプロンプトに以下を明記すること：
- **編集許可ファイル（Write Allowed）**: そのサブエージェントが作成・変更してよいファイルパスの一覧。
- **読み取り専用ファイル（Read Only）**: 参照してよいが書き換えてはならないファイルパスの一覧。

### 3.2 鉄則2：インターフェース先行合意 (Contract-First Development)
並列作業を開始する前に、親エージェントがモジュール間の「入出力の約束（関数名・引数・戻り値の型・カスタムイベント名）」を定義し、各サブエージェントへ共有してから実装に入ること。

```javascript
// 例：親エージェントが事前に確定させる DataAdapter 契約の例
// window.TetheractDataAdapter = {
//   async getPhotos(filterParams) -> Promise<Array<PhotoRecord>>,
//   async getThumbnailUrl(photoId) -> Promise<string>,
//   async setRating(photoIds, rating) -> Promise<{ok: boolean}>,
//   async syncPendingChanges() -> Promise<{syncedCount: number}>
// }
```

### 3.3 標準サブエージェント役割分担モデル

| ロール名 | 担当領域（Write Allowed） | 主なミッション |
| :--- | :--- | :--- |
| **1. Core Refactoring Agent**<br>（コア抽出・共通化担当） | `frontend/js/core/*.js`<br>（※切り出し元の既存ファイルは段階的に整理） | 既存モノリス（`app.js`, `sidebar_filters.js`, `mobile.js` 等）からツリー構築・フィルタ計算・ヒストグラム等の純粋ロジックを抽出し、DOM非依存の共通モジュール化する。 |
| **2. Data Adapter & Native Bridge Agent**<br>（DB・通信・Android橋渡し担当） | `frontend/js/adapters/*.js`<br>`android/`（Kotlin/SAF/SQLiteロッカー）<br>`server/routers/mobile_router.py` | スマホ内専用ロッカー（内部キャッシュDB）＋ SAF永続権限 ＋ 未同期ジャーナル保護（`pending_journal`）＋ USB 2段階オフラインアップデートの実装。 |
| **3. Touch & Tablet UI Agent**<br>（タッチUI・ジェスチャー担当） | `frontend/js/views/touch/*.js`<br>`frontend/css/touch-*.css`<br>`frontend/mobile.html` | Phoneモード ⇄ Tabletモードのレスポンシブ切替、自動収納ドロワー、スワイプ・長押しなぞり選択・キャンバス全面スクラブ、変身する親指バーの実装。 |
| **4. QA & Security Agent**<br>（検証・バンドル・テスト担当） | `tests/test_*.py`<br>`server/mobile_bundle.py` | 切り出したモジュールの回帰テスト作成、XSS・LAN保護等のセキュリティテスト（`test_security.py`）、単体HTMLバンドル生成の確認。 |

### 3.4 統合・検証ゲート (Integration Gate)
各サブエージェントの作業完了後、親エージェントは以下の統合チェックを必ず実行してからコミットに進む：
1. `.\python\python.exe server\mobile_bundle.py`（モバイル単体HTMLの再生成エラーがないこと）
2. `.\python\python.exe -m unittest discover -s tests -p "test_*.py"`（全回帰テスト・セキュリティテストが OK であること）
3. 新規ファイルが CSS / JS の読み込み順（`index.html` / `mobile.html`）および配布スクリプト（`build_dist.bat` / `make_release_zips.py`）に正しく反映されていること。
