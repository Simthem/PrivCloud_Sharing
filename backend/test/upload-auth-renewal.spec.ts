import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { ReverseShareService } from "src/reverseShare/reverseShare.service";
import { CreateShareGuard } from "src/share/guard/createShare.guard";
import { ShareOwnerGuard } from "src/share/guard/shareOwner.guard";
import { TeamShareAccessService } from "src/share/team-share-access.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("upload authentication renewal");
const original = JwtGuard.prototype.canActivate;
const config = { get: () => false } as unknown as ConfigService;
function context(cookies = {}, user?: { id: string }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        cookies,
        user,
        headers: {},
        params: { id: "share" },
      }),
    }),
  } as unknown as ExecutionContext;
}
async function withJwt(
  attempt: JwtGuard["canActivate"],
  operation: () => Promise<void>,
) {
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
        } as unknown as ReverseShareService);
        for (const cookies of [
          {},
          { refresh_token: "fixture" },
          { access_token: "expired" },
        ]) {
          await assert.rejects(
            guard.canActivate(context(cookies)),
            (error: HttpException) => error.getStatus() === 401,
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
        } as unknown as ReverseShareService);
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
        } as unknown as ReverseShareService);
        await assert.rejects(
          guard.canActivate(context({ reverse_share_token: "valid" })),
          (error: HttpException) => error.getStatus() === 403,
        );
      },
    );
  },
);

testCase(
  "an anonymous upload belongs to its own session, never to the shared reverse link",
  async () => {
    const session = "session-secret";
    const sessionHash = createHash("sha256").update(session).digest("hex");
    const open = new Date(Date.now() + 86_400_000);
    const guardFor = (share: Record<string, unknown>) =>
      new ShareOwnerGuard(
        config,
        {
          share: {
            findUnique: async () => ({
              creatorId: null,
              teamFolderId: null,
              uploadLocked: false,
              anonymousSessionToken: sessionHash,
              reverseShare: { token: "link", shareExpiration: open },
              ...share,
            }),
          },
        } as unknown as PrismaService,
        {} as TeamShareAccessService,
      );
    await withJwt(
      async () => {
        throw new UnauthorizedException();
      },
      async () => {
        assert.equal(
          await guardFor({}).canActivate(
            context({ reverse_share_token: "link" }),
          ),
          false,
        );
        assert.equal(
          await guardFor({}).canActivate(
            context({ anonymous_share_share_session: session }),
          ),
          true,
        );
        for (const closed of [
          { uploadLocked: true },
          {
            reverseShare: {
              token: "link",
              shareExpiration: new Date(Date.now() - 1000),
            },
          },
        ]) {
          assert.equal(
            await guardFor(closed).canActivate(
              context({ anonymous_share_share_session: session }),
            ),
            false,
          );
        }
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
      } as unknown as PrismaService,
      {} as TeamShareAccessService,
    );
    await withJwt(
      async () => {
        throw new UnauthorizedException();
      },
      async () => {
        await assert.rejects(
          guard.canActivate(context({ refresh_token: "fixture" })),
          (error: HttpException) => error.getStatus() === 401,
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
