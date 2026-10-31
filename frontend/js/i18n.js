/**
 * Photo Manager - マルチランゲージ（日本語 JP ⇄ English EN）リアルタイム切替モジュール (i18n.js)
 *
 * 特徴:
 * 1. DBスキーマや既存18モジュールの状態管理ロジックに一切触れず、DOM TextNode と属性（title / placeholder / aria-label）を
 *    双方向トラッキング（__pmOrigJa / __pmLastEn）して0.01秒で日英即時切替を行う。
 * 2. MutationObserver により、非同期描画される写真カード・インスペクタ・ライトボックス・2枚比較(Duel)・
 *    勝ちレンズカルテ(Kami-Lens Karte)・47都道府県制覇マップ(Seiha Map)・トースト通知までリアルタイムに自動翻訳する。
 * 3. カメラ文化・日本発祥スラング（Washi / Urusi, Ex / Gd / Nm / Rj, Lens Shaker, Kami-Lens Karte,
 *    Gear & Numa, Gacha, Osanpo Trail, Seiha Map, Betayaki HTML, Duel）を取り入れた小粋な英語UIを提供する。
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'pm_lang';
  let currentLang = localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'ja';
  let isApplying = false;

  /**
   * 完全一致辞書（日本語 ➔ English）
   * ※ 空白トリム後の文字列に対して完全一致で高速変換する
   */
  const EXACT_MAP = {
    // --- ヘッダー & テーマ・表示モード ---
    '和紙': 'Washi',
    '夜墨': 'Urusi',
    'テーマ切り替え (和紙 ⇄ 夜墨)': 'Switch Theme (Washi ⇄ Urusi)',
    '夜墨（ダーク）モードに切り替え': 'Switch to Urusi (Dark Ink) Mode',
    '和紙（ライト）モードに切り替え': 'Switch to Washi (Paper Light) Mode',
    'UI言語切り替え (日本語 ⇄ English)': 'Switch UI Language (English ⇄ 日本語)',
    'サイドバーを開閉 ([キー または Bキー)': 'Toggle Sidebar ([ or B key)',
    'サイドバーの固定表示を切替 ([キー または Bキー)': 'Toggle Sidebar Pinning ([ or B key)',
    'サイドバーを開閉': 'Toggle Sidebar',
    '詳細情報パネルを開閉': 'Toggle Inspector',
    '写真の詳細情報パネル（インスペクタ）を開閉 (Dキー)': 'Toggle Photo Inspector Panel (D key)',
    'セパレータ': 'Separator',
    'レイアウト切り替え': 'Switch Layout Mode',
    'グリッド': 'Grid',
    '均等グリッド (標準)': 'Uniform Grid (Standard)',
    'びっしり': 'Tight',
    'びっしり敷き詰め (縦横比維持)': 'Tight Justified Grid (Keep Aspect Ratio)',
    'マウント': 'Mount',
    'スライドマウント (昔のフィルム枠)': 'Slide Mount (35mm Reversal Film Frame)',
    'スライドショー': 'Slide',
    '表示中の写真でスライドショーを開始 (Spaceキーで一時停止/再開)': 'Start Slideshow with current photos (Space to Pause/Resume)',
    'スタック': 'Stack',
    '露出ブラケット・連写のスタック表示切り替え (ONで代表写真のみ表示、OFFで全枚数展開)': 'Toggle Stack Grouping for Bracket / Burst / Duplicates (ON: Primary only, OFF: Expand all)',
    '情報': 'HUD',
    '情報表示切り替え (文字・メタ情報を隠して写真だけを鑑賞 / Iキー)': 'Toggle HUD Overlay (Hide text & badges for clean viewing / I key)',
    'サムネイルサイズ': 'Thumbnail Size',
    '並び替え': 'Sort By',
    '新しい順 (撮影日)': 'Newest (Date Taken)',
    '古い順 (撮影日)': 'Oldest (Date Taken)',
    '撮影日時 (新しい順)': 'Date Taken (Newest)',
    '撮影日時 (古い順)': 'Date Taken (Oldest)',
    '評価の高い順': 'Top Rated (Ex → Rj)',
    '評価の高い順 (優 → 棄)': 'Top Rated (Ex → Rj)',
    'ファイル名順': 'File Name (A → Z)',
    'ファイル名順 (A → Z)': 'File Name (A → Z)',
    'ファイル名順 (Z → A)': 'File Name (Z → A)',
    'サイズが大きい順': 'File Size (Largest)',
    'サイズが小さい順': 'File Size (Smallest)',
    'F値・絞り (開放 → 絞込)': 'Aperture (Wide → Narrow)',
    '検索': 'Search',
    'レンズ情報なし': 'No Lens Info',
    'ピクチャ': 'Pictures',
    'ドキュメント': 'Documents',
    'デスクトップ': 'Desktop',
    'ダウンロード': 'Downloads',
    'ファイル名 (A→Z)': 'File Name (A → Z)',
    'ファイル名 (Z→A)': 'File Name (Z → A)',
    'ファイル名 (A → Z)': 'File Name (A → Z)',
    'ファイル名 (Z → A)': 'File Name (Z → A)',
    'サイズ (大きい順)': 'File Size (Large → Small)',
    'サイズ (小さい順)': 'File Size (Small → Large)',
    'ファイルサイズ (大きい順)': 'File Size (Large → Small)',
    'ファイルサイズ (小さい順)': 'File Size (Small → Large)',
    '焦点距離 (広角→望遠)': 'Focal Length (Wide → Tele)',
    '焦点距離 (望遠→広角)': 'Focal Length (Tele → Wide)',
    '焦点距離 (広角 → 望遠)': 'Focal Length (Wide → Tele)',
    '焦点距離 (望遠 → 広角)': 'Focal Length (Tele → Wide)',
    'F値 (開放→絞込)': 'Aperture (Wide Open → Stopped Down)',
    'F値 (開放 → 絞込)': 'Aperture (Wide Open → Stopped Down)',
    'F値 (絞込 → 開放)': 'Aperture (Stopped Down → Wide Open)',
    'シャッター速度 (高速 → 低速)': 'Shutter Speed (Fast → Slow)',
    'シャッター速度 (低速 → 高速)': 'Shutter Speed (Slow → Fast)',
    'ISO感度 (高い順)': 'ISO (High → Low)',
    'ISO感度 (低い順)': 'ISO (Low → High)',
    '調整済': 'Edited',
    '詳細属性...': 'More Attr...',
    'JPEG / 一般のみ': 'JPEG Only',
    'JPEG/一般のみ': 'JPEG Only',
    'RAW+JPG ペア': 'RAW+JPG Pair',
    'RAW+JPGペア': 'RAW+JPG Pair',
    'XMP あり': 'Has XMP',
    'XMPあり': 'Has XMP',
    '調整済みのみ': 'Edited Only',
    '調整済のみ': 'Edited Only',
    'RAWのみ': 'RAW Only',
    '属性フィルタ (すべて / RAWのみ / 調整済みのみ)': 'Attribute Filter (All / RAW Only / Edited Only)',
    'すべての形式を表示': 'Show all formats',
    'すべての形式・状態の写真を表示': 'Show photos of all formats and states',
    'RAW写真（およびRAW+JPGペア）のみ表示': 'Show RAW photos (and RAW+JPG pairs) only',
    'RAWデータ（またはRAW＋JPEGペア）の写真のみ表示': 'Show RAW photos (or RAW+JPEG pairs) only',
    '回転・傾き・切り抜き・トーン調整済みの写真のみ表示': 'Show photos with non-destructive edits only',
    '回転・傾き・クロップ・明るさ等の非破壊調整を行った写真のみ表示': 'Show photos with non-destructive edits (rotate, tilt, crop, tone)',
    'さらに詳細なファイル属性（JPEGのみ / RAW+JPGペア / XMPサイドカーあり）で絞り込み': 'Filter by detailed file attributes (JPEG only / RAW+JPG pair / Has XMP)',
    '取り込み': 'Import',
    'PCの写真ファイルを選んで、アプリ内にコピーしてライブラリに取り込みます': 'Select photo files from PC and copy into library',
    'PCの写真ファイルを選んで storage（アプリ内ストレージ）へコピー＆取り込みます': 'Select photo files from PC and import into in-app storage',
    'スマホ連携': 'Mobile',
    'スマホ（Android）連携・モバイル画面 (/m) を開く': 'Open Mobile Cull & USB Sync Guide (/m)',
    'ヘルプ': 'Help',
    '操作マニュアル & ショートカット一覧 (? / F1)': 'User Manual & Shortcuts (? / F1)',
    '終了': 'Quit',
    'Tetheract Photo Manager を終了する': 'Quit Tetheract Photo Manager',

    // --- 4段階評価（優 / 良 / 可 / 棄  Ex / Gd / Nm / Rj） ---
    '評価フィルタ:': 'Rating:',
    '優': 'Ex',
    '良': 'Gd',
    '可': 'Nm',
    '棄': 'Rj',
    '優 (1)': 'Ex - Excellent (1)',
    '良 (2)': 'Gd - Good (2)',
    '可 (0 / 4)': 'Nm - Normal (0 / 4)',
    '棄 (3 / X)': 'Rj - Reject / Botsu (3 / X)',
    '評価「優」の写真を表示/非表示': 'Toggle Ex (Excellent) photos in view',
    '評価「良」の写真を表示/非表示': 'Toggle Gd (Good) photos in view',
    '評価「可」の写真を表示/非表示': 'Toggle Nm (Normal) photos in view',
    '評価「棄」の写真を表示/非表示': 'Toggle Rj (Reject) photos in view',
    '優 (Excellent)': 'Ex (Excellent)',
    '良 (Good)': 'Gd (Good)',
    '可 (解除・普通)': 'Nm (Normal / Clear)',
    '棄 (非表示候補)': 'Rj (Reject / Botsu)',
    '可（解除）': 'Nm (Reset)',

    // --- 左サイドバー共通 & クイックアクセス ---
    'フィルタ全解除': 'Clear Filters',
    'すべてのフィルタを解除して全写真を表示': 'Clear all filters and show all photos',
    '開いているメニューを閉じる': 'Collapse open sections',
    'すべてのメニューを展開する': 'Expand all sections',
    'サイドバーを非表示にする ([ または B)': 'Hide Sidebar ([ or B)',
    'クイックアクセス': 'Quick Access',
    'すべての写真': 'All Photos',
    '未分類の写真': 'Untagged Photos',
    '未分類': 'Untagged',
    '接続中の写真': 'Connected Photos',
    '接続中のみ': 'Online Only',
    '未接続の写真': 'Offline Photos',
    '未接続のみ': 'Offline Only',
    'リンク消失の写真': 'Unlinked Photos',
    '重複のある写真': 'Duplicate Photos',
    '現在の絞り込み条件': 'Active Filters',
    '条件なし（すべての写真）': 'No Filter (All Photos)',
    'セット名を入力 (例: 2025北海道旅行)': 'Preset name (e.g. Hokkaido 2026)',
    '現在の絞り込み条件を名前をつけて保存': 'Save current filter conditions as a preset',
    '保存': 'Save',
    '保存済みセット': 'Saved Presets',
    '保存されたセットはありません': 'No saved presets yet',
    '適用': 'Apply',
    'このフィルタセットを適用': 'Apply this filter preset',
    '▶︎ 再生': '▶︎ Play',
    '▶ 再生': '▶ Play',
    'このセットでスライドショーを再生': 'Play slideshow with this preset',
    'このセットを削除': 'Delete this preset',

    // --- 左サイドバー: フォルダ ---
    'フォルダ': 'Folders',
  'クイック': 'Quick',
  '年月': 'Date',
  '機材': 'Gear',

    'スキャン完了後にAIタグを自動付与するかどうかを切り替えます': 'Toggle Auto AI-Tagging after folder scan',
    'データベースの最適化（VACUUM）やバックアップ': 'Database Optimization (VACUUM) & Backup',
    'ドライブ一覧とフォルダツリーを再読み込み': 'Reload drives and folder tree',
    '展開': 'Expand',
    '管理中のフォルダまで展開': 'Expand to managed folders',
    '閉じる': 'Collapse',
    'すべてのフォルダを折りたたむ': 'Collapse all folders',
    '折りたたむ': 'Collapse',
    '読み込み中...': 'Loading...',
    'リンク情報なし': 'Unlinked Files',
    '実体ファイルとの紐付けが外れた（リンク消失）写真を表示': 'Show photos whose source files were moved or unlinked',
    'スキャン中...': 'Scanning...',
    'パスを直接入力してスキャン...': 'Enter folder path to scan...',
    'フォルダパスを入力して Enter または右のボタンでスキャンを開始します': 'Enter folder path and press Enter or click ▶ to scan',
    '入力したフォルダをスキャンして管理に追加': 'Scan entered folder and add to library',
    'ショートカット': 'Shortcuts',
    '接続中のドライブ': 'Connected Drives',
    '未接続（キャッシュのみ）': 'Offline (Cached Thumbnails)',
    '接続中のドライブがありません': 'No connected drives found',
    '除外': 'Ignored',
    '消失': 'Missing',

    // --- 左サイドバー: タグ (アルバム) & カラー ---
    'タグ (アルバム)': 'Tags (Albums)',
    'カラーフィルタを開閉': 'Toggle Color Palette Filter',
    'カラー': 'Colors',
    'タグ名を入力...': 'Enter tag name...',
    '作成': 'Create',
    '手動': 'Manual',
    'AI': 'AI',
    'すべて': 'All',
    'タグ候補を絞り込み (Enter)...': 'Filter tags (Enter)...',
    'タグを絞り込み...': 'Filter tags...',
    '検索解除': 'Clear search',
    'クリックで': 'Click:',
    '[+]含む': '[+] In',
    '[-]除外': '[-] Out',
    '解除': 'Off',
    'クリア': 'Clear',
    '枚数順': 'By Count',
    'ON: 写真枚数が多い順 ／ OFF: 設定の名前順ルール': 'ON: Sort by photo count desc / OFF: Sort by name rule in Settings',
    'ON: 写真枚数が多い順 ／ OFF: 設定された名前順': 'ON: Sort by photo count desc / OFF: Sort by name rule in Settings',
    'ツリー編集': 'Edit Tree',
    'タグツリーエディタ（階層移動・名前変更・削除）を開く': 'Open Tag Tree Editor (Drag & Drop hierarchy, rename, delete)',
    '設定': 'Settings',
    '表示設定・タグツリーエディタ・データベース管理（VACUUM / バックアップ）': 'Display Settings, Tag Tree Editor & Database Maintenance (VACUUM / Backup)',
    '設定 ＆ タグツリーエディタ': 'Settings & Tag Tree Editor',
    'タグの名前順ルール': 'Tag Name Sort Rule',
    'タグツリーエディタ': 'Tag Tree Editor',
    '全展開': 'Expand All',
    '全折りたたみ': 'Collapse All',
    '⬆ 子タグをここにドラッグ＆ドロップで「ルート（最上位階層）」へ独立移動': '⬆ Drag & Drop a child tag here to promote it to Root level',
    '新しいルートタグ名を入力 (親/子 も可)...': 'New root tag name (Parent/Child allowed)...',
    '+ 新規作成': '+ Create',
    '手動タグはまだ登録されていません。下の入力欄から作成できます。': 'No manual tags yet. Create one using the input box below.',
    '赤': 'Red',
    '青': 'Blue',
    '緑': 'Green',
    '黄': 'Yellow',
    '黄色': 'Yellow',
    '黒': 'Black',
    '白': 'White',
    '銀': 'Silver',
    '銀・シルバー': 'Silver',
    '金': 'Gold',
    '金・ゴールド': 'Gold',
    '茶': 'Brown',
    '茶色': 'Brown',
    '紫': 'Purple',
    '橙': 'Orange',
    'オレンジ': 'Orange',
    '桃': 'Pink',
    'ピンク': 'Pink',

    // --- 左サイドバー: ジオタグ & 制覇マップ ---
    'ジオタグ': 'Geotags',
    'ジオタグツリーを再読み込み': 'Reload Geotag Tree',
    '制覇マップ': 'Seiha Map',
    '47都道府県 制覇白地図': '47-Pref Seiha Map',
    '47都道府県 撮影制覇白地図': '47 Prefectures Seiha Map',
    '47都道府県 撮影制覇白地図・撮影密度ヒートマップ・撮影さんぽ軌跡を開く': 'Open 47-Prefecture Seiha Map, Density Heatmap & Osanpo Trail',
    '47都道府県 撮影制覇白地図・ヒートマップ・撮影さんぽ軌跡を開く': 'Open 47-Prefecture Seiha Map, Density Heatmap & Osanpo Trail',
    'すべての地域を展開': 'Expand all regions',
    'すべての地域を折りたたむ': 'Collapse all regions',
    'ジオタグなし': 'No Geotag',
    'ジオタグ（位置情報）が登録されていない写真を表示': 'Show photos without GPS location data',
    'ジオタグ付きの写真がありません': 'No geotagged photos found',

    // --- 左サイドバー: タイムライン & カメラ・レンズ (Gear & Numa) ---
    'タイムライン': 'Timeline',
    '複数選択可': 'Multi-OR',
    '年・月をクリックしてOR条件で絞り込み可能': 'Click years/months to filter with OR condition',
    'カメラ・レンズ': 'Gear & Numa',
    '排他検索可': 'Numa Filter',
    'クリックで [+]含む [-]除外 解除': 'Click: [+] In [-] Out Off',
    'カメラ・レンズ一覧を再読み込み': 'Reload Gear & Lens Tree',
    'すべてのレンズ一覧を展開': 'Expand all lenses',
    'すべてのレンズ一覧を折りたたむ': 'Collapse all lenses',
    'スキャン後に表示': 'Shown after scan',

    // --- 左サイドバー: ファイル名検索 ---
    'ファイル名検索': 'File Search',
    'ファイル名で検索...': 'Search by filename...',
    '検索クリア': 'Clear search',
    '入力したキーワードを含むファイル名を即座に絞り込み表示します。': 'Instantly filters photos matching the filename keyword.',

    // ---  storage（アプリ内ストレージ）管理 ---
    'storage (アプリ内ストレージ)': 'storage (In-App Storage)',
    'storageへインポート': 'Import to storage',
    '選択した写真をアプリ内の storage フォルダへコピー＆インポートします': 'Copy & import selected photos into the in-app storage folder',
    '作成&インポート': 'Create & Import',
    'storage内にフォルダを作成してインポート': 'Create a subfolder in storage and import',
    'インポート先フォルダ': 'Destination Folder in storage',
    'storage内で移動': 'Move in storage',
    'storage 内の写真を別サブフォルダへ移動します': 'Move photos to another subfolder inside storage',
    '作成&移動': 'Create & Move',
    'storage内にフォルダを作成して移動': 'Create a subfolder in storage and move',
    '移動先フォルダ': 'Destination Folder in storage',
    'storageフォルダを開く': 'Open storage Folder',
    'エクスプローラーでstorageフォルダを開きます': 'Open storage folder in File Explorer',
    'ファイル名を変更 (F2)': 'Rename File (F2)',
    '一括連番リネーム... (F2)': 'Batch Sequential Rename... (F2)',
    'ファイル名変更': 'Rename',
    '一括リネーム': 'Batch Rename',
    '新規サブフォルダを作成...': 'Create New Subfolder...',
    'フォルダ名を変更...': 'Rename Folder...',
    'このフォルダを外部へエクスポート...': 'Export This Folder...',
    '空フォルダを削除': 'Delete Empty Folder',
    'ファイル名を変更': 'Rename File',
    'storage 内の写真ファイル名を変更します': 'Rename photo file in storage',
    '現在のファイル名:': 'Current Filename:',
    '変更を保存 (Enter)': 'Save Changes (Enter)',
    '撮影日時 ＋ 3桁連番': 'Date Taken + 3-Digit Seq',
    '撮影日時 ＋ 元ファイル名': 'Date Taken + Original Name',
    '自由な接頭辞 ＋ 3桁連番': 'Custom Prefix + 3-Digit Seq',
    '接頭辞（プレフィックス）': 'Custom Prefix',
    '開始番号': 'Start Number',
    '変更プレビュー（先頭5件）': 'Preview (First 5 Items)',
    '新規サブフォルダを作成': 'Create New Subfolder',
    'storage 内に新しいサブフォルダを作成します': 'Create a new subfolder inside storage',
    '作成する': 'Create',

    // --- 左サイドバー:  ラボ (Lab) ---
    'ラボ': 'Lab',
    '分析・発掘': 'Karte & Dig',
    '撮影カルテ・選別発掘': 'Karte & Discovery',
    '光線・露出・記念日スマート抽出': 'Smart Light & OTD Filters',
    '勝ちレンズ・得意設定カルテ': 'Kami-Lens Karte',
    'これまでの評価から勝ちレンズ・黄金の焦点距離・F値・時間帯を診断します': 'Diagnose your Kami-Lenses, Golden Focal Length, F-stop & Shutter Rhythm from your ratings',
    '未整理ガチャ': 'Discovery Gacha',
    '未整理（評価：可）の写真が残っているフォルダをランダムに1つ引き当てます': 'Draw a random folder that still has unrated (Nm) photos!',
    '未整理（可）の写真が残っているフォルダをランダムに1つ引き当てます': 'Draw a random folder that still has unrated (Nm) photos!',
    '2枚比較 (V)': 'Compare 2 Photos (V)',
    '選択した2枚の写真を並べて同期ズーム＆Exif比較 (Vキー)': 'Side-by-side sync zoom & Exif comparison (V key)',
    '選択した2枚の写真を並べて同期ズーム＆Exif比較 (V)': 'Side-by-side sync zoom & Exif comparison (V)',
    '歴代の今日・記念日': 'On This Day',
    '今日': 'Today',
    '今日の日付に戻す': 'Reset to today',
    '月を選択': 'Select Month',
    '日を選択': 'Select Day',
    '抽出': 'Dig',
    '抽出中': 'Active',
    '指定した月日の歴代写真を抽出・解除': 'Filter photos taken on this month & day across all years',
    '太陽高度・露出ラボ抽出': 'Solar Angle & Exposure Lab',
    'ラボの絞り込み条件をすべて解除': 'Clear all Lab filters',
    'マジックアワー': 'Golden Hour',
    '太陽高度 -4°〜+6° のドラマチックな光（朝焼け・夕焼け）で撮影した写真を抽出': 'Filter photos shot during Golden Hour (solar altitude -4° to +6°)',
    'ブルーアワー': 'Blue Hour',
    'マジック＆ブルーアワー': 'Golden & Blue Hour',
    'マジック＋ブルーアワー': 'Golden & Blue Hour',
    'マジック＋ブルー': 'Golden & Blue',
    '太陽高度 -8°〜-4° の静謐な蒼い薄明時間帯の写真を抽出': 'Filter photos shot during Blue Hour (solar altitude -8° to -4°)',
    '夜景・星景': 'Night & Astro',
    '夜景・天体': 'Night & Astro',
    '太陽高度 -8°未満の夜景・星景写真を抽出': 'Filter night & astrophotography shots (solar altitude < -8°)',
    '手ブレ注意': 'Lens Shaker',
    '手ブレ危険度': 'Lens Shaker',
    '手ブレ注意領域': 'Lens Shaker',
    'シャッター速度 < 1/焦点距離 秒 の微ブレ危険領域にある写真を抽出': 'Filter shots where Shutter Speed < 1/Focal Length sec (Check for camera shake!)',

    // --- メインビュー・ヘッダー & 空状態 ---
    'すべて解除': 'Clear All',
    '絞り込みをすべて解除してすべての写真を表示': 'Clear all active filters and show all photos',
    'リンク消失写真をすべて完全消去': 'Purge All Unlinked Photos',
    'リンク消失しているすべての写真レコード（サムネイル・タグ含む）をDBから完全に消去': 'Permanently remove all unlinked photo records from database',
    'このフィルタを解除': 'Remove this filter',
    '実フォルダが存在しないか、ドライブが未接続です': 'Folder missing or external drive disconnected',
    'USBメモリ等の外部ドライブが抜かれているか、フォルダが移動・削除された可能性があります。（保存済みサムネイルをキャッシュから表示中）': 'External drive may be unplugged or folder moved. (Showing cached thumbnails)',
    '再確認': 'Recheck',
    '接続を再確認': 'Recheck Connection',
    '接続状態を再確認': 'Recheck drive connection status',
    '写真が見つかりません': 'No Photos Found',
    '指定された条件の写真がないか、まだスキャンされていません。': 'No photos match the current filters, or no folders have been scanned yet.',
    'フォルダ管理を開く': 'Open Folder Tree',
    'フォルダ一覧を開く': 'Open Folder Tree',
    '実フォルダが見つかりません（未接続）': 'Folder Not Found (Offline)',
    'このフォルダはライブラリ未登録です': 'Folder Not Registered in Library',
    '実ディスク上に存在する未登録フォルダです。「管理に追加」を押すと写真をスキャンしてライブラリに登録します。': 'This folder is not registered yet. Click "Add & Scan" to import its photos into your library.',
    '管理に追加してスキャン': 'Add to Management & Scan',
    'このフォルダは管理対象外（除外設定中）です': 'Folder is Ignored',
    '自動スキャンの対象から除外されています。「除外を解除」を押すと未登録状態に戻せます。': 'Excluded from scanning. Click "Unignore" to restore.',
    '↩ 除外を解除する': '↩ Unignore Folder',
    '選択 (Ctrl/Shiftクリック対応)': 'Select (Ctrl/Shift+Click supported)',
    '日付不明': 'Unknown Date',
    'カメラ不明': 'Unknown Camera',

    // --- 右ペイン: インスペクタ ---
    '写真情報': 'Inspector',
    '調整': 'Adjust',
    '波形': 'Hist',
    '画像の切り抜き・傾き補正・明るさ微調整を開く (Cキー)': 'Open Crop, Horizon Level & Tone Adjustments (C key)',
    '切り抜き・傾き・明るさを調整 (Cキー)': 'Adjust Crop, Horizon Level & Tone (C key)',
    '切り抜き・傾き・明るさを調整 (C)': 'Adjust Crop, Horizon Level & Tone (C)',
    '詳細情報 (EXIF・タグ) の表示/非表示': 'Toggle EXIF & Tags Drawer',
    'RGB・輝度ヒストグラムを表示/非表示 (Hキー)': 'Toggle RGB & Luminance Histogram (H key)',
    '反時計回りに90°回転 (Lキー)': 'Rotate 90° CCW (L key)',
    '時計回りに90°回転 (Rキー)': 'Rotate 90° CW (R key)',
    '元データが格納されているフォルダを開く (Explorer)': 'Open containing folder in Explorer',
    '写真を関連付けられた規定のアプリで開く': 'Open photo in default external app',
    'パネルを閉じる': 'Close Inspector',
    'ダブルクリックでライトボックスを開く': 'Double-click to open Lightbox',
    '露出ブラケット': 'Exposure Bracket',
    '▼ 他のコマを表示': '▼ Show More Frames',
    '▲ 折りたたむ': '▲ Collapse Frames',
    '代表に設定': 'Crown',
    '代表': 'Primary',
    'タグ': 'Tags',
    '詳細情報': 'Exif',
    'マップ': 'Map',
    'GPS位置情報あり': 'Has GPS Location',
    '色合いパレットを開閉': 'Toggle Color Palette',
    '色合い (複数選択可)': 'Color Tone (Multiple selectable)',
    'タグツリーから選ぶ / 追加': 'Quick Tag Tree / Add',
    'AI自動タグ付けを開閉': 'Toggle Local AI Tagging',
    'AI自動タグ付け': 'AI Auto-Tagging',
    'ローカルAI (CLIP Vision) が写真の被写体・シーンを自動認識してタグ付けします。': 'Local AI (CLIP Vision) recognizes subjects & scenes offline.',
    'この写真をAIで自動タグ付け': 'Auto-tag this photo with AI',
    'ファイル名': 'File Name',
    'フォーマット': 'Format',
    '形式': 'Format',
    'RAW ファイル': 'RAW File',
    'RAWペア': 'RAW Pair',
    'RAWを開く': 'Open RAW',
    'OSのデフォルトアプリでRAWファイルを開く': 'Open RAW file in OS default application',
    'JPEG + RAW (ペア)': 'JPEG + RAW (Pair)',
    'JPEG / 一般画像': 'JPEG / Standard',
    '撮影日時': 'Date Taken',
    'カメラ機種': 'Camera',
    'レンズ': 'Lens',
    '露出・設定': 'Exposure',
    'シャッター速度': 'Shutter Speed',
    '絞り値 (F値)': 'Aperture (F-Stop)',
    'ISO感度': 'ISO Sensitivity',
    '露出補正': 'Exposure Bias',
    '焦点距離': 'Focal Length',
    '解像度': 'Dimensions',
    'ファイルサイズ': 'File Size',
    '保存パス': 'File Path',
    '保存場所': 'File Path',
    '保存ボリューム': 'Volume',
    '緯度・経度': 'Latitude / Longitude',
    '撮影地域': 'Shooting Location',
    'ジオタグ削除': 'Delete Geotag',
    'SQLiteデータベースからこの写真のジオタグ（緯度・経度・地名）を削除します（元画像ファイルは変更されません）': 'Remove GPS coordinates from SQLite DB (Original file is untouched)',
    'この写真にはGPS情報が記録されていません': 'No GPS coordinates recorded for this photo',
    '近隣写真からGPSをコピー': 'Copy GPS from Nearby Photos',
    'スマホGPS準用': 'Copy Phone GPS',
    'ジオタグ準用': 'Apply Nearby GPS',

    // --- インスペクタ: 一括編集モード (Batch View) ---
    '枚の写真を選択中': 'photos selected',
    '一括評価を設定': 'Batch Rating',
    'タグを一括付与': 'Batch Add Tags',
    '色合い一括パレットを開閉': 'Toggle Batch Color Palette',
    '色合いを一括設定 (複数選択可)': 'Batch Set Color Tone (Multiple selectable)',
    'タグツリーから選んで一括追加': 'Batch Add from Tag Tree',
    '選択写真に付いているタグ': 'Tags on Selected Photos',
    'ジオタグの一括操作': 'Batch Geotag Actions',
    '選択をすべて解除': 'Deselect All',
    '選択解除': 'Deselect',

    // --- ヒストグラム (histogram.js) ---
    'ヒストグラム': 'Histogram',
    '枠内': 'Crop',
    '全体': 'Full',
    '集計範囲の切替（切り抜き枠内のみ ⇔ 写真全体）': 'Toggle histogram scope (Crop Box ⇔ Full Image)',
    'ヒストグラム表示モード': 'Histogram Mode',
    'RGB重畳 + 輝度ライン': 'RGB Overlay + Luma Curve',
    '輝度': 'Luma',
    '輝度 (Luminance) のみ': 'Luminance Only',
    '3色': 'Parade',
    'R・G・B 3段分離パレード表示': 'RGB 3-Row Parade',
    'ヒストグラムを閉じる (H)': 'Close Histogram (H)',
    'クリックで表示モード切替 (RGB → 輝度 → 3色) / ホバーで階調値確認': 'Click to cycle mode (RGB → Luma → Parade) / Hover to inspect tone value',
    '黒つぶれ領域（階調 0〜3 のピクセル割合）': 'Shadow Clipping (Pixels in tone 0–3)',
    '平均輝度 (0〜255) と露出傾向': 'Mean Luminance (0–255) & Exposure Tendency',
    '白飛び領域（階調 252〜255 のピクセル割合）': 'Highlight Clipping (Pixels in tone 252–255)',

    // --- ライトボックス & スライドショー ---
    '詳細情報 (EXIF)': 'EXIF Details',
    'AIタグ': 'AI Tag',
    'AIでこの写真の被写体・シーンを認識してタグ付け': 'Recognize subject & scene with Local AI',
    'タグ名を入力してEnter...': 'Enter tag name & press Enter...',
    '追加': 'Add',
    '反時計回りに90°回転 (L)': 'Rotate 90° CCW (L)',
    '時計回りに90°回転 (R)': 'Rotate 90° CW (R)',
    '回転・調整をリセット (0°)': 'Reset Rotation & Adjustments (0°)',
    '画像の調整 (Crop & Rotate)': 'Adjust Image (Crop, Level & Tone / C)',
    'EXIF詳細トグル': 'Toggle EXIF Drawer',
    '閉じる (Esc)': 'Close (Esc)',
    '前の写真・スタック (←)': 'Previous Photo / Stack (←)',
    '次の写真・スタック (→)': 'Next Photo / Stack (→)',
    'スライドショーを終了 (Esc)': 'Exit Slideshow (Esc)',
    '前の写真 (←)': 'Previous Photo (←)',
    '次の写真 (→)': 'Next Photo (→)',
    '一時停止 / 再生 (Space)': 'Pause / Play (Space)',
    '表示速度の切り替え': 'Slide Interval Speed',
    'シャッフル再生 (S)': 'Shuffle Play (S)',
    'Exif情報の表示/非表示 (I)': 'Toggle EXIF Overlay (I)',
    '全画面表示 (F)': 'Fullscreen (F)',

    // --- 画像調整モーダル (adjust.js) ---
    '画像の調整': 'Adjust Image (Crop, Level & Tone)',
    'トーンをコピー': 'Copy Tone',
    'トーンをペースト': 'Paste Tone',
    '元画像と比較 (\\\\)': 'Compare Original (\\\\)',
    '元画像 (Before)': 'Original (Before)',
    '明るさ・コントラスト・彩度の設定値をコピーします（傾き・回転・切り抜き枠は除外）': 'Copy Brightness, Contrast & Saturation values (excludes tilt, rotation & crop)',
    '現在のトーン調整（明るさ・コントラスト・彩度）をコピー (Ctrl+Shift+C)': 'Copy current tone adjustments (Brightness, Contrast, Saturation / Ctrl+Shift+C)',
    '明るさ・コントラスト・彩度の設定値をコピーします (Ctrl+Shift+C)': 'Copy Brightness, Contrast & Saturation values (Ctrl+Shift+C)',
    'コピーした明るさ・コントラスト・彩度をこの写真に適用します': 'Paste copied Brightness, Contrast & Saturation to this photo',
    'コピー済みのトーン調整（明るさ・コントラスト・彩度）をペースト (Ctrl+Shift+V)': 'Paste copied tone adjustments (Brightness, Contrast, Saturation / Ctrl+Shift+V)',
    'コピーしたトーン調整（明るさ・コントラスト・彩度）を選択写真に一括ペーストします (Ctrl+Shift+V)': 'Batch paste copied tone adjustments to selected photos (Ctrl+Shift+V)',
    '選択中の写真（非破壊調整反映済み）をクリップボードへ画像コピーします (Ctrl+C)': 'Copy selected photo (with non-destructive edits) to clipboard (Ctrl+C)',
    '選択中の写真の撮影日時（DB）を一括でプラス・マイナス補正します': 'Batch shift date taken (DB) for selected photos',
    '押している間だけ調整前の元画像（Before）を表示します（\\\\キー または Spaceキー長押しでも比較可能）': 'Hold to preview unadjusted original image (or hold \\\\ / Space key)',
    '押している間だけ無加工の元画像（Before）を表示します (\\ キー または Space キー長押し)': 'Hold to preview unadjusted original image (\\ or Space key)',
    '傾': 'Tilt',
    '明': 'EV',
    '◐比': '◐Cont',
    '彩': 'Sat',
    '比率:': 'Aspect:',
    '元の比率': 'Original',
    '1:1 正方形': '1:1 Square',
    '16:9 ワイド': '16:9 Wide',
    '4:3 標準': '4:3 Standard',
    '3:2 一眼比率': '3:2 DSLR',
    '自由': 'Free',
    '自由比率': 'Free Aspect',
    '回転:': 'Rotate:',
    '左90°': '90° L',
    '右90°': '90° R',
    'リセット': 'Reset',
    '切り抜き・傾き・トーン・回転をすべて元に戻す': 'Reset all crop, tilt, tone, and rotation adjustments',
    'キャンセル': 'Cancel',
    'キャンセル (Esc)': 'Cancel (Esc)',
    '適用して保存': 'Apply & Save',

    // --- 2枚比較モーダル (compare.js: Duel) ---
    '2枚比較 (Side-by-Side)': 'Duel (Side-by-Side)',
    '比較モード': 'Duel Mode',
    '同期:': 'Sync:',
    'ビュー': 'Pan',
    'ズーム': 'Zoom',
    'クリックで100%（等倍・位置中央）にリセット': 'Click to reset to 100% fit & center',
    '左右入替 (S)': 'Swap A⇄B (S)',
    '左(A)と右(B)の写真を入れ替えます (Sキー)': 'Swap Left (A) and Right (B) photos (S key)',
    '右(B)を基準にして次へ (W)': 'Crown B → A & Next (W)',
    '右(B)の写真を左(A:基準)の座に据え、右(B)には次の候補を呼び出します (Wキー)': 'Promote Right (B) to Left (A: Champion) and load next challenger into B (W key)',
    '波形比較 (H)': 'Waveforms (H)',
    '左右両方のRGBヒストグラムを同時表示して露出・階調を比較します (Hキー)': 'Compare RGB Histograms side-by-side (H key)',
    'ホイール:拡大 / ←→:右(B)切替 / 1・2・3:評価': 'Wheel: Zoom / ←→: Next B / 1·2·3: Rate',
    '比較モードを閉じる (Esc / V)': 'Close Duel Mode (Esc / V)',
    'A : 基準': 'A : Champion',
    'B : 比較候補': 'B : Challenger',
    '数字キー (1:優 / 2:良 / 3:棄) の評価対象': 'Active target for keys (1:Ex / 2:Gd / 3:Rj)',
    '左(A)に「優」を設定': 'Rate Left (A) as Ex (Excellent)',
    '左(A)に「良」を設定': 'Rate Left (A) as Gd (Good)',
    '左(A)の評価を「可（解除）」に設定': 'Reset Left (A) to Nm (Normal)',
    '左(A)に「棄」を設定': 'Rate Left (A) as Rj (Reject)',
    '右(B)に「優」を設定': 'Rate Right (B) as Ex (Excellent)',
    '右(B)に「良」を設定': 'Rate Right (B) as Gd (Good)',
    '右(B)の評価を「可（解除）」に設定': 'Reset Right (B) to Nm (Normal)',
    '右(B)に「棄」を設定': 'Rate Right (B) as Rj (Reject)',

    // ---  勝ちレンズ・得意設定カルテ (lab.js: Kami-Lens Karte) ---
    '勝ちレンズ・得意設定カルテ（パーソナル撮影ラボ）': 'Kami-Lens Karte (Personal Photo Lab)',
    'これまでの評価（優・良）から、あなたと最も相性の良い機材・焦点距離・F値・時間帯を診断します': 'Diagnoses your best-performing lenses, bodies, golden focal lengths, apertures & shooting hours from your Ex/Gd ratings',
    '勝ちレンズ＆カメラ番付': 'Kami-Lens & Camera Ranking',
    '黄金の焦点距離 & F値分析': 'Golden Focal Length & F-number Analysis',
    '撮影時間帯 & 光の傾向': 'Shooting Time & Light Trends',
    '分析対象写真': 'Analyzed Photos',
    '「優」獲得数 / 打率': '"Ex" Count / Batting Average',
    '好評価（優＋良）率': 'Good Rating (Ex+Gd) Rate',
    '薄明マジック＆ブルー': 'Twilight Magic & Blue',
    'レンズ別「優」獲得打率ランキング': 'Lens Ranking by "Ex" Rate',
    'カメラボディ別 歩留まり番付': 'Camera Body Ranking by Yield',
    'このレンズで絞り込む': 'Filter by this Lens',
    'このカメラで絞り込む': 'Filter by this Camera',
    '絞り込む': 'Filter',
    '撮影枚数シェア': 'Shot Share',
    'あなたの黄金スイートスポット診断': 'Your Golden Sweet Spot Diagnosis',
    '焦点距離5区分別 枚数 &「優」打率': '5 Focal Ranges: Count & "Ex" Rate',
    '超広角 〜 超望遠': 'Ultra-Wide to Super-Telephoto',
    'F値（絞り）5区分別 枚数 &「優」打率': '5 Aperture Ranges: Count & "Ex" Rate',
    '開放ボケ 〜 パンフォーカス・小絞り': 'Wide-Open Bokeh to Deep Focus',
    'あなたのゴールデンタイム分析': 'Your Golden Time Analysis',
    '24時間シャッターリズム（0時〜23時）': '24-Hour Shutter Rhythm (00:00 – 23:00)',
    '総撮影枚数': 'Total Photos',
    '優 獲得枚数': 'Ex Shots',
    '太陽高度（天文計算）＆ 露出条件でワンクリック抽出': 'Solar Elevation & Exposure 1-Click Extraction',
    '撮影カルテを集計中...': 'Aggregating shooting report...',
    'レンズ・カメラ情報が記録された写真がありません': 'No photos with recorded camera/lens EXIF found',

    // ---  47都道府県 制覇マップ (location_map.js: Seiha Map & Osanpo Trail) ---
    'ジオタグ全国制覇マップ ＆ 撮影密度ヒートマップ ＆ 撮影さんぽ軌跡': 'Geotag Nationwide Seiha Map, Heatmap & Walking Trail',
    '47都道府県の撮影制覇状況・よく撮るホットスポット・1日のフォトラリー移動軌跡を可視化します': 'Visualize your 47-prefecture conquest, favorite photo hotspots, and daily Osanpo photo walk trails',
    '撮影密度ヒートマップ': 'Shooting Density Heatmap',
    '撮影さんぽ軌跡ライン': 'Shooting Walking Trail Line',
    '全国47都道府県 制覇率': '47 Prefectures Seiha Rate',
    '総ジオタグ写真枚数': 'Total Geotagged Photos',
    '制覇ランク称号': 'Seiha Rank Title',
    '全国47都道府県 完全制覇グランドマスター': 'All 47 Prefectures Grand Master',
    '日本列島制覇マイスター': 'Japan Archipelago Master',
    '全国縦断フォトトラベラー': 'National Traverse Photo Traveler',
    '旅するフォトグラファー': 'Traveling Photographer',
    '地域開拓エクスプローラー': 'Regional Explorer',
    '撮影旅の始まり': 'Beginning of Photo Journey',
    '未踏の地図（GPS写真をスキャンしよう）': 'Uncharted Map (Scan GPS photos)',
    '塗り分け基準:': 'Color By:',
    '撮影枚数モード': 'Photo Count Mode',
    '優枚数モード': 'Ex Count Mode',
    '制覇済': 'Conquered',
    '未訪問': 'Unvisited',
    '優 / 打率': 'Ex / Rate',
    '良 (Good) 枚数': 'Gd (Good) Count',
    'この都道府県のジオタグ付き写真はまだ登録されていません': 'No geotagged photos registered for this prefecture yet',
    '国・地域別クイック絞り込み:': 'Quick Filter by Country/Region:',
    '撮影日を選択:': 'Select Walk Date:',

    // ---  スマート・テイクアウト &  ベタ焼きHTML ---
    'スマート・テイクアウト': 'Smart Takeout',
    'スマート・テイクアウト...': 'Smart Takeout...',
    '元ファイルを非破壊のまま、回転・水平出し・クロップ・トーン・解像度・Exifを整えて出力': 'Non-destructively export photos with rotation, horizon level, crop, tone, resize & Exif control',
    '元の写真ファイルは一切変更されず、指定のフォルダへ新しく書き出されます': 'Original files are never modified; new copies are exported to the destination folder',
    '非破壊調整・DB情報の反映': 'Apply Non-Destructive Adjustments & DB Info',
    '回転・水平出し・クロップ・トーン微調整を反映して出力': 'Bake rotation, horizon tilt, crop & tone adjustments into exported files',
    'DBの位置情報（GPS）・向きをExifへ同期して書き込む': 'Sync DB GPS & Orientation to Exif',
    '解像度・サイズ': 'Resolution & Size',
    'オリジナル解像度（リサイズなし）': 'Original Resolution (No Resize)',
    '4K Ultra HD (長辺 3840px)': '4K Ultra HD (Long edge 3840px)',
    'フルHD (長辺 1920px)': 'Full HD (Long edge 1920px)',
    'SNS/Web標準': 'SNS / Web',
    '軽量 (長辺 1280px)': 'Light (Long edge 1280px)',
    'メール/共有': 'Mail / Share',
    'カスタム長辺:': 'Custom Long Edge:',
    '保存フォーマット & 画質': 'Save Format & Quality',
    '圧縮品質:': 'Quality:',
    'ファイル名ルール': 'Filename Rule',
    '元のファイル名を維持': 'Keep Original Filename',
    '自由名 ＋ 連番:': 'Custom Prefix + Seq:',
    '_001.jpg (秒数順)': '_001.jpg (Time Order)',
    'Exif メタデータの消去': 'Strip Exif Metadata',
    '※全オフならExifを完全維持': '*All OFF keeps full EXIF',
    'すべて（Exifメタデータを完全消去）': 'All (Completely strip Exif metadata)',
    '位置情報（GPS座標・ジオタグ）': 'Location Info (GPS Coordinates & Geotags)',
    '撮影条件（SS・F値・ISO感度・露出・焦点距離）': 'Shooting Conditions (SS, F-number, ISO, Exposure, Focal Length)',
    'カメラ・機材情報（メーカー・機種・レンズ・シリアル）': 'Camera & Gear Info (Maker, Model, Lens, Serial)',
    'その他（コメント・説明文・著作権・サムネイル等）': 'Strip Others (Comments, Copyright, Embedded Thumb)',
    '保存先フォルダ': 'Destination Folder',
    'フォルダ選択...': 'Select Folder...',
    '完了後にエクスプローラーでフォルダを開く': 'Open destination folder in Explorer when finished',
    'エクスポートを準備中...': 'Preparing export...',
    '写真を出力しています...': 'Exporting photos...',
    '完了しました！': 'Export Complete!',
    'テイクアウト開始': 'Start Takeout',
    'ベタ焼きHTML出力...': 'Betayaki HTML...',
    '暗室コンタクトシート・A4印刷対応': 'Darkroom Contact Sheet (A4 Print)',

    // --- 右クリックメニュー & 下部フローティングバー ---
    'タグを付ける': 'Add Tag',
    '新しいタグ名...': 'New tag name...',
    '付与': 'Add',
    '既存タグから選択': 'Select from Existing Tags',
    'テイクアウト': 'Takeout',
    '回転・クロップ・Exif制御': 'Crop, Rotate & Exif',
    '回転・クロップ・解像度・Exif制御': 'Crop, Resize & Exif',
    '新規フォルダ名...': 'New folder name...',
    '作成&送信': 'Create & Copy',
    'take_outフォルダを開く': 'Open take_out Folder',
    '送信先フォルダ': 'Destination Subfolders',
    '評価を設定': 'Set Rating',
    '評価設定': 'Rate',
    '評価を一括設定': 'Batch Set Rating',
    '調整と回転': 'Adjust & Rotate',
    '↻ 右へ回転 (R)': '↻ Rotate 90° CW (R)',
    '↺ 左へ回転 (L)': '↺ Rotate 90° CCW (L)',
    '切り抜き・微調整 (C)': 'Crop & Fine Adjust (C)',
    'トーン調整をコピー (Ctrl+Shift+C)': 'Copy Tone Adjustments (Ctrl+Shift+C)',
    'トーン調整をペースト (Ctrl+Shift+V)': 'Paste Tone Adjustments (Ctrl+Shift+V)',
    'トーン調整を一括ペースト': 'Batch Paste Tone Adjustments',
    '画像をクリップボードにコピー (Ctrl+C)': 'Copy Image to Clipboard (Ctrl+C)',
    '↺ 回転・調整をリセット': '↺ Reset Adjustments',
    '回転': 'Rotate',
    '↻ 写真を一括回転': '↻ Batch Rotate Photos',
    '右へ90° (R)': '90° CW (R)',
    '左へ90° (L)': '90° CCW (L)',
    '回転・調整をリセット': 'Reset Adjustments',
    'サムネイルを更新': 'Refresh Thumbnail',
    'サムネイル更新': 'Refresh Thumb',
    'その他': 'More',
    '⋯ その他の操作': '⋯ More Actions',
    'サムネイル更新・ジオタグ準用・ジオタグ削除などの一括操作メニュー': 'More batch actions (Refresh Thumbnails, Infer GPS, Clear GPS)',
    'ジオタグ準用 (スマホGPS)': 'Infer GPS (Phone GPS)',
    'ジオタグ情報を削除': 'Clear GPS Info',
    '写真ファイルを現在のフォルダ（またはstorage）に取り込む': 'Import photo files into current folder (or storage)',
    'プレビューを開く': 'Open Preview',
    'ライブラリから削除': 'Remove from Library',
    '削除': 'Remove',
    '選択を解除': 'Deselect',
    'このフォルダを再スキャン（直下のみ）': 'Rescan This Folder (Direct only)',
    '配下も含めて再スキャン': 'Rescan Including Subfolders',
    'リフレッシュ（再スキャン＋消失写真のDB削除）': 'Refresh (Rescan + DB Cleanup)',
    'AIタグ付け': 'AI Tagging',
    '管理から外す（DB登録解除）': 'Remove from Management',
    '管理対象外（除外）に設定': 'Exclude from Management',
    '↩ 除外を解除（未管理に戻す）': '↩ Unignore Folder',
    'エクスプローラーで開く': 'Open in File Explorer',

    // --- 各種モーダル（終了・DBメンテナンス・フォルダ登録・タグ削除・スマホ連携） ---
    'Tetheract Photo Manager の終了': 'Exit Tetheract Photo Manager',
    'サーバー停止の確認': 'Confirm Server Shutdown',
    'サーバーを停止して終了しますか？': 'Stop server and quit Tetheract Photo Manager?',
    'バックエンドサーバーを安全に停止し、データベースを完全にクローズして終了します。': 'Safely stops the local backend server and closes the SQLite database.',
    '終了後にUSBメモリをPCから安全に取り外せます。': 'You can safely remove the USB drive from PC after exit.',
    'サーバーを停止して終了': 'Stop Server & Quit',
    '停止処理中...': 'Stopping...',
    'データベースメンテナンス': 'Database Maintenance',
    'ライブラリDBの最適化・世代バックアップ管理': 'Optimize SQLite DB & Manage Backups',
    'データベースの状態': 'Database Status',
    'データベース最適化 (VACUUM)': 'Database Optimization (VACUUM)',
    '不要領域を解放してファイルサイズを縮小し、読み書きを高速化します': 'Reclaims unused space, shrinks DB size, and speeds up queries',
    '最適化を実行': 'Run VACUUM',
    'データベースのバックアップ': 'Database Backup',
    '確認中...': 'Checking...',
    '今すぐ作成': 'Backup Now',
    '保存先フォルダを開く': 'Open Backup Folder',
    'フォルダの管理登録': 'Folder Management Registration',
    'ライブラリへのフォルダ追加': 'Add folder to Tetheract library',
    '登録範囲を選択してください。サブフォルダの写真もまとめて登録する場合は「子フォルダを含む」を選択してください。': 'Choose scan depth. Select "Include Subfolders" to scan nested folders as well.',
    '直下のみ': 'Direct Only',
    '子フォルダを含む': 'Include Subfolders',
    'タグの完全削除': 'Delete Tag from Library',
    'ライブラリ全体からのタグ除去': 'Remove tag from all photos',
    '※ 写真ファイル自体は削除されません。': '* Original photo files are never deleted.',
    'タグを削除': 'Delete Tag',
    'スマホ（Android）選別連携 & USB抜き差しガイド': 'Smartphone (Android) Sorting Sync & USB Guide',
    'ネットワーク設定不要・USBメモリ1本で安全に持ち出し＆自動反映': 'Cull on phone via Wi-Fi QR or offline USB drive',
    '未反映のスマホ選別データ (mobile_sync.json) を検出しました': 'Detected unapplied smartphone sort data (mobile_sync.json)',
    '今すぐPCに反映': 'Apply to PC Now',
    '直近のスマホ選別データ取り込み実績': 'Recent Smartphone Sync History',
    'PCでスマホ画面を試す': 'Preview /m on PC',
    '単体HTMLを保存': 'Save Standalone HTML',
    'コピー': 'Copy',
    '手動で選別データを取り込む場合:': 'Manual Sync Import:',
    'クリップボードから反映': 'Paste from Clipboard',
    'mobile_sync.json を選択して取り込む': 'Import mobile_sync.json',
    'スマホ選別データの取り込み完了': 'Smartphone Sort Data Imported',
    '反映された写真の内訳:': 'Updated Photos:',
    '確認 (OK)': 'OK',
    '写真をドロップして追加': 'Drop Photos to Import',
    'JPEG, PNG, WebP などの画像ファイルをここにドロップしてください': 'Drop JPEG, PNG, WebP or RAW files here to copy into library',

    // --- ヘルプモーダル タブ見出し & フッター & Overview / Shortcuts ---
    'Tetheract Photo Manager 操作マニュアル & ヘルプ': 'Tetheract Photo Manager User Manual & Help',
    '初めての方から応用・スマホ連携まで、目的に合わせて読めるレベル別ガイド': 'Complete guide from basic 1-hand culling to Lab Karte, Duel & Mobile USB sync',
    'はじめに': 'Overview',
    'Basic編 (基本)': 'Basics',
    'Advance編 (応用)': 'Advanced & Lab',
    'Mobile & USB編': 'Mobile & USB',
    'ショートカット & FAQ': 'Shortcuts & FAQ',
    'Tetheract Photo Manager へようこそ — 安心・軽快なローカル写真管理': 'Welcome to Tetheract Photo Manager — Fast, Safe & Portable Local Photo Culling',
    '元写真は絶対に傷つけない（完全非破壊）': '100% Non-Destructive (Original Files Untouched)',
    'アプリ内で写真を回転したり、傾き・明るさを調整したり、「棄（ボツ）」の評価を付けても、パソコン内の元ファイルは1バイトも変更・削除されません。いつでも元の状態に戻せます。': 'Rotating, leveling, adjusting exposure, or marking a photo as "Rj (Botsu)" never alters or deletes a single byte of your original files.',
    'ネット接続不要（完全オフライン動作）': '100% Offline & Local Privacy',
    '写真を外部のクラウドへ送信することは一切ありません。AIによる自動タグ付けや撮影場所（県・市区町村）の判定も、すべてお使いのパソコン内部だけで安全に完結します。': 'Zero cloud uploads. Local AI subject tagging and reverse-geocoding (Country > Prefecture > City) run entirely offline on your PC.',
    '片手でサクサク！4段階の高速選別': 'One-Hand High-Speed 4-Tier Culling',
    '連写・ブラケット・重複写真を自動で束ねる': 'Auto-Stacking for Bursts, Brackets & Duplicates',
    '傾き・切り抜き・明るさ微調整 ＆ 一括書き出し': 'Non-Destructive Crop, Tilt, Tone & Smart Takeout',
    'USBメモリ持ち歩き ＆ スマホでの片手選別': 'Portable USB Catalog & Mobile Thumb Culling',
    '気分や用途で選べる3つの表示レイアウト': '3 View Layouts & Washi / Urusi Themes',
    'グリッド (標準)': 'Grid (Standard)',
    '正方形の枠に整然と並ぶ標準モード。ファイル名や日付も見やすく、大量の写真を素早く探すのに最適です。': 'Clean uniform square frames. Ideal for browsing filenames, dates, and thousands of shots quickly.',
    'びっしり (Justified)': 'Tight (Justified)',
    '写真本来の縦横比をそのまま活かし、隙間なく画面いっぱいに敷き詰めるモード。構図や迫力を楽しめます。': 'Preserves original aspect ratios and packs photos edge-to-edge to showcase composition.',
    'マウント (Slide Mount)': 'Mount (Slide Mount)',
    'フィルムのスライドマウント枠を再現した鑑賞モード。「情報」ボタンをOFFにすれば無地枠で作品を堪能できます。': 'Classic 35mm reversal film slide mounts. Turn off "HUD" for pure gallery framing.',
    'はじめての4ステップ': 'First 4 Steps',
    'フォルダ登録': 'Register Folder',
    '左サイドバー「 フォルダ」から写真が入ったフォルダをクリックします。': 'Click a photo folder under " Folders" in the left sidebar.',
    '数字キーで選別': 'Sort with Number Keys',
    '拡大・ピント確認': 'Zoom & Focus Check',
    '書き出し・活用': 'Export & Utilize',
    '選んだ写真を「 テイクアウト」でまとめたり、「」で現像ソフトへ渡します。': 'Export via " Takeout" or pass RAW files directly to your developer app.',
    '一覧画面でのショートカット': 'Grid View Keyboard Shortcuts',
    'ライトボックス（全画面拡大）＆ 2枚比較画面でのショートカット': 'Lightbox & 2-Photo Duel Shortcuts',
    'キー': 'Key',
    'キー / 操作': 'Key / Action',
    '機能・アクション': 'Action',
    '選択中の写真を拡大表示（ライトボックス）で開く': 'Open selected photo in Lightbox',
    '写真上の文字・バッジ表示を隠す / 表示する（クリーンモード切替）': 'Toggle HUD text & badge overlays (Clean View)',
    '左サイドバーの表示 / 非表示を切り替え': 'Toggle Left Sidebar',
    '右インスペクタ（詳細パネル）の表示 / 非表示を切り替え': 'Toggle Right Inspector Panel',
    '表示中のすべての写真を選択': 'Select all displayed photos',
    '選択を全解除 / 開いているウィンドウを閉じる': 'Deselect all / Close active modal',
    '本ヘルプ（操作マニュアル）を表示': 'Open this Help & Shortcut Guide',
    '拡大 (200%) ⇔ 等倍 (100%) をワンタッチ切替': 'Toggle 200% Zoom ⇔ 100% Fit',
    'ライトボックス / 2枚比較画面を閉じて一覧画面に戻る': 'Close Lightbox / Duel and return to Grid',
    'よくある質問（FAQ）': 'FAQ',
    'さらに詳しい解説はプロジェクト内の': 'For full details, see',
    'をご覧ください。': 'in the project folder.',

    // --- 追加の細かいラベル・属性・モーダル内テキスト ---
    '枚': 'shots',
    '対象写真:': 'Target Photos:',
    '例: DSC01234.jpg': 'e.g. DSC01234.jpg',
    '例: 20261013_143000_DSC01234.jpg': 'e.g. 20261013_143000_DSC01234.jpg',
    '例: 20261013_001.jpg (秒数順ソート)': 'e.g. 20261013_001.jpg (Time Sorted)',
    '出力先フォルダパス...': 'Destination folder path...',
    '接頭辞...': 'Prefix...',
    '露出ブラケット:': 'Exposure Bracket:',
    '登録写真数:': 'Total Photos:',
    'DBサイズ:': 'DB Size:',
    'サムネイル数:': 'Thumbnails:',
    '解放可能領域:': 'Reclaimable WAL:',
    'タグ「': 'Delete tag "',
    '」を削除しますか？': '"?',
    'このタグおよびその子孫タグがすべての写真から削除されます。': 'This tag and its child tags will be removed from all photos.',
    '」を登録しますか？': '" to Library?',
    '直下のファイル数: 0枚': 'Direct files: 0 shots',
    '接続URLを取得中...': 'Fetching LAN URL...',
    '同じWi-Fi（LAN）内のスマホカメラで左のQRコードを読み取ると、スマホ専用画面が開きリアルタイムに選別・タグ付けできます。': 'Scan the QR code with your phone camera on the same Wi-Fi (LAN) to open the mobile culling view (/m) in real time.',
    '① 自宅Wi-Fi: QRコードでスマホ版 (': '1. Home Wi-Fi: Scan QR to Open Mobile View (',
    ') に入る': ')',
    '② USB持ち出し選別: USB抜き差し＆JSON反映の4ステップ': '2. USB Portable Sorting: 4 Steps of USB & JSON Sync',
    '【Step 1】PCからUSBを抜くとき': '[Step 1] Before Unplugging USB from PC',
    '【Step 2】スマホにUSBを挿して写真を読み込む': '[Step 2] Plug USB into Phone & Load DB',
    '【Step 3】選別結果をUSBに保存してスマホから抜く（最重要）': '[Step 3] Save mobile_sync.json & Safely Unmount USB ( Crucial)',
    '【Step 4】PCにUSBを挿して起動すると自動反映＆通知！': '[Step 4] Plug USB Back into PC for Auto-Sync!',
    'PC画面右上の': 'Click the top-right',
    '「 終了」ボタン': '" Quit" button',
    'から「サーバーを停止して終了」を実行し（ウィンドウの「×」だけではバックグラウンド常駐が維持されます）、Windowsタスクバー右下の「ハードウェアの安全な取り外し」を行ってからUSBメモリを抜きます。': 'and choose "Stop Server & Quit", then use Windows "Safely Remove Hardware" before unplugging the USB drive.',
    'スマホにUSBを挿し、「ファイル」アプリでUSB内の': 'Plug the USB into your phone, open',
    'を開きます。続けて': 'in the Files app, then tap',
    '「 library.db を読み込む」': '" Load library.db"',
    'から': 'and select',
    '（現在': '(currently',
    '）を選ぶと全写真が表示され、親指で高速選別できます（選別中はUSBを挿したままでOKです）。': ') to browse and cull all photos with your thumb.',
    '選別が終わったらスマホ画面右上の「 DB/同期」から': 'When finished, tap " DB/Sync" →',
    '「 mobile_sync.json を保存する」': '" Save mobile_sync.json"',
    'でUSB直下に保存します。': 'to save to the USB root folder.',
    '「 書き込み・クローズ完了」': '" Write & Close Complete"',
    'と表示されたら、スマホ画面上の通知バーから': 'appears, open the phone notification bar and tap',
    '「USBドライブを取り外す（マウント解除）」': '"Unmount / Eject USB Drive"',
    'を必ずタップしてからUSBを抜いてください。': 'before unplugging the USB drive.',
    'USBをPCに挿して': 'Plug the USB into your PC and launch',
    'を起動すると、自動的に': '—',
    'が取り込まれ、画面中央に': 'is automatically imported and the',
    '「 スマホ選別データの取り込み完了」通知ウィンドウ': '" Mobile Sync Applied!" dialog',
    'が表示されます。': 'will be shown.',
    'USBメモリの選別差分データをPCライブラリへ反映しました': 'Applied mobile culling changes from USB to PC library',
    '1 枚の写真の選別結果を反映しました！': 'Applied mobile culling changes to 1 photo!',
    '1/3段EVステップ (-2.0EV〜+2.0EV / ダブルクリックで 0.0EV にリセット)': '1/3 EV steps (-2.0EV to +2.0EV / Double-click to reset to 0.0EV)',
    'PC上でスマホ画面 (/m) を別ウィンドウで開いて試す': 'Preview Mobile View (/m) in a separate window on PC',
    'SQLite上のジオタグ情報（緯度・経度・地名）を一括削除': 'Batch clear GPS coordinates & location names from SQLite DB',
    'このフォルダ配下の写真にAIタグを自動付与します': 'Auto-tag photos in this folder using Local AI',
    'エクスプローラーでtake_outフォルダを開きます': 'Open take_out folder in Windows Explorer',
    'クリップボードにコピーした選別JSONを直接反映': 'Apply mobile sync JSON directly from clipboard',
    'コントラスト (ダブルクリックで 0 にリセット)': 'Contrast (Double-click to reset to 0)',
    'コントラスト +1 (Shift+クリックで +5)': 'Contrast +1 (Shift+Click for +5)',
    'コントラスト -1 (Shift+クリックで -5)': 'Contrast -1 (Shift+Click for -5)',
    'ダブルクリックで 0 にリセット': 'Double-click to reset to 0',
    'ダブルクリックで 0.0EV にリセット': 'Double-click to reset to 0.0EV',
    'ダブルクリックで 0.0° にリセット': 'Double-click to reset to 0.0°',
    'フォルダを作成して選択中のJPGをコピー': 'Create subfolder and copy selected photos',
    'マップ等で追加・変更したGPS位置情報や回転向きを書き出し画像のExifに反映します': 'Write updated DB GPS coordinates and rotation into exported image EXIF',
    '傾き +0.1° (Shift+クリックで +1.0°)': 'Tilt +0.1° (Shift+Click for +1.0°)',
    '傾き -0.1° (Shift+クリックで -1.0°)': 'Tilt -0.1° (Shift+Click for -1.0°)',
    '単体HTMLを別フォルダやスマホ転送用に保存': 'Download standalone mobile HTML file',
    '回転・クロップ・解像度・ファイル名・Exif制御を一括適用して出力': 'Export with non-destructive rotation, crop, resize, rename & EXIF control',
    '回転・切り抜き・微調整を一括リセット': 'Batch reset rotation, crop, tilt & tone adjustments',
    '彩度 (ダブルクリックで 0 にリセット)': 'Saturation (Double-click to reset to 0)',
    '彩度 +1 (Shift+クリックで +5)': 'Saturation +1 (Shift+Click for +5)',
    '彩度 -1 (Shift+クリックで -5)': 'Saturation -1 (Shift+Click for -5)',
    '撮影時刻が近いスマホ写真のジオタグ（±1時間）を一括準用': 'Batch copy GPS from nearby smartphone photos shot within ±1 hour',
    '明るさ +1/3段 (+0.3EV / Shift+クリックで +1.0EV)': 'Brightness +1/3 EV (+0.3EV / Shift+Click for +1.0EV)',
    '明るさ -1/3段 (-0.3EV / Shift+クリックで -1.0EV)': 'Brightness -1/3 EV (-0.3EV / Shift+Click for -1.0EV)',
    '明るさ / 露出補正 (1/3段EVステップ、ダブルクリックで 0.0EV にリセット)': 'Brightness / Exposure Bias (1/3 EV steps, Double-click to reset)',
    '水平傾き (ダブルクリックで 0.0° にリセット)': 'Horizon Tilt (Double-click to reset to 0.0°)',
    '選択した写真を暗室ネガシート風のスタンドアロンHTML（ベタ焼き）として出力します': 'Export selected photos as a darkroom Betayaki contact sheet HTML (A4 print ready)',
    '選択した写真（JPEG）をアプリ内の take_out フォルダへコピーし、持ち出しの準備をします': 'Export or copy selected photos to the take_out folder',
    '選択中の写真にタグを付ける': 'Add tags to selected photos',
    '選択中の写真のサムネイルを取得・更新します': 'Regenerate thumbnails for selected photos',
    '選択中の写真のジオタグ情報（緯度・経度・地名）をSQLiteデータベースから削除します（元ファイルは変更されません）': 'Remove GPS coordinates of selected photos from SQLite DB (Original files untouched)',
    '選択中の写真の評価を一括設定': 'Batch set rating for selected photos',
    '選択中の写真をライブラリから登録解除': 'Unregister selected photos from library DB',
    '選択中の写真を一括回転': 'Batch rotate selected photos',
    '選択中の写真（ジオタグなし）に対して、撮影時刻が近いスマホ写真のジオタグ（±1時間）を一括準用します': 'Infer GPS coordinates for selected photos from smartphone photos taken within ±1 hour',
    '配下の写真を再スキャンし、移動・削除された写真をライブラリから削除します': 'Rescan folder and clean up missing/moved photo records from DB',

    // --- JS動的生成ボタン・バッジ・ヒストグラム・インスペクタ・各モジュール ---
    '階調・露出': 'Tone & Hist',
    'ヒストグラムを表示 (H)': 'Show Histogram (H)',
    'ヒストグラムを隠す (H)': 'Hide Histogram (H)',
    'ヒストグラム (H)': 'Histogram (H)',
    '平均': 'Avg',
    'シャドウ': 'Shadow',
    '中間調': 'Mid',
    'ハイライト': 'High',
    '(暗め)': '(Low-Key)',
    '(明るめ)': '(High-Key)',
    '画像読み込み中...': 'Loading image...',
    'RGBヒストグラムを表示/非表示 (Hキー)': 'Toggle RGB Histogram (H key)',
    'プレビュー下部にRGB・輝度ヒストグラムを展開します (Hキー)': 'Expand RGB & Luma Histogram below preview (H key)',
    'RGBヒストグラム表示/非表示 (H)': 'Toggle RGB Histogram (H)',
    'トーン調整・切り抜き枠にリアルタイム連動するRGBヒストグラムを表示/非表示 (H)': 'Toggle real-time RGB Histogram linked to tone & crop (H)',

    'この写真を一覧の代表写真にする': 'Set this photo as the stack primary (Crown)',
    '現在のグループ代表写真です': 'Current stack primary photo (Crown)',
    'クリックしてこの写真をグループの代表に設定': 'Click to set this photo as stack primary (Crown)',
    'グループの代表写真に設定しました': 'Set as the stack primary photo (Crown)',
    '代表写真の変更に失敗しました': 'Failed to change the stack primary photo',
    '一括編集': 'Batch Edit',
    '一括解除': 'Remove All',
    'タグなし': 'No tags',
    'タグ付きの写真はありません': 'No tagged photos in selection',
    '手動タグはありません': 'No manual tags yet',
    '手動タグとして確定（昇格）': 'Promote AI tag to Manual tag',
    '+追加': '+Add',
    '+付与': '+Add',
    '+送信': '+Send',
    '展開する': 'Expand',
    '展開/折りたたみ': 'Expand / Collapse',
    'レンズ一覧を展開/折りたたみ': 'Expand / Collapse lenses',
    '新しいタグ名を入力...': 'Enter new tag name...',
    '新しいタグを作成して付与 (親/子 も可)': 'Create and add new tag (Parent/Child supported)',
    '不明': 'Unknown',
    '場所不明': 'Unknown Location',
    'ラベルなし': 'Unlabeled',
    '準用': 'INFERRED',
    'スマホ写真から準用': 'Inferred from nearby phone photo',
    'クリックで写真切り替え': 'Click to switch photo',
    '実体パス未登録': 'Unlinked Path',
    '実体パス未登録（リンク消失）': 'Unlinked Path (File Moved/Missing)',
    '実体ファイルとの紐付けが外れています': 'Source file link is missing',
    '近隣のジオタグ付き写真 (±60分)': 'Nearby Geotagged Photos (±60 min)',
    '直前 / 直後の候補から選ぶ': 'Choose Before / After Candidate',
    'この位置を採用': 'Use This GPS',
    '±60分以内にGPS付き写真が見つかりませんでした。': 'No geotagged photos found within ±60 minutes.',
    'スマホで撮影した写真をスキャンしてみてください。': 'Try scanning photos taken with your smartphone.',

    'リンク消失の写真（実体パス未登録）': 'Unlinked Photos (Missing Path)',
    'ジオタグなしの写真': 'Photos Without Geotag',
    'クイックアクセスを開く': 'Open Quick Access',
    'RAW+JPEGペア写真': 'RAW + JPEG Pair',
    'なし': 'None',
    '含む': 'Include',
    'サムネイル取得': 'Fetch Thumb',
    'サムネイルを取得': 'Fetch Thumbnails',
    '選択中の写真のサムネイルを取得します': 'Generate thumbnails for selected photos',
    '選択中の写真のサムネイルを更新します': 'Regenerate thumbnails for selected photos',
    'take_out (直下)': 'take_out (Root)',
    '登録済みタグがありません': 'No registered tags',
    'その他のAIタグはありません': 'No other AI tags',
    'その他のタグなし (＋で作成)': 'No other tags (Click + to create)',
    '日付情報なし': 'No date info',
    'カメラ情報なし': 'No camera info',
    '[未接続]': '[Offline]',
    '[消失]': '[Missing]',
    '[除外]': '[Ignored]',
    '[未登録]': '[Unregistered]',
    '配下をスキャンして管理に追加': 'Scan & Add to Library',
    'サブフォルダはありません': 'No subfolders',
    '読み込みに失敗しました': 'Failed to load',
    '取得に失敗しました': 'Failed to load',
    '写真ファイルを検索中...': 'Finding photo files...',
    '連写・露出グループ化中...': 'Grouping bursts & brackets...',
    '写真スキャン中...': 'Scanning photos...',
    'スキャン準備中...': 'Preparing scan...',
    'スキャン完了': 'Scan Complete',
    'バックアップ: まだ作成されていません': 'Backup: None created yet',
    '最適化中...': 'Optimizing...',
    'データベースの最適化（VACUUM）が完了しました': 'Database VACUUM optimization complete',
    '作成中...': 'Creating...',
    '管理中のフォルダ': 'Managed Folder',
    '管理対象外（除外）': 'Ignored Folder',
    '未登録のフォルダ（右クリックで管理に追加）': 'Unregistered Folder (Right-click to add & scan)',
    '● 配下に管理フォルダがあります': '● Contains managed subfolders',
    '未接続のドライブ上のフォルダです（キャッシュのみ）': 'Folder on offline drive (Cached thumbnails only)',
    'ライブラリに写真がありますが、実フォルダが見つかりません': 'Photos in library, but physical folder is missing',
    '保存済みのサムネイルで閲覧・絞り込みができます': 'You can browse and filter using cached thumbnails',
    'スキャン完了後にAI自動タグ付けを実行します（クリックでOFF）': 'Auto AI-Tagging after scan is ON (Click to turn OFF)',
    'スキャン完了後にAI自動タグ付けを実行しません（クリックでON）': 'Auto AI-Tagging after scan is OFF (Click to turn ON)',
    'スキャン後のAI自動タグ付けを有効にしました': 'Enabled Auto AI-Tagging after scan',
    'スキャン後のAI自動タグ付けを無効にしました': 'Disabled Auto AI-Tagging after scan',

    '2枚並べて比較 (V)': 'Compare 2 Photos (V)',
    '2枚並べてピント・構図・露出を比較 (Vキー)': 'Compare focus, framing & exposure side-by-side (V key)',
    '選択中の写真を左右2枚並べて同時ズーム比較します (Vキー)': 'Compare selected photos side-by-side with sync zoom (V key)',
    '比較画像 A': 'Compare Image A',
    '比較画像 B': 'Compare Image B',
    'サムネイルを': 'Thumbnail:',
    'クリックで 右(B)': 'Click → Right (B)',
    'に表示 ／': '/',
    'Shift+クリックで 左(A)': 'Shift+Click → Left (A)',
    'に固定 ／': '/',
    'Alt+ドラッグ・ホイール': 'Alt+Drag/Wheel',
    'で一時的に片方だけ操作': 'for independent pan/zoom',
    '比較できる写真がありません': 'No photos available to compare',
    '比較するには2枚以上の写真が必要です': 'At least 2 photos are required for Duel comparison',
    '点灯している項目が左右で連動します（Altキー押下中は一時的に片側のみ操作）': 'Active toggles sync Left & Right (Hold Alt for independent control)',
    'ビュー位置（ドラッグ移動）を左右で同期します。OFFにすると片方だけドラッグして構図のズレを合わせられます': 'Sync pan position between A & B. Turn OFF to align framing offset independently',
    'ズーム倍率（ホイール拡大）を左右で同期します。OFFにすると片方だけ倍率を変えて被写体の大きさを揃えられます': 'Sync zoom level between A & B. Turn OFF to match subject scale independently',

    '連写スタートコマ (0.000s)': 'Burst Start Frame (0.000s)',
    '解析中...': 'Analyzing...',
    'この写真に該当するタグは見つかりませんでした': 'No matching AI tags found for this photo',
    '一時停止 (Space)': 'Pause (Space)',
    '再生 (Space)': 'Play (Space)',
    '表示中の写真': 'Current Photos',
    'スライドショーの対象写真がありません': 'No photos available for slideshow',
    '表示できる写真がありません': 'No photos to display',

    '優 (Excellent) 枚数': 'Ex (Excellent) Shots',
    'このカメラ＆レンズの組み合わせでメイングリッドを絞り込む': 'Filter main grid by this Camera + Lens combo',
    'まだ時間帯別の撮影データが十分にありません。': 'Not enough hourly shooting data yet.',
    '焦点距離は': 'Your sweet spot is',
    '、最も「優」が生まれやすいあなたのゴールデンタイムは': ', and your highest "Ex" hit-rate Golden Time is',
    '最も多くシャッターを切る時間帯は': 'Your most active shutter hour is',
    'です！': '!',
    '未整理（評価：可）の写真が残っているフォルダはありません！すべて整理済みです。': 'All folders are culled! No unrated (Nm) photos left.',

    '少': 'Low',
    '多（クリックで都道府県絞り込み）': 'High (Click prefecture to filter)',
    '撮影密度が高い場所ほど': 'Higher shooting density glows',
    '青緑 黄 橙 朱赤（#e14d2a）': 'Teal Yellow Orange Vermilion (#e14d2a)',
    'に輝きます。サークルをクリックすると地域で絞り込めます。': '. Click any circle to filter by area.',
    '主要な撮影軌跡すべて (最新1,500枚)': 'All Major Trails (Latest 1,500 photos)',
    '撮影スポット': 'Photo Spot',
    '撮影枚数:': 'Shots:',
    '/ 優:': '/ Ex:',
    '総移動距離:': 'Total Distance:',
    '所要時間:': 'Duration:',
    '歩数換算目安:': 'Est. Steps:',
    '滞在ホットスポット:': 'Hotspots:',
    'この写真を表示': 'Show this photo',
    '全国制覇マップ＆軌跡データを集計中...': 'Aggregating nationwide map & trail data...',
    'Leaflet 地図ライブラリが読み込まれていません': 'Leaflet map library is not loaded',
    'ジオタグ情報の読み込みに失敗しました': 'Failed to load geotag data',
    '北海道地方': 'Hokkaido Region',
    '東北地方': 'Tohoku Region',
    '関東地方': 'Kanto Region',
    '中部地方': 'Chubu Region',
    '近畿地方': 'Kinki Region',
    '中国地方': 'Chugoku Region',
    '四国地方': 'Shikoku Region',
    '九州・沖縄地方': 'Kyushu & Okinawa',
    '東北': 'Tohoku',
    '関東': 'Kanto',
    '中部': 'Chubu',
    '近畿': 'Kinki',
    '中国': 'Chugoku',
    '四国': 'Shikoku',
    '九州・沖縄': 'Kyushu & Okinawa',
    '日本': 'Japan',
    'アメリカ': 'USA',
    'フランス': 'France',
    'イギリス': 'UK',
    'イタリア': 'Italy',
    'ドイツ': 'Germany',
    '韓国': 'South Korea',
    '台湾': 'Taiwan',
    'オーストラリア': 'Australia',
    'カナダ': 'Canada',
    'スペイン': 'Spain',

    'サーバーは正常に停止しました': 'Server Stopped Safely',
    'このブラウザタブまたはウィンドウを閉じてください。': 'You may now close this browser window.',
    '次回は': 'Next time, launch from',
    'から一瞬で起動できます。': 'for instant startup.',
    'サーバーを停止しています...': 'Stopping server...',
    'サーバーを停止しました。ウィンドウを閉じます。': 'Server stopped. Closing window...',
    'ドライブ・フォルダの接続状態を確認中...': 'Checking drive & folder connection status...',
    '接続状態を更新しました': 'Connection status updated',
    '↩ 除外を解除しました': '↩ Unignored folder',
    '取り込み中...': 'Importing...',
    '反映中...': 'Applying...',
    'フォルダを開きました': 'Opened folder in Explorer',
    'フォルダを開けませんでした': 'Could not open folder',
    '規定のアプリで写真を開きました': 'Opened photo in default app',
    'ファイルを開けませんでした': 'Could not open file',
    'RAWファイルを開けませんでした': 'Could not open RAW file',
    'スマホ写真からジオタグを準用しました': 'Copied GPS from nearby phone photo',
    'ジオタグ情報を削除しました': 'Cleared GPS data from DB',
    '画像の調整を保存しました': 'Saved image adjustments',
    '調整を初期状態に戻しました': 'Reset adjustments to default',
    '回転・調整をリセットしました': 'Reset rotation & adjustments',
    'take_outフォルダを開きました': 'Opened take_out folder',
    'ベタ焼きHTML（コンタクトシート）を生成中...': 'Generating Betayaki Contact Sheet HTML...',
    'クリックでこのフィルタの場所を開く（×で解除）': 'Click to jump to this filter in sidebar (× to remove)',

    // ヘルプモーダル (#helpModal) 全タブ詳細テキスト・テーブル・FAQ
    '基本操作から応用整理、スマホ・USB運用までをまとめた操作ガイド':
      'Operation guide covering basic culling, advanced organization, and mobile / USB workflows',
    'Basic編 (基本操作)': 'Basics',
    'Advance編 (応用・整理)': 'Advanced & Lab',
    'Tetheract Photo Manager — 非破壊・ローカル完結の写真閲覧・選別ツール':
      'Tetheract Photo Manager — Non-Destructive, Local-First Photo Viewer & Culling Tool',
    '大量の写真（JPEG / PNG / WebP / HEIC および各社カメラの RAW データ）を、元のファイルを変更することなく軽快に閲覧・選別・整理できるビューアです。':
      'Browse, compare, and organize large collections of photos (JPEG, PNG, WebP, HEIC, and RAW files from major camera brands) smoothly without modifying your original files.',
    '目的に合わせて上部の「Basic編」「Advance編」「Mobile & USB編」「ショートカット & FAQ」タブを切り替えてご覧ください。':
      'Switch between the "Basics", "Advanced & Lab", "Mobile & USB", and "Shortcuts & FAQ" tabs above according to your needs.',
    '元ファイルには一切手を触れない（完全非破壊）': '100% Non-Destructive (Original Files Untouched)',
    'アプリ内で写真を回転したり、傾きや明るさを調整したり、「棄（ボツ）」の評価を付けても、PC内の元ファイルは1バイトも変更・削除されません。いつでも元の状態に戻せます。':
      'Rotating photos, adjusting horizon or brightness, or marking shots as "Rj (Reject)" never modifies or deletes a single byte of your original files on disk. You can revert anytime.',
    '写真の外部送信なし（ローカル完結動作）': 'No External Photo Uploads (Local-First Operation)',
    '写真を外部のクラウドやサーバーへ送信することは一切ありません。AIによる自動タグ付けや撮影場所（都道府県・市区町村）の判定もすべてPC内部だけで完結します（地図の背景タイル表示時のみ OpenStreetMap に接続します）。':
      'Your photos are never uploaded to any external cloud or server. Local AI auto-tagging and reverse geocoding (Country, Prefecture/State, City) run entirely on your PC (only map background tiles connect to OpenStreetMap).',
    '数字キーによる4段階の片手選別': 'One-Handed 4-Tier Culling with Number Keys',
    '数字キーの 1（優）、2（良）、3（棄）、0（可）を押すだけで視線を外さずに仕分けられます。「棄」にした写真は一覧から自動で隠れ、いつでも再表示や取り消しが可能です。':
      'Press number keys 1 (Ex), 2 (Gd), 3 (Rj), or 0 (Nm) to rate photos without taking your eyes off the screen. Rejected photos hide automatically from the grid and can be revealed or restored anytime.',
    '連写・ブラケット・重複写真のスタック表示': 'Smart Stacking for Bursts, Brackets & Duplicates',
    '連写や露出ブラケット、別フォルダにある同一写真のコピーを自動で1つの束（スタック）に集約します。拡大表示中に上下の矢印キーでコマを切り替え、上部の「代表」ボタンで表紙を変更できます。':
      'Automatically groups continuous bursts, exposure brackets, and duplicate copies across folders into a single stack. Use the Up/Down arrow keys in Lightbox to flip through frames and click the top "Primary" button to change the cover shot.',
    '傾き・切り抜き・トーン調整と一括書き出し': 'Non-Destructive Crop, Straighten, Tone & Batch Export',
    '水平線の傾き補正（Cキー）や露出調整を非破壊で行い、「スマート・テイクアウト」でリサイズや撮影順の連番リネーム、EXIF消去を適用して別フォルダへ一括出力できます。':
      'Adjust horizon tilt (C key) and exposure non-destructively, then batch-export via "Smart Takeout" with resizing, chronological sequential renaming, and EXIF stripping into a separate folder.',
    'USBポータブル運用とスマホでの選別': 'USB Portable Workflow & Smartphone Culling',
    '大容量の元写真は自宅に置いたままカタログ（USB）だけを持ち歩けます。自宅Wi-Fi（QRコード）や外出先のUSB接続で、スマホの親指操作で選別してPCへ同期できます。':
      'Leave large original files at home and carry only the USB catalog. Cull with your thumb on a smartphone via home Wi-Fi (QR code) or offline USB connection, then sync back to your PC.',
    '用途に合わせて選べる3つの表示レイアウト': 'Three View Layouts for Any Workflow',
    '画面上部のスリムヘッダーから、3つの表示モードを切り替えられます。右側の「和紙 / 夜墨」ボタンで明暗テーマの切り替え、「JP / EN」ボタンで日本語・英語表示の切り替えも行えます。':
      'Switch between three layout modes from the top slim header. Use the "Washi / Urusi" button on the right to toggle light and dark themes, and "JP / EN" to switch between Japanese and English.',
    '正方形の枠に整然と並ぶ標準モードです。ファイル名や日付も見やすく、大量の写真を素早く探すのに適しています。':
      'Standard mode with uniform square frames. Easy to read filenames and dates when browsing large libraries.',
    '写真本来の縦横比をそのまま活かし、隙間なく並べるモードです。構図や全体の雰囲気を見渡せます。':
      'Preserves each photo\'s original aspect ratio in a clean, gapless layout so you can overview composition and mood.',
    'フィルムのスライドマウント枠を再現した鑑賞モードです。情報表示（Iキー）をオフにすれば余白枠だけで写真を眺められます。':
      'Viewing mode modeled after reversal film slide mounts. Turn off text overlays (I key) to view photos in clean mat frames.',
    '基本の4ステップ': 'Basic 4-Step Workflow',
    '左サイドバー「フォルダ」から写真が入ったフォルダをクリックします。':
      'Click a folder containing photos under "Folders" in the left sidebar.',
    '1（優）・2（良）・3（棄）・0（可）キーで片手で仕分けます。':
      'Rate photos one-handed using the 1 (Ex), 2 (Gd), 3 (Rj), and 0 (Nm) keys.',
    'Spaceキーで拡大し、マウスホイールでピントや表情を確認します。':
      'Press Space to open Lightbox and scroll the mouse wheel to check focus and expressions.',
    '選んだ写真を「テイクアウト」で書き出すか、外部の現像ソフトへ渡します。':
      'Export selected photos via "Takeout" or open them in your external RAW editor.',

    // タブ1: Basic編
    '1. 起動と終了のしかた（2つの閉じかた）': '1. Launching & Closing (Two Ways to Exit)',
    '起動：フォルダ内の Tetheract.exe をダブルクリックすると専用ウィンドウが開きます。':
      'Launch: Double-click Tetheract.exe in the folder to open the dedicated application window.',
    '※初回起動時に SmartScreen の確認画面が出た場合や Tetheract.exe が見当たらない場合は、フォルダ内の Build.bat をダブルクリックすると、お使いのPC上でソースコードから Tetheract.exe が生成されてそのまま起動します。':
      '* If a Windows SmartScreen prompt appears on first launch or Tetheract.exe is missing, double-click Build.bat in the folder to compile Tetheract.exe locally from source code and launch immediately.',
    '完全終了（USBを抜く前など）：画面右上の「終了」ボタン →「サーバーを停止して終了」を選びます。':
      'Complete Exit (before unplugging USB, etc.): Click the top-right "Exit" button → "Stop Server & Exit".',
    'ウィンドウだけ閉じる（待機状態）：ウィンドウ右上の「×」で閉じるとタスクトレイに待機し、次回起動時に素早く画面が復元します（タスクトレイのアイコンを右クリックして完全終了することもできます）。':
      'Close Window Only (Standby): Clicking the top-right "×" keeps the server on standby in the system tray for instant reopening next time (you can also right-click the tray icon to stop the server completely).',
    '2. 写真フォルダを登録する・更新する': '2. Registering & Refreshing Photo Folders',
    '新しく登録する：左サイドバーの「フォルダ」を開き、PCや外付けドライブのツリーから写真フォルダをクリックします。「子フォルダを含む（推奨）」か「直下のみ」を選ぶと、進行バーが表示されて読み込みが始まります。':
      'Register a Folder: Open "Folders" in the left sidebar and click a photo folder in your PC or external drive tree. Select "Include Subfolders (Recommended)" or "Direct Only" to start scanning with a progress bar.',
    '写真を追加・削除したあと：登録済みのフォルダを左サイドバーでクリックすると、変化を検知して「フォルダの内容が更新された可能性があります。リフレッシュしますか？」と確認画面が出るので、OKを押して更新します。':
      'After Adding or Deleting Photos: Click the registered folder in the left sidebar. The app detects changes and asks whether to refresh the folder contents; click OK to update.',
    '3. 写真の選別（4段階評価）と矢印キー移動': '3. Culling Photos (4-Tier Rating) & Arrow Key Navigation',
    '一覧画面でも拡大画面でも、矢印キー（← / → / ↑ / ↓）で前後・上下の写真へ移動でき（Shift + 矢印キーで範囲選択）、そのまま数字キーを押して評価を付けられます。':
      'In both Grid and Lightbox views, use the arrow keys (← / → / ↑ / ↓) to move between photos (hold Shift + arrow keys for range selection) and press the number keys to assign ratings.',
    '1 キー：優 (Ex) — 現像や出力に残したい最優秀カット':
      '1 Key: Ex (Excellent) — Top picks to develop, print, or share',
    '2 キー：良 (Gd) — 残しておきたいお気に入り・合格カット':
      '2 Key: Gd (Good) — Keeper and favorite shots',
    '3 または X キー：棄 (Rj) — ピンボケや目つぶりなどのボツ写真（一覧から自動で隠れ、次の写真へ移動します）':
      '3 or X Key: Rj (Reject) — Out-of-focus or blinked shots (automatically hidden from the grid, advancing focus to the next photo)',
    '0 または 4 キー：可 (Nm) — 評価なし（初期状態）に戻す':
      '0 or 4 Key: Nm (Normal) — Clear rating and return to the initial unrated state',
    '「棄」にした写真を見返すには：ファイル自体は削除されていません。左メニュー最上部の評価フィルタにある「棄」ボタンをクリックして点灯させると再表示され、0キーで元の状態に戻せます。また、そのすぐ上にある種別フィルタ（すべて / RAW / 調整済 / 詳細...）で、RAWのみ・JPEGのみ・RAW+JPGペア・XMPありの写真だけを絞り込めます。':
      'Viewing Rejected Photos Again: Original files are never deleted. Click the "Rj" rating filter button at the top of the left menu to reveal rejected photos, and press 0 to restore them. Use the Type filter bar right above it (All / RAW / Edited / More...) to filter by RAW only, JPEG only, RAW+JPG pairs, or photos with XMP sidecars.',
    '4. 拡大してピントを確認する（ライトボックス）': '4. Inspecting Focus in Full Screen (Lightbox)',
    '一覧の写真（または右インスペクタの 4:3 プレビュー）をダブルクリックするか、写真を選んで Space / Enter キーを押すと全画面で拡大表示します（各社RAWファイルもそのままフルサイズ表示されます）。':
      'Double-click a photo in the grid (or the 4:3 preview in the right Inspector), or select a photo and press Space / Enter to open Lightbox (camera RAW files also display at full size).',
    '前後の写真へ移動：左右の矢印キー（← / →）または画面下部のフィルム帯でマウスホイールを回します。':
      'Previous / Next Photo: Press the Left / Right arrow keys (← / →) or scroll the mouse wheel over the bottom filmstrip.',
    '連写・ブラケット・重複の切替と代表設定：上下の矢印キー（↑ / ↓）で束内のコマを切り替えます（露出ブラケット時は ↑ で明るいEV+ / ↓ で暗いEV-、連写時は前後のコマへ移動）。上部ツールバーの評価ボタン左隣にある「代表」ボタンをクリックすると、今見ているコマをスタックの代表写真（表紙）に設定できます。':
      'Switch Stack Frames & Set Primary: Press the Up / Down arrow keys (↑ / ↓) to switch frames inside a stack (in exposure brackets, ↑ shows brighter EV+ and ↓ shows darker EV-; in bursts, moves to earlier/later frames). Click the "Primary" button to the left of the rating buttons in the top toolbar to set the current frame as the stack cover.',
    'ピント拡大チェック：確認したい場所にカーソルを合わせてマウスホイールを回すと、その位置を中心に 100%〜400% まで拡大します（ドラッグで移動、ダブルクリックで 100% ⇔ 200% 切替）。':
      'Focus Zoom Check: Point the cursor where you want to inspect and scroll the mouse wheel to zoom from 100% to 400% centered on the cursor (drag to pan, double-click to toggle 100% ⇔ 200%).',
    '90度回転：Rキー（時計回り）/ Lキー（反時計回り）で写真の向きを回転できます。':
      '90° Rotation: Press R (clockwise) or L (counter-clockwise) to rotate the photo non-destructively.',
    '閉じる：もう一度 Space キーまたは Esc キーを押します。':
      'Close: Press Space again or press Esc.',
    '5. 複数の写真をまとめて操作する・絞り込み検索': '5. Batch Operations & Search Filters',
    '複数選択：Ctrl + クリックで追加選択、Shift + クリックで範囲選択、Ctrl + A で全選択できます。複数枚を選ぶと、右インスペクタの一括編集パネルや右クリックメニューから、まとめて評価付け・タグ付け・回転・テイクアウト・日時シフト補正が行えます。':
      'Multi-Select: Use Ctrl + Click to add/toggle, Shift + Click for range selection, and Ctrl + A to select all. When multiple photos are selected, use the batch panel in the right Inspector or the right-click menu to batch-rate, tag, rotate, export, or shift timestamps.',
    '写真を探す：左サイドバーの「年月」「機材（カメラ ＞ レンズ階層ツリーと [+] 含む / [-] 除外検索）」「ラボ」、および一番下の「検索」で絞り込めます。フィルタ適用中は写真グリッドを一切上下にずらさず、画面下部にフローティングのフィルタフッターバーが現れ、条件が自然な日本語文（「または」「かつ」「除く」）として表示されます。フッター内の条件ピルを左クリックするとその場で条件の変更・追加ポップオーバーが開き、右クリックで含む[+]⇔除外[-]を反転、×で個別解除、「すべて解除」で全解除できます。':
      'Finding Photos: Filter by "Date", "Gear (Camera > Lens hierarchy with [+] Include / [-] Exclude)", "Lab", or "Search" at the bottom of the left sidebar. While filters are active, a floating filter footer bar appears at the bottom without shifting the photo grid, displaying conditions as natural clauses (OR / AND / Except). Left-click any pill in the footer to open a quick-change popover in place, right-click to flip Include [+] ⇔ Exclude [-], click × to remove, or click "Clear All" to reset.',

    // タブ2: Advance編
    '1. 連写・露出ブラケット・重複写真のスタック表示と2枚比較（Duel）':
      '1. Smart Stacking (Burst / AEB / Duplicates) & 2-Up Comparison (Duel)',
    '上部ヘッダーの「スタック」ボタンがONのとき、連写・露出ブラケット（AEB）・別フォルダにある同一写真の重複コピーを自動で1つの束にまとめ、代表の1枚だけを表示します。':
      'When the "Stack" button in the top header is ON, continuous bursts, exposure brackets (AEB), and duplicate copies across folders are grouped into a single stack showing only the primary photo.',
    '束の中身を見比べる：ライトボックス（Spaceキー）を開き、上下の矢印キー（↑ / ↓）や下部のミニサムネイルバーで比較できます。':
      'Compare Frames in a Stack: Open Lightbox (Space key) and use the Up / Down arrow keys (↑ / ↓) or the bottom mini-thumbnail bar to compare frames.',
    '2枚並べて比較（Duel / Vキー）：キーボードの V キー、右クリックメニューの「2枚並べて比較 (V)」、左サイドバー「ラボ」の「2枚比較」、またはライトボックス上部の「隣と比較」ボタンを押すと、2枚の写真を左右に並べて同期ズーム＆ドラッグ移動でピントや描写を見比べられます。Wキーで右(B)の写真を左(A:基準)に残して次の候補へ進む勝ち抜き選別や、Sキーでの左右入れ替え、Hキーでの左右同時ヒストグラム表示に対応しています。':
      '2-Up Side-by-Side Comparison (Duel / V Key): Press V, select "Compare 2 Photos (V)" from the right-click menu, click "2-Photo Duel" in Lab, or click "Compare Next" in Lightbox to inspect two photos side-by-side with synchronized zoom and pan. Press W for knockout selection (promoting Right B to Left A and advancing to the next candidate), S to swap left and right, or H to view dual histograms.',
    '代表（表紙）を変える：ライトボックス上部（評価ボタンの左隣）の「代表」ボタン、または右インスペクタの「代表に設定」を押すと、現在表示しているコマを表紙に変更できます。':
      'Change Primary (Cover) Photo: Click the "Primary" button in the top Lightbox toolbar (left of the rating buttons) or "Set as Primary" in the right Inspector to make the current frame the cover shot.',
    '重複写真の確認：別フォルダに同じ写真がある場合はサムネイル右上角に折り目マークが付きます。左サイドバー「クイック」の「重複のある写真」から一覧表示し、右インスペクタで保存先フォルダを確認できます。':
      'Check Duplicates: Photos with identical copies in other folders display a corner-fold mark at the top-right of the thumbnail. Click "Duplicate Photos" under "Quick" in the left sidebar to list them and check all file paths in the right Inspector.',
    '2. 階層タグ・色ラベル・ローカルAI自動分類と排他検索':
      '2. Hierarchical Tags, Color Labels, Local AI Tagging & Exclusive Search',
    '階層タグとタグツリーエディタ：タグ入力時に「旅行/2026北海道/小樽」のようにスラッシュ（/）で区切ると親子ツリーとして整理されます。左サイドバー「タグ」の「枚数順」ボタンで枚数順と名前順を切り替えられるほか、「設定」（または右インスペクタの「ツリー編集」）の「タグツリーエディタ」でドラッグ＆ドロップによる階層組み替え・名前変更・削除が行えます。':
      'Hierarchical Tags & Tag Tree Editor: Separate tag names with slashes (e.g. "Travel/2026-Hokkaido/Otaru") to organize them into a parent-child tree. Toggle between count order and name order with the "By Count" button in the Tags sidebar, and reorganize hierarchies via drag-and-drop, rename, or delete tags inside the dedicated "Tag Tree Editor" in Settings.',
    '色合い（12色パレット）：右インスペクタの「色合い」で写真にカラーラベルを登録し、左サイドバー「タグ」上部の「カラー」から色別に絞り込めます（右クリックでその色を除外）。':
      'Color Palette (12 Colors): Assign color labels under "Color" in the right Inspector and filter by color from the palette at the top of the "Tags" sidebar (right-click a color to exclude it).',
    'ローカルAI自動タグ付け：左サイドバーのフォルダを右クリックして「AIタグ付け」を選ぶと、ネット通信なしでPC内のAI（CLIP）が「青空」「海」「猫」「料理」「夜景」などのタグを自動付与します。':
      'Local AI Auto-Tagging: Right-click a folder in the left sidebar and select "AI Auto-Tag" to have the local on-device AI (CLIP) assign tags such as Blue Sky, Sea, Cat, Food, and Night View offline.',
    'タグ・機材の [+] 含む / [-] 除外検索と道標表示：タグツリーの一番上の親（1階層目）同士を [+] にすると「しかも（AND）」で絞り込まれ、同じ親の下にある2階層目以降の子タグを複数 [+] にすると「または（OR）」で候補が追加されます。見たくない子タグは右クリックで [-]（除外）を明示して引き算できるため、「トヨタ [+]・プリウス [-]・ロードスター [+]」のように選べば「プリウス以外のトヨタ車とロードスター」を簡単に抽出できます。親階層を閉じていても、配下の子項目でフィルタが有効な場合は破線枠と件数バッジ（+1 / -1）の道標が表示されます。':
      'Tag & Gear [+] Include / [-] Exclude Search & Trail Indicators: Top-level (1st-tier) tags set to [+] are combined with AND, while 2nd-tier and deeper child tags under the same root are combined with OR to expand candidates. Right-click unwanted child tags to set [-] (Exclude) and subtract them—for example, selecting "Toyota [+], Prius [-], Roadster [+]" easily extracts "all Toyotas except Prius, plus Roadster". When a parent node is collapsed while a child filter is active, a dashed border and count badge (+1 / -1) indicate the active filter path.',
    '3. 傾き補正・切り抜き・トーン調整とリアルタイムヒストグラム（非破壊）':
      '3. Horizon Leveling, Crop, Tone Adjustments & Live Histogram (Non-Destructive)',
    '写真を選んで C キー（または右インスペクタ・ライトボックスの「調整」ボタン）を押すと、元ファイルを一切書き換えずに以下の調整が行えます。':
      'Select a photo and press the C key (or click the "Adjust" button in the right Inspector or Lightbox) to perform the following adjustments without modifying the original file.',
    '切り抜き（アスペクト比）：元の比率、1:1、16:9、4:3、3:2、自由サイズから選んで構図を調整できます（三分割ガイド線付き）。':
      'Crop (Aspect Ratio): Choose from Original, 1:1, 16:9, 4:3, 3:2, or Free ratio to adjust framing with a rule-of-thirds grid.',
    '傾き補正（水平出し）：スライダーで水平線の傾きを補正します（四隅に黒い隙間が出ないよう自動で内側を切り抜きます）。':
      'Straighten (Horizon Leveling): Fine-tune tilt angle with the slider (automatically constrains the crop box so black corners never appear).',
    '明るさ・コントラスト・彩度とヒストグラム（Hキー）：露出補正感覚（-2.0EV〜+2.0EV、1/3段ステップ）で明るさや色味を微調整すると、RGB・輝度ヒストグラムがリアルタイムに連動します。Hキー（または右インスペクタの「波形」ボタン）でいつでもヒストグラムを開閉できます。':
      'Exposure, Contrast, Saturation & Histogram (H Key): Adjust brightness (-2.0EV to +2.0EV in 1/3-stop steps), contrast, and saturation while watching the RGB & Luminance histogram update in real time. Press H (or the "Waveform" button in the Inspector) anytime to toggle the histogram.',
    '元画像との比較（Before / After）と一括ペースト：調整画面右上の「元画像と比較 (\\)」ボタン（または \\ / Space キー）を押している間だけ無加工の元画像を表示して見比べられます。また、調整したトーン3項目（明るさ・コントラスト・彩度）を Ctrl + Shift + C でコピーし、他の写真へ Ctrl + Shift + V で一括ペーストできます。':
      'Before / After Comparison & Batch Tone Paste: Hold the "Compare Original (\\)" button (or hold \\ / Space) to temporarily view the unedited original image. Copy the three tone settings (Exposure, Contrast, Saturation) with Ctrl + Shift + C and batch-paste them onto other photos with Ctrl + Shift + V.',
    'XMPサイドカー連携：同名の .xmp / .pp3 / .dop サイドカーファイルがある写真では、右インスペクタ上部の「XMPプレビュー」ボタンを押している間だけ現像パラメータを反映して比較できます。「評価・タグ取込」ボタンから、XMP内の評価や階層タグ（既存のタグと混ざらない XMP/... 階層へ隔離）を取り込むことも可能です。':
      'XMP Sidecar Integration: When a companion .xmp, .pp3, or .dop sidecar file exists, hold down "XMP Preview" in the right Inspector to temporarily preview its development parameters. Click "Import Rating & Tags" to import XMP ratings and hierarchical keywords into an isolated XMP/... tag branch.',
    'スライダーのダブルクリックや下部の「リセット」ボタンから、いつでも初期状態に戻せます。':
      'Double-click any slider or click "Reset" at the bottom to restore the original unedited state anytime.',
    '4. ジオタグ・47都道府県マップ・スマホGPS準用・撮影日時シフト補正':
      '4. Geotags, 47-Prefecture Map, Phone GPS Matching & Capture Time Shift',
    '場所ツリー：GPS情報付き写真は、左サイドバー「ジオタグ」から「国 ＞ 都道府県 ＞ 市区町村」の階層で絞り込めます。':
      'Location Tree: Filter GPS-tagged photos by "Country > Prefecture/State > City" under "Geotags" in the left sidebar.',
    '47都道府県 撮影制覇白地図・ヒートマップ・さんぽ軌跡：左サイドバー「ジオタグ」上部の「制覇マップ」ボタンから、都道府県ごとの撮影枚数塗り分け白地図、よく訪れる場所の撮影密度ヒートマップ、日付ごとの移動ルートを結ぶ「撮影さんぽ軌跡」を表示できます。':
      '47-Prefecture Conquest Map, Heatmap & Walk Trajectory: Click "Conquest Map" at the top of the "Geotags" sidebar to view the 47-prefecture choropleth map, shooting density heatmaps, and chronological photo-walk route lines by date.',
    'スマホから位置情報を引き継ぐ（スマホGPS準用）：GPSのないカメラで撮った写真でも、前後1時間以内に撮影したスマホ写真がライブラリにあれば、右インスペクタまたは右クリックメニューの「スマホGPS準用」から位置情報を引き継げます。':
      'Match Location from Smartphone Photos (Phone GPS Sync): For photos taken with a camera without GPS, if your library contains a smartphone photo taken within ±1 hour, use "Infer GPS from Phone" in the right Inspector or context menu to copy its location.',
    '撮影日時の一括シフト補正：カメラの内蔵時計ズレや海外旅行の時差がある場合は、右クリックメニュー（または右インスペクタ）の「撮影日時を一括補正...」から、元ファイルを書き換えずに日・時間・分・秒のオフセット補正（および元のEXIF日時への復元）が行えます。':
      'Batch Capture Time Shift: To fix camera clock drift or travel timezone differences, select "Batch Shift Capture Time..." from the context menu (or right Inspector) to non-destructively offset timestamps by Days/Hours/Min/Sec (with one-click restore to original EXIF time).',
    '5. スマート・テイクアウトとベタ焼き（コンタクトシート）HTML出力':
      '5. Smart Takeout & Contact Sheet (Betayaki) HTML Export',
    '右クリックメニュー（または右インスペクタ）の「テイクアウト」から、2種類の出力機能を利用できます（元ファイルは変更されません）。':
      'From "Takeout" in the right-click menu (or right Inspector), choose between two export options (original files remain untouched).',
    'スマート・テイクアウト：非破壊で行った回転・傾き・切り抜き・トーン調整の反映、GPS・向きのEXIF同期、XMPサイドカー（.xmp）の同時出力、長辺リサイズ（4K / フルHD / 軽量等）、撮影秒数順の連番リネーム、SNS公開用のEXIF消去を一括適用して別フォルダへ書き出します。':
      'Smart Takeout: Batch-exports copies into a separate folder with non-destructive rotation/tilt/crop/tone edits baked in, GPS & orientation EXIF synced, optional companion .xmp sidecars, long-edge resizing (4K / FHD / Web), chronological sequential renaming, and EXIF privacy scrubbing.',
    'ベタ焼きHTML出力：選んだ写真を暗室コンタクトシート風（または和紙台紙風）の単一HTMLファイルとして出力します。ブラウザで開いて写真をクリックすると赤鉛筆の丸印を付けられ、A4サイズ等での一覧印刷にも対応しています。':
      'Contact Sheet (Betayaki) HTML Export: Outputs selected photos into a single self-contained HTML file styled like a darkroom negative sheet (or Washi mount). Open it in any browser to toggle red grease-pencil circle marks and print clean A4 index sheets.',
    '6. ラボ：勝ちレンズカルテ・太陽高度抽出・歴代の今日・未整理ガチャ':
      '6. Photography Lab: Winning Lens Chart, Solar Elevation, On This Day & Folder Gacha',
    '左サイドバーの「ラボ」では、蓄積された写真データから撮影傾向の分析や過去写真の発掘を行えます。':
      'The "Lab" section in the left sidebar provides tools to analyze your shooting tendencies and rediscover past photos.',
    '勝ちレンズ・得意設定カルテ：これまでの評価（優・良）データから、高評価率（歩留まり）が高いレンズ・カメラや、よく使う焦点距離・F値・撮影時間帯を集計します。':
      'Winning Lens & Sweet-Spot Chart: Aggregates your Ex and Gd ratings to show lenses and cameras with high keeper rates, along with your favored focal lengths, apertures, and shooting hours.',
    '太陽高度・露出ラボ抽出：撮影日時とGPS座標から太陽の角度を計算し、マジックアワー（-4°〜+6°）、ブルーアワー（-8°〜-4°）、夜景・星景（-8°未満）、およびシャッター速度が 1/焦点距離 秒より遅い「手ブレ注意」の写真を抽出します。':
      'Solar Elevation & Exposure Lab: Calculates the sun\'s elevation angle from capture time and GPS coordinates to extract Golden Hour (-4° to +6°), Blue Hour (-8° to -4°), Night/Astro (<-8°), and slow-shutter shake candidates (shutter speed slower than 1/focal_length sec).',
    '歴代の今日・記念日と未整理ガチャ：過去の同じ月日に撮った写真を振り返る機能や、まだ評価を付けていない写真が残っているフォルダをランダムに1つ開く「未整理ガチャ」を使えます。':
      'On This Day & Unrated Folder Gacha: Look back at photos taken on the same calendar date across past years, or open a random folder that still has unrated photos.',
    '7. プリセット保存・外部ソフト連携・storage管理・DBメンテナンス':
      '7. Filter Presets, External Apps, In-App "storage" & DB Maintenance',
    'プリセット保存：よく使う絞り込み条件は、左サイドバー「クイック」下部の保存フォームで名前を付けて保存し、ワンクリックで呼び出せます。':
      'Filter Presets: Save frequently used filter combinations with a custom name at the bottom of the "Quick" sidebar panel for one-click recall.',
    '外部ソフト連携とサムネイル更新：右インスペクタ上部のアイコンからエクスプローラーで保存先を開いたり、既定のソフトでファイルを開けます。外部ソフトで編集したあとは、右クリックメニューの「サムネイルを更新」で表示を最新化できます。':
      'External App Integration & Refresh Thumbnail: Use the icons at the top of the right Inspector to reveal the file in Explorer or open it in your default application. After editing in an external tool, right-click the photo and select "Refresh Thumbnail".',
    '設定とDBメンテナンス：画面右上の「設定」ボタンから、起動時のウィンドウサイズやタグの名前順ルールの変更、世代バックアップ付きデータベース最適化（VACUUM）が行えます。':
      'Settings & DB Maintenance: Click "Settings" at the top-right to configure startup window size, tag sorting rules, and database optimization (VACUUM) with automatic rotating backups.',
    'storage（アプリ内ストレージ）管理：左サイドバー「フォルダ」先頭の「storage」には、外部フォルダの写真を「storageへインポート」（またはドラッグ＆ドロップ）でコピー取り込みできます。storage内ではサブフォルダ作成・移動・ファイル名変更（F2キーで単一または一括連番リネーム）・外部エクスポートが行え、同名のサイドカーファイル（.xmp等）やペアRAWも自動で追従します。':
      'In-App "storage" Management: Copy photos from external folders into "storage" at the top of the "Folders" sidebar via "Import to storage" (or drag-and-drop). Inside storage, you can create subfolders, move photos, rename files (F2 for single or batch sequential rename), and export folders while companion sidecars (.xmp, etc.) and paired RAW files follow automatically.',

    // タブ3: Mobile & USB編
    '1. USBメモリ・外付けSSDでの3つの持ち歩きスタイル':
      '1. Three Portable Workflows with USB Flash Drives & External SSDs',
    'スタイル1（写真もアプリもUSBに入れる）：Tetheract フォルダと写真（または storage）をUSBドライブに入れておけば、別のPCに挿して Tetheract.exe を開くだけで同じ環境で使えます。':
      'Style 1 (App + Photos on USB): Keep both the Tetheract folder and your photos (or storage/) on a USB drive so you can plug it into any PC and run Tetheract.exe with the exact same environment.',
    'スタイル2（元写真は自宅に置きカタログだけ持ち歩く）：大容量の元写真は自宅のHDDに置いたまま、Tetheract が入ったUSBメモリだけを持ち歩けます。元写真が未接続でも、全写真のサムネイル閲覧・評価・タグ付けが行えます。':
      'Style 2 (Leave Original Files at Home, Carry Only the USB Catalog): Leave large RAW libraries on your home HDD and carry only the USB drive containing Tetheract. Even while original files are disconnected, you can browse all thumbnails, rate, and tag.',
    'スタイル3（ドライブ文字が変わっても自動追従）：別のPCに繋いでドライブ文字（D: → E: 等）が変わっても、ドライブ固有の識別番号を認識してリンク切れを防ぎます。':
      'Style 3 (Automatic Drive-Letter Tracking): Even if Windows assigns a different drive letter (e.g. D: → E:) on another PC, Tetheract tracks the drive\'s Volume Serial Number automatically.',
    '2. スマートフォンで写真を選別する（2つの方法）':
      '2. Two Ways to Cull Photos on a Smartphone',
    'スマートフォンの画面と親指のタップ操作で、写真の4段階評価（優・良・可・棄）とタグ付けが行えます。':
      'Use your smartphone screen and thumb taps to rate photos (Ex / Gd / Nm / Rj) and assign tags.',
    '方法A：自宅のWi-Fiでつなぐ（QRコードでリアルタイム連動）':
      'Method A: Connect via Home Wi-Fi (Real-Time Sync with QR Code)',
    'PC画面右上の「スマホ連携」ボタンをクリックします。':
      'Click the "Mobile" button at the top-right of the PC window.',
    '表示されたQRコードをスマートフォンのカメラで読み取ってブラウザで開きます（同じWi-Fiに接続）。QRコードには専用のアクセストークンが含まれており、閲覧・選別以外の操作は遮断されます。':
      'Scan the displayed QR code with your smartphone camera on the same Wi-Fi network. The QR code embeds an access token, and only browsing and culling operations are permitted over LAN.',
    'スマートフォンで付けた評価やタグが、そのままPC側の画面へリアルタイムに反映されます（30分間通信がない場合は、安全のためスマホ向けの待受が自動で停止します）。':
      'Ratings and tags applied on your phone are reflected on the PC screen in real time (for security, the mobile listener stops automatically after 30 minutes of inactivity).',
    '方法B：外出先・ネット圏外でUSBメモリを直接スマートフォンに挿す（完全オフライン）':
      'Method B: Plug the USB Drive Directly into Your Smartphone (100% Offline)',
    'PCの電源が切れているときやネット圏外でも使えます。Tetheract が入ったUSBメモリをAndroidスマートフォン等に挿します。':
      'Works even when your PC is off or without internet access. Connect the USB drive containing Tetheract to an Android smartphone.',
    'スマートフォンのファイルアプリでUSB内の Tetheract_Mobile.html をタップしてブラウザで開きます（USBから直接開けない機種では、このHTMLファイル1つだけをスマートフォン本体のダウンロードフォルダ等にコピーして開いてください）。':
      'Open Tetheract_Mobile.html from the USB drive in your phone\'s browser via the Files app (if your device restricts opening HTML directly from USB, copy that single HTML file to your phone\'s Downloads folder and open it there).',
    '画面の「DB読込」をタップし、USBメモリ内の cache フォルダにある library.db を選ぶと、全写真のカタログが読み込まれます。':
      'Tap "Load DB" on screen and select cache/library.db on the USB drive to load the entire photo catalog into memory.',
    '3. スマートフォンでの操作と、PCへの同期手順（USBオフライン時）':
      '3. Smartphone Operation & Syncing Back to PC (USB Offline Mode)',
    '親指ドックで選別：スマートフォンで写真をタップして拡大し、画面下部の「棄」「可」「良」「優」をタップします。「自動送り」がONならタップと同時に次の写真へ進みます。':
      'Thumb-Dock Culling: Tap a photo to open the large view and tap "Rj", "Nm", "Gd", or "Ex" at the bottom. When "Auto-Advance" is ON, rating automatically advances to the next photo.',
    'PCへの反映手順（方法Bで選別したあと）：':
      'Syncing Back to PC (after culling with Method B):',
    '選別が終わったらスマートフォン画面の「変更を保存」を押し、USBメモリの先頭（ルート）フォルダに mobile_sync.json を保存します。':
      'When finished, tap "Save Changes" on your smartphone and save mobile_sync.json to the root folder of the USB drive.',
    '保存完了メッセージから数秒待ち、スマートフォンの通知欄から「USBドライブを取り外す（マウント解除）」を実行してからUSBを抜きます。':
      'Wait a few seconds after the completion message, then select "Eject / Unmount USB drive" from your phone\'s notification bar before unplugging the USB drive.',
    'USBメモリをPCに挿して Tetheract.exe を起動すると、自動的に選別結果が取り込まれて反映されます。':
      'Plug the USB drive into your PC and launch Tetheract.exe; the saved changes are automatically detected and imported.',
    '4. USBメモリを安全に取り外すための手順':
      '4. Safely Removing Your USB Drive',
    'PCから抜く前：画面右上の「終了」＞「サーバーを停止して終了」でアプリを完全に停止させてから、Windowsの「ハードウェアの安全な取り外し」を行ってください。':
      'Before Unplugging from PC: Always stop the app completely via top-right "Exit" > "Stop Server & Exit", then use Windows "Safely Remove Hardware".',
    'スマートフォンから抜く前：mobile_sync.json を保存したあと、スマートフォンの通知欄から「取り外す（マウント解除）」を実行してから引き抜いてください（そのまま抜くと保存ファイルが空になることがあります）。':
      'Before Unplugging from Smartphone: After saving mobile_sync.json, always unmount/eject the USB drive from the notification bar before pulling it out (unplugging without unmounting may leave the saved file empty).',

    // タブ4: ショートカット & FAQ
    '機能・動作': 'Action',
    '前後・上下の写真へ移動（右インスペクタもリアルタイム追従 ／ Shift + 矢印キーで範囲選択）':
      'Move between photos (Right Inspector updates in real time / Shift + Arrow keys for range selection)',
    '選択中の写真に「優 (Ex)」を設定': 'Set rating of selected photo(s) to "Ex (Excellent)"',
    '選択中の写真に「良 (Gd)」を設定': 'Set rating of selected photo(s) to "Gd (Good)"',
    '選択中の写真に「棄 (Rj)」を設定（一覧から自動で隠れます）':
      'Set rating of selected photo(s) to "Rj (Reject)" (automatically hidden from the grid)',
    '選択中の写真の評価を取り消す（「可 (Nm)」に戻す）':
      'Clear rating of selected photo(s) (reset to "Nm (Normal)")',
    '選択中の写真を時計回りに90度（R）/ 反時計回りに90度（L）回転（非破壊）':
      'Rotate selected photo(s) 90° clockwise (R) / 90° counter-clockwise (L) (non-destructive)',
    '選択中の写真の切り抜き・傾き・トーン調整画面を開く（調整中は \\ 長押しで元画像比較）':
      'Open Crop, Straighten & Tone adjustment modal (hold \\ while editing to compare with original)',
    '選択中の写真をクリップボードへ画像コピー（調整反映済み ／ そのまま Ctrl+V で他アプリへ貼付可）':
      'Copy selected photo to clipboard with non-destructive edits applied (paste directly into other apps with Ctrl+V)',
    '写真のトーン調整（明るさ・コントラスト・彩度）をコピー（C）／ 選択写真へ一括ペースト（V）':
      'Copy tone adjustments (Exposure, Contrast, Saturation) (C) / Batch-paste onto selected photos (V)',
    'storage（アプリ内ストレージ）内の写真のファイル名を変更（1枚：単一 ／ 2枚以上：一括連番リネーム）':
      'Rename photo(s) inside in-app "storage" (1 photo: single rename / 2+ photos: batch sequential rename)',
    '2枚並べて比較（Duel）モードを開く（同期ズーム・勝ち抜き選別）':
      'Open 2-Up side-by-side comparison (Duel) mode (synchronized zoom & knockout culling)',
    'RGB・輝度ヒストグラムの表示 / 非表示を切り替え':
      'Toggle RGB & Luminance histogram display',
    '写真カード上の文字・バッジ表示を隠す / 表示する（クリーンモード切替）':
      'Show / hide text and badge overlays on photo cards (Clean View toggle)',
    '左メニューの表示 / 非表示を切り替え': 'Toggle left menu panel',
    '選択をすべて解除 ／ 開いているモーダル画面を閉じる':
      'Deselect all photos / Close active modal window',
    '操作マニュアル（本ヘルプ画面）を表示': 'Open User Manual (this Help window)',
    'ライトボックス（拡大表示）＆ 2枚比較画面でのショートカット':
      'Lightbox & 2-Up Comparison (Duel) Shortcuts',
    '前後の写真へ移動（2枚比較時は右ペインBの候補写真を切り替え）':
      'Move to previous / next photo (in 2-Up Duel, switches candidate photo in Right pane B)',
    '連写・ブラケット・重複スタック内のコマ切替（露出ブラケット時は ↑ で EV+ ／ ↓ で EV-）':
      'Switch frames inside a burst, bracket, or duplicate stack (in AEB brackets: ↑ for EV+, ↓ for EV-)',
    '表示中の写真（2枚比較時は選択中ペイン）に 優(1) / 良(2) / 棄(3) / 可(0・4) を設定':
      'Set rating on current photo (or active pane in 2-Up Duel): Ex(1) / Gd(2) / Rj(3) / Nm(0, 4)',
    'ライトボックスから2枚比較（Duel）モードを開く / 閉じる':
      'Open / close 2-Up comparison (Duel) mode from Lightbox',
    '2枚比較時：W で右(B)を左(A:基準)に昇格して次へ ／ S で左右を入れ替え':
      'In 2-Up Duel: press W to promote Right (B) to Left (A: reference) and advance / press S to swap left and right',
    'RGB・輝度ヒストグラムの表示 / 非表示を切り替え（2枚比較時は左右同時表示）':
      'Toggle RGB & Luminance histogram (displays dual side-by-side histograms in 2-Up Duel)',
    '棄（Rj）評価の ON / OFF を切り替え': 'Toggle Rj (Reject) rating ON / OFF',
    '表示中の写真を時計回りに90度（R）/ 反時計回りに90度（L）回転（非破壊）':
      'Rotate current photo 90° clockwise (R) / 90° counter-clockwise (L) (non-destructive)',
    '表示中の写真の切り抜き・傾き・トーン調整画面を開く（非破壊）':
      'Open Crop, Straighten & Tone adjustment modal for current photo (non-destructive)',
    'マウスホイール': 'Mouse Wheel',
    '画像上：カーソル位置を中心に拡大縮小（100%〜400%）／ 連写バー・下部フィルム帯上：コマ送り':
      'Over image: zoom centered on cursor (100%–400%) / Over stack bar or filmstrip: flip frames',
    'ダブルクリック': 'Double-Click',
    '拡大（200%）⇔ 等倍（100%）を切り替え': 'Toggle between 200% zoom and 100% fit',
    'ドラッグ': 'Drag',
    '拡大中の表示位置を移動（2枚比較時は左右同期パン、Alt + ドラッグで片側のみ移動）':
      'Pan while zoomed (synchronized pan in 2-Up Duel; hold Alt + Drag to move one side independently)',
    'Q. 3 キーで「棄」にしたら写真が消えました。ファイルが削除されたのですか？':
      'Q. I pressed 3 to mark a photo as "Rj (Reject)" and it disappeared. Was the file deleted?',
    'A. いいえ、PC内のファイルは削除されていません。左メニュー最上部の評価フィルタにある「棄」ボタンを押して点灯させればいつでも再表示でき、0キーで元に戻せます。':
      'A. No, files on your PC are never deleted. Click the "Rj" filter button at the top of the left menu to reveal rejected photos anytime, and press 0 to restore them.',
    'Q. 回転や明るさ調整をした写真を、実際の画像ファイルとして保存したいときは？':
      'Q. How do I save rotated or brightness-adjusted photos as actual image files?',
    'A. アプリ内の調整は元ファイルを書き換えない非破壊方式です。調整結果を反映した画像ファイルを作るには、右クリックメニューの「テイクアウト」＞「スマート・テイクアウト...」から別フォルダへ書き出してください。':
      'A. All adjustments inside the app are non-destructive. To export new image files with your adjustments applied, select "Takeout" > "Smart Takeout..." from the right-click menu.',
    'Q. 初回起動時に「Windows によって PC が保護されました」と表示されました。':
      'Q. Windows displayed "Windows protected your PC" (SmartScreen) on first launch.',
    'A. 商用のコード署名証明書を付与していない個人開発ソフトのため表示される確認画面です。「詳細情報」→「実行」で起動するか、同梱の Build.bat をダブルクリックしてPC上で Tetheract.exe を生成してください。':
      'A. This confirmation screen appears because this personal project does not have a commercial code-signing certificate. Click "More info" → "Run anyway", or double-click the included Build.bat to compile Tetheract.exe locally on your PC.',
    'さらに詳しい解説はプロジェクトフォルダ内の MANUAL.md をご覧ください。':
      'For more details, please refer to MANUAL.md in the project folder.',

    // XMP サイドカー & storage 機能 (UIツールチップ・モーダル用)
    'XMPサイドカーファイルが検出されました': 'XMP sidecar file detected',
    'XMPプレビュー': 'XMP Preview',
    '押している間だけTetheractの調整をオフにし、XMPの調整データを反映して表示します':
      'Hold to temporarily bypass Tetheract edits and preview XMP adjustments',
    '評価・タグ取込': 'Import Rating & Tags',
    'XMPサイドカーの評価（4段階変換）やタグ（XMP/ルート配下）を取り込みます':
      'Import XMP rating (converted to 4-stage) and hierarchical tags (under XMP/ root)',
    ' XMPサイドカー (.xmp) も一緒に出力する（評価・タグ・調整情報の保持）':
      ' Also export XMP sidecar (.xmp) (preserves rating, tags & adjustments)',
    '書き出し画像と一緒に評価・タグ・GPS・調整情報を記録した .xmp サイドカーファイルも出力します':
      'Exports a companion .xmp sidecar file containing rating, tags, GPS, and adjustment metadata',
    'DB管理': 'DB Maint',
    '設定・データベース管理（タグ並び順・DBバックアップ・最適化）': 'Settings & Database Maintenance (Tag Sort Order, DB Backup & VACUUM)',
    '設定 ＆ データベース管理': 'Settings & Database Maintenance',
    '表示・並び順の設定 ＆ ライブラリDBの最適化・バックアップ': 'Display & Sort Settings, Library DB Optimization & Backup',
    'タグツリーの並び順（左フィルタ ＆ 右タグエディタ共通）': 'Tag Tree Sort Order (Left Filter & Right Tag Editor)',
    '「文字コード順（24-xxx → 2410-xxx → 25-xxx）」や「数値の自然順（1 → 2 → 10）」など、好みに合わせて保存できます': 'Choose between Lexical Order (24-xxx → 2410-xxx → 25-xxx), Natural Numeric Order (1 → 2 → 10), or Photo Count',
    '文字順・昇順（例: 24-イベント → 2410-旅行 → 25-正月）': 'Lexical Ascending (e.g. 24-Event → 2410-Trip → 25-NewYear)',
    '文字順・降順（例: 25-正月 → 2410-旅行 → 24-イベント）': 'Lexical Descending (e.g. 25-NewYear → 2410-Trip → 24-Event)',
    '数値の自然順・昇順（例: 1 → 2 → 10 / 24 → 25 → 2410）': 'Natural Ascending (e.g. 1 → 2 → 10 / 24 → 25 → 2410)',
    '数値の自然順・降順（例: 2410 → 25 → 24 / 10 → 2 → 1）': 'Natural Descending (e.g. 2410 → 25 → 24 / 10 → 2 → 1)',
    '写真枚数が多い順（よく使うタグが上）': 'Most Photos First (Frequently used tags on top)',
    'タグツリーの並び順を保存・反映しました': 'Saved and applied tag tree sort order',
    'データベースのバックアップ・最適化（VACUUM）': 'Database Backup & Optimization (VACUUM)',
    'タグエディタ (付与・作成・編集)': 'Tag Editor (Assign, Create & Edit)',
    'タグエディタ (一括付与・作成・編集)': 'Tag Editor (Batch Assign, Create & Edit)',
    '付与済': 'Added',
    '+子': '+Sub',
    'その他のタグなし (右インスペクタで作成)': 'No other tags (Create in Right Inspector)',
    '付与されている写真枚数': 'Number of photos with this tag',
    'タグを全体から削除（確認）': 'Delete Tag from Entire Library (Confirm)',
    'キャンセル (NG)': 'Cancel (NG)',
    'OK (全体から削除)': 'OK (Delete Tag)',
    '起動時のウィンドウサイズ': 'Startup Window Size',
    'アプリ起動時のウィンドウ状態を設定します（選択すると即座に現在の画面にも反映されます）': 'Set initial window state on launch (selecting applies immediately to current window)',
    '最大化（標準・タスクバーあり）': 'Maximized (Standard with Taskbar)',
    '前回のサイズ・位置を記憶（システム標準）': 'Remember Previous Size & Position',
    '画面中央（約80%サイズ）': 'Center Screen (~80% Size)',
    '◧ 画面の左半分にスナップ（50%）': '◧ Snap to Left Half (50%)',
    '◨ 画面の右半分にスナップ（50%）': '◨ Snap to Right Half (50%)',
    'フルスクリーン（枠なし全画面 / F11）': 'Fullscreen (Borderless / F11)',
    '起動時のウィンドウサイズを保存・反映しました': 'Saved and applied startup window size',
    'タグツリーの名前順ルールを保存・反映しました': 'Saved and applied tag name sort rule',
    '左ペインの「 枚数順」がオフのときに使われる名前ソート順を保存します': 'Saves the name sort order used when " By Count" in the left sidebar is OFF',

    // --- シャッター速度ソート & 詳細属性フィルタ & 撮影日時一括シフト補正 ---
    'シャッター速度 (高速→低速)': 'Shutter Speed (Fast → Slow)',
    'シャッター速度 (低速→高速)': 'Shutter Speed (Slow → Fast)',
  '詳細...': 'More...',
    '撮影日時を一括補正...': 'Batch Shift Date...',
    '撮影日時の一括シフト補正': 'Batch Shift Date Taken',
    'カメラの内蔵時計ズレや海外時差を非破壊で一括補正します（元ファイルは変更されません）': 'Non-destructively shift Date Taken in DB to fix camera clock drift or timezone offset',
    '＋ 進める（未来へ）': '+ Forward (Add Time)',
    '－ 戻す（過去へ）': '- Backward (Subtract Time)',
    'シフト補正を適用': 'Apply Shift',
    '↩ 元のEXIF日時に戻す': '↩ Reset to Original EXIF Date',
    '簡易フォルダコピー (take_out/)': 'Simple Folder Copy (take_out/)',
    'シフト方向': 'Shift Direction',
    '日': 'Days',
    '時間': 'Hours',
    '分': 'Min',
    '秒': 'Sec',
    'クイックプリセット': 'Quick Presets',
    'クイックプリセット:': 'Quick Presets:',
    '変更プレビュー (先頭5件)': 'Preview (First 5 Items)',
    'シフト補正前の元のEXIF撮影日時に復元します': 'Restore to original EXIF Date Taken before shift',
    '選択中の写真にシフト補正履歴（元のEXIF日時）はありません': 'No shift history (original EXIF date) on selected photos',
    'シフトする時間（日・時・分・秒）を指定してください': 'Please specify the shift offset (days, hours, minutes, or seconds)',
    '撮影日時を補正する写真を選択してください': 'Please select photos to shift Date Taken',
    // --- v3.00 Stoic Design ＆ 追加文言同期 ---
    '24時間シャッター時間帯 ＆ 成果グラフ': '24-Hour Shutter Time & Yield Graph',
    '2枚並べて比較 (Side-by-Side)': 'Side-by-Side Comparison',
    '2枚比較': 'Compare 2 Photos',
    '47都道府県 制覇マップ': '47 Prefectures Seiha Map',
    '47都道府県 撮影制覇白地図・ヒートマップ・撮影さんぽ軌跡:': '47 Prefectures Seiha Map, Heatmap & Walking Trail:',
    'Advance編 (応用・便利機能)': 'Advance (Advanced Features)',
    'Basic編 (基本操作)': 'Basic (Basic Operations)',
    'GPS': 'GPS',
    'USBメモリを安全に抜くための鉄則': 'Rules for Safely Removing USB Drive',
    'XMP': 'XMP',
    'XMPサイドカー (.xmp) も一緒に出力する（評価・タグ・調整情報の保持）': 'Also output XMP sidecar (.xmp) (Preserve ratings, tags & adjustments)',
    'XMPサイドカー連携': 'XMP Sidecar Integration',
    'storage（アプリ内ストレージ）での完結管理 ＆ サイドカー自動追従:': 'Storage Complete Management & Auto Sidecar Tracking:',
    '① 自宅Wi-Fi: QRコードでスマホ版 (/m) に入る': '1. Home Wi-Fi: Access Smartphone Mode (/m) via QR Code',
    'カメラ・レンズ階層ツリー': 'Camera & Lens Tree',
    'クイックプリセット（時差・時計ズレ）': 'Quick Presets (Timezone & Clock Drift)',
    'シフト方向と時間量': 'Shift Direction & Amount',
    'ジオタグツリー:': 'Geotag Tree:',
    'タグツリーエディタ（構造・名前の編集専用）': 'Tag Tree Editor (Structure & Rename)',
    'トーン調整をコピー': 'Copy Tone Settings',
    'トーン調整をペースト': 'Paste Tone Settings',
    'プライバシー保護・安心のローカル動作': 'Privacy Protection & Safe Local Operation',
    'プレビュー': 'Preview',
    'ベタ焼きHTML（コンタクトシート）を出力...': 'Output Contact Sheet HTML...',
    'リアルタイムトーン波形': 'Realtime Tone Waveform',
    'リアルタイムヒストグラム': 'Realtime Histogram',
    '一括補正を適用': 'Apply Batch Correction',
    '優 (Ex)': 'Ex',
    '元画像と比較 (\\)': 'Compare with Original (\\)',
    '勝ちレンズカルテ': 'Kami-Lens Karte',
    '可 (Nm)': 'Nm',
    '太陽高度・マジックアワー抽出': 'Solar Elevation & Magic Hour Extraction',
    '子タグをここにドラッグ＆ドロップで「ルート（最上位階層）」へ独立移動': 'Drag & Drop a child tag here to promote to Root',
    '撮影日時の一括シフト補正（カメラ時計ズレ・海外時差補正）:': 'Batch Date Shift (Camera Clock & Timezone Correction):',
    '撮影日時を一括シフト補正': 'Batch Shift Shooting Date & Time',
    '操作マニュアル & ヘルプ': 'User Manual & Help',
    '日時': 'Date & Time',
    '最新化': 'Refresh',
    '棄 (Rj)': 'Rj',
    '歴代の今日': 'On This Day',
    '良 (Gd)': 'Gd',
    '色合い': 'Color Tone',
    '設定画面の「タグツリーエディタ」を開く': 'Open Tag Tree Editor in Settings',
    '除外を解除（未管理に戻す）': 'Cancel Exclusion',
    '除外検索）」「ラボ」や、「検索」で自在に絞り込めます。左端アイコンバーの通知ランプや親階層の道標バッジ（':
      'Exclude)", "Lab", or "Search". Active categories light up on the left icon rail, collapsed parents show a dashed trail badge (',
    '破線枠）で適用箇所がひと目で分かり、上部のフィルタチップをクリックすると該当ツリー位置へ自動ジャンプします。元に戻すときは左サイドバー一番上の':
      '), and clicking any active filter chip jumps straight to that item in the tree. To clear all filters, click',
    '階層タグ ＆ タグツリーエディタ:': 'Hierarchical Tags & Tag Tree Editor:',
    'スマホからアクセスできないときの設定確認（ファイアウォール・ネットワーク設定）':
      'Troubleshooting Smartphone Connection (Firewall & Network Settings)',
    '▼ クリックで開く': '▼ Click to expand',
    '【確認1】Windowsのネットワークプロファイルを「プライベート」に変更（最も多い原因）':
      '[Check 1] Set Windows Network Profile to "Private" (Most Common Cause)',
    'Windowsの「設定」＞「ネットワークとインターネット」＞「Wi-Fi（またはイーサネット）」のプロパティを開き、ネットワークプロファイルの種類が':
      'Open Windows "Settings" > "Network & internet" > "Wi-Fi (or Ethernet)" properties, and if Network profile type is set to',
    '「パブリック (Public)」': '"Public"',
    'になっている場合は': ', switch it to',
    '「プライベート (Private)」': '"Private"',
    'に切り替えてください（パブリック設定では他端末からの接続が遮断されます）。':
      ' (Public profile blocks incoming connections from other devices).',
    '【確認2】Windows Defender ファイアウォールの通信許可（TCP 8088 / python.exe）':
      '[Check 2] Allow in Windows Defender Firewall (TCP 8088 / python.exe)',
    '初回接続時のWindowsセキュリティ警告でブロックされた場合は、「Windows セキュリティ」＞「ファイアウォールとネットワーク保護」＞「ファイアウォールによるアプリケーションの許可」から、Tetheract 内の':
      'If blocked by the Windows Security prompt on first connection, open "Windows Security" > "Firewall & network protection" > "Allow an app through firewall" and allow',
    '（または詳細設定の「受信の規則」で': 'inside Tetheract (or inbound rule for',
    'TCP ポート': 'TCP port',
    '）の「プライベート」にチェックを入れて許可してください。': ') on "Private" networks.',
    '許可コマンドをコピー': 'Copy Firewall Command',
    '管理者として開いたPowerShellまたはコマンドプロンプトに貼り付けて実行すると、ファイアウォールのポート8088受信許可を追加できます':
      'Paste and run in an Administrator PowerShell or Command Prompt to allow inbound TCP port 8088 in Windows Firewall',
    '※スタートボタンを右クリック ＞「ターミナル (管理者)」または「PowerShell (管理者)」を開き、上記コマンドを貼り付けて Enter を押すと一発で許可登録できます。':
      '* Right-click the Start button > open "Terminal (Admin)" or "PowerShell (Admin)", paste the command above, and press Enter to register the rule.',
    '【確認3】同じWi-Fiルーター・ゲストSSID（プライバシーセパレーター）の確認':
      '[Check 3] Verify Same Wi-Fi Router & Guest SSID (AP Isolation)',
    'PCとスマホが同じルーターのネットワークに接続されているか確認してください。ゲスト用SSID（':
      'Make sure your PC and phone are connected to the same Wi-Fi router. Guest SSIDs (e.g.',
    '等）やモバイルルーター等の「プライバシーセパレーター（ネットワーク分離機能）」が有効な環境では端末間通信が遮断されます。設定変更が難しい場合は、下の':
      ') or routers with "AP Isolation / Privacy Separator" enabled block device-to-device connections. If network settings cannot be changed, use',
    '「② USB持ち出し選別」': '"2. USB Portable Sorting"',
    'ならネットワーク設定不要で確実に利用できます。': 'below—it works 100% offline without any network configuration.',
    'ファイアウォール許可コマンドをコピーしました（管理者PowerShell等で実行してください）':
      'Copied Firewall command (run in Administrator PowerShell / Terminal)',
    '※QRコードを読み取ってもスマホから繋がらない場合は、(1) Windowsの「設定 ＞ ネットワークとインターネット ＞ Wi-Fi（またはイーサネット）」でネットワークプロファイルを「パブリック」から「プライベート」に変更する、(2)「Windows Defender ファイアウォール」で':
      '* If scanning the QR code cannot connect: (1) Change your Windows network profile from "Public" to "Private" under Settings > Network & internet > Wi-Fi/Ethernet, (2) Allow',
    '（または TCP ポート': '(or TCP port',
    '）のプライベート通信を許可する、(3) ゲスト用SSIDやプライバシーセパレーター（端末間分離）でない同じWi-Fiルーターに接続しているかを確認してください（スマホ連携画面内にも詳しい手順と許可コマンドがあります）。':
      ') on Private networks in Windows Defender Firewall, and (3) Ensure both devices are on the same router without Guest SSID / AP Isolation (detailed steps and a one-line firewall command are available inside the Mobile modal).',
    'かつ': 'AND',
    'または': 'or',
    'または (OR)': 'OR',
    'かつ (AND)': 'AND',
    '同グループ内の結合:': 'Within this group:',
    '別グループとの結合:': 'Between tag groups:',
    'を除く': 'excluded',
    '（除く:': '(Except:',
    '異グループ間: OR検索（いずれかのタグ条件に一致）\nクリックで「かつ (AND)」に戻す':
      'Between tag groups: OR search (match any group)\nClick to switch back to "AND"',
    '異グループ間: AND検索（両方のタグ条件に一致）\nクリックで「または (OR)」に切り替える':
      'Between tag groups: AND search (match all groups)\nClick to switch to "OR"',
  };

  const MONTH_NAMES_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  const PREF_ROMAJI_MAP = {
    '北海道': 'Hokkaido', '青森': 'Aomori', '秋田': 'Akita', '岩手': 'Iwate', '山形': 'Yamagata', '宮城': 'Miyagi', '福島': 'Fukushima',
    '群馬': 'Gunma', '栃木': 'Tochigi', '茨城': 'Ibaraki', '埼玉': 'Saitama', '東京': 'Tokyo', '千葉': 'Chiba', '神奈川': 'Kanagawa',
    '石川': 'Ishikawa', '福井': 'Fukui', '富山': 'Toyama', '新潟': 'Niigata', '岐阜': 'Gifu', '長野': 'Nagano', '愛知': 'Aichi', '山梨': 'Yamanashi', '静岡': 'Shizuoka',
    '兵庫': 'Hyogo', '京都': 'Kyoto', '滋賀': 'Shiga', '大阪': 'Osaka', '奈良': 'Nara', '三重': 'Mie', '和歌山': 'Wakayama',
    '島根': 'Shimane', '鳥取': 'Tottori', '広島': 'Hiroshima', '岡山': 'Okayama', '山口': 'Yamaguchi',
    '愛媛': 'Ehime', '香川': 'Kagawa', '高知': 'Kochi', '徳島': 'Tokushima',
    '長崎': 'Nagasaki', '佐賀': 'Saga', '福岡': 'Fukuoka', '熊本': 'Kumamoto', '大分': 'Oita', '鹿児島': 'Kagoshima', '宮崎': 'Miyazaki', '沖縄': 'Okinawa',
    '青森県': 'Aomori', '秋田県': 'Akita', '岩手県': 'Iwate', '山形県': 'Yamagata', '宮城県': 'Miyagi', '福島県': 'Fukushima',
    '群馬県': 'Gunma', '栃木県': 'Tochigi', '茨城県': 'Ibaraki', '埼玉県': 'Saitama', '東京都': 'Tokyo', '千葉県': 'Chiba', '神奈川県': 'Kanagawa',
    '石川県': 'Ishikawa', '福井県': 'Fukui', '富山県': 'Toyama', '新潟県': 'Niigata', '岐阜県': 'Gifu', '長野県': 'Nagano', '愛知県': 'Aichi', '山梨県': 'Yamanashi', '静岡県': 'Shizuoka',
    '兵庫県': 'Hyogo', '京都府': 'Kyoto', '滋賀県': 'Shiga', '大阪府': 'Osaka', '奈良県': 'Nara', '三重県': 'Mie', '和歌山県': 'Wakayama',
    '島根県': 'Shimane', '鳥取県': 'Tottori', '広島県': 'Hiroshima', '岡山県': 'Okayama', '山口県': 'Yamaguchi',
    '愛媛県': 'Ehime', '香川県': 'Kagawa', '高知県': 'Kochi', '徳島県': 'Tokushima',
    '長崎県': 'Nagasaki', '佐賀県': 'Saga', '福岡県': 'Fukuoka', '熊本県': 'Kumamoto', '大分県': 'Oita', '鹿児島県': 'Kagoshima', '宮崎県': 'Miyazaki', '沖縄県': 'Okinawa',
  };

  /**
   * 動的文字列用の正規表現パターン変換ルール
   */
  const PATTERN_RULES = [
    // 枚数・件数・個数・色数バッジ
    [/^([\d,]+\+?)\s*枚\s*\(表示上限\)$/, '$1 shots (Max)'],
    [/^([\d,]+\+?)\s*枚$/, '$1 shots'],
    [/^([\d,]+)\s*件$/, '$1 items'],
    [/^([\d,]+)\s*個$/, '$1'],
    [/^([\d,]+)\s*色$/, '$1 colors'],
    [/^\(([\d,]+)枚\)$/, '($1)'],
    [/^([\d,]+)\s*枚選択中$/, '$1 selected'],
    [/^([\d,]+)枚の写真を選択中$/, '$1 photos selected'],
    [/^([\d,]+)\s*\/\s*([\d,]+)\s*枚\s*\((\d+)%\)$/, '$1 / $2 shots ($3%)'],
    [/^(?:📋\s*)?重複\s*(\d+)$/, 'DUP $1'],
    [/^(?:📋\s*)?重複写真グループ\s*\((\d+)枚\)(.*)$/, 'Duplicate Group ($1 shots)$2'],
    [/^(?:⚡\s*)?連写グループ\s*\((\d+)枚\)(.*)$/, 'Burst Group ($1 shots)$2'],
    [/^(?:⚡\s*)?連写バースト\s*\((\d+)コマ\)(.*)$/, 'Burst Group ($1 frames)$2'],
    [/^(?:⚡\s*)?露出ブラケット\s*\((\d+)枚(.*)\)(.*)$/, 'Exposure Bracket ($1 shots$2)$3'],
    [/^▼\s*他\s*(\d+)\s*枚を表示$/, '▼ Show $1 More'],
    [/^▼\s*他のコマを表示\s*\((\d+)枚\)$/, '▼ Show $1 More Frames'],

    // ヒストグラム動的数値・ゾーン表示
    [/^(\d+)\s*\(暗め\)$/, '$1 (Low-Key)'],
    [/^(\d+)\s*\(明るめ\)$/, '$1 (High-Key)'],
    [/^Lv\.(\d+)\s*\(黒\)\s*([\d.]+)%$/, 'Lv.$1 (Black) $2%'],
    [/^Lv\.(\d+)\s*\(シャドウ\)\s*([\d.]+)%$/, 'Lv.$1 (Shadow) $2%'],
    [/^Lv\.(\d+)\s*\(中間調\)\s*([\d.]+)%$/, 'Lv.$1 (Mid) $2%'],
    [/^Lv\.(\d+)\s*\(ハイライト\)\s*([\d.]+)%$/, 'Lv.$1 (High) $2%'],
    [/^Lv\.(\d+)\s*\(白\)\s*([\d.]+)%$/, 'Lv.$1 (White) $2%'],

    // 年・月・日（タイムライン＆ラボ）
    [/^(\d{4})年$/, '$1'],
    [/^(\d{1,2})月$/, (_, m) => MONTH_NAMES_SHORT[(parseInt(m, 10) || 1) - 1] || `${m}M`],
    [/^(\d{1,2})日$/, 'Day $1'],
    [/^(\d{1,2})月(\d{1,2})日$/, (_, m, d) => `${MONTH_NAMES_SHORT[(parseInt(m, 10) || 1) - 1] || m} ${d}`],
    [/^歴代の\s*(\d{1,2})月(\d{1,2})日$/, (_, m, d) => `On This Day: ${MONTH_NAMES_SHORT[(parseInt(m, 10) || 1) - 1] || m} ${d}`],
    [/^歴代の今日:\s*(.+)$/, 'On This Day: $1'],
    [/^今日の日付（(.+)）に戻す$/, 'Reset to today ($1)'],
    [/^(?:📅\s*)?複数月選択\s*\((\d+)ヶ月:\s*(.+)\)$/, 'Multi-Month ($1 mos: $2)'],

    // フィルタチップ・カードバッジ・インスペクタ詳細
    [/^評価:\s*(.+)$/, (_, rText) => {
      const mapped = rText
        .replace(/優/g, 'Ex')
        .replace(/良/g, 'Gd')
        .replace(/可/g, 'Nm')
        .replace(/棄/g, 'Rj')
        .replace(/なし/g, 'None');
      return `Rating: ${mapped}`;
    }],
    [/^(?:⭐\s*)?([優良可棄/]+)$/, (_, rText) => {
      const mapped = rText
        .replace(/優/g, 'Ex')
        .replace(/良/g, 'Gd')
        .replace(/可/g, 'Nm')
        .replace(/棄/g, 'Rj');
      return mapped;
    }],
    [/^ジオタグ:\s*(.+)$/, 'Geotag: $1'],
    [/^RAW画像\s*\((.+)\)$/, 'RAW Image ($1)'],
    [/^重複写真\s*(\d+)枚\s*\(他フォルダにコピーあり・クリックで一覧表示\)$/, 'Duplicate ($1 copies across folders — click to inspect)'],
    [/^グループ\s*(\d+)枚(.*)$/, 'Stack of $1 shots$2 (click to view group)'],
    [/^他フォルダに重複コピーあり\s*\(計\s*(\d+)\s*箇所\)$/, 'Duplicate copies in other folders ($1 locations)'],
    [/^保存パス\s*\((\d+)件\)$/, 'File Paths ($1)'],
    [/^保存ボリューム\s*\((\d+)件\)$/, 'Volumes ($1)'],
    [/^元の保存パス:\s*(.+)$/, 'Original Path: $1'],
    [/^ボリュームシリアル:\s*(.+)$/, (_, s) => `Volume Serial: ${s === '不明' ? 'Unknown' : s}`],
    [/^(?:(?:🟢|🔴)\s*)?ラベルなし(.*)$/, 'Unlabeled$1'],
    [/^(.+)\s*の子タグ\.\.\.$/, 'Child tag of $1...'],
    [/^「(.+)\/\.\.\.」の子タグを作成して付与$/, 'Create & add child tag under "$1/..."'],
    [/^「(.+)」を写真に付与$/, 'Add tag "$1" to photo'],
    [/^「(.+)」を選択写真に付与$/, 'Add tag "$1" to selected photos'],
    [/^「(.+)」に一致するタグはありません$/, 'No tags matching "$1"'],
    [/^タグ「(.+)」をリネーム$/, 'Rename tag "$1"'],
    [/^タグ「(.+)」を削除$/, 'Delete tag "$1"'],
    [/^全写真\((\d+)枚\)に付与されています。クリックで一括解除$/, 'Applied to all ($1) photos. Click to remove from all'],
    [/^一部の写真\((\d+)\/(\d+)枚\)に付与されています。クリックで一括解除$/, 'Applied to $1/$2 photos. Click to remove from all'],
    [/^◀\s*撮影前\s*\((\d+)分前\)$/, '◀ Before ($1m prior)'],
    [/^撮影後\s*▶\s*\((\d+)分後\)$/, 'After ▶ ($1m later)'],
    [/^(?:📋\s*)?その他の候補\s*\((\d+)件\)$/, 'All Candidates ($1)'],
    [/^(?:📷\s*)?(.+?)\s*・\s*(?:⏱\s*)?([\d.?]+)分差\s*・\s*(?:📍\s*)?(.+)$/, (_, cam, diff, coords) => `${cam === '不明' ? 'Unknown' : cam} · ±${diff}m · ${coords}`],
    [/^(?:🚫\s*)?除外:\s*(.+)$/, 'Ignored: $1'],
    [/^(?:🔭\s*)?除外:\s*(.+)$/, 'Exclude: $1'],
    [/^(?:📷\s*)?除外:\s*(.+)$/, 'Exclude: $1'],
    [/^(?:📷\s*)?カメラ・レンズ絞り込み\s*\((\d+)件\)$/, 'Gear Filter ($1)'],
    [/^最新:\s*(.+)\s*\/\s*全(\d+)世代保存中$/, 'Latest: $1 / $2 backups kept'],
    [/^写真:\s*配下\s*([\d,]+)\s*枚(.*)$/, (_, tot, dir) => `Photos: ${tot} total` + (dir ? dir.replace(/（直下\s*([\d,]+)\s*枚）/, ' ($1 direct)') : '')],
    [/^元ファイルが未接続です（ボリューム:\s*(.+)）\s*—\s*サムネイルプレビューで表示中$/, 'Source drive offline (Vol: $1) — Showing cached thumbnail'],
    [/^元ファイルが未接続です\s*—\s*サムネイルプレビューで表示中$/, 'Source drive offline — Showing cached thumbnail'],
    [/^実フォルダ（(.+)）が存在しないか、ドライブが未接続です。（保存済みサムネイルをキャッシュから表示中）$/, 'Folder ($1) is missing or drive is offline. (Showing cached thumbnails)'],
    [/^実フォルダ（(.+)）が存在しないか、ドライブが未接続です。ドライブの接続状態を確認してください。$/, 'Folder ($1) is missing or drive is offline. Please check drive connection.'],

    // ライトボックス＆2枚比較 (Duel)
    [/^プレビュー表示(.*)$/, (_, v) => 'Cached Preview' + (v ? v.replace('（ボリューム:', ' (Vol:').replace('）', ')') : '')],
    [/^コピー(\d+)$/, 'Copy #$1'],
    [/^開始から\s*\+([\d.]+)s$/, '+$1s from start'],
    [/^連写\s*#(\d+)\s*コマ目$/, 'Burst Frame #$1'],
    [/^(?:📌\s*)?A:\s*#(\d+)\s+vs\s+(?:🔍\s*)?B:\s*#(\d+)\s*（全\s*([\d,]+)\s*枚）$/, 'A: #$1  vs  B: #$2 ($3 total)'],
    [/^(?:⚡\s*)?露出ブラケット比較\s*\((\d+)枚\)$/, 'Bracket Duel ($1 shots)'],
    [/^(?:📋\s*)?重複グループ比較\s*\((\d+)枚\)$/, 'Duplicate Duel ($1 shots)'],
    [/^(?:⚡\s*)?連写グループ比較\s*\((\d+)コマ\)$/, 'Burst Duel ($1 frames)'],
    [/^(?:🖼️\s*)?前後写真の比較\s*\((\d+)枚\)$/, 'Neighbor Duel ($1 shots)'],
    [/^(?:✓\s*)?選択中の写真を比較\s*\((\d+)枚\)$/, 'Selected Duel ($1 shots)'],
    [/^(?:⚡\s*)?スタック内比較\s*\((\d+)枚\)$/, 'Stack Duel ($1 shots)'],
    [/^(?:🖼️\s*)?写真一覧の比較\s*\((\d+)枚\)$/, 'Grid Duel ($1 shots)'],
    [/^(\d+)\s*&\s*(\d+)\s*\/\s*([\d,]+)\s*枚$/, '$1 & $2 / $3 shots'],

    // カルテ・ラボ統計バッジ
    [/^(?:🏅\s*)?優\s*([\d,]+)$/, 'Ex $1'],
    [/^(?:👍\s*)?良\s*([\d,]+)$/, 'Gd $1'],
    [/^(?:🏅\s*)?優打率\s*([\d.]+)%$/, 'Ex Rate $1%'],
    [/^優打率\s*([\d.]+)%$/, 'Ex Rate $1%'],
    [/^好評価\s*([\d.]+)%$/, 'Hit $1%'],
    [/^優打率:\s*([\d.]+)%\s*\/\s*好評価率:\s*([\d.]+)%\s*\(出動比率:\s*([\d.]+)%\)$/, 'Ex Rate: $1% / Keeper Rate: $2% (Usage Share: $3%)'],
    [/^（優打率\s*([\d.]+)%）、\s*絞りは$/, ' (Ex Rate $1%), and aperture '],
    [/^（優打率\s*([\d.]+)%）で最高傑作が生まれやすい傾向にあります。$/, ' (Ex Rate $1%) for producing masterpieces.'],
    [/^(\d+)時台（([\d,]+)枚）$/, '$1:00 ($2 shots)'],
    [/^(\d+)時台（優打率\s*([\d.]+)%）$/, '$1:00 (Ex Rate $2%)'],
    [/^(\d+)時台:\s*計\s*([\d,]+)枚\s*\/\s*(?:🏅\s*)?優\s*([\d,]+)枚\s*\(優打率\s*([\d.]+)%\)$/, '$1:00 — Total $2 / Ex $3 (Ex Rate $4%)'],
    [/^([\d,]+)\s*本のレンズを分析$/, '$1 lenses analyzed'],
    [/^([\d,]+)\s*機種$/, '$1 bodies'],
    [/^(?:🌅\s*)?マジックアワー\s*\(([\d,]+)枚\)$/, 'Golden Hour ($1)'],
    [/^(?:🌌\s*)?ブルーアワー\s*\(([\d,]+)枚\)$/, 'Blue Hour ($1)'],
    [/^(?:🌃\s*)?夜景・星景\s*\(([\d,]+)枚\)$/, 'Night & Astro ($1)'],
    [/^(?:⚠️\s*)?手ブレ(?:危険度|注意)\s*\(([\d,]+)枚\)$/, 'Lens Shaker ($1)'],
    [/^焦点距離:\s*(.+)$/, 'Focal: $1'],
    [/^F値:\s*(.+)$/, 'F-Stop: $1'],
    [/^除外:\s*(.+)$/, 'Exclude: $1'],

    // 制覇マップ・ヒートマップ・軌跡
    [/^(\d+)\s*\/\s*(\d+)\s*都道府県$/, '$1 / $2 Prefs'],
    [/^(\d+)の国と地域$/, '$1 Countries'],
    [/^([\d,]+)\s*(メッシュ|エリア)$/, '$1 Hotspots'],
    [/^([\d,]+)枚\s*\(([\d.]+)%\)$/, '$1 shots ($2%)'],
    [/^([\d,]+)枚\s*\/\s*(?:🏅\s*)?([\d,]+)$/, '$1 shots / $2'],
    [/^(?:(?:🇯🇵|🌍)\s+)?(.+)$/, (full, c) => Object.prototype.hasOwnProperty.call(EXACT_MAP, c) ? EXACT_MAP[c] : full],
    [/^(?:🔍\s*)?(.+)の写真を表示\s*\(([\d,]+)枚\)$/, (_, pref, cnt) => `View ${PREF_ROMAJI_MAP[pref] || pref} (${cnt})`],
    [/^(\d{4}-\d{2}-\d{2})\s*\(([\d,]+)枚\)$/, '$1 ($2 shots)'],
    [/^(?:🔥\s*)?滞在ホットスポット\s*\(([\d,]+)枚撮影\)$/, 'Stay Hotspot ($1 shots)'],
    [/^(?:🏅\s*)?優\s*#(\d+)$/, 'Ex #$1'],
    [/^約\s*([\d,]+)\s*歩$/, 'Approx. $1 steps'],
    [/^(\d+)\s*箇所$/, '$1 spots'],
    [/^(\d+)分$/, '$1m'],
    [/^(\d+)時間(\d+)分$/, '$1h $2m'],
    [/^(\d+)日間$/, '$1 days'],

    // 複数行ツールチップ
    [/^([\s\S]+)\nクリック:\s*上部にプレビュー表示\nダブルクリック:\s*ライトボックスで全画面表示$/, '$1\nClick: Preview above\nDouble-click: Open Lightbox'],
    [/^([\s\S]+)\nクリックでフォルダを開く$/, '$1\nClick to open folder'],
    [/^([\s\S]+)\nクリック:\s*(?:🔍\s*)?右\(B\)に表示\nShift\+クリック:\s*(?:📌\s*)?左\(A\)に固定$/, '$1\nClick: Show in Right (B)\nShift+Click: Pin to Left (A)'],
    [/^([\s\S]+)\n左クリック:\s*含む\/解除\s*｜\s*右クリック:\s*除外$/, '$1\nLeft-click: Include/Off | Right-click: Exclude'],
    [/^(.+)\s*\(([\d,]+)枚\)\nクリック:\s*この色で絞り込み\s*｜\s*右クリック:\s*除外$/, (_, c, n) => `${EXACT_MAP[c] || c} (${n})\nLeft-click: Include | Right-click: Exclude`],
    [/^(.+)\nクリック:\s*選択中写真\((\d+)枚\)に一括(解除|付与)$/, (_, c, n, act) => `${EXACT_MAP[c] || c}\nClick: Batch ${act === '解除' ? 'remove from' : 'apply to'} ${n} selected photos`],
    [/^(.+)\nクリックでこの写真に(解除|付与)$/, (_, c, act) => `${EXACT_MAP[c] || c}\nClick to ${act === '解除' ? 'remove from' : 'apply to'} this photo`],
    [/^([\s\S]+)\n保存先:\s*(.+)\n解像度:\s*(.+)\nサイズ:\s*(.+?)(\n\(代表マスター写真\))?$/, (_, f, d, r, s, pri) => `${f}\nFolder: ${d === '不明' ? 'Unknown' : d}\nDimensions: ${r}\nSize: ${s}${pri ? '\n(★ Crowned Primary)' : ''}`],
    [/^([\s\S]+)\n撮影時刻:\s*(.+)\n露出:\s*(.+)$/, (_, head, t, exp) => `${head.replace('連写スタートコマ (0.000s)', 'Burst Start (0.000s)').replace(/開始から \+([\d.]+)s/, '+$1s from start').replace(/連写 #(\d+) コマ目/, 'Burst Frame #$1')}\nTime: ${t === '不明' ? 'Unknown' : t}\nExposure: ${exp}`],
    [/^(.+)（ドライブ未接続）$/, '$1 (Offline)'],
    [/^(.+)（実フォルダ消失）$/, '$1 (Folder Missing)'],
    [/^「(.+)」内:\s*AND検索（すべて含む写真のみ）\nクリックで「または\s*\(OR\)」に戻す$/, 'Inside "$1": AND search (must match all)\nClick to switch back to "or (OR)"'],
    [/^「(.+)」内:\s*OR検索（いずれかを含む写真）\nクリックで「かつ\s*\(AND\)」に切り替える$/, 'Inside "$1": OR search (match any)\nClick to switch to "AND"'],
    [/^タグ条件:\s*(.+)（同グループ内は(AND|OR)・除外はNOT）$/, 'Tag Filter: $1 (Intra-group: $2, Exclude: NOT)'],
    [/^「(.+)」内の別タグを追加\s*\((AND|OR)\)\s*または除外\s*\(NOT\)$/, 'Add another tag in "$1" ($2) or exclude (NOT)'],

    // バージョン更新日時ツールチップ
    [/^v([\d.a-zA-Z]+)\s*\(最終更新:\s*(.+)\)$/, 'v$1 (Updated: $2)'],

    // よく出るトーストメッセージ
    [/^(右へ90°|左へ90°)回転しました$/, (_, d) => `Rotated ${d === '右へ90°' ? '90° CW' : '90° CCW'}`],
    [/^(\d+)枚を(右へ90°|左へ90°)一括回転しました$/, (_, n, d) => `Batch rotated ${n} photos ${d === '右へ90°' ? '90° CW' : '90° CCW'}`],
    [/^(\d+)枚の回転・調整をリセットしました$/, 'Reset rotation & adjustments for $1 photos'],
    [/^(?:📤\s*)?(\d+)枚のJPGを「(.+)」にテイクアウトしました(.*)$/, 'Exported $1 JPGs to "$2"$3'],
    [/^(?:🏷️\s*)?(\d+)枚の写真にタグ「(.+)」を付与しました$/, 'Added tag "$2" to $1 photos'],
    [/^(\d+)枚の評価を「(.+)」に設定しました$/, 'Set rating for $1 photos to "$2"'],
    [/^(?:🗑️\s*)?(\d+)枚の写真をライブラリから削除しました$/, 'Removed $1 photos from library'],
    [/^(?:📍\s*)?(\d+)\s*枚の写真にジオタグを準用しました$/, 'Inferred GPS for $1 photos'],
    [/^(?:🗑️\s*)?(\d+)\s*枚の写真からジオタグを削除しました$/, 'Cleared GPS from $1 photos'],
    [/^(\d+)枚の写真を「(.+)」に書き出しました！(.*)$/, 'Exported $1 photos to "$2"!$3'],
    [/^(?:🎲\s*)?発掘ガチャ:\s*「(.+)」（未整理\s*([\d,]+)枚）を引き当てました!?$/, 'Gacha Hit! Folder "$1" ($2 unrated shots)!'],
    [/^(?:🗾\s*)?「(.+)」で撮影された写真を表示します$/, (_, pref) => `Filtering photos taken in ${PREF_ROMAJI_MAP[pref] || pref}`],
    [/^(?:🌏\s*)?「(.+)」の写真で絞り込みました$/, (_, c) => `Filtered by country: ${EXACT_MAP[c] || c}`],
    [/^(?:🎞️\s*)?ベタ焼きHTML（([\d,]+)枚）を\s*take_out\s*に出力しました$/, 'Exported Betayaki HTML ($1 shots) to take_out!'],
    [/^(?:🔍\s*)?レンズ「(.+)」で絞り込みました$/, 'Filtered by Lens: "$1"'],
    [/^(?:📷\s*)?カメラ「(.+)」で絞り込みました$/, 'Filtered by Body: "$1"'],
    [/^(?:📐\s*)?焦点距離「(.+)」で絞り込みました$/, 'Filtered by Focal Length: "$1"'],
    [/^(?:🔆\s*)?絞り「(.+)」で絞り込みました$/, 'Filtered by Aperture: "$1"'],
    [/^(?:🎂\s*)?歴代の\s*(.+)\s*に撮影された写真を表示します$/, 'Showing photos taken on $1 across all years'],
    [/^(.+)\s*で写真を絞り込みました$/, 'Filtered photos by $1'],
    [/^(?:👑\s*)?「(.+)」を左\(A:基準\)にセットしました$/, 'Crowned "$1" as Left (A: Champion)'],
    [/^(?:🏷️\s*)?「(.+)」を手動タグとして確定しました$/, 'Promoted "$1" to Manual tag'],
    [/^(?:🤖\s*)?AIタグを付与しました:\s*(.+)$/, 'Added AI tags: $1'],
    [/^フィルタセット「(.+)」を保存しました$/, 'Saved filter preset "$1"'],
    [/^フィルタセット「(.+)」を適用しました$/, 'Applied filter preset "$1"'],
    [/^フィルタセット「(.+)」を削除しました$/, 'Deleted filter preset "$1"'],
    [/^(?:✅\s*)?スキャン完了:\s*([\d,]+)枚検出\s*\(([\d,]+)枚更新(.*)\)$/, 'Scan complete: $1 found ($2 updated$3)'],
    [/^XMPサイドカー検出:\s*(.+)$/, 'XMP sidecar detected: $1'],
    [/^XMPサイドカーファイルが検出されました\s*\((.+)\)$/, 'XMP sidecar file detected ($1)'],
    [/^押している間だけXMPの調整データを反映します\s*\((.+)\)$/, 'Hold to preview XMP adjustments ($1)'],
    [/^(?:🕒\s*)?(\d+)枚の写真の撮影日時を一括シフト補正しました$/, 'Shifted Date Taken for $1 photos'],
    [/^(?:↩️\s*)?(\d+)枚の写真の撮影日時を元のEXIF日時に戻しました$/, 'Restored original EXIF Date Taken for $1 photos'],
    [/^(?:📥\s*)?(\d+)枚の写真を\s*storage\s*に取り込みました$/, 'Imported $1 photos into storage'],
    [/^\(元:\s*(.+)\)$/, '(Orig: $1)'],
    [/^…他\s*(\d+)\s*枚$/, '...and $1 more'],
    [/^XMPサイドカーから取り込み\s*\((.+)\)$/, 'Import from XMP sidecar ($1)'],
    [/^(?:📥\s*)?XMPからメタデータを取り込みました（タグ\s*(\d+)件）$/, 'Imported metadata from XMP ($1 tags)'],
  ];

  /**
   * 文字列を日本語から英語に変換する
   * @param {string} raw
   * @returns {string}
   */
  function translateString(raw) {
    if (!raw || typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    // 日本語文字（ひらがな・カタカナ・漢字）を1文字も含まない場合（絵文字のみ・英数字のみ）は無変換で即座に返す
    if (!/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(trimmed)) return raw;

    // 1. 完全一致辞書
    if (Object.prototype.hasOwnProperty.call(EXACT_MAP, trimmed)) {
      const target = EXACT_MAP[trimmed];
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      return lead + target + trail;
    }

    // 2. 都道府県名（47都道府県白地図のSVGセル等）
    if (Object.prototype.hasOwnProperty.call(PREF_ROMAJI_MAP, trimmed)) {
      const target = PREF_ROMAJI_MAP[trimmed];
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      return lead + target + trail;
    }

    // 3. パターンルール
    for (let i = 0; i < PATTERN_RULES.length; i++) {
      const [regex, replacement] = PATTERN_RULES[i];
      if (regex.test(trimmed)) {
        const converted = trimmed.replace(regex, replacement);
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        return lead + converted + trail;
      }
    }

    return raw;
  }

  /**
   * 翻訳対象外とすべき要素か判定する（スクリプト・スタイル・ファイルパス表示セル・言語切替ボタン自身）
   * @param {Element|null} el
   * @returns {boolean}
   */
  function shouldSkipElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
      return true;
    }
    if (el.id === 'langToggleBtn' || el.closest('#langToggleBtn')) {
      return true;
    }
    if (
      el.classList &&
      (el.classList.contains('path-val') ||
        el.classList.contains('path-cell') ||
        el.classList.contains('raw-filename') ||
        el.classList.contains('card-filename') ||
        el.classList.contains('lightbox-filename') ||
        el.classList.contains('compare-filename'))
    ) {
      return true;
    }
    return false;
  }

  /**
   * 単一のTextNodeを現在の言語設定（en / ja）に合わせて変換または復元する
   * @param {Text} textNode
   */
  function processTextNode(textNode) {
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const parent = textNode.parentElement;
    if (shouldSkipElement(parent)) return;

    const val = textNode.nodeValue;
    if (!val || !val.trim()) return;

    if (currentLang === 'en') {
      // 既に直近で変換した英語文字列そのものであればスキップ（無限ループ防止）
      if (textNode.__pmLastEn !== undefined && val === textNode.__pmLastEn) {
        return;
      }
      // 新しい日本語文字列（または初期値）として記憶し、英語へ変換
      textNode.__pmOrigJa = val;
      const enVal = translateString(val);
      if (enVal !== val) {
        textNode.__pmLastEn = enVal;
        textNode.nodeValue = enVal;
      }
    } else {
      // 日本語モード: 英語に変換されていた場合は元の日本語へ復元
      if (textNode.__pmOrigJa !== undefined && val === textNode.__pmLastEn) {
        textNode.nodeValue = textNode.__pmOrigJa;
      }
    }
  }

  const TARGET_ATTRS = ['title', 'placeholder', 'aria-label'];

  /**
   * 要素の属性（title / placeholder / aria-label）を変換または復元する
   * @param {Element} el
   */
  function processElementAttributes(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    if (el.id === 'langToggleBtn' || el.closest('#langToggleBtn')) return;

    for (let i = 0; i < TARGET_ATTRS.length; i++) {
      const attr = TARGET_ATTRS[i];
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr);
      if (!val || !val.trim()) continue;

      if (!el.__pmAttrOrig) el.__pmAttrOrig = {};
      if (!el.__pmAttrEn) el.__pmAttrEn = {};

      if (currentLang === 'en') {
        if (el.__pmAttrEn[attr] !== undefined && val === el.__pmAttrEn[attr]) {
          continue;
        }
        el.__pmAttrOrig[attr] = val;
        const enVal = translateString(val);
        if (enVal !== val) {
          el.__pmAttrEn[attr] = enVal;
          el.setAttribute(attr, enVal);
        }
      } else {
        if (el.__pmAttrOrig[attr] !== undefined && val === el.__pmAttrEn[attr]) {
          el.setAttribute(attr, el.__pmAttrOrig[attr]);
        }
      }
    }
  }

  /**
   * 指定されたルートノード配下のすべてのTextNodeおよび属性を一括走査する
   * @param {Node} root
   */
  function processSubtree(root) {
    if (!root) return;
    isApplying = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) {
        processTextNode(root);
        return;
      }
      if (root.nodeType === Node.ELEMENT_NODE) {
        processElementAttributes(root);
      }

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        null
      );

      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          processElementAttributes(node);
        }
        node = walker.nextNode();
      }
    } finally {
      isApplying = false;
    }
  }

  /**
   * ヘッダーの言語切替ボタン（#langToggleBtn）の表示を更新する
   */
  function updateLangToggleButton() {
    const btn = document.getElementById('langToggleBtn');
    const iconEl = document.getElementById('langToggleIcon');
    const labelEl = document.getElementById('langToggleLabel');

    document.documentElement.lang = currentLang;
    document.documentElement.setAttribute('data-lang', currentLang);

    if (!btn) return;
    if (currentLang === 'en') {
      if (iconEl) iconEl.textContent = '';
      if (labelEl) labelEl.textContent = 'EN';
      btn.title = 'Switch UI Language (English ⇄ 日本語)';
      btn.classList.add('is-en');
    } else {
      if (iconEl) iconEl.textContent = '';
      if (labelEl) labelEl.textContent = 'JP';
      btn.title = 'UI言語切り替え (日本語 ⇄ English)';
      btn.classList.remove('is-en');
    }
  }

  /**
   * 言語を切り替えて即時反映する
   * @param {'ja'|'en'} lang
   */
  let _i18nObserver = null;

  function syncObserverState() {
    if (!_i18nObserver || !document.body) return;
    if (currentLang === 'en') {
      _i18nObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TARGET_ATTRS,
      });
    } else {
      _i18nObserver.disconnect();
    }
  }

  function setLanguage(lang) {
    currentLang = lang === 'en' ? 'en' : 'ja';
    localStorage.setItem(STORAGE_KEY, currentLang);
    updateLangToggleButton();
    syncObserverState();
    processSubtree(document.body);
  }

  /**
   * 日本語 ⇄ 英語をトグルする
   */
  function toggleLanguage() {
    const nextLang = currentLang === 'ja' ? 'en' : 'ja';
    setLanguage(nextLang);
    if (typeof showToast === 'function') {
      if (nextLang === 'en') {
        showToast('Switched UI language to English', 'info', 2200);
      } else {
        showToast('表示言語を日本語に切り替えました', 'info', 2200);
      }
    }
  }

  /**
   * 初期化＆MutationObserver監視開始
   */
  function initI18n() {
    const btn = document.getElementById('langToggleBtn');
    if (btn && !btn.dataset.i18nBound) {
      btn.dataset.i18nBound = 'true';
      btn.addEventListener('click', toggleLanguage);
    }

    updateLangToggleButton();
    if (currentLang === 'en') {
      processSubtree(document.body);
    }

    const observer = new MutationObserver((mutations) => {
      if (isApplying || currentLang !== 'en') return;
      isApplying = true;
      try {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (m.type === 'characterData') {
            processTextNode(m.target);
          } else if (m.type === 'attributes') {
            processElementAttributes(m.target);
          } else if (m.type === 'childList') {
            for (let j = 0; j < m.addedNodes.length; j++) {
              const added = m.addedNodes[j];
              if (added.nodeType === Node.TEXT_NODE) {
                processTextNode(added);
              } else if (added.nodeType === Node.ELEMENT_NODE) {
                processSubtree(added);
              }
            }
          }
        }
      } finally {
        isApplying = false;
      }
    });

    _i18nObserver = observer;
    syncObserverState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initI18n);
  } else {
    initI18n();
  }

  // グローバルAPI公開
  window.pmI18n = {
    getLang: () => currentLang,
    setLanguage,
    toggleLanguage,
    translateString,
  };
})();
