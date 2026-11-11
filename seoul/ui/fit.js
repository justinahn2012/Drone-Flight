// seoul/ui/fit.js: [F2] P4 pure UI layout and copy rules (no DOM, no three.js). main.js lays the menu, the end card and
// the OSD labels out with them; tests/seoul-ui.mjs runs the same functions in node (the 844 x 390 grid, the end card row).

// ---- ui #3 / ux #2: the LINES groups side by side in short landscape. Every group gets the same number of rows (the
// fewest whose cells are still >= minCell px wide), each group as many columns as that needs: 19 lines (STREETS 9,
// SET PIECES 5, GAPS & ROOFS 5) go 3 + 2 + 2 = 7 cells across, 3 rows. `weights` are the groups' widths for the outer
// grid's fr columns (equal cells across groups). null: not even maxRows rows fit (the grid scrolls).
export function gridPlan(counts, width, { minCell = 92, gap = 5, gapG = 8, maxRows = 6 } = {}) {
  const ns = (counts || []).filter((n) => n > 0), G = ns.length;
  if (!G || !(width > 0)) return null;
  for (let R = 1; R <= maxRows; R++) {
    const cols = ns.map((n) => Math.ceil(n / R)), C = cols.reduce((a, b) => a + b, 0);
    const cell = (width - (G - 1) * gapG - gap * (C - G)) / C;
    if (cell >= minCell) return { rows: R, cols, cell, weights: cols.map((c) => c * cell + (c - 1) * gap) };
  }
  return null;
}

// the compact cell (index.html, short landscape): 12.5 px Barlow Condensed 700, .02em tracking, two lines at most, 22 + 5 px
// of padding, 1 px borders, the head 18 px with its margin. The glyph advance is an upper bound for the caps the line names use (measured ~0.47-0.53 em).
export const CELL = { font: 12.5, adv: 0.56, track: 0.02, padX: 27, lineH: 1.05, padY: 10, minH: 32, head: 18 };   // padY: 4 + 4 + the 1 px border
// how many lines a name wraps to in a cell `w` px wide (greedy, word by word; a word wider than the line breaks anywhere)
export function nameLines(name, w, C = CELL) {
  const em = C.font * (C.adv + C.track), avail = Math.max(1, w - C.padX), words = String(name).split(/\s+/).filter(Boolean);
  let lines = 0, cur = Infinity;                       // width used on the current line (Infinity: start a new one)
  for (const wd of words) {
    const ww = wd.length * em;
    if (cur + em + ww <= avail) { cur += em + ww; continue; }
    const k = Math.max(1, Math.ceil(ww / avail)); lines += k; cur = ww - (k - 1) * avail;
  }
  return Math.max(1, lines);
}
export const cellH = (lines, C = CELL) => Math.max(C.minH, Math.ceil(lines * C.font * C.lineH + C.padY));

// ---- ui #4 / ux #1: the end card's line row from take.stats.lines ([{name, flow, clean, micro, repeat, dur, fast}] or
// names). Named lines once each, in the order first flown, with their best FLOW this take; micros only as a count ("+30
// BEATS"). CLEAN counts named flights only (micros are beats, not lines). isMicroName: for logs without the micro flag.
export function takeSummary(log, isMicroName = null) {
  const named = new Map(); let beats = 0, flights = 0, clean = 0;
  for (const x of Array.isArray(log) ? log : []) {
    const e = typeof x === 'string' ? { name: x } : x; if (!e || !e.name) continue;
    const micro = 'micro' in e ? !!e.micro : !!isMicroName?.(e.name);
    if (micro) { beats++; continue; }
    flights++; if (e.clean) clean++;
    const f = +e.flow || 1, r = named.get(e.name);
    if (r) { r.n++; r.flow = Math.max(r.flow, f); r.fast ||= !!e.fast; }
    else named.set(e.name, { name: e.name, flow: f, n: 1, fast: !!e.fast });
  }
  return { named: [...named.values()], beats, flights, clean };
}

// ---- ui #6: where a gate bracket's label goes. Over the bracket (its bottom 4 px above the box) unless that is in the top
// band (the OSD's LQ / guide / take tag rows, y < band) or overlaps a box to avoid (the OSD readouts, by any amount; other
// labels, by more than 30 %); else under the bracket; else nowhere (the ticks stay). Boxes are [x0, y0, x1, y1] CSS px.
// -> {x (centre), y (top), box} | null
export const overlap = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? (w * h) / Math.max(1, Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))) : 0;
};
export function labelSpot(bx, lw, lh, { band = 80, bottom = Infinity, fixed = [], labels = [], left = 0, right = Infinity } = {}) {
  const cx = Math.max(left + lw / 2, Math.min(right - lw / 2, (bx[0] + bx[2]) / 2));
  const free = (r) => !fixed.some((a) => overlap(a, r) > 0) && !labels.some((a) => overlap(a, r) > 0.3);
  for (const y of [bx[1] - 4 - lh, bx[3] + 4]) {
    const r = [cx - lw / 2, y, cx + lw / 2, y + lh];
    if (y >= band && y + lh <= bottom && free(r)) return { x: cx, y, box: r };
  }
  return null;
}
