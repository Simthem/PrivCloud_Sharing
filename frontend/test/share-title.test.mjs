import assert from "node:assert/strict";
import test from "node:test";
import { defaultShareTitle } from "../src/utils/shareTitle.util.ts";

test("an unnamed share reads as its first file and counts the others", () => {
  assert.deepEqual(defaultShareTitle([{ name: "Contrat.pdf" }], true), {
    name: "Contrat.pdf",
    others: 0,
  });
  assert.deepEqual(
    defaultShareTitle(
      [{ name: " Contrat.pdf " }, { name: "a" }, { name: "b" }, { name: "c" }],
      true,
    ),
    { name: "Contrat.pdf", others: 3 },
  );
});

test("encrypted names are never shown before they are opened", () => {
  const placeholder = [{ name: "file.bin", metadataScheme: "FILE_META_V1" }];
  assert.equal(defaultShareTitle(placeholder, false), null);
  assert.equal(
    defaultShareTitle([{ name: "x", metadataUnreadable: true }], true),
    null,
  );
  assert.equal(defaultShareTitle([], true), null);
  assert.equal(defaultShareTitle(undefined, true), null);
  assert.equal(defaultShareTitle([{ name: "  " }], true), null);
});
