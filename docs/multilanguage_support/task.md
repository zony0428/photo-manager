# マルチランゲージ対応（日本語 ⇄ 英語 リアルタイムUI切替）タスクリスト

- [x] **設計・辞書定義策定 (`implementation_plan.md`)**
  - [x] テーマ表記: `和紙` / `夜墨` ➔ **`Washi`** / **`Urusi`**
  - [x] 4段階評価: `優` / `良` / `可` / `棄` ➔ **`Ex`** / **`Gd`** / **`Nm`** / **`Rj`** (Excellent / Good / Normal / Reject)
  - [x] カメラ文化＆日本発祥スラング: `⚠️ Lens Shaker`, `🏆 Kami-Lens Karte`, `📷 Gear & Numa`, `🎲 Gacha`, `👣 Osanpo Trail`, `🗾 Seiha Map`, `🎞️ Betayaki HTML...`, `⚖️ Duel`
- [x] **フロントエンド i18n エンジンの実装 (`frontend/js/i18n.js`)**
  - [x] 双方向テキストノード・属性（`title`, `placeholder`, `aria-label`）変換＆復元エンジン（`__pmOrigJa` / `__pmLastEn`）
  - [x] `MutationObserver` による動的生成DOM（写真カード・インスペクタ・ライトボックス・2枚比較・カルテ・制覇マップ・トースト通知）のリアルタイム自動翻訳
  - [x] `localStorage` (`pm_lang`) による言語設定の永続化
- [x] **ヘッダーUIへの言語切替ボタン追加 (`frontend/index.html`, `frontend/css/style.css`)**
  - [x] `#themeToggleBtn` の隣に `#langToggleBtn` (`🇯🇵 JP` ⇄ `🇺🇸 EN`) を配置
  - [x] `.btn-lang-toggle` の専用スタイル定義
- [x] **操作マニュアル同期更新 (`MANUAL.md`, `#helpModal`)**
  - [x] `frontend/index.html` の `#helpModal` および `MANUAL.md` に言語切替ボタンの説明を追記
- [x] **動作検証 & ドキュメント保存 (`docs/multilanguage_support/`)**
  - [x] 静的カバレッジ検証および FastAPI エンドポイント配信確認
  - [x] `task.md`, `implementation_plan.md`, `walkthrough.md` を `docs/multilanguage_support/` に保存
