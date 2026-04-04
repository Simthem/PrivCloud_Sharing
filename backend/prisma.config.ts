import path from "node:path";
import { defineConfig } from "prisma/config";

const rawUrl =
  process.env.DATABASE_URL ||
  "file:../data/pingvin-share.db?connection_limit=1";

// Prisma 7 defineConfig resolves file: URLs relative to prisma.config.ts
// (backend root), but the path "../data/" was written for Prisma 6 which
// resolved relative to prisma/schema.prisma. We resolve it ourselves to
// an absolute file: URL so that migrate deploy, db seed and the runtime
// adapter all hit the same database file.
function resolveFileUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const withoutScheme = url.slice(5);
  const qIdx = withoutScheme.indexOf("?");
  const filePath = qIdx >= 0 ? withoutScheme.slice(0, qIdx) : withoutScheme;
  const query = qIdx >= 0 ? withoutScheme.slice(qIdx) : "";
  if (path.isAbsolute(filePath)) return url;
  const schemaDir = path.join(__dirname, "prisma");
  const absolutePath = path.resolve(schemaDir, filePath);
  return `file:${absolutePath}${query}`;
}

const DATABASE_URL = resolveFileUrl(rawUrl);
console.log(`[prisma.config] datasource.url: ${DATABASE_URL}  (__dirname: ${__dirname})`);

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: DATABASE_URL,
  },
  migrations: {
    seed: "ts-node --transpile-only prisma/seed/config.seed.ts",
  },
});
