import "reflect-metadata";
import assert from "node:assert/strict";
import { deliverSigningCompletionEmails } from "src/signing/signing-mail.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signing completion mail");

testCase(
  "attempts creator first and isolates recipient delivery failures",
  async () => {
    const attempts: string[] = [];
    const failures: string[] = [];

    const result = await deliverSigningCompletionEmails({
      fileName: "contrat.pdf",
      documentUrl: "https://example.test/signing/doc-1",
      creator: { email: "owner@example.test", username: "Owner" },
      recipients: [
        {
          email: "broken@example.test",
          name: "Broken",
          role: "SIGNER",
          signedAt: new Date("2026-07-13T12:00:00Z"),
        },
        {
          email: "working@example.test",
          name: "Working",
          role: "SIGNER",
          signedAt: new Date("2026-07-13T12:01:00Z"),
        },
      ],
      sendMail: async (email) => {
        attempts.push(email);
        if (email === "broken@example.test") throw new Error("SMTP rejected");
      },
      onFailure: (email) => failures.push(email),
    });

    assert.equal(attempts[0], "owner@example.test");
    assert.deepEqual(
      new Set(attempts),
      new Set([
        "owner@example.test",
        "broken@example.test",
        "working@example.test",
      ]),
    );
    assert.deepEqual(failures, ["broken@example.test"]);
    assert.deepEqual(result, { sent: 2, failed: 1 });
  },
);

void run();
