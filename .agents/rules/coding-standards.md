# コーディング規約 (Coding Standards)

本ドキュメントは Photo Manager プロジェクトにおけるコード記述・設計の統一規約である。
すべてのAIエージェントおよび開発者は本規約を遵守すること。

---

## 1. 言語・命名・コメント

| 項目 | ルール |
|---|---|
| **コード内コメント** | **日本語**（docstringを含む） |
| **変数名・関数名・クラス名** | **英語**（ローマ字命名は厳禁。略語を避け意図が伝わる命名） |
| **コミットメッセージ・説明文** | **日本語** |

```python
# ❌ 禁止（ローマ字命名）
def syashin_kensaku(kensaku_moji: str):
    pass

# ✅ 正しい（英語命名 ＋ 日本語docstring）
def search_photos(query_text: str) -> List[Dict[str, Any]]:
    """指定された文字列に一致する写真リストを検索して返す"""
    pass
```

---

## 2. Python 規約

### エラーハンドリング
- `except:`（bare except）は **全面禁止**。例外を握りつぶして原因不明の不具合を引き起こすのを防ぐため、必ず `except Exception as e:` または具象例外クラスを指定する。
- 例外をキャッチした場合は、必ずログ出力（`logger.error`, `logger.warning`, または `print`）でエラー内容を明示する。単なる `pass` や空ブロックでの握りつぶしは禁止。

```python
# ❌ 禁止
try:
    process_data()
except:
    pass

# ✅ 正しい
try:
    process_data()
except Exception as e:
    print(f"[ERROR] データ処理に失敗しました: {e}")
```

### ファイル I/O
- テキストファイルの読み書きでは、必ず `encoding="utf-8"` を明示する（Windowsのデフォルトである cp932 で保存・読み込みされるのを防止）。

```python
# ❌ 危険（環境依存のエンコーディングになる）
with open("data.json", "w") as f:
    json.dump(data, f)

# ✅ 正しい
with open("data.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
```

### パス解決（ポータブル設計の維持）
- 本プロジェクトはUSBメモリや別フォルダへの移動に対応するため、**絶対パスをコードにハードコードしてはならない**。
- スクリプト自身の場所を基点とした相対パス（`Path(__file__).resolve().parent`）を用いる。

---

## 3. JavaScript / フロントエンド規約

### 日付時刻の生成（最重要ルール）
`Date.toISOString()` は **UTC（協定世界時）** ベースの文字列を返す。
日本時間 (JST = UTC+9) の午前0:00〜8:59に実行すると、前日の日付が返され **「日付が1日ズレる」** という重大な不具合が発生する。

```javascript
// ❌ 絶対禁止（日本時間午前中に実行すると1日前の日付になる）
const dateStr = new Date().toISOString().substring(0, 10);

// ✅ 正しい（ローカルタイムゾーン基準の取得）
function getLocalDateString(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}
```

### XSS 対策
テンプレートリテラルで HTML を動的生成する際、ユーザー入力値やファイル名・メタデータは必ずエスケープ関数を通す。

```javascript
// エスケープ関数
function _escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function _escAttr(str) {
    return _escHtml(str);
}
```

### フレームワーク導入の禁止
- フロントエンドは軽量・ポータブル性維持のため **Vanilla JS (ES6+) + CSS3** で記述する。
- React, Vue, jQuery, TailwindCSS などのビルドが必要なフレームワークや重量ライブラリを勝手に導入しない。

---

## 4. CSS 規約

### CSS 変数のフォールバック指定
CSS変数を使用する際は、必ずフォールバック値を指定する。

```css
/* ❌ フォールバックなし（未定義時に透明・無効になる） */
background: var(--surface-card);

/* ✅ 正しい */
background: var(--surface-card, #1e293b);
color: var(--text-primary, #f8fafc);
```

---

## 5. データベース (SQLite) 規約

### 全件取得（SELECT *）の禁止
- DBアクセス関数には必ず SQL レベルのフィルタ引数（`folder_id`, `rating`, `search_query` など）を用意する。
- 「DBから全件取得して Python 側で if 文やループでフィルタする」実装は、写真枚数が数万件になった際に致命的な速度低下を引き起こすため禁止する。

```python
# ❌ 禁止（全件取得してからメモリ上で絞り込み）
def get_starred_photos():
    photos = get_all_photos()
    return [p for p in photos if p["rating"] >= 1]

# ✅ 正しい（SQLレベルでWHERE句を適用）
def get_starred_photos(min_rating: int = 1):
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM photos WHERE rating >= ?", (min_rating,))
        return [dict(r) for r in cursor.fetchall()]
```

### 相関サブクエリの回避
- 一覧画面のクエリで、1行ごとに副問い合わせを実行する相関サブクエリは避け、`LEFT JOIN` + `GROUP BY` で集計する。

---

## 6. Karpathy LLM ガイドライン（AI行動規範）

1. **シンプル第一 (Simplicity First)**:
   - 問題を解決する最小限のコードを書く。
   - 頼まれていない「拡張性」「汎用化」のためのクラス階層やファクトリを作らない。
   - 200行で書いたコードが50行で済むなら簡素化する。
2. **外科的変更 (Surgical Changes)**:
   - 修正対象箇所以外のコード、コメント、空行、フォーマットを「ついでに改善」しない。
   - 自分が追加して不要になった不要インポートや変数のみを片付ける。
3. **推測の排除**:
   - 仕様や挙動に曖昧さがある場合は、勝手な仮定で実装せず立ち止まって確認する。
