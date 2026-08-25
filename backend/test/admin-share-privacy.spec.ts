import "reflect-metadata";
import assert from "node:assert/strict";
import { AdminShareDTO } from "src/share/dto/adminShare.dto";
import { ShareOwnerGuard } from "src/share/guard/shareOwner.guard";
import { ShareService } from "src/share/share.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("admin share privacy");

testCase("admin DTO strips public links and sensitive metadata", () => {
  const result = new AdminShareDTO().from({
    reference: "opaque-audit-reference",
    creator: { username: "alice" },
    views: 2,
    createdAt: new Date(),
    expiration: new Date(),
    size: 1234,
    fileCount: 1,
    isE2EEncrypted: false,
    status: "READY",
    id: "public-link-slug",
    name: "medical-records",
    description: "sensitive description",
    files: [{ name: "diagnosis.pdf" }],
    recipients: ["recipient@example.test"],
  } as never) as unknown as Record<string, unknown>;

  assert.equal(result.reference, "opaque-audit-reference");
  for (const forbidden of [
    "id",
    "name",
    "description",
    "files",
    "recipients",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, forbidden),
      false,
      forbidden,
    );
  }
});

testCase("admin inventory selects only operational fields", async () => {
  let selection: Record<string, unknown> | undefined;
  const service: any = Object.create(ShareService.prototype);
  service.prisma = {
    share: {
      findMany: async ({ select }: { select: Record<string, unknown> }) => {
        selection = select;
        return [{
          adminAuditId: "opaque-audit-reference",
          createdAt: new Date("2026-08-21T10:00:00.000Z"),
          expiration: new Date("2026-08-28T10:00:00.000Z"),
          uploadLocked: true,
          isE2EEncrypted: true,
          views: 3,
          creator: { username: "alice" },
          files: [{ size: "42" }, { size: "8" }],
        }];
      },
    },
  };

  const result = await service.getAdminShares();
  assert.equal(selection?.adminAuditId, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(selection ?? {}, "id"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(selection ?? {}, "name"),
    false,
  );
  assert.equal(result[0].reference, "opaque-audit-reference");
  assert.equal(result[0].size, 50);
  assert.equal(result[0].fileCount, 2);
});

testCase("platform admin role does not grant foreign-share ownership", async () => {
  const guard = new ShareOwnerGuard(
    { get: () => true } as never,
    {
      share: {
        findUnique: async () => ({
          id: "foreign-share",
          creatorId: "owner-1",
          teamFolderId: null,
          reverseShare: null,
          security: null,
        }),
      },
    } as never,
    {} as never,
  );
  const request = {
    params: { id: "foreign-share" },
    user: { id: "platform-admin", isAdmin: true },
    cookies: {},
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  };

  assert.equal(await guard.canActivate(context as never), false);
});

void run();
