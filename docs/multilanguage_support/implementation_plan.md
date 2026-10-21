# 実装計画：マルチランゲージ（🇯🇵 JP ⇄ 🇺🇸 EN）リアルタイム切替対応

## 1. 概要・設計方針
Photo Manager の UI 全体を、ページ再読み込みなしで **🇯🇵 日本語 (JP)** と **🇺🇸 英語 (EN)** にワンクリックで切り替えられるマルチランゲージ機能を実装します。

- **DB非破壊・ゼロ副作用**: SQLite (`library.db`) の中身や既存の検索・フィルタ・イベント処理ロジックは一切変更せず、**UI 表示レイヤーのみ**を双方向変換します。
- **外科的実装 (`frontend/js/i18n.js`)**:
  - 既存の18個のJSファイルを大量書き換えしてバグを招くのを防ぐため、独立モジュール [`frontend/js/i18n.js`](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/i18n.js) に **「静的/動的テキスト＆属性（`title`, `placeholder`）の双方向トランスレータ ＋ `MutationObserver`」** を構築します。
  - 各DOMテキストノード・属性の元の日本語値をメモリ属性（`__pmOrigText` 等）に保持することで、`EN ➔ JP` に戻した際も **100% 元の日本語表示へ完全復元** します。
  - 選択した言語設定は `localStorage` (`pm_lang`: `'ja'` | `'en'`) に永続化します。

---

## 2. 英語モードの用語デザイン（短尺・ひねり・日本発スラング融合）

ボタンやバッジの横幅を崩さず、カメラ好きがニヤッとする単語・日本発スラングを採用します。

| カテゴリ | 🇯🇵 日本語表記 | 🇺🇸 英語モード表記（ボタン・バッジ） | ツールチップ・補足説明 |
| :--- | :--- | :--- | :--- |
| **言語スイッチ** | `🇯🇵 JP` | **`🇺🇸 EN`** | Language: 日本語 ⇄ English (`#themeToggleBtn` の横に配置) |
| **テーマ** | `📜 和紙` / `🌙 夜墨` | **`📜 Washi`** / **`🌙 Urusi`** | Washi (Light Paper) ⇄ Urusi (Dark Lacquer) |
| **4段階評価** | `優` / `良` / `可` / `棄` | **`Ex`** / **`Gd`** / **`Nm`** / **`Rj`** | **Ex**cellent / **G**oo**d** / **N**or**m**al / **R**e**j**ect (Botsu) |
| **レイアウト** | `グリッド` / `びっしり` / `マウント` | **`Grid`** / **`Tight`** / **`Mount`** | Tight (Aspect-ratio packed) / Slide Mount |
| **ツールバー** | `スライドショー` / `スタック` / `情報` | **`Slide`** / **`Stack`** / **`HUD`** | HUD = ファインダー内情報表示トグル |
| **ツールバー右** | `取り込み` / `スマホ連携` / `ヘルプ` / `終了` | **`Import`** / **`Mobile`** / **`Help`** / **`Quit`** | 短くスッキリ統一 |
| **クイック** | `すべての写真` / `未分類` / `接続中` / `未接続` | **`All Shots`** / **`Untagged`** / **`Plugged`** / **`Unplugged`** | ドライブ接続状態をアンプラグド表現に |
| **重複・リンク** | `重複のある写真` / `リンク消失` | **`Dupes`** / **`Ghost Links`** | Duplicates の略 `Dupes` / リンク切れを `Ghost Links` |
| **ナビ項目** | `フォルダ` / `タグ` / `カラー` / `ジオタグ` / `タイムライン` | **`Folders`** / **`Tags`** / **`Palette`** / **`Atlas`** / **`Chrono`** | 短くシャープな単語に統一 |
| **カメラ・レンズ** | `カメラ・レンズ` (`排他検索可`) | **`Gear`** (`Numa Filter`) | 機材＝`Gear`、レンズ沼＝`Numa`！ |
| **🧪 ラボ系** | `🏆 勝ちレンズ・得意設定カルテ` | **`🏆 Kami-Lens Karte`** | 海外カメラ界でも通じる日本発スラング **「神レンズ (Kami-Lens)」**！ |
| **🧪 ラボ系** | `⚠️ 手ブレ注意` | **`⚠️ Lens Shaker`** | 手ブレ危険領域の写真＝**「レンズシェイカーｗ」** |
| **🧪 ラボ系** | `🎲 未整理ガチャ` | **`🎲 Gacha`** | 未整理フォルダをランダムに引くガチャ |
| **🧪 ラボ系** | `🎂 歴代の今日・記念日` | **`🎂 Time Capsule`** | 過去の同じ月日の写真を掘り起こす |
| **🧪 ラボ系** | `🌅 マジックアワー` / `🌌 ブルーアワー` / `🌃 夜景・星景` | **`🌅 Magic Hour`** / **`🌌 Blue Hour`** / **`🌃 Night Sky`** | 太陽高度ラボ抽出 |
| **地図・軌跡** | `🗾 制覇マップ` / `👣 さんぽ軌跡` | **`🗾 Seiha Map`** / **`👣 Osanpo Trail`** | 47都道府県制覇（Conquest）＆ お写ん歩（Osanpo）軌跡 |
| **比較・代表** | `⚖️ 2枚比較` / `👑 代表に設定` | **`⚖️ Duel`** / **`👑 Crown`** | 2枚の一騎打ち勝ち抜き選別（Duel）＆ 王冠（Crown） |
| **書き出し** | `📤 テイクアウト` / `🎞️ ベタ焼きHTML` | **`📤 Takeout`** / **`🎞️ Betayaki HTML`** | 暗室コンタクトシート「ベタ焼き (Betayaki / Darkroom Proof)」 |

---

## 3. 変更対象ファイル

1. **[`frontend/index.html`](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html)**
   - ヘッダー左（`#themeToggleBtn` の右隣）に言語切替ボタン `#langToggleBtn`（`🇯🇵 JP` / `🇺🇸 EN`）を追加。
   - `<script src="/js/i18n.js?v=2.39"></script>` を読み込みに追加。
   - `#helpModal` に言語切替の案内を追記。
2. **[`frontend/css/style.css`](file:///c:/Users/zony0/Documents/photo-manager/frontend/css/style.css)**
   - `.btn-lang-toggle` のコンパクトなボタンスタイルを追加。
3. **[`frontend/js/i18n.js`](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/i18n.js)**（新規作成）
   - 完全一致辞書＋動的パターン正規表現（`123 枚` ➔ `123 shots`、`3個` ➔ `3 tags`、`露出ブラケット (3枚)` ➔ `AEB Stack (3)` 等）＋ `MutationObserver` によるリアルタイム翻訳・復元エンジン。
4. **[`MANUAL.md`](file:///c:/Users/zony0/Documents/photo-manager/MANUAL.md)**
   - 上部ツールバーの解説に言語切替ボタン（`🇯🇵 JP` / `🇺🇸 EN`）の说明を追記。

---

## 4. 検証計画
1. サーバーを起動してブラウザで表示し、ヘッダーの `🇯🇵 JP` ボタンをクリックして `🇺🇸 EN` に切り替わることを確認。
2. テーマボタンが `📜 Washi` / `🌙 Urusi`、評価ボタン・サムネイルバッジが `Ex` / `Gd` / `Nm` / `Rj`、ラボの `⚠️ Lens Shaker` や `🏆 Kami-Lens Karte` などが崩れず表示されることを確認。
3. ライトボックス、2枚比較（Duel）、ラボカルテ、47都道府県マップ、スマート・テイクアウト、右インスペクタを開いた際も英語化され、もう一度ボタンを押すと `🇯🇵 JP`（元の日本語）へ完全に戻ることを確認。
