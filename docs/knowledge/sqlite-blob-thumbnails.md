# サムネイル管理の変遷と SQLite BLOB ＆ ROWID クラスタ化アーキテクチャ

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

## 2. 解決策: SQLite BLOB 方式への統一と ROWID 直結化（v1.2.0+）

サムネイルバイナリ（WebP）を単一の SQLite データベース（`cache/library.db`）内のテーブルに直接 BLOB として格納する方式に全面移行し、さらに v1.2.0 以降でユニーク写真エンティティ（`photos`）と1対1に対応する `photo_id INTEGER PRIMARY KEY`（ROWID直結構造）へ最適化した。

### 現行テーブル設計（`server/database/schema.py`）
```sql
-- サムネイル BLOB 格納テーブル（photo_id INTEGER PRIMARY KEY による ROWID 直結構造）
CREATE TABLE IF NOT EXISTS thumbnails (
    photo_id INTEGER PRIMARY KEY,
    file_hash TEXT,
    data BLOB NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
);

-- タグ・アルバム管理テーブル（WITHOUT ROWID による省メモリ・高速カバリング構造）
CREATE TABLE IF NOT EXISTS photo_tags (
    photo_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    confidence REAL DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (photo_id, tag),
    FOREIGN KEY(photo_id) REFERENCES photos(id) ON DELETE CASCADE
) WITHOUT ROWID;
```

### アーキテクチャ上の特徴
1. **ROWID 直結 1発ルックアップ (`thumbnails`)**:
   - 旧方式の文字列主キー（`file_hash`）＋ セカンダリインデックスの2段階B-Tree探索を廃止し、SQLite 最速の `photo_id INTEGER PRIMARY KEY`（ROWID エイリアス）直結とした。
   - 複数フォルダ・複数メディアに同一画像が存在する場合も、`photos` と `photo_links` の分離によりサムネイル BLOB はユニーク画像につき **1個のみ** 格納される。
2. **`WITHOUT ROWID` クラスタ化 (`photo_tags`)**:
   - 不要な連番 `id` カラムを廃止し、`PRIMARY KEY (photo_id, tag) WITHOUT ROWID` とすることで、同一写真のタグ行がディスクページ・RAMキャッシュ上で物理的に隣接配置され、一覧表示・フィルタ時の連続スキャンが高速化されている。
3. **安全なテーブル再構築マイグレーション原則（v1.2.1+）**:
   - SQLite で親テーブル（`photos`）の制約変更等に伴うテーブル再構築（`DROP TABLE photos` → `ALTER TABLE photos_new RENAME TO photos`）を行う際、`FOREIGN KEY ... ON DELETE CASCADE` が有効だと子テーブル（`thumbnails`, `photo_tags`, `photo_links`）が連動消去されてしまう。
   - そのため、スキーマ再構築マイグレーションでは **① トランザクション確定後の `PRAGMA foreign_keys = OFF` 実行** と、**② 再構築前の子テーブル一時退避テーブルへのコピー＆復元** の二重保護を行い、さらにマイグレーション実行前に `cache/backups/library_pre_ideal_photo_links_v1_<日時>.db` へ自動バックアップを作成する（万が一初版 v1.2.0 でタグ・サムネイルが欠落していた環境でも、起動時に事前バックアップから100%自動復元する自己修復機構を搭載）。

---

## 3. パフォーマンス最適化 PRAGMA

単一ファイルへの集約に加え、以下の設定により超高速な読み出しを実現（`server/database/connection.py`）：
- `PRAGMA journal_mode = WAL`: 読み込みと書き込みが互いにブロックしない。
- `PRAGMA cache_size = -16000`: 16MBのRAMキャッシュ（接続ごと）。スレッドローカル接続×スレッドプールでメモリが肥大化しないよう適正化（読み出しは mmap が主に担う）。
- `PRAGMA mmap_size = 268435456`: 256MBのメモリマップドI/O。ファイル読み込みのシステムコールオーバーヘッドを回避。
- `PRAGMA synchronous = NORMAL`: 書き込み同期頻度を適正化。
- `PRAGMA temp_store = MEMORY`: 一時テーブル・ソート処理をRAM上で実行。

### 導入結果
- **起動・スクロール速度**: グリッドの読み込み速度が体感で約3〜5倍に向上し、重複サムネイル排除によりDB容量とRAMキャッシュ効率も大幅改善。
- **ポータビリティ**: `cache/` フォルダのコピー・移動が一瞬で完了する。
- **連動削除**: `ON DELETE CASCADE` および `trg_photos_after_delete` トリガーにより、写真を完全削除した際に対応するサムネイル・タグ・所在リンクも自動削除され、ゴミが残らない。
