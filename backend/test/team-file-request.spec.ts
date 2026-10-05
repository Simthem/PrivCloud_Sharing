import {
  fileRequestMessages,
  fileRequestServiceEmail,
  fileRequestServiceMessage,
} from "src/teamFileRequest/team-file-request-i18n";
import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  canWriteRequestFolder,
  assertFileRequestUpload,
} from "src/teamFileRequest/team-file-request-access";
import { TeamFileRequestService } from "src/teamFileRequest/team-file-request.service";
import { CreateTeamFileRequestDTO } from "src/teamFileRequest/dto/create-team-file-request.dto";
import { TeamFileRequestController } from "src/teamFileRequest/team-file-request.controller";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import {
  validateFileRequestEnvelope,
  wantsFileRequestNotification,
} from "src/teamFileRequest/team-file-request-notification";
import { ShareService } from "src/share/share.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Team file requests");
const member = {
  id: "member",
  role: "MEMBER",
  isActive: true,
  userId: "recipient",
};
const owner = { id: "owner", role: "OWNER", isActive: true, userId: "creator" };
const rules = [{ memberId: member.id, permission: "WRITE" }];
const request = () => ({
  id: "request",
  teamId: "team",
  creatorId: "creator",
  status: "OPEN",
  expiresAt: new Date(Date.now() + 86400000),
  recipients: [{ userId: "recipient" }],
  folder: {
    id: "folder",
    teamId: "team",
    accessRules: rules,
    team: { isActive: true, members: [member, owner] },
  },
});
const txFor = (row: unknown) => ({
  $executeRaw: async () => 1,
  teamFileRequest: { findUnique: async () => row },
});

testCase("all request routes require JWT for every team member", () => {
  assert.deepEqual(
    Reflect.getMetadata("__guards__", TeamFileRequestController),
    [JwtGuard],
  );
});

testCase(
  "WRITE is explicit, inactive owners and read/deny/unknown permissions fail closed",
  () => {
    assert.equal(canWriteRequestFolder(member, rules), true);
    assert.equal(canWriteRequestFolder(owner, []), true);
    assert.equal(
      canWriteRequestFolder({ ...owner, isActive: false }, rules),
      false,
    );
    for (const permission of ["READ", "NONE", "DENY", "unknown"])
      assert.equal(
        canWriteRequestFolder(member, [{ memberId: member.id, permission }]),
        false,
      );
    assert.equal(canWriteRequestFolder(member, []), false);
  },
);

testCase(
  "validates, trims and bounds the subject, note, IDs, recipients and deadline",
  async () => {
    const dto = plainToInstance(CreateTeamFileRequestDTO, {
      id: "123e4567-e89b-42d3-a456-426614174002",
      recipientScope: "SELECTED",
      notifications: [],
      folderId: "123e4567-e89b-42d3-a456-426614174000",
      subject: "  Documents  ",
      recipientIds: ["123e4567-e89b-42d3-a456-426614174001"],
    });
    assert.equal(dto.subject, "Documents");
    assert.equal((await validate(dto)).length, 0);
    for (const bad of [
      { subject: "   " },
      { subject: "x".repeat(121) },
      { note: "x".repeat(2001) },
      { folderId: "../../folder" },
      { recipientIds: [] },
      { recipientIds: [dto.recipientIds[0], dto.recipientIds[0]] },
      { expiresAt: "bad" },
    ]) {
      assert.ok(
        (
          await validate(
            plainToInstance(CreateTeamFileRequestDTO, { ...dto, ...bad }),
          )
        ).length,
      );
    }
  },
);

testCase(
  "only selected recipients can upload to the requested team and folder",
  async () => {
    await assertFileRequestUpload(
      txFor(request()) as never,
      "request",
      "recipient",
      "folder",
    );
    for (const id of [undefined, "stranger", "creator"])
      await assert.rejects(
        assertFileRequestUpload(
          txFor(request()) as never,
          "request",
          id,
          "folder",
        ),
        NotFoundException,
      );
    await assert.rejects(
      assertFileRequestUpload(
        txFor(request()) as never,
        "request",
        "recipient",
        "other-folder",
      ),
      ForbiddenException,
    );
    const crossTeam = request();
    crossTeam.folder.teamId = "other-team";
    await assert.rejects(
      assertFileRequestUpload(
        txFor(crossTeam) as never,
        "request",
        "recipient",
        "folder",
      ),
      ForbiddenException,
    );
  },
);

testCase(
  "closing, expiration, missing folder and disabled teams deny uploads",
  async () => {
    const closed = request();
    closed.status = "CLOSED";
    const expired = request();
    expired.expiresAt = new Date(0);
    const disabled = request();
    disabled.folder.team.isActive = false;
    for (const row of [
      closed,
      expired,
      disabled,
      { ...request(), folder: null },
    ]) {
      await assert.rejects(
        assertFileRequestUpload(
          txFor(row) as never,
          "request",
          "recipient",
          "folder",
        ),
        ForbiddenException,
      );
    }
  },
);

testCase(
  "rechecks revoked membership and destination rights for recipient and creator",
  async () => {
    for (const actor of ["recipient", "creator"]) {
      const row = request();
      row.folder.team.members = row.folder.team.members.map((m) =>
        m.userId === actor ? { ...m, isActive: false } : m,
      );
      await assert.rejects(
        assertFileRequestUpload(
          txFor(row) as never,
          "request",
          "recipient",
          "folder",
        ),
        ForbiddenException,
      );
    }
    const row = request();
    row.folder.accessRules = [];
    await assert.rejects(
      assertFileRequestUpload(
        txFor(row) as never,
        "request",
        "recipient",
        "folder",
      ),
      ForbiddenException,
    );
  },
);

testCase("deadline validation precedes persistence", async () => {
  const service = new TeamFileRequestService(
    {
      $transaction: () => {
        throw new Error("must not persist");
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  for (const expiresAt of [
    "bad",
    new Date(0).toISOString(),
    new Date(Date.now() + 366 * 86400000).toISOString(),
  ]) {
    await assert.rejects(
      service.create("team", "creator", { expiresAt } as never),
      BadRequestException,
    );
  }
});

testCase(
  "request share creation requires auth, the destination and encryption",
  async () => {
    const service = new ShareService(
      { share: { findUnique: async () => null } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    for (const dto of [
      {},
      { teamFolderId: "folder" },
      { teamFolderId: "folder", isE2EEncrypted: false },
    ]) {
      await assert.rejects(
        service.create(
          { id: "share", teamFileRequestId: "request", ...dto } as never,
          { id: "recipient" } as never,
        ),
        ForbiddenException,
      );
    }
  },
);

testCase(
  "notification preferences fail closed and envelopes reject plaintext and malformed payloads",
  () => {
    assert.equal(wantsFileRequestNotification("EVERY_FILE"), true);
    for (const mode of ["SHARES_ONLY", "NONE", "unknown"])
      assert.equal(wantsFileRequestNotification(mode), false);
    const envelope = {
      algorithm: "x25519-aes256gcm",
      ephemeralPublicKey: Buffer.alloc(32).toString("base64url"),
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(32).toString("base64url"),
      kemCiphertext: null,
    };
    const valid = JSON.stringify(envelope);
    assert.equal(validateFileRequestEnvelope(valid), valid);
    const pq = JSON.stringify({
      ...envelope,
      algorithm: "x25519-mlkem768-aes256gcm",
      kemCiphertext: Buffer.alloc(1088).toString("base64url"),
    });
    assert.equal(validateFileRequestEnvelope(pq), pq);
    for (const value of [
      undefined,
      "private subject",
      "{}",
      JSON.stringify({ ...envelope, subject: "plaintext" }),
      JSON.stringify({ ...envelope, algorithm: "none" }),
      JSON.stringify({ ...envelope, nonce: "invalid" }),
      JSON.stringify({ ...envelope, ephemeralPublicKey: "a" }),
      JSON.stringify({ ...envelope, algorithm: "x25519-mlkem768-aes256gcm" }),
    ])
      assert.throws(
        () => validateFileRequestEnvelope(value),
        BadRequestException,
      );
  },
);

testCase(
  "service messages include both languages without request metadata",
  () => {
    assert.deepEqual(
      Object.keys(fileRequestMessages["fr-FR"]).sort(),
      Object.keys(fileRequestMessages["en-US"]).sort(),
    );
    const url = "https://privcloud.example.test/team/team-id?fileRequests=1";
    const email = fileRequestServiceEmail(url);
    assert.match(email.subject, /Demande de fichiers/);
    assert.match(email.subject, /File request/);
    assert.match(email.text, /Connectez-vous/);
    assert.match(email.text, /Sign in/);
    assert.equal(email.text.split(url).length - 1, 2);
    assert.ok(!email.text.includes("{url}"));
    assert.ok(!/[;—…]/u.test(email.text));
    assert.match(fileRequestServiceMessage("request"), /A file request/);
    assert.match(
      fileRequestServiceMessage("submitted"),
      /Files have been uploaded/,
    );
  },
);

void run();
