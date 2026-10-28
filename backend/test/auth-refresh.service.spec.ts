import "reflect-metadata";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { AuthService } from "src/auth/auth.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("distributed auth refresh");

type Row = Record<string, unknown>;
type RefreshRow = Row & { token: string };
type ReplayRow = Row & {
  previousTokenHash: string;
  expiresAt: Date;
  encryptedResult: string | null;
};

testCase("two replicas return the exact same persisted rotation", async () => {
  const secret = crypto.randomBytes(32).toString("base64url");
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const oldHash = crypto
    .createHmac("sha256", secret)
    .update(rawToken)
    .digest("hex");
  const user = {
    id: "user-1",
    email: "user@example.test",
    isAdmin: false,
    emailVerificationRequiredAt: null,
    emailVerifiedAt: new Date(),
    emailVerificationDeletionStartedAt: null,
  };

  const refreshTokens = new Map<string, RefreshRow>([
    [
      oldHash,
      {
        id: "refresh-old",
        token: oldHash,
        expiresAt: new Date(Date.now() + 60_000),
        oauthIDToken: null,
        user,
      },
    ],
  ]);
  const replays = new Map<string, ReplayRow>();
  const calls = { create: 0, sign: 0, transactions: 0 };

  let transactionTail = Promise.resolve();
  const prisma = {
    refreshToken: {
      findUnique: async ({ where }: { where: { token: string } }) =>
        refreshTokens.get(where.token) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { token: string };
        data: Row;
      }) => {
        const row = refreshTokens.get(where.token);
        assert(row);
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: RefreshRow }) => {
        calls.create++;
        const row = {
          ...data,
          id: `refresh-new-${calls.create}`,
          user,
        };
        refreshTokens.set(data.token, row);
        return row;
      },
    },
    refreshTokenReplay: {
      deleteMany: async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        let count = 0;
        for (const [key, replay] of replays) {
          if (replay.expiresAt < where.expiresAt.lt) {
            replays.delete(key);
            count++;
          }
        }
        return { count };
      },
      findUnique: async ({ where }: { where: { previousTokenHash: string } }) =>
        replays.get(where.previousTokenHash) ?? null,
      create: async ({ data }: { data: ReplayRow }) => {
        if (replays.has(data.previousTokenHash)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const row = {
          ...data,
          encryptedResult: null,
          createdAt: new Date(),
        };
        replays.set(data.previousTokenHash, row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { previousTokenHash: string };
        data: Row;
      }) => {
        const row = replays.get(where.previousTokenHash);
        assert(row);
        Object.assign(row, data);
        return row;
      },
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      calls.transactions++;
      try {
        return await work(prisma);
      } finally {
        release();
      }
    },
  };

  const jwtService = {
    sign: (payload: { refreshTokenId: string }) => {
      calls.sign++;
      return `access-${payload.refreshTokenId}`;
    },
  };
  const config = {
    get: (key: string) => {
      if (key === "internal.jwtSecret") return secret;
      if (key === "general.sessionDuration") {
        return { value: 3, unit: "months" };
      }
      return undefined;
    },
  };
  const dependencies = [
    prisma,
    jwtService,
    config,
    {},
    {},
    {},
    {},
    {},
  ] as unknown as ConstructorParameters<typeof AuthService>;
  const firstReplica = new AuthService(...dependencies);
  const secondReplica = new AuthService(...dependencies);

  const [first, second] = await Promise.all([
    firstReplica.refreshAccessToken(rawToken),
    secondReplica.refreshAccessToken(rawToken),
  ]);

  assert.deepEqual(second, first);
  assert.equal(calls.create, 1);
  assert.equal(calls.sign, 1);
  assert(calls.transactions >= 1);
  assert.equal(replays.size, 1);
  const stored = replays.get(oldHash);
  assert.equal(typeof stored.encryptedResult, "string");
  assert.equal(stored.encryptedResult.includes(first.refreshToken), false);
  assert.equal(stored.encryptedResult.includes(first.accessToken), false);
});

void run();
