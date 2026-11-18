// Handwriting on top of a note's pages (pen, highlighter). It is kept only on this device
// (IndexedDB store "ink", one record per note) and never written into the note's own file.
//
// A record: {pages: {"<page number>": {v: <note version it was written on>, s: [stroke…]}}}
// A stroke: {k: 'pen' | 'hl', c: <colour key>, w: <width>, p: [x0, y0, x1, y1, …]}
// Coordinates and widths are in the page's own units (PDF.js viewport at scale 1, so a rotated
// or cropped page lines up the same way it is shown).

import { idb } from './store.js';

/** Colour keys → colours (the page shows them through CSS; exports use these). */
export const PEN_COLORS = { k: '#1d2321', b: '#1f5fd1', r: '#d4382c', g: '#1d8a4a' };
export const HL_COLORS = { y: '#ffd23f', g: '#7fe08c', p: '#ff93bd', b: '#86c8ff' };
export const HL_OPACITY = 0.38;

/** Stroke width for a tool and size (0 thin, 1 thick), from the page's width. */
export function strokeWidth(tool, size, pageW) {
  const f = tool === 'hl' ? [0.022, 0.036] : [0.0028, 0.0056];
  return Math.round(pageW * f[size ? 1 : 0] * 100) / 100;
}

const STORE = 'ink';
const INDEX = 'gnv.inkIndex'; // {id: pages with handwriting}: settings show it without waiting
// Writing whose database save may not finish (the page going away cuts it off):
// {id: {pages, lost, s: session, t: token, g: generation}}, kept at once, moved into the
// database the next time the app starts, dropped once a save at least as new has finished.
const PENDING = 'gnv.inkPending';
// Bumped by "delete all writing": a save made from writing read before that is dropped (another
// tab, a save still on its way), and open notes drop what they hold (the storage event).
const GEN = 'gnv.inkGen';
// The last save of a note ({id, s}), so other tabs showing it read it again.
export const SAVED = 'gnv.inkSaved';
export const MAX_POINTS = 5000; // per stroke (a longer one stops growing)

const SESSION = Math.random().toString(36).slice(2);
let tokens = 0;
/** A token for one snapshot of a note's writing: later snapshots get larger ones. */
export const nextToken = () => ++tokens;

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch { return fallback; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; }
}
const readIndex = () => readJSON(INDEX, {});
const writeIndex = (ix) => writeJSON(INDEX, ix);
/** The "delete all" generation now (see GEN). */
export const inkGeneration = () => Number(localStorage.getItem(GEN)) || 0;

function readPending() {
  const j = readJSON(PENDING, {});
  // (one note at a time, as a first test build kept it)
  if (typeof j.id === 'string' && j.pages) return { [j.id]: { pages: j.pages, lost: j.lost, g: inkGeneration() } };
  return j && typeof j === 'object' ? j : {};
}
/** A save finished: a kept copy of this session's writing that is not newer than it goes. */
function dropPending(id, token) {
  const j = readPending();
  const e = j[id];
  if (!e || (token != null && !(e.s === SESSION && e.t <= token))) return;
  delete j[id];
  if (Object.keys(j).length) writeJSON(PENDING, j); else localStorage.removeItem(PENDING);
}

// One storage change at a time (a save, a move to a new file id, deleting everything), so none
// works from what another is about to change.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isVersion = (v) => typeof v === 'string' || typeof v === 'number';

/** Only well-formed pages and strokes from a stored record (anything else is left out). */
export function cleanPages(pages) {
  const out = {};
  if (!pages || typeof pages !== 'object') return out;
  for (const key of Object.keys(pages)) {
    const n = Number(key);
    const e = pages[key];
    if (!Number.isInteger(n) || n < 1 || n > 100000 || !e || !Array.isArray(e.s)) continue;
    const s = [];
    for (const st of e.s) {
      if (!st || !Array.isArray(st.p) || st.p.length < 2 || st.p.length % 2) continue;
      const p = st.p.length > MAX_POINTS * 2 ? st.p.slice(0, MAX_POINTS * 2) : st.p;
      if (!p.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const hl = st.k === 'hl';
      const w = Number(st.w);
      const clean = {
        k: hl ? 'hl' : 'pen',
        c: own(hl ? HL_COLORS : PEN_COLORS, st.c) ? st.c : hl ? 'y' : 'k',
        w: Number.isFinite(w) && w > 0 && w < 1000 ? w : 1,
        p,
      };
      if (isVersion(st.v)) clean.v = st.v; // written on another version than the page's others
      s.push(clean);
    }
    if (s.length) out[n] = { v: isVersion(e.v) ? e.v : undefined, s };
  }
  return out;
}

/** Writing of pages taken out of a note: [{n: old page number, v, s}], kept but not shown. */
export function cleanLost(lost) {
  if (!Array.isArray(lost)) return [];
  const out = [];
  for (const g of lost) {
    if (!g || !Number.isInteger(g.n)) continue;
    const s = (cleanPages({ 1: { v: g.v, s: g.s } })[1] || {}).s;
    if (s && s.length) out.push({ n: g.n, v: isVersion(g.v) ? g.v : undefined, s });
  }
  return out;
}

/** Whether a note has handwriting stored. */
export function hasInk(id) {
  return !!readIndex()[id];
}

/** Notes with handwriting on this device. */
export function inkNoteCount() {
  return Object.keys(readIndex()).length;
}

/** Keep a snapshot of a note's writing at once (its database save may not finish); see PENDING. */
export function journalInk(id, pages, lost, token, gen) {
  const j = readPending();
  j[id] = { pages, lost, s: SESSION, t: token, g: gen };
  writeJSON(PENDING, j); // (full: the database save may still make it)
}

async function writePages(id, pages, lost = [], token = null) {
  const out = {};
  for (const [n, e] of Object.entries(pages)) if (e && e.s && e.s.length) out[n] = { v: e.v, s: e.s };
  const count = Object.keys(out).length || (lost.length ? 1 : 0);
  if (count) await idb.put(STORE, id, lost.length ? { pages: out, lost, at: Date.now() } : { pages: out, at: Date.now() });
  else await idb.del(STORE, id);
  const ix = readIndex(); // (read after the wait: another change may have landed meanwhile)
  if (count) ix[id] = count; else delete ix[id];
  writeIndex(ix);
  dropPending(id, token);
  writeJSON(SAVED, { id, s: SESSION, at: Date.now() });
}

/** Writing kept when the app went away last time: into the database now. */
export function recoverInk() {
  return serial(async () => {
    const j = readPending();
    const gen = inkGeneration();
    for (const [id, e] of Object.entries(j)) {
      if (e && e.s === SESSION) continue; // this run's own copies: its saves are on their way
      if (e && e.pages && typeof e.pages === 'object' && (e.g == null || e.g === gen)) {
        await writePages(id, cleanPages(e.pages), cleanLost(e.lost));
      }
      dropPending(id);
    }
  }).catch(() => { /* tried again next time */ });
}

export async function loadInk(id) {
  await recoverInk();
  try {
    const rec = await serial(() => idb.get(STORE, id));
    if (rec && rec.pages) return { pages: cleanPages(rec.pages), lost: cleanLost(rec.lost) };
  } catch { /* none */ }
  return { pages: {}, lost: [] };
}

/**
 * Store a note's handwriting (pages without strokes are left out; nothing left removes it).
 * `gen`: the "delete all" generation the writing was read in: older, and nothing is saved.
 * Resolves to whether it was saved.
 */
export function saveInk(id, pages, lost = [], token = null, gen = null) {
  return serial(async () => {
    if (gen != null && gen !== inkGeneration()) return false;
    await writePages(id, pages, lost, token);
    return true;
  });
}

/** Forget a note's handwriting (its writing now lives under another id). */
export function deleteInk(id) {
  return serial(() => writePages(id, {}));
}

/**
 * The same note under a new file id (see moveDocState): its handwriting goes with it, joining any
 * already there.
 */
export function moveInk(from, to) {
  return serial(async () => {
    const a = await idb.get(STORE, from);
    if (!a) return;
    const b = await idb.get(STORE, to);
    const pages = cleanPages(b && b.pages);
    for (const [n, e] of Object.entries(cleanPages(a.pages))) {
      const t2 = pages[n] || (pages[n] = { v: e.v, s: [] });
      for (const st of e.s) t2.s.push(st.v == null && e.v !== t2.v && e.v != null ? { ...st, v: e.v } : st);
    }
    await writePages(to, pages, [...cleanLost(b && b.lost), ...cleanLost(a.lost)]);
    await writePages(from, {});
  }).catch(() => { /* stays where it was */ });
}

export function clearAllInk() {
  return serial(async () => {
    writeJSON(GEN, inkGeneration() + 1); // first: saves of writing read before this are dropped
    localStorage.removeItem(PENDING);
    await idb.clear(STORE);
    writeIndex({});
  });
}

/** SVG path of a stroke, smoothed through the midpoints of its points. */
export function pathD(p) {
  const r = (v) => Math.round(v * 10) / 10;
  if (p.length < 2) return '';
  if (p.length < 4) return `M${r(p[0])} ${r(p[1])}l0.01 0`; // a dot
  let d = `M${r(p[0])} ${r(p[1])}`;
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2;
    const my = (p[i + 1] + p[i + 3]) / 2;
    d += `Q${r(p[i])} ${r(p[i + 1])} ${r(mx)} ${r(my)}`;
  }
  return d + `L${r(p[p.length - 2])} ${r(p[p.length - 1])}`;
}

/** Whether the eraser at (x, y) with radius `rad` touches the stroke. */
export function strokeHits(st, x, y, rad) {
  const p = st.p;
  const reach = rad + st.w / 2;
  const r2 = reach * reach;
  if (p.length === 2) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const tt = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    if ((ax + tt * dx - x) ** 2 + (ay + tt * dy - y) ** 2 <= r2) return true;
  }
  return false;
}

const colorOf = (st) => (st.k === 'hl' ? (own(HL_COLORS, st.c) ? HL_COLORS[st.c] : HL_COLORS.y) : own(PEN_COLORS, st.c) ? PEN_COLORS[st.c] : PEN_COLORS.k);

/** Draw strokes onto a canvas whose pixels are `scale` × the page's units (thumbnails, images). */
export function drawInk(ctx, strokes, scale) {
  if (!strokes || !strokes.length || typeof Path2D === 'undefined') return;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const st of strokes) {
    const d = pathD(st.p);
    if (!d) continue;
    ctx.globalAlpha = st.k === 'hl' ? HL_OPACITY : 1;
    ctx.globalCompositeOperation = st.k === 'hl' ? 'multiply' : 'source-over';
    ctx.strokeStyle = colorOf(st);
    ctx.lineWidth = st.w;
    ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}

/**
 * Draw strokes into a pdf-lib page. `vt` is the PDF.js viewport transform at scale 1 of the same
 * page ([a, b, c, d, e, f]: page space → the shown page), so the strokes land where they were
 * written whatever the page's rotation or crop box.
 */
export function inkIntoPdfPage(lib, page, strokes, vt) {
  const { rgb, BlendMode, LineCapStyle, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = lib;
  const [a, b, c, d, e, f] = vt;
  const det = a * d - b * c;
  if (!det) return;
  // The inverse of vt (shown page → page space), then drawSvgPath's own flip (y → −y) undone.
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  const ie = (c * f - d * e) / det, iff = (b * e - a * f) / det;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(ia, ib, -ic, -id, ie, iff));
  for (const st of strokes) {
    const path = pathD(st.p);
    if (!path) continue;
    const hex = colorOf(st);
    const col = rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
    page.drawSvgPath(path, {
      x: 0,
      y: 0,
      borderColor: col,
      borderWidth: st.w,
      borderOpacity: st.k === 'hl' ? HL_OPACITY : 1,
      borderLineCap: LineCapStyle.Round,
      blendMode: st.k === 'hl' ? BlendMode.Multiply : BlendMode.Normal,
    });
  }
  page.pushOperators(popGraphicsState());
}
