import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { synchronizeCompletedUpload } from "../src/utils/uploadStateCache.util.ts";

test("completion removes only the acknowledged upload and refreshes published shares", async () => {
  const client = new QueryClient();
  try {
    client.setQueryData(
      ["pendingUploads", "owner"],
      [{ id: "finished" }, { id: "unfinished" }],
    );
    client.setQueryData(["myShares", "owner"], []);
    client.setQueryData(["share", "finished"], { uploadPending: true });
    await synchronizeCompletedUpload(client, "finished");
    assert.deepEqual(client.getQueryData(["pendingUploads", "owner"]), [
      { id: "unfinished" },
    ]);
    assert.equal(
      client.getQueryState(["myShares", "owner"]).isInvalidated,
      true,
    );
    assert.equal(
      client.getQueryState(["share", "finished"]).isInvalidated,
      true,
    );
  } finally {
    client.clear();
  }
});

test("an older pending-list response cannot restore a finalized upload", async () => {
  const client = new QueryClient();
  let deliverOldResponse;
  try {
    client.setQueryData(
      ["pendingUploads", "owner"],
      [{ id: "finished" }, { id: "unfinished" }],
    );
    const oldResponse = new Promise((resolve) => {
      deliverOldResponse = resolve;
    });
    const fetching = client
      .fetchQuery({
        queryKey: ["pendingUploads", "owner"],
        queryFn: () => oldResponse,
        staleTime: 0,
      })
      .catch(() => undefined);
    await Promise.resolve();
    await synchronizeCompletedUpload(client, "finished");
    deliverOldResponse([{ id: "finished" }, { id: "unfinished" }]);
    await fetching;
    assert.deepEqual(client.getQueryData(["pendingUploads", "owner"]), [
      { id: "unfinished" },
    ]);
  } finally {
    client.clear();
  }
});

test("active owner lists refetch after completion and retain other unfinished uploads", async () => {
  const client = new QueryClient();
  let publishedReads = 0;
  const pending = new QueryObserver(client, {
    queryKey: ["pendingUploads", "owner"],
    initialData: [{ id: "finished" }, { id: "unfinished" }],
    staleTime: Infinity,
    queryFn: async () => [{ id: "unfinished" }],
  });
  const published = new QueryObserver(client, {
    queryKey: ["myShares", "owner"],
    initialData: [],
    staleTime: Infinity,
    queryFn: async () => {
      publishedReads++;
      return [{ id: "finished" }];
    },
  });
  const subscriptions = [
    pending.subscribe(() => {}),
    published.subscribe(() => {}),
  ];
  try {
    await synchronizeCompletedUpload(client, "finished");
    assert.equal(publishedReads, 1);
    assert.deepEqual(published.getCurrentResult().data, [{ id: "finished" }]);
    assert.deepEqual(pending.getCurrentResult().data, [{ id: "unfinished" }]);
  } finally {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    client.clear();
  }
});
