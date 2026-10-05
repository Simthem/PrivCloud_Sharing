import assert from "node:assert/strict";
import test from "node:test";
import { isValidSigningRecipientEmail } from "../src/utils/signingEmail.util.ts";

test("signer addresses reject invalid domains before recipient and field submission", () => {
  for (const email of [
    "signer@example..test",
    "signer@.example.test",
    "signer@example.test.",
    "signer@-example.test",
    "signer@example-.test",
    "signer@example.c",
    "signer@example.123",
    "signer@exam_ple.test",
    ".signer@example.test",
    "signer..name@example.test",
    "signer@example.test ",
    "signer@@example.test",
  ]) {
    assert.equal(isValidSigningRecipientEmail(email), false, email);
  }
  for (const email of [
    "signer@example.test",
    "first.last+signing@sub.example.test",
    "signer@xn--exmple-cua.test",
    "élise@exemple.fr",
  ]) {
    assert.equal(isValidSigningRecipientEmail(email), true, email);
  }
});
