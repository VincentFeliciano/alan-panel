/* Snapshot shim — replaces every network call with the frozen payload that
   js/snapshot-data.js carries. Loaded as a classic script BEFORE the module,
   so the panel never sees a live socket. */
(function () {
  'use strict';
  var data = window.__SNAPSHOT__ || {};
  var at = window.__SNAPSHOT_AT__ || '';
  var realFetch = window.fetch.bind(window);

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function base(path) {
    try { return new URL(path, location.href).pathname; }
    catch (e) { return String(path).split('?')[0]; }
  }

  window.fetch = function (input, opts) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((opts && opts.method) || 'GET').toUpperCase();
    if (method !== 'GET') return Promise.resolve(json({ error: 'read-only snapshot' }, 503));
    var p = base(url);
    if (Object.prototype.hasOwnProperty.call(data, p)) return Promise.resolve(json(data[p]));
    // A conversation drill-down has no frozen text; an empty thread reads better
    // than an error box.
    if (p.indexOf('/conversation/') === 0) return Promise.resolve(json({ messages: [] }));
    return Promise.resolve(json({ error: 'not in snapshot' }, 404));
  };

  function banner() {
    var el = document.createElement('div');
    el.id = 'snapshotBanner';
    el.textContent = 'SNAPSHOT · ' + at + ' · read-only';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'top:0', 'transform:translateX(-50%)',
      'z-index:9999', 'padding:4px 14px', 'border-radius:0 0 8px 8px',
      'background:rgba(255,176,64,.14)', 'border:1px solid rgba(255,176,64,.45)',
      'border-top:0', 'color:#ffb040', 'font:11px/1.6 ui-monospace,monospace',
      'letter-spacing:.12em', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
  }

  function readOnly() {
    var cmd = document.getElementById('cmdInput');
    if (cmd) { cmd.disabled = true; cmd.placeholder = 'Snapshot — read only'; }
    ['sendBtn', 'micBtn', 'attachBtn', 'voiceBtn', 'sessionPick'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    var send = document.getElementById('sendBtn');
    if (send) send.style.opacity = '0.35';
  }

  // The panel repaints the link chip from its own state machine, which still
  // believes it is live. Rewriting it keeps us from claiming a connection we
  // do not have.
  function relabel() {
    var el = document.getElementById('linkState');
    if (!el) return;
    var txt = el.querySelector('.txt');
    if (txt && txt.textContent !== 'SNAPSHOT') txt.textContent = 'SNAPSHOT';
    el.dataset.state = 'stale';
  }

  function boot() {
    banner();
    readOnly();
    relabel();
    var el = document.getElementById('linkState');
    if (el && window.MutationObserver) {
      new MutationObserver(relabel).observe(el, { childList: true, subtree: true, characterData: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
