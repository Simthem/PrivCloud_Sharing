import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { recreateSvg } from "../ocr-recreation.mjs"

const row = (text, x = 10) => `5\t1\t1\t1\t1\t1\t${x}\t10\t50\t20\t90\t${text}`

test("OCR reconstruction escapes document words and bounds geometry", () => {
  const tsv =
    "header\n" +
    Array.from({ length: 20 }, () =>
      row('<a href="https://external.invalid/">'),
    ).join("\n")
  const result = recreateSvg(tsv + "\n" + row("outside", 9999), 500, 500)
  assert.equal(result.words, 20)
  assert.ok(result.svg.includes("&lt;a href=&quot;"))
  assert.doesNotMatch(result.svg, /<a |outside/)
  assert.throws(() => recreateSvg(tsv, "500", 500))
  assert.throws(() => recreateSvg(tsv, 5000, 5000))
  assert.throws(() => recreateSvg("x".repeat(1024 * 1024 + 1), 500, 500))
})

test("the OCR measurement has real recovered text and identifies its exact sources", async () => {
  const report = JSON.parse(
    await readFile(new URL("../ocr-results.json", import.meta.url), "utf8"),
  )
  const hash = async (file) =>
    createHash("sha256")
      .update(await readFile(new URL(file, import.meta.url)))
      .digest("hex")
  assert.equal(report.algorithmSha256, await hash("../watermark.ts"))
  assert.equal(report.harnessSha256, await hash("../ocr-recreation.mjs"))
  assert.equal(
    report.multiscaleAlgorithmSha256,
    await hash("../multiscale-copy-mark.ts"),
  )
  assert.match(report.tools.tesseract, /^tesseract /)
  assert.match(report.tools.browser, /^Chrome\//)
  assert.equal(report.cases.length, 6)
  assert.equal(
    report.cases.filter((item) => item.carrier === "v1-only").length,
    3,
  )
  assert.equal(
    report.cases.filter((item) => item.carrier === "v1-plus-multiscale-v2")
      .length,
    3,
  )
  for (const item of report.cases) {
    assert.ok(item.recoveredWords >= 20)
    assert.equal(item.screenshotStatus, "match")
    assert.notEqual(item.pixelSha256, item.screenshotPixelSha256)
    assert.equal(item.matched, null)
    assert.equal(item.safeDecision, true)
    assert.equal(item.sourceRecreationMatched, null)
    assert.equal(item.sourceRecreationCompatibleCount, 0)
  }
})
