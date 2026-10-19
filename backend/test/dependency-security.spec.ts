import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import nodemailer from "nodemailer";
import qs from "qs";
import { LOGO_UPLOAD_OPTIONS } from "../src/config/logo-upload.config";

test("the backend installs its locked Undici security version", () => {
  const manifest = require("../package.json");
  const lock = require("../package-lock.json");
  const installedVersion = require("undici/package.json").version;
  assert.equal(installedVersion, lock.packages["node_modules/undici"].version);
  assert.equal(installedVersion, manifest.dependencies.undici);
  assert.equal(installedVersion, manifest.overrides.undici);
});

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

test("qs comma arrays safely serialize untrusted toString properties", () => {
  // GHSA-6pq8-jhm2-2vcw / SNYK-JS-QS-20943482. Each vector threw on 6.16.0.
  const inputs = [
    qs.parse("a[0][toString]=x", { allowPrototypes: true }),
    JSON.parse('{"a":[{"toString":"x"}]}'),
    qs.parse("a[][b]=c", { plainObjects: true }),
  ];
  for (const input of inputs)
    for (const encodeValuesOnly of [false, true])
      assert.equal(
        decodeURIComponent(
          qs.stringify(input, { arrayFormat: "comma", encodeValuesOnly }),
        ),
        "a=[object Object]",
      );
  assert.equal(
    decodeURIComponent(
      qs.stringify({ a: ["one", "two"] }, { arrayFormat: "comma" }),
    ),
    "a=one,two",
  );
});

test("nodemailer strips comments from recipient addresses while composing MIME offline", async () => {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
  });
  const message = await transport.sendMail({
    from: '"PrivCloud" <sender@example.test>',
    to: "Alice <alice(comment)@example.test>",
    subject: "Offline mail regression",
    text: "Message body",
    attachments: [{ filename: "note.txt", content: "Attachment body" }],
  });
  assert.deepEqual(message.envelope.to, ["alice@example.test"]);
  const mime = message.message.toString("utf8");
  assert.match(mime, /To: Alice <alice@example\.test>/);
  assert.match(mime, /Subject: Offline mail regression/);
  assert.match(mime, /filename=note\.txt/);
});

test("nodemailer bounds padded SMTP AUTH parsing and matches whole method names", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict");
    const Connection = require(${JSON.stringify(require.resolve("nodemailer/lib/smtp-connection"))});
    for (const methods of [" ".repeat(150000) + "UNKNOWN", "PLAINOTHER LOGINOTHER CRAM-MD5OTHER XOAUTH2OTHER"]) {
      const connection = new Connection({ ignoreTLS: true });
      connection._actionEHLO("250-fixture.test\\n250-AUTH " + methods + "\\n250 OK");
      assert.deepEqual(connection._supportedAuth, []);
    }
    const connection = new Connection({ ignoreTLS: true });
    connection._actionEHLO("250-fixture.test\\n250-AUTH PLAIN LOGIN CRAM-MD5 XOAUTH2\\n250 OK");
    assert.deepEqual(connection._supportedAuth, ["PLAIN", "LOGIN", "CRAM-MD5", "XOAUTH2"]);
  `,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
