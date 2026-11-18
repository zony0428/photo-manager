# Tetheract Photo Manager - ドキュメントポータル (Documentation Portal)

本ディレクトリは、Tetheract Photo Manager のコア設計文書、リリースノート、監査・改修計画、および過去の開発アーカイブを集約したドキュメントポータルである。

---

## 1. ドキュメント構成マップ

```text
docs/
├── README.md                          ★ 本ポータル（全体索引）
├── knowledge/                         ★ 現行アーキテクチャ設計・コア技術知見集（コア6本）
│   ├── README.md                      ★ ナレッジ索引
│   ├── design-philosophy-four-pillars.md
│   ├── portable-storage-patterns.md
│   ├── security-architecture.md
│   ├── ui-design-system-and-tiat-guidelines.md
│   ├── architecture-scalability-and-side-effects.md
│   └── android-app-and-touch-architecture.md
├── release_notes/                     ★ バージョン別リリースノート（v1.0.0〜v2.x 新系列 ＆ v0.x 旧系列）
├── <topic>/                           ★ 進行中・直近の大型タスク計画・監査記録（task / implementation_plan / walkthrough）
├── archive/                           ★ 過去の設計記録・旧ルール・タスク履歴アーカイブ
│   ├── knowledge/                     ★ 過渡期ナレッジ・旧コードマップ等の履歴保管
│   ├── rules_legacy/                  ★ AGENTS.md 統合前の旧 .agents/rules/ 保管
│   ├── agents_legacy/                 ★ 旧専門サブエージェント定義の保管
│   └── tasks/                         ★ 過去の改修タスク計画・ウォークスルー（全52タスク）
└── images/                            ★ ドキュメント用スクリーンショット・図版
```

---

## 2. ルート直下の主要ドキュメント

| ファイル | 対象 | 主な内容 |
| :--- | :--- | :--- |
| [MANUAL.md](../MANUAL.md) | 全ユーザー | 操作マニュアル完全版（選別・画像調整・Loome管理・スマートテイクアウト・ショートカット一覧） |
| [README.md](../README.md) / [README_EN.md](../README_EN.md) | 全体 | プロジェクト概要、4つの設計原則、導入手順、動作環境（日本語 / 英語） |
| [README_USB.md](../README_USB.md) | USB利用者 | ポータブルSSD / USBメモリでの持ち歩き自走運用ガイド |
| [RELEASE_NOTES.md](../RELEASE_NOTES.md) | 全体 | 最新リリース内容および過去の更新履歴（Changelog）統合版 |
| [AGENTS.md](../AGENTS.md) | AIエージェント / 開発者 | コア開発原則、ポータブル＆非破壊境界、セキュリティ・SQLite・UTF-8鉄則、開発ワークフロー |

---

## 3. コア技術知見・設計仕様 (`docs/knowledge/`)

現行アーキテクチャの不変条件と設計仕様を6本のコアドキュメントに集約している（索引は [docs/knowledge/README.md](knowledge/README.md)、過渡期の旧仕様書・履歴資料は `docs/archive/knowledge/` を参照）。

| ドキュメント | 概要 |
| :--- | :--- |
| [design-philosophy-four-pillars.md](knowledge/design-philosophy-four-pillars.md) | **【4つの設計原則（4本の柱）】** プロダクトの根幹思想4原則と、それを実現する機能体系・対外文章の編集原則 |
| [portable-storage-patterns.md](knowledge/portable-storage-patterns.md) | **【ポータブル運用・所在リンク・Loome・XMP連携】** 相対パス原則、VSN照合、`photos` / `photo_links` 分離、専用保管庫 `Loome` 管理、`server/sidecar.py` によるXMP非破壊連携 |
| [security-architecture.md](knowledge/security-architecture.md) | **【セキュリティ ＆ 3段階エシカル保護】** 4層ネットワーク防御、Lv.0/1/2 エシカル保護（他環境 `Loome` 拒否・起動ロック・`TETHVLT1` 先頭64KBカプセル化）、`.loome_seal` 鍵自動サルベージ |
| [ui-design-system-and-tiat-guidelines.md](knowledge/ui-design-system-and-tiat-guidelines.md) | **【UI/UXデザインシステム】** 1段メインツールバー、2段階左サイドバー、4:3インスペクタ、単色SVG徹底、2階建て4カラーテーマ、`#commonConfirmModal`、カスケード＆タグツリー仕様 |
| [architecture-scalability-and-side-effects.md](knowledge/architecture-scalability-and-side-effects.md) | **【スケーラビリティ ＆ 禁止アンチパターン】** SQLite・スキャン・UI描画で他部位を壊さないための禁止アンチパターンと、本番DBを汚さないテスト接続切替原則 |
| [android-app-and-touch-architecture.md](knowledge/android-app-and-touch-architecture.md) | **【Android (`TETHERACT ld`) ＆ タッチUI設計】** スマホ内ロッカーDB、Wi-Fi差分同期、Read-Only USB `Loome` オンメモリ復号、手許 `PhoneCase` / Uplink、`lan_bridge`、GPSフィールドログ、JS/Kotlin構成 |

---

## 4. リリースノート (`docs/release_notes/`)

GitHub Releases 投稿用に作成されたバージョン別リリースノート（全ファイル一覧は `docs/release_notes/` を直接参照）。
旧称 Photo Manager 時代のリリースノート（旧 v2.41〜v3.2.1）は、新系列（v1.0.0〜）と区別するため `RELEASE_NOTES_v0.2.41.md` 〜 `RELEASE_NOTES_v0.3.21.md` として保管されている。

| バージョン | 主な更新内容 | ファイル |
| :--- | :--- | :--- |
| **v2.4.0** | モバイル版『Art Framer』搭載（1タップ選択起動・Step2/3拡大・OS共有）、オンデバイス `YuNet`/`LPD-YuNet` ONNX推論＆4辺スナップ、PhoneCase役割モード＆スマートRAW照合・待機シグナル・`thmod_` フォルダ横断スタック | [RELEASE_NOTES_v2.4.0.md](release_notes/RELEASE_NOTES_v2.4.0.md) |
| **v2.3.0** | 作品書き出しウィザード『Art Framer』搭載（外寸逆算プリセット、ローカルAIナンバープレート・顔検出＆フチのモヤ、4種プリント枠・EXIFキャプション・透かし合成、`thmod_` 自動スタック＆AIタグ除外） | [RELEASE_NOTES_v2.3.0.md](release_notes/RELEASE_NOTES_v2.3.0.md) |
| **v2.2.2** | フォルダ差分ピンポイント更新＆未登録フォルダ巻き込み防止（v1.8.11共通）、スマホ下部3構成メニュー（86px中央丸型GPSダイヤル・上下スワイプ切替・ワンタップ『母艦に収納』・未LINK時グレーアウト） | [RELEASE_NOTES_v2.2.2.md](release_notes/RELEASE_NOTES_v2.2.2.md) |
| **v2.2.1** | モーションアジャスタ（Slap & Sweep）搭載、タグ/スタック/インスペクタ即時同期＆キャッシュ無効化漏れ修正 | [RELEASE_NOTES_v2.2.1.md](release_notes/RELEASE_NOTES_v2.2.1.md) |
| **v2.2.0** | 手許PhoneCase一括転送＆GPS補完、PC 2D仮想スクロール＆SQL高速化、Android並列DB＆一括保存、LANペアリング防御強化 | [RELEASE_NOTES_v2.2.0.md](release_notes/RELEASE_NOTES_v2.2.0.md) |
| **v2.1.7** | RAWスタッキング修正、形式フィルタ整理＆RAW抱き合わせ出力、共通タグ一括削除、Loomeフォルダ単位取り込み＆ピッカー小窓 | [RELEASE_NOTES_v2.1.7.md](release_notes/RELEASE_NOTES_v2.1.7.md) |
| **v2.1.6** | SONY α RAW（`.ARW` ロスレス圧縮M/S等）のプレビューJPEG・サムネイル・EXIF抽出修正とリフレッシュ再取得対応 | [RELEASE_NOTES_v2.1.6.md](release_notes/RELEASE_NOTES_v2.1.6.md) |
| **v2.1.3** | モバイル非破壊調整API・EVスケール統一＆二重掛け防止、Android USB RAWプレビュー抽出、Duel比較＆スタック連携修正 | [RELEASE_NOTES_v2.1.3.md](release_notes/RELEASE_NOTES_v2.1.3.md) |
| **v2.0.2** | 左ペインのカード枠精緻化＆NeXTSTEP風 300ms ホバー右展開カスケード、ライトボックスフェードイン・マウス戻るボタン対応 | [RELEASE_NOTES_v2.0.2.md](release_notes/RELEASE_NOTES_v2.0.2.md) |
| **v1.8.1** | アクティビティレール再編＆アイコン刷新、1行コンパクトBinderプリセット、インスペクタ整理、ローカルクリーンアップデータ | [RELEASE_NOTES_v1.8.1.md](release_notes/RELEASE_NOTES_v1.8.1.md) |
| **v1.8.0** | `diff.zip` 自動適用のローカルクリーンアップデータ、ルートディレクトリ整理（`tools/` ＆ `Loome/`） | [RELEASE_NOTES_v1.8.0.md](release_notes/RELEASE_NOTES_v1.8.0.md) |
| **v1.7.2** | フロントエンドJS・バックエンドAPI・CSSのモジュール分割、デッドコード＆未使用CSS撤去、2階建てテーマ属性修正 | [RELEASE_NOTES_v1.7.2.md](release_notes/RELEASE_NOTES_v1.7.2.md) |
| **v1.7.1** | Lv.0 エシカルモード誤ロック修正・非破壊オンメモリロック、大容量DB起動高速化、Win32 `CopyFileExW` DBバックアップ高速化 | [RELEASE_NOTES_v1.7.1.md](release_notes/RELEASE_NOTES_v1.7.1.md) |
| **v1.7.0** | 3段階セキュリティ＆エシカル保護（Lv.0/1/2）、`TETHVLT1` 先頭64KBカプセル化、`Loome/.loome_seal` からの鍵自動サルベージ | [RELEASE_NOTES_v1.7.0.md](release_notes/RELEASE_NOTES_v1.7.0.md) |
| **v1.6.1** | リンク消失写真の選択削除＆絞り込み削除、Exif欠落画像のサンプリングハッシュ同一認識＆重複自動統合 | [RELEASE_NOTES_v1.6.1.md](release_notes/RELEASE_NOTES_v1.6.1.md) |
| **v1.6.0** | `Loome` への並列ファイルコピー（`CopyFileExW`）、右展開カスケードメニュー、空フォルダ化時のリンク整理 | [RELEASE_NOTES_v1.6.0.md](release_notes/RELEASE_NOTES_v1.6.0.md) |
| **v1.5.0** | イベント駆動メディア抜き挿し自動検知（`WM_DEVICECHANGE`＋SSE）、外部アプリ編集の自動同期 | [RELEASE_NOTES_v1.5.0.md](release_notes/RELEASE_NOTES_v1.5.0.md) |
| **v1.4.1** | 日英翻訳（JP/EN）の網羅性向上、アプリ内ヘルプ＆ドキュメント同期 | [RELEASE_NOTES_v1.4.1.md](release_notes/RELEASE_NOTES_v1.4.1.md) |
| **v1.4.0** | 専用保管庫「Loome」・外部ドライブ Loome 増設、下部フッターツールバー刷新、評価・フィルタ切替高速化 | [RELEASE_NOTES_v1.4.0.md](release_notes/RELEASE_NOTES_v1.4.0.md) |
| **v1.2.2** | フォルダ更新（差分検出）・消失写真リンク解除、カスタム確認モーダル（`#commonConfirmModal`）統一 | [RELEASE_NOTES_v1.2.2.md](release_notes/RELEASE_NOTES_v1.2.2.md) |
| **v1.2.1** | DBマイグレーション時の `ON DELETE CASCADE` 遮断と自動自己修復、4KBパディング連写識別精度向上 | [RELEASE_NOTES_v1.2.1.md](release_notes/RELEASE_NOTES_v1.2.1.md) |
| **v1.2.0** | ユニーク画像（`photos`）と所在リンク（`photo_links`）の分離、`thumbnails` ROWID直結化、`photo_tags` `WITHOUT ROWID` 化 | [RELEASE_NOTES_v1.2.0.md](release_notes/RELEASE_NOTES_v1.2.0.md) |
| **v1.1.1** | サブフォルダ差分検出、親フォルダ管理統合、複数SDカードVSN安定化 | [RELEASE_NOTES_v1.1.1.md](release_notes/RELEASE_NOTES_v1.1.1.md) |
| **v1.1.0** | 複数SDカードのVSN個体識別・メタデータ引き継ぎ、撮影カレンダー、AIカラータグ単独再判定 | [RELEASE_NOTES_v1.1.0.md](release_notes/RELEASE_NOTES_v1.1.0.md) |
| **v1.0.0** | 「Tetheract Photo Manager」へ改称し新系列 v1.0.0 から再出発、`tag_key` スキーマ、Tetheract D/L テーマ | [RELEASE_NOTES_v1.0.0.md](release_notes/RELEASE_NOTES_v1.0.0.md) |
| **旧 v3.2.1** | 旧称 Photo Manager 最終版（改称前） | [RELEASE_NOTES_v0.3.21.md](release_notes/RELEASE_NOTES_v0.3.21.md) |
| **旧 v3.0.1** | セキュリティ多層防御（DNS Rebinding・LANトークン認証・APIホワイトリスト）、ローカルアセット同梱 | [RELEASE_NOTES_v0.3.1.md](release_notes/RELEASE_NOTES_v0.3.1.md) |
| **旧 v3.00** | メジャーUI改装（2段階左サイドバー・1段ツールバー・4:3インスペクタ・脱絵文字・下部選択バー廃止） | [RELEASE_NOTES_v0.3.0.md](release_notes/RELEASE_NOTES_v0.3.0.md) |
| **旧 v2.44** | UIレイアウト交通整理、矢印キー移動・Before/After比較・画像コピー | [RELEASE_NOTES_v0.2.44.md](release_notes/RELEASE_NOTES_v0.2.44.md) |
| **旧 v2.43** | タグ並び順「枚数順」トグル＆名前順4ルール、2ペイン設定＆タグツリーエディタD&D階層移動 | [RELEASE_NOTES_v0.2.43.md](release_notes/RELEASE_NOTES_v0.2.43.md) |
| **旧 v2.42** | アプリ内ストレージ完結管理・D&D移動・一括連番リネーム、XMPサイドカープレビュー | [RELEASE_NOTES_v0.2.42.md](release_notes/RELEASE_NOTES_v0.2.42.md) |
| **旧 v2.41** | ローカルセキュリティ強化（127.0.0.1既定バインド・Origin遮断・インジェクション対策） | [RELEASE_NOTES_v0.2.41.md](release_notes/RELEASE_NOTES_v0.2.41.md) |

---

## 5. アーカイブ (`docs/archive/`)

過去の機能追加・移行期における設計記録および統合前の旧ルール群は、現行開発のコンテキストを肥大化させないよう `docs/archive/` 配下に分類保管されている。

- **`docs/archive/knowledge/`**: 過渡期の旧アーキテクチャ解説、旧コードマップ、将来構想メモ等のアーカイブ
- **`docs/archive/rules_legacy/`**: `AGENTS.md` スリム化統合前の旧 `.agents/rules/` ファイル群
- **`docs/archive/agents_legacy/`**: UI改装・README刷新時に使用した旧専門サブエージェント定義
- **`docs/archive/tasks/`**: 過去の改修タスク計画（`implementation_plan.md` / `task.md` / `walkthrough.md`、全52タスク）
