# 大規模化・パフォーマンス設計原則 ＆ 禁止アンチパターン

本ドキュメントは、数万枚・数百フォルダ・外付けSSD／仮想ドライブ（Google Drive / NAS）混在環境において、ある部位の変更が他部位の退行やフリーズを引き起こさないための **禁止アンチパターン**、**SQLite・キャッシュ・UIの安全実装原則**、および **自動テストの完全隔離規約** を定義する。

---

## 1. 禁止アンチパターン（採用厳禁）

| # | 対象領域 | やってはいけないアンチパターン | 引き起こされる障害・副作用 |
| :--- | :--- | :--- | :--- |
| **1** | **SQLite 変数上限** | `WHERE photo_id IN (?, ...)` に数万件のID配列をそのままバインドする | SQLite の `SQLITE_MAX_VARIABLE_NUMBER`（32,766）を超えた瞬間に `OperationalError: too many SQL variables` でクラッシュする。大量IDの `IN` 句はチャンク分割または一時テーブル／JOINで処理する。 |
| **2** | **SQLite BLOB 参照** | 一覧・スキャン前照合クエリで `LEFT JOIN thumbnails t ON p.id = t.photo_id` をインデックス指定なしで書く | 寸法（`width, height`）だけが欲しいクエリでも数百MBの WebP BLOB 本体ページをランダムシークしてしまう。寸法参照時は必ず `INDEXED BY idx_thumbnails_dims` を明示する。 |
| **3** | **フォルダ・重複検索** | `photos` 全行に対して相関 `EXISTS (SELECT 1 FROM photo_links pl WHERE pl.photo_id = p.id ...)` を回す、または全件取得後にPython側でフィルタする | 2枚しかないフォルダの絞り込みでも全数万枚のフルスキャンになる。`photo_links` 側のカバリングインデックス（`idx_photo_links_dir_nocase` / `idx_photo_links_vsn_reldir`）で `photo_id` 集合を先に絞る（`rel_dir` の先頭 `\` 仕様を維持）。 |
| **4** | **親テーブル再構築** | `PRAGMA foreign_keys = ON` のまま、またはトランザクション内だけで `photos` テーブルを `DROP` / 再構築する | `ON DELETE CASCADE` により `thumbnails`, `photo_tags`, `photo_links` が連動全消去される。スキーマ再構築時はトランザクション外での `PRAGMA foreign_keys = OFF` と子テーブル一時退避の二重保護を必須とする。 |
| **5** | **ポータブルパス判定** | `resolve_portable_path(..., expected_serial=...)` を通さず DB の `file_path` / `directory_path` に直接 `os.path.exists` / `os.listdir` を呼ぶ | USBや外付けSSDのドライブレター変動時（`D:` → `E:` 等）に全写真が「未接続・消失」と誤判定される。ディレクトリ単位でバッチ走査する場合も、先にディレクトリ単位で `resolve_portable_path` を解決してから `os.scandir` する。 |
| **6** | **キャッシュ無効化・非同期I/O** | 変更有無を確認する前に無条件でレスポンスキャッシュ全消去や `bump_db_commit_seq()` を呼ぶ、または FastAPI の `async def` 内で重い同期SQLite／ファイルI/Oを実行する | Alt-Tab 復帰やサムネイル1枚保存のたびに全キャッシュが崩壊し、直後のクリックで数秒のフル再構築フリーズと Uvicorn イベントループ停止を引き起こす。重いI/Oはスレッドプール（同期 `def` または `run_in_threadpool`）で実行し、実変更があったドメインのみ無効化する。 |
| **7** | **フロントエンド更新** | 1枚〜数枚の評価・タグ変更のたびに `renderPhotoGrid()`（`innerHTML = ''` 全DOM破棄）や同一ティック内での多重 `fetchPhotos()` / `refreshAll()` を乱射する | スクロール位置の喪失、数万DOMノードの再構築、バックエンド側での重いJSON生成の並走競合を招く。単一・バッチ属性変更は `state.photoById`（O(1) Map）と対象カードのDOM部分更新を基本とし、一覧再取得はマイクロタスク合流で1回に束ねる。 |
| **8** | **サムネイルURL / ETag** | クロップ4座標（`crop_x, crop_y, crop_w, crop_h`）・回転・`file_mtime` を含めずに `Cache-Control: immutable` を付ける、または一覧に Base64 バッチを使う | アスペクト比固定のままクロップ枠を平行移動した際に古いサムネイルが残り続ける。また Base64 一括返却は転送量1.33倍＋JSヒープ圧迫で逆効果となる。 |

---

## 2. レイアウト安定性とモジュール分割の安全原則

1. **プレースホルダ寸法の事前確定 (`getPhotoAspectInfo`)**:
   - `thumbnails.width` / `height` には回転・クロップ反映済みの寸法が格納されているため二重に90°入れ替えを行わず、未生成時のみ元寸法＋回転＋クロップ比率から計算して `.photo-card` の `--photo-aspect` / `--photo-aspect-ratio` に設定する。これにより「びっしり表示（Masonry）」でも画像ロード前後の Layout Shift を防ぐ。
2. **後方互換を壊さないモジュール分割**:
   - **Python (`server/database/`, `server/routers/`)**: サブモジュールへ関数を切り出す際はパッケージの `__init__.py` 等で公開シンボルを維持し、かつ呼び出し元への配線と旧コード除去を同一変更内で完結させる（未配線の死にファイルを作らない）。
   - **CSS (`frontend/css/`)**: 直列ラウンドトリップを招く `@import` は使わず、HTMLの `<link rel="stylesheet">` 順で読み込む。

---

## 3. 自動テストの本番環境完全隔離プロトコル (`tests/`)

同梱ポータブル Python には `pytest` を入れず標準 `unittest` で統一する（`.\python\python.exe -m unittest discover -s tests -p "test_*.py"`）。テストコードは以下の隔離原則を厳守しなければならない：

1. **本番 `cache/library.db` への接触厳禁**:
   - `server/database/connection.py` はスレッドローカル（`_local_db.connection`）に接続を保持するため、`DB_PATH` 変数の書き換えや `:memory:` 指定だけでは既存接続や別スレッドから本番DBを破壊する。
   - 必ずテストモジュールの `setUpModule` / `setUpClass` で一時ディレクトリ内の一時ファイルパスを作成し、`switch_database_path(temp_db_path)`（および終了時の `close_all_connections()` + 元パス復元）を実行する。
2. **ワークツリー生成物・実ネットワーク待受の隔離**:
   - ルートの `Tetheract_Mobile.html`、`Loome/`、`cache/field_logs/`、`.tetheract_instance` 等の実ファイルも一時ディレクトリまたはテスト用差し替えフックへ向ける。
   - LANペアリング等のテストで実ソケット待受（`ensure_lan_listeners` 等）や過剰な PBKDF2 反復を起動してテスト時間を肥大化させない（本番定数値のアサーションのみ独立して行う）。
