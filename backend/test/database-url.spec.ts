import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveDbUrl } from "../src/constants";

test("SQLite URLs resolve to the same filesystem path for CLI and runtime", () => {
  assert.equal(
    resolveDbUrl("file:/tmp/privcloud-system.db?connection_limit=1"),
    "/tmp/privcloud-system.db",
  );
  assert.equal(
    resolveDbUrl("file:../data/privcloud-system.db?connection_limit=1"),
    path.resolve(process.cwd(), "prisma", "../data/privcloud-system.db"),
  );
  assert.equal(
    resolveDbUrl("postgresql://localhost/privcloud"),
    "postgresql://localhost/privcloud",
  );
});

test("the container seed is independent from the omitted backend source tree", () => {
  const seed = readFileSync(
    path.resolve("prisma/seed/config.seed.ts"),
    "utf8",
  );

  assert.doesNotMatch(seed, /from ["']\.\.\/\.\.\/src\//);
  assert.match(seed, /if \(path\.isAbsolute\(filePath\)\) return filePath/);
});
