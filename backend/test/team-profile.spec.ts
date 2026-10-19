import "reflect-metadata";
import assert from "node:assert/strict";
import { TeamService } from "src/team/team.service";
import { coveredRotationMetadata } from "src/team/team-rotation-metadata.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("team profile");

const TEAM = "11111111-1111-4111-8111-111111111111";
// [IV 12][64 padded bytes][tag 16] = 92 bytes, as the browser produces it.
const envelope = (byte: number) => Buffer.alloc(92, byte).toString("base64url");

async function rejects(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: { getStatus?: () => number }) => {
    assert.equal(error.getStatus?.(), status);
    return true;
  });
}

function service(role: string) {
  const writes: unknown[] = [];
  const team = new TeamService(
    {
      teamProfile: {
        findUnique: async () => ({
          encryptedInfo: envelope(1),
          keyVersion: 3,
          updatedAt: new Date(),
        }),
        upsert: async (args: unknown) => {
          writes.push(args);
          return {};
        },
        deleteMany: async () => ({ count: 1 }),
      },
      team: { findUnique: async () => ({ keyVersion: 3 }) },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Object.assign(team, {
    assertTeamMembership: async () => ({ id: "member", role }),
  });
  return { team, writes };
}

testCase(
  "only team administrators read or write the company details",
  async () => {
    const member = service("MEMBER");
    await rejects(member.team.getTeamProfile(TEAM, "user"), 403);
    await rejects(
      member.team.setTeamProfile(TEAM, "user", {
        encryptedInfo: envelope(2),
        keyVersion: 3,
      }),
      403,
    );
    assert.equal(member.writes.length, 0);
    const admin = service("ADMIN");
    assert.equal(
      (await admin.team.getTeamProfile(TEAM, "user"))?.keyVersion,
      3,
    );
    await admin.team.setTeamProfile(TEAM, "user", {
      encryptedInfo: envelope(2),
      keyVersion: 3,
    });
    assert.equal(admin.writes.length, 1);
  },
);

testCase(
  "details encrypted with an older team key or malformed are refused",
  async () => {
    const { team, writes } = service("OWNER");
    await rejects(
      team.setTeamProfile(TEAM, "user", {
        encryptedInfo: envelope(2),
        keyVersion: 2,
      }),
      409,
    );
    await rejects(
      team.setTeamProfile(TEAM, "user", {
        encryptedInfo: "c2hvcnQ",
        keyVersion: 3,
      }),
      400,
    );
    assert.equal(writes.length, 0);
  },
);

testCase(
  "a key rotation cannot complete without re-encrypting the profile",
  () => {
    const rows = [{ id: TEAM, encryptedInfo: envelope(1) }];
    assert.throws(() => coveredRotationMetadata(rows, "PROFILE", []));
    assert.throws(() =>
      coveredRotationMetadata(rows, "PROFILE", [
        {
          kind: "PROFILE",
          id: TEAM,
          expectedEncryptedInfo: envelope(9),
          encryptedInfo: envelope(2),
        },
      ]),
    );
    const staged = {
      kind: "PROFILE" as const,
      id: TEAM,
      expectedEncryptedInfo: envelope(1),
      encryptedInfo: envelope(2),
    };
    assert.deepEqual(coveredRotationMetadata(rows, "PROFILE", [staged]), [
      staged,
    ]);
  },
);

void run();
