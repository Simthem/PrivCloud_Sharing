import assert from "node:assert/strict";
import { after, test } from "node:test";
import api from "../src/services/api.service.ts";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as policy from "../src/utils/contentV2.util.ts";
import * as identity from "../src/utils/shareContentContext.util.ts";
import * as paths from "../src/utils/apiPath.util.ts";

async function service(name) {
  const source = await readFile(
    new URL(`../src/services/${name}.service.ts`, import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const unused = new Proxy(
    { __esModule: true },
    {
      get: (_, key) =>
        key === "__esModule"
          ? true
          : () => {
              throw new Error(`Unexpected dependency ${String(key)}`);
            },
    },
  );
  const dependencies = {
    "./api.service": { __esModule: true, default: api },
    "../utils/contentV2.util": policy,
    "../utils/shareContentContext.util": identity,
    "../utils/apiPath.util": paths,
  };
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, {
    filename: `${name}.service.ts`,
  })((id) => dependencies[id] ?? unused, module, module.exports);
  return module.exports.default;
}
const shareService = await service("share");
const signingService = await service("signing");
import { ContentIntegrityError } from "../src/utils/contentV2.util.ts";
import { contentV2FileId } from "../src/utils/shareContentContext.util.ts";

const original = api.defaults.adapter;
after(() => {
  api.defaults.adapter = original;
});
const reply = (build) => {
  api.defaults.adapter = async (config) => ({
    status: 200,
    statusText: "OK",
    headers: {},
    config,
    data: build(config),
  });
};

test("the real share API refuses identity and encryption-flag substitutions", async () => {
  reply(() => ({ id: "v2.protected", isE2EEncrypted: false, files: [] }));
  await assert.rejects(shareService.get("v2.protected"), ContentIntegrityError);
  await assert.rejects(
    shareService.getFromOwner("v2.protected"),
    ContentIntegrityError,
  );
  reply(() => ({ id: "different", isE2EEncrypted: true, files: [] }));
  await assert.rejects(shareService.get("v2.protected"), ContentIntegrityError);
  reply(() => ({
    id: "historical",
    isE2EEncrypted: false,
    files: [{ id: contentV2FileId(crypto.randomUUID()) }],
  }));
  await assert.rejects(shareService.get("historical"), ContentIntegrityError);
  reply(() => ({
    id: "historical",
    isE2EEncrypted: true,
    files: [{ id: crypto.randomUUID() }],
  }));
  assert.equal((await shareService.get("historical")).isE2EEncrypted, true);
});

test("the real signing creator chooses its v2 identity before contacting the server", async () => {
  let requested;
  reply((config) => {
    requested = JSON.parse(config.data);
    return { ...requested, isE2EEncrypted: true };
  });
  const created = await signingService.createRequest({
    shareId: "v2.source",
    fileId: contentV2FileId(crypto.randomUUID()),
    isE2EEncrypted: true,
    recipients: [],
    notificationE2EKey: "client-only",
  });
  assert.equal(created.id[14], "8");
  assert.equal(created.id, requested.id);
  assert.equal(requested.notificationE2EKey, undefined);
  reply((config) => ({ ...JSON.parse(config.data), id: crypto.randomUUID() }));
  await assert.rejects(
    signingService.createRequest({
      shareId: "v2.source",
      fileId: contentV2FileId(crypto.randomUUID()),
      isE2EEncrypted: true,
      recipients: [],
    }),
    ContentIntegrityError,
  );
});

test("the real signature APIs refuse a plaintext claim for a new document", async () => {
  const id = contentV2FileId(crypto.randomUUID());
  reply(() => ({ id, isE2EEncrypted: false }));
  await assert.rejects(signingService.getDocument(id), ContentIntegrityError);
  reply(() => ({ document: { id, isE2EEncrypted: false } }));
  await assert.rejects(
    signingService.getSigningPage("signer-token"),
    ContentIntegrityError,
  );
});
