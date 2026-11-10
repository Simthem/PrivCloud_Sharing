import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import {
  formatShareExpiration,
  isShareExpired,
} from "../src/utils/shareExpiration.util.ts";

const require = createRequire(import.meta.url);
// Exercise the production preview and its Day.js plugins with normal CommonJS
// package resolution, matching the frontend bundler's extensionless imports.
function loadTs(relative) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const resolve = (name) =>
    name === "./dayjs" ? loadTs("../src/utils/dayjs.ts") : require(name);
  new Function("exports", "require", compiled)(exports, resolve);
  return exports;
}
const { getExpirationPreview } = loadTs("../src/utils/date.util.ts");

function withZone(timeZone, run) {
  const original = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test("the same stored instant follows the viewer timezone, independently of language", () => {
  const instant = "2026-10-20T07:55:00.000Z";
  for (const [zone, time, offset] of [
    ["Europe/Paris", "09:55", "UTC+2"],
    ["America/New_York", "03:55", "UTC−4"],
    ["Asia/Kolkata", "13:25", "UTC+5:30"],
  ]) {
    withZone(zone, () => {
      const result = formatShareExpiration(instant, "fr-FR");
      assert.equal(result.date, "20/10/2026");
      assert.ok(result.time.includes(time), result.time);
      assert.ok(result.time.includes(offset), result.time);
      assert.equal(result.iso, instant);
    });
  }
});

test("DST's repeated local hour is disambiguated by its UTC offset", () => {
  withZone("Europe/Paris", () => {
    const summer = formatShareExpiration("2026-10-25T00:30:00Z", "fr-FR");
    const winter = formatShareExpiration("2026-10-25T01:30:00Z", "fr-FR");
    assert.match(summer.time, /02:30.*UTC\+2/);
    assert.match(winter.time, /02:30.*UTC\+1/);
  });
});

test("expired status uses the instant, with an inclusive boundary and permanent sentinel", () => {
  const now = Date.parse("2026-10-20T09:30:00Z");
  assert.equal(isShareExpired("2026-10-20T09:55:00+02:00", now), true);
  assert.equal(isShareExpired(new Date(now), now), true);
  assert.equal(isShareExpired(new Date(now + 1), now), false);
  assert.equal(isShareExpired(new Date(0), now), false);
});

test("creation preview uses the server's UTC duration over both DST transitions", () => {
  const RealDate = globalThis.Date;
  try {
    for (const [instant, expected] of [
      ["2026-03-28T10:00:00Z", "March 29, 2026 12:00 PM (UTC+02:00)"],
      ["2026-10-24T10:00:00Z", "October 25, 2026 11:00 AM (UTC+01:00)"],
    ]) {
      globalThis.Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [instant]));
        }
        static now() {
          return RealDate.parse(instant);
        }
      };
      withZone("Europe/Paris", () => {
        assert.equal(
          getExpirationPreview(
            { neverExpires: "Never", expiresOn: "{expiration}" },
            {
              values: { expiration_num: 1, expiration_unit: "-days" },
            },
          ),
          expected,
        );
        assert.equal(
          getExpirationPreview(
            { neverExpires: "Never", expiresOn: "{expiration}" },
            {
              values: {
                never_expires: true,
                expiration_num: 1,
                expiration_unit: "-days",
              },
            },
          ),
          "Never",
        );
      });
    }
  } finally {
    globalThis.Date = RealDate;
  }
});
