import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { prepareRuntimeManifest } from "../scripts/prepare-runtime-manifest.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const frontend = path.join(root, "frontend")
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8")
const runner = dockerfile.split(/ AS runner\n/)[1]
const builder = dockerfile
  .split("FROM base AS frontend-builder\n")[1]
  .split(/^FROM /m)[0]

function temporaryRuntime() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "privcloud-runtime-manifest-"),
  )
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "privcloud-sharing-frontend",
      version: "1.25.2",
      dependencies: { xlsx: "file:vendor/xlsx-0.20.3.tgz", next: "16.3.8" },
      scripts: { build: "next build" },
    }),
  )
  return directory
}

test("the official SheetJS 0.20.3 artifact is exact and locked locally", () => {
  const archive = fs.readFileSync(path.join(frontend, "vendor/xlsx-0.20.3.tgz"))
  assert.equal(
    createHash("sha256").update(archive).digest("hex"),
    "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8",
  )
  const manifest = JSON.parse(
    fs.readFileSync(path.join(frontend, "package.json"), "utf8"),
  )
  const lock = JSON.parse(
    fs.readFileSync(path.join(frontend, "package-lock.json"), "utf8"),
  )
  assert.equal(manifest.dependencies.xlsx, "file:vendor/xlsx-0.20.3.tgz")
  assert.deepEqual(
    {
      version: lock.packages["node_modules/xlsx"].version,
      resolved: lock.packages["node_modules/xlsx"].resolved,
    },
    { version: "0.20.3", resolved: "file:vendor/xlsx-0.20.3.tgz" },
  )
})

test("standalone manifest records only the packages actually installed in the runtime tree", () => {
  const directory = temporaryRuntime()
  try {
    fs.mkdirSync(path.join(directory, "node_modules/next"), { recursive: true })
    fs.writeFileSync(
      path.join(directory, "node_modules/next/package.json"),
      JSON.stringify({ name: "next", version: "16.3.8" }),
    )
    assert.deepEqual(prepareRuntimeManifest(directory), {
      name: "privcloud-sharing-frontend",
      version: "1.25.2",
      private: true,
    })
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")),
      {
        name: "privcloud-sharing-frontend",
        version: "1.25.2",
        private: true,
      },
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("standalone preparation fails if xlsx or a build lockfile enters the runtime", () => {
  for (const artifact of ["xlsx", "package-lock.json", "npm-shrinkwrap.json"]) {
    const directory = temporaryRuntime()
    try {
      if (artifact === "xlsx") {
        fs.mkdirSync(path.join(directory, "node_modules/xlsx"), {
          recursive: true,
        })
        fs.writeFileSync(
          path.join(directory, "node_modules/xlsx/package.json"),
          JSON.stringify({ name: "xlsx", version: "0.20.3" }),
        )
      } else fs.writeFileSync(path.join(directory, artifact), "{}")
      assert.throws(
        () => prepareRuntimeManifest(directory),
        artifact === "xlsx" ? /xlsx package/ : /lockfile/,
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
})

test("Docker sanitizes the standalone manifest and never copies frontend build manifests", () => {
  assert.match(builder, /RUN node scripts\/prepare-runtime-manifest\.mjs/)
  assert.doesNotMatch(
    runner,
    /frontend-builder[^\n]*(?:frontend\/package(?:-lock)?\.json|package-lock\.json)/,
  )
  assert.match(
    runner,
    /frontend-builder \/opt\/app\/frontend\/\.next\/standalone \.\//,
  )
})
