import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importX509,
  jwtVerify,
  SignJWT,
} from "jose";
import { ErrorPageException } from "src/oauth/exceptions/errorPage.exception";
import { MicrosoftProvider } from "src/oauth/provider/microsoft.provider";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Microsoft Entra ID sign-in");

const clientId = "fixture-client";
const nonce = "fixture-nonce";
const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const otherTenant = "11111111-2222-4333-8444-555555555555";
const issuerOf = (id: string) => `https://login.microsoftonline.com/${id}/v2.0`;
const config = {
  get: (key: string) => (key.endsWith("-clientId") ? clientId : undefined),
  getOAuth(provider: string, setting: string) {
    return this.get(`oauth.${provider}-${setting}`);
  },
  addListener: () => {},
};

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;

function provider(issuer = issuerOf("{tenantid}")) {
  const instance = new MicrosoftProvider(config as never, {} as never);
  instance.getConfiguration = async () =>
    ({ issuer, jwks_uri: "https://issuer.invalid/keys" }) as never;
  Object.assign(instance, { remoteJwks: jwks });
  return instance;
}

async function signIn(
  claims: Record<string, unknown>,
  issuer?: string,
  tokenIssuer = issuerOf(tenant),
  signingKey = keys.privateKey,
) {
  const idToken = await new SignJWT({
    nonce,
    tid: tenant,
    sub: "pairwise-subject",
    email: "user@example.test",
    preferred_username: "user@example.test",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuedAt()
    .setIssuer(tokenIssuer)
    .setAudience(clientId)
    .setExpirationTime("5m")
    .sign(signingKey);
  return provider(issuer).getUserInfo({ idToken } as never, { nonce } as never);
}

async function rejected(promise: Promise<unknown>) {
  await assert.rejects(promise, ErrorPageException);
}

testCase(
  "accepts the real tenant behind the organizations template",
  async () => {
    const user = await signIn({ xms_edov: true });
    assert.equal(user.providerId, "pairwise-subject");
    assert.equal(user.email, "user@example.test");
  },
);

testCase(
  "expired Microsoft sessions retain signature, issuer and domain checks",
  async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { tid: tenant, xms_edov: true },
      { tid: tenant, xms_edov: false },
      { tid: otherTenant, xms_edov: true },
    ]) {
      const token = await new SignJWT({
        sub: "pairwise-subject",
        email: "User@Example.test",
        ...claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuerOf(tenant))
        .setAudience(clientId)
        .setIssuedAt(now - 7200)
        .setExpirationTime(now - 3600)
        .sign(keys.privateKey);
      assert.equal(
        await provider().recoverVerifiedEmail(token, "pairwise-subject"),
        claims.tid === tenant && claims.xms_edov
          ? "user@example.test"
          : undefined,
      );
    }
  },
);

testCase("rejects an issuer that does not match the signed tid", async () => {
  await rejected(signIn({ tid: otherTenant, xms_edov: true }));
});

testCase("rejects a forged token whatever its tid claims", async () => {
  const forger = await generateKeyPair("RS256");
  await rejected(
    signIn({ xms_edov: true }, undefined, undefined, forger.privateKey),
  );
});

testCase("rejects a token without a usable tid", async () => {
  await rejected(signIn({ tid: "not-a-tenant" }));
  await rejected(signIn({ tid: undefined }));
});

testCase(
  "keeps the exact issuer of a tenant-specific configuration",
  async () => {
    await signIn({ xms_edov: true }, issuerOf(tenant));
    await rejected(
      signIn({ tid: otherTenant }, issuerOf(tenant), issuerOf(otherTenant)),
    );
  },
);

testCase("drops an email the domain owner did not verify", async () => {
  assert.equal((await signIn({})).email, undefined);
  assert.equal((await signIn({ xms_edov: false })).email, undefined);
  assert.equal((await signIn({ xms_edov: "0" })).email, undefined);
  assert.equal((await signIn({ email_verified: true })).email, undefined);
  assert.equal((await signIn({ xms_edov: "1" })).email, "user@example.test");
});

function certificateBundle() {
  const directory = mkdtempSync(join(tmpdir(), "entra-certificate-"));
  const key = join(directory, "key.pem");
  const certificate = join(directory, "certificate.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "60",
      "-subj",
      "/CN=fixture",
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { stdio: "ignore" },
  );
  const certificatePem = readFileSync(certificate, "utf8");
  const bundle = join(directory, "bundle.pem");
  writeFileSync(bundle, readFileSync(key, "utf8") + certificatePem);
  return { bundle, certificatePem, directory };
}

async function exchange(instance: MicrosoftProvider) {
  const originalFetch = globalThis.fetch;
  let body = new URLSearchParams();
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    body = new URLSearchParams(init.body);
    return new Response(
      JSON.stringify({ id_token: "token", access_token: "access" }),
    );
  }) as never;
  try {
    await instance.getToken({ code: "code" } as never);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return body;
}

const tokenEndpoint =
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";

function exchangeProvider() {
  const instance = provider();
  instance.getConfiguration = async () =>
    ({ token_endpoint: tokenEndpoint }) as never;
  return instance;
}

testCase(
  "an unverified sign-in address stays separate from the trusted one",
  async () => {
    const withoutMail = await signIn({ email: undefined });
    assert.equal(withoutMail.email, undefined);
    assert.equal(withoutMail.unverifiedEmail, "user@example.test");
    const trusted = await signIn({ xms_edov: true });
    assert.equal(trusted.unverifiedEmail, undefined);
  },
);

testCase("a certificate signs the exchange instead of the secret", async () => {
  const { bundle, certificatePem, directory } = certificateBundle();
  process.env.MICROSOFT_OAUTH_CERTIFICATE_FILE = bundle;
  try {
    const body = await exchange(exchangeProvider());
    assert.equal(body.get("client_secret"), null);
    assert.equal(
      body.get("client_assertion_type"),
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    const assertion = body.get("client_assertion") as string;
    const header = decodeProtectedHeader(assertion);
    assert.equal(header.alg, "PS256");
    assert.equal(
      header["x5t#S256"],
      createHash("sha256")
        .update(new X509Certificate(certificatePem).raw)
        .digest("base64url"),
    );
    const { payload } = await jwtVerify(
      assertion,
      await importX509(certificatePem, "PS256"),
      { issuer: clientId, subject: clientId, audience: tokenEndpoint },
    );
    assert.ok(payload.jti);
    assert.ok((payload.exp as number) - (payload.nbf as number) <= 600);
    assert.doesNotMatch(body.toString(), /PRIVATE/);
  } finally {
    delete process.env.MICROSOFT_OAUTH_CERTIFICATE_FILE;
    rmSync(directory, { recursive: true });
  }
});

testCase("the client secret stays the default", async () => {
  const body = await exchange(exchangeProvider());
  assert.equal(body.has("client_secret"), true);
  assert.equal(body.get("client_assertion"), null);
});

testCase("an unusable certificate never falls back to the secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "entra-certificate-"));
  const invalid = join(directory, "invalid.pem");
  writeFileSync(invalid, "not a certificate");
  try {
    for (const file of [invalid, join(directory, "missing.pem")]) {
      process.env.MICROSOFT_OAUTH_CERTIFICATE_FILE = file;
      await rejected(exchangeProvider().getToken({ code: "code" } as never));
    }
  } finally {
    delete process.env.MICROSOFT_OAUTH_CERTIFICATE_FILE;
    rmSync(directory, { recursive: true });
  }
});

void (async () => {
  Logger.overrideLogger(false);
  keys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(keys.publicKey);
  jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, kid: "fixture", alg: "RS256", use: "sig" }],
  });
  await run();
})();
