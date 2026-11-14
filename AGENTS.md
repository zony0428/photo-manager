# Tetheract Photo Manager - AI Agent Core Instructions

本書は、本リポジトリ（Tetheract Photo Manager / 旧称 Photo Manager）で作業するすべてのAIエージェントに向けた最優先のコア指示書である。

---

## 1. アーキテクチャ概要 & 旧名維持対象

Tetheract Photo Manager（PC版略称 `TETHERACT pm` / Android・モバイル版呼称 `TETHERACT ld`）は、USBメモリやポータブルSSDで持ち歩き自走できるローカル完結型の高速RAW・写真管理ツールである。

- **バックエンド**: Python 3.11 Embeddable 同梱（`python/`、外部Python・venv不要）＋ FastAPI / Uvicorn（`server/`）
- **フロントエンド**: Vanilla HTML5 + CSS3 + JavaScript ES6+（`frontend/`、Node.js・Webpack/Vite等のバンドラ不使用）
- **データベース**: SQLite3（`cache/library.db`、WALモード＋RAMキャッシュ）。ユニーク画像（`photos` / `content_key`）と複数メディア所在リンク（`photo_links`）の正規化構造、`thumbnails` は `photo_id INTEGER PRIMARY KEY` ROWID直結のWebP BLOB、`photo_tags` は `WITHOUT ROWID` クラスタ化
- **モバイル / Android（`v2` ブランチ）**: 単体完結HTML `Tetheract_Mobile.html`（`server/mobile_bundle.py` 生成）および Android ネイティブシェル（`android/`: WebView + Native SQLite ロッカー + Read-Only SAF `Loome` + 手許 `PhoneCase` / Uplink + GPSフィールドログ）
- **起動・終了**: `Tetheract.exe`（または `start.bat`）→ ルート `run.py` → Edge/Chrome `--app` モード起動、`server/tray.py`（タスクトレイ常駐）、UI終了ボタン（`POST /api/shutdown` → `server/heartbeat.py`）またはトレイからの明示終了（※ハートビート自動終了は無効化済み）
- **改称禁止（互換維持対象）**: リポジトリ名（`photo-manager` / `photo-manager-dev`）、DBパス（`cache/library.db`）、Pythonロガー名（`photo_manager.*`）、C#名前空間（`PhotoManager`）は互換性維持のため旧名のまま維持し、書き換えてはならない。

---

## 2. 最重要境界：非破壊原則 & 開発フォルダ外への干渉厳禁

1. **元データ非破壊の徹底**: 管理対象の元写真ファイル（RAW / JPEG / XMP 等）および元フォルダには、1バイトも変更・移動・削除・隠しファイル生成を行わない（実ファイルの移動・リネーム・カプセル化は専用保管庫 `Loome/`・`storage/`・外付け `<Drive>:\Loome` 内のみ）。
2. **開発フォルダ外への干渉厳禁**: ワークスペース（`c:\Users\zony0\Documents\photo-manager`）の外にあるドライブ・パス（`P:\` 等のUSBメモリ・外付けドライブ・`%LOCALAPPDATA%` 等）には、ファイルの読み書き・コピー・プロセス操作を一切行わない。

---

## 3. ポータブルパス & セキュリティ・ライセンス鉄則

- **ポータブル相対パス**: パス解決は必ず相対パス（`Path(__file__).resolve().parent` や `%~dp0`）を起点とし、`C:\Users\...` 等の絶対パスをコードや設定にハードコードしない。
- **VSN 動的パス解決**: 実写真ファイルのパス解決は必ず `server.scanner.resolve_portable_path(stored_path, expected_serial=photo["volume_serial"])` を経由する（ドライブレター変動・別SDカード誤一致防止のため、`volume_serial` を持つレコードで `expected_serial` を省略しない）。
- **ネットワーク・API防御**:
  - 新規APIは既定で `127.0.0.1` / `localhost` 専用とする。LAN公開が必要な場合のみ安全性を検証の上 `server/lan_access.py` のホワイトリストに明示追加する（PC操作・ファイル削除・DB/セキュリティ設定変更APIのLAN公開は厳禁）。
  - `server/app.py` の `_is_origin_allowed()`（ループバックまたは `Origin == Host` 同一オリジンのみ許可）を緩めない。確認用PINを認可の代わりにしない。
- **XSS・コマンドインジェクション防止**:
  - DOM（`innerHTML` 等）へ挿入する外部由来文字列（ファイル名・ボリューム名・EXIF・タグ名等）は必ずエスケープ関数（`escapeHtml` / `_escHtml`）を通す。
  - `os.startfile` や `subprocess` は検証済みパス・許可拡張子のみを対象とし、シェル文字列連結は禁止（必ず引数リスト形式 `[exe, arg1, ...]` を使用）。
- **テスト義務**: セキュリティや認証周りを変更した際は `tests/test_security.py` を更新し、`.\python\python.exe -m unittest discover -s tests -p "test_*.py"`（標準 `unittest` 統一）の全件合格を確認する。
- **パッケージ追加・ライセンス**: `.\python\python.exe -m pip install <pkg> --no-warn-script-location` を使用する。GPL / AGPL 採用禁止、LGPL は動的リンクのみ可（PyInstaller `--onefile` 禁止）。追加・メジャー更新時は `.agents/skills/license-management/SKILL.md` に従い `LICENSES/` と `NOTICE.txt` を更新する。

---

## 4. コーディング規約 (Python / JS / UI / SQLite)

- **基本姿勢（Simplicity & Surgical Changes）**:
  - 暗黙の仮定で進めず、仕様に曖昧さがあれば確認する。頼まれた以上の過剰な抽象化を作らず、目的外のコード・コメント・フォーマットを勝手に変更しない。
- **言語・クリーンコード原則**:
  - コード内コメント・docstring・ユーザーへの説明はすべて**日本語**（1〜3行で簡潔・現在形とし、廃止経緯の歴史コメントや未使用のデッドコード・非表示DOMをコード内に残さない）。
  - 変数名・関数名・クラス名は**英語**（ローマ字命名は厳禁）。
- **モジュール設計（End-to-End 完結原則）**:
  - 既存の大型ファイル（`frontend/js/mobile.js`, `frontend/js/app.js`, `server/database/photos.py`, `server/app.py` 等）へ漫然と新規機能ブロックを追記せず、単一責務のモジュールへ切り出す。
  - 固定ロール分業や機械的な行数上限合わせは行わず、**「モジュール切り出し → 呼び出し元への配線完了 → 不要になった旧コードの除去 → 動作検証」までを一気通貫（End-to-End）で完結させる（未配線の死にモジュールを作らない）**。
- **Python**:
  - `except:`（bare except）および例外の握りつぶしは全面禁止（`except Exception as e:` または具象例外で必ずログ出力）。
  - テキストファイルの `open()` には必ず `encoding="utf-8"` を明示する。
- **JavaScript / UI / CSS**:
  - **`Date.toISOString()` は使用禁止**（UTC基準で日本時間の日付が1日ズレるため）。必ず `getFullYear()`, `getMonth() + 1`, `getDate()` のローカルタイム連結で生成する。
  - ブラウザ標準の `window.confirm()` / `window.alert()` は使用禁止。確認は `frontend/js/common.js` の `showConfirmModal(options)`（`#commonConfirmModal`）、通知は `showToast()` に統一する。
  - テーマは `data-scheme` 4種（`tetheract-d`［既定］/ `tetheract-l` / `sumi` / `paper`）と明暗ベース `data-theme` 2種（`sumi` / `paper`）のみ（旧名 `washi` / `urusi` / `dark` 等は使用禁止）。テーマ定義に存在しない独自CSS変数のみフォールバック値を指定する。
  - UIへのOS標準カラー絵文字混入は禁止し、単色細線SVG（`stroke="currentColor"`）を使用する。
- **SQLite & パフォーマンス**:
  - 全件取得後のPython側フィルタは禁止（必ずSQLの `WHERE` 句で絞り込む）。
  - 複数行取得時の相関サブクエリを避け、`LEFT JOIN` + `GROUP BY` で事前集計する。WAL・`cache_size`・`mmap_size` 設定を維持する。
  - `photos` 等の親テーブルを再構築する際は、`ON DELETE CASCADE` による子テーブル（`photo_tags`, `thumbnails`, `photo_links`）連動消失を防ぐため、トランザクション外での `PRAGMA foreign_keys = OFF` と子テーブル一時退避の二重保護を徹底する。

---

## 5. Windows / PowerShell UTF-8 鉄則 (No Mojibake)

Windows PowerShell の cp932 文字化けおよび UTF-16 LE BOM 破損を防ぐため、以下を厳守する：
- PowerShell のリダイレクト書き込み（`>` / `Out-File` / `Set-Content`）、テキスト操作コマンド（`Get-Content` / `Select-String` / `-replace` / `findstr`）、および `git diff` の直接実行は**全面禁止**。
- ファイルの閲覧・検索・編集・差分取得には専用のファイル操作ツール、または `.\python\python.exe -X utf8`（`encoding="utf-8"` 明示）を使用する。

---

## 6. ブランチ分離・開発ワークフロー・設計ナレッジ参照

- **`main`（v1.8系 PC安定版 → `dist/`）と `v2`（v2.x系 Android連携版 → `dist_v2/`）の分離**: 作業開始前に必ず `git branch --show-current` を確認し、`main` ブランチへ Android 連携コードを混入させない（詳細: `.agents/rules/branch-and-dist-separation.md`）。
- **日常コミットとリリース作業の分離**:
  - **日常開発**: 目的外のコード・フォーマットを触らない外科的変更と **1コミット1目的** を徹底する。日常の修正・機能実装コミットのたびに `VERSION`・`?v=`・`MANUAL.md`・`#helpModal` を毎回更新する必要はない。
  - **リリース実行時（または明示指示時）**: バージョン更新（事前に `git fetch origin --tags` ＆ `git ls-remote --tags public` 全行確認、新系列 `v1.0.0` 以降基準の SemVer）、キャッシュバスター同期、`MANUAL.md` / `#helpModal` 反映、リリースノート生成、`build_dist.bat` / `scripts/publish_release.py` 実行を一括で行う（手順: `.agents/skills/documentation-manual/SKILL.md`）。
- **AI作業ドキュメント保存先**: 複雑な実装で計画書等（`task.md`, `implementation_plan.md`, `walkthrough.md`）を作成する際は `docs/<topic>/` 配下に保存する（単純な質問・軽微な修正時は生成しない）。
- **コア設計ナレッジ（`docs/README.md` / `docs/knowledge/`）**:
  - `docs/knowledge/design-philosophy-four-pillars.md` — 4つの設計原則（4本の柱）と機能体系・対外文体原則
  - `docs/knowledge/portable-storage-patterns.md` — VSN追跡・`photos`/`photo_links` 分離・`Loome` 保管庫・XMPサイドカー連携
  - `docs/knowledge/security-architecture.md` — 4層ネットワーク防御・Lv.0/1/2 エシカル保護・鍵自動サルベージ
  - `docs/knowledge/ui-design-system-and-tiat-guidelines.md` — UIデザインシステム・2階建てテーマ属性・カスケードUI・タグツリー
  - `docs/knowledge/architecture-scalability-and-side-effects.md` — SQLite/スキャン/UIの禁止アンチパターンとテストDB隔離原則
  - `docs/knowledge/android-app-and-touch-architecture.md` — `TETHERACT ld`・Wi-Fiロッカー同期・PhoneCase/Uplink・FieldLog・タッチUI仕様
