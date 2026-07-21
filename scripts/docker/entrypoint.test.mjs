import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const backendDirectory = process.cwd();
process.env.PRIVCLOUD_BACKEND_DIRECTORY = backendDirectory;
const backendRequire = createRequire(
  path.join(backendDirectory, "package.json"),
);
const Database = backendRequire("better-sqlite3");
const entrypointUrl = pathToFileURL(
  path.resolve(backendDirectory, "..", "scripts", "docker", "entrypoint.mjs"),
);
const { publicParitySchemaIsReady, reconcileSqliteMigrations } = await import(
  `${entrypointUrl.href}?unit-test`
);

function createPartiallyMigratedDatabase(databasePath) {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE "_prisma_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO "_prisma_migrations"
      (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
    VALUES
      ('failed-parity', 'original-checksum', NULL,
       '20260721120000_add_public_team_signing_parity',
       'duplicate column name: signaturePage', NULL, 1, 0);

    CREATE TABLE "Team" (
      "id" TEXT PRIMARY KEY,
      "createdAt" DATETIME NOT NULL,
      "reportEnabled" BOOLEAN NOT NULL DEFAULT true,
      "keyVersion" INTEGER NOT NULL DEFAULT 1,
      "keyRotatedAt" DATETIME,
      "keyRotationIntervalDays" INTEGER NOT NULL DEFAULT 90,
      "keyRotationReminderDays" INTEGER NOT NULL DEFAULT 7,
      "lastKeyRotationReminderAt" DATETIME
    );
    CREATE TABLE "TeamMember" (
      "id" TEXT PRIMARY KEY,
      "updatedAt" DATETIME NOT NULL,
      "wrappedTeamKey" TEXT,
      "teamId" TEXT NOT NULL,
      "teamKeyVersion" INTEGER NOT NULL DEFAULT 0,
      "teamKeyUpdatedAt" DATETIME
    );
    CREATE TABLE "TeamAccessLog" (
      "id" TEXT PRIMARY KEY,
      "createdAt" DATETIME NOT NULL,
      "action" TEXT NOT NULL,
      "teamId" TEXT NOT NULL,
      "targetType" TEXT,
      "targetId" TEXT,
      "metadata" TEXT
    );
    CREATE TABLE "Share" (
      "id" TEXT PRIMARY KEY,
      "createdAt" DATETIME NOT NULL,
      "creatorId" TEXT,
      "teamFolderId" TEXT,
      "uploadLocked" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "File" (
      "id" TEXT PRIMARY KEY,
      "shareId" TEXT NOT NULL,
      "encryptionChunkSize" INTEGER
    );
    CREATE TABLE "SignatureDocument" (
      "id" TEXT PRIMARY KEY,
      "createdAt" DATETIME NOT NULL,
      "teamId" TEXT,
      "certificatePageKey" TEXT,
      "completedAt" DATETIME,
      "signaturePage" INTEGER,
      "watermarkPage" INTEGER
    );
    CREATE TABLE "TeamFolder" (
      "id" TEXT PRIMARY KEY,
      "teamId" TEXT NOT NULL,
      "parentId" TEXT
    );
    CREATE TABLE "AccessGrant" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "grantorId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL
    );

    INSERT INTO "Team" (id, createdAt) VALUES ('team-1', 100);
    INSERT INTO "TeamMember"
      (id, updatedAt, wrappedTeamKey, teamId)
    VALUES ('member-1', 200, 'wrapped-key', 'team-1');
  `);
  return database;
}

test("repairs the exact partially applied public parity migration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "privcloud-migration-"));
  const databasePath = path.join(directory, "partial.db");
  let database = createPartiallyMigratedDatabase(databasePath);
  database.close();

  try {
    reconcileSqliteMigrations(databasePath);
    // A second run must remain a no-op after Docker restarts.
    reconcileSqliteMigrations(databasePath);

    database = new Database(databasePath, { readonly: true });
    assert.equal(publicParitySchemaIsReady(database), true);
    const migration = database
      .prepare(
        "SELECT finished_at, logs, applied_steps_count FROM _prisma_migrations WHERE id = ?",
      )
      .get("failed-parity");
    assert.ok(migration.finished_at);
    assert.equal(migration.logs, null);
    assert.equal(migration.applied_steps_count, 1);
    assert.equal(
      database
        .prepare("SELECT teamKeyVersion FROM TeamMember WHERE id = ?")
        .get("member-1").teamKeyVersion,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT keyRotatedAt FROM Team WHERE id = ?")
        .get("team-1").keyRotatedAt,
      100,
    );
    database.close();
  } finally {
    if (database?.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not re-add consolidated signing page columns", () => {
  const migration = readFileSync(
    path.resolve(
      backendDirectory,
      "prisma",
      "migrations",
      "20260721120000_add_public_team_signing_parity",
      "migration.sql",
    ),
    "utf8",
  );
  assert.doesNotMatch(migration, /ADD COLUMN "signaturePage"/);
  assert.doesNotMatch(migration, /ADD COLUMN "watermarkPage"/);
});
