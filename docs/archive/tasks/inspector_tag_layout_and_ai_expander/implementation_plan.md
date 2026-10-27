# 実装計画: インスペクタのタグツリー常時表示化およびAIタグエキスパンダ化

## 1. 目的と要望の整理
- **ユーザー要望**:
  1. 「タグツリーから選ぶ」のセクションは外枠エキスパンダにしなくて良い（常時表示にする）。
  2. むしろ「AIタグ」はエキスパンダの中に格納して、「タグツリーから選ぶ」セクションより下に配置する。
- **改修方針**:
  - 先ほどの改修で「タグツリー内部のフォルダごとに折りたたみ・展開」ができるようになったため、外枠自体の折りたたみエキスパンダ（`inspector-quick-header`）は不要となり、一括編集画面と同様に見出しラベル＋常時表示ツリーへと統合します。
  - ヘッダー右上にあった「🤖 AIタグ」ボタンをタグタブの最下端（タグツリーの下）へ移動し、色合いパレットと同様の統一された開閉エキスパンダ（デフォルト閉じ）として再構築します。これにより、普段の手動タグ作業で視界のノイズにならず、使いたい時に開いて確実に実行できるようになります。

---

## 2. 変更対象ファイルと詳細

### 1. `frontend/index.html`
- `inspectorTabPaneTags`:
  - ヘッダー内から `inspectorAiTagBtn` を除去し、`inspectorTagCount`（件数バッジ）のみにする。
  - `inspector-quick-tags`:
    - `inspector-quick-header`（`▼ タグツリーから選ぶ`）を削除。
    - `<div class="inspector-label" style="margin-top: 14px; margin-bottom: 6px;">タグツリーから選ぶ</div>` に置き換え。
    - `inspectorQuickTree` の初期インラインスタイル（`style="display:none"` 等）を除去し、常に表示。
  - タグツリー直下に「AI自動タグ付け」エキスパンダを追加：
    - `inspectorAiTagBlock.inspector-color-palette-block.color-palette-expander`
    - ヘッダー: `inspectorAiTagHeader`（`▶ 🤖 AI自動タグ付け`）
    - ボディ: `inspectorAiTagBody`（説明文 + 幅100%の `inspectorAiTagBtn`）

### 2. `frontend/js/common.js`
- `elements` に以下を追加：
  - `inspectorAiTagBlock: document.getElementById('inspectorAiTagBlock')`
  - `inspectorAiTagHeader: document.getElementById('inspectorAiTagHeader')`
  - `inspectorAiTagArrow: document.getElementById('inspectorAiTagArrow')`
  - `inspectorAiTagBody: document.getElementById('inspectorAiTagBody')`

### 3. `frontend/js/inspector.js`
- `initInspectorEvents`:
  - `inspectorAiTagHeader` のクリック開閉イベントを登録（色合いパレットと同様にクリックで `is-open` トグル、矢印切り替え、ボディの `display` 切り替え）。
  - 旧 `inspectorQuickHeader` の開閉イベント登録を除去。

---

## 3. 検証手順
1. 単一写真を選択してインスペクタのタグタブを開く。
2. ヘッダーにAIボタンがなく、タグ件数のみすっきり表示されていることを確認。
3. 「タグツリーから選ぶ」が最初から常時表示され、フォルダごとの折りたたみ・展開がそのまま動作することを確認。
4. その下に「▶ 🤖 AI自動タグ付け」のエキスパンダが存在し、初期状態では閉じていることを確認。
5. エキスパンダをクリックするとスムーズに開き、説明文と「🤖 この写真をAIで自動タグ付け」ボタンが現れることを確認。
6. ボタンをクリックしてAIタグが実行され、結果が反映されることを確認。
