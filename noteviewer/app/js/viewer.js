// Notebook-style reader: continuous vertical pages (or one page at a time, side by side) on a
// grey canvas, two pages side by side on wide screens, pinch/double-tap zoom, dark pages,
// page thumbnails / bookmarks / outline sheet, in-document search (with handwriting on Android),
// working PDF links.

import { openPdf, renderToCanvas, extractText } from './pdf.js';
import { docState, updateDocState, kv, settings, saveSettings, idb, cache } from './store.js';
import { $, $$, esc, scrollBehavior, toast, dialog, actionSheet, mountOverlay, fmtDate, fmtSize } from './ui.js';
import { icon, hydrateIcons } from './icons.js';
import { extractPdf, inkIntoWholePdf, pageToPng, makeZip, saveFile, safeFileName } from './export.js';
import { t, joinList, listSep } from './i18n.js';
import { ocrSupported, ocrOn, loadOcr, indexDoc, doneCount, findAll, boxFor } from './ocr.js';
import { detectToc } from './toc.js';
import { fingerprint, changedPages, followPages, FP_TAG } from './pagediff.js';
import { loadInk, saveInk, journalInk, nextToken, inkGeneration, SAVED as INK_SAVED, hasInk, MAX_POINTS, pathD, strokeHits, strokeWidth, drawInk, PEN_COLORS, HL_COLORS } from './ink.js';

const PAD = 10; // side/top padding at zoom 1 (CSS px)
const GAP = 14; // gap between pages at zoom 1
const MAX_PAGE_W = 920; // pages never get wider than this at zoom 1 (tablets / desktop)
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const QUICK_OPEN = 60; // pages: longer documents show before every page size is known
const MAX_CANVAS_PX = 12e6; // pixel budget per page canvas (memory safety on phones)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const PEN_NAMES = { k: 'colorBlack', b: 'colorBlue', r: 'colorRed', g: 'colorGreen' };
const HL_NAMES = { y: 'colorYellow', g: 'colorGreen', p: 'colorPink', b: 'colorBlue' };

export class Viewer {
  constructor(root, { onBack, onMenu, onAddPreview }) {
    this.root = root;
    this.onBack = onBack;
    this.onMenu = onMenu;
    this.onAddPreview = onAddPreview;
    this.previewBar = $('.vpreview', root);
    // (its height, for the toast to keep clear of it)
    if (this.previewBar && window.ResizeObserver) {
      new ResizeObserver(() => document.documentElement.style.setProperty('--vpreview-h', this.previewBar.offsetHeight + 'px')).observe(this.previewBar);
    }
    this.scroller = $('.scroller', root);
    this.sizer = $('.sizer', root);
    this.pagesEl = $('.pages', root);
    this.pill = $('.pagepill', root);
    this.scrub = $('.scrub input', root);
    this.scrubLabel = $('.scrub-label', root);
    this.bubble = $('.scrub-bubble', root);
    this.subtitle = $('.vtitle-sub', root);
    this.loading = $('.vloading', root);
    this.sheet = $('.thumbsheet', root);
    this.searchBar = $('.vsearch', root);
    this.searchInput = $('.vsearch input', root);
    this.searchResults = $('.vsearch-results', root);
    this.zoom = 1;
    this.gen = 0;
    this.pages = [];
    this.per = 1; // pages per row (2 when shown side by side)
    this.picking = false; // page list: choosing pages to export
    this.picked = new Set();
    this.inkBar = $('.inkbar', root);
    this.inking = false; // handwriting tools out
    this.inkPages = null; // {page number: {v, s: [strokes]}} of the open note (see ink.js)
    this.inkUndo = [];
    this.inkRedo = [];
    this.bindEvents();
  }

  // ------------------------------------------------------------------ lifecycle
  showLoading(text, progress) {
    this.loading.hidden = false;
    // An earlier "can't open this note" card replaced the contents: put the loading view back.
    if (!$('.vloading-text', this.loading)) {
      this.loading.innerHTML = '<div class="spinner"></div><div class="vloading-text" role="status" aria-live="polite"></div><div class="progress"><i></i></div>';
    }
    $('.vloading-text', this.loading).textContent = text || t('loading');
    const bar = $('.progress', this.loading);
    bar.hidden = progress == null;
    if (progress != null) $('i', bar).style.width = Math.round(progress * 100) + '%';
  }

  prepare(meta) {
    this.close();
    this.meta = meta;
    this.root.hidden = false;
    document.body.classList.add('in-viewer');
    this.cover(true);
    $('.vtitle-text', this.root).textContent = meta.name;
    this.subtitle.textContent = '';
    // A file opened from another app, not in the library yet: offer to add it.
    this.root.classList.toggle('previewing', !!meta.preview);
    if (this.previewBar) {
      this.previewBar.hidden = !meta.preview;
      this.setPreviewReady(false); // (adding waits until the file has opened)
      const say = $('.vpreview-text', this.previewBar);
      if (meta.preview && say) { // (said again after the loading messages, so screen readers hear it)
        say.textContent = '';
        setTimeout(() => { if (this.meta === meta) say.textContent = t('previewNote'); }, 400);
      }
    }
    this.applyPageColor();
    this.updateBookmarkButton();
    this.showLoading(t('loading'));
  }

  async open(meta, blob, { page } = {}) {
    if (!this.meta || this.meta.id !== meta.id) this.prepare(meta);
    else if (this.doc) this.dropDocument(); // same note, newer version: free the old one first
    this.meta = meta;
    const gen = ++this.gen;
    this.showLoading(t('preparingPages'));
    const doc = await openPdf(blob);
    if (gen !== this.gen) { doc.destroy(); return; }
    this.doc = doc;
    this.relayoutPending = false;
    this.docId = meta.id;
    this.blob = blob;
    this.texts = null;
    const sizeOf = (i) => doc.getPage(i + 1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      return { w: v.width, h: v.height };
    });
    // A long document opens at once with the first page's size for every page (notes rarely
    // change size); the real sizes are read afterwards and the pages adjusted if they differ.
    const quick = doc.numPages > QUICK_OPEN;
    const want = clamp((page || docState(meta.id).lastPage || 1) - 1, 0, doc.numPages - 1);
    let sizes;
    if (quick) {
      const [first, at] = await Promise.all([sizeOf(0), sizeOf(want)]);
      sizes = Array.from({ length: doc.numPages }, () => first);
      sizes[want] = at;
    } else {
      sizes = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => sizeOf(i)));
    }
    if (gen !== this.gen) return;
    this.pages = sizes.map((s, i) => ({ i, ...s, el: null, canvas: null, scale: 0, links: false }));
    this.maxRatio = Math.min(4, Math.max(...sizes.map((s) => s.h / s.w)));
    this.buildPages();
    if (meta.preview) { // (nothing kept for a preview: no writing, nothing to save)
      this.inkPages = null;
      this.inkLost = [];
      this.inkLoading = null;
      this.inkRev = this.inkSavedRev = 0;
      this.inkUndo = [];
      this.inkRedo = [];
    }
    else this.inkLoading = this.loadInkFor(meta, gen);
    this.zoom = 1;
    this.layout();
    this.loading.hidden = true;
    if (!kv.get('tapHintShown', false)) {
      kv.set('tapHintShown', true);
      toast(t('tapHint'));
    }
    const st = docState(meta.id);
    const start = clamp((page || st.lastPage || 1) - 1, 0, this.pages.length - 1);
    this.goToPage(start, { instant: true });
    this.current = -1;
    this.update();
    this.updateScrub();
    if (quick) this.measurePages(doc, gen, sizeOf);
    if (meta.preview) return 0; // a file opened from another app: nothing about it is stored
    this.loadChanged(meta);
    this.diffPages(meta, gen);
    // A newer version with more pages than last time: offer to jump to the new ones.
    const added = st.pages && st.seenModified && meta.modifiedTime && st.seenModified !== meta.modifiedTime
      ? doc.numPages - st.pages : 0;
    updateDocState(meta.id, { lastOpened: Date.now(), seenModified: meta.modifiedTime, pages: doc.numPages });
    // New pages are told now; changed ones may follow (diffPages) and then say both together.
    this.added = added > 0 ? { gen, from: st.pages + 1, n: added } : null;
    if (added > 0) {
      const from = st.pages + 1;
      toast(t('newPages', { n: added, range: added > 1 ? `${from}–${doc.numPages}` : String(from) }), {
        action: t('newPagesGo'),
        onAction: () => { if (gen === this.gen) this.goToPage(from - 1); },
        duration: 8000,
      });
    }
    return added;
  }

  /** The real size of every page of a long document, a few at a time after it opened. */
  async measurePages(doc, gen, sizeOf) {
    let changed = false;
    for (let i = 0; i < doc.numPages; i += 25) {
      let batch;
      try {
        batch = await Promise.all(Array.from({ length: Math.min(25, doc.numPages - i) }, (_, k) => sizeOf(i + k)));
      } catch { break; } // a broken page keeps the assumed size
      if (gen !== this.gen) return;
      batch.forEach((sz, k) => {
        const p = this.pages[i + k];
        if (Math.abs(p.w - sz.w) > 0.5 || Math.abs(p.h - sz.h) > 0.5) { p.w = sz.w; p.h = sz.h; changed = true; if (this.inkOn(p.i + 1)) this.renderInk(p.i); }
      });
    }
    if (!changed || gen !== this.gen) return;
    this.maxRatio = Math.min(4, Math.max(...this.pages.map((p) => p.h / p.w)));
    // Zoomed in or pinching: don't pull the page away; lay out again once back at full view.
    if (this.zoom > 1.001 || this.pinch) { this.relayoutPending = true; return; }
    if (this.single) { this.relayoutAt(Math.max(0, this.current)); return; }
    // Keep the spot being read where it is on screen (not the top of its page).
    const h = this.scroller.clientHeight;
    const y = this.scroller.scrollTop + h / 2;
    // (the left page of a two-page row: if the layout goes to one page per row, that's the one shown)
    const i = this.per === 2 ? this.rowStart(this.pageAt(y)) : this.pageAt(y);
    const frac = this.pages[i] ? (y - this.tops[i]) / Math.max(1, this.pages[i].height) : 0;
    this.layout();
    if (this.pages[i]) this.scroller.scrollTop = this.tops[i] + frac * this.pages[i].height - h / 2;
    this.update();
  }

  /** Replace the document with a newer version, keeping the reading position. */
  async reload(meta, blob) {
    const page = this.current + 1;
    const scrollFrac = this.scroller.scrollTop / Math.max(1, this.sizer.offsetHeight);
    const added = await this.open(meta, blob, { page });
    this.scroller.scrollTop = scrollFrac * this.sizer.offsetHeight;
    return added;
  }

  /** The previewed file has opened: it can be added. */
  setPreviewReady(on) {
    const b = this.previewBar && $('.vpreview-add', this.previewBar);
    if (b) b.disabled = !on;
  }

  close() {
    this.setInking(false);
    this.root.classList.remove('previewing');
    if (this.previewBar) this.previewBar.hidden = true;
    this.gen++;
    if (this.barsHidden) this.setBarsHidden(false);
    this.closeSearch();
    if (this.doc) this.saveState();
    this.dropDocument();
    this.blob = null;
    this.meta = null;
    this.root.hidden = true;
    this.cover(false);
    document.body.classList.remove('in-viewer');
  }

  /** Release the PDF, its page canvases, thumbnails and reading position. */
  dropDocument() {
    clearTimeout(this.saveTimer);
    this.cancelStroke();
    // (the same note's newer version reads it back after this save; a copy is kept at once in case
    // the page goes away before the save finishes)
    this.flushInk({ now: true });
    this.closeSheet();
    for (const p of this.pages) this.releasePage(p);
    this.pages = [];
    this.pagesEl.innerHTML = '';
    if (this.doc) this.doc.destroy();
    this.doc = null;
    this.docId = null;
    this.texts = null;
    this.ocr = null;
    this.autoToc = null;
    this.autoTocJob = null;
    this.ocrLoaded = false;
    this.ocrRunning = false;
    this.ocrWaiting = false;
    this.hlEl = null;
    this.thumbCache = null;
    this.changed = null;
    this.inkPages = null;
    this.inkLost = [];
    this.inkUndo = [];
    this.inkRedo = [];
    this.current = -1;
  }

  get isOpen() { return !this.root.hidden; }

  /** The library and the tab bar under an open note: out of reach for Tab and screen readers. */
  cover(on) {
    for (const id of ['main', 'tabbar']) { const el = document.getElementById(id); if (el) el.inert = on; }
  }

  /** Close in-viewer panels (for the Android back button). Returns true when something closed. */
  handleBack() {
    if (!this.sheet.hidden && this.picking) { this.setPicking(false); return true; }
    if (!this.sheet.hidden) { this.closeSheet(); return true; }
    if (!this.searchBar.hidden) { this.closeSearch(); return true; }
    if (this.inking) { this.setInking(false); return true; }
    return false;
  }

  // ------------------------------------------------------------------ tap to hide the menu bar
  /**
   * Reading starts with the menu bar visible; a single tap hides it together with the phone's
   * status/navigation bars (full screen), and another tap brings everything back.
   */
  setBarsHidden(hidden) {
    if (!!this.barsHidden === !!hidden) return;
    if (hidden && this.inking) return; // the writing tools stay at hand
    this.barsHidden = hidden;
    this.root.classList.toggle('bars-hidden', hidden);
    document.body.classList.toggle('reading-full', hidden); // the tab strip hides too
    if (window.GNVNative && window.GNVNative.setFullscreen) {
      window.GNVNative.setFullscreen(hidden);
    } else if (hidden && document.fullscreenEnabled && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (!hidden && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  onSingleTap() {
    if (!this.doc || !this.searchBar.hidden) return;
    this.setBarsHidden(!this.barsHidden);
  }

  saveState() {
    // Only for the document actually on screen (not while a different note is still loading).
    if (this.meta && this.meta.preview) return;
    if (this.meta && this.doc && this.docId === this.meta.id && this.current >= 0) {
      updateDocState(this.meta.id, { lastPage: this.current + 1 });
    }
  }

  // ------------------------------------------------------------------ layout
  buildPages() {
    const frag = document.createDocumentFragment();
    for (const p of this.pages) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.i = p.i;
      p.el = el;
      frag.appendChild(el);
    }
    this.pagesEl.innerHTML = '';
    this.pagesEl.appendChild(frag);
  }

  baseWidth() {
    const W = this.scroller.clientWidth;
    return Math.min(W - 2 * PAD, MAX_PAGE_W);
  }

  // ------------------------------------------------------------------ view options
  get single() { return settings.readMode === 'single'; }

  /** Landscape + "fit to height": the whole page fits on screen while scrolling. */
  fitsHeight() {
    return !this.single && settings.fitHeightLandscape && window.innerWidth > window.innerHeight;
  }

  /**
   * Two pages side by side: on "auto" for portrait pages when the screen is wide and tall enough
   * (tablets, an unfolded foldable held sideways; not a phone on its side), on "on" whenever it is
   * at least 480 px wide.
   */
  spreadOn() {
    const mode = settings.spread || 'auto';
    if (mode === 'off' || this.pages.length < 2) return false;
    // The keyboard (in-note search) shrinks the screen: keep the current layout meanwhile.
    const typing = document.activeElement && document.activeElement.matches('input, textarea');
    if (typing && this.layoutMode) return this.per === 2;
    const W = this.scroller.clientWidth || window.innerWidth;
    const H = this.steadyHeight() || window.innerHeight;
    if (mode === 'on') return W >= 480;
    // Landscape pages (planners, slides) read better one at a time across the screen.
    const first = this.pages.slice(0, 10);
    const wide = first.filter((p) => p.w > p.h * 1.05).length;
    if (wide * 2 > first.length) return false;
    return W >= 600 && H >= 420 && W / H >= 1.15;
  }

  /**
   * The height of the pages' area with the bars shown, also while they are hidden: a tap that hides
   * them must not switch between one and two pages, or change the size of a page being zoomed.
   */
  steadyHeight() {
    const W = this.scroller.clientWidth;
    if (!this.root.classList.contains('bars-hidden')) {
      this.shownH = this.scroller.clientHeight;
      this.shownW = W;
      return this.shownH;
    }
    return this.shownW === W && this.shownH ? this.shownH : this.scroller.clientHeight;
  }

  /** What the page layout depends on; a change means laying the pages out again. */
  modeKey() {
    return (this.single ? 'single' : 'scroll') + (this.fitsHeight() ? ':h' : '') + (this.spreadOn() ? ':2' : '');
  }

  /** First page of the row (or one-page slot) that page i sits in. */
  rowStart(i) {
    return i - (i % this.per);
  }

  setSpread(on) {
    const i = Math.max(0, this.current);
    saveSettings({ spread: on ? 'on' : 'off' });
    this.relayoutAt(i);
  }

  /** Dark pages (colours inverted) when switched on, or on "auto" with the dark app theme. */
  pageDark() {
    const m = settings.pageDark;
    if (m === 'on') return true;
    if (m !== 'auto') return false;
    const th = document.documentElement.dataset.theme;
    return th === 'dark' || (th !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  applyPageColor() {
    this.root.classList.toggle('page-dark', this.pageDark());
  }

  setPageDark(on) {
    saveSettings({ pageDark: on ? 'on' : 'off' });
    this.applyPageColor();
  }

  setMode(mode) {
    if (settings.readMode === mode) return;
    const i = Math.max(0, this.current);
    saveSettings({ readMode: mode });
    this.relayoutAt(i);
    if (mode === 'single' && !kv.get('singleHintShown', false)) {
      kv.set('singleHintShown', true);
      toast(t('singleHint'), { duration: 5000 });
    }
  }

  setFitHeight(on) {
    const i = Math.max(0, this.current);
    saveSettings({ fitHeightLandscape: on });
    this.relayoutAt(i);
  }

  /** Lay the pages out again at zoom 1 and show page i. */
  relayoutAt(i) {
    if (!this.pages.length) return;
    this.zoom = 1;
    this.layout();
    this.current = -1;
    this.goToPage(i, { instant: true });
    this.update();
  }

  layout() {
    const W = this.scroller.clientWidth;
    const H = this.scroller.clientHeight;
    this.layoutWidth = W;
    this.layoutHeight = H;
    this.layoutMode = this.modeKey();
    this.per = this.spreadOn() ? 2 : 1;
    const z = this.zoom;
    this.tops = [];
    // Fitted layouts keep the whole page above the floating page slider while it is shown.
    const fitH = Math.max(100, H - this.dockReserve());
    if (this.single) {
      // Each page (or pair of pages) gets a screen-sized slot, side by side, and fits inside it whole.
      const slot = W * z;
      const per = this.per;
      const gap = per === 2 ? GAP : 0;
      const nSlots = Math.ceil(this.pages.length / per);
      for (let k = 0; k < nSlots; k++) {
        const group = this.pages.slice(k * per, k * per + per);
        const ratios = group.map((p) => p.w / p.h);
        if (ratios.length < per) ratios.push(ratios[0]); // a last page alone keeps its pair's size
        const rowH = Math.max(1, Math.min((W - 2 * PAD - gap) / ratios.reduce((a, b) => a + b, 0), fitH - 2 * PAD));
        const widths = group.map((p) => (p.w / p.h) * rowH * z);
        let x = k * slot + (slot - widths.reduce((a, b) => a + b, 0) - gap * z * (group.length - 1)) / 2;
        group.forEach((p, j) => {
          p.width = widths[j];
          p.height = rowH * z;
          p.left = x;
          p.top = (fitH * z - p.height) / 2;
          p.el.style.cssText = `top:${p.top}px;left:${p.left}px;width:${p.width}px;height:${p.height}px`;
          this.tops.push(p.top);
          x += p.width + gap * z;
        });
      }
      const totalW = nSlots * slot;
      this.pagesEl.style.width = totalW + 'px';
      this.pagesEl.style.height = H * z + 'px';
      this.pagesEl.style.left = '0px';
      this.sizer.style.width = totalW + 'px';
      this.sizer.style.height = H * z + 'px';
      this.pagesLeft = 0;
      this.scroller.classList.toggle('snap', z <= 1.001);
      return;
    }
    this.scroller.classList.remove('snap');
    if (this.per === 2) { this.layoutRows(W, fitH, this.steadyHeight() || H); return; }
    let bw = this.baseWidth();
    if (this.fitsHeight()) bw = Math.min(bw, Math.max(120, (fitH - 2 * PAD) / (this.maxRatio || 1.414)));
    const pw = bw * z;
    let y = PAD * z;
    for (const p of this.pages) {
      const h = pw * (p.h / p.w);
      p.top = y;
      p.left = PAD * z;
      p.width = pw;
      p.height = h;
      p.el.style.cssText = `top:${y}px;left:${PAD * z}px;width:${pw}px;height:${h}px`;
      this.tops.push(y);
      y += h + GAP * z;
    }
    const contentW = (bw + 2 * PAD) * z;
    const contentH = y - GAP * z + PAD * z + 60; // room for the page pill
    const left = Math.max(0, (W - contentW) / 2);
    this.pagesEl.style.width = contentW + 'px';
    this.pagesEl.style.height = contentH + 'px';
    this.pagesEl.style.left = left + 'px';
    this.sizer.style.width = Math.max(W, Math.ceil(contentW)) + 'px';
    this.sizer.style.height = contentH + 'px';
    this.pagesLeft = left;
  }

  /** Scrolling layout with two pages per row, each row as wide as the screen allows. */
  layoutRows(W, fitH, H = fitH) {
    const z = this.zoom;
    const maxW = Math.min(W - 2 * PAD, 2 * MAX_PAGE_W + GAP);
    let y = PAD * z;
    for (let k = 0; k < this.pages.length; k += 2) {
      const group = this.pages.slice(k, k + 2);
      const ratios = group.map((p) => p.w / p.h);
      if (ratios.length < 2) ratios.push(ratios[0]);
      let rowH = (maxW - GAP) / (ratios[0] + ratios[1]);
      if (this.fitsHeight()) rowH = Math.min(rowH, Math.max(120, fitH - 2 * PAD));
      // Only a little taller than the screen (an unfolded foldable held sideways): both pages whole,
      // like a book (the page bar over them hides with a tap).
      else if (rowH > H - 2 * PAD && rowH <= (H - 2 * PAD) * 1.12) rowH = Math.max(120, H - 2 * PAD);
      const widths = group.map((p) => (p.w / p.h) * rowH);
      let x = PAD + (maxW - widths.reduce((a, b) => a + b, 0) - GAP * (group.length - 1)) / 2;
      for (let j = 0; j < group.length; j++) {
        const p = group[j];
        p.top = y;
        p.left = x * z;
        p.width = widths[j] * z;
        p.height = rowH * z;
        p.el.style.cssText = `top:${p.top}px;left:${p.left}px;width:${p.width}px;height:${p.height}px`;
        this.tops.push(y);
        x += widths[j] + GAP;
      }
      y += (rowH + GAP) * z;
    }
    const contentW = (maxW + 2 * PAD) * z;
    const contentH = y - GAP * z + PAD * z + 60; // room for the page pill
    const left = Math.max(0, (W - contentW) / 2);
    this.pagesEl.style.width = contentW + 'px';
    this.pagesEl.style.height = contentH + 'px';
    this.pagesEl.style.left = left + 'px';
    this.sizer.style.width = Math.max(W, Math.ceil(contentW)) + 'px';
    this.sizer.style.height = contentH + 'px';
    this.pagesLeft = left;
  }

  /** Height covered by the page slider at the bottom (0 while the bars are hidden). */
  dockReserve() {
    if (this.barsHidden) return 0;
    const dock = $('.vdock', this.root);
    const r = dock.getBoundingClientRect();
    if (!r.height) return 0;
    return Math.max(0, this.scroller.getBoundingClientRect().bottom - r.top) + 4;
  }

  /** One-page mode: index of the page slot under the middle of the screen. */
  slotAt(x) {
    const slot = this.layoutWidth * this.zoom || 1;
    return clamp(Math.floor(x / slot), 0, Math.ceil(this.pages.length / this.per) - 1);
  }

  /** Turn one page (tap on the screen edge in one-page mode); fast taps keep counting. */
  flip(d) {
    const base = this.flipTarget != null && Date.now() - this.flipAt < 600 ? this.flipTarget : this.current;
    const i = this.rowStart(clamp(base + d * this.per, 0, this.pages.length - 1));
    this.flipTarget = i;
    this.flipAt = Date.now();
    if (i !== base) this.goToPage(i);
  }

  /** In one-page mode at zoom 1, the tap zones turn pages: left 30% back, right 30% forward. */
  edgeTap(clientX) {
    if (!this.single || this.zoom > 1.001 || !this.doc || !this.searchBar.hidden) return 0;
    const r = this.scroller.getBoundingClientRect();
    const fx = (clientX - r.left) / r.width;
    return fx < 0.3 ? -1 : fx > 0.7 ? 1 : 0;
  }

  pageAt(y) {
    const t = this.tops;
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  goToPage(i, { instant = false } = {}) {
    if (!this.pages.length) return;
    i = clamp(i, 0, this.pages.length - 1);
    // Where this jump is going, for a moment: the screen may change size meanwhile (the keyboard of
    // "Go to page" closing), and the resize must keep heading there, not back to the page it left.
    this.pendingPage = { i, until: Date.now() + 1500 };
    if (this.single) {
      const k = Math.floor(i / this.per);
      this.scroller.scrollTo({ left: k * this.layoutWidth * this.zoom, top: 0, behavior: instant ? 'instant' : scrollBehavior() });
      if (instant) this.update();
      return;
    }
    const top = Math.max(0, this.pages[i].top - PAD * this.zoom);
    this.scroller.scrollTo({ top, behavior: instant ? 'instant' : scrollBehavior() });
    if (instant) this.update();
  }

  // ------------------------------------------------------------------ rendering
  scheduleUpdate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); });
  }

  update() {
    if (!this.pages.length) return;
    let cur;
    const per = this.per;
    const n = this.pages.length;
    if (this.single) {
      const left = this.scroller.scrollLeft;
      const w = this.scroller.clientWidth;
      this.first = this.slotAt(left) * per;
      this.last = Math.min(n - 1, this.slotAt(left + w - 1) * per + per - 1);
      cur = this.slotAt(left + w / 2) * per;
    } else {
      // Pages of one row share their top: count a row from its first page.
      const top = this.scroller.scrollTop;
      const h = this.scroller.clientHeight;
      this.first = this.rowStart(this.pageAt(top));
      this.last = Math.min(n - 1, this.rowStart(this.pageAt(top + h)) + per - 1);
      cur = this.rowStart(this.pageAt(top + h * 0.4));
    }
    if (cur !== this.current) {
      this.current = cur;
      this.updateBookmarkButton();
      this.updateScrub();
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveState(), 800);
    }
    this.showPill();
    // Free canvases far from the viewport; zoomed in, each one is big: keep only what is on screen.
    const keep = this.zoom > 1.5 ? 0 : 3;
    for (const p of this.pages) {
      if (p.canvas && (p.i < this.first - keep || p.i > this.last + keep)) this.releasePage(p);
    }
    this.pump();
  }

  targetScale(p) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let s = (p.width * dpr) / p.w;
    const px = p.w * p.h * s * s;
    if (px > MAX_CANVAS_PX) s *= Math.sqrt(MAX_CANVAS_PX / px);
    return s;
  }

  needsRender(i) {
    const p = this.pages[i];
    if (!p) return false;
    const target = this.targetScale(p);
    // Too coarse, or far sharper than needed after zooming back out (memory).
    return p.scale < target * 0.92 || p.scale > target * 1.6;
  }

  nextToRender() {
    const order = [];
    for (let i = this.first; i <= this.last; i++) order.push(i);
    if (this.zoom <= 1.5) order.push(this.last + 1, this.first - 1, this.last + 2); // neighbours ahead, not when zoomed
    for (const i of order) if (i >= 0 && i < this.pages.length && this.needsRender(i)) return i;
    return -1;
  }

  async pump() {
    if (this.rendering || this.pinch) return;
    this.rendering = true;
    const gen = this.gen;
    try {
      for (;;) {
        if (gen !== this.gen || this.pinch) break;
        const i = this.nextToRender();
        if (i < 0) break;
        await this.renderPage(this.pages[i], gen);
      }
    } catch (e) {
      if (gen === this.gen) console.error(e);
    } finally {
      this.rendering = false;
    }
  }

  async renderPage(p, gen) {
    const page = await this.doc.getPage(p.i + 1);
    if (gen !== this.gen) return;
    const scale = this.targetScale(p);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport: vp });
    p.task = task;
    try {
      await task.promise;
    } catch (e) {
      canvas.width = canvas.height = 0;
      if (e && e.name === 'RenderingCancelledException') return;
      throw e;
    } finally {
      p.task = null;
    }
    if (gen !== this.gen) { canvas.width = canvas.height = 0; return; }
    if (p.canvas) { p.canvas.replaceWith(canvas); p.canvas.width = p.canvas.height = 0; } else p.el.prepend(canvas);
    p.canvas = canvas;
    p.scale = scale;
    if (!p.links) { p.links = true; this.addLinks(p, page); this.addPageText(p, page); }
    if (this.changed && this.changed.has(p.i + 1)) this.markChanged(p);
  }

  releasePage(p) {
    if (p.task) { p.task.cancel(); p.task = null; }
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0;
      p.canvas.remove();
      p.canvas = null;
      // PDF.js keeps a page's parsed drawing commands and images until told otherwise.
      const doc = this.doc;
      if (doc) doc.getPage(p.i + 1).then((pg) => { if (this.doc === doc && !p.canvas) pg.cleanup(); }).catch(() => {});
    }
    p.scale = 0;
  }

  /** The page's own text, for screen readers (the page itself is a picture). */
  async addPageText(p, page) {
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = tc.items.map((it) => it.str || '').join(' ').replace(/\s+/g, ' ').trim();
    } catch { return; }
    if (!text || !p.el || !p.el.isConnected) return;
    const div = document.createElement('div');
    div.className = 'sr-only';
    div.textContent = t('pageN', { n: p.i + 1 }) + '. ' + text.slice(0, 20000); // where one page ends
    p.el.insertBefore(div, p.el.querySelector('.plink')); // the text before the page's links
  }

  async addLinks(p, page) {
    let annots;
    try { annots = await page.getAnnotations({ intent: 'display' }); } catch { return; }
    const vp = page.getViewport({ scale: 1 });
    for (const a of annots) {
      if (a.subtype !== 'Link' || (!a.url && !a.dest)) continue;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      const el = document.createElement('a');
      el.className = 'plink';
      el.style.left = (Math.min(x1, x2) / vp.width) * 100 + '%';
      el.style.top = (Math.min(y1, y2) / vp.height) * 100 + '%';
      el.style.width = (Math.abs(x2 - x1) / vp.width) * 100 + '%';
      el.style.height = (Math.abs(y2 - y1) / vp.height) * 100 + '%';
      if (a.url) {
        el.href = a.url;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        el.setAttribute('aria-label', String(a.url).replace(/^https?:\/\//, '').slice(0, 80));
      } else {
        el.href = '#';
        el.setAttribute('aria-label', t('linkInPdf'));
        el.onclick = (e) => { e.preventDefault(); this.goToDest(a.dest); };
      }
      p.el.appendChild(el);
    }
  }

  async resolveDest(dest) {
    const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return -1;
    const ref = explicit[0];
    if (typeof ref === 'number') return ref;
    return this.doc.getPageIndex(ref);
  }

  async goToDest(dest) {
    try {
      const i = await this.resolveDest(dest);
      if (i >= 0) this.goToPage(i);
    } catch (e) {
      console.warn('bad link', e);
    }
  }

  // ------------------------------------------------------------------ zoom
  /** Commit a zoom change so that content point under viewport point (fx, fy) stays put. */
  applyZoom(z, fx, fy) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const s = z / this.zoom;
    const cx = this.scroller.scrollLeft + fx - this.pagesLeft;
    const cy = this.scroller.scrollTop + fy;
    const keep = this.current;
    this.zoom = z;
    this.layout();
    this.scroller.scrollLeft = cx * s + this.pagesLeft - fx;
    this.scroller.scrollTop = cy * s - fy;
    this.resnap(keep);
    this.scheduleUpdate();
    if (this.relayoutPending && this.zoom <= 1.001) { this.relayoutPending = false; this.relayoutAt(Math.max(0, keep)); }
  }

  /**
   * One-page mode back at zoom 1: settle on the page that was being read. (The zoom anchor can
   * land in the neighbouring slot, e.g. after panning to a page's right edge.)
   */
  resnap(keep = this.current) {
    if (!this.single || this.zoom > 1.001) return;
    const i = keep >= 0 ? keep : this.slotAt(this.scroller.scrollLeft + this.scroller.clientWidth / 2) * this.per;
    this.goToPage(i, { instant: true });
  }

  animateZoom(z, fx, fy, onDone) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const s = z / this.zoom;
    const cx = this.scroller.scrollLeft + fx - this.pagesLeft;
    const cy = this.scroller.scrollTop + fy;
    const el = this.pagesEl;
    el.style.transformOrigin = `${cx}px ${cy}px`;
    el.style.transition = 'transform .22s ease';
    el.style.transform = `scale(${s})`;
    this.pinch = { animating: true };
    setTimeout(() => {
      el.style.transition = '';
      el.style.transform = '';
      el.style.transformOrigin = '';
      this.pinch = null;
      this.applyZoom(z, fx, fy);
      if (onDone) onDone();
    }, 230);
  }

  /** "원래 크기로": zoom out around the reading line, so the same page stays current. */
  resetZoom() {
    if (this.zoom === 1) return;
    const keep = this.current;
    const w = this.scroller.clientWidth;
    const h = this.scroller.clientHeight;
    this.animateZoom(1, w / 2, h * 0.4, () => {
      this.update();
      if (keep >= 0 && keep !== this.current) this.goToPage(keep, { instant: true }); // near the document's ends
    });
  }

  localPoint(clientX, clientY) {
    const r = this.scroller.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  onTouchStart(e) {
    this.pendingPage = null; // the reader takes over: a resize keeps what is on screen again
    if (this.stroke) {
      // Writing: the page stays still. A second finger while a finger writes is a pinch instead
      // (a hand resting on the screen while a stylus writes is not).
      if (this.stroke.finger && e.touches.length > 1) this.cancelStroke();
      else { e.preventDefault(); this.touchStart = null; return; }
    }
    if (e.touches.length === 2 && !this.pinch) {
      const [a, b] = e.touches;
      const f = this.localPoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      this.pinch = {
        d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        f0: f,
        f1: f,
        s: 1,
        sx: this.scroller.scrollLeft,
        sy: this.scroller.scrollTop,
        left: this.pagesLeft,
        z0: this.zoom,
      };
      this.pagesEl.style.transformOrigin = '0 0';
      this.tap = null;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      this.touchStart = { x: t.clientX, y: t.clientY, time: Date.now(), moved: false };
    }
  }

  onTouchMove(e) {
    if (this.stroke) { e.preventDefault(); return; }
    const pz = this.pinch;
    if (pz && !pz.animating && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pz.s = clamp(d / pz.d0, MIN_ZOOM / pz.z0 * 0.85, MAX_ZOOM / pz.z0 * 1.1);
      pz.f1 = this.localPoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      // Keep the content point that was under the initial midpoint under the current midpoint.
      const cx = pz.sx + pz.f0.x - pz.left;
      const cy = pz.sy + pz.f0.y;
      const tx = pz.f1.x + pz.sx - pz.left - cx * pz.s;
      const ty = pz.f1.y + pz.sy - cy * pz.s;
      this.pagesEl.style.transform = `translate(${tx}px, ${ty}px) scale(${pz.s})`;
    } else if (this.touchStart && e.touches.length === 1) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - this.touchStart.x, t.clientY - this.touchStart.y) > 10) this.touchStart.moved = true;
    }
  }

  onTouchEnd(e) {
    const pz = this.pinch;
    if (pz && !pz.animating && e.touches.length < 2) {
      const z1 = clamp(pz.z0 * pz.s, MIN_ZOOM, MAX_ZOOM);
      const s = z1 / pz.z0;
      const cx = pz.sx + pz.f0.x - pz.left;
      const cy = pz.sy + pz.f0.y;
      this.pagesEl.style.transform = '';
      this.pinch = null;
      const keep = this.current;
      this.zoom = z1;
      this.layout();
      this.scroller.scrollLeft = cx * s + this.pagesLeft - pz.f1.x;
      this.scroller.scrollTop = cy * s - pz.f1.y;
      this.resnap(keep);
      if (this.relayoutPending && this.zoom <= 1.001) { this.relayoutPending = false; this.relayoutAt(Math.max(0, keep)); }
      this.touchStart = null;
      this.scheduleUpdate();
      return;
    }
    // double tap → toggle zoom
    const ts = this.touchStart;
    this.touchStart = null;
    if (this.inking) return; // writing: taps write dots, they don't turn pages or hide the bars
    if (!ts || ts.moved || e.touches.length || Date.now() - ts.time > 300) return;
    if (e.target.closest && e.target.closest('.plink')) return;
    const now = Date.now();
    this.lastTouch = now;
    const edge = this.edgeTap(ts.x);
    if (edge) { // turn the page right away (no double-tap wait on the edges)
      e.preventDefault();
      this.lastTap = null;
      clearTimeout(this.tapTimer);
      this.flip(edge);
      return;
    }
    if (this.lastTap && now - this.lastTap.time < 320 && Math.hypot(ts.x - this.lastTap.x, ts.y - this.lastTap.y) < 40) {
      this.lastTap = null;
      clearTimeout(this.tapTimer);
      e.preventDefault();
      const f = this.localPoint(ts.x, ts.y);
      this.animateZoom(this.zoom > 1.05 ? 1 : 2.2, f.x, f.y);
    } else {
      this.lastTap = { time: now, x: ts.x, y: ts.y };
      clearTimeout(this.tapTimer);
      this.tapTimer = setTimeout(() => this.onSingleTap(), 330);
    }
  }

  // ------------------------------------------------------------------ chrome
  /** Keep the page slider, its label and the title's page counter in step with the reading position. */
  updateScrub() {
    const n = this.pages.length;
    if (!n) { this.subtitle.textContent = ''; return; }
    const cur = this.pageLabel();
    this.subtitle.textContent = t('pageOfN', { cur, n });
    this.scrubLabel.innerHTML = `${cur}<small> / ${n}</small>`;
    if (this.scrubbing) return;
    const at = Math.max(0, this.current) + 1;
    this.scrub.max = String(n);
    this.scrub.value = String(at);
    this.scrub.style.setProperty('--pct', n > 1 ? ((at - 1) / (n - 1)) * 100 + '%' : '100%');
  }

  /** "3", or "3–4" while two pages are shown side by side. */
  pageLabel() {
    const cur = Math.max(0, this.current) + 1;
    return this.per === 2 && cur < this.pages.length ? `${cur}–${cur + 1}` : String(cur);
  }

  onScrubInput() {
    const n = this.pages.length;
    const v = Number(this.scrub.value);
    this.scrubbing = true;
    const frac = n > 1 ? (v - 1) / (n - 1) : 1;
    this.scrub.style.setProperty('--pct', frac * 100 + '%');
    // Float a big page number above the thumb while dragging.
    const r = this.scrub.getBoundingClientRect();
    const dock = this.bubble.parentElement.getBoundingClientRect();
    this.bubble.textContent = `${v} / ${n}`;
    this.bubble.style.left = `${r.left - dock.left + 11 + frac * (r.width - 22)}px`;
    this.bubble.classList.add('show');
    if (!this.scrubRaf) {
      this.scrubRaf = requestAnimationFrame(() => {
        this.scrubRaf = 0;
        this.goToPage(Number(this.scrub.value) - 1, { instant: true });
      });
    }
  }

  onScrubEnd() {
    this.scrubbing = false;
    this.goToPage(Number(this.scrub.value) - 1, { instant: true });
    setTimeout(() => this.bubble.classList.remove('show'), 350);
    this.updateScrub();
  }

  showPill() {
    if (!this.pages.length) return;
    this.pill.textContent = `${this.pageLabel()} / ${this.pages.length}`;
    this.pill.classList.add('show');
    clearTimeout(this.pillTimer);
    this.pillTimer = setTimeout(() => this.pill.classList.remove('show'), 1600);
  }

  updateBookmarkButton() {
    if (!this.meta) return;
    const bms = docState(this.meta.id).bookmarks || [];
    const on = bms.includes(this.current + 1);
    const b = $('[data-act=bookmark] span', this.root);
    b.dataset.icon = on ? 'bookmarkFill' : 'bookmark';
    b.parentElement.classList.toggle('active', on);
    hydrateIcons(b.parentElement);
  }

  toggleBookmark() {
    if (this.meta && this.meta.preview) { toast(t('previewAddFirst')); return; }
    if (!this.meta || this.current < 0) return;
    const n = this.current + 1;
    const bms = new Set(docState(this.meta.id).bookmarks || []);
    if (bms.has(n)) { bms.delete(n); toast(t('bookmarkRemoved', { n })); } else { bms.add(n); toast(t('bookmarkAdded', { n })); }
    updateDocState(this.meta.id, { bookmarks: [...bms].sort((a, b) => a - b) });
    this.updateBookmarkButton();
  }

  async askPage() {
    if (!this.pages.length) return;
    const v = await dialog({
      title: t('goToPage'),
      message: `1 – ${this.pages.length}`,
      input: String(this.current + 1),
      numeric: true, // the number keypad
      okText: t('go'),
    });
    // Full-width digits (some keyboards type "４") count as numbers too.
    const n = parseInt(String(v ?? '').replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10)).trim(), 10);
    if (Number.isFinite(n)) this.goToPage(n - 1); // 0 or less: the first page, like too large a number goes to the last
  }

  showInfo() {
    const m = this.meta;
    if (!m) return;
    dialog({
      title: m.name,
      message: [
        t('pagesCount', { n: this.pages.length }),
        m.size || this.blob ? fmtSize(m.size || this.blob.size) : '',
        m.modifiedTime ? t('modifiedAt', { d: fmtDate(m.modifiedTime) }) : '',
        m.path ? t('locationAt', { p: m.path }) : '',
        this.restricted() ? t('restrictedInfo') : '',
      ].filter(Boolean).join('\n'),
      cancelText: '',
    });
  }

  // ------------------------------------------------------------------ thumbnails sheet
  openSheet(tab = 'thumbs') {
    if (!this.doc) return;
    this.sheet.hidden = false;
    this.underSheet(true);
    requestAnimationFrame(() => this.sheet.classList.add('open'));
    this.showSheetTab(tab);
  }

  /** The bars, the pages and the page slider under the sheet: out of reach for Tab while it is open. */
  underSheet(on) {
    for (const el of $$('.vbar, .scroller, .vdock, .vpreview', this.root)) el.inert = on;
  }

  closeSheet() {
    if (this.picking) this.setPicking(false);
    if (this.thumbObserver) { this.thumbObserver.disconnect(); this.thumbObserver = null; }
    this.sheet.classList.remove('open');
    this.sheet.hidden = true;
    this.underSheet(false);
    $('.sheet-body', this.sheet).innerHTML = '';
  }

  showSheetTab(tab) {
    $$('.seg button', this.sheet).forEach((b) => {
      b.classList.toggle('on', b.dataset.seg === tab);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(b.dataset.seg === tab));
    });
    const body = $('.sheet-body', this.sheet);
    if (this.thumbObserver) { this.thumbObserver.disconnect(); this.thumbObserver = null; }
    body.scrollTop = 0;
    this.sheetTab = tab;
    if (this.picking) this.setPicking(false);
    $('.sheet-left', this.sheet).hidden = tab === 'outline';
    if (tab === 'outline') { this.renderOutline(body); return; }
    const all = this.pages.map((p) => p.i + 1);
    const nums = tab === 'bookmarks' ? (docState(this.meta.id).bookmarks || []).filter((n) => n <= this.pages.length) : all;
    if (!nums.length) {
      body.innerHTML = `<div class="empty small"><span data-icon="bookmark"></span><b>${t('noBookmarksTitle')}</b><p>${t(this.meta && this.meta.preview ? 'previewAddFirst' : 'noBookmarksText')}</p></div>`;
      hydrateIcons(body);
      return;
    }
    body.innerHTML = `<div class="thumbgrid">${nums.map((n) => {
      const p = this.pages[n - 1];
      const changed = this.changed && this.changed.has(n);
      return `<button class="thumb ${n - 1 === this.current ? 'current' : ''} ${changed ? 'changed' : ''}" data-n="${n}">
        <div class="thumb-img" style="aspect-ratio:${p.w}/${p.h}"></div>
        <i class="thumb-check">${icon('check')}</i>
        <span>${esc(joinList([String(n), changed && t('changedTag')]))}</span></button>`;
    }).join('')}</div>`;
    this.thumbCache = this.thumbCache || new Map();
    this.thumbObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        this.thumbObserver.unobserve(en.target);
        this.fillThumb(en.target);
      }
    }, { root: body, rootMargin: '200px' });
    $$('.thumb', body).forEach((b) => {
      this.thumbObserver.observe(b);
      b.onclick = () => {
        if (Date.now() - (this.pickDragEnded || 0) < 450) return; // the lift at the end of a drag
        if (this.picking) { this.togglePick(+b.dataset.n); return; }
        this.closeSheet();
        this.goToPage(+b.dataset.n - 1, { instant: true });
      };
    });
    const cur = $('.thumb.current', body);
    if (cur) cur.scrollIntoView({ block: 'center' });
  }

  // ------------------------------------------------------------------ choose pages → export
  setPicking(on) {
    this.picking = on;
    this.picked.clear();
    const head = $('.sheet-head', this.sheet);
    $('.seg', head).hidden = on;
    $('.pick-count', head).hidden = !on;
    const left = $('.sheet-left', head);
    left.dataset.act = on ? 'pick-all' : 'pick-start';
    left.hidden = !on && this.restricted(); // (picking pages only leads to exporting them)
    left.className = (on ? 'textbtn' : 'ibtn') + ' sheet-left';
    if (on) left.removeAttribute('aria-label'); else left.setAttribute('aria-label', t('select')); // text says it when picking
    const right = $('.sheet-right', head);
    right.dataset.act = on ? 'pick-cancel' : 'thumbs-close';
    right.className = (on ? 'ibtn' : 'textbtn strong') + ' sheet-right';
    if (on) { right.innerHTML = icon('x'); right.setAttribute('aria-label', t('cancel')); } else { right.textContent = t('done'); right.removeAttribute('aria-label'); }
    $('.sheet-foot', this.sheet).hidden = !on;
    const body = $('.sheet-body', this.sheet);
    body.classList.toggle('picking', on);
    $$('.thumb.picked', body).forEach((b) => b.classList.remove('picked'));
    this.updatePickUi();
  }

  togglePick(n) {
    if (this.picked.has(n)) this.picked.delete(n); else this.picked.add(n);
    const b = $(`.thumb[data-n="${n}"]`, this.sheet);
    if (b) b.classList.toggle('picked', this.picked.has(n));
    this.updatePickUi();
  }

  pickAll() {
    const thumbs = $$('.thumb', this.sheet);
    const all = thumbs.length && this.picked.size === thumbs.length;
    this.picked.clear();
    thumbs.forEach((b) => {
      if (!all) this.picked.add(+b.dataset.n);
      b.classList.toggle('picked', !all);
    });
    this.updatePickUi();
  }

  updatePickUi() {
    const left = $('.sheet-left', this.sheet);
    if (!this.picking) { left.innerHTML = icon('checkCircle'); return; }
    const n = this.picked.size;
    const total = $$('.thumb', this.sheet).length;
    left.textContent = n && n === total ? t('pickNone') : t('pickAll');
    $('.pick-count', this.sheet).textContent = n ? t('pagesSelected', { n }) : t('pickPages');
    $('.pick-export', this.sheet).disabled = !n;
  }

  /**
   * Drag to pick a run of pages (like a photo gallery):
   * - while picking, a sideways swipe over the thumbnails selects every page it passes;
   * - a long-press (also outside picking mode) starts the same drag in any direction, and holding
   *   the finger near the top/bottom edge scrolls the list while it keeps selecting.
   * The range runs from the first page to the page under the finger; starting on a picked page
   * un-picks the range instead. Pages outside the range keep their earlier state.
   */
  bindPickDrag() {
    const body = $('.sheet-body', this.sheet);
    const thumbs = () => $$('.thumb', body);
    let st = null;
    const indexAt = (x, y) => {
      const r = body.getBoundingClientRect();
      const el = document.elementFromPoint(clamp(x, r.left + 2, r.right - 2), clamp(y, r.top + 2, r.bottom - 2));
      const b = el && el.closest('.thumb');
      return b && body.contains(b) ? thumbs().indexOf(b) : -1;
    };
    const apply = (idx) => {
      if (idx < 0 || idx === st.last) return; // between thumbnails: keep the current range
      st.last = idx;
      const lo = Math.min(st.idx, idx);
      const hi = Math.max(st.idx, idx);
      thumbs().forEach((el, k) => {
        const n = +el.dataset.n;
        const want = k >= lo && k <= hi ? st.adding : st.base.has(n);
        if (want) this.picked.add(n); else this.picked.delete(n);
        el.classList.toggle('picked', want);
      });
      this.updatePickUi();
    };
    const autoScroll = () => {
      if (!st || !st.active) return;
      const r = body.getBoundingClientRect();
      const edge = 72;
      let v = 0;
      if (st.fy < r.top + edge) v = -Math.ceil((r.top + edge - st.fy) / 4);
      else if (st.fy > r.bottom - edge) v = Math.ceil((st.fy - (r.bottom - edge)) / 4);
      if (v) {
        body.scrollTop += clamp(v, -28, 28);
        apply(indexAt(st.fx, st.fy));
      }
      st.raf = requestAnimationFrame(autoScroll);
    };
    const start = () => {
      clearTimeout(st.timer);
      st.active = true;
      if (!this.picking) this.setPicking(true);
      st.base = new Set(this.picked);
      st.adding = !this.picked.has(st.n);
      st.last = null;
      if (navigator.vibrate) navigator.vibrate(10);
      apply(st.idx);
      st.raf = requestAnimationFrame(autoScroll);
    };
    const begin = (target, x, y, mouse) => {
      const b = target.closest && target.closest('.thumb');
      if (!b || !body.contains(b) || this.sheetTab === 'outline') return;
      st = { x, y, fx: x, fy: y, idx: thumbs().indexOf(b), n: +b.dataset.n, active: false, mouse };
      if (!mouse) st.timer = setTimeout(() => { if (st && !st.active) start(); }, 380);
    };
    const move = (x, y, e) => {
      if (!st) return;
      st.fx = x;
      st.fy = y;
      if (st.active) {
        if (e.cancelable) e.preventDefault(); // no scrolling while dragging
        apply(indexAt(x, y));
        return;
      }
      const dx = x - st.x;
      const dy = y - st.y;
      if (Math.hypot(dx, dy) < 10) return;
      if (this.picking && (st.mouse || Math.abs(dx) > Math.abs(dy))) {
        if (e.cancelable) e.preventDefault();
        start();
        apply(indexAt(x, y));
      } else {
        clearTimeout(st.timer); // an up/down swipe scrolls the list as usual
        st = null;
      }
    };
    const end = () => {
      if (!st) return;
      clearTimeout(st.timer);
      if (st.active) {
        cancelAnimationFrame(st.raf);
        this.pickDragEnded = Date.now();
      }
      st = null;
    };
    body.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { end(); return; }
      begin(e.target, e.touches[0].clientX, e.touches[0].clientY, false);
    }, { passive: true });
    body.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
    body.addEventListener('touchend', end);
    body.addEventListener('touchcancel', end);
    body.addEventListener('contextmenu', (e) => { if (e.target.closest('.thumb')) e.preventDefault(); });
    // mouse (desktop / tests): press on a thumbnail while picking and drag
    body.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button === 0 && this.picking) begin(e.target, e.clientX, e.clientY, true);
    });
    window.addEventListener('pointermove', (e) => { if (st && st.mouse) move(e.clientX, e.clientY, e); });
    window.addEventListener('pointerup', () => { if (st && st.mouse) end(); });
  }

  /** Export sheet: PDF or images (optionally one ZIP), with an editable file name. */
  /** A distribution document's copy: kept to reading (its author chose: no copying or printing). */
  restricted() {
    // (the copy being shown says so itself: the index may still describe an older version)
    return !!(this.blob && this.blob.restricted);
  }

  openExport() {
    if (this.restricted()) { toast(t('restrictedDoc'), { duration: 6000 }); return; }
    const nums = [...this.picked].sort((a, b) => a - b);
    if (!nums.length || !this.blob || !this.doc) return;
    // (the export is of this document: if another one is opened meanwhile, it stops)
    const src = { blob: this.blob, doc: this.doc };
    const base = safeFileName(this.meta.name);
    let fmt = kv.get('exportFormat', 'pdf') === 'image' ? 'image' : 'pdf';
    let zip = !!kv.get('exportZip', false);
    const hasInkPicked = nums.some((n) => this.inkOn(n));
    let withInk = kv.get('exportInk', true) !== false;
    const html = `
      <div class="asheet xsheet" role="dialog">
        <div class="asheet-head"><b>${esc(t('exportTitle'))}</b><small>${esc(t('exportPages', { n: nums.length, list: pageRanges(nums) }))}</small></div>
        <div class="xrow"><span class="xlabel">${esc(t('exportFormat'))}</span>
          <div class="seg" data-x="fmt"><button data-v="pdf">PDF</button><button data-v="image">${esc(t('formatImage'))}</button></div>
        </div>
        <label class="xrow xname"><span class="xlabel">${esc(t('fileName'))}</span>
          <span class="xname-field"><input type="text" value="${esc(base)}" enterkeyhint="done" autocomplete="off" autocapitalize="off" spellcheck="false"><span class="xext"></span></span>
        </label>
        <label class="xrow" data-x="inkrow"${hasInkPicked ? '' : ' hidden'}><span class="xlabel">${esc(t('exportInk'))}</span><input type="checkbox" class="switch" data-x="ink"></label>
        <label class="xrow" data-x="ziprow"><span class="xlabel">${esc(t('zipImages'))}<small></small></span><input type="checkbox" class="switch" data-x="zip"></label>
        <div class="xprogress" hidden><span></span><div class="progress"><i></i></div></div>
        <div class="xbtns"><button data-x="cancel">${esc(t('cancel'))}</button><button class="strong" data-x="go">${esc(t('exportGo'))}</button></div>
      </div>`;
    const { wrap, close } = mountOverlay(html, 'ov-sheet');
    const q = (sel) => wrap.querySelector(sel);
    const input = q('input[type=text]');
    const zipBox = q('[data-x=zip]');
    zipBox.checked = zip;
    const inkBox = q('[data-x=ink]');
    inkBox.checked = withInk;
    inkBox.onchange = () => { withInk = inkBox.checked; kv.set('exportInk', withInk); };
    let busy = false;
    let cancelled = false;
    const name = () => safeFileName(input.value, base);
    const refresh = () => {
      const multi = nums.length > 1;
      $$('[data-x=fmt] button', wrap).forEach((b) => {
        b.classList.toggle('on', b.dataset.v === fmt);
        b.setAttribute('aria-pressed', String(b.dataset.v === fmt));
      });
      q('[data-x=ziprow]').hidden = fmt !== 'image' || !multi;
      q('[data-x=ziprow] small').textContent = zip ? t('zipImagesSub') : t('imagesFolderHint', { folder: name() });
      const pad = String(this.pages.length).length;
      q('.xext').textContent = fmt === 'pdf' ? '.pdf'
        : multi && zip ? '.zip'
          : multi ? `_${String(nums[0]).padStart(pad, '0')}.png …` : '.png';
    };
    refresh();
    $$('[data-x=fmt] button', wrap).forEach((b) => {
      b.onclick = () => { if (busy) return; fmt = b.dataset.v; kv.set('exportFormat', fmt); refresh(); };
    });
    zipBox.onchange = () => { zip = zipBox.checked; kv.set('exportZip', zip); refresh(); };
    input.oninput = refresh;
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
    const shut = () => { cancelled = true; close(); };
    wrap.querySelector('.ov-backdrop').onclick = () => { if (!busy) shut(); };
    q('[data-x=cancel]').onclick = shut;
    const progress = (text, frac) => {
      const box = q('.xprogress');
      box.hidden = false;
      q('.xprogress span').textContent = text;
      q('.xprogress i').style.width = frac == null ? '100%' : Math.round(frac * 100) + '%';
    };
    q('[data-x=go]').onclick = async () => {
      if (busy) return;
      if (this.blob !== src.blob || this.doc !== src.doc || this.restricted()) { shut(); if (this.restricted()) toast(t('restrictedDoc'), { duration: 6000 }); return; }
      busy = true;
      q('[data-x=go]').disabled = true;
      input.disabled = zipBox.disabled = inkBox.disabled = true;
      const file = name();
      try {
        const inkMap = hasInkPicked && withInk ? await this.inkForExport(nums, src) : null;
        const msg = fmt === 'pdf'
          ? await this.exportPdf(nums, file, progress, src, inkMap)
          : await this.exportImages(nums, file, nums.length > 1 && zip, progress, () => cancelled || this.doc !== src.doc, src, inkMap);
        if (cancelled) return;
        close();
        this.setPicking(false);
        toast(msg, { duration: 4500 });
      } catch (e) {
        console.error(e);
        if (cancelled) return;
        busy = false;
        q('[data-x=go]').disabled = false;
        input.disabled = zipBox.disabled = inkBox.disabled = false;
        q('.xprogress').hidden = true;
        toast(t('exportFailed', { e: e.message || e }), { duration: 4500 });
      }
    };
  }

  /** The handwriting of the chosen pages, with where each page sits ({strokes, vt}; see ink.js). */
  async inkForExport(nums, src) {
    const map = new Map();
    for (const n of nums) {
      const strokes = this.inkOn(n);
      if (!strokes) continue;
      const page = await src.doc.getPage(n);
      map.set(n, { strokes: strokes.slice(), vt: page.getViewport({ scale: 1 }).transform });
    }
    return map.size ? map : null;
  }

  async exportPdf(nums, file, progress, src, inkMap = null) {
    if (!src || src.blob.restricted) throw new Error(t('restrictedDoc'));
    progress(t('exportingPdf'), null);
    const whole = nums.length === src.doc.numPages && nums.every((n, i) => n === i + 1);
    const blob = whole && !inkMap ? src.blob // every page in order, nothing written on them: the original file as it is
      : whole ? await inkIntoWholePdf(src.blob, (n) => inkMap.get(n)) // (keeps its outline and forms)
        : await extractPdf(src.blob, nums, inkMap && ((n) => inkMap.get(n)));
    progress(t('exportingSave'), null);
    const name = file + '.pdf';
    if (!(await saveFile(blob, name))) throw new Error(t('saveFailed'));
    return t('savedToDownloads', { name });
  }

  async exportImages(nums, file, zip, progress, isCancelled, src, inkMap = null) {
    if (!src || src.blob.restricted) throw new Error(t('restrictedDoc'));
    const pad = String(src.doc.numPages).length;
    const multi = nums.length > 1;
    const files = [];
    for (let k = 0; k < nums.length; k++) {
      if (isCancelled()) return '';
      progress(t('exportingImages', { i: k + 1, n: nums.length }), k / nums.length);
      const png = await pageToPng(src.doc, nums[k], inkMap && inkMap.get(nums[k]) ? inkMap.get(nums[k]).strokes : null);
      const name = multi ? `${file}_${String(nums[k]).padStart(pad, '0')}.png` : `${file}.png`;
      if (zip) files.push({ name, blob: png });
      else if (!(await saveFile(png, name, { folder: multi ? file : '' }))) throw new Error(t('saveFailed'));
    }
    if (zip) {
      progress(t('exportingSave'), null);
      const name = file + '.zip';
      if (!(await saveFile(await makeZip(files), name))) throw new Error(t('saveFailed'));
      return t('savedToDownloads', { name });
    }
    if (!multi) return t('savedToDownloads', { name: file + '.png' });
    return t('imagesSaved', { n: nums.length, where: window.GNVNative ? t('downloadsFolder', { folder: file }) : file });
  }

  async fillThumb(btn) {
    const n = +btn.dataset.n;
    const holder = $('.thumb-img', btn);
    let url = this.thumbCache.get(n);
    if (!url) {
      const gen = this.gen;
      try {
        const page = await this.doc.getPage(n);
        const c = await renderToCanvas(page, 150);
        if (gen !== this.gen) return;
        const strokes = this.inkOn(n);
        if (strokes && this.pages[n - 1]) drawInk(c.getContext('2d'), strokes, c.width / this.pages[n - 1].w);
        url = c.toDataURL('image/jpeg', 0.8);
        c.width = c.height = 0;
        this.thumbCache.set(n, url);
      } catch { return; }
    }
    holder.style.backgroundImage = `url(${url})`;
    holder.classList.add('loaded');
  }

  async renderOutline(body) {
    body.innerHTML = '<div class="empty small"><div class="spinner"></div></div>';
    let outline = null;
    const gen = this.gen;
    const stale = () => gen !== this.gen || this.sheetTab !== 'outline' || this.sheet.hidden; // moved on meanwhile
    try { outline = await this.doc.getOutline(); } catch { /* ignore */ }
    if (stale()) return;
    if (!outline || !outline.length) { this.renderAutoToc(body, stale); return; }
    const rows = [];
    const walk = (items, depth) => {
      for (const it of items) {
        rows.push({ title: it.title, dest: it.dest, depth });
        if (it.items && it.items.length) walk(it.items, depth + 1);
      }
    };
    walk(outline, 0);
    const pagesOf = await Promise.all(rows.map((r) => this.resolveDest(r.dest).catch(() => -1)));
    if (stale()) return;
    body.innerHTML = `<div class="glist outline">${rows.map((r, k) => `
      <button class="glist-row" data-k="${k}" style="padding-left:${16 + r.depth * 18}px" ${pagesOf[k] >= 0 ? `aria-label="${esc(r.title)}, ${esc(t('pageN', { n: pagesOf[k] + 1 }))}"` : ''}>
        <span class="glist-label">${esc(r.title)}</span>
        <span class="glist-value">${pagesOf[k] >= 0 ? pagesOf[k] + 1 : ''}</span>
      </button>`).join('')}</div>`;
    $$('.glist-row', body).forEach((b) => {
      b.onclick = () => {
        const i = pagesOf[+b.dataset.k];
        if (i >= 0) { this.closeSheet(); this.goToPage(i, { instant: true }); }
      };
    });
  }

  /**
   * Chapters of the open note when its PDF has no bookmarks: from the cache, or found once. The
   * search keeps going when the sheet closes (only another note stops it), so a long book isn't
   * started over each time; onProgress(i, n) reports pages read.
   */
  async autoTocFor(onProgress) {
    const meta = this.meta;
    const gen = this.gen;
    // The version also counts the pages whose handwriting has been read so far, so the list is
    // made again as recognition goes on.
    const ink = ocrOn() ? await loadOcr(meta.id, meta.modifiedTime) : null;
    if (gen !== this.gen) return null;
    const version = (meta.modifiedTime || '') + (ocrOn() ? '+ink' + doneCount(ink) : '');
    if (this.autoToc && this.autoToc.version === version) return this.autoToc.items;
    const running = this.autoTocJob;
    if (running && running.version === version && running.gen === gen) { running.onProgress = onProgress; return running.promise; }
    if (running) running.cancelled = true; // an older version: one scan at a time
    const key = 'toc:' + meta.id;
    const job = { version, gen, onProgress, cancelled: false };
    job.promise = (async () => {
      try {
        const rec = await idb.get('texts', key);
        if (rec && rec.version === version) return rec.items;
      } catch { /* not cached */ }
      let items;
      try {
        items = await detectToc(this.doc, { ink, onProgress: (i, n) => job.onProgress && job.onProgress(i, n), isCancelled: () => gen !== this.gen || job.cancelled });
      } catch (e) {
        console.warn('auto contents', e);
        return []; // shown as "none found", not remembered: a passing failure tries again
      }
      if (items && !meta.preview) idb.put('texts', key, { version, items }).catch(() => {});
      return items;
    })().then((items) => {
      if (this.autoTocJob === job) this.autoTocJob = null;
      if (items && gen === this.gen) this.autoToc = { version, items };
      return items;
    });
    this.autoTocJob = job;
    return job.promise;
  }

  async renderAutoToc(body, stale) {
    let status = null;
    const items = await this.autoTocFor((i, n) => {
      if (stale()) return;
      if (!status) { // one live region, updated in place
        body.innerHTML = '<div class="empty small"><div class="spinner"></div><p role="status"></p></div>';
        status = $('p', body);
      }
      status.textContent = t('autoTocFinding', { i, n });
    });
    if (!items || stale()) return;
    if (!items.length) {
      body.innerHTML = `<div class="empty small"><span data-icon="outline"></span><b>${t('noOutlineTitle')}</b><p>${t('noOutlineText')}</p><p>${esc(t('autoTocNone'))}</p></div>`;
      hydrateIcons(body);
      return;
    }
    body.innerHTML = `<p class="small pad autotoc-note">${esc(t('autoTocNote'))}</p>
      <div class="glist outline">${items.map((r, k) => `
      <button class="glist-row" data-k="${k}" style="padding-left:${16 + r.level * 18}px" aria-label="${esc(r.title)}, ${esc(t('pageN', { n: r.page + 1 }))}">
        <span class="glist-label">${esc(r.title)}</span>
        <span class="glist-value">${r.page + 1}</span>
      </button>`).join('')}</div>`;
    $$('.glist-row', body).forEach((b) => {
      b.onclick = () => { this.closeSheet(); this.goToPage(items[+b.dataset.k].page, { instant: true }); };
    });
  }

  // ------------------------------------------------------------------ search
  openSearch() {
    if (!this.doc) return;
    this.setBarsHidden(false);
    this.searchBar.hidden = false;
    $('.vbar-row', this.root).hidden = true;
    this.searchInput.value = this.lastQuery || '';
    this.searchInput.focus();
    this.updateSearchNav();
  }

  closeSearch() {
    this.searchBar.hidden = true;
    this.searchResults.hidden = true;
    $('.vbar-row', this.root).hidden = false;
    this.hits = null;
    this.clearHighlight();
  }

  async runSearch(q) {
    q = q.trim();
    this.lastQuery = q;
    this.clearHighlight();
    if (!q) { this.searchResults.hidden = true; this.hits = null; this.updateSearchNav(); return; }
    this.searchResults.hidden = false;
    const gen = this.gen;
    if (!this.texts) {
      this.searchResults.innerHTML = '<div class="sr-empty"><div class="spinner"></div></div>';
      let texts;
      try {
        texts = await extractText(this.doc);
      } catch (e) {
        if (gen === this.gen) { this.searchResults.hidden = true; console.warn(e); }
        return; // the note was closed or replaced while reading its text
      }
      if (gen !== this.gen) return;
      this.texts = texts;
    }
    if (ocrOn() && !this.ocrLoaded && this.meta) {
      this.ocrLoaded = true;
      this.ocr = await loadOcr(this.meta.id, this.meta.modifiedTime);
      if (gen !== this.gen) return;
    }
    if (q !== this.lastQuery) return; // typed on meanwhile
    this.hitIndex = -1;
    this.renderHits(q);
    if (ocrOn()) this.startOcr();
  }

  /**
   * Matches in the text layer and in the recognized handwriting (spaces and case ignored). Per
   * page the handwriting matches win when there are at least as many: they can be highlighted.
   */
  renderHits(q) {
    const hits = [];
    this.texts.forEach((text, i) => {
      const fromText = findAll(text, q).map((m) => ({ page: i, text, ...m }));
      const ink = this.ocr && this.ocr.pages[i];
      const fromInk = ink && ink.t ? findAll(ink.t, q).map((m) => ({ page: i, text: ink.t, box: boxFor(ink, m.at, m.end), ...m })) : [];
      hits.push(...(fromInk.length && fromInk.length >= fromText.length ? fromInk : fromText));
    });
    this.hits = hits;
    if (this.hitIndex >= hits.length) this.hitIndex = -1;
    this.updateSearchNav();
    if (this.restricted() && !hits.length) {
      // (a distribution document has no text to search, and its pages aren't read out by hand)
      this.searchResults.innerHTML = `<div class="sr-empty">${t('noResults', { q: esc(q) })}<small>${esc(t('restrictedSearch'))}</small></div>`;
      return;
    }
    const n = this.pages.length;
    const done = this.meta && this.meta.preview ? n : doneCount(this.ocr); // (a preview's handwriting isn't read)
    let status = '';
    if (ocrOn() && done < n && this.ocrError) status = `<div class="sr-ocr" role="status">${esc(t('ocrFailed'))}</div>`;
    else if (ocrOn() && done < n) status = `<div class="sr-ocr" role="status"><div class="spinner sm"></div>${esc(this.ocrWaiting ? t('ocrPreparing') : t('ocrProgress', { i: done, n }))}</div>`;
    else if (!ocrOn() && ocrSupported()) status = `<button class="sr-ocr on" data-act="ocr-enable">${icon('pen')}<span>${esc(t('ocrEnable'))}</span></button>`;
    if (this.meta && this.meta.preview) status = ocrSupported() ? `<div class="sr-ocr">${esc(t('previewOcrLater'))}</div>` : '';
    if (!hits.length) {
      this.searchResults.innerHTML = `<div class="sr-empty">${t('noResults', { q: esc(q) })}${ocrOn() || (this.meta && this.meta.preview) ? '' : `<small>${t('handwritingNote')}</small>`}</div>${status}`;
      return;
    }
    const line = (s) => esc(s.replace(/\s+/g, ' '));
    this.searchResults.innerHTML = `<div class="sr-head">${t('nResults', { n: hits.length })}</div>${status}` + hits.slice(0, 300).map((h, k) => `
      <button class="sr-row" data-k="${k}"><b>${t('pageN', { n: h.page + 1 })}${h.box ? ` <i>${icon('pen')}</i><span class="sr-only">${esc(t('ocrInk'))}</span>` : ''}</b>
      <span>…${line(h.text.slice(Math.max(0, h.at - 24), h.at))}<mark>${line(h.text.slice(h.at, h.end))}</mark>${line(h.text.slice(h.end, h.end + 40))}…</span></button>`).join('');
    $$('.sr-row', this.searchResults).forEach((b) => {
      b.onclick = () => this.gotoHit(+b.dataset.k);
    });
  }

  /** Recognize the pages not read yet, refreshing the results as pages come in. */
  startOcr() {
    if (this.meta && this.meta.preview) return; // (read once it is in the library)
    if (this.ocrRunning || !this.doc || !this.meta || doneCount(this.ocr) >= this.pages.length) return;
    if (this.restricted()) return; // (its text isn't read out, by hand or otherwise)
    const gen = this.gen;
    const meta = this.meta;
    this.ocrRunning = true;
    this.ocrError = '';
    let timer;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (gen === this.gen && this.lastQuery && !this.searchBar.hidden) this.renderHits(this.lastQuery);
      }, 250);
    };
    indexDoc({
      id: meta.id,
      modifiedTime: meta.modifiedTime,
      doc: this.doc,
      texts: this.texts,
      isCancelled: () => gen !== this.gen || this.searchBar.hidden,
      onWait: () => { if (!this.ocrWaiting) { this.ocrWaiting = true; refresh(); } },
      onPage: (rec) => {
        if (gen !== this.gen) return;
        this.ocr = rec;
        this.ocrWaiting = false;
        refresh();
      },
    }).catch((e) => {
      if (gen !== this.gen || e.message === 'cancelled') return;
      console.warn('handwriting recognition failed', e);
      this.ocrError = String(e.message || e);
    }).finally(() => {
      if (gen !== this.gen) return;
      this.ocrRunning = false;
      refresh();
    });
  }

  async enableOcr() {
    const ok = await dialog({ title: t('ocrTitle'), message: t('ocrExplain'), okText: t('ocrTurnOn') });
    if (!ok) return;
    saveSettings({ ocr: true });
    this.runSearch(this.searchInput.value);
  }

  gotoHit(k) {
    if (!this.hits || !this.hits.length) return;
    this.hitIndex = (k + this.hits.length) % this.hits.length;
    this.searchResults.hidden = true;
    this.searchInput.blur();
    const h = this.hits[this.hitIndex];
    const p = this.pages[h.page];
    if (h.box && !this.single && p) {
      // Bring the highlighted lines (not just the top of the page) into view; an earlier jump no longer applies.
      this.pendingPage = null;
      this.scroller.scrollTo({ top: Math.max(0, p.top + h.box[1] * p.height - this.scroller.clientHeight * 0.3), behavior: scrollBehavior() });
    } else {
      this.goToPage(h.page);
    }
    this.showHighlight(h);
    this.updateSearchNav();
  }

  showHighlight(h) {
    this.clearHighlight();
    const p = this.pages[h.page];
    if (!h.box || !p || !p.el) return;
    const [x, y, w, hh] = h.box;
    const el = document.createElement('div');
    el.className = 'ocr-hl';
    const pct = (v) => (v * 100).toFixed(2) + '%';
    el.style.cssText = `left:${pct(x - 0.006)};top:${pct(y - 0.004)};width:${pct(w + 0.012)};height:${pct(hh + 0.008)}`;
    p.el.appendChild(el);
    this.hlEl = el;
  }

  clearHighlight() {
    if (this.hlEl) this.hlEl.remove();
    this.hlEl = null;
  }

  updateSearchNav() {
    const c = $('.vsearch-count', this.root);
    if (!this.hits) c.textContent = '';
    else if (!this.hits.length) c.textContent = '0';
    else c.textContent = this.hitIndex >= 0 ? `${this.hitIndex + 1}/${this.hits.length}` : `${this.hits.length}`;
  }

  // ------------------------------------------------------------------ events
  bindEvents() {
    this.scroller.addEventListener('scroll', () => this.scheduleUpdate(), { passive: true });
    this.scroller.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    this.scroller.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    this.scroller.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    this.scroller.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
    // desktop: ctrl/⌘ + wheel or trackpad pinch
    // the reader scrolling by wheel, mouse or scrollbar takes over from a jump under way, as a touch does
    this.scroller.addEventListener('pointerdown', () => { this.pendingPage = null; });
    this.scroller.addEventListener('wheel', (e) => {
      this.pendingPage = null;
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const f = this.localPoint(e.clientX, e.clientY);
      this.applyZoom(this.zoom * Math.exp(-e.deltaY * 0.01), f.x, f.y);
    }, { passive: false });
    // Writing is saved a moment after each change; going to the background or closing saves it now.
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.cancelStroke(); this.flushInk(); } });
    window.addEventListener('pagehide', () => { this.cancelStroke(); this.flushInk({ now: true }); });
    window.addEventListener('storage', (e) => {
      if (e.key === 'gnv.inkGen') { this.dropInk(); return; }
      if (e.key !== INK_SAVED || !this.meta || !this.inkPages || this.stroke) return;
      let v = null;
      try { v = JSON.parse(e.newValue || 'null'); } catch { /* */ }
      // (with changes of its own not yet saved, this tab's save comes after and keeps them)
      if (v && v.id === this.meta.id && this.inkRev === this.inkSavedRev && !this.inkTimer) this.inkLoading = this.loadInkFor(this.meta, this.gen);
    });
    this.scroller.addEventListener('pointerdown', (e) => this.inkDown(e));
    this.scroller.addEventListener('pointermove', (e) => this.inkMove(e));
    this.scroller.addEventListener('pointerup', (e) => this.inkUp(e));
    this.scroller.addEventListener('pointercancel', () => this.cancelStroke());
    this.inkBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ink]');
      if (b) this.setInkTool({ tool: b.dataset.ink });
    });
    this.scroller.addEventListener('click', (e) => {
      if (this.inking) return;
      if (Date.now() - (this.lastTouch || 0) < 800 || e.target.closest('.plink') || e.detail > 1) return;
      clearTimeout(this.tapTimer);
      const edge = this.edgeTap(e.clientX);
      if (edge) { this.flip(edge); return; }
      this.tapTimer = setTimeout(() => this.onSingleTap(), 280);
    });
    this.scroller.addEventListener('dblclick', (e) => {
      if (this.inking) return;
      clearTimeout(this.tapTimer);
      if (e.target.closest('.plink')) return;
      const f = this.localPoint(e.clientX, e.clientY);
      this.animateZoom(this.zoom > 1.05 ? 1 : 2.2, f.x, f.y);
    });
    this.scrollerTop = this.scroller.getBoundingClientRect().top;
    new ResizeObserver(() => {
      const newTop = this.scroller.getBoundingClientRect().top;
      const moved = newTop - this.scrollerTop;
      this.scrollerTop = newTop;
      if (!this.pages.length || this.pinch) return;
      const target = this.pendingPage && Date.now() < this.pendingPage.until ? this.pendingPage.i : null;
      const mode = this.modeKey();
      const heightFits = this.single || this.fitsHeight(); // layouts that depend on the screen height
      const heightChanged = this.scroller.clientHeight !== this.layoutHeight;
      if (mode !== this.layoutMode || (this.single && this.scroller.clientWidth !== this.layoutWidth)
        || (heightFits && heightChanged && this.zoom <= 1.001)) {
        // One page per screen / fit to height: the pages follow the screen size (rotation, bars
        // hidden or shown). While zoomed in, a height change leaves the zoom alone.
        this.relayoutAt(Math.max(0, target ?? this.current));
        return;
      }
      if (target != null) { // a jump under way: land it (laid out again first if the width changed)
        if (this.scroller.clientWidth !== this.layoutWidth) this.layout();
        this.goToPage(target, { instant: true });
        return;
      }
      if (this.scroller.clientWidth === this.layoutWidth) {
        // Only the height changed (menu bar hidden/shown, keyboard): keep the pages still on screen.
        if (moved) this.scroller.scrollTop += moved;
        this.scheduleUpdate();
        return;
      }
      // Width changed (rotation): keep the same spot of the same page in view.
      const i = this.pageAt(this.scroller.scrollTop);
      const p = this.pages[i];
      const frac = p.height ? (this.scroller.scrollTop - p.top) / p.height : 0;
      this.layout();
      this.scroller.scrollTop = p.top + frac * p.height;
      this.scheduleUpdate();
    }).observe(this.scroller);

    this.pill.onclick = () => this.askPage();
    this.scrubLabel.onclick = () => this.askPage();
    this.scrub.addEventListener('input', () => this.onScrubInput());
    this.scrub.addEventListener('change', () => this.onScrubEnd());
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'back') this.onBack();
      else if (act === 'thumbs') this.openSheet('thumbs');
      else if (act === 'thumbs-close') this.closeSheet();
      else if (act === 'pick-start') { if (this.restricted()) toast(t('restrictedDoc'), { duration: 6000 }); else this.setPicking(true); }
      else if (act === 'pick-all') this.pickAll();
      else if (act === 'pick-cancel') this.setPicking(false);
      else if (act === 'pick-export') this.openExport();
      else if (act === 'bookmark') this.toggleBookmark();
      else if (act === 'menu') this.openMenu();
      else if (act === 'search') this.openSearch();
      else if (act === 'search-close') this.closeSearch();
      else if (act === 'search-next') this.gotoHit(this.hitIndex + 1);
      else if (act === 'search-prev') this.gotoHit(this.hitIndex - 1);
      else if (act === 'ocr-enable') this.enableOcr();
      else if (act === 'ink') this.setInking(true);
      else if (act === 'preview-add') { if (this.onAddPreview) this.onAddPreview(); }
      else if (act === 'ink-done') this.setInking(false);
      else if (act === 'ink-undo') this.inkStep(true);
      else if (act === 'ink-redo') this.inkStep(false);
      else if (act === 'ink-style') this.openInkStyle();
    });
    $$('.seg button', this.sheet).forEach((b) => { b.onclick = () => this.showSheetTab(b.dataset.seg); });
    this.bindPickDrag();
    let searchTimer;
    this.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.runSearch(this.searchInput.value), 250);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); this.runSearch(this.searchInput.value).then(() => this.gotoHit(0)); }
    });
    this.searchInput.addEventListener('focus', () => { if (this.hits) this.searchResults.hidden = false; });
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.target.matches('input') || document.querySelector('#overlay .ov')) return;
      if (this.inking) {
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Escape' && this.sheet.hidden && this.searchBar.hidden) { this.setInking(false); e.preventDefault(); return; }
        if (mod && (e.key === 'z' || e.key === 'Z')) { this.inkStep(!e.shiftKey); e.preventDefault(); return; }
        if (mod && (e.key === 'y' || e.key === 'Y')) { this.inkStep(false); e.preventDefault(); return; }
      }
      // The browser's own scrolling keys take over from a jump under way (as touch, wheel and mouse do).
      if (['ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) this.pendingPage = null;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { this.flip(1); e.preventDefault(); } // a whole spread
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { this.flip(-1); e.preventDefault(); }
      if (e.key === 'f') this.setBarsHidden(!this.barsHidden);
      if (e.key === 'Escape') {
        if (this.barsHidden) this.setBarsHidden(false);
        else if (this.picking && !this.sheet.hidden) this.setPicking(false);
        else if (!this.handleBack()) this.onBack(); // close the sheet/search first, then the note
      }
    });
  }

  openMenu() {
    if (!this.meta) return;
    const extra = this.onMenu ? this.onMenu(this.meta) : [];
    const pv = !!this.meta.preview;
    actionSheet({
      title: this.meta.name,
      subtitle: joinList([this.pages.length ? t('menuSubtitle', { n: this.pages.length, cur: this.current + 1 }) : '', this.restricted() && t('restrictedInfo')]),
      items: [
        ...(pv ? extra : []), // (a preview: "Add to Note Viewer" first)
        { label: t('goToPageMenu'), icon: 'page', onClick: () => this.askPage() },
        { label: t('showPageList'), icon: 'grid', onClick: () => this.openSheet('thumbs') },
        ...(pv ? [] : [{ label: t('inkMode'), icon: 'pen', onClick: () => this.setInking(true) }]),
        this.single
          ? { label: t('scrollView'), icon: 'docs', onClick: () => this.setMode('scroll') }
          : { label: t('singlePageView'), icon: 'page', onClick: () => this.setMode('single') },
        ...(!this.single && window.innerWidth > window.innerHeight
          ? [settings.fitHeightLandscape
            ? { label: t('fitWidth'), icon: 'zoomFit', onClick: () => this.setFitHeight(false) }
            : { label: t('fitHeight'), icon: 'zoomFit', onClick: () => this.setFitHeight(true) }]
          : []),
        ...(this.pages.length > 1 && this.scroller.clientWidth >= 480
          ? [this.per === 2
            ? { label: t('spreadOffMenu'), icon: 'page', onClick: () => this.setSpread(false) }
            : { label: t('spreadOnMenu'), icon: 'spread', onClick: () => this.setSpread(true) }]
          : []),
        this.pageDark()
          ? { label: t('pageLightMenu'), icon: 'moon', onClick: () => this.setPageDark(false) }
          : { label: t('pageDarkMenu'), icon: 'moon', onClick: () => this.setPageDark(true) },
        ...(this.changed && this.changed.size
          ? [{ label: t('changedMenu', { n: this.changed.size }), icon: 'page', onClick: () => this.listChanged() }]
          : []),
        { label: t('resetZoom'), icon: 'zoomFit', disabled: this.zoom === 1, onClick: () => this.resetZoom() },
        ...(pv ? [] : extra),
        { label: t('savePdf'), icon: 'download', disabled: !this.blob, onClick: () => this.savePdf() },
        { label: t('info'), icon: 'info', onClick: () => this.showInfo() },
      ],
    });
  }

  // ------------------------------------------------------------------ changed pages
  /** Pages marked as changed in this version (found when it was first opened). */
  // ------------------------------------------------------------------ handwriting (kept on this device)
  /** The note's handwriting, after any save still under way (a newer version reopening the note). */
  async loadInkFor(meta, gen) {
    if (this.inkSaving) await this.inkSaving.catch(() => {});
    const inkGen = inkGeneration();
    const rec = await loadInk(meta.id);
    if (gen !== this.gen) return;
    this.inkPages = rec.pages;
    this.inkGen = inkGen;
    this.inkLost = rec.lost || [];
    this.inkUndo = [];
    this.inkRedo = [];
    this.inkRev = this.inkSavedRev = 0;
    for (const n of Object.keys(this.inkPages)) this.renderInk(+n - 1);
    this.updateInkBar();
  }

  inkOn(n) {
    const e = this.inkPages && this.inkPages[n];
    return e && e.s.length ? e.s : null;
  }

  strokeSvg(st) {
    const hl = st.k === 'hl';
    const c = (hl ? HL_COLORS : PEN_COLORS)[st.c] ? st.c : hl ? 'y' : 'k';
    return `<path class="${hl ? 'hl' : 'pn'} c-${c}" stroke-width="${Number(st.w) || 1}" d="${pathD(st.p)}"/>`;
  }

  /** The page's handwriting layer (made when needed). */
  inkSvg(p) {
    let svg = p.el.querySelector('svg.ink');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ink');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('preserveAspectRatio', 'none');
      p.el.insertBefore(svg, p.el.querySelector('.chg-tag'));
    }
    svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
    return svg;
  }

  renderInk(i) {
    const p = this.pages[i];
    if (!p || !p.el) return;
    const strokes = this.inkOn(i + 1);
    if (!strokes && !(this.stroke && this.stroke.p === p && this.stroke.path)) { const old = p.el.querySelector('svg.ink'); if (old) old.remove(); return; }
    if (!strokes) { this.inkSvg(p).replaceChildren(this.stroke.path); return; }
    const svg = this.inkSvg(p);
    svg.innerHTML = strokes.map((st) => this.strokeSvg(st)).join('');
    // (a stroke being drawn on this page stays in view)
    if (this.stroke && this.stroke.p === p && this.stroke.path) svg.appendChild(this.stroke.path);
  }

  /** Fingers draw too, unless a stylus was seen on this device (then they move the page). */
  fingerDraws() {
    const f = settings.inkFinger;
    return f === 'on' || (f !== 'off' && !kv.get('penSeen', false));
  }

  notePen() {
    if (kv.get('penSeen', false)) return;
    kv.set('penSeen', true);
    if (settings.inkFinger !== 'on' && settings.inkFinger !== 'off') toast(t('inkPenFound'), { duration: 6000 });
  }

  inkTool() {
    const s = kv.get('inkTool', {});
    const tool = ['pen', 'hl', 'eraser'].includes(s.tool) ? s.tool : 'pen';
    const draw = tool === 'eraser' ? (s.last === 'hl' ? 'hl' : 'pen') : tool; // what the colour button sets
    return {
      tool,
      draw,
      c: draw === 'hl' ? (HL_COLORS[s.hc] ? s.hc : 'y') : (PEN_COLORS[s.pc] ? s.pc : 'k'),
      size: draw === 'hl' ? (s.hs ? 1 : 0) : (s.ps ? 1 : 0),
    };
  }

  setInkTool(patch) {
    const s = Object.assign({}, kv.get('inkTool', {}), patch);
    if (patch.tool && patch.tool !== 'eraser') s.last = patch.tool;
    kv.set('inkTool', s);
    this.updateInkBar();
  }

  setInking(on) {
    if (on && this.meta && this.meta.preview) { toast(t('previewAddFirst')); return; }
    on = !!on && !!this.doc;
    if (on === !!this.inking) return;
    this.cancelStroke();
    this.inking = on;
    this.root.classList.toggle('inking', on);
    this.inkBar.hidden = !on;
    if (on) {
      this.setBarsHidden(false);
      this.closeSearch();
      this.updateInkBar();
      if (!kv.get('inkHintShown', false)) {
        kv.set('inkHintShown', true);
        toast(t('inkHint', { how: t(this.fingerDraws() ? 'inkHowFinger' : 'inkHowPen') }), { duration: 7000 });
      }
      const b = $('[data-ink].on', this.inkBar) || $('[data-ink]', this.inkBar);
      if (b && document.activeElement && this.root.contains(document.activeElement)) b.focus({ preventScroll: true });
    } else {
      this.flushInk();
      const pen = $('.vdock [data-act="ink"]', this.root);
      if (pen && this.inkBar.contains(document.activeElement)) pen.focus({ preventScroll: true });
    }
  }

  updateInkBar() {
    if (!this.inkBar) return;
    const tl = this.inkTool();
    $$('[data-ink]', this.inkBar).forEach((b) => {
      const on = b.dataset.ink === tl.tool;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const hl = tl.draw === 'hl';
    const sw = $('.inkcolor', this.inkBar);
    if (sw) {
      sw.style.setProperty('--sw', (hl ? HL_COLORS : PEN_COLORS)[tl.c]);
      sw.setAttribute('aria-label', `${t('inkStyle')}: ${t((hl ? HL_NAMES : PEN_NAMES)[tl.c])}`);
    }
    const u = $('[data-act="ink-undo"]', this.inkBar);
    const r = $('[data-act="ink-redo"]', this.inkBar);
    const focused = document.activeElement;
    if (u) u.disabled = !this.inkUndo || !this.inkUndo.length;
    if (r) r.disabled = !this.inkRedo || !this.inkRedo.length;
    // A button that just turned itself off had the focus: give it to its partner, or the tool.
    if (focused && focused.disabled && this.inkBar.contains(focused)) {
      const other = focused === u ? r : u;
      (other && !other.disabled ? other : $('[data-ink].on', this.inkBar) || this.inkBar).focus({ preventScroll: true });
    }
  }

  /** A point of the pointer on the stroke's page, in the page's own units. */
  inkPoint(s, e) {
    const r = s.rect;
    return {
      x: clamp((e.clientX - r.left) / r.width, 0, 1) * s.p.w,
      y: clamp((e.clientY - r.top) / r.height, 0, 1) * s.p.h,
    };
  }

  inkDown(e) {
    if (!this.inking || !this.inkPages || this.pinch || this.stroke) return;
    if (e.pointerType === 'pen') this.notePen();
    const finger = e.pointerType === 'touch';
    if (finger && (!this.fingerDraws() || !e.isPrimary)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target.closest && e.target.closest('.page');
    const p = el && this.pages[+el.dataset.i];
    if (!p || p.el !== el) return;
    e.preventDefault();
    if (!finger) try { this.scroller.setPointerCapture(e.pointerId); } catch { /* fine without */ }
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const tl = this.inkTool();
    const s = { id: e.pointerId, p, finger, rect, unit: p.w / rect.width };
    // A stylus's eraser end (or its side button held) erases, whatever tool is chosen.
    const penErase = e.pointerType === 'pen' && (e.buttons & 32 || e.buttons & 2);
    if (tl.tool === 'eraser' || penErase) {
      s.erase = [];
      this.stroke = s;
      this.eraseAt(s, this.inkPoint(s, e));
      return;
    }
    const pt = this.inkPoint(s, e);
    s.st = { k: tl.draw === 'hl' ? 'hl' : 'pen', c: tl.c, w: strokeWidth(tl.draw, tl.size, p.w), p: [pt.x, pt.y] };
    const svg = this.inkSvg(p);
    svg.insertAdjacentHTML('beforeend', this.strokeSvg(s.st));
    s.path = svg.lastElementChild;
    this.stroke = s;
  }

  inkMove(e) {
    const s = this.stroke;
    if (!s || e.pointerId !== s.id) return;
    e.preventDefault();
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const r = s.p.el.getBoundingClientRect();
    if (r.width && r.height) s.rect = r;
    for (const ev of evs.length ? evs : [e]) {
      const pt = this.inkPoint(s, ev);
      if (s.erase) { this.eraseAt(s, pt); continue; }
      const p = s.st.p;
      if (p.length >= MAX_POINTS * 2) break; // a very long stroke stops growing
      // Points closer than half a screen pixel add nothing.
      if (Math.hypot(pt.x - p[p.length - 2], pt.y - p[p.length - 1]) < s.unit * 0.5) continue;
      p.push(pt.x, pt.y);
    }
    if (s.st) s.path.setAttribute('d', pathD(s.st.p));
  }

  inkUp(e) {
    const s = this.stroke;
    if (!s || e.pointerId !== s.id) return;
    this.stroke = null;
    const n = s.p.i + 1;
    if (s.erase) {
      if (s.erase.length) this.pushInkOp({ op: 'erase', n, items: s.erase });
      return;
    }
    s.st.p = s.st.p.map((v) => Math.round(v * 10) / 10);
    const cur = this.meta && this.meta.modifiedTime;
    const e2 = this.inkPages[n] || (this.inkPages[n] = { v: cur, s: [] });
    // (writing from an older version of the note on the same page keeps that version: it may still
    // move to another page when the newer version's pages are lined up, this stroke won't)
    if (!e2.s.length) e2.v = cur; else if (e2.v !== cur) s.st.v = cur;
    e2.s.push(s.st);
    s.path.setAttribute('d', pathD(s.st.p));
    this.pushInkOp({ op: 'add', n, st: s.st });
  }

  /** A stroke stopped (a second finger came: that's a pinch), or the eraser let go. */
  cancelStroke() {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    if (s.erase) { if (s.erase.length) this.pushInkOp({ op: 'erase', n: s.p.i + 1, items: s.erase }); return; }
    if (s.path) s.path.remove();
  }

  eraseAt(s, pt) {
    const n = s.p.i + 1;
    const e = this.inkPages[n];
    if (!e || !e.s.length) return;
    const rad = 12 * s.unit; // 12 screen pixels around the finger or pen
    let hit = false;
    for (let k = e.s.length - 1; k >= 0; k--) {
      if (strokeHits(e.s[k], pt.x, pt.y, rad)) { s.erase.push({ st: e.s[k], at: k }); e.s.splice(k, 1); hit = true; }
    }
    if (hit) this.renderInk(s.p.i);
  }

  pushInkOp(op) {
    this.inkUndo.push(op);
    if (this.inkUndo.length > 200) this.inkUndo.shift();
    this.inkRedo = [];
    this.inkChanged(op.n);
  }

  inkChanged(n) {
    this.inkRev = (this.inkRev || 0) + 1;
    if (this.thumbCache) this.thumbCache.delete(n);
    this.updateInkBar();
    clearTimeout(this.inkTimer);
    this.inkTimer = setTimeout(() => this.flushInk(), 600);
  }

  /** Undo (back = true) or redo the last change. */
  inkStep(back) {
    if (this.stroke) return;
    const op = (back ? this.inkUndo : this.inkRedo).pop();
    if (!op) return;
    const e = this.inkPages[op.n] || (this.inkPages[op.n] = { v: this.meta && this.meta.modifiedTime, s: [] });
    const remove = (op.op === 'add') === back; // undoing an addition, or redoing an erasure
    if (op.op === 'add') {
      if (remove) { const k = e.s.indexOf(op.st); if (k >= 0) e.s.splice(k, 1); } else e.s.push(op.st);
    } else if (remove) {
      for (const it of op.items) { const k = e.s.indexOf(it.st); if (k >= 0) e.s.splice(k, 1); }
    } else {
      for (let j = op.items.length - 1; j >= 0; j--) e.s.splice(Math.min(op.items[j].at, e.s.length), 0, op.items[j].st);
    }
    (back ? this.inkRedo : this.inkUndo).push(op);
    this.renderInk(op.n - 1);
    this.inkChanged(op.n);
    // Show where it happened.
    if (op.n - 1 < this.first || op.n - 1 > this.last) this.goToPage(op.n - 1);
  }

  /** Save now (a pending save, or when leaving the note). `now`: the page is going away. */
  flushInk({ now = false } = {}) {
    clearTimeout(this.inkTimer);
    this.inkTimer = 0;
    if (this.meta && this.meta.preview) return this.inkSaving || Promise.resolve(true);
    const id = this.meta && this.meta.id;
    if (!id || !this.inkPages) return this.inkSaving || Promise.resolve();
    const snap = () => {
      const out = {};
      for (const [n, e] of Object.entries(this.inkPages)) out[n] = { v: e.v, s: e.s.slice() };
      return out;
    };
    // The page going away cuts off a database save under way (this one or an earlier one): keep a
    // copy at once whenever this note's writing changed since it was opened.
    const lost = (this.inkLost || []).slice();
    const gen = this.inkGen;
    // (nothing changed since the last finished save, and none under way: nothing to keep)
    if (now && this.inkRev > 0 && (this.inkRev !== this.inkSavedRev || this.inkInFlight > 0)) journalInk(id, snap(), lost, nextToken(), gen);
    if (this.inkRev === this.inkSavedRev) return this.inkSaving || Promise.resolve(true);
    const snapshot = snap();
    const token = nextToken();
    this.inkSavedRev = this.inkRev;
    const prev = this.inkSaving || Promise.resolve();
    // Resolves to whether it was saved (not after "delete all writing", not on a failure).
    this.inkInFlight = (this.inkInFlight || 0) + 1;
    this.inkSaving = prev.catch(() => {}).then(() => saveInk(id, snapshot, lost, token, gen)).finally(() => { this.inkInFlight--; }).catch((err) => {
      console.warn('ink save failed', err);
      this.inkSavedRev = -1; // tried again with the next change or when leaving the note
      toast(t('inkSaveFailed'), { duration: 6000 });
      return false;
    });
    return this.inkSaving;
  }

  /** Colour, width and how fingers work: a small sheet. */
  openInkStyle() {
    const tl = this.inkTool();
    const hl = tl.draw === 'hl';
    const colors = hl ? HL_COLORS : PEN_COLORS;
    const NAME = hl ? HL_NAMES : PEN_NAMES;
    // A toast over the sheet would cover (and catch taps meant for) its switch.
    const tst = document.getElementById('toast');
    if (tst) tst.classList.remove('show');
    const html = `
      <div class="asheet xsheet inksheet" role="dialog" aria-labelledby="inkst-t">
        <div class="asheet-head"><b id="inkst-t">${esc(t('inkStyle'))}</b><small>${esc(t(hl ? 'inkHighlighter' : 'inkPen'))}</small></div>
        <div class="xrow"><span class="xlabel" id="inkst-c">${esc(t('inkColor'))}<small class="inkst-name"></small></span>
          <div class="swatches" role="group" aria-labelledby="inkst-c">${Object.entries(colors).map(([k, v]) => `<button data-c="${k}" aria-pressed="${k === tl.c}" aria-label="${esc(t(NAME[k]))}" style="--sw:${v}"></button>`).join('')}</div>
        </div>
        <div class="xrow"><span class="xlabel">${esc(t('inkWidth'))}</span>
          <div class="seg" data-x="size"><button data-v="0">${esc(t('inkThin'))}</button><button data-v="1">${esc(t('inkThick'))}</button></div>
        </div>
        <label class="xrow"><span class="xlabel">${esc(t('inkFinger'))}<small>${esc(t('inkFingerSub'))}</small></span><input type="checkbox" class="switch" data-x="finger"${this.fingerDraws() ? ' checked' : ''}></label>
        <button class="xrow inkclear" data-x="clear"${this.inkOn(this.current + 1) ? '' : ' disabled'}><span class="xlabel">${esc(t('inkClearPage'))}</span></button>
        <div class="xbtns"><button class="strong" data-x="done">${esc(t('done'))}</button></div>
      </div>`;
    const { wrap, close } = mountOverlay(html, 'ov-sheet');
    const refresh = () => {
      const cur = this.inkTool();
      $$('.swatches button', wrap).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === cur.c)));
      wrap.querySelector('.inkst-name').textContent = t(NAME[cur.c]);
      $$('[data-x=size] button', wrap).forEach((b) => {
        const on = +b.dataset.v === cur.size;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    };
    refresh();
    const key = hl ? 'h' : 'p';
    $$('.swatches button', wrap).forEach((b) => {
      b.onclick = () => { this.setInkTool({ [key + 'c']: b.dataset.c, tool: tl.draw }); refresh(); };
    });
    $$('[data-x=size] button', wrap).forEach((b) => {
      b.onclick = () => { this.setInkTool({ [key + 's']: +b.dataset.v, tool: tl.draw }); refresh(); };
    });
    wrap.querySelector('[data-x=finger]').onchange = (ev) => saveSettings({ inkFinger: ev.target.checked ? 'on' : 'off' });
    wrap.querySelector('[data-x=clear]').onclick = () => { close(); this.clearPageInk(this.current + 1); };
    wrap.querySelector('[data-x=done]').onclick = close;
    wrap.querySelector('.ov-backdrop').onclick = close;
  }

  async clearPageInk(n) {
    const e = this.inkPages && this.inkPages[n];
    if (!e || !e.s.length) return;
    const ok = await dialog({ title: t('inkClearPage'), message: t('inkClearPageMsg', { n }), okText: t('inkEraseOk'), danger: true });
    if (!ok || this.inkPages[n] !== e) return;
    const items = e.s.map((st, at) => ({ st, at })).reverse();
    e.s = [];
    this.renderInk(n - 1);
    this.pushInkOp({ op: 'erase', n, items });
  }

  /** Every note's handwriting was deleted (Settings). */
  dropInk() {
    this.cancelStroke();
    this.inkGen = inkGeneration();
    clearTimeout(this.inkTimer);
    this.inkTimer = 0;
    if (!this.inkPages) return;
    this.inkPages = {};
    this.inkLost = [];
    this.inkUndo = [];
    this.inkRedo = [];
    this.inkSavedRev = this.inkRev; // (nothing left to save)
    for (const el of $$('svg.ink', this.pagesEl)) el.remove();
    if (this.thumbCache) this.thumbCache.clear();
    this.updateInkBar();
  }

  /**
   * A newer version of the note: handwriting written on the version before follows its page
   * (`follow`: for each old page index, {to, changed} or null; see pagediff.followPages). Writing on
   * an edited page goes along and the reader is told; writing on a page taken out is kept aside
   * (not shown, deleted with all writing).
   */
  async remapInk(meta, prevVersion, follow, gen) {
    if (gen === this.gen && this.inkLoading) await this.inkLoading.catch(() => {});
    let live = gen === this.gen && this.meta && this.meta.id === meta.id && this.inkPages;
    let pages;
    let lost;
    if (live) {
      await this.flushInk();
      live = gen === this.gen && this.inkPages;
      pages = this.inkPages;
      lost = this.inkLost || [];
    }
    if (!live) {
      // (the note isn't open, or was closed meanwhile: its saves come first in the queue)
      const rec = await loadInk(meta.id);
      pages = rec.pages;
      lost = rec.lost;
    }
    const old = (e, st) => (st.v != null ? st.v : e.v) === prevVersion;
    if (!Object.values(pages).some((e) => e && e.s && e.s.some((st) => old(e, st)))) return; // nothing written on it
    if (typeof follow === 'function') follow = follow();
    const now = meta.modifiedTime;
    const lists = {};
    const edited = new Set();
    const gone = {};
    let touched = false;
    for (const [key, e] of Object.entries(pages)) {
      if (!e || !e.s || !e.s.length) continue;
      const n0 = +key;
      for (const st of e.s) {
        let n = n0;
        let v = st.v != null ? st.v : e.v;
        if (v === prevVersion) {
          touched = true;
          const f = follow[n0 - 1];
          if (f === null) { (gone[n0] || (gone[n0] = [])).push(st); continue; }
          if (f) { n = f.to + 1; v = now; if (f.changed) edited.add(n); }
        }
        (lists[n] || (lists[n] = [])).push({ st, v });
      }
    }
    if (!touched) return;
    // Back to pages: a page's version is the current one when any of its writing is; writing of
    // another version keeps its own.
    const out = {};
    for (const [n, list] of Object.entries(lists)) {
      const pv = list.some((x) => x.v === now) ? now : list[0].v;
      out[n] = {
        v: pv,
        s: list.map(({ st, v }) => {
          const c = { ...st };
          if (v === pv) delete c.v; else c.v = v;
          return c;
        }),
      };
    }
    const lostOut = [...lost, ...Object.entries(gone).map(([n, st]) => ({ n: +n, v: prevVersion, s: st }))];
    if (live && (gen !== this.gen || this.inkPages !== pages)) return this.remapInk(meta, prevVersion, () => follow, -1); // closed meanwhile: on what is stored
    if (live) {
      this.cancelStroke(); // (a stroke under way would be drawn over pages that moved)
      this.inkLost = lostOut;
      this.inkPages = out;
      this.inkUndo = [];
      this.inkRedo = [];
      for (const el of $$('svg.ink', this.pagesEl)) el.remove();
      for (const n of Object.keys(out)) this.renderInk(+n - 1);
      if (this.thumbCache) this.thumbCache.clear();
      this.inkRev = (this.inkRev || 0) + 1;
      await this.flushInk();
    } else {
      // (the note open again meanwhile reads it after this save: loadInk waits in the same queue)
      await saveInk(meta.id, out, lostOut, null, inkGeneration()).catch(() => {});
    }
    if (!live) return;
    const nGone = Object.keys(gone).length;
    const msgs = [];
    if (edited.size) msgs.push(t('inkPagesChanged', { range: pageRanges([...edited].sort((a, b) => a - b)) }));
    if (nGone) msgs.push(t('inkPagesRemoved', { n: nGone }));
    if (msgs.length) toast(msgs.join(' '), { duration: 9000 });
  }

  loadChanged(meta) {
    const c = docState(meta.id).changed;
    this.changed = c && c.version === meta.modifiedTime && Array.isArray(c.pages) ? new Set(c.pages) : null;
    if (this.changed) for (const p of this.pages) if (p.canvas && this.changed.has(p.i + 1)) this.markChanged(p);
  }

  markChanged(p) {
    if (!p.el || p.el.querySelector('.chg-tag')) return;
    const tag = document.createElement('span');
    tag.className = 'chg-tag';
    tag.textContent = t('changedTag');
    tag.setAttribute('aria-label', joinList([t('pageN', { n: p.i + 1 }), t('changedTag')]));
    p.el.appendChild(tag);
  }

  /**
   * In the background, take each page's fingerprint; when the version read before had some,
   * the pages whose prints differ are the changed ones: offer them and mark them.
   */
  async diffPages(meta, gen) {
    // Stored per note: {tag, version, fp, done} for the version read last, and while its prints
    // are still being made (done: false) the finished prints of the version before (prev).
    const key = 'fp:' + meta.id;
    const epoch = cache.epoch; // before any wait: a deletion from now on stops all writes
    let rec = null;
    try { rec = await idb.get('texts', key); } catch { /* none */ }
    if (rec && rec.tag !== FP_TAG) rec = null; // made another way: start again
    const mine = rec && rec.version === meta.modifiedTime;
    if (mine && rec.done !== false) {
      // This version is known. Writing left on the version before (its move cut short) goes now.
      if (rec.prev && Array.isArray(rec.prev.fp) && Array.isArray(rec.fp) && hasInk(meta.id)) {
        this.remapInk(meta, rec.prev.version, () => followPages(rec.prev.fp, rec.fp), gen).catch((err) => console.warn('ink remap', err));
      }
      return;
    }
    let prev = null;
    if (mine) prev = rec.prev || null;
    else if (rec && rec.done !== false) prev = { version: rec.version, fp: rec.fp };
    else if (rec) prev = rec.prev || null;
    // Only compare with an older version (an old offline copy opened later compares nothing).
    if (prev && !(String(meta.modifiedTime) > String(prev.version))) prev = null;
    await new Promise((r) => setTimeout(r, 1500)); // let the first pages draw first
    // A pass cut short earlier goes on where it stopped (from the first page it couldn't draw).
    const fps = mine ? rec.fp.slice() : [];
    const gap = fps.indexOf(null);
    if (gap >= 0) fps.length = gap;
    const n = Math.min(this.doc ? this.doc.numPages : 0, 1500);
    // Not after the note's stored data was deleted meanwhile (that would bring it back).
    const save = (done) => cache.epoch !== epoch ? Promise.resolve() : idb.put('texts', key, done
      ? { tag: FP_TAG, version: meta.modifiedTime, fp: fps, done: true, prev: prev && Array.isArray(prev.fp) ? prev : null }
      : { tag: FP_TAG, version: meta.modifiedTime, fp: fps, done: false, prev }).catch(() => {});
    const t0 = performance.now();
    for (let i = fps.length; i < n; i++) {
      // Not while the app is in the background, not for more than 90 s of work at a time; what
      // was made is kept, and the next opening goes on from there.
      if (gen === this.gen && document.hidden) await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }));
      if (gen !== this.gen || !this.doc || performance.now() - t0 > 90_000) { await save(false); return; }
      const doc = this.doc;
      const fp = await fingerprint(doc, i, !!(this.pages[i] && this.pages[i].canvas));
      // Closed meanwhile: the drawing may have failed only because of that. Not kept.
      if (gen !== this.gen || this.doc !== doc) { await save(false); return; }
      fps.push(fp);
      if (i % 20 === 19) await save(false);
      if (i % 3 === 2) await new Promise((r) => setTimeout(r, 20)); // reading stays smooth
    }
    if (gen !== this.gen) { await save(false); return; }
    await save(true);
    if (!prev || !Array.isArray(prev.fp)) return; // first time: nothing to compare
    const pages = changedPages(prev.fp, fps);
    // Handwriting on the version before follows its pages.
    if (hasInk(meta.id) || (this.inkPages && gen === this.gen && Object.keys(this.inkPages).length)) {
      this.remapInk(meta, prev.version, () => followPages(prev.fp, fps), gen).catch((err) => console.warn('ink remap', err));
    }
    updateDocState(meta.id, { changed: { version: meta.modifiedTime, pages } });
    if (gen !== this.gen || !pages.length) return;
    this.changed = new Set(pages);
    for (const p of this.pages) if (p.canvas && this.changed.has(p.i + 1)) this.markChanged(p);
    let added = this.added && this.added.gen === gen ? this.added : null;
    // Pages new at the end were told already when the note opened: here they come together. When
    // the new pages were put in the middle instead (the end pages match old ones), that toast named
    // the wrong pages: this one names every new or changed page.
    if (added && pages.filter((x) => x >= added.from).length < added.n) added = null;
    const edited = added ? pages.filter((x) => x < added.from) : pages;
    if (added && !edited.length) return;
    const first = added ? Math.min(edited[0], added.from) : edited[0];
    toast(added
      ? t('changedAndNew', { n: edited.length, range: pageRanges(edited), added: added.n })
      : t('changedPages', { n: edited.length, range: pageRanges(edited) }), {
      action: t('newPagesGo'),
      duration: 8000,
      onAction: () => { if (gen === this.gen) this.goToPage(first - 1); },
    });
  }

  listChanged() {
    const pages = [...(this.changed || [])].sort((a, b) => a - b);
    actionSheet({
      title: t('changedMenu', { n: pages.length }),
      subtitle: pageRanges(pages),
      items: [
        ...pages.slice(0, 40).map((n) => ({ label: t('pageN', { n }), icon: 'page', onClick: () => this.goToPage(n - 1) })),
        { label: t('changedClear'), icon: 'x', onClick: () => this.clearChanged() },
      ],
    });
  }

  clearChanged() {
    if (!this.meta) return;
    updateDocState(this.meta.id, { changed: null });
    this.changed = null;
    for (const el of $$('.chg-tag', this.pagesEl)) el.remove();
  }

  async savePdf(withInk = null) {
    if (!this.blob || !this.doc) return;
    if (this.restricted()) { toast(t('restrictedDoc'), { duration: 6000 }); return; }
    const nums = Array.from({ length: this.doc.numPages }, (_, i) => i + 1);
    if (withInk == null && nums.some((n) => this.inkOn(n))) {
      // Written on: ask whether the writing goes into the saved file.
      actionSheet({
        title: t('savePdf'),
        items: [
          { label: t('savePdfWithInk'), icon: 'pen', onClick: () => this.savePdf(true) },
          { label: t('savePdfOriginal'), icon: 'download', onClick: () => this.savePdf(false) },
        ],
      });
      return;
    }
    const src = { blob: this.blob, doc: this.doc };
    const name = safeFileName(this.meta.name) + '.pdf';
    let ok = false;
    try {
      const inkMap = withInk ? await this.inkForExport(nums, src) : null;
      const blob = inkMap ? await inkIntoWholePdf(src.blob, (n) => inkMap.get(n)) : src.blob;
      ok = await saveFile(blob, name);
    } catch (e) {
      console.error(e);
    }
    toast(ok ? t('savedToDownloads', { name }) : t('saveFailed'));
  }
}

/** [1,2,3,5,8,9] → "1–3, 5, 8–9" (shortened when long). */
function pageRanges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  const sep = listSep();
  const s = out.join(sep);
  if (s.length <= 48) return s;
  // Long: whole pages and ranges only (a cut inside "123" would show page 12)
  let shown = '';
  for (const part of out) {
    const next = shown ? shown + sep + part : part;
    if (next.length > 46) break;
    shown = next;
  }
  return shown + ' …';
}
