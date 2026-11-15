// Which files the app shows as notes: PDFs, and documents it turns into PDFs (js/convert.js) the
// first time they are opened or saved for offline use. Small on purpose: everything else about
// converting is loaded only when a document is converted.

const NOTE_EXT = /\.(pdf|docx|hwpx|hwp)$/i;
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Hangul HWPX: what clouds and other apps call it. */
export const HWPX_TYPES = ['application/hwp+zip', 'application/haansofthwpx', 'application/vnd.hancom.hwpx'];
/** Older Hangul files (.hwp, HWP 5.0). */
export const HWP_TYPES = ['application/x-hwp', 'application/haansofthwp', 'application/vnd.hancom.hwp'];
/** File types the file picker and "open with" offer. */
export const PICK_TYPES = ['application/pdf', DOCX_TYPE, ...HWPX_TYPES, ...HWP_TYPES];

export const isNoteName = (name) => typeof name === 'string' && NOTE_EXT.test(name);
/** 'pdf', 'docx', 'hwpx' or 'hwp' (by the name's extension; 'pdf' when it has none of them). */
export const formatOf = (name) => {
  const m = typeof name === 'string' && name.match(NOTE_EXT);
  return m ? m[1].toLowerCase() : 'pdf';
};
export const baseName = (name) => String(name || '').replace(NOTE_EXT, '');
/** Whether a note in the library is a converted document (its `fmt`, absent for PDFs). */
export const converted = (f) => !!(f && f.fmt && f.fmt !== 'pdf');

/**
 * What a file really is, from its first bytes: 'pdf', 'hwpx' (a ZIP that starts with Hangul's
 * "mimetype" entry), 'docx' (any other ZIP), 'cfb' (a compound file: an older Hangul file, or an
 * older Office one), 'hwp3' (a Hangul file older than HWP 5.0, which can't be read) or null.
 */
export async function sniff(blob) {
  let head;
  try { head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer()); } catch { return null; }
  const text = String.fromCharCode(...head.subarray(0, 1024));
  if (text.includes('%PDF-')) return 'pdf';
  if (text.startsWith('HWP Document File')) return 'hwp3';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    // the first entry's name and (stored) content, after its extra field
    const nameLen = head[26] | (head[27] << 8);
    const extraLen = head[28] | (head[29] << 8);
    const all = String.fromCharCode(...head);
    const name = all.slice(30, 30 + nameLen);
    const body = all.slice(30 + nameLen + extraLen, 30 + nameLen + extraLen + 40);
    if (name === 'mimetype' && body.startsWith('application/hwp+zip')) return 'hwpx';
    // (a packed or later "mimetype": Hangul's own parts among the first entries)
    if (/Contents\/(header|section\d+)\.xml|Contents\/content\.hpf/.test(all) && !all.includes('word/')) return 'hwpx';
    return 'docx';
  }
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => head[i] === b)) return 'cfb';
  return null;
}
/**
 * Older Office files (and password-protected newer ones, Hancom's sheets and slides) are compound
 * files too: a compound file is an .hwp unless its name says otherwise.
 */
export const cfbFormat = (name) => (/\.(doc|dot|xls|xlt|ppt|pps|pot|msg|msi|vsd|pub|mpp|docx|xlsx|pptx|cell|show|nxl|hwt|hwdt)$/i.test(name || '') ? null : 'hwp');
/** Types a cloud gives files it doesn't know (a Hangul file is found by its name then). */
const GENERIC_TYPES = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed'];
/** Google Drive types listed in note folders. */
export const DRIVE_TYPES = ['application/pdf', DOCX_TYPE, ...HWPX_TYPES, ...HWP_TYPES, ...GENERIC_TYPES];
/** A Drive file's format by its type (a generic type: by its name), or null when it isn't a note. */
export function driveFormat(type, name) {
  if (type === 'application/pdf') return 'pdf';
  if (type === DOCX_TYPE) return 'docx';
  if (HWPX_TYPES.includes(type)) return 'hwpx';
  if (HWP_TYPES.includes(type)) return 'hwp';
  if (GENERIC_TYPES.includes(type) && /\.hwpx$/i.test(name || '')) return 'hwpx';
  if (GENERIC_TYPES.includes(type) && /\.hwp$/i.test(name || '')) return 'hwp';
  return null;
}
/** The tag a converted note shows (format names, not translated). */
export const formatTag = (fmt) => (fmt === 'hwpx' || fmt === 'hwp' ? 'HWP' : 'Word');
/** Converted formats a file of this kind can be: a ZIP named .docx or .hwpx is what it says. */
export const zipFormat = (kind, name, type) => (kind === 'hwpx' || formatOf(name) === 'hwpx' || HWPX_TYPES.includes(type) ? 'hwpx' : 'docx');

/** Bumped when conversion gets better: copies made by an older version are made again. */
export const CONVERT_VERSION = 1;
