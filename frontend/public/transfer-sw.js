// Registered with the upload worker URLs as scope. It has no fetch handler on
// purpose: the requests of those workers then go straight to the network.
self.addEventListener("install", function () {
  self.skipWaiting();
});
