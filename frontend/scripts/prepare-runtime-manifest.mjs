import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function prepareRuntimeManifest(runtimeRoot) {
  const root = path.resolve(runtimeRoot)
  assert.ok(
    fs.lstatSync(root).isDirectory(),
    "Missing standalone runtime directory",
  )
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const location = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(location)
        continue
      }
      if (
        entry.name === "package-lock.json" ||
        entry.name === "npm-shrinkwrap.json"
      )
        throw new Error(
          "Build dependency lockfile entered the standalone runtime",
        )
      if (
        entry.name !== "package.json" ||
        location === path.join(root, "package.json")
      )
        continue
      const manifest = JSON.parse(fs.readFileSync(location, "utf8"))
      if (manifest.name === "xlsx")
        throw new Error(
          "Build-only xlsx package entered the standalone runtime",
        )
    }
  }

  const source = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  )
  assert.match(source.name, /^[a-z0-9][a-z0-9._-]*$/)
  assert.match(source.version, /^\d+\.\d+\.\d+$/)
  const runtime = { name: source.name, version: source.version, private: true }
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(runtime, null, 2) + "\n",
  )
  return runtime
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  prepareRuntimeManifest(".next/standalone")
