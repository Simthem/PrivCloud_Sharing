import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { detectMark, embedMark, markPattern } from "./watermark.ts"
import {
  embedRobustCopyMark,
  detectRobustCopyMark,
  combineCopyAnalyses,
} from "./multiscale-copy-mark.ts"
import { screenshot } from "./screenshot.mjs"

const execute = promisify(execFile)
const sha = (value) => createHash("sha256").update(value).digest("hex")
const escapeXml = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  )
const decode = async (buffer) => {
  const { data, info } = await sharp(buffer, { limitInputPixels: 16_000_000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  }
}
const encode = (pixels) =>
  sharp(Buffer.from(pixels.data), {
    raw: { width: pixels.width, height: pixels.height, channels: 4 },
  })
    .png()
    .toBuffer()

// OCR text is escaped before rendering. Only bounded word boxes survive.
export function recreateSvg(tsv, width, height) {
  if (
    typeof tsv !== "string" ||
    tsv.length > 1024 * 1024 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 64 ||
    height < 64 ||
    width * height > 16_000_000
  )
    throw new Error("Invalid or oversized OCR reconstruction")
  const words = []
  for (const line of tsv.split("\n").slice(1, 10001)) {
    const cells = line.split("\t")
    if (cells.length !== 12 || cells[0] !== "5") continue
    const [x, y, w, h, confidence] = cells.slice(6, 11).map(Number)
    const text = cells[11].trim()
    if (
      ![x, y, w, h, confidence].every(Number.isFinite) ||
      confidence < 0 ||
      x < 0 ||
      y < 0 ||
      w <= 0 ||
      h <= 0 ||
      x + w > width ||
      y + h > height ||
      text.length === 0 ||
      text.length > 256
    )
      continue
    words.push(
      `<text x="${x}" y="${y + h}" font-size="${h}" textLength="${w}" lengthAdjust="spacingAndGlyphs">${escapeXml(text)}</text>`,
    )
    if (words.length >= 2000) break
  }
  if (words.length < 20)
    throw new Error("OCR did not recover enough document words")
  return {
    words: words.length,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><g font-family="DejaVu Sans" fill="black">${words.join("")}</g></svg>`,
  }
}

export async function runOcrBenchmark() {
  const key = new Uint8Array(
    Buffer.from(sha("public-ocr-demonstration-v1"), "hex"),
  )
  const candidates = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const markId = sha(`public-ocr-copy:${index}`).slice(0, 32)
      return { markId, pattern: await markPattern(key, markId) }
    }),
  )
  const directory = await mkdtemp(path.join(tmpdir(), "privcloud-ocr-"))
  const cases = []
  let browser
  try {
    const version = (
      await execute("tesseract", ["--version"], {
        timeout: 10000,
        maxBuffer: 16384,
      })
    ).stdout.split("\n")[0]
    for (const [fixtureIndex, background] of [
      "white",
      "#dddddd",
      "#c6d6e6",
      "white",
      "#dddddd",
      "#c6d6e6",
    ].entries()) {
      const index = fixtureIndex % 3
      const coarse = fixtureIndex >= 3
      const analyse = (pixels) =>
        coarse
          ? combineCopyAnalyses([
              detectMark(pixels, candidates),
              detectRobustCopyMark(pixels, candidates),
            ])
          : detectMark(pixels, candidates)
      const lines = Array.from(
        { length: 30 },
        (_, line) =>
          `<text x="70" y="${100 + line * 38}" font-size="23">${escapeXml(`Record ${index + 1} line ${line + 1}: bounded local document verification and secure sharing.`)}</text>`,
      ).join("")
      const original = await decode(
        await sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1400"><rect width="100%" height="100%" fill="${background}"/><g font-family="DejaVu Sans" fill="#222222">${lines}</g></svg>`,
          ),
        )
          .png()
          .toBuffer(),
      )
      const marked = { ...original, data: new Uint8ClampedArray(original.data) }
      if (coarse) embedRobustCopyMark(marked, candidates[0].pattern)
      embedMark(marked, candidates[0].pattern)
      const capture = await screenshot(
        await encode(marked),
        marked.width,
        marked.height,
        { trustedSynthetic: true },
      )
      browser = capture.browser
      const captured = await decode(capture.png)
      const control = analyse(captured)
      assert.equal(
        control.best?.markId,
        candidates[0].markId,
        "The OCR input must contain the expected mark",
      )
      const input = path.join(directory, "capture.png")
      await writeFile(input, capture.png, { mode: 0o600 })
      const { stdout } = await execute(
        "tesseract",
        [input, "stdout", "-l", "eng", "--psm", "6", "tsv"],
        {
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, OMP_THREAD_LIMIT: "1" },
        },
      )
      const reconstructed = recreateSvg(stdout, marked.width, marked.height)
      const pixels = await decode(
        await sharp(Buffer.from(reconstructed.svg)).png().toBuffer(),
      )
      const result = analyse(pixels)
      const sourceControl = analyse(original)
      assert.notEqual(sha(pixels.data), sha(captured.data))
      assert.equal(
        result.best,
        null,
        "Recreated unmarked text must not accuse a copy",
      )
      assert.equal(result.compatible.length, 0)
      assert.equal(sourceControl.best, null)
      assert.equal(sourceControl.compatible.length, 0)
      cases.push({
        fixture: ["white", "gray", "blue"][index],
        carrier: coarse ? "v1-plus-multiscale-v2" : "v1-only",
        transformation: "screenshot-ocr-recreation",
        recoveredWords: reconstructed.words,
        width: pixels.width,
        height: pixels.height,
        screenshotStatus: control.status,
        screenshotScore: control.topScore,
        status: result.status,
        matched: result.best?.markId ?? null,
        compatible: result.compatible,
        topScore: result.topScore,
        runnerUpScore: result.runnerUpScore,
        pixelSha256: sha(pixels.data),
        screenshotPixelSha256: sha(captured.data),
        sourceRecreationStatus: sourceControl.status,
        sourceRecreationMatched: sourceControl.best?.markId ?? null,
        sourceRecreationCompatibleCount: sourceControl.compatible.length,
        safeDecision: result.best === null && result.compatible.length === 0,
      })
    }
    return {
      format: "privcloud-ocr-recreation-v1",
      generatedAt: new Date().toISOString(),
      algorithmSha256: sha(
        await readFile(new URL("watermark.ts", import.meta.url)),
      ),
      multiscaleAlgorithmSha256: sha(
        await readFile(new URL("multiscale-copy-mark.ts", import.meta.url)),
      ),
      harnessSha256: sha(
        await readFile(new URL("ocr-recreation.mjs", import.meta.url)),
      ),
      tools: {
        node: process.version,
        tesseract: version,
        browser,
        sharp: sharp.versions,
      },
      candidateCount: 8,
      threshold: 8,
      cases,
      limitations: [
        "Three synthetic text pages with v1 alone and with v1 plus multiscale v2, using real Chrome and Tesseract, not every OCR engine or document.",
        "OCR renders new glyphs on a new background and discards the invisible pixel pattern.",
        "Source recreation has no recipient-specific signal. Safe abstention is required, not successful recovery.",
        "Text/content similarity and visible names alone cannot establish which copy supplied the text.",
        "No private photograph, document, key, personal data or production attribution is included.",
      ],
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, "Usage: node ocr-recreation.mjs")
  const report = await runOcrBenchmark()
  const destination = await mkdtemp(path.join(process.cwd(), "ocr-report-"))
  await writeFile(
    path.join(destination, "ocr-results.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  )
  console.log(`OCR report saved in ${destination}`)
}
