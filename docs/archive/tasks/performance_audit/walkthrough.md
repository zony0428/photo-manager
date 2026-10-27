# パフォーマンス改善 修正内容の確認 (Walkthrough)

- 対象バージョン: **1.35 → 1.36**
- 実施日: 2026-10-07〜08
- 進め方: 監査と計画（[implementation_plan.md](implementation_plan.md)）→ 作業パッケージ WP-0, A〜F を別 Agent に委譲（[delegation_prompts.md](delegation_prompts.md)）→ 統合レビュー・修正・検証

---

## 1. 計測結果（改修前 → 改修後）

計測には `scratch/perf/bench.py --fresh` を使用した（本番DBを複製して計測するため、本番DBは変更しない）。写真は 12,596 件。

| 項目 | 改修前 | 改修後 | 主な施策 |
|---|---|---|---|
| `/api/photos` 応答（HTTP実測） | 約620ms | **233ms** | `jsonable_encoder` を回避（`_fast_json`）、stack_photos の列を削減 |
| `get_photos` クエリ | 117ms | 95ms | NOCASE インデックスと範囲比較 |
| 一覧データの大きさ / うち stack_photos | 7.81MB / 3.62MB | 6.44MB / 1.87MB | スタックメンバーの不要な列を削除 |
| `get_folders_summary` | 243ms | 209ms | FS 確認を TTL キャッシュ化 |
| サムネイル生成（1枚） | 92〜104ms | **39ms** | JPEG draft と reducing_gap、rawpy の1回オープン化 |
| サムネイル一括生成 | 約9枚/秒 | **約70枚/秒** | 4スレッド並列 + バッチ保存 |
| 移動ファイルの照合 | 0.63ms（全件走査） | 0.01ms | `idx_photos_name_size` |
| 再スキャン（変更なしの30枚） | 0.25s | **0.05s** | size と mtime による差分判定 |
| サムネイル再要求 | 200 + 本文 | **304（本文なし）** | ETag / If-None-Match |

---

## 2. 作業パッケージ別の変更概要

| WP | 内容 | 主なファイル |
|---|---|---|
| WP-0 | 旧 `server/database.py` を削除、規約文書を修正、配布時に `*.orig_backup` を除外 | AGENTS.md, build_dist.bat |
| WP-A | `_fast_json` の導入、サムネイル配信で `get_photo_brief` と 304 応答 | app.py, photos.py |
| WP-B | インデックスの追加・整理、`_directory_filter_sql`（範囲比較）、stack_photos の列削減、GPS検索を BETWEEN 化 | schema.py, photos.py ほか |
| WP-C | `file_mtime` 列、差分スキャン、`upsert_photos_batch`、変更ファイルのサムネイル無効化、スタック更新の差分化 | scanner.py, stacks.py |
| WP-D | `render_thumbnail_webp` に処理を統一、JPEG draft、一括生成の並列化と多重起動防止ロック | scanner.py, preload_thumbnails.py, raw_loader.py |
| WP-E | 選択表示の差分更新、`refreshAll` を必要最小限の再取得に置換、評価変更時の全再描画を廃止、`content-visibility` | app.js, style.css |
| WP-F | AIタグ付けのチャンク処理と numpy 化、executemany、cache_size 16MB、オンライン判定の TTL キャッシュ | ai/*.py, connection.py, scanner.py |

---

## 3. 統合レビューで見つけて修正した問題

| # | 問題 | 修正 |
|---|---|---|
| 1 | 一覧を再描画したあとに選択を外しても、カードのハイライトが残る | `renderPhotoGrid` で差分の基準 `lastSelectedPhotoIds` を現在の選択に同期する |
| 2 | ドライブ直下（`C:\`）の写真がフォルダ絞り込みに出ない | `_directory_filter_sql` の下限を `>=` にし、非再帰時も `C:\` 表記と一致させる |
| 3 | フォルダ解除時に scan_roots の LIKE の `_` が別フォルダに誤一致する | 範囲比較ヘルパーに置換 |
| 4 | サムネイル一括生成で、完了済みの future が結果を保持し続ける | future を集合で管理し、処理済みのものを都度破棄 |
| 5 | スタック再計算で `paired_raw_path` の扱いが旧実装と異なる | 旧実装と同じ扱いに戻す（全件比較で差分 0 を確認） |
| 6 | TTL キャッシュのクリアがどこからも呼ばれていない | `scan_directory` の開始時にクリアする |
| 7 | `presets.py` の docstring とエラーメッセージが文字化けしていた | 日本語に復元 |
| 8 | 改行コードが LF のファイルが混在していた | CRLF に統一 |

### 評価フィルタ外になった写真の挙動（ユーザー決定）
- 評価を変えた結果、現在の評価フィルタに含まれなくなった写真（既定では「棄」）は、**その写真だけを一覧から即座に除去する**。
  - グリッド全体の再描画は行わない。
  - 段階描画の途中や 0 枚になった場合だけ、全再描画に切り替える。
- ライトボックス表示中は**次の写真へ自動で進む**。
- 選択状態、Shift範囲選択の起点、ライトボックスの位置は `removePhotoFromView()` で補正する。
- `MANUAL.md` とアプリ内ヘルプ（`#helpModal`）に追記済み。

---

## 4. 検証内容

- **旧版との比較**（DB複製で実施）
  - `recalculate_stacks` を HEAD 版と新版で全件実行し、12,596 件すべてでスタック関連列の差分が 0。
  - フォルダ絞り込みは、旧 LIKE 条件と新ヘルパーで全 92 フォルダの件数が一致。
  - 合成ケース（`C:\` 直下、`Photo_1` と `PhotoX1`、大文字小文字の違い）も期待どおりの結果。
- **差分スキャン**（DB複製で実施）: 1回目は updated=30、2回目は unchanged=30。`file_mtime` が NULL の行は 0。
- **API スモークテスト**: version / photos / tags / folders / timeline / cameras / filter-presets がすべて 200。サムネイル再要求は 304。
- **ブラウザ確認**（すべて合格。コンソールエラーなし）
  - 選択・解除・再描画後の解除
  - 棄によるグリッドからの即時除去
  - ライトボックスでの自動送り
  - Shift範囲選択
  - フォルダ切替

---

## 5. 運用上の注意

- 初回起動時に `file_mtime` 列とインデックスの追加マイグレーションが走る（非破壊）。
- 既存の写真は `file_mtime` が未記録のため、**最初の再スキャンだけは全件を解析する**。2回目以降は差分スキャンになる。
- ベンチマーク: `python\python.exe scratch\perf\bench.py --fresh`（scratch は git 管理外）。
