# 実装計画書: 左ペイン（サイドバー）の表示・非表示トグル機能 (v1.71)

## 1. ユーザー要望と対応方針
- **要望**: 「左ペインを非表示にも出来るように、、、はムリ？」
- **回答・方針**: **完全に対応可能**。右ペイン（詳細インスペクタ）と同様に、ユーザーがワンクリックまたはキーボードショートカットで左ペイン（サイドバー）を非表示／再表示できるようにする。
- **UXのこだわり**:
  1. **ヘッダーボタン**: ヘッダー左側（ロゴのすぐ右、サイドバーの真上）に `#toggleSidebarBtn`（アイコン付きトグルボタン）を配置。ON/OFF状態が明瞭に点灯。
  2. **サイドバー内折りたたみボタン**: サイドバー上部バー（`sidebar-top-bar`）右端に `◀` ボタンを設置し、サイドバーを見ているときにも素早く畳める。
  3. **キーボードショートカット**: `[` または `B`（および `Ctrl+B`）でキーボードから瞬時に開閉。
  4. **境界線ハンドルの自動非表示**: サイドバー非表示時は境界線リサイズハンドルも消え、写真グリッドが画面左端まで広がる。
  5. **幅の記憶・復元**: 再表示時は、直前に設定・リサイズされていた幅をそのまま復元。状態（開/閉）は `localStorage` に保存され、リロード後も維持。
  6. **グリッド追従**: 開閉時に `window.resize` イベントを発火し、仮想スクロールやMasonryグリッドが自動的に最適な横幅に再計算される。

---

## 2. 改修詳細

### ① `frontend/index.html`
- `.header-left` 内のロゴ右側に `#toggleSidebarBtn` を追加:
  ```html
  <button id="toggleSidebarBtn" class="btn btn-icon-toggle active" title="左ペイン（サイドバー）を開閉 ([キー または Bキー)">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <line x1="9" y1="3" x2="9" y2="21"/>
    </svg>
    <span id="sidebarToggleLabel" class="btn-label">サイドバー</span>
  </button>
  ```
- `.sidebar-top-bar` の右端に `#sidebarCloseBtn` を追加:
  ```html
  <button class="btn btn-icon-only btn-sm sidebar-close-btn" id="sidebarCloseBtn" title="サイドバーを非表示にする ([ または B)">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
  </button>
  ```
- `#helpModal` のショートカット表に `[` / `B` を追加。
- バージョンキャッシュバスター `?v=1.71` および `#appVersion` を更新。

### ② `frontend/css/style.css`
- `.sidebar.accordion-sidebar.is-collapsed`: `display: none !important;` を追加。
- `.sidebar-close-btn`: ホバー効果とサイズを定義。
- レスポンシブルール（幅1350px以下）に `#sidebarToggleLabel` の `display: none;` を追加。

### ③ `frontend/js/common.js`
- `state.isSidebarOpen`: `localStorage.getItem('pm_sidebar_open') !== 'false'` で初期化。
- `elements.toggleSidebarBtn`, `elements.sidebarCloseBtn` を登録。

### ④ `frontend/js/app.js`
- `toggleSidebar(forcedState)` を実装。
- 初期化時に `toggleSidebar(state.isSidebarOpen)` を実行して前回状態を反映。
- `toggleSidebarBtn` および `sidebarCloseBtn` のクリックリスナーを登録。
- `keydown` イベントリスナーで `[` および `b` / `B` / `Ctrl+B` を検知して `toggleSidebar()` を呼び出し。

### ⑤ ドキュメント & マニュアル
- `VERSION`: `1.71` に更新。
- `MANUAL.md`: サイドバー開閉機能とショートカットの追記。
- `walkthrough.md` の作成。
