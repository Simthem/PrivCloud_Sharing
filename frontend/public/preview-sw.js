// Imported by sw.js. Only ephemeral preview URLs are intercepted; API/upload
// requests never call respondWith. No plaintext is persisted in Cache Storage.
self.addEventListener("message", function (event) {
  if (event.origin !== String(self.location.origin)) return;
  if (
    event.isTrusted !== true ||
    event.currentTarget !== self ||
    !event.source ||
    event.source.type !== "window" ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  // A forced reload leaves the page uncontrolled, and the claim made on
  // activation is long past: the page asks for one before a preview.
  if (
    event.ports.length === 0 &&
    previewFields(event.data, ["type"]) &&
    event.data.type === "privcloud-preview-claim"
  ) {
    event.waitUntil(self.clients.claim());
    return;
  }
  if (
    event.ports.length !== 1 ||
    !(event.ports[0] instanceof MessagePort) ||
    !previewFields(event.data, ["type"]) ||
    event.data.type !== "privcloud-preview-version"
  )
    return;
  var source = event.source;
  var port = event.ports[0];
  event.waitUntil(
    self.clients
      .get(source.id)
      .then(function (client) {
        if (
          client &&
          client.type === "window" &&
          client.url === source.url &&
          new URL(client.url).origin === self.location.origin
        ) {
          port.postMessage({ previewVersion: 2 });
        }
        port.close();
      })
      .catch(function () {
        port.close();
      }),
  );
});

function previewFields(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every(function (field) {
      return Object.prototype.hasOwnProperty.call(value, field);
    })
  );
}

function previewReply(port, command) {
  return new Promise(function (resolve, reject) {
    var timeout = setTimeout(function () {
      port.postMessage({ close: true });
      port.onmessage = null;
      port.close();
      reject(new Error("Preview page unavailable"));
    }, 60000);
    port.onmessage = function (event) {
      // Private MessagePorts have an empty origin and no Window source.
      if (event.origin !== "") return;
      if (
        event.isTrusted !== true ||
        event.currentTarget !== port ||
        event.source !== null ||
        event.ports.length !== 0
      )
        return;
      var data = event.data;
      var failed = previewFields(data, ["error"]) && data.error === true;
      var valid = command
        ? previewFields(data, ["bytes"]) &&
          data.bytes instanceof ArrayBuffer &&
          data.bytes.byteLength === command.end - command.start
        : previewFields(data, ["size", "mimeType", "chunkBytes"]) &&
          Number.isSafeInteger(data.size) &&
          data.size > 0 &&
          typeof data.mimeType === "string" &&
          /^(?:audio|video)\/[a-z0-9.+-]+$/i.test(data.mimeType) &&
          data.chunkBytes === 1024 * 1024;
      port.onmessage = null;
      clearTimeout(timeout);
      failed || !valid
        ? reject(new Error("Preview read failed"))
        : resolve(data);
    };
    if (command) port.postMessage(command);
    port.start();
  });
}

async function servePreview(event, token) {
  var client = await self.clients.get(event.clientId);
  if (
    !client ||
    client.type !== "window" ||
    new URL(client.url).origin !== self.location.origin
  )
    return new Response(null, { status: 410 });
  var channel = new MessageChannel();
  var port = channel.port1;
  var metadataPromise = previewReply(port);
  client.postMessage({ type: "privcloud-preview", token: token }, [
    channel.port2,
  ]);
  try {
    var metadata = await metadataPromise;
    var size = metadata.size;
    var start = 0;
    var end = size - 1;
    var range = event.request.headers.get("Range");
    if (range) {
      var match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) throw new Error("Invalid range");
      if (!match[1]) {
        var suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
          throw new Error("Invalid range");
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        port.postMessage({ close: true });
        port.close();
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": "bytes */" + size },
        });
      }
    }
    var headers = {
      "Content-Type": metadata.mimeType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (range)
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
    function close() {
      port.postMessage({ close: true });
      port.close();
    }
    if (event.request.method === "HEAD") {
      close();
      return new Response(null, {
        status: range ? 206 : 200,
        headers: headers,
      });
    }
    var delivered = 0;
    var stream = new ReadableStream(
      {
        async pull(controller) {
          try {
            if (start > end) {
              close();
              controller.close();
              return;
            }
            // Browsers often need only a short prefix for their first frame.
            // Grow to MiB reads once they continue consuming the response.
            var chunk = delivered < 256 * 1024 ? 64 * 1024 : 1024 * 1024;
            var next = Math.min(end + 1, start + chunk);
            var reply = await previewReply(port, { start: start, end: next });
            if (
              !(reply.bytes instanceof ArrayBuffer) ||
              reply.bytes.byteLength !== next - start
            )
              throw new Error("Invalid preview bytes");
            controller.enqueue(new Uint8Array(reply.bytes));
            delivered += next - start;
            start = next;
          } catch (error) {
            close();
            controller.error(error);
          }
        },
        cancel() {
          close();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, {
      status: range ? 206 : 200,
      headers: headers,
    });
  } catch {
    port.postMessage({ close: true });
    port.close();
    return new Response(null, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  var match = /^\/__privcloud_preview__\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (
    url.origin === self.location.origin &&
    match &&
    (event.request.method === "GET" || event.request.method === "HEAD")
  ) {
    event.respondWith(servePreview(event, match[1]));
  }
});
