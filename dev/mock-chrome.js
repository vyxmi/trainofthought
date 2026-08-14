/**
 * mock-chrome.js — a chrome.* stand-in for driving the panel outside an extension.
 *
 * This exists so the side panel can be rendered, screenshotted and interacted
 * with in headless Chromium without packaging and installing the extension on
 * every change. It implements only the surface panel.js actually touches:
 * storage.local, storage.session, storage.onChanged and tabs.
 *
 * Not shipped — the packaging script excludes the dev/ directory.
 */
(function () {
  const store = { local: {}, session: {} };
  const listeners = [];

  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function area(name) {
    return {
      async get(keys) {
        const src = store[name];
        if (keys === null || keys === undefined) return clone(src);
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (k in src) out[k] = clone(src[k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: clone(store[name][k]), newValue: clone(v) };
          store[name][k] = clone(v);
        }
        // Real storage events are async relative to the setter.
        setTimeout(() => listeners.forEach((fn) => fn(changes, name)), 0);
      },
      async remove(keys) {
        const list = typeof keys === 'string' ? [keys] : keys;
        const changes = {};
        for (const k of list) {
          changes[k] = { oldValue: clone(store[name][k]), newValue: undefined };
          delete store[name][k];
        }
        setTimeout(() => listeners.forEach((fn) => fn(changes, name)), 0);
      },
      async clear() {
        const changes = {};
        for (const k of Object.keys(store[name])) changes[k] = { oldValue: clone(store[name][k]), newValue: undefined };
        store[name] = {};
        setTimeout(() => listeners.forEach((fn) => fn(changes, name)), 0);
      },
    };
  }

  const fakeTabs = [
    { id: 1, url: 'https://www.figma.com/file/abc', title: 'Deposit flow — Figma', active: true, pinned: false },
    { id: 2, url: 'https://www.notion.so/case-study', title: 'Case study draft', active: false, pinned: false },
    { id: 3, url: 'https://app.posthog.com/insights', title: 'Deposit funnel', active: false, pinned: false },
  ];

  window.chrome = {
    storage: {
      local: area('local'),
      session: area('session'),
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    tabs: {
      async query() {
        return fakeTabs.map((t) => ({ ...t }));
      },
      async get(id) {
        return fakeTabs.find((t) => t.id === id);
      },
      async create(props) {
        window.__opened = window.__opened || [];
        window.__opened.push(props.url);
        return { id: Math.random(), ...props };
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    windows: { onFocusChanged: { addListener() {} }, WINDOW_ID_NONE: -1 },
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };

  // Test hook: seed durable state before the panel boots.
  window.__seed = (state) => {
    store.local.ty = clone(state);
  };
})();
