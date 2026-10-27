# タスクリスト: インスペクタのクイックタグツリー折りたたみ・階層化

- [x] 現状のコード調査とUI設計 <!-- id: 0 -->
  - [x] `renderInspectorQuickTree` の描画ロジック確認（フラット展開されている現状の把握）
  - [x] 開閉矢印・フォルダアイコン・子コンテナの階層ツリー構造の設計
- [x] CSSスタイルの追加・最適化 (`frontend/css/style.css`) <!-- id: 1 -->
  - [x] `.inspector-tree-node`, `.inspector-tree-item-left`, `.inspector-tree-children` のスタイル定義
  - [x] 開閉アニメーション・ホバー表現の統一
- [x] JavaScript実装 (`frontend/js/inspector.js`) <!-- id: 2 -->
  - [x] `renderInspectorQuickTree`: 親ノードの開閉（折りたたみ/展開）トグル実装
  - [x] 展開状態（`state.inspectorQuickTreeExpandedPaths`）の永続化
  - [x] 親ノードとリーフノードでのクリックイベント分離（展開矢印/行クリック vs `+追加` ボタン）
- [x] 実機ブラウザ検証 <!-- id: 3 -->
  - [x] 単一インスペクタの「タグツリーから選ぶ」で階層タグが折りたたまれ、クリックで展開・折りたたみできることを確認
  - [x] 親タグの「+追加」クリックで親タグが付与され、矢印クリックで開閉することを確認
  - [x] リーフタグをクリックして即座にタグ付与できることを確認
  - [x] 一括インスペクタ（複数選択）の「タグツリーから選ぶ」でも同様に折りたたみ・展開と一括付与ができることを確認
- [x] ドキュメント作成 (Implementation Plan & Walkthrough) <!-- id: 4 -->
