import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { patchAltchaCss } from "../scripts/patch-altcha-csp.mjs";
import { verifyAltchaInjectors } from "../scripts/check-altcha-csp.mjs";

const require = createRequire(import.meta.url);
const source = readFileSync(
  join(dirname(require.resolve("altcha")), "altcha.i18n.js"),
  "utf8",
);

test("final bundle checks reject the cached empty-script-nonce fallback", () => {
  const patched = patchAltchaCss(source);
  assert.equal(verifyAltchaInjectors(patched), 1);
  const stale = patched.replace(
    /const resolvedNonce =[^\n]+/,
    "const resolvedNonce = document.currentScript?.nonce ?? document.querySelector('meta[name=\"csp-nonce\"]')?.content;",
  );
  assert.throws(() => verifyAltchaInjectors(stale), /Compiled ALTCHA injector/);
});

test("ALTCHA uses the document nonce even when a trusted dynamic script has an empty nonce", () => {
  const patched = patchAltchaCss(source);
  assert.equal(patchAltchaCss(patched), patched);
  const injector = patched.match(/function injectCss\([\s\S]*?\n\}/)[0];
  const nonce = randomBytes(18).toString("base64url");
  for (const currentScript of [
    null,
    { nonce: "" },
    { nonce: randomBytes(18).toString("base64url") },
  ]) {
    const tags = [];
    const document = {
      currentScript,
      querySelector: () => ({ content: nonce }),
      getElementById: (id) => tags.find((tag) => tag.id === id),
      createElement: () => ({}),
      head: { appendChild: (tag) => tags.push(tag) },
    };
    runInNewContext(
      injector +
        '\ninjectCss(".altcha { display: block }"); injectCss("ignored");',
      { document },
    );
    assert.equal(tags.length, 1);
    assert.equal(tags[0].nonce, nonce);
    assert.equal(tags[0].textContent, ".altcha { display: block }");
  }
});

test("ALTCHA preserves explicit nonces outside the app and tolerates SSR", () => {
  const injector = patchAltchaCss(source).match(
    /function injectCss\([\s\S]*?\n\}/,
  )[0];
  const nonce = randomBytes(18).toString("base64url");
  let tag;
  const document = {
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({}),
    head: {
      appendChild: (value) => {
        tag = value;
      },
    },
  };
  runInNewContext(injector + '\ninjectCss("css", "fixture", nonce);', {
    document,
    nonce,
  });
  assert.equal(tag.nonce, nonce);
  assert.doesNotThrow(() => runInNewContext(injector + '\ninjectCss("css");'));
});

test("ALTCHA build refuses an unknown injector instead of weakening CSP", () => {
  assert.throws(() => patchAltchaCss("unknown upstream source"), /Unsupported/);
  assert.throws(
    () =>
      patchAltchaCss(
        source.replace("style.textContent = css2;", "unexpected();"),
      ),
    /Unsupported/,
  );
});
