# 実装計画: 左ペインタグフィルタセクションの調整 & クイックアクセス再編

## 1. 目的と変更内容
左ペイン（サイドバー）のUIレイアウト最適化のため、以下の調整を実施する。

1. **タグ種別タブの順序変更 & デフォルト手動化**:
   - 変更前: `すべて` | `👤 手動` | `🤖 AI` （デフォルト: `すべて`）
   - 変更後: `👤 手動` | `🤖 AI` | `すべて` （デフォルト: `👤 手動`）
2. **カラーフィルタのエキスパンダ化 & 最上部配置**:
   - セクション最上部に開閉可能なエキスパンダとして配置。初期状態は「閉じ」。開閉状態は `localStorage` に保持。
3. **タグ種別タブのインスペクタタブ仕様統一 (v1.80)**:
   - 右インスペクタの一体型アンダーラインタブデザインと完全同一の仕様・外観・背景色に統一。
   - ナビ背景: `rgba(0, 0, 0, 0.22)` / paper: `rgba(0, 0, 0, 0.04)`
   - アクティブ背景: `var(--bg-secondary, #1e2430)` / paper: `#fbf9f5`
   - 下線: `2px solid var(--accent-primary)`
4. **クイックアクセスパネルの再編 & フィルタプリセット統合 (v1.81)**:
   - クイックアクセスパネル（セクション 1）から評価フィルタ（`sidebarRatingFilterToggles`）およびショートカット案内（`shortcut-tip`）を割愛。
   - 旧セクション 6「★ フィルタプリセット」（現在の絞り込み条件保存＆保存済みセット一覧）の全機能をクイックアクセス内に移設・統合。
   - 独立した旧セクション 6 アコーディオンを削除し、サイドバー全体の縦スペースをすっきり集約。
5. **左右ペイン背景色・境界線の仕様統一 (v1.82)**:
   - 左サイドバー（`.sidebar.accordion-sidebar`）と右インスペクタ（`.inspector-pane`）の背景色および境界線スタイルを完全統一。
   - 通常時（夜墨モード）: `background: var(--bg-secondary)`、境界線 `1px solid var(--border-soft)`。
   - 和紙モード: `background: #fbf9f4`、境界線 `1px solid rgba(0, 0, 0, 0.08)`、インスペクタヘッダー `background: #f4efe6`。
6. **夜墨テーマの銀墨スレートダーク調色 (v1.83)**:
   - 「ほぼ真っ黒」だった夜墨テーマの左右ペイン（`--bg-secondary: #22201e`）を、ユーザー選択に基づき **銀墨スレートダーク (`#262c35`)** へ調色。
   - 漆黒スレートの中央グリッド（`--bg-primary: #16181b`）に対して左右ペインが立体的に浮かび上がり、境界線（`--border-color: #3d4756`, `--border-soft: #2f3642`）やテキスト視認性（`#f0f2f5`, `#9ca6b5`）を大幅に向上。
7. **サムネイル固定サイズ化（スライダー完全連動・ペイン開閉時のサイズ変動防止）(v1.84)**:
   - `.photo-grid` の `grid-template-columns` を `repeat(auto-fill, var(--thumbnail-size))` に変更（マウントモードも同様に `calc(var(--thumbnail-size) * 1.15)` に変更）。
   - これにより、サムネイルサイズはヘッダーのスライダー値に100%連動・固定され、サイドバーやインスペクタを開閉しても勝手に拡大縮小せず、列数のみが増減する挙動に統一。

---

## 2. 影響範囲・変更対象ファイル

| ファイルパス | 変更内容 |
|---|---|
| `frontend/index.html` | タグセクション構造更新、クイックアクセス内へのプリセット機能移設、評価・ショートカットセクション削除、旧セクション6削除、ヘルプモーダル更新、appVersion v1.84更新 |
| `frontend/css/style.css` | タグ種別タブのアンダーライン化・インスペクタ同一背景色適用、カラーエキスパンダのスタイル定義、右インスペクタの背景色・境界線統一（和紙/夜墨）、夜墨テーマの銀墨スレート調色（v1.83）、サムネイル固定サイズ化（v1.84） |
| `frontend/js/common.js` | `state.tagSourceFilter` 初期値を `'manual'` に設定、カラーエキスパンダDOM要素の追加、不要な `sidebarRatingFilterToggles` 要素キャッシュの除去 |
| `frontend/js/app.js` | クイックアクセス開閉時のプリセットチップ描画トリガー追加、カラーエキスパンダ開閉トグルロジック |
| `VERSION` | `1.78` → `1.79` → `1.80` → `1.81` → `1.82` → `1.83` → `1.84` へインクリメント |
| `MANUAL.md` | 操作マニュアルのサイドバー各セクション説明・プリセット保存手順、右インスペクタの背景色統一説明、v1.83スレートダーク調色、v1.84サムネイル固定サイズの更新 |

---

## 3. 詳細実装設計

### 3.1 クイックアクセスパネル構造
```html
<div class="accordion-item is-open" data-section="quick" id="accordionItem-quick">
  <div class="accordion-header" data-section="quick">...</div>
  <div class="accordion-body">
    <!-- ナビ項目（すべての写真、未分類の写真、接続中、未接続） -->
    <ul class="nav-list">...</ul>

    <!-- フィルタプリセット: 現在の条件 & 保存フォーム -->
    <div class="preset-create-section">...</div>

    <!-- フィルタプリセット: 保存済みセット一覧 -->
    <div class="preset-list-section">
      <div class="section-title">
        <span>保存済みセット</span>
        <span class="badge-sub" id="presetCountBadge">0件</span>
      </div>
      <div class="preset-list" id="presetListContainer">...</div>
    </div>
  </div>
</div>
```

### 3.2 左右ペイン背景色・境界線仕様 (v1.82〜v1.83)
- **夜墨モード (sumi / v1.83 銀墨スレートダーク)**:
  - 中央グリッド: `background: #16181b;`
  - 左ペイン: `background: #262c35; border-right: 1px solid #2f3642;`
  - 右ペイン: `background: #262c35; border-left: 1px solid #2f3642;`
  - 入力欄・サブ枠: `background: #303844;`
  - 文字色: `color: #f0f2f5;`（淡スレート: `#9ca6b5`）
- **和紙モード (paper)**:
  - 左ペイン: `background: #fbf9f4; border-right: 1px solid rgba(0, 0, 0, 0.08);`
  - 右ペイン: `background: #fbf9f4; border-left: 1px solid rgba(0, 0, 0, 0.08);`
  - 右ヘッダー: `background: #f4efe6; border-bottom: 1px solid rgba(0, 0, 0, 0.06);`

### 3.3 サムネイル固定サイズ仕様 (v1.84)
```css
.photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, var(--thumbnail-size));
  gap: 16px;
}

body.layout-mount .photo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, calc(var(--thumbnail-size) * 1.15));
  gap: 24px;
}
```

---

## 4. 検証計画
- HTML / JS / CSS の構文確認
- タグ種別タブがインスペクタタブと完全同一の背景色・アンダーラインで描画されること
- クイックアクセスパネル内に「現在の絞り込み条件」と「保存済みセット一覧」が正常に表示されること
- 旧セクション6がサイドバーから削除されていること
- 評価フィルタおよびショートカット案内がクイックアクセスから割愛されていること
- プリセットの保存・適用・削除がクイックアクセス内で正常に動作すること
- 右インスペクタの背景色・境界線が左サイドバーと完全に統一されていること（夜墨/和紙両テーマ）
- 夜墨テーマの左右ペインが `#262c35` で立体的に表示されること
- ペイン開閉時にサムネイルカードのサイズが一切変動せず、列数のみが増減すること
- バージョン `1.84` およびマニュアル記述の同期
