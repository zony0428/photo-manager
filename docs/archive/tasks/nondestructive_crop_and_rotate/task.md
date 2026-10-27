# 非破壊画像調整（90度回転・X/Twitter風クロップ）実装タスクリスト

## 概要
Photo Manager に元画像を一切破壊せず、SQLiteデータベースおよびUI上で写真を90度単位で回転、およびTwitter(X)風の直感的な比率プリセット付きトリミング（クロップ）を行う機能を追加する。

## タスク項目

- [x] **1. データベース層の拡張・マイグレーション**
  - [x] `server/database/schema.py`: `photos` テーブルに `rotation`, `crop_x`, `crop_y`, `crop_w`, `crop_h`, `crop_aspect` カラム追加マイグレーション
  - [x] `server/database/photos.py`: 写真調整用関数（`update_photo_adjustments`, `rotate_photo`, `reset_photo_adjustments`, `batch_rotate_photos`, `get_photo_brief`, `get_photos_brief_batch`）の実装
  - [x] スキャン時UPSERTで手動調整値が上書きされないことの保護確認（`_UPSERT_PHOTO_SQL` で rotation / crop は保持）

- [x] **2. バックエンドAPIおよびサムネイル処理の実装**
  - [x] `server/scanner.py`: サムネイル生成時に `rotation` および `crop_box` を適用するヘルパー（`render_thumbnail_webp`, `refresh_photo_thumbnail_transform`, `ensure_thumbnail`）の実装
  - [x] `server/app.py`: 単一/一括回転API (`/api/photo/{id}/rotate`, `/api/photos/batch-rotate`)
  - [x] `server/app.py`: クロップ・調整保存API (`/api/photo/{id}/adjust`, `/api/photo/{id}/adjust/reset`)
  - [x] サムネイルETag生成に回転・クロップハッシュを含めてキャッシュ整合性を担保

- [x] **3. フロントエンド: X(Twitter)風画像調整モーダルの実装**
  - [x] `frontend/index.html`: `#imageAdjustModal` のHTMLマークアップ（三分割線付きクロップ枠、8ハンドル、比率ボタン、回転ボタン、リセット、適用）
  - [x] `frontend/css/style.css`: モーダルおよびクロップ枠、ガイド線、ハンドルのHinomaru Ink UIスタイリング
  - [x] `frontend/js/adjust.js`: クロップ枠のドラッグ移動・ハンドルリサイズ・アスペクト比拘束・回転処理を担う専用モジュールの実装

- [x] **4. フロントエンド: 爆速選別連携（ショートカット・インスペクタ・ライトボックス連動）**
  - [x] キーボードショートカット: `R`（時計回り90度）/ `L`（反時計回り90度）
  - [x] 右インスペクタ (`inspector.js`): 「↺」「↻」「✂ 調整」ボタンの配置
  - [x] ライトボックス (`lightbox.js`): ツールバーへの回転・調整ボタン追加、CSS `transform: rotate(...)` による即時反映
  - [x] 写真グリッドカード (`app.js`): サムネイルへの回転CSS適用とアスペクト比対応
  - [x] 複数選択操作バー & 右クリックメニュー (`selection.js`): 一括回転メニューの追加

- [x] **5. ドキュメント同期 & バージョンアップ**
  - [x] `VERSION`: 2.11 → 2.12 カウントアップ
  - [x] `MANUAL.md`: 新機能（非破壊回転・Twitter風クロップ調整）の操作マニュアル追記
  - [x] `frontend/index.html`: `#helpModal` 内のショートカット表・機能説明更新
  - [x] `docs/nondestructive_crop_and_rotate/walkthrough.md`: 検証結果と機能ウォークスルーの作成

- [x] **6. UX改善: 右クリックメニュー統合 ＆ Cキーショートカット (v2.14)**
  - [x] 右クリックメニューを「✂ 調整と回転 ▶」サブメニューに一本化（右回転、左回転、クロップ、区切り線、調整リセット）
  - [x] `frontend/js/selection.js`: `contextMenuCrop` へのイベントバインド
  - [x] `frontend/js/app.js`: グリッド一覧およびライトボックスでの `C` / `c` キーショートカット実装
  - [x] `MANUAL.md` & `#helpModal`: `C` キーショートカットの追記
  - [x] `VERSION`: 2.13 → 2.14 カウントアップ

- [x] **7. 不具合修正・UIスリム化 (v2.15)**
  - [x] `frontend/js/adjust.js`: 構文エラー（閉じ括弧欠落）の修正により、全回転・調整関数のグローバル公開と即時自動保存を復旧
  - [x] インスペクタから不要な回転・クロップ調整バーを完全撤去（HTML, JS, CSS）
  - [x] `VERSION`: 2.14 → 2.15 カウントアップ

- [x] **8. クロップモーダル操作性改善 ＆ 誤爆防止 (v2.16)**
  - [x] 画像とクロップコンテナの寸法完全同期（ズレ・黒帯はみ出しの解消）
  - [x] 初期表示および「元の比率」選択時は画像全体の100%選択スタートに改善
  - [x] 8点ハンドルの幾何学的対角クランプによる自由な拡縮機能
  - [x] モーダル背景クリック閉じるの廃止（ドラッグ後の誤爆クローズ防止）
  - [x] `VERSION`: 2.15 → 2.16 カウントアップ



