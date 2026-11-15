// App shell: routing, library (문서), favorites, search, settings, Drive, GitHub and other clouds' sync.

import { DEFAULT_CLIENT_ID, APP_VERSION } from './config.js';
import { settings, saveSettings, setSources, sourcesSig, library, ghLibrary, cloudLibrary, localFiles, docState, updateDocState, allDocStates, moveDocState, cache, idb, kv } from './store.js';
import * as drive from './drive.js';
import * as github from './github.js';
import * as onedrive from './onedrive.js';
import * as dropbox from './dropbox.js';
import * as mybox from './mybox.js';
import * as webdav from './webdav.js';
import { AuthError, NetworkError, NotFoundError, BusyError, MAX_FOLDERS as MAX_CLOUD_FOLDERS, newBudget } from './cloud.js';
import { makeCover, openPdf, extractText } from './pdf.js';
import { Viewer } from './viewer.js';
import { icon, hydrateIcons, LOGO } from './icons.js';
import { $, $$, esc, scrollBehavior, toast, actionSheet, dialog, formDialog, modalPage, fmtDate, fmtAgo, fmtSize, coverColor } from './ui.js';
import { t, LANGS, applyLang, currentLang, joinList, listSep } from './i18n.js';
import { ocrSupported, ocrOn, loadOcr, indexDoc, doneCount, findAll } from './ocr.js';
import { base64Of } from './export.js';
import { baseName, formatOf, converted, sniff, cfbFormat, DOCX_TYPE, CONVERT_VERSION, driveFormat, zipFormat, formatTag } from './formats.js';

if (!settings.clientId && DEFAULT_CLIENT_ID) saveSettings({ clientId: DEFAULT_CLIENT_ID });
settings.ghRepos = github.cleanRepos(settings.ghRepos);

// Defense in depth: the app never uses WebRTC, and WebRTC traffic isn't covered by the CSP or the
// app's network allowlist, so take it away from any script that might ever get in.
for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
  try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch { /* not present */ }
}

// Inside the Android app (android/) sign-in goes through Play services: no web client ID needed.
const NATIVE = drive.native;
const PACKAGE = NATIVE ? NATIVE.packageName() : '';
const configured = () => !!NATIVE || !!settings.clientId;
const driveUsable = () => navigator.onLine && drive.isConnected() && (drive.hasValidToken() || !!NATIVE);

const ROOT = 'root';
const LOCAL_FOLDER = 'v:local';
const DEMO_FOLDER = 'v:demo';
const DEMOS = [
  { id: 'demo:lecture', nameKey: 'demoLecture', url: 'demo/lecture.pdf', modifiedTime: '2026-09-22T09:30:00Z', size: 139485 },
  { id: 'demo:planner', nameKey: 'demoPlanner', url: 'demo/planner.pdf', modifiedTime: '2026-09-27T21:10:00Z', size: 29238 },
];

const main = $('#main');
const status = { syncing: false, detail: '', error: '', reauth: kv.get('needsReauth', false) };
let currentRoute = null;
let openedFromApp = false;
const scrollMemory = new Map();

// ====================================================================== data
function snapshot() {
  return library.get() || { folders: {}, files: {}, syncedAt: 0 };
}

function demoVisible() {
  return !drive.isConnected() && !settings.ghRepos.length && !anyCloudOn() && !kv.get('hideDemo', false);
}

/** 'Language' after the setting's own name, so anyone can find it: full-width brackets in ja and zh. */
const langAlso = () => (['ja', 'zh'].includes(currentLang()) ? '（Language）' : ' (Language)');
/** Notes from somewhere else that the app downloads: Google Drive, GitHub or another cloud. */
const remote =(f) => f.source === 'drive' || f.source === 'github' || !!cloudOf(f);
/** Whether a remote note can be downloaded right now. */
const canFetch = (f) => (f.source === 'github' ? navigator.onLine : cloudOf(f) ? cloudUsable(f.source) : driveUsable());
/**
 * A remote note as a PDF: a document (Word) is downloaded, then turned into a PDF on the phone.
 * onProgress(p, stage) — stage 'convert' while converting.
 */
function fetchRemote(f, opts = {}) {
  if (!converted(f)) return fetchFile(f, opts);
  // One conversion per note version: whoever asks again (the viewer while the background download
  // converts it, say) waits for the same one, and a wait the user sees makes it go first.
  const key = versionKey(f);
  let job = converting.get(key);
  if (!job) {
    job = { listeners: new Set(), p: 0, stage: '', urgent: !opts.background, waiting: 0, ctrl: new AbortController() };
    const tell = (p, stage = '') => {
      job.p = p;
      job.stage = stage;
      for (const l of job.listeners) { try { l(p, stage); } catch { /* a closed screen */ } }
    };
    job.promise = fetchFile(f, { ...opts, signal: job.ctrl.signal, onProgress: (p) => tell(p * 0.3) })
      .then((blob) => {
        tell(0.3, 'convert');
        return toPdf(blob, f, { key, background: !job.urgent, signal: job.ctrl.signal, onProgress: (p) => tell(0.3 + p * 0.7, 'convert') });
      })
      .finally(() => { if (converting.get(key) === job) converting.delete(key); });
    converting.set(key, job);
  } else if (!opts.background && !job.urgent) {
    job.urgent = true;
    import('./convert.js').then((m) => m.hurry(key)).catch(() => {});
  }
  // Everyone the user waits on gave up (they opened another note): the conversion stops, unless
  // it is background work (that goes on).
  if (opts.signal && !opts.background) {
    job.waiting++;
    opts.signal.addEventListener('abort', () => {
      if (--job.waiting > 0) return;
      converting.delete(key); // (a new request starts afresh)
      job.ctrl.abort();
    }, { once: true });
  }
  if (opts.onProgress) {
    job.listeners.add(opts.onProgress);
    if (job.p) opts.onProgress(job.p, job.stage);
  }
  return job.promise;
}
const versionKey = (f) => f.id + '\n' + f.modifiedTime;
const converting = new Map(); // note version → {promise, listeners, urgent}
function fetchFile(f, opts = {}) {
  if (f.source === 'github') return github.download(f, opts);
  if (cloudOf(f)) return CLOUDS[f.source].download(f, opts);
  return drive.download(f.id, { size: f.size, acct: f.acct || '', ...opts });
}

/**
 * A document as a PDF (js/convert.js, loaded only now). A file that already is a PDF stays as it
 * is. A version that failed, or that was being converted when the app's page crashed (out of
 * memory), isn't tried again in the background (opening it still tries).
 */
const convertFailed = new Set(); // note versions
const CONV_SKIP_MAX = 30;
// 1.23 reads distribution documents, which earlier versions gave up on: those are tried again (a
// version that crashed the page just now is still kept out, below).
if (kv.get('convSkipFor', '') !== '1.23') { kv.set('convSkip', []); kv.set('convSkipFor', '1.23'); }
{
  const crashed = kv.get('convBusy', null);
  if (crashed) {
    kv.set('convSkip', [crashed, ...kv.get('convSkip', []).filter((k) => k !== crashed)].slice(0, CONV_SKIP_MAX));
    kv.set('convBusy', null);
  }
}
const skipConvert = (f) => convertFailed.has(versionKey(f)) || kv.get('convSkip', []).includes(versionKey(f));
async function toPdf(blob, f, opts = {}) {
  opts = { ...opts };
  if ((await sniff(blob)) === 'pdf') {
    blob.converted = CONVERT_VERSION; // (a "Word" file that is a PDF: kept as the converted copy)
    return blob;
  }
  const key = f.id ? versionKey(f) : null;
  try {
    const mod = await import('./convert.js');
    // (the crash marker names the document being converted when it starts, not when it is queued
    // behind another one)
    const pdf = await mod.toPdf(blob, f.fmt || formatOf(f.name), { ...opts, title: f.name, onStart: () => { if (key) kv.set('convBusy', key); } });
    pdf.converted = CONVERT_VERSION; // (and pdf.restricted for a distribution document, from convert.js)
    return pdf;
  } catch (e) {
    if (e && e.convert && key) {
      // (remembered across restarts: not converted again in the background)
      convertFailed.add(key);
      kv.set('convSkip', [key, ...kv.get('convSkip', []).filter((k) => k !== key)].slice(0, CONV_SKIP_MAX));
    }
    throw e;
  } finally {
    if (key && kv.get('convBusy', null) === key) kv.set('convBusy', null);
  }
}

/** Every folder and note from Drive and GitHub, hidden ones included. */
function libData() {
  const lib = snapshot();
  const gh = ghLibrary.get();
  const ghFolders = {};
  for (const [id, f] of Object.entries(gh.folders || {})) {
    ghFolders[id] = f.relTag ? { ...f, name: t('ghReleases', { tag: f.relTag }) } : f;
  }
  const folders = { ...lib.folders, ...ghFolders };
  const files = { ...lib.files, ...(gh.files || {}) };
  for (const k of CLOUD_KEYS) {
    const c = cloudLibrary.get(k);
    Object.assign(folders, c.folders || {});
    Object.assign(files, c.files || {});
  }
  return { folders, files };
}

/**
 * Drive notes/folders deleted from the list: {id: modifiedTime | true}. The Drive original is
 * untouched (read-only access). A hidden note that gets edited again on the iPad shows up again.
 */
function hiddenMap() {
  return kv.get('hidden', {});
}
function isHiddenItem(item, hidden = hiddenMap()) {
  const v = hidden[item.id];
  return v === true || (v !== undefined && v === item.modifiedTime);
}

/**
 * allFolders()/allFiles() are asked for many times per screen (every folder cell counts its
 * contents): keep the last answer while what it is made from stays the same. The stored texts
 * are compared as they are (cheap) instead of being parsed again.
 */
let libMemo = { key: null, folders: null, files: null };
function memoKey() {
  let raw = [];
  try { raw = ['library', 'local', 'hidden', 'hideDemo', 'connected'].map((k) => localStorage.getItem('gnv.' + k)); } catch { /* storage off */ }
  return [...raw, ghLibrary.get(), settings.ghRepos.length, ...CLOUD_KEYS.map((k) => cloudLibrary.get(k)), ...CLOUD_KEYS.map((k) => cloudFolders(k).length), currentLang()];
}
function memoFresh() {
  const key = memoKey();
  if (libMemo.key && key.every((v, i) => v === libMemo.key[i])) return true;
  libMemo = { key, folders: null, files: null };
  return false;
}

function allFolders() {
  if (memoFresh() && libMemo.folders) return libMemo.folders;
  libMemo.folders = computeFolders();
  return libMemo.folders;
}

function computeFolders() {
  const lib = libData();
  const hidden = hiddenMap();
  const visible = {};
  const reachable = (id, depth = 0) => {
    if (id === ROOT) return true;
    if (id in visible) return visible[id];
    const f = lib.folders[id];
    visible[id] = !!f && depth < 60 && !isHiddenItem(f, hidden) && reachable(f.parent, depth + 1);
    return visible[id];
  };
  const out = {};
  for (const id of Object.keys(lib.folders)) if (reachable(id)) out[id] = lib.folders[id];
  if (Object.keys(localFiles.get()).length) out[LOCAL_FOLDER] = { id: LOCAL_FOLDER, name: t('folderImported'), parent: ROOT, virtual: true };
  if (demoVisible()) out[DEMO_FOLDER] = { id: DEMO_FOLDER, name: t('folderSamples'), parent: ROOT, virtual: true };
  return out;
}

function allFiles() {
  if (memoFresh() && libMemo.files) return libMemo.files;
  const files = computeFiles();
  libMemo.files = files;
  return files;
}

function computeFiles() {
  const lib = libData();
  const hidden = hiddenMap();
  const folders = allFolders();
  const out = {};
  for (const f of Object.values(lib.files)) {
    if (!isHiddenItem(f, hidden) && (f.parent === ROOT || folders[f.parent])) out[f.id] = f;
  }
  for (const f of Object.values(localFiles.get())) out[f.id] = { ...f, parent: LOCAL_FOLDER, source: 'local' };
  if (demoVisible()) for (const d of DEMOS) out[d.id] = { ...d, name: t(d.nameKey), parent: DEMO_FOLDER, source: 'demo' };
  return out;
}

function findFile(id) {
  return allFiles()[id] || null;
}

function folderPath(folderId, folders = allFolders()) {
  const names = [];
  let f = folders[folderId];
  let guard = 0;
  while (f && guard++ < 50) {
    names.unshift(f.name);
    f = folders[f.parent];
  }
  return names;
}

function sortItems(items) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });
  if (settings.sort === 'name') return items.sort(byName);
  return items.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || '') || byName(a, b));
}

function childrenOf(folderId) {
  const folders = Object.values(allFolders()).filter((f) => f.parent === folderId);
  const files = Object.values(allFiles()).filter((f) => f.parent === folderId);
  const virt = folders.filter((f) => f.virtual);
  const real = folders.filter((f) => !f.virtual);
  return { folders: [...virt, ...sortItems(real)], files: sortItems(files) };
}

function countIn(folderId) {
  const folders = allFolders();
  const files = allFiles();
  if (!libMemo.counts) { // items per folder, counted once for the whole screen
    const counts = new Map();
    const add = (p) => counts.set(p, (counts.get(p) || 0) + 1);
    for (const f of Object.values(folders)) add(f.parent);
    for (const f of Object.values(files)) add(f.parent);
    libMemo.counts = counts;
  }
  return libMemo.counts.get(folderId) || 0;
}

// ====================================================================== PDF access
/** True on Wi‑Fi (or wired). The app asks Android; browsers use the Network Information API. */
function onWifi() {
  if (NATIVE && NATIVE.isWifi) return NATIVE.isWifi();
  const c = navigator.connection;
  if (!c || !c.type || c.type === 'unknown' || c.type === 'other') return true; // can't tell
  return c.type === 'wifi' || c.type === 'ethernet';
}

function canAutoDownload() {
  if (!settings.autoDownload) return false;
  const c = navigator.connection;
  if (c && c.saveData) return false;
  if ((settings.wifiOnly || settings.syncWifiOnly) && !onWifi()) return false;
  return true;
}

async function getPdf(f, onProgress, signal) {
  if (f.source === 'demo') {
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(t('errSampleLoad'));
    return res.blob();
  }
  if (f.source === 'local') {
    const b = await cache.getPdf(f.id);
    if (!b) throw new Error(t('errLocalMissing'));
    return b;
  }
  if (cache.isFresh(f)) {
    const b = await cache.getPdf(f.id);
    if (b) return b;
  }
  const cachedInfo = cache.info(f.id);
  if (canFetch(f)) {
    try {
      // (a conversion stops when the user opens another note; a PDF download goes on)
      const blob = await fetchRemote(f, { onProgress, signal: converted(f) ? signal : undefined });
      if (await cachePdf(f, blob)) queueCover(f); // a full disk only means no offline copy
      return blob;
    } catch (e) {
      if (!cachedInfo || (e && e.name === 'AbortError')) throw e;
      console.warn(e);
    }
  }
  if (cachedInfo) {
    const b = await cache.getPdf(f.id);
    if (b) {
      // (the same version made by an older converter is still that version)
      if (cachedInfo.modifiedTime === f.modifiedTime) return b;
      toast(navigator.onLine ? t('staleOnline') : t('staleOffline'));
      b.staleVersion = cachedInfo.modifiedTime; // an older version: read it as that one
      return b;
    }
  }
  if (!navigator.onLine) throw new Error(t('errOfflineNoCopy'));
  const err = new Error(t('errDriveExpired'));
  err.auth = true;
  throw err;
}

/** Store a downloaded note for offline use. Returns false (and keeps going) when storage fails. */
let storageFullWarned = false;
async function cachePdf(f, blob) {
  if (f.source === 'github' && !ghLibrary.get().files[f.id]) return false; // its repository was removed meanwhile
  if (cloudOf(f) && !cloudLibrary.get(f.source).files[f.id]) return false; // its folder was removed meanwhile
  try {
    await cache.putPdf(f.id, blob, f.modifiedTime);
    // Disconnected or removed while it was being written: it doesn't stay.
    const c = cloudOf(f) ? cloudLibrary.get(f.source) : null;
    if ((f.source === 'github' && !ghLibrary.get().files[f.id]) || (c && !c.files[f.id] && !(c.pending || {})[f.id])) {
      await cache.remove(f.id).catch(() => {});
      return false;
    }
    return true;
  } catch (e) {
    console.warn('offline copy not saved', f.name, e);
    if (!storageFullWarned && e && e.name === 'QuotaExceededError') {
      storageFullWarned = true;
      toast(t('storageFull'), { duration: 5000 });
    }
    return false;
  }
}

// ====================================================================== covers
const coverURLs = new Map(); // id -> {url, modifiedTime}
const coverQueue = [];
let coverBusy = false;

const coverLoads = new Map(); // id -> pending lookup, so two cells of one note share one object URL
async function coverURL(f) {
  const mem = coverURLs.get(f.id);
  if (mem) return mem;
  if (!coverLoads.has(f.id)) {
    coverLoads.set(f.id, idb.get('covers', f.id).catch(() => null).then((rec) => {
      coverLoads.delete(f.id);
      if (!rec) return null;
      if (coverURLs.has(f.id)) return coverURLs.get(f.id);
      const v = { url: URL.createObjectURL(rec.blob), modifiedTime: rec.modifiedTime, pages: rec.pages };
      coverURLs.set(f.id, v);
      return v;
    }));
  }
  return coverLoads.get(f.id);
}

function queueCover(f) {
  if (!coverQueue.some((x) => x.id === f.id)) coverQueue.push(f);
  pumpCovers();
}

async function pumpCovers() {
  if (coverBusy) return;
  coverBusy = true;
  try {
    while (coverQueue.length) {
      const f = coverQueue.shift();
      try {
        const existing = await idb.get('covers', f.id);
        if (existing && existing.modifiedTime === f.modifiedTime) continue;
        let blob;
        if (f.source === 'demo') blob = await (await fetch(f.url)).blob();
        else if (f.source === 'local' || cache.isFresh(f)) blob = await cache.getPdf(f.id);
        if (!blob) continue;
        const { blob: jpeg, pages } = await makeCover(blob);
        await idb.put('covers', f.id, { blob: jpeg, modifiedTime: f.modifiedTime, pages });
        const old = coverURLs.get(f.id);
        if (old) URL.revokeObjectURL(old.url);
        coverURLs.delete(f.id);
        refreshCells(f.id);
      } catch (e) {
        console.warn('cover failed', f.name, e);
      }
    }
  } finally {
    coverBusy = false;
  }
}

async function fillCover(cell, f) {
  const img = $('img', cell);
  if (!img) return;
  // (no inline onload/onerror: the Content-Security-Policy allows only our own scripts)
  img.onload = () => img.parentNode.classList.add('has-img');
  img.onerror = () => img.removeAttribute('src');
  const c = await coverURL(f);
  if (c) {
    img.src = c.url;
    if (c.pages) {
      const pc = $('.pagecount', cell);
      if (pc) pc.textContent = t('pagesCount', { n: c.pages });
    }
    if (c.modifiedTime !== f.modifiedTime && (!remote(f) || cache.isFresh(f))) queueCover(f);
    return;
  }
  if (!remote(f) || cache.isFresh(f)) queueCover(f);
  else if (f.thumb && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(f.thumb)) {
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.removeAttribute('src'); thumbsExpired(); };
    img.src = f.thumb;
  }
}

/**
 * Drive's preview links last only hours and the changes list doesn't renew them for notes that
 * didn't change: when one fails, read the folders in full at the next sync (soon).
 */
let thumbsRenewedAt = 0;
function thumbsExpired() {
  if (Date.now() - thumbsRenewedAt < 10 * 60_000) return;
  thumbsRenewedAt = Date.now();
  // Only when the links are old enough to have expired: a preview that fails for another reason
  // (blocked, needs sign-in) must not make every sync read all folders.
  const cur = kv.get('cursors', null);
  if (!cur || Date.now() - (cur.fullAt || 0) < 3 * 3600_000) return;
  kv.set('cursors', { ...cur, fullAt: 0 });
  setTimeout(() => sync(), 3000);
}

// ====================================================================== background download
let prefetching = false;
const GH_PREFETCH_MAX = 150 * 1024 * 1024;
const PREFETCH_CONVERT_MAX = 15 * 1024 * 1024; // larger Word documents are converted only when opened
let prefetchAgain = false; // notes found while a prefetch was running: one more round after it
async function prefetch() {
  if (prefetching) { prefetchAgain = true; return; }
  if (!navigator.onLine) return;
  prefetching = true;
  try {
    const files = sortItems(Object.values(allFiles()).filter(remote));
    let driveFailed = false; // signed out: the GitHub notes can still come
    const cloudFailed = new Set(); // clouds signed out meanwhile
    for (const f of files) {
      if (cache.isFresh(f)) { queueCover(f); continue; }
      if (!canAutoDownload() || !canFetch(f) || (driveFailed && f.source === 'drive') || cloudFailed.has(f.source)) continue;
      if (f.source === 'github' && f.size > GH_PREFETCH_MAX) continue; // someone else's big file: only when opened
      if (converted(f) && (skipConvert(f) || f.size > PREFETCH_CONVERT_MAX)) continue; // a document that can't (or would take long to) be converted: only when opened
      status.detail = t('downloadingNote', { name: f.name });
      renderStatus();
      try {
        const blob = await fetchRemote(f, { background: true, onProgress: (p, stage) => {
          const detail = stage === 'convert' ? t('convertingName', { name: f.name }) : t('downloadingNote', { name: f.name });
          if (status.detail !== detail) { status.detail = detail; renderStatus(); }
        } });
        if (!(await cachePdf(f, blob))) break; // storage full: stop downloading the rest
        queueCover(f);
        refreshCells(f.id);
      } catch (e) {
        console.warn('prefetch failed', f.name, e);
        if (e instanceof drive.AuthError) driveFailed = true;
        if (e instanceof AuthError && cloudOf(f)) cloudFailed.add(f.source);
      }
    }
  } finally {
    prefetching = false;
    if (prefetchAgain) { prefetchAgain = false; setTimeout(prefetch, 0); }
    status.detail = '';
    renderStatus();
  }
}

// ====================================================================== sync
function markReauth(v) {
  status.reauth = v;
  kv.set('needsReauth', v);
}

let lastNativeSilent = 0;
function trySilentAuth() {
  if (NATIVE) {
    // Same guard as the web redirect: at most one silent attempt every 2 minutes, so a token
    // that Drive keeps rejecting can't cause a sync → 401 → re-auth → sync loop.
    if (Date.now() - lastNativeSilent < 120_000) return false;
    lastNativeSilent = Date.now();
    drive.nativeAuthorize(false).then((r) => {
      markReauth(!r.ok);
      if (r.ok) sync();
      else renderStatus();
    });
    return true;
  }
  // Avoid redirect loops: at most one silent attempt every 2 minutes.
  const last = Number(sessionStorage.getItem('gnv.silentAt') || 0);
  if (Date.now() - last < 120_000) return false;
  sessionStorage.setItem('gnv.silentAt', String(Date.now()));
  drive.startAuth({ silent: true, returnTo: location.hash });
  return true;
}

let resyncPending = false; // the folders changed while a sync was running
async function sync({ manual = false } = {}) {
  syncOthers({ manual });
  if (status.syncing) { if (sourcesSig() !== syncingSig) resyncPending = true; return; }
  const driveWanted = manual && !settings.ghRepos.length && !anyCloudOn(); // GitHub or another cloud alone need no Google sign-in
  if (!configured()) { if (driveWanted) openSetupGuide(); return; }
  if (!drive.isConnected()) { if (driveWanted) connectDrive(); return; }
  if (!navigator.onLine) { if (manual) toast(t('offlineNow')); renderStatus(); return; }
  if (settings.syncWifiOnly && !onWifi()) {
    if (!manual) { status.waitWifi = true; renderStatus(); return; }
    const ok = await dialog({ title: t('wifiTitle'), message: t('wifiMsg'), okText: t('sync') });
    if (!ok) return;
  }
  status.waitWifi = false;
  if (!drive.hasValidToken() && !NATIVE) {
    if (viewer.isOpen && !manual) return; // don't yank the reader away with a redirect
    if (manual) sessionStorage.removeItem('gnv.silentAt');
    if (!trySilentAuth() && manual) connectDrive();
    return;
  }
  if (!settings.sources.length) {
    if (!rootPickerOpen) await pickRootAutomatically();
    if (!settings.sources.length) return;
  }
  status.syncing = true;
  status.error = '';
  status.detail = '';
  renderStatus();
  try {
    if (!drive.account()) drive.fetchAccount().then(() => currentRoute && currentRoute.tab === 'settings' && render()).catch(() => {});
    const sources = settings.sources.slice();
    const sig = sourcesSig(sources);
    syncingSig = sig;
    const prev = snapshot();
    const { folders, files, failed, saveCursors } = await readLibrary(sources, prev, sig);
    if (!drive.isConnected()) return; // disconnected while reading: nothing of it is kept
    if (sourcesSig() !== sig) { resyncPending = true; return; } // folders changed meanwhile: read them again
    carryOverReplaced(prev.files || {}, files);
    // The places are kept only once the library they lead on from is stored.
    if (library.set({ sig, folders, files, syncedAt: Date.now() })) saveCursors();
    if (failed.length) {
      status.error = t('acctFailed', { email: joinList(failed.map((x) => x.acct)) });
      if (manual) toast(status.error);
    }
    sendWidget(); // names may have changed, notes may be gone
    markReauth(false);
    // Drop offline copies of notes that were deleted from Drive.
    sweepGone((id) => !/^(local|demo|gh):/.test(id) && !CLOUD_ID.test(id) && !files[id]);
    if (currentRoute && !currentRoute.doc) render({ keepScroll: true });
    offerNewVersion(files);
    pushBackgroundConfig({ listed: true, failed });
    maybeAskNotifications();
    await importBackgroundUpdates(); // reuse files the background check already downloaded
    prefetch();
  } catch (e) {
    console.error(e);
    if (e instanceof drive.AuthError) {
      if (!viewer.isOpen && trySilentAuth()) return;
      markReauth(true);
    } else {
      status.error = e.message || String(e);
      if (manual) toast(status.error);
    }
  } finally {
    status.syncing = false;
    syncingSig = null;
    renderStatus();
    if (resyncPending) { resyncPending = false; sync({ manual }); }
  }
}
let syncingSig = null;

/** Delete what is stored for notes that are gone: offline copies, handwriting, chapter lists. */
function sweepGone(gone) {
  for (const id of cache.ids()) if (gone(id)) cache.remove(id);
  idb.keys('ocr').then((ids) => { // also what was read of notes never saved offline
    for (const id of ids) if (typeof id === 'string' && gone(id)) idb.del('ocr', id).catch(() => {});
  }).catch(() => {});
  idb.keys('texts').then((keys) => {
    for (const k of keys) {
      const id = typeof k === 'string' && /^(toc|fp):/.test(k) ? k.slice(k.indexOf(':') + 1) : null; // chapters, page prints
      if (id && gone(id)) idb.del('texts', k).catch(() => {});
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------- GitHub
let ghResync = false;

/**
 * Check the GitHub repositories: every 15 minutes (less often with many repositories, see
 * github.checkInterval), and at most every 30 seconds when pulled down.
 */
async function syncGithub({ manual = false, force = false } = {}) {
  if (!settings.ghRepos.length) return;
  if (status.ghSyncing) { ghResync = ghResync || force; return; }
  const repos = settings.ghRepos.slice();
  const sig = github.reposSig(repos);
  const lib = ghLibrary.get();
  const age = Date.now() - (lib.checkedAt || 0);
  if (!force && lib.sig === sig && age < (manual ? 30_000 : github.checkInterval(repos, lib.states))) {
    if (manual && ghProblem()) toast(ghProblem()); // a red chip tapped right after a failure
    return;
  }
  if (!navigator.onLine) return;
  if (settings.syncWifiOnly && !onWifi() && !manual && !force) return;
  const until = github.limitedUntil();
  if (until) {
    // Normal and temporary: the chip stays calm, the reason comes when the user asks.
    if (manual || force) toast(new github.RateLimitError(until).message, { duration: 5000 });
    return;
  }
  status.ghSyncing = true;
  renderStatus();
  try {
    const r = await github.checkAll(repos, lib);
    if (github.reposSig(settings.ghRepos) !== sig) { ghResync = true; return; } // changed meanwhile
    // Only when GitHub couldn't be reached at all is it tried again soon; any answer counts as a check.
    const offline = r.failed.length === repos.length && r.failed.every((x) => x.error instanceof github.NetworkError);
    ghLibrary.set({ sig, folders: r.folders, files: r.files, states: r.states, checkedAt: offline ? lib.checkedAt || 0 : Date.now() });
    status.ghErrors = {};
    for (const x of r.failed) {
      const quiet = x.error instanceof github.RateLimitError || x.error instanceof github.NetworkError;
      status.ghErrors[github.repoKey(x.entry)] = { msg: ghErrorText(x), quiet };
    }
    if ((manual || force) && r.failed.length) toast(ghErrorText(r.failed[0]), { duration: 5000 });
    sweepGone((id) => id.startsWith('gh:') && !r.files[id]);
    if (currentRoute && !currentRoute.doc) render({ keepScroll: true });
    offerNewVersion(r.files);
    sendWidget();
    pushBackgroundConfig();
    prefetch();
  } catch (e) {
    console.warn('GitHub', e);
  } finally {
    status.ghSyncing = false;
    renderStatus();
    if (ghResync) { ghResync = false; syncGithub({ force: true }); }
  }
}

/** What went wrong with one repository, for a toast and its row in Settings. */
function ghErrorText({ entry, error }) {
  if (error instanceof github.RateLimitError || error instanceof github.NetworkError) return error.message;
  const name = github.repoName(entry); // toasts escape
  if (error instanceof github.NotFoundError) return t('ghGone', { name });
  return t('ghFailed', { name, msg: error.message || String(error) });
}

/** A GitHub problem worth a red chip: not the rate limit or being offline, which pass by themselves. */
function ghProblem() {
  const errs = status.ghErrors || {};
  const found = settings.ghRepos.map((e) => errs[github.repoKey(e)]).find((x) => x && !x.quiet);
  return found ? found.msg : '';
}

function ghRowError(e) {
  const err = (status.ghErrors || {})[github.repoKey(e)];
  return err ? `<small class="${err.quiet ? '' : 'err'}">${esc(err.msg)}</small>` : '';
}

/** Settings → GitHub → 저장소 추가: paste a link, check it, add it. */
async function addRepo(prefill = '') {
  if (settings.ghRepos.length >= github.MAX_REPOS) { toast(t('ghTooMany', { n: github.MAX_REPOS })); return; }
  const v = await dialog({
    title: t('ghAddTitle'),
    message: t('ghAddMsg'),
    input: prefill,
    placeholder: t('ghPlaceholder'),
    url: true,
    okText: t('ghAddOk'),
  });
  if (v === null || !v.trim()) return;
  // Something went wrong: say why, then offer the dialog again with what was typed.
  const retry = (msg) => { toast(msg, { duration: 6000 }); setTimeout(() => addRepo(v), 400); };
  let e = github.parseRepoUrl(v);
  if (!e) { retry(t('ghBadUrl')); return; }
  if (e.only === 'releases' && !NATIVE) { toast(t('ghReleaseWeb'), { duration: 5000 }); return; }
  if (!navigator.onLine) { toast(t('noInternet')); return; }
  toast(t('ghChecking'), { duration: 30_000 }); // the answer replaces it
  let r;
  let key;
  try {
    e = await github.resolveRef(e, { file: /\/blob\//.test(v) }); // a branch named "a/b"
    key = github.repoKey(e);
    if (settings.ghRepos.some((x) => github.repoKey(x) === key)) { toast(t('ghAlready')); return; }
    r = await github.checkRepo(e);
  } catch (err) {
    if (err instanceof github.NotFoundError) retry(t('ghNotFound'));
    else toast(err.message || String(err), { duration: 6000 });
    return;
  }
  if (settings.ghRepos.some((x) => github.repoKey(x) === key)) return; // added twice in a hurry
  saveSettings({ ghRepos: [...settings.ghRepos, e] });
  const lib = ghLibrary.get();
  ghLibrary.set({
    sig: github.reposSig(settings.ghRepos),
    folders: { ...lib.folders, ...r.folders },
    files: { ...lib.files, ...r.files },
    states: { ...lib.states, [key]: r.state },
    checkedAt: lib.checkedAt || Date.now(),
  });
  const n = Object.keys(r.files).length;
  const name = github.repoName(e);
  toast(n ? t('ghAdded', { n, name }) : t('ghAddedNone', { name }), { duration: 5000 });
  render({ keepScroll: true });
  pushBackgroundConfig();
  maybeAskNotifications();
  prefetch();
}

function repoMenu(i) {
  const e = settings.ghRepos[i];
  if (!e) return;
  actionSheet({
    title: github.repoName(e),
    subtitle: github.repoLabel(e),
    items: [
      { label: t('syncNow'), icon: 'sync', onClick: () => syncGithub({ force: true }) },
      { label: t('removeFolder'), icon: 'trash', danger: true, onClick: () => removeRepo(i) },
    ],
  });
}

async function removeRepo(i) {
  const e = settings.ghRepos[i];
  if (!e) return;
  const ok = await dialog({ title: t('removeFolder'), message: t('ghRemoveMsg', { name: github.repoName(e) }), okText: t('removeFolder'), danger: true });
  if (!ok || settings.ghRepos[i] !== e) return;
  const key = github.repoKey(e);
  saveSettings({ ghRepos: settings.ghRepos.filter((x) => x !== e) });
  const lib = ghLibrary.get();
  const keep = (map) => Object.fromEntries(Object.entries(map || {}).filter(([, x]) => x.repo !== key));
  const states = { ...lib.states };
  delete states[key];
  ghLibrary.set({ ...lib, sig: github.reposSig(settings.ghRepos), folders: keep(lib.folders), files: keep(lib.files), states });
  const files = ghLibrary.get().files;
  sweepGone((id) => id.startsWith('gh:') && !files[id]);
  pushBackgroundConfig();
  sendWidget();
  render({ keepScroll: true });
}

// ---------------------------------------------------------------------- other clouds
// OneDrive, Dropbox, NAVER MYBOX and WebDAV, all read only and all in the Android app. Each cloud
// module (see cloud.js) knows its own API; what's here is shared: chosen folders, the stored
// library of each cloud, when to look, and what to do with what was found.
const CLOUDS = { onedrive, dropbox, mybox, webdav };
const CLOUD_KEYS = Object.keys(CLOUDS);
const CLOUD_FULL_EVERY = 24 * 3600_000; // with a changes list: still read in full once a day
const cloudResync = {};
const cloudSigningIn = {};
status.cloudSyncing = {};
status.cloudError = {};
migrateOneDrive();
settings.clouds = cleanClouds(settings.clouds);

/**
 * 1.19 moved OneDrive's chosen folders and its notes into the store all clouds share. A phone that
 * last ran 1.18 still has them under the old names: they move over (same note ids, so offline
 * copies, bookmarks and reading places stay), and only then are the old ones removed.
 */
function migrateOneDrive() {
  let old = null;
  try { old = JSON.parse(localStorage.getItem('gnv.odlib') || 'null'); } catch { old = null; }
  const chosen = Array.isArray(settings.odFolders) ? settings.odFolders : null;
  if (!chosen && !old) return;
  const clouds = { ...(settings.clouds || {}) };
  if (chosen && chosen.length && !(Array.isArray(clouds.onedrive) && clouds.onedrive.length)) clouds.onedrive = chosen;
  const cur = cloudLibrary.get('onedrive');
  if (old && old.files && typeof old.files === 'object' && !Object.keys(cur.files || {}).length) {
    const folders = {};
    for (const [id, d] of Object.entries(old.folders || {})) {
      if (d && typeof d === 'object' && id.startsWith('odf:')) folders[id] = { ...d, rid: id.slice(4), croot: d.odRoot || id.slice(4) };
    }
    const files = {};
    for (const [id, f] of Object.entries(old.files)) {
      if (f && typeof f === 'object' && id.startsWith('od:')) files[id] = { ...f, source: 'onedrive', rid: f.od || id.slice(3), croot: f.odRoot };
    }
    // (read in full at the next look: the old one kept no changes cursor of this store's kind)
    // (and the notes 1.18 was still waiting to see gone: their offline copies stay too)
    const pending = {};
    for (const [id, f] of Object.entries(old.pending && typeof old.pending === 'object' ? old.pending : {})) {
      if (f && typeof f === 'object' && id.startsWith('od:')) pending[id] = { ...f, source: 'onedrive', rid: f.od || id.slice(3), croot: f.odRoot };
    }
    if (!cloudLibrary.set('onedrive', { ...cur, sig: String(old.sig || ''), acct: String(old.acct || ''), folders, files, link: '', fullAt: 0, checkedAt: 0, errors: {}, pending, truncated: !!old.truncated })) return;
  }
  settings.clouds = clouds;
  delete settings.odFolders;
  saveSettings({ clouds });
  try { localStorage.removeItem('gnv.odlib'); } catch { /* (it is read again next time) */ }
}

// 1.20: Word documents are notes too, 1.21: Hangul ones (.hwpx), 1.22: older Hangul ones (.hwp).
// Changes lists only report files that change, so read every source in full once to find the
// documents already there.
if (kv.get('formatScan', 0) < 3) {
  kv.set('formatScan', 3);
  const cur = kv.get('cursors', null);
  if (cur) kv.set('cursors', { ...cur, fullAt: 0 });
  for (const k of CLOUD_KEYS) {
    const c = cloudLibrary.get(k);
    if (c && c.sig) cloudLibrary.set(k, { ...c, fullAt: 0 });
  }
  const gh = ghLibrary.get();
  if (gh && gh.states) {
    const states = {};
    for (const [key, st] of Object.entries(gh.states)) states[key] = { ...st, head: null };
    ghLibrary.set({ ...gh, states, checkedAt: 0 });
  }
}

const cloudOf = (f) => (f && CLOUDS[f.source] ? f.source : null);
/** A cloud's name in a few letters (folder cells): MYBOX, WebDAV, Dropbox, OneDrive. */
const shortCloud = (k) => ({ onedrive: 'OneDrive', dropbox: 'Dropbox', mybox: 'MYBOX', webdav: 'WebDAV' }[k] || '');
/** Which cloud a folder of the library belongs to (by its id's prefix). */
const cloudKeyOfFolder = (d) => CLOUD_KEYS.find((k) => d && typeof d.id === 'string' && d.id.startsWith(CLOUDS[k].PREFIX + 'f:'));
/** Ids of notes and folders of the other clouds ('od:…', 'odf:…', 'dbx:…'…). */
const CLOUD_ID = new RegExp('^(' + CLOUD_KEYS.map((k) => CLOUDS[k].PREFIX + 'f?').join('|') + '):');
const fileId = (k, rid) => CLOUDS[k].PREFIX + ':' + rid;
const folderId = (k, rid) => CLOUDS[k].PREFIX + 'f:' + rid;
const isCloudFile = (k, id) => id.startsWith(CLOUDS[k].PREFIX + ':');

function cloudFolders(k) {
  const all = settings.clouds && typeof settings.clouds === 'object' ? settings.clouds : {};
  return Array.isArray(all[k]) ? all[k] : [];
}
function setCloudFolders(k, list) {
  saveSettings({ clouds: { ...(settings.clouds || {}), [k]: cleanCloudFolders(list) } });
}
function cleanCloudFolders(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 1000 || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({ id: x.id, name: String(x.name || '').slice(0, 200) });
  }
  return out.slice(0, MAX_CLOUD_FOLDERS);
}
function cleanClouds(all) {
  const out = {};
  for (const k of CLOUD_KEYS) if (all && Array.isArray(all[k])) out[k] = cleanCloudFolders(all[k]);
  return out;
}
const cloudSig = (k) => cloudFolders(k).map((x) => x.id).join('\n');
/** Who the cloud's account is: its e-mail; for WebDAV the user at the server. */
const accountKey = (k, a) => (k === 'webdav' ? (a.name || '') + '@' + (a.email || '') : a.email || '');

/** This cloud's folders are chosen (whether or not its account still works). */
function cloudOn(k) {
  return cloudFolders(k).length > 0 && !!CLOUDS[k].account();
}
const anyCloudOn = () => CLOUD_KEYS.some(cloudOn);
function cloudUsable(k) {
  const a = CLOUDS[k].account();
  return navigator.onLine && !!a && !a.reauth;
}
const reauthText = (k) => (k === 'mybox' ? t('myboxReauth') : k === 'webdav' ? t('webdavReauth') : t('cloudReauth', { name: CLOUDS[k].label() }));

/** A problem worth a red chip (being offline or the cloud being busy pass by themselves). */
function cloudProblem(k) {
  if (!cloudOn(k)) return '';
  const a = CLOUDS[k].account();
  if (a && a.reauth) return reauthText(k);
  if (status.cloudError[k]) return status.cloudError[k];
  const errs = cloudLibrary.get(k).errors || {};
  const x = cloudFolders(k).find((y) => errs[y.id] && !errs[y.id].quiet);
  if (!x) return '';
  return errs[x.id].gone ? t('cloudFolderGoneName', { name: x.name, cloud: CLOUDS[k].label() }) : errs[x.id].msg;
}
function anyCloudProblem() {
  for (const k of CLOUD_KEYS) { const p = cloudProblem(k); if (p) return { k, p }; }
  return null;
}

/**
 * Every chosen folder of one cloud read in full. One that can't be read keeps what was seen last
 * time (gone: its notes go). {folders, files, errors: {folder id: {msg, quiet, gone}}, truncated}.
 */
async function readCloud(k, chosen, prev) {
  const mod = CLOUDS[k];
  const folders = {};
  const files = {};
  const errors = {};
  let truncated = false;
  const budget = newBudget();
  const failed = [];
  const partial = new Set(); // folders not read in full (the limits): what was in them stays
  for (const c of chosen) {
    const rootKey = folderId(k, c.id);
    folders[rootKey] = { id: rootKey, name: c.name, parent: ROOT, croot: c.id, rid: c.id, modifiedTime: '' };
    try {
      // Another chosen folder inside this one is listed on its own, not twice.
      const stopAt = new Set(chosen.filter((x) => x.id !== c.id).map((x) => x.id));
      const r = await mod.listTree(c.id, { stopAt, budget });
      truncated = truncated || r.truncated;
      if (typeof r.rootPath === 'string') folders[rootKey].p = r.rootPath;
      for (const id of r.partial) partial.add(folderId(k, id));
      for (const d of r.folders) {
        const id = folderId(k, d.id);
        folders[id] = { id, name: d.name, parent: folderId(k, d.parent), croot: c.id, rid: d.id, modifiedTime: '' };
      }
      for (const f of r.files) {
        const id = fileId(k, f.id);
        files[id] = { id, name: baseName(f.name), parent: folderId(k, f.parent), modifiedTime: f.modified, size: f.size, source: k, rid: f.id, croot: c.id };
        if (formatOf(f.name) !== 'pdf') files[id].fmt = formatOf(f.name);
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      const quiet = e instanceof NetworkError || e instanceof BusyError;
      const gone = e instanceof NotFoundError;
      errors[c.id] = { msg: gone ? t('cloudFolderGone', { name: mod.label() }) : e.message || String(e), quiet, gone };
      failed.push(e);
      if (!gone) keepCloudRoot(k, prev, c.id, folders, files);
    }
  }
  // Offline or busy for every folder: nothing was learnt, nothing is stored.
  if (failed.length === chosen.length && failed.every((e) => e instanceof NetworkError || e instanceof BusyError)) throw failed[0];
  // An incomplete list (too many files) doesn't mean the notes left out were deleted: the notes
  // below a folder that wasn't read in full stay.
  if (partial.size) {
    const below = (f) => {
      for (let p = f.parent, n = 0; p && n < 100; p = prev.folders && prev.folders[p] ? prev.folders[p].parent : null, n++) if (partial.has(p)) return true;
      return false;
    };
    for (const f of Object.values(prev.files || {})) {
      if (files[f.id] || !folders[folderId(k, f.croot)] || !below(f)) continue;
      files[f.id] = f;
      for (let p = f.parent; p && !folders[p] && prev.folders && prev.folders[p]; p = prev.folders[p].parent) folders[p] = prev.folders[p];
    }
  }
  return { folders, files, errors, truncated };
}

/**
 * What was below a chosen folder that can't be read now, by where it was (not by which chosen
 * folder listed it: a folder just chosen inside another one keeps what the outer one showed).
 */
function keepCloudRoot(k, prev, root, folders, files) {
  const rootKey = folderId(k, root);
  const pf = prev.folders || {};
  const under = (p) => {
    for (let n = 0; p && n < 200; n++) {
      if (p === rootKey) return true;
      p = pf[p] ? pf[p].parent : null;
    }
    return false;
  };
  for (const [id, d] of Object.entries(pf)) if (id !== rootKey && !folders[id] && under(d.parent)) folders[id] = { ...d, croot: root };
  for (const [id, f] of Object.entries(prev.files || {})) if (!files[id] && under(f.parent)) files[id] = { ...f, croot: root };
}

/**
 * Check one cloud. With a changes list (OneDrive, Dropbox) usually one request; the chosen folders
 * are read in full only when something in them changed, they were changed, once a day, or when
 * the list can't go on. Without one (MYBOX, WebDAV) they are read in full, at most every
 * CHECK_EVERY by themselves (MANUAL_EVERY when pulled down).
 */
async function syncCloud(k, { manual = false, force = false } = {}) {
  const mod = CLOUDS[k];
  const acc = mod.account();
  const chosen = cloudFolders(k);
  if (!acc || !chosen.length) return;
  if (acc.reauth) {
    if (manual) toast(reauthText(k), { action: t('reconnect'), onAction: () => connectCloud(k, { reauth: true }), duration: 8000 });
    renderStatus();
    return;
  }
  if (status.cloudSyncing[k]) { cloudResync[k] = cloudResync[k] || force || manual; return; }
  const lib = cloudLibrary.get(k);
  const sig = cloudSig(k);
  const fresh = lib.sig === sig && lib.acct === accountKey(k, acc);
  if (!force && fresh && Date.now() - (lib.checkedAt || 0) < (manual ? mod.MANUAL_EVERY : mod.CHECK_EVERY)) return;
  if (!navigator.onLine) return;
  if (settings.syncWifiOnly && !onWifi() && !manual) return;
  status.cloudSyncing[k] = true;
  renderStatus();
  try {
    let link = '';
    if (mod.changes) {
      // A folder that couldn't be read last time is read again in full (its changes are not in the list any more).
      const unread = Object.values(lib.errors || {}).some((x) => x && !x.gone);
      let full = force || !fresh || unread || !lib.link || Date.now() - (lib.fullAt || 0) > CLOUD_FULL_EVERY;
      if (!full) {
        try {
          const r = await mod.changes(lib.link);
          if (r.more || mod.relevant(r.items, lib, chosen)) full = true;
          else {
            if (cloudSig(k) === sig) cloudLibrary.set(k, { ...cloudLibrary.get(k), link: r.link, checkedAt: Date.now() });
            status.cloudError[k] = '';
            if (manual && cloudProblem(k)) toast(cloudProblem(k), { duration: 6000 });
            return;
          }
        } catch (e) {
          // Too old or refused: start again from a full read (offline, busy or signed out: later).
          if (e instanceof AuthError || e instanceof NetworkError || e instanceof BusyError) throw e;
        }
      }
      // Where the changes list stands, taken before reading: what changes meanwhile shows next time.
      link = await mod.latestLink();
    }
    // What was there before stays where a folder can't be read now (same account only).
    const same = lib.acct === accountKey(k, acc);
    const r = await readCloud(k, chosen.slice(), same ? lib : { folders: {}, files: {} });
    const now = mod.account();
    if (cloudSig(k) !== sig || !now || accountKey(k, now) !== accountKey(k, acc)) { cloudResync[k] = true; return; } // changed meanwhile
    // A note missing from this read keeps its offline copy until a read where every folder was
    // read in full agrees: listing a folder isn't a snapshot (a note moved meanwhile from a folder
    // not read yet to one already read is in neither list).
    const complete = !Object.keys(r.errors).length && !r.truncated;
    const pending = {};
    for (const [id, f] of Object.entries(same ? lib.files || {} : {})) if (!r.files[id]) pending[id] = f;
    if (!complete) for (const [id, f] of Object.entries(same ? lib.pending || {} : {})) if (!r.files[id] && !pending[id]) pending[id] = f;
    cloudLibrary.set(k, { sig, acct: accountKey(k, acc), folders: r.folders, files: r.files, link, fullAt: Date.now(), checkedAt: Date.now(), errors: r.errors, truncated: r.truncated, pending });
    status.cloudError[k] = '';
    const shown = Object.values(r.errors).find((x) => !x.quiet) || Object.values(r.errors)[0];
    if (manual && shown) toast(cloudProblem(k) || shown.msg, { duration: 6000 });
    else if (manual && r.truncated) toast(t('cloudTruncated'), { duration: 5000 });
    sweepGone((id) => isCloudFile(k, id) && !r.files[id] && !pending[id]);
    if (currentRoute && !currentRoute.doc) render({ keepScroll: true });
    offerNewVersion(r.files);
    sendWidget();
    pushBackgroundConfig();
    prefetch();
  } catch (e) {
    if (e instanceof AuthError) {
      status.cloudError[k] = reauthText(k);
      if (manual) toast(reauthText(k), { action: t('reconnect'), onAction: () => connectCloud(k, { reauth: true }), duration: 8000 });
      if (currentRoute && currentRoute.tab === 'settings') render({ keepScroll: true });
    } else if (e instanceof NetworkError || e instanceof BusyError) {
      if (manual) toast(e.message);
    } else {
      status.cloudError[k] = e.message || String(e);
      if (manual) toast(status.cloudError[k]);
    }
    console.warn(k, e);
  } finally {
    status.cloudSyncing[k] = false;
    renderStatus();
    if (cloudResync[k]) { cloudResync[k] = false; syncCloud(k, { force: true }); }
  }
}

/** GitHub and the other clouds: none needs Google. */
function syncOthers(opts = {}) {
  syncGithub(opts);
  for (const k of CLOUD_KEYS) syncCloud(k, opts);
}

/**
 * Connect a cloud: OneDrive and Dropbox sign in in the browser; MYBOX asks for a personal access
 * token; WebDAV for the server address, user name and app password. A different account than
 * before starts with no folders. Signed in already (the picker was closed): choose a folder.
 */
let lastDav = { url: '', user: '' };
async function connectCloud(k, { reauth = false } = {}) {
  const mod = CLOUDS[k];
  if (!mod.available() || cloudSigningIn[k]) return;
  const before = mod.account();
  if (before && !before.reauth && !reauth) { addCloudFolder(k); return; }
  if (!navigator.onLine) { toast(t('noInternet')); return; }
  cloudSigningIn[k] = true; // a second tap meanwhile opens nothing
  let args = {};
  try {
    if (k === 'mybox') {
      const v = await formDialog({
        title: t('myboxConnectTitle'),
        message: t('myboxConnectMsg'),
        fields: [{ name: 'token', label: t('myboxToken'), type: 'password', placeholder: 'mbx_pat_…', autocomplete: 'off' }],
        okText: t('connect'),
      });
      if (!v || !v.token.trim()) return;
      args = { token: v.token.trim() };
    } else if (k === 'webdav') {
      const v = await formDialog({
        title: t('webdavConnectTitle'),
        message: t('webdavConnectMsg'),
        fields: [
          { name: 'url', label: t('webdavUrl'), type: 'url', placeholder: 'https://cloud.example.com/remote.php/dav/files/me/', value: (before && before.url) || lastDav.url },
          { name: 'user', label: t('webdavUser'), type: 'text', value: (before && before.name) || lastDav.user, autocomplete: 'username' },
          { name: 'pass', label: t('webdavPass'), type: 'password', autocomplete: 'current-password' },
        ],
        okText: t('connect'),
      });
      if (!v) return;
      args = { url: v.url.trim(), user: v.user.trim(), pass: v.pass };
      lastDav = { url: args.url, user: args.user }; // typed again after a mistake: not the password
    }
  } finally {
    cloudSigningIn[k] = false;
  }
  cloudSigningIn[k] = true;
  // Back from the browser: the app is still finishing the sign-in for a moment.
  const back = () => { if (document.visibilityState === 'visible' && cloudSigningIn[k]) toast(t('cloudSigningIn', { name: mod.label() }), { duration: 15000 }); };
  document.addEventListener('visibilitychange', back);
  if (k === 'mybox' || k === 'webdav') toast(t('cloudChecking', { name: mod.label() }), { duration: 15000 });
  let r;
  try {
    r = await mod.connect(args);
  } finally {
    cloudSigningIn[k] = false;
    document.removeEventListener('visibilitychange', back);
  }
  if (!r.ok) {
    if (r.error === 'canceled') return;
    // A WebDAV address that answers, but not as WebDAV (a web page, a redirect, 400/405): the address.
    if (k === 'webdav' && /^http_(200|3\d\d|400|405)$/.test(r.error)) r.error = 'bad_url';
    if (/^http_5\d\d$/.test(r.error)) { toast(t('cloudBusy', { name: mod.label() }), { duration: 7000 }); return; }
    const msg = {
      network_error: t('cloudNetwork', { name: mod.label() }),
      unauthorized: k === 'mybox' ? t('myboxBadToken') : t('webdavBadLogin'),
      bad_token: t('myboxBadToken'),
      bad_url: t('webdavBadUrl'),
      bad_login: t('webdavBadLogin'),
      not_found: t('webdavBadUrl'),
      tls: t('webdavTls'),
    }[r.error] || t('cloudSignInFailed', { name: mod.label() });
    toast(msg, { duration: 7000 });
    return;
  }
  if (k === 'webdav') lastDav = { url: '', user: '' };
  cloudAccountChanged(k, before);
  toast(r.email ? t('cloudConnected', { name: mod.label(), email: r.email }) : t('cloudConnectedPlain', { name: mod.label() }));
  if (!cloudFolders(k).length) addCloudFolder(k);
  else syncCloud(k, { force: true });
}

/** After a sign-in: another account's folders (and notes) don't belong to this one. */
function cloudAccountChanged(k, before) {
  const now = CLOUDS[k].account();
  const lib = cloudLibrary.get(k);
  const was = (before && accountKey(k, before)) || lib.acct;
  if (now && was && was.toLowerCase() !== accountKey(k, now).toLowerCase()) {
    setCloudFolders(k, []);
    cloudLibrary.clear(k);
    sweepGone((id) => isCloudFile(k, id));
  }
  status.cloudError[k] = '';
  pushBackgroundConfig();
  render({ keepScroll: true });
}
// Signed in after the app was restarted (Android closed it while the browser was open).
function cloudSignedInLater(k) {
  cloudAccountChanged(k, null);
  const a = CLOUDS[k].account();
  if (!a) return;
  toast(a.email ? t('cloudConnected', { name: CLOUDS[k].label(), email: a.email }) : t('cloudConnectedPlain', { name: CLOUDS[k].label() }));
  if (!cloudFolders(k).length) addCloudFolder(k);
  else syncCloud(k, { force: true });
}
window.__gnvMsChanged = () => cloudSignedInLater('onedrive');
window.__gnvCloudChanged = (k) => { if (CLOUDS[k]) cloudSignedInLater(k); };

async function disconnectCloud(k) {
  const mod = CLOUDS[k];
  const ok = await dialog({ title: t('cloudDisconnectTitle', { name: mod.label() }), message: t('cloudDisconnectMsg') + '\n' + t('cloudRevoke_' + k), okText: t('disconnect'), danger: true });
  if (!ok) return;
  mod.signOut();
  setCloudFolders(k, []);
  cloudLibrary.clear(k);
  status.cloudError[k] = '';
  sweepGone((id) => isCloudFile(k, id)); // its offline copies go too
  pushBackgroundConfig();
  sendWidget();
  render({ keepScroll: true });
}

function addCloudFolder(k) {
  const mod = CLOUDS[k];
  if (cloudFolders(k).length >= MAX_CLOUD_FOLDERS) { toast(t('cloudTooMany', { n: MAX_CLOUD_FOLDERS, name: mod.label() })); return; }
  const suggestions = mod.findNoteFolders().catch(() => []);
  openFolderPicker(suggestions, null, {
    provider: {
      rootName: mod.rootName(),
      list: (id) => mod.listFolders(id),
      top: mod.topFolder || null, // the real id of the top, where its changes use it
      isAuthError: (e) => e instanceof AuthError,
      onAuthError: () => { status.cloudError[k] = reauthText(k); },
      choose: (f) => {
        const list = cloudFolders(k);
        if (list.some((x) => x.id === f.id)) { toast(t('folderAlready', { name: f.name })); return false; }
        if (list.length >= MAX_CLOUD_FOLDERS) { toast(t('cloudTooMany', { n: MAX_CLOUD_FOLDERS, name: mod.label() })); return false; }
        setCloudFolders(k, [...list, { id: f.id, name: f.name }]);
        toast(t('syncingFolder', { name: f.name }));
        render({ keepScroll: true });
        syncCloud(k, { force: true, manual: true });
        return true;
      },
    },
  });
}

function cloudFolderMenu(k, i) {
  const x = cloudFolders(k)[i];
  if (!x) return;
  const acc = CLOUDS[k].account();
  actionSheet({
    title: x.name,
    subtitle: joinList([CLOUDS[k].label(), acc && acc.email]),
    items: [
      { label: t('syncNow'), icon: 'sync', onClick: () => syncCloud(k, { force: true, manual: true }) },
      { label: t('removeFolder'), icon: 'trash', danger: true, onClick: () => removeCloudFolder(k, x) },
    ],
  });
}

async function removeCloudFolder(k, x) {
  const ok = await dialog({ title: t('removeFolder'), message: t('cloudRemoveMsg', { name: x.name, cloud: CLOUDS[k].label() }), okText: t('removeFolder'), danger: true });
  if (!ok || !cloudFolders(k).some((y) => y.id === x.id)) return;
  setCloudFolders(k, cloudFolders(k).filter((y) => y.id !== x.id));
  const lib = cloudLibrary.get(k);
  const keep = (map) => Object.fromEntries(Object.entries(map || {}).filter(([, v]) => v.croot !== x.id));
  const errors = { ...(lib.errors || {}) };
  delete errors[x.id];
  // Its notes leave the list now; the next check reads the others again (a folder around it may
  // be chosen too and show the same notes), and only then are offline copies of what's gone deleted.
  cloudLibrary.set(k, { ...lib, sig: cloudSig(k), folders: keep(lib.folders), files: keep(lib.files), errors, fullAt: 0 });
  if (!cloudFolders(k).length) sweepGone((id) => isCloudFile(k, id)); // nothing left to show them
  pushBackgroundConfig();
  sendWidget();
  render({ keepScroll: true });
  syncCloud(k, { force: true });
}

/** Which clouds can be added here (in the Android app; OneDrive and Dropbox once registered). */
const addableClouds = () => CLOUD_KEYS.filter((k) => CLOUDS[k].available() && !CLOUDS[k].account());

function addCloud() {
  const ks = addableClouds();
  if (!ks.length) return;
  if (ks.length === 1) { connectCloud(ks[0]); return; }
  actionSheet({
    title: t('cloudAddTitle'),
    subtitle: t('cloudAddSub'),
    items: ks.map((k) => ({ label: t('cloudPick_' + k), icon: 'cloud', onClick: () => connectCloud(k) })),
  });
}

/** Settings → 다른 클라우드: each connected cloud with its folders, and a row to add one. */
function cloudsSection() {
  const shown = CLOUD_KEYS.filter((k) => CLOUDS[k].available() && CLOUDS[k].account());
  const canAdd = addableClouds().length > 0;
  if (!shown.length && !canAdd) return '';
  const block = (k) => {
    const mod = CLOUDS[k];
    const acc = mod.account();
    const errs = cloudLibrary.get(k).errors || {};
    const rowErr = (x) => {
      const e = errs[x.id];
      return e ? `<small class="${e.quiet ? '' : 'err'}">${esc(e.msg)}</small>` : '';
    };
    return `
        <div class="glist-row">
          <span class="glist-ic blue">${icon('cloud')}</span>
          <span class="glist-label">${esc(mod.label())}<small>${esc(joinList([acc.email, acc.name && acc.name !== acc.email ? acc.name : '']) || (k === 'mybox' ? t('myboxToken') : ''))}</small>${acc.reauth ? `<small class="err">${esc(reauthText(k))}</small>` : ''}</span>
          <button class="pill-btn ${acc.reauth ? '' : 'ghost'}" data-a="${acc.reauth ? 'cloudconnect' : 'clouddisconnect'}" data-k="${k}" aria-label="${esc(acc.reauth ? mod.label() + ': ' + t('reconnect') : t('cloudDisconnectTitle', { name: mod.label() }))}">${acc.reauth ? t('reconnect') : t('disconnect')}</button>
        </div>
        ${cloudFolders(k).map((x, i) => `
        <button class="glist-row" data-a="cloudmenu" data-k="${k}" data-i="${i}">
          <span class="glist-ic blue">${icon('folder')}</span>
          <span class="glist-label">${esc(x.name)}<small>${t('noteFolder')}</small>${rowErr(x)}</span>${icon('chevronRight', 'chev')}
        </button>`).join('')}
        <button class="glist-row" data-a="cloudadd" data-k="${k}" ${acc.reauth ? 'disabled' : ''}>
          <span class="glist-ic green">${icon('plus')}</span>
          <span class="glist-label">${t('addFolder')}<small>${t('cloudAddFolderSub', { name: mod.label() })}</small></span>
        </button>
        ${acc.reauth ? `
        <button class="glist-row danger" data-a="clouddisconnect" data-k="${k}">
          <span class="glist-ic red">${icon('x')}</span>
          <span class="glist-label">${esc(t('cloudDisconnectTitle', { name: mod.label() }))}</span>
        </button>` : ''}`;
  };
  return `
      <h3 class="sechead">${t('cloudsTitle')}</h3>
      ${shown.map((k) => `<div class="glist">${block(k)}</div>`).join('<div class="glist-gap"></div>')}
      ${canAdd ? `${shown.length ? '<div class="glist-gap"></div>' : ''}<div class="glist">
        <button class="glist-row" data-a="cloudnew">
          <span class="glist-ic blue">${icon('cloud')}</span>
          <span class="glist-label">${t('cloudAddTitle')}<small>${esc(joinList(addableClouds().map((k) => CLOUDS[k].label())))}</small></span>${icon('chevronRight', 'chev')}
        </button>
      </div>` : ''}
      <p class="muted small pad">${t('cloudsNote')}</p>`;
}

// ---------------------------------------------------------------------- Drive: changes only
const FULL_READ_EVERY = 24 * 3600_000; // a full read now and then, in case anything was missed

/**
 * The library as Drive has it now. Usually only what changed since last time is asked for (one
 * request per account when nothing did), from where each account's changes list stood; the
 * folders are read in full the first time, when the note folders change, once a day, or when
 * the saved place is no longer valid. Returns {folders, files, failed, saveCursors}.
 */
async function readLibrary(sources, prev, sig) {
  const accts = [...new Set(sources.map((x) => x.acct || ''))];
  const cur = kv.get('cursors', null);
  const email = (drive.account() || {}).email || '';
  // The places belong to the accounts they were taken for: another sign-in reads in full.
  const recent = cur && cur.sig === sig && cur.email === email && prev.sig === sig && prev.syncedAt
    && Date.now() - (cur.fullAt || 0) < FULL_READ_EVERY;
  if (recent && accts.every((a) => cur.tokens && cur.tokens[a])) {
    try {
      const r = await applyChanges(sources, prev, cur.tokens);
      return { ...r, saveCursors: () => kv.set('cursors', { ...cur, email, tokens: { ...cur.tokens, ...r.tokens } }) };
    } catch (e) {
      if (e instanceof drive.AuthError) throw e;
      console.warn('changes: reading the folders again', e);
    }
  }
  // Take each account's place first, so what changes during the read is caught next time.
  const tokens = {};
  await Promise.all(accts.map(async (a) => {
    // Without a place the next sync simply reads in full again.
    try { tokens[a] = await drive.startCursor(a); } catch (e) { if (e instanceof drive.AuthError && !a) throw e; }
  }));
  const r = await listSources(sources, prev);
  for (const f of r.failed) delete tokens[f.acct || '']; // read in full again next time
  return { ...r, saveCursors: () => kv.set('cursors', { sig, email, fullAt: r.failed.length ? 0 : Date.now(), tokens }) };
}

/**
 * Apply each account's changes since `tokens` to the library `prev`. A folder that comes into a
 * note folder is read in full (its notes didn't change, so they aren't in the list); one that
 * leaves (moved out, trashed, deleted) takes everything below it along.
 */
async function applyChanges(sources, prev, tokens) {
  const single = sources.length === 1;
  const folders = { ...prev.folders };
  const files = { ...prev.files };
  const failed = [];
  const next = {};
  for (const acct of [...new Set(sources.map((x) => x.acct || ''))]) {
    try {
      next[acct] = await applyAccount(acct, sources, single, folders, files, tokens[acct]);
    } catch (e) {
      if (e instanceof drive.CursorError || !acct) throw e; // the main account: as a full read would
      console.warn('changes of', acct, e);
      failed.push(...sources.filter((x) => (x.acct || '') === acct));
      // Undo what was half applied: this account stays as the last library had it.
      for (const map of [folders, files]) for (const [id, x] of Object.entries(map)) if ((x.acct || '') === acct) delete map[id];
      for (const x of Object.values(prev.folders || {})) if ((x.acct || '') === acct) folders[x.id] = x;
      for (const x of Object.values(prev.files || {})) if ((x.acct || '') === acct) files[x.id] = x;
    }
  }
  return { folders, files, failed, tokens: next };
}

/** One account's changes, applied to `folders`/`files` in place; returns its next place. */
async function applyAccount(acct, sources, single, folders, files, token) {
  {
    const list = await drive.listChanges(token, acct);
    const roots = sources.filter((x) => (x.acct || '') === acct).map((x) => x.root);
    const mine = (x) => x && (x.acct || '') === acct;
    const inside = (id) => roots.includes(id) || mine(folders[id]);
    const placeOf = (driveParent) => (roots.includes(driveParent) ? (single ? ROOT : driveParent) : driveParent);
    const srcOf = (driveParent) => (roots.includes(driveParent) ? driveParent : (folders[driveParent] || {}).src || '');
    const parentIn = (f) => (f && !f.trashed ? (f.parents || []).find(inside) : undefined);
    // Every note folder (any account): one chosen inside another stays even when the folder
    // between them leaves.
    const chosen = new Set(sources.map((x) => x.root));
    const drop = (id) => { // a folder and everything below it, except note folders of their own
      const gone = new Set([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const x of Object.values(folders)) {
          if (!gone.has(x.id) && gone.has(x.parent) && !chosen.has(x.id)) { gone.add(x.id); grew = true; }
        }
      }
      for (const fid of gone) delete folders[fid];
      for (const x of Object.values(files)) if (gone.has(x.parent)) delete files[x.id];
      // A note folder that was inside: back at the top, as its own folder.
      for (const src of sources) {
        const x = folders[src.root];
        if (x && gone.has(x.parent)) folders[src.root] = { id: src.root, name: src.name, parent: ROOT, acct: src.acct, src: src.root };
      }
    };
    const arrived = new Set();
    // Folders first, until nothing moves (a folder may be listed before the one it moved into).
    for (let pass = 0; pass < 20; pass++) {
      let moved = false;
      for (const c of list.changes) {
        const f = c.file;
        const id = c.fileId || (f && f.id);
        if (!id) continue;
        if (roots.includes(id)) {
          // A note folder itself trashed, deleted or brought back: read everything again.
          const empty = !Object.values(files).some((x) => x.src === id) && !Object.values(folders).some((x) => x.src === id && x.id !== id);
          if (c.removed || (f && f.trashed) || empty) throw new drive.CursorError('note folder changed');
          continue;
        }
        const isFolder = f ? f.mimeType === drive.FOLDER_TYPE : !!folders[id];
        if (!isFolder) continue;
        const p = c.removed ? undefined : parentIn(f);
        if (p === undefined) {
          if (mine(folders[id])) { drop(id); moved = true; }
          continue;
        }
        const was = folders[id];
        const now = { id, name: f.name, parent: placeOf(p), modifiedTime: f.modifiedTime, acct, src: srcOf(p) };
        if (!was || was.src !== now.src) arrived.add(id); // new here, or from another note folder: read it in full
        if (!was || was.name !== now.name || was.parent !== now.parent || was.src !== now.src) { folders[id] = now; moved = true; }
      }
      if (!moved) break;
    }
    for (const c of list.changes) {
      const f = c.file;
      const id = c.fileId || (f && f.id);
      if (!id || folders[id] || (f && f.mimeType === drive.FOLDER_TYPE)) continue;
      const fmt = f && driveFormat(f.mimeType, f.name);
      const p = c.removed || !f || !fmt ? undefined : parentIn(f);
      if (p === undefined) { if (mine(files[id])) delete files[id]; continue; }
      const was = files[id] || {};
      files[id] = {
        ...was,
        id,
        name: baseName(f.name),
        fmt: fmt !== 'pdf' ? fmt : undefined,
        parent: placeOf(p),
        modifiedTime: f.modifiedTime,
        size: Number(f.size || 0),
        thumb: f.thumbnailLink || '',
        source: 'drive',
        acct,
        src: srcOf(p),
      };
    }
    // Folders that came in from elsewhere: their notes and sub-folders, read in full (once: not
    // again for a folder inside one that came in too).
    const within = (id) => {
      for (let p = folders[id] && folders[id].parent, n = 0; p && n < 60; p = folders[p] && folders[p].parent, n++) if (arrived.has(p)) return true;
      return false;
    };
    for (const id of arrived) {
      if (!folders[id] || within(id)) continue; // left again in the same batch, or read with its parent
      const tree = await drive.listTree(id, null, acct, { stopAt: chosen });
      const src = folders[id].src;
      for (const x of [...Object.values(tree.folders), ...Object.values(tree.files)]) x.src = src;
      Object.assign(folders, tree.folders);
      Object.assign(files, tree.files);
    }
    return list.next || token;
  }
}

/**
 * Read every note folder. With one folder its contents are the library's top level; with several,
 * each is a folder at the top. A folder of an added account that can't be read now (signed out,
 * offline, removed) keeps what was seen last time and is reported in `failed`.
 */
async function listSources(sources, prev) {
  const single = sources.length === 1;
  const chosen = new Set(sources.map((x) => x.root)); // a note folder inside another is read on its own
  const folders = {};
  const files = {};
  const failed = [];
  let scanned = 0;
  for (const src of sources) {
    try {
      const tree = await drive.listTree(src.root, () => {
        scanned++;
        status.detail = t('foldersScanned', { n: scanned });
        renderStatus();
      }, src.acct, { stopAt: chosen });
      for (const x of [...Object.values(tree.folders), ...Object.values(tree.files)]) {
        x.src = src.root;
        if (x.parent === src.root) x.parent = single ? ROOT : src.root;
      }
      if (!single) folders[src.root] = { id: src.root, name: src.name, parent: ROOT, acct: src.acct, src: src.root };
      Object.assign(folders, tree.folders);
      Object.assign(files, tree.files);
    } catch (e) {
      if (!src.acct) throw e; // the main account: reconnect banner / error as before
      console.warn('folder of', src.acct, e);
      failed.push(src);
      // Keep what was seen last time, also when other folders were added or removed meanwhile
      // (then its top level moves: the library's top with one folder, its own folder with several).
      const mine = (x) => x.src === src.root && (x.acct || '') === (src.acct || '');
      const place = (x) => {
        if (x.parent === ROOT || x.parent === src.root) return { ...x, parent: single ? ROOT : src.root };
        return x;
      };
      if (prev && prev.folders) {
        for (const x of Object.values(prev.folders)) if (mine(x) && x.id !== src.root) folders[x.id] = place(x);
        for (const x of Object.values(prev.files || {})) if (mine(x)) files[x.id] = place(x);
        const seen = Object.values(prev.files || {}).some(mine) || Object.values(prev.folders).some(mine);
        if (!single && seen) folders[src.root] = { id: src.root, name: src.name, parent: ROOT, acct: src.acct, src: src.root };
      }
    }
  }
  // A note folder chosen inside another one stays a folder of its own at the top (reading the
  // outer one also listed it, as a sub-folder).
  if (!single) {
    for (const src of sources) {
      if (folders[src.root]) folders[src.root] = { id: src.root, name: src.name, parent: ROOT, acct: src.acct, src: src.root };
    }
  }
  return { folders, files, failed };
}

/**
 * Some apps back up a note by uploading a new file and deleting the old one. A note that vanished
 * while a new file of the same name appeared in the same folder is the same note: it keeps its
 * reading position, bookmarks, favourite and tab (and shows as updated).
 */
function carryOverReplaced(oldFiles, newFiles) {
  const states = allDocStates();
  const fresh = Object.values(newFiles).filter((f) => !states[f.id]); // also seen last time next to the old one
  if (!fresh.length) return;
  for (const o of Object.values(oldFiles)) {
    if (newFiles[o.id] || !states[o.id]) continue;
    const n = fresh.find((f) => f.parent === o.parent && f.name === o.name && !states[f.id]);
    if (!n) continue;
    moveDocState(o.id, n.id);
    if (tabs.includes(o.id)) { tabs = tabs.map((id) => (id === o.id ? n.id : id)); saveTabs(); }
    if (activeTab === o.id) activeTab = n.id;
    if (viewer.meta && viewer.meta.id === o.id) { // reading it now: keep saving to the new id
      viewer.meta = { ...viewer.meta, id: n.id };
      viewer.docId = n.id;
    }
  }
}

let rootPickerOpen = false;
async function pickRootAutomatically() {
  if (rootPickerOpen) return;
  rootPickerOpen = true; // held until the picker below closes (or we picked a folder ourselves)
  try {
    const named = await drive.findNoteFolders();
    if (named.length === 1) {
      setSources([{ root: named[0].id, name: named[0].name, acct: '' }]);
      toast(t('rootChosen', { name: named[0].name }));
      rootPickerOpen = false;
      return;
    }
    // No (or several) note-app folders by name: also suggest the folders holding the most PDFs.
    openFolderPicker(suggestFolders(), () => { rootPickerOpen = false; });
  } catch (e) {
    rootPickerOpen = false;
    if (e instanceof drive.AuthError) markReauth(true);
    else toast(e.message);
  }
}

const AUTH_ERRORS = {
  developer_error: 'authDeveloperError',
  network_error: 'authNetworkError',
  canceled: '',
  superseded: '',
  busy: '', // another sign-in screen is already open
};

function connectDrive() {
  if (!configured()) { openSetupGuide(); return; }
  if (!navigator.onLine) { toast(t('noInternet')); return; }
  if (NATIVE) {
    drive.nativeAuthorize(true).then((r) => {
      if (r.ok) {
        markReauth(false);
        toast(t('driveConnected'));
        drive.fetchAccount().then(() => currentRoute && currentRoute.tab === 'settings' && render({ keepScroll: true })).catch(() => {});
        render({ keepScroll: true });
        sync();
        return;
      }
      const msg = r.error in AUTH_ERRORS ? (AUTH_ERRORS[r.error] && t(AUTH_ERRORS[r.error])) : t('authFailed', { e: r.error });
      if (msg) toast(msg);
      if (r.error === 'developer_error') openSetupGuide();
    });
    return;
  }
  drive.startAuth({ silent: false, returnTo: location.hash || '#/docs' });
}

// ====================================================================== routing
function parseRoute() {
  // Split first, then decode: an id may hold a "/" (WebDAV paths), encoded in the address.
  const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/').map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  if (a === 'doc' && b) return { doc: b, page: parseInt(c, 10) || 0 };
  if (a === 'fav') return { tab: 'fav' };
  if (a === 'search') return { tab: 'search' };
  if (a === 'settings') return { tab: 'settings' };
  return { tab: 'docs', folder: b || ROOT };
}

function routeKey(r) {
  return r.tab + ':' + (r.folder || '');
}

function go(hash, { replace = false } = {}) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function onRoute() {
  const r = parseRoute();
  if (homeAfterBack) {
    homeAfterBack = false;
    if (!r.doc && !(r.tab === 'docs' && r.folder === ROOT)) { go('#/docs', { replace: true }); return; }
  }
  activeTab = r.doc || null;
  if (r.doc) {
    if (!currentRoute) { currentRoute = { tab: 'docs', folder: ROOT }; render(); }
    openDoc(r.doc, r.page);
    return;
  }
  if (viewer.isOpen) {
    viewer.close();
    refreshCells();
  }
  renderTabs();
  if (currentRoute && !currentRoute.doc) scrollMemory.set(routeKey(currentRoute), main.scrollTop);
  const same = currentRoute && routeKey(currentRoute) === routeKey(r);
  if (selecting && !same) {
    selected.clear();
    // Opening a folder while selecting keeps selection mode on (select notes inside it).
    if (r.tab !== 'docs') { selecting = false; document.body.classList.remove('selecting'); }
    renderSelbar();
  }
  currentRoute = r;
  if (!same) render();
  main.scrollTop = scrollMemory.get(routeKey(r)) || 0;
}

function render({ keepScroll = false } = {}) {
  const r = currentRoute;
  const top = main.scrollTop;
  const tab = r.tab === 'fav' ? 'docs' : r.tab;
  $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  if (r.tab === 'docs') renderDocs(r.folder);
  else if (r.tab === 'fav') renderFavorites();
  else if (r.tab === 'search') renderSearch();
  else if (r.tab === 'settings') renderSettings();
  hydrateIcons(main);
  renderTabs();
  if (keepScroll) main.scrollTop = top;
}

// ====================================================================== library screens
/** Short sync state for the header chip (tap it to sync now). */
function statusLine() {
  const warn = (ic, text) => `<span class="warn">${icon(ic)}<span>${esc(text)}</span></span>`;
  const ghOnly = !drive.isConnected() && (settings.ghRepos.length > 0 || anyCloudOn()); // GitHub or other clouds without Google
  // Not set up / not connected: the banner right below explains it, so the chip is icon-only.
  if (!configured() && !ghOnly) return `<span class="warn" title="${t('chipNotSetUp')}">${icon('cloudOff')}</span>`;
  if (status.syncing || status.ghSyncing || CLOUD_KEYS.some((k) => status.cloudSyncing[k])) return `<span class="spinner sm"></span><span>${status.detail ? t('chipDownloading') : t('chipSyncing')}</span>`;
  if (!navigator.onLine) return `${icon('cloudOff')}<span>${t('chipOffline')}</span>`;
  if (status.waitWifi && settings.syncWifiOnly && !onWifi()) return `${icon('wifi')}<span>${t('chipWaitWifi')}</span>`;
  if (ghOnly) {
    const cp = anyCloudProblem();
    if (cp) return warn('cloudOff', cp.p === reauthText(cp.k) ? t('reconnect') : t('chipFailed'));
    if (ghProblem()) return warn('cloudOff', t('chipFailed'));
    const at = Math.max(settings.ghRepos.length ? ghLibrary.get().checkedAt || 0 : 0, ...CLOUD_KEYS.map((k) => (cloudOn(k) ? cloudLibrary.get(k).checkedAt || 0 : 0)));
    return `${icon('sync')}<span>${at ? esc(fmtAgo(at)) : t('sync')}</span>`;
  }
  if (!drive.isConnected()) return `<span class="warn" title="${t('chipNotConnected')}">${icon('cloudOff')}</span>`;
  if (status.reauth) return warn('cloudOff', t('reconnect'));
  if (status.error) return warn('cloudOff', t('chipFailed'));
  const cp = anyCloudProblem();
  if (cp) return warn('cloudOff', cp.p === reauthText(cp.k) ? t('reconnect') : t('chipFailed'));
  const lib = snapshot();
  return `${icon('sync')}<span>${lib.syncedAt ? esc(fmtAgo(lib.syncedAt)) : t('sync')}</span>`;
}

function renderStatus() {
  $$('.syncline').forEach((el) => {
    el.innerHTML = statusLine();
    // Screen readers hear the state too ("Offline", "Sync failed", "2 min ago"), not only the action.
    const state = el.textContent.trim();
    el.setAttribute('aria-label', joinList([state, t('syncNow')]));
  });
  $$('[data-a=sync]').forEach((b) => b.classList.toggle('spinning', status.syncing));
  const banner = $('.banner-slot');
  if (banner) { banner.innerHTML = bannerHTML(); hydrateIcons(banner); }
}

function bannerHTML() {
  const orGithub = `${addableClouds().length ? `<button class="banner-alt" data-a="cloudnew">${icon('cloud')}<span>${t('cloudInstead')}</span></button>` : ''}<button class="banner-alt" data-a="ghadd">${icon('branch')}<span>${t('ghInstead')}</span></button>`;
  if (!configured() && !settings.ghRepos.length) {
    return `<div class="banner">
      <div class="banner-ic">${icon('google')}</div>
      <div class="banner-txt"><b>${t('bannerSetupTitle')}</b><p>${t('bannerSetupText')}</p></div>
      <button class="pill-btn" data-a="setup">${t('setUp')}</button>${orGithub}</div>`;
  }
  if (!drive.isConnected()) {
    if (settings.ghRepos.length || anyCloudOn()) return '';
    return `<div class="banner">
      <div class="banner-ic">${icon('google')}</div>
      <div class="banner-txt"><b>${t('bannerConnectTitle')}</b><p>${t('bannerConnectText')}</p></div>
      <button class="pill-btn" data-a="connect">${t('connect')}</button>${orGithub}</div>`;
  }
  if (status.reauth) {
    return `<div class="banner warn">
      <div class="banner-ic">${icon('google')}</div>
      <div class="banner-txt"><b>${t('bannerReauthTitle')}</b><p>${t('bannerReauthText')}</p></div>
      <button class="pill-btn" data-a="connect">${t('connect')}</button></div>`;
  }
  return '';
}

function largeHeader({ title, back, actions = '', brand = false, sub = '' }) {
  const main = brand
    ? `<div class="brand">${LOGO}<span>${esc(title)}</span></div>`
    : `${back ? `<a class="ibtn back" href="${back.href}" aria-label="${esc(back.label)}">${icon('chevronLeft')}</a>` : ''}
       <div class="hdr-title">${sub ? `<small>${esc(sub)}</small>` : ''}<b>${esc(title)}</b></div>`;
  return `<header class="hdr"><div class="hdr-main">${main}</div><div class="hdr-actions">${actions}</div></header>`;
}

function folderSVG(color = 'var(--folder)') {
  return `<svg class="foldersvg" viewBox="0 0 120 90" aria-hidden="true">
    <path d="M6 14a8 8 0 0 1 8-8h30l9 9h53a8 8 0 0 1 8 8v53a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="${color}" opacity=".55"/>
    <path d="M6 28a8 8 0 0 1 8-8h92a8 8 0 0 1 8 8v48a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z" fill="${color}"/>
  </svg>`;
}

function folderCell(f) {
  const n = countIn(f.id);
  const top = f.parent === ROOT;
  const special = f.id === LOCAL_FOLDER ? icon('phone') : f.id === DEMO_FOLDER ? icon('star') : f.repo && top ? icon('branch') : f.croot && top ? icon('cloud') : '';
  return `<a class="item folder" data-fid="${esc(f.id)}" href="#/docs/${encodeURIComponent(f.id)}">
    <div class="thumb"><span class="selmark">${icon('check')}</span>${folderSVG(f.id === DEMO_FOLDER ? 'var(--folder-demo)' : 'var(--folder)')}${special ? `<span class="folder-badge">${special}</span>` : ''}</div>
    <div class="name"><span>${esc(f.name)}</span>${f.repo && top ? `<span class="sr-only">${listSep()}${t('ghFolderLabel')}</span>` : ''}</div>
    <div class="meta">${esc(joinList([t('itemsCount', { n }), f.croot && top && CLOUDS[cloudKeyOfFolder(f)] ? shortCloud(cloudKeyOfFolder(f)) : '']))}</div>
  </a>`;
}

function fileBadges(f) {
  const st = docState(f.id);
  const updated = remote(f) && st.seenModified && st.seenModified !== f.modifiedTime;
  const notCached = remote(f) && !cache.isFresh(f);
  return { updated, notCached, fav: !!st.fav };
}

function docCell(f, { showPath = false, variant = '' } = {}) {
  const b = fileBadges(f);
  const st = docState(f.id);
  const path = showPath ? folderPath(f.parent).join(' › ') : '';
  const pct = st.lastPage && st.pages ? Math.min(100, Math.round((st.lastPage / st.pages) * 100)) : 0;
  const meta = variant === 'resume' && st.lastPage && st.pages ? t('resumeMeta', { p: st.lastPage, n: st.pages, ago: fmtAgo(st.lastOpened) }) : (path || fmtDate(f.modifiedTime));
  return `<div class="item doc ${selected.has(f.id) ? 'sel' : ''}" data-id="${esc(f.id)}">
    <a class="thumb" href="#/doc/${encodeURIComponent(f.id)}" data-open aria-label="${esc(f.name)}${converted(f) ? ', ' + formatTag(f.fmt) : ''}${cache.restricted(f.id) ? ', ' + esc(t('readOnlyTag')) : ''}">
      <span class="selmark">${icon('check')}</span>
      <div class="cover" style="--c:${coverColor(f.name)}">
        <img alt="" decoding="async">
        <div class="cover-ph"></div>
      </div>
      ${b.updated ? `<span class="newtag">${t('newTag')}</span>` : ''}
      ${b.notCached ? `<span class="badge cloud" title="${t('notDownloaded')}">${icon('cloud')}</span>` : ''}
      ${b.fav ? `<span class="badge fav">${icon('starFill')}</span>` : ''}
      ${converted(f) ? `<span class="fmtbadge" aria-hidden="true">${formatTag(f.fmt)}</span>` : ''}
    </a>
    <div class="name">${b.updated ? `<i class="newdot" title="${t('updated')}"></i>` : ''}<span>${esc(f.name)}</span><button class="menubtn" data-menu="${esc(f.id)}" aria-label="${t('more')}">${icon('chevronDown')}</button></div>
    <div class="meta">${converted(f) ? `<span class="fmttag">${formatTag(f.fmt)}</span> ` : ''}${cache.restricted(f.id) ? `<span class="fmttag">${esc(t('readOnlyTag'))}</span> ` : ''}${esc(meta)}${variant === 'resume' ? '' : '<span class="pagecount"></span>'}</div>
    ${pct ? `<div class="progress-line" title="${t('percentRead', { pct })}"><i style="width:${pct}%"></i></div>` : ''}
  </div>`;
}

function itemsHTML(folders, files, opts = {}) {
  const cls = settings.view === 'list' ? 'list' : 'grid';
  return `<div class="items ${cls}">${folders.map(folderCell).join('')}${files.map((f) => docCell(f, opts)).join('')}</div>`;
}

function hydrateCovers(root = main) {
  const files = allFiles();
  $$('.item.doc', root).forEach((cell) => {
    const f = files[cell.dataset.id];
    if (f) fillCover(cell, f);
  });
}

/** Re-render cells for one file (or all) after covers/cache changed. */
function refreshCells(id) {
  const files = allFiles();
  $$(id ? `.item.doc[data-id="${CSS.escape(id)}"]` : '.item.doc', main).forEach((cell) => {
    const f = files[cell.dataset.id];
    if (!f) return;
    const tmp = document.createElement('div');
    const shelf = cell.closest('[data-variant]');
    tmp.innerHTML = docCell(f, { showPath: cell.closest('[data-showpath]') !== null, variant: shelf ? shelf.dataset.variant : '' });
    const fresh = tmp.firstElementChild;
    cell.replaceWith(fresh);
    fillCover(fresh, f);
  });
}

function libActions() {
  if (selecting) return `<button class="textbtn strong" data-a="selectdone">${t('done')}</button>`;
  return `
    <button class="chip syncline" data-a="sync" aria-label="${t('syncNow')}">${statusLine()}</button>
    <button class="ibtn" data-a="select" aria-label="${t('select')}" title="${t('select')}">${icon('checkCircle')}</button>
    <button class="ibtn" data-a="viewmenu" aria-label="${t('viewOptions')}">${icon('more')}</button>`;
}

// ---------------------------------------------------------------------- selection mode (선택)
let selecting = false;
const selected = new Set();

function setSelecting(on, firstId) {
  selecting = on;
  selected.clear();
  if (on && firstId) selected.add(firstId);
  document.body.classList.toggle('selecting', on);
  render({ keepScroll: true });
  renderSelbar();
}

function toggleSelected(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  $$('.item.doc', main).forEach((el) => el.classList.toggle('sel', selected.has(el.dataset.id)));
  renderSelbar();
}

function renderSelbar() {
  let bar = $('#selbar');
  if (!bar) {
    bar = document.createElement('nav');
    bar.id = 'selbar';
    bar.className = 'selbar';
    $('#app').appendChild(bar);
    bar.addEventListener('click', onSelbarClick);
  }
  bar.hidden = !selecting;
  if (!selecting) return;
  const n = selected.size;
  const docsInView = $$('.item.doc', main).length;
  bar.innerHTML = `
    <button class="textbtn" data-s="all">${n && n === docsInView ? t('deselectAll') : t('selectAll')}</button>
    <span class="selcount">${n ? t('nSelected', { n }) : t('selectItems')}</span>
    <div class="selbar-actions">
      <button class="ibtn" data-s="fav" ${n ? '' : 'disabled'} aria-label="${t('favorites')}">${icon('star')}</button>
      <button class="ibtn danger" data-s="delete" ${n ? '' : 'disabled'} aria-label="${t('delete')}">${icon('trash')}</button>
    </div>`;
}

function onSelbarClick(e) {
  const b = e.target.closest('[data-s]');
  if (!b) return;
  const act = b.dataset.s;
  if (act === 'all') {
    const ids = $$('.item.doc', main).map((el) => el.dataset.id);
    const all = selected.size === ids.length;
    selected.clear();
    if (!all) ids.forEach((id) => selected.add(id));
    $$('.item.doc', main).forEach((el) => el.classList.toggle('sel', !all));
    renderSelbar();
  } else if (act === 'fav') {
    const files = allFiles();
    const docs = [...selected].filter((id) => files[id]);
    if (!docs.length) { toast(t('onlyNotesFav')); return; }
    const makeFav = docs.some((id) => !docState(id).fav);
    docs.forEach((id) => updateDocState(id, { fav: makeFav }));
    toast(makeFav ? t('nFavAdded', { n: docs.length }) : t('nFavRemoved', { n: docs.length }));
    setSelecting(false);
  } else if (act === 'delete') {
    confirmDelete([...selected]).then((done) => { if (done) setSelecting(false); });
  }
}

/** Ask, then delete: imported PDFs are removed from the phone, Drive items are hidden from the list. */
async function confirmDelete(ids) {
  const files = allFiles();
  const folders = allFolders();
  const items = ids.map((id) => files[id] || folders[id]).filter(Boolean);
  if (!items.length) return false;
  const isLocal = (x) => x.source === 'local' || x.id === LOCAL_FOLDER;
  const isGithub = (x) => !!x.repo;
  const isCloud = (x) => !!cloudOf(x) || !!x.croot;
  const isDrive = (x) => !isGithub(x) && !isCloud(x) && (x.source === 'drive' || (!x.virtual && !x.source));
  const lines = [];
  if (items.some(isLocal)) lines.push(t('delLocalLine'));
  if (items.some(isDrive)) lines.push(t('delDriveLine'));
  if (items.some(isGithub)) lines.push(t('delGithubLine'));
  if (items.some(isCloud)) lines.push(t('delCloudLine'));
  const title = items.length === 1 ? t('delOneTitle', { name: items[0].name }) : t('delManyTitle', { n: items.length });
  if (!(await dialog({ title, message: lines.join('\n'), okText: t('delete'), danger: true }))) return false;
  await deleteItems(items);
  return true;
}

/** Items currently hidden with 삭제 (Drive notes/folders still in the backup, plus the samples). */
function hiddenEntries() {
  const lib = libData();
  const hidden = hiddenMap();
  const out = [];
  for (const [id, v] of Object.entries(hidden)) {
    const folder = lib.folders[id];
    const file = lib.files[id];
    if (folder && v === true) out.push({ id, kind: 'folder', name: folder.name, parent: folder.parent, modifiedTime: folder.modifiedTime });
    else if (file && isHiddenItem(file, hidden)) out.push({ id, kind: 'file', name: file.name, parent: file.parent, modifiedTime: file.modifiedTime });
  }
  if (kv.get('hideDemo', false) && !drive.isConnected() && !settings.ghRepos.length && !anyCloudOn()) out.push({ id: DEMO_FOLDER, kind: 'demo', name: t('folderSamples'), parent: ROOT });
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
}

/** Folder path using every Drive and GitHub folder, including hidden ones. */
function rawPath(folderId) {
  const folders = libData().folders;
  const names = [];
  for (let f = folders[folderId], guard = 0; f && guard < 60; f = folders[f.parent], guard++) names.unshift(f.name);
  return names;
}

function restoreHidden(ids) {
  const hidden = hiddenMap();
  for (const id of ids) {
    if (id === DEMO_FOLDER) kv.set('hideDemo', false);
    else delete hidden[id];
  }
  kv.set('hidden', hidden);
  pushBackgroundConfig();
}

function openHiddenList() {
  // Forget entries for notes that were removed from Drive or reappeared after an edit.
  if (snapshot().syncedAt) {
    const keep = new Set(hiddenEntries().map((e) => e.id));
    const hidden = hiddenMap();
    for (const id of Object.keys(hidden)) if (!keep.has(id)) delete hidden[id];
    kv.set('hidden', hidden);
  }
  const { el } = modalPage({
    title: t('deletedItems'),
    body: '<div class="hiddenlist"></div>',
    rightButton: {
      label: t('restoreAll'),
      onClick: (done) => {
        const ids = hiddenEntries().map((e) => e.id);
        if (!ids.length) { done(); return; }
        restoreHidden(ids);
        toast(t('nRestored', { n: ids.length }));
        done();
      },
    },
    onClose: () => render({ keepScroll: true }),
  });
  const box = $('.hiddenlist', el);
  const draw = () => {
    const entries = hiddenEntries();
    if (!entries.length) {
      box.innerHTML = `<div class="empty">${icon('check')}<b>${t('nothingDeleted')}</b><p>${t('allRestored')}</p></div>`;
      return;
    }
    const hidden = hiddenMap();
    box.innerHTML = `
      <p class="muted small pad">${t('deletedIntro')}</p>
      <div class="glist">${entries.map((e) => {
        const path = e.kind === 'demo' ? t('sampleHint') : [t('tabLibrary'), ...rawPath(e.parent)].join(' › ');
        const parentHidden = e.kind !== 'demo' && rawPathIds(e.parent).some((pid) => hidden[pid] === true);
        return `<div class="glist-row">
          <span class="glist-ic ${e.kind === 'file' ? 'blue' : 'orange'}">${icon(e.kind === 'file' ? 'page' : 'folder')}</span>
          <span class="glist-label">${esc(e.name)}<small>${esc(joinList([path, e.modifiedTime && e.kind === 'file' ? fmtDate(e.modifiedTime) : '', parentHidden ? t('parentAlsoDeleted') : '']))}</small></span>
          <button class="pill-btn" data-restore="${esc(e.id)}">${t('restore')}</button>
        </div>`;
      }).join('')}</div>`;
    $$('[data-restore]', box).forEach((b) => {
      b.onclick = () => {
        const e = entries.find((x) => x.id === b.dataset.restore);
        restoreHidden([e.id]);
        const blocked = e.kind !== 'demo' && rawPathIds(e.parent).find((pid) => hiddenMap()[pid] === true);
        toast(blocked
          ? t('restoredNeedParent', { name: e.name, parent: libData().folders[blocked].name })
          : t('restoredOne', { name: e.name }));
        draw();
      };
    });
  };
  draw();
}

function rawPathIds(folderId) {
  const folders = libData().folders;
  const ids = [];
  for (let f = folders[folderId], guard = 0; f && guard < 60; f = folders[f.parent], guard++) ids.push(f.id);
  return ids;
}

async function deleteItems(items) {
  const hidden = hiddenMap();
  const locals = localFiles.get();
  const files = Object.values(allFiles());
  const folders = libData().folders;
  const insideFolder = (f, folderId) => {
    for (let p = f.parent, guard = 0; p && p !== ROOT && guard < 60; p = folders[p] && folders[p].parent, guard++) {
      if (p === folderId) return true;
    }
    return false;
  };
  const dropped = [];
  const dropLocal = async (id) => { await cache.remove(id); dropped.push(id); };
  for (const it of items) {
    if (it.source === 'local') await dropLocal(it.id);
    else if (it.source === 'demo' || it.id === DEMO_FOLDER) kv.set('hideDemo', true);
    else if (it.id === LOCAL_FOLDER) { for (const id of Object.keys(locals)) await dropLocal(id); }
    else if (remote(it)) { hidden[it.id] = it.modifiedTime; await cache.remove(it.id); }
    else {
      hidden[it.id] = true; // a Drive or GitHub folder: hide it and drop offline copies inside
      for (const f of files) if (remote(f) && insideFolder(f, it.id)) await cache.remove(f.id);
    }
    updateDocState(it.id, { fav: false });
  }
  // Re-read what is stored: another change may have landed while the copies were being removed.
  kv.set('hidden', { ...hiddenMap(), ...hidden });
  pushBackgroundConfig(); // deleted folders go quiet in the background check at once
  // Re-read: a PDF imported while the copies were being removed must stay.
  const now = localFiles.get();
  for (const id of dropped) delete now[id];
  localFiles.set(now);
  toast(items.length === 1 ? t('deleted') : t('nDeleted', { n: items.length }));
  render({ keepScroll: true });
}

function renderDocs(folderId) {
  const folders = allFolders();
  const isRoot = folderId === ROOT;
  const folder = folders[folderId];
  if (!isRoot && !folder) { go('#/docs', { replace: true }); return; }
  const parent = !isRoot ? folder.parent : null;
  const back = isRoot ? null : {
    href: parent === ROOT ? '#/docs' : `#/docs/${encodeURIComponent(parent)}`,
    label: parent === ROOT ? t('tabLibrary') : folders[parent] ? folders[parent].name : t('back'),
  };
  let { folders: subs, files } = childrenOf(folderId);
  // At the top, the notes of one source only when one is chosen (Google Drive, MYBOX, GitHub…).
  const srcs = isRoot ? librarySources() : [];
  const only = isRoot ? shownSource(srcs) : '';
  if (only) { subs = subs.filter((x) => sourceOf(x) === only); files = files.filter((x) => sourceOf(x) === only); }
  const empty = !subs.length && !files.length;
  const desk = isRoot && !selecting ? homeSections(only) : '';
  main.innerHTML = `
    ${isRoot
      ? largeHeader({ title: t('appName'), brand: true, actions: libActions() })
      : largeHeader({ title: folder.name, back, sub: [t('tabLibrary'), ...folderPath(folder.parent)].join(' › '), actions: libActions() })}
    ${isRoot ? '<div class="banner-slot">' + bannerHTML() + '</div>' : ''}
    ${srcs.length > 1 && !selecting ? sourceBarHTML(srcs, only) : ''}
    ${desk}
    ${desk && !empty ? `<div class="section-title"><span>${only ? esc(sourceName(only)) : t('allNotes')}</span></div>` : ''}
    ${empty ? emptyHTML(isRoot) : itemsHTML(subs, files)}
  `;
  setupSourceBar();
  hydrateCovers();
}

/** Home "reading desk": continue reading, notes changed on the tablet, favorites. */
/** Notes for "이어 읽기", most recently read first. */
function resumeNotes() {
  const files = allFiles();
  return Object.entries(allDocStates())
    .filter(([id, st]) => st.lastOpened && files[id] && !(st.resumeHidden >= st.lastOpened)) // hidden until opened again
    .sort((a, b) => b[1].lastOpened - a[1].lastOpened)
    .map(([id]) => files[id]);
}

// ---------------------------------------------------------------------- sources (전체 / Google 드라이브 / MYBOX / GitHub…)
/** Where a library item comes from: 'drive', a cloud ('mybox'…), 'github', or '' (imported, samples). */
function sourceOf(x) {
  if (!x || x.virtual) return '';
  if (x.source) return x.source === 'local' || x.source === 'demo' ? '' : x.source; // a note
  const id = String(x.id || '');
  if (/^gh(r|f|rel):/.test(id)) return 'github';
  return cloudKeyOfFolder(x) || 'drive';
}
const SOURCE_ORDER = ['drive', ...CLOUD_KEYS, 'github'];
const sourceName = (k) => (k === 'drive' ? t('googleDrive') : k === 'github' ? 'GitHub' : shortCloud(k));
/** The sources that have something at the top of the library, in a fixed order. */
function librarySources() {
  const { folders, files } = childrenOf(ROOT);
  const have = new Set([...folders, ...files].map(sourceOf));
  return SOURCE_ORDER.filter((k) => have.has(k));
}
/** The chosen source, while it still has notes ('' = all). */
function shownSource(srcs) {
  const k = kv.get('libSource', '');
  if (srcs.length > 1 && k && !srcs.includes(k)) kv.set('libSource', ''); // that source left: back to all for good
  return srcs.length > 1 && srcs.includes(k) ? k : '';
}
/** The chosen source's button in sight (it may be far right after a restart), and a fade at the edge while more scroll in. */
function setupSourceBar() {
  const bar = $('.srcbar', main);
  if (!bar) return;
  const fade = () => bar.classList.toggle('more', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2);
  const on = $('.srcbtn.on', bar);
  if (on) {
    const r = on.getBoundingClientRect();
    const box = bar.getBoundingClientRect();
    if (r.right > box.right - 16) bar.scrollLeft += r.right - box.right + 40;
  }
  bar.addEventListener('scroll', fade, { passive: true });
  bar.addEventListener('focusin', (e) => { if (e.target.scrollIntoView) e.target.scrollIntoView({ inline: 'nearest', block: 'nearest' }); });
  fade();
}
function sourceBarHTML(srcs, only) {
  const b = (k, label) => `<button class="srcbtn${only === k ? ' on' : ''}" data-a="libsource" data-src="${k}" aria-pressed="${only === k}">${esc(label)}</button>`;
  return `<div class="srcbar" role="group" aria-label="${t('srcFilter')}">${b('', t('srcAll'))}${srcs.map((k) => b(k, sourceName(k))).join('')}</div>`;
}

function homeSections(only = '') {
  const all = allFiles();
  const files = only ? Object.fromEntries(Object.entries(all).filter(([, f]) => sourceOf(f) === only)) : all;
  const states = allDocStates();
  const recent = resumeNotes().filter((f) => !only || sourceOf(f) === only).slice(0, 10);
  const updated = Object.values(files)
    .filter((f) => { const st = states[f.id] || {}; return remote(f) && st.seenModified && st.seenModified !== f.modifiedTime; })
    .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
    .slice(0, 10);
  const favs = sortItems(Object.values(files).filter((f) => (states[f.id] || {}).fav));
  return [
    recent.length ? shelfHTML(t('continueReading'), recent, 'resume') : '',
    updated.length ? shelfHTML(t('recentlyChanged'), updated, 'updated') : '',
    favs.length ? shelfHTML(t('favorites'), favs.slice(0, 12), 'fav', favs.length > 3 ? '#/fav' : '') : '',
  ].join('');
}

function shelfHTML(title, files, variant, moreHref = '') {
  return `<div class="section-title"><span>${esc(title)}<span class="count">${files.length}</span></span>${moreHref ? `<a href="${moreHref}">${t('seeAll')}</a>` : ''}</div>
    <div class="items row" data-variant="${variant}">${files.map((f) => docCell(f, { variant })).join('')}</div>`;
}

function emptyHTML(isRoot) {
  if (!isRoot) return `<div class="empty">${icon('folder')}<b>${t('emptyFolderTitle')}</b><p>${t('emptyFolderText')}</p></div>`;
  if (drive.isConnected() && !snapshot().syncedAt) return `<div class="empty"><div class="spinner"></div><b>${t('loadingNotes')}</b></div>`;
  return `<div class="empty">${icon('docs')}<b>${t('noNotesTitle')}</b><p>${t('noNotesText')}</p></div>`;
}

function renderFavorites() {
  const files = Object.values(allFiles()).filter((f) => docState(f.id).fav);
  main.innerHTML = `
    ${largeHeader({ title: t('favorites'), back: { href: '#/docs', label: t('tabLibrary') }, actions: `<button class="ibtn" data-a="viewmenu" aria-label="${t('viewOptions')}">${icon('more')}</button>` })}
    ${files.length ? `<div data-showpath>${itemsHTML([], sortItems(files), { showPath: true })}</div>`
      : `<div class="empty">${icon('star')}<b>${t('noFavTitle')}</b><p>${t('noFavText')}</p></div>`}
  `;
  hydrateCovers();
}

// ---------------------------------------------------------------------- search tab
let searchQuery = '';
let fullTextResults = null;

function renderSearch() {
  main.innerHTML = `
    ${largeHeader({ title: t('tabSearch') })}
    <div class="searchwrap">
      <div class="searchfield big">${icon('search')}<input type="search" id="q" enterkeyhint="search" placeholder="${t('searchPlaceholder')}" value="${esc(searchQuery)}" autocomplete="off"></div>
    </div>
    <div id="sresults"></div>`;
  const input = $('#q');
  input.addEventListener('input', () => { searchQuery = input.value; fullTextResults = null; renderSearchResults(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  renderSearchResults();
  if (!searchQuery) setTimeout(() => input.focus(), 50);
}

function renderSearchResults() {
  const box = $('#sresults');
  if (!box) return;
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    const recent = Object.entries(allDocStates())
      .filter(([id, s]) => s.lastOpened && findFile(id))
      .sort((a, b) => b[1].lastOpened - a[1].lastOpened)
      .slice(0, 8)
      .map(([id]) => findFile(id));
    // Nothing opened yet: say what can be found here.
    box.innerHTML = recent.length ? `<h3 class="sechead">${t('recentlyViewed')}</h3><div data-showpath>${itemsHTML([], recent, { showPath: true })}</div>` : `<p class="muted pad">${t('searchEmptyHint')}</p>`;
    hydrateCovers(box);
    return;
  }
  const folders = Object.values(allFolders()).filter((f) => f.name.toLowerCase().includes(q));
  const files = Object.values(allFiles()).filter((f) => f.name.toLowerCase().includes(q));
  box.innerHTML = `
    ${folders.length || files.length ? `<h3 class="sechead">${t('nameMatches', { n: folders.length + files.length })}</h3><div data-showpath>${itemsHTML(sortItems(folders), sortItems(files), { showPath: true })}</div>` : `<p class="muted pad">${t('noNameMatch')}</p>`}
    <h3 class="sechead">${t('noteContents')}</h3>
    <div id="ftresults">${fullTextResults ? fullTextHTML(fullTextResults) : `
      <button class="glist-btn" data-a="fulltext">${icon('search')} ${t('searchInSaved', { q: esc(searchQuery.trim()) })}</button>
      <p class="muted small pad">${t('fullTextHint')}</p>`}</div>`;
  hydrateCovers(box);
  hydrateIcons(box);
}

function fullTextHTML(res) {
  const { results, unread } = res;
  const line = (s) => esc(s.replace(/\s+/g, ' '));
  // Handwriting: offer to switch it on, or to read the notes that have not been read yet.
  const ocrRow = ocrOn()
    ? (unread ? `<button class="glist-btn" data-a="ocrall">${icon('pen')} ${t('ocrReadAll', { n: unread })}</button>` : '')
    : ocrSupported() ? `<button class="glist-btn" data-a="ocron">${icon('pen')} ${t('ocrEnable')}</button>` : '';
  if (!results.length) return `<p class="muted pad">${t('notFoundInText')}</p>${ocrRow}`;
  return `<div class="glist">${results.map((r) => `
    <a class="glist-row ft" href="#/doc/${encodeURIComponent(r.id)}/${r.page + 1}">
      <span class="glist-label"><b>${esc(r.name)}</b> <small>${esc(joinList([t('pageN', { n: r.page + 1 }), r.ink && t('ocrInk')]))}</small><br><span class="snippet">…${line(r.text.slice(Math.max(0, r.at - 20), r.at))}<mark>${line(r.text.slice(r.at, r.end))}</mark>${line(r.text.slice(r.end, r.end + 30))}…</span></span>
      ${icon('chevronRight', 'chev')}
    </a>`).join('')}</div>${ocrRow}`;
}

/** Notes whose saved copy is up to date (a stale PDF would be indexed under the new version's time). */
function searchableFiles() {
  return Object.values(allFiles()).filter((f) => !remote(f) || cache.isFresh(f)); // not an old copy
}

async function fileBlob(f) {
  return f.source === 'demo' ? (await fetch(f.url)).blob() : cache.getPdf(f.id);
}

/** Text layer of every page, from the index or read now. */
async function fileTexts(f, doc) {
  let rec = await idb.get('texts', f.id);
  if (!rec || rec.modifiedTime !== f.modifiedTime) {
    let own = null;
    if (!doc) {
      const blob = await fileBlob(f);
      if (!blob) return null;
      doc = own = await openPdf(blob);
    }
    let pages;
    try { pages = await extractText(doc); } finally { if (own) own.destroy(); }
    rec = { modifiedTime: f.modifiedTime, pages };
    await idb.put('texts', f.id, rec);
  }
  return rec.pages;
}

async function runFullText() {
  const q = searchQuery.trim();
  if (!q) return;
  const box = $('#ftresults');
  box.innerHTML = `<div class="empty small"><div class="spinner"></div><p>${t('searching')}</p></div>`;
  const results = [];
  let unread = 0;
  for (const f of searchableFiles()) {
    try {
      const pages = await fileTexts(f);
      if (!pages) continue;
      const ink = ocrOn() ? await loadOcr(f.id, f.modifiedTime) : null;
      if (ocrOn() && doneCount(ink) < pages.length) unread++;
      pages.forEach((text, page) => {
        const fromText = findAll(text, q).map((m) => ({ text, ...m }));
        const p = ink && ink.pages[page];
        const fromInk = p && p.t ? findAll(p.t, q).map((m) => ({ text: p.t, ink: true, ...m })) : [];
        const hits = fromInk.length && fromInk.length >= fromText.length ? fromInk : fromText;
        if (hits.length) results.push({ id: f.id, name: f.name, page, ...hits[0] });
      });
    } catch (e) {
      console.warn('text search failed', f.name, e);
    }
    if (searchQuery.trim() !== q) return; // query changed meanwhile
  }
  fullTextResults = { results, unread };
  const cur = $('#ftresults');
  if (cur) { cur.innerHTML = fullTextHTML(fullTextResults); hydrateIcons(cur); }
}

/** Chapter lists that used recognized handwriting go with it (they are rebuilt from the text). */
function dropInkTocs() {
  idb.keys('texts').then(async (keys) => {
    for (const k of keys) {
      if (typeof k !== 'string' || !k.startsWith('toc:')) continue;
      const rec = await idb.get('texts', k).catch(() => null);
      if (rec && String(rec.version || '').includes('+ink')) await idb.del('texts', k).catch(() => {});
    }
  }).catch(() => {});
  viewer.autoToc = null;
}

/** Switch handwriting search on (after explaining it). Resolves true when it is on. */
async function turnOnOcr() {
  if (ocrOn()) return true;
  const ok = await dialog({ title: t('ocrTitle'), message: t('ocrExplain'), okText: t('ocrTurnOn') });
  if (ok) saveSettings({ ocr: true });
  return !!ok;
}

/** Read the handwriting of every saved note not read yet, then search again. */
let ocrAllRunning = false;
async function runOcrAll() {
  if (ocrAllRunning || !ocrOn()) return;
  ocrAllRunning = true;
  const q = searchQuery.trim();
  let cancelled = false;
  const stopped = () => cancelled || !ocrOn() || searchQuery.trim() !== q || !$('#ftresults');
  const show = (text) => {
    const box = $('#ftresults');
    if (!box) return;
    box.innerHTML = `<div class="ocrbusy" role="status"><div class="spinner sm"></div><span>${esc(text)}</span><button class="textbtn" data-x="ocrstop">${t('cancel')}</button></div>`;
    $('[data-x=ocrstop]', box).onclick = () => { cancelled = true; };
  };
  try {
    const files = searchableFiles().filter((f) => !cache.restricted(f.id));
    for (let k = 0; k < files.length && !stopped(); k++) {
      const f = files[k];
      try {
        const blob = await fileBlob(f);
        if (!blob || blob.restricted) continue; // (a distribution document isn't read out)
        const doc = await openPdf(blob);
        try {
          const texts = await fileTexts(f, doc);
          const have = doneCount(await loadOcr(f.id, f.modifiedTime));
          if (have >= doc.numPages) continue;
          show(t('ocrReadingNote', { k: k + 1, n: files.length, name: f.name, i: have, total: doc.numPages }));
          await indexDoc({
            id: f.id,
            modifiedTime: f.modifiedTime,
            doc,
            texts,
            isCancelled: stopped,
            onWait: () => show(t('ocrPreparing')),
            onPage: (rec) => show(t('ocrReadingNote', { k: k + 1, n: files.length, name: f.name, i: doneCount(rec), total: doc.numPages })),
          });
        } finally {
          doc.destroy();
        }
      } catch (e) {
        if (!stopped()) { console.warn('handwriting recognition failed', f.name, e); toast(t('ocrFailed')); }
        break;
      }
    }
  } finally {
    ocrAllRunning = false;
  }
  if (searchQuery.trim() === q && $('#ftresults')) runFullText();
}

// ---------------------------------------------------------------------- settings tab
function renderSettings() {
  const hiddenCount = hiddenEntries().length;
  const acc = drive.account();
  const connected = drive.isConnected();
  const manyAccounts = connected && drive.extraAccounts().length > 0;
  const theme = settings.theme;
  main.innerHTML = `
    ${largeHeader({ title: t('tabSettings') })}
    <div class="settings">
      <h3 class="sechead">${t('googleDrive')}</h3>
      <div class="glist">
        ${configured() ? `
        <div class="glist-row">
          <span class="glist-ic g">${icon('google')}</span>
          <span class="glist-label">${connected ? esc(acc ? acc.email : t('connected')) : t('chipNotConnected')}${connected && acc && acc.name ? `<small>${esc(acc.name)}</small>` : ''}</span>
          <button class="pill-btn ${connected ? 'ghost' : ''}" data-a="${connected ? 'disconnect' : 'connect'}">${connected ? t('disconnect') : t('connect')}</button>
        </div>
        ${connected ? drive.extraAccounts().map((x) => `
        <div class="glist-row">
          <span class="glist-ic blue initial" aria-hidden="true">${esc((x.email || '?')[0].toUpperCase())}</span>
          <span class="glist-label">${esc(x.email)}${x.name ? `<small>${esc(x.name)}</small>` : ''}</span>
          <button class="pill-btn ghost" data-a="removeacct" data-acct="${esc(x.key)}">${t('disconnect')}</button>
        </div>`).join('') : ''}
        ${settings.sources.length ? settings.sources.map((src, i) => `
        <button class="glist-row" data-a="srcmenu" data-i="${i}" ${connected ? '' : 'disabled'}>
          <span class="glist-ic blue">${icon('folder')}</span>
          <span class="glist-label">${esc(src.name)}<small>${manyAccounts ? esc(src.acct || (acc ? acc.email : '')) : t('noteFolder')}</small></span>${icon('chevronRight', 'chev')}
        </button>`).join('') : `
        <button class="glist-row" data-a="pickroot" ${connected ? '' : 'disabled'}>
          <span class="glist-ic blue">${icon('folder')}</span>
          <span class="glist-label">${t('noteFolder')}</span>
          <span class="glist-value">${t('notSelected')}</span>${icon('chevronRight', 'chev')}
        </button>`}
        <button class="glist-row" data-a="addsource" ${connected && settings.sources.length ? '' : 'disabled'}>
          <span class="glist-ic green">${icon('plus')}</span>
          <span class="glist-label">${t('addFolder')}<small>${t(NATIVE && NATIVE.addAccount ? 'addFolderSub' : 'addFolderSubWeb')}</small></span>
        </button>
        <button class="glist-row" data-a="sync" ${connected ? '' : 'disabled'}>
          <span class="glist-ic green">${icon('sync')}</span>
          <span class="glist-label">${t('syncNow')}</span>
          <span class="glist-value">${snapshot().syncedAt ? fmtAgo(snapshot().syncedAt) : ''}</span>
        </button>` : `
        <button class="glist-row" data-a="setup">
          <span class="glist-ic g">${icon('google')}</span>
          <span class="glist-label">${t('startSetup')}<small>${t('startSetupSub')}</small></span>${icon('chevronRight', 'chev')}
        </button>`}
      </div>

      ${cloudsSection()}

      <h3 class="sechead">GitHub</h3>
      <div class="glist">
        ${settings.ghRepos.map((e, i) => `
        <button class="glist-row" data-a="ghmenu" data-i="${i}">
          <span class="glist-ic dark">${icon('branch')}</span>
          <span class="glist-label">${esc(github.repoName(e))}<small>${esc(github.repoLabel(e))}</small>${ghRowError(e)}</span>${icon('chevronRight', 'chev')}
        </button>`).join('')}
        <button class="glist-row" data-a="ghadd">
          <span class="glist-ic green">${icon('plus')}</span>
          <span class="glist-label">${t('ghAdd')}<small>${t('ghAddSub')}</small></span>
        </button>
      </div>
      <p class="muted small pad">${t('ghNote')}</p>

      <h3 class="sechead">${t('syncDownloads')}</h3>
      <div class="glist">
        <label class="glist-row">
          <span class="glist-ic green">${icon('sync')}</span>
          <span class="glist-label">${t('wifiOnlySync')}<small>${t('wifiOnlySyncSub')}</small></span>
          <input type="checkbox" class="switch" data-set="syncWifiOnly" ${settings.syncWifiOnly ? 'checked' : ''}>
        </label>
        ${NATIVE && NATIVE.setBackgroundSync ? `
        <label class="glist-row">
          <span class="glist-ic purple">${icon('cloud')}</span>
          <span class="glist-label">${t('bgSync')}<small>${t('bgSyncSub')}</small></span>
          <input type="checkbox" class="switch" data-set="bgSync" ${settings.bgSync ? 'checked' : ''}>
        </label>
        ${settings.bgSync ? `
        <label class="glist-row">
          <span class="glist-ic red">${icon('bell')}</span>
          <span class="glist-label">${t('bgNotify')}<small>${t('bgNotifySub')}</small></span>
          <input type="checkbox" class="switch" data-set="bgNotify" ${settings.bgNotify ? 'checked' : ''}>
        </label>` : ''}` : ''}
        <label class="glist-row">
          <span class="glist-ic orange">${icon('download')}</span>
          <span class="glist-label">${t('autoDownload')}<small>${t('autoDownloadSub')}</small></span>
          <input type="checkbox" class="switch" data-set="autoDownload" ${settings.autoDownload ? 'checked' : ''}>
        </label>
        <label class="glist-row">
          <span class="glist-ic blue">${icon('wifi')}</span>
          <span class="glist-label">${t('wifiOnlyDownload')}</span>
          <input type="checkbox" class="switch" data-set="wifiOnly" ${settings.wifiOnly ? 'checked' : ''}>
        </label>
        <div class="glist-row">
          <span class="glist-ic gray">${icon('hdd')}</span>
          <span class="glist-label">${t('savedNotes')}</span>
          <span class="glist-value">${t('savedCount', { n: cache.ids().length, size: fmtSize(cache.totalBytes()) })}</span>
        </div>
        <button class="glist-row danger" data-a="clearcache">
          <span class="glist-ic red">${icon('trash')}</span>
          <span class="glist-label">${t('deleteAllOffline')}</span>
        </button>
        ${hiddenCount ? `
        <button class="glist-row" data-a="hiddenlist">
          <span class="glist-ic gray">${icon('refresh')}</span>
          <span class="glist-label">${t('deletedItems')}<small>${t('deletedItemsSub')}</small></span>
          <span class="glist-value">${t('countN', { n: hiddenCount })}</span>${icon('chevronRight', 'chev')}
        </button>` : ''}
      </div>

      <h3 class="sechead">${t('thisDevice')}</h3>
      <div class="glist">
        <button class="glist-row" data-a="import">
          <span class="glist-ic purple">${icon('plus')}</span>
          <span class="glist-label">${t('importPdf')}<small>${t('importPdfSub')}</small></span>${icon('chevronRight', 'chev')}
        </button>
        ${ocrSupported() ? `
        <label class="glist-row">
          <span class="glist-ic orange">${icon('pen')}</span>
          <span class="glist-label">${t('ocrSetting')}<small>${t('ocrSettingSub')}</small></span>
          <input type="checkbox" class="switch" data-set="ocr" ${settings.ocr ? 'checked' : ''}>
        </label>` : ''}
      </div>

      <h3 class="sechead">${t('display')}</h3>
      <div class="glist">
        <button class="glist-row" data-a="language">
          <span class="glist-ic indigo">${icon('globe')}</span>
          <span class="glist-label">${t('language')}${currentLang() !== 'en' ? langAlso() : ''}</span>
          <span class="glist-value">${esc(langLabel())}</span>${icon('chevronRight', 'chev')}
        </button>
        <div class="glist-row">
          <span class="glist-ic indigo">${icon('moon')}</span>
          <span class="glist-label">${t('theme')}</span>
          <div class="seg small" data-seg="theme">
            <button data-v="system" class="${theme === 'system' ? 'on' : ''}">${t('themeAuto')}</button>
            <button data-v="light" class="${theme === 'light' ? 'on' : ''}">${t('themeLight')}</button>
            <button data-v="dark" class="${theme === 'dark' ? 'on' : ''}">${t('themeDark')}</button>
          </div>
        </div>
        <div class="glist-row">
          <span class="glist-ic teal">${icon('page')}</span>
          <span class="glist-label">${t('readingMode')}</span>
          <div class="seg small" data-seg="readMode">
            <button data-v="scroll" class="${settings.readMode !== 'single' ? 'on' : ''}">${t('modeScroll')}</button>
            <button data-v="single" class="${settings.readMode === 'single' ? 'on' : ''}">${t('modeSingle')}</button>
          </div>
        </div>
        <label class="glist-row">
          <span class="glist-ic teal">${icon('zoomFit')}</span>
          <span class="glist-label">${t('fitHeightLandscape')}<small>${t('fitHeightLandscapeSub')}</small></span>
          <input type="checkbox" class="switch" data-set="fitHeightLandscape" ${settings.fitHeightLandscape ? 'checked' : ''}>
        </label>
        <div class="glist-row stack">
          <span class="glist-ic teal">${icon('spread')}</span>
          <span class="glist-label">${t('spreadSetting')}<small>${t('spreadSettingSub')}</small></span>
          <div class="seg small" data-seg="spread">
            <button data-v="auto" class="${(settings.spread || 'auto') === 'auto' ? 'on' : ''}">${t('themeAuto')}</button>
            <button data-v="on" class="${settings.spread === 'on' ? 'on' : ''}">${t('optOn')}</button>
            <button data-v="off" class="${settings.spread === 'off' ? 'on' : ''}">${t('optOff')}</button>
          </div>
        </div>
        <div class="glist-row stack">
          <span class="glist-ic indigo">${icon('moon')}</span>
          <span class="glist-label">${t('pageColor')}<small>${t('pageColorSub')}</small></span>
          <div class="seg small" data-seg="pageDark">
            <button data-v="off" class="${settings.pageDark !== 'on' && settings.pageDark !== 'auto' ? 'on' : ''}">${t('pageColorOrig')}</button>
            <button data-v="on" class="${settings.pageDark === 'on' ? 'on' : ''}">${t('pageColorDark')}</button>
            <button data-v="auto" class="${settings.pageDark === 'auto' ? 'on' : ''}">${t('pageColorAuto')}</button>
          </div>
        </div>
        <div class="glist-row">
          <span class="glist-ic teal">${icon('grid')}</span>
          <span class="glist-label">${t('docView')}</span>
          <div class="seg small" data-seg="view">
            <button data-v="grid" class="${settings.view === 'grid' ? 'on' : ''}">${t('viewGrid')}</button>
            <button data-v="list" class="${settings.view === 'list' ? 'on' : ''}">${t('viewList')}</button>
          </div>
        </div>
      </div>

      <h3 class="sechead">${t('advanced')}</h3>
      <div class="glist">
        ${NATIVE ? (!kv.get('devMode', false) ? '' : `
        <button class="glist-row" data-a="copy" data-copy="${esc(PACKAGE)}">
          <span class="glist-label">${t('packageName')}<small class="mono">${esc(PACKAGE)}</small></span>
          <span class="glist-value">${t('copy')}</span>
        </button>
        <button class="glist-row" data-a="copy" data-copy="${esc(NATIVE.signingSha1())}">
          <span class="glist-label">${t('sha1')}<small class="mono">${esc(NATIVE.signingSha1())}</small></span>
          <span class="glist-value">${t('copy')}</span>
        </button>`) : `
        <button class="glist-row" data-a="clientid">
          <span class="glist-label">${t('oauthClientId')}</span>
          <span class="glist-value mono">${settings.clientId ? esc(settings.clientId.slice(0, 14)) + '…' : t('none')}</span>${icon('chevronRight', 'chev')}
        </button>
        <button class="glist-row" data-a="copyredirect">
          <span class="glist-label">${t('redirectUri')}<small class="mono">${esc(drive.redirectUri())}</small></span>
          <span class="glist-value">${t('copy')}</span>
        </button>`}
        <button class="glist-row" data-a="setup">
          <span class="glist-label">${t('howToSetup')}</span>${icon('chevronRight', 'chev')}
        </button>
      </div>
      <h3 class="sechead">${t('about')}</h3>
      <div class="glist">
        <button class="glist-row" data-a="doc" data-page="privacy.html" data-title="${t('privacy')}">
          <span class="glist-label">${t('privacy')}</span>${icon('chevronRight', 'chev')}
        </button>
        <button class="glist-row" data-a="doc" data-page="licenses.html" data-title="${t('licenses')}">
          <span class="glist-label">${t('licenses')}</span>${icon('chevronRight', 'chev')}
        </button>
        <div class="glist-row" data-a="version">
          <span class="glist-label">${t('version')}</span>
          <span class="glist-value">${APP_VERSION}</span>
        </div>
      </div>
      <p class="footnote">${t('footnote')}</p>
    </div>`;
  $$('[data-set]', main).forEach((inp) => {
    inp.onchange = () => {
      const key = inp.dataset.set;
      if (key === 'ocr') {
        if (inp.checked) {
          inp.checked = false; // stays off unless confirmed
          turnOnOcr().then((on) => { inp.checked = on; });
        } else {
          saveSettings({ ocr: false });
          idb.clear('ocr').catch(() => {}); // what was read so far goes too
          dropInkTocs();
        }
        return;
      }
      saveSettings({ [key]: inp.checked });
      pushBackgroundConfig();
      if (key === 'bgSync') {
        render({ keepScroll: true }); // show/hide the notification row
        if (inp.checked && settings.bgNotify) askNotifications({ manual: true });
      } else if (key === 'bgNotify') {
        if (inp.checked) askNotifications({ manual: true });
      } else if (key === 'syncWifiOnly') {
        if (!inp.checked) sync();
      } else if ((key === 'autoDownload' || key === 'wifiOnly') && inp.checked) prefetch();
    };
  });
  $$('.seg[data-seg] button', main).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.classList.contains('on')));
    b.onclick = () => {
      const key = b.parentElement.dataset.seg;
      saveSettings({ [key]: b.dataset.v });
      if (key === 'theme') applyTheme();
      if (key === 'theme' || key === 'pageDark') viewer.applyPageColor();
      if (key === 'spread' && viewer.isOpen && viewer.pages.length) viewer.relayoutAt(Math.max(0, viewer.current));
      render({ keepScroll: true });
    };
  });
}

// ====================================================================== setup guide & folder picker
/** Step 1 of both setup guides (built on demand so it follows the current language). */
function guideBackup() {
  return `
        <section><h4><i>1</i> ${t('guideBackupTitle')}</h4>
        <ol>${t('guideBackupSteps')}</ol>
        <p class="muted small">${t('guideBackupNote')}</p></section>`;
}

/** Tap the version 7 times: shows developer-only settings (package name, SHA-1, Cloud setup steps). */
let versionTaps = [];
function versionTapped() {
  const now = Date.now();
  versionTaps = versionTaps.filter((x) => now - x < 2500).concat(now);
  if (versionTaps.length < 7) return;
  versionTaps = [];
  kv.set('devMode', !kv.get('devMode', false));
  toast(kv.get('devMode', false) ? t('devModeOn') : 'OK');
  render({ keepScroll: true });
}

function openNativeSetupGuide() {
  const sha1 = NATIVE.signingSha1();
  // App users only need steps 1 and "connect": the app's Google Cloud registration is the
  // developer's job, so those steps show only in developer mode.
  const dev = kv.get('devMode', false);
  const { el, close } = modalPage({
    title: t('setupTitle'),
    body: `
      <div class="guide">
        <p class="lead">${t('guideLead')}</p>
        ${guideBackup()}
        ${!dev ? '' : `<section><h4><i>2</i> ${t('guideCloudTitle')}</h4>
        <ol>
          <li>${t('guideStepProject')}</li>
          <li>${t('guideStepApi')}</li>
          <li>${t('guideStepConsent')}</li>
          <li>${t('guideStepTesters')}</li>
          <li>${t('guideStepClientAndroid')}</li>
          <li>${t('packageName')}: <code class="copy" data-copy="${esc(PACKAGE)}">${esc(PACKAGE)}</code></li>
          <li>${t('sha1')}: <code class="copy" data-copy="${esc(sha1)}">${esc(sha1)}</code></li>
          <li>${t('guideStepCreateDone')}</li>
        </ol>
        <p class="muted small">${t('guideCloudNote')}</p></section>`}

        <section><h4><i>${dev ? 3 : 2}</i> ${t('guideConnectTitle')}</h4>
          <button class="primary-btn" id="nconnect">${icon('google')} ${t('guideConnectBtn')}</button>
          <p class="muted small">${t('guideAutoPick')}</p>
        </section>

        <p class="muted small center"><button class="linkbtn" id="justdemo">${t('guideDemo')}</button></p>
      </div>`,
  });
  hydrateIcons(el);
  $$('.copy', el).forEach((c) => { c.onclick = () => copyText(c.dataset.copy); });
  $('#justdemo', el).onclick = () => { close(); go('#/docs/' + DEMO_FOLDER); };
  $('#nconnect', el).onclick = () => { close(); connectDrive(); };
}

function openSetupGuide() {
  if (NATIVE) { openNativeSetupGuide(); return; }
  const origin = location.origin;
  const redirect = drive.redirectUri();
  const { el, close } = modalPage({
    title: t('setupTitle'),
    body: `
      <div class="guide">
        <p class="lead">${t('guideLead')}</p>
        ${guideBackup()}

        <section><h4><i>2</i> ${t('guideCloudTitleWeb')}</h4>
        <ol>
          <li>${t('guideStepProject')}</li>
          <li>${t('guideStepApi')}</li>
          <li>${t('guideStepConsent')}</li>
          <li>${t('guideStepTesters')}</li>
          <li>${t('guideStepClientWeb')}</li>
          <li>${t('guideStepOrigin')}: <code class="copy" data-copy="${esc(origin)}">${esc(origin)}</code></li>
          <li>${t('guideStepRedirect')}: <code class="copy" data-copy="${esc(redirect)}">${esc(redirect)}</code></li>
          <li>${t('guideStepPasteId')}</li>
        </ol>
        <p class="muted small">${t('guideCloudNoteWeb')}</p></section>

        <section><h4><i>3</i> ${t('guideConnectTitle')}</h4>
          <input class="field" id="cid" placeholder="123456-abc.apps.googleusercontent.com" value="${esc(settings.clientId)}" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="primary-btn" id="cidsave">${icon('google')} ${t('guideSaveConnectBtn')}</button>
        </section>

        <section><h4><i>4</i> ${t('guideHomeTitle')}</h4>
        <p>${t('guideHome')}</p></section>

        <p class="muted small center"><button class="linkbtn" id="justdemo">${t('guideDemo')}</button></p>
      </div>`,
  });
  hydrateIcons(el);
  $$('.copy', el).forEach((c) => { c.onclick = () => copyText(c.dataset.copy); });
  $('#justdemo', el).onclick = () => { close(); go('#/docs/' + DEMO_FOLDER); };
  $('#cidsave', el).onclick = () => {
    const v = $('#cid', el).value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) {
      toast(t('clientIdInvalid'));
      return;
    }
    saveSettings({ clientId: v });
    close();
    connectDrive();
  };
}

/** Suggested note folders: known note-app names first, then folders with the most PDFs. */
async function suggestFolders(acct = '') {
  const named = await drive.findNoteFolders(acct).catch(() => []);
  const dense = await drive.findPdfFolders(4, acct).catch(() => []);
  return [...named, ...dense.filter((d) => !named.some((n) => n.id === d.id))];
}

/**
 * candidates: an array, or a promise of one (the picker opens right away and fills them in).
 * The chosen folder replaces note folder `index` (the first by default), or with `add` is added
 * as one more; `acct` is the account to browse.
 */
function openFolderPicker(candidates = null, onClosed = null, { acct = '', index = 0, add = false, provider = null } = {}) {
  // provider (OneDrive): {rootName, list(id), choose(f) → whether it was taken, isAuthError, onAuthError}
  const stack = [{ id: 'root', name: provider ? provider.rootName : t('myDrive') }];
  if (candidates && candidates.then) {
    candidates.then((c) => { candidates = c; if (stack.length === 1) show(); });
  }
  const { el, close } = modalPage({
    title: t('pickFolderTitle'),
    body: '<div class="picker"></div>',
    onClose: onClosed,
    rightButton: {
      label: t('select'),
      onClick: (done) => {
        const cur = stack[stack.length - 1];
        if (cur.id === 'root') { chooseWhole(done); return; }
        if (choose(cur) !== false) done();
      },
    },
  });
  /**
   * The whole drive (every folder in it), after a word on what that means. Its top is stored by
   * its real id where the cloud has one (Google Drive, OneDrive: their changes name it so, and
   * the library's own top is called 'root'); the others take 'root'. Waiting for the id must not
   * win over the picker being closed or another folder chosen meanwhile.
   */
  let picks = 0; // every choice made in this picker
  const open = () => el.isConnected && !!el.closest('.ov.open');
  let wholeBusy = false;
  const chooseWhole = async (done) => {
    if (wholeBusy) return;
    const name = stack[0].name;
    const at = picks;
    const ok = await dialog({ title: t('wholeDriveTitle', { name }), message: t('wholeDriveMsg'), okText: t('select') });
    if (!ok || !open() || at !== picks) return;
    const resolve = provider ? provider.top : () => drive.getFolder('root', acct);
    if (!resolve) { if (choose({ id: 'root', name }) !== false) done(); return; }
    wholeBusy = true;
    try {
      const top = await resolve();
      if (!top || typeof top.id !== 'string' || !top.id || top.id === ROOT || top.id.length > 1000) throw new Error(t('cloudNetwork', { name }));
      if (open() && at === picks && choose({ id: top.id, name }) !== false) done();
    } catch (e) {
      if (provider ? provider.isAuthError(e) : e instanceof drive.AuthError) { if (provider) provider.onAuthError(); else markReauth(true); }
      if (open() && at === picks) toast(e.message || String(e), { duration: 6000 });
    } finally {
      wholeBusy = false;
    }
  };
  const choose = (f) => {
    picks++;
    if (provider) return provider.choose(f);
    const list = settings.sources.slice();
    const entry = { root: f.id, name: f.name, acct };
    const at = add ? -1 : Math.min(index, list.length);
    if (list.some((x, k) => k !== at && x.root === f.id)) { toast(t('folderAlready', { name: f.name })); return false; }
    const replaced = at >= 0 ? list[at] : null;
    if (add) list.push(entry); else list[at] = entry;
    setSources(list);
    // The notes of a replaced folder leave now; the others stay on screen until the sync is done.
    if (replaced && replaced.root !== f.id) { dropFromLibrary((x) => x.src === replaced.root); render(); }
    toast(t('syncingFolder', { name: f.name }));
    sync({ manual: true });
  };
  const box = $('.picker', el);

  async function show() {
    const cur = stack[stack.length - 1];
    box.innerHTML = `
      <div class="crumbs">${stack.map((s, i) => `<button data-i="${i}">${esc(s.name)}</button>`).join(`${icon('chevronRight')}`)}</div>
      ${candidates && candidates.then && stack.length === 1 ? `<p class="muted small pad"><span class="spinner sm"></span> ${t('findingSuggestions')}</p>` : ''}
      ${Array.isArray(candidates) && candidates.length && stack.length === 1 ? `
        <h3 class="sechead">${t('suggested')}</h3>
        <div class="glist">${candidates.map((c) => `<button class="glist-row" data-pick="${esc(c.id)}" data-name="${esc(c.name)}"><span class="glist-ic blue">${icon('folder')}</span><span class="glist-label">${esc(c.name)}${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</span><span class="pill-btn">${t('select')}</span></button>`).join('')}</div>` : ''}
      ${stack.length === 1 ? `
        <div class="glist"><div class="glist-row pick-row">
          <button class="pick-open" data-whole><span class="glist-ic blue">${icon('cloud')}</span><span class="glist-label">${esc(t('wholeDrive', { name: cur.name }))}<small>${t('wholeDriveSub')}</small></span></button>
          <button class="pill-btn" data-whole aria-label="${esc(t('pickThis') + ': ' + t('wholeDrive', { name: cur.name }))}">${t('pickThis')}</button>
        </div></div>` : ''}
      <h3 class="sechead">${esc(cur.name)}</h3>
      <div class="glist" id="plist"><div class="empty small"><div class="spinner"></div></div></div>
      <p class="muted small pad">${t('pickerHint')}</p>`;
    $$('.crumbs button', box).forEach((b) => { b.onclick = () => { stack.length = +b.dataset.i + 1; show(); }; });
    $$('[data-pick]', box).forEach((b) => { b.onclick = () => { if (choose({ id: b.dataset.pick, name: b.dataset.name }) !== false) close(); }; });
    $$('[data-whole]', box).forEach((b) => { b.onclick = () => chooseWhole(close); });
    try {
      const items = provider ? await provider.list(cur.id) : await drive.listFolders(cur.id, acct);
      if (stack[stack.length - 1] !== cur) return;
      const list = $('#plist', box);
      // A folder is chosen right from its row ("Select"), or opened (the rest of the row) to go further in.
      list.innerHTML = items.length ? items.map((f) => `
        <div class="glist-row pick-row">
          <button class="pick-open" data-id="${esc(f.id)}" data-name="${esc(f.name)}">
            <span class="glist-ic blue">${icon('folder')}</span><span class="glist-label">${esc(f.name)}</span>${icon('chevronRight', 'chev')}
          </button>
          <button class="pill-btn" data-choose="${esc(f.id)}" data-name="${esc(f.name)}" aria-label="${esc(t('pickThis') + ': ' + f.name)}">${t('pickThis')}</button>
        </div>`).join('') : `<p class="muted pad">${t('noSubfolders')}</p>`;
      $$('[data-id]', list).forEach((b) => { b.onclick = () => { stack.push({ id: b.dataset.id, name: b.dataset.name }); show(); }; });
      $$('[data-choose]', list).forEach((b) => { b.onclick = () => { if (choose({ id: b.dataset.choose, name: b.dataset.name }) !== false) close(); }; });
    } catch (e) {
      $('#plist', box).innerHTML = `<p class="muted pad">${esc(e.message)}</p>`;
      if (provider ? provider.isAuthError(e) : e instanceof drive.AuthError) { if (provider) provider.onAuthError(); else markReauth(true); }
    }
  }
  show();
}

// ---------------------------------------------------------------------- note folders & accounts
/** Take a removed folder's (or account's) notes out of the library right away; the rest stays. */
function dropFromLibrary(gone) {
  const lib = library.get();
  if (!lib) return;
  for (const map of [lib.folders, lib.files]) for (const [id, x] of Object.entries(map)) if (gone(x)) delete map[id];
  lib.sig = sourcesSig();
  library.set(lib);
}

function sourceMenu(i) {
  const src = settings.sources[i];
  if (!src) return;
  const main = drive.account();
  actionSheet({
    title: src.name,
    subtitle: src.acct || (main ? main.email : ''),
    items: [
      { label: t('changeFolder'), icon: 'folder', onClick: () => openFolderPicker(suggestFolders(src.acct), null, { acct: src.acct, index: i }) },
      ...(settings.sources.length > 1 ? [{ label: t('removeFolder'), icon: 'trash', danger: true, onClick: () => removeSource(i) }] : []),
    ],
  });
}

async function removeSource(i) {
  const src = settings.sources[i];
  if (!src) return;
  const ok = await dialog({ title: t('removeFolder'), message: t('removeFolderMsg', { name: src.name }), okText: t('removeFolder'), danger: true });
  if (!ok) return;
  setSources(settings.sources.filter((x) => x !== src));
  dropFromLibrary((x) => x.src === src.root);
  render({ keepScroll: true });
  sync({ manual: true });
}

/** One more note folder: from an account already connected or (Android app) another Google account. */
function addSource() {
  const main = drive.account();
  const items = [
    { acct: '', email: main ? main.email : t('connected') },
    ...drive.extraAccounts().map((x) => ({ acct: x.key, email: x.email })),
  ].map((a) => ({
    label: t('addFromAccount', { email: a.email }),
    icon: 'folder',
    onClick: () => openFolderPicker(suggestFolders(a.acct), null, { acct: a.acct, add: true }),
  }));
  if (NATIVE && NATIVE.addAccount) items.push({ label: t('addFromOther'), icon: 'plus', onClick: addAnotherAccount });
  if (items.length === 1) { items[0].onClick(); return; }
  actionSheet({ title: t('addFolder'), items });
}

async function addAnotherAccount() {
  if (!navigator.onLine) { toast(t('noInternet')); return; }
  // The main account must be known by name first, or its token could be mixed up with the new one.
  if (!drive.account() && !(await drive.fetchAccount().catch(() => null))) { toast(t('checkConnection')); return; }
  const r = await drive.nativeAddAccount();
  if (!r.ok) {
    const msg = r.error in AUTH_ERRORS ? (AUTH_ERRORS[r.error] && t(AUTH_ERRORS[r.error])) : t('authFailed', { e: r.error });
    if (msg) toast(msg);
    return;
  }
  let acct = r.acct;
  const acc = acct ? await drive.fetchAccount(acct).catch(() => null) : null;
  const main = drive.account();
  if (acc && main && acc.email.toLowerCase() === main.email.toLowerCase()) {
    drive.forgetAccount(acct); // the main account under another name on the phone (alias)
    acct = '';
  }
  render({ keepScroll: true });
  openFolderPicker(suggestFolders(acct), null, { acct, add: true });
}

async function removeAccount(acct) {
  if (!acct) return;
  const ok = await dialog({ title: t('removeAcctTitle'), message: t('removeAcctMsg', { email: acct }), okText: t('disconnect'), danger: true });
  if (!ok) return;
  const revoked = drive.removeAccount(acct);
  kv.set('cursors', null); // its changes list is gone: read the folders again in full
  const left = settings.sources.filter((x) => x.acct !== acct);
  if (left.length !== settings.sources.length) { setSources(left); dropFromLibrary((x) => x.acct === acct); }
  pushBackgroundConfig();
  render({ keepScroll: true });
  sync();
  if (!(await revoked)) toast(t('revokeFailed'), { duration: 10000 });
}

/** Show a bundled static page (privacy policy, licenses) in a sheet. */
function openDocPage(title, page) {
  modalPage({ title, body: `<iframe class="docframe" src="${esc(page)}" title="${esc(title)}"></iframe>` });
}

function copyText(text) {
  if (NATIVE) { NATIVE.copy(text); toast(t('copied')); return; }
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => toast(t('copied')))
    .catch(() => dialog({ title: t('copy'), input: text, cancelText: '' }));
}

// ====================================================================== item menu
function itemMenu(id, { resume = false } = {}) {
  const f = findFile(id);
  if (!f) return;
  const st = docState(id);
  const items = [
    { label: t('open'), icon: 'docs', onClick: () => openFromApp(id) },
    ...(resume ? [{ label: t('hideFromResume'), icon: 'x', onClick: () => hideFromResume(id) }] : []),
    { label: st.fav ? t('removeFav') : t('addFav'), icon: st.fav ? 'star' : 'starFill', onClick: () => toggleFav(id) },
  ];
  if (remote(f)) {
    if (cache.isFresh(f)) items.push({ label: t('deleteOffline'), icon: 'trash', onClick: async () => { await cache.remove(id); refreshCells(id); toast(t('offlineDeleted')); } });
    else items.push({ label: t('downloadOffline'), icon: 'download', onClick: () => downloadOne(f) });
  }
  items.push({ label: t('delete'), icon: 'trash', danger: true, onClick: () => confirmDelete([id]) });
  const path = folderPath(f.parent).join(' › ');
  actionSheet({
    title: f.name,
    subtitle: joinList([fmtDate(f.modifiedTime), f.size ? fmtSize(f.size) : '', path]),
    items,
  });
}

/** Take a note off the 이어 읽기 shelf; it returns the next time the note is opened. */
function hideFromResume(id) {
  const prev = docState(id).resumeHidden || 0;
  updateDocState(id, { resumeHidden: docState(id).lastOpened || Date.now() });
  render({ keepScroll: true });
  toast(t('resumeHiddenToast'), {
    action: t('undo'),
    duration: 4500,
    onAction: () => { updateDocState(id, { resumeHidden: prev }); render({ keepScroll: true }); },
  });
}

function resumeMenu(id) {
  const f = findFile(id);
  if (!f) return;
  actionSheet({
    title: f.name,
    items: [{ label: t('hideFromResume'), icon: 'x', danger: true, onClick: () => hideFromResume(id) }],
  });
}

/** Long-press on a folder: folders can't be selected, so they get their own small menu. */
function folderMenu(id) {
  const folder = allFolders()[id];
  if (!folder) return;
  actionSheet({
    title: folder.name,
    items: [
      { label: t('open'), icon: 'folder', onClick: () => { location.hash = `#/docs/${encodeURIComponent(id)}`; } },
      { label: t('delete'), icon: 'trash', danger: true, onClick: () => confirmDelete([id]) },
    ],
  });
}

function toggleFav(id) {
  const fav = !docState(id).fav;
  updateDocState(id, { fav });
  toast(fav ? t('favAdded') : t('favRemoved'));
  if (currentRoute.tab === 'fav') render({ keepScroll: true }); else refreshCells(id);
}

async function downloadOne(f) {
  if (!canFetch(f)) { toast(f.source === 'github' ? t('noInternet') : cloudOf(f) ? (navigator.onLine ? reauthText(f.source) : t('noInternet')) : t('reconnectDrive')); return; }
  toast(t('downloadingName', { name: f.name }));
  try {
    const blob = await fetchRemote(f);
    // Not when its repository or folder (or the whole account) was removed meanwhile.
    if (!(await cachePdf(f, blob))) return;
    queueCover(f);
    refreshCells(f.id);
    toast(t('availableOffline'));
  } catch (e) {
    toast(e.message);
  }
}

function viewMenu() {
  actionSheet({
    title: t('viewTitle'),
    items: [
      { label: `${settings.sort === 'date' ? '✓ ' : ''}${t('sortDate')}`, icon: 'sort', onClick: () => { saveSettings({ sort: 'date' }); render({ keepScroll: true }); } },
      { label: `${settings.sort === 'name' ? '✓ ' : ''}${t('sortName')}`, icon: 'sort', onClick: () => { saveSettings({ sort: 'name' }); render({ keepScroll: true }); } },
      settings.view === 'grid'
        ? { label: t('showList'), icon: 'list', onClick: () => { saveSettings({ view: 'list' }); render({ keepScroll: true }); } }
        : { label: t('showGrid'), icon: 'grid', onClick: () => { saveSettings({ view: 'grid' }); render({ keepScroll: true }); } },
      { label: t('importPdf'), icon: 'plus', onClick: () => $('#filepick').click() },
    ],
  });
}

// ====================================================================== import local PDFs
async function importFiles(fileList) {
  let last = null;
  let replaced = 0;
  const failed = [];
  let failMsg = '';
  let oldHwp = ''; // (a Hangul file older than HWP 5.0 that was left out: said by name)
  const startedAt = location.hash;
  for (let file of fileList) {
    // What the file really is (a shared file may come without a type, a name or the right one).
    let kind = await sniff(file);
    if (!kind && (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name))) kind = 'pdf'; // (pdf.js reads a little junk before the header)
    // a document to turn into a PDF: Hangul (HWPX), or a ZIP that is a Word file (by its name or
    // type; a shared one may have neither)
    const fmt = kind === 'hwpx' || kind === 'docx' ? zipFormat(kind, file.name, file.type) : kind === 'cfb' ? cfbFormat(file.name) : null;
    const word = !!fmt && (fmt === 'hwpx' || fmt === 'hwp' || formatOf(file.name) === 'docx' || file.type === DOCX_TYPE || !OTHER_ZIP.test(file.name));
    if (kind !== 'pdf' && !word) {
      if (kind === 'hwp3' && !oldHwp) oldHwp = baseName(file.name) || file.name || '';
      continue;
    }
    const name = baseName(file.name);
    if (word) {
      const say = (p) => toast(t('convertingNamePct', { name, pct: Math.round(p * 100) }), { duration: 10 * 60_000 });
      let shown = -1;
      say(0);
      try {
        file = await toPdf(file, { name, fmt }, { onProgress: (p) => { if (p - shown >= 0.05) { shown = p; say(p); } } });
      } catch (e) {
        console.warn('convert failed', e);
        failed.push(name);
        failMsg = e && e.convert ? e.message : t('convBroken');
        continue;
      }
    }
    let modifiedTime = new Date(file.lastModified || Date.now()).toISOString();
    // The same note again (e.g. a report re-exported after editing): offer to update it in place,
    // which keeps its reading position, bookmarks and tab.
    const same = Object.values(localFiles.get()).find((x) => x.name.toLowerCase() === name.toLowerCase());
    const choice = same ? await askSameName(same.name) : 'keep';
    if (choice === 'skip') continue; // dismissed: import nothing (not a silent duplicate)
    const replace = choice === 'replace';
    const id = replace ? same.id : 'local:' + Math.random().toString(36).slice(2, 10);
    if (replace && modifiedTime <= same.modifiedTime) modifiedTime = new Date().toISOString(); // still a newer version
    await cache.putPdf(id, file, modifiedTime);
    // Re-read right before writing so concurrent imports don't overwrite each other.
    const all = localFiles.get();
    all[id] = { id, name: replace ? same.name : name, modifiedTime, size: file.size };
    if (word) all[id].fmt = fmt; else delete all[id].fmt;
    localFiles.set(all);
    if (replace) replaced++;
    last = id;
  }
  if (failed.length) toast(failed.length === 1 && !last ? failMsg : t('convFailedSome', { name: joinList(failed) }), { duration: 6000 });
  if (!last) { if (!failed.length) toast(oldHwp ? t('oldHwp3', { name: oldHwp }) : t('onlyPdf'), oldHwp ? { duration: 6000 } : undefined); return; }
  if (!failed.length) toast(replaced ? t('sameNameUpdated') : t('imported'));
  if (replaced && viewer.isOpen && viewer.meta && viewer.meta.id === last) reloadOpenDoc();
  else if (location.hash !== startedAt) {
    // The user went on elsewhere while a document was being converted: don't pull them away.
    if (!failed.length) toast(t('imported'), { action: t('open'), onAction: () => openFromApp(last) });
  } else if (fileList.length === 1) openFromApp(last);
  else go('#/docs/' + LOCAL_FOLDER);
}
/** ZIP files that are something else than a Word document (a shared Word file may have no name). */
const OTHER_ZIP = /\.(xlsx|xlsm|pptx|ppsx|zip|odt|ods|odp|epub|apk|jar|hwpx|xps|oxps|key|pages|numbers|cbz|kmz|3mf)$/i;

/** Same name as a note already imported: 'replace', 'keep' (both) or 'skip' (dismissed). */
function askSameName(name) {
  return new Promise((resolve) => {
    actionSheet({
      title: t('sameNameTitle'),
      subtitle: t('sameNameMsg', { name }),
      items: [
        { label: t('sameNameReplace'), icon: 'refresh', onClick: () => resolve('replace') },
        { label: t('sameNameKeep'), icon: 'plus', onClick: () => resolve('keep') },
      ],
      onCancel: () => resolve('skip'),
    });
  });
}

// ====================================================================== viewer glue
const viewer = new Viewer($('#viewer'), {
  onBack: () => closeViewer(),
  onMenu: (meta) => {
    const st = docState(meta.id);
    const items = [
      { label: st.fav ? t('removeFav') : t('addFav'), icon: st.fav ? 'star' : 'starFill', onClick: () => toggleFav(meta.id) },
    ];
    if (remote(meta)) items.push({ label: t('redownload'), icon: 'refresh', onClick: () => reloadOpenDoc(true) });
    return items;
  },
});
hydrateIcons($('#viewer'));

function openFromApp(id, page) {
  openedFromApp = true;
  go(`#/doc/${encodeURIComponent(id)}${page ? '/' + page : ''}`);
}

function closeViewer() {
  if (openedFromApp) {
    openedFromApp = false;
    history.back();
    return;
  }
  const meta = viewer.meta;
  const parent = meta && meta.parent && meta.parent !== ROOT ? '#/docs/' + encodeURIComponent(meta.parent) : '#/docs';
  go(parent, { replace: true });
}

let openSeq = 0;
async function openDoc(id, page) {
  const seq = ++openSeq;
  const f = findFile(id);
  if (!f) {
    toast(t('noteNotFound'));
    go('#/docs', { replace: true });
    return;
  }
  f.path = folderPath(f.parent).join(' › ');
  addTab(id);
  if (viewer.meta && viewer.meta.id === id) {
    if (page) viewer.goToPage(page - 1);
    return;
  }
  viewer.prepare(f);
  try {
    const needDownload = remote(f) && !cache.isFresh(f);
    const from = f.source === 'github' ? t('downloadingFromGithub') : cloudOf(f) ? t('downloadingFromCloud', { name: CLOUDS[f.source].label() }) : t('downloadingFromDrive');
    if (needDownload) viewer.showLoading(from, 0);
    // the note converted for the viewer before (not when it is this same one again)
    const same = openConversion && openConversion.key === versionKey(f);
    if (openConversion && !same) openConversion.abort();
    const ctrl = (openConversion = same ? openConversion : new AbortController());
    ctrl.key = versionKey(f);
    const blob = await getPdf(f, (p, stage) => viewer.meta && viewer.meta.id === id && viewer.showLoading(stage === 'convert' ? t('converting') : from, p), ctrl.signal);
    if (openConversion === ctrl) openConversion = null;
    if (!viewer.meta || viewer.meta.id !== id) return;
    // An older offline copy: reading position, handwriting and chapters belong to that version.
    await viewer.open(blob.staleVersion ? { ...f, modifiedTime: blob.staleVersion } : f, blob, { page });
    if (needDownload) refreshCells(id);
    if (blob.restricted && kv.get('restrictedNoted', '') !== id) {
      // (each time another distribution document is opened: why export and search don't work)
      kv.set('restrictedNoted', id);
      toast(t('restrictedDoc'), { duration: 6000 });
    } else if (converted(f) && !kv.get('convNoted', false)) {
      kv.set('convNoted', true);
      toast(t('convertedNote'), { duration: 6000 });
    }
  } catch (e) {
    console.error(e);
    if (!viewer.meta || viewer.meta.id !== id) return;
    // stopped because another note was opened in between, and this one opened again: once more
    if (e && e.name === 'AbortError') { if (seq === openSeq) { viewer.meta = null; openDoc(id, page); } return; }
    const loading = $('.vloading', viewer.root);
    loading.hidden = false;
    // A document that couldn't be converted: trying again would fail the same way.
    const conv = !!(e && e.convert);
    loading.innerHTML = `
      <div class="empty">${icon(conv ? 'file' : 'cloudOff')}<b>${t('cantOpenNote')}</b><p>${esc(e.message || e)}</p>
      ${conv ? '' : `<button class="pill-btn" data-retry>${e.auth || e instanceof AuthError ? t('reconnect') : t('retry')}</button>`}</div>`;
    if (conv) return;
    $('[data-retry]', loading).onclick = () => {
      loading.innerHTML = '<div class="spinner"></div><div class="vloading-text" role="status" aria-live="polite"></div><div class="progress"><i></i></div>';
      if (e instanceof AuthError && cloudOf(f)) { connectCloud(f.source, { reauth: true }); return; }
      if (e.auth) { sessionStorage.removeItem('gnv.silentAt'); if (!trySilentAuth()) connectDrive(); return; }
      viewer.meta = null;
      openDoc(id, page);
    };
  }
}

let openConversion = null;

/** The open note has a newer version: offer it, once per version (not again at every sync). */
function offerNewVersion(files) {
  const open = viewer.meta;
  const f = open && files[open.id];
  if (!f || !remote(open) || f.modifiedTime === open.modifiedTime || open.offered === f.modifiedTime) return;
  open.offered = f.modifiedTime;
  toast(t('newVersion'), { action: t('refresh'), onAction: () => reloadOpenDoc() });
}

async function reloadOpenDoc(force = false) {
  const meta = viewer.meta;
  if (!meta) return;
  const stillHere = () => viewer.isOpen && viewer.meta === meta;
  const f = findFile(meta.id);
  if (!f) return;
  f.path = meta.path;
  try {
    let blob;
    if (force && remote(f)) {
      // Fetch first and only then replace the cached copy, so a failed download keeps it.
      if (!canFetch(f)) throw new Error(f.source === 'github' ? t('ghNetwork') : cloudOf(f) ? t('cloudNetwork', { name: CLOUDS[f.source].label() }) : t('checkConnection'));
      viewer.showLoading(t('downloadingLatest'), 0);
      blob = await fetchRemote(f, { onProgress: (p, stage) => stillHere() && viewer.showLoading(stage === 'convert' ? t('converting') : t('downloadingLatest'), p) });
      if (await cachePdf(f, blob)) queueCover(f);
    } else {
      viewer.showLoading(t('downloadingLatest'), 0);
      blob = await getPdf(f, (p, stage) => stillHere() && viewer.showLoading(stage === 'convert' ? t('converting') : t('downloadingLatest'), p));
    }
    if (!stillHere()) return; // the user switched notes or left the viewer meanwhile
    // Still only the old copy (the download failed again): getPdf said so; nothing to reload.
    if (blob.staleVersion && blob.staleVersion === meta.modifiedTime) { viewer.loading.hidden = true; meta.offered = undefined; return; }
    const added = await viewer.reload(blob.staleVersion ? { ...f, modifiedTime: blob.staleVersion } : f, blob);
    if (!added) toast(t('updatedToLatest')); // otherwise the "new pages" offer is showing
  } catch (e) {
    if (!stillHere()) return;
    viewer.loading.hidden = true;
    toast(e.message);
  }
}

// ====================================================================== global events
let suppressClick = false;
// The tap that ends a long-press must not reach anything — not even the sheet the long-press
// just opened (its backdrop would close it), so this runs in the capture phase.
document.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('click', (e) => {
  if (selecting && main.contains(e.target)) {
    const item = e.target.closest('.item.doc'); // folders aren't selectable: their link opens them
    if (item) {
      e.preventDefault();
      toggleSelected(item.dataset.id);
      return;
    }
  }
  // Note cells: the arrow button opens the menu, a tap anywhere else opens the note.
  const menu = e.target.closest('[data-menu]');
  if (menu) { itemMenu(menu.dataset.menu, { resume: !!menu.closest('[data-variant="resume"]') }); return; }
  const cell = e.target.closest('.item.doc');
  if (cell && main.contains(cell)) {
    e.preventDefault();
    openFromApp(cell.dataset.id);
    return;
  }
  const ft = e.target.closest('.glist-row.ft');
  if (ft) { openedFromApp = true; return; }
  const a = e.target.closest('[data-a]');
  if (!a || !main.contains(a)) return;
  const act = a.dataset.a;
  if (act === 'sync') sync({ manual: true });
  else if (act === 'select') setSelecting(true);
  else if (act === 'selectdone') setSelecting(false);
  else if (act === 'libsource') {
    kv.set('libSource', a.dataset.src || '');
    render();
    const on = $('.srcbtn.on', main);
    if (on) on.focus({ preventScroll: true });
  }
  else if (act === 'hiddenlist') openHiddenList();
  else if (act === 'language') chooseLanguage();
  else if (act === 'version') versionTapped();
  else if (act === 'doc') openDocPage(a.dataset.title, a.dataset.page);
  else if (act === 'viewmenu') viewMenu();
  else if (act === 'setup') openSetupGuide();
  else if (act === 'connect') { sessionStorage.removeItem('gnv.silentAt'); connectDrive(); }
  else if (act === 'disconnect') {
    dialog({ title: t('disconnectTitle'), message: t('disconnectMsg'), okText: t('disconnect'), danger: true }).then(async (ok) => {
      if (!ok) return;
      const revoked = drive.disconnect(); // every account, at once; Google answers later
      kv.set('cursors', null);
      setSources(settings.sources.filter((x) => !x.acct));
      dropFromLibrary((x) => !!x.acct);
      markReauth(false);
      pushBackgroundConfig({ clear: true });
      render();
      // Disconnected here either way; Google's list of connected apps may still show it.
      if (!(await revoked)) toast(t('revokeFailed'), { duration: 10000 });
    });
  } else if (act === 'pickroot') openFolderPicker(suggestFolders());
  else if (act === 'srcmenu') sourceMenu(+a.dataset.i);
  else if (act === 'addsource') addSource();
  else if (act === 'removeacct') removeAccount(a.dataset.acct);
  else if (act === 'ghadd') addRepo();
  else if (act === 'ghmenu') repoMenu(+a.dataset.i);
  else if (act === 'cloudnew') addCloud();
  else if (act === 'cloudconnect' && CLOUDS[a.dataset.k]) connectCloud(a.dataset.k, { reauth: true });
  else if (act === 'clouddisconnect' && CLOUDS[a.dataset.k]) disconnectCloud(a.dataset.k);
  else if (act === 'cloudadd' && CLOUDS[a.dataset.k]) addCloudFolder(a.dataset.k);
  else if (act === 'cloudmenu' && CLOUDS[a.dataset.k]) cloudFolderMenu(a.dataset.k, +a.dataset.i);
  else if (act === 'clearcache') {
    dialog({ title: t('deleteAllOffline'), message: t('deleteAllOfflineMsg'), okText: t('delete'), danger: true }).then(async (ok) => {
      if (!ok) return;
      await cache.clearAll();
      localFiles.set({});
      coverURLs.forEach((c) => URL.revokeObjectURL(c.url));
      coverURLs.clear();
      resetWidget(); // its copy of the first page goes too
      render();
      toast(t('deleted'));
    });
  } else if (act === 'import') $('#filepick').click();
  else if (act === 'clientid') {
    dialog({ title: t('oauthClientId'), input: settings.clientId, placeholder: '…apps.googleusercontent.com', okText: t('save') }).then((v) => {
      if (v === null) return;
      const changed = v.trim() !== settings.clientId;
      saveSettings({ clientId: v.trim() });
      if (changed) { drive.disconnect(); markReauth(false); }
      render();
    });
  } else if (act === 'copyredirect') copyText(drive.redirectUri());
  else if (act === 'copy') copyText(a.dataset.copy);
  else if (act === 'fulltext') runFullText();
  else if (act === 'ocron') turnOnOcr().then((on) => { if (on) runFullText(); });
  else if (act === 'ocrall') runOcrAll();
});

// Pull down at the top of the library to sync now.
const ptrEl = $('.ptr');
let ptr = null;
main.addEventListener('touchstart', (e) => {
  if (main.scrollTop > 0 || e.touches.length !== 1 || selecting || !currentRoute || currentRoute.tab !== 'docs') return;
  ptr = { y0: e.touches[0].clientY, d: 0 };
}, { passive: true });
main.addEventListener('touchmove', (e) => {
  if (!ptr) return;
  const dy = e.touches[0].clientY - ptr.y0;
  if (dy <= 0 || main.scrollTop > 0) { ptr.d = 0; ptrEl.style.cssText = ''; ptrEl.classList.remove('ready'); return; }
  ptr.d = Math.min(120, dy * 0.5);
  ptrEl.style.transition = 'none';
  ptrEl.style.opacity = String(Math.min(1, ptr.d / 50));
  ptrEl.style.transform = `translateY(${ptr.d - 50}px) rotate(${ptr.d * 4}deg)`;
  ptrEl.classList.toggle('ready', ptr.d >= 64);
}, { passive: true });
['touchend', 'touchcancel'].forEach((ev) => main.addEventListener(ev, () => {
  if (!ptr) return;
  const ready = ptrEl.classList.contains('ready');
  ptr = null;
  ptrEl.classList.remove('ready');
  ptrEl.style.transition = 'transform .25s, opacity .25s';
  if (!ready) { ptrEl.style.opacity = '0'; ptrEl.style.transform = 'translateY(-50px)'; return; }
  ptrEl.style.transform = 'translateY(14px)';
  ptrEl.firstElementChild.classList.add('spinning');
  Promise.resolve(sync({ manual: true })).finally(() => {
    ptrEl.firstElementChild.classList.remove('spinning');
    ptrEl.style.opacity = '0';
    ptrEl.style.transform = 'translateY(-50px)';
  });
}, { passive: true }));

// Long-press an item: select it (문서 tab) or show its menu (elsewhere).
let pressTimer = null;
let pressStart = null;
function onLongPress(item) {
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 700);
  if (navigator.vibrate) navigator.vibrate(12);
  if (item.dataset.fid) {
    if (!selecting) folderMenu(item.dataset.fid);
    return;
  }
  const id = item.dataset.id;
  if (item.closest('[data-variant="resume"]') && !selecting) resumeMenu(id);
  else if (currentRoute.tab === 'docs') {
    if (selecting) toggleSelected(id); else setSelecting(true, id);
  } else itemMenu(id);
}
main.addEventListener('touchstart', (e) => {
  const item = e.target.closest('.item');
  if (!item || e.touches.length > 1) return;
  const t = e.touches[0];
  pressStart = { x: t.clientX, y: t.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => { pressTimer = null; onLongPress(item); }, 480);
}, { passive: true });
main.addEventListener('touchmove', (e) => {
  if (!pressTimer || !pressStart) return;
  const t = e.touches[0];
  if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > 10) { clearTimeout(pressTimer); pressTimer = null; }
}, { passive: true });
['touchend', 'touchcancel'].forEach((ev) => main.addEventListener(ev, () => { clearTimeout(pressTimer); pressTimer = null; }, { passive: true }));
main.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  e.preventDefault();
  if (!suppressClick) onLongPress(item); // desktop right-click (touch long-press already handled)
});

$('#filepick').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});

// Main scroll: collapse the large title into the bar like iOS.
main.addEventListener('scroll', () => {
  document.body.classList.toggle('scrolled', main.scrollTop > 30);
}, { passive: true });

window.addEventListener('hashchange', onRoute);
window.addEventListener('online', () => { renderStatus(); sync(); });
window.addEventListener('offline', renderStatus);
let netTimer = null;
function onNetworkChange() {
  clearTimeout(netTimer);
  netTimer = setTimeout(() => {
    renderStatus();
    if (navigator.onLine && (!settings.syncWifiOnly || onWifi()) && (status.waitWifi || !snapshot().syncedAt || Date.now() - snapshot().syncedAt > 60_000)) sync();
  }, 1500);
}
window.__gnvNetChange = onNetworkChange; // called by the Android app
if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', onNetworkChange);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { viewer.saveState(); sendWidget(); return; }
  importBackgroundUpdates();
  githubAnnounced();
  onedriveAnnounced();
  const lib = snapshot();
  if (Date.now() - (lib.syncedAt || 0) > 60_000) sync();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && driveUsable()) sync();
  else if (document.visibilityState === 'visible') { syncOthers(); renderStatus(); }
  else renderStatus();
}, Math.max(1, settings.syncMinutes) * 60_000);

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  if (NATIVE) NATIVE.setTheme(t === 'dark' || (t === 'system' && darkQuery.matches));
}
darkQuery.addEventListener('change', () => { applyTheme(); viewer.applyPageColor(); });

// ====================================================================== Android app hooks
/** Android back button: close the top-most sheet/dialog first. Returns true when handled. */
window.__gnvBack = () => {
  const ovs = $$('#overlay .ov');
  if (ovs.length) { // dialogs and sheets first
    const top = ovs[ovs.length - 1];
    const btn = top.querySelector('.asheet-cancel, [data-mp=close], [data-r=cancel], [data-r=ok], [data-x=cancel]');
    if (btn) btn.click();
    else {
      top.remove();
      if (!$('#overlay .ov')) $('#app').inert = false; // nothing modal left
    }
    return true;
  }
  if (selecting && !viewer.isOpen) { setSelecting(false); return true; }
  return viewer.isOpen && viewer.handleBack();
};

// ====================================================================== home screen widget
/**
 * The Android widget "이어 읽기" shows the note being read and the two before it. It is refreshed
 * when the user leaves the app (and after syncs, which can rename or remove notes).
 */
let widgetSent = '';
const widgetCover = { key: '', b64: '' };
function resetWidget() {
  widgetSent = '';
  widgetCover.key = '';
  widgetCover.b64 = '';
  sendWidget();
}
async function sendWidget() {
  if (!NATIVE || !NATIVE.setWidget) return;
  const notes = resumeNotes().slice(0, 3);
  const items = notes.map((f) => {
    const st = docState(f.id);
    const pages = st.pages || 0;
    const page = Math.max(1, Math.min(st.lastPage || 1, pages || Infinity));
    return { id: f.id, name: f.name, page, pages, sub: pages ? t('pageOfN', { cur: page, n: pages }) : '' };
  });
  const first = notes[0];
  const coverKey = first ? first.id + '|' + (first.modifiedTime || '') : '';
  const key = JSON.stringify(items) + coverKey + currentLang();
  if (key === widgetSent) return;
  const send = (cover) => { NATIVE.setWidget(JSON.stringify({ items, cover, title: t('continueReading'), empty: t('widgetEmpty') })); };
  if (!first || widgetCover.key === coverKey) {
    widgetSent = key;
    send(first ? widgetCover.b64 : '');
    return;
  }
  send(''); // right away (the app may be on its way to the background), the cover follows
  let b64 = '';
  try {
    const rec = await idb.get('covers', first.id);
    b64 = rec && rec.blob ? await base64Of(rec.blob) : '';
  } catch { /* no cover */ }
  const now = resumeNotes()[0];
  if (!now || now.id + '|' + (now.modifiedTime || '') !== coverKey) return; // a newer push owns it
  if (b64) { widgetCover.key = coverKey; widgetCover.b64 = b64; widgetSent = key; } // no cover yet: try again next time
  send(b64);
}

/** A note tapped in the widget. */
window.__gnvOpenNote = () => {
  if (!NATIVE || !NATIVE.takeOpenNote) return;
  let req;
  try { req = JSON.parse(NATIVE.takeOpenNote() || 'null'); } catch { return; }
  if (!req || typeof req.id !== 'string') return;
  if (!findFile(req.id)) { toast(t('noteNotFound')); return; }
  const page = Math.max(1, parseInt(req.page, 10) || 1);
  if (viewer.isOpen && viewer.meta && viewer.meta.id === req.id) viewer.goToPage(page - 1);
  else openFromApp(req.id, page);
};

/** PDFs opened or shared into the app from other apps (Files, Drive, KakaoTalk…). */
// One import at a time: a second share arriving mid-import is picked up by a follow-up pass.
let sharesBusy = false;
let sharesAgain = false;
window.__gnvShares = async () => {
  if (!NATIVE) return;
  if (sharesBusy) { sharesAgain = true; return; }
  sharesBusy = true;
  try {
    do {
      sharesAgain = false;
      await importShares();
    } while (sharesAgain);
  } finally {
    sharesBusy = false;
  }
};

async function importShares() {
  let shares = [];
  try { shares = JSON.parse(NATIVE.takeShares()); } catch { return; }
  const files = [];
  for (const sh of shares) {
    try {
      const res = await fetch(sh.url);
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      // (the type the other app gave, if any; importFiles looks at the bytes as well)
      files.push(new File([blob], sh.name, { type: typeof sh.type === 'string' ? sh.type : '', lastModified: Date.now() }));
    } catch (e) {
      toast(t('shareFailed', { name: sh.name }));
    }
    NATIVE.doneShare(sh.index);
  }
  if (!files.length) return;
  try {
    await importFiles(files);
  } catch (e) {
    console.error(e);
    toast(e && e.name === 'QuotaExceededError' ? t('storageFull') : t('shareFailed', { name: joinList(files.map((f) => f.name)) }));
  }
}

// ====================================================================== tabs
// Open notes stay as tabs in a strip at the top (like windows): tap to switch, × to close,
// long-press and drag to reorder. The home button on the left goes back to the library.
const MAX_TABS = 10;
const tabstrip = $('#tabstrip');
let tabs = (kv.get('tabs', []) || []).filter((id) => typeof id === 'string');
let activeTab = null;

function saveTabs() { kv.set('tabs', tabs); }

function addTab(id) {
  if (!tabs.includes(id)) {
    tabs.push(id);
    while (tabs.length > MAX_TABS) tabs.splice(tabs.findIndex((x) => x !== id), 1); // drop the oldest
    saveTabs();
  }
  activeTab = id;
  renderTabs();
}

function renderTabs() {
  // Notes that were deleted or are gone from Drive lose their tab.
  const libraryKnown = !drive.isConnected() || snapshot().syncedAt;
  const shown = tabs.map((id) => [id, findFile(id)]).filter(([, f]) => f);
  if (libraryKnown && shown.length !== tabs.length) { tabs = shown.map(([id]) => id); saveTabs(); }
  document.body.classList.toggle('has-tabs', shown.length > 0);
  tabstrip.hidden = !shown.length;
  if (!shown.length) { tabstrip.innerHTML = ''; return; }
  const inLibrary = !activeTab;
  tabstrip.innerHTML = `
    <button class="tab-home ${inLibrary ? 'on' : ''}" data-tab-home aria-label="${t('home')}">${icon('home')}</button>
    <div class="tabs-scroll" role="tablist">${shown.map(([id, f]) => `
      <div class="tab ${id === activeTab ? 'on' : ''}" data-tab="${esc(id)}" role="tab" tabindex="0" aria-selected="${id === activeTab}">
        <i class="tab-dot" style="--c:${coverColor(f.name)}"></i>
        <span class="tab-name">${esc(f.name)}</span>
        <button class="tab-x" data-tab-close aria-label="${esc(t('closeTab') + ': ' + f.name)}">${icon('x')}</button>
      </div>`).join('')}
    </div>`;
  const on = $('.tab.on', tabstrip);
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(id) {
  const i = tabs.indexOf(id);
  if (i < 0) return;
  tabs.splice(i, 1);
  saveTabs();
  if (id === activeTab) {
    const next = tabs[i] || tabs[i - 1];
    if (next) go(`#/doc/${encodeURIComponent(next)}`, { replace: true });
    else closeViewer();
  }
  renderTabs();
}

let homeAfterBack = false;
function goHome() {
  if (viewer.isOpen && openedFromApp) {
    // Step back out of the note (no duplicate library entry in history), then land on the home root.
    openedFromApp = false;
    homeAfterBack = true;
    history.back();
  } else if (viewer.isOpen) {
    go('#/docs', { replace: true });
  } else if (currentRoute && currentRoute.tab === 'docs' && currentRoute.folder === ROOT) {
    main.scrollTo({ top: 0, behavior: scrollBehavior() });
  } else go('#/docs');
}

let tabDragEnded = 0;
tabstrip.addEventListener('click', (e) => {
  if (Date.now() - tabDragEnded < 400) return; // the tap that ends a drag
  if (e.target.closest('[data-tab-home]')) { goHome(); return; }
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const id = tab.dataset.tab;
  if (e.target.closest('[data-tab-close]')) { closeTab(id); return; }
  if (id === activeTab) return;
  if (viewer.isOpen) go(`#/doc/${encodeURIComponent(id)}`, { replace: true }); // switch in place
  else openFromApp(id);
});
tabstrip.addEventListener('contextmenu', (e) => e.preventDefault());
tabstrip.addEventListener('keydown', (e) => { // keyboard: Enter/Space on a tab opens it
  const tab = e.target.closest && e.target.closest('.tab');
  if (tab && e.target === tab && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tab.click(); }
});
// Escape closes the top dialog/sheet (the viewer handles its own keys when nothing is on top).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#overlay .ov')) { e.preventDefault(); window.__gnvBack(); }
});

// Reorder: long-press (touch) or drag (mouse) a tab; it follows the finger between its neighbours.
(function tabDrag() {
  let press = null;
  const scroller = () => $('.tabs-scroll', tabstrip);
  const start = () => {
    press.dragging = true;
    press.tab.classList.add('dragging');
    if (navigator.vibrate) navigator.vibrate(10);
  };
  const move = (x) => {
    const sc = scroller();
    const box = sc.getBoundingClientRect();
    if (x < box.left + 32) sc.scrollLeft -= 10; else if (x > box.right - 32) sc.scrollLeft += 10;
    const others = $$('.tab:not(.dragging)', sc);
    const before = others.find((el) => { const r = el.getBoundingClientRect(); return x < r.left + r.width / 2; });
    if (before ? press.tab.nextElementSibling !== before : sc.lastElementChild !== press.tab) sc.insertBefore(press.tab, before || null);
  };
  const end = () => {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.dragging) {
      press.tab.classList.remove('dragging');
      const order = $$('.tab', tabstrip).map((el) => el.dataset.tab);
      tabs = [...order, ...tabs.filter((id) => !order.includes(id))];
      saveTabs();
      tabDragEnded = Date.now();
    }
    press = null;
  };
  tabstrip.addEventListener('touchstart', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || e.touches.length > 1 || e.target.closest('[data-tab-close]')) return;
    const p = e.touches[0];
    press = { tab, x: p.clientX, y: p.clientY, dragging: false };
    press.timer = setTimeout(start, 300);
  }, { passive: true });
  tabstrip.addEventListener('touchmove', (e) => {
    if (!press) return;
    const p = e.touches[0];
    if (press.dragging) { e.preventDefault(); move(p.clientX); return; } // no scrolling while dragging
    if (Math.hypot(p.clientX - press.x, p.clientY - press.y) > 8) { clearTimeout(press.timer); press = null; } // a swipe scrolls
  }, { passive: false });
  tabstrip.addEventListener('touchend', end);
  tabstrip.addEventListener('touchcancel', end);
  tabstrip.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const tab = e.target.closest('.tab');
    if (!tab || e.target.closest('[data-tab-close]')) return;
    press = { tab, x: e.clientX, y: e.clientY, dragging: false, mouse: true };
  });
  window.addEventListener('pointermove', (e) => {
    if (!press || !press.mouse) return;
    if (!press.dragging && Math.abs(e.clientX - press.x) > 6) start();
    if (press.dragging) move(e.clientX);
  });
  window.addEventListener('pointerup', (e) => { if (press && press.mouse) end(e); });
})();

// ====================================================================== background sync (Android)
/**
 * The Android app checks Drive about every 15 minutes even while closed (SyncWorker), using the
 * Drive changes feed. It needs the notes folder and its subfolders, plus the user's rules.
 */
/**
 * listed: sent right after every folder was read (a sync that succeeded); the background check
 * then forgets what it learnt about folders by itself and starts again from this list.
 */
function pushBackgroundConfig({ clear = false, listed = false, failed = [] } = {}) {
  if (!NATIVE || !NATIVE.setBackgroundSync) return;
  const lib = snapshot();
  const main = drive.account();
  // One entry per account: its note folders, the folders below them with their parent, and the
  // folders deleted in the app (they and what is below them stay quiet).
  const byAcct = new Map();
  for (const src of settings.sources) {
    if (!byAcct.has(src.acct)) byAcct.set(src.acct, { acct: src.acct || (main && main.email) || '', roots: [], folders: {}, hidden: [], listed: false });
    byAcct.get(src.acct).roots.push(src.root);
  }
  if (lib.sig === sourcesSig()) {
    const hidden = hiddenMap();
    const single = settings.sources.length === 1 ? settings.sources[0].root : null;
    for (const f of Object.values(lib.folders || {})) {
      const a = byAcct.get(f.acct || '');
      if (!a || f.repo) continue;
      if (hidden[f.id] === true) a.hidden.push(f.id); // a whole note folder may be deleted too
      if (a.roots.includes(f.id)) continue;
      a.folders[f.id] = f.parent === ROOT && single ? single : f.parent; // one folder: its top is the library's
    }
    // Per account: one that couldn't be read keeps what the background check learnt.
    for (const [key, a] of byAcct) a.listed = listed && !failed.some((x) => (x.acct || '') === key);
  }
  const driveOn = drive.isConnected() && settings.sources.length > 0;
  const od = backgroundOnedrive();
  NATIVE.setBackgroundSync(JSON.stringify({
    enabled: !!(settings.bgSync && (driveOn || settings.ghRepos.length || od)),
    onedrive: od,
    accounts: driveOn ? [...byAcct.values()] : [],
    github: backgroundRepos(),
    githubWait: github.limitedUntil(), // the same hourly limit: the app was just told to wait
    syncWifiOnly: settings.syncWifiOnly,
    download: settings.autoDownload,
    downloadWifiOnly: settings.wifiOnly || settings.syncWifiOnly,
    notify: settings.bgNotify,
    notifTitle: t('bgNotifTitle'), // "{n}" is filled in by the app
    channelName: t('bgChannel'),
    clear, // disconnected: delete what the background check downloaded
  }));
}

/**
 * OneDrive for the background check: the account, the folders below the chosen ones (and those),
 * and short hashes of the note versions the app already has (only newer ones are announced).
 * Deleted notes and folders stay quiet.
 */
function backgroundOnedrive() {
  const acc = onedrive.account();
  const lib = cloudLibrary.get('onedrive');
  const chosen = cloudFolders('onedrive');
  if (!acc || acc.reauth || !chosen.length || lib.acct !== acc.email) return null;
  const shownFolders = allFolders();
  const folders = chosen.filter((x) => shownFolders[folderId('onedrive', x.id)]).map((x) => x.id);
  for (const d of Object.values(lib.folders || {})) if (d.parent !== ROOT && shownFolders[d.id]) folders.push(d.rid);
  const known = [];
  for (const f of Object.values(lib.files || {})) known.push(github.shortHash(f.rid + '\n' + f.modifiedTime));
  return { acct: acc.email, sig: cloudSig('onedrive'), folders, known };
}

/**
 * The GitHub repositories for the background check, with what the app already has of each
 * (newest commit, PDF versions) so only newer changes are announced.
 */
function backgroundRepos() {
  const lib = ghLibrary.get();
  const shown = allFiles(); // deleted notes and the notes in deleted folders stay quiet
  return settings.ghRepos.map((e) => {
    const key = github.repoKey(e);
    const st = (lib.states || {})[key] || {};
    const known = []; // short hashes keep the app's stored settings small
    const quiet = [];
    const assets = {};
    // Deleted folders (and what is below them) stay quiet, new files there too.
    const shownFolders = allFolders();
    const quietDirs = Object.values(lib.folders || {})
      .filter((d) => d.repo === key && !d.relTag && typeof d.p === 'string' && !shownFolders[d.id])
      .map((d) => d.p);
    const quietRelease = Object.values(lib.folders || {}).some((d) => d.repo === key && d.relTag && !shownFolders[d.id]);
    for (const f of Object.values(lib.files || {})) {
      if (f.repo !== key) continue;
      if (f.gh.asset) assets[f.gh.asset] = f.modifiedTime;
      else if (shown[f.id]) known.push(github.shortHash(f.gh.p + '\n' + f.gh.blob));
      else quiet.push(github.shortHash(f.gh.p));
    }
    return {
      key, owner: e.owner, repo: e.repo, ref: e.ref, path: e.path, only: e.only,
      head: st.head ? st.head.sha : '',
      releases: e.only === 'releases' || (!e.path && !!st.release), // ones without a release: the app checks
      known, quiet, assets, quietDirs, quietRelease,
    };
  });
}

/** Ask for the notification permission (Android 13+) once background updates are on. */
let notifAskManual = false;
function askNotifications({ manual = false } = {}) {
  if (!NATIVE || !NATIVE.requestNotifications) return;
  kv.set('notifAsked', true);
  notifAskManual = manual;
  const r = NATIVE.requestNotifications();
  if (r === 'granted') window.__gnvNotifPerm(true);
}
function maybeAskNotifications() {
  if (!NATIVE || !NATIVE.requestNotifications || !settings.bgSync || !settings.bgNotify || kv.get('notifAsked', false)) return;
  kv.set('notifAsked', true);
  // Say why before Android's permission prompt appears.
  dialog({ title: t('bgNotify'), message: t('bgNotifRationale'), okText: t('bgNotifAllow'), cancelText: t('notNow') }).then((ok) => {
    if (ok) askNotifications({ manual: true });
    else window.__gnvNotifPerm(false);
  });
}
window.__gnvNotifPerm = (granted) => {
  if (granted) return;
  // Without the permission the switch would be lying: turn it off (it can be turned on again later).
  saveSettings({ bgNotify: false });
  pushBackgroundConfig();
  if (notifAskManual) toast(t('bgNotifDenied'), { duration: 6000 });
  if (currentRoute && currentRoute.tab === 'settings') render({ keepScroll: true });
};

/** Bring in what the background check found: newer note versions and the PDFs it downloaded. */
let bgImporting = null;
function importBackgroundUpdates() {
  if (!NATIVE || !NATIVE.takeBackgroundUpdates) return Promise.resolve();
  if (!bgImporting) bgImporting = doImportBackground().finally(() => { bgImporting = null; });
  return bgImporting;
}
async function doImportBackground() {
  let updates = [];
  try { updates = JSON.parse(NATIVE.takeBackgroundUpdates()); } catch { return; }
  if (!updates.length) return;
  const lib = snapshot();
  const sameRoot = settings.sources.length && lib.sig === sourcesSig();
  const single = settings.sources.length === 1 ? settings.sources[0] : null;
  const fresh = [];
  let changed = false;
  for (const u of updates) {
    const prev = lib.files[u.id];
    const parent = single && u.parent === single.root ? ROOT : u.parent;
    const home = parent === ROOT ? single : lib.folders[parent]; // which note folder it belongs to
    // Older than what a foreground sync already saw → nothing to do.
    if (!sameRoot || (prev && prev.modifiedTime > u.modifiedTime)) { NATIVE.doneBackgroundUpdate(u.id, u.modifiedTime || ''); continue; }
    if ((!prev || prev.modifiedTime !== u.modifiedTime) && (parent === ROOT || lib.folders[parent])) {
      lib.files[u.id] = {
        ...(prev || { thumb: '' }),
        id: u.id,
        name: String(u.name || '').replace(/\.pdf$/i, ''),
        parent,
        modifiedTime: u.modifiedTime,
        size: Number(u.size || 0),
        source: 'drive',
        acct: home ? home.acct || '' : '',
        src: home ? home.src || home.root || '' : '',
      };
      changed = true;
    }
    fresh.push(u);
  }
  if (changed) {
    library.set(lib);
    offerNewVersion(lib.files);
    if (currentRoute && !currentRoute.doc) render({ keepScroll: true });
  }
  for (const u of fresh) {
    try {
      if (u.url && !cache.isFresh(u)) {
        const res = await fetch(u.url);
        if (!res.ok) throw new Error(res.status);
        await cache.putPdf(u.id, await res.blob(), u.modifiedTime);
        const f = snapshot().files[u.id];
        if (f) { queueCover(f); refreshCells(u.id); }
      }
    } catch (e) {
      console.warn('background file', u.name, e); // the note downloads normally when opened
    }
    NATIVE.doneBackgroundUpdate(u.id, u.modifiedTime || '');
  }
}

// ====================================================================== boot
// ====================================================================== language
/** Fill the fixed texts in index.html (data-i18n / data-i18n-aria / data-i18n-ph). */
function applyStaticTexts() {
  document.title = t('appName');
  const desc = document.querySelector('meta[name=description]');
  if (desc) desc.setAttribute('content', t('appDesc'));
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  $$('[data-i18n-ph]').forEach((el) => el.setAttribute('placeholder', t(el.dataset.i18nPh)));
}

function langLabel() {
  if (!settings.lang || settings.lang === 'auto') return t('languageAuto');
  const found = LANGS.find(([code]) => code === settings.lang);
  return found ? found[1] : '';
}

function chooseLanguage() {
  const cur = settings.lang || 'auto';
  actionSheet({
    title: t('language') + (currentLang() !== 'en' ? langAlso() : ''),
    items: [
      { label: `${cur === 'auto' ? '✓ ' : ''}${t('languageAuto')}`, icon: 'globe', onClick: () => setLanguage('auto') },
      ...LANGS.map(([code, name]) => ({ label: `${cur === code ? '✓ ' : ''}${name}`, onClick: () => setLanguage(code) })),
    ],
  });
}

function setLanguage(code) {
  saveSettings({ lang: code });
  applyLang();
  applyStaticTexts();
  viewer.updateScrub();
  pushBackgroundConfig(); // notification texts follow the language
  render({ keepScroll: true });
}

function boot() {
  applyTheme();
  applyStaticTexts();
  hydrateIcons(document);
  const auth = drive.consumeAuthResponse();
  if (auth) {
    if (auth.ok) {
      markReauth(false);
      sessionStorage.removeItem('gnv.silentAt');
      if (!auth.silent) toast(t('driveConnected'));
      drive.fetchAccount().catch(() => {});
    } else if (auth.silent) {
      markReauth(true);
    } else {
      const msg = {
        access_denied: t('authDenied'),
        scope_denied: t('authScopeDenied'),
        state_mismatch: t('authStateMismatch'),
      }[auth.error] || t('authFailedWeb', { e: auth.error });
      toast(msg);
    }
  } else if (!NATIVE && settings.clientId && drive.isConnected() && !drive.hasValidToken() && navigator.onLine) {
    // Web: renew the expired token with a quick redirect before showing anything.
    // (The Android app renews tokens in place, so it never needs to stop here.)
    if (trySilentAuth()) return;
  }
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/docs');
  onRoute();
  if (driveUsable()) sync();
  else { prefetchCoversOnly(); syncOthers(); prefetch(); }
  if (NATIVE) {
    window.__gnvShares();
    window.__gnvOpenNote();
    sendWidget();
    pushBackgroundConfig();
    importBackgroundUpdates();
    githubAnnounced();
    onedriveAnnounced();
  } else if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // Copies of GitHub notes whose repository went away while they were downloading.
  const gh = ghLibrary.get().files || {};
  sweepGone((id) => id.startsWith('gh:') && !gh[id]);
  for (const k of CLOUD_KEYS) {
    const c = cloudLibrary.get(k);
    const files = c.files || {};
    const waiting = c.pending || {}; // missing from a read, not confirmed gone yet: see syncCloud
    sweepGone((id) => isCloudFile(k, id) && !files[id] && !waiting[id]);
  }
}

/** The background check announced OneDrive changes: look now. */
function onedriveAnnounced() {
  if (NATIVE && NATIVE.takeOnedriveChanged && NATIVE.takeOnedriveChanged()) syncCloud('onedrive', { force: true });
}

/** The background check announced GitHub changes: show them now rather than at the next check. */
function githubAnnounced() {
  if (NATIVE && NATIVE.takeGithubChanged && NATIVE.takeGithubChanged()) syncGithub({ force: true });
}

function prefetchCoversOnly() {
  for (const f of Object.values(allFiles())) if (!remote(f) || cache.isFresh(f)) queueCover(f);
}

boot();
