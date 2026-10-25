# サムネイル管理の変遷と SQLite BLOB アーキテクチャ

## 1. 課題と背景

Photo Manager の初期設計では、サムネイル画像をファイルシステム上の個別ファイルとして保存していた：
- パス: `.cache/thumbnails/{photo_id}_{size}.webp`

### 発生した深刻な問題
1. **USBストレージでの性能崩壊**:
   写真が1万枚ある場合、大・小サムネイルで数万個の微小ファイル（数KB〜数十KB）が生成される。
   USBフラッシュメモリ（特に exFAT / FAT32）では、微小ファイルのランダムI/O性能が内蔵SSDの1/100以下に落ち込み、グリッド表示が極端にカクつく。
2. **フォルダコピー・バックアップの遅延**:
   エクスプローラーで `.cache` フォルダをコピーする際、総容量は数GB程度でもファイル数が多すぎるため、完了まで数十分〜数時間かかる。
3. **セキュリティソフト（Windows Defender 等）のリアルタイムスキャン負荷**:
   ブラウザが高速スクロールして大量のWebPファイルを読み込むたびに、ウイルス対策ソフトがファイル1個ずつを検査するため、CPU使用率が跳ね上がる。

---

## 2. 解決策: SQLite BLOB 方式への統一

サムネイルバイナリ（WebP）を単一の SQLite データベース（`.cache/library.db`）内のテーブルに直接 BLOB として格納する方式に全面移行した。

### テーブル設計
```sql
CREATE TABLE IF NOT EXISTS thumbnails (
    photo_id INTEGER NOT NULL,
    max_size INTEGER NOT NULL,
    image_data BLOB NOT NULL,
    created_at TEXT NOT NULL,
    file_hash TEXT,
    PRIMARY KEY (photo_id, max_size),
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_thumbnails_lookup ON thumbnails(photo_id, max_size);
```

### パフォーマンス最適化PRAGMA
単一ファイルへの集約に加え、以下の設定により超高速な読み出しを実現：
- `PRAGMA journal_mode = WAL`: 読み込みと書き込みが互いにブロックしない。
- `PRAGMA cache_size = -16000`: 16MBのRAMキャッシュ（接続ごと）。v1.35までは64MBだったが、スレッドローカル接続×スレッドプールでメモリが肥大化するため v1.36 で縮小（読み出しは mmap が主に担う）。
- `PRAGMA mmap_size = 268435456`: 256MBのメモリマップドI/O。ファイル読み込みのシステムコールオーバーヘッドを回避。
- `PRAGMA synchronous = NORMAL`: 書き込み同期頻度を適正化。

### 導入結果
- **起動・スクロール速度**: グリッドの読み込み速度が体感で約3〜5倍に向上。
- **ポータビリティ**: `.cache/` フォルダのコピー・移動が一瞬で完了するようになった。
- **連動削除**: `ON DELETE CASCADE` により、写真を削除した際に対応するサムネイルも自動削除され、ゴミが残らない。
