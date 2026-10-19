import teamExternalService from "../services/teamExternal.service";
import { resolveCurrentTeamKey } from "./teamProfile.util";

// Team audit key of the copies issued to contractors: 32 random bytes,
// wrapped with K_team in the browser. It derives the invisible mark of every
// copy and encrypts the titles shown in the register. The server only stores
// it wrapped, and a key rotation re-wraps it without changing it, so marks
// issued before a rotation stay detectable.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const fromBase64Url = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const auditKeyAad = (teamId: string) =>
  encoder.encode(`privcloud:team-audit-key:v1:${teamId}`);

const labelAad = (teamId: string, previewId: string) =>
  encoder.encode(
    `privcloud:contractor-register-label:v1:${teamId}:${previewId}`,
  );

async function seal(key: CryptoKey, data: Uint8Array, aad: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: aad as Uint8Array<ArrayBuffer>,
      },
      key,
      data as Uint8Array<ArrayBuffer>,
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

async function open(key: CryptoKey, value: string, aad: Uint8Array) {
  const bytes = fromBase64Url(value);
  if (bytes.length < 12 + 16) throw new Error("Invalid ciphertext");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, 12),
        additionalData: aad as Uint8Array<ArrayBuffer>,
      },
      key,
      bytes.subarray(12),
    ),
  );
}

export async function wrapAuditKey(
  teamKey: CryptoKey,
  teamId: string,
  raw: Uint8Array,
) {
  return seal(teamKey, raw, auditKeyAad(teamId));
}

export async function unwrapAuditKey(
  teamKey: CryptoKey,
  teamId: string,
  wrapped: string,
) {
  const raw = await open(teamKey, wrapped, auditKeyAad(teamId));
  if (raw.length !== 32) throw new Error("Invalid team audit key");
  return raw;
}

/**
 * The audit key of the team, created by the first administrator who needs
 * it. Two administrators creating it at once: the server keeps the first one
 * and the other browser reads it back.
 */
export async function loadTeamAuditKey(
  teamId: string,
  options: { create: boolean },
): Promise<Uint8Array | null> {
  const current = await resolveCurrentTeamKey(teamId);
  if (!current) throw new Error("team_key_unavailable");
  const stored = await teamExternalService.getAuditKey(teamId);
  if (stored) return unwrapAuditKey(current.key, teamId, stored.encryptedKey);
  if (!options.create) return null;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    await teamExternalService.createAuditKey(teamId, {
      encryptedKey: await wrapAuditKey(current.key, teamId, raw),
      keyVersion: current.keyVersion,
    });
    return raw;
  } catch (error) {
    const code = (error as { response?: { data?: { error?: string } } })
      ?.response?.data?.error;
    if (code !== "audit_key_exists") throw error;
    raw.fill(0);
    const winner = await teamExternalService.getAuditKey(teamId);
    if (!winner) throw error;
    return unwrapAuditKey(current.key, teamId, winner.encryptedKey);
  }
}

/** AES-256-GCM key of the register labels: HMAC-SHA256 of the audit key. */
async function labelKey(auditKey: Uint8Array, usage: KeyUsage[]) {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    auditKey as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const raw = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode("privcloud:contractor-register-label:v1"),
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usage);
}

/** Title of the copied document, padded so that its length stays hidden. */
export async function encryptRegisterLabel(
  auditKey: Uint8Array,
  teamId: string,
  previewId: string,
  title: string,
) {
  const json = JSON.stringify({ t: title.slice(0, 300) });
  const padded = json + " ".repeat((64 - (json.length % 64)) % 64);
  return seal(
    await labelKey(auditKey, ["encrypt"]),
    encoder.encode(padded),
    labelAad(teamId, previewId),
  );
}

export async function decryptRegisterLabel(
  auditKey: Uint8Array,
  teamId: string,
  previewId: string,
  value: string | null,
): Promise<string | null> {
  if (!value) return null;
  try {
    const plain = await open(
      await labelKey(auditKey, ["decrypt"]),
      value,
      labelAad(teamId, previewId),
    );
    const parsed = JSON.parse(decoder.decode(plain).trimEnd());
    return typeof parsed?.t === "string" ? parsed.t : null;
  } catch {
    return null;
  }
}
