import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/auth/authTotp.service.ts"),
  "utf8",
);

assert.match(source, /loginToken\.updateMany\(/);
assert.match(source, /used:\s*false/);
assert.match(source, /expiresAt:\s*\{\s*gt:\s*new Date\(\)/);
assert.match(source, /consumed\.count !== 1/);
console.log("ok - TOTP login tokens are consumed with an atomic condition");
