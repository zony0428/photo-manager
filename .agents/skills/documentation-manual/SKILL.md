---
name: documentation-manual
description: >-
  リリース実行時（またはユーザーからマニュアル・ヘルプ更新を明示指示された時）専用の、
  MANUAL.md・アプリ内ヘルプモーダル（#helpModal）・リリースノート一括同期チェックリスト。
---

# リリース & 操作マニュアル・ヘルプ同期スキル

> **適用タイミング**: 日常の開発コミットごとに本スキルを実行する必要はありません（日常は1コミット1目的で軽快に進めます）。**バージョン番号を更新してリリースを行うタイミング、またはユーザーからマニュアル／ヘルプ／リリースノート更新を明示的に指示されたタイミング**で本チェックリストを実行してください。

---

## 1. リリース・同期対象のドキュメント一覧

| 対象 | ファイルパス | 主な役割 |
| :--- | :--- | :--- |
| **バージョン定義** | `VERSION`（ルート） | 単一のバージョン情報源（SemVer ＋ `Updated: YYYY-MM-DD HH:MM`） |
| **外部マニュアル** | `MANUAL.md`（ルート） | 全機能網羅のユーザー向け操作ガイド（配布パッケージ同梱） |
| **アプリ内ヘルプ** | `frontend/index.html` (`#helpModal`) | アプリ使用中に `?` / `F1` で即座に参照できる要約チートシート |
| **各版リリースノート** | `docs/release_notes/RELEASE_NOTES_v<VERSION>.md` | GitHub Releases 投稿用テキスト（差分版/フル版案内・日英併記） |
| **統合リリースノート** | `RELEASE_NOTES.md`（ルート） | 最新リリース内容と過去の更新履歴（配布パッケージ同梱） |
| **配布スクリプト** | `build_dist.bat` / `scripts/publish_release.py` | `dist/`（v2系は `dist_v2/`）生成・ZIP作成・GitHub Releases 自動公開 |

---

## 2. リリース時の一括同期 4ステップ

### ステップ 1: バージョン番号の決定とキャッシュバスター同期
1. 次のバージョン番号を決める前に必ず `git fetch origin --tags` および `git ls-remote --tags public` の**全行**を確認する（新系列 `v1.0.0` 以降を基準とし、SemVer `MAJOR.MINOR.PATCH` に従う）。
2. ルートの `VERSION` ファイル（バージョン番号 ＋ `Updated: YYYY-MM-DD HH:MM`）を更新する。
3. あわせて以下を同じバージョン番号へ同期する：
   - `frontend/index.html`（`#appVersion` 表記および CSS/JS の `?v=` キャッシュバスター）
   - `frontend/mobile.html`（CSS/JS/アイコンの `?v=` キャッシュバスター）
   - `launcher/Launcher.cs`（`AssemblyVersion` / `AssemblyFileVersion`）
   - モバイル資産に変更がある場合は `.\python\python.exe server\mobile_bundle.py` で `Tetheract_Mobile.html` を再生成する。

### ステップ 2: `MANUAL.md` とアプリ内 `#helpModal` の差分反映
前回リリース以降に**新機能追加・UIレイアウト変更・ショートカット変更**があった場合のみ、両者の記述が食い違わないようまとめて反映する：
- `MANUAL.md`: 該当セクションおよびショートカット表へ具体的な操作手順を追記する。
- `frontend/index.html` (`#helpModal`): `#helpTab-shortcuts` や該当タブの `.help-card` に要点を簡潔に反映する。

### ステップ 3: リリースノートの生成・更新
1. `docs/release_notes/RELEASE_NOTES_v<VERSION>.md` を新規作成する：
   - 冒頭に `- **Tag**: \`v<VERSION>\`` および `- **Title**: \`...\``（`scripts/publish_release.py` が自動取得するため書式厳守）を記載する。
   - 既存ユーザー向けの軽量差分版 `Tetheract_v<VERSION>diff.zip` 上書き案内と、新規向けのフル版 `Tetheract_v<VERSION>.zip` 案内を明記し、日本語・英語の2言語で更新内容を整理する。
2. ルートの `RELEASE_NOTES.md` の先頭に最新バージョンを追記する。
3. `docs/README.md` のリリースノート索引にも必要に応じてリンクを追加する。

### ステップ 4: テスト実行・配布パッケージ生成・公開
1. 回帰テストを実行し全件合格を確認する：`.\python\python.exe -m unittest discover -s tests -p "test_*.py"`
2. `build_dist.bat` を実行し、`dist/`・`dist_update/`（v2系は `dist_v2/`・`dist_v2_update/`）に `MANUAL.md` と `RELEASE_NOTES.md` が同梱され、配布ZIP 2種が生成されることを確認する。
3. ユーザーから「リリースお願い」等の公開指示がある場合は、`.\python\python.exe scripts\publish_release.py` を実行して `public` リポジトリ同期・タグプッシュ・GitHub Release 作成・ZIP アップロードを完遂する。

---

## 3. 文体・記述スタイル規約（脱・絵文字スパム）

- **OS標準カラー絵文字の禁止**: 見出し・箇条書き・評価表記に派手な絵文字（`🏅`, `⭐`, `🗑️`, `🚀`, `✨` 等）を並べない。4段階評価は絵文字を添えず `優 / 良 / 可 / 棄`（英語は `Ex / Gd / Nm / Rj`）と端正に表記する。
- **過度な装飾と煽り表現の禁止**: 太字だらけの長文（Bold-Text Wall）、感嘆符（`!` / `！`）の連発、「爆速」「究極」等の誇張ワードを使わず、落ち着いた句点（`。`）と Markdown テーブルで構造化する。
- **キー表記の統一**: HTML内は `<kbd>1</kbd>` / `<kbd>Shift</kbd> + <kbd>Click</kbd>`、Markdown内は `` `1` `` / `` `Shift + Click` `` または `<kbd>` タグで統一する。
- **専門用語の平易な補足**: EXIF、露出ブラケット（AEB）、サイドカー（XMP）等の専門用語には、初見のユーザーにも伝わる簡潔な補足を添える。
