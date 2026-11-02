# TETHERACT pm v1.2.0 Release Notes

- **Tag**: `v1.2.0`
- **Title**: `TETHERACT pm v1.2.0 - Unified Photo Entity & Multi-Media Link Architecture, Faster Rendering & Automatic DB Deduplication`
- **Date**: `2026-11-02`

---

> [!WARNING]
> **【重要】データベース構造刷新に伴う後方互換性に関するご注意 / Important Notice on Database Backward Compatibility**
>
> - **自動バックアップの作成**: v1.2.0 の初回起動時、マイグレーション実行前に既存のデータベースが `cache/backups/library_pre_ideal_photo_links_v1_<日時>.db` として**自動バックアップ**されます。
> - **旧バージョンとの後方互換性なし**: v1.2.0 ではデータベース構造（`photos`・`photo_links`・`thumbnails`・`photo_tags`）を抜本的に刷新しているため、**v1.2.0 で自動変換された後の `cache/library.db` を v1.1.1 以前の旧バージョンで開くことはできません（後方互換性はありません）**。万が一旧バージョンへ戻す場合は、`cache/backups/` 内のバックアップファイルを `cache/library.db` に戻してご利用ください。
> - **Automatic Pre-Migration Backup & No Backward Compatibility**: On first launch of v1.2.0, your existing database is automatically backed up to `cache/backups/library_pre_ideal_photo_links_v1_<timestamp>.db` before migration. Because v1.2.0 introduces a fundamental database schema overhaul, **the migrated `cache/library.db` is NOT backward-compatible with v1.1.1 or earlier**. If you ever need to downgrade, restore the backup file from `cache/backups/` to `cache/library.db`.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.2.0diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれ、初回起動時に自動で新DB構造へ統合マイグレーションされます）。
> - **初回導入（フル版 `Tetheract_v1.2.0.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.2.0diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. ユニーク画像エンティティ（`photos`）と実ファイル所在リンク（`photo_links`）の分離による抜本的DB刷新
- **「全写真枚数 − 重複分」の純粋エンティティ管理**: 複数のフォルダや複数の外部メディア（SDカード・ポータブルSSD等）に同一の写真が存在する場合、これまでのようにパスごとに `photos` 行・サムネイル・タグ行を重複保持するのではなく、`photos` テーブルにはユニークな写真として**1行のみ**、サムネイルも**1個のみ**、タグも**1組のみ**を保持し、各メディア・フォルダ上の実ファイルの所在を新設の `photo_links` テーブル（`volume_serial` ＋ ドライブ相対パス管理）で複数リンクとして保持する正規化アーキテクチャへ刷新しました。
- **不変の同一画像識別キー（`content_key`）の導入**: 撮影日時補正（シフト後でも `original_date_taken` を保持）・ファイルサイズ・RAW区分から生成される識別キー `content_key` により、ファイル名変更や日時シフト後でも 1 カラムのインデックス照合で即座に同一画像を特定します。
- **既存DBからの無損失・自動統合マイグレーション**: 初回起動時に事前バックアップを作成したうえで、旧DB内で複数行に分裂していた重複写真を自動的に1つの `photos` エンティティへ統合し、いずれかのコピーに付与されていた評価・お気に入り・非破壊調整・後付けGPS・日時シフト・手動/AIタグ・サムネイルをすべて無損失でマージします。

### 2. メディア横断のスマート・リンクライフサイクル（片方消失・全消失・再発見時の自動復帰）
- **片方のメディアから消えた場合**: 複数のメディア（例：メディアAとメディアB）にリンクを持つ写真が片方のメディアから削除・移動された場合、消えた側の `photo_links` のみを削除し、残っているメディアのリンクを自動的に代表パスへ昇格させて通常表示を継続します（不要に「リンク切れの写真」へ送られません）。
- **すべてのメディアから消えた場合（リンク消失リストでの保護）**: すべての管理下メディア・フォルダから実ファイルが見つからなくなった場合（残りリンク 0 本）のみ、「リンク切れの写真」一覧へ移動し、明示的にパージされるまで評価・タグ・調整値・サムネイルを安全に保持します。
- **後日別メディアや移動先で見つかった場合**: リンク消失状態の写真が後日メディアCや移動先フォルダ（リネーム済み含む）でスキャンされた際、既存の `photos` ID に新しいリンクが自動で張り直され、すべてのメタデータを維持したまま通常状態へ自動復帰します。

### 3. 一覧表示・サムネイル描画・タグ読込・フォルダ差分検知の大幅な高速化
- **一覧取得時の全件重複集計クエリを完全撤廃**: グリッド表示・フィルタ切り替えのたびに実行されていた全件 `GROUP BY date_taken, file_size` サブクエリおよび Python 側の辞書照合を廃止し、`photos.link_count` カラムの直接参照（追加クエリ 0 回）に置き換えました。
- **サムネイルテーブルの `photo_id INTEGER PRIMARY KEY`（ROWID直結）化**: 旧 `file_hash` 文字列主キーとセカンダリインデックスの2段階探索を廃止し、SQLite 最速の ROWID 直結1発ルックアップに刷新しました。重複サムネイルBLOBの排除とあわせてスクロール時の描画レスポンスとRAMキャッシュ効率が向上しています。
- **`photo_tags` テーブルの `WITHOUT ROWID` クラスタ化**: 不要な連番 `id` カラムを廃止し、`PRIMARY KEY (photo_id, tag) WITHOUT ROWID` とすることで、写真ごとのタグ情報がディスク・メモリ上で物理的に隣接配置され、連続スキャンで高速に読み出せるようになりました。

---

## English

### 1. Fundamental Database Overhaul: Unique Photo Entities (`photos`) & Location Links (`photo_links`)
- **True Deduplicated Entity Storage ($N - \text{Duplicates}$)**: Identical photos stored across multiple folders or external media (SD cards, portable SSDs) are now stored as a **single unique entity** in `photos` with **one** thumbnail in `thumbnails` and **one** set of tags in `photo_tags`, while physical file locations across volumes and folders are tracked as multiple links in the new `photo_links` table.
- **Immutable Identity Key (`content_key`)**: Added an indexed `content_key` derived from original capture timestamp, file size, and RAW flag for instant $O(\log N)$ identity matching even after timestamp shifts or file renames.
- **Lossless Automatic Deduplication Migration**: On first startup, after creating an automatic backup in `cache/backups/`, existing duplicate `photos` rows are automatically merged into a single master record while preserving all ratings, favorites, non-destructive adjustments, GPS coordinates, shifted dates, tags, and thumbnails.

### 2. Smart Cross-Media Link Lifecycle
- **Partial Removal (Surviving Links Remain)**: If a photo linked to both Media A and Media B is removed from Media B, only Media B's link is removed and Media A automatically becomes the primary path without sending the photo to the Unlinked list.
- **Complete Removal (0 Links Remaining)**: Only when all physical files across all managed folders/media are gone does the photo move to the "Unlinked Photos" list, retaining its thumbnail, ratings, tags, and adjustments until explicitly purged.
- **Automatic Relink & Recovery**: If the file is later scanned on Media C or a new folder (even if renamed), it automatically relinks to the existing `photos` record and restores normal visibility.

### 3. Noticeably Faster Grid Display, Thumbnail Loading & Tag Queries
- **Eliminated Full-Table Duplicate Subqueries on Grid Load**: Replaced the per-query `GROUP BY date_taken, file_size` full-table scan and Python dictionary matching in `get_photos()` with direct `photos.link_count` lookup (zero extra queries).
- **Direct ROWID Primary Key on `thumbnails` (`photo_id INTEGER PRIMARY KEY`)**: Replaced the legacy `file_hash` text primary key + secondary index lookup with a single direct ROWID B-Tree lookup.
- **Clustered `WITHOUT ROWID` `photo_tags` Table**: Rebuilt `photo_tags` as `PRIMARY KEY (photo_id, tag) WITHOUT ROWID` so all tags for a photo are stored contiguously on disk and in RAM cache.
