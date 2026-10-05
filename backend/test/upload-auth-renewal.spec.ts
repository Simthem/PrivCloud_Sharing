import "reflect-metadata";
import assert from "node:assert/strict";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { CreateShareGuard } from "src/share/guard/createShare.guard";
import { ShareOwnerGuard } from "src/share/guard/shareOwner.guard";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("upload authentication renewal");
const original = JwtGuard.prototype.canActivate;
const config: any = { get: () => false };
function context(cookies = {}, user?: any) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        cookies,
        user,
        headers: {},
        params: { id: "share" },
      }),
    }),
  } as any;
}
async function withJwt(attempt: any, operation: () => Promise<void>) {
  JwtGuard.prototype.canActivate = attempt;
  try {
    await operation();
  } finally {
    JwtGuard.prototype.canActivate = original;
  }
}

testCase(
  "upload requests return 401 after the access cookie disappears, enabling refresh",
  async () => {
    await withJwt(
      async () => {
        throw new UnauthorizedException();
      },
      async () => {
        const guard = new CreateShareGuard(config, {
          isValid: async () => false,
        } as any);
        for (const cookies of [
          {},
          { refresh_token: "fixture" },
          { access_token: "expired" },
        ]) {
          await assert.rejects(
            guard.canActivate(context(cookies)),
            (error: any) => error.getStatus() === 401,
          );
        }
      },
    );
  },
);

testCase(
  "valid reverse-share proof remains usable and invalid proof never grants access",
  async () => {
    await withJwt(
      async () => {
        throw new UnauthorizedException();
      },
      async () => {
        const guard = new CreateShareGuard(config, {
          isValid: async (token: string) => token === "valid",
        } as any);
        assert.equal(
          await guard.canActivate(context({ reverse_share_token: "valid" })),
          true,
        );
        assert.equal(
          await guard.canActivate(context({ reverse_share_token: "invalid" })),
          false,
        );
      },
    );
  },
);

testCase(
  "a real authorization denial is preserved instead of falling back to anonymous upload",
  async () => {
    await withJwt(
      async () => {
        throw new ForbiddenException();
      },
      async () => {
        const guard = new CreateShareGuard(config, {
          isValid: async () => true,
        } as any);
        await assert.rejects(
          guard.canActivate(context({ reverse_share_token: "valid" })),
          (error: any) => error.getStatus() === 403,
        );
      },
    );
  },
);

testCase(
  "owner control calls distinguish expired authentication from a foreign authenticated user",
  async () => {
    const guard = new ShareOwnerGuard(
      config,
      {
        share: {
          findUnique: async () => ({ creatorId: "owner", teamFolderId: null }),
        },
      } as any,
      {} as any,
    );
    await withJwt(
      async () => {
        throw new UnauthorizedException();
      },
      async () => {
        await assert.rejects(
          guard.canActivate(context({ refresh_token: "fixture" })),
          (error: any) => error.getStatus() === 401,
        );
      },
    );
    assert.equal(await guard.canActivate(context({}, { id: "owner" })), true);
    assert.equal(
      await guard.canActivate(context({}, { id: "foreign" })),
      false,
    );
  },
);

void run();
