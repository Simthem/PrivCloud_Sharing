import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as argon from "argon2";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { AuthService } from "src/auth/auth.service";
import { AuthTotpService } from "src/auth/authTotp.service";
import { EmailChangeService } from "src/auth/emailChange.service";
import { OAuthReauthService } from "src/auth/oauthReauth.service";
import { OutboxEmail } from "src/email/email-outbox.crypto";
import { UserSevice } from "src/user/user.service";
import { createTestCredentials } from "./test-credentials";

const fixtureCredentials = createTestCredentials();

async function main() {
  const directory = await mkdtemp(join(tmpdir(), "privcloud-email-change-"));
  const database = `file:${join(directory, "account.db")}`;
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: database }),
  });
  try {
    await writeFile(join(directory, "account.db"), "");
    execFileSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: database },
        stdio: "pipe",
      },
    );
    const password = fixtureCredentials.password;
    const encodedPassword = await argon.hash(password);
    async function account(
      options: {
        passwordless?: boolean;
        mfa?: boolean;
        smtp?: boolean;
        ldap?: boolean;
      } = {},
    ) {
      const id = randomUUID();
      const email = `${id}@example.test`;
      const next = `next-${id}@example.test`;
      await prisma.user.create({
        data: {
          id,
          username: id,
          email,
          // Proven unless a case says otherwise: inserts start unverified.
          emailVerifiedAt: new Date(),
          password: options.passwordless ? null : encodedPassword,
          ldapDN: options.ldap ? `uid=${id},dc=example,dc=test` : null,
          totpEnabled: !!options.mfa,
          totpVerified: !!options.mfa,
          totpSecret: options.mfa ? fixtureCredentials.totpSecret : null,
          encryptionKeyHash: "e".repeat(64),
          refreshTokens: {
            create: {
              token: randomUUID(),
              expiresAt: new Date(Date.now() + 3600_000),
            },
          },
          wrappedKeys: {
            create: {
              credentialId: randomUUID(),
              wrappedKey: "wrapped",
              salt: "salt",
            },
          },
          accountPasskeys: {
            create: {
              credentialId: randomUUID(),
              publicKey: Buffer.from("public-key"),
              publicKeyAlgorithm: -7,
              counter: 3n,
              deviceType: "singleDevice",
            },
          },
        },
      });
      if (options.mfa)
        await prisma.totpBackupCode.create({
          data: { userId: id, codeHash: await argon.hash("ABCD1234") },
        });
      const settings: Record<string, unknown> = {
        "smtp.enabled": options.smtp !== false,
        "general.appUrl": "https://example.test",
        "oauth.disablePassword": false,
        "security.loginMaxFailures": 3,
        "security.loginBaseLockMinutes": 15,
        "security.loginMaxLockMinutes": 60,
        "security.loginFailureWindowMinutes": 15,
      };
      const config = { get: (key: string) => settings[key] };
      const recovery: Array<{ recipient: string; token: string }> = [];
      const notices: OutboxEmail[] = [];
      const auth = Object.create(AuthService.prototype) as AuthService;
      Object.assign(auth, {
        prisma,
        config,
        logger: { warn: () => undefined },
        emailService: {
          sendResetPasswordEmail: async (recipient: string, token: string) => {
            recovery.push({ recipient, token });
          },
        },
      });
      const factors = Object.create(
        AuthTotpService.prototype,
      ) as AuthTotpService;
      Object.assign(factors, { prisma, authService: auth });
      const oauth = new OAuthReauthService(prisma as never);
      const change = new EmailChangeService(
        prisma as never,
        config as never,
        auth,
        factors,
        oauth,
        {
          enqueue: async (_tx: unknown, message: OutboxEmail) => {
            notices.push(message);
          },
          deliverPending: async () => undefined,
        } as never,
      );
      const state = () =>
        prisma.user.findUniqueOrThrow({
          where: { id },
          select: {
            password: true,
            encryptionKeyHash: true,
            refreshTokens: true,
            accountPasskeys: true,
            wrappedKeys: true,
          },
        });
      const start = (code?: string) =>
        change.initiate(id, {
          email: next,
          password: options.passwordless ? undefined : password,
          code,
        });
      const token = (recipient: string, action: string) => {
        const message = notices.find(
          (notice) => notice.recipient === recipient,
        );
        assert.ok(message);
        const match = message.text.match(
          new RegExp(`action=${action}&token=([A-Za-z0-9_-]{43})`),
        );
        assert.ok(match);
        return match[1];
      };
      return {
        id,
        email,
        next,
        auth,
        change,
        recovery,
        notices,
        state,
        start,
        old: () => token(email, "confirm"),
        verify: () => token(next, "confirm"),
        cancel: () => token(email, "cancel"),
      };
    }

    for (const order of ["old", "new"]) {
      const f = await account({ passwordless: true });
      const original = await f.state();
      await prisma.emailVerificationToken.create({
        data: {
          userId: f.id,
          email: f.email,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await f.start();
      assert.equal(f.notices.length, 2);
      const stored = await prisma.emailChangeRequest.findUniqueOrThrow({
        where: { userId: f.id },
      });
      assert.match(stored.oldTokenHash, /^[a-f0-9]{64}$/);
      assert.notEqual(stored.oldTokenHash, f.old());
      await f.auth.requestResetPassword(f.next);
      assert.equal(f.recovery.length, 0);
      const first = order === "old" ? f.old() : f.verify();
      const second = order === "old" ? f.verify() : f.old();
      assert.deepEqual(await f.change.confirm(first), { changed: false });
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.id } })).email,
        f.email,
      );
      await assert.rejects(f.change.confirm(first));
      await assert.rejects(f.change.confirm(f.cancel()));
      assert.deepEqual(await f.change.confirm(second), { changed: true });
      assert.deepEqual(await f.state(), original);
      assert.equal(
        await prisma.emailVerificationToken.count({ where: { userId: f.id } }),
        0,
      );
      await assert.rejects(f.change.cancel(f.cancel()));
      await f.auth.requestResetPassword(f.email);
      assert.equal(f.recovery.length, 0);
      await f.auth.requestResetPassword(f.next);
      assert.equal(f.recovery.length, 1);
      assert.equal(f.recovery[0].recipient, f.next);
      await f.auth.resetPassword(
        f.recovery[0].token,
        fixtureCredentials.updatedPassword,
      );
      const updated = await f.state();
      assert.equal(updated.refreshTokens.length, 0);
      assert.ok(
        await argon.verify(
          updated.password!,
          fixtureCredentials.updatedPassword,
        ),
      );
      assert.deepEqual(updated.accountPasskeys, original.accountPasskeys);
      assert.deepEqual(updated.wrappedKeys, original.wrappedKeys);
      assert.equal(updated.encryptionKeyHash, original.encryptionKeyHash);
    }

    const disabled = await account({ smtp: false });
    await assert.rejects(disabled.start(), /Email delivery is unavailable/);
    const directoryAccount = await account({ ldap: true });
    await assert.rejects(directoryAccount.start(), /managed by your directory/);
    const protectedAccount = await account({ mfa: true });
    await assert.rejects(protectedAccount.start(), /Invalid code/);
    await protectedAccount.start("ABCD1234");
    assert.ok(
      (
        await prisma.totpBackupCode.findFirstOrThrow({
          where: { userId: protectedAccount.id },
        })
      ).usedAt,
    );
    await prisma.totpBackupCode.create({
      data: {
        userId: protectedAccount.id,
        codeHash: await argon.hash("EFGH5678"),
      },
    });
    await assert.rejects(protectedAccount.start("EFGH5678"), /Wait one minute/);
    assert.equal(
      await prisma.totpBackupCode.count({
        where: { userId: protectedAccount.id, usedAt: null },
      }),
      1,
    );
    const f = await account();
    await assert.rejects(
      f.change.initiate(f.id, {
        email: f.next,
        password: fixtureCredentials.incorrectPassword,
      }),
      /Invalid password/,
    );
    await f.start();
    await assert.rejects(f.start(), /Wait one minute/);
    await prisma.emailChangeRequest.update({
      where: { userId: f.id },
      data: { expiresAt: new Date(0) },
    });
    await assert.rejects(f.change.confirm(f.old()));

    const typo = await account();
    await prisma.user.update({
      where: { id: typo.id },
      data: { emailVerificationRequiredAt: new Date(), emailVerifiedAt: null },
    });
    assert.deepEqual(await typo.start(), {
      pending: true,
      currentAddressApproval: false,
    });
    assert.deepEqual(
      typo.notices.map((notice) => notice.recipient),
      [typo.next],
    );
    assert.deepEqual(await typo.change.confirm(typo.verify()), {
      changed: true,
    });
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: typo.id } })).email,
      typo.next,
    );

    const purged = await account();
    await purged.start();
    await purged.change.confirm(purged.old());
    await prisma.user.update({
      where: { id: purged.id },
      data: { emailVerificationDeletionStartedAt: new Date() },
    });
    await assert.rejects(purged.change.confirm(purged.verify()));
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: purged.id } })).email,
      purged.email,
    );

    for (const kind of ["cancel", "reset"]) {
      for (const winner of ["first-action", "confirmation"]) {
        const f = await account();
        await f.start();
        await f.change.confirm(f.old());
        await f.auth.requestResetPassword(f.email);
        const reset = f.recovery[0].token;
        const action = (db: PrismaClient) =>
          kind === "cancel"
            ? clone(f.change, db).cancel(f.cancel())
            : clone(f.auth, db).resetPassword(
                reset,
                fixtureCredentials.replacementPassword,
              );
        const confirm = (db: PrismaClient) =>
          clone(f.change, db).confirm(f.verify());
        const outcomes = await serializePair(
          prisma,
          winner === "first-action" ? action : confirm,
          winner === "first-action" ? confirm : action,
        );
        assert.equal(outcomes[0].status, "fulfilled");
        assert.equal(outcomes[1].status, "rejected");
        if (outcomes[1].status === "rejected")
          assert.equal(
            (outcomes[1].reason as { getStatus?: () => number }).getStatus?.(),
            400,
          );
        const current = await prisma.user.findUniqueOrThrow({
          where: { id: f.id },
        });
        assert.equal(
          current.email,
          winner === "confirmation" ? f.next : f.email,
        );
        if (winner === "confirmation") {
          assert.equal(
            await prisma.resetPasswordToken.count({ where: { userId: f.id } }),
            0,
          );
          await assert.rejects(
            f.auth.resetPassword(reset, fixtureCredentials.replacementPassword),
          );
        }
      }
    }

    for (const requestFirst of [true, false]) {
      const f = await account();
      await f.start();
      await f.change.confirm(f.old());
      const request = (db: PrismaClient) =>
        clone(f.auth, db).requestResetPassword(f.email);
      const confirm = (db: PrismaClient) =>
        clone(f.change, db).confirm(f.verify());
      const results = await serializePair(
        prisma,
        requestFirst ? request : confirm,
        requestFirst ? confirm : request,
      );
      assert.ok(results.every((result) => result.status === "fulfilled"));
      assert.equal(
        await prisma.resetPasswordToken.count({ where: { userId: f.id } }),
        0,
      );
      for (const recovery of f.recovery)
        await assert.rejects(
          f.auth.resetPassword(
            recovery.token,
            fixtureCredentials.replacementPassword,
          ),
        );
    }

    for (const data of [
      { password: fixtureCredentials.updatedPasswordHash },
      { totpVerified: true },
      { email: `${randomUUID()}@example.test` },
    ]) {
      const f = await account();
      await f.start();
      await f.change.confirm(f.old());
      await prisma.user.update({ where: { id: f.id }, data });
      await assert.rejects(f.change.confirm(f.verify()));
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const f = await account();
      await f.start();
      const answers = await Promise.all([
        f.change.confirm(f.old()),
        f.change.confirm(f.verify()),
      ]);
      assert.equal(answers.filter((answer) => answer.changed).length, 1);
    }
    // An administrator replaces the address, then the password: the reset link
    // and the pending change mailed earlier die with the first, the sessions
    // with the second. Their own account goes through the proven flows.
    {
      const f = await account();
      await f.start();
      await f.auth.requestResetPassword(f.email);
      const users = Object.create(UserSevice.prototype) as UserSevice;
      Object.assign(users, {
        prisma,
        emailVerificationService: {
          isDeliveryAvailable: () => true,
          issueAndSend: async () => undefined,
        },
        logger: { warn: () => undefined },
      });
      const administrator = randomUUID();
      const replaced = `admin-${f.id}@example.test`;
      await users.update(f.id, { email: replaced }, administrator);
      const sessions = () =>
        prisma.refreshToken.count({ where: { userId: f.id } });
      assert.equal(
        await prisma.resetPasswordToken.count({ where: { userId: f.id } }),
        0,
      );
      assert.equal(
        await prisma.emailChangeRequest.count({ where: { userId: f.id } }),
        0,
      );
      assert.equal(await sessions(), 1);
      await assert.rejects(f.change.confirm(f.old()));
      await assert.rejects(
        f.auth.resetPassword(f.recovery[0].token, "taken-over"),
      );
      await users.update(
        f.id,
        { password: fixtureCredentials.updatedPassword },
        administrator,
      );
      assert.equal(await sessions(), 0);
      await assert.rejects(
        users.update(f.id, { email: `self-${f.id}@example.test` }, f.id),
        /account settings/,
      );
      await assert.rejects(
        users.update(
          f.id,
          { password: fixtureCredentials.updatedPassword },
          f.id,
        ),
        /account settings/,
      );
      const row = await prisma.user.findUniqueOrThrow({ where: { id: f.id } });
      assert.equal(row.email, replaced);
      assert.ok(
        await argon.verify(row.password!, fixtureCredentials.updatedPassword),
      );
    }
    // Re-authentication counts towards the per-account lock: a stolen session
    // cannot guess the current password beside it, and a locked account
    // confirms nothing, not even with the right password.
    {
      const f = await account();
      const row = () => prisma.user.findUniqueOrThrow({ where: { id: f.id } });
      const attempt = async (current: string) =>
        f.auth.updatePassword(
          await row(),
          fixtureCredentials.replacementPassword,
          current,
        );
      const status =
        (expected: number) => (error: { getStatus?: () => number }) =>
          error.getStatus?.() === expected;
      await assert.rejects(
        attempt(fixtureCredentials.incorrectPassword),
        status(403),
      );
      await assert.rejects(
        attempt(fixtureCredentials.incorrectPassword),
        status(403),
      );
      await assert.rejects(
        attempt(fixtureCredentials.incorrectPassword),
        status(429),
      );
      await assert.rejects(attempt(password), status(429));
      await assert.rejects(f.start(), status(429));
      const locked = await row();
      assert.equal(locked.failedLoginAttempts, 3);
      assert.ok(locked.lockedUntil && locked.lockedUntil > new Date());
      assert.ok(await argon.verify(locked.password!, password));
    }
    // Parallel guesses are each counted before any is checked: no more than
    // the limit get a check. The emailed reset link still works afterwards,
    // and restarts the count.
    {
      const f = await account();
      let checks = 0;
      const guess = () =>
        f.auth.countReauthentication(f.id, async () => {
          checks++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return false;
        });
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, guess),
      );
      assert.equal(checks, 3);
      assert.equal(
        results.filter(
          (result) =>
            result.status === "rejected" &&
            (result.reason as { getStatus?: () => number }).getStatus?.() ===
              429,
        ).length,
        8,
      );
      await f.auth.requestResetPassword(f.email);
      await f.auth.resetPassword(
        f.recovery[f.recovery.length - 1].token,
        fixtureCredentials.resetPassword,
      );
      const reset = await prisma.user.findUniqueOrThrow({
        where: { id: f.id },
      });
      assert.equal(reset.failedLoginAttempts, 0);
      assert.equal(reset.lockedUntil, null);
    }
    // The right password on the last allowed attempt is accepted, and gives
    // back the attempt and the lock it had reserved.
    {
      const f = await account();
      const row = () => prisma.user.findUniqueOrThrow({ where: { id: f.id } });
      const attempt = async (current: string) =>
        f.auth.updatePassword(
          await row(),
          fixtureCredentials.replacementPassword,
          current,
        );
      await assert.rejects(attempt(fixtureCredentials.incorrectPassword));
      await assert.rejects(attempt(fixtureCredentials.incorrectPassword));
      await attempt(password);
      const accepted = await row();
      assert.ok(
        await argon.verify(
          accepted.password!,
          fixtureCredentials.replacementPassword,
        ),
      );
      assert.equal(accepted.failedLoginAttempts, 2);
      assert.equal(accepted.lockedUntil, null);
    }
    // A 2FA code typed to confirm a change counts like a password.
    {
      const f = await account({ mfa: true });
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(f.start(fixtureCredentials.incorrectCode));
      }
      const locked = await prisma.user.findUniqueOrThrow({
        where: { id: f.id },
      });
      assert.equal(locked.failedLoginAttempts, 3);
      assert.ok(locked.lockedUntil && locked.lockedUntil > new Date());
    }
    // Once a lock has run out, a re-authentication is checked again.
    {
      const f = await account();
      await prisma.user.update({
        where: { id: f.id },
        data: {
          failedLoginAttempts: 3,
          lastFailedLoginAt: new Date(Date.now() - 120_000),
          lockedUntil: new Date(Date.now() - 1_000),
        },
      });
      assert.equal(
        await f.auth.countReauthentication(f.id, async () => true),
        true,
      );
      assert.equal(
        (await prisma.user.findUniqueOrThrow({ where: { id: f.id } }))
          .lockedUntil,
        null,
      );
    }
    console.log("SQLite email change and recovery integration passed");
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

function clone<T extends object>(service: T, prisma: PrismaClient): T {
  return Object.assign(Object.create(Object.getPrototypeOf(service)), service, {
    prisma,
  }) as T;
}

function latch() {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  return { ready, resolve };
}

async function waitFor(ready: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_done, fail) => {
        timer = setTimeout(
          () => fail(new Error("SQLite transaction schedule timed out")),
          4000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function serializePair(
  database: PrismaClient,
  first: (db: PrismaClient) => Promise<unknown>,
  second: (db: PrismaClient) => Promise<unknown>,
) {
  const written = latch();
  const waiting = latch();
  const release = latch();
  const probe = (leading: boolean) =>
    new Proxy(database, {
      get(client, property) {
        if (property === "$transaction")
          return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
            if (!leading) waiting.resolve();
            return client.$transaction(
              async (tx) =>
                work(
                  new Proxy(tx, {
                    get(transaction, member) {
                      if (member === "$executeRaw")
                        return async (
                          query: TemplateStringsArray,
                          ...values: unknown[]
                        ) => {
                          const value = await transaction.$executeRaw(
                            query,
                            ...values,
                          );
                          if (leading) {
                            written.resolve();
                            await waitFor(release.ready);
                          }
                          return value;
                        };
                      const value: unknown = Reflect.get(transaction, member);
                      return typeof value === "function"
                        ? value.bind(transaction)
                        : value;
                    },
                  }),
                ),
              { maxWait: 5000, timeout: 5000 },
            );
          };
        const value: unknown = Reflect.get(client, property);
        return typeof value === "function" ? value.bind(client) : value;
      },
    });
  const one = first(probe(true));
  void one.catch(() => undefined);
  let two: Promise<unknown> | undefined;
  try {
    await waitFor(written.ready);
    two = second(probe(false));
    void two.catch(() => undefined);
    await waitFor(waiting.ready);
  } catch (error) {
    release.resolve();
    await Promise.allSettled(two ? [one, two] : [one]);
    throw error;
  } finally {
    release.resolve();
  }
  return Promise.allSettled([one, two]);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
