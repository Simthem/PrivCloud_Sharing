// Imported by sw.js. Serves a file decrypted in the page as a real download,
// so the browser shows it with its progress. Bytes are pulled from the page
// one piece at a time and never stored.
var downloadOffers = new Map();
var DOWNLOAD_OFFER_TTL_MS = 60000;
var DOWNLOAD_PIECE_MAX_BYTES = 4 * 1024 * 1024;

function downloadFields(value, fields) {
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

self.addEventListener("message", function (event) {
  if (event.origin !== String(self.location.origin)) return;
  if (
    event.isTrusted !== true ||
    event.currentTarget !== self ||
    !event.source ||
    event.source.type !== "window" ||
    new URL(event.source.url).origin !== self.location.origin ||
    event.ports.length !== 1 ||
    !(event.ports[0] instanceof MessagePort) ||
    !downloadFields(event.data, ["type", "token"]) ||
    event.data.type !== "privcloud-download-offer" ||
    typeof event.data.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(event.data.token)
  )
    return;
  var now = Date.now();
  downloadOffers.forEach(function (offer, token) {
    if (now - offer.at > DOWNLOAD_OFFER_TTL_MS) {
      offer.port.close();
      downloadOffers.delete(token);
    }
  });
  downloadOffers.set(event.data.token, { port: event.ports[0], at: now });
  event.ports[0].postMessage({ ready: true });
});

function downloadReply(port, command) {
  return new Promise(function (resolve, reject) {
    var timeout = setTimeout(function () {
      port.onmessage = null;
      reject(new Error("Download page unavailable"));
    }, DOWNLOAD_OFFER_TTL_MS);
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
      var valid = command.metadata
        ? downloadFields(data, ["name", "size"]) &&
          typeof data.name === "string" &&
          data.name.length > 0 &&
          data.name.length <= 255 &&
          (data.size === null ||
            (Number.isSafeInteger(data.size) && data.size >= 0))
        : (downloadFields(data, ["bytes"]) &&
            data.bytes instanceof ArrayBuffer &&
            data.bytes.byteLength > 0 &&
            data.bytes.byteLength <= DOWNLOAD_PIECE_MAX_BYTES) ||
          (downloadFields(data, ["done"]) && data.done === true);
      port.onmessage = null;
      clearTimeout(timeout);
      valid ? resolve(data) : reject(new Error("Download read failed"));
    };
    port.postMessage(command);
    port.start();
  });
}

function downloadDisposition(name) {
  var clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_");
  var fallback = clean.replace(/[^ -~]|["%;]/g, "_");
  return (
    'attachment; filename="' +
    fallback +
    "\"; filename*=UTF-8''" +
    encodeURIComponent(clean).replace(/['()*]/g, function (char) {
      return "%" + char.charCodeAt(0).toString(16).toUpperCase();
    })
  );
}

async function serveDownload(port) {
  function close() {
    port.postMessage({ close: true });
    port.close();
  }
  try {
    var metadata = await downloadReply(port, { metadata: true });
    var headers = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": downloadDisposition(metadata.name),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (metadata.size !== null)
      headers["Content-Length"] = String(metadata.size);
    var stream = new ReadableStream({
      async pull(controller) {
        try {
          var reply = await downloadReply(port, { next: true });
          if (reply.done === true) {
            close();
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(reply.bytes));
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    });
    return new Response(stream, { status: 200, headers: headers });
  } catch {
    close();
    return new Response(null, { status: 410 });
  }
}

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  var match = /^\/__privcloud_download__\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (!match || event.request.method !== "GET") return;
  var offer = downloadOffers.get(match[1]);
  downloadOffers.delete(match[1]);
  event.respondWith(
    offer ? serveDownload(offer.port) : new Response(null, { status: 410 }),
  );
});
