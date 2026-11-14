# ポータブルストレージ・所在リンク・専用保管庫 `Loome` ＆ XMPサイドカー設計

本ドキュメントは、Tetheract Photo Manager のポータブルパス解決（VSN追跡）、ユニーク画像エンティティ（`photos` / `photo_links`）の正規化設計、SQLite BLOBサムネイル構造、専用保管庫 `Loome` のファイル管理、および `server/sidecar.py` によるサイドカー・XMP非破壊連携仕様を定義する。

---

## 1. ドライブ識別（VSN）と動的パス解決

### 1.1 ボリュームシリアル番号による個体識別 (`server/volume_info.py`)
ドライブレター（`D:`, `E:` 等）は接続PCや差し替え順で変動するため、Windows API `GetVolumeInformationW`（`ctypes` 呼び出し）で物理ドライブ固有の **ボリュームシリアル番号（VSN）** とボリュームラベルを取得し、`volumes` および `scan_roots` テーブルに記録する。
なお、Google Drive 等の全環境共通の仮想VSN（`19831116` 等）は `SHARED_VIRTUAL_VSNS` として物理個体識別対象から除外する。

### 1.2 ポータブルパス解決 (`server/scanner.py` — `resolve_portable_path`)
実写真ファイルへのアクセス時はハードコード絶対パスを直接開かず、必ず `resolve_portable_path(stored_path, expected_serial=volume_serial)` を経由する：
1. **アプリ内 `Loome/`・`storage/` 配下**: 実行中アプリ自身の相対ディレクトリで解決する。
2. **VSN指定ありのリムーバブル／ローカルドライブ**: 現在接続中のドライブ群から一致する VSN を探し、同一相対パスで解決する（該当VSNが未接続ならオフラインと判定し、同じドライブレターに挿さった別SDカード等への誤一致を防ぐ）。
3. **VSN未指定・UNC／ネットワークパス**: 元パス実在確認 → 現在ドライブ上の相対パス → クラウド同期フォルダ → `photos/` 直下の順でフォールバック解決する。

---

## 2. ユニーク画像 (`photos`) と複数所在リンク (`photo_links`) の分離

複数フォルダや複数メディア（SDカード、内蔵SSD、外付けバックアップ）に同一写真が存在しても、`photos` テーブルにはユニーク画像1行のみを保持し、物理ファイルの所在を `photo_links`（`UNIQUE(volume_serial, rel_path)`）で1対多管理する（`server/database/photos.py`, `server/database/duplicates.py`）。

- **同一画像識別キー (`content_key`)**:
  - Exif撮影日時あり：`original_date_taken`（日時シフト後も不変）・`file_size`・`is_raw`・`subsec_time`・`shutter_speed`・`f_number`・`iso`・`exposure_bias` の組み合わせで一意化する。
  - Exif撮影日時なし（SNS保存画像・スクリーンショット等）：ファイル中間4箇所（20/40/60/80%位置の各4KB）＋末尾4KB＋サイズから算出する **BLAKE2b 64-bit サンプリングハッシュ**（`compute_image_body_sample_hash()` in `server/raw_loader.py`）を用い、`mtime` 変化で別画像に分裂するのを防ぐ。
- **スマート・リンクライフサイクル**:
  1. **部分消失**: 複数リンクのうち片方のメディアから削除された場合は該当 `photo_links` 行のみを除去し、残存リンクを `is_primary = 1` に昇格して通常表示を維持する。
  2. **完全消失 (`is_unlinked = 1`)**: 全リンクが0本になった場合のみ `file_path = 'unlinked://<id>/<file_name>'`, `directory_path = '__unlinked__'`, `volume_serial = NULL`, `is_unlinked = 1` へ移行し、評価・タグ・調整・サムネイルを保護する（明示的な完全消去は `POST /api/photos/purge-unlinked` のみ）。
  3. **再発見時の自動復帰**: 別メディアや移動先で同一 `content_key` が再スキャンされると、既存の `photo_id` に新リンクが張り直され `is_unlinked = 0` へ自動復帰する。
- **消失フォルダ検知**: VSN一致ドライブが接続中であるにもかかわらず対象フォルダが存在しない場合は「オフライン」ではなく「消失」と判定し、再スキャン（`cleanup_orphans=True`）または `[リンク消去]`（`POST /api/folders/unlink-missing`）で配下リンクを整理する。

---

## 3. SQLite BLOB サムネイル ＆ クラスタ化スキーマ (`server/database/schema.py`)

USBメモリ（exFAT等）での微小ファイル大量生成によるI/O劣化とバックアップ遅延を防ぐため、サムネイルWebPバイナリはすべて `cache/library.db` 内に格納する。

- **`thumbnails` テーブル**: `photo_id INTEGER PRIMARY KEY` による ROWID 直結1発ルックアップ構造。一覧クエリで寸法のみ参照する際は BLOB 本体ページを読まないカバリングインデックス `idx_thumbnails_dims(photo_id, width, height)` を使用する。
- **`photo_tags` テーブル**: `PRIMARY KEY (photo_id, tag) WITHOUT ROWID` により同一写真のタグ行を物理隣接配置する。
- **基本PRAGMA (`server/database/connection.py`)**: `journal_mode = WAL`, `cache_size = -16000` (16MB), `mmap_size = 268435456` (256MB), `synchronous = NORMAL`, `temp_store = MEMORY`。

---

## 4. 専用保管庫 `Loome` 完結管理 (`server/storage_manager.py`, `server/storage_folder_import.py`)

一般フォルダの写真には「元ファイル・元フォルダへの書き込みゼロ」を厳守する一方、専用保管庫 **`Loome`**（本体内 `Loome/` または `storage/`、および外付けドライブ直下の `<Drive>:\Loome`）内の写真に限り、アプリUI上から実ファイル整理を完結できる（選択UIは `frontend/js/loome_picker.js` および `frontend/js/storage.js`）。

1. **取り込み (`POST /api/photos/import-to-storage` / フォルダ取込)**: 選択写真やフォルダを `Loome/<サブフォルダ>` へコピー（Windows環境の大容量ファイルは `server/sidecar.py` の `fast_copy_file` による `CopyFileExW` 高速転送）し、評価・非破壊調整・GPS・タグを引き継ぐ。
2. **サブフォルダ移動 (`POST /api/storage/move-photos`)**: `Loome` 内のサブフォルダ間物理移動（D&D対応）を行い、`photo_id` とサムネイルを維持したままDBパスを更新する。
3. **単一・一括連番リネーム (`POST /api/storage/rename-photo`, `batch-rename-photos`)**: `Loome` 内写真のみ `F2` キーを有効化し、一時ファイル経由の2パス方式で名前衝突を防ぎながらリネームする。
4. **外付け `Loome` 作成 (`POST /api/storage/create-external-loome`)**: 接続中ドライブ直下に `<Drive>:\Loome` と電子刻印 `.loome_seal` を作成する。

---

## 5. サイドカー自動追従 ＆ XMP非破壊連携 (`server/sidecar.py`)

### 5.1 付随サイドカーとペアRAWの自動追従
現像ソフトが出力するサイドカー（`SIDECAR_EXTENSIONS`: `.xmp`, `.pp3`, `.arp`, `.dop`, `.on1`, `.cos`, `.nksc`, `.spd`）を `find_sidecars_for_file()`（`<stem>.<ext>` および `<filename>.<ext>` 両対応）で検出し、`Loome` へのコピー・移動・リネーム・外部エクスポート時にペアRAWともども自動追従させる（リネーム時は `.xmp` 内の `crs:RawFileName` も同期更新する）。

### 5.2 XMP非破壊プレビューと隔離取り込み（「混ぜない・壊さない・比較できる」）
- **XMPホールド比較 (`parse_xmp_for_photo` + `GET /api/photo/{photo_id}/xmp-preview`)**:
  - `.xmp` の Camera Raw 系パラメータ（露光量・コントラスト・彩度・クロップ・角度・Orientation）を解析し、右インスペクタの「XMPプレビュー」を押している間だけオンデマンドWebPで比較表示する（DBは無変更）。
- **評価・階層タグの安全取り込み (`POST /api/photo/{photo_id}/xmp-import`, `POST /api/photos/batch-xmp-import`)**:
  - **現行4段階評価へのマッピング**: `pm:rating`（`2 / 1 / 0 / -1`）があれば優先採用し、標準 `xmp:Rating` の場合は `4〜5` → `2`（優）、`3` → `1`（良）、`0〜2` → `0`（可）、`-1以下` → `-1`（棄）へ変換する。
  - **タグの `XMP/` ルート隔離**: `lr:hierarchicalSubject` や `dc:subject` はすべて **`XMP/親/子`** のように `XMP/` プレフィックス配下へ格納し、既存の手動タグツリーと混在させない。
- **スマート・テイクアウト時の `.xmp` 同時書き出し (`write_xmp_sidecar_for_photo`)**:
  - 書き出し時にオプションを有効にすると、評価（`pm:rating` ＆ `xmp:Rating`）、`XMP/` プレフィックスを除いた階層タグ、GPS座標、非破壊調整値を Lightroom / Camera Raw 互換 `.xmp` として同時出力する。
