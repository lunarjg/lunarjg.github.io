// WebDAV, read only (Android app only): Nextcloud, ownCloud, Synology, pCloud, Koofr and other
// servers, over https with a user name and an app password. The login stays in the app
// (android/…/Cloud.java), which also makes the calls; files come through /cloud. Ids are paths
// below the server address ("GoodNotes/Bio/" for a folder). There is no changes list: folders
// are read in full, at most every 15 minutes by themselves.

import { t } from './i18n.js';
import { gateway, walkTree, byName, versionTime } from './cloud.js';

export const KEY = 'webdav';
export const PREFIX = 'dav';
export const label = () => t('webdavName');
export const rootName = () => {
  const a = account();
  return a && a.email ? a.email.replace(/\/$/, '') : 'WebDAV';
};
export const CHECK_EVERY = 15 * 60_000;
export const MANUAL_EVERY = 10_000;
const name = 'WebDAV';
const gw = gateway(KEY, {
  reauth: () => t('webdavReauth'),
  network: () => t('cloudNetwork', { name }),
  busy: () => t('cloudBusy', { name }),
  gone: () => t('cloudFolderGone', { name }),
  fileGone: () => t('cloudFileGone', { name }),
  tooLarge: () => t('ghTooLarge'),
  error: (msg) => t('cloudError', { name, msg }),
});

export const available = () => gw.available();
export const account = () => gw.account();
/** args: {url, user, pass} */
export const connect = (args) => gw.connect(args);
export const signOut = () => gw.signOut();

/** A server's date ("Tue, 03 Nov 2026 10:00:00 GMT") as ISO; the ETag when it has none. */
function version(x) {
  return versionTime(x.modified, x.etag ? String(x.etag) : '');
}

async function children(id) {
  const here = id === 'root' ? '' : id;
  const list = await gw.call('list', { path: here });
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    // (the server listed more than the app reads: the folder wasn't read in full)
    if (x && x.more === true) { out.more = true; continue; }
    // (the folder itself is in its own listing)
    if (!x || x.self || typeof x.path !== 'string' || !x.path || x.path === here) continue;
    out.push({ id: x.path, name: String(x.name || ''), dir: !!x.dir, size: x.size, modified: version(x) });
  }
  return out;
}

export async function listFolders(id) {
  return (await children(id)).filter((x) => x.dir).map((x) => ({ id: x.id, name: x.name })).sort(byName);
}

export async function findNoteFolders() {
  const top = await children('root').catch(() => []);
  return top.filter((x) => x.dir && /goodnotes/i.test(x.name)).slice(0, 6).map((x) => ({ id: x.id, name: x.name, hint: rootName() }));
}

export const listTree = (rootId, opts) => walkTree(rootId, children, opts);

export const download = (f, opts) => gw.download(f.rid, f.size, opts);
