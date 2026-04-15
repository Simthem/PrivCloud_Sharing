/**
 * Re-encryption utility for E2E key rotation.
 *
 * Downloads each E2E-encrypted file, decrypts with the old key,
 * re-encrypts with the new key, and uploads the result via the
 * dedicated reencrypt endpoint.  Also re-wraps reverse share keys.
 */

import {
  importKeyFromBase64,
  encryptFile,
  decryptStream,
  wrapReverseShareKey,
  unwrapReverseShareKey,
  exportKeyToBase64,
} from "./crypto.util";
import shareService from "../services/share.service";
import { completeSafeLineChallenge, setUploadActive } from "../services/api.service";
import { MyShare, MyReverseShare } from "../types/share.type";

const REENCRYPT_CHUNK_SIZE = 10_000_000; // 10 MB plaintext chunks
const INTER_CHUNK_DELAY_MS = 150; // ms between chunk uploads
const INTER_FILE_DELAY_MS = 500;  // ms between file re-encryptions
const MAX_RETRIES = 3;
const MAX_FILE_RETRIES = 2;       // retries per file (3 total attempts)
const KEEPALIVE_INTERVAL_MS = 90_000; // SafeLine session keepalive
const JWT_REFRESH_INTERVAL_MS = 10 * 60_000; // refresh JWT every 10 min

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ReencryptProgress {
  phase: "files" | "reverseShares" | "done";
  currentShare?: string;
  currentFile?: string;
  filesTotal: number;
  filesDone: number;
  filesSkipped: number;
  filesFailed: number;
  reverseSharesTotal: number;
  reverseSharesDone: number;
  reverseSharesFailed: number;
  failedDetails: string[];
}

export interface ReencryptResult {
  filesReencrypted: number;
  filesSkipped: number;
  filesFailed: number;
  reverseSharesFailed: number;
  failedDetails: string[];
}

/**
 * Native fetch with SafeLine 468 retry (same as share.service.ts).
 */
async function fetchStreaming(url: string): Promise<Response> {
  const opts: RequestInit = {
    credentials: "include",
    mode: "same-origin",
    headers: {
      Accept: "application/octet-stream",
      "X-Download-Stream": "1",
    },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response = await fetch(url, opts);

    // SafeLine WAF challenge
    if (response.status === 468) {
      // Release the 468 response connection before retrying
      response.body?.cancel().catch(() => {});
      try { await completeSafeLineChallenge(); } catch { /* ignore */ }
      response = await fetch(url, opts);
      if (response.ok) return response;
    }

    if (response.ok) return response;

    // Release non-OK response body to free the TCP connection
    response.body?.cancel().catch(() => {});

    // WAF rate-limit or block -- exponential backoff
    if (response.status === 403 || response.status === 429) {
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 30_000));
        continue;
      }
    }

    if (attempt < MAX_RETRIES) {
      await sleep(Math.min(1000 * Math.pow(2, attempt), 16_000));
      continue;
    }
    throw new Error(`HTTP ${response.status}`);
  }
  throw new Error("Max retries exceeded");
}

/**
 * PATCH a reverse share with WAF-aware retry and backoff.
 * Handles 468 (SafeLine challenge), 429 (throttle), and 403 (WAF rate-limit).
 */
async function updateReverseShareWithRetry(
  rsId: string,
  data: { encryptedReverseShareKey: string },
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await shareService.updateReverseShare(rsId, data);
      return;
    } catch (e: any) {
      const status = e?.response?.status ?? e?.status;
      if (status === 468 && attempt < MAX_RETRIES) {
        try { await completeSafeLineChallenge(); } catch { /* ignore */ }
        continue;
      }
      if ((status === 403 || status === 429) && attempt < MAX_RETRIES) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 30_000));
        continue;
      }
      if (attempt >= MAX_RETRIES) throw e;
      await sleep(Math.min(1000 * Math.pow(2, attempt), 16_000));
    }
  }
}

/**
 * Upload re-encrypted chunk with WAF-aware retry and backoff.
 */
async function uploadChunkWithRetry(
  shareId: string,
  fileId: string,
  chunk: ArrayBuffer,
  chunkIndex: number,
  totalChunks: number,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await shareService.uploadReencryptChunk(
        shareId, fileId, chunk, chunkIndex, totalChunks,
      );
      return;
    } catch (e: any) {
      const status = e?.status;
      if (status === 468 && attempt < MAX_RETRIES) {
        try { await completeSafeLineChallenge(); } catch { /* ignore */ }
        continue;
      }
      if ((status === 403 || status === 429) && attempt < MAX_RETRIES) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 30_000));
        continue;
      }
      if (attempt >= MAX_RETRIES) throw e;
      await sleep(Math.min(1000 * Math.pow(2, attempt), 16_000));
    }
  }
}

/**
 * Re-encrypt all E2E files and reverse share keys after a key change.
 *
 * @param oldEncodedKey - The previous key (base64url)
 * @param newEncodedKey - The new key (base64url)
 * @param onProgress    - Progress callback
 * @param signal        - AbortSignal for cancellation
 * @returns Detailed result of the re-encryption operation
 */
export async function reencryptAll(
  oldEncodedKey: string,
  newEncodedKey: string,
  onProgress?: (p: ReencryptProgress) => void,
  signal?: AbortSignal,
): Promise<ReencryptResult> {
  const oldKey = await importKeyFromBase64(oldEncodedKey);
  const newKey = await importKeyFromBase64(newEncodedKey);

  // Prevent the axios interceptor from redirecting to /auth/signIn
  // if a chunk upload gets a 401 during long re-encryption.
  setUploadActive(true);

  // SafeLine keepalive: keep WAF session alive during long re-encryption
  const keepalive = setInterval(() => {
    fetch("/?_sl=" + Date.now(), { credentials: "include" })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }, KEEPALIVE_INTERVAL_MS);

  // Active JWT refresh: background tabs throttle setInterval to ~60s,
  // so the _app.tsx 10s refresh may not fire often enough to keep the
  // 13-min access_token alive.  Refresh proactively every 10 min.
  const jwtRefresh = setInterval(() => {
    fetch("/api/auth/token", { method: "POST", credentials: "include" })
      .catch(() => {});
  }, JWT_REFRESH_INTERVAL_MS);

  try {
  // --- Phase 1: re-encrypt files ---
  const allShares: MyShare[] = await shareService.getMyShares();
  const e2eShares = allShares.filter((s) => s.isE2EEncrypted);

  // Count total non-empty files across all E2E shares
  let totalFiles = 0;
  for (const share of e2eShares) {
    if (Array.isArray(share.files)) totalFiles += share.files.length;
  }

  // Fetch reverse shares for phase 2
  const allReverseShares: MyReverseShare[] =
    await shareService.getMyReverseShares();
  const e2eReverseShares = allReverseShares.filter(
    (rs) => !!rs.encryptedReverseShareKey,
  );

  let filesDone = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
  let reverseSharesFailed = 0;
  const failedDetails: string[] = [];

  const progress: ReencryptProgress = {
    phase: "files",
    filesTotal: totalFiles,
    filesDone: 0,
    filesSkipped: 0,
    filesFailed: 0,
    reverseSharesTotal: e2eReverseShares.length,
    reverseSharesDone: 0,
    reverseSharesFailed: 0,
    failedDetails,
  };

  onProgress?.({ ...progress });

  // Fetch chunkSize from config (same approach as share.service.ts)
  let configChunkSize = 10_000_000;
  try {
    const configs = (
      await fetch("/api/configs", { credentials: "include" }).then((r) =>
        r.json(),
      )
    ) as { key: string; value?: string; defaultValue?: string }[];
    const cfg = configs.find((c) => c.key === "share.chunkSize");
    if (cfg)
      configChunkSize = parseInt(
        cfg.value ?? cfg.defaultValue ?? "10000000",
      );
  } catch {
    // fallback to default
  }

  for (const share of e2eShares) {
    if (!Array.isArray(share.files)) continue;

    fileLoop: for (const file of share.files) {
      // Check cancellation
      if (signal?.aborted) {
        throw new Error("Re-encryption cancelled by user");
      }

      progress.currentShare = share.id;
      progress.currentFile = file.name ?? file.id;
      onProgress?.({ ...progress, failedDetails: [...failedDetails] });

      // Skip 0-byte or empty files -- they have no encrypted content
      const fileSize = parseInt(file.size ?? "0", 10);
      if (fileSize <= 0) {
        filesSkipped++;
        filesDone++;
        progress.filesDone = filesDone;
        progress.filesSkipped = filesSkipped;
        onProgress?.({ ...progress, failedDetails: [...failedDetails] });
        continue;
      }

      // Retry loop: handles transient WAF / network mid-stream errors
      for (let fileAttempt = 0; fileAttempt <= MAX_FILE_RETRIES; fileAttempt++) {
        try {
          // Download and decrypt with old key using streaming
          const response = await fetchStreaming(
            `/api/shares/${share.id}/files/${file.id}`,
          );
          const totalSize = parseInt(
            response.headers.get("Content-Length") || "0",
            10,
          );

          if (!response.body || totalSize <= 0) {
            // File exists in DB but has no actual content -- skip
            filesSkipped++;
            filesDone++;
            progress.filesDone = filesDone;
            progress.filesSkipped = filesSkipped;
            onProgress?.({ ...progress, failedDetails: [...failedDetails] });
            continue fileLoop;
          }

          // Accumulate decrypted plaintext
          const parts: Uint8Array[] = [];
          let totalDecrypted = 0;
          for await (const chunk of decryptStream(
            response.body,
            oldKey,
            configChunkSize,
            totalSize,
          )) {
            parts.push(chunk);
            totalDecrypted += chunk.length;
          }

          // Combine into single buffer
          const plaintext = new Uint8Array(totalDecrypted);
          let offset = 0;
          for (const part of parts) {
            plaintext.set(part, offset);
            offset += part.length;
          }

          // Re-encrypt in chunks and upload
          const totalChunks = Math.max(
            1,
            Math.ceil(totalDecrypted / REENCRYPT_CHUNK_SIZE),
          );

          for (let i = 0; i < totalChunks; i++) {
            if (signal?.aborted) {
              throw new Error("Re-encryption cancelled by user");
            }

            const start = i * REENCRYPT_CHUNK_SIZE;
            const end = Math.min(start + REENCRYPT_CHUNK_SIZE, totalDecrypted);
            const chunkPlaintext = plaintext.slice(start, end).buffer;

            const encrypted = await encryptFile(chunkPlaintext, newKey);

            await uploadChunkWithRetry(
              share.id,
              file.id,
              encrypted,
              i,
              totalChunks,
            );

            // Delay between chunks to avoid WAF rate-limiting
            if (i < totalChunks - 1) {
              await sleep(INTER_CHUNK_DELAY_MS);
            }
          }

          break; // success -- exit retry loop
        } catch (e: any) {
          // User cancellation -- rethrow immediately
          if (e?.message?.includes("cancelled")) throw e;

          // Classify the error for better diagnostics
          const msg = e?.message ?? "unknown error";
          const isNetworkError =
            e instanceof TypeError ||
            msg.includes("network") ||
            msg.includes("Failed to fetch") ||
            msg.includes("aborted") ||
            msg.includes("The operation was aborted");
          const errorHint = isNetworkError
            ? `${msg} (connexion coupee -- verifier proxy/WAF)`
            : msg;

          if (fileAttempt < MAX_FILE_RETRIES) {
            console.warn(
              `[reencrypt] File ${file.name ?? file.id} attempt ${fileAttempt + 1}/${MAX_FILE_RETRIES + 1} failed, retrying...`,
              errorHint,
            );
            await sleep(3000 * Math.pow(2, fileAttempt));
            continue; // next retry attempt
          }

          // All retries exhausted
          filesFailed++;
          progress.filesFailed = filesFailed;
          const detail = `${file.name ?? file.id} (share ${share.id}): ${errorHint}`;
          failedDetails.push(detail);
        }
      }

      filesDone++;
      progress.filesDone = filesDone;
      onProgress?.({ ...progress, failedDetails: [...failedDetails] });

      // Delay between files to avoid WAF rate-limiting
      await sleep(INTER_FILE_DELAY_MS);
    }
  }

  // --- Phase 2: re-wrap reverse share keys ---
  // Allow WAF/throttle window to cool down after Phase 1 traffic
  await sleep(1500);

  // Re-fetch reverse shares via axios to:
  // 1. Trigger JWT refresh if the access token expired during Phase 1
  // 2. Get fresh encryptedReverseShareKey values from the database
  let freshReverseShares = e2eReverseShares;
  try {
    const refreshed: MyReverseShare[] =
      await shareService.getMyReverseShares();
    freshReverseShares = refreshed.filter(
      (rs) => !!rs.encryptedReverseShareKey,
    );
  } catch {
    // Fall back to the list fetched before Phase 1
  }

  progress.phase = "reverseShares";
  progress.reverseSharesTotal = freshReverseShares.length;
  onProgress?.({ ...progress });

  for (const rs of freshReverseShares) {
    if (signal?.aborted) {
      throw new Error("Re-encryption cancelled by user");
    }

    try {
      const rsKey = await unwrapReverseShareKey(
        rs.encryptedReverseShareKey!,
        oldKey,
      );
      const newWrapped = await wrapReverseShareKey(rsKey, newKey);
      await updateReverseShareWithRetry(rs.id, {
        encryptedReverseShareKey: newWrapped,
      });
      progress.reverseSharesDone++;
      onProgress?.({ ...progress, failedDetails: [...failedDetails] });
    } catch (e: any) {
      // Track reverse share failure but continue with others
      console.error(`[reencrypt] Phase 2 failed for RS ${rs.id}:`, e);
      reverseSharesFailed++;
      progress.reverseSharesFailed = reverseSharesFailed;
      progress.reverseSharesDone++;
      const detail = `Reverse share ${rs.id}: ${e?.message ?? "unknown error"}`;
      failedDetails.push(detail);
      onProgress?.({ ...progress, failedDetails: [...failedDetails] });
    }
  }

  progress.phase = "done";
  onProgress?.({ ...progress, failedDetails: [...failedDetails] });

  return {
    filesReencrypted: filesDone - filesSkipped - filesFailed,
    filesSkipped,
    filesFailed,
    reverseSharesFailed,
    failedDetails,
  };
  } finally {
    clearInterval(keepalive);
    clearInterval(jwtRefresh);
    setUploadActive(false);
  }
}
