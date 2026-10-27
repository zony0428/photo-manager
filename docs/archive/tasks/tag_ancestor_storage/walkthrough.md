# ウォークスルー: タグ記録方式の変更

## 変更概要

タグのDB記録方式を「リーフ（末端パス）のみ保存」から「**祖先ノード独立保存**」に変更しました。

**変更前**: `被写体/車/ロードスター` → DB に1行
**変更後**: `被写体/車/ロードスター` → DB に3行 (`被写体`, `被写体/車`, `被写体/車/ロードスター`)

## 変更ファイル

### [database.py](file:///r:/photo-manager/server/database.py)

| 関数 | 変更内容 |
|------|----------|
| `_expand_ancestor_tags` | **新規**: タグパスから祖先パスを含むリストを生成 |
| `_migrate_ancestor_tags` | **新規**: 既存タグに祖先レコードを追加するマイグレーション |
| `initialize_database` | `migrations` テーブル新設、マイグレーション自動実行 |
| `add_tag_to_photo` | 祖先パスも `INSERT OR IGNORE` で自動追加 |
| `batch_add_tag` | 同上（一括版） |
| `remove_tag_from_photo` | 完全一致のみ → `tag = ? OR tag LIKE ?/%`（子孫カスケード削除、祖先は残す） |
| `get_photos` | `tag = ? OR tag LIKE ?/%` → `tag = ?`（完全一致に簡略化） |

### [app.js](file:///r:/photo-manager/frontend/js/app.js)

| 関数 | 変更内容 |
|------|----------|
| `getLeafTags` | **新規**: タグ配列からリーフ（最深の末端）のみ抽出するヘルパー |
| `buildTagTree` | `count += item.count` → 末端ノードに `count = item.count` を設定（累計廃止） |
| `showSingleInspector` | タグチップ表示を `getLeafTags` で絞込 |
| `renderLightboxTags` | 同上 |
| `renderPhotoGrid` | カードのタグバッジを `getLeafTags` で絞込 |
| `showBatchInspector` | 一括編集のタグ集計を `getLeafTags` で絞込 |

### 変更なし
- [app.py](file:///r:/photo-manager/server/app.py) — APIエンドポイントは変更不要

## テスト結果

```
Testing with photo_id=352
After add 'テスト/子/孫': ['テスト', 'テスト/子', 'テスト/子/孫']
  [PASS] add_tag_to_photo adds ancestors

After remove 'テスト/子/孫': ['テスト', 'テスト/子']
  [PASS] remove_tag_from_photo leaves ancestors intact

After remove 'テスト/子': ['テスト']
  [PASS] remove_tag_from_photo cascades to descendants

ALL TESTS PASSED!
```

## 動作フロー

```
1. ユーザーが「被写体/車/ロードスター」を付与
   → DB: 被写体, 被写体/車, 被写体/車/ロードスター (3行)
   → UI: チップに「被写体/車/ロードスター」のみ表示

2. ユーザーがチップの × で「ロードスター」を削除
   → DB: 被写体, 被写体/車 (2行 — 親が残る!)
   → UI: チップに「被写体/車」が自然に出現 ✓

3. ユーザーがクイックツリーから「コペン」を追加
   → DB: 被写体, 被写体/車, 被写体/車/コペン (3行)
   → UI: チップに「被写体/車/コペン」が表示 ✓
```
