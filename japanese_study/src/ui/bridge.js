/* Standard MCP Apps transport. A timed-out write is never retried here. */
(() => {
  const pending = new Map();
  const listeners = new Map();
  let origin = '*';
  let mode = 'standard';
  let hostContext = {};
  let savedState;
  const storageKey = 'jstudy-review-1';
  const allow = new Set(['study_search_items', 'study_get_item', 'study_read_review_workspace', 'study_update_review_workspace', 'study_set_manual_labels', 'study_record_attempt']);
  const emit = (name, data) => (listeners.get(name) || []).forEach(fn => fn(data));
  function updateContext(changes) {
    hostContext = { ...hostContext, ...changes };
    emit('context', hostContext);
  }
  window.addEventListener('openai:set_globals', event => {
    if (mode !== 'compatibility') return;
    const globals = event.detail?.globals || {};
    const changes = {};
    for (const key of ['theme', 'displayMode', 'maxHeight']) {
      if (Object.hasOwn(globals, key)) changes[key] = globals[key];
    }
    updateContext(changes);
  });
  function notify(method, params) {
    if (window.parent !== window) window.parent.postMessage({ jsonrpc: '2.0', method, params }, origin);
  }
  function request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = 'study-' + crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('要求逾時；寫入結果尚未確認。'), { code: 'TRANSPORT_TIMEOUT' }));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, origin);
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || window.parent === window) return;
    if (origin !== '*' && event.origin !== origin) return;
    const m = event.data;
    if (!m || m.jsonrpc !== '2.0' || typeof m !== 'object') return;
    if (pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id); clearTimeout(p.timer);
      if (event.origin && event.origin !== 'null') origin = event.origin;
      if (m.error) p.reject(Object.assign(new Error(String(m.error.message || 'Host 拒絕操作。')), { code: m.error.code }));
      else p.resolve(m.result);
    } else if (m.method === 'ui/notifications/tool-result') emit('toolresult', m.params);
    else if (m.method === 'ui/notifications/host-context-changed') {
      updateContext(m.params);
    }
  });
  function decoded(result) {
    let data = result?.structuredContent;
    if (!data && Array.isArray(result?.content)) {
      for (const part of result.content) {
        if (part.type === 'text') { try { const candidate = JSON.parse(part.text); if (candidate && typeof candidate === 'object') data = candidate; } catch {} }
      }
    }
    if (result?.isError || data?.ok === false) {
      throw Object.assign(new Error(data?.error?.message || '操作未完成。'), { code: data?.error?.code || 'TOOL_ERROR' });
    }
    if (!data || typeof data !== 'object') throw new Error('伺服器回傳格式不符。');
    return data;
  }
  window.StudyBridge = {
    on(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
    async connect() {
      try {
        if (window.parent === window) throw new Error('請從 ChatGPT 開啟日文複習室。');
        const result = await request('ui/initialize', {
          appInfo: { name: 'japanese-study-review', version: '1.3.0' },
          appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
          protocolVersion: '2026-01-26',
        }, 8000);
        hostContext = result?.hostContext || {};
        notify('ui/notifications/initialized', {});
      } catch (error) {
        if (typeof window.openai?.callTool !== 'function') throw error;
        mode = 'compatibility';
        hostContext = { theme: window.openai.theme, displayMode: window.openai.displayMode, maxHeight: window.openai.maxHeight,
          availableDisplayModes: window.openai.requestDisplayMode ? ['inline', 'fullscreen'] : ['inline'] };
      }
      emit('context', hostContext);
      return hostContext;
    },
    async call(name, args) {
      if (!allow.has(name)) throw new Error('不支援的介面操作。');
      let result;
      if (mode === 'standard') result = await request('tools/call', { name, arguments: args });
      else {
        let timer;
        try {
          result = await Promise.race([window.openai.callTool(name, args), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('要求逾時；寫入結果尚未確認。'), { code: 'TRANSPORT_TIMEOUT' })), 30000);
          })]);
        } finally { clearTimeout(timer); }
      }
      return decoded(result);
    },
    async expand() {
      const result = mode === 'compatibility'
        ? await window.openai.requestDisplayMode({ mode: 'fullscreen' })
        : await request('ui/request-display-mode', { mode: 'fullscreen' });
      if (result?.mode) updateContext({ displayMode: result.mode });
      return result;
    },
    getState() {
      if (window.openai?.widgetState?.schema === storageKey) return window.openai.widgetState;
      return savedState;
    },
    async saveState(value) {
      savedState = value;
      if (typeof window.openai?.setWidgetState === 'function') {
        try { await window.openai.setWidgetState(value); } catch { /* In-frame pending state remains retryable. */ }
      }
    },
    resize(height) { if (mode === 'standard') notify('ui/notifications/size-changed', { height }); },
  };
})();
