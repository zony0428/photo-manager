# RAW+JPEG ペアの取り扱い改善

## 背景・問題点

現在、同一ステム名の RAW+JPEG（例: `P1141856.ORF` + `P1141856.JPG`）は `stack_type = "raw_pair"` としてブラケット/連写と同じスタックの仕組みに乗せている。

**問題:**
1. グリッドではスタック表示ON時にJPEGのみ表示されるが、右ペインのスタックセクションに**同じサムネイルが2つ並ぶ**だけで情報量が少ない
2. RAWを見たい/開きたいユーザーの導線が不明確
3. ブラケット/連写とは性質が異なるのに同じUIに押し込んでいる

**目標:** RAW+JPEGペアをスタックから分離し、右ペインで「RAWあり」表示 + 「RAWを開く」ボタンを提供する。

---

## 取り込み順序の考慮

| シナリオ | 現在の動作 | 改善後の動作 |
|---|---|---|
| **JPEG → RAW** | `recalculate_stacks` で raw_pair スタック化 | ペアリングのみ（JPEGの `paired_raw_path` にRAWパスを設定、RAWをグリッドから非表示） |
| **RAW → JPEG** | RAWが先にグリッドに表示され、後のJPEGスキャン+`recalculate_stacks`でペア化 | 同上。`recalculate_stacks` 実行時にRAWが「ペア済み」となりグリッドから消え、JPEGが代わりに表示される |
| **RAW のみ** | グリッドに RAW 表示（埋め込みJPEGのサムネイル） | **変更なし** — ペアなしRAWはそのまま表示 |
| **JPEG のみ** | 通常表示 | **変更なし** |

> [!IMPORTANT]
> **RAW→JPEG順の安全性**: `recalculate_stacks` はスキャン完了後に毎回呼ばれるため、RAWが先に登録されていても、JPEGが追加されたスキャン後にペアリングが確立されます。中間状態（RAWだけが見える状態）はスキャン中のみ発生し、スキャン完了時点で正しくペアリングされます。

---

## 提案する変更内容

### 1. データベース層 ([`database.py`](file:///r:/photo-manager/server/database.py))

#### `recalculate_stacks()` の変更

**Before (L794-818):** RAW+JPEGペアを `stack_type = "raw_pair"` でスタック化
```python
elif group[0].get("has_pair") or group[0].get("attached_raws"):
    stack_id = rep["id"]
    stack_type = "raw_pair"
    # ... スタックとして登録
```

**After:** スタック化せず、`paired_raw_path` の紐付けのみ行う
```python
elif group[0].get("has_pair") or group[0].get("attached_raws"):
    rep = group[0]
    # スタックには含めず、paired_raw_path のみ設定
    cursor.execute("""
        UPDATE photos
        SET stack_id = NULL, is_stack_primary = 1, stack_type = NULL,
            paired_raw_path = ?
        WHERE id = ?
    """, (rep.get("paired_raw_path"), rep["id"]))
    # 付随RAWにもペア情報を設定
    for raw_it in rep.get("attached_raws", []):
        cursor.execute("""
            UPDATE photos
            SET stack_id = NULL, is_stack_primary = 1, stack_type = NULL,
                paired_raw_path = ?
            WHERE id = ?
        """, (rep["file_path"], raw_it["id"]))
```

#### `get_photos()` の変更

スタックフィルタとは**別に**、ペア済みRAWをグリッドから除外するフィルタを追加：

```python
# ペア済みRAW（JPEGペアが存在する）はグリッドから除外
query += " AND NOT (p.is_raw = 1 AND p.paired_raw_path IS NOT NULL)"
```

> [!NOTE]
> このフィルタはスタック表示ON/OFFに関係なく常に適用されます。ペア済みRAWは右ペインのEXIF情報から参照できるため、グリッドに出す必要がありません。

---

### 2. API 層 ([`app.py`](file:///r:/photo-manager/server/app.py))

#### [NEW] `POST /api/photo/{photo_id}/open-raw`

ペアのRAWファイルをOSのデフォルトアプリケーションで開く：

```python
@app.post("/api/photo/{photo_id}/open-raw")
def api_open_raw(photo_id: int):
    photo = get_photo_by_id(photo_id)
    if not photo or not photo.get("paired_raw_path"):
        raise HTTPException(status_code=404, detail="RAWペアが存在しません")
    
    raw_path = Path(photo["paired_raw_path"])
    if not raw_path.exists():
        raise HTTPException(status_code=404, detail="RAWファイルが見つかりません")
    
    import os
    os.startfile(str(raw_path))  # Windows
    return {"status": "ok", "raw_path": str(raw_path)}
```

---

### 3. フロントエンド ([`app.js`](file:///r:/photo-manager/frontend/js/app.js) / [`index.html`](file:///r:/photo-manager/frontend/index.html))

#### インスペクタの RAWペア行を強化 (`index.html` L354-357)

**Before:**
```html
<div class="meta-row" id="inspectorRawPairRow" style="display: none;">
  <span class="meta-name">RAWペア</span>
  <span class="meta-val path-val" id="inspectorRawPairPath">-</span>
</div>
```

**After:**
```html
<div class="inspector-section inspector-raw-section" id="inspectorRawPairRow" style="display: none;">
  <div class="inspector-section-header">
    <div class="inspector-label">📷 RAW ファイル</div>
    <span class="badge-sub raw-badge">RAW</span>
  </div>
  <div class="inspector-raw-info">
    <span class="raw-filename" id="inspectorRawPairPath">-</span>
    <button class="btn btn-primary btn-xs" id="inspectorOpenRawBtn">RAWを開く</button>
  </div>
</div>
```

#### インスペクタ JS の変更 (`app.js` L1467-1481)

- `inspectorRawPairRow` を EXIFテーブルの meta-row ではなく、独立セクションとして表示
- 「RAWを開く」ボタンのクリックで `POST /api/photo/{id}/open-raw` を呼ぶ
- `paired_raw_path` からファイル名だけを抽出して見やすく表示

#### ブラケットセクションの変更 (`app.js` L1325-1431)

- `stack_type === 'raw_pair'` のケースを削除（もう来なくなるため）
- ブラケット/連写のみをスタックセクションに表示

#### グリッドカードの変更 (`app.js` L888-906)

- `raw_pair` スタックのバッジ表示ロジック修正（`stack_type !== 'raw_pair'` ガードは不要になる）
- `paired_raw_path` がある場合の `RAW+JPG` バッジはそのまま維持

---

## Open Questions

> [!IMPORTANT]
> **`os.startfile` は Windows 専用です。** 現在のプロジェクトは USB ポータブル Windows 環境を想定しているため問題ありませんが、将来 Mac/Linux 対応が必要になった場合は `subprocess.Popen` での分岐が必要です。現時点では Windows 限定で実装して良いですか？

> [!NOTE]
> **既存DBの `raw_pair` スタックデータ:** `recalculate_stacks` を再実行すれば自動的に修正されます。サーバ起動時の初回スキャンで `recalculate_stacks` が走るため、特別な移行作業は不要です。ただし、既存のフォルダを明示的に再スキャンするか、`/api/stacks/recalculate` APIを呼ぶ必要があります。

---

## 変更対象ファイル一覧

| ファイル | 変更内容 |
|---|---|
| [`database.py`](file:///r:/photo-manager/server/database.py) | `recalculate_stacks()` から raw_pair スタック化を除去、`get_photos()` にペア済みRAW除外フィルタ追加 |
| [`app.py`](file:///r:/photo-manager/server/app.py) | `POST /api/photo/{id}/open-raw` エンドポイント追加 |
| [`index.html`](file:///r:/photo-manager/frontend/index.html) | インスペクタの RAWペア行を独立セクション+ボタンに強化 |
| [`app.js`](file:///r:/photo-manager/frontend/js/app.js) | インスペクタ RAW セクション表示・ボタンイベント追加、ブラケットセクションから raw_pair 除去 |
| [`style.css`](file:///r:/photo-manager/frontend/css/style.css) | RAWセクション用スタイル追加 |

## 検証計画

### 手動検証
1. RAW+JPEGペアのあるフォルダをスキャン → グリッドにJPEGのみ表示されることを確認
2. 右ペインに「📷 RAW ファイル」セクションが表示されることを確認
3. 「RAWを開く」ボタンでOSのデフォルトアプリが起動することを確認
4. RAW単体（JPEGなし）のファイルがグリッドに正常表示されることを確認
5. ブラケット/連写のスタック機能が引き続き正常動作することを確認
6. スタック再計算APIで既存の raw_pair が正しく解消されることを確認
