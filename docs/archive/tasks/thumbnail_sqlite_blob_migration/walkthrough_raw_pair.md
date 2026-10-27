# RAW+JPEG ペア改善 - Walkthrough

## 変更概要

RAW+JPEG ペアを**スタックの仕組みから分離**し、右ペインに独立した「📷 RAW ファイル」セクション + 「RAWを開く」ボタンを提供する形に変更しました。

---

## 変更ファイル一覧

### [MODIFY] [`database.py`](file:///r:/photo-manager/server/database.py)

| 変更箇所 | 内容 |
|---|---|
| `recalculate_stacks()` | RAW+JPEGペアを `stack_type = "raw_pair"` でスタック化 → `paired_raw_path` の紐付けのみ（`stack_id = NULL`）に変更 |
| `get_photos()` | `AND NOT (p.is_raw = 1 AND p.paired_raw_path IS NOT NULL)` フィルタを追加し、ペア済みRAWをグリッドから常に除外 |

---

### [MODIFY] [`app.py`](file:///r:/photo-manager/server/app.py)

| 変更箇所 | 内容 |
|---|---|
| `POST /api/photo/{id}/open-raw` | **新規追加** — `os.startfile()` でペアのRAWファイルをOSのデフォルトアプリで開く |

---

### [MODIFY] [`index.html`](file:///r:/photo-manager/frontend/index.html)

| 変更箇所 | 内容 |
|---|---|
| インスペクタ RAW 表示 | EXIFテーブル内の `meta-row` → 独立セクション `inspector-raw-section` に昇格。「📷 RAW ファイル」ヘッダー + RAWバッジ + ファイル名 + 「RAWを開く」ボタン |

---

### [MODIFY] [`app.js`](file:///r:/photo-manager/frontend/js/app.js)

| 変更箇所 | 内容 |
|---|---|
| DOM キャッシュ | `inspectorOpenRawBtn` を追加 |
| ブラケットセクション | `isRawPair` / `raw_pair` ケースを除去（もうスタックとして来ないため） |
| RAW ペア表示 | ファイル名のみ抽出して表示、「RAWを開く」ボタンの `onclick` で `POST /api/photo/{id}/open-raw` を呼ぶ |
| グリッドカード | `stack_type !== 'raw_pair'` ガードを除去（不要） |

---

### [MODIFY] [`style.css`](file:///r:/photo-manager/frontend/css/style.css)

| 変更箇所 | 内容 |
|---|---|
| 新規追加 | `.inspector-raw-section`, `.raw-badge-indicator`, `.inspector-raw-info`, `.raw-filename`, `.btn-accent` のスタイル |

---

## テスト結果

### バックエンドテスト
- スタック再計算: 563スタック作成（ブラケット/連写のみ、raw_pair **0件**）
- グリッド表示: 870枚（ペア済みRAW 0件、RAW単体 70件が正常表示）
- `raw_pair` スタック残存: **0件** ✅

### ブラウザ表示テスト
- グリッド正常表示 ✅
- インスペクタパネル正常表示 ✅
- RAWセクション: ペアなし写真では非表示（仕様通り） ✅
- ブラケット/連写スタック: 引き続き正常動作 ✅
- JavaScript エラー: なし ✅

---

## 補足事項

> [!NOTE]
> **現在のデータにはRAW+JPEGの同名ペアが同一フォルダ内に存在しません。** RAWフォルダ (`112_PANA RAW`) とJPEGフォルダが別ディレクトリに格納されているため、`recalculate_stacks` のステム名マッチングではペアが発動しません。RAW+JPEGが同一フォルダに存在するケースでペアリングが正しく動作するかは、そのようなフォルダを取り込んだ際に確認されます。

> [!TIP]
> **「RAWを開く」ボタンのテスト:** 実際の動作確認は、RAW+JPEGが同一フォルダに存在するデータを取り込んだ際に、インスペクタの「📷 RAW ファイル」セクションに表示される「RAWを開く」ボタンをクリックして行えます。
