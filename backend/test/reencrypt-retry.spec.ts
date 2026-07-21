import "reflect-metadata";
import assert from "node:assert/strict";
import { HttpException, HttpStatus } from "@nestjs/common";
import { FileService } from "src/file/file.service";
import { S3FileService } from "src/file/s3.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("re-encryption retry");

testCase("retains the file session while retrying a failed S3 chunk", async () => {
  const shareId = "share-1";
  const fileId = "7352aeee-e01b-4dcc-a812-90d9e1647bed";
  const sessionId = "e0bd2da3-7b02-41af-b888-33c965de43eb";
  let failMiddleChunk = true;
  const uploaded: number[] = [];

  const prisma = {
    share: {
      findUnique: async () => ({
        id: shareId,
        isE2EEncrypted: true,
        storageProvider: "S3",
      }),
    },
    file: {
      findUnique: async () => ({ id: fileId, shareId }),
    },
  };
  const s3 = {
    replace: async (
      _data: Buffer,
      chunk: { index: number; total: number },
    ) => {
      if (chunk.index === 1 && failMiddleChunk) {
        failMiddleChunk = false;
        throw new Error("temporary S3 failure");
      }
      uploaded.push(chunk.index);
    },
  };
  const service = new FileService(
    prisma as never,
    {} as never,
    s3 as never,
    {} as never,
  );
  (
    service as unknown as {
      logger: { error: () => void; warn: () => void };
    }
  ).logger = { error: () => undefined, warn: () => undefined };

  const replace = (index: number) =>
    service.replaceFileContent(
      Buffer.from([index]),
      { index, total: 3 },
      fileId,
      shareId,
      10_000_000,
      sessionId,
    );

  await replace(0);
  await assert.rejects(replace(1), /temporary S3 failure/);
  await replace(1);
  await replace(2);

  assert.deepEqual(uploaded, [0, 1, 2]);
  await assert.rejects(replace(1), /No re-encryption session found/);
});

testCase("retains S3 multipart parts after a transient part failure", async () => {
  const shareId = "share-1";
  const fileId = "7352aeee-e01b-4dcc-a812-90d9e1647bed";
  const reencryptKey = `reencrypt:${fileId}`;
  const multipart = {
    uploadId: "upload-1",
    parts: [{ ETag: "etag-1", PartNumber: 1 }],
    lastActivity: Date.now(),
    shareId,
  };
  const service = Object.create(S3FileService.prototype) as {
    multipartUploads: Record<string, typeof multipart>;
    config: { get: (_key: string) => string };
    getShareObjectKey: (_shareId: string, _fileId: string) => string;
    getS3Instance: () => { send: () => Promise<never> };
    acquireUploadSlot: () => Promise<boolean>;
    releaseUploadSlot: () => void;
    logger: { error: () => void; warn: () => void };
    replace: S3FileService["replace"];
  };
  service.multipartUploads = { [reencryptKey]: multipart };
  service.config = { get: () => "bucket" };
  service.getShareObjectKey = () => `${shareId}/${fileId}`;
  service.getS3Instance = () => ({
    send: async () => {
      throw new Error("temporary S3 timeout");
    },
  });
  service.acquireUploadSlot = async () => true;
  service.releaseUploadSlot = () => undefined;
  service.logger = { error: () => undefined, warn: () => undefined };

  await assert.rejects(
    service.replace(
      Buffer.alloc(6 * 1024 * 1024),
      { index: 1, total: 3 },
      fileId,
      shareId,
      10_000_000,
    ),
    (error: unknown) =>
      error instanceof HttpException &&
      error.getStatus() === HttpStatus.SERVICE_UNAVAILABLE,
  );
  assert.equal(service.multipartUploads[reencryptKey], multipart);
  assert.deepEqual(multipart.parts, [{ ETag: "etag-1", PartNumber: 1 }]);
});

void run();
