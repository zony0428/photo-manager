# 修正内容の確認 (Walkthrough): フォルダマネージャーの左ペイン集約とフォルダ名刷新 (v1.40)

「フォルダマネージャー」モーダルの全機能を左ペイン「📁 フォルダ」タブへ完全集約し、旧モーダルおよび旧コードを撤去。さらに写真取り込み保存先を `carry`、書き出し準備保存先を `take_out` に刷新し、バージョン `1.40` へアップデートしました。

---

## 1. 主な改修内容

### ① 左ペイン「📁 フォルダ」タブへの機能完全集約 (フェーズ1〜3)
- **3セクション構成**:
  - ⭐ **ショートカット**: ピクチャ、ドキュメント、デスクトップ、ダウンロード、ユーザーホームへワンクリックアクセス。
  - 💻 **接続中のドライブ**: C:、D: などの全ドライブを遅延ツリー展開（`os.scandir` + DB写真情報のマージ）。
  - 💾 **未接続（キャッシュのみ）**: ボリュームシリアルで接続/未接続を厳密判定し、セパレータの下部に分離表示。
- **左クリック3段切替**:
  - 1回目: 通常絞り込み（`folder`）
  - 2回目: 除外絞り込み（`folder_exclude`、朱色ダッシュ枠＋打ち消し線、上部に除外チップ表示）
  - 3回目: 絞り込み解除（`all`）
- **右クリックメニューの全面刷新**:
  - 再スキャン（直下・配下）、リフレッシュ（消滅ファイルのDB一括整理）、AI自動タグ付け、管理除外/解除、エクスプローラー起動。
  - ドライブ直下などの大量ファイルスキャン時は安全のための警告ダイアログを表示。
- **下部コントロール**:
  - リアルタイム・スタック対応のスキャン進捗バー。
  - 最下部固定のパス直接入力バー（`▶` ボタンで即スキャン）。
- **タブヘッダー**:
  - `[🤖 OFF / ON]` AI自動タグトグルボタン。
  - `[⚙️]` 独立した「データベースメンテナンス」モーダル起動ボタン（DBサイズ、写真数、サムネイル数、空き領域表示、VACUUM最適化、世代管理バックアップ、フォルダ起動）。

### ② フォルダ名刷新（carry / take_out）および build_dist.bat 更新
- **ヘッダー [取り込み] ボタン**: 保存先を `uploads` から `carry` に変更。
- **右クリックメニュー [書き出し準備] ボタン**: 保存先を `import` から `take_out` に変更。
- **旧フォルダのクリーンアップ**: ディスク上の旧 `uploads/` および `import/` フォルダを削除。
- **配布パッケージ更新 (`build_dist.bat`)**: 配布パッケージ (`dist/`) 内に `carry` と `take_out` の空フォルダを自動生成するよう更新。

### ③ 旧モーダル・旧スクリプトの完全撤去 (フェーズ4)
- `frontend/index.html` より `#scanModal`（旧フォルダマネージャ）および `<script src="/js/scanner_modal.js"></script>` を削除。
- `frontend/js/common.js` より旧モーダル用 DOM キャッシュを削除し、ヘルプ・終了モーダル制御を統合。
- `frontend/js/app.js` の写真ゼロ時空状態ボタン（`emptyStateActionBtn`）の動作を、左ペインのフォルダタブを開くように変更。
- `frontend/js/scanner_modal.js` を非推奨・集約完了コメントに整理。

### ④ バージョンアップ & ドキュメント同期 (フェーズ5)
- バージョン番号を **`1.40`** に更新（`VERSION`, `server/version.py`, `index.html` 静的アセットキャッシュクエリ）。
- `MANUAL.md`（操作マニュアル）を最新仕様へ全面改訂。
- `docs/knowledge/feature-code-map.md` を新アーキテクチャへ更新。

### ⑤ UI微調整 & テキスト同期 (v1.41〜v1.42)
- **右クリックメニュー [テイクアウト] サブメニュー**:
  - 表記を「テイクアウト」に統一、`importフォルダを開く` から **`take_outフォルダを開く`** に修正。
- **下部フローティングバー [評価設定] セレクトボックス**:
  - 先頭 option に `hidden` を付与し、展開時に「⭐ 評価設定」が出ないよう修正。

### ⑥ フッターツールバーのスマート・レスポンシブ化 (v1.43)
- **アイコンとラベルの分離構造化**:
  - フローティングバー内の全ボタンに `<span class="btn-icon">` と `<span class="btn-label">` を導入。
- **ヘッダー同様の段階的アイコン化**:
  - **幅 1150px 以下**: 長いラベル（タグを付ける、テイクアウト、サムネイル更新）をアイコン化。
  - **幅 920px 以下**: 「枚の写真を選択中」テキストを非表示にし、数字バッジのみにスッキリ化。
  - **幅 860px 以下**: 全ボタン（削除、選択解除含む）を完全アイコン化し、パディング・ギャップをスリム化。
  - **幅 640px 以下**: 超狭幅モード（320px 相当）で画面内に1行で完全に収まるミニマルレイアウト。
- **折り返し（2段崩れ）の完全防止**:
  - `white-space: nowrap !important;` と `max-width: calc(100vw - 24px);` を適用し、どんな画面幅でも横一列の美しいピル形状を維持。
- **コントラスト改善**:
  - ダークバー上の文字色を `#f1f5f9` に明示指定し、和紙（ライト）モードでも鮮明に読めるよう調整。

---

## 2. 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| [VERSION](../../VERSION) | `1.40` → `1.41` → `1.42` → `1.43` に更新 |
| [server/version.py](../../server/version.py) | 動的バージョン取得により `1.43` を返却 |
| [frontend/index.html](../../frontend/index.html) | フローティングバーの `btn-icon` / `btn-label` 構造化、`?v=1.43` 更新 |
| [frontend/css/style.css](../../frontend/css/style.css) | フローティングバーのスマート・レスポンシブスタイル追加 |
| [frontend/js/app.js](../../frontend/js/app.js) | ResizeObserver でフローティングバーのコンパクトクラス連動 |
| [frontend/js/selection.js](../../frontend/js/selection.js) | サムネイル取得・更新ボタンのアイコン・ラベル個別動的更新 |
| [build_dist.bat](../../build_dist.bat) | `carry/`, `take_out/` の除外設定および空フォルダ生成を追加 |
| [server/app.py](../../server/app.py) | `UPLOAD_DIR` を `carry`、`IMPORT_DIR` を `take_out`、API表示名を更新 |
| [server/database/folders.py](../../server/database/folders.py) | `SYSTEM_IGNORE_NAMES` に `carry`, `take_out` を追加 |
| [server/scanner.py](../../server/scanner.py) | 再帰スキャン除外リストに `carry`, `take_out` を追加、コメント更新 |
| [server/folder_tree.py](../../server/folder_tree.py) | 新設: roots / children / exclude API ロジック |
| [frontend/index.html](../../frontend/index.html) | `take_outフォルダを開く` に修正、`floatingRateSelect` の先頭 option に `hidden` 付与、アセットを `?v=1.41` に更新 |
| [frontend/js/selection.js](../../frontend/js/selection.js) | トースト通知を `take_outフォルダを開きました` に修正 |
| [frontend/js/folder_tree.js](../../frontend/js/folder_tree.js) | 新設: 左ペインフォルダツリー描画・操作・DBメンテモーダル |
| [frontend/js/common.js](../../frontend/js/common.js) | 旧モーダル参照削除、ヘルプ・シャットダウンモーダル制御を移設 |
| [frontend/js/app.js](../../frontend/js/app.js) | 空状態ボタンのフォルダタブ連動、不要コード整理 |
| [frontend/js/scanner_modal.js](../../frontend/js/scanner_modal.js) | 非推奨整理（集約完了コメント） |
| [MANUAL.md](../../MANUAL.md) | 左ペインフォルダツリー操作、`carry`/`take_out` 保存先を反映 |
| [docs/knowledge/feature-code-map.md](../../docs/knowledge/feature-code-map.md) | モジュール対応表・機能コードマップを v1.40/1.41 構成に同期 |

---

## 3. ブラウザ検証結果

ブラウザサブエージェント（Chrome/Edge互換）により以下の動作を実機確認しました：

1. **コンソールエラー**: JavaScript エラー / 例外 **0件**。
2. **ヘッダーUI**:
   - `取り込み` ボタンが正常表示。
   - 旧 `フォルダ管理` ボタンは完全に削除されていることを確認。
3. **左ペイン「📁 フォルダ」ツリー**:
   - ショートカット（ピクチャ、ドキュメント、デスクトップ）が正常表示。
   - 接続中ドライブ（C:, E:, F:, G:, K:, M:, Y:, Z:）が正常一覧表示。
4. **データベースメンテナンスモーダル**:
   - フォルダヘッダーの `⚙️` ボタンでモーダルが開き、写真数（2,377枚）、DBサイズ（35.4MB）、サムネイル数（2,335件）を正確にロードできることを確認。
5. **ヘルプモーダル**:
   - ヘッダーの `？` ボタンで操作マニュアルモーダルが正常に開き、タブ切替および閉じる処理が正常に動作することを確認。
