// Service worker: فقط پوسته‌ی اپ کش می‌شود. فایل داده، API و تایل نقشه هرگز کش نمی‌شوند.
const V = "arzesh-v9";
const SHELL = ["./","index.html","config.js","listings-core.js","pricing.js","rent-pricing.js","pricing-model.json","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png",
  "vendor/leaflet.js","vendor/leaflet.css","vendor/xlsx.full.min.js","vendor/fonts/Vazirmatn.woff2"];
self.addEventListener("install",e=>{ e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())); });
self.addEventListener("activate",e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener("fetch",e=>{
  const r = e.request, u = new URL(r.url);
  if(r.method!=="GET" || u.origin!==location.origin) return;                    // تایل و API خارجی: مستقیم
  if(/\/(data|api|storage)\//.test(u.pathname)) return;                          // داده و ثبت‌نام: مستقیم
  const fresh = /\.(html|js|json|webmanifest)$|\/$/.test(u.pathname) && !u.pathname.includes("/vendor/");
  e.respondWith(fresh
    ? fetch(r).then(x=>{ const cp=x.clone(); caches.open(V).then(c=>c.put(r,cp)); return x; }).catch(()=>caches.match(r))   // آنلاین: نسخه‌ی تازه
    : caches.match(r).then(h=>h||fetch(r).then(x=>{ const cp=x.clone(); caches.open(V).then(c=>c.put(r,cp)); return x; })));
});
