// Exporting pages: a new PDF made of the chosen pages (copied as-is, so they stay sharp),
// PNG images of them, or those images bundled into one ZIP file. Plus saving any file.

import { drawInk, inkIntoPdfPage } from './ink.js';

const PDF_LIB = new URL('../vendor/pdf-lib/pdf-lib.esm.min.js', import.meta.url).href;
const IMAGE_LONG_SIDE = 2200; // px of the longer page side in exported images (~190 dpi for A4)
const CHUNK = 1536 * 1024; // bytes per piece handed to the Android app (keeps strings small)

let pdfLibPromise;
const loadPdfLib = () => pdfLibPromise || (pdfLibPromise = import(PDF_LIB));

/** Characters Android/Windows don't allow in file names → "_". Falls back to `fallback`. */
export function safeFileName(name, fallback = 'note') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (s || fallback).slice(0, 120);
}

/**
 * A new PDF with only the given pages (1-based, in the given order). `inkOf(n)`: handwriting to
 * draw onto page n, {strokes, vt} (see ink.js), or nothing.
 */
export async function extractPdf(srcBlob, pageNums, inkOf = null) {
  const lib = await loadPdfLib();
  const { PDFDocument } = lib;
  const src = await PDFDocument.load(await srcBlob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageNums.map((n) => n - 1));
  copied.forEach((p, k) => {
    out.addPage(p);
    const ink = inkOf && inkOf(pageNums[k]);
    if (ink && ink.strokes.length) inkIntoPdfPage(lib, p, ink.strokes, ink.vt);
  });
  const bytes = await out.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

/**
 * The whole file with handwriting drawn onto its own pages (so its outline, form fields and
 * details stay as they are). `inkOf(n)` as in extractPdf.
 */
export async function inkIntoWholePdf(srcBlob, inkOf) {
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.load(await srcBlob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
  doc.getPages().forEach((p, k) => {
    const ink = inkOf(k + 1);
    if (ink && ink.strokes.length) inkIntoPdfPage(lib, p, ink.strokes, ink.vt);
  });
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

/** One page as a PNG (white background), with its handwriting if given. `doc`: an open PDF.js document. */
export async function pageToPng(doc, n, strokes = null) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(6, IMAGE_LONG_SIDE / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (strokes) drawInk(ctx, strokes, scale);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG'))), 'image/png'));
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// ---------------------------------------------------------------- ZIP (stored: PNGs are already compressed)
let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** files: [{name, blob}] → a ZIP blob (UTF-8 names, no compression). */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 file names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true);
    c.setUint16(14, dosDate, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((s, b) => s + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------------------------------------------------------------- saving
export function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Save a file to the phone's Download folder (Android app; `folder` = optional subfolder) or as a
 * browser download. Returns true when it was saved.
 */
export async function saveFile(blob, name, { folder = '' } = {}) {
  const native = window.GNVNative;
  if (native && native.beginFile) {
    const id = native.beginFile(name, blob.type || 'application/octet-stream', folder);
    if (!id) return false;
    let ok = true;
    try {
      for (let at = 0; at < blob.size && ok; at += CHUNK) {
        ok = native.appendFile(id, await base64Of(blob.slice(at, at + CHUNK)));
      }
    } catch {
      ok = false;
    }
    return native.endFile(id, ok) && ok;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return true;
}
