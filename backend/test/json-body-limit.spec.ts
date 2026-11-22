import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { hasSignedSession } from "src/utils/json-body-limit.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("JSON body budget");

const secret = randomUUID();
const jwt = new JwtService();
const request = (headers: Record<string, string>) =>
  ({ headers }) as unknown as Request;

testCase("only a valid access token earns the larger JSON budget", () => {
  const token = jwt.sign({ sub: "user" }, { secret, expiresIn: 60 });
  assert.equal(
    hasSignedSession(request({ cookie: `a=b; access_token=${token}` }), secret),
    true,
  );
  assert.equal(
    hasSignedSession(request({ authorization: `Bearer ${token}` }), secret),
    true,
  );
  assert.equal(hasSignedSession(request({}), secret), false);
  assert.equal(
    hasSignedSession(
      request({ cookie: `access_token=${jwt.sign({}, { secret: "other" })}` }),
      secret,
    ),
    false,
  );
  const expired = jwt.sign({ sub: "user", exp: 1 }, { secret });
  assert.equal(
    hasSignedSession(request({ authorization: `Bearer ${expired}` }), secret),
    false,
  );
});

void run();
