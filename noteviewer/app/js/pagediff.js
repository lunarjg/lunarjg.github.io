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
  const matched = new Uint8Array(m);
  for (let i = 0, j = 0; i < n && j < m;) {
    const s = score(i, j);
    if (s && L[i * W + j] === L[(i + 1) * W + j + 1] + s) { matched[j] = 1; i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++;
  }
  const out = [];
  for (let j = 0; j < m; j++) if (!matched[j] && b[j] != null) out.push(j + 1);
  return out;
}
