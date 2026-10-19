import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { AuthService } from "src/auth/auth.service";
import { AccountPasskeyService } from "src/passkey/accountPasskey.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("passkey sign-in");

const ORIGIN = "https://share.example.test";
const RP_ID = "share.example.test";
const USER = "user-1";

const b64url = (value: Buffer | Uint8Array) =>
  Buffer.from(value).toString("base64url");

/** A software authenticator: P-256 key, COSE public key, real signatures. */
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ]),
  );
  let counter = 0;
  return {
    publicKey: Buffer.from(cose),
    assert(
      credentialId: string,
      challenge: string,
      userHandle: string | null,
      options: { userVerified?: boolean; origin?: string } = {},
    ) {
      counter++;
      const authenticatorData = Buffer.concat([
        createHash("sha256").update(RP_ID).digest(),
        // User present, and user verified unless told otherwise.
        Buffer.from([options.userVerified === false ? 0x01 : 0x05]),
        Buffer.from([0, 0, 0, counter]),
      ]);
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge,
          origin: options.origin ?? ORIGIN,
          crossOrigin: false,
        }),
      );
      const signature = sign(
        "sha256",
        Buffer.concat([
          authenticatorData,
          createHash("sha256").update(clientDataJSON).digest(),
        ]),
        privateKey,
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: b64url(authenticatorData),
          clientDataJSON: b64url(clientDataJSON),
          signature: b64url(signature),
          ...(userHandle
            ? { userHandle: b64url(Buffer.from(userHandle)) }
            : {}),
        },
      };
    },
  };
}

function passkeyService(stored: {
  account?: Record<string, any>;
  signing?: Record<string, any>;
}) {
  const challenges = new Map<string, Record<string, any>>();
  const counters: string[] = [];
  const byCredential =
    (row?: Record<string, any>) =>
    async (args: { where: { credentialId: string } }) =>
      row && row.credentialId === args.where.credentialId ? row : null;
  const prisma = {
    accountPasskey: {
      findMany: async () => (stored.account ? [stored.account] : []),
      findUnique: byCredential(stored.account),
      update: async () => void counters.push("account"),
    },
    signingPasskey: {
      findMany: async () => (stored.signing ? [stored.signing] : []),
      findUnique: byCredential(stored.signing),
      update: async () => void counters.push("signing"),
    },
    passkeyChallenge: {
      deleteMany: async () => ({ count: 0 }),
      create: async (args: { data: Record<string, any> }) => {
        const id = `00000000-0000-4000-8000-00000000000${challenges.size}`;
        challenges.set(id, {
          id,
          userId: null,
          consumedAt: null,
          ...args.data,
        });
        return { id };
      },
      findFirst: async (args: { where: Record<string, any> }) => {
        const row = challenges.get(args.where.id);
        return row &&
          row.purpose === args.where.purpose &&
          row.userId === args.where.userId &&
          row.consumedAt === null
          ? row
          : null;
      },
      updateMany: async (args: { where: { id: string } }) => {
        const row = challenges.get(args.where.id);
        if (!row || row.consumedAt) return { count: 0 };
        row.consumedAt = new Date();
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => ({ id: USER, email: "user@example.test" }),
    },
  };
  const service = new AccountPasskeyService(
    prisma as never,
    {
      get: (key: string) => (key === "general.appUrl" ? ORIGIN : "PrivCloud"),
    } as never,
  );
  Object.assign(service, { logger: { log: () => undefined } });
  return { service, counters };
}

const row = (credentialId: string, publicKey: Buffer) => ({
  id: `row-${credentialId}`,
  userId: USER,
  credentialId,
  publicKey,
  counter: BigInt(0),
  transports: null,
});

async function refused(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: { getStatus?: () => number }) => {
    assert.equal(error.getStatus?.(), 401);
    return true;
  });
}

testCase("the sign-in ceremony names no account and requires UV", async () => {
  const { service } = passkeyService({});
  const { challengeId, options } = await service.beginLogin();
  assert.ok(challengeId);
  assert.equal(options.rpId, RP_ID);
  assert.equal(options.userVerification, "required");
  assert.equal(options.allowCredentials?.length ?? 0, 0);
});

testCase("an account passkey signs in, once per challenge", async () => {
  const device = authenticator();
  const { service, counters } = passkeyService({
    account: row("account-cred", device.publicKey),
  });
  const { challengeId, options } = await service.beginLogin();
  const answer = device.assert(
    "account-cred",
    options.challenge,
    `account:${USER}`,
  );
  const user = await service.verifyLogin({ challengeId, response: answer });
  assert.equal(user.id, USER);
  assert.deepEqual(counters, ["account"]);
  // The same answer cannot open a second session.
  await refused(service.verifyLogin({ challengeId, response: answer }));
});

testCase("a passkey enrolled for a signature signs in too", async () => {
  const device = authenticator();
  const { service, counters } = passkeyService({
    signing: row("signing-cred", device.publicKey),
  });
  const { challengeId, options } = await service.beginLogin();
  const user = await service.verifyLogin({
    challengeId,
    response: device.assert("signing-cred", options.challenge, USER),
  });
  assert.equal(user.id, USER);
  assert.deepEqual(counters, ["signing"]);
});


testCase(
  "forged, foreign or unverified answers all get the same 401",
  async () => {
    const device = authenticator();
    const intruder = authenticator();
    const { service } = passkeyService({
      account: row("account-cred", device.publicKey),
    });
    let ceremony = await service.beginLogin();
    // Signed by another key.
    await refused(
      service.verifyLogin({
        challengeId: ceremony.challengeId,
        response: intruder.assert(
          "account-cred",
          ceremony.options.challenge,
          `account:${USER}`,
        ),
      }),
    );
    // Unknown credential.
    await refused(
      service.verifyLogin({
        challengeId: ceremony.challengeId,
        response: device.assert("other", ceremony.options.challenge, null),
      }),
    );
    // A handle naming another account.
    await refused(
      service.verifyLogin({
        challengeId: ceremony.challengeId,
        response: device.assert(
          "account-cred",
          ceremony.options.challenge,
          "account:someone-else",
        ),
      }),
    );
    // No user verification (no PIN, no biometrics).
    await refused(
      service.verifyLogin({
        challengeId: ceremony.challengeId,
        response: device.assert(
          "account-cred",
          ceremony.options.challenge,
          `account:${USER}`,
          { userVerified: false },
        ),
      }),
    );
    // Answer to another challenge.
    const other = await service.beginLogin();
    await refused(
      service.verifyLogin({
        challengeId: other.challengeId,
        response: device.assert(
          "account-cred",
          ceremony.options.challenge,
          `account:${USER}`,
        ),
      }),
    );
    ceremony = await service.beginLogin();
    assert.equal(
      (
        await service.verifyLogin({
          challengeId: ceremony.challengeId,
          response: device.assert(
            "account-cred",
            ceremony.options.challenge,
            `account:${USER}`,
          ),
        })
      ).id,
      USER,
    );
  },
);

testCase(
  "the evidence vault opens for the administrator's own passkey only",
  async () => {
    const device = authenticator();
    const intruder = authenticator();
    const admin = { id: USER, email: "admin@example.test" };
    await assert.rejects(
      passkeyService({}).service.beginVault(admin as never),
      (error: { getStatus?: () => number }) => {
        assert.equal(error.getStatus?.(), 403);
        return true;
      },
    );
    const { service } = passkeyService({
      account: row("account-cred", device.publicKey),
    });
    let ceremony = await service.beginVault(admin as never);
    assert.equal(ceremony.options.userVerification, "required");
    assert.deepEqual(
      ceremony.options.allowCredentials?.map((credential) => credential.id),
      ["account-cred"],
    );
    await assert.rejects(
      service.verifyVault(admin as never, {
        challengeId: ceremony.challengeId,
        response: intruder.assert(
          "account-cred",
          ceremony.options.challenge,
          `account:${USER}`,
        ),
      }),
    );
    ceremony = await service.beginVault(admin as never);
    const answer = device.assert(
      "account-cred",
      ceremony.options.challenge,
      `account:${USER}`,
    );
    await service.verifyVault(admin as never, {
      challengeId: ceremony.challengeId,
      response: answer,
    });
    // One opening per answer.
    await assert.rejects(
      service.verifyVault(admin as never, {
        challengeId: ceremony.challengeId,
        response: answer,
      }),
    );
  },
);

// Random stand-ins for the issued session values.
const ISSUED = {
  login: randomUUID(),
  refresh: randomUUID(),
  refreshId: randomUUID(),
  access: randomUUID(),
};

function authService() {
  const auth = Object.create(AuthService.prototype) as AuthService;
  const calls: string[] = [];
  Object.assign(auth, {
    logger: { log: () => undefined, warn: () => undefined },
    config: { get: () => false },
    prisma: {
      loginToken: { deleteMany: async () => ({ count: 0 }) },
      user: { update: async () => void calls.push("reset") },
    },
    createLoginToken: async () => {
      calls.push("loginToken");
      return ISSUED.login;
    },
    createRefreshToken: async () => ({
      refreshToken: ISSUED.refresh,
      refreshTokenId: ISSUED.refreshId,
    }),
    createAccessToken: async () => ISSUED.access,
  });
  return { auth, calls };
}

testCase("a passkey stands for both factors, never for a lock", async () => {
  const { auth, calls } = authService();
  const user = {
    id: USER,
    totpVerified: true,
    failedLoginAttempts: 2,
    lockedUntil: null,
    emailVerificationRequiredAt: null,
    emailVerifiedAt: new Date(),
  };
  assert.deepEqual(await auth.signInWithPasskey(user as never), {
    accessToken: ISSUED.access,
    refreshToken: ISSUED.refresh,
  });
  assert.deepEqual(calls, ["reset"]);
  // The password path still asks for the TOTP code.
  assert.deepEqual(await auth.generateToken(user as never), {
    loginToken: ISSUED.login,
  });
  await assert.rejects(
    auth.signInWithPasskey({
      ...user,
      lockedUntil: new Date(Date.now() + 60_000),
    } as never),
    (error: { getStatus?: () => number }) => {
      assert.equal(error.getStatus?.(), 429);
      return true;
    },
  );
});

testCase(
  "team evidence assertions bind account, team, copy and download kind, and cannot be replayed",
  async () => {
    const device = authenticator()
    const { service } = passkeyService({
      account: row("account-cred", device.publicKey),
    })
    const user = { id: USER } as never
    const ceremony = await service.beginTeamEvidence(
      user,
      "team-a",
      "copy-a",
      "evidence",
    )
    const dto = {
      challengeId: ceremony.challengeId,
      response: device.assert(
        "account-cred",
        ceremony.options.challenge,
        `account:${USER}`,
      ),
    } as never
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-b", "copy-a", "evidence", dto),
    )
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-a", "copy-b", "evidence", dto),
    )
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-a", "copy-a", "certificate", dto),
    )
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-a", "copy-a", "pattern", dto),
    )
    await assert.rejects(
      service.verifyTeamEvidence(
        { id: "other-admin" } as never,
        "team-a",
        "copy-a",
        "evidence",
        dto,
      ),
    )
    await assert.rejects(service.verifyVault(user, dto))
    await service.verifyTeamEvidence(user, "team-a", "copy-a", "evidence", dto)
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-a", "copy-a", "evidence", dto),
    )
  },
)

testCase(
  "team evidence refuses missing verification and foreign origins",
  async () => {
    for (const options of [
      { userVerified: false },
      { origin: "https://attacker.example.test" },
      { origin: "android:apk-key-hash:untrusted" },
    ]) {
      const device = authenticator()
      const { service } = passkeyService({
        account: row("account-cred", device.publicKey),
      })
      const user = { id: USER } as never
      const ceremony = await service.beginTeamEvidence(
        user,
        "team-a",
        "copy-a",
        "evidence",
      )
      const dto = {
        challengeId: ceremony.challengeId,
        response: device.assert(
          "account-cred",
          ceremony.options.challenge,
          `account:${USER}`,
          options,
        ),
      } as never
      const result = service.verifyTeamEvidence(
        user,
        "team-a",
        "copy-a",
        "evidence",
        dto,
      )
      await assert.rejects(result)
    }
  },
)

testCase(
  "team evidence has no password or session-only fallback when the account has no passkey",
  async () => {
    const { service } = passkeyService({})
    await assert.rejects(
      service.beginTeamEvidence(
        { id: USER } as never,
        "team",
        "copy",
        "evidence",
      ),
    )
  },
)

testCase(
  "pattern diagnostics require a distinct single-use passkey assertion",
  async () => {
    const device = authenticator()
    const { service } = passkeyService({
      account: row("account-cred", device.publicKey),
    })
    const user = { id: USER } as never
    const ceremony = await service.beginTeamEvidence(
      user,
      "team-a",
      "copy-a",
      "pattern",
    )
    const dto = {
      challengeId: ceremony.challengeId,
      response: device.assert(
        "account-cred",
        ceremony.options.challenge,
        `account:${USER}`,
      ),
    } as never
    assert.equal(ceremony.options.userVerification, "required")
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-a", "copy-a", "evidence", dto),
    )
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-a", "copy-a", "certificate", dto),
    )
    await service.verifyTeamEvidence(user, "team-a", "copy-a", "pattern", dto)
    await assert.rejects(
      service.verifyTeamEvidence(user, "team-a", "copy-a", "pattern", dto),
    )
  },
)

void run();
