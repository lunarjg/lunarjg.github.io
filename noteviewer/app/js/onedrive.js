// Microsoft OneDrive, read only (Android app only). Sign-in and the refresh token stay in the app
// (android/…/OneDrive.java); the page asks it for short-lived access tokens and reads the
// Microsoft Graph API with them. Files are downloaded by the app (/od?id=…).

import { t } from './i18n.js';
import { AuthError, NetworkError, NotFoundError, GoneError, BusyError, walkTree, readPdf, byName } from './cloud.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const native = typeof window !== 'undefined' && window.GNVNative ? window.GNVNative : null;
const MAX_DELTA_PAGES = 20;

export const KEY = 'onedrive';
export const PREFIX = 'od';
export const label = () => 'OneDrive';
export const rootName = () => 'OneDrive';
// The changes list makes a check one request: look often.
export const CHECK_EVERY = 60_000;
export const MANUAL_EVERY = 10_000;
const name = label();

export function available() {
  try { return !!(native && native.msAvailable && native.msAvailable()); } catch { return false; }
}

/** {name, email, reauth} of the account signed in on this phone, or null. */
export function account() {
  if (!available()) return null;
  try {
    const s = native.msAccount();
    const a = s ? JSON.parse(s) : null;
    return a && typeof a.email === 'string' ? a : null;
  } catch {
    return null;
  }
}

const waiters = new Map();
let seq = 0;
if (typeof window !== 'undefined') {
  window.__gnvMsResult = (id, json) => {
    const done = waiters.get(id);
    waiters.delete(id);
    if (done) { try { done(JSON.parse(json)); } catch { done({ error: 'failed' }); } }
  };
}
function ask(method, ...args) {
  return new Promise((resolve) => {
    const id = 'ms' + ++seq;
    waiters.set(id, resolve);
    try { native[method](id, ...args); } catch { waiters.delete(id); resolve({ error: 'failed' }); }
  });
}

let tok = null; // {token, until} — in memory only
let gen = 0; // bumped on sign-out: answers that arrive later are dropped

/** Sign in with Microsoft (the browser opens). Resolves to {ok, name, email} or {error}. */
export async function connect() {
  if (!available()) return { error: 'not_configured' };
  const started = ++gen;
  tok = null;
  const r = await ask('msSignIn');
  if (started !== gen) return { error: 'canceled' };
  return r && r.ok ? { ok: true, name: r.name || '', email: r.email || '' } : { error: (r && r.error) || 'failed' };
}

/** Forget the account on this phone. */
export function signOut() {
  gen++;
  tok = null;
  try { native && native.msSignOut && native.msSignOut(); } catch { /* not in the app */ }
}

/** refused: a token Graph just turned down (the app then fetches a new one). */
async function token(refused = '') {
  if (!refused && tok && tok.until - Date.now() > 60_000) return tok.token;
  const started = gen;
  const r = await ask('msToken', refused);
  if (started !== gen) throw new AuthError(t('cloudReauth', { name }));
  if (r && r.token) {
    tok = { token: r.token, until: Date.now() + Math.max(60, Number(r.expiresIn) || 0) * 1000 };
    return tok.token;
  }
  if (r && r.error === 'network_error') throw new NetworkError(t('cloudNetwork', { name }));
  throw new AuthError(t('cloudReauth', { name }));
}

async function get(url, { signal } = {}, refused = '') {
  if (typeof url !== 'string' || !url.startsWith(GRAPH + '/')) throw new Error('not Graph');
  const bearer = await token(refused);
  let res;
  try {
    // A stalled connection gives up after a minute (the sync isn't stuck "syncing").
    const sig = signal || (AbortSignal.timeout ? AbortSignal.timeout(60_000) : undefined);
    res = await fetch(url, { headers: { Authorization: 'Bearer ' + bearer }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: sig });
  } catch (e) {
    if (e && e.name === 'AbortError' && signal) throw e;
    throw new NetworkError(t('cloudNetwork', { name }));
  }
  if (res.status === 401) {
    if (tok && tok.token === bearer) tok = null;
    if (!refused) return get(url, { signal }, bearer);
    throw new AuthError(t('cloudReauth', { name }));
  }
  if (res.status === 404) throw new NotFoundError(t('cloudFolderGone', { name }));
  if (res.status === 410) throw new GoneError('gone');
  if (res.status === 429 || res.status === 503) throw new BusyError(t('cloudBusy', { name }));
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch { /* plain text */ }
    throw new Error(t('cloudError', { name, msg }));
  }
  return res.json();
}

const itemPath = (id) => (id === 'root' ? '/me/drive/root' : '/me/drive/items/' + encodeURIComponent(id));
const SELECT = 'id,name,folder,file,size,lastModifiedDateTime,parentReference,package';

/** Every child of a folder (Graph pages them). */
async function children(id, { signal } = {}) {
  const out = [];
  let url = `${GRAPH}${itemPath(id)}/children?$select=${SELECT}&$top=999`;
  for (let n = 0; url && n < 50; n++) {
    const r = await get(url, { signal });
    if (Array.isArray(r.value)) out.push(...r.value);
    url = typeof r['@odata.nextLink'] === 'string' && r['@odata.nextLink'].startsWith(GRAPH + '/') ? r['@odata.nextLink'] : null;
  }
  out.more = !!url; // a huge folder: the rest wasn't read
  return out;
}

/** The folders in a folder ('root' = the top of OneDrive): [{id, name}]. */
export async function listFolders(id) {
  return (await children(id)).filter((it) => it && it.folder && typeof it.id === 'string').map((it) => ({ id: it.id, name: String(it.name || '') })).sort(byName);
}

/** The top of OneDrive by its real id ({id, name}): its changes name the parent by that id, not 'root'. */
export async function topFolder() {
  const r = await get(`${GRAPH}/me/drive/root?$select=id,name`);
  return r && typeof r.id === 'string' ? { id: r.id, name: String(r.name || '') } : null;
}

/** Folders that look like GoodNotes backups ("GoodNotes" in the name): [{id, name, hint}]. */
export async function findNoteFolders() {
  const r = await get(`${GRAPH}/me/drive/root/search(q='GoodNotes')?$select=${SELECT}&$top=50`).catch(() => null);
  const items = r && Array.isArray(r.value) ? r.value : [];
  return items.filter((it) => it && it.folder && /goodnotes/i.test(it.name || '')).slice(0, 6).map((it) => {
    const p = it.parentReference && typeof it.parentReference.path === 'string' ? it.parentReference.path.replace(/^\/drive\/root:?/, '') : '';
    return { id: it.id, name: String(it.name), hint: 'OneDrive' + (p ? p : '') };
  });
}

/**
 * Everything below one chosen folder: {folders: [{id, name, parent}], files: [item…], truncated, partial}.
 * `stopAt`: other chosen folders inside this one are listed on their own, not twice.
 * `budget` is shared by all the chosen folders of one sync ({folders, files} still allowed).
 */
export function listTree(rootId, { stopAt = new Set(), budget } = {}) {
  return walkTree(rootId, async (id) => {
    const items = await children(id);
    const out = items.map((it) => ({ id: it && it.id, name: it && it.name, dir: !!(it && it.folder), size: it && it.size, modified: it && it.lastModifiedDateTime, file: !!(it && it.file) }))
      .filter((it) => it.dir || it.file);
    out.more = items.more;
    return out;
  }, { stopAt, budget });
}

/** Whether anything in the changes list touches the notes or folders the app knows of. */
export function relevant(items, lib, chosen) {
  const known = new Set(chosen.map((x) => x.id));
  for (const d of Object.values(lib.folders || {})) if (d.rid) known.add(d.rid);
  for (const f of Object.values(lib.files || {})) known.add(f.rid);
  return items.some((it) => it && (known.has(it.id) || (it.parentReference && known.has(it.parentReference.id))));
}

/** Where the changes list stands now (changes from now on are listed by changes()). */
export async function latestLink() {
  // Only the fields needed to tell whether a change touches the chosen folders (the links
  // that follow keep this choice).
  const r = await get(`${GRAPH}/me/drive/root/delta?token=latest&$select=id,name,file,folder,deleted,size,parentReference,lastModifiedDateTime`);
  const link = r && r['@odata.deltaLink'];
  if (typeof link !== 'string' || !link.startsWith(GRAPH + '/')) throw new Error(t('cloudError', { name, msg: 'delta' }));
  return link;
}

/**
 * Everything in the drive that changed since `link`: {items, link} (link = where to go on next
 * time), or {more: true} when there are too many changes to page through (read in full then).
 */
export async function changes(link) {
  const items = [];
  let url = link;
  for (let n = 0; n < MAX_DELTA_PAGES; n++) {
    const r = await get(url);
    if (Array.isArray(r.value)) items.push(...r.value);
    const next = r['@odata.nextLink'];
    const done = r['@odata.deltaLink'];
    if (typeof done === 'string' && done.startsWith(GRAPH + '/')) return { items, link: done };
    if (typeof next !== 'string' || !next.startsWith(GRAPH + '/')) throw new Error(t('cloudError', { name, msg: 'delta' }));
    url = next;
  }
  return { more: true };
}

/** A note's PDF, downloaded by the app. f.rid = the OneDrive item id. */
export async function download(f, { onProgress, signal } = {}) {
  let res;
  try {
    res = await fetch('/od?id=' + encodeURIComponent(f.rid), { signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new NetworkError(t('cloudNetwork', { name }));
  }
  if (res.status === 401) throw new AuthError(t('cloudReauth', { name }));
  if (res.status === 404) throw new Error(t('cloudFileGone', { name }));
  if (res.status === 413) throw new Error(t('ghTooLarge'));
  if (!res.ok) throw new NetworkError(t('cloudNetwork', { name }));
  return readPdf(res, f.size, onProgress);
}

export { AuthError, NetworkError, NotFoundError, GoneError, BusyError };
