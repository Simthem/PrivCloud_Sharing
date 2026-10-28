import "reflect-metadata";
import assert from "node:assert/strict";
import * as argon from "argon2";
import { AuthService } from "src/auth/auth.service";
import { OAuthReauthService } from "src/auth/oauthReauth.service";
import { OAuthController } from "src/oauth/oauth.controller";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "first password after a fresh sign-in",
);

type Row = {
  tokenHash: string;
  userId: string;
  provider: string;
  stage: string;
  purpose: string;
  expiresAt: Date;
  usedAt: Date | null;
};

function reauthStore() {
  const rows = new Map<string, Row>();
  const prisma = {
    oAuthReauthToken: {
      create: async ({ data }: { data: Omit<Row, "usedAt"> }) => {
        rows.set(data.tokenHash, { ...data, usedAt: null });
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.get(where.tokenHash) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { tokenHash: string };
        data: { usedAt: Date };
      }) => {
        const row = rows.get(where.tokenHash);
        if (!row || row.usedAt) return { count: 0 };
        row.usedAt = data.usedAt;
        return { count: 1 };
      },
      deleteMany: async () => ({ count: 0 }),
    },
  };
  return { rows, service: new OAuthReauthService(prisma as never) };
}

const lockPolicy: Record<string, number> = {
  "security.loginMaxFailures": 5,
  "security.loginBaseLockMinutes": 15,
  "security.loginMaxLockMinutes": 60,
  "security.loginFailureWindowMinutes": 15,
};

function authService(options: { ldap?: boolean } = {}) {
  const store = reauthStore();
  const writes: string[] = [];
  const service = Object.create(AuthService.prototype) as AuthService;
  Object.assign(service, {
    oauthReauth: store.service,
    config: {
      get: (key: string) =>
        key === "ldap.enabled" ? !!options.ldap : lockPolicy[key],
    },
    ldapService: {
      authenticateUser: async (_name: string, password: string) =>
        ({
          directory: { dn: "uid=u,dc=test" },
          "someone-else": { dn: "uid=other,dc=test" },
        })[password] ?? null,
    },
    prisma: {
      // Re-authentication reads and counts towards the sign-in lock.
      user: {
        findUnique: async () => ({
          id: "user-1",
          failedLoginAttempts: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        }),
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (work: (tx: unknown) => Promise<void>) =>
        work({
          user: {
            update: async () => {
              writes.push("password");
            },
          },
          refreshToken: {
            deleteMany: async () => {
              writes.push("sessions");
            },
          },
        }),
    },
  });
  return { service, store, writes };
}

async function forbidden(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: { getStatus?: () => number }) => {
    assert.equal(error.getStatus?.(), 403);
    return true;
  });
}

const passwordless = {
  id: "user-1",
  password: null,
  username: "u",
  email: "u@x.test",
} as never;

testCase("a session alone cannot set the first password", async () => {
  const { service, writes } = authService();
  await forbidden(service.updatePassword(passwordless, "a-new-password"));
  await forbidden(
    service.updatePassword(passwordless, "a-new-password", "", "forged"),
  );
  assert.deepEqual(writes, []);
});

testCase("a fresh linked sign-in sets the first password, once", async () => {
  const { service, store, writes } = authService();
  const proof = await store.service.issueProof("user-1", "google", "PASSWORD");
  await service.updatePassword(passwordless, "a-new-password", "", proof);
  assert.deepEqual(writes, ["password", "sessions"]);
  await forbidden(
    service.updatePassword(passwordless, "another-password", "", proof),
  );
  assert.deepEqual(writes, ["password", "sessions"]);
});

testCase("a proof only serves its own account and change", async () => {
  const { service, store, writes } = authService();
  const twoFactor = await store.service.issueProof("user-1", "google");
  await forbidden(
    service.updatePassword(passwordless, "a-new-password", "", twoFactor),
  );
  // Not spent by the refusal: it still confirms the 2FA change.
  assert.equal(await store.service.hasProof(twoFactor, "user-1"), true);

  const foreign = await store.service.issueProof(
    "user-2",
    "google",
    "PASSWORD",
  );
  await forbidden(
    service.updatePassword(passwordless, "a-new-password", "", foreign),
  );
  // And a password proof never confirms a 2FA change.
  const password = await store.service.issueProof(
    "user-1",
    "google",
    "PASSWORD",
  );
  assert.equal(await store.service.hasProof(password, "user-1"), false);
  assert.equal(await store.service.consumeProof(password, "user-1"), false);
  assert.deepEqual(writes, []);
});

testCase("an expired proof is refused", async () => {
  const { service, store, writes } = authService();
  const proof = await store.service.issueProof("user-1", "google", "PASSWORD");
  for (const row of store.rows.values()) row.expiresAt = new Date(0);
  await forbidden(
    service.updatePassword(passwordless, "a-new-password", "", proof),
  );
  assert.deepEqual(writes, []);
});

testCase(
  "a wrong current password is refused even next to a valid proof",
  async () => {
    const { service, store, writes } = authService();
    const proof = await store.service.issueProof(
      "user-1",
      "google",
      "PASSWORD",
    );
    await forbidden(
      service.updatePassword(passwordless, "a-new-password", "guess", proof),
    );
    assert.equal(
      await store.service.consumeProof(proof, "user-1", "PASSWORD"),
      true,
    );
    assert.deepEqual(writes, []);
  },
);

testCase(
  "a directory account confirms with its directory password",
  async () => {
    const { service, writes } = authService({ ldap: true });
    const directoryUser = {
      ...(passwordless as object),
      ldapDN: "uid=u,dc=test",
    } as never;
    await forbidden(
      service.updatePassword(directoryUser, "a-new-password", "wrong"),
    );
    // A username now naming another entry cannot vouch for this account.
    await forbidden(
      service.updatePassword(directoryUser, "a-new-password", "someone-else"),
    );
    assert.deepEqual(writes, []);
    await service.updatePassword(directoryUser, "a-new-password", "directory");
    assert.deepEqual(writes, ["password", "sessions"]);
  },
);

testCase(
  "an account outside the directory cannot borrow a directory password",
  async () => {
    const { service, writes } = authService({ ldap: true });
    await forbidden(
      service.updatePassword(passwordless, "a-new-password", "directory"),
    );
    assert.deepEqual(writes, []);
  },
);

testCase("a password account still needs its current password", async () => {
  const { service, store, writes } = authService();
  const user = {
    id: "user-1",
    password: await argon.hash("current-password"),
  } as never;
  const proof = await store.service.issueProof("user-1", "google", "PASSWORD");
  await forbidden(service.updatePassword(user, "a-new-password"));
  await forbidden(
    service.updatePassword(user, "a-new-password", undefined, proof),
  );
  await forbidden(service.updatePassword(user, "a-new-password", "wrong"));
  await service.updatePassword(user, "a-new-password", "current-password");
  assert.deepEqual(writes, ["password", "sessions"]);
});

// The flow's private steps, called directly like the provider would.
type ReauthFlow = {
  reauth: (...args: unknown[]) => Promise<void>;
  completeReauth: (...args: unknown[]) => Promise<void>;
};

function controller() {
  const store = reauthStore();
  const cookies: Record<
    string,
    { value: string; options: Record<string, unknown> }
  > = {};
  let redirected = "";
  const response = {
    cookie: (name: string, value: string, options: unknown) => {
      cookies[name] = { value, options: options as Record<string, unknown> };
    },
    redirect: (url: string) => {
      redirected = url;
    },
  };
  const oauth = new OAuthController(
    {} as never,
    { isLinked: async () => true } as never,
    {
      get: (key: string) =>
        key === "general.appUrl" ? "https://app.test" : true,
    } as never,
    store.service,
    {
      google: {
        getAuthEndpoint: async () => ({ url: "https://idp.test/authorize" }),
      },
    } as never,
    {} as never,
  );
  Object.assign(oauth, {
    logger: { warn: () => undefined, error: () => undefined },
  });
  return {
    oauth: oauth as unknown as ReauthFlow,
    store,
    cookies,
    response,
    redirected: () => redirected,
  };
}

testCase(
  "the provider round trip keeps the change it was started for",
  async () => {
    const { oauth, store, cookies, response, redirected } = controller();
    const user = { id: "user-1" };

    await oauth.reauth("google", user, response, "password");
    const intent = cookies.oauth_google_reauth.value;
    await oauth.completeReauth(
      "google",
      intent,
      { providerId: "google-sub-1", authTime: Math.floor(Date.now() / 1000) },
      response,
    );
    assert.equal(redirected(), "https://app.test/account?passwordReauth=1");
    const proof = cookies.reauth_confirmation.value;
    assert.equal(await store.service.hasProof(proof, "user-1"), false);
    assert.equal(
      await store.service.hasProof(proof, "user-1", "PASSWORD"),
      true,
    );

    // Without (or with an unknown) purpose it stays a 2FA confirmation.
    await oauth.reauth("google", user, response, "anything");
    await oauth.completeReauth(
      "google",
      cookies.oauth_google_reauth.value,
      { providerId: "google-sub-1", authTime: Math.floor(Date.now() / 1000) },
      response,
    );
    assert.equal(redirected(), "https://app.test/account?totpReauth=1");
    assert.equal(
      await store.service.hasProof(cookies.reauth_confirmation.value, "user-1"),
      true,
    );
  },
);

testCase(
  "a provider that does not date the sign-in cannot confirm a password",
  async () => {
    const { oauth, store, cookies, response } = controller();
    const intent = await store.service.startIntent(
      "user-1",
      "github",
      "PASSWORD",
    );
    await assert.rejects(
      oauth.completeReauth(
        "github",
        intent,
        { providerId: "github-1" },
        response,
      ),
      (error: { key?: string }) => error.key === "reauth_unsupported",
    );
    assert.equal(cookies.reauth_confirmation, undefined);
    // A 2FA confirmation keeps working with such a provider.
    const twoFactor = await store.service.startIntent("user-1", "github");
    await oauth.completeReauth(
      "github",
      twoFactor,
      { providerId: "github-1" },
      response,
    );
    assert.equal(
      await store.service.hasProof(cookies.reauth_confirmation.value, "user-1"),
      true,
    );
  },
);

void run();
