import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, verify } from "otplib";
import {
  applyAccountEncryption,
  findByToken,
  openAccountSecret,
  openToken,
  sealAccountSecret,
  sealToken,
  tokenCandidates,
  verifiedEmailFold,
} from "src/config/account-secrets";
import { isSealedValue } from "src/config/config-encryption";
import {
  matchesSecurityState,
  sealSecurityState,
} from "src/auth/securityState.util";
import { createTestCredentials } from "./test-credentials";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Encrypted account secrets");

const key = randomBytes(32);
const quiet = { log() {} } as never;
const { totpSecret } = createTestCredentials();
const idToken = "microsoft:header.payload.signature";

function withKey(mode: string | undefined, body: () => Promise<void> | void) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "account-key-"));
    const file = join(directory, "config.key");
    writeFileSync(file, key.toString("base64"));
    process.env.CONFIG_ENCRYPTION_KEY_FILE = file;
    if (mode) process.env.CONFIG_ENCRYPTION_MODE = mode;
    try {
      await body();
    } finally {
      delete process.env.CONFIG_ENCRYPTION_KEY_FILE;
      delete process.env.CONFIG_ENCRYPTION_MODE;
      rmSync(directory, { recursive: true });
    }
  };
}

type Row = Record<string, string | null>;

function table(rows: Row[]) {
  return {
    rows,
    findMany: async ({
      where,
      take,
    }: {
      where: Record<string, { startsWith?: string }> & {
        NOT?: Record<string, { startsWith: string }>;
      };
      take: number;
    }) => {
      const stored = where.NOT ?? where;
      const field = Object.keys(stored)[0];
      const prefix = stored[field].startsWith as string;
      return rows
        .filter((row) => {
          if (row[field] === null || row[field] === undefined) return false;
          return row[field].startsWith(prefix) !== !!where.NOT;
        })
        .slice(0, take)
        .map((row) => ({ ...row }));
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const field = Object.keys(data)[0];
      let count = 0;
      for (const row of rows) {
        if (row.id === where.id && row[field] === where[field]) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      rows.splice(
        rows.findIndex((row) => row.id === where.id),
        1,
      );
    },
  };
}

const empty = () => table([]);

const database = () => ({
  user: table([
    { id: "user-1", totpSecret },
    { id: "user-2", totpSecret: null },
  ]),
  refreshToken: table([
    { id: "token-1", userId: "user-1", oauthIDToken: idToken },
  ]),
  oAuthUser: empty(),
  pushSubscription: empty(),
  enrollmentToken: empty(),
  teamInvitation: empty(),
  teamGuestLink: empty(),
  signatureRecipient: empty(),
  reverseShare: empty(),
});

testCase("address indexes retain their existing unkeyed bytes", () => {
  const expected = createHash("sha256")
    .update("verified-email-fold\0contact@example.test", "utf8")
    .digest("base64url");
  assert.equal(verifiedEmailFold("Contact@Example.test"), expected);
});

testCase(
  "address indexes retain their existing keyed bytes in every storage mode",
  withKey(undefined, () => {
    const expected = createHmac("sha256", key)
      .update("verified-email-fold\0contact@example.test", "utf8")
      .digest("base64url");
    for (const mode of ["full", "decrypt", ""]) {
      process.env.CONFIG_ENCRYPTION_MODE = mode;
      assert.equal(verifiedEmailFold("Contact@Example.test"), expected);
    }
  }),
);

testCase("without a key secrets stay as they are", async () => {
  assert.equal(
    sealAccountSecret("user-1", "totpSecret", totpSecret),
    totpSecret,
  );
  assert.equal(
    openAccountSecret("user-1", "totpSecret", totpSecret),
    totpSecret,
  );
  const store = database();
  await applyAccountEncryption(store as never, null, quiet);
  assert.equal(store.user.rows[0].totpSecret, totpSecret);
});

testCase(
  "a key alone leaves them readable by older versions",
  withKey(undefined, async () => {
    assert.equal(
      sealAccountSecret("user-1", "totpSecret", totpSecret),
      totpSecret,
    );
    const store = database();
    await applyAccountEncryption(store as never, key, quiet);
    assert.equal(store.user.rows[0].totpSecret, totpSecret);
    assert.equal(store.refreshToken.rows[0].oauthIDToken, idToken);
  }),
);

testCase(
  "a sealed secret opens only for its account and column",
  withKey("full", () => {
    const sealed = sealAccountSecret("user-1", "totpSecret", totpSecret);
    assert.equal(isSealedValue(sealed), true);
    assert.equal(sealed.includes(totpSecret), false);
    assert.equal(openAccountSecret("user-1", "totpSecret", sealed), totpSecret);
    assert.throws(() => openAccountSecret("user-2", "totpSecret", sealed));
    assert.throws(() => openAccountSecret("user-1", "oauthIDToken", sealed));
  }),
);

testCase(
  "stored rows are sealed once, and a sealed secret still verifies codes",
  withKey("full", async () => {
    const store = database();
    await applyAccountEncryption(store as never, key, quiet);
    const sealed = store.user.rows[0].totpSecret as string;
    assert.equal(isSealedValue(sealed), true);
    assert.equal(store.user.rows[1].totpSecret, null);
    assert.equal(isSealedValue(store.refreshToken.rows[0].oauthIDToken), true);

    await applyAccountEncryption(store as never, key, quiet);
    assert.equal(store.user.rows[0].totpSecret, sealed);

    const secret = openAccountSecret("user-1", "totpSecret", sealed);
    const token = await generate({ secret });
    assert.equal((await verify({ secret, token })).valid, true);
  }),
);

testCase(
  "decrypt mode restores plaintext rows",
  withKey("full", async () => {
    const store = database();
    await applyAccountEncryption(store as never, key, quiet);
    process.env.CONFIG_ENCRYPTION_MODE = "decrypt";
    await applyAccountEncryption(store as never, key, quiet);
    assert.equal(store.user.rows[0].totpSecret, totpSecret);
    assert.equal(store.refreshToken.rows[0].oauthIDToken, idToken);
    assert.equal(
      sealAccountSecret("user-1", "totpSecret", totpSecret),
      totpSecret,
    );
  }),
);

testCase(
  "a concurrent change is not overwritten",
  withKey("full", async () => {
    const store = database();
    const { findMany } = store.user;
    store.user.findMany = async (args) => {
      const rows = await findMany(args);
      if (rows.length) store.user.rows[0].totpSecret = "ENROLLEDAGAIN";
      return rows;
    };
    let reads = 0;
    const counted = store.user.findMany;
    store.user.findMany = async (args) => (reads++ ? [] : counted(args));
    await applyAccountEncryption(store as never, key, quiet);
    assert.equal(store.user.rows[0].totpSecret, "ENROLLEDAGAIN");
  }),
);

testCase(
  "sealing a secret leaves a pending email change valid",
  withKey("full", async () => {
    const account = {
      id: "user-1",
      password: null,
      ldapDN: null,
      totpEnabled: true,
      totpVerified: true,
      totpSecret,
    };
    const state = await sealSecurityState(account);
    const sealed = sealAccountSecret("user-1", "totpSecret", totpSecret);
    assert.equal(
      await matchesSecurityState(state, { ...account, totpSecret: sealed }),
      true,
    );
  }),
);

const link = "4f1c2d7e-link-token";

testCase(
  "without full mode a token is stored as it is",
  withKey(undefined, () => {
    assert.equal(sealToken("signing", link), link);
  }),
);

testCase(
  "a sealed token is stable, readable and of one kind only",
  withKey("full", () => {
    const sealed = sealToken("signing", link);
    assert.equal(sealed.includes(link), false);
    assert.equal(sealToken("signing", link), sealed);
    assert.notEqual(sealToken("signing", `${link}x`), sealed);
    assert.notEqual(sealToken("reverseShare", link), sealed);
    assert.equal(openToken("signing", sealed), link);
    assert.throws(() => openToken("reverseShare", sealed));
  }),
);

testCase(
  "a link finds its row whether it was sealed or not",
  withKey("full", async () => {
    const sealed = sealToken("invitation", link);
    const stored = new Map([
      [sealed, "sealed row"],
      ["older-link", "plain row"],
    ]);
    const find = async (value: string) => stored.get(value) ?? null;
    assert.equal(await findByToken("invitation", link, find), "sealed row");
    assert.equal(
      await findByToken("invitation", "older-link", find),
      "plain row",
    );
    assert.equal(await findByToken("invitation", "unknown", find), null);
  }),
);

testCase(
  "a value read from the database opens nothing",
  withKey("full", async () => {
    const sealed = sealToken("invitation", link);
    const find = async (value: string) => (value === sealed ? "row" : null);
    assert.deepEqual(tokenCandidates("invitation", sealed), []);
    assert.equal(await findByToken("invitation", sealed, find), null);
    assert.deepEqual(tokenCandidates("invitation", { token: link }), []);
  }),
);

testCase(
  "without a key a sealed token stops the request",
  withKey("full", () => {
    const sealed = sealToken("guestLink", link);
    delete process.env.CONFIG_ENCRYPTION_KEY_FILE;
    assert.throws(() => openToken("guestLink", sealed));
  }),
);

testCase(
  "every column is sealed at startup and restored by decrypt mode",
  withKey("full", async () => {
    const store = database();
    store.oAuthUser = table([
      {
        id: "o-1",
        userId: "user-1",
        providerUsername: "someone@example.test",
      },
    ]);
    store.signatureRecipient = table([{ id: "r-1", signingToken: link }]);
    store.reverseShare = table([{ id: "s-1", token: link }]);
    await applyAccountEncryption(store as never, key, quiet);

    const signing = store.signatureRecipient.rows[0].signingToken as string;
    assert.equal(signing, sealToken("signing", link));
    assert.equal(
      store.reverseShare.rows[0].token,
      sealToken("reverseShare", link),
    );
    const username = store.oAuthUser.rows[0].providerUsername as string;
    assert.equal(
      openAccountSecret("user-1", "providerUsername", username),
      "someone@example.test",
    );

    await applyAccountEncryption(store as never, key, quiet);
    assert.equal(store.signatureRecipient.rows[0].signingToken, signing);

    process.env.CONFIG_ENCRYPTION_MODE = "decrypt";
    await applyAccountEncryption(store as never, key, quiet);
    assert.equal(store.signatureRecipient.rows[0].signingToken, link);
    assert.equal(store.reverseShare.rows[0].token, link);
    assert.equal(
      store.oAuthUser.rows[0].providerUsername,
      "someone@example.test",
    );
  }),
);

testCase(
  "a push endpoint stored in both forms keeps one row",
  withKey("full", async () => {
    const store = database();
    store.pushSubscription = table([
      {
        id: "p-1",
        userId: "user-1",
        endpoint: "https://push.example.test/1",
        p256dh: "key",
        auth: "secret",
      },
    ]);
    const { updateMany } = store.pushSubscription;
    store.pushSubscription.updateMany = async (args) => {
      if ("endpoint" in args.data) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      return updateMany(args);
    };
    await applyAccountEncryption(store as never, key, quiet);
    assert.equal(store.pushSubscription.rows.length, 0);
  }),
);

void run();
