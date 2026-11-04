# TETHERACT pm v1.6.0 Release Notes

- **Tag**: `v1.6.0`
- **Title**: `TETHERACT pm v1.6.0 - High-Speed Parallel Loome File Copy, NeXTSTEP-Style Cascading Context Menu & Folder Diff Refinements`
- **Date**: `2026-11-04`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.6.0diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.6.0.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.6.0diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. `Loome` への超高速ファイルコピー・エクスポート実装（Win32 `CopyFileExW` ＋ ドライブ種別自動並列化 ＋ EXIF再解析スキップ）
- **Win32 ネイティブ `CopyFileExW` とドライブ種別に応じた並列スレッド自動調整**: Windows カーネル API `CopyFileExW`（GIL解放）とマルチスレッド並列コピーを導入し、コピー元・コピー先のドライブ種別（NVMe/SSD・リムーバブルSDカード/USB・HDD・ネットワークドライブ）を自動判定して最適ワーカー数（SSD間は並列4スレッド、SDカードや同一HDDはヘッドシークやコントローラ詰まりを防ぐ直列1スレッド）で高速転送します。
- **EXIF再解析スキップ ＆ 単一トランザクションDB登録 ＆ O(1) ファイル名採番**: すでにライブラリ登録済みの写真を `Loome` へコピーする際、重い EXIF 再解析（`extract_metadata`）とサムネイル再生成を完全にスキップし、既存のメタデータ辞書を引き継いで単一の SQLite トランザクションで一括登録するよう刷新しました。また、コピー先フォルダの既存ファイル一覧とサイドカー一覧を `os.scandir` で事前キャッシュすることで、数百枚のコピー・移動・外部エクスポートも一瞬で完了します。

### 2. NeXTSTEP 風味の右展開カスケード階層コンテキストメニュー（`Loomeへコピー ▶` / `Loome内で移動 ▶`）
- **マウスオーバーで右へ次々と展開する階層パネル**: 写真の右クリックメニューに `📦 Loome 保管庫操作` セクション（セパレーター＆小キャプション付き）を設け、「Loomeへコピー ▶」「Loome内で移動 ▶」から保存先ドライブ（本体 `Loome` や外部ドライブの `Loome`）にマウスオーバーすると、右隣へドライブ内サブフォルダ階層・孫フォルダ階層が次々とカスケード展開されます。
- **ゆったりした縦幅・高コントラスト強調表示・その場でのサブフォルダ作成**: ドライブ行・フォルダ行の縦幅とホバー強調表示を刷新し、各階層パネルでの「📥 ここ（直下）へコピー / 移動」のワンクリック実行や、パネル下部の入力欄からの新規サブフォルダ作成＆即時コピー／移動に対応しました。

### 3. フォルダ差分検知・全削除リフレッシュ時のリンク整理精度向上
- **空フォルダ化した管理フォルダのリフレッシュ時リンク整理**: 写真を `Loome` 等へコピーしたあとに元のフォルダ（`Screenshots` 等）の中身をすべて削除してリフレッシュした際、同一物理ドライブ（VSN一致）や明示的リフレッシュ時に「別フォルダへの移動」と誤判定されて古いパスリンクが残ってしまう問題を修正し、空になったフォルダのリンクと残留メディア表示が確実にクリーンアップされるよう改善しました。
- **空のサブフォルダ（写真0枚）が存在する `Loome` / 管理フォルダでの変更誤検知防止**: `Loome` 等にまだ写真が0枚の空サブフォルダを作成した際、フォルダをクリックするたびに毎回「変更を検知しました」が表示され続ける不具合を修正しました。また、ウィンドウのフォーカス復帰時に現在表示中のフォルダの差分チェックも自動で行われるよう改善しました。

---

## English

### 1. High-Speed Parallel File Copy & Export for `Loome` (Win32 `CopyFileExW` + Auto-Tuned Concurrency + Zero Re-Parsing)
- **Native Win32 `CopyFileExW` with Drive-Aware Worker Scaling**: Combines GIL-releasing Win32 `CopyFileExW` with automatic drive-type detection (`GetDriveTypeW`), running 4 parallel copy workers on SSDs while serializing to 1 worker on removable SD cards, USB flash drives, or same-spindle HDDs to prevent I/O contention.
- **Zero EXIF Re-Parsing & Single-Transaction DB Commit**: Copying registered photos into `Loome` now reuses existing DB metadata without re-running `extract_metadata()` or regenerating thumbnails, committing all `photo_links` in a single SQLite transaction with $O(1)$ pre-scanned filename and sidecar resolution.

### 2. NeXTSTEP-Inspired Right-Expanding Cascade Context Menu (`Copy to Loome ▶` / `Move in Loome ▶`)
- **Multi-Level Hover Cascade Panels**: Hovering over a target `Loome` drive in the right-click menu expands a clean NeXTSTEP-style cascading panel to the right, allowing you to drill down through subfolders, copy/move directly to any folder root, or create a new subfolder on the fly.

### 3. Folder Diff Detection & Orphan Link Cleanup Refinements
- **Accurate Link Cleanup When Emptying Source Folders**: Fixed an issue where emptying a source folder after copying its photos to `Loome` on the same physical volume could leave stale path links behind after a folder refresh.
- **No False-Positive Diff Alerts on Empty Subfolders**: Fixed a bug where empty subfolders (0 images) inside `Loome` or managed folders triggered a false "Changes detected" prompt on every click.
