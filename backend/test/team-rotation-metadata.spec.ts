import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import {
  coveredRotationMetadata,
  readRotationMetadataUpdates,
} from "src/team/team-rotation-metadata.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Team metadata rotation");
const row = { id: "request-1", encryptedInfo: "old-ciphertext" };
const update = {
  kind: "REQUEST" as const,
  id: row.id,
  expectedEncryptedInfo: row.encryptedInfo,
  encryptedInfo: "new-ciphertext",
};

testCase("completion requires all current encrypted metadata", () => {
  assert.throws(
    () => coveredRotationMetadata([row], "REQUEST", []),
    ConflictException,
  );
  assert.throws(
    () =>
      coveredRotationMetadata([row], "REQUEST", [{ ...update, kind: "SHARE" }]),
    ConflictException,
  );
  assert.throws(
    () =>
      coveredRotationMetadata(
        [{ ...row, encryptedInfo: "concurrent-change" }],
        "REQUEST",
        [update],
      ),
    ConflictException,
  );
  assert.deepEqual(coveredRotationMetadata([row], "REQUEST", [update]), [
    update,
  ]);
  assert.deepEqual(coveredRotationMetadata([], "REQUEST", [update]), []);
  assert.deepEqual(readRotationMetadataUpdates(null), []);
  assert.deepEqual(readRotationMetadataUpdates(JSON.stringify([update])), [
    update,
  ]);
});
void run();
