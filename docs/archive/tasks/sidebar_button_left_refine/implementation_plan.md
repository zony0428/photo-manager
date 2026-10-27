# 実装計画書: サイドバートグルボタンの左端配置・アイコン化・控えめ配色 (v1.72)

## 1. ユーザー要望と対応方針
- **要望**: 「'サイドバー'のテキスト無しにして、PHOTOMANAGERのロゴよりも左(左端)に配置するとどうなる？もう少し控えめな色にして。」
- **方針**:
  1. **左端配置**: `header-left` 内でロゴより前（最左端）に配置。画面左上端の起点にサイドバーボタンが来ることで、直下の左サイドバーとの一体感が生まれ、VS Codeや現代のアプリと同様に極めて自然な操作導線になります。
  2. **アイコンのみ**: テキスト「サイドバー」を除去し、正方形のアイコンボタン（32px×32px）にスッキリと簡素化。
  3. **控えめな上品配色**: 派手な朱色ベタ塗り（`#dc2626`）を廃止し、透過アクセントティント（`rgba(225, 77, 42, 0.12)`）と朱色アイコン線を採用。ロゴの視認性を邪魔せず、ツールバーに美しく馴染みながら、ON/OFF状態が明瞭に伝わる上品なデザインにします。

---

## 2. 改修詳細

### ① `frontend/index.html`
- `.header-left` の先頭に `#toggleSidebarBtn` を移動:
  ```html
  <div class="header-left">
    <!-- 左ペイン（サイドバー）トグルボタン（左端アイコンのみ） -->
    <button id="toggleSidebarBtn" class="btn btn-icon-only btn-sidebar-toggle active" title="サイドバーを開閉 ([キー または Bキー)" aria-label="サイドバーを開閉">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </button>

    <div class="logo">
      ...
  ```
- キャッシュバスターとバージョン表記を `v1.72` に更新。

### ② `frontend/css/style.css`
- `#toggleSidebarBtn` 専用スタイルを定義:
  - 通常（非表示時）: 背景透明、ボーダー透明、文字色 `var(--text-muted)`。ホバーで控えめにハイライト。
  - アクティブ（表示時）: 背景 `rgba(225, 77, 42, 0.12)`、ボーダー `rgba(225, 77, 42, 0.28)`、アイコン色 `var(--accent-primary)`。
  - 和紙テーマ対応（ライトモードで自然な淡いティント）。

### ③ ドキュメント & マニュアル
- `VERSION`: `1.72` に更新。
- `MANUAL.md`: ヘッダー左端配置についての説明を同期。
- `walkthrough.md` の作成。
