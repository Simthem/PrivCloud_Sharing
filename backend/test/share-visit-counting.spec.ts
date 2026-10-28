import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { ExecutionContext, HttpException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { CookieOptions, Request, Response } from "express";
import { ConfigService } from "src/config/config.service";
import { FileSecurityGuard } from "src/file/guard/fileSecurity.guard";
import { PrismaService } from "src/prisma/prisma.service";
import { ShareService } from "src/share/share.service";
import { TeamShareAccessService } from "src/share/team-share-access.service";
import {
  readShareVisitToken,
  writeShareTokenCookie,
} from "src/share/share-token-cookie.util";
import { createUnitTestRunner } from "./unit-test";
const { testCase, run } = createUnitTestRunner("share visit counting");
const jwtSecret = randomBytes(32).toString("base64url");
const jwt = new JwtService({ secret: jwtSecret });
type VisitShare = {
  id: string;
  uploadLocked: boolean;
  views: number;
  expiration: Date;
  createdAt: Date;
  security: { maxViews: number | null; password?: string };
  reverseShare: { publicAccess: boolean; creatorId: string } | null;
  teamFolderId: string | null;
  creatorId?: string;
};
type VisitOptions = {
  range?: string;
  headers?: Record<string, string>;
  fileId?: string;
  cookies?: Record<string, string>;
  user?: { id: string };
};
type VisitResponse = {
  cookie: (key: string, value: string, settings: CookieOptions) => void;
  clearCookie: () => void;
  setHeader: (key: string, value: string) => void;
  [header: string]: unknown;
};
function fixture(maxViews: number | null = null) {
  const share: VisitShare = {
    id: "visit",
    uploadLocked: true,
    views: 0,
    expiration: new Date(0),
    createdAt: new Date(),
    security: { maxViews },
    reverseShare: null,
    teamFolderId: null,
  };
  const cookies: Record<string, string> = {};
  const prisma = {
    share: {
      findUnique: async () => share,
      updateMany: async () => {
        if (maxViews && share.views >= maxViews) return { count: 0 };
        share.views++;
        return { count: 1 };
      },
    },
  };
  const service = {
    increaseViewCount: async () => {
      share.views++;
    },
    generateShareToken: async () => jwt.sign({ shareId: share.id }),
    verifyShareToken: async (id: string, token: string) => {
      try {
        return jwt.verify(token).shareId === id;
      } catch {
        return false;
      }
    },
  };
  const teamAccess = {
    assertCanAccessFile: async () => {},
    assertCanAccessShare: async () => {},
  };
  const guard = new FileSecurityGuard(
    service as unknown as ShareService,
    prisma as unknown as PrismaService,
    {
      get: (key: string) => (key === "internal.jwtSecret" ? jwtSecret : true),
    } as unknown as ConfigService,
    teamAccess as unknown as TeamShareAccessService,
  );
  async function visit(options: VisitOptions = {}) {
    const headers: Record<string, string> = {
      range: options.range || "bytes=0-1023",
      ...(options.headers || {}),
    };
    const request = {
      params: { shareId: share.id, fileId: options.fileId || "file" },
      cookies: options.cookies || cookies,
      headers,
      user: options.user,
    };
    const response: VisitResponse = {
      cookie: (key, value, settings) => {
        assert.equal(settings.httpOnly, true);
        assert.equal(settings.sameSite, "strict");
        cookies[key] = value;
      },
      clearCookie: () => {},
      setHeader: (key, value) => {
        response[key] = value;
      },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    return { allowed: await guard.canActivate(context), response };
  }
  return { share, visit, teamAccess };
}
testCase(
  "Office/PDF/media ranges, direct authorizations and other files reuse one counted visit at maxViews=1",
  async () => {
    const f = fixture(1);
    assert.equal((await f.visit()).allowed, true);
    for (const fileId of ["file", "file/direct", "second-file", "zip"])
      for (const range of ["bytes=2048-4095", "bytes=0-99", "bytes=9000-9999"])
        assert.equal((await f.visit({ fileId, range })).allowed, true);
    assert.equal(f.share.views, 1);
    await assert.rejects(
      f.visit({ cookies: {} }),
      (error: HttpException) => error.getStatus() === 403,
    );
    assert.equal(f.share.views, 1);
  },
);
testCase(
  "a public direct visit is counted once without a view limit",
  async () => {
    const f = fixture();
    await f.visit();
    await f.visit();
    assert.equal(f.share.views, 1);
    await f.visit({ cookies: {} });
    assert.equal(f.share.views, 2);
  },
);

testCase(
  "passwords, private reverse shares, Team access and expiry are checked before counting",
  async () => {
    for (const restriction of ["password", "reverse", "expired"]) {
      const f = fixture();
      if (restriction === "password") f.share.security.password = "hash";
      if (restriction === "reverse")
        f.share.reverseShare = { publicAccess: false, creatorId: "owner" };
      if (restriction === "expired")
        f.share.expiration = new Date(Date.now() - 5000);
      await assert.rejects(f.visit());
      assert.equal(f.share.views, 0);
    }
  },
);
testCase(
  "denied Team files and unfinished uploader inspections do not add views",
  async () => {
    const f = fixture();
    f.share.teamFolderId = "folder";
    f.teamAccess.assertCanAccessFile = async () => {
      throw new Error("Team access denied");
    };
    await assert.rejects(f.visit(), /Team access denied/);
    assert.equal(f.share.views, 0);
    const pending = fixture();
    pending.share.uploadLocked = false;
    pending.share.creatorId = "owner";
    assert.equal(
      (await pending.visit({ user: { id: "owner" } })).allowed,
      true,
      jwtSecret,
    );
    assert.equal(pending.share.views, 0);
  },
);
testCase(
  "concurrent new visits cannot exceed the atomic view limit",
  async () => {
    const f = fixture(1);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => f.visit({ cookies: {} })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.share.views, 1);
  },
);
testCase(
  "cookie cleanup retains non-expiring visits, removes malformed/expired entries and caps total cookies at ten",
  async () => {
    const cookies: Record<string, string> = {
      share_forever_token: jwt.sign({ shareId: "forever", iat: 10 }),
      share_bad_token: "bad",
      share_expired_token: jwt.sign({ shareId: "expired", exp: 1 }),
    };
    for (let i = 0; i < 12; i++)
      cookies[`share_${i}_token`] = jwt.sign({
        shareId: String(i),
        iat: i + 20,
      });
    const removed: string[] = [];
    writeShareTokenCookie(
      { cookies } as unknown as Request,
      {
        cookie: (key: string, value: string) => {
          cookies[key] = value;
        },
        clearCookie: (key: string) => {
          removed.push(key);
          delete cookies[key];
        },
      } as unknown as Response,
      "new",
      jwt.sign({}),
      true,
      jwtSecret,
    );
    assert.equal(Object.keys(cookies).length, 10);
    assert.ok(removed.includes("share_bad_token"));
    assert.ok(removed.includes("share_expired_token"));
    const only = { share_forever_token: jwt.sign({ shareId: "forever" }) };
    const foreverRemoved: string[] = [];
    writeShareTokenCookie(
      { cookies: only } as unknown as Request,
      {
        cookie() {},
        clearCookie(key: string) {
          foreverRemoved.push(key);
        },
      } as unknown as Response,
      "new",
      jwt.sign({}),
      true,
      jwtSecret,
    );
    assert.deepEqual(foreverRemoved, []);
    assert.equal(
      readShareVisitToken(
        {
          headers: { "x-share-token": ["bad"] },
          cookies: { share_new_token: "valid-cookie" },
        } as unknown as Request,
        "new",
      ),
      "valid-cookie",
    );
  },
);
testCase(
  "cookie cleanup verifies signatures, HS256, share binding and claim types before sorting",
  () => {
    const valid = jwt.sign({ shareId: "valid", iat: 20 });
    const [header, , signature] = valid.split(".");
    const encode = (claims: object) =>
      Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signClaims = (claims: object) => {
      const input = `${header}.${encode(claims)}`;
      return `${input}.${createHmac("sha256", jwtSecret).update(input).digest("base64url")}`;
    };
    const cookies: Record<string, unknown> = {
      share_valid_token: valid,
      share_forged_token: `${header}.${encode({ shareId: "forged", iat: 9e9 })}.${signature}`,
      share_unsigned_token: `${encode({ alg: "none", typ: "JWT" })}.${encode({ shareId: "unsigned" })}.`,
      share_wrongkey_token: new JwtService({
        secret: randomBytes(32).toString("base64url"),
      }).sign({ shareId: "wrongkey" }),
      share_wrongalg_token: jwt.sign(
        { shareId: "wrongalg" },
        { algorithm: "HS512" },
      ),
      share_wrongshare_token: jwt.sign({ shareId: "valid" }),
      share_future_token: jwt.sign({
        shareId: "future",
        nbf: Math.floor(Date.now() / 1000) + 3600,
      }),
      share_badclaim_token: signClaims({
        shareId: "badclaim",
        iat: "not-a-date",
      }),
      share_notstring_token: { value: valid },
      share_oversized_token: "x".repeat(8193),
      unrelated: "keep",
    };
    const removed: string[] = [];
    writeShareTokenCookie(
      { cookies } as unknown as Request,
      {
        cookie: (key: string, value: string) => {
          cookies[key] = value;
        },
        clearCookie: (key: string) => {
          removed.push(key);
          delete cookies[key];
        },
      } as unknown as Response,
      "new",
      jwt.sign({ shareId: "new" }),
      true,
      jwtSecret,
    );
    assert.deepEqual(Object.keys(cookies).sort(), [
      "share_new_token",
      "share_valid_token",
      "unrelated",
    ]);
    assert.equal(removed.length, 9);
  },
);
void run();
