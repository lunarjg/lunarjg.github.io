// Persistence: small JSON state in localStorage, PDF blobs and covers in IndexedDB.

import { CONVERT_VERSION } from './formats.js';

const LS = 'gnv.';

function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(LS + key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
/** Returns whether the value was stored (a full storage refuses it). */
function writeJSON(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(LS + key);
    else localStorage.setItem(LS + key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('localStorage write failed', e);
    return false;
  }
}

const DEFAULT_SETTINGS = {
  clientId: '',
  rootId: '',
  rootName: '',
  autoDownload: true,
  wifiOnly: true,
  theme: 'system', // system | light | dark
  sort: 'date', // date | name
  view: 'grid', // grid | list
  syncMinutes: 5,
  syncWifiOnly: false,
  readMode: 'scroll', // viewer: scroll | single (one page at a time)
  fitHeightLandscape: false, // viewer: whole page on screen when the phone is sideways
  pageDark: 'off', // viewer: off | on | auto (dark pages when the app theme is dark)
  spread: 'auto', // viewer: auto | on | off — two pages side by side on wide screens
  ocr: false, // Android app: recognize handwriting on the phone so it can be searched
  bgSync: true, // Android app: check Drive for updated notes in the background
  bgNotify: true,
  lang: 'auto', // auto | ko | en | ja | zh | es
  ghRepos: [], // public GitHub repositories: [{owner, repo, ref, path, only}] (see github.js)
  clouds: {}, // other clouds' chosen folders (Android app): {onedrive|dropbox|mybox|webdav: [{id, name}]} (see cloud.js)
};

export const settings = Object.assign({}, DEFAULT_SETTINGS, readJSON('settings', {}));
delete settings.memo; // memorize mode was taken out in 1.26.0: its pen colour goes with the next save
export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  writeJSON('settings', settings);
}

/**
 * Note folders the library shows: [{root, name, acct}] (acct '' = the account connected first,
 * else the e-mail of an account added later). Before 1.13 there was one folder: rootId/rootName,
 * which still mirror the first entry.
 */
if (!Array.isArray(settings.sources)) {
  settings.sources = settings.rootId ? [{ root: settings.rootId, name: settings.rootName || '', acct: '' }] : [];
}
export function setSources(list) {
  saveSettings({ sources: list, rootId: list.length ? list[0].root : '', rootName: list.length ? list[0].name : '' });
}
/** Identifies the folder set; a library snapshot made for another set is out of date. */
export function sourcesSig(list = settings.sources) {
  return list.map((s) => `${s.acct}/${s.root}`).join('|');
}

/**
 * Library snapshot from Drive:
 * { sig, folders: {id:{id,name,parent,acct}}, files: {id:{id,name,parent,modifiedTime,size,thumb,acct}}, syncedAt }
 * (acct: which account the item came from, see settings.sources)
 */
export const library = {
  get() {
    const v = readJSON('library', null);
    // A snapshot from before 1.13 names its one folder by rootId.
    if (v && v.sig === undefined) v.sig = v.rootId && v.rootId === settings.rootId ? sourcesSig() : '';
    return v;
  },
  set(v) { return writeJSON('library', v); },
};

/**
 * What the GitHub repositories hold: { sig, folders, files, states: {repoKey: {head, release, …}},
 * checkedAt }. Kept in memory too: the library reads it on every render.
 */
let ghMemo;
export const ghLibrary = {
  get() {
    // One object until it changes (the library's cache compares it by identity).
    if (ghMemo === undefined) ghMemo = readJSON('ghlib', null) || { sig: '', folders: {}, files: {}, states: {}, checkedAt: 0 };
    return ghMemo;
  },
  set(v) { ghMemo = v; writeJSON('ghlib', v); },
};

const cloudMemo = new Map();
const emptyCloud = () => ({ sig: '', acct: '', folders: {}, files: {}, link: '', fullAt: 0, checkedAt: 0, errors: {}, pending: {} });
/**
 * Each other cloud's folders and notes (OneDrive, Dropbox, MYBOX, WebDAV):
 * {sig, acct, folders, files, link, fullAt, checkedAt, errors, pending}. One object per cloud until
 * it changes (the library's cache compares them by identity).
 */
export const cloudLibrary = {
  get(key) {
    if (!cloudMemo.has(key)) cloudMemo.set(key, readJSON('cloud.' + key, null) || emptyCloud());
    return cloudMemo.get(key);
  },
  set(key, v) { cloudMemo.set(key, v); return writeJSON('cloud.' + key, v); },
  clear(key) { return this.set(key, emptyCloud()); },
};

/** Files imported from the phone itself. {id:{id,name,modifiedTime,size}} */
export const localFiles = {
  get() { return readJSON('local', {}); },
  set(v) { writeJSON('local', v); },
};

/** Per-document reading state: {id:{lastPage, lastOpened, seenModified, bookmarks:[], fav}} */
const docStates = readJSON('docs', {});
export function docState(id) {
  return docStates[id] || {};
}
export function updateDocState(id, patch) {
  docStates[id] = Object.assign({}, docStates[id], patch);
  writeJSON('docs', docStates);
  return docStates[id];
}
export function allDocStates() {
  return docStates;
}
/** Hand a note's reading state to another id (the same note under a new file). */
export function moveDocState(from, to) {
  if (!docStates[from]) return;
  docStates[to] = Object.assign({}, docStates[from], docStates[to]);
  delete docStates[from];
  writeJSON('docs', docStates);
}

export const kv = {
  get: (k, f) => readJSON(k, f),
  set: (k, v) => writeJSON(k, v),
};

// ---------------------------------------------------------------- IndexedDB
let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('goodnotes-viewer', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ['pdfs', 'covers', 'texts', 'ocr']) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
};

// Index of what is cached, kept in memory so the library can render synchronously.
// {id: {modifiedTime, size}}
let cacheIndex = readJSON('cacheIndex', {});
export const cache = {
  info(id) { return cacheIndex[id]; },
  isFresh(file) {
    const c = cacheIndex[file.id];
    // a converted document: only a copy made by this version of the converter
    return !!c && c.modifiedTime === file.modifiedTime && (!file.fmt || file.fmt === 'pdf' || file.source === 'local' || c.conv === CONVERT_VERSION);
  },
  async getPdf(id) {
    const rec = await idb.get('pdfs', id);
    if (!rec) return null;
    // (a distribution document's copy says so itself, whatever happens to the index)
    if (rec.noCopy) rec.blob.restricted = true;
    return rec.blob;
  },
  async putPdf(id, blob, modifiedTime) {
    // The same version converted again (a newer converter): its pages may differ, so what was
    // worked out from the old copy (cover, text, chapters, page marks, handwriting) goes.
    const was = cacheIndex[id];
    if (was && was.modifiedTime === modifiedTime && (was.conv || 0) !== (blob.converted || 0)) {
      await Promise.all([idb.del('covers', id), idb.del('texts', id), idb.del('texts', 'toc:' + id), idb.del('texts', 'fp:' + id), idb.del('ocr', id)]).catch(() => {});
    }
    await idb.put('pdfs', id, blob.restricted ? { blob, modifiedTime, noCopy: true } : { blob, modifiedTime });
    cacheIndex[id] = { modifiedTime, size: blob.size };
    if (blob.converted) cacheIndex[id].conv = blob.converted;
    if (blob.restricted) cacheIndex[id].noCopy = true; // (a distribution document: no export)
    writeJSON('cacheIndex', cacheIndex);
  },
  /** Bumped when stored data goes: background work started before must not write it back. */
  epoch: 0,
  async remove(id) {
    this.epoch++;
    await Promise.all([idb.del('pdfs', id), idb.del('covers', id), idb.del('texts', id), idb.del('texts', 'toc:' + id), idb.del('texts', 'fp:' + id), idb.del('ocr', id)]);
    delete cacheIndex[id];
    writeJSON('cacheIndex', cacheIndex);
  },
  async clearAll() {
    this.epoch++;
    await Promise.all([idb.clear('pdfs'), idb.clear('covers'), idb.clear('texts'), idb.clear('ocr')]);
    cacheIndex = {};
    writeJSON('cacheIndex', cacheIndex);
  },
  /** A copy of a distribution document (배포용 문서): read only, never exported or saved. */
  restricted(id) { return !!(cacheIndex[id] && cacheIndex[id].noCopy); },
  totalBytes() {
    return Object.values(cacheIndex).reduce((a, c) => a + (c.size || 0), 0);
  },
  ids() { return Object.keys(cacheIndex); },
};
