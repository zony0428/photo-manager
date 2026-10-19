# タスクリスト: ボリュームラベル表示機能

- [x] `server/volume_info.py` — ボリューム情報取得ユーティリティを新規作成
- [x] `server/database.py` — volumes テーブル新設 + photos に volume_serial カラム追加 + 関数追加
- [x] `server/scanner.py` — スキャン時にボリューム情報を取得・記録
- [x] `server/app.py` — API レスポンスにボリューム情報を付与
- [x] `frontend/index.html` — インスペクタに「保存ボリューム」行を追加
- [x] `frontend/js/app.js` — インスペクタ・ツールチップ・ライトボックスにボリューム情報を表示
- [x] 動作確認（volume_info取得OK / DBマイグレーションOK / スキーマ検証OK）
