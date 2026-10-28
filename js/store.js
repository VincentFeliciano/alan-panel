// Data layer. One poller, one state object, one set of subscribers.
//
// Rules this file enforces:
//  * Every value rendered by the UI originates here, from a real endpoint.
//    Nothing is synthesised. A field the runtime does not provide stays null
//    and the view renders "not reported" rather than a guess.
//  * Responses are validated on arrival. A malformed body degrades that one
//    panel; it never throws into the render path.
//  * Staleness is explicit. If polls stop succeeding the link goes stale, then
//    down, and the views dim instead of showing old numbers as if they were
//    current.

const POLL_MS = 5000;
const STALE_AFTER_MS = 12000;

export const state = {
  link: 'connecting',       // connecting | live | stale | down
  lastOk: 0,                // ms epoch of the last fully successful poll
  health: null,
  admin: null,
  stats: null,
  sessions: [],
  activity: null,
  tools: null,
  cron: null,
  usage: null,
  errors: [],
  events: [],               // normalised, newest first
  lastError: '',
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function emit(what) { for (const fn of subs) { try { fn(what); } catch { /* a broken view must not stop the others */ } } }

/* ── validation helpers ─────────────────────────────────────────────────── */
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const dig = (o, ...path) => {
  let cur = o;
  for (const k of path) { if (!isObj(cur)) return null; cur = cur[k]; }
  return cur === undefined ? null : cur;
};

async function jget(path) {
  const r = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(path + ' → HTTP ' + r.status);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error(path + ' → not JSON'); }
}

/* ── event normalisation ────────────────────────────────────────────────── */
// The runtime timestamps rows as "YYYY-MM-DD HH:MM:SS" in local time. Parse
// defensively: an unparseable stamp yields null and the row sorts last rather
// than pretending to be from 1970.
function when(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return isFinite(t) ? t : null;
}

function buildEvents(a) {
  const out = [];
  for (const e of arr(a && a.tool_executions).slice(0, 120)) {
    if (!isObj(e)) continue;
    const ok = e.status === 'success';
    out.push({
      id: 'tool:' + (str(e.id) || Math.random()),
      kind: 'tool',
      sev: ok ? 'ok' : 'err',
      at: when(e.at),
      raw_at: str(e.at),
      label: ok ? 'TOOL OK' : 'TOOL FAIL',
      text: (str(e.tool_name) || 'unknown tool') +
            (num(e.duration_ms) != null ? ' · ' + num(e.duration_ms) + 'ms' : ''),
      session: str(e.session_id),
      entity: str(e.tool_name),
      data: e,
    });
  }
  for (const c of arr(a && a.cron_runs).slice(0, 40)) {
    if (!isObj(c)) continue;
    out.push({
      id: 'cron:' + (str(c.id) || Math.random()),
      kind: 'cron', sev: c.status === 'success' ? 'ok' : 'warn',
      at: when(c.at || c.ran_at), raw_at: str(c.at || c.ran_at),
      label: 'CRON', text: str(c.job_name) || str(c.name) || 'scheduled job',
      session: null, entity: str(c.job_name) || str(c.name), data: c,
    });
  }
  for (const x of arr(a && a.errors).slice(0, 60)) {
    if (!isObj(x)) continue;
    out.push({
      id: 'err:' + (str(x.id) || Math.random()),
      kind: 'error', sev: 'err',
      at: when(x.at), raw_at: str(x.at),
      label: 'ERROR',
      text: str(x.message) || str(x.error) || str(x.kind) || 'runtime error',
      session: str(x.session_id), entity: str(x.tool_name), data: x,
    });
  }
  for (const t of arr(a && a.background_tasks).slice(0, 40)) {
    if (!isObj(t)) continue;
    out.push({
      id: 'task:' + (str(t.id) || Math.random()),
      kind: 'task', sev: t.status === 'error' ? 'err' : 'info',
      at: when(t.started_at || t.at), raw_at: str(t.started_at || t.at),
      label: 'TASK', text: (str(t.label) || str(t.kind) || 'background task') +
            (str(t.status) ? ' · ' + str(t.status) : ''),
      session: str(t.session_id), entity: str(t.label), data: t,
    });
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out.slice(0, 200);
}

/* ── polling ────────────────────────────────────────────────────────────── */
let timer = null;
let inFlight = false;

async function poll() {
  if (inFlight) return;
  inFlight = true;
  let anyOk = false;
  const grab = async (key, path) => {
    try {
      const v = await jget(path);
      state[key] = v;
      anyOk = true;
    } catch (err) {
      state.lastError = String(err && err.message || err);
    }
  };

  try {
    // Parallel, but each endpoint fails alone: losing /api/usage must not
    // blank the topology.
    await Promise.all([
      grab('health', '/health'),
      grab('admin', '/api/admin'),
      grab('stats', '/api/stats'),
      grab('activity', '/api/activity'),
      grab('tools', '/api/tools'),
      grab('cron', '/api/cron'),
      grab('usage', '/api/usage'),
      grab('errors', '/api/errors'),
    ]);

    try {
      const s = await jget('/api/sessions?limit=40');
      state.sessions = arr(s && s.sessions).filter(isObj);
      anyOk = true;
    } catch (err) { state.lastError = String(err && err.message || err); }

    state.events = buildEvents(state.activity);
    state.errors = arr(dig(state, 'errors', 'errors'));

    const now = Date.now();
    if (anyOk) {
      state.lastOk = now;
      state.link = 'live';
      state.lastError = '';
    } else {
      state.link = 'down';
    }
  } finally {
    inFlight = false;
  }

  emit('data');
}

// A separate, cheap watchdog so the header can go stale without waiting for a
// fetch that may itself be hanging.
function watchdog() {
  if (state.link === 'live' && Date.now() - state.lastOk > STALE_AFTER_MS) {
    state.link = 'stale';
    emit('link');
  }
}

export function start() {
  poll();
  if (timer) clearInterval(timer);
  timer = setInterval(poll, POLL_MS);
  setInterval(watchdog, 2000);
  window.addEventListener('online', () => { state.link = 'connecting'; emit('link'); poll(); });
  window.addEventListener('offline', () => { state.link = 'down'; emit('link'); });
}

export function refresh() { return poll(); }

/* ── derived views over real data ───────────────────────────────────────── */
export function version() { return str(dig(state, 'health', 'version')); }
export function agentPath() { return str(dig(state, 'health', 'agent')); }
export function port() { return num(dig(state, 'health', 'port')); }

export function counts() {
  const c = dig(state, 'stats', 'counts');
  return {
    sessions: num(dig(c, 'sessions')),
    messages: num(dig(c, 'messages')),
    tools: num(dig(c, 'tool_executions')),
    cron: num(dig(c, 'cron_jobs')),
    channel: num(dig(c, 'channel_messages')),
    files: num(dig(c, 'files')),
  };
}

export function today() {
  const t = dig(state, 'stats', 'today');
  return { tokens: num(dig(t, 'tokens')), cost: num(dig(t, 'cost')), calls: num(dig(t, 'calls')) };
}

export function dayRoll() {
  const d = dig(state, 'stats', 'day');
  return {
    toolRuns: num(dig(d, 'tool_runs')),
    ok: num(dig(d, 'tool_ok')),
    failed: num(dig(d, 'tool_failed')),
    rate: num(dig(d, 'success_rate')),
    tokens: num(dig(d, 'tokens')),
    cost: num(dig(d, 'cost')),
  };
}

// A session is "active" if it has moved within the last ten minutes. This is a
// derivation of real timestamps, not a status the runtime hands us.
export function sessionActive(s) {
  const u = num(s && s.updated_at);
  return u != null && Date.now() / 1000 - u < 600;
}

// Which tool is working right now.
//
// The runtime writes a tool_executions row when the call FINISHES, so there is
// no "running" flag to read and inventing one would be a lie. What is true is
// freshness: while the agent works, rows land every few seconds, so the newest
// row is the tool it is using at this moment. Past the window it stops being
// evidence of anything and the glow is dropped rather than left burning.
export const LIVE_TOOL_MS = 20000;

export function liveTool() {
  const rows = arr(dig(state, 'activity', 'tool_executions'));
  for (const e of rows) {
    if (!isObj(e)) continue;
    const name = str(e.tool_name);
    if (!name) continue;
    const at = when(e.at);
    if (at == null) continue;
    const age = Date.now() - at;
    // A stamp from the future is a clock skew, not a live call.
    if (age < -2000 || age > LIVE_TOOL_MS) return null;
    return { name, at, ageMs: age, status: str(e.status), session: str(e.session_id) };
  }
  return null;
}

export function usageDaily() {
  return arr(dig(state, 'usage', 'daily'))
    .filter((d) => isObj(d) && num(d.tokens) != null)
    .slice(0, 14)
    .reverse();
}

// Per provider/model usage rows, as the runtime reports them. The provider
// board sizes every bar from these numbers: the width is real volume, never a
// status flag dressed up as a meter.
export function usageModels() {
  return arr(dig(state, 'usage', 'models'))
    .filter((m) => isObj(m) && num(m.tokens) != null);
}
