import "reflect-metadata";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { GoogleProvider } from "src/oauth/provider/google.provider";
import { OidcProvider } from "src/oauth/provider/oidc.provider";
import { OAuthController } from "src/oauth/oauth.controller";
import { ErrorPageException } from "src/oauth/exceptions/errorPage.exception";
import { createUnitTestRunner } from "./unit-test";
import { createTestCredentials } from "./test-credentials";

const fixtureCredentials = createTestCredentials();

const { testCase, run } = createUnitTestRunner(
  "OIDC verification and callbacks",
);
const issuer = "https://accounts.google.com";
const clientId = "fixture-client";
const nonce = fixtureCredentials.nonce;
const logs: string[] = [];
const configuration = {
  issuer,
  token_endpoint: "https://issuer.invalid/token",
  jwks_uri: "https://issuer.invalid/keys",
};
const config = {
  get: (key: string) =>
    key.endsWith("-clientId")
      ? clientId
      : key === "general.appUrl"
        ? "https://app.invalid"
        : key === "general.secureCookies"
          ? true
          : key.endsWith("-clientSecret")
            ? fixtureCredentials.clientSecret
            : undefined,
  addListener: () => {},
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;

function provider(custom = false) {
  const instance = custom
    ? new OidcProvider(config as never, {} as never)
    : new GoogleProvider(config as never, {} as never);
  instance.getConfiguration = async () => configuration as never;
  // Isolate claim/signature verification from transport, tested over real TLS separately.
  Object.assign(instance, { remoteJwks: jwks });
  return instance;
}

async function token(
  overrides: Record<string, unknown> = {},
  otherKey = false,
) {
  const pair = otherKey ? await generateKeyPair("RS256") : keys;
  return new SignJWT({
    iss: issuer,
    aud: clientId,
    sub: "fixture-user",
    name: "Fixture User",
    email: fixtureCredentials.identityEmail,
    email_verified: true,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
    .sign(pair.privateKey);
}

async function identity(
  instance: ReturnType<typeof provider>,
  jwt: string,
  expectedNonce = nonce,
) {
  return instance.getUserInfo(
    { idToken: jwt } as never,
    { nonce: expectedNonce } as never,
  );
}

async function invalid(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: ErrorPageException) => {
    assert.ok(error instanceof ErrorPageException);
    assert.equal(error.key, "invalid_token");
    return true;
  });
}

testCase(
  "Google accepts both documented issuers with a valid signature",
  async () => {
    for (const iss of [issuer, "accounts.google.com"]) {
      const user = await identity(provider(), await token({ iss }));
      assert.equal(user.providerId, "fixture-user");
      assert.equal(user.email, fixtureCredentials.identityEmail);
    }
  },
);

testCase("custom OIDC retains exact issuer validation", async () => {
  assert.equal(
    (await identity(provider(true), await token())).providerId,
    "fixture-user",
  );
  await invalid(
    identity(provider(true), await token({ iss: "accounts.google.com" })),
  );
  await invalid(
    identity(provider(), await token({ iss: "https://attacker.invalid" })),
  );
  assert.ok(logs.some((line) => line.includes("claim_iss_invalid")));
});

testCase(
  "wrong audience, expired token, bad signature and nonce remain rejected",
  async () => {
    await invalid(identity(provider(), await token({ aud: "another-client" })));
    await invalid(identity(provider(), await token({ exp: 1 })));
    await invalid(identity(provider(), await token({}, true)));
    await invalid(
      identity(provider(), await token(), fixtureCredentials.incorrectNonce),
    );
    for (const reason of [
      "claim_aud_invalid",
      "token_expired",
      "signature_invalid",
    ]) {
      assert.ok(
        logs.some((line) => line.includes(reason)),
        reason,
      );
    }
  },
);

testCase("unverified email is never accepted for registration", async () => {
  const user = await identity(
    provider(),
    await token({ email_verified: false }),
  );
  assert.equal(user.email, undefined);
});

testCase(
  "token exchange rejects HTTP errors, provider errors and missing ID tokens",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const [status, body] of [
        [
          401,
          {
            error: "invalid_client",
            error_description: fixtureCredentials.clientSecret,
          },
        ],
        [200, { error: "invalid_grant" }],
        [200, { access_token: fixtureCredentials.accessToken }],
      ] as const) {
        globalThis.fetch = async () =>
          new Response(JSON.stringify(body), { status });
        await invalid(
          provider().getToken({
            code: fixtureCredentials.authorizationCode,
          } as never),
        );
      }
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ id_token: fixtureCredentials.idToken }));
      assert.equal(
        (
          await provider().getToken({
            code: fixtureCredentials.authorizationCode,
          } as never)
        ).idToken,
        fixtureCredentials.idToken,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

function callbackFixture(options: { totp?: boolean; failure?: Error } = {}) {
  const redirects: string[] = [];
  const cleared: string[] = [];
  const issued = options.totp
    ? { loginToken: "second-factor" }
    : {
        accessToken: fixtureCredentials.accessToken,
        refreshToken: fixtureCredentials.refreshToken,
      };
  const handovers: unknown[] = [];
  const auth = {
    getIdOfCurrentUser: async () => undefined,
    addTokensToResponse: () => {
      handovers.push("cookies");
    },
  };
  const oauth = {
    signIn: async () => issued,
  };
  const providers = {
    google: {
      getToken: async () => {
        if (options.failure) throw options.failure;
        return {};
      },
      getUserInfo: async () => ({ providerId: "fixture-user" }),
    },
  };
  // This edition has no native client handover: the controller takes the
  // re-authentication store between the configuration and the providers, and
  // the step-up confirmations last.
  const args: unknown[] = [auth, oauth, config, {}, providers, {}];
  const controller = Reflect.construct(
    OAuthController,
    args,
  ) as OAuthController;
  const response = {
    clearCookie: (name: string) => {
      cleared.push(name);
    },
    redirect: (url: string) => {
      redirects.push(url);
    },
    status: (): unknown => response,
    type: (): unknown => response,
    set: (): unknown => response,
    send: (html: string) => {
      redirects.push(html);
    },
  };
  const request = {
    cookies: {
      oauth_google_state: `state|${nonce}`,
    },
    ip: "127.0.0.1",
  };
  return {
    controller,
    response: response as never,
    request: request as never,
    redirects,
    cleared,
    handovers,
  };
}

testCase(
  "callback preserves typed OAuth errors for the existing error-page filter",
  async () => {
    const failure = new ErrorPageException("invalid_token");
    const fixture = callbackFixture({ failure });
    await assert.rejects(
      fixture.controller.callback(
        "google",
        {} as never,
        fixture.request,
        fixture.response,
      ),
      (error: Error) => error === failure,
    );
    assert.deepEqual(fixture.redirects, []);
    assert.ok(fixture.cleared.includes("oauth_google_state"));
  },
);

testCase(
  "web sessions and TOTP redirects still complete through the callback",
  async () => {
    for (const totp of [false, true]) {
      const fixture = callbackFixture({ totp });
      await fixture.controller.callback(
        "google",
        {} as never,
        fixture.request,
        fixture.response,
      );
      assert.deepEqual(fixture.redirects, [
        totp
          ? "https://app.invalid/auth/totp/second-factor"
          : "https://app.invalid",
      ]);
      assert.deepEqual(fixture.handovers, totp ? [] : ["cookies"]);
    }
  },
);

testCase(
  "diagnostics never include raw claims, tokens, nonces or upstream messages",
  () => {
    const output = logs.join("\n");
    for (const secret of [
      nonce,
      fixtureCredentials.identityEmail,
      "fixture-user",
      fixtureCredentials.clientSecret,
      fixtureCredentials.authorizationCode,
      fixtureCredentials.accessToken,
    ]) {
      assert.ok(!output.includes(secret), secret);
    }
  },
);

void (async () => {
  keys = await generateKeyPair("RS256");
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture-key" }],
  });
  const originalError = Logger.prototype.error;
  Logger.prototype.error = function (message: string) {
    logs.push(message);
  };
  try {
    await run();
  } finally {
    Logger.prototype.error = originalError;
  }
})();
