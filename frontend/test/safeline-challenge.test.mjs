import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateSafeLineSession,
  probeSafeLineSession,
  resolveChallengeViaPopup,
  completeSafeLineChallenge,
  prepareSafeLineRetry,
  handleSafeLineChallengeWindow,
} from "../src/utils/safelineChallenge.util.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("HTML denials request verification while JSON authorization failures remain unavailable", async () => {
  const saved = globalThis.fetch;
  try {
    for (const status of [401, 403]) {
      for (const contentType of ["text/html", "application/json"]) {
        let drained = 0;
        globalThis.fetch = async () => ({
          ok: false, status,
          headers: { get: () => contentType },
          arrayBuffer: async () => { drained++; return new ArrayBuffer(0); },
        });
        assert.equal(await probeSafeLineSession(), contentType === "text/html" ? "challenge" : "unavailable");
        assert.equal(await probeSafeLineSession(true), contentType === "text/html" ? "challenge" : "unavailable");
        assert.equal(drained, 2);
      }
    }
  } finally { globalThis.fetch = saved; }
});
function browserFixture() {
  const names = [
    "window",
    "navigator",
    "document",
    "sessionStorage",
    "BroadcastChannel",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
  ];
  const saved = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const intervals = new Map(),
    timeouts = new Map(),
    channels = [],
    listeners = new Map();
  let valid = false,
    networkFailure = false,
    popupClosed = 0,
    windowClosed = 0,
    opened = 0,
    removed = 0,
    drained = 0,
    cancelled = 0;
  const storage = new Map();
  const popup = {
    closed: false,
    opener: {},
    sessionStorage: { setItem: (k, v) => storage.set(k, v) },
    location: {
      replace(url) {
        popup.url = url;
      },
    },
    close() {
      popupClosed++;
      popup.closed = true;
    },
  };
  const win = {
    location: { origin: "https://share.example.test", search: "" },
    opener: null,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    open() {
      opened++;
      return popup;
    },
    close() {
      windowClosed++;
    },
  };
  win.top = win.self = win;
  globalThis.window = win;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userActivation: { isActive: false } },
  });
  globalThis.document = {
    createElement: () => ({
      style: {},
      setAttribute() {},
      remove() {
        removed++;
      },
    }),
    body: { appendChild() {} },
  };
  globalThis.sessionStorage = {
    getItem: (k) => storage.get(k),
    removeItem: (k) => storage.delete(k),
  };
  globalThis.BroadcastChannel = class {
    closed = false;
    constructor() {
      channels.push(this);
    }
    postMessage(message) {
      this.message = message;
    }
    close() {
      this.closed = true;
    }
  };
  globalThis.setInterval = (fn, delay) => {
    const id = {};
    intervals.set(id, { fn, delay });
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);
  globalThis.setTimeout = (fn, delay) => {
    const id = {};
    timeouts.set(id, { fn, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => timeouts.delete(id);
  globalThis.fetch = async (url, options) => {
    assert.match(url, /^(?:\/api\/configs|\/)\?/);
    assert.equal(options.credentials, "include");
    assert.equal(options.cache, "no-store");
    if (networkFailure) throw new Error("offline");
    return {
      ok: valid,
      status: valid ? 200 : 468,
      headers: {
        get: () =>
          valid && url.startsWith("/api/")
            ? "application/json; charset=utf-8"
            : "text/html",
      },
      arrayBuffer: async () => {
        drained++;
        return new ArrayBuffer(0);
      },
      body: { cancel: async () => {
          cancelled++;
        },
      },
    };
  };
  return {
    win,
    popup,
    channels,
    storage,
    intervals,
    timeouts,
    listeners,
    setValid(value) {
      valid = value;
    },
    setOffline(value) {
      networkFailure = value;
    },
    async poll() {
      for (const { fn } of [...intervals.values()]) fn();
      await tick();
    },
    async expire(delay) {
      for (const [id, timer] of [...timeouts])
        if (timer.delay === delay) {
          timeouts.delete(id);
          timer.fn();
        }
      await tick();
    },
    counts: () => ({ popupClosed, windowClosed, opened, removed,
      drained,
      cancelled,
    }),
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test("WAF validation rejects HTML challenges and network failures", async () => {
  const f = browserFixture();
  try {
    assert.equal(await validateSafeLineSession(), false);
    f.setValid(true);
    assert.equal(await validateSafeLineSession(), true);
    assert.equal(f.counts().drained, 3);
    assert.equal(f.counts().cancelled, 0);
    f.setOffline(true);
    assert.equal(await validateSafeLineSession(), false);
    assert.equal(f.timeouts.size, 0);
  } finally {
    f.restore();
  }
});

test("popup polls the API and closes without an opener or broadcast signal", async () => {
  const f = browserFixture();
  try {
    const waiting = resolveChallengeViaPopup();
    assert.equal(f.popup.opener, null);
    assert.equal(f.storage.get("__sl_challenge"), "1");
    assert.match(f.popup.url, /_sl_popup=1$/);
    // COOP may report a closed proxy although the real popup still exists.
    f.popup.closed = true;
    let completed = false;
    waiting.then(() => {
      completed = true;
    });
    await f.poll();
    assert.equal(completed, false);
    f.setValid(true);
    await f.poll();
    await waiting;
    assert.equal(f.counts().popupClosed, 1);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.timeouts.size, 0);
    assert.equal(f.listeners.size, 0);
    assert.ok(f.channels.every((c) => c.closed));
  } finally {
    f.restore();
  }
});

test("closing the popup or sending a completion signal cannot bypass a WAF rejection", async () => {
  const f = browserFixture();
  try {
    const waiting = resolveChallengeViaPopup(1234);
    const rejection = assert.rejects(waiting, /timeout/);
    f.popup.closed = true;
    f.channels[0].onmessage({ data: { type: "safeline-challenge-complete" } });
    await tick();
    await f.poll();
    await f.expire(1234);
    await rejection;
    assert.equal(f.intervals.size, 0);
    assert.equal(f.timeouts.size, 0);
  } finally {
    f.restore();
  }
});

test("marked isolated popups close themselves only after a verified API response", async () => {
  const f = browserFixture();
  try {
    f.win.location.search = "?_sl_popup=1";
    const cleanup = handleSafeLineChallengeWindow();
    await tick();
    assert.equal(f.counts().windowClosed, 0);
    f.setValid(true);
    await f.poll();
    assert.equal(f.counts().windowClosed, 1);
    assert.equal(f.channels[0].message.type, "safeline-challenge-complete");
    assert.equal(f.intervals.size, 0);
    assert.equal(f.timeouts.size, 0);
    cleanup();
  } finally {
    f.restore();
  }
});

test("ordinary windows with an opener are never closed", async () => {
  const f = browserFixture();
  try {
    f.win.opener = {};
    f.setValid(true);
    handleSafeLineChallengeWindow();
    await tick();
    assert.equal(f.counts().windowClosed, 0);
    assert.equal(f.intervals.size, 0);
  } finally {
    f.restore();
  }
});

test("parallel upload requests share one challenge and remove the iframe before popup fallback", async () => {
  const f = browserFixture();
  try {
    const first = completeSafeLineChallenge();
    assert.equal(completeSafeLineChallenge(), first);
    await f.expire(45000);
    assert.equal(f.counts().opened, 1);
    assert.equal(f.counts().removed, 1);
    f.setValid(true);
    await f.poll();
    await first;
    assert.equal(f.counts().popupClosed, 1);
    assert.equal(f.intervals.size, 0);
    assert.ok(f.channels.every((c) => c.closed));
  } finally {
    f.restore();
  }
});

test("a retry click opens a previously blocked popup before losing user activation", async () => {
  const f = browserFixture();
  try {
    const open = f.win.open;
    f.win.open = () => null;
    await assert.rejects(resolveChallengeViaPopup(), /popup-blocked/);
    f.win.open = open;
    navigator.userActivation.isActive = true;
    const first = completeSafeLineChallenge();
    assert.equal(f.counts().opened, 1);
    assert.equal(completeSafeLineChallenge(), first);
    assert.equal(f.counts().removed, 0);
    navigator.userActivation.isActive = false;
    f.setValid(true);
    await f.poll();
    await first;
    assert.equal(f.counts().popupClosed, 1);
  } finally {
    f.restore();
  }
});
test("a real retry click can solve a challenge already waiting in a background iframe", async () => {
  const f = browserFixture();
  try {
    const open = f.win.open;
    f.win.open = () => null;
    await assert.rejects(resolveChallengeViaPopup(), /popup-blocked/);
    f.win.open = open;
    const background = completeSafeLineChallenge();
    assert.equal(f.counts().opened, 0);
    navigator.userActivation.isActive = true;
    const foreground = completeSafeLineChallenge();
    assert.equal(f.counts().opened, 1);
    navigator.userActivation.isActive = false;
    f.setValid(true);
    await f.poll();
    await Promise.all([background, foreground]);
    assert.equal(f.counts().removed, 1);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.timeouts.size, 0);
  } finally {
    f.restore();
  }
});

test("a blocked manual popup keeps verification pending and permits another click", async () => {
  const f = browserFixture();
  try {
    const open = f.win.open;
    f.win.open = () => null;
    await assert.rejects(resolveChallengeViaPopup(), /popup-blocked/);
    navigator.userActivation.isActive = true;
    await assert.rejects(completeSafeLineChallenge(), /popup-blocked/);
    assert.equal(await validateSafeLineSession(), false);
    f.win.open = open;
    navigator.userActivation.isActive = false;
    const waiting = prepareSafeLineRetry();
    assert.equal(f.counts().opened, 1);
    f.setValid(true);
    await f.poll();
    await waiting;
    assert.equal(f.intervals.size, 0);
  } finally {
    f.restore();
  }
});

test("verified background renewal clears an obsolete popup requirement", async () => {
  const f = browserFixture();
  try {
    const open = f.win.open;
    f.win.open = () => null;
    await assert.rejects(resolveChallengeViaPopup(), /popup-blocked/);
    f.win.open = open;
    f.setValid(true);
    assert.equal(await validateSafeLineSession(), true);
    await prepareSafeLineRetry();
    assert.equal(f.counts().opened, 0);
  } finally {
    f.restore();
  }
});
