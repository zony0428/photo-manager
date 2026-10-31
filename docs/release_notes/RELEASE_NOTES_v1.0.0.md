# Tetheract Photo Manager v1.0.0 Release Notes

- **Tag**: `v1.0.0`
- **Title**: `Tetheract Photo Manager v1.0.0 - Official Rebrand, Tag Key Architecture & Champagne Monotone Themes`
- **Date**: `2026-10-31`

---

> [!NOTE]
> **差分アップデート・旧バージョンからの移行案内 / Lightweight Diff Update & Migration Guide**
>
> - **既存ユーザー様向け（差分版 `Tetheract_v1.0.0diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーし、新しく追加された **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれ、残っていた旧 `PhotoManager.exe` / `PhotoManager_Mobile.html` は起動時に自動整理されます）。
> - **安全なDB自動バックアップと後方互換性**: 初回起動時のDB移行処理（`tag_keys_v1`）の直前に、`cache/backups/library_pre_tag_keys_v1_YYYYMMDD_HHMMSS.db` として移行前のDBが自動バックアップされます。また、移行後のDBは旧 v3.x とも後方互換を保つハイブリッド構造のため、万が一旧版へ戻した場合でもそのまま動作します。
> - **初回導入の方（フルパッケージ版 `Tetheract_v1.0.0.zip`）**: ポータブル Python 同梱版を解凍し、`Tetheract.exe` を起動してください。
> - **For Existing Users (`Tetheract_v1.0.0diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**. Legacy `PhotoManager.exe` and `PhotoManager_Mobile.html` are automatically cleaned up on startup, and a pre-migration DB snapshot is saved to `cache/backups/`.

---

## 日本語 (Japanese)

### 1. ブランド刷新：`Tetheract Photo Manager`（テザラクト / `回TETHERACT pm`）＆ `v1.0.0` リリース
- **新ブランド「テザラクト（Tetheract）」の由来と白銀比（シルバーレシオ）ロゴ・アイコン**:
  - 旧称「Photo Manager」（〜v3.x）から、正式名称を **`Tetheract Photo Manager`（テザラクト・フォトマネージャー / ロゴ表記：`回TETHERACT pm`）** へ刷新し、バージョンを **`v1.0.0`** として再出発しました。
  - 映画『インターステラー』に登場する4次元超立方体「テサラクト（Tesseract）」にインスパイアされ、時間や保存場所を超えて写真の記憶を繋ぎ止める（Tether）という意味を込めて **「テサラクト ⇒ テザラクト（Tetheract）」** と命名しています。
  - 外枠と内枠の比率・文字高・配置すべてに日本人の美意識に馴染む白銀比（$1:\sqrt{2}$ / $1:1+\sqrt{2}$）を取り入れた「テザラクト」アイコン＆ロゴロックアップを採用。
  - ランチャーを **`Tetheract.exe`**、単体モバイルHTMLを **`Tetheract_Mobile.html`** に変更し、上書きアップデート時に旧ファイルを自動整理するマイグレーション処理を搭載。

### 2. 新カラースキーム `Tetheract D` / `Tetheract L` ＆ 4プリセット切替
- **目に優しいシャンパン＆モノトーン基調の新テーマ**:
  - **`Tetheract D`（ダーク）**: 青みを排した暗室マットチャコール〜グラファイトのモノトーン背景に、シルキーアイボリー文字とシャンパンブロンズ（`#c89d6c`）のアクセントを組み合わせたダークテーマ。
  - **`Tetheract L`（ライト）**: 白飛びを抑えたシルキーストーン〜アイボリーマット背景に、チャコールインク文字とアンバーブロンズ（`#a86825`）を組み合わせたライトテーマ。
  - 従来の **`夜墨 (Sumi)`**・**`和紙 (Paper)`** もそのまま残し、設定モーダル最上部の「カラーテーマ（外観）」から4種類をいつでも即時切り替え可能。

### 3. タグ内部キー化（`tag_key`）＆ 省略名（`short_name`）・お気に入りピン留め（`is_pinned`）
- **不変キー `tag_key` によるリネーム・階層移動の高速化と整合性向上**:
  - `tag_definitions` テーブルに不変識別子 `tag_key`（`t_000001` 形式）を導入し、タグ名変更や階層移動時にもプリセット（`filter_presets`）やモバイル差分同期の参照が途切れないハイブリッド設計を実装（マイグレーション直前に自動バックアップを生成）。
- **タグの省略名（`short_name`）とピン留め（`is_pinned`）**:
  - 長い階層タグに短い表示名（省略名）を設定できる機能と、よく使うタグをピン留めしてクイックアクセスできる機能を追加。

### 4. 「タグなし」抽出精度の改善 ＆ UIブラッシュアップ
- **「タグなし」フィルタ・件数からカラーラベルと未昇格AIタグを除外**:
  - 12色カラーラベル（`カラー/...`）や自動付与されただけの未昇格AIタグ（`source = 'ai'`）のみが付いている写真が「手動タグ付け済み」とみなされて「タグなし」から漏れてしまう問題を修正し、純粋に手動タグが未付与の写真を漏れなく抽出できるよう改善（PC版・モバイル版共通）。
- **ジオタグアイコンの刷新・ヘッダーボタン高さ統一・左アイコンバーのドラッグ拡大**:
  - ジオタグのアイコンを直感的な「マップピン＋接地リング」に刷新。
  - 上部ヘッダーの全ボタン・セレクトボックスの高さを `28px` に完全統一。
  - 左端アイコンバー（`#sidebarRail`）の右端境界をドラッグすることで、標準幅（`54px`）から最大2倍（`108px`）までアイコンサイズごと無段階拡大できる機能を追加（ダブルクリックで標準サイズにリセット）。

---

## English

### 1. Rebrand to `Tetheract Photo Manager` (`回TETHERACT pm`) & `v1.0.0` Release
- **Origin of "Tetheract" & Silver-Ratio Icon / Logo Lockup**:
  - Rebranded from *Photo Manager* (up to v3.x) to **`Tetheract Photo Manager`** (`v1.0.0`). Inspired by the 4D hypercube (**Tesseract**) in *Interstellar* combined with **Tether** (linking memories across time and storage: **Tesseract ⇒ Tetheract**), featuring a new icon and condensed logo lockup designed around the Silver Ratio ($1:\sqrt{2}$ and $1:1+\sqrt{2}$).
  - Renamed the native launcher to **`Tetheract.exe`** and standalone mobile viewer to **`Tetheract_Mobile.html`**, with automatic cleanup of legacy `PhotoManager.exe` / `PhotoManager_Mobile.html` on startup.

### 2. New `Tetheract D` & `Tetheract L` Champagne Monotone Themes (4 Presets)
- **Eye-Friendly Monotone Palettes**:
  - **`Tetheract D` (Dark)**: Blue-free warm charcoal/graphite monotone surfaces paired with silky ivory text and Champagne Bronze (`#c89d6c`) accents.
  - **`Tetheract L` (Light)**: Low-glare gallery stone/ivory monotone surfaces paired with charcoal ink text and Amber Bronze (`#a86825`) accents.
  - Classic **`Sumi`** and **`Paper`** themes remain available—all 4 presets can be switched anytime from the Settings modal.

### 3. Immutable Tag Keys (`tag_key`), Short Names (`short_name`), and Pinned Tags (`is_pinned`)
- **Hybrid `tag_key` Architecture with Automatic Pre-Migration Backup**:
  - Added immutable `tag_key` identifiers, `short_name` aliases, and `is_pinned` favorite flags to `tag_definitions` while preserving full backward compatibility with `photo_tags` and `filter_presets`.

### 4. Smarter "Untagged" Filter & UI Refinements
- **Exclude Color Labels & Unpromoted AI Tags from "Untagged" (`untagged_only`)**:
  - Photos that only have 12-color labels (`カラー/...`) or unpromoted AI tags (`source = 'ai'`) are now properly included in the "Untagged" filter and count on both desktop and mobile.
- **New Geo-Tag Map Pin Icon, Unified `28px` Header Controls & Resizable Icon Rail**:
  - Replaced the Geo-tag icon with an intuitive map-pin-and-ring icon, unified all header buttons/selects to `28px` height, and made the left icon rail (`#sidebarRail`) smoothly resizable up to 2x width (`54px`–`108px`) by dragging its right edge.
