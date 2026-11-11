# TETHERACT pm v1.8.8 Release Notes

- **Tag**: `v1.8.8`
- **Title**: `TETHERACT pm v1.8.8 - Sony α RAW (.ARW) Preview/Thumbnail/EXIF Extraction Fix & Automatic Re-Extraction on Refresh`
- **Date**: `2026-11-11`

---

> [!CAUTION]
> **⚠️【重要】v1.7.0 以降を起動すると、旧バージョン（v1.6.1以前）との後方互換性がなくなります（特に差分アップデートの場合）**
>
> - **v1.7.0 以降で一度でも起動したデータベース（`cache/library.db`）には新しいセキュリティ＆エシカル保護スキーマが自動適用されるため、それ以降は v1.6.1 以前の旧バージョンでは起動できなくなります。**
> - 万が一 v1.6.1 以前へ戻す可能性がある場合は、アップデート前にあらかじめ `cache/library.db` を別場所へコピーしてバックアップしておくことを推奨します。
>
> **⚠️ [IMPORTANT] Launching v1.7.0+ Removes Backward Compatibility with Older Versions (v1.6.1 or Earlier)**
> - Once launched in v1.7.0+, `cache/library.db` is upgraded to the new security & ethical protection schema and **can no longer be opened or launched by v1.6.1 or earlier**.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.8.8diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.8diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.8diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.8.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.8diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.8diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. SONY α RAW (`.ARW`) のプレビューJPEG・サムネイル・EXIFメタデータ抽出の完全修正（v1.8.8）
- **TIFF IFD 構造解析によるプレビューJPEG・EXIF・回転方向（Orientation）の直接抽出（`server/raw_loader.py`）**:
  - SONY α（α7 IV, α7R V, α7C II, α7CR, α6700, ZV-E1, α1 II 等）のロスレス圧縮RAW（M / S サイズ）および最新ボディで `rawpy` (LibRaw) が非対応エラーを返す場合でも、TIFF IFD（`IFD0` / `SubIFD` / `ExifIFD` / `MakerNote` / `IFD1`）を直接走査してカメラ現像済みフルサイズプレビューJPEG・センサー解像度・回転方向（Orientation）・EXIF/GPS情報を100%正確に抽出できるよう修正しました。
  - プレビューJPEGの `APP1 (EXIF)` ヘッダ内にある極小サムネイル（160×120）の終端マーカーや、RAWセンサーデータ内のランダムバイト列への誤一致によってプレビュー抽出・JPEG書き出し・サムネイル生成が失敗していた不具合を解消しました。
- **OneDrive 配下フォルダ（Windows 標準の「ピクチャ」「デスクトップ」等）でのローカル保存済みRAWの誤スキップ解消（`server/shell_thumbnail.py`）**:
  - ローカルに実体がある OneDrive 管理下フォルダで `FILE_ATTRIBUTE_REPARSE_POINT` によりクラウド未同期ファイルと誤判定され、Windows に RAW 拡張機能がない環境で `.ARW` のサムネイル生成がスキップされていた問題を修正しました。
- **ポータブルPythonへの VC++ / OpenMP ランタイムDLL同梱**:
  - Visual C++ 再頒布可能パッケージ未導入のクリーンなWindows環境でも `rawpy` が確実に動作するよう `msvcp140.dll` / `vcomp140.dll` を同梱しました。

### 2. フォルダ「リフレッシュ（再スキャン）」による既存RAWレコードの自動再取得（v1.8.8）
- **未取得RAWレコードの自動検知とメタデータ・サムネイル再生成（`server/database/photos.py` / `server/scanner.py`）**:
  - 過去に抽出失敗状態でDBへ登録されたRAW写真（解像度 `0×0`、カメラ機種名 `RAW写真`、またはサムネイル未生成／200px以下の極小サムネイル）について、ファイルサイズや更新日時が変わっていなくてもフォルダの「リフレッシュ」を実行するだけで、既存の星評価・タグ・非破壊調整を維持したままEXIFメタデータと高画質サムネイルを自動再取得するよう改善しました。

---

## English

### 1. Complete Fix for Sony α RAW (`.ARW`) Preview JPEG, Thumbnail & EXIF Metadata Extraction (v1.8.8)
- **Native TIFF IFD Parser for Camera-Developed Preview JPEG, EXIF & Orientation (`server/raw_loader.py`)**:
  - Directly parses TIFF `IFD0` / `SubIFD` / `ExifIFD` / `MakerNote` / `IFD1` structures to extract the full-resolution embedded preview JPEG, sensor dimensions, EXIF/GPS metadata, and Orientation even when `rawpy` (LibRaw) rejects Sony Lossless Compressed RAW (M / S) or newer α bodies.
  - Eliminated false-positive EOI truncation caused by nested 160×120 EXIF thumbnails inside `APP1` segments and random `0xFFD8`..`0xFFD9` byte sequences inside RAW sensor data.
- **Fixed False-Positive Cloud Placeholder Skip on Locally Stored OneDrive Folders (`server/shell_thumbnail.py`) & Bundled Runtime DLLs**:
  - Fixed an issue where locally synced files inside Windows OneDrive folders (`Pictures`, `Desktop`, etc.) were skipped due to `FILE_ATTRIBUTE_REPARSE_POINT` when Windows lacked a shell RAW codec, and bundled `msvcp140.dll` / `vcomp140.dll` in portable `python/`.

### 2. Automatic Re-Extraction of Previously Failed RAW Records on Folder Refresh (v1.8.8)
- **Smart Re-Scan Detection (`server/database/photos.py` / `server/scanner.py`)**:
  - Existing RAW records with missing metadata (`0×0` dimensions or generic `RAW写真` model) or missing/tiny (`<=200px`) thumbnails are now automatically re-parsed and regenerated when running Folder Refresh, while preserving all existing ratings, tags, and non-destructive adjustments.
