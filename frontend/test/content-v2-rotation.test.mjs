import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as cryptoUtils from "../src/utils/crypto.util.ts";
import * as metadata from "../src/utils/fileMetadata.util.ts";
import * as format from "../src/utils/contentV2.util.ts";
import * as policy from "../src/utils/contentPolicy.util.ts";
import * as chunks from "../src/utils/reencryptChunk.util.ts";

test("the real Team rotation authenticates historical plain names with v2 content, including an empty file", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const source = await readFile(
    new URL("../src/utils/reencrypt.util.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  for (const { size, lost } of [
    { size: 0, lost: false },
    { size: 17, lost: false },
    { size: 17, lost: true },
  ]) {
    const root = await cryptoUtils.generateEncryptionKey();
    const next = await cryptoUtils.generateEncryptionKey({ v2Floor: true });
    const shareId = "historical-team-share";
    const fileId = "11111111-2222-4333-8444-555555555555";
    const plain = Uint8Array.from({ length: size }, (_, i) => i);
    const old =
      size === 0
        ? new Uint8Array()
        : new Uint8Array(await cryptoUtils.encryptFile(plain.buffer, root));
    const uploads = [];
    const file = {
      id: fileId,
      name: "before.txt",
      relativePath: "folder/before.txt",
      size: String(old.length),
      metadataScheme: null,
    };
    const dependencies = {
      "./crypto.util": cryptoUtils,
      "./fileMetadata.util": metadata,
      "./contentV2.util": format,
      "./contentPolicy.util": policy,
      "./reencryptChunk.util": chunks,
      "../services/team.service": {
        __esModule: true,
        default: {
          getTeamShares: async () => [
            {
              id: shareId,
              files: [
                lost && uploads.length
                  ? {
                      ...file,
                      metadataScheme: 1,
                      encryptedMetadata: uploads[0].request.encryptedMetadata,
                    }
                  : file,
              ],
            },
          ],
        },
      },
      "../services/api.service": {
        setUploadActive() {},
        refreshTokenOnce: async () => undefined,
      },
      "./reencryptUpload.util": {
        uploadReencryptChunkInWorker: async (request, bytes) => {
          uploads.push({ request, bytes });
          if (lost) throw new Error("Acknowledgement lost");
        },
      },
    };
    globalThis.fetch = async (url) =>
      url === "/api/configs"
        ? Response.json([])
        : new Response(
            lost && uploads.length ? uploads[0].bytes : old.length ? old : null,
            {
              headers: {
                "Content-Length": String(
                  lost && uploads.length
                    ? uploads[0].bytes.byteLength
                    : old.length,
                ),
                "X-Encryption-Chunk-Size": "1000000",
              },
            },
          );
    const module = { exports: {} };
    vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, {
      filename: "reencrypt.util.ts",
    })((id) => dependencies[id] ?? {}, module, module.exports);
    const result = await module.exports.reencryptTeam(
      "team",
      await cryptoUtils.exportKeyToBase64(root),
      await cryptoUtils.exportKeyToBase64(next),
      undefined,
      undefined,
      { rotationId: crypto.randomUUID() },
    );
    assert.equal(result.filesReencrypted, lost ? 0 : 1, JSON.stringify(result));
    assert.equal(result.filesSkipped, lost ? 1 : 0);
    assert.equal(result.filesFailed, 0);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].request.contentScheme, 2);
    const encryptedMetadata = uploads[0].request.encryptedMetadata;
    assert.equal(typeof encryptedMetadata, "string");
    const rows = await metadata.decryptShareFileNames(
      shareId,
      [
        {
          ...file,
          name: "encrypted-file-11111111",
          metadataScheme: 1,
          encryptedMetadata,
        },
      ],
      next,
    );
    assert.equal(rows[0].name, "before.txt");
    assert.equal(rows[0].relativePath, "folder/before.txt");
    assert.notEqual(rows[0].metadataUnreadable, true);
    assert.deepEqual(
      new Uint8Array(
        await cryptoUtils.decryptFileAuto(uploads[0].bytes, next, 1_000_000, {
          fileId,
          shareId,
        }),
      ),
      plain,
    );
    assert.equal(file.name, "before.txt");
    assert.equal(file.metadataScheme, null);
  }
});
