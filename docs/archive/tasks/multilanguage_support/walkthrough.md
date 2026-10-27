# マルチランゲージ対応（🇯🇵 JP ⇄ 🇺🇸 EN リアルタイム切替）Walkthrough

## 1. 実装のポイント

データベース（SQLite）や既存の18個のJavaScriptモジュールの状態管理ロジックに一切変更を加えず、ワンクリック（0.01秒）で画面全体を日本語（`🇯🇵 JP`）と英語（`🇺🇸 EN`）にリアルタイム切り替えできる [i18n.js](../../../../frontend/js/i18n.js) を実装しました。

### ✨ こだわりの用語・カメラ文化スラング翻訳

| カテゴリ | 🇯🇵 日本語 (JP) | 🇺🇸 English (EN) | ニュアンス・解説 |
| :--- | :--- | :--- | :--- |
| **テーマ切替** | `📜 和紙` / `🌙 夜墨` | **`📜 Washi`** / **`🌙 Urusi`** | 和紙と漆（黒漆）の対比をそのままブランド語として採用 |
| **4段階評価** | `優` / `良` / `可` / `棄` | **`Ex`** / **`Gd`** / **`Nm`** / **`Rj`** | **Ex**cellent / **G**oo**d** / **N**or**m**al / **R**e**j**ect (Botsu)。2文字略称によりバッジ・ボタン幅が漢字1文字と完全一致 |
| **手ブレ危険度** | `⚠️ 手ブレ注意` | **`⚠️ Lens Shaker`** | シャッター速度 `< 1/焦点距離 秒` の微ブレ領域をユーモラスに表現 |
| **勝ちレンズ診断** | `🏆 勝ちレンズ・得意設定カルテ` | **`🏆 Kami-Lens Karte`** | 海外でも通じる「神レンズ（Kami-Lens）」＋ドイツ語由来の「Karte」 |
| **機材ツリー** | `📷 カメラ・レンズ` (`排他検索可`) | **`📷 Gear & Numa`** (`Numa Filter`) | レンズ沼・機材沼（Lens Numa）の楽しさを表現 |
| **未整理発掘** | `🎲 未整理ガチャ` | **`🎲 Gacha`** | ランダム発掘の「Gacha」 |
| **2枚比較** | `⚖️ 2枚比較 (V)` (`📌 A:基準` / `🔍 B:比較候補`) | **`⚖️ Duel (V)`** (`📌 A:Champion` / `🔍 B:Challenger`) | トーナメント勝ち抜き選別を「決闘（Duel）」として表現 |
| **制覇白地図** | `🗾 制覇マップ` / `👣 撮影さんぽ軌跡ライン` | **`🗾 Seiha Map`** / **`👣 Osanpo Trail`** | 47都道府県制覇（Seiha）とフォトウォーク（Osanpo Trail） |
| **コンタクトシート** | `🎞️ ベタ焼きHTML出力...` | **`🎞️ Betayaki HTML...`** | 暗室銀塩文化の「ベタ焼き（Betayaki）」 |
| **表示モード** | `グリッド` / `びっしり` / `マウント` / `情報` | **`Grid`** / **`Tight`** / **`Mount`** / **`HUD`** | ツールバーに美しく収まるショートワード |

---

## 2. 変更・追加したファイル

1. **[frontend/js/i18n.js](../../../../frontend/js/i18n.js)**（新規作成・JS動的文字列の全面網羅）
   - `EXACT_MAP`（800項目以上のUI辞書）、`PREF_ROMAJI_MAP`（47都道府県ローマ字変換）、`PATTERN_RULES`（`5000+ 枚 (表示上限)` ➔ `5000+ shots (Max)`、`123 枚` ➔ `123 shots`、`Lv.128 (中間調) 0.45%` ➔ `Lv.128 (Mid) 0.45%`、`72 (暗め)` ➔ `72 (Low-Key)`、`🏅優 5` ➔ `🏅Ex 5`、`優打率 25.0%` ➔ `Ex Rate 25.0%` などの動的正規表現ルール）を搭載。
   - ヒストグラム（`波形` ➔ `Wave`、`階調・露出` ➔ `Tone & Hist`、`📊 ヒストグラムを表示 (H)` ➔ `📊 Show Histogram (H)`、`平均` ➔ `Avg` 等）やインスペクタ内のスタックボタン（`代表に設定` ➔ `Crown`、`▼ 他 N 枚を表示` ➔ `▼ Show N More`）など、全16個のJSモジュールが動的に生成するボタン・バッジ・ツールチップを完全網羅。
   - DOM TextNode（`__pmOrigJa` / `__pmLastEn`）および属性（`title`, `placeholder`, `aria-label`）の双方向トラッキングと `MutationObserver` により、非同期描画される写真カードやモーダルも遅延ゼロで自動翻訳・復元。
2. **[frontend/js/histogram.js](../../../../frontend/js/histogram.js)**
   - Canvas 2D 描画中のローディングテキスト（`画像読み込み中...` ➔ `Loading image...`）も `window.pmI18n` に連動。
3. **[frontend/index.html](../../../../frontend/index.html)**
   - 上部ヘッダーのテーマ切替ボタン（`#themeToggleBtn`）の右隣に `#langToggleBtn`（`🇯🇵 JP` ⇄ `🇺🇸 EN`）を追加。
   - `#helpModal` 内の説明および `<script src="/js/i18n.js?v=2.39b"></script>` を追加。
4. **[frontend/css/style.css](../../../../frontend/css/style.css)**
   - `.btn-lang-toggle` のボタンスタイルおよびホバーエフェクトを追加。
5. **[MANUAL.md](../../../../MANUAL.md)**
   - セクション `1-4` に言語切替ボタン（`🇯🇵 JP ／ 🇺🇸 EN`）の解説を追記。

---

## 3. 検証結果

- `frontend/index.html` の静的HTML要素および `frontend/js/*.js` 全16モジュールの動的テンプレート・バッジ・ヒストグラム要素のカバレッジ検証を実施し、未翻訳漏れがないことを確認済み。
- FastAPI `TestClient` にて `/` および `/js/i18n.js` が HTTP 200 で正常配信されることを確認済み。
- **追加修正 (v2.39b / v2.39c)**:
  - **ヒストグラム・動的バッジの英語化漏れ解消**: [frontend/js/histogram.js](../../../../frontend/js/histogram.js) の `📊 波形` → `📊 Wave`、`📊 トーン＆波形` → `📊 Tone & Hist`、および「`5000+ 枚 (表示上限)`」→ `5000+ shots (Max)`、「`代表に`」→ `Crown` 等を完全カバー。
  - **絵文字アイコン (`🏷️` 等) の文字化け (``) 修正**: `PATTERN_RULES` 内の文字クラス `[🇯🇵🌍]` が UTF-16 サロゲートペア上位サロゲート (`\uD83C`) 単体にマッチして絵文字テキストノードを分断していた問題を修正し、`translateString()` 先頭に日本語文字ガードを追加して純粋な絵文字ノード・英数字ノードを無変換で即座に返すよう保護。
  - **ヘルプモーダル (`#helpModal`) 全5タブの完全英語化**: `💡 Overview` / `🟢 Basic` / `🔵 Advance` / `🟣 Mobile & USB` / `⌨️ Shortcuts & FAQ` の全テキストノード（約325項目）を [frontend/js/i18n.js](../../../../frontend/js/i18n.js) に追加。
