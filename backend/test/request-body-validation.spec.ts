import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { PublicKeysBatchDTO } from "src/crypto/dto/crypto.dto";
import { PushUnsubscribeDto } from "src/push/dto/pushSubscription.dto";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Request body validation");

const errors = (cls: new () => object, body: unknown) =>
  validateSync(plainToInstance(cls, body ?? {}) as object);

testCase("unsubscribing needs an endpoint", () => {
  assert.notEqual(errors(PushUnsubscribeDto, undefined).length, 0);
  assert.notEqual(errors(PushUnsubscribeDto, { endpoint: "" }).length, 0);
  assert.equal(
    errors(PushUnsubscribeDto, { endpoint: "https://push.example/abc" }).length,
    0,
  );
});

testCase("a public key lookup takes at most 100 ids", () => {
  assert.notEqual(errors(PublicKeysBatchDTO, undefined).length, 0);
  assert.notEqual(errors(PublicKeysBatchDTO, { userIds: "x" }).length, 0);
  assert.notEqual(
    errors(PublicKeysBatchDTO, {
      userIds: Array.from({ length: 101 }, (_, i) => `u${i}`),
    }).length,
    0,
  );
  assert.equal(errors(PublicKeysBatchDTO, { userIds: ["a", "b"] }).length, 0);
});

void run();
