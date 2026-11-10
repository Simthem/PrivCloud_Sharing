import assert from "node:assert/strict";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Team folder limit");

process.env.TEAM_MAX_FOLDERS = "20";

testCase(
  "the team detail carries the deployment's folder ceiling",
  async () => {
    const { TeamService } = await import("src/team/team.service");
    const service = Object.create(TeamService.prototype) as InstanceType<
      typeof TeamService
    >;
    const team = {
      id: "team-1",
      name: "Team",
      keyVersion: 1,
      maxShareSize: BigInt(1),
      totalStorageLimit: BigInt(1),
      storageUsed: BigInt(0),
      members: [
        {
          id: "m-1",
          role: "OWNER",
          wrappedTeamKey: "k",
          teamKeyVersion: 1,
          user: { id: "u-1", username: "u", email: "u@x" },
        },
      ],
    };
    Object.assign(service, {
      prisma: { team: { findFirst: async () => team } },
    });
    const detail = await service.getTeam("team-1", "u-1");
    assert.equal(detail.maxFolders, 20);
    assert.equal(
      (detail.members[0] as { keyStatus?: string }).keyStatus,
      "CURRENT",
    );
  },
);

void run();
