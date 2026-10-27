# タスクリスト: タグ祖先ノード独立保存

## バックエンド (database.py)
- [x] `initialize_database` にマイグレーション機構追加（migrations テーブル + ancestor_tags マイグレーション）
- [x] `add_tag_to_photo` で祖先タグを自動追加
- [x] `batch_add_tag` で祖先タグを一括追加
- [x] `remove_tag_from_photo` で子孫カスケード削除
- [x] `get_photos` フィルタリングを完全一致に簡略化

## フロントエンド (app.js)
- [x] `buildTagTree` の件数累計加算を廃止
- [x] `getLeafTags` ヘルパー関数を追加
- [x] 4箇所のタグチップ表示をリーフのみに変更
- [x] 一括編集のタグ集計をリーフのみに変更

## 検証
- [x] サーバー起動 & マイグレーション確認
- [x] 動作テスト（タグ追加/削除/カスケード）
