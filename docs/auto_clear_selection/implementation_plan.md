# 実装計画: タグ付け・評価後の選択自動解除および孤立選択の防止

## 1. 課題と原因分析
### 現状の課題
- 写真を選択した状態でタグ付けや評価の変更を行うと、操作完了後も選択状態（`state.selectedPhotoIds`）が保持されたままになる。
- 付与したタグの除外フィルタ（[-]）や未分類フィルタ、評価フィルタなどの影響で対象写真が画面から非表示になっても、内部的に選択状態が残り続ける。
- この状態で別の写真を選択してタグを付けた際、以前の写真（見えていない写真）にもタグが付与されてしまう誤爆が発生する。

### 解決方針
1. **各操作完了時の明示的選択解除**:
   タグ付け、評価設定、タグ削除、インポートなどの一括操作が正常に完了した直後に `clearSelection()` を呼び出し、選択状態をリセットする。
2. **孤立選択の自動クリーンアップ（フェイルセーフ）**:
   写真一覧が再取得・描画された際、取得データ（`state.photos`）に存在しない写真IDが万が一 `state.selectedPhotoIds` に残っていれば自動的に削除・クリーンアップし、画面外の写真が誤って選択され続けることを根本的に防ぐ。

## 2. 変更対象ファイルと具体的な改修点
- **[frontend/js/app.js](file:///r:/photo-manager/frontend/js/app.js)**:
  1. `batchAddTagToSelection(tagName)`: `await refreshAll()` の直前に `clearSelection()` を追加。
  2. `batchRateSelection(rating)`: `await refreshAll()` の直前に `clearSelection()` を追加。
  3. `batchRemoveTagFromSelection(tag)`: `await refreshAll()` の直前に `clearSelection()` を追加。
  4. `importSelectedPhotos(destinationPath, displayName)`: コピー成功時およびトースト表示後に `clearSelection()` を追加。
  5. 単一インスペクタ内評価変更ハンドラ: 評価変更後に `clearSelection()` を呼び出し。
  6. `renderPhotoGrid()`: 現在の `state.photos` に含まれない写真IDを `state.selectedPhotoIds` から自動除去するガード処理を追加。

## 3. 検証手順
- 複数写真を選択 ➜ タグ付与 ➜ 選択解除され、フローティングバーが非表示になること。
- 複数写真を選択 ➜ 評価設定 ➜ 選択解除されること。
- 除外フィルタが有効な状態でタグを付け、写真が画面から消えても次回選択時に巻き込まれないこと。
