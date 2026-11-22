import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function loadUtil(serviceWorker) {
  const timers = [];
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(
        new URL("../src/utils/transferWorker.util.ts", import.meta.url),
        "utf8",
      ),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText,
    {
      module,
      exports: module.exports,
      navigator: serviceWorker ? { serviceWorker } : {},
      require: (name) => {
        assert.equal(name, "./uploadClock.util");
        return {
          scheduleUploadTimeout(callback) {
            const timer = { callback, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
        };
      },
    },
  );
  return { claim: module.exports.claimTransferWorkerScope, timers };
}

const settled = async (promise) => {
  let done = false;
  promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test("transfer worker scope waits for the worker without fetch handler", async () => {
  const calls = [];
  let changed;
  const installing = {
    state: "installing",
    addEventListener: (type, listener) => (changed = listener),
  };
  const { claim, timers } = loadUtil({
    register: async (script, options) => {
      calls.push({ script, ...options });
      return { installing, waiting: null, active: null };
    },
  });
  const first = claim("/upload-worker.js");
  assert.equal(claim("/upload-worker.js"), first);
  assert.equal(await settled(first), false);
  installing.state = "activated";
  changed();
  assert.equal(await settled(first), true);
  assert.deepEqual(calls, [
    {
      script: "/transfer-sw.js",
      scope: "/upload-worker.js",
      updateViaCache: "none",
    },
  ]);
  assert.equal(timers[0].cancelled, true);
});

test("transfer worker scope never blocks an upload", async () => {
  assert.equal(await settled(loadUtil(null).claim("/upload-worker.js")), true);

  const refused = loadUtil({
    register: () => Promise.reject(new Error("SecurityError")),
  });
  assert.equal(await settled(refused.claim("/reencrypt-worker.js")), true);

  const stalled = loadUtil({ register: () => new Promise(() => {}) });
  const pending = stalled.claim("/upload-worker.js");
  assert.equal(await settled(pending), false);
  stalled.timers[0].callback();
  assert.equal(await settled(pending), true);
});

test("transfer service worker has no fetch handler", () => {
  const events = [];
  let skipped = false;
  vm.runInNewContext(
    readFileSync(new URL("../public/transfer-sw.js", import.meta.url), "utf8"),
    {
      self: {
        addEventListener: (type, listener) => events.push([type, listener]),
        skipWaiting: () => (skipped = true),
      },
    },
  );
  assert.deepEqual(
    events.map(([type]) => type),
    ["install"],
  );
  events[0][1]();
  assert.equal(skipped, true);
});
