import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as argon from "argon2";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { AuthService } from "src/auth/auth.service";
import { AuthTotpService } from "src/auth/authTotp.service";

// Sign-in counters under real interleaving: every failure counted, the lock
// reached and a login token spent once, on a migrated SQLite database.
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "privcloud-sign-in-races-"));
  const connectionString = `file:${join(directory, "fixture.db")}`;
  await writeFile(join(directory, "fixture.db"), "");
  try {
    execFileSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: connectionString },
        stdio: "pipe",
      },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: connectionString }),
  });
  const password = await argon.hash("right-password");

  async function account(failedLoginAttempts = 0) {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        username: `race-${id.slice(0, 8)}`,
        email: `race-${id}@example.test`,
        password,
        failedLoginAttempts,
        lastFailedLoginAt: failedLoginAttempts ? new Date() : null,
      },
    });
    return id;
  }

  function signInService(maxFailures: number) {
    let userWrites = 0;
    const settings: Record<string, unknown> = {
      "security.loginMaxFailures": maxFailures,
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
          findFirst: prisma.user.findFirst.bind(prisma.user),
          findUnique: prisma.user.findUnique.bind(prisma.user),
          update: prisma.user.update.bind(prisma.user),
          updateMany: (args: never) => {
            userWrites++;
            return prisma.user.updateMany(args);
          },
        },
      },
    });
    const signIn = (id: string, attempt: string) =>
      prisma.user
        .findUniqueOrThrow({ where: { id }, select: { email: true } })
        .then(({ email }) =>
          service.signIn({ email, password: attempt } as never, "ip"),
        )
        .then(
          () => 200,
          (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
        );
    return { signIn, service, writes: () => userWrites };
  }

  /** The real sign-in counters, with a known code and sessions counted. */
  function codeService(
    auth: AuthService,
    onSession: () => void = () => undefined,
  ) {
    const totp = Object.create(AuthTotpService.prototype) as AuthTotpService;
    Object.assign(totp, {
      prisma,
      verifyTotpOrBackup: async (_id: string, _s: string, code: string) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return code === "123456";
      },
      authService: Object.assign(Object.create(auth) as AuthService, {
        createRefreshToken: async () => {
          onSession();
          return { refreshToken: "refresh", refreshTokenId: "id" };
        },
        createAccessToken: async () => "access",
      }),
    });
    return totp;
  }

  async function loginToken(userId: string) {
    const raw = randomUUID();
    await prisma.loginToken.create({
      data: {
        token: createHash("sha256").update(raw).digest("hex"),
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return raw;
  }

  const row = (id: string) =>
    prisma.user.findUniqueOrThrow({
      where: { id },
      select: { failedLoginAttempts: true, lockedUntil: true },
    });

  try {
    // A failure that meets no contention is written by its compare-and-set,
    // so the timestamp equality really matches what the database returns.
    {
      const id = await account(1);
      const { signIn, writes } = signInService(1000);
      assert.equal(await signIn(id, "bad"), 401);
      assert.equal(writes(), 1);
      assert.equal((await row(id)).failedLoginAttempts, 2);
    }

    // No failure is lost, however many land together.
    {
      const id = await account();
      const { signIn } = signInService(1000);
      const statuses = await Promise.all(
        Array.from({ length: 40 }, () => signIn(id, "bad")),
      );
      assert.ok(statuses.every((status) => status === 401));
      assert.equal((await row(id)).failedLoginAttempts, 40);
    }

    // A burst reaches the lock, and the lock then holds the right password.
    {
      const id = await account();
      const { signIn } = signInService(5);
      const statuses = await Promise.all(
        Array.from({ length: 20 }, () => signIn(id, "bad")),
      );
      assert.ok(statuses.every((status) => [401, 429].includes(status)));
      const after = await row(id);
      assert.ok(after.failedLoginAttempts >= 5);
      assert.ok(after.lockedUntil && after.lockedUntil > new Date());
      assert.equal(await signIn(id, "right-password"), 429);
    }

    // A fresh login token, many right codes at once: one session.
    {
      const id = await account();
      await prisma.user.update({
        where: { id },
        data: { totpSecret: "SECRET" },
      });
      let sessions = 0;
      const totp = codeService(signInService(1000).service, () => sessions++);
      const second = randomUUID();
      await prisma.loginToken.create({
        data: {
          token: createHash("sha256").update(second).digest("hex"),
          userId: id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          totp.signInTotp({ loginToken: second, totp: "123456" } as never).then(
            () => 200,
            (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
          ),
        ),
      );
      assert.equal(results.filter((status) => status === 200).length, 1);
      assert.equal(sessions, 1);
    }

    // Each guess is counted before it is checked: a burst holding the right
    // password gets no more checks than the limit allows.
    {
      const id = await account();
      const { signIn } = signInService(3);
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () => signIn(id, "right-password")),
      );
      assert.ok(statuses.filter((status) => status === 200).length <= 3);
      assert.ok(statuses.filter((status) => status === 429).length >= 7);
    }

    // Wrong codes count towards both the account lock and the token cap.
    {
      const id = await account();
      await prisma.user.update({
        where: { id },
        data: { totpSecret: "SECRET", totpVerified: true },
      });
      const { signIn, service } = signInService(3);
      const totp = codeService(service);
      const submit = (raw: string, code: string) =>
        totp.signInTotp({ loginToken: raw, totp: code } as never).then(
          () => 200,
          (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
        );
      assert.equal(await signIn(id, "right-password"), 200);
      const raw = await loginToken(id);
      assert.equal(await submit(raw, "000000"), 400);
      assert.equal(await submit(raw, "000001"), 400);
      assert.equal((await row(id)).failedLoginAttempts, 2);
      assert.equal(await submit(raw, "000002"), 429);
      assert.equal(await submit(raw, "123456"), 429);
      assert.equal(await signIn(id, "right-password"), 429);

      const other = await account();
      await prisma.user.update({
        where: { id: other },
        data: { totpSecret: "SECRET", totpVerified: true },
      });
      assert.equal(await submit(await loginToken(other), "000000"), 400);
      assert.equal(await submit(await loginToken(other), "123456"), 200);
      assert.equal((await row(other)).failedLoginAttempts, 0);
    }

    // A token minted without the new column by an older backend receives the
    // database default. Parallel requests can check at most five codes even
    // when account policy allows more failures.
    {
      const id = await account();
      await prisma.user.update({
        where: { id },
        data: { totpSecret: "SECRET", totpVerified: true },
      });
      const raw = await loginToken(id);
      const hash = createHash("sha256").update(raw).digest("hex");
      assert.equal(
        (await prisma.loginToken.findUniqueOrThrow({ where: { token: hash } }))
          .attempts,
        0,
      );
      const { service } = signInService(1000);
      const totp = codeService(service);
      const statuses = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          totp
            .signInTotp({
              loginToken: raw,
              totp: `0000${String(index).padStart(2, "0")}`,
            } as never)
            .then(
              () => 200,
              (error: { getStatus?: () => number }) =>
                error.getStatus?.() ?? 500,
            ),
        ),
      );
      assert.equal(statuses.filter((status) => status === 400).length, 5);
      assert.equal(statuses.filter((status) => status === 401).length, 7);
      assert.equal(
        (await prisma.loginToken.findUniqueOrThrow({ where: { token: hash } }))
          .attempts,
        5,
      );
      assert.equal((await row(id)).failedLoginAttempts, 5);
    }

    // Real backup-code storage still consumes a valid code only after a
    // reserved token attempt. An exhausted token cannot burn a backup code.
    {
      const id = await account();
      await prisma.user.update({
        where: { id },
        data: { totpSecret: "SECRET", totpVerified: true },
      });
      const backup = await prisma.totpBackupCode.create({
        data: { userId: id, codeHash: await argon.hash("A1B2C3D4") },
      });
      const { service } = signInService(1000);
      const realTotp = Object.create(
        AuthTotpService.prototype,
      ) as AuthTotpService;
      Object.assign(realTotp, {
        prisma,
        authService: Object.assign(Object.create(service) as AuthService, {
          createRefreshToken: async () => ({
            refreshToken: "refresh",
            refreshTokenId: "id",
          }),
          createAccessToken: async () => "access",
        }),
      });
      const submit = (raw: string, code: string) =>
        realTotp.signInTotp({ loginToken: raw, totp: code } as never).then(
          () => 200,
          (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
        );
      const exhausted = await loginToken(id);
      for (let index = 0; index < 5; index++) {
        assert.equal(await submit(exhausted, `BADCODE${index}`), 400);
      }
      assert.equal(await submit(exhausted, "A1B2C3D4"), 401);
      assert.equal(
        (
          await prisma.totpBackupCode.findUniqueOrThrow({
            where: { id: backup.id },
          })
        ).usedAt,
        null,
      );
      const fresh = await loginToken(id);
      assert.equal(await submit(fresh, "A1B2C3D4"), 200);
      assert.ok(
        (
          await prisma.totpBackupCode.findUniqueOrThrow({
            where: { id: backup.id },
          })
        ).usedAt,
      );
      assert.equal(await submit(fresh, "A1B2C3D4"), 401);
    }

    // Once a lock has run out, the next attempt is checked like any other.
    {
      const id = await account();
      await prisma.user.update({
        where: { id },
        data: {
          failedLoginAttempts: 5,
          lastFailedLoginAt: new Date(Date.now() - 120_000),
          lockedUntil: new Date(Date.now() - 1_000),
        },
      });
      const { signIn } = signInService(5);
      assert.equal(await signIn(id, "right-password"), 200);
      const after = await row(id);
      assert.equal(after.failedLoginAttempts, 0);
      assert.equal(after.lockedUntil, null);
    }

    // A directory sign-in under a name that belongs to another local account
    // leaves that account's count as it was.
    {
      const bystander = await account();
      const directoryUser = await account();
      const { signIn, service } = signInService(5);
      const config = (
        service as unknown as { config: { get(key: string): unknown } }
      ).config;
      Object.assign(service, {
        config: {
          get: (key: string) =>
            key === "ldap.enabled" ? true : config.get(key),
        },
        logger: {
          log: () => undefined,
          warn: () => undefined,
          debug: () => undefined,
        },
        ldapService: {
          authenticateUser: async () => ({ dn: "uid=directory,dc=test" }),
        },
        userService: {
          findOrCreateFromLDAP: async () =>
            prisma.user.findUniqueOrThrow({ where: { id: directoryUser } }),
        },
      });
      assert.equal(await signIn(bystander, "directory-password"), 200);
      assert.equal((await row(bystander)).failedLoginAttempts, 0);
    }

    console.log("SQLite sign-in attempt races passed");
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
