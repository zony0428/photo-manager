# RAW+JPEG ペア改善 - タスクリスト

## 1. バックエンド
- [ ] `database.py`: `recalculate_stacks()` から raw_pair スタック化を除去
- [ ] `database.py`: `get_photos()` にペア済みRAW除外フィルタ追加
- [ ] `app.py`: `POST /api/photo/{id}/open-raw` エンドポイント追加

## 2. フロントエンド
- [ ] `index.html`: インスペクタ RAW セクションを独立セクション+ボタンに強化
- [ ] `app.js`: インスペクタ RAW セクション表示・ボタンイベント追加
- [ ] `app.js`: ブラケットセクションから raw_pair ケース除去
- [ ] `style.css`: RAW セクション用スタイル追加

## 3. 検証
- [ ] スタック再計算で raw_pair が解消されることを確認
- [ ] グリッドにペア済みRAWが表示されないことを確認
- [ ] 右ペインに RAW セクション表示確認
- [ ] ブラケット/連写は引き続き正常動作
