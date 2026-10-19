import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  synchronizeCompletedUpload,
  synchronizeRemovedShare,
} from "../src/utils/uploadStateCache.util.ts";

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

test("completion marks every team's folder views stale", async () => {
  const client = new QueryClient();
  try {
    const teamViews = [
      ["team.folder.shares", "team-1", "folder-1"],
      ["team.folders", "team-1"],
      ["team.folders", "team-2"],
      ["team.metrics", "team-1"],
      ["team.searchIndex", "team-1"],
      ["team.logs", "team-1"],
      ["team-shares", "team-1", 1, 1],
      ["team.signatures", "team-1", 1],
    ];
    for (const queryKey of teamViews) client.setQueryData(queryKey, []);
    client.setQueryData(["team", "team-1"], {});
    await synchronizeCompletedUpload(client, "finished");
    for (const queryKey of teamViews) {
      assert.equal(client.getQueryState(queryKey).isInvalidated, true);
    }
    assert.equal(client.getQueryState(["team", "team-1"]).isInvalidated, false);
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
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(published.getCurrentResult().data, [{ id: "finished" }]);
    assert.deepEqual(pending.getCurrentResult().data, [{ id: "unfinished" }]);
  } finally {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    client.clear();
  }
});

test("slow owner-list refreshes do not delay completion acknowledgement", async () => {
  const client = new QueryClient();
  const releases = [];
  const observers = [
    ["pendingUploads", "owner"],
    ["myShares", "owner"],
    ["share", "finished"],
  ].map(
    (queryKey) =>
      new QueryObserver(client, {
        queryKey,
        staleTime: Infinity,
        initialData:
          queryKey[0] === "pendingUploads"
            ? [{ id: "finished" }, { id: "unfinished" }]
            : [],
        queryFn: () => new Promise((resolve) => releases.push(resolve)),
      }),
  );
  const subscriptions = observers.map((observer) =>
    observer.subscribe(() => {}),
  );
  try {
    // Each HTTP response stays blocked until after the local completion returns.
    await synchronizeCompletedUpload(client, "finished");
    assert.equal(releases.length, 3);
    assert.deepEqual(client.getQueryData(["pendingUploads", "owner"]), [
      { id: "unfinished" },
    ]);
    assert.ok(
      observers.every((observer) => observer.getCurrentResult().isFetching),
    );
  } finally {
    releases.forEach((resolve) => resolve([]));
    subscriptions.forEach((unsubscribe) => unsubscribe());
    client.clear();
  }
});

test("confirmed share deletion removes owner/pending entries and refreshes team folder views", async () => {
  const client = new QueryClient();
  client.setQueryData(
    ["pendingUploads", "owner"],
    [{ id: "removed" }, { id: "other" }],
  );
  client.setQueryData(
    ["myShares", "owner"],
    [{ id: "removed" }, { id: "other" }],
  );
  client.setQueryData(["share", "removed"], { id: "removed" });
  client.setQueryData(["share", "other"], { id: "other" });
  client.setQueryData(["team.folders", "team"], []);
  try {
    await synchronizeRemovedShare(client, "removed");
    assert.deepEqual(client.getQueryData(["pendingUploads", "owner"]), [
      { id: "other" },
    ]);
    assert.deepEqual(client.getQueryData(["myShares", "owner"]), [
      { id: "other" },
    ]);
    assert.equal(client.getQueryData(["share", "removed"]), undefined);
    assert.deepEqual(client.getQueryData(["share", "other"]), { id: "other" });
    assert.equal(
      client.getQueryState(["team.folders", "team"]).isInvalidated,
      true,
    );
  } finally {
    client.clear();
  }
});
