import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Prisma } from "@prisma/client";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";
import {
  SIGNATURE_PUSH_FILTER,
  SIGNATURE_PUSH_MEMBERSHIP,
} from "src/teamNotification/signature-notification-policy";
import { UpdateOwnUserDTO } from "src/user/dto/updateOwnUser.dto";
import { UserController } from "src/user/user.controller";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signature push preferences");
function harness(enabled = true, memberships: string[] = []) {
  const rows: Record<string, unknown>[] = [];
  const pushes: unknown[] = [];
  const queries: Prisma.TeamNotificationFindManyArgs[] = [];
  const service = new TeamNotificationService(
    {
      user: {
        findUnique: async (query: Prisma.UserFindUniqueArgs) => {
          const selected = query.select?.teamMemberships;
          assert.ok(selected && typeof selected === "object");
          assert.deepEqual(selected.where, SIGNATURE_PUSH_MEMBERSHIP);
          return {
            signaturePushEnabled: enabled,
            teamMemberships: memberships.map((teamId) => ({ teamId })),
          };
        },
      },
      teamNotification: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return { id: "notice", ...data };
        },
        findMany: async (query: Prisma.TeamNotificationFindManyArgs) => {
          queries.push(query);
          return [];
        },
        count: async () => 0,
      },
    } as never,
    {
      sendToUser: async (...args: unknown[]) => {
        pushes.push(args);
      },
    } as never,
  );
  return { service, rows, pushes, queries };
}
for (const teamId of [undefined, "sender-team"]) {
  testCase(
    `accounts without a team can receive invitations and finalized documents from ${teamId ?? "personal space"}`,
    async () => {
      const h = harness();
      await h.service.notifySignatureInvitation({
        userId: "recipient",
        actorId: "sender",
        documentTeamId: teamId,
        encryptedMetadata: "foreign-envelope",
      });
      await h.service.notifySignatureCompletion({
        userId: "recipient",
        actorId: "sender",
        documentTeamId: teamId,
        encryptedMetadata: "foreign-envelope",
      });
      assert.equal(h.rows.length, 2);
      assert.ok(
        h.rows.every(
          (row) => row.teamId === null && row.encryptedMetadata === null,
        ),
      );
      assert.equal(h.pushes.length, 2);
      assert.match(JSON.stringify(h.pushes), /New signature request/);
      assert.match(JSON.stringify(h.pushes), /Signed document ready/);
      assert.doesNotMatch(
        JSON.stringify(h.pushes),
        /foreign-envelope|sender-team|fileName|signingToken/,
      );
    },
  );
}
testCase(
  "opting out suppresses generic signature pushes without deleting encrypted inbox actions",
  async () => {
    const h = harness(false, ["source-team"]);
    await h.service.notifySignatureInvitation({
      userId: "recipient",
      actorId: "sender",
    });
    await h.service.notifySignatureCompletion({
      userId: "recipient",
      actorId: "sender",
      documentTeamId: "source-team",
      encryptedMetadata: "sealed-action",
    });
    assert.equal(h.pushes.length, 0);
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0].encryptedMetadata, "sealed-action");
  },
);
testCase(
  "catch-up respects the signature preference while the inbox remains accessible",
  async () => {
    const h = harness();
    await h.service.getNotifications("recipient", { pushOnly: true });
    assert.deepEqual(h.queries[0].where, {
      userId: "recipient",
      ...SIGNATURE_PUSH_FILTER,
    });
    await h.service.getNotifications("recipient");
    assert.deepEqual(h.queries[1].where, { userId: "recipient" });
  },
);
testCase(
  "signed-in users can save the signature option without any subscription or membership lookup",
  async () => {
    const controller = new UserController(
      {
        update: async (_id: string, data: Record<string, unknown>) => data,
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const saved = await controller.updateCurrentUser(
      { id: "recipient", email: "recipient@example.test" } as never,
      { signaturePushEnabled: true },
    );
    assert.equal(saved.signaturePushEnabled, true);
  },
);
testCase(
  "preference payloads accept only explicit booleans and persist download modes",
  async () => {
    for (const value of [true, false])
      assert.equal(
        (
          await validate(
            plainToInstance(UpdateOwnUserDTO, { signaturePushEnabled: value }),
          )
        ).length,
        0,
      );
    for (const value of [null, "true", 1, [], {}])
      assert.ok(
        (
          await validate(
            plainToInstance(UpdateOwnUserDTO, { signaturePushEnabled: value }),
          )
        ).length > 0,
      );
    assert.equal(
      (
        await validate(
          plainToInstance(UpdateOwnUserDTO, { notificationMode: "WEEKLY" }),
        )
      ).length,
      0,
    );
  },
);
void run();
