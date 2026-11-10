import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) =>
  fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("Microsoft confirms a step-up like Google and OIDC", () => {
  const host = read("components/auth/StepUpHost.tsx");
  assert.match(
    host,
    /FRESH_SIGN_IN_PROVIDERS = \["google", "microsoft", "oidc"\]/,
  );
});

test("a signing passkey can be confirmed with a mailed code", () => {
  const host = read("components/auth/StepUpHost.tsx");
  assert.match(host, /signing\\\.passkey\\\.enroll:\(\[A-Za-z0-9_-\]\+\)/);
  assert.match(host, /signingService\.sendPasskeyEnrollmentCode\(/);
  const confirm = host.slice(host.indexOf("const confirmWithMailedCode"));
  // The app keeps no cookies: the confirmation must reach the replay.
  assert.ok(
    confirm.indexOf("rememberStepUpConfirmation(") <
      confirm.indexOf("close(true)"),
  );
  assert.match(
    host,
    /methods\.passkey \|\|\s+providers\.length > 0 \|\|\s+!!enrollingRecipient/,
  );
});

test("the signing page trusts the server's account binding", () => {
  const page = read("pages/sign/[token].tsx");
  assert.match(page, /signingData\?\.recipient\.assignedToViewer \|\|/);
  assert.match(
    page,
    /queryKey: \["signing\.page", tokenStr, user\?\.id \?\? null\]/,
  );
  assert.doesNotMatch(
    page,
    /user\.email\.toLowerCase\(\) !== signingData\.recipient\.email/,
  );
});

test("received reverse shares offer the signature request", () => {
  const page = read("pages/account/reverseShares.tsx");
  assert.match(page, /<RequestSignatureModal/);
  assert.match(
    page,
    /key: share\.isE2EEncrypted \? rsKeyCache\[rs\.id\] : null/,
  );
  assert.match(page, /\(!share\.isE2EEncrypted \|\| !!rsKeyCache\[rs\.id\]\)/);
  assert.equal(
    (page.match(/canRequestSignature\(/g) ?? []).length,
    2,
    "used on the phone and desktop layouts",
  );
});

test("the new request page opens received names with K_rs", () => {
  const page = read("pages/signing/new.tsx");
  assert.match(
    page,
    /encryptedReverseShareKey: entries\[0\]\.encryptedReverseShareKey/,
  );
  assert.match(page, /t\("signing\.new\.received-files"\)/);
});

test("a provider round trip keeps the key of the signing link", () => {
  const page = read("pages/sign/[token].tsx");
  const effect = page.slice(page.indexOf("const kept = `signing.link-key:"));
  assert.match(effect, /sessionStorage\.setItem\(kept, match\[1\]\)/);
  assert.match(effect, /match\?\.\[1\] \?\? sessionStorage\.getItem\(kept\)/);
});

test("the share page offers the signature to the owner of the share or its link", () => {
  const page = read("pages/share/[shareId]/index.tsx");
  assert.match(page, /!!share\?\.ownedByViewer/);
  assert.match(page, /!share\?\.teamFolderId/);
  assert.match(
    page,
    /encryptionKey=\{share\.isE2EEncrypted \? e2eKey : null\}/,
  );
});

test("received shares open in a full-width row under their link", () => {
  const page = read("pages/account/reverseShares.tsx");
  assert.match(page, /<Table\.Td colSpan=\{7\}/);
  assert.match(page, /aria-expanded=\{openReceived\.has\(reverseShare\.id\)\}/);
});

test("the signing preview follows the page the signature goes on", () => {
  for (const path of [
    "components/signing/RequestSignatureModal.tsx",
    "pages/signing/new.tsx",
  ]) {
    const source = read(path);
    assert.match(
      source,
      /const signatureTargetPage = form\.values\.customPageEnabled/,
      path,
    );
    assert.match(
      source,
      /\}, \[signatureTargetPage, pageLayouts\.length\]\);/,
      path,
    );
  }
});

test("untitled shares are named after their first file everywhere", () => {
  const share = read("pages/share/[shareId]/index.tsx");
  assert.match(share, /\{displayName\}/);
  assert.doesNotMatch(share, /shareInfo\.name \|\| share\?\.id/);
  const received = read("pages/account/reverseShares.tsx");
  assert.match(received, /defaultShareTitle\(files, !!files\)/);
  assert.doesNotMatch(received, /share\.name \|\| share\.id/);
});
