---
trigger: always_on
description: v1.8系（PC単体安定版: mainブランチ）と v2.0系（Android専用アプリ・Wi-Fiロッカー連携版: v2ブランチ）のソースコードおよび配布フォルダ（dist / dist_v2）の完全分離・並行運用ルール
---

# v1.8系（PC安定版）と v2.0系（Android連携版）の分離・並行運用規約

本リポジトリでは、**v1.8系（PC単体・安定版）** と **v2.0系（Android専用アプリ・Wi-Fi双方向ロッカー同期・3層タッチUI統合版）** を Git ブランチおよびビルド出力先フォルダの双方で完全に分離して管理する。すべてのAIエージェントは以下のルールを厳守すること。

---

## 1. Git ブランチの役割分担（ソースコードの分離）

| 系列 | ブランチ名 | リモート追跡先 | `VERSION` 表記 | 含めるコードの範囲 |
| :--- | :--- | :--- | :--- | :--- |
| **v1.8系（PC単体・安定版）** | `main` | `origin/main` / `public/main` | `1.8.x` | PC版（Windows）の本体機能・高速化・バグ修正のみ。**Androidネイティブ連携コード（`android/`, `server/mobile_delta.py`, UDP自動発見 `51888`, ペアリング承認ポーリング等）は一切含めてはならない。** |
| **v2.0系（Android連携・タッチUI版）** | `v2` | `origin/v2` | `2.0.x` | v1.8系の全機能に加え、Androidネイティブアプリ（`android/`）、3層タッチUI（`frontend/js/views/touch/` 等）、Wi-Fiロッカー双方向同期・UDP自動発見・実ファイルLAN配信を含む実験・次期メジャー開発ライン。 |

### 作業時の鉄則
1. **作業開始前のブランチ確認**:
   - ユーザーから「v1.8系の修正」「通常のPC版の修正」を指示された場合は、必ず `git branch --show-current` が **`main`** であることを確認してから作業する。
   - ユーザーから「Android版の修正」「v2系の修正」「スマホ・タブレット連携の修正」を指示された場合は、必ず **`v2`** ブランチへ切り替えて（`git checkout v2`）から作業する。
2. **v1.8系の改善を v2系へ取り込む場合**:
   - `main` ブランチでコミットしたPC本体の改善を `v2` ブランチにも反映したい場合は、`git checkout v2` → `git cherry-pick <commit-hash>` で取り込む（`v2` を `main` へマージしてはならない）。

---

## 2. ビルド出力先フォルダの完全分離（`dist` vs `dist_v2`）

1つのワークスペース内で `main`（v1.8系）と `v2`（v2.0系）を切り替えても、ビルド済みパッケージが互いに上書きされないよう、出力先フォルダを以下の通り分離している：

| 系列 | フルパッケージ出力先 | 軽量差分アップデート出力先 | Android APK 出力先 | 生成されるZIPファイル名 |
| :--- | :--- | :--- | :--- | :--- |
| **v1.8系 (`VERSION` = `1.x`)** | `dist/` | `dist_update/` | （生成しない） | `Tetheract_v1.8.x.zip` / `Tetheract_v1.8.xdiff.zip` |
| **v2.0系 (`VERSION` = `2.x`)** | `dist_v2/` | `dist_v2_update/` | `dist_v2/android/Tetheract_Android.apk` | `Tetheract_v2.0.x.zip` / `Tetheract_v2.0.xdiff.zip` |

- `build_dist.bat` および `server/make_release_zips.py` は、ルートの `VERSION` ファイルの先頭文字（`1.` か `2.` か）を自動判定し、`1.x` の時は `dist/` ＆ `dist_update/`、`2.x` の時は `dist_v2/` ＆ `dist_v2_update/` へ自動振り分けして出力する。
- `v2` ブランチの `scripts/build_android_apk.py` も、`dist_v2/android/Tetheract_Android.apk`（および `dist_v2_update/android/Tetheract_Android.apk`）へ出力する。
- `dist/`, `dist_update/`, `dist_v2/`, `dist_v2_update/` はすべて `.gitignore` 登録済みであるため、ブランチを切り替えても両方のビルド済みフォルダが手元に共存し続ける。
