/**
 * Re-encryption utility for E2E key rotation.
 *
 * Downloads each E2E-encrypted file, decrypts with the old key,
 * re-encrypts with the new key, and uploads the result via the
 * dedicated reencrypt endpoint.  Also re-wraps reverse share keys.
 */

import {
  importKeyFromBase64,
  reencryptStream,
  wrapReverseShareKey,
  unwrapReverseShareKey,
} from "./crypto.util";
import shareService from "../services/share.service";
import teamService from "../services/team.service";
import {
  completeSafeLineChallenge,
  setUploadActive,
} from "../services/api.service";
import { MyShare, MyReverseShare } from "../types/share.type";
import { uploadReencryptChunkInWorker } from "./reencryptUpload.util";

const REENCRYPT_TRANSPORT_CHUNK_SIZE = 100_000_000;
const REENCRYPT_CRYPTO_RECORD_SIZE = 1_000_000;
// 199 MB plus 28 bytes per 1 MB crypto record remains below the backend's
// 200 MB raw-body ceiling.
const MAX_REENCRYPT_TRANSPORT_CHUNK_SIZE = 199_000_000;
const MAX_REENCRYPT_CHUNKS = 9_500;
const REENCRYPT_CHUNK_QUANTUM = 1_000_000;
const MAX_RETRIES = 3;
const MAX_FILE_RETRIES = 2; // retries per file (3 total attempts)
const KEEPALIVE_INTERVAL_MS = 90_000; // SafeLine session keepalive
const JWT_REFRESH_INTERVAL_MS = 5 * 60_000; // refresh JWT every 5 min (token TTL = 13 min)

function getEncryptionRecordConfig(
  response: Response,
  fallback: number,
): { size: number; exact: boolean } {
  const advertised = Number(response.headers.get("X-Encryption-Chunk-Size"));
  const exact =
    Number.isSafeInteger(advertised) &&
    advertised >= 1_000_000 &&
    advertised <= 200_000_000;
  return { size: exact ? advertised : fallback, exact };
}

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
async function fetchStreaming(
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  const opts: RequestInit = {
    credentials: "include",
    mode: "same-origin",
    headers: {
      Accept: "application/octet-stream",
      "X-Download-Stream": "1",
    },
    signal,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    signal?.throwIfAborted();
    let response = await fetch(url, opts);

    // SafeLine WAF challenge
    if (response.status === 468) {
      // Release the 468 response connection before retrying
      response.body?.cancel().catch(() => {});
      try {
        await completeSafeLineChallenge();
      } catch {
        /* ignore */
      }
      signal?.throwIfAborted();
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
        try {
          await completeSafeLineChallenge();
        } catch {
          /* ignore */
        }
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
  rotationId?: string,
  sessionId?: string,
  encryptionChunkSize = REENCRYPT_CRYPTO_RECORD_SIZE,
  signal?: AbortSignal,
): Promise<void> {
  let pendingChunk = chunk;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    signal?.throwIfAborted();
    try {
      await uploadReencryptChunkInWorker(
        {
          shareId,
          fileId,
          chunkIndex,
          totalChunks,
          rotationId,
          encryptionChunkSize,
          sessionId,
        },
        pendingChunk,
        signal,
      );
      return;
    } catch (e: any) {
      if (signal?.aborted) signal.throwIfAborted();

      // Ownership of the transferred ArrayBuffer returns from the Worker on
      // an HTTP/network failure. If the Worker itself crashed, restart the
      // whole file so its source stream can regenerate this payload.
      if (e?.chunk instanceof ArrayBuffer) {
        pendingChunk = e.chunk;
      } else {
        throw e;
      }

      const status = e?.status;
      if (status === 468 && attempt < MAX_RETRIES) {
        try {
          await completeSafeLineChallenge();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (status === 401 && attempt < MAX_RETRIES) {
        await fetch("/api/auth/token", {
          method: "POST",
          credentials: "include",
        }).catch(() => undefined);
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
  onProgress?: (_p: ReencryptProgress) => void,
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
    fetch("/api/auth/token", { method: "POST", credentials: "include" }).catch(
      () => {},
    );
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
      const configs = (await fetch("/api/configs", {
        credentials: "include",
      }).then((r) => r.json())) as {
        key: string;
        value?: string;
        defaultValue?: string;
      }[];
      const cfg = configs.find((c) => c.key === "share.chunkSize");
      if (cfg)
        configChunkSize = parseInt(cfg.value ?? cfg.defaultValue ?? "10000000");
    } catch {
      // fallback to default
    }

    for (const share of e2eShares) {
      if (!Array.isArray(share.files)) continue;

      fileLoop: for (const file of share.files) {
        const reencryptSessionId = crypto.randomUUID();
        // Check cancellation
        if (signal?.aborted) {
          throw new Error("Re-chiffrement annulé par l'utilisateur");
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
        for (
          let fileAttempt = 0;
          fileAttempt <= MAX_FILE_RETRIES;
          fileAttempt++
        ) {
          try {
            // Download and decrypt with old key using streaming
            const response = await fetchStreaming(
              `/api/shares/${share.id}/files/${file.id}`,
              signal,
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

            const cryptoRecord = getEncryptionRecordConfig(
              response,
              configChunkSize,
            );

            await reencryptStream({
              encryptedStream: response.body,
              oldKey,
              newKey,
              sourceChunkSize: cryptoRecord.size,
              sourceChunkSizeIsExact: cryptoRecord.exact,
              totalEncryptedSize: totalSize,
              targetChunkSize: REENCRYPT_TRANSPORT_CHUNK_SIZE,
              targetRecordSize: REENCRYPT_CRYPTO_RECORD_SIZE,
              maxChunks: MAX_REENCRYPT_CHUNKS,
              maxTargetChunkSize: MAX_REENCRYPT_TRANSPORT_CHUNK_SIZE,
              chunkSizeQuantum: REENCRYPT_CHUNK_QUANTUM,
              signal,
              uploadChunk: (encrypted, index, total, chunkSize) =>
                uploadChunkWithRetry(
                  share.id,
                  file.id,
                  encrypted,
                  index,
                  total,
                  undefined,
                  reencryptSessionId,
                  chunkSize,
                  signal,
                ),
            });

            break; // success -- exit retry loop
          } catch (e: any) {
            // User cancellation -- rethrow immediately
            if (e?.name === "AbortError" || e?.message?.includes("annulé"))
              throw e;

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
        throw new Error("Re-chiffrement annulé par l'utilisateur");
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

export interface TeamReencryptProgress {
  filesTotal: number;
  filesDone: number;
  filesSkipped: number;
  filesFailed: number;
  currentFile?: string;
  failedDetails: string[];
}

export interface TeamReencryptResult {
  filesReencrypted: number;
  filesSkipped: number;
  filesFailed: number;
  failedDetails: string[];
}

/**
 * Re-encrypt all files in a team after a key rotation.
 * Downloads each E2E-encrypted file, decrypts with oldKey, re-encrypts with newKey,
 * and uploads via the reencrypt endpoint.
 * Call teamService.rotateTeamKey() AFTER this succeeds.
 */
export async function reencryptTeam(
  teamId: string,
  oldEncodedKey: string,
  newEncodedKey: string,
  onProgress?: (_p: TeamReencryptProgress) => void,
  signal?: AbortSignal,
  options?: {
    rotationId?: string;
    completedFileIds?: string[];
    onSkippedFile?: (_fileId: string) => Promise<void>;
  },
): Promise<TeamReencryptResult> {
  const oldKey = await importKeyFromBase64(oldEncodedKey);
  const newKey = await importKeyFromBase64(newEncodedKey);

  setUploadActive(true);

  const keepalive = setInterval(() => {
    fetch("/?_sl=" + Date.now(), { credentials: "include" })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }, KEEPALIVE_INTERVAL_MS);

  const jwtRefresh = setInterval(() => {
    fetch("/api/auth/token", { method: "POST", credentials: "include" }).catch(
      () => {},
    );
  }, JWT_REFRESH_INTERVAL_MS);

  try {
    const teamShares = await teamService.getTeamShares(teamId);
    const completedFileIds = new Set(options?.completedFileIds || []);

    let totalFiles = 0;
    for (const share of teamShares) {
      if (Array.isArray(share.files)) totalFiles += share.files.length;
    }

    let filesDone = 0;
    let filesSkipped = 0;
    let filesFailed = 0;
    const failedDetails: string[] = [];

    const progress: TeamReencryptProgress = {
      filesTotal: totalFiles,
      filesDone: 0,
      filesSkipped: 0,
      filesFailed: 0,
      failedDetails,
    };

    onProgress?.({ ...progress });

    let configChunkSize = 10_000_000;
    try {
      const configs = (await fetch("/api/configs", {
        credentials: "include",
      }).then((r) => r.json())) as {
        key: string;
        value?: string;
        defaultValue?: string;
      }[];
      const cfg = configs.find((c) => c.key === "share.chunkSize");
      if (cfg)
        configChunkSize = parseInt(cfg.value ?? cfg.defaultValue ?? "10000000");
    } catch {
      /* fallback */
    }

    for (const share of teamShares) {
      if (!Array.isArray(share.files)) continue;

      fileLoop: for (const file of share.files) {
        const reencryptSessionId = crypto.randomUUID();
        if (signal?.aborted)
          throw new Error("Re-chiffrement annulé par l'utilisateur");

        if (completedFileIds.has(file.id)) {
          filesDone++;
          progress.filesDone = filesDone;
          onProgress?.({ ...progress, failedDetails: [...failedDetails] });
          continue;
        }

        progress.currentFile = file.name ?? file.id;
        onProgress?.({ ...progress, failedDetails: [...failedDetails] });

        const fileSize = parseInt(file.size ?? "0", 10);
        if (fileSize <= 0) {
          filesSkipped++;
          filesDone++;
          progress.filesDone = filesDone;
          progress.filesSkipped = filesSkipped;
          await options?.onSkippedFile?.(file.id);
          onProgress?.({ ...progress, failedDetails: [...failedDetails] });
          continue;
        }

        for (
          let fileAttempt = 0;
          fileAttempt <= MAX_FILE_RETRIES;
          fileAttempt++
        ) {
          try {
            const response = await fetchStreaming(
              `/api/shares/${share.id}/files/${file.id}`,
              signal,
            );
            const totalSize = parseInt(
              response.headers.get("Content-Length") || "0",
              10,
            );

            if (!response.body || totalSize <= 0) {
              filesSkipped++;
              filesDone++;
              progress.filesDone = filesDone;
              progress.filesSkipped = filesSkipped;
              await options?.onSkippedFile?.(file.id);
              onProgress?.({ ...progress, failedDetails: [...failedDetails] });
              continue fileLoop;
            }

            const cryptoRecord = getEncryptionRecordConfig(
              response,
              configChunkSize,
            );

            await reencryptStream({
              encryptedStream: response.body,
              oldKey,
              newKey,
              sourceChunkSize: cryptoRecord.size,
              sourceChunkSizeIsExact: cryptoRecord.exact,
              totalEncryptedSize: totalSize,
              targetChunkSize: REENCRYPT_TRANSPORT_CHUNK_SIZE,
              targetRecordSize: REENCRYPT_CRYPTO_RECORD_SIZE,
              maxChunks: MAX_REENCRYPT_CHUNKS,
              maxTargetChunkSize: MAX_REENCRYPT_TRANSPORT_CHUNK_SIZE,
              chunkSizeQuantum: REENCRYPT_CHUNK_QUANTUM,
              signal,
              uploadChunk: (encrypted, index, total, chunkSize) =>
                uploadChunkWithRetry(
                  share.id,
                  file.id,
                  encrypted,
                  index,
                  total,
                  options?.rotationId,
                  reencryptSessionId,
                  chunkSize,
                  signal,
                ),
            });

            break; // success
          } catch (e: any) {
            if (e?.name === "AbortError" || e?.message?.includes("annulé"))
              throw e;

            // Classify the error for diagnostics
            const msg = e?.message ?? "unknown error";
            const httpStatus = e?.status ?? e?.response?.status;
            const isNetworkError =
              e instanceof TypeError ||
              msg.includes("network") ||
              msg.includes("Failed to fetch") ||
              msg.includes("aborted") ||
              msg.includes("The operation was aborted");
            const errorHint = isNetworkError
              ? `${msg} (connexion coupée -- vérifier proxy/WAF)`
              : httpStatus
                ? `HTTP ${httpStatus}: ${msg}`
                : msg;

            if (fileAttempt < MAX_FILE_RETRIES) {
              console.warn(
                `[reencryptTeam] File ${file.name ?? file.id} (share ${share.id}) attempt ${fileAttempt + 1}/${MAX_FILE_RETRIES + 1} failed, retrying...`,
                errorHint,
              );
              await sleep(Math.min(2000 * Math.pow(2, fileAttempt), 30_000));
              continue;
            }

            // All retries exhausted
            console.error(
              `[reencryptTeam] File ${file.name ?? file.id} (share ${share.id}) FAILED after ${MAX_FILE_RETRIES + 1} attempts:`,
              errorHint,
              e,
            );
            filesFailed++;
            filesDone++;
            failedDetails.push(`${file.name ?? file.id}: ${errorHint}`);
            progress.filesDone = filesDone;
            progress.filesFailed = filesFailed;
            onProgress?.({ ...progress, failedDetails: [...failedDetails] });
            continue fileLoop;
          }
        }

        filesDone++;
        progress.filesDone = filesDone;
        onProgress?.({ ...progress, failedDetails: [...failedDetails] });
      }
    }

    return {
      filesReencrypted: filesDone - filesSkipped - filesFailed,
      filesSkipped,
      filesFailed,
      failedDetails,
    };
  } finally {
    clearInterval(keepalive);
    clearInterval(jwtRefresh);
    setUploadActive(false);
  }
}
