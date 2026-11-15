// Documents → PDF, on the device (nothing is uploaded). A Word document (.docx) is laid out by
// docx-preview in a hidden, script-less frame; the app then breaks it into pages itself (the
// browser's column layout does the breaking between lines), draws each page into a picture and
// writes a PDF: the picture of each page, with the page's text over it, invisible, at the same
// place. So search, chapters, highlights and everything else that reads PDF text keep working.
//
// Loaded only when a document is converted (see formats.js for what is shown in the library).

import JSZip from '../vendor/jszip/jszip.mjs';
import { renderAsync } from '../vendor/docx-preview/docx-preview.mjs';
import { renderOwpml, pictureUrl, picturePixels, formatNumber, NUM_FORMATS, NUM_MARK_BASE } from './hwpx.js';
import { readHwp, HwpError } from './hwp5.js';
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFRawStream, pushGraphicsState, popGraphicsState,
  beginText, endText, setFontAndSize, setTextRenderingMode, setTextMatrix, showText, setCharacterSqueeze,
  concatTransformationMatrix, drawObject,
} from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { t } from './i18n.js';

const PT = 0.75; // PDF points per CSS pixel
const SCALE = 2.5; // picture pixels per CSS pixel (about 240 dpi)
const MAX_PAGE_PX = 1.4e7; // pixels in one page picture
const MAX_PAGES = 500;
const MAX_PDF = 300 * 1024 * 1024; // page pictures in the PDF (pages full of photos or noise)
const MAX_INPUT = 60 * 1024 * 1024;
const MAX_UNPACKED = 150 * 1024 * 1024; // (pictures in a document are packed already: real ones stay far below)
const MAX_ENTRIES = 20000;
const MAX_XML = 60 * 1024 * 1024; // the document's text, unpacked
const MAX_PARAGRAPHS = 60000;
const MAX_TEXT = 2_000_000; // characters of text (about 1000 full pages)
const MAX_PIXELS_ONE = 40e6; // one picture, decoded
const MAX_PIXELS_ALL = 120e6; // of all a Hangul document's pictures, decoded (about 480 MB)
const MAX_RUNS = 1_000_000; // lines of text kept for the text layer of all pages
const MAX_ELEMENTS = 600000; // in a Hangul document's sections (a long report: ~60 000)
const MAX_PICTURE = 30 * 1024 * 1024; // one picture in a Hangul document, unpacked
const MAX_PICTURES = 120 * 1024 * 1024; // all of them
const MAX_FONTS = 6 * 1024 * 1024; // fonts embedded in the document: larger ones are left out (every page carries them)
const FRAME_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PAGE_MARK = '\uE0F1';
const PAGES_MARK = '\uE0F2';
const BREAK_MARK = '_nvPageBreakBefore';

export class ConvertError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ConvertError';
    this.convert = true; // (checked by the app without loading this module)
  }
}

const abortError = () => new DOMException('Aborted', 'AbortError');
const jobs = [];
let running = null;
/**
 * A document (Blob) as a PDF Blob. One conversion runs at a time; one the user waits for goes
 * first, and stops a background one (opts.background), which the app tries again later.
 * opts: onProgress(0…1) (0 when it starts, then after each page), signal (stops it between
 * pages), key (which note version it is, for hurry()), title.
 */
export function toPdf(blob, fmt, opts = {}) {
  return new Promise((resolve, reject) => {
    const job = { blob, fmt, opts, resolve, reject, ctrl: new AbortController(), urgent: !opts.background };
    if (opts.signal) {
      if (opts.signal.aborted) { reject(abortError()); return; }
      opts.signal.addEventListener('abort', () => job.ctrl.abort(), { once: true });
    }
    if (job.urgent) {
      jobs.unshift(job);
      if (running && !running.urgent) running.ctrl.abort();
    } else jobs.push(job);
    pump();
  });
}

async function pump() {
  if (running) return;
  while (jobs.length) {
    const job = jobs.shift();
    if (job.ctrl.signal.aborted) { job.reject(abortError()); continue; }
    running = job;
    try {
      active = { signal: job.ctrl.signal, job, started: Date.now() };
      if (job.opts.onStart) job.opts.onStart();
      job.resolve(await convert(job.blob, job.fmt, { ...job.opts, signal: job.ctrl.signal }));
    } catch (e) {
      job.reject(e);
    }
    running = null;
    active = null;
  }
}

/**
 * The running conversion stops here when asked to (another one the user waits for, a closed
 * note), and a background one that takes too long gives up (it is converted when opened).
 */
let active = null;
const BACKGROUND_BUDGET = 120_000;
function check() {
  if (!active) return;
  stop(active.signal);
  if (!active.job.urgent && Date.now() - active.started > BACKGROUND_BUDGET) throw new ConvertError(t('convTooLarge'));
}

/** The background conversion of `key` (waiting or running) is now one the user waits for. */
export function hurry(key) {
  const job = running && running.opts.key === key ? running : jobs.find((j) => j.opts.key === key);
  if (!job || job.urgent) return;
  job.urgent = true;
  if (job !== running) {
    jobs.splice(jobs.indexOf(job), 1);
    jobs.unshift(job);
    if (running && !running.urgent) running.ctrl.abort();
  }
}

/** Whatever goes wrong is a ConvertError (shown as is, and not tried again in the background). */
async function convert(blob, fmt, opts) {
  try {
    return await convertNow(blob, fmt, opts);
  } catch (e) {
    if (e && (e.convert || e.name === 'AbortError')) throw e;
    console.warn('conversion failed', e);
    throw new ConvertError(t('convBroken'));
  }
}

async function convertNow(blob, fmt, { onProgress, signal, title = '' } = {}) {
  if (onProgress) onProgress(0);
  if (blob.size > MAX_INPUT) throw new ConvertError(t('convTooLarge'));
  const prep = fmt === 'docx' ? await prepareDocx(blob) : fmt === 'hwpx' ? await prepareHwpx(blob) : fmt === 'hwp' ? await prepareHwp(blob, title) : null;
  if (!prep) throw new ConvertError(t('convUnsupported'));
  const frame = document.createElement('iframe');
  // No scripts run in it; the app only lays the document out there and reads where things are.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('inert', '');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1400px;height:1400px;border:0;visibility:hidden;pointer-events:none';
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    // (text-size-adjust: the app's own text zoom must not reach the layout: pages are drawn without it)
    // (and nothing in the document can load anything from the network: only data: pictures and fonts)
    doc.write('<!doctype html><html style="-webkit-text-size-adjust:none;text-size-adjust:none"><head><meta charset="utf-8">'
      + `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"></head><body style="margin:0;background:#fff"></body></html>`);
    doc.close();
    const box = doc.createElement('div');
    doc.body.append(box);
    try {
      await prep.render(doc, box);
    } catch (e) {
      if (e && (e.convert || e.name === 'AbortError')) throw e;
      if (e && e.tooLarge) throw new ConvertError(t('convTooLarge'));
      console.warn('render failed', e);
      throw new ConvertError(t('convBroken'));
    }
    await settle(doc);
    stop(signal);
    tidy(doc);
    await settle(doc);
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n') + PAGE_CSS;
    const sections = [...doc.querySelectorAll('section.docx')];
    if (!sections.length) throw new ConvertError(t('convBroken'));
    const pages = [];
    const counters = { values: null }; // list numbers run on through the whole document
    for (let i = 0; i < sections.length; i++) {
      await layoutSection(doc, sections[i], pages, counters, i === sections.length - 1);
      if (pages.length > MAX_PAGES) throw new ConvertError(t('convTooLarge'));
      check();
    }
    const total = pages.length;
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    pdf.setProducer('Note Viewer');
    pdf.setCreator('Note Viewer');
    const font = textFont(pdf);
    const extra = new Map(); // characters past U+FFFF → the codes standing for them
    const canvas = document.createElement('canvas');
    let html = null;
    let htmlOf = null;
    let shift = 0;
    let pdfBytes = 0;
    for (let i = 0; i < total; i++) {
      check();
      const pg = pages[i];
      if (pg.slice) { html = serialize(doc, pageSection(pg)); htmlOf = null; shift = pg.shift; }
      else {
        if (htmlOf !== pg.sec) { html = serialize(doc, pg.sec); htmlOf = pg.sec; }
        shift = pg.fullShift;
      }
      const png = await drawPage(canvas, pg, html, css, shift, pg.no || i + 1, total);
      if ((pdfBytes += (png.gray || png.png).length) > MAX_PDF) throw new ConvertError(t('convTooLarge'));
      const page = pdf.addPage([pg.w * PT, pg.h * PT]);
      page.node.setXObject(PDFName.of('NVPage'), png.gray ? grayImage(pdf, png) : await pngImage(pdf, png.png));
      page.node.setFontDictionary(PDFName.of('NVText'), font.ref);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(pg.w * PT, 0, 0, pg.h * PT, 0, 0), drawObject('NVPage'), popGraphicsState());
      // (a distribution document: no text to copy or search, as its author chose)
      const ops = prep.restricted ? [] : textOps(pg, pg.no || i + 1, total, extra);
      for (let o = 0; o < ops.length; o += 2000) page.pushOperators(...ops.slice(o, o + 2000));
      if (onProgress) onProgress((i + 1) / total);
      await idle();
    }
    font.finish(extra);
    const bytes = await pdf.save({ useObjectStreams: false });
    const out = new Blob([bytes], { type: 'application/pdf' });
    if (prep.restricted) out.restricted = true;
    return out;
  } finally {
    frame.remove();
  }
}

/** The page-number marks in a page's markup or text: this page's number (in its format), the count. */
/** A 1×1 transparent PNG, in place of a picture that is left out. */
const BLANK_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
/** Start tags in an XML part's bytes: every "<" that isn't an end tag, a declaration or a comment. */
function countTags(b) {
  let n = 0;
  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] === 60) { const c = b[i + 1]; if (c !== 47 && c !== 63 && c !== 33) n++; }
  }
  return n;
}

/**
 * The private-use characters the converter marks page numbers with, as a document's own text
 * (written out or as a character reference), turned into a box so they don't become numbers.
 */
const OWN_MARKS = /[\uE0F1\uE0F2\uE100-\uE10F]|&#(?:[xX]0*(?:[eE]0[fF][12]|[eE]10[0-9a-fA-F])|0*(?:5758[56]|576(?:0\d|1[0-5])));/g;
const unmark = (xml) => xml.replace(OWN_MARKS, '\u25A1');

function pageNumbers(s, n, total) {
  return s.split(PAGE_MARK).join(String(n)).split(PAGES_MARK).join(String(total))
    .replace(/[\uE100-\uE10F]/g, (c) => formatNumber(n, NUM_FORMATS[c.charCodeAt(0) - NUM_MARK_BASE] || 'DIGIT'));
}

function stop(signal) {
  if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
}
const idle = () => new Promise((r) => setTimeout(r, 0));
const frameTick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** Fonts and pictures loaded, and docx-preview's late measuring (tab stops, shapes) done. */
async function settle(doc) {
  await frameTick();
  await frameTick();
  try { await doc.fonts.ready; } catch { /* no font loading */ }
  await Promise.all([...doc.images].map((img) => (img.complete ? null : img.decode().catch(() => {}))));
}

// ---------------------------------------------------------------------- the document file
/**
 * Checked and adjusted before laying out: not too big when unpacked; page numbers in headers and
 * footers marked (each page gets its own number); "page break before" and "no space between
 * paragraphs of the same style" (two things docx-preview ignores) written out.
 */
/** A ZIP file opened, after checking it isn't too big unpacked (whatever it says about itself). */
async function openZip(blob) {
  let zip;
  try { zip = await JSZip.loadAsync(blob); } catch { throw new ConvertError(t('convBroken')); }
  let unpacked = 0;
  let entries = 0;
  zip.forEach((path, f) => { unpacked += (f._data && f._data.uncompressedSize) || 0; entries++; });
  if (unpacked > MAX_UNPACKED || entries > MAX_ENTRIES || (await inflatedSize(zip)) > MAX_UNPACKED) throw new ConvertError(t('convTooLarge'));
  return zip;
}

/** Paragraphs (any namespace prefix) and characters of text: laying out more would take minutes. */
function checkText(text) {
  let paras = 0;
  for (const m of text.matchAll(/<(?:[\w.-]+:)?p[\s>\/]/g)) if (m && ++paras > MAX_PARAGRAPHS) throw new ConvertError(t('convTooLarge'));
  let chars = 0;
  for (const m of text.matchAll(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>([^<]*)</g)) if ((chars += m[1].length) > MAX_TEXT) throw new ConvertError(t('convTooLarge'));
}

/**
 * A Hangul HWPX package: its manifest (content.hpf) names the header, the sections in order and
 * the pictures. Only those are read.
 */
async function prepareHwpx(blob) {
  const zip = await openZip(blob);
  const hpf = await readXml(zip, 'Contents/content.hpf');
  const items = new Map();
  const order = [];
  if (hpf) {
    for (const it of hpf.getElementsByTagNameNS('*', 'item')) items.set(it.getAttribute('id'), it.getAttribute('href') || '');
    for (const r of hpf.getElementsByTagNameNS('*', 'itemref')) order.push(items.get(r.getAttribute('idref')) || '');
  }
  // (each section once: a list could name one over and over)
  let sectionPaths = [...new Set(order.filter((h) => /(^|\/)section\d+\.xml$/i.test(h) && zip.file(h)))];
  if (!sectionPaths.length) {
    sectionPaths = Object.keys(zip.files).filter((p) => /^Contents\/section\d+\.xml$/i.test(p))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/i)[1]) - Number(b.match(/(\d+)\.xml$/i)[1]));
  }
  const headerPath = [...items.values()].find((h) => /header\.xml$/i.test(h) && zip.file(h)) || 'Contents/header.xml';
  if (!sectionPaths.length || !zip.file(headerPath)) throw new ConvertError(t('convBroken'));
  let xml = 0;
  const texts = [];
  for (const path of [headerPath, ...sectionPaths]) {
    const text = await zip.file(path).async('string');
    if ((xml += text.length) > MAX_XML) throw new ConvertError(t('convTooLarge'));
    texts.push(unmark(text));
  }
  const docs = texts.map(parseXml);
  if (docs.some((d) => !d)) throw new ConvertError(t('convBroken'));
  const [header, ...sections] = docs;
  return owpml(header, sections, async (id) => {
    const href = items.get(id) || '';
    const f = (href && zip.file(href)) || zip.file(new RegExp('^BinData/' + id.replace(/[^\w.-]/g, '') + '\\.[a-z0-9]+$', 'i'))[0];
    if (!f || (f._data && f._data.uncompressedSize > MAX_PICTURE)) return null;
    return f.async('uint8array');
  });
}

/**
 * A Hangul document in HWPX's terms (from an HWPX file, or read from an HWP one): its limits
 * checked, and laid out by hwpx.js. `bytesOf(id)` gives a picture's bytes.
 */
function owpml(header, sections, bytesOf) {
  // Paragraphs and text of all sections together (text elements may hold tabs and the like, so
  // counted in the parsed document, not in the file's text)
  let paras = 0;
  let chars = 0;
  let elements = 0;
  for (const sec of sections) {
    paras += sec.getElementsByTagNameNS('*', 'p').length;
    // (and everything else: empty cells, shapes and tabs hold no paragraph or text)
    if ((elements += sec.getElementsByTagName('*').length) > MAX_ELEMENTS) throw new ConvertError(t('convTooLarge'));
    for (const tx of sec.getElementsByTagNameNS('*', 't')) chars += tx.textContent.length;
    if (paras > MAX_PARAGRAPHS || chars > MAX_TEXT) throw new ConvertError(t('convTooLarge'));
  }
  // Pictures: each one unpacked once however often it is used; too big ones (or too many) are
  // drawn as empty boxes.
  const pics = new Map();
  let picBytes = 0;
  let picPixels = 0; // (all the pictures are decoded at once: their pixels add up in memory)
  const picture = (id) => {
    if (!pics.has(id)) {
      pics.set(id, (async () => {
        try {
          const bytes = await bytesOf(id);
          if (!bytes || bytes.length > MAX_PICTURE || (picBytes += bytes.length) > MAX_PICTURES) return null;
          // (only pictures that are drawn count: one refused for its own size takes nothing)
          const n = picturePixels(bytes);
          if (!(n > 0) || n > MAX_PIXELS_ONE || picPixels + n > MAX_PIXELS_ALL) return null;
          picPixels += n;
          return pictureUrl(bytes);
        } catch { return null; }
      })());
    }
    return pics.get(id);
  };
  return { render: (doc, box) => renderOwpml({ header, sections, picture, maxPages: MAX_PAGES, maxText: MAX_TEXT * 2 }, doc, box, doc.head) };
}

/** An older Hangul document (HWP 5.0): read by hwp5.js into HWPX's terms. */
async function prepareHwp(blob, title) {
  let doc;
  try {
    doc = await readHwp(new Uint8Array(await blob.arrayBuffer()), {
      maxUnpacked: MAX_UNPACKED, maxParagraphs: MAX_PARAGRAPHS, maxText: MAX_TEXT, maxPicture: MAX_PICTURE, maxElements: MAX_ELEMENTS,
    });
  } catch (e) {
    if (e instanceof HwpError && e.kind === 'old') throw new ConvertError(t('oldHwp3', { name: String(title || '').replace(/\.hwp$/i, '') }));
    if (e instanceof HwpError) throw new ConvertError(t(e.kind === 'locked' ? 'convLocked' : e.kind === 'tooLarge' ? 'convTooLarge' : 'convBroken'));
    throw e;
  }
  return { ...owpml(doc.header, doc.sections, doc.binary), restricted: doc.restricted };
}

async function prepareDocx(blob) {
  const zip = await openZip(blob);
  if (!zip.file('word/document.xml')) throw new ConvertError(t('convBroken'));
  // Only what a Word document is made of goes on (anything else in the file is left out).
  const out = new JSZip();
  let xml = 0;
  let fonts = 0;
  let pixels = 0;
  let elements = 0;
  for (const [path, f] of Object.entries(zip.files)) {
    if (f.dir || !/^(\[Content_Types\]\.xml$|_rels\/|word\/|docProps\/)/.test(path)) continue;
    const bytes = await f.async('uint8array');
    if (/\.(xml|rels)$/i.test(path) && (xml += bytes.length) > MAX_XML) throw new ConvertError(t('convTooLarge'));
    if (/^word\/fonts\//i.test(path)) fonts += bytes.length;
    // (a picture too big to decode on a phone, or past what all of them may take: left out)
    if (!/\.(xml|rels)$/i.test(path) && !/^word\/fonts\//i.test(path)) {
      const n = picturePixels(bytes);
      if (n > MAX_PIXELS_ONE || pixels + n > MAX_PIXELS_ALL) { out.file(path, BLANK_PNG); continue; }
      pixels += n;
    }
    // (everything the document's text parts hold becomes an element on the page: counted, as a
    // small packed file can hold millions of empty runs)
    if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(path) && (elements += countTags(bytes)) > MAX_ELEMENTS) {
      throw new ConvertError(t('convTooLarge'));
    }
    if (/^word\/[^/]+\.xml$/i.test(path)) {
      const x = new TextDecoder().decode(bytes);
      OWN_MARKS.lastIndex = 0;
      if (OWN_MARKS.test(x)) { out.file(path, unmark(x)); continue; }
    }
    out.file(path, bytes);
  }
  const styles = await readStyles(out);
  for (const path of Object.keys(out.files)) {
    if (!/^word\/(header|footer)\d*\.xml$/i.test(path)) continue;
    const x = await readXml(out, path);
    if (x && markFields(x)) out.file(path, new XMLSerializer().serializeToString(x));
  }
  const text = await out.file('word/document.xml').async('string');
  checkText(text);
  const body = parseXml(text);
  if (body && adjustBody(body, styles)) out.file('word/document.xml', new XMLSerializer().serializeToString(body));
  const data = await out.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
  const fontsOff = fonts > MAX_FONTS;
  return {
    render: (doc, box) => renderAsync(data, box, doc.head, {
      inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: true, experimental: true,
      useBase64URL: true, renderComments: false, renderChanges: false, renderAltChunks: false, ignoreFonts: fontsOff,
    }),
  };
}

/**
 * How big the files really are unpacked (the sizes a ZIP states can lie): each one is unpacked by
 * the browser, counting, and given up once it is over the limit.
 */
async function inflatedSize(zip) {
  if (typeof DecompressionStream !== 'function') return 0;
  let total = 0;
  for (const f of Object.values(zip.files)) {
    const d = f._data;
    if (f.dir || !d || !d.compressedContent || !d.compression) continue;
    if (d.compression.magic === '\x00\x00') { total += d.compressedContent.length; continue; }
    if (d.compression.magic !== '\x08\x00') continue;
    // fed in small pieces: the browser unpacks each piece it is given at once
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    let over = false;
    const counting = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        total += value.length;
        if (total > MAX_UNPACKED) {
          over = true;
          reader.cancel().catch(() => {}); // (makes the pending write fail: the loop below ends)
          return;
        }
      }
    })();
    try {
      const data = d.compressedContent;
      for (let o = 0; o < data.length && !over; o += 16384) await writer.write(data.subarray(o, o + 16384));
      if (!over) await writer.close();
      await counting;
    } catch {
      if (!over) throw new ConvertError(t('convBroken'));
    } finally {
      reader.cancel().catch(() => {});
      writer.abort().catch(() => {});
    }
    if (over) return total;
  }
  return total;
}

async function readXml(zip, path) {
  const f = zip.file(path);
  return f ? parseXml(await f.async('string')) : null;
}
function parseXml(text) {
  const x = new DOMParser().parseFromString(text, 'application/xml');
  return x.getElementsByTagName('parsererror').length ? null : x;
}

const wAttr = (el, name) => (el ? el.getAttributeNS(W_NS, name) ?? el.getAttribute('w:' + name) : null);
const wKids = (el, name) => (el ? [...el.children].filter((c) => c.namespaceURI === W_NS && c.localName === name) : []);
const wKid = (el, name) => wKids(el, name)[0] || null;
const isOn = (el) => !!el && !/^(0|false|off)$/i.test(wAttr(el, 'val') || '');

/** Paragraph styles: {id: {basedOn, pageBreakBefore, contextualSpacing}}, and the default one. */
async function readStyles(zip) {
  const x = await readXml(zip, 'word/styles.xml');
  const map = {};
  let def = null;
  if (!x) return { map, def };
  for (const s of x.getElementsByTagNameNS(W_NS, 'style')) {
    if (wAttr(s, 'type') !== 'paragraph') continue;
    const id = wAttr(s, 'styleId');
    if (!id) continue;
    const ppr = wKid(s, 'pPr');
    const pb = wKid(ppr, 'pageBreakBefore');
    const cs = wKid(ppr, 'contextualSpacing');
    map[id] = { basedOn: wAttr(wKid(s, 'basedOn'), 'val'), pb: pb ? isOn(pb) : undefined, cs: cs ? isOn(cs) : undefined };
    if (/^(1|true|on)$/i.test(wAttr(s, 'default') || '')) def = id;
  }
  return { map, def };
}
function styleFlag(styles, id, key) {
  for (let n = 0, cur = id; cur && n < 20; n++) {
    const s = styles.map[cur];
    if (!s) return false;
    if (s[key] !== undefined) return s[key];
    cur = s.basedOn;
  }
  return false;
}

function adjustBody(x, styles) {
  let changed = inheritHeaders(x);
  let marks = 0;
  const paras = [...x.getElementsByTagNameNS(W_NS, 'p')];
  const first = paras[0];
  for (const p of paras) {
    const ppr = wKid(p, 'pPr');
    const sid = wAttr(wKid(ppr, 'pStyle'), 'val') || styles.def;
    const own = wKid(ppr, 'pageBreakBefore');
    if (p !== first && !inTable(p) && (own ? isOn(own) : styleFlag(styles, sid, 'pb'))) {
      // a mark docx-preview keeps (a bookmark becomes <span id>); the paragraph then starts a page
      const mark = x.createElementNS(W_NS, 'w:bookmarkStart');
      mark.setAttributeNS(W_NS, 'w:id', String(900000 + marks++));
      mark.setAttributeNS(W_NS, 'w:name', BREAK_MARK);
      if (ppr) ppr.after(mark); else p.prepend(mark);
      changed = true;
    }
    // No space between two paragraphs of the same style that asks for it (lists, mostly).
    const prev = p.previousElementSibling;
    if (prev && prev.namespaceURI === W_NS && prev.localName === 'p') {
      const pppr = wKid(prev, 'pPr');
      const psid = wAttr(wKid(pppr, 'pStyle'), 'val') || styles.def;
      const csOwn = wKid(ppr, 'contextualSpacing');
      const cs = csOwn ? isOn(csOwn) : styleFlag(styles, sid, 'cs');
      if (psid === sid && cs) {
        setSpacing(x, prev, 'after');
        setSpacing(x, p, 'before');
        changed = true;
      }
    }
  }
  return changed;
}
/**
 * A section without its own header or footer (of a kind) shows the previous section's ("link to
 * previous" in Word); docx-preview would show none.
 */
function inheritHeaders(x) {
  let changed = false;
  const last = {};
  for (const sp of [...x.getElementsByTagNameNS(W_NS, 'sectPr')]) {
    for (const kind of ['headerReference', 'footerReference']) {
      const own = wKids(sp, kind);
      for (const type of ['default', 'first', 'even']) {
        const key = kind + ':' + type;
        const mine = own.find((r) => (wAttr(r, 'type') || 'default') === type);
        if (mine) last[key] = mine;
        else if (last[key]) {
          sp.prepend(last[key].cloneNode(true));
          changed = true;
        }
      }
    }
  }
  return changed;
}

function inTable(p) {
  for (let e = p.parentElement; e; e = e.parentElement) if (e.namespaceURI === W_NS && e.localName === 'tbl') return true;
  return false;
}
function setSpacing(x, p, side) {
  let ppr = wKid(p, 'pPr');
  if (!ppr) { ppr = x.createElementNS(W_NS, 'w:pPr'); p.prepend(ppr); }
  let sp = wKid(ppr, 'spacing');
  if (!sp) { sp = x.createElementNS(W_NS, 'w:spacing'); ppr.append(sp); }
  sp.setAttributeNS(W_NS, 'w:' + side, '0');
  sp.removeAttributeNS(W_NS, side + 'Autospacing');
}

/** PAGE / NUMPAGES fields in a header or footer: their shown text becomes a mark. */
function markFields(x) {
  let changed = false;
  const kind = (instr) => {
    const w = String(instr || '').trim().split(/\s+/)[0].toUpperCase();
    return w === 'PAGE' ? PAGE_MARK : w === 'NUMPAGES' || w === 'SECTIONPAGES' ? PAGES_MARK : null;
  };
  const setText = (texts, mark) => {
    texts.forEach((tx, i) => { tx.textContent = i === 0 ? mark : ''; });
    if (texts.length) changed = true;
  };
  for (const fs of [...x.getElementsByTagNameNS(W_NS, 'fldSimple')]) {
    const mark = kind(wAttr(fs, 'instr'));
    if (mark) setText([...fs.getElementsByTagNameNS(W_NS, 't')], mark);
  }
  const stack = [];
  for (const r of [...x.getElementsByTagNameNS(W_NS, 'r')]) {
    for (const c of r.children) {
      if (c.namespaceURI !== W_NS) continue;
      if (c.localName === 'fldChar') {
        const type = wAttr(c, 'fldCharType');
        if (type === 'begin') stack.push({ instr: '', result: false, texts: [] });
        else if (type === 'separate' && stack.length) stack[stack.length - 1].result = true;
        else if (type === 'end' && stack.length) {
          const fld = stack.pop();
          const mark = kind(fld.instr);
          if (mark) setText(fld.texts, mark);
        }
      } else if (c.localName === 'instrText' && stack.length) {
        stack[stack.length - 1].instr += c.textContent;
      } else if (c.localName === 't' && stack.length && stack[stack.length - 1].result) {
        stack[stack.length - 1].texts.push(c);
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------- after laying out
const SERIF = /바탕|batang|명조|myeongjo|궁서|gungsuh|times|cambria|georgia|garamond|palatino|book antiqua|century|mincho|明朝|song|宋|serif/i;
const MONO = /courier|consolas|mono|d2coding|menlo|lucida console/i;
function withFallback(family) {
  const f = String(family || '').trim();
  if (!f || /(^|,)\s*(serif|sans-serif|monospace)\s*$/i.test(f) || /var\(/.test(f)) return f;
  const first = f.split(',')[0];
  return `${f}, ${MONO.test(first) ? 'monospace' : SERIF.test(first) && !/sans/i.test(first) ? 'serif' : 'sans-serif'}`;
}
// Symbol / Wingdings bullets (private-use characters) as ordinary characters.
const PUA = { 0xf0b7: '•', 0xf0a7: '▪', 0xf0a8: '□', 0xf0d8: '➢', 0xf0fc: '✓', 0xf076: '❖', 0xf06e: '■', 0xf06c: '●', 0xf071: '❑', 0xf0e0: '➔', 0xf0e8: '➔', 0xf0b2: '◆', 0xf0a4: '●', 0xf02d: '–', 0xf0be: '—' };
const fixPua = (s) => s.replace(/[\uF000-\uF0FF]/g, (c) => PUA[c.charCodeAt(0)] || '•');

/** Fonts the phone may not have fall back to the right kind; bullets drawn with symbol fonts show. */
function tidy(doc) {
  for (const st of doc.querySelectorAll('style')) {
    let s = st.textContent;
    s = s.replace(/font-family:\s*["']?(Symbol|Wingdings)[^;}\n]*;?/gi, '');
    s = s.replace(/(--docx-[\w-]+-font:\s*)([^;}\n]+)/g, (m, a, f) => a + withFallback(f));
    s = s.replace(/(font-family:\s*)([^;}\n]+)/g, (m, a, f) => a + withFallback(f));
    st.textContent = fixPua(s);
  }
  for (const el of doc.querySelectorAll('[style*="font-family"]')) {
    if (/symbol|wingdings/i.test(el.style.fontFamily)) el.style.fontFamily = '';
    else el.style.fontFamily = withFallback(el.style.fontFamily);
  }
  const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (/[\uF000-\uF0FF]/.test(n.data)) n.data = fixPua(n.data);
  for (const a of doc.querySelectorAll('a[href]')) a.removeAttribute('href');
  for (const m of doc.querySelectorAll(`[id="${BREAK_MARK}"]`)) {
    const p = m.closest('p');
    if (p) p.style.breakBefore = 'column';
    m.removeAttribute('id');
  }
}

// Pages are cut from a column layout: the body text of a section flows through columns as wide as
// the page's text area, one column per page, with the page's side margins as the gap between them.
const PAGE_CSS = `
section.docx{display:block!important;box-sizing:border-box;position:relative;overflow:hidden;margin:0!important;box-shadow:none!important;background:#fff}
section.docx>header,section.docx>footer{position:absolute;margin:0!important}
.nv-flow{position:absolute;column-fill:auto;overflow:visible}
.nv-flow p[class*="heading"],.nv-flow p[class*="title"]{break-after:avoid}
.nv-flow tr{break-inside:avoid}
p.nv-cont::before{content:none!important;counter-increment:none!important}
p.nv-cont{text-indent:0!important}
.nv-flow>ol{margin-top:12pt}
.nv-flow>ol::before{content:"";display:block;width:33%;margin:0 0 4pt -40px;border-top:.75pt solid #000}
`;

const num = (v) => parseFloat(v) || 0;

async function layoutSection(doc, sec, pages, counters, lastSection) {
  const win = doc.defaultView;
  if (!doc.getElementById('nv-page-css')) {
    const st = doc.createElement('style');
    st.id = 'nv-page-css';
    st.textContent = PAGE_CSS;
    doc.head.append(st);
  }
  // No page size or margins in the file (some converters leave them out): A4, 2.5 cm margins.
  if (!sec.style.width) sec.style.width = '595.3pt';
  if (!sec.style.minHeight) sec.style.minHeight = '841.9pt';
  if (!sec.style.padding && !sec.style.paddingLeft) sec.style.padding = '72pt 72pt';
  const cs = win.getComputedStyle(sec);
  const W = sec.offsetWidth || 794;
  const H = toPx(win, sec.style.minHeight);
  const pl = num(cs.paddingLeft);
  const pr = num(cs.paddingRight);
  const pt = num(cs.paddingTop);
  const pb = num(cs.paddingBottom);
  const cw = Math.max(50, W - pl - pr);
  const ch = Math.max(50, H - pt - pb);
  const gap = pl + pr;
  sec.style.height = H + 'px';
  sec.style.minHeight = H + 'px';
  // Everything but headers and footers goes into the flow.
  const flow = doc.createElement('div');
  flow.className = 'nv-flow';
  // (and a page's background stays behind everything: a Hangul section's page border and fill)
  for (const c of [...sec.children]) if (!/^(HEADER|FOOTER)$/.test(c.tagName) && !c.dataset.nvPage) flow.append(c);
  for (const c of sec.querySelectorAll(':scope > [data-nv-page]')) c.dataset.nvKey = 'page';
  sec.append(flow);
  Object.assign(flow.style, { left: pl + 'px', top: pt + 'px', width: cw + 'px', height: ch + 'px', columnWidth: cw + 'px', columnGap: gap + 'px', columnCount: 'auto' });
  for (const hf of sec.querySelectorAll(':scope > header')) {
    // docx-preview pulls the header up into the top margin, to the header distance
    const top = Math.max(0, pt + lengthPx(win, hf.style.marginTop));
    Object.assign(hf.style, { left: pl + 'px', width: cw + 'px', top: top + 'px' });
  }
  for (const hf of sec.querySelectorAll(':scope > footer')) {
    // at the footer distance from the bottom edge (docx-preview's negative bottom margin), growing
    // upwards, but not into the text
    const dist = Math.max(0, pb + lengthPx(win, hf.style.marginBottom));
    Object.assign(hf.style, { left: pl + 'px', width: cw + 'px', minHeight: '0', top: H - pb + 'px' });
    hf.style.top = Math.max(H - pb, H - dist - hf.offsetHeight) + 'px';
  }
  // The last section's own columns fill one after the other (Word balances only before a
  // continuous section break).
  if (lastSection) {
    const arts = [...flow.querySelectorAll(':scope > article')];
    const art = arts[arts.length - 1];
    if (art && /^[2-9]/.test(win.getComputedStyle(art).columnCount)) art.style.columnFill = 'auto';
  }
  // Things placed on the page itself (behind or in front of the text, from Hangul documents): out
  // of the text onto the page; their page is the one their paragraph ends up on.
  const floats = [];
  for (const fl of [...flow.querySelectorAll('[data-nv-float]')]) {
    // (one inside another — in a text box — stays where it is in that one)
    if (fl.parentElement.closest('[data-nv-float]')) { fl.removeAttribute('data-nv-float'); fl.classList.remove('hw-float'); continue; }
    const mark = doc.createElement('span');
    mark.style.cssText = 'display:inline-block;width:0;height:1px';
    fl.replaceWith(mark);
    fl.style.left = num(fl.dataset.nvX) + 'px';
    fl.style.top = num(fl.dataset.nvY) + 'px'; // (relative to its paragraph: set once laid out)
    fl.dataset.nvKey = 'float:' + floats.length;
    if (fl.classList.contains('behind')) sec.insertBefore(fl, flow); else sec.append(fl);
    floats.push({ fl, mark });
  }
  const sr = sec.getBoundingClientRect();
  const fr = flow.getBoundingClientRect();
  const step = cw + gap;
  const colOf = (x) => Math.max(0, Math.floor((x - fr.left + gap / 2) / step));
  // Too many pages: say so before measuring every line of them.
  // (by the column of the last block: something sticking out sideways doesn't count)
  const tail = flow.lastElementChild ? [...flow.lastElementChild.getClientRects()].pop() : null;
  if (tail && pages.length + colOf(tail.left) > MAX_PAGES) throw new ConvertError(t('convTooLarge'));
  // Text, by line, with the column (page) it is in.
  const runs = await textRuns(doc, flow, (r) => colOf(r.left));
  // the page each thing on a page goes to: where its paragraph is (and its height there)
  for (const f of floats) {
    const mr = f.mark.getBoundingClientRect();
    f.k = colOf(mr.left);
    if (f.fl.dataset.nvYPara !== undefined) {
      // its paragraph's line on its page, in page coordinates
      const line = f.mark.closest('.hw-p') || f.mark;
      const lr = [...line.getClientRects()].find((r) => colOf(r.left + 1) === f.k) || mr;
      f.fl.style.top = (pt + (lr.top - fr.top) + num(f.fl.dataset.nvYPara)) + 'px';
    }
  }
  let last = 0;
  for (const r of runs) last = Math.max(last, r.k);
  for (const f of floats) last = Math.max(last, f.k);
  // (the pages blocks are on — pictures and tables in them count, things sticking out sideways don't)
  for (const el of flow.querySelectorAll(':scope > article > *, :scope > :not(article)')) {
    if (!el.querySelector('img, svg, table, hr') && !/^(IMG|SVG|TABLE|HR)$/i.test(el.tagName)) continue;
    for (const r of el.getClientRects()) if (r.width || r.height) last = Math.max(last, colOf(r.left + 1));
  }
  // A page element with nothing in it (what is left before a page break at the start of a
  // paragraph) isn't a page, unless the whole document is empty.
  // (a page made on purpose — a Hangul page break — stays, and so does one with only a picture on it)
  if (!runs.length && !flow.querySelector('img, svg, table, hr') && !floats.length && !sec.dataset.nvKeep && !(lastSection && !pages.length)) return;
  const count = last + 1;
  if (pages.length + count > MAX_PAGES) throw new ConvertError(t('convTooLarge'));
  const byPage = new Map();
  for (const r of runs) {
    if (!byPage.has(r.k)) byPage.set(r.k, []);
    byPage.get(r.k).push(r);
  }
  const hfRuns = {};
  const hfFloats = {}; // header/footer key → things on the page that belong to it
  for (const hf of sec.querySelectorAll(':scope > header, :scope > footer')) {
    const key = hf.tagName.toLowerCase() + ':' + (hf.dataset.nvHf || 'default');
    hf.dataset.nvKey = key;
    const own = [];
    for (const fl of [...hf.querySelectorAll('[data-nv-float]')]) {
      if (fl.parentElement.closest('[data-nv-float]')) continue;
      const hr = hf.getBoundingClientRect();
      fl.style.left = num(fl.dataset.nvX) + 'px';
      fl.style.top = (fl.dataset.nvYPara !== undefined ? hr.top - sr.top + num(fl.dataset.nvYPara) : num(fl.dataset.nvY)) + 'px';
      fl.dataset.nvKey = key + '~' + own.length;
      if (fl.classList.contains('behind')) sec.insertBefore(fl, flow); else sec.append(fl);
      own.push({ key: fl.dataset.nvKey, fl });
    }
    hfRuns[key] = await textRuns(doc, hf, () => 0);
    // (the page number's own lines: left out on a page that hides the number)
    const nums = [...hf.querySelectorAll('[data-nv-page-num]')].map((e) => e.getBoundingClientRect());
    for (const r of hfRuns[key]) r.num = nums.some((b) => r.top >= b.top - 1 && r.top <= b.bottom && r.left >= b.left - 1 && r.right <= b.right + 1);
    for (const o of own) o.runs = await textRuns(doc, o.fl, () => 0);
    hfFloats[key] = own;
  }
  for (const f of floats) f.runs = await textRuns(doc, f.fl, () => 0);
  const units = flowUnits(doc, flow, colOf, fr, counters);
  const has = (k) => !!sec.querySelector(`:scope > [data-nv-key="${k}"]`);
  const startsSection = sec.dataset.nvFirst === '1';
  const titlePage = sec.dataset.nvTitle === '1';
  // page numbers run on through the document, from where a section or a paragraph (on the page
  // it is on) restarts them
  if (sec.dataset.nvPageNo) counters.pageNo = Math.max(1, Number(sec.dataset.nvPageNo) || 1);
  const restarts = new Map();
  for (const m of flow.querySelectorAll('[data-nv-page-no]')) {
    const r = m.getClientRects()[0];
    if (r) restarts.set(colOf(r.left + 1), Math.max(1, Number(m.dataset.nvPageNo) || 1));
  }
  // 감추기: what a paragraph hides on the page it is on (h header, f footer, n page number, b border/fill)
  const hides = new Map();
  for (const m of flow.querySelectorAll('[data-nv-hide]')) {
    const r = m.getClientRects()[0];
    if (r) { const k = colOf(r.left + 1); hides.set(k, (hides.get(k) || '') + m.dataset.nvHide); }
  }
  // a header or footer that starts further on: not on the pages before (h / f → its first page)
  const from = {};
  for (const m of flow.querySelectorAll('[data-nv-hf-from]')) {
    const r = m.getClientRects()[0];
    if (r) for (const c of m.dataset.nvHfFrom) from[c] = Math.min(from[c] ?? Infinity, colOf(r.left + 1));
  }
  for (let k = 0; k < count; k++) {
    if (restarts.has(k)) counters.pageNo = restarts.get(k);
    const n = counters.pageNo || pages.length + 1; // the page's number
    counters.pageNo = n + 1;
    const pick = (part) => {
      // a section with its own first page: only its first-page header/footer there (none: blank)
      if (k === 0 && startsSection && titlePage) return has(part + ':first') ? part + ':first' : null;
      if (n % 2 === 0 && has(part + ':even')) return part + ':even';
      return has(part + ':default') ? part + ':default' : null;
    };
    const hide = hides.get(k) || '';
    const hideNum = hide.includes('n');
    const hidden = (part) => hide.includes(part[0]) || k < (from[part[0]] ?? 0);
    const show = [hidden('header') ? null : pick('header'), hidden('footer') ? null : pick('footer'), hide.includes('b') ? null : 'page'].filter(Boolean);
    for (const f of floats) if (f.k === k) show.push(f.fl.dataset.nvKey);
    const texts = [];
    for (const r of byPage.get(k) || []) texts.push({ ...r, x: r.left - fr.left - k * step + pl, y: r.top - sr.top });
    for (const key of show) for (const r of hfRuns[key] || []) if (!(hideNum && r.num)) texts.push({ ...r, x: r.left - sr.left, y: r.top - sr.top });
    for (const key of [...show]) {
      for (const o of hfFloats[key] || []) {
        show.push(o.key);
        for (const r of o.runs) texts.push({ ...r, x: r.left - sr.left, y: r.top - sr.top });
      }
    }
    for (const f of floats) if (f.k === k) for (const r of f.runs) texts.push({ ...r, x: r.left - sr.left, y: r.top - sr.top });
    // Only the blocks on this page are drawn (drawing the whole section for every page would make
    // long documents slow): from the first one, laid out again exactly where it was.
    const on = [];
    for (let i = 0; i < units.length; i++) if (units[i].k0 <= k && units[i].k1 >= k) on.push(i);
    const slice = on.length ? { units: on.map((i) => units[i]), lead: on[0] > 0, k0: units[on[0]].k0 } : null;
    if (!slice && pages.length + 1 > MAX_PAGES) throw new ConvertError(t('convTooLarge'));
    // (headers and footers are copied onto every page, also the pages a long section makes)
    if ((counters.runs = (counters.runs || 0) + texts.length) > MAX_RUNS) throw new ConvertError(t('convTooLarge'));
    pages.push({ sec, flow, w: W, h: H, shift: (k - (slice ? slice.k0 : 0)) * step, fullShift: k * step, show, texts, slice, no: n, hideNum });
  }
}

/**
 * The blocks of the flow in order (paragraphs and tables of each article; an article with its own
 * columns is one block), each with the pages it is on, where it starts, and the list numbers
 * before it (lists number themselves with CSS counters, which would start again on a page drawn
 * from its own blocks).
 */
function flowUnits(doc, flow, colOf, fr, counters) {
  const win = doc.defaultView;
  const rules = counterRules(doc);
  if (!counters.values) {
    counters.values = {};
    for (const r of rules) if (r.root) for (const [name, v] of r.reset) counters.values[name] = v;
  }
  const values = counters.values;
  const apply = (el) => {
    const cont = el.classList.contains('nv-cont'); // (its ::before is gone: no number of its own)
    for (const r of rules) {
      if (r.root || (r.pseudo && cont) || !el.matches(r.sel)) continue;
      for (const [name, v] of r.reset) values[name] = v;
      for (const [name, v] of r.inc) values[name] = (values[name] || 0) + v;
      for (const [name, v] of r.set) values[name] = v;
    }
  };
  const units = [];
  let k = 0;
  const place = (el) => {
    const rects = [...el.getClientRects()].filter((r) => r.width || r.height);
    const k0 = rects.length ? colOf(rects[0].left + 1) : k;
    let k1 = k0;
    for (const r of rects) k1 = Math.max(k1, colOf(r.left + 1));
    return { k0, k1, top: rects.length ? rects[0].top - fr.top : 0 };
  };
  const add = (el, parents, at) => {
    const before = { ...values };
    if (rules.length) {
      if (el.matches('[class*="docx-num-"]')) apply(el);
      for (const d of el.querySelectorAll('[class*="docx-num-"]')) apply(d);
    }
    units.push({ el, parents, ...at, mt: num(win.getComputedStyle(el).marginTop), counters: before });
    k = at.k1;
  };
  for (const c of flow.children) {
    const own = c.tagName === 'ARTICLE' && !c.style.columnCount && !win.getComputedStyle(c).columnCount.match(/^[2-9]/);
    for (const el of own ? [...c.children] : [c]) {
      const at = place(el);
      // A table over several pages: its rows are blocks of their own (drawing the whole table
      // for each of its pages would take long).
      // (not when a cell spans rows: cut between its rows, the cells after it would move over)
      const rows = el.tagName === 'TABLE' && at.k1 > at.k0 && !el.querySelector(':scope > tr > td[rowspan]:not([rowspan="1"])')
        ? [...el.children].filter((r) => r.tagName === 'TR') : [];
      if (rows.length && rows.length === el.querySelectorAll(':scope > tr, :scope > tbody > tr').length) {
        for (const r of rows) add(r, own ? [c, el] : [el], place(r));
      } else add(el, own ? [c] : [], at);
    }
  }
  return units;
}

/** docx-preview's counter rules: {sel, root, reset, inc, set} with [[name, value]] lists. */
function counterRules(doc) {
  if (doc.__nvCounters) return doc.__nvCounters;
  const parse = (v, dflt) => {
    const parts = String(v || '').trim().split(/\s+/);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!name || name === 'none' || /^-?\d+$/.test(name)) continue;
      let n = dflt;
      if (/^-?\d+$/.test(parts[i + 1] || '')) n = parseInt(parts[++i], 10);
      if (/^docx-/.test(name)) out.push([name, n]);
    }
    return out;
  };
  const rules = [];
  for (const sheet of doc.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    for (const r of list) {
      if (!r.style || !r.selectorText) continue;
      const reset = parse(r.style.counterReset, 0);
      const inc = parse(r.style.counterIncrement, 1);
      const set = parse(r.style.counterSet, 0);
      if (!reset.length && !inc.length && !set.length) continue;
      const root = /^:root$|^html$/i.test(r.selectorText.trim());
      const sel = r.selectorText.replace(/::?before|::?after|::?marker/g, '');
      try { if (!root) doc.body.matches(sel); } catch { continue; }
      rules.push({ sel, root, reset, inc, set, pseudo: sel !== r.selectorText });
    }
  }
  doc.__nvCounters = rules;
  return rules;
}

/** A section with only what one page shows: its header and footer, and the flow's blocks on it. */
function pageSection(pg) {
  const { sec, flow, slice } = pg;
  const out = sec.cloneNode(false);
  const f = flow.cloneNode(false);
  // (in the section's order: what lies behind the text comes before it)
  for (const c of sec.children) {
    if (c === flow) out.append(f);
    else if (pg.show.includes(c.dataset.nvKey)) out.append(c.cloneNode(true));
  }
  // the containers of the blocks (an article; a table for rows), copied without their content
  let chain = [];
  let clones = [];
  let into = f;
  const enter = (parents) => {
    let same = 0;
    while (same < chain.length && same < parents.length && chain[same] === parents[same]) same++;
    chain = chain.slice(0, same);
    clones = clones.slice(0, same);
    for (let j = same; j < parents.length; j++) {
      const c = parents[j].cloneNode(false);
      // a table keeps its column widths
      if (c.tagName === 'TABLE') for (const g of parents[j].children) if (g.tagName === 'COLGROUP') c.append(g.cloneNode(true));
      (clones[j - 1] || f).append(c);
      chain.push(parents[j]);
      clones.push(c);
    }
    into = clones[clones.length - 1] || f;
  };
  slice.units.forEach((u, i) => {
    enter(u.parents);
    const el = u.el.cloneNode(true);
    if (i === 0) el.style.breakBefore = 'auto'; // it starts this page already
    const sets = i === 0 ? Object.entries(u.counters).map(([name, v]) => name + ' ' + v).join(' ') : '';
    if (i === 0 && (slice.lead || sets)) {
      // the list numbers so far (they go on across pages and sections), and the space above the
      // first block when it started on an earlier page
      const h = slice.lead ? u.top - u.mt : 0;
      const spacer = u.el.ownerDocument.createElement('div');
      spacer.style.height = Math.max(0, h) + 'px';
      if (sets) spacer.style.counterSet = sets;
      if (u.el.tagName === 'TR') {
        // rows: the space goes before the table, which then starts right at its first row here
        const table = clones[clones.length - 1];
        table.before(spacer);
        if (slice.lead) table.style.marginTop = '0';
      } else {
        into.append(spacer);
        if (slice.lead && h < 0.5) el.style.marginTop = '0';
      }
    }
    into.append(el);
  });
  return out;
}

/** A CSS length (may be negative, may be calc()) in pixels. */
function lengthPx(win, len) {
  if (!len) return 0;
  const d = win.document.createElement('div');
  d.style.cssText = 'position:absolute;visibility:hidden;height:0';
  d.style.marginTop = len;
  win.document.body.append(d);
  const v = num(win.getComputedStyle(d).marginTop);
  d.remove();
  return v;
}

function toPx(win, len) {
  const d = win.document.createElement('div');
  d.style.cssText = 'position:absolute;visibility:hidden;height:' + len;
  win.document.body.append(d);
  const h = d.getBoundingClientRect().height;
  d.remove();
  return h || 1123;
}

/**
 * The text below `root` as runs on one line each: {t, left, right, top, h, size, k}. Where a line
 * ends inside a text node is found by halving (everything between two characters on the same line
 * is on that line), so long paragraphs cost a few measurements per line, not one per character.
 */
async function textRuns(doc, root, colOf) {
  const out = [];
  const range = doc.createRange();
  const win = doc.defaultView;
  const tw = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let budget = 0;
  for (let node = tw.nextNode(); node; node = tw.nextNode()) {
    const s = node.data;
    if (!s.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    // text a box clips (a text box that is too small) isn't shown: not in the text layer either
    const clip = el.closest('[data-nv-clip]');
    const cr = clip ? clip.getBoundingClientRect() : null;
    const size = num(win.getComputedStyle(el).fontSize) || 14;
    // a line is never wider than its block (in a two-column part, the next column's line is
    // at the same height)
    const block = el.closest('p, td, th, li, div, h1, h2, h3, h4, h5, h6') || el;
    const lineMax = (block.offsetWidth || 1e9) + 2;
    const rectAt = (i) => {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rs = range.getClientRects();
      return rs.length ? rs[0] : null;
    };
    const same = (a, b) => a && b && Math.abs(a.top - b.top) < Math.max(2, a.height / 2) && colOf(a) === colOf(b) && b.left >= a.left - 1 && b.right - a.left <= lineMax;
    let i = 0;
    while (i < s.length) {
      // skip characters that aren't drawn (spaces at line ends, collapsed space)
      let a = rectAt(i);
      while (i < s.length && (!a || (!a.width && /\s/.test(s[i])))) { i++; a = i < s.length ? rectAt(i) : null; }
      if (i >= s.length || !a) break;
      // the last character on a's line
      let lo = i;
      let hi = s.length - 1;
      const end = rectAt(hi);
      if (!same(a, end)) {
        let step = 1;
        while (lo + step < hi && same(a, rectAt(lo + step))) { lo += step; step *= 2; }
        let top = Math.min(hi, lo + step);
        while (top - lo > 1) {
          const mid = (lo + top) >> 1;
          if (same(a, rectAt(mid))) lo = mid; else top = mid;
        }
        hi = lo;
      }
      let b = rectAt(hi);
      let j = hi;
      while (j > i && (!b || !b.width)) b = rectAt(--j);
      const text = s.slice(i, hi + 1).replace(/[\u0000-\u001f]/g, ' ');
      const visible = !cr || (a.top < cr.bottom - 1 && a.bottom > cr.top + 1 && a.left < cr.right && a.right > cr.left);
      if (visible && text.trim()) out.push({ t: text, left: a.left, right: (b || a).right, top: Math.min(a.top, (b || a).top), h: Math.max(a.height, (b || a).height), size, k: colOf(a) });
      i = hi + 1;
      if (++budget % 400 === 0) { await idle(); check(); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------- drawing pages
function serialize(doc, sec) {
  return new doc.defaultView.XMLSerializer().serializeToString(sec)
    // characters XML doesn't allow (the picture would fail to load)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
}
const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function drawPage(canvas, pg, html, css, shift, n, total) {
  const { w, h } = pg;
  const only = pg.show.map((k) => `[data-nv-key="${k}"]`).join(',');
  const pageCss = `.nv-flow{transform:translateX(-${shift}px)}[data-nv-key]{display:none!important}${only ? only + '{display:block!important}' : ''}`
    + (pg.hideNum ? '[data-nv-page-num]{visibility:hidden!important}' : '');
  const body = pageNumbers(html, n, total);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;background:#fff;-webkit-text-size-adjust:none;text-size-adjust:none"><style>${escXml(css + pageCss)}</style>${body}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  try {
    await img.decode();
  } catch (e) {
    console.warn('page picture failed', e);
    throw new ConvertError(t('convBroken'));
  }
  let scale = SCALE;
  if (w * h * scale * scale > MAX_PAGE_PX) scale = Math.sqrt(MAX_PAGE_PX / (w * h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const g = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  const gray = await grayPage(canvas, g);
  if (gray) return gray;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new ConvertError(t('convBroken'));
  return { png: new Uint8Array(await blob.arrayBuffer()) };
}

/**
 * A page without colour (most text pages) as 8-bit gray rows, compressed: well under half the
 * size of the colour picture. Null when the page has colour (or the browser can't compress).
 */
async function grayPage(canvas, g) {
  if (typeof CompressionStream !== 'function') return null;
  const w = canvas.width;
  const h = canvas.height;
  const img = g.getImageData(0, 0, w, h).data;
  const px = new Uint32Array(img.buffer, img.byteOffset, w * h);
  const rows = new Uint8Array((w + 1) * h); // each row starts with PNG filter type 0 (none)
  for (let y = 0, i = 0, q = 0; y < h; y++) {
    q++;
    for (let x = 0; x < w; x++, i++) {
      const v = px[i];
      if (v === 0xffffffff) { rows[q++] = 255; continue; } // white (most of a page)
      const r = v & 255;
      const gg = (v >> 8) & 255;
      const b = (v >> 16) & 255;
      if (r - gg > 8 || gg - r > 8 || r - b > 8 || b - r > 8) return null;
      rows[q++] = (r * 77 + gg * 150 + b * 29) >> 8;
    }
  }
  const data = new Uint8Array(await new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  return { gray: data, w, h };
}

/**
 * A PNG from the canvas as a PDF image, without decoding it: its compressed rows are what PDF's
 * Flate filter with PNG predictors reads (8-bit RGB, not interlaced: what an opaque canvas gives).
 */
function grayImage(pdf, { gray, w, h }) {
  const dict = pdf.context.obj({
    Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 8, Columns: w }, Length: gray.length,
  });
  return pdf.context.register(PDFRawStream.of(dict, gray));
}

async function pngImage(pdf, b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  let w = 0;
  let h = 0;
  let type = -1;
  const parts = [];
  let len = 0;
  while (p + 8 <= b.length) {
    const n = dv.getUint32(p);
    const name = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (name === 'IHDR') {
      w = dv.getUint32(p + 8);
      h = dv.getUint32(p + 12);
      type = b[p + 17];
      if (b[p + 16] !== 8 || b[p + 20] !== 0 || (type !== 2 && type !== 6)) throw new ConvertError(t('convBroken'));
    } else if (name === 'IDAT') {
      parts.push(b.subarray(p + 8, p + 8 + n));
      len += n;
    } else if (name === 'IEND') break;
    p += 12 + n;
  }
  if (type === 6) return (await pdf.embedPng(b)).ref; // with transparency (not expected): the slow way
  const data = new Uint8Array(len);
  let o = 0;
  for (const c of parts) { data.set(c, o); o += c.length; }
  const dict = pdf.context.obj({
    Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: w }, Length: len,
  });
  return pdf.context.register(PDFRawStream.of(dict, data));
}

/**
 * A font for invisible text: no glyphs, each character code is its Unicode value (UTF-16, two
 * bytes), every character 1 em wide; the text is stretched to the width it has on the page.
 * Characters past U+FFFF get codes from the surrogates' range (no character has those), mapped in
 * the ToUnicode table written at the end: { ref, finish(extra) }.
 */
function textFont(pdf) {
  const ctx = pdf.context;
  const toUnicode = ctx.nextRef();
  const lines = [];
  for (let hi = 0; hi < 256; hi++) {
    if (hi >= 0xd8 && hi <= 0xdf) continue;
    const x = hi.toString(16).padStart(2, '0');
    lines.push(`<${x}00> <${x}ff> <${x}00>`);
  }
  let ranges = '';
  for (let i = 0; i < lines.length; i += 100) {
    const part = lines.slice(i, i + 100);
    ranges += `${part.length} beginbfrange\n${part.join('\n')}\nendbfrange\n`;
  }
  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
  const finish = (extra) => {
    const chars = [...extra].map(([cp, code]) => `<${hex4(code)}> <${hex4(0xd800 + ((cp - 0x10000) >> 10))}${hex4(0xdc00 + ((cp - 0x10000) & 0x3ff))}>`);
    let more = '';
    for (let i = 0; i < chars.length; i += 100) {
      const part = chars.slice(i, i + 100);
      more += `${part.length} beginbfchar\n${part.join('\n')}\nendbfchar\n`;
    }
    const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n'
      + `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${ranges}${more}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    ctx.assign(toUnicode, ctx.flateStream(cmap));
  };
  const descriptor = ctx.register(ctx.obj({
    Type: 'FontDescriptor', FontName: 'NVText', Flags: 4, FontBBox: [0, -200, 1000, 800], ItalicAngle: 0,
    Ascent: 800, Descent: -200, CapHeight: 700, StemV: 80,
  }));
  const cid = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'NVText', FontDescriptor: descriptor, DW: 1000, CIDToGIDMap: 'Identity',
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
  }));
  const ref = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'NVText', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUnicode }));
  return { ref, finish };
}

function textOps(pg, n, total, extra) {
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(3)];
  for (const r of pg.texts) {
    // (a space at the end stays: it is what separates this run from the next one in search)
    const str = pageNumbers(r.t, n, total);
    const codes = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x10000 && (c < 0xd800 || c > 0xdfff)) codes.push(c);
      else if (c >= 0x10000) {
        // (emoji, rarer CJK…: a code from the surrogates' range, which no character uses,
        // mapped to the character in the font's ToUnicode table)
        if (!extra.has(c) && extra.size < 2048) extra.set(c, 0xd800 + extra.size);
        if (extra.has(c)) codes.push(extra.get(c));
      }
    }
    if (!codes.length || !codes.some((c) => c > 32)) continue;
    const size = Math.max(1, Math.min(r.size, r.h) * PT);
    const width = Math.max(1, (r.right - r.left) * PT);
    const squeeze = Math.max(1, Math.min(1000, (width / (codes.length * size)) * 100));
    const baseline = (pg.h - (r.y + r.h / 2 + Math.min(r.size, r.h) * 0.35)) * PT;
    ops.push(
      setFontAndSize('NVText', size), setCharacterSqueeze(squeeze), setTextMatrix(1, 0, 0, 1, r.x * PT, baseline),
      showText(PDFHexString.of(codes.map((c) => c.toString(16).padStart(4, '0')).join(''))),
    );
  }
  ops.push(endText(), popGraphicsState());
  return ops;
}
