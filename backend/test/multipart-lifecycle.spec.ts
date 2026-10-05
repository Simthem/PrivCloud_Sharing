import "reflect-metadata";
import assert from "node:assert/strict";
import { S3FileService } from "src/file/s3.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("multipart lifecycle");
const fileId = "b53173ae-a482-4d17-b952-246df7317c8a";
const shareId = "own-share";
const objectKey = `prefix/${shareId}/${fileId}`;
const plainBytes = 361_700_000_000;
const storedBytes = plainBytes + Math.ceil(plainBytes / 1_000_000) * 28;
const totalParts = 1 + Math.ceil((plainBytes - 32_000_000) / 50_000_000);

function serviceFixture() {
  const messages: string[] = [],
    commands: string[] = [];
  const service: any = Object.create(S3FileService.prototype);
  service.multipartUploads = new Map();
  service.multipartInitializations = new Map();
  service.config = {
    get: (name: string) =>
      name === "s3.bucketName" ? "fixture-bucket" : "prefix",
  };
  service.logger = Object.fromEntries(
    ["log", "warn", "error", "debug"].map((name) => [
      name,
      (message: string) => messages.push(message),
    ]),
  );
  const released: string[] = [];
  service.getAdaptiveUploadScheduler = () => ({
    registerFlow() {},
    touchFlow() {},
    unregisterFlow: (id: string) => released.push(id),
  });
  service.getS3Instance = () => ({
    send: async (command: any) => {
      commands.push(command.constructor.name);
      return {};
    },
  });
  return { service, messages, commands, released };
}

testCase(
  "a WAF pause longer than one hour preserves the unfinished share's multipart state",
  async () => {
    const f = serviceFixture();
    let reads = 0;
    f.service.prisma = {
      share: {
        findUnique: async () => {
          reads++;
          return {
            uploadLocked: false,
            expiration: new Date(Date.now() + 86400_000),
          };
        },
      },
    };
    for (const id of [fileId, "second-file", "third-file"]) {
      f.service.multipartUploads.set(`upload:${shareId}:${id}`, {
        uploadId: `secret-upload-${id}`,
        shareId,
        flowId: id,
        parts: [],
        lastActivity: Date.now() - 2 * 3600_000,
      });
    }
    await f.service.cleanupAbandonedUploads();
    assert.equal(f.service.multipartUploads.size, 3);
    assert.equal(reads, 1);
    assert.deepEqual(f.commands, []);
    assert.deepEqual(f.released, []);
  },
);

testCase(
  "database outages preserve state, while expired and completed shares release only the cache",
  async () => {
    for (const state of ["offline", "expired", "complete", "absent"]) {
      const f = serviceFixture();
      f.service.multipartUploads.set(`upload:${shareId}:${fileId}`, {
        uploadId: "secret-upload",
        shareId,
        flowId: fileId,
        parts: [],
        lastActivity: Date.now() - 2 * 3600_000,
      });
      f.service.prisma = {
        share: {
          findUnique: async () => {
            if (state === "offline") throw new Error("database unavailable");
            if (state === "absent") return null;
            return {
              uploadLocked: state === "complete",
              expiration: new Date(
                state === "expired" ? 1 : Date.now() + 86400_000,
              ),
            };
          },
        },
      };
      await f.service.cleanupAbandonedUploads();
      assert.equal(
        f.service.multipartUploads.size,
        state === "offline" ? 1 : 0,
      );
      assert.deepEqual(f.commands, []);
      assert.ok(
        f.messages.every(
          (message) =>
            !message.includes(shareId) && !message.includes("secret-upload"),
        ),
      );
    }
  },
);

testCase(
  "361.7 GB recovers paginated S3 state and persists after lost completion and database responses",
  async () => {
    const f = serviceFixture();
    let completed = false,
      saved: any,
      failDatabaseOnce = true,
      completionCalls = 0;
    const listPages: number[] = [];
    const tx = {
      $queryRaw: async () => [],
      share: { findUnique: async () => ({ files: [] }) },
      file: {
        findUnique: async () => (saved ? { shareId } : null),
        create: async ({ data }: any) => {
          if (failDatabaseOnce) {
            failDatabaseOnce = false;
            throw new Error("database unavailable");
          }
          saved = data;
          return saved;
        },
      },
    };
    f.service.prisma = {
      $transaction: async (operation: any) => operation(tx),
    };
    f.service.getS3Instance = () => ({
      send: async (command: any) => {
        const name = command.constructor.name;
        f.commands.push(name);
        if (name === "ListMultipartUploadsCommand") {
          assert.equal(command.input.Prefix, objectKey);
          if (!command.input.KeyMarker)
            return {
              Uploads: [{ Key: `${objectKey}-other`, UploadId: "foreign" }],
              IsTruncated: true,
              NextKeyMarker: objectKey,
              NextUploadIdMarker: "marker",
            };
          assert.equal(command.input.UploadIdMarker, "marker");
          return {
            Uploads: [
              {
                Key: objectKey,
                UploadId: "saved-upload",
                Initiated: new Date(0),
              },
            ],
          };
        }
        if (name === "ListPartsCommand") {
          if (completed)
            throw Object.assign(new Error("Gone"), { name: "NoSuchUpload" });
          const offset = Number(command.input.PartNumberMarker || 0);
          listPages.push(offset);
          const end = Math.min(totalParts, offset + 1000);
          return {
            Parts: Array.from({ length: end - offset }, (_, i) => {
              const part = offset + i;
              const start =
                part === 0 ? 0 : 32_000_000 + (part - 1) * 50_000_000;
              const bytes = Math.min(
                part === 0 ? 32_000_000 : 50_000_000,
                plainBytes - start,
              );
              return {
                PartNumber: part + 1,
                ETag: `etag-${part}`,
                Size: bytes + Math.ceil(bytes / 1_000_000) * 28,
              };
            }),
            IsTruncated: end < totalParts,
            NextPartNumberMarker: String(end),
          };
        }
        if (name === "CompleteMultipartUploadCommand") {
          assert.equal(command.input.MultipartUpload.Parts.length, totalParts);
          completionCalls++;
          completed = true;
          throw new Error("completion response lost");
        }
        if (name === "HeadObjectCommand") {
          assert.ok(completed);
          return { ContentLength: storedBytes };
        }
        throw new Error(`Unexpected storage mutation: ${name}`);
      },
    });
    const initialized = await f.service.initializeMultipartUpload(
      { id: fileId, name: fileId },
      shareId,
      totalParts,
    );
    assert.equal(initialized.initialized, false);
    assert.equal(initialized.uploadedParts.length, totalParts);
    assert.equal(
      initialized.uploadedParts.reduce(
        (sum: number, part: any) => sum + part.size,
        0,
      ),
      storedBytes,
    );
    assert.ok(listPages.includes(7000));
    const finish = () =>
      f.service.completeMultipartUpload(
        {
          id: fileId,
          name: fileId,
          metadataScheme: 1,
          encryptedMetadata: "fixture-ciphertext",
        },
        shareId,
        totalParts,
        { isE2EEncrypted: true },
        Number.MAX_SAFE_INTEGER,
        1_000_000,
      );
    await assert.rejects(finish, (error: any) => error.getStatus() === 503);
    assert.equal(saved, undefined);
    const result = await finish();
    assert.equal(result.uploadComplete, true);
    assert.equal(saved.size, String(storedBytes));
    assert.equal(saved.encryptionChunkSize, 1_000_000);
    assert.equal(saved.encryptedMetadata, "fixture-ciphertext");
    assert.equal(completionCalls, 1);
    const previousCalls = f.commands.length;
    assert.equal((await finish()).alreadyCompleted, true);
    assert.equal(f.commands.length, previousCalls);
    assert.equal(f.service.multipartUploads.size, 0);
  },
);

void run();
