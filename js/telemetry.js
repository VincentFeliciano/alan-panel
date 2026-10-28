// Right column: compact instrumentation over verified runtime values.
//
// Discipline here: a field the runtime does not report renders as "not
// reported" in the dim style. It is never filled with a plausible number, and
// no metric is shown twice across cards.

import { state, subscribe, today, dayRoll, usageDaily, usageModels } from './store.js';

const cards = {};

function card(id, title) {
  const c = document.createElement('section');
  c.className = 'card';
  c.dataset.card = id;
  const h = document.createElement('h3');
  h.textContent = title;
  c.appendChild(h);
  const body = document.createElement('div');
  c.appendChild(body);
  return { root: c, body };
}

function kv(host, k, v, tone) {
  const row = document.createElement('div');
  row.className = 'kv';
  const kk = document.createElement('span');
  kk.className = 'k';
  kk.textContent = k;
  const vv = document.createElement('span');
  vv.className = 'v' + (tone ? ' ' + tone : '');
  vv.textContent = v;
  vv.title = String(v);
  row.append(kk, vv);
  host.appendChild(row);
  return vv;
}

function none(host, text) {
  const d = document.createElement('div');
  d.className = 'none';
  d.textContent = text;
  host.appendChild(d);
}

const bytes = (n) => {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return 'not reported';
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
};
const nfmt = (n) => {
  const v = Number(n);
  if (!isFinite(v)) return 'not reported';
  return v.toLocaleString('en-US');
};
const money = (n) => {
  const v = Number(n);
  if (!isFinite(v)) return 'not reported';
  return '$' + v.toFixed(2);
};
const tokens = (n) => {
  const v = Number(n);
  if (!isFinite(v)) return 'not reported';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
};
const at = (epoch) => {
  const v = Number(epoch);
  if (!isFinite(v) || v <= 0) return 'not reported';
  const d = new Date(v > 1e12 ? v : v * 1000);
  return d.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const ago = (epoch) => {
  const v = Number(epoch);
  if (!isFinite(v) || v <= 0) return 'not reported';
  const secs = Math.max(0, Date.now() / 1000 - (v > 1e12 ? v / 1000 : v));
  if (secs < 60) return Math.round(secs) + 's ago';
  if (secs < 3600) return Math.round(secs / 60) + 'm ago';
  if (secs < 86400) return Math.round(secs / 3600) + 'h ago';
  return Math.round(secs / 86400) + 'd ago';
};

/* ── individual cards ───────────────────────────────────────────────────── */
function paintExecution() {
  const b = cards.exec.body;
  b.textContent = '';
  const d = dayRoll();
  kv(b, 'tool runs (today)', d.toolRuns != null ? nfmt(d.toolRuns) : 'not reported');
  kv(b, 'succeeded', d.ok != null ? nfmt(d.ok) : 'not reported', 'ok');
  kv(b, 'failed', d.failed != null ? nfmt(d.failed) : 'not reported', d.failed ? 'err' : '');
  const rate = d.rate;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.dataset.tone = rate == null ? '' : rate >= 95 ? 'ok' : rate >= 80 ? 'warn' : 'err';
  const fill = document.createElement('i');
  fill.style.width = rate == null ? '0%' : Math.max(0, Math.min(100, rate)) + '%';
  bar.appendChild(fill);
  b.appendChild(bar);
  kv(b, 'success rate', rate == null ? 'not reported' : rate.toFixed(1) + '%',
     rate == null ? 'dimv' : rate >= 95 ? 'ok' : 'warn');
  const bg = ((state.activity && state.activity.background_tasks) || []).length;
  kv(b, 'background tasks', nfmt(bg));
}

function paintUsage() {
  const b = cards.usage.body;
  b.textContent = '';
  const t = today();
  kv(b, 'tokens (today)', tokens(t.tokens));
  kv(b, 'cost (today)', money(t.cost));
  kv(b, 'calls (today)', t.calls != null ? nfmt(t.calls) : 'not reported');

  const daily = usageDaily();
  if (daily.length) {
    const w = 260, h = 34;
    const vals = daily.map((d) => Number(d.tokens) || 0);
    const max = Math.max(1, ...vals);
    const pts = vals.map((v, i) => {
      const x = (i / Math.max(1, vals.length - 1)) * w;
      const y = h - (v / max) * (h - 3) - 1.5;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts.join(' '));
    svg.appendChild(poly);
    b.appendChild(svg);
    const cap = document.createElement('div');
    cap.className = 'kv';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'last ' + daily.length + ' days';
    cap.appendChild(k);
    b.appendChild(cap);
  } else {
    none(b, 'no daily usage reported');
  }
  const totals = (state.stats && state.stats.totals) || {};
  kv(b, 'tokens (all time)', tokens(totals.tokens));
  kv(b, 'cost (all time)', money(totals.cost));
}

function paintInfra() {
  const b = cards.infra.body;
  b.textContent = '';
  const db = (state.admin && state.admin.database) || {};
  kv(b, 'opencrabs.db', db.exists ? bytes(db.bytes) : 'missing', db.exists ? '' : 'err');
  kv(b, 'integrity', db.ok ? 'quick_check ok' : 'FAILED', db.ok ? 'ok' : 'err');
  kv(b, 'pages × size', db.pages != null ? nfmt(db.pages) + ' × ' + nfmt(db.page_size) : 'not reported');
  kv(b, 'WAL', db.wal_bytes != null ? bytes(db.wal_bytes) : 'not reported');

  const pdb = (state.admin && state.admin.panel_db) || {};
  kv(b, 'panel.db', pdb.exists ? bytes(pdb.bytes) + (pdb.ok ? ' · ok' : ' · FAILED') : 'missing',
     pdb.ok ? '' : 'err');

  const disk = (state.admin && state.admin.disk) || {};
  if (disk.total) {
    const usedPct = (Number(disk.used) / Number(disk.total)) * 100;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.dataset.tone = usedPct > 92 ? 'err' : usedPct > 80 ? 'warn' : 'ok';
    const fill = document.createElement('i');
    fill.style.width = Math.max(0, Math.min(100, usedPct)) + '%';
    bar.appendChild(fill);
    b.appendChild(bar);
    kv(b, 'disk free', bytes(disk.free) + ' of ' + bytes(disk.total),
       usedPct > 92 ? 'err' : usedPct > 80 ? 'warn' : '');
  } else {
    kv(b, 'disk free', 'not reported', 'dimv');
  }

  const logs = (state.admin && state.admin.logs) || {};
  kv(b, 'logs', logs.files != null ? nfmt(logs.files) + ' files · ' + bytes(logs.bytes) : 'not reported');
}

function paintAutomation() {
  const b = cards.auto.body;
  b.textContent = '';
  const c = (state.admin && state.admin.counts) || {};
  kv(b, 'cron jobs', c.cron_jobs != null ? nfmt(c.cron_jobs) : 'not reported');
  kv(b, 'enabled', c.cron_enabled != null ? nfmt(c.cron_enabled) : 'not reported',
     c.cron_enabled === c.cron_jobs && c.cron_jobs ? 'ok' : c.cron_enabled ? 'warn' : '');

  const jobs = ((state.cron && state.cron.jobs) || []).filter((j) => j && (j.name || j.id));
  if (!jobs.length) { none(b, 'no scheduled jobs reported'); return; }
  for (const j of jobs.slice(0, 5)) {
    const row = document.createElement('div');
    row.className = 'kv';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = String(j.name || j.id).slice(0, 22);
    const v = document.createElement('span');
    v.className = 'v' + (j.enabled === 0 ? ' dimv' : '');
    // next_run_at is not trusted: the runtime has been seen storing a sentinel.
    v.textContent = j.enabled === 0 ? 'disabled' : (j.schedule || j.cron || 'enabled');
    row.append(k, v);
    b.appendChild(row);
  }
}

function paintAlerts() {
  const b = cards.alerts.body;
  b.textContent = '';
  const host = document.createElement('div');
  host.className = 'alerts';
  const add = (sev, who, what) => {
    const a = document.createElement('div');
    a.className = 'alert';
    a.dataset.sev = sev;
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    const t = document.createElement('span');
    t.textContent = what;
    a.append(w, t);
    host.appendChild(a);
  };

  if (state.link === 'down') add('err', 'LINK', 'runtime unreachable');
  else if (state.link === 'stale') add('warn', 'LINK', 'no update for over 12s');

  const db = (state.admin && state.admin.database) || {};
  if (db.exists && db.ok === false) add('err', 'DB', 'integrity check failed');

  const disk = (state.admin && state.admin.disk) || {};
  if (disk.total) {
    const pct = (Number(disk.used) / Number(disk.total)) * 100;
    if (pct > 92) add('err', 'DISK', Math.round(pct) + '% used');
    else if (pct > 80) add('warn', 'DISK', Math.round(pct) + '% used');
  }

  const provs = ((state.admin && state.admin.providers && state.admin.providers.providers) || []);
  for (const p of provs) {
    if (p && p.consecutive_failures > 0) {
      add('warn', String(p.name || '?'), p.consecutive_failures + ' consecutive failure' +
          (p.consecutive_failures === 1 ? '' : 's'));
    }
  }

  const r = (state.admin && state.admin.runtime) || {};
  if (r.approval_set === false) add('ok', 'POLICY', 'approval policy at default');

  if (!host.children.length) add('ok', 'NOMINAL', 'no operational issues reported');
  b.appendChild(host);
}


function paintConfig() {
  const b = cards.config.body;
  b.textContent = '';
  const c = (state.admin && state.admin.config) || {};
  kv(b, 'config.toml', c.exists ? bytes(c.bytes) : 'missing', c.exists ? '' : 'err');
  kv(b, 'modified', c.modified ? at(c.modified) : 'not reported');
  // Presence only. The panel never receives a secret, so it cannot leak one.
  kv(b, 'keys.toml', c.keys_exists ? 'present' : 'absent', c.keys_exists ? 'ok' : 'err');
  kv(b, 'home', shortPath(state.admin && state.admin.home));
}

function shortPath(p) {
  if (!p) return 'not reported';
  const s = String(p);
  return s.length > 30 ? '…' + s.slice(-29) : s;
}

/* ── provider board ─────────────────────────────────────────────────────── */
// One hue per model, held in a module-level map so a model keeps its colour
// between polls (and between providers). The used-set keeps two models in the
// same provider row from landing on the same hue, which is the whole point of
// colouring them.
const MODEL_HUES = [72, 190, 265, 320, 45, 155, 210, 8, 285, 120];
const modelHue = new Map();
const usedHues = new Set();
function hueOf(name) {
  if (modelHue.has(name)) return modelHue.get(name);
  for (const h of MODEL_HUES) {
    if (!usedHues.has(h)) { modelHue.set(name, h); usedHues.add(h); return h; }
  }
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  while (usedHues.has(h)) h = (h + 37) % 360;
  modelHue.set(name, h); usedHues.add(h);
  return h;
}

// A failure count alone doesn't say whether a provider is down *right now* —
// it may have failed once last week and succeeded a hundred times since.
// "Down" means the most recent event was a failure, not merely that one ever
// happened. The label comes from the runtime's own error text; we only sort
// it into a few known buckets so the badge stays short.
function classifyDown(p) {
  const f = Number(p && p.consecutive_failures) || 0;
  if (!f) return null;
  const lastFail = Number(p.last_failure) || 0;
  const lastOk = Number(p.last_success) || 0;
  if (lastOk && lastOk >= lastFail) return null; // recovered since the last failure
  const s = String(p.last_error || '').toLowerCase();
  let label = 'FAILING';
  if (/rate limit/.test(s)) label = 'RATE LIMITED';
  else if (/credit|402/.test(s)) label = 'OUT OF CREDITS';
  else if (/no provider configured/.test(s)) label = 'NOT CONFIGURED';
  else if (/connect|refused|no connection/.test(s)) label = 'UNREACHABLE';
  return { label, since: lastFail, error: String(p.last_error || '') };
}

function paintProviders() {
  const b = cards.providers.body;
  b.textContent = '';

  // Health tells us which providers are configured and how they are failing;
  // usage tells us how much work each one actually did. The bar is drawn from
  // the second, because volume is the thing that grows.
  const health = ((state.admin && state.admin.providers && state.admin.providers.providers) || [])
    .filter((p) => p && p.name);
  const byProv = new Map();
  for (const m of usageModels()) {
    const key = String(m.provider || 'unreported');
    if (!byProv.has(key)) byProv.set(key, { tokens: 0, calls: 0, models: [] });
    const row = byProv.get(key);
    const tok = Number(m.tokens) || 0;
    row.tokens += tok;
    row.calls += Number(m.calls) || 0;
    row.models.push({ name: String(m.model || 'unreported'), tokens: tok });
  }
  const fails = new Map(health.map((p) => [String(p.name), Number(p.consecutive_failures) || 0]));
  const downByName = new Map(health.map((p) => [String(p.name), classifyDown(p)]));
  const names = [...new Set([...byProv.keys(), ...fails.keys()])];
  if (!names.length) { none(b, 'no providers reported'); return; }

  const busiest = Math.max(1, ...[...byProv.values()].map((v) => v.tokens));
  names.sort((x, y) => {
    const a = byProv.has(x) ? byProv.get(x).tokens : -1;
    const c = byProv.has(y) ? byProv.get(y).tokens : -1;
    return c - a || x.localeCompare(y);
  });

  for (const name of names.slice(0, 9)) {
    const u = byProv.get(name) || { tokens: 0, calls: 0, models: [] };
    const f = fails.get(name) || 0;
    const down = downByName.get(name);
    const row = document.createElement('div');
    row.className = 'prov';

    const head = document.createElement('div');
    head.className = 'prov-head';
    const nm = document.createElement('span');
    nm.className = 'prov-name';
    nm.textContent = name;
    head.appendChild(nm);
    if (down) {
      const badge = document.createElement('span');
      badge.className = 'prov-badge';
      badge.textContent = down.label;
      badge.title = (down.error || down.label) + ' · ' + (down.since ? ago(down.since) : 'time not reported');
      head.appendChild(badge);
    }
    const val = document.createElement('span');
    val.className = 'prov-val' + (f ? ' err' : u.tokens ? '' : ' dimv');
    const vol = u.tokens ? tokens(u.tokens) + ' · ' + nfmt(u.calls) + ' calls' : 'no usage';
    val.textContent = f ? vol + ' · ' + f + ' fail' + (f === 1 ? '' : 's') : vol;
    head.appendChild(val);
    row.appendChild(head);

    // Width is the provider's real volume against the busiest provider: the
    // bar grows as usage grows and stays empty when nothing has been recorded.
    // There is no quota or reset time in the runtime's own data, so the bar
    // never claims to show distance-to-limit — only recorded volume. A provider
    // that is down right now gets its bar painted full and red instead, which
    // is a state we *can* back with real data (last_failure after last_success).
    const share = u.tokens ? (u.tokens / busiest) * 100 : 0;
    const pct = down ? 100 : u.tokens ? Math.max(2, share) : 0;
    const track = document.createElement('div');
    track.className = 'rate-bar' + (down ? ' down' : '');
    track.title = down
      ? down.label + ' · ' + (down.since ? ago(down.since) : 'time not reported')
      : u.tokens
        ? tokens(u.tokens) + ' tokens · ' + share.toFixed(2) + '% of the busiest provider'
        : 'no usage recorded for this provider';
    const fill = document.createElement('i');
    fill.style.width = pct.toFixed(1) + '%';
    track.appendChild(fill);
    row.appendChild(track);

    // The same volume, split across the models that produced it.
    const ms = u.models.slice().sort((x, y) => y.tokens - x.tokens);
    if (ms.length) {
      const strip = document.createElement('div');
      strip.className = 'model-sub-bar';
      strip.style.width = pct.toFixed(1) + '%';
      for (const m of ms) {
        const seg = document.createElement('span');
        seg.className = 'model-bar';
        seg.style.flexGrow = String(Math.max(m.tokens, 1));
        seg.style.background = 'hsl(' + hueOf(m.name) + ' 88% 58%)';
        seg.title = m.name + ' · ' + tokens(m.tokens);
        strip.appendChild(seg);
      }
      row.appendChild(strip);
    }
    b.appendChild(row);
  }
}

export function init() {
  const host = document.getElementById('right');
  const defs = [
    ['providers', 'PROVIDERS'],
    ['exec', 'EXECUTION'],
    ['usage', 'USAGE'],
    ['infra', 'INFRASTRUCTURE'],
    ['auto', 'AUTOMATION'],
    ['alerts', 'ALERTS'],
    ['config', 'CONFIG FILES'],
  ];
  for (const [id, title] of defs) {
    const c = card(id, title);
    cards[id] = c;
    host.appendChild(c.root);
  }

  const painters = {
    providers: paintProviders,
    exec: paintExecution,
    usage: paintUsage,
    infra: paintInfra,
    auto: paintAutomation,
    alerts: paintAlerts,
    config: paintConfig,
  };
  const paint = () => {
    for (const [id, fn] of Object.entries(painters)) {
      try { fn(); } catch { none(cards[id].body, 'render error'); }
    }
  };

  subscribe((what) => { if (what === 'data' || what === 'link') paint(); });
  paint();
}
