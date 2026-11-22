import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const origin = "https://download.example";
const token = randomUUID();

class Port {
  peer = null;
  sent = [];
  closed = false;
  onmessage = null;
  postMessage(data) {
    this.sent.push(data);
    const peer = this.peer;
    if (!peer) return;
    // Like a MessagePort, a message posted before close() is delivered.
    if (this.closed) return;
    queueMicrotask(() => {
      if (peer.closed) return;
      peer.onmessage?.({
        data,
        origin: "",
        isTrusted: true,
        currentTarget: peer,
        source: null,
        ports: [],
      });
    });
  }
  start() {}
  close() {
    this.closed = true;
  }
}

class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

function timerSet() {
  const timers = new Set();
  return {
    setTimeout: (fn, delay) => {
      const timer = setTimeout(fn, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
    setInterval: (fn, delay) => {
      const timer = setInterval(fn, delay);
      timers.add(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timers.delete(timer);
      clearInterval(timer);
    },
    clear: () => timers.forEach((timer) => clearTimeout(timer)),
  };
}

function workerFixture() {
  const listeners = new Map();
  const timers = timerSet();
  const client = { type: "window", url: origin + "/team/1/folder/2" };
  const self = {
    location: { origin },
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  vm.runInContext(
    readFileSync(new URL("../public/download-sw.js", import.meta.url), "utf8"),
    vm.createContext({
      self,
      MessagePort: Port,
      URL,
      ArrayBuffer,
      Uint8Array,
      Map,
      ReadableStream,
      Response,
      encodeURIComponent,
      ...timers,
    }),
  );
  return {
    client,
    offer(port, overrides = {}) {
      listeners.get("message")({
        origin,
        isTrusted: true,
        currentTarget: self,
        source: client,
        ports: [port],
        data: { type: "privcloud-download-offer", token },
        ...overrides,
      });
    },
    fetch(path, method = "GET") {
      let response = null;
      listeners.get("fetch")({
        request: { url: origin + path, method },
        respondWith: (value) => {
          response = Promise.resolve(value);
        },
      });
      return response;
    },
    cleanup: timers.clear,
  };
}

const chrome = "Mozilla/5.0 Chrome/140.0 Safari/537.36";

function pageFixture(
  worker,
  { answers = true, controlled = true, userAgent = chrome } = {},
) {
  const timers = timerSet();
  let response = null;
  const document = {
    body: {
      appendChild(frame) {
        response = worker.fetch(frame.src);
      },
    },
    createElement: () => ({ setAttribute() {}, remove() {} }),
  };
  const controller = {
    postMessage(data, ports = []) {
      if (!answers || data.type !== "privcloud-download-offer") return;
      worker.offer(ports[0], { data });
    },
  };
  const changes = new Set();
  const claims = [];
  const serviceWorker = {
    controller: controlled ? controller : null,
    addEventListener: (type, fn) => changes.add(fn),
    removeEventListener: (type, fn) => changes.delete(fn),
    register: async () => ({}),
    ready: Promise.resolve({
      active: {
        postMessage(data) {
          claims.push(data);
          serviceWorker.controller = controller;
          changes.forEach((fn) => fn());
        },
      },
    }),
  };
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(
        new URL("../src/utils/serviceWorkerDownload.util.ts", import.meta.url),
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
      window: {},
      navigator: {
        userAgent,
        serviceWorker,
      },
      document,
      MessageChannel: Channel,
      ReadableStream,
      DOMException,
      crypto: { randomUUID: () => token },
      ...timers,
    },
  );
  return {
    open: (name) => module.exports.openServiceWorkerDownload(name),
    response: () => response,
    claims,
    cleanup: timers.clear,
  };
}

// Values built in the worker realm.
const plain = (value) => JSON.parse(JSON.stringify(value));

const bytes = (length, seed) =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 251);

test("download worker accepts offers from same-origin windows only", () => {
  const f = workerFixture();
  try {
    for (const overrides of [
      { origin: "https://attacker.example" },
      { isTrusted: false },
      { currentTarget: {} },
      { source: null },
      { source: { ...f.client, type: "worker" } },
      { source: { ...f.client, url: "https://attacker.example/" } },
      { ports: [] },
      { ports: [{}] },
      { data: { type: "privcloud-download-offer", token, extra: true } },
      { data: { type: "privcloud-download-offer", token: "../../etc" } },
      { data: { type: "privcloud-preview-claim", token } },
    ]) {
      const port = new Port();
      f.offer(port, overrides);
      assert.deepEqual(plain(port.sent), []);
    }
    const port = new Port();
    f.offer(port);
    assert.deepEqual(plain(port.sent), [{ ready: true }]);
  } finally {
    f.cleanup();
  }
});

test("download worker ignores other paths and serves a token once", async () => {
  const f = workerFixture();
  try {
    assert.equal(f.fetch("/api/shares/a/files/b"), null);
    assert.equal(f.fetch(`/__privcloud_download__/${token}/x`), null);
    assert.equal(
      (await f.fetch(`/__privcloud_download__/${token}`)).status,
      410,
    );
    const port = new Port();
    f.offer(port);
    assert.equal(f.fetch(`/__privcloud_download__/${token}`, "POST"), null);
    const first = f.fetch(`/__privcloud_download__/${token}`);
    assert.equal(
      (await f.fetch(`/__privcloud_download__/${token}`)).status,
      410,
    );
    assert.deepEqual(plain(port.sent.at(-1)), { metadata: true });
    port.onmessage({
      data: { name: "a.bin", size: 0 },
      origin: "",
      isTrusted: true,
      currentTarget: port,
      source: null,
      ports: [],
    });
    assert.equal((await first).status, 200);
  } finally {
    f.cleanup();
  }
});

test("download worker refuses malformed replies from the page", async () => {
  for (const reply of [
    { name: "", size: 1 },
    { name: "a.bin", size: -1 },
    { name: "a.bin", size: 1.5 },
    { name: "a".repeat(256), size: 1 },
    { name: "a.bin", size: 1, extra: true },
    { bytes: new ArrayBuffer(1) },
  ]) {
    const f = workerFixture();
    try {
      const port = new Port();
      f.offer(port);
      const response = f.fetch(`/__privcloud_download__/${token}`);
      port.onmessage({
        data: reply,
        origin: "",
        isTrusted: true,
        currentTarget: port,
        source: null,
        ports: [],
      });
      assert.equal((await response).status, 410);
      assert.deepEqual(plain(port.sent.at(-1)), { close: true });
    } finally {
      f.cleanup();
    }
  }
  for (const reply of [
    { bytes: new ArrayBuffer(0) },
    { bytes: new ArrayBuffer(4 * 1024 * 1024 + 1) },
    { bytes: new Uint8Array(4) },
    { done: false },
    { error: true },
  ]) {
    const f = workerFixture();
    try {
      const port = new Port();
      f.offer(port);
      const pending = f.fetch(`/__privcloud_download__/${token}`);
      const event = (data) => ({
        data,
        origin: "",
        isTrusted: true,
        currentTarget: port,
        source: null,
        ports: [],
      });
      port.onmessage(event({ name: "a.bin", size: null }));
      const reader = (await pending).body.getReader();
      const read = reader.read();
      await new Promise((resolve) => setImmediate(resolve));
      port.onmessage({ ...event(reply), origin: origin });
      assert.notEqual(port.onmessage, null, "a window message is ignored");
      port.onmessage(event(reply));
      await assert.rejects(read);
      assert.deepEqual(plain(port.sent.at(-1)), { close: true });
    } finally {
      f.cleanup();
    }
  }
});

test("a decrypted file reaches the browser download intact", async () => {
  const worker = workerFixture();
  const page = pageFixture(worker);
  try {
    const sink = await page.open('rapport "été" 2026.bin');
    assert.ok(sink);
    const first = bytes(1536 * 1024, 3);
    const second = bytes(700 * 1024, 9);
    sink.setSize(first.length + second.length);
    const writing = (async () => {
      await sink.write(first);
      await sink.write(second);
      await sink.close();
    })();
    const response = await page.response();
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Length"),
      String(first.length + second.length),
    );
    assert.equal(
      response.headers.get("Content-Disposition"),
      "attachment; filename=\"rapport __t__ 2026.bin\"; filename*=UTF-8''rapport%20%22%C3%A9t%C3%A9%22%202026.bin",
    );
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const received = new Uint8Array(await response.arrayBuffer());
    await writing;
    assert.deepEqual(received, Uint8Array.from([...first, ...second]));
  } finally {
    page.cleanup();
    worker.cleanup();
  }
});

test("cancelling in the browser stops the page and a page error fails the download", async () => {
  const worker = workerFixture();
  const page = pageFixture(worker);
  try {
    const sink = await page.open("a.bin");
    sink.setSize(null);
    const response = await page.response();
    assert.equal(response.headers.get("Content-Length"), null);
    const reader = response.body.getReader();
    const writing = sink.write(bytes(3 * 1024 * 1024, 1));
    assert.equal((await reader.read()).value.length, 1024 * 1024);
    await reader.cancel();
    await assert.rejects(writing, { name: "AbortError" });
    await assert.rejects(sink.write(bytes(10, 1)), { name: "AbortError" });
  } finally {
    page.cleanup();
    worker.cleanup();
  }

  const otherWorker = workerFixture();
  const otherPage = pageFixture(otherWorker);
  try {
    const sink = await otherPage.open("b.bin");
    // The size is unknown until the first write.
    const writing = sink.write(bytes(10, 2));
    const response = await otherPage.response();
    const reader = response.body.getReader();
    await writing;
    assert.equal((await reader.read()).value.length, 10);
    await sink.abort();
    await assert.rejects(reader.read());
  } finally {
    otherPage.cleanup();
    otherWorker.cleanup();
  }
});

test("a worker without the download handler leaves the previous path", async () => {
  const worker = workerFixture();
  const page = pageFixture(worker, { answers: false });
  try {
    assert.equal(await page.open("a.bin"), null);
    assert.equal(page.response(), null);
  } finally {
    page.cleanup();
    worker.cleanup();
  }
});

test("Safari streams through the worker as there is no save picker", async () => {
  const worker = workerFixture();
  const page = pageFixture(worker, {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  });
  try {
    const sink = await page.open("archive.bin");
    assert.ok(sink);
    const writing = sink.write(bytes(4096, 9)).then(() => sink.close());
    const received = new Uint8Array(
      await (await page.response()).arrayBuffer(),
    );
    await writing;
    assert.deepEqual(received, bytes(4096, 9));
  } finally {
    page.cleanup();
    worker.cleanup();
  }
});

test("a page not controlled yet waits for the worker when no save picker exists", async () => {
  const worker = workerFixture();
  const page = pageFixture(worker, { controlled: false });
  try {
    const sink = await page.open("premier.bin");
    assert.ok(sink);
    assert.deepEqual(plain(page.claims), [{ type: "privcloud-preview-claim" }]);
    const writing = sink.write(bytes(10, 4)).then(() => sink.close());
    const received = new Uint8Array(
      await (await page.response()).arrayBuffer(),
    );
    await writing;
    assert.deepEqual(received, bytes(10, 4));
  } finally {
    page.cleanup();
    worker.cleanup();
  }
});
