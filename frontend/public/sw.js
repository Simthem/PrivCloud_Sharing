// PrivCloud_Sharing Service Worker
// Handles push notifications, notification clicks, and PWA installability.
//
// Only preview and download requests are answered here. Every other request,
// uploads included, still passes through this worker on its way out.
self.addEventListener("fetch", function (event) {
  // Chrome never frees the body copy it hands to this worker.
  var body = event.request.body;
  if (body) body.cancel().catch(function () {});
});

importScripts("/preview-sw.js");
importScripts("/download-sw.js");

var DEFAULT_NOTIFICATION_ICON = "/img/icons/icon-512x512.png";
var DEFAULT_NOTIFICATION_BADGE = "/img/icons/icon-96x96.png";

function sameOriginAsset(value, fallback) {
  try {
    if (!value) return fallback;
    var url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}

function sameOriginPath(value) {
  try {
    var url = new URL(value || "/", self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

function sameOriginUrl(value) {
  try {
    var url = new URL(value || "/", self.location.origin);
    if (url.origin !== self.location.origin) return self.location.origin + "/";
    return url.href;
  } catch {
    return self.location.origin + "/";
  }
}

function clientUrlMatches(clientUrl, targetUrl) {
  try {
    return new URL(clientUrl).href === targetUrl;
  } catch {
    return false;
  }
}

// -- Install: activate immediately --
self.addEventListener("install", function () {
  self.skipWaiting();
});

// -- Activate: delete old caches and claim clients --
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (name) {
            return caches.delete(name);
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

// -- Push notification handler --
self.addEventListener("push", function (event) {
  if (!event.data) return;
  var payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "PrivCloud", body: event.data.text() };
  }
  var title = payload.title || "PrivCloud";
  var options = {
    body: payload.body || "",
    icon: sameOriginAsset(payload.icon, DEFAULT_NOTIFICATION_ICON),
    badge: sameOriginAsset(payload.badge, DEFAULT_NOTIFICATION_BADGE),
    data: { url: sameOriginPath(payload.url) },
    tag: payload.tag || "privcloud-push",
    renotify: true,
    requireInteraction: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// -- Notification click: open the app at the relevant page --
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = sameOriginUrl(
    event.notification.data && event.notification.data.url,
  );
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          if (
            clientUrlMatches(clientList[i].url, url) &&
            "focus" in clientList[i]
          ) {
            return clientList[i].focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(url).then(function (client) {
            return client && "focus" in client ? client.focus() : client;
          });
        }
      }),
  );
});
