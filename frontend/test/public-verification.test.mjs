import assert from "node:assert/strict"
import test from "node:test"
import { readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { unzipSync } from "fflate"
const read = (relative) => readFile(new URL(relative, import.meta.url))
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const publicRoot = new URL(
  "../public/verification/contractor/",
  import.meta.url,
)

test("new private-corpus aggregates bind sources without disclosing private inputs", async () => {
  const report = JSON.parse(await read("../public/verification/contractor/preproduction-results.json"))
  for (const [field, file] of [
    ["fragmentSha256", "../src/utils/fragmentCopyMark.util.ts"],
    ["registrationCoreSha256", "../src/utils/photoRegistrationCore.util.ts"],
    ["registrationBuilderSha256", "../scripts/build-photo-registration.mjs"],
  ]) assert.equal(report[field], sha(await read(file)))
  assert.equal(report.actualExportedCandidates, 1)
  assert.equal(report.laboratoryDistractors, 7)
  assert.equal(report.referenceRegistration.otherPagesAccepted, 0)
  assert.equal(report.referenceRegistration.cspViolations, 0)
  for (const result of [report.referenceRegistration, ...report.fragmentCases]) {
    assert.ok(result.score >= result.decisionThreshold)
    assert.equal(result.withoutExpectedCandidate.decision, "none")
    assert.equal(result.wrongTeamPatterns.decision, "none")
  }
  assert.doesNotMatch(JSON.stringify(report), /Preuves_Tests|Téléchargements|PXL_|"filename"|sourceSha256|"markId"|\.jpg/i)
  const summary = JSON.parse(await read("../public/verification/contractor/summary.json"))
  assert.equal(summary.fragments.fixedScales, 181)
  assert.equal(summary.fragments.negativeControls.trials, 100)
  assert.equal(summary.fragments.negativeControls.uniqueMatches, 0)
})
async function listFiles(directory = publicRoot, prefix = "") {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory())
      files.push(
        ...(await listFiles(new URL(entry.name + "/", directory), name + "/")),
      )
    else files.push(name)
  }
  return files.sort()
}

test("photo measurements bind both sources without publishing private captures", async () => {
  const report = JSON.parse(
    await read("../public/verification/contractor/photo-results.json"),
  )
  assert.equal(
    report.algorithmSha256,
    sha(await read("../src/utils/forensicMark.util.ts")),
  )
  assert.equal(
    report.registrationSha256,
    sha(await read("../../verification/contractor/register-photo.py")),
  )
  assert.equal(report.cases.length, 2)
  assert.ok(
    report.cases.every(
      (c) =>
        c.rawStatus === "inconclusive" &&
        c.referenceAssistedStatus === "match" &&
        c.correctLaboratoryCopy &&
        c.referenceAssistedTopScore >= 8 &&
        c.withoutExpectedCandidate === "inconclusive",
    ),
  )
  assert.ok(report.limitations.some((line) => line.includes("development")))
  assert.doesNotMatch(
    JSON.stringify(report),
    /Preuves_Tests|a-front\.jpg|a-angle\.jpg|sourceSha256/,
  )
  const summary = JSON.parse(
    await read("../public/verification/contractor/summary.json"),
  )
  assert.equal(summary.photos.total, 2)
  assert.equal(summary.photos.rawMatches, 0)
  assert.equal(summary.photos.referenceAssistedMatches, 2)
  assert.equal(summary.photos.preproduction.rawStatus, "inconclusive")
  assert.equal(summary.photos.preproduction.referenceAssistedStatus, "inconclusive")
  assert.equal(summary.ocr.total, 6)
  assert.equal(summary.ocr.recovered, 0)
  assert.equal(summary.ocr.safeAbstentions, 6)
  const ocr = JSON.parse(await read("../public/verification/contractor/ocr-results.json"))
  assert.equal(ocr.cases.filter((item) => item.carrier === "v1-only").length, 3)
  assert.equal(ocr.cases.filter((item) => item.carrier === "v1-plus-multiscale-v2").length, 3)
  const evaluation = JSON.parse(
    await read(
      "../public/verification/contractor/decision-evaluation-results.json",
    ),
  )
  assert.equal(
    summary.decisionEvaluation.safe,
    evaluation.cases.filter((c) => c.safeDecision).length,
  )
})

test("photo registration never derives an output path from command-line input", async () => {
  const python = (await read("../../verification/contractor/register-photo.py")).toString()
  assert.doesNotMatch(python, /add_argument\(["']--output/)
  assert.doesNotMatch(python, /Path\(output|os\.chmod|args\.output/)
  for (const control of ["secrets.token_hex(16)", "os.O_NOFOLLOW", "os.O_EXCL", "dir_fd="])
    assert.ok(python.includes(control), control)
  assert.deepEqual(
    await read("../../verification/contractor/register-photo.py"),
    await read("../public/verification/contractor/register-photo.py"),
  )
  const wrapper = (await read("../scripts/register-forensic-photo.mjs")).toString()
  assert.match(wrapper, /args\.length,\s*2,/)
  assert.doesNotMatch(wrapper, /args\[2\]/)
  assert.match(wrapper, /mkdtemp\(/)
})

test("public watermark measurements and served sources match the application", async () => {
  for (const file of [
    "screenshot.mjs",
    "read-only.mjs",
    "test/read-only.test.mjs",
  ])
    assert.deepEqual(
      await read("../../verification/contractor/" + file),
      await read("../public/verification/contractor/" + file),
      file,
    )
  const source = await read("../src/utils/forensicMark.util.ts")
  const snapshot = await read("../../verification/contractor/watermark.ts")
  assert.deepEqual(source, snapshot)
  assert.deepEqual(
    source,
    await read("../public/verification/contractor/watermark.ts"),
  )
  for (const file of [
    "results.json",
    "extended-results.json",
    "corpus-results.json",
    "candidate-scale-results.json",
    "decision-evaluation-results.json",
  ]) {
    const report = JSON.parse(
      await read("../public/verification/contractor/" + file),
    )
    assert.equal(report.algorithmSha256, sha(source), file)
    assert.deepEqual(
      await read("../../verification/contractor/" + file),
      await read("../public/verification/contractor/" + file),
    )
  }
  assert.deepEqual(
    await read("../../backend/src/teamExternal/evidence-verifier.py"),
    await read("../public/verification/contractor/verifier.py"),
  )
})

test("article summary is small and derived from the published diagnostic reports", async () => {
  const bytes = await read("../public/verification/contractor/summary.json")
  assert.ok(
    bytes.length < 16 * 1024,
    "the article must not bundle full diagnostic matrices",
  )
  const summary = JSON.parse(bytes)
  assert.equal(
    summary.algorithmSha256,
    sha(await read("../src/utils/forensicMark.util.ts")),
  )
  for (const [key, file] of [
    ["baseline", "results.json"],
    ["extended", "extended-results.json"],
  ]) {
    const report = JSON.parse(
      await read("../public/verification/contractor/" + file),
    )
    assert.equal(summary[key].generatedAt, report.generatedAt)
    assert.equal(summary[key].caseCount, report.cases.length)
    for (const row of summary[key].transformations) {
      const cases = report.cases.filter((c) => c.transformation === row.name)
      assert.equal(row.total, cases.length)
      assert.equal(row.correct, cases.filter((c) => c.detected).length)
    }
    const negatives = report.cases.filter((c) => c.negativeControl)
    assert.equal(summary[key].negativeControls.trials, negatives.length)
    assert.equal(
      summary[key].negativeControls.falseMatches,
      negatives.filter((c) => c.matched !== null).length,
    )
  }
  const corpus = JSON.parse(
    await read("../public/verification/contractor/corpus-results.json"),
  )
  for (const key of [
    "generatedAt",
    "trials",
    "falseMatches",
    "candidateCount",
    "zeroFailureOneSided95Upper",
  ])
    assert.equal(summary.corpus[key], corpus[key])
  const candidates = JSON.parse(
    await read(
      "../public/verification/contractor/candidate-scale-results.json",
    ),
  )
  assert.deepEqual(
    summary.candidateScale.cases,
    candidates.cases.map(({ count, control, width, height, correct }) => ({
      count,
      control,
      width,
      height,
      correct,
    })),
  )
  assert.equal(
    summary.candidateScale.maxPatternBytes,
    Math.max(...candidates.cases.map((c) => c.patternBytes)),
  )
})

test("public reproducible archive has only the allowlisted tools and exact advertised checksums", async () => {
  const zip = await read("../public/verification/contractor/verification.zip")
  const contents = unzipSync(zip)
  const checks = (
    await read("../public/verification/contractor/checksums.sha256")
  )
    .toString()
    .trim()
    .split("\n")
  for (const line of checks) {
    const [expected, name] = line.split("  ")
    const bytes = await read("../public/verification/contractor/" + name)
    assert.equal(sha(bytes), expected, name)
    if (name !== "verification.zip")
      assert.deepEqual(Buffer.from(contents[name]), bytes, name)
  }
  assert.equal(Object.keys(contents).length, checks.length - 1)
  assert.ok(
    !Object.keys(contents).some((name) =>
      /node_modules|backend\/|\.key$|\.pem$/.test(name),
    ),
  )
  assert.deepEqual(
    await listFiles(),
    [
      ...checks.map((line) => line.split("  ")[1]),
      "checksums.sha256",
      "index.html",
      "style.css",
    ].sort(),
    "the public directory must not retain files outside the generated allowlist",
  )
})
