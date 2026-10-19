# アーキテクチャ & パフォーマンス規約

本ドキュメントは、Photo Manager のコア設計原則、ポータブル運用要件、SQLiteパフォーマンスチューニングに関する仕様を定義する。

---

## 1. ポータブル運用原則 (Portable First)

Photo Manager の最大の特徴は、**「USBメモリや外付けSSDに丸ごと入れて持ち歩き、どのPCでも即座に自走する」** ことである。

### 相対パスの徹底
- スクリプト・設定・キャッシュパスの取得は、常に自身の配置ディレクトリ（`Path(__file__).resolve().parent` や `%~dp0`）を起点とする。
- コード内に `C:\Users\...` や特定ドライブレターをハードコードすることは厳禁。

### ドライブレター変動への対応
- USBメモリを別のPCに挿した場合、ドライブ文字が `D:` から `E:` や `F:` に変わる。
- 実写真ファイルの読み込み時は、必ず `server.scanner.resolve_portable_path(stored_path)` を経由して動的に解決する。
  1. `stored_path` がそのまま存在するか確認
  2. 存在しない場合、現在のカレントドライブ（USBドライブ）に同じ相対パスが存在するか照合
  3. プロジェクト直下の `photos/` フォルダ内を照合
  4. 見つからない場合は「未接続（オフライン）」フラグを返す

---

## 2. SQLite 最適化 & サムネイル設計

### 接続設定 (PRAGMA)
データベース（`.cache/library.db`）は低速なUSBフラッシュメモリ上でも快適に動作するよう、以下のPRAGMAパラメータでチューニングされている（`server/database/connection.py`）：

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

---

## 3. バックエンド & ライフサイクル管理

### アプリモード起動
- `run.py` は Edge または Chrome を探索し、`--app=http://127.0.0.1:8088` 引数を付与して起動する。
- これにより、ブラウザのURLバーやタブを排除した単体ネイティブアプリ風のUXを提供する。

### 自動シャットダウン (Heartbeat)
- 起動バッチ `start.bat` は `pythonw.exe` を使用してコンソールウィンドウを出さずにバックグラウンドで起動する。
- ユーザーがブラウザウィンドウを閉じた際、プロセスがゾンビとして残り続けないよう、フロントエンドから定期的にハートビート通信（`/api/heartbeat`）を送出している。
- 一定時間ハートビートが途絶えた場合、`server/heartbeat.py` がプロセスを安全に自動終了する。
- サーバーのログは `pythonw.exe` 起動時でも追跡できるよう、ルートの `server.log` に出力される。

---

## 4. RAW 画像処理 & パフォーマンス

- RAW現像には `rawpy`（LibRaw）を使用する。
- 高速プレビュー表示時は、巨大なRAWデータをフルデコードするのではなく、RAW内部に埋め込まれているプレビューJPEGを優先抽出（`extract_embedded_jpeg()`）してサムネイル化する。
- クラウドストレージ（OneDrive / Google Drive）のオンデマンド同期（ローカル未実体化）ファイルに対しては、勝手な自動ダウンロードを防ぐため Windows Shell API のサムネイルキャッシュ（`shell_thumbnail.py`）をフォールバックとして活用する。
