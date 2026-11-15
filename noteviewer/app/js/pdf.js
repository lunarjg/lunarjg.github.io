// Lazy loader for the vendored PDF.js build, plus cover/thumbnail helpers.

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
let libPromise;

export function loadPdfjs() {
  if (!libPromise) {
    libPromise = import(BASE + 'pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
      return lib;
    });
  }
  return libPromise;
}

export async function openPdf(blob) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  return lib.getDocument({
    data,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    isEvalSupported: false,
  }).promise;
}

/** Render one page into a new canvas that is `cssWidth` CSS pixels wide. */
export async function renderToCanvas(page, cssWidth, dpr = window.devicePixelRatio || 1) {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (cssWidth * dpr) / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

/** First-page cover as a JPEG blob plus page count. */
export async function makeCover(blob) {
  const doc = await openPdf(blob);
  try {
    const page = await doc.getPage(1);
    const canvas = await renderToCanvas(page, 220, 2);
    const jpeg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    canvas.width = canvas.height = 0;
    return { blob: jpeg, pages: doc.numPages };
  } finally {
    doc.destroy();
  }
}

/** Plain text of every page (for full-text search). */
export async function extractText(doc) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
  }
  return pages;
}
