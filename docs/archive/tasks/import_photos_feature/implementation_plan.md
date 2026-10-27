# 実装計画: インポート（送る）機能の実装（JPG限定）

## 1. 概要
Photo Manager で閲覧・選択した写真を、実行環境（USBドライブ等）ルート直下の `import/` フォルダ内の指定サブフォルダへワンクリックでコピー取り込み（Send to / Import）できる機能を新設する。
取り込み対象は **JPG/JPEG 写真に限定** し、RAW単体ファイルは除外し、RAW+JPGペア写真の場合はJPG側のみを抽出してコピーする。また `import/` フォルダはスキャナーの監視対象外とする。

## 2. 変更対象ファイル
1. **修正**: `server/scanner.py`
   - `IGNORED_DIR_NAMES` に `"import"` を追加し、スキャン時に `import` フォルダ内が再帰探索・DB登録されないよう保護。
2. **修正**: `server/app.py`
   - `IMPORT_DIR = BASE_DIR / "import"` を定義・自動生成。
   - `GET /api/import/destinations`: `import/` 直下のサブフォルダ一覧を返す。
   - `POST /api/import/folders`: 新規サブフォルダを作成する。
   - `POST /api/import/copy`: 指定された `photo_ids` の中から JPG/JPEG ファイル（RAW単体は除外、RAW+JPGペアはJPG側）を特定し、指定フォルダへ `shutil.copy2`（EXIF/タイムスタンプ保持）でコピー。同名ファイル時は自動ナンバリング。
   - `POST /api/import/open`: `import/`（または特定サブフォルダ）を `os.startfile` で Windows エクスプローラーで開く。
3. **修正**: `frontend/index.html`
   - 右クリックコンテキストメニューに「📤 送る / インポート」項目およびサブメニューコンテナを追加。
   - 複数選択フローティングバーに「📤 送る」ボタンを追加。
4. **修正**: `frontend/js/app.js`
   - コンテキストメニュー表示時に送り先フォルダ一覧を取得・表示。
   - 新規フォルダ作成アクション、フォルダへのコピー実行処理、エクスプローラーで開くアクションを実装。
5. **修正**: `frontend/css/style.css`
   - サブメニュー（ネストメニュー）のスタイル調整。

## 3. 実装手順
1. `server/scanner.py` に `import` 除外を追加。
2. `server/app.py` にインポート関連 API を実装。
3. `frontend/index.html`, `frontend/css/style.css`, `frontend/js/app.js` に UI を実装。
4. 単体・結合テスト（JPG限定コピー、RAWペア処理、エクスプローラー起動）を実施。
5. `docs/import_photos_feature/walkthrough.md` を作成。
