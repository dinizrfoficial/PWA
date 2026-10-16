const CACHE='zlinktalk-web-shell-v4-registration-20261015';
const SHELL=['./','./index.html','./styles.css','./app.js','./audio.js','./amrwb-panel-decoder.js','./zlink-pcm-worklet.js','./amrwb-encode-worker.js','./pcm-capture-worklet.js','./config.js','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.includes('/api/'))return;
 // Somente arquivos estáticos. Nunca armazenar dados privados/tokens/contas.
 event.respondWith(fetch(event.request).then(response=>{if(response.ok&&['document','script','style','image','manifest'].includes(event.request.destination)){const copy=response.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));}return response;}).catch(()=>caches.match(event.request)));
});
