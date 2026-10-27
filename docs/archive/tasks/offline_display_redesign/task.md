# タスクリスト: 未接続表示リデザイン ＆ 接続中フィルタ

## 変更作業

- [x] 未接続表示のデサチュレーション方式化
  - [x] `createPhotoCard`: `offline-badge` テキストバッジ廃止
  - [x] `createPhotoCard`: `.is-offline` クラス付与 + title ツールチップ設定
  - [x] CSS: `.photo-card.is-offline` のデサチュレーションスタイル定義
  - [x] CSS: ホバー時の復元アニメーション定義
  - [x] CSS: 旧 `.offline-badge` スタイル削除

- [x] ライトボックスのオフライン表示改善
  - [x] `loadLightboxPhoto`: インラインスタイル表示を `.lightbox-offline-pill` ピルバッジに変更
  - [x] CSS: `.lightbox-offline-pill` スタイル定義

- [x] インスペクタのアイコン統一
  - [x] `showSingleInspector`: ボリュームアイコンを 🔌/💿 → 🔴/🟢 に変更

- [x] 接続中の写真のみ表示フィルタ
  - [x] `state.onlineOnly` フラグ追加
  - [x] `fetchPhotos`: クライアントサイドフィルタ適用
  - [x] HTML: クイックアクセスに `onlineOnlyNavItem` 追加
  - [x] イベントリスナー: トグル式ON/OFF＋タイトル更新
  - [x] `updateViewHeader`: isFiltered 判定に `onlineOnly` 追加
  - [x] clearFilter: `onlineOnly` リセット + nav active 解除

## コード検証

- [x] `createPhotoCard` — 正常動作確認
- [x] `fetchPhotos` — フィルタ適用確認
- [x] `updateViewHeader` — isFiltered 反映確認
- [x] clearFilter — リセット確認
- [x] 「すべての写真」クリック — onlineOnly 解除確認
- [x] onlineOnly トグルOFF時のタイトル復元 — **修正実施・確認済み**
- [x] ライトボックス — ピルバッジ表示確認
- [x] インスペクタ — アイコン更新確認
- [x] HTML — nav アイテム配置確認
- [x] CSS — デサチュレーション・ピルバッジ定義確認

## ドキュメント

- [x] walkthrough.md 作成
- [x] task.md 作成
- [x] docs/offline_display_redesign/ に保存
