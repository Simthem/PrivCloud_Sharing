import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

const PREVIEW = "22222222-2222-4222-8222-222222222222";

async function contractorKeys() {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  const publicKey = Buffer.from(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  ).toString("base64url");
  const privateKey = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).slice(-32);
  const pq = ml_kem768.keygen();
  return {
    recipient: {
      x25519: { publicKey },
      pqKey: {
        variant: "ML-KEM-768",
        publicKey: Buffer.from(pq.publicKey).toString("base64url"),
      },
    },
    x25519: privateKey,
    mlkem: pq.secretKey,
  };
}

test("only the contractor's two private keys open a preview key", async () => {
  const {
    generatePreviewKeyBytes,
    wrapPreviewKeyForContractor,
    unwrapPreviewKeyWith,
    encryptExternalPage,
    decryptExternalPage,
    importPreviewKey,
  } = await import("../src/utils/externalPreviewCrypto.util.ts");
  const contractor = await contractorKeys();
  const raw = generatePreviewKeyBytes();
  const wrapping = await wrapPreviewKeyForContractor(raw, contractor.recipient);
  assert.equal(wrapping.algorithm, "x25519-mlkem768-aes256gcm");
  assert.equal(wrapping.encryptedKey.length, 64);
  assert.equal(wrapping.ephemeralPublicKey.length, 43);
  assert.equal(wrapping.nonce.length, 16);
  assert.equal(wrapping.kemCiphertext.length, 1451);

  const opened = await unwrapPreviewKeyWith(
    wrapping,
    contractor.x25519,
    contractor.mlkem,
  );
  const page = new TextEncoder().encode("page image");
  const sealed = await encryptExternalPage(
    await importPreviewKey(raw),
    PREVIEW,
    0,
    page,
  );
  assert.deepEqual(await decryptExternalPage(opened, PREVIEW, 0, sealed), page);

  const other = await contractorKeys();
  await assert.rejects(
    unwrapPreviewKeyWith(wrapping, contractor.x25519, other.mlkem),
  );
  await assert.rejects(
    unwrapPreviewKeyWith(wrapping, other.x25519, contractor.mlkem),
  );
  await assert.rejects(
    unwrapPreviewKeyWith(
      { ...wrapping, algorithm: "x25519-aes256gcm" },
      contractor.x25519,
      contractor.mlkem,
    ),
  );
});

test("a contractor without an ML-KEM-768 key gets no copy", async () => {
  const { wrapPreviewKeyForContractor, generatePreviewKeyBytes } =
    await import("../src/utils/externalPreviewCrypto.util.ts");
  const contractor = await contractorKeys();
  await assert.rejects(
    wrapPreviewKeyForContractor(generatePreviewKeyBytes(), {
      ...contractor.recipient,
      pqKey: { ...contractor.recipient.pqKey, variant: "ML-KEM-1024" },
    }),
  );
});

test("pages and manifest are bound to their preview and position", async () => {
  const {
    importPreviewKey,
    generatePreviewKeyBytes,
    encryptExternalPage,
    decryptExternalPage,
    encryptExternalManifest,
    decryptExternalManifest,
  } = await import("../src/utils/externalPreviewCrypto.util.ts");
  const key = await importPreviewKey(generatePreviewKeyBytes());
  const sealed = await encryptExternalPage(
    key,
    PREVIEW,
    3,
    new Uint8Array([1, 2, 3]),
  );
  await assert.rejects(decryptExternalPage(key, PREVIEW, 4, sealed));
  await assert.rejects(
    decryptExternalPage(key, "33333333-3333-4333-8333-333333333333", 3, sealed),
  );
  const tampered = sealed.slice();
  tampered[20] ^= 1;
  await assert.rejects(decryptExternalPage(key, PREVIEW, 3, tampered));

  const manifest = {
    v: 1,
    title: "Contrat.docx",
    watermark: "Presta - presta@example.test - 2026-10-06",
    createdAt: "2026-10-06T12:00:00.000Z",
    pages: [
      { width: 1400, height: 1800, label: "Page 1/2" },
      { width: 1400, height: 900 },
    ],
  };
  const value = await encryptExternalManifest(key, PREVIEW, manifest);
  assert.deepEqual(
    await decryptExternalManifest(key, PREVIEW, value, 2),
    manifest,
  );
  await assert.rejects(decryptExternalManifest(key, PREVIEW, value, 3));
  await assert.rejects(
    decryptExternalManifest(
      key,
      "33333333-3333-4333-8333-333333333333",
      value,
      2,
    ),
  );
});

test("only formats that can be flattened to images are offered", async () => {
  const { externalPreviewKind } =
    await import("../src/utils/externalPreviewLayout.util.ts");
  assert.equal(externalPreviewKind("application/pdf"), "pdf");
  assert.equal(
    externalPreviewKind(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    "office",
  );
  assert.equal(externalPreviewKind("text/csv"), "office");
  assert.equal(externalPreviewKind("image/png"), "image");
  assert.equal(externalPreviewKind("image/svg+xml"), "image");
  assert.equal(externalPreviewKind("text/plain"), "text");
  assert.equal(externalPreviewKind("application/json"), "text");
  assert.equal(externalPreviewKind("video/mp4"), null);
  assert.equal(externalPreviewKind("audio/mpeg"), null);
  assert.equal(externalPreviewKind("application/zip"), null);
  assert.equal(externalPreviewKind("application/octet-stream"), null);
});

test("tiles cover a page exactly within the bounded output size", async () => {
  const { computeTiles, EXTERNAL_PAGE_MAX_WIDTH, EXTERNAL_TILE_MAX_HEIGHT } =
    await import("../src/utils/externalPreviewLayout.util.ts");
  for (const [width, height] of [
    [794, 1123],
    [794, 9000],
    [11000, 3000],
    [300, 200],
  ]) {
    const { scale, tiles } = computeTiles(width, height);
    assert.ok(scale >= 1 && scale <= 2);
    let area = 0;
    for (const tile of tiles) {
      assert.ok(tile.width * scale <= EXTERNAL_PAGE_MAX_WIDTH + 1);
      assert.ok(tile.height * scale <= EXTERNAL_TILE_MAX_HEIGHT + 1);
      assert.ok(tile.x + tile.width <= width && tile.y + tile.height <= height);
      area += tile.width * tile.height;
    }
    assert.equal(area, width * height);
  }
  assert.equal(computeTiles(11000, 100).scale, 1);
  assert.ok(computeTiles(11000, 100).tiles.length >= 8);
});

test("text wraps and the watermark names the owner, then the contractor", async () => {
  const { wrapTextLines, buildWatermark } =
    await import("../src/utils/externalPreviewLayout.util.ts");
  assert.deepEqual(wrapTextLines("abcdefghijkl\n\tx", 10), [
    "abcdefghij",
    "kl",
    "    x",
  ]);
  const date = new Date("2026-10-06T12:00:00Z");
  const contractor = { name: "Jean Presta", email: "jp@example.test", date };
  assert.deepEqual(
    buildWatermark({ ...contractor, defaultMention: "Confidentiel" }),
    {
      text: "Jean Presta - jp@example.test - 2026-10-06",
      footer: "Jean Presta - jp@example.test - 2026-10-06",
    },
  );
  assert.equal(
    buildWatermark({ ...contractor, name: " ", defaultMention: "Confidentiel" })
      .text,
    "jp@example.test - 2026-10-06",
  );
  assert.deepEqual(
    buildWatermark({
      ...contractor,
      company: { companyName: "Acme Conseil", details: "SIRET 123 456 789" },
      defaultMention: "Confidentiel",
    }),
    {
      text: "Acme Conseil - Confidentiel - jp@example.test - 2026-10-06",
      footer:
        "Acme Conseil - SIRET 123 456 789 - Jean Presta - jp@example.test - 2026-10-06",
    },
  );
  assert.equal(
    buildWatermark({
      ...contractor,
      company: {
        companyName: "Acme Conseil",
        mention: "Strictement confidentiel",
      },
      defaultMention: "Confidentiel",
    }).text,
    "Acme Conseil - Strictement confidentiel - jp@example.test - 2026-10-06",
  );
});

test("team company details are bound to their team and never readable with another key", async () => {
  const { encryptTeamProfile, openTeamProfile } =
    await import("../src/utils/fileMetadata.util.ts");
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const other = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const TEAM = "11111111-1111-4111-8111-111111111111";
  const profile = {
    companyName: "Acme Conseil",
    mention: "Confidentiel",
    details: "Paris",
  };
  const sealed = await encryptTeamProfile(key, TEAM, profile);
  // Padded to 64-byte steps: [IV 12][64n][tag 16].
  assert.equal((Buffer.from(sealed, "base64url").length - 28) % 64, 0);
  assert.deepEqual(await openTeamProfile(key, TEAM, sealed), profile);
  assert.equal(await openTeamProfile(other, TEAM, sealed), undefined);
  assert.equal(
    await openTeamProfile(key, "22222222-2222-4222-8222-222222222222", sealed),
    undefined,
  );
  await assert.rejects(encryptTeamProfile(key, TEAM, { companyName: "  " }));
});

test("the contractor side offers no download path", () => {
  const files = [
    "src/components/external/ExternalPreviewViewer.tsx",
    "src/pages/external/index.tsx",
    "src/pages/external/[previewId].tsx",
  ];
  for (const file of files) {
    const source = fs.readFileSync(
      new URL(`../${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /createObjectURL|download=|\.download\b|toDataURL|toBlob/,
      file,
    );
  }
  const service = fs.readFileSync(
    new URL("../src/services/teamExternal.service.ts", import.meta.url),
    "utf8",
  );
  // Contractors only call their own routes, never a share or team route.
  const contractorPart = service.slice(
    service.indexOf("// External contractors"),
  );
  assert.doesNotMatch(contractorPart, /shares\/|teams\//);
});
