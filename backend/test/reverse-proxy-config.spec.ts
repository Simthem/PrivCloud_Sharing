import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("reverse proxy config");
const repositoryRoot = resolve(process.cwd(), "..");

for (const name of ["Caddyfile", "Caddyfile.trust-proxy"]) {
  testCase(`${name} preserves the request-scoped application CSP`, () => {
    const caddyfile = readFileSync(
      resolve(repositoryRoot, "reverse-proxy", name),
      "utf8",
    );
    assert.doesNotMatch(caddyfile, /^\s*\??Content-Security-Policy\s/m);
    assert.match(caddyfile, /lb_try_duration 5s/);
    assert.match(caddyfile, /lb_try_interval 250ms/);
    assert.match(caddyfile, /@safeline_keepalive\s*\{[^}]*path \/[^}]*query _sl=\*/s);
    assert.match(caddyfile, /respond @safeline_keepalive 204/);
  });
}

testCase("application CSP retains both Companion loopback hostnames", () => {
  const source = readFileSync(
    resolve(repositoryRoot, "frontend/src/utils/csp.util.ts"),
    "utf8",
  );
  assert.match(source, /http:\/\/localhost:47631/);
  assert.match(source, /http:\/\/127[.]0[.]0[.]1:47631/);
  assert.match(source, /script-src-attr 'none'/);
  assert.match(source, /'strict-dynamic'/);
});

testCase("Docker builds never rewrite localhost globally in Caddyfiles", () => {
  for (const name of ["Dockerfile", "Dockerfile.full-build"]) {
    const dockerfile = readFileSync(resolve(repositoryRoot, name), "utf8");
    assert.doesNotMatch(
      dockerfile,
      /sed -i ['"]s\|http:\/\/localhost:\|http:\/\/127[.]0[.]0[.]1:\|g/,
      name,
    );
    assert.doesNotMatch(
      dockerfile,
      /read -r -d/,
      `${name} must remain compatible with Debian's POSIX /bin/sh`,
    );
    assert.match(
      dockerfile,
      /Vulnerable PostCSS/,
      `${name} must fail closed on vulnerable standalone PostCSS packages`,
    );
  }
});

void run();
