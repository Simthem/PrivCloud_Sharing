import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalMention,
  approvalWatermark,
  signingDay,
  signingLanguage,
  signingLanguageOf,
  signedPdfName,
} from "../src/utils/signingLanguage.util.ts";

test("a request carries the requester's interface language", () => {
  assert.equal(signingLanguageOf("fr-FR"), "fr");
  assert.equal(signingLanguageOf("en-US"), "en");
  assert.equal(signingLanguageOf("de-DE"), "en");
  assert.equal(signingLanguage(undefined), "fr");
  assert.equal(signingLanguage("en"), "en");
});

test("the marks drawn in the browser match the server's wording", () => {
  const date = new Date("2026-11-07T10:00:00Z");
  assert.equal(
    approvalMention(date, "fr"),
    "Lu et approuvé le 7 novembre 2026",
  );
  assert.equal(
    approvalMention(date, "en"),
    "Read and approved on 7 November 2026",
  );
  assert.equal(approvalWatermark("fr"), "Bon pour Accord");
  assert.equal(approvalWatermark("en"), "Approved");
  assert.equal(signingDay(date, "en"), "7 November 2026");
});

test("the signed copy is named like the server names it", () => {
  assert.equal(signedPdfName("contrat.pdf", "fr"), "contrat_signé.pdf");
  assert.equal(signedPdfName("contrat.pdf", "en"), "contrat_signed.pdf");
  assert.equal(signedPdfName("Contrat.PDF", "fr"), "Contrat_signé.pdf");
  assert.equal(signedPdfName("scan", "en"), "scan_signed.pdf");
  assert.equal(signedPdfName(undefined, "fr"), "document_signé.pdf");
});
