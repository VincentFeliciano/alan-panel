// Left rail activity stream and the bottom timeline. Both are fed by the same
// normalised event list, so a row you click in one is the row highlighted in
// the other.
//
// Only real events appear. If the runtime reports nothing, both views say so
// instead of inventing a plausible-looking history.

import { state, subscribe } from './store.js';

let filter = 'all';
let seen = new Set();
let firstPaint = true;
let onPick = () => {};
let selectedId = null;

const pad = (n) => String(n).padStart(2, '0');
function hhmmss(ms) {
  if (!ms) return '--:--:--';
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function visible() {
  const all = state.events || [];
  if (filter === 'all') return all;
  if (filter === 'error') return all.filter((e) => e.sev === 'err');
  if (filter === 'cron') return all.filter((e) => e.kind === 'cron');
  if (filter === 'tool') return all.filter((e) => e.kind === 'tool');
  return all;
}

/* ── stream ─────────────────────────────────────────────────────────────── */
function renderStream() {
  const host = document.getElementById('stream');
  const rows = visible().slice(0, 90);
  host.textContent = '';

  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = state.link === 'down'
      ? 'NO CONNECTION — stream unavailable'
      : (filter === 'all'
          ? 'NO EVENTS REPORTED\nthe runtime has recorded nothing yet'
          : 'NOTHING MATCHES THIS FILTER');
    none.style.whiteSpace = 'pre-line';
    host.appendChild(none);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const e of rows) {
    const row = document.createElement('div');
    row.className = 'ev';
    row.dataset.sev = e.sev;
    row.dataset.id = e.id;
    if (!firstPaint && !seen.has(e.id)) row.classList.add('fresh');

    const t = document.createElement('div');
    t.className = 't';
    t.textContent = hhmmss(e.at);

    const body = document.createElement('div');
    body.className = 'body';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = e.label;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = e.text;
    d.title = e.text;
    body.append(k, d);

    row.append(t, body);
    row.addEventListener('click', () => { select(e.id); onPick(e); });
    frag.appendChild(row);
  }
  host.appendChild(frag);
  firstPaint = false;
  for (const e of rows) seen.add(e.id);
  if (seen.size > 600) seen = new Set(rows.map((e) => e.id));
}

/* ── timeline ───────────────────────────────────────────────────────────── */
function renderTimeline() {
  const host = document.getElementById('timeline');
  host.textContent = '';

  const rows = visible().slice(0, 70);
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'NO TIMELINE DATA';
    host.appendChild(none);
    return;
  }

  const axis = document.createElement('div');
  axis.className = 'axis';
  host.appendChild(axis);

  const times = rows.map((e) => e.at).filter((t) => t != null);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const span = Math.max(1, t1 - t0);
  const width = host.clientWidth || 900;
  const padL = 46, padR = 46;

  for (const e of rows) {
    if (e.at == null) continue;
    const x = padL + ((e.at - t0) / span) * (width - padL - padR);
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.dataset.sev = e.sev;
    tick.dataset.id = e.id;
    if (e.id === selectedId) tick.classList.add('sel');
    tick.style.left = Math.round(x) + 'px';
    tick.title = hhmmss(e.at) + '  ' + e.label + ' — ' + e.text;
    tick.addEventListener('click', () => { select(e.id); onPick(e); });
    host.appendChild(tick);
  }

  const l = document.createElement('div');
  l.className = 'lab';
  l.style.left = '8px';
  l.textContent = hhmmss(t0);
  const r = document.createElement('div');
  r.className = 'lab';
  r.style.right = '8px';
  r.textContent = hhmmss(t1);
  host.append(l, r);
}

/* ── selection ──────────────────────────────────────────────────────────── */
function select(id) {
  selectedId = id;
  for (const row of document.querySelectorAll('#stream .ev')) {
    row.style.background = row.dataset.id === id ? 'rgba(221,255,0,.09)' : '';
  }
  for (const tick of document.querySelectorAll('#timeline .tick')) {
    tick.classList.toggle('sel', tick.dataset.id === id);
  }
}

/* ── public ─────────────────────────────────────────────────────────────── */
export function init(pickHandler) {
  onPick = pickHandler || (() => {});

  const chips = document.getElementById('streamFilters');
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    filter = b.dataset.kind;
    for (const c of chips.querySelectorAll('button')) c.classList.toggle('on', c === b);
    firstPaint = true;
    renderStream();
    renderTimeline();
  });

  window.addEventListener('resize', () => renderTimeline());
  subscribe((what) => {
    if (what !== 'data') return;
    renderStream();
    renderTimeline();
  });
  renderStream();
  renderTimeline();
}

export function redraw() { renderStream(); renderTimeline(); }
