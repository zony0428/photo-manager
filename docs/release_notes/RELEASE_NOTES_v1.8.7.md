# TETHERACT pm v1.8.7 Release Notes

- **Tag**: `v1.8.7`
- **Title**: `TETHERACT pm v1.8.7 - 90°/270° Rotated Zoom Metrics, Full Stack Sub-Photo Metadata & Mobile Adjustments API`
- **Date**: `2026-11-10`

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
> - **既存環境（軽量差分版 `Tetheract_v1.8.7diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.7diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.7diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.7.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.7diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.7diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 90° / 270° 回転写真およびトリミング済み写真のフィット枠・拡大率（`%`）計算の精緻化（v1.8.7）
- **ライトボックス・2枚比較ビュー・モバイルビューアでの 90° / 270° 回転時のアスペクト比整合**:
  - 90° または 270° 回転された写真において、サーバー側で回転焼き込み済みの画像（またはサムネイル）を表示する際のメタデータ寸法（`width` / `height`）の縦横入れ替え、およびCSS回転適用時のビューポート境界（`maxW` / `maxH`）の縦横入れ替えに対応し、回転写真でも歪みや見切れなく正確な原本1:1基準の拡大率（`%`）で表示されるよう改善しました。

### 2. スタック内サブ写真の非破壊調整値・Exif情報の完全取得とモバイル一括操作・調整APIの強化（v1.8.7）
- **スタック内サブ写真（連写・ブラケット・RAW+JPEG）の調整値・Exifカラム補完**:
  - `get_photos()` および `get_photo_by_id()` が返す `stack_photos` に、各サブ写真の非破壊調整値（`rotation`, `fine_angle`, `brightness`, `contrast`, `saturation`, `crop_*`）および `iso`, `focal_length`, `content_key` をすべて含めるよう拡張しました。
- **非破壊調整更新時の高速メモリキャッシュ即時無効化と `/api/photo/{id}/adjustments` エンドポイント追加**:
  - 回転・トーン調整・リセット時に `photos` テーブルの高速メモリキャッシュおよび `/api/photos` レスポンスキャッシュを即時無効化するよう改善し、既存の90度回転・クロップ範囲を保持したままトーン・水平傾きを更新する `/api/photo/{id}/adjustments` API および LAN ホワイトリストを追加しました。
- **モバイル `localdb` モードでの一括評価・一括タグ付け時の詳細ロード保証**:
  - オフライン `localdb` モードで閲覧前の写真を複数選択して一括評価・一括タグ付けした際にも、`ensureLocalPhotoDetails()` を事前実行して既存タグやメタデータが欠落しないよう修正しました。

---

## English

### 1. Accurate Fit & Original-Pixel (`100%`) Zoom Metrics for 90° / 270° Rotated & Cropped Photos (v1.8.7)
- **Aspect-Ratio Alignment for 90° / 270° Rotated Photos Across Lightbox, Compare View, and Mobile Viewer**:
  - Properly swaps fallback metadata dimensions (`width` / `height`) when displaying server-baked rotated images/thumbnails and swaps viewport fit bounds (`maxW` / `maxH`) when applying CSS 90°/270° rotation, preventing aspect-ratio distortion or clipping.

### 2. Full Non-Destructive Adjustment & Exif Columns for Stack Sub-Photos and Mobile Adjustments API (v1.8.7)
- **Complete Stack Member Metadata**:
  - Included `rotation`, `fine_angle`, `brightness`, `contrast`, `saturation`, `crop_*`, `iso`, `focal_length`, and `content_key` in `stack_photos` queries across `get_photos()` and `get_photo_by_id()`.
- **Immediate Cache Invalidation & `/api/photo/{id}/adjustments` Endpoint**:
  - Added immediate fast-cache invalidation across all adjustment/rotation updates and introduced `POST /api/photo/{id}/adjustments` (preserving existing 90° rotation and crop bounds while updating tone and fine angle).
- **Mobile `localdb` Batch Rating & Tagging Detail Guard**:
  - Ensured `ensureLocalPhotoDetails()` runs prior to recording pending changes during batch rating and batch tagging in `localdb` mode.
