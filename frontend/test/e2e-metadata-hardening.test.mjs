import assert from "node:assert/strict";
import test from "node:test";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import {
  arrayBufferToBase64Url,
  generateEncryptionKey,
} from "../src/utils/crypto.util.ts";
import {
  encryptFileRequestInfo,
  encryptReverseShareName,
  openFileRequestInfo,
  openReverseShareName,
} from "../src/utils/fileMetadata.util.ts";

const REQUEST = "1f0e3c9a-6a43-4b5e-9a57-2c1d6f3b8e10";

// Same rule as the server checks (backend file-metadata-scheme.ts).
function serverAccepts(value, maxPlaintext) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const plaintext = Math.floor((value.length * 3) / 4) - 28;
  return plaintext >= 64 && plaintext <= maxPlaintext && plaintext % 64 === 0;
}

test("upload link names open with K_rs only", async () => {
  const key = await generateEncryptionKey();
  const other = await generateEncryptionKey();
  for (const name of ["Dépôt RH", "x".repeat(90), "Devis 日本 ✓"]) {
    const encryptedName = await encryptReverseShareName(key, name);
    assert.ok(serverAccepts(encryptedName, 512), name);
    assert.ok(
      !Buffer.from(encryptedName, "base64url").includes(Buffer.from(name)),
    );
    assert.equal(await openReverseShareName({ encryptedName }, key), name);
    assert.equal(
      await openReverseShareName({ encryptedName }, other),
      undefined,
    );
    assert.equal(
      await openReverseShareName({ encryptedName }, null),
      undefined,
    );
  }
  assert.equal(
    await openReverseShareName({ name: "Lisible" }, null),
    "Lisible",
  );
  await assert.rejects(encryptReverseShareName(key, "x".repeat(91)));
});

test("file request subjects are bound to their request", async () => {
  const key = await generateEncryptionKey();
  const info = { subject: "Bilans 2026", note: "Ligne 1\nLigne 2" };
  const encryptedInfo = await encryptFileRequestInfo(key, REQUEST, info);
  assert.ok(serverAccepts(encryptedInfo, 16384));
  const row = { id: REQUEST, subject: "", note: null, encryptedInfo };
  assert.deepEqual(await openFileRequestInfo(row, key), info);
  assert.equal(
    await openFileRequestInfo({ ...row, id: "another-request" }, key),
    undefined,
    "a ciphertext moved to another request does not open",
  );
  assert.equal(
    await openFileRequestInfo(row, await generateEncryptionKey()),
    undefined,
  );
  assert.deepEqual(
    await openFileRequestInfo(
      { id: REQUEST, subject: "Lisible", note: null },
      null,
    ),
    { subject: "Lisible" },
  );

  const longest = await encryptFileRequestInfo(key, REQUEST, {
    subject: "\u0001".repeat(120),
    note: "\u0001".repeat(2000),
  });
  assert.ok(serverAccepts(longest, 16384), "worst-case JSON escaping fits");
  await assert.rejects(
    encryptFileRequestInfo(key, REQUEST, { subject: "x".repeat(121) }),
  );
});

test("ML-KEM-768 ciphertexts have the length the server expects", () => {
  const { publicKey } = ml_kem768.keygen();
  const { cipherText } = ml_kem768.encapsulate(publicKey);
  assert.equal(arrayBufferToBase64Url(cipherText.buffer).length, 1451);
});

test("hybrid grants open only with both recipient private keys", async () => {
  const { wrapKeyForRecipient, hybridUnwrapDEK, unwrapDEKFromGrant } =
    await import("../src/services/crypto.service.ts");
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  const publicKey = arrayBufferToBase64Url(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const privateKey = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).slice(-32);
  const pq = ml_kem768.keygen();
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const recipient = {
    x25519: { publicKey },
    pqKey: {
      variant: "ML-KEM-768",
      publicKey: arrayBufferToBase64Url(pq.publicKey.buffer),
    },
  };
  const hybrid = await wrapKeyForRecipient(dek, recipient);
  assert.equal(hybrid.algorithm, "x25519-mlkem768-aes256gcm");
  assert.deepEqual(
    await hybridUnwrapDEK(hybrid, privateKey, pq.secretKey),
    dek,
  );
  await assert.rejects(
    hybridUnwrapDEK(hybrid, privateKey, ml_kem768.keygen().secretKey),
  );
  const tampered = Buffer.from(hybrid.kemCiphertext, "base64url");
  tampered[0] ^= 1;
  await assert.rejects(
    hybridUnwrapDEK(
      { ...hybrid, kemCiphertext: tampered.toString("base64url") },
      privateKey,
      pq.secretKey,
    ),
  );
  const classical = await wrapKeyForRecipient(dek, { x25519: { publicKey } });
  assert.equal(classical.algorithm, "x25519-aes256gcm");
  assert.equal(classical.kemCiphertext, undefined);
  assert.deepEqual(await unwrapDEKFromGrant(classical, privateKey), dek);
});

test("team metadata rotation stages readable titles and subjects under the new key", async () => {
  const { default: teamService } =
    await import("../src/services/team.service.ts");
  const { rotateTeamMetadata } =
    await import("../src/utils/teamRotationMetadata.util.ts");
  const { encryptShareInfo, decryptShareInfo } =
    await import("../src/utils/fileMetadata.util.ts");
  const oldKey = await generateEncryptionKey();
  const newKey = await generateEncryptionKey();
  const shareInfo = { name: "Bilans 2026", description: "Equipe finance" };
  const requestInfo = { subject: "Bilans 2026", note: "Document annuel" };
  const shareCiphertext = await encryptShareInfo(oldKey, REQUEST, shareInfo);
  const requestCiphertext = await encryptFileRequestInfo(
    oldKey,
    REQUEST,
    requestInfo,
  );
  const originalGet = teamService.getKeyRotationMetadata;
  const originalStage = teamService.stageKeyRotationMetadata;
  const staged = [];
  teamService.getKeyRotationMetadata = async () => ({
    shares: [{ id: REQUEST, encryptedInfo: shareCiphertext }],
    requests: [{ id: REQUEST, encryptedInfo: requestCiphertext }],
  });
  teamService.stageKeyRotationMetadata = async (_team, _rotation, update) => {
    staged.push(update);
  };
  try {
    await rotateTeamMetadata("team-1", "rotation-1", oldKey, newKey);
    assert.equal(staged.length, 2);
    assert.doesNotMatch(JSON.stringify(staged), /Bilans|finance|annuel/);
    assert.deepEqual(
      await decryptShareInfo(newKey, REQUEST, staged[0].encryptedInfo),
      shareInfo,
    );
    assert.deepEqual(
      await openFileRequestInfo(
        { id: REQUEST, subject: "", encryptedInfo: staged[1].encryptedInfo },
        newKey,
      ),
      requestInfo,
    );
    await assert.rejects(
      decryptShareInfo(oldKey, REQUEST, staged[0].encryptedInfo),
    );
    await assert.rejects(
      rotateTeamMetadata("team-1", "rotation-1", newKey, oldKey),
    );
  } finally {
    teamService.getKeyRotationMetadata = originalGet;
    teamService.stageKeyRotationMetadata = originalStage;
  }
});
