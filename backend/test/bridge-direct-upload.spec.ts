import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { FileController } from "src/file/file.controller";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "Companion direct multipart authorization",
);
const layout = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "fixture.bin",
  fileSize: 13_000_000,
  chunkSize: 6_000_000,
  initialChunkSize: 6_000_000,
  totalChunks: 3,
  encryptionChunkSize: 6_000_000,
};
function fixture() {
  const tokens: string[] = [],
    calls: string[] = [];
  const controller = new FileController(
    {
      initializeMultipartUpload: async () => {
        calls.push("init");
        return { uploadTransport: "direct-s3" };
      },
      authorizeMultipartPartsUpload: async (
        _request: unknown,
        _share: string,
        parts: unknown,
      ) => {
        calls.push("parts");
        return parts;
      },
      completeMultipartUpload: async () => {
        calls.push("complete");
        return { uploadComplete: true };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      validateToken: async (share: string, token: string) => {
        tokens.push(share);
        if (share !== "own-share" || token !== "pcbu_fixture")
          throw new UnauthorizedException();
      },
    } as never,
  );
  return { controller, tokens, calls };
}

testCase(
  "every direct operation checks the token's share before touching storage",
  async () => {
    const { controller, tokens, calls } = fixture();
    await controller.initializeMultipartViaBridge(
      layout,
      "own-share",
      "Bearer pcbu_fixture",
    );
    await controller.authorizeMultipartPartsViaBridge(
      { ...layout, parts: [{ chunkIndex: 0, contentLength: 6_000_028 }] },
      "own-share",
      "Bearer pcbu_fixture",
    );
    await controller.completeMultipartViaBridge(
      layout,
      "own-share",
      "Bearer pcbu_fixture",
    );
    assert.deepEqual(calls, ["init", "parts", "complete"]);
    assert.deepEqual(tokens, ["own-share", "own-share", "own-share"]);
    for (const method of [
      "initializeMultipartViaBridge",
      "authorizeMultipartPartsViaBridge",
      "completeMultipartViaBridge",
    ] as const) {
      await assert.rejects(
        controller[method](layout, "foreign-share", "Bearer pcbu_fixture"),
        UnauthorizedException,
      );
      await assert.rejects(
        controller[method](layout, "own-share", "Bearer revoked"),
        UnauthorizedException,
      );
    }
    assert.equal(calls.length, 3);
  },
);

testCase(
  "Companion keeps multipart record sizing and batch limits",
  async () => {
    const { controller, calls } = fixture();
    await assert.rejects(
      controller.initializeMultipartViaBridge(
        { ...layout, chunkSize: 200_000_001 },
        "own-share",
        "Bearer pcbu_fixture",
      ),
      BadRequestException,
    );
    for (const parts of [
      [{ chunkIndex: 0, contentLength: 6_000_000 }],
      [{ chunkIndex: 3, contentLength: 1_000_028 }],
      Array.from({ length: 33 }, () => ({
        chunkIndex: 0,
        contentLength: 6_000_028,
      })),
      [
        { chunkIndex: 0, contentLength: 6_000_028 },
        { chunkIndex: 0, contentLength: 6_000_028 },
      ],
    ])
      await assert.rejects(
        controller.authorizeMultipartPartsViaBridge(
          { ...layout, parts },
          "own-share",
          "Bearer pcbu_fixture",
        ),
        BadRequestException,
      );
    assert.deepEqual(calls, []);
  },
);

testCase("small files use one authorized final S3 part", async () => {
  const { controller, calls } = fixture();
  const small = { ...layout, fileSize: 19, totalChunks: 1 };
  await controller.initializeMultipartViaBridge(
    small,
    "own-share",
    "Bearer pcbu_fixture",
  );
  await controller.authorizeMultipartPartsViaBridge(
    { ...small, parts: [{ chunkIndex: 0, contentLength: 47 }] },
    "own-share",
    "Bearer pcbu_fixture",
  );
  await controller.completeMultipartViaBridge(
    small,
    "own-share",
    "Bearer pcbu_fixture",
  );
  assert.deepEqual(calls, ["init", "parts", "complete"]);
});

void run();
