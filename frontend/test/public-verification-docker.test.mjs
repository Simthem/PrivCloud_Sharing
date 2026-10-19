import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const generator = fs.readFileSync(
  path.join(root, "scripts/build-public-verification.mjs"),
  "utf8",
)
const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8")
const stage = docker
  .split("FROM base AS frontend-builder\n")[1]
  .split(/^FROM /m)[0]
const copies = [
  ...stage.replace(/\\\r?\n/g, " ").matchAll(/^COPY (?!--from)(.+)$/gm),
].flatMap((match) => {
  const words = match[1].trim().split(/\s+/)
  const destination = words.pop()
  return words
    .filter((source) =>
      /^(verification\/contractor\/|scripts\/build-public-verification\.mjs$|LICENSE$|backend\/src\/teamExternal\/evidence-verifier\.py$)/.test(
        source,
      ),
    )
    .map((source) => ({ source, destination }))
})
const inputs = [
  ...generator
    .match(/const files = \[([\s\S]*?)\]\.sort\(\)/)[1]
    .matchAll(/"([^"]+)"/g),
].map((match) => "verification/contractor/" + match[1])

function stagedGenerator(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "privcloud-docker-prebuild-"),
  )
  try {
    for (const { source, destination } of copies) {
      assert.ok(!source.split("/").includes(".."))
      assert.ok(
        destination.startsWith("/opt/app/") &&
          !destination.split("/").includes(".."),
      )
      const target = path.join(
        directory,
        destination.slice("/opt/app/".length),
        destination.endsWith("/") ? path.basename(source) : "",
      )
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(root, source), target)
    }
    for (const source of [
      "frontend/package.json",
      "frontend/src/utils/forensicMark.util.ts",
      "frontend/src/utils/visibleCopyMark.util.ts",
      "frontend/src/utils/robustCopyMark.util.ts",
      "frontend/src/utils/forensicDecision.util.ts",
      "frontend/src/utils/fragmentCopyMark.util.ts",
      "frontend/src/utils/photoRegistrationCore.util.ts",
      "frontend/scripts/build-photo-registration.mjs",
    ]) {
      const target = path.join(directory, source)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(root, source), target)
    }
    fs.mkdirSync(path.join(directory, "frontend/node_modules"))
    fs.symlinkSync(
      path.join(root, "frontend/node_modules/fflate"),
      path.join(directory, "frontend/node_modules/fflate"),
      "dir",
    )
    run(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function build(directory) {
  return spawnSync(
    process.execPath,
    ["scripts/build-public-verification.mjs"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 15_000,
    },
  )
}

test("Docker frontend builder explicitly copies every public verification prebuild input", () => {
  const expected = [
    "scripts/build-public-verification.mjs",
    "LICENSE",
    ...inputs,
  ]
  if (generator.includes("backend/src/teamExternal/evidence-verifier.py"))
    expected.push("backend/src/teamExternal/evidence-verifier.py")
  assert.deepEqual(copies.map((entry) => entry.source).sort(), expected.sort())
  assert.doesNotMatch(
    stage,
    /^COPY\s+(?:\.\/?\s|verification\/\s|verification\/contractor\/\s|backend\/\s)/m,
  )
  const prebuildPosition = stage.indexOf("RUN npm run build")
  assert.ok(prebuildPosition > 0)
  for (const source of expected)
    assert.ok(stage.indexOf(source) < prebuildPosition, source)
})

test("Docker-staged generator rebuilds the exact public checksums without the repository tree", () => {
  stagedGenerator((directory) => {
    assert.equal(fs.existsSync(path.join(directory, ".git")), false)
    const result = build(directory)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Public verification assets built/)
    for (const file of ["checksums.sha256", "summary.json", "verification.zip"])
      assert.deepEqual(
        fs.readFileSync(
          path.join(directory, "frontend/public/verification/contractor", file),
        ),
        fs.readFileSync(
          path.join(root, "frontend/public/verification/contractor", file),
        ),
      )
  })
})

test("Docker-staged generator keeps the deployed watermark snapshot guard", () => {
  stagedGenerator((directory) => {
    fs.appendFileSync(
      path.join(directory, "frontend/src/utils/forensicMark.util.ts"),
      "\n",
    )
    const result = build(directory)
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /Watermark snapshot differs from the deployed source/,
    )
    assert.equal(
      fs.existsSync(
        path.join(directory, "frontend/public/verification/contractor"),
      ),
      false,
    )
  })
})
