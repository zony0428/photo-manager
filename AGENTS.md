# Photo Manager - AI Agent Instruction & Context

このファイルは、本リポジトリ（Photo Manager）で作業するすべてのAIエージェント（Antigravity, Cursor, Claude Code, GitHub Copilot 等）に向けた最優先システム指示書である。
外部環境やPC固有のグローバル設定に依存せず、本フォルダ単体で完結して自律稼働できるように設計されている。

---

## 1. プロジェクト概要 & アーキテクチャ

Photo Manager は、Picasa / Tiat にインスパイアされた、RAW画像・一般画像向けのローカル高速写真ビューア・管理ツールである。
USBメモリやポータブルSSDでの持ち歩き運用（完全スタンドアロン自走）をコア要件とする。

- **バックエンド**: Python 3.11 (FastAPI + Uvicorn)
- **Python環境**: リポジトリ内 `python/` に Embeddable Python を同梱（外部Python / venv 不要）
- **フロントエンド**: Vanilla HTML5 + CSS3 + JavaScript (ES6+)。Node.js やビルドツール（Webpack/Vite等）は一切使わない
- **データベース**: SQLite3 (`cache/library.db`)。WALモード + RAMキャッシュ最適化
- **サムネイル**: SQLite BLOBストレージ（`thumbnails` テーブルにWebPバイナリを格納）
- **UI起動**: `PhotoManager.exe`（または `start.bat`） -> `server/run.py` -> Edge/Chrome の `--app` モード（タブ/URLバー無しの単体アプリ風ウィンドウ）
- **プロセス終了**: `server/heartbeat.py` によるブラウザ生存監視（ブラウザを閉じるとサーバーも自動停止）

---

## 2. コア行動指針 (Karpathy LLM Guidelines)

1. **考えてからコードを書く**:
   - 暗黙の前提を置かない。推測で進めず、不明点があればユーザーに確認する。
   - よりシンプルな解決策があれば提案する。
2. **シンプル第一 (Simplicity First)**:
   - 頼まれたこと以上の過剰な機能・抽象化を追加しない。
   - 一度しか使わない処理に過度なデザインパターンやインターフェースを導入しない。
   - コードの粒度は小さく、単一責務で簡潔に保つ。
3. **外科的変更 (Surgical Changes)**:
   - 目的外のコード・コメント・フォーマットを勝手に「改善」しない。
   - 既存のコードスタイルに合わせる。
   - 不要になったインポートや変数は確実に除去する。
4. **目標・検証駆動 (Goal & Verification Driven)**:
   - 変更前後の動作確認手順を明確にし、テスト・検証を行う。

---

## 3. コーディング規約 (Coding Standards)

### 言語 & コメント
- **コード内コメント・docstring**: すべて**日本語**で記述する。
- **変数名・関数名・クラス名**: 英語で明確に命名する（ローマ字命名は厳禁）。
- **ユーザーへの説明・計画書**: すべて**日本語**で行う。

### Python
- **エラーハンドリング**:
  - `except:` (bare except) は**全面禁止**。必ず `except Exception as e:` または具象例外を使う。
  - エラーは握りつぶさず、必ずログ出力（`logger.warning` / `logger.error` / `print`）する。
- **ファイルI/O**:
  - テキストファイルの `open()` には必ず `encoding="utf-8"` を明示する（Windowsデフォルトの cp932 を避ける）。
- **ポータブルパス原則**:
  - ファイルパスの解決には必ず相対パス（`Path(__file__).resolve().parent` や `%~dp0`）を使う。
  - 絶対パス（`C:\Users\...`）をコードや設定にハードコードしてはならない。
  - ドライブレター変動に対応するため、実写真のパス解決は `server/scanner.py` の `resolve_portable_path()` を経由する。
- **パッケージ追加・ライセンス**:
  - パッケージ追加は `python\python.exe -m pip install <pkg> --no-warn-script-location` で行う。
  - GPL / AGPL ライセンスのライブラリは**採用禁止**（Photo Manager ソースコードへの感染防止）。
  - LGPL は動的リンクのみ許可。PyInstaller `--onefile` は禁止（`--onedir` のみ許可）。
  - 追加時は `LICENSES/` へのライセンスファイル配置と `NOTICE.txt` 更新を必須とする（`.agents/skills/license-management/` 参照）。

### JavaScript / フロントエンド
- **日付時刻生成の鉄則**:
  - `Date.toISOString()` は**使用禁止**（UTC基準のため日本時間で日付が1日ズレるバグが発生する）。
  - 必ずローカルタイム方式（`getFullYear()`, `getMonth() + 1`, `getDate()` をゼロ埋め連結）で生成する。
- **サニタイズ (XSS防止)**:
  - テンプレートリテラルでDOMに挿入するユーザー入力値・ファイル名は必ずエスケープ関数（`_escHtml`, `_escAttr`）を通す。
- **CSS変数**:
  - `var(--var-name, fallback)` のように必ずフォールバック値を指定する。

### データベース & パフォーマンス
- **全件取得の禁止**:
  - DBアクセス関数には必ずSQLレベルの条件（`WHERE` 句）パラメータを渡す。全件取得後にPython側でフィルタする実装は禁止。
- **相関サブクエリの回避**:
  - 複数行取得時に `SELECT` 句内でサブクエリを回さず、`LEFT JOIN` + `GROUP BY` で事前集計する。
- **SQLite PRAGMA**:
  - WALモード、RAMキャッシュ（`cache_size`）、メモリマップドI/O（`mmap_size`）の設定を維持する。

### バージョン管理・自動カウントアップ規約
- **起点バージョン**: 2026-10-06 時点を `1.00` とする。
- **カウントアップ原則（検証・コミット時更新）**:
  - 通常の作業途中・微修正のたびに細かくバージョン番号を上げてはならない。
  - **動作検証・確認が完了し、Gitコミットを行うタイミングで `0.01` 単位でカウントアップ**する（例: `2.23` → `2.24`）。
  - 大幅な機能変更等でバージョンを大きく上げる場合は、ユーザーからの明示的な指示に従う。
- **最終更新日時の併記**:
  - バージョン値はプロジェクトルートの `VERSION` ファイルおよび `server/version.py` で一元管理する。
  - `VERSION` ファイルにはバージョン番号とあわせて **最終更新日時（`Updated: YYYY-MM-DD HH:MM`）** を記載し、改修時は最終更新日時を最新化する（UIの `#appVersion` および `/api/version` へ反映させる）。

### ドキュメンテーション & 操作マニュアル同期規約
- **マニュアル同時更新義務**:
  - 新機能の追加、UIレイアウトの変更、キーボードショートカットの変更・追加を行った際は、必ずプロジェクトルートの `MANUAL.md` およびアプリ内ヘルプモーダル（`frontend/index.html` の `#helpModal`）を**同時に更新**する。
  - 詳細手順は `.agents/skills/documentation-manual/` を参照。
  - 配布用バッチ `build_dist.bat` にも `MANUAL.md` の同梱設定を維持する。


---

## 4. Windows / PowerShell 操作の絶対ルール (No Mojibake)

Windows PowerShell の文字化け（cp932）および UTF-16 LE BOM 書き込み事故を防ぐため、以下を厳守する。

1. **`git diff` の直接実行禁止**:
   - 日本語ファイルでは文字化けするため実行しない。ファイル確認には IDE の専用ツール（`view_file`）を使う。
2. **PowerShell リダイレクト（`>` / `Out-File` / `Set-Content`）でのファイル書き込み禁止**:
   - UTF-16 LE BOM が付与されファイルが破損する。ファイル生成は IDE ツール（`write_to_file`）または Python（`encoding='utf-8'`）で行う。
3. **PowerShell のテキスト操作コマンド禁止**:
   - `Select-String`, `-replace`, `Get-Content`, `findstr` は文字化け・型崩れの原因となるため使用禁止。
   - 検索は `grep_search`、置換は `replace_file_content` / `multi_replace_file_content` を使う。

---

## 5. ディレクトリ構造マップ

```text
photo-manager/
├── PhotoManager.exe           ★ 専用ネイティブGUIランチャー（アイコン付き・DOS窓なし）
├── MANUAL.md                  ★ 操作マニュアル（ユーザー向け完全ガイド）
├── VERSION                    ★ バージョン管理ファイル
├── start.bat                  ★ 予備起動用バッチ（開発・トラブル対応用）
├── run.py                     ★ サーバー起動＆ブラウザアプリウィンドウ立ち上げ（ルート/server両対応）
├── build_dist.bat             ★ ポータブル配布パッケージ生成スクリプト（dist/ を自動生成）
├── build_launcher.bat         ★ ランチャー（PhotoManager.exe）再コンパイルバッチ
├── setup_portable_python.bat  ★ ポータブルPython自動構築バッチ（開発用）
├── python/                    ★ 同梱のポータブルPython（3.11 embeddable）
├── cache/                     ★ SQLiteデータベース（library.db）
├── .agents/                   ★ AIエージェント設定（Rules & Skills）
│   ├── rules/                 ★ 詳細ルール（coding, encoding, architecture, license, documentation）
│   └── skills/                ★ 専門スキル（license-management, documentation-manual）
├── docs/                      ★ 設計ドキュメント
│   └── knowledge/             ★ 過去の改修知見・技術ノウハウアーカイブ
├── frontend/                  ★ UI画面（Vanilla HTML / CSS / JS）
│   ├── index.html
│   ├── css/
│   └── js/
└── server/                    ★ バックエンド（FastAPI）
    ├── app.py                 ★ APIエンドポイントルーティング
    ├── database/              ★ SQLiteスキーマ定義・CRUD操作・DB管理パッケージ
    ├── scanner.py             ★ 画像スキャン・メタデータ抽出・WebPサムネイル生成
    ├── raw_loader.py          ★ 各社RAWファイル解析・LibRaw連携
    ├── shell_thumbnail.py     ★ Windows Shell APIサムネイルフォールバック
    ├── volume_info.py         ★ ドライブVSN・ボリュームラベル取得
    ├── heartbeat.py           ★ ブラウザ生存監視・自動シャットダウン
    └── tray.py                ★ システムトレイアイコン・メニュー（pystray）
```

---

## 6. 詳細ルールへのリファレンス

詳細なコンテキストや仕様は、以下のプロジェクト内ファイルを参照すること：
- **コーディング規約詳細**: `.agents/rules/coding-standards.md`
- **PowerShell文字化け対策**: `.agents/rules/powershell-encoding.md`
- **アーキテクチャ & パフォーマンス**: `.agents/rules/architecture-and-performance.md`
- **ライセンス管理規約**: `.agents/rules/license.md`
- **ドキュメンテーション規約**: `.agents/rules/documentation.md`
- **操作マニュアル保守スキル**: `.agents/skills/documentation-manual/SKILL.md`
- **機能別コードマップ（機能と該当コードの完全対応表）**: `docs/knowledge/feature-code-map.md`
- **大規模化・高速化の相互影響検証 & 安全設計計画**: `docs/knowledge/architecture-scalability-and-side-effects.md`
- **技術ノウハウ・知見集**: `docs/knowledge/`
