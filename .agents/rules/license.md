# ライセンス管理ルール

## 依存ライブラリ追加時の義務

- 新しい pip パッケージを追加する場合、**必ずライセンス種別を確認**すること。
- GPL / AGPL ライセンスのパッケージは **採用禁止**（Photo Manager のコード全体に感染するため）。
- LGPL は条件付きで許可（動的リンクのみ。PyInstaller `--onefile` 不可）。
- ライセンスファイルを `LICENSES/` フォルダにコピーし、`NOTICE.txt` を更新すること。
- 詳細手順は `license-management` スキルを参照。

## exe化・配布時の注意

- 本プロジェクトは同梱の Embeddable Python および C# 製専用ランチャー（`PhotoManager.exe`）によって自走しており、通常 PyInstaller は使用しない。
- 将来的に PyInstaller 等で Python パッケージを exe 化・単体実行可能にする場合でも、**`--onedir` のみ** 許可する（`--onefile` は LibRaw 等の LGPL 要件である「動的リンクライブラリ差し替え可能性」に抵触するため禁止）。
- 配布物（`dist/`）には必ず `LICENSES/` フォルダを含めること。
