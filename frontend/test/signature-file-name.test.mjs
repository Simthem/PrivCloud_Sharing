import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { signatureFileOf } from "../src/utils/fileMetadata.util.ts";

const ID = "4b0e3c9a-6a43-4b5e-9a57-2c1d6f3b8e10";

test("an encrypted name is flagged so the request discloses it", () => {
  assert.deepEqual(
    signatureFileOf({ id: ID, name: "accord.pdf", metadataScheme: 1 }),
    { id: ID, name: "accord.pdf", encryptedName: true },
  );
  assert.deepEqual(
    signatureFileOf({ id: ID, name: "accord.pdf", metadataScheme: null }),
    { id: ID, name: "accord.pdf", encryptedName: false },
  );
  assert.equal(signatureFileOf({ id: ID }).name, ID);
});

test("every page opening the signature modal flags encrypted names", () => {
  for (const page of [
    "src/pages/account/shares.tsx",
    "src/pages/team/[id]/folder/[folderId].tsx",
  ]) {
    const source = fs.readFileSync(
      new URL(`../${page}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /signatureFileOf/, page);
    assert.doesNotMatch(
      source,
      /files: \[\{ id: file\.id, name: file\.name \}\]/,
      page,
    );
  }
});
