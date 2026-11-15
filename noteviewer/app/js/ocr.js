// Handwriting search: pages are rendered here and read by ML Kit text recognition inside the
// Android app, on the phone (the page images never leave it). Results are kept per note version
// in IndexedDB, so each page is recognized once.

import { idb, settings } from './store.js';
import { currentLang } from './i18n.js';

const OCR_WIDTH = 1600; // px across the page handed to the recognizer
const MAX_PX = 5e6;
const TEXT_PAGE = 600; // pages with this much real (typed) text are searched by their text layer only

export const ocrSupported = () => !!(window.GNVNative && window.GNVNative.ocr);
export const ocrOn = () => ocrSupported() && !!settings.ocr;

const pending = new Map();
let seq = 0;
window.__gnvOcr = (id, json) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  try { p.resolve(JSON.parse(json)); } catch (e) { p.reject(e); }
};

/**
 * Which ML Kit recognizer reads the handwriting: Japanese or Chinese with the app in that
 * language, otherwise the Korean one (it also reads Latin letters). Older apps know only Korean.
 */
export function ocrModel() {
  if (!window.GNVNative || !window.GNVNative.ocrIn) return 'ko';
  const l = currentLang();
  return l === 'ja' || l === 'zh' ? l : 'ko';
}

function callNative(b64, model) {
  return new Promise((resolve, reject) => {
    const id = 'o' + (++seq);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 90_000);
    pending.set(id, { resolve, reject, timer });
    if (window.GNVNative.ocrIn) window.GNVNative.ocrIn(id, b64, model);
    else window.GNVNative.ocr(id, b64);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Recognize one page: {t, l: [{t, b: [x, y, w, h]}]}, boxes as fractions of the page and `t` the
 * lines joined with "\n". `onWait` runs while Google Play services is still fetching the
 * recognizer (first use only).
 */
async function recognize(page, onWait, stop, model) {
  const base = page.getViewport({ scale: 1 });
  let scale = OCR_WIDTH / base.width;
  const px = base.width * base.height * scale * scale;
  if (px > MAX_PX) scale *= Math.sqrt(MAX_PX / px);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let b64;
  try {
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    b64 = canvas.toDataURL('image/jpeg', 0.85).replace(/^data:[^,]*,/, '');
  } finally {
    canvas.width = canvas.height = 0;
  }
  for (let tries = 0; ; tries++) {
    const r = await callNative(b64, model);
    if (r.error === 'model' && tries < 60) {
      if (onWait) onWait();
      await sleep(3000);
      if (stop && stop()) throw new Error('cancelled');
      continue;
    }
    if (r.error) throw new Error(r.error);
    const lines = (r.lines || []).filter((l) => l && l.t);
    return { t: lines.map((l) => l.t).join('\n'), l: lines };
  }
}

/**
 * Saved results for this version of the note, read by the current recognizer, or null.
 * {modifiedTime, model, n, pages: {index: page}}
 */
export async function loadOcr(id, modifiedTime) {
  try {
    const rec = await idb.get('ocr', id);
    return rec && rec.modifiedTime === (modifiedTime || '') && (rec.model || 'ko') === ocrModel() ? rec : null;
  } catch {
    return null;
  }
}

export const doneCount = (rec) => (rec ? Object.keys(rec.pages).length : 0);

let chain = Promise.resolve();

/**
 * Recognize every page of `doc` that has no result yet, saving after each page. One job runs at a
 * time across the app; later jobs wait their turn. `texts` (the text layer per page, optional)
 * lets typed pages skip recognition.
 */
export function indexDoc({ id, modifiedTime, doc, texts, onPage, onWait, isCancelled }) {
  const job = chain.then(async () => {
    const stop = () => !ocrOn() || (isCancelled && isCancelled()); // switched off: stop too
    if (stop()) return null;
    const model = ocrModel();
    const rec = (await loadOcr(id, modifiedTime)) || { modifiedTime: modifiedTime || '', model, n: doc.numPages, pages: {} };
    // Saving rewrites the whole record: every few pages (and at the end), not after each one.
    let unsaved = 0;
    let savedAt = Date.now();
    const save = async () => {
      if (!unsaved || !ocrOn()) return; // switched off: what was read must not come back
      unsaved = 0;
      savedAt = Date.now();
      try { await idb.put('ocr', id, rec); } catch (e) { console.warn('ocr save failed', e); }
    };
    try {
      for (let i = 0; i < doc.numPages; i++) {
        if (rec.pages[i]) continue;
        if (stop()) break;
        if (texts && (texts[i] || '').replace(/\s+/g, '').length >= TEXT_PAGE) {
          rec.pages[i] = { t: '', l: [], typed: true };
        } else {
          const page = await doc.getPage(i + 1);
          if (stop()) break;
          const read = await recognize(page, onWait, stop, rec.model || model);
          if (!ocrOn()) break; // switched off while reading: what was deleted must stay deleted
          rec.pages[i] = read;
          if (stop()) { unsaved++; break; } // closed meanwhile: keep this page anyway
        }
        if (stop()) break;
        unsaved++;
        if (unsaved >= 8 || Date.now() - savedAt > 5000) await save();
        if (onPage) onPage(rec, i);
      }
    } finally {
      await save(); // also when the note was closed under it (the PDF is gone)
    }
    return rec;
  });
  chain = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------- matching
/** Lower-cased text without spaces, plus where each kept character came from. */
function squash(text) {
  let s = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) continue;
    const low = c.toLowerCase();
    s += low.length === 1 ? low : c;
    map.push(i);
  }
  return { s, map };
}

/**
 * Every place `q` occurs in `text`, ignoring case and spaces (handwriting is read with uneven
 * spacing, e.g. "고유 값" for "고유값"). [{at, end}] as positions in `text`.
 */
export function findAll(text, q) {
  const needle = squash(q).s;
  if (!needle || !text) return [];
  const { s, map } = squash(text);
  const out = [];
  let at = s.indexOf(needle);
  while (at >= 0) {
    out.push({ at: map[at], end: map[at + needle.length - 1] + 1 });
    at = s.indexOf(needle, at + needle.length);
  }
  return out;
}

/** Area of the recognized lines that a match [at, end) in page.t spans, as page fractions. */
export function boxFor(page, at, end) {
  let pos = 0;
  let box = null;
  for (const l of page.l) {
    const lineEnd = pos + l.t.length;
    if (lineEnd > at && pos < end && l.b) {
      const [x, y, w, h] = l.b;
      if (!box) box = [x, y, x + w, y + h];
      else box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + w), Math.max(box[3], y + h)];
    }
    pos = lineEnd + 1; // "\n"
    if (pos >= end) break;
  }
  return box && [box[0], box[1], box[2] - box[0], box[3] - box[1]];
}
