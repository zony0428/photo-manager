# 実装計画: 複数写真タグ一括登録およびインスペクタタグ表示の不具合修正

## 1. 課題と原因分析

### 課題 1: インスペクタのタグセクションに設定したタグが表示されない
- **原因**:
  - `frontend/js/common.js` の `elements` オブジェクト定義において、`inspectorTagList: document.getElementById('inspectorTagList')` が欠落していた。
  - そのため `elements.inspectorTagList` が常に `undefined` となり、`inspector.js` の `renderInspectorTagChips(photo)` が先頭の `if (!elements.inspectorTagList || !photo) return;` で早期リターンしてしまっていた。
  - 結果として、単一写真を選択してもインスペクタ内のタグチップが一切描画されず、常に「タグなし」または空となっていた。

### 課題 2: 複数ファイル選択時のタグ一括登録ができない（「一括追加」ボタンが無反応）
- **原因**:
  - 同じく `frontend/js/common.js` の `elements` オブジェクト定義において、`batchAddTagBtn: document.getElementById('batchAddTagBtn')` が欠落していた。
  - そのため `elements.batchAddTagBtn` が `undefined` となり、`inspector.js` 末尾のクリックイベントリスナー登録 `if (elements.batchAddTagBtn) elements.batchAddTagBtn.addEventListener('click', executeBatchNewTag);` が実行されずスキップされていた。
  - 結果として、複数選択時にタグ名を入力して「一括追加」ボタンをクリックしても何も実行されなかった。

### 課題 3: 色タグの一括設定の動作と視認性
- **状況**:
  - カラーパレットをクリックした際のAPI呼び出し・データ反映ロジックは存在するが、
  - 一括インスペクタ下部の「選択写真に付いているタグ（`batchCommonTagsList`）」からカラータグが集計除外されていた。
  - さらに、設定されたか確認するために個別の写真を選択してインスペクタを見ても課題1のバグでタグが一切表示されなかったため、ユーザーから「色タグもダメかも」と見えていた。

---

## 2. 改修方針

1. **`frontend/js/common.js` の修正**:
   - `elements` オブジェクトに以下3つの欠落プロパティを登録する：
     - `inspectorBody: document.getElementById('inspectorBody'),`
     - `inspectorTagList: document.getElementById('inspectorTagList'),`
     - `batchAddTagBtn: document.getElementById('batchAddTagBtn'),`

2. **`frontend/js/inspector.js` の堅牢化・視認性改善**:
   - `renderInspectorTagChips`: `elements.inspectorTagList` に加え、フォールバック `document.getElementById('inspectorTagList')` を適用。
   - `executeBatchNewTag` / イベント登録: `elements.batchAddTagBtn` に加え、フォールバックを適用。
   - `showBatchInspector`: 「選択写真に付いているタグ」一覧（`batchCommonTagsList`）において、手動タグ・AIタグに加えてカラータグ（色ドット付き）も表示可能にし、色合いパレットを開かなくても選択中の全写真に付与されているタグ・色が一目で確認できるようにする。

---

## 3. 検証手順

1. 単一写真を選択して右ペインのインスペクタを開き、タグチップ（通常タグ・AIタグ）が正常に描画されることを確認。
2. ギャラリーで複数写真を選択（Ctrl+クリック）し、インスペクタが一括編集モードに切り替わることを確認。
3. 一括編集の「タグを一括付与」入力欄にタグ名を入力し、「一括追加」ボタンをクリックして即座に対象全写真にタグが付与されることを確認。
4. 色合いパレットからカラータイル（青・赤など）をクリックし、選択全写真に色タグが付与され、下のタグ一覧および写真カードに即時反映されることを確認。
5. 個別写真をクリックしてインスペクタを確認し、一括付与したタグが正常に表示されることを確認。
