# TETHERACT pm v2.0.2 Release Notes

- **Tag**: `v2.0.2`
- **Title**: `TETHERACT pm v2.0.2 - NeXTSTEP-Style 300ms Cascade Flyout Menus, Lightbox Fade-In & 200% Thumbnail Zoom & Mouse Back Close`
- **Date**: `2026-11-09`

---

> [!NOTE]
> **アップデート案内 / Update Guide**
>
> - **v2.0系（Android連携・タッチUI統合版 / `v2` ブランチ）**:
>   - `dist_v2/`（フル版）および `dist_v2_update/`（軽量差分版）へ出力されます。
>   - 既存の v2.0.x 環境では `Tetheract_v2.0.2diff.zip` をそのままアプリフォルダへ置いて **`Tetheract.exe`** を起動することでクリーン・アップデートが適用されます。

---

## 日本語 (Japanese)

### 1. 左ペイン全フィルタ項目のカード枠精緻化 ＆ 300ms ホバー右展開カスケードメニュー（v2.0.2）
- **左ペイン（`Folder / Tag / Place / Historia / Gear`）のカード形状・クリアランス調整**:
  - 各フィルタ項目カードの角丸をシャープな `1.5px`（内側 `[▶]` / `[▼]` トグルも `1.5px`、枚数バッジは `2px`）に引き締め、カードの縦幅（`min-height: 29px`）を維持したまま上下間隔を `1.5px` に詰めて一覧性を向上しました。
- **NeXTSTEP風 300ms ホバー右展開カスケード子メニュー（`sidebar_cascade_flyout.js`）**:
  - 左ペインの親項目にマウスカーソルを **300ms** 乗せると、左ペインのツリーを開かなくても右側に多段カスケード子メニューがふわっとフェードイン展開され、階層を辿って直接絞り込み（左クリック：含む／選択、右クリック：除外／コンテキストメニュー）が行えるようになりました。
  - フォルダ・ドライブのカスケードではダークヘッダー内にパス・メディアラベル・VSN情報およびサブフォルダ件数を統合表示し、タグのカスケードでは不要なポップアップ情報パネルを出さず子タグ一覧のみをすっきり表示します。

### 2. 右クリックメニュー ＆ `Loome` カスケードの 300ms ホバー展開・ソフトフェードイン統一（v2.0.2）
- **全サブメニューの展開タイマーを 300ms に統一**:
  - 右クリックコンテキストメニュー（`評価を設定`、`タグを付ける`、`調整と回転`、`テイクアウト`、`Loomeへコピー`、`Loome内で移動`）のマウスオーバー展開時間を **300ms** に統一しました（クリック時は0msで即時展開・実行）。
- **ソフトフェードイン ＆ チラつき防止**:
  - 子メニューおよびカスケードパネル展開時に `0.18s cubic-bezier(0.22, 1, 0.36, 1)` のソフトフェードイン（`nsMenuSoftFadeIn`）を適用し、同一階層内で別項目へカーソルを移動した際はパネルDOMを再利用することで画面のチラつき（フリッカー）を解消しました。

### 3. ライトボックスのフェードイン表示・先行サムネイル表示廃止・サムネイル200%上限拡大・マウス「戻る」ボタン対応（v2.0.2）
- **ライトボックス起動＆画像切替のフェードイン化**:
  - ギャラリーからサムネイルをダブルクリックしてライトボックスを開く際、モーダルおよびメイン画像がふわっとフェードイン（`0.22s`）するように改善しました。
- **本体ファイル接続時の先行サムネイル表示を廃止**:
  - 本体ファイルが存在する（オンライン）ときは、先に小さいサムネイルを表示せず、フル解像度画像（`/view`）のロード完了と同時に本来のサイズでフェードイン表示し、解像度ジャンプの違和感を解消しました。
- **サムネイルのみ利用可能時の最大200%拡大表示**:
  - オフラインやリンク消失などサムネイルのみ利用可能な写真では、ステージ枠内に収まる範囲でサムネイル解像度の **最大200%（2.0倍）** を上限として拡大表示するようにしました。
- **マウスの「戻る」ボタンでライトボックスを閉じる操作に対応**:
  - ライトボックス表示中に `Space` / `Esc` キーや `×` ボタンに加え、マウスのサイド「戻る」ボタン（第4ボタン: `MouseEvent.button === 3`）およびブラウザ戻る操作（`popstate`）でライトボックス（調整モーダル表示中は調整モーダル）を閉じられるようにしました。

---

## English

### 1. Refined Left-Pane Filter Cards & 300ms Hover Cascade Flyout Menus (v2.0.2)
- **Sharper Corner Radius & Tighter Vertical Clearance**:
  - Refined left-pane filter item cards to a crisp `1.5px` corner radius (`1.5px` vertical gap while preserving `29px` row height).
- **NeXTSTEP-Style 300ms Right-Expanding Cascade Submenus (`sidebar_cascade_flyout.js`)**:
  - Hovering over any parent item in `Folder`, `Tag`, `Place`, `Historia`, or `Gear` for **300ms** smoothly fades in a multi-column cascade submenu to the right, with folder/drive metadata integrated into the dark header and clean child-tag lists without redundant tooltips.

### 2. Unified 300ms Submenu Hover Timers & Anti-Flicker Soft Fade-In (v2.0.2)
- **300ms Hover Expansion Across All Context Submenus**:
  - Unified hover expansion delay to **300ms** (instant on click) across all right-click submenus (`Set Rating`, `Add Tag`, `Adjust & Rotate`, `Takeout`, `Copy to Loome`, `Move in Loome`) with a `0.18s` soft fade-in and DOM reuse to eliminate flicker when moving between rows.

### 3. Lightbox Soft Fade-In, Direct Full-Resolution Load, 200% Thumbnail Zoom Cap & Mouse Back Button Support (v2.0.2)
- **Soft Fade-In & No Premature Thumbnail Flash When Online**:
  - Opening the lightbox and switching photos now smoothly fades in (`0.22s`). When the original file is available online, the lightbox loads and fades in the full-resolution image directly without flashing the low-res thumbnail first.
- **Up to 200% Enlargement for Thumbnail-Only Photos**:
  - Offline or unlinked photos with only a cached thumbnail are automatically scaled up to a **200% (`2.0x`)** ceiling within the viewer stage.
- **Mouse Back Button Support**:
  - Pressing the mouse Back button (`MouseEvent.button === 3` / `popstate`) now closes the active lightbox (or image adjustment modal).
