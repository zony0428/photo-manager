# TETHERACT pm v1.8.6 Release Notes

- **Tag**: `v1.8.6`
- **Title**: `TETHERACT pm v1.8.6 - Original-Pixel Zoom Ratio & Crisp Full-Res Rendering Without Texture Upscaling Mosaic`
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
> - **既存環境（軽量差分版 `Tetheract_v1.8.6diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.6diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.6diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.6.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.6diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.6diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. ライトボックス・2枚比較ビュー・モバイルビューアの拡大時モザイク化解消と原本1:1基準の拡大率（`%`）表示（v1.8.6）
- **CSS `scale()` による縮小キャンバス引き伸ばし（モザイク化）を根本排除**:
  - 画面フィット枠（`max-width: 100%; max-height: 80vh` / `100%`）に収めた `<img>` に対して CSS `transform: scale(zoom)`（および `will-change: transform`）で拡大していたため、ブラウザが初期の縮小フィット枠でラスタライズしたGPUテクスチャをそのまま引き伸ばしてモザイク状になっていた問題を修正しました。
  - ズーム倍率に応じて `<img>` 要素自体の実レイアウト寸法（`width` / `height`）を直接ピクセル指定し、移動のみ `translate` する方式へ全面刷新したことで、どの拡大率でも常に原本フル解像度から直接デコード・高精細描画されるようになりました。
- **原本ピクセル（1:1等倍＝`100%`）基準の拡大率表示 ＆ ダブルクリック等倍（`100%`）トグル**:
  - 初期の画面フィット状態を縮小率（例: `25% (FIT)`）として正しく表示し、ダブルクリック（モバイルはダブルタップ）で **全体フィット（縮小 `%`） ⇄ 原本1:1等倍（`100% (等倍)`）** をワンタッチで切り替えられるよう統一しました（マウスホイールでは最大原本 `300%` まで拡大可能）。

### 2. 外付け・内蔵 `Loome` 等のセカンダリリンク（`photo_links`）からの原本自動解決とランチャー安全性強化（v1.8.6）
- **代表リンク未接続時のオンラインサブリンク原本解決**:
  - 取り込み元のSDカード等が未接続でも、`Loome` 等にコピーされたセカンダリリンク（`photo_links`）がオンラインであれば、拡大ビューア（`/api/photo/{id}/view`）および詳細取得時に自動的にオンラインの実ファイルから原本を配信するよう改善しました。
- **ネイティブランチャー（`Tetheract.exe`）の差分アップデート安全性ガード**:
  - 同フォルダ内の `Tetheract_v*diff.zip` を検知した際、現在稼働中のバージョンより新しいバージョンの差分ZIPのみを適用対象とし、開発リポジトリ（`.git` 存在環境）では自動削除をスキップする保護ガードを追加しました。

---

## English

### 1. Crisp Full-Resolution Zoom Without Texture Upscaling Mosaic & Original-Pixel (`100%` = 1:1) Zoom Readout (v1.8.6)
- **Eliminated CSS `scale()` GPU Texture Upscaling Mosaic**:
  - Replaced CSS `transform: scale(zoom)` on screen-fitted `<img>` elements across the Lightbox, Side-by-Side Compare View, and Mobile Viewer with direct pixel layout sizing (`style.width` / `style.height`) and `translate`-only panning. This prevents Chromium from stretching a low-resolution screen-fit texture and ensures crisp, full-resolution rasterization at every zoom level.
- **Original-Pixel-Based Zoom Ratio (`%`) & Double-Click 1:1 (`100%`) Toggle**:
  - Zoom percentages are now calculated relative to the photo's original pixel dimensions (`100%` = 1:1 physical pixels). Screen-fit starts at its true reduced percentage (e.g., `25% (FIT)`), and double-clicking (or double-tapping on mobile) toggles cleanly between **Screen Fit** and **Original 1:1 (`100%`)**.

### 2. Automatic Online Secondary Link (`Loome` / `photo_links`) Resolution & Launcher Update Guard (v1.8.6)
- **Seamless Original Delivery from Online Secondary Links**:
  - When a photo's primary path (e.g., an unplugged SD card) is offline while a secondary link in `photo_links` (such as a connected `Loome` drive) is online, `/api/photo/{id}/view` and photo detail queries now automatically resolve and serve the full-resolution original from the online link.
- **Launcher Clean-Update Version & Dev-Workspace Guard**:
  - Added version comparison and `.git` workspace guards to `Tetheract.exe` when applying `Tetheract_v*diff.zip`.
