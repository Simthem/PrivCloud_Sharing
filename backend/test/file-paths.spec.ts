import "reflect-metadata";
import assert from "node:assert/strict";
import path from "node:path";
import { BadRequestException } from "@nestjs/common";
import {
  assertSafeFileName,
  assertSafeStorageKey,
  getArchiveEntryName,
  normalizeUploadRelativePath,
  resolveStoragePath,
} from "src/file/file-path.util";
import { LocalFileService } from "src/file/local.service";
import { SafeIdPipe } from "src/share/pipe/safeId.pipe";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("file paths");

const assertBadRequest = (fn: () => unknown) => {
  assert.throws(fn, BadRequestException);
};

testCase("accepts plain file names and logical folder paths", () => {
  assert.equal(assertSafeFileName("report.pdf"), "report.pdf");
  assert.equal(normalizeUploadRelativePath(undefined, "report.pdf"), undefined);
  assert.equal(normalizeUploadRelativePath("", "report.pdf"), undefined);
  assert.equal(
    normalizeUploadRelativePath("report.pdf", "report.pdf"),
    undefined,
  );
  assert.equal(
    normalizeUploadRelativePath("client-a/contracts/report.pdf", "report.pdf"),
    "client-a/contracts/report.pdf",
  );
});

testCase("rejects unsafe file names and relative paths", () => {
  for (const name of [
    "",
    "../report.pdf",
    "folder/report.pdf",
    "folder\\report.pdf",
    "report..pdf",
    "report\0.pdf",
    "x".repeat(256),
  ]) {
    assertBadRequest(() => assertSafeFileName(name));
  }

  for (const path of [
    "../report.pdf",
    "/client/report.pdf",
    "C:/client/report.pdf",
    "client/../report.pdf",
    "client//report.pdf",
    "client/./report.pdf",
    "client/report..pdf",
    "client/report\0.pdf",
    "client/report.pdf/extra",
  ]) {
    assertBadRequest(() => normalizeUploadRelativePath(path, "report.pdf"));
  }
});

testCase("uses validated relative paths as archive entries", () => {
  assert.equal(
    getArchiveEntryName({
      name: "report.pdf",
      relativePath: "client-a/contracts/report.pdf",
    }),
    "client-a/contracts/report.pdf",
  );
  assert.equal(
    getArchiveEntryName({ name: "report.pdf", relativePath: null }),
    "report.pdf",
  );
  assertBadRequest(() =>
    getArchiveEntryName({
      name: "report.pdf",
      relativePath: "../report.pdf",
    }),
  );
});

testCase("accepts only scalar allow-listed route identifiers", () => {
  const pipe = new SafeIdPipe();
  assert.equal(pipe.transform("share_A-123", {} as never), "share_A-123");

  for (const value of [
    "../share",
    "share/name",
    "share.name",
    "share\0name",
    "équipe",
    ["share", "admin"],
    null,
  ]) {
    assertBadRequest(() => pipe.transform(value as never, {} as never));
  }
});

testCase("keeps every resolved local-storage path below its share root", () => {
  const service = Object.create(LocalFileService.prototype) as {
    resolveSharePath: (shareId: string, ...segments: string[]) => string;
  };
  const resolved = service.resolveSharePath(
    "share_A-123",
    "7352aeee-e01b-4dcc-a812-90d9e1647bed.tmp-chunk",
  );
  assert.match(
    resolved,
    /[/\\]share_A-123[/\\]7352aeee-e01b-4dcc-a812-90d9e1647bed\.tmp-chunk$/u,
  );

  for (const [shareId, child] of [
    ["../share", "file"],
    ["share", "../file"],
    ["share", "/absolute"],
    ["share", "file\\escape"],
    ["share", "file..tmp"],
    ["share", "équipe"],
  ] as Array<[string, string]>) {
    assertBadRequest(() => service.resolveSharePath(shareId, child));
  }
});

testCase(
  "confines signing object keys below the configured storage root",
  () => {
    const safeKey = "signed/7352aeee-e01b-4dcc-a812-90d9e1647bed/report.pdf";
    const storageRoot = path.resolve("test-storage");
    assert.equal(assertSafeStorageKey(safeKey), safeKey);
    assert.equal(
      resolveStoragePath(storageRoot, safeKey),
      path.join(
        storageRoot,
        "signed",
        "7352aeee-e01b-4dcc-a812-90d9e1647bed",
        "report.pdf",
      ),
    );

    for (const key of [
      "../secret",
      "signed/../../secret",
      "/absolute/file",
      "signed\\..\\secret",
      "signed//file.pdf",
      "signed/file\0.pdf",
    ]) {
      assertBadRequest(() => assertSafeStorageKey(key));
      assertBadRequest(() => resolveStoragePath(storageRoot, key));
    }
  },
);

void run();
