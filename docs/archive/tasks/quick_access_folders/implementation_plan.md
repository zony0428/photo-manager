# 実装計画: フォルダマネージャへの「よく使う場所」プリセット追加

## 1. 概要
フォルダマネージャの左ペイン（フォルダブラウザ）の最上位階層において、これまでの「ドライブ一覧（C:, D: 等）」のみの表示に加え、Windowsエクスプローラーと同等の **「よく使う場所（クイックアクセス: ピクチャ、デスクトップ、ドキュメント、ダウンロード、ユーザーホーム）」** をプリセット表示し、深いフォルダ階層の知識がなくてもワンクリックで写真のあるフォルダにアクセスできるようにする。

## 2. 変更対象ファイル
1. **修正**: `server/app.py` (`api_browse_folders`)
   - `path` 未指定時（トップ階層）において、`quick_access` リストを構築して返却する。
   - Windowsレジストリ（`User Shell Folders`）を参照し、OneDrive同期環境や別ドライブ移動にも追従した実フォルダパスを正確に取得。
   - レスポンス構造:
     ```json
     {
       "quick_access": [
         {"name": "ピクチャ", "path": "C:\\Users\\...\\Pictures", "icon": "🖼️"},
         {"name": "デスクトップ", "path": "C:\\Users\\...\\Desktop", "icon": "🖥️"},
         {"name": "ドキュメント", "path": "C:\\Users\\...\\Documents", "icon": "📁"},
         {"name": "ダウンロード", "path": "C:\\Users\\...\\Downloads", "icon": "📥"},
         {"name": "ユーザー", "path": "C:\\Users\\...", "icon": "🏠"}
       ],
       "folders": [...ドライブ一覧...],
       "parent": null,
       "current": ""
     }
     ```
2. **修正**: `frontend/js/app.js` (`loadFolderBrowser`)
   - トップ階層（`_browserCurrentPath === ''`）の際、`quick_access` が存在すれば「⭐ よく使う場所」と「💻 PC / ドライブ」の2セクションに分けて描画。
   - 各アイテムのクリックで該当フォルダの中身へ遷移、または「選択」ボタンでパス欄へ反映。
   - ヘッダー表示を「ドライブ・よく使う場所」に更新。
3. **修正**: `frontend/css/style.css`
   - セクション区切りタイトル (`.folder-browser-section-title`) のスタイリング。

## 3. 実装手順
1. `server/app.py` で Windows の特殊フォルダ取得ロジックを実装し、APIレスポンスをテスト。
2. `frontend/css/style.css` にセクションスタイリングを追加。
3. `frontend/js/app.js` の `loadFolderBrowser` を改修。
4. 単体・結合テストで動作確認。
5. `docs/quick_access_folders/walkthrough.md` を作成。
