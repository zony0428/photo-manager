# 評価システムリニューアル タスクリスト

## バックエンド

- [x] `database.py`: ratingカラムのセマンティクス変更（-1/0/1/2）
- [x] `database.py`: DBマイグレーション（旧5段階 → 新4段階）
- [x] `database.py`: `get_photos` を `ratings` パラメータ（複数値）対応に変更
- [x] `database.py`: `update_rating` / `batch_update_rating` の範囲チェック変更
- [x] `app.py`: API エンドポイントの変更（`min_rating` → `ratings`）
- [x] `app.py`: `RateRequest` のバリデーション変更

## フロントエンド

- [x] `index.html`: サイドバーのフィルタUI変更
- [x] `index.html`: フィルタバーの「最低評価」→ 4段階チェックボックスに変更
- [x] `index.html`: インスペクタの星ボタン → 優良可棄ボタンに変更
- [x] `index.html`: ライトボックスの星ウィジェット → 優良棄ボタンに変更
- [x] `index.html`: コンテキストメニューの星評価 → 優良可棄に変更
- [x] `index.html`: 一括評価ボタンの変更
- [x] `app.js`: state変更（minRating → ratingFilter Set）
- [x] `app.js`: カード生成（ホバー評価バー + 一文字アイコンオーバーレイ）
- [x] `app.js`: fetchPhotos の ratings パラメータ送信
- [x] `app.js`: updatePhotoRating の新体系対応
- [x] `app.js`: ライトボックス評価更新
- [x] `app.js`: インスペクタ評価描画
- [x] `app.js`: キーボードショートカット変更
- [x] `app.js`: コンテキストメニュー評価ハンドラ
- [x] `app.js`: フィルタUIイベントハンドラ
- [x] `style.css`: CSS変数の変更
- [x] `style.css`: 評価アイコンオーバーレイ + ホバーバーのスタイル
- [x] `style.css`: フィルタUI（チェックボックス群）スタイル
- [x] `style.css`: ライトボックス/インスペクタの評価ウィジェットスタイル
- [x] `style.css`: 各レイアウトモード対応

## 検証

- [x] サーバーモジュール起動確認（DB module OK, App module OK）
- [ ] ブラウザ動作確認（ユーザー確認待ち）
