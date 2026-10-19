// PrivCloud_Sharing Service Worker
// Handles push notifications, notification clicks, and PWA installability.
//
// Preview-only fetch interception; all API and upload requests bypass it.
importScripts("/preview-sw.js");

var CACHE_NAME = "privcloud-v14";
var DEFAULT_NOTIFICATION_ICON = "/img/icons/icon-512x512.png";
var DEFAULT_NOTIFICATION_BADGE = "/img/icons/icon-96x96.png";

function sameOriginAsset(value, fallback) {
  try {
    if (!value) return fallback;
    var url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return fallback;
    return url.pathname + url.search;
  } catch (e) {
    return fallback;
  }
}

function sameOriginPath(value) {
  try {
    var url = new URL(value || "/", self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    return url.pathname + url.search + url.hash;
  } catch (e) {
    return "/";
  }
}

function sameOriginUrl(value) {
  try {
    var url = new URL(value || "/", self.location.origin);
    if (url.origin !== self.location.origin) return self.location.origin + "/";
    return url.href;
  } catch (e) {
    return self.location.origin + "/";
  }
}

function clientUrlMatches(clientUrl, targetUrl) {
  try {
    return new URL(clientUrl).href === targetUrl;
  } catch (e) {
    return false;
  }
}

// -- Install: activate immediately --
self.addEventListener("install", function (event) {
  self.skipWaiting();
});

// -- Activate: delete old caches and claim clients --
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.map(function (name) {
          return caches.delete(name);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
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
  var url = sameOriginUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientUrlMatches(clientList[i].url, url) && "focus" in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url).then(function (client) {
          return client && "focus" in client ? client.focus() : client;
        });
      }
    })
  );
});
