/* Static-site build for the Journal frontend.
   Assembles the Apps Script sources into one static page that any static host
   (Cloudflare Pages, GitHub Pages, Netlify, Vercel) can serve as text/html.
   No dependencies: node build_frontend.mjs  ->  dist/index.html  */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

const [index, styles, javascript, runtime] = await Promise.all([
  read('apps-script/Index.html'),
  read('apps-script/Styles.html'),
  read('apps-script/JavaScript.html'),
  read('dev/supabase_runtime.js')
]);

const stylesMarker = "<?!= include('Styles'); ?>";
const javascriptMarker = "<?!= include('JavaScript'); ?>";
if (!index.includes(stylesMarker) || !index.includes(javascriptMarker)) {
  throw new Error('apps-script/Index.html does not contain the expected Apps Script include markers.');
}

/* Replacement callbacks are important here: JavaScript can contain `$&`, `$'`, or `$``.
   String.replace interprets those specially when given a replacement string, corrupting
   the bundled source. A callback returns the replacement literally. */
const output = index
  .replace('<head>', '<head><title>Crypto Journal</title><link rel="manifest" href="/manifest.webmanifest?v=2"><meta name="theme-color" content="#101a2b"><link rel="apple-touch-icon" href="/icon-192.png">')
  .replace('</body>', `<script>
(function(){
  var pending=null,btn=document.createElement('button');btn.textContent='Install Crypto Journal';btn.hidden=true;btn.style.cssText='position:fixed;bottom:18px;right:16px;z-index:99999;padding:12px 16px;background:#e7bf67;color:#101a2b;border:0;border-radius:10px;font:600 13px system-ui;box-shadow:0 4px 20px #0008';
  document.body.appendChild(btn);
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();pending=e;btn.hidden=false;});
  window.addEventListener('appinstalled',function(){btn.hidden=true;pending=null;});
  btn.addEventListener('click',async function(){if(!pending)return;await pending.prompt();await pending.userChoice;pending=null;btn.hidden=true;});
  if('serviceWorker' in navigator)navigator.serviceWorker.getRegistration().then(function(r){if(r)r.update();}).catch(function(){});
})();
</script></body>`)
  .replace(stylesMarker, () => styles)
  .replace(javascriptMarker, () => `<script>\n${runtime}\n</script>\n${javascript}`);

if (output.includes(stylesMarker) || output.includes(javascriptMarker)) {
  throw new Error('An Apps Script include marker remains in the static output.');
}

const outDir = path.join(root, 'dist');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'index.html'), output, 'utf8');
/* SCOUT-ALERT-1 · tiny service worker so the Scout BUY alert can show as a phone/desktop notification
   (Android Chrome only shows notifications through a service worker). No caching: it never serves the app. */
const sw = `self.addEventListener('install', function (e) { e.waitUntil(caches.open('cj-offline-v1').then(function(c){return c.add('/offline.html');}).then(function(){return self.skipWaiting();})); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e){ if(e.request.mode==='navigate' && new URL(e.request.url).origin===self.location.origin){e.respondWith(fetch(e.request,{cache:'no-store'}).catch(function(){return caches.match('/offline.html');}));} });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var t = (e.notification.data && e.notification.data.ticker) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) { list[i].postMessage({ type: 'scout-open', ticker: t }); return list[i].focus(); } }
    return self.clients.openWindow('./?open=' + encodeURIComponent(t));
  }));
});
`;
await writeFile(path.join(outDir, 'sw.js'), sw, 'utf8');
console.log(`Static build written to ${path.join(outDir, 'index.html')} (${output.length} bytes)`);

for (const file of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'offline.html', 'install.html']) { await writeFile(path.join(outDir,file), await readFile(path.join(root,'pwa',file))); }
await writeFile(path.join(outDir,'_headers'), `/*
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/manifest.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: no-cache
`);

// Offline document metadata is copied verbatim from pwa/offline.html.
