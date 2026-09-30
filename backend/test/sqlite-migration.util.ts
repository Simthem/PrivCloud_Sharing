import { readFileSync } from "node:fs";
import path from "node:path";

type SqliteStatement = { run: (...params: unknown[]) => unknown };

export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

// better-sqlite3 is installed for the Prisma adapter, without typings: only
// the calls declared above are used.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3") as new (
  filename: string,
) => SqliteDatabase;

export function readMigration(name: string): string {
  return readFileSync(
    path.resolve("prisma/migrations", name, "migration.sql"),
    "utf8",
  );
}

/** Migration SQL without its comment lines. */
export function migrationStatements(name: string): string {
  return readMigration(name)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/**
 * In-memory database holding only the Share and File columns read by the
 * SHARE_DEK_V1 and FILE_META_V1 triggers, followed by the given migrations
 * exactly as shipped. The older history is not replayed here: this checks the
 * triggers themselves, `prisma migrate deploy` covers the full chain.
 */
export function databaseWithMigrations(...names: string[]): SqliteDatabase {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE "Share" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "isE2EEncrypted" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "File" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "relativePath" TEXT,
      "shareId" TEXT NOT NULL
    );
  `);
  for (const name of names) db.exec(readMigration(name));
  return db;
}
