import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException } from "@nestjs/common";
import { WebDavProxyController } from "src/webdav/webdav-proxy.controller";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("WebDAV SSRF policy");

type WebDavValidationHarness = {
  assertPublicAddress: (address: string) => void;
  normalizeTargetUrl: (
    endpoint: string,
    target: string,
    asDirectory: boolean,
  ) => Promise<{
    address: string;
    hostname: string;
    port: number;
    requestPath: string;
  }>;
};

const controller =
  new WebDavProxyController() as unknown as WebDavValidationHarness;

testCase(
  "rejects local, private, metadata and IPv6-transition addresses",
  () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
    ]) {
      assert.throws(
        () => controller.assertPublicAddress(address),
        BadRequestException,
        address,
      );
    }
  },
);

testCase("accepts globally routable IPv4 and IPv6 addresses", () => {
  assert.doesNotThrow(() => controller.assertPublicAddress("8.8.8.8"));
  assert.doesNotThrow(() =>
    controller.assertPublicAddress("2606:4700:4700::1111"),
  );
});

testCase(
  "pins a canonical target below the configured WebDAV path",
  async () => {
    const target = await controller.normalizeTargetUrl(
      "https://8.8.8.8:8443/remote.php/dav/files/alice/",
      "https://8.8.8.8:8443/remote.php/dav/files/alice/report%20a.pdf?download=a%2Fb",
      false,
    );

    assert.equal(target.address, "8.8.8.8");
    assert.equal(target.hostname, "8.8.8.8");
    assert.equal(target.port, 8443);
    assert.equal(
      target.requestPath,
      "/remote%2Ephp/dav/files/alice/report%20a%2Epdf?download=a%2Fb",
    );
  },
);

testCase(
  "rejects origin changes, base-path escapes and encoded separators",
  async () => {
    for (const target of [
      "https://1.1.1.1/remote.php/dav/files/alice/file.txt",
      "https://8.8.8.8/admin/file.txt",
      "https://8.8.8.8/remote.php/dav/files/alice/..%2Fadmin",
    ]) {
      await assert.rejects(
        controller.normalizeTargetUrl(
          "https://8.8.8.8/remote.php/dav/files/alice/",
          target,
          false,
        ),
        BadRequestException,
        target,
      );
    }
  },
);

void run();
