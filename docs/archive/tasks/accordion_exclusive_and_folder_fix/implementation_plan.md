# 実装計画書: 排他的アコーディオン制御とフォルダヘッダー表示修正 (v1.57)

## 1. 背景と課題分析
1. **フォルダヘッダーの表示崩れ**:
   - フォルダアコーディオンのヘッダー内に `🤖 OFF`、`⚙️`、`🔄`、`展開`、`閉じる` の5つのボタンが詰め込まれており、サイドバー幅（260px〜275px）に対して幅が不足。
   - その結果、「フォルダ」というタイトル文字が `flex: 1; overflow: hidden;` により幅0に押し潰されて消失し、ボタン群が2段に折り返されてヘッダーの高さが歪む深刻なUI崩れが発生していた。
   - **対策**: これらの操作ボタンはフォルダ一覧を操作するためのツールバーであるため、ヘッダーからは除去し、フォルダが開いたときに見える `.accordion-body` の最上部（フォルダツリーの上）に `folder-actions-bar` として整然と配置する。これにより、ヘッダーは他の項目と同様に「▶ 📁 フォルダ」とシンプルかつ美しく正立表示される。

2. **排他的アコーディオン制御**:
   - 現在のコードは複数セクションを同時に開いたままにできるマルチオープン方式。
   - ユーザーの要望「展開出来るメニューは一つに絞ろう。排他的に。」に基づき、1つのセクションを開いたら他の開いているセクションは自動的に閉じる排他アコーディオン（Exclusive Accordion）に変更する。
   - すでに開いているセクションのヘッダーを再度クリックした場合は折りたたむ（全閉じ可能）。
   - `localStorage` に保存する状態も、複数フラグのオブジェクトから「現在アクティブなセクション名（文字列または null）」へとシンプルに洗練させる。

---

## 2. 変更対象ファイルと改修方針

### ① `frontend/index.html`
- **フォルダヘッダー (`#accordionItem-folder`)**:
  - ヘッダー内の `.folder-tree-actions` を `.accordion-body` 内の最上部（`#folderTreeContainer` の直前）へ移動。
  - ヘッダーは `<span class="accordion-arrow">` + `<span class="accordion-icon">` + `<span class="accordion-title">フォルダ</span>` の標準構成にする。
- **上部バー (`.sidebar-top-bar`)**:
  - 排他制御に伴い、全展開ボタンは不要となるため、全折りたたみ専用アイコンボタン（またはシンプルな「折りたたみ」）とするか、あるいは「フィルタ全解除」ボタンを幅いっぱいにすっきりと配置。

### ② `frontend/css/style.css`
- `.folder-tree-actions` を `.folder-actions-bar` にリファイン。
  - `margin-bottom: 8px; display: flex; align-items: center; justify-content: flex-end; gap: 4px;`
  - ボタンデザイン（`.btn-mini-text`）を上品に整え、Hinomaru Inkデザインに調和させる。
- `.accordion-header` のタイトルの可視性と余白を再点検。

### ③ `frontend/js/app.js`
- `initSidebarAccordion()`:
  - 排他制御ロジックへの切り替え。
  - `activeSection = 'quick'`（初期値）。
  - `toggleSection(sectionName)`:
    - クリックされたセクションが現在開いているセクションなら閉じる（`activeSection = null`）。
    - 異なるセクションなら、開いているセクションを閉じて新しいセクションを開く（`activeSection = sectionName`）。
  - `localStorage`（キー: `pm_accordion_active_section`）に `activeSection` を保存・復元。
  - `openSidebarSection(sectionName)` も排他制御に従って対象のみを開くように更新。

### ④ バージョン & マニュアル
- `VERSION`: `1.57` にカウントアップ。
- `frontend/index.html`: `?v=1.57` に更新。
- `MANUAL.md`: 排他的アコーディオンの動作仕様を反映。

---

## 3. 検証計画
1. ブラウザサブエージェントにより `http://127.0.0.1:8088` で検証。
2. フォルダヘッダーに「フォルダ」という文字が正しく表示され、ボタンの2段落ちが完全に解消されているか確認。
3. フォルダを開いたときに、ツリー上部に操作ボタンが美しく配置されているか確認。
4. クイックアクセス、フォルダ、タグ、年月、カメラ、プリセット、検索をクリックした際、常に1つだけが排他的に展開され、他がスムーズに閉じることを確認。
5. ページリロード後も開いていたセクションが復元されることを確認。
6. 和紙・夜墨両テーマでの外観を確認しスクリーンショットを撮影。
