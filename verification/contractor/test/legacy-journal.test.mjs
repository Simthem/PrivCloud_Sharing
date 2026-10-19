import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { makeFixture } from "./fixture.mjs"

test("legacy event hashes remain valid without rewriting timestamped links", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "privcloud-legacy-proof-"))
  try {
    const { evidence } = makeFixture(directory, { legacyCount: 2 })
    const verify = (input) => {
      writeFileSync(path.join(directory, "preuve.json"), JSON.stringify(input))
      return spawnSync("python3", ["-I", fileURLToPath(new URL("../verifier.py", import.meta.url)),
        path.join(directory, "preuve.json"), "--strict", "--json", "--ca", path.join(directory, "ca.pem"),
        "--expected-origin", "https://proof.example.test", "--rp-id", "proof.example.test",
        "--original", path.join(directory, "original.txt"), "--checkpoint", path.join(directory, "checkpoint.json")],
      { encoding: "utf8", timeout: 30000 })
    }
    const valid = verify(evidence)
    assert.equal(valid.status, 0, valid.stdout + valid.stderr)
    assert.equal(JSON.parse(valid.stdout).status, "VALID")
    const changed = structuredClone(evidence)
    changed.journal.events[0].actorEmail = "modified@example.test"
    assert.equal(verify(changed).status, 1)
    const opaque = structuredClone(evidence)
    opaque.journal.events = opaque.journal.events.filter((event) => event.seq !== 2)
    const partial = verify(opaque)
    assert.equal(partial.status, 3, partial.stdout + partial.stderr)
    assert.equal(JSON.parse(partial.stdout).status, "INDETERMINATE")
    const mislabeled = structuredClone(evidence)
    mislabeled.journal.links[0].hashFormat = "split-v1"
    assert.equal(verify(mislabeled).status, 1)
    const downgrade = structuredClone(evidence)
    downgrade.journal.links[2].hashFormat = "legacy-flat-v1"
    assert.equal(verify(downgrade).status, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
