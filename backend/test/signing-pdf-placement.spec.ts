import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  getInitialsStampGeometry,
  normalizeInitialsPlacement,
  shouldAddInitialsToPage,
} from "src/signing/initials-placement.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signing PDF placement");

testCase(
  "places initials above the footer and slightly right of centre",
  () => {
    const geometry = getInitialsStampGeometry({
      pageWidth: 595,
      pageHeight: 842,
      textWidth: 18,
      placement: "BOTTOM_CENTER_RIGHT",
    });

    assert.ok(geometry.y >= 39);
    assert.ok(geometry.x > 595 / 2);
    assert.ok(geometry.x + geometry.width < 595);
    assert.equal(geometry.fontSize, 9);
  },
);

testCase("keeps every initials preset inside the physical page", () => {
  for (const placement of [
    "BOTTOM_LEFT",
    "BOTTOM_CENTER_RIGHT",
    "BOTTOM_RIGHT",
  ]) {
    const geometry = getInitialsStampGeometry({
      pageWidth: 420,
      pageHeight: 595,
      textWidth: 42,
      placement,
    });
    assert.ok(geometry.x >= 0);
    assert.ok(geometry.y >= 0);
    assert.ok(geometry.x + geometry.width <= 420);
    assert.ok(geometry.y + geometry.height <= 595);
  }
  assert.equal(normalizeInitialsPlacement("unexpected"), "BOTTOM_CENTER_RIGHT");
});

testCase("omits the full-signature page unless explicitly requested", () => {
  assert.equal(
    shouldAddInitialsToPage({ pageIndex: 1, signaturePage: 2 }),
    false,
  );
  assert.equal(
    shouldAddInitialsToPage({
      pageIndex: 1,
      signaturePage: 2,
      includeSignaturePage: true,
    }),
    true,
  );
  assert.equal(
    shouldAddInitialsToPage({ pageIndex: 0, signaturePage: 2 }),
    true,
  );
});

testCase(
  "persists the initials preferences through the schema migration",
  () => {
    const schema = fs.readFileSync(
      path.resolve("prisma/schema.prisma"),
      "utf8",
    );
    const migration = fs.readFileSync(
      path.resolve(
        "prisma/migrations/20260904160000_add_oss_signing_evidence/migration.sql",
      ),
      "utf8",
    );
    assert.match(schema, /initialsPlacement\s+String/);
    assert.match(schema, /initialsIncludeSignaturePage\s+Boolean/);
    assert.match(migration, /BOTTOM_CENTER_RIGHT/);
  },
);

void run();
