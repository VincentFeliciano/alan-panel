// Column resize. Drags the rail/center and center/telemetry boundaries by
// writing the --rail / --tel CSS vars the grid is built from. Widths persist
// in localStorage so a reload keeps the layout the user left it in.

const MIN = 220;
const MAX = 520;
// The chat history's height has no fixed ceiling the way the side columns do
// — it is a fraction of whatever screen the panel is open on, not a budget
// measured in characters-per-line, so the cap is computed from the viewport
// rather than a constant.
const MIN_BOTTOM = 110;
const KEY = 'alan.cols';
const root = document.documentElement;

function clamp(n) {
  return Math.max(MIN, Math.min(MAX, n));
}

function maxBottom() {
  return Math.round(window.innerHeight * 0.82);
}

function clampBottom(n) {
  return Math.max(MIN_BOTTOM, Math.min(maxBottom(), n));
}

function varPx(name) {
  return parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
}

function load() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  if (saved.rail) root.style.setProperty('--rail', clamp(saved.rail) + 'px');
  if (saved.tel) root.style.setProperty('--tel', clamp(saved.tel) + 'px');
  // No saved bottomH means "leave it" — the CSS default (33vh) already
  // applies and resizes itself with the window, which a fixed px readout here
  // would otherwise freeze in place on first load.
  if (saved.bottomH) root.style.setProperty('--bottomH', clampBottom(saved.bottomH) + 'px');
}

function save() {
  const bottomEl = document.getElementById('bottom');
  localStorage.setItem(KEY, JSON.stringify({
    rail: varPx('--rail'),
    tel: varPx('--tel'),
    bottomH: bottomEl ? Math.round(bottomEl.getBoundingClientRect().height) : 0,
  }));
}

// sign: +1 when dragging right grows the column (the left rail), -1 when
// dragging right shrinks it (the right telemetry column sits past the handle).
function wire(handle, varName, sign) {
  if (!handle) return;

  function drag(startX, startW, pointerId) {
    handle.classList.add('dragging');
    function onMove(ev) {
      root.style.setProperty(varName, clamp(startW + sign * (ev.clientX - startX)) + 'px');
    }
    function onUp() {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      save();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    drag(e.clientX, varPx(varName), e.pointerId);
  });

  // Keyboard: arrow keys nudge the same boundary by 16px, for anyone who
  // can't drag a 7px track with a mouse.
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.key === 'ArrowRight' ? 1 : -1) * sign * 16;
    root.style.setProperty(varName, clamp(varPx(varName) + step) + 'px');
    save();
  });
}

// The bottom row drags by height, not by a boundary's distance from a fixed
// start — it starts from the footer's own rendered height so a --bottomH left
// at its CSS default (33vh, no px yet) still has a real number to grow from.
function wireRow(handle, el) {
  if (!handle || !el) return;

  function drag(startY, startH, pointerId) {
    handle.classList.add('dragging');
    function onMove(ev) {
      // Dragging up (smaller clientY) grows the panel below the handle.
      root.style.setProperty('--bottomH', clampBottom(startH - (ev.clientY - startY)) + 'px');
    }
    function onUp() {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      save();
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    drag(e.clientY, el.getBoundingClientRect().height, e.pointerId);
  });

  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = (e.key === 'ArrowUp' ? 1 : -1) * 16;
    root.style.setProperty('--bottomH', clampBottom(el.getBoundingClientRect().height + step) + 'px');
    save();
  });
}

export function init() {
  load();
  wire(document.getElementById('resizeLeft'), '--rail', 1);
  wire(document.getElementById('resizeRight'), '--tel', -1);
  wireRow(document.getElementById('resizeBottom'), document.getElementById('bottom'));
}
