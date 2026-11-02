# TETHERACT pm v1.2.1 Release Notes

- **Tag**: `v1.2.1`
- **Title**: `TETHERACT pm v1.2.1 - Safe DB Schema Migration Fix, Auto-Backup Tag/Thumbnail Recovery, Burst Frame Identity & New App Icon`
- **Date**: `2026-11-02`

---

> [!WARNING]
> **【重要】データベース構造刷新に伴う後方互換性に関するご注意 / Important Notice on Database Backward Compatibility**
>
> - **自動バックアップの作成**: v1.2.x の初回起動時、マイグレーション実行前に既存のデータベースが `cache/backups/library_pre_ideal_photo_links_v1_<日時>.db` として**自動バックアップ**されます。
> - **旧バージョンとの後方互換性なし**: v1.2.x ではデータベース構造（`photos`・`photo_links`・`thumbnails`・`photo_tags`）を抜本的に刷新しているため、**v1.2.x で自動変換された後の `cache/library.db` を v1.1.1 以前の旧バージョンで開くことはできません（後方互換性はありません）**。万が一旧バージョンへ戻す場合は、`cache/backups/` 内のバックアップファイルを `cache/library.db` に戻してご利用ください。
> - **Automatic Pre-Migration Backup & No Backward Compatibility**: On first launch of v1.2.x, your existing database is automatically backed up to `cache/backups/library_pre_ideal_photo_links_v1_<timestamp>.db` before migration. Because v1.2.x introduces a fundamental database schema overhaul, **the migrated `cache/library.db` is NOT backward-compatible with v1.1.1 or earlier**. If you ever need to downgrade, restore the backup file from `cache/backups/` to `cache/library.db`.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.2.1diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれ、安全に新DB構造へ統合マイグレーションされます）。
> - **初回導入（フル版 `Tetheract_v1.2.1.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.2.1diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 重要バグ修正：DBマイグレーション時のタグ・サムネイル保護 ＆ 事前バックアップからの自動復元（v1.2.1）
- **テーブル再構築時の外部キー連動削除（`ON DELETE CASCADE`）の完全遮断**: v1.1.1 以前のデータベースから新スキーマへ移行する際、`photos` テーブルの旧 `UNIQUE` 制約解除に伴うテーブル再構築時に SQLite の `ON DELETE CASCADE` が発火して `photo_tags`（タグ）および `thumbnails`（サムネイル）がクリアされてしまう不具合を修正しました。トランザクション確定後の `PRAGMA foreign_keys = OFF` 化に加え、`photos` 再構築前に子テーブルを一時退避テーブルへ移してから再構築する二重保護により、タグ・サムネイルを1件も欠落させずに移行します。
- **初版 v1.2.0 起動済み環境の自動リストア（自己修復マイグレーション）**: 万が一初版 v1.2.0 を一度起動してタグやサムネイルが消えていた環境でも、v1.2.1 を起動するだけで `cache/backups/library_pre_ideal_photo_links_v1_*.db`（自動作成された事前バックアップ）から全タグ・全サムネイルを重複統合後の `photo_id` へ自動的にマッピングして100%復元します。
- **同一秒・同一ファイルサイズの連写・ブラケット別コマの識別精度向上**: LUMIX（DC-S1R 等）のように JPEG ファイルサイズが 4KB 境界にパディングされるカメラで、1秒間に連写・ブラケット撮影された別コマがたまたま同じファイルサイズになった際に同一画像として統合されないよう、不変識別キー `content_key` にミリ秒（`subsec_time`）および露出パラメータ（シャッター速度・F値・ISO・露出補正値）を追加しました。

### 2. アプリアイコンのフルブリード刷新 ＆ ヘッダーロゴ反映（v1.2.1）
- **新アプリアイコン採用**: シャンパンブロンズの発光ブルーム、パースペクティブ（遠近）テザーライン、ヘアラインリムを備えたフルブリードの新アイコンへ刷新し、PC メイン画面およびモバイル画面（単体 HTML 含む）のヘッダー左上のロゴマークにも統一反映しました（`pm` とバージョンバッジの重なりも解消）。

### 3. ユニーク画像エンティティ（`photos`）と実ファイル所在リンク（`photo_links`）の分離によるDB刷新（v1.2.0〜v1.2.1）
- **「全写真枚数 − 重複分」の純粋エンティティ管理**: 複数のフォルダや複数の外部メディア（SDカード・ポータブルSSD等）に同一の写真が存在する場合、`photos` テーブルにはユニークな写真として**1行のみ**、サムネイルも**1個のみ**、タグも**1組のみ**を保持し、各メディア・フォルダ上の実ファイルの所在を `photo_links` テーブル（`volume_serial` ＋ ドライブ相対パス管理）で複数保持する正規化構造を採用しています。
- **メディア横断のスマート・リンクライフサイクル**: 複数メディアにリンクを持つ写真が片方のメディアから消えた場合は残存メディアを代表に自動昇格して通常表示を維持し、すべての管理先から消えた場合（残りリンク0本）のみ「リンク切れの写真」リストへ移動、後日別メディアや移動先フォルダで見つかった際には既存の `photo_id` へ自動で再リンクして復帰します。
- **一覧表示・サムネイル描画・タグ読込の高速化**: 一覧取得時の全件重複集計サブクエリを廃止して `photos.link_count` 直読とし、`thumbnails` テーブルの `photo_id INTEGER PRIMARY KEY`（ROWID直結）化および `photo_tags` テーブルの `PRIMARY KEY (photo_id, tag) WITHOUT ROWID` クラスタ化により、スクロール・フィルタ切替の体感速度を向上させています。

---

## English

### 1. Critical Fix: Safe Schema Migration Without Cascade Deletion & Auto-Backup Recovery (v1.2.1)
- **Prevented `ON DELETE CASCADE` During Table Rebuild**: Fixed a critical issue where rebuilding the legacy `photos` table to drop the `file_path UNIQUE` constraint triggered SQLite's `ON DELETE CASCADE` on `photo_tags` and `thumbnails`. The migration now disables foreign keys outside transactions (`PRAGMA foreign_keys = OFF`) and stages child tables into temporary backup tables prior to rebuilding `photos`, guaranteeing zero data loss during v1.1.1 → v1.2.1 migration.
- **Automatic Self-Healing Recovery from Pre-Migration Backup**: For any environment where v1.2.0 was already launched once, v1.2.1 automatically detects `cache/backups/library_pre_ideal_photo_links_v1_*.db` on startup and restores 100% of tags and thumbnails mapped to the deduplicated `photo_id` records.
- **Sub-Second & Exposure-Aware `content_key` for Padded Burst/Bracket Frames**: Enhanced `content_key` with `subsec_time`, shutter speed, aperture, ISO, and exposure bias so that same-second burst or auto-exposure bracket frames on cameras that pad JPEG file sizes to 4 KB boundaries (such as Panasonic LUMIX S1R) are never mistakenly merged as duplicates.

### 2. Redesigned Full-Bleed App Icon & Header Logo Mark (v1.2.1)
- **New App Icon & Header Integration**: Redesigned the application icon with a full-bleed champagne-bronze bloom, perspective tether lines, and hairline rim, and unified the header logo mark across both Desktop and Mobile UIs (including standalone `Tetheract_Mobile.html`).

### 3. Unified Photo Entities (`photos`) & Multi-Media Location Links (`photo_links`) (v1.2.0–v1.2.1)
- **Deduplicated Entity Storage ($N - \text{Duplicates}$)**: Identical photos across multiple folders or external drives are stored as a single unique row in `photos` with one thumbnail in `thumbnails` (`photo_id INTEGER PRIMARY KEY`) and one tag set in `photo_tags` (`WITHOUT ROWID`), while physical file locations are tracked in `photo_links`.
- **Smart Cross-Media Link Lifecycle & Faster Grid Queries**: Automatically promotes surviving media links when one copy is removed, moves photos to the Unlinked list only when 0 links remain, and eliminates full-table duplicate subqueries during grid rendering.
