# Tetheract Photo Manager - 技術ナレッジ集 (Knowledge Base)

本ディレクトリには、Tetheract Photo Manager の現行アーキテクチャ・設計不変条件・UI/セキュリティ規約を凝縮した **コア設計書6本** を収録している。
過去の移行記録や旧バージョン時点の検討資料は [`docs/archive/knowledge/`](../archive/knowledge/) にアーカイブ保管している。

---

## コア設計書一覧（全6本）

| ドキュメント | 対象領域・要点 |
| :--- | :--- |
| [design-philosophy-four-pillars.md](design-philosophy-four-pillars.md) | **4つの設計原則（4本の柱）と対外文体規約**<br>保存先に縛られない分類・検索／元データを汚さず見るだけで終わらない／作業を邪魔しないLook&Feel／クラウドに頼らずポータブル、および `README.md`・`note` の編集原則 |
| [portable-storage-patterns.md](portable-storage-patterns.md) | **ポータブルパス解決・所在リンク・保管庫 `Loome`・XMP連携**<br>VSN個体識別、`resolve_portable_path`、`photos` / `photo_links` と `content_key`、SQLite BLOBサムネイル、`Loome` ファイル管理、`server/sidecar.py` によるサイドカー追従とXMP非破壊連携（評価 `2/1/0/-1`・`XMP/` 隔離） |
| [security-architecture.md](security-architecture.md) | **ネットワーク防御 ＆ 3段階エシカル保護（Lv.0 / Lv.1 / Lv.2）**<br>Host/Origin検証、LANトークン＆APIホワイトリスト、`lan_bridge.py`、他人の `Loome` 保護、2段階鍵階層（DEK/KEK）、`TETHVLT1` カプセル化、`Loome/.loome_seal` 自動鍵サルベージ |
| [ui-design-system-and-tiat-guidelines.md](ui-design-system-and-tiat-guidelines.md) | **UIデザインシステム・2階建てテーマ・タグツリー3ペイン設計**<br>単色細線SVG（カラー絵文字禁止）、`data-scheme`（4種）× `data-theme`（2種）、1段メインツールバー、`#viewHeaderChipBar`、`showConfirmModal`、タグ並び順4ルールと `rename_tag` 祖先安全同期 |
| [architecture-scalability-and-side-effects.md](architecture-scalability-and-side-effects.md) | **大規模化・パフォーマンス設計原則 ＆ 禁止アンチパターン**<br>SQLite（変数上限・`idx_thumbnails_dims`・`photo_links` インデックス・安全な親テーブル再構築）、キャッシュ世代・スレッドプール原則、部分DOM更新、および `unittest` 本番DB完全隔離プロトコル |
| [android-app-and-touch-architecture.md](android-app-and-touch-architecture.md) | **Androidアプリ（`TETHERACT ld`）・Touch UI・PhoneCase・FieldLog**<br>実動 `mobile.js` と未配線モジュールの境界、Kotlin ネイティブシェル、Wi-Fiロッカー双方向同期、手許写真 PhoneCase / Uplink、Read-Only USB `Loome` 復号、GPSフィールドログ採取・照合、APKビルド同期仕様 |
