import path from "node:path";
import { defineConfig } from "prisma/config";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "file:../data/pingvin-share.db?connection_limit=1";

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: DATABASE_URL,
  },
  migrations: {
    seed: "ts-node --transpile-only prisma/seed/config.seed.ts",
  },
});
