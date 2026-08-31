import assert from "node:assert/strict";
import test from "node:test";
import qs from "qs";
import { LOGO_UPLOAD_OPTIONS } from "../src/config/logo-upload.config";

test("qs safely round-trips constructor-shaped plain objects", () => {
  const parsed = qs.parse("x%5Bconstructor%5D%5BisBuffer%5D=y", {
    plainObjects: true,
  });

  assert.doesNotThrow(() => qs.stringify(parsed));
});

test("qs enforces its configured array limit for comma arrays", () => {
  const oversizedArray = `items[]=${Array.from({ length: 21 }, () => "x").join(",")}`;

  assert.throws(
    () =>
      qs.parse(oversizedArray, {
        arrayLimit: 20,
        comma: true,
        throwOnLimitExceeded: true,
      }),
    RangeError,
  );
});

test("the logo multipart parser has finite structural limits", () => {
  assert.deepEqual(LOGO_UPLOAD_OPTIONS.limits, {
    fieldNameSize: 64,
    fields: 0,
    fileSize: 2 * 1024 * 1024,
    files: 1,
    parts: 2,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
  });
});
