import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import ts from "typescript"

async function fixture(cancel = false) {
  const calls = []
  const key = "evidenceFixture" + randomUUID().replaceAll("-", "")
  const response = { id: "own-credential", type: "public-key", response: {} }
  globalThis[key] = {
    api: {
      post: async (url, data, options) => {
        calls.push({ url, data, options })
        return {
          data: url.endsWith("/download/options")
            ? {
                challengeId: "fresh-challenge",
                options: { challenge: "random" },
              }
            : new Blob(["archive"]),
        }
      },
    },
    authenticate: async (value, channel) => {
      calls.push({ channel, value })
      if (cancel)
        throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" })
      return response
    },
  }
  try {
    const source = await readFile(
      new URL("../src/services/teamExternal.service.ts", import.meta.url),
      "utf8",
    )
    let code = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText
    const native = code.includes("getNativePasskeyAssertion")
    code = code
      .replace(
        /import api from "[^"]+";/,
        `const api=globalThis[${JSON.stringify(key)}].api;`,
      )
      .replace(
        /import \{ apiPathSegment \} from "[^"]+";/,
        `import {apiPathSegment} from ${JSON.stringify(new URL("../src/utils/apiPath.util.ts", import.meta.url).href)};`,
      )
      .replace(
        /import \{ startAuthentication \} from "[^"]+";/,
        `const startAuthentication=value=>globalThis[${JSON.stringify(key)}].authenticate(value,"browser");`,
      )
      .replace(
        /import \{ IS_CAPACITOR_BUILD \} from "[^"]+";/,
        "const IS_CAPACITOR_BUILD=true;",
      )
      .replace(
        /import \{ getNativePasskeyAssertion \} from "[^"]+";/,
        `const getNativePasskeyAssertion=value=>globalThis[${JSON.stringify(key)}].authenticate(value,"native");`,
      )
    const module = await import(
      "data:text/javascript;base64," + Buffer.from(code).toString("base64")
    )
    return { service: module.default, calls, key, response, native }
  } catch (error) {
    delete globalThis[key]
    throw error
  }
}

test("team evidence performs a scoped fresh assertion before either archive download", async () => {
  for (const [method, kind] of [
    ["downloadCertificate", "certificate"],
    ["downloadEvidence", "evidence"],
  ]) {
    const f = await fixture()
    try {
      const blob = await f.service[method]("team?other", "copy/other")
      assert.equal(await blob.text(), "archive")
      assert.deepEqual(f.calls[0], {
        url: "teams/team%3Fother/external/issuances/copy%2Fother/download/options",
        data: { kind },
        options: undefined,
      })
      assert.equal(f.calls[1].channel, f.native ? "native" : "browser")
      assert.equal(
        f.calls[2].url,
        `teams/team%3Fother/external/issuances/copy%2Fother/${kind}`,
      )
      assert.deepEqual(f.calls[2].data, {
        challengeId: "fresh-challenge",
        response: f.response,
      })
      assert.deepEqual(f.calls[2].options, { responseType: "blob" })
    } finally {
      delete globalThis[f.key]
    }
  }
})

test("cancelled passkey confirmation never requests the certificate or evidence bytes", async () => {
  const f = await fixture(true)
  try {
    await assert.rejects(f.service.downloadEvidence("team", "copy"), {
      name: "NotAllowedError",
    })
    assert.equal(f.calls.filter((call) => call.url).length, 1)
  } finally {
    delete globalThis[f.key]
  }
})

test("pattern permission requires a fresh pattern-bound assertion and JSON response", async () => {
  const f = await fixture()
  try {
    await f.service.authorizePatternExport("team", "copy")
    assert.deepEqual(f.calls[0].data, { kind: "pattern" })
    assert.equal(f.calls[1].channel, f.native ? "native" : "browser")
    assert.equal(f.calls[2].url, "teams/team/external/issuances/copy/pattern")
    assert.deepEqual(f.calls[2].data, {
      challengeId: "fresh-challenge",
      response: f.response,
    })
    assert.deepEqual(f.calls[2].options, { responseType: "json" })
  } finally {
    delete globalThis[f.key]
  }
})

test("cancelled pattern assertion never authorizes an export", async () => {
  const f = await fixture(true)
  try {
    await assert.rejects(f.service.authorizePatternExport("team", "copy"), {
      name: "NotAllowedError",
    })
    assert.equal(f.calls.filter((call) => call.url).length, 1)
  } finally {
    delete globalThis[f.key]
  }
})
