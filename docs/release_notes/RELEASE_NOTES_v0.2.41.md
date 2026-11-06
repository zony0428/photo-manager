# Photo Manager v2.41 リリースノート

- **Tag**: `v2.41`
- **Title**: `Photo Manager v2.41 — ローカルセキュリティ強化（127.0.0.1既定待受＆オンデマンドLAN・CORS/CSRF遮断）＆ autorun.inf オプショナル化`
- **Release Date**: `2026-10-24`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v2.41diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけで更新できます（`cache/`・`python/` はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v2.41.zip`）**: ポータブル Python 同梱版を解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v2.41diff.zip`)**: Extract and overwrite your existing `PhotoManager` directory. `cache/` and `python/` remain untouched.

---

## 日本語 (Japanese)

### 1. ローカルセキュリティとネットワーク待受制御の強化
- **127.0.0.1（ローカルループバック）既定待受**:
  - サーバーの待受アドレスを既定で `127.0.0.1`（自PC限定）とし、LAN（外部ネットワーク）へのポート露出を防止。
- **オンデマンドLAN接続**:
  - ヘッダーの「スマホ連携」ボタンをクリックした際のみ、セカンダリ待受としてLAN IPアドレスでのリッスンを一時的に開始する安全な待受制御へ刷新。
- **CORS / Origin 検証ミドルウェア**:
  - 悪意ある外部Webサイトからのクロスオリジンリクエスト（CSRF）を検知し、許可オリジン以外を確実に 403 遮断。
- **インジェクション対策**:
  - SQL `LIKE` クエリにおける `ESCAPE` 句の統一とメタ文字処理の厳格化。
  - 逆ジオコーディングキャッシュのポータブルパスキー化による安全性の向上。

### 2. USB 自動再生設定のオプショナル化
- **誤検知防止**:
  - ウイルス対策ソフト（Windows Defender等）による誤検知（False Positive）を防ぐため、標準配布パッケージから `autorun.inf` を除外。
  - 必要なユーザー向けに `Build.bat` 実行時のオプション生成として選択可能に変更。

---

## English

### 1. Local Security Hardening & On-Demand LAN Binding
- **127.0.0.1 default binding**: Server binds exclusively to loopback (`127.0.0.1`) by default, preventing unintended port exposure to the local network.
- **On-demand LAN listener**: LAN-wide listening is started only when the user explicitly opens the "Mobile Connect" modal from the UI header.
- **CORS & Origin validation middleware**: Rejects cross-origin requests from external websites with HTTP 403 Forbidden.
- **Injection defense**: Enforced SQL `LIKE ... ESCAPE` clauses and portable path resolution for reverse geocoding cache.

### 2. Optional USB Autorun Configuration
- Excluded `autorun.inf` from standard release ZIP packages to avoid false-positive anti-virus detections; available as an opt-in toggle during `Build.bat`.
