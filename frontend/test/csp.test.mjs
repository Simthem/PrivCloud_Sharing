import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContentSecurityPolicy,
  shouldEmbedCspMeta,
} from "../src/utils/csp.util.ts";

const NONCE = "0123456789abcdefghijklmn";

test("production CSP requires nonces for scripts and style elements", () => {
  const policy = buildContentSecurityPolicy(NONCE, false);

  assert.match(policy, new RegExp(`script-src [^;]*'nonce-${NONCE}'`));
  assert.match(policy, new RegExp(`style-src-elem [^;]*'nonce-${NONCE}'`));
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /'strict-dynamic'/);
  assert.doesNotMatch(policy, /script-src [^;]*'unsafe-inline'/);
  assert.doesNotMatch(policy, /script-src [^;]*'unsafe-eval'/);
  assert.doesNotMatch(policy, /style-src-elem [^;]*'unsafe-inline'/);
  assert.match(policy, /style-src-attr 'unsafe-inline'/);
});

test("development CSP enables eval without enabling inline scripts", () => {
  const policy = buildContentSecurityPolicy(NONCE, true);

  assert.match(policy, /script-src [^;]*'unsafe-eval'/);
  assert.doesNotMatch(policy, /script-src [^;]*'unsafe-inline'/);
});

test("CSP retains PDF frames and native Companion connections", () => {
  const policy = buildContentSecurityPolicy(NONCE, false);

  assert.match(policy, /frame-src [^;]*\bblob:/);
  assert.match(policy, /http:\/\/localhost:47631/);
  assert.match(policy, /http:\/\/127[.]0[.]0[.]1:47631/);
});

test("CSP rejects a nonce that could inject directives", () => {
  assert.throws(
    () => buildContentSecurityPolicy("bad'; script-src *", false),
    /Invalid CSP nonce/,
  );
});

test("static Capacitor exports keep CSP when Next supplies a synthetic response", () => {
  assert.equal(shouldEmbedCspMeta(true, "capacitor"), true);
  assert.equal(shouldEmbedCspMeta(true, "server"), false);
  assert.equal(shouldEmbedCspMeta(false, "server"), true);
});
