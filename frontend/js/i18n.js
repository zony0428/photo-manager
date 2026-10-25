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
    '📜 和紙': '📜 Washi',
    '🌙 夜墨': '🌙 Urusi',
    'テーマ切り替え (和紙 ⇄ 夜墨)': 'Switch Theme (Washi ⇄ Urusi)',
    '夜墨（ダーク）モードに切り替え': 'Switch to Urusi (Dark Ink) Mode',
    '和紙（ライト）モードに切り替え': 'Switch to Washi (Paper Light) Mode',
    'UI言語切り替え (日本語 ⇄ English)': 'Switch UI Language (English ⇄ 日本語)',
    'サイドバーを開閉 ([キー または Bキー)': 'Toggle Sidebar ([ or B key)',
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
    '評価の高い順': 'Top Rated (Ex → Rj)',
    'ファイル名順': 'File Name (A → Z)',
    '取り込み': 'Import',
    'PCの写真ファイルを選んで、アプリ内にコピーしてライブラリに取り込みます': 'Select photo files from PC and copy into library',
    'スマホ連携': 'Mobile',
    'スマホ（Android）連携・モバイル画面 (/m) を開く': 'Open Mobile Cull & USB Sync Guide (/m)',
    'ヘルプ': 'Help',
    '操作マニュアル & ショートカット一覧 (? / F1)': 'User Manual & Shortcuts (? / F1)',
    '終了': 'Quit',
    'Photo Manager を終了する': 'Quit Photo Manager',

    // --- 4段階評価（優 / 良 / 可 / 棄 ➔ Ex / Gd / Nm / Rj） ---
    '評価フィルタ:': 'Rating:',
    '優': 'Ex',
    '良': 'Gd',
    '可': 'Nm',
    '棄': 'Rj',
    '🏅 優': '🏅 Ex',
    '⭐ 良': '⭐ Gd',
    '⚪ 可': '⚪ Nm',
    '🗑️ 棄': '🗑️ Rj',
    '優 (1)': 'Ex - Excellent (1)',
    '良 (2)': 'Gd - Good (2)',
    '可 (0 / 4)': 'Nm - Normal (0 / 4)',
    '棄 (3 / X)': 'Rj - Reject / Botsu (3 / X)',
    '優 (Excellent)': 'Ex (Excellent)',
    '良 (Good)': 'Gd (Good)',
    '可 (解除・普通)': 'Nm (Normal / Clear)',
    '棄 (非表示候補)': 'Rj (Reject / Botsu)',
    '可（解除）': 'Nm (Reset)',

    // --- 左サイドバー共通 & クイックアクセス ---
    'フィルタ全解除': 'Reset All',
    'すべてのフィルタを解除して全写真を表示': 'Clear all filters and show all photos',
    '開いているメニューを閉じる': 'Collapse open sections',
    'すべてのメニューを展開する': 'Expand all sections',
    'サイドバーを非表示にする ([ または B)': 'Hide Sidebar ([ or B)',
    'クイックアクセス': 'Quick Access',
    'すべての写真': 'All Photos',
    '未分類の写真': 'Untagged Photos',
    '未分類': 'Untagged',
    '接続中の写真': 'Online Photos',
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
    '⭐ ショートカット': '⭐ Shortcuts',
    '💻 接続中のドライブ': '💻 Connected Drives',
    '🔌 未接続（キャッシュのみ）': '🔌 Offline (Cached Thumbnails)',
    '接続中のドライブがありません': 'No connected drives found',
    '除外': 'Ignored',
    '⚠️ 消失': '⚠️ Missing',

    // --- 左サイドバー: タグ (アルバム) & カラー ---
    'タグ (アルバム)': 'Tags (Albums)',
    'カラーフィルタを開閉': 'Toggle Color Palette Filter',
    '🎨 カラー': '🎨 Colors',
    'タグ名を入力...': 'Enter tag name...',
    '作成': 'Create',
    '👤 手動': '👤 Manual',
    '🤖 AI': '🤖 AI',
    'すべて': 'All',
    '🔍 タグ候補を絞り込み (Enter)...': '🔍 Filter tags (Enter)...',
    '検索解除': 'Clear search',
    'クリックで': 'Click:',
    '[+]含む': '[+] In',
    '[-]除外': '[-] Out',
    '解除': 'Off',
    'クリア': 'Clear',
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
    '🗾 制覇マップ': '🗾 Seiha Map',
    '47都道府県 制覇白地図': '47-Pref Seiha Map',
    '47都道府県 撮影制覇白地図': '47-Pref Seiha Map',
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
    'クリックで [+]含む ➜ [-]除外 ➜ 解除': 'Click: [+] In ➜ [-] Out ➜ Off',
    'カメラ・レンズ一覧を再読み込み': 'Reload Gear & Lens Tree',
    'すべてのレンズ一覧を展開': 'Expand all lenses',
    'すべてのレンズ一覧を折りたたむ': 'Collapse all lenses',
    'スキャン後に表示': 'Shown after scan',

    // --- 左サイドバー: ファイル名検索 ---
    'ファイル名検索': 'File Search',
    'ファイル名で検索...': 'Search by filename...',
    '検索クリア': 'Clear search',
    '入力したキーワードを含むファイル名を即座に絞り込み表示します。': 'Instantly filters photos matching the filename keyword.',

    // --- 📦 storage（アプリ内ストレージ）管理 ---
    'storage (アプリ内ストレージ)': 'storage (In-App Storage)',
    '📥 storageへインポート': '📥 Import to storage',
    'storageへインポート': 'Import to storage',
    '選択した写真をアプリ内の storage フォルダへコピー＆インポートします': 'Copy & import selected photos into the in-app storage folder',
    '作成&インポート': 'Create & Import',
    'storage内にフォルダを作成してインポート': 'Create a subfolder in storage and import',
    'インポート先フォルダ': 'Destination Folder in storage',
    '📦 storage内で移動': '📦 Move in storage',
    'storage内で移動': 'Move in storage',
    'storage 内の写真を別サブフォルダへ移動します': 'Move photos to another subfolder inside storage',
    '作成&移動': 'Create & Move',
    'storage内にフォルダを作成して移動': 'Create a subfolder in storage and move',
    '移動先フォルダ': 'Destination Folder in storage',
    'storageフォルダを開く': 'Open storage Folder',
    'エクスプローラーでstorageフォルダを開きます': 'Open storage folder in File Explorer',
    '✏️ ファイル名を変更 (F2)': '✏️ Rename File (F2)',
    '✏️ 一括連番リネーム... (F2)': '✏️ Batch Sequential Rename... (F2)',
    'ファイル名変更': 'Rename',
    '一括リネーム': 'Batch Rename',
    'ファイル名を変更 (F2)': 'Rename File (F2)',
    '📁 新規サブフォルダを作成...': '📁 New Subfolder...',
    '✏️ フォルダ名を変更...': '✏️ Rename Folder...',
    '📤 このフォルダを外部へエクスポート...': '📤 Export Folder to External...',
    '🗑️ 空フォルダを削除': '🗑️ Delete Empty Folder',
    '✏️ ファイル名を変更': '✏️ Rename File',
    'storage 内の写真ファイル名を変更します': 'Rename photo file in storage',
    '現在のファイル名:': 'Current Filename:',
    '変更を保存 (Enter)': 'Save Changes (Enter)',
    '撮影日時 ＋ 3桁連番': 'Date Taken + 3-Digit Seq',
    '撮影日時 ＋ 元ファイル名': 'Date Taken + Original Name',
    '自由な接頭辞 ＋ 3桁連番': 'Custom Prefix + 3-Digit Seq',
    '接頭辞（プレフィックス）': 'Custom Prefix',
    '開始番号': 'Start Number',
    '変更プレビュー（先頭5件）': 'Preview (First 5 Items)',
    '📁 新規サブフォルダを作成': '📁 Create New Subfolder',
    'storage 内に新しいサブフォルダを作成します': 'Create a new subfolder inside storage',
    '作成する': 'Create',

    // --- 左サイドバー: 🧪 ラボ (Lab) ---
    'ラボ': 'Lab',
    '分析・発掘': 'Karte & Dig',
    '勝ちレンズ・得意設定カルテ': 'Kami-Lens Karte',
    '🏆 勝ちレンズ・得意設定カルテ': '🏆 Kami-Lens Karte',
    'これまでの評価から勝ちレンズ・黄金の焦点距離・F値・時間帯を診断します': 'Diagnose your Kami-Lenses, Golden Focal Length, F-stop & Shutter Rhythm from your ratings',
    '未整理ガチャ': 'Gacha',
    '🎲 未整理ガチャ': '🎲 Gacha',
    '未整理（評価：可）の写真が残っているフォルダをランダムに1つ引き当てます': 'Draw a random folder that still has unrated (Nm) photos!',
    '未整理（可）の写真が残っているフォルダをランダムに1つ引き当てます': 'Draw a random folder that still has unrated (Nm) photos!',
    '2枚比較 (V)': 'Duel (V)',
    '⚖️ 2枚比較 (V)': '⚖️ Duel (V)',
    '選択した2枚の写真を並べて同期ズーム＆Exif比較 (Vキー)': 'Side-by-side sync zoom & Exif comparison (V key)',
    '選択した2枚の写真を並べて同期ズーム＆Exif比較 (V)': 'Side-by-side sync zoom & Exif comparison (V)',
    '🎂 歴代の今日・記念日': '🎂 On This Day',
    '今日': 'Today',
    '今日の日付に戻す': 'Reset to today',
    '月を選択': 'Select Month',
    '日を選択': 'Select Day',
    '🎂 抽出': '🎂 Dig',
    '🎂 抽出中': '🎂 Active',
    '指定した月日の歴代写真を抽出・解除': 'Filter photos taken on this month & day across all years',
    '🔭 太陽高度・露出ラボ抽出': '🔭 Solar Angle & Exposure Lab',
    '太陽高度・露出ラボ抽出': 'Solar Angle & Exposure Lab',
    'ラボの絞り込み条件をすべて解除': 'Clear all Lab filters',
    '🌅 マジックアワー': '🌅 Golden Hour',
    'マジックアワー': 'Golden Hour',
    '太陽高度 -4°〜+6° のドラマチックな光（朝焼け・夕焼け）で撮影した写真を抽出': 'Filter photos shot during Golden Hour (solar altitude -4° to +6°)',
    '🌌 ブルーアワー': '🌌 Blue Hour',
    'ブルーアワー': 'Blue Hour',
    '✨ マジック＆ブルーアワー': '✨ Golden & Blue Hour',
    'マジック＋ブルーアワー': 'Golden & Blue Hour',
    'マジック＋ブルー': 'Golden & Blue',
    '太陽高度 -8°〜-4° の静謐な蒼い薄明時間帯の写真を抽出': 'Filter photos shot during Blue Hour (solar altitude -8° to -4°)',
    '🌃 夜景・星景': '🌃 Night & Astro',
    '🌃 夜景・天体': '🌃 Night & Astro',
    '夜景・星景': 'Night & Astro',
    '太陽高度 -8°未満の夜景・星景写真を抽出': 'Filter night & astrophotography shots (solar altitude < -8°)',
    '⚠️ 手ブレ注意': '⚠️ Lens Shaker',
    '⚠️ 手ブレ危険度': '⚠️ Lens Shaker',
    '⚠️ 手ブレ注意領域': '⚠️ Lens Shaker',
    '手ブレ注意': 'Lens Shaker',
    'シャッター速度 < 1/焦点距離 秒 の微ブレ危険領域にある写真を抽出': 'Filter shots where Shutter Speed < 1/Focal Length sec (Check for camera shake!)',

    // --- メインビュー・ヘッダー & 空状態 ---
    '✕ すべて解除': '✕ Clear All',
    '絞り込みをすべて解除してすべての写真を表示': 'Clear all active filters and show all photos',
    '🗑️ リンク消失写真をすべて完全消去': '🗑️ Purge All Unlinked Photos',
    'リンク消失しているすべての写真レコード（サムネイル・タグ含む）をDBから完全に消去': 'Permanently remove all unlinked photo records from database',
    'このフィルタを解除': 'Remove this filter',
    '実フォルダが存在しないか、ドライブが未接続です': 'Folder missing or external drive disconnected',
    'USBメモリ等の外部ドライブが抜かれているか、フォルダが移動・削除された可能性があります。（保存済みサムネイルをキャッシュから表示中）': 'External drive may be unplugged or folder moved. (Showing cached thumbnails)',
    '再確認': 'Recheck',
    '🔄 接続を再確認': '🔄 Recheck Connection',
    '接続状態を再確認': 'Recheck drive connection status',
    '写真が見つかりません': 'No Photos Found',
    '指定された条件の写真がないか、まだスキャンされていません。': 'No photos match the current filters, or no folders have been scanned yet.',
    'フォルダ管理を開く': 'Open Folder Tree',
    '📁 フォルダ一覧を開く': '📁 Open Folder Tree',
    '実フォルダが見つかりません（未接続）': 'Folder Not Found (Offline)',
    'このフォルダはライブラリ未登録です': 'Folder Not Registered in Library',
    '実ディスク上に存在する未登録フォルダです。「管理に追加」を押すと写真をスキャンしてライブラリに登録します。': 'This folder is not registered yet. Click "Add & Scan" to import its photos into your library.',
    '➕ 管理に追加してスキャン': '➕ Add & Scan Folder',
    'このフォルダは管理対象外（除外設定中）です': 'Folder is Ignored',
    '自動スキャンの対象から除外されています。「除外を解除」を押すと未登録状態に戻せます。': 'Excluded from scanning. Click "Unignore" to restore.',
    '↩️ 除外を解除する': '↩️ Unignore Folder',
    '選択 (Ctrl/Shiftクリック対応)': 'Select (Ctrl/Shift+Click supported)',
    '日付不明': 'Unknown Date',
    'カメラ不明': 'Unknown Camera',

    // --- 右ペイン: インスペクタ ---
    '写真情報': 'Inspector',
    '元データが格納されているフォルダを開く (Explorer)': 'Open containing folder in Explorer',
    '写真を関連付けられた規定のアプリで開く': 'Open photo in default external app',
    'パネルを閉じる': 'Close Inspector',
    'クリックで大画面ビューワを開く (Space)': 'Click to open Lightbox (Space)',
    '🔍 拡大ビューワ (Space)': '🔍 Lightbox (Space)',
    '⚡ 露出ブラケット': '⚡ Exposure Bracket',
    '▼ 他のコマを表示': '▼ Show More Frames',
    '▲ 折りたたむ': '▲ Collapse Frames',
    '👑 代表に設定': '👑 Crown',
    '★ 代表': '★ Crowned',
    'タグ': 'Tags',
    '詳細情報': 'Exif',
    'マップ': 'Map',
    'GPS位置情報あり': 'Has GPS Location',
    '色合いパレットを開閉': 'Toggle Color Palette',
    '🎨 色合い (複数選択可)': '🎨 Color Labels (Multi)',
    'タグツリーから選ぶ / 追加': 'Quick Tag Tree / Add',
    'AI自動タグ付けを開閉': 'Toggle Local AI Tagging',
    '🤖 AI自動タグ付け': '🤖 Local AI Tagging',
    'ローカルAI (CLIP Vision) が写真の被写体・シーンを自動認識してタグ付けします。': 'Local AI (CLIP Vision) recognizes subjects & scenes offline.',
    '🤖 この写真をAIで自動タグ付け': '🤖 Auto-Tag This Photo with AI',
    'ファイル名': 'File Name',
    'フォーマット': 'Format',
    '形式': 'Format',
    '📷 RAW ファイル': '📷 RAW File',
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
    '📍 緯度・経度': '📍 Lat / Lon',
    '🗺️ 撮影地域': '🗺️ Location',
    '🗑️ ジオタグ削除': '🗑️ Clear GPS',
    'ジオタグ削除': 'Clear GPS',
    'SQLiteデータベースからこの写真のジオタグ（緯度・経度・地名）を削除します（元画像ファイルは変更されません）': 'Remove GPS coordinates from SQLite DB (Original file is untouched)',
    'この写真にはGPS情報が記録されていません': 'No GPS coordinates recorded for this photo',
    '📍 近隣写真からGPSをコピー': '📍 Copy GPS from Nearby Photo',
    '📍 スマホGPS準用': '📍 Copy Phone GPS',
    'ジオタグ準用': 'Infer GPS',
    '📍 ジオタグ準用': '📍 Infer GPS',

    // --- インスペクタ: 一括編集モード (Batch View) ---
    '枚の写真を選択中': 'photos selected',
    '一括評価を設定': 'Batch Rating',
    'タグを一括付与': 'Batch Add Tags',
    '色合い一括パレットを開閉': 'Toggle Batch Color Palette',
    '🎨 色合いを一括設定 (複数選択可)': '🎨 Batch Color Labels',
    'タグツリーから選んで一括追加': 'Batch Add from Tag Tree',
    '選択写真に付いているタグ': 'Tags on Selected Photos',
    'ジオタグの一括操作': 'Batch Geotag Actions',
    '✕ 選択をすべて解除': '✕ Deselect All',
    '選択解除': 'Deselect',
    '選択をすべて解除': 'Deselect all photos',

    // --- ヒストグラム (histogram.js) ---
    '📊 ヒストグラム': '📊 Histogram',
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
    '🤖 AIタグ': '🤖 AI Tag',
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
    '📐傾': '📐Tilt',
    '☀️明': '☀️EV',
    '◐比': '◐Cont',
    '🎨彩': '🎨Sat',
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
    '📌 A : 基準': '📌 A : Champion',
    '🔍 B : 比較候補': '🔍 B : Challenger',
    '⌨️ 数字キー (1:優 / 2:良 / 3:棄) の評価対象': '⌨️ Active target for keys (1:Ex / 2:Gd / 3:Rj)',
    '左(A)に「優」を設定': 'Rate Left (A) as Ex (Excellent)',
    '左(A)に「良」を設定': 'Rate Left (A) as Gd (Good)',
    '左(A)の評価を「可（解除）」に設定': 'Reset Left (A) to Nm (Normal)',
    '左(A)に「棄」を設定': 'Rate Left (A) as Rj (Reject)',
    '右(B)に「優」を設定': 'Rate Right (B) as Ex (Excellent)',
    '右(B)に「良」を設定': 'Rate Right (B) as Gd (Good)',
    '右(B)の評価を「可（解除）」に設定': 'Reset Right (B) to Nm (Normal)',
    '右(B)に「棄」を設定': 'Rate Right (B) as Rj (Reject)',

    // --- 🏆 勝ちレンズ・得意設定カルテ (lab.js: Kami-Lens Karte) ---
    '勝ちレンズ・得意設定カルテ（パーソナル撮影ラボ）': 'Kami-Lens Karte (Personal Photo Lab)',
    'これまでの評価（🏅優・👍良）から、あなたと最も相性の良い機材・焦点距離・F値・時間帯を診断します': 'Diagnoses your best-performing lenses, bodies, golden focal lengths, apertures & shooting hours from your Ex/Gd ratings',
    '🏆 勝ちレンズ＆カメラ番付': '🏆 Kami-Lens & Body Banzuke',
    '📐 黄金の焦点距離 & F値分析': '📐 Golden Focal & F-Stop',
    '🕰️ 撮影時間帯 & 光の傾向': '🕰️ Golden Hour & Rhythm',
    '分析対象写真': 'Analyzed Photos',
    '🏅「優」獲得数 / 打率': '🏅 "Ex" Count / Hit Rate',
    '👍 好評価（優＋良）率': '👍 Keeper Rate (Ex + Gd)',
    '🌅 薄明マジック＆ブルー': '🌅 Golden & Blue Hour',
    '🔭 レンズ別「🏅優」獲得打率ランキング': '🔭 Kami-Lens "🏅Ex" Hit-Rate Banzuke',
    '📷 カメラボディ別 歩留まり番付': '📷 Camera Body Yield Banzuke',
    '🔍 このレンズで絞り込む': '🔍 Filter by Lens',
    '🔍 このカメラで絞り込む': '🔍 Filter by Body',
    '🔍 絞り込む': '🔍 Filter',
    '撮影枚数シェア': 'Shot Share',
    '💡 あなたの黄金スイートスポット診断': '💡 Your Golden Sweet-Spot Diagnosis',
    '📐 焦点距離5区分別 枚数 &「🏅優」打率': '📐 Shots & "🏅Ex" Hit Rate by Focal Length',
    '超広角 〜 超望遠': 'Ultra-Wide to Super-Telephoto',
    '🔆 F値（絞り）5区分別 枚数 &「🏅優」打率': '🔆 Shots & "🏅Ex" Hit Rate by Aperture (F-Stop)',
    '開放ボケ 〜 パンフォーカス・小絞り': 'Wide-Open Bokeh to Deep Focus',
    '🕰️ あなたのゴールデンタイム分析': '🕰️ Your Golden Time Analysis',
    '📊 24時間シャッターリズム（0時〜23時）': '📊 24-Hour Shutter Rhythm (00:00 – 23:00)',
    '総撮影枚数': 'Total Shots',
    '🏅優 獲得枚数': '🏅Ex Shots',
    '🔭 太陽高度（天文計算）＆ 露出条件でワンクリック抽出': '🔭 One-Click Filter by Solar Altitude & Shake Risk',
    '🧪 撮影カルテを集計中...': '🧪 Analyzing your Kami-Lens Karte...',
    'レンズ・カメラ情報が記録された写真がありません': 'No photos with recorded camera/lens EXIF found',

    // --- 🗾 47都道府県 制覇マップ (location_map.js: Seiha Map & Osanpo Trail) ---
    'ジオタグ全国制覇マップ ＆ 撮影密度ヒートマップ ＆ 撮影さんぽ軌跡': '47-Prefecture Seiha Map, Density Heatmap & Osanpo Trail',
    '47都道府県の撮影制覇状況・よく撮るホットスポット・1日のフォトラリー移動軌跡を可視化します': 'Visualize your 47-prefecture conquest, favorite photo hotspots, and daily Osanpo photo walk trails',
    '🗾 47都道府県 撮影制覇白地図': '🗾 47-Pref Seiha Map',
    '🔥 撮影密度ヒートマップ': '🔥 Density Heatmap',
    '👣 撮影さんぽ軌跡ライン': '👣 Osanpo Trail',
    '🗾 全国47都道府県 制覇率': '🗾 47-Prefecture Seiha Rate',
    '📍 総ジオタグ写真枚数': '📍 Total Geotagged Shots',
    '🏅 制覇ランク称号': '🏅 Seiha Explorer Rank',
    '👑 全国47都道府県 完全制覇グランドマスター': '👑 47-Prefecture Complete Seiha Grandmaster',
    '🏯 日本列島制覇マイスター': '🏯 Archipelago Seiha Meister',
    '🚅 全国縦断フォトトラベラー': '🚅 Cross-Country Photo Traveler',
    '🗺️ 旅するフォトグラファー': '🗺️ Wandering Photographer',
    '📷 地域開拓エクスプローラー': '📷 Regional Photo Explorer',
    '🌱 撮影旅の始まり': '🌱 Beginning of the Photo Journey',
    '🧭 未踏の地図（GPS写真をスキャンしよう）': '🧭 Uncharted Map (Scan GPS photos!)',
    '塗り分け基準:': 'Color By:',
    '📷 撮影枚数モード': '📷 Total Shots',
    '🏅 優枚数モード': '🏅 "Ex" Shots',
    '🚩 制覇済': '🚩 Conquered',
    '未訪問': 'Unvisited',
    '📷 総撮影枚数': '📷 Total Shots',
    '🏅 優 / 打率': '🏅 Ex / Hit Rate',
    '👍 良 (Good) 枚数': '👍 Gd (Good) Shots',
    'この都道府県のジオタグ付き写真はまだ登録されていません': 'No geotagged photos registered for this prefecture yet',
    '🌏 国・地域別クイック絞り込み:': '🌏 Filter by Country / Region:',
    '📅 撮影日を選択:': '📅 Select Walk Date:',

    // --- 📤 スマート・テイクアウト & 🎞️ ベタ焼きHTML ---
    '📤 スマート・テイクアウト': '📤 Smart Takeout',
    'スマート・テイクアウト...': 'Smart Takeout...',
    '元ファイルを非破壊のまま、回転・水平出し・クロップ・トーン・解像度・Exifを整えて出力': 'Non-destructively export photos with rotation, horizon level, crop, tone, resize & Exif control',
    '元の写真ファイルは一切変更されず、指定のフォルダへ新しく書き出されます': 'Original files are never modified; new copies are exported to the destination folder',
    '✂️ 非破壊調整・DB情報の反映': '✂️ Apply Non-Destructive Edits & DB Sync',
    '回転・水平出し・クロップ・トーン微調整を反映して出力': 'Bake rotation, horizon tilt, crop & tone adjustments into exported files',
    '🔄 DBの位置情報（GPS）・向きをExifへ同期して書き込む': '🔄 Sync DB GPS coordinates & orientation into exported EXIF',
    '📐 解像度・サイズ': '📐 Resolution / Long Edge Resize',
    'オリジナル解像度（リサイズなし）': 'Original Resolution (No Resize)',
    '4K Ultra HD (長辺 3840px)': '4K Ultra HD (Long edge 3840px)',
    'フルHD (長辺 1920px)': 'Full HD (Long edge 1920px)',
    'SNS/Web標準': 'SNS / Web',
    '軽量 (長辺 1280px)': 'Light (Long edge 1280px)',
    'メール/共有': 'Mail / Share',
    'カスタム長辺:': 'Custom Long Edge:',
    '🖼️ 保存フォーマット & 画質': '🖼️ Output Format & Quality',
    '圧縮品質:': 'Quality:',
    '📝 ファイル名ルール': '📝 File Naming Rule',
    '元のファイル名を維持': 'Keep Original Filename',
    '撮影日時 ＋ 元ファイル名': 'Date Taken + Original Name',
    '撮影日時 ＋ 3桁連番': 'Date Taken + 3-Digit Seq',
    '自由名 ＋ 連番:': 'Custom Prefix + Seq:',
    '_001.jpg (秒数順)': '_001.jpg (Time Order)',
    '🔒 Exif メタデータの消去': '🔒 Strip EXIF Metadata (Privacy)',
    '※全オフならExifを完全維持': '*All OFF keeps full EXIF',
    '🗑️ すべて（Exifメタデータを完全消去）': '🗑️ Strip All EXIF Metadata',
    '📍 位置情報（GPS座標・ジオタグ）': '📍 Strip GPS Coordinates & Location',
    '⏱️ 撮影条件（SS・F値・ISO感度・露出・焦点距離）': '⏱️ Strip Exposure Settings (SS, F-Stop, ISO, Focal)',
    '📷 カメラ・機材情報（メーカー・機種・レンズ・シリアル）': '📷 Strip Camera & Lens Model / Serial',
    '🏷️ その他（コメント・説明文・著作権・サムネイル等）': '🏷️ Strip Others (Comments, Copyright, Embedded Thumb)',
    '📂 保存先フォルダ': '📂 Destination Folder',
    '📁 フォルダ選択...': '📁 Browse...',
    '完了後にエクスプローラーでフォルダを開く': 'Open destination folder in Explorer when finished',
    'エクスポートを準備中...': 'Preparing export...',
    '写真を出力しています...': 'Exporting photos...',
    '完了しました！': 'Export Complete!',
    'テイクアウト開始': 'Start Takeout',
    'ベタ焼きHTML出力...': 'Betayaki HTML...',
    '暗室コンタクトシート・A4印刷対応': 'Darkroom Contact Sheet (A4 Print)',

    // --- 右クリックメニュー & 下部フローティングバー ---
    '🏷️ タグを付ける': '🏷️ Add Tags',
    'タグを付ける': 'Add Tags',
    '新しいタグ名...': 'New tag name...',
    '付与': 'Add',
    '既存タグから選択': 'Select from Existing Tags',
    '📤 テイクアウト': '📤 Takeout',
    'テイクアウト': 'Takeout',
    '回転・クロップ・Exif制御': 'Crop, Rotate & Exif',
    '回転・クロップ・解像度・Exif制御': 'Crop, Resize & Exif',
    '新規フォルダ名...': 'New folder name...',
    '作成&送信': 'Create & Copy',
    'take_outフォルダを開く': 'Open take_out Folder',
    '送信先フォルダ': 'Destination Subfolders',
    '🏅 評価を設定': '🏅 Set Rating',
    '評価設定': 'Rate',
    '⭐ 評価を一括設定': '⭐ Batch Set Rating',
    '✂ 調整と回転': '✂ Adjust & Rotate',
    '↻ 右へ回転 (R)': '↻ Rotate 90° CW (R)',
    '↺ 左へ回転 (L)': '↺ Rotate 90° CCW (L)',
    '✂ 切り抜き・微調整 (C)': '✂ Crop, Tilt & Tone (C)',
    '↺ 回転・調整をリセット': '↺ Reset Adjustments',
    '回転': 'Rotate',
    '↻ 写真を一括回転': '↻ Batch Rotate Photos',
    '右へ90° (R)': '90° CW (R)',
    '左へ90° (L)': '90° CCW (L)',
    '回転・調整をリセット': 'Reset Adjustments',
    '🔄 サムネイルを更新': '🔄 Refresh Thumbnail',
    'サムネイル更新': 'Refresh Thumb',
    '🔍 プレビューを開く': '🔍 Open in Lightbox',
    '🗑️ ライブラリから削除': '🗑️ Remove from Library',
    '削除': 'Remove',
    '✕ 選択を解除': '✕ Deselect',
    '🔄 このフォルダを再スキャン（直下のみ）': '🔄 Rescan Folder (Direct Only)',
    '🔄 配下も含めて再スキャン': '🔄 Rescan Folder (Include Subfolders)',
    '♻️ リフレッシュ（再スキャン＋消失写真のDB削除）': '♻️ Refresh (Rescan + Clean Missing)',
    '🤖 AIタグ付け': '🤖 Auto-Tag Folder with AI',
    '➖ 管理から外す（DB登録解除）': '➖ Unregister from Library',
    '🚫 管理対象外（除外）に設定': '🚫 Ignore Folder',
    '↩️ 除外を解除（未管理に戻す）': '↩️ Unignore Folder',
    '📁 エクスプローラーで開く': '📁 Open in Explorer',

    // --- 各種モーダル（終了・DBメンテナンス・フォルダ登録・タグ削除・スマホ連携） ---
    '⏻ Photo Manager の終了': '⏻ Quit Photo Manager',
    'サーバー停止の確認': 'Confirm Server Shutdown',
    'サーバーを停止して終了しますか？': 'Stop server and quit Photo Manager?',
    'バックエンドサーバーを安全に停止し、データベースを完全にクローズして終了します。': 'Safely stops the local backend server and closes the SQLite database.',
    '💡 終了後にUSBメモリをPCから安全に取り外せます。': '💡 You can safely unplug your USB drive after quitting.',
    'サーバーを停止して終了': 'Stop Server & Quit',
    '停止処理中...': 'Stopping...',
    '⚙️ データベースメンテナンス': '⚙️ Database Maintenance',
    'ライブラリDBの最適化・世代バックアップ管理': 'Optimize SQLite DB & Manage Backups',
    '📊 データベースの状態': '📊 Database Status',
    '🧹 データベース最適化 (VACUUM)': '🧹 Optimize Database (VACUUM)',
    '不要領域を解放してファイルサイズを縮小し、読み書きを高速化します': 'Reclaims unused space, shrinks DB size, and speeds up queries',
    '最適化を実行': 'Run VACUUM',
    '💾 データベースのバックアップ': '💾 Database Backup',
    '確認中...': 'Checking...',
    '今すぐ作成': 'Backup Now',
    '📂 保存先フォルダを開く': '📂 Open Backup Folder',
    '📂 フォルダの管理登録': '📂 Register Folder to Library',
    'ライブラリへのフォルダ追加': 'Add folder to Photo Manager library',
    '登録範囲を選択してください。サブフォルダの写真もまとめて登録する場合は「子フォルダを含む」を選択してください。': 'Choose scan depth. Select "Include Subfolders" to scan nested folders as well.',
    '直下のみ': 'Direct Only',
    '子フォルダを含む': 'Include Subfolders',
    '🏷️ タグの完全削除': '🏷️ Delete Tag from Library',
    'ライブラリ全体からのタグ除去': 'Remove tag from all photos',
    '※ 写真ファイル自体は削除されません。': '* Original photo files are never deleted.',
    'タグを削除': 'Delete Tag',
    '📱 スマホ（Android）選別連携 & USB抜き差しガイド': '📱 Mobile Cull (/m) & USB Sync Guide',
    'ネットワーク設定不要・USBメモリ1本で安全に持ち出し＆自動反映': 'Cull on phone via Wi-Fi QR or offline USB drive',
    '⚡ 未反映のスマホ選別データ (mobile_sync.json) を検出しました': '⚡ Detected unapplied mobile culling data (mobile_sync.json)',
    '今すぐPCに反映': 'Apply to PC Now',
    '✅ 直近のスマホ選別データ取り込み実績': '✅ Last Applied Mobile Sync',
    '💻 PCでスマホ画面を試す': '💻 Preview /m on PC',
    '📥 単体HTMLを保存': '📥 Save Standalone HTML',
    '📋 コピー': '📋 Copy',
    '📥 手動で選別データを取り込む場合:': '📥 Manual Sync Import:',
    '📋 クリップボードから反映': '📋 Paste from Clipboard',
    '📂 mobile_sync.json を選択して取り込む': '📂 Import mobile_sync.json',
    '📱 スマホ選別データの取り込み完了': '📱 Mobile Sync Applied!',
    '反映された写真の内訳:': 'Updated Photos:',
    '✅ 確認 (OK)': '✅ OK',
    '写真をドロップして追加': 'Drop Photos to Import',
    'JPEG, PNG, WebP などの画像ファイルをここにドロップしてください': 'Drop JPEG, PNG, WebP or RAW files here to copy into library',

    // --- ヘルプモーダル タブ見出し & フッター & Overview / Shortcuts ---
    '📖 Photo Manager 操作マニュアル & ヘルプ': '📖 Photo Manager User Manual & Help',
    '初めての方から応用・スマホ連携まで、目的に合わせて読めるレベル別ガイド': 'Complete guide from basic 1-hand culling to Lab Karte, Duel & Mobile USB sync',
    '💡 はじめに': '💡 Overview',
    '🟢 Basic編 (基本)': '🟢 Basics',
    '🔵 Advance編 (応用)': '🔵 Advanced & Lab',
    '🟣 Mobile & USB編': '🟣 Mobile & USB',
    '⌨️ ショートカット & FAQ': '⌨️ Shortcuts & FAQ',
    '💡 Photo Manager へようこそ — 安心・軽快なローカル写真管理': '💡 Welcome to Photo Manager — Fast, Safe & Portable Local Photo Culling',
    '🛡️': '🛡️',
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
    '🚀 はじめての4ステップ': '🚀 Quick 4-Step Start',
    '📂 フォルダ登録': '📂 1. Scan Folder',
    '左サイドバー「📁 フォルダ」から写真が入ったフォルダをクリックします。': 'Click a photo folder under "📁 Folders" in the left sidebar.',
    '🎯 数字キーで選別': '🎯 2. Rate with Keys',
    '🔍 拡大・ピント確認': '🔍 3. Zoom & Check Focus',
    '📤 書き出し・活用': '📤 4. Export & Share',
    '選んだ写真を「📤 テイクアウト」でまとめたり、「📁」で現像ソフトへ渡します。': 'Export via "📤 Takeout" or pass RAW files directly to your developer app.',
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
    '❓ よくある質問（FAQ）': '❓ Frequently Asked Questions (FAQ)',
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
    '⚡ 露出ブラケット:': '⚡ Exposure Bracket:',
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
    '🟢 ① 自宅Wi-Fi: QRコードでスマホ版 (': '🟢 1. Home Wi-Fi: Scan QR to Open Mobile View (',
    ') に入る': ')',
    '🔌 ② USB持ち出し選別: USB抜き差し＆JSON反映の4ステップ': '🔌 2. Offline USB Culling: 4-Step USB Plug & Sync Guide',
    '【Step 1】PCからUSBを抜くとき': '[Step 1] Before Unplugging USB from PC',
    '【Step 2】スマホにUSBを挿して写真を読み込む': '[Step 2] Plug USB into Phone & Load DB',
    '【Step 3】選別結果をUSBに保存してスマホから抜く（⚠️最重要）': '[Step 3] Save mobile_sync.json & Safely Unmount USB (⚠️ Crucial)',
    '【Step 4】PCにUSBを挿して起動すると自動反映＆通知！': '[Step 4] Plug USB Back into PC for Auto-Sync!',
    'PC画面右上の': 'Click the top-right',
    '「⏻ 終了」ボタン': '"⏻ Quit" button',
    'から「サーバーを停止して終了」を実行し（ウィンドウの「×」だけではバックグラウンド常駐が維持されます）、Windowsタスクバー右下の「ハードウェアの安全な取り外し」を行ってからUSBメモリを抜きます。': 'and choose "Stop Server & Quit", then use Windows "Safely Remove Hardware" before unplugging the USB drive.',
    'スマホにUSBを挿し、「ファイル」アプリでUSB内の': 'Plug the USB into your phone, open',
    'を開きます。続けて': 'in the Files app, then tap',
    '「📂 library.db を読み込む」': '"📂 Load library.db"',
    'から': 'and select',
    '（現在': ' (currently ',
    '）を選ぶと全写真が表示され、親指で高速選別できます（選別中はUSBを挿したままでOKです）。': ') to browse and cull all photos with your thumb.',
    '選別が終わったらスマホ画面右上の「📂 DB/同期」から': 'When finished, tap "📂 DB/Sync" →',
    '「💾 mobile_sync.json を保存する」': '"💾 Save mobile_sync.json"',
    'でUSB直下に保存します。': 'to save to the USB root folder.',
    '「✅ 書き込み・クローズ完了」': '"✅ Write & Close Complete"',
    'と表示されたら、スマホ画面上の通知バーから': 'appears, open the phone notification bar and tap',
    '「USBドライブを取り外す（マウント解除）」': '"Unmount / Eject USB Drive"',
    'を必ずタップしてからUSBを抜いてください。': 'before unplugging the USB drive.',
    'USBをPCに挿して': 'Plug the USB into your PC and launch',
    'を起動すると、自動的に': '—',
    'が取り込まれ、画面中央に': 'is automatically imported and the',
    '「📱 スマホ選別データの取り込み完了」通知ウィンドウ': '"📱 Mobile Sync Applied!" dialog',
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
    '波形': 'Wave',
    '階調・露出': 'Tone & Hist',
    '📊 ヒストグラムを表示 (H)': '📊 Show Histogram (H)',
    '📊 ヒストグラムを隠す (H)': '📊 Hide Histogram (H)',
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

    '代表に設定': 'Crown',
    'この写真を一覧の代表写真にする': 'Set this photo as the stack primary (Crown)',
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
    '🔗 実体パス未登録': '🔗 Unlinked Path',
    '🔗 実体パス未登録（リンク消失）': '🔗 Unlinked Path (File Moved/Missing)',
    '実体ファイルとの紐付けが外れています': 'Source file link is missing',
    '📍 近隣のジオタグ付き写真 (±60分)': '📍 Nearby Geotagged Photos (±60 min)',
    '🎯 直前 / 直後の候補から選ぶ': '🎯 Choose Before / After Candidate',
    'この位置を採用': 'Use This GPS',
    '±60分以内にGPS付き写真が見つかりませんでした。': 'No geotagged photos found within ±60 minutes.',
    'スマホで撮影した写真をスキャンしてみてください。': 'Try scanning photos taken with your smartphone.',
    '📷 不明': '📷 Unknown',

    '🟢 接続中の写真': '🟢 Online Photos',
    '⚪ 未接続の写真': '⚪ Offline Photos',
    '🔗 リンク消失の写真（実体パス未登録）': '🔗 Unlinked Photos (Missing Source Path)',
    '📋 重複のある写真': '📋 Duplicate Photos',
    '🏷️ 未分類の写真': '🏷️ Untagged Photos',
    '🏷️ 未分類': '🏷️ Untagged',
    '🟢 接続中のみ': '🟢 Online Only',
    '⚪ 未接続のみ': '⚪ Offline Only',
    '🧪 マジックアワー': '🧪 Golden Hour',
    '🧪 ブルーアワー': '🧪 Blue Hour',
    '🧪 マジック＋ブルー': '🧪 Golden & Blue',
    '🧪 夜景・星景': '🧪 Night & Astro',
    '🧪 手ブレ注意': '🧪 Lens Shaker',
    '🗺️ ジオタグなしの写真': '🗺️ Photos Without Geotag',
    'クイックアクセスを開く': 'Open Quick Access',
    'RAW+JPEGペア写真': 'RAW + JPEG Pair',
    'なし': 'None',
    '含む': 'Include',
    '⚪ 可（解除）': '⚪ Nm (Reset)',
    'サムネイル取得': 'Fetch Thumb',
    'サムネイルを取得': 'Fetch Thumbnails',
    'サムネイルを更新': 'Refresh Thumbnails',
    '選択中の写真のサムネイルを取得します': 'Generate thumbnails for selected photos',
    '選択中の写真のサムネイルを更新します': 'Regenerate thumbnails for selected photos',
    'take_out (直下)': 'take_out (Root)',
    '登録済みタグがありません': 'No registered tags',
    'その他のAIタグはありません': 'No other AI tags',
    'その他のタグなし (＋で作成)': 'No other tags (Click + to create)',
    '日付情報なし': 'No date info',
    'カメラ情報なし': 'No camera info',
    '🔌 [未接続]': '🔌 [Offline]',
    '⚠️ [消失]': '⚠️ [Missing]',
    '🚫 [除外]': '🚫 [Ignored]',
    '📁 [未登録]': '📁 [Unregistered]',
    '➕ 配下をスキャンして管理に追加': '➕ Scan & Add to Library',
    'サブフォルダはありません': 'No subfolders',
    '読み込みに失敗しました': 'Failed to load',
    '取得に失敗しました': 'Failed to load',
    '🔍 写真ファイルを検索中...': '🔍 Finding photo files...',
    '⚡ 連写・露出グループ化中...': '⚡ Grouping bursts & brackets...',
    '📂 写真スキャン中...': '📂 Scanning photos...',
    '🔍 スキャン準備中...': '🔍 Preparing scan...',
    '✅ スキャン完了': '✅ Scan Complete',
    'バックアップ: まだ作成されていません': 'Backup: None created yet',
    '⏳ 最適化中...': '⏳ Optimizing...',
    '🧹 データベースの最適化（VACUUM）が完了しました': '🧹 Database VACUUM optimization complete',
    '⏳ 作成中...': '⏳ Creating...',
    '✅ 管理中のフォルダ': '✅ Managed Folder',
    '🚫 管理対象外（除外）': '🚫 Ignored Folder',
    '未登録のフォルダ（右クリックで管理に追加）': 'Unregistered Folder (Right-click to add & scan)',
    '● 配下に管理フォルダがあります': '● Contains managed subfolders',
    '🔌 未接続のドライブ上のフォルダです（キャッシュのみ）': '🔌 Folder on offline drive (Cached thumbnails only)',
    '⚠️ ライブラリに写真がありますが、実フォルダが見つかりません': '⚠️ Photos in library, but physical folder is missing',
    '保存済みのサムネイルで閲覧・絞り込みができます': 'You can browse and filter using cached thumbnails',
    'スキャン完了後にAI自動タグ付けを実行します（クリックでOFF）': 'Auto AI-Tagging after scan is ON (Click to turn OFF)',
    'スキャン完了後にAI自動タグ付けを実行しません（クリックでON）': 'Auto AI-Tagging after scan is OFF (Click to turn ON)',
    '🤖 スキャン後のAI自動タグ付けを有効にしました': '🤖 Enabled Auto AI-Tagging after scan',
    '🤖 スキャン後のAI自動タグ付けを無効にしました': '🤖 Disabled Auto AI-Tagging after scan',

    '⚖️ 2枚並べて比較 (V)': '⚖️ Duel (V)',
    '2枚並べてピント・構図・露出を比較 (Vキー)': 'Compare focus, framing & exposure side-by-side (V key)',
    '選択中の写真を左右2枚並べて同時ズーム比較します (Vキー)': 'Compare selected photos side-by-side with sync zoom (V key)',
    '比較画像 A': 'Compare Image A',
    '比較画像 B': 'Compare Image B',
    '💡 サムネイルを': '💡 Thumbnail: ',
    'クリックで 🔍右(B)': 'Click → 🔍Right (B)',
    'に表示 ／': ' / ',
    'Shift+クリックで 📌左(A)': 'Shift+Click → 📌Left (A)',
    'に固定 ／': ' / ',
    'Alt+ドラッグ・ホイール': 'Alt+Drag/Wheel',
    'で一時的に片方だけ操作': ' for independent pan/zoom',
    '比較できる写真がありません': 'No photos available to compare',
    '比較するには2枚以上の写真が必要です': 'At least 2 photos are required for Duel comparison',
    '点灯している項目が左右で連動します（Altキー押下中は一時的に片側のみ操作）': 'Active toggles sync Left & Right (Hold Alt for independent control)',
    'ビュー位置（ドラッグ移動）を左右で同期します。OFFにすると片方だけドラッグして構図のズレを合わせられます': 'Sync pan position between A & B. Turn OFF to align framing offset independently',
    'ズーム倍率（ホイール拡大）を左右で同期します。OFFにすると片方だけ倍率を変えて被写体の大きさを揃えられます': 'Sync zoom level between A & B. Turn OFF to match subject scale independently',

    '連写スタートコマ (0.000s)': 'Burst Start Frame (0.000s)',
    '🤖 解析中...': '🤖 Analyzing...',
    '🤖 この写真に該当するタグは見つかりませんでした': '🤖 No matching AI tags found for this photo',
    '一時停止 (Space)': 'Pause (Space)',
    '再生 (Space)': 'Play (Space)',
    '表示中の写真': 'Current Photos',
    'スライドショーの対象写真がありません': 'No photos available for slideshow',
    '表示できる写真がありません': 'No photos to display',

    '優 (Excellent) 枚数': 'Ex (Excellent) Shots',
    '良 (Good) 枚数': 'Gd (Good) Shots',
    'このカメラ＆レンズの組み合わせでメイングリッドを絞り込む': 'Filter main grid by this Camera + Lens combo',
    'まだ時間帯別の撮影データが十分にありません。': 'Not enough hourly shooting data yet.',
    '焦点距離は': 'Your sweet spot is ',
    '、最も「🏅優」が生まれやすいあなたのゴールデンタイムは': ', and your highest "🏅Ex" hit-rate Golden Time is ',
    '最も多くシャッターを切る時間帯は': 'Your most active shutter hour is ',
    'です！': '!',
    '🎉 未整理（評価：可）の写真が残っているフォルダはありません！すべて整理済みです。': '🎉 All folders are culled! No unrated (Nm) photos left.',

    '少': 'Low',
    '多（クリックで都道府県絞り込み）': 'High (Click prefecture to filter)',
    '🔥 撮影密度が高い場所ほど': '🔥 Higher shooting density glows ',
    '青緑 ➔ 黄 ➔ 橙 ➔ 朱赤（#e14d2a）': 'Teal ➔ Yellow ➔ Orange ➔ Vermilion (#e14d2a)',
    'に輝きます。サークルをクリックすると地域で絞り込めます。': '. Click any circle to filter by area.',
    '🌐 主要な撮影軌跡すべて (最新1,500枚)': '🌐 All Major Photo Trails (Latest 1,500 shots)',
    '撮影スポット': 'Photo Spot',
    '撮影枚数:': 'Shots:',
    '/ 🏅優:': '/ 🏅Ex:',
    '👣 総移動距離:': '👣 Total Distance:',
    '⏱️ 所要時間:': '⏱️ Duration:',
    '👟 歩数換算目安:': '👟 Est. Steps:',
    '🔥 滞在ホットスポット:': '🔥 Stay Hotspots:',
    '🔍 この写真を表示': '🔍 View Photo',
    '🏅優': '🏅Ex',
    '👍良': '👍Gd',
    '⚪可': '⚪Nm',
    '🗾 全国制覇マップ＆軌跡データを集計中...': '🗾 Building Seiha Map & Osanpo Trail...',
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
    '次回は': 'Next time, launch from ',
    'から一瞬で起動できます。': ' for instant startup.',
    '🛑 サーバーを停止しています...': '🛑 Stopping server...',
    '✅ サーバーを停止しました。ウィンドウを閉じます。': '✅ Server stopped. Closing window...',
    '🔄 ドライブ・フォルダの接続状態を確認中...': '🔄 Checking drive & folder connection status...',
    '接続状態を更新しました': 'Connection status updated',
    '↩️ 除外を解除しました': '↩️ Unignored folder',
    '取り込み中...': 'Importing...',
    '反映中...': 'Applying...',
    '📁 フォルダを開きました': '📁 Opened folder in Explorer',
    'フォルダを開けませんでした': 'Could not open folder',
    '🖼️ 規定のアプリで写真を開きました': '🖼️ Opened photo in default app',
    'ファイルを開けませんでした': 'Could not open file',
    'RAWファイルを開けませんでした': 'Could not open RAW file',
    '📍 スマホ写真からジオタグを準用しました': '📍 Copied GPS from nearby phone photo',
    '🗑️ ジオタグ情報を削除しました': '🗑️ Cleared GPS data from DB',
    '画像の調整を保存しました': 'Saved image adjustments',
    '調整を初期状態に戻しました': 'Reset adjustments to default',
    '回転・調整をリセットしました': 'Reset rotation & adjustments',
    '📂 take_outフォルダを開きました': '📂 Opened take_out folder',
    '🎞️ ベタ焼きHTML（コンタクトシート）を生成中...': '🎞️ Generating Betayaki Contact Sheet HTML...',

    // ヘルプモーダル (#helpModal) 全タブ詳細テキスト・テーブル・FAQ
    '大量の写真（JPEG / PNG / WebP / HEIC および各社一眼カメラの RAW データ）を、待ち時間ゼロで閲覧・選別・整理できる写真ビューアです。':
      'A zero-latency photo viewer & culling tool for large libraries (JPEG / PNG / WebP / HEIC and camera RAW files).',
    '目的に合わせて上部の': 'Switch between the ',
    '「🟢 Basic編」「🔵 Advance編」「🟣 Mobile & USB編」': '"🟢 Basic", "🔵 Advance", and "🟣 Mobile & USB"',
    'タブを切り替えてご覧ください。': ' tabs above to explore features by level.',
    '数字キーの': 'Press number keys',
    '（優）、': ' (Ex), ',
    '（良）、': ' (Gd), ',
    '（棄）、': ' (Rj), or ',
    '（可）を押すだけで視線を外さず高速仕分け。「棄」にした写真は一覧から自動で隠れます（いつでも再表示・復活可能）。':
      ' (Nm) for rapid culling without taking your eyes off the photo. "Rj (Reject)" photos are automatically hidden from the grid (and can be shown or restored anytime).',
    '連写や露出ブラケット、別フォルダにコピーされた同じ写真も自動で「1つの束（スタック）」に集約。一覧画面が同じ写真で埋め尽くされず、拡大時に':
      'Burst shots, exposure brackets, and duplicate copies across folders are automatically grouped into a single "Stack" so your grid stays clean. In Lightbox, press',
    'キーで瞬時に見比べられます。': 'to flip through the stack.',
    '斜めの水平線補正（': 'Straighten tilted horizons (',
    'キー）や露出補正を元ファイル無傷で行い、「📤 スマート・テイクアウト」でリサイズや撮影順の連番リネーム、プライバシー保護（Exif消去）を掛けて別フォルダへ一括出力できます。':
      'key) and fine-tune exposure non-destructively, then batch-export via "📤 Smart Takeout" with resizing, chronological renaming, and Exif privacy scrubbing.',
    '重たい元写真は自宅に置いたままカタログ（USB）だけを持ち歩けます。さらに自宅Wi-Fi（QRコード）や外出先のUSB直接接続で、スマホの親指操作だけで写真をサクサク選別・同期できます。':
      'Carry just your USB catalog while leaving terabytes of RAWs at home. Cull with one thumb on your phone via home Wi-Fi (QR code) or offline USB OTG, then sync back.',
    '画面上部のツールバーから、ワンクリックで3つの表示モードを切り替えられます。左上の「📜 和紙 ／ 🌙 夜墨（Washi / Urusi）」ボタンで明るい画面・暗い画面の切り替え、さらに隣の「🇯🇵 JP ／ 🇺🇸 EN」ボタンで日本語・英語UIのリアルタイム切り替えも可能です。':
      'Switch between 3 layout modes from the top toolbar. Toggle light/dark themes with "📜 Washi / 🌙 Urusi" at the top-left, or switch languages anytime with "🇯🇵 JP / 🇺🇸 EN".',
    '（優）・': ' (Ex), ',
    '（良）・': ' (Gd), ',
    '（棄）キーで片手でサクサク仕分けます。': ' (Rj) keys to cull one-handed.',
    'キーで拡大。ホイール操作でピントや表情をチェックします。': 'key to open Lightbox. Scroll the mouse wheel to check focus and expressions.',
    '1. 起動と終了のしかた（2つの閉じかた）': '1. Launching & Closing (2 Ways to Exit)',
    '🚀 起動:': '🚀 Launch:',
    'フォルダ内の': 'Double-click',
    'をダブルクリックすると専用ウィンドウ（最大化状態）が開きます。': 'in the folder to open the dedicated app window (maximized).',
    '※初回起動時に SmartScreen の確認画面が出た場合や': '* If Windows SmartScreen appears on first launch or',
    'が見当たらない場合は、フォルダ内の': 'is missing, double-click',
    'をダブルクリックするとお使いのPC上で': 'in the folder to cleanly build',
    'と': 'and',
    'がクリーンに生成されてそのまま起動します。': 'right on your PC and launch immediately.',
    '⏻ 完全終了（USBを抜く前など）:': '⏻ Full Shutdown (Before unplugging USB):',
    '画面右上の': 'Click the top-right',
    '→「サーバーを停止して終了」を選びます。': '→ "Stop Server & Exit".',
    '× 画面だけ閉じる（高速起動待機）:': '× Close Window Only (Instant Standby):',
    'ウィンドウ右上の「×」で閉じると裏で待機状態になり、次回': 'Closing with the top-right "×" keeps the server on standby so the next',
    'を開いたときに': 'launch restores the window in',
    '0.1秒': '0.1 sec',
    'で画面が復元します（Windows右下のタスクトレイのアイコンから完全終了もできます）。': '(you can also fully exit from the Windows system tray icon).',
    '2. 写真フォルダを登録する・更新する': '2. Adding & Refreshing Photo Folders',
    '📂 新しく登録する:': '📂 Add a Folder:',
    '左サイドバーの': 'Open',
    '「📁 フォルダ」': '"📁 Folders"',
    'を開き、パソコンや外付けドライブのツリーから写真フォルダをクリックします。「子フォルダを含む（おすすめ）」か「直下のみ」を選ぶと、すぐ下に進行バーが出て取り込みが始まります。':
      'in the left sidebar and click any folder in your PC or external drive tree. Choose "+ Sub (Recommended)" or "Direct" to start importing with a live progress bar.',
    '🔄 写真を追加・削除したあと:': '🔄 After Adding/Deleting Files:',
    '登録済みのフォルダを左サイドバーでクリックするだけで、アプリが自動で変化を検知し「ライブラリをリフレッシュ（最新化）しますか？」と案内してくれます。':
      'Simply click the registered folder in the left sidebar—the app automatically detects changes and prompts you to refresh the library.',
    '3. 片手でサクサク！写真の選別（4段階評価）': '3. One-Handed 4-Tier Culling (Ex / Gd / Nm / Rj)',
    '写真を選んでキーボードの数字キー（またはテンキー）を押すだけで、視線を動かさずに仕分けられます。':
      'Select a photo and press the number keys (or Numpad) to rate shots without taking your eyes off the image.',
    'キー：': 'key: ',
    '（ベストショット！現像やSNS投稿したい最優秀カット）': ' (Best shot! Top picks for editing or sharing)',
    '（お気に入り・合格カット）': ' (Good / Keeper shot)',
    'または': 'or',
    '（ピンボケ・目つぶり等のボツ写真。': ' (Out-of-focus / blink / reject. ',
    '一覧から自動で隠れます': 'Automatically hidden from grid',
    '（評価を取り消して初期状態に戻す）': ' (Clear rating / reset to Normal)',
    '「棄」にした写真を見返すには？': 'How do I view "Rj (Reject)" photos again?',
    'ファイル自体は削除されていません。上部ツールバーの': 'Your files are never deleted from disk. Click the',
    '「🗑️ 棄」': '"🗑️ Rj"',
    'ボタンをクリックして点灯させればいつでも再表示でき、': 'toggle button on the top toolbar to reveal rejected shots anytime, and press',
    'キーで復活できます。': 'to restore them.',
    '4. 拡大してピントを確認する（ライトボックス）': '4. Full-Screen Focus Check (Lightbox)',
    '写真をダブルクリックするか、選んで': 'Double-click a photo or press',
    'キーを押すと全画面で拡大表示します（RAWデータも待ち時間ゼロで高画質表示されます）。': 'to open full-screen Lightbox (camera RAW files also render with zero wait).',
    '前後の写真へ移動:': 'Prev / Next Photo:',
    'キーボードの': 'Press',
    '（または画面下部のフィルム帯でホイール）': '(or scroll the mouse wheel over the bottom filmstrip)',
    '連写・ブラケット・重複の切替:': 'Switch Frame in Stack (Burst / AEB / Dup):',
    '（露出ブラケット時は': '(In AEB brackets:',
    'で明るいEV+ /': 'for brighter EV+ /',
    'で暗いEV-、連写・重複時は': 'for darker EV-; in bursts:',
    'で時間戻り /': 'for earlier /',
    'で時間進み）': 'for later frame)',
    'ピント拡大ズーム:': 'Focus Check Zoom:',
    '見たい場所にマウスを合わせて': 'Point the cursor where you want to inspect and',
    'ホイールを回す': 'scroll the mouse wheel',
    'と、そこを中心に': 'to zoom',
    '拡大します（ドラッグで移動、ダブルクリックで100%⇔200%切替）。': 'centered on the cursor (drag to pan, double-click to toggle 100% ⇔ 200%).',
    '90度回転:': '90° Rotation:',
    '横向きの写真は': 'Rotate sideways shots on the spot with',
    '（右回転）/': ' (90° CW) /',
    '（左回転）キーでその場で直せます。': ' (90° CCW).',
    '閉じる:': 'Close:',
    'もう一度': 'Press',
    'キーまたは': 'again or press',
    'キーを押します。': '.',
    '5. 複数の写真をまとめて操作する ＆ 絞り込み検索': '5. Batch Multi-Select & Search Filters',
    '👥 複数選択:': '👥 Multi-Select:',
    '+クリックで追加選択、': '+Click to add/toggle, ',
    '+クリックで範囲選択、': '+Click for range, ',
    'で全選択できます。選ぶと': 'to select all. Selecting opens the ',
    '画面下部に黒い操作バー': 'bottom Batch Action Bar',
    'が現れ、まとめて評価付け・タグ付け・回転・書き出し・': ' for batch rating, tagging, rotation, export, and ',
    '「⚖️ 2枚比較」': '"⚖️ Duel (2-Up)"',
    'が行えます。': '.',
    '🔍 写真を探す:': '🔍 Find Photos:',
    '左サイドバーの「📅 タイムライン」「📷 カメラ・レンズ（機種＞レンズ階層ツリー＆': 'Filter freely using left sidebar "📅 Timeline", "📷 Gear (Body > Lens tree with ',
    '含む/': ' Include / ',
    '除外検索）」「🧪 ラボ」や、「🔍 ファイル名検索」で自在に絞り込めます。元に戻すときは左サイドバー一番上の': ' Exclude)", "🧪 Lab", or the top search box. To clear all filters, click',
    '「🖼️ すべての写真」': '"🖼️ All Photos"',
    '「🔄 フィルタ全解除」': '"🔄 Reset Filters"',
    'を押してください。': 'at the top of the left sidebar.',

    // タブ2: 🔵 Advance編
    '1. 連写・露出ブラケット・重複写真をまとめる（スタック機能）＆ ⚖️ 2枚並べて比較':
      '1. Smart Stacking (Burst / AEB / Duplicates) & ⚖️ 2-Up Duel Comparison',
    '上部ツールバーの': 'When',
    '「スタック」': '"Stack"',
    'ボタンがONのとき、「連写」「露出ブラケット（AEB）」「別フォルダにある同一写真の重複コピー」を自動で1つの束にまとめ、代表の1枚だけを表示します。':
      'is ON in the top toolbar, bursts, exposure brackets (AEB), and duplicate copies across folders are grouped into a single stack showing only the primary shot.',
    '束の中身を見比べる:': 'Inspect Stack Frames:',
    'ライトボックス（': 'Open Lightbox (',
    '）を開き、': ') and use',
    'キーや下部のミニサムネイルバーで比較できます。': 'or the bottom mini-strip to flip through frames.',
    '⚖️ 2枚並べて比較（同期ズーム＆パン）:': '⚖️ 2-Up Duel Mode (Synced Zoom & Pan):',
    '写真を2枚選んで下部バー（または右クリック）の': 'Select 2 photos and click',
    '、あるいはライトボックス上部の': 'in the bottom bar (or right-click menu), or click',
    '「⚖️ 隣と比較」': '"⚖️ Duel (V)"',
    'を押すと、左右に並べて': 'in Lightbox to inspect two shots side-by-side with ',
    '連動ズーム＆ドラッグ移動': 'synchronized zoom & pan',
    'でピントや描写を厳密に見比べられます。Exifの差分もハイライト表示され、左写真は': '. Exif differences are highlighted, and you can rate Left (A) with',
    '、右写真は': 'and Right (B) with',
    'で即座に評価付けできます。': '.',
    '代表（表紙）を変える:': 'Crown a New Primary Shot:',
    '気に入ったコマを表示して、右インスペクタやライトボックスの': 'Display your preferred frame and click',
    '「👑 代表に設定」': '"👑 Crown"',
    'を押します。': 'in the right inspector or Lightbox.',
    '📋 重複写真の確認:': '📋 Check Duplicates:',
    '別フォルダに同じ写真がある場合はサムネイル右上角に「折り目マーク」が付きます。左サイドバー「クイックアクセス」の':
      'Photos with identical copies in other folders show a corner fold badge. Click',
    '「📋 重複のある写真」': '"📋 Duplicates"',
    'から一覧でき、右インスペクタで保存先フォルダを確認・整理できます。': 'under Quick Access to list them and inspect all file paths in the right inspector.',
    '2. 階層タグ・色ラベル・ローカルAI自動分類 ＆ 📷 カメラ・レンズ排他検索':
      '2. Hierarchical Tags, 12-Color Palette, Offline AI Tagging & 📷 Gear Include/Exclude',
    '🏷️ 階層タグ:': '🏷️ Hierarchical Tags:',
    'タグ入力時に': 'Use',
    '旅行/2026北海道/小樽': 'Travel/2026-Hokkaido/Otaru',
    'のように': 'with',
    'で区切ると、左サイドバーで親子ツリーとして整理されます（タグ右端の': 'separators to organize tags into a parent-child tree in the sidebar (click the',
    'ボタンから子タグの追加も可能）。': 'button on any tag to add a child tag).',
    '🎨 色合い（12色パレット）:': '🎨 12-Color Palette:',
    '右インスペクタの「🎨 色合い」で写真にイメージ色を登録し、左サイドバーの「🎨 カラー」から色別に絞り込めます。':
      'Assign up to 12 color tones in the right inspector and filter by color in the left sidebar.',
    '🤖 ローカルAI自動タグ付け:': '🤖 Offline AI Auto-Tagging:',
    '左サイドバーのフォルダを右クリック →': 'Right-click any folder in the left sidebar →',
    '「🤖 AIタグ付け」': '"🤖 AI Auto-Tag"',
    'を選ぶと、ネット通信なしでパソコン内のAIが「青空」「海」「猫」「料理」「夜景」などのタグを自動付与します。':
      'to let the local on-device AI automatically tag subjects like Blue Sky, Sea, Cat, Food, and Night View completely offline.',
    '📷 カメラ・レンズ階層ツリー ＆': '📷 Camera > Lens Tree &',
    '排他検索:': 'Include/Exclude Filter:',
    'タグだけでなく「📷 カメラ・レンズ」でも、カメラ本体の下に装着レンズが階層表示され、クリックするたびに':
      'In both Tags and "📷 Gear", mounted lenses are nested under each camera body. Click to cycle',
    '含む ➜': 'Include ➜',
    '除外 ➜ 解除': 'Exclude ➜ Off',
    'を切り替えられます（「特定のカメラ・レンズで撮った写真だけを除外する」といった高度な絞り込みが可能）。':
      '(allowing advanced queries like excluding shots from a specific camera or lens).',
    '3. 傾き補正・切り抜き・明るさ微調整 ＆ 📊 リアルタイムヒストグラム（完全非破壊）':
      '3. Horizon Leveling, Crop, Tone Adjust & 📊 Live Histogram (100% Non-Destructive)',
    '写真を選んで': 'Select a photo and press',
    '（またはライトボックス上部の': '(or click the',
    '「✂」ボタン': '"✂" button',
    '）を押すと、元ファイルを一切傷つけずに画面上で以下の調整ができます：': 'in Lightbox) to make the following non-destructive adjustments without touching the original file:',
    '切り抜き（アスペクト比）:': 'Crop (Aspect Ratio):',
    '元の比率、1:1、16:9、4:3、3:2、自由サイズから選んで構図を調整（三分割ガイド線付き）。':
      'Adjust composition with Original, 1:1, 16:9, 4:3, 3:2, or Free ratios (with rule-of-thirds grid).',
    '📐 傾き補正（水平出し）:': '📐 Horizon Straightening:',
    'の範囲で斜めの水平線をまっすぐに補正（周囲に黒い余白が出ないよう自動で内側を切り抜きます）。':
      'range to level tilted horizons (automatically crops inside so no black corners appear).',
    '☀️ 明るさ・コントラスト・彩度 ＆ 📊 リアルタイムトーン波形:': '☀️ Exposure / Contrast / Saturation & 📊 Live Tone Waveform:',
    'カメラの露出補正感覚（': 'Fine-tune brightness and color in 1/3-stop EV steps (',
    '、1/3段ステップ）で明るさや色味を微調整すると、上部の': ') while watching the live',
    '📊 リアルタイムヒストグラム（RGB・輝度波形）': '📊 RGB & Luminance Histogram',
    'が連動して変化し、白飛びや黒つぶれを防ぎながら追い込めます（右インスペクタの「ℹ️ 詳細情報」タブでも常時ヒストグラムを確認できます）。':
      'update in real time to prevent blown highlights or crushed shadows (also always visible in the right "ℹ️ Info" tab).',
    '💡 いつでも「↺ リセット」ボタンから撮影時の初期状態に100%戻せます。':
      '💡 Click "↺ Reset" anytime to restore the original unedited state 100%.',
    '4. 撮影場所（ジオタグ）ツリー・🗾 47都道府県制覇マップ ＆ 📍 スマホGPS準用':
      '4. Location Tree, 🗾 47-Prefecture Conquest Map & 📍 Phone GPS Sync',
    '🗺️ 場所ツリー:': '🗺️ Location Tree:',
    'GPS情報付き写真は、左サイドバー「🗺️ ジオタグ」から「国 ＞ 都道府県 ＞ 市区町村」の階層で絞り込めます。':
      'Filter GPS-tagged photos by Country > Prefecture/State > City in the "🗺️ Geotag" sidebar section.',
    '🗾 47都道府県 撮影制覇白地図・ヒートマップ・👣 撮影さんぽ軌跡:': '🗾 47-Prefecture Conquest Map, Heatmap & 👣 Photo Walk Trajectory:',
    '左サイドバー「🗺️ ジオタグ」内の': 'Click',
    '「🗾 制覇マップ」': '"🗾 Conquest Map"',
    'ボタンを押すと、以下の3つの地図分析モードを楽しめます：': 'inside "🗺️ Geotag" to explore 3 interactive map modes:',
    '🗾 47都道府県 制覇白地図:': '🗾 47-Prefecture Conquest Map:',
    '撮影したことがある都道府県が撮影枚数に応じて色分けされ、制覇率（○/47都道府県）を表示。県をクリックするとその県の写真だけを即座に一覧抽出できます。':
      'Colors each prefecture by shot count, displays your conquest rate (X/47 prefs), and lets you click any prefecture to filter its photos immediately.',
    '🔥 撮影密度ヒートマップ ＆ 👣 撮影さんぽ軌跡ライン:': '🔥 Density Heatmap & 👣 Photo Walk Trajectory:',
    'よく撮影に訪れるスポットがヒートマップで浮かび上がり、さらに日付を選ぶとその日に歩いた撮影ルートを時系列の赤い破線（さんぽ軌跡）で地図上に再現します。':
      'Visualizes your favorite shooting hotspots as a heatmap, and when you pick a date, traces your chronological walking route as a dashed red line on the map.',
    '📍 スマホから位置情報をコピー（スマホGPS準用）:': '📍 Copy GPS from Phone Photos (Geotag Inference):',
    'GPSのない一眼カメラの写真でも、前後1時間以内に撮ったスマホ写真がライブラリにあれば、右インスペクタの「📍 スマホGPS準用」や下部バーの「📍 ジオタグ準用」から位置情報を引き継げます。':
      'Even if your camera lacks GPS, if you have a smartphone photo taken within ±1 hour in your library, you can copy its coordinates via "📍 Infer GPS from Phone".',
    '5. 📤 スマート・テイクアウト ＆ 🎞️ ベタ焼き（コンタクトシート）HTML出力':
      '5. 📤 Smart Takeout & 🎞️ Betayaki (Darkroom Contact Sheet) HTML Export',
    '画面下部バー（または右クリック）の': 'From',
    '「📤 テイクアウト」': '"📤 Takeout"',
    'から、用途に合わせて2種類の出力が選べます（元ファイルは無傷のまま維持）：':
      'in the bottom bar (or right-click menu), choose from two export modes (leaving original files untouched):',
    '⚡ スマート・テイクアウト:': '⚡ Smart Takeout:',
    '非破壊で行った回転・傾き・切り抜き・明るさ調整の焼き込み、GPS/向きのExif同期、長辺リサイズ（4K / SNS最適 / フルHD等）、撮影秒数順の連番リネーム、SNS公開用のExifプライバシー消去を一括適用して別フォルダへ書き出します。':
      'Bakes in non-destructive rotation/crop/tone edits, syncs GPS/Orientation Exif, resizes long edge (4K / Social / FHD), renames sequentially by timestamp, and scrubs private Exif into a separate folder.',
    '🎞️ ベタ焼きHTML出力（暗室コンタクトシート）:': '🎞️ Betayaki HTML Export (Darkroom Contact Sheet):',
    '選んだ写真を昔ながらの暗室ネガフィルムシート風（または和紙風）の単一HTMLファイルとして出力します。ブラウザで開いて写真をクリックすると':
      'Exports selected photos into a single self-contained HTML contact sheet (Darkroom Negative or Washi theme). Open it in any browser and click frames to mark them with a ',
    '赤鉛筆の「⭕（マル）」チェック': 'red grease-pencil "⭕" circle',
    'を付けられ、そのままA4サイズ等での美しい一覧印刷にも対応しています。': ', or print directly onto A4 sheets.',
    '6. 🧪 ラボ（実験室）：🏆 勝ちレンズカルテ・🌅 太陽高度抽出・🎂 歴代の今日・🎲 未整理ガチャ':
      '6. 🧪 Lab: 🏆 Winning Lens Chart, 🌅 Solar Elevation, 🎂 On This Day & 🎲 Unrated Gacha',
    '「🧪 ラボ」': '"🧪 Lab"',
    'セクションでは、写真ライブラリを多角的に分析・発掘する実験室ツールを使えます：':
      'in the left sidebar offers analytical & discovery tools for your library:',
    '🏆 勝ちレンズ・得意設定カルテ:': '🏆 Winning Lens & Sweet-Spot Chart:',
    'これまでの評価（優・良）データから、歩留まり（高評価率）が高い「相性抜群の勝ちレンズランキング」や、自分が得意とする「黄金の焦点距離・F値・撮影時間帯」を自動診断します。':
      'Analyzes your Ex/Gd ratings to rank your highest-keeper-rate "Winning Lenses" and diagnose your personal sweet-spot focal length, aperture, and shooting hours.',
    '🔭 太陽高度・露出ラボ抽出:': '🔭 Solar Elevation & Exposure Lab:',
    '撮影日時と緯度・経度から太陽の角度を自動計算し、ドラマチックな朝夕の':
      'Calculates the sun angle from timestamp & GPS to extract dramatic',
    '「🌅 マジックアワー（太陽高度 -4°〜+6°）」': '"🌅 Golden Hour (-4° to +6°)"',
    '、静謐な薄明の': ', serene ',
    '「🌌 ブルーアワー（-8°〜-4°）」': '"🌌 Blue Hour (-8° to -4°)"',
    '「🌃 夜景・星景（-8°未満）」': '"🌃 Night & Astro (<-8°)"',
    '、さらにシャッター速度が': ', and ',
    '1/焦点距離 秒': '1 / focal_length sec',
    'より遅い': 'slow-shutter',
    '「⚠️ 手ブレ注意」': '"⚠️ Lens Shaker"',
    'の写真をワンクリックで抽出します。': 'shots in one click.',
    '🎂 歴代の今日・記念日 ＆ 🎲 未整理ガチャ:': '🎂 On This Day & 🎲 Unrated Folder Gacha:',
    '「過去の同じ月日（今日や記念日）に撮った写真」を一発で振り返る機能や、まだ選別していない（評価：可）写真が残っているフォルダをランダムに1つ引き当てる「🎲 未整理ガチャ」で楽しく整理を進められます。':
      'Rediscover photos taken on the same month & day across past years, or spin the "🎲 Random Unrated Folder Gacha" to pick an unculled folder and enjoy organizing.',
    '7. 検索プリセット保存・外部ソフト連携・DBメンテナンス': '7. Saved Filter Presets, External App Integration & DB Maintenance',
    '💾 プリセット保存:': '💾 Saved Filter Presets:',
    'よく使う絞り込み条件は、左サイドバー「⚡ クイックアクセス」内の保存フォームで名前を付けて登録し、ワンクリックで呼び出せます。':
      'Save frequently used filter combinations with a custom name under "⚡ Quick Access" for one-click recall.',
    '📁 外部ソフト連携 ＆ 🔄 サムネイル更新:': '📁 Open in External App & 🔄 Refresh Thumbnail:',
    '右インスペクタ上部の': 'Click',
    'でエクスプローラーを開き、': 'in the right inspector to reveal in Explorer, or',
    'で既定ソフトで開けます。外部ソフトで編集した後は、写真を右クリック →「🔄 サムネイルを更新」で表示を最新化できます。':
      'to open in your default editor. After editing externally, right-click the photo → "🔄 Refresh Thumbnail" to update its preview.',
    '⚙️ DBメンテナンス:': '⚙️ DB Maintenance:',
    '左サイドバー「📁 フォルダ」上部の': 'Click the',
    'ボタンで、世代バックアップを取りつつデータベース容量を最適化（VACUUM）できます。':
      'button in the "📁 Folders" header to create rotating backups and compact (VACUUM) the database.',

    // タブ3: 🟣 Mobile & USB編
    '1. USBメモリ・外付けSSDでの3つの持ち歩きスタイル': '1. Three Portable Styles with USB Flash Drives / External SSDs',
    '① 写真もアプリも丸ごとUSBに入れる:': '① All-in-One USB (App + Photos):',
    'USBメモリ1本を別のPCに挿して': 'Plug a single USB drive into any PC and open',
    'を開くだけで、どこでも同じ環境で使えます。': 'to enjoy the exact same environment anywhere.',
    '② 元写真は自宅に置き「カタログ（USB）」だけ持ち歩く:': '② Carry Only the USB Catalog (Leave Heavy RAWs at Home):',
    '数百GB〜数TBの元写真は自宅HDDに置いたまま、Photo Manager が入ったUSBメモリだけを持ち歩けます。元写真が未接続（「🔌 未接続」表示）でも、全写真のサムネイル閲覧・評価・タグ付けが快適に行えます。':
      'Leave terabytes of original files on your home HDD and carry only the USB drive containing Photo Manager. Even while offline ("🔌 Offline"), you can browse all cached WebP thumbnails, rate, and tag smoothly.',
    '③ ドライブ文字（D: → E: 等）が変わっても自動追従:': '③ Automatic Drive-Letter Tracking (D: → E:):',
    '別のPCに挿してドライブ文字が変わっても、ドライブ固有情報を自動認識してリンク切れを防ぎます。':
      'Automatically recognizes drive Volume Serial Numbers (VSN) so links never break even when Windows assigns a different drive letter.',
    '2. スマホで写真をサクサク選別する（2つの方法）': '2. Two Ways to Cull Photos on Your Smartphone',
    'ソファや移動中の電車の中で、スマホの親指操作だけで大量の写真を4段階評価（優・良・可・棄）＆タグ付けできます。':
      'Cull and tag thousands of photos with one thumb from your couch or commuter train.',
    '🏠 方法A：自宅のWi-Fiでつなぐ（リアルタイム反映）': '🏠 Method A: Home Wi-Fi Connection (Real-Time Sync)',
    'パソコン画面右上の': 'Click the top-right',
    '「📱 スマホ連携」': '"📱 Mobile"',
    'ボタンをクリックします。': 'button on your PC.',
    '表示された': 'Scan the displayed',
    'QRコード': 'QR Code',
    'をスマホのカメラで読み取って開きます（同じWi-Fiに接続）。': 'with your phone camera (connected to the same Wi-Fi).',
    'スマホで付けた評価やタグが、その瞬間にパソコン画面へリアルタイム反映されます！':
      'Ratings and tags made on your phone are reflected on your PC screen in real time!',
    '🚃 方法B：外出先・ネット圏外でUSBメモリを直接スマホに挿す（完全オフライン）':
      '🚃 Method B: Plug USB Directly into Phone on the Go (100% Offline)',
    'パソコン電源OFF・ネット圏外でも使えます。Photo Manager が入ったUSBメモリをAndroidスマホ等に挿します。':
      'Works with your PC off and no internet. Plug the Photo Manager USB drive directly into your Android phone.',
    'スマホの「ファイル」アプリでUSB内の': "In your phone's Files app, tap",
    'をタップしてブラウザで開きます（※開けない機種では、このHTMLファイル1つだけをスマホ本体のダウンロードフォルダ等にコピーして開いてください）。':
      "on the USB drive to open it in the browser (*if your device blocks opening HTML from USB, copy just that single HTML file to your phone's Downloads folder and open it).",
    '画面の': 'Tap',
    '「📂 DB読込」': '"📂 Load DB"',
    'をタップし、USBメモリ内の': 'on screen and select',
    'フォルダ ＞': 'folder >',
    'を選ぶと、約1秒で全写真が読み込まれます。': 'on the USB drive to load all photos in ~1 second.',
    '3. スマホでの親指操作と、パソコンへの同期手順（USBオフライン時）':
      '3. One-Thumb Mobile Culling & Syncing Back to PC (Offline USB)',
    '👍 親指ドックで連続選別:': '👍 Rapid Thumb-Zone Culling:',
    'スマホで写真をタップして拡大し、画面下部の': 'Tap a photo to zoom and tap',
    '「🗑️棄」「⚪可」「⭐良」「🏅優」': '"🗑️Rj", "⚪Nm", "⭐Gd", or "🏅Ex"',
    'をタップします。「⚡自動送り」がONならタップと同時に次の写真へ進むため、片手で何百枚でも仕分けられます。':
      'at the bottom. With "⚡ Auto-Advance" ON, rating immediately advances to the next shot so you can cull hundreds of photos one-handed.',
    '🔄 パソコンへの反映手順:': '🔄 Syncing Back to PC:',
    '選別が終わったらスマホ画面の': 'When finished, tap',
    '「💾 変更を保存」': '"💾 Save Changes"',
    'を押し、USBメモリの先頭（ルート）フォルダに': 'on your phone and save',
    'を保存します。': 'to the root folder of your USB drive.',
    '保存完了メッセージから3秒ほど待ち、スマホの通知欄から': 'Wait ~3 seconds after the save message, then tap',
    'を実行してからUSBを抜きます。': "from your phone's notification shade before unplugging the USB drive.",
    'USBメモリをパソコンに挿して': 'Plug the USB drive into your PC and launch',
    'を起動すると、': '—your changes are ',
    '自動的に選別結果が検出・反映': 'automatically detected and merged',
    'され、完了通知が表示されます！': ' with a completion toast!',
    '4. ⚠️ USBメモリを安全に抜くための鉄則': '4. ⚠️ Golden Rules for Safely Unplugging USB Drives',
    '💻 パソコンから抜く前:': '💻 Before Unplugging from PC:',
    '必ず画面右上の': 'Always shut down completely via top-right',
    '「⏻ 終了」＞「サーバーを停止して終了」': '"⏻ Exit" > "Stop Server & Exit"',
    'で完全終了してから抜いてください。': 'before removing the USB drive.',
    '📱 スマホから抜く前:': '📱 Before Unplugging from Phone:',
    '保存後、必ずスマホ通知欄の': 'After saving, always run',
    '「取り外す（マウント解除）」': '"Eject / Unmount"',
    'を実行してから抜いてください（そのまま引き抜くと保存ファイルが空になることがあります）。':
      "from your phone's notification bar before pulling out the drive (unplugging without unmounting may leave the saved file empty).",

    // タブ4: ⌨️ ショートカット & FAQ
    '選択中の写真に': 'Set selected photo(s) to',
    '🏅 優 (ベストショット)': '🏅 Ex (Excellent / Best Shot)',
    'を設定': '',
    '⭐ 良 (お気に入り)': '⭐ Gd (Good / Keeper)',
    '🗑️ 棄 (ボツ)': '🗑️ Rj (Reject)',
    'を設定（一覧から自動で隠れます）': '(auto-hidden from grid)',
    '選択中の写真の': 'Open',
    '評価を取り消す（⚪ 可）': 'Reset rating to ⚪ Nm (Normal)',
    '選択中の写真を': 'Rotate selected photo(s)',
    '右へ90度(': '90° CW (',
    ') / 左へ90度(': ') / 90° CCW (',
    ') 回転': ')',
    '（非破壊）': ' (non-destructive)',
    '切り抜き・傾き・明るさ調整画面': 'Crop / Level / Tone Adjustment',
    'を開く（非破壊）': '(non-destructive)',
    '⚖️ 2枚並べて比較（Side-by-Side）': '⚖️ 2-Up Duel Comparison (Side-by-Side)',
    'を開く（同期ズーム・勝ち抜き選別）': '(synced zoom & knockout culling)',
    '📊 RGB・輝度ヒストグラム': '📊 RGB & Luminance Histogram',
    'の表示 / 非表示を切り替え': 'toggle show / hide',
    '前後の写真・スタックへ移動（2枚比較時は右ペインBの候補切替）':
      'Prev / Next photo or stack (in 2-Up Duel: switch Right [B] candidate)',
    '連写 / ブラケット / 重複写真のスタック内切替': 'Switch frame inside Burst / AEB / Duplicate stack',
    '（露出ブラケット時:': '(AEB bracket:',
    'で暗いEV-、連写・重複時:': 'darker EV-; Burst/Dup:',
    '表示中の写真（2枚比較時は選択中ペイン）に': 'Rate current photo (or active pane in 2-Up Duel):',
    '優(': 'Ex (',
    ') / 良(': ') / Gd (',
    ') / 棄(': ') / Rj (',
    ') / 可(': ') / Nm (',
    '・': ' / ',
    'ライトボックスから': 'From Lightbox, toggle',
    'を開く / 閉じる': 'open / close',
    '【⚖️ 2枚比較時】': '[In ⚖️ 2-Up Duel] ',
    'で': ': ',
    '右(B)を左(A:基準)に昇格して次へ': 'Crown Right (B) as Left (A) & advance',
    '左右入れ替え': 'Swap Left (A) ⇄ Right (B)',
    'の表示 / 非表示を切り替え（2枚比較時は左右同時表示）': 'toggle show / hide (shows dual side-by-side waveforms in 2-Up Duel)',
    '🗑️ 棄（ボツ）': '🗑️ Rj (Reject)',
    '評価のON / OFFトグル': 'rating toggle ON / OFF',
    '表示中の写真を': 'Rotate current photo',
    '表示中の写真の': 'Open',
    'マウスホイール': 'Mouse Wheel',
    '画像上:': 'Over image:',
    'カーソル位置を中心に拡大縮小 (100%〜400% / 2枚比較時は左右同期ズーム)':
      'Zoom centered on cursor (100%–400% / synced zoom in 2-Up Duel)',
    '連写バー上:': 'Over burst bar:',
    'スタック内のコマ送り': 'Flip stack frames',
    '／ 下部フィルム帯上:': ' / Over bottom filmstrip:',
    '写真送り': 'Prev/Next photo',
    'ダブルクリック': 'Double-Click',
    'ドラッグ': 'Drag',
    '拡大中の表示位置を移動（パン移動 / 2枚比較時は左右同期パン、': 'Pan while zoomed (synced pan in 2-Up Duel; hold ',
    '+ドラッグで片側のみ移動）': '+Drag to pan one side independently)',
    'キーで「棄」にしたら写真が消えました。ファイルが削除されたのですか？':
      'key to mark a photo as "Rj (Reject)" and it disappeared. Was my file deleted?',
    'A. いいえ、パソコン内のファイルは削除されていません。画面上部ツールバーの':
      'A. No, files on your PC are never deleted. Click the',
    'ボタンを押して点灯させればいつでも再表示でき、':
      'button on the top toolbar to reveal rejected photos anytime, and press',
    'キーで元に戻せます。': 'to restore them.',
    'Q. 回転や明るさ調整をした写真を、実際のファイルとして保存したいときは？':
      'Q. How do I save rotated or brightness-adjusted photos as actual image files?',
    'A. アプリ内の調整は元ファイルを傷つけない非破壊方式です。調整結果を焼き込んだ画像ファイルを作るには、画面下部バーの':
      'A. All in-app adjustments are non-destructive. To export new image files with your edits baked in, use',
    '「📤 テイクアウト」＞「⚡ スマート・テイクアウト...」': '"📤 Takeout" > "⚡ Smart Takeout..."',
    'から書き出してください。': 'from the bottom action bar.',
    'Q. 初回起動時に「Windows によって PC が保護されました」と表示されました。':
      'Q. Windows displayed "Windows protected your PC" (SmartScreen) on first launch.',
    'A. 個人開発で商用コード署名証明書を付与していないため表示される確認画面です。「詳細情報」→「実行」で起動するか、同梱の':
      'A. This appears because this indie tool is not signed with a commercial certificate. Click "More info" → "Run anyway", or double-click the bundled',
    'を実行してPC上で': 'to compile a fresh',
    'を再生成してください。': 'locally on your PC.',

    // XMP サイドカー & storage 機能
    'XMPサイドカーファイルが検出されました': 'XMP sidecar file detected',
    '👁️ XMPプレビュー': '👁️ Hold XMP Preview',
    '押している間だけPhotoManagerの調整をオフにし、XMPの調整データを反映して表示します':
      'Hold to temporarily bypass Photo Manager edits and preview XMP adjustments',
    '📥 評価・タグ取込': '📥 Import Rating/Tags',
    'XMPサイドカーの評価（4段階変換）やタグ（XMP/ルート配下）を取り込みます':
      'Import XMP rating (converted to 4-stage) and hierarchical tags (under XMP/ root)',
    '📄 XMPサイドカー (.xmp) も一緒に出力する（評価・タグ・調整情報の保持）':
      '📄 Also export XMP sidecar (.xmp) (preserves rating, tags & adjustments)',
    '書き出し画像と一緒に評価・タグ・GPS・調整情報を記録した .xmp サイドカーファイルも出力します':
      'Exports a companion .xmp sidecar file containing rating, tags, GPS, and adjustment metadata',
    '📄 XMPサイドカー連携 ＆ 👁️ XMPプレビュー（ホールド比較）:':
      '📄 XMP Sidecar Integration & 👁️ Hold XMP Preview:',
    '同名の': 'For photos with a companion',
    'サイドカーファイル（Lightroom / Adobe Camera Raw 等）が存在する写真では、右インスペクタ上部に':
      'sidecar file (from Lightroom / Adobe Camera Raw, etc.), the',
    '「📄 XMP」バー': '"📄 XMP" bar',
    'が表示されます。': 'appears at the top of the right inspector.',
    '「👁️ XMPプレビュー」ボタンを長押し（ホールド）している間だけ':
      'While holding down "👁️ Hold XMP Preview",',
    'Photo Manager 側の調整を一時オフにして XMP 側の調整（露出・コントラスト・彩度・クロップ・角度）を反映表示し、指を離すと元の表示に戻ります。また':
      'Photo Manager temporarily bypasses its own edits to render the XMP adjustments (Exposure, Contrast, Saturation, Crop, Angle), restoring normal view upon release. Click',
    '「📥 評価・タグ取込」': '"📥 Import Rating/Tags"',
    'ボタンから、XMP 内の評価（4段階へ自動変換）や階層タグ（':
      'to import XMP ratings (converted to 4-stage) and hierarchical keywords (safely isolated under the',
    'ルート配下に隔離して安全にインポート）を取り込めます。':
      'root).',
    '非破壊で行った回転・傾き・切り抜き・明るさ調整の焼き込み、GPS/向きのExif同期、':
      'Bakes in non-destructive rotation/crop/tone edits, syncs GPS/Orientation Exif,',
    '📄 XMPサイドカー (': '📄 exports companion XMP sidecars (',
    ') の同時出力（評価・タグ・調整情報の保持）': ') preserving ratings/tags/adjustments',
    '、長辺リサイズ（4K / SNS最適 / フルHD等）、撮影秒数順の連番リネーム、SNS公開用のExifプライバシー消去を一括適用して別フォルダへ書き出します。':
      ', resizes long edge (4K / Social / FHD), renames sequentially by timestamp, and scrubs private Exif into a separate folder.',
    '📦 storage（アプリ内ストレージ）での完結管理 ＆ サイドカー自動追従:':
      '📦 Self-Contained "storage" Management & Automatic Sidecar Tracking:',
    '左サイドバー「📁 フォルダ」先頭の': 'At the top of "📁 Folders" in the left sidebar,',
    '「📦 storage (アプリ内ストレージ)」': '"📦 storage (In-App Storage)"',
    'には、外部フォルダの写真を選択して': 'lets you select external photos and click',
    '「📥 storageへインポート」': '"📥 Import to storage"',
    '（または左ツリーの': '(or drag & drop onto the',
    'フォルダへドラッグ＆ドロップ）でコピー取り込みできます。':
      'folder in the sidebar) to copy them into the app.',
    '内ではサブフォルダの作成・名前変更、写真のフォルダ間移動（':
      'supports creating/renaming subfolders, moving photos between folders (',
    '「📦 storage内で移動」': '"📦 Move in storage"',
    '）、ファイル名変更（': '), renaming files (',
    'で単一リネーム／複数選択時は一括連番リネーム）、フォルダ右クリックからの外部エクスポートが自在に行えます。さらに、写真と同名の':
      'for single rename or batch sequential rename), and exporting folders externally. Companion',
    'サイドカーファイル（': 'sidecar files (',
    '等）が存在する場合は、インポート・移動・リネーム・エクスポート時に自動で追従':
      'etc.) automatically follow the photo during import, move, rename, and export',
    'します。': '.',
    'DB管理': 'DB Maint',
    'データベースのバックアップ・最適化（VACUUM）': 'Database Backup & Optimization (VACUUM)',
    'タグエディタ (付与・作成・編集)': 'Tag Editor (Assign, Create & Edit)',
    'タグエディタ (一括付与・作成・編集)': 'Tag Editor (Batch Assign, Create & Edit)',
    '✓付与済': '✓Added',
    '+子': '+Sub',
    'その他のタグなし (右インスペクタで作成)': 'No other tags (Create in Right Inspector)',
    '付与されている写真枚数': 'Number of photos with this tag',
    '🏷️ タグを全体から削除（確認）': '🏷️ Delete Tag from Library (Confirm)',
    'キャンセル (NG)': 'Cancel (NG)',
    'OK (全体から削除)': 'OK (Delete Tag)',
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
    [/^📋\s*重複\s*(\d+)$/, '📋 DUP $1'],
    [/^📋\s*重複写真グループ\s*\((\d+)枚\)(.*)$/, '📋 Duplicate Group ($1 shots)$2'],
    [/^⚡\s*連写グループ\s*\((\d+)枚\)(.*)$/, '⚡ Burst Group ($1 shots)$2'],
    [/^⚡\s*連写バースト\s*\((\d+)コマ\)(.*)$/, '⚡ Burst Group ($1 frames)$2'],
    [/^⚡\s*露出ブラケット\s*\((\d+)枚(.*)\)(.*)$/, '⚡ Exposure Bracket ($1 shots$2)$3'],
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
    [/^📅\s*複数月選択\s*\((\d+)ヶ月:\s*(.+)\)$/, '📅 Multi-Month ($1 mos: $2)'],

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
    [/^⭐\s*([優良可棄/]+)$/, (_, rText) => {
      const mapped = rText
        .replace(/優/g, 'Ex')
        .replace(/良/g, 'Gd')
        .replace(/可/g, 'Nm')
        .replace(/棄/g, 'Rj');
      return `⭐ ${mapped}`;
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
    [/^(🟢|🔴)\s*ラベルなし(.*)$/, '$1 Unlabeled$2'],
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
    [/^📋\s*その他の候補\s*\((\d+)件\)$/, '📋 All Candidates ($1)'],
    [/^📷\s*(.+)\s*・\s*⏱\s*([\d.?]+)分差\s*・\s*📍\s*(.+)$/, (_, cam, diff, coords) => `📷 ${cam === '不明' ? 'Unknown' : cam} · ⏱ ±${diff}m · 📍 ${coords}`],
    [/^🚫\s*除外:\s*(.+)$/, '🚫 Ignored: $1'],
    [/^🔭\s*除外:\s*(.+)$/, '🔭 Exclude: $1'],
    [/^📷\s*除外:\s*(.+)$/, '📷 Exclude: $1'],
    [/^📷\s*カメラ・レンズ絞り込み\s*\((\d+)件\)$/, '📷 Gear Filter ($1)'],
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
    [/^📌\s*A:\s*#(\d+)\s+vs\s+🔍\s*B:\s*#(\d+)\s*（全\s*([\d,]+)\s*枚）$/, '📌 A: #$1  vs  🔍 B: #$2 ($3 total)'],
    [/^⚡\s*露出ブラケット比較\s*\((\d+)枚\)$/, '⚡ Bracket Duel ($1 shots)'],
    [/^📋\s*重複グループ比較\s*\((\d+)枚\)$/, '📋 Duplicate Duel ($1 shots)'],
    [/^⚡\s*連写グループ比較\s*\((\d+)コマ\)$/, '⚡ Burst Duel ($1 frames)'],
    [/^🖼️\s*前後写真の比較\s*\((\d+)枚\)$/, '🖼️ Neighbor Duel ($1 shots)'],
    [/^✓\s*選択中の写真を比較\s*\((\d+)枚\)$/, '✓ Selected Duel ($1 shots)'],
    [/^⚡\s*スタック内比較\s*\((\d+)枚\)$/, '⚡ Stack Duel ($1 shots)'],
    [/^🖼️\s*写真一覧の比較\s*\((\d+)枚\)$/, '🖼️ Grid Duel ($1 shots)'],
    [/^(\d+)\s*&\s*(\d+)\s*\/\s*([\d,]+)\s*枚$/, '$1 & $2 / $3 shots'],

    // カルテ・ラボ統計バッジ
    [/^🏅優\s*([\d,]+)$/, '🏅Ex $1'],
    [/^👍良\s*([\d,]+)$/, '👍Gd $1'],
    [/^🏅優打率\s*([\d.]+)%$/, '🏅Ex Rate $1%'],
    [/^優打率\s*([\d.]+)%$/, 'Ex Rate $1%'],
    [/^好評価\s*([\d.]+)%$/, 'Hit $1%'],
    [/^優打率:\s*([\d.]+)%\s*\/\s*好評価率:\s*([\d.]+)%\s*\(出動比率:\s*([\d.]+)%\)$/, 'Ex Rate: $1% / Keeper Rate: $2% (Usage Share: $3%)'],
    [/^（優打率\s*([\d.]+)%）、\s*絞りは$/, ' (Ex Rate $1%), and aperture '],
    [/^（優打率\s*([\d.]+)%）で最高傑作が生まれやすい傾向にあります。$/, ' (Ex Rate $1%) for producing masterpieces.'],
    [/^(\d+)時台（([\d,]+)枚）$/, '$1:00 ($2 shots)'],
    [/^(\d+)時台（優打率\s*([\d.]+)%）$/, '$1:00 (Ex Rate $2%)'],
    [/^(\d+)時台:\s*計\s*([\d,]+)枚\s*\/\s*🏅優\s*([\d,]+)枚\s*\(優打率\s*([\d.]+)%\)$/, '$1:00 — Total $2 / 🏅Ex $3 (Ex Rate $4%)'],
    [/^([\d,]+)\s*本のレンズを分析$/, '$1 lenses analyzed'],
    [/^([\d,]+)\s*機種$/, '$1 bodies'],
    [/^🌅\s*マジックアワー\s*\(([\d,]+)枚\)$/, '🌅 Golden Hour ($1)'],
    [/^🌌\s*ブルーアワー\s*\(([\d,]+)枚\)$/, '🌌 Blue Hour ($1)'],
    [/^🌃\s*夜景・星景\s*\(([\d,]+)枚\)$/, '🌃 Night & Astro ($1)'],
    [/^⚠️\s*手ブレ危険度\s*\(([\d,]+)枚\)$/, '⚠️ Lens Shaker ($1)'],
    [/^焦点距離:\s*(.+)$/, 'Focal: $1'],
    [/^F値:\s*(.+)$/, 'F-Stop: $1'],
    [/^除外:\s*(.+)$/, 'Exclude: $1'],

    // 制覇マップ・ヒートマップ・軌跡
    [/^(\d+)\s*\/\s*(\d+)\s*都道府県$/, '$1 / $2 Prefs'],
    [/^(\d+)の国と地域$/, '$1 Countries'],
    [/^([\d,]+)\s*(メッシュ|エリア)$/, '$1 Hotspots'],
    [/^([\d,]+)枚\s*\(([\d.]+)%\)$/, '$1 shots ($2%)'],
    [/^([\d,]+)枚\s*\/\s*🏅([\d,]+)$/, '$1 shots / 🏅$2'],
    [/^(🇯🇵|🌍)\s+(.+)$/, (full, icon, c) => Object.prototype.hasOwnProperty.call(EXACT_MAP, c) ? `${icon} ${EXACT_MAP[c]}` : full],
    [/^🔍\s*(.+)の写真を表示\s*\(([\d,]+)枚\)$/, (_, pref, cnt) => `🔍 View ${PREF_ROMAJI_MAP[pref] || pref} (${cnt})`],
    [/^(\d{4}-\d{2}-\d{2})\s*\(([\d,]+)枚\)$/, '$1 ($2 shots)'],
    [/^🔥\s*滞在ホットスポット\s*\(([\d,]+)枚撮影\)$/, '🔥 Stay Hotspot ($1 shots)'],
    [/^🏅優\s*#(\d+)$/, '🏅Ex #$1'],
    [/^約\s*([\d,]+)\s*歩$/, 'Approx. $1 steps'],
    [/^(\d+)\s*箇所$/, '$1 spots'],
    [/^(\d+)分$/, '$1m'],
    [/^(\d+)時間(\d+)分$/, '$1h $2m'],
    [/^(\d+)日間$/, '$1 days'],

    // 複数行ツールチップ
    [/^([\s\S]+)\nクリック:\s*上部にプレビュー表示\nダブルクリック:\s*ライトボックスで全画面表示$/, '$1\nClick: Preview above\nDouble-click: Open Lightbox'],
    [/^([\s\S]+)\nクリックでフォルダを開く$/, '$1\nClick to open folder'],
    [/^([\s\S]+)\nクリック:\s*🔍右\(B\)に表示\nShift\+クリック:\s*📌左\(A\)に固定$/, '$1\nClick: Show in 🔍Right (B)\nShift+Click: Pin to 📌Left (A)'],
    [/^([\s\S]+)\n左クリック:\s*含む\/解除\s*｜\s*右クリック:\s*除外$/, '$1\nLeft-click: Include/Off | Right-click: Exclude'],
    [/^(.+)\s*\(([\d,]+)枚\)\nクリック:\s*この色で絞り込み\s*｜\s*右クリック:\s*除外$/, (_, c, n) => `${EXACT_MAP[c] || c} (${n})\nLeft-click: Include | Right-click: Exclude`],
    [/^(.+)\nクリック:\s*選択中写真\((\d+)枚\)に一括(解除|付与)$/, (_, c, n, act) => `${EXACT_MAP[c] || c}\nClick: Batch ${act === '解除' ? 'remove from' : 'apply to'} ${n} selected photos`],
    [/^(.+)\nクリックでこの写真に(解除|付与)$/, (_, c, act) => `${EXACT_MAP[c] || c}\nClick to ${act === '解除' ? 'remove from' : 'apply to'} this photo`],
    [/^([\s\S]+)\n保存先:\s*(.+)\n解像度:\s*(.+)\nサイズ:\s*(.+?)(\n\(代表マスター写真\))?$/, (_, f, d, r, s, pri) => `${f}\nFolder: ${d === '不明' ? 'Unknown' : d}\nDimensions: ${r}\nSize: ${s}${pri ? '\n(★ Crowned Primary)' : ''}`],
    [/^([\s\S]+)\n撮影時刻:\s*(.+)\n露出:\s*(.+)$/, (_, head, t, exp) => `${head.replace('連写スタートコマ (0.000s)', 'Burst Start (0.000s)').replace(/開始から \+([\d.]+)s/, '+$1s from start').replace(/連写 #(\d+) コマ目/, 'Burst Frame #$1')}\nTime: ${t === '不明' ? 'Unknown' : t}\nExposure: ${exp}`],
    [/^(.+)（ドライブ未接続）$/, '$1 (Offline)'],
    [/^(.+)（実フォルダ消失）$/, '$1 (Folder Missing)'],

    // バージョン更新日時ツールチップ
    [/^v([\d.a-zA-Z]+)\s*\(最終更新:\s*(.+)\)$/, 'v$1 (Updated: $2)'],

    // よく出るトーストメッセージ
    [/^(右へ90°|左へ90°)回転しました$/, (_, d) => `Rotated ${d === '右へ90°' ? '90° CW' : '90° CCW'}`],
    [/^(\d+)枚を(右へ90°|左へ90°)一括回転しました$/, (_, n, d) => `Batch rotated ${n} photos ${d === '右へ90°' ? '90° CW' : '90° CCW'}`],
    [/^(\d+)枚の回転・調整をリセットしました$/, 'Reset rotation & adjustments for $1 photos'],
    [/^📤\s*(\d+)枚のJPGを「(.+)」にテイクアウトしました(.*)$/, '📤 Exported $1 JPGs to "$2"$3'],
    [/^🏷️\s*(\d+)枚の写真にタグ「(.+)」を付与しました$/, '🏷️ Added tag "$2" to $1 photos'],
    [/^(\d+)枚の評価を「(.+)」に設定しました$/, 'Set rating for $1 photos to "$2"'],
    [/^🗑️\s*(\d+)枚の写真をライブラリから削除しました$/, '🗑️ Removed $1 photos from library'],
    [/^📍\s*(\d+)\s*枚の写真にジオタグを準用しました$/, '📍 Inferred GPS for $1 photos'],
    [/^🗑️\s*(\d+)\s*枚の写真からジオタグを削除しました$/, '🗑️ Cleared GPS from $1 photos'],
    [/^(\d+)枚の写真を「(.+)」に書き出しました！(.*)$/, 'Exported $1 photos to "$2"!$3'],
    [/^🎲\s*発掘ガチャ:\s*「(.+)」（未整理\s*([\d,]+)枚）を引き当てました！$/, '🎲 Gacha Hit! Folder "$1" ($2 unrated shots)!'],
    [/^🗾\s*「(.+)」で撮影された写真を表示します$/, (_, pref) => `🗾 Filtering photos taken in ${PREF_ROMAJI_MAP[pref] || pref}`],
    [/^🌏\s*「(.+)」の写真で絞り込みました$/, (_, c) => `🌏 Filtered by country: ${EXACT_MAP[c] || c}`],
    [/^🎞️\s*ベタ焼きHTML（([\d,]+)枚）を\s*take_out\s*に出力しました$/, '🎞️ Exported Betayaki HTML ($1 shots) to take_out!'],
    [/^🔍\s*レンズ「(.+)」で絞り込みました$/, '🔍 Filtered by Lens: "$1"'],
    [/^📷\s*カメラ「(.+)」で絞り込みました$/, '📷 Filtered by Body: "$1"'],
    [/^📐\s*焦点距離「(.+)」で絞り込みました$/, '📐 Filtered by Focal Length: "$1"'],
    [/^🔆\s*絞り「(.+)」で絞り込みました$/, '🔆 Filtered by Aperture: "$1"'],
    [/^🎂\s*歴代の\s*(.+)\s*に撮影された写真を表示します$/, '🎂 Showing photos taken on $1 across all years'],
    [/^(.+)\s*で写真を絞り込みました$/, 'Filtered photos by $1'],
    [/^👑\s*「(.+)」を左\(A:基準\)にセットしました$/, '👑 Crowned "$1" as Left (A: Champion)'],
    [/^🏷️\s*「(.+)」を手動タグとして確定しました$/, '🏷️ Promoted "$1" to Manual tag'],
    [/^🤖\s*AIタグを付与しました:\s*(.+)$/, '🤖 Added AI tags: $1'],
    [/^フィルタセット「(.+)」を保存しました$/, 'Saved filter preset "$1"'],
    [/^フィルタセット「(.+)」を適用しました$/, 'Applied filter preset "$1"'],
    [/^フィルタセット「(.+)」を削除しました$/, 'Deleted filter preset "$1"'],
    [/^✅\s*スキャン完了:\s*([\d,]+)枚検出\s*\(([\d,]+)枚更新(.*)\)$/, '✅ Scan complete: $1 found ($2 updated$3)'],
    [/^XMPサイドカー検出:\s*(.+)$/, 'XMP sidecar detected: $1'],
    [/^XMPサイドカーファイルが検出されました\s*\((.+)\)$/, 'XMP sidecar file detected ($1)'],
    [/^押している間だけXMPの調整データを反映します\s*\((.+)\)$/, 'Hold to preview XMP adjustments ($1)'],
    [/^XMPサイドカーから取り込み\s*\((.+)\)$/, 'Import from XMP sidecar ($1)'],
    [/^📥\s*XMPからメタデータを取り込みました（タグ\s*(\d+)件）$/, '📥 Imported metadata from XMP ($1 tags)'],
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
      if (iconEl) iconEl.textContent = '🇺🇸';
      if (labelEl) labelEl.textContent = 'EN';
      btn.title = 'Switch UI Language (English ⇄ 日本語)';
      btn.classList.add('is-en');
    } else {
      if (iconEl) iconEl.textContent = '🇯🇵';
      if (labelEl) labelEl.textContent = 'JP';
      btn.title = 'UI言語切り替え (日本語 ⇄ English)';
      btn.classList.remove('is-en');
    }
  }

  /**
   * 言語を切り替えて即時反映する
   * @param {'ja'|'en'} lang
   */
  function setLanguage(lang) {
    currentLang = lang === 'en' ? 'en' : 'ja';
    localStorage.setItem(STORAGE_KEY, currentLang);
    updateLangToggleButton();
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
        showToast('🇺🇸 Switched UI to English (Washi / Urusi & Slang Edition)', 'info', 2200);
      } else {
        showToast('🇯🇵 表示言語を日本語に切り替えました', 'info', 2200);
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

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TARGET_ATTRS,
    });
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
