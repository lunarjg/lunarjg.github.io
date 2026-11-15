// Dropbox, read only (Android app only): sign-in (OAuth 2.0 + PKCE) and the token stay in the app
// (android/…/Cloud.java), which also makes the calls; files come through /cloud. A folder is read
// in one recursive listing, and Dropbox's changes list (a cursor) makes a check one request.

import { t } from './i18n.js';
import { gateway, NotFoundError, GoneError, isNoteName, byName, versionTime } from './cloud.js';

export const KEY = 'dropbox';
export const PREFIX = 'dbx';
export const label = () => 'Dropbox';
export const rootName = () => 'Dropbox';
export const CHECK_EVERY = 60_000;
export const MANUAL_EVERY = 10_000;
const name = 'Dropbox';
const gw = gateway(KEY, {
  reauth: () => t('cloudReauth', { name }),
  network: () => t('cloudNetwork', { name }),
  busy: () => t('cloudBusy', { name }),
  gone: () => t('cloudFolderGone', { name }),
  fileGone: () => t('cloudFileGone', { name }),
  tooLarge: () => t('ghTooLarge'),
  error: (msg) => t('cloudError', { name, msg }),
});

export const available = () => gw.available();
export const account = () => gw.account();
export const connect = () => gw.connect({});
export const signOut = () => gw.signOut();

/** Dropbox answers 409 with a reason; a missing path is "not found". */
async function call(op, args) {
  try {
    return await gw.call(op, args);
  } catch (e) {
    if (e.status === 409 && /not_found|malformed_path/.test(e.detail || '')) throw new NotFoundError(t('cloudFolderGone', { name }));
    if (e.status === 409 && /reset/.test(e.detail || '')) throw new GoneError('reset');
    throw e;
  }
}

const path = (id) => (id === 'root' ? '' : id);

/** Every entry of a listing (Dropbox pages them). */
async function listAll(args) {
  const out = [];
  let r = await call('list_folder', { limit: 2000, include_non_downloadable_files: false, ...args });
  out.push(...(r.entries || []));
  for (let n = 0; r.has_more && n < 100; n++) {
    r = await call('list_folder_continue', { cursor: r.cursor });
    out.push(...(r.entries || []));
  }
  if (r.has_more) out.more = true;
  return out;
}

export async function listFolders(id) {
  const entries = await listAll({ path: path(id), recursive: false });
  return entries.filter((e) => e && e['.tag'] === 'folder' && typeof e.id === 'string').map((e) => ({ id: e.id, name: String(e.name || '') })).sort(byName);
}

export async function findNoteFolders() {
  const r = await call('search', { query: 'GoodNotes', options: { max_results: 50, filename_only: true } }).catch(() => null);
  const matches = r && Array.isArray(r.matches) ? r.matches : [];
  return matches.map((m) => m && m.metadata && m.metadata.metadata).filter((m) => m && m['.tag'] === 'folder' && /goodnotes/i.test(m.name || ''))
    .slice(0, 6).map((m) => ({ id: m.id, name: String(m.name), hint: 'Dropbox' + String(m.path_display || '').replace(/\/[^/]*$/, '') }));
}

/**
 * Everything below one chosen folder, in one recursive listing. Folders are found by their path
 * (Dropbox entries name their place by path, not by parent id).
 */
export async function listTree(rootId, { stopAt = new Set(), budget } = {}) {
  const root = rootId === 'root' ? { path_lower: '' } : await call('get_metadata', { path: rootId });
  const rootPath = String(root.path_lower || '');
  const entries = await listAll({ path: path(rootId), recursive: true });
  const byPath = new Map([[rootPath, rootId]]);
  const stops = [];
  for (const e of entries) {
    if (!e || e['.tag'] !== 'folder' || typeof e.path_lower !== 'string') continue;
    if (stopAt.has(e.id)) stops.push(e.path_lower + '/');
    else byPath.set(e.path_lower, e.id);
  }
  const under = (p) => stops.some((s) => p.startsWith(s));
  const parentOf = (p) => byPath.get(p.slice(0, p.lastIndexOf('/')));
  const folders = [];
  const files = [];
  let truncated = !!entries.more;
  const partial = new Set(entries.more ? [rootId] : []);
  // Parents first (shorter paths), so a folder's place is known before what is in it.
  const sorted = entries.filter((e) => e && typeof e.path_lower === 'string' && e.path_lower !== rootPath && !under(e.path_lower + '/'))
    .sort((a, b) => a.path_lower.split('/').length - b.path_lower.split('/').length);
  for (const e of sorted) {
    const parent = parentOf(e.path_lower);
    if (!parent) continue;
    if (e['.tag'] === 'folder') {
      if (stopAt.has(e.id)) continue;
      if (budget.folders <= 0) { truncated = true; partial.add(parent); byPath.delete(e.path_lower); continue; }
      budget.folders--;
      folders.push({ id: e.id, name: String(e.name || ''), parent });
    } else if (e['.tag'] === 'file' && isNoteName(e.name)) {
      if (budget.files <= 0) { truncated = true; partial.add(parent); continue; }
      budget.files--;
      // The revision makes each version's time distinct (the same second can hold two saves).
      files.push({ id: e.id, name: String(e.name), size: Number(e.size) || 0, modified: versionTime(e.server_modified, e.rev || ''), parent });
    }
  }
  return { folders, files, truncated, partial, rootPath };
}

/** Where the changes list (the whole Dropbox) stands now. */
export async function latestLink() {
  const r = await call('latest_cursor', { path: '', recursive: true, include_deleted: true });
  if (!r || typeof r.cursor !== 'string') throw new Error(t('cloudError', { name, msg: 'cursor' }));
  return r.cursor;
}

export async function changes(cursor) {
  const items = [];
  let r = { cursor, has_more: true };
  for (let n = 0; r.has_more; n++) {
    if (n >= 20) return { more: true };
    r = await call('list_folder_continue', { cursor: r.cursor });
    items.push(...(r.entries || []));
  }
  return { items, link: r.cursor };
}

/**
 * A change is relevant when it is at or below a chosen folder (deleted entries carry only a
 * path), above one (a parent renamed or moved), or a folder or note the app knows by id.
 */
export function relevant(items, lib, chosen = []) {
  const roots = Object.values(lib.folders || {}).filter((d) => d.parent === 'root' && typeof d.p === 'string').map((d) => d.p);
  if (!roots.length) return true;
  const known = new Set(chosen.map((x) => x.id));
  for (const d of Object.values(lib.folders || {})) if (d.rid) known.add(d.rid);
  for (const f of Object.values(lib.files || {})) known.add(f.rid);
  return items.some((it) => it && ((typeof it.id === 'string' && known.has(it.id)) || (typeof it.path_lower === 'string'
    && roots.some((r) => r === '' || it.path_lower === r || it.path_lower.startsWith(r + '/') || r.startsWith(it.path_lower + '/')))));
}

export const download = (f, opts) => gw.download(f.rid, f.size, opts);
