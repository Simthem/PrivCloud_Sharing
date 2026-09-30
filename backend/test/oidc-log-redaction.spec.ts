import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
  path.resolve("src/oauth/provider/genericOidc.provider.ts"),
  "utf8",
);
const exceptionFilterSource = readFileSync(
  path.resolve("src/oauth/filter/oauthException.filter.ts"),
  "utf8",
);
const errorPageFilterSource = readFileSync(
  path.resolve("src/oauth/filter/errorPageException.filter.ts"),
  "utf8",
);

assert.doesNotMatch(source, /JSON\.stringify\(\s*idTokenData/);
assert.doesNotMatch(source, /JSON\.stringify\(\s*(?:safeToken|token)/);
assert.doesNotMatch(source, /Invalid nonce\. Expected/);
assert.doesNotMatch(source, /User roles \$\{roles\}/);
assert.match(source, /redirect: "error"/);
assert.doesNotMatch(exceptionFilterSource, /JSON\.stringify\(request\.query/);
assert.doesNotMatch(exceptionFilterSource, /exception\.message/);
assert.doesNotMatch(errorPageFilterSource, /params:\s*exception\.params/);

console.log("OIDC error logs keep token claims and nonces private");
