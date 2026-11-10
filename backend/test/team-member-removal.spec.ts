import "reflect-metadata";
import assert from "node:assert/strict";
import { OAuthService } from "src/oauth/oauth.service";
import { TeamService } from "src/team/team.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "Team member removal and provider usernames",
);

const member = {
  id: "member",
  teamId: "team",
  userId: "user",
  role: "MEMBER",
  isActive: true,
};

function recordingPrisma() {
  const calls: { call: string; args: unknown }[] = [];
  const prisma = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_model, method: string) => async (args: unknown) => {
              calls.push({ call: `${model}.${method}`, args });
              if (method === "findMany") return [];
              if (method.startsWith("find")) {
                return model === "teamMember" ? member : { id: "row" };
              }
              return { count: 0 };
            },
          },
        ),
    },
  );
  return { calls, prisma };
}

function teamServiceWith(prisma: object) {
  const logger = { log() {}, warn() {}, error() {} };
  const service = new Proxy(Object.create(TeamService.prototype), {
    get: (target, property, receiver) => {
      if (property === "prisma") return prisma;
      if (property === "logger") return logger;
      if (property === "assertTeamRole" || property === "logAccess") {
        return async () => undefined;
      }
      if (property === "assertNotExternalContractor") {
        return async () => undefined;
      }
      const value = Reflect.get(target, property, receiver);
      return value ?? (async () => undefined);
    },
  });
  return service as TeamService;
}

function assertRulesDeleted(calls: { call: string; args: unknown }[]) {
  const deletion = calls.find((c) => c.call === "teamFolderAccess.deleteMany");
  assert.deepEqual(deletion?.args, { where: { memberId: "member" } });
}

testCase("an owner removing a member clears their folder rules", async () => {
  const { calls, prisma } = recordingPrisma();
  await teamServiceWith(prisma).removeMember("team", "member", "owner");
  assertRulesDeleted(calls);
});

testCase("a platform admin removing a member clears their rules", async () => {
  const { calls, prisma } = recordingPrisma();
  await teamServiceWith(prisma).adminRemoveMember("team", "member");
  assertRulesDeleted(calls);
});

testCase(
  "inviting someone again sends a new mail and renews the link",
  async () => {
    const expiredInvitation = {
      id: "invitation",
      token: "token",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 1000),
    };
    const enqueued: unknown[] = [];
    const upserts: unknown[] = [];
    const service = teamServiceWith({
      team: { findUnique: async () => ({ members: [], maxMembers: 3 }) },
      teamInvitation: {
        findUnique: async () => expiredInvitation,
      },
      teamMember: { findUnique: async () => null },
      user: { findUnique: async () => null },
      $transaction: async (run: (client: unknown) => unknown) =>
        run({
          teamInvitation: {
            upsert: async (args: unknown) => {
              upserts.push(args);
              return expiredInvitation;
            },
          },
        }),
    });
    Object.assign(service, {
      configService: { get: async () => "https://app.test" },
      emailOutbox: {
        enqueue: async (_client: unknown, message: unknown) =>
          enqueued.push(message),
        deliverPending: async () => undefined,
      },
    });

    const result = await service.inviteMember(
      "team",
      { email: "person@example.test" } as never,
      "owner",
    );

    assert.equal(result.invited, true);
    assert.equal(upserts.length, 1);
    assert.equal(enqueued.length, 1);
  },
);

testCase("revoking an invitation deletes it and its link", async () => {
  const { calls, prisma } = recordingPrisma();
  const service = teamServiceWith(prisma);
  await service.revokeInvitation("team", "invitation", "owner");
  assert.deepEqual(
    calls.find((c) => c.call === "teamInvitation.findFirst")?.args,
    { where: { id: "invitation", teamId: "team", status: "PENDING" } },
  );
  assert.deepEqual(
    calls.find((c) => c.call === "teamInvitation.delete")?.args,
    { where: { id: "row" } },
  );
});

testCase(
  "the pending list exposes neither links nor expired rows",
  async () => {
    const { calls, prisma } = recordingPrisma();
    await teamServiceWith(prisma).getPendingInvitations("team", "owner");
    const { select, where } = calls[0].args as {
      select: Record<string, boolean>;
      where: { status: string; expiresAt: { gt: Date } };
    };
    assert.equal(select.token, undefined);
    assert.equal(where.status, "PENDING");
    assert.ok(where.expiresAt.gt instanceof Date);
  },
);

async function usernameFor(identifier: string, taken: string[] = []) {
  const service = Object.create(OAuthService.prototype);
  service.prisma = {
    user: {
      findFirst: async ({ where }: { where: { username: string } }) =>
        taken.includes(where.username) ? { id: "taken" } : null,
    },
  };
  return service.getAvailableUsername(identifier) as Promise<string>;
}

testCase("a provider identifier gives a clean username", async () => {
  assert.equal(
    await usernameFor("admin@simonprivcloud.onmicrosoft.com"),
    "admin",
  );
  assert.equal(await usernameFor("jean.dupont"), "jean.dupont");
  assert.equal(
    await usernameFor("abcdefghijklmnopqrs.tuvw"),
    "abcdefghijklmnopqrs",
  );
  assert.equal(await usernameFor("ab@example.test"), "abexample.test");
  assert.match(
    await usernameFor("admin@example.test", ["admin"]),
    /^admin_[A-Za-z0-9_]{1,10}$/,
  );
});

void run();
