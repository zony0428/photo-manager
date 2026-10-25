# タスク: 左ペインタグフィルタセクションの調整 & クイックアクセスパネル再編 & ペイン背景色統一

## 概要
左ペインの「タグ (アルバム)」セクション、クイックアクセスセクション、および右インスペクタペインにおいて、以下のUIレイアウト調整を行う。
1. タグ種別切替タブの並び順を「手動」「AI」「すべて」に変更し、デフォルト選択を「手動」にする。
2. 「カラー」フィルタを折りたたみ可能なエキスパンダに変更し、セクションの最上部に配置する（初期状態は「閉じ」）。
3. タグ種別タブのスタイル・背景色を右インスペクタのタブ表示と完全に仕様統一する。
4. クイックアクセスパネルから「評価フィルタ」と「ショートカット」セクションを割愛し、代わりに「フィルタプリセット」（現在の条件保存 & 保存済みセット一覧）機能を統合する（旧セクション6は廃止）。
5. 左ペインの背景色・境界線スタイルを右インスペクタペインにも適用し、左右の視覚的バランスを完全に統一する (v1.82)。

---

## タスクリスト

- [x] 実装計画の策定 (`docs/tag_filter_section_adjustment/implementation_plan.md`) <!-- id: 0 -->
- [x] HTMLマークアップの改修 (`frontend/index.html`) <!-- id: 1 -->
  - [x] カラーフィルタを最上部に移動しエキスパンダ構造化
  - [x] タグ種別タブの並び順を手動・AI・すべてに変更し、手動を初期activeに設定
- [x] スタイルの改修 (`frontend/css/style.css`) <!-- id: 2 -->
  - [x] カラーエキスパンダの開閉ヘッダー・矢印アニメーション・ボーダー・ボディのスタイリング
  - [x] 和紙テーマ（paper）対応
- [x] JavaScriptロジックの改修 (`frontend/js/common.js`, `frontend/js/app.js`) <!-- id: 3 -->
  - [x] デフォルトの `tagSourceFilter` を `'manual'` に設定
  - [x] カラーエキスパンダの開閉トグル処理および初期状態（デフォルト閉じ）の実装
  - [x] フィルタ全リセット時のデフォルト値を `'manual'` に反映
- [x] タグ種別タブのインスペクタタブ仕様統一 (v1.80) <!-- id: 7 -->
  - [x] `.tag-type-segmented-control` をインスペクタナビと同等のアンダーラインベースバーへ改修
  - [x] 背景色をインスペクタタブナビと完全に一致させる (`rgba(0, 0, 0, 0.22)` / paper: `rgba(0, 0, 0, 0.04)`)
  - [x] `.tag-segment-btn` をフラット・アンダーラインアクティブ（`2px solid var(--accent-primary)`）へ改修
  - [x] 和紙テーマ（paper）および夜墨テーマ（sumi）対応
- [x] クイックアクセスパネルの再編 & フィルタプリセット統合 (v1.81) <!-- id: 8 -->
  - [x] クイックアクセスから評価フィルタ・ショートカット案内を削除
  - [x] フィルタプリセット（現在の条件保存＋保存済みセット一覧）をクイックアクセス内に移設
  - [x] 旧セクション6（★ フィルタプリセット）のアコーディオンを削除
  - [x] `app.js` のアコーディオン開閉連動処理の調整
- [x] 左右ペインの背景色・境界線統一 (v1.82) <!-- id: 9 -->
  - [x] `.inspector-pane` の境界線を `border-left: 1px solid var(--border-soft)` に統一
  - [x] `[data-theme="paper"] .inspector-pane` に `background: #fbf9f4` と `border-left: 1px solid rgba(0, 0, 0, 0.08)` を適用
  - [x] `[data-theme="paper"] .inspector-header` に `background: #f4efe6` を適用
  - [x] `[data-theme="paper"] .inspector-fixed-preview` に `background: #fbf9f4` を適用
- [x] 夜墨テーマの銀墨スレートダーク調色 (v1.83) <!-- id: 10 -->
  - [x] `--bg-secondary` を `#262c35`（銀墨スレート）に設定し、左右ペインとカードを一段明るく調整
  - [x] `--bg-primary`（`#16181b`）、`--bg-tertiary`（`#303844`）、`--bg-hover`（`#3c4554`）の連動調色
  - [x] `--border-color`（`#3d4756`）、`--border-soft`（`#2f3642`）の境界線調色
  - [x] `--text-main`（`#f0f2f5`）、`--text-muted`（`#9ca6b5`）の視認性向上
- [x] サムネイル固定サイズ化（スライダー完全連動・ペイン開閉時のサイズ変動防止）(v1.84) <!-- id: 11 -->
  - [x] `.photo-grid` の `grid-template-columns` を `repeat(auto-fill, var(--thumbnail-size))` に変更
  - [x] `body.layout-mount .photo-grid` の `grid-template-columns` を `repeat(auto-fill, calc(var(--thumbnail-size) * 1.15))` に変更
  - [x] ペイン開閉時はカードサイズを変えず、列数のみを増減させる挙動に統一
- [x] バージョン更新とドキュメント同期 <!-- id: 4 -->
  - [x] `VERSION` を 1.83 → 1.84 へインクリメント
  - [x] `frontend/index.html` の `appVersion` および CSS キャッシュバスター更新
  - [x] `MANUAL.md` の記述更新
  - [x] アプリ内 `#helpModal` の記述更新
- [x] 動作確認・検証 <!-- id: 5 -->
  - [x] DOM構造・JSシンタックス・CSS整合性の検証 (`scratch/verify_changes.py`, `scratch/verify_dom.py`)
- [x] 変更内容の確認書作成 (`docs/tag_filter_section_adjustment/walkthrough.md`) <!-- id: 6 -->
