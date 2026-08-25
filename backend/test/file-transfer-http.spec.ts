import "reflect-metadata";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  BadRequestException,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common";
import { hours, minutes } from "@nestjs/throttler";
import {
  isProbeRequest,
  PROBE_MAX_BODY_BYTES,
  ProbeValidationResult,
  validateProbeBody,
  validateProbeContentLength,
} from "src/probe/probe-validation.util";
import {
  FileController,
  getMultipartPartPayloadLength,
  parseSingleByteRange,
} from "src/file/file.controller";
import { FileService } from "src/file/file.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("file transfer HTTP");

const getProbeErrorStatus = (
  result: ProbeValidationResult,
): number | undefined => (result.ok === false ? result.statusCode : undefined);

type FileGetCall = [
  shareId: string,
  fileId: string,
  range: { start: number; end: number } | undefined,
  storageProvider: string | undefined,
];

type MockResponse = {
  headers: Record<string, unknown>;
  statusCode: number;
  ended: boolean;
  status: (code: number) => MockResponse;
  set: (headers: Record<string, unknown>) => MockResponse;
  end: () => MockResponse;
};

const createMockResponse = (): MockResponse => {
  const response: MockResponse = {
    headers: {},
    statusCode: 200,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return response;
};

const createControllerHarness = (
  options: {
    range?: string;
    fileExists?: boolean;
    fileSize?: string;
  } = {},
) => {
  const calls: FileGetCall[] = [];
  const fileSize = options.fileSize ?? "1000";
  const fileService = {
    get: async (...args: FileGetCall) => {
      calls.push(args);
      return {
        metaData: {
          id: "file-1",
          name: "document.bin",
          size: fileSize,
          createdAt: new Date(0),
          mimeType: "application/octet-stream",
          shareId: "share-1",
          encryptionChunkSize: 1_000_000,
        },
        file: Readable.from([Buffer.from("payload")]),
      };
    },
  };
  const prisma = {
    file: {
      findFirst: async () =>
        options.fileExists === false
          ? null
          : {
              name: "document.bin",
              size: fileSize,
              encryptionChunkSize: 1_000_000,
            },
    },
    teamFolder: { findUnique: async () => null },
    teamAccessLog: { create: async () => undefined },
  };
  const controller = new FileController(
    fileService as never,
    { onDownload: async () => undefined } as never,
    prisma as never,
    {} as never,
    {} as never,
  );
  const request = {
    headers: options.range ? { range: options.range } : {},
    authorizedShare: {
      storageProvider: "S3",
      teamFolderId: null,
    },
  };
  const response = createMockResponse();

  return { calls, controller, request, response };
};

testCase("parses closed, open-ended and suffix byte ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=100-199", 1000), {
    start: 100,
    end: 199,
  });
  assert.deepEqual(parseSingleByteRange("bytes=900-", 1000), {
    start: 900,
    end: 999,
  });
  assert.deepEqual(parseSingleByteRange("bytes=-100", 1000), {
    start: 900,
    end: 999,
  });
  assert.deepEqual(parseSingleByteRange("bytes=-2000", 1000), {
    start: 0,
    end: 999,
  });
  assert.deepEqual(parseSingleByteRange("bytes=0-5000", 1000), {
    start: 0,
    end: 999,
  });
});

testCase("rejects malformed, multiple and unsatisfiable byte ranges", () => {
  for (const value of [
    "bytes=",
    "bytes=-",
    "bytes=-0",
    "bytes=1000-",
    "bytes=500-499",
    "bytes=0-1,4-5",
    "items=0-1",
    "bytes=1.5-2",
  ]) {
    assert.equal(parseSingleByteRange(value, 1000), undefined, value);
  }
  assert.equal(parseSingleByteRange("bytes=0-1", 0), undefined);
});

testCase(
  "validates and forwards the multipart control-plane layout",
  async () => {
    const calls: unknown[][] = [];
    const controller = new FileController(
      {
        initializeMultipartUpload: async (...args: unknown[]) => {
          calls.push(args);
          return {
            id: "11111111-1111-4111-8111-111111111111",
            initialized: true,
          };
        },
        authorizeMultipartPartUpload: async (...args: unknown[]) => {
          calls.push(args);
          return {
            id: "11111111-1111-4111-8111-111111111111",
            url: "https://s3.example.test/signed",
          };
        },
        authorizeMultipartPartsUpload: async (...args: unknown[]) => {
          calls.push(args);
          return {
            id: "11111111-1111-4111-8111-111111111111",
            parts: [],
          };
        },
        completeMultipartUpload: async (...args: unknown[]) => {
          calls.push(args);
          return {
            id: "11111111-1111-4111-8111-111111111111",
            uploadComplete: true,
          };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const body = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "large.bin",
      relativePath: "folder/large.bin",
      totalChunks: 3,
      fileSize: 116_000_000,
      chunkSize: 50_000_000,
      initialChunkSize: 16_000_000,
      encryptionChunkSize: 1_000_000,
    };
    const request = { user: { id: "user-1" } };

    await controller.initializeMultipartUpload(
      body,
      "share-1",
      request as never,
    );
    assert.deepEqual(calls, [[body, "share-1"]]);
    await controller.authorizeMultipartPartUpload(
      {
        ...body,
        chunkIndex: 1,
        contentLength: 50_001_400,
      },
      "share-1",
      request as never,
    );
    await controller.authorizeMultipartPartsUpload(
      {
        ...body,
        parts: [
          { chunkIndex: 0, contentLength: 16_000_448 },
          { chunkIndex: 2, contentLength: 50_001_400 },
        ],
      },
      "share-1",
      request as never,
    );
    await controller.completeMultipartUpload(body, "share-1", request as never);
    assert.deepEqual(calls, [
      [body, "share-1"],
      [body, "share-1", 1, 50_001_400],
      [
        body,
        "share-1",
        [
          { partIndex: 0, contentLength: 16_000_448 },
          { partIndex: 2, contentLength: 50_001_400 },
        ],
      ],
      [body, "share-1"],
    ]);

    await assert.rejects(
      controller.initializeMultipartUpload(
        { ...body, totalChunks: 2 },
        "share-1",
        request as never,
      ),
      BadRequestException,
    );
    await assert.rejects(
      controller.initializeMultipartUpload(
        { ...body, encryptionChunkSize: 3_000_000 },
        "share-1",
        request as never,
      ),
      BadRequestException,
    );
    await assert.rejects(
      controller.authorizeMultipartPartUpload(
        {
          ...body,
          chunkIndex: 1,
          contentLength: 50_000_000,
        },
        "share-1",
        request as never,
      ),
      BadRequestException,
    );
    assert.equal(calls.length, 4);
  },
);

testCase(
  "keeps direct S3 authorization on the independent direct fair-share window",
  async () => {
    const allocationCalls: unknown[][] = [];
    const s3FileService = {
      createMultipartPartUploadUrls: async () => [
        {
          url: "https://s3.example.test/signed",
          partNumber: 2,
          contentLength: 50_000_000,
          expiresInSeconds: 300,
        },
      ],
      getBrowserDirectUploadPolicy: () => ({
        enabled: true,
        expiresInSeconds: 300,
        maxConcurrency: 16,
      }),
      getBrowserDirectUploadAllocation: (...args: unknown[]) => {
        allocationCalls.push(args);
        return {
          recommendedSlots: 4,
          targetSlots: 16,
          activeSlots: 0,
          activeFlows: 4,
          queuedRequests: 0,
          fairShare: 4,
          memoryPressure: 0,
          cpuPressure: 0,
          eventLoopLagMs: 0,
          pressureSamples: 0,
        };
      },
      getUploadAllocation: () => ({
        recommendedSlots: 1,
        targetSlots: 6,
      }),
    };
    const service = new FileService(
      {
        share: {
          findUnique: async () => ({
            storageProvider: "S3",
            uploadLocked: false,
          }),
        },
      } as never,
      {} as never,
      s3FileService as never,
      {} as never,
    );

    const result = await service.authorizeMultipartPartUpload(
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "large.bin",
        totalChunks: 100,
        fileSize: 5_000_000_000,
        chunkSize: 50_000_000,
        initialChunkSize: 32_000_000,
      },
      "share-1",
      1,
      50_000_000,
    );

    assert.deepEqual(allocationCalls, [
      ["share-1", "11111111-1111-4111-8111-111111111111"],
    ]);
    assert.equal(result.uploadConcurrency, 4);
    assert.equal(result.uploadGlobalConcurrency, 16);
    assert.equal(result.uploadActiveFlows, 4);
    assert.equal(result.uploadWindowMode, "browser-origin-pool");
    assert.equal(result.directUpload.enabled, true);
  },
);

testCase("derives exact signed multipart lengths including E2E overhead", () => {
  const request = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "large.bin",
    totalChunks: 3,
    fileSize: 111_000_000,
    chunkSize: 50_000_000,
    initialChunkSize: 32_000_000,
    encryptionChunkSize: 1_000_000,
  };
  assert.equal(getMultipartPartPayloadLength(request, 0), 32_000_896);
  assert.equal(getMultipartPartPayloadLength(request, 1), 50_001_400);
  assert.equal(getMultipartPartPayloadLength(request, 2), 29_000_812);
  assert.throws(
    () => getMultipartPartPayloadLength(request, 3),
    BadRequestException,
  );
});

testCase(
  "authorizes a direct download without opening the Nest data stream",
  async () => {
    const calls: unknown[][] = [];
    let notifications = 0;
    const controller = new FileController(
      {
        authorizeBrowserDownload: async (...args: unknown[]) => {
          calls.push(args);
          return {
            direct: true,
            url: "https://objects.example.test/signed",
            fileName: "large.bin",
            size: 50_000_000,
            encryptionChunkSize: 1_000_000,
            forceDownload: true,
          };
        },
      } as never,
      {
        onDownload: async () => {
          notifications++;
        },
      } as never,
      {
        teamFolder: { findUnique: async () => null },
        teamAccessLog: { create: async () => undefined },
      } as never,
      {} as never,
      {} as never,
    );
    const request = {
      authorizedShare: {
        id: "share-1",
        storageProvider: "S3",
        teamFolderId: null,
      },
      user: { id: "user-1" },
    };
    const response = createMockResponse();

    const result = await controller.authorizeDirectDownload(
      request as never,
      response as never,
      "share-1",
      "11111111-1111-4111-8111-111111111111",
      "true",
    );
    await Promise.resolve();

    assert.equal(result.direct, true);
    assert.deepEqual(calls, [
      [
        "share-1",
        "11111111-1111-4111-8111-111111111111",
        "S3",
        true,
      ],
    ]);
    assert.equal(notifications, 1);
    assert.match(String(response.headers["Cache-Control"]), /no-store/);
  },
);

testCase(
  "advertises bounded direct ranges under the public memory ceiling",
  async () => {
    const s3FileService = {
      getBrowserDirectDownloadPolicy: () => ({
        enabled: true,
        expiresInSeconds: 900,
        maxConcurrency: 24,
        partBytes: 32 * 1024 * 1024,
        thresholdBytes: 64 * 1024 * 1024,
        maxBufferBytes: 128 * 1024 * 1024,
      }),
      createBrowserDownloadUrl: async () => ({
        url: "https://objects.example.test/signed",
        candidates: Array.from({ length: 4 }, (_, index) => ({
          url: `https://objects-${index}.example.test/signed`,
          origin: `https://objects-${index}.example.test`,
          addressingMode: "path",
        })),
        expiresInSeconds: 900,
      }),
    };
    const service = new FileService(
      {
        file: {
          findFirst: async () => ({
            name: "large.bin",
            size: "5000000000",
            encryptionChunkSize: 1_000_000,
            share: {
              teamFolderId: null,
            },
          }),
        },
      } as never,
      {} as never,
      s3FileService as never,
      {} as never,
    );

    const result = await service.authorizeBrowserDownload(
      "share-1",
      "11111111-1111-4111-8111-111111111111",
      "S3",
      true,
    );
    assert.equal(result.direct, true);
    assert.equal(result.directDownloadConcurrency, 24);
    assert.equal(result.directDownloadPartBytes, 5_592_405);
    assert.equal(result.directDownloadThresholdBytes, 64 * 1024 * 1024);
    assert.equal(result.directDownloadMaxBufferBytes, 128 * 1024 * 1024);
  },
);

testCase(
  "opens exactly one full object stream and sets no-transform",
  async () => {
    const { calls, controller, request, response } = createControllerHarness();

    const result = await controller.getFile(
      request as never,
      response as never,
      "share-1",
      "file-1",
      "true",
    );

    assert.ok(result instanceof StreamableFile);
    assert.deepEqual(calls, [["share-1", "file-1", undefined, "S3"]]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["Content-Length"], 1000);
    assert.match(String(response.headers["Cache-Control"]), /no-transform/);
  },
);

testCase(
  "opens exactly one ranged object stream for each range form",
  async () => {
    const cases = [
      ["bytes=100-199", { start: 100, end: 199 }],
      ["bytes=900-", { start: 900, end: 999 }],
      ["bytes=-100", { start: 900, end: 999 }],
    ] as const;

    for (const [rangeHeader, expectedRange] of cases) {
      const { calls, controller, request, response } = createControllerHarness({
        range: rangeHeader,
      });

      const result = await controller.getFile(
        request as never,
        response as never,
        "share-1",
        "file-1",
        "true",
      );

      assert.ok(result instanceof StreamableFile);
      assert.deepEqual(calls, [["share-1", "file-1", expectedRange, "S3"]]);
      assert.equal(response.statusCode, 206);
      assert.equal(
        response.headers["Content-Range"],
        `bytes ${expectedRange.start}-${expectedRange.end}/1000`,
      );
      assert.equal(
        response.headers["Content-Length"],
        expectedRange.end - expectedRange.start + 1,
      );
      assert.match(String(response.headers["Cache-Control"]), /no-transform/);
    }
  },
);

testCase(
  "returns 416 without opening an object for invalid ranges",
  async () => {
    for (const rangeHeader of [
      "bytes=1000-",
      "bytes=500-499",
      "bytes=0-1,4-5",
      "bytes=-0",
    ]) {
      const { calls, controller, request, response } = createControllerHarness({
        range: rangeHeader,
      });

      const result = await controller.getFile(
        request as never,
        response as never,
        "share-1",
        "file-1",
        "true",
      );

      assert.equal(result, undefined);
      assert.deepEqual(calls, []);
      assert.equal(response.statusCode, 416);
      assert.equal(response.headers["Content-Range"], "bytes */1000");
      assert.equal(response.ended, true);
    }
  },
);

testCase("returns metadata 404 without opening an object", async () => {
  const { calls, controller, request, response } = createControllerHarness({
    fileExists: false,
  });

  await assert.rejects(
    controller.getFile(
      request as never,
      response as never,
      "share-1",
      "file-1",
      "true",
    ),
    NotFoundException,
  );
  assert.deepEqual(calls, []);
});

testCase("validates probe length before parsing and body after parsing", () => {
  assert.deepEqual(validateProbeContentLength(String(PROBE_MAX_BODY_BYTES)), {
    ok: true,
    length: PROBE_MAX_BODY_BYTES,
  });
  assert.equal(getProbeErrorStatus(validateProbeContentLength(undefined)), 411);
  assert.equal(getProbeErrorStatus(validateProbeContentLength("invalid")), 400);
  assert.equal(
    getProbeErrorStatus(
      validateProbeContentLength(String(PROBE_MAX_BODY_BYTES + 1)),
    ),
    413,
  );

  const body = Buffer.alloc(256_000);
  assert.deepEqual(
    validateProbeBody(body, body.length, "application/octet-stream"),
    { ok: true, length: body.length },
  );
  assert.equal(
    getProbeErrorStatus(
      validateProbeBody(body, body.length + 1, "application/octet-stream"),
    ),
    400,
  );
  assert.equal(
    getProbeErrorStatus(
      validateProbeBody(body, body.length, "application/json"),
    ),
    415,
  );
});

testCase("matches only the exact POST probe endpoint", () => {
  assert.equal(
    isProbeRequest({
      method: "POST",
      originalUrl: "/api/probe?cacheBust=1",
    }),
    true,
  );
  assert.equal(
    isProbeRequest({ method: "GET", originalUrl: "/api/probe" }),
    false,
  );
  assert.equal(
    isProbeRequest({ method: "POST", originalUrl: "/api/probe/extra" }),
    false,
  );
});

testCase("uses millisecond throttle windows on transfer endpoints", () => {
  const metadata = (method: (...args: never[]) => unknown, key: string) =>
    Reflect.getMetadata(key, method);

  assert.equal(
    metadata(FileController.prototype.create, "THROTTLER:LIMITdefault"),
    10_000,
  );
  assert.equal(
    metadata(FileController.prototype.create, "THROTTLER:TTLdefault"),
    hours(1),
  );
  assert.equal(
    metadata(FileController.prototype.createViaBridge, "THROTTLER:TTLdefault"),
    hours(1),
  );
  assert.equal(
    metadata(FileController.prototype.getZip, "THROTTLER:TTLdefault"),
    minutes(1),
  );
  assert.equal(
    metadata(FileController.prototype.remove, "THROTTLER:TTLdefault"),
    minutes(1),
  );
  assert.equal(
    metadata(FileController.prototype.reencrypt, "THROTTLER:LIMITdefault"),
    10_000,
  );
  assert.equal(
    metadata(FileController.prototype.reencrypt, "THROTTLER:TTLdefault"),
    hours(1),
  );
});

void run();
