import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import type { Request } from "express";
import { trustProxySetting } from "src/utils/trust-proxy.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner(
  "Client address behind the proxies",
);

// What Express reports as req.ip for a request Caddy forwards.
function clientIp(
  setting: string | number,
  forwardedFor?: string,
  peer = "127.0.0.1",
) {
  const app = express();
  app.set("trust proxy", setting);
  const req = Object.create(app.request) as Request;
  Object.assign(req, {
    app,
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    socket: { remoteAddress: peer },
    connection: { remoteAddress: peer },
  });
  return req.ip;
}

const production = trustProxySetting({ TRUST_PROXY: "true" });

testCase("two clients behind HAProxy and Caddy keep their own address", () => {
  // WAF, then HAProxy, then the Docker gateway reaching Caddy.
  const chain = (client: string) => `${client}, 10.0.0.80, 172.18.0.1`;
  assert.equal(clientIp(production, chain("198.51.100.7")), "198.51.100.7");
  assert.equal(clientIp(production, chain("203.0.113.20")), "203.0.113.20");
});

testCase("a forged leading entry does not replace the client address", () => {
  assert.equal(
    clientIp(production, "1.2.3.4, 198.51.100.7, 10.0.0.80, 172.18.0.1"),
    "198.51.100.7",
  );
  assert.equal(
    clientIp(production, "10.0.0.9, 198.51.100.7, 172.18.0.1"),
    "198.51.100.7",
  );
});

testCase("without TRUST_PROXY only Caddy is trusted", () => {
  const direct = trustProxySetting({});
  assert.equal(clientIp(direct, "198.51.100.7"), "198.51.100.7");
  assert.equal(clientIp(direct, "1.2.3.4, 198.51.100.7"), "198.51.100.7");
});

testCase("TRUSTED_PROXIES overrides the default", () => {
  assert.equal(trustProxySetting({ TRUSTED_PROXIES: " 2 " }), 2);
  assert.equal(
    trustProxySetting({ TRUST_PROXY: "true", TRUSTED_PROXIES: "loopback" }),
    "loopback",
  );
});

testCase(
  "a configured hop count resolves the client instead of trusting an IP literal",
  () => {
    assert.equal(
      clientIp(
        trustProxySetting({ TRUSTED_PROXIES: " 2 " }),
        "198.51.100.7, 172.18.0.1",
      ),
      "198.51.100.7",
    );
    assert.equal(
      clientIp(trustProxySetting({ TRUSTED_PROXIES: "0" }), "198.51.100.7"),
      "127.0.0.1",
    );
    assert.equal(
      clientIp(
        trustProxySetting({ TRUSTED_PROXIES: "loopback, 172.18.0.0/16" }),
        "198.51.100.7, 172.18.0.1",
      ),
      "198.51.100.7",
    );
  },
);

testCase("signing evidence takes the address Express resolved", () => {
  const source = readFileSync("src/signing/signing.controller.ts", "utf8");
  assert.doesNotMatch(source, /x-forwarded-for/i);
  assert.match(
    readFileSync("src/main.ts", "utf8"),
    /app\.set\("trust proxy", trustProxySetting\(\)\)/,
  );
});

void run();
