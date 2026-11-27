/* UI state only. Content eligibility and scheduling belong to the Hub. */
(() => {
  const $ = id => document.getElementById('js-' + id);
  const root = document.getElementById('jstudy-app');
  const bridge = window.StudyBridge;
  const labels = { unmarked: '未標記', unknown: '不熟', uncertain: '不確定', known: '熟悉', suspended: '暫停複習' };
  const blockers = { missing_meaning: '缺少中文意思', content_review_pending: '內容待確認', suspended: '已暫停複習', retired: '已停用' };
  const pageSize = 50;
  const state = { kind: 'vocab', page: 'library', rows: [], total: 0, offset: 0, generation: 0,
    loading: false, ready: false, busy: false, pending: null, deck: null, decks: new Map(),
    revealed: false, activeSession: null, card: null, batches: new Map(), bookmark: null, position: null, cardPreferences: {} };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = (id, value) => { $(id).textContent = value; };
  const show = (id, visible) => { $(id).hidden = !visible; };
  const uuid = () => crypto.randomUUID();
  const filters = () => ({ kind: state.kind, query: $('query').value.trim(),
    ...($('level').value !== 'all' ? { jlptLevel: $('level').value } : {}),
    ...($('label-filter').value !== 'all' ? { manualLabel: $('label-filter').value } : {}) });
  function validItem(item) {
    if (!item || typeof item.item_id !== 'string' || item.review_content?.contract_version !== 'review-content-v1')
      throw new Error('教材格式不符，請更新學習服務。');
    return item;
  }
  async function itemById(itemId) {
    const item = validItem((await bridge.call('study_get_item', { itemId })).item);
    if (item.item_id !== itemId) throw new Error('教材識別不一致，請重新整理。');
    return item;
  }
  function errorText(error) {
    if (error?.code === 'HUB_REVIEW_UPGRADE_REQUIRED') return '學習服務尚未更新，請完成更新後重試。';
    if (error?.code === 'TRANSPORT_TIMEOUT') return '連線逾時，結果尚未確認。';
    return '操作未完成：' + String(error?.message || '請稍後重試。').slice(0, 200);
  }
  function explanationMarkup(sections) {
    return (sections || []).map(section =>
      '<p class="js-explanation"><span class="js-muted">' + escape(section.label) + '　</span>' + escape(section.text) + '</p>'
    ).join('');
  }
  function exampleMarkup(examples) {
    return (examples || []).map(example => {
      const translation = example.zh_tw ? '<p>' + escape(example.zh_tw) + '</p>'
        : example.en ? '<p lang="en">' + escape(example.en) + '</p>' : '';
      return '<div class="js-example"><p lang="ja">' + escape(example.ja) + '</p>' + translation + '</div>';
    }).join('');
  }
  function reviewNotes(projection) {
    const reasons = (projection.blockers || []).map(key => blockers[key]).filter(Boolean);
    return (reasons.length ? '<p class="js-label-note">' + escape(reasons.join(' · ')) + '</p>' : '') +
      (projection.truncated ? '<p class="js-label-note">內容較長，這裡顯示節錄。</p>' : '');
  }
  const meaning = item => item.meaning_tc || '尚未補上中文意思';

  const visibleDetails = new Set();
  let detailFrame, detailsInFlight = false, detailResult;
  const detailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.target.isConnected) visibleDetails.add(entry.target);
      else visibleDetails.delete(entry.target);
    }
    scheduleDetails();
  });
  function scheduleDetails() {
    if (detailFrame == null) detailFrame = requestAnimationFrame(() => {
      detailFrame = null;
      loadVisibleDetails();
    });
  }
  function stopObserving(row) {
    detailObserver.unobserve(row);
    visibleDetails.delete(row);
  }
  function renderRowDetails(row, item) {
    const projection = item.review_content;
    row.querySelector('.js-meaning').textContent = meaning(item);
    const sections = explanationMarkup((projection.sections || [])
      .filter(section => section.text.trim() !== meaning(item).trim()));
    row.querySelector('.js-detail').innerHTML = exampleMarkup(projection.examples) +
      (sections && item.kind === 'grammar' ? '<details><summary>展開用法</summary>' + sections + '</details>' : sections);
    row.querySelector('.js-review-notes').innerHTML = reviewNotes(projection);
    row.dataset.detail = 'ready';
    stopObserving(row);
  }
  function applyDetailBatch({ rows, items, error }) {
    const scroll = $('scroll');
    const viewport = scroll.getBoundingClientRect();
    const focused = document.activeElement?.closest('#js-rows tr');
    const bookmarked = rowById(state.position?.item_id);
    const visible = row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    };
    const anchor = focused || (bookmarked && visible(bookmarked) ? bookmarked :
      Array.from($('rows').children).find(visible));
    const anchorTop = anchor?.getBoundingClientRect().top;
    for (const row of rows) {
      if (!row.isConnected) continue;
      const item = items?.get(row.dataset.item);
      if (item) {
        renderRowDetails(row, item);
        continue;
      }
      const detail = row.querySelector('.js-detail');
      if (!error) {
        row.dataset.detail = 'unavailable';
        detail.textContent = '這筆詳情已無法讀取。';
        stopObserving(row);
        continue;
      }
      row.dataset.detail = 'error';
      detail.textContent = errorText(error) + ' ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '重試';
      retry.addEventListener('click', () => {
        delete row.dataset.detail;
        detail.textContent = '';
        scheduleDetails();
      });
      detail.append(retry);
    }
    if (anchor) writeReadingScroll(scroll.scrollTop + anchor.getBoundingClientRect().top - anchorTop);
  }
  async function loadVisibleDetails() {
    // Keep an acknowledged or pending label's anchor stable until its focus has been restored.
    if (detailsInFlight || state.loading || state.busy || state.pending ||
        state.page !== 'library' || $('hide').checked) return;
    if (detailResult) {
      const result = detailResult;
      detailResult = null;
      applyDetailBatch(result);
      // Give IntersectionObserver a frame to report the newly laid out rows.
      scheduleDetails();
      return;
    }
    const rows = Array.from(visibleDetails).filter(row => row.isConnected && !row.dataset.detail).slice(0, 12);
    if (!rows.length) return;
    detailsInFlight = true;
    rows.forEach(row => { row.dataset.detail = 'loading'; });
    try {
      const result = await bridge.call('study_read_review_workspace', {
        scope: 'items', itemIds: rows.map(row => row.dataset.item),
      });
      if (!Array.isArray(result.items)) throw new Error('教材詳情格式不符。');
      detailResult = { rows, items: new Map(result.items.map(item => [item.item_id, validItem(item)])) };
    } catch (error) {
      detailResult = { rows, error };
    } finally {
      detailsInFlight = false;
      scheduleDetails();
    }
  }
  function rowNode(item) {
    const row = document.createElement('tr');
    row.dataset.item = item.item_id;
    const options = Object.entries(labels).map(([key, title]) =>
      '<option value="' + key + '"' + (key === 'unmarked' || key === 'suspended' ? ' disabled' : '') +
      '>' + title + '</option>').join('');
    const reading = item.reading?.trim();
    const readingLine = reading && reading !== item.title?.trim()
      ? '<div class="js-reading" lang="ja">' + escape(reading) + '</div>' : '';
    row.innerHTML = '<td><div class="js-word" lang="ja">' + escape(item.title) +
      '</div>' + readingLine + '<span class="js-tag">' +
      escape([item.jlpt_level, item.part_of_speech].filter(Boolean).join(' · ')) +
      '</span></td><td class="js-content"><div class="js-meaning">' + escape(meaning(item)) +
      '</div><div class="js-detail"></div><div class="js-review-notes">' + reviewNotes(item.review_content) + '</div></td><td>' +
      '<select class="js-manual" aria-label="' + escape(item.title + '的熟悉度') + '">' + options + '</select></td>';
    row.dataset.revision = JSON.stringify([item.updated_at, item.title, item.reading, item.meaning_tc]);
    patchLabel(row, item);
    return row;
  }
  function patchLabel(row, item) {
    const label = item.manual_label || 'unmarked';
    row.dataset.familiarity = label;
    const select = row.querySelector('select');
    select.querySelector('[value="suspended"]').hidden = label !== 'suspended';
    select.value = label;
  }
  const rowById = id => Array.from($('rows').children).find(row => row.dataset.item === id);
  function reconcileRows(items) {
    const body = $('rows');
    const incoming = new Set(items.map(item => item.item_id));
    for (const row of Array.from(body.children)) {
      if (!incoming.has(row.dataset.item)) { stopObserving(row); row.remove(); }
    }
    const current = new Map(Array.from(body.children, row => [row.dataset.item, row]));
    items.forEach((item, index) => {
      let row = current.get(item.item_id);
      if (row && row.dataset.revision !== JSON.stringify([item.updated_at, item.title, item.reading, item.meaning_tc])) {
        stopObserving(row);
        row.remove();
        row = null;
      }
      if (row) patchLabel(row, item);
      else {
        row = rowNode(item);
        detailObserver.observe(row);
      }
      if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
    });
  }
  const pageCount = () => Math.ceil(state.total / pageSize);
  function updateDisabled() {
    const locked = !state.ready || state.busy || !!state.pending;
    root.querySelectorAll('[data-page],[data-kind],#js-query,#js-level,#js-label-filter,#js-direction,#js-start,#js-end,#js-use-list')
      .forEach(el => { el.disabled = locked; });
    root.querySelectorAll('.js-manual,#js-page-number,#js-first,#js-bookmark,#js-refresh')
      .forEach(el => { el.disabled = locked || state.loading; });
    for (const filter of cardFilters) filter.menu.querySelector('fieldset').disabled = locked;
    $('start').disabled = locked || !!state.activeSession || hasEmptySelection();
    $('retry-preferences').disabled = locked;
    $('prev').disabled = locked || state.loading || state.offset === 0;
    $('next').disabled = locked || state.loading || state.offset + pageSize >= state.total;
    root.querySelectorAll('[data-rate]').forEach(el => { el.disabled = locked || !state.revealed; });
    $('skip').disabled = locked || !state.card;
    $('retry').disabled = state.busy;
    $('retry-card').disabled = locked;
    $('reveal').disabled = locked || !state.card?.item?.review_content.eligible;
  }
  function operation(message, retryLabel = '') {
    text('operation-text', message);
    show('operation', !!message);
    show('retry', !!retryLabel);
    text('retry', retryLabel);
    updateDisabled();
  }
  function save() {
    return bridge.saveState({ schema: 'jstudy-review-1', kind: state.kind, page: state.page,
      query: $('query').value, level: $('level').value, label: $('label-filter').value,
      density: $('density').value, hide: $('hide').checked, direction: $('direction').value,
      pending: state.pending });
  }
  const readWorkspace = (scope, sessionId, offset, library) =>
    bridge.call('study_read_review_workspace', { scope, sessionId, offset, library });
  const changeWorkspace = (action, payload) => bridge.call('study_update_review_workspace', { change: { action, payload } });
  const hubFilters = () => ({ kind: state.kind, query: $('query').value.trim(),
    jlpt_level: filters().jlptLevel ?? null, manual_label: filters().manualLabel ?? null });
  function capture(row) {
    if (!row) return null;
    const relativeTop = Math.round(row.getBoundingClientRect().top - $('scroll').getBoundingClientRect().top);
    return { ...hubFilters(), order: 'jlpt-title-id-v1', offset: state.offset, item_id: row.dataset.item,
      neighbor_id: (row.nextElementSibling || row.previousElementSibling)?.dataset.item ?? null,
      relative_top: relativeTop };
  }
  let bookmarkTimer, bookmarkQueue = Promise.resolve(), lastSavedBookmark;
  function remember(row, immediate = false) {
    if (state.loading || state.page !== 'library') return;
    const bookmark = capture(row);
    if (!bookmark) return;
    state.position = bookmark;
    clearTimeout(bookmarkTimer);
    if (immediate) flushBookmark(bookmark);
    else bookmarkTimer = setTimeout(() => flushBookmark(bookmark), 350);
  }
  function flushBookmark(bookmark = state.position) {
    clearTimeout(bookmarkTimer);
    if (!bookmark) return Promise.resolve();
    const fingerprint = JSON.stringify(bookmark);
    bookmarkQueue = bookmarkQueue.then(async () => {
      if (fingerprint === lastSavedBookmark) return;
      try {
        await changeWorkspace('bookmark', bookmark);
        lastSavedBookmark = fingerprint;
        state.bookmark = bookmark;
        show('bookmark', true);
      } catch {
        text('status', '書籤未保存。可再次選取教材或重新整理後重試。');
      }
    });
    return bookmarkQueue;
  }
  let adjustedScrollTop;
  function writeReadingScroll(top) {
    const scroll = $('scroll');
    const before = scroll.scrollTop;
    scroll.scrollTop = top;
    if (scroll.scrollTop !== before) adjustedScrollTop = scroll.scrollTop;
  }
  function restoreRow(row, position, focus) {
    if (!row) return;
    const scroll = $('scroll');
    const top = position?.relative_top ?? $('rows').previousElementSibling.getBoundingClientRect().height;
    writeReadingScroll(scroll.scrollTop + row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - top);
    if (focus) row.querySelector('select').focus({ preventScroll: true });
  }
  async function loadRows(offset = 0, position = null, { pin = false, focus = false, notice = '', preloaded } = {}) {
    const generation = ++state.generation;
    state.loading = true;
    text('status', '載入中…'); updateDisabled();
    let pinned;
    try {
      const result = preloaded || await bridge.call('study_search_items', { ...filters(), view: 'summary', offset, limit: pageSize,
        ...(position && { anchor: position.item_id, neighbor: position.neighbor_id || undefined }) });
      if (generation !== state.generation) return;
      if (!Array.isArray(result.items) || !Number.isInteger(result.offset) || !Number.isInteger(result.total) ||
          !Object.hasOwn(result, 'anchor_item_id')) throw new Error('教材分頁格式不符，請更新學習服務。');
      state.rows = result.items.map(validItem);
      state.total = result.total;
      state.offset = result.offset;
      reconcileRows(state.rows);
      $('page-number').value = state.offset / pageSize + 1;
      $('page-number').max = Math.max(1, pageCount());
      text('page-total', '/ ' + pageCount());
      show('pagination', state.total > 0);
      text('result-count', state.rows.length ? (state.offset + 1) + '–' + (state.offset + state.rows.length) + ' / ' + state.total : '0 / ' + state.total);
      show('no-results', !state.rows.length);
      const index = position?.index ?? 0;
      const row = rowById(result.anchor_item_id) || $('rows').children[Math.min(index, state.rows.length - 1)];
      if (position) {
        restoreRow(row, position, false);
        pinned = row;
      } else {
        writeReadingScroll(0);
        pinned = $('rows').firstElementChild;
      }
      state.position = capture(pinned);
      text('status', position && result.anchor_item_id !== position.item_id
        ? (row ? '原項目已離開目前篩選，已移到鄰近項目。' : '原項目已離開目前篩選，沒有可續讀的項目。')
        : notice);
      await save();
    } catch (error) {
      if (generation === state.generation) text('status', errorText(error));
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        updateDisabled();
        if (focus && pinned) restoreRow(pinned, position, true);
        else if (focus) $('label-filter').focus({ preventScroll: true });
        if (pin && pinned) remember(pinned, true);
        scheduleDetails();
      }
    }
  }
  function setKind(kind) {
    state.kind = kind;
    root.querySelectorAll('[data-kind]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.kind === kind)));
    text('title-heading', kind === 'grammar' ? '文法／讀音' : '單字／讀音');
    text('card-kind', kind === 'grammar' ? '文法' : '單字');
    restoreCardPreferences();
  }
  function restoreBookmark(bookmark, preloaded) {
    if (!bookmark) return loadRows();
    setKind(bookmark.kind);
    $('query').value = bookmark.query;
    $('level').value = bookmark.jlpt_level || 'all';
    $('label-filter').value = bookmark.manual_label || 'all';
    return loadRows(bookmark.offset, bookmark, { notice: '已接續上次閱讀。', preloaded });
  }
  function page(name) {
    if (state.page === name) return;
    if (state.page === 'library') flushBookmark();
    else endRound();
    state.page = name;
    show('library', name === 'library'); show('cards', name === 'cards');
    show('use-list', name === 'library');
    root.querySelectorAll('[data-page]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.page === name)));
    if (name === 'cards') {
      $('cards').append($('operation'));
      text('review-status', '');
      updateDeckSetup();
    } else {
      $('scroll').after($('operation'));
      scheduleDetails();
    }
    save();
  }
  const cardFilters = [
    { menu: $('card-levels'), key: 'jlpt_levels',
      options: [['N1', 'N1'], ['N2', 'N2'], ['N3', 'N3'], ['N4', 'N4'], ['N5', 'N5'], ['N4-5', 'N4-5'], ['unclassified', '未分類']] },
    { menu: $('card-labels'), key: 'manual_labels',
      options: ['unmarked', 'unknown', 'uncertain', 'known'].map(key => [key, labels[key]]) },
  ];
  for (const filter of cardFilters) {
    const fieldset = filter.menu.querySelector('fieldset');
    function addCheckbox(label, value) {
      const control = document.createElement('input');
      control.type = 'checkbox';
      control.checked = true;
      control.value = value;
      const wrapper = document.createElement('label');
      wrapper.append(control, label);
      fieldset.append(wrapper);
      return control;
    }
    filter.all = addCheckbox('全選', '');
    filter.inputs = filter.options.map(([value, label]) => addCheckbox(label, value));
    fieldset.addEventListener('change', event => {
      if (event.target === filter.all) filter.inputs.forEach(input => { input.checked = filter.all.checked; });
      text('review-status', '');
      persistPreferences();
    });
  }
  const menus = [...cardFilters.map(filter => filter.menu), $('display'), $('reading-menu')];
  for (const menu of menus) {
    menu.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      event.stopPropagation();
      menu.open = false;
      menu.querySelector('summary').focus();
    });
    menu.addEventListener('toggle', () => {
      if (menu.open) for (const other of menus) if (other !== menu) other.open = false;
    });
  }
  document.addEventListener('click', event => {
    for (const menu of menus) if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  function selection(filter) {
    const selected = filter.inputs.filter(input => input.checked).map(input => input.value).sort();
    return selected.length === filter.inputs.length ? null : selected;
  }
  function cardPreferences() {
    return { kind: state.kind, direction: $('direction').value,
      ...Object.fromEntries(cardFilters.map(filter => [filter.key, selection(filter)])) };
  }
  function restoreCardPreferences() {
    const prefs = state.cardPreferences[state.kind];
    $('direction').value = prefs?.direction || 'ja';
    for (const filter of cardFilters) {
      for (const input of filter.inputs) input.checked = prefs?.[filter.key]?.includes(input.value) ?? true;
    }
    updateDeckSetup();
  }
  const pendingPreferences = new Map(), unsavedPreferences = new Set();
  let savingPreferenceKind;
  function persistPreferences() {
    const prefs = cardPreferences();
    state.cardPreferences[prefs.kind] = prefs;
    pendingPreferences.set(prefs.kind, prefs);
    updateDeckSetup();
    flushPreferences();
  }
  async function flushPreferences() {
    if (savingPreferenceKind) return;
    for (const [kind, prefs] of pendingPreferences) {
      pendingPreferences.delete(kind);
      savingPreferenceKind = kind;
      updatePreferencesStatus();
      try {
        await changeWorkspace('preferences', prefs);
        unsavedPreferences.delete(kind);
      } catch {
        unsavedPreferences.add(kind);
      }
    }
    savingPreferenceKind = null;
    updatePreferencesStatus();
  }
  function updatePreferencesStatus() {
    const saving = savingPreferenceKind === state.kind || pendingPreferences.has(state.kind);
    const failed = !saving && unsavedPreferences.has(state.kind);
    show('preferences-status', saving || failed);
    show('retry-preferences', failed);
    text('preferences-status', saving ? '儲存篩選偏好中…' : failed ? '篩選偏好尚未儲存。' : '');
  }
  const deckKey = (kind, mode) => kind + ':' + mode;
  const savedRandomDeck = () => state.decks.get(deckKey(state.kind, 'random'));
  const hasEmptySelection = () => cardFilters.some(filter => selection(filter)?.length === 0);
  function selectionText(filter, selected) {
    if (selected == null) return '全部';
    return filter.options.filter(([key]) => selected.includes(key)).map(([, label]) => label).join('、') || '未選';
  }
  function updateDeckSetup() {
    const prefs = cardPreferences();
    for (const filter of cardFilters) {
      const selected = prefs[filter.key];
      filter.all.checked = selected === null;
      filter.all.indeterminate = !!selected?.length;
      filter.menu.querySelector('.js-filter-value').textContent = selectionText(filter, selected);
    }
    const config = state.activeSession && state.deck?.session_id === state.activeSession ? state.deck.config : null;
    let note = '';
    if (config) {
      const changed = config.direction !== prefs.direction ||
        cardFilters.some(({ key }) => JSON.stringify(config[key]) !== JSON.stringify(prefs[key]));
      if (changed) {
        const [levels, familiarity] = cardFilters.map(filter => selectionText(filter, config[filter.key]));
        const direction = config.direction === 'ja' ? '日文 → 中文' : '中文 → 日文';
        note = '本輪使用等級 ' + levels + ' · 熟練度 ' + familiarity + ' · ' + direction + '。變更將套用到下一輪。';
      } else note = '變更設定將套用到下一輪。';
    }
    if (hasEmptySelection()) note += (note ? ' ' : '') + '開始前請各選至少一項等級與熟練度。';
    text('deck-summary', note);
    show('deck-summary', !!note);
    updatePreferencesStatus();
    updateDisabled();
  }
  function rememberDecks(decks) {
    state.decks = new Map(decks.map(deck => [deckKey(deck.config.kind, deck.config.mode), deck]));
  }
  function applyDeck(deck) {
    if (!deck || !Number.isInteger(deck.position) || !Number.isInteger(deck.total))
      throw new Error('卡片佇列格式不符。');
    if (state.deck?.session_id !== deck.session_id) state.batches.clear();
    for (const card of deck.cards || []) state.batches.set(card.position, card);
    for (const position of state.batches.keys()) if (position < deck.position) state.batches.delete(position);
    state.deck = deck;
    state.decks.set(deckKey(deck.config.kind, deck.config.mode), deck);
  }
  let prefetch;
  function fetchCards(offset) {
    const session = state.deck.session_id;
    if (prefetch?.session === session && prefetch.offset === offset) return prefetch.promise;
    const entry = { session, offset };
    entry.promise = readWorkspace('deck', session, offset).then(({ deck }) => {
      if (session !== state.activeSession) return;
      if (!deck || deck.session_id !== session || deck.position > state.deck.position)
        throw new Error('複習位置已變更，請重新讀取。');
      for (const card of deck.cards) if (card.position >= state.deck.position) state.batches.set(card.position, card);
    }).finally(() => { if (prefetch === entry) prefetch = null; });
    prefetch = entry;
    return entry.promise;
  }
  const gradeNames = { again: 'Again', hard: 'Hard', correct: 'Good', easy: 'Easy', skip: '略過' };
  async function renderCard() {
    const { position, total, config } = state.deck;
    state.card = null;
    state.revealed = false;
    text('answer', '');
    show('setup', false); show('complete', false); show('session', false); show('retry-card', false);
    show('round-actions', true);
    if (position >= total) {
      endRound(true);
      text('complete-summary', total
        ? Object.entries(gradeNames).map(([grade, name]) => name + ' ' + (state.deck.counts[grade] || 0)).join(' · ')
        : '沒有可複習的卡片。');
      text('review-status', state.deck.excluded ? '排除 ' + state.deck.excluded + ' 筆缺譯、未審或暫停的項目。' : '');
      return;
    }
    try {
      if (!state.batches.has(position)) {
        text('review-status', '讀取卡片…');
        const pendingBatch = prefetch?.session === state.deck.session_id && prefetch.offset <= position ? prefetch.promise : null;
        if (pendingBatch) await pendingBatch;
        if (!state.batches.has(position)) await fetchCards(position);
      }
      const card = state.batches.get(position);
      if (!card) throw new Error('缺少目前卡片。');
      const item = card.item ? validItem(card.item) : null;
      const eligible = item?.review_content.eligible;
      state.card = card;
      text('card-meta', [config.kind === 'grammar' ? '文法' : '單字', item?.jlpt_level].filter(Boolean).join(' · '));
      text('card-prompt', eligible ? (config.direction === 'ja' ? item.title : item.meaning_tc) : '此項目已無法複習');
      $('card-prompt').lang = eligible && config.direction === 'ja' ? 'ja' : 'zh-Hant';
      show('answer', false); show('rating', false); show('reveal', eligible); show('session', true);
      text('review-status', eligible ? '' : '可略過此卡並繼續。');
      updateDeckSetup();
      // Keep one upcoming batch in flight while the learner works on the last two cards.
      let next = position + 1;
      while (state.batches.has(next)) next++;
      if (next - position <= 2 && next < total) fetchCards(next).catch(() => {});
    } catch (error) {
      text('review-status', errorText(error)); show('retry-card', true);
    }
  }
  function focusCard() {
    if (state.card) $(state.card.item?.review_content.eligible ? 'reveal' : 'skip').focus({ preventScroll: true });
    else if (!$('retry-card').hidden) $('retry-card').focus({ preventScroll: true });
    else if (!$('setup').hidden) $('start').focus({ preventScroll: true });
  }
  function endRound(completed = false) {
    state.activeSession = null;
    state.card = null;
    state.revealed = false;
    state.batches.clear();
    text('answer', '');
    show('answer', false); show('rating', false); show('session', false);
    show('complete', completed); show('retry-card', false); show('round-actions', false); show('setup', true);
    updateDeckSetup();
  }
  function pauseCards() {
    endRound();
    text('review-status', '');
    focusCard();
  }
  async function reloadActiveCard() {
    const sessionId = state.activeSession;
    if (!sessionId || state.busy || state.pending) return;
    state.busy = true;
    updateDisabled();
    try {
      const { deck } = await readWorkspace('deck', sessionId, 0);
      state.batches.clear();
      applyDeck(deck);
      await renderCard();
    } catch (error) {
      text('review-status', errorText(error));
      show('retry-card', true);
    } finally { state.busy = false; updateDisabled(); focusCard(); }
  }
  function startCards() {
    if (hasEmptySelection() || state.activeSession || state.busy || state.pending) return;
    const config = { ...cardPreferences(), mode: 'random' };
    const sessionId = 'flash-' + uuid();
    state.activeSession = sessionId;
    for (const { menu } of cardFilters) menu.open = false;
    text('review-status', '');
    state.pending = { type: 'start', stage: 'request',
      payload: { session_id: sessionId, previous_id: savedRandomDeck()?.session_id ?? null, config } };
    runPending();
  }
  function moveCard(rating) {
    if (!state.card || state.deck.session_id !== state.activeSession || state.busy || state.pending) return;
    state.pending = { type: 'move', stage: 'request', payload: {
      session_id: state.deck.session_id, position: state.card.position,
      item_id: state.card.item_id, rating, occurred_at: new Date().toISOString()
    } };
    runPending();
  }
  function sameMove(a, b) {
    return a && b && a.session_id === b.session_id && a.position === b.position &&
      a.item_id === b.item_id && a.rating === b.rating && Date.parse(a.occurred_at) === Date.parse(b.occurred_at);
  }
  async function confirmPending(pending) {
    if (pending.type === 'label') {
      const item = await itemById(pending.itemId);
      const { label, note } = pending.payload.labels[0];
      return item.manual_label === label && (note === undefined || item.manual_note === note) ? item : null;
    }
    if (pending.type === 'attempt') {
      // Compatibility for an older frame with a fixed, already-dispatched event.
      if (pending.stage === 'legacy-readback') return itemById(pending.itemId);
      return bridge.call('study_record_attempt', pending.payload);
    }
    const { deck } = await readWorkspace('deck', pending.payload.session_id, pending.type === 'start' ? 0 : undefined);
    if (!deck || deck.session_id !== pending.payload.session_id) return null;
    if (pending.type === 'start' || sameMove(deck.last_move?.move, pending.payload)) return deck;
    if (deck.position !== pending.payload.position) throw new Error('複習位置已變更，請重新開啟以讀取最新進度。');
    return null;
  }
  async function runPending() {
    if (state.busy || !state.pending) return;
    const pending = state.pending;
    let refreshCard = false;
    state.busy = true;
    operation(pending.stage === 'readback' ? '讀取儲存結果…' : '儲存中…');
    try {
      await save();
      let result;
      if (pending.stage !== 'request' || pending.type === 'attempt') {
        result = await confirmPending(pending);
        if (!result) {
          pending.stage = 'request';
          await save();
          operation('Hub 尚未確認這筆操作。', '重試同一筆');
          return;
        }
      } else {
        try {
          if (pending.type === 'label') {
            const response = await bridge.call('study_set_manual_labels', pending.payload);
            result = response.result?.items?.find(item => item.item_id === pending.itemId);
            if (!result || result.manual_label !== pending.payload.labels[0].label)
              throw new Error('缺少熟悉度儲存確認。');
          } else {
            result = (await changeWorkspace(pending.type, pending.payload)).deck;
            if (!result || result.session_id !== pending.payload.session_id ||
                (pending.type === 'move' && !sameMove(result.last_move?.move, pending.payload)))
              throw new Error('缺少這筆複習操作的確認。');
          }
        } catch (error) {
          if (error.code === 'REVIEW_CARD_UNAVAILABLE') {
            state.pending = null;
            await save();
            refreshCard = state.activeSession === pending.payload.session_id;
            operation(refreshCard ? '這張卡已無法複習，可略過後繼續。' : '上一輪卡片已無法複習。');
            if (!refreshCard) endRound();
            return;
          }
          if (error.code === 'REVIEW_DECK_CHANGED') {
            const { decks } = await readWorkspace('workspace');
            rememberDecks(decks);
            state.pending = null;
            await save();
            pauseCards();
            operation('另一個視窗已更新複習進度，可以開始新一輪。');
            return;
          }
          pending.stage = 'readback';
          await save();
          throw error;
        }
      }
      state.pending = null;
      await save();
      if (pending.type === 'label') {
        const position = pending.position;
        const row = rowById(pending.itemId);
        const filter = $('label-filter').value;
        if (filter === 'all' || filter === result.manual_label) {
          if (row) {
            patchLabel(row, result);
            state.rows = state.rows.map(item => item.item_id === result.item_id ? { ...item, manual_label: result.manual_label } : item);
          }
        } else await loadRows(position?.offset ?? state.offset, position, { pin: true });
        operation('已儲存：' + labels[result.manual_label]);
        state.busy = false;
        updateDisabled();
        const target = row?.isConnected ? row : rowById(state.position?.item_id);
        if (target) {
          restoreRow(target, position, true);
          remember(target, true);
        } else $('label-filter').focus({ preventScroll: true });
      } else if (pending.type === 'attempt') operation('已記錄');
      else {
        applyDeck(result);
        if (state.page !== 'cards') page('cards');
        operation(pending.type === 'move' && pending.payload.rating !== 'skip' ? '已記錄' : '');
        if (state.activeSession === result.session_id) await renderCard();
        else endRound();
      }
    } catch (error) {
      operation(errorText(error), state.pending
        ? (pending.stage === 'readback' || pending.stage === 'legacy-readback' ? '重新讀取結果' : '重試同一筆')
        : '');
    } finally {
      state.busy = false;
      updateDisabled();
      if (pending.type === 'label') scheduleDetails();
      if (refreshCard) await reloadActiveCard();
      else if (state.page === 'cards' && !state.pending) focusCard();
    }
  }
  root.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => page(el.dataset.page)));
  let searchTimer;
  function browseFromStart() {
    clearTimeout(searchTimer);
    state.position = null;
    loadRows(0, null, { pin: true });
  }
  root.querySelectorAll('[data-kind]').forEach(el => el.addEventListener('click', () => {
    setKind(el.dataset.kind); browseFromStart();
  }));
  $('query').addEventListener('input', () => {
    clearTimeout(searchTimer);
    state.generation++;
    state.loading = true;
    updateDisabled();
    searchTimer = setTimeout(browseFromStart, 250);
  });
  for (const id of ['level', 'label-filter']) $(id).addEventListener('change', browseFromStart);
  function styleLibrary() {
    $('library').classList.toggle('js-compact', $('density').value === 'compact');
    $('library').classList.toggle('js-library-hidden', $('hide').checked);
    scheduleDetails();
  }
  for (const id of ['density', 'hide']) $(id).addEventListener('change', () => { styleLibrary(); save(); });
  $('prev').addEventListener('click', () => loadRows(state.offset - pageSize, null, { pin: true }));
  $('next').addEventListener('click', () => loadRows(state.offset + pageSize, null, { pin: true }));
  $('page-form').addEventListener('submit', event => {
    event.preventDefault();
    loadRows(($('page-number').valueAsNumber - 1) * pageSize, null, { pin: true });
  });
  $('first').addEventListener('click', () => {
    $('reading-menu').open = false;
    $('reading-menu').querySelector('summary').focus();
    browseFromStart();
  });
  $('bookmark').addEventListener('click', () => restoreBookmark(state.bookmark));
  $('refresh').addEventListener('click', () => loadRows(state.offset, state.position, { pin: true }));
  $('scroll').addEventListener('scroll', () => {
    const scroll = $('scroll');
    const compensated = adjustedScrollTop === scroll.scrollTop;
    adjustedScrollTop = undefined;
    if (compensated || state.loading || state.busy || state.pending) return;
    const position = state.position;
    const anchor = rowById(position?.item_id);
    const top = scroll.getBoundingClientRect().top + ($('rows').previousElementSibling?.getBoundingClientRect().height || 0);
    if (anchor) {
      const { top: rowTop, bottom } = anchor.getBoundingClientRect();
      if (bottom > top && rowTop < scroll.getBoundingClientRect().bottom) {
        remember(anchor);
        return;
      }
    }
    remember(Array.from($('rows').children).find(row => row.getBoundingClientRect().bottom > top));
  }, { passive: true });
  for (const type of ['focusin', 'click']) $('rows').addEventListener(type, event => {
    if (!state.pending && !state.busy) remember(event.target.closest('[data-item]'), type === 'focusin');
  });
  $('rows').addEventListener('change', event => {
    if (!event.target.matches('.js-manual') || state.pending || state.busy || state.loading) return;
    const row = event.target.closest('[data-item]');
    const item = state.rows.find(entry => entry.item_id === row.dataset.item);
    const label = event.target.value;
    event.target.value = item.manual_label || 'unmarked';
    if (!['known', 'unknown', 'uncertain'].includes(label) || label === item.manual_label) return;
    clearTimeout(bookmarkTimer);
    state.pending = { type: 'label', stage: 'request', itemId: item.item_id,
      position: { ...capture(row), index: row.sectionRowIndex },
      payload: { preserveNotes: true, labels: [{ itemId: item.item_id, label }] } };
    runPending();
  });
  $('use-list').addEventListener('click', () => {
    const { jlptLevel, manualLabel, query } = filters();
    for (const filter of cardFilters) {
      const value = filter.key === 'jlpt_levels' ? jlptLevel : manualLabel;
      filter.inputs.forEach(input => { input.checked = !value || input.value === value; });
    }
    persistPreferences();
    page('cards');
    if (query) text('review-status', '文字搜尋僅適用於教材清單。已帶入清單的等級與熟練度條件。');
  });
  $('direction').addEventListener('change', persistPreferences);
  $('retry-preferences').addEventListener('click', persistPreferences);
  $('start').addEventListener('click', startCards);
  $('retry-card').addEventListener('click', reloadActiveCard);
  $('end').addEventListener('click', pauseCards);
  $('reveal').addEventListener('click', () => {
    if (state.busy || state.pending || !state.card?.item?.review_content.eligible) return;
    const { item } = state.card;
    const projection = item.review_content;
    const reverse = state.deck.config.direction === 'zh';
    const reading = item.reading?.trim();
    const partOfSpeech = item.part_of_speech?.trim();
    const details = explanationMarkup(projection.sections) + exampleMarkup(projection.examples) + reviewNotes(projection);
    $('answer').innerHTML = '<div class="js-answer-head">' +
      (reverse ? '<h3 lang="ja">' + escape(item.title) + '</h3>' : '') +
      (reading ? '<div class="js-reading" lang="ja">' + escape(reading) + '</div>' : '') +
      '<div class="js-meaning" lang="zh-Hant">' + escape(item.meaning_tc) + '</div>' +
      (partOfSpeech ? '<div class="js-answer-pos">詞性 ' + escape(partOfSpeech) + '</div>' : '') + '</div>' +
      (details ? '<div class="js-answer-detail">' + details + '</div>' : '');
    state.revealed = true;
    show('answer', true); show('rating', true); show('reveal', false);
    updateDisabled();
    $('answer').focus({ preventScroll: true });
  });
  $('skip').addEventListener('click', () => moveCard('skip'));
  root.querySelectorAll('[data-rate]').forEach(el => el.addEventListener('click', () => {
    if (state.revealed) moveCard(el.dataset.rate);
  }));
  $('retry').addEventListener('click', runPending);
  $('expand').addEventListener('click', () => bridge.expand().catch(error => operation(errorText(error))));
  bridge.on('context', context => {
    if (['light', 'dark'].includes(context.theme)) document.documentElement.style.colorScheme = context.theme;
    root.classList.toggle('js-expanded', ['fullscreen', 'pip'].includes(context.displayMode));
    const panelHeight = context.containerDimensions?.height ?? context.containerDimensions?.maxHeight ?? context.maxHeight;
    if (Number.isFinite(panelHeight) && panelHeight > 0) root.style.setProperty('--js-panel-height', panelHeight + 'px');
    else root.style.removeProperty('--js-panel-height');
    show('expand', context.availableDisplayModes?.includes('fullscreen') && context.displayMode !== 'fullscreen');
  });
  let requestedKind;
  bridge.on('toolresult', result => {
    const data = result?.structuredContent;
    if (!data?.kind_explicit || !['vocab', 'grammar'].includes(data.kind)) return;
    requestedKind = data.kind;
    if (state.ready && !state.busy && !state.pending && state.kind !== requestedKind)
      root.querySelector('[data-kind="' + requestedKind + '"]').click();
  });
  new ResizeObserver(() => bridge.resize(Math.ceil(document.documentElement.getBoundingClientRect().height))).observe(root);
  async function boot() {
    updateDisabled(); text('status', '連線中…');
    try {
      await bridge.connect();
      const saved = bridge.getState();
      if (saved?.schema === 'jstudy-review-1') {
        for (const [key, id] of Object.entries({ query: 'query', level: 'level', label: 'label-filter', density: 'density' })) {
          if (typeof saved[key] === 'string') {
            const field = $(id);
            if (field.tagName !== 'SELECT' || Array.from(field.options).some(option => option.value === saved[key])) field.value = saved[key];
          }
        }
        $('hide').checked = !!saved.hide;
        if (saved.kind === 'grammar') state.kind = 'grammar';
        const pending = saved.pending;
        if (pending?.payload && ['label', 'start', 'move', 'attempt'].includes(pending.type)) {
          state.pending = { ...pending, stage: pending.type === 'attempt' && pending.stage !== 'request'
            ? 'legacy-readback' : 'readback' };
        }
      }
      const bootKind = requestedKind;
      const { bookmark, decks, library, card_preferences } = await readWorkspace('workspace', undefined, undefined,
        { ...hubFilters(), kind: bootKind || state.kind, explicit_kind: !!bootKind });
      const preloaded = requestedKind === bootKind ? library : undefined;
      if (!card_preferences) throw Object.assign(new Error(), { code: 'HUB_REVIEW_UPGRADE_REQUIRED' });
      state.bookmark = bookmark;
      state.cardPreferences = card_preferences;
      rememberDecks(decks);
      for (const deck of decks) {
        if (deck.config.mode === 'random' && !state.cardPreferences[deck.config.kind])
          state.cardPreferences[deck.config.kind] = deck.config;
      }
      show('bookmark', !!bookmark);
      if (requestedKind && bookmark && requestedKind !== bookmark.kind) {
        $('query').value = '';
        $('level').value = 'all';
        $('label-filter').value = 'all';
      }
      setKind(requestedKind || state.kind);
      styleLibrary();
      state.ready = true;
      if (bookmark && (!requestedKind || requestedKind === bookmark.kind)) await restoreBookmark(bookmark, preloaded);
      else await loadRows(0, null, { preloaded });
      if (saved?.page === 'cards' || ['start', 'move', 'attempt'].includes(state.pending?.type)) page('cards');
      if (state.pending) operation('有一筆儲存結果尚未確認。', '重新讀取結果');
      updateDeckSetup();
    } catch (error) {
      text('status', errorText(error));
      operation('無法讀取複習進度。請從 ChatGPT 重新開啟日文複習室。');
    }
  }
  boot();
})();
