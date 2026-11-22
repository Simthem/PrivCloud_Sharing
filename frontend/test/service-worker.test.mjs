import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadWorker() {
  const listeners = [];
  const self = {
    location: { origin: "https://app.example" },
    addEventListener(type, listener) {
      if (type === "fetch") listeners.push(listener);
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    { self, importScripts() {}, URL },
  );
  return (request) => {
    for (const listener of listeners) listener({ request });
  };
}

const body = (cancel) => ({ cancel });

test("service worker releases the body of every request", async () => {
  const dispatch = loadWorker();
  let cancelled = 0;
  dispatch({
    url: "https://storage.example/bucket/object?partNumber=1",
    method: "PUT",
    body: body(() => {
      cancelled++;
      return Promise.resolve();
    }),
  });
  dispatch({
    url: "https://app.example/api/shares/a/files/multipart/part-urls",
    method: "POST",
    body: body(() => {
      cancelled++;
      return Promise.reject(new TypeError("locked"));
    }),
  });
  dispatch({
    url: "https://app.example/api/configs",
    method: "GET",
    body: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 2);
});
