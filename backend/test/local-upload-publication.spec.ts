import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUnitTestRunner } from "./unit-test";

const dataDirectory = mkdtempSync(
  path.join(os.tmpdir(), "privcloud-local-upload-"),
);
process.env.DATA_DIRECTORY = dataDirectory;

// SHARE_DIRECTORY is resolved when the module loads, after DATA_DIRECTORY.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LocalFileService } = require("src/file/local.service") as {
  LocalFileService: typeof import("src/file/local.service").LocalFileService;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SHARE_DIRECTORY } = require("src/constants") as {
  SHARE_DIRECTORY: string;
};

const { testCase, run } = createUnitTestRunner("local upload publication");

const CHUNK = 1_000_000;

type Row = {
  id: string;
  shareId: string;
  name: string;
  size: string;
  contentScheme?: number | null;
  encryptedMetadata?: string | null;
  metadataScheme?: number | null;
  relativePath?: string | null;
};

class Store {
  rows = new Map<string, Row>();
  failNextTransaction = false;

  client() {
    const file = {
      findUnique: async ({ where }: { where: { id: string } }) =>
        this.rows.get(where.id) ?? null,
      findFirst: async ({
        where,
      }: {
        where: { id: string; shareId: string };
      }) => {
        const row = this.rows.get(where.id);
        return row && row.shareId === where.shareId ? row : null;
      },
      create: async ({
        data,
      }: {
        data: {
          id: string;
          name: string;
          size: string;
          contentScheme?: number | null;
          share: { connect: { id: string } };
        };
      }) => {
        if (this.rows.has(data.id)) {
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        const row = {
          id: data.id,
          name: data.name,
          size: data.size,
          contentScheme: data.contentScheme,
          shareId: data.share.connect.id,
        };
        this.rows.set(row.id, row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; shareId: string };
        data: {
          size: string;
          contentScheme?: number | null;
          encryptedMetadata?: string;
        };
      }) => {
        const row = this.rows.get(where.id);
        if (!row || row.shareId !== where.shareId) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    };
    const share = {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        uploadLocked: false,
        isE2EEncrypted: false,
        creatorId: null,
        reverseShare: null,
        files: [...this.rows.values()].filter(
          (row) => row.shareId === where.id,
        ),
      }),
    };
    const client: Record<string, unknown> = {
      file,
      share,
      $queryRaw: async () => [],
      $transaction: async (task: (tx: unknown) => Promise<unknown>) => {
        const snapshot = new Map(
          [...this.rows].map(([id, row]) => [id, { ...row }]),
        );
        try {
          const result = await task(client);
          if (this.failNextTransaction) {
            this.failNextTransaction = false;
            throw new Error("Transaction aborted");
          }
          return result;
        } catch (error) {
          this.rows = snapshot;
          throw error;
        }
      },
    };
    return client;
  }
}

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  log: () => undefined,
};

const buildService = (store: Store) => {
  const service = new LocalFileService(
    store.client() as never,
    {
      get: (key: string) => (key === "share.chunkSize" ? CHUNK : undefined),
    } as never,
  );
  (service as unknown as { logger: typeof silentLogger }).logger = silentLogger;
  return service;
};

const newShare = () => {
  const shareId = randomUUID();
  mkdirSync(path.join(SHARE_DIRECTORY, shareId), { recursive: true });
  return shareId;
};

const filePath = (shareId: string, fileId: string) =>
  path.join(SHARE_DIRECTORY, shareId, fileId);

const shareEntries = (shareId: string) =>
  readdirSync(path.join(SHARE_DIRECTORY, shareId)).sort();

const upload = (
  service: InstanceType<typeof LocalFileService>,
  shareId: string,
  fileId: string,
  content: Buffer,
  limit = Infinity,
) => {
  const total = Math.max(1, Math.ceil(content.byteLength / CHUNK));
  return (async () => {
    for (let index = 0; index < total; index++) {
      await service.create(
        content.subarray(index * CHUNK, (index + 1) * CHUNK),
        { index, total },
        { id: fileId, name: "report.pdf" },
        shareId,
        CHUNK,
        undefined,
        limit,
      );
    }
  })();
};

const bytes = (fill: number, length: number) => Buffer.alloc(length, fill);

testCase("a second upload never replaces a published file", async () => {
  const store = new Store();
  const service = buildService(store);
  const shareId = newShare();
  const fileId = randomUUID();
  const original = bytes(1, CHUNK + 10);

  await upload(service, shareId, fileId, original);
  await upload(service, shareId, fileId, bytes(2, CHUNK + 20));

  assert.deepEqual(readFileSync(filePath(shareId, fileId)), original);
  assert.equal(store.rows.get(fileId)?.size, String(original.byteLength));
  assert.deepEqual(shareEntries(shareId), [fileId]);
});

testCase("an identifier owned by another share is refused", async () => {
  const store = new Store();
  const service = buildService(store);
  const ownerShare = newShare();
  const otherShare = newShare();
  const fileId = randomUUID();
  const original = bytes(3, 64);

  await upload(service, ownerShare, fileId, original);
  await assert.rejects(
    upload(service, otherShare, fileId, bytes(4, 64)),
    /File ID is already in use/,
  );

  assert.deepEqual(readFileSync(filePath(ownerShare, fileId)), original);
  assert.equal(store.rows.get(fileId)?.shareId, ownerShare);
  assert.deepEqual(shareEntries(otherShare), []);
});

testCase("a file published by another process is never replaced", async () => {
  const store = new Store();
  const service = buildService(store);
  const shareId = newShare();
  const fileId = randomUUID();
  const inFlight = bytes(5, 64);
  writeFileSync(filePath(shareId, fileId), inFlight);

  await assert.rejects(
    upload(service, shareId, fileId, bytes(6, 64)),
    /File ID is already in use/,
  );

  assert.deepEqual(readFileSync(filePath(shareId, fileId)), inFlight);
  assert.equal(store.rows.has(fileId), false);
  assert.deepEqual(shareEntries(shareId), [fileId]);
});

testCase(
  "concurrent uploads with one identifier publish exactly one file",
  async () => {
    const store = new Store();
    const service = buildService(store);
    const shareId = newShare();
    const fileId = randomUUID();
    const first = bytes(7, 4096);
    const second = bytes(8, 4096);

    await Promise.allSettled([
      upload(service, shareId, fileId, first),
      upload(service, shareId, fileId, second),
    ]);

    const published = readFileSync(filePath(shareId, fileId));
    assert.ok(published.equals(first) || published.equals(second));
    assert.equal(store.rows.get(fileId)?.size, String(published.byteLength));
    assert.deepEqual(shareEntries(shareId), [fileId]);
  },
);

testCase(
  "a failed transaction leaves neither a record nor a published file",
  async () => {
    const store = new Store();
    const service = buildService(store);
    const shareId = newShare();
    const fileId = randomUUID();
    store.failNextTransaction = true;

    await assert.rejects(
      upload(service, shareId, fileId, bytes(9, 64)),
      /Transaction aborted/,
    );

    assert.equal(store.rows.has(fileId), false);
    assert.deepEqual(shareEntries(shareId), []);
  },
);

testCase(
  "an exceeded quota removes only the copy published by this upload",
  async () => {
    const store = new Store();
    const service = buildService(store);
    const shareId = newShare();
    const kept = randomUUID();
    const refused = randomUUID();
    const original = bytes(10, 64);
    await upload(service, shareId, kept, original);

    await assert.rejects(
      upload(service, shareId, refused, bytes(11, 64), 100),
      /Max share size exceeded/,
    );
    await upload(service, shareId, kept, bytes(12, 64), 100);

    assert.deepEqual(readFileSync(filePath(shareId, kept)), original);
    assert.equal(store.rows.has(refused), false);
    assert.deepEqual(shareEntries(shareId), [kept]);
  },
);

testCase(
  "an interrupted upload resumes and publishes its own content",
  async () => {
    const store = new Store();
    const service = buildService(store);
    const shareId = newShare();
    const fileId = randomUUID();
    const content = Buffer.concat([bytes(13, CHUNK), bytes(14, 99)]);
    const send = (index: number) =>
      service.create(
        content.subarray(index * CHUNK, (index + 1) * CHUNK),
        { index, total: 2 },
        { id: fileId, name: "report.pdf" },
        shareId,
        CHUNK,
      );

    await send(0);
    assert.equal(existsSync(filePath(shareId, fileId)), false);
    await assert.rejects(
      send(0),
      (error: { response?: { expectedChunkIndex?: number } }) => {
        assert.equal(error.response?.expectedChunkIndex, 1);
        return true;
      },
    );
    await send(1);

    assert.deepEqual(readFileSync(filePath(shareId, fileId)), content);
    assert.equal(store.rows.get(fileId)?.size, String(content.byteLength));
    assert.deepEqual(shareEntries(shareId), [fileId]);
  },
);

testCase("a chunk retried concurrently is appended once", async () => {
  const store = new Store();
  const service = buildService(store);
  const shareId = newShare();
  const fileId = randomUUID();
  const content = Buffer.concat([bytes(20, CHUNK), bytes(21, 10)]);
  const send = (index: number) =>
    service.create(
      content.subarray(index * CHUNK, (index + 1) * CHUNK),
      { index, total: 2 },
      { id: fileId, name: "report.pdf" },
      shareId,
      CHUNK,
    );

  const attempts = await Promise.allSettled([send(0), send(0)]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  await send(1);

  assert.deepEqual(readFileSync(filePath(shareId, fileId)), content);
});

testCase(
  "two backend processes racing on one identifier publish one file",
  async () => {
    const store = new Store();
    const shareId = newShare();
    const fileId = randomUUID();
    const first = bytes(22, 4096);
    const second = bytes(23, 4096);

    await Promise.allSettled([
      upload(buildService(store), shareId, fileId, first),
      upload(buildService(store), shareId, fileId, second),
    ]);

    const published = readFileSync(filePath(shareId, fileId));
    assert.ok(published.equals(first) || published.equals(second));
    assert.equal(store.rows.get(fileId)?.size, String(published.byteLength));
    assert.deepEqual(shareEntries(shareId), [fileId]);
  },
);

testCase("a lock left by a stopped process is recovered", async () => {
  const store = new Store();
  const service = buildService(store);
  const shareId = newShare();
  const fileId = randomUUID();
  const lock = filePath(shareId, `${fileId}.lock.tmp-chunk`);
  writeFileSync(lock, "");
  const stopped = new Date(Date.now() - 20 * 60_000);
  utimesSync(lock, stopped, stopped);

  await upload(service, shareId, fileId, bytes(24, 64));

  assert.deepEqual(shareEntries(shareId), [fileId]);
});

testCase("a lock held by another process delays the chunk", async () => {
  const store = new Store();
  const service = buildService(store);
  const shareId = newShare();
  const fileId = randomUUID();
  const lock = filePath(shareId, `${fileId}.lock.tmp-chunk`);
  writeFileSync(lock, "");
  let released = false;
  setTimeout(() => {
    released = true;
    rmSync(lock);
  }, 300);

  await upload(service, shareId, fileId, bytes(25, 64));

  assert.equal(released, true);
  assert.deepEqual(shareEntries(shareId), [fileId]);
});

testCase("authorized re-encryption still replaces its own file", async () => {
  const store = new Store();
  const service = buildService(store);
  const shareId = newShare();
  const fileId = randomUUID();
  await upload(service, shareId, fileId, bytes(15, 64));

  const rewritten = bytes(16, 80);
  await service.replace(rewritten, { index: 0, total: 1 }, fileId, shareId);

  assert.deepEqual(readFileSync(filePath(shareId, fileId)), rewritten);
  assert.equal(store.rows.get(fileId)?.size, "80");
  assert.deepEqual(shareEntries(shareId), [fileId]);
});

testCase(
  "filesystems without hard links publish without replacing",
  async () => {
    const store = new Store();
    const service = buildService(store);
    const shareId = newShare();
    const fileId = randomUUID();
    const original = bytes(17, 64);
    (service as unknown as { linkFile: () => Promise<void> }).linkFile =
      async () => {
        throw Object.assign(new Error("Operation not permitted"), {
          code: "EPERM",
        });
      };
    await upload(service, shareId, fileId, original);
    const busy = randomUUID();
    writeFileSync(filePath(shareId, busy), "in flight");
    await assert.rejects(
      upload(service, shareId, busy, bytes(19, 64)),
      /File ID is already in use/,
    );

    assert.equal(readFileSync(filePath(shareId, busy), "utf8"), "in flight");
    assert.deepEqual(readFileSync(filePath(shareId, fileId)), original);
    assert.equal(store.rows.get(fileId)?.size, "64");
  },
);

testCase(
  "the E2EE v2 header of the first chunk does not shift later chunks",
  async () => {
    const store = new Store();
    const service = buildService(store);
    const shareId = newShare();
    const fileId = randomUUID();
    const first = Buffer.concat([bytes(9, 32), bytes(1, CHUNK)]);
    const last = bytes(2, 17);
    const file = { id: fileId, name: "report.pdf", contentScheme: 2 as const };
    await service.create(first, { index: 0, total: 2 }, file, shareId, CHUNK);
    await assert.rejects(
      service.create(last, { index: 2, total: 3 }, file, shareId, CHUNK),
      /Unexpected chunk/,
    );
    await service.create(last, { index: 1, total: 2 }, file, shareId, CHUNK);
    assert.deepEqual(
      readFileSync(filePath(shareId, fileId)),
      Buffer.concat([first, last]),
    );
    assert.equal(store.rows.get(fileId)?.contentScheme, 2);
    const v1 = randomUUID();
    await upload(service, shareId, v1, bytes(3, CHUNK + 5));
    assert.equal(store.rows.get(v1)?.contentScheme, null);
  },
);

testCase(
  "re-encryption commits encrypted metadata, format and size in one update",
  async () => {
    const store = new Store();
    const service = buildService(store);
    const shareId = newShare();
    const fileId = randomUUID();
    await upload(service, shareId, fileId, bytes(1, 64));
    const encryptedMetadata = "opaque-new-description";
    const replacement = bytes(3, 60);
    await service.replace(
      replacement,
      { index: 0, total: 1 },
      fileId,
      shareId,
      CHUNK,
      2,
      encryptedMetadata,
    );
    assert.equal(store.rows.get(fileId)?.encryptedMetadata, encryptedMetadata);
    assert.equal(store.rows.get(fileId)?.metadataScheme, 1);
    assert.equal(
      store.rows.get(fileId)?.name,
      `encrypted-file-${fileId.slice(0, 8)}`,
    );
    assert.equal(store.rows.get(fileId)?.contentScheme, 2);
    assert.equal(store.rows.get(fileId)?.size, "60");
    assert.deepEqual(readFileSync(filePath(shareId, fileId)), replacement);
  },
);

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dataDirectory, { recursive: true, force: true }));
