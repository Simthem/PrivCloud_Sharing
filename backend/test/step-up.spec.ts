import "reflect-metadata";
import assert from "node:assert/strict";
import * as argon from "argon2";
import { AuthController } from "src/auth/auth.controller";
import { AuthTotpService } from "src/auth/authTotp.service";
import { StepUpService } from "src/auth/stepUp.service";
import { OAuthReauthService } from "src/auth/oauthReauth.service";
import { ConfigController } from "src/config/config.controller";
import { OAuthController } from "src/oauth/oauth.controller";
import { SigningController } from "src/signing/signing.controller";
import { TeamController } from "src/team/team.controller";
import { UserController } from "src/user/user.controller";
import { createUnitTestRunner } from "./unit-test";
import { createTestCredentials } from "./test-credentials";

const fixtureCredentials = createTestCredentials();

const { testCase, run } = createUnitTestRunner("step-up confirmation");

type Grant = {
  tokenHash: string;
  userId: string;
  scope: string;
  method: string;
  expiresAt: Date;
  usedAt: Date | null;
};

/** The grant table, with the conditional update a database applies at once. */
function grantStore() {
  const rows = new Map<string, Grant>();
  const prisma = {
    stepUpGrant: {
      create: async ({ data }: { data: Omit<Grant, "usedAt"> }) => {
        rows.set(data.tokenHash, { ...data, usedAt: null });
      },
      deleteMany: async () => ({ count: 0 }),
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          tokenHash: string;
          userId: string;
          scope: string;
          expiresAt: { gt: Date };
        };
        data: { usedAt: Date };
      }) => {
        const row = rows.get(where.tokenHash);
        if (
          !row ||
          row.usedAt ||
          row.userId !== where.userId ||
          row.scope !== where.scope ||
          row.expiresAt <= where.expiresAt.gt
        ) {
          return { count: 0 };
        }
        row.usedAt = data.usedAt;
        return { count: 1 };
      },
    },
  };
  const service = new StepUpService(prisma as never);
  Object.assign(service, {
    logger: { log: () => undefined, warn: () => undefined },
  });
  return { rows, service };
}

function reauthStore() {
  const rows = new Map<
    string,
    {
      tokenHash: string;
      userId: string;
      stage: string;
      purpose: string;
      expiresAt: Date;
      usedAt: Date | null;
    }
  >();
  const prisma = {
    oAuthReauthToken: {
      create: async ({
        data,
      }: {
        data: {
          tokenHash: string;
          userId: string;
          stage: string;
          purpose: string;
          expiresAt: Date;
        };
      }) => {
        rows.set(data.tokenHash, { ...data, usedAt: null });
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.get(where.tokenHash) ?? null,
      updateMany: async ({ where }: { where: { tokenHash: string } }) => {
        const row = rows.get(where.tokenHash);
        if (!row || row.usedAt) return { count: 0 };
        row.usedAt = new Date();
        return { count: 1 };
      },
      deleteMany: async () => ({ count: 0 }),
    },
  };
  return new OAuthReauthService(prisma as never);
}

const admin = { id: "admin-1", isAdmin: true } as never;
const request = (value?: string) =>
  ({ cookies: value ? { step_up: value } : {} }) as never;

async function stepUpRequired(promise: Promise<unknown>, scope: string) {
  await assert.rejects(
    promise,
    (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
      assert.equal(error.getStatus?.(), 403);
      assert.deepEqual(error.getResponse?.(), {
        statusCode: 403,
        message: "Confirm your identity to continue",
        error: "step_up_required",
        scope,
      });
      return true;
    },
  );
}

testCase("a confirmation serves its own operation once", async () => {
  const { service } = grantStore();
  const { value } = await service.issue(admin, "user.update:u-2", "password");

  await stepUpRequired(
    service.consume(request(value), admin, "user.update:u-3"),
    "user.update:u-3",
  );
  await stepUpRequired(
    service.consume(
      request(value),
      { id: "admin-2" } as never,
      "user.update:u-2",
    ),
    "user.update:u-2",
  );
  await service.consume(request(value), admin, "user.update:u-2");
  await stepUpRequired(
    service.consume(request(value), admin, "user.update:u-2"),
    "user.update:u-2",
  );
  await stepUpRequired(
    service.consume(request(), admin, "config.update"),
    "config.update",
  );
});

testCase("an expired confirmation is refused", async () => {
  const { rows, service } = grantStore();
  const { value } = await service.issue(admin, "config.update", "passkey");
  for (const row of rows.values()) row.expiresAt = new Date(0);
  await stepUpRequired(
    service.consume(request(value), admin, "config.update"),
    "config.update",
  );
});

testCase("racing requests spend one confirmation once", async () => {
  const { service } = grantStore();
  const { value } = await service.issue(admin, "user.create.admin", "oauth");
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      service.consume(request(value), admin, "user.create.admin"),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

testCase("an unknown operation name is never confirmed", async () => {
  const { service } = grantStore();
  for (const scope of [
    "",
    "USER",
    "user.update:a/b",
    fixtureCredentials.character.repeat(80),
  ]) {
    await assert.rejects(service.issue(admin, scope, "password"));
  }
});

function userController(target: Record<string, unknown> | null) {
  const { service } = grantStore();
  const calls: string[] = [];
  const users = {
    get: async () => target,
    create: async (dto: { isAdmin?: boolean }) => {
      calls.push("create");
      return { id: "new", isAdmin: !!dto.isAdmin };
    },
    update: async () => {
      calls.push("update");
      return { id: "u-2" };
    },
    delete: async () => {
      calls.push("delete");
      return { id: "u-2" };
    },
  };
  const totp = {
    adminDisableTotp: async () => {
      calls.push("totp");
    },
  };
  const controller = new UserController(
    users as never,
    {} as never,
    totp as never,
    {} as never,
    service,
  );
  Object.assign(controller, { logger: { warn: () => undefined } });
  return { controller, service, calls };
}

testCase("administrator rights and credentials ask for a step-up", async () => {
  const member = {
    id: "u-2",
    email: fixtureCredentials.memberEmail,
    isAdmin: false,
  };
  const { controller, service, calls } = userController(member);

  for (const [dto, scope] of [
    [{ isAdmin: true }, "user.update:u-2"],
    [{ email: fixtureCredentials.nextEmail }, "user.update:u-2"],
    [{ password: fixtureCredentials.updatedPassword }, "user.update:u-2"],
  ] as const) {
    await stepUpRequired(
      controller.update("u-2", dto as never, admin, request()),
      scope,
    );
  }
  await stepUpRequired(
    controller.create(
      { isAdmin: true, email: fixtureCredentials.adminEmail } as never,
      admin,
      request(),
    ),
    "user.create.admin",
  );
  await stepUpRequired(
    controller.adminDisableTotp("u-2", admin, request()),
    "user.totp.reset:u-2",
  );
  assert.deepEqual(calls, []);

  const { value } = await service.issue(admin, "user.update:u-2", "password");
  await controller.update(
    "u-2",
    { isAdmin: true } as never,
    admin,
    request(value),
  );
  assert.deepEqual(calls, ["update"]);
});

testCase("everyday edits need no step-up", async () => {
  const member = {
    id: "u-2",
    email: fixtureCredentials.memberEmail,
    isAdmin: false,
  };
  const { controller, calls } = userController(member);
  await controller.update(
    "u-2",
    {
      username: fixtureCredentials.username,
      email: fixtureCredentials.memberEmail,
      isAdmin: false,
    } as never,
    admin,
    request(),
  );
  await controller.create(
    { email: fixtureCredentials.otherEmail } as never,
    admin,
    request(),
  );
  await controller.delete("u-2", admin, request());
  assert.deepEqual(calls, ["update", "create", "delete"]);
});

testCase("removing an administrator asks for a step-up", async () => {
  const other = {
    id: "u-2",
    email: fixtureCredentials.otherAdminEmail,
    isAdmin: true,
  };
  const { controller, calls } = userController(other);
  await stepUpRequired(
    controller.delete("u-2", admin, request()),
    "user.delete:u-2",
  );
  assert.deepEqual(calls, []);
});

testCase("one's own credentials are left to the account page", async () => {
  const self = {
    id: "admin-1",
    email: fixtureCredentials.adminEmail,
    isAdmin: true,
  };
  const { controller, calls } = userController(self);
  // The service refuses it with its own message, no confirmation is spent.
  await controller.update(
    "admin-1",
    { email: fixtureCredentials.otherEmail } as never,
    admin,
    request(),
  );
  assert.deepEqual(calls, ["update"]);
  await stepUpRequired(
    controller.update("admin-1", { isAdmin: false } as never, admin, request()),
    "user.update:admin-1",
  );
});

testCase("settings that decide who signs in ask for a step-up", async () => {
  const { service } = grantStore();
  const updates: unknown[] = [];
  const controller = new ConfigController(
    {
      updateMany: async (data: unknown) => {
        updates.push(data);
        return [];
      },
    } as never,
    {} as never,
    {} as never,
    service,
  );
  await controller.updateMany(
    [{ key: "legal.imprintText", value: "x" }] as never,
    admin,
    request(),
  );
  for (const key of [
    "oauth.google-enabled",
    "ldap.url",
    "smtp.host",
    "general.appUrl",
    "security.loginMaxFailures",
    "somethingNew.key",
  ]) {
    await stepUpRequired(
      controller.updateMany(
        [
          { key: "legal.imprintText", value: "x" },
          { key, value: "y" },
        ] as never,
        admin,
        request(),
      ),
      "config.update",
    );
  }
  assert.equal(updates.length, 1);
});

testCase("team membership and roles ask for a step-up", async () => {
  const { service } = grantStore();
  const calls: string[] = [];
  const team = {
    adminJoinTeam: async () => calls.push("join"),
    adminAddUserToTeam: async () => calls.push("add"),
    adminSetMemberRole: async () => calls.push("role"),
    adminSetTeamAdmin: async () => calls.push("admin"),
  };
  const controller = new TeamController(team as never, {} as never, service);
  await stepUpRequired(
    controller.adminJoinTeam("t-1", admin, request()),
    "team.member.add:t-1",
  );
  await stepUpRequired(
    controller.adminAddMember(
      "t-1",
      { userId: "u-2", role: "MEMBER" } as never,
      admin,
      request(),
    ),
    "team.member.add:t-1",
  );
  await stepUpRequired(
    controller.adminSetMemberRole(
      "t-1",
      "m-1",
      { role: "ADMIN" } as never,
      admin,
      request(),
    ),
    "team.member.role:m-1",
  );
  await stepUpRequired(
    controller.adminDesignateTeamAdmin("t-1", "m-1", admin, request()),
    "team.admin.set:m-1",
  );
  assert.deepEqual(calls, []);
  const { value } = await service.issue(admin, "team.admin.set:m-1", "passkey");
  await controller.adminDesignateTeamAdmin("t-1", "m-1", admin, request(value));
  assert.deepEqual(calls, ["admin"]);
});

testCase(
  "resetting someone's signing passkeys asks for a step-up",
  async () => {
    const { service } = grantStore();
    const resets: string[] = [];
    const controller = new SigningController(
      {} as never,
      {} as never,
      {} as never,
      {
        resetPasskeys: async (userId: string) => {
          resets.push(userId);
        },
      } as never,
      {} as never,
      service,
      { get: () => true } as never,
    );
    await stepUpRequired(
      controller.resetUserPasskeys("u-2", admin, request()),
      "signing.passkeys.reset:u-2",
    );
    assert.deepEqual(resets, []);
  },
);

const lockPolicy: Record<string, number> = {
  "security.loginMaxFailures": 5,
  "security.loginBaseLockMinutes": 3,
  "security.loginMaxLockMinutes": 1440,
  "security.loginFailureWindowMinutes": 60,
};

/** The confirmation route, with the real factor checks behind it. */
async function confirmation(options: { totp?: boolean; linked?: boolean }) {
  const oauthReauth = reauthStore();
  const grants = grantStore();
  const password = await argon.hash(fixtureCredentials.password);
  const user = {
    id: "admin-1",
    isAdmin: true,
    password,
    totpVerified: !!options.totp,
  } as never;
  const totp = Object.create(AuthTotpService.prototype) as AuthTotpService;
  Object.assign(totp, {
    oauthReauth,
    prisma: {
      oAuthUser: { count: async () => (options.linked ? 1 : 0) },
      user: {
        findUnique: async () => ({
          totpSecret: fixtureCredentials.totpSecret,
        }),
      },
      totpBackupCode: { findMany: async () => [] },
    },
    authService: {
      verifyPassword: async (_user: unknown, candidate: string) =>
        candidate === fixtureCredentials.password,
      countReauthentication: async (
        _id: string,
        check: () => Promise<boolean>,
      ) => check(),
    },
    configService: { get: (key: string) => lockPolicy[key] },
  });
  const passkeyScopes: string[] = [];
  const cookies: Record<string, { value: string; options: unknown }> = {};
  const controller = Object.create(AuthController.prototype) as AuthController;
  Object.assign(controller, {
    authTotpService: totp,
    stepUp: grants.service,
    config: { get: () => true },
    passkeys: {
      verifyStepUp: async (_user: unknown, scope: string) => {
        passkeyScopes.push(scope);
      },
    },
  });
  const response = {
    cookie: (name: string, value: string, cookieOptions: unknown) => {
      cookies[name] = { value, options: cookieOptions };
    },
    clearCookie: () => undefined,
  } as never;
  const confirm = (dto: Record<string, unknown>, proof?: string) =>
    controller.confirmStepUp(
      user,
      { scope: "user.update:u-2", ...dto } as never,
      { cookies: proof ? { reauth_confirmation: proof } : {} } as never,
      response,
    );
  return { confirm, cookies, grants, oauthReauth, passkeyScopes };
}

testCase("a wrong password or a missing code grants nothing", async () => {
  const { confirm, cookies } = await confirmation({ totp: true });
  await assert.rejects(
    confirm({ password: fixtureCredentials.incorrectPassword }),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 403,
  );
  await assert.rejects(
    confirm({ password: fixtureCredentials.password }),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 400,
  );
  await assert.rejects(
    confirm({
      password: fixtureCredentials.password,
      code: fixtureCredentials.incorrectCode,
    }),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 400,
  );
  assert.deepEqual(cookies, {});
});

testCase("the password grants a short, httpOnly confirmation", async () => {
  const { confirm, cookies, grants } = await confirmation({});
  const { expiresAt } = await confirm({
    password: fixtureCredentials.password,
  });
  const issued = cookies.step_up;
  assert.ok(issued);
  assert.deepEqual(issued.options, {
    path: "/api",
    sameSite: "strict",
    secure: true,
    httpOnly: true,
    maxAge: 120_000,
  });
  assert.ok(expiresAt.getTime() - Date.now() <= 120_000);
  await grants.service.consume(request(issued.value), admin, "user.update:u-2");
});

testCase("a linked sign-in confirms only when started for it", async () => {
  const { confirm, cookies, oauthReauth } = await confirmation({
    linked: true,
  });
  const twoFactor = await oauthReauth.issueProof("admin-1", "google", "TOTP");
  await assert.rejects(confirm({}, twoFactor));
  assert.equal(cookies.step_up, undefined);
  const proof = await oauthReauth.issueProof("admin-1", "google", "STEP_UP");
  await confirm({}, proof);
  assert.ok(cookies.step_up);
  // Spent: the same proof never confirms a second operation.
  delete cookies.step_up;
  await assert.rejects(confirm({}, proof));
  assert.equal(cookies.step_up, undefined);
});

testCase("a passkey confirms the operation it was asked for", async () => {
  const { confirm, cookies, passkeyScopes } = await confirmation({
    totp: true,
  });
  await confirm({
    passkey: { challengeId: "c-1", response: { id: "cred" } },
  });
  assert.deepEqual(passkeyScopes, ["user.update:u-2"]);
  assert.ok(cookies.step_up);
});

/** The provider round trip's private steps, called as the provider would. */
function oauthController(store: OAuthReauthService) {
  const oauth = new OAuthController(
    {} as never,
    { isLinked: async () => true } as never,
    {
      get: (key: string) =>
        key === "general.appUrl" ? "https://app.test" : true,
    } as never,
    store,
    {
      github: {
        getAuthEndpoint: async () => ({ url: "https://idp.test/authorize" }),
      },
      google: {
        getAuthEndpoint: async () => ({ url: "https://idp.test/authorize" }),
      },
    } as never,
    {} as never,
  ) as unknown as {
    reauth: (...args: unknown[]) => Promise<void>;
    completeReauth: (...args: unknown[]) => Promise<void>;
  };
  Object.assign(oauth, { logger: { warn: () => undefined } });
  return oauth;
}

testCase(
  "linking a provider to an administrator asks for a step-up",
  async () => {
    const grants = grantStore();
    const links: string[] = [];
    const cookies: Record<string, string> = {};
    const response = {
      cookie: (name: string, value: string) => {
        cookies[name] = value;
      },
      clearCookie: (name: string) => {
        delete cookies[name];
      },
      redirect: () => undefined,
      headersSent: false,
    };
    const oauth = new OAuthController(
      {
        getIdOfCurrentUser: async (req: { cookies: Record<string, string> }) =>
          req.cookies.access_token ?? null,
      } as never,
      {
        findAdministrator: async (id: string) =>
          id === "admin-1" ? admin : null,
        link: async (
          userId: string,
          provider: string,
          providerUserId: string,
        ) => {
          links.push(`${userId}:${provider}:${providerUserId}`);
        },
      } as never,
      {
        get: (key: string) =>
          key === "general.appUrl" ? "https://app.test" : true,
      } as never,
      reauthStore(),
      {
        google: {
          getAuthEndpoint: async () => ({ url: "https://idp.test/authorize" }),
          getToken: async () => ({}),
          getUserInfo: async () => ({
            providerId: "idp-7",
            providerUsername: "someone",
          }),
        },
      } as never,
      grants.service,
    );
    Object.assign(oauth, {
      logger: { warn: () => undefined, error: () => undefined },
    });
    const signedIn = (extra: Record<string, string> = {}) =>
      ({
        cookies: { access_token: "admin-1", ...extra },
        headers: {},
      }) as never;
    const refused = (error: { key?: string }) =>
      error.key === "step_up_required";

    // A stolen session presented at the callback links nothing.
    await assert.rejects(
      oauth.callback("google", {} as never, signedIn(), response as never),
      refused,
    );
    // Nor does starting the flow without confirming.
    await assert.rejects(
      oauth.auth("google", signedIn(), response as never, "1"),
      refused,
    );
    assert.equal(cookies.oauth_google_link, undefined);
    // A sign-in is not a link request: it asks for nothing even in an
    // administrator's browser.
    await oauth.auth("google", signedIn(), response as never);
    assert.equal(cookies.oauth_google_link, undefined);

    const { value } = await grants.service.issue(
      admin,
      "oauth.link:google",
      "password",
    );
    await oauth.auth(
      "google",
      signedIn({ step_up: value }),
      response as never,
      "1",
    );
    const handedOver = cookies.oauth_google_link;
    assert.match(handedOver, /^[A-Za-z0-9_-]{43}$/);
    await stepUpRequired(
      grants.service.consume(request(value), admin, "oauth.link:google"),
      "oauth.link:google",
    );

    await oauth.callback(
      "google",
      {} as never,
      signedIn({ oauth_google_link: handedOver }),
      response as never,
    );
    assert.deepEqual(links, ["admin-1:google:idp-7"]);
    assert.equal(cookies.oauth_google_link, undefined);
    // Single use: the same grant never links a second identity.
    await assert.rejects(
      oauth.callback(
        "google",
        {} as never,
        signedIn({ oauth_google_link: handedOver }),
        response as never,
      ),
      refused,
    );

    // Other accounts link as before.
    await oauth.callback(
      "google",
      {} as never,
      { cookies: { access_token: "user-2" }, headers: {} } as never,
      response as never,
    );
    assert.deepEqual(links, ["admin-1:google:idp-7", "user-2:google:idp-7"]);
  },
);

testCase("a linked sign-in for a step-up must be dated", async () => {
  const store = reauthStore();
  const cookies: Record<string, { value: string }> = {};
  let redirected = "";
  const response = {
    cookie: (name: string, value: string) => {
      cookies[name] = { value };
    },
    redirect: (url: string) => {
      redirected = url;
    },
  };
  const oauth = oauthController(store);

  await oauth.reauth("github", { id: "admin-1" }, response, "step-up");
  await assert.rejects(
    oauth.completeReauth(
      "github",
      cookies.oauth_github_reauth.value,
      { providerId: "github-1" },
      response,
    ),
    (error: { key?: string }) => error.key === "reauth_unsupported",
  );
  assert.equal(cookies.reauth_confirmation, undefined);

  const back = "/sign/0b8f0d3e-9d2c-4f5b-8a51-2f7c1e3a9b40";
  await oauth.reauth("google", { id: "admin-1" }, response, "step-up", back);
  assert.equal(cookies.oauth_google_return.value, back);
  await oauth.completeReauth(
    "google",
    cookies.oauth_google_reauth.value,
    { providerId: "google-1", authTime: Math.floor(Date.now() / 1000) },
    response,
  );
  assert.equal(redirected, "https://app.test/admin?stepUpReauth=1");
  const proof = cookies.reauth_confirmation.value;
  assert.equal(await store.hasProof(proof, "admin-1", "STEP_UP"), true);
  assert.equal(await store.hasProof(proof, "admin-1", "TOTP"), false);
});

testCase("a linked sign-in returns only to pages it knows", async () => {
  const store = reauthStore();
  const cookies: Record<string, { value: string }> = {};
  let redirected = "";
  const response = {
    cookie: (name: string, value: string) => {
      cookies[name] = { value };
    },
    redirect: (url: string) => {
      redirected = url;
    },
  };
  const oauth = oauthController(store);
  for (const unknown of [
    "https://evil.test/admin",
    "//evil.test",
    "/account/../admin",
    "/accounts",
    "/sign/../admin",
    "/admin/../account",
  ]) {
    await oauth.reauth("google", { id: "u-1" }, response, "step-up", unknown);
    assert.equal(cookies.oauth_google_return, undefined, unknown);
  }
  const back = "/sign/0b8f0d3e-9d2c-4f5b-8a51-2f7c1e3a9b40";
  const intent = await store.startIntent("u-1", "google", "STEP_UP");
  await oauth.completeReauth(
    "google",
    intent,
    { providerId: "google-1", authTime: Math.floor(Date.now() / 1000) },
    response,
    back,
  );
  assert.equal(redirected, `https://app.test${back}?stepUpReauth=1`);
  // Linking a provider starts from the account page and comes back to it.
  await oauth.reauth("google", { id: "u-1" }, response, "step-up", "/account");
  assert.equal(cookies.oauth_google_return.value, "/account");
});

testCase(
  "only the enrolment of a signing passkey is a user's to confirm",
  async () => {
    const { service } = grantStore();
    const member = { id: "u-1", isAdmin: false } as never;
    assert.throws(() => service.assertMayConfirm(member, "config.update"));
    assert.throws(() => service.assertMayConfirm(member, "user.update:u-1"));
    service.assertMayConfirm(member, "signing.passkey.enroll:r-1");
    service.assertMayConfirm(admin, "config.update");
  },
);

testCase("enrolling a signing passkey asks for a step-up", async () => {
  const { service } = grantStore();
  const begun: string[] = [];
  const controller = new SigningController(
    {} as never,
    {} as never,
    {} as never,
    {
      assignedReinforcedRecipientId: async () => "r-1",
      beginRegistration: async (token: string) => {
        begun.push(token);
        return { challengeId: "c-1", options: {} };
      },
    } as never,
    {} as never,
    service,
    { get: () => true } as never,
  );
  const signer = { id: "u-1", isAdmin: false } as never;
  const res = { setHeader: () => undefined } as never;
  await stepUpRequired(
    controller.beginPasskeyRegistration("link", signer, request(), res),
    "signing.passkey.enroll:r-1",
  );
  assert.deepEqual(begun, []);
  const other = await service.issue(
    signer,
    "signing.passkey.enroll:r-2",
    "password",
  );
  await stepUpRequired(
    controller.beginPasskeyRegistration(
      "link",
      signer,
      request(other.value),
      res,
    ),
    "signing.passkey.enroll:r-1",
  );
  const { value } = await service.issue(
    signer,
    "signing.passkey.enroll:r-1",
    "password",
  );
  await controller.beginPasskeyRegistration(
    "link",
    signer,
    request(value),
    res,
  );
  assert.deepEqual(begun, ["link"]);
});

void run();
