# 実装計画 (Implementation Plan): 重複写真検知・判別機能の改善 & インスペクタ詳細情報への全パス・ボリューム表示 (v1.97)

## 1. 概要と背景
ユーザーより「確認する方法は必要だね。改善案に加えて、重複している場合はインスペクタの詳細情報、保存パスと保存ボリュームが件数分全部出るってのも追加して。」との要望をいただいた。

### 現状の課題
1. **ブラケット・連写写真の重複検知スキップ**:
   - 既存のスタックエンジン（`stacks.py`）では、第1パスでブラケット判定、第2パスで連写判定が行われた後、第3パスで重複写真判定が行われる。
   - 第3パスに `if m.get("stack_type") not in ("burst", "bracket")` という除外ガードが存在するため、ブラケット撮影や連写された写真が他フォルダに重複コピーされていても、重複判定が一切実行されずスキップされていた。
2. **インスペクタ詳細情報での単一パス表示**:
   - インスペクタの「詳細情報」タブでは、選択中の写真の「保存パス」と「保存ボリューム」が1行ずつしか表示されず、他フォルダのどこにコピーが存在するのかを確認できなかった。
3. **重複写真の判別・一覧アクセス手段の不足**:
   - ユーザーがライブラリ内の重複写真を素早く確認するためのクイックアクセス（絞り込み）が存在しなかった。

---

## 2. 実装アプローチ

### ① バックエンド: 重複写真の完全検知 & メタデータ連携
1. **任意の写真に対する重複写真取得関数 ([`server/database/duplicates.py`](../../server/database/duplicates.py))**:
   - `get_duplicates_for_photo(photo_id: int)` を新設。
   - 対象写真の `date_taken` と `file_size` が一致する全写真レコード（自身を含む他フォルダの全コピー）を取得し、各写真の `id`, `file_name`, `file_path`, `directory_path`, `volume_label`, `volume_drive`, `is_offline`, `is_unlinked` を返す。
   - 写真が `bracket` や `burst` であっても、同一画像の重複関係を正確に抽出する。
2. **単一写真詳細API & 写真一覧APIへの連携 ([`server/database/photos.py`](../../server/database/photos.py))**:
   - `/api/photos/{id}` で `duplicates` リストを返却。
   - `get_photos` のレスポンスに `duplicate_count`（他フォルダコピー数 + 1）を付与。
3. **クイックアクセス用「重複写真」絞り込みAPI ([`server/database/photos.py`](../../server/database/photos.py))**:
   - `quick_filter = 'duplicates'` をサポートし、同一撮影日時＋ファイルサイズで2件以上存在する写真群（ブラケット・連写含む）を一発で抽出できるクエリを追加。
   - 件数取得API `/api/photos/duplicates-count` を新設。

### ② フロントエンド: インスペクタ詳細情報 & UI判別
1. **詳細情報タブでの保存パス・ボリューム全件表示 ([`frontend/js/inspector.js`](../../frontend/js/inspector.js))**:
   - 重複写真が存在する場合（`photo.duplicates && photo.duplicates.length > 1`）、
     - 「保存パス (N件)」として全コピーのパスをリスト表示（選択中のパスをハイライト）。
     - 「保存ボリューム (N件)」として各パスに対応するボリューム情報（アイコン・ラベル・ドライブレター）をリスト表示。
     - 各パスにエクスプローラー起動ボタン（📁）を設置。
2. **インスペクタ上部の重複グループセクション拡張 ([`frontend/js/inspector.js`](../../frontend/js/inspector.js))**:
   - `photo.duplicates.length > 1` の場合、スタックタイプが `bracket` や `burst` であっても、「📋 他フォルダの重複コピー (N件)」として上部に展開表示。
3. **サムネイルカード上の重複インジケータ ([`frontend/js/app.js`](../../frontend/js/app.js))**:
   - ブラケット写真（`⚡ BKT 3`）や連写（`⚡ BURST`）であっても `duplicate_count > 1` の場合、バッジ内に重複を示すアイコン「📋 重複あり」または重複バッジを付与。
4. **サイドバー「⚡ クイックアクセス」への追加 ([`frontend/index.html`](../../frontend/index.html), [`frontend/js/sidebar.js`](../../frontend/js/sidebar.js) / [`app.js`](../../frontend/js/app.js))**:
   - クイックアクセス一覧に **「📋 重複のある写真」** を追加（件数バッジ付き）。ワンクリックで重複写真を一発絞り込み。
5. **CSSスタイル定義 ([`frontend/css/style.css`](../../frontend/css/style.css))**:
   - 複数パス・ボリューム表示用のスタイリング（見やすいカード風リスト、和紙・夜墨両テーマ高コントラスト対応）。

---

## 3. 変更対象ファイル一覧
- [`server/database/duplicates.py`](../../server/database/duplicates.py)
- [`server/database/photos.py`](../../server/database/photos.py)
- [`server/app.py`](../../server/app.py)
- [`frontend/js/inspector.js`](../../frontend/js/inspector.js)
- [`frontend/js/app.js`](../../frontend/js/app.js)
- [`frontend/css/style.css`](../../frontend/css/style.css)
- [`frontend/index.html`](../../frontend/index.html)
- [`VERSION`](../../VERSION): `1.96` → `1.97`
- [`MANUAL.md`](../../MANUAL.md)

---

## 4. 検証手順
1. GドライブとZドライブの山塩ラーメンオフの写真（ブラケット写真432枚）を選択。
2. インスペクタの「詳細情報」タブで、保存パスと保存ボリュームが2件分（GドライブとZドライブ）正しく表示されることを確認。
3. インスペクタ上部に「📋 他フォルダの重複コピー (2件)」が表示され、各フォルダのパスと解像度・サイズが確認できることを検証。
4. サイドバーの「⚡ クイックアクセス」に「📋 重複のある写真」が表示され、クリックで重複写真が一覧絞り込みできることを検証。
5. ブラウザ（和紙・夜墨両テーマ）でレイアウトとデザインが美しく整合していることを確認。
