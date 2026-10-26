# Walkthrough: Photo Manager v3.00 (UI/UX 大改装・ライトボックス高速化・Step 3 完結)

## 1. ダブルクリック → ビューワ（ライトボックス）起動遅延の原因と修正

16,500枚超のライブラリ表示時に写真グリッドのダブルクリックからライトボックスが開くまで遅くなっていた原因を特定し、以下の5つの最適化を実施しました：

| ボトルネック原因 | 修正内容（ファイル） |
| :--- | :--- |
| **1. `openLightbox` での 16,565 件フィルムストリップ同期構築** | [`lightbox.js`](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/lightbox.js) にて、`loadLightboxPhoto`（モーダル表示＋メイン画像リクエスト）を **t = 0ms** で最優先実行し、未構築時の `renderFilmstrip` を `requestAnimationFrame` へ非同期化。さらに全件分の `<img>` 生成と `IntersectionObserver.observe` を廃止し、画面中央付近（`±18`枚）のみオンデマンドで `<img>` を生成する方式へ刷新 |
| **2. フル解像度画像（`/view`）のロード待ちによる空白・残像** | [`lightbox.js`](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/lightbox.js) の `updateLightboxContent` にて、グリッドで既にブラウザキャッシュに乗っているサムネイルを **0ms で即時表示** しつつ、バックグラウンドでフル解像度画像（`/api/photo/{id}/view`）をプリロードして完了次第シームレスに差し替える二段描画を導入 |
| **3. 全写真クリック時の不要な `/api/photo/{id}` 通信とインスペクタ二重再描画** | [`inspector.js`](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/inspector.js) の `showSingleInspector` が `photo.xmp_info === undefined` のために全写真クリック時に `/api/photo/{id}` を発火し、約120ms後（ちょうどダブルクリックの2打目と重なる瞬間）にインスペクタ全体を再構築していた問題を修正。一覧APIの `duplicate_count <= 1` かつ `has_xmp === false` の写真では通信を完全スキップし、必要な場合も `180ms` デバウンスを適用 |
| **4. ダブルクリック時（`click` × 2 → `dblclick`）の重複 `updateInspectorView` 呼び出し** | [`app.js`](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/app.js) にて、`updateSelectionUI()` 直後の重複 `updateInspectorView()` 呼び出しを削除し、`e.detail >= 2`（2回目クリック）および `dblclick` 時に既に単一選択済みの場合はインスペクタ再構築をスキップ |
| **5. 日本語モード時の `MutationObserver` 常時監視 & `/view` の5クエリ実行** | [`i18n.js`](file:///c:/Users/zony0/Documents/photo-manager/frontend/js/i18n.js) で日本語（`JP`）モード時は `MutationObserver` を `disconnect()` してDOM監視負荷をゼロ化。また [`server/app.py`](file:///c:/Users/zony0/Documents/photo-manager/server/app.py) の `/api/photo/{id}/view` を `get_photo_by_id`（タグ・スタック・重複・XMPの5クエリ）から `get_photo_brief`（単一主キー検索1クエリ）へ軽量化 |

---

## 2. デザインルールの KI（ナレッジ＆エージェントルール）永続化

今回の「脱・芋UI（Tiat 志向ストイック・デザインシステム）」の設計ルールが今後のセッションでも絶対に失われないよう、以下のファイルに体系化して保存しました：

- **ナレッジアイテム (KI)**: [`docs/knowledge/ui-design-system-and-tiat-guidelines.md`](file:///c:/Users/zony0/Documents/photo-manager/docs/knowledge/ui-design-system-and-tiat-guidelines.md)
- **AIエージェント規約**: [`.agents/rules/ui-design-system.md`](file:///c:/Users/zony0/Documents/photo-manager/.agents/rules/ui-design-system.md)（および [`AGENTS.md`](file:///c:/Users/zony0/Documents/photo-manager/AGENTS.md) からの参照リンク追加）
- **専門サブエージェント定義の永続化**:
  - [`.agents/agents/ui-design-critic/agent.md`](file:///c:/Users/zony0/Documents/photo-manager/.agents/agents/ui-design-critic/agent.md)
  - [`.agents/agents/oss-editorial-director/agent.md`](file:///c:/Users/zony0/Documents/photo-manager/.agents/agents/oss-editorial-director/agent.md)

---

## 3. v3.00 バージョン更新 & ドキュメント・リリースノート整備

- [`VERSION`](file:///c:/Users/zony0/Documents/photo-manager/VERSION) および [`frontend/index.html`](file:///c:/Users/zony0/Documents/photo-manager/frontend/index.html) を **`v3.00`** に更新
- [`README.md`](file:///c:/Users/zony0/Documents/photo-manager/README.md) / [`README_EN.md`](file:///c:/Users/zony0/Documents/photo-manager/README_EN.md) を v3.00 の2段階左サイドバー・1段ヘッダー・4:3インスペクタ仕様に合わせて更新
- [`RELEASE_NOTES.md`](file:///c:/Users/zony0/Documents/photo-manager/RELEASE_NOTES.md) および [`docs/release_notes/RELEASE_NOTES_v3.00.md`](file:///c:/Users/zony0/Documents/photo-manager/docs/release_notes/RELEASE_NOTES_v3.00.md) を作成
