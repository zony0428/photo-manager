# アーキテクチャ & パフォーマンス規約

本ドキュメントは、Photo Manager のコア設計原則、ポータブル運用要件、SQLiteパフォーマンスチューニングに関する仕様を定義する。

---

## 1. ポータブル運用原則 (Portable First)

Photo Manager の最大の特徴は、**「USBメモリや外付けSSDに丸ごと入れて持ち歩き、どのPCでも即座に自走する」** ことである。

### 相対パスの徹底
- スクリプト・設定・キャッシュパスの取得は、常に自身の配置ディレクトリ（`Path(__file__).resolve().parent` や `%~dp0`）を起点とする。
- コード内に `C:\Users\...` や特定ドライブレターをハードコードすることは厳禁。

### ドライブレター変動・複数メディア（VSN）への対応
- USBメモリを別のPCに挿した場合、ドライブ文字が `D:` から `E:` や `F:` に変わる。また、同じドライブ文字（例: `E:`）に別のSDカードが挿さることもある。
- 実写真ファイルの読み込み時は、必ず `server.scanner.resolve_portable_path(stored_path, expected_serial=photo["volume_serial"])` を経由して動的に解決する。
  - `volume_serial` を持つレコードでは `expected_serial` を省略してはならない（省略すると、同じドライブ文字に挿さった別メディアの同名ファイルを誤って開く）。
- 解決順序:
  1. アプリ内 `Loome/`（または既存の `storage/`）配下のパスであれば、アプリ自身の `Loome/`（または `storage/`）で解決する（外付けドライブの `<Drive>:\Loome` は VSN 照合で解決）
  2. VSN 指定があり、ローカル／リムーバブルドライブ上のパスであれば、そのVSNを持つ接続中ドライブで解決する（ドライブ文字の変化に追従。該当VSNが未接続ならオフラインとし、別メディアへは絶対に誤一致させない）
  3. VSN 未指定、またはネットワークドライブ・UNC パス（VSN照合の対象外）は従来方式で解決する（元パスの存在確認 → 現在ドライブでの相対パス照合 → クラウド同期フォルダ照合 → プロジェクト直下 `photos/`）
  4. 見つからない場合は「未接続（オフライン）」フラグを返す
- **ユニーク画像エンティティ（`photos`）と実ファイル所在リンク（`photo_links`）の分離（v1.2.0+）**:
  - 複数のフォルダや複数の外部メディア（SDカード・SSD等）に同一の写真が存在する場合、`photos` テーブルにはユニークな写真として1行のみ、サムネイルも1個のみ、タグも1組のみを保持し、各メディア・フォルダ上の実ファイル所在を `photo_links` テーブル（`UNIQUE(volume_serial, rel_path)`）で複数保持する。
  - 同一画像の判定には、撮影日時（シフト前 `original_date_taken` 優先）・ファイルサイズ・RAW区分・ミリ秒（`subsec_time`）・露出パラメータ（シャッター速度・F値・ISO・露出補正値）から生成される不変識別キー `content_key` を用いる（4KB境界パディングJPEGの連写・ブラケット別コマ誤統合を防止）。
  - 片方のメディアからファイルが消えた場合は残存メディアのリンクを代表パスへ自動昇格し、全リンクが0本になった場合のみ `is_unlinked = 1`（リンク切れの写真）へ移動、後日別メディアや移動先で再発見された際は既存 `photo_id` へ自動再リンクする。
  - 旧互換の `vsn://<VSN>/<元パス>` 接頭辞が残っている場合は `_strip_vsn_prefix_raw()` で除去してからAPI・UIへ返す。

---

## 2. SQLite 最適化 & サムネイル設計

### 接続設定 (PRAGMA)
データベース（`cache/library.db`）は低速なUSBフラッシュメモリ上でも快適に動作するよう、以下のPRAGMAパラメータでチューニングされている（`server/database/connection.py`）：

```python
# WALモード（並行読み書きの高速化）
conn.execute("PRAGMA journal_mode = WAL")
# 16MB キャッシュ（スレッドローカル接続 × スレッドプール最大40本分でのメモリ肥大化を防止）
conn.execute("PRAGMA cache_size = -16000")
# 256MB メモリマップドI/O（OSページキャッシュを活用した超高速読み出し）
conn.execute("PRAGMA mmap_size = 268435456")
# 同期モードNORMAL（耐障害性と速度のベストバランス）
conn.execute("PRAGMA synchronous = NORMAL")
# 一時テーブルをRAM上で処理
conn.execute("PRAGMA temp_store = MEMORY")
```

### サムネイルの BLOB 管理
- 初期の実装（ファイルシステム上に数万個のWebPファイルを置く方式）は、USBのファイルシステムオーバーヘッドやアンチウイルススキャンにより著しい速度低下を招いた。
- そのため、**サムネイル画像（WebPバイナリ）は SQLite の `thumbnails` テーブルに BLOB として格納** する方式に統一されている。
- サムネイル取得・保存は `server/database/thumbnails.py` の `get_thumbnail()` / `save_thumbnail()` を使用すること。
- **ROWID直結 & クラスタ化（v1.2.0+）**:
  - `thumbnails` テーブルは `photo_id INTEGER PRIMARY KEY`（ROWID直結1発ルックアップ）とし、重複排除されたユニーク写真1枚につき1つのWebP BLOBを保持する。
  - `photo_tags` テーブルは `PRIMARY KEY (photo_id, tag) WITHOUT ROWID` のクラスタ化構造とし、同一写真のタグをディスク・RAMキャッシュ上で物理的に隣接配置する。
- **スレッドローカル常駐読み取り接続 & インメモリキャッシュ（v1.4.0+）**: `server/database/connection.py` の `get_read_connection()` によりスレッドごとにPRAGMA適用済みのSQLite読み取り接続を再利用し、かつ `frontend/js/app.js` 側でフィルタ切り替え時は不要な `/api/stats` 通信をスキップ（`skipStats=true`）＋30秒TTLキャッシュ（`_galleryResponseCache`）を組み合わせることで、2.7万枚環境でも初回約5ms・キャッシュヒット時0.01ms未満で瞬時に切り替える。
- **安全なスキーマ再構築マイグレーション原則（v1.2.1+）**:
  - SQLite で親テーブル（`photos`）を再構築（`DROP TABLE` / `RENAME`）する際は、`ON DELETE CASCADE` による子テーブル（`photo_tags`, `thumbnails`, `photo_links`）の連動消失を防ぐため、必ずトランザクション外で `PRAGMA foreign_keys = OFF` を実行し、かつ再構築前に子テーブルを一時退避テーブルへコピーする二重保護を行うこと（万が一旧版で消失していた場合は `cache/backups/library_pre_ideal_photo_links_v1_*.db` から自動復元する）。

---

## 3. バックエンド & ライフサイクル管理

### アプリモード起動
- `run.py` は Edge または Chrome を探索し、`--app=http://127.0.0.1:8088` 引数を付与して起動する。
- これにより、ブラウザのURLバーやタブを排除した単体ネイティブアプリ風のUXを提供する。
- 数万枚規模のDBマイグレーションや事前バックアップ作成中にブラウザが先に開いて `ERR_CONNECTION_REFUSED` になるのを防ぐため、`run.py` / `server/run.py` のポートOpen待機上限は最大180秒に設定されている。

### タスクトレイ常駐 & 明示的シャットダウン
- 起動バッチ `start.bat` は `pythonw.exe` を使用してコンソールウィンドウを出さずにバックグラウンドで起動する。
- タスクトレイ常駐（`server/tray.py` / `pystray`）に伴い、ブラウザウィンドウを閉じた際のハートビート途絶による自動強制終了は無効化されている（ウィンドウを閉じてもトレイアイコンや `Tetheract.exe` から即座に再表示できる）。
- サーバーの終了は、UI右上の終了ボタン（`POST /api/shutdown` -> `server/heartbeat.py` の `request_shutdown()`）またはタスクトレイメニューの「サーバーを終了 (シャットダウン)」から安全に実行する。
- サーバーのログは `pythonw.exe` 起動時でも追跡できるよう、ルートの `server.log` に出力される。

---

## 4. RAW 画像処理 & パフォーマンス

- RAW現像には `rawpy`（LibRaw）を使用する。
- 高速プレビュー表示時は、巨大なRAWデータをフルデコードするのではなく、RAW内部に埋め込まれているプレビューJPEGを優先抽出（`extract_embedded_jpeg()`）してサムネイル化する。
- クラウドストレージ（OneDrive / Google Drive）のオンデマンド同期（ローカル未実体化）ファイルに対しては、勝手な自動ダウンロードを防ぐため Windows Shell API のサムネイルキャッシュ（`shell_thumbnail.py`）をフォールバックとして活用する。
