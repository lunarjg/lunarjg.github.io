// NAVER MYBOX, read only (Android app only), with a personal access token the user makes in MYBOX
// (Settings → account and personal access token management). The token stays in the app
// (android/…/Cloud.java), which also makes the calls (at most one a second: MYBOX allows about
// 60 a minute) and downloads the files. MYBOX has no changes list: folders are read in full,
// at most every 30 minutes by themselves.

import { t } from './i18n.js';
import { gateway, walkTree, byName, versionTime } from './cloud.js';

export const KEY = 'mybox';
export const PREFIX = 'mb';
export const label = () => t('myboxName');
export const rootName = () => 'MYBOX';
export const CHECK_EVERY = 30 * 60_000;
export const MANUAL_EVERY = 60_000;
const gw = gateway(KEY, {
  reauth: () => t('myboxReauth'),
  network: () => t('cloudNetwork', { name: 'MYBOX' }),
  busy: () => t('cloudBusy', { name: 'MYBOX' }),
  gone: () => t('cloudFolderGone', { name: 'MYBOX' }),
  fileGone: () => t('cloudFileGone', { name: 'MYBOX' }),
  tooLarge: () => t('ghTooLarge'),
  error: (msg) => t('cloudError', { name: 'MYBOX', msg }),
});

export const available = () => gw.available();
export const account = () => gw.account();
/** args: {token} */
export const connect = (args) => gw.connect(args);
export const signOut = () => gw.signOut();

/** Everything directly in a folder ('root' = the top). */
async function children(id) {
  const out = [];
  let cursor = '';
  for (let n = 0; n < 50; n++) {
    const r = await gw.call('list', { id: id === 'root' ? '' : id, cursor });
    for (const x of (r && r.resources) || []) {
      if (!x || typeof x.resourceId !== 'string') continue;
      out.push({ id: x.resourceId, name: String(x.name || ''), dir: x.type === 'folder', size: x.size, modified: versionTime(x.modifiedAt || x.updatedAt, x.size != null ? String(x.size) : '') });
    }
    cursor = r && r.responseMetaData && r.responseMetaData.nextCursor;
    if (!cursor) return out;
  }
  out.more = true;
  return out;
}

export async function listFolders(id) {
  return (await children(id)).filter((x) => x.dir).map((x) => ({ id: x.id, name: x.name })).sort(byName);
}

/** GoodNotes folders at the top of MYBOX (searching would cost more of MYBOX's small allowance). */
export async function findNoteFolders() {
  const top = await children('root').catch(() => []);
  return top.filter((x) => x.dir && /goodnotes/i.test(x.name)).slice(0, 6).map((x) => ({ id: x.id, name: x.name, hint: 'MYBOX' }));
}

export const listTree = (rootId, opts) => walkTree(rootId, children, opts);

export const download = (f, opts) => gw.download(f.rid, f.size, opts);
