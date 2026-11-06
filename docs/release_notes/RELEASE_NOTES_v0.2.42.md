# Photo Manager v2.42 リリースノート

- **Tag**: `v2.42`
- **Title**: `Photo Manager v2.42 — 📦 アプリ内ストレージ(storage)完結管理・👁️ XMPホールドプレビュー＆サイドカー追従`
- **Release Date**: `2026-10-25`

---

## 🎉 What's New in v2.42 (日本語)

### 1. 📦 アプリ内ストレージ（`storage/`）完結管理＆旧 `carry/` 自動移行
- 従来の `carry/` フォルダを **`storage/`（アプリ内ストレージ）** へ刷新しました（起動時に既存の `carry/` 内ファイルとDBパスを自動で `storage/` へ安全に移行します）。
- **アプリ内で完結するフォルダ・ファイル整理**:
  - 左サイドバーの `📦 storage` ツリー右クリックから **新規サブフォルダ作成・フォルダ名変更・空フォルダ削除・外部フォルダへの丸ごとエクスポート** が可能になりました。
  - グリッド上の写真を左ペインの `storage` サブフォルダへ **ドラッグ＆ドロップ**（または右クリックメニュー）で直感的にフォルダ間移動できます。
  - **単一リネーム (`F2`)** および **`{date}_{seq}` 等のテンプレート連番一括リネーム** に対応しました。

### 2. 🔗 XMP等のサイドカーファイル＆ペアRAWの自動追従
- `storage` 内での写真移動・リネーム・外部エクスポート、および「📤 スマート・テイクアウト」実行時に、同名のサイドカーファイル（`.xmp`, `.pp3`, `.dop`, `.arp`, `.cos`, `.on1` 等）やペアRAWファイルを自動で検出し、ベース名を揃えて一緒に移動・リネーム・コピーします。

### 3. 👁️ XMPサイドカー非破壊連携＆「ホールド比較プレビュー」
- **Exif欠落時のXMPメタデータ自動補完**: カメラ名・レンズ名・ISO・F値・シャッター速度・撮影日時がExifから欠落している場合、同名の `.xmp` から自動補完します。
- **押している間だけ反映する「👁️ XMPプレビュー」ボタン**:
  - 右インスペクタの「📄 XMPサイドカー連携」セクションにて、`👁️ XMPプレビュー (押している間反映)` ボタンをホールドしている間だけ、Lightroom / Camera Raw 等の編集パラメータ（露光量・コントラスト・ハイライト・シャドー・白レベル・黒レベル・色温度・彩度・回転・クロップ等）をプレビュー画像にリアルタイム反映し、離すと元画像に戻る直感的なBefore/After比較が可能です。
- **XMP評価・階層タグの安全な取り込み**:
  - XMP内の星評価を Photo Manager の4段階評価（`★4〜5 → 優(2)`, `★2〜3 → 良(1)`, `★0〜1 → 未評価(0)`, `Reject(-1) → 棄(-1)`）に変換して取り込めます。
  - XMP内の階層キーワード（`lr:hierarchicalSubject` / `dc:subject`）は、既存タグツリーを汚さないようすべて **`XMP/...`** ルート配下に隔離して取り込みます。

---

## 🌍 Release Notes in English (v2.42)

1. **📦 Self-Contained Internal `storage/` Management**:
   - Upgraded `carry/` to `storage/` with automatic migration on startup. Create/rename/delete subfolders, move photos via Drag & Drop, single/batch rename (`F2`), and export folders to external drives.
2. **🔗 Automatic Sidecar & Paired RAW Tracking**:
   - Moving, renaming, or exporting photos automatically keeps `.xmp`, `.pp3`, `.dop`, and paired RAW files in sync.
3. **👁️ Hold-to-Compare `.xmp` Preview & Metadata Integration**:
   - Hold down **`👁️ XMP Preview`** in the right inspector to preview Adobe Camera Raw / Lightroom adjustments (exposure, contrast, highlights, shadows, temperature, tint, saturation, crop/angle) non-destructively, and import XMP ratings or hierarchical keywords under the isolated `XMP/...` root tag.
