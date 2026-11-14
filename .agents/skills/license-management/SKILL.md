---
name: license-management
description: >-
  新しいPythonパッケージや同梱フロントエンド資産を追加した場合、または依存ライブラリの
  メジャーバージョンを更新した場合にのみ参照する、LICENSES/ と NOTICE.txt の管理手順。
---

# ライセンス管理スキル（パッケージ追加・更新時のみ参照）

> **適用タイミング**: 日常のコード改修時は本スキルを参照する必要はありません。**新しい `pip` パッケージや外部フォント・JSライブラリを同梱追加する際、または既存ライブラリのメジャーバージョンを更新する際のみ**本手順を実行してください。

Tetheract Photo Manager は複数のOSSライブラリを同梱配布しており、配布パッケージにはライセンス文の同梱が必須です。

---

## LICENSES/ フォルダの構成

```text
photo-manager/
└── LICENSES/
    ├── NOTICE.txt            ← 人間向けの一覧サマリ（日本語）
    ├── LICENSE.Python        ← PSF License
    ├── LICENSE.FastAPI       ← MIT
    ├── LICENSE.Uvicorn       ← BSD-3-Clause
    ├── LICENSE.Pillow        ← HPND (MIT-CMU)
    ├── LICENSE.rawpy         ← MIT
    ├── LICENSE.LibRaw        ← LGPL 2.1 / CDDL 1.0
    ├── LICENSE.NumPy         ← BSD-3-Clause
    ├── LICENSE.Pydantic      ← MIT
    ├── LICENSE.Starlette     ← BSD-3-Clause
    ├── LICENSE.Click         ← BSD-3-Clause
    ├── LICENSE.AnyIO         ← MIT
    ├── LICENSE.h11           ← MIT
    ├── LICENSE.pystray       ← LGPL 3.0 / GPL 3.0
    ├── LICENSE.six           ← MIT
    ├── LICENSE.onnxruntime   ← MIT
    ├── LICENSE.sqljs         ← MIT
    ├── LICENSE.Inter         ← SIL OFL 1.1 (同梱フォント)
    ├── LICENSE.Outfit        ← SIL OFL 1.1 (同梱フォント)
    └── LICENSE.Leaflet       ← BSD-2-Clause (同梱地図ライブラリ)
```

---

## 新しいライブラリを追加した場合の手順

1. **ライセンスの種類を確認する**
   ```powershell
   .\python\python.exe -m pip show <package_name>
   ```
   `License` / `License-Expression` フィールドを確認する。

2. **ライセンスファイルを `LICENSES/` に配置する**
   ライセンス原文は `python/Lib/site-packages/<package>-<ver>.dist-info/licenses/` 配下にある。対応する原文を `LICENSES/LICENSE.<PackageName>` としてUTF-8で保存・コピーする。

3. **`LICENSES/NOTICE.txt` を更新する**
   「直接利用しているライブラリ一覧」セクションに以下のフォーマットで追記する：
   ```text
   ■ <ライブラリ名> <バージョン>
     - 著作権: Copyright (c) <著作権者>
     - ライセンス: <ライセンス種別>
     - ファイル: LICENSE.<PackageName>
     - URL: <公式URL>
   ```

4. **GPL / LGPL 系ライセンスの厳格チェック**
   - **GPL / AGPL**: **採用禁止**（リポジトリ全体のソースコードに感染するため）。
   - **LGPL**: 動的リンク（DLL / shared library の差し替えが可能な構成）のみ許可。静的リンクや PyInstaller `--onefile` は禁止。

---

## ライブラリ更新時の確認コマンド

パッチ・マイナー更新でライセンス種別が変わらない場合は更新不要。メジャーバージョンアップ時は以下の UTF-8 安全な同梱 Python ワンライナーで確認する（PowerShell の `findstr` や `Select-String` は使用しない）：

```powershell
.\python\python.exe -X utf8 -c "import importlib.metadata as m; meta = m.metadata('<package>'); print(meta.get('License-Expression') or meta.get('License'))"
```

---

## LibRaw および配布パッケージに関する特記事項

- `rawpy` は内部で LibRaw（LGPL 2.1 / CDDL 1.0 デュアルライセンス）を `raw_r.dll` として動的リンクしている。DLL差し替え可能性を維持するため、将来パッケージャを使う場合も `--onefile` は禁止（`--onedir` のみ可）。
- 配布パッケージ生成時（`build_dist.bat`）は、`dist/`（v2系は `dist_v2/`）に `LICENSES/` フォルダ一式が必ずコピーされる設定を維持すること。
