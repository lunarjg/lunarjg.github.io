// Hangul (HWPX / OWPML) documents laid out as HTML pages for js/convert.js, which breaks them into
// pages, draws them and writes the PDF. Reads the package's header.xml (fonts, character and
// paragraph shapes, borders and fills, numbering), its sections (paragraphs, runs, tables,
// pictures, text boxes, simple shapes, headers and footers, page numbers, footnotes, columns,
// page breaks) and its pictures. (HWP 5.0 files are to be turned into the same XML first.)
//
// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
//
// Everything is built with DOM methods (never markup from the file), values from the file are
// checked before they reach a style, and pictures are data: URLs of the formats a browser shows.
//
// Units: HWPUNIT = 1/7200 inch → px = v / 75. Font sizes in 1/100 pt.

const PX = 1 / 75;
const px = (v) => (Number(v) || 0) * PX;
const clampPx = (v, lo = -2000, hi = 20000) => Math.max(lo, Math.min(hi, px(v)));

// ------------------------------------------------------------------ XML helpers (any prefix)
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const attr = (el, name, dflt = '') => (el && el.hasAttribute(name) ? el.getAttribute(name) : dflt);
const num = (el, name, dflt = 0) => {
  const v = Number(attr(el, name, ''));
  return Number.isFinite(v) ? v : dflt;
};
const on = (el, name) => /^(1|true)$/i.test(attr(el, name, '0'));
/** A signed value (offsets and points are written as unsigned 32-bit numbers when negative). */
const sint = (el, name, dflt = 0) => {
  const v = num(el, name, dflt);
  return v >= 2 ** 31 ? v - 2 ** 32 : v;
};
/**
 * Children with <hp:switch> resolved: the branch for "HwpUnitChar" (the values Hangul lays out
 * with — the default branch holds paragraph margins doubled, for older readers), otherwise the
 * default branch.
 */
function unswitch(el) {
  const out = [];
  for (const c of el ? el.children : []) {
    if (c.localName === 'switch') {
      const want = kids(c, 'case').find((x) => [...x.attributes].some((a) => a.localName === 'required-namespace' && /HwpUnitChar/.test(a.value)));
      const d = want || kid(c, 'default') || kids(c, 'case')[0];
      if (d) out.push(...unswitch(d));
    } else out.push(c);
  }
  return out;
}
const sub = (el, name) => unswitch(el).find((c) => c.localName === name) || null;

const COLOR = /^#[0-9a-f]{6}$/i;
const color = (v, dflt = '') => (COLOR.test(v || '') ? v : dflt);
/** A font name safe inside a CSS string. */
const fontName = (s) => String(s || '').replace(/["'\\;{}<>\n\r]/g, '').trim().slice(0, 80);
const SERIF = /바탕|명조|궁서|batang|myeongjo|gungsuh|serif|times|mincho|明朝|宋|song|georgia|garamond/i;
const MONO = /courier|consolas|mono|d2coding|고정폭/i;
const generic = (f) => (MONO.test(f) ? 'monospace' : SERIF.test(f) && !/sans/i.test(f) ? 'serif' : 'sans-serif');
/** A weight implied by a face's name (heavy title faces), 0 when none. */
function weightOf(f) {
  if (/헤드라인|견고딕|견명조|굵은|extrabold|extra bold|black|heavy/i.test(f)) return 800;
  if (/bold|[가-힣]B$/i.test(f) && !/semi|demi/i.test(f)) return 700;
  if (/semibold|demibold|[가-힣]M$|medium/i.test(f)) return 600;
  return 0;
}

/** A border width ("0.12 mm") in px. */
function borderWidth(v) {
  const m = String(v || '').match(/^([\d.]+)\s*mm$/);
  return m ? Math.min(20, (parseFloat(m[1]) * 96) / 25.4) : 0.5;
}
const BORDER_STYLE = {
  SOLID: 'solid', DASH: 'dashed', DOT: 'dotted', DASH_DOT: 'dashed', DASH_DOT_DOT: 'dashed', LONG_DASH: 'dashed',
  CIRCLE: 'dotted', DOUBLE_SLIM: 'double', SLIM_THICK: 'double', THICK_SLIM: 'double', SLIM_THICK_SLIM: 'double',
  WAVE: 'solid', DOUBLE_WAVE: 'double', THICK_3D: 'ridge', THICK_3D_REVERS: 'groove', '3D': 'ridge', '3D_REVERS': 'groove',
};
function borderCss(b) {
  if (!b) return 'none';
  const type = attr(b, 'type', 'NONE');
  if (type === 'NONE') return 'none';
  const w = borderWidth(attr(b, 'width'));
  const style = BORDER_STYLE[type] || 'solid';
  return `${(style === 'double' ? Math.max(w, 2.5) : w).toFixed(2)}px ${style} ${color(attr(b, 'color'), '#000000')}`;
}

// ------------------------------------------------------------------ numbers
const HANGUL = '가나다라마바사아자차카타파하';
const JAMO = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const IDEO = '一二三四五六七八九十';
function roman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
const letters = (n, base) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(base + ((x - 1) % 26)) + s;
  return s || String(n);
};
export function formatNumber(n, fmt) {
  switch (fmt) {
    case 'CIRCLED_DIGIT': return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n);
    case 'ROMAN_CAPITAL': return roman(n);
    case 'ROMAN_SMALL': return roman(n).toLowerCase();
    case 'LATIN_CAPITAL': return letters(n, 65);
    case 'LATIN_SMALL': return letters(n, 97);
    case 'CIRCLED_LATIN_CAPITAL': return n >= 1 && n <= 26 ? String.fromCharCode(0x24b6 + n - 1) : letters(n, 65);
    case 'CIRCLED_LATIN_SMALL': return n >= 1 && n <= 26 ? String.fromCharCode(0x24d0 + n - 1) : letters(n, 97);
    case 'HANGUL_SYLLABLE': return HANGUL[(n - 1) % 14] || String(n);
    case 'CIRCLED_HANGUL_SYLLABLE': return n >= 1 && n <= 14 ? String.fromCharCode(0x326e + n - 1) : HANGUL[(n - 1) % 14];
    case 'HANGUL_JAMO': return JAMO[(n - 1) % 14] || String(n);
    case 'CIRCLED_HANGUL_JAMO': return n >= 1 && n <= 14 ? String.fromCharCode(0x3260 + n - 1) : JAMO[(n - 1) % 14];
    case 'HANGUL_PHONETIC': return ['일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십'][n - 1] || String(n);
    case 'IDEOGRAPH': return IDEO[n - 1] || String(n);
    case 'CIRCLED_IDEOGRAPH': return n >= 1 && n <= 10 ? String.fromCharCode(0x3280 + n - 1) : IDEO[n - 1] || String(n);
    default: return String(n);
  }
}

/** Page-number marks: digits use convert.js's mark; other formats one character each. */
export const NUM_FORMATS = ['ROMAN_CAPITAL', 'ROMAN_SMALL', 'LATIN_CAPITAL', 'LATIN_SMALL', 'CIRCLED_DIGIT', 'HANGUL_SYLLABLE', 'HANGUL_JAMO', 'IDEOGRAPH'];
export const NUM_MARK_BASE = 0xE100;
const pageMark = (fmt) => {
  const i = NUM_FORMATS.indexOf(fmt);
  return i < 0 ? '\uE0F1' : String.fromCharCode(NUM_MARK_BASE + i);
};
/** Too much to lay out (convert.js says so). */
/** All the pictures placed in a document, in data: URL characters (about 36 MB of pictures). */
const MAX_PLACED = 48e6;
/** Bullets in symbol fonts (Wingdings and the like, stored as U+F0xx) as the characters they draw. */
const SYMBOL_BULLETS = { 0x6c: '●', 0x6e: '■', 0x6f: '□', 0x71: '❑', 0x75: '◆', 0xa7: '▪', 0xa8: '◻', 0xd8: '➢', 0xfc: '✔', 0x9f: '•', 0xb7: '•' };
/** How deep objects go inside each other (tables, text boxes, groups), and table cells in all. */
const MAX_DEPTH = 12;
/** Elements copied onto pages (headers, footers, backgrounds), and objects behind/in front of the text. */
const MAX_COPIES = 600000;
const MAX_FLOATS = 2000;
/** Tables, pictures and drawings in a document (an 80-page report with many: ~750). */
const MAX_OBJECTS = 10000;
const MAX_CELLS = 200000;
function tooLarge() {
  const e = new Error('too large');
  e.tooLarge = true;
  return e;
}

// ------------------------------------------------------------------ the document's shapes
/** header.xml → lookup tables and the style sheet. */
function readHeader(header) {
  const fonts = {}; // lang → [face]
  for (const ff of header.getElementsByTagNameNS('*', 'fontface')) {
    const lang = attr(ff, 'lang').toLowerCase();
    fonts[lang] = kids(ff, 'font').map((f) => fontName(attr(f, 'face')));
  }
  const byId = (name) => {
    const m = new Map();
    for (const e of header.getElementsByTagNameNS('*', name)) m.set(attr(e, 'id'), e);
    return m;
  };
  return {
    fonts,
    charPrs: byId('charPr'),
    paraPrs: byId('paraPr'),
    borderFills: byId('borderFill'),
    numberings: byId('numbering'),
    bullets: byId('bullet'),
    styles: byId('style'),
  };
}

/** About one line of a character shape's text, in px. */
const lineHeight = (cp) => (num(cp, 'height', 1000) / 100) * (4 / 3) * 1.6;

function charCss(cp, fonts) {
  const css = [];
  const h = num(cp, 'height', 1000);
  const rel = num(kid(cp, 'relSz'), 'hangul', 100) || 100;
  css.push(`font-size:${((h / 100) * (rel / 100)).toFixed(2)}pt`);
  const ref = kid(cp, 'fontRef');
  let heavy = 0;
  if (ref) {
    const fam = [];
    for (const lang of ['latin', 'hangul', 'hanja', 'japanese', 'other', 'symbol']) {
      const f = (fonts[lang] || [])[num(ref, lang, 0)];
      if (f && !fam.includes(f)) fam.push(f);
    }
    // (serif or sans by the Hangul face: that is the look of most of the text)
    const hangul = (fonts.hangul || [])[num(ref, 'hangul', 0)] || fam[0] || '';
    if (fam.length) css.push(`font-family:${fam.map((f) => `"${f}"`).join(',')},${generic(hangul)}`);
    // heavy title faces (HY헤드라인M, 견고딕…) look bold in the fallback font too
    heavy = weightOf(hangul);
  }
  const c = color(attr(cp, 'textColor'));
  if (c) css.push(`color:${c}`);
  const shade = color(attr(cp, 'shadeColor'));
  if (shade && shade.toLowerCase() !== '#ffffff') css.push(`background-color:${shade}`);
  if (kid(cp, 'bold')) css.push(`font-weight:${Math.max(700, heavy)}`);
  else if (heavy) css.push(`font-weight:${heavy}`);
  if (kid(cp, 'italic')) css.push('font-style:italic');
  const deco = [];
  const ul = kid(cp, 'underline');
  if (ul && attr(ul, 'type', 'NONE') !== 'NONE') deco.push(attr(ul, 'type') === 'TOP' ? 'overline' : 'underline');
  const so = kid(cp, 'strikeout');
  if (so && !/^(NONE|3D)$/.test(attr(so, 'shape', 'NONE'))) deco.push('line-through');
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
  // 자간 (letter spacing) and 장평 (character width): the width can't be set in CSS, so a narrower
  // width takes that much room out between the characters (the lines then break as in Hangul)
  const sp = Math.max(-50, Math.min(50, num(kid(cp, 'spacing'), 'hangul', 0)));
  const ratio = Math.max(50, Math.min(200, num(kid(cp, 'ratio'), 'hangul', 100) || 100));
  // (only partly, and never so tight that letters run into each other)
  const ls = Math.max(-0.12, sp / 100 + (ratio - 100) / 100 * 0.5);
  if (Math.abs(ls) > 0.001) css.push(`letter-spacing:${ls.toFixed(3)}em`);
  if (kid(cp, 'supscript')) css.push('vertical-align:super;font-size:70%');
  else if (kid(cp, 'subscript')) css.push('vertical-align:sub;font-size:70%');
  return css.join(';');
}

function paraCss(pp) {
  const css = [];
  const align = attr(kid(pp, 'align'), 'horizontal', 'LEFT');
  const a = { JUSTIFY: 'justify', CENTER: 'center', RIGHT: 'right', DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify' }[align] || 'left';
  css.push(`text-align:${a}`);
  if (/^DISTRIBUTE/.test(align)) css.push('text-align-last:justify');
  const m = sub(pp, 'margin');
  const val = (n) => num(kid(m, n), 'value', 0);
  const indent = val('intent');
  const left = val('left');
  if (indent < 0) css.push(`padding-left:${px(left - indent).toFixed(2)}px`, `text-indent:${px(indent).toFixed(2)}px`);
  else css.push(`padding-left:${px(left).toFixed(2)}px`, `text-indent:${px(indent).toFixed(2)}px`);
  css.push(`padding-right:${px(val('right')).toFixed(2)}px`, `--hw-prev:${px(val('prev')).toFixed(2)}px`, `--hw-next:${px(val('next')).toFixed(2)}px`,
    'margin-top:var(--hw-prev)', 'margin-bottom:var(--hw-next)');
  const ls = sub(pp, 'lineSpacing');
  const type = attr(ls, 'type', 'PERCENT');
  const v = num(ls, 'value', 160);
  if (type === 'PERCENT') {
    const lh = Math.max(50, Math.min(500, v)) / 100;
    css.push(`line-height:${lh.toFixed(3)}`, `--hw-lead:${(Math.max(0, lh - 1) / 2).toFixed(3)}em`);
  }
  else if (type === 'FIXED') css.push(`line-height:${px(v).toFixed(2)}px`);
  else if (type === 'BETWEEN_LINES') css.push(`line-height:calc(1.2em + ${px(v).toFixed(2)}px)`);
  else if (type === 'AT_LEAST') css.push(`line-height:max(1.2em,${px(v).toFixed(2)}px)`);
  const bs = kid(pp, 'breakSetting');
  if (on(bs, 'keepWithNext')) css.push('break-after:avoid');
  if (on(bs, 'keepLines')) css.push('break-inside:avoid');
  if (on(bs, 'pageBreakBefore')) css.push('break-before:column');
  return css.join(';');
}

function fillCss(bf) {
  const css = [];
  const fill = kid(bf, 'fillBrush');
  const win = kid(fill, 'winBrush');
  const face = color(attr(win, 'faceColor'));
  if (face && attr(win, 'faceColor').toLowerCase() !== 'none') css.push(`background-color:${face}`);
  else {
    const g = kid(fill, 'gradation');
    const cs = kids(g, 'color').slice(0, 8).map((c) => color(attr(c, 'value'))).filter(Boolean);
    if (cs.length >= 2) css.push(`background-image:linear-gradient(${num(g, 'angle', 90)}deg,${cs.join(',')})`);
  }
  return css;
}
function borderFillCss(bf) {
  if (!bf) return '';
  const css = [
    `border-left:${borderCss(kid(bf, 'leftBorder'))}`, `border-right:${borderCss(kid(bf, 'rightBorder'))}`,
    `border-top:${borderCss(kid(bf, 'topBorder'))}`, `border-bottom:${borderCss(kid(bf, 'bottomBorder'))}`,
    ...fillCss(bf),
  ];
  return css.join(';');
}

/** The style sheet for the document's shapes (class per id). */
function styleSheet(h) {
  const rules = [
    // base: Hancom's default look; the converter's own page rules come after these
    'section.docx{box-sizing:border-box;background:#fff;color:#000;font-family:"함초롬바탕",serif;font-size:10pt;line-height:1.6}',
    '.hw-p{margin:0;min-height:1em;white-space:pre-wrap;overflow-wrap:break-word;orphans:1;widows:1}',
    '.hw-p>span{white-space:pre-wrap}',
    '.hw-tbl{border-collapse:collapse;table-layout:fixed;empty-cells:show}',
    '.hw-tbl td{vertical-align:top;box-sizing:border-box;overflow-wrap:anywhere}',
    // (in a cell, no line spacing above the first line or below the last one, as in Hangul)
    '.hw-tbl td>.hw-p:first-child{margin-top:calc(var(--hw-prev,0px) - var(--hw-lead,0em))}',
    '.hw-tbl td>.hw-p:last-child{margin-bottom:calc(var(--hw-next,0px) - var(--hw-lead,0em))}',
    '.hw-vert{writing-mode:vertical-rl;text-orientation:upright;display:inline-block;text-align:left}',
    '.hw-obj{display:inline-block;position:relative;vertical-align:bottom;box-sizing:border-box}',
    '.hw-block{display:block}',
    'table.hw-block,table.hw-obj{display:table}',
    'div.hw-block,table.hw-nobreak{break-inside:avoid}',
    '.hw-tbl:not(.hw-nobreak) tr{break-inside:auto}',
    '.hw-float{position:absolute;z-index:2}',
    '.hw-float.behind{z-index:0}',
    '.hw-img{display:block;width:100%;height:100%;object-fit:fill}',
    '.hw-missing{background:#f2f2f2;border:.5px dashed #999}',
    '.hw-tab{display:inline-block}',
    '.hw-eq{font-family:serif;font-style:italic}',
    '.hw-frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;font-size:90%;margin:0 .1em}',
    '.hw-frac>span+span{border-top:1px solid currentColor}',
    '.hw-notes{margin-top:12pt;font-size:9pt}',
    '.hw-notes::before{content:"";display:block;width:33%;border-top:.75pt solid #000;margin-bottom:4pt}',
    '.hw-noteref{vertical-align:super;font-size:70%}',
  ];
  for (const [id, cp] of h.charPrs) rules.push(`.cp${cssId(id)}{${charCss(cp, h.fonts)}}`);
  for (const [id, pp] of h.paraPrs) rules.push(`.pp${cssId(id)}{${paraCss(pp)}}`);
  return rules.join('\n');
}
const cssId = (id) => String(id).replace(/[^0-9a-z_-]/gi, '_');

// ------------------------------------------------------------------ equations
/** Words of Hangul's equation script drawn as a symbol. */
const EQ_SYMBOLS = {
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', sim: '∼', equiv: '≡', inf: '∞', infty: '∞', infinity: '∞', sum: '∑', prod: '∏', int: '∫', oint: '∮',
  partial: '∂', nabla: '∇', therefore: '∴', because: '∵', in: '∈', notin: '∉', subset: '⊂', supset: '⊃',
  cup: '∪', cap: '∩', forall: '∀', exist: '∃', emptyset: '∅', angle: '∠', deg: '°', prime: '′',
  larrow: '←', rarrow: '→', lrarrow: '↔', LARROW: '⇐', RARROW: '⇒', LRARROW: '⇔', uparrow: '↑', downarrow: '↓',
  cdots: '⋯', ldots: '…', vdots: '⋮', ddots: '⋱', bot: '⊥', perp: '⊥', triangle: '△', circ: '∘', smallsum: '∑',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
  kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  ALPHA: 'Α', BETA: 'Β', GAMMA: 'Γ', DELTA: 'Δ', THETA: 'Θ', LAMBDA: 'Λ', PI: 'Π', SIGMA: 'Σ', PHI: 'Φ', PSI: 'Ψ', OMEGA: 'Ω',
};
/** Words that only change the look (roman, italic, bold, bracket sizing): nothing to draw. */
const EQ_SILENT = /^(rm|it|bold|left|right|LEFT|RIGHT|big|BIG|scale)$/;
/**
 * A Hangul equation script (e.g. `{1} over {2} sqrt {x^2}`) drawn roughly as text: fractions,
 * roots, sub- and superscripts and the common symbols. (Not a full equation layout.)
 */
function equation(into, script, b) {
  const toks = String(script).match(/"[^"]*"|[A-Za-z]+|\d+(?:\.\d+)?|\s+|[^\sA-Za-z\d]/g) || [];
  let i = 0;
  let depth = 0;
  let fracs = 0; // (fractions nest as flex boxes, which the browser can't take very deep)
  const atom = () => {
    // one thing to which ^, _ and over apply
    while (i < toks.length && /^\s+$/.test(toks[i])) i++;
    if (i >= toks.length) return null;
    const t = toks[i++];
    if (t === '{') {
      const g = b.el('span');
      if (++depth < 40) seq(g, '}'); else i = toks.length;
      depth--;
      return g;
    }
    if (t === '}') return null;
    if (t === 'over') return b.doc.createTextNode('/'); // (past the fractions drawn as such)
    if (t[0] === '"') return b.doc.createTextNode(t.slice(1, -1));
    if (t === 'sqrt' || t === 'root') {
      const s = b.el('span');
      if (t === 'root') {
        const n = atom();
        const k = b.el('sup');
        if (n) k.append(n);
        s.append(k);
        if (toks[i] && /^\s+$/.test(toks[i])) i++;
        if (toks[i] === 'of') i++;
      }
      s.append(b.doc.createTextNode('√'));
      const r = b.el('span', '', 'border-top:1px solid currentColor');
      const x = atom();
      if (x) r.append(x);
      s.append(r);
      return s;
    }
    if (EQ_SILENT.test(t)) return b.doc.createTextNode('');
    if (t === '~' || t === '`') return b.doc.createTextNode(t === '~' ? ' ' : ' ');
    if (t === '#') return b.el('br');
    if (t === '&') return b.doc.createTextNode(' ');
    if (Object.prototype.hasOwnProperty.call(EQ_SYMBOLS, t)) return b.doc.createTextNode(EQ_SYMBOLS[t]);
    return b.doc.createTextNode(t);
  };
  const seq = (into2, end) => {
    let prev = null;
    while (i < toks.length) {
      while (i < toks.length && /^\s+$/.test(toks[i])) i++;
      if (i >= toks.length) break;
      const t = toks[i];
      if (t === end) { i++; break; }
      if ((t === '^' || t === '_' || t === 'sup' || t === 'sub') && prev) {
        i++;
        const e = b.el(t === '^' || t === 'sup' ? 'sup' : 'sub');
        const x = atom();
        if (x) e.append(x);
        into2.append(e);
        continue;
      }
      if (t === 'over' && prev && fracs < 24) {
        fracs++;
        i++;
        const f = b.el('span', 'hw-frac');
        const top = b.el('span');
        top.append(prev);
        const bot = b.el('span');
        const x = atom();
        if (x) bot.append(x);
        f.append(top, bot);
        into2.append(f);
        prev = f;
        continue;
      }
      const a = atom();
      if (!a) continue;
      into2.append(a);
      prev = a;
    }
  };
  seq(into, null);
  b.addText(into.textContent.length);
}

// ------------------------------------------------------------------ pictures
const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'], [[0x52, 0x49, 0x46, 0x46], 'image/webp'],
];
const MAX_PIXELS = 40e6;
/** Width × height from a picture's header (0 when it can't be read). */
function pixels(b, type) {
  const be16 = (i) => (b[i] << 8) | b[i + 1];
  const be32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const le16 = (i) => b[i] | (b[i + 1] << 8);
  const le32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + ((b[i + 3] << 24) >>> 0);
  if (b.length < 30) return 0;
  if (type === 'image/png') return be32(16) * be32(20);
  if (type === 'image/gif') return le16(6) * le16(8);
  if (type === 'image/bmp') return Math.abs(le32(18) | 0) * Math.abs(le32(22) | 0);
  if (type === 'image/webp') {
    const kind = String.fromCharCode(...b.subarray(12, 16));
    if (kind === 'VP8X') return (1 + (b[24] | (b[25] << 8) | (b[26] << 16))) * (1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    if (kind === 'VP8L') { const v = le32(21); return ((v & 0x3fff) + 1) * (((v >>> 14) & 0x3fff) + 1); }
    if (kind === 'VP8 ') return (le16(26) & 0x3fff) * (le16(28) & 0x3fff);
    return 0;
  }
  // JPEG: the frame header (SOFn) after the markers before it
  for (let i = 2; i + 9 < b.length && i < 2e6;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return be16(i + 5) * be16(i + 7);
    i += 2 + be16(i + 2);
  }
  return 0;
}

const pictureType = (bytes) => {
  if (!bytes || bytes.length < 12) return null;
  const type = (MAGIC.find(([m]) => m.every((b, i) => bytes[i] === b)) || [])[1] || null;
  return type === 'image/webp' && String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP' ? null : type;
};
/** A picture's size in pixels once decoded (0 when it isn't one that is drawn). */
export const picturePixels = (bytes) => {
  const type = pictureType(bytes);
  return type ? pixels(bytes, type) || 0 : 0;
};

/** A picture's bytes as a data: URL, only for formats a browser draws (not WMF/EMF). */
export function pictureUrl(bytes) {
  const type = pictureType(bytes);
  if (!type) return null;
  // (a small file can hold a huge picture: decoding it would take more memory than a phone has)
  const px2 = pixels(bytes, type);
  if (!(px2 > 0) || px2 > MAX_PIXELS) return null;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

// ------------------------------------------------------------------ building pages
/**
 * Lays the document out into `box` (in the frame document `doc`) and its styles into `head`.
 * src: { header: XMLDocument, sections: [XMLDocument], picture: async (binaryItemId) → data: URL | null }
 */
export async function renderOwpml(src, doc, box, head) {
  const h = readHeader(src.header);
  const style = doc.createElement('style');
  style.textContent = styleSheet(h);
  head.append(style);
  const b = new Builder(h, doc, src.picture, { maxPages: src.maxPages || 500, maxText: src.maxText || 2e6 });
  for (const sec of src.sections) await b.section(sec.documentElement || sec);
  b.endnotes();
  for (const el of b.pages) box.append(el);
}

class Builder {
  constructor(h, doc, picture, limits) {
    this.h = h;
    this.doc = doc;
    this.picture = picture;
    this.limits = limits;
    this.textCount = 0;
    this.depth = 0; // objects inside objects
    this.copies = 0; // elements copied onto every page
    this.floats = 0;
    this.objects = 0;
    this.cells = 0;
    this.pages = [];
    this.counters = new Map(); // numbering id → [level values]
    this.endnoteList = [];
    this.footnoteNo = 0;
    this.endnoteNo = 0;
    this.pictures = 0;
  }

  el(tag, cls, css) {
    const e = this.doc.createElement(tag);
    if (cls) e.className = cls;
    if (css) e.style.cssText = css;
    return e;
  }

  // ---------------------------------------------------------------- sections and pages
  async section(sec) {
    // page setup from the first secPr (in the first paragraph's first run)
    const secPr = sec.getElementsByTagNameNS('*', 'secPr')[0] || null;
    const page = kid(secPr, 'pagePr');
    const m = kid(page, 'margin');
    let w = num(page, 'width', 59528);
    let hh = num(page, 'height', 84188);
    if (attr(page, 'landscape') === 'NARROWLY' && w < hh) [w, hh] = [hh, w]; // landscape: stored upright
    this.geo = {
      w: Math.max(100, Math.min(4000, px(w))), h: Math.max(100, Math.min(6000, px(hh))),
      left: px(num(m, 'left', 8504)), right: px(num(m, 'right', 8504)), top: px(num(m, 'top', 5668)), bottom: px(num(m, 'bottom', 4252)),
      header: px(num(m, 'header', 4252)), footer: px(num(m, 'footer', 4252)), gutter: px(num(m, 'gutter', 0)),
    };
    this.geo.left += this.geo.gutter;
    const vis = kid(secPr, 'visibility');
    this.hideFirst = { header: on(vis, 'hideFirstHeader'), footer: on(vis, 'hideFirstFooter'), pageNum: on(vis, 'hideFirstPageNum') };
    this.outline = attr(secPr, 'outlineShapeIDRef', '');
    this.pageBg = await this.pageBorder(secPr);
    this.headers = [];
    this.footers = [];
    this.pageNum = null;
    this.notes = [];
    this.firstPage = true;
    this.cols = null; // (each section sets its own)
    this.newPage();
    // 시작 쪽 번호: 0 goes on from the section before
    const start = num(kid(secPr, 'startNum'), 'page', 0);
    if (start > 0) this.page.dataset.nvPageNo = String(Math.min(1e6, start));
    for (const p of kids(sec, 'p')) await this.paragraph(p, this.article);
    this.finishPage();
  }

  newPage() {
    if (this.pages.length >= this.limits.maxPages) throw tooLarge();
    const g = this.geo;
    const s = this.el('section', 'docx');
    s.lang = 'ko'; // (Korean forms of the characters Korean and Chinese share)
    s.style.width = g.w + 'px';
    s.style.minHeight = g.h + 'px';
    s.style.padding = `${g.top + g.header}px ${g.right}px ${g.bottom + g.footer}px ${g.left}px`;
    s.dataset.nvFirst = this.firstPage ? '1' : '';
    // "hide on the first page": the first page of the section shows only its first-page parts (none)
    s.dataset.nvTitle = this.firstPage && (this.hideFirst.header || this.hideFirst.footer || this.hideFirst.pageNum) ? '1' : '';
    this.firstPage = false;
    this.page = s;
    this.pages.push(s);
    if (this.pageBg) s.append(this.addCopy(this.pageBg.cloneNode(true)));
    this.article = this.el('article');
    if (this.cols) this.applyCols(this.article, this.cols);
    s.append(this.article);
  }

  /**
   * The section's page border and background (쪽 테두리/배경): lines around the page, a colour,
   * gradient or picture over the paper, behind everything. (Even/odd variants: the "both" one.)
   */
  async pageBorder(secPr) {
    const pbf = kids(secPr, 'pageBorderFill').find((x) => attr(x, 'type', 'BOTH') === 'BOTH') || kids(secPr, 'pageBorderFill')[0];
    const bf = pbf && this.h.borderFills.get(attr(pbf, 'borderFillIDRef'));
    if (!bf) return null;
    const g = this.geo;
    const off = kid(pbf, 'offset');
    const o = ['top', 'right', 'bottom', 'left'].map((k) => px(num(off, k, 1417)));
    // the border: around the body (with the header and footer when they are inside it), out
    // by the offsets — that is where Hangul draws "종이 기준" — or from the paper's edge
    const top = on(pbf, 'headerInside') ? g.top : g.top + g.header;
    const bottom = on(pbf, 'footerInside') ? g.bottom : g.bottom + g.footer;
    const box = (attr(pbf, 'textBorder', 'PAPER') === 'PAPER'
      ? [top - o[0], g.right - o[1], bottom - o[2], g.left - o[3]]
      : [o[0], o[1], o[2], o[3]]).map((v) => Math.max(0, v));
    const fillArea = attr(pbf, 'fillArea', 'PAPER');
    const fill = fillArea === 'PAPER' ? [0, 0, 0, 0] : fillArea === 'PAGE' ? [g.top + g.header, g.right, g.bottom + g.footer, g.left] : box;
    const layer = this.el('div', '', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none');
    layer.dataset.nvPage = '1';
    const fillCss2 = fillCss(bf);
    const url = await this.imgFill(bf);
    if (fillCss2.length || url) {
      const f = this.el('div', '', `position:absolute;top:${fill[0]}px;right:${fill[1]}px;bottom:${fill[2]}px;left:${fill[3]}px;${fillCss2.join(';')}`);
      if (url) {
        const i = this.el('img', 'hw-img');
        i.alt = '';
        i.src = url;
        f.append(i);
      }
      layer.append(f);
    }
    const lines = ['topBorder', 'rightBorder', 'bottomBorder', 'leftBorder'].map((k) => borderCss(kid(bf, k)));
    if (lines.some((l) => l !== 'none')) {
      layer.append(this.el('div', '', `position:absolute;box-sizing:border-box;top:${box[0]}px;right:${box[1]}px;bottom:${box[2]}px;left:${box[3]}px;`
        + `border-top:${lines[0]};border-right:${lines[1]};border-bottom:${lines[2]};border-left:${lines[3]}`));
    }
    return layer.childNodes.length ? layer : null;
  }

  /**
   * A picture for one more place in the document, or null (a grey box) once the pictures placed
   * add up to too much to draw: the same big picture used over and over would be drawn every time.
   */
  async usePicture(ref) {
    const url = this.picture ? await this.picture(ref) : null;
    if (!url || (this.pictures += url.length) > MAX_PLACED) return null;
    return url;
  }

  /** A border/fill's picture (그림 채우기) as a data: URL, or null. */
  async imgFill(bf) {
    const img = kid(kid(bf, 'fillBrush'), 'imgBrush');
    const ref = img && attr(img.getElementsByTagNameNS('*', 'img')[0], 'binaryItemIDRef');
    return ref ? this.usePicture(ref) : null;
  }

  /** Headers, footers, page numbers and footnotes go on the page element when it is complete. */
  finishPage() {
    const s = this.page;
    const g = this.geo;
    const first = s.dataset.nvTitle === '1';
    const place = (list, kind) => {
      // (after the page's background, so that doesn't cover them)
      const bg = s.querySelector(':scope > [data-nv-page]');
      for (const part of list) {
        const e = this.el(kind);
        e.dataset.nvHf = part.type;
        if (kind === 'header') { e.style.marginTop = `-${g.header}px`; e.style.minHeight = `${g.header}px`; } else { e.style.marginBottom = `-${g.footer}px`; e.style.minHeight = `${g.footer}px`; }
        e.append(...part.nodes.map((n) => n.cloneNode(true)));
        this.addText(e.textContent.length);
        this.addCopy(e);
        if (kind === 'header') { if (bg) bg.after(e); else s.prepend(e); } else s.append(e);
      }
    };
    if (this.notes.length) {
      const ol = this.el('div', 'hw-notes');
      for (const n of this.notes) ol.append(n);
      this.article.after(ol);
      this.notes = [];
    }
    // the page number (쪽 번호 매기기): a line in the footer or header area of this page
    let num = null;
    const numTop = !!this.pageNum && /^TOP/.test(this.pageNum.pos);
    if (this.pageNum) s.dataset.nvNumIn = numTop ? 'header' : 'footer'; // (for 감추기: where the number is)
    if (this.pageNum) {
      const pos = this.pageNum.pos;
      num = this.el('div', 'hw-p', `text-align:${/LEFT/.test(pos) ? 'left' : /RIGHT/.test(pos) ? 'right' : 'center'};font-size:10pt`);
      const side = this.pageNum.side;
      num.append(this.doc.createTextNode(side ? side + ' ' : ''), this.mark(this.pageNum.format), this.doc.createTextNode(side ? ' ' + side : ''));
      num.dataset.nvPageNum = '1'; // (감추기 hides just this, not the rest of the header or footer)
    }
    // This page's parts (copies: the section's own stay as they are). On a first page that hides
    // something (감추기), a first-page part: the default one without what is hidden.
    const parts = (list, kind) => {
      const withNum = !!num && (kind === 'header') === numTop;
      const out = list.map((p) => ({ type: p.type, nodes: [...p.nodes] }));
      if (withNum && !out.some((p) => p.type === 'default')) out.push({ type: 'default', nodes: [] });
      let firstPart = null;
      if (first) {
        const def = out.find((p) => p.type === 'default');
        firstPart = { type: 'first', nodes: this.hideFirst[kind] || !def ? [] : [...def.nodes] };
        if (withNum && !this.hideFirst.pageNum) firstPart.nodes.push(num);
      }
      if (withNum) for (const p of out) p.nodes.push(num);
      if (firstPart) out.push(firstPart);
      return out;
    };
    place(parts(this.headers, 'header'), 'header');
    place(parts(this.footers, 'footer'), 'footer');
  }

  /**
   * What goes on every page (headers, footers, the page background) counts once per page: its
   * elements, and its pictures, which are drawn again on every page (past the limit, left out).
   */
  addCopy(e) {
    if ((this.copies += e.getElementsByTagName('*').length + 1) > MAX_COPIES) throw tooLarge();
    for (const el of [e, ...e.querySelectorAll('img, [style*="background-image"]')]) {
      const url = el.tagName === 'IMG' ? el.getAttribute('src') || '' : el.style.backgroundImage;
      if (!url || (this.pictures += url.length) <= MAX_PLACED) continue;
      if (el.tagName === 'IMG') { el.parentNode.classList.add('hw-missing'); el.remove(); } else el.style.backgroundImage = '';
    }
    return e;
  }

  /** Text that goes on every page (headers, footers) counts once per page. */
  addText(n) {
    this.textCount += n;
    if (this.textCount > this.limits.maxText) throw tooLarge();
  }

  pageBreak() {
    this.finishPage();
    this.newPage();
    this.page.dataset.nvKeep = '1'; // (a page of its own even when nothing is on it, as in Hangul)
  }

  /** A page-number mark: convert.js puts each page's number there, in its format. */
  mark(format) {
    const span = this.el('span');
    span.textContent = pageMark(format);
    return span;
  }

  applyCols(article, cols) {
    if (cols.count > 1) {
      article.style.columnCount = String(cols.count);
      article.style.columnGap = cols.gap + 'px';
      if (cols.line) article.style.columnRule = cols.line;
    }
  }

  // ---------------------------------------------------------------- paragraphs
  async paragraph(p, into, inCell = false) {
    if (!inCell && on(p, 'pageBreak') && into === this.article && this.article.childNodes.length) this.pageBreak();
    if (!inCell && on(p, 'pageBreak')) into = this.article;
    const div = this.el('div', `hw-p pp${cssId(attr(p, 'paraPrIDRef', '0'))}`);
    if (on(p, 'columnBreak')) div.style.breakBefore = 'column';
    const pp = this.h.paraPrs.get(attr(p, 'paraPrIDRef', '0'));
    const head = this.heading(pp);
    const art0 = this.article;
    const blocks = []; // tables and objects that stand on their own (not inline)
    let hasText = false;
    let firstChar = null;
    if (head) {
      // (a number or bullet is copied into every paragraph that has it: kept short, and counted)
      const s = this.el('span');
      s.textContent = head.text + ' ';
      this.addText(s.textContent.length);
      div.append(s);
      hasText = true;
    }
    for (const run of kids(p, 'run')) {
      const cp = attr(run, 'charPrIDRef', '0');
      if (firstChar === null) firstChar = cp;
      for (const c of unswitch(run)) {
        const name = c.localName;
        if (name === 't') {
          const span = this.el('span', `cp${cssId(cp)}`);
          this.text(c, span);
          if (span.childNodes.length) { div.append(span); hasText = true; }
        } else if (name === 'ctrl') {
          await this.ctrl(c, div, cp, inCell);
        } else if (name === 'secPr') {
          // (read in section())
        } else if (name === 'dutmal') {
          // 덧말: the main text with the small one over (or under) it
          const ruby = this.el('ruby', `cp${cssId(cp)}`);
          ruby.append(this.doc.createTextNode(kid(c, 'mainText')?.textContent || ''));
          const rt = this.el('rt');
          rt.textContent = kid(c, 'subText')?.textContent || '';
          if (attr(c, 'posType', 'TOP') === 'BOTTOM') ruby.style.rubyPosition = 'under';
          ruby.append(rt);
          this.addText(ruby.textContent.length);
          div.append(ruby);
          hasText = true;
        } else {
          const obj = await this.object(c, cp);
          if (!obj) continue;
          if (obj.inline) { div.append(obj.node); hasText = true; }
          // (one on the page itself stays where it is anchored, in the line, until convert.js
          // moves it: no line of its own)
          else if (obj.node.dataset.nvFloat) div.append(obj.node);
          else blocks.push(obj);
          // (one set lower than its paragraph's start: after the paragraph's text)
          if (!obj.inline && obj.below) obj.after = true;
        }
      }
    }
    if (!hasText) {
      // an empty paragraph still takes a line of its font
      const span = this.el('span', `cp${cssId(firstChar || '0')}`);
      span.append(this.el('br'));
      div.append(span);
    }
    // Objects standing on their own come where their paragraph starts (behind/in-front ones
    // are taken out of the text by convert.js and put at their place on the page).
    // (the paragraph that changes the columns is the first one in them)
    if (into === art0 && this.article !== art0) into = this.article;
    const after = hasText && !head ? blocks.filter((o) => o.after) : [];
    for (const o of blocks) if (!after.includes(o)) into.append(o.node);
    if (!(blocks.length && !hasText && !head)) into.append(div);
    else {
      // (a paragraph holding only a table or object has no line of its own: what it marks for
      // convert.js — page hiding, a new page number, a header's start — goes on the object)
      for (const k of ['nvHide', 'nvPageNo', 'nvHfFrom']) if (div.dataset[k]) blocks[0].node.dataset[k] = div.dataset[k];
    }
    for (const o of after) {
      // its offset was from the paragraph's top: less the paragraph's (first) line
      const m = parseFloat(o.node.style.marginTop) || 0;
      o.node.style.marginTop = Math.max(0, m - lineHeight(this.h.charPrs.get(firstChar || '0'))).toFixed(1) + 'px';
      into.append(o.node);
    }
  }

  /** The number or bullet a paragraph starts with (개요, 번호, 글머리표). */
  heading(pp) {
    const hd = kid(pp, 'heading');
    const type = attr(hd, 'type', 'NONE');
    if (!hd || type === 'NONE') return null;
    const level = Math.max(0, Math.min(9, num(hd, 'level', 0)));
    if (type === 'BULLET') {
      const bl = this.h.bullets.get(attr(hd, 'idRef'));
      const ch = attr(bl, 'char', '•').slice(0, 4);
      return { text: !ch ? '•' : /[\uF000-\uF0FF]/.test(ch) ? SYMBOL_BULLETS[ch.charCodeAt(0) & 0xff] || '•' : ch };
    }
    const id = type === 'OUTLINE' ? this.outline || attr(hd, 'idRef') : attr(hd, 'idRef');
    const nb = this.h.numberings.get(id);
    if (!nb) return null;
    const heads = kids(nb, 'paraHead');
    const fmt = (lv) => heads.find((x) => num(x, 'level', 0) === lv + 1) || null;
    const ph = fmt(level);
    if (!ph) return null;
    let vals = this.counters.get(id);
    if (!vals) { vals = []; this.counters.set(id, vals); }
    for (let i = 0; i <= level; i++) if (vals[i] === undefined) vals[i] = num(fmt(i), 'start', 1) - (i === level ? 1 : 0);
    vals[level]++;
    vals.length = level + 1; // deeper levels start again
    const text = (ph.textContent || '').slice(0, 64).replace(/\^(\d)/g, (x, d) => {
      const lv = Number(d) - 1;
      return vals[lv] === undefined ? '' : formatNumber(vals[lv], attr(fmt(lv), 'numFormat', 'DIGIT'));
    });
    return { text };
  }

  /** The text of <hp:t>: characters, tabs, line breaks, special spaces, highlights. */
  text(t, span) {
    let into = span;
    for (const n of t.childNodes) {
      if (n.nodeType === 3) { into.append(this.doc.createTextNode(n.data)); continue; }
      if (n.nodeType !== 1) continue;
      switch (n.localName) {
        case 'tab': {
          const w = Math.max(4, Math.min(600, px(num(n, 'width', 4000))));
          into.append(this.el('span', 'hw-tab', `width:${w.toFixed(1)}px`));
          break;
        }
        case 'lineBreak': into.append(this.el('br')); break;
        case 'nbSpace': into.append(this.doc.createTextNode('\u00a0')); break;
        case 'fwSpace': into.append(this.doc.createTextNode('\u2002')); break; // (고정폭 빈칸: half an em)
        case 'hyphen': into.append(this.doc.createTextNode('-')); break;
        case 'markpenBegin': {
          const mark = this.el('span', '', `background-color:${color(attr(n, 'color'), '#ffff00')}`);
          span.append(mark);
          into = mark;
          break;
        }
        case 'markpenEnd': into = span; break;
        default:
          if (n.textContent) into.append(this.doc.createTextNode(n.textContent));
      }
    }
  }

  // ---------------------------------------------------------------- controls
  async ctrl(c, div, cp, inCell) {
    for (const x of unswitch(c)) {
      // (headers, footers and notes hold paragraphs: as deep as objects can go, and no deeper)
      const holds = /^(header|footer|footNote|endNote)$/.test(x.localName);
      if (holds && this.depth >= MAX_DEPTH) continue;
      if (holds) this.depth++;
      try { await this.ctrl1(x, div, cp, inCell); } finally { if (holds) this.depth--; }
    }
  }

  async ctrl1(x, div, cp, inCell) {
    {
      switch (x.localName) {
        case 'colPr': {
          const count = Math.max(1, Math.min(8, num(x, 'colCount', 1)));
          const line = kid(x, 'colLine');
          const cols = { count, gap: px(num(x, 'sameGap', 0)) || 24, line: line && attr(line, 'type', 'NONE') !== 'NONE' ? borderCss(line) : '' };
          if (inCell) break;
          const changed = (this.cols ? this.cols.count : 1) !== count;
          this.cols = cols;
          if (changed) {
            // the paragraph that changes the columns starts a new part of the page
            const art = this.el('article');
            this.applyCols(art, cols);
            this.article.after(art);
            this.article = art;
          }
          break;
        }
        case 'header':
        case 'footer': {
          const nodes = [];
          const subl = kid(x, 'subList');
          const tmp = this.el('div');
          for (const p of kids(subl, 'p')) await this.paragraph(p, tmp, true);
          nodes.push(...tmp.childNodes);
          const type = { BOTH: 'default', EVEN: 'even', ODD: 'default' }[attr(x, 'applyPageType', 'BOTH')] || 'default';
          const list = x.localName === 'header' ? this.headers : this.footers;
          // A header that starts after text on this page part shows from the page it is on (as
          // in Hangul), not on the pages before it: convert.js finds that page.
          if (!inCell && !list.length && [...this.page.querySelectorAll(':scope > article')].some((a) => a.childNodes.length)) {
            div.dataset.nvHfFrom = (div.dataset.nvHfFrom || '') + x.localName[0];
          }
          const at = list.findIndex((p) => p.type === type);
          if (at >= 0) list[at] = { type, nodes }; else list.push({ type, nodes });
          // only odd pages: even ones get an empty one
          if (attr(x, 'applyPageType') === 'ODD' && !list.some((p) => p.type === 'even')) list.push({ type: 'even', nodes: [] });
          break;
        }
        case 'pageHiding': {
          // (감추기: on the page this paragraph is on; convert.js finds the page)
          const what = (on(x, 'hideHeader') ? 'h' : '') + (on(x, 'hideFooter') ? 'f' : '') + (on(x, 'hidePageNum') ? 'n' : '')
            + (on(x, 'hideBorder') || on(x, 'hideFill') ? 'b' : '');
          // (also from a table cell: on the page the cell is on; text boxes, headers and notes are
          // taken out of the text, so convert.js doesn't see theirs)
          if (what) div.dataset.nvHide = what;
          break;
        }
        case 'pageNum':
          if (attr(x, 'pos', 'NONE') !== 'NONE') this.pageNum = { pos: attr(x, 'pos'), format: attr(x, 'formatType', 'DIGIT'), side: attr(x, 'sideChar', '').slice(0, 2) };
          break;
        case 'autoNum':
        case 'newNum':
          if (x.localName !== 'autoNum') {
            // 새 번호로 시작: the page numbers start again from here
            if (attr(x, 'numType', 'PAGE') === 'PAGE' && !inCell) div.dataset.nvPageNo = String(Math.max(1, Math.min(1e6, num(x, 'num', 1))));
          } else if (attr(x, 'numType') === 'PAGE') div.append(this.mark(attr(kid(x, 'autoNumFormat'), 'type', 'DIGIT')));
          else if (/^(FOOTNOTE|ENDNOTE)$/.test(attr(x, 'numType'))) {
            // (a note's own number: the note is labelled once, when it is put together)
          } else {
            // a picture's, table's or equation's number (in its caption)
            const s = this.el('span');
            s.textContent = formatNumber(Math.max(0, Math.min(1e6, num(x, 'num', 0))), attr(kid(x, 'autoNumFormat'), 'type', 'DIGIT'));
            div.append(s);
          }
          break;
        case 'footNote':
        case 'endNote': {
          const end = x.localName === 'endNote';
          const n = end ? ++this.endnoteNo : ++this.footnoteNo;
          const ref = this.el('span', `hw-noteref cp${cssId(cp)}`);
          ref.textContent = String(n);
          div.append(ref);
          const note = this.el('div');
          const tmp = this.el('div');
          for (const p of kids(kid(x, 'subList'), 'p')) await this.paragraph(p, tmp, true);
          const first = tmp.querySelector('.hw-p');
          const label = this.el('span');
          label.textContent = n + ') ';
          if (first) first.prepend(label); else note.append(label);
          note.append(...tmp.childNodes);
          (end ? this.endnoteList : this.notes).push(note);
          break;
        }
        default:
          break; // fields, bookmarks, hidden comments, page hiding: nothing to draw
      }
    }
  }

  endnotes() {
    if (!this.endnoteList.length || !this.pages.length) return;
    const last = this.pages[this.pages.length - 1];
    const box = this.el('div', 'hw-notes');
    box.append(...this.endnoteList);
    const art = [...last.children].filter((c) => c.tagName === 'ARTICLE' || c.className === 'hw-notes').pop();
    (art || last).after(box);
  }

  // ---------------------------------------------------------------- objects
  /** Size, place and wrapping of a table, picture or drawing. */
  frame(o) {
    const sz = kid(o, 'sz');
    const pos = kid(o, 'pos');
    const out = kid(o, 'outMargin');
    // in a group, the size is the drawn one (curSz), or the original one scaled
    let w = num(sz, 'width', 0);
    let h = num(sz, 'height', 0);
    if (!w || !h) {
      // the drawn size, else the original one times all its scalings (the group's and its own)
      const cur = kid(o, 'curSz');
      const org = kid(o, 'orgSz');
      const scas = [...(kid(o, 'renderingInfo') || o).children].filter((c) => c.localName === 'scaMatrix');
      const scale = (k) => scas.reduce((a, m) => a * (Math.abs(num(m, k, 1)) || 1), 1);
      if (!w) w = num(cur, 'width', 0) || num(org, 'width', 0) * scale('e1');
      if (!h) h = num(cur, 'height', 0) || num(org, 'height', 0) * scale('e5');
    }
    return {
      w: Math.max(1, Math.min(4000, px(w))),
      h: Math.max(1, Math.min(6000, px(h))),
      inline: !pos || on(pos, 'treatAsChar'),
      wrap: attr(o, 'textWrap', 'TOP_AND_BOTTOM'),
      pos,
      margin: [px(num(out, 'top', 0)), px(num(out, 'right', 0)), px(num(out, 'bottom', 0)), px(num(out, 'left', 0))],
    };
  }

  /** An object: {node, inline}. Floating objects get their place on the page as data-nv-* attributes. */
  async object(o, cp) {
    const name = o.localName;
    if (++this.objects > MAX_OBJECTS) throw tooLarge();
    // tables in tables, text boxes in text boxes…: deeper than Hangul documents go, a grey box
    if (this.depth >= MAX_DEPTH) {
      const f = this.frame(o);
      const box = this.el('div', 'hw-missing hw-obj', `width:${f.w}px;height:${Math.min(f.h, 400)}px`);
      return { node: box, inline: true };
    }
    this.depth++;
    try { return await this.object1(o, cp, name); } finally { this.depth--; }
  }

  async object1(o, cp, name) {
    let node = null;
    if (name === 'tbl') node = await this.table(o);
    else if (name === 'pic') node = await this.pic(o);
    else if (['rect', 'ellipse', 'line', 'polygon', 'curve', 'arc', 'connectLine'].includes(name)) node = await this.shape(o);
    else if (name === 'container') node = await this.container(o);
    else if (name === 'equation') {
      const s = this.el('span', `hw-eq cp${cssId(cp)}`);
      equation(s, (kid(o, 'script') || o).textContent.slice(0, 2000), this);
      return { node: s, inline: true };
    } else if (name === 'textart') {
      const s = this.el('span', `cp${cssId(cp)}`);
      s.textContent = attr(o, 'text', '').slice(0, 500);
      return { node: s, inline: true };
    } else if (['ole', 'video', 'chart', 'btn', 'radioBtn', 'checkBtn', 'comboBox', 'listBox', 'edit', 'scrollBar'].includes(name)) {
      node = this.el('div', 'hw-missing');
      const cap = attr(o, 'caption', '');
      if (cap) node.textContent = cap.slice(0, 200);
    } else return null;
    if (!node) return null;
    const f = this.frame(o);
    if (name !== 'tbl') { node.style.width = f.w + 'px'; node.style.height = f.h + 'px'; }
    node = await this.caption(o, node, f);
    node.classList.add('hw-obj');
    if (f.inline) return { node, inline: true };
    this.place(node, f);
    const pos = f.pos;
    return { node, inline: false, below: attr(pos, 'vertRelTo', 'PARA') === 'PARA' && sint(pos, 'vertOffset', 0) > 0 && attr(pos, 'vertAlign', 'TOP') === 'TOP' };
  }

  /** An object with its caption (캡션: "그림 1"…), over, under or beside it. */
  async caption(o, node, f) {
    const c = kid(o, 'caption');
    if (!c) return node;
    const side = attr(c, 'side', 'BOTTOM');
    const gap = Math.max(0, Math.min(200, px(num(c, 'gap', 850))));
    const box = this.el('div');
    await this.subList(kid(c, 'subList'), box);
    if (node.tagName === 'TABLE' && (side === 'TOP' || side === 'BOTTOM')) {
      // (a table's own caption: the table still splits across pages)
      const cap = this.el('caption', '', `caption-side:${side === 'TOP' ? 'top' : 'bottom'};padding:${side === 'TOP' ? `0 0 ${gap}px` : `${gap}px 0 0`}`);
      cap.append(...box.childNodes);
      node.prepend(cap);
      return node;
    }
    const wrap = this.el('div', '', `width:${f.w}px`);
    node.style.display = node.tagName === 'TABLE' ? 'table' : 'block';
    if (side === 'LEFT' || side === 'RIGHT') {
      const w = Math.max(10, Math.min(2000, px(num(c, 'width', 8504))));
      wrap.style.cssText = `display:inline-flex;align-items:flex-start;gap:${gap}px;width:${f.w + gap + w}px`;
      box.style.width = w + 'px';
      box.style.flex = 'none';
      node.style.flex = 'none';
      if (side === 'LEFT') wrap.append(box, node); else wrap.append(node, box);
      f.w += gap + w;
    } else {
      box.style[side === 'TOP' ? 'paddingBottom' : 'paddingTop'] = gap + 'px';
      if (side === 'TOP') wrap.append(box, node); else wrap.append(node, box);
    }
    return wrap;
  }

  /** Where a floating object goes. Text-wrapped ones stay in the text where their paragraph is. */
  place(node, f) {
    const pos = f.pos;
    const g = this.geo;
    const horzRel = attr(pos, 'horzRelTo', 'COLUMN');
    const vertRel = attr(pos, 'vertRelTo', 'PARA');
    const hAlign = attr(pos, 'horzAlign', 'LEFT');
    const vAlign = attr(pos, 'vertAlign', 'TOP');
    const hOff = clampPx(sint(pos, 'horzOffset', 0));
    const vOff = clampPx(sint(pos, 'vertOffset', 0));
    // (past the limit, in the text: each one is placed on its page separately)
    const behind = (f.wrap === 'BEHIND_TEXT' || f.wrap === 'IN_FRONT_OF_TEXT') && ++this.floats <= MAX_FLOATS;
    // the box it is placed in (paper, page = text area, column/paragraph ≈ text area)
    const area = (rel, along) => {
      if (rel === 'PAPER') return along === 'x' ? [0, g.w] : [0, g.h];
      return along === 'x' ? [g.left, g.w - g.right] : [g.top + g.header, g.h - g.bottom - g.footer];
    };
    const at = ([a, b], size, align, off) => (align === 'CENTER' ? (a + b - size) / 2 + off : align === 'RIGHT' || align === 'BOTTOM' || align === 'OUTSIDE' ? b - size - off : a + off);
    if (behind) {
      // Behind or in front of the text: it takes no room. convert.js takes it out of the text and
      // puts it at its place on the page where its paragraph is (relative to that paragraph, or
      // to the page or paper).
      node.classList.add('hw-float');
      if (f.wrap === 'BEHIND_TEXT') node.classList.add('behind');
      node.dataset.nvFloat = '1';
      node.dataset.nvX = String(horzRel === 'PARA' || horzRel === 'COLUMN' ? g.left + hOff : at(area(horzRel, 'x'), f.w, hAlign, hOff));
      if (vertRel === 'PARA') node.dataset.nvYPara = String(vOff);
      else node.dataset.nvY = String(at(area(vertRel, 'y'), f.h, vAlign, vOff));
      return;
    }
    // in the text: a block of its own, across from the left of the text area
    node.classList.add('hw-block');
    const [a, b] = horzRel === 'PAPER' ? [-g.left, g.w - g.left] : [0, g.w - g.left - g.right];
    const x = Math.max(-g.left, Math.min(g.w - g.left - f.w, at([a, b], f.w, hAlign, hOff)));
    node.style.marginLeft = x.toFixed(1) + 'px';
    node.style.marginTop = (vertRel === 'PARA' ? Math.max(0, vOff) + f.margin[0] : f.margin[0]).toFixed(1) + 'px';
    node.style.marginBottom = f.margin[2].toFixed(1) + 'px';
  }

  async subList(list, into) {
    for (const p of kids(list, 'p')) await this.paragraph(p, into, true);
  }

  async table(t) {
    const rows = kids(t, 'tr');
    if (!rows.length) return null;
    // (a table splits across pages at its rows, unless it says it doesn't)
    const table = this.el('table', attr(t, 'pageBreak', 'CELL') === 'NONE' ? 'hw-tbl hw-nobreak' : 'hw-tbl');
    const f = this.frame(t);
    table.style.width = f.w + 'px';
    const tblBf = this.h.borderFills.get(attr(t, 'borderFillIDRef'));
    const inM = kid(t, 'inMargin');
    // column widths from the cells that span one column
    // (as many columns as the cells use: a table may say fewer)
    let used = num(t, 'colCnt', 1);
    for (const tr of rows) {
      for (const tc of kids(tr, 'tc')) used = Math.max(used, num(kid(tc, 'cellAddr'), 'colAddr', 0) + Math.max(1, num(kid(tc, 'cellSpan'), 'colSpan', 1)));
    }
    const colCnt = Math.max(1, Math.min(200, used));
    const widths = new Array(colCnt).fill(0);
    for (const tr of rows) {
      for (const tc of kids(tr, 'tc')) {
        const a = kid(tc, 'cellAddr');
        const sp = kid(tc, 'cellSpan');
        const col = num(a, 'colAddr', 0);
        if (num(sp, 'colSpan', 1) === 1 && col < colCnt) widths[col] = Math.max(widths[col], px(num(kid(tc, 'cellSz'), 'width', 0)));
      }
    }
    const known = widths.filter((x) => x > 0);
    const rest = Math.max(0, f.w - known.reduce((a, b) => a + b, 0));
    const missing = widths.filter((x) => !x).length;
    const cg = this.el('colgroup');
    for (const w0 of widths) {
      const c = this.el('col');
      c.style.width = (w0 || (missing ? rest / missing : 0) || 20).toFixed(2) + 'px';
      cg.append(c);
    }
    table.append(cg);
    // Cells go into the table's grid of colCnt columns: each where it says (or next), never over
    // a cell from a row above, as wide as there is room for and no taller than the rows left; a
    // cell with no room left in its row is left out (only a damaged table has one).
    const busy = new Array(colCnt).fill(0); // the row each column is taken until
    for (let ri = 0; ri < rows.length; ri++) {
      const tr = rows[ri];
      const row = this.el('tr');
      let next = 0;
      for (const tc of kids(tr, 'tc')) {
        if (++this.cells > MAX_CELLS) throw tooLarge();
        const sp = kid(tc, 'cellSpan');
        let col = Math.max(next, Math.min(colCnt, num(kid(tc, 'cellAddr'), 'colAddr', 0)));
        while (col < colCnt && busy[col] > ri) col++;
        if (col >= colCnt) continue;
        let cs = 1;
        const want = Math.max(1, num(sp, 'colSpan', 1));
        while (cs < want && col + cs < colCnt && busy[col + cs] <= ri) cs++;
        const rs = Math.max(1, Math.min(rows.length - ri, num(sp, 'rowSpan', 1)));
        for (let c = col; c < col + cs; c++) busy[c] = ri + rs;
        next = col + cs;
        const td = this.el('td');
        if (cs > 1) td.colSpan = cs;
        if (rs > 1) td.rowSpan = rs;
        const sz = kid(tc, 'cellSz');
        const m = on(tc, 'hasMargin') ? kid(tc, 'cellMargin') : inM || kid(tc, 'cellMargin');
        const bf = this.h.borderFills.get(attr(tc, 'borderFillIDRef')) || tblBf;
        const list = kid(tc, 'subList');
        const va = { CENTER: 'middle', BOTTOM: 'bottom' }[attr(list, 'vertAlign', 'TOP')] || 'top';
        td.style.cssText = `${borderFillCss(bf)};height:${px(num(sz, 'height', 0)).toFixed(2)}px;vertical-align:${va};`
          + `padding:${px(num(m, 'top', 141)).toFixed(2)}px ${px(num(m, 'right', 510)).toFixed(2)}px ${px(num(m, 'bottom', 141)).toFixed(2)}px ${px(num(m, 'left', 510)).toFixed(2)}px`;
        const bg = await this.imgFill(bf);
        if (bg) { td.style.backgroundImage = `url("${bg}")`; td.style.backgroundSize = '100% 100%'; }
        if (attr(list, 'textDirection', 'HORIZONTAL') === 'VERTICAL') {
          // (세로쓰기: the cell's text set top to bottom, in the middle of the cell)
          const v = this.el('div', 'hw-vert');
          await this.subList(list, v);
          td.style.textAlign = 'center';
          td.append(v);
        } else await this.subList(list, td);
        row.append(td);
      }
      table.append(row);
    }
    return table;
  }

  async pic(o) {
    const img = o.getElementsByTagNameNS('*', 'img')[0];
    const ref = attr(img, 'binaryItemIDRef');
    const url = ref ? await this.usePicture(ref) : null;
    const box = this.el('div', url ? '' : 'hw-missing');
    // (the picture's inner margins: white around it inside its frame)
    const im = kid(o, 'inMargin');
    if (im) box.style.padding = ['top', 'right', 'bottom', 'left'].map((k) => `${Math.max(0, Math.min(200, px(num(im, k, 0)))).toFixed(2)}px`).join(' ');
    if (url) {
      const i = this.el('img', 'hw-img');
      i.alt = '';
      i.src = url;
      box.append(i);
    }
    const bf = this.h.borderFills.get(attr(o, 'borderFillIDRef'));
    const line = kid(o, 'lineShape');
    if (line && attr(line, 'style', 'NONE') !== 'NONE' && num(line, 'width', 0) > 0) box.style.border = `${Math.max(0.5, px(num(line, 'width', 0))).toFixed(2)}px solid ${color(attr(line, 'color'), '#000000')}`;
    else if (bf) box.style.cssText += borderFillCss(bf);
    return box;
  }

  /** A drawing (rectangle, ellipse, line…) as SVG, and its text box (글상자) over it. */
  async shape(o) {
    const name = o.localName;
    const f = this.frame(o);
    const box = this.el('div');
    const line = kid(o, 'lineShape');
    const stroke = line && attr(line, 'style', 'SOLID') !== 'NONE' ? color(attr(line, 'color'), '#000000') : 'none';
    const sw = Math.max(0.6, Math.min(20, px(num(line, 'width', 33)))); // (Hangul draws thin lines a pixel wide)
    const fill = kid(o, 'fillBrush');
    const face = color(attr(kid(fill, 'winBrush'), 'faceColor'), '');
    const grad = kids(kid(fill, 'gradation'), 'color').map((c) => color(attr(c, 'value'))).filter(Boolean);
    const fillColor = face || grad[0] || 'none';
    const svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(f.w));
    svg.setAttribute('height', String(f.h));
    svg.setAttribute('viewBox', `0 0 ${f.w} ${f.h}`);
    svg.setAttribute('style', 'position:absolute;left:0;top:0;overflow:visible');
    const mk = (tag, attrs) => {
      const e = this.doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      e.setAttribute('stroke', stroke);
      e.setAttribute('stroke-width', String(sw));
      e.setAttribute('fill', name === 'line' ? 'none' : fillColor);
      svg.append(e);
      return e;
    };
    const org = kid(o, 'orgSz');
    const sx = f.w / Math.max(1, px(num(org, 'width', 0)) || f.w);
    const sy = f.h / Math.max(1, px(num(org, 'height', 0)) || f.h);
    const pt = (e) => [clampPx(sint(e, 'x', 0)) * sx, clampPx(sint(e, 'y', 0)) * sy];
    if (name === 'rect') {
      const r = Math.min(f.w, f.h) * (num(o, 'ratio', 0) / 100) / 2;
      mk('rect', { x: sw / 2, y: sw / 2, width: Math.max(0, f.w - sw), height: Math.max(0, f.h - sw), rx: r, ry: r });
    } else if (name === 'ellipse' || name === 'arc') {
      mk('ellipse', { cx: f.w / 2, cy: f.h / 2, rx: Math.max(0, f.w / 2 - sw / 2), ry: Math.max(0, f.h / 2 - sw / 2) });
    } else if (name === 'line' || name === 'connectLine') {
      const [x1, y1] = pt(kid(o, 'startPt'));
      const [x2, y2] = pt(kid(o, 'endPt'));
      mk('line', { x1, y1, x2, y2 });
    } else if (name === 'polygon' || name === 'curve') {
      const pts = kids(o, 'pt').map(pt).slice(0, 2000);
      if (name === 'curve') { const segs = kids(o, 'seg').slice(0, 2000); if (segs.length) pts.push(...segs.map((s) => [px(num(s, 'x1', 0)) * sx, px(num(s, 'y1', 0)) * sy])); }
      pts.length = Math.min(pts.length, 2000);
      if (pts.length >= 2) mk(name === 'polygon' ? 'polygon' : 'polyline', { points: pts.map((p) => p.join(',')).join(' ') });
    }
    box.append(svg);
    const dt = kid(o, 'drawText');
    if (dt) {
      const tm = kid(dt, 'textMargin');
      const list = kid(dt, 'subList');
      const va = { CENTER: 'center', BOTTOM: 'flex-end' }[attr(list, 'vertAlign', 'TOP')] || 'flex-start';
      const inner = this.el('div', '', `position:absolute;inset:0;display:flex;flex-direction:column;justify-content:${va};`
        + `padding:${px(num(tm, 'top', 283))}px ${px(num(tm, 'right', 283))}px ${px(num(tm, 'bottom', 283))}px ${px(num(tm, 'left', 283))}px;overflow:hidden`);
      inner.dataset.nvClip = '1'; // (text that doesn't fit isn't shown, nor searched)
      const flow = this.el('div');
      await this.subList(list, flow);
      inner.append(flow);
      box.append(inner);
    }
    return box;
  }

  /** Grouped drawings: each at its place inside the group. */
  async container(o) {
    if (this.depth >= MAX_DEPTH) return this.el('div', 'hw-missing');
    this.depth++;
    try { return await this.container1(o); } finally { this.depth--; }
  }

  async container1(o) {
    const f = this.frame(o);
    const box = this.el('div');
    let n = 0;
    for (const c of o.children) {
      if (++n > 500) break;
      const name = c.localName;
      if (!['rect', 'ellipse', 'line', 'polygon', 'curve', 'arc', 'pic', 'container', 'connectLine'].includes(name)) continue;
      const node = name === 'pic' ? await this.pic(c) : name === 'container' ? await this.container(c) : await this.shape(c);
      if (!node) continue;
      const cf = this.frame(c);
      const off = kid(c, 'offset');
      node.classList.add('hw-obj');
      const rot = num(kid(c, 'rotationInfo'), 'angle', 0) % 360;
      node.style.cssText += `;position:absolute;left:${clampPx(sint(off, 'x', 0)).toFixed(1)}px;top:${clampPx(sint(off, 'y', 0)).toFixed(1)}px;width:${cf.w}px;height:${cf.h}px`
        + (rot ? `;transform:rotate(${rot}deg)` : '');
      box.append(node);
    }
    box.style.overflow = 'hidden'; // (a group's parts stay inside it)
    box.dataset.nvClip = '1';
    void f;
    return box;
  }
}
