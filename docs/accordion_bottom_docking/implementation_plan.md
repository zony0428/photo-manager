# 実装計画書: 開いているセクションより下のメニューの下端固定 (v1.58)

## 1. 課題と目的
- **現状の課題**:
  - フォルダツリーやタグリストなど、中身が縦に長いセクションを展開すると、アコーディオン全体が縦スクロールとなり、開いているセクションより下のメニュー（タグ、タイムライン、カメラ、プリセット、検索）が画面外へ押し流されて見えなくなってしまう。
  - 別のメニューへ切り替えるために、ツリーの一番下まで長いスクロールが必要となり、操作効率が低下する。
- **目的**:
  - 展開中のセクションがサイドバーの縦スペースを最大限活用して内部スクロール（`overflow-y: auto`）するようにし、
  - **開いているセクションより下にあるメニューヘッダー群を、常に表示エリアの最下端（下部）に固定（ドッキング）**させる。
  - これにより、フォルダツリーが何千行あろうとも、他の全メニュー（上部メニューも下部メニューも）が常に画面内に固定表示され、ワンクリックで瞬時に切り替えられるハイエンドな操作性を実現する。

---

## 2. アーキテクチャと実装詳細 (CSS Flexbox)

ブラウザのネイティブFlexboxエンジンを活用し、JavaScriptによる高さ計算やDOM操作を行わずに、純粋なCSSレイアウトのみで高速・堅牢（リサイズ追従60fps）に実現する。

```text
┌──────────────────────────────────────┐
│ [🔄 フィルタ全解除]             [⏷] │ ← 上部バー (flex-shrink: 0)
├──────────────────────────────────────┤
│ ▶ ⚡ クイックアクセス                │ ← 上部メニュー (flex-shrink: 0)
├──────────────────────────────────────┤
│ ▼ 📁 フォルダ                        │ ← 開いているセクション (flex: 1)
├──────────────────────────────────────┤
│ [🤖 OFF][⚙][🔄]   [展開][閉じる]     │
│ 📁 ピクチャ                          │ ↕ この領域 (.accordion-body) だけが
│ 📁 ドキュメント                      │   flex: 1; min-height: 0;
│ 📁 デスクトップ                      │   overflow-y: auto; で独立スクロール！
│ 🖴 C:                               │
│ 🖴 D:                               │
├──────────────────────────────────────┤
│ ▶ 🏷️ タグ (アルバム)                │ ← 下部メニュー群 (flex-shrink: 0)
│ ▶ 📅 タイムライン (年月)             │   サイドバー最下端に美しくドッキング！
│ ▶ 📷 カメラ機種                      │   （ツリーの長さに関わらず常時視認＆クリック可能）
│ ▶ ★ フィルタプリセット               │
│ ▶ 🔍 ファイル名検索                  │
└──────────────────────────────────────┘
```

### CSS定義 (`frontend/css/style.css`):
```css
/* アコーディオン本体コンテナ: 親の高さいっぱいに広げ、外側スクロールは抑止 */
.sidebar-accordion {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 閉じているアイテム: 上部または下端にピタッと固定 */
.accordion-item {
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}

/* 展開中のアイテム: 残りスペースをすべて専有 */
.accordion-item.is-open {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.accordion-item.is-open .accordion-header {
  flex-shrink: 0;
}

/* 展開中のボディ: 内部スクロール */
.accordion-item.is-open .accordion-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}

/* 細幅の上品なカスタムスクロールバー */
.accordion-body::-webkit-scrollbar {
  width: 5px;
}
.accordion-body::-webkit-scrollbar-track {
  background: transparent;
}
.accordion-body::-webkit-scrollbar-thumb {
  background: rgba(120, 120, 120, 0.25);
  border-radius: 3px;
}
.accordion-body::-webkit-scrollbar-thumb:hover {
  background: rgba(120, 120, 120, 0.45);
}
```

---

## 3. 検証計画
1. `VERSION` を `1.58` にカウントアップ、`index.html` のクエリを更新。
2. ブラウザサブエージェントにより `http://127.0.0.1:8088` で検証。
3. 「📁 フォルダ」を展開した際、下のメニュー（🏷️タグ、📅タイムライン、📷カメラ、★プリセット、🔍検索）がサイドバーの最下端に固定されているか確認。
4. フォルダツリーをスクロールしても、下のメニューが下端に留まったまま固定されているか確認。
5. 「🏷️ タグ」を展開した際、上のメニューは上部、タグ自身がスペースを満たし、下のメニューが最下端に固定されるか確認。
6. スクリーンショットを撮影して確認。
