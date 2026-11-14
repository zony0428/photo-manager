# Release Notes - v2.1.7

- **Tag**: `v2.1.7`
- **Title**: `TETHERACT pm v2.1.7 - RAWスタッキング修正・形式フィルタ整理＆RAW抱き合わせ出力・共通タグ一括削除・Loomeフォルダ単位取り込み＆ピッカー小窓`
- **Release Date**: `2026-11-12`

---

## ✨ 新機能・UI改善・不具合修正 (New Features, UI Improvements & Bug Fixes)

### 1. RAW+JPEG ペア・連写スタッキングの従属RAW除外を完全修正
- **Android ローカルDB・スマホフォルダカタログ・モバイルUI・PCバックエンドの完全統一 (`LockerDatabaseManager.kt` / `PhoneCatalogEngine.kt` / `mobile.js` / `data_adapter.js` / `filter_engine.js` / `server/database/photos.py` / `preload_thumbnails.py`)**:
  - RAW+JPEG 同時記録時および RAW+JPEG 連写・ブラケット撮影時に、ペア済みの従属 RAW 行が一覧・枚数カウント・スタックサブコマ配列（`stack_photos`）・未生成サムネイル走査へ混入して黒い未生成カードとして表示されていた問題を完全に解消しました。

### 2. ファイル形式フィルタの明確化 ＆ テイクアウト「RAW抱き合わせ（無加工原本）」モード追加
- **形式フィルタの整理 (`server/database/photos.py` / `frontend/index.html` / `inspector.js`)**:
  - `RAW単体` / `RAW+JPEG` / `RAWを含むすべて` / `JPEG単体` を明確に分離し、インスペクタの表示形式・解像度・容量表記も `RAW+JPEG ペア（表示・情報: JPEG基準）` 等へ分かりやすく整理しました。
- **RAW抱き合わせ（無加工原本）出力 (`server/exporter.py` / `takeout.js` / `selection.js`)**:
  - スマート・テイクアウトおよび `take_out/` 無加工フォルダコピーに「RAW抱き合わせ」オプションを追加し、JPEG出力・コピーと同時にペアのRAW原本（`.ARW` / `.CR3` / `.NEF` 等）やRAW単体原本を無加工のまま一括出力できるようにしました。

### 3. 複数選択時の右ペイン「共通タグのみ `×` 一括削除」対応
- **インスペクタ・タブレット・モバイルの一括タグ操作改善 (`inspector.js` / `touch_layout.js` / `mobile.js` / `server/app.py`)**:
  - 複数枚選択中に単一写真インスペクタが遅延上書きされて先頭1枚しかタグ削除できなかった不具合を修正しました。
  - **選択した全画像に共通のタグ**にのみ `×` ボタンを表示して選択維持のまま一括削除可能とし、一部の画像のみに付いているタグは破線表示（`×` 非表示）として誤削除を防止しました。

### 4. Loome「フォルダ単位での取り込み」＆ 保存先選択ピッカー小窓への刷新
- **フォルダごとの階層維持インポート (`server/storage_folder_import.py` / `storage_volumes_router.py` / `folder_tree.js` / `app.js`)**:
  - 設定画面の `フォルダごと取り込み...`、左ペイン外部フォルダ右クリック `📦 このフォルダごと Loome へコピー...`、Loome 右クリック `外部フォルダごと取り込み...`、およびエクスプローラーからのフォルダD&Dにより、フォルダ名・サブフォルダ階層・RAW+JPEGペア・サイドカー・既存の評価／タグを維持して丸ごと Loome へ取り込めるようになりました。
- **右クリックのカスケードメニューを専用ピッカー小窓へ刷新 (`loome_picker.js` / `storage.js` / `modals-tools.css`)**:
  - 子フォルダが多い環境でも快適に選べるよう、Loome ドライブ切替タブ・パンくず移動・`↑ 上へ`・フォルダダブルクリックでの子フォルダ展開・その場での `＋ 新規フォルダ` 作成を備えた小窓（`#loomePickerModal`）へ刷新しました。
