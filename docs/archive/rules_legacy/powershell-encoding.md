# PowerShell + 日本語 エンコーディング規約 (No Mojibake)

本ドキュメントは、Windows PowerShell 環境で発生する文字化け・ファイル破損を防止するための絶対厳守ルールを定義する。

> ツール名は実行環境（Antigravity IDE / Antigravity 2.0 / Claude Code 等）によって異なる。本書のツール名は例であり、同等機能のツールに読み替えること。

---

## 1. 背景と根本原因

Windows の PowerShell には以下の2大問題が存在する：
1. **コンソール文字化け**: 標準コンソールが `cp932` (Shift-JIS) のため、UTF-8 の日本語出力が文字化けする。
2. **UTF-16 LE BOM 書き込み**: `>` リダイレクトや `Out-File`、`Set-Content` のデフォルト出力が **UTF-16 LE BOM** となり、Python スクリプトや設定ファイルが `UnicodeDecodeError` で即死する。

---

## 2. 厳守ルール一覧

### ルール 1: `git diff` の直接実行は禁止
日本語ファイルでは確実に文字化けするため実行しない。
- ❌ `git diff HEAD -- file.py`
- ❌ `git log -p`
- ✅ **代替手段**: エージェントのファイル閲覧ツール（例: `view_file` / `read_file`）を使う。差分全体が必要な場合は、Python の `subprocess.run(["git", "diff", ...], capture_output=True)` で取得した `stdout` を UTF-8 でデコードしてファイルへ書き出し、それを閲覧ツールで読む。

### ルール 2: PowerShell のリダイレクトでファイルを書き込まない
- ❌ `echo "test" > file.txt`（UTF-16 LE BOM で破損する）
- ❌ `"content" | Out-File config.json`
- ❌ `Set-Content -Path file.py -Value "content"`
- ✅ **代替手段**: エージェントのファイル作成ツール（例: `write_to_file` / `write_file`）または Python（`encoding='utf-8'`）で書き込む。

```powershell
# Python経由での安全な1行書き込み例
python -c "open('file.txt', 'w', encoding='utf-8').write('内容')"
```

### ルール 3: PowerShell のテキスト置換・検索コマンドは全面禁止
PowerShell のテキスト操作コマンドは内部で文字列のエンコード変換を引き起こすため、**英語のみであっても一切使用禁止**。
- ❌ `(Get-Content file.py) -replace 'old', 'new' | Set-Content file.py`
- ❌ `Select-String -Pattern "text" -Path *.py`
- ❌ `Get-Content file.py | ForEach-Object { ... }`
- ❌ `[System.IO.File]::ReadAllText(...)`
- ❌ `findstr`（cp932出力のため禁止）

### 安全な代替手段マッピング

| 目的 | 推奨ツール / 手順 |
|---|---|
| **テキスト・コード検索** | エージェントの検索ツール（例: `grep_search`。ripgrep ベース、UTF-8完全対応） |
| **テキスト置換・ファイル修正** | エージェントの編集ツール（例: `replace_file_content` / `edit_file`） |
| **ファイル内容閲覧** | エージェントの閲覧ツール（例: `view_file` / `read_file`） |
| **複数ファイルの一括操作** | Python スクリプト（`open(..., encoding='utf-8')` を明示） |

---

## 3. よくある事故パターンと対策

| 事故内容 | 発生原因 | 正しい対策 |
|---|---|---|
| `UnicodeDecodeError: 'utf-8' codec can't decode...` | PowerShell の `>` リダイレクトで UTF-16 BOM が混入 | `write_to_file` ツールまたは Python で書き直す |
| コマンドプロンプト出力が文字化けして読めない | cp932 コンソールで UTF-8 出力された | ファイルに書き出してから `view_file` で読む |
| `-replace` を実行したらファイル全体が壊れた | PowerShell による UTF-16 化と改行コード変換 | Gitで復元し、`replace_file_content` を使う |
| `Select-String` の結果が文字化け | 出力ストリームが cp932 | `grep_search` ツールを使う |
