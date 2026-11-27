// Offline support: app shell and PDF.js are cached; Google APIs always go to the network.
const VERSION = 'gnv-1.29.0';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/config.js',
  'js/drive.js',
  'js/icons.js',
  'js/pdf.js',
  'js/store.js',
  'js/ui.js',
  'js/viewer.js',
  'js/i18n.js',
  'js/export.js',
  'js/ocr.js',
  'js/toc.js',
  'js/github.js',
  'js/onedrive.js',
  'js/cloud.js',
  'js/dropbox.js',
  'js/mybox.js',
  'js/webdav.js',
  'js/pagediff.js',
  'js/ink.js',
  'js/formats.js',
  'js/convert.js',
  'js/hwpx.js',
  'js/hwp5.js',
  'js/cfb.js',
  'js/aes.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/pdf-lib/pdf-lib.esm.min.js',
  'vendor/docx-preview/docx-preview.mjs',
  'vendor/jszip/jszip.mjs',
  'vendor/jszip/jszip.min.js',
  'icons/icon-192.png',
  'icons/favicon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Only our own old caches: another app on the same site keeps its own.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gnv-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // Stale-while-revalidate for our own files: instant start, updates on next launch.
  const work = caches.open(VERSION).then(async (cache) => {
    const key = url.origin + url.pathname;
    const cached = await cache.match(key);
    const network = fetch(req)
      .then(async (res) => {
        if (res.ok && res.type === 'basic') await cache.put(key, res.clone());
        return res;
      })
      .catch(() => cached || Response.error());
    return { cached, network };
  });
  e.respondWith(work.then(({ cached, network }) => cached || network));
  e.waitUntil(work.then(({ network }) => network.catch(() => {})));
});
