// PrivCloud_Sharing Service Worker
// Provides offline shell caching, network-first API strategy,
// and background upload continuation.

var CACHE_NAME = "privcloud-v5";

// App shell resources cached on install for offline access.
var APP_SHELL = [
  "/",
  "/account",
  "/upload",
  "/auth/signIn",
  "/offline",
  "/manifest.json",
  "/img/favicon.ico",
];

// -- Install: cache app shell --
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Cache each resource individually so one failure does not prevent others
      return Promise.all(
        APP_SHELL.map(function (url) {
          return cache.add(url).catch(function () {
            // Non-critical: resource may not exist yet
          });
        })
      );
    })
  );
  self.skipWaiting();
});

// -- Activate: clean old caches --
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) {
            return name !== CACHE_NAME;
          })
          .map(function (name) {
            return caches.delete(name);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// -- Fetch: network-first for API, cache-first for app shell --
self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // Only handle same-origin requests -- never intercept cross-origin
  // scripts (e.g. Safeline WAF challenge.js, analytics, OAuth).
  if (url.origin !== self.location.origin) {
    return;
  }

  // Only handle http(s) requests - ignore chrome-extension://, etc.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return;
  }

  // Never cache API calls or file uploads
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // For navigation requests and app shell: network-first with cache fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(function () {
          return caches.match(event.request).then(function (cached) {
            return cached || caches.match("/offline");
          });
        })
    );
    return;
  }

  // For static assets: cache-first
  if (
    url.pathname.startsWith("/img/") ||
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js")
  ) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        if (cached) return cached;
        return fetch(event.request).then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
    return;
  }
});

// -- Message handler for background upload continuation --
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "UPLOAD_KEEPALIVE") {
    // Acknowledge the keepalive -- the SW staying active keeps
    // the browser from killing the upload tab/process.
    event.source.postMessage({ type: "UPLOAD_KEEPALIVE_ACK" });
  }
});

// -- Push notification handler --
self.addEventListener("push", function (event) {
  if (!event.data) return;
  var payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: "PrivCloud", body: event.data.text() };
  }
  var title = payload.title || "PrivCloud";
  var options = {
    body: payload.body || "",
    icon: "/img/logo.png",
    badge: "/img/logo.png",
    data: { url: payload.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// -- Notification click: open the app at the relevant page --
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf(url) !== -1 && "focus" in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
