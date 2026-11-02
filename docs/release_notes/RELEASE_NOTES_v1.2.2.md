# TETHERACT pm v1.2.2 Release Notes

- **Tag**: `v1.2.2`
- **Title**: `TETHERACT pm v1.2.2 - Unified Custom Confirmation & Folder Diff Modals, Large DB Migration Startup Wait & UI Polish`
- **Date**: `2026-11-03`

---

> [!WARNING]
> **【重要】v1.2.x データベース構造刷新に伴う後方互換性に関するご注意 / Important Notice on Database Backward Compatibility**
>
> - **自動バックアップの作成**: v1.1.1 以前の環境から v1.2.x へ初回アップデートして起動する際、マイグレーション実行前に既存のデータベースが `cache/backups/library_pre_ideal_photo_links_v1_<日時>.db` として**自動バックアップ**されます。
> - **旧バージョンとの後方互換性なし**: v1.2.x ではデータベース構造（`photos`・`photo_links`・`thumbnails`・`photo_tags`）を抜本的に刷新しているため、**v1.2.x で自動変換された後の `cache/library.db` を v1.1.1 以前の旧バージョンで開くことはできません（後方互換性はありません）**。万が一旧バージョンへ戻す場合は、`cache/backups/` 内のバックアップファイルを `cache/library.db` に戻してご利用ください。
> - **Automatic Pre-Migration Backup & No Backward Compatibility**: When upgrading from v1.1.1 or earlier to v1.2.x, your existing database is automatically backed up to `cache/backups/library_pre_ideal_photo_links_v1_<timestamp>.db` before migration. Because v1.2.x introduces a fundamental database schema overhaul, **the migrated `cache/library.db` is NOT backward-compatible with v1.1.1 or earlier**. If you ever need to downgrade, restore the backup file from `cache/backups/` to `cache/library.db`.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.2.2diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれ、安全に新DB構造へ統合マイグレーションされます）。
> - **初回導入（フル版 `Tetheract_v1.2.2.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.2.2diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. フォルダ更新（差分検出）・消失写真リンク解除 ＆ 全確認ダイアログのカスタムモーダル統一（v1.2.2）
- **管理下フォルダの更新（差分検出）モーダル刷新**: 管理下のフォルダを左クリックした際に変更（新規・消失子フォルダ、追加・削除・変更ファイル）が検出された場合、これまでブラウザ標準の素っ気ない `confirm()` ダイアログが出ていた箇所を、「フォルダの管理登録」モーダル（`#registerFolderModal`）と同じデザインの**カスタム確認モーダル（`#commonConfirmModal`）**に統一しました。フォルダ名・フルパスとともに、変更内訳（`新規フォルダ` / `消失フォルダ` / `新規追加` / `削除・消失` / `変更・更新`）を色分けドット付きのカードで見やすく表示し、`Enter` キーで即座にリフレッシュ（最新化）、`Esc` キーで「あとで」を選べます。
- **消失写真のリンク解除モーダル刷新**: 削除・移動により実体ファイルが見つからない写真がある場合のリンク解除確認も、枚数と「サムネイル・タグ・評価はそのまま保持される」旨を明示した同デザインのカスタムモーダルに刷新しました。
- **アプリ全体の確認・通知ダイアログの統一**: フォルダ右クリックメニュー（リフレッシュ / AIタグ付け / AIカラータグ再判定 / 管理解除 / 除外設定 / ドライブ全体スキャン確認）、登録メディア（SDカード等）の管理解除、リンク消失写真の一括完全消去、XMPサイドカーの評価・タグ取り込み、単一・一括ジオタグ削除、スマホGPS一括準用、選択写真のライブラリ削除、保存済みフィルタセット削除、storage空フォルダ削除、テイクアウト処理中の画面クローズ確認をすべて統一デザインのカスタムモーダル（日英リアルタイム切替対応）へ置き換え、残っていた `alert()` もすべてトースト通知へ統一しました。

### 2. 大規模DBマイグレーション実行時の起動待機時間延長によるブラウザ接続エラー防止（v1.2.2）
- **サーバー起動待機の延長（最大180秒）**: 数万枚規模のライブラリで初回起動時のDBスキーマ移行・事前バックアップ作成・自己修復処理に10秒以上かかった際、マイグレーション完了前にブラウザウィンドウが開いて「接続が拒否されました（`ERR_CONNECTION_REFUSED`）」と表示される問題を解消しました。`run.py` / `server/run.py` のポートOpen待機上限を最大180秒まで拡大し、バックグラウンドのマイグレーション完了後に自動でアプリ画面が開くよう改善しました。

### 3. （v1.2.0〜v1.2.1 からの主要改善ハイライト）
- **安全なDBマイグレーション ＆ 事前バックアップからの自動復元**: `photos` テーブル再構築時の外部キー連動削除（`ON DELETE CASCADE`）を完全遮断してタグ・サムネイルを100%保護するとともに、初版 v1.2.0 起動済み環境でも `cache/backups/` から自動復元する自己修復マイグレーションを搭載しています。
- **ユニーク画像エンティティ（`photos`）と実ファイル所在リンク（`photo_links`）の分離**: 複数フォルダ・複数メディア間の重複写真を1エンティティに統合し、一覧表示・サムネイル描画・タグ読込の高速化とメディア横断のスマート・リンクライフサイクルを実現しています。

---

## English

### 1. Unified Custom Confirmation Modals for Folder Diff Refresh, Unlinking & App-Wide Actions (v1.2.2)
- **Redesigned Folder Update (Diff Detection) Modal**: Replaced the native browser `confirm()` dialog when clicking a managed folder with detected changes with a custom modal (`#commonConfirmModal`) matching the sleek design of `#registerFolderModal`. Displays the folder name, monospace path, and a color-coded breakdown card (`Added Folders`, `Missing Folders`, `Added Photos`, `Missing / Moved`, `Modified`), with full keyboard support (`Enter` to refresh, `Esc` to dismiss).
- **Redesigned Missing Photo Unlink Modal**: Replaced the native follow-up confirmation for unlinking missing files with the same custom modal design, clearly reassuring users that cached thumbnails, tags, and ratings are preserved.
- **App-Wide Native Dialog Elimination**: Unified all remaining `confirm()` and `alert()` dialogs across folder context menus (Refresh, AI Auto-Tag, AI Color Re-evaluation, Unmanage, Ignore, Full Drive Scan), Registered Media unmanagement, Purge Unlinked Photos, XMP Sidecar import, Single/Batch Geotag clear & Phone GPS inference, Batch Photo removal, Saved Filter Preset deletion, empty `storage` subfolder deletion, and Smart Takeout close confirmation into the custom modal and toast notification system with full JP ⇄ EN real-time translation support.

### 2. Extended Startup Port Readiness Wait for Large Database Migrations (v1.2.2)
- **Up to 180s Startup Wait**: Fixed an issue where upgrading a large library (tens of thousands of photos) took longer than 10 seconds to complete pre-migration backup and schema migration, causing the browser window to open prematurely with `ERR_CONNECTION_REFUSED`. `run.py` and `server/run.py` now wait up to 180 seconds for the server port to start listening before launching the browser window.

### 3. Key Highlights from v1.2.0–v1.2.1
- **Zero-Loss Schema Migration & Self-Healing Backup Recovery**: Prevents SQLite `ON DELETE CASCADE` during table rebuilds and automatically restores any tags/thumbnails from `cache/backups/` if v1.2.0 was previously run.
- **Deduplicated Photo Entities (`photos`) & Multi-Media Location Links (`photo_links`)**: Stores unique photos once while tracking multiple physical locations across folders and external media in `photo_links`.
