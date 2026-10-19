import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { runBenchmark } from "../benchmark.mjs"
import { withElapsedNotice } from "./elapsed-notice.mjs"

test(
  "public destructive tests measure the deployed watermark with real JPEG and Chrome screenshots",
  { timeout: 600_000 },
  async () => {
    const report = await withElapsedNotice(
      "destructive screenshot matrix",
      () => runBenchmark(),
    )
    const expected = [
      "screenshot-100-percent",
      "crop-20-percent-area-offset-0",
      "crop-20-percent-area-offset-1",
      "crop-50-percent-area-offset-0",
      "crop-50-percent-area-offset-1",
      "jpeg-q90",
      "jpeg-q60",
      "resize-1920-to-800",
      "contrast-plus-30-percent-clipped",
    ]
    for (const c of report.cases) {
      if (
        expected.includes(c.transformation) ||
        c.transformation === "rotation-2-degrees"
      )
        assert.equal(c.detected, true, `${c.fixture}/${c.transformation}`)
      if (
        c.negativeControl ||
        c.transformation === "pixel-recreation-from-source"
      )
        assert.equal(c.matched, null, `${c.fixture}/${c.transformation}`)
    }
    assert.equal(
      report.cases.find(
        (c) =>
          c.fixture === "white" &&
          c.transformation === "background-whitening-and-dark-threshold",
      ).matched,
      null,
    )
    if (process.env.WATERMARK_REPORT)
      await writeFile(
        process.env.WATERMARK_REPORT,
        JSON.stringify(report, null, 2) + "\n",
      )
  },
)

test("the published measurement identifies the exact watermark source", async () => {
  const report = JSON.parse(
    await readFile(new URL("../results.json", import.meta.url), "utf8"),
  )
  const algorithm = await readFile(new URL("../watermark.ts", import.meta.url))
  assert.equal(
    report.algorithmSha256,
    createHash("sha256").update(algorithm).digest("hex"),
  )
  assert.ok(
    report.measuredSeparately.some(
      (c) =>
        c.transformation === "real-smartphone-photo" &&
        c.report === "photo-results.json",
    ),
  )
  assert.ok(
    report.measuredSeparately.some(
      (c) =>
        c.transformation === "screenshot-ocr-recreation" &&
        c.report === "ocr-results.json",
    ),
  )
})
