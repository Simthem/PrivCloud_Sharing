import assert from "node:assert/strict";
import test from "node:test";
import { UploadBatchCoordinator } from "../src/utils/uploadBatchCoordinator.util.ts";

const CANDIDATES = [
  { origin: "https://s3-path.example" },
  { origin: "https://s3-virtual.example" },
];

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

test("a ready file borrows idle slots while sibling workers wait for authentication", async () => {
  const coordinator = new UploadBatchCoordinator();
  const windows = [];
  const healthy = coordinator.registerFlow((window) => windows.push(window));
  const waiting = coordinator.registerFlow();
  coordinator.registerFlow();
  coordinator.registerFlow();
  coordinator.configure({ originCount: 1, connectionsPerOrigin: 6, maxConcurrency: 6 });
  const grants = [];
  const requests = Array.from({ length: 6 }, () => coordinator.acquireDirect(healthy, [CANDIDATES[0]])
    .then((grant) => { grants.push(grant); }, () => {}));
  try {
    await flushPromises();
    assert.equal(coordinator.activeDirectCount, 6, "idle workers reserved usable sockets");
    assert.equal(windows.at(-1), 6);
    const siblingGrants = [];
    for (let i = 0; i < 3; i++) {
      requests.push(coordinator.acquireDirect(waiting, [CANDIDATES[0]]).then((grant) => { siblingGrants.push(grant); }, () => {}));
    }
    for (const grant of grants.slice(0, 3)) coordinator.releaseDirect(grant.leaseId);
    await flushPromises();
    assert.equal(siblingGrants.length, 3, "a resumed sibling was starved by the borrowing file");
    assert.equal(coordinator.activeDirectCount, 6);
    assert.equal(windows.at(-1), 3);
  } finally {
    coordinator.close();
    await Promise.all(requests);
  }
});

test("a ready file also borrows spare slots while a sibling has its last part in flight", async () => {
  const coordinator = new UploadBatchCoordinator();
  const windows = [];
  const tail = coordinator.registerFlow();
  const healthy = coordinator.registerFlow((window) => windows.push(window));
  coordinator.configure({ originCount: 1, connectionsPerOrigin: 6, maxConcurrency: 6 });
  await coordinator.acquireDirect(tail, [CANDIDATES[0]]);
  const grants = [];
  const requests = Array.from({ length: 5 }, () => coordinator.acquireDirect(healthy, [CANDIDATES[0]])
    .then((grant) => { grants.push(grant); }, () => {}));
  try {
    await flushPromises();
    assert.equal(grants.length, 5, "the last sibling part reserved empty sockets");
    assert.equal(coordinator.activeDirectCount, 6);
    assert.equal(windows.at(-1), 5);
  } finally {
    coordinator.close();
    await Promise.all(requests);
  }
});

test("bounds and fairly drains 100 upload flows across two origins", async () => {
  const coordinator = new UploadBatchCoordinator();
  coordinator.configure({
    originCount: 2,
    connectionsPerOrigin: 6,
    maxConcurrency: 12,
    relayFallbackConcurrency: 2,
  });

  const flowIds = Array.from({ length: 100 }, () =>
    coordinator.registerFlow(),
  );
  const grants = [];
  const outcomes = flowIds.map((flowId) =>
    coordinator.acquireDirect(flowId, CANDIDATES).then(
      (grant) => {
        grants.push({ flowId, grant });
        return { flowId, grant };
      },
      (error) => ({ flowId, error }),
    ),
  );

  await flushPromises();
  assert.equal(coordinator.activeDirectCount, 12);
  assert.equal(grants.length, 12);
  assert.equal(new Set(grants.map(({ flowId }) => flowId)).size, 12);
  assert.deepEqual(
    Object.fromEntries(
      CANDIDATES.map(({ origin }) => [
        origin,
        grants.filter(({ grant }) => grant.origin === origin).length,
      ]),
    ),
    {
      "https://s3-path.example": 6,
      "https://s3-virtual.example": 6,
    },
  );

  for (const { grant } of grants.slice(0, 12)) {
    coordinator.releaseDirect(grant.leaseId);
  }
  await flushPromises();
  assert.equal(coordinator.activeDirectCount, 12);
  assert.equal(grants.length, 24);
  assert.equal(new Set(grants.map(({ flowId }) => flowId)).size, 24);

  coordinator.close();
  const settled = await Promise.all(outcomes);
  assert.equal(coordinator.activeDirectCount, 0);
  assert.equal(coordinator.activeRelayCount, 0);
  assert.equal(
    settled.filter(({ error }) => error?.message === "Upload flow was cancelled")
      .length,
    76,
  );
});

test("moves a retry to the alternate origin while the failed origin cools down", async () => {
  const coordinator = new UploadBatchCoordinator();
  coordinator.configure({
    originCount: 2,
    connectionsPerOrigin: 6,
    maxConcurrency: 12,
  });
  const flowId = coordinator.registerFlow();

  const first = await coordinator.acquireDirect(flowId, CANDIDATES);
  assert.equal(first.origin, CANDIDATES[0].origin);
  coordinator.releaseDirect(first.leaseId, "network");

  const retry = await coordinator.acquireDirect(flowId, CANDIDATES);
  assert.equal(retry.origin, CANDIDATES[1].origin);
  coordinator.releaseDirect(retry.leaseId);
  coordinator.close();
});

test("uses the relay global budget independently of the per-flow fallback hint", async () => {
  const coordinator = new UploadBatchCoordinator();
  coordinator.configure({
    relayFallbackConcurrency: 1,
    relayGlobalConcurrency: 6,
  });
  const flowIds = Array.from({ length: 10 }, () => coordinator.registerFlow());
  const leases = [];
  const outcomes = flowIds.map((flowId) =>
    coordinator.acquireRelay(flowId).then(
      (leaseId) => {
        leases.push(leaseId);
        return { leaseId };
      },
      (error) => ({ error }),
    ),
  );

  await flushPromises();
  assert.equal(coordinator.activeRelayCount, 6);
  assert.equal(leases.length, 6);

  coordinator.close();
  const settled = await Promise.all(outcomes);
  assert.equal(coordinator.activeRelayCount, 0);
  assert.equal(
    settled.filter(({ error }) => error?.message === "Upload flow was cancelled")
      .length,
    4,
  );
});
