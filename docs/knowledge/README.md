# Photo Manager - 技術ナレッジ集 (Knowledge Base)

本ディレクトリは、Photo Manager の開発において得られた設計判断、パフォーマンス改善、障害対策、トラブルシューティングのノウハウを蓄積したアーカイブである。
別の開発PCや異なるAIエージェント環境でも、過去の知見をそのまま参照・活用できるように自己完結型で管理されている。

---

## 収録ナレッジ一覧

| ドキュメント | 概要 |
|---|---|
| [feature-code-map.md](feature-code-map.md) | **【機能別コードマップ】** ユーザー機能（グリッド・ライトボックス・タグ・スタック・スキャン・storage・XMP等）と対応するフロントエンドJS・API・DBモジュールの完全対応表 |
| [portable-storage-patterns.md](portable-storage-patterns.md) | USBポータブル運用、ドライブレター変動（D:→E:）への動的追跡、ボリュームシリアル番号（VSN）照合の仕組み |
| [sqlite-blob-thumbnails.md](sqlite-blob-thumbnails.md) | サムネイル管理の変遷（ファイル方式からSQLite BLOB方式への移行理由、PRAGMA高速化、マイグレーション実績） |
| [powershell-no-mojibake.md](powershell-no-mojibake.md) | Windows PowerShell 環境における文字化け・BOM破損の事故パターンと完全防止ガイド |
| [performance-optimization-patterns.md](performance-optimization-patterns.md) | v1.36 パフォーマンス監査で確立したパターン（範囲比較フォルダ絞込・差分スキャン・高速JSON・サムネ並列生成・差分DOM更新）、回帰検証手法、Agent 委譲の教訓 |
| [tag-trees-and-batch-actions.md](tag-trees-and-batch-actions.md) | **【タグツリー並び順制御・2ペイン「タグツリーエディタ」＆一括操作設計 (v2.11〜v2.43)】** `📊 枚数順` トグル・名前順4ルール（辞書順/自然順）、D&D階層移動・祖先タグ安全同期 (`rename_tag`)、3ペイン責務分離の設計仕様 |
| [architecture-scalability-and-side-effects.md](architecture-scalability-and-side-effects.md) | **【大規模化・高速化の相互影響検証 & 安全設計計画 (v2.20+)】** グリッド描画・DBインデックス・I/O・キャッシュ・テスト導入時に他部位を壊さないための「7つの禁止アンチパターン」と Phase 1〜4 実装仕様 |
| [mobile-hybrid-architecture.md](mobile-hybrid-architecture.md) | **【Android / スマホ専用UI & ハイブリッドDB連携 (v2.30)】** Wi-Fi直結モード（`/m`）と WebAssembly SQLite (`sql.js`) によるUSB内 `library.db` 直接読込（ファイルロックエラー完全回避・BLOBサムネイル展開・3段階フォールバック差分同期）の設計と実装仕様 |
| [storage-and-xmp-sidecar-architecture.md](storage-and-xmp-sidecar-architecture.md) | **【アプリ内ストレージ (`storage/`) 完結管理 ＆ XMPサイドカー非破壊連携 (v2.42+)】** `storage/` サブフォルダ管理・D&D移動・単一/一括連番リネーム、付随サイドカー/ペアRAW自動追従、`[👁️ XMPプレビュー]` ホールド比較・`XMP/...` 隔離取込の設計仕様 |
| [ui-design-system-and-tiat-guidelines.md](ui-design-system-and-tiat-guidelines.md) | **【UI/UX デザインシステム ＆ Tiat志向設計仕様 (v3.00+)】** 2段階左サイドバー（54pxタブレール＋全高メニュー）、1段統合ヘッダー（44px）、4:3インスペクタ、右クリック/右ペイン一括操作（下部バー完全廃止）、脱カラー絵文字（単色細線SVG）、和紙/夜墨テーマ仕様 |
| [security-architecture.md](security-architecture.md) | **【セキュリティアーキテクチャ ＆ 防御層設計書 (v3.0.1+)】** 4層防御（Hostヘッダ検証によるDNS Rebinding対策、Origin検証によるCSRF遮断、LANトークン認証＆Cookie化、LAN APIホワイトリスト）、30分無通信自動停止、回帰テスト仕様 |
| [ui-ux-diagnosis-and-roadmap.md](ui-ux-diagnosis-and-roadmap.md) | **【UI/UX 総合診断・機能配置整理 ＆ ステップ1〜3完全実装記録 (v2.44〜v3.00過渡記録)】** v2.44時点のUI交通整理（ステップ1）・ビューア強化（ステップ2）およびv3.00で完結したステップ3の歴史的設計記録（現行仕様は `ui-design-system-and-tiat-guidelines.md` 参照） |

---

## ナレッジの追加ルール

今後新たな大規模機能の追加、重篤なバグの解決、パフォーマンスチューニングを行った場合は、本ディレクトリに Markdown ファイルとして知見を記録し、本 `README.md` の一覧に追加すること。
