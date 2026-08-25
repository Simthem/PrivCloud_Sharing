import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import {
  assertSafeFileName,
  getArchiveEntryName,
  normalizeUploadRelativePath,
} from "src/file/file-path.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("file paths");

const assertBadRequest = (fn: () => unknown) => {
  assert.throws(fn, BadRequestException);
};

testCase("accepts plain file names and logical folder paths", () => {
  assert.equal(assertSafeFileName("report.pdf"), "report.pdf");
  assert.equal(normalizeUploadRelativePath(undefined, "report.pdf"), undefined);
  assert.equal(normalizeUploadRelativePath("", "report.pdf"), undefined);
  assert.equal(normalizeUploadRelativePath("report.pdf", "report.pdf"), undefined);
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

void run();
