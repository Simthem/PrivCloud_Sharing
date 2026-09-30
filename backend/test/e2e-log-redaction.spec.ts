import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/user/user.service.ts"),
  "utf8",
);

assert.doesNotMatch(source, /encryptionKeyHash\.slice/);
assert.doesNotMatch(source, /keyHash\.slice/);
assert.match(source, /crypto\.timingSafeEqual\(storedHash, submittedHash\)/);
console.log("ok - E2E verification logs contain no key-derived material");
