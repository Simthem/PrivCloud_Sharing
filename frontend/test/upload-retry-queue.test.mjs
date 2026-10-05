import assert from "node:assert/strict";
import test from "node:test";
import pLimit from "p-limit";
import {
  runUploadQueue,
  waitForUploadRetry,
} from "../src/utils/uploadQueue.util.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an interrupted file rejoins a bounded pool before long siblings finish", async () => {
  const limit = pLimit(2),
    controller = new AbortController();
  const attempts = new Map(),
    waits = [],
    running = new Map();
  let active = 0,
    maximum = 0,
    finished = false;
  const done = runUploadQueue(["interrupted", "large", "queued"], {
    signal: controller.signal,
    schedule: (attempt) => limit(attempt),
    onRetry: () => 30_000,
    wait: async (delay) => {
      assert.equal(delay, 30_000);
      await new Promise((resolve) => waits.push(resolve));
    },
    upload: async (file) => {
      attempts.set(file, (attempts.get(file) ?? 0) + 1);
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (file === "interrupted" && attempts.get(file) === 1)
          return "retryable";
        await new Promise((resolve) => running.set(file, resolve));
        return "ok";
      } finally {
        active--;
      }
    },
  }).then(() => {
    finished = true;
  });
  await tick();
  assert.equal(attempts.get("queued"), 1, "backoff held a file slot");
  waits.shift()();
  running.get("queued")();
  await tick();
  assert.equal(
    attempts.get("interrupted"),
    2,
    "retry waited for the large file",
  );
  assert.equal(maximum, 2);
  assert.equal(finished, false);
  running.get("interrupted")();
  await tick();
  assert.equal(finished, false, "finalization raced the large file");
  running.get("large")();
  await done;
});

test("cancellation releases retry waits immediately and never starts another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const done = runUploadQueue(["file"], {
    signal: controller.signal,
    schedule: (attempt) => attempt(),
    upload: async () => {
      attempts++;
      return "retryable";
    },
    onRetry: () => 120_000,
  });
  await tick();
  controller.abort();
  await done;
  await waitForUploadRetry(120_000, controller.signal);
  assert.equal(attempts, 1);
});
