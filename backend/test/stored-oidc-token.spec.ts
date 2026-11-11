import "reflect-metadata";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";
import {
  CompactSign,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { GoogleProvider } from "src/oauth/provider/google.provider";
import { OidcProvider } from "src/oauth/provider/oidc.provider";
import { ErrorPageException } from "src/oauth/exceptions/errorPage.exception";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "stored OIDC token verification",
);
const issuer = "https://accounts.google.com";
const clientId = "stored-token-fixture";
const subject = "linked-subject";
const now = Math.floor(Date.now() / 1000);
const config = {
  get: (key: string) => (key.endsWith("clientId") ? clientId : undefined),
  getOAuth: (_provider: string, key: string) =>
    key === "clientId" ? clientId : undefined,
  addListener: () => {},
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;

function provider(custom = false) {
  const instance = custom
    ? new OidcProvider(config as never, {} as never)
    : new GoogleProvider(config as never, {} as never);
  instance.getConfiguration = async () =>
    ({ issuer, jwks_uri: "https://issuer.invalid/keys" }) as never;
  Object.assign(instance, { remoteJwks: jwks });
  return instance;
}
async function token(claims: Record<string, unknown> = {}, forged = false) {
  return new SignJWT({
    iss: issuer,
    aud: clientId,
    sub: subject,
    email: "Signer@Example.test",
    email_verified: true,
    name: "Fixture",
    nonce: "fixture-nonce",
    iat: now - 7200,
    exp: now - 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign((forged ? otherKeys : keys).privateKey);
}

testCase(
  "authentic expired sessions recover an address but cannot authenticate",
  async () => {
    const stored = await token();
    const instance = provider();
    assert.equal(
      await instance.recoverVerifiedEmail(stored, subject),
      "signer@example.test",
    );
    await assert.rejects(
      instance.getUserInfo(
        { idToken: stored } as never,
        { nonce: "fixture-nonce" } as never,
      ),
      ErrorPageException,
    );
    const current = await token({ iat: now - 30, exp: now + 300 });
    assert.equal(
      await instance.recoverVerifiedEmail(current, subject),
      "signer@example.test",
    );
    assert.equal(
      (
        await instance.getUserInfo(
          { idToken: current } as never,
          { nonce: "fixture-nonce" } as never,
        )
      ).providerId,
      subject,
    );
  },
);

testCase(
  "forged signatures, tampered payloads and unsigned tokens never recover",
  async () => {
    for (const exp of [now - 3600, now + 300]) {
      assert.equal(
        await provider().recoverVerifiedEmail(
          await token({ exp }, true),
          subject,
        ),
        undefined,
      );
    }
    const pieces = (await token()).split(".");
    pieces[1] = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: clientId,
        sub: subject,
        email: "forged@example.test",
        email_verified: true,
        iat: now - 7200,
        exp: now - 3600,
      }),
    ).toString("base64url");
    assert.equal(
      await provider().recoverVerifiedEmail(pieces.join("."), subject),
      undefined,
    );
    pieces[0] = Buffer.from(JSON.stringify({ alg: "none" })).toString(
      "base64url",
    );
    pieces[2] = "";
    assert.equal(
      await provider().recoverVerifiedEmail(pieces.join("."), subject),
      undefined,
    );
  },
);

testCase(
  "historical recovery retains issuer, audience, subject and verified-email policy",
  async () => {
    for (const claims of [
      { iss: "https://other.invalid" },
      { aud: "other-client" },
      { sub: "another-subject" },
      { email_verified: false },
      { email_verified: "true" },
      { email: null },
    ]) {
      assert.equal(
        await provider().recoverVerifiedEmail(await token(claims), subject),
        undefined,
      );
    }
    assert.equal(
      await provider().recoverVerifiedEmail(
        await token({ aud: ["other-client", clientId] }),
        subject,
      ),
      "signer@example.test",
    );
    const alternate = await token({ iss: "accounts.google.com" });
    assert.equal(
      await provider().recoverVerifiedEmail(alternate, subject),
      "signer@example.test",
    );
    assert.equal(
      await provider(true).recoverVerifiedEmail(alternate, subject),
      undefined,
    );
  },
);

testCase(
  "only authenticated, usable issuance dates can select historical validation time",
  async () => {
    for (const claims of [
      { iat: undefined },
      { iat: "123" },
      { iat: null },
      { iat: -1 },
      { iat: now + 3600 },
      { iat: now - 0.5 },
      { exp: undefined },
      { exp: "123" },
      { exp: now - 10000 },
      { nbf: now - 3600 },
      { nbf: now + 3600 },
      { nbf: "123" },
    ]) {
      assert.equal(
        await provider().recoverVerifiedEmail(await token(claims), subject),
        undefined,
      );
    }
    assert.equal(
      await provider().recoverVerifiedEmail(
        await token({ nbf: now - 8000 }),
        subject,
      ),
      "signer@example.test",
    );
    assert.equal(
      await provider().recoverVerifiedEmail(
        await token({ nbf: now - 6000 }),
        subject,
      ),
      "signer@example.test",
    );
    for (const payload of [null, [], 42, "claim"]) {
      const signed = await new CompactSign(Buffer.from(JSON.stringify(payload)))
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .sign(keys.privateKey);
      assert.equal(
        await provider().recoverVerifiedEmail(signed, subject),
        undefined,
      );
    }
    for (const value of ["not-a-jwt", "e30.%%%.sig", "e30.e30.sig.extra"])
      assert.equal(
        await provider().recoverVerifiedEmail(value, subject),
        undefined,
      );
  },
);

testCase("missing provider audience configuration fails closed", async () => {
  const instance = provider();
  Object.assign(instance, { config: { ...config, getOAuth: () => undefined } });
  assert.equal(
    await instance.recoverVerifiedEmail(await token(), subject),
    undefined,
  );
  await assert.rejects(
    instance.getUserInfo(
      { idToken: await token({ iat: now - 30, exp: now + 300 }) } as never,
      { nonce: "fixture-nonce" } as never,
    ),
    ErrorPageException,
  );
});

testCase(
  "unavailable verification keys fail closed without decoded claims",
  async () => {
    const instance = provider();
    Object.assign(instance, {
      remoteJwks: async () => {
        throw new Error("fixture key lookup failed");
      },
    });
    assert.equal(
      await instance.recoverVerifiedEmail(await token(), subject),
      undefined,
    );
  },
);

void (async () => {
  Logger.overrideLogger(false);
  keys = await generateKeyPair("RS256");
  otherKeys = await generateKeyPair("RS256");
  const publicKey = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({
    keys: [{ ...publicKey, kid: "fixture", alg: "RS256" }],
  });
  await run();
})();
