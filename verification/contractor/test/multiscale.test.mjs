import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { runMultiscaleBenchmark } from "../multiscale-benchmark.mjs"
import { withElapsedNotice } from "./elapsed-notice.mjs"

test(
  "whole-page carrier recovers reductions and enlarged captures, while refusing absent copies and independent negatives",
  { timeout: 1_800_000 },
  async () => {
    const report = await withElapsedNotice(
      "multiscale: 54 cases and 300 negatives",
      () => runMultiscaleBenchmark(),
    )
    assert.equal(report.cases.length, 54)
    assert.equal(report.negatives.length, 300)
    for (const width of [1000, 800, 640, 480, 320]) {
      const resized = report.cases.filter(
        (value) => value.name === `resize-to-${width}-no-visible-code`,
      )
      assert.equal(resized.length, 3)
      assert.ok(
        resized.every((value) => value.correct),
        `reduction ${width}`,
      )
    }
    assert.ok(
      report.cases
        .filter(
          (value) => value.name === "zoom-3.4-central-capture-no-visible-code",
        )
        .every((value) => value.correct),
    )
    assert.equal(report.falseMatches, 0)
    assert.ok(report.cases.every((value) => value.safeDecision))
    const published = JSON.parse(
      await readFile(
        new URL("../multiscale-results.json", import.meta.url),
        "utf8",
      ),
    )
    assert.equal(published.harnessSha256, report.harnessSha256)
    assert.equal(published.algorithmSha256, report.algorithmSha256)
    assert.equal(published.physicalPhotoCase.correctLaboratoryCopy, true)
    assert.equal(published.physicalPhotoCase.visibleCodePresent, false)
    assert.equal(published.physicalPhotoCase.matchesWithoutExpectedCandidate, 0)
    assert.equal(published.physicalPhotoCase.matchesWithWrongTeamKey, 0)
    assert.equal(
      createHash("sha256")
        .update(
          await readFile(
            new URL("../multiscale-copy-mark.ts", import.meta.url),
          ),
        )
        .digest("hex"),
      report.algorithmSha256,
    )
  },
)
