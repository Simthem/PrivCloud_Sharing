import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
test("production Axios interceptors retain page state across WAF and authentication renewal", () => {
  const env = {
    ...process.env,
    BUILD_TARGET: "",
    NEXT_PUBLIC_API_ORIGIN: "",
    PRIVCLOUD_NATIVE_CHECKOUT: existsSync(
      new URL("../src/utils/nativeAuthStore.ts", import.meta.url),
    )
      ? "1"
      : "0",
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-transform-types",
      "--experimental-test-module-mocks",
      "--import",
      "./test/register-ts.mjs",
      "--test",
      "./test/fixtures/safeline-api.mjs",
    ],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      timeout: 30_000,
      env,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /tests 8\b/);
});
