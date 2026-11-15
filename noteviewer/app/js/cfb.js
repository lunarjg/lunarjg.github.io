// A reader for the compound files (OLE/CFB) older Hangul documents (.hwp, HWP 5.0) are stored in:
// sectors, the allocation tables, the directory and the streams in it. Only reads; every chain
// and size is checked against the file, so a damaged or crafted file can't loop or read past it.
//
// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE = 0xffffffff;
const END = 0xfffffffe;

export class CfbError extends Error {}
const bad = (why) => new CfbError('compound file: ' + why);

export const isCfb = (b) => b && b.length >= 8 && SIGNATURE.every((x, i) => b[i] === x);

/**
 * Opens a compound file. Returns { streams: Map<path, entry>, read(path) → Uint8Array | null }.
 * Paths are names joined with "/" ("BodyText/Section0").
 */
export function openCfb(bytes, { maxStreams = 20000 } = {}) {
  if (!isCfb(bytes) || bytes.length < 512) throw bad('not a compound file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const shift = u16(0x1e);
  const miniShift = u16(0x20);
  if ((shift !== 9 && shift !== 12) || miniShift !== 6) throw bad('sector size');
  const size = 1 << shift;
  const nSectors = Math.floor((bytes.length - size) / size) + 1; // (the header takes the first sector's room)
  const off = (sid) => (sid + 1) * size;
  const okSector = (sid) => sid < nSectors && off(sid) + size <= bytes.length + size; // a short last sector is padded
  const sector = (sid) => {
    if (!okSector(sid)) throw bad('sector out of the file');
    const o = off(sid);
    const out = new Uint8Array(size);
    out.set(bytes.subarray(o, Math.min(bytes.length, o + size)));
    return out;
  };

  // the allocation table, from the sector list in the header and its continuation sectors
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(0x4c + i * 4);
    if (s !== FREE && s !== END) fatSectors.push(s);
  }
  let difat = u32(0x44);
  const per = size / 4;
  const seenDifat = new Set();
  while (difat !== END && difat !== FREE) {
    if (seenDifat.has(difat) || fatSectors.length > nSectors) throw bad('table chain loops');
    seenDifat.add(difat);
    const s = new DataView(sector(difat).buffer);
    for (let i = 0; i < per - 1; i++) {
      const v = s.getUint32(i * 4, true);
      if (v !== FREE && v !== END) fatSectors.push(v);
    }
    difat = s.getUint32((per - 1) * 4, true);
  }
  if (fatSectors.length > nSectors) throw bad('table too large');
  const fat = new Uint32Array(fatSectors.length * per);
  fatSectors.forEach((sid, i) => fat.set(new Uint32Array(sector(sid).buffer), i * per));

  /** The sectors of a chain, checked: no loops, inside the file. */
  const chain = (start, table, limit) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== END; s = table[s]) {
      if (s === FREE || s >= table.length || seen.has(s) || out.length >= limit) throw bad('broken chain');
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readChain = (start, len) => {
    const sids = chain(start, fat, Math.ceil(len / size) + 1);
    if (sids.length * size < len) throw bad('stream shorter than its size');
    const out = new Uint8Array(len);
    let at = 0;
    for (const sid of sids) {
      if (at >= len) break;
      const s = sector(sid);
      const n = Math.min(size, len - at);
      out.set(s.subarray(0, n), at);
      at += n;
    }
    return out;
  };

  // the directory
  const dirSids = chain(u32(0x30), fat, nSectors);
  const dir = new Uint8Array(dirSids.length * size);
  dirSids.forEach((sid, i) => dir.set(sector(sid), i * size));
  const dd = new DataView(dir.buffer);
  const nEntries = dir.length / 128;
  const entry = (i) => {
    const o = i * 128;
    const nameLen = Math.min(64, dd.getUint16(o + 64, true));
    let name = '';
    for (let k = 0; k + 2 < nameLen; k += 2) name += String.fromCharCode(dd.getUint16(o + k, true));
    const hi = dd.getUint32(o + 124, true);
    return {
      name, type: dir[o + 66], left: dd.getUint32(o + 68, true), right: dd.getUint32(o + 72, true), child: dd.getUint32(o + 76, true),
      start: dd.getUint32(o + 116, true), size: shift === 9 ? dd.getUint32(o + 120, true) : (hi ? Infinity : dd.getUint32(o + 120, true)),
    };
  };
  if (!nEntries) throw bad('no directory');
  const root = entry(0);
  if (root.type !== 5) throw bad('no root');

  // the small streams' container (in the root's own stream) and their table
  const cutoff = u32(0x38) || 4096;
  const miniSize = 1 << miniShift;
  const miniStream = root.size && root.start !== END ? readChain(root.start, Math.min(root.size, bytes.length)) : new Uint8Array(0);
  const miniFatSids = u32(0x3c) === END || u32(0x3c) === FREE ? [] : chain(u32(0x3c), fat, nSectors);
  const miniFat = new Uint32Array(miniFatSids.length * per);
  miniFatSids.forEach((sid, i) => miniFat.set(new Uint32Array(sector(sid).buffer), i * per));
  const readMini = (start, len) => {
    const sids = chain(start, miniFat, Math.ceil(len / miniSize) + 1);
    if (sids.length * miniSize < len) throw bad('small stream shorter than its size');
    const out = new Uint8Array(len);
    let at = 0;
    for (const sid of sids) {
      if (at >= len) break;
      const o = sid * miniSize;
      if (o + Math.min(miniSize, len - at) > miniStream.length) throw bad('small stream out of its container');
      const n = Math.min(miniSize, len - at);
      out.set(miniStream.subarray(o, o + n), at);
      at += n;
    }
    if (at < len) throw bad('small stream shorter than its size');
    return out;
  };

  // names: each storage's children are a tree of siblings
  const streams = new Map();
  const seen = new Set();
  const starts = new Set();
  const walk = (i, prefix, depth) => {
    const stack = [i];
    while (stack.length) {
      const k = stack.pop();
      if (k === FREE || k >= nEntries || seen.has(k)) continue;
      seen.add(k);
      if (seen.size > maxStreams) throw bad('too many entries');
      const e = entry(k);
      stack.push(e.left, e.right);
      const path = prefix + e.name;
      if (e.type === 2) {
        // (two streams on the same sectors: only a crafted file has that, to have them read twice)
        const at = (e.size < (u32(0x38) || 4096) ? 'm' : 's') + e.start;
        if (e.size && e.start !== END && e.start !== FREE) {
          if (starts.has(at)) throw bad('streams share sectors');
          starts.add(at);
        }
        streams.set(path, e);
      }
      else if (e.type === 1 && depth < 8) walk(e.child, path + '/', depth + 1);
    }
  };
  walk(root.child, '', 0);

  return {
    streams,
    /** A stream's bytes, or null when there is none of that name. */
    read(path) {
      const e = streams.get(path);
      if (!e) return null;
      if (!(e.size <= bytes.length * 2 + 4096)) throw bad('stream larger than the file');
      if (!e.size) return new Uint8Array(0);
      return e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size);
    },
  };
}
