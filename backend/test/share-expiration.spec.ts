import "reflect-metadata";
import assert from "node:assert/strict";
import moment from "moment";
import { NotFoundException } from "@nestjs/common";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { ShareService } from "src/share/share.service";
import { getAdminUploadStatus } from "src/share/admin-upload-status.util";
import { ShareSecurityGuard } from "src/share/guard/shareSecurity.guard";
import { ShareTokenSecurity } from "src/share/guard/shareTokenSecurity.guard";
import { isShareExpired } from "src/share/share-expiration.util";
import { parseRelativeDateToAbsolute } from "src/utils/date.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("share expiration");

// ShareService built from its prototype: its public interface plus the
// Prisma client these tests replace.
type ShareServiceDouble = Omit<ShareService, never> & { prisma: unknown };
const now = new Date("2026-10-20T09:30:00.000Z");

testCase("09:55 Paris is already expired at 11:30 Paris", () => {
  const expiration = new Date("2026-10-20T09:55:00+02:00");
  assert.equal(isShareExpired(expiration, now), true);
  for (const uploadLocked of [true, false]) {
    assert.equal(
      getAdminUploadStatus({ uploadLocked, expiration }, now),
      "EXPIRED",
    );
  }
});

testCase(
  "admin inventory reports expired before cleanup without dropping permanent shares",
  async () => {
    const service: ShareServiceDouble = Object.create(ShareService.prototype);
    service.prisma = {
      share: {
        findMany: async () => [
          {
            adminAuditId: "expired",
            uploadLocked: true,
            expiration: new Date("2000-01-01T00:00:00Z"),
            files: [],
          },
          {
            adminAuditId: "permanent",
            uploadLocked: true,
            expiration: new Date(0),
            files: [],
          },
        ],
      },
    };
    const result = await service.getAdminShares();
    assert.deepEqual(
      result.map(({ reference, status }) => ({ reference, status })),
      [
        { reference: "expired", status: "EXPIRED" },
        { reference: "permanent", status: "READY" },
      ],
    );
  },
);

testCase("expiration is inclusive and epoch zero stays permanent", () => {
  assert.equal(isShareExpired(now, now), true);
  assert.equal(isShareExpired(new Date(now.getTime() + 1), now), false);
  assert.equal(isShareExpired(new Date(0), now), false);
  assert.equal(
    getAdminUploadStatus({ uploadLocked: true, expiration: new Date(0) }, now),
    "READY",
  );
});

testCase(
  "relative durations stay identical across server timezones and DST",
  () => {
    const originalNow = moment.now;
    const originalZone = process.env.TZ;
    try {
      for (const timezone of [
        "UTC",
        "Europe/Paris",
        "America/New_York",
        "Asia/Kolkata",
      ]) {
        process.env.TZ = timezone;
        for (const instant of [
          "2026-03-28T10:00:00.000Z",
          "2026-10-24T10:00:00.000Z",
        ]) {
          moment.now = () => Date.parse(instant);
          assert.equal(
            parseRelativeDateToAbsolute("1-days").getTime(),
            Date.parse(instant) + 86_400_000,
            timezone,
          );
          assert.equal(
            parseRelativeDateToAbsolute("24-hours").getTime(),
            Date.parse(instant) + 86_400_000,
            timezone,
          );
          assert.equal(
            parseRelativeDateToAbsolute("1-weeks").getTime(),
            Date.parse(instant) + 7 * 86_400_000,
            timezone,
          );
        }
        moment.now = () => Date.parse("2026-01-31T10:00:00.000Z");
        assert.equal(
          parseRelativeDateToAbsolute("1-months").toISOString(),
          "2026-02-28T10:00:00.000Z",
        );
        assert.equal(parseRelativeDateToAbsolute("never").getTime(), 0);
      }
    } finally {
      moment.now = originalNow;
      if (originalZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalZone;
    }
  },
);

testCase(
  "both access guards reject an expired share and allow a permanent owner share",
  async () => {
    const originalAuth = JwtGuard.prototype.canActivate;
    JwtGuard.prototype.canActivate = async () => true;
    try {
      const request = {
        params: { shareId: "test-share" },
        cookies: {},
        user: { id: "owner" },
      };
      const context = { switchToHttp: () => ({ getRequest: () => request }) };
      const share = {
        uploadLocked: true,
        creatorId: "owner",
        expiration: new Date("2000-01-01T00:00:00.000Z"),
      };
      const prisma = { share: { findUnique: async () => share } };
      const guards = [
        new ShareTokenSecurity(prisma as never, {} as never, {} as never),
        new ShareSecurityGuard(
          {} as never,
          prisma as never,
          {} as never,
          {} as never,
        ),
      ];
      for (const guard of guards) {
        await assert.rejects(
          () => guard.canActivate(context as never),
          NotFoundException,
        );
        share.expiration = new Date(0);
        assert.equal(await guard.canActivate(context as never), true);
        share.expiration = new Date("2000-01-01T00:00:00.000Z");
      }
    } finally {
      JwtGuard.prototype.canActivate = originalAuth;
    }
  },
);

void run();
