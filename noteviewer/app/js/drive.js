// Google Drive access with the browser-only OAuth 2.0 token flow (no server needed).
// The token lives ~1 hour; after that we renew it with a silent redirect (prompt=none),
// which returns immediately while the phone's browser is still signed in to Google.
//
// Accounts: `acct` '' is the account connected first. The Android app can add more Google
// accounts (their e-mail is their `acct`); each keeps its own token, renewed silently in place.

import { settings, kv } from './store.js';
import { t } from './i18n.js';
import { DRIVE_TYPES, driveFormat, baseName } from './formats.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

export class AuthError extends Error {}
/** The saved place in the changes list is no longer valid: read the folders again in full. */
export class CursorError extends Error {}

/** Set when running inside the Android app (see /android); sign-in then goes through Play services. */
export const native = typeof window !== 'undefined' && window.GNVNative ? window.GNVNative : null;

const nativeWaiters = new Map();
let nativeSeq = 0;
const silentInFlight = new Map(); // acct -> pending silent renewal
// acct -> revocation still on its way to Google: signing in again waits for it, or the late
// revocation would cancel the new connection (Google revokes every token of the grant).
const revoking = new Map();
function trackRevoke(acct, p) {
  revoking.set(acct, p);
  p.finally(() => { if (revoking.get(acct) === p) revoking.delete(acct); });
  return p;
}
// Bumped when an account is disconnected: a sign-in answer that arrives later is dropped.
const authGen = new Map(); // acct -> number
const gen = (acct) => authGen.get(acct) || 0;
function forgetPending(acct) {
  authGen.set(acct, gen(acct) + 1);
  silentInFlight.delete(acct);
}
window.__gnvAuthResult = (id, json) => {
  const done = nativeWaiters.get(id);
  nativeWaiters.delete(id);
  if (done) done(JSON.parse(json));
};

// Play services doesn't report the lifetime; tokens last ≥ 1h, renew a bit early.
const nativeToken = (r) => ({ accessToken: r.token, expiresAt: Date.now() + 45 * 60_000 });

/**
 * Ask the Android app for a Drive token for one account. interactive=false never shows UI.
 * Resolves to {ok, error, needsInteraction}.
 */
export function nativeAuthorize(interactive, acct = '') {
  if (!native) return Promise.resolve({ ok: false, error: 'not_native' });
  const pending = revoking.get(acct);
  if (pending) return pending.then(() => nativeAuthorize(interactive, acct));
  if (!interactive && silentInFlight.has(acct)) return silentInFlight.get(acct);
  const started = gen(acct);
  // Name the account once it is known, so a token never comes back for a different one.
  const email = acct || (account() && account().email) || '';
  const ask = (name) => askNative(interactive, name);
  const p = ask(email).then((r) => {
    // The main account's Drive address may not be its name on the phone (alias, letter case):
    // with no other account to confuse it with, let Play services pick it as before 1.13.
    const notFound = !r.token && !r.needsInteraction && !['network_error', 'canceled', 'busy'].includes(r.error);
    return !acct && email && notFound && !extraAccounts().length ? ask('') : r;
  }).then((r) => {
    if (gen(acct) !== started) return { ok: false, error: 'canceled' }; // disconnected meanwhile
    if (r.token) {
      setToken(acct, nativeToken(r));
      if (!acct) kv.set('connected', true);
      return { ok: true };
    }
    return { ok: false, error: r.error || 'failed', needsInteraction: !!r.needsInteraction };
  });
  if (!interactive) {
    silentInFlight.set(acct, p);
    p.finally(() => silentInFlight.delete(acct));
  }
  return p;
}

/**
 * Android app: let the user pick another Google account and grant it Drive access.
 * Resolves to {ok, acct} ('' when they picked the account already connected) or {ok:false, error}.
 */
export function nativeAddAccount() {
  if (!native || !native.addAccount) return Promise.resolve({ ok: false, error: 'not_native' });
  const started = gen('');
  // An account just disconnected may be picked again: let every revocation land first (also
  // ones that start while waiting).
  const settled = async () => { while (revoking.size) await Promise.all([...revoking.values()]); };
  return settled().then(() => {
    if (gen('') !== started || !isConnected()) return { error: 'canceled' }; // disconnected meanwhile
    return new Promise((resolve) => {
      const id = String(++nativeSeq);
      nativeWaiters.set(id, resolve);
      native.addAccount(id);
    });
  }).then((r) => {
    if (gen('') !== started || !isConnected()) return { ok: false, error: 'canceled' };
    if (!r.token || !r.account) return { ok: false, error: r.error || 'failed' };
    const main = account();
    const acct = main && main.email && main.email.toLowerCase() === String(r.account).toLowerCase() ? '' : String(r.account);
    setToken(acct, nativeToken(r));
    if (!acct) kv.set('connected', true);
    // Known (listed in Settings, renewed silently) even if fetching its name fails now.
    else if (!kv.get('xaccounts', {})[acct]) kv.set('xaccounts', { ...kv.get('xaccounts', {}), [acct]: { name: '', email: acct } });
    return { ok: true, acct };
  });
}

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function token(acct = '') {
  return acct ? kv.get('xtokens', {})[acct] || null : kv.get('token', null);
}
function setToken(acct, value) {
  if (!acct) { kv.set('token', value); return; }
  const all = kv.get('xtokens', {});
  if (value) all[acct] = value; else delete all[acct];
  kv.set('xtokens', all);
}
export function hasValidToken(acct = '') {
  const t = token(acct);
  return !!t && t.expiresAt - Date.now() > 60_000;
}
export function isConnected() {
  return !!kv.get('connected', false);
}
/** The account connected first: {name, email}. */
export function account() {
  return kv.get('account', null);
}
/**
 * Accounts added later (Android app): [{key, name, email}]. `key` is the account's name on the
 * phone (what tokens and note folders use); `email` is its Drive address (usually the same).
 */
export function extraAccounts() {
  return Object.entries(kv.get('xaccounts', {})).map(([key, v]) => ({ ...v, key }));
}

export function startAuth({ silent = false, returnTo = location.hash } = {}) {
  if (!settings.clientId) throw new Error(t('errNoClientId'));
  // Unguessable state ties the redirect back to this tab (stops login CSRF / token injection).
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem('gnv.oauth', JSON.stringify({ state, returnTo, silent }));
  const p = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  const acc = account();
  if (acc && acc.email) p.set('login_hint', acc.email);
  if (silent) p.set('prompt', 'none');
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
}

/**
 * If the page was loaded as the OAuth redirect target, consume the response.
 * Returns null when there is nothing to handle, otherwise {ok, error, silent, returnTo}.
 */
export function consumeAuthResponse() {
  const h = location.hash.slice(1);
  if (!/(^|&)(access_token|error)=/.test(h)) return null;
  const p = new URLSearchParams(h);
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem('gnv.oauth') || '{}'); } catch { /* ignore */ }
  sessionStorage.removeItem('gnv.oauth');
  const returnTo = saved.returnTo && !saved.returnTo.includes('access_token') ? saved.returnTo : '#/docs';
  history.replaceState(null, '', location.pathname + location.search + returnTo);

  if (!saved.state || p.get('state') !== saved.state) {
    return { ok: false, error: 'state_mismatch', silent: !!saved.silent, returnTo };
  }
  if (p.get('error')) return { ok: false, error: p.get('error'), silent: !!saved.silent, returnTo };
  const granted = (p.get('scope') || '').split(' ');
  if (!granted.includes(SCOPE)) {
    return { ok: false, error: 'scope_denied', silent: !!saved.silent, returnTo };
  }
  kv.set('token', {
    accessToken: p.get('access_token'),
    expiresAt: Date.now() + Number(p.get('expires_in') || 3600) * 1000,
  });
  kv.set('connected', true);
  return { ok: true, silent: !!saved.silent, returnTo };
}

/**
 * Revoke the grant at Google (the app disappears from the account's connected apps), then drop
 * the token. Best effort: offline or already expired is fine.
 */
/**
 * Ask Google to revoke a grant; resolves to whether it confirmed. `held` is the token the
 * account had; in the app an expired one is renewed silently first (Google needs a working one),
 * without storing anything: the account is already disconnected here.
 */
async function revokeHeld(held, email) {
  let tok = held && held.expiresAt - Date.now() > 60_000 ? held.accessToken : '';
  if (held && native) native.clearToken(held.accessToken);
  if (!tok && native) {
    try {
      // The app may be closing and never answer: give up after 10 s.
      const r = await Promise.race([askNative(false, email), new Promise((res) => setTimeout(() => res(null), 10_000))]);
      tok = r && r.token ? r.token : '';
      if (tok) native.clearToken(tok);
    } catch { tok = ''; }
  }
  if (!tok) return false; // nothing to revoke with: Google may still list the app
  try {
    const res = await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tok), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(10_000) : undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}

function askNative(interactive, name) {
  return new Promise((resolve) => {
    const id = String(++nativeSeq);
    nativeWaiters.set(id, resolve);
    native.authorize(!!interactive, id, name);
  });
}

/**
 * Disconnect every account: done here at once (nothing waits for the network). Returns a promise
 * of whether Google confirmed every revocation; false means the user should remove the app in
 * their Google Account (offline, or no working token).
 */
export function disconnect() {
  const main = account();
  const accts = ['', ...Object.keys(kv.get('xaccounts', {}))];
  const held = accts.map((a) => ({ t: token(a), email: a || (main && main.email) || '' }));
  for (const a of accts) { forgetPending(a); setToken(a, null); }
  kv.set('xtokens', null);
  kv.set('xaccounts', null);
  kv.set('connected', false);
  kv.set('account', null);
  const each = accts.map((a, i) => trackRevoke(a, revokeHeld(held[i].t, held[i].email)));
  return Promise.all(each).then((all) => all.every(Boolean));
}

/** Drop an added account without revoking (it turned out to be the main account). */
export function forgetAccount(acct) {
  if (!acct) return;
  forgetPending(acct);
  setToken(acct, null);
  const all = kv.get('xaccounts', {});
  delete all[acct];
  kv.set('xaccounts', all);
}

/** Disconnect one of the accounts added later, at once. Returns a promise like disconnect(). */
export function removeAccount(acct) {
  if (!acct) return Promise.resolve(true);
  const held = token(acct);
  forgetPending(acct);
  setToken(acct, null);
  const all = kv.get('xaccounts', {});
  delete all[acct];
  kv.set('xaccounts', all);
  return trackRevoke(acct, revokeHeld(held, acct));
}

async function request(url, { signal, acct = '' } = {}, retried = false) {
  const known = acct ? !!kv.get('xaccounts', {})[acct] || hasValidToken(acct) : isConnected();
  if (!hasValidToken(acct)) {
    // In the app a fresh token is one silent call away; on the web it needs a redirect.
    if (!native || !known) throw new AuthError('token_expired');
    const r = await nativeAuthorize(false, acct);
    if (!r.ok) throw new AuthError(r.error);
  }
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token(acct).accessToken },
    signal,
  });
  if (res.status === 401) {
    const stale = token(acct);
    setToken(acct, null);
    // Disconnected while this request was out: don't sign in again behind the user's back.
    const still = acct ? !!kv.get('xaccounts', {})[acct] : isConnected();
    if (native && !retried && still) {
      if (stale) native.clearToken(stale.accessToken);
      const r = await nativeAuthorize(false, acct);
      if (r.ok) return request(url, { signal, acct }, true);
    }
    throw new AuthError('unauthorized');
  }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { msg = (await res.json()).error.message || msg; } catch { /* ignore */ }
    const err = new Error(t('errDrive', { msg }));
    err.status = res.status;
    throw err;
  }
  return res;
}

async function api(path, params = {}, acct = '') {
  const res = await request(API + path + '?' + new URLSearchParams(params), { acct });
  return res.json();
}

export async function fetchAccount(acct = '') {
  const r = await api('/about', { fields: 'user(displayName,emailAddress)' }, acct);
  const acc = { name: r.user.displayName, email: r.user.emailAddress };
  if (!acct) kv.set('account', acc);
  else kv.set('xaccounts', { ...kv.get('xaccounts', {}), [acct]: acc });
  return acc;
}

async function listAll(q, fields, acct = '') {
  const out = [];
  let pageToken;
  do {
    const r = await api('/files', {
      q,
      fields: `nextPageToken,files(${fields})`,
      pageSize: '1000',
      spaces: 'drive',
      ...(pageToken ? { pageToken } : {}),
    }, acct);
    out.push(...r.files);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function listFolders(parentId, acct = '') {
  const files = await listAll(
    `'${esc(parentId)}' in parents and mimeType='${FOLDER}' and trashed=false`,
    'id,name,modifiedTime',
    acct,
  );
  return files.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** Note apps whose backup/export folders we recognise by name. */
const NOTE_APPS = [
  { term: 'goodnotes', re: /good\s*notes/i, label: 'GoodNotes' },
  { term: 'notability', re: /notability/i, label: 'Notability' },
  { term: 'noteshelf', re: /noteshelf/i, label: 'Noteshelf' },
  { term: 'samsung', re: /samsung\s*notes/i, label: 'Samsung Notes' },
  { term: '삼성', re: /삼성\s*노트/, label: '삼성 노트' },
];

/** Folders whose name looks like a note app's backup folder: [{id, name, hint}]. */
export async function findNoteFolders(acct = '') {
  const q = NOTE_APPS.map((a) => `name contains '${a.term}'`).join(' or ');
  const files = await listAll(`mimeType='${FOLDER}' and (${q}) and trashed=false`, 'id,name,parents,modifiedTime', acct);
  const out = [];
  for (const f of files) {
    const app = NOTE_APPS.find((a) => a.re.test(f.name));
    if (app) out.push({ id: f.id, name: f.name, hint: t('hintAppFolder', { app: app.label }) });
  }
  return out;
}

/**
 * Folders that hold the most recently modified PDFs, counting PDFs in sub-folders too, so a
 * backup folder of any note app surfaces even if its name is unknown: [{id, name, hint}].
 */
export async function findPdfFolders(limit = 4, acct = '') {
  const r = await api('/files', {
    q: "mimeType='application/pdf' and trashed=false",
    fields: 'files(parents)',
    pageSize: '500',
    orderBy: 'modifiedTime desc',
    spaces: 'drive',
  }, acct);
  const direct = new Map();
  for (const f of r.files) for (const p of f.parents || []) direct.set(p, (direct.get(p) || 0) + 1);
  const info = new Map(); // id -> {id, name, parents}
  const getInfo = async (id) => {
    if (!info.has(id)) info.set(id, api('/files/' + encodeURIComponent(id), { fields: 'id,name,parents' }, acct).catch(() => null));
    return info.get(id);
  };
  const totals = new Map();
  const top = [...direct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  await Promise.all(top.map(async ([id, n]) => {
    // Credit the folder and up to three ancestors (My Drive itself has no parents and is skipped).
    let cur = await getInfo(id);
    for (let depth = 0; cur && cur.parents && depth < 4; depth++) {
      totals.set(cur.id, (totals.get(cur.id) || 0) + n);
      cur = await getInfo(cur.parents[0]);
    }
  }));
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const out = [];
  for (const [id, n] of ranked) {
    const f = await getInfo(id);
    if (f) out.push({ id, name: f.name, hint: t('hintRecentPdfs', { n }) });
  }
  return out;
}

export async function getFolder(id, acct = '') {
  return api('/files/' + encodeURIComponent(id), { fields: 'id,name' }, acct);
}

/** Where the account's list of changes stands now (read changes after this point later). */
export async function startCursor(acct = '') {
  const r = await api('/changes/startPageToken', {}, acct);
  return r.startPageToken;
}

const MAX_CHANGES = 20_000; // more than this since last time: reading the folders again is cheaper

/**
 * Everything that changed in the account's Drive since `cursor`: {changes: [{removed, fileId,
 * file}], next} where `next` is the cursor for the next time. One request when nothing changed.
 */
export async function listChanges(cursor, acct = '') {
  const changes = [];
  let page = cursor;
  let next = null;
  while (page) {
    let r;
    try {
      r = await api('/changes', {
        pageToken: page,
        pageSize: '1000',
        spaces: 'drive',
        includeRemoved: 'true',
        fields: 'nextPageToken,newStartPageToken,changes(removed,fileId,file(id,name,mimeType,modifiedTime,size,parents,trashed,thumbnailLink))',
      }, acct);
    } catch (e) {
      if (e && [400, 404, 410].includes(e.status)) throw new CursorError(e.message);
      throw e;
    }
    changes.push(...(r.changes || []));
    if (changes.length > MAX_CHANGES) throw new CursorError('too many changes');
    page = r.nextPageToken || null;
    if (r.newStartPageToken) next = r.newStartPageToken;
  }
  return { changes, next };
}

export const FOLDER_TYPE = FOLDER;

/**
 * Walk the backup folder breadth-first and return every sub-folder and PDF.
 */
export async function listTree(rootId, onProgress, acct = '', { stopAt = null } = {}) {
  const folders = {};
  const files = {};
  let queue = [rootId];
  let scanned = 0;
  while (queue.length) {
    const next = [];
    // A few folders at a time keeps things fast without hitting rate limits.
    for (let i = 0; i < queue.length; i += 4) {
      const batch = queue.slice(i, i + 4);
      const results = await Promise.all(batch.map((id) => listAll(
        `'${esc(id)}' in parents and trashed=false and (mimeType='${FOLDER}' or ${DRIVE_TYPES.map((m) => `mimeType='${m}'`).join(' or ')})`,
        'id,name,mimeType,modifiedTime,size,thumbnailLink',
        acct,
      ).then((items) => ({ id, items }))));
      for (const { id, items } of results) {
        for (const it of items) {
          if (it.mimeType === FOLDER) {
            if (stopAt && stopAt.has(it.id)) continue; // another chosen note folder: read on its own
            folders[it.id] = { id: it.id, name: it.name, parent: id, modifiedTime: it.modifiedTime, acct };
            next.push(it.id);
          } else if (driveFormat(it.mimeType, it.name)) {
            const fmt = driveFormat(it.mimeType, it.name);
            files[it.id] = {
              id: it.id,
              name: baseName(it.name),
              ...(fmt !== 'pdf' ? { fmt } : {}),
              parent: id,
              modifiedTime: it.modifiedTime,
              size: Number(it.size || 0),
              thumb: it.thumbnailLink || '',
              source: 'drive',
              acct,
            };
          }
        }
        scanned++;
        onProgress && onProgress(scanned);
      }
    }
    queue = next;
  }
  return { folders, files };
}

/** Download a file's bytes, reporting progress as a 0..1 fraction. */
export async function download(fileId, { size = 0, onProgress, signal, acct = '' } = {}) {
  const res = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { signal, acct });
  const total = Number(res.headers.get('content-length')) || size;
  if (!res.body || !total || !onProgress) return res.blob();
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
