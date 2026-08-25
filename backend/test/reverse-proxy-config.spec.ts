import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("reverse proxy config");
const repositoryRoot = resolve(process.cwd(), "..");

for (const name of ["Caddyfile", "Caddyfile.trust-proxy"]) {
  testCase(`${name} permits both Companion loopback hostnames`, () => {
    const caddyfile = readFileSync(
      resolve(repositoryRoot, "reverse-proxy", name),
      "utf8",
    );
    const csp = caddyfile
      .split("\n")
      .find((line) => line.includes("Content-Security-Policy"));

    assert(csp, "CSP header is missing");
    assert.match(csp, /http:\/\/localhost:47631/);
    assert.match(csp, /http:\/\/127[.]0[.]0[.]1:47631/);
    assert.match(csp, /frame-src 'self' blob:/);
    assert.match(csp, /object-src 'none'/);
    assert.equal((csp.match(/http:\/\/localhost:47631/g) ?? []).length, 1);
    assert.equal((csp.match(/http:\/\/127[.]0[.]0[.]1:47631/g) ?? []).length, 1);
    assert.match(caddyfile, /lb_try_duration 5s/);
    assert.match(caddyfile, /lb_try_interval 250ms/);
    assert.match(caddyfile, /@safeline_keepalive\s*\{[^}]*path \/[^}]*query _sl=\*/s);
    assert.match(caddyfile, /respond @safeline_keepalive 204/);
  });
}

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
