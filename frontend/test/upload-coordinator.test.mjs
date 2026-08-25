import assert from "node:assert/strict";
import test from "node:test";
import { UploadBatchCoordinator } from "../src/utils/uploadBatchCoordinator.util.ts";

const CANDIDATES = [
  { origin: "https://s3-path.example" },
  { origin: "https://s3-virtual.example" },
];

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

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
