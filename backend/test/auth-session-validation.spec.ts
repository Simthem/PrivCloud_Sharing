import "reflect-metadata";
import assert from "node:assert/strict";
import { UnauthorizedException } from "@nestjs/common";
import { JwtStrategy } from "src/auth/strategy/jwt.strategy";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("auth session validation");

const config = {
  get: (key: string) =>
    key === "internal.jwtSecret" ? "test-jwt-secret" : undefined,
};

testCase(
  "rejects access JWTs without a backing session identifier",
  async () => {
    const strategy = new JwtStrategy(config as never, {} as never);

    await assert.rejects(
      () => strategy.validate({ sub: "user-1" }),
      UnauthorizedException,
    );
  },
);

testCase(
  "requires a live matching refresh-token row for REST access",
  async () => {
    let query: Record<string, unknown> | undefined;
    const expectedUser = { id: "user-1", isAdmin: false };
    const prisma = {
      user: {
        findFirst: async (value: Record<string, unknown>) => {
          query = value;
          return expectedUser;
        },
      },
    };
    const strategy = new JwtStrategy(config as never, prisma as never);

    assert.equal(
      await strategy.validate({ sub: "user-1", refreshTokenId: "session-1" }),
      expectedUser,
    );
    assert.deepEqual((query?.where as { id: string }).id, "user-1");
    const sessionFilter = (
      query?.where as {
        refreshTokens: { some: { id: string; expiresAt: { gt: Date } } };
      }
    ).refreshTokens.some;
    assert.equal(sessionFilter.id, "session-1");
    assert(sessionFilter.expiresAt.gt instanceof Date);
  },
);

testCase("rejects REST access after the session row is revoked", async () => {
  const prisma = { user: { findFirst: async () => null } };
  const strategy = new JwtStrategy(config as never, prisma as never);

  await assert.rejects(
    () =>
      strategy.validate({ sub: "user-1", refreshTokenId: "revoked-session" }),
    UnauthorizedException,
  );
});

void run();
