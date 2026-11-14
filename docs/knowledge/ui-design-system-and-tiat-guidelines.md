# UI/UX デザインシステム & Tiat 志向設計ガイドライン

本ドキュメントは、Tetheract Photo Manager の視覚ルール（Stoic Darkroom / Tiat-Inspired Design System）、レイアウト構造、2階建てカラーテーマ、確認モーダル統一規約、およびタグツリー3ペイン責務分離仕様を定義するコア・ナレッジである。

---

## 1. タイポグラフィ & アイコノグラフィ規約

1. **サンセリフ統一と等幅数値 (`tabular-nums`)**:
   - UIのボタン・ラベル・ツリーに明朝体は使用せず、すべてサンセリフ体（`--font-sans` / `--font-display`）に統一する。
   - 写真枚数バッジ、EXIF数値、ヒストグラム階調、日付表示には `font-variant-numeric: tabular-nums` または `--font-mono` を適用して桁ズレを防ぐ。
   - 太字（`700/800`）の乱用を避け、基本ウェイトは `400`〜`500`、アクティブ要素・見出しのみ `600` とする。
2. **OS標準カラー絵文字の全面禁止と単色細線SVG統一**:
   - UIのボタン・見出し・ツリー・バッジ・ドキュメント見出しにOS標準カラー絵文字を配置してはならない。
   - アイコンは `width="15" height="15"`（または `16px`）、`stroke="currentColor" stroke-width="1.75" fill="none"` の単色細線SVGを使用し、テキスト色に追従させる。
   - 4段階評価（`2`: 優 / `1`: 良 / `0`: 可 / `-1`: 棄）も絵文字を添えず、文字ピルボタン（英語時は `Ex / Gd / Nm / Rj`）で表現する。
3. **サーフェス・境界線・バッジ**:
   - 不透明な太枠やパネル内の二重枠（Box-in-Box）を避け、`--border-color` の半透明ラインを使用する。
   - サムネイル上のオーバーレイバッジ（RAW / スタック / XMP 等）は原色ベタ塗りを避け、半透明ダーク・モノトーンに統一して写真の色彩を邪魔しない。
   - スクロールバーは `6px` 幅の控えめな丸角バーとする。

---

## 2. 4つのカラーテーマと2階建て属性構造 (`data-scheme` & `data-theme`)

`frontend/js/common.js` の `applyTheme(scheme)` は、`<html>` 要素（`document.documentElement`）に以下の2属性を同時設定する：

1. **`data-scheme`（4種類の個別パレット）**:
   - `tetheract-d`: Tetheract D（既定ダークテーマ、ブルー系アクセント `#3b82f6`）
   - `tetheract-l`: Tetheract L（ライトテーマ、ブルー系アクセント `#2563eb`）
   - `sumi`: 夜墨（純黒系ダークテーマ、朱色アクセント `#e14d2a`）
   - `paper`: 和紙（白磁系ライトテーマ、朱色アクセント `#c83e1d`）
2. **`data-theme`（明暗2種類のベース分類）**:
   - ダーク系2種（`tetheract-d` / `sumi`）は `data-theme="sumi"`
   - ライト系2種（`tetheract-l` / `paper`）は `data-theme="paper"`

> [!IMPORTANT]
> 旧称のプロトタイプ属性名（`washi`, `urusi`, `dark`, `light`）は存在しないため、CSSセレクタに使用してはならない。明暗共通スタイルは `[data-theme="paper"]` / `[data-theme="sumi"]`、パレット固有色は `--accent-primary` / `--accent-rgb` 等のテーマ変数または `[data-scheme="..."]` で記述する。

---

## 3. レイアウト & ナビゲーション動線規約

### 3.1 1段メインツールバーと自然文フィルタバー (`#viewHeaderChipBar`)
- **メインツールバー（`.app-header.unified-single-header`, 高さ `44px`）**: 1段構成とし、既定は画面下部フッター配置（`body.toolbar-bottom`、設定で上部ヘッダーへ切替可）。
  - **左**: メニュー開閉、アプリロゴ・バージョン（`#appVersion`）、レイアウト切替（`グリッド / びっしり / マウント`）、`スタック`、`情報`、サイズスライダー、ソート順。
  - **中央（常設3大基本フィルタ `.header-center-filters`）**: ①表示対象（`#headerScopeSelect`: `すべて / 接続中 / 未接続 / リンク消失 / 未分類 / 重複`）、②形式・状態（`#headerAttrSelect`: `すべて / RAW / RAW+JPEG / JPEG / 調整済 / XMPあり`）、③評価ピル（`優 / 良 / 可 / 棄`）＋ リセットボタン。
  - **右**: テーマ明暗トグル、言語切替（`JP / EN`）、`設定`、`スマホ連携`、`ヘルプ`、`詳細`、`終了`。
- **自然文フィルタバー（`#viewHeaderChipBar`, `frontend/js/filter_chips.js`）**:
  - 絞り込み条件が有効な間は `#viewHeaderChipBar` に現在の条件を自然な日本語（英語時は英語）のピル列として表示し、ピルクリックで同親タグの追加・除外や「歴代の同月」切替をインライン実行できる（※`#filterFooterBar` というDOM IDは存在しないため参照禁止）。

### 3.2 左サイドバー2段階構造と300msホバーカスケード
- **左サイドバー（`#sidebar`）**: 左端の垂直タブレール（`#sidebarRail`: `Binder / Folder / Tag / Place / Historia / Gear / Lab` ＋ 下部 `Search`）と、選択中の1セクションを全高表示する `#sidebarStage` の2段階横並びとする（メニューオフ時もレールは残り、アイコンクリックでオーバーレイ展開する）。
- **`Binder` ペイン**: 絞り込み条件セットの名前付き保存・呼び出し・スライドショー再生の専用ページとする。
- **ボックス枠カードとカスケード（`sidebar_cascade_flyout.js`）**: 左ペイン・右クリックメニュー（`#contextMenu`）・`Loome` 移動サブメニューはマウスオーバー `300ms`（クリック時は即時）でソフトフェードイン展開し、同一階層の移動時はDOMを再利用してフリッカーを防ぐ。
- **グリッド下部の選択フローティングバー廃止**: 単一・一括操作はすべて右クリックメニュー（`#contextMenu`）と右インスペクタに集約し、写真グリッドの視界を遮らない。

### 3.3 右インスペクタ（`4:3` プレビュー）とライトボックス
- **右インスペクタ**: プレビュー枠（`.inspector-preview-wrapper`）は `aspect-ratio: 4 / 3` + `object-fit: contain` で縦横見切れゼロとし、直下に4行の常時表示クイックEXIF（`#inspectorQuickExif`）を配置する。
- **ライトボックス**: ダブルクリック時にインスペクタの二重更新を走らせず、オンライン写真はフル解像度（`/view`）でフェードイン表示、オフライン・リンク消失写真はサムネイルを最大200%上限で表示する。閉じる操作は `Space` / `Esc` / `×` に加えマウス第4ボタン（戻る）と `popstate` に対応する。

### 3.4 ネイティブ `confirm()` / `alert()` の全面禁止
- ブラウザ標準の `window.confirm()` / `window.alert()` はPC・モバイルともに使用禁止とする。
- 確認ダイアログは `frontend/js/common.js` の `await showConfirmModal(options)`（`#commonConfirmModal`、モバイル単体時はカスタムモーダル）、通知は `showToast()` に統一する。

---

## 4. タグツリーの並び順制御 ＆ 3ペイン責務分離 (`server/database/tags.py`)

### 4.1 並び順制御（枚数順トグル ＆ 名前順4ルール）
- **枚数順トグル (`#tagSortByCountToggleBtn`)**: ON時は各階層を写真枚数降順で並べ、同数の場合のみ名前順ルールで並べる。左メニューと右インスペクタで独立切替が可能。
- **名前順4ルール (`localStorage: pm_tag_sort_mode`)**: `'lexical'`（文字コード昇順：`24-A` → `2410-B` → `25-C`）、`'lexical_desc'`、`'natural'`（数値自然順昇順：`第2回` → `第10回`）、`'natural_desc'`。

### 4.2 誤操作防止のための3ペイン責務分離
1. **左サイドバー (`#tagList`)**: 純粋な絞り込み専用（左クリック＝含む `[+]`、右クリック＝除外 `[-]`、リネーム・削除ボタンは置かない）。
2. **右インスペクタ (`#inspectorQuickTree` / `#batchQuickTree`)**: 写真へのタグ付与・解除とオンデマンドの子タグ追加（`+子`）専用。
3. **設定モーダル内「タグツリーエディタ」(`#settingsTagTreeContainer`)**: D&Dによる階層移動・ルート独立化、`tag_definitions` テーブルによる0枚空タグ作成、インラインリネーム、影響枚数確認付きの全体削除の専用画面。

### 4.3 階層移動時の祖先タグ安全同期 (`rename_tag` in `server/database/tags.py`)
`photo_tags` は祖先ノード独立保存方式（`A/B` 付与時に `A` と `A/B` を保持）であるため、`rename_tag(old_tag, new_tag)` は単一トランザクション内で ①自己子孫への循環移動ブロック、②対象および子孫 `old_tag/*` の一括置換マージ、③移動先の新しい祖先ノードの `INSERT OR IGNORE` 自動補完、④外れた旧祖先ノードの条件付き削除（同一写真に他の `旧祖先/*` が1つも残っていない場合のみ削除）の4ステップを実行する。

---

## 5. ドキュメント & リリースノート編集規約

`README.md`, `README_EN.md`, `MANUAL.md`, `RELEASE_NOTES.md`, `docs/knowledge/*.md` を執筆・更新する際は、見出し・箇条書きへのカラー絵文字付与、感嘆符による煽り表現、太字の壁を避け、テーブルと構造化リストで端正に記述する。
