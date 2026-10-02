/* Шёпот — service worker (PWA)
   Стратегия: сеть в приоритете; кэш — только офлайн-фолбэк.
   Так приложение всегда получает свежие чанки, а офлайн остаётся работоспособным.
   Task 42: pushsubscriptionchange — разрешение/подписка не теряются:
   браузер инвалидировал подписку → SW молча переподписывается и будит
   открытые вкладки обновить запись в БД (нет вкладок — обновит syncPush
   OnLogin при следующем входе). */
const VERSION = 'shpot-v22';
/* BASE = каталог, где лежит сам SW (scope): '/' на корневом хостинге
   или '/whisper/' на GitHub Pages — все пути считаем от него. */
const BASE = new URL('./', self.registration.scope).pathname;
const CORE = [
  BASE,
  BASE + 'manifest.webmanifest',
  BASE + 'icons/favicon.png',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'icons/maskable-512.png',
  BASE + 'offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(CORE).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---- Web Push (Task 40): payload-less пуш — контент задаём сами ---- */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* пустой/нечитаемый пейлоад */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Шёпот', {
      body: data.body || 'Новое сообщение — откройте, чтобы прочитать',
      icon: BASE + 'icons/icon-192.png',
      badge: BASE + 'icons/icon-192.png',
      tag: data.tag || 'shpot-msg',
      renotify: true,
      data: { url: data.url || BASE },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || BASE;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/* ---------- Task 42: подписка не теряется ----------
   Chrome/Firefox истекают подписку при долгой неактивности или чистке
   данных — разрешение при этом ОСТАЁТСЯ. Без этого хендлера устройство
   навсегда выпадало из рассылки. Здесь: тихая переподписка + сигнал
   вкладкам сохранить новый эндпоинт в БД. */
function urlB64ToBytes(s) {
  const pad = '==='.slice((s.length + 3) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
const VAPID_PUBLIC = 'BM6qYyVLxqp8RhhNT-8PkQptOiVPDukQx9KR0Omou1iegBnPc21k9J4sTaWhRYP1W8xNKmNE9H6X289i6kCT6-Y';

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToBytes(VAPID_PUBLIC).buffer,
        });
        if (!sub) return;
        const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of cs) c.postMessage({ type: 'push-resub', endpoint: sub.endpoint });
        // вкладок нет — syncPushOnLogin() сохранит подписку при следующем входе
      } catch (_) { /* переподписка невозможна (разрешение отозвано) —
         следующий вход спросит заново через тумблер */ }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Не перехватываем: сокеты (EIO), мини-сервисы, API, HMR
  const p = url.pathname;
  if (
    url.search.includes('EIO=') ||
    url.search.includes('XTransformPort') ||
    p.includes('/api/') ||
    p.includes('webpack-hmr') ||
    p.endsWith('.hot-update.')
  ) return;
  /* путь внутри приложения (без BASE): '/icons/…' и т.п. */
  const rel = BASE !== '/' && p.startsWith(BASE) ? p.slice(BASE.length - 1) : p;

  // Всё — сеть в приоритете, кэш как фолбэк (никаких устаревших чанков)
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && (req.mode === 'navigate' || rel.startsWith('/icons/') || rel === '/manifest.webmanifest')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => null);
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match(BASE + 'offline.html');
          return undefined;
        })
      )
  );
});
