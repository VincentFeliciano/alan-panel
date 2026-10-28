// The mark answers the audio.
//
// One module, two panels. `/futuristic/` drives `#stageMark` from the voice
// chip it keeps after sending; the classic panel drives `.brand .mark` and the
// empty-state `.hero` from the player `voiceBubble()` already builds. Nothing
// here reaches the topology, the map or the particles — the mark is a
// watermark, and this only lets it breathe while something is being spoken.
//
// The contract with the CSS is three things and nothing else:
//   data-speaking="1"  on the element while audio is playing
//   --mark-level       0…1, how far through the clip we are
// and the element's own resting styles, which this never touches.

// How often --mark-level is written while playing. Deliberately not
// requestAnimationFrame: a background or headless tab may suspend rAF
// entirely, which would leave the level — and any probe measuring it — dead.
const LEVEL_MS = 60;

// One binder per panel. `markEl` may be a single element or a list of them:
// the classic panel has a header mark and an empty-state hero that should
// react together, and one audio has to drive both.
export function bindMark(markEl) {
  const els = (Array.isArray(markEl) ? markEl : [markEl]).filter(Boolean);
  let audio = null;
  let timer = 0;

  const stopLoop = () => {
    if (timer) { clearInterval(timer); timer = 0; }
  };

  // Back to rest: no flag, no level, no leftover inline value. The element is
  // left exactly as the stylesheet found it.
  const rest = () => {
    stopLoop();
    els.forEach((el) => {
      delete el.dataset.speaking;
      el.style.removeProperty('--mark-level');
    });
  };

  // Progress through the clip. An unknown or unbounded duration (a streamed
  // reply) has no honest fraction to show, so it reads as fully lit.
  const level = () => {
    if (!audio) return;
    const d = Number(audio.duration);
    const t = Number(audio.currentTime) || 0;
    const p = (isFinite(d) && d > 0) ? Math.min(1, Math.max(0, t / d)) : 1;
    els.forEach((el) => el.style.setProperty('--mark-level', p.toFixed(3)));
  };

  const rise = () => {
    stopLoop();
    els.forEach((el) => { el.dataset.speaking = '1'; });
    level();
    timer = setInterval(level, LEVEL_MS);
  };

  const onPlay = () => rise();
  const onStop = () => rest();
  const onSeek = () => { if (audio && !audio.paused) level(); };

  const unbind = (el) => {
    el.removeEventListener('play', onPlay);
    el.removeEventListener('playing', onPlay);
    el.removeEventListener('pause', onStop);
    el.removeEventListener('ended', onStop);
    el.removeEventListener('seeked', onSeek);
  };

  // Only one audio drives the mark at a time: a second player taking over
  // clears the first, so a paused clip cannot keep the mark lit.
  const attach = (el) => {
    if (!el || el === audio) return;
    if (audio) unbind(audio);
    audio = el;
    el.addEventListener('play', onPlay);
    el.addEventListener('playing', onPlay);
    el.addEventListener('pause', onStop);
    el.addEventListener('ended', onStop);
    el.addEventListener('seeked', onSeek);
    // Attached to something already rolling (a player that autoplays, or a
    // re-attach after a re-render): pick the state up rather than wait.
    if (!el.paused && !el.ended) rise();
  };

  const detach = () => {
    if (audio) { unbind(audio); audio = null; }
    rest();
  };

  if (els.length) rest();      // an explicit resting state on bind
  return { attach, detach };
}