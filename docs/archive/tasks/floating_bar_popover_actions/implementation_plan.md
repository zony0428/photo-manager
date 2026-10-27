# 実装計画: フローティングバー操作ポップオーバー刷新 (v1.85)

## 1. 概要・背景

### 現状の問題点
サムネイルギャラリーで写真を選択した際、画面下部にフローティング選択バー（`#selectionFloatingBar`）が表示される。
しかし、バー内の主要アクションである「🏷️ タグを付ける」（`#floatingAddTagBtn`）および「📤 テイクアウト」（`#floatingImportBtn`）をクリックすると、
`openContextMenu(e.clientX, e.clientY - 200)` が呼び出され、**サムネイル上で右クリックした時と全く同じコンテキストメニュー（全体）**が画面下部に開くだけの実装となっていた。

このため、ユーザーは：
- 「タグを付ける」を押したのに、タグ付け画面が出るわけではなく、右クリックメニュー（タグ、テイクアウト、評価、サムネイル更新、削除など）が再度表示される
- 「テイクアウト」を押したのに、同様に右クリックメニューが再度表示される
- そこからさらにサブメニューをホバーしなければ操作できず、二度手間で不自然かつ意味不明

という重大な操作性・UX上の欠陥が発生していた。

### 解決方針
右クリックメニュー全体の呼び出しを完全に廃止し、フローティングバーの各ボタン真上に直接展開する専用の**スマート・ポップオーバー（吹き出し型 Popover UI）**を新設する。
- **「🏷️ タグを付ける」**: ボタン真上に直接タグ専用ポップオーバーが開き、新規タグ入力＋既存階層タグツリーからのワンクリック付与が可能。
- **「📤 テイクアウト」**: ボタン真上に直接テイクアウト専用ポップオーバーが開き、新規フォルダ作成＆送信、take_outフォルダオープン、既存送り先フォルダ一覧からのワンクリックコピーが可能。
- **排他制御・自動クローズ**: ボタンクリックでトグル開閉。外側クリック、Escキー、写真選択解除で自動クローズ。

---

## 2. 変更対象ファイル

| ファイルパス | 変更内容 |
|---|---|
| `frontend/index.html` | フローティングバー内のボタン構造を更新、タグおよびテイクアウト専用ポップオーバーHTMLの配置、`appVersion` を `v1.85`、アセットキャッシュバスターを `?v=1.85` に更新、ヘルプモーダル更新 |
| `frontend/css/style.css` | フローティングポップオーバーコンテナ、吹き出し型スタイル（ダークガラスモーフィズム、キャレット矢印、アニメーション、スクロールバー、レスポンシブ）の定義 |
| `frontend/js/selection.js` | フローティングバーのボタンイベント更新、専用ポップオーバー開閉・描画ロジック実装、外側クリック/Esc連動 |
| `frontend/js/common.js` | 必要に応じたDOM要素キャッシュの追加 |
| `VERSION` | `1.84` → `1.85` へインクリメント |
| `MANUAL.md` | 操作マニュアルの選択ツールバー（フローティングバー）操作説明を v1.85 に同期更新 |

---

## 3. 詳細実装設計

### 3.1 HTML構造 (`frontend/index.html`)

フローティングバー内のボタンを `.floating-action-group` で囲み、その子要素として各ポップオーバーを配置する。
```html
<div class="floating-action-group">
  <button class="btn btn-secondary btn-sm" id="floatingAddTagBtn" title="選択中の写真にタグを付ける">
    <span class="btn-icon">🏷️</span>
    <span class="btn-label">タグを付ける</span>
  </button>
  <div class="floating-popover" id="floatingTagPopover" style="display: none;">
    <div class="floating-popover-header">
      <span class="floating-popover-title">🏷️ タグを付ける</span>
      <button class="floating-popover-close" id="closeFloatingTagPopoverBtn" title="閉じる">&times;</button>
    </div>
    <div class="floating-popover-body">
      <div class="popover-input-group">
        <input type="text" id="floatingTagInput" placeholder="新しいタグ名..." autocomplete="off">
        <button class="btn btn-primary btn-xs" id="floatingConfirmTagBtn">付与</button>
      </div>
      <div class="popover-section-label">既存タグから選択</div>
      <div class="popover-tree-container" id="floatingTagTreeContainer">
        <!-- JSで動的生成 -->
      </div>
    </div>
  </div>
</div>
```
テイクアウトも同様のグループ構造で配置。

### 3.2 CSSスタイル (`frontend/css/style.css`)

- `.floating-action-group`: `position: relative; display: inline-flex;`
- `.floating-popover`:
  - `position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%);`
  - `width: 290px; max-width: calc(100vw - 32px); max-height: 380px;`
  - `background: rgba(22, 27, 34, 0.96); backdrop-filter: blur(20px);`
  - `border: 1px solid var(--accent-primary); border-radius: 12px;`
  - `box-shadow: 0 12px 36px rgba(0, 0, 0, 0.7), 0 0 20px var(--accent-glow);`
  - `z-index: 4200;`
  - 下向きの矢印（キャレット擬似要素）でボタンを指し示す。
  - アニメーション: `slideUpPopover 0.2s cubic-bezier(0.16, 1, 0.3, 1)`

### 3.3 JavaScriptロジック (`frontend/js/selection.js`)

- `toggleFloatingTagPopover()`:
  - テイクアウトポップオーバーを閉じる。
  - ポップオーバーの表示/非表示をトグル。
  - 表示時はタグツリーを描画（`renderFloatingTagTree()`）し、タグ入力欄にフォーカス。
- `toggleFloatingImportPopover()`:
  - タグポップオーバーを閉じる。
  - ポップオーバーの表示/非表示をトグル。
  - 表示時はフォルダ一覧を取得・描画（`loadAndRenderFloatingImportFolders()`）し、フォルダ入力欄にフォーカス。
- `closeAllFloatingPopovers()`:
  - すべてのフローティングポップオーバーを非表示化。
- ドキュメント全体の `click` イベントで、フローティングバー・ポップオーバー外をクリックした場合は閉じる。
- `keyup` で `Esc` が押されたら閉じる。
- 写真選択が解除されたとき（`clearSelection()`）にも確実に閉じる。

---

## 4. 検証手順

1. **基本選択テスト**:
   - サムネイルを複数選択し、画面下部にフローティングバーが表示されることを確認。
2. **タグ付けポップオーバーテスト**:
   - 「🏷️ タグを付ける」をクリック → ボタン直上に吹き出し型ポップオーバーが表示されること（右クリックメニューが出ないこと）。
   - 新規タグ名を入力して「付与」（またはEnter）→ 選択写真にタグが付与され、ポップオーバーが閉じること。
   - 既存タグツリーのタグをクリック → 選択写真にタグが付与され、ポップオーバーが閉じること。
3. **テイクアウトポップオーバーテスト**:
   - 「📤 テイクアウト」をクリック → ボタン直上に吹き出し型ポップオーバーが表示されること（右クリックメニューが出ないこと）。
   - 「take_out フォルダを開く」をクリック → エクスプローラーでフォルダが開くこと。
   - 送り先フォルダ（直下またはサブフォルダ）をクリック → 選択中のJPGがコピーされ、トースト通知が出てポップオーバーが閉じること。
4. **排他・クローズテスト**:
   - タグポップオーバーを開いた状態でテイクアウトを押すと、タグが閉じてテイクアウトが開くこと。
   - 画面の空いている場所をクリックするとポップオーバーが閉じること。
   - Escキーを押すとポップオーバーが閉じること。
   - 「解除」ボタンまたは選択全解除でポップオーバーが閉じること。
5. **右クリックコンテキストメニューテスト**:
   - 写真カード上で右クリックした際、従来の右クリックコンテキストメニューが問題なく動作すること（回帰がないこと）。
