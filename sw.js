// диагностика: учёт незавершённых waitUntil() у всех обработчиков, включая код OneSignal.
// Активация нового воркера откладывается, пока у активного есть незавершённая работа, а fetch-события —
// не единственный её источник (по журналу с Android «незавершённых fetch = 0», но активация всё равно
// не наступала). Патч ставится ДО importScripts, чтобы видеть и обработчики OneSignal.
const __pendingExt = new Map();
let __eid = 0;
try {
  const origWaitUntil = ExtendableEvent.prototype.waitUntil;
  ExtendableEvent.prototype.waitUntil = function(p){
    const id = ++__eid;
    __pendingExt.set(id, { type: this.type, t: Date.now() });
    const done = () => __pendingExt.delete(id);
    try { Promise.resolve(p).then(done, done); } catch(e){ done(); }
    return origWaitUntil.call(this, p);
  };
} catch(e){}

// OneSignal — веб-пуш уведомления. Совмещаем с нашим собственным SW в один файл,
// а не регистрируем два отдельных на одном скоупе (так рекомендует сам OneSignal).
// В try/catch: если этот внешний запрос к CDN не пройдёт (сеть, блокировка,
// временный сбой) — раньше это ломало ВЕСЬ Service Worker целиком, включая
// наш собственный кэш и офлайн-режим, никак не связанные с OneSignal
try {
  importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
} catch(e){
  // тихо продолжаем без push-уведомлений в этом конкретном запуске —
  // наша собственная функциональность (кэш, офлайн) не должна от этого страдать
}

/*
  Service Worker для Counter Chat.

  Стратегия:
  - index.html (сама страница): "сеть в приоритете" — при каждом открытии
    с доступом в интернет подтягивается САМАЯ СВЕЖАЯ версия с сервера
    и тут же кладётся в кэш. Если сети нет — отдаётся последняя закэшированная
    версия, чтобы приложение всё равно открылось (офлайн-доступ).
  - Остальные файлы (иконки, манифест, сплэши): "кэш в приоритете" — они меняются
    редко, поэтому отдаём мгновенно из кэша, а в фоне тихо обновляем на будущее.

  ВАЖНО: при каждом значимом обновлении контента (новые фразы, карты, дизайн)
  увеличивай CACHE_VERSION на единицу. Это заставит Service Worker пересоздать
  кэш и корректно удалить старый — без этого шага браузер может решить,
  что новый sw.js "такой же", и не обновит закэшированные файлы вовремя.
*/
/* НЕ РЕДАКТИРУЙ ВРУЧНУЮ: __BUILD_VERSION__ подставляется автоматически
   GitHub Action-ом при каждой публикации (см. .github/workflows/deploy.yaml) */
const CACHE_VERSION = '__BUILD_VERSION__';
const CACHE_NAME = `counter-chat-${CACHE_VERSION}`;

/* Картинки интерфейса (иконки категорий, фоны карт, значки) лежат в ОТДЕЛЬНОМ кэше,
   который НЕ пересоздаётся при каждой публикации — иначе после каждого обновления
   приложения телефон заново скачивал бы все ~300 КБ картинок. Файлы отдаются
   «сначала из кэша», без запроса в сеть.
   ВАЖНО: если заменяешь картинку в assets/categories, assets/maps или assets/ui
   под тем же именем — увеличь число в IMG_CACHE (v1 -> v2), иначе у пользователей
   останется старая версия. */
const IMG_CACHE = 'counter-chat-img-v1';

/* Шрифты Google тоже в отдельном постоянном кэше. Раньше они попадали в CACHE_NAME,
   который удаляется при каждой публикации, — и первый запуск после обновления
   снова ждал fonts.googleapis.com по сети. */
const FONT_CACHE = 'counter-chat-fonts-v1';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* Сколько ждать сеть при открытии страницы, если в кэше уже есть копия.
   Дольше — отдаём кэш, чтобы при слабой сети не было белого экрана. */
const NAV_TIMEOUT_MS = 800;
/* единый адрес, под которым в кэше лежит страница приложения (запросы вида /, /index.html,
   /index.html?r=…, /?import=… — это одна и та же страница, скрипт читает параметры сам) */
const INDEX_URL = new URL('./index.html', self.registration.scope).href;
const IMG_PATH_RE = /\/assets\/(categories|maps|ui)\//;
const IMG_SHELL = [
  './assets/categories/all_chat.webp',
  './assets/categories/apologies.webp',
  './assets/categories/basic.webp',
  './assets/categories/colloquial.webp',
  './assets/categories/compliments.webp',
  './assets/categories/courtesy.webp',
  './assets/categories/custom.webp',
  './assets/categories/directions.webp',
  './assets/categories/economy.webp',
  './assets/categories/greetings.webp',
  './assets/categories/info.webp',
  './assets/categories/intro.webp',
  './assets/categories/matchmaking.webp',
  './assets/categories/opinion.webp',
  './assets/categories/peeking.webp',
  './assets/categories/postgame.webp',
  './assets/categories/radio.webp',
  './assets/categories/rank_skill.webp',
  './assets/categories/report.webp',
  './assets/categories/requests.webp',
  './assets/categories/roles.webp',
  './assets/categories/situation.webp',
  './assets/categories/slang.webp',
  './assets/categories/social.webp',
  './assets/categories/special_rounds.webp',
  './assets/categories/technical.webp',
  './assets/categories/tilt.webp',
  './assets/categories/timing.webp',
  './assets/categories/utility.webp',
  './assets/categories/warmup.webp',
  './assets/categories/weapons.webp',
  './assets/maps/dust2.webp',
  './assets/maps/inferno.webp',
  './assets/maps/mirage.webp',
  './assets/maps/nuke.webp',
  './assets/maps/nuke-lower.webp',
  './assets/maps/overpass.webp',
  './assets/maps/ancient.webp',
  './assets/maps/anubis.webp',
  './assets/ui/compact.webp',
  './assets/ui/lang-en.webp',
  './assets/ui/lang-ru.webp',
  './assets/ui/logo.webp',
  './assets/ui/random.webp',
  './assets/ui/star.webp',
];

// загрузочные экраны (apple-touch-startup-image) нужны только на iOS — на других платформах
// не качаем лишние ~2,7 МБ при каждой установке воркера
const IOS_SPLASH = [
  './assets/splash/splash-1290x2796.png',
  './assets/splash/splash-1179x2556.png',
  './assets/splash/splash-1284x2778.png',
  './assets/splash/splash-1170x2532.png',
  './assets/splash/splash-1080x2340.png',
  './assets/splash/splash-1242x2688.png',
  './assets/splash/splash-828x1792.png',
  './assets/splash/splash-1125x2436.png',
  './assets/splash/splash-1320x2868.png',
  './assets/splash/splash-1206x2622.png',
];
const IS_IOS = /iPhone|iPad|iPod/i.test((self.navigator && self.navigator.userAgent) || '');

const APP_SHELL = [
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-android-192.png',
  './assets/icons/icon-android-512.png',
  './assets/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then((cache) => Promise.all([
      cache.addAll(IS_IOS ? APP_SHELL.concat(IOS_SPLASH) : APP_SHELL).catch(() => {}), // не роняем установку, если какой-то файл не нашёлся
      // страница кладётся в кэш новой версии в обход HTTP-кэша браузера (cache:'reload'), чтобы сразу после
      // обновления воркера из кэша отдавалась именно свежая страница, а не копия до 10 минут давности
      fetch(INDEX_URL, { cache: 'reload' }).then((res) => { if (res && res.ok) return cache.put(INDEX_URL, res); }).catch(() => {}),
    ])).catch(() => {}),
    // картинки докачиваем по одной и только те, которых ещё нет в кэше картинок;
    // сбой одного файла не мешает остальным
    caches.open(IMG_CACHE).then((cache) => Promise.allSettled(IMG_SHELL.map(async (url) => {
      if (await cache.match(url)) return;
      const res = await fetch(url);
      if (res.ok) await cache.put(url, res);
    }))).catch(() => {}),
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== IMG_CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ includeUncontrolled: true, type: 'window' }))
      .then((cs) => cs.forEach((c) => { try { c.postMessage({ type: 'SW_DBG', msg: 'activate: кэши очищены, clients.claim() выполнен' }); } catch(e){} }))
  );
});

// позволяет странице попросить новый Service Worker активироваться немедленно
// (используется кнопкой "Обновить" в баннере обновления)
/* Текст мини-changelog для баннера обновления — подставляется автоматически
   GitHub Action-ом из changelog.json при каждой публикации. НЕ редактируй
   вручную — редактируй changelog.json, а сюда значение попадёт само. */
const CHANGELOG_TEXT = '__CHANGELOG_TEXT__';

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING'){
    // диагностика: воркер сам сообщает странице, дошло ли сообщение и сработал ли skipWaiting()
    const dbg = (m) => { try { event.source && event.source.postMessage({ type: 'SW_DBG', msg: m }); } catch(e){} };
    dbg('воркер получил SKIP_WAITING, вызываю skipWaiting()');
    self.skipWaiting().then(() => dbg('skipWaiting() выполнен'), (e) => dbg('skipWaiting() ошибка: ' + e));
  }
  if (event.data === 'GET_CHANGELOG'){
    // отвечаем странице напрямую, без HTTP-запроса — так его не может перехватить
    // ещё активный СТАРЫЙ Service Worker со своей (потенциально устаревшей) логикой
    event.source.postMessage({ type: 'CHANGELOG', text: CHANGELOG_TEXT });
  }
  if (event.data === 'GET_PENDING'){
    const now = Date.now();
    const list = [...__inflight.values()].map((v) => Math.round((now - v.t) / 1000) + 'с ' + v.url.slice(0, 90));
    const extList = [...__pendingExt.values()].map((v) => v.type + ' ' + Math.round((now - v.t) / 1000) + 'с');
    try { event.source.postMessage({ type: 'SW_DBG', msg: 'активный воркер: незавершённых waitUntil = ' + extList.length + (extList.length ? ' → ' + extList.join(' ; ') : '') }); } catch(e){}
    try { event.source.postMessage({ type: 'SW_DBG', msg: 'активный воркер: незавершённых fetch = ' + list.length + (list.length ? ' → ' + list.join(' ; ') : '') }); } catch(e){}
  }
  if (event.data === 'GET_VERSION'){
    event.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});

// диагностика: какие запросы сейчас «висят» у этого воркера. WebKit откладывает активацию
// нового воркера, пока у активного есть незавершённые события (проверено по исходнику
// SWServerRegistration::tryActivate), поэтому полезно видеть, не завис ли какой-то запрос
const __inflight = new Map();
let __fid = 0;
function respondTracked(event, promise){
  const id = ++__fid;
  __inflight.set(id, { url: event.request.url, t: Date.now() });
  const done = () => __inflight.delete(id);
  Promise.resolve(promise).then(done, done);
  event.respondWith(promise);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // пробный запрос для проверки реальной доступности сети (используется для
  // честного определения офлайна на iOS, где navigator.onLine ненадёжен) —
  // намеренно НЕ перехватываем его вообще, пропускаем напрямую в браузер,
  // иначе Service Worker может ответить из собственной логики кэширования
  // и исказить результат проверки
  if (req.url.includes('probe=')) return;

  // запросы к API OneSignal (api.onesignal.com и т.п.) не перехватываем: это не ресурсы
  // приложения, кэшировать их незачем, а зависший такой запрос держит fetch-событие
  // активного воркера «незавершённым», и WebKit откладывает активацию нового воркера
  // (по журналу с iPhone: висел api.onesignal.com/sync/...?callback=__jp0). Сам скрипт SDK
  // с cdn.onesignal.com по-прежнему кэшируется обычным образом
  try {
    const h = new URL(req.url).hostname;
    if (h.endsWith('onesignal.com') && h !== 'cdn.onesignal.com') return;
  } catch(e){}

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  const isChangelog = req.url.includes('changelog.json');

  // кэш-сразу работает ТОЛЬКО для самой страницы приложения (/ и /index.html). Любые другие HTML-страницы
  // сайта (tools/…, 404.html, тестовые) воркер не трогает — их открывает браузер напрямую из сети,
  // иначе вместо них показывалась бы страница приложения
  let isAppPage = false;
  try {
    const pn = new URL(req.url).pathname, sp = new URL(self.registration.scope).pathname;
    isAppPage = (pn === sp || pn === sp + 'index.html');
  } catch(e){}
  if (isHTML && !isAppPage) return;

  if (isHTML) {
    // СТРАНИЦА: «кэш сразу, обновление в фоне». Белый экран при запуске длится ровно столько, сколько
    // страница не доходит до первой отрисовки, а раньше она всегда ждала ответа сети (по замерам с iPhone
    // первая отрисовка наступала сразу после конца ответа сервера). Теперь копия из кэша отдаётся мгновенно,
    // а свежая версия скачивается в фоне и ложится в кэш к следующему запуску.
    // ВАЖНО: cache:'no-store' обязателен — без него fetch() может тихо вернуть ответ из встроенного
    // HTTP-кэша браузера (отдельного от Cache API), и «свежий» запрос не дойдёт до сервера.
    // Новая версия приложения всё равно доходит до пользователя штатно: браузер сам находит новый sw.js,
    // воркер при установке кладёт в свой кэш свежую страницу, а кнопка «Обновить» перезагружает приложение.
    const refresh = () => fetch(INDEX_URL, { cache: 'no-store' }).then((res) => {
      if (res && res.ok){
        const copy = res.clone();
        return caches.open(CACHE_NAME).then((cache) => cache.put(INDEX_URL, copy)).then(() => res, () => res);
      }
      return res;
    });
    const lookup = () => caches.open(CACHE_NAME).then((cache) => cache.match(INDEX_URL))
      .then((hit) => hit || caches.match(INDEX_URL));
    // перезагрузка после нажатия «Обновить» идёт с ?r=<время>: тут нужна именно свежая страница
    const forceFresh = /[?&]r=\d+/.test(req.url);
    respondTracked(event, lookup().then((cached) => {
      if (cached && !forceFresh){
        // фоновое обновление; не дольше 10 с, чтобы зависший запрос не откладывал активацию нового воркера
        event.waitUntil(Promise.race([refresh().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]));
        return cached;
      }
      return refresh().catch(() => cached || lookup());
    }));
    return;
  }

  if (isChangelog) {
    // changelog.json: сеть в приоритете, но не дольше NAV_TIMEOUT_MS, если в кэше есть копия
    const network = fetch(req, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok){
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    const fromCache = () => caches.match(req);
    event.waitUntil(Promise.race([network.catch(() => {}), new Promise((r) => setTimeout(r, 10000))]));
    respondTracked(event, fromCache().then((cached) => {
      if (!cached) return network.catch(() => fromCache());
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(cached), NAV_TIMEOUT_MS);
        network.then((res) => { clearTimeout(timer); resolve(res); },
                     () => { clearTimeout(timer); resolve(cached); });
      });
    }));
    return;
  }

  // шрифты Google — только кэш (постоянный FONT_CACHE), в сеть лишь если ещё нет.
  // В кэш кладём только успешные (res.ok) ответы. Файл стилей запрашивается без CORS и пришёл бы
  // «закрытым» (opaque): по нему нельзя отличить ошибку от успеха, и ошибка осталась бы в кэше
  // навсегда. Поэтому запрашиваем его сами с mode:'cors'; если Google не отдаёт CORS-заголовки,
  // идём обычным путём и в кэш ничего не кладём
  let host = '';
  try { host = new URL(req.url).hostname; } catch(e){}
  if (FONT_HOSTS.includes(host)){
    respondTracked(event,
      caches.open(FONT_CACHE).then((cache) => cache.match(req.url).then((cached) => {
        if (cached) return cached;
        return fetch(req.url, { mode: 'cors', credentials: 'omit' }).then((res) => {
          if (!res.ok) throw new Error('fonts ' + res.status);
          cache.put(req.url, res.clone());
          return res;
        }).catch(() => fetch(req));
      }))
    );
    return;
  }

  // картинки интерфейса — только кэш, в сеть идём лишь если файла в кэше ещё нет
  if (IMG_PATH_RE.test(new URL(req.url).pathname)){
    respondTracked(event,
      caches.open(IMG_CACHE).then((cache) => cache.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
      }))
    );
    return;
  }

  // статичные файлы — кэш в приоритете, фоновое обновление
  respondTracked(event,
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// клик по напоминанию о серии дней — фокусируем уже открытую вкладку приложения,
// если такая есть, иначе открываем новую
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList){
        if (client.url.includes(location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
