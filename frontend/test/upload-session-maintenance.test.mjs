import assert from "node:assert/strict";
import { test } from "node:test";
import { startUploadSessionMaintenance } from "../src/utils/uploadSessionMaintenance.util.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const names = ["window", "document", "setInterval", "clearInterval"];
  const descriptors = names.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  const window = new EventTarget(),
    document = new EventTarget();
  document.visibilityState = "hidden";
  const intervals = new Map();
  globalThis.window = window;
  globalThis.document = document;
  globalThis.setInterval = (fn) => {
    const id = {};
    intervals.set(id, fn);
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);
  return {
    window,
    document,
    intervals,
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}
test("hidden upload and pending finalization renew WAF without a user gesture", async () => {
  const f = fixture();
  let stop;
  try {
    let status = "challenge",
      probes = 0,
      solves = 0,
      heartbeats = 0;
    stop = startUploadSessionMaintenance({
      isActive: () => true,
      probeSession: async () => {
        probes++;
        return status;
      },
      resolveChallenge: async () => {
        solves++;
        status = "valid";
      },
      heartbeat: async () => {
        heartbeats++;
      },
    });
    await tick();
    assert.equal(solves, 1);
    assert.equal(heartbeats, 1);
    status = "challenge";
    for (const fn of f.intervals.values()) fn();
    await tick();
    assert.equal(solves, 2);
    assert.equal(probes, 2);
    stop();
    assert.equal(f.intervals.size, 0);
    f.window.dispatchEvent(new Event("focus"));
    await tick();
    assert.equal(probes, 2);
  } finally {
    stop?.();
    f.restore();
  }
});
test("visibility, focus, pageshow and online immediately probe a pending session", async () => {
  const f = fixture();
  let stop;
  try {
    let probes = 0;
    stop = startUploadSessionMaintenance({
      isActive: () => true,
      probeSession: async () => {
        probes++;
        return "valid";
      },
      resolveChallenge: async () => {},
      heartbeat: async () => {},
    });
    await tick();
    for (const name of ["focus", "pageshow", "online"]) {
      f.window.dispatchEvent(new Event(name));
      await tick();
    }
    f.document.visibilityState = "visible";
    f.document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    assert.equal(probes, 5);
  } finally {
    stop?.();
    f.restore();
  }
});
test("network outages never trigger challenges and overlapping checks are serialized", async () => {
  const f = fixture();
  let stop;
  try {
    let completeProbe,
      probes = 0,
      challenges = 0,
      heartbeats = 0;
    stop = startUploadSessionMaintenance({
      isActive: () => true,
      probeSession: () => {
        probes++;
        return new Promise((resolve) => {
          completeProbe = resolve;
        });
      },
      resolveChallenge: async () => {
        challenges++;
      },
      heartbeat: async () => {
        heartbeats++;
      },
    });
    f.window.dispatchEvent(new Event("focus"));
    for (const fn of f.intervals.values()) fn();
    assert.equal(probes, 1);
    completeProbe("unavailable");
    await tick();
    assert.equal(challenges, 0);
    assert.equal(heartbeats, 0);
    f.window.dispatchEvent(new Event("online"));
    assert.equal(probes, 2);
    stop();
    completeProbe("challenge");
    await tick();
    assert.equal(challenges, 0);
    assert.equal(heartbeats, 0);
  } finally {
    stop?.();
    f.restore();
  }
});
