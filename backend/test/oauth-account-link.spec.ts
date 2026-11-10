import "reflect-metadata";
import assert from "node:assert/strict";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "node:crypto";
import { OAuthService } from "src/oauth/oauth.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("OAuth account linking");

const SECRET = randomUUID();
const DOMAIN = `${randomUUID()}.test`;
const ADDRESS = `person@${DOMAIN}`;
const provider = {
  provider: "microsoft" as const,
  providerId: "subject",
  providerUsername: "person",
};

function service(account: Record<string, unknown> | null, smtp = true) {
  const calls = { links: 0, mails: [] as string[], signUps: [] as unknown[] };
  const config = {
    get: (key: string) =>
      ({
        "smtp.enabled": smtp,
        "oauth.allowRegistration": true,
        "internal.jwtSecret": SECRET,
        "general.appUrl": "https://share.example.test",
      })[key],
  };
  const prisma = {
    $queryRaw: async () => (account ? [{ id: account.id }] : []),
    oAuthUser: {
      findFirst: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async () => {
        calls.links += 1;
        return { id: "link", userId: "created" };
      },
    },
    user: {
      findFirst: async () => account,
      findMany: async () => (account ? [account] : []),
    },
  };
  const auth = {
    generateToken: async (user: { id: string }) => ({ signedIn: user.id }),
    signUp: async (...args: unknown[]) => {
      calls.signUps.push(args);
      return { user: { id: "created" } };
    },
  };
  const email = {
    sendOAuthLinkEmail: async (to: string) => {
      calls.mails.push(to);
    },
  };
  const oauth = new OAuthService(
    prisma as never,
    config as never,
    auth as never,
    [],
    {} as never,
    new JwtService({}),
    email as never,
  );
  return { oauth, calls };
}

const account = (extra = {}) => ({
  id: "existing",
  email: ADDRESS,
  isAdmin: false,
  totpVerified: false,
  emailVerifiedAt: new Date(),
  ...extra,
});

const errorOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail("expected a refusal"),
    (error: { key?: string; message?: string }) =>
      error.key ?? error.message ?? "",
  );

testCase("a vouched address joins the account that proved it", async () => {
  const { oauth, calls } = service(account());
  const result = await oauth.signIn(
    { ...provider, email: ADDRESS.toUpperCase() },
    "ip",
  );
  assert.deepEqual(result, { signedIn: "existing" });
  assert.equal(calls.links, 1);
  assert.equal(calls.signUps.length, 0);
});

testCase("an unproven match waits for the mailed confirmation", async () => {
  for (const [existing, user] of [
    [account(), { unverifiedEmail: ADDRESS }],
    [account({ emailVerifiedAt: null }), { email: ADDRESS }],
  ] as const) {
    const { oauth, calls } = service(existing);
    assert.match(
      await errorOf(
        oauth.signIn({ ...provider, email: undefined, ...user }, "ip"),
      ),
      /link_email_sent/,
    );
    assert.equal(calls.links, 0);
    assert.equal(calls.signUps.length, 0);
    assert.deepEqual(calls.mails, [ADDRESS]);
  }
});

testCase(
  "administrators and 2FA accounts are never linked this way",
  async () => {
    for (const extra of [{ isAdmin: true }, { totpVerified: true }]) {
      const { oauth, calls } = service(account(extra));
      assert.match(
        await errorOf(oauth.signIn({ ...provider, email: ADDRESS }, "ip")),
        /account_exists/,
      );
      assert.equal(calls.links + calls.mails.length, 0);
    }
  },
);

testCase(
  "a new unverified address creates one account with no deletion deadline",
  async () => {
    const { oauth, calls } = service(null);
    await oauth.signIn(
      { ...provider, email: undefined, unverifiedEmail: `new@${DOMAIN}` },
      "ip",
    );
    assert.equal(calls.signUps.length, 1);
    assert.equal((calls.signUps[0] as unknown[])[3], false);
    assert.equal((calls.signUps[0] as unknown[])[4], true);
  },
);

testCase("only a token issued for linking confirms a link", async () => {
  const { oauth, calls } = service(null);
  const jwt = new JwtService({});
  const claims = {
    sub: "existing",
    provider: "microsoft",
    providerUserId: "subject",
    providerUsername: "person",
  };
  await assert.rejects(
    oauth.confirmMailedLink(jwt.sign(claims, { secret: SECRET })),
  );
  await oauth.confirmMailedLink(
    jwt.sign(claims, { secret: SECRET, audience: "oauth-link" }),
  );
  assert.equal(calls.links, 1);
});

testCase(
  "provider role claims grant and remove administrator rights without changing absent claims",
  async () => {
    for (const [initial, claim, expected] of [
      [true, false, false],
      [false, true, true],
      [true, undefined, true],
    ] as const) {
      const current = { id: "linked-account", isAdmin: initial };
      const writes: boolean[] = [];
      const oauth = new OAuthService(
        {
          oAuthUser: {
            findFirst: async () => ({
              id: "linked-provider",
              userId: current.id,
              verifiedEmail: null,
              verifiedEmailFold: null,
            }),
          },
          user: {
            findFirst: async () => current,
            update: async ({ data }: { data: { isAdmin: boolean } }) => {
              writes.push(data.isAdmin);
              current.isAdmin = data.isAdmin;
              return current;
            },
          },
        } as never,
        {} as never,
        {
          generateToken: async (user: { isAdmin: boolean }) => ({
            isAdmin: user.isAdmin,
          }),
        } as never,
        [],
        {} as never,
        new JwtService({}),
        {} as never,
      );
      const result = await oauth.signIn(
        {
          ...provider,
          email: undefined,
          ...(claim === undefined ? {} : { isAdmin: claim }),
        },
        "ip",
      );
      assert.deepEqual(result, { isAdmin: expected });
      assert.deepEqual(writes, claim === undefined ? [] : [claim]);
    }
  },
);

void run();
