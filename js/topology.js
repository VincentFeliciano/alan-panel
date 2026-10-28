// The intelligence core: a node-and-connection map of the runtime.
//
// Every node is an entity the runtime actually reports — a session, a tool that
// has really run, a provider that is really configured, a cron job that really
// exists. Every edge is a relation proven by the data (this session ran this
// tool; this session used this provider). Nothing is placed to fill space.
//
// Layout is deterministic: angle comes from the entity's index in its ring, so
// a refresh does not make the map jump around while you are reading it.

import { state, subscribe, sessionActive, counts, liveTool } from './store.js';

const NS = 'http://www.w3.org/2000/svg';
const MAX_SESSIONS = 9;
const MAX_TOOLS = 11;

let svg = null;
let stage = null;
let inspectorEl = null;
let gRoot = null;
let gLinks = null;
let gFlow = null;
let gNodes = null;

const view = { x: 0, y: 0, k: 1 };
let selected = null;
let lastSig = '';
// Live element records, keyed by entity id / edge key. render() reconciles
// against these instead of tearing the layer down, because a rebuilt <g> is a
// brand-new element to CSS: its animation starts over at the negative-delay
// phase, so every orb snaps back to the same spot on every poll. Reuse is what
// makes the float continuous across a refresh.
const nodeEls = new Map();
const linkEls = new Map();

const el = (name, attrs) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  return n;
};

/* ── graph construction ─────────────────────────────────────────────────── */
function buildGraph() {
  const nodes = [];
  const links = [];
  const byId = new Map();

  const sessions = (state.sessions || []).slice()
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, MAX_SESSIONS);

  // Tool frequency over the activity window the runtime returned.
  const toolCount = new Map();
  const sessionTools = new Map(); // session id -> Set(tool)
  for (const e of ((state.activity && state.activity.tool_executions) || [])) {
    const name = e && e.tool_name;
    if (!name) continue;
    toolCount.set(name, (toolCount.get(name) || 0) + 1);
    if (e.session_id) {
      if (!sessionTools.has(e.session_id)) sessionTools.set(e.session_id, new Set());
      sessionTools.get(e.session_id).add(name);
    }
  }
  const tools = [...toolCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOOLS);

  // The tool that is working right now gets a node whether or not it made the
  // frequency cut. A glow on an absent node is a glow you never see, and the
  // one thing the map must never do is hide the live call.
  const live = liveTool();
  if (live && !tools.some(([name]) => name === live.name)) {
    tools.pop();
    tools.push([live.name, toolCount.get(live.name) || 1]);
  }

  const providers = [];
  const seenProv = new Set();
  for (const s of sessions) {
    if (s.provider && !seenProv.has(s.provider)) { seenProv.add(s.provider); providers.push(s.provider); }
  }
  const provHealth = ((state.admin && state.admin.providers && state.admin.providers.providers) || [])
    .filter((p) => p && p.name);

  const jobs = ((state.cron && state.cron.jobs) || []).filter((j) => j && (j.name || j.id));

  // — sessions: inner ring ————————————————————————————————————————————
  const nS = Math.max(sessions.length, 1);
  sessions.forEach((s, i) => {
    const a = (i / nS) * Math.PI * 2 - Math.PI / 2;
    const active = sessionActive(s);
    const id = 'session:' + s.id;
    byId.set(id, true);
    nodes.push({
      id, type: 'session',
      state: active ? 'active' : 'idle',
      label: short(s.title || s.id),
      r: 15 + Math.min(9, Math.log2((s.message_count || 1) + 1)),
      angle: a, ring: 0,
      detail: {
        'session': s.id,
        'title': s.title || '—',
        'provider': s.provider || '—',
        'model': s.model || '—',
        'messages': s.message_count != null ? String(s.message_count) : '—',
        'tokens': s.token_count != null ? fmt(s.token_count) : '—',
        'cost': s.total_cost != null ? '$' + Number(s.total_cost).toFixed(2) : '—',
        'updated': s.updated_at ? ago(s.updated_at) : '—',
        'category': s.category || '—',
      },
      raw: s,
    });
  });

  // — tools: middle ring ——————————————————————————————————————————————
  const nT = Math.max(tools.length, 1);
  tools.forEach(([name, n], i) => {
    const a = (i / nT) * Math.PI * 2 - Math.PI / 2 + 0.35;
    const id = 'tool:' + name;
    nodes.push({
      id, type: 'tool',
      state: n > 0 ? 'active' : 'idle',
      label: name,
      r: 9 + Math.min(9, Math.log2(n + 1) * 2),
      angle: a, ring: 1,
      detail: {
        'tool': name,
        'recent runs': String(n),
        'window': 'last ' + ((state.activity && state.activity.tool_executions) || []).length + ' executions',
      },
      raw: { name, n },
    });
  });

  // — providers: outer ring ————————————————————————————————————————————
  const nP = Math.max(providers.length, 1);
  providers.forEach((p, i) => {
    const a = (i / nP) * Math.PI * 2 - Math.PI / 2 + 0.8;
    const h = provHealth.find((x) => x.name === p);
    const fails = h && typeof h.consecutive_failures === 'number' ? h.consecutive_failures : null;
    nodes.push({
      id: 'provider:' + p, type: 'provider',
      state: fails && fails > 0 ? 'failed' : 'active',
      label: p, r: 13, angle: a, ring: 2,
      detail: {
        'provider': p,
        'consecutive failures': fails == null ? 'not reported' : String(fails),
        'health source': h ? 'provider_health.json' : 'not reported',
      },
      raw: { name: p, fails },
    });
  });

  // — cron: outer ring, offset ————————————————————————————————————————
  const nC = Math.max(jobs.length, 1);
  jobs.forEach((j, i) => {
    const a = (i / nC) * Math.PI * 2 - Math.PI / 2 + 2.1;
    const id = 'cron:' + (j.id || j.name);
    nodes.push({
      id, type: 'cron',
      state: j.enabled === 0 ? 'idle' : 'active',
      label: short(j.name || j.id),
      r: 10, angle: a, ring: 3,
      detail: {
        'job': j.name || j.id || '—',
        'schedule': j.schedule || j.cron || '—',
        'enabled': j.enabled === 0 ? 'no' : 'yes',
        'last run': j.last_run_at || 'not reported',
      },
      raw: j,
    });
  });

  // — edges: only relations the data proves ——————————————————————————
  const toolIds = new Set(tools.map(([n]) => 'tool:' + n));
  for (const s of sessions) {
    const sid = 'session:' + s.id;
    const used = sessionTools.get(s.id);
    if (used) {
      for (const t of used) {
        const tid = 'tool:' + t;
        if (toolIds.has(tid)) links.push({ a: sid, b: tid });
      }
    }
    if (s.provider && providers.includes(s.provider)) {
      links.push({ a: sid, b: 'provider:' + s.provider });
    }
  }

  return { nodes, links, byId };
}

function short(s, n = 18) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
// A stable 32-bit hash of a string. Used for per-entity motion parameters, so
// the drift is varied but reproducible: the same node always moves the same
// way, and a re-render never reshuffles it.
function hashOf(s) {
  let h = 2166136261;
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
function fmt(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}
function ago(epochSec) {
  const d = Math.max(0, Date.now() / 1000 - Number(epochSec));
  if (d < 60) return Math.round(d) + 's ago';
  if (d < 3600) return Math.round(d / 60) + 'm ago';
  if (d < 86400) return Math.round(d / 3600) + 'h ago';
  return Math.round(d / 86400) + 'd ago';
}

/* ── geometry ───────────────────────────────────────────────────────────── */
function radiusFor(ring) {
  const w = stage.clientWidth || 800;
  const h = stage.clientHeight || 600;
  const base = Math.min(w, h) / 2;
  return [base * 0.40, base * 0.66, base * 0.88, base * 0.88][Math.min(ring, 3)] || base * 0.4;
}

function place(node) {
  const r = radiusFor(node.ring) * (node.ring === 3 ? 1.0 : 1);
  const cx = (stage.clientWidth || 800) / 2;
  const cy = (stage.clientHeight || 600) / 2;
  node.x = cx + Math.cos(node.angle) * r;
  node.y = cy + Math.sin(node.angle) * r;
  return node;
}

/* ── render ─────────────────────────────────────────────────────────────── */
function render() {
  const graph = buildGraph();
  const sig = graph.nodes.map((n) => n.id + ':' + n.state + ':' + Math.round(n.r)).join('|');
  const structural = sig !== lastSig;
  lastSig = sig;

  graph.nodes.forEach(place);
  const pos = new Map(graph.nodes.map((n) => [n.id, n]));

  // ── edges: reconcile by pair, never rebuild the layer ────────────────
  // No layer wipe here. Clearing gLinks while linkEls still held the elements
  // detached them for good: the reconcile loop then updated attributes on an
  // orphan, so the map lost its lines on the second render and never got them
  // back. Removal is done per stale key, below.
  const linkSeen = new Set();
  for (const l of graph.links) {
    const a = pos.get(l.a), b = pos.get(l.b);
    if (!a || !b) continue;
    const key = l.a + '|' + l.b;
    if (linkSeen.has(key)) continue;
    linkSeen.add(key);
    let rec = linkEls.get(key);
    if (!rec) {
      const line = el('line', { class: 'link', 'data-a': l.a, 'data-b': l.b });
      // The traffic layer: the same segment drawn as a dashed stroke over the
      // faint solid one. A dash pattern with a falling offset walks the marks
      // from the tail to the head of the line, so the dashes themselves are the
      // direction of travel: source at the start, target at the end.
      const flow = el('line', { class: 'flow', 'data-a': l.a, 'data-b': l.b });
      const h = hashOf(key);
      flow.style.setProperty('--fdur', (1.05 + (h % 7) * 0.22).toFixed(2) + 's');
      flow.style.setProperty('--fdelay', (-(h % 31) * 0.09).toFixed(2) + 's');
      gFlow.appendChild(flow);
      gLinks.appendChild(line);
      rec = { line, flow };
      linkEls.set(key, rec);
    }
    for (const e of [rec.line, rec.flow]) {
      e.setAttribute('x1', a.x.toFixed(1));
      e.setAttribute('y1', a.y.toFixed(1));
      e.setAttribute('x2', b.x.toFixed(1));
      e.setAttribute('y2', b.y.toFixed(1));
    }
    const hot = a.state === 'active' || b.state === 'active';
    rec.line.classList.toggle('hot', hot);
    rec.flow.classList.toggle('hot', hot);
  }
  for (const [key, rec] of linkEls) {
    if (linkSeen.has(key)) continue;
    rec.line.remove();
    rec.flow.remove();
    linkEls.delete(key);
  }

  // ── nodes: reuse the existing <g> for an id, build only what is new ──
  const nodeSeen = new Set();
  for (const n of graph.nodes) {
    nodeSeen.add(n.id);
    let rec = nodeEls.get(n.id);
    if (rec) {
      rec.node = n;
      rec.g.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      rec.g.setAttribute('data-state', n.state);
      rec.g.setAttribute('data-label', n.label);
      rec.g.classList.toggle('sel', selected === n.id);
      if (rec.label !== n.label) { rec.cap.textContent = n.label; rec.label = n.label; }
      if (rec.r !== n.r) {
        rec.r = n.r;
        rec.ring.setAttribute('r', n.r + 13);
        rec.halo.setAttribute('r', n.r + 6);
        rec.core.setAttribute('r', n.r);
        rec.cap.setAttribute('y', n.r + 13);
      }
      continue;
    }

    const g = el('g', {
      class: 'node',
      'data-type': n.type,
      'data-state': n.state,
      'data-id': n.id,
      'data-label': n.label,
      transform: `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`,
    });
    if (selected === n.id) g.classList.add('sel');

// The orb is halo + core together, so they drift as one body. Two nested
    // groups carry the two motions, because one element executes one transform
    // animation: the outer drifts the whole body on a shallow closed ellipse —
    // suspended in space rather than bobbing on a string — and the inner
    // breathes it in and out, which is the pulse you see at rest. Amplitude,
    // period and phase all come from a hash of the entity id: deterministic,
    // so a refresh never reshuffles the motion, and stable per entity so the
    // same session always floats the same way.
    const h = hashOf(n.id);
    const orb = el('g', { class: 'orb' });
    // Amplitude roughly doubled from the first pass. A 4px drift over ten
    // seconds is mathematically motion and visually a still image; these read
    // as floating from across the room, which is the only place that counts.
    //
    // The period is derived from the ellipse rather than hashed independently.
    // A fixed period makes a wide orb fast and a narrow one slow, and the wide
    // ones then cross 2px per 250ms frame: mathematically a glide, visually a
    // step. Scaling the period with the ellipse's own size holds every orb to
    // the same peak speed, so the widest drift is as smooth as the tightest.
    const ax = 9.0 + (h % 4) * 2.2;
    const ay = 7.0 + (h % 6) * 1.7;
    const PEAK_PX_PER_S = 7.0;
    const dur = (6 * Math.hypot(0.85 * ax, ay) / PEAK_PX_PER_S) * (0.95 + (h % 5) * 0.025);
    orb.style.setProperty('--ampx', ax.toFixed(2) + 'px');
    orb.style.setProperty('--ampy', ay.toFixed(2) + 'px');
    orb.style.setProperty('--dur', dur.toFixed(2) + 's');
    orb.style.setProperty('--delay', (-(h % 23) * 0.41).toFixed(2) + 's');

    const inner = el('g', { class: 'orbIn' });
    inner.style.setProperty('--smin', (0.855 - (h % 3) * 0.014).toFixed(3));
    inner.style.setProperty('--smax', (1.13 + (h % 4) * 0.018).toFixed(3));
    inner.style.setProperty('--pdur', (3.4 + (h % 5) * 0.48).toFixed(2) + 's');
    inner.style.setProperty('--pdelay', (-(h % 17) * 0.29).toFixed(2) + 's');

    // The halo's own glow breathe: a third clock, so the light never pulses in
    // step with the body it belongs to.
    orb.style.setProperty('--bdur', (4.4 + (h % 7) * 0.46).toFixed(2) + 's');
    orb.style.setProperty('--bdelay', (-(h % 19) * 0.33).toFixed(2) + 's');

    // The ring sits behind the halo and stays invisible until this entity is
    // the one working; it is the glow's own geometry, not a decoration.
    const ring = el('circle', { class: 'ring', r: n.r + 13 });
    const halo = el('circle', { class: 'halo', r: n.r + 6 });
    const core = el('circle', { class: 'core', r: n.r });
    inner.appendChild(ring);
    inner.appendChild(halo);
    inner.appendChild(core);
    orb.appendChild(inner);
    g.appendChild(orb);

    const cap = el('text', { class: 'cap', x: 0, y: n.r + 13, 'text-anchor': 'middle' });
    cap.textContent = n.label;
    g.appendChild(cap);

    const title = el('title');
    title.textContent = n.type + ' · ' + n.label;
    g.appendChild(title);

    // The record, not the closure's `n`: the element outlives this graph
    // object, so the handler must read whichever node is current.
    rec = { g, orb, inner, cap, ring, halo, core, r: n.r, label: n.label, node: n };
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const cur = rec.node;
      selected = selected === cur.id ? null : cur.id;
      paintSelection();
      showInspector(cur);
    });
    gNodes.appendChild(g);
    nodeEls.set(n.id, rec);
  }

  for (const [id, rec] of nodeEls) {
    if (nodeSeen.has(id)) continue;
    rec.g.remove();
    nodeEls.delete(id);
  }

  if (!graph.nodes.length) {
    stage.querySelector('#coreEmpty').hidden = false;
    stage.querySelector('#coreEmpty').textContent = '';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = 'NO ENTITIES REPORTED';
    stage.querySelector('#coreEmpty').append(big);
  } else {
    stage.querySelector('#coreEmpty').hidden = true;
  }

  if (structural) pulseActivity(graph);
  paintLive();
  applyView();
}

// A single travelling light per newly-arrived edge. Driven by a real event
// count change, never on a timer.
let lastToolCount = -1;
function pulseActivity(graph) {
  const total = ((state.activity && state.activity.tool_executions) || []).length;
  if (lastToolCount < 0) { lastToolCount = total; return; }
  if (total === lastToolCount) return;
  lastToolCount = total;

  const hot = graph.links.slice(0, 6);
  for (const l of hot) {
    const a = graph.nodes.find((n) => n.id === l.a);
    const b = graph.nodes.find((n) => n.id === l.b);
    if (!a || !b) continue;
    const dot = el('circle', { class: 'pulse go', r: 2.6, cx: a.x, cy: a.y });
    const anim = el('animateMotion', {
      dur: '1.15s', fill: 'freeze', path: `M${a.x},${a.y} L${b.x},${b.y}`,
    });
    dot.appendChild(anim);
    gLinks.appendChild(dot);
    setTimeout(() => dot.remove(), 1250);
  }
}

function paintSelection() {
  for (const g of gNodes.children) {
    g.classList.toggle('sel', g.getAttribute('data-id') === selected);
  }
  if (!selected) inspectorEl.hidden = true;
}

/* ── live tool glow ─────────────────────────────────────────────────────── */
// The database records a tool when it FINISHES, so "running" is inferred: the
// newest row is the best evidence of what is working, and it stays lit for
// twenty seconds before we admit we no longer know. paintLive runs on every
// render and on its own short tick, because a glow that only updates on a five
// second poll would arrive already stale and linger past the truth.
function paintLive() {
  const live = liveTool();
  const id = live ? 'tool:' + live.name : null;
  for (const g of gNodes.children) {
    const on = id !== null && g.getAttribute('data-id') === id;
    if (on) {
      g.setAttribute('data-live', '1');
      g.setAttribute('data-live-label', live.name);
      g.setAttribute('data-live-age', String(Math.round(live.ageMs / 1000)));
    } else if (g.hasAttribute('data-live')) {
      g.removeAttribute('data-live');
      g.removeAttribute('data-live-label');
      g.removeAttribute('data-live-age');
    }
  }
  for (const l of gLinks.querySelectorAll('line.link')) {
    const on = id !== null && (l.getAttribute('data-a') === id || l.getAttribute('data-b') === id);
    l.classList.toggle('live', on);
  }
}

/* ── inspector ──────────────────────────────────────────────────────────── */
function showInspector(node) {
  if (!node) { inspectorEl.hidden = true; return; }
  inspectorEl.textContent = '';
  inspectorEl.hidden = false;

  const head = document.createElement('div');
  head.className = 'ih';
  const nm = document.createElement('div');
  nm.className = 'iname';
  nm.textContent = node.label;
  const x = document.createElement('button');
  x.className = 'ix';
  x.type = 'button';
  x.textContent = '×';
  x.title = 'close';
  x.addEventListener('click', () => { selected = null; paintSelection(); });
  head.append(nm, x);
  inspectorEl.appendChild(head);

  const type = document.createElement('div');
  type.className = 'label';
  type.textContent = node.type + ' · ' + node.state;
  inspectorEl.appendChild(type);

  const dl = document.createElement('dl');
  for (const [k, v] of Object.entries(node.detail || {})) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v == null ? '—' : String(v);
    dl.append(dt, dd);
  }
  inspectorEl.appendChild(dl);
}

/* ── pan / zoom ─────────────────────────────────────────────────────────── */
function applyView() {
  gRoot.setAttribute('transform', `translate(${view.x.toFixed(2)},${view.y.toFixed(2)}) scale(${view.k.toFixed(3)})`);
}

function bindControls() {
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    dragging = true; stage.classList.add('grabbing');
    sx = e.clientX; sy = e.clientY; ox = view.x; oy = view.y;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    view.x = ox + (e.clientX - sx);
    view.y = oy + (e.clientY - sy);
    applyView();
  });
  const stop = () => { dragging = false; stage.classList.remove('grabbing'); };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k2 = Math.max(0.35, Math.min(3.5, view.k * factor));
    // keep the point under the cursor fixed
    view.x = mx - (mx - view.x) * (k2 / view.k);
    view.y = my - (my - view.y) * (k2 / view.k);
    view.k = k2;
    applyView();
  }, { passive: false });

  stage.addEventListener('click', (e) => {
    if (e.target.closest('.node')) return;
    selected = null;
    paintSelection();
  });
}

function zoomBy(f) {
  const w = stage.clientWidth || 800, h = stage.clientHeight || 600;
  const k2 = Math.max(0.35, Math.min(3.5, view.k * f));
  view.x = w / 2 - (w / 2 - view.x) * (k2 / view.k);
  view.y = h / 2 - (h / 2 - view.y) * (k2 / view.k);
  view.k = k2;
  applyView();
}

/* ── ambient layer ──────────────────────────────────────────────────────── */
// Drifting motes for depth. Purely atmospheric, tied to no data, and switched
// off entirely under prefers-reduced-motion.
function startAmbient(canvas) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, motes = [];
  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    motes = Array.from({ length: 46 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12,
      r: Math.random() * 1.3 + 0.4, a: Math.random() * 0.32 + 0.08,
    }));
  };
  fit();
  window.addEventListener('resize', fit);

  let raf = 0;
  const step = () => {
    ctx.clearRect(0, 0, w, h);
    for (const m of motes) {
      m.x += m.vx; m.y += m.vy;
      if (m.x < -10) m.x = w + 10; if (m.x > w + 10) m.x = -10;
      if (m.y < -10) m.y = h + 10; if (m.y > h + 10) m.y = -10;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(221,255,0,' + m.a.toFixed(3) + ')';
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(step);
  });
}

/* ── public ─────────────────────────────────────────────────────────────── */
export function init() {
  svg = document.getElementById('topology');
  stage = document.getElementById('stage');
  inspectorEl = document.getElementById('inspector');
  const canvas = document.getElementById('ambient');

  gRoot = el('g', {});
  gLinks = el('g', {});
  gFlow = el('g', {});
  gNodes = el('g', {});
  gRoot.append(gLinks, gFlow, gNodes);
  svg.appendChild(gRoot);

  bindControls();
  startAmbient(canvas);

  document.getElementById('zoomIn').addEventListener('click', () => zoomBy(1.18));
  document.getElementById('zoomOut').addEventListener('click', () => zoomBy(1 / 1.18));
  document.getElementById('zoomReset').addEventListener('click', () => {
    view.x = 0; view.y = 0; view.k = 1; applyView();
  });

  window.addEventListener('resize', () => { render(); });

  subscribe((what) => { if (what === 'data') render(); });
  render();
  // The glow decays on its own clock. The activity poll runs every five
  // seconds; twenty seconds of licence is four polls of slack, and without a
  // faster tick the ring would sit on a tool that finished half a poll ago.
  setInterval(paintLive, 2000);
}

export function selectEntity(id) {
  selected = id;
  paintSelection();
}
