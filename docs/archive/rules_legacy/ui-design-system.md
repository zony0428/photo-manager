# UI/UX デザインシステム & 編集規約 (v1.4.0+ Stoic Design Rules)

すべてのAIエージェントは、UI（HTML / CSS / JS）およびドキュメント（README / Release Notes / Manual）の追加・修正を行う際、以下のデザインルールを厳守すること。
詳細仕様は `docs/knowledge/ui-design-system-and-tiat-guidelines.md` を参照。

---

## 1. ビジュアル・タイポグラフィ・アイコノグラフィ鉄則

1. **明朝体フォールバックの禁止**:
   - UIコントロールやラベルに明朝体（`Shippori Mincho` 等）を使用してはならない。サンセリフ体（`Inter`, `Yu Gothic UI`, `Meiryo`）＋ 数値等幅（`tabular-nums`）を維持する。
2. **OS標準カラー絵文字の禁止（Zero Color Emojis in UI）**:
   - ボタン、ツールバー、ツリー、評価ピル、バッジにOS標準カラー絵文字（`📁`, `🏷️`, `📷`, `🏅`, `⭐`, `🗑️`, `📜`, `🌙`, `🌐`, `⚙️` 等）を混入させてはならない。
   - アイコンが必要な箇所には `stroke="currentColor" stroke-width="1.75" fill="none"` の単色細線SVGを使用する。
3. **境界線の軟化 & Box-in-Box 禁止**:
   - 不透明な黒太枠（`#2a2926`）は使用せず、各テーマで半透明値が定義済みの `var(--border-color)` を用いる（色を直書きしない）。
   - パネル内部に二重・三重の枠線付きボックスを入れ子にしない。
4. **サムネイル上バッジのモノトーン・すりガラス統一**:
   - 写真カード上のバッジ（`.format-badge`, `.stack-badge`, `.xmp-badge`）は `rgba(20, 20, 20, 0.68)` ＋ `backdrop-filter: blur(4px)` のダーク・モノトーンとし、カラフルな原色バッジで写真の色彩を邪魔しない。
5. **カラーテーマは4種（`data-scheme`）**:
   - `tetheract-d`（既定ダーク）/ `tetheract-l`（ライト）/ `sumi`（夜墨）/ `paper`（和紙）。明暗ベースを表す `data-theme` は `sumi` / `paper` の2値のみ。
   - テーマ依存の色は `--accent-primary` / `--accent-rgb` / `--border-color` 等のテーマ変数で書き、アクセント色を直書きしない。

---

## 2. レイアウト & ナビゲーション構造の維持

1. **メインツールバーは完全1段（高さ `44px`・既定は下部フッター配置、設定で上部ヘッダー切替可）**:
   - `.app-header.unified-single-header` の1段に全メインコントロールを収める（既定は `body.toolbar-bottom` による画面下部フッター配置）。
   - 中央グループには **3大基本フィルタ**（①表示対象プルダウン：`すべての写真 / 接続中の写真 / 未接続の写真 / リンク消失の写真 / 未分類の写真 / 重複のある写真`、②形式・状態プルダウン：`すべての形式 / RAW / RAW+JPEG / JPEG / 調整済 / XMPあり`、③4段階評価トグル：`優 / 良 / 可 / 棄`）＋ 合算枚数バッジ ＋ ソート順 ＋ 表示レイアウト切替 ＋ スタック/情報トグル ＋ サイズスライダーを一列に集約する。
   - `#viewHeaderChipBar` はアクティブな絞り込みチップやリンク消失一括消去ボタンが存在する時のみ表示し、通常時は非表示とする。
2. **左ペインは「垂直タブレール（既定 `54px`、右端ドラッグで最大 `108px`。幅は CSS 変数 `--rail-width`）＋ 全高メニューエリア」の2段階構造**:
   - 左端の `#sidebarRail`（`Binder / Folder / Tag / Place / Historia / Gear / Lab` ＋ 最下部 `Search` の8セクション）はメニューオフ時（`is-collapsed`）も常時表示する。
   - `Binder` セクションは、現在の絞り込み条件の組み合わせに名前を付けて保存・呼び出し・スライドショー再生する「条件セット保存」専用ページとする（旧クイックリストや旧 `#sidebarPersistentFilters` はツールバー中央の3大基本フィルタへ統合済みのため非表示）。
   - メニューオフ時に `#sidebarRail` のアイコンをクリックした場合は、`#sidebarStage` を写真グリッド上にオーバーレイ展開（`is-overlay-open`）させる。
3. **右インスペクタは `4:3` プレビュー ＋ ファーストビュー EXIF サマリ**:
   - `.inspector-preview-wrapper` は `aspect-ratio: 4 / 3`（見切れなし・オーバーレイ波形ボタンなし）を維持する。
   - 評価ボタン直下に常時表示の `#inspectorQuickExif`（撮影日時・解像度・機材名・露出ピル）を維持する。
   - タグツリーの子タグ作成フォームは常時表示せず、親タグの `+子` ボタンを押したときだけインライン入力欄を開くオンデマンド方式を維持する。
4. **下部フローティング選択バーの廃止維持**:
   - `#selectionFloatingBar` は常時非表示とし、一括操作は右クリックメニュー（`#contextMenu`）と右インスペクタで提供する。
5. **ネイティブ `confirm()` / `alert()` の禁止 & カスタムモーダル統一（v1.2.2+）**:
   - ブラウザ標準の `window.confirm()` および `window.alert()` はUIの一貫性を損なうため使用禁止とする。
   - 確認ダイアログはすべて `frontend/js/common.js` の `showConfirmModal(options)`（`#commonConfirmModal`：対象名ハイライト、サブパス表示、`detailRows` 色分け内訳カード、`Enter` 確定 / `Esc` キャンセル、日英リアルタイム翻訳対応）を使用し、通知メッセージは `showToast()` に統一する。

---

## 3. ドキュメント（README / Release Notes）編集鉄則

- 見出し・箇条書き先頭の絵文字スパム、太字だらけの長文（Bold-Text Wall）、感嘆符（`！`）の連発を禁止する。
- 機能一覧やショートカットは Markdown テーブルで構造化し、知的で端正な技術ドキュメントのトーンを維持する。
