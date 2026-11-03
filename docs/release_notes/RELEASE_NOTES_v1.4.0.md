# TETHERACT pm v1.4.0 Release Notes

- **Tag**: `v1.4.0`
- **Title**: `TETHERACT pm v1.4.0 - Loome Portable Storage, Bottom Footer Toolbar & 3-Filter Bar, Instant Rating Switching & UI Refinement`
- **Date**: `2026-11-04`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.4.0diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.4.0.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.4.0diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 専用保管庫「Loome」の実装 ＆ 外部メディア Loome 拡張（v1.4.0）
- **アプリ管理下の専用保管庫 `Loome`（内部・外部ドライブ対応）**: 従来の「元の写真ファイルは一切触らない」安全原則を維持しつつ、アプリ内からサブフォルダ作成・ドラッグ＆ドロップ移動・単一または一括連番リネーム（`F2` キー）・外部書き出しを自由に行える専用領域 **`Loome`** を実装しました（同名 `.xmp` サイドカーやペアRAWも自動追従）。
- **外部メディアへの `Loome` 増設**: アプリ内の標準 `Loome`（`storage/`）だけでなく、接続中の外付けSSDやUSBメモリ直下にも右クリックメニューや「登録メディア管理」から `<ドライブ>:\Loome` を作成・登録でき、複数ドライブにまたがるポータブル保管庫としてシームレスに扱えます。

### 2. メインツールバーのフッター（下部）配置化 ＆ 3大基本フィルタのセンター集約（v1.4.0）
- **ツールバーの下部（フッター）標準配置（設定で上部切替可）**: メインツールバーを画面下部のフッター位置に統合し、視線移動を最小限に抑えたモダンなワークスペースへ刷新しました（「設定」モーダルの「メインツールバーの位置」からいつでも「下部（フッター）」⇔「上部（ヘッダー）」を切り替え可能）。
- **3つの基本フィルタ＋枚数チップ＋ソート順のセンタリング集約**:
  1. **表示対象プルダウン**: `すべての写真` / `接続中の写真` / `未接続の写真` / `リンク消失の写真` / `未分類の写真` / `重複のある写真`
  2. **形式・状態プルダウン**: `すべての形式` / `RAW` / `RAW+JPEG` / `JPEG` / `調整済` / `XMPあり`
  3. **4段階評価トグル**: `優` / `良` / `可` / `棄`
  4. **合算枚数チップ (`0 枚`)** ＆ **ソート順プルダウン** ＆ **レイアウト・スタック・情報・サイズスライダー**
  を中央グループに一列集約し、3つの基本フィルタを組み合わせた結果枚数がリアルタイムに表示されます。

### 3. 左サイドバーの8セクション刷新（`Binder` / `Folder` / `Tag` / `Place` / `Historia` / `Gear` / `Lab` / `Search`）とタグツリー改善（v1.4.0）
- **左メニュー＆見出しの統一**: 左端の垂直タブレールと各ペインの見出しを `Binder`（条件セット保存）、`Folder`（フォルダ・メディア）、`Tag`（タグ・カラー）、`Place`（撮影地・マップ）、`Historia`（撮影年月・カレンダー）、`Gear`（カメラ・レンズ）、`Lab`（分析・発掘）、`Search`（ファイル名検索）へ刷新しました。
- **子タグ作成フォームのオンデマンド表示化**: 右インスペクタおよび設定モーダルのタグツリーエディタで、常時表示されていた「〇〇の子タグ...」入力欄を廃止し、各親タグの `+子` ボタンを押したときだけインライン入力欄が開くすっきりしたツリー表示に改善しました。

### 4. 評価・フィルタ切り替えの劇的な高速化（最大 21.8秒 → 5ms / 即時応答）（v1.4.0）
- **切断ネットワークドライブの120ms高速死活判定＆XMP事前フィルタ**: 未接続のネットワークドライブ（`Z:` 等）が含まれるライブラリで発生していたWindows SMBタイムアウト（約21秒）と写真ごとの個別パス解決フォールバックを解消しました。
- **サムネイル寸法カバリングインデックス＆DBコミット世代連動キャッシュ**: 500MB超の `thumbnails` BLOBテーブルに対するカバリングインデックス（`idx_thumbnails_dims`）と、DB書き込み世代連動のレスポンスキャッシュ＋フロントエンド `AbortController` を導入し、約1.6万枚のライブラリでも `優`・`良`・`可`・`棄` の切り替えが数ミリ秒〜即時（0.01ms未満）で完了します。

---

## English

### 1. "Loome" Managed Portable Storage & External Volume Loome Support (v1.4.0)
- **Managed Storage Vault (`Loome`)**: While preserving strict non-destructive handling for external folders, `Loome` provides a dedicated managed workspace where you can freely create subfolders, drag-and-drop move photos, rename files (`F2` for single or batch sequential rename), and export folders—automatically keeping paired RAW files and `.xmp` sidecars in sync.
- **Multi-Drive `Loome` Expansion**: In addition to the built-in `Loome` (`storage/`), you can create and register `<Drive>:\Loome` on any connected external SSD or USB drive from the folder context menu or Registered Media modal.

### 2. Bottom Footer Toolbar & Centered 3-Filter Control Bar (v1.4.0)
- **Bottom Footer Toolbar Placement (Configurable Top/Bottom)**: Relocated the main toolbar to the bottom footer by default for a cleaner viewing canvas (switchable between Bottom Footer and Top Header in Settings).
- **Centered 3-Filter Integration**: Grouped the Scope dropdown (`All Photos` / `Connected` / `Offline` / `Unlinked` / `Untagged` / `Duplicates`), Format/State dropdown (`All Formats` / `RAW` / `RAW+JPEG` / `JPEG` / `Adjusted` / `With XMP`), 4-tier Rating toggles (`Ex` / `Gd` / `Nm` / `Rj`), combined photo count badge, Sort dropdown, Layout switcher, Stack/Info toggles, and Thumbnail size slider in the center of the toolbar.

### 3. Refined Sidebar Navigation (`Binder` / `Folder` / `Tag` / `Place` / `Historia` / `Gear` / `Lab` / `Search`) & On-Demand Child Tag Input (v1.4.0)
- **Unified Sidebar Rail & Headers**: Renamed the 8 sidebar sections and their pane headers to `Binder`, `Folder`, `Tag`, `Place`, `Historia`, `Gear`, `Lab`, and `Search`.
- **Clean Tag Tree View**: Replaced always-visible child tag input boxes in the Inspector and Tag Tree Editor with an on-demand inline input that appears only when clicking `+子` (`+Sub`) on a parent tag.

### 4. Instant Rating & Filter Switching Performance (v1.4.0)
- **120ms Network Drive Probe & Covering Index Optimization**: Eliminated 21-second Windows SMB timeouts on disconnected mapped network drives, skipped redundant per-photo XMP path checks on offline directories, added covering index `idx_thumbnails_dims (photo_id, width, height)`, and introduced commit-sequence response caching with frontend `AbortController`—reducing rating filter switching from ~21.8s / ~790ms down to **5ms (first switch) and <0.01ms (cached)**.
