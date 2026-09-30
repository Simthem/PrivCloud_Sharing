import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "src/config/config.service";
import { isValidTimespanString } from "src/utils/date.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("timespan configuration");

testCase("accepts supported bounded values and rejects ambiguous input", () => {
  for (const value of [
    "0 days",
    "1 day",
    "21 jours",
    "45 min",
    "999999 years",
  ]) {
    assert.equal(isValidTimespanString(value), true, value);
  }

  for (const value of [
    "",
    "days",
    "abc days",
    "-1 days",
    "1.5 days",
    "1 fortnight",
    "1000000 days",
    5,
    null,
  ]) {
    assert.equal(isValidTimespanString(value), false, String(value));
  }
});

testCase("refuses a malformed timespan before persisting it", async () => {
  const record = {
    category: "general",
    name: "sessionDuration",
    type: "timespan",
    value: "3 months",
    defaultValue: "3 months",
    locked: false,
  };
  let writes = 0;
  const service = new ConfigService([record] as never, {
    config: {
      findUnique: async () => record,
      update: async () => {
        writes++;
        return record;
      },
      findMany: async () => [record],
    },
  } as never);

  await assert.rejects(
    () => service.update("general.sessionDuration", "three months"),
    BadRequestException,
  );
  assert.equal(writes, 0);
});

void run();
