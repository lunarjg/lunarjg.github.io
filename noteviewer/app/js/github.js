// Public GitHub repositories as a note source, read without signing in: the PDFs of a branch (or
// of one folder in it) and the PDFs attached to the repository's latest release.
//
// GitHub allows about 60 anonymous API calls an hour per network, so a check costs one call per
// repository when nothing changed (its newest commit) and reads the file list only after a
// change. Files come from raw.githubusercontent.com and release downloads, which aren't counted.

import { kv } from './store.js';
import { t, joinList } from './i18n.js';
import { isNoteName, baseName, formatOf } from './formats.js';

const API = 'https://api.github.com';
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}$/u; // what git allows in a branch name
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_FILES = 1000; // PDFs per repository
const MAX_TOTAL = 3000; // in all repositories (the list is kept in the app's small storage)
const MAX_ASSETS = 100;
const RELEASE_RECHECK = 6 * 3600_000; // no release last time: look again after 6 hours

export class RateLimitError extends Error {
  constructor(until) {
    super(t('ghRateLimited', { min: Math.max(1, Math.ceil((until - Date.now()) / 60_000)) }));
    this.until = until;
  }
}
export class NotFoundError extends Error {}
export class NetworkError extends Error {}

/** The most repositories one can add: each check spends some of the anonymous hourly calls. */
export const MAX_REPOS = 10;

/** In the Android app files come through it: release downloads don't allow other origins (CORS). */
const native = typeof window !== 'undefined' && window.GNVNative ? window.GNVNative : null;

/**
 * A repository the user added: {owner, repo, ref, path, only} from what they pasted —
 * owner/repo, github.com/owner/repo, …/tree/<branch>/<folder>, …/blob/<branch>/<file.pdf>,
 * …/releases. ref '' = the default branch, path '' = the whole branch, only 'releases' = just
 * the release files. Returns null for anything else.
 */
export function parseRepoUrl(input) {
  let s = String(input || '').trim();
  s = s.replace(/^git\+/i, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null; // another site
  s = s.split(/[?#]/)[0];
  let parts;
  try {
    parts = s.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [owner, rawRepo, kind, ...rest] = parts;
  const repo = (rawRepo || '').replace(/\.git$/i, '');
  if (!owner || !OWNER.test(owner) || !REPO.test(repo) || /^\.+$/.test(repo)) return null;
  const out = { owner, repo, ref: '', path: '', only: '' };
  if (kind === 'tree' || kind === 'blob') {
    // A branch name may contain "/": resolveRef() finds where it ends (first segment for now).
    out.ref = rest[0] || '';
    out.path = rest.slice(1).join('/');
    if (rest.length > 1) Object.defineProperty(out, 'segs', { value: rest, enumerable: false });
  } else if (kind === 'releases') {
    out.only = 'releases';
  }
  if (out.ref && (!REF.test(out.ref) || out.ref.includes('..'))) return null;
  if (out.path.split('/').some((p) => p === '.' || p === '..') || out.path.length > 500) return null;
  return out;
}

/** Keep only well-formed entries (they come from stored settings). */
export function cleanRepos(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && OWNER.test(e.owner) && REPO.test(e.repo)
    && typeof e.ref === 'string' && (!e.ref || REF.test(e.ref))
    && typeof e.path === 'string' && (e.only === '' || e.only === 'releases'));
}

/**
 * For a …/tree/<a>/<b>/… address: which leading segments are the branch name ("feature/notes"
 * is one branch). Asks GitHub about each candidate, shortest first (usually one call); when none
 * is a branch (a tag or a commit), the first segment stays.
 */
export async function resolveRef(e, { file = false } = {}) {
  const segs = e.segs;
  if (!segs || segs.length < 2) return e;
  const base = `/repos/${encodeURIComponent(e.owner)}/${encodeURIComponent(e.repo)}`;
  const most = Math.min(file ? segs.length - 1 : segs.length, 5);
  for (let n = 1; n <= most; n++) {
    const ref = segs.slice(0, n).join('/');
    try {
      await api(`${base}/branches/${encodeURIComponent(ref)}`);
      return { owner: e.owner, repo: e.repo, ref, path: segs.slice(n).join('/'), only: e.only };
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  return e;
}

export function repoKey(e) {
  return `${e.owner.toLowerCase()}/${e.repo.toLowerCase()}@${e.ref}:${e.path}#${e.only}`;
}
export function reposSig(list) {
  return list.map(repoKey).join('|');
}
/** Shown as the repository's folder: the folder or file it points at, else the repository. */
export function repoName(e) {
  return e.path ? baseName(e.path.split('/').pop()) : e.repo;
}
/** owner/repo, branch, /folder — for Settings. */
export function repoLabel(e) {
  return joinList([`${e.owner}/${e.repo}`, e.ref, e.path && '/' + e.path, e.only && t('ghReleasesOnly')]);
}

/** A commit date with nine digits of fractions of a second taken from a blob's id. */
function versionOf(date, blob) {
  const t = Date.parse(date);
  const iso = new Date(Number.isFinite(t) ? t - (t % 1000) : 0).toISOString().slice(0, 19);
  return `${iso}.${String(parseInt(blob.slice(0, 8), 16) % 1e9 || 0).padStart(9, '0')}Z`;
}

/** Short stable id (note ids appear in links, the widget and file names: no slashes). */
function hash(s) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/**
 * How often the app may check: every 15 minutes, less often with many repositories, so a check
 * an hour stays well inside the anonymous limit (the background check needs some too).
 */
export function checkInterval(entries, states = {}) {
  let calls = 0;
  for (const e of entries) {
    const st = states[repoKey(e)] || {};
    calls += e.only === 'releases' ? 1 : 1 + (native && !e.path && st.release ? 1 : 0);
  }
  return Math.max(15 * 60_000, calls * 2 * 60_000); // at most ~30 calls an hour
}

/** Short hash of a text, as hex (FNV-1a; the Android app's GitHub.hash() is the same). */
export function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** Until when GitHub asked us to wait (rate limit), as a timestamp; 0 when it didn't. */
export function limitedUntil() {
  const v = kv.get('ghWait', 0);
  return v > Date.now() ? v : 0;
}

async function api(path, signal) {
  const until = limitedUntil();
  if (until) throw new RateLimitError(until);
  let res;
  try {
    res = await fetch(API + path, {
      headers: { Accept: 'application/vnd.github+json' }, // no other headers: no CORS preflight
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new NetworkError(t('ghNetwork'));
  }
  if ((res.status === 403 || res.status === 429)
      && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'))) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || 0;
    const retry = Number(res.headers.get('retry-after')) * 1000 || 0;
    // At least a minute, at most an hour (a wrong clock must not stop checks for long).
    const wait = Math.min(Date.now() + 3600_000, Math.max(reset, Date.now() + retry, Date.now() + 60_000));
    kv.set('ghWait', wait);
    throw new RateLimitError(wait);
  }
  if (res.status === 404 || res.status === 451) throw new NotFoundError(String(res.status));
  if (res.status === 409) return null; // empty repository
  if (!res.ok) throw new Error(t('ghHttp', { code: res.status }));
  return res.json();
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Read one repository. prev = what the last check found for it ({state, files}) so an unchanged
 * branch costs one call and unchanged files keep their date. Returns {folders, files, state}.
 */
export async function checkRepo(e, prev = null, { signal } = {}) {
  const key = repoKey(e);
  const base = `/repos/${encodeURIComponent(e.owner)}/${encodeURIComponent(e.repo)}`;
  const rootId = 'ghr:' + hash(key);
  // p: the folder's path in the repository (the background check keeps deleted folders quiet).
  const folders = { [rootId]: { id: rootId, name: repoName(e), parent: 'root', repo: key, modifiedTime: '', p: e.only ? null : e.path } };
  const files = {};
  const before = prev ? prev.files || {} : {};
  const was = prev && prev.state ? prev.state : {};
  const state = { head: null, release: null, releaseCheckedAt: 0, truncated: false };

  if (e.only !== 'releases') {
    const q = new URLSearchParams({ per_page: '1' });
    if (e.ref) q.set('sha', e.ref);
    if (e.path) q.set('path', e.path);
    const commits = await api(`${base}/commits?${q}`, signal);
    const c = Array.isArray(commits) ? commits[0] : null;
    if (!c && e.path) throw new NotFoundError('path'); // no commit ever touched it
    if (c && SHA.test(c.sha)) {
      const date = (c.commit && ((c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date))) || '';
      state.head = { sha: c.sha, date };
      if (was.head && was.head.sha === c.sha) {
        // Nothing new: the same files as last time.
        state.truncated = !!was.truncated;
        for (const f of Object.values(before)) if (!f.gh.asset) files[f.id] = f;
        for (const f of Object.values(prev.folders || {})) if (!f.relTag && f.id !== rootId) folders[f.id] = f;
      } else {
        const tree = await api(`${base}/git/trees/${c.sha}?recursive=1`, signal);
        state.truncated = !!(tree && tree.truncated);
        const prefix = e.path ? e.path + '/' : '';
        let n = 0;
        for (const it of (tree && Array.isArray(tree.tree) ? tree.tree : [])) {
          if (!it || it.type !== 'blob' || typeof it.path !== 'string' || !isNoteName(it.path)) continue;
          if (e.path && it.path !== e.path && !it.path.startsWith(prefix)) continue;
          if (++n > MAX_FILES) { state.truncated = true; break; }
          const rel = it.path === e.path ? it.path.split('/').pop() : it.path.slice(prefix.length);
          const dirs = rel.split('/');
          const name = dirs.pop();
          let parent = rootId;
          let at = '';
          for (const d of dirs) {
            at += (at ? '/' : '') + d;
            const id = 'ghf:' + hash(key + '\n' + at);
            if (!folders[id]) folders[id] = { id, name: d, parent, repo: key, modifiedTime: '', p: prefix + at };
            parent = id;
          }
          const id = 'gh:' + hash(key + '\n' + it.path);
          const old = before[id];
          // The date doubles as the version (offline copies, reading position): its fraction of a
          // second comes from the file's content id, so different contents never share it.
          const modifiedTime = versionOf(date, String(it.sha || ''));
          files[id] = {
            id,
            name: baseName(name),
            ...(formatOf(name) !== 'pdf' ? { fmt: formatOf(name) } : {}),
            parent,
            // GitHub doesn't say when each file last changed (one call per file); a changed file
            // gets the date of the commit that brought it, an unchanged one keeps its date.
            modifiedTime: old && old.gh.blob === it.sha ? old.modifiedTime : modifiedTime,
            size: Number(it.size) || 0,
            source: 'github',
            repo: key,
            gh: { o: e.owner, r: e.repo, c: c.sha, p: it.path, blob: String(it.sha || '') },
          };
        }
      }
    }
  }

  // The latest release's PDFs, unless the link pointed into a folder. A browser can't download
  // them (no CORS headers on GitHub's release downloads): only the Android app lists them.
  if (native && (e.only === 'releases' || !e.path)) {
    if (e.only !== 'releases' && !was.release && was.releaseCheckedAt && Date.now() - was.releaseCheckedAt < RELEASE_RECHECK) {
      state.releaseCheckedAt = was.releaseCheckedAt; // had none a moment ago: spare the call
    } else {
      let rel = null;
      try {
        rel = await api(`${base}/releases/latest`, signal);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
      state.releaseCheckedAt = Date.now();
      const tag = rel && typeof rel.tag_name === 'string' ? rel.tag_name : '';
      const pdfs = rel && tag && Array.isArray(rel.assets)
        ? rel.assets.filter((a) => a && typeof a.name === 'string' && isNoteName(a.name) && a.state !== 'starter').slice(0, MAX_ASSETS)
        : [];
      if (pdfs.length) {
        state.release = { tag };
        let parent = rootId;
        if (e.only !== 'releases') {
          parent = 'ghrel:' + hash(key); // its own kind of id: a folder may be called "release"
          folders[parent] = { id: parent, name: tag, relTag: tag, parent: rootId, repo: key, modifiedTime: '' };
        }
        const prefix = `https://github.com/${encodeURIComponent(e.owner)}/${encodeURIComponent(e.repo)}/releases/download/`;
        for (const a of pdfs) {
          // Same file name in a newer release = a new version of the same note.
          const id = 'gh:' + hash(key + '\0release\0' + a.name);
          const url = typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(prefix)
            ? a.browser_download_url
            : prefix + encodeURIComponent(tag) + '/' + encodeURIComponent(a.name);
          files[id] = {
            id,
            name: baseName(a.name),
            ...(formatOf(a.name) !== 'pdf' ? { fmt: formatOf(a.name) } : {}),
            parent,
            modifiedTime: a.updated_at || rel.published_at || '',
            size: Number(a.size) || 0,
            source: 'github',
            repo: key,
            gh: { o: e.owner, r: e.repo, asset: a.name, tag, url },
          };
        }
      }
    }
  }
  // An incomplete list (GitHub cut a huge tree short, or our own limit) doesn't mean the files
  // left out were deleted: keep the ones seen before, so their offline copies aren't swept.
  if (state.truncated) {
    for (const f of Object.values(before)) {
      if (files[f.id] || f.gh.asset) continue;
      files[f.id] = f;
      for (let p = f.parent; p && !folders[p] && prev.folders && prev.folders[p]; p = prev.folders[p].parent) folders[p] = prev.folders[p];
    }
  }
  return { folders, files, state };
}

/**
 * Check every repository. One that can't be read now keeps what was seen last time and is
 * reported in `failed` ([{entry, error}]). prev = the stored GitHub library.
 */
export async function checkAll(entries, prev, { signal } = {}) {
  const folders = {};
  const files = {};
  const states = {};
  const failed = [];
  let limited = null;
  for (const e of entries) {
    const key = repoKey(e);
    const mine = (map) => Object.fromEntries(Object.entries((prev && map) || {}).filter(([, x]) => x.repo === key));
    const last = prev && prev.states && prev.states[key]
      ? { state: prev.states[key], files: mine(prev.files), folders: mine(prev.folders) }
      : null;
    try {
      if (limited) throw limited; // GitHub said stop: don't spend more calls now
      const r = await checkRepo(e, last, { signal });
      Object.assign(folders, r.folders);
      let room = MAX_TOTAL - Object.keys(files).length;
      for (const [id, f] of Object.entries(r.files)) {
        // Over the limit: only notes already in the library stay (nothing is swept), no new ones.
        if (room <= 0 && !(last && last.files[id])) { r.state.truncated = true; continue; }
        files[id] = f;
        room--;
      }
      states[key] = r.state;
    } catch (error) {
      if (error instanceof RateLimitError) limited = error;
      failed.push({ entry: e, error });
      if (last) {
        Object.assign(folders, last.folders);
        Object.assign(files, last.files);
        states[key] = last.state;
      }
    }
  }
  return { folders, files, states, failed };
}

/** Download a GitHub file's bytes, reporting progress as a 0..1 fraction. */
export async function download(f, { onProgress, signal } = {}) {
  const g = f.gh || {};
  const repo = `${encodeURIComponent(g.o)}/${encodeURIComponent(g.r)}`;
  if (g.asset) return get(g.url, f.size, onProgress, signal);
  if (!SHA.test(g.c || '')) throw new Error(t('ghFileGone'));
  let blob = await get(`https://raw.githubusercontent.com/${repo}/${g.c}/${enc(g.p)}`, f.size, onProgress, signal);
  // Git LFS keeps a small pointer in the repository; the file itself is served elsewhere.
  if (blob.size < 1024 && /^version https:\/\/git-lfs\.github\.com\/spec\//.test(await blob.text())) {
    blob = await get(`https://media.githubusercontent.com/media/${repo}/${g.c}/${enc(g.p)}`, 0, onProgress, signal);
  }
  return blob;
}

async function get(url, size, onProgress, signal) {
  let res;
  try {
    res = await fetch(native ? '/gh?u=' + encodeURIComponent(url) : url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new NetworkError(t('ghNetwork'));
  }
  if (res.status === 404) throw new Error(t('ghFileGone'));
  if (res.status === 413) throw new Error(t('ghTooLarge'));
  if (!res.ok) throw new Error(t('ghHttp', { code: res.status }));
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
