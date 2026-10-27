# タスクリスト: マップ（場所）ツリー機能 & ローカル逆ジオコーディング基盤

## 概要
写真のExif GPS情報から国・都道府県・市区町村の階層地名を自動判定・保存し、左ペインに「場所」ツリーを表示する機能。
また、スマホ写真のGPSを一眼レフ等の写真へ準用（時間マッチング引き継ぎ）する機能を提供する。

---

## タスク進捗

### Step 1: DB拡張 & ローカル逆ジオコーディング基盤（★ 完了）
- [x] 1.1 DBスキーマ拡張 (`server/database/schema.py`)
  - [x] `photos` テーブルに `country`, `state`, `city` カラムを追加
  - [x] 座標キャッシュ用 `geo_cache` テーブルの新設
  - [x] 検索・集計用インデックス `idx_photos_location` の作成
- [x] 1.2 ローカル逆ジオコーディングデータセットの構築
  - [x] 日本全国自治体マスター（47都道府県、1,916自治体の代表座標と正式名称）の作成・格納 (`server/geocoder/data/japan_cities.json`)
  - [x] 世界主要国・都市マスター（国コード、日本語国名、主要14,495都市）の作成・格納 (`server/geocoder/data/world_cities.json`, `countries.json`)
  - [x] ライセンス・帰属表記の整備 (`server/geocoder/data/NOTICE.txt`)
- [x] 1.3 ローカル逆ジオコーダーエンジンの実装 (`server/geocoder/local_geocoder.py`)
  - [x] 緯度経度からの最寄り自治体・都市の高速探索（NumPy/ユークリッド距離二乗）
  - [x] `geo_cache` 連携（約1.1kmメッシュでのキャッシュヒット）
- [x] 1.4 スキャン処理およびDB写真更新への逆ジオコーディング統合
  - [x] `server/scanner.py`: EXIFからGPS取得時に `country, state, city` を自動判定して保存
  - [x] `server/database/photos.py`: 写真保存・更新時の `country, state, city` 反映
  - [x] 既存のGPS付き写真への地名一括バックフィルAPI (`/api/locations/backfill`)
- [x] 1.5 バージョン管理・実データテスト動作確認
  - [x] バージョン自動カウントアップ (2.02 -> 2.03)
  - [x] 実DBのGPS付き写真 6,034枚への逆ジオコーディング一括適用成功（福島県、栃木県など完全分類）

---

### Step 2: スマホGPSの一括準用機能（★ 完了）
- [x] 2.1 直前・直後GPS候補取得 & 一括準用DB関数の実装 (`server/database/photos.py`)
  - [x] `find_nearby_gps_photos` を拡張し、直前（before）と直後（after）の候補を分離返却
  - [x] `batch_infer_gps` 関数を実装（±60分以内で最寄りのGPSを特定し一括更新、`gps_source = 'inferred'`）
  - [x] `clear_inferred_gps` 関数を実装（準用されたGPSのみを安全にリセット）
- [x] 2.2 APIエンドポイントの整備 (`server/app.py`)
  - [x] `GET /api/photo/{photo_id}/gps-candidates` の拡張（before/after、各候補の地名情報付与）
  - [x] `POST /api/photos/batch-infer-gps` エンドポイント追加
  - [x] `POST /api/photos/clear-inferred-gps` エンドポイント追加
- [x] 2.3 インスペクターUIの「直前 / 直後 GPS比較モーダル」の改善 (`frontend/js/inspector.js`)
  - [x] 撮影時刻の前（before）と後（after）のカードを並べ、「どっちを採用する？」と直感的に選べるUI
  - [x] 撮影地名（国/県/市）、時間差（分）、カメラ機種、サムネイルプレビューを表示
- [x] 2.4 フローティングバー / インスペクターへの一括準用ボタンの追加
  - [x] 選択写真に対して「📍 スマホGPSを一括準用」を実行可能にする
- [x] 2.5 バージョンカウントアップ (2.03 -> 2.04) & 動作検証

---

### Step 3: 左ペイン「場所」ツリー表示 & グリッド連動（★ 完了）
- [x] 3.1 場所階層ツリー取得API (`/api/locations/tree`) & 写真一覧フィルタパラメータ (`country`, `state`, `city`, `no_location`)
- [x] 3.2 フロントエンド: アコーディオンへの「🗺️ 場所」セクション追加 (`frontend/index.html`) & 専用モジュール (`frontend/js/location_tree.js`)
- [x] 3.3 ツリー選択によるメイングリッド絞り込み＆フィルタチップ連動 (`state.activeLocation`, `fetchPhotos`, `renderFilterChips`, `resetAllFilters`)
- [x] 3.4 場所ツリー専用スタイル定義 (`frontend/css/style.css`)
- [x] 3.5 操作マニュアル (`MANUAL.md`) & アプリ内ヘルプモーダル (`#helpModal`) の同期更新
- [x] 3.6 実DBデータによる結合検証 & バージョン固定 (`2.01`)

