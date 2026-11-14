# Tetheract Photo Manager - v1.8系（PC安定版）と v2.0系（Android連携版）の分離・並行運用ガイド

本ドキュメントは、Tetheract Photo Manager における **v1.8系（PC単体・安定版ライン）** と **v2.0系（Android専用アプリ・Wi-Fiロッカー双方向同期・タッチUI統合ライン）** のソースコード管理およびビルド出力フォルダ（`dist` / `dist_v2`）の切り分け仕様を定義する。

---

## 1. 背景と目的

- **v1.8系（`main` ブランチ）**: PC版の改良・高速化・安定運用および公開リポジトリ（`public`）へのリリースを継続するため、Android連携用の実験的コード（`android/` プロジェクト、PC側のUDPディスカバリ待受、ペアリング承認ポーリング、差分DB生成等）を一切含まないクリーンな状態に保つ。
- **v2.0系（`v2` ブランチ）**: Android実機（スマホ・タブレット）での長期的な個人テスト・UIブラッシュアップを行うため、`origin/v2` ブランチに独立保管し、ビルド出力先も `dist_v2/` および `dist_v2_update/` に分離して、同じPC上でいつでも両系列を並行試用できるようにする。

---

## 2. ブランチとビルド出力フォルダの対応表

| 項目 | v1.8系（PC単体・安定版） | v2.0系（Android連携・タッチUI版） |
| :--- | :--- | :--- |
| **Git ブランチ** | `main` (`origin/main`) | `v2` (`origin/v2`) |
| **`VERSION` ファイル** | `1.8.x`（例: `1.8.3`） | `2.0.x`（例: `2.0.0`） |
| **フル版ビルド出力先** | `dist/` | `dist_v2/` |
| **軽量差分ビルド出力先** | `dist_update/` | `dist_v2_update/` |
| **Android APK 配置先** | なし（Androidコード非同梱） | `dist_v2/android/Tetheract_Android.apk` |
| **生成ZIP（`zip/` 等）** | `Tetheract_v1.8.x.zip` / `Tetheract_v1.8.xdiff.zip` | `Tetheract_v2.0.x.zip` / `Tetheract_v2.0.xdiff.zip` |

---

## 3. 自動振り分けの仕組み

1. **`build_dist.bat`**:
   - 実行時にルートの `VERSION` ファイルの1行目を読み取り、先頭が `2.` で始まる場合は出力先を自動的に `dist_v2` / `dist_v2_update` に切り替える（`1.` で始まる場合は従来通り `dist` / `dist_update`）。
   - `2.` 系ビルド時は `dist_v2/android/` 内の `Tetheract_Android.apk` および `tetheract_ui_bundle.zip` を保持したままPC母艦プログラムを最新化する。
2. **`server/make_release_zips.py`**:
   - `get_version()` が `2.` で始まる場合は `dist_v2` / `dist_v2_update` から `Tetheract_v2.x.x.zip` / `Tetheract_v2.x.xdiff.zip` を生成する。
3. **`scripts/build_android_apk.py`（`v2` ブランチのみ存在）**:
   - ビルド完了時に `dist_v2/android/Tetheract_Android.apk` および `dist_v2/android/tetheract_ui_bundle.zip` へ成果物を出力する。

---

## 4. 開発・ビルドの標準手順

### A. v1.8系（PC版）を改修・ビルドする時
```powershell
git checkout main
# コード修正・テスト実行後
cmd /c "set NO_PAUSE=1 && build_dist.bat"
# -> dist/ および dist_update/ が v1.8.x で更新される（dist_v2/ は一切影響を受けない）
```

### B. v2.0系（Android連携版）を改修・ビルドする時
```powershell
git checkout v2
# コード修正・テスト実行後、APKとPC母艦パッケージをビルド
.\python\python.exe scripts\build_android_apk.py
cmd /c "set NO_PAUSE=1 && build_dist.bat"
# -> dist_v2/ および dist_v2_update/（＋ dist_v2/android/Tetheract_Android.apk）が v2.0.x で更新される
# 作業完了後、普段のブランチを main に戻しておく場合は:
git checkout main
```

### C. v1.8系で行ったPC本体の修正を v2.0系へ反映する時
```powershell
git checkout v2
git cherry-pick <mainのコミットハッシュ>
git push origin v2
git checkout main
```
