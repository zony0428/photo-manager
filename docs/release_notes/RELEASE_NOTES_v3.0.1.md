# Photo Manager v3.0.1 Release Notes

- **Tag**: `v3.0.1`
- **Title**: `Photo Manager v3.0.1 - Security Hardening (DNS Rebinding / LAN Token Auth / XSS), Data Safety & Fully Local Assets`
- **Date**: `2026-10-27`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v3.0.1diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけで更新できます（`cache/`・`storage/`・`python/`・`models/` はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v3.0.1.zip`）**: ポータブル Python 同梱版を解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v3.0.1diff.zip`)**: Extract and overwrite your existing `PhotoManager` directory. `cache/`, `storage/`, `python/`, and `models/` remain untouched.

---

## 日本語 (Japanese)

### セキュリティ強化 (Security Hardening)

| 項目 | 内容 |
| :--- | :--- |
| DNS Rebinding 対策 | `Host` ヘッダを検証し、`localhost` と IP アドレス以外のホスト名によるアクセスを拒否。悪意あるWebサイトがローカルサーバーの写真・フォルダ情報を読み取る経路を遮断 |
| スマホ連携のトークン認証 | QRコードのURLに接続用トークンを埋め込み、初回アクセス時に HttpOnly Cookie として保存。同じWi-Fi上でもQRコードを読み取っていない端末は接続不可（操作手順は従来どおり） |
| LAN経由APIのホワイトリスト化 | スマホからは写真の閲覧・評価・タグ付け・同期に必要なAPIのみ許可。撮影日時シフト、タグ編集、画像調整、storage操作などPC側の管理機能はLANから利用不可 |
| LAN待受の自動停止 | スマホからの通信が30分間ない場合にLAN待受を自動停止（次回「スマホ連携」表示時に再開） |
| XSS 修正 | ライトボックスのボリュームラベル・重複フォルダ名、インスペクタのシャッター速度/F値をHTMLエスケープ |
| XMP 読み込み上限 | 5MB を超える異常なXMPサイドカーは解析をスキップ（メモリ枯渇防止） |

### データ安全性・コード品質 (Data Safety & Code Quality)

- フォルダの「リフレッシュ」（消失写真のDB整理）でポータブルパス解決を行い、ドライブ未接続やドライブレター変動時に写真レコードを誤削除しないよう保護
- 呼び出し元のない全件クリーンアップ関数を削除（誤用時の全件削除リスクを排除）
- ペアRAW側のXMP探索、実ファイル削除時のパス解決をポータブル対応
- Google Drive 判定のドライブレター `G:` 決め打ちを廃止（USBメモリが `G:` の場合の誤判定を解消）
- 例外の無言握りつぶし57箇所をログ出力付きに是正し、GPS推定・地名補完のDB更新を一括トランザクション化

### 完全ローカル化・UI整理・配布 (Local Assets, UI Cleanup & Distribution)

- Webフォント（Inter / Outfit）と地図ライブラリ Leaflet をアプリに同梱し、外部CDNへの通信を廃止（地図の背景タイル表示時のみ OpenStreetMap に接続）
- 非表示のまま残っていた旧フローティング選択バーの残存コード・CSSを撤去し、デスクトップUIからカラー絵文字を除去して単色線画アイコン・テキストに統一
- `localStorage` が使えない環境でも起動できるよう代替ストレージで保護
- 依存パッケージのバージョンを固定（`setup_portable_python.py`）し、配布ZIP生成時に `cache/`・`storage/`・ログ等の個人データを除外
- セキュリティ回帰テスト `tests/test_security.py` を追加
- 本バージョンよりセマンティックバージョニング（`MAJOR.MINOR.PATCH`：`3.0.1`）へ移行

---

## English

### Security Hardening
- **DNS Rebinding protection**: Validates the `Host` header and rejects any hostname other than `localhost` or IP literals.
- **Token-authenticated mobile LAN access**: The QR code URL now embeds an access token that is stored as an HttpOnly cookie on first visit. Devices on the same Wi-Fi cannot connect without scanning the QR code.
- **LAN API whitelist**: Only the endpoints required for browsing, rating, tagging, and syncing are reachable from the LAN. Administrative APIs remain localhost-only.
- **Idle auto-stop**: The on-demand LAN listener stops automatically after 30 minutes without mobile activity.
- **XSS fixes** in the Lightbox (volume label, duplicate folder names) and Inspector (shutter speed / aperture).
- **XMP size limit**: Sidecars larger than 5 MB are skipped.

### Data Safety & Code Quality
- Folder refresh now resolves portable paths and never deletes records for offline drives or changed drive letters.
- Removed an unused library-wide cleanup function that could delete all records if misused.
- Replaced silent exception blocks with structured logging and batched GPS inference / location backfill queries.

### Fully Local Assets, UI Cleanup & Distribution
- Bundled the Inter / Outfit web fonts and Leaflet locally; no external CDN requests (only OpenStreetMap map tiles require internet).
- Removed deprecated floating selection bar code, unified desktop icons to monochrome SVGs, synced English i18n dictionary, and updated in-app Help / manuals.
- Pinned dependency versions, excluded personal data from release ZIPs, added `tests/test_security.py`, and adopted standard Semantic Versioning (`3.0.1`).
