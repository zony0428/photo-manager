---
name: license-management
description: >-
  Photo Manager プロジェクトの依存ライブラリのライセンス管理・更新手順。
  新しいライブラリを追加した場合や、ライブラリバージョンを更新した場合に、
  LICENSES/ フォルダと NOTICE.txt を最新状態に保つためのワークフロー。
---

# ライセンス管理スキル

Photo Manager は複数のOSSライブラリに依存しており、配布時にはライセンス文の
同梱が必要です。このスキルは、LICENSES/ フォルダの管理手順を定義します。

---

## LICENSES/ フォルダの構成

```
photo-manager/
└── LICENSES/
    ├── NOTICE.txt           ← 人間向けの一覧サマリ（日本語）
    ├── LICENSE.Python        ← PSF License
    ├── LICENSE.FastAPI        ← MIT
    ├── LICENSE.Uvicorn        ← BSD-3-Clause
    ├── LICENSE.Pillow         ← HPND (MIT-CMU)
    ├── LICENSE.rawpy          ← MIT
    ├── LICENSE.LibRaw         ← LGPL 2.1 / CDDL 1.0
    ├── LICENSE.NumPy          ← BSD-3-Clause
    ├── LICENSE.Pydantic       ← MIT
    ├── LICENSE.Starlette      ← BSD-3-Clause
    ├── LICENSE.Click          ← BSD-3-Clause
    ├── LICENSE.AnyIO          ← MIT
    └── LICENSE.h11            ← MIT
```

---

## 新しいライブラリを追加した場合の手順

1. **ライセンスの種類を確認する**
   ```bash
   python -m pip show <package_name>
   ```
   `License-Expression` フィールドを確認する。

2. **ライセンスファイルを LICENSES/ にコピーする**
   ライセンス原文は `python/Lib/site-packages/<package>-<ver>.dist-info/licenses/` にある。
   ```bash
   copy python\Lib\site-packages\<package>-<ver>.dist-info\licenses\LICENSE LICENSES\LICENSE.<PackageName>
   ```

3. **NOTICE.txt を更新する**
   `LICENSES/NOTICE.txt` の「直接利用しているライブラリ一覧」セクションに、
   以下のフォーマットで追記する：
   ```
   ■ <ライブラリ名> <バージョン>
     - 著作権: Copyright (c) <著作権者>
     - ライセンス: <ライセンス種別>
     - ファイル: LICENSE.<PackageName>
     - URL: <公式URL>
   ```

4. **GPL / LGPL 系ライセンスの場合は特に注意**
   - LGPL: 動的リンク (DLL/shared library) であれば問題なし。静的リンク（exe --onefile）は避ける
   - GPL: 採用不可（Photo Manager のソースコードを GPL で公開する義務が生じる）
   - AGPL: 採用不可（ネットワーク経由の利用でも GPL 義務が発生する）

---

## ライブラリ更新時の手順

バージョンが変わってもライセンス種別が変わらない限り、通常は更新不要。
ただしメジャーバージョンアップ時はライセンス変更の可能性があるため確認する。

```bash
# 全パッケージのライセンスを一括確認
python -m pip list --format=columns
python -m pip show <package> | findstr "License"
```

---

## LibRaw に関する特記事項

rawpy は内部で LibRaw (C++ライブラリ) を `raw_r.dll` として動的リンクしている。
LibRaw は **LGPL 2.1 / CDDL 1.0 のデュアルライセンス** であり、以下を守る必要がある：

- ✅ DLL として動的リンクしている（現在の構成で OK）
- ✅ LibRaw のソースコードを改変していない
- ✅ ライセンス全文を同梱している（LICENSE.LibRaw）
- ✅ ユーザーが `pip install rawpy` で差し替え可能（LGPL の「差し替え可能性」要件を満たす）
- ❌ PyInstaller `--onefile` での配布は避ける（DLL が埋め込まれ差し替え不可になる）

---

## exe化（PyInstaller等）する場合の注意

- `--onedir` モードを使う（`--onefile` は LibRaw の LGPL 要件に抵触する可能性がある）
- 生成された dist/ フォルダに LICENSES/ フォルダをそのままコピーする
- vcomp140.dll (Visual C++ ランタイム) は rawpy パッケージの一部として再頒布可能
