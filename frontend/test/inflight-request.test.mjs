import assert from "node:assert/strict";
import test from "node:test";
import { createInflightRequest } from "../src/utils/inflightRequest.util.ts";

test("simultaneous team panels share a read and refresh after settlement", async () => {
  const read = createInflightRequest();
  let calls = 0;
  const fetchKey = async () => {
    calls++;
    return { version: calls };
  };
  const panels = await Promise.all(
    Array.from({ length: 20 }, () => read("team-1", fetchKey)),
  );
  assert.equal(calls, 1);
  assert.ok(panels.every((response) => response === panels[0]));
  assert.deepEqual(await read("team-1", fetchKey), { version: 2 });
  await Promise.all([read("team-1", fetchKey), read("team-2", fetchKey)]);
  assert.equal(calls, 4);
  await assert.rejects(
    read("team-1", () => Promise.reject(new Error("temporary failure"))),
  );
  assert.deepEqual(await read("team-1", fetchKey), { version: 5 });
});
