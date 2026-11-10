import assert from "node:assert/strict";
import { UserController } from "src/user/user.controller";
import { UserSevice } from "src/user/user.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Administrators' user list");

const account = (id: string, teamMemberships: unknown[]) => ({
  id,
  username: id,
  email: `${id}@example.test`,
  teamMemberships,
});

testCase("each account lists the teams it has joined", async () => {
  const controller = Object.create(UserController.prototype) as UserController;
  Object.assign(controller, {
    userService: {
      list: async () => [
        account("member", [
          { id: "m-1", role: "OWNER", team: { name: "Alpha" } },
          { id: "m-2", role: "MEMBER", team: { name: "Beta" } },
        ]),
        account("solo", []),
      ],
    },
    shareQuotaService: { getUsageSummaries: async () => new Map() },
  });

  const [member, solo] = await controller.list();
  assert.deepEqual(member.teams, [
    { name: "Alpha", role: "OWNER" },
    { name: "Beta", role: "MEMBER" },
  ]);
  assert.deepEqual(solo.teams, []);
});

testCase("the query keeps what the share quota reads", async () => {
  let query: {
    orderBy: unknown;
    include: { teamMemberships: { where: unknown; select: { id: boolean } } };
  };
  const service = Object.create(UserSevice.prototype) as UserSevice;
  Object.assign(service, {
    prisma: {
      user: {
        findMany: async (args: typeof query) => {
          query = args;
          return [];
        },
      },
    },
  });

  await service.list();
  assert.deepEqual(query.orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.deepEqual(query.include.teamMemberships.where, { isActive: true });
  assert.equal(query.include.teamMemberships.select.id, true);
});

void run();
