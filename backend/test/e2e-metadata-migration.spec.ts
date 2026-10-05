import assert from "node:assert/strict";
import { databaseWithMigrations, readMigration } from "./sqlite-migration.util";
import { createUnitTestRunner } from "./unit-test";
const { testCase, run } = createUnitTestRunner(
  "SQLite encrypted metadata migration",
);

testCase(
  "upgrade preserves requests, recipients and shares and enforces encrypted labels",
  () => {
    const db = databaseWithMigrations();
    const get = (sql: string) =>
      (db.prepare(sql) as unknown as { get(): Record<string, unknown> }).get();
    try {
      db.exec(`
      PRAGMA foreign_keys=ON;
      ALTER TABLE "Share" ADD COLUMN "hasBeenCompleted" BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE "Share" ADD COLUMN "creatorId" TEXT;
      CREATE TABLE "User" (id TEXT PRIMARY KEY);
      CREATE TABLE "Team" (id TEXT PRIMARY KEY);
      CREATE TABLE "TeamFolder" (id TEXT PRIMARY KEY);
      CREATE TABLE "AccessGrant" (id TEXT PRIMARY KEY, algorithm TEXT NOT NULL);
      CREATE TABLE "ReverseShare" (id TEXT PRIMARY KEY, name TEXT, "encryptedReverseShareKey" TEXT);
      CREATE TABLE "TeamKeyRotation" (id TEXT PRIMARY KEY);
      CREATE TABLE "TeamNotification" (id TEXT PRIMARY KEY, type TEXT, title TEXT, metadata TEXT, "encryptedMetadata" TEXT);
      INSERT INTO "User" VALUES ('owner'), ('recipient');
      INSERT INTO "Team" VALUES ('team');
      INSERT INTO "TeamFolder" VALUES ('folder');
      INSERT INTO "AccessGrant" VALUES ('old-grant', 'x25519-aes256gcm');
      INSERT INTO "ReverseShare" VALUES ('old-link', 'Readable name', 'wrapped');
      INSERT INTO "TeamNotification" VALUES ('old-notification', 'FILE_SHARED', 'secret-plan.pdf', 'Finance', NULL), ('encrypted-notification', 'FILE_SHARED', 'Generic', NULL, 'ciphertext');
    `);
      db.exec(readMigration("20261001120000_add_team_file_requests"));
      db.exec(`
      INSERT INTO "TeamFileRequest" (id, subject, note, "expiresAt", "creatorId", "teamId", "folderId") VALUES ('request', 'Old subject', 'Old note', CURRENT_TIMESTAMP, 'owner', 'team', 'folder');
      INSERT INTO "TeamFileRequestRecipient" VALUES ('recipient-row', 'request', 'recipient');
      INSERT INTO "Share" (id, "teamFileRequestId") VALUES ('share', 'request');
    `);
      db.exec(readMigration("20261002140000_e2e_metadata_hardening"));
      assert.equal(
        get(`SELECT subject FROM "TeamFileRequest" WHERE id='request'`).subject,
        "Old subject",
      );
      assert.equal(
        get('SELECT "requestId" FROM "TeamFileRequestRecipient"').requestId,
        "request",
      );
      assert.equal(
        get('SELECT "teamFileRequestId" FROM "Share"').teamFileRequestId,
        "request",
      );
      assert.equal(get("PRAGMA foreign_keys").foreign_keys, 1);
      assert.equal(get("PRAGMA foreign_key_check"), undefined);
      assert.equal(
        get(
          `SELECT "encryptedMetadata" FROM "TeamNotification" WHERE id='encrypted-notification'`,
        ).encryptedMetadata,
        "ciphertext",
      );
      assert.doesNotMatch(
        String(
          get(
            `SELECT title FROM "TeamNotification" WHERE id='old-notification'`,
          ).title,
        ),
        /secret-plan/,
      );
      db.exec(
        `UPDATE "TeamFileRequest" SET subject='', note=NULL, "encryptedInfo"='ciphertext' WHERE id='request'`,
      );
      assert.throws(() =>
        db.exec(`UPDATE "TeamFileRequest" SET note='leak' WHERE id='request'`),
      );
      assert.throws(() =>
        db.exec(
          `UPDATE "TeamFileRequest" SET subject='leak' WHERE id='request'`,
        ),
      );
      assert.throws(() =>
        db.exec(
          `UPDATE "TeamFileRequest" SET "encryptedInfo"=NULL WHERE id='request'`,
        ),
      );
      assert.throws(() =>
        db.exec(
          `INSERT INTO "AccessGrant" (id, algorithm) VALUES ('invalid', 'x25519-mlkem768-aes256gcm')`,
        ),
      );
      db.exec(
        `INSERT INTO "AccessGrant" VALUES ('hybrid', 'x25519-mlkem768-aes256gcm', 'ciphertext')`,
      );
      assert.throws(() =>
        db.exec(
          `UPDATE "AccessGrant" SET algorithm='x25519-aes256gcm' WHERE id='hybrid'`,
        ),
      );
      assert.throws(() =>
        db.exec(
          `UPDATE "ReverseShare" SET "encryptedName"='ciphertext' WHERE id='old-link'`,
        ),
      );
      db.exec(
        `UPDATE "ReverseShare" SET name=NULL, "encryptedName"='ciphertext' WHERE id='old-link'`,
      );
      assert.throws(() =>
        db.exec(
          `UPDATE "ReverseShare" SET "encryptedReverseShareKey"=NULL WHERE id='old-link'`,
        ),
      );
      db.exec(`DELETE FROM "TeamFileRequest" WHERE id='request'`);
      assert.equal(
        get('SELECT count(*) AS n FROM "TeamFileRequestRecipient"').n,
        0,
      );
      assert.equal(
        get('SELECT "teamFileRequestId" FROM "Share"').teamFileRequestId,
        null,
      );
    } finally {
      db.close();
    }
  },
);
void run();
