// Wiring. Owns the header strip, the clock, the link indicator, and the command
// composer. Nothing here reaches past the panel's own HTTP API: the composer
// posts to /ask, which is the supported messaging mechanism — there is no shell
// endpoint and none is exposed to the browser.

import { state, subscribe, start, refresh, counts, today, dayRoll, version, port, sessionActive } from './store.js';
import * as topology from './topology.js';
import * as stream from './stream.js';
import * as telemetry from './telemetry.js';
import * as resize from './resize.js';
import { bindMark } from './mark.js';

const pad = (n) => String(n).padStart(2, '0');

/* ── composer attachments ───────────────────────────────────────────────── */
// A message here is text, a picture, a voice note, or any mix of the three.
// A picture is held as a data URL until it is sent; a voice note is the same,
// plus the path it was saved to and the transcript its own recording produced.
// Neither is a decoration on the message — it IS the message.
let attachments = [];   // { name, dataUrl }
let voiceClip = null;   // { name, dataUrl, audio, path, text, duration, bytes, saving, sent }
let autoVoice = true;   // speak the agent's reply aloud as it lands

/* ── the mark, and the note it answers ─────────────────────────────────── */
// mark.js owns the reaction; this only hands it the audio the chip is
// playing. The mark is a static element of the shell, so it resolves once.
const stageMark = bindMark(document.getElementById('stageMark'));

// One player for the chip, reused across every re-render: the strip is rebuilt
// whenever its contents change, and a fresh <audio> per rebuild would drop the
// position mid-clip. The element therefore outlives the DOM that points at it.
const clipAudio = new Audio();
clipAudio.preload = 'metadata';
stageMark.attach(clipAudio);
let clipLoaded = null;   // the data URL currently loaded in clipAudio
let clipBar = null;      // the <i> the progress line is painted into
let clipPlay = null;     // the ▶ / ❚❚ button, so its glyph can follow the audio

// The reply's own player. Only one audio drives the mark at a time (mark.js),
// so whichever of this and clipAudio played last re-attaches itself just
// before it plays — nothing else changes which one currently owns the glow.
const replyAudio = new Audio();
replyAudio.preload = 'auto';

// The reply's visible player. A spoken answer is shown as the recording it is:
// the button plays it, the line shows how far it has got, and the words wait
// one tap away behind TRANSCRIPT. These are the live elements of whichever
// reply box was drawn last — showReply rebuilds them, so they are re-pointed
// there rather than cached across replies.
let replyRow = null;     // the player row, hidden until there are bytes
let replyPlay = null;    // its ▶ / ❚❚ button
let replyBar = null;     // the progress fill
let replyTime = null;    // "0:03 / 0:12"
let replyTextEl = null;  // the transcript under the player
let replyToggle = null;  // the TRANSCRIPT button that brings the words back
let replySeq = 0;        // which reply box a slow /speak belongs to
let replyUrl = null;     // the last object URL, revoked when it is replaced

// A third player, for the scrollable chat history: replaying an old turn must
// not disturb the clip chip or the live reply, and must not itself be cut off
// by them either — the usual "one voice at a time" rule, just with a third
// voice in the rotation. A user's voice note replays the real recording on
// disk; an assistant turn has none, so its button re-asks /speak and this is
// where the regenerated clip plays.
const historyAudio = new Audio();
historyAudio.preload = 'none';
let historyBtn = null;   // the chat-play button historyAudio currently belongs to
let historyUrl = null;   // object URL for a regenerated reply, revoked on replace

// The picker's sentinel for "show the real Telegram thread instead of a saved
// panel conversation." Read-only: a bot can send to the chat it's already in,
// but it can't post as Vee, so there is no reply-from-here path to wire up.
const TELEGRAM_SENTINEL = '__telegram__';
let telegramPollTimer = null;

function paintClip() {
  if (clipPlay) clipPlay.textContent = clipAudio.paused ? '▶' : '❚❚';
  if (!clipBar) return;
  const d = Number(clipAudio.duration);
  // No honest fraction without a duration — a streamed file may not have one.
  const p = (isFinite(d) && d > 0) ? Math.min(1, clipAudio.currentTime / d) : 0;
  clipBar.style.width = (p * 100).toFixed(1) + '%';
}
clipAudio.addEventListener('timeupdate', paintClip);
clipAudio.addEventListener('play', paintClip);
clipAudio.addEventListener('pause', paintClip);
clipAudio.addEventListener('ended', paintClip);

function toggleClip() {
  if (!voiceClip || !voiceClip.dataUrl) return;
  if (clipLoaded !== voiceClip.dataUrl) {
    clipAudio.src = voiceClip.dataUrl;      // the bytes are already in memory
    clipLoaded = voiceClip.dataUrl;
  }
  // The click IS the gesture, so a real browser does not block this; a refused
  // play() must not throw into the handler either way.
  if (clipAudio.paused || clipAudio.ended) {
    replyAudio.pause(); historyAudio.pause();   // one voice at a time
    stageMark.attach(clipAudio);   // reclaim the glow from a reply that spoke last
    clipAudio.play().catch(() => {});
  }
  else clipAudio.pause();
}

// Every route the panel exposes takes JSON, so a clip has to travel as a data:
// URL. It is written to disk on arrival and the agent is handed the path,
// because the binary reads files rather than request bodies.
function jpost(path, payload) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }).then(async (r) => {
    const raw = await r.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
    if (!r.ok) throw new Error((data && (data.error || data.why)) || 'HTTP ' + r.status);
    return data;
  });
}

// /speak answers audio/ogg bytes, not JSON, so this bypasses jpost. Returns
// an object URL, or null when the voice engine is down — the caller just
// skips the audio; the text reply already landed via showReply.
async function speak(text) {
  try {
    const r = await fetch('/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (!blob.size) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function paintReply() {
  if (replyPlay) replyPlay.textContent = replyAudio.paused ? '▶' : '❚❚';
  const d = Number(replyAudio.duration);
  const t = Number(replyAudio.currentTime) || 0;
  // No honest fraction without a duration — an OGG straight off the shim may
  // not report one until it is asked to play.
  if (replyBar) {
    const p = (isFinite(d) && d > 0) ? Math.min(1, t / d) : 0;
    replyBar.style.width = (p * 100).toFixed(1) + '%';
  }
  if (replyTime) {
    const clock = (s) => {
      const n = Math.max(0, Math.round(Number(s) || 0));
      return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
    };
    replyTime.textContent = clock(t) + ((isFinite(d) && d > 0) ? ' / ' + clock(d) : '');
  }
}
replyAudio.addEventListener('timeupdate', paintReply);
replyAudio.addEventListener('play', paintReply);
replyAudio.addEventListener('pause', paintReply);
replyAudio.addEventListener('ended', paintReply);
replyAudio.addEventListener('loadedmetadata', paintReply);
replyAudio.addEventListener('durationchange', paintReply);

function toggleReply() {
  if (!replyAudio.src) return;
  if (replyAudio.paused || replyAudio.ended) {
    clipAudio.pause(); historyAudio.pause();   // one voice at a time
    stageMark.attach(replyAudio);          // and it owns the glow
    replyAudio.play().catch(() => {});
  } else replyAudio.pause();
}

// The player itself: play button, tag, scrub line and clock. Built once per
// reply box and left hidden until /speak has bytes, so a reply that never got
// audio is a reply with no dead controls in it.
function replyPlayer(box) {
  const row = document.createElement('div');
  row.className = 'vreply';
  row.hidden = true;

  const play = document.createElement('button');
  play.className = 'vplay';
  play.type = 'button';
  play.title = 'Play the reply';
  play.textContent = '▶';
  play.addEventListener('click', toggleReply);

  const lbl = document.createElement('span');
  lbl.className = 'vlbl';
  lbl.textContent = 'VOICE REPLY';

  const track = document.createElement('i');
  track.className = 'vtrack';
  track.title = 'Jump to a point in the reply';
  const bar = document.createElement('i');
  bar.className = 'vbar';
  track.append(bar);
  track.addEventListener('click', (ev) => {
    const d = Number(replyAudio.duration);
    if (!isFinite(d) || d <= 0) return;
    const r = track.getBoundingClientRect();
    if (!r.width) return;
    const at = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    replyAudio.currentTime = at * d;
  });

  const time = document.createElement('span');
  time.className = 'vtime';
  time.textContent = '0:00';

  row.append(play, lbl, track, time);
  box.appendChild(row);

  replyRow = row; replyPlay = play; replyBar = bar; replyTime = time;
}

// Fetches the spoken version of a reply and shows it as the recording it is.
// A reply is not finished until its player is in the box: the button, the
// length, and — when the speech carries the whole answer — the transcript
// folded away behind TRANSCRIPT instead of sitting there as the message. The
// click that sent the message is the user gesture autoplay rides on.
async function voiceReply(text) {
  const raw = String(text || '');
  const coded = /```/.test(raw);           // code is not read aloud
  const plain = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return;
  const spoken = plain.slice(0, 900);
  const mine = replySeq;
  const url = await speak(spoken);
  // A newer reply landed while this one was being spoken: drop this audio
  // rather than hand the box a player for words it no longer holds.
  if (!url || mine !== replySeq) {
    if (url) URL.revokeObjectURL(url);
    return;
  }
  if (replyUrl) URL.revokeObjectURL(replyUrl);
  replyUrl = url;
  replyAudio.src = url;
  stageMark.attach(replyAudio);
  if (replyRow) { replyRow.hidden = false; paintReply(); }
  // Fold the words away only when the recording has all of them. A long answer
  // or one carrying code keeps its text on screen: the audio does not have it,
  // and hiding the only full copy would be worse than the transcript it replaced.
  if (replyTextEl && replyToggle && !coded && plain.length <= 900) {
    replyToggle.hidden = false;
    replyToggle.textContent = 'TRANSCRIPT';
    replyTextEl.classList.add('closed');
  }
  if (autoVoice) replyAudio.play().catch(() => { /* autoplay blocked; the button is there */ });
}

function dataUrlOf(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('could not read the recording'));
    reader.readAsDataURL(blob);
  });
}

function fmtLen(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// The queued chip strip above the row. A picture chip IS the picture; a voice
// chip is its length and its state, because a clip still being saved must not
// look like one that is ready to go.
function renderAttachments() {
  const strip = document.getElementById('attachStrip');
  const chips = [];

  if (voiceClip) {
    const chip = document.createElement('div');
    chip.className = 'clipchip';
    if (voiceClip.sent) chip.classList.add('sent');

    // The clip can be heard before it is sent and again afterwards: the bytes
    // never left the page, so replaying it costs nothing and is the only way
    // to check what the agent was actually told. While it plays, the mark
    // behind the map answers it.
    const play = document.createElement('button');
    play.className = 'play';
    play.type = 'button';
    play.title = 'Play the note';
    play.textContent = clipAudio.paused ? '▶' : '❚❚';
    play.addEventListener('click', toggleClip);
    clipPlay = play;

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = 'Voice note ' + fmtLen(voiceClip.duration)
      + (voiceClip.saving ? ' · saving…' : (voiceClip.sent ? ' · sent' : ' · ready to send'));

    // A thin line under the label, not a scrub bar: seeking a note you just
    // spoke is not a thing anyone wants, and it keeps the chip one row tall.
    const track = document.createElement('i');
    track.className = 'track';
    clipBar = document.createElement('i');
    clipBar.className = 'bar';
    track.append(clipBar);
    paintClip();

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      // Stop the sound before dropping the clip, or the audio would outlive
      // the chip that owns it and the mark would glow at nothing.
      clipAudio.pause();
      voiceClip = null;
      clipBar = null;
      clipPlay = null;
      renderAttachments();
    });
    chip.append(play, lbl, track, rm);
    chips.push(chip);
  }

  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'thumb';
    const img = document.createElement('img');
    img.src = a.dataUrl;
    img.alt = a.name || 'attachment';
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    chip.append(img, rm);
    chips.push(chip);
  });

  strip.replaceChildren(...chips);
}

/* ── header ─────────────────────────────────────────────────────────────── */
function stat(host, key, value, dim) {
  const d = document.createElement('div');
  d.className = 'stat';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'v' + (dim ? ' dimv' : '');
  v.textContent = value;
  d.append(k, v);
  host.appendChild(d);
}

function paintStrip() {
  const host = document.getElementById('statusStrip');
  host.textContent = '';
  const c = counts();
  const t = today();
  const d = dayRoll();

  const active = (state.sessions || []).filter(sessionActive).length;

  stat(host, 'sessions', c.sessions != null ? String(c.sessions) : '—');
  stat(host, 'active', active ? String(active) : '0', active === 0);
  stat(host, 'tools today', d.toolRuns != null ? String(d.toolRuns) : '—');
  stat(host, 'tokens today', t.tokens != null ? compact(t.tokens) : '—');
  stat(host, 'cost today', t.cost != null ? '$' + t.cost.toFixed(2) : '—');
  stat(host, 'cron', c.cron != null ? String(c.cron) : '—');
  stat(host, 'version', version() || '—', !version());
}

function compact(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

function paintLink() {
  const el = document.getElementById('linkState');
  const txt = el.querySelector('.txt');
  el.dataset.state = state.link;
  txt.textContent = ({
    live: 'LIVE',
    connecting: 'CONNECTING',
    stale: 'STALE',
    down: 'DISCONNECTED',
  })[state.link] || 'UNKNOWN';

  // A stale or down link must look stale everywhere, not just in the header.
  document.getElementById('center').dataset.stale = (state.link === 'down' || state.link === 'stale') ? '1' : '0';
}

/* ── clock ──────────────────────────────────────────────────────────────── */
function tickClock() {
  const d = new Date();
  document.getElementById('clock').textContent =
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/* ── event selection → context ──────────────────────────────────────────── */
function onEventPick(e) {
  if (!e) return;
  const box = document.getElementById('inspector');
  box.textContent = '';
  box.hidden = false;

  const head = document.createElement('div');
  head.className = 'ih';
  const nm = document.createElement('div');
  nm.className = 'iname';
  nm.textContent = e.label;
  const x = document.createElement('button');
  x.className = 'ix';
  x.type = 'button';
  x.textContent = '×';
  x.addEventListener('click', () => { box.hidden = true; });
  head.append(nm, x);
  box.appendChild(head);

  const dl = document.createElement('dl');
  const rows = [
    ['time', e.raw_at || '—'],
    ['severity', e.sev],
    ['kind', e.kind],
    ['detail', e.text],
    ['session', e.session || '—'],
    ['entity', e.entity || '—'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v == null ? '—' : String(v);
    dl.append(dt, dd);
  }
  box.appendChild(dl);
}

/* ── bottom: scrollable chat history ─────────────────────────────────────── */
// /upload returns the file's full path on the server's disk; the browser can
// only fetch it back by the bare filename the panel's own route accepts.
function uploadUrl(path) {
  const base = String(path || '').split(/[\\/]/).pop();
  return base ? '/api/upload/' + encodeURIComponent(base) : '';
}

function paintHistoryBtn() {
  if (historyBtn) historyBtn.classList.toggle('on', !historyAudio.paused && !historyAudio.ended);
}
historyAudio.addEventListener('play', paintHistoryBtn);
historyAudio.addEventListener('pause', paintHistoryBtn);
historyAudio.addEventListener('ended', paintHistoryBtn);

// Shared by both kinds of history button. getUrl is only called when this
// click actually needs new audio — clicking the already-playing button just
// pauses it, same as the clip chip and the live reply player.
async function playHistoryItem(btn, getUrl) {
  if (historyBtn === btn && !historyAudio.paused) { historyAudio.pause(); return; }
  const prevBtn = historyBtn;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  let url;
  try { url = await getUrl(); } finally { btn.disabled = false; btn.textContent = label; }
  if (!url) return;
  clipAudio.pause(); replyAudio.pause();   // one voice at a time
  if (historyUrl) { URL.revokeObjectURL(historyUrl); historyUrl = null; }
  if (url.startsWith('blob:')) historyUrl = url;
  historyAudio.src = url;
  historyBtn = btn;
  if (prevBtn && prevBtn !== btn) prevBtn.classList.remove('on');
  stageMark.attach(historyAudio);
  historyAudio.play().catch(() => {});
}

function renderChatlog(messages) {
  const host = document.getElementById('chatlog');
  if (!host) return;
  if (historyBtn) { historyAudio.pause(); historyBtn = null; }
  host.textContent = '';
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No history yet — pick a saved conversation above, or send a message.';
    host.appendChild(empty);
    return;
  }
  for (const msg of list) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.dataset.role = msg.role === 'assistant' ? 'assistant' : 'user';

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const role = document.createElement('span');
    role.className = 'chat-role';
    role.textContent = msg.role === 'assistant' ? 'ALAN' : 'YOU';
    const time = document.createElement('span');
    time.className = 'chat-time mono';
    const ts = Number(msg.created_at);
    time.textContent = (isFinite(ts) && ts > 0)
      ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    meta.append(role, time);
    row.appendChild(meta);

    const text = document.createElement('div');
    text.className = 'chat-text';
    text.textContent = msg.text || '(no text)';
    row.appendChild(text);

    // A voice note replays the real recording; a spoken reply never had one
    // saved, so its button earns its keep by regenerating it on click only.
    const audioAtt = (msg.meta || []).find((m) => m && m.audio && m.path);
    if (audioAtt) {
      const btn = document.createElement('button');
      btn.className = 'chip chat-play';
      btn.type = 'button';
      btn.textContent = '▶ VOICE NOTE';
      btn.addEventListener('click', () => playHistoryItem(btn, () => Promise.resolve(uploadUrl(audioAtt.path))));
      row.appendChild(btn);
    } else if (msg.role === 'assistant' && String(msg.text || '').trim()) {
      const btn = document.createElement('button');
      btn.className = 'chip chat-play';
      btn.type = 'button';
      btn.textContent = '▶ REPLAY';
      btn.addEventListener('click', () => {
        const plain = String(msg.text || '')
          .replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900);
        playHistoryItem(btn, () => (plain ? speak(plain) : Promise.resolve(null)));
      });
      row.appendChild(btn);
    }

    host.appendChild(row);
  }
  host.scrollTop = host.scrollHeight;
}

function stopTelegramPoll() {
  if (telegramPollTimer) { clearInterval(telegramPollTimer); telegramPollTimer = null; }
}

async function loadTelegramLog() {
  try {
    const r = await fetch('/api/telegram/messages?limit=200',
      { headers: { Accept: 'application/json' }, cache: 'no-store' });
    renderChatlog(r.ok ? (await r.json() || {}).messages : []);
  } catch {
    renderChatlog([]);
  }
}

async function loadChatlog(cid) {
  stopTelegramPoll();
  if (cid === TELEGRAM_SENTINEL) {
    await loadTelegramLog();
    // Telegram carries on without this page open, so the log is polled while
    // it's the selected thread — the same reason the composer below is
    // disabled: nothing here is the source of truth for that conversation.
    telegramPollTimer = setInterval(loadTelegramLog, 5000);
    return;
  }
  if (!cid) { renderChatlog([]); return; }
  try {
    const r = await fetch('/conversation/' + encodeURIComponent(cid),
      { headers: { Accept: 'application/json' }, cache: 'no-store' });
    renderChatlog(r.ok ? (await r.json() || {}).messages : []);
  } catch {
    renderChatlog([]);
  }
}

/* ── composer ───────────────────────────────────────────────────────────── */
function initComposer() {
  const input = document.getElementById('cmdInput');
  const btn = document.getElementById('sendBtn');
  const status = document.getElementById('sendState');
  const pick = document.getElementById('sessionPick');

  const setStatus = (text, tone) => {
    status.textContent = text;
    status.dataset.tone = tone || '';
  };

  // The composer targets a panel-side conversation, which is what /ask expects.
  // Existing conversations are listed so a reply lands in a real thread.
  const addOption = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    pick.appendChild(o);
  };

  const fillConversations = async () => {
    // Rebuilding the list below clears the picker; keep whatever was chosen
    // (Telegram included) so a periodic refresh doesn't silently switch what
    // the log is showing out from under whoever is reading it.
    const prev = pick.value;
    pick.textContent = '';
    try {
      const r = await fetch('/api/conversations?limit=25', { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const list = Array.isArray(d && d.conversations) ? d.conversations : [];
      if (!list.length) {
        addOption('', 'new conversation');
      } else {
        for (const c of list) {
          addOption(String(c.id || ''), String(c.title || c.id || 'untitled').slice(0, 44));
        }
      }
    } catch {
      addOption('', 'new conversation');
    }
    // Appended last: the default landing view stays the most recent panel
    // conversation, same as before this existed. Telegram is a deliberate pick.
    addOption(TELEGRAM_SENTINEL, 'Telegram (live)');
    if ([...pick.options].some((o) => o.value === prev)) pick.value = prev;
  };

  let busy = false;   // one turn at a time: a second Enter used to start another

  const send = async () => {
    // A second Enter while a turn is running used to launch a second turn that
    // silently sat alongside the first. Say so instead: a turn here is minutes.
    if (busy) { setStatus('STILL WORKING — one moment…', 'warn'); return; }
    const text = input.value.trim();
    // A clip that has already gone stays on the strip so it can be replayed,
    // but it is no longer part of the message: without this guard a second
    // Enter would quietly send the same voice note again.
    const clip = (voiceClip && !voiceClip.sent) ? voiceClip : null;
    if (!text && !attachments.length && !clip) return;

    // A recording arrives with its transcription still in flight. Wait for it,
    // but only briefly: a stuck STT call must not hold the message hostage the
    // way the old ordering did. After thirty seconds the clip path goes along
    // instead and the agent listens to the file for itself.
    if (clip && !String(clip.text || '').trim() && clip.stt) {
      setStatus('TRANSCRIBING…', 'warn');
      await Promise.race([
        clip.stt,
        new Promise((res) => setTimeout(res, 30000)),
      ]);
    }

    const atts = attachments.slice();
    if (clip) atts.push(clip);
    attachments = [];
    if (clip) {
      // Stop the sound first: it is being handed to the agent, and a chip
      // still playing while its message leaves reads as two messages.
      clipAudio.pause();
      clip.sent = true;
    }
    renderAttachments();
    input.value = '';

    btn.disabled = true;
    busy = true;
    // The wait is minutes, not seconds, so tick the seconds: a still status line
    // reads as a hang rather than as work.
    const askedAt = performance.now();
    const ticker = setInterval(() => {
      setStatus('WORKING… ' + Math.round((performance.now() - askedAt) / 1000) + 's', 'warn');
    }, 1000);
    setStatus('WORKING…', 'warn');

    // Everything is written to disk first, and the paths ride along in the
    // prompt: the agent binary reads files, it does not take bytes.
    const paths = [];
    for (const a of atts) {
      if (a.path) { paths.push(a.path); continue; }
      try {
        const up = await jpost('/upload', { dataUrl: a.dataUrl, name: a.name });
        if (up && up.path) { a.path = up.path; paths.push(up.path); }
      } catch (err) {
        setStatus('UPLOAD FAILED · ' + ((err && err.message) || 'error'), 'err');
      }
    }

    // With a transcript the turn is a TEXT turn: the words are the message, and
    // the clip path is deliberately left out of the prompt. Handing the binary
    // the file as well takes the slow path — it transcribes the audio itself,
    // which measured 148s for a five-second note. Only a clip with no transcript
    // (STT refused, or still running past the wait above) goes as a file.
    let prompt = text;
    const spoken = clip ? String(clip.text || '').trim() : '';
    if (!prompt && clip) {
      prompt = spoken || 'Listen to the attached voice note and answer what I said.';
    }
    if (!prompt && paths.length) prompt = 'Describe the attached image.';
    const carry = (clip && spoken) ? paths.filter((p) => p !== clip.path) : paths;
    if (carry.length) {
      prompt += '\n\n[attached ' + (clip ? 'voice note' : 'image')
        + (carry.length > 1 ? 's' : '') + ']\n'
        + carry.map((p) => '- ' + p).join('\n');
    }

    // Only descriptors go into the conversation log: the bytes are already on
    // disk and are served back from there, so the log carries no second copy.
    const meta = atts.map((a) => (a.audio
      ? { kind: 'audio', audio: true, name: a.name || 'voice-note',
          duration: a.duration || 0, bytes: a.bytes || 0, path: a.path || null }
      : { kind: 'image', name: a.name || 'image', path: a.path || null }));

    const cid = pick.value || null;
    // How many turns the log held before this ask. Recovery needs the baseline so
    // it cannot mistake an older answer for this one; -1 keeps it away when the
    // baseline cannot be read.
    let before = -1;
    if (cid) {
      try {
        const lr = await fetch('/conversation/' + encodeURIComponent(cid),
                              { headers: { Accept: 'application/json' }, cache: 'no-store' });
        const log = lr.ok ? await lr.json() : null;
        before = (log && log.messages ? log.messages.length : -1);
      } catch { before = -1; }
    }
    const body = { text: prompt, conversation_id: cid, meta };
    // One POST, wrapped so a busy provider can be tried again without rebuilding
    // the body. /ask holds the connection open for the whole turn.
    const postAsk = async () => {
      const r = await fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await r.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
      return { r, raw, data };
    };
    const t0 = performance.now();
    try {
      let { r, raw, data } = await postAsk();
      // A provider that is out of capacity rejects FAST (429/502/503). Retry once
      // only when the failure came back quickly: a slow failure has already spent
      // the binary's whole retry ladder, and spending it twice is how a four-minute
      // wait turns into eight.
      if (!r.ok && [429, 502, 503, 504].includes(r.status)
          && (performance.now() - t0) < 60000) {
        setStatus('PROVIDER BUSY · HTTP ' + r.status + ' · retrying once', 'warn');
        await new Promise((res) => setTimeout(res, 4000));
        ({ r, raw, data } = await postAsk());
      }

      if (!r.ok) {
        setStatus('FAILED · HTTP ' + r.status, 'err');
        showReply('Request failed', (data && (data.error || data.why)) || raw.slice(0, 400), 'err');
        return;
      }
      if (!data) {
        setStatus('FAILED · unreadable reply', 'err');
        return;
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      setStatus('ANSWERED · ' + secs + 's', 'ok');
      showReply(
        'AGENT REPLY',
        data.reply || '(empty reply)',
        'ok',
        [
          ['model', data.model || 'not reported'],
          ['tokens', data.tokens != null ? String(data.tokens) : 'not reported'],
          ['cost', data.cost != null ? '$' + Number(data.cost).toFixed(4) : 'not reported'],
          ['session', data.session_id || '—'],
          ['elapsed', secs + 's'],
        ]
      );
      fillConversations();
      loadChatlog(data.conversation_id || cid);
      refresh();
    } catch (err) {
      // The turn is committed to the log the moment it ends, and it can outlive
      // this request — a dropped socket, or an answer long enough that the panel
      // gave up first. Read the log before calling it a failure.
      const recovered = await recoverReply(cid, before);
      if (recovered) {
        setStatus('ANSWERED · recovered from the log', 'ok');
        showReply('AGENT REPLY', recovered, 'ok', [['elapsed', 'recovered from the log']]);
        fillConversations();
        loadChatlog(cid);
        refresh();
      } else {
        setStatus('FAILED · ' + (err && err.message || 'network'), 'err');
        showReply('Request failed', String(err && err.message || err), 'err');
      }
    } finally {
      clearInterval(ticker);
      busy = false;
      btn.disabled = false;
      renderAttachments();
    }
  };

  // Keep looking for an answer this panel never received. The log is the truth
  // even when the request is not: the server writes the reply the moment the turn
  // ends. Waits out the server's own ten-minute ask window, then gives up.
  const recoverReply = async (cid, before) => {
    if (!cid || before < 0) return null;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const r = await fetch('/conversation/' + encodeURIComponent(cid),
                              { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!r.ok) continue;
        const log = await r.json();
        const turns = (log && log.messages) || [];
        if (turns.length <= before) continue;   // the log has not taken this turn yet
        const last = turns[turns.length - 1];
        if (last && last.role === 'assistant' && String(last.text || '').trim()) {
          return last.text;
        }
      } catch { /* log unreachable this second — keep waiting, the deadline ends it */ }
    }
    return null;
  };

  btn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // Telegram is a bot speaking to Vee, not a thread this panel can post into
  // as Vee — there is no API that lets a bot send a message as its own human,
  // so the composer is locked rather than wired to a send that can't work.
  const applyComposerLock = () => {
    const live = pick.value === TELEGRAM_SENTINEL;
    input.disabled = live;
    btn.disabled = live;
    input.placeholder = live
      ? 'Telegram is read-only here — reply from Telegram itself'
      : 'Message Alan… (Enter to send)';
  };
  pick.addEventListener('change', () => { applyComposerLock(); loadChatlog(pick.value); });

  // --- picture attach -----------------------------------------------------
  const attachBtn = document.getElementById('attachBtn');
  const fileInput = document.getElementById('file');
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files || []) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = (ev) => {
        attachments.push({ name: f.name, dataUrl: String(ev.target.result) });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    }
    fileInput.value = '';
  });

  // A screenshot pasted straight into the box is the commonest way a picture
  // arrives, and making the user save it somewhere first is a tax with no
  // purpose.
  input.addEventListener('paste', (e) => {
    for (const item of (e.clipboardData && e.clipboardData.items) || []) {
      if (!item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (!f) continue;
      const reader = new FileReader();
      reader.onload = (ev) => {
        attachments.push({ name: 'pasted.png', dataUrl: String(ev.target.result) });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    }
  });

  // --- voice note ---------------------------------------------------------
  // Click to record, click again to send. The clip is saved to disk and
  // transcribed by the panel's own whisper; send() waits for that transcript
  // (bounded) and sends THOSE WORDS as the message. Only a clip with no
  // transcript rides along as a file. The words are never typed back into the
  // composer — doing that is exactly what makes a recording look like dictation.
  const micBtn = document.getElementById('micBtn');
  let recorder = null;
  let chunks = [];
  let tick = null;
  let started = 0;

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const MR = window.MediaRecorder;
    const type = MR.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : (MR.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : '');
    recorder = new MR(stream, type ? { mimeType: type } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      // Length of the CLIP, measured the instant the recording stops. Taking
      // it later would fold in the upload and the transcription, and the chip
      // would claim nine seconds for a four-second note.
      const seconds = Math.max(0, (Date.now() - started) / 1000);
      stream.getTracks().forEach((t) => t.stop());
      micBtn.classList.remove('rec');
      if (tick) { clearInterval(tick); tick = null; }
      const blob = new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
      recorder = null;
      if (!blob.size) { setStatus('NOTHING CAPTURED · check the mic', 'err'); return; }

      const dataUrl = await dataUrlOf(blob);
      voiceClip = { name: 'voice-note', dataUrl, audio: true, path: null, text: '',
        duration: seconds, bytes: blob.size, saving: true };
      renderAttachments();

      setStatus('SAVING THE CLIP…', 'warn');
      try {
        const up = await jpost('/upload', { dataUrl, name: 'voice-note' });
        if (up && up.path) voiceClip.path = up.path;
      } catch (err) {
        setStatus('CLIP NOT SAVED · ' + ((err && err.message) || 'error'), 'err');
      }
      // Transcription is STARTED here, not awaited: the panel's own whisper does
      // it in about eleven seconds, and send() waits for it (bounded) so the turn
      // goes out as TEXT. Sending the audio file as well makes the agent
      // transcribe it again on the slow path — 148s for a five-second note.
      const mine = voiceClip;
      mine.saving = false;
      renderAttachments();
      setStatus('TRANSCRIBING…', 'warn');
      mine.stt = jpost('/transcribe', { dataUrl })
        .then((res) => {
          const t = String((res && res.text) || '').trim();
          if (t && mine === voiceClip) mine.text = t;
        })
        .catch(() => {
          // No transcript is not a failure: the clip path goes along instead and
          // the agent listens to the file.
        })
        .then(() => {
          if (mine === voiceClip) { mine.stt = null; renderAttachments(); }
        });
      send();
    };
    started = Date.now();
    recorder.start();
    micBtn.classList.add('rec');
    setStatus('● RECORDING…', 'err');
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setStatus('● REC ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
        + ' · click to send', 'err');
    }, 500);
  }

  micBtn.addEventListener('click', async () => {
    if (recorder) { recorder.stop(); return; }
    if (!(navigator.mediaDevices && window.MediaRecorder)) {
      setStatus('NO RECORDER IN THIS BROWSER · type instead', 'err');
      return;
    }
    try { await startRecording(); }
    catch (err) { setStatus('MIC · ' + ((err && err.message) || 'refused'), 'err'); }
  });

  const voiceBtn = document.getElementById('voiceBtn');
  voiceBtn.addEventListener('click', () => {
    autoVoice = !autoVoice;
    voiceBtn.classList.toggle('on', autoVoice);
    if (!autoVoice) replyAudio.pause();
    setStatus(autoVoice ? 'SPOKEN REPLIES ON' : 'SPOKEN REPLIES OFF', 'ok');
  });

  renderAttachments();
  fillConversations().then(() => { applyComposerLock(); loadChatlog(pick.value); });
}

// Replies are rendered as plain text. Agent output is untrusted content: it is
// never parsed as markup.
function showReply(title, text, tone, meta) {
  const host = document.getElementById('center');
  let box = document.getElementById('replyBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'replyBox';
    box.className = 'inspector';
    box.style.left = '10px';
    box.style.right = 'auto';
    box.style.top = 'auto';
    box.style.bottom = '10px';
    box.style.width = 'min(460px, calc(100% - 20px))';
    box.style.maxHeight = '46%';
    host.appendChild(box);
  }
  // A new answer owns the box: stop the last one, and point the player at the
  // elements about to be built. replySeq is what a late /speak compares itself
  // against, so a slow voice never lands on the next reply's player.
  replyAudio.pause();
  replySeq += 1;
  replyRow = replyPlay = replyBar = replyTime = replyTextEl = replyToggle = null;
  box.textContent = '';
  box.hidden = false;

  const head = document.createElement('div');
  head.className = 'ih';
  const nm = document.createElement('div');
  nm.className = 'iname';
  nm.textContent = title;
  if (tone === 'err') nm.style.color = 'var(--err)';
  const x = document.createElement('button');
  x.className = 'ix';
  x.type = 'button';
  x.textContent = '×';
  x.addEventListener('click', () => { box.hidden = true; replyAudio.pause(); });
  head.append(nm, x);
  box.appendChild(head);

  // The recording sits above the words: on a spoken answer it is the message.
  replyPlayer(box);

  const body = document.createElement('div');
  body.className = 'rtext';
  body.style.whiteSpace = 'pre-wrap';
  body.style.fontSize = '11.5px';
  body.style.color = 'var(--ink)';
  body.textContent = text;
  box.appendChild(body);
  replyTextEl = body;

  // Hidden until the player exists: with no recording there is nothing to fold
  // the words behind, and a transcript button with nothing behind it is clutter.
  const toggle = document.createElement('button');
  toggle.className = 'vtext';
  toggle.type = 'button';
  toggle.hidden = true;
  toggle.textContent = 'TRANSCRIPT';
  toggle.addEventListener('click', () => {
    const closed = body.classList.toggle('closed');
    toggle.textContent = closed ? 'TRANSCRIPT' : 'HIDE TEXT';
  });
  box.appendChild(toggle);
  replyToggle = toggle;

  if (meta) {
    const dl = document.createElement('dl');
    for (const [k, v] of meta) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
    box.appendChild(dl);
  }

  // Failures are read, not listened to.
  if (tone !== 'err') voiceReply(text);
}

/* ── boot ───────────────────────────────────────────────────────────────── */
function boot() {
  telemetry.init();
  topology.init();
  stream.init(onEventPick);
  initComposer();
  resize.init();

  subscribe((what) => {
    if (what === 'data') { paintStrip(); paintLink(); }
    if (what === 'link') { paintLink(); }
  });

  paintLink();
  tickClock();
  setInterval(tickClock, 1000);

  // Poll-driven views refresh on their own; this covers the first paint after
  // the initial fetch resolves.
  subscribe((what) => { if (what === 'data' && !window.__firstStrip) { window.__firstStrip = 1; paintStrip(); } });

  start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
