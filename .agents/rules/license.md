# ライセンス管理ルール

## 依存ライブラリ追加時の義務

- 新しい pip パッケージを追加する場合、**必ずライセンス種別を確認**すること。
- GPL / AGPL ライセンスのパッケージは **採用禁止**（Photo Manager のコード全体に感染するため）。
- LGPL は条件付きで許可（動的リンクのみ。PyInstaller `--onefile` 不可）。
- ライセンスファイルを `LICENSES/` フォルダにコピーし、`NOTICE.txt` を更新すること。
- 詳細手順は `license-management` スキルを参照。

## exe化・配布時の注意

- PyInstaller を使う場合は **`--onedir` のみ** 許可（`--onefile` は LibRaw の LGPL 要件に抵触する可能性あり）。
- 配布物には必ず `LICENSES/` フォルダを含めること。
