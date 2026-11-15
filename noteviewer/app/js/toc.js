// Automatic table of contents for PDFs without one (no bookmarks): found on the phone from
// - a printed contents page ("목차 / Contents" with "title …… 12" lines), mapped to PDF pages;
// - chapter headings: lines near the top of a page in a clearly bigger font, or numbered like
//   "3강", "제2장", "Chapter 4", "第3章" (running headers, with or without page numbers, ignored);
// - with handwriting search on, the same rules on the recognized handwriting.
// Plain rules on the text's size, position and numbering — no model.

const CHAPTER_WORD = /^(chapter|chap\.|part|section|unit|lesson|lecture|week|module)\s*([0-9]+|[A-Za-z]+)\b/i;
const CHAPTER = [
  /^제?\s*\d+\s*(장|강|편|부|절|과|단원|주차|교시|회)(\s|$|[.:·])/,
  /^第?\s*[\d一二三四五六七八九十百]+\s*(章|節|节|講|讲|課|课|部|編|编|回)/,
  /^(capítulo|cap\.|tema|parte|lección|unidad)\s*\d+/i,
];
const NUMBERED = /^(\d+(\.\d+){0,2}|[IVX]+)[.)]?\s+\S/;
const CONTENTS = /^(목차|차례|contents|tableofcontents|目次|目录|目錄|índice|indice|sumario)$/; // squashed
// "title …… 12" / "title   12" (a number column) / "title 12" (only on the contents page itself)
const ENTRY = /^(.*?\S)\s*(?:[.·…_\-–—]{2,}\s*|\s{2,}|\s)(\d{1,4})$/;
const ENTRY_STRICT = /^(.*?\S)\s*(?:[.·…_\-–—]{2,}\s*|\s{2,})(\d{1,4})$/;

const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
const MAX_ENTRIES = 400; // contents lines kept (bounds the work and the list)
const MAX_LINE = 200; // longer "lines" are never contents entries (and would slow the pattern)
const MAX_ITEMS = 3000; // text pieces read per page (the top ones; headings are near the top)
const key = (s) => squash(s.slice(0, MAX_LINE));
const numKey = (s) => '#' + key(s).replace(/\d+/g, '#'); // "Chapter 1. Methods 7" ~ "… 8"
const words = (s) => s.trim().split(/\s+/).length;

function isChapter(s) {
  const m = s.match(CHAPTER_WORD);
  if (m) return /^\d+$/.test(m[2]) || /^[IVXLC]+$/.test(m[2]); // "Part 3", "Part IV" — not "Part civil"
  return CHAPTER.some((re) => re.test(s));
}

/** Text of pieces in reading order: no space inside a word drawn letter by letter. */
function joinParts(parts) {
  let out = '';
  let prev = null;
  for (const p of parts) {
    if (prev) {
      const gap = prev.w ? p.x - (prev.x + prev.w) : Infinity;
      out += gap > Math.max(prev.size, p.size) * 0.15 ? ' ' : '';
    }
    out += p.str;
    prev = p;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Text lines of a page, top to bottom: [{text, title, size, y, runs, row, rowText}]. Pieces on one
 * height far apart (columns, a page-number column) become separate lines of the same row;
 * rowText is the whole row with wide gaps kept as two spaces. y is a fraction of the page height,
 * runs = [[size, characters]] of the pieces, title = the line without smaller side text.
 */
async function pageLines(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const size = it.height || Math.hypot(it.transform[2], it.transform[3]);
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    items.push({ str: it.str, size, x, y, w: it.width || 0 });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of items.slice(0, MAX_ITEMS)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(it.y - last.vy) < Math.max(it.size, last.size) * 0.5) {
      last.parts.push(it);
      last.size = Math.max(last.size, it.size);
    } else {
      rows.push({ vy: it.y, size: it.size, parts: [it] });
    }
  }
  const lines = [];
  rows.forEach((r, row) => {
    r.parts.sort((a, b) => a.x - b.x);
    const segs = [[r.parts[0]]];
    for (let k = 1; k < r.parts.length; k++) {
      const a = r.parts[k - 1];
      const b = r.parts[k];
      const gap = a.w ? b.x - (a.x + a.w) : 0;
      if (gap > Math.max(a.size, b.size) * 2) segs.push([b]); else segs[segs.length - 1].push(b);
    }
    const rowText = segs.map(joinParts).join('  ');
    for (const parts of segs) {
      const size = Math.max(...parts.map((p) => p.size));
      const text = joinParts(parts);
      if (!text) continue;
      lines.push({
        text,
        title: joinParts(parts.filter((p) => p.size >= size * 0.8)),
        size,
        y: vp.height ? r.vy / vp.height : 0,
        runs: parts.map((p) => [p.size, p.str.trim().length]),
        row,
        rowText,
      });
    }
  });
  return lines;
}

/** Median of a {value: count} histogram. */
function median(hist) {
  let total = 0;
  for (const n of hist.values()) total += n;
  let seen = 0;
  for (const v of [...hist.keys()].sort((a, b) => a - b)) {
    seen += hist.get(v);
    if (seen * 2 > total) return v;
  }
  return 0;
}
const count = (hist, v, n = 1) => { const k = Math.round(v * 10) / 10; hist.set(k, (hist.get(k) || 0) + n); };

/** Whole rows of a page (contents entries span the title and the page-number column). */
function rowsOf(lines) {
  const out = [];
  for (const l of lines) if (!out.length || out[out.length - 1].row !== l.row) out.push(l);
  return out.map((l) => l.rowText);
}

/** "Contents" pages near the front: [{title, printed, from}] (printed page numbers). */
function contentsEntries(pages) {
  const out = [];
  const limit = Math.min(pages.length, Math.max(6, Math.ceil(pages.length * 0.15)));
  for (let i = 0; i < limit; i++) {
    const rows = rowsOf(pages[i]);
    const head = rows.findIndex((t) => CONTENTS.test(squash(t)));
    if (head < 0) continue;
    // This page, and the next ones while they look like contents (leaders or a number column).
    for (let k = i; k < Math.min(pages.length, i + 6); k++) {
      const found = [];
      const pattern = k === i ? ENTRY : ENTRY_STRICT;
      for (const t of k === i ? rows.slice(head + 1) : rowsOf(pages[k])) {
        if (t.length > MAX_LINE || out.length + found.length >= MAX_ENTRIES) continue;
        const m = t.match(pattern);
        if (m && m[1].length >= 2 && !/^\d+$/.test(m[1])) {
          found.push({ title: m[1].replace(/[\s.·…_\-–—]+$/, '').slice(0, 120), printed: +m[2], from: k });
        }
      }
      if (found.length < 2 && k > i) break;
      out.push(...found);
    }
    if (out.length >= 2) {
      // Page numbers in a contents list only go up; anything else is ordinary text.
      let last = 0;
      return out.filter((e) => (e.printed >= last ? ((last = e.printed), true) : false));
    }
  }
  return [];
}

/** Printed page number → PDF page index, from page labels or from where the titles appear. */
function mapContents(entries, pages, labels) {
  const after = entries.length ? entries[entries.length - 1].from + 1 : 0;
  const tops = pages.map((lines) => lines.slice(0, 6).map((l) => key(l.text))); // once, not per entry
  const appearsOn = (e, i) => i >= 0 && i < pages.length && tops[i].some((t) => t.includes(squash(e.title).slice(0, 24)));
  // Offset between printed numbers and PDF pages, voted by titles found at the top of a page.
  const votes = new Map();
  for (const e of entries.slice(0, 60)) { // enough votes to settle the offset
    if (squash(e.title).length < 3) continue;
    for (let i = after; i < pages.length; i++) {
      if (appearsOn(e, i)) { votes.set(i - e.printed, (votes.get(i - e.printed) || 0) + 1); break; }
    }
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  const voted = best && best[1] >= Math.min(2, entries.length) ? best[0] : null;
  if (labels) {
    const at = new Map(labels.map((l, i) => [String(l).trim(), i]));
    const mapped = entries.map((e) => ({ ...e, page: at.has(String(e.printed)) ? at.get(String(e.printed)) : -1 })).filter((e) => e.page >= 0);
    // Labels can be plain physical numbers; trust them when the titles are where they say.
    const confirmed = mapped.filter((e) => appearsOn(e, e.page)).length;
    if (mapped.length >= entries.length * 0.6 && (voted === null || confirmed * 2 >= mapped.length)) return mapped;
  }
  if (voted === null) return [];
  return entries.map((e) => ({ ...e, page: e.printed + voted })).filter((e) => e.page >= 0 && e.page < pages.length);
}

/**
 * Headings found on the pages themselves. body: the ordinary text size; seen: how many pages
 * each top line appears on (running headers repeat on many pages and are not chapters).
 */
function headings(pages, body, seen) {
  const often = (k) => pages.length >= 4 && (seen.get(k) || 0) >= Math.max(3, pages.length * 0.3);
  // The same text on many pages, or the same apart from numbers in a small font (a header with
  // the page number), is a running header.
  const repeated = (l) => often(key(l.text)) || (often(numKey(l.text)) && l.size / body < 1.15);
  const out = [];
  pages.forEach((lines, page) => {
    let best = null;
    lines.forEach((l, k) => {
      if (l.y > 0.45 || l.text.length < 2 || l.text.length > 80 || /^[\d\s./:-]+$/.test(l.text) || repeated(l)) return;
      const ratio = l.size / body;
      const name = l.title || l.text;
      const chapter = isChapter(name);
      const short = words(name) <= 6 && name.length <= 60;
      // At body size a numbered title counts only when it opens the page as its biggest line.
      const opens = k === 0 && ratio >= 1 && lines.every((o) => o === l || o.size < l.size);
      let score = 0;
      if (chapter && (ratio >= 1.2 || (short && (ratio >= 1.05 || opens)))) score = ratio + 1;
      else if (NUMBERED.test(name) && short && ratio >= 1.2) score = ratio + 0.3;
      else if (ratio >= 1.35) score = ratio;
      if (score && (!best || score > best.score)) best = { title: name, page, score, chapter, level: chapter || ratio >= 1.8 ? 0 : 1 };
    });
    if (best) out.push(best);
  });
  // The same title on the next pages (a slide continued) counts once.
  return out.filter((h, k) => !k || squash(h.title) !== squash(out[k - 1].title));
}

/** Headings in recognized handwriting: big writing near the top, or numbered like a chapter. */
function inkHeadings(ink, n) {
  const heights = new Map();
  for (let i = 0; i < n; i++) for (const l of (ink.pages[i] && ink.pages[i].l) || []) if (l.b) count(heights, l.b[3] * 1000);
  const body = (median(heights) || 1) / 1000;
  const out = [];
  for (let i = 0; i < n; i++) {
    const lines = (ink.pages[i] && ink.pages[i].l) || [];
    let best = null;
    for (const l of lines) {
      if (!l.b || typeof l.t !== 'string' || l.b[1] > 0.35 || l.t.length < 2 || l.t.length > 60) continue;
      const ratio = l.b[3] / body;
      const chapter = isChapter(l.t) && words(l.t) <= 6 && ratio >= 1;
      const score = chapter ? ratio + 1 : ratio >= 1.5 && l.b[1] < 0.25 ? ratio : 0;
      if (score && (!best || score > best.score)) best = { title: l.t, page: i, score, chapter, level: chapter ? 0 : 1 };
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * [{title, page, level}] for a document without bookmarks (empty when nothing convincing).
 * ink: saved handwriting recognition of this note (or null).
 */
export async function detectToc(doc, { ink = null, onProgress, isCancelled } = {}) {
  // Kept per page: every line where a contents page may be (the front), elsewhere only the
  // lines in the top part, where headings are. Text sizes and repeated lines are counted on the way.
  const front = Math.min(doc.numPages, Math.max(6, Math.ceil(doc.numPages * 0.15)) + 6);
  const pages = [];
  const sizes = new Map();
  const seen = new Map();
  for (let i = 1; i <= doc.numPages; i++) {
    if (isCancelled && isCancelled()) return null;
    let lines = [];
    try { lines = await pageLines(await doc.getPage(i)); } catch { /* unreadable page */ }
    // Ordinary text size: per character of every run (a title sharing a line with a small date
    // must not make the whole line look like body text).
    for (const l of lines) for (const [size, n] of l.runs) count(sizes, size, Math.min(n, 40));
    const top = lines.filter((l) => l.y <= 0.45).slice(0, 40);
    for (const t of new Set(top.flatMap((l) => [key(l.text), numKey(l.text)]))) seen.set(t, (seen.get(t) || 0) + 1);
    const keep = i <= front ? lines.slice(0, 400) : top;
    for (const l of keep) delete l.runs;
    pages.push(keep);
    if (onProgress && (i < 10 || i % 5 === 0 || i === doc.numPages)) onProgress(i, doc.numPages);
  }
  let labels = null;
  try { labels = await doc.getPageLabels(); } catch { /* none */ }
  if (isCancelled && isCancelled()) return null;
  const printed = contentsEntries(pages);
  if (printed.length >= 3) {
    const mapped = mapContents(printed, pages, labels);
    if (mapped.length >= 3) {
      return mapped.sort((a, b) => a.page - b.page).map((e) => ({
        title: e.title,
        page: e.page,
        level: isChapter(e.title) || (/^\d+[.)]?\s/.test(e.title) && !/^\d+\.\d/.test(e.title)) ? 0 : 1,
      }));
    }
  }
  let found = headings(pages, median(sizes) || 1, seen);
  if (ink) {
    const have = new Set(found.map((h) => h.page));
    for (const h of inkHeadings(ink, doc.numPages)) if (!have.has(h.page)) found.push(h);
    found.sort((a, b) => a.page - b.page);
  }
  // A heading on most pages (slides) is just each page's title: keep numbered chapters only.
  if (doc.numPages >= 6 && found.length >= doc.numPages * 0.85) found = found.filter((h) => h.chapter);
  if (found.length < 2 && doc.numPages > 3) return [];
  return found.map(({ title, page, level }) => ({ title, page, level }));
}
