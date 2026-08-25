import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendDirectory = fileURLToPath(new URL("..", import.meta.url));
const rawUrl =
  process.env.DATABASE_URL ||
  "file:../data/pingvin-share.db?connection_limit=1";

if (!rawUrl.startsWith("file:")) process.exit(0);

const rawPath = rawUrl.slice(5).split("?", 1)[0];
const databasePath = isAbsolute(rawPath)
  ? rawPath
  : resolve(backendDirectory, "prisma", rawPath);

if (!existsSync(databasePath)) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const database = new Database(databasePath);
  database.close();
}
