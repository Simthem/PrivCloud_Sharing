import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const origin = "https://preview.example";
const token = randomUUID();
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Port {
  sent = [];
  closed = false;
  onmessage = null;
  postMessage(data) {
    this.sent.push(data);
  }
  start() {}
  close() {
    this.closed = true;
  }
  emit(data, overrides = {}) {
    return this.onmessage?.({
      data,
      origin: "",
      isTrusted: true,
      currentTarget: this,
      source: null,
      ports: [],
      ...overrides,
    });
  }
}

function pageFixture({ manualVersion = false, source } = {}) {
  const listeners = new Map(),
    channels = [],
    reads = [],
    timers = new Set();
  class Channel {
    port1 = new Port();
    port2 = new Port();
    constructor() {
      channels.push(this);
    }
  }
  const worker = {
    postMessage() {
      if (!manualVersion)
        queueMicrotask(() => channels.at(-1).port1.emit({ previewVersion: 2 }));
    },
  };
  const serviceWorker = {
    controller: worker,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    ready: Promise.resolve(),
    register: async () => ({ update: async () => {} }),
  };
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(
        new URL("../src/utils/previewMedia.util.ts", import.meta.url),
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
      require: () => ({ PREVIEW_READ_BYTES: 1024 * 1024 }),
      navigator: { serviceWorker },
      window: { location: { origin } },
      MessageChannel: Channel,
      MessagePort: Port,
      AbortController,
      ArrayBuffer,
      Uint8Array,
      crypto: { randomUUID: () => token },
      setTimeout: (fn, delay) => {
        const timer = setTimeout(fn, delay);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timers.delete(timer);
        clearTimeout(timer);
      },
    },
  );
  const abort = new AbortController();
  const open = () =>
    module.exports.createProgressiveMediaUrl(
      source || {
        size: 2 * 1024 * 1024,
        read: async (start, end) => {
          reads.push([start, end]);
          return new Uint8Array(end - start).fill(7);
        },
      },
      "video/mp4",
      abort.signal,
    );
  return {
    open,
    reads,
    channels,
    abort,
    worker,
    serviceWorker,
    emit: (data, port, overrides = {}) =>
      listeners.get("message")({
        data,
        origin,
        isTrusted: true,
        currentTarget: serviceWorker,
        source: worker,
        ports: [port],
        ...overrides,
      }),
    cleanup() {
      abort.abort();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

test("preview page rejects forged origins, sources, synthetic events and malformed sessions", async () => {
  const f = pageFixture();
  try {
    await f.open();
    for (const overrides of [
      { origin: "https://attacker.example" },
      { origin: "" },
      { isTrusted: false },
      { source: {} },
      { currentTarget: {} },
      { ports: [] },
      { ports: [new Port(), new Port()] },
    ]) {
      const port = new Port();
      f.emit({ type: "privcloud-preview", token }, port, overrides);
      assert.equal(port.sent.length, 0);
      assert.equal(port.onmessage, null);
    }
    for (const data of [
      null,
      [],
      { type: "privcloud-preview" },
      { type: "privcloud-preview", token, extra: true },
      { type: "privcloud-preview", token: "../../api" },
    ]) {
      const port = new Port();
      f.emit(data, port);
      assert.equal(port.onmessage, null);
    }
    const unknown = new Port();
    f.emit(
      {
        type: "privcloud-preview",
        token: randomUUID(),
      },
      unknown,
    );
    assert.equal(unknown.sent[0].error, true);
    assert.equal(unknown.closed, true);
    assert.deepEqual(f.reads, []);
  } finally {
    f.cleanup();
  }
});

test("private preview ports reject forged events and unbounded or malformed read commands", async () => {
  const f = pageFixture();
  try {
    await f.open();
    const port = new Port();
    f.emit({ type: "privcloud-preview", token }, port);
    for (const overrides of [
      { origin },
      { isTrusted: false },
      { currentTarget: {} },
      { source: {} },
      { ports: [new Port()] },
    ]) {
      await port.emit({ start: 0, end: 10 }, overrides);
    }
    assert.deepEqual(f.reads, []);
    await port.emit({ start: 0, end: 10 });
    assert.deepEqual(f.reads, [[0, 10]]);
    assert.equal(port.sent.at(-1).bytes.byteLength, 10);
    for (const data of [
      null,
      [],
      { start: -1, end: 1 },
      { start: 0.5, end: 2 },
      { start: 0, end: Infinity },
      { start: 0, end: 0 },
      { start: 0, end: 1024 * 1024 + 1 },
      { start: 2 * 1024 * 1024, end: 2 * 1024 * 1024 + 1 },
      { start: "0", end: 1 },
      { start: 0, end: 1, extra: true },
      { close: false },
    ]) {
      const invalid = new Port();
      f.emit({ type: "privcloud-preview", token }, invalid);
      await invalid.emit(data);
      assert.equal(invalid.sent.at(-1).error, true);
      assert.equal(invalid.closed, true);
    }
    assert.equal(f.reads.length, 1);
    await port.emit({ close: true });
    assert.equal(port.closed, true);
  } finally {
    f.cleanup();
  }
});

test("worker readiness only accepts a trusted reply on the issued private channel", async () => {
  const f = pageFixture({ manualVersion: true });
  try {
    let ready = false;
    const opening = f.open().then(() => {
      ready = true;
    });
    await flush();
    const port = f.channels[0].port1;
    for (const overrides of [
      { origin },
      { isTrusted: false },
      { currentTarget: {} },
      { source: {} },
      { ports: [new Port()] },
    ]) {
      port.emit({ previewVersion: 2 }, overrides);
    }
    for (const data of [
      null,
      { previewVersion: 3 },
      { previewVersion: 2, extra: true },
    ])
      port.emit(data);
    await flush();
    assert.equal(ready, false);
    port.emit({ previewVersion: 2 });
    await opening;
    assert.equal(ready, true);
    assert.equal(port.closed, true);
  } finally {
    f.cleanup();
  }
});

test("an already controlling preview worker remains usable during a stalled update", async () => {
  const f = pageFixture();
  f.serviceWorker.register = () => new Promise(() => {});
  try {
    let opened = false;
    const opening = f.open().then(() => {
      opened = true;
    });
    await flush();
    assert.equal(
      opened,
      true,
      "a trusted protocol reply suffices without waiting on registration",
    );
    await opening;
  } finally {
    f.cleanup();
  }
});

test("release aborts active reads and prevents late byte replies", async () => {
  let complete, readSignal;
  const f = pageFixture({
    source: {
      size: 100,
      read: (a, b, signal) => {
        readSignal = signal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
  });
  try {
    const media = await f.open();
    const port = new Port();
    f.emit({ type: "privcloud-preview", token }, port);
    const pending = port.emit({ start: 0, end: 10 });
    media.release();
    assert.equal(readSignal.aborted, true);
    complete(new Uint8Array(10));
    await pending;
    assert.equal(port.sent.length, 1, "only metadata was sent before release");
    assert.equal(port.closed, true);
  } finally {
    f.cleanup();
  }
});

function workerFixture() {
  const listeners = new Map(),
    timers = new Set();
  const client = { id: "owner", type: "window", url: origin + "/share" };
  const self = {
    location: { origin },
    clients: { get: async (id) => (id === client.id ? client : undefined) },
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const context = vm.createContext({
    self,
    MessagePort: Port,
    URL,
    ArrayBuffer,
    setTimeout: (fn, delay) => {
      const timer = setTimeout(fn, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  });
  vm.runInContext(
    readFileSync(new URL("../public/preview-sw.js", import.meta.url), "utf8"),
    context,
  );
  return {
    client,
    self,
    context,
    emit(port, overrides = {}) {
      let lifetime;
      listeners.get("message")({
        origin,
        isTrusted: true,
        currentTarget: self,
        source: client,
        ports: [port],
        data: { type: "privcloud-preview-version" },
        waitUntil: (promise) => {
          lifetime = promise;
        },
        ...overrides,
      });
      return lifetime;
    },
    cleanup() {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

test("preview worker version replies require the same-origin live window client", async () => {
  const f = workerFixture();
  try {
    for (const overrides of [
      { origin: "https://attacker.example" },
      { isTrusted: false },
      { currentTarget: {} },
      { source: null },
      { source: { ...f.client, type: "worker" } },
      { source: { ...f.client, url: "https://attacker.example" } },
      { source: { ...f.client, id: "unknown" } },
      { ports: [] },
      { data: { type: "privcloud-preview-version", extra: true } },
    ]) {
      const port = new Port();
      await f.emit(port, overrides);
      assert.equal(port.sent.length, 0);
    }
    const port = new Port();
    await f.emit(port);
    assert.equal(port.sent[0].previewVersion, 2);
    assert.equal(port.closed, true);
  } finally {
    f.cleanup();
  }
});

test("preview worker rejects malformed metadata and unsolicited byte replies", async () => {
  const f = workerFixture();
  try {
    const port = new Port();
    const metadata = f.context.previewReply(port);
    for (const overrides of [
      { origin },
      { isTrusted: false },
      { currentTarget: {} },
      { source: {} },
      { ports: [new Port()] },
    ]) {
      port.emit(
        { size: 10, mimeType: "video/mp4", chunkBytes: 1024 * 1024 },
        overrides,
      );
    }
    assert.notEqual(port.onmessage, null);
    port.emit({ size: 10, mimeType: "video/mp4", chunkBytes: 1024 * 1024 });
    assert.equal((await metadata).size, 10);
    for (const data of [
      null,
      { size: -1, mimeType: "video/mp4", chunkBytes: 1024 * 1024 },
      { size: 10, mimeType: "text/html", chunkBytes: 1024 * 1024 },
      {
        size: 10,
        mimeType: "video/mp4\r\nX-Test: value",
        chunkBytes: 1024 * 1024,
      },
      { size: 10, mimeType: "video/mp4", chunkBytes: 1024 * 1024, extra: true },
    ]) {
      const channel = new Port();
      const rejected = assert.rejects(f.context.previewReply(channel));
      channel.emit(data);
      await rejected;
    }
    for (const data of [
      { bytes: new ArrayBuffer(9) },
      { bytes: "unsafe" },
      { bytes: new ArrayBuffer(10), extra: true },
      { error: true },
    ]) {
      const channel = new Port();
      const rejected = assert.rejects(
        f.context.previewReply(channel, { start: 0, end: 10 }),
      );
      channel.emit(data);
      await rejected;
    }
    const channel = new Port();
    const bytes = f.context.previewReply(channel, { start: 0, end: 10 });
    channel.emit({ bytes: new ArrayBuffer(10) });
    assert.equal((await bytes).bytes.byteLength, 10);
  } finally {
    f.cleanup();
  }
});
