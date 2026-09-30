import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  decryptRefreshReplay,
  encryptRefreshReplay,
} from "src/auth/refresh-replay.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("refresh replay encryption");

testCase(
  "encrypts replay tokens with authenticated randomized envelopes",
  () => {
    const tokens = {
      accessToken: crypto.randomUUID(),
      refreshToken: crypto.randomUUID(),
    };
    const secret = crypto.randomBytes(32).toString("base64url");
    const unrelatedSecret = crypto.randomBytes(32).toString("base64url");
    const first = encryptRefreshReplay(tokens, secret);
    const second = encryptRefreshReplay(tokens, secret);

    assert.notEqual(first, second);
    assert.equal(first.includes(tokens.accessToken), false);
    assert.equal(first.includes(tokens.refreshToken), false);
    assert.deepEqual(decryptRefreshReplay(first, secret), tokens);
    assert.throws(() => decryptRefreshReplay(first, unrelatedSecret));
    const parts = first.split(".");
    parts[2] = `${parts[2].startsWith("A") ? "B" : "A"}${parts[2].slice(1)}`;
    assert.throws(() => decryptRefreshReplay(parts.join("."), secret));
  },
);

void run();
