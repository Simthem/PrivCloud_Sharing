import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PDFDocument } from "pdf-lib"

const args = process.argv.slice(2)
assert.equal(
  args.length,
  2,
  "Usage: node scripts/register-forensic-photo.mjs ABSOLUTE_REFERENCE_PNG ABSOLUTE_PHOTO",
)
assert.ok(
  args.every((value) => path.isAbsolute(value)),
  "Input paths must be absolute",
)
const python = process.env.PRIVCLOUD_PHOTO_PYTHON
assert.ok(
  python && path.isAbsolute(python),
  "Set PRIVCLOUD_PHOTO_PYTHON to the Python executable in your isolated photo environment",
)
const helper = fileURLToPath(
  new URL("../../verification/contractor/register-photo.py", import.meta.url),
)
const temporary = await mkdtemp(path.join(tmpdir(), "privcloud-photo-pdf-"))
try {
  const { stdout } = await promisify(execFile)(
    python,
    [
      helper,
      "--reference",
      args[0],
      "--photo",
      args[1],
    ],
    { timeout: 120_000, maxBuffer: 32 * 1024, cwd: temporary },
  )
  const response = JSON.parse(stdout)
  // The helper reports where it wrote, but only this process's own temporary
  // directory decides which files are read back.
  const registrations = path.join(temporary, "photo-registrations")
  const entries = await readdir(registrations)
  assert.ok(
    entries.length === 1 &&
      /^[a-f0-9]{32}$/.test(entries[0]) &&
      response.output === "photo-registrations/" + entries[0],
    "The registration helper must create exactly one output directory",
  )
  const output = path.join(registrations, entries[0])
  const registration = JSON.parse(
    await readFile(path.join(output, "registration.json"), "utf8"),
  )
  assert.ok(
    registration.hypotheses.length >= 1 && registration.hypotheses.length <= 2,
  )
  const document = await PDFDocument.create()
  for (const { method } of registration.hypotheses) {
    assert.ok(method === "sift" || method === "ecc")
    const image = await document.embedPng(
      await readFile(
        path.join(output, method === "sift" ? "sift.png" : "ecc.png"),
      ),
    )
    const page = document.addPage([
      (image.width * 72) / 200,
      (image.height * 72) / 200,
    ])
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight(),
    })
  }
  // Lossless PNG pages. The application inspects embedded images at native size.
  // All geometric hypotheses stay together for the cross-page ambiguity check.
  const pdf = await document.save()
  assert.ok(pdf.length <= 64 * 1024 * 1024, "Registered PDF exceeds the verifier's 64 MiB budget")
  const destination = await mkdtemp(
    path.join(process.cwd(), "privcloud-registered-photo-"),
  )
  const outputFile = path.join(destination, "registered-photo.pdf")
  try {
    await writeFile(outputFile, pdf, { flag: "wx", mode: 0o600 })
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
  console.log(
    `Registered photo PDF saved: ${outputFile}\nAnalyse every page together in the team verifier. No watermark key was used.`,
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
