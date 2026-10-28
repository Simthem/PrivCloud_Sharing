import "reflect-metadata";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as argon from "argon2";
import { AuthService } from "src/auth/auth.service";
import { AuthTotpService } from "src/auth/authTotp.service";
import { createUnitTestRunner } from "./unit-test";
import { createTestCredentials } from "./test-credentials";

const fixtureCredentials = createTestCredentials();

const { testCase, run } = createUnitTestRunner("sign-in attempt races");

type Row = Record<string, unknown>;

const same = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date
    ? a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    : a === b;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR")
      return (condition as Row[]).some((branch) => matches(row, branch));
    if (
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const { lt, lte, gt } = condition as Record<string, number | Date>;
      const value = row[key] as number | Date | null;
      if (value === null) return false;
      if (lt !== undefined) return value < lt;
      if (lte !== undefined) return value <= lte;
      return value > gt;
    }
    return same(row[key], condition);
  });
}

function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      row[key] =
        (row[key] as number) + (value as { increment: number }).increment;
    } else if (value && typeof value === "object" && "decrement" in value) {
      row[key] =
        (row[key] as number) - (value as { decrement: number }).decrement;
    } else {
      row[key] = value;
    }
  }
}

/** Lets `count` callers in, then releases them together. */
function barrier(count: number) {
  let arrived = 0;
  let release: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    if (++arrived === count) release();
    await gate;
  };
}

const settle = (promises: Promise<unknown>[]) =>
  Promise.all(
    promises.map((promise) =>
      promise.then(
        () => 200,
        (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
      ),
    ),
  );

const lockedNow = (user: Row) =>
  user.lockedUntil instanceof Date && user.lockedUntil > new Date();

async function signInHarness(options: {
  attempts?: number;
  lockedUntil?: Date | null;
  lastFailedLoginAt?: Date | null;
  readBarrier?: () => Promise<void>;
  conflictForever?: boolean;
  resetAfterLock?: boolean;
  vanishBeforeFallback?: boolean;
}) {
  let locked: () => void;
  const lockDone = new Promise<void>((resolve) => (locked = resolve));
  let deleted = false;
  const user: Row = {
    id: "user-1",
    email: fixtureCredentials.currentEmail,
    username: "user",
    password: await argon.hash(fixtureCredentials.password),
    failedLoginAttempts: options.attempts ?? 0,
    lastFailedLoginAt: options.lastFailedLoginAt ?? null,
    lockedUntil: options.lockedUntil ?? null,
  };
  const settings: Record<string, unknown> = {
    "security.loginMaxFailures": 5,
    "security.loginBaseLockMinutes": 1,
    "security.loginMaxLockMinutes": 60,
    "security.loginFailureWindowMinutes": 15,
    "oauth.disablePassword": false,
    "ldap.enabled": false,
  };
  const service = Object.create(AuthService.prototype) as AuthService;
  Object.assign(service, {
    config: { get: (key: string) => settings[key] },
    logger: { log: () => undefined, warn: () => undefined },
    generateToken: async () => ({ signedIn: true }),
    prisma: {
      user: {
        findFirst: async () => {
          const snapshot = { ...user };
          await options.readBarrier?.();
          return snapshot;
        },
        findUnique: async () => (deleted ? null : { ...user }),
        update: async ({ data }: { data: Row }) => {
          apply(user, data);
          return { ...user };
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const resets = data.failedLoginAttempts === 0;
          if (options.resetAfterLock && resets) await lockDone;
          if (
            options.conflictForever &&
            "failedLoginAttempts" in where &&
            !("OR" in where)
          )
            return { count: 0 };
          if (options.vanishBeforeFallback && Object.keys(where).length === 1)
            deleted = true;
          if (deleted || !matches(user, where)) return { count: 0 };
          apply(user, data);
          if (lockedNow(user)) locked();
          return { count: 1 };
        },
      },
    },
  });
  const signIn = (password: string) =>
    service.signIn(
      { email: fixtureCredentials.currentEmail, password } as never,
      "ip",
    );
  return { user, signIn, service };
}

testCase("sequential failures keep the lock policy and messages", async () => {
  const { user, signIn } = await signInHarness({});
  const statuses = [];
  for (let i = 0; i < 5; i++)
    statuses.push(
      ...(await settle([signIn(fixtureCredentials.incorrectPassword)])),
    );
  assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
  assert.equal(user.failedLoginAttempts, 5);
  assert.ok(lockedNow(user));
  assert.deepEqual(await settle([signIn(fixtureCredentials.password)]), [429]);
});

testCase(
  "concurrent failures from one snapshot still lock the account",
  async () => {
    const { user, signIn } = await signInHarness({ readBarrier: barrier(5) });
    const statuses = await settle(
      Array.from({ length: 5 }, () =>
        signIn(fixtureCredentials.incorrectPassword),
      ),
    );
    assert.equal(user.failedLoginAttempts, 5);
    assert.ok(lockedNow(user));
    assert.equal(statuses.filter((status) => status === 429).length, 1);
    // The right password does not get through the lock the race produced.
    assert.deepEqual(
      await settle([signIn(fixtureCredentials.password)]),
      [429],
    );
  },
);

testCase("a locked account refuses even the right password", async () => {
  const lockedUntil = new Date(Date.now() + 60_000);
  const { user, signIn } = await signInHarness({ attempts: 5, lockedUntil });
  assert.deepEqual(await settle([signIn(fixtureCredentials.password)]), [429]);
  assert.equal(user.failedLoginAttempts, 5);
  assert.equal((user.lockedUntil as Date).getTime(), lockedUntil.getTime());
});

testCase(
  "a success resets the counter, a stale failure cannot undo it",
  async () => {
    const { user, signIn, service } = await signInHarness({
      attempts: 3,
      lastFailedLoginAt: new Date(),
    });
    const stale = { ...user };
    assert.deepEqual(
      await settle([signIn(fixtureCredentials.password)]),
      [200],
    );
    await (
      service as unknown as {
        recordLoginFailure: (snapshot: Row) => Promise<unknown>;
      }
    ).recordLoginFailure(stale);
    assert.equal(user.failedLoginAttempts, 1);
    assert.equal(user.lockedUntil, null);
  },
);

testCase(
  "a success does not lift a lock a concurrent failure set",
  async () => {
    const { user, signIn } = await signInHarness({
      attempts: 4,
      lastFailedLoginAt: new Date(),
      readBarrier: barrier(2),
      resetAfterLock: true,
    });
    // Both passed the lock check, then the failure locks before the success
    // resets.
    const statuses = await settle([
      signIn(fixtureCredentials.password),
      signIn(fixtureCredentials.incorrectPassword),
    ]);
    assert.deepEqual(statuses, [429, 429]);
    assert.equal(user.failedLoginAttempts, 5);
    assert.ok(lockedNow(user));
  },
);

testCase("an account deleted meanwhile is a plain failure", async () => {
  const { signIn } = await signInHarness({
    attempts: 1,
    lastFailedLoginAt: new Date(),
    conflictForever: true,
    vanishBeforeFallback: true,
  });
  assert.deepEqual(
    await settle([signIn(fixtureCredentials.incorrectPassword)]),
    [401],
  );
});

testCase("persistent contention still counts and locks", async () => {
  const { user, signIn } = await signInHarness({
    attempts: 4,
    lastFailedLoginAt: new Date(),
    conflictForever: true,
  });
  assert.deepEqual(
    await settle([signIn(fixtureCredentials.incorrectPassword)]),
    [429],
  );
  assert.equal(user.failedLoginAttempts, 5);
  assert.ok(lockedNow(user));
});

testCase("a contended failure never shortens an existing lock", async () => {
  const { user, service } = await signInHarness({ conflictForever: true });
  // Another request locked the account for an hour after this one read it.
  const longer = new Date(Date.now() + 3_600_000);
  Object.assign(user, {
    failedLoginAttempts: 5,
    lastFailedLoginAt: new Date(),
    lockedUntil: longer,
  });
  const failure = await (
    service as unknown as {
      recordLoginFailure: (snapshot: Row) => Promise<{ lockedUntil: Date }>;
    }
  ).recordLoginFailure({
    id: "user-1",
    failedLoginAttempts: 0,
    lastFailedLoginAt: null,
    lockedUntil: null,
  });
  assert.equal(user.failedLoginAttempts, 6);
  assert.ok((user.lockedUntil as Date).getTime() >= longer.getTime());
  // The retry hint is the lock really in force, not a shorter local one.
  assert.equal(
    failure.lockedUntil.getTime(),
    (user.lockedUntil as Date).getTime(),
  );
});

function totpHarness(options: { verifyBarrier?: () => Promise<void> }) {
  const tokenHash = crypto
    .createHash("sha256")
    .update(fixtureCredentials.loginToken)
    .digest("hex");
  const token: Row = {
    token: tokenHash,
    used: false,
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: "user-1",
      email: fixtureCredentials.currentEmail,
      totpSecret: fixtureCredentials.totpSecret,
    },
  };
  let verifications = 0;
  let sessions = 0;
  const service = Object.create(AuthTotpService.prototype) as AuthTotpService;
  Object.assign(service, {
    verifyTotpOrBackup: async (_id: string, _secret: string, code: string) => {
      verifications++;
      await options.verifyBarrier?.();
      return code === fixtureCredentials.code;
    },
    authService: {
      countReauthentication: async (
        _id: string,
        verify: () => Promise<boolean>,
      ) => verify(),
      clearLoginFailures: async () => undefined,
      createRefreshToken: async () => {
        sessions++;
        return {
          refreshToken: fixtureCredentials.refreshToken,
          refreshTokenId: "id",
        };
      },
      createAccessToken: async () => fixtureCredentials.accessToken,
    },
    prisma: {
      loginToken: {
        findFirst: async ({ where }: { where: Row }) =>
          where.token === tokenHash ? { ...token } : null,
        update: async ({ data }: { data: Row }) => apply(token, data),
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          if (!matches(token, where)) return { count: 0 };
          apply(token, data);
          return { count: 1 };
        },
      },
    },
  });
  const submit = (totp: string) =>
    (
      service as unknown as {
        signInTotp: (dto: {
          loginToken: string;
          totp: string;
        }) => Promise<unknown>;
      }
    ).signInTotp({ loginToken: fixtureCredentials.loginToken, totp });
  return {
    token,
    submit,
    verifications: () => verifications,
    sessions: () => sessions,
  };
}

testCase("a login token opens one session only", async () => {
  const { submit, sessions } = totpHarness({ verifyBarrier: barrier(2) });
  const statuses = await settle([
    submit(fixtureCredentials.code),
    submit(fixtureCredentials.code),
  ]);
  assert.deepEqual([...statuses].sort(), [200, 401]);
  assert.equal(sessions(), 1);
});

testCase(
  "a login token checks at most five codes under concurrency",
  async () => {
    const { token, submit, verifications, sessions } = totpHarness({
      verifyBarrier: barrier(5),
    });
    const statuses = await settle(
      Array.from({ length: 12 }, () =>
        submit(fixtureCredentials.incorrectCode),
      ),
    );
    assert.equal(statuses.filter((status) => status === 400).length, 5);
    assert.equal(statuses.filter((status) => status === 401).length, 7);
    assert.equal(verifications(), 5);
    assert.equal(token.attempts, 5);
    assert.deepEqual(await settle([submit(fixtureCredentials.code)]), [401]);
    assert.equal(sessions(), 0);
  },
);

const deadline = setTimeout(() => {
  throw new Error("Sign-in race tests did not complete");
}, 30_000);
void run().finally(() => clearTimeout(deadline));
