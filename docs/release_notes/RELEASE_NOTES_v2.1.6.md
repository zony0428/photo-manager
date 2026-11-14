# Release Notes - v2.1.6

- **Tag**: `v2.1.6`
- **Title**: `TETHERACT pm v2.1.6 - SONY α RAW (.ARW) のプレビューJPEG・サムネイル・EXIF抽出不具合の完全修正とリフレッシュ自動再取得対応`
- **Release Date**: `2026-11-11`

---

## 🔧 不具合修正・改善内容 (Bug Fixes & Improvements)

### 1. SONY α RAW (`.ARW`) のプレビューJPEG・サムネイル・EXIFメタデータ抽出の完全修正
- **TIFF IFD 構造解析によるプレビューJPEG直接抽出 (`server/raw_loader.py` / `SafUsbManager.kt` / `PhoneCaseManager.kt`)**:
  - SONY α（α7 IV, α7R V, α7C II, α7CR, α6700, ZV-E1, α1 II 等）のロスレス圧縮RAW（M / S サイズ）および最新ボディで `rawpy` (LibRaw) が非対応エラーを返す場合でも、TIFF IFD（`IFD0` / `SubIFD` / `ExifIFD` / `MakerNote` / `IFD1`）を直接走査してカメラ現像済みフルサイズプレビューJPEG・センサー解像度・回転方向（Orientation）・EXIF/GPS情報を100%正確に抽出できるよう修正しました。
  - プレビューJPEGの `APP1 (EXIF)` ヘッダ内にある極小サムネイル（160×120）の終端マーカーや、RAWセンサーデータ内のランダムバイト列への誤一致によってプレビュー抽出・JPEG書き出し・サムネイル生成が失敗していた不具合を解消しました。
- **OneDrive 配下フォルダ（Windows 標準の「ピクチャ」「デスクトップ」等）でのローカル保存済みRAWの誤スキップ解消 (`server/shell_thumbnail.py`)**:
  - ローカルに実体がある OneDrive 管理下フォルダで `FILE_ATTRIBUTE_REPARSE_POINT` によりクラウド未同期ファイルと誤判定され、Windows に RAW 拡張機能がない環境で `.ARW` のサムネイル生成がスキップされていた問題を修正しました。
- **ポータブルPythonへの VC++ / OpenMP ランタイムDLL同梱**:
  - Visual C++ 再頒布可能パッケージ未導入のクリーンなWindows環境でも `rawpy` が確実に動作するよう `msvcp140.dll` / `vcomp140.dll` を同梱しました。

### 2. フォルダ「リフレッシュ（再スキャン）」による既存RAWレコードの自動再取得 (`server/database/photos.py` / `server/scanner.py`)
- 過去に抽出失敗状態でDBへ登録されたRAW写真（解像度 `0×0`、カメラ機種名 `RAW写真`、またはサムネイル未生成／200px以下の極小サムネイル）について、ファイルサイズや更新日時が変わっていなくてもフォルダの「リフレッシュ」を実行するだけで既存の星評価・タグ・非破壊調整を維持したままEXIFメタデータと高画質サムネイルを自動再取得するよう改善しました。
