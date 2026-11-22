import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Team folder guest links");

testCase(
  "creating a folder guest link returns an explicit conflict",
  async () => {
    const { TeamService } = await import("src/team/team.service");
    const service = Object.create(TeamService.prototype) as InstanceType<
      typeof TeamService
    >;
    let created = 0;
    Object.assign(service, {
      assertTeamRole: async () => undefined,
      prisma: {
        teamGuestLink: {
          create: async () => {
            created += 1;
          },
        },
      },
    });
    await assert.rejects(
      service.createGuestLink(
        "team-1",
        "folder-1",
        { folderId: "folder-1" } as never,
        "owner",
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal(error.getStatus(), 409);
        return true;
      },
    );
    assert.equal(created, 0);
  },
);

testCase("only owners and administrators reach the answer", async () => {
  const { TeamService } = await import("src/team/team.service");
  const service = Object.create(TeamService.prototype) as InstanceType<
    typeof TeamService
  >;
  Object.assign(service, {
    assertTeamRole: async () => {
      throw new Error("forbidden");
    },
  });
  await assert.rejects(
    service.createGuestLink("team-1", "folder-1", {} as never, "member"),
    /forbidden/,
  );
});

void run();
