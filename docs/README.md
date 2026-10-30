# Photo Manager - ドキュメントポータル (Documentation Portal)

本ディレクトリは、Photo Manager の設計文書、技術知見、リリースノート、および開発履歴アーカイブを集約したドキュメント基底ポータルである。

---

## 1. ドキュメント構成マップ

```text
docs/
├── README.md               ★ 本ポータル（全体索引）
├── knowledge/              ★ アーキテクチャ設計・技術知見集（Knowledge Base）
│   ├── README.md           ★ ナレッジ索引
│   ├── feature-code-map.md ★ 機能別コードマップ（UI/API/DB対応表）
│   ├── ui-design-system-and-tiat-guidelines.md ★ v3.00 Tiat志向デザインシステム
│   ├── security-architecture.md ★ セキュリティアーキテクチャ ＆ 防御層設計書
│   └── ...                 ★ 各種最適化・ストレージ・モバイル知見
├── release_notes/          ★ バージョン別リリースノートアーカイブ
│   ├── RELEASE_NOTES_v3.0.1.md
│   ├── RELEASE_NOTES_v3.00.md
│   ├── RELEASE_NOTES_v2.44.md
│   └── ...
├── archive/tasks/          ★ 過去の改修タスク計画・ウォークスルー（全49タスク）
└── images/                 ★ ドキュメント用スクリーンショット
```

---

## 2. コアドキュメント一覧

### ユーザー・開発者向け主要ドキュメント（プロジェクトルート）

| ファイル | 対象 | 主な内容 |
| :--- | :--- | :--- |
| [MANUAL.md](../MANUAL.md) | 全ユーザー | 操作マニュアル完全版（選別・画像調整・スマートテイクアウト・ショートカット一覧・トラブルシューティング） |
| [README.md](../README.md) / [EN](../README_EN.md) | 全体 | プロジェクト概要、高速選別アーキテクチャ、導入手順、動作環境 |
| [README_USB.md](../README_USB.md) | USB利用者 | ポータブルSSD / USBメモリでの持ち歩き自走運用ガイド |
| [RELEASE_NOTES.md](../RELEASE_NOTES.md) | 全体 | 最新リリース内容および過去の更新履歴（Changelog）統合版 |
| [AGENTS.md](../AGENTS.md) | AIエージェント / 開発者 | 開発原則（Karpathy LLM Guidelines）、コーディング規約、文字化け対策、ディレクトリ構造マップ |

---

## 3. 技術知見・設計仕様 (docs/knowledge/)

Photo Manager の設計判断、パフォーマンス最適化パターン、セキュリティ防御層などを蓄積したナレッジ集。
詳細は [docs/knowledge/README.md](knowledge/README.md) を参照。

| ドキュメント | 概要 |
| :--- | :--- |
| [design-philosophy-four-pillars.md](knowledge/design-philosophy-four-pillars.md) | **【4つの設計原則（4本の柱）】** プロダクトの基本思想4原則と、それを実現する全機能体系・対外文章の編集原則 |
| [feature-code-map.md](knowledge/feature-code-map.md) | **【機能別コードマップ】** 14の大分類（グリッド・ライトボックス・タグ・スタック・スキャン・storage・画像調整・セキュリティ等）とコードの対応表 |
| [ui-design-system-and-tiat-guidelines.md](knowledge/ui-design-system-and-tiat-guidelines.md) | **【UI/UXデザインシステム】** 2段階左サイドバー、1段ヘッダー、4:3インスペクタ、脱絵文字、和紙/夜墨テーマ等の規約 |
| [security-architecture.md](knowledge/security-architecture.md) | **【セキュリティアーキテクチャ】** 4層防御（Host検証、Origin検証、LANトークン認証、LAN APIホワイトリスト）、自動停止タイマー |
| [storage-and-xmp-sidecar-architecture.md](knowledge/storage-and-xmp-sidecar-architecture.md) | **【storage・XMP連携】** アプリ内ストレージ管理、XMPサイドカー追従・プレビュー・隔離取込 |
| [mobile-hybrid-architecture.md](knowledge/mobile-hybrid-architecture.md) | **【モバイル連携】** Wi-Fi直結モード（`/m`）および WebAssembly SQLite (`sql.js`) 直接読込 |
| [performance-optimization-patterns.md](knowledge/performance-optimization-patterns.md) | **【最適化パターン】** 範囲比較フォルダ絞込、差分スキャン、高速JSON、BLOBサムネイル |
| [portable-storage-patterns.md](knowledge/portable-storage-patterns.md) | **【ポータブル運用】** 相対パス原則、ドライブレター変動追跡、ボリュームシリアル照合 |
| [sqlite-blob-thumbnails.md](knowledge/sqlite-blob-thumbnails.md) | **【サムネイル設計】** SQLite BLOB格納、WALモード、PRAGMAチューニング |

---

## 4. リリースノート (docs/release_notes/)

GitHub Releases 投稿用に作成されたバージョン別リリースノート。差分アップデート版（`*diff.zip`）とフル版の使い分け、日英対訳の更新内容を収録。

| バージョン | 主な更新内容 | ファイル |
| :--- | :--- | :--- |
| **v3.0.1** | セキュリティ多層防御（DNS Rebinding・LANトークン認証・APIホワイトリスト）、ポータブルパス保護、フォント/Leafletローカル同梱、UI・ドキュメント整備 | [RELEASE_NOTES_v3.0.1.md](release_notes/RELEASE_NOTES_v3.0.1.md) |
| **v3.00** | メジャーUI大改装（2段階左サイドバー・1段ヘッダー・4:3インスペクタ・脱絵文字・下部バー廃止）、起動高速化 | [RELEASE_NOTES_v3.00.md](release_notes/RELEASE_NOTES_v3.00.md) |
| **v2.44** | UIレイアウト交通整理（Step 1）、基本ビューア体験強化（Step 2: 矢印キー移動・Before/After比較・画像コピー・12種ソート） | [RELEASE_NOTES_v2.44.md](release_notes/RELEASE_NOTES_v2.44.md) |
| **v2.43** | タグ並び順「📊 枚数順」トグル＆名前順4ルール、2ペイン設定＆タグツリーエディタでのD&D階層移動 | [RELEASE_NOTES_v2.43.md](release_notes/RELEASE_NOTES_v2.43.md) |
| **v2.42** | アプリ内ストレージ（storage/）完結管理・D&D移動・一括連番リネーム、XMPサイドカープレビュー | [RELEASE_NOTES_v2.42.md](release_notes/RELEASE_NOTES_v2.42.md) |
| **v2.41** | ローカルセキュリティ強化（127.0.0.1既定バインド・CORS/CSRF遮断・インジェクション対策） | [RELEASE_NOTES_v2.41.md](release_notes/RELEASE_NOTES_v2.41.md) |

---

## 5. タスクアーカイブ (docs/archive/tasks/)

過去の機能追加・改修において作成された作業計画（`implementation_plan.md`）、タスク管理（`task.md`）、検証記録（`walkthrough.md`）のアーカイブ。
設計意図や当時の検証経緯を確認する際に参照できる。

<details>
<summary>収録タスク一覧（クリックで展開・全49タスク）</summary>

- `accordion_bottom_docking`
- `accordion_exclusive_and_folder_fix`
- `accordion_sidebar_renewal`
- `ai_auto_tagging`
- `auto_clear_selection`
- `batch_tagging_and_inspector_tags_fix`
- `duplicate_photo_detection_and_inspector_details`
- `duplicate_photo_smart_management`
- `filter_presets`
- `floating_bar_and_menu_contrast_fix`
- `floating_bar_popover_actions`
- `floating_bar_rate_popover_order`
- `folder_auto_refresh_confirm`
- `folder_tree_consolidation`
- `frontend_refactoring`
- `import_photos_feature`
- `inspector_button_right_refine`
- `inspector_tag_layout_and_ai_expander`
- `inspector_tag_tree_foldable`
- `left_sidebar_divider`
- `left_sidebar_tag_delete_fix`
- `location_tree_geocoding`
- `menu_contrast_and_inspector_improvements`
- `multilanguage_support`
- `nondestructive_crop_and_rotate`
- `offline_display_redesign`
- `performance_audit`
- `quick_access_folders`
- `rating_filter_redesign`
- `rating_system_renewal`
- `scan_progress_footer_migration`
- `sidebar_button_left_refine`
- `sidebar_resize_and_cleanup`
- `sidebar_toggle_collapse`
- `slideshow`
- `smart_takeout_export`
- `step3_backlog_completion`
- `storage_folder_management`
- `system_tray_shutdown`
- `tag_ancestor_storage`
- `tag_filter_section_adjustment`
- `thumbnail_refresh_action`
- `thumbnail_sqlite_blob_migration`
- `ui_layout_declutter_step1`
- `upload_auto_cleanup`
- `v300_ui_overhaul_and_step3`
- `viewer_ux_enhancement_step2`
- `volume_label_display`
- `windowless_auto_shutdown`

</details>
