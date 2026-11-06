# TETHERACT pm v1.8.1 Release Notes

- **Tag**: `v1.8.1`
- **Title**: `TETHERACT pm v1.8.1 - Activity Rail Reorganization & Icons, Compact 1-Line Binder Presets, Streamlined Inspector & Local Clean Updater`
- **Date**: `2026-11-06`

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
> - **既存環境（軽量差分版 `Tetheract_v1.8.1diff.zip`）**:
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.1diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.1diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
> - **初回導入（フル版 `Tetheract_v1.8.1.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.1diff.zip`)**: If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**. Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.1diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 左端アクティビティレールの並び順再編 ＆ アイコン刷新（v1.8.1）
- **探す動線と保存場所の明快なグルーピング**:
  - 左端メニューバー（アクティビティレール）およびアコーディオンモードの並び順を再設計しました：
    1. **Folder**（保存場所・登録メディア管理）
    2. **セパレータ線**
    3. **Binder**（条件セット保存・呼び出し）— **テザラクト（超立方体）アイコン**へ刷新（初回起動時の既定セクション）
    4. **狭めの空白（セパレータなし）**
    5. **Tag**（タグ・カラー）— 視認性の高い**標準タグアイコン**へ刷新
    6. **Historia**（撮影年月・カレンダー）
    7. **Place**（撮影地・マップ）
    8. **Gear**（カメラ・レンズ）
    9. **下部スペーサー**
    10. **Lab**（分析・発掘ツール）
    11. **Search**（ファイル名検索）

### 2. Binder「保存済みセット」カードの1行スリム化 ＆ 条件ホバーツールチップ化（v1.8.1）
- **縦幅を大幅に圧縮した1行レイアウト**:
  - 保存済みセットのカードから作成日時表示と条件バッジの折り返し行を廃止し、左側に**セット名**、右側に **`[適用]` `[▶︎ 再生]` `[🗑️]`** を1行でコンパクトに配置しました。多数のプリセットを登録してもスクロールせずに一覧できます。
- **マウスオーバーによる条件スマート確認**:
  - 保存されている絞り込み条件（フォルダ・タグ・日付・場所・機材・評価など）の内訳は、`[適用]` ボタン（およびセット名）にマウスカーソルを合わせた際のツールチップ（`title`）で確認できるようになりました。

### 3. 右インスペクタ上部ヘッダーバーの廃止 ＆ クイックアクションバーへの機能統合（v1.8.1）
- **インスペクタ上部の省スペース化**:
  - 右インスペクタ最上部にあったタイトルバー（ファイル名表示および `×` 閉じるボタン）を廃止し、縦方向のスペースをプレビューとメタデータ領域へ還元しました（ファイル名とリネームボタンはファイル情報欄で確認・操作できます）。
- **「フォルダを開く」「アプリで開く」ボタンの統合**:
  - 旧ヘッダーにあった **「エクスプローラーで保存先を開く」** と **「既定のアプリで開く」** の2つのアイコンボタンを、プレビュー直下のクイックアクションバー右端（`[調整] [波形] [↺] [↻] [📁] [↗]`）へ横一列に統合しました。

### 4. ローカル完結の「クリーン・アップデート」機構 ＆ ルート階層整理（v1.8.0 統合）
- **差分ZIP（`Tetheract_v*diff.zip`）の自動検知と不要ファイルの一掃**:
  - `Tetheract.exe` と同じフォルダに `Tetheract_v*diff.zip` を解凍せずに置いて起動すると、更新確認ダイアログを表示し、既存のプログラムフォルダ（`frontend/`・`server/`・`LICENSES/`・`tools/` および旧ルート残骸）を一度すべてクリーン削除してから最新ファイルを展開します（`cache/`・`Loome/`・`storage/`・`take_out/`・`.tetheract_instance`・`python/`・`models/` には一切触れず、完了後に `diff.zip` も自動削除します）。
- **ルート階層のスリム化（`tools/` 集約 ＆ `Loome/` 標準化）と `autorun.inf` 設置確認**:
  - 自前コンパイル・予備起動用ファイル（`Build.bat`・`start.bat`・`Launcher.cs`）を `tools/` フォルダへ集約し、解凍直後のルート階層にある実行ファイルを **`Tetheract.exe`** 1つに統一しました。あわせて、初回起動時・アップデート直後にエクスプローラー用アイコン設定 `autorun.inf` の設置確認ダイアログを追加しました。

---

## English

### 1. Activity Rail Reorganization & Renewed Icons (v1.8.1)
- **Clear Grouping of Storage, Presets, Metadata Filters, and Bottom Utilities**:
  - Reorganized the left Activity Rail and Accordion headers:
    1. **Folder** (Storage & Media Management)
    2. **Divider Line**
    3. **Binder** (Saved Filter Presets — default initial section, updated with the **Tetheract hypercube icon**)
    4. **Narrow Gap (no line)**
    5. **Tag** (Tags & Colors — updated with a **standard tag icon**), **Historia** (Timeline), **Place** (Location), **Gear** (Camera/Lens)
    6. **Bottom Spacer** -> **Lab** (Analytics & Rediscovery) & **Search** (Filename Search)

### 2. Compact 1-Line Binder Preset Cards with Hover Condition Tooltips (v1.8.1)
- **Vertically Compact Single-Row Cards**:
  - Streamlined each saved preset card in `Binder` into a compact single line with the preset name on the left and `[Apply]`, `[▶︎ Play]`, and `[🗑️]` buttons on the right.
- **Hover Tooltip for Filter Conditions**:
  - Removed the multi-line inline condition badges row; detailed filter conditions are now cleanly displayed in the tooltip when hovering over the `[Apply]` button or preset name.

### 3. Streamlined Right Inspector & Integrated Quick Action Bar (v1.8.1)
- **Removed Redundant Top Inspector Header Bar**:
  - Removed the top `.inspector-header` bar (filename bar and `×` close button) to maximize vertical space for the photo preview, histogram, and metadata sections.
- **Unified Quick Action Row**:
  - Moved the **Reveal in Explorer** (`📁`) and **Open in Default App** (`↗`) icon buttons to the right end of the quick action bar directly below the preview (`[Adjust] [Histogram] [↺] [↻] [📁] [↗]`).

### 4. Local Clean Updater (`diff.zip` Auto-Apply) & Root Folder Organization (v1.8.0 Included)
- **Automatic `Tetheract_v*diff.zip` Clean Update**:
  - Placing `Tetheract_v*diff.zip` (unextracted) into the app folder and launching `Tetheract.exe` prompts to cleanly replace program folders (`frontend/`, `server/`, `LICENSES/`, `tools/`) while preserving all user data (`cache/`, `Loome/`, `storage/`, `take_out/`, `.tetheract_instance`, `python/`, `models/`).
- **Consolidated `tools/` Subfolder & `autorun.inf` Setup Prompt**:
  - Moved `Build.bat`, `start.bat`, and `Launcher.cs` into `tools/` so `Tetheract.exe` is the sole executable in the root folder, and added an optional `autorun.inf` setup prompt on first launch or after updates.
