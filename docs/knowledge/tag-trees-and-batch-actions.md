# タグツリー自然順ソート ＆ 一括タグ操作ワークフロー (v2.11)

本ドキュメントは、Photo Manager の各種タグツリー表示における自然順ソート（Natural Sort Order）およびインスペクタ一括タグ設定のUX・整合性設計に関する技術ノウハウ・知見をまとめたものである。

---

## 1. 各種タグツリーの自然順ソート (Natural Sort Order)

### 背景・課題
スラッシュ区切りの階層タグ（例: `旅行/2020/春`, `イベント/第1回`, `ナンバー/1`）をツリー表示する際、バックエンドDB（SQLite）の集計クエリは枚数順（`ORDER BY count DESC, tag ASC`）で返却される。
従来のフロントエンドでは返却された順序でツリーを構築していたため、子ノードの並び順が写真枚数や登録順に左右され、年別タグ（2020, 2021...）や番号タグ（1, 2, 10...）が数字順に並ばない課題があった。

### 解決策 (`buildTagTree`)
すべてのタグツリー生成の起点となる共通関数 `buildTagTree`（`frontend/js/app.js`）において、各階層の子ノード（`node.children`）を再帰的に自然順ソート（`numeric: true`）で整列する。

```javascript
// 各階層の子ノードを自然順ソート（数字なら小さい方が上・昇順）で再帰的に整列
function sortTreeNodes(node) {
  if (!node.children || node.children.size === 0) return;
  const sortedEntries = Array.from(node.children.entries()).sort((a, b) => {
    return a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' });
  });
  node.children = new Map(sortedEntries);
  node.children.forEach(child => sortTreeNodes(child));
}
sortTreeNodes(root);
```

### 適用範囲
`buildTagTree` を共通基盤としている以下のすべてのツリーで、数字の小さい順・五十音/アルファベット昇順が自動的に保証される：
1. **左サイドバーのタグツリー** (`renderTagList`)
2. **右インスペクタ（単一写真）のクイックタグツリー** (`renderInspectorQuickTree`)
3. **右インスペクタ（複数写真一括）のクイックタグツリー** (`renderInspectorQuickTree`)
4. **右クリックコンテキストメニューのタグサブメニュー** (`renderContextTagSubmenu`)
5. **下部フローティング操作バーのタグ付与ポップオーバー** (`renderFloatingTagTree`)

---

## 2. インスペクタ一括タグ設定のUX・順序統一

### 表示順序の統一
単一写真のインスペクタ詳細タブ（🏷️ タグ）の表示順に合わせ、複数写真選択時の一括編集モード（`#inspectorBatchView`）も以下の順序に統一：
1. **🎨 色合いを一括設定 (複数選択可・エキスパンダ)**
2. **新しいタグ名入力 (`#batchNewTagInput`) ＆ 一括追加ボタン**
3. **タグツリーから選んで一括追加 (`#batchQuickTree`)**

### 操作完了時の選択自動解除 ＆ フィルタ再適用
一括タグ設定（色合い、新規タグ、タグツリー、付与済みタグの解除）の実行後、以下のライフサイクルを確実に実行する：

```javascript
// POST /api/photos/batch-tags 完了後
clearSelection();
await Promise.all([fetchPhotos(), fetchTags()]);
```

- **`clearSelection()`**: 選択を解除してグリッドの選択枠およびフローティングバーを消去し、インスペクタを通常表示に戻す。
- **`fetchPhotos()`**: 現在適用中の全フィルタ条件（タグ、フォルダ、未分類、評価等）を再クエリし、条件に合致する写真のみを最新一覧に再描画（除外された写真の居座りや新規付与写真の反映漏れを防止）。
- **`fetchTags()`**: サイドバーのタグ件数や未分類件数バッジを最新化。
