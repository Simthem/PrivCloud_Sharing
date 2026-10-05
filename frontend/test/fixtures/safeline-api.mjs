import assert from "node:assert/strict";
import { test, mock, afterEach } from "node:test";
import axios from "axios";
let challenges = 0,
  challengeFails = false;
const redirects = [];
globalThis.window = Object.assign(new EventTarget(), {
  Capacitor: { isNativePlatform: () => false },
  location: {
    origin: "https://share.example.test",
    pathname: "/upload",
    search: "",
    hash: "",
    reload: () => redirects.push("reload"),
    replace: (url) => redirects.push(url),
  },
});
mock.module(
  new URL("../../src/utils/safelineChallenge.util.ts", import.meta.url).href,
  {
    namedExports: {
      completeSafeLineChallenge: async () => {
        challenges++;
        if (challengeFails) throw new Error("blocked");
      },
      validateSafeLineSession: async () => true,
    },
  },
);
if (process.env.PRIVCLOUD_NATIVE_CHECKOUT === "1") {
  mock.module(
    new URL("../../src/utils/nativeSafeLineChallenge.ts", import.meta.url).href,
    { namedExports: { solveSafeLineChallengeNatively: async () => true } },
  );
  mock.module(
    new URL("../../src/utils/nativeAuthStore.ts", import.meta.url).href,
    {
      namedExports: {
        clearTokens: async () => {},
        getAccessTokenSync: () => null,
        getRefreshTokenSync: () => null,
        loadTokens: async () => {},
        setAccessTokenSync: () => {},
        setTokens: async () => {},
      },
    },
  );
}
let replies, calls;
axios.defaults.adapter = async (config) => {
  calls.push({
    url: axios.getUri(config),
    body: config.data,
    method: config.method,
  });
  const reply = replies.shift() ?? 200;
  const status = typeof reply === "object" ? reply.status : reply === "html" ? 200 : reply;
  const response = {
    status,
    statusText: "fixture",
    data: typeof reply === "object" ? reply.data : reply === "html" ? "<!doctype html><title>Verification</title>" : {},
    headers: typeof reply === "object" ? reply.headers ?? {} : reply === "html" ? { "content-type": "text/html" } : {},
    config,
  };
  if (status >= 400)
    throw new axios.AxiosError(
      "fixture",
      "ERR_BAD_RESPONSE",
      config,
      {},
      response,
    );
  return response;
};
const {
  default: api,
  setUploadActive,
  refreshTokenOnce,
} = await import("../../src/services/api.service.ts");
afterEach(async () => {
  setUploadActive(false);
  await new Promise((resolve) => setTimeout(resolve, 350));
});
function reset(sequence) {
  replies = [...sequence];
  calls = [];
  redirects.length = 0;
  challenges = 0;
  challengeFails = false;
}
for (const active of [true, false])
  test(`468 replays finalization without navigating, active=${active}`, async () => {
    reset([468, 200]);
    setUploadActive(active);
    const payload = { complete: true };
    await api.post("shares/fixture/complete", payload);
    assert.equal(challenges, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(redirects, []);
  });
test("a 468 during token rotation resumes the heartbeat and retains authentication", async () => {
  reset([401, 468, 200, 200]);
  setUploadActive(true);
  await api.post("shares/fixture/upload-heartbeat");
  assert.equal(challenges, 1);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "/api/shares/fixture/upload-heartbeat",
      "/api/auth/token",
      "/api/auth/token",
      "/api/shares/fixture/upload-heartbeat",
    ],
  );
  assert.deepEqual(redirects, []);
});
test("persistent 468 retries once and never reloads or signs out", async () => {
  reset([468, 468]);
  setUploadActive(true);
  await assert.rejects(
    api.post("shares/fixture/complete"),
    (error) => error.response.status === 468,
  );
  assert.equal(calls.length, 2);
  assert.equal(challenges, 1);
  assert.deepEqual(redirects, []);
});
test("a blocked challenge and a 503 preserve page state and status", async () => {
  reset([468]);
  challengeFails = true;
  await assert.rejects(
    api.get("configs"),
    (error) => error.response.status === 468,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(redirects, []);
  reset([503]);
  await assert.rejects(
    api.get("configs"),
    (error) => error.response.status === 503,
  );
  assert.equal(challenges, 0);
  assert.deepEqual(redirects, []);
});
test("direct refresh handles a challenge while the upload is inactive", async () => {
  reset([468, 200]);
  setUploadActive(false);
  assert.deepEqual(await refreshTokenOnce(), { ok: true, status: 200 });
  assert.equal(challenges, 1);
  assert.deepEqual(redirects, []);
});

test("HTTP 200 challenge documents never acknowledge token rotation or finalization", async () => {
  reset(["html", 200]);
  assert.deepEqual(await refreshTokenOnce(), { ok: true, status: 200 });
  assert.equal(challenges, 1);
  assert.equal(calls.length, 2);
  reset(["html", 200]);
  await api.post("shares/fixture/complete");
  assert.equal(challenges, 1);
  assert.equal(calls.length, 2);
  reset(["html", "html"]);
  await assert.rejects(
    api.post("shares/fixture/complete"),
    (error) => error.response.status === 468,
  );
  assert.equal(challenges, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(redirects, []);
});

test("HTML 401 and 403 use verified recovery while application JSON denials retain their status", async () => {
  const document = (status) => ({ status, data: "<!doctype html><title>Verification</title>", headers: { "content-type": "text/html" } });
  reset([document(403), 200]);
  setUploadActive(true);
  await api.post("shares/fixture/upload-heartbeat");
  assert.equal(challenges, 1);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(redirects, []);
  reset([document(401), 200]);
  assert.deepEqual(await refreshTokenOnce(), { ok: true, status: 200 });
  assert.equal(challenges, 1);
  const forbidden = { status: 403, data: { error: "Forbidden", message: "Access denied" } };
  reset([forbidden]);
  await assert.rejects(api.post("shares/fixture/upload-heartbeat"), (error) => error.response.status === 403);
  assert.equal(challenges, 0);
  assert.equal(calls.length, 1);
  reset([document(403), forbidden]);
  await assert.rejects(api.post("shares/fixture/upload-heartbeat"), (error) => error.response.status === 403);
  assert.equal(challenges, 1);
  assert.equal(calls.length, 2);
  reset([document(403), document(403)]);
  await assert.rejects(api.post("shares/fixture/upload-heartbeat"), (error) => error.response.status === 468);
  assert.equal(challenges, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(redirects, []);
});
