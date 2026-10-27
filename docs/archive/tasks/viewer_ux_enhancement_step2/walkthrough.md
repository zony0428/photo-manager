# Walkthrough：ステップ2 基本ビューア体験の強化（他ソフト比較での弱点解消）

Picasa / FastStone / XnView / Lightroom 等の定番写真ビューア・管理ソフトと比較した際に弱点となっていた4つの基本体験を強化しました。

---

## 1. 主な改修内容

### ① 一覧グリッド画面での矢印キー移動（`←` `→` `↑` `↓` ＆ `Shift + 矢印` での範囲選択）
- **対象ファイル**: [app.js](../../../../frontend/js/app.js), [selection.js](../../../../frontend/js/selection.js), [common.js](../../../../frontend/js/common.js)
- **改善内容**:
  - 一覧グリッド表示中（ライトボックスを閉じている状態）にキーボードの `←` `→` `↑` `↓` キーで写真を移動できる [`navigateGridByArrow`](../../../../frontend/js/app.js#L2697-L2837) を実装しました。
  - 上下移動（`↑` / `↓`）では各カードの中心座標 (`getBoundingClientRect()`) を計算するため、**「標準グリッド」「びっしり（Justified：カード幅が可変）」「スライドマウント」のどのレイアウトでも、視覚的に真上・真下にある写真へ自然に移動**します（未描画チャンクに近づいた場合は自動で追加描画し、画面外に出ないよう自動スクロールします）。
  - 移動するたびに右インスペクタのプレビュー・ヒストグラム波形・EXIF・マップがリアルタイムに追従します。
  - `Shift + 矢印キー` で起点（`state.selectionAnchorIndex`）からの連続範囲選択が可能です。
  - さらに、単一選択中に `3`（棄）キーを押して写真が一覧から隠れた際、**同じ位置の次の写真へ自動的にフォーカスを引き継ぐ**よう改善し、一覧画面のまま片手で連続選別ができるようになりました。

---

### ② 画像調整画面の「👁️ 元画像と比較（Before/After）」＆「トーン調整（3項目）のコピー / 一括ペースト」
- **対象ファイル**: [index.html](../../../../frontend/index.html), [modals-features.css](../../../../frontend/css/modals-features.css), [adjust.js](../../../../frontend/js/adjust.js), [selection.js](../../../../frontend/js/selection.js), [photos.py](../../../../server/database/photos.py), [app.py](../../../../server/app.py)
- **改善内容**:
  - **👁️ 元画像と比較（Before / After）**:
    - 画像調整モーダル (`#imageAdjustModal`) のヘッダーに **「👁️ 元画像と比較 (`\`)」ホールドボタン**を追加しました。
    - ボタンをマウス/タッチで押している間、またはキーボードの <kbd>\</kbd>（円マークキー）や <kbd>Space</kbd> キーを長押ししている間だけ、調整前の無加工状態（Before）と元ヒストグラム波形を表示し、左上に「👁️ 元画像 (Before)」バッジを表示します。
  - **🎨 トーン調整（明るさ・コントラスト・彩度）のコピー＆一括ペースト**:
    - ご指定の仕様に基づき、コピー＆ペーストの対象を**「トーン調整3項目（明るさ `brightness`・コントラスト `contrast`・彩度 `saturation`）のみ」**に限定しました（水平傾き `fine_angle`・90度回転 `rotation`・切り抜き枠 `crop_*` は除外し、ペースト先の写真が持つ既存の構図・回転・傾きを一切壊しません）。
    - 画像調整モーダル内の「📋 トーンをコピー」「🎨 トーンをペースト」ボタンのほか、一覧画面・ライトボックスでのショートカット（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> でコピー ／ <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> で一括ペースト）、右クリックメニュー「✂ 調整と回転 ▶」、および下部選択バー「↻ 回転」ポップオーバー内の「🎨 トーン調整を一括ペースト」から複数枚へ一括適用できます。

---

### ③ `Ctrl + C`（＆右クリック）で選択中の写真をクリップボードへ画像コピー
- **対象ファイル**: [adjust.js](../../../../frontend/js/adjust.js), [selection.js](../../../../frontend/js/selection.js), [app.js](../../../../frontend/js/app.js), [index.html](../../../../frontend/index.html)
- **改善内容**:
  - 一覧画面やライトボックス拡大中に <kbd>Ctrl</kbd> + <kbd>C</kbd> を押すか、右クリックメニューの **「📋 画像をクリップボードにコピー (Ctrl+C)」** をクリックすると、[`copyPhotoImageToClipboard`](../../../../frontend/js/adjust.js#L1142-L1225) により**非破壊の回転・傾き・切り抜き・トーン調整がすべて反映された状態の画像**を PNG としてOSクリップボードへコピーします。
  - わざわざファイル書き出しを行わなくても、SNSの投稿画面やチャット、資料作成アプリへそのまま <kbd>Ctrl</kbd> + <kbd>V</kbd> で貼り付けられます（※画面上のEXIF文字列などをマウスでテキスト選択している場合は、標準のテキストコピーが優先されます）。

---

### ④ ソート順（12種類）の拡充 ＆ ビューヘッダー属性フィルタピル（すべて / RAW / 調整済）
- **対象ファイル**: [index.html](../../../../frontend/index.html), [grid-lightbox.css](../../../../frontend/css/grid-lightbox.css), [app.js](../../../../frontend/js/app.js), [presets.js](../../../../frontend/js/presets.js), [photos.py](../../../../server/database/photos.py), [app.py](../../../../server/app.py)
- **改善内容**:
  - **ソート順の拡充（4種類 → 12種類）**:
    - `#sortBySelect` およびバックエンドの [`get_photos()`](../../../../server/database/photos.py#L469-L485) に、以下の並び順を追加しました（Exif未記録のNULL写真は常に末尾へ回るよう制御）：
      1. 新しい順 (撮影日) / 2. 古い順 (撮影日) / 3. 評価の高い順
      4. ファイル名 (A→Z) / 5. ファイル名 (Z→A)
      6. サイズ (大きい順) / 7. サイズ (小さい順)
      8. 焦点距離 (広角→望遠) / 9. 焦点距離 (望遠→広角)
      10. F値 (開放→絞込) / 11. ISO感度 (高い順) / 12. ISO感度 (低い順)
  - **属性フィルタピル（`すべて` / `RAW` / `✂ 調整済`）**:
    - メインビュー上部ヘッダーの評価フィルタの左隣に、コンパクトな切替ピル（`すべて` / `RAW` / `✂ 調整済`）を配置しました。
    - ワンクリックで「RAWファイル（およびRAW+JPGペア）のみ」や「非破壊調整（回転・傾き・切り抜き・トーン）を行った写真のみ」を抽出でき、適用中フィルタチップ・フィルタ全解除・プリセット保存とも連動します。

---

## 2. 検証結果

`.\python\python.exe` で自動検証スクリプトを実行し、以下の全項目が正常にパスすることを確認しました：
1. **バックエンドSQL・API検証**:
   - 全12種類の `sort_by` オプションおよび `attr_filter`（`None`, `'all'`, `'raw'`, `'adjusted'`）が SQLite 上でエラーなく高速実行されることを確認。
   - `batch_update_photo_tone` を実行した際、既存の `rotation`（90°）、`fine_angle`（3.5°）、`crop_*`（0.8）が一切上書きされずに保持され、`brightness` / `contrast` / `saturation` の3項目のみが正確に更新されることを確認。
2. **フロントエンドDOM・JS・日英辞書・マニュアル検証**:
   - `frontend/index.html` の新規要素ID 11個・ソートoption 12個、`app.js` / `adjust.js` / `selection.js` / `common.js` / `presets.js` / `i18n.js` の全関数およびイベント結線を確認。
   - `MANUAL.md` と `frontend/index.html` (`#helpModal`)、`docs/knowledge/feature-code-map.md` の同期更新を確認。
