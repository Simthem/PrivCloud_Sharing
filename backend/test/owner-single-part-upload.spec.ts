import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { FileController } from "src/file/file.controller";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "Owner single-part direct upload",
);

// A file that fits in one part goes to storage like a larger one. Relayed
// through the API instead, its bytes were inspected by the WAF in front of
// it, and a challenge on the content stalled the whole share.
const small = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "mindmap.png",
  fileSize: 40_800,
  chunkSize: 6_000_000,
  initialChunkSize: 6_000_000,
  totalChunks: 1,
  encryptionChunkSize: 1_000_000,
};
const request = { user: { id: "owner", isAdmin: false } } as never;

function fixture() {
  const calls: string[] = [];
  const controller = new FileController(
    {
      initializeMultipartUpload: async () => {
        calls.push("init");
        return { uploadTransport: "direct-s3" };
      },
      authorizeMultipartPartsUpload: async () => {
        calls.push("parts");
        return {};
      },
      authorizeMultipartPartUpload: async () => {
        calls.push("part");
        return {};
      },
      completeMultipartUpload: async () => {
        calls.push("complete");
        return { uploadComplete: true };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, calls };
}

testCase(
  "a small file is initialized, signed and completed as one part",
  async () => {
    const { controller, calls } = fixture();
    await controller.initializeMultipartUpload(small, "own-share", request);
    await controller.authorizeMultipartPartsUpload(
      { ...small, parts: [{ chunkIndex: 0, contentLength: 40_828 }] },
      "own-share",
      request,
    );
    await controller.authorizeMultipartPartUpload(
      { ...small, chunkIndex: 0, contentLength: 40_828 },
      "own-share",
      request,
    );
    await controller.completeMultipartUpload(small, "own-share", request);
    assert.deepEqual(calls, ["init", "parts", "part", "complete"]);
  },
);

testCase(
  "one part never covers more than a chunk or a smaller first part",
  async () => {
    const { controller, calls } = fixture();
    for (const layout of [
      { ...small, fileSize: 6_000_001 },
      { ...small, initialChunkSize: 5_242_880 },
      { ...small, fileSize: 0 },
    ]) {
      await assert.rejects(
        controller.initializeMultipartUpload(layout, "own-share", request),
        BadRequestException,
      );
    }
    assert.deepEqual(calls, []);
  },
);

void run();
