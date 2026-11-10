import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import { verifiedEmailFold } from "src/config/account-secrets";
import { OAuthService } from "src/oauth/oauth.service";
import { TeamService } from "src/team/team.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Team invitation address");

const invited = "invited@entra.example";
const user = {
  id: "user-1",
  email: "account@example.test",
  username: "account",
};

function acceptance(
  options: {
    links?: { verifiedEmail: string }[];
    contractors?: string[];
  } = {},
) {
  const joined: string[] = [];
  const service = Object.create(TeamService.prototype) as TeamService;
  Object.assign(service, {
    logger: { log: () => undefined },
    logAccess: async () => undefined,
    prisma: {
      teamInvitation: {
        findUnique: async () => ({
          id: "invitation-1",
          email: invited,
          role: "MEMBER",
          status: "PENDING",
          teamId: "team-1",
          expiresAt: new Date(Date.now() + 60_000),
          team: { name: "Team", keyVersion: 1 },
        }),
        update: async () => undefined,
      },
      user: { findUnique: async () => user },
      oAuthUser: {
        findMany: async ({ where }: { where: { userId: string } }) => {
          assert.equal(where.userId, user.id);
          return options.links ?? [];
        },
      },
      teamExternalSeat: {
        findFirst: async ({
          where,
        }: {
          where: { OR?: { email?: string }[] };
        }) =>
          where.OR?.some(
            ({ email }) => email && options.contractors?.includes(email),
          )
            ? { id: "seat-1" }
            : null,
      },
      teamMember: {
        upsert: async ({
          where,
        }: {
          where: { userId_teamId: { userId: string } };
        }) => {
          joined.push(where.userId_teamId.userId);
        },
      },
    },
  });
  return {
    joined,
    accept: () => service.acceptInvitation("token", user.id),
  };
}

testCase("the account's own address is enough", async () => {
  const { joined, accept } = acceptance();
  Object.assign(user, { email: invited.toUpperCase() });
  try {
    await accept();
  } finally {
    Object.assign(user, { email: "account@example.test" });
  }
  assert.deepEqual(joined, [user.id]);
});

testCase("an address a linked provider vouches for is accepted", async () => {
  const { joined, accept } = acceptance({
    links: [{ verifiedEmail: invited }],
  });
  await accept();
  assert.deepEqual(joined, [user.id]);
});

testCase("any other address is refused with its own code", async () => {
  const { joined, accept } = acceptance({
    links: [{ verifiedEmail: "someone@else.example" }],
  });
  await assert.rejects(accept(), (error: ForbiddenException) => {
    assert.equal(error.getStatus(), 403);
    assert.equal(
      (error.getResponse() as { error: string }).error,
      "invitation_email_mismatch",
    );
    return true;
  });
  assert.deepEqual(joined, []);
});

testCase("a contractor of the team stays refused", async () => {
  const { joined, accept } = acceptance({
    links: [{ verifiedEmail: invited }],
    contractors: [invited],
  });
  await assert.rejects(accept());
  assert.deepEqual(joined, []);
});

function linkedAccount(verifiedEmail: string | null) {
  const updates: unknown[] = [];
  const created: Record<string, unknown>[] = [];
  const service = Object.create(OAuthService.prototype) as OAuthService;
  const row = {
    id: "link-1",
    userId: user.id,
    provider: "microsoft",
    providerUserId: "sub-1",
    verifiedEmail,
    verifiedEmailFold: verifiedEmail ? verifiedEmailFold(verifiedEmail) : null,
  };
  const folds: unknown[] = [];
  Object.assign(service, {
    logger: { log: () => undefined },
    auth: { generateToken: async () => ({ accessToken: "token" }) },
    prisma: {
      oAuthUser: {
        findFirst: async () => row,
        update: async ({
          data,
        }: {
          data: { verifiedEmail: string | null; verifiedEmailFold: unknown };
        }) => {
          updates.push(data.verifiedEmail);
          folds.push(data.verifiedEmailFold);
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
        },
      },
      user: { findFirst: async () => user, update: async () => undefined },
    },
  });
  const signIn = (email?: string) =>
    service.signIn(
      {
        provider: "microsoft",
        providerId: "sub-1",
        providerUsername: "someone",
        email,
      },
      "127.0.0.1",
    );
  return { service, signIn, updates, folds, created, row };
}

testCase(
  "each sign-in refreshes the address the provider vouches for",
  async () => {
    const first = linkedAccount(null);
    await first.signIn("Invited@Entra.example");
    assert.deepEqual(first.updates, [invited]);
    assert.deepEqual(first.folds, [verifiedEmailFold(invited)]);

    const unchanged = linkedAccount(invited);
    await unchanged.signIn(invited);
    assert.deepEqual(unchanged.updates, []);

    const withdrawn = linkedAccount(invited);
    await withdrawn.signIn(undefined);
    assert.deepEqual(withdrawn.updates, [null]);
    assert.deepEqual(withdrawn.folds, [null]);

    // Written by an older image: the address is kept, its lookup form added.
    const unindexed = linkedAccount(invited);
    unindexed.row.verifiedEmailFold = null;
    await unindexed.signIn(invited);
    assert.deepEqual(unindexed.folds, [verifiedEmailFold(invited)]);
  },
);

testCase("linking keeps only what the provider verified", async () => {
  const { service, created } = linkedAccount(null);
  const prisma = (
    service as unknown as {
      prisma: { oAuthUser: { findFirst: () => Promise<null> } };
    }
  ).prisma;
  prisma.oAuthUser.findFirst = async () => null;
  await service.link(user.id, "microsoft", "sub-2", "someone", invited);
  await service.link(user.id, "microsoft", "sub-3", "someone");
  assert.equal(created[0].verifiedEmail, invited);
  assert.equal(created[0].verifiedEmailFold, verifiedEmailFold(invited));
  assert.equal(created[1].verifiedEmail, null);
  assert.equal(created[1].verifiedEmailFold, null);
});

void run();
