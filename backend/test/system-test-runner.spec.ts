import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("the system-test runner seeds config and bounds backend startup", () => {
  const packageJson = JSON.parse(
    readFileSync(path.resolve("package.json"), "utf8"),
  );
  const runner = readFileSync(
    path.resolve("test/run-system-tests.mjs"),
    "utf8",
  );

  assert.equal(
    packageJson.scripts["test:system"],
    "node test/run-system-tests.mjs",
  );
  assert.match(runner, /\["migrate", "deploy"\]/);
  assert.doesNotMatch(runner, /migrate", "reset/);
  assert.match(runner, /\["db", "seed"\]/);
  assert.match(runner, /scripts\/ensure-sqlite-database\.mjs/);
  assert.match(runner, /http-get:\/\/127\.0\.0\.1:8080\/api\/configs/);
  assert.match(runner, /"--timeout",\s*"60000"/);
  assert.match(runner, /mkdtemp/);
  assert.match(runner, /CONFIG_FILE:/);
  assert.match(runner, /DATABASE_URL:/);
  assert.match(runner, /await rm\(temporaryRoot/);
});
