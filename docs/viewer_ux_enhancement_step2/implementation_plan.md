# 実装計画書：ステップ2「基本ビューア体験の強化」

## 1. 目的と概要
ステップ1でのUI交通整理に続き、定番の写真管理・ビューアソフト（Picasa / FastStone / Lightroom / Eagle 等）と比較した際に不足していた**基本ビューア体験の4大機能**を実装する。

1. **一覧グリッドでの矢印キー移動（`←` `→` `↑` `↓` ＆ `Shift + 矢印` での範囲選択）**
2. **画像調整モーダル (`#imageAdjustModal`) の「👁️ 元画像と比較（Before/After）」＆「トーン調整（明るさ・コントラスト・彩度）のコピー / 一括ペースト」**
3. **`Ctrl + C`（＆右クリックメニュー）でのクリップボードへの画像コピー**
4. **ソート順の拡充（サイズ・焦点距離・F値・ISO・ファイル名逆順）＆ 上部ビューヘッダーの属性フィルタピル（すべて / RAW / 調整済）**

---

## 2. 具体的な変更内容

### ① 一覧グリッドでの矢印キー移動（`frontend/js/app.js`, `frontend/js/selection.js`）
- **対象**: `state.currentPhotoIndex === -1`（一覧グリッド表示中）かつモーダル非表示時。
- **左右移動 (`ArrowLeft` / `ArrowRight`)**:
  - 現在のインデックスから `-1` / `+1` の写真へ移動。
- **上下移動 (`ArrowUp` / `ArrowDown`)**:
  - DOM上の `.photo-card` の矩形座標 (`getBoundingClientRect()`) を走査し、現在カードの1行上または1行下にあるカード群のうち、水平中心座標 (`centerX`) が最も近いカードのインデックスを特定する。これにより「グリッド」「びっしり（Masonry）」「マウント」のすべての表示モード、および任意のウィンドウ幅・サムネイルサイズで自然な上下移動が可能となる。
- **`Shift + 矢印` による連続範囲選択**:
  - `state.selectionAnchorIndex`（単一選択開始位置）から移動先インデックスまでの範囲を選択状態にし、下部フローティングバー・右インスペクタの複数選択ビューへ即座に連動させる。
- **単一移動時のインスペクタ連動＆自動スクロール**:
  - 移動先のカードを `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` で画面内に収め、右インスペクタが開いている場合は `showSingleInspector(photo)` でプレビュー・波形・EXIF・マップを即時更新する。

### ② 画像調整の「👁️ 元画像と比較」＆「トーン調整（明・比・彩）のコピー / 一括ペースト」
- **Before / After ホールド比較（`frontend/index.html`, `frontend/js/adjust.js`, `frontend/css/modals-features.css`）**:
  - 画像調整モーダルヘッダーに `#adjustCompareOrigBtn`（`👁️ 元画像と比較 (\)`）を追加。
  - ボタン押下中（ホールド）または `\` キー押下中は、トーンフィルタ（明るさ・コントラスト・彩度）と水平傾きを一時的に解除し、クロップ枠を隠して無加工の元画像を表示する（ステージ左上に `Before (元画像)` バッジを表示）。
- **トーン調整のコピー＆一括ペースト（`server/database/photos.py`, `server/app.py`, `frontend/js/adjust.js`, `frontend/js/selection.js`, `frontend/js/app.js`）**:
  - **コピー対象**: ユーザー指定に基づき、写真ごとに異なる構図クロップ・90°回転・水平傾きは除外し、**トーン3項目（明るさ `brightness`・コントラスト `contrast`・彩度 `saturation`）のみ**を対象とする。
  - **バックエンドAPI**: `POST /api/photos/batch-adjust-tone` を新設。指定された `photo_ids` に対して既存の `rotation`, `fine_angle`, `crop_*` を保持したまま `brightness`, `contrast`, `saturation` のみを一括更新し、並列でサムネイルキャッシュを再生成する。
  - **フロントエンド導線**:
    - 画像調整モーダルヘッダー: `📋 トーンをコピー` (`#adjustCopyToneBtn`) / `🎨 ペースト` (`#adjustPasteToneBtn`)
    - キーボードショートカット: `Ctrl + Shift + C`（トーンをコピー）、`Ctrl + Shift + V`（選択写真へトーンを一括ペースト）
    - 右クリックメニュー (`#contextMenu`): `📋 トーン調整をコピー` (`#ctxCopyToneAdjust`) / `🎨 トーン調整をペースト` (`#ctxPasteToneAdjust`)
    - 下部フローティング選択バー「⋯ その他」(`#floatingMorePopover`): `🎨 トーン調整を一括ペースト` (`#floatingBatchPasteToneBtn`)

### ③ `Ctrl + C` で選択中の写真をクリップボードへ画像コピー（`frontend/js/selection.js`, `frontend/js/app.js`, `frontend/index.html`）
- **動作**:
  - 一覧グリッドまたはライトボックスで `Ctrl + C`（`Ctrl+Shift+C` ではない通常のコピー）を押した際、または右クリックメニューの `📋 画像をクリップボードにコピー (Ctrl+C)` (`#ctxCopyImageClipboard`) を実行した際、対象写真の `/api/photo/{id}/view` を読み込み、Canvas経由で非破壊調整（回転・傾き・クロップ・トーン）反映済みの `image/png` Blob を生成して `navigator.clipboard.write()` でOSクリップボードに格納する。

### ④ ソート順の拡充 ＆ ビューヘッダー属性フィルタピル（`server/database/photos.py`, `server/app.py`, `frontend/index.html`, `frontend/js/app.js`, `frontend/js/common.js`）
- **ソート順 (`#sortBySelect`)**:
  - 既存の4種に加え、`file_name DESC`（ファイル名 Z→A）、`file_size DESC`（サイズ大→小）、`file_size ASC`（サイズ小→大）、`focal_length ASC`（焦点距離 広角→望遠）、`focal_length DESC`（焦点距離 望遠→広角）、`f_number ASC`（F値 開放→絞り）、`iso DESC`（ISO 高い順）、`iso ASC`（ISO 低い順）を追加。
- **属性フィルタピル（`#attrFilterToggles`）**:
  - 上部ビューヘッダー（`.view-actions` 内、評価フィルタの左横）に `すべて` / `RAW` / `調整済` のピルボタンを配置。
  - バックエンド `get_photos()` の `attr_filter` パラメータ（`raw`: `p.is_raw = 1 OR p.paired_raw_path IS NOT NULL`、`adjusted`: 回転・傾き・クロップ・トーンのいずれかが非初期値）で高速に絞り込む。
