# タグ記録方式の変更: リーフのみ → 祖先ノード独立保存

## 概要

現在のタグDBは「リーフ（末端パス）のみ保存」方式。例えば `被写体/車/ロードスター` を付けると1行だけ保存される。  
これを「**祖先ノードも独立保存**」方式に変更する。同じタグを付けると **3行** が保存される:

```
photo_id | tag
---------|----
42       | 被写体
42       | 被写体/車
42       | 被写体/車/ロードスター
```

### 変更によるUX改善

```
現在の挙動:
  ロードスター を削除 → 「被写体/車/ロードスター」行ごと消滅 → 親の文脈が失われる

新しい挙動:
  ロードスター を削除 → 「被写体/車/ロードスター」だけ消える
                       → 「被写体/車」が残り、チップとして表示される
                       → ユーザーは即座に別の子タグを選べる ✓
```

### 技術的メリット

| 項目 | 変更前 | 変更後 |
|------|--------|--------|
| タグ検索 | `tag = ? OR tag LIKE ?/%` | `tag = ?`（完全一致で十分） |
| 親タグの件数 | フロントで累計計算 | DB値をそのまま使用 |
| 子タグ削除時の親 | 完全消滅 | 自然に残る |

## Open Questions

> [!IMPORTANT]
> **既存DBのマイグレーション方式**  
> 既存の `photo_tags` テーブルに祖先タグを追加するマイグレーションを `initialize_database` 内で自動実行します（`INSERT OR IGNORE` によるべき等処理）。  
> 実行済みフラグとして `migrations` テーブルを新設し、二重実行を防止します。  
> ⇒ 既存データが壊れることはなく、追加のみ。問題なければこの方式で進めます。

---

## Proposed Changes

### バックエンド: データベース層

#### [MODIFY] [database.py](file:///r:/photo-manager/server/database.py)

**1. `initialize_database` にマイグレーション機構を追加**
- `migrations` テーブルを新設
- `ancestor_tags` マイグレーションを自動実行（既存タグの祖先を `INSERT OR IGNORE`）

**2. `add_tag_to_photo` — 祖先タグの自動追加**
```diff
 def add_tag_to_photo(photo_id, tag):
+    # 祖先パスも全て INSERT OR IGNORE
+    parts = cleaned_tag.split("/")
+    all_tags = ["/".join(parts[:i+1]) for i in range(len(parts))]
+    cursor.executemany(
+        "INSERT OR IGNORE INTO photo_tags (photo_id, tag) VALUES (?, ?)",
+        [(photo_id, t) for t in all_tags],
+    )
```

**3. `batch_add_tag` — 同様に祖先タグを一括追加**
```diff
 def batch_add_tag(photo_ids, tag):
+    parts = cleaned_tag.split("/")
+    all_tags = ["/".join(parts[:i+1]) for i in range(len(parts))]
+    pairs = [(pid, t) for pid in photo_ids for t in all_tags]
+    cursor.executemany("INSERT OR IGNORE ...", pairs)
```

**4. `remove_tag_from_photo` — 子孫タグもカスケード削除**
```diff
 def remove_tag_from_photo(photo_id, tag):
-    DELETE ... WHERE photo_id = ? AND tag = ?
+    DELETE ... WHERE photo_id = ? AND (tag = ? OR tag LIKE ?)
     # 祖先は残す（「被写体/車」を消しても「被写体」は残る）
```

**5. `get_photos` フィルタリング — 完全一致に簡略化**
```diff
 # included_tags
-query += " AND p.id IN (SELECT photo_id FROM photo_tags WHERE tag = ? OR tag LIKE ?)"
-params.extend([tag, f"{tag}/%"])
+query += " AND p.id IN (SELECT photo_id FROM photo_tags WHERE tag = ?)"
+params.extend([tag])

 # excluded_tags 
-query += " AND p.id NOT IN (SELECT photo_id FROM photo_tags WHERE tag = ? OR tag LIKE ?)"
-params.extend([tag, f"{tag}/%"])
+query += " AND p.id NOT IN (SELECT photo_id FROM photo_tags WHERE tag = ?)"
+params.extend([tag])
```

**6. 変更不要な関数（既に正しい挙動）**
- `batch_remove_tag`: 既に `tag = ? OR tag LIKE ?/%` で子孫カスケード削除 ✓
- `delete_tag`: 同上 ✓
- `rename_tag`: プレフィックス置換で祖先は不変 ✓

---

### フロントエンド: UI層

#### [MODIFY] [app.js](file:///r:/photo-manager/frontend/js/app.js)

**1. `buildTagTree` — 件数の累計加算を廃止**

新モデルでは各ノードが独自のDB件数を持つため、パス途中での `count +=` を廃止し、末端ノードにのみ件数を設定:

```diff
 parts.forEach((part, idx) => {
   ...
   const childNode = current.children.get(part);
-  childNode.count += item.count;
+  if (idx === parts.length - 1) {
+    childNode.count = item.count;
+  }
   current = childNode;
 });
```

**2. 新規ヘルパー `getLeafTags(tags)` の追加**

写真に付いているタグのうち、**子孫タグを持たないもの（=リーフ）** のみを抽出:

```javascript
function getLeafTags(tags) {
  return tags.filter(tag =>
    !tags.some(other => other !== tag && other.startsWith(tag + '/'))
  );
}
```

例:
- 入力: `["被写体", "被写体/車", "被写体/車/ロードスター"]`
- 出力: `["被写体/車/ロードスター"]`
- `ロードスター` 削除後の入力: `["被写体", "被写体/車"]`
- 出力: `["被写体/車"]` ← 親が自然に可視化される ✓

**3. タグチップ表示の更新（4箇所）**

以下の箇所で `getLeafTags(photo.tags)` を使い、リーフタグのみ表示:
- `showSingleInspector` — インスペクタのタグチップ（[L1522](file:///r:/photo-manager/frontend/js/app.js#L1522)）
- `renderLightboxTags` — ライトボックスのタグチップ（[L1960](file:///r:/photo-manager/frontend/js/app.js#L1960)）
- `renderPhotoGrid` — カードのタグバッジ（[L972](file:///r:/photo-manager/frontend/js/app.js#L972)）
- `showBatchInspector` — 一括編集の共通タグ集計（[L1662](file:///r:/photo-manager/frontend/js/app.js#L1662)）

---

### API層

#### [MODIFY] [app.py](file:///r:/photo-manager/server/app.py)

変更不要。API エンドポイントは `database.py` の関数を呼ぶだけのため、バックエンドの関数変更で自動的に新挙動になる。

---

## Verification Plan

### 自動テスト

マイグレーション後のDBデータ整合性を確認するスクリプトを作成:
```bash
python -c "from server.database import *; ..."
```

### 手動検証

1. **サーバー起動** → 既存DBが自動マイグレーションされることを確認
2. **写真にタグ追加** → DB に祖先タグが自動保存されていることを確認
3. **リーフタグ削除** → 親タグがチップに表示されることを確認
4. **親タグ削除** → 子孫タグも一括削除されることを確認
5. **サイドバー件数** → 正しい件数が表示されることを確認
6. **タグフィルタリング** → 親タグでのフィルタが正しく動作することを確認
