/**
 * Photo Manager - サイドバーツリー＆フィルタ管理モジュール (sidebar_filters.js)
 * タイムライン（常設ミニカレンダー・年月ツリー・拡大カレンダーモーダル）、
 * カメラ＆レンズ階層ツリー（[+]/[-]排他検索）、
 * フォルダ階層データ構築、階層タグツリー・12色カラーパレット管理を担当する。
 */

/** 拡大カレンダーモーダル内部状態 */
let _calModalActiveTab = 'month'; // 'month' (月間フォトカレンダー) | 'year' (年間12ヶ月ヒートマップ)
let _calModalYm = null;           // 月間タブで表示中の YYYY-MM
let _calModalYear = null;         // 年間タブで表示中の YYYY
let _calModalShowThumbs = localStorage.getItem('pm_cal_modal_thumbs') !== 'false'; // 月間タブの代表サムネイル表示ON/OFF
let _calModalHeatMode = 'count';  // 年間ヒートマップの基準 ('count' | 'excellent')

/**
 * 日別カレンダー集計データをバックエンドから取得して state.calendarDaysMap を更新する
 */
async function fetchCalendarSummary() {
  try {
    const res = await fetch('/api/calendar/summary');
    if (!res.ok) return;
    const data = await res.json();
    const days = Array.isArray(data.days) ? data.days : [];
    if (!state.calendarDaysMap) state.calendarDaysMap = new Map();
    state.calendarDaysMap.clear();
    days.forEach(item => {
      if (item && item.date) {
        state.calendarDaysMap.set(item.date, item);
      }
    });
    renderSidebarMiniCalendar();
    const modal = document.getElementById('calendarModal');
    if (modal && modal.style.display !== 'none') {
      renderCalendarModalContent();
    }
  } catch (err) {
    console.warn('[WARN] fetchCalendarSummary エラー:', err);
  }
}
window.fetchCalendarSummary = fetchCalendarSummary;

/**
 * YYYY-MM 文字列を前後に N ヶ月ずらした YYYY-MM を返す
 */
function _shiftYearMonth(ymStr, deltaMonths) {
  const parts = String(ymStr || '').split('-');
  let y = parseInt(parts[0], 10);
  let m = parseInt(parts[1], 10);
  if (isNaN(y) || isNaN(m)) {
    const now = new Date();
    y = now.getFullYear();
    m = now.getMonth() + 1;
  }
  const d = new Date(y, m - 1 + deltaMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 撮影データが存在する昇順ソート済みの YYYY-MM リストを取得する
 */
function _getAvailableSortedYms() {
  const ymSet = new Set();
  (state.availableTimeline || []).forEach(item => {
    if (item && item.year_month && /^\d{4}-\d{2}$/.test(item.year_month)) {
      ymSet.add(item.year_month);
    }
  });
  if (state.calendarDaysMap) {
    state.calendarDaysMap.forEach(info => {
      if (info && info.year_month && /^\d{4}-\d{2}$/.test(info.year_month)) {
        ymSet.add(info.year_month);
      }
    });
  }
  return Array.from(ymSet).sort();
}

/**
 * 現在の YYYY-MM から前後の撮影月（または forceOneMonth 時は暦上の前後1ヶ月）を取得する
 */
function _getAdjacentYearMonth(currentYm, direction, forceOneMonth = false) {
  if (forceOneMonth) {
    return _shiftYearMonth(currentYm, direction);
  }
  const sortedYms = _getAvailableSortedYms();
  if (sortedYms.length === 0) {
    return _shiftYearMonth(currentYm, direction);
  }
  if (direction < 0) {
    const prevCandidates = sortedYms.filter(ym => ym < currentYm);
    return prevCandidates.length > 0
      ? prevCandidates[prevCandidates.length - 1]
      : _shiftYearMonth(currentYm, -1);
  } else {
    const nextCandidates = sortedYms.filter(ym => ym > currentYm);
    return nextCandidates.length > 0
      ? nextCandidates[0]
      : _shiftYearMonth(currentYm, 1);
  }
}

/**
 * 2つの YYYY-MM-DD 間のすべての日付配列（両端含む・昇順）を生成する（最大366日上限）
 */
function _getDateRangeArray(dateA, dateB) {
  const [startStr, endStr] = dateA <= dateB ? [dateA, dateB] : [dateB, dateA];
  const p1 = startStr.split('-').map(Number);
  const p2 = endStr.split('-').map(Number);
  if (p1.length !== 3 || p2.length !== 3 || p1.some(isNaN) || p2.some(isNaN)) {
    return [dateB];
  }
  const result = [];
  const cur = new Date(p1[0], p1[1] - 1, p1[2]);
  const end = new Date(p2[0], p2[1] - 1, p2[2]);
  let guard = 0;
  while (cur <= end && guard < 366) {
    const yy = cur.getFullYear();
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    const dd = String(cur.getDate()).padStart(2, '0');
    result.push(`${yy}-${mm}-${dd}`);
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return result;
}

/**
 * 左サイドバー上部の常設7列ミニカレンダーを描画する
 */
function renderSidebarMiniCalendar() {
  initTimelineToolbarEvents();
  const boxEl = document.getElementById('sidebarMiniCalendarBox');
  const gridEl = document.getElementById('miniCalGrid');
  const titleBtn = document.getElementById('miniCalTitleBtn');
  const bodyEl = document.getElementById('miniCalBody');
  const collapseBtn = document.getElementById('miniCalCollapseBtn');
  if (!boxEl || !gridEl || !titleBtn) return;

  if (!state.selectedDates) state.selectedDates = new Set();

  // 表示対象の YYYY-MM を決定
  if (!state.miniCalendarYm || !/^\d{4}-\d{2}$/.test(state.miniCalendarYm)) {
    if (state.selectedDates.size > 0) {
      const firstDate = Array.from(state.selectedDates).sort().pop();
      state.miniCalendarYm = firstDate.substring(0, 7);
    } else if (state.selectedYearMonths && state.selectedYearMonths.size > 0) {
      state.miniCalendarYm = Array.from(state.selectedYearMonths).sort().pop();
    } else if (state.availableTimeline && state.availableTimeline.length > 0) {
      const validYm = state.availableTimeline.find(t => /^\d{4}-\d{2}$/.test(t.year_month));
      if (validYm) state.miniCalendarYm = validYm.year_month;
    }
    if (!state.miniCalendarYm || !/^\d{4}-\d{2}$/.test(state.miniCalendarYm)) {
      const now = new Date();
      state.miniCalendarYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
  }

  // 折りたたみ状態の反映
  const isCollapsed = Boolean(state.isMiniCalendarCollapsed);
  if (bodyEl) bodyEl.style.display = isCollapsed ? 'none' : '';
  if (collapseBtn) {
    collapseBtn.textContent = isCollapsed ? '▶' : '▼';
    collapseBtn.title = isCollapsed ? 'ミニカレンダーを展開' : 'ミニカレンダーを折りたたむ';
  }

  const [yearStr, monthStr] = state.miniCalendarYm.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  // この月の合計撮影枚数を算出
  let monthPhotoCount = 0;
  let maxDayCountInMonth = 1;
  const tlMatch = (state.availableTimeline || []).find(t => t.year_month === state.miniCalendarYm);
  if (tlMatch) {
    monthPhotoCount = tlMatch.count || 0;
  }
  if (state.calendarDaysMap && state.calendarDaysMap.size > 0) {
    let sumFromDays = 0;
    state.calendarDaysMap.forEach((info, dKey) => {
      if (dKey.startsWith(state.miniCalendarYm + '-')) {
        const c = info.count || 0;
        sumFromDays += c;
        if (c > maxDayCountInMonth) maxDayCountInMonth = c;
      }
    });
    if (!tlMatch) monthPhotoCount = sumFromDays;
  }

  const isMonthSelected = Boolean(state.selectedYearMonths && state.selectedYearMonths.has(state.miniCalendarYm));
  titleBtn.innerHTML = `<span class="mini-cal-ym-label">${year}年${month}月</span><span class="mini-cal-ym-count">${monthPhotoCount}</span>`;
  titleBtn.classList.toggle('active', isMonthSelected);
  titleBtn.title = isMonthSelected
    ? `${year}年${month}月全体を選択中（クリックで月選択を解除）`
    : `クリックで ${year}年${month}月 全体（${monthPhotoCount}枚）をOR選択`;

  gridEl.innerHTML = '';

  const firstDayDow = new Date(year, month - 1, 1).getDay(); // 0(日)〜6(土)
  const daysInMonth = new Date(year, month, 0).getDate();

  // 月初の空白セル
  for (let i = 0; i < firstDayDow; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'mini-cal-cell is-empty';
    gridEl.appendChild(emptyCell);
  }

  // 今日の日付（ローカルタイム）
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  for (let day = 1; day <= daysInMonth; day++) {
    const ddStr = String(day).padStart(2, '0');
    const dateStr = `${yearStr}-${monthStr}-${ddStr}`;
    const dow = (firstDayDow + day - 1) % 7;
    const dayInfo = state.calendarDaysMap ? state.calendarDaysMap.get(dateStr) : null;
    const cnt = dayInfo ? (dayInfo.count || 0) : 0;
    const exCnt = dayInfo ? (dayInfo.excellent_count || 0) : 0;
    const isDateSelected = state.selectedDates.has(dateStr);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'mini-cal-cell';
    cell.dataset.date = dateStr;

    if (dow === 0) cell.classList.add('is-sun');
    else if (dow === 6) cell.classList.add('is-sat');
    if (dateStr === todayStr) cell.classList.add('is-today');

    if (cnt > 0) {
      cell.classList.add('has-photos');
      const ratio = Math.min(1, Math.log10(cnt + 1) / Math.log10(Math.max(5, maxDayCountInMonth) + 1));
      const lv = ratio >= 0.78 ? 4 : ratio >= 0.52 ? 3 : ratio >= 0.28 ? 2 : 1;
      cell.classList.add(`cal-lv-${lv}`);
    }
    if (isDateSelected) {
      cell.classList.add('is-selected');
    } else if (isMonthSelected && cnt > 0) {
      cell.classList.add('is-in-selected-month');
    }

    const locText = dayInfo && dayInfo.location_label ? ` / ${dayInfo.location_label}` : '';
    const exText = exCnt > 0 ? ` (優:${exCnt}枚)` : '';
    cell.title = cnt > 0
      ? `${year}年${month}月${day}日: ${cnt}枚${exText}${locText}\nクリック: 日付OR選択 ｜ Shift+クリック: 期間選択`
      : `${year}年${month}月${day}日 (撮影なし)`;

    cell.innerHTML = `
      <span class="mini-cal-day-num">${day}</span>
      ${cnt > 0 ? `<span class="mini-cal-day-dot" title="${cnt}枚"></span>` : ''}
    `;

    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTimelineDate(dateStr, e.shiftKey);
    });

    gridEl.appendChild(cell);
  }
}
window.renderSidebarMiniCalendar = renderSidebarMiniCalendar;

/**
 * タイムラインの描画 (年別エキスパンダ・複数年/複数月/複数日OR選択対応)
 */
function renderTimeline(timelineItems) {
  if (Array.isArray(timelineItems)) {
    state.availableTimeline = timelineItems;
  }
  initTimelineToolbarEvents();
  renderSidebarMiniCalendar();

  const container = elements.timelineTree || elements.timelineList;
  if (!container) return;

  const items = state.availableTimeline || [];
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-hint">日付情報なし</div>';
    return;
  }

  if (!state.selectedDates) state.selectedDates = new Set();

  // 年ごとにグルーピング
  const yearGroups = new Map();
  items.forEach(item => {
    const parts = (item.year_month || '').split('-');
    const year = parts[0] || '不明';
    const month = parts[1] || '';
    if (!yearGroups.has(year)) {
      yearGroups.set(year, { year, totalCount: 0, months: [] });
    }
    const group = yearGroups.get(year);
    group.totalCount += item.count;
    group.months.push({ ...item, month });
  });

  container.innerHTML = '';

  yearGroups.forEach((group, year) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'timeline-year-group';

    // その年内の選択月数・選択日数
    const selectedInYearCount = group.months.filter(m => state.selectedYearMonths.has(m.year_month)).length;
    const selectedDatesInYear = Array.from(state.selectedDates).filter(d => d.startsWith(`${year}-`)).length;
    const hasSelectedChild = selectedInYearCount > 0 || selectedDatesInYear > 0;
    const isExpanded = state.expandedTimelineYears.has(year) || hasSelectedChild;
    const isCollapsed = !isExpanded;

    const allMonthsSelected = group.months.length > 0 && selectedInYearCount === group.months.length;
    const hasPartialSelected = !allMonthsSelected && (selectedInYearCount > 0 || selectedDatesInYear > 0);

    // 年ヘッダー
    const headerEl = document.createElement('div');
    headerEl.className = `timeline-year-header ${allMonthsSelected ? 'active-all' : (hasPartialSelected ? 'has-active-child' : '')}`.trim();
    headerEl.dataset.year = year;

    let partialBadgeHtml = '';
    if (hasPartialSelected) {
      const badgeParts = [];
      if (selectedInYearCount > 0) badgeParts.push(`${selectedInYearCount}月`);
      if (selectedDatesInYear > 0) badgeParts.push(`${selectedDatesInYear}日`);
      const badgeLabel = `+${badgeParts.join('・')}`;
      partialBadgeHtml = `<span class="child-filter-badge is-accent" title="この年のうち ${badgeParts.join(' / ')} を選択中">${escapeHtml(badgeLabel)}</span>`;
    }

    headerEl.innerHTML = `
      <span class="tree-toggle-btn ${isCollapsed ? 'collapsed' : ''}" title="展開/折りたたみ">▼</span>
      <span class="timeline-year-title" title="クリックで ${escapeHtml(year)}年 全体をOR選択/解除">${escapeHtml(year)}年</span>
      ${partialBadgeHtml}
      <span class="nav-count">${group.totalCount}</span>
    `;

    // 矢印クリックで開閉トグル
    const toggleBtn = headerEl.querySelector('.tree-toggle-btn');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const monthListEl = groupEl.querySelector('.timeline-month-list');
      const isNowCollapsed = toggleBtn.classList.toggle('collapsed');
      if (isNowCollapsed) {
        state.expandedTimelineYears.delete(year);
      } else {
        state.expandedTimelineYears.add(year);
      }
      if (monthListEl) {
        monthListEl.classList.toggle('hidden', isNowCollapsed);
      }
    });

    // 年ヘッダーのクリックでその年の全月を一括選択/解除（2024年 OR 2025年 OR 2026年 等の大雑把なOR選択）
    headerEl.addEventListener('click', () => {
      const firstMonth = group.months[0]?.year_month;
      if (firstMonth) {
        state.miniCalendarYm = firstMonth;
      }
      toggleYearMonths(group.months.map(m => m.year_month), year);
    });

    groupEl.appendChild(headerEl);

    // 月リスト
    const monthListEl = document.createElement('ul');
    monthListEl.className = `timeline-month-list ${isCollapsed ? 'hidden' : ''}`;

    group.months.forEach(m => {
      const monthLi = document.createElement('li');
      monthLi.className = 'nav-item timeline-month-item';
      const isMonthActive = state.selectedYearMonths.has(m.year_month);
      const datesInThisMonth = Array.from(state.selectedDates).filter(d => d.startsWith(`${m.year_month}-`)).length;

      if (isMonthActive) {
        monthLi.classList.add('active');
      } else if (datesInThisMonth > 0) {
        monthLi.classList.add('has-active-child');
      }
      if (state.miniCalendarYm === m.year_month) {
        monthLi.classList.add('is-mini-cal-focused');
      }
      monthLi.dataset.filterType = 'year_month';
      monthLi.dataset.filterValue = m.year_month;

      const displayMonth = m.month ? `${parseInt(m.month, 10)}月` : m.year_month;
      const dayBadgeHtml = (!isMonthActive && datesInThisMonth > 0)
        ? `<span class="child-filter-badge is-accent" title="この月のうち ${datesInThisMonth}日を選択中">+${datesInThisMonth}日</span>`
        : '';

      monthLi.innerHTML = `
        <span class="nav-text">${escapeHtml(displayMonth)}</span>
        ${dayBadgeHtml}
        <span class="nav-count">${m.count}</span>
      `;

      monthLi.addEventListener('click', (e) => {
        e.stopPropagation();
        state.miniCalendarYm = m.year_month;
        toggleTimelineYearMonth(m.year_month);
      });

      monthListEl.appendChild(monthLi);
    });

    groupEl.appendChild(monthListEl);
    container.appendChild(groupEl);
  });
}

/**
 * 年内の月を一括トグル選択 (全選択 ⇄ 全解除)
 */
function toggleYearMonths(yearMonthsList, yearStr = null) {
  if (!state.selectedDates) state.selectedDates = new Set();
  const allAlreadySelected = yearMonthsList.length > 0 && yearMonthsList.every(ym => state.selectedYearMonths.has(ym));
  if (allAlreadySelected) {
    yearMonthsList.forEach(ym => state.selectedYearMonths.delete(ym));
    if (yearStr) {
      Array.from(state.selectedDates).forEach(d => {
        if (d.startsWith(`${yearStr}-`)) state.selectedDates.delete(d);
      });
    }
  } else {
    yearMonthsList.forEach(ym => {
      state.selectedYearMonths.add(ym);
      Array.from(state.selectedDates).forEach(d => {
        if (d.startsWith(`${ym}-`)) state.selectedDates.delete(d);
      });
    });
  }
  updateTimelineFilterState();
}

/**
 * タイムライン年月のトグル処理 (複数月選択 / OR条件フィルタ)
 */
function toggleTimelineYearMonth(yearMonth) {
  if (!state.selectedDates) state.selectedDates = new Set();
  if (/^\d{4}-\d{2}$/.test(yearMonth)) {
    state.miniCalendarYm = yearMonth;
  }
  const hasDatesInMonth = Array.from(state.selectedDates).some(d => d.startsWith(`${yearMonth}-`));
  if (state.selectedYearMonths.has(yearMonth)) {
    state.selectedYearMonths.delete(yearMonth);
  } else {
    state.selectedYearMonths.add(yearMonth);
    if (hasDatesInMonth) {
      Array.from(state.selectedDates).forEach(d => {
        if (d.startsWith(`${yearMonth}-`)) state.selectedDates.delete(d);
      });
    }
  }
  updateTimelineFilterState();
}

/**
 * カレンダー日付（YYYY-MM-DD）のトグル選択・Shift範囲選択処理（OR条件フィルタ）
 */
function toggleTimelineDate(dateStr, isShift = false) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
  if (!state.selectedDates) state.selectedDates = new Set();

  const ym = dateStr.substring(0, 7);
  state.miniCalendarYm = ym;

  // もしその月全体（YYYY-MM）が選択されていた場合は、月全体選択を解除して日単位選択へ移行する
  if (state.selectedYearMonths && state.selectedYearMonths.has(ym)) {
    state.selectedYearMonths.delete(ym);
  }

  if (isShift && state.lastClickedCalendarDate && /^\d{4}-\d{2}-\d{2}$/.test(state.lastClickedCalendarDate)) {
    const rangeDates = _getDateRangeArray(state.lastClickedCalendarDate, dateStr);
    const datesWithPhotos = rangeDates.filter(d => state.calendarDaysMap && state.calendarDaysMap.has(d));
    const targetList = datesWithPhotos.length > 0 ? datesWithPhotos : rangeDates;
    targetList.forEach(d => {
      const dYm = d.substring(0, 7);
      if (state.selectedYearMonths) state.selectedYearMonths.delete(dYm);
      state.selectedDates.add(d);
    });
  } else {
    if (state.selectedDates.has(dateStr)) {
      state.selectedDates.delete(dateStr);
    } else {
      state.selectedDates.add(dateStr);
    }
  }

  state.lastClickedCalendarDate = dateStr;
  updateTimelineFilterState();
}
window.toggleTimelineDate = toggleTimelineDate;

/**
 * タイムライン選択状態の共通更新（タイトル・アクティブクラス・ミニカレンダー・再取得）
 */
function updateTimelineFilterState() {
  if (!state.selectedDates) state.selectedDates = new Set();
  state.untaggedOnly = false;
  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');

  const isFolderActive = state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude');
  const ymCount = state.selectedYearMonths.size;
  const dateCount = state.selectedDates.size;
  const totalSelected = ymCount + dateCount;

  if (!isFolderActive) {
    if (totalSelected === 0) {
      state.currentFilter = { type: 'all', value: null };
      if (elements.viewTitle) elements.viewTitle.textContent = 'すべての写真';
    } else if (ymCount === 1 && dateCount === 0) {
      const singleYm = Array.from(state.selectedYearMonths)[0];
      state.currentFilter = { type: 'year_month', value: singleYm };
      if (elements.viewTitle) elements.viewTitle.textContent = `${singleYm}`;
    } else if (ymCount === 0 && dateCount === 1) {
      const singleDate = Array.from(state.selectedDates)[0];
      state.currentFilter = { type: 'date', value: singleDate };
      if (elements.viewTitle) elements.viewTitle.textContent = `${singleDate}`;
    } else {
      const sortedYms = Array.from(state.selectedYearMonths).sort();
      const sortedDates = Array.from(state.selectedDates).sort();
      const combined = [...sortedYms, ...sortedDates];
      state.currentFilter = { type: 'year_months', value: combined };
      if (elements.viewTitle) {
        elements.viewTitle.textContent = `日程選択 (${combined.slice(0, 4).join(', ')}${combined.length > 4 ? ` ほか${combined.length - 4}件` : ''})`;
      }
    }
  }

  updateTimelineActiveClasses();
  fetchPhotos();
}

/**
 * タイムラインおよびミニカレンダー・関連サイドバー要素のアクティブ表示を更新
 */
function updateTimelineActiveClasses() {
  if (!state.selectedDates) state.selectedDates = new Set();
  const hasSelection = state.selectedYearMonths.size > 0 || state.selectedDates.size > 0;
  const hasCamOrLens = (state.selectedCameras && state.selectedCameras.size > 0) ||
    (state.cameraFilters && state.cameraFilters.size > 0) ||
    (state.lensFilters && state.lensFilters.size > 0);

  // 「すべての写真」のアクティブ表示切替
  document.querySelectorAll('.sidebar [data-filter-type="all"]').forEach(el => {
    if (!hasSelection && state.currentFilter.type === 'all' && !hasCamOrLens) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  // フォルダ選択の解除
  if (hasSelection && elements.folderList) {
    elements.folderList.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  }

  // ミニカレンダーの再描画とツリー状態更新
  renderSidebarMiniCalendar();

  const container = elements.timelineTree || elements.timelineList;
  if (container) {
    container.querySelectorAll('.timeline-year-group').forEach(groupEl => {
      const headerEl = groupEl.querySelector('.timeline-year-header');
      const year = headerEl ? headerEl.dataset.year : '';
      const monthItems = groupEl.querySelectorAll('.timeline-month-item');
      let selectedInYearCount = 0;

      monthItems.forEach(itemEl => {
        const ym = itemEl.dataset.filterValue;
        const isMonthSel = Boolean(ym && state.selectedYearMonths.has(ym));
        const datesInMonth = ym ? Array.from(state.selectedDates).filter(d => d.startsWith(`${ym}-`)).length : 0;

        itemEl.classList.toggle('active', isMonthSel);
        itemEl.classList.toggle('has-active-child', !isMonthSel && datesInMonth > 0);
        itemEl.classList.toggle('is-mini-cal-focused', Boolean(ym && state.miniCalendarYm === ym));

        if (isMonthSel) selectedInYearCount++;

        const existingMonthBadge = itemEl.querySelector('.child-filter-badge');
        if (!isMonthSel && datesInMonth > 0) {
          if (existingMonthBadge) {
            existingMonthBadge.textContent = `+${datesInMonth}日`;
            existingMonthBadge.title = `この月のうち ${datesInMonth}日を選択中`;
          } else {
            const badge = document.createElement('span');
            badge.className = 'child-filter-badge is-accent';
            badge.textContent = `+${datesInMonth}日`;
            badge.title = `この月のうち ${datesInMonth}日を選択中`;
            const countEl = itemEl.querySelector('.nav-count');
            if (countEl) itemEl.insertBefore(badge, countEl);
            else itemEl.appendChild(badge);
          }
        } else if (existingMonthBadge) {
          existingMonthBadge.remove();
        }
      });

      const selectedDatesInYear = year ? Array.from(state.selectedDates).filter(d => d.startsWith(`${year}-`)).length : 0;
      const allSelected = monthItems.length > 0 && selectedInYearCount === monthItems.length;
      const hasPartial = !allSelected && (selectedInYearCount > 0 || selectedDatesInYear > 0);

      if (headerEl) {
        headerEl.classList.toggle('active-all', allSelected);
        headerEl.classList.toggle('has-active-child', hasPartial);
        const existingBadge = headerEl.querySelector('.child-filter-badge');
        if (hasPartial) {
          const badgeParts = [];
          if (selectedInYearCount > 0) badgeParts.push(`${selectedInYearCount}月`);
          if (selectedDatesInYear > 0) badgeParts.push(`${selectedDatesInYear}日`);
          const labelTxt = `+${badgeParts.join('・')}`;
          const titleTxt = `この年のうち ${badgeParts.join(' / ')} を選択中`;
          if (existingBadge) {
            existingBadge.textContent = labelTxt;
            existingBadge.title = titleTxt;
          } else {
            const badge = document.createElement('span');
            badge.className = 'child-filter-badge is-accent';
            badge.textContent = labelTxt;
            badge.title = titleTxt;
            const countEl = headerEl.querySelector('.nav-count');
            if (countEl) headerEl.insertBefore(badge, countEl);
            else headerEl.appendChild(badge);
          }
        } else if (existingBadge) {
          existingBadge.remove();
        }
      }
    });
  }

  // 拡大カレンダーモーダルが開いていれば同期更新
  const calModal = document.getElementById('calendarModal');
  if (calModal && calModal.style.display !== 'none') {
    renderCalendarModalContent();
  }
}

/**
 * タイムライン操作ツールバー＆ミニカレンダーヘッダーのイベント登録
 */
function initTimelineToolbarEvents() {
  const reloadBtn = document.getElementById('reloadTimelineTreeBtn');
  if (reloadBtn && !reloadBtn.dataset.bound) {
    reloadBtn.dataset.bound = '1';
    reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof fetchTimeline === 'function') fetchTimeline();
      fetchCalendarSummary();
    });
  }

  const openCalBtn = document.getElementById('timelineOpenCalendarBtn');
  if (openCalBtn && !openCalBtn.dataset.bound) {
    openCalBtn.dataset.bound = '1';
    openCalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCalendarModal('month');
    });
  }

  const expandBtn = document.getElementById('expandAllTimelineBtn');
  if (expandBtn && !expandBtn.dataset.bound) {
    expandBtn.dataset.bound = '1';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      (state.availableTimeline || []).forEach(item => {
        const yr = String(item.year_month || '').split('-')[0];
        if (yr) state.expandedTimelineYears.add(yr);
      });
      renderTimeline(state.availableTimeline);
    });
  }

  const collapseBtn = document.getElementById('collapseAllTimelineBtn');
  if (collapseBtn && !collapseBtn.dataset.bound) {
    collapseBtn.dataset.bound = '1';
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.expandedTimelineYears.clear();
      renderTimeline(state.availableTimeline);
    });
  }

  const miniCollapseBtn = document.getElementById('miniCalCollapseBtn');
  if (miniCollapseBtn && !miniCollapseBtn.dataset.bound) {
    miniCollapseBtn.dataset.bound = '1';
    miniCollapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.isMiniCalendarCollapsed = !state.isMiniCalendarCollapsed;
      localStorage.setItem('pm_mini_cal_collapsed', state.isMiniCalendarCollapsed ? 'true' : 'false');
      renderSidebarMiniCalendar();
    });
  }

  const prevMonthBtn = document.getElementById('miniCalPrevMonthBtn');
  if (prevMonthBtn && !prevMonthBtn.dataset.bound) {
    prevMonthBtn.dataset.bound = '1';
    prevMonthBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.miniCalendarYm = _getAdjacentYearMonth(state.miniCalendarYm, -1, e.shiftKey);
      renderSidebarMiniCalendar();
      updateTimelineActiveClasses();
    });
  }

  const nextMonthBtn = document.getElementById('miniCalNextMonthBtn');
  if (nextMonthBtn && !nextMonthBtn.dataset.bound) {
    nextMonthBtn.dataset.bound = '1';
    nextMonthBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.miniCalendarYm = _getAdjacentYearMonth(state.miniCalendarYm, 1, e.shiftKey);
      renderSidebarMiniCalendar();
      updateTimelineActiveClasses();
    });
  }

  const titleBtn = document.getElementById('miniCalTitleBtn');
  if (titleBtn && !titleBtn.dataset.bound) {
    titleBtn.dataset.bound = '1';
    titleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.miniCalendarYm) {
        toggleTimelineYearMonth(state.miniCalendarYm);
      }
    });
  }

  const miniExpandModalBtn = document.getElementById('miniCalOpenModalBtn');
  if (miniExpandModalBtn && !miniExpandModalBtn.dataset.bound) {
    miniExpandModalBtn.dataset.bound = '1';
    miniExpandModalBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCalendarModal('month');
    });
  }
}

/**
 * 拡大カレンダーモーダル (#calendarModal) のDOM生成・取得
 */
function ensureCalendarModalDom() {
  let modal = document.getElementById('calendarModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'calendarModal';
    modal.className = 'modal-backdrop';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }

  if (!modal.querySelector('#calTabPaneMonth') || !modal.querySelector('#calTabPaneYear')) {
    modal.innerHTML = `
      <div class="modal-card modal-card-lg calendar-modal-card" style="max-width: 1140px; width: 95vw; max-height: 92vh; display: flex; flex-direction: column;">
        <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--border-soft, rgba(255,255,255,0.1));">
          <div class="modal-header-title">
            <h2 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span>フォトカレンダー ＆ 年間12ヶ月ヒートマップ</span>
            </h2>
            <span class="modal-subtitle" style="font-size: 0.78rem; color: var(--text-muted, #94a3b8);">
              年・月・日・期間（Shift+クリック）をOR条件で自由に組み合わせて写真を絞り込めます（ダブルクリックでその日のみを即時表示）
            </span>
          </div>
          <button type="button" class="modal-close-btn" id="closeCalendarModalBtn" title="閉じる (Esc)">&times;</button>
        </div>

        <!-- 上部サマリーバー -->
        <div id="calendarModalSummaryBar" class="location-map-summary-bar" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; padding: 10px 20px; background: var(--bg-tertiary, #252b34); border-bottom: 1px solid var(--border-soft, rgba(255,255,255,0.1));"></div>

        <!-- アンダーラインタブバー -->
        <div class="map-tabs-nav" id="calendarModalTabsNav" style="display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid var(--border-soft, rgba(255,255,255,0.1)); background: var(--bg-secondary, #1b2028);">
          <div style="display: flex; gap: 22px;">
            <button type="button" class="map-tab-btn active" data-cal-tab="month" style="padding: 10px 4px; background: transparent; border: none; border-bottom: 2px solid var(--accent-primary, #e14d2a); color: var(--text-primary, #f1f5f9); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
              月間フォトカレンダー
            </button>
            <button type="button" class="map-tab-btn" data-cal-tab="year" style="padding: 10px 4px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--text-muted, #94a3b8); font-weight: 600; font-size: 0.88rem; cursor: pointer;">
              年間12ヶ月ヒートマップ (年別OR選択)
            </button>
          </div>
          <div id="calendarModalActiveSelectionBar" style="display: flex; align-items: center; gap: 8px; font-size: 0.78rem;"></div>
        </div>

        <!-- タブコンテンツ本体 -->
        <div class="modal-body calendar-modal-body" style="padding: 14px 20px; overflow-y: auto; flex: 1;">
          <!-- タブ1: 月間フォトカレンダー -->
          <div id="calTabPaneMonth" class="cal-tab-pane">
            <div class="cal-modal-toolbar">
              <div class="cal-modal-nav-group">
                <button type="button" class="btn btn-secondary btn-xs" id="calModalPrevMonthBtn" title="前の撮影月へ移動 (← キー / Shift+クリックで1ヶ月前)">◀ 前の月</button>
                <select id="calModalYearSelect" class="styled-select cal-modal-select" aria-label="年を選択"></select>
                <select id="calModalMonthSelect" class="styled-select cal-modal-select" aria-label="月を選択"></select>
                <button type="button" class="btn btn-secondary btn-xs" id="calModalNextMonthBtn" title="次の撮影月へ移動 (→ キー / Shift+クリックで1ヶ月後)">次の月 ▶</button>
              </div>
              <div class="cal-modal-action-group">
                <button type="button" class="btn btn-secondary btn-xs" id="calModalToggleMonthBtn" title="表示中の月全体をOR選択/解除">この月全体を選択</button>
                <button type="button" class="btn btn-secondary btn-xs" id="calModalToggleThumbBtn" title="日付マス内の代表サムネイル画像の表示/非表示を切り替え">サムネイル表示: ON</button>
              </div>
            </div>
            <div class="cal-modal-weekdays">
              <span class="is-sun">日曜日</span><span>月曜日</span><span>火曜日</span><span>水曜日</span><span>木曜日</span><span>金曜日</span><span class="is-sat">土曜日</span>
            </div>
            <div class="cal-modal-month-grid" id="calModalMonthGrid"></div>
          </div>

          <!-- タブ2: 年間12ヶ月ヒートマップ -->
          <div id="calTabPaneYear" class="cal-tab-pane" style="display: none;">
            <div class="cal-modal-toolbar">
              <div class="cal-modal-nav-group" style="flex-wrap: wrap;">
                <button type="button" class="btn btn-secondary btn-xs" id="calModalPrevYearBtn" title="前年へ (← キー)">◀ 前年</button>
                <div class="cal-modal-year-pills" id="calModalYearPills"></div>
                <button type="button" class="btn btn-secondary btn-xs" id="calModalNextYearBtn" title="次年へ (→ キー)">次年 ▶</button>
              </div>
              <div class="cal-modal-action-group">
                <button type="button" class="btn btn-secondary btn-xs" id="calModalToggleYearBtn" title="表示中の年の全撮影月を一括でOR選択/解除">この年全体を選択</button>
                <div class="whitemap-mode-group">
                  <button type="button" class="btn btn-primary btn-xs" id="calModalHeatCountBtn" data-heat-mode="count">撮影枚数</button>
                  <button type="button" class="btn btn-secondary btn-xs" id="calModalHeatExcellentBtn" data-heat-mode="excellent">優枚数</button>
                </div>
              </div>
            </div>
            <div class="cal-modal-year-grid" id="calModalYearGrid"></div>
          </div>
        </div>

        <div class="modal-footer" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; border-top: 1px solid var(--border-soft, rgba(255,255,255,0.1));">
          <span style="font-size: 0.76rem; color: var(--text-muted, #94a3b8);">
            ヒント: 日付クリックで複数日OR選択 ／ Shift+クリックで期間一括選択 ／ ダブルクリックでその日のみを即座に表示
          </span>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-secondary btn-sm" id="calModalClearSelectionBtn">日程選択をクリア</button>
            <button type="button" class="btn btn-primary btn-sm" id="calModalDoneBtn">表示に反映して閉じる</button>
          </div>
        </div>
      </div>
    `;

    // イベントバインド
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeCalendarModal();
    });
    modal.querySelector('#closeCalendarModalBtn')?.addEventListener('click', closeCalendarModal);
    modal.querySelector('#calModalDoneBtn')?.addEventListener('click', closeCalendarModal);

    modal.querySelector('#calModalClearSelectionBtn')?.addEventListener('click', () => {
      state.selectedYearMonths.clear();
      if (state.selectedDates) state.selectedDates.clear();
      updateTimelineFilterState();
    });

    // タブ切替
    modal.querySelectorAll('[data-cal-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        _calModalActiveTab = btn.dataset.calTab || 'month';
        renderCalendarModalContent();
      });
    });

    // 月間タブナビゲーション
    modal.querySelector('#calModalPrevMonthBtn')?.addEventListener('click', (e) => {
      _calModalYm = _getAdjacentYearMonth(_calModalYm, -1, e.shiftKey);
      state.miniCalendarYm = _calModalYm;
      renderSidebarMiniCalendar();
      renderCalendarModalContent();
    });
    modal.querySelector('#calModalNextMonthBtn')?.addEventListener('click', (e) => {
      _calModalYm = _getAdjacentYearMonth(_calModalYm, 1, e.shiftKey);
      state.miniCalendarYm = _calModalYm;
      renderSidebarMiniCalendar();
      renderCalendarModalContent();
    });

    const ySel = modal.querySelector('#calModalYearSelect');
    const mSel = modal.querySelector('#calModalMonthSelect');
    const onYmSelectChange = () => {
      if (ySel && mSel && ySel.value && mSel.value) {
        _calModalYm = `${ySel.value}-${String(mSel.value).padStart(2, '0')}`;
        _calModalYear = ySel.value;
        state.miniCalendarYm = _calModalYm;
        renderSidebarMiniCalendar();
        renderCalendarModalContent();
      }
    };
    ySel?.addEventListener('change', onYmSelectChange);
    mSel?.addEventListener('change', onYmSelectChange);

    modal.querySelector('#calModalToggleMonthBtn')?.addEventListener('click', () => {
      if (_calModalYm) {
        toggleTimelineYearMonth(_calModalYm);
      }
    });

    modal.querySelector('#calModalToggleThumbBtn')?.addEventListener('click', () => {
      _calModalShowThumbs = !_calModalShowThumbs;
      localStorage.setItem('pm_cal_modal_thumbs', _calModalShowThumbs ? 'true' : 'false');
      renderCalendarModalContent();
    });

    // 年間タブナビゲーション
    modal.querySelector('#calModalPrevYearBtn')?.addEventListener('click', () => {
      const years = _getAvailableYearsList();
      const idx = years.indexOf(String(_calModalYear));
      if (idx > 0) _calModalYear = years[idx - 1];
      else _calModalYear = String((parseInt(_calModalYear, 10) || new Date().getFullYear()) - 1);
      renderCalendarModalContent();
    });
    modal.querySelector('#calModalNextYearBtn')?.addEventListener('click', () => {
      const years = _getAvailableYearsList();
      const idx = years.indexOf(String(_calModalYear));
      if (idx !== -1 && idx < years.length - 1) _calModalYear = years[idx + 1];
      else _calModalYear = String((parseInt(_calModalYear, 10) || new Date().getFullYear()) + 1);
      renderCalendarModalContent();
    });

    modal.querySelector('#calModalToggleYearBtn')?.addEventListener('click', () => {
      if (!_calModalYear) return;
      const yearMonths = (state.availableTimeline || [])
        .map(t => t.year_month)
        .filter(ym => ym && ym.startsWith(`${_calModalYear}-`));
      if (yearMonths.length > 0) {
        toggleYearMonths(yearMonths, String(_calModalYear));
      }
    });

    modal.querySelectorAll('[data-heat-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        _calModalHeatMode = btn.dataset.heatMode || 'count';
        renderCalendarModalContent();
      });
    });

    // キーボードナビゲーション (Esc / ← / →)
    if (!window._calModalKeydownBound) {
      window._calModalKeydownBound = true;
      document.addEventListener('keydown', (e) => {
        const m = document.getElementById('calendarModal');
        if (!m || m.style.display === 'none') return;
        if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          closeCalendarModal();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (_calModalActiveTab === 'month') {
            _calModalYm = _getAdjacentYearMonth(_calModalYm, -1, e.shiftKey);
            state.miniCalendarYm = _calModalYm;
            renderSidebarMiniCalendar();
            renderCalendarModalContent();
          } else {
            m.querySelector('#calModalPrevYearBtn')?.click();
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (_calModalActiveTab === 'month') {
            _calModalYm = _getAdjacentYearMonth(_calModalYm, 1, e.shiftKey);
            state.miniCalendarYm = _calModalYm;
            renderSidebarMiniCalendar();
            renderCalendarModalContent();
          } else {
            m.querySelector('#calModalNextYearBtn')?.click();
          }
        }
      });
    }
  }
  return modal;
}

/**
 * 利用可能な年リスト（昇順）を取得する
 */
function _getAvailableYearsList() {
  const ySet = new Set();
  (state.availableTimeline || []).forEach(item => {
    const y = String(item.year_month || '').split('-')[0];
    if (/^\d{4}$/.test(y)) ySet.add(y);
  });
  if (state.calendarDaysMap) {
    state.calendarDaysMap.forEach((_, dKey) => {
      const y = dKey.substring(0, 4);
      if (/^\d{4}$/.test(y)) ySet.add(y);
    });
  }
  if (ySet.size === 0) {
    ySet.add(String(new Date().getFullYear()));
  }
  return Array.from(ySet).sort();
}

/**
 * 拡大カレンダーモーダルを開く
 */
async function openCalendarModal(initialTab = 'month', targetYm = null) {
  const modal = ensureCalendarModalDom();
  if (initialTab) _calModalActiveTab = initialTab;
  if (targetYm && /^\d{4}-\d{2}$/.test(targetYm)) {
    _calModalYm = targetYm;
    state.miniCalendarYm = targetYm;
  } else if (!_calModalYm) {
    _calModalYm = state.miniCalendarYm;
  }
  if (_calModalYm && /^\d{4}-\d{2}$/.test(_calModalYm)) {
    _calModalYear = _calModalYm.split('-')[0];
  } else {
    const years = _getAvailableYearsList();
    _calModalYear = years[years.length - 1];
    _calModalYm = `${_calModalYear}-01`;
  }

  modal.style.display = 'flex';
  if (!state.calendarDaysMap || state.calendarDaysMap.size === 0) {
    await fetchCalendarSummary();
  }
  renderCalendarModalContent();
}
window.openCalendarModal = openCalendarModal;

/**
 * 拡大カレンダーモーダルを閉じる
 */
function closeCalendarModal() {
  const modal = document.getElementById('calendarModal');
  if (modal) modal.style.display = 'none';
}
window.closeCalendarModal = closeCalendarModal;

/**
 * 拡大カレンダーモーダル内部の描画（サマリーバー・月間フォトカレンダー・年間12ヶ月ヒートマップ）
 */
function renderCalendarModalContent() {
  const modal = document.getElementById('calendarModal');
  if (!modal || modal.style.display === 'none') return;

  if (!state.selectedDates) state.selectedDates = new Set();

  // タブボタンとペインの同期
  modal.querySelectorAll('[data-cal-tab]').forEach(btn => {
    const isAct = btn.dataset.calTab === _calModalActiveTab;
    btn.classList.toggle('active', isAct);
    btn.style.borderBottomColor = isAct ? 'var(--accent-primary, #e14d2a)' : 'transparent';
    btn.style.color = isAct ? 'var(--text-primary, #f1f5f9)' : 'var(--text-muted, #94a3b8)';
  });
  const monthPane = modal.querySelector('#calTabPaneMonth');
  const yearPane = modal.querySelector('#calTabPaneYear');
  if (monthPane) monthPane.style.display = _calModalActiveTab === 'month' ? 'block' : 'none';
  if (yearPane) yearPane.style.display = _calModalActiveTab === 'year' ? 'block' : 'none';

  // サマリーバーの更新
  const summaryBar = modal.querySelector('#calendarModalSummaryBar');
  if (summaryBar) {
    const totalDays = state.calendarDaysMap ? state.calendarDaysMap.size : 0;
    const totalMonths = (state.availableTimeline || []).length;
    let peakDay = '-';
    let peakCount = 0;
    if (state.calendarDaysMap) {
      state.calendarDaysMap.forEach((info, dKey) => {
        if ((info.count || 0) > peakCount) {
          peakCount = info.count || 0;
          peakDay = dKey;
        }
      });
    }
    const selYmCnt = state.selectedYearMonths.size;
    const selDateCnt = state.selectedDates.size;
    const selSummary = (selYmCnt === 0 && selDateCnt === 0)
      ? '未選択 (全期間)'
      : `${selYmCnt > 0 ? `${selYmCnt}ヶ月` : ''}${selYmCnt > 0 && selDateCnt > 0 ? ' ＋ ' : ''}${selDateCnt > 0 ? `${selDateCnt}日` : ''} (OR選択中)`;

    summaryBar.innerHTML = `
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, rgba(255,255,255,0.08));">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">総撮影日数 / 撮影月数</div>
        <div style="font-size: 1rem; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px;">${totalDays.toLocaleString()} 日 <span style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted, #94a3b8);">(${totalMonths}ヶ月)</span></div>
      </div>
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, rgba(255,255,255,0.08));">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">最多撮影日</div>
        <div style="font-size: 0.95rem; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px;">${peakCount > 0 ? `${escapeHtml(peakDay)} (${peakCount.toLocaleString()}枚)` : '-'}</div>
      </div>
      <div class="lab-stat-box" style="padding: 8px 12px; border-radius: 6px; background: var(--bg-secondary, #1b2028); border: 1px solid var(--border-soft, rgba(255,255,255,0.08));">
        <div style="font-size: 0.72rem; color: var(--text-muted, #94a3b8);">現在のタイムライン絞り込み</div>
        <div style="font-size: 0.92rem; font-weight: 700; color: ${(selYmCnt + selDateCnt) > 0 ? 'var(--accent-primary, #e14d2a)' : 'var(--text-primary, #f1f5f9)'}; margin-top: 2px;">${escapeHtml(selSummary)}</div>
      </div>
    `;
  }

  if (_calModalActiveTab === 'month') {
    _renderCalendarModalMonthView(modal);
  } else {
    _renderCalendarModalYearView(modal);
  }
}

/**
 * 拡大カレンダー タブ1: 月間フォトカレンダーの描画
 */
function _renderCalendarModalMonthView(modal) {
  if (!_calModalYm || !/^\d{4}-\d{2}$/.test(_calModalYm)) {
    _calModalYm = state.miniCalendarYm || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  }
  const [yearStr, monthStr] = _calModalYm.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  _calModalYear = yearStr;

  // 年・月セレクトの構築
  const ySel = modal.querySelector('#calModalYearSelect');
  const mSel = modal.querySelector('#calModalMonthSelect');
  const years = _getAvailableYearsList();
  if (!years.includes(yearStr)) years.push(yearStr);
  years.sort();

  if (ySel) {
    ySel.innerHTML = years.map(y => `<option value="${escapeHtml(y)}" ${y === yearStr ? 'selected' : ''}>${escapeHtml(y)}年</option>`).join('');
  }
  if (mSel) {
    let mHtml = '';
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const ymKey = `${yearStr}-${mm}`;
      const tlItem = (state.availableTimeline || []).find(t => t.year_month === ymKey);
      const cntTxt = tlItem && tlItem.count ? ` (${tlItem.count}枚)` : '';
      mHtml += `<option value="${mm}" ${m === month ? 'selected' : ''}>${m}月${cntTxt}</option>`;
    }
    mSel.innerHTML = mHtml;
  }

  // 月全体選択ボタン・サムネイル切替ボタンの同期
  const toggleMonthBtn = modal.querySelector('#calModalToggleMonthBtn');
  const isMonthSelected = Boolean(state.selectedYearMonths && state.selectedYearMonths.has(_calModalYm));
  if (toggleMonthBtn) {
    toggleMonthBtn.textContent = isMonthSelected ? `${year}年${month}月 全体を選択中` : `${year}年${month}月 全体を選択`;
    toggleMonthBtn.classList.toggle('btn-primary', isMonthSelected);
    toggleMonthBtn.classList.toggle('btn-secondary', !isMonthSelected);
  }

  const toggleThumbBtn = modal.querySelector('#calModalToggleThumbBtn');
  if (toggleThumbBtn) {
    toggleThumbBtn.textContent = `代表サムネイル: ${_calModalShowThumbs ? 'ON' : 'OFF'}`;
    toggleThumbBtn.classList.toggle('active', _calModalShowThumbs);
  }

  const gridEl = modal.querySelector('#calModalMonthGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '';

  const firstDayDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  let maxDayCount = 1;
  if (state.calendarDaysMap) {
    state.calendarDaysMap.forEach((info, dKey) => {
      if (dKey.startsWith(`${_calModalYm}-`) && (info.count || 0) > maxDayCount) {
        maxDayCount = info.count;
      }
    });
  }

  for (let i = 0; i < firstDayDow; i++) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'cal-modal-day-cell is-empty';
    gridEl.appendChild(emptyEl);
  }

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  for (let day = 1; day <= daysInMonth; day++) {
    const dd = String(day).padStart(2, '0');
    const dateStr = `${yearStr}-${monthStr}-${dd}`;
    const dow = (firstDayDow + day - 1) % 7;
    const dayInfo = state.calendarDaysMap ? state.calendarDaysMap.get(dateStr) : null;
    const cnt = dayInfo ? (dayInfo.count || 0) : 0;
    const exCnt = dayInfo ? (dayInfo.excellent_count || 0) : 0;
    const repId = dayInfo ? dayInfo.rep_photo_id : null;
    const locLabel = dayInfo ? (dayInfo.location_label || '') : '';
    const isDateSelected = state.selectedDates.has(dateStr);

    const cell = document.createElement('div');
    cell.className = 'cal-modal-day-cell';
    cell.dataset.date = dateStr;
    if (dow === 0) cell.classList.add('is-sun');
    else if (dow === 6) cell.classList.add('is-sat');
    if (dateStr === todayStr) cell.classList.add('is-today');

    if (cnt > 0) {
      cell.classList.add('has-photos');
      const ratio = Math.min(1, Math.log10(cnt + 1) / Math.log10(Math.max(5, maxDayCount) + 1));
      const lv = ratio >= 0.78 ? 4 : ratio >= 0.52 ? 3 : ratio >= 0.28 ? 2 : 1;
      cell.classList.add(`cal-lv-${lv}`);
    }
    if (isDateSelected) {
      cell.classList.add('is-selected');
    } else if (isMonthSelected && cnt > 0) {
      cell.classList.add('is-in-selected-month');
    }

    const showThumb = _calModalShowThumbs && cnt > 0 && repId;
    if (showThumb) cell.classList.add('has-thumb');

    cell.innerHTML = `
      ${showThumb ? `<div class="cal-modal-day-thumb-wrap"><img src="/api/photo/${encodeURIComponent(repId)}/thumbnail" alt="" loading="lazy" class="cal-modal-day-thumb"></div>` : ''}
      <div class="cal-modal-day-top">
        <span class="cal-modal-day-num">${day}</span>
        ${cnt > 0 ? `<span class="cal-modal-day-count">${cnt}枚</span>` : ''}
      </div>
      ${cnt > 0 ? `
        <div class="cal-modal-day-bottom">
          ${exCnt > 0 ? `<span class="cal-modal-ex-badge" title="評価「優」: ${exCnt}枚">優 ${exCnt}</span>` : '<span></span>'}
          ${locLabel ? `<span class="cal-modal-loc-label" title="${escapeHtml(locLabel)}">${escapeHtml(locLabel)}</span>` : ''}
        </div>
      ` : ''}
    `;

    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTimelineDate(dateStr, e.shiftKey);
    });

    cell.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      state.selectedYearMonths.clear();
      state.selectedDates.clear();
      state.selectedDates.add(dateStr);
      state.lastClickedCalendarDate = dateStr;
      updateTimelineFilterState();
      closeCalendarModal();
    });

    gridEl.appendChild(cell);
  }
}

/**
 * 拡大カレンダー タブ2: 年間12ヶ月ヒートマップの描画
 */
function _renderCalendarModalYearView(modal) {
  const years = _getAvailableYearsList();
  if (!_calModalYear || !years.includes(String(_calModalYear))) {
    _calModalYear = years[years.length - 1];
  }
  const yearNum = parseInt(_calModalYear, 10);

  // 年ピル一覧の描画（クリックで表示年切替、selected状態も表示）
  const pillsContainer = modal.querySelector('#calModalYearPills');
  if (pillsContainer) {
    pillsContainer.innerHTML = '';
    years.forEach(yStr => {
      const yMonths = (state.availableTimeline || []).filter(t => String(t.year_month || '').startsWith(`${yStr}-`));
      const allSel = yMonths.length > 0 && yMonths.every(m => state.selectedYearMonths.has(m.year_month));
      const partialSel = !allSel && (
        yMonths.some(m => state.selectedYearMonths.has(m.year_month)) ||
        Array.from(state.selectedDates).some(d => d.startsWith(`${yStr}-`))
      );

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-xs ${yStr === String(_calModalYear) ? 'btn-primary' : 'btn-secondary'}`;
      if (allSel || partialSel) {
        btn.style.outline = '1.5px solid var(--accent-primary, #e14d2a)';
      }
      btn.textContent = `${yStr}年${allSel ? ' ✓' : (partialSel ? ' •' : '')}`;
      btn.title = `${yStr}年の12ヶ月ヒートマップを表示（ダブルクリックで ${yStr}年 全体をOR選択/解除）`;
      btn.addEventListener('click', () => {
        _calModalYear = yStr;
        renderCalendarModalContent();
      });
      btn.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const ymList = yMonths.map(m => m.year_month);
        if (ymList.length > 0) toggleYearMonths(ymList, yStr);
      });
      pillsContainer.appendChild(btn);
    });
  }

  // この年全体を選択ボタン
  const toggleYearBtn = modal.querySelector('#calModalToggleYearBtn');
  const yearMonthsInYear = (state.availableTimeline || [])
    .map(t => t.year_month)
    .filter(ym => ym && ym.startsWith(`${_calModalYear}-`));
  const isAllYearSelected = yearMonthsInYear.length > 0 && yearMonthsInYear.every(ym => state.selectedYearMonths.has(ym));
  if (toggleYearBtn) {
    toggleYearBtn.textContent = isAllYearSelected ? `${_calModalYear}年 全体を選択中` : `${_calModalYear}年 全体を選択`;
    toggleYearBtn.classList.toggle('btn-primary', isAllYearSelected);
    toggleYearBtn.classList.toggle('btn-secondary', !isAllYearSelected);
    toggleYearBtn.disabled = yearMonthsInYear.length === 0;
  }

  // ヒートマップモードボタンの同期
  modal.querySelectorAll('[data-heat-mode]').forEach(btn => {
    const isAct = btn.dataset.heatMode === _calModalHeatMode;
    btn.classList.toggle('btn-primary', isAct);
    btn.classList.toggle('btn-secondary', !isAct);
  });

  // 年内の1日あたり最大値算出
  let maxValInYear = 1;
  if (state.calendarDaysMap) {
    state.calendarDaysMap.forEach((info, dKey) => {
      if (dKey.startsWith(`${_calModalYear}-`)) {
        const v = _calModalHeatMode === 'excellent' ? (info.excellent_count || 0) : (info.count || 0);
        if (v > maxValInYear) maxValInYear = v;
      }
    });
  }

  const yearGrid = modal.querySelector('#calModalYearGrid');
  if (!yearGrid) return;
  yearGrid.innerHTML = '';

  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const ymStr = `${_calModalYear}-${mm}`;
    const tlItem = (state.availableTimeline || []).find(t => t.year_month === ymStr);
    const mCount = tlItem ? (tlItem.count || 0) : 0;
    const isMonthSelected = state.selectedYearMonths.has(ymStr);

    const cardEl = document.createElement('div');
    cardEl.className = `cal-year-month-card ${isMonthSelected ? 'is-month-selected' : ''}`;

    const hdrEl = document.createElement('div');
    hdrEl.className = 'cal-year-month-header';
    hdrEl.innerHTML = `
      <button type="button" class="cal-year-month-title-btn" title="${_calModalYear}年${m}月のフォトカレンダーを開く">${m}月 <span class="cal-year-month-cnt">${mCount > 0 ? `${mCount}枚` : ''}</span></button>
      <button type="button" class="btn-mini-text cal-year-month-sel-btn ${isMonthSelected ? 'active' : ''}" title="${_calModalYear}年${m}月 全体をOR選択/解除">${isMonthSelected ? '選択中' : '+月選択'}</button>
    `;

    hdrEl.querySelector('.cal-year-month-title-btn')?.addEventListener('click', () => {
      _calModalYm = ymStr;
      state.miniCalendarYm = ymStr;
      _calModalActiveTab = 'month';
      renderSidebarMiniCalendar();
      renderCalendarModalContent();
    });

    hdrEl.querySelector('.cal-year-month-sel-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTimelineYearMonth(ymStr);
    });

    cardEl.appendChild(hdrEl);

    const wkEl = document.createElement('div');
    wkEl.className = 'mini-cal-weekdays';
    wkEl.innerHTML = '<span class="is-sun">日</span><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span class="is-sat">土</span>';
    cardEl.appendChild(wkEl);

    const mGrid = document.createElement('div');
    mGrid.className = 'mini-cal-grid';

    const firstDow = new Date(yearNum, m - 1, 1).getDay();
    const daysInM = new Date(yearNum, m, 0).getDate();

    for (let i = 0; i < firstDow; i++) {
      const emp = document.createElement('div');
      emp.className = 'mini-cal-cell is-empty';
      mGrid.appendChild(emp);
    }

    for (let d = 1; d <= daysInM; d++) {
      const dd = String(d).padStart(2, '0');
      const dStr = `${ymStr}-${dd}`;
      const dayInfo = state.calendarDaysMap ? state.calendarDaysMap.get(dStr) : null;
      const val = dayInfo ? (_calModalHeatMode === 'excellent' ? (dayInfo.excellent_count || 0) : (dayInfo.count || 0)) : 0;
      const totalCnt = dayInfo ? (dayInfo.count || 0) : 0;
      const isDateSel = state.selectedDates.has(dStr);

      const dBtn = document.createElement('button');
      dBtn.type = 'button';
      dBtn.className = 'mini-cal-cell';
      if (val > 0) {
        dBtn.classList.add('has-photos');
        const ratio = Math.min(1, Math.log10(val + 1) / Math.log10(Math.max(5, maxValInYear) + 1));
        const lv = ratio >= 0.78 ? 4 : ratio >= 0.52 ? 3 : ratio >= 0.28 ? 2 : 1;
        dBtn.classList.add(`cal-lv-${lv}`);
      }
      if (isDateSel) dBtn.classList.add('is-selected');
      else if (isMonthSelected && totalCnt > 0) dBtn.classList.add('is-in-selected-month');

      dBtn.textContent = String(d);
      dBtn.title = totalCnt > 0
        ? `${_calModalYear}年${m}月${d}日: ${totalCnt}枚 (優:${dayInfo.excellent_count || 0}枚)`
        : `${_calModalYear}年${m}月${d}日`;

      dBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTimelineDate(dStr, e.shiftKey);
      });
      mGrid.appendChild(dBtn);
    }

    cardEl.appendChild(mGrid);
    yearGrid.appendChild(cardEl);
  }
}

/**
 * カメラツリー操作ツールバー（再読み込み・全展開・全折りたたみ）のイベント登録
 */
function initCameraToolbarEvents() {
  const reloadBtn = document.getElementById('reloadCameraTreeBtn');
  if (reloadBtn && !reloadBtn.dataset.bound) {
    reloadBtn.dataset.bound = '1';
    reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fetchCameras();
    });
  }

  const sortBtn = document.getElementById('cameraSortByCountToggleBtn');
  if (sortBtn) {
    const isCount = Boolean(state.cameraSortByCount);
    sortBtn.classList.toggle('active', isCount);
    sortBtn.setAttribute('aria-pressed', isCount ? 'true' : 'false');
    sortBtn.textContent = isCount ? '枚数順' : '名前順';
    if (!sortBtn.dataset.bound) {
      sortBtn.dataset.bound = '1';
      sortBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.cameraSortByCount = !state.cameraSortByCount;
        localStorage.setItem('pm_camera_sort_by_count', state.cameraSortByCount ? 'true' : 'false');
        renderCameras(state.availableCameras);
        if (typeof showToast === 'function') {
          showToast(
            state.cameraSortByCount
              ? 'カメラ・レンズ一覧を「枚数順」に切り替えました'
              : 'カメラ・レンズ一覧を「名前順（自然順）」に切り替えました',
            'info',
            1800
          );
        }
      });
    }
  }

  const expandBtn = document.getElementById('expandAllCamerasBtn');
  if (expandBtn && !expandBtn.dataset.bound) {
    expandBtn.dataset.bound = '1';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.expandedCameras) state.expandedCameras = new Set();
      (state.availableCameras || []).forEach(item => {
        if (item.lenses && item.lenses.length > 0) {
          state.expandedCameras.add(item.camera_model);
        }
      });
      renderCameras(state.availableCameras);
    });
  }

  const collapseBtn = document.getElementById('collapseAllCamerasBtn');
  if (collapseBtn && !collapseBtn.dataset.bound) {
    collapseBtn.dataset.bound = '1';
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.expandedCameras) state.expandedCameras.clear();
      renderCameras(state.availableCameras);
    });
  }
}

/**
 * カメラ機種・レンズ階層情報の取得と描画
 */
async function fetchCameras() {
  initCameraToolbarEvents();
  try {
    const response = await fetch('/api/cameras');
    if (!response.ok) throw new Error('カメラ一覧取得失敗');
    const data = await response.json();
    state.availableCameras = data.cameras || [];
    renderCameras(state.availableCameras);
  } catch (error) {
    console.error('カメラ一覧読み込みエラー:', error);
  }
}

/**
 * カメラ機種＆レンズ2階層ツリーの描画 (3ステート排他選択対応)
 */
function renderCameras(cameraItems) {
  initCameraToolbarEvents();
  if (!elements.cameraList) return;

  if (!cameraItems || cameraItems.length === 0) {
    elements.cameraList.innerHTML = '<li class="empty-hint">カメラ情報なし</li>';
    return;
  }

  if (!state.expandedCameras) state.expandedCameras = new Set();
  if (!state.cameraFilters) state.cameraFilters = new Map();
  if (!state.lensFilters) state.lensFilters = new Map();

  elements.cameraList.innerHTML = '';
  const sortByCount = Boolean(state.cameraSortByCount);
  const sortedCameraItems = [...cameraItems].sort((a, b) => {
    const ca = String(a.camera_model || '');
    const cb = String(b.camera_model || '');
    const aLast = (ca === '不明' || ca === 'Unknown' || ca === '__NONE__') ? 1 : 0;
    const bLast = (cb === '不明' || cb === 'Unknown' || cb === '__NONE__') ? 1 : 0;
    if (aLast !== bLast) return aLast - bLast;
    if (sortByCount) {
      const diff = (b.count || 0) - (a.count || 0);
      if (diff !== 0) return diff;
    }
    return ca.localeCompare(cb, undefined, { numeric: true, sensitivity: 'base' });
  });
  sortedCameraItems.forEach(item => {
    const camModel = item.camera_model;
    const lenses = Array.isArray(item.lenses) ? [...item.lenses].sort((a, b) => {
      const la = String(a.label || a.lens_model || '');
      const lb = String(b.label || b.lens_model || '');
      const aLast = (a.lens_model === '__NONE__' || la === 'レンズ情報なし' || la === '----') ? 1 : 0;
      const bLast = (b.lens_model === '__NONE__' || lb === 'レンズ情報なし' || lb === '----') ? 1 : 0;
      if (aLast !== bLast) return aLast - bLast;
      if (sortByCount) {
        const diff = (b.count || 0) - (a.count || 0);
        if (diff !== 0) return diff;
      }
      return la.localeCompare(lb, undefined, { numeric: true, sensitivity: 'base' });
    }) : [];
    const hasLenses = lenses.length > 0;

    // 子レンズにフィルタが適用されているかチェック
    const hasActiveChildLens = lenses.some(l => state.lensFilters.has(`${camModel}::${l.lens_model}`));
    const isExpanded = state.expandedCameras.has(camModel) || hasActiveChildLens;

    const groupLi = document.createElement('li');
    groupLi.className = 'camera-tree-group';
    groupLi.dataset.cameraGroup = camModel;

    const camMode = state.cameraFilters.get(camModel) || (state.selectedCameras.has(camModel) ? 'include' : null);
    const rowDiv = document.createElement('div');
    rowDiv.className = 'nav-item camera-tree-item';
    if (camMode === 'include') rowDiv.classList.add('active', 'include');
    else if (camMode === 'exclude') rowDiv.classList.add('exclude');
    rowDiv.dataset.filterType = 'camera';
    rowDiv.dataset.filterValue = camModel;
    rowDiv.dataset.camera = camModel;

    const badgeText = camMode === 'include' ? '[+]' : (camMode === 'exclude' ? '[-]' : '');
    const expanderChar = hasLenses ? (isExpanded ? '▼' : '▶') : '•';

    rowDiv.innerHTML = `
      <span class="camera-tree-expander ${hasLenses ? '' : 'empty'}" data-camera="${escapeHtml(camModel)}" title="${hasLenses ? 'レンズ一覧を展開/折りたたみ' : ''}">${expanderChar}</span>
      <span class="nav-text" title="${escapeHtml(camModel)}">${escapeHtml(camModel)}</span>
      <span class="camera-state-badge">${badgeText}</span>
      <span class="nav-count">${item.count}</span>
    `;

    // エキスパンダ矢印のクリック（フィルタを発火させずに子レンズ一覧を開閉）
    const expanderEl = rowDiv.querySelector('.camera-tree-expander');
    if (expanderEl && hasLenses) {
      expanderEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const subList = groupLi.querySelector('.camera-lens-sublist');
        const currentlyExpanded = state.expandedCameras.has(camModel) || (subList && subList.style.display !== 'none');
        if (currentlyExpanded) {
          state.expandedCameras.delete(camModel);
          if (subList) subList.style.display = 'none';
          expanderEl.textContent = '▶';
        } else {
          state.expandedCameras.add(camModel);
          if (subList) subList.style.display = 'block';
          expanderEl.textContent = '▼';
        }
      });
    }

    // カメラ親行クリックで3ステート遷移 (解除 -> [+]含む -> [-]除外 -> 解除)
    rowDiv.addEventListener('click', (e) => {
      if (e.target.closest('.camera-tree-expander') && hasLenses) return;
      toggleCameraFilter(camModel);
    });

    groupLi.appendChild(rowDiv);

    // 子レンズ一覧の構築
    if (hasLenses) {
      const subUl = document.createElement('ul');
      subUl.className = 'camera-lens-sublist';
      subUl.style.display = isExpanded ? 'block' : 'none';

      lenses.forEach(lens => {
        const lensModel = lens.lens_model;
        const lensLabel = lens.label || lensModel;
        const lensKey = `${camModel}::${lensModel}`;
        const lensMode = state.lensFilters.get(lensKey) || state.lensFilters.get(lensModel) || null;
        const lensBadge = lensMode === 'include' ? '[+]' : (lensMode === 'exclude' ? '[-]' : '');

        const lensLi = document.createElement('li');
        lensLi.className = 'nav-item camera-lens-item';
        if (lensMode === 'include') lensLi.classList.add('active', 'include');
        else if (lensMode === 'exclude') lensLi.classList.add('exclude');
        lensLi.dataset.lensKey = lensKey;
        lensLi.dataset.camera = camModel;
        lensLi.dataset.lens = lensModel;
        lensLi.dataset.lensLabel = lensLabel;

        lensLi.innerHTML = `
          <span class="nav-text lens-nav-text" title="${escapeHtml(camModel)} / ${escapeHtml(lensModel)}">${escapeHtml(lensLabel)}</span>
          <span class="camera-state-badge">${lensBadge}</span>
          <span class="nav-count">${lens.count}</span>
        `;

        lensLi.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleLensFilter(lensKey, lensLabel);
        });

        subUl.appendChild(lensLi);
      });

      groupLi.appendChild(subUl);
    }

    elements.cameraList.appendChild(groupLi);
  });

  updateCameraActiveClasses();
}

/**
 * カメラ・レンズフィルタ状態から selectedCameras / selectedLenses およびビュータイトルを同期する内部ヘルパー
 */
function syncCameraAndLensFilterTitle() {
  state.selectedCameras.clear();
  if (state.cameraFilters) {
    state.cameraFilters.forEach((mode, cam) => {
      if (mode === 'include') state.selectedCameras.add(cam);
    });
  }

  state.selectedLenses.clear();
  if (state.lensFilters) {
    state.lensFilters.forEach((mode, key) => {
      if (mode === 'include') state.selectedLenses.add(key);
    });
  }

  state.untaggedOnly = false;
  if (elements.untaggedNavItem) elements.untaggedNavItem.classList.remove('active');

  const isFolderActive = state.currentFilter && (state.currentFilter.type === 'folder' || state.currentFilter.type === 'folder_exclude');
  const camCount = state.cameraFilters ? state.cameraFilters.size : 0;
  const lensCount = state.lensFilters ? state.lensFilters.size : 0;

  if (!isFolderActive) {
    if (camCount === 0 && lensCount === 0) {
      if (state.currentFilter.type === 'cameras' || state.currentFilter.type === 'camera') {
        state.currentFilter = { type: 'all', value: null };
        elements.viewTitle.textContent = 'すべての写真';
      }
    } else if (lensCount === 1 && camCount === 0) {
      const [lensKey, mode] = Array.from(state.lensFilters.entries())[0];
      const displayName = lensKey.includes('::') ? lensKey.split('::')[1] : lensKey;
      state.currentFilter = { type: 'cameras', value: [lensKey] };
      elements.viewTitle.textContent = mode === 'exclude' ? `除外: ${displayName}` : `${displayName}`;
    } else if (camCount === 1 && lensCount === 0) {
      const [singleCam, mode] = Array.from(state.cameraFilters.entries())[0];
      state.currentFilter = { type: 'camera', value: mode === 'include' ? singleCam : null };
      elements.viewTitle.textContent = mode === 'exclude' ? `除外: ${singleCam}` : `${singleCam}`;
    } else {
      state.currentFilter = { type: 'cameras', value: Array.from(state.selectedCameras) };
      elements.viewTitle.textContent = `カメラ・レンズ絞り込み (${camCount + lensCount}件)`;
    }
  }

  updateCameraActiveClasses();
  fetchPhotos();
}

/**
 * カメラ機種の3ステートトグル選択処理 (解除 -> [+]含む -> [-]除外 -> 解除)
 */
function toggleCameraFilter(cameraModel, forceRemove = false) {
  if (!state.cameraFilters) state.cameraFilters = new Map();
  const current = state.cameraFilters.get(cameraModel) || (state.selectedCameras.has(cameraModel) ? 'include' : null);

  if (forceRemove) {
    state.cameraFilters.delete(cameraModel);
  } else if (!current) {
    state.cameraFilters.set(cameraModel, 'include');
  } else if (current === 'include') {
    state.cameraFilters.set(cameraModel, 'exclude');
  } else {
    state.cameraFilters.delete(cameraModel);
  }

  syncCameraAndLensFilterTitle();
}

/**
 * レンズの3ステートトグル選択処理 (解除 -> [+]含む -> [-]除外 -> 解除)
 */
function toggleLensFilter(lensKey, label, forceRemove = false) {
  if (!state.lensFilters) state.lensFilters = new Map();
  const current = state.lensFilters.get(lensKey) || null;

  if (forceRemove) {
    state.lensFilters.delete(lensKey);
  } else if (!current) {
    state.lensFilters.set(lensKey, 'include');
  } else if (current === 'include') {
    state.lensFilters.set(lensKey, 'exclude');
  } else {
    state.lensFilters.delete(lensKey);
  }

  syncCameraAndLensFilterTitle();
}

/**
 * 外部モジュール（ラボの勝ちレンズカルテ等）から特定レンズで一発抽出するグローバル関数
 */
function selectLensFilter(filterKey, label) {
  if (!filterKey) return;
  if (!state.cameraFilters) state.cameraFilters = new Map();
  if (!state.lensFilters) state.lensFilters = new Map();
  if (!state.expandedCameras) state.expandedCameras = new Set();

  state.cameraFilters.clear();
  state.selectedCameras.clear();
  state.lensFilters.clear();
  state.selectedLenses.clear();

  state.lensFilters.set(filterKey, 'include');
  state.selectedLenses.add(filterKey);

  if (filterKey.includes('::')) {
    const camModel = filterKey.split('::')[0];
    if (camModel) state.expandedCameras.add(camModel);
  }

  renderCameras(state.availableCameras);
  syncCameraAndLensFilterTitle();
  if (label && elements.viewTitle) {
    elements.viewTitle.textContent = `${label}`;
  }
}
window.selectLensFilter = selectLensFilter;
window.renderCameras = renderCameras;

/**
 * カメラ・レンズツリーのアクティブ表示（include / exclude クラスとバッジ）およびアコーディオン状態更新
 */
function updateCameraActiveClasses() {
  const camAccordion = document.getElementById('accordionItem-camera');
  const hasCamFilter = Boolean(
    (state.cameraFilters && state.cameraFilters.size > 0) ||
    (state.lensFilters && state.lensFilters.size > 0) ||
    (state.selectedCameras && state.selectedCameras.size > 0)
  );
  if (camAccordion) {
    camAccordion.classList.toggle('has-filter', hasCamFilter);
  }

  if (!elements.cameraList) return;

  // カメラ親行の更新（配下レンズのフィルタ状態も集計して道しるべ表示）
  elements.cameraList.querySelectorAll('.camera-tree-item').forEach(el => {
    const cam = el.dataset.camera || el.dataset.filterValue;
    const mode = (state.cameraFilters && state.cameraFilters.get(cam)) ||
      (state.selectedCameras && state.selectedCameras.has(cam) ? 'include' : null);
    el.classList.toggle('active', mode === 'include');
    el.classList.toggle('include', mode === 'include');
    el.classList.toggle('exclude', mode === 'exclude');
    const badge = el.querySelector('.camera-state-badge');
    if (badge) {
      badge.textContent = mode === 'include' ? '[+]' : (mode === 'exclude' ? '[-]' : '');
    }

    let childInc = 0;
    let childExc = 0;
    if (state.lensFilters && state.lensFilters.size > 0 && cam) {
      state.lensFilters.forEach((lMode, lKey) => {
        if (lKey.startsWith(`${cam}::`)) {
          if (lMode === 'include') childInc++;
          else if (lMode === 'exclude') childExc++;
        }
      });
    }
    el.classList.toggle('has-active-child-include', !mode && childInc > 0);
    el.classList.toggle('has-active-child-exclude', !mode && childInc === 0 && childExc > 0);

    el.querySelectorAll('.child-filter-badge').forEach(b => b.remove());
    const countEl = el.querySelector('.nav-count');
    if (childExc > 0) {
      const b = document.createElement('span');
      b.className = 'child-filter-badge is-exclude';
      b.textContent = `−${childExc}`;
      b.title = `このカメラ配下のレンズに −${childExc} 件の除外フィルタあり`;
      if (countEl) el.insertBefore(b, countEl);
      else el.appendChild(b);
    }
    if (childInc > 0) {
      const b = document.createElement('span');
      b.className = 'child-filter-badge is-include';
      b.textContent = `+${childInc}`;
      b.title = `このカメラ配下のレンズに +${childInc} 件のフィルタあり`;
      if (countEl) el.insertBefore(b, countEl);
      else el.appendChild(b);
    }
  });

  // 子レンズ行の更新
  elements.cameraList.querySelectorAll('.camera-lens-item').forEach(el => {
    const lensKey = el.dataset.lensKey;
    const lensModel = el.dataset.lens;
    const mode = (state.lensFilters && (state.lensFilters.get(lensKey) || state.lensFilters.get(lensModel))) || null;
    el.classList.toggle('active', mode === 'include');
    el.classList.toggle('include', mode === 'include');
    el.classList.toggle('exclude', mode === 'exclude');
    const badge = el.querySelector('.camera-state-badge');
    if (badge) {
      badge.textContent = mode === 'include' ? '[+]' : (mode === 'exclude' ? '[-]' : '');
    }
  });
}
window.updateCameraActiveClasses = updateCameraActiveClasses;

/**
 * ディレクトリパス一覧から階層ツリー構造を構築する
 * （Windowsのドライブ文字やフォルダー名の大文字小文字の揺れを同一フォルダとして統合）
 */
function buildFolderTree(folderItems) {
  const root = { children: new Map(), count: 0, fullPath: '' };

  folderItems.forEach(item => {
    let rawPath = (item.directory_path || '').trim();
    if (!rawPath) return;

    // Windowsドライブレター (例: "g:" や "g:\...") を大文字 "G:" に正規化
    if (/^[a-z]:/i.test(rawPath)) {
      rawPath = rawPath[0].toUpperCase() + rawPath.slice(1);
    }

    // パス区切りを / で統一してセグメント分解
    const isUnc = rawPath.startsWith('\\\\') || rawPath.startsWith('//');
    let normalized = rawPath.replace(/\\/g, '/');
    let prefix = '';
    if (isUnc) {
      normalized = normalized.replace(/^\/+/, '');
      prefix = '\\\\';
    }

    const segments = normalized.split('/').filter(Boolean);
    let current = root;
    let accumulatedPath = prefix;

    segments.forEach((seg, idx) => {
      // ドライブレターセグメント（例: "g:"）を大文字化
      let displaySeg = seg;
      if (idx === 0 && /^[a-z]:$/i.test(seg)) {
        displaySeg = seg.toUpperCase();
      }

      if (idx === 0) {
        accumulatedPath += displaySeg;
      } else {
        const sep = (accumulatedPath.endsWith('\\') || accumulatedPath.endsWith('/')) ? '' : '\\';
        accumulatedPath += sep + displaySeg;
      }

      // 大文字小文字を区別せず同一フォルダとして束ねるため、キーは小文字を使用
      const lookupKey = displaySeg.toLowerCase();

      if (!current.children.has(lookupKey)) {
        current.children.set(lookupKey, {
          name: displaySeg,
          fullPath: accumulatedPath,
          rawPath: rawPath,
          count: 0,
          totalCount: 0,
          status: 'unmanaged',
          isMissing: false,
          children: new Map(),
        });
      }

      const childNode = current.children.get(lookupKey);

      // 管理中（写真が存在する）またはより具体的な大文字表記があれば表示名をアップデート
      if (item.status === 'managed' || (item.count && item.count > 0)) {
        childNode.name = displaySeg;
        childNode.fullPath = accumulatedPath;
      }

      if (idx === segments.length - 1) {
        // 葉ノード（末端）の場合
        if (item.status === 'managed' || (item.count && item.count > 0)) {
          childNode.status = 'managed';
          childNode.count = item.count || 0;
          childNode.isMissing = !!item.is_missing;
        } else if (childNode.status !== 'managed') {
          childNode.count = item.count || 0;
          childNode.status = item.status || 'unmanaged';
          childNode.isMissing = !!item.is_missing;
        }
      }
      current = childNode;
    });
  });

  // 各ノードの配下写真総数（自身＋子孫）およびステータスを再帰計算
  function calculateTotals(node) {
    let sum = node.count;
    let hasManagedChild = false;
    let hasUnmanagedChild = false;
    let allIgnored = (node.children.size > 0);

    node.children.forEach(child => {
      sum += calculateTotals(child);
      if (child.status === 'managed' || child.totalCount > 0) hasManagedChild = true;
      if (child.status === 'unmanaged') hasUnmanagedChild = true;
      if (child.status !== 'ignored') allIgnored = false;
    });

    node.totalCount = sum;

    // ノード自身のstatusが明示されていない親ノードの状態推論
    if (!node.status || node.status === 'unmanaged') {
      if (sum > 0 || hasManagedChild) {
        node.status = 'managed';
      } else if (allIgnored && node.children.size > 0) {
        node.status = 'ignored';
      } else if (hasUnmanagedChild) {
        node.status = 'unmanaged';
      }
    }

    // 子孫がすべて未接続なら親も未接続扱い
    if (node.children.size > 0 && Array.from(node.children.values()).every(c => c.isMissing)) {
      node.isMissing = true;
    }

    return sum;
  }
  root.children.forEach(child => calculateTotals(child));

  function sortFolderNodes(node) {
    if (!node.children || node.children.size === 0) return;
    const sorted = Array.from(node.children.entries()).sort((a, b) =>
      String(a[1].name || '').localeCompare(String(b[1].name || ''), undefined, { numeric: true, sensitivity: 'base' })
    );
    node.children = new Map(sorted);
    node.children.forEach(child => sortFolderNodes(child));
  }
  sortFolderNodes(root);

  return root;
}

/**
 * スラッシュ区切りのタグ一覧から階層ツリー構造を構築する
 * 各階層の子ノードは自然順（数字なら小さい方が上・昇順）にソートされる (v2.11)
 */
function buildTagTree(tagItems, options = {}) {
  const root = { children: new Map(), count: 0 };

  tagItems.forEach(item => {
    const parts = item.tag.split('/').map(p => p.trim()).filter(Boolean);
    let current = root;
    let currentPath = '';

    parts.forEach((part, idx) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath: currentPath,
          count: 0,
          children: new Map(),
        });
      }
      const childNode = current.children.get(part);
      // 祖先ノード独立保存: 各ノードはDB上の自身の件数・メタデータのみを表示（累計しない）
      if (idx === parts.length - 1) {
        childNode.count = item.count;
        childNode.source = item.source || 'manual';
        childNode.tag_key = item.tag_key || '';
        childNode.short_name = item.short_name || '';
        childNode.is_pinned = Boolean(item.is_pinned);
      }
      current = childNode;
    });
  });

  // 各階層の子ノードを設定されたソート順（枚数順トグルON時は枚数順優先、OFF時は設定画面の名前順ルール）で再帰的に整列
  const sortMode = (typeof state !== 'undefined' && state.tagSortMode && state.tagSortMode !== 'count_desc')
    ? state.tagSortMode
    : (localStorage.getItem('pm_tag_sort_mode_v2') && localStorage.getItem('pm_tag_sort_mode_v2') !== 'count_desc'
      ? localStorage.getItem('pm_tag_sort_mode_v2')
      : 'natural');
  const sortByCount = (options && typeof options.sortByCount === 'boolean')
    ? options.sortByCount
    : ((typeof state !== 'undefined' && state.tagSortByCount !== undefined)
      ? Boolean(state.tagSortByCount)
      : (localStorage.getItem('pm_tag_sort_by_count_v2') === 'true'));

  function compareTagNames(nameA, nameB) {
    if (sortMode === 'lexical_desc') {
      return nameB.localeCompare(nameA, undefined, { numeric: false, sensitivity: 'base' });
    }
    if (sortMode === 'natural') {
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    }
    if (sortMode === 'natural_desc') {
      return nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
    }
    // デフォルト ('lexical'): 文字コード・辞書順（24-xxx → 2410-xxx → 25-xxx）
    return nameA.localeCompare(nameB, undefined, { numeric: false, sensitivity: 'base' });
  }

  function sortTreeNodes(node) {
    if (!node.children || node.children.size === 0) return;
    const sortedEntries = Array.from(node.children.entries()).sort((a, b) => {
      if (sortByCount) {
        const diff = (b[1].count || 0) - (a[1].count || 0);
        if (diff !== 0) return diff;
      }
      return compareTagNames(a[0], b[0]);
    });
    node.children = new Map(sortedEntries);
    node.children.forEach(child => sortTreeNodes(child));
  }
  sortTreeNodes(root);

  return root;
}

/**
 * 写真に付いているタグ一覧から、リーフタグ（子孫タグを持たない最深のタグ）のみを抽出する。
 * 祖先ノード独立保存方式のため、表示時は末端のタグだけをチップ表示し、
 * 中間ノードは省略する（削除操作で親ノードが自然に現れる）。
 */
function getLeafTags(tags) {
  if (!tags || tags.length === 0) return [];
  return tags.filter(tag =>
    !tags.some(other => other !== tag && other.startsWith(tag + '/'))
  );
}

/**
 * 指定したタグパスのすべての祖先階層を展開状態（expandedTagPaths）にする
 * 例: "車/mazda/CX-5" ➜ "車", "車/mazda" を expandedTagPaths に追加
 */
function expandTagAncestors(fullPath) {
  if (!fullPath) return;
  const parts = fullPath.split('/').map(p => p.trim()).filter(Boolean);
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    state.expandedTagPaths.add(acc);
  }
}

/**
 * カラーパレット専用 左クリック操作 (単一選択制御)
 * - 既にその色が 'include' ➜ 解除 (OFF)
 * - 別の色または未選択 ➜ 他のカラータグを解除した上で、この色を 'include' にセット
 * ※ 被写体タグ等の通常タグフィルタは維持されます
 */
function handleColorFilterLeftClick(colorName) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(colorName);
  
  // 他のカラータグのフィルタをすべて解除（単一選択）
  Object.keys(COLOR_TAG_MAP).forEach(cName => {
    state.tagFilters.delete(cName);
  });

  if (current !== 'include') {
    state.tagFilters.set(colorName, 'include');
  }

  renderTagList();
  fetchPhotos();
}

/**
 * カラーパレット専用 右クリック操作 (単一選択制御)
 * - 既にその色が 'exclude' ➜ 解除 (OFF)
 * - 別の色または未選択 ➜ 他のカラータグを解除した上で、この色を 'exclude' にセット
 */
function handleColorFilterRightClick(colorName) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(colorName);
  
  // 他のカラータグのフィルタをすべて解除（単一選択）
  Object.keys(COLOR_TAG_MAP).forEach(cName => {
    state.tagFilters.delete(cName);
  });

  if (current !== 'exclude') {
    state.tagFilters.set(colorName, 'exclude');
  }

  renderTagList();
  fetchPhotos();
}

/**
 * カラータグ・パレットの開閉トグル (エキスパンダ)
 */
function toggleColorPaletteExpander(isOpen) {
  const section = elements.colorPaletteSection || document.getElementById('colorPaletteSection');
  const body = elements.colorPaletteBody || document.getElementById('colorPaletteBody');
  if (!section) return;

  if (isOpen === undefined) {
    isOpen = !section.classList.contains('is-open');
  }

  section.classList.toggle('is-open', isOpen);
  if (body) {
    body.style.display = isOpen ? 'block' : 'none';
  }
  localStorage.setItem('pm_color_filter_expanded', isOpen ? 'true' : 'false');
}

/**
 * カラータグ・パレットの描画 (上部集約 ＆ 3ステート連動)
 */
function renderColorPalette() {
  if (!elements.colorPaletteSection || !elements.colorSwatchGrid) return;

  const colorTagNames = Object.keys(COLOR_TAG_MAP);

  // 現在のタグソースフィルタに応じたカウント集計
  let available = state.availableTags || [];
  if (state.tagSourceFilter === 'manual') {
    available = available.filter(t => t.source === 'manual' || t.source === 'both');
  } else if (state.tagSourceFilter === 'ai') {
    available = available.filter(t => t.source === 'ai' || t.source === 'both');
  }

  const tagCountMap = new Map();
  available.forEach(t => {
    const tagName = t.tag || t.name;
    tagCountMap.set(tagName, t.count || 0);
  });

  const activeColorFilters = colorTagNames.filter(name => state.tagFilters.has(name));

  // 常時表示してカラーによる絞り込みを直感的に提供
  elements.colorPaletteSection.style.display = 'block';

  const colorHeaderEl = elements.colorPaletteHeader || document.getElementById('colorPaletteHeader');
  if (colorHeaderEl) {
    const hasColorInc = activeColorFilters.some(c => state.tagFilters.get(c) === 'include');
    const hasColorExc = activeColorFilters.some(c => state.tagFilters.get(c) === 'exclude');
    colorHeaderEl.classList.toggle('has-active-child-include', hasColorInc);
    colorHeaderEl.classList.toggle('has-active-child-exclude', !hasColorInc && hasColorExc);
  }
  if (elements.colorPaletteActiveCount) {
    if (activeColorFilters.length > 0) {
      const activeColor = activeColorFilters[0];
      const mode = state.tagFilters.get(activeColor);
      const isExc = mode === 'exclude';
      const badgeCls = isExc ? 'is-exclude' : 'is-include';
      const sign = isExc ? '−' : '+';
      elements.colorPaletteActiveCount.innerHTML = `<span class="child-filter-badge ${badgeCls}">${sign}${escapeHtml(activeColor)}</span>`;
    } else {
      elements.colorPaletteActiveCount.textContent = '';
    }
  }

  elements.colorSwatchGrid.innerHTML = '';

  colorTagNames.forEach(colorName => {
    const conf = COLOR_TAG_MAP[colorName];
    const count = tagCountMap.get(colorName) || 0;
    const currentMode = state.tagFilters.get(colorName); // 'include' | 'exclude' | undefined

    const chip = document.createElement('div');
    chip.className = 'color-swatch-chip';
    if (currentMode === 'include') {
      chip.classList.add('state-include');
    } else if (currentMode === 'exclude') {
      chip.classList.add('state-exclude');
    }

    // ボタンフェイスそのものをその色（カラータイル）として鮮明に表示
    chip.style.background = conf.bg;
    chip.style.borderColor = conf.border;
    chip.style.color = conf.text;
    if (conf.shadow) {
      chip.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.6)';
    } else {
      chip.style.textShadow = 'none';
    }

    let badgeIcon = '';
    if (currentMode === 'include') badgeIcon = '<span class="color-swatch-badge badge-include">+</span>';
    else if (currentMode === 'exclude') badgeIcon = '<span class="color-swatch-badge badge-exclude">−</span>';

    chip.innerHTML = `
      ${badgeIcon}
      <span class="color-swatch-label" title="${escapeHtml(colorName)}">${escapeHtml(conf.label || colorName)}</span>
      <span class="color-swatch-count">${count}</span>
    `;

    chip.setAttribute('title', `${colorName} (${count}枚)\nクリック: この色で絞り込み ｜ 右クリック: 除外`);

    // 左クリック: 単一選択で含む/解除
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      handleColorFilterLeftClick(colorName);
    });

    // 右クリック: 単一選択で除外/解除
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleColorFilterRightClick(colorName);
    });

    elements.colorSwatchGrid.appendChild(chip);
  });
}

/**
 * 3ステート階層タグツリーの描画 (親タグ包括 ＆ 子タグ排他対応 ＆ AI/手動フィルタ)
 */
function renderTagList() {
  const hasActiveFilters = state.tagFilters.size > 0;
  elements.clearTagFiltersBtn.style.display = hasActiveFilters ? 'inline' : 'none';

  // 左ペイン専用「名前順 ⇄ 枚数順」トグルボタンの状態同期＆イベントバインド
  const countToggleBtn = elements.tagSortByCountToggleBtn || document.getElementById('tagSortByCountToggleBtn');
  if (countToggleBtn) {
    const isCount = Boolean(state.tagSortByCount);
    countToggleBtn.classList.toggle('active', isCount);
    countToggleBtn.setAttribute('aria-pressed', isCount ? 'true' : 'false');
    countToggleBtn.textContent = isCount ? '枚数順' : '名前順';
    if (!countToggleBtn.dataset.bound) {
      countToggleBtn.dataset.bound = 'true';
      countToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.tagSortByCount = !state.tagSortByCount;
        localStorage.setItem('pm_tag_sort_by_count_v2', state.tagSortByCount ? 'true' : 'false');
        renderTagList();
        if (typeof showToast === 'function') {
          showToast(
            state.tagSortByCount
              ? '左ペインのタグを「枚数順」に切り替えました'
              : '左ペインのタグを「名前順（自然順）」に切り替えました',
            'info',
            1800
          );
        }
      });
    }
  }

  // カラータグパレットの描画（上部に集約）
  renderColorPalette();

  // セグメントボタンのアクティブ同期 ＆ 種別ごとのフィルタ適用中ドット表示
  if (elements.tagTypeSegmentedControl) {
    let hasManualActive = false;
    let hasAiActive = false;
    if (state.tagFilters && state.tagFilters.size > 0) {
      const tagSourceMap = new Map();
      (state.availableTags || []).forEach(t => {
        const tName = t.tag || t.name;
        if (tName && !(tName in COLOR_TAG_MAP)) {
          tagSourceMap.set(tName, t.source || 'manual');
        }
      });
      state.tagFilters.forEach((_mode, tPath) => {
        if (tPath in COLOR_TAG_MAP) return;
        const src = tagSourceMap.get(tPath) || 'manual';
        if (src === 'manual' || src === 'both') hasManualActive = true;
        if (src === 'ai' || src === 'both') hasAiActive = true;
      });
    }
    elements.tagTypeSegmentedControl.querySelectorAll('.tag-segment-btn').forEach(b => {
      const sf = b.dataset.sourceFilter || 'manual';
      b.classList.toggle('active', sf === state.tagSourceFilter);
      if (sf === 'manual') b.classList.toggle('has-filter', hasManualActive);
      else if (sf === 'ai') b.classList.toggle('has-filter', hasAiActive);
      else b.classList.toggle('has-filter', hasManualActive || hasAiActive);
    });
  }

  // セグメントボタンのイベントバインド（未バインド時のみ）
  if (elements.tagTypeSegmentedControl && !elements.tagTypeSegmentedControl.dataset.bound) {
    elements.tagTypeSegmentedControl.dataset.bound = 'true';
    elements.tagTypeSegmentedControl.querySelectorAll('.tag-segment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        elements.tagTypeSegmentedControl.querySelectorAll('.tag-segment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.tagSourceFilter = btn.dataset.sourceFilter || 'manual';
        localStorage.setItem('pm_tag_source_filter', state.tagSourceFilter);
        renderTagList();
      });
    });
  }

  let tagsToDisplay = state.availableTags || [];
  if (state.tagSourceFilter === 'manual') {
    tagsToDisplay = tagsToDisplay.filter(t => t.source === 'manual' || t.source === 'both');
  } else if (state.tagSourceFilter === 'ai') {
    tagsToDisplay = tagsToDisplay.filter(t => t.source === 'ai' || t.source === 'both');
  }

  // カラータグは上部パレットに集約されているため、下部の通常ツリー一覧からは除外
  tagsToDisplay = tagsToDisplay.filter(t => !((t.tag || t.name) in COLOR_TAG_MAP));

  // テキスト絞り込み (Enter確定クエリによる部分一致フィルタ)
  if (state.tagSearchQuery && state.tagSearchQuery.trim()) {
    const q = state.tagSearchQuery.trim().toLowerCase();
    tagsToDisplay = tagsToDisplay.filter(t => {
      const name = (t.tag || t.name || '').toLowerCase();
      return name.includes(q);
    });
  }

  if (tagsToDisplay.length === 0) {
    let emptyMsg = '';
    if (state.tagSearchQuery && state.tagSearchQuery.trim()) {
      emptyMsg = `「${escapeHtml(state.tagSearchQuery.trim())}」に一致するタグはありません`;
    } else {
      emptyMsg = state.tagSourceFilter === 'ai' 
        ? 'その他のAIタグはありません' 
        : 'その他のタグなし (右インスペクタで作成)';
    }
    elements.tagList.innerHTML = `<li class="empty-hint">${emptyMsg}</li>`;
    return;
  }

  elements.tagList.innerHTML = '';
  const treeRoot = buildTagTree(tagsToDisplay, { sortByCount: Boolean(state.tagSortByCount) });

  // 選択中フィルタがある場合、そのタグの祖先を展開
  if (state.tagFilters && state.tagFilters.size > 0) {
    state.tagFilters.forEach((mode, tagPath) => {
      expandTagAncestors(tagPath);
    });
  }

  // テキスト絞り込みがある場合、ヒットしたタグの祖先を展開
  if (state.tagSearchQuery && state.tagSearchQuery.trim()) {
    tagsToDisplay.forEach(t => {
      expandTagAncestors(t.tag || t.name);
    });
  }

  // 子孫ノードに適用中のフィルタ件数（include / exclude）を再帰集計するヘルパー
  function countDescendantTagFilters(node) {
    let inc = 0;
    let exc = 0;
    node.children.forEach(child => {
      const m = state.tagFilters.get(child.fullPath);
      if (m === 'include') inc++;
      else if (m === 'exclude') exc++;
      const sub = countDescendantTagFilters(child);
      inc += sub.inc;
      exc += sub.exc;
    });
    return { inc, exc };
  }

  // ツリーノードを再帰的にDOM構築
  function appendTreeNodes(parentNode, container) {
    parentNode.children.forEach(node => {
      const nodeEl = document.createElement('li');
      nodeEl.className = 'tag-tree-node';

      const hasChildren = node.children.size > 0;
      const currentMode = state.tagFilters.get(node.fullPath);
      const descCounts = hasChildren ? countDescendantTagFilters(node) : { inc: 0, exc: 0 };

      // ピル行
      const pillItem = document.createElement('div');
      pillItem.className = 'tag-pill-item';
      pillItem.dataset.tagPath = node.fullPath;
      if (node.source === 'ai') {
        pillItem.classList.add('is-ai-tag');
      }

      let stateIcon = '';
      if (currentMode === 'include') {
        pillItem.classList.add('state-include');
        stateIcon = '+';
      } else if (currentMode === 'exclude') {
        pillItem.classList.add('state-exclude');
        stateIcon = '−';
      } else if (descCounts.inc > 0) {
        pillItem.classList.add('has-active-child-include');
      } else if (descCounts.exc > 0) {
        pillItem.classList.add('has-active-child-exclude');
      }

      const isExpanded = state.expandedTagPaths.has(node.fullPath);

      // ツリー展開矢印またはスペーサー (デフォルトは閉: collapsed)
      let arrowHtml = '<span class="tree-toggle-spacer"></span>';
      if (hasChildren) {
        arrowHtml = `<span class="tree-toggle-btn ${isExpanded ? '' : 'collapsed'}">▼</span>`;
      }

      // AIバッジ
      let aiIconHtml = '';
      if (node.source === 'ai') {
        aiIconHtml = '<span class="ai-tag-pill-badge" style="margin-right: 3px;">AI</span>';
      }

      // 配下の子孫フィルタ通知バッジ（折りたたんでいても中にON/除外があることを明示）
      let childBadgeHtml = '';
      if (descCounts.inc > 0) {
        childBadgeHtml += `<span class="child-filter-badge is-include" title="このタグの配下に +${descCounts.inc} 件の含むフィルタがあります">+${descCounts.inc}</span>`;
      }
      if (descCounts.exc > 0) {
        childBadgeHtml += `<span class="child-filter-badge is-exclude" title="このタグの配下に −${descCounts.exc} 件の除外フィルタがあります">−${descCounts.exc}</span>`;
      }

      pillItem.innerHTML = `
        <div class="tag-pill-main">
          ${arrowHtml}
          <span class="tag-state-icon">${stateIcon}</span>
          ${aiIconHtml}
          <span class="tag-name-text" title="${escapeHtml(node.fullPath)}">${escapeHtml(node.name)}</span>
        </div>
        <div class="tag-pill-right">
          ${childBadgeHtml}
          <span class="tag-pill-count">${node.count}</span>
        </div>
      `;

      // 展開・折りたたみイベント (1段ずつ展開・折りたたみ)
      if (hasChildren) {
        const toggleBtn = pillItem.querySelector('.tree-toggle-btn');
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const childrenContainer = nodeEl.querySelector('.tag-tree-children');
          const isNowCollapsed = toggleBtn.classList.toggle('collapsed');
          if (isNowCollapsed) {
            state.expandedTagPaths.delete(node.fullPath);
          } else {
            state.expandedTagPaths.add(node.fullPath);
          }
          if (childrenContainer) {
            childrenContainer.classList.toggle('hidden', isNowCollapsed);
          }
        });
      }

      pillItem.setAttribute('title', `${node.fullPath}\n左クリック: 含む/解除 ｜ 右クリック: 除外`);

      // 左クリック: フィルタOFF ➜ 含む(+) / フィルタON(除外含む) ➜ OFF(解除)
      pillItem.addEventListener('click', (e) => {
        if (e.target.closest('.tree-toggle-btn')) return;
        handleTagLeftClick(node.fullPath);
      });

      // 右クリック: 除外(-)のトグル（OFFまたは含む ➜ 除外 / 既に除外 ➜ OFF）
      pillItem.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.tree-toggle-btn')) return;
        e.preventDefault();
        e.stopPropagation();
        handleTagRightClick(node.fullPath);
      });

      nodeEl.appendChild(pillItem);

      // 子ノードがある場合は再帰 (デフォルトは閉: hidden)
      if (hasChildren) {
        const childrenContainer = document.createElement('ul');
        childrenContainer.className = `tag-tree-children ${isExpanded ? '' : 'hidden'}`;
        appendTreeNodes(node, childrenContainer);
        nodeEl.appendChild(childrenContainer);
      }


      container.appendChild(nodeEl);
    });
  }

  appendTreeNodes(treeRoot, elements.tagList);
}

/**
 * タグのインラインリネームを開始する
 */
function startInlineRename(pillItem, node) {
  const nameSpan = pillItem.querySelector('.tag-name-text');
  if (!nameSpan) return;

  // 既にinputが表示されている場合は何もしない
  if (pillItem.querySelector('.tag-rename-input')) return;

  const oldName = node.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-rename-input';
  input.value = oldName;

  nameSpan.style.display = 'none';
  nameSpan.parentNode.insertBefore(input, nameSpan.nextSibling);
  input.focus();
  input.select();

  let committed = false;

  async function commitRename() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();

    // 変更なしまたは空ならキャンセル
    if (!newName || newName === oldName) {
      input.remove();
      nameSpan.style.display = '';
      return;
    }

    // 新しいfullPathを構築（親パスを維持してノード名だけ変更）
    const parts = node.fullPath.split('/');
    parts[parts.length - 1] = newName;
    const newFullPath = parts.join('/');

    try {
      const res = await fetch(`/api/tags/${encodeURIComponent(node.fullPath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_tag: newFullPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'リネームに失敗しました');
      }
      if (state.tagFilters && state.tagFilters.size > 0) {
        for (const [k, mode] of Array.from(state.tagFilters.entries())) {
          if (k === node.fullPath) {
            state.tagFilters.delete(k);
            state.tagFilters.set(newFullPath, mode);
          } else if (k.startsWith(node.fullPath + '/')) {
            state.tagFilters.delete(k);
            state.tagFilters.set(newFullPath + k.slice(node.fullPath.length), mode);
          }
        }
      }
      if (data && Array.isArray(data.tags) && typeof window.applyTagsSummaryData === 'function') {
        window.applyTagsSummaryData(data);
      } else if (typeof fetchTags === 'function') {
        await fetchTags();
      }
      if (typeof fetchPhotos === 'function') {
        fetchPhotos().then(() => {
          if (state.selectedPhotoIds && state.selectedPhotoIds.size > 1 && typeof showBatchInspector === 'function') {
            showBatchInspector();
          } else if (state.activeInspectorPhotoId && typeof showSingleInspector === 'function') {
            const p = state.photos.find(x => x.id === state.activeInspectorPhotoId);
            if (p) showSingleInspector(p);
          }
        });
      }
    } catch (err) {
      alert('エラー: ' + err.message);
      input.remove();
      nameSpan.style.display = '';
    }
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      committed = true;
      input.remove();
      nameSpan.style.display = '';
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(() => commitRename(), 100);
  });

  // input内のクリックが親に伝搬しないようにする
  input.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * タグを全写真から一括削除する
 */
async function deleteTagCompletely(tagPath, photoCount = 0) {
  let confirmed = false;
  if (typeof showDeleteTagModal === 'function') {
    confirmed = await showDeleteTagModal(tagPath, photoCount);
  } else {
    const countMsg = photoCount > 0
      ? `\n\n※ ${photoCount} 枚の写真からこのタグ（およびその子孫タグ）が削除されます。`
      : '\n\n※ このタグ（およびその子孫タグ）が全写真から削除されます。';
    confirmed = confirm(`タグ「${tagPath}」を削除しますか？${countMsg}\n※ 写真ファイル自体は削除されません。`);
  }
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/tags/${encodeURIComponent(tagPath)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'タグの削除に失敗しました');
    }
    // フィルタ状態からも削除（子孫タグ含む）
    if (state.tagFilters) {
      for (const k of Array.from(state.tagFilters.keys())) {
        if (k === tagPath || k.startsWith(tagPath + '/')) {
          state.tagFilters.delete(k);
        }
      }
    }
    if (data && Array.isArray(data.tags) && typeof window.applyTagsSummaryData === 'function') {
      window.applyTagsSummaryData(data);
    } else if (typeof fetchTags === 'function') {
      await fetchTags();
    }
    if (typeof fetchPhotos === 'function') {
      await fetchPhotos();
    }
    if (state.selectedPhotoIds && state.selectedPhotoIds.size > 1 && typeof showBatchInspector === 'function') {
      showBatchInspector();
    } else if (state.activeInspectorPhotoId && typeof showSingleInspector === 'function') {
      const p = state.photos.find(x => x.id === state.activeInspectorPhotoId);
      if (p) showSingleInspector(p);
    }
  } catch (err) {
    alert('エラー: ' + err.message);
  }
}
window.deleteTagCompletely = deleteTagCompletely;

/**
 * タグツリー 左クリック操作
 * - フィルタOFF ➜ 含む (include [+])
 * - フィルタON (含む[+] または 除外[-]) ➜ 解除 (OFF)
 */
function handleTagLeftClick(tag) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(tag);
  if (current) {
    state.tagFilters.delete(tag);
    if (state.tagFilters.size === 0) {
      if (state.tagAndRoots) state.tagAndRoots.clear();
      state.tagInterGroupMode = 'and';
    }
  } else {
    state.tagFilters.set(tag, 'include');
    expandTagAncestors(tag);
  }

  renderTagList();
  fetchPhotos();
}

/**
 * タグツリー 右クリック操作
 * - フィルタOFF または 含む[+] ➜ 除外 (exclude [-])
 * - 既に除外[-] ➜ 解除 (OFF)
 */
function handleTagRightClick(tag) {
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');

  const current = state.tagFilters.get(tag);
  if (current === 'exclude') {
    state.tagFilters.delete(tag);
    if (state.tagFilters.size === 0) {
      if (state.tagAndRoots) state.tagAndRoots.clear();
      state.tagInterGroupMode = 'and';
    }
  } else {
    state.tagFilters.set(tag, 'exclude');
    expandTagAncestors(tag);
  }

  renderTagList();
  fetchPhotos();
}

// 後方互換性エイリアス
const toggleTagFilter = handleTagLeftClick;

/**
 * 特定のタグフィルタを解除（削除）
 */
function removeTagFilter(tag) {
  state.tagFilters.delete(tag);
  if (state.tagFilters.size === 0) {
    if (state.tagAndRoots) state.tagAndRoots.clear();
    state.tagInterGroupMode = 'and';
  }
  renderTagList();
  fetchPhotos();
}

/**
 * すべてのタグフィルタをクリア
 */
function clearAllTagFilters() {
  state.tagFilters.clear();
  if (state.tagAndRoots) state.tagAndRoots.clear();
  state.tagInterGroupMode = 'and';
  state.untaggedOnly = false;
  elements.untaggedNavItem.classList.remove('active');
  renderTagList();
  fetchPhotos();
}

