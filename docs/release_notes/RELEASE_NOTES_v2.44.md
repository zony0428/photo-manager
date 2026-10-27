# Photo Manager v2.44 リリースノート

- **Tag**: `v2.44`
- **Title**: `Photo Manager v2.44 — UIレイアウト交通整理（Step 1）＆ 基本ビューア体験強化（Step 2: 矢印キー移動・Before/After比較・画像コピー・12種ソート）`
- **Release Date**: `2026-10-26`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v2.44diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけで更新できます（`cache/`・`storage/`・`python/` はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v2.44.zip`）**: ポータブル Python 同梱版を解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v2.44diff.zip`)**: Extract and overwrite your existing `PhotoManager` directory. `cache/`, `storage/`, and `python/` remain untouched.

---

## 日本語 (Japanese)

### 1. 【ステップ1】UIレイアウトの交通整理（引き算・再配置）
- **左サイドバーの整理 ＆ ファイル名検索の最下部配置**:
  - 各種ビジュアルフィルタ（フォルダ・タグ・場所・年月・機材・ラボ）の組み合わせで絞り込む本ツールの特性に合わせ、`🔍 ファイル名検索` をアコーディオン最下部へ配置。
  - 実験的機能を「🧪 ラボ」セクションへ一本化し、ジオタグ欄とのボタン重複を解消。
- **上部メインヘッダーの整理**:
  - 右側にあった `📥 取り込み` ボタンを左サイドバー「📁 フォルダ」内のツールバーへ移設。
  - 表示系コントロールとシステム操作ボタン群（スマホ連携・設定・ヘルプ・終了）の間に縦セパレータを配置し、視覚的なノイズを削減。
- **「📤 テイクアウト」メニューの一本化**:
  - 右クリックメニューおよび下部選択バーから、新旧重複していたフォルダ一覧を廃止し、「⚡ スマート・テイクアウト」と「🎞️ ベタ焼きHTML出力」の2つにスッキリ整理。
- **右インスペクタ「単一写真クイックアクションバー」新設**:
  - プレビュー画像直下に `[✂ 調整]` `[📊 波形]` `[↺]` `[↻]` のクイックボタンを常設し、詳細タブを開かずに1クリックで調整や回転へアクセス可能に。
- **下部フローティング選択バーの過密解消**:
  - メンテナンス系操作（サムネイル更新・GPS準用・GPS削除）を「`⋯ その他`」ポップオーバー内へ集約し、ゴミ箱アイコンの重複押し間違いリスクを排除。

### 2. 【ステップ2】基本ビューア体験の強化（他ソフト比較での弱点解消）
- **一覧グリッドでの矢印キー移動（`←` `→` `↑` `↓`）＆ `Shift + 矢印` 範囲選択**:
  - キーボードの矢印キーで一覧写真をスムーズに移動可能に。カードの中心座標計算により、「標準グリッド」「びっしり」「スライドマウント」のいずれのレイアウトでも直感的に真上・真下の写真へ移動。
  - 移動に連動して右インスペクタのプレビュー・ヒストグラム・EXIF・地図がリアルタイムに追従。
  - 単一選択中に `3`（棄）キーで写真が除外された際、同じ位置の次の写真へ自動でフォーカスを引き継ぐ片手連続選別に対応。
- **画像調整モーダルの「👁️ 元画像と比較（Before / After）」**:
  - 調整モーダルヘッダーにホールドボタンを追加。マウス押下中、またはキーボードの `\`（円マーク）/ `Space` キー長押し中だけ、無加工状態（Before）と元波形を表示。
- **トーン調整（3項目）のコピー ＆ 一括ペースト**:
  - 構図や回転・傾きを壊さないよう、コピー＆ペーストの対象を「明るさ・コントラスト・彩度」の3項目に限定して実装。
  - ショートカット（`Ctrl+Shift+C` / `Ctrl+Shift+V`）、画像調整モーダル、右クリックメニューから複数枚へ一括適用可能。
- **`Ctrl + C` で選択写真をクリップボードへ画像コピー**:
  - 一覧やライトボックスから `Ctrl + C`（または右クリックメニュー）で、非破壊調整（回転・傾き・切り抜き・トーン）が反映された状態の画像をOSクリップボードへPNGコピー。SNSや資料へそのまま貼り付け可能。
- **ソート順の拡充（4種類 → 12種類）**:
  - ファイル名順（昇順/降順）、サイズ順（大/小）、焦点距離（広角/望遠）、F値（開放/絞込）、ISO感度（高/低）を追加。
- **属性フィルタピル（`すべて` / `RAW` / `✂ 調整済`）**:
  - 上部ヘッダーにコンパクトな切替ピルを新設。RAWデータのみ、または非破壊調整済みの写真のみをワンクリックで抽出可能に。

---

## English

### 1. [Step 1] UI Layout Decluttering & Repositioning
- **Left Sidebar Organization**: Moved `Filename Search` to the bottom of the accordion; consolidated experimental features into the `Lab` section.
- **Top Header Streamlining**: Relocated the `Import` button into the Folder section toolbar; added vertical separators between display controls and system action buttons.
- **Unified Takeout Menu**: Cleaned up legacy folder copy actions, keeping two distinct export options: `Smart Takeout` and `Contact Sheet (Betayaki) HTML`.
- **Inspector Quick Action Bar**: Added quick-access buttons right below the preview image for non-destructive adjustments, histogram toggle, and 90° rotation.
- **Floating Selection Bar Clean-up**: Grouped secondary actions into a `More (...)` popover to prevent accidental deletions.

### 2. [Step 2] Core Viewer Experience Enhancements
- **Arrow Key Grid Navigation & Shift Selection**: Navigate photos using `←` `→` `↑` `↓` across all layouts (Grid, Tight Masonry, Slide Mount) with automatic scrolling and real-time Inspector tracking; `Shift + Arrow` for continuous range selection; auto-advancing focus when rejecting (`3`) photos.
- **Hold-to-Compare (Before/After) in Adjust Modal**: Hold down the header button, `\`, or `Space` to temporarily inspect the original unmodified photo and histogram.
- **Tone Adjustment Copy & Batch Paste**: Copy tone settings (`brightness`, `contrast`, `saturation`) without overwriting individual crop, angle, or rotation parameters. Use `Ctrl+Shift+C` and `Ctrl+Shift+V` to apply across multiple selected photos.
- **Copy Image to Clipboard (`Ctrl + C`)**: Copies the fully rendered image (with rotation, crop, and tone applied) directly to the OS clipboard for instant pasting into chats or documents.
- **Expanded Sort Orders (12 options)**: Sort by Date, Rating, Filename (A-Z / Z-A), File Size, Focal Length, Aperture (F-number), and ISO.
- **Attribute Filter Pills**: Quickly toggle between `All`, `RAW`, and `Adjusted` photos.
