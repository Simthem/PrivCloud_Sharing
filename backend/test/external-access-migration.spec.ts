import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readMigration } from "./sqlite-migration.util";

const database = new DatabaseSync(":memory:");
try {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL);
    CREATE TABLE "Team" (
      "id" TEXT PRIMARY KEY,
      "ownerId" TEXT REFERENCES "User"("id") ON DELETE CASCADE
    );
    CREATE TABLE "File" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
    CREATE TABLE "TeamFileRequest" ("id" TEXT PRIMARY KEY, "subject" TEXT NOT NULL);
    INSERT INTO "User" VALUES ('owner', 'Owner@Example.test');
    INSERT INTO "Team" VALUES ('team', 'owner');
    INSERT INTO "File" VALUES ('original', 'retained.txt');
    INSERT INTO "TeamFileRequest" VALUES ('request', 'retained request');
  `);
  database.exec(
    readMigration("20261019120000_add_external_access_and_passkeys"),
  );
  assert.equal(
    database.prepare('SELECT "name" FROM "File"').get()?.name,
    "retained.txt",
  );
  assert.equal(
    database.prepare('SELECT "subject" FROM "TeamFileRequest"').get()?.subject,
    "retained request",
  );
  database.exec(`
    INSERT INTO "TeamExternalSeat" (
      "id", "updatedAt", "email", "inviteExpiresAt", "accessExpiresAt", "teamId"
    ) VALUES ('seat', CURRENT_TIMESTAMP, 'contractor@example.test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'team');
    INSERT INTO "TeamExternalPreview" (
      "id", "updatedAt", "pageCount", "encryptedManifest", "encryptedKey",
      "ephemeralPublicKey", "nonce", "kemCiphertext", "algorithm", "teamId", "seatId", "sourceFileId"
    ) VALUES ('preview', CURRENT_TIMESTAMP, 1, 'opaque', 'opaque', 'opaque', 'opaque', 'opaque', 'opaque', 'team', 'seat', 'original');
    INSERT INTO "TeamExternalPreviewPage" ("id", "index", "size", "previewId")
      VALUES ('page', 0, 64, 'preview');
    DELETE FROM "File" WHERE "id" = 'original';
  `);
  assert.equal(
    database.prepare('SELECT "sourceFileId" FROM "TeamExternalPreview"').get()
      ?.sourceFileId,
    null,
  );
  assert.throws(
    () =>
      database.exec(`
    INSERT INTO "TeamExternalPreviewPage" ("id", "index", "size", "previewId")
    VALUES ('duplicate', 0, 64, 'preview')
  `),
    /UNIQUE/,
  );
  database.exec('DELETE FROM "Team" WHERE "id" = \'team\'');
  assert.equal(
    database
      .prepare('SELECT count(*) AS count FROM "TeamExternalPreview"')
      .get()?.count,
    0,
  );
  assert.equal(
    database
      .prepare('SELECT count(*) AS count FROM "TeamExternalPreviewPage"')
      .get()?.count,
    0,
  );
  for (const table of [
    "TeamExternalIssuance",
    "TeamExternalAuditEvent",
    "TeamExternalAuditAnchor",
  ]) {
    const keys = database.prepare(`PRAGMA foreign_key_list("${table}")`).all();
    assert.equal(
      keys.some((key) => key.table === "Team"),
      false,
      `${table} must retain evidence after deletion`,
    );
  }
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  console.log(
    "ok - external access migration preserves existing records and constrains preview lifecycles",
  );
} finally {
  database.close();
}
