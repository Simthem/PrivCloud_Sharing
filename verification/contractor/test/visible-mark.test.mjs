import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { runVisibleMarkerBenchmark } from "../visible-mark-benchmark.mjs"

test("visible copy markers recover through perspective/JPEG and reject unrelated or forged codes", async () => {
  const report = await runVisibleMarkerBenchmark()
  assert.equal(report.cases.length, 7)
  assert.ok(report.cases.every((item) => item.correct))
  const published = JSON.parse(
    await readFile(
      new URL("../visible-mark-results.json", import.meta.url),
      "utf8",
    ),
  )
  const source = await readFile(
    new URL("../visible-copy-mark.ts", import.meta.url),
  )
  assert.equal(
    published.markerSha256,
    createHash("sha256").update(source).digest("hex"),
  )
  assert.equal(published.harnessSha256, report.harnessSha256)
  assert.equal(published.physicalPhotoCase.markerRecovered, true)
  assert.equal(published.physicalPhotoCase.matchesWithoutExpectedCandidate, 0)
})
