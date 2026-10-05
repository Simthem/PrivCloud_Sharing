import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

function fixture({ unavailable = false, clampDocument = true } = {}) {
  let now = 0,
    sequence = 0;
  const timers = new Map(),
    workers = new Set();
  const setTimer = (fn, delay, document = false) => {
    const id = ++sequence;
    timers.set(id, {
      fn,
      at: now + (document && clampDocument ? Math.max(delay, 60_000) : delay),
    });
    return id;
  };
  const clockDate = class extends Date {
    static now() {
      return now;
    }
  };
  class Worker {
    constructor(url) {
      if (unavailable) throw new Error("Worker unavailable");
      assert.equal(url, "/upload-clock-worker.js");
      this.listeners = {};
      this.timerIds = new Set();
      workers.add(this);
      this.self = { postMessage: (data) => this.emit(data) };
      vm.runInNewContext(
        readFileSync(
          new URL("../public/upload-clock-worker.js", import.meta.url),
          "utf8",
        ),
        {
          self: this.self,
          Date: clockDate,
          setTimeout: (fn, delay) => {
            const id = setTimer(fn, delay);
            this.timerIds.add(id);
            return id;
          },
          clearTimeout: (id) => {
            timers.delete(id);
            this.timerIds.delete(id);
          },
        },
      );
    }
    addEventListener(type, callback) {
      this.listeners[type] = callback;
    }
    emit(data, overrides = {}) {
      this.listeners.message?.({
        data,
        origin: "",
        isTrusted: true,
        currentTarget: this,
        source: null,
        ports: [],
        ...overrides,
      });
    }
    postMessage(data) {
      this.send(data);
    }
    send(data, overrides = {}) {
      this.self.onmessage({
        data,
        origin: "",
        isTrusted: true,
        currentTarget: this.self,
        source: null,
        ports: [],
        ...overrides,
      });
    }
    terminate() {
      workers.delete(this);
      for (const id of this.timerIds) timers.delete(id);
    }
  }
  const load = (name, dependencies = {}) => {
    const module = { exports: {} };
    const source = ts.transpileModule(
      readFileSync(new URL(`../src/utils/${name}.ts`, import.meta.url), "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText;
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      require: (name) => dependencies[name],
      Worker,
      Date: clockDate,
      Math: Object.assign(Object.create(Math), { random: () => 0 }),
      setTimeout: (fn, delay) => setTimer(fn, delay, true),
      clearTimeout: (id) => timers.delete(id),
    });
    return module.exports;
  };
  const clock = load("uploadClock.util");
  const advance = (until) => {
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = until;
  };
  return {
    clock,
    load,
    advance,
    workers,
    timers,
    jump: (time) => {
      now = time;
    },
  };
}

test("clock replies reject foreign origins, synthetic events, other targets and malformed payloads", () => {
  const f = fixture();
  let calls = 0;
  f.clock.scheduleUploadTimeout(() => calls++, 250);
  const [worker] = f.workers;
  f.jump(250);
  const valid = { type: "elapsed", id: 1 };
  for (const overrides of [
    { origin: "https://attacker.example" },
    { origin: "null" },
    { origin: "https://app.example" },
    { isTrusted: false },
    { currentTarget: {} },
    { source: {} },
    { ports: [{}] },
  ]) {
    worker.emit(valid, overrides);
    assert.equal(calls, 0, "untrusted reply fired an overdue callback");
  }
  for (const data of [
    null,
    "elapsed",
    [],
    { ...valid, extra: true },
    { type: "cancel", id: 1 },
    { type: "elapsed", id: "1" },
    { type: "elapsed", id: 0 },
    { type: "elapsed", id: -1 },
    { type: "elapsed", id: 1.5 },
    { type: "elapsed", id: NaN },
    { type: "elapsed", id: Infinity },
    { type: "elapsed", id: Number.MAX_SAFE_INTEGER + 1 },
    { type: "elapsed", id: 999 },
    Object.create(valid),
  ]) {
    worker.emit(data);
    assert.equal(calls, 0, "invalid payload fired an overdue callback");
  }
  worker.emit(valid);
  assert.equal(calls, 1);
  assert.equal(f.workers.size, 0);
  assert.equal(f.timers.size, 0);
});

test("a retired worker cannot trigger a deadline belonging to its replacement", () => {
  const f = fixture();
  const cancel = f.clock.scheduleUploadTimeout(
    () => assert.fail("cancelled callback"),
    250,
  );
  const [retired] = f.workers;
  cancel();
  let calls = 0;
  f.clock.scheduleUploadTimeout(() => calls++, 250);
  const [current] = f.workers;
  f.jump(250);
  retired.emit({ type: "elapsed", id: 2 });
  assert.equal(calls, 0);
  current.emit({ type: "elapsed", id: 2 });
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
});

test("worker commands cannot cancel or replace a deadline through invalid events or payloads", () => {
  const cases = [
    [{ type: "cancel", id: 1 }, { origin: "https://attacker.example" }],
    [{ type: "cancel", id: 1 }, { isTrusted: false }],
    [{ type: "cancel", id: 1 }, { currentTarget: {} }],
    [{ type: "cancel", id: 1 }, { source: {} }],
    [{ type: "cancel", id: 1 }, { ports: [{}] }],
    [{ type: "cancel", id: 1, extra: true }, {}],
    [{ type: "schedule", id: 1, deadline: Infinity }, {}],
    [{ type: "schedule", id: 1, deadline: NaN }, {}],
    [{ type: "schedule", id: 1, deadline: -1 }, {}],
    [{ type: "schedule", id: 1, deadline: Number.MAX_SAFE_INTEGER + 1 }, {}],
    [{ type: "schedule", id: 1, deadline: "250" }, {}],
    [{ type: "schedule", id: 1, deadline: 999999, extra: true }, {}],
    [Object.create({ type: "cancel", id: 1 }), {}],
    [null, {}],
    [[], {}],
  ];
  for (const [data, overrides] of cases) {
    const f = fixture();
    let calls = 0;
    f.clock.scheduleUploadTimeout(() => calls++, 250);
    const [worker] = f.workers;
    worker.send(data, overrides);
    f.advance(250);
    assert.equal(calls, 1, "invalid command changed the existing deadline");
    assert.equal(f.timers.size, 0);
  }
});

test("upload deadlines fire on time when document timers wait a minute", () => {
  const f = fixture();
  let calls = 0;
  f.clock.scheduleUploadTimeout(() => calls++, 250);
  f.advance(249);
  assert.equal(calls, 0);
  f.advance(250);
  assert.equal(calls, 1);
  assert.equal(f.workers.size, 0);
  assert.equal(f.timers.size, 0);
  f.advance(60_000);
  assert.equal(calls, 1);
});

test("shared clock keeps other deadlines and releases its worker after cancellation", () => {
  const f = fixture();
  const calls = [];
  const cancel = f.clock.scheduleUploadTimeout(
    () => calls.push("cancelled"),
    100,
  );
  f.clock.scheduleUploadTimeout(() => calls.push("done"), 200);
  assert.equal(f.workers.size, 1);
  cancel();
  cancel();
  f.advance(200);
  assert.deepEqual(calls, ["done"]);
  assert.equal(f.workers.size, 0);
  assert.equal(f.timers.size, 0);
});

test("an interval can cancel itself without leaving a worker or another tick", () => {
  const f = fixture();
  let calls = 0;
  const stop = f.clock.scheduleUploadInterval(() => {
    if (++calls === 2) stop();
  }, 30_000);
  f.advance(30_000);
  assert.equal(calls, 1);
  assert.equal(f.workers.size, 1);
  f.advance(120_000);
  assert.equal(calls, 2);
  assert.equal(f.workers.size, 0);
  assert.equal(f.timers.size, 0);
});

test("ordinary timers remain available if the clock worker cannot start", () => {
  const f = fixture({ unavailable: true, clampDocument: false });
  let calls = 0;
  f.clock.scheduleUploadTimeout(() => calls++, 250);
  f.advance(250);
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
});

test("origin cooldown restores a queued socket despite clamped document timers", async () => {
  const f = fixture();
  const { UploadBatchCoordinator } = f.load("uploadBatchCoordinator.util", {
    "./uploadClock.util": f.clock,
  });
  const coordinator = new UploadBatchCoordinator();
  const flow = coordinator.registerFlow();
  coordinator.configure({
    originCount: 1,
    connectionsPerOrigin: 1,
    maxConcurrency: 1,
  });
  const candidates = [{ origin: "https://storage.example.test" }];
  const first = await coordinator.acquireDirect(flow, candidates);
  coordinator.releaseDirect(first.leaseId, "transient");
  let granted = false;
  const queued = coordinator.acquireDirect(flow, candidates).then(() => {
    granted = true;
  });
  f.advance(249);
  await Promise.resolve();
  assert.equal(granted, false);
  f.advance(250);
  await queued;
  assert.equal(granted, true);
  coordinator.close();
  assert.equal(f.workers.size, 0);
  assert.equal(f.timers.size, 0);
});

test("cancelling a retry wait releases its shared deadline immediately", async () => {
  const f = fixture();
  const { waitForUploadRetry } = f.load("uploadQueue.util", {
    "./uploadClock.util": f.clock,
  });
  const controller = new AbortController();
  const waiting = waitForUploadRetry(30_000, controller.signal);
  assert.equal(f.workers.size, 1);
  controller.abort();
  await waiting;
  assert.equal(f.workers.size, 0);
  assert.equal(f.timers.size, 0);
});
