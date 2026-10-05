import assert from "node:assert/strict";
import { databaseWithMigrations, readMigration } from "./sqlite-migration.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("SQLite file request migration");

testCase(
  "preserves existing shares, encryption triggers and references during upgrade",
  () => {
    const db = databaseWithMigrations();
    try {
      db.exec(`
      PRAGMA foreign_keys = ON;
      ALTER TABLE "Share" ADD COLUMN "hasBeenCompleted" BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE "Share" ADD COLUMN "creatorId" TEXT;
      CREATE TABLE "User" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "Team" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "TeamFolder" ("id" TEXT PRIMARY KEY);
      INSERT INTO "User" VALUES ('owner'), ('recipient');
      INSERT INTO "Team" VALUES ('team');
      INSERT INTO "TeamFolder" VALUES ('folder');
      INSERT INTO "Share" ("id", "isE2EEncrypted") VALUES ('existing', true);
      CREATE TRIGGER "existing_encryption_guard" BEFORE UPDATE OF "isE2EEncrypted" ON "Share"
      BEGIN SELECT RAISE(ABORT, 'encryption preserved'); END;
    `);
      db.exec(readMigration("20261001120000_add_team_file_requests"));
      const get = (sql: string) =>
        (
          db.prepare(sql) as unknown as { get(): Record<string, unknown> }
        ).get();
      assert.equal(
        get(
          `SELECT count(*) AS n FROM "Share" WHERE id = 'existing' AND "isE2EEncrypted" = true`,
        ).n,
        1,
      );
      assert.throws(
        () =>
          db.exec(
            `UPDATE "Share" SET "isE2EEncrypted" = false WHERE id = 'existing'`,
          ),
        /encryption preserved/,
      );
      const insert = db.prepare(
        `INSERT INTO "TeamFileRequest" ("id", "subject", "status", "recipientScope", "expiresAt", "creatorId", "teamId", "folderId") VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'owner', 'team', 'folder')`,
      );
      for (const [subject, status, scope] of [
        ["ab", "OPEN", "ALL"],
        ["x".repeat(121), "OPEN", "ALL"],
        ["Valid", "UNKNOWN", "ALL"],
        ["Valid", "OPEN", "UNKNOWN"],
      ]) {
        assert.throws(
          () => insert.run("invalid", subject, status, scope),
          /CHECK constraint/,
        );
      }
      insert.run("request", "Valid subject", "OPEN", "SELECTED");
      db.exec(`
      INSERT INTO "TeamFileRequestRecipient" VALUES ('recipient-row', 'request', 'recipient');
      UPDATE "Share" SET "teamFileRequestId" = 'request' WHERE "id" = 'existing';
    `);
      assert.throws(
        () =>
          db.exec(
            `INSERT INTO "TeamFileRequestRecipient" VALUES ('duplicate', 'request', 'recipient')`,
          ),
        /UNIQUE constraint/,
      );
      assert.throws(
        () =>
          db.exec(
            `UPDATE "Share" SET "teamFileRequestId" = 'missing' WHERE "id" = 'existing'`,
          ),
        /FOREIGN KEY constraint/,
      );
      db.exec(`DELETE FROM "TeamFileRequest" WHERE "id" = 'request'`);
      assert.equal(
        get(`SELECT "teamFileRequestId" FROM "Share" WHERE id = 'existing'`)
          .teamFileRequestId,
        null,
      );
      assert.equal(
        get('SELECT count(*) AS n FROM "TeamFileRequestRecipient"').n,
        0,
      );
      assert.equal(get('SELECT count(*) AS n FROM "Share"').n, 1);
    } finally {
      db.close();
    }
  },
);

void run();
