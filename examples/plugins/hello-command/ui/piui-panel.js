// PiUI plugin panel client v1 (@piui/plugin-sdk). Copy this file next to
// your panel page (create-plugin does) and load it with
// <script src="piui-panel.js"></script> before your own script.
//
// A panel runs in a sandboxed frame with an opaque origin: no Tauri API, no
// network, no storage shared with PiUI. Everything goes through this bridge,
// and PiUI checks the plugin's permissions on every request:
//   context.get  (chat.read)      the open chat's id and title
//   commands.run (commands)       one of this plugin's commands
//   settings.get / settings.set   (ui.settings) this plugin's settings
//   notice.show  (notifications)  a short notice
// The theme's design tokens arrive as CSS custom properties (--piui-*) on the
// root element; data-appearance says "dark" or "light".
// See docs/PLUGINS.md and contracts/plugin-panel-v1.ts.
(function () {
  'use strict';
  var MARKER = 'piui-panel';
  var channel = null;
  var nextId = 1;
  var pending = new Map();
  var listeners = { theme: [], context: [] };
  var resolveReady;
  var ready = new Promise(function (resolve) {
    resolveReady = resolve;
  });

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    var root = document.documentElement;
    root.setAttribute('data-appearance', theme.appearance === 'light' ? 'light' : 'dark');
    var tokens = theme.tokens || {};
    Object.keys(tokens).forEach(function (name) {
      if (/^[a-z0-9-]+$/.test(name) && typeof tokens[name] === 'string') root.style.setProperty('--piui-' + name, tokens[name]);
    });
  }

  function post(message) {
    // The frame cannot know PiUI's origin; requests carry no secrets.
    window.parent.postMessage(Object.assign({ piui: MARKER, version: 1 }, message), '*');
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.piui !== MARKER || data.version !== 1) return;
    if (data.type === 'init') {
      channel = data.channel;
      applyTheme(data.theme);
      resolveReady(data);
      return;
    }
    if (data.channel !== channel) return;
    if (data.type === 'response') {
      var request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) {
        var error = new Error(data.error.message || data.error.code);
        error.code = data.error.code;
        request.reject(error);
      } else {
        request.resolve(data.result);
      }
    } else if (data.type === 'event') {
      if (data.event === 'theme') applyTheme(data.data);
      (listeners[data.event] || []).forEach(function (listener) {
        listener(data.data);
      });
    }
  });

  function request(method, params) {
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var id = 'r' + nextId++;
        pending.set(id, { resolve: resolve, reject: reject });
        post({ type: 'request', channel: channel, id: id, method: method, params: params });
      });
    });
  }

  window.piuiPanel = {
    /** Resolves with the init message: plugin, panel, permissions, theme, locale. */
    ready: ready,
    request: request,
    /** `theme` or `context`; returns an unsubscribe function. */
    on: function (event, listener) {
      if (!listeners[event]) return function () {};
      listeners[event].push(listener);
      return function () {
        listeners[event] = listeners[event].filter(function (item) {
          return item !== listener;
        });
      };
    },
    getContext: function () {
      return request('context.get');
    },
    runCommand: function (commandId) {
      return request('commands.run', { commandId: commandId });
    },
    getSettings: function () {
      return request('settings.get');
    },
    setSettings: function (values) {
      return request('settings.set', { values: values });
    },
    showNotice: function (message, level) {
      return request('notice.show', { message: message, level: level || 'info' });
    },
  };

  // Announce until PiUI answers (it may still be mounting the frame).
  var attempts = 0;
  function announce() {
    if (channel !== null || attempts++ >= 20) return;
    post({ type: 'ready' });
    setTimeout(announce, 500);
  }
  announce();
})();
