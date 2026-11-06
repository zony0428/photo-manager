# Tetheract Photo Manager - ドキュメントポータル (Documentation Portal)

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
| [ui-design-system-and-tiat-guidelines.md](knowledge/ui-design-system-and-tiat-guidelines.md) | **【UI/UXデザインシステム】** 2段階左サイドバー、1段ヘッダー、4:3インスペクタ、脱絵文字、4カラーテーマ、カスタム確認モーダル（`#commonConfirmModal`）統一等の規約 |
| [security-architecture.md](knowledge/security-architecture.md) | **【セキュリティ ＆ 3段階エシカル保護設計】** 4層ネットワーク防御、3段階エシカル保護（Lv.0 他人のLoome完全拒否＆DB単体引き抜き検知・3大救済手段／Lv.1 起動ロック＆サムネイル暗号化／Lv.2 Loome先頭64KBカプセル化 `TETHVLT1`）、鍵自動サルベージ＆セルフブリック防止設計 |
| [storage-and-xmp-sidecar-architecture.md](knowledge/storage-and-xmp-sidecar-architecture.md) | **【storage・XMP連携】** アプリ内ストレージ管理、XMPサイドカー追従・プレビュー・隔離取込 |
| [mobile-hybrid-architecture.md](knowledge/mobile-hybrid-architecture.md) | **【モバイル連携】** Wi-Fi直結モード（`/m`）および WebAssembly SQLite (`sql.js`) 直接読込 |
| [performance-optimization-patterns.md](knowledge/performance-optimization-patterns.md) | **【最適化パターン】** 範囲比較フォルダ絞込、差分スキャン、高速JSON、BLOBサムネイル |
| [portable-storage-patterns.md](knowledge/portable-storage-patterns.md) | **【ポータブル運用・所在リンク】** 相対パス原則、ドライブレター変動追跡、VSN照合、ユニーク画像 (`photos`) と複数メディア所在リンク (`photo_links`) の分離 |
| [sqlite-blob-thumbnails.md](knowledge/sqlite-blob-thumbnails.md) | **【サムネイル・タグDB設計】** SQLite BLOB格納、`photo_id INTEGER PRIMARY KEY` ROWID直結、`photo_tags` の `WITHOUT ROWID` クラスタ化、安全マイグレーション |

---

## 4. リリースノート (docs/release_notes/)

GitHub Releases 投稿用に作成されたバージョン別リリースノート。差分アップデート版（`*diff.zip`）とフル版の使い分け、日英対訳の更新内容を収録。

> 旧系列（旧称 Photo Manager: v2.x〜v3.2.1）と新系列（Tetheract Photo Manager: v1.0.0〜）が同居している。下表に無い版（v3.0.2〜v3.2.1 等）は `release_notes/` を直接参照。

| バージョン | 主な更新内容 | ファイル |
| :--- | :--- | :--- |
| **v1.7.2** | フロントエンドJS・バックエンドAPI・CSSのモジュール分割（モノリス解消）、双方向監査によるデッドコード＆未使用CSS（2,562行）の撤去、2階建てテーマ属性（`paper`/`sumi`）修正、423ロック中の不要通信抑止＆エラーハンドリング整備 | [RELEASE_NOTES_v1.7.2.md](release_notes/RELEASE_NOTES_v1.7.2.md) |
| **v1.7.1** | Lv.0 エシカルモードの誤ロック修正・DB非破壊オンメモリロック・自己修復、大容量DB起動高速化 ＆ Win32 `CopyFileExW` DBバックアップ高速化、1週間バックアップ未実施リマインドモーダル | [RELEASE_NOTES_v1.7.1.md](release_notes/RELEASE_NOTES_v1.7.1.md) |
| **v1.7.0** | 3段階セキュリティ＆エシカル保護（Lv.0 他人のLoome完全拒否＆DB単体引き抜き検知・3大救済手段、Lv.1 起動パスワードロック＆DBサムネイルAEAD暗号化、Lv.2 Loome先頭64KBカプセル化保護 `TETHVLT1` ＆1ビット完全復元）、`Loome/.loome_seal` からの鍵自動サルベージ・セルフブリック防止 | [RELEASE_NOTES_v1.7.0.md](release_notes/RELEASE_NOTES_v1.7.0.md) |
| **v1.6.1** | リンク消失写真の選択削除＆絞り込み削除・矛盾操作防止と混在選択スキップ通知、Exif欠落画像のサンプリングハッシュ同一認識＆重複自動統合、フッター三大フィルタの意図しない解除防止 | [RELEASE_NOTES_v1.6.1.md](release_notes/RELEASE_NOTES_v1.6.1.md) |
| **v1.6.0** | `Loome` への超高速並列ファイルコピー（Win32 `CopyFileExW` ＋ドライブ種別自動並列化＋EXIF再解析スキップ）、NeXTSTEP風右展開カスケードメニュー、空フォルダ化時のリンク整理＆空サブフォルダ誤検知修正 | [RELEASE_NOTES_v1.6.0.md](release_notes/RELEASE_NOTES_v1.6.0.md) |
| **v1.5.0** | イベント駆動メディア抜き挿し自動検知（`WM_DEVICECHANGE`＋SSE）、外部アプリ編集の自動同期、全画面リアクティブ同期 | [RELEASE_NOTES_v1.5.0.md](release_notes/RELEASE_NOTES_v1.5.0.md) |
| **v1.4.1** | 日英翻訳（JP/EN）の網羅性向上、アプリ内ヘルプ＆ドキュメント同期 | [RELEASE_NOTES_v1.4.1.md](release_notes/RELEASE_NOTES_v1.4.1.md) |
| **v1.4.0** | 専用保管庫「Loome」・外部ドライブ Loome 増設、下部フッターツールバー刷新、評価・フィルタ切替の超高速化 | [RELEASE_NOTES_v1.4.0.md](release_notes/RELEASE_NOTES_v1.4.0.md) |
| **v1.2.2** | フォルダ更新（差分検出）・消失写真リンク解除 ＆ アプリ全体の確認ダイアログをカスタムモーダル（`#commonConfirmModal`）に統一、大規模DBマイグレーション時の起動待機時間延長（最大180秒） | [RELEASE_NOTES_v1.2.2.md](release_notes/RELEASE_NOTES_v1.2.2.md) |
| **v1.2.1** | DBマイグレーション時の `ON DELETE CASCADE` 遮断と事前バックアップからの自動自己修復復元、4KBパディング連写・ブラケット識別精度向上、フルブリード新アプリアイコン | [RELEASE_NOTES_v1.2.1.md](release_notes/RELEASE_NOTES_v1.2.1.md) |
| **v1.2.0** | ユニーク画像エンティティ（`photos`）と実ファイル所在リンク（`photo_links`）の分離、`thumbnails` ROWID直結化、`photo_tags` `WITHOUT ROWID` クラスタ化 | [RELEASE_NOTES_v1.2.0.md](release_notes/RELEASE_NOTES_v1.2.0.md) |
| **v1.1.1** | サブフォルダ差分検出、親フォルダ管理統合、複数SDカードVSN安定化、ランチャーアイコンキャッシュ更新 | [RELEASE_NOTES_v1.1.1.md](release_notes/RELEASE_NOTES_v1.1.1.md) |
| **v1.1.0** | 複数SDカードのVSN個体識別・メタデータ引き継ぎ、撮影カレンダー、AIカラータグ単独再判定 | [RELEASE_NOTES_v1.1.0.md](release_notes/RELEASE_NOTES_v1.1.0.md) |
| **v1.0.0** | 「Tetheract Photo Manager」へ改称しバージョンを v1.0.0 から再出発、tag_key スキーマ、Tetheract D/L テーマ | [RELEASE_NOTES_v1.0.0.md](release_notes/RELEASE_NOTES_v1.0.0.md) |
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
- `three_tier_ethical_security_v170`
- `thumbnail_refresh_action`
- `thumbnail_sqlite_blob_migration`
- `ui_layout_declutter_step1`
- `upload_auto_cleanup`
- `v300_ui_overhaul_and_step3`
- `viewer_ux_enhancement_step2`
- `volume_label_display`
- `windowless_auto_shutdown`

</details>
