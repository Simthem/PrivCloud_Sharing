/**
 * Persistent worker used by E2E key rotation chunk uploads.
 *
 * The encrypted ArrayBuffer is transferred out of the React renderer before
 * fetch() sees it. This keeps long rotations from retaining hundreds of large
 * request bodies in Chromium's main isolate. Failed payloads are transferred
 * back to the caller so the same chunk can be retried without re-encryption.
 */

var activeRequests = new Map();

self.onmessage = function (event) {
  var message = event.data;
  if (message.type === "abort") {
    var active = activeRequests.get(message.requestId);
    if (active) active.abort();
    return;
  }
  if (message.type === "upload") {
    uploadChunk(message);
  }
};

async function uploadChunk(message) {
  var requestId = message.requestId;
  var chunk = message.chunk;
  var controller = new AbortController();
  var timedOut = false;
  var timer = setTimeout(function () {
    timedOut = true;
    controller.abort();
  }, 900000);
  activeRequests.set(requestId, controller);

  var url =
    "/api/shares/" +
    encodeURIComponent(message.shareId) +
    "/files/" +
    encodeURIComponent(message.fileId) +
    "/reencrypt?chunkIndex=" +
    message.chunkIndex +
    "&totalChunks=" +
    message.totalChunks;
  if (message.rotationId) {
    url += "&rotationId=" + encodeURIComponent(message.rotationId);
  }
  if (message.encryptionChunkSize) {
    url += "&encryptionChunkSize=" + message.encryptionChunkSize;
  }
  if (message.sessionId) {
    url += "&sessionId=" + encodeURIComponent(message.sessionId);
  }

  try {
    var response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
      credentials: "include",
      signal: controller.signal,
    });

    if (!response.ok) {
      var responseText = "";
      try {
        responseText = await response.text();
      // eslint-disable-next-line no-unused-vars
      } catch (_error) {}
      var responseData = null;
      if (responseText) {
        try {
          responseData = JSON.parse(responseText);
        // eslint-disable-next-line no-unused-vars
        } catch (_error) {
          responseData = { message: responseText.slice(0, 2000) };
        }
      }
      returnFailure(
        requestId,
        response.status,
        "Reencrypt chunk " + message.chunkIndex + " failed",
        responseData,
        chunk,
      );
      return;
    }

    await response.arrayBuffer();
    chunk = null;
    self.postMessage({ type: "result", requestId: requestId, ok: true });
  } catch (error) {
    var messageText = timedOut
      ? "Reencrypt chunk " + message.chunkIndex + " timed out"
      : error && error.message
        ? error.message
        : "Reencrypt chunk upload failed";
    returnFailure(requestId, 0, messageText, null, chunk);
  } finally {
    clearTimeout(timer);
    activeRequests.delete(requestId);
  }
}

function returnFailure(requestId, status, message, data, chunk) {
  var result = {
    type: "result",
    requestId: requestId,
    ok: false,
    status: status,
    message: message,
    data: data,
    chunk: chunk,
  };
  if (chunk instanceof ArrayBuffer) {
    self.postMessage(result, [chunk]);
  } else {
    self.postMessage(result);
  }
}
