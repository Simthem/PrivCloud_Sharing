import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { emailFold, findUserIdByEmail } from "src/prisma/sealed-columns";
import { sealLookupValue } from "src/config/account-secrets";

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "email-account-lookup-"));
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${directory}/lookup.db` }),
  });
  try {
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL, "emailFold" TEXT)',
    );
    const key = Buffer.alloc(32, 17);
    const sealed = sealLookupValue(key, "User.email", "Sealed@Example.test");
    const fold = emailFold(key, "Sealed@Example.test");
    await prisma.$executeRaw`INSERT INTO "User" ("id", "email", "emailFold") VALUES ('plain', 'MixedCase@Example.test', NULL), ('sealed', ${sealed}, ${fold}), ('unicode', 'MÉLANGE@Exemple.test', NULL)`;

    assert.equal(
      await findUserIdByEmail(prisma, "MIXEDCASE@EXAMPLE.TEST", null),
      "plain",
    );
    assert.equal(
      await findUserIdByEmail(prisma, "mixedcase@example.test", key),
      "plain",
    );
    assert.equal(
      await findUserIdByEmail(prisma, "SEALED@EXAMPLE.TEST", key),
      "sealed",
    );
    assert.equal(
      await findUserIdByEmail(
        prisma,
        "sealed@example.test",
        Buffer.alloc(32, 18),
      ),
      null,
    );
    assert.equal(
      await findUserIdByEmail(prisma, "sealed@example.test", null),
      null,
    );
    assert.equal(
      await findUserIdByEmail(prisma, "missing@example.test", key),
      null,
    );
    assert.equal(await findUserIdByEmail(prisma, "' OR 1=1 --", key), null);
    assert.equal(
      await findUserIdByEmail(prisma, "mélange@exemple.test", null),
      "unicode",
    );
    assert.equal(
      await findUserIdByEmail(prisma, "MÉLANGE@EXEMPLE.TEST", key),
      "unicode",
    );
    console.log("9 SQLite account address lookup checks passed");
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

void main();
