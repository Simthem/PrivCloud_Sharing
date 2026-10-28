import "reflect-metadata";
import assert from "node:assert/strict";
import { generate, generateSecret } from "otplib";
import { AuthTotpService } from "src/auth/authTotp.service";
import { OAuthReauthService } from "src/auth/oauthReauth.service";
import { OAuthController } from "src/oauth/oauth.controller";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "OAuth re-authentication for 2FA",
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

async function rejects(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: { getStatus?: () => number }) => {
    assert.equal(error.getStatus?.(), status);
    return true;
  });
}

testCase("an intent is spent once, for its provider only", async () => {
  const { service } = reauthStore();
  const intent = await service.startIntent("user-1", "google");
  assert.equal(await service.consumeIntent(intent, "github"), null);
  assert.deepEqual(await service.consumeIntent(intent, "google"), {
    userId: "user-1",
    purpose: "TOTP",
  });
  assert.equal(await service.consumeIntent(intent, "google"), null);
  assert.equal(await service.consumeIntent("forged", "google"), null);
  assert.equal(await service.consumeIntent(undefined, "google"), null);
});

testCase("a proof belongs to one user, expires and is spent once", async () => {
  const { rows, service } = reauthStore();
  const proof = await service.issueProof("user-1", "google");
  assert.equal(await service.hasProof(proof, "user-2"), false);
  assert.equal(await service.hasProof(proof, "user-1"), true);
  assert.equal(await service.consumeProof(proof, "user-2"), false);
  assert.equal(await service.consumeProof(proof, "user-1"), true);
  assert.equal(await service.consumeProof(proof, "user-1"), false);

  const late = await service.issueProof("user-1", "google");
  for (const row of rows.values()) if (!row.usedAt) row.expiresAt = new Date(0);
  assert.equal(await service.hasProof(late, "user-1"), false);

  // An intent is never a proof, and a proof never an intent.
  const intent = await service.startIntent("user-1", "google");
  assert.equal(await service.hasProof(intent, "user-1"), false);
  const proof2 = await service.issueProof("user-1", "google");
  assert.equal(await service.consumeIntent(proof2, "google"), null);
});

function totpService(options: { linked: number }) {
  const store = reauthStore();
  const secret = generateSecret();
  const updates: unknown[] = [];
  const counted: string[] = [];
  const prisma = {
    oAuthUser: { count: async () => options.linked },
    user: {
      findUnique: async () => ({ totpVerified: false, totpSecret: secret }),
      update: async (args: unknown) => updates.push(args),
    },
    totpBackupCode: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 10 }),
      findMany: async () => [],
    },
  };
  const service = new AuthTotpService(
    prisma as never,
    { get: () => "PrivCloud" } as never,
    {
      verifyPassword: async (_u: unknown, p: string) => p === "right",
      countReauthentication: async (
        id: string,
        check: () => Promise<boolean>,
      ) => {
        counted.push(id);
        return check();
      },
    } as never,
    store.service,
  );
  return { service, store, secret, updates, counted };
}

const oauthOnly = {
  id: "user-1",
  password: null,
  username: "u",
  email: "u@x.test",
} as never;
const withPassword = {
  id: "user-1",
  password: "hash",
  username: "u",
  email: "u@x.test",
} as never;

testCase(
  "an account without a password confirms 2FA with a fresh linked sign-in",
  async () => {
    const { service, store, secret, updates } = totpService({ linked: 1 });
    await rejects(service.enableTotp(oauthOnly, {}), 403);
    const proof = await store.service.issueProof("user-1", "google");
    await service.enableTotp(oauthOnly, { reauthProof: proof });
    // Enabling only checks: the same proof completes the verification.
    await rejects(
      service.verifyTotp(oauthOnly, { reauthProof: proof }, "000000"),
      400,
    );
    assert.equal(await store.service.hasProof(proof, "user-1"), true);
    const code = await generate({ secret });
    const result = await service.verifyTotp(
      oauthOnly,
      { reauthProof: proof },
      code,
    );
    assert.equal(result.backupCodes.length > 0, true);
    assert.equal(await store.service.hasProof(proof, "user-1"), false);
    assert.ok(updates.length >= 2);
  },
);

testCase(
  "a password account may use its password or a fresh linked sign-in",
  async () => {
    const { service, store } = totpService({ linked: 1 });
    await rejects(service.enableTotp(withPassword, {}), 403);
    await rejects(service.enableTotp(withPassword, { password: "wrong" }), 403);
    // A wrong password is refused even with a valid proof next to it.
    const proof = await store.service.issueProof("user-1", "google");
    await rejects(
      service.enableTotp(withPassword, {
        password: "wrong",
        reauthProof: proof,
      }),
      403,
    );
    await service.enableTotp(withPassword, { password: "right" });
    await service.enableTotp(withPassword, { reauthProof: proof });
  },
);

testCase(
  "a password account without a linked provider needs its password",
  async () => {
    const { service, store } = totpService({ linked: 0 });
    const proof = await store.service.issueProof("user-1", "google");
    await rejects(
      service.enableTotp(withPassword, { reauthProof: proof }),
      403,
    );
  },
);

testCase(
  "a 2FA code typed to confirm a change counts towards the account lock",
  async () => {
    const { service, secret, counted } = totpService({ linked: 0 });
    const protectedUser = {
      ...(withPassword as object),
      totpVerified: true,
      totpSecret: secret,
    } as never;
    await rejects(
      service.confirmSecondFactorChange(
        protectedUser,
        { password: "right" },
        "000000",
      ),
      400,
    );
    await service.confirmEmailChangeFactor(
      protectedUser,
      await generate({ secret }),
    );
    await rejects(
      service.disableTotp(protectedUser, { password: "right" }, "000000"),
      400,
    );
    assert.deepEqual(counted, ["user-1", "user-1", "user-1"]);
  },
);

testCase(
  "adding a passkey takes the same proof as turning 2FA off",
  async () => {
    const { service, store, secret } = totpService({ linked: 1 });
    const protectedUser = {
      ...(withPassword as object),
      totpVerified: true,
    } as never;
    // A stolen session alone: no password, no proof.
    await rejects(service.confirmSecondFactorChange(protectedUser, {}), 403);
    await rejects(
      service.confirmSecondFactorChange(protectedUser, { password: "wrong" }),
      403,
    );
    // The password without the current code is not enough while 2FA is on.
    await rejects(
      service.confirmSecondFactorChange(protectedUser, { password: "right" }),
      400,
    );
    await rejects(
      service.confirmSecondFactorChange(
        protectedUser,
        { password: "right" },
        "000000",
      ),
      400,
    );
    await service.confirmSecondFactorChange(
      protectedUser,
      { password: "right" },
      await generate({ secret }),
    );
    // Without a password: a fresh linked sign-in, spent at once.
    const proof = await store.service.issueProof("user-1", "google");
    await service.confirmSecondFactorChange(oauthOnly, { reauthProof: proof });
    assert.equal(await store.service.hasProof(proof, "user-1"), false);
    await rejects(
      service.confirmSecondFactorChange(oauthOnly, { reauthProof: proof }),
      403,
    );
  },
);

testCase(
  "without a password and without a linked provider there is no way",
  async () => {
    const { service, store } = totpService({ linked: 0 });
    const proof = await store.service.issueProof("user-1", "google");
    await rejects(service.enableTotp(oauthOnly, { reauthProof: proof }), 403);
  },
);

// The flow's private steps, called directly like the provider would.
type ReauthFlow = {
  reauth: (...args: unknown[]) => Promise<void>;
  completeReauth: (...args: unknown[]) => Promise<void>;
};

function controller(linkedIdentity: string) {
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
    {
      isLinked: async (_u: string, _p: string, providerUserId?: string) =>
        providerUserId === undefined || providerUserId === linkedIdentity,
    } as never,
    {
      get: (key: string) =>
        key === "general.appUrl" ? "https://app.test" : true,
    } as never,
    store.service,
    {} as never,
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
  "the provider must return the identity linked to the account",
  async () => {
    const { oauth, store, cookies, response } = controller("google-sub-1");
    const intent = await store.service.startIntent("user-1", "google");
    await assert.rejects(
      oauth.completeReauth(
        "google",
        intent,
        { providerId: "google-sub-2" },
        response,
      ),
      (error: { key?: string }) => error.key === "reauth_mismatch",
    );
    assert.equal(cookies.reauth_confirmation, undefined);
    // The intent was spent by the failed attempt.
    await assert.rejects(
      oauth.completeReauth(
        "google",
        intent,
        { providerId: "google-sub-1" },
        response,
      ),
      (error: { key?: string }) => error.key === "reauth_expired",
    );
  },
);

testCase(
  "an old provider sign-in is refused, a fresh one yields a scoped proof",
  async () => {
    const { oauth, store, cookies, response, redirected } =
      controller("google-sub-1");
    const stale = await store.service.startIntent("user-1", "google");
    await assert.rejects(
      oauth.completeReauth(
        "google",
        stale,
        {
          providerId: "google-sub-1",
          authTime: Math.floor(Date.now() / 1000) - 3600,
        },
        response,
      ),
      (error: { key?: string }) => error.key === "reauth_expired",
    );
    const fresh = await store.service.startIntent("user-1", "google");
    await oauth.completeReauth(
      "google",
      fresh,
      { providerId: "google-sub-1", authTime: Math.floor(Date.now() / 1000) },
      response,
    );
    assert.equal(cookies.reauth_confirmation.options.path, "/api/auth");
    assert.equal(cookies.reauth_confirmation.options.httpOnly, true);
    assert.equal(cookies.reauth_confirmation.options.sameSite, "strict");
    assert.equal(
      await store.service.hasProof(cookies.reauth_confirmation.value, "user-1"),
      true,
    );
    assert.equal(redirected(), "https://app.test/account?totpReauth=1");
  },
);

void run();
