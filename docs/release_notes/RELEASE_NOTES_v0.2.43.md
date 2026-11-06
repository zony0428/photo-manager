# Photo Manager v2.43 リリースノート

- **Tag**: `v2.43`
- **Title**: `Photo Manager v2.43 — 🌳 専用「タグツリーエディタ」(D&D階層編集)・📊 枚数順切替・⚡ 1.6万枚表示の10倍高速化`
- **Release Date**: `2026-10-25`

---

## ⚡ アップデート方法のご案内（すでに v2.42 等が稼働している方へ）

すでに **v2.42（フルパッケージ版）** が稼働している環境では、巨大な `python/` や `models/` を再ダウンロードする必要はありません！
- 添付の軽量差分版 **`PhotoManager_v2.43diff.zip`（約 2.1 MB）** をダウンロードし、解凍した中身を既存の `PhotoManager` フォルダへ **そのまま上書きコピー** してください。
- 登録済みのデータベース（`cache/`）やアプリ内ストレージ（`storage/`）、AIモデル（`models/`）、Python環境（`python/`）はそのまま維持され、1秒で `v2.43` へ更新できます。
- ※ **初めて導入される方** は、フルパッケージ版（`PhotoManager_v2.43.zip`）をご利用ください。

---

## 🎉 What's New in v2.43 (日本語)

### 1. 📊 左サイドバー「枚数順」ワンクリックトグル＆名前順ソートルール設定
- **「📊 枚数順」トグルボタン**: 左サイドバー「🏷️ タグ (アルバム)」上部に **`📊 枚数順`** トグルボタンを新設しました。
  - **ON（点灯時）**: 各階層のタグを **「写真枚数が多い順」** でソートします。
  - **OFF（消灯時）**: **`⚙️ 設定`** で選択した好みの **名前順ルール** でソートします。
- **名前順ルールの選択・保存**: `⚙️ 設定` 画面にて、タグの名前順ルールを以下から選んで保存できるようになりました：
  - **文字コード・辞書順 (`A → Z`)**: `24-○×▲` → `2410-abcd` → `25-XYZ` のように先頭文字から厳密に並ぶ方式（年・月プレフィックス管理に最適）
  - **数値自然順 (`1 → 2 → 10`)**: 数字の桁数を数値大小として比較する方式
  - ※ それぞれ昇順・降順を選択可能

### 2. ⚙️ 2ペイン「設定 ＆ 🌳 タグツリーエディタ」（ドラッグ＆ドロップ階層編集）
- 左サイドバーの `DB管理` ボタンを **`⚙️ 設定`** に刷新し、モーダルを **左ペイン（表示設定＆DB管理）** と **右ペイン（🌳 タグツリーエディタ）** の2ペイン構成に拡張しました（右インスペクタの **`⚙️ ツリー編集`** ボタンからも直接開けます）。
- **ドラッグ＆ドロップでのタグ階層組み替え**:
  - タグ行（`⋮⋮`）を別のタグへドラッグ＆ドロップすると、そのタグの配下（`親タグ/移動タグ`）へ子階層ごと一括移動できます。
  - 子タグを上部の **「⬆️ 子タグをここにドラッグ＆ドロップでルート（最上位階層）へ独立移動」** ゾーンへドロップすると、ルート階層へ独立移動できます。
  - 同一写真に `A/B` と `A/C` が両方付いている状態で `A/B` を別親 `D/B` へ移動した場合も、`A/C` 用の親 `A` を自動で維持したまま `D`・`D/B` を補完する安全な祖先タグ同期を行います。
- **日常の選別画面との役割分離（誤操作防止）**:
  - 普段使う右インスペクタのタグツリーは「写真へのタグ付与（`+追加`）」と「素早い子タグ追加（`+子`）」に専念させ、タグ名の変更（`✏`）・階層移動（D&D）・ライブラリ全体からのタグ完全削除（`🗑️` 確認モーダル付き）はすべて設定画面内の **「🌳 タグツリーエディタ」** に集約しました。
  - 写真が0枚の空タグ（整理用の親フォルダタグ等）もツリーエディタ上で先行作成・保持できます。

### 3. ⚡ 起動直後「すべての写真」（16,000枚超）の読み込みを約 10.7倍 高速化
- 5,000枚上限解除後に発生していた起動時 `/api/photos` のボトルネックを解消：
  - 全件表示時は写真の所属フォルダ一覧（約120ディレクトリ）を先に `os.path.exists()` で一括判定し、16,311回発生していた `resolve_portable_path()` のファイルI/Oをスキップ。
  - サイドカー検出のフォルダ単位キャッシュ化と SQLite 一時テーブルB-Treeソートの回避により、16,311枚の読み込み時間を **7,532 ms → 705 ms（約 10.7倍 高速化）** に短縮しました。

### 4. 🔄 F5 リロード不要のリアクティブUI即時反映
- **タグツリーエディタ / 左サイドバー / 右インスペクタ**: タグのD&D移動・リネーム・新規作成・削除時に、APIレスポンスから即座に全3ツリー・写真グリッド・インスペクタを 0ms で再描画し、移動先の親フォルダも自動展開。
- **📦 storage（アプリ内ストレージ）**: 写真の取り込み・移動・リネーム・一括リネーム・サブフォルダ作成/削除時に、グリッドとフォルダツリーが `F5` なしで即座に更新されるよう修正。
- **2枚比較モード / インスペクタ**: 比較画面での評価変更（「棄」による除外など）、XMP取り込み時の評価バッジ反映、GPSコピー時の撮影地ツリー更新、スタック代表変更をすべて即時反映。

---

## 🌍 Release Notes in English (v2.43)

### ⚡ How to Update from v2.42 (Lightweight Diff Package)
If you already have **v2.42** running, you do **not** need to re-download the large `python/` and `models/` folders:
- Simply download **`PhotoManager_v2.43diff.zip` (~2.1 MB)**, extract it, and **overwrite your existing Photo Manager folder**. Your database (`cache/`), `storage/`, `models/`, and `python/` will remain completely intact!
- *(First-time users should download the full package `PhotoManager_v2.43.zip`.)*

### Highlights
1. **📊 One-Click "By Count" Tag Sort Toggle & Customizable Name Sort Rules**:
   - Toggle **`📊 By Count`** in the left Tag filter header to sort tags by photo count descending, or turn it off to sort by your preferred name rule in `⚙️ Settings` (**Lexical Dictionary Order** `24-xxx → 2410-xxx → 25-xxx` or **Natural Numeric Order**, ascending/descending).
2. **🌳 Dedicated 2-Pane "Settings & Tag Tree Editor" with Drag & Drop**:
   - Reorganize tag hierarchies safely via **Drag & Drop** (drop a tag onto another tag to move it under that parent, or drop a child tag onto the top Root Drop Zone to promote it to root level), rename tags (`✏`), create empty parent/child tags, or delete tags library-wide (`🗑️` with confirmation modal) in a dedicated editor separated from daily photo culling.
3. **⚡ 10.7x Faster Startup "All Photos" Loading (16,000+ Photos in ~0.7s)**:
   - Reduced `/api/photos` response time for 16,311 photos from **7,532 ms down to 705 ms** via directory-level existence caching, batched sidecar lookup, and in-memory sorting.
4. **🔄 Instant Reactive UI Updates Without F5 Reload**:
   - All mutations across the Tag Tree Editor, `📦 storage` folder/photo operations, Inspector XMP/GPS/Stack operations, and 2-Photo Compare View now update the UI immediately without requiring a browser refresh.
