# TETHERACT pm v1.1.1 Release Notes

- **Tag**: `v1.1.1`
- **Title**: `TETHERACT pm v1.1.1 - Subfolder Diff Detection, Parent Folder Management, Multi-SD VSN Stability & Launcher Icon Refresh`
- **Date**: `2026-11-02`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.1.1diff.zip`）**: 既存フォルダへ上書きコピーして **`Tetheract.exe`** を起動してください（`cache/`・`storage/`・`python/`・`models/` はそのまま引き継がれます）。
> - **初回導入（フル版 `Tetheract_v1.1.1.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.1.1diff.zip`)**: Extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. 親フォルダの「直下＋子フォルダ合計」による管理下判定 ＆ 左クリック時の子フォルダ増減検知
- **親フォルダの管理下（`managed`）統合判定と内訳ツールチップ**: 直下に写真が0枚でも配下の子フォルダに管理下の写真がある親フォルダ（例：年別フォルダ `2026` 等）を自動的に管理下（`managed`）として扱い、フォルダ行・枚数バッジのホバー時に `合計 X 枚（直下: Y 枚 / 子フォルダ: Z 枚）` の内訳を表示します。また、右クリック「管理に追加してスキャン」も直下に画像が無い場合は配下を含めた再帰スキャンへ自動フォールバックします。
- **左クリック時の子フォルダ追加・消失・枚数増減の自動検知＆一括リフレッシュ**: 管理下フォルダを左クリックした際、直下ファイルだけでなく配下の子フォルダの追加・消失（例：`202611` の新規作成など）や子フォルダ内の写真増減も高速検知し、ワンクリックで配下ごと最新化できる通知ダイアログ（キャンセル時のセッション内再通知抑止付き）を追加しました。

### 2. 複数SDカード（VSN）管理・メタデータ引き継ぎ・スタック計算の信頼性＆高速化
- **VSN別スタック分離とSQLiteロック解消**: 同一ドライブ文字・同一フォルダ構造（例：`E:\DCIM\100MSDCF`）の別SDカード間で同名ファイルが合体スタックされないよう `volume_serial` 単位でスタック計算・RAW+JPEGペアリングを分離し、バッチスキャン時のVSN退避統合におけるSQLite自己ロックを解消しました。
- **ドライブ文字変動時のSDカード追従・インデックス高速化・切断ネットワークドライブ回避**: 前回と異なるドライブ文字で接続されたSDカードのフォルダツリー・スキャンルート自動追従、重複照合・VSN復帰照合のインデックス追加によるスキャン高速化、およびメディア一覧・VSN照合時の切断済みネットワークドライブ照会によるブロック回避を行いました。

### 3. セキュリティ強化・データ保護・ランチャー（`Tetheract.exe`）アイコン更新
- **LAN Origin検証の厳格化とデータ保護**: Origin検証をループバックと同一オリジン（`Origin = Host`）のみに限定してLAN上の他ホストからのCSRFを遮断。あわせてフォルダ再帰解除時の前方一致誤爆防止、XMPサイドカーのVSN対応、AIカラータグ単体再判定時のサムネイル自動生成、拡大カレンダー表示中のグリッドショートカット誤発火防止を修正しました。
- **ランチャー（`Tetheract.exe`）ビルド時のアイコンキャッシュ自動更新**: `Build.bat` / `build_launcher.bat` / `build_dist.bat` および `run.py` にて、旧 `PhotoManager.exe` 移行時の単純リネームによる旧アイコンキャッシュ残りを防ぎ、クリーンビルドと Windows Shell アイコンキャッシュ更新通知（`SHChangeNotify`）を自動実行するよう改善しました。

---

## English

### 1. Parent Folder Management via Subfolder Totals & Subfolder Diff Detection on Left-Click
- **Unified Managed Status & Breakdown Tooltips for Parent Folders**: Parent folders containing managed photos in subfolders (even with 0 direct files, e.g., yearly folder `2026`) are automatically treated as `managed`, displaying a `Total: X (Direct: Y / Subfolders: Z)` breakdown tooltip on hover. Right-clicking "Add & Scan" also automatically falls back to recursive scanning when no direct image files exist.
- **Automatic Subfolder Addition/Deletion & File Diff Detection on Left-Click**: Clicking a managed parent folder now detects added/removed subfolders and file changes inside subfolders, prompting to refresh the entire subtree with a single click (with per-session snooze when canceled).

### 2. Multi-SD Card (VSN) Stability, Stack Isolation & Scan Performance
- **Per-VSN Stack Isolation & SQLite Lock Resolution**: Isolated stack calculation and RAW+JPEG pairing by `volume_serial` so identically named files across different SD cards on the same drive letter (`E:\DCIM\100MSDCF`) never merge into the same stack, and resolved SQLite self-locking during batch VSN duplicate merging.
- **Cross-Drive-Letter SD Card Tracking, Index Optimization & Disconnected Network Drive Protection**: Automatically tracks connected SD cards across drive letter changes in the Folder Tree, added database indexes for fast duplicate/VSN matching, and avoided blocking I/O on disconnected network drives.

### 3. Security Hardening, Data Protection & Launcher (`Tetheract.exe`) Icon Refresh
- **Strict Origin Validation & Data Safety Fixes**: Restricted Origin validation to loopback and same-origin (`Origin = Host`) to prevent cross-host LAN CSRF. Fixed prefix-collision protection on recursive folder unmanage, VSN resolution for XMP sidecars, thumbnail auto-generation before single AI color re-tagging, and grid shortcut suppression while the expanded calendar modal is open.
- **Automatic Windows Shell Icon Cache Refresh for `Tetheract.exe`**: Improved `Build.bat`, `build_launcher.bat`, `build_dist.bat`, and `run.py` to perform clean builds and trigger Windows Shell icon cache notifications (`SHChangeNotify`) instead of renaming legacy `PhotoManager.exe` binaries.
