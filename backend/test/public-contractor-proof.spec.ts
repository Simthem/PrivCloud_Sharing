import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "src/signing/signing-evidence.util";
import {
  auditEventContentHash,
  auditEventHash,
  issuanceRecordHash,
} from "src/teamExternal/team-external-audit.util";
import { createUnitTestRunner } from "./unit-test";
const { testCase, run } = createUnitTestRunner(
  "public contractor proof parity",
);

testCase(
  "independent public proof formulas match the deployed backend format",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "privcloud-public-parity-"));
    try {
      const fixtureUrl = new URL(
        "file://" + resolve("../verification/contractor/test/fixture.mjs"),
      ).href;
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {makeFixture} from ${JSON.stringify(fixtureUrl)}; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(directory, "preuve.json"))},JSON.stringify(makeFixture(${JSON.stringify(directory)}).evidence));`,
        ],
        { timeout: 30000, stdio: "pipe" },
      );
      const proof = JSON.parse(
        readFileSync(join(directory, "preuve.json"), "utf8"),
      );
      const manifest = JSON.parse(proof.issuance.manifest);
      assert.equal(canonicalJson(manifest), proof.issuance.manifest);
      const w = proof.issuance.webauthn;
      assert.equal(
        issuanceRecordHash({
          manifest: proof.issuance.manifest,
          credentialId: w.credentialId,
          credentialPublicKey: w.publicKeyCoseBase64Url,
          credentialAlgorithm: w.algorithm,
          authenticatorData: w.authenticatorDataBase64Url,
          clientDataJSON: w.clientDataJSONBase64Url,
          signature: w.signatureBase64Url,
        }),
        proof.issuance.recordHash,
      );
      for (const event of proof.journal.events) {
        const content = {
          ...event,
          teamId: proof.journal.teamId,
          at: new Date(event.at),
        };
        assert.equal(auditEventHash(content), event.hash);
        assert.equal(
          auditEventContentHash(content),
          proof.journal.links.find((l: { seq: number }) => l.seq === event.seq)
            .contentHash,
        );
      }
      assert.equal(
        readFileSync("src/teamExternal/evidence-verifier.py", "utf8"),
        readFileSync("../verification/contractor/verifier.py", "utf8"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
void run();
