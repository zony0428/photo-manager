# 実装計画書: インスペクタトグルボタンの右端配置・アイコン化・控えめ配色 (v1.73)

## 1. ユーザー要望と対応方針
- **要望**: 「良いね。インスペクタについても、左右反転して同じ事をしようよ。終了ボタンとはある程度隙間(セパレータが良いかな)を空けてね。」
- **方針**:
  1. **左右反転・最右端配置**:
     - 左端に「左サイドバー開閉ボタン」があるのと完全に呼応させ、**画面の最右端に「右インスペクタ開閉ボタン」を配置**。
     - 直下の右インスペクタパネルとの垂直方向の対応関係が一致し、直感的で美しい左右対称（Symmetry）UIを実現します。
  2. **終了ボタンとの分離（セパレータ設置）**:
     - 終了ボタン（`#openShutdownModalBtn`）とインスペクタボタンの間に縦セパレータ（`.toolbar-divider`）を挟み、適度な余白を設けることで、終了ボタンとの誤爆・誤操作を防止します。
  3. **アイコンのみ & 左右反転アイコン**:
     - テキスト「詳細」を除去し、32px×32px の固定正方形アイコンボタンに簡素化。
     - アイコンは左ボタン（四角＋左縦線）の左右反転となる「四角＋右縦線」のSVGを採用。
  4. **控えめで上品な配色**:
     - 派手な朱色ベタ塗りを廃止し、左サイドバーボタンと共通の「淡い朱色ティント（約12%）＋朱色アイコン線」を採用。両端で完全にトーン＆マナーを統一します。

---

## 2. 改修詳細

### ① `frontend/index.html`
- 旧位置（情報ボタンの横）から `#toggleInspectorBtn` を削除。
- 終了ボタン（`#openShutdownModalBtn`）の直後に縦セパレータと右端ボタンを配置:
  ```html
  <!-- アプリ終了ボタン -->
  <button id="openShutdownModalBtn" class="btn btn-secondary btn-shutdown" title="Photo Manager を終了する">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
    <span class="btn-label">終了</span>
  </button>

  <!-- 縦セパレータ -->
  <div class="toolbar-divider"></div>

  <!-- 右ペイン（インスペクタ）トグルボタン（最右端アイコンのみ） -->
  <button id="toggleInspectorBtn" class="btn btn-icon-only btn-inspector-toggle active" title="写真の詳細情報パネル（インスペクタ）を開閉 (Dキー)" aria-label="詳細情報パネルを開閉">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <line x1="15" y1="3" x2="15" y2="21"/>
    </svg>
  </button>
  ```
- キャッシュバスターとバージョン表記を `v1.73` に更新。

### ② `frontend/css/style.css`
- `.toolbar-divider` を新設（高さ20px、border-soft色、左右マージン4px）。
- `#toggleSidebarBtn.btn-sidebar-toggle` と `#toggleInspectorBtn.btn-inspector-toggle` を共通ルールで統一。
- メディアクエリから `#inspectorToggleLabel` / `#toggleInspectorBtn` を整理。

### ③ ドキュメント & マニュアル
- `VERSION`: `1.73` に更新。
- `MANUAL.md`: ヘッダー最右端配置およびセパレータについての説明を更新。
- `walkthrough.md` の作成。
