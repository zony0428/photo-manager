# タスクリスト: タグ付け・評価後の選択自動解除および孤立選択の防止

- [x] 実装計画の作成 (`docs/auto_clear_selection/implementation_plan.md`) <!-- id: 0 -->
- [x] 一括操作完了時の選択自動解除 (`frontend/js/app.js`) <!-- id: 1 -->
  - [x] `batchAddTagToSelection`: タグ付与成功後に `clearSelection()` を実行
  - [x] `batchRateSelection`: 評価変更成功後に `clearSelection()` を実行
  - [x] `batchRemoveTagFromSelection`: タグ削除成功後に `clearSelection()` を実行
  - [x] `importSelectedPhotos`: インポート（送る）成功後に `clearSelection()` を実行
  - [x] 単一インスペクタでの評価変更時にも選択を解除
- [x] 画面外写真の孤立選択クリーンアップガード (`frontend/js/app.js`) <!-- id: 2 -->
  - [x] 写真一覧取得・再描画時に、表示対象外となったIDを `state.selectedPhotoIds` から自動除外
- [x] 動作確認・テスト <!-- id: 3 -->
  - [x] タグ付け後に選択が解除されることの確認
  - [x] 評価変更後に選択が解除されることの確認
  - [x] 除外フィルタON時にタグ付けしても孤立選択が残らないことの確認
  - [x] 次のタグ付け時に以前の写真が巻き込まれないことの確認
- [x] 修正内容確認ドキュメント (`docs/auto_clear_selection/walkthrough.md`) の作成 <!-- id: 4 -->
