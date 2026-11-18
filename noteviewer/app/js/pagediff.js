// Which pages changed between two versions of a note: each page is drawn very small and turned
// into a short fingerprint, kept per note on the phone. When a newer version is opened, pages
// whose fingerprint differs from the version read before are the ones that changed.

const WIDTH = 128; // px across the page for the fingerprint: small edits still show
// A different drawing method (or browser engine, which updates by itself) gives different prints:
// prints are compared only with ones made the same way.
export const FP_TAG = 'v1/' + ((typeof navigator !== 'undefined' && (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1]) || '');

/**
 * Fingerprint of one page (a number), or null when it can't be drawn. `keep`: the page is on
 * screen, so PDF.js keeps its parsed drawing; otherwise it is let go afterwards (memory).
 */
export async function fingerprint(doc, i, keep = false) {
  let page;
  try {
    page = await doc.getPage(i + 1);
  } catch {
    return null;
  }
  const base = page.getViewport({ scale: 1 });
  // 128 px across, or less for a very tall page so all of it fits in 512 px.
  const vp = page.getViewport({ scale: Math.min(WIDTH / base.width, (4 * WIDTH) / base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  try {
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let h = 0x811c9dc5;
    for (let k = 0; k < px.length; k += 4) {
      // Brightness in 8 steps: the same drawing gives the same print; ink makes a difference.
      const v = ((px[k] * 3 + px[k + 1] * 6 + px[k + 2]) / 10) >> 5; // 0..7
      h = Math.imul(h ^ v, 0x01000193);
    }
    return h >>> 0;
  } catch {
    return null;
  } finally {
    canvas.width = canvas.height = 0;
    if (!keep) try { page.cleanup(); } catch { /* still drawing elsewhere: it frees itself later */ }
  }
}

/**
 * Pages (1-based) of the newer version that are new or changed: the two lists of prints are
 * lined up by content (longest common sequence), so a page inserted in the middle doesn't make
 * every page after it look changed.
 */
export function changedPages(before, after) {
  const matched = alignPages(before, after);
  const out = [];
  for (let j = 0; j < matched.length; j++) if (matched[j] === -1 && after[j] != null) out.push(j + 1);
  return out;
}

/** Pages of two versions lined up by content (longest common sequence): [[old, new, same print]]. */
function lineUp(before, after) {
  const a = before.slice(0, 1500);
  const b = after.slice(0, 1500);
  const n = a.length;
  const m = b.length;
  // Equal prints match first; a page that couldn't be drawn (either side) is unknown, not a
  // change: it may match anything, but never at the cost of a real match. A real match is worth
  // more than every possible unknown one together (at most 1500).
  const KNOWN = 1501;
  const score = (i, j) => (a[i] == null || b[j] == null ? 1 : a[i] === b[j] ? KNOWN : 0);
  // Best score of lining up from (i, j) to the end (at most 1500 × 1501: fits in 32 bits).
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      L[i * W + j] = Math.max(s ? L[(i + 1) * W + j + 1] + s : 0, L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const pairs = []; // [old index, new index, same print]
  for (let i = 0, j = 0; i < n && j < m;) {
    const s = score(i, j);
    if (s && L[i * W + j] === L[(i + 1) * W + j + 1] + s) { pairs.push([i, j, s === KNOWN]); i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
  }
  return pairs;
}

/**
 * For each of the first 1500 pages of the newer version, the index of the same page in the older
 * version; −1 when it is new or changed, −2 when it lines up with a page that couldn't be drawn
 * (either side: not known to be the same).
 */
export function alignPages(before, after) {
  const matched = new Int32Array(Math.min(after.length, 1500)).fill(-1);
  // (an unknown page lined up with anything is not the same page: only equal prints count)
  for (const [i, j, same] of lineUp(before, after)) matched[j] = same ? i : -2;
  return matched;
}

/**
 * Where each page of the older version went in the newer one (for writing kept on top of pages):
 * for each old index, {to: new index, changed: whether its content changed}, or null when the page
 * is gone. Pages lined up by content anchor the rest; between two anchors, old and new pages that
 * didn't line up are paired in order (edited pages), and old pages left over were taken out.
 * Pages past the first 1500 keep their numbers.
 */
export function followPages(before, after) {
  const out = new Array(before.length).fill(null);
  const pairs = lineUp(before, after);
  const anchors = [[-1, -1], ...pairs, [Math.min(before.length, 1500), Math.min(after.length, 1500)]];
  for (const [i, j, same] of pairs) out[i] = { to: j, changed: !same && before[i] != null && after[j] != null };
  // Pages that swapped places can't all line up in order: an old page left over whose print appears
  // exactly once among the new pages left over (and once among the old) is that page, moved.
  const usedNew = new Set(pairs.map(([, j]) => j));
  const count = (arr, isFree) => {
    const m = new Map();
    arr.forEach((v, k) => { if (v != null && k < 1500 && isFree(k)) m.set(v, m.has(v) ? -1 : k); });
    return m;
  };
  const oldLeft = count(before, (k) => !out[k]);
  const newLeft = count(after, (k) => !usedNew.has(k));
  for (const [v, i] of oldLeft) {
    const j = newLeft.get(v);
    if (i >= 0 && j != null && j >= 0) { out[i] = { to: j, changed: false }; usedNew.add(j); }
  }
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [i0, j0] = anchors[k];
    const [i1, j1] = anchors[k + 1];
    // Old and new pages still left between two anchors are paired in order (edited pages).
    const olds = [];
    const news = [];
    for (let i = i0 + 1; i < i1; i++) if (!out[i]) olds.push(i);
    for (let j = j0 + 1; j < j1; j++) if (!usedNew.has(j)) news.push(j);
    for (let d = 0; d < Math.min(olds.length, news.length); d++) out[olds[d]] = { to: news[d], changed: true };
  }
  for (let i = 1500; i < before.length; i++) out[i] = i < after.length ? { to: i, changed: false } : null;
  return out;
}
