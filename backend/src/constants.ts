import { LogLevel } from "@nestjs/common";
import * as path from "path";

export const CONFIG_FILE = process.env.CONFIG_FILE || "../config.yaml";

export const DATA_DIRECTORY = process.env.DATA_DIRECTORY || "./data";
export const SHARE_DIRECTORY = `${DATA_DIRECTORY}/uploads/shares`;
export const DATABASE_URL =
  process.env.DATABASE_URL ||
  "file:../data/pingvin-share.db?connection_limit=1";

/**
 * Resolve a Prisma SQLite datasource URL to an absolute file path.
 *
 * Prisma CLI resolves file: URLs relative to the schema.prisma directory,
 * but better-sqlite3 (used by @prisma/adapter-better-sqlite3) resolves
 * relative to process.cwd(). This mismatch causes the adapter to open
 * a different (empty) database file.
 *
 * This function mimics Prisma’s resolution: relative paths are resolved
 * from {cwd}/prisma/ (where schema.prisma resides).
 */
export function resolveDbUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const raw = url.slice(5);
  const filePath = raw.split("?")[0];
  if (path.isAbsolute(filePath)) return url;
  const schemaDir = path.join(process.cwd(), "prisma");
  const absolutePath = path.resolve(schemaDir, filePath);
  return absolutePath;
}
export const CLAMAV_HOST =
  process.env.CLAMAV_HOST ||
  (process.env.NODE_ENV == "docker" ? "clamav" : "127.0.0.1");
export const CLAMAV_PORT = parseInt(process.env.CLAMAV_PORT) || 3310;

export const LOG_LEVEL_AVAILABLE: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
export const LOG_LEVEL_DEFAULT: LogLevel = process.env.NODE_ENV === 'development' ? "verbose" : "log";
export const LOG_LEVEL_ENV = `${process.env.PV_LOG_LEVEL || ""}`;