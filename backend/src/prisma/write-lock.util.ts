import { Prisma } from "@prisma/client";

/**
 * SQLite has a single writer. Taking the write lock first makes what this
 * transaction reads next final until it commits, as a row lock would.
 */
export async function takeWriteLock(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`UPDATE "Config" SET "name" = "name" WHERE 0`;
}
