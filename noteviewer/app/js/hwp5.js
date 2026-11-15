// Older Hangul documents (.hwp, HWP 5.0) for js/convert.js: the compound file (js/cfb.js), its
// compressed streams and binary records, turned into the same elements an HWPX file has, which
// js/hwpx.js then lays out. Reads the document's fonts, character and paragraph shapes, borders and
// fills, numbering, and its sections: paragraphs, tables, pictures, drawings and text boxes, groups,
// equations, headers and footers, footnotes, page numbers, columns, page borders.
//
// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Nothing from the file reaches markup: values become attributes of an XML document (read by
// hwpx.js, which checks them again), text becomes text nodes. Every count and size is limited.

import { openCfb } from './cfb.js';
import { aesEcbDecrypt } from './aes.js';

/** Why a document can't be read: 'locked' (password, certificate or DRM), 'old' (HWP 3.x or older), 'broken', 'tooLarge'. */
export class HwpError extends Error {
  constructor(kind) {
    super('hwp: ' + kind);
    this.kind = kind;
  }
}
const broken = () => new HwpError('broken');
const tooLarge = () => new HwpError('tooLarge');

// ------------------------------------------------------------------ records
const T = {
  DOC_PROPS: 16, ID_MAPPINGS: 17, BIN_DATA: 18, FACE_NAME: 19, BORDER_FILL: 20, CHAR_SHAPE: 21, TAB_DEF: 22,
  NUMBERING: 23, BULLET: 24, PARA_SHAPE: 25, STYLE: 26, DISTRIBUTE_DOC_DATA: 28,
  PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, CTRL_HEADER: 71, LIST_HEADER: 72, PAGE_DEF: 73,
  PAGE_BORDER_FILL: 75, SHAPE_COMPONENT: 76, TABLE: 77, SC_LINE: 78, SC_RECT: 79, SC_ELLIPSE: 80, SC_ARC: 81,
  SC_POLYGON: 82, SC_CURVE: 83, SC_OLE: 84, SC_PICTURE: 85, SC_CONTAINER: 86, EQEDIT: 88, SC_TEXTART: 90,
};

/** A little-endian reader over a record's bytes; reads past the end give 0. */
class Reader {
  constructor(b, at = 0) {
    this.b = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.o = at;
  }
  get left() { return this.b.length - this.o; }
  skip(n) { this.o += n; return this; }
  u8() { const v = this.o + 1 <= this.b.length ? this.b[this.o] : 0; this.o += 1; return v; }
  i8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
  u16() { const v = this.o + 2 <= this.b.length ? this.dv.getUint16(this.o, true) : 0; this.o += 2; return v; }
  i16() { const v = this.o + 2 <= this.b.length ? this.dv.getInt16(this.o, true) : 0; this.o += 2; return v; }
  u32() { const v = this.o + 4 <= this.b.length ? this.dv.getUint32(this.o, true) : 0; this.o += 4; return v; }
  i32() { const v = this.o + 4 <= this.b.length ? this.dv.getInt32(this.o, true) : 0; this.o += 4; return v; }
  f64() { const v = this.o + 8 <= this.b.length ? this.dv.getFloat64(this.o, true) : 0; this.o += 8; return Number.isFinite(v) ? v : 0; }
  /** A string: a 16-bit length, then that many UTF-16 code units. */
  str(max = 4096) {
    const n = Math.min(this.u16(), max, Math.max(0, this.left >> 1));
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16());
    return s;
  }
}

/** The records of a stream as a tree (each record's children are the deeper ones after it). */
function recordTree(b, budget) {
  const root = { tag: -1, level: -1, kids: [] };
  const stack = [root];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  while (o + 4 <= b.length) {
    const h = dv.getUint32(o, true);
    o += 4;
    let size = h >>> 20;
    if (size === 0xfff) {
      if (o + 4 > b.length) break;
      size = dv.getUint32(o, true);
      o += 4;
    }
    if (o + size > b.length) throw broken();
    if (++budget.records > budget.maxRecords) throw tooLarge();
    const rec = { tag: h & 0x3ff, level: (h >>> 10) & 0x3ff, data: b.subarray(o, o + size), kids: [] };
    o += size;
    while (stack.length > 1 && stack[stack.length - 1].level >= rec.level) stack.pop();
    stack[stack.length - 1].kids.push(rec);
    stack.push(rec);
  }
  return root.kids;
}

/** The characters convert.js marks page numbers with, in a document's own text, as boxes. */
const unmark = (s) => s.replace(/[\uE0F1\uE0F2\uE100-\uE10F]/g, '\u25A1');
const isMark = (c) => c === 0xe0f1 || c === 0xe0f2 || (c >= 0xe100 && c <= 0xe10f);

const ctrlId = (r) => {
  const v = new Reader(r.data).u32();
  return String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
};

/** A COLORREF (0x00BBGGRR) as #rrggbb, or '' for "none" (a high byte set). */
const colorOf = (c) => (c >>> 24 ? '' : '#' + [c & 255, (c >>> 8) & 255, (c >>> 16) & 255].map((x) => x.toString(16).padStart(2, '0')).join(''));

/** Stream inflation (raw deflate), counted against the document's budget. */
async function inflate(bytes, budget, max = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if ((budget.unpacked += value.length) > budget.maxUnpacked || n > max) {
        reader.cancel().catch(() => {});
        throw tooLarge();
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof HwpError) throw e;
    if (!n) throw broken(); // (data after the end of the compressed part is fine)
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ------------------------------------------------------------------ names of things
const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const LANG_ATTRS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const LINE_TYPES = ['NONE', 'SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM',
  'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE', 'THICK_3D', 'THICK_3D_REVERS', '3D', '3D_REVERS'];
const LINE_WIDTHS = ['0.1', '0.12', '0.15', '0.2', '0.25', '0.3', '0.4', '0.5', '0.6', '0.7', '1.0', '1.5', '2.0', '3.0', '4.0', '5.0'];
const NUM_FMTS = ['DIGIT', 'CIRCLED_DIGIT', 'ROMAN_CAPITAL', 'ROMAN_SMALL', 'LATIN_CAPITAL', 'LATIN_SMALL', 'CIRCLED_LATIN_CAPITAL',
  'CIRCLED_LATIN_SMALL', 'HANGUL_SYLLABLE', 'CIRCLED_HANGUL_SYLLABLE', 'HANGUL_JAMO', 'CIRCLED_HANGUL_JAMO', 'HANGUL_PHONETIC',
  'IDEOGRAPH', 'CIRCLED_IDEOGRAPH'];
const numFmt = (i) => NUM_FMTS[i] || 'DIGIT';
const ALIGNS = ['JUSTIFY', 'LEFT', 'RIGHT', 'CENTER', 'DISTRIBUTE', 'DISTRIBUTE_SPACE'];
const SPACINGS = ['PERCENT', 'FIXED', 'BETWEEN_LINES', 'AT_LEAST'];
const HEADINGS = ['NONE', 'OUTLINE', 'NUMBER', 'BULLET'];
const VALIGN = ['TOP', 'CENTER', 'BOTTOM'];

// ------------------------------------------------------------------ XML out
class Out {
  /** budget: shared by all of a document's parts (elements made, checked as they are made). */
  constructor(root, budget) {
    this.doc = document.implementation.createDocument(null, root, null);
    this.budget = budget;
  }
  get root() { return this.doc.documentElement; }
  el(name, attrs, ...kids) {
    if (this.budget && ++this.budget.elements > this.budget.maxElements) throw tooLarge();
    const e = this.doc.createElement(name);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== '') e.setAttribute(k, String(v));
    for (const k of kids) if (k) e.append(k);
    return e;
  }
}

// ------------------------------------------------------------------ the document
/**
 * Reads an HWP 5.0 file. Returns { header, sections, binary(id) → Promise<Uint8Array|null> } for
 * convert.js (header and sections as XML documents in HWPX's terms).
 */
export async function readHwp(bytes, limits = {}) {
  const budget = {
    unpacked: 0, maxUnpacked: limits.maxUnpacked || 150 * 1024 * 1024,
    records: 0, maxRecords: limits.maxRecords || 1.5e6,
    elements: 0, maxElements: (limits.maxElements || 600000) + 50000, // (+ the header's)
    maxPicture: limits.maxPicture || 30 * 1024 * 1024,
    paras: 0, maxParas: limits.maxParagraphs || 60000, chars: 0, maxChars: limits.maxText || 2e6,
  };
  // (HWP 3.x and older files aren't compound files: they start with the signature itself)
  if (bytes.length >= 17 && String.fromCharCode(...bytes.subarray(0, 17)) === 'HWP Document File') throw new HwpError('old');
  let cfb;
  try { cfb = openCfb(bytes); } catch { throw broken(); }
  if (typeof DecompressionStream === 'undefined') throw broken(); // (a WebView too old to unpack)
  let head;
  try { head = cfb.read('FileHeader'); } catch { throw broken(); }
  if (!head || head.length < 40 || String.fromCharCode(...head.subarray(0, 17)) !== 'HWP Document File') throw broken();
  const hr = new Reader(head, 32);
  const version = hr.u32();
  const flags = hr.u32();
  if (version >>> 24 !== 5) throw broken();
  // password, certificate encryption or DRM (flags 2, 0x100; 16, 0x400): can't be read. A distribution document (배포용 문서) is read for viewing only:
  // its text is in ViewText, encrypted as Hancom's published format describes, and the copy made
  // here keeps the author's limits (no text to copy or search, no export: see convert.js, app.js).
  if (flags & (2 | 16 | 0x100 | 0x400)) throw new HwpError('locked');
  const distribution = !!(flags & 4);
  const compressed = !!(flags & 1);
  const stream = async (name) => {
    let b;
    try { b = cfb.read(name); } catch { throw broken(); }
    if (!b) return null;
    if (b.length > budget.maxUnpacked) throw tooLarge();
    // (stored as is: counted like unpacked data, so many sections can't add up past the limit)
    if (!compressed && (budget.unpacked += b.length) > budget.maxUnpacked) throw tooLarge();
    return compressed ? inflate(b, budget) : b;
  };

  const docInfo = await stream('DocInfo');
  if (!docInfo) throw broken();
  const info = readDocInfo(recordTree(docInfo, budget), budget);
  const header = headerXml(info, budget);

  const dir = distribution ? 'ViewText' : 'BodyText';
  const names = [...cfb.streams.keys()].filter((k) => new RegExp(`^${dir}/Section\\d+$`).test(k))
    .sort((a, b) => Number(a.slice(dir.length + 8)) - Number(b.slice(dir.length + 8)));
  if (!names.length) throw broken();
  const sections = [];
  for (const name of names) {
    const recs = recordTree(distribution ? await viewText(cfb, name, compressed, budget) : await stream(name), budget);
    sections.push(new SectionWriter(info, budget).section(recs));
  }

  // pictures: the BinData stream of each item, unpacked when it is stored packed
  const binary = async (id) => {
    const item = info.bins[Number(id) - 1];
    if (!item || item.type === 0) return null;
    const name = `BinData/BIN${item.id.toString(16).toUpperCase().padStart(4, '0')}.${item.ext}`;
    let b;
    try { b = cfb.read(name); } catch { return null; }
    if (!b) return null;
    const packed = item.compress === 1 || (item.compress === 0 && compressed);
    if (!packed) return b;
    // (a picture past its own limit is left out; past the document's, the document is too large)
    const before = budget.unpacked;
    try { return await inflate(b, budget, budget.maxPicture); } catch (e) {
      if (e.kind === 'tooLarge' && budget.unpacked <= budget.maxUnpacked) { budget.unpacked = before; return null; }
      if (e.kind === 'tooLarge') throw e;
      return null;
    }
  };
  return { header, sections, binary, restricted: distribution };
}

/**
 * A distribution document's section: a 256-byte record whose bytes, unscrambled with the
 * generator seeded by its first four, hold the AES-128 key of the rest (ECB), which is then the
 * section as usual (packed when the document is).
 */
async function viewText(cfb, name, compressed, budget) {
  let b;
  try { b = cfb.read(name); } catch { throw broken(); }
  if (!b || b.length < 260) throw broken();
  // (what is decrypted counts toward the document's limit too)
  if ((budget.unpacked += b.length) > budget.maxUnpacked) throw tooLarge();
  const head = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  if ((head & 0x3ff) !== T.DISTRIBUTE_DOC_DATA || head >>> 20 !== 256) throw broken();
  const data = b.slice(4, 260);
  const seed = new DataView(data.buffer).getUint32(0, true);
  let state = seed;
  const rand = () => { state = (Math.imul(state, 214013) + 2531011) >>> 0; return (state >>> 16) & 0x7fff; };
  for (let i = 0, key = 0, count = 0; i < 256; i++, count--) {
    if (count === 0) { key = rand() & 0xff; count = (rand() & 0xf) + 1; }
    if (i >= 4) data[i] ^= key;
  }
  const at = 4 + (seed & 0xf);
  const plain = aesEcbDecrypt(b.subarray(260), data.subarray(at, at + 16));
  return compressed ? inflate(plain, budget) : plain;
}

// ------------------------------------------------------------------ DocInfo
function readDocInfo(recs, budget) {
  // (each record becomes several header elements: charged before it is read, as a small file
  // can hold a great many of them)
  const COST = { [T.CHAR_SHAPE]: 8, [T.PARA_SHAPE]: 10, [T.NUMBERING]: 8, [T.BORDER_FILL]: 7, [T.BULLET]: 1, [T.FACE_NAME]: 1, [T.BIN_DATA]: 1 };
  const info = { counts: [], fonts: {}, bins: [], borderFills: [], charShapes: [], numberings: [], bullets: [], paraShapes: [] };
  const faceRecs = [];
  // (most records are children of ID_MAPPINGS: all of them, in order)
  const all = [];
  const walk = (list) => { for (const rec of list) { all.push(rec); walk(rec.kids); } };
  walk(recs);
  for (const rec of all) {
    if (COST[rec.tag] && (budget.elements += COST[rec.tag]) > budget.maxElements) throw tooLarge();
    const r = new Reader(rec.data);
    switch (rec.tag) {
      case T.ID_MAPPINGS:
        for (let i = 0; i < 18 && r.left >= 4; i++) info.counts.push(Math.max(0, r.i32()));
        break;
      case T.BIN_DATA: {
        const prop = r.u16();
        const type = prop & 15;
        const item = { type, compress: (prop >> 4) & 3, id: 0, ext: '' };
        if (type === 0) { r.str(); r.str(); } else {
          item.id = r.u16();
          if (type === 1) item.ext = r.str(16).toLowerCase().replace(/[^a-z0-9]/g, '');
        }
        info.bins.push(item);
        break;
      }
      case T.FACE_NAME: r.u8(); faceRecs.push(r.str(200)); break;
      case T.BORDER_FILL: info.borderFills.push(readBorderFill(r)); break;
      case T.CHAR_SHAPE: info.charShapes.push(readCharShape(r)); break;
      case T.NUMBERING: info.numberings.push(readNumbering(r)); break;
      case T.BULLET: r.skip(12); info.bullets.push(unmark(String.fromCharCode(r.u16() || 0x2022))); break;
      case T.PARA_SHAPE: info.paraShapes.push(readParaShape(r)); break;
      default: break;
    }
  }
  // the faces come language by language, as many as ID_MAPPINGS says for each
  let at = 0;
  LANGS.forEach((lang, i) => {
    const n = info.counts[i + 1] || 0;
    info.fonts[lang] = faceRecs.slice(at, at + n);
    at += n;
  });
  return info;
}

/** A border (type, width, colour) as HWPX's attributes. */
const border = (r) => {
  const type = r.u8();
  const width = r.u8();
  const c = r.u32();
  return { type: LINE_TYPES[type] || 'SOLID', width: (LINE_WIDTHS[width] || '0.12') + ' mm', color: colorOf(c) || '#000000' };
};

/** Fill information (단색, 그러데이션, 그림). */
function readFill(r) {
  const type = r.u32();
  const fill = {};
  if (type & 1) {
    fill.face = colorOf(r.u32());
    r.u32();
    r.i32();
  }
  if (type & 4) {
    r.u8();
    const angle = r.i32();
    r.i32(); r.i32(); r.i32();
    const n = r.i32();
    if (n >= 2 && n <= 16) {
      if (n > 2) r.skip(4 * n);
      fill.grad = { angle, colors: Array.from({ length: n }, () => colorOf(r.u32())).filter(Boolean) };
    } else return fill;
  }
  if (type & 2) {
    r.u8();
    r.skip(3);
    fill.img = r.u16();
  }
  return fill;
}

function readBorderFill(r) {
  r.u16();
  const sides = [border(r), border(r), border(r), border(r)]; // left, right, top, bottom
  border(r); // (diagonal)
  return { sides, fill: readFill(r) };
}

function readCharShape(r) {
  const faces = Array.from({ length: 7 }, () => r.u16());
  const ratio = Array.from({ length: 7 }, () => r.u8());
  const spacing = Array.from({ length: 7 }, () => r.i8());
  const rel = Array.from({ length: 7 }, () => r.u8());
  r.skip(7); // (positions)
  const size = r.i32();
  const prop = r.u32();
  r.skip(2);
  const text = r.u32();
  r.u32();
  const shade = r.u32();
  return { faces, ratio, spacing, rel, size, prop, text, shade };
}

function readNumbering(r) {
  const levels = [];
  for (let i = 0; i < 7; i++) {
    const prop = r.u32();
    r.skip(8);
    levels.push({ fmt: numFmt((prop >> 5) & 15), text: r.str(64), start: 1 });
  }
  const start = r.u16();
  for (let i = 0; i < 7; i++) levels[i].start = r.left >= 4 ? r.u32() : start || 1;
  return levels;
}

function readParaShape(r) {
  const p1 = r.u32();
  const left = r.i32();
  const right = r.i32();
  const indent = r.i32();
  const prev = r.i32();
  const next = r.i32();
  const oldSpacing = r.i32();
  r.u16();
  const numbering = r.u16();
  r.skip(2 + 8);
  r.u32();
  const p3 = r.u32();
  const spacing = r.u32();
  const newer = r.left >= 0 && r.b.length >= 54;
  return {
    align: ALIGNS[(p1 >> 2) & 7] || 'JUSTIFY',
    // (margins and spacing are stored doubled, as in an HWPX file's compatibility branch)
    left: left / 2, right: right / 2, indent: indent / 2, prev: prev / 2, next: next / 2,
    spacingType: SPACINGS[newer ? p3 & 31 : p1 & 3] || 'PERCENT',
    spacing: newer ? spacing : oldSpacing,
    keepWithNext: (p1 >> 17) & 1, keepLines: (p1 >> 18) & 1, pageBreakBefore: (p1 >> 19) & 1,
    heading: HEADINGS[(p1 >> 23) & 3], level: (p1 >> 25) & 7, numbering,
  };
}

/** The header document: fonts, borders and fills, character and paragraph shapes, numbering. */
function headerXml(info, budget) {
  const x = new Out('head', budget);
  const fontfaces = x.el('fontfaces');
  for (const lang of LANGS) fontfaces.append(x.el('fontface', { lang }, ...info.fonts[lang].map((face) => x.el('font', { face }))));
  const fills = x.el('borderFills');
  info.borderFills.forEach((bf, i) => {
    const e = x.el('borderFill', { id: i + 1 });
    ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder'].forEach((n, k) => e.append(x.el(n, bf.sides[k])));
    const fill = fillXml(x, bf.fill);
    if (fill) e.append(fill);
    fills.append(e);
  });
  const chars = x.el('charProperties');
  info.charShapes.forEach((c, i) => {
    const per = (name, vals) => x.el(name, Object.fromEntries(LANG_ATTRS.map((l, k) => [l, vals[k]])));
    const ul = (c.prop >> 2) & 3;
    chars.append(x.el('charPr', { id: i, height: c.size, textColor: colorOf(c.text) || '#000000', shadeColor: colorOf(c.shade) },
      per('fontRef', c.faces), per('ratio', c.ratio), per('spacing', c.spacing), per('relSz', c.rel),
      c.prop & 2 ? x.el('bold') : null, c.prop & 1 ? x.el('italic') : null,
      ul === 1 || ul === 3 ? x.el('underline', { type: ul === 1 ? 'BOTTOM' : 'TOP' }) : null,
      // (a line through the middle: kind 2 of the underline, or a strike-through)
      (c.prop >> 18) & 7 || ul === 2 ? x.el('strikeout', { shape: 'SOLID' }) : null,
      c.prop & (1 << 15) ? x.el('supscript') : null, c.prop & (1 << 16) ? x.el('subscript') : null));
  });
  const nums = x.el('numberings');
  info.numberings.forEach((levels, i) => {
    nums.append(x.el('numbering', { id: i + 1 }, ...levels.map((lv, k) => {
      const e = x.el('paraHead', { level: k + 1, start: Math.min(1e6, lv.start), numFormat: lv.fmt });
      e.textContent = unmark(lv.text);
      return e;
    })));
  });
  const bullets = x.el('bullets');
  info.bullets.forEach((ch, i) => bullets.append(x.el('bullet', { id: i + 1, char: ch })));
  const paras = x.el('paraProperties');
  info.paraShapes.forEach((p, i) => {
    const v = (value) => ({ value: Math.round(value) });
    paras.append(x.el('paraPr', { id: i },
      x.el('align', { horizontal: p.align }),
      x.el('heading', { type: p.heading, idRef: p.numbering, level: p.level }),
      x.el('breakSetting', { keepWithNext: p.keepWithNext, keepLines: p.keepLines, pageBreakBefore: p.pageBreakBefore }),
      x.el('margin', null, x.el('intent', v(p.indent)), x.el('left', v(p.left)), x.el('right', v(p.right)), x.el('prev', v(p.prev)), x.el('next', v(p.next))),
      x.el('lineSpacing', { type: p.spacingType, value: p.spacingType === 'PERCENT' ? p.spacing : Math.round(p.spacing / 2) })));
  });
  x.root.append(fontfaces, fills, chars, nums, bullets, paras);
  return x.doc;
}

function fillXml(x, fill) {
  if (!fill || (!fill.face && !fill.grad && !fill.img)) return null;
  const e = x.el('fillBrush');
  if (fill.face) e.append(x.el('winBrush', { faceColor: fill.face }));
  if (fill.grad && fill.grad.colors.length >= 2) e.append(x.el('gradation', { angle: fill.grad.angle }, ...fill.grad.colors.map((value) => x.el('color', { value }))));
  if (fill.img) e.append(x.el('imgBrush', null, x.el('img', { binaryItemIDRef: fill.img })));
  return e;
}

// ------------------------------------------------------------------ sections
// Control characters in a paragraph's text: those that stand for a control (8 code units each,
// matched in order with the paragraph's CTRL_HEADER records), inline ones (8 units, no record)
// and single characters.
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
const INLINE = new Set([4, 5, 6, 7, 8, 9, 19, 20]);
const MAX_NESTING = 24;

class SectionWriter {
  constructor(info, budget) {
    this.info = info;
    this.budget = budget;
    this.x = new Out('sec', budget);
    this.depth = 0;
  }

  section(recs) {
    for (const rec of recs) if (rec.tag === T.PARA_HEADER) this.x.root.append(this.paragraph(rec));
    return this.x.doc;
  }

  /** Paragraphs of a list (a cell, a text box, a header…). */
  list(recs) {
    const out = [];
    if (++this.depth > MAX_NESTING) { this.depth--; return out; }
    try {
      for (const rec of recs) if (rec.tag === T.PARA_HEADER) out.push(this.paragraph(rec));
    } finally { this.depth--; }
    return out;
  }

  paragraph(rec) {
    const x = this.x;
    const b = this.budget;
    if (++b.paras > b.maxParas) throw tooLarge();
    const r = new Reader(rec.data);
    r.u32(); r.u32();
    const shape = r.u16();
    const style = r.u8();
    const brk = r.u8();
    const p = x.el('p', { paraPrIDRef: shape, styleIDRef: style, pageBreak: brk & 4 ? 1 : 0, columnBreak: brk & 8 ? 1 : 0 });
    const textRec = rec.kids.find((k) => k.tag === T.PARA_TEXT);
    const shapeRec = rec.kids.find((k) => k.tag === T.PARA_CHAR_SHAPE);
    const ctrls = rec.kids.filter((k) => k.tag === T.CTRL_HEADER);
    // where each character shape starts
    const starts = [];
    if (shapeRec) {
      const sr = new Reader(shapeRec.data);
      while (sr.left >= 8 && starts.length < 100000) starts.push([sr.u32(), sr.u32()]);
    }
    if (!starts.length) starts.push([0, 0]);
    let si = 0;
    let run = null;
    let t = null;
    const newRun = (id) => { run = x.el('run', { charPrIDRef: id }); p.append(run); t = null; };
    newRun(starts[0][1]);
    const text = () => { if (!t) { t = x.el('t'); run.append(t); } return t; };
    let ci = 0;
    if (textRec) {
      const d = textRec.data;
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const n = d.length >> 1;
      if ((b.chars += n) > b.maxChars) throw tooLarge();
      let buf = '';
      const flush = () => { if (buf) { text().append(buf); buf = ''; } };
      for (let i = 0; i < n;) {
        if (si + 1 < starts.length && starts[si + 1][0] <= i) {
          while (si + 1 < starts.length && starts[si + 1][0] <= i) si++;
          flush();
          newRun(starts[si][1]);
        }
        const c = dv.getUint16(i * 2, true);
        if (c >= 32) { buf += isMark(c) ? '\u25A1' : String.fromCharCode(c); i++; continue; }
        if (EXTENDED.has(c)) {
          flush();
          const ctrl = ctrls[ci++];
          if (ctrl) for (const e of this.ctrl(ctrl)) { run.append(e); t = null; }
          i += 8;
        } else if (INLINE.has(c)) {
          if (c === 9) {
            flush();
            const w = i + 2 < n ? dv.getUint32((i + 1) * 2, true) : 4000;
            text().append(x.el('tab', { width: Math.min(w, 60000) }));
          }
          i += 8;
        } else {
          if (c === 10) { flush(); text().append(x.el('lineBreak')); }
          else if (c === 24) buf += '-';
          else if (c === 30) { flush(); text().append(x.el('nbSpace')); }
          else if (c === 31) { flush(); text().append(x.el('fwSpace')); }
          i++;
        }
      }
      flush();
    }
    // controls of a paragraph with no text record (a section's first one, an empty table line…)
    for (; ci < ctrls.length; ci++) {
      const id = ctrlId(ctrls[ci]);
      if (id === 'secd' || id === 'cold' || id === 'head' || id === 'foot' || id === 'pgnp' || id === 'nwno' || id === 'pghd') for (const e of this.ctrl(ctrls[ci])) run.append(e);
    }
    return p;
  }

  /** A control's elements (HWPX's: secPr, ctrl > …, tbl, pic, rect…). */
  ctrl(rec) {
    const x = this.x;
    const id = ctrlId(rec);
    const r = new Reader(rec.data, 4);
    switch (id) {
      case 'secd': return [this.secPr(rec, r)];
      case 'cold': {
        // (equal widths: the gap, then the rest of the properties; unequal ones: the rest of the
        // properties, then each column's width and gap)
        const prop = r.u16();
        const same = (prop >> 12) & 1;
        const count = Math.max(1, (prop >> 2) & 255);
        let gap = 0;
        if (count < 2 || same) { gap = r.u16(); r.u16(); } else {
          r.u16();
          r.u16();
          gap = r.u16();
          r.skip(4 * (count - 1));
        }
        const line = border(r);
        return [x.el('ctrl', null, x.el('colPr', { colCount: count, sameGap: gap }, line.type !== 'NONE' ? x.el('colLine', line) : null))];
      }
      case 'head':
      case 'foot': {
        const apply = ['BOTH', 'EVEN', 'ODD'][r.u32() & 3] || 'BOTH';
        return [x.el('ctrl', null, x.el(id === 'head' ? 'header' : 'footer', { applyPageType: apply }, x.el('subList', null, ...this.list(rec.kids))))];
      }
      case 'fn  ':
      case 'en  ':
        return [x.el('ctrl', null, x.el(id === 'fn  ' ? 'footNote' : 'endNote', null, x.el('subList', null, ...this.list(rec.kids))))];
      case 'atno': {
        const prop = r.u32();
        const num = r.u16();
        const type = ['PAGE', 'FOOTNOTE', 'ENDNOTE', 'PICTURE', 'TABLE', 'EQUATION'][prop & 15] || 'PAGE';
        return [x.el('ctrl', null, x.el('autoNum', { numType: type, num }, x.el('autoNumFormat', { type: numFmt((prop >> 4) & 255) })))];
      }
      case 'nwno': {
        const prop = r.u32();
        const num = r.u16();
        return [x.el('ctrl', null, x.el('newNum', { numType: ['PAGE', 'FOOTNOTE', 'ENDNOTE', 'PICTURE', 'TABLE', 'EQUATION'][prop & 15] || 'PAGE', num }))];
      }
      case 'pgnp': {
        const prop = r.u32();
        r.u16();
        const side = r.u16();
        const pos = ['NONE', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'OUTSIDE_TOP', 'OUTSIDE_BOTTOM', 'INSIDE_TOP', 'INSIDE_BOTTOM'][(prop >> 8) & 15] || 'NONE';
        return [x.el('ctrl', null, x.el('pageNum', { pos, formatType: numFmt(prop & 255), sideChar: side >= 32 ? unmark(String.fromCharCode(side)) : '' }))];
      }
      case 'pghd': {
        const prop = r.u32();
        return [x.el('ctrl', null, x.el('pageHiding', {
          hideHeader: prop & 1, hideFooter: (prop >> 1) & 1, hideMasterPage: (prop >> 2) & 1, hideBorder: (prop >> 3) & 1, hideFill: (prop >> 4) & 1, hidePageNum: (prop >> 5) & 1,
        }))];
      }
      case 'tdut': {
        const main = r.str(1000);
        const subText = r.str(1000);
        const pos = r.u32();
        const e = x.el('dutmal', { posType: pos === 1 ? 'BOTTOM' : 'TOP' }, x.el('mainText'), x.el('subText'));
        e.children[0].textContent = unmark(main);
        e.children[1].textContent = unmark(subText);
        return [e];
      }
      case 'tcps': {
        const e = x.el('t');
        e.textContent = unmark(r.str(100));
        return [e];
      }
      case 'tbl ': return this.depth >= MAX_NESTING ? [] : [this.table(rec, r)];
      case 'gso ': return this.depth >= MAX_NESTING ? [] : [this.shape(rec, r)].filter(Boolean);
      case 'eqed': {
        const f = this.frame(r);
        const eq = rec.kids.find((k) => k.tag === T.EQEDIT);
        const er = eq ? new Reader(eq.data) : null;
        if (er) er.u32();
        const script = x.el('script');
        script.textContent = er ? unmark(er.str(2000)) : '';
        return [x.el('equation', { textWrap: f.wrap }, ...this.frameEls(f), script)];
      }
      default: return []; // fields, bookmarks, hidden comments, page hiding: nothing to draw
    }
  }

  /** 구역 정의: page size and margins, first-page hiding, page borders, numbering start. */
  secPr(rec, r) {
    const x = this.x;
    const prop = r.u32();
    r.u16(); r.u16(); r.u16(); r.u32();
    const outline = r.u16();
    const pageStart = r.u16();
    const e = x.el('secPr', { outlineShapeIDRef: outline || '' },
      x.el('startNum', { page: pageStart }),
      x.el('visibility', { hideFirstHeader: prop & 1, hideFirstFooter: (prop >> 1) & 1 }));
    const pd = rec.kids.find((k) => k.tag === T.PAGE_DEF);
    if (pd) {
      const pr = new Reader(pd.data);
      let w = pr.u32();
      let h = pr.u32();
      const m = { left: pr.u32(), right: pr.u32(), top: pr.u32(), bottom: pr.u32(), header: pr.u32(), footer: pr.u32(), gutter: pr.u32() };
      if (pr.u32() & 1 && w < h) [w, h] = [h, w]; // landscape (stored upright)
      e.append(x.el('pagePr', { width: w, height: h }, x.el('margin', m)));
    }
    rec.kids.filter((k) => k.tag === T.PAGE_BORDER_FILL).slice(0, 3).forEach((k, i) => {
      const br = new Reader(k.data);
      const bp = br.u32();
      const off = { left: br.u16(), right: br.u16(), top: br.u16(), bottom: br.u16() };
      const id = br.u16();
      e.append(x.el('pageBorderFill', {
        type: ['BOTH', 'EVEN', 'ODD'][i], borderFillIDRef: id, textBorder: bp & 1 ? 'PAPER' : 'CONTENT',
        headerInside: (bp >> 1) & 1, footerInside: (bp >> 2) & 1, fillArea: ['PAPER', 'PAGE', 'BORDER'][(bp >> 3) & 3] || 'PAPER',
      }, x.el('offset', off)));
    });
    return e;
  }

  /** The common part of tables, drawings and equations: where and how big. */
  frame(r) {
    const prop = r.u32();
    const y = r.i32();
    const xo = r.i32();
    const w = r.u32();
    const h = r.u32();
    r.i32();
    const m = { left: r.i16(), right: r.i16(), top: r.i16(), bottom: r.i16() };
    return {
      pos: {
        treatAsChar: prop & 1,
        vertRelTo: ['PAPER', 'PAGE', 'PARA', 'PARA'][(prop >> 3) & 3],
        vertAlign: ['TOP', 'CENTER', 'BOTTOM', 'INSIDE', 'OUTSIDE'][(prop >> 5) & 7] || 'TOP',
        horzRelTo: ['PAPER', 'PAGE', 'COLUMN', 'PARA'][(prop >> 8) & 3],
        horzAlign: ['LEFT', 'CENTER', 'RIGHT', 'INSIDE', 'OUTSIDE'][(prop >> 10) & 7] || 'LEFT',
        vertOffset: y, horzOffset: xo,
      },
      wrap: ['SQUARE', 'TOP_AND_BOTTOM', 'BEHIND_TEXT', 'IN_FRONT_OF_TEXT'][(prop >> 21) & 7] || 'TOP_AND_BOTTOM',
      w, h, margin: m,
    };
  }

  frameEls(f) {
    const x = this.x;
    return [x.el('sz', { width: f.w, height: f.h }), x.el('pos', f.pos), x.el('outMargin', f.margin)];
  }

  /** A caption (캡션): its list header, then its paragraphs. */
  caption(lh, paras) {
    const r = new Reader(lh.data, 8);
    const prop = r.u32();
    const width = r.u32();
    const gap = r.u16();
    return this.x.el('caption', { side: ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'][prop & 3], width, gap }, this.x.el('subList', null, ...this.list(paras)));
  }

  /** Splits a control's children into lists: each LIST_HEADER with the paragraphs after it. */
  static lists(kids) {
    const out = [];
    let cur = null;
    for (const k of kids) {
      if (k.tag === T.LIST_HEADER) { cur = { lh: k, paras: [], before: null }; out.push(cur); } else if (k.tag === T.PARA_HEADER && cur) cur.paras.push(k);
    }
    return out;
  }

  table(rec, r) {
    const x = this.x;
    const f = this.frame(r);
    const ti = rec.kids.findIndex((k) => k.tag === T.TABLE);
    if (ti < 0) return null;
    const tr = new Reader(rec.kids[ti].data);
    const tprop = tr.u32();
    const nRows = Math.min(2000, tr.u16());
    const nCols = Math.min(200, tr.u16());
    tr.u16();
    const inM = { left: tr.u16(), right: tr.u16(), top: tr.u16(), bottom: tr.u16() };
    tr.skip(2 * nRows);
    const bf = tr.u16();
    const tbl = x.el('tbl', { colCnt: nCols, rowCnt: nRows, pageBreak: tprop & 3 ? 'CELL' : 'NONE', borderFillIDRef: bf, textWrap: f.wrap },
      ...this.frameEls(f), x.el('inMargin', inM));
    const cap = SectionWriter.lists(rec.kids.slice(0, ti))[0];
    if (cap) tbl.append(this.caption(cap.lh, cap.paras));
    const rows = new Map();
    for (const cell of SectionWriter.lists(rec.kids.slice(ti + 1))) {
      const cr = new Reader(cell.lh.data);
      cr.skip(4);
      const prop = cr.u32();
      const col = cr.u16();
      const row = cr.u16();
      const cs = cr.u16();
      const rs = cr.u16();
      const w = cr.u32();
      const h = cr.u32();
      const m = { left: cr.u16(), right: cr.u16(), top: cr.u16(), bottom: cr.u16() };
      const cbf = cr.u16();
      if (row >= 2000 || col >= 200) continue;
      const tc = x.el('tc', { borderFillIDRef: cbf, hasMargin: 1 },
        x.el('subList', { vertAlign: VALIGN[(prop >> 5) & 3] || 'TOP', textDirection: prop & 7 ? 'VERTICAL' : 'HORIZONTAL' }, ...this.list(cell.paras)),
        x.el('cellAddr', { colAddr: col, rowAddr: row }), x.el('cellSpan', { colSpan: Math.max(1, cs), rowSpan: Math.max(1, rs) }),
        x.el('cellSz', { width: w, height: h }), x.el('cellMargin', m));
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push([col, tc, Math.max(1, rs)]);
    }
    // (rows down to the last one a cell is in or spans: none for a table with no cells)
    let last = 0;
    for (const [row, cells] of rows) {
      for (const [, tc, rs] of cells) last = Math.max(last, row + 1, Math.min(nRows, row + rs));
    }
    for (let i = 0; i < last; i++) {
      const cells = (rows.get(i) || []).sort((a, b) => a[0] - b[0]);
      tbl.append(x.el('tr', null, ...cells.map((c) => c[1])));
    }
    return tbl;
  }

  /** A drawing object (gso): its caption, then the drawing (a picture, shape or group). */
  shape(rec, r) {
    const f = this.frame(r);
    const ci = rec.kids.findIndex((k) => k.tag === T.SHAPE_COMPONENT);
    if (ci < 0) return null;
    const e = this.component(rec.kids[ci], f);
    if (!e) return null;
    const cap = SectionWriter.lists(rec.kids.slice(0, ci))[0];
    if (cap) e.append(this.caption(cap.lh, cap.paras));
    return e;
  }

  /**
   * One drawing (개체 요소): a shape, a picture or a group of them. `f` is the frame of the
   * outermost one; drawings in a group have their place in the group instead.
   */
  component(rec, f, n = { count: 0 }) {
    const x = this.x;
    if (++n.count > 500) return null;
    const r = new Reader(rec.data);
    const first = r.u32();
    if (new Reader(rec.data, 4).u32() === first) r.u32(); // (the outermost one names its kind twice)
    const kind = String.fromCharCode((first >>> 24) & 255, (first >>> 16) & 255, (first >>> 8) & 255, first & 255);
    const gx = r.i32();
    const gy = r.i32();
    r.u16(); r.u16();
    const orgW = r.u32();
    const orgH = r.u32();
    const curW = r.u32();
    const curH = r.u32();
    r.u32();
    const angle = r.i16();
    r.i32(); r.i32();
    const cnt = Math.min(16, r.u16());
    r.skip(48);
    const scales = [];
    for (let i = 0; i < cnt; i++) {
      const s = [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()];
      r.skip(48);
      scales.push(x.el('scaMatrix', { e1: s[0], e5: s[4] }));
    }
    const name = { $rec: 'rect', $ell: 'ellipse', $arc: 'arc', $pol: 'polygon', $cur: 'curve', $lin: 'line', $pic: 'pic', $con: 'container', $ole: 'ole' }[kind] || 'ole';
    const el = x.el(name, { textWrap: f ? f.wrap : undefined });
    if (f) el.append(...this.frameEls(f));
    else el.append(x.el('offset', { x: gx, y: gy }));
    el.append(x.el('orgSz', { width: orgW, height: orgH }), x.el('curSz', { width: curW, height: curH }), x.el('renderingInfo', null, ...scales));
    if (angle) el.append(x.el('rotationInfo', { angle }));
    if (name === 'container') {
      for (const k of rec.kids) if (k.tag === T.SHAPE_COMPONENT) { const c = this.component(k, null, n); if (c) el.append(c); }
      return el;
    }
    if (name !== 'pic' && name !== 'ole') {
      const color = r.u32();
      const width = r.i32();
      const lp = r.u32();
      r.u8();
      el.append(x.el('lineShape', { style: (lp & 63) === 0 ? 'NONE' : 'SOLID', width, color: colorOf(color) || '#000000' }));
      const fill = fillXml(x, readFill(r));
      if (fill) el.append(fill);
    }
    for (const k of rec.kids) {
      const kr = new Reader(k.data);
      if (k.tag === T.SC_RECT) el.setAttribute('ratio', String(kr.u8()));
      else if (k.tag === T.SC_LINE) {
        el.append(x.el('startPt', { x: kr.i32(), y: kr.i32() }), x.el('endPt', { x: kr.i32(), y: kr.i32() }));
      } else if (k.tag === T.SC_POLYGON || k.tag === T.SC_CURVE) {
        // (no more points than the record holds)
        const count = Math.min(2000, Math.max(0, kr.i32()), kr.left >> 3);
        for (let i = 0; i < count; i++) el.append(x.el('pt', { x: kr.i32(), y: kr.i32() }));
      } else if (k.tag === T.SC_PICTURE) {
        const bc = kr.u32();
        const bw = kr.i32();
        const bp = kr.u32();
        kr.skip(32 + 16);
        const im = { left: kr.u16(), right: kr.u16(), top: kr.u16(), bottom: kr.u16() };
        kr.skip(3);
        const bin = kr.u16();
        el.append(x.el('img', { binaryItemIDRef: bin }), x.el('inMargin', im));
        // (a frame of width 0 is drawn as a hairline)
        if (bp & 63) el.append(x.el('lineShape', { style: 'SOLID', width: Math.max(28, bw), color: colorOf(bc) || '#000000' }));
      }
    }
    // a text box (글상자)
    const box = SectionWriter.lists(rec.kids)[0];
    if (box && name !== 'pic') {
      const lr = new Reader(box.lh.data, 4);
      const prop = lr.u32();
      const tm = { left: lr.u16(), right: lr.u16(), top: lr.u16(), bottom: lr.u16() };
      el.append(x.el('drawText', null, x.el('textMargin', tm), x.el('subList', { vertAlign: VALIGN[(prop >> 5) & 3] || 'TOP' }, ...this.list(box.paras))));
    }
    return el;
  }
}
