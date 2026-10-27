# Photo Manager v3.0.2 Release Notes

- **Tag**: `v3.0.2`
- **Title**: `Photo Manager v3.0.2 - Lightbox Stack Primary Badge & Instant Frame Promotion`
- **Date**: `2026-10-27`

---

> [!NOTE]
> **差分アップデートのご案内 / Lightweight Diff Update Guide**
>
> - **既存ユーザー様向け（差分版 `PhotoManager_v3.0.2diff.zip`）**: 解凍して既存の `PhotoManager` フォルダへ上書きコピーするだけで更新できます（`cache/`・`storage/`・`python/`・`models/` はそのまま保持されます）。
> - **初回導入の方（フルパッケージ版 `PhotoManager_v3.0.2.zip`）**: ポータブル Python 同梱版を解凍し、`PhotoManager.exe` を起動してください。
> - **For Existing Users (`PhotoManager_v3.0.2diff.zip`)**: Extract and overwrite your existing `PhotoManager` directory. `cache/`, `storage/`, `python/`, and `models/` remain untouched.

---

## 日本語 (Japanese)

### UI / 操作性改善 (UI & Workflow Improvements)

- **ライトボックスでのスタック「代表」バッジ追加・即時切替**:
  連写（バースト）・ブラケット（BKT）などのスタックグループに属する写真をライトボックスで閲覧中、上部ツールバーの評価ボタン（`優・良・可・棄`）の左隣に「**代表**」バッジボタンを表示するようにしました。
  - 現在のコマが代表でない場合は落ち着いたグレー表示となり、クリックするとそのコマをグループの代表写真に設定して朱色（`--accent-primary`）で点灯します。
  - 下部ブラケット切替バー（`1/N`, `2/N` ...）のピルにも、現在どのコマが代表か一目でわかるインジケータードットを表示します。
  - ライトボックスを閉じたりグリッドへ戻ったりすることなく、拡大確認しながら4段階評価と代表コマ選びを一連の流れで完結できます。

---

## English

### UI & Workflow Improvements

- **Stack Primary Badge & Instant Switching in Lightbox**:
  When viewing a photo belonging to a burst, bracket (BKT), or manual stack in the Lightbox, a **Primary (`代表`)** badge button now appears immediately to the left of the 4-tier rating widget (`優 / 良 / 可 / 棄`) in the top toolbar.
  - Appears in muted gray for non-primary frames and lights up in vermilion (`--accent-primary`) when the current frame is the stack's primary photo.
  - Clicking an inactive badge promotes the currently viewed frame to the stack's primary photo on the spot and updates the indicator dot on the bottom frame switcher bar (`1/N`, `2/N`, ...).
