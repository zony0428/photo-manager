# Windows PowerShell エンコーディングトラブルシューティング集 (No Mojibake)

## 1. 概要

Windows PowerShell（標準の `powershell.exe`）は、日本語環境において極めて厄介なエンコーディングのトラップを複数抱えている。
AIエージェントがコマンドを実行する際、これらの落とし穴に嵌るとコードの破壊やデバッグループの浪費を招くため、メカニズムと対処法をここに記録する。

---

## 2. 事故ケーススタディ & メカニズム

### ケース 1: リダイレクト `>` による UTF-16 LE BOM 汚染
- **現象**: `echo "..." > config.json` や `Out-File` を実行した後、Python からファイルを読み込むと `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff in position 0` で落ちる。
- **原因**: PowerShell 5.1 の `>` 演算子および `Out-File`、`Set-Content` のデフォルト文字コードは **UTF-16 LE (BOM付き)**。先頭に `0xFF 0xFE` の2バイトが付与され、中身も2バイト文字で記録されるため、UTF-8 を期待するツール群が全滅する。
- **対処**: PowerShell のリダイレクトは絶対に使わない。ファイル作成は Python 経由（`open(..., 'w', encoding='utf-8')`）または IDE ツール（`write_to_file`）で行う。

### ケース 2: `git diff` による日本語の化け・文字化け事故
- **現象**: ターミナルで `git diff` を実行すると、日本語のコメントや文字列がすべて `\346\227\245\346\234\254` や文字化け記号で表示され、内容が把握できない。
- **原因**: Windows コンソールの標準出力コードページが `cp932`（Shift-JIS）であるのに対し、Git は UTF-8 で差分を出力するため。
- **対処**: `git diff` をコンソールで直接叩かない。差分やファイル内容の確認には IDE 専用ツール（`view_file`）を使用する。

### ケース 3: `-replace` 演算子によるコード破損
- **現象**: 1行だけ文字列を置換しようと `(Get-Content file.py) -replace 'A', 'B' | Set-Content file.py` を実行したところ、ファイル全体が UTF-16 に変換され、改行コードも CRLF に一律置換されて構文エラーが発生。
- **原因**: `Get-Content` が cp932 で解釈しようとし、さらにパイプ後の `Set-Content` が UTF-16 LE BOM で上書きするため。
- **対処**: PowerShell のテキスト置換は全面禁止。IDEの `replace_file_content` ツールまたは Python の正規表現置換を使用する。

---

## 3. 安全な代替コマンドチートシート

```powershell
# ❌ 禁止: PowerShellリダイレクト
echo "hello" > test.txt

# ✅ 安全: Python経由のUTF-8書き込み
python -c "open('test.txt', 'w', encoding='utf-8').write('hello\n')"

# ❌ 禁止: Select-String や findstr での検索
Select-String -Pattern "def main" -Path *.py

# ✅ 安全: ripgrep / grep_search ツールによる検索
# （IDE提供の grep_search ツールを使用する）

# ❌ 禁止: -replace による置換
(Get-Content run.py) -replace '8088', '8089' | Set-Content run.py

# ✅ 安全: IDEの replace_file_content ツールを使用する
```
