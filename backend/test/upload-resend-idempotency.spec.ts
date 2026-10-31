import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { FileService } from "src/file/file.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Upload resent after completion");

const FILE_ID = "6f1d2c7e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";

/**
 * A client that lost the answer to a finished file sends it again. Storage
 * must not be touched: the resend used to rewrite the object, then fail on the
 * existing record with a 500 retried until the file was given up.
 */
function serviceWith(stored: { shareId: string; size: string } | null) {
  const writes: unknown[][] = [];
  const share = {
    id: "share-1",
    uploadLocked: false,
    isE2EEncrypted: false,
    storageProvider: "LOCAL",
    fileMetadataScheme: null,
    creatorId: null,
    reverseShare: null,
    files: [],
  };
  const service = new FileService(
    {
      share: { findUnique: async () => share },
      file: { findUnique: async () => stored },
    } as never,
    {
      create: async (...args: unknown[]) => {
        writes.push(args);
        return { id: FILE_ID };
      },
    } as never,
    {} as never,
    {
      get: (key: string) =>
        key === "share.chunkSize" ? 10_000_000 : undefined,
      isContentV2WritesEnabled: async () => false,
    } as never,
  );
  (service as unknown as { logger: object }).logger = {
    warn: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  };
  return { service, writes };
}

const send = (service: FileService, body: Buffer, total = 1) =>
  service.create(
    body,
    { index: total - 1, total },
    { id: FILE_ID, name: "file.bin" },
    "share-1",
    10_000_000,
  );

testCase("a new file still reaches storage", async () => {
  const { service, writes } = serviceWith(null);
  await send(service, Buffer.alloc(10));
  assert.equal(writes.length, 1);
});

testCase("the same file sent again is answered as stored, unwritten", async () => {
  const { service, writes } = serviceWith({ shareId: "share-1", size: "10" });
  const result = await send(service, Buffer.alloc(10));
  assert.equal(writes.length, 0);
  assert.equal((result as { alreadyCompleted?: boolean }).alreadyCompleted, true);
  assert.equal(result.id, FILE_ID);
});

testCase("the last part of a stored chunked file is answered as stored", async () => {
  const { service, writes } = serviceWith({ shareId: "share-1", size: "25" });
  await send(service, Buffer.alloc(5), 3);
  assert.equal(writes.length, 0);
});

testCase("different bytes under a stored ID are refused, unwritten", async () => {
  const { service, writes } = serviceWith({ shareId: "share-1", size: "10" });
  await assert.rejects(send(service, Buffer.alloc(11)), ConflictException);
  assert.equal(writes.length, 0);
});

testCase("an ID stored in another share is refused, unwritten", async () => {
  const { service, writes } = serviceWith({ shareId: "share-2", size: "10" });
  await assert.rejects(send(service, Buffer.alloc(10)), BadRequestException);
  assert.equal(writes.length, 0);
});

void run();
