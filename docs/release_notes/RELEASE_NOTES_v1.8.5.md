# TETHERACT pm v1.8.5 Release Notes

- **Tag**: `v1.8.5`
- **Title**: `TETHERACT pm v1.8.5 - Lightbox Filmstrip Wheel Precision Fix & Compact Footer/Header Bar with Dynamic Tooltips`
- **Date**: `2026-11-10`

---

> [!CAUTION]
> **⚠️【重要】v1.7.0 以降を起動すると、旧バージョン（v1.6.1以前）との後方互換性がなくなります（特に差分アップデートの場合）**
>
> - **v1.7.0 以降で一度でも起動したデータベース（`cache/library.db`）には新しいセキュリティ＆エシカル保護スキーマが自動適用されるため、それ以降は v1.6.1 以前の旧バージョンでは起動できなくなります。**
> - 万が一 v1.6.1 以前へ戻す可能性がある場合は、アップデート前にあらかじめ `cache/library.db` を別場所へコピーしてバックアップしておくことを推奨します。
>
> **⚠️ [IMPORTANT] Launching v1.7.0+ Removes Backward Compatibility with Older Versions (v1.6.1 or Earlier)**
> - Once launched in v1.7.0+, `cache/library.db` is upgraded to the new security & ethical protection schema and **can no longer be opened or launched by v1.6.1 or earlier**.

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **既存環境（軽量差分版 `Tetheract_v1.8.5diff.zip`）**:
>   - **v1.8.0 以降の環境からの更新時（自動クリーン・アップデート）**: ダウンロードした `Tetheract_v1.8.5diff.zip` を**解凍せずにそのまま**アプリフォルダへ置いて **`Tetheract.exe`** を起動するだけで、古い不要プログラムファイルを自動消去してクリーン更新できます（`cache/`・`Loome/`・`storage/`・`python/`・`models/` およびセキュリティ鍵はすべてそのまま保たれます）。
>   - **v1.7.2 以前からの更新時**: `Tetheract_v1.8.5diff.zip` を解凍して既存フォルダへ上書きコピーし、**`Tetheract.exe`** を起動してください（起動時にルート階層の旧 `Build.bat`・`start.bat`・`run.py`・`launcher/` が自動整理されます）。
> - **初回導入（フル版 `Tetheract_v1.8.5.zip`）**: 解凍して **`Tetheract.exe`** を起動してください（インストール不要）。
> - **For Existing Users (`Tetheract_v1.8.5diff.zip`)**: Starting from v1.8.0+, updates can be applied cleanly simply by placing `Tetheract_v1.8.5diff.zip` (unextracted) in the app root and launching **`Tetheract.exe`**. If upgrading from v1.7.2 or earlier, extract and overwrite your existing folder, then launch **`Tetheract.exe`**.

---

## 日本語 (Japanese)

### 1. ライトボックス下部「フィルムロール（フィルムストリップ）」のマウスホイール操作バグ修正（v1.8.5）
- **1枚飛ばし（二重進行）と逆方向への切り返し遅延を根本解消**:
  - ライトボックス下部のフィルムロール（`#filmstrip`）上でマウスホイールを回した際、汎用ホイールハンドラと高精度ホイールハンドラが二重登録されていたことで「1ノッチで写真が2枚飛んでしまう（1枚飛ばし）」問題と、高精度ハンドラ側で逆方向へ回した際に前方向の蓄積値・クールダウンが残って「前後の行き来に異常に時間がかかる」問題を修正しました。
  - バーストセレクタと同等の1ノッチ即応性と、逆回転した瞬間に蓄積量とクールダウンを即時リセットする制御に一本化し、狙った1枚へ正確にホイール移動できるようになりました。

### 2. フッター／ヘッダーバーの省スペース化とドロップダウン動的ツールチップ対応（FHD〜QHD環境最適化）（v1.8.5）
- **表示レイアウト切替のドロップダウン化・区切り線整理・右端ボタンのアイコン化**:
  - フルHD（1920×1080）〜QHD環境でもメインツールバー（下部フッター／上部ヘッダー）が窮屈にならず余裕を持って1行に収まるよう、「グリッド / びっしり / マウント」の3連ボタンをコンパクトなドロップダウンリストに集約し、右端の「設定・ヘルプ・終了」ボタンをアイコンのみのクリーン表示に統一しました。
  - あわせて、「絞り込み条件＋枚数バッジ」と「並び順＋表示レイアウト」の境界が視覚的に正しくなるようセパレータ（区切り線）の位置を整理しました。
- **各ドロップダウンの選択項目全文を表示する動的ホバーツールチップ**:
  - 省スペース化に伴いドロップダウン幅を適正化した際も、マウスカーソルを乗せると現在選択されている項目名（例：`表示対象: すべての写真`、`形式・状態: RAW + JPEG ペア`、`並び替え: 新しい順 (撮影日)`、`レイアウト: びっしり`、日英切替連動）がツールチップで全文表示されるようになりました。

---

## English

### 1. Lightbox Filmstrip Mouse Wheel Navigation Fix (v1.8.5)
- **Eliminated 1-Frame Skipping & Reverse-Direction Lag**:
  - Fixed a duplicate `wheel` event listener registration on `#filmstrip` that caused a single mouse wheel notch to skip two photos at once, as well as a direction-reversal accumulation/cooldown issue that made scrolling back and forth sluggish.
  - Unified filmstrip wheel handling into a single precision-aware handler with instant accumulator/cooldown reset on direction reversal, matching the crisp responsiveness of the burst selector.

### 2. Compact Footer/Header Toolbar & Dynamic Dropdown Tooltips for FHD/QHD Displays (v1.8.5)
- **Layout Mode Dropdown, Logical Separator Placement & Icon-Only Utility Buttons**:
  - Converted the `Grid / Tight / Mount` segmented buttons into a compact dropdown (`#viewModeSelect`), repositioned the toolbar separator cleanly between `Filters + Photo Count` and `Sort + Layout Controls`, constrained dropdown widths, and streamlined the right-hand `Settings / Help / Quit` buttons to clean icon buttons so the entire toolbar fits comfortably on FHD (1920×1080) and QHD screens without crowding.
- **Dynamic Full-Label Tooltips on Hover**:
  - Added automatic tooltip synchronization (`JP` / `EN` aware) across all toolbar dropdowns so hovering any truncated dropdown immediately displays the full name of the currently selected option.
