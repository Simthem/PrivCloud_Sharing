import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateShareDTO } from "src/share/dto/createShare.dto";
import { MyShareDTO } from "src/share/dto/myShare.dto";
import { ShareDTO } from "src/share/dto/share.dto";
import { ShareCryptoEventDTO } from "src/share/dto/shareCryptoEvent.dto";
import { UpdateWrappedShareKeyDTO } from "src/share/dto/wrappedShareKey.dto";
import { ShareController } from "src/share/share.controller";
import {
  LEGACY_ACCOUNT_KEY,
  SHARE_DEK_V1,
  SHARE_KEY_WRAP_ALGORITHM,
  ShareCryptoCounters,
  isShareDekReadEnabled,
  isShareDekWriteEnabledFor,
  resolveShareCryptoScheme,
} from "src/share/share-crypto-scheme";
import { ShareService } from "src/share/share.service";
import {
  databaseWithMigrations,
  migrationStatements,
} from "./sqlite-migration.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("SHARE_DEK_V1");

const WRAPPED = "A".repeat(80);
const owner = { id: "owner-1", email: "owner@example.test" };
const FLAG_KEYS = [
  "SHARE_DEK_V1_READ",
  "SHARE_DEK_V1_WRITE",
  "SHARE_DEK_V1_CANARY_USERS",
  "SHARE_DEK_V1_ROLLOUT_PERCENT",
];

function withFlags(
  flags: Record<string, string>,
  runCase: () => void | Promise<void>,
): void | Promise<void> {
  const saved = Object.fromEntries(FLAG_KEYS.map((k) => [k, process.env[k]]));
  for (const key of FLAG_KEYS) delete process.env[key];
  Object.assign(process.env, flags);
  const restore = () => {
    for (const key of FLAG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  try {
    const result = runCase();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

function service(prisma: unknown = {}) {
  const instance = Object.create(ShareService.prototype) as ShareService;
  Object.assign(instance, {
    prisma,
    logger: { log() {}, warn() {}, debug() {}, error() {} },
  });
  return instance;
}

testCase("reads NULL and 1 as LEGACY_ACCOUNT_KEY and rejects unknown", () => {
  assert.equal(resolveShareCryptoScheme(null), LEGACY_ACCOUNT_KEY);
  assert.equal(resolveShareCryptoScheme(undefined), LEGACY_ACCOUNT_KEY);
  assert.equal(resolveShareCryptoScheme(1), LEGACY_ACCOUNT_KEY);
  assert.equal(resolveShareCryptoScheme(2), SHARE_DEK_V1);
  assert.throws(() => resolveShareCryptoScheme(3));
});

testCase("flags default to dual-read with legacy writes", () =>
  withFlags({}, () => {
    assert.equal(isShareDekReadEnabled(), true);
    assert.equal(isShareDekWriteEnabledFor(owner), false);
  }),
);

testCase("WRITE without a canary list selects nobody", () =>
  withFlags({ SHARE_DEK_V1_WRITE: "true" }, () => {
    assert.equal(isShareDekWriteEnabledFor(owner), false);
  }),
);

testCase("canary selects by id or e-mail, * selects everyone", () => {
  withFlags(
    {
      SHARE_DEK_V1_WRITE: "true",
      SHARE_DEK_V1_CANARY_USERS: " other , OWNER@example.test ",
    },
    () => {
      assert.equal(isShareDekWriteEnabledFor(owner), true);
      assert.equal(isShareDekWriteEnabledFor({ id: "x", email: "x@y" }), false);
      assert.equal(isShareDekWriteEnabledFor(null), false);
    },
  );
  withFlags(
    { SHARE_DEK_V1_WRITE: "true", SHARE_DEK_V1_CANARY_USERS: "owner-1" },
    () => assert.equal(isShareDekWriteEnabledFor(owner), true),
  );
  withFlags(
    { SHARE_DEK_V1_WRITE: "true", SHARE_DEK_V1_CANARY_USERS: "*" },
    () => assert.equal(isShareDekWriteEnabledFor({ id: "anyone" }), true),
  );
  withFlags(
    {
      SHARE_DEK_V1_WRITE: "false",
      SHARE_DEK_V1_CANARY_USERS: "*",
    },
    () => assert.equal(isShareDekWriteEnabledFor(owner), false),
  );
  withFlags(
    {
      SHARE_DEK_V1_READ: "false",
      SHARE_DEK_V1_WRITE: "true",
      SHARE_DEK_V1_CANARY_USERS: "*",
    },
    () => assert.equal(isShareDekWriteEnabledFor(owner), false),
  );
});

testCase("rollout percentage is stable and bounded", () =>
  withFlags(
    { SHARE_DEK_V1_WRITE: "true", SHARE_DEK_V1_ROLLOUT_PERCENT: "50" },
    () => {
      const users = Array.from({ length: 1000 }, (_, i) => ({ id: `u${i}` }));
      const selected = users.filter((u) => isShareDekWriteEnabledFor(u));
      assert.ok(selected.length > 400 && selected.length < 600);
      for (const user of selected) {
        assert.equal(isShareDekWriteEnabledFor(user), true);
      }
      process.env.SHARE_DEK_V1_ROLLOUT_PERCENT = "100";
      assert.ok(users.every((u) => isShareDekWriteEnabledFor(u)));
    },
  ),
);

testCase("clients that send no scheme keep the historical NULL", () => {
  const data = service().resolveCreateCryptoData(
    { id: "s1", isE2EEncrypted: true } as CreateShareDTO,
    owner as never,
    false,
    false,
  );
  assert.deepEqual(data, {
    cryptoScheme: null,
    wrappedShareKey: null,
    wrappedShareKeyAlgorithm: null,
    wrappedShareKeyVersion: null,
    fileMetadataScheme: null,
  });
});

testCase("explicit legacy scheme is stored only for personal E2E", () => {
  const s = service();
  assert.equal(
    s.resolveCreateCryptoData(
      { id: "s1", isE2EEncrypted: true, cryptoScheme: 1 } as CreateShareDTO,
      owner as never,
      false,
      false,
    ).cryptoScheme,
    LEGACY_ACCOUNT_KEY,
  );
  assert.equal(
    s.resolveCreateCryptoData(
      { id: "s1", isE2EEncrypted: false, cryptoScheme: 1 } as CreateShareDTO,
      owner as never,
      false,
      false,
    ).cryptoScheme,
    null,
  );
  assert.throws(
    () =>
      s.resolveCreateCryptoData(
        {
          id: "s1",
          isE2EEncrypted: true,
          cryptoScheme: 1,
          wrappedShareKey: WRAPPED,
        } as CreateShareDTO,
        owner as never,
        false,
        false,
      ),
    BadRequestException,
  );
  assert.throws(
    () =>
      s.resolveCreateCryptoData(
        {
          id: "s1",
          isE2EEncrypted: true,
          wrappedShareKey: WRAPPED,
        } as CreateShareDTO,
        owner as never,
        false,
        false,
      ),
    BadRequestException,
  );
});

testCase("SHARE_DEK_V1 creation honours the write flag", () => {
  const dek = {
    id: "s1",
    isE2EEncrypted: true,
    cryptoScheme: SHARE_DEK_V1,
    wrappedShareKey: WRAPPED,
    wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
  } as CreateShareDTO;

  withFlags({}, () => {
    assert.throws(
      () => service().resolveCreateCryptoData(dek, owner as never, false, false),
      (error: unknown) =>
        error instanceof ConflictException &&
        (error.getResponse() as { error?: string }).error ===
          "share_crypto_scheme_unavailable",
    );
  });

  withFlags(
    { SHARE_DEK_V1_WRITE: "true", SHARE_DEK_V1_CANARY_USERS: "owner-1" },
    () => {
      assert.deepEqual(
        service().resolveCreateCryptoData(dek, owner as never, false, false),
        {
          cryptoScheme: SHARE_DEK_V1,
          wrappedShareKey: WRAPPED,
          wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
          wrappedShareKeyVersion: 1,
          fileMetadataScheme: null,
        },
      );
      // Reverse-share uploads, team shares, anonymous and plaintext shares
      // keep their own key model.
      for (const [input, user, reverse, team] of [
        [dek, owner, true, false],
        [dek, owner, false, true],
        [dek, undefined, false, false],
        [{ ...dek, isE2EEncrypted: false }, owner, false, false],
        [{ ...dek, wrappedShareKey: undefined }, owner, false, false],
        [{ ...dek, wrappedShareKeyAlgorithm: "other" }, owner, false, false],
      ] as const) {
        assert.throws(
          () =>
            service().resolveCreateCryptoData(
              input as CreateShareDTO,
              user as never,
              reverse,
              team,
            ),
          BadRequestException,
        );
      }
    },
  );
});

testCase("create DTO accepts only a 60-byte base64url wrapped key", async () => {
  const base = {
    id: "share-1",
    expiration: "1-day",
    security: {},
    isE2EEncrypted: true,
  };
  const valid = plainToInstance(CreateShareDTO, {
    ...base,
    cryptoScheme: 2,
    wrappedShareKey: WRAPPED,
    wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
  });
  assert.equal((await validate(valid)).length, 0);

  for (const invalid of [
    { cryptoScheme: 3 },
    { cryptoScheme: "2" },
    { wrappedShareKey: "A".repeat(79) },
    { wrappedShareKey: "A".repeat(81) },
    { wrappedShareKey: `${"A".repeat(79)}=` },
    { wrappedShareKeyAlgorithm: "AES-KW" },
  ]) {
    const dto = plainToInstance(CreateShareDTO, { ...base, ...invalid });
    assert.ok((await validate(dto)).length > 0, JSON.stringify(invalid));
  }

  const rewrap = plainToInstance(UpdateWrappedShareKeyDTO, {
    wrappedShareKey: WRAPPED,
    expectedVersion: 1,
  });
  assert.equal((await validate(rewrap)).length, 0);
  const badRewrap = plainToInstance(UpdateWrappedShareKeyDTO, {
    wrappedShareKey: WRAPPED,
    expectedVersion: 0,
  });
  assert.ok((await validate(badRewrap)).length > 0);
});

testCase("public share DTO exposes the scheme but never the wrapped key", () => {
  const row = {
    id: "s1",
    cryptoScheme: 2,
    wrappedShareKey: WRAPPED,
    wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
    wrappedShareKeyVersion: 1,
    files: [],
  };
  const publicDto = new ShareDTO().from(row as never) as unknown as Record<
    string,
    unknown
  >;
  assert.equal(publicDto.cryptoScheme, 2);
  assert.equal("wrappedShareKey" in publicDto, false);
  assert.equal("wrappedShareKeyVersion" in publicDto, false);

  const ownerDto = new MyShareDTO().from(row as never) as unknown as Record<
    string,
    unknown
  >;
  assert.equal(ownerDto.wrappedShareKey, WRAPPED);
  assert.equal(ownerDto.wrappedShareKeyVersion, 1);
});

testCase("rewrap is compare-and-set and owner-only", async () => {
  let stored = { version: 1, wrapped: "old" };
  const prisma = {
    share: {
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: { wrappedShareKey: string };
      }) => {
        const matches =
          args.where.id === "s1" &&
          args.where.creatorId === "owner-1" &&
          args.where.cryptoScheme === SHARE_DEK_V1 &&
          args.where.wrappedShareKeyVersion === stored.version;
        if (!matches) return { count: 0 };
        stored = { version: stored.version + 1, wrapped: args.data.wrappedShareKey };
        return { count: 1 };
      },
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === "s1"
          ? { creatorId: "owner-1", cryptoScheme: SHARE_DEK_V1 }
          : args.where.id === "legacy"
            ? { creatorId: "owner-1", cryptoScheme: null }
            : null,
    },
  };
  const s = service(prisma);

  assert.deepEqual(
    await s.updateWrappedShareKey("s1", "owner-1", {
      wrappedShareKey: WRAPPED,
      expectedVersion: 1,
    }),
    { wrappedShareKeyVersion: 2 },
  );
  assert.equal(stored.wrapped, WRAPPED);

  await assert.rejects(
    s.updateWrappedShareKey("s1", "owner-1", {
      wrappedShareKey: WRAPPED,
      expectedVersion: 1,
    }),
    ConflictException,
    "a stale version must never overwrite a newer wrap",
  );
  await assert.rejects(
    s.updateWrappedShareKey("s1", "intruder", {
      wrappedShareKey: WRAPPED,
      expectedVersion: 2,
    }),
    ForbiddenException,
  );
  await assert.rejects(
    s.updateWrappedShareKey("legacy", "owner-1", {
      wrappedShareKey: WRAPPED,
      expectedVersion: 1,
    }),
    BadRequestException,
  );
  await assert.rejects(
    s.updateWrappedShareKey("missing", "owner-1", {
      wrappedShareKey: WRAPPED,
      expectedVersion: 1,
    }),
    NotFoundException,
  );
  assert.equal(stored.version, 2);
});

testCase("e2e-key endpoint keeps reverse shares and serves DEK to owner", () =>
  withFlags({}, async () => {
    const controller = Object.create(
      ShareController.prototype,
    ) as ShareController;
    const materials: Record<string, unknown> = {
      dek: {
        creatorId: "owner-1",
        cryptoScheme: SHARE_DEK_V1,
        wrappedShareKey: WRAPPED,
        wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
        wrappedShareKeyVersion: 3,
      },
      legacy: {
        creatorId: "owner-1",
        cryptoScheme: null,
        wrappedShareKey: null,
      },
    };
    Object.assign(controller, {
      logger: { debug() {}, warn() {}, log() {} },
      shareService: {
        getEncryptedReverseShareKey: async (id: string) =>
          id === "reverse"
            ? { encryptedReverseShareKey: "rs-wrapped", creatorId: "owner-1" }
            : null,
        getWrappedShareKey: async (id: string) => materials[id] ?? null,
      },
    });
    const me = { id: "owner-1" } as never;

    assert.deepEqual(await controller.getEncryptedE2eKey("reverse", me), {
      encryptedReverseShareKey: "rs-wrapped",
    });
    assert.deepEqual(await controller.getEncryptedE2eKey("legacy", me), {
      encryptedReverseShareKey: null,
      cryptoScheme: null,
    });
    assert.deepEqual(await controller.getEncryptedE2eKey("dek", me), {
      encryptedReverseShareKey: null,
      cryptoScheme: SHARE_DEK_V1,
      wrappedShareKey: WRAPPED,
      wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
      wrappedShareKeyVersion: 3,
    });
    await assert.rejects(
      controller.getEncryptedE2eKey("dek", { id: "someone" } as never),
      ForbiddenException,
    );
    await assert.rejects(
      controller.getEncryptedE2eKey("dek", undefined as never),
      ForbiddenException,
    );

    process.env.SHARE_DEK_V1_READ = "false";
    assert.deepEqual(await controller.getEncryptedE2eKey("dek", me), {
      encryptedReverseShareKey: null,
      cryptoScheme: SHARE_DEK_V1,
    });
  }),
);

testCase("crypto counters keep aggregated values only", async () => {
  const counters = new ShareCryptoCounters();
  counters.record({
    event: "unwrap_error",
    scheme: "SHARE_DEK_V1",
    client: "unknown",
    clientVersion: "1.25.0",
  });
  counters.record({
    event: "unwrap_error",
    scheme: "SHARE_DEK_V1",
    client: "unknown",
    clientVersion: "1.25.0",
  });
  counters.record({
    event: "decrypt_error",
    scheme: "LEGACY_ACCOUNT_KEY",
    client: "web",
    clientVersion: "not a version!",
  });
  const snapshot = counters.snapshot();
  assert.deepEqual(snapshot.counters, [
    {
      event: "decrypt_error",
      scheme: "LEGACY_ACCOUNT_KEY",
      client: "web",
      clientVersion: "unknown",
      count: 1,
    },
    {
      event: "unwrap_error",
      scheme: "SHARE_DEK_V1",
      client: "unknown",
      clientVersion: "1.25.0",
      count: 2,
    },
  ]);

  const event = plainToInstance(ShareCryptoEventDTO, {
    event: "unwrap_error",
    scheme: "SHARE_DEK_V1",
    client: "web",
    clientVersion: "1.25.0",
    shareId: "must-not-be-accepted",
  });
  assert.equal((await validate(event, { whitelist: true })).length, 0);
  assert.equal(
    (
      await validate(
        plainToInstance(ShareCryptoEventDTO, {
          event: "key_leak",
          scheme: "SHARE_DEK_V1",
          client: "web",
        }),
      )
    ).length > 0,
    true,
  );
});

testCase("K_master rotation cannot rewrite SHARE_DEK_V1 ciphertext", () => {
  const source = readFileSync(
    path.resolve("src/file/file.controller.ts"),
    "utf8",
  );
  const reencrypt = source.slice(source.indexOf('@Put(":fileId/reencrypt")'));
  const guard = reencrypt.indexOf("share_dek_reencrypt_refused");
  const write = reencrypt.indexOf("this.fileService.replaceFileContent(");
  assert.ok(guard > 0 && write > guard, "the refusal must precede any write");
});

testCase("migration is additive and keeps legacy rows valid", () => {
  const migration = "20260929120000_add_share_dek_v1";
  const statements = migrationStatements(migration);
  // SQLite cannot add a CHECK constraint to an existing table: triggers
  // enforce it. Nothing else touches the rows already stored.
  assert.doesNotMatch(
    statements.replace(/BEFORE UPDATE OF/g, ""),
    /\bDROP\b|\bRENAME\b|\bUPDATE\b|\bDELETE\b/i,
  );
  const addedColumns = statements
    .split("\n")
    .filter((line) => line.includes("ADD COLUMN"));
  assert.equal(addedColumns.length, 4);
  for (const line of addedColumns) {
    assert.doesNotMatch(line, /NOT NULL|DEFAULT/i, "new columns stay nullable");
  }
  for (const column of [
    "cryptoScheme",
    "wrappedShareKey",
    "wrappedShareKeyAlgorithm",
    "wrappedShareKeyVersion",
  ]) {
    assert.match(statements, new RegExp(`ADD COLUMN "${column}"`));
  }

  const db = databaseWithMigrations(migration);
  const insert = db.prepare(
    `INSERT INTO "Share" ("id", "isE2EEncrypted", "cryptoScheme", "wrappedShareKey", "wrappedShareKeyAlgorithm", "wrappedShareKeyVersion") VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("legacy", 1, null, null, null, null);
  insert.run("legacy-explicit", 1, 1, null, null, null);
  insert.run("dek", 1, SHARE_DEK_V1, WRAPPED, SHARE_KEY_WRAP_ALGORITHM, 1);
  for (const row of [
    ["null-scheme-with-key", 1, null, WRAPPED, SHARE_KEY_WRAP_ALGORITHM, 1],
    ["dek-without-key", 1, SHARE_DEK_V1, null, null, null],
    ["dek-not-e2e", 0, SHARE_DEK_V1, WRAPPED, SHARE_KEY_WRAP_ALGORITHM, 1],
    ["unknown-scheme", 1, 3, null, null, null],
  ]) {
    assert.throws(
      () => insert.run(...row),
      /Share\.(cryptoScheme|wrappedShareKey)/,
      String(row[0]),
    );
  }
  // A rewrap keeps the scheme valid, removing the wrapped key does not.
  db.prepare(
    `UPDATE "Share" SET "wrappedShareKey" = ?, "wrappedShareKeyVersion" = "wrappedShareKeyVersion" + 1 WHERE "id" = 'dek'`,
  ).run("B".repeat(80));
  assert.throws(
    () =>
      db
        .prepare(`UPDATE "Share" SET "wrappedShareKey" = NULL WHERE "id" = 'dek'`)
        .run(),
    /Share\.wrappedShareKey/,
  );
  db.close();
});

void run();
