// What the cloud modules (onedrive.js, dropbox.js, mybox.js, webdav.js) share: their errors, the
// limits of one sync, walking a folder tree, and the Android app's gateway for Dropbox, MYBOX and
// WebDAV (the login stays in the app; the page asks it for read operations only).
//
// Each cloud module exports the same things, used by app.js:
//   KEY, PREFIX (of note ids), label(), available(), account() → {name, email, reauth} | null,
//   connect(args) → {ok, name, email} | {error}, signOut(), rootName(), listFolders(id),
//   findNoteFolders(), listTree(rootId, {stopAt, budget}) → {folders, files, truncated, partial},
//   download(f, {onProgress, signal}), CHECK_EVERY / MANUAL_EVERY (ms), and when the cloud keeps
//   a changes list: latestLink(), changes(link) → {items, link} | {more}, relevant(items, lib, chosen).

import { isNoteName } from './formats.js';

export const MAX_FOLDERS = 10; // chosen folders per cloud
const MAX_TREE_FOLDERS = 2000; // folders below them, all together
const MAX_FILES = 5000;
export const newBudget = () => ({ folders: MAX_TREE_FOLDERS, files: MAX_FILES });

export class AuthError extends Error {}
export class NetworkError extends Error {}
export class NotFoundError extends Error {}
/** The saved place in the changes list is too old: read the folders again in full. */
export class GoneError extends Error {}
export class BusyError extends Error {}

/**
 * A note's version as a valid date: the time of the change, its milliseconds taken from the
 * cloud's revision tag, so two saves within the same second are still two versions.
 */
export function versionTime(when, tag = '') {
  const d = when ? new Date(when) : null;
  if (!d || isNaN(d)) return tag ? new Date(0).toISOString().replace('.000Z', '.' + String(hash(tag) % 1000).padStart(3, '0') + 'Z') : '';
  if (!tag) return d.toISOString();
  d.setUTCMilliseconds(hash(tag) % 1000);
  return d.toISOString();
}
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export { isNoteName };
export const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Every folder and PDF below rootId, breadth first. children(id) → items [{id, name, dir, size,
 * modified}] (items.more: the folder wasn't read in full). stopAt: chosen folders inside this one
 * (listed on their own). budget is shared by all chosen folders of one sync.
 */
export async function walkTree(rootId, children, { stopAt = new Set(), budget, isGone = (e) => e instanceof NotFoundError } = {}) {
  const folders = [];
  const files = [];
  let truncated = false;
  const partial = new Set();
  const queue = [rootId];
  const seen = new Set([rootId]); // a folder is read once, even if a server lists it twice
  while (queue.length) {
    const id = queue.shift();
    let items;
    try {
      items = await children(id);
    } catch (e) {
      if (id !== rootId && isGone(e)) continue; // a folder below that vanished meanwhile
      throw e;
    }
    if (items.more) { truncated = true; partial.add(id); }
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || !it.id) continue;
      if (it.dir) {
        if (stopAt.has(it.id) || seen.has(it.id)) continue;
        seen.add(it.id);
        if (budget.folders <= 0) { truncated = true; partial.add(it.id); continue; }
        budget.folders--;
        folders.push({ id: it.id, name: String(it.name || ''), parent: id });
        queue.push(it.id);
      } else if (isNoteName(it.name)) {
        if (budget.files <= 0) { truncated = true; partial.add(id); continue; }
        budget.files--;
        files.push({ id: it.id, name: String(it.name), size: Number(it.size) || 0, modified: String(it.modified || ''), parent: id });
      }
    }
  }
  return { folders, files, truncated, partial };
}

/** A downloaded PDF from a fetch Response, with progress. */
export async function readPdf(res, size, onProgress) {
  const total = Number(res.headers.get('content-length')) || size;
  if (!res.body || !total || !onProgress) return new Blob([await res.blob()], { type: 'application/pdf' });
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  return new Blob(chunks, { type: 'application/pdf' });
}

// ---------------------------------------------------------------------- the app's gateway
const native = typeof window !== 'undefined' && window.GNVNative ? window.GNVNative : null;
const waiters = new Map();
let seq = 0;
if (typeof window !== 'undefined') {
  window.__gnvCloudResult = (id, json) => {
    const done = waiters.get(id);
    waiters.delete(id);
    if (done) { try { done(JSON.parse(json)); } catch { done({ error: 'failed' }); } }
  };
}
function ask(method, ...args) {
  return new Promise((resolve) => {
    const id = 'c' + ++seq;
    waiters.set(id, resolve);
    try { native[method](id, ...args); } catch { waiters.delete(id); resolve({ error: 'failed' }); }
  });
}

/** The short reason a server gave with an error ({"message": …} or {"error": …}), for the error text. */
function serverSays(detail) {
  let m = '';
  try {
    const j = JSON.parse(String(detail || ''));
    const v = j && (j.message || j.error_summary || (typeof j.error === 'string' ? j.error : '') || j.code);
    m = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  } catch { /* not JSON: left out */ }
  m = m.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, 120);
  return m ? ` (${m})` : '';
}

/** One cloud handled by the app's gateway (Dropbox, MYBOX, WebDAV). */
export function gateway(cloud, texts) {
  const gen = { n: 0 };
  return {
    available() {
      try { return !!(native && native.cloudAvailable && native.cloudAvailable(cloud)); } catch { return false; }
    },
    account() {
      if (!this.available()) return null;
      try {
        const s = native.cloudAccount(cloud);
        const a = s ? JSON.parse(s) : null;
        return a && typeof a.email === 'string' ? a : null;
      } catch {
        return null;
      }
    },
    async connect(args = {}) {
      if (!this.available()) return { error: 'not_configured' };
      const started = ++gen.n;
      const r = await ask('cloudConnect', cloud, JSON.stringify(args));
      if (started !== gen.n) return { error: 'canceled' };
      return r && r.ok ? { ok: true, name: r.name || '', email: r.email || '' } : { error: (r && r.error) || 'failed' };
    },
    signOut() {
      gen.n++;
      try { native && native.cloudSignOut && native.cloudSignOut(cloud); } catch { /* not in the app */ }
    },
    /** A read operation; resolves to its data or throws one of the errors above. */
    async call(op, args = {}) {
      const started = gen.n;
      const r = await ask('cloudCall', cloud, op, JSON.stringify(args));
      if (started !== gen.n) throw new AuthError(texts.reauth());
      if (r && 'data' in r) return r.data;
      const status = r && r.status;
      if (!r || r.error === 'network_error') throw new NetworkError(texts.network());
      if (r.error === 'reauth' || status === 401) throw new AuthError(texts.reauth());
      if (status === 404) throw Object.assign(new NotFoundError(texts.gone()), { detail: r.detail });
      if (status === 429 || status === 503) throw new BusyError(texts.busy());
      const err = new Error(texts.error((status ? 'HTTP ' + status : r.error || 'failed') + serverSays(r.detail)));
      err.status = status;
      err.detail = r.detail || '';
      throw err;
    },
    async download(id, size, { onProgress, signal } = {}) {
      let res;
      try {
        res = await fetch('/cloud?p=' + encodeURIComponent(cloud) + '&id=' + encodeURIComponent(id), { signal });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new NetworkError(texts.network());
      }
      if (res.status === 401) throw new AuthError(texts.reauth());
      if (res.status === 404) throw new Error(texts.fileGone());
      if (res.status === 413) throw new Error(texts.tooLarge());
      if (res.status === 429) throw new BusyError(texts.busy());
      if (!res.ok) throw new NetworkError(texts.network());
      return readPdf(res, size, onProgress);
    },
  };
}
