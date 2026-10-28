import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  assertContentV2FirstPart,
  assertUploadContentScheme,
  contentHeaderBytes,
  isContentV2Header,
  parseContentScheme,
} from "src/file/content-scheme.util";
import { ConfigService, withContentV2Default } from "src/config/config.service";
import { getMultipartPartPayloadLength } from "src/file/file.controller";
import { FileService } from "src/file/file.service";
import { getMaxUploadPayloadBytes } from "src/file/upload-limit.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("E2EE content scheme");

const FILE_ID = "6f1d2c7e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";

function v2Header(): Buffer {
  const header = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x43, 0x45, 0x32, 0x0d, 0x0a, 0x1a]).copy(header);
  header[8] = 2;
  header.writeUInt32BE(1_000_000, 10);
  header.fill(7, 14, 30);
  return header;
}

const refusedForV2 = (error: unknown) =>
  error instanceof ConflictException &&
  (error.getResponse() as { error?: string }).error ===
    "e2ee_content_v2_required";

/** FileService with a local storage stub that records what reached it. */
function serviceWith(options: { writes: boolean; e2e?: boolean }) {
  const stored: unknown[][] = [];
  const share = {
    id: "share-1",
    uploadLocked: false,
    isE2EEncrypted: options.e2e ?? true,
    storageProvider: "LOCAL",
    fileMetadataScheme: null,
    creatorId: null,
    reverseShare: null,
    files: [],
  };
  const service = new FileService(
    {
      share: { findUnique: async () => share },
      file: { findUnique: async () => null },
    } as never,
    {
      create: async (...args: unknown[]) => {
        stored.push(args);
        return { id: FILE_ID };
      },
    } as never,
    {} as never,
    {
      get: (key: string) =>
        key === "share.chunkSize" ? 10_000_000 : undefined,
      isContentV2WritesEnabled: async () => options.writes,
    } as never,
  );
  (service as unknown as { logger: object }).logger = {
    warn: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  };
  return { service, stored };
}

const upload = (
  service: FileService,
  body: Buffer,
  index: number,
  contentScheme?: 2,
  encryptionChunkSize = 1_000_000,
  id: string | null = FILE_ID,
) =>
  service.create(
    body,
    { index, total: 2 },
    { id: id ?? undefined, name: "file.bin", contentScheme },
    "share-1",
    10_000_000,
    encryptionChunkSize,
  );

testCase("the declared scheme is v1 when absent and only 2 otherwise", () => {
  assert.equal(parseContentScheme(undefined), undefined);
  assert.equal(parseContentScheme(""), undefined);
  assert.equal(parseContentScheme("2"), 2);
  assert.equal(parseContentScheme(2), 2);
  for (const value of ["1", "3", "v2", 1, true]) {
    assert.throws(() => parseContentScheme(value), BadRequestException);
  }
});

testCase("only the first part of a v2 file carries the 32-byte header", () => {
  assert.equal(contentHeaderBytes(2, 0), 32);
  assert.equal(contentHeaderBytes(2, 1), 0);
  assert.equal(contentHeaderBytes(undefined, 0), 0);
  assert.equal(
    getMaxUploadPayloadBytes(10_000_000, 10_000_000, 1_000_000),
    10_000_280,
  );
  assert.equal(
    getMaxUploadPayloadBytes(10_000_000, 10_000_000, 1_000_000, 32),
    10_000_312,
  );
  const request = {
    id: FILE_ID,
    name: "large.bin",
    totalChunks: 3,
    fileSize: 111_000_000,
    chunkSize: 50_000_000,
    initialChunkSize: 32_000_000,
    encryptionChunkSize: 1_000_000,
    contentScheme: 2 as const,
  };
  assert.equal(getMultipartPartPayloadLength(request, 0), 32_000_928);
  assert.equal(getMultipartPartPayloadLength(request, 1), 50_001_400);
  assert.equal(getMultipartPartPayloadLength(request, 2), 29_000_812);
});

testCase("a v2 header is recognised only with its fixed bytes", () => {
  assert.equal(isContentV2Header(v2Header()), true);
  for (const offset of [0, 7, 8, 9, 10, 13, 30, 31]) {
    const changed = v2Header();
    changed[offset] ^= 1;
    assert.equal(isContentV2Header(changed), false, `offset ${offset}`);
  }
  assert.equal(isContentV2Header(v2Header().subarray(0, 31)), false);
  assert.throws(
    () => assertContentV2FirstPart(2, 0, Buffer.alloc(60)),
    BadRequestException,
  );
  assertContentV2FirstPart(2, 1, Buffer.alloc(60));
  assertContentV2FirstPart(undefined, 0, Buffer.alloc(60));
});

testCase("v2 needs an E2E share, 1 MB records and a client file id", () => {
  const base = {
    isE2EEncrypted: true,
    scheme: 2 as const,
    v2WritesEnabled: false,
    encryptionChunkSize: 1_000_000,
    fileId: FILE_ID,
  };
  assertUploadContentScheme(base);
  assertUploadContentScheme({ ...base, v2WritesEnabled: true });
  assert.throws(
    () => assertUploadContentScheme({ ...base, isE2EEncrypted: false }),
    BadRequestException,
  );
  assert.throws(
    () =>
      assertUploadContentScheme({ ...base, encryptionChunkSize: 2_000_000 }),
    BadRequestException,
  );
  assert.throws(
    () => assertUploadContentScheme({ ...base, fileId: undefined }),
    BadRequestException,
  );
  assertUploadContentScheme({ ...base, scheme: undefined });
  assert.throws(
    () =>
      assertUploadContentScheme({
        ...base,
        scheme: undefined,
        v2WritesEnabled: true,
      }),
    refusedForV2,
  );
  assertUploadContentScheme({
    ...base,
    isE2EEncrypted: false,
    scheme: undefined,
    v2WritesEnabled: true,
  });
});

testCase(
  "with v2 writes on, a new v1 upload is refused before storage",
  async () => {
    const { service, stored } = serviceWith({ writes: true });
    await assert.rejects(
      upload(service, Buffer.alloc(1_000_028), 0),
      refusedForV2,
    );
    assert.equal(stored.length, 0);
    // An upload already under way keeps its format.
    await upload(service, Buffer.alloc(1_000_028), 1);
    assert.equal(stored.length, 1);
    // Uploads to shares without end-to-end encryption are unaffected.
    const plain = serviceWith({ writes: true, e2e: false });
    await plain.service.create(
      Buffer.alloc(10),
      { index: 0, total: 1 },
      { id: FILE_ID, name: "file.bin" },
      "share-1",
      10_000_000,
    );
    assert.equal(plain.stored.length, 1);
  },
);

testCase(
  "v2 is accepted whatever the switch, with a valid first part",
  async () => {
    for (const writes of [true, false]) {
      const { service, stored } = serviceWith({ writes });
      const body = Buffer.concat([v2Header(), Buffer.alloc(1_000_028)]);
      await upload(service, body, 0, 2);
      assert.equal(stored.length, 1);
      const file = stored[0][2] as { contentScheme?: number; id: string };
      assert.equal(file.contentScheme, 2);
      assert.equal(file.id, FILE_ID);
      await assert.rejects(
        upload(service, Buffer.alloc(1_000_060), 0, 2),
        BadRequestException,
      );
      await assert.rejects(
        upload(service, body, 0, 2, 2_000_000),
        BadRequestException,
      );
      await assert.rejects(
        upload(service, body, 0, 2, 1_000_000, null),
        BadRequestException,
      );
    }
  },
);

testCase(
  "a v1 multipart session is refused at initialisation while v2 writes are on",
  async () => {
    const { service } = serviceWith({ writes: true });
    const request = {
      id: FILE_ID,
      name: "large.bin",
      totalChunks: 3,
      fileSize: 111_000_000,
      chunkSize: 50_000_000,
      initialChunkSize: 32_000_000,
      encryptionChunkSize: 1_000_000,
    };
    await assert.rejects(
      service.initializeMultipartUpload(request, "share-1"),
      refusedForV2,
    );
    const accepted = await service.initializeMultipartUpload(
      { ...request, contentScheme: 2 },
      "share-1",
    );
    assert.equal(accepted.uploadTransport, "buffered");
  },
);

testCase(
  "the deployment default applies until an administrator saves a value",
  async () => {
    const row = (value: string | null) => ({
      category: "share",
      name: "contentV2Writes",
      defaultValue: "false",
      value,
    });
    const env = { E2EE_CONTENT_V2_WRITES: "true" } as NodeJS.ProcessEnv;
    assert.equal(withContentV2Default(row(null), env).defaultValue, "true");
    assert.equal(withContentV2Default(row("false"), env).value, "false");
    assert.equal(
      withContentV2Default(row(null), {
        E2EE_CONTENT_V2_WRITES: "yes",
      } as NodeJS.ProcessEnv).defaultValue,
      "false",
    );
    assert.equal(
      withContentV2Default({ ...row(null), name: "contentV2Floor" }, {
        E2EE_CONTENT_V2_FLOOR: "TRUE",
      } as NodeJS.ProcessEnv).defaultValue,
      "true",
    );
    assert.equal(
      withContentV2Default({ ...row(null), category: "email" }, env)
        .defaultValue,
      "false",
    );

    let stored: { value: string | null } = { value: null };
    const config = new ConfigService([], {
      config: {
        findUnique: async () => ({ ...row(null), ...stored }),
      },
    } as never);
    const previous = process.env.E2EE_CONTENT_V2_WRITES;
    try {
      delete process.env.E2EE_CONTENT_V2_WRITES;
      assert.equal(await config.isContentV2WritesEnabled(), false);
      process.env.E2EE_CONTENT_V2_WRITES = "true";
      assert.equal(await config.isContentV2WritesEnabled(), true);
      stored = { value: "false" };
      assert.equal(await config.isContentV2WritesEnabled(), false);
    } finally {
      if (previous === undefined) delete process.env.E2EE_CONTENT_V2_WRITES;
      else process.env.E2EE_CONTENT_V2_WRITES = previous;
    }
  },
);

void run();
