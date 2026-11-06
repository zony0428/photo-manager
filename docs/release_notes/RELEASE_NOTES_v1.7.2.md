# TETHERACT pm v1.7.2 Release Notes

- **Tag**: `v1.7.2`
- **Title**: `TETHERACT pm v1.7.2 - Codebase Modularization, CSS & Dead-Code Cleanup, Theme Selector Fixes & Error Handling Refinements`
- **Date**: `2026-11-05`

---

> [!CAUTION]
> **⚠️【重要】v1.7.0 以降を起動すると、旧バージョン（v1.6.1以前）との後方互換性がなくなります（特に差分アップデートの場合）**
>
> - **v1.7.0 以降で一度でも起動したデータベース（`cache/library.db`）には新しいセキュリティ＆エシカル保護スキーマが自動適用されるため、それ以降は v1.6.1 以前の旧バージョンでは起動できなくなります。**
> - 特に既存環境へ**軽量差分版（`Tetheract_v1.7.2diff.zip`）を上書きして `Tetheract.exe` を起動した場合**、既存の `cache/library.db` がそのまま v1.7.0+ 仕様へ更新されるため、後から旧バージョンの実行ファイルだけを上書きで戻しても起動しなくなります。
> - 万が一 v1.6.1 以前へ戻す可能性がある場合は、アップデート前にあらかじめ `cache/library.db` を別場所へコピーしてバックアップしておくことを推奨します。
>
> **⚠️ [IMPORTANT] Launching v1.7.0+ Removes Backward Compatibility with Older Versions (v1.6.1 or Earlier)**
> - Once launched in v1.7.0+, `cache/library.db` is upgraded to the new security & ethical protection schema and **can no longer be opened or launched by v1.6.1 or earlier** (especially when overwriting an existing installation with `Tetheract_v1.7.2diff.zip`).

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.7.2diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`Loome/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.7.2.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.7.2diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. フロントエンドJS・バックエンドAPI・CSSのモジュール分割と軽量化（モノリス解消）
- **フロントエンド JavaScript の機能別モジュール分離**:
  - `frontend/js/app.js`（旧 7,530行 ➜ 3,798行）から、適用中フィルタ＆自然言語ポップオーバー（`filter_chips.js`）、登録メディア＆ボリュームVSN管理（`media_volumes.js`）、3段階セキュリティ＆ロック画面制御（`security_ui.js`）、週次バックアップリマインド＆リンク消失パージ（`maintenance_reminders.js`）を独立モジュールへ分離しました。
  - `frontend/js/i18n.js`（旧 2,477行）から日英翻訳辞書データ（`i18n_dict.js`）を分離し、翻訳エンジン本体を 332行へスリム化しました。
- **バックエンド FastAPI ルーターの分割（`server/routers/`）**:
  - `server/app.py`（旧 4,169行 ➜ 2,728行）から 35本の API エンドポイントを機能別ルーター（`ai_router.py`, `gps_lab_router.py`, `storage_volumes_router.py`, `export_import_router.py`, `mobile_router.py`, `security_router.py` および共有モジュール `common.py`）へ分離し、保守性と見通しを大幅に向上させました。
- **双方向デッドコード監査と CSS のスリム化（-2,562行）・ファイル分割**:
  - 順方向・逆方向の双方向監査により、HTML・JS・Python のどこからも参照されていない死にコードおよび旧UIの非表示DOMを撤去しました。
  - CSS 全ファイルから完全未使用の 348ブロック（計 2,562行・約14.2%）を撤去・重複統合し、最大だった `modals-features.css` をカスケード順序を維持したまま `modals-features.css` と `modals-tools.css` に2分割しました。

### 2. ライト／ダークテーマ適用漏れの修正 ＆ ロック中コンソールエラー抑止・例外ロギング強化
- **4テーマ（2階建て属性 `data-scheme` / `data-theme`）のCSSセレクタ修正**:
  - `lab-map.css`（拡大カレンダー・47都道府県マップ・カルテ等）に残っていた旧属性名 `[data-theme="washi"]`（6箇所）を `[data-theme="paper"]` に、`inspector.css` の `[data-theme="dark"]` を `[data-theme="sumi"]` に修正し、「Tetheract L（昼光）」「Hinomaru（白磁）」などのライト系／ダーク系テーマ切り替え時に意図通りスタイルが適用されるよう修正しました。
  - `compare.css` の2枚比較ビューワ（`.compare-pane`）の角丸指定を補填しました。
- **起動ロック（`423 Locked`）中の不要なバックグラウンド通信・コンソール赤エラーの遮断**:
  - パスワードロックまたはエシカル保護ロック画面表示中に、バックグラウンドで `/api/ai/status`・`/api/scan/status` のポーリングや `/api/media/events`（SSE）接続が走ってブラウザコンソールに `423 Locked` エラーが出力され続ける問題を修正し、解錠完了後に接続を開始するよう改善しました。
- **エラー握りつぶしの解消と例外ロギングの適正化**:
  - ファイル削除・リンク消失パージ・フォルダリフレッシュ・ストレージ移動ロールバック等で例外が黙殺（`pass`）されていた箇所に警告ログ出力（`logger.warning`）を追加し、トラブルシューティング性を向上させました。

---

## English

### 1. Frontend JS, Backend API & CSS Modularization and Dead-Code Cleanup
- **Frontend JavaScript Module Decomposition**:
  - Split `frontend/js/app.js` (7,530 lines -> 3,798 lines) by extracting `filter_chips.js`, `media_volumes.js`, `security_ui.js`, and `maintenance_reminders.js`.
  - Separated the bilingual dictionary dataset (`i18n_dict.js`) from `frontend/js/i18n.js`, reducing the core translation engine to 332 lines.
- **Backend FastAPI Router Separation (`server/routers/`)**:
  - Extracted 35 API endpoints from `server/app.py` (4,169 lines -> 2,728 lines) into dedicated domain routers (`ai_router.py`, `gps_lab_router.py`, `storage_volumes_router.py`, `export_import_router.py`, `mobile_router.py`, `security_router.py`, and `common.py`).
- **Bidirectional Dead-Code Audit & CSS Cleanup (-2,562 Lines)**:
  - Removed unreferenced legacy functions, unused hidden DOM nodes, and 348 unused CSS rule blocks (2,562 lines / ~14.2% reduction), and split `modals-features.css` into `modals-features.css` and `modals-tools.css` while preserving exact cascade order.

### 2. Theme Selector Fixes, `423 Locked` Console Error Prevention & Logging Refinements
- **Fixed Legacy Theme Attribute Selectors (`paper` / `sumi`)**:
  - Fixed legacy `[data-theme="washi"]` selectors in `lab-map.css` to `[data-theme="paper"]` and `[data-theme="dark"]` in `inspector.css` to `[data-theme="sumi"]`, ensuring light/dark styles apply accurately across all 4 color schemes (`Tetheract D`, `Tetheract L`, `Hinomaru Sumi`, `Hinomaru Paper`).
- **Suppressed Background Polling & SSE Requests While Locked (`423 Locked`)**:
  - Prevented background `/api/ai/status` and `/api/scan/status` polling and `/api/media/events` SSE connections from firing while the security unlock overlay is active, eliminating console `423 Locked` errors.
- **Improved Exception Logging**:
  - Replaced silent `except Exception: pass` blocks in file deletion, unlinked photo purging, folder refresh, and storage rollback routines with structured `logger.warning` diagnostics.
