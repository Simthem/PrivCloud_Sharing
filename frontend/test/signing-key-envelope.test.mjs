import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const namespace = (value) => ({ __esModule: true, ...value });
let current, posts, targets;
const api = {
  get: async (url) => {
    if (url === "crypto/identity/keys/me") return { data: current.identities };
    if (url === "crypto/identity/pq-keys/me")
      return { data: current.pq ?? null };
    throw new Error(`Unexpected fixture GET ${url}`);
  },
  post: async (url, data) => {
    posts.push([url, data]);
    if (url.endsWith("encryption-targets")) return { data: targets };
    if (url === "crypto/identity/keys/batch")
      return {
        data: [current.publicKeys].filter((entry) =>
          data.userIds.includes(entry.userId),
        ),
      };
    if (url.endsWith("key-envelopes"))
      return { data: { stored: data.recipients.length } };
    if (url === "signing/request")
      return { data: { ...data, status: "PENDING", fileName: "source.pdf" } };
    throw new Error(`Unexpected fixture POST ${url}`);
  },
};
const toKey = async (key) =>
  crypto.subtle.importKey(
    "raw",
    Buffer.from(key, "base64url"),
    "AES-GCM",
    true,
    ["encrypt", "decrypt"],
  );
class IntegrityError extends Error {}
const mocks = {
  "./api.service": namespace({ default: api }),
  "../utils/apiPath.util": {
    apiPathSegment: (value) => encodeURIComponent(value),
  },
  "../utils/pqNotification.util": {
    selectPqNotificationPublicKey: (enabled, key) => (enabled ? key : null),
  },
  "./contentV2.util": { ContentIntegrityError: IntegrityError },
  "../utils/contentV2.util": { ContentIntegrityError: IntegrityError },
  "./crypto.util": { importKeyFromBase64: toKey },
  "../utils/shareContentContext.util": {
    contentV2FileId: (value) => value,
    isContentV2FileId: () => true,
  },
  "../utils/signingNotification.util": {
    buildSigningNotificationActions: (token, key) => ({
      invitation: `/sign/${token}${key ? `#key=${key}` : ""}`,
      completion: `/sign/${token}?download=1`,
    }),
  },
  "./team.service": namespace({
    default: {
      getTeam: async () => ({
        members: [],
        pqNotificationEncryptionEnabled: false,
      }),
    },
  }),
};
function load(path) {
  const module = { exports: {} };
  const source = fs.readFileSync(
    new URL(`../src/${path}`, import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  new Function("require", "module", "exports", output)(
    (id) => mocks[id] ?? require(id),
    module,
    module.exports,
  );
  return module.exports;
}
const cryptoService = load("services/crypto.service.ts");
mocks["../services/crypto.service"] = cryptoService;
mocks["./crypto.service"] = cryptoService;
const envelopes = load("utils/signingKeyEnvelope.util.ts");
mocks["../utils/signingKeyEnvelope.util"] = envelopes;
const signing = load("services/signing.service.ts").default;

async function account(hybrid = false) {
  const master = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const pair = await cryptoService.generateX25519KeyPair();
  const userId = randomUUID();
  const identities = [
    {
      keyType: "X25519",
      version: 1,
      encryptedPrivateKey: await cryptoService.encryptPrivateKey(
        pair.privateKey,
        master,
      ),
    },
  ];
  const publicKeys = {
    userId,
    x25519: {
      publicKey: Buffer.from(pair.publicKey).toString("base64url"),
      algorithm: "x25519-aes256gcm",
      version: 1,
    },
    pqKey: null,
  };
  let pq;
  if (hybrid) {
    const pair = await cryptoService.generateMLKEMKeyPair();
    publicKeys.pqKey = {
      publicKey: Buffer.from(pair.publicKey).toString("base64url"),
      variant: "ML-KEM-768",
      version: 1,
    };
    pq = {
      encryptedPrivateKey: await cryptoService.encryptPrivateKey(
        pair.privateKey,
        master,
      ),
    };
  }
  return { master, identities, publicKeys, pq };
}
const context = () => ({
  documentId: randomUUID(),
  fileId: randomUUID(),
  recipientUserId: current.publicKeys.userId,
});

test("an untouched recipient decrypts the document key using its own private identity, including hybrid mode", async () => {
  for (const hybrid of [false, true]) {
    current = await account(hybrid);
    posts = [];
    const key = randomBytes(32).toString("base64url"),
      scope = context();
    const envelope = await envelopes.sealSigningKey(
      key,
      scope,
      current.publicKeys,
    );
    assert.equal(envelope.includes(key), false);
    assert.equal(
      JSON.parse(envelope).algorithm,
      hybrid ? "x25519-mlkem768-aes256gcm" : "x25519-aes256gcm",
    );
    assert.equal(
      await envelopes.openSigningKey(envelope, scope, current.master),
      key,
    );
    assert.deepEqual(posts, []);
  }
});

test("envelopes cannot be replayed across accounts, files or documents, or decrypted by another account", async () => {
  current = await account();
  posts = [];
  const owner = current,
    key = randomBytes(32).toString("base64url"),
    scope = context();
  const envelope = await envelopes.sealSigningKey(
    key,
    scope,
    current.publicKeys,
  );
  for (const field of ["documentId", "fileId", "recipientUserId"]) {
    await assert.rejects(
      envelopes.openSigningKey(
        envelope,
        { ...scope, [field]: randomUUID() },
        owner.master,
      ),
      /Invalid signing key envelope context/,
    );
  }
  current = await account();
  await assert.rejects(
    envelopes.openSigningKey(envelope, scope, current.master),
  );
  current = owner;
  const corrupted = JSON.parse(envelope);
  const bytes = Buffer.from(corrupted.ciphertext, "base64url");
  bytes[0] ^= 1;
  corrupted.ciphertext = bytes.toString("base64url");
  await assert.rejects(
    envelopes.openSigningKey(JSON.stringify(corrupted), scope, current.master),
  );
});

test("a retained signed result recovers its key by document and account after source deletion", async () => {
  current = await account();
  posts = [];
  const key = randomBytes(32).toString("base64url"),
    scope = context();
  const envelope = await envelopes.sealSigningKey(
    key,
    scope,
    current.publicKeys,
  );
  assert.equal(
    await envelopes.openSigningKey(
      envelope,
      { ...scope, fileId: null },
      current.master,
    ),
    key,
  );
  await assert.rejects(
    envelopes.openSigningKey(
      envelope,
      { ...scope, documentId: randomUUID(), fileId: null },
      current.master,
    ),
  );
});

test("a personal request delivers the key before any recipient visit without sending it in clear", async () => {
  current = await account();
  posts = [];
  const email = "signer@example.test",
    key = randomBytes(32).toString("base64url");
  targets = [{ email, userId: current.publicKeys.userId }];
  const request = await signing.createRequest({
    shareId: randomUUID(),
    fileId: randomUUID(),
    isE2EEncrypted: true,
    notificationE2EKey: key,
    recipients: [{ email, name: "Signer" }],
  });
  const sent = posts.find(([url]) => url === "signing/request")[1];
  assert.equal(JSON.stringify(posts).includes(key), false);
  assert.equal("notificationE2EKey" in sent, false);
  assert.equal("e2eKey" in sent, false);
  assert.equal(sent.recipients[0].keyEnvelopeUserId, current.publicKeys.userId);
  assert.equal(
    await envelopes.openSigningKey(
      sent.recipients[0].encryptedKeyEnvelope,
      {
        documentId: request.id,
        fileId: request.fileId,
        recipientUserId: current.publicKeys.userId,
      },
      current.master,
    ),
    key,
  );
});

test("an external Team recipient receives the key independently of Team notification membership", async () => {
  current = await account();
  posts = [];
  const email = "outside@example.test",
    key = randomBytes(32).toString("base64url");
  targets = [{ email, userId: current.publicKeys.userId }];
  const request = await signing.createRequest({
    shareId: randomUUID(),
    fileId: randomUUID(),
    teamId: randomUUID(),
    notificationCreatorId: randomUUID(),
    isE2EEncrypted: true,
    notificationE2EKey: key,
    recipients: [{ email, name: "Signer" }],
  });
  assert.equal(typeof request.recipients[0].encryptedKeyEnvelope, "string");
  assert.equal(request.recipients[0].teamInviteNotification, undefined);
  assert.equal(JSON.stringify(posts).includes(key), false);
});

test("the requester repairs an existing invitation with ciphertext only and recipients cannot initiate the repair", async () => {
  current = await account();
  posts = [];
  const key = randomBytes(32).toString("base64url");
  const document = {
    id: randomUUID(),
    fileId: randomUUID(),
    isRequester: true,
    isE2EEncrypted: true,
  };
  targets = [
    {
      recipientId: randomUUID(),
      email: "signer@example.test",
      userId: current.publicKeys.userId,
    },
  ];
  assert.deepEqual(
    await signing.ensureRecipientKeyEnvelopes(
      { ...document, isRequester: false },
      key,
    ),
    { stored: 0 },
  );
  assert.deepEqual(posts, []);
  assert.deepEqual(await signing.ensureRecipientKeyEnvelopes(document, key), {
    stored: 1,
  });
  const sent = posts.find(([url]) => url.endsWith("key-envelopes"))[1];
  assert.equal(JSON.stringify(posts).includes(key), false);
  assert.equal(
    await envelopes.openSigningKey(
      sent.recipients[0].encryptedKeyEnvelope,
      {
        documentId: document.id,
        fileId: document.fileId,
        recipientUserId: current.publicKeys.userId,
      },
      current.master,
    ),
    key,
  );
});
