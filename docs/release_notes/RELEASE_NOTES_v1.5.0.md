# TETHERACT pm v1.5.0 Release Notes

- **Tag**: `v1.5.0`
- **Title**: `TETHERACT pm v1.5.0 - Event-Driven Media Hotplug Detection, External App Auto-Sync & Full Reactive UI Synchronization`
- **Date**: `2026-11-04`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.5.0diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.5.0.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.5.0diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. イベント駆動のメディア抜き挿し自動検知（`WM_DEVICECHANGE` ＋ SSE）
- **SDカード・USBメモリ・外付けSSDの瞬時認識・切断反映**: Windows ネイティブのハードウェア変更通知（`WM_DEVICECHANGE`：64bit `WNDPROC` 対応の非表示ウィンドウによる0秒イベント待機）と Server-Sent Events（`GET /api/media/events`）を連携させ、ポーリング負荷ゼロで外部メディアの接続・取り外しをリアルタイム検知します。
- **更新ボタン不要の自動同期 ＆ クロスメディア自動フォールバック**: メディアを挿抜した瞬間に左サイドバーのフォルダツリー、登録メディア一覧、および写真ギャラリーのオンライン／オフライン表示が自動で切り替わります。複数メディア（SDカードとPC/SSDなど）に同一写真のリンクがある場合、片方のメディアを抜いても接続中の他メディアのリンクへ自動的にフォールバックしてオンライン表示を維持します。

### 2. 外部現像ソフト・エクスプローラー連携の自動更新検知（フォーカス復帰フック）
- **外部アプリ編集・XMPサイドカー追加の自動反映**: 右インスペクタの「関連付けアプリで開く」や「エクスプローラーで開く」を実行したあと、外部ソフトで画像を上書き保存したり `.xmp` サイドカーファイルを書き出して Tetheract のウィンドウへ戻った（フォーカス復帰）際に、対象写真（およびRAW+JPEGペア）のファイル更新日時（`mtime`）や新規サイドカー生成を自動検出し、非破壊調整を維持したままサムネイル再生成とUI更新を自動実行します。
- **開いたフォルダの差分チェック連動**: エクスプローラーで開いた管理下フォルダにファイルの追加・削除があった場合も、ウィンドウ復帰時に自動で変更検知を実行します。

### 3. 全画面リアクティブ同期 ＆ サーバーキャッシュ無効化の完全連動
- **スタック内サブ写真・ライトボックス・2枚比較・一覧・インスペクタの即時同期**: スタック（連写・ブラケット・重複）内の代表以外のサブ写真をライトボックスや2枚比較（Duel）で回転・調整リセット・タグ付与・GPS変更した際、および撮影日時の一括シフト補正や `Loome` 内のファイル／フォルダ名変更を行った際に、全画面のメモリ状態・DOM・枚数バッジ・カレンダー・EXIF表示がリロードなしで即座に同期されるよう徹底改善しました。
- **サーバー側キャッシュ世代連動と ETag 改善**: 写真更新・タグ操作・スキャン完了・メディア挿抜・フォルダ操作のすべてで `/api/photos` のレスポンスキャッシュ世代とオンライン判定キャッシュが即座に無効化されるよう統一し、サムネイル API の ETag に BLOB サイズ・寸法を含めることで回転や調整直後の古いキャッシュ残りを解消しました。また、アプリ多重起動時に新規プロセスの立ち上げではなく既存ウィンドウを前面化するよう改善しました。

---

## English

### 1. Event-Driven Media Hotplug Detection (`WM_DEVICECHANGE` + SSE)
- **Zero-Polling Hardware Detection for SD Cards, USB Drives & External SSDs**: Listens directly to Windows `WM_DEVICECHANGE` hardware notifications on a 64-bit native message loop and pushes events to the UI via Server-Sent Events (`GET /api/media/events`).
- **Automatic UI Refresh & Cross-Media Link Fallback**: Inserting or removing an SD card or external drive immediately updates the Folder tree, Registered Media list, and Online/Offline gallery badges without clicking refresh. Photos linked across multiple media automatically fall back to an online secondary link when the primary media is unplugged.

### 2. External Editor & Explorer Auto-Sync on Window Focus
- **Automatic Thumbnail & XMP Refresh After External Editing**: After opening a photo in an external editor or File Explorer from the Inspector, returning focus to the Tetheract window automatically checks for modified `mtime` or newly created `.xmp` sidecars (`POST /api/photos/check-external-updates`), regenerating thumbnails (preserving non-destructive adjustments) and updating badges on the fly.

### 3. Comprehensive Reactive UI Synchronization & Cache Coherency
- **Instant Sync Across Stacks, Lightbox, Duel, Grid & Inspector**: Rotating, resetting adjustments, editing tags/GPS on non-primary stacked frames, shifting shooting dates, or renaming files/subfolders inside `Loome` now updates all views, filmstrips, calendars, and count badges immediately without reloading.
- **Unified Server Cache Invalidation & ETag Precision**: Synchronized server-side response cache invalidation across all mutation endpoints and media state changes, and included thumbnail BLOB length and dimensions in ETag headers to guarantee fresh previews after edits.
