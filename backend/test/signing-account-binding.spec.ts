import "reflect-metadata";
import assert from "node:assert/strict";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { verifiedEmailFold } from "src/config/account-secrets";
import { OAuthService, vouchedEmail } from "src/oauth/oauth.service";
import { SigningService } from "src/signing/signing.service";
import { TeamService } from "src/team/team.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signing account binding");

type Account = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  emailVerificationSource: string | null;
  ldapDN: string | null;
  oAuthUsers: { provider: string }[];
};

const account = (id: string, email: string, provider?: string): Account => ({
  id,
  email,
  emailVerifiedAt: null,
  emailVerificationSource: null,
  ldapDN: null,
  oAuthUsers: provider ? [{ provider }] : [],
});

function signingService(prisma: Record<string, unknown>, mails?: string[][]) {
  const service = new SigningService(
    prisma as never,
    {
      sendSigningMail: async (email: string, subject: string, body: string) => {
        mails?.push([email, subject, body]);
      },
    } as never,
    {} as never,
    {
      get: (key: string) =>
        key === "smtp.enabled" ? true : "unit-test-signing-secret",
    } as never,
    {} as never,
    {} as never,
    {} as never,
    { notifyTeamMembers: async () => [] } as never,
  );
  Object.assign(service, { createAuditEvent: async () => undefined });
  return service;
}

function lookup(
  owners: Account[],
  links: { userId: string; verifiedEmail: string; fold?: string }[],
) {
  const asked: string[][] = [];
  const service = signingService({
    user: {
      findMany: async () => owners,
    },
    oAuthUser: {
      findMany: async ({
        where,
      }: {
        where: { verifiedEmailFold: { in: string[] } };
      }) => {
        asked.push(where.verifiedEmailFold.in);
        return links
          .filter((link) =>
            where.verifiedEmailFold.in.includes(
              link.fold ?? verifiedEmailFold(link.verifiedEmail),
            ),
          )
          .map((link) => ({
            userId: link.userId,
            verifiedEmail: link.verifiedEmail,
            user: account(link.userId, `${link.userId}@primary.test`, "github"),
          }));
      },
    },
  });
  return {
    asked,
    eligible: async (email: string) =>
      (await service.checkReinforcedEligibility([email])).recipients[0]
        .eligible,
  };
}

testCase("the account's own address binds as before", async () => {
  const { asked, eligible } = lookup(
    [account("u1", "Owner@Example.test", "google")],
    [],
  );
  assert.equal(await eligible("owner@example.test"), true);
  assert.deepEqual(asked, []);
});

testCase(
  "an address a linked provider vouches for reaches its account",
  async () => {
    const { eligible } = lookup(
      [],
      [{ userId: "u2", verifiedEmail: "work@entra.example" }],
    );
    assert.equal(await eligible("Work@Entra.example"), true);
  },
);

testCase("a stale lookup form never binds another address", async () => {
  const { eligible } = lookup(
    [],
    [
      {
        userId: "u2",
        verifiedEmail: "old@entra.example",
        fold: verifiedEmailFold("work@entra.example"),
      },
    ],
  );
  assert.equal(await eligible("work@entra.example"), false);
});

testCase("an address two accounts vouch for binds none", async () => {
  const { eligible } = lookup(
    [],
    [
      { userId: "u2", verifiedEmail: "shared@entra.example" },
      { userId: "u3", verifiedEmail: "shared@entra.example" },
    ],
  );
  assert.equal(await eligible("shared@entra.example"), false);
});

testCase("an account's own address wins over a linked one", async () => {
  const { asked, eligible } = lookup(
    [account("u1", "both@example.test")],
    [{ userId: "u2", verifiedEmail: "both@example.test" }],
  );
  // u1 has no proof of its own: the linked account must not take over.
  assert.equal(await eligible("both@example.test"), false);
  assert.deepEqual(asked, []);
});

testCase("the lookup form ignores case and changes with the key", () => {
  assert.equal(
    verifiedEmailFold("A@B.example"),
    verifiedEmailFold("a@b.example"),
  );
  assert.notEqual(
    verifiedEmailFold("a@b.example"),
    verifiedEmailFold("c@b.example"),
  );
  assert.doesNotMatch(verifiedEmailFold("a@b.example"), /a@b/);
});

testCase(
  "received documents also list requests bound to the account",
  async () => {
    let where: { OR?: unknown[] } | undefined;
    const service = signingService({
      user: { findUnique: async () => account("u1", "own@example.test") },
      signatureDocument: {
        findMany: async (args: { where: { OR?: unknown[] } }) => {
          where = args.where;
          return [];
        },
      },
    });
    await service.getReceivedDocuments("u1");
    assert.deepEqual(where?.OR, [
      { recipients: { some: { userId: "u1" } } },
      { recipients: { some: { email: "own@example.test" } } },
    ]);
  },
);

testCase(
  "a reverse share received by the requester can be signed",
  async () => {
    let where: unknown;
    const service = signingService({
      share: {
        findFirst: async (args: { where: unknown }) => {
          where = args.where;
          return null;
        },
      },
    });
    await assert.rejects(
      service.createSignatureRequest(
        {
          shareId: "s1",
          fileId: "f1",
          recipients: [],
          signatureLevel: "REINFORCED",
        } as never,
        { id: "u1" } as never,
      ),
      NotFoundException,
    );
    assert.deepEqual(where, {
      id: "s1",
      OR: [
        { creatorId: "u1" },
        { reverseShare: { creatorId: "u1" }, uploadLocked: true },
      ],
    });
  },
);

testCase(
  "received reverse share PDFs are listed with their wrapped key",
  async () => {
    let where: unknown;
    const team = Object.create(TeamService.prototype) as TeamService;
    Object.assign(team, {
      prisma: {
        teamMember: { findMany: async () => [] },
        share: {
          findMany: async (args: { where: unknown }) => {
            where = args.where;
            return [
              {
                id: "own",
                isE2EEncrypted: true,
                cryptoScheme: 2,
                wrappedShareKey: "wrapped",
                reverseShare: null,
                files: [{ id: "f1", name: "own.pdf", size: "1" }],
              },
              {
                id: "received",
                isE2EEncrypted: true,
                cryptoScheme: null,
                wrappedShareKey: null,
                reverseShare: {
                  creatorId: "u1",
                  encryptedReverseShareKey: "krs",
                },
                files: [
                  { id: "f2", name: "drop.pdf", size: "2" },
                  { id: "f3", name: "notes.txt", size: "3" },
                ],
              },
            ];
          },
        },
      },
    });
    const files = await team.getSignableFiles("u1");
    assert.deepEqual((where as { OR: unknown[] }).OR, [
      { creatorId: "u1", teamFolderId: null },
      { reverseShare: { creatorId: "u1" } },
    ]);
    assert.deepEqual(
      files.map((f) => [
        f.fileId,
        f.received ?? false,
        f.encryptedReverseShareKey,
      ]),
      [
        ["f1", false, undefined],
        ["f2", true, "krs"],
      ],
    );
  },
);

function enrollment(overrides: Record<string, unknown> = {}) {
  const mails: string[][] = [];
  const recipient: Record<string, unknown> = {
    id: "r1",
    documentId: "d1",
    userId: "u1",
    email: "work@entra.example",
    name: "Signer",
    role: "SIGNER",
    status: "VIEWED",
    otpHash: null,
    otpSentAt: null,
    otpFailures: 0,
    otpVerified: false,
    identityVerificationMethod: "OIDC_ACCOUNT",
    document: {
      fileName: "contract.pdf",
      status: "PENDING",
      signatureLevel: "REINFORCED",
      expiresAt: null,
      language: "en",
    },
    ...overrides,
  };
  const service = signingService(
    {
      signatureRecipient: {
        findUnique: async () => recipient,
        updateMany: async ({
          where,
          data,
        }: {
          where: {
            otpHash?: string;
            OR?: { otpSentAt: null | { lt: Date } }[];
          };
          data: Record<string, unknown>;
        }) => {
          if (where.otpHash && where.otpHash !== recipient.otpHash) {
            return { count: 0 };
          }
          const sentAt = recipient.otpSentAt as Date | null;
          if (
            where.OR &&
            !where.OR.some(({ otpSentAt }) =>
              otpSentAt === null ? !sentAt : !!sentAt && sentAt < otpSentAt.lt,
            )
          ) {
            return { count: 0 };
          }
          for (const [key, value] of Object.entries(data)) {
            recipient[key] =
              value && typeof value === "object" && "increment" in value
                ? (recipient[key] as number) +
                  (value as { increment: number }).increment
                : value;
          }
          return { count: 1 };
        },
      },
    },
    mails,
  );
  return { service, recipient, mails, user: { id: "u1" } as never };
}

testCase(
  "a mailed code confirms a passkey enrolment, once and for its account",
  async () => {
    const { service, recipient, mails, user } = enrollment();
    await service.sendPasskeyEnrollmentCode("r1", user);
    assert.equal(mails.length, 1);
    assert.equal(mails[0][0], "work@entra.example");
    assert.match(mails[0][1], /^Passkey confirmation code/);
    const code = mails[0][2].match(/: (\d{6})/)?.[1] as string;

    await assert.rejects(
      service.verifyPasskeyEnrollmentCode("r1", user, "000000"),
      BadRequestException,
    );
    assert.equal(recipient.otpFailures, 1);
    await service.verifyPasskeyEnrollmentCode("r1", user, code);
    assert.equal(recipient.otpHash, null);
    assert.equal(recipient.otpFailures, 0);
    // Identity evidence of the reinforced request stays as it was.
    assert.equal(recipient.otpVerified, false);
    assert.equal(recipient.identityVerificationMethod, "OIDC_ACCOUNT");
    await assert.rejects(
      service.verifyPasskeyEnrollmentCode("r1", user, code),
      BadRequestException,
    );
  },
);

testCase(
  "only the bound account of a reinforced request gets a code",
  async () => {
    const other = enrollment();
    await assert.rejects(
      other.service.sendPasskeyEnrollmentCode("r1", { id: "u2" } as never),
      NotFoundException,
    );
    const standard = enrollment({
      document: {
        fileName: "contract.pdf",
        status: "PENDING",
        signatureLevel: "STANDARD",
        expiresAt: null,
      },
    });
    await assert.rejects(
      standard.service.sendPasskeyEnrollmentCode("r1", standard.user),
      BadRequestException,
    );
    const signed = enrollment({ status: "SIGNED" });
    await assert.rejects(
      signed.service.sendPasskeyEnrollmentCode("r1", signed.user),
      ForbiddenException,
    );
    assert.equal(other.mails.length + standard.mails.length, 0);
  },
);

testCase("a second code waits for the resend delay", async () => {
  const { service, mails, user } = enrollment();
  await service.sendPasskeyEnrollmentCode("r1", user);
  await assert.rejects(
    service.sendPasskeyEnrollmentCode("r1", user),
    BadRequestException,
  );
  assert.equal(mails.length, 1);
});

function linkedRows(rows: Record<string, unknown>[]) {
  const updates: Record<string, unknown>[] = [];
  const service = Object.create(OAuthService.prototype) as OAuthService;
  Object.assign(service, {
    logger: { warn: () => undefined },
    prisma: {
      oAuthUser: {
        findMany: async ({ where }: { where: { id?: { gt: string } } }) =>
          rows.filter((row) => !where.id || (row.id as string) > where.id.gt),
        updateMany: async (args: Record<string, unknown>) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    },
  });
  return { service, updates };
}

testCase("the boot pass indexes rows an older image wrote", async () => {
  const fold = verifiedEmailFold("ok@example.test");
  const { service, updates } = linkedRows([
    { id: "a", userId: "u1", verifiedEmail: "new@example.test" },
    {
      id: "b",
      userId: "u2",
      verifiedEmail: "ok@example.test",
      verifiedEmailFold: fold,
    },
    {
      id: "c",
      userId: "u3",
      verifiedEmail: "moved@example.test",
      verifiedEmailFold: fold,
    },
  ]);
  await service.refreshVerifiedEmailFolds();
  assert.deepEqual(updates, [
    {
      where: { id: "a", verifiedEmailFold: undefined },
      data: { verifiedEmailFold: verifiedEmailFold("new@example.test") },
    },
    {
      where: { id: "c", verifiedEmailFold: fold },
      data: { verifiedEmailFold: verifiedEmailFold("moved@example.test") },
    },
  ]);
});

const idToken = (provider: string, claims: Record<string, unknown>) =>
  `${provider}:e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

testCase(
  "an older link recovers its address from the kept ID token",
  async () => {
    const entra = { provider: "microsoft", providerUserId: "sub-1" };
    assert.equal(
      vouchedEmail(
        entra,
        idToken("microsoft", {
          sub: "sub-1",
          email: "A@Entra.example",
          xms_edov: true,
        }),
      ),
      "a@entra.example",
    );
    // Sign-in trusts neither an unverified address nor another identity.
    assert.equal(
      vouchedEmail(
        entra,
        idToken("microsoft", { sub: "sub-1", email: "a@e.x" }),
      ),
      undefined,
    );
    assert.equal(
      vouchedEmail(
        entra,
        idToken("microsoft", { sub: "sub-2", email: "a@e.x", xms_edov: 1 }),
      ),
      undefined,
    );
    assert.equal(
      vouchedEmail(
        entra,
        idToken("google", {
          sub: "sub-1",
          email: "a@e.x",
          email_verified: true,
        }),
      ),
      undefined,
    );
    assert.equal(
      vouchedEmail(
        { provider: "google", providerUserId: "g" },
        idToken("google", { sub: "g", email: "a@e.x", email_verified: "true" }),
      ),
      undefined,
    );
    assert.equal(vouchedEmail(entra, "microsoft:not-a-jwt"), undefined);

    const updates: Record<string, unknown>[] = [];
    const service = Object.create(OAuthService.prototype) as OAuthService;
    Object.assign(service, {
      prisma: {
        oAuthUser: {
          findMany: async () => [{ id: "l1", userId: "u1", ...entra }],
          updateMany: async (args: Record<string, unknown>) => {
            updates.push(args);
            return { count: 1 };
          },
        },
        refreshToken: {
          findMany: async () => [
            { userId: "u1", oauthIDToken: null },
            {
              userId: "u1",
              oauthIDToken: idToken("microsoft", {
                sub: "sub-1",
                email: "a@entra.example",
                xms_edov: "1",
              }),
            },
          ],
        },
      },
    });
    await service.recoverVerifiedEmails();
    assert.deepEqual(updates, [
      {
        where: { id: "l1", verifiedEmail: null },
        data: {
          verifiedEmail: "a@entra.example",
          verifiedEmailFold: verifiedEmailFold("a@entra.example"),
        },
      },
    ]);
  },
);

void run();
